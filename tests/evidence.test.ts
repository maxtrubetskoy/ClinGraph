import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnnotationData, Mention } from '../src/types';
import { normalizeEvidence, reconcileEvidenceWithNotes, retargetMention, sameEvidenceTarget, buildEvidenceGraph, attributeIdFor } from '../src/utils/evidence';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { normalizeTemporal } from '../src/utils/temporal';

const span = (text: string, startChar = 0) => ({ lineIndex: 0, segmentId: 's1', startChar, endChar: startChar + text.length, text });
const mention = (id: string, text: string, supportedAttribute?: string): Mention => ({
  id, entityId: 'e1', entityType: 'Symptom', textSpan: span(text),
  polarity: 'positive', certainty: 'uncertain', temporality: 'past',
  experiencer: 'patient', function: 'asserted', speaker: 'Patient',
  ...(supportedAttribute ? { supportedAttribute } : {})
});
const legacy = (): AnnotationData => ({
  entities: [{ id: 'e1', name: 'Headache', type: 'Symptom' }],
  mentions: [mention('m1', 'headache'), mention('m2', 'Tuesday', 'Onset'), mention('m3', 'Wednesday', 'onset')],
  relations: [],
  clinicalNotes: { symptoms: [{ entityId: 'e1', name: 'Headache', severity: 'Mild', onset: 'Tuesday' }], medications: [], followUps: [] }
});

test('legacy attribute hints become stable attribute targets without changing spans, context, or input', () => {
  const input = legacy();
  const untouched = structuredClone(input);
  const result = normalizeEvidence(input);
  assert.deepEqual(input, untouched);
  assert.equal(result.evidenceVersion, 2);
  const onset = result.entities[0].attributes!.find(a => a.name === 'onset')!;
  assert.deepEqual(onset.value, normalizeTemporal('Tuesday'));
  assert.deepEqual(result.mentions![0].target, { kind: 'entity', entityId: 'e1' });
  for (const m of result.mentions!.slice(1)) {
    assert.deepEqual(m.target, { kind: 'attribute', entityId: 'e1', attributeId: onset.id });
    assert.equal(m.supportedAttribute, undefined);
    assert.equal(m.certainty, 'uncertain');
    assert.equal(m.temporality, 'past');
  }
  assert.deepEqual(result.entities[0].textSpan, input.mentions![0].textSpan);
  assert.deepEqual(normalizeEvidence(result), result);
});

test('attribute evidence never supplies a representative entity span and unknown legacy fields stay unassigned', () => {
  const input = legacy();
  input.mentions = [mention('m1', 'Tuesday', 'customOnset')];
  input.entities[0].textSpan = span('Tuesday');
  const result = normalizeEvidence(input);
  assert.equal(result.entities[0].textSpan, undefined);
  assert.equal(result.entities[0].attributes!.find(a => a.name === 'customOnset')!.value, null);
  assert.deepEqual(normalizeEvidence({ ...result, mentions: [] }).mentions, []);
});

test('editing values and retargeting preserves identity, text, and per-target context boundaries', () => {
  const original = normalizeEvidence(legacy());
  const next = reconcileEvidenceWithNotes({ ...original, clinicalNotes: {
    ...original.clinicalNotes, symptoms: [{ ...original.clinicalNotes.symptoms[0], onset: 'Wednesday' }]
  } });
  const attr = next.entities[0].attributes!.find(a => a.name === 'onset')!;
  assert.equal(attr.id, attributeIdFor('e1', 'onset'));
  assert.deepEqual(attr.value, normalizeTemporal('Wednesday'));
  assert.deepEqual(next.mentions, original.mentions);
  // V2 nodes are authoritative even if a client sends stale clinicalNotes.
  const canonicalEdit = normalizeEvidence({ ...original, entities: next.entities });
  assert.deepEqual(canonicalEdit.clinicalNotes.symptoms[0].onset, normalizeTemporal('Wednesday'));
  const moved = retargetMention(next.mentions![1], { kind: 'entity', entityId: 'e1' });
  assert.deepEqual(moved.textSpan, next.mentions![1].textSpan);
  assert.equal(moved.certainty, 'uncertain');
  assert.equal(sameEvidenceTarget(moved, next.mentions![0]), true);
  assert.equal(sameEvidenceTarget(next.mentions![0], next.mentions![1]), false);
  assert.equal(sameEvidenceTarget(next.mentions![1], next.mentions![2]), true);
});

test('validation rejects dangling and cross-owner attributes, duplicate IDs, and unspecified v2 targets', () => {
  const original = normalizeEvidence(legacy());
  const bad = structuredClone(original);
  bad.mentions![1].target = { kind: 'attribute', entityId: 'e1', attributeId: 'missing' };
  assert.throws(() => normalizeEvidence(bad), /missing attribute/);
  const foreign = structuredClone(original);
  foreign.entities.push({ id: 'e2', name: 'Nausea', type: 'Symptom', attributes: [
    { id: attributeIdFor('e2', 'onset'), name: 'onset', value: 'Monday' }
  ] });
  foreign.mentions![1].target = { kind: 'attribute', entityId: 'e1', attributeId: attributeIdFor('e2', 'onset') };
  assert.throws(() => normalizeEvidence(foreign), /another entity/);
  foreign.mentions![1] = retargetMention(foreign.mentions![1], {
    kind: 'attribute', entityId: 'e2', attributeId: attributeIdFor('e2', 'onset')
  });
  assert.equal(normalizeEvidence(foreign).mentions![1].entityId, 'e2');
  const duplicate = structuredClone(original);
  duplicate.entities[0].attributes!.push({ ...duplicate.entities[0].attributes![0] });
  assert.throws(() => normalizeEvidence(duplicate), /unique/);
  assert.throws(() => normalizeEvidence({ ...original, mentions: [mention('m4', 'Tuesday')] }), /no evidence target/);
  assert.throws(() => normalizeEvidence({ ...original, mentions: undefined }), /explicit mentions/);
  const removed = structuredClone(original);
  removed.entities[0].attributes = removed.entities[0].attributes!.filter(a => a.name !== 'onset');
  assert.throws(() => normalizeEvidence(removed), /missing attribute/);
});

test('graph and every evidence export keep direct and attribute mentions separate', () => {
  const annotation = normalizeEvidence(legacy());
  const graph = buildEvidenceGraph('case1', 'Synthetic', annotation);
  const node = (kind: string, originalId: string) => graph.nodes.find(n =>
    n.kind === kind && (n.mentionId === originalId || n.attributeId === originalId || n.entityId === originalId))!;
  const e = node('entity', 'e1');
  const a = node('attribute', attributeIdFor('e1', 'onset'));
  const direct = node('mention', 'm1');
  const attribute = node('mention', 'm2');
  assert.ok(graph.edges.some(edge => edge.source === e.id && edge.target === direct.id && edge.type === 'EVIDENCED_BY'));
  assert.ok(graph.edges.some(edge => edge.source === e.id && edge.target === a.id && edge.type === 'HAS_ATTRIBUTE'));
  assert.ok(graph.edges.some(edge => edge.source === a.id && edge.target === attribute.id && edge.type === 'EVIDENCED_BY'));
  assert.equal(graph.edges.filter(edge => edge.target === attribute.id).length, 1);
  assert.deepEqual(graph.nodes.slice(0, 2).map(n => n.kind), ['patient', 'encounter']);
  const args = [{ id: 'case1', title: 'Synthetic', annotation }, annotation.entities, annotation.mentions!, annotation.relations] as const;
  const entity = JSON.parse(generateJsonlContent('entities_mentions', ...args));
  assert.deepEqual(entity.mentions.map((m: Mention) => m.id), ['m1']);
  assert.equal(entity.mentionsCount, 1);
  assert.deepEqual(entity.attributes.find((a: any) => a.name === 'onset').mentions.map((m: Mention) => m.id), ['m2', 'm3']);
  const mentions = generateJsonlContent('mentions', ...args).split('\n').map(line => JSON.parse(line));
  assert.equal(mentions[1].target.attributeId, mentions[1].attribute.id);
  const full = JSON.parse(generateJsonlContent('full_dataset', ...args));
  assert.equal(full.evidenceVersion, 2);
  assert.deepEqual(full.evidenceGraph, graph);
  assert.deepEqual(full.mentions, annotation.mentions);
});
