const { Client } = require('@hubspot/api-client');

function extractFailedProperties(error) {
  const failed = new Set();
  const body = error.body;

  if (!body) return failed;

  const patterns = [/"([^"]+)" does not exist/g, /property "([^"]+)" does not exist/gi];

  if (typeof body === 'string') {
    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(body)) !== null) {
        if (match[1]) failed.add(match[1]);
      }
    });
  } else if (body.errors && Array.isArray(body.errors)) {
    body.errors.forEach(err => {
      if (err.context?.propertyName) {
        const names = Array.isArray(err.context.propertyName) ? err.context.propertyName : [err.context.propertyName];
        names.forEach(n => failed.add(n));
      }
      if (err.message) {
        patterns.forEach(pattern => {
          let match;
          while ((match = pattern.exec(err.message)) !== null) {
            if (match[1]) failed.add(match[1]);
          }
        });
      }
    });
  }

  return failed;
}

exports.main = async (context = {}) => {
  let finalStatus = 'error';
  let result = { status: 'error', message: 'Unknown error' };
  
  try {
    let objectId = context.propertiesToSend?.hs_object_id
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

    const objectTypeName = process.env['dossier_j_NAME'] || process.env['sandbox_dossier_j_NAME'] || 'p_dossier_juridique';

    if (!token) {
      finalStatus = 'error';
      result = { status: 'error', message: 'API key not found' };
    } else {
      objectId = String(objectId);
      if (objectId.includes('-')) {
        objectId = objectId.split('-').pop();
      }

      if (!objectId || !documents) {
        finalStatus = 'error';
        result = { status: 'error', message: 'Missing required parameters' };
      } else {
        const properties = {};
        
        Object.entries(documents).forEach(([key, value]) => {
          if (typeof value === 'boolean') {
            properties[key] = value ? 'true' : 'false';
          } else if (value !== null && value !== undefined && value !== '') {
            properties[key] = value;
          }
        });

        if (Object.keys(properties).length === 0) {
          finalStatus = 'success';
          result = { status: 'success', message: 'No properties to update', data: {} };
        } else {
          const hubspotClient = new Client({
            accessToken: token,
            basePath: 'https://api-eu1.hubapi.com'
          });

          let retries = 2;
          let updateSuccess = false;
          
          while (retries > 0 && !updateSuccess) {
            try {
              const response = await hubspotClient.crm.objects.basicApi.update(
                objectTypeName,
                objectId,
                { properties }
              );

              finalStatus = response?.id ? 'success' : 'error';
              result = { status: 'success', message: 'Documents updated successfully', data: response };
              updateSuccess = true;

            } catch (err) {
              if (err.statusCode === 404) {
                finalStatus = 'success';
                result = { status: 'success', message: 'Object not found, update skipped' };
                updateSuccess = true;
              } else if (err.statusCode === 400) {
                const failed = extractFailedProperties(err);
                if (failed.size > 0) {
                  failed.forEach(prop => delete properties[prop]);

                  if (Object.keys(properties).length === 0) {
                    finalStatus = 'success';
                    result = { status: 'success', message: 'Update skipped - properties do not exist', data: {} };
                    updateSuccess = true;
                  } else {
                    retries--;
                  }
                } else {
                  throw err;
                }
              } else {
                throw err;
              }
            }
          }

          if (!updateSuccess) {
            finalStatus = 'error';
            const remainingProps = Object.keys(properties);
            result = { status: 'error', message: `Update failed after retries. Remaining properties: ${remainingProps.slice(0, 5).join(', ')}${remainingProps.length > 5 ? '...' : ''}` };
          }
        }
      }
    }
  } catch (error) {
    const msg = error.body?.message || error.message || 'Unknown error';
    const statusCode = error.statusCode || error.status || 'unknown';
    finalStatus = 'error';
    result = { status: 'error', message: `${msg} (status: ${statusCode})` };
    console.error(`[updateDocuments] Error caught:`, error);
    if (error.body) {
      console.error(`[updateDocuments] Error body:`, JSON.stringify(error.body, null, 2));
    }
  }

  console.log(`Documents updated with status: ${finalStatus}`);
  if (finalStatus === 'error') {
    console.error(`[updateDocuments] Error message: ${result.message}`);
  }
  return result;
};
