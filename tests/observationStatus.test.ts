import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalDatabase, StorageError } from '../server/database';
import { FHIR_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../src/types';
import type { AnnotationData, AnnotationCategory, EntityAttribute } from '../src/types';
import { normalizeEvidence, reconcileEvidenceWithNotes, buildEvidenceGraph, attributeIdFor } from '../src/utils/evidence';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { OBSERVATION_RESULT_STATUSES, observationStatusReview } from '../src/utils/observationStatus';

const fixture = (status: unknown = 'refuted'): AnnotationData => ({ evidenceVersion: 2,
  entities: [{ id: 'e1', type: 'Symptom', categoryId: 'fhir_symptoms', name: 'Headache', attributes: [
    { id: 'name-1', name: 'name', value: 'Headache' }, { id: attributeIdFor('e1', 'status'), name: 'status', value: status }
  ] }],
  mentions: [{ id: 'm1', entityId: 'e1', entityType: 'Symptom', speaker: 'Patient', polarity: 'negative', certainty: 'uncertain',
    function: 'asserted', temporality: 'current', experiencer: 'patient',
    target: { kind: 'attribute', entityId: 'e1', attributeId: attributeIdFor('e1', 'status') },
    textSpan: { lineIndex: 0, startChar: 0, endChar: 2, text: 'No' } }],
  relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] }
});
const attrs = (annotation: AnnotationData) => annotation.entities[0].attributes!;
const field = (annotation: AnnotationData, name: string) => attrs(annotation).find(a => a.name === name)!;

test('FHIR observation schemas remove refuted workflow choices even from saved customizations', () => {
  for (const id of ['fhir_symptoms', 'fhir_observations', 'fhir_socialStatus']) {
    const category = FHIR_ANNOTATION_SCHEMA.find(c => c.id === id)!;
    assert.deepEqual(category.attributes.find(a => a.name === 'status')!.choices, OBSERVATION_RESULT_STATUSES);
    assert.ok(category.attributes.some(a => a.name === 'diagnosticAssessment'));
    const old: AnnotationCategory = { ...category, attributes: [{ name: 'status', type: 'text',
      displayName: 'Clinical status', choices: ['final', 'refuted', 'Refuted', 'active'], hint: 'Use refuted for negatives' }] };
    const normalized = normalizeAnnotationSchema([old])[0];
    assert.deepEqual(normalized.attributes[0].choices, OBSERVATION_RESULT_STATUSES);
    assert.equal(normalized.attributes[0].type, 'select');
    assert.equal(normalized.attributes[0].displayName, 'Result status');
    assert.deepEqual(normalizeAnnotationSchema([normalized]), [normalized]);
    assert.equal(old.attributes[0].type, 'text');
  }
});

test('legacy refuted moves to a reviewable assessment while IDs, evidence and source metadata remain intact', () => {
  const original = fixture('Refuted');
  const untouched = structuredClone(original);
  const migrated = normalizeEvidence(original);
  assert.deepEqual(original, untouched);
  const assessment = field(migrated, 'diagnosticAssessment');
  assert.equal(migrated.observationStatusVersion, 1);
  assert.equal(assessment.value, 'legacy_refuted');
  assert.equal(assessment.id, attributeIdFor('e1', 'status'));
  assert.deepEqual(assessment.migration, { kind: 'observation-status', originalName: 'status', originalValue: 'Refuted' });
  assert.equal(field(migrated, 'status').value, 'unassigned');
  assert.notEqual(field(migrated, 'status').id, assessment.id);
  assert.deepEqual(migrated.mentions, original.mentions!.map(m => ({ ...m, evidenceRole: 'unassigned' })));
  assert.equal(migrated.entities[0].textSpan, undefined);
  assert.match(observationStatusReview(assessment)!, /Review legacy status/);
  assert.equal(migrated.clinicalNotes.fhir_symptoms![0].diagnosticAssessment, 'legacy_refuted');
  assert.equal(migrated.clinicalNotes.fhir_symptoms![0].status, 'unassigned');
  assert.deepEqual(normalizeEvidence(migrated), migrated);
});

test('unversioned notes and supportedAttribute hints migrate before separating observation statuses', () => {
  const annotation = fixture();
  delete annotation.evidenceVersion;
  annotation.entities[0].attributes = undefined;
  delete annotation.mentions![0].target;
  annotation.mentions![0].supportedAttribute = 'status';
  annotation.clinicalNotes.fhir_symptoms = [{ entityId: 'e1', name: 'Headache', status: 'refuted' }];
  const migrated = normalizeEvidence(annotation);
  assert.equal(field(migrated, 'diagnosticAssessment').value, 'legacy_refuted');
  assert.equal(migrated.mentions![0].target!.kind, 'attribute');
  assert.equal((migrated.mentions![0].target as any).attributeId, field(migrated, 'diagnosticAssessment').id);
  assert.equal(migrated.mentions![0].polarity, 'negative');
});

test('conflicting assessments, unknown legacy statuses and ID/name collisions are preserved without overwriting', () => {
  const annotation = fixture();
  annotation.entities[0].attributes!.push({ id: 'assessment-1', name: 'diagnosticAssessment', value: 'not_suspected' },
    { id: 'legacy-1', name: 'legacyStatus', value: 'Existing historical context' },
    { id: attributeIdFor('e1', 'status') + ':1', name: 'custom', value: 'Reserved ID' });
  const migrated = normalizeEvidence(annotation);
  assert.equal(field(migrated, 'diagnosticAssessment').value, 'not_suspected');
  assert.equal(field(migrated, 'legacyStatus').value, 'Existing historical context');
  assert.equal(field(migrated, 'legacyStatus1').value, 'refuted');
  assert.equal(field(migrated, 'legacyStatus1').id, annotation.entities[0].attributes![1].id);
  assert.match(observationStatusReview(field(migrated, 'legacyStatus1'))!, /Review/);
  assert.equal(field(migrated, 'status').id, attributeIdFor('e1', 'status') + ':2');
  assert.deepEqual(migrated.mentions, annotation.mentions!.map(m => ({ ...m, evidenceRole: 'unassigned' })));
  const unfamiliar = normalizeEvidence(fixture({ old: 'nonstandard status' }));
  assert.deepEqual(field(unfamiliar, 'legacyStatus').value, { old: 'nonstandard status' });
  assert.equal(field(unfamiliar, 'status').value, 'unassigned');
  assert.deepEqual(normalizeEvidence(unfamiliar), unfamiliar);
});

test('workflow, diagnostic assessment, clinical status and verification remain independent', () => {
  const original = fixture('final');
  original.entities[0].attributes!.push({ id: 'assess', name: 'diagnosticAssessment', value: 'absent' });
  const normalized = normalizeEvidence(original);
  assert.equal(field(normalized, 'status').value, 'final');
  assert.equal(field(normalized, 'diagnosticAssessment').value, 'absent');
  assert.equal(field(normalized, 'status').migration, undefined);
  for (const categoryId of ['symptoms', 'conditions', 'fhir_conditions', 'fhir_allergies', 'custom']) {
    const other = fixture(); other.entities[0].categoryId = categoryId;
    assert.equal(field(normalizeEvidence(other), 'status').value, 'refuted');
  }
  for (const value of ['refuted', 'active', 'confirmed', 'absent', false]) {
    assert.throws(() => normalizeEvidence({ ...fixture(value), observationStatusVersion: 1 }), /workflow/);
  }
  for (const value of ['refuted', 'final', 'legacy_refuted']) {
    const bad = fixture('final'); bad.observationStatusVersion = 1;
    bad.entities[0].attributes!.push({ id: 'bad', name: 'diagnosticAssessment', value });
    assert.throws(() => normalizeEvidence(bad), /diagnostic assessment/);
  }
});

test('editing a reviewed assessment keeps its evidence and does not alter independent workflow status', () => {
  const migrated = normalizeEvidence(fixture());
  const edited = reconcileEvidenceWithNotes({ ...migrated, clinicalNotes: { ...migrated.clinicalNotes,
    fhir_symptoms: [{ ...migrated.clinicalNotes.fhir_symptoms![0], diagnosticAssessment: 'not_suspected', status: 'preliminary' }] } });
  assert.equal(field(edited, 'diagnosticAssessment').id, field(migrated, 'diagnosticAssessment').id);
  assert.equal(field(edited, 'diagnosticAssessment').value, 'not_suspected');
  assert.equal(field(edited, 'status').value, 'preliminary');
  assert.equal(observationStatusReview(field(edited, 'diagnosticAssessment')), null);
  assert.deepEqual(edited.mentions, migrated.mentions);
  assert.deepEqual(field(edited, 'diagnosticAssessment').migration, field(migrated, 'diagnosticAssessment').migration);
});

test('SQLite lazy migration does not rewrite raw records; edits persist and new invalid statuses return 400', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-status-test-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  const raw = new DatabaseSync(filename);
  try {
    const session = { title: 'Synthetic legacy status', createdAt: '2026-09-11T00:00:00Z', status: 'annotated',
      rawTranscript: 'No', transcriptSegments: [], annotation: fixture() };
    raw.prepare('INSERT INTO conversations (id, data) VALUES (?, ?)').run('s1', JSON.stringify(session));
    const migrated = db.getConversation('s1');
    assert.equal(field(migrated.annotation!, 'diagnosticAssessment').value, 'legacy_refuted');
    assert.deepEqual(JSON.parse(raw.prepare('SELECT data FROM conversations WHERE id = ?').get('s1')!.data as string), session);
    db.saveConversation('s1', { annotation: migrated.annotation });
    db.close(); db = new LocalDatabase(filename);
    assert.deepEqual(db.getConversation('s1').annotation, migrated.annotation);
    const invalid = structuredClone(migrated.annotation!); field(invalid, 'status').value = 'refuted';
    assert.throws(() => db.saveConversation('s1', { annotation: invalid }), (error: StorageError) => error.status === 400);
    assert.deepEqual(db.getConversation('s1').annotation, migrated.annotation);
  } finally { raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exports and evidence graph preserve the migrated assessment, its provenance and original mention target', () => {
  const annotation = normalizeEvidence(fixture());
  const id = field(annotation, 'diagnosticAssessment').id;
  for (const type of ['entities_mentions', 'mentions', 'full_dataset'] as const) {
    const exported = JSON.parse(generateJsonlContent(type, { id: 's1', annotation }, annotation.entities, annotation.mentions));
    assert.equal(exported.observationStatusVersion, 1);
    const attribute: EntityAttribute = type === 'mentions' ? exported.attribute :
      (type === 'full_dataset' ? exported.entities[0].attributes : exported.attributes).find((a: EntityAttribute) => a.id === id);
    assert.equal(attribute.name, 'diagnosticAssessment');
    assert.equal(attribute.value, 'legacy_refuted');
    assert.equal(attribute.migration!.originalValue, 'refuted');
  }
  const graph = buildEvidenceGraph('s1', 'Synthetic', annotation);
  const node = graph.nodes.find(n => n.attributeId === id)!;
  assert.equal(node.label, 'diagnosticAssessment');
  assert.ok(graph.edges.some(edge => edge.source === node.id && edge.type === 'EVIDENCED_BY'));
});
