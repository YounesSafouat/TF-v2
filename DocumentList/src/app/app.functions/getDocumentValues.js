const { Client } = require('@hubspot/api-client');

const conditionalProperties = [
  "sous_categorie",
  "avez_vous_un_statut_refugie_ou_apatride__",
  "quelle_est_votre_situation_professionnel__",
  "quelle_est_votre_situation_familliale",
  "avez_vous_des_enfant_mineur__",
  "domicile__",
  "percevez_vous_",
  "quel_est_votre_lien_avec_le_descendant_francais__",
  "avez_vous_fait_votre_scolarite_formation_en_france__",
  "quelle_est_votre_situation_professionnel_aes__",
  "type_d_entree_en_france",
  "quel_est_votre_lien_avec_le_refugie__",
  "vous_etes_entree_en_france_en_tant_que__",
  "revenu_percu_par_letudiant__",
  "etes_vous_marie_depuis_moins_de_5_ans__",
  "votre_mariage_a_t_il_ete_celebre_a_l_etranger__",
  "l_un_des_epoux__ou_les_deux__a_t_il_eu_des_unions_anterieures__",
  "avez_vous_des_enfants__mineurs_ou_majeurs___",
  "avez_vous_des_enfants_mineurs_etrangers_residant_avec_vous__",
  "etes_vous_entre_en_france_il_y_a_moins_de_10_ans__"
];

exports.main = async (context = {}) => {
  try {
    const objectId = context.parameters?.hs_object_id
      || context.propertiesToSend?.hs_object_id
      || context.recordId
      || context.hs_object_id;

    const token = context.accessToken
      || context.secrets?.PRIVATE_APP_ACCESS_TOKEN
      || context.secrets?.ACCESS_TOKEN
      || process.env['PRIVATE_APP_ACCESS_TOKEN']
      || process.env['hubspot_api_key']
      || process.env['sandbox_hubspot_api_key'];

    const objectTypeId = process.env['dossier_j_ID'] || process.env['sandbox_dossier_j_ID'] || '2-141688426';
    const objectTypeName = process.env['dossier_j_NAME'] || process.env['sandbox_dossier_j_NAME'] || 'p_dossier_juridique';

    if (!objectId || !token) {
      return { error: 'Missing object ID or access token' };
    }

    const propertyNames = context.parameters?.propertyNames || [];
    const includeCompletion = context.parameters?.includeCompletion || false;

    const properties = propertyNames.length
      ? [...propertyNames]
      : ['passport_required', 'passport_provided'];

    if (includeCompletion) {
      properties.push('documents_completed', 'etat_du_dossier');
    }

    conditionalProperties.forEach(prop => {
      if (!properties.includes(prop)) properties.push(prop);
    });

    const hubspotClient = new Client({
      accessToken: token,
      basePath: 'https://api-eu1.hubapi.com'
    });

    const BATCH_SIZE = 100;
    const allProperties = {};

    const sorted = ['sous_categorie', ...properties.filter(p => p !== 'sous_categorie')];

    for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
      const batch = sorted.slice(i, i + BATCH_SIZE);

      try {
        let response;
        try {
          response = await hubspotClient.crm.objects.basicApi.getById(objectTypeName, String(objectId), batch);
        } catch (e) {
          response = await hubspotClient.crm.objects.basicApi.getById(objectTypeId, String(objectId), batch);
        }

        if (response?.properties) {
          Object.assign(allProperties, response.properties);
        }
      } catch (err) {
        if (err.statusCode === 404) {
          return { error: 'Object not found' };
        }
        batch.forEach(prop => { if (!(prop in allProperties)) allProperties[prop] = null; });
      }
    }

    const result = {};
    properties.forEach(prop => {
      const raw = allProperties[prop];
      if (prop.includes('_required') || prop.includes('_provided')) {
        result[prop] = (raw === null || raw === undefined || raw === '') ? 'false' : String(raw);
      } else {
        if (raw === null || raw === undefined || raw === '') {
          result[prop] = '';
        } else if (Array.isArray(raw)) {
          result[prop] = raw.join(';');
        } else if (typeof raw === 'object' && raw.value !== undefined) {
          result[prop] = Array.isArray(raw.value) ? raw.value.join(';') : String(raw.value);
        } else {
          result[prop] = String(raw);
        }
      }
    });

    const status = Object.keys(result).length > 0 ? 'success' : 'empty';
    console.log(`Documents initialized with status: ${status}`);

    return result;

  } catch (error) {
    return { error: error.message };
  }
};
