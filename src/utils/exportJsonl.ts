import type { Entity, Mention, Relation, Conversation, ClinicalCategory } from '../types';
import { normalizeEvidence, getMentionAttribute, buildEvidenceGraph } from './evidence';
import { isTemporalValue, resolveTemporal } from './temporal';
import { isTrajectoryValue } from './trajectory';
import { getProcedureRelations } from './procedureReferences';

export type JsonlExportType = 'entities_mentions' | 'mentions' | 'full_dataset' | 'relations';

const exportMention = (mention: Mention) => ({
  ...mention,
  speaker: mention.speaker || null,
  polarity: mention.polarity || 'unassigned',
  certainty: mention.certainty || 'unassigned',
  temporality: mention.temporality || 'unassigned',
  experiencer: mention.experiencer || 'unassigned',
  function: mention.function || 'unassigned'
});

export function generateJsonlContent(
  type: JsonlExportType,
  session?: Partial<Conversation> | null,
  entities: Entity[] = [],
  mentions: Mention[] = [],
  relations: Relation[] = [],
  clinicalNotes?: ClinicalCategory
): string {
  const annotation = normalizeEvidence({
    ...session?.annotation,
    entities, mentions, relations,
    clinicalNotes: clinicalNotes || session?.annotation?.clinicalNotes || { symptoms: [], medications: [], followUps: [] }
  }, session?.schemaSnapshot?.categories);
  const normalizedMentions = annotation.mentions || [];
  const temporalContext = { encounterTime: session?.encounterTime, entities: annotation.entities };
  const exportAttribute = (attribute: NonNullable<Entity['attributes']>[number]) => ({
    ...attribute,
    ...(isTemporalValue(attribute.value) ? { resolvedTime: resolveTemporal(attribute.value, temporalContext) } : {}),
    ...(isTrajectoryValue(attribute.value) ? { resolvedComparisonTime: resolveTemporal(attribute.value.comparedTo, temporalContext) } : {})
  });
  const timeContext = { mentionContextVersion: annotation.mentionContextVersion, observationStatusVersion: annotation.observationStatusVersion, temporalVersion: 1, trajectoryVersion: 1, encounterTime: session?.encounterTime || null };
  const entityMap = new Map(annotation.entities.map(entity => [entity.id, entity]));
  const byTarget = new Map<string, Mention[]>();
  for (const mention of normalizedMentions) {
    if (!mention.target) continue;
    const key = mention.target.kind === 'attribute' ? 'attribute:' + mention.target.attributeId : 'entity:' + mention.target.entityId;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key)!.push(mention);
  }
  const directMentions = (id: string) => (byTarget.get('entity:' + id) || []).map(exportMention);

  if (type === 'entities_mentions') {
    return annotation.entities.map(entity => JSON.stringify({
      evidenceVersion: 2,
      ...timeContext,
      ...entity,
      mentionsCount: directMentions(entity.id).length,
      mentions: directMentions(entity.id),
      attributes: (entity.attributes || []).map(attribute => ({
        ...exportAttribute(attribute),
        mentions: (byTarget.get('attribute:' + attribute.id) || []).map(exportMention)
      }))
    })).join('\n');
  }
  if (type === 'mentions') {
    return normalizedMentions.map(mention => {
      const owner = entityMap.get(mention.entityId || '');
      return JSON.stringify({
        evidenceVersion: 2,
        ...timeContext,
        ...exportMention(mention),
        entityName: owner?.name || '',
        entityType: mention.entityType || owner?.type || 'Unknown',
        attribute: getMentionAttribute(mention, annotation.entities) ? exportAttribute(getMentionAttribute(mention, annotation.entities)!) : null,
        umlsMapping: owner?.umlsMapping || null
      });
    }).join('\n');
  }
  if (type === 'relations') {
    return [...annotation.relations, ...getProcedureRelations(annotation.entities)].map(relation => JSON.stringify({
      id: relation.id, relationType: relation.type,
      ...('derivedFrom' in relation && 'attributeId' in relation ? { derivedFrom: relation.derivedFrom, attributeId: relation.attributeId } : {}),
      sourceEntityId: relation.source,
      sourceEntityName: entityMap.get(relation.source)?.name || 'Unknown',
      sourceEntityType: entityMap.get(relation.source)?.type || 'Unknown',
      targetEntityId: relation.target,
      targetEntityName: entityMap.get(relation.target)?.name || 'Unknown',
      targetEntityType: entityMap.get(relation.target)?.type || 'Unknown'
    })).join('\n');
  }
  const sessionId = session?.id || 'session_export';
  const title = session?.title || 'Clinical Encounter';
  return JSON.stringify({
    sessionId, title,
    ...(session?.schemaSnapshot ? { schemaSnapshot: session.schemaSnapshot } : {}),
    ...(session?.restoredFrom ? { restoredFrom: session.restoredFrom } : {}),
    ...timeContext,
    encounterType: session?.encounterType || 'dialogue',
    createdAt: session?.createdAt || new Date().toISOString(),
    rawTranscript: session?.rawTranscript || '',
    transcriptSegments: session?.transcriptSegments || [],
    ...annotation,
    entities: annotation.entities.map(entity => ({ ...entity, attributes: (entity.attributes || []).map(exportAttribute) })),
    evidenceGraph: buildEvidenceGraph(sessionId, title, annotation, session?.encounterTime)
  });
}

export function downloadJsonlFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'application/x-jsonlines;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.jsonl') ? filename : `${filename}.jsonl`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
