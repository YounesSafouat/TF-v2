/**
 * HubSpot Serverless Function: Update Documents
 * 
 * Updates document required/provided status properties in HubSpot custom objects.
 * Handles property validation errors by automatically removing non-existent properties
 * and retrying the update.
 */

const { Client } = require('@hubspot/api-client');

/**
 * Main serverless function entry point.
 * Updates document properties (required/provided status) in bulk.
 * 
 * @param {Object} context - HubSpot serverless function context
 * @param {Object} context.parameters.documents - Object with property names as keys and boolean/string values
 * @param {string} context.parameters.hs_object_id - HubSpot object ID
 * @returns {Object} Response with status and message
 */
exports.main = async (context = {}) => {
  try {
    const hs_object_id = context.propertiesToSend?.hs_object_id 
      || context.recordId 
      || context.parameters?.hs_object_id
      || context.hs_object_id;
    const { documents } = context.parameters || {};
    
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
    
    if (!objectInstanceId || !token || !documents) {
      return { 
        status: 'error',
        message: 'Missing required parameters (object ID, token, or documents)'
      };
    }
    
    const hubspotClient = new Client({ 
      accessToken: token,
      basePath: 'https://api-eu1.hubapi.com'
    });
    
    try {
        const properties = {};
        
      Object.keys(documents).forEach((key) => {
          const value = documents[key];
          
          if (typeof value === 'boolean') {
            properties[key] = value ? 'true' : 'false';
        } else if (value === null || value === undefined || value === '') {
            return;
          } else {
            properties[key] = value;
          }
        });
        
        if (Object.keys(properties).length === 0) {
          return {
            status: 'success',
            message: 'No properties to update',
            data: {}
          };
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
        
        // Handle property validation errors by removing non-existent properties and retrying
        if (firstErr.statusCode === 400 && firstErr.body) {
          const failedProperties = new Set();
          
          if (typeof firstErr.body === 'string') {
            const patterns = [
              /"([^"]+)" does not exist/g,
              /property "([^"]+)" does not exist/gi,
              /"([^"]+)"[^"]*does not exist/gi
            ];
            for (const pattern of patterns) {
              let match;
              while ((match = pattern.exec(firstErr.body)) !== null) {
                if (match[1]) {
                  failedProperties.add(match[1]);
                }
              }
            }
          } else if (firstErr.body.errors && Array.isArray(firstErr.body.errors)) {
            firstErr.body.errors.forEach((err) => {
              if (err.context && err.context.propertyName) {
                if (Array.isArray(err.context.propertyName)) {
                  err.context.propertyName.forEach(prop => failedProperties.add(prop));
                } else {
                  failedProperties.add(err.context.propertyName);
                }
              }
              if (err.name) {
                failedProperties.add(err.name);
              }
              if (err.message) {
                const patterns = [
                  /"([^"]+)" does not exist/g,
                  /property "([^"]+)" does not exist/gi,
                  /"([^"]+)"[^"]*does not exist/gi
                ];
                for (const pattern of patterns) {
                  let match;
                  while ((match = pattern.exec(err.message)) !== null) {
                    if (match[1]) {
                      failedProperties.add(match[1]);
                    }
                  }
                }
                  }
            });
          }
          
          if (failedProperties.size > 0) {
            failedProperties.forEach(prop => {
              if (properties[prop] !== undefined) {
                delete properties[prop];
              }
            });
            
            if (Object.keys(properties).length > 0) {
              try {
                updateResponse = await hubspotClient.crm.objects.basicApi.update(
                  objectTypeName,
                  objectInstanceId,
                  { properties }
                );
              } catch (retryErr) {
                if (retryErr.statusCode === 400 && retryErr.body) {
                  const moreFailedProps = new Set();
                  if (retryErr.body.errors && Array.isArray(retryErr.body.errors)) {
                    retryErr.body.errors.forEach(err => {
                      if (err.context && err.context.propertyName) {
                        if (Array.isArray(err.context.propertyName)) {
                          err.context.propertyName.forEach(prop => moreFailedProps.add(prop));
                        } else {
                          moreFailedProps.add(err.context.propertyName);
                        }
                      }
                    });
                  }
                  moreFailedProps.forEach(prop => {
                    if (properties[prop] !== undefined) {
                      delete properties[prop];
                    }
                  });
                  
                  if (Object.keys(properties).length > 0) {
                    updateResponse = await hubspotClient.crm.objects.basicApi.update(
                      objectTypeName,
                      objectInstanceId,
                      { properties }
                    );
                  } else {
                    return {
                      status: 'success',
                      message: 'Update skipped - all properties do not exist',
                      data: {}
                    };
                  }
                } else {
                throw retryErr;
                }
              }
            } else {
              return {
                status: 'success',
                message: 'Update skipped - all properties do not exist',
                data: {}
              };
            }
          } else {
            throw firstErr;
          }
        } else {
          throw firstErr;
        }
      }
      
      return {
        status: 'success',
        message: 'Documents updated successfully',
        data: updateResponse
      };
    } catch (apiError) {
      const statusCode = apiError.statusCode || apiError.code;
      let errorBody = apiError.body || apiError.response?.body || '';
      const errorMessage = apiError.message || 'Unknown error';
      
      let errorDetails = '';
      if (errorBody) {
        if (typeof errorBody === 'string') {
          errorDetails = errorBody;
        } else if (errorBody.message) {
          errorDetails = errorBody.message;
        } else if (errorBody.errors && Array.isArray(errorBody.errors)) {
          errorDetails = errorBody.errors.map(e => e.message || JSON.stringify(e)).join('; ');
        } else {
          errorDetails = JSON.stringify(errorBody);
        }
      }
      
      let formattedError = `API error: HTTP-Code: ${statusCode || 'Unknown'}\nMessage: ${errorMessage}`;
      if (errorDetails) {
        formattedError += `\nDetails: ${errorDetails}`;
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
