import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnnotationData, Mention } from '../src/types';
import { normalizeMentionContext, setMentionEvidenceRole, summarizeEntityClaims } from '../src/utils/mentionContext';
import { normalizeEvidence, retargetMention, buildEvidenceGraph } from '../src/utils/evidence';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { LocalDatabase, StorageError } from '../server/database';

const mention = (changes: Partial<Mention> = {}): Mention => ({
  id: 'm1', entityId: 'e1', entityType: 'Observation', speaker: 'Clinician',
  target: { kind: 'entity', entityId: 'e1' },
  textSpan: { lineIndex: 0, startChar: 0, endChar: 15, text: 'kidney function' }, ...changes
});
const annotation = (mentions: Mention[] = [mention()]): AnnotationData => ({
  evidenceVersion: 2, entities: [{ id: 'e1', name: 'Kidney function', type: 'Observation', categoryId: 'fhir_observations',
    attributes: [{ id: 'interpretation-1', name: 'interpretation', value: 'Low' }] }],
  mentions, relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] }
});

test('legacy roles remain unassigned without losing explicit labels, targets, spans, or input', () => {
  const input = annotation([
    mention({ certainty: 'certain', function: 'asserted', polarity: 'positive', experiencer: 'patient', temporality: 'current' }),
    mention({ id: 'm2', certainty: 'uncertain', function: 'asserted', target: { kind: 'attribute', entityId: 'e1', attributeId: 'interpretation-1' } }),
    mention({ id: 'm3', target: null })
  ]);
  const original = structuredClone(input);
  const normalized = normalizeEvidence(input);
  assert.deepEqual(input, original);
  assert.equal(normalized.mentionContextVersion, 1);
  for (const [i, current] of normalized.mentions!.entries()) {
    assert.equal(current.evidenceRole, 'unassigned');
    assert.deepEqual(current.target, original.mentions![i].target);
    assert.deepEqual(current.textSpan, original.mentions![i].textSpan);
    assert.equal(current.certainty, original.mentions![i].certainty || 'unassigned');
    assert.equal(current.function, original.mentions![i].function || 'unassigned');
  }
  assert.equal(summarizeEntityClaims(normalized.mentions!, 'e1').claimCount, 0);
  assert.deepEqual(normalizeEvidence(normalized), normalized);
});

test('references have no claim certainty but may participate in questions; tentative claims can be asserted', () => {
  const reference = normalizeMentionContext(mention({ evidenceRole: 'reference' }));
  assert.equal(reference.certainty, 'not_applicable');
  assert.equal(reference.function, 'not_applicable');
  assert.equal(reference.polarity, 'neutral');
  assert.equal(reference.temporality, 'not_applicable');
  const normalizedReference = normalizeEvidence(annotation([mention({ evidenceRole: 'reference' })])).mentions![0];
  assert.equal(normalizedReference.function, 'not_applicable');
  assert.equal(normalizedReference.polarity, 'neutral');
  assert.equal(normalizedReference.temporality, 'not_applicable');
  const question = normalizeMentionContext(mention({ evidenceRole: 'reference', function: 'questioned' }));
  assert.equal(question.certainty, 'not_applicable');
  assert.equal(question.function, 'questioned');
  assert.equal(question.temporality, 'not_applicable');
  assert.equal(question.polarity, 'neutral');
  const claim = normalizeMentionContext(mention({ evidenceRole: 'claim', certainty: 'uncertain', function: 'asserted' }));
  assert.equal(claim.certainty, 'uncertain');
  assert.equal(claim.function, 'asserted');
  const missing = normalizeMentionContext(mention());
  assert.equal(missing.certainty, 'unassigned');
  assert.equal(missing.function, 'unassigned');
  assert.equal(missing.polarity, 'unassigned');
  assert.equal(missing.temporality, 'unassigned');
});

test('reference defaults never overwrite explicit saved polarity or temporality, including unassigned', () => {
  for (const [polarity, temporality] of [['negative', 'past'], ['positive', 'future'], ['unassigned', 'unassigned'], ['neutral', 'not_applicable']]) {
    const source = mention({ evidenceRole: 'reference', certainty: 'not_applicable', function: 'questioned', polarity, temporality });
    const normalized = normalizeEvidence(annotation([source]));
    assert.equal(normalized.mentions![0].polarity, polarity);
    assert.equal(normalized.mentions![0].temporality, temporality);
    assert.deepEqual(normalizeEvidence(normalized), normalized);
  }
});

test('role and target are independent; retargeting never reclassifies or propagates context', () => {
  const source = normalizeMentionContext(mention({ evidenceRole: 'claim', certainty: 'uncertain', function: 'asserted', polarity: 'positive', temporality: 'future' }));
  const moved = retargetMention(source, { kind: 'attribute', entityId: 'e1', attributeId: 'interpretation-1' });
  assert.equal(moved.evidenceRole, 'claim');
  assert.equal(moved.certainty, 'uncertain');
  assert.equal(moved.temporality, 'future');
  assert.deepEqual(moved.textSpan, source.textSpan);
  assert.equal(retargetMention(moved, null).evidenceRole, 'claim');
  const reference = setMentionEvidenceRole(source, 'reference');
  assert.equal(reference.certainty, 'not_applicable');
  assert.equal(reference.function, 'not_applicable');
  assert.equal(reference.polarity, 'neutral');
  assert.equal(reference.temporality, 'not_applicable');
  assert.deepEqual(reference.target, source.target);
  assert.equal(source.certainty, 'uncertain');
  const reconsidered = setMentionEvidenceRole(reference, 'claim');
  assert.equal(reconsidered.certainty, 'unassigned');
  assert.equal(reconsidered.function, 'unassigned');
  assert.equal(reconsidered.polarity, 'unassigned');
  assert.equal(reconsidered.temporality, 'unassigned');
  assert.equal(setMentionEvidenceRole({ ...source, function: 'questioned' }, 'reference').function, 'questioned');
});

test('invalid roles and claim certainty on explicit references are rejected, including unlinked mentions', () => {
  assert.throws(() => normalizeEvidence(annotation([mention({ evidenceRole: 'invented' as any })])), /Invalid mention evidence role/);
  assert.throws(() => normalizeEvidence(annotation([mention({ evidenceRole: 'reference', certainty: 'certain', target: null })])), /cannot carry claim certainty/);
  assert.throws(() => normalizeEvidence({ ...annotation(), mentionContextVersion: 2 as any }), /Unsupported mention context version/);
  assert.doesNotThrow(() => normalizeEvidence(annotation([mention({ certainty: 'custom legacy value' })])));
});

test('claim summaries exclude references, attribute claims, questions, and unreviewed labels without inventing defaults', () => {
  const base = mention({ evidenceRole: 'claim', function: 'asserted', experiencer: 'patient', certainty: 'uncertain' });
  const others: Mention[] = [
    { ...base, id: 'ref', evidenceRole: 'reference', certainty: 'not_applicable', polarity: 'negative' },
    { ...base, id: 'legacy', evidenceRole: 'unassigned', certainty: 'certain' },
    { ...base, id: 'question', function: 'questioned', certainty: 'certain' },
    { ...base, id: 'attribute', certainty: 'certain', target: { kind: 'attribute', entityId: 'e1', attributeId: 'interpretation-1' } },
    { ...base, id: 'missing-function', function: undefined, certainty: 'certain' },
    { ...base, id: 'missing-experiencer', experiencer: undefined, certainty: 'certain' },
  ];
  assert.equal(summarizeEntityClaims(others, 'e1').claimCount, 0);
  const summary = summarizeEntityClaims([base, ...others], 'e1');
  assert.equal(summary.claimCount, 1);
  assert.deepEqual(summary.certainty, { conflict: false, text: '1 uncertain' });
  assert.deepEqual(summary.polarity, { conflict: false, text: 'unassigned' });
  assert.deepEqual(summary.temporality, { conflict: false, text: 'unassigned' });
  const current = { ...base, temporality: 'current' };
  const futureQuestion = { ...base, id: 'future-question', temporality: 'future', function: 'questioned' };
  const timeless = { ...base, id: 'timeless', temporality: 'not_applicable' };
  const unannotated = { ...base, id: 'unannotated', temporality: 'unassigned' };
  assert.deepEqual(summarizeEntityClaims([current, futureQuestion, timeless, unannotated], 'e1').temporality,
    { conflict: false, text: '1 current' });
  assert.deepEqual(summarizeEntityClaims([timeless], 'e1').temporality, { conflict: false, text: 'Not applicable' });
  assert.deepEqual(summarizeEntityClaims([timeless, unannotated], 'e1').temporality,
    { conflict: false, text: '1 Not applicable, 1 unassigned' });
});

test('graph and all evidence exports preserve role, not-applicable context, and claim scope', () => {
  const input = normalizeEvidence(annotation([
    mention({ evidenceRole: 'reference', function: 'questioned' }),
    mention({ id: 'm2', evidenceRole: 'claim', certainty: 'uncertain', function: 'asserted',
      target: { kind: 'attribute', entityId: 'e1', attributeId: 'interpretation-1' },
      textSpan: { lineIndex: 0, startChar: 16, endChar: 30, text: 'may be reduced' } })
  ]));
  const args = [{ id: 's1', annotation: input }, input.entities, input.mentions!, input.relations] as const;
  const graph = buildEvidenceGraph('s1', 'Synthetic', input);
  assert.equal(graph.nodes.find(n => n.mentionId === 'm1')!.certainty, 'not_applicable');
  assert.equal(graph.nodes.find(n => n.mentionId === 'm1')!.polarity, 'neutral');
  assert.equal(graph.nodes.find(n => n.mentionId === 'm1')!.temporality, 'not_applicable');
  assert.equal(graph.nodes.find(n => n.mentionId === 'm2')!.evidenceRole, 'claim');
  const full = JSON.parse(generateJsonlContent('full_dataset', ...args));
  assert.equal(full.mentionContextVersion, 1);
  assert.deepEqual(full.mentions, input.mentions);
  const rows = generateJsonlContent('mentions', ...args).split('\n').map(row => JSON.parse(row));
  assert.equal(rows[0].certainty, 'not_applicable');
  assert.equal(rows[0].polarity, 'neutral');
  assert.equal(rows[0].temporality, 'not_applicable');
  assert.equal(rows[1].certainty, 'uncertain');
  assert.equal(rows[1].attribute.id, 'interpretation-1');
  const entity = JSON.parse(generateJsonlContent('entities_mentions', ...args));
  assert.equal(entity.mentions[0].evidenceRole, 'reference');
  assert.equal(entity.mentions[0].temporality, 'not_applicable');
  assert.equal(entity.mentions[0].polarity, 'neutral');
  assert.equal(entity.attributes.find((a: any) => a.id === 'interpretation-1').mentions[0].evidenceRole, 'claim');
});

test('SQLite migrates roles without rewriting old rows, preserves edits on restart, and rejects invalid updates', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-mention-context-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  const raw = new DatabaseSync(filename);
  const old = { id: 's1', title: 'Synthetic mention context', createdAt: '2026-09-11T00:00:00Z',
    rawTranscript: 'Kidney function', transcriptSegments: [], status: 'annotated',
    annotation: annotation([mention({ certainty: 'certain', function: 'asserted' })]) };
  try {
    const stored = JSON.stringify(old);
    raw.prepare('INSERT INTO conversations (id, data) VALUES (?, ?)').run('s1', stored);
    const loaded = db.getConversation('s1');
    assert.equal(loaded.annotation!.mentions![0].evidenceRole, 'unassigned');
    assert.equal(loaded.annotation!.mentions![0].certainty, 'certain');
    assert.equal(raw.prepare('SELECT data FROM conversations WHERE id = ?').get('s1')!.data, stored);
    loaded.annotation!.mentions![0] = setMentionEvidenceRole(loaded.annotation!.mentions![0], 'reference');
    db.saveConversation('s1', { annotation: loaded.annotation });
    db.close();
    db = new LocalDatabase(filename);
    const saved = db.getConversation('s1');
    assert.deepEqual(saved.annotation, loaded.annotation);
    assert.equal(saved.annotation!.mentions![0].temporality, 'not_applicable');
    assert.equal(saved.annotation!.mentions![0].polarity, 'neutral');
    const invalid = structuredClone(saved.annotation!);
    invalid.mentions![0].certainty = 'certain';
    assert.throws(() => db.saveConversation('s1', { annotation: invalid }), (error: StorageError) => error.status === 400);
    assert.deepEqual(db.getConversation('s1'), saved);
  } finally { raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
