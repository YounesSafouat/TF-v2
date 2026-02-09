const { Client } = require('@hubspot/api-client');

const PROPS = {
  COMPLETION: 'documents_completed',
  STATE: 'etat_du_dossier',
  MISSING: 'missing_doc'
};

function findFailedProperty(error) {
  const body = error.body;
  if (!body) return null;

  const match = typeof body === 'string'
    ? body.match(/"([^"]+)" does not exist/)
    : body.errors?.find(e => e.message)?.message.match(/"([^"]+)" does not exist/);

  return match ? match[1] : null;
}

exports.main = async (context = {}) => {
  try {
    let objectId = context.propertiesToSend?.hs_object_id
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

    const objectTypeId = process.env['dossier_j_ID'] || process.env['sandbox_dossier_j_ID'] || '2-141688426';
    const objectTypeName = process.env['dossier_j_NAME'] || process.env['sandbox_dossier_j_NAME'] || 'p_dossier_juridique';

    if (!token) {
      return { status: 'error', message: 'API key not found' };
    }

    objectId = String(objectId);
    if (objectId.includes('-')) {
      objectId = objectId.split('-').pop();
    }

    if (!objectId) {
      return { status: 'error', message: 'Missing object ID' };
    }

    const isMissingDocOnly = completionStatus === undefined && dossierState === undefined;
    if (!isMissingDocOnly && (completionStatus === undefined || dossierState === undefined)) {
      return { status: 'error', message: 'Missing required parameters' };
    }

    const properties = {};
    const completionValue = (completionStatus === true || completionStatus === 'true') ? 'true' : 'false';

    if (completionStatus !== undefined) {
      properties[PROPS.COMPLETION] = completionValue;
    }
    if (dossierState !== undefined && dossierState !== null) {
      properties[PROPS.STATE] = dossierState;
    }
    if (missingDoc !== undefined && missingDoc !== null) {
      properties[PROPS.MISSING] = String(missingDoc);
    }

    const hubspotClient = new Client({
      accessToken: token,
      basePath: 'https://api-eu1.hubapi.com'
    });

    try {
      const response = await hubspotClient.crm.objects.basicApi.update(
        objectTypeName,
        objectId,
        { properties }
      );

      return {
        status: 'success',
        message: 'Properties updated successfully',
        data: { completionStatus: completionValue, dossierState, missingDoc: missingDoc || '' }
      };

    } catch (err) {
      if (err.statusCode === 404) {
        return { status: 'success', message: 'Object not found, update skipped' };
      }

      if (err.statusCode === 400) {
        const failedProp = findFailedProperty(err);
        if (failedProp && properties[failedProp] !== undefined) {
          delete properties[failedProp];

          if (Object.keys(properties).length > 0) {
            try {
              await hubspotClient.crm.objects.basicApi.update(objectTypeName, objectId, { properties });
              return {
                status: 'success',
                message: `Updated (${failedProp} does not exist)`,
                data: { completionStatus: properties[PROPS.COMPLETION] || null, dossierState: properties[PROPS.STATE] || null }
              };
            } catch (retryErr) {
            }
          }
        }

        const updated = {};
        const failed = [];

        for (const [key, value] of Object.entries(properties)) {
          try {
            await hubspotClient.crm.objects.basicApi.update(objectTypeName, objectId, { properties: { [key]: value } });
            updated[key] = value;
          } catch (e) {
            failed.push(key);
          }
        }

        if (Object.keys(updated).length > 0) {
          return {
            status: 'partial_success',
            message: `Partial update. Failed: ${failed.join(', ')}`,
            data: { updated, failed }
          };
        }
      }

      throw err;
    }

  } catch (error) {
    const msg = error.body?.message || error.message || 'Unknown error';
    return { status: 'error', message: msg };
  }
};
