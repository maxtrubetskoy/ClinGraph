import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnnotationData } from '../src/types';
import { normalizeEvidence, reconcileEvidenceWithNotes } from '../src/utils/evidence';
import { observationStatusReview } from '../src/utils/observationStatus';
import { resolveLegacyStatus } from '../src/utils/legacyStatusReview';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { LocalDatabase } from '../server/database';

const fixture = (existingAssessment = true): AnnotationData => normalizeEvidence({ evidenceVersion: 2,
  entities: [{ id: 'e1', categoryId: 'fhir_symptoms', type: 'Symptom', name: 'Headache', attributes: [
    { id: 'original-status', name: 'status', value: 'refuted' },
    ...(existingAssessment ? [{ id: 'assessment', name: 'diagnosticAssessment', value: 'not_suspected' }] : []),
    { id: 'historical', name: 'legacyStatus', value: 'refuted', migration: { kind: 'observation-status', originalName: 'status', originalValue: 'refuted' } }
  ] }], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] },
  mentions: [{ id: 'm1', entityId: 'e1', entityType: 'Symptom', polarity: 'negative', certainty: 'certain',
    function: 'asserted', evidenceRole: 'claim', speaker: 'Patient',
    target: { kind: 'attribute', entityId: 'e1', attributeId: 'original-status' },
    textSpan: { lineIndex: 0, startChar: 0, endChar: 2, text: 'No' } },
  { id: 'm2', entityId: 'e1', entityType: 'Symptom',
    target: { kind: 'attribute', entityId: 'e1', attributeId: 'historical' },
    textSpan: { lineIndex: 1, startChar: 0, endChar: 6, text: 'Denied' } }]
});
const attr = (annotation: AnnotationData, id: string) => annotation.entities[0].attributes!.find(a => a.id === id)!;

test('review can retain a historical legacy field without changing the assessment, evidence, or other warnings', () => {
  const original = fixture();
  const copy = structuredClone(original);
  const resolved = resolveLegacyStatus(original, 'e1', 'original-status', { kind: 'keep-context' });
  assert.deepEqual(original, copy);
  assert.equal(attr(resolved, 'assessment').value, 'not_suspected');
  assert.deepEqual(resolved.mentions, original.mentions);
  assert.deepEqual(resolved.entities[0].attributes!.map(a => a.id), original.entities[0].attributes!.map(a => a.id));
  assert.equal(attr(resolved, 'original-status').value, 'refuted');
  assert.equal(attr(resolved, 'original-status').migration!.originalValue, 'refuted');
  assert.equal(observationStatusReview(attr(resolved, 'original-status')), null);
  assert.ok(observationStatusReview(attr(resolved, 'historical')));
  assert.deepEqual(normalizeEvidence(resolved), resolved);
});

test('mapping updates only the chosen assessment and retargets only the reviewed source evidence with audit history', () => {
  const original = fixture();
  const copy = structuredClone(original);
  const resolved = resolveLegacyStatus(original, 'e1', 'original-status', { kind: 'assessment', value: 'absent' });
  assert.deepEqual(original, copy);
  assert.equal(attr(resolved, 'assessment').value, 'absent');
  assert.equal(attr(resolved, 'original-status').value, 'refuted');
  assert.deepEqual(attr(resolved, 'original-status').migration!.review, { decision: 'mapped-to-assessment',
    assessmentAttributeId: 'assessment', assessmentValue: 'absent', previousAssessmentValue: 'not_suspected', movedMentionIds: ['m1'] });
  assert.deepEqual(resolved.mentions![0], { ...original.mentions![0], target: { kind: 'attribute', entityId: 'e1', attributeId: 'assessment' } });
  assert.deepEqual(resolved.mentions![1], original.mentions![1]);
  assert.equal(resolved.entities[0].attributes!.find(a => a.name === 'status')!.value, 'unassigned');
  assert.equal(resolved.clinicalNotes.fhir_symptoms![0].diagnosticAssessment, 'absent');
  assert.equal(observationStatusReview(attr(resolved, 'original-status')), null);
  assert.ok(observationStatusReview(attr(resolved, 'historical')));
  // The existing form adapter must not undo the reviewed assessment or lose audit metadata.
  assert.deepEqual(reconcileEvidenceWithNotes(resolved), resolved);
});

test('legacy_refuted on the assessment itself is resolved in place, including an explicit insufficient-evidence choice', () => {
  const original = fixture(false);
  assert.equal(attr(original, 'original-status').name, 'diagnosticAssessment');
  assert.throws(() => resolveLegacyStatus(original, 'e1', 'original-status', { kind: 'keep-context' }), /Choose an assessment/);
  for (const value of ['unassigned', 'not_suspected', 'ruled_out']) {
    const resolved = resolveLegacyStatus(original, 'e1', 'original-status', { kind: 'assessment', value });
    assert.equal(attr(resolved, 'original-status').value, value);
    assert.deepEqual(resolved.mentions, original.mentions);
    assert.equal(observationStatusReview(attr(resolved, 'original-status')), null);
    assert.equal(attr(resolved, 'original-status').migration!.originalValue, 'refuted');
  }
});

test('invalid values, targets, and repeated resolutions fail without mutating annotations', () => {
  const original = fixture();
  const copy = structuredClone(original);
  assert.throws(() => resolveLegacyStatus(original, 'other', 'original-status', { kind: 'keep-context' }), /pending review/);
  assert.throws(() => resolveLegacyStatus(original, 'e1', 'assessment', { kind: 'keep-context' }), /pending review/);
  assert.throws(() => resolveLegacyStatus(original, 'e1', 'original-status', { kind: 'assessment', value: 'refuted' }), /valid diagnostic/);
  assert.throws(() => resolveLegacyStatus(original, 'e1', 'original-status', { kind: 'invented' } as any), /Choose how/);
  assert.deepEqual(original, copy);
  const resolved = resolveLegacyStatus(original, 'e1', 'original-status', { kind: 'keep-context' });
  assert.throws(() => resolveLegacyStatus(resolved, 'e1', 'original-status', { kind: 'keep-context' }), /pending review/);
});

test('review decisions and historical source values survive SQLite restart and evidence exports', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-legacy-review-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  try {
    const mapped = resolveLegacyStatus(fixture(), 'e1', 'original-status', { kind: 'assessment', value: 'absent' });
    const resolved = resolveLegacyStatus(mapped, 'e1', 'historical', { kind: 'keep-context' });
    db.saveConversation('s1', { title: 'Synthetic review', status: 'annotated', createdAt: '2026-09-11T00:00:00Z',
      rawTranscript: 'No. Denied.', transcriptSegments: [], annotation: resolved }, true);
    db.close(); db = new LocalDatabase(filename);
    const restored = db.getConversation('s1').annotation!;
    assert.deepEqual(restored, resolved);
    assert.ok(restored.entities[0].attributes!.every(a => !observationStatusReview(a)));
    const args = [{ id: 's1', annotation: restored }, restored.entities, restored.mentions!, restored.relations] as const;
    const full = JSON.parse(generateJsonlContent('full_dataset', ...args));
    assert.equal(attr(full, 'original-status').migration!.originalValue, 'refuted');
    assert.equal(attr(full, 'historical').migration!.review!.decision, 'retained-as-context');
    assert.equal(full.mentions[0].target.attributeId, 'assessment');
    const entities = JSON.parse(generateJsonlContent('entities_mentions', ...args));
    assert.equal(entities.attributes.find((a: any) => a.id === 'assessment').mentions[0].id, 'm1');
    assert.equal(entities.attributes.find((a: any) => a.id === 'original-status').migration.review.assessmentValue, 'absent');
    const mentions = generateJsonlContent('mentions', ...args).split('\n').map(line => JSON.parse(line));
    assert.equal(mentions[1].attribute.migration.review.decision, 'retained-as-context');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
