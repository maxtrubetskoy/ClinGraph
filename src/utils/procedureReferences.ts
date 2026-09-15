import type { AnnotationAttribute, AnnotationData, Entity, Relation } from '../types';

export interface ProcedureReferenceValue {
  type: 'procedure-reference';
  procedureIds: string[];
}

export const partOfAttribute = (): AnnotationAttribute => ({
  name: 'partOf', displayName: 'Part of procedure', type: 'procedure-reference',
  hint: 'Procedure events that produced this measurement. Link only when supported by the source.'
});

// Older AI annotations store the schema category ID as the entity type.
export const isProcedureEntity = (entity?: Entity): boolean =>
  entity?.type === 'Procedure' || entity?.type === 'fhir_procedures';

export function isProcedureReferenceValue(value: unknown): value is ProcedureReferenceValue {
  return !!value && typeof value === 'object' && (value as ProcedureReferenceValue).type === 'procedure-reference';
}

export function normalizeProcedureReferences(value: unknown): ProcedureReferenceValue | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isProcedureReferenceValue(value) || !Array.isArray(value.procedureIds) ||
      value.procedureIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(value.procedureIds).size !== value.procedureIds.length) {
    throw new Error('Part of procedure requires unique procedure IDs');
  }
  return value.procedureIds.length ? { type: 'procedure-reference', procedureIds: [...value.procedureIds] } : null;
}

export function validateProcedureReferences(entities: Entity[]) {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  for (const entity of entities) {
    for (const attribute of entity.attributes || []) {
      if (attribute.valueType !== 'procedure-reference' && !isProcedureReferenceValue(attribute.value)) continue;
      if (attribute.name !== 'partOf' || !(['Measurement', 'measurements', 'fhir_observations'].includes(entity.type) ||
          (entity.type === 'Observation' && entity.categoryId === 'fhir_observations'))) {
        throw new Error('Part of procedure is a measurement attribute');
      }
      const value = normalizeProcedureReferences(attribute.value);
      for (const id of value?.procedureIds || []) {
        if (id === entity.id || !isProcedureEntity(byId.get(id))) {
          throw new Error(`Part of procedure references a missing or non-procedure entity: ${id}`);
        }
      }
    }
  }
}

export type ProcedureRelation = Relation & { attributeId: string; derivedFrom: 'partOf' };

/** Derived edges share the attribute's evidence; the attribute remains the source of truth. */
export function getProcedureRelations(entities: Entity[]): ProcedureRelation[] {
  return entities.flatMap(entity => (entity.attributes || []).flatMap(attribute => {
    if (attribute.name !== 'partOf' || !isProcedureReferenceValue(attribute.value)) return [];
    return attribute.value.procedureIds.map(target => ({
      id: `partOf:${encodeURIComponent(attribute.id)}:${encodeURIComponent(target)}`,
      source: entity.id, target, type: 'PART_OF', attributeId: attribute.id, derivedFrom: 'partOf' as const
    }));
  }));
}

/** Explicit UI deletion unlinks references, retaining the attribute ID and its text evidence. */
export function unlinkDeletedProcedures(annotation: AnnotationData, deletedIds: Set<string>): AnnotationData {
  const prune = (value: unknown) => {
    if (!isProcedureReferenceValue(value)) return value;
    return normalizeProcedureReferences({ ...value, procedureIds: value.procedureIds.filter(id => !deletedIds.has(id)) });
  };
  return {
    ...annotation,
    entities: annotation.entities.map(entity => ({ ...entity,
      attributes: entity.attributes?.map(attribute => ({ ...attribute, value: prune(attribute.value) }))
    })),
    clinicalNotes: Object.fromEntries(Object.entries(annotation.clinicalNotes).map(([category, rows]) =>
      [category, rows?.map(row => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, prune(value)])))])) as AnnotationData['clinicalNotes']
  };
}
