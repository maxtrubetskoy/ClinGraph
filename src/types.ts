export interface TranscriptSegment {
  id: string;
  speaker: string;
  text: string;
  timestamp?: string;
}

export interface TextSpan {
  lineIndex: number;
  startChar: number;
  endChar: number;
  text: string;
}

export type EntityType = string;

export interface UmlsMapping {
  cui: string;
  preferredName: string;
  rxnorm?: string;
  snomed?: string;
  icd10?: string;
  loinc?: string;
  loading?: boolean;
  error?: string;
}

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
  textSpan?: TextSpan;
  umlsMapping?: UmlsMapping;
}

export interface Relation {
  id: string;
  source: string; // Entity ID
  target: string; // Entity ID
  type: string;   // e.g. "DIAGNOSED_WITH", "PRESCRIBED", "TREATS", "EXPERIENCING", "SCHEDULED"
}

export interface ClinicalSymptom {
  entityId: string;
  name: string;
  severity: string; // e.g. "Mild", "Moderate", "Severe", "Unspecified"
  onset?: string;
  details?: string;
}

export interface ClinicalCondition {
  entityId: string;
  name: string;
  status: string; // e.g. "Active", "Chronic", "History of", "Differential Diagnosis", "Unspecified"
  details?: string;
}

export interface ClinicalMedication {
  entityId: string;
  name: string;
  action: string; // e.g. "Start", "Stop", "Change Dosage", "Continue"
  dosage?: string;
  details?: string;
}

export interface ClinicalFollowUp {
  entityId: string;
  task: string;
  due?: string;
  assignee?: string;
}

export interface ClinicalMeasurement {
  entityId: string;
  name: string; // e.g. "eGFR", "Blood Pressure", "Target Blood Pressure"
  value?: string; // e.g. "58", "140/90"
  status?: string; // e.g. "Stable", "Decreased", "Elevated", "Target"
  details?: string;
}

export interface ClinicalCategory {
  symptoms: ClinicalSymptom[];
  conditions?: ClinicalCondition[];
  medications: ClinicalMedication[];
  followUps: ClinicalFollowUp[];
  measurements?: ClinicalMeasurement[];
  [customCategory: string]: any[] | undefined;
}

export interface AnnotationAttribute {
  name: string;
  type: 'text' | 'select' | 'boolean';
  choices?: string[]; // If type is 'select'
  hint?: string;
}

export interface AnnotationCategory {
  id: string; // unique key, e.g. "symptoms", "conditions", or a custom one
  entityType: string; // The type of entity matched from knowledge graph (e.g., 'Symptom', 'Condition', 'Medication', etc.)
  displayName: string; // e.g. "Symptoms", "Disorders", "Drugs"
  attributes: AnnotationAttribute[];
  typeHint?: string; // Direct instruction/guidance for LLM model on when to use/not use this category
}

export const DEFAULT_ANNOTATION_SCHEMA: AnnotationCategory[] = [
  {
    id: 'conditions',
    entityType: 'Condition',
    displayName: 'Disorders & Conditions',
    typeHint: 'Use ONLY for formal, established medical diagnoses, diseases, and chronic disorders (e.g. Essential hypertension, Type 2 diabetes). Do NOT classify standard transient symptoms, patient-reported complaints, or temporary physical sensations (e.g. \'early satiety\' / \'vroege verzadiging\' is a Symptom or Observation, NOT a Condition). NEVER extract generic terms like \'klachten\' (complaint) or \'stabiel\' / \'stabiele conditie\' (stable condition) as Conditions.',
    attributes: [
      { name: 'name', type: 'text', hint: 'The medical name of the condition or disease' },
      { name: 'status', type: 'select', choices: ['Active', 'Chronic', 'History of', 'Differential Diagnosis', 'Unspecified'], hint: 'Clinical status or presence' },
      { name: 'details', type: 'text', hint: 'Additional context, specifications, or notes' }
    ]
  },
  {
    id: 'symptoms',
    entityType: 'Symptom',
    displayName: 'Symptoms',
    typeHint: 'Use for physical signs, transient patient-reported complaints, or clinical symptoms (e.g. Nausea, headache, fever, cough, chest pain, early satiety / \'vroege verzadiging\'). Do NOT use for drug allergies (AllergyIntolerance) or chronic disease diagnoses.',
    attributes: [
      { name: 'name', type: 'text', hint: 'The physical symptom or sign' },
      { name: 'severity', type: 'select', choices: ['Mild', 'Moderate', 'Severe', 'Unspecified'], hint: 'The intensity of the symptom' },
      { name: 'onset', type: 'text', hint: 'When the symptom started or duration' },
      { name: 'details', type: 'text', hint: 'Additional characterization of the symptom' }
    ]
  },
  {
    id: 'medications',
    entityType: 'Medication',
    displayName: 'Prescribed Medications',
    typeHint: 'Use for regular daily prescriptions, active therapeutic medications, or over-the-counter drugs (e.g. Metformin, Lisinopril, Pantoprazole). Do NOT use for active vaccine administrations (Immunizations).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Brand or generic drug name' },
      { name: 'action', type: 'select', choices: ['Start', 'Stop', 'Change Dosage', 'Continue', 'Discussed'], hint: 'Status or action of the prescription' },
      { name: 'dosage', type: 'text', hint: 'Dosage amount and frequency' },
      { name: 'details', type: 'text', hint: 'Special instructions or side effects' }
    ]
  },
  {
    id: 'followUps',
    entityType: 'FollowUp',
    displayName: 'Follow-up Tasks',
    typeHint: 'Use for planned future clinical actions, referrals, scheduled diagnostics, or orders (e.g. Ordering an ECG for next week, referral to cardiology). Do NOT use for completed procedures or historical actions.',
    attributes: [
      { name: 'task', type: 'text', hint: 'Description of the follow-up or referral' },
      { name: 'due', type: 'text', hint: 'Due date or timeline' },
      { name: 'assignee', type: 'text', hint: 'Responsible person (e.g. Patient, Doctor)' }
    ]
  },
  {
    id: 'measurements',
    entityType: 'Measurement',
    displayName: 'Laboratory & Vital Measurements',
    typeHint: 'Use for isolated physical measurements, vital sign metrics, or individual lab values (e.g. Blood pressure: 140/90, Heart rate: 72, creatinine: 1.2). Do NOT use for comprehensive lab panels or multi-page summary reports.',
    attributes: [
      { name: 'name', type: 'text', hint: 'Vital sign or lab test name' },
      { name: 'value', type: 'text', hint: 'Result or value with units' },
      { name: 'status', type: 'select', choices: ['Stable', 'Elevated', 'Decreased', 'Target', 'Abnormal'], hint: 'General trend or clinical interpretation' },
      { name: 'details', type: 'text', hint: 'Refining details or target goals' }
    ]
  }
];

export const FHIR_ANNOTATION_SCHEMA: AnnotationCategory[] = [
  {
    id: 'fhir_conditions',
    entityType: 'Condition',
    displayName: 'FHIR Condition',
    typeHint: 'Use ONLY for formal, established medical diagnoses, diseases, illnesses, and chronic disorders (e.g. Essential hypertension, Type 2 diabetes, Polycystic kidney disease). Do NOT classify standard transient clinical symptoms, patient-reported somatic complaints, or temporary physical sensations (e.g. \'early satiety\' / \'vroege verzadiging\' is an Observation or Symptom, NOT a Condition). NEVER extract generic clinical terms like \'klachten\' (complaint) or \'stabiel\' / \'stabiele conditie\' (stable condition) as Condition entities.',
    attributes: [
      { name: 'name', type: 'text', hint: 'Condition code or display name (e.g., Essential hypertension)' },
      { name: 'clinicalStatus', type: 'select', choices: ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved', 'unspecified'], hint: 'active | recurrence | relapse | inactive | remission | resolved' },
      { name: 'verificationStatus', type: 'select', choices: ['unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered-in-error'], hint: 'unconfirmed | provisional | differential | confirmed | refuted' },
      { name: 'severity', type: 'select', choices: ['mild', 'moderate', 'severe', 'unspecified'], hint: 'mild | moderate | severe' },
      { name: 'onset', type: 'text', hint: 'Estimated onset dateTime, age, or period' }
    ]
  },
  {
    id: 'fhir_symptoms',
    entityType: 'Symptom',
    displayName: 'FHIR Observation (Symptom)',
    typeHint: 'Use ONLY for subjective patient-reported symptoms, physical complaints, bodily signs, or temporary sensations (e.g. \'early satiety\' / \'vroege verzadiging\', \'nausea\', \'headache\', \'fatigue\', \'pain\'). Do NOT use for formal diagnoses/chronic diseases (Conditions) or objective physical vitals/measurements.',
    attributes: [
      { name: 'name', type: 'text', hint: 'The physical symptom or subjective complaint' },
      { name: 'severity', type: 'select', choices: ['mild', 'moderate', 'severe', 'unspecified'], hint: 'The intensity or severity of the symptom' },
      { name: 'status', type: 'select', choices: ['registered', 'preliminary', 'final', 'unknown'], hint: 'Clinical status or verification status' },
      { name: 'details', type: 'text', hint: 'Any additional details or context' }
    ]
  },
  {
    id: 'fhir_observations',
    entityType: 'Measurement',
    displayName: 'FHIR Observation (Measurement)',
    typeHint: 'Use strictly for objective, quantitative physical vital signs, laboratory values, or anatomical measurements (e.g. \'grootte van de nieren\' / \'kidney size\', blood pressure: 140/90, heart rate: 72, creatinine: 1.2, eGFR: 58). Do NOT use for subjective patient-reported complaints/symptoms (like \'vroege verzadiging\', nausea, pain, which belong under FHIR Observation (Symptom)), or formal medical diagnoses (Conditions).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Observation code or display name (e.g., Blood Pressure, Body Temperature)' },
      { name: 'status', type: 'select', choices: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'], hint: 'registered | preliminary | final | amended | corrected' },
      { name: 'category', type: 'select', choices: ['vital-signs', 'laboratory', 'imaging', 'social-history', 'exam', 'therapy', 'activity'], hint: 'Classification of type of observation' },
      { name: 'value', type: 'text', hint: 'The absolute result value with units (e.g., 120/80 mmHg, 37.5 C)' },
      { name: 'interpretation', type: 'select', choices: ['Normal', 'High', 'Low', 'Critical High', 'Critical Low', 'Abnormal', 'Unspecified'], hint: 'Clinical interpretation of value' }
    ]
  },
  {
    id: 'fhir_medications',
    entityType: 'Medication',
    displayName: 'FHIR MedicationStatement',
    typeHint: 'Use ONLY for named therapeutic drug names, over-the-counter medications, or active pharmacological treatments (e.g. Lisinopril, Metformin, Pantoprazole). CRITICAL: Do NOT extract generic/abstract nouns like \'medicijn\', \'medicatie\', \'pillen\', \'pills\', or \'medication\' as a MedicationStatement when no specific drug name is given. Do NOT use for vaccines/immunizations.',
    attributes: [
      { name: 'name', type: 'text', hint: 'Brand or generic drug name' },
      { name: 'status', type: 'select', choices: ['active', 'completed', 'entered-in-error', 'intended', 'stopped', 'on-hold', 'unknown', 'not-taken'], hint: 'active | completed | entered-in-error | intended | stopped' },
      { name: 'dosage', type: 'text', hint: 'Dosage instructions (e.g., 1 tablet daily by mouth)' },
      { name: 'details', type: 'text', hint: 'Reason for medication or side notes' }
    ]
  },
  {
    id: 'fhir_allergies',
    entityType: 'Symptom',
    displayName: 'FHIR AllergyIntolerance',
    typeHint: 'Use only for confirmed or suspected food, drug, or substance allergy, hypersensitivity, or intolerance reactions (e.g. Penicillin allergy, peanut allergy, severe rash from medication). Do NOT map ordinary transient patient complaints/symptoms (like vomiting or nausea) unless explicitly stated as an allergy/hypersensitivity reaction.',
    attributes: [
      { name: 'name', type: 'text', hint: 'Allergen or substance (e.g., Penicillin, Peanuts)' },
      { name: 'clinicalStatus', type: 'select', choices: ['active', 'inactive', 'resolved'], hint: 'active | inactive | resolved' },
      { name: 'verificationStatus', type: 'select', choices: ['unconfirmed', 'confirmed', 'refuted', 'entered-in-error'], hint: 'unconfirmed | confirmed | refuted' },
      { name: 'type', type: 'select', choices: ['allergy', 'intolerance', 'unspecified'], hint: 'allergy | intolerance' },
      { name: 'category', type: 'select', choices: ['food', 'medication', 'environment', 'biologic', 'unspecified'], hint: 'food | medication | environment | biologic' },
      { name: 'criticality', type: 'select', choices: ['low', 'high', 'unable-to-assess'], hint: 'low | high | unable-to-assess' }
    ]
  },
  {
    id: 'fhir_serviceRequests',
    entityType: 'FollowUp',
    displayName: 'FHIR ServiceRequest',
    typeHint: 'Use for clinical intent, planned diagnostic tests, upcoming orders, planned referrals, or instructions to schedule an activity in the future (e.g. "We need to order an ECG", "Let\'s request a kidney biopsy", referral to nephrology, or conditionally planned actions like "we will perform an ECG if symptoms occur"). Represents future-planned, scheduled, conditionally-planned, or ordered clinical requests.',
    attributes: [
      { name: 'task', type: 'text', hint: 'The requested service, procedure, or referral' },
      { name: 'status', type: 'select', choices: ['draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'], hint: 'draft | active | on-hold | revoked | completed' },
      { name: 'intent', type: 'select', choices: ['proposal', 'plan', 'directive', 'order', 'original-order', 'unspecified'], hint: 'proposal | plan | directive | order' },
      { name: 'priority', type: 'select', choices: ['routine', 'urgent', 'asap', 'stat'], hint: 'routine | urgent | asap | stat' },
      { name: 'occurrence', type: 'text', hint: 'Timeline or specific timing instructions' }
    ]
  },
  {
    id: 'fhir_procedures',
    entityType: 'FollowUp',
    displayName: 'FHIR Procedure',
    typeHint: 'Use ONLY for the actual performance of medical, surgical, diagnostic, or therapeutic actions that have been completed, are in progress, or are historical (e.g. "had an appendectomy last year", "performing an ECG now", "kidney biopsy was completed"). Do NOT use for future requests, planned upcoming orders, or conditionally planned tests (such as "an ECG to be done when symptoms occur", which is a ServiceRequest).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Procedure or therapy name (e.g., Appendectomy, Chest X-ray)' },
      { name: 'status', type: 'select', choices: ['preparation', 'in-progress', 'not-done', 'on-hold', 'stopped', 'completed', 'entered-in-error', 'unknown'], hint: 'preparation | in-progress | completed | on-hold' },
      { name: 'outcome', type: 'text', hint: 'Outcome of the procedure (e.g., successful, incomplete)' },
      { name: 'performed', type: 'text', hint: 'Date/time or relative timing when performed' }
    ]
  },
  {
    id: 'fhir_immunizations',
    entityType: 'Medication',
    displayName: 'FHIR Immunization',
    typeHint: 'Use only for active administration of vaccines or immunization shots (e.g. Influenza vaccine, Covid-19 vaccine, MMR booster, DTP vaccine). Do NOT use for daily therapeutic drugs or daily drug prescriptions.',
    attributes: [
      { name: 'vaccine', type: 'text', hint: 'Vaccine product or drug name (e.g., Influenza vaccine)' },
      { name: 'status', type: 'select', choices: ['completed', 'not-done', 'entered-in-error'], hint: 'completed | not-done' },
      { name: 'occurrence', type: 'text', hint: 'Date/time administered or patient recollection' },
      { name: 'primarySource', type: 'select', choices: ['true', 'false'], hint: 'Is this from official records (true) or self-reported (false)?' }
    ]
  },
  {
    id: 'fhir_familyHistory',
    entityType: 'Condition',
    displayName: 'FHIR FamilyMemberHistory',
    typeHint: 'Use ONLY for medical conditions, diseases, or chronic illnesses present in the patient\'s biological or non-biological relatives (e.g. "father has PKD", "mother had type 2 diabetes"). Do NOT map the patient\'s own conditions to family history.',
    attributes: [
      { name: 'condition', type: 'text', hint: 'The condition of the family member (e.g., Type 2 Diabetes)' },
      { name: 'relationship', type: 'select', choices: ['father', 'mother', 'sibling', 'grandparent', 'child', 'unspecified'], hint: 'father | mother | sibling | grandparent' },
      { name: 'status', type: 'select', choices: ['confirmed', 'suspected', 'unspecified'], hint: 'Is the condition confirmed or suspected in the relative?' },
      { name: 'onset', type: 'text', hint: 'Approximate age of onset for the relative' }
    ]
  },
  {
    id: 'fhir_diagnosticReports',
    entityType: 'Measurement',
    displayName: 'FHIR DiagnosticReport',
    typeHint: 'Use for comprehensive diagnostic summaries, laboratory panels, or full test result reports containing findings (e.g. Complete Blood Count report, Renal Function Panel, ECG report findings). Do NOT use for isolated vital signs or single individual measurements.',
    attributes: [
      { name: 'reportName', type: 'text', hint: 'Name/type of the report (e.g., Complete Blood Count, Renal Panel)' },
      { name: 'status', type: 'select', choices: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'], hint: 'registered | partial | preliminary | final' },
      { name: 'conclusion', type: 'text', hint: 'Clinical summary/conclusion of the diagnostic report' },
      { name: 'issued', type: 'text', hint: 'Date/time the report was issued' }
    ]
  }
];

export interface Mention {
  id: string;
  textSpan: TextSpan;
  entityType: EntityType;
  entityId: string | null;
  speaker?: string;
  polarity?: 'positive' | 'negative' | 'neutral' | string;
  certainty?: 'certain' | 'uncertain' | 'hypothetical' | string;
  temporality?: 'current' | 'past' | 'future' | string;
  experiencer?: 'patient' | 'family' | 'other' | string;
  function?: 'asserted' | 'questioned' | 'hypothetical' | 'explanatory' | string;
}

export interface AnnotationData {
  entities: Entity[];
  relations: Relation[];
  clinicalNotes: ClinicalCategory;
  mentions?: Mention[];
}

export function normalizeAnnotationSchema(schema: AnnotationCategory[]): AnnotationCategory[] {
  if (!schema) return [];
  
  // Create a combined map of standard category defaults
  const systemDefaultsMap = new Map<string, AnnotationCategory>();
  DEFAULT_ANNOTATION_SCHEMA.forEach(cat => systemDefaultsMap.set(cat.id, cat));
  FHIR_ANNOTATION_SCHEMA.forEach(cat => systemDefaultsMap.set(cat.id, cat));

  return schema.map(cat => {
    const systemDefault = systemDefaultsMap.get(cat.id);
    if (systemDefault) {
      // If typeHint is missing or looks like an empty placeholder
      const needsUpdate = !cat.typeHint || cat.typeHint.trim() === '';
      if (needsUpdate) {
        return {
          ...cat,
          typeHint: systemDefault.typeHint
        };
      }
    }
    return cat;
  });
}

export function areSchemasIdentical(
  schemaA?: AnnotationCategory[],
  schemaB?: AnnotationCategory[]
): boolean {
  const normA = normalizeAnnotationSchema(schemaA || DEFAULT_ANNOTATION_SCHEMA);
  const normB = normalizeAnnotationSchema(schemaB || DEFAULT_ANNOTATION_SCHEMA);

  if (normA.length !== normB.length) return false;

  for (const catA of normA) {
    const catB = normB.find(
      b => b.id.toLowerCase() === catA.id.toLowerCase() ||
           (b.displayName.toLowerCase().trim() === catA.displayName.toLowerCase().trim() &&
            b.entityType.toLowerCase().trim() === catA.entityType.toLowerCase().trim())
    );
    if (!catB) return false;

    if (catA.displayName.trim() !== catB.displayName.trim()) return false;
    if (catA.entityType.trim() !== catB.entityType.trim()) return false;
    if ((catA.typeHint || '').trim() !== (catB.typeHint || '').trim()) return false;

    const attrsA = catA.attributes || [];
    const attrsB = catB.attributes || [];
    if (attrsA.length !== attrsB.length) return false;

    for (const attrA of attrsA) {
      const attrB = attrsB.find(b => b.name.trim() === attrA.name.trim());
      if (!attrB) return false;
      if (attrA.type !== attrB.type) return false;
      if ((attrA.hint || '').trim() !== (attrB.hint || '').trim()) return false;
      if (attrA.type === 'select') {
        const choicesA = (attrA.choices || []).map(c => c.trim()).join(',');
        const choicesB = (attrB.choices || []).map(c => c.trim()).join(',');
        if (choicesA !== choicesB) return false;
      }
    }
  }

  return true;
}

export function migrateToMentionsSchema(annotation: any): {
  entities: Entity[];
  relations: Relation[];
  clinicalNotes: ClinicalCategory;
  mentions: Mention[];
} {
  if (!annotation) {
    return {
      entities: [],
      relations: [],
      clinicalNotes: { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] },
      mentions: []
    };
  }

  // If mentions already exist, return as is (ensuring all have default attributes if missing)
  if (annotation.mentions && annotation.mentions.length > 0) {
    const updatedMentions = annotation.mentions.map((m: any) => ({
      speaker: 'patient',
      polarity: 'positive',
      certainty: 'certain',
      temporality: 'current',
      experiencer: 'patient',
      function: 'asserted',
      ...m
    }));
    return {
      entities: annotation.entities || [],
      relations: annotation.relations || [],
      clinicalNotes: annotation.clinicalNotes || { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] },
      mentions: updatedMentions
    };
  }

  const rawEntities = annotation.entities || [];
  const rawRelations = annotation.relations || [];
  const rawNotes = annotation.clinicalNotes || { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] };

  const canonicalEntities: Entity[] = [];
  const mentions: Mention[] = [];
  const idMap: { [oldId: string]: string } = {};

  rawEntities.forEach((ent: any) => {
    const key = `${ent.type.toLowerCase()}:${ent.name.toLowerCase().trim()}`;
    let canonical = canonicalEntities.find(c => `${c.type.toLowerCase()}:${c.name.toLowerCase().trim()}` === key);
    
    if (!canonical) {
      const canonicalId = `e_canonical_${ent.id}`;
      canonical = {
        id: canonicalId,
        name: ent.name,
        type: ent.type,
        description: ent.description,
        umlsMapping: ent.umlsMapping
      };
      canonicalEntities.push(canonical);
    }
    
    idMap[ent.id] = canonical.id;

    if (ent.textSpan && ent.textSpan.lineIndex >= 0) {
      mentions.push({
        id: `m_${ent.id}`,
        textSpan: ent.textSpan,
        entityType: ent.type,
        entityId: canonical.id,
        speaker: 'patient',
        polarity: 'positive',
        certainty: 'certain',
        temporality: 'current',
        experiencer: 'patient',
        function: 'asserted'
      });
    }
  });

  const remappedRelations: Relation[] = [];
  const relKeys = new Set<string>();

  rawRelations.forEach((rel: any) => {
    const newSource = idMap[rel.source] || rel.source;
    const newTarget = idMap[rel.target] || rel.target;
    
    if (newSource === newTarget) return;

    const relKey = `${newSource}:${rel.type}:${newTarget}`;
    if (!relKeys.has(relKey)) {
      relKeys.add(relKey);
      remappedRelations.push({
        id: rel.id || `r_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        source: newSource,
        target: newTarget,
        type: rel.type
      });
    }
  });

  const remappedNotes: ClinicalCategory = {
    symptoms: [],
    conditions: [],
    medications: [],
    followUps: [],
    measurements: []
  };

  const processCategory = (categoryName: keyof ClinicalCategory) => {
    const items = rawNotes[categoryName] || [];
    const seenNames = new Set<string>();
    
    items.forEach((item: any) => {
      const oldEntityId = item.entityId;
      const newEntityId = idMap[oldEntityId] || oldEntityId;
      const nameVal = item.name || item.task || '';
      const key = `${newEntityId}:${nameVal.toLowerCase().trim()}`;

      if (!seenNames.has(key)) {
        seenNames.add(key);
        remappedNotes[categoryName]!.push({
          ...item,
          entityId: newEntityId
        });
      }
    });
  };

  processCategory('symptoms');
  processCategory('conditions');
  processCategory('medications');
  processCategory('followUps');
  processCategory('measurements');

  return {
    entities: canonicalEntities,
    relations: remappedRelations,
    clinicalNotes: remappedNotes,
    mentions: mentions
  };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  rawTranscript: string;
  transcriptSegments: TranscriptSegment[];
  hasAudio: boolean;
  audioLocalId?: string; // Key to local IndexedDB storage
  audioDataUrl?: string; // Backup small base64 data url if IndexedDB is not used
  annotation?: AnnotationData;
  status: 'draft' | 'processing' | 'annotated' | 'failed';
  encounterType?: 'dialogue' | 'note';
  userId?: string;
  isShared?: boolean;
  sharedFromId?: string;
  groupId?: string; // Links this session to a SessionGroup
  sharedGroupData?: {
    id?: string;
    name: string;
    settings?: SessionGroupSettings;
  };
}

export interface SessionGroupSettings {
  description?: string;
  encounterTemplate?: 'soap' | 'birp' | 'standard' | string;
  preferredModel?: string;
  clinicalTaxonomy?: 'snomed' | 'icd10' | 'rxnorm' | 'all' | string;
  annotationSchema?: AnnotationCategory[];
}

export interface SessionGroup {
  id: string;
  name: string;
  createdAt: string;
  userId: string;
  settings?: SessionGroupSettings;
}

export interface ModelConfig {
  provider: 'gemini' | 'openai';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface UserAiConfig {
  transcription: ModelConfig;
  annotation: ModelConfig;
}

