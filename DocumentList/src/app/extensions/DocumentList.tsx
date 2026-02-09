/**
 * Document List Extension for HubSpot
 * 
 * Manages document requirements and completion status for legal dossiers.
 * Documents can be conditionally required based on HubSpot record properties,
 * and the extension automatically tracks completion status and missing documents.
 */

import React, { useEffect, useState } from 'react';
import {
  hubspot,
  Checkbox,
  Flex,
  Text,
  LoadingSpinner,
  Alert,
  Box,
  Button,
  Divider,
  Tag,
  Tabs,
  Tab,
  ProgressBar,
  EmptyState,
  StepIndicator,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  type CrmContext,
} from '@hubspot/ui-extensions';

import documentsConfig from './documents.json';
import tabsConfig from './tabs.json';
import conditionalPropertiesConfig from './conditionalProperties.json';

hubspot.extend<'crm.record.tab'>(({ context, actions }) => <Extension context={context} actions={actions} />);

interface ExtensionProps {
  context: CrmContext;
  actions: {
    closeOverlay: (id: string) => void;
  };
}

/**
 * Condition for determining when a document should be required.
 * Conditions are evaluated against HubSpot record properties.
 */
interface DocumentCondition {
  property: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'in';
  value: string;
}

/**
 * Tab-specific configuration for a document.
 * Each tab can have its own order and conditions.
 */
interface TabConfig {
  order: number;
  conditions: DocumentCondition[];
}

/**
 * Document configuration loaded from JSON.
 * Uses tabConfig for per-tab conditions and ordering.
 */
interface DocumentConfig {
  id: string;
  name: string;
  requiredProperty: string;
  providedProperty: string;
  tabConfig: Record<string, TabConfig>;
}

/**
 * Document state at runtime.
 * Includes current required/provided status and per-tab configuration.
 */
interface Document {
  id: string;
  name: string;
  required: boolean;
  provided: boolean;
  requiredProperty: string;
  providedProperty: string;
  tabConfig: Record<string, TabConfig>;
}

const DOCUMENTS_CONFIG: DocumentConfig[] = documentsConfig as DocumentConfig[];
const TABS_CONFIG = tabsConfig as Array<{ id: string; title: string; description: string }>;

const INITIAL_DOCUMENTS: Document[] = DOCUMENTS_CONFIG.map(config => ({
  id: config.id,
  name: config.name,
  required: false,
  provided: false,
  requiredProperty: config.requiredProperty,
  providedProperty: config.providedProperty,
  tabConfig: config.tabConfig || {}
}));

const COMPLETION_PROPERTY = 'documents_completed';
const DOSSIER_STATE_PROPERTY = 'etat_du_dossier';
const MISSING_DOC_PROPERTY = 'missing_doc';

const DOSSIER_STATES = {
  TO_BUILD: "À construire",
  INCOMPLETE: "En construction",
  COMPLETE: "Complet"
};

/**
 * Helper function to check if a document belongs to a specific tab.
 * Uses the new tabConfig structure where each document has per-tab configuration.
 */
const documentBelongsToTab = (doc: Document, tabId: string): boolean => {
  return doc.tabConfig && tabId in doc.tabConfig;
};

/**
 * Helper function to get the order for a document in a specific tab.
 * Returns the order from tabConfig or 9999 if not found.
 */
const getOrderForTab = (doc: Document, tabId: string): number => {
  return doc.tabConfig?.[tabId]?.order ?? 9999;
};

/**
 * Helper function to get conditions for a document in a specific tab.
 * Returns the conditions array from tabConfig or empty array if not found.
 */
const getConditionsForTab = (doc: Document, tabId: string): DocumentCondition[] => {
  return doc.tabConfig?.[tabId]?.conditions || [];
};

/**
 * Helper function to get all conditions across all tabs for a document.
 * Used when checking if any conditions match regardless of tab.
 */
const getAllConditions = (doc: Document): DocumentCondition[] => {
  if (!doc.tabConfig) return [];
  const allConditions: DocumentCondition[] = [];
  Object.values(doc.tabConfig).forEach(config => {
    if (config.conditions) {
      allConditions.push(...config.conditions);
    }
  });
  return allConditions;
};

/**
 * Helper function to get the first tab a document belongs to.
 * Returns null if document has no tab configuration.
 */
const getFirstTab = (doc: Document): string | null => {
  if (!doc.tabConfig) return null;
  const tabs = Object.keys(doc.tabConfig);
  return tabs.length > 0 ? tabs[0] : null;
};

/**
 * Converts various HubSpot property value formats to boolean.
 * Handles strings like "true", "false", "Oui", "Non", "1", "0", etc.
 */
const toBool = (value: any): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  
  if (value === null || value === undefined || value === '') {
    return false;
  }
  
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'oui') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'non' || lower === '--') {
      return false;
    }
    return false;
  }
  
  if (typeof value === 'number') {
    return value !== 0;
  }
  
  return Boolean(value);
};

const Extension = ({ context, actions }: ExtensionProps) => {
  const [documents, setDocuments] = useState<Document[]>(INITIAL_DOCUMENTS);
  const [recordProperties, setRecordProperties] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [isChanged, setIsChanged] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [existingProperties, setExistingProperties] = useState<Set<string>>(new Set());
  const [dossierState, setDossierState] = useState(DOSSIER_STATES.TO_BUILD);
  const [initialCompletionStatus, setInitialCompletionStatus] = useState(false);
  const [initialDossierState, setInitialDossierState] = useState(DOSSIER_STATES.TO_BUILD);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showEmailSuccess, setShowEmailSuccess] = useState(false);
  // Initialize selected tab - will be updated when sous_categorie is loaded
  const [selectedTab, setSelectedTab] = useState<string>(TABS_CONFIG[0]?.id || 'autre');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [natureDemande, setNatureDemande] = useState<string>('');
  const [isRefugieApatride, setIsRefugieApatride] = useState<boolean>(false);
  const [refugieRaw, setRefugieRaw] = useState<string>('');
  const [hasConfigError, setHasConfigError] = useState<boolean>(false);
  const [isAutoSaving, setIsAutoSaving] = useState<boolean>(false);

  /**
   * Checks if all required documents have been provided.
   * Returns true only if there are required documents and all are provided.
   */
  const checkCompletion = (docs: Document[]): boolean => {
    const incompleteRequired = docs.find(doc => doc.required && !doc.provided);
    const hasRequiredDocs = docs.some(doc => doc.required);
    return !incompleteRequired && hasRequiredDocs;
  };

  /**
   * Calculates the dossier state based on document status.
   * States: TO_BUILD (no required docs), INCOMPLETE (some provided), COMPLETE (all provided).
   */
  const calculateDossierState = (docs: Document[]): string => {
    const hasRequiredDocs = docs.some(doc => doc.required);
    if (!hasRequiredDocs) {
      return DOSSIER_STATES.TO_BUILD;
    }
    
    const anyProvided = docs.some(doc => doc.provided);
    if (anyProvided) {
      const allRequiredProvided = !docs.some(doc => doc.required && !doc.provided);
      return allRequiredProvided ? DOSSIER_STATES.COMPLETE : DOSSIER_STATES.INCOMPLETE;
    }
    
    return DOSSIER_STATES.TO_BUILD;
  };

  // Fetch initial data and refetch when window regains focus (detects external changes)
  useEffect(() => {
    fetchDocumentValues();
    
    if (typeof window !== 'undefined') {
      const handleFocus = () => {
        fetchDocumentValues();
      };
      
      window.addEventListener('focus', handleFocus);
      return () => window.removeEventListener('focus', handleFocus);
    }
  }, []);

  /**
   * Calculates missing documents (required but not provided) and formats as HTML list.
   * Used for the missing_doc HubSpot property which is a Rich Text field.
   */
  const calculateMissingDocuments = (docs: Document[], properties?: Record<string, any>): string => {
    const propsToUse = properties || recordProperties;
    
    const missingDocs = docs
      .filter(doc => {
        const conditionsMet = checkDocumentConditions(doc, propsToUse);
        const hasConditions = getAllConditions(doc).length > 0;

        // A document is required if manually marked as required OR if conditions are met
        const isRequired = doc.required || (hasConditions ? conditionsMet : false);

        return isRequired && !doc.provided;
      })
      .map(doc => doc.name)
      .filter(name => name.trim() !== '');

    if (missingDocs.length === 0) {
      return '';
    }
    const listItems = missingDocs.map(docName => `<li>${docName}</li>`).join('');
    return `<ul>${listItems}</ul>`;
  };

  /**
   * Returns array of missing document names for display in UI (e.g., modal).
   */
  const getMissingDocumentsList = (docs: Document[], properties?: Record<string, any>): string[] => {
    const propsToUse = properties || recordProperties;

    const missingDocs = docs
      .filter(doc => {
        const conditionsMet = checkDocumentConditions(doc, propsToUse);
        const hasConditions = getAllConditions(doc).length > 0;

        // A document is required if manually marked as required OR if conditions are met
        const isRequired = doc.required || (hasConditions ? conditionsMet : false);

        return isRequired && !doc.provided;
      })
      .map(doc => doc.name)
      .filter(name => name.trim() !== '');

    return missingDocs;
  };

  /**
   * Updates the send_mail property to true when user sends email notification.
   */
  const updateSendMailProperty = async (): Promise<boolean> => {
    const objectId = context.crm?.objectId;
    
    if (!objectId) {
      return false;
    }
    
    try {
      await hubspot.serverless('updateDocuments', {
        parameters: {
          hs_object_id: objectId.toString(),
          documents: {
            send_mail: true
          }
        }
      });
      
      return true;
    } catch (err) {
      setError(err?.message || 'Erreur lors de l\'envoi de l\'email');
      return false;
    }
  };

  /**
   * Updates only the missing_doc property in HubSpot.
   * Called automatically when document status changes.
   */
  const updateMissingDocProperty = async (missingDocs: string) => {
    const objectId = context.crm?.objectId;
    
    if (!objectId) {
      return false;
    }
    
    // Skip if we know there's a configuration issue
    if (hasConfigError) {
      return false;
    }
    
    try {
      const response = await hubspot.serverless('updateCompletionStatus', {
        parameters: {
          missingDoc: missingDocs,
          hs_object_id: objectId.toString()
        } as any
      });
      
      if (response?.status === 'error') {
        const errorMsg = response.message || '';
        
        // Check if it's a configuration error (API key, secrets, etc.)
        if (errorMsg.includes('API key') || errorMsg.includes('secret') || errorMsg.includes('token')) {
          if (!hasConfigError) {
            console.warn('[DocumentList] updateMissingDocProperty: Configuration issue detected -', errorMsg);
            console.warn('[DocumentList] updateMissingDocProperty: Please check HubSpot app secrets configuration. Updates will be skipped.');
            setHasConfigError(true);
          }
          return false;
        }
        
        // Log other errors
        console.error('[DocumentList] updateMissingDocProperty: ERROR -', errorMsg);
        return false;
      }
      
      // Success - clear config error flag if it was set
      if (hasConfigError) {
        setHasConfigError(false);
      }
      
      return true;
    } catch (err) {
      const errorMsg = err?.message || String(err);
      
      // Check if it's a configuration error
      if (errorMsg.includes('API key') || errorMsg.includes('secret') || errorMsg.includes('token')) {
        if (!hasConfigError) {
          console.warn('[DocumentList] updateMissingDocProperty: Configuration issue detected -', errorMsg);
          console.warn('[DocumentList] updateMissingDocProperty: Please check HubSpot app secrets configuration. Updates will be skipped.');
          setHasConfigError(true);
        }
        return false;
      }
      
      console.error('[DocumentList] updateMissingDocProperty: EXCEPTION -', errorMsg);
      return false;
    }
  };

  /**
   * Updates completion status, dossier state, and missing documents in HubSpot.
   * Called automatically when document states change.
   */
  const updateStatusProperties = async (completionStatus: boolean, dossierState: string, missingDocs: string) => {
    const objectId = context.crm?.objectId;
    
    if (!objectId) {
      console.error('[DocumentList] updateStatusProperties: No object ID');
      return false;
    }
    
    try {
      const response = await hubspot.serverless('updateCompletionStatus', {
        parameters: {
          completionStatus: completionStatus,
          dossierState: dossierState,
          missingDoc: missingDocs,
          hs_object_id: objectId.toString()
        }
      });
      
      if (response?.status === 'error') {
        const errorMsg = response.message || '';
        
        // Check if it's a configuration error
        if (errorMsg.includes('API key') || errorMsg.includes('secret') || errorMsg.includes('token')) {
          if (!hasConfigError) {
            console.warn('[DocumentList] updateStatusProperties: Configuration issue detected -', errorMsg);
            console.warn('[DocumentList] updateStatusProperties: Please check HubSpot app secrets configuration.');
            setHasConfigError(true);
          }
          setError('Configuration error: Please check HubSpot app secrets');
          return false;
        }
        
        console.error('[DocumentList] updateStatusProperties: ERROR -', errorMsg);
        setError(errorMsg || 'Error updating status properties');
        return false;
      }
      
      if (response?.status === 'success' || response?.status === 'partial_success') {
        console.log('[DocumentList] updateStatusProperties: SUCCESS -', {
          completionStatus,
          dossierState,
          missingDocsCount: missingDocs ? (missingDocs.match(/<li>/g) || []).length : 0
        });
        
        // Clear config error flag on success
        if (hasConfigError) {
          setHasConfigError(false);
        }
        
        return true;
      }
      
      // If no status field, assume success (backward compatibility)
      console.log('[DocumentList] updateStatusProperties: SUCCESS (backward compatibility)');
      return true;
    } catch (err) {
      const errorMsg = err?.message || String(err);
      
      // Check if it's a configuration error
      if (errorMsg.includes('API key') || errorMsg.includes('secret') || errorMsg.includes('token')) {
        if (!hasConfigError) {
          console.warn('[DocumentList] updateStatusProperties: Configuration issue detected -', errorMsg);
          console.warn('[DocumentList] updateStatusProperties: Please check HubSpot app secrets configuration.');
          setHasConfigError(true);
        }
        setError('Configuration error: Please check HubSpot app secrets');
        return false;
      }
      
      console.error('[DocumentList] updateStatusProperties: EXCEPTION -', errorMsg);
      setError(errorMsg || 'Error updating status properties');
      return false;
    }
  };

const [initialDocuments, setInitialDocuments] = useState<Document[]>([]);

  /**
   * Fetches document status from HubSpot and initializes component state.
   * Also handles auto-updating required status for documents with conditions.
   */
const fetchDocumentValues = async () => {
  setLoading(true);
  setError('');
  const objectId = context.crm?.objectId;
  
  if (!objectId) {
    setError('Object ID not found in context');
    setLoading(false);
    return;
  }
  
  // Skip if we know there's a configuration issue
  if (hasConfigError) {
    setLoading(false);
    return;
  }
  
    const propertyNames: string[] = [];
    // Always include sous_categorie for tab selection
    propertyNames.push('sous_categorie');
    
    // Add all conditional properties needed for condition evaluation
    if (Array.isArray(conditionalPropertiesConfig)) {
      conditionalPropertiesConfig.forEach(prop => {
        if (!propertyNames.includes(prop)) {
          propertyNames.push(prop);
        }
      });
    }
    
    // Add all document required/provided properties
    INITIAL_DOCUMENTS.forEach(doc => {
      if (doc.requiredProperty) {
        propertyNames.push(doc.requiredProperty);
      }
      if (doc.providedProperty) {
        propertyNames.push(doc.providedProperty);
      }
    });
  
  try {
    const response = await hubspot.serverless('getDocumentValues', {
      propertiesToSend: ['hs_object_id'],
      parameters: {
        propertyNames: propertyNames,
        includeCompletion: true,
        hs_object_id: objectId.toString()
      }
    });
    
    // Check if response contains an error (e.g., missing token)
    if (response?.error) {
      const errorMsg = response.error || '';
      
      // Check if it's a token/secret error
      if (errorMsg.includes('token') || errorMsg.includes('API key') || errorMsg.includes('secret') || errorMsg.includes('access token')) {
        // Only show warning once, and only if we haven't already logged it
        if (!hasConfigError) {
          // Check if we're in a development context (no object ID in context)
          const isDevContext = !context.crm?.objectId;
          
          if (isDevContext) {
            // During development/compilation, this is expected
            console.warn('[DocumentList] fetchDocumentValues: Secrets not available during development.');
            console.warn('[DocumentList] fetchDocumentValues: This is expected. The app will work when deployed with secrets configured.');
          } else {
            // In production, this is a real configuration issue
            console.error('[DocumentList] fetchDocumentValues: Configuration issue detected -', errorMsg);
            console.error('[DocumentList] fetchDocumentValues: Please configure HubSpot app secrets (hubspot_api_key or sandbox_hubspot_api_key)');
            setError('Configuration error: Please check HubSpot app secrets');
          }
          setHasConfigError(true);
        }
        setLoading(false);
        return;
      }
      
      // Other errors - clear config error flag if it's not a config issue
      if (hasConfigError) {
        setHasConfigError(false);
      }
      setError(errorMsg || 'Error fetching document values');
      setLoading(false);
      return;
    }
    
    // Success - clear config error flag
    if (hasConfigError) {
      setHasConfigError(false);
      setError('');
    }
    
    const properties = response || {};
    
    const getPropValue = (obj: any, needle: string) => {
      if (!obj) return undefined;
      const lower = needle.toLowerCase();
      const hitKey = Object.keys(obj).find(k => k.toLowerCase() === lower || k.toLowerCase().includes(lower));
      return hitKey ? obj[hitKey] : undefined;
    };

    const completionStatus = toBool(properties[COMPLETION_PROPERTY]);
    setIsCompleted(completionStatus);
    setInitialCompletionStatus(completionStatus);
    
    const currentDossierState = properties[DOSSIER_STATE_PROPERTY] || DOSSIER_STATES.TO_BUILD;
    setDossierState(currentDossierState);
    setInitialDossierState(currentDossierState);

    // Try multiple ways to get sous_categorie
    let nd = properties['sous_categorie'];
    
    if (!nd || nd === '' || nd === null || nd === undefined) {
      nd = getPropValue(properties, 'sous_categorie');
    }
    if (!nd || nd === '' || nd === null || nd === undefined) {
      // Try with different case variations
      const sousKeys = Object.keys(properties).filter(k => 
        k.toLowerCase().includes('sous') && k.toLowerCase().includes('categorie')
      );
      if (sousKeys.length > 0) {
        nd = properties[sousKeys[0]];
      }
    }
    
    nd = (nd || '').toString().trim();
    
    setNatureDemande(nd);
    
    // Ensure sous_categorie is in recordProperties for condition checking
    if (nd) {
      properties['sous_categorie'] = nd;
    }
    
    // Auto-select the tab based on sous_categorie
    if (nd) {
      const tabId = getTabForNatureDemande(nd);
      if (tabId) {
        setSelectedTab(tabId);
      }
    }
    const refugieVal = getPropValue(properties, 'avez_vous_un_statut_refugie_ou_apatride');
    const refugieStr = refugieVal === undefined || refugieVal === null ? '' : String(refugieVal);
    setRefugieRaw(refugieStr);
    setIsRefugieApatride(toBool(refugieStr));
    
    setRecordProperties(properties);
    
    const propertiesSet = new Set<string>();
    Object.keys(properties).forEach(key => {
      if (key.includes('_required') || key.includes('_provided')) {
        propertiesSet.add(key);
      }
    });
    setExistingProperties(propertiesSet);
    
      let updatedDocuments = INITIAL_DOCUMENTS.map(doc => {
      const requiredProp = doc.requiredProperty;
      const providedProp = doc.providedProperty;
      const requiredRaw = properties[requiredProp];
      const providedRaw = properties[providedProp];
        // toBool converts undefined/null/'' to false, 'true'/'false' strings to boolean
        const requiredFromHubSpot = toBool(requiredRaw);
      const provided = toBool(providedRaw);
      
      // Debug logging for documents that should be required
      if (doc.id === 'timbre_fiscal_de_55') {
        console.log(`[fetchDocumentValues] Document "${doc.name}":`);
        console.log(`[fetchDocumentValues]   requiredRaw from HubSpot: "${requiredRaw}" (type: ${typeof requiredRaw})`);
        console.log(`[fetchDocumentValues]   requiredFromHubSpot: ${requiredFromHubSpot}`);
        console.log(`[fetchDocumentValues]   providedRaw from HubSpot: "${providedRaw}" (type: ${typeof providedRaw})`);
        console.log(`[fetchDocumentValues]   provided: ${provided}`);
        console.log(`[fetchDocumentValues]   Property exists in properties: ${requiredProp in properties}`);
      }
      
      // Log specific document for debugging
      if (doc.id.includes('document_justifiant_de_la_date_et_du_lieu_de_naissance')) {
        console.log(`[DocumentList] fetchDocumentValues: Document "${doc.name}"`);
        console.log(`[DocumentList] fetchDocumentValues: requiredRaw="${requiredRaw}" (type: ${typeof requiredRaw}) -> requiredFromHubSpot=${requiredFromHubSpot}`);
        console.log(`[DocumentList] fetchDocumentValues: providedRaw="${providedRaw}" (type: ${typeof providedRaw}) -> provided=${provided}`);
        console.log(`[DocumentList] fetchDocumentValues: Property names - required: "${requiredProp}", provided: "${providedProp}"`);
        console.log(`[DocumentList] fetchDocumentValues: Properties exist? required: ${requiredProp in properties}, provided: ${providedProp in properties}`);
      }
      
      const conditionsMet = checkDocumentConditions(doc, properties);
      const hasConditions = getAllConditions(doc).length > 0;

      let required: boolean;
      if (hasConditions) {
        if (conditionsMet) {
          required = true;
        } else {
          // If conditions are not met:
          // - If document is provided, keep the required status (user can manage in "autre" tab)
          // - If document is NOT provided, reset required to false
          if (provided) {
            required = requiredFromHubSpot; // Keep user's choice if provided
          } else {
            required = false; // Reset to false if not provided
          }
        }
      } else {
        required = requiredFromHubSpot;
      }

      return {
        ...doc,
        required,
        provided,
        _requiredFromHubSpot: requiredFromHubSpot,
        _shouldBeRequired: hasConditions
          ? (conditionsMet ? true : requiredFromHubSpot)
          : requiredFromHubSpot
      };
    });
    
    setDocuments(updatedDocuments);
    setInitialDocuments([...updatedDocuments]);
    
    const calculatedCompletion = checkCompletion(updatedDocuments);
    const calculatedDossierState = calculateDossierState(updatedDocuments);
    
    if (calculatedCompletion !== completionStatus || 
        calculatedDossierState !== currentDossierState) {
      setIsCompleted(calculatedCompletion);
      setDossierState(calculatedDossierState);
      setInitialCompletionStatus(calculatedCompletion);
      setInitialDossierState(calculatedDossierState);
    }
    
      // REMOVED AUTO-SAVE LOGIC - It was causing infinite loops
      // Users will need to manually save changes using the "Enregistrer les modifications" button
    
      const missingDocs = calculateMissingDocuments(updatedDocuments, properties);
      updateMissingDocProperty(missingDocs).catch(() => {});
    
    setIsChanged(false);
  } catch (err) {
    setError(err?.message || 'Unknown error fetching document values');
  } finally {
    setLoading(false);
  }
};

  /**
   * Handles checkbox toggles for required/provided status.
   * For documents with conditions, required status is controlled by conditions
   * unless in the "autre" tab where manual control is allowed.
   */
const handleCheckboxToggle = (documentId: string, field: 'required' | 'provided') => {
  return (checked: boolean, value: string) => {
    setDocuments(prevDocs => {
      const newDocs = prevDocs.map(doc => {
        if (doc.id === documentId) {
          if (field === 'required') {
            const conditionsMet = checkDocumentConditions(doc, recordProperties);
            const hasConditions = getAllConditions(doc).length > 0;
            const isAutreTab = selectedTab === 'autre';

            if (hasConditions && !isAutreTab) {
              if (conditionsMet && !checked) {
                return doc;
              }
              if (!conditionsMet && checked) {
                return doc;
              }
              return { ...doc, required: conditionsMet };
            }
            return { ...doc, [field]: checked };
          }
          return { ...doc, [field]: checked };
        }
        return doc;
      });
    
    const newCompletionStatus = checkCompletion(newDocs);
    const newDossierState = calculateDossierState(newDocs);
      setIsCompleted(newCompletionStatus);
      setDossierState(newDossierState);
      
      const missingDocs = calculateMissingDocuments(newDocs);
      
      // Only auto-update missing_doc property (calculated field)
      // Do NOT auto-update documents_completed or etat_du_dossier until user saves
      updateMissingDocProperty(missingDocs).catch(() => {});
      
      const completionChanged = newCompletionStatus !== initialCompletionStatus;
      const dossierStateChanged = newDossierState !== initialDossierState;
      const documentsChanged = newDocs.some((currentDoc, index) => {
        const initialDoc = initialDocuments[index];
        if (!initialDoc) return true;
        return currentDoc.required !== initialDoc.required || 
               currentDoc.provided !== initialDoc.provided;
      });
      setIsChanged(completionChanged || dossierStateChanged || documentsChanged);
      
      return newDocs;
    });
  };
};

  /**
   * Checks if any changes have been made compared to initial state.
   * Used to show/hide save/cancel buttons.
   */
const checkForChanges = () => {
  const completionChanged = isCompleted !== initialCompletionStatus;
  const dossierStateChanged = dossierState !== initialDossierState;
  const documentsChanged = documents.some((currentDoc, index) => {
    const initialDoc = initialDocuments[index];
      if (!initialDoc) return true;
    return currentDoc.required !== initialDoc.required || 
           currentDoc.provided !== initialDoc.provided;
  });
  setIsChanged(completionChanged || dossierStateChanged || documentsChanged);
};

  /**
   * Saves document changes to HubSpot.
   * @param docsToSave - Optional documents to save, defaults to current state
   * @param skipRefetch - If true, skips refetch after save (used for auto-saves)
   */
  const saveDocumentChanges = async (docsToSave?: Document[], skipRefetch: boolean = false) => {
  setSaving(true);
  setError('');
  
  try {
      const docs = docsToSave || documents;
    const documentProperties = {};
    
    // Get currently visible documents to prioritize their values when there are duplicates
    // Only if we have the necessary state (recordProperties, selectedTab, etc.)
    let visibleDocIds = new Set<string>();
    try {
      const visibleDocs = getVisibleDocuments();
      visibleDocIds = new Set(visibleDocs.map(d => d.id));
    } catch (err) {
      // If getVisibleDocuments fails (e.g., during initial load), just use all docs
      console.warn('[saveDocumentChanges] Could not get visible documents, using all documents:', err);
      visibleDocIds = new Set(docs.map(d => d.id));
    }
    
    // Track which properties we've seen to detect duplicates
    // When duplicates exist, prefer the value from a visible document
    const seenProperties = new Map<string, { docId: string; docName: string; value: any; isVisible: boolean }>();
    
      docs.forEach((doc) => {
      const requiredProp = doc.requiredProperty;
      const providedProp = doc.providedProperty;
        const isRequired = doc.required;
      const isVisible = visibleDocIds.has(doc.id);
      
      // Handle duplicate properties - prefer visible documents
      if (seenProperties.has(requiredProp)) {
        const previous = seenProperties.get(requiredProp)!;
        // If current doc is visible and previous wasn't, use current
        // If both are visible or both aren't, use the last one
        if (isVisible && !previous.isVisible) {
          console.warn(`[DocumentList] saveDocumentChanges: Duplicate required property "${requiredProp}" - using VISIBLE document`);
          console.warn(`[DocumentList] saveDocumentChanges: Previous (not visible): doc="${previous.docName}" (${previous.docId}) = ${previous.value}`);
          console.warn(`[DocumentList] saveDocumentChanges: New (visible): doc="${doc.name}" (${doc.id}) = ${isRequired}`);
          seenProperties.set(requiredProp, { docId: doc.id, docName: doc.name, value: isRequired, isVisible });
          documentProperties[requiredProp] = isRequired;
        } else if (!isVisible && previous.isVisible) {
          console.warn(`[DocumentList] saveDocumentChanges: Duplicate required property "${requiredProp}" - keeping VISIBLE document value`);
          // Keep previous value, don't update
        } else {
          // Both same visibility, use last one
          console.warn(`[DocumentList] saveDocumentChanges: Duplicate required property "${requiredProp}" - using last value`);
          seenProperties.set(requiredProp, { docId: doc.id, docName: doc.name, value: isRequired, isVisible });
          documentProperties[requiredProp] = isRequired;
        }
      } else {
        seenProperties.set(requiredProp, { docId: doc.id, docName: doc.name, value: isRequired, isVisible });
        documentProperties[requiredProp] = isRequired;
      }
      
      if (seenProperties.has(providedProp)) {
        const previous = seenProperties.get(providedProp)!;
        // If current doc is visible and previous wasn't, use current
        // If both are visible or both aren't, use the last one
        if (isVisible && !previous.isVisible) {
          console.warn(`[DocumentList] saveDocumentChanges: Duplicate provided property "${providedProp}" - using VISIBLE document`);
          console.warn(`[DocumentList] saveDocumentChanges: Previous (not visible): doc="${previous.docName}" (${previous.docId}) = ${previous.value}`);
          console.warn(`[DocumentList] saveDocumentChanges: New (visible): doc="${doc.name}" (${doc.id}) = ${doc.provided}`);
          seenProperties.set(providedProp, { docId: doc.id, docName: doc.name, value: doc.provided, isVisible });
          documentProperties[providedProp] = doc.provided;
        } else if (!isVisible && previous.isVisible) {
          console.warn(`[DocumentList] saveDocumentChanges: Duplicate provided property "${providedProp}" - keeping VISIBLE document value`);
          // Keep previous value, don't update
        } else {
          // Both same visibility, use last one
          console.warn(`[DocumentList] saveDocumentChanges: Duplicate provided property "${providedProp}" - using last value`);
          seenProperties.set(providedProp, { docId: doc.id, docName: doc.name, value: doc.provided, isVisible });
          documentProperties[providedProp] = doc.provided;
        }
      } else {
        seenProperties.set(providedProp, { docId: doc.id, docName: doc.name, value: doc.provided, isVisible });
        documentProperties[providedProp] = doc.provided;
      }
        
        // Log specific document for debugging
        if (doc.id.includes('document_justifiant_de_la_date_et_du_lieu_de_naissance')) {
          console.log(`[DocumentList] saveDocumentChanges: Document "${doc.name}" (id: ${doc.id})`);
          console.log(`[DocumentList] saveDocumentChanges: required=${isRequired} (property: ${requiredProp}), visible=${isVisible}`);
          console.log(`[DocumentList] saveDocumentChanges: provided=${doc.provided} (property: ${providedProp}), visible=${isVisible}`);
        }
      });
      
      // Log final values for the specific property
      const targetProp = 'document_justifiant_de_la_date_et_du_lieu_de_naissance_de_votre_pere_et_votre_mere_et_de_l_provided';
      if (targetProp in documentProperties) {
        const finalInfo = seenProperties.get(targetProp);
        console.log(`[DocumentList] saveDocumentChanges: FINAL value for ${targetProp} = ${documentProperties[targetProp]} (type: ${typeof documentProperties[targetProp]})`);
        if (finalInfo) {
          console.log(`[DocumentList] saveDocumentChanges: Final value comes from doc "${finalInfo.docName}" (${finalInfo.docId}), visible=${finalInfo.isVisible}`);
        }
      }
  
    const objectId = context.crm?.objectId;
    
    if (!objectId) {
      setError('Object ID not found in context');
      setSaving(false);
      return;
    }
    
    console.log('[DocumentList] saveDocumentChanges: Sending update for', Object.keys(documentProperties).length, 'properties');
    console.log('[DocumentList] saveDocumentChanges: Sample properties:', Object.entries(documentProperties).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(', '));
    
    const docResponse = await hubspot.serverless('updateDocuments', {
      parameters: {
        documents: documentProperties,
          hs_object_id: objectId.toString()
        }
      });
    
    console.log('[DocumentList] saveDocumentChanges: Response status:', docResponse?.status);
    console.log('[DocumentList] saveDocumentChanges: Response data:', docResponse?.data ? 'Received' : 'No data');
    
      if (docResponse?.status === 'error') {
        const errorMsg = docResponse.message || '';
        console.error('[DocumentList] saveDocumentChanges: ERROR response -', errorMsg);
        console.error('[DocumentList] saveDocumentChanges: Full response:', JSON.stringify(docResponse, null, 2));
        
        if (errorMsg.includes('does not exist') || errorMsg.includes('PROPERTY_DOESNT_EXIST')) {
          console.warn('[DocumentList] saveDocumentChanges: Some properties do not exist, continuing...');
        } else if (errorMsg.includes('API key') || errorMsg.includes('secret') || errorMsg.includes('token')) {
          if (!hasConfigError) {
            console.warn('[DocumentList] saveDocumentChanges: Configuration issue detected -', errorMsg);
            console.warn('[DocumentList] saveDocumentChanges: Please check HubSpot app secrets configuration.');
            setHasConfigError(true);
          }
          throw new Error('Configuration error: Please check HubSpot app secrets');
        } else {
          console.error('[DocumentList] saveDocumentChanges: Update failed -', errorMsg);
          throw new Error(docResponse.message || 'Failed to update documents');
        }
      }
      
      if (docResponse?.status === 'success') {
        console.log('[DocumentList] saveDocumentChanges: SUCCESS - Updated', Object.keys(documentProperties).length, 'document properties');
        
        // Clear config error flag on success
        if (hasConfigError) {
          setHasConfigError(false);
        }
      } else if (docResponse?.status !== 'error') {
        console.warn('[DocumentList] saveDocumentChanges: Unexpected response status:', docResponse?.status);
        console.warn('[DocumentList] saveDocumentChanges: Full response:', JSON.stringify(docResponse, null, 2));
        throw new Error(`Unexpected response status: ${docResponse?.status}`);
      }
    
      // Only continue if update was successful
      if (docResponse?.status !== 'success') {
        throw new Error('Document update failed');
      }
    
      const missingDocs = calculateMissingDocuments(docs, recordProperties);
      const statusUpdated = await updateStatusProperties(isCompleted, dossierState, missingDocs);
    
    if (statusUpdated) {
      setInitialCompletionStatus(isCompleted);
      setInitialDossierState(dossierState);
        setInitialDocuments([...docs]);
      setIsChanged(false);
      
        if (!skipRefetch) {
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
          // Wait a bit longer to ensure HubSpot has processed the update
          await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('[DocumentList] saveDocumentChanges: Refetching document values to verify updates...');
      
      // Remember if we were in "autre" tab before refetch
      const wasInAutreTab = selectedTab === 'autre';
      const activeTabIdBeforeRefetch = getActiveTabId();
      
      await fetchDocumentValues();
      
      // After refetch, check if documents in "autre" tab should move to main tab
      // (if they now match conditions after being marked as provided and required)
      if (wasInAutreTab && activeTabIdBeforeRefetch) {
        // Wait a bit for state to update after fetchDocumentValues
        setTimeout(() => {
          const currentDocs = documents;
          const currentProps = recordProperties;
          const activeTabId = getActiveTabId();
          
          if (activeTabId) {
            // Check if any documents now match conditions and should move to main tab
            const docsThatNowMatch = currentDocs.filter(doc => {
              if (!documentBelongsToTab(doc, activeTabId)) return false;
              const conditionsMet = checkDocumentConditions(doc, currentProps);
              // If document is both required and provided, and conditions are met, move to main tab
              return conditionsMet && doc.required && doc.provided;
            });
            
            if (docsThatNowMatch.length > 0) {
              console.log(`[DocumentList] saveDocumentChanges: ${docsThatNowMatch.length} document(s) now match conditions and should be in main tab`);
              console.log(`[DocumentList] saveDocumentChanges: Documents: ${docsThatNowMatch.map(d => d.name).join(', ')}`);
              // Switch to main tab to show these documents
              setSelectedTab(activeTabId);
            }
          }
        }, 100);
      }
      
      console.log('[DocumentList] saveDocumentChanges: Verification complete. Check the fetched values above.');
        }
    } else {
      console.error('[DocumentList] saveDocumentChanges: Failed to update status properties');
      setError('Error updating status properties');
    }
  } catch (err) {
    console.error('[DocumentList] saveDocumentChanges: EXCEPTION -', err?.message || err);
    setError(err?.message || 'Error updating documents');
  } finally {
    setSaving(false);
  }
};

  /**
   * Resets all changes back to initial state from HubSpot.
   */
const resetChanges = () => {
    setDocuments([...initialDocuments]);
  setIsCompleted(initialCompletionStatus);
  setDossierState(initialDossierState);
  setIsChanged(false);
};

  // Auto-update HubSpot properties when document states change
useEffect(() => {
    if (initialDocuments.length > 0 && documents.length > 0 && !loading && Object.keys(recordProperties).length > 0) { 
    checkForChanges();
    
      const timeoutId = setTimeout(() => {
        if (documents.length > 0 && documents.some(doc => doc.name)) {
          const missingDocs = calculateMissingDocuments(documents);
          // Only auto-update missing_doc property (calculated field)
          // Do NOT auto-update documents_completed or etat_du_dossier until user saves
          updateMissingDocProperty(missingDocs).catch(() => {});
        }
      }, 200);
    
      return () => clearTimeout(timeoutId);
  }
}, [documents, isCompleted, dossierState]);

  // Update selected tab when natureDemande changes
  useEffect(() => {
    if (natureDemande) {
      const tabId = getTabForNatureDemande(natureDemande);
      if (tabId && tabId !== selectedTab) {
        setSelectedTab(tabId);
      }
    }
  }, [natureDemande]);

  // DISABLED: Auto-update required status when record properties change
  // This was causing infinite loops. Users will need to manually save.
  // useEffect(() => {
  //   ... disabled to prevent infinite loops
  // }, [recordProperties, selectedTab]);


  const getDossierStateStyle = (state) => {
    switch(state) {
      case DOSSIER_STATES.COMPLETE:
        return "success";
      case DOSSIER_STATES.INCOMPLETE:
        return "warning";
      case DOSSIER_STATES.TO_BUILD:
      default:
        return "error";
    }
  };

  const stepNames = [
    DOSSIER_STATES.TO_BUILD,
    DOSSIER_STATES.INCOMPLETE,
    DOSSIER_STATES.COMPLETE
  ];

  const getCurrentStepIndex = (): number => {
    switch (dossierState) {
      case DOSSIER_STATES.TO_BUILD:
        return 0;
      case DOSSIER_STATES.INCOMPLETE:
        return 1;
      case DOSSIER_STATES.COMPLETE:
        return isCompleted ? stepNames.length : 2;
      default:
        return 0;
    }
  };

  /**
   * Evaluates a single condition against HubSpot record properties.
   * Supports multiple operators including 'in' for multi-select fields.
   */
  const evaluateCondition = (condition: DocumentCondition, properties: Record<string, any>): boolean => {
    let propertyValue = properties[condition.property];
    if (propertyValue === undefined) {
      const foundKey = Object.keys(properties).find(k => 
        k.toLowerCase() === condition.property.toLowerCase()
      );
      if (foundKey) {
        propertyValue = properties[foundKey];
      }
    }
    
    const propValueStr = propertyValue ? String(propertyValue).trim() : '';
    const conditionValue = condition.value.trim();

    switch (condition.operator) {
      case 'equals':
        return propValueStr === conditionValue;
      case 'not_equals':
        return propValueStr !== conditionValue;
      case 'contains':
        return propValueStr.toLowerCase().includes(conditionValue.toLowerCase());
      case 'not_contains':
        return !propValueStr.toLowerCase().includes(conditionValue.toLowerCase());
      case 'in':
        // Handles HubSpot multi-select fields which can be:
        // - Single string: "Value"
        // - Semicolon-separated: "Value1;Value2"
        // - Array: ["Value1", "Value2"]
        if (!propertyValue || propValueStr === '') {
          return false;
        }
        
        const normalizedConditionValue = conditionValue.trim();
        const normalizedPropertyValue = propValueStr.trim();
        
        if (Array.isArray(propertyValue)) {
          return propertyValue.some(val => {
            const normalizedVal = String(val).trim();
            return normalizedVal === normalizedConditionValue;
          });
        }
        
        const normalizeForComparison = (str: string): string => {
          return str.trim().replace(/\s+/g, ' ');
        };
        
        const normalizedCondition = normalizeForComparison(normalizedConditionValue);
        
        if (normalizedPropertyValue.includes(';')) {
          const values = normalizedPropertyValue.split(';').map(v => normalizeForComparison(v)).filter(v => v !== '');
          return values.some(val => val === normalizedCondition);
        }
        
        if (normalizedPropertyValue.includes(',')) {
          const values = normalizedPropertyValue.split(',').map(v => normalizeForComparison(v)).filter(v => v !== '');
          return values.some(val => val === normalizedCondition);
        }
        
        const normalizedProperty = normalizeForComparison(normalizedPropertyValue);
        return normalizedProperty === normalizedCondition;
      default:
        return true;
    }
  };

  /**
   * Checks if all conditions for a document are met.
   * Logic: Conditions on the same property use OR (any match),
   * conditions on different properties use AND (all groups must match).
   *
   * @param doc - The document to check
   * @param properties - The HubSpot record properties
   * @param tabId - Optional: specific tab to check conditions for. If not provided, checks all tabs.
   */
  const checkDocumentConditions = (doc: Document, properties: Record<string, any>, tabId?: string): boolean => {
    // Get conditions based on whether a specific tab is requested
    let conditions: DocumentCondition[];

    if (tabId) {
      // Check conditions for specific tab
      conditions = getConditionsForTab(doc, tabId);
    } else {
      // Check conditions across all tabs (any tab's conditions matching is enough)
      conditions = getAllConditions(doc);
    }

    if (!conditions || conditions.length === 0) {
      return true;
    }

    const conditionsByProperty = new Map<string, DocumentCondition[]>();

    conditions.forEach(condition => {
      if (!conditionsByProperty.has(condition.property)) {
        conditionsByProperty.set(condition.property, []);
      }
      conditionsByProperty.get(condition.property)!.push(condition);
    });

    const allPropertyGroupsMatch = Array.from(conditionsByProperty.entries()).every(([property, propConditions]) => {
      return propConditions.some(condition => {
        return evaluateCondition(condition, properties);
      });
    });

    return allPropertyGroupsMatch;
  };

  /**
   * Determines which tab should be shown based on sous_categorie value.
   * Uses the new tabConfig structure to find matching tabs.
   */
  const getTabForNatureDemande = (natureDemandeValue: string): string | null => {
    if (!natureDemandeValue) {
      return null;
    }

    // Normalize the value for comparison (trim, normalize whitespace)
    const normalize = (str: string): string => {
      return str.trim().replace(/\s+/g, ' ');
    };
    const normalizedValue = normalize(natureDemandeValue);

    // Search through all documents and their tabConfigs to find matching sous_categorie
    for (const doc of DOCUMENTS_CONFIG) {
      if (!doc.tabConfig) continue;

      // Check each tab's conditions
      for (const [tabId, tabConfig] of Object.entries(doc.tabConfig)) {
        if (!tabConfig.conditions) continue;

        // Look for a sous_categorie condition that matches
        const hasMatch = tabConfig.conditions.some(condition => {
          return condition.property === 'sous_categorie' &&
            condition.operator === 'equals' &&
            normalize(condition.value) === normalizedValue;
        });

        if (hasMatch) {
          return tabId;
        }
      }
    }

    return null;
  };

  /**
   * Gets the active tab ID based on current sous_categorie.
   * Returns the tab that should be shown (not "autre").
   */
  const getActiveTabId = (): string | null => {
    if (!natureDemande) {
      return null;
    }
    
    const tabId = getTabForNatureDemande(natureDemande);
    return tabId;
  };

  /**
   * Filters and sorts documents visible in the current tab.
   * First tab is determined by sous_categorie (finds documents matching that value and uses their tab property).
   * "Autre" tab shows documents from the first tab that don't match conditions.
   */
  const getVisibleDocuments = (): Document[] => {
    // Safety check: ensure we have the necessary state
    if (!documents || documents.length === 0) {
      return [];
    }
    
    const activeTabId = getActiveTabId();
    
    // Ensure sous_categorie is in recordProperties for condition checking
    const propsForConditions = recordProperties ? { ...recordProperties } : {};
    if (natureDemande && !propsForConditions['sous_categorie']) {
      propsForConditions['sous_categorie'] = natureDemande;
    }
    
    const visible = documents.filter(doc => {
      const conditionsMet = checkDocumentConditions(doc, propsForConditions, activeTabId || undefined);
      
      // Debug logging for specific document
      if (doc.id.includes('document_justifiant_de_la_date_et_du_lieu_de_naissance') && 
          !doc.id.includes('fraterie')) {
        console.log(`[getVisibleDocuments] Document: "${doc.name}"`);
        console.log(`[getVisibleDocuments] Tab: ${selectedTab}, ActiveTabId: ${activeTabId}`);
        console.log(`[getVisibleDocuments] Belongs to active tab: ${activeTabId ? documentBelongsToTab(doc, activeTabId) : 'N/A'}`);
        console.log(`[getVisibleDocuments] Conditions met: ${conditionsMet}`);
        console.log(`[getVisibleDocuments] Required: ${doc.required}, Provided: ${doc.provided}`);
        console.log(`[getVisibleDocuments] sous_categorie: ${propsForConditions['sous_categorie'] || natureDemande || 'NOT SET'}`);
      }
      
      if (selectedTab === 'autre') {
        // "Autre" tab shows:
        // 1. Documents from active tab that don't match conditions
        // 2. Documents from ANY tab that are required OR provided (may be from different sous_categorie)

        // Case 1: Document is required or provided (from any tab)
        if (doc.required || doc.provided) {
          // Don't show if conditions are met AND document belongs to active tab
          // (it will show in the main tab instead)
          if (conditionsMet && activeTabId && documentBelongsToTab(doc, activeTabId)) {
            return false;
          }
          // Show in Autre if it's marked but doesn't belong to current tab or conditions not met
          return true;
        }

        // Case 2: Document belongs to active tab but conditions not met
        if (!activeTabId) {
          return false;
        }

        if (!documentBelongsToTab(doc, activeTabId)) {
          return false;
        }

        return !conditionsMet;
      }

      // For the active tab: show documents that match their conditions
      // OR documents that are required AND provided (completed documents)
      const tabToCheck = (activeTabId && selectedTab === activeTabId) ? activeTabId : selectedTab;

      if (!documentBelongsToTab(doc, tabToCheck)) {
        return false;
      }

      // Show if conditions are met OR if document is required AND provided
      return conditionsMet || (doc.required && doc.provided);
    });
    
    const filtered = searchTerm.trim() 
      ? visible.filter(doc => 
          doc.name.toLowerCase().includes(searchTerm.toLowerCase())
        )
      : visible;
    
    return filtered.sort((a, b) => {
      const orderA = getOrderForTab(a, selectedTab);
      const orderB = getOrderForTab(b, selectedTab);
      return orderA - orderB;
    });
  };

  /**
   * Calculates progress based on all required documents across all tabs.
   * A document is required if conditions are met OR manually set to required.
   */
  const calculateProgress = (docs: Document[]): { provided: number; required: number; percentage: number } => {
    const requiredDocs = docs.filter(doc => {
      if (doc.required) {
        return true;
      }
      const hasConditions = getAllConditions(doc).length > 0;
      if (hasConditions) {
        const conditionsMet = checkDocumentConditions(doc, recordProperties);
        return conditionsMet;
      }
      return false;
    });
    
    const providedDocs = requiredDocs.filter(doc => doc.provided);
    const requiredCount = requiredDocs.length;
    const providedCount = providedDocs.length;
    const percentage = requiredCount > 0 ? Math.round((providedCount / requiredCount) * 100) : 100;
    
    return {
      provided: providedCount,
      required: requiredCount,
      percentage
    };
  };

  const renderDocumentsTable = () => {
    const visible = getVisibleDocuments() || [];
    const progress = calculateProgress(visible);
    
    if (visible.length === 0) {
      return (
        <EmptyState 
          title={searchTerm.trim() ? "Aucun document trouvé" : "Aucun document dans cet onglet"}
          layout="vertical"
        >
          {searchTerm.trim() && (
            <Text>Essayez de modifier votre recherche ou de vérifier les filtres.</Text>
          )}
        </EmptyState>
      );
    }
    
    return (
      <Flex direction="column" gap="md">
        <Flex direction="row" gap="sm" align="end" justify="between">
          <Flex direction="row" gap="sm" align="end">
            <Input
              name="document-search"
              label="Rechercher un document"
              placeholder="Tapez le nom du document..."
              value={searchTerm}
              onChange={(value) => {
                setSearchTerm(value || '');
              }}
            />
            {searchTerm && (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearchTerm('');
                }}
              >
                Effacer
              </Button>
            )}
          </Flex>
          <Button
            overlay={
              <Modal id="send-email-modal" title="Envoyer un email" width="md">
                <ModalBody>
                  <Flex direction="column" gap="md">
                    <Text format={{ fontWeight: 'bold' }}>
                      Documents manquants à envoyer :
                    </Text>
                    {(() => {
                      const missingDocs = getMissingDocumentsList(documents, recordProperties);
                      if (missingDocs.length === 0) {
                        return (
                          <Alert title="Aucun document manquant" variant="success">
                            Tous les documents requis ont été fournis.
                          </Alert>
                        );
                      }
                      return (
                        <Box>
                          <Flex direction="column" gap="xs">
                            {missingDocs.map((docName, index) => (
                              <React.Fragment key={index}>
                                <Flex direction="row" gap="sm" align="start">
                                  <Text format={{ fontWeight: 'bold' }}>
                                    {index + 1}.
                                  </Text>
                                  <Text>{docName}</Text>
                                </Flex>
                                {index < missingDocs.length - 1 && (
                                  <Divider distance="xs" />
                                )}
                              </React.Fragment>
                            ))}
                          </Flex>
                          <Flex direction="column" gap="sm">
                            <Divider />
                            <Text format={{ fontWeight: 'bold' }}>
                              Total : {missingDocs.length} document{missingDocs.length > 1 ? 's' : ''} manquant{missingDocs.length > 1 ? 's' : ''}
                            </Text>
                          </Flex>
                        </Box>
                      );
                    })()}
                  </Flex>
                </ModalBody>
                <ModalFooter>
                  <Flex justify="end" gap="sm">
                    <Button
                      variant="secondary"
                      onClick={() => actions.closeOverlay('send-email-modal')}
                    >
                      Annuler
                    </Button>
                    <Button
                      variant="primary"
                      onClick={async () => {
                        const success = await updateSendMailProperty();
                        if (success) {
                          actions.closeOverlay('send-email-modal');
                          setShowEmailSuccess(true);
                          setTimeout(() => setShowEmailSuccess(false), 3000);
                        }
                      }}
                    >
                      Envoyer
                    </Button>
                  </Flex>
                </ModalFooter>
              </Modal>
            }
            variant="secondary"
          >
            Envoyer un email
          </Button>
        </Flex>
        
        {progress.required > 0 && (
          <ProgressBar
            title="Progression des documents"
            value={progress.provided}
            maxValue={progress.required}
            showPercentage={true}
            valueDescription={`${progress.provided} sur ${progress.required} documents fournis`}
            variant={progress.percentage === 100 ? 'success' : progress.percentage >= 50 ? 'warning' : 'danger'}
          />
        )}
        
        {isChanged && (
          <Flex justify="center" gap="sm" align="center">
            <Button onClick={resetChanges} variant="destructive">
              Annuler
            </Button>
            <Button onClick={() => saveDocumentChanges()} variant="primary" disabled={saving}>
              {saving ? 'Enregistrement...' : 'Enregistrer les modifications'}
            </Button>
          </Flex>
        )}
        
        <Flex direction="row" gap="lg" align="center">
          <Flex>
            <Text format={{ fontWeight: 'bold' }}>Nom du document</Text>
          </Flex>
          <Flex justify="center">
            <Text format={{ fontWeight: 'bold' }}>Requis</Text>
          </Flex>
          <Flex justify="center">
            <Text format={{ fontWeight: 'bold' }}>Fournis</Text>
          </Flex>
        </Flex>
        <Divider />
    
        {(visible || [])
          .sort((a, b) => {
            if (!a || !b) return 0;
            if (a.required && !b.required) return -1;
            if (!a.required && b.required) return 1;
            
            const orderA = getOrderForTab(a, selectedTab);
            const orderB = getOrderForTab(b, selectedTab);
            if (orderA !== orderB) {
              return orderA - orderB;
            }
            
            return a.name.localeCompare(b.name);
          })
          .filter((doc) => doc != null && doc.id) // Filter out any null/undefined docs
          .map((doc) => {
          if (!doc || !doc.id) return null; // Safety check
          
          try {
            const conditionsMet = checkDocumentConditions(doc, recordProperties);
            const hasConditions = getAllConditions(doc).length > 0;

            let requiredValue;
            let isRequiredByCondition = false;

            if (hasConditions) {
              if (conditionsMet) {
                requiredValue = true;
                isRequiredByCondition = true;
              } else {
                requiredValue = doc.required;
                isRequiredByCondition = false;
              }
            } else {
              requiredValue = doc.required;
              isRequiredByCondition = false;
            }
            
            return (
            <React.Fragment key={doc.id}>
            <Flex
              direction="row"
              align="center"
                gap="lg"
            >
              <Flex>
                <Text>{doc.name || 'Unnamed Document'}</Text>
              </Flex>
              <Flex justify="center">
                <Checkbox
                  key={`req-${doc.id}-${requiredValue}`}
                  checked={requiredValue === true}
                  readOnly={isRequiredByCondition}
                  onChange={isRequiredByCondition ? () => {} : handleCheckboxToggle(doc.id, 'required')}
                />
              </Flex>
              <Flex justify="center">
                <Checkbox
                  key={`prov-${doc.id}-${doc.provided}`}
                  checked={doc.provided === true}
                  onChange={handleCheckboxToggle(doc.id, 'provided')}
                />
              </Flex>
            </Flex>
              <Divider />
            </React.Fragment>
          );
          } catch (err) {
            console.error(`[renderDocumentsTable] Error rendering document ${doc?.id}:`, err);
            return null;
          }
        })
        .filter((item) => item != null)} {/* Filter out any null returns */}
      </Flex>
    );
  };

  if (loading) {
    return (
      <Flex justify="center">
        <LoadingSpinner label="Loading document checklist..." />
      </Flex>
    );
  }

  return (
    <Box>
      <Flex direction="column" gap="md">
        <Flex direction="row" gap="sm" align="center">
            <Tag variant={getDossierStateStyle(dossierState)}>{dossierState}</Tag>
            {isCompleted ?
             <Tag variant="success">✓ Completed</Tag> : <Tag variant="error">× Incomplete</Tag>}
        </Flex>
    
        {error && (
          <Alert
            title="Error"
            variant="error"
          >
            {error}
          </Alert>
        )}
    
        {showSuccess && (
         <Alert
           title="Succès"
           variant="success"
         >
           Documents mis à jour avec succès
         </Alert>
        )}
        
        {showEmailSuccess && (
         <Alert
           title="Succès"
           variant="success"
         >
           Email envoyé avec succès
         </Alert>
        )}
        
        <StepIndicator
          currentStep={getCurrentStepIndex()}
          stepNames={stepNames}
          direction="horizontal"
          circleSize="md"
        />
        
        <Divider />
        
        <Box>
        <Tabs
          variant="enclosed"
          selected={selectedTab}
            onSelectedChange={(id) => {
              setSelectedTab(id as string);
              setSearchTerm(''); // Clear search when switching tabs
            }}
          fill={false}
        >
          {(() => {
            // Only show the active tab (based on sous_categorie) + "autre" tab
            const activeTabId = getActiveTabId();
            
            // Filter tabs: only show active tab + "autre"
            // If no active tab found but natureDemande is set, try to find it from recordProperties
            let finalActiveTabId = activeTabId;
            if (!finalActiveTabId && natureDemande) {
              finalActiveTabId = getTabForNatureDemande(natureDemande);
            }
            // If still no active tab and we have recordProperties, try to get sous_categorie from there
            if (!finalActiveTabId && recordProperties['sous_categorie']) {
              finalActiveTabId = getTabForNatureDemande(recordProperties['sous_categorie']);
            }
            
            let tabsToShow;
            if (finalActiveTabId) {
              tabsToShow = TABS_CONFIG.filter(tab => 
                tab.id === 'autre' || tab.id === finalActiveTabId
              );
            } else {
              // Fallback: show all tabs if we can't determine the active tab
              tabsToShow = TABS_CONFIG;
            }
            
            return tabsToShow.map(tab => (
              <Tab key={tab.id} tabId={tab.id} title={tab.title}>
                <Box>
                  {renderDocumentsTable()}
                </Box>
              </Tab>
            ));
          })()}
        </Tabs>
        </Box>
      </Flex>
    </Box>
  );
};

export default Extension;
