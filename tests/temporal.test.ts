import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDatabase, StorageError } from '../server/database';
import { DEFAULT_ANNOTATION_SCHEMA, FHIR_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../src/types';
import type { AnnotationData } from '../src/types';
import { attributeIdFor, normalizeEvidence, reconcileEvidenceWithNotes } from '../src/utils/evidence';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { datePrecision, normalizeTemporal, resolveTemporal, validateTemporal, validateEncounterTime } from '../src/utils/temporal';
import type { TemporalValue } from '../src/utils/temporal';

const absolute = (date: string): TemporalValue => ({ type: 'temporal', kind: 'absolute', date, precision: datePrecision(date) || 'unknown', qualifier: 'exact' });
const relative = (value = -1): TemporalValue => ({ type: 'temporal', kind: 'relative', offset: { value, unit: 'wk' },
  anchor: { kind: 'encounter' }, precision: 'week', qualifier: 'approximate', text: 'about a week ago' });
const fixture = (): AnnotationData => normalizeEvidence({
  entities: [{ id: 'e1', name: 'Headache', type: 'Symptom', categoryId: 'fhir_symptoms' },
    { id: 'e2', name: 'Blood pressure', type: 'Observation', categoryId: 'fhir_observations' }],
  relations: [], mentions: [],
  clinicalNotes: { symptoms: [], medications: [], followUps: [],
    fhir_symptoms: [{ entityId: 'e1', name: 'Headache', onset: 'last week' }],
    fhir_observations: [{ entityId: 'e2', name: 'Blood pressure', value: '120/80' }] }
});

test('partial dates preserve precision; invalid dates, missing timezone and precision inflation are rejected', () => {
  for (const [date, precision] of [['2024', 'year'], ['2024-02', 'month'], ['2024-02-29', 'day'],
    ['2026-09-11T10:30+02:00', 'minute'], ['2026-09-11T10:30:00Z', 'second']]) {
    assert.equal(datePrecision(date), precision);
    assert.doesNotThrow(() => validateTemporal(absolute(date)));
  }
  for (const date of ['2023-02-29', '2026-04-31', '2026-13', '2026-00-01', '2026-09-11T10:30',
    '2026-09-11T24:00Z', '2026-09-11T10:30+14:01', '2026-09-11junk']) {
    assert.equal(datePrecision(date), null, date);
    assert.throws(() => validateTemporal(absolute(date)));
  }
  assert.throws(() => validateTemporal({ ...absolute('2026'), precision: 'day' }), /precision/);
  assert.equal(normalizeTemporal('  '), null);
});

test('legacy wording migrates without guessed dates and existing schema definitions acquire temporal controls', () => {
  const annotation = fixture();
  assert.deepEqual(annotation.entities[0].attributes!.find(a => a.name === 'onset')!.value, normalizeTemporal('last week'));
  assert.equal(resolveTemporal(normalizeTemporal('last week'), { encounterTime: absolute('2026-09-11') }), null);
  for (const [categoryId, fields] of [
    ['symptoms', ['onset', 'resolutionTime', 'duration']],
    ['fhir_symptoms', ['onset', 'resolutionTime', 'duration']],
    ['measurements', ['effectiveTime']], ['fhir_observations', ['effectiveTime']]
  ] as const) {
    const category = [...DEFAULT_ANNOTATION_SCHEMA, ...FHIR_ANNOTATION_SCHEMA].find(c => c.id === categoryId)!;
    assert.ok(fields.every(name => category.attributes.some(a => a.name === name && a.type === 'temporal')));
  }
  const old = [{ id: 'symptoms', entityType: 'Symptom', displayName: 'Symptoms',
    attributes: [{ name: 'onset', type: 'text' as const }] }];
  assert.equal(normalizeAnnotationSchema(old)[0].attributes.find(a => a.name === 'onset')!.type, 'temporal');
  assert.deepEqual(normalizeEvidence(annotation), annotation);
});

test('offsets resolve only from sufficiently precise clinical anchors, never workspace creation time', () => {
  assert.equal(resolveTemporal(relative()), null);
  assert.equal(resolveTemporal(relative(), { encounterTime: absolute('2026') }), null);
  assert.deepEqual(resolveTemporal(relative(), { encounterTime: absolute('2026-09-11') }),
    { date: '2026-09-04', precision: 'week', qualifier: 'approximate' });
  const hours: TemporalValue = { ...relative(), kind: 'relative', offset: { value: 5, unit: 'h' },
    anchor: { kind: 'encounter' }, precision: 'hour', qualifier: 'exact' };
  assert.equal(resolveTemporal(hours, { encounterTime: absolute('2026-09-11') }), null);
  assert.deepEqual(resolveTemporal(hours, { encounterTime: absolute('2026-09-11T10:30+02:00') }),
    { date: '2026-09-11T13:30Z', precision: 'hour', qualifier: 'exact' });
  assert.equal(resolveTemporal({ ...hours, offset: { value: 1, unit: 'mo' } }, { encounterTime: absolute('2026-01-31') }), null);
  assert.equal(resolveTemporal({ ...hours, anchor: { kind: 'unknown', label: 'surgery' } }), null);
  assert.throws(() => validateEncounterTime(relative()), /absolute/);
});

test('duration ranges are not onset dates and unknown interval ends are not ongoing', () => {
  const duration: TemporalValue = { type: 'temporal', kind: 'duration', amount: { value: 2, maxValue: 3, unit: 'd' }, precision: 'day', qualifier: 'approximate' };
  assert.doesNotThrow(() => validateTemporal(duration));
  assert.equal(resolveTemporal(duration, { encounterTime: absolute('2026-09-11') }), null);
  assert.throws(() => validateTemporal({ ...duration, amount: { value: -1, unit: 'd' } }), /negative/);
  assert.throws(() => validateTemporal({ ...duration, amount: { value: 3, maxValue: 2, unit: 'd' } }), /range/);
  const interval: TemporalValue = { type: 'temporal', kind: 'interval', start: '2026-09-01', endStatus: 'unknown', precision: 'day', qualifier: 'exact' };
  assert.equal(normalizeTemporal(interval)!.kind, 'interval');
  assert.equal((normalizeTemporal(interval) as typeof interval).endStatus, 'unknown');
  assert.throws(() => validateTemporal({ ...interval, endStatus: 'known' }), /end date/);
  assert.throws(() => validateTemporal({ ...interval, endStatus: 'known', end: '2026-08-01' }), /precede/);
  const annotation = fixture();
  annotation.entities[0].attributes!.find(a => a.name === 'onset')!.value = duration;
  assert.throws(() => normalizeEvidence(annotation), /separately/);
});

test('stable event anchors resolve and dangling, foreign-owner, non-temporal, and cyclic anchors are rejected', () => {
  const annotation = fixture();
  const onset = annotation.entities[0].attributes!.find(a => a.name === 'onset')!;
  onset.value = absolute('2026-09-01');
  const effective = annotation.entities[1].attributes!.find(a => a.name === 'effectiveTime')!;
  effective.value = { ...relative(1), kind: 'relative', offset: { value: 1, unit: 'd' },
    anchor: { kind: 'attribute', entityId: 'e1', attributeId: onset.id }, precision: 'day', qualifier: 'exact' };
  assert.doesNotThrow(() => normalizeEvidence(annotation));
  assert.equal(resolveTemporal(effective.value, { entities: annotation.entities })!.date, '2026-09-02');
  for (const anchor of [
    { kind: 'attribute', entityId: 'e1', attributeId: 'missing' },
    { kind: 'attribute', entityId: 'e2', attributeId: onset.id },
    { kind: 'attribute', entityId: 'e1', attributeId: attributeIdFor('e1', 'name') }
  ]) {
    const bad = structuredClone(annotation);
    bad.entities[1].attributes!.find(a => a.id === effective.id)!.value = { ...(effective.value as object), anchor };
    assert.throws(() => normalizeEvidence(bad), /anchor/);
  }
  onset.value = { ...relative(), kind: 'relative', offset: { value: -1, unit: 'd' },
    anchor: { kind: 'attribute', entityId: 'e2', attributeId: effective.id } };
  assert.throws(() => normalizeEvidence(annotation), /cycle/);
  assert.equal(resolveTemporal(onset.value, { entities: annotation.entities }), null);
});

test('timing, attribute evidence and encounter time survive database reopening; invalid edits do not overwrite', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-time-test-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  try {
    const annotation = fixture();
    const onset = annotation.entities[0].attributes!.find(a => a.name === 'onset')!;
    onset.value = relative();
    annotation.mentions = [{ id: 'm1', entityId: 'e1', entityType: 'Symptom',
      target: { kind: 'attribute', entityId: 'e1', attributeId: onset.id },
      textSpan: { lineIndex: 0, startChar: 0, endChar: 16, text: 'about a week ago' }, certainty: 'uncertain' }];
    db.saveConversation('time-test', { title: 'Synthetic time', createdAt: '2040-01-01T00:00:00Z',
      rawTranscript: 'about a week ago', transcriptSegments: [], status: 'annotated',
      encounterTime: absolute('2026-09-11'), annotation }, true);
    db.close(); db = new LocalDatabase(filename);
    const saved = db.getConversation('time-test');
    assert.equal(resolveTemporal(saved.annotation!.entities[0].attributes!.find(a => a.id === onset.id)!.value, saved)!.date, '2026-09-04');
    assert.deepEqual(saved.annotation!.mentions![0].target, annotation.mentions[0].target);
    assert.throws(() => db.saveConversation('time-test', { encounterTime: absolute('2026-02-30') }), (error: StorageError) => error.status === 400);
    assert.deepEqual(db.getConversation('time-test'), saved);
    db.saveConversation('time-test', { encounterTime: null });
    const cleared = db.getConversation('time-test');
    assert.equal(resolveTemporal(onset.value, cleared), null);
    assert.deepEqual(cleared.annotation, saved.annotation);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exports separate source expressions from recomputed dates and preserve timing evidence after value edits', () => {
  let annotation = fixture();
  const onsetId = attributeIdFor('e1', 'onset');
  annotation = reconcileEvidenceWithNotes({ ...annotation, clinicalNotes: {
    ...annotation.clinicalNotes, fhir_symptoms: [{ entityId: 'e1', name: 'Headache', onset: relative() }]
  } });
  const session = { id: 's1', createdAt: '2040-01-01T00:00:00Z', encounterTime: absolute('2026-09-11') };
  const exportFull = (encounterTime = session.encounterTime) => JSON.parse(generateJsonlContent('full_dataset',
    { ...session, encounterTime, annotation }, annotation.entities, annotation.mentions));
  const row = exportFull();
  const onset = row.entities[0].attributes.find((a: any) => a.id === onsetId);
  assert.equal(row.temporalVersion, 1);
  assert.deepEqual(row.encounterTime, session.encounterTime);
  assert.equal(onset.value.offset.value, -1);
  assert.equal(onset.value.resolved, undefined);
  assert.equal(onset.resolvedTime.date, '2026-09-04');
  assert.equal(exportFull(absolute('2026-09-18')).entities[0].attributes.find((a: any) => a.id === onsetId).resolvedTime.date, '2026-09-11');
  const imported = normalizeEvidence({ ...annotation, entities: row.entities });
  assert.equal((imported.entities[0].attributes!.find(a => a.id === onsetId) as any).resolvedTime, undefined);
});
