/**
 * HubSpot Serverless Function: Get Document Values
 * 
 * Fetches property values from a HubSpot custom object (Dossier Juridique).
 * Returns document status properties (required/provided) and conditional UI properties.
 */

const { Client } = require('@hubspot/api-client');

const conditionalProperties = [
  "sous_categorie",
  "avez_vous_un_statut_refugie_ou_apatride__",
  "quelle_est_votre_situation_professionnelle__",
  "quelle_est_votre_situation_familliale",
  "avez_vous_des_enfant_mineur__",
  "domicile__",
  "percevez_vous_"
];

/**
 * Main serverless function entry point.
 * 
 * @param {Object} context - HubSpot serverless function context
 * @param {string[]} context.parameters.propertyNames - Array of property names to fetch
 * @param {boolean} context.parameters.includeCompletion - Whether to include completion status
 * @param {string} context.parameters.hs_object_id - HubSpot object ID
 * @returns {Object} Object with property values keyed by property name
 */
exports.main = async (context = {}) => {
  try {
    const objectId = extractObjectId(context);
    const token = extractAccessToken(context);
    const { objectTypeId, objectTypeName } = getObjectTypeConfig();

    validateRequiredParams(objectId, token);

    const propertyNames = context.parameters?.propertyNames || [];
    const includeCompletion = context.parameters?.includeCompletion || false;
    const properties = buildPropertiesList(propertyNames, includeCompletion);

    const hubspotClient = new Client({
      accessToken: token,
      basePath: 'https://api-eu1.hubspot.com'
    });

    try {
      const objectResponse = await fetchObjectFromHubSpot(
        hubspotClient,
        objectTypeName,
        objectTypeId,
        objectId,
        properties
      );

      if (objectResponse?.properties) {
        return extractPropertyValues(objectResponse.properties, properties);
      } else {
        return buildDefaultResponse(properties, 'No properties found in response');
      }
    } catch (apiError) {
      return handleApiError(apiError, properties);
    }
  } catch (error) {
    console.error('Error in getDocumentValues:', error.message);
    return { error: error.message };
  }
};

/**
 * Extracts HubSpot object ID from various context sources.
 */
function extractObjectId(context) {
    const hs_object_id = context.parameters?.hs_object_id
      || context.propertiesToSend?.hs_object_id 
      || context.recordId 
      || context.hs_object_id;
  return hs_object_id ? String(hs_object_id) : null;
}

/**
 * Extracts HubSpot access token from various context sources.
 */
function extractAccessToken(context) {
    const token = context.accessToken
      || context.secrets?.PRIVATE_APP_ACCESS_TOKEN 
      || context.secrets?.ACCESS_TOKEN
    || process.env['PRIVATE_APP_ACCESS_TOKEN']
      || process.env['hubspot_api_key'] 
      || process.env['sandbox_hubspot_api_key'];

  return token;
}

/**
 * Gets HubSpot custom object type configuration from environment variables.
 */
function getObjectTypeConfig() {
      return { 
    objectTypeId: process.env['dossier_j_ID'] || process.env['sandbox_dossier_j_ID'] || '2-141688426',
    objectTypeName: process.env['dossier_j_NAME'] || process.env['sandbox_dossier_j_NAME'] || 'p_dossier_juridique'
  };
}

/**
 * Validates that required parameters (objectId and token) are present.
 */
function validateRequiredParams(objectId, token) {
    if (!objectId || !token) {
      console.error(`Missing required data - objectId: ${objectId}, token: ${token ? 'present' : 'missing'}`);
    throw new Error('Missing object ID or access token');
  }
    }
    
/**
 * Builds list of properties to fetch, including conditional properties and completion status if requested.
 */
function buildPropertiesList(propertyNames, includeCompletion) {
  const defaultProperties = propertyNames.length
    ? propertyNames
    : ['passport_required', 'passport_provided', 'residence_proof_required', 'residence_proof_provided'];

  const properties = [...defaultProperties];

    if (includeCompletion) {
    properties.push('documents_completed', 'etat_du_dossier');
    }
    
  // Add conditional properties from JSON file
  if (Array.isArray(conditionalProperties)) {
    conditionalProperties.forEach(prop => {
      if (!properties.includes(prop)) {
        properties.push(prop);
      }
    });
  }

  return properties;
}

/**
 * Fetches object data from HubSpot API.
 * Splits properties into batches to avoid HTTP 414 (URI Too Long) errors.
 * HubSpot API has a limit on URL length, so we fetch in chunks of 100 properties.
 * Prioritizes critical properties like sous_categorie.
 */
async function fetchObjectFromHubSpot(hubspotClient, objectTypeName, objectTypeId, objectId, properties) {
  const BATCH_SIZE = 100; // Fetch 100 properties at a time to avoid URL length limits
  const allProperties = {};
  
  // Prioritize critical properties - fetch sous_categorie first if present
  const criticalProperties = ['sous_categorie'];
  const otherProperties = properties.filter(p => !criticalProperties.includes(p));
  const prioritizedProperties = [...criticalProperties.filter(p => properties.includes(p)), ...otherProperties];
  
  // Split properties into batches
  for (let i = 0; i < prioritizedProperties.length; i += BATCH_SIZE) {
    const batch = prioritizedProperties.slice(i, i + BATCH_SIZE);
    
    try {
      let batchResponse;
      try {
        batchResponse = await hubspotClient.crm.objects.basicApi.getById(
          objectTypeName,
          objectId,
          batch
        );
      } catch (firstErr) {
        try {
          batchResponse = await hubspotClient.crm.objects.basicApi.getById(
            objectTypeId,
            objectId,
            batch
          );
        } catch (secondErr) {
          if (secondErr.statusCode === 404 || secondErr.code === 404) {
            throw new Error('Object not found');
          }
          throw secondErr;
        }
      }
      
      // Merge batch results
      if (batchResponse?.properties) {
        Object.assign(allProperties, batchResponse.properties);
      }
    } catch (batchError) {
      console.error(`Error fetching batch ${i / BATCH_SIZE + 1}:`, batchError.message);
      // Continue with other batches even if one fails
      // Set empty values for failed batch
      batch.forEach(prop => {
        if (!(prop in allProperties)) {
          allProperties[prop] = null;
        }
      });
    }
  }
  
  // Return in the same format as the original API response
  return {
    properties: allProperties
  };
}

/**
 * Extracts and formats property values from HubSpot API response.
 * Formats boolean properties (required/provided) and other property types differently.
 */
function extractPropertyValues(hubspotProperties, requestedProperties) {
  const result = {};

  requestedProperties.forEach(prop => {
    const rawValue = hubspotProperties[prop];
    
    // Log sous_categorie for debugging
    if (prop === 'sous_categorie') {
      console.log('[getDocumentValues] sous_categorie rawValue:', rawValue, 'type:', typeof rawValue);
      console.log('[getDocumentValues] All hubspotProperties keys:', Object.keys(hubspotProperties));
      console.log('[getDocumentValues] Properties containing "nature":', 
        Object.keys(hubspotProperties).filter(k => k.toLowerCase().includes('nature')));
    }
    
          if (prop.includes('_required') || prop.includes('_provided')) {
      result[prop] = formatBooleanProperty(rawValue);
          } else {
      result[prop] = formatOtherProperty(rawValue);
          }
        });
        
        return result;
}

/**
 * Formats boolean properties (required/provided) from HubSpot response.
 * Returns 'false' for null/undefined/empty values.
 */
function formatBooleanProperty(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return 'false';
  }
  return String(rawValue);
}

/**
 * Formats other properties (dropdowns, text fields, multiple select) from HubSpot response.
 * HubSpot multiple select fields are returned as semicolon-separated strings.
 */
function formatOtherProperty(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return '';
  }
  
  if (typeof rawValue === 'string') {
    return rawValue;
  }
  
  if (Array.isArray(rawValue)) {
    return rawValue.join(';');
  }
  
  if (typeof rawValue === 'object' && rawValue.value !== undefined) {
    const value = rawValue.value;
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.join(';');
    }
    return String(value);
  }
  
  return String(rawValue);
}

/**
 * Builds default response with empty/false values when properties are not found.
 */
function buildDefaultResponse(properties, errorMessage) {
  const result = { error: errorMessage };
        properties.forEach(prop => {
          if (prop.includes('_required') || prop.includes('_provided')) {
      result[prop] = 'false';
    } else {
      result[prop] = '';
    }
  });
  return result;
}

/**
 * Handles API errors and returns formatted error response with default values.
 */
function handleApiError(apiError, properties) {
      const statusCode = apiError.statusCode || apiError.code;
      const errorBody = apiError.body || apiError.response?.body || '';
      const errorMessage = apiError.message || 'Unknown error';
      
      let formattedError = `API error: HTTP-Code: ${statusCode || 'Unknown'}\nMessage: ${errorMessage}`;
      if (errorBody) {
          formattedError += `\nBody: ${JSON.stringify(errorBody)}`;
      }
      
  return buildDefaultResponse(properties, formattedError);
}
