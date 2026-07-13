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

export type EntityType = 'Patient' | 'Doctor' | 'Symptom' | 'Condition' | 'Medication' | 'Dosage' | 'FollowUp' | 'Measurement' | 'Other';

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

export interface AnnotationData {
  entities: Entity[];
  relations: Relation[];
  clinicalNotes: ClinicalCategory;
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

