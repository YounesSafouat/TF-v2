/**
 * HubSpot Serverless Function: Update Completion Status
 * 
 * Updates document completion status, dossier state, and missing documents list
 * in HubSpot custom objects. Handles property validation errors gracefully.
 */

const { Client } = require('@hubspot/api-client');

/**
 * Main serverless function entry point.
 * Updates documents_completed, etat_du_dossier, and missing_doc properties.
 * 
 * @param {Object} context - HubSpot serverless function context
 * @param {boolean|string} context.parameters.completionStatus - Completion status (true/false or 'true'/'false')
 * @param {string} context.parameters.dossierState - Dossier state value
 * @param {string} context.parameters.missingDoc - HTML formatted list of missing documents
 * @param {string} context.parameters.hs_object_id - HubSpot object ID
 * @returns {Object} Response with status and message
 */
exports.main = async (context = {}) => {
  try {
    const hs_object_id = context.propertiesToSend?.hs_object_id 
      || context.recordId 
      || context.parameters?.hs_object_id
      || context.hs_object_id;
    const { completionStatus, dossierState, missingDoc } = context.parameters || {};
    
    const token = context.accessToken
      || context.secrets?.PRIVATE_APP_ACCESS_TOKEN 
      || context.secrets?.ACCESS_TOKEN
      || process.env['PRIVATE_APP_ACCESS_TOKEN']
      || process.env['hubspot_api_key'] 
      || process.env['sandbox_hubspot_api_key'];
    
    if (!token) {
      return { 
        status: 'error',
        message: 'API key not found' 
      };
    }
    
    const objectTypeId = process.env['dossier_j_ID'] || process.env['sandbox_dossier_j_ID'] || '2-141688426';
    const objectTypeName = process.env['dossier_j_NAME'] || process.env['sandbox_dossier_j_NAME'] || 'p_dossier_juridique';
    
    let objectInstanceId = String(hs_object_id);
    if (objectInstanceId.includes('-')) {
      const parts = objectInstanceId.split('-');
      objectInstanceId = parts[parts.length - 1];
    }
    
    const COMPLETION_PROPERTY = 'documents_completed';
    const DOSSIER_STATE_PROPERTY = 'etat_du_dossier';
    const MISSING_DOC_PROPERTY = 'missing_doc';
    
    const isMissingDocOnly = completionStatus === undefined && dossierState === undefined;
    
    if (!hs_object_id || !token) {
      return { 
        status: 'error',
        message: 'Missing required parameters (object ID or token)'
      };
    }
    
    if (!isMissingDocOnly && (completionStatus === undefined || dossierState === undefined || dossierState === null)) {
      return { 
        status: 'error',
        message: 'Missing required parameters (completion status or dossier state)'
      };
    }
    
    const hubspotClient = new Client({ 
      accessToken: token,
      basePath: 'https://api-eu1.hubapi.com'
    });
    
    let stringValue = 'false';
    if (completionStatus !== undefined) {
      stringValue = completionStatus === true || completionStatus === 'true' ? 'true' : 'false';
    }
    
    try {
      // Prepare properties object - only include properties that are defined
      const properties = {};
      
      // Add completion status if provided
      if (completionStatus !== undefined) {
        properties[COMPLETION_PROPERTY] = stringValue;
        console.log(`[COMPLETION] Setting ${COMPLETION_PROPERTY} to: ${stringValue}`);
      }
      
      // Add dossier state if provided
      if (dossierState !== undefined && dossierState !== null) {
        properties[DOSSIER_STATE_PROPERTY] = dossierState;
      }
      
      // Add missing_doc property if provided (can be empty string)
      if (missingDoc !== undefined && missingDoc !== null) {
        properties[MISSING_DOC_PROPERTY] = String(missingDoc);
      }
      
      let updateResponse;
      try {
        updateResponse = await hubspotClient.crm.objects.basicApi.update(
          objectTypeName,
          objectInstanceId,
          { properties }
        );
      } catch (firstErr) {
        if (firstErr.statusCode === 404 || firstErr.code === 404) {
          return { status: 'success', message: 'Object not found, update skipped' };
        }
        
        if (firstErr.statusCode === 400 || firstErr.code === 400) {
          let propertyError = null;
          
          if (firstErr.body) {
            if (typeof firstErr.body === 'string') {
              const match = firstErr.body.match(/does not exist[^"]*"([^"]+)"/);
              if (match) propertyError = match[1];
            } else if (firstErr.body.errors && Array.isArray(firstErr.body.errors)) {
              firstErr.body.errors.forEach(err => {
                if (err.message) {
                  const match = err.message.match(/does not exist[^"]*"([^"]+)"/);
                  if (match) propertyError = match[1];
                }
              });
            }
          }
          
          if (propertyError === MISSING_DOC_PROPERTY) {
            try {
              const propertiesWithoutMissing = {};
              if (completionStatus !== undefined) {
                propertiesWithoutMissing[COMPLETION_PROPERTY] = stringValue;
              }
              if (dossierState !== undefined && dossierState !== null) {
                propertiesWithoutMissing[DOSSIER_STATE_PROPERTY] = dossierState;
              }
              updateResponse = await hubspotClient.crm.objects.basicApi.update(
                objectTypeName,
                objectInstanceId,
                { properties: propertiesWithoutMissing }
              );
              return {
                status: 'success',
                message: `Properties updated (${MISSING_DOC_PROPERTY} property does not exist)`,
                data: {
                  completionStatus: completionStatus !== undefined ? stringValue : null,
                  dossierState: dossierState,
                  missingDoc: null,
                  response: updateResponse
                }
              };
            } catch (retryErr) {
              // Continue to fallback
            }
          } else if (propertyError === DOSSIER_STATE_PROPERTY) {
            try {
              const propertiesWithoutDossier = {};
              if (completionStatus !== undefined) {
                propertiesWithoutDossier[COMPLETION_PROPERTY] = stringValue;
              }
              if (missingDoc !== undefined && missingDoc !== null) {
                propertiesWithoutDossier[MISSING_DOC_PROPERTY] = String(missingDoc);
              }
              updateResponse = await hubspotClient.crm.objects.basicApi.update(
                objectTypeName,
                objectInstanceId,
                { properties: propertiesWithoutDossier }
              );
              return {
                status: 'success',
                message: `Completion status and missing_doc updated (${DOSSIER_STATE_PROPERTY} property does not exist)`,
                data: {
                  completionStatus: completionStatus !== undefined ? stringValue : null,
                  dossierState: null,
                  missingDoc: missingDoc || '',
                  response: updateResponse
                }
              };
            } catch (retryErr) {
              // Continue to fallback
            }
          } else if (propertyError === COMPLETION_PROPERTY) {
            try {
              const propertiesWithoutCompletion = {
                [DOSSIER_STATE_PROPERTY]: dossierState
              };
              if (missingDoc !== undefined && missingDoc !== null) {
                propertiesWithoutCompletion[MISSING_DOC_PROPERTY] = String(missingDoc);
              }
              updateResponse = await hubspotClient.crm.objects.basicApi.update(
                objectTypeName,
                objectInstanceId,
                { properties: propertiesWithoutCompletion }
              );
              return {
                status: 'success',
                message: `Dossier state and missing_doc updated (${COMPLETION_PROPERTY} property does not exist)`,
                data: {
                  completionStatus: null,
                  dossierState: dossierState,
                  missingDoc: missingDoc || '',
                  response: updateResponse
                }
              };
            } catch (retryErr) {
              // Continue to fallback
            }
          } else {
            const updatedProperties = {};
            const failedProperties = [];
            
            if (completionStatus !== undefined) {
              try {
                await hubspotClient.crm.objects.basicApi.update(
                  objectTypeName,
                  objectInstanceId,
                  { properties: { [COMPLETION_PROPERTY]: stringValue } }
                );
                updatedProperties[COMPLETION_PROPERTY] = stringValue;
              } catch (err) {
                failedProperties.push(COMPLETION_PROPERTY);
              }
            }
            
            try {
              await hubspotClient.crm.objects.basicApi.update(
                objectTypeName,
                objectInstanceId,
                { properties: { [DOSSIER_STATE_PROPERTY]: dossierState } }
              );
              updatedProperties[DOSSIER_STATE_PROPERTY] = dossierState;
            } catch (err) {
              failedProperties.push(DOSSIER_STATE_PROPERTY);
            }
            
            if (missingDoc !== undefined && missingDoc !== null) {
              try {
                await hubspotClient.crm.objects.basicApi.update(
                  objectTypeName,
                  objectInstanceId,
                  { properties: { [MISSING_DOC_PROPERTY]: String(missingDoc) } }
                );
                updatedProperties[MISSING_DOC_PROPERTY] = String(missingDoc);
              } catch (err) {
                failedProperties.push(MISSING_DOC_PROPERTY);
              }
            }
            
            if (Object.keys(updatedProperties).length > 0) {
              return {
                status: 'partial_success',
                message: `Some properties updated. Failed: ${failedProperties.join(', ')}`,
                data: {
                  completionStatus: updatedProperties[COMPLETION_PROPERTY] || null,
                  dossierState: updatedProperties[DOSSIER_STATE_PROPERTY] || null,
                  missingDoc: updatedProperties[MISSING_DOC_PROPERTY] || null,
                  failedProperties: failedProperties
                }
              };
            }
          }
        }
        
        throw firstErr;
      }
      
      return {
        status: 'success',
        message: 'Properties updated successfully',
        data: {
          completionStatus: completionStatus !== undefined ? stringValue : null,
          dossierState: dossierState,
          missingDoc: missingDoc || '',
          response: updateResponse
        }
      };
      
    } catch (apiError) {
      const statusCode = apiError.statusCode || apiError.code;
      const errorBody = apiError.body || apiError.response?.body || '';
      const errorMessage = apiError.message || 'Unknown error';
      
      let formattedError = `API error: HTTP-Code: ${statusCode || 'Unknown'}\nMessage: ${errorMessage}`;
      if (errorBody) {
        if (typeof errorBody === 'string') {
          formattedError += `\nBody: ${errorBody}`;
        } else {
          formattedError += `\nBody: ${JSON.stringify(errorBody)}`;
        }
      }
      
      return {
        status: 'error',
        message: formattedError
      };
    }
  } catch (error) {
    return {
      status: 'error',
      message: error.message
    };
  }
};
