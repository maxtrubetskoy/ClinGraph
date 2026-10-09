import type { AnnotationAttribute, AnnotationCategory, AnnotationData, Entity, EntityAttribute, EvidenceTarget, MappingIssue, Mention } from '../src/types';
import { getPrimaryAttribute } from '../src/types';
import { attributeIdFor, normalizeEvidence, retargetMention } from '../src/utils/evidence';
import { isTemporalValue, normalizeTemporal } from '../src/utils/temporal';
import { isTrajectoryValue, normalizeTrajectory, TRAJECTORY_DIRECTIONS } from '../src/utils/trajectory';

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceText = (value: unknown) => record(value) && typeof value.text === 'string' ? value.text : null;
const unresolvedTime = (value: unknown) => normalizeTemporal(sourceText(value));
const aliases: Record<string, string[]> = {
  clinicalstatus: ['clinical_status', 'conditionstatus'], verificationstatus: ['verification_status'],
  severity: ['intensity', 'grade'], details: ['description', 'notes', 'comment', 'note'],
  description: ['details', 'notes', 'comment', 'note'],
  name: ['title', 'task', 'medication', 'vaccine', 'condition', 'reportName'],
  task: ['name', 'title'], title: ['name', 'task'], value: ['result', 'measurement', 'val'],
  dosage: ['dose', 'amount'], action: ['plan', 'instruction']
};

function normalizeField(value: unknown, definition: AnnotationAttribute): unknown {
  if (definition.type === 'temporal') {
    const time = normalizeTemporal(value);
    if (time && time.kind !== 'text' && (
      (definition.temporalMode === 'duration' && time.kind !== 'duration') ||
      (definition.temporalMode === 'event' && time.kind === 'duration')
    )) throw new Error('Duration and event timing must be annotated separately');
    return time;
  }
  if (definition.type === 'trajectory') return normalizeTrajectory(value);
  if (value == null || value === '') return definition.type === 'select'
    ? definition.choices?.find(c => c.toLowerCase() === 'unassigned') ?? null : null;
  if (definition.type === 'procedure-reference') throw new Error('Procedure links require review after entities are mapped');
  if (definition.type === 'select' && definition.choices?.length) {
    const choice = typeof value === 'string' && definition.choices.find(c => c.toLowerCase() === value.trim().toLowerCase());
    if (!choice) throw new Error('Value is not an allowed choice');
    return choice;
  }
  if (definition.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Expected a number');
  if (definition.type === 'boolean' && typeof value !== 'boolean') throw new Error('Expected true or false');
  if (['text', 'textarea', 'select'].includes(definition.type) && typeof value !== 'string') throw new Error('Expected text');
  return value;
}

/** Keep explicit wording and any valid comparison direction; never guess a date or assessment. */
function recoverField(value: unknown, definition: AnnotationAttribute): unknown {
  if (definition.type === 'temporal') return unresolvedTime(value);
  if (definition.type === 'trajectory' && record(value)) {
    let comparedTo = null;
    try { comparedTo = normalizeField(value.comparedTo, { name: 'comparedTo', type: 'temporal', temporalMode: 'event' }); }
    catch { comparedTo = unresolvedTime(value.comparedTo); }
    return normalizeTrajectory({ type: 'trajectory',
      direction: TRAJECTORY_DIRECTIONS.includes(value.direction) ? value.direction : 'unassigned',
      comparedTo, ...(sourceText(value) ? { text: sourceText(value) } : {}) });
  }
  return definition.type === 'select' ? definition.choices?.find(c => c.toLowerCase() === 'unassigned') ?? null : null;
}

/** Tolerant only at the AI boundary. The result still passes strict evidence/storage validation. */
export function processEntityMapping(raw: unknown, extractedMentions: Mention[], schema: AnnotationCategory[]): AnnotationData & { title: string } {
  if (!record(raw) || !Array.isArray(raw.entities)) throw new Error('The AI provider returned invalid entity clusters');
  const mappingIssues: MappingIssue[] = [];
  const entities: Entity[] = [];
  const mentionMap = new Map(extractedMentions.map(m => [m.id, m]));
  const assignments = new Map<string, EvidenceTarget>();
  const conflicts = new Set<string>();
  const originalValues = new Map<string, unknown>();

  raw.entities.forEach((entry: unknown, index: number) => {
    const category = record(entry) && typeof entry.type === 'string'
      ? schema.find(c => c.id.toLowerCase() === entry.type.toLowerCase()) ||
        schema.find(c => c.entityType.toLowerCase() === entry.type.toLowerCase()) : undefined;
    if (!record(entry) || typeof entry.name !== 'string' || !entry.name.trim() || !category) {
      mappingIssues.push({ code: 'invalid_entity', message: `Entity ${index + 1} has an invalid name or category and was skipped.`, originalValue: entry });
      return;
    }
    const entity: Entity = { id: `e${index + 1}`, name: entry.name.trim(), type: category.id, categoryId: category.id, attributes: [],
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}) };
    entities.push(entity);
    const issue = (message: string, originalValue: unknown, attributeName?: string) => mappingIssues.push({
      code: 'invalid_attribute', entityId: entity.id, entityName: entity.name, attributeName, message, originalValue
    });
    const values = record(entry.attributes) ? entry.attributes : {};
    if (entry.attributes != null && !record(entry.attributes)) issue('Invalid attributes were left unassigned.', entry.attributes);
    const consumed = new Set<string>();
    const primary = getPrimaryAttribute(category).name;
    for (const definition of category.attributes) {
      if (!definition.name.trim() || definition.name === 'entityId') continue;
      // Timing roles and structured fields are never aliases of each other.
      const names = [definition.name, ...(['temporal', 'trajectory', 'procedure-reference'].includes(definition.type)
        ? [] : Object.hasOwn(aliases, definition.name.toLowerCase()) ? aliases[definition.name.toLowerCase()] : [])];
      const key = names.map(name => Object.keys(values).find(k => k.toLowerCase() === name.toLowerCase()))
        .find(k => k !== undefined && values[k] != null && values[k] !== '');
      if (key !== undefined) consumed.add(key);
      const original = key === undefined ? (definition.name === primary ? entity.name : null) : values[key];
      let value;
      try { value = normalizeField(original, definition); }
      catch (error) {
        value = recoverField(original, definition);
        issue(`${(error as Error).message}. Preserved source wording where available; review this field.`, original, definition.name);
      }
      const attribute: EntityAttribute = { id: attributeIdFor(entity.id, definition.name), name: definition.name, value };
      if (['temporal', 'trajectory', 'procedure-reference'].includes(definition.type)) {
        attribute.valueType = definition.type as EntityAttribute['valueType'];
        attribute.temporalMode = definition.temporalMode;
      }
      entity.attributes!.push(attribute);
      originalValues.set(attribute.id, original);
    }
    for (const [name, value] of Object.entries(values)) {
      if (!consumed.has(name) && value != null && value !== '') issue('Unknown or redundant attribute was retained in this review report.', value, name);
    }

    const attach = (ids: unknown, field?: string) => {
      if (ids == null) return;
      const list = Array.isArray(ids) ? ids : [ids];
      for (const id of list) {
        const mention = typeof id === 'string' ? mentionMap.get(id.trim()) : undefined;
        const name = field ?? mention?.supportedAttribute;
        const attribute = name ? entity.attributes!.find(a => a.name.toLowerCase() === name.trim().toLowerCase()) : undefined;
        if (!mention || (field !== undefined && !field.trim()) || (name && !attribute)) {
          mappingIssues.push({ code: 'invalid_assignment', entityId: entity.id, entityName: entity.name,
            ...(mention ? { mentionId: mention.id } : {}), attributeName: name,
            message: !mention ? 'Ignored an assignment to an unknown mention.' : 'Unknown evidence field; this assignment was ignored.', originalValue: id });
          continue;
        }
        const target: EvidenceTarget = attribute ? { kind: 'attribute', entityId: entity.id, attributeId: attribute.id }
          : { kind: 'entity', entityId: entity.id };
        const previous = assignments.get(mention.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(target)) conflicts.add(mention.id);
        else assignments.set(mention.id, target);
      }
    };
    attach(entry.mentionIds);
    if (record(entry.attributeMentionIds)) {
      Object.entries(entry.attributeMentionIds).forEach(([name, ids]) => attach(ids, name));
    } else if (entry.attributeMentionIds != null) {
      mappingIssues.push({ code: 'invalid_assignment', entityId: entity.id, entityName: entity.name,
        message: 'Invalid attribute assignments were ignored.', originalValue: entry.attributeMentionIds });
    }
  });

  // Validate each chain independently so an invalid anchor/cycle cannot poison unrelated fields.
  const attributes = new Map(entities.flatMap(entity => entity.attributes!.map(attribute => [attribute.id, { entity, attribute }] as const)));
  const anchorError = (value: unknown, visiting = new Set<string>()): string | null => {
    if (!isTemporalValue(value) || value.kind !== 'relative' || value.anchor.kind !== 'attribute') return null;
    const target = attributes.get(value.anchor.attributeId);
    if (!target || target.entity.id !== value.anchor.entityId || target.attribute.valueType !== 'temporal' ||
      target.attribute.temporalMode === 'duration' || (isTemporalValue(target.attribute.value) && target.attribute.value.kind === 'duration')) {
      return 'Temporal anchor references a missing or non-event temporal attribute';
    }
    if (visiting.has(target.attribute.id)) return 'Temporal anchors cannot form a cycle';
    return anchorError(target.attribute.value, new Set([...visiting, target.attribute.id]));
  };
  const invalidAnchors = [...attributes.values()].flatMap(({ entity, attribute }) => {
    const value = isTrajectoryValue(attribute.value) ? attribute.value.comparedTo : attribute.value;
    const error = anchorError(value);
    return error ? [{ entity, attribute, value, error }] : [];
  });
  for (const { entity, attribute, value, error } of invalidAnchors) {
    mappingIssues.push({ code: 'invalid_attribute', entityId: entity.id, entityName: entity.name, attributeName: attribute.name,
      message: `${error}. Timing was left unresolved.`, originalValue: originalValues.get(attribute.id) });
    attribute.value = isTrajectoryValue(attribute.value)
      ? { ...attribute.value, comparedTo: unresolvedTime(value) } : unresolvedTime(value);
  }

  const mentions = extractedMentions.map(mention => {
    const target = conflicts.has(mention.id) ? null : assignments.get(mention.id) ?? null;
    if (!target) mappingIssues.push({ code: conflicts.has(mention.id) ? 'conflicting_assignment' : 'unmapped_mention', mentionId: mention.id,
      message: conflicts.has(mention.id) ? 'Conflicting assignments; mention kept unlinked for review.' : 'No entity was mapped; mention kept unlinked for review.' });
    return retargetMention(mention, target);
  });
  return { title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Annotated Clinical Consultation',
    ...normalizeEvidence({ evidenceVersion: 2, mentionContextVersion: 1, observationStatusVersion: 1,
      entities, mentions, relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] }, mappingIssues }, schema) };
}
