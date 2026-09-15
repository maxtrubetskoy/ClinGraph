import type { AnnotationAttribute, Entity, EntityAttribute } from '../types';
import { attributeIdFor } from './attributeIds';

export const OBSERVATION_RESULT_STATUSES = ['unassigned', 'registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'];
export const DIAGNOSTIC_ASSESSMENTS = ['unassigned', 'supported', 'suspected', 'not_suspected', 'absent', 'ruled_out', 'indeterminate'];
export const isObservationCategory = (id: string | undefined) =>
  ['fhir_symptoms', 'fhir_observations', 'fhir_socialStatus', 'fhir_socialHistory'].includes(id || '');

export function observationStatusAttribute(): AnnotationAttribute {
  return { name: 'status', displayName: 'Result status', type: 'select', choices: [...OBSERVATION_RESULT_STATUSES],
    hint: 'Result workflow only. Final does not mean present; a negative finding does not change workflow status.' };
}
export function diagnosticAssessmentAttribute(): AnnotationAttribute {
  return { name: 'diagnosticAssessment', displayName: 'Diagnostic assessment', type: 'select', choices: [...DIAGNOSTIC_ASSESSMENTS],
    hint: 'ClinGraph assessment, not a native FHIR field: supported = affirmed finding; absent = stated absence/denial; not_suspected is not ruled_out. Do not infer from workflow, severity, or unrelated negative text.' };
}

const code = (value: unknown): string | null => {
  if (value == null || (typeof value === 'string' && /^(|unassigned|unspecified)$/i.test(value.trim()))) return 'unassigned';
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
};

export function observationStatusReview(attribute: EntityAttribute): string | null {
  if (attribute.migration?.kind !== 'observation-status') return null;
  if (attribute.migration.review?.decision === 'retained-as-context' || attribute.migration.review?.decision === 'mapped-to-assessment') return null;
  if (attribute.name === 'diagnosticAssessment' && attribute.value !== 'legacy_refuted') return null;
  return 'Review legacy status: ' + JSON.stringify(attribute.migration.originalValue) +
    '. The previous status field mixed result workflow with clinical assessment; absence versus ruled-out was not distinguished. Source evidence is preserved.';
}

/** Keep old attribute IDs (and all mention targets) attached to their original clinical meaning. */
export function normalizeObservationStatus(entity: Entity, migrateLegacy: boolean, usedIds: Set<string>) {
  if (!isObservationCategory(entity.categoryId || entity.type)) return;
  const attributes = entity.attributes || (entity.attributes = []);
  const find = (name: string) => attributes.find(a => a.name.toLowerCase() === name.toLowerCase());
  const create = (name: string) => {
    const base = attributeIdFor(entity.id, name);
    let id = base, suffix = 1;
    while (usedIds.has(id)) id = base + ':' + suffix++;
    usedIds.add(id);
    const attribute: EntityAttribute = { id, name, value: 'unassigned' };
    attributes.push(attribute);
    return attribute;
  };
  let status = find('status');
  if (status && !OBSERVATION_RESULT_STATUSES.includes(code(status.value) || '')) {
    if (!migrateLegacy) throw new Error('Observation result status must describe workflow; use diagnosticAssessment for clinical findings');
    const originalValue = status.value, originalName = status.name;
    // Old refuted could mean a patient denial OR diagnostic exclusion. Never upgrade it to ruled_out.
    if (code(originalValue) === 'refuted' && !find('diagnosticAssessment')) {
      status.name = 'diagnosticAssessment';
      status.value = 'legacy_refuted';
    } else {
      // Do not overwrite a pre-existing assessment or discard unfamiliar legacy values.
      let name = 'legacyStatus', suffix = 1;
      while (find(name)) name = 'legacyStatus' + suffix++;
      status.name = name;
    }
    status.migration = { kind: 'observation-status', originalName, originalValue };
    status = undefined;
  }
  status ||= create('status');
  status.value = code(status.value);
  const assessment = find('diagnosticAssessment') || create('diagnosticAssessment');
  const assessmentCode = code(assessment.value);
  const preservedLegacy = assessmentCode === 'legacy_refuted' && assessment.migration?.kind === 'observation-status' &&
    code(assessment.migration.originalValue) === 'refuted';
  if (!preservedLegacy && !DIAGNOSTIC_ASSESSMENTS.includes(assessmentCode || '')) {
    // New assessments must be explicit; incompatible custom legacy fields remain readable for review.
    if (!migrateLegacy) throw new Error('Invalid diagnostic assessment');
    let name = 'legacyAssessment', suffix = 1;
    while (find(name)) name = 'legacyAssessment' + suffix++;
    assessment.migration = { kind: 'observation-status', originalName: assessment.name, originalValue: assessment.value };
    assessment.name = name;
    create('diagnosticAssessment');
  } else assessment.value = assessmentCode;
}
