import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDatabase, StorageError } from '../server/database';
import { DEFAULT_ANNOTATION_SCHEMA, FHIR_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../src/types';
import type { AnnotationData, AnnotationCategory } from '../src/types';
import { attributeIdFor, buildEvidenceGraph, normalizeEvidence, reconcileEvidenceWithNotes } from '../src/utils/evidence';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { formatAttributeValue } from '../src/utils/attributeValues';
import { normalizeTrajectory, trajectoryError, validateTrajectory } from '../src/utils/trajectory';
import type { TrajectoryValue } from '../src/utils/trajectory';
import { normalizeTemporal, resolveTemporal } from '../src/utils/temporal';
import type { TemporalValue } from '../src/utils/temporal';

const absolute = (date = '2026-09-11'): TemporalValue => ({ type: 'temporal', kind: 'absolute', date, precision: 'day', qualifier: 'exact' });
const relative = (): TemporalValue => ({ type: 'temporal', kind: 'relative', offset: { value: -1, unit: 'wk' },
  anchor: { kind: 'encounter' }, precision: 'week', qualifier: 'exact', text: 'a week ago' });
const comparison = (comparedTo: TemporalValue | null = relative()): TrajectoryValue =>
  ({ type: 'trajectory', direction: 'worsened', comparedTo, text: 'worse than a week ago' });
const fixture = (): AnnotationData => normalizeEvidence({ evidenceVersion: 2,
  entities: [{ id: 'e1', name: 'Headache', type: 'Symptom', categoryId: 'symptoms',
    attributes: [{ id: 'name-1', name: 'name', value: 'Headache' }] }],
  mentions: [], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } });
const attr = (annotation: AnnotationData, name = 'trajectory') => annotation.entities[0].attributes!.find(a => a.name === name)!;

test('standard and FHIR symptom, condition and measurement schemas acquire typed, unassigned trajectory slots', () => {
  const schemas = [...DEFAULT_ANNOTATION_SCHEMA, ...FHIR_ANNOTATION_SCHEMA];
  for (const id of ['symptoms', 'conditions', 'measurements', 'fhir_symptoms', 'fhir_conditions', 'fhir_observations']) {
    const category = schemas.find(c => c.id === id)!;
    assert.equal(category.attributes.find(a => a.name === 'trajectory')!.type, 'trajectory');
    const old: AnnotationCategory = { ...category, attributes: [{ name: 'trajectory', type: 'text' }] };
    assert.equal(normalizeAnnotationSchema([old])[0].attributes[0].type, 'trajectory');
    const annotation = fixture();
    annotation.entities[0] = { id: 'e1', name: 'Synthetic', type: category.entityType, categoryId: id };
    const upgraded = normalizeEvidence(annotation);
    assert.equal(attr(upgraded).valueType, 'trajectory');
    assert.equal(attr(upgraded).value, null);
    assert.deepEqual(normalizeEvidence(upgraded), upgraded);
  }
});

test('missing and legacy trajectories preserve uncertainty and never infer comparison dates or clinical benefit', () => {
  for (const missing of [null, undefined, '', 'Unassigned', 'Unspecified']) assert.equal(normalizeTrajectory(missing), null);
  for (const [word, direction] of [['better', 'improved'], ['worse', 'worsened'], ['unchanged', 'unchanged'],
    ['not improved', 'unassigned'], ['increased', 'unassigned'], ['fluctuating', 'unassigned']]) {
    assert.deepEqual(normalizeTrajectory(word), { type: 'trajectory', direction, comparedTo: null, text: word });
  }
  const annotation = fixture();
  annotation.entities[0].attributes!.push({ id: 'status', name: 'status', value: 'Stable' }, { id: 'value', name: 'value', value: '120' });
  assert.equal(attr(normalizeEvidence(annotation)).value, null);
  assert.equal(normalizeTrajectory({ type: 'trajectory', direction: 'improved' })!.comparedTo, null);
  const old = fixture();
  attr(old).value = 'worse than last week';
  const migrated = normalizeEvidence(old);
  assert.equal((attr(migrated).value as TrajectoryValue).text, 'worse than last week');
  assert.equal((attr(migrated).value as TrajectoryValue).comparedTo, null);
});

test('trajectory validates direction and comparison time, rejects duration and preserves unresolved references', () => {
  for (const direction of ['improved', 'worsened', 'unchanged', 'unassigned']) {
    assert.doesNotThrow(() => validateTrajectory({ ...comparison(null), direction }));
  }
  assert.throws(() => normalizeTrajectory({ ...comparison(), direction: 'increased' }), /trajectory/);
  assert.throws(() => normalizeTrajectory({ ...comparison(), text: 5 }), /trajectory/);
  assert.throws(() => normalizeTrajectory(comparison(absolute('2026-02-30'))), /valid/);
  assert.throws(() => normalizeTrajectory(comparison({ ...absolute(), kind: 'duration', amount: { value: 1, unit: 'wk' } })), /not a duration/);
  const unspecifiedVisit = comparison(normalizeTemporal('the previous visit'));
  assert.deepEqual(normalizeTrajectory(unspecifiedVisit), unspecifiedVisit);
  assert.equal(resolveTemporal(unspecifiedVisit.comparedTo, { encounterTime: absolute() }), null);
  assert.equal(trajectoryError(comparison()), null);
  assert.match(formatAttributeValue(comparison()), /Worsened compared with 1 week before encounter/);
  assert.match(formatAttributeValue(comparison(null)), /unspecified time/);
  const malformed = fixture();
  attr(malformed, 'onset').value = comparison();
  assert.throws(() => normalizeEvidence(malformed), /temporal/);
});

test('comparison anchors use stable event IDs and reject dangling, wrong-owner, duration and trajectory targets', () => {
  const annotation = fixture();
  const onset = attr(annotation, 'onset');
  onset.value = absolute('2026-09-01');
  const linked: TemporalValue = { ...relative(), kind: 'relative', offset: { value: 0, unit: 'd' }, precision: 'day',
    anchor: { kind: 'attribute', entityId: 'e1', attributeId: onset.id } };
  attr(annotation).value = comparison(linked);
  assert.doesNotThrow(() => normalizeEvidence(annotation));
  assert.equal(resolveTemporal(linked, { entities: annotation.entities })!.date, '2026-09-01');
  for (const [entityId, attributeId] of [['e1', 'missing'], ['wrong-owner', onset.id], ['e1', 'name-1'],
    ['e1', attr(annotation, 'duration').id], ['e1', attr(annotation).id]]) {
    attr(annotation).value = comparison({ ...linked, anchor: { kind: 'attribute', entityId, attributeId } });
    assert.throws(() => normalizeEvidence(annotation), /anchor/);
  }
});

test('editing and clearing trajectory preserves its ID and evidence without promoting it to entity evidence', () => {
  let annotation = fixture();
  const id = attr(annotation).id;
  annotation.mentions = [{ id: 'm1', entityId: 'e1', entityType: 'Symptom', certainty: 'uncertain', polarity: 'positive',
    target: { kind: 'attribute', entityId: 'e1', attributeId: id },
    textSpan: { lineIndex: 0, startChar: 0, endChar: 21, text: 'worse than a week ago' } }];
  for (const value of [comparison(), { ...comparison(), direction: 'improved' as const }, null]) {
    annotation = reconcileEvidenceWithNotes({ ...annotation, clinicalNotes: { ...annotation.clinicalNotes,
      symptoms: [{ entityId: 'e1', name: 'Headache', severity: 'Unassigned', trajectory: value }] } });
    assert.equal(attr(annotation).id, id);
    assert.deepEqual(attr(annotation).value, value);
    assert.equal(annotation.entities[0].textSpan, undefined);
    assert.equal(annotation.mentions![0].certainty, 'uncertain');
    const graph = buildEvidenceGraph('s1', 'Synthetic', annotation);
    const evidenceEdges = graph.edges.filter(e => e.type === 'EVIDENCED_BY');
    assert.equal(evidenceEdges.length, 1);
    assert.equal(graph.nodes.find(node => node.id === evidenceEdges[0].source)!.attributeId, id);
  }
});

test('custom trajectory fields are materialized and normalized through the same path', () => {
  const schema: AnnotationCategory[] = [{ id: 'custom', entityType: 'Other', displayName: 'Custom',
    attributes: [{ name: 'change', type: 'trajectory' }] }];
  const annotation = fixture();
  annotation.entities[0] = { id: 'e1', name: 'Synthetic', type: 'Other', categoryId: 'custom' };
  const normalized = normalizeEvidence(annotation, schema);
  assert.equal(attr(normalized, 'change').valueType, 'trajectory');
  assert.equal(attr(normalized, 'change').value, null);
  attr(normalized, 'change').value = comparison();
  assert.deepEqual(attr(normalizeEvidence(normalized, schema), 'change').value, comparison());
});

test('trajectory and its evidence survive SQLite reopening; invalid edits cannot overwrite valid data', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-trajectory-test-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  try {
    const annotation = fixture();
    attr(annotation).value = comparison();
    annotation.mentions = [{ id: 'm1', entityId: 'e1', entityType: 'Symptom',
      target: { kind: 'attribute', entityId: 'e1', attributeId: attr(annotation).id },
      textSpan: { lineIndex: 0, startChar: 0, endChar: 20, text: 'worse than a week ago' } }];
    db.saveConversation('s1', { title: 'Synthetic trajectory', createdAt: '2040-01-01T00:00:00Z', status: 'annotated',
      rawTranscript: 'worse than a week ago', transcriptSegments: [], encounterTime: absolute(), annotation }, true);
    db.close(); db = new LocalDatabase(filename);
    const saved = db.getConversation('s1');
    assert.deepEqual(attr(saved.annotation!).value, comparison());
    assert.deepEqual(saved.annotation!.mentions, normalizeEvidence(annotation).mentions);
    attr(annotation).value = comparison(absolute('2026-02-30'));
    assert.throws(() => db.saveConversation('s1', { annotation }), (error: StorageError) => error.status === 400);
    assert.deepEqual(db.getConversation('s1'), saved);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exports retain trajectory evidence and recompute comparison dates without trusting stored derivatives', () => {
  const annotation = fixture();
  attr(annotation).value = comparison();
  annotation.mentions = [{ id: 'm1', entityId: 'e1', entityType: 'Symptom',
    target: { kind: 'attribute', entityId: 'e1', attributeId: attr(annotation).id },
    textSpan: { lineIndex: 0, startChar: 0, endChar: 20, text: 'worse than a week ago' } }];
  const session = { id: 's1', createdAt: '2040-01-01T00:00:00Z', encounterTime: absolute(), annotation };
  for (const type of ['entities_mentions', 'mentions', 'full_dataset'] as const) {
    const row = JSON.parse(generateJsonlContent(type, session, annotation.entities, annotation.mentions));
    const exported = type === 'mentions' ? row.attribute
      : (type === 'full_dataset' ? row.entities[0].attributes : row.attributes).find((a: any) => a.name === 'trajectory');
    assert.equal(row.trajectoryVersion, 1);
    assert.equal(exported.id, attributeIdFor('e1', 'trajectory'));
    assert.deepEqual(exported.value, comparison());
    assert.equal(exported.resolvedComparisonTime.date, '2026-09-04');
    assert.equal(exported.resolvedTime, undefined);
    if (type === 'entities_mentions') { assert.equal(row.mentions.length, 0); assert.equal(exported.mentions.length, 1); }
    if (type === 'mentions') assert.equal(row.target.attributeId, exported.id);
  }
  const exportFull = (encounterTime: TemporalValue | null) => JSON.parse(generateJsonlContent('full_dataset',
    { ...session, encounterTime }, annotation.entities, annotation.mentions));
  assert.equal((attr(exportFull(null)) as any).resolvedComparisonTime, null);
  const row = exportFull(absolute('2026-09-18'));
  assert.equal((attr(row) as any).resolvedComparisonTime.date, '2026-09-11');
  const exported = attr(row) as any;
  exported.resolvedComparisonTime = { date: 'invented' };
  exported.value.comparedTo.resolved = { date: 'invented' };
  const imported = normalizeEvidence(row);
  assert.equal((attr(imported) as any).resolvedComparisonTime, undefined);
  assert.deepEqual(attr(imported).value, comparison());
});
