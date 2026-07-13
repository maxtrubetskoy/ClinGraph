import React, { useState, useEffect } from 'react';
import { ClinicalCategory, Entity, ClinicalSymptom, ClinicalCondition, ClinicalMedication, ClinicalFollowUp, Relation, ClinicalMeasurement } from '../types';
import { Plus, Trash2, Edit2, Check, X, ShieldAlert, Pill, Activity, CalendarCheck, Link2, Beaker, Search, Settings } from 'lucide-react';

interface ClinicalNotesViewProps {
  clinicalNotes?: ClinicalCategory;
  entities: Entity[];
  relations: Relation[];
  onUpdateNotes: (updatedNotes: ClinicalCategory, updatedEntities: Entity[], updatedRelations?: Relation[]) => void;
  selectedEntityId?: string | null;
  onSelectEntity: (id: string | null) => void;
  isReadOnly?: boolean;
}

export default function ClinicalNotesView({
  clinicalNotes = { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] },
  entities,
  relations = [],
  onUpdateNotes,
  selectedEntityId,
  onSelectEntity,
  isReadOnly = false
}: ClinicalNotesViewProps) {
  const [editingIndex, setEditingIndex] = useState<{ category: 'symptoms' | 'conditions' | 'medications' | 'followUps' | 'measurements'; index: number } | null>(null);

  // New Relation States
  const [newRelSource, setNewRelSource] = useState<string>('');
  const [newRelType, setNewRelType] = useState<string>('TREATS');
  const [newRelTarget, setNewRelTarget] = useState<string>('');

  useEffect(() => {
    if (selectedEntityId) {
      setNewRelSource(selectedEntityId);
    }
  }, [selectedEntityId]);

  // Auto-synchronize any 'Condition' type entities from the knowledge graph into the structured clinical notes
  useEffect(() => {
    if (isReadOnly) return;
    const currentConditions = clinicalNotes.conditions || [];
    const missingConditions: ClinicalCondition[] = [];

    entities.forEach(ent => {
      if (ent.type === 'Condition') {
        const alreadyExists = currentConditions.some(c => c.entityId === ent.id);
        if (!alreadyExists) {
          missingConditions.push({
            entityId: ent.id,
            name: ent.name,
            status: 'Active',
            details: ent.description || ''
          });
        }
      }
    });

    if (missingConditions.length > 0) {
      const updatedNotes = {
        ...clinicalNotes,
        conditions: [...currentConditions, ...missingConditions]
      };
      onUpdateNotes(updatedNotes, entities);
    }
  }, [entities, clinicalNotes.conditions, onUpdateNotes, isReadOnly]);

  const handleAddRelation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRelSource || !newRelType || !newRelTarget) return;
    if (newRelSource === newRelTarget) {
      alert("Source and Target cannot be the same entity.");
      return;
    }

    const newRelation: Relation = {
      id: `r_user_${Date.now()}`,
      source: newRelSource,
      target: newRelTarget,
      type: newRelType.toUpperCase()
    };

    const updatedRelations = [...relations, newRelation];
    onUpdateNotes(clinicalNotes, entities, updatedRelations);

    // Reset target but keep source
    setNewRelTarget('');
  };

  const handleDeleteRelation = (relId: string) => {
    const updatedRelations = relations.filter(r => r.id !== relId);
    onUpdateNotes(clinicalNotes, entities, updatedRelations);
  };

  // Local Form States
  const [symForm, setSymForm] = useState<Partial<ClinicalSymptom>>({});
  const [condForm, setCondForm] = useState<Partial<ClinicalCondition>>({});
  const [medForm, setMedForm] = useState<Partial<ClinicalMedication>>({});
  const [folForm, setFolForm] = useState<Partial<ClinicalFollowUp>>({});
  const [measForm, setMeasForm] = useState<Partial<ClinicalMeasurement>>({});

  const itemRefs = React.useRef<{ [key: string]: HTMLDivElement | null }>({});

  // UMLS Mapping States
  const [mappingStates, setMappingStates] = useState<{ [key: string]: 'loading' | 'success' | 'error' }>({});
  const [isMappingAll, setIsMappingAll] = useState(false);
  const [mapAllProgress, setMapAllProgress] = useState({ current: 0, total: 0 });

  // Manual UMLS Edit & Search States
  const [activeUmlsEditEntityId, setActiveUmlsEditEntityId] = useState<string | null>(null);
  const [umlsSearchQuery, setUmlsSearchQuery] = useState('');
  const [umlsSearchResults, setUmlsSearchResults] = useState<{ cui: string; name: string }[]>([]);
  const [isUmlsSearching, setIsUmlsSearching] = useState(false);
  const [customUmlsMapping, setCustomUmlsMapping] = useState({
    cui: '',
    preferredName: '',
    rxnorm: '',
    snomed: '',
    icd10: '',
    loinc: ''
  });
  const [fetchCodesLoading, setFetchCodesLoading] = useState(false);
  const [umlsEditError, setUmlsEditError] = useState('');

  const handleOpenUmlsEdit = (entityId: string) => {
    const entity = entities.find(e => e.id === entityId);
    if (!entity) return;

    setActiveUmlsEditEntityId(entityId);
    setUmlsSearchQuery(entity.name);
    setUmlsSearchResults([]);
    setUmlsEditError('');
    setCustomUmlsMapping({
      cui: entity.umlsMapping?.cui || '',
      preferredName: entity.umlsMapping?.preferredName || entity.name,
      rxnorm: entity.umlsMapping?.rxnorm || '',
      snomed: entity.umlsMapping?.snomed || '',
      icd10: entity.umlsMapping?.icd10 || '',
      loinc: entity.umlsMapping?.loinc || ''
    });
  };

  const handleUmlsSearch = async () => {
    if (!umlsSearchQuery.trim()) return;
    setIsUmlsSearching(true);
    setUmlsEditError('');
    setUmlsSearchResults([]);

    try {
      const response = await fetch('/api/umls/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: umlsSearchQuery })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned status ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setUmlsSearchResults(data.results);
        if (data.results.length === 0) {
          setUmlsEditError('No matching concepts found in UMLS for your query.');
        }
      } else {
        throw new Error(data.error || 'Failed to fetch search results');
      }
    } catch (err: any) {
      console.error('UMLS Search Error:', err);
      setUmlsEditError(err.message || 'Error searching UMLS database.');
    } finally {
      setIsUmlsSearching(false);
    }
  };

  const handleSelectSearchResult = async (result: { cui: string; name: string }) => {
    setFetchCodesLoading(true);
    setUmlsEditError('');
    
    // Set CUI and Preferred Name immediately
    setCustomUmlsMapping(prev => ({
      ...prev,
      cui: result.cui,
      preferredName: result.name,
      rxnorm: '',
      snomed: '',
      icd10: '',
      loinc: ''
    }));

    try {
      const response = await fetch('/api/umls/concept-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cui: result.cui })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch vocabulary codes (Status ${response.status})`);
      }

      const resJson = await response.json();
      if (resJson.success && resJson.data) {
        setCustomUmlsMapping(prev => ({
          ...prev,
          rxnorm: resJson.data.rxnorm || '',
          snomed: resJson.data.snomed || '',
          icd10: resJson.data.icd10 || '',
          loinc: resJson.data.loinc || ''
        }));
      }
    } catch (err: any) {
      console.error('Error fetching concept codes:', err);
      setUmlsEditError('Concept selected, but failed to retrieve some specific vocabulary codes.');
    } finally {
      setFetchCodesLoading(false);
    }
  };

  const handleSaveCustomUmlsMapping = () => {
    if (!activeUmlsEditEntityId) return;

    // Save mapping to entities
    const updatedEntities = entities.map(ent => {
      if (ent.id === activeUmlsEditEntityId) {
        return {
          ...ent,
          umlsMapping: {
            cui: customUmlsMapping.cui,
            preferredName: customUmlsMapping.preferredName || ent.name,
            rxnorm: customUmlsMapping.rxnorm || undefined,
            snomed: customUmlsMapping.snomed || undefined,
            icd10: customUmlsMapping.icd10 || undefined,
            loinc: customUmlsMapping.loinc || undefined
          }
        };
      }
      return ent;
    });

    onUpdateNotes(clinicalNotes, updatedEntities, relations);
    
    // Update mappingState to 'success'
    setMappingStates(prev => ({ ...prev, [activeUmlsEditEntityId]: 'success' }));
    setActiveUmlsEditEntityId(null);
  };

  const handleRemoveUmlsMapping = () => {
    if (!activeUmlsEditEntityId) return;

    const updatedEntities = entities.map(ent => {
      if (ent.id === activeUmlsEditEntityId) {
        const { umlsMapping, ...rest } = ent;
        return rest;
      }
      return ent;
    });

    onUpdateNotes(clinicalNotes, updatedEntities, relations);
    
    // Clear mapping state
    setMappingStates(prev => {
      const copy = { ...prev };
      delete copy[activeUmlsEditEntityId];
      return copy;
    });
    setActiveUmlsEditEntityId(null);
  };

  const handleMapEntity = async (entityId: string, name: string, type: string) => {
    setMappingStates(prev => ({ ...prev, [entityId]: 'loading' }));

    try {
      const response = await fetch('/api/umls/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server error ${response.status}`);
      }

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'UMLS mapping failed');
      }

      const umlsMapping = result.data ? {
        cui: result.data.cui,
        preferredName: result.data.preferredName,
        rxnorm: result.data.rxnorm,
        snomed: result.data.snomed,
        icd10: result.data.icd10
      } : {
        cui: "",
        preferredName: name,
        error: "No matching concept found in UMLS"
      };

      // Update the entities list
      const updatedEntities = entities.map(ent => {
        if (ent.id === entityId) {
          return { ...ent, umlsMapping };
        }
        return ent;
      });

      onUpdateNotes(clinicalNotes, updatedEntities, relations);
      setMappingStates(prev => ({ ...prev, [entityId]: 'success' }));
    } catch (err: any) {
      console.error(`Error mapping ${name}:`, err);
      setMappingStates(prev => ({ ...prev, [entityId]: 'error' }));
      
      // Save error status on entity
      const updatedEntities = entities.map(ent => {
        if (ent.id === entityId) {
          return {
            ...ent,
            umlsMapping: {
              cui: "",
              preferredName: name,
              error: err.message || "Failed to map to UMLS"
            }
          };
        }
        return ent;
      });
      onUpdateNotes(clinicalNotes, updatedEntities, relations);
    }
  };

  const handleMapAllEntities = async () => {
    // Map Symptoms, Conditions, Medications, and Measurements
    const mappableTypes = ['Symptom', 'Condition', 'Medication', 'Measurement'];
    const targets = entities.filter(ent => mappableTypes.includes(ent.type) && !ent.umlsMapping?.cui);

    if (targets.length === 0) {
      alert("All clinical entities are already mapped or no mappable entities were found!");
      return;
    }

    setIsMappingAll(true);
    setMapAllProgress({ current: 0, total: targets.length });

    let currentEntities = [...entities];

    for (let i = 0; i < targets.length; i++) {
      const ent = targets[i];
      setMapAllProgress({ current: i + 1, total: targets.length });
      setMappingStates(prev => ({ ...prev, [ent.id]: 'loading' }));

      try {
        const response = await fetch('/api/umls/map', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ent.name, type: ent.type })
        });

        if (response.ok) {
          const result = await response.json();
          if (result.success && result.data) {
            const umlsMapping = {
              cui: result.data.cui,
              preferredName: result.data.preferredName,
              rxnorm: result.data.rxnorm,
              snomed: result.data.snomed,
              icd10: result.data.icd10
            };
            currentEntities = currentEntities.map(e => e.id === ent.id ? { ...e, umlsMapping } : e);
            setMappingStates(prev => ({ ...prev, [ent.id]: 'success' }));
          } else {
            const umlsMapping = {
              cui: "",
              preferredName: ent.name,
              error: "No matching concept found in UMLS"
            };
            currentEntities = currentEntities.map(e => e.id === ent.id ? { ...e, umlsMapping } : e);
            setMappingStates(prev => ({ ...prev, [ent.id]: 'error' }));
          }
        } else {
          setMappingStates(prev => ({ ...prev, [ent.id]: 'error' }));
        }
      } catch (err) {
        setMappingStates(prev => ({ ...prev, [ent.id]: 'error' }));
      }
    }

    onUpdateNotes(clinicalNotes, currentEntities, relations);
    setIsMappingAll(false);
  };

  const renderUmlsBadges = (entityId: string, name: string, type: string) => {
    const entity = entities.find(e => e.id === entityId);
    const mapping = entity?.umlsMapping;
    const state = mappingStates[entityId];

    if (state === 'loading' || (mapping && mapping.loading)) {
      return (
        <div className="flex items-center gap-1.5 mt-2 text-[10px] text-slate-400 font-mono">
          <span className="w-2.5 h-2.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></span>
          <span>Connecting UMLS...</span>
        </div>
      );
    }

    if (!mapping) {
      return (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMapEntity(entityId, name, type);
            }}
            className="flex items-center gap-1 text-[9px] font-semibold text-blue-600 hover:text-blue-700 hover:bg-blue-50 border border-blue-100 px-2 py-0.5 rounded transition-all cursor-pointer bg-white"
          >
            <Link2 className="w-2.5 h-2.5" />
            <span>Map UMLS</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenUmlsEdit(entityId);
            }}
            className="flex items-center gap-1 text-[9px] font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded transition-all cursor-pointer bg-white"
            title="Search or define UMLS codes manually"
          >
            <Search className="w-2.5 h-2.5" />
            <span>Manual Search/Edit</span>
          </button>
        </div>
      );
    }

    if (mapping.error) {
      return (
        <div className="flex flex-col gap-1.5 mt-2">
          <div className="flex items-center justify-between gap-2 p-1.5 bg-rose-50 border border-rose-100 rounded text-[9px] text-rose-600 font-medium">
            <div className="flex items-center gap-1 truncate">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 text-rose-500" />
              <span className="truncate">{mapping.error}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMapEntity(entityId, name, type);
              }}
              className="text-[9px] text-blue-600 hover:underline font-semibold shrink-0 cursor-pointer bg-transparent border-0"
            >
              Retry
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleOpenUmlsEdit(entityId);
              }}
              className="flex items-center gap-1 text-[9px] font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 px-2 py-0.5 rounded transition-all cursor-pointer bg-white"
            >
              <Search className="w-2.5 h-2.5" />
              <span>Search / Edit Manually</span>
            </button>
          </div>
        </div>
      );
    }

    if (!mapping.cui) {
      return (
        <div className="mt-2 flex items-center justify-between gap-2 bg-slate-50 border border-slate-100 rounded px-1.5 py-1">
          <span className="text-[9px] font-mono text-slate-400 italic">No UMLS match found</span>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMapEntity(entityId, name, type);
              }}
              className="text-[9px] text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            >
              Re-map
            </button>
            <span className="text-slate-300 text-[9px]">|</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleOpenUmlsEdit(entityId);
              }}
              className="text-[9px] text-slate-500 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            >
              Search/Edit
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="mt-2 pt-1.5 border-t border-dashed border-slate-100 flex flex-wrap gap-1 items-center" onClick={e => e.stopPropagation()}>
        <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mr-1 font-mono">UMLS:</span>
        
        <a
          href={`https://uts.nlm.nih.gov/uts/umls/concept/${mapping.cui}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800 border border-slate-200 transition-colors"
          title={`UMLS Concept Unique Identifier (CUI): ${mapping.preferredName}`}
        >
          <span>{mapping.cui}</span>
        </a>

        {mapping.snomed && (
          <a
            href={`https://terminologie.nictiz.nl/art-decor/snomed-ct?conceptId=${mapping.snomed}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 hover:text-purple-900 border border-purple-100 transition-colors"
            title="SNOMED-CT Code"
          >
            <span>SNOMED: {mapping.snomed}</span>
          </a>
        )}

        {mapping.rxnorm && (
          <a
            href={`https://mor.nlm.nih.gov/RxNav/search?searchBy=NameOrCode&searchTerm=${mapping.rxnorm}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 hover:bg-sky-100 hover:text-sky-900 border border-sky-100 transition-colors"
            title="RxNorm Code"
          >
            <span>RxNorm: {mapping.rxnorm}</span>
          </a>
        )}

        {mapping.icd10 && (
          <a
            href={`https://icd.who.int/browse10/2019/en#/${mapping.icd10}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-900 border border-emerald-100 transition-colors"
            title="ICD-10 (Dutch/General) Code"
          >
            <span>ICD-10: {mapping.icd10}</span>
          </a>
        )}

        {mapping.loinc && (
          <a
            href={`https://loinc.org/${mapping.loinc}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-900 border border-amber-100 transition-colors"
            title="LOINC Code"
          >
            <span>LOINC: {mapping.loinc}</span>
          </a>
        )}

        <div className="flex gap-1.5 ml-auto">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenUmlsEdit(entityId);
            }}
            className="text-[8px] text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            title="Edit UMLS codes manually"
          >
            Edit
          </button>
          <span className="text-[8px] text-slate-300">|</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMapEntity(entityId, name, type);
            }}
            className="text-[8px] text-slate-400 hover:text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            title="Refresh UMLS mapping"
          >
            Re-map
          </button>
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (selectedEntityId && itemRefs.current[selectedEntityId]) {
      itemRefs.current[selectedEntityId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [selectedEntityId]);

  // Triggered when a row is clicked
  const handleItemClick = (entityId: string) => {
    onSelectEntity(entityId === selectedEntityId ? null : entityId);
  };

  // Delete Action
  const handleDelete = (category: 'symptoms' | 'conditions' | 'medications' | 'followUps' | 'measurements', index: number, entityId: string) => {
    const updatedNotes = { ...clinicalNotes };
    if (!updatedNotes[category]) {
      updatedNotes[category] = [];
    }
    updatedNotes[category] = (updatedNotes[category] as any[]).filter((_, idx) => idx !== index);
    
    // Also remove from general entities array
    const updatedEntities = entities.filter(e => e.id !== entityId);

    onUpdateNotes(updatedNotes, updatedEntities);
    if (selectedEntityId === entityId) {
      onSelectEntity(null);
    }
  };

  // Start Editing
  const startEdit = (category: 'symptoms' | 'conditions' | 'medications' | 'followUps' | 'measurements', index: number, item: any) => {
    setEditingIndex({ category, index });
    if (category === 'symptoms') {
      setSymForm(item);
    } else if (category === 'conditions') {
      setCondForm(item);
    } else if (category === 'medications') {
      setMedForm(item);
    } else if (category === 'followUps') {
      setFolForm(item);
    } else if (category === 'measurements') {
      setMeasForm(item);
    }
  };

  // Cancel Editing
  const cancelEdit = () => {
    setEditingIndex(null);
    setSymForm({});
    setCondForm({});
    setMedForm({});
    setFolForm({});
    setMeasForm({});
  };

  // Save Editing
  const saveEdit = (category: 'symptoms' | 'conditions' | 'medications' | 'followUps' | 'measurements', index: number) => {
    const updatedNotes = { ...clinicalNotes };
    const updatedEntities = [...entities];

    if (category === 'symptoms') {
      const updatedSymptom = { ...updatedNotes.symptoms[index], ...symForm } as ClinicalSymptom;
      updatedNotes.symptoms[index] = updatedSymptom;
      
      // Update matching entity
      const entIdx = updatedEntities.findIndex(e => e.id === updatedSymptom.entityId);
      if (entIdx > -1) {
        updatedEntities[entIdx] = {
          ...updatedEntities[entIdx],
          name: updatedSymptom.name,
          description: `${updatedSymptom.severity} - Onset: ${updatedSymptom.onset || 'Unspecified'}`
        };
      }
    } else if (category === 'conditions') {
      const existingCond = updatedNotes.conditions ? updatedNotes.conditions[index] : {} as ClinicalCondition;
      const updatedCond = { ...existingCond, ...condForm } as ClinicalCondition;
      if (!updatedNotes.conditions) updatedNotes.conditions = [];
      updatedNotes.conditions[index] = updatedCond;

      // Update matching entity
      const entIdx = updatedEntities.findIndex(e => e.id === updatedCond.entityId);
      if (entIdx > -1) {
        updatedEntities[entIdx] = {
          ...updatedEntities[entIdx],
          name: updatedCond.name,
          description: `Status: ${updatedCond.status || 'Active'}`
        };
      }
    } else if (category === 'medications') {
      const updatedMed = { ...updatedNotes.medications[index], ...medForm } as ClinicalMedication;
      updatedNotes.medications[index] = updatedMed;

      // Update matching entity
      const entIdx = updatedEntities.findIndex(e => e.id === updatedMed.entityId);
      if (entIdx > -1) {
        updatedEntities[entIdx] = {
          ...updatedEntities[entIdx],
          name: updatedMed.name,
          description: `${updatedMed.action} - Dosage: ${updatedMed.dosage || 'Unspecified'}`
        };
      }
    } else if (category === 'followUps') {
      const updatedFol = { ...updatedNotes.followUps[index], ...folForm } as ClinicalFollowUp;
      updatedNotes.followUps[index] = updatedFol;

      // Update matching entity
      const entIdx = updatedEntities.findIndex(e => e.id === updatedFol.entityId);
      if (entIdx > -1) {
        updatedEntities[entIdx] = {
          ...updatedEntities[entIdx],
          name: updatedFol.task,
          description: `Due: ${updatedFol.due || 'Unspecified'} | Assigned: ${updatedFol.assignee || 'Unspecified'}`
        };
      }
    } else if (category === 'measurements') {
      const existingMeas = updatedNotes.measurements ? updatedNotes.measurements[index] : {} as ClinicalMeasurement;
      const updatedMeas = { ...existingMeas, ...measForm } as ClinicalMeasurement;
      if (!updatedNotes.measurements) updatedNotes.measurements = [];
      updatedNotes.measurements[index] = updatedMeas;

      // Update matching entity
      const entIdx = updatedEntities.findIndex(e => e.id === updatedMeas.entityId);
      if (entIdx > -1) {
        updatedEntities[entIdx] = {
          ...updatedEntities[entIdx],
          name: updatedMeas.name,
          description: `Value: ${updatedMeas.value || 'Unspecified'} | Status: ${updatedMeas.status || 'Stable'}`
        };
      }
    }

    onUpdateNotes(updatedNotes, updatedEntities);
    cancelEdit();
  };

  // Add Item to Category
  const handleAddNewItem = (category: 'symptoms' | 'conditions' | 'medications' | 'followUps' | 'measurements') => {
    const updatedNotes = { ...clinicalNotes };
    const updatedEntities = [...entities];
    const newId = `e_user_${Date.now()}`;

    if (category === 'symptoms') {
      const newSymptom: ClinicalSymptom = {
        entityId: newId,
        name: 'New Symptom',
        severity: 'Unspecified',
        onset: 'Today',
        details: 'Added manually'
      };
      updatedNotes.symptoms = [...updatedNotes.symptoms, newSymptom];
      updatedEntities.push({
        id: newId,
        name: 'New Symptom',
        type: 'Symptom',
        description: 'Unspecified - Onset: Today'
      });
    } else if (category === 'conditions') {
      const newCond: ClinicalCondition = {
        entityId: newId,
        name: 'New Condition',
        status: 'Active',
        details: 'Added manually'
      };
      if (!updatedNotes.conditions) updatedNotes.conditions = [];
      updatedNotes.conditions = [...updatedNotes.conditions, newCond];
      updatedEntities.push({
        id: newId,
        name: 'New Condition',
        type: 'Condition',
        description: 'Status: Active'
      });
    } else if (category === 'medications') {
      const newMed: ClinicalMedication = {
        entityId: newId,
        name: 'New Medication',
        action: 'Discussed',
        dosage: 'Dosage details',
        details: 'Added manually'
      };
      updatedNotes.medications = [...updatedNotes.medications, newMed];
      updatedEntities.push({
        id: newId,
        name: 'New Medication',
        type: 'Medication',
        description: 'Discussed - Dosage details'
      });
    } else if (category === 'followUps') {
      const newFol: ClinicalFollowUp = {
        entityId: newId,
        task: 'New Follow-up Task',
        due: '1 week',
        assignee: 'Patient'
      };
      updatedNotes.followUps = [...updatedNotes.followUps, newFol];
      updatedEntities.push({
        id: newId,
        name: 'New Follow-up Task',
        type: 'FollowUp',
        description: 'Due: 1 week | Assigned: Patient'
      });
    } else if (category === 'measurements') {
      const newMeas: ClinicalMeasurement = {
        entityId: newId,
        name: 'eGFR',
        value: '58 mL/min',
        status: 'Stable',
        details: 'Added manually'
      };
      if (!updatedNotes.measurements) updatedNotes.measurements = [];
      updatedNotes.measurements = [...updatedNotes.measurements, newMeas];
      updatedEntities.push({
        id: newId,
        name: 'eGFR',
        type: 'Measurement',
        description: 'Value: 58 mL/min | Status: Stable'
      });
    }

    onUpdateNotes(updatedNotes, updatedEntities);
    
    // Set to editing immediately
    const lastIndex = (updatedNotes[category] as any[]).length - 1;
    startEdit(category, lastIndex, (updatedNotes[category] as any[])[lastIndex]);
  };

  return (
    <div className="space-y-6">
      {isReadOnly && (
        <>
          <style dangerouslySetInnerHTML={{__html: `
            button[title*="Delete"],
            button[title*="Edit"],
            button[title*="Add"],
            button:has(.lucide-trash2),
            button:has(.lucide-edit2),
            button:has(.lucide-plus),
            button:has(.lucide-link2),
            form {
              display: none !important;
            }
          `}} />
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-indigo-800 text-xs flex items-start gap-3">
            <ShieldAlert className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />
            <div>
              <span className="font-bold">Read-Only Mode:</span> This is a shared clinical session. You can explore the interactive knowledge graph and UMLS term mappings, but editing has been disabled. To customize this session, click the <strong className="text-indigo-950 font-bold">"Clone Session"</strong> button at the top right to copy it to your account!
            </div>
          </div>
        </>
      )}
      {/* UMLS Mapping Dashboard Control */}
      <div className="bg-slate-900 text-white rounded-xl p-4.5 shadow-md border border-slate-800 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="p-1.5 bg-blue-500/20 text-blue-400 rounded-lg shrink-0 mt-0.5">
            <Beaker className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h3 className="font-semibold text-xs leading-tight uppercase tracking-wider text-slate-300 font-mono">
              UMLS Terminology Mapping
            </h3>
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
              Standardize medical concepts: <strong className="text-sky-300 font-medium">RxNorm</strong> for drugs, <strong className="text-purple-300 font-medium">SNOMED-CT</strong> for symptoms, <strong className="text-emerald-300 font-medium">ICD-10</strong> for conditions, and <strong className="text-amber-300 font-medium">LOINC</strong> for lab measurements.
            </p>
          </div>
        </div>
        
        <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between gap-4">
          {isMappingAll ? (
            <div className="flex-1 flex items-center gap-3">
              <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div 
                  className="bg-blue-500 h-1.5 transition-all duration-300" 
                  style={{ width: `${(mapAllProgress.current / mapAllProgress.total) * 100}%` }}
                ></div>
              </div>
              <span className="text-[10px] text-slate-400 font-mono whitespace-nowrap shrink-0">
                {mapAllProgress.current} of {mapAllProgress.total} mapped
              </span>
            </div>
          ) : (
            <>
              <span className="text-[10px] text-slate-500 font-mono">
                Automatic concept mapping
              </span>
              <button
                onClick={handleMapAllEntities}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-[11px] rounded-lg shadow-sm transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
              >
                <Link2 className="w-3 h-3" />
                <span>Auto-Map All</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Symptoms / Conditions Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-amber-50 text-amber-600 rounded-lg">
              <Activity className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800">Symptoms & Conditions</h3>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleAddNewItem('conditions')}
              className="flex items-center gap-1 text-[11px] font-semibold text-orange-600 hover:text-orange-700 bg-orange-50/50 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer"
            >
              <Plus className="w-3 h-3" /> Add Condition
            </button>
            <button
              onClick={() => handleAddNewItem('symptoms')}
              className="flex items-center gap-1 text-[11px] font-semibold text-amber-600 hover:text-amber-700 bg-amber-50/50 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer"
            >
              <Plus className="w-3 h-3" /> Add Symptom
            </button>
          </div>
        </div>

        {((clinicalNotes.conditions || []).length === 0 && clinicalNotes.symptoms.length === 0) ? (
          <p className="text-xs text-slate-400 italic text-center py-4">No symptoms or conditions documented in annotations.</p>
        ) : (
          <div className="space-y-5">
            {/* Conditions Subsection */}
            {(clinicalNotes.conditions || []).length > 0 && (
              <div className="space-y-2">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">Clinical Conditions</h4>
                <div className="space-y-2">
                  {(clinicalNotes.conditions || []).map((condition, idx) => {
                    const isSelected = selectedEntityId === condition.entityId;
                    const isEditing = editingIndex?.category === 'conditions' && editingIndex?.index === idx;

                    return (
                      <div
                        key={`cond-${idx}`}
                        ref={el => { itemRefs.current[condition.entityId] = el; }}
                        onClick={() => !isEditing && handleItemClick(condition.entityId)}
                        className={`border rounded-lg p-3 transition-all relative border-l-4 group ${
                          isSelected
                            ? 'border-l-orange-500 border-y-slate-200 border-r-slate-200 bg-orange-50/10 shadow-sm'
                            : 'border-l-orange-300 border-y-slate-100 border-r-slate-100 bg-slate-50/20'
                        } ${!isEditing ? 'cursor-pointer' : ''}`}
                      >
                        {isEditing ? (
                          <div className="space-y-2.5" onClick={e => e.stopPropagation()}>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Condition Name</label>
                                <input
                                  type="text"
                                  value={condForm.name || ''}
                                  onChange={e => setCondForm({ ...condForm, name: e.target.value })}
                                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400 mt-0.5"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Status</label>
                                <select
                                  value={condForm.status || 'Active'}
                                  onChange={e => setCondForm({ ...condForm, status: e.target.value })}
                                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400 mt-0.5 bg-white"
                                >
                                  <option value="Active">Active</option>
                                  <option value="Chronic">Chronic</option>
                                  <option value="History of">History of</option>
                                  <option value="Differential Diagnosis">Differential Diagnosis</option>
                                  <option value="Unspecified">Unspecified</option>
                                </select>
                              </div>
                            </div>
                            <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Additional Details</label>
                              <input
                                type="text"
                                value={condForm.details || ''}
                                onChange={e => setCondForm({ ...condForm, details: e.target.value })}
                                className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400 mt-0.5"
                              />
                            </div>
                            <div className="flex justify-end gap-1.5 pt-1">
                              <button
                                onClick={cancelEdit}
                                className="p-1 text-slate-400 hover:text-slate-600 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => saveEdit('conditions', idx)}
                                className="p-1 bg-orange-500 hover:bg-orange-600 text-white rounded cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-start justify-between">
                              <div>
                                <h4 className="text-xs font-semibold text-slate-800">{condition.name}</h4>
                                <div className="flex gap-1.5 mt-1">
                                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-orange-50 text-orange-600">
                                    {condition.status || 'Active'}
                                  </span>
                                </div>
                              </div>
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => { e.stopPropagation(); startEdit('conditions', idx, condition); }}
                                  className="p-1 text-slate-400 hover:text-orange-500 cursor-pointer"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDelete('conditions', idx, condition.entityId); }}
                                  className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                            {condition.details && (
                              <p className="text-[10px] text-slate-500 mt-1.5 border-t border-dashed border-slate-100/80 pt-1">
                                {condition.details}
                              </p>
                            )}
                            {renderUmlsBadges(condition.entityId, condition.name, 'Condition')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Symptoms Subsection */}
            {clinicalNotes.symptoms.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">Symptoms</h4>
                <div className="space-y-2">
                  {clinicalNotes.symptoms.map((symptom, idx) => {
                    const isSelected = selectedEntityId === symptom.entityId;
                    const isEditing = editingIndex?.category === 'symptoms' && editingIndex?.index === idx;

                    return (
                      <div
                        key={`sym-${idx}`}
                        ref={el => { itemRefs.current[symptom.entityId] = el; }}
                        onClick={() => !isEditing && handleItemClick(symptom.entityId)}
                        className={`border rounded-lg p-3 transition-all relative border-l-4 group ${
                          isSelected
                            ? 'border-l-amber-500 border-y-slate-200 border-r-slate-200 bg-amber-50/10 shadow-sm'
                            : 'border-l-amber-200 border-y-slate-100 border-r-slate-100 bg-slate-50/20'
                        } ${!isEditing ? 'cursor-pointer' : ''}`}
                      >
                        {isEditing ? (
                          <div className="space-y-2.5" onClick={e => e.stopPropagation()}>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Symptom Name</label>
                                <input
                                  type="text"
                                  value={symForm.name || ''}
                                  onChange={e => setSymForm({ ...symForm, name: e.target.value })}
                                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-red-400 mt-0.5"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Severity</label>
                                <select
                                  value={symForm.severity || 'Unspecified'}
                                  onChange={e => setSymForm({ ...symForm, severity: e.target.value })}
                                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-red-400 mt-0.5 bg-white"
                                >
                                  <option value="Mild">Mild</option>
                                  <option value="Moderate">Moderate</option>
                                  <option value="Severe">Severe</option>
                                  <option value="Unspecified">Unspecified</option>
                                </select>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Onset</label>
                                <input
                                  type="text"
                                  value={symForm.onset || ''}
                                  onChange={e => setSymForm({ ...symForm, onset: e.target.value })}
                                  placeholder="e.g. 3 days ago"
                                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-red-400 mt-0.5"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Additional Details</label>
                                <input
                                  type="text"
                                  value={symForm.details || ''}
                                  onChange={e => setSymForm({ ...symForm, details: e.target.value })}
                                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-red-400 mt-0.5"
                                />
                              </div>
                            </div>
                            <div className="flex justify-end gap-1.5 pt-1">
                              <button
                                onClick={cancelEdit}
                                className="p-1 text-slate-400 hover:text-slate-600 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => saveEdit('symptoms', idx)}
                                className="p-1 bg-red-500 hover:bg-red-600 text-white rounded cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-start justify-between">
                              <div>
                                <h4 className="text-xs font-semibold text-slate-800">{symptom.name}</h4>
                                <div className="flex gap-1.5 mt-1">
                                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                                    symptom.severity === 'Severe' ? 'bg-rose-50 text-rose-600' :
                                    symptom.severity === 'Moderate' ? 'bg-amber-50 text-amber-600' :
                                    symptom.severity === 'Mild' ? 'bg-sky-50 text-sky-600' : 'bg-slate-50 text-slate-500'
                                  }`}>
                                    {symptom.severity}
                                  </span>
                                  {symptom.onset && (
                                    <span className="text-[9px] text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded font-medium">
                                      Onset: {symptom.onset}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => { e.stopPropagation(); startEdit('symptoms', idx, symptom); }}
                                  className="p-1 text-slate-400 hover:text-indigo-500 cursor-pointer"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDelete('symptoms', idx, symptom.entityId); }}
                                  className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                            {symptom.details && (
                              <p className="text-[10px] text-slate-500 mt-1.5 border-t border-dashed border-slate-100/80 pt-1">
                                {symptom.details}
                              </p>
                            )}
                            {renderUmlsBadges(symptom.entityId, symptom.name, 'Symptom')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Medications Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-blue-50 text-blue-500 rounded-lg">
              <Pill className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800">Prescribed Medications</h3>
          </div>
          <button
            onClick={() => handleAddNewItem('medications')}
            className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 bg-blue-50/50 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer"
          >
            <Plus className="w-3 h-3" /> Add Medication
          </button>
        </div>

        {clinicalNotes.medications.length === 0 ? (
          <p className="text-xs text-slate-400 italic text-center py-4">No medications documented in annotations.</p>
        ) : (
          <div className="space-y-2.5">
            {clinicalNotes.medications.map((med, idx) => {
              const isSelected = selectedEntityId === med.entityId;
              const isEditing = editingIndex?.category === 'medications' && editingIndex?.index === idx;

              return (
                <div
                  key={idx}
                  ref={el => { itemRefs.current[med.entityId] = el; }}
                  onClick={() => !isEditing && handleItemClick(med.entityId)}
                  className={`border rounded-lg p-3 transition-all relative border-l-4 ${
                    isSelected
                      ? 'border-l-blue-500 border-y-slate-200 border-r-slate-200 bg-blue-50/10 shadow-sm'
                      : 'border-l-blue-200 border-y-slate-100 border-r-slate-100 bg-slate-50/20'
                  } ${!isEditing ? 'cursor-pointer' : ''}`}
                >
                  {isEditing ? (
                    <div className="space-y-2.5" onClick={e => e.stopPropagation()}>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Medication</label>
                          <input
                            type="text"
                            value={medForm.name || ''}
                            onChange={e => setMedForm({ ...medForm, name: e.target.value })}
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-400 mt-0.5"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Action</label>
                          <select
                            value={medForm.action || 'Discussed'}
                            onChange={e => setMedForm({ ...medForm, action: e.target.value })}
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-400 mt-0.5 bg-white"
                          >
                            <option value="Start">Start</option>
                            <option value="Stop">Stop</option>
                            <option value="Change Dosage">Change Dosage</option>
                            <option value="Continue">Continue</option>
                            <option value="Discussed">Discussed</option>
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Dosage</label>
                          <input
                            type="text"
                            value={medForm.dosage || ''}
                            onChange={e => setMedForm({ ...medForm, dosage: e.target.value })}
                            placeholder="e.g. 20mg daily"
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-400 mt-0.5"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Details</label>
                          <input
                            type="text"
                            value={medForm.details || ''}
                            onChange={e => setMedForm({ ...medForm, details: e.target.value })}
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-400 mt-0.5"
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-1.5 pt-1">
                        <button
                          onClick={cancelEdit}
                          className="p-1 text-slate-400 hover:text-slate-600 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => saveEdit('medications', idx)}
                          className="p-1 bg-green-500 hover:bg-green-600 text-white rounded cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="text-xs font-semibold text-slate-800">{med.name}</h4>
                          <div className="flex gap-1.5 mt-1">
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                              med.action === 'Start' ? 'bg-emerald-50 text-emerald-600' :
                              med.action === 'Stop' ? 'bg-rose-50 text-rose-600' :
                              med.action === 'Change Dosage' ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-500'
                            }`}>
                              {med.action}
                            </span>
                            {med.dosage && (
                              <span className="text-[9px] text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded font-medium">
                                Dosage: {med.dosage}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit('medications', idx, med); }}
                            className="p-1 text-slate-400 hover:text-indigo-500 cursor-pointer"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete('medications', idx, med.entityId); }}
                            className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      {med.details && (
                        <p className="text-[10px] text-slate-500 mt-1.5 border-t border-dashed border-slate-100/80 pt-1">
                          {med.details}
                        </p>
                      )}
                      {renderUmlsBadges(med.entityId, med.name, 'Medication')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Follow-ups Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-green-50 text-green-500 rounded-lg">
              <CalendarCheck className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800">Follow-up Tasks</h3>
          </div>
          <button
            onClick={() => handleAddNewItem('followUps')}
            className="flex items-center gap-1 text-[11px] font-semibold text-green-600 hover:text-green-700 bg-green-50/50 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer"
          >
            <Plus className="w-3 h-3" /> Add Task
          </button>
        </div>

        {clinicalNotes.followUps.length === 0 ? (
          <p className="text-xs text-slate-400 italic text-center py-4">No follow-up tasks documented in annotations.</p>
        ) : (
          <div className="space-y-2.5">
            {clinicalNotes.followUps.map((fol, idx) => {
              const isSelected = selectedEntityId === fol.entityId;
              const isEditing = editingIndex?.category === 'followUps' && editingIndex?.index === idx;

              return (
                <div
                  key={idx}
                  ref={el => { itemRefs.current[fol.entityId] = el; }}
                  onClick={() => !isEditing && handleItemClick(fol.entityId)}
                  className={`border rounded-lg p-3 transition-all relative border-l-4 ${
                    isSelected
                      ? 'border-l-green-500 border-y-slate-200 border-r-slate-200 bg-green-50/10 shadow-sm'
                      : 'border-l-green-200 border-y-slate-100 border-r-slate-100 bg-slate-50/20'
                  } ${!isEditing ? 'cursor-pointer' : ''}`}
                >
                  {isEditing ? (
                    <div className="space-y-2.5" onClick={e => e.stopPropagation()}>
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Task Name</label>
                        <input
                          type="text"
                          value={folForm.task || ''}
                          onChange={e => setFolForm({ ...folForm, task: e.target.value })}
                          className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-cyan-400 mt-0.5"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Due Timeline</label>
                          <input
                            type="text"
                            value={folForm.due || ''}
                            onChange={e => setFolForm({ ...folForm, due: e.target.value })}
                            placeholder="e.g. 2 weeks"
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-cyan-400 mt-0.5"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Assignee</label>
                          <input
                            type="text"
                            value={folForm.assignee || ''}
                            onChange={e => setFolForm({ ...folForm, assignee: e.target.value })}
                            placeholder="e.g. Patient"
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-cyan-400 mt-0.5"
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-1.5 pt-1">
                        <button
                          onClick={cancelEdit}
                          className="p-1 text-slate-400 hover:text-slate-600 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => saveEdit('followUps', idx)}
                          className="p-1 bg-cyan-500 hover:bg-cyan-600 text-white rounded cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="text-xs font-semibold text-slate-800">{fol.task}</h4>
                          <div className="flex gap-1.5 mt-1">
                            {fol.due && (
                              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-600">
                                Due: {fol.due}
                              </span>
                            )}
                            {fol.assignee && (
                              <span className="text-[9px] text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded font-medium">
                                Assignee: {fol.assignee}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit('followUps', idx, fol); }}
                            className="p-1 text-slate-400 hover:text-indigo-500 cursor-pointer"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete('followUps', idx, fol.entityId); }}
                            className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Laboratory & Measurements Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg">
              <Beaker className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800">Laboratory & Vital Measurements</h3>
          </div>
          <button
            onClick={() => handleAddNewItem('measurements')}
            className="flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 bg-indigo-50/50 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer"
          >
            <Plus className="w-3 h-3" /> Add Measurement
          </button>
        </div>

        {(!clinicalNotes.measurements || clinicalNotes.measurements.length === 0) ? (
          <p className="text-xs text-slate-400 italic text-center py-4">No measurements documented in annotations.</p>
        ) : (
          <div className="space-y-2.5">
            {clinicalNotes.measurements.map((meas, idx) => {
              const isSelected = selectedEntityId === meas.entityId;
              const isEditing = editingIndex?.category === 'measurements' && editingIndex?.index === idx;

              return (
                <div
                  key={idx}
                  ref={el => { itemRefs.current[meas.entityId] = el; }}
                  onClick={() => !isEditing && handleItemClick(meas.entityId)}
                  className={`border rounded-lg p-3 transition-all relative border-l-4 group ${
                    isSelected
                      ? 'border-l-indigo-500 border-y-slate-200 border-r-slate-200 bg-indigo-50/10 shadow-sm'
                      : 'border-l-indigo-200 border-y-slate-100 border-r-slate-100 bg-slate-50/20'
                  } ${!isEditing ? 'cursor-pointer' : ''}`}
                >
                  {isEditing ? (
                    <div className="space-y-2.5" onClick={e => e.stopPropagation()}>
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Measurement Name</label>
                        <input
                          type="text"
                          value={measForm.name || ''}
                          onChange={e => setMeasForm({ ...measForm, name: e.target.value })}
                          placeholder="e.g. eGFR, Blood Pressure"
                          className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400 mt-0.5"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Value / Result</label>
                          <input
                            type="text"
                            value={measForm.value || ''}
                            onChange={e => setMeasForm({ ...measForm, value: e.target.value })}
                            placeholder="e.g. 58 mL/min, 140/90"
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400 mt-0.5"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Status / Trend</label>
                          <select
                            value={measForm.status || 'Stable'}
                            onChange={e => setMeasForm({ ...measForm, status: e.target.value })}
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400 mt-0.5 bg-white"
                          >
                            <option value="Stable">Stable</option>
                            <option value="Elevated">Elevated</option>
                            <option value="Decreased">Decreased</option>
                            <option value="Target">Target</option>
                            <option value="Abnormal">Abnormal</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Details / Context</label>
                        <input
                          type="text"
                          value={measForm.details || ''}
                          onChange={e => setMeasForm({ ...measForm, details: e.target.value })}
                          placeholder="e.g. measured today, compared to baseline"
                          className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400 mt-0.5"
                        />
                      </div>
                      <div className="flex justify-end gap-1.5 pt-1">
                        <button
                          onClick={cancelEdit}
                          className="p-1 text-slate-400 hover:text-slate-600 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => saveEdit('measurements', idx)}
                          className="p-1 bg-indigo-500 hover:bg-indigo-600 text-white rounded cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="text-xs font-semibold text-slate-800">{meas.name}</h4>
                          <div className="flex gap-1.5 mt-1">
                            {meas.value && (
                              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">
                                {meas.value}
                              </span>
                            )}
                            {meas.status && (
                              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                                meas.status === 'Target' ? 'bg-emerald-50 text-emerald-600' :
                                meas.status === 'Elevated' ? 'bg-amber-50 text-amber-600' :
                                meas.status === 'Decreased' ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-500'
                              }`}>
                                {meas.status}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit('measurements', idx, meas); }}
                            className="p-1 text-slate-400 hover:text-indigo-500 cursor-pointer"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete('measurements', idx, meas.entityId); }}
                            className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      {meas.details && (
                        <p className="text-[10px] text-slate-500 mt-1.5 border-t border-dashed border-slate-100/80 pt-1">
                          {meas.details}
                        </p>
                      )}
                      {renderUmlsBadges(meas.entityId, meas.name, 'Measurement')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Graph Relations Manager */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg">
              <Link2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Graph Relations Manager</h3>
              <p className="text-[10px] text-slate-400 mt-0.5">Link manual additions to create structured concepts</p>
            </div>
          </div>
          {selectedEntityId && (
            <div className="bg-amber-50 border border-amber-100 px-2 py-0.5 rounded text-[10px] font-medium text-amber-700 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>
              Focusing: {entities.find(e => e.id === selectedEntityId)?.name || 'Focus Entity'}
            </div>
          )}
        </div>

        {/* Add Relation Form */}
        <form onSubmit={handleAddRelation} className="space-y-3 bg-slate-50/50 p-3 rounded-lg border border-slate-100">
          <div className="text-[10px] font-bold text-slate-500 uppercase font-mono tracking-wider">
            Establish New Relationship
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {/* Source Entity Select */}
            <div>
              <label className="block text-[9px] font-bold text-slate-400 uppercase font-mono mb-1">Source Entity</label>
              <select
                value={newRelSource}
                onChange={e => setNewRelSource(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
              >
                <option value="">-- Choose Source --</option>
                {entities.map(ent => (
                  <option key={ent.id} value={ent.id}>
                    ({ent.type}) {ent.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Relationship Type Select */}
            <div>
              <label className="block text-[9px] font-bold text-slate-400 uppercase font-mono mb-1">Relationship Type</label>
              <select
                value={newRelType}
                onChange={e => setNewRelType(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
              >
                <optgroup label="Patient Status & Experience">
                  <option value="EXPERIENCING">EXPERIENCING (Patient &rarr; Symptom)</option>
                  <option value="TAKING">TAKING (Patient &rarr; Medication)</option>
                  <option value="AGREED_TO">AGREED_TO (Patient &rarr; FollowUp)</option>
                  <option value="HAS_MEASUREMENT">HAS_MEASUREMENT (Patient &rarr; Measurement)</option>
                  <option value="DIAGNOSED_WITH">DIAGNOSED_WITH (Patient &rarr; Condition)</option>
                </optgroup>
                
                <optgroup label="Clinical Associations">
                  <option value="TREATS">TREATS (Medication &rarr; Symptom/Condition)</option>
                  <option value="PRESCRIBED_FOR">PRESCRIBED_FOR (Medication &rarr; Condition)</option>
                  <option value="PREVENTS">PREVENTS (Medication &rarr; Condition)</option>
                  <option value="INDICATED_FOR">INDICATED_FOR (Medication &rarr; Condition)</option>
                  <option value="ASSOCIATED_WITH">ASSOCIATED_WITH (Measurement &rarr; Condition)</option>
                  <option value="MONITORING_DRUG">MONITORING_DRUG (Measurement &rarr; Medication)</option>
                  <option value="AFFECTS_MEASUREMENT">AFFECTS_MEASUREMENT (Medication &rarr; Measurement)</option>
                  <option value="HAS_TARGET">HAS_TARGET (Measurement &rarr; Measurement/Other)</option>
                  <option value="TARGET_VALUE">TARGET_VALUE (Measurement &rarr; Measurement/Other)</option>
                  <option value="NORMAL_VALUE">NORMAL_VALUE (Measurement &rarr; Measurement/Other)</option>
                </optgroup>

                <optgroup label="Drug & Dosage Linkage">
                  <option value="HAS_DOSAGE">HAS_DOSAGE (Medication &rarr; Dosage)</option>
                  <option value="DOSAGE_FOR">DOSAGE_FOR (Dosage &rarr; Medication)</option>
                  <option value="REPLACES">REPLACES (Medication &rarr; Medication)</option>
                  <option value="SWITCHED_TO">SWITCHED_TO (Medication &rarr; Medication)</option>
                  <option value="COMBINED_WITH">COMBINED_WITH (Medication &rarr; Medication)</option>
                  <option value="CONTRAINDICATED_WITH">CONTRAINDICATED_WITH (Medication &rarr; Medication)</option>
                </optgroup>

                <optgroup label="Medical Orders & Actions">
                  <option value="PRESCRIBED">PRESCRIBED (Doctor &rarr; Medication)</option>
                  <option value="SCHEDULED">SCHEDULED (Doctor &rarr; FollowUp)</option>
                  <option value="ORDERED_BY">ORDERED_BY (Measurement/Lab &rarr; Doctor)</option>
                  <option value="COOPERATES_WITH">COOPERATES_WITH (Doctor &rarr; Patient)</option>
                </optgroup>

                <optgroup label="Care Plan Attribution & Timing">
                  <option value="PROPOSED_BY">PROPOSED_BY (Condition/Treatment &rarr; Provider)</option>
                  <option value="DIAGNOSED_BY">DIAGNOSED_BY (Condition &rarr; Doctor)</option>
                  <option value="PRESCRIBED_BY">PRESCRIBED_BY (Medication &rarr; Doctor)</option>
                  <option value="SCHEDULED_BY">SCHEDULED_BY (FollowUp &rarr; Doctor)</option>
                  <option value="CANCELLED_BY">CANCELLED_BY (FollowUp &rarr; Doctor)</option>
                  <option value="CONSIDERED_BY">CONSIDERED_BY (Condition/Medication &rarr; Doctor)</option>
                  <option value="DISCONTINUED_BY">DISCONTINUED_BY (Medication &rarr; Doctor)</option>
                  <option value="MEASURES">MEASURES (Measurement &rarr; Patient)</option>
                  <option value="MEASURED_BY">MEASURED_BY (Measurement &rarr; Provider/Patient)</option>
                </optgroup>
              </select>
            </div>

            {/* Target Entity Select */}
            <div>
              <label className="block text-[9px] font-bold text-slate-400 uppercase font-mono mb-1">Target Entity</label>
              <select
                value={newRelTarget}
                onChange={e => setNewRelTarget(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
              >
                <option value="">-- Choose Target --</option>
                {entities.map(ent => (
                  <option key={ent.id} value={ent.id}>
                    ({ent.type}) {ent.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={!newRelSource || !newRelTarget}
              className={`flex items-center gap-1 text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                !newRelSource || !newRelTarget
                  ? 'bg-slate-50 text-slate-400 border-slate-100 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-500 hover:shadow-md'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Link Entities</span>
            </button>
          </div>
        </form>

        {/* Existing Relations List */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-500 uppercase font-mono tracking-wider">
              Active Map Connections ({relations.length})
            </span>
          </div>

          {relations.length === 0 ? (
            <p className="text-xs text-slate-400 italic text-center py-4 bg-slate-50/20 border border-dashed border-slate-100 rounded-lg">
              No custom graph connections established.
            </p>
          ) : (
            <div className="max-h-[220px] overflow-y-auto space-y-1.5 pr-1 border rounded-lg p-2 bg-slate-50/20 scrollbar-thin">
              {relations.map((rel) => {
                const sourceEnt = entities.find(e => e.id === rel.source);
                const targetEnt = entities.find(e => e.id === rel.target);
                const isFocused = selectedEntityId && (rel.source === selectedEntityId || rel.target === selectedEntityId);

                return (
                  <div
                    key={rel.id}
                    className={`flex items-center justify-between p-2 rounded-md border text-xs transition-all ${
                      isFocused
                        ? 'bg-indigo-50/40 border-indigo-200 shadow-sm'
                        : 'bg-white border-slate-100 hover:border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1 flex-wrap font-medium">
                      <span
                        onClick={() => onSelectEntity(rel.source)}
                        className={`cursor-pointer px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-700 hover:bg-slate-200 ${
                          rel.source === selectedEntityId ? 'ring-1 ring-amber-500 font-bold' : ''
                        }`}
                      >
                        {sourceEnt ? sourceEnt.name : 'Unknown'}
                      </span>
                      <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.2 rounded uppercase font-mono">
                        {rel.type}
                      </span>
                      <span
                        onClick={() => onSelectEntity(rel.target)}
                        className={`cursor-pointer px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-700 hover:bg-slate-200 ${
                          rel.target === selectedEntityId ? 'ring-1 ring-amber-500 font-bold' : ''
                        }`}
                      >
                        {targetEnt ? targetEnt.name : 'Unknown'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteRelation(rel.id)}
                      className="p-1 text-slate-400 hover:text-rose-500 rounded transition-colors cursor-pointer ml-2"
                      title="Delete connection"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Raw Object Preview */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm mt-6">
        <div className="text-[10px] font-bold text-slate-400 uppercase mb-2 tracking-wider font-mono">
          Clinical Instance Registry (JSON Node binding)
        </div>
        <div className="bg-slate-900 rounded-lg p-3 text-[10.5px] font-mono text-emerald-400 overflow-x-auto max-h-[160px] scrollbar-thin select-all">
          <pre>{JSON.stringify({
            selectedNodeId: selectedEntityId || 'None (Click a node or entity to bind)',
            selectedEntity: selectedEntityId ? entities.find(e => e.id === selectedEntityId) : null,
            schemaType: selectedEntityId ? entities.find(e => e.id === selectedEntityId)?.type : 'ClinicalEntity',
            bindingProperties: selectedEntityId ? {
              symptomBind: clinicalNotes.symptoms.find(s => s.entityId === selectedEntityId),
              medicationBind: clinicalNotes.medications.find(m => m.entityId === selectedEntityId),
              followUpBind: clinicalNotes.followUps.find(f => f.entityId === selectedEntityId)
            } : 'No active selection'
          }, null, 2)}</pre>
        </div>
      </div>

      {/* UMLS Manual Search and Override Modal */}
      {activeUmlsEditEntityId && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs"
          onClick={() => setActiveUmlsEditEntityId(null)}
        >
          <div 
            className="bg-white rounded-xl shadow-2xl border border-slate-200 max-w-2xl w-full flex flex-col overflow-hidden max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Beaker className="w-5 h-5 text-blue-400" />
                <div>
                  <h3 className="font-semibold text-sm">Manual UMLS Concept Mapping</h3>
                  <p className="text-[10px] text-slate-300 font-mono mt-0.5">
                    Entity: "{entities.find(e => e.id === activeUmlsEditEntityId)?.name}" ({entities.find(e => e.id === activeUmlsEditEntityId)?.type})
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setActiveUmlsEditEntityId(null)}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer p-1 rounded-md hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-5 divide-y divide-slate-100 max-h-[calc(90vh-120px)] scrollbar-thin">
              
              {/* Part 1: UTS Search Engine */}
              <div className="space-y-3">
                <div>
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider font-mono flex items-center gap-1.5">
                    <Search className="w-3.5 h-3.5 text-blue-500" />
                    <span>Search UMLS Metathesaurus</span>
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Query NLM's UTS to search over 100 vocabularies. Selected concepts will automatically auto-fill code registries.
                  </p>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={umlsSearchQuery}
                    onChange={(e) => setUmlsSearchQuery(e.target.value)}
                    placeholder="Search query (e.g. edema, heart failure, paracetamol)..."
                    className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2 bg-slate-50/50 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleUmlsSearch();
                      }
                    }}
                  />
                  <button
                    onClick={handleUmlsSearch}
                    disabled={isUmlsSearching || !umlsSearchQuery.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-100 disabled:text-slate-400 text-white font-semibold text-xs rounded-lg transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
                  >
                    {isUmlsSearching ? (
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    <span>Search</span>
                  </button>
                </div>

                {umlsEditError && (
                  <p className="text-[11px] text-rose-500 font-medium bg-rose-50 border border-rose-100 rounded-md p-2 flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>{umlsEditError}</span>
                  </p>
                )}

                {umlsSearchResults.length > 0 && (
                  <div className="border border-slate-100 rounded-lg overflow-hidden bg-slate-50/50 max-h-[160px] overflow-y-auto scrollbar-thin">
                    <div className="bg-slate-100 px-3 py-1.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider font-mono">
                      Query matches ({umlsSearchResults.length})
                    </div>
                    <div className="divide-y divide-slate-100">
                      {umlsSearchResults.map((res) => (
                        <button
                          key={res.cui}
                          onClick={() => handleSelectSearchResult(res)}
                          disabled={fetchCodesLoading}
                          className="w-full text-left px-3 py-2 text-xs hover:bg-white flex items-center justify-between gap-4 transition-colors disabled:opacity-50"
                        >
                          <span className="font-medium text-slate-700 truncate">{res.name}</span>
                          <span className="font-mono text-[10px] text-blue-600 font-bold bg-blue-50 px-1.5 py-0.5 rounded shrink-0">
                            CUI: {res.cui}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Part 2: Custom / Direct Mapping Overrides */}
              <div className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider font-mono flex items-center gap-1.5">
                    <Settings className="w-3.5 h-3.5 text-purple-500" />
                    <span>Direct Registry Overrides</span>
                  </h4>
                  {fetchCodesLoading && (
                    <div className="flex items-center gap-1.5 text-[10px] text-purple-600 font-semibold font-mono animate-pulse">
                      <span className="w-2.5 h-2.5 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin"></span>
                      <span>Resolving vocabulary mappings...</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Concept Name */}
                  <div className="md:col-span-2">
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      Preferred Concept Name
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.preferredName}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, preferredName: e.target.value }))}
                      placeholder="Preferred standardized term name..."
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* CUI */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      UMLS CUI (Concept Unique Identifier)
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.cui}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, cui: e.target.value }))}
                      placeholder="CXXXXXXX"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* SNOMED */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      SNOMED-CT Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.snomed}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, snomed: e.target.value }))}
                      placeholder="e.g. 29857009"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* RxNorm */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      RxNorm Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.rxnorm}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, rxnorm: e.target.value }))}
                      placeholder="e.g. 1191"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* ICD-10 */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      ICD-10 Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.icd10}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, icd10: e.target.value }))}
                      placeholder="e.g. I10, R60.9"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* LOINC */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      LOINC Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.loinc}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, loinc: e.target.value }))}
                      placeholder="e.g. 1751-7"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={handleRemoveUmlsMapping}
                disabled={!entities.find(e => e.id === activeUmlsEditEntityId)?.umlsMapping}
                className="px-3 py-2 text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-lg font-semibold text-xs transition-all disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:border-transparent cursor-pointer"
              >
                Clear/Remove Mapping
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveUmlsEditEntityId(null)}
                  className="px-3.5 py-2 hover:bg-slate-100 text-slate-700 font-semibold text-xs rounded-lg transition-all border border-slate-200 cursor-pointer bg-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveCustomUmlsMapping}
                  disabled={!customUmlsMapping.cui}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-transparent text-white font-semibold text-xs rounded-lg transition-all cursor-pointer shadow-xs border border-indigo-500 hover:shadow-md"
                >
                  Save Mapping
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
