import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FHIR_ANNOTATION_SCHEMA, DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema, type AnnotationData } from '../src/types';
import { normalizeEvidence, reconcileEvidenceWithNotes, buildEvidenceGraph } from '../src/utils/evidence';
import { getProcedureRelations, unlinkDeletedProcedures } from '../src/utils/procedureReferences';
import { formatAttributeValue } from '../src/utils/attributeValues';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { LocalDatabase, StorageError } from '../server/database';

const reference = (...procedureIds: string[]) => ({ type: 'procedure-reference' as const, procedureIds });
const fixture = (): AnnotationData => ({
  evidenceVersion: 2, entities: [
    { id: 'volume', name: 'Total kidney volume', type: 'Observation', categoryId: 'fhir_observations', attributes: [
      { id: 'volume-value', name: 'value', value: 'about 2300 mL' },
      { id: 'volume-procedure', name: 'partOf', value: reference('scan') }
    ] },
    { id: 'scan', name: 'Ultrasound', type: 'Procedure', categoryId: 'fhir_procedures', attributes: [
      { id: 'scan-time', name: 'performed', value: 'about two months ago' }
    ] },
    { id: 'scan2', name: 'Repeat ultrasound', type: 'Procedure', categoryId: 'fhir_procedures', attributes: [] }
  ], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] },
  mentions: [{ id: 'evidence', entityId: 'volume', entityType: 'Observation', evidenceRole: 'claim', certainty: 'uncertain', function: 'asserted',
    target: { kind: 'attribute', entityId: 'volume', attributeId: 'volume-procedure' },
    textSpan: { lineIndex: 0, startChar: 0, endChar: 10, text: 'on the scan' } }]
});
const partOf = (data: AnnotationData) => data.entities[0].attributes!.find(attribute => attribute.name === 'partOf')!;

test('measurement slots migrate saved schemas without inference or changing identities and evidence', () => {
  for (const [schema, id] of [[DEFAULT_ANNOTATION_SCHEMA, 'measurements'], [FHIR_ANNOTATION_SCHEMA, 'fhir_observations']] as const) {
    const old = schema.map(category => ({ ...category, attributes: category.attributes.filter(attribute => attribute.name !== 'partOf') }));
    assert.equal(normalizeAnnotationSchema(old).find(category => category.id === id)!.attributes.find(attribute => attribute.name === 'partOf')!.type, 'procedure-reference');
    const data = fixture();
    data.entities[0].categoryId = id;
    data.entities[0].type = id === 'measurements' ? 'Measurement' : 'Observation';
    data.entities[0].attributes = data.entities[0].attributes!.filter(attribute => attribute.name !== 'partOf');
    data.mentions = [];
    const normalized = normalizeEvidence(data, old);
    assert.equal(partOf(normalized).value, null);
    assert.equal(partOf(normalized).valueType, 'procedure-reference');
    assert.deepEqual(normalizeEvidence(normalized, old), normalized);
  }
  const input = fixture();
  const untouched = structuredClone(input);
  const normalized = normalizeEvidence(input, FHIR_ANNOTATION_SCHEMA);
  assert.deepEqual(input, untouched);
  assert.equal(partOf(normalized).id, 'volume-procedure');
  assert.equal(normalized.mentions![0].certainty, 'uncertain');
  assert.equal(normalized.entities[0].attributes!.find(attribute => attribute.name === 'effectiveTime')!.value, null);
  assert.equal(normalized.entities[0].textSpan, undefined);
  const oldAi = fixture();
  oldAi.entities[0].type = 'fhir_observations';
  oldAi.entities[1].type = 'fhir_procedures';
  assert.deepEqual(partOf(normalizeEvidence(oldAi, FHIR_ANNOTATION_SCHEMA)).value, reference('scan'));
});

test('multiple links, renaming, unlinking and explicit deletion preserve measurement and attribute evidence', () => {
  const initial = normalizeEvidence(fixture(), FHIR_ANNOTATION_SCHEMA);
  const updated = reconcileEvidenceWithNotes({ ...initial, clinicalNotes: { ...initial.clinicalNotes,
    fhir_observations: [{ ...initial.clinicalNotes.fhir_observations![0], partOf: reference('scan', 'scan2') }]
  } }, FHIR_ANNOTATION_SCHEMA);
  updated.entities[1].name = 'Renamed ultrasound';
  assert.equal(formatAttributeValue(partOf(updated).value, updated.entities), 'Renamed ultrasound, Repeat ultrasound');
  assert.equal(getProcedureRelations(updated.entities).length, 2);
  const pruned = reconcileEvidenceWithNotes(unlinkDeletedProcedures({ ...updated,
    entities: updated.entities.filter(entity => entity.id !== 'scan'),
    clinicalNotes: { ...updated.clinicalNotes, fhir_procedures: updated.clinicalNotes.fhir_procedures!.filter(row => row.entityId !== 'scan') }
  }, new Set(['scan'])), FHIR_ANNOTATION_SCHEMA);
  assert.deepEqual(partOf(pruned).value, reference('scan2'));
  assert.deepEqual(pruned.mentions, initial.mentions);
  pruned.clinicalNotes.fhir_observations![0].partOf = null;
  const unlinked = reconcileEvidenceWithNotes(pruned, FHIR_ANNOTATION_SCHEMA);
  assert.equal(partOf(unlinked).value, null);
  assert.equal(partOf(unlinked).id, 'volume-procedure');
  assert.deepEqual(unlinked.mentions, initial.mentions);
  assert.equal(unlinked.entities[0].attributes!.find(attribute => attribute.name === 'value')!.value, 'about 2300 mL');
});

test('invalid references and reference roles are rejected', () => {
  for (const value of ['scan', ['scan'], {}, reference('missing'), reference('volume'), reference('scan', 'scan'), reference('')]) {
    const data = fixture();
    partOf(data).value = value;
    assert.throws(() => normalizeEvidence(data, FHIR_ANNOTATION_SCHEMA), /Part of procedure/);
  }
  const nonProcedure = fixture();
  nonProcedure.entities[1].type = 'Condition';
  assert.throws(() => normalizeEvidence(nonProcedure, FHIR_ANNOTATION_SCHEMA), /non-procedure/);
  const symptom = fixture();
  symptom.entities[0].type = 'Symptom';
  symptom.entities[0].categoryId = 'fhir_symptoms';
  assert.throws(() => normalizeEvidence(symptom, FHIR_ANNOTATION_SCHEMA), /measurement attribute/);
});

test('graphs and exports derive PART_OF from attributes and retain the evidence target', () => {
  const data = normalizeEvidence(fixture(), FHIR_ANNOTATION_SCHEMA);
  const graph = buildEvidenceGraph('case', 'Synthetic', data);
  assert.deepEqual(graph.edges.find(edge => edge.type === 'PART_OF'), {
    source: 'case:entity:volume', target: 'case:entity:scan', type: 'PART_OF', attributeId: 'volume-procedure'
  });
  assert.deepEqual(graph.edges.find(edge => edge.type === 'EVIDENCED_BY'), {
    source: 'case:attribute:volume-procedure', target: 'case:mention:evidence', type: 'EVIDENCED_BY'
  });
  const relation = JSON.parse(generateJsonlContent('relations', { annotation: data }, data.entities, data.mentions, data.relations));
  assert.equal(relation.relationType, 'PART_OF');
  assert.equal(relation.sourceEntityId, 'volume');
  assert.equal(relation.targetEntityId, 'scan');
  assert.equal(relation.derivedFrom, 'partOf');
  assert.equal(relation.attributeId, 'volume-procedure');
  for (const type of ['full_dataset', 'entities_mentions'] as const) {
    const exported = JSON.parse(generateJsonlContent(type, { annotation: data }, data.entities, data.mentions, data.relations).split('\n')[0]);
    const attribute = (type === 'full_dataset' ? exported.entities[0] : exported).attributes.find((a: any) => a.name === 'partOf');
    assert.deepEqual(attribute.value, reference('scan'));
    assert.equal(attribute.id, 'volume-procedure');
  }
  assert.deepEqual(data.relations, []);
});

test('persistence and checkpoint restoration preserve links; rejected saves leave stored data intact', () => {
  const db = new LocalDatabase(':memory:');
  try {
    db.saveGroup('study', { name: 'Study', createdAt: '2026-09-14', settings: { annotationSchema: FHIR_ANNOTATION_SCHEMA } }, true);
    const saved = db.saveConversation('case', { title: 'Kidney volume', groupId: 'study', createdAt: '2026-09-14',
      status: 'annotated', rawTranscript: 'on the scan', transcriptSegments: [], annotation: fixture() }, true);
    const checkpoint = db.createCheckpoint('case');
    assert.equal(checkpoint.schema.categories.find(category => category.id === 'fhir_observations')!.attributes.find(attribute => attribute.name === 'partOf')!.type, 'procedure-reference');
    const invalid = structuredClone(saved.annotation!);
    invalid.entities = invalid.entities.filter(entity => entity.id !== 'scan');
    assert.throws(() => db.saveConversation('case', { annotation: invalid }), (error: StorageError) => error.status === 400);
    assert.deepEqual(db.getConversation('case').annotation, saved.annotation);
    const unlinked = structuredClone(saved.annotation!);
    partOf(unlinked).value = null;
    db.saveConversation('case', { annotation: unlinked });
    const restored = db.restoreCheckpoint('case', checkpoint.id);
    assert.deepEqual(restored.annotation, saved.annotation);
    assert.deepEqual(restored.schemaSnapshot, checkpoint.schema);
    assert.equal(partOf(db.getConversation('case').annotation!).value, null);
  } finally { db.close(); }
});
