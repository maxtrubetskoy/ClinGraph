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
  segmentId?: string;
  speaker?: string;
  /** 0-based word index across concatenated segment texts, invariant to speaker/utterance splits */
  globalStartWord?: number;
  /** 0-based word index of the last word in the mention */
  globalEndWord?: number;
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
  severity: string; // e.g. "Mild", "Moderate", "Severe", "None / Denied", "Unspecified"
  status?: string;   // e.g. "Active", "Resolved", "Refuted", "Unconfirmed", "Unspecified"
  onset?: string;
  details?: string;
}

export interface ClinicalCondition {
  entityId: string;
  name: string;
  status: string; // e.g. "Active", "Chronic", "History of", "Differential Diagnosis", "Refuted", "Unspecified"
  verificationStatus?: string; // e.g. "unconfirmed", "provisional", "differential", "confirmed", "refuted", "entered-in-error"
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

export interface ClinicalSocialStatus {
  entityId: string;
  name: string; // e.g. "Tobacco Smoking Status", "Alcohol Consumption", "Substance Use"
  value?: string; // e.g. "Former smoker", "Current every day smoker", "Never smoker", "1-2 drinks per week", "Non-drinker"
  status?: string; // e.g. "final", "preliminary", "amended", "Active", "Former", "Never"
  category?: string; // e.g. "social-history"
  details?: string; // e.g. "Pack-years, cessation date, frequency, or living conditions"
}

export interface ClinicalCategory {
  symptoms: ClinicalSymptom[];
  conditions?: ClinicalCondition[];
  medications: ClinicalMedication[];
  followUps: ClinicalFollowUp[];
  measurements?: ClinicalMeasurement[];
  socialStatus?: ClinicalSocialStatus[];
  socialHistory?: ClinicalSocialStatus[];
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
    typeHint: 'Use ONLY for formal, established medical diagnoses, diseases, and chronic disorders (e.g. Essential hypertension, Type 2 diabetes) experienced by the patient. Do NOT classify standard transient symptoms, patient-reported complaints, or temporary physical sensations (e.g. \'early satiety\' / \'vroege verzadiging\' is a Symptom, NOT a Condition). NEVER extract generic terms like \'klachten\' (complaint) or \'stabiel\' / \'stabiele conditie\' (stable condition) as Conditions. NEVER map to family history unless specifically diagnosed in a biological relative.',
    attributes: [
      { name: 'name', type: 'text', hint: 'The medical name of the condition or disease' },
      { name: 'status', type: 'select', choices: ['Unassigned', 'Active', 'Chronic', 'History of', 'Differential Diagnosis', 'Refuted', 'Unspecified'], hint: 'Clinical status or presence (use "Refuted" for ruled-out or screened and denied conditions)' },
      { name: 'details', type: 'text', hint: 'Additional context, specifications, or notes' }
    ]
  },
  {
    id: 'symptoms',
    entityType: 'Symptom',
    displayName: 'Symptoms',
    typeHint: 'Use for physical signs, somatic complaints, bodily sensations, or transient clinical symptoms reported by the patient (e.g. Cramps / spierkrampen, dizziness / duizeligheid, fatigue / moeheid / uitgeput, nausea, headache, fever, cough, chest pain, early satiety / vroege verzadiging). Do NOT use for drug allergies (AllergyIntolerance) or chronic disease diagnoses.',
    attributes: [
      { name: 'name', type: 'text', hint: 'The physical symptom or sign' },
      { name: 'severity', type: 'select', choices: ['Unassigned', 'Mild', 'Moderate', 'Severe', 'None / Denied', 'Unspecified'], hint: 'The intensity of the symptom' },
      { name: 'status', type: 'select', choices: ['Unassigned', 'Active', 'Resolved', 'Refuted', 'Unconfirmed', 'Unspecified'], hint: 'Clinical presence or verification status (use "Refuted" when screened and denied/absent)' },
      { name: 'onset', type: 'text', hint: 'When the symptom started or duration' },
      { name: 'details', type: 'text', hint: 'Additional characterization of the symptom' }
    ]
  },
  {
    id: 'medications',
    entityType: 'Medication',
    displayName: 'Prescribed Medications',
    typeHint: 'Use for regular daily prescriptions, active therapeutic medications, pain relievers/analgesics (e.g. Paracetamol, Acetaminophen, Tylenol, Ibuprofen, Aspirin), antipyretics, PPIs (Pantoprazole, Omeprazole), or over-the-counter drugs (e.g. Metformin, Lisinopril). Do NOT use for active vaccine administrations (Immunizations).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Brand or generic drug name' },
      { name: 'action', type: 'select', choices: ['Unassigned', 'Start', 'Stop', 'Change Dosage', 'Continue', 'Discussed'], hint: 'Status or action of the prescription' },
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
      { name: 'status', type: 'select', choices: ['Unassigned', 'Stable', 'Elevated', 'Decreased', 'Target', 'Abnormal'], hint: 'General trend or clinical interpretation' },
      { name: 'details', type: 'text', hint: 'Refining details or target goals' }
    ]
  },
  {
    id: 'socialStatus',
    entityType: 'Observation',
    displayName: 'Social Status & Lifestyle',
    typeHint: 'Use for patient social history, lifestyle factors, behavioral risks, and personal habits including tobacco/cigarette smoking status, vaping, alcohol intake, recreational substance use, occupational background, living arrangements, and exercise habits.',
    attributes: [
      { name: 'name', type: 'text', hint: 'Habit or social factor (e.g., Tobacco Smoking Status, Alcohol Use, Substance Use, Occupation, Living Situation)' },
      { name: 'status', type: 'select', choices: ['Unassigned', 'Active', 'Former', 'Never', 'Occasional', 'Daily', 'Denied', 'Unspecified'], hint: 'Reported status or habit pattern (e.g., Former smoker, Non-smoker, 1-2 drinks/week, Denies drug use, Lives with partner)' },
      { name: 'details', type: 'text', hint: 'Frequency, quit date, pack-years, or lifestyle context' }
    ]
  }
];

export const FHIR_ANNOTATION_SCHEMA: AnnotationCategory[] = [
  {
    id: 'fhir_conditions',
    entityType: 'Condition',
    displayName: 'FHIR Condition',
    typeHint: 'Use ONLY for formal, established medical diagnoses, diseases, illnesses, and chronic disorders (e.g. Essential hypertension, Type 2 diabetes, Polycystic kidney disease) experienced by the patient. Do NOT classify standard transient clinical symptoms, patient-reported somatic complaints, or temporary physical sensations (e.g. \'early satiety\' / \'vroege verzadiging\' is a Symptom, NOT a Condition). NEVER extract generic clinical terms like \'klachten\' (complaint) or \'stabiel\' / \'stabiele conditie\' (stable condition) as Condition entities. NEVER classify the patient\'s own conditions as FamilyMemberHistory!',
    attributes: [
      { name: 'name', type: 'text', hint: 'Condition code or display name (e.g., Essential hypertension)' },
      { name: 'clinicalStatus', type: 'select', choices: ['unassigned', 'active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved', 'unspecified'], hint: 'unassigned | active | recurrence | relapse | inactive | remission | resolved' },
      { name: 'verificationStatus', type: 'select', choices: ['unassigned', 'unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered-in-error'], hint: 'unassigned | unconfirmed | provisional | differential | confirmed | refuted' },
      { name: 'severity', type: 'select', choices: ['unassigned', 'mild', 'moderate', 'severe', 'unspecified'], hint: 'unassigned | mild | moderate | severe' },
      { name: 'onset', type: 'text', hint: 'Estimated onset dateTime, age, or period' }
    ]
  },
  {
    id: 'fhir_symptoms',
    entityType: 'Symptom',
    displayName: 'FHIR Observation (Symptom)',
    typeHint: 'Use for patient-reported physical symptoms, somatic complaints, bodily signs, or temporary sensations (e.g. \'spierkrampen\' / \'kramp\', \'duizeligheid\' / dizziness, \'moeheid\' / fatigue, \'vroege verzadiging\' / early satiety, nausea, headache, pain). Do NOT map to AllergyIntolerance or Condition.',
    attributes: [
      { name: 'name', type: 'text', hint: 'The physical symptom or subjective complaint' },
      { name: 'severity', type: 'select', choices: ['unassigned', 'mild', 'moderate', 'severe', 'unspecified'], hint: 'unassigned | mild | moderate | severe' },
      { name: 'status', type: 'select', choices: ['unassigned', 'registered', 'preliminary', 'final', 'refuted', 'unknown'], hint: 'unassigned | registered | preliminary | final | refuted' },
      { name: 'details', type: 'text', hint: 'Any additional details or context' }
    ]
  },
  {
    id: 'fhir_observations',
    entityType: 'Observation',
    displayName: 'FHIR Observation (Measurement)',
    typeHint: 'Use strictly for objective, quantitative physical vital signs, laboratory values, or anatomical measurements (e.g. \'grootte van de nieren\' / \'kidney size\', blood pressure: 140/90, heart rate: 72, creatinine: 1.2, eGFR: 58). Do NOT use for subjective patient-reported complaints/symptoms (like \'vroege verzadiging\', cramps, nausea, pain, which belong under FHIR Observation (Symptom)), or formal medical diagnoses (Conditions).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Observation code or display name (e.g., Blood Pressure, Body Temperature)' },
      { name: 'status', type: 'select', choices: ['unassigned', 'registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'], hint: 'unassigned | registered | preliminary | final | amended | corrected' },
      { name: 'category', type: 'select', choices: ['unassigned', 'vital-signs', 'laboratory', 'imaging', 'social-history', 'exam', 'therapy', 'activity'], hint: 'unassigned | vital-signs | laboratory | imaging | social-history' },
      { name: 'value', type: 'text', hint: 'The absolute result value with units (e.g., 120/80 mmHg, 37.5 C)' },
      { name: 'interpretation', type: 'select', choices: ['Unassigned', 'Normal', 'High', 'Low', 'Critical High', 'Critical Low', 'Abnormal', 'Unspecified'], hint: 'Unassigned | Normal | High | Low | Critical High | Critical Low | Abnormal' }
    ]
  },
  {
    id: 'fhir_socialStatus',
    entityType: 'Observation',
    displayName: 'FHIR Observation (Social Status)',
    typeHint: 'Use strictly for FHIR Social History Observations (category: social-history): personal habits, behavioral risk factors, lifestyle factors, and social determinants of health (e.g. tobacco/nicotine smoking status, cigarette use, alcohol consumption or frequency, illicit substance/drug use, employment status, housing situation, living arrangements, physical exercise, or dietary habits). Do NOT use for physiological/vital signs (e.g. Blood Pressure is a vital sign measurement), laboratory tests, or medical diagnoses (Conditions).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Social factor or observation code (e.g., Tobacco Smoking Status, Alcohol Consumption, Substance Use, Employment Status, Living Situation)' },
      { name: 'value', type: 'text', hint: 'Observed status or quantity (e.g., Former smoker, Current every day smoker, Never smoker, 1-2 drinks/week, Non-drinker, Denies illicit drug use, Lives with spouse)' },
      { name: 'status', type: 'select', choices: ['unassigned', 'final', 'preliminary', 'amended', 'registered', 'entered-in-error', 'unknown'], hint: 'unassigned | final | preliminary | amended' },
      { name: 'category', type: 'select', choices: ['unassigned', 'social-history'], hint: 'unassigned | social-history' },
      { name: 'details', type: 'text', hint: 'Additional context, pack-years, cessation date, frequency, or lifestyle details' }
    ]
  },
  {
    id: 'fhir_medications',
    entityType: 'Medication',
    displayName: 'FHIR MedicationStatement',
    typeHint: 'Use ONLY for named therapeutic drug names, over-the-counter medications, pain relievers/analgesics (e.g. Paracetamol, Acetaminophen, Tylenol, Ibuprofen, Aspirin), antipyretics, gastroprotectives/PPIs (Pantoprazole, Omeprazole, maagbeschermer), or active pharmacological treatments (e.g. Lisinopril, Metformin, Albuterol). CRITICAL: Do NOT extract generic/abstract nouns like \'medicijn\', \'medicatie\', \'pillen\', \'pills\', or \'medication\' as a MedicationStatement when no specific drug name is given. CRITICAL NEGATIVE CONSTRAINT: Daily prescriptions and pain medications (such as Paracetamol) MUST NEVER be classified as Immunizations.',
    attributes: [
      { name: 'name', type: 'text', hint: 'Brand or generic drug name' },
      { name: 'status', type: 'select', choices: ['unassigned', 'active', 'completed', 'entered-in-error', 'intended', 'stopped', 'on-hold', 'unknown', 'not-taken'], hint: 'unassigned | active | completed | entered-in-error | intended | stopped' },
      { name: 'dosage', type: 'text', hint: 'Dosage instructions (e.g., 1 tablet daily by mouth)' },
      { name: 'details', type: 'text', hint: 'Reason for medication or side notes' }
    ]
  },
  {
    id: 'fhir_medicationRequests',
    entityType: 'MedicationRequest',
    displayName: 'FHIR MedicationRequest',
    typeHint: 'Use for clinician prescription orders, proposals, or authorization changes to start, adjust, or discontinue a medication during the encounter (e.g., "I will prescribe Lisinopril 20mg", "Let\'s start Metformin 500mg daily", "Stop taking the water pill"). Differentiates active prescription directives from patient-reported historical medication usage (which belongs to MedicationStatement).',
    attributes: [
      { name: 'medication', type: 'text', hint: 'Prescribed drug brand or generic name (e.g., Lisinopril)' },
      { name: 'status', type: 'select', choices: ['unassigned', 'active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'], hint: 'unassigned | active | draft | on-hold | stopped | cancelled' },
      { name: 'intent', type: 'select', choices: ['unassigned', 'proposal', 'plan', 'order', 'original-order', 'option'], hint: 'unassigned | proposal | plan | order' },
      { name: 'priority', type: 'select', choices: ['unassigned', 'routine', 'urgent', 'asap', 'stat'], hint: 'unassigned | routine | urgent | asap | stat' },
      { name: 'dosageInstruction', type: 'text', hint: 'Prescription directions (e.g., 20mg PO once daily in the morning)' }
    ]
  },
  {
    id: 'fhir_allergies',
    entityType: 'AllergyIntolerance',
    displayName: 'FHIR AllergyIntolerance',
    typeHint: 'CRITICAL ALLERGY/INTOLERANCE RULE: Use ONLY for confirmed or suspected true immunological allergies or hypersensitivity reactions to specific allergens (e.g. Penicillin allergy, peanut allergy, severe drug rash). CRITICAL EXCLUSION: Ordinary somatic symptoms, muscle cramps (\'kramp\' / \'spierkrampen\'), dizziness (\'duizeligheid\'), fatigue (\'moeheid\' / \'uitgeput\'), pain, nausea, dialysis side effects, or general discomfort MUST NEVER be mapped to AllergyIntolerance! They belong strictly to FHIR Observation (Symptom).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Allergen or substance (e.g., Penicillin, Peanuts)' },
      { name: 'clinicalStatus', type: 'select', choices: ['unassigned', 'active', 'inactive', 'resolved'], hint: 'unassigned | active | inactive | resolved' },
      { name: 'verificationStatus', type: 'select', choices: ['unassigned', 'unconfirmed', 'confirmed', 'refuted', 'entered-in-error'], hint: 'unassigned | unconfirmed | confirmed | refuted' },
      { name: 'type', type: 'select', choices: ['unassigned', 'allergy', 'intolerance', 'unspecified'], hint: 'unassigned | allergy | intolerance' },
      { name: 'category', type: 'select', choices: ['unassigned', 'food', 'medication', 'environment', 'biologic', 'unspecified'], hint: 'unassigned | food | medication | environment | biologic' },
      { name: 'criticality', type: 'select', choices: ['unassigned', 'low', 'high', 'unable-to-assess'], hint: 'unassigned | low | high | unable-to-assess' }
    ]
  },
  {
    id: 'fhir_serviceRequests',
    entityType: 'ServiceRequest',
    displayName: 'FHIR ServiceRequest',
    typeHint: 'Use for clinical intent, planned diagnostic tests, upcoming orders, planned referrals, or instructions to schedule an activity in the future (e.g. "We need to order an ECG", "Let\'s request a kidney biopsy", referral to nephrology, or conditionally planned actions like "we will perform an ECG if symptoms occur"). Represents future-planned, scheduled, conditionally-planned, or ordered clinical requests.',
    attributes: [
      { name: 'task', type: 'text', hint: 'The requested service, procedure, or referral' },
      { name: 'status', type: 'select', choices: ['unassigned', 'draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'], hint: 'unassigned | draft | active | on-hold | revoked | completed' },
      { name: 'intent', type: 'select', choices: ['unassigned', 'proposal', 'plan', 'directive', 'order', 'original-order', 'unspecified'], hint: 'unassigned | proposal | plan | directive | order' },
      { name: 'priority', type: 'select', choices: ['unassigned', 'routine', 'urgent', 'asap', 'stat'], hint: 'unassigned | routine | urgent | asap | stat' },
      { name: 'occurrence', type: 'text', hint: 'Timeline or specific timing instructions' }
    ]
  },
  {
    id: 'fhir_carePlans',
    entityType: 'CarePlan',
    displayName: 'FHIR CarePlan',
    typeHint: 'Use for overarching management plans, multi-step care pathways, lifestyle interventions, dietary regimens, and clinical strategies (e.g. "hypertension management plan", "diabetes lifestyle and glycemic control plan", "smoking cessation regimen", "low-sodium diet guidance"). Represents structured clinical management plans combining instructions, goals, and coordinated activities. Do NOT use for single diagnostic orders or referrals (which are ServiceRequests).',
    attributes: [
      { name: 'title', type: 'text', hint: 'Title or focus of the care plan (e.g., Hypertension Management Regimen)' },
      { name: 'status', type: 'select', choices: ['unassigned', 'draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'], hint: 'unassigned | draft | active | on-hold | revoked | completed' },
      { name: 'intent', type: 'select', choices: ['unassigned', 'proposal', 'plan', 'order', 'option'], hint: 'unassigned | proposal | plan | order' },
      { name: 'category', type: 'select', choices: ['unassigned', 'assess-plan', 'lifestyle', 'disease-management', 'rehabilitation', 'unspecified'], hint: 'unassigned | assess-plan | lifestyle | disease-management' },
      { name: 'description', type: 'text', hint: 'Key interventions, lifestyle directives, or coordinated patient instructions' }
    ]
  },
  {
    id: 'fhir_goals',
    entityType: 'Goal',
    displayName: 'FHIR Goal',
    typeHint: 'Use for specific health objectives, targets, desired clinical outcomes, or patient commitments established during the consultation (e.g. "Target blood pressure < 130/80 mmHg", "HbA1c target below 7%", "Lose 5 kg by next visit", "Walk 30 minutes daily", "Quit smoking within one month"). Distinct from measurements (actual observed values) or care plans (the overall management strategy).',
    attributes: [
      { name: 'description', type: 'text', hint: 'The target clinical or behavioral objective (e.g., Blood pressure < 130/80 mmHg)' },
      { name: 'lifecycleStatus', type: 'select', choices: ['unassigned', 'proposed', 'planned', 'accepted', 'active', 'on-hold', 'completed', 'cancelled', 'entered-in-error', 'rejected'], hint: 'unassigned | proposed | planned | accepted | active | completed' },
      { name: 'achievementStatus', type: 'select', choices: ['unassigned', 'in-progress', 'improving', 'worsening', 'no-change', 'achieved', 'sustaining', 'not-achieved', 'no-progress', 'not-attainable'], hint: 'unassigned | in-progress | improving | achieved | not-achieved' },
      { name: 'priority', type: 'select', choices: ['unassigned', 'high-priority', 'medium-priority', 'low-priority'], hint: 'unassigned | high-priority | medium-priority | low-priority' },
      { name: 'targetDate', type: 'text', hint: 'Target completion date or timeline (e.g., in 3 months, by next appointment)' }
    ]
  },
  {
    id: 'fhir_procedures',
    entityType: 'Procedure',
    displayName: 'FHIR Procedure',
    typeHint: 'Use ONLY for the actual performance of medical, surgical, diagnostic, or therapeutic actions that have been completed, are in progress, or are historical (e.g. "had an appendectomy last year", "performing an ECG now", "kidney biopsy was completed"). Do NOT use for future requests, planned upcoming orders, or conditionally planned tests (such as "an ECG to be done when symptoms occur", which is a ServiceRequest).',
    attributes: [
      { name: 'name', type: 'text', hint: 'Procedure or therapy name (e.g., Appendectomy, Chest X-ray)' },
      { name: 'status', type: 'select', choices: ['unassigned', 'preparation', 'in-progress', 'not-done', 'on-hold', 'stopped', 'completed', 'entered-in-error', 'unknown'], hint: 'unassigned | preparation | in-progress | completed | on-hold' },
      { name: 'outcome', type: 'text', hint: 'Outcome of the procedure (e.g., successful, incomplete)' },
      { name: 'performed', type: 'text', hint: 'Date/time or relative timing when performed' }
    ]
  },
  {
    id: 'fhir_immunizations',
    entityType: 'Immunization',
    displayName: 'FHIR Immunization',
    typeHint: 'Use ONLY and EXCLUSIVELY for active administration of preventative vaccines, immunization shots, or vaccine boosters (e.g. Influenza flu vaccine, Covid-19 vaccine, MMR booster, DTP vaccine, Tetanus shot, Hepatitis vaccine). CRITICAL NEGATIVE CONSTRAINTS: 1) Diseases, infections, or laboratory/serology blood test results (e.g. negative or positive Hepatitis B/C blood test, HIV test, covid illness) are NOT immunizations; they belong to DiagnosticReports/Observations or Conditions (with negative mention polarity / refuted verification status). 2) ALL therapeutic drugs, pain relievers, antipyretics (e.g. Paracetamol, Acetaminophen, Ibuprofen, Aspirin), antibiotics, daily prescriptions, and OTC medications are strictly Medications (FHIR MedicationStatement) and MUST NEVER be classified as Immunizations.',
    attributes: [
      { name: 'vaccine', type: 'text', hint: 'Vaccine product or drug name (e.g., Influenza vaccine)' },
      { name: 'status', type: 'select', choices: ['unassigned', 'completed', 'not-done', 'entered-in-error'], hint: 'unassigned | completed | not-done' },
      { name: 'occurrence', type: 'text', hint: 'Date/time administered or patient recollection' },
      { name: 'primarySource', type: 'select', choices: ['unassigned', 'true', 'false'], hint: 'unassigned | true | false' }
    ]
  },
  {
    id: 'fhir_familyHistory',
    entityType: 'FamilyMemberHistory',
    displayName: 'FHIR FamilyMemberHistory',
    typeHint: 'Use ONLY and EXCLUSIVELY for medical conditions, diseases, or chronic illnesses explicitly documented in the patient\'s biological or non-biological relatives (e.g. "father has PKD", "mother had type 2 diabetes", "sister has asthma"). CRITICAL NEGATIVE CONSTRAINT: Any condition, symptom, disease, or complaint experienced by the patient themselves MUST be classified under the patient\'s own Condition or Symptom categories. NEVER map the patient\'s own conditions or past medical history to FamilyMemberHistory!',
    attributes: [
      { name: 'condition', type: 'text', hint: 'The condition of the family member (e.g., Type 2 Diabetes)' },
      { name: 'relationship', type: 'select', choices: ['unassigned', 'father', 'mother', 'sibling', 'grandparent', 'child', 'unspecified'], hint: 'unassigned | father | mother | sibling | grandparent' },
      { name: 'status', type: 'select', choices: ['unassigned', 'confirmed', 'suspected', 'unspecified'], hint: 'unassigned | confirmed | suspected' },
      { name: 'onset', type: 'text', hint: 'Approximate age of onset for the relative' }
    ]
  },
  {
    id: 'fhir_diagnosticReports',
    entityType: 'DiagnosticReport',
    displayName: 'FHIR DiagnosticReport',
    typeHint: 'Use for comprehensive diagnostic summaries, laboratory panels, or full test result reports containing findings (e.g. Complete Blood Count report, Renal Function Panel, ECG report findings). Do NOT use for isolated vital signs or single individual measurements.',
    attributes: [
      { name: 'reportName', type: 'text', hint: 'Name/type of the report (e.g., Complete Blood Count, Renal Panel)' },
      { name: 'status', type: 'select', choices: ['unassigned', 'registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'], hint: 'unassigned | registered | partial | preliminary | final' },
      { name: 'conclusion', type: 'text', hint: 'Clinical summary/conclusion of the diagnostic report' },
      { name: 'issued', type: 'text', hint: 'Date/time the report was issued' }
    ]
  }
];

export interface Mention {
  id: string;
  segmentId?: string;
  textSpan: TextSpan;
  entityType: EntityType;
  entityId: string | null;
  speaker?: string;
  /** 0-based word index across concatenated segment texts, invariant to speaker/utterance splits */
  globalStartWord?: number;
  /** 0-based word index of the last word in the mention */
  globalEndWord?: number;
  polarity?: 'unassigned' | 'positive' | 'negative' | 'neutral' | string;
  certainty?: 'unassigned' | 'certain' | 'uncertain' | 'hypothetical' | string;
  temporality?: 'unassigned' | 'current' | 'past' | 'future' | string;
  experiencer?: 'unassigned' | 'patient' | 'family' | 'other' | string;
  function?: 'unassigned' | 'asserted' | 'questioned' | 'hypothetical' | 'explanatory' | string;
  /** The entity attribute this mention supports (e.g. "value" for "145", "severity" for "moderate", "dosage" for "20mg", "status", "onset") */
  supportedAttribute?: string;
  canonicalName?: string;
  description?: string;
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
  FHIR_ANNOTATION_SCHEMA.forEach(cat => {
    systemDefaultsMap.set(cat.id, cat);
    if (cat.id === 'fhir_socialStatus') {
      systemDefaultsMap.set('fhir_socialHistory', { ...cat, id: 'fhir_socialHistory' });
    }
  });

  return schema.map(cat => {
    const systemDefault = systemDefaultsMap.get(cat.id);
    if (systemDefault) {
      // Merge attributes so existing user sessions get updated options (like 'refuted', 'unassigned') and new attributes
      const existingAttrs = cat.attributes && cat.attributes.length > 0 ? cat.attributes.map(a => ({ ...a })) : [...systemDefault.attributes];
      
      // Ensure any default attribute (e.g. status) is present
      systemDefault.attributes.forEach(defAttr => {
        const found = existingAttrs.find(a => a.name.toLowerCase() === defAttr.name.toLowerCase());
        if (!found) {
          existingAttrs.push({ ...defAttr });
        } else if (defAttr.type === 'select' && defAttr.choices) {
          // Merge choices and ensure 'unassigned' / 'Unassigned' is present and placed first
          const rawChoices = Array.from(new Set([...defAttr.choices, ...(found.choices || [])]));
          const unassignedChoice = rawChoices.find(c => c.toLowerCase() === 'unassigned') || (defAttr.choices[0] && defAttr.choices[0].toLowerCase() === 'unassigned' ? defAttr.choices[0] : 'unassigned');
          const remainingChoices = rawChoices.filter(c => c.toLowerCase() !== 'unassigned');
          found.choices = [unassignedChoice, ...remainingChoices];
        }
      });

      // Ensure any remaining select attributes have unassigned option
      existingAttrs.forEach(attr => {
        if (attr.type === 'select' && attr.choices && attr.choices.length > 0) {
          const hasUnassigned = attr.choices.some(c => c.toLowerCase() === 'unassigned');
          if (!hasUnassigned) {
            const isMostlyLower = attr.choices.filter(c => c[0] === c[0].toLowerCase()).length >= attr.choices.length / 2;
            const unassignedOption = isMostlyLower ? 'unassigned' : 'Unassigned';
            attr.choices = [unassignedOption, ...attr.choices];
          }
        }
      });

      return {
        ...cat,
        entityType: systemDefault.entityType,
        typeHint: cat.typeHint && cat.typeHint.trim() !== '' ? cat.typeHint : systemDefault.typeHint,
        attributes: existingAttrs
      };
    }

    // For custom categories, ensure select attributes have unassigned option as well
    const customAttrs = cat.attributes?.map(attr => {
      if (attr.type === 'select' && attr.choices && attr.choices.length > 0) {
        const hasUnassigned = attr.choices.some(c => c.toLowerCase() === 'unassigned');
        if (!hasUnassigned) {
          const isMostlyLower = attr.choices.filter(c => c[0] === c[0].toLowerCase()).length >= attr.choices.length / 2;
          const unassignedOption = isMostlyLower ? 'unassigned' : 'Unassigned';
          return { ...attr, choices: [unassignedOption, ...attr.choices] };
        }
      }
      return attr;
    }) || [];

    return { ...cat, attributes: customAttrs };
  });
}

/**
 * Returns the primary identifying attribute for a category (e.g., 'title' for CarePlan,
 * 'task' for ServiceRequest, 'medication' for MedicationRequest, 'vaccine' for Immunization, 'name' for Condition).
 */
export function getPrimaryAttribute(cat?: AnnotationCategory | null): AnnotationAttribute {
  if (!cat || !cat.attributes || cat.attributes.length === 0) {
    return { name: 'name', type: 'text' };
  }
  const namingPriority = [
    'name', 'task', 'title', 'medication', 'vaccine', 'condition',
    'reportName', 'description', 'label'
  ];
  for (const key of namingPriority) {
    const found = cat.attributes.find(a => a.name.toLowerCase() === key.toLowerCase());
    if (found) return found;
  }
  const firstText = cat.attributes.find(a => a.type === 'text');
  return firstText || cat.attributes[0];
}

/**
 * Resolves the display name of a clinical note item or entity using the category's primary attribute.
 */
export function getItemDisplayName(
  item: any,
  cat?: AnnotationCategory | null,
  fallbackEntity?: Entity | null
): string {
  if (!item) return fallbackEntity?.name || '';
  const primaryAttr = getPrimaryAttribute(cat);
  const primaryVal = item[primaryAttr.name];
  if (primaryVal !== undefined && primaryVal !== null && String(primaryVal).trim() !== '') {
    return String(primaryVal).trim();
  }
  const namingPriority = ['name', 'task', 'title', 'medication', 'vaccine', 'condition', 'reportName', 'description'];
  for (const key of namingPriority) {
    const val = item[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val).trim();
    }
  }
  if (fallbackEntity?.name) return fallbackEntity.name;
  return `New ${cat?.displayName || 'Entity'}`;
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
      polarity: 'unassigned',
      certainty: 'unassigned',
      temporality: 'unassigned',
      experiencer: 'unassigned',
      function: 'unassigned',
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
        polarity: 'unassigned',
        certainty: 'unassigned',
        temporality: 'unassigned',
        experiencer: 'unassigned',
        function: 'unassigned'
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

  Object.keys(rawNotes).forEach(catKey => {
    if (!['symptoms', 'conditions', 'medications', 'followUps', 'measurements'].includes(catKey)) {
      const items = rawNotes[catKey] || [];
      remappedNotes[catKey] = items.map((item: any) => ({
        ...item,
        entityId: idMap[item.entityId] || item.entityId
      }));
    }
  });

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

