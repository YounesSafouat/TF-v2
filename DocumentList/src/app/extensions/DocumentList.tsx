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
 * Document configuration loaded from JSON.
 * Defines the structure and requirements for each document type.
 */
interface DocumentConfig {
  id: string;
  name: string;
  requiredProperty: string;
  providedProperty: string;
  tab: string | string[];
  order?: number | number[];
  conditions: DocumentCondition[];
}

/**
 * Document state at runtime.
 * Includes current required/provided status and condition evaluation.
 */
interface Document {
  id: string;
  name: string;
  required: boolean;
  provided: boolean;
  requiredProperty: string;
  providedProperty: string;
  tab: string | string[];
  order?: number | number[];
  conditions: DocumentCondition[];
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
  tab: config.tab,
  order: config.order,
  conditions: config.conditions
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
 * Helper function to get the tab value (handles both string and array)
 */
const getTabValue = (tab: string | string[]): string => {
  return Array.isArray(tab) ? tab[0] : tab;
};

/**
 * Helper function to check if a document belongs to a specific tab
 */
const documentBelongsToTab = (doc: Document, tabId: string): boolean => {
  if (Array.isArray(doc.tab)) {
    return doc.tab.includes(tabId);
  }
  return doc.tab === tabId;
};

/**
 * Helper function to get the order for a document in a specific tab
 */
const getOrderForTab = (doc: Document, tabId: string): number => {
  if (Array.isArray(doc.order)) {
    const tabArray = Array.isArray(doc.tab) ? doc.tab : [doc.tab];
    const tabIndex = tabArray.indexOf(tabId);
    if (tabIndex >= 0 && tabIndex < doc.order.length) {
      return doc.order[tabIndex];
    }
    // If tab not found in array, return first order or 9999
    return doc.order[0] ?? 9999;
  }
  return doc.order ?? 9999;
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
        
        // A document is required if manually marked as required OR if conditions are met
        const isRequired = doc.required || (doc.conditions && doc.conditions.length > 0 ? conditionsMet : false);
        
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
        
        // A document is required if manually marked as required OR if conditions are met
        const isRequired = doc.required || (doc.conditions && doc.conditions.length > 0 ? conditionsMet : false);
        
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
    
    try {
      await hubspot.serverless('updateCompletionStatus', {
        parameters: {
          missingDoc: missingDocs,
          hs_object_id: objectId.toString()
        } as any
      });
      
      return true;
    } catch (err) {
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
      return false;
    }
    
    try {
      await hubspot.serverless('updateCompletionStatus', {
        parameters: {
          completionStatus: completionStatus,
          dossierState: dossierState,
          missingDoc: missingDocs,
          hs_object_id: objectId.toString()
        }
      });
      
      return true;
    } catch (err) {
      setError(err?.message || 'Error updating status properties');
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
  
  if (!objectId) {
    setError('Object ID not found in context');
    setLoading(false);
    return;
  }
  
  try {
    const response = await hubspot.serverless('getDocumentValues', {
      propertiesToSend: ['hs_object_id'],
      parameters: {
        propertyNames: propertyNames,
        includeCompletion: true,
        hs_object_id: objectId.toString()
      }
    });
    
    const properties = response || {};
    console.log('[DocumentList] fetchDocumentValues: received properties keys:', Object.keys(properties));
    console.log('[DocumentList] fetchDocumentValues: sous_categorie direct access:', properties['sous_categorie']);
    console.log('[DocumentList] fetchDocumentValues: all sous_categorie variations:', 
      Object.keys(properties).filter(k => k.toLowerCase().includes('sous')));
    
    const getPropValue = (obj: any, needle: string) => {
      if (!obj) return undefined;
      const lower = needle.toLowerCase();
      const hitKey = Object.keys(obj).find(k => k.toLowerCase() === lower || k.toLowerCase().includes(lower));
      const value = hitKey ? obj[hitKey] : undefined;
      console.log('[DocumentList] getPropValue: searching for', needle, 'found key:', hitKey, 'value:', value);
      return value;
    };

    const completionStatus = toBool(properties[COMPLETION_PROPERTY]);
    setIsCompleted(completionStatus);
    setInitialCompletionStatus(completionStatus);
    
    const currentDossierState = properties[DOSSIER_STATE_PROPERTY] || DOSSIER_STATES.TO_BUILD;
    setDossierState(currentDossierState);
    setInitialDossierState(currentDossierState);

    // Try multiple ways to get sous_categorie
    let nd = properties['sous_categorie'];
    console.log('[DocumentList] fetchDocumentValues: direct property access:', nd, 'type:', typeof nd);
    
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
        console.log('[DocumentList] fetchDocumentValues: found sous_categorie via variation:', sousKeys[0], 'value:', nd);
      }
    }
    
    // Log all property values that might be related
    console.log('[DocumentList] fetchDocumentValues: All property values (first 20):', 
      Object.entries(properties).slice(0, 20).map(([k, v]) => `${k}: ${v}`));
    
    nd = (nd || '').toString().trim();
    console.log('[DocumentList] fetchDocumentValues: sous_categorie final value:', nd, 'length:', nd.length);
    
    // TEMPORARY: If empty, check if we should use a test value
    // Remove this after debugging
    if (!nd && process.env.NODE_ENV === 'development') {
      console.warn('[DocumentList] sous_categorie is empty - property may not be set in HubSpot');
    }
    
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
        const requiredFromHubSpot = toBool(requiredRaw);
      const provided = toBool(providedRaw);
      const conditionsMet = checkDocumentConditions(doc, properties);
      
        let required: boolean;
        if (doc.conditions && doc.conditions.length > 0) {
          if (conditionsMet) {
        required = true;
          } else {
            required = requiredFromHubSpot;
          }
        } else {
          required = requiredFromHubSpot;
      }
      
      return {
        ...doc,
        required,
          provided,
          _requiredFromHubSpot: requiredFromHubSpot,
          _shouldBeRequired: doc.conditions && doc.conditions.length > 0 
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
    
      let needsSave = false;
      const docsNeedingUpdate = updatedDocuments.filter(doc => {
        if (doc.conditions && doc.conditions.length > 0) {
          const conditionsMet = checkDocumentConditions(doc, properties);
          if (!conditionsMet) {
            return false;
          }
          const requiredFromHubSpot = (doc as any)._requiredFromHubSpot ?? false;
          const shouldBeRequired = (doc as any)._shouldBeRequired ?? false;
          if (requiredFromHubSpot !== shouldBeRequired) {
            needsSave = true;
            return true;
          }
        }
        return false;
      });
    
      if (needsSave && docsNeedingUpdate.length > 0) {
        const correctedDocs = updatedDocuments;
        setDocuments(correctedDocs);
        setInitialDocuments([...correctedDocs]);
      
        (async () => {
          try {
            await saveDocumentChanges(correctedDocs, true);
          } catch (err) {
            // Silent fail for auto-save
          }
        })();
      
        updatedDocuments = correctedDocs;
      }
    
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
              const isAutreTab = selectedTab === 'autre';
              
              if (doc.conditions && doc.conditions.length > 0 && !isAutreTab) {
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
    
      docs.forEach((doc) => {
      const requiredProp = doc.requiredProperty;
      const providedProp = doc.providedProperty;
        const isRequired = doc.required;
      documentProperties[requiredProp] = isRequired;
        documentProperties[providedProp] = doc.provided;
      });
  
    const objectId = context.crm?.objectId;
    
    if (!objectId) {
      setError('Object ID not found in context');
      setSaving(false);
      return;
    }
    
    const docResponse = await hubspot.serverless('updateDocuments', {
      parameters: {
        documents: documentProperties,
          hs_object_id: objectId.toString()
        }
      });
    
      if (docResponse?.status === 'error') {
        const errorMsg = docResponse.message || '';
        if (errorMsg.includes('does not exist') || errorMsg.includes('PROPERTY_DOESNT_EXIST')) {
          // Continue - some properties may not exist
        } else {
          throw new Error(docResponse.message || 'Failed to update documents');
        }
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
          await new Promise(resolve => setTimeout(resolve, 3000));
      await fetchDocumentValues();
        }
    } else {
      setError('Error updating status properties');
    }
  } catch (err) {
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

  // Auto-update required status when record properties change (conditions may have changed)
  useEffect(() => {
    if (Object.keys(recordProperties).length > 0 && initialDocuments.length > 0) {
      setDocuments(prevDocs => {
        let hasChanges = false;
        const updatedDocs = prevDocs.map(doc => {
          if (doc.conditions && doc.conditions.length > 0) {
            const conditionsMet = checkDocumentConditions(doc, recordProperties);
            if (conditionsMet) {
              if (!doc.required) {
                hasChanges = true;
                return { ...doc, required: true };
              }
            } else {
              // Don't auto-update to false - preserve manual control in "autre" tab
              return doc;
            }
          }
          return doc;
        });
      
        if (hasChanges) {
          const newCompletionStatus = checkCompletion(updatedDocs);
          const newDossierState = calculateDossierState(updatedDocs);
          setIsCompleted(newCompletionStatus);
          setDossierState(newDossierState);
        
          setTimeout(async () => {
            try {
              await saveDocumentChanges(updatedDocs, true);
            } catch (err) {
              // Silent fail
            }
          }, 500);
        
          setIsChanged(true);
          return updatedDocs;
        }
      
        return updatedDocs;
      });
    }
  }, [recordProperties, selectedTab]);


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
    
    // Debug logging for condition evaluation
    if (condition.property === 'domicile__') {
      console.log('[DocumentList] evaluateCondition - domicile__:', {
        property: condition.property,
        operator: condition.operator,
        conditionValue,
        propValueStr,
        matches: propValueStr === conditionValue
      });
    }

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
   */
  const checkDocumentConditions = (doc: Document, properties: Record<string, any>): boolean => {
    if (!doc.conditions || doc.conditions.length === 0) {
      return true;
    }

    const conditionsByProperty = new Map<string, DocumentCondition[]>();
    
    doc.conditions.forEach(condition => {
      if (!conditionsByProperty.has(condition.property)) {
        conditionsByProperty.set(condition.property, []);
      }
      conditionsByProperty.get(condition.property)!.push(condition);
    });
    
    // Debug: log condition evaluation for documents with domicile__ or multiple conditions
    const hasMultipleProperties = conditionsByProperty.size > 1;
    const hasDomicileCondition = conditionsByProperty.has('domicile__');
    
    if (hasMultipleProperties || hasDomicileCondition) {
      console.log('[DocumentList] checkDocumentConditions - Document:', doc.name);
      console.log('[DocumentList] checkDocumentConditions - Conditions by property:', 
        Array.from(conditionsByProperty.entries()).map(([prop, conds]) => ({
          property: prop,
          conditions: conds.map(c => `${c.operator} ${c.value}`),
          propertyValue: properties[prop]
        }))
      );
    }
    
    const allPropertyGroupsMatch = Array.from(conditionsByProperty.entries()).every(([property, conditions]) => {
      const anyMatches = conditions.some(condition => {
        return evaluateCondition(condition, properties);
      });
      
      // Debug for domicile__ conditions
      if (property === 'domicile__' && hasMultipleProperties) {
        console.log('[DocumentList] checkDocumentConditions - domicile__ group:', {
          property,
          propertyValue: properties[property],
          conditions: conditions.map(c => c.value),
          anyMatches
        });
      }
      
      return anyMatches;
    });

    if (hasMultipleProperties || hasDomicileCondition) {
      console.log('[DocumentList] checkDocumentConditions - Result for', doc.name, ':', allPropertyGroupsMatch);
    }

    return allPropertyGroupsMatch;
  };

  /**
   * Determines which tab should be shown based on sous_categorie value.
   * Finds documents matching the sous_categorie and returns their tab property.
   */
  const getTabForNatureDemande = (natureDemandeValue: string): string | null => {
    if (!natureDemandeValue) {
      console.log('[DocumentList] getTabForNatureDemande: no value provided');
      return null;
    }
    
    // Normalize the value for comparison (trim, normalize whitespace, handle case)
    const normalize = (str: string): string => {
      return str.trim().replace(/\s+/g, ' ');
    };
    const normalizedValue = normalize(natureDemandeValue);
    console.log('[DocumentList] getTabForNatureDemande: searching for tab with value:', normalizedValue);
    
    // Find documents that have a condition matching this sous_categorie
    // If a document has multiple tabs, find which tab corresponds to this condition
    const matchingDocs = DOCUMENTS_CONFIG.filter(doc => {
      if (!doc.conditions || doc.conditions.length === 0) {
        return false;
      }
      
      return doc.conditions.some(condition => {
        return condition.property === 'sous_categorie' && 
        condition.operator === 'equals' && 
        normalize(condition.value) === normalizedValue;
      });
    });
    
    if (matchingDocs.length > 0) {
      // Find a document that has this condition and belongs to a specific tab
      // Prefer documents that only have this condition (not multiple conditions)
      const docWithSingleCondition = matchingDocs.find(doc => {
        const sousConditions = doc.conditions.filter(c => 
          c.property === 'sous_categorie' && c.operator === 'equals'
        );
        return sousConditions.length === 1;
      });
      
      const docToUse = docWithSingleCondition || matchingDocs[0];
      console.log('[DocumentList] Found matching document:', docToUse.name, 'with tab:', docToUse.tab);
      
      // If document has multiple tabs, try to find which tab corresponds to this condition
      if (Array.isArray(docToUse.tab) && docToUse.tab.length > 1) {
        // Check if there's a document that ONLY has this condition and belongs to naturalisation_mariage tab
        const naturalisationDoc = matchingDocs.find(doc => {
          const tabs = Array.isArray(doc.tab) ? doc.tab : [doc.tab];
          return tabs.includes('naturalisation_mariage') && 
                 !tabs.includes('decret');
        });
        
        if (naturalisationDoc && normalizedValue.toLowerCase().includes('naturalisation')) {
          console.log('[DocumentList] getTabForNatureDemande: using naturalisation_mariage tab for naturalisation condition');
          return 'naturalisation_mariage';
        }
        
        // For "Tronc commun décret", prefer decret tab
        if (normalizedValue.toLowerCase().includes('décret') || normalizedValue.toLowerCase().includes('decret')) {
          console.log('[DocumentList] getTabForNatureDemande: using decret tab for décret condition');
          return 'decret';
        }
        
        // Default to first tab if we can't determine
        const tab = getTabValue(docToUse.tab);
        console.log('[DocumentList] getTabForNatureDemande: returning first tab:', tab);
        return tab;
      }
      
      const tab = getTabValue(docToUse.tab);
      console.log('[DocumentList] getTabForNatureDemande: returning tab:', tab);
      return tab;
    }
    
    console.log('[DocumentList] getTabForNatureDemande: no matching document found');
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
    const activeTabId = getActiveTabId();
    console.log('[DocumentList] getVisibleDocuments: activeTabId:', activeTabId, 'selectedTab:', selectedTab, 'natureDemande:', natureDemande);
    
    // Ensure sous_categorie is in recordProperties for condition checking
    const propsForConditions = { ...recordProperties };
    if (natureDemande && !propsForConditions['sous_categorie']) {
      propsForConditions['sous_categorie'] = natureDemande;
    }
    
    // Debug: log properties being used for condition checking
    console.log('[DocumentList] getVisibleDocuments: recordProperties keys:', Object.keys(recordProperties));
    console.log('[DocumentList] getVisibleDocuments: propsForConditions domicile__:', propsForConditions['domicile__']);
    console.log('[DocumentList] getVisibleDocuments: propsForConditions sous_categorie:', propsForConditions['sous_categorie']);
    
    console.log('[DocumentList] getVisibleDocuments: total documents:', documents.length);
    const visible = documents.filter(doc => {
      const conditionsMet = checkDocumentConditions(doc, propsForConditions);
      
      if (selectedTab === 'autre') {
        // "Autre" tab: show documents from the active tab that don't match their conditions
        // User can manage these documents (set as required or remove them) regardless of required status
        if (!activeTabId) {
          return false;
        }
        
        // Document must belong to the active tab
        if (!documentBelongsToTab(doc, activeTabId)) {
          return false;
        }
        
        // Show if conditions are not met (regardless of required status, so user can manage them)
        const shouldShow = !conditionsMet;
        if (shouldShow) {
          console.log('[DocumentList] Document in autre tab:', doc.name, 'conditionsMet:', conditionsMet, 'required:', doc.required);
        }
        return shouldShow;
      }
      
      // For the active tab: show ONLY documents that match their conditions
      // Documents that don't match go to "autre" tab, regardless of required status
      // Use activeTabId if selectedTab matches it, otherwise use selectedTab
      const tabToCheck = (activeTabId && selectedTab === activeTabId) ? activeTabId : selectedTab;
      
      if (!documentBelongsToTab(doc, tabToCheck)) {
        return false;
      }
      
      // Show ONLY if conditions are met (not if manually required but conditions don't match)
      const shouldShow = conditionsMet;
      if (shouldShow) {
        console.log('[DocumentList] Document visible:', doc.name, 'tab:', doc.tab, 'tabToCheck:', tabToCheck, 'conditionsMet:', conditionsMet, 'required:', doc.required);
      } else if (documentBelongsToTab(doc, tabToCheck)) {
        // Debug: log documents that belong to tab but aren't shown (they should be in "autre")
        console.log('[DocumentList] Document NOT visible (conditions not met, should be in autre):', doc.name, 'conditions:', doc.conditions);
      }
      return shouldShow;
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
      if (doc.conditions && doc.conditions.length > 0) {
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
    const visible = getVisibleDocuments();
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
    
        {visible
          .sort((a, b) => {
            if (a.required && !b.required) return -1;
            if (!a.required && b.required) return 1;
            
            const orderA = getOrderForTab(a, selectedTab);
            const orderB = getOrderForTab(b, selectedTab);
            if (orderA !== orderB) {
              return orderA - orderB;
            }
            
            return a.name.localeCompare(b.name);
          })
          .map((doc) => {
          const conditionsMet = checkDocumentConditions(doc, recordProperties);
          
          let requiredValue;
          let isRequiredByCondition = false;
          
          if (doc.conditions && doc.conditions.length > 0) {
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
              <Text>{doc.name}</Text>
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
        })}
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
