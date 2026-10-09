import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnnotationData, EvidenceTarget, Mention } from '../src/types';
import { normalizeEvidence, buildEvidenceGraph } from '../src/utils/evidence';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { summarizeEntityClaims } from '../src/utils/mentionContext';
import { getMentionTargets, setMentionTargets, retainMentionEntities } from '../src/utils/evidenceTargets';
import { LocalDatabase } from '../server/database';
import { validateExtractedMentions } from '../src/utils/mentionExtraction';
import { resolveLegacyStatus } from '../src/utils/legacyStatusReview';
import { realignMentionsWithSegments } from '../src/utils/segmentRealignment';

const targets: EvidenceTarget[] = [{ kind: 'entity', entityId: 'cellcept' }, { kind: 'entity', entityId: 'prednison' }];
const shared = (): Mention => ({ id: 'die', entityId: null, target: null, targets: targets.map(t => ({ ...t })),
  entityType: 'Medication', evidenceRole: 'reference', certainty: 'not_applicable',
  textSpan: { lineIndex: 1, startChar: 6, endChar: 9, text: 'die' } });
const annotation = (): AnnotationData => ({ evidenceVersion: 2, mentionContextVersion: 1, observationStatusVersion: 1,
  entities: [{ id: 'cellcept', name: 'Cellcept', type: 'Medication', categoryId: 'medications', attributes: [{ id: 'c-action', name: 'action', value: 'Continue' }] },
    { id: 'prednison', name: 'Prednison', type: 'Medication', categoryId: 'medications', attributes: [{ id: 'p-action', name: 'action', value: 'Continue' }] }],
  mentions: [shared()], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } });

test('one reference span belongs to both medications without duplicating it or creating clinical claims', () => {
  const input = annotation();
  const normalized = normalizeEvidence(input);
  assert.equal(normalized.mentions!.length, 1);
  assert.deepEqual(normalized.mentions![0].targets, targets);
  assert(normalized.entities.every(e => e.textSpan?.text === 'die'));
  assert.equal(summarizeEntityClaims(normalized.mentions!, 'cellcept').referenceCount, 1);
  assert.equal(summarizeEntityClaims(normalized.mentions!, 'prednison').referenceCount, 1);
  assert.equal(summarizeEntityClaims(normalized.mentions!, 'prednison').claimCount, 0);
  assert.deepEqual(normalizeEvidence(normalized), normalized);
  assert.deepEqual(input, annotation());
});

test('one graph node and one mention export row retain both targets and every entity gets its evidence', () => {
  const data = normalizeEvidence(annotation());
  const graph = buildEvidenceGraph('case', 'Two medications', data);
  assert.equal(graph.nodes.filter(n => n.kind === 'mention').length, 1);
  assert.equal(graph.edges.filter(e => e.type === 'EVIDENCED_BY').length, 2);
  const args = [{ id: 'case', annotation: data }, data.entities, data.mentions!, data.relations] as const;
  const rows = generateJsonlContent('entities_mentions', ...args).split('\n').map(line => JSON.parse(line));
  assert(rows.every(row => row.mentionsCount === 1 && row.mentions[0].id === 'die'));
  const mentions = generateJsonlContent('mentions', ...args).split('\n').map(line => JSON.parse(line));
  assert.equal(mentions.length, 1);
  assert.deepEqual(mentions[0].targets, targets);
  assert.deepEqual(mentions[0].linkedTargets.map((t: any) => t.entityName), ['Cellcept', 'Prednison']);
});

test('shared attribute evidence stays scoped and every target is strictly validated', () => {
  const data = annotation();
  data.mentions![0].targets = [{ kind: 'attribute', entityId: 'cellcept', attributeId: 'c-action' }, targets[1]];
  const normalized = normalizeEvidence(data);
  assert.equal(normalized.entities[0].textSpan, undefined);
  assert.equal(normalized.entities[1].textSpan?.text, 'die');
  for (const bad of [null, 'bad', [{ kind: 'entity', entityId: 'missing' }],
    [{ kind: 'attribute', entityId: 'prednison', attributeId: 'c-action' }], [targets[0], targets[0]]]) {
    const broken = annotation();
    broken.mentions![0].targets = bad as any;
    assert.throws(() => normalizeEvidence(broken));
  }
});

test('removing or changing one link preserves other links, source identity and single-target compatibility', () => {
  const original = shared();
  const edited = setMentionTargets(original, [{ kind: 'attribute', entityId: 'cellcept', attributeId: 'c-action' }, targets[1]]);
  const reduced = retainMentionEntities(edited, new Set(['prednison']));
  assert.deepEqual(getMentionTargets(reduced), [targets[1]]);
  assert.deepEqual(reduced.target, targets[1]);
  assert.equal(reduced.targets, undefined);
  assert.equal(reduced.entityId, 'prednison');
  assert.equal(reduced.id, original.id);
  assert.deepEqual(reduced.textSpan, original.textSpan);
  assert.equal(reduced.evidenceRole, original.evidenceRole);
  assert.equal(reduced.certainty, original.certainty);
  const unlinked = retainMentionEntities(reduced, new Set());
  assert.equal(unlinked.id, 'die');
  assert.equal(unlinked.target, null);
  assert.deepEqual(getMentionTargets(unlinked), []);
});

test('multiple links survive database reads, checkpoint restoration and failed invalid saves', () => {
  const db = new LocalDatabase(':memory:');
  try {
    db.saveConversation('shared', { title: 'Cellcept and Prednison', createdAt: '2026-10-09T00:00:00Z', status: 'annotated',
      rawTranscript: 'Clinician: En je gebruikt ook nog de Cellcept en de Prednison?\nPatient: Ja ja die heb ik wel gewoon normaal gebruikt ja.',
      transcriptSegments: [
        { id: 's0', speaker: 'Clinician', text: 'En je gebruikt ook nog de Cellcept en de Prednison?' },
        { id: 's1', speaker: 'Patient', text: 'Ja ja die heb ik wel gewoon normaal gebruikt ja.' }
      ], annotation: annotation() }, true);
    const checkpoint = db.createCheckpoint('shared');
    const saved = db.getConversation('shared');
    assert.equal(saved.annotation!.mentions!.length, 1);
    assert.deepEqual(getMentionTargets(saved.annotation!.mentions![0]), targets);
    assert.throws(() => validateExtractedMentions(saved.annotation!.mentions, saved.transcriptSegments), /Invalid extracted/);
    const broken = annotation();
    broken.mentions![0].targets![1] = { kind: 'entity', entityId: 'missing' };
    assert.throws(() => db.saveConversation('shared', { annotation: broken }), /missing entity/);
    const restored = db.restoreCheckpoint('shared', checkpoint.id);
    assert.deepEqual(getMentionTargets(restored.annotation!.mentions![0]), getMentionTargets(saved.annotation!.mentions![0]));
  } finally { db.close(); }
});

test('legacy status review moves only its own link, preserving a second entity reference', () => {
  const data = annotation();
  delete data.observationStatusVersion;
  data.entities[0] = { id: 'cellcept', name: 'Finding', type: 'Symptom', categoryId: 'fhir_symptoms', attributes: [
    { id: 'old-status', name: 'status', value: 'active' }
  ] };
  data.mentions![0].targets = [{ kind: 'attribute', entityId: 'cellcept', attributeId: 'old-status' }, targets[1]];
  const reviewed = resolveLegacyStatus(data, 'cellcept', 'old-status', { kind: 'assessment', value: 'supported' });
  const links = getMentionTargets(reviewed.mentions![0]);
  const assessment = reviewed.entities[0].attributes!.find(a => a.name === 'diagnosticAssessment')!;
  assert.deepEqual(links, [{ kind: 'attribute', entityId: 'cellcept', attributeId: assessment.id }, targets[1]]);
  assert.equal(reviewed.mentions![0].id, 'die');
});

test('moving a transcript segment keeps a shared span and both representative entity spans aligned', () => {
  const data = normalizeEvidence(annotation());
  const original = [{ id: 's0', speaker: 'Clinician', text: 'Cellcept en Prednison?' },
    { id: 's1', speaker: 'Patient', text: 'Ja ja die heb ik wel gewoon normaal gebruikt ja.' }];
  const moved = [{ id: 'intro', speaker: 'Clinician', text: 'Goedemiddag.' }, ...original];
  data.mentions![0].segmentId = 's1';
  const aligned = realignMentionsWithSegments(original, moved, data.mentions!, data.entities);
  assert.equal(aligned.realignedMentions.length, 1);
  assert.equal(aligned.realignedMentions[0].textSpan.lineIndex, 2);
  assert.deepEqual(getMentionTargets(aligned.realignedMentions[0]), targets);
  assert(aligned.realignedEntities.every(e => e.textSpan?.lineIndex === 2));
});
