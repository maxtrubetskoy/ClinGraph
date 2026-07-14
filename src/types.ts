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

export type EntityType = 'Person' | 'Patient' | 'Doctor' | 'Symptom' | 'Condition' | 'Medication' | 'Dosage' | 'FollowUp' | 'Measurement' | 'Other';

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
}

export interface Mention {
  id: string;
  textSpan: TextSpan;
  entityType: EntityType;
  entityId: string | null;
  speaker?: string;
  polarity?: 'positive' | 'negative' | 'neutral' | string;
  certainty?: 'certain' | 'uncertain' | 'hypothetical' | string;
  temporality?: 'current' | 'past' | 'future' | string;
  experiencer?: 'patient' | 'other' | string;
  function?: 'asserted' | 'questioned' | 'hypothetical' | 'explanatory' | string;
}

export interface AnnotationData {
  entities: Entity[];
  relations: Relation[];
  clinicalNotes: ClinicalCategory;
  mentions?: Mention[];
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

