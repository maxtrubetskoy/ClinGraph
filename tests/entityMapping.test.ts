import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processEntityMapping } from '../server/entityMapping';
import { DEFAULT_ANNOTATION_SCHEMA, FHIR_ANNOTATION_SCHEMA, type Mention } from '../src/types';
import { normalizeEvidence, attributeIdFor } from '../src/utils/evidence';
import { normalizeTemporal } from '../src/utils/temporal';

const mentions: Mention[] = [{ id: 'm1', entityId: null, entityType: 'symptoms',
  textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'Headache' } }];
const map = (entities: unknown[]) => processEntityMapping({ entities }, mentions, DEFAULT_ANNOTATION_SCHEMA);
const entity = (attributes: Record<string, unknown>) => ({ name: 'Headache', type: 'symptoms', mentionIds: ['m1'], attributes });
const attr = (result: ReturnType<typeof map>, name: string, i = 0) => result.entities[i].attributes!.find(a => a.name === name)!;
const relative = (entityId: string, field: string) => ({ type: 'temporal', kind: 'relative',
  anchor: { kind: 'attribute', entityId, attributeId: attributeIdFor(entityId, field) },
  offset: { value: 1, unit: 'd' }, precision: 'day', qualifier: 'exact', text: 'the following day' });

test('mapping preserves good fields and isolates bad dates, temporal roles and trajectory parts', () => {
  for (const onset of [
    { type: 'temporal', kind: 'absolute', date: '2026-02-30', precision: 'day', qualifier: 'exact', text: 'Tuesday' },
    { type: 'temporal', kind: 'duration', amount: { value: 2, unit: 'd' }, precision: 'day', qualifier: 'exact', text: 'two days' },
    { type: 'temporal', kind: 'text', text: 12, precision: 'unknown', qualifier: 'exact' }
  ]) {
    const result = map([entity({ severity: 'Mild', onset, trajectory: { type: 'trajectory', direction: 'worsened', comparedTo: onset } })]);
    assert.equal(attr(result, 'severity').value, 'Mild');
    assert.deepEqual(attr(result, 'onset').value, normalizeTemporal(typeof onset.text === 'string' ? onset.text : null));
    assert.equal((attr(result, 'trajectory').value as any).direction, 'worsened');
    assert.equal(result.mentions![0].target?.kind, 'entity');
    assert(result.mappingIssues!.some(issue => issue.attributeName === 'onset' && issue.originalValue === onset));
    assert.doesNotThrow(() => normalizeEvidence(result, DEFAULT_ANNOTATION_SCHEMA));
  }
  const result = map([entity({ trajectory: { type: 'trajectory', direction: 'not-a-direction', comparedTo: 'last week', text: 'unclear comparison' } })]);
  assert.deepEqual(attr(result, 'trajectory').value, { type: 'trajectory', direction: 'unassigned', comparedTo: normalizeTemporal('last week'), text: 'unclear comparison' });
});

test('mapping isolates missing, wrong-role and cyclic anchors while preserving valid cross-entity timing', () => {
  for (const onset of [relative('missing', 'onset'), relative('e1', 'duration'), relative('e1', 'onset')]) {
    const result = map([entity({ onset }), { name: 'Nausea', type: 'symptoms', attributes: { onset: 'Tuesday' } }]);
    assert.deepEqual(attr(result, 'onset').value, normalizeTemporal('the following day'));
    assert.deepEqual(attr(result, 'onset', 1).value, normalizeTemporal('Tuesday'));
    assert.doesNotThrow(() => normalizeEvidence(result, DEFAULT_ANNOTATION_SCHEMA));
  }
  const cyclic = map([entity({ onset: relative('e2', 'onset') }),
    { name: 'Nausea', type: 'symptoms', attributes: { onset: relative('e1', 'onset') } }]);
  assert.equal(cyclic.mappingIssues!.filter(issue => issue.code === 'invalid_attribute').length, 2);
  const valid = map([entity({ onset: relative('e2', 'onset'), trajectory: { type: 'trajectory', direction: 'improved', comparedTo: relative('e2', 'onset') } }),
    { name: 'Nausea', type: 'symptoms', attributes: { onset: 'Tuesday' } }]);
  assert.deepEqual(valid.mappingIssues, []);
  assert.deepEqual(attr(valid, 'onset').value, relative('e2', 'onset'));
  assert.equal((attr(valid, 'trajectory').value as any).comparedTo.kind, 'relative');
  const badComparison = map([entity({ trajectory: { type: 'trajectory', direction: 'improved', comparedTo: relative('missing', 'onset') } })]);
  assert.equal((attr(badComparison, 'trajectory').value as any).direction, 'improved');
  assert.deepEqual((attr(badComparison, 'trajectory').value as any).comparedTo, normalizeTemporal('the following day'));
});

test('empty or malformed entity entries preserve every mention without inventing fallback entities', () => {
  for (const entities of [[], [null, false, {}, { name: 'Bad category', type: 'nonsense' }]]) {
    const result = map(entities);
    assert.deepEqual(result.entities, []);
    assert.equal(result.mentions!.length, 1);
    assert.equal(result.mentions![0].target, null);
    assert(result.mappingIssues!.some(issue => issue.code === 'unmapped_mention'));
  }
  assert.throws(() => processEntityMapping({ entities: {} }, mentions, DEFAULT_ANNOTATION_SCHEMA), /invalid entity clusters/);
  assert.throws(() => processEntityMapping(null, mentions, DEFAULT_ANNOTATION_SCHEMA), /invalid entity clusters/);
  assert.deepEqual(mentions[0].entityId, null);
});

test('ambiguous assignments stay unlinked; identical assignments are deduplicated and unknown fields are reported', () => {
  const conflicting = map([{ ...entity({}), attributeMentionIds: { severity: ['m1'] } }]);
  assert.equal(conflicting.mentions![0].target, null);
  assert(conflicting.mappingIssues!.some(issue => issue.code === 'conflicting_assignment'));
  const duplicate = map([{ ...entity({}), mentionIds: ['m1', 'm1'] }]);
  assert.equal(duplicate.mentions![0].target?.kind, 'entity');
  assert.deepEqual(duplicate.mappingIssues, []);
  const invalid = map([{ ...entity({ mysteriousField: { bad: true } }), mentionIds: [], attributeMentionIds: { madeUpField: ['m1'] } }]);
  assert.equal(invalid.mentions![0].target, null);
  assert(invalid.mappingIssues!.some(issue => issue.code === 'invalid_assignment'));
  assert(invalid.mappingIssues!.some(issue => issue.attributeName === 'mysteriousField'));
});

test('invalid workflow statuses remain unassigned and never become inferred clinical assessments', () => {
  const result = processEntityMapping({ entities: [{ ...entity({ status: 'refuted', severity: 'mild' }), type: 'fhir_symptoms' }] }, mentions, FHIR_ANNOTATION_SCHEMA);
  assert.equal(attr(result, 'status').value, 'unassigned');
  assert.equal(attr(result, 'diagnosticAssessment').value, 'unassigned');
  assert.equal(attr(result, 'severity').value, 'mild');
  assert.equal(result.mappingIssues![0].originalValue, 'refuted');
  // Tolerance belongs to model ingestion; malformed manual saves still fail strict validation.
  attr(result, 'onset').value = { type: 'temporal', precision: 'bad' };
  assert.throws(() => normalizeEvidence(result, FHIR_ANNOTATION_SCHEMA), /Invalid temporal/);
});
