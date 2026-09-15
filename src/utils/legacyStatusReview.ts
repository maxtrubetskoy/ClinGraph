import type { AnnotationData, AnnotationCategory } from '../types';
import { normalizeEvidence, retargetMention } from './evidence';
import { DIAGNOSTIC_ASSESSMENTS, observationStatusReview } from './observationStatus';

export type LegacyStatusResolution = { kind: 'keep-context' } | { kind: 'assessment'; value: string };

/** Explicit human review. Preserve the original node and value; only move evidence
 * when the reviewer deliberately maps it to the current diagnostic assessment.
 */
export function resolveLegacyStatus(annotation: AnnotationData, entityId: string, attributeId: string,
  resolution: LegacyStatusResolution, schema?: AnnotationCategory[]): AnnotationData {
  const result = normalizeEvidence(annotation, schema);
  const entity = result.entities.find(e => e.id === entityId);
  const source = entity?.attributes?.find(a => a.id === attributeId);
  if (!source?.migration || !observationStatusReview(source)) throw new Error('This legacy attribute has no pending review');
  const assessment = entity.attributes.find(a => a.name.toLowerCase() === 'diagnosticassessment');
  if (resolution.kind === 'keep-context') {
    if (source === assessment) throw new Error('Choose an assessment, or unassigned if the evidence is insufficient');
    source.migration = { ...source.migration, review: { decision: 'retained-as-context' } };
  } else if (resolution.kind === 'assessment') {
    if (!DIAGNOSTIC_ASSESSMENTS.includes(resolution.value)) throw new Error('Choose a valid diagnostic assessment');
    if (!assessment) throw new Error('No diagnostic assessment attribute is available for this entity');
    const previousAssessmentValue = assessment.value;
    const movedMentionIds: string[] = [];
    if (source !== assessment) result.mentions = result.mentions.map(mention => {
      if (mention.target?.kind !== 'attribute' || mention.target.entityId !== entityId || mention.target.attributeId !== source.id) return mention;
      movedMentionIds.push(mention.id);
      return retargetMention(mention, { kind: 'attribute', entityId, attributeId: assessment.id });
    });
    assessment.value = resolution.value;
    source.migration = { ...source.migration, review: { decision: 'mapped-to-assessment',
      assessmentAttributeId: assessment.id, assessmentValue: resolution.value, previousAssessmentValue, movedMentionIds } };
  } else throw new Error('Choose how to resolve the legacy status');
  // Re-project notes from canonical attributes so the form adapter cannot restore a stale assessment.
  return normalizeEvidence(result, schema);
}
