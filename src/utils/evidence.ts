import { migrateToMentionsSchema, DEFAULT_ANNOTATION_SCHEMA, FHIR_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../types';
import type { AnnotationData, AnnotationCategory, ClinicalCategory, Entity, EntityAttribute, EvidenceTarget, Mention } from '../types';
import { normalizeTemporal, validateTemporalAnchors, isTemporalValue } from './temporal';
import { normalizeTrajectory, isTrajectoryValue } from './trajectory';
import type { TemporalValue } from './temporal';
import { normalizeObservationStatus } from './observationStatus';
import { attributeIdFor } from './attributeIds';
import { normalizeMentionContext } from './mentionContext';
import { getProcedureRelations, isProcedureReferenceValue, normalizeProcedureReferences, validateProcedureReferences } from './procedureReferences';
export { attributeIdFor } from './attributeIds';

export function getMentionAttribute(mention: Mention, entities: Entity[]): EntityAttribute | undefined {
  if (mention.target?.kind !== 'attribute') return undefined;
  const target = mention.target;
  return entities.find(e => e.id === target.entityId)?.attributes?.find(a => a.id === target.attributeId);
}

export function getMentionAttributeName(mention: Mention, entities: Entity[]): string {
  return getMentionAttribute(mention, entities)?.name || (!mention.target ? mention.supportedAttribute || '' : '');
}

export function isEntityEvidence(mention: Mention, entityId: string): boolean {
  return mention.target?.kind === 'entity' && mention.target.entityId === entityId;
}

export function sameEvidenceTarget(a: Mention, b: Mention): boolean {
  if (!a.target || !b.target || a.target.kind !== b.target.kind || a.target.entityId !== b.target.entityId) return false;
  return a.target.kind === 'entity' || (b.target.kind === 'attribute' && a.target.attributeId === b.target.attributeId);
}

export function retargetMention(mention: Mention, target: EvidenceTarget | null): Mention {
  const { supportedAttribute, ...rest } = mention;
  return { ...rest, target, entityId: target?.entityId ?? null };
}

const noteEntries = (notes: ClinicalCategory) => Object.entries(notes || {}).flatMap(([categoryId, items]) =>
  (Array.isArray(items) ? items : []).map(item => ({ categoryId, item })));

/** Convert legacy name hints into real references. Already-versioned attributes are authoritative. */
export function normalizeEvidence(annotation: AnnotationData, schema?: AnnotationCategory[]): AnnotationData {
  if (annotation.mentionContextVersion !== undefined && annotation.mentionContextVersion !== 1) {
    throw new Error('Unsupported mention context version');
  }
  if (annotation.observationStatusVersion !== undefined && annotation.observationStatusVersion !== 1) {
    throw new Error('Unsupported observation status version');
  }
  const legacy = annotation.evidenceVersion !== 2;
  if (!legacy && !Array.isArray(annotation.mentions)) throw new Error('Version 2 annotations require an explicit mentions array');
  const migrated = migrateToMentionsSchema(annotation);
  const rows = noteEntries(migrated.clinicalNotes);
  const entities = migrated.entities.map(entity => {
    const row = rows.find(({ item }) => item.entityId === entity.id);
    const attributes = (entity.attributes || []).map(a => {
      const { resolvedTime, resolvedComparisonTime, ...stored } = a as EntityAttribute & { resolvedTime?: unknown; resolvedComparisonTime?: unknown };
      return stored;
    });
    if (legacy && row) {
      for (const [name, value] of Object.entries(row.item)) {
        if (name === 'entityId') continue;
        const previous = attributes.find(a => a.name === name);
        if (previous) previous.value = value;
        else attributes.push({ id: attributeIdFor(entity.id, name), name, value });
      }
    }
    return { ...entity, categoryId: entity.categoryId || row?.categoryId, attributes };
  });
  const entityMap = new Map(entities.map(e => [e.id, e]));
  const mentions = (migrated.mentions || []).map(mention => {
    if (mention.target !== undefined) return retargetMention(mention, mention.target);
    if (!legacy) throw new Error(`Mention ${mention.id} has no evidence target`);
    const owner = mention.entityId ? entityMap.get(mention.entityId) : undefined;
    if (!owner) return retargetMention(mention, null);
    if (mention.supportedAttribute?.trim()) {
      const name = mention.supportedAttribute.trim();
      let attribute = owner.attributes.find(a => a.name.toLowerCase() === name.toLowerCase());
      if (!attribute) {
        attribute = { id: attributeIdFor(owner.id, name), name, value: null };
        owner.attributes.push(attribute);
      }
      return retargetMention(mention, { kind: 'attribute', entityId: owner.id, attributeId: attribute.id });
    }
    return retargetMention(mention, { kind: 'entity', entityId: owner.id });
  }).map(normalizeMentionContext);
  // Reject dangling evidence before adding schema slots; do not silently recreate a deleted target.
  validateEvidence({ ...annotation, entities, mentions });
  const usedIds = new Set(entities.flatMap(entity => entity.attributes.map(attribute => attribute.id)));
  entities.forEach(entity => normalizeObservationStatus(entity, annotation.observationStatusVersion !== 1, usedIds));
  // Materialize structured slots even on existing records, so evidence can target an unassigned field.
  const categories = normalizeAnnotationSchema(schema || [...DEFAULT_ANNOTATION_SCHEMA, ...FHIR_ANNOTATION_SCHEMA]);
  for (const entity of entities) {
    const category = categories.find(c => c.id === (entity.categoryId || entity.type));
    for (const definition of category?.attributes || []) {
      if (definition.type !== 'temporal' && definition.type !== 'trajectory' && definition.type !== 'procedure-reference') continue;
      let attribute = entity.attributes.find(a => a.name.toLowerCase() === definition.name.toLowerCase());
      if (!attribute) {
        attribute = { id: attributeIdFor(entity.id, definition.name), name: definition.name, value: null };
        entity.attributes.push(attribute);
      }
      attribute.valueType = definition.type;
      if (definition.type === 'procedure-reference') attribute.name = definition.name;
      attribute.temporalMode = definition.temporalMode;
    }
    for (const attribute of entity.attributes) {
      if (attribute.valueType === 'procedure-reference' || isProcedureReferenceValue(attribute.value)) {
        attribute.valueType = 'procedure-reference';
        delete attribute.temporalMode;
        attribute.value = normalizeProcedureReferences(attribute.value);
        continue;
      }
      if (attribute.valueType === 'trajectory' || (!attribute.valueType && isTrajectoryValue(attribute.value))) {
        attribute.valueType = 'trajectory';
        delete attribute.temporalMode;
        attribute.value = normalizeTrajectory(attribute.value);
        continue;
      }
      if (attribute.valueType !== 'temporal' && !isTemporalValue(attribute.value)) continue;
      attribute.valueType = 'temporal';
      attribute.value = normalizeTemporal(attribute.value);
      const value = attribute.value;
      if (isTemporalValue(value) && value.kind !== 'text' && (
        (attribute.temporalMode === 'duration' && value.kind !== 'duration') ||
        (attribute.temporalMode === 'event' && value.kind === 'duration')
      )) throw new Error('Duration and event timing must be annotated separately');
    }
  }
  const result: AnnotationData = { ...annotation, evidenceVersion: 2, observationStatusVersion: 1, mentionContextVersion: 1, entities, mentions,
    relations: migrated.relations, clinicalNotes: migrated.clinicalNotes };
  validateEvidence(result);
  validateProcedureReferences(entities);
  validateTemporalAnchors(entities, entities.flatMap(entity => entity.attributes.flatMap(attribute =>
    isTrajectoryValue(attribute.value) ? [attribute.value.comparedTo] : [])));
  // Legacy representative spans must never turn attribute evidence into entity evidence.
  for (const entity of entities) {
    const direct = mentions.find(m => isEntityEvidence(m, entity.id));
    if (direct) entity.textSpan = direct.textSpan;
    else delete entity.textSpan;
  }
  result.clinicalNotes = projectClinicalNotes(result);
  return result;
}

/** Adapter for the existing schema forms: edits update attribute values without changing IDs. */
export function reconcileEvidenceWithNotes(annotation: AnnotationData, schema?: AnnotationCategory[]): AnnotationData {
  const rows = noteEntries(annotation.clinicalNotes);
  const entities = annotation.entities.map(entity => {
    const row = rows.find(({ item }) => item.entityId === entity.id);
    const attributes = (entity.attributes || []).map(a => ({ ...a }));
    if (row) {
      for (const [name, value] of Object.entries(row.item)) {
        if (name === 'entityId') continue;
        const attribute = attributes.find(a => a.name === name);
        if (attribute) attribute.value = value;
        else attributes.push({ id: attributeIdFor(entity.id, name), name, value });
      }
    }
    return { ...entity, categoryId: entity.categoryId || row?.categoryId, attributes };
  });
  return normalizeEvidence({ ...annotation, entities }, schema);
}

/** Clinical notes remain a compatibility projection of the actual attribute nodes. */
function projectClinicalNotes(annotation: AnnotationData): ClinicalCategory {
  const notes = Object.fromEntries(Object.entries(annotation.clinicalNotes || {}).map(([key, items]) =>
    [key, Array.isArray(items) ? items.map(item => ({ ...item })) : []])) as ClinicalCategory;
  for (const entity of annotation.entities) {
    if (!entity.categoryId) continue;
    const items = notes[entity.categoryId] || (notes[entity.categoryId] = []);
    const index = items.findIndex(item => item.entityId === entity.id);
    const row = { entityId: entity.id, ...Object.fromEntries((entity.attributes || []).map(a => [a.name, a.value])) };
    if (index >= 0) items[index] = row;
    else items.push(row);
  }
  return notes;
}

export function validateEvidence(annotation: AnnotationData) {
  const entityIds = new Set<string>();
  const attributeOwners = new Map<string, string>();
  for (const entity of annotation.entities) {
    if (typeof entity.id !== 'string' || !entity.id || entityIds.has(entity.id)) throw new Error('Entity IDs must be unique');
    entityIds.add(entity.id);
    const names = new Set<string>();
    if (entity.attributes !== undefined && !Array.isArray(entity.attributes)) throw new Error('Attributes must be an array');
    for (const attribute of entity.attributes || []) {
      if (typeof attribute.id !== 'string' || !attribute.id || typeof attribute.name !== 'string' || !attribute.name.trim() || attribute.name === 'entityId' ||
          names.has(attribute.name) || attributeOwners.has(attribute.id)) throw new Error('Attribute IDs and names must be unique');
      names.add(attribute.name);
      attributeOwners.set(attribute.id, entity.id);
    }
  }
  const mentionIds = new Set<string>();
  for (const mention of annotation.mentions || []) {
    if (typeof mention.id !== 'string' || !mention.id || mentionIds.has(mention.id)) throw new Error('Mention IDs must be unique');
    mentionIds.add(mention.id);
    const target = mention.target;
    if (target === null) continue;
    if (!target || !['entity', 'attribute'].includes(target.kind) || !entityIds.has(target.entityId)) {
      throw new Error(`Mention ${mention.id} references a missing entity`);
    }
    if (target.kind === 'attribute' && attributeOwners.get(target.attributeId) !== target.entityId) {
      throw new Error(`Mention ${mention.id} references a missing attribute or an attribute owned by another entity`);
    }
  }
}

export interface EvidenceGraphNode {
  id: string;
  kind: 'patient' | 'encounter' | 'entity' | 'attribute' | 'mention';
  label: string;
  entityId?: string;
  attributeId?: string;
  mentionId?: string;
  evidenceRole?: Mention['evidenceRole'];
  polarity?: string;
  temporality?: string;
  certainty?: string;
  function?: string;
  value?: unknown;
}
export interface EvidenceGraphEdge { source: string; target: string; type: 'HAS_ENCOUNTER' | 'HAS_ENTITY' | 'HAS_ATTRIBUTE' | 'EVIDENCED_BY' | 'PART_OF'; attributeId?: string }

/** A patient context is case-local until the application has explicit patient identities. */
export function buildEvidenceGraph(sessionId: string, title: string, annotation: AnnotationData, encounterTime?: TemporalValue | null) {
  const prefix = encodeURIComponent(sessionId);
  const nodeId = (kind: string, id: string) => `${prefix}:${kind}:${encodeURIComponent(id)}`;
  const patientId = nodeId('patient', 'case');
  const encounterId = nodeId('encounter', sessionId);
  const nodes: EvidenceGraphNode[] = [
    { id: patientId, kind: 'patient', label: 'Patient (this case)' },
    { id: encounterId, kind: 'encounter', label: title, ...(encounterTime ? { value: encounterTime } : {}) },
  ];
  const edges: EvidenceGraphEdge[] = [{ source: patientId, target: encounterId, type: 'HAS_ENCOUNTER' }];
  for (const entity of annotation.entities) {
    const id = nodeId('entity', entity.id);
    nodes.push({ id, kind: 'entity', label: entity.name, entityId: entity.id });
    edges.push({ source: encounterId, target: id, type: 'HAS_ENTITY' });
    for (const attribute of entity.attributes || []) {
      const attributeId = nodeId('attribute', attribute.id);
      nodes.push({ id: attributeId, kind: 'attribute', label: attribute.name, value: attribute.value, entityId: entity.id, attributeId: attribute.id });
      edges.push({ source: id, target: attributeId, type: 'HAS_ATTRIBUTE' });
    }
  }
  for (const relation of getProcedureRelations(annotation.entities)) {
    edges.push({ source: nodeId('entity', relation.source), target: nodeId('entity', relation.target),
      type: 'PART_OF', attributeId: relation.attributeId });
  }
  for (const mention of annotation.mentions || []) {
    const id = nodeId('mention', mention.id);
    const context = normalizeMentionContext(mention);
    nodes.push({ id, kind: 'mention', label: mention.textSpan.text, mentionId: mention.id, entityId: mention.target?.entityId,
      evidenceRole: context.evidenceRole, polarity: context.polarity, temporality: context.temporality,
      certainty: context.certainty, function: context.function });
    if (!mention.target) continue;
    const source = mention.target.kind === 'entity'
      ? nodeId('entity', mention.target.entityId) : nodeId('attribute', mention.target.attributeId);
    edges.push({ source, target: id, type: 'EVIDENCED_BY' });
  }
  return { nodes, edges };
}
