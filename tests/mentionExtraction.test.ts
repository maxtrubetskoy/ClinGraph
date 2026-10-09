import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDatabase } from '../server/database';
import { validateExtractedMentions } from '../src/utils/mentionExtraction';

const segments = [{ id: 's0', speaker: 'Patient', text: 'Headache since Tuesday.' }];
const mention = { id: 'm1', entityId: null, entityType: 'Symptom', supportedAttribute: 'onset',
  canonicalName: 'Headache', evidenceRole: 'claim' as const,
  textSpan: { lineIndex: 0, startChar: 15, endChar: 22, text: 'Tuesday' } };
const extraction = { mentions: [mention], progress: { operation: 'extraction' as const, stage: 'complete' as const,
  utterances: [{ lineIndex: 0, status: 'complete' as const }] } };

test('raw mention hints survive restart and checkpoint restoration, independently of mapped annotations', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-extraction-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  try {
    db.saveConversation('s1', { title: 'Extraction', rawTranscript: 'Patient: Headache since Tuesday.',
      transcriptSegments: segments, createdAt: '2026-01-01T00:00:00Z', status: 'draft', mentionExtraction: extraction }, true);
    const checkpoint = db.createCheckpoint('s1');
    db.close();
    db = new LocalDatabase(filename);
    assert.deepEqual(db.getConversation('s1').mentionExtraction, extraction);
    assert.deepEqual(db.getCheckpoint('s1', checkpoint.id).snapshot.mentionExtraction, extraction);
    assert.throws(() => db.saveConversation('s1', { mentionExtraction: { ...extraction, mentions: [mention, mention] } }), /duplicate/);
    assert.deepEqual(db.getConversation('s1').mentionExtraction, extraction);
    db.saveConversation('s1', { rawTranscript: 'Patient: Nausea.' });
    assert.equal(db.getConversation('s1').mentionExtraction, null);
    const restored = db.restoreCheckpoint('s1', checkpoint.id);
    assert.equal(restored.status, 'draft');
    assert.deepEqual(restored.mentionExtraction, extraction);
    assert.equal(db.getConversation('s1').mentionExtraction, null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('mapping rejects stale, duplicated, already mapped, or malformed spans while accepting empty extractions', () => {
  assert.doesNotThrow(() => validateExtractedMentions([], segments));
  assert.doesNotThrow(() => validateExtractedMentions([mention], segments));
  for (const mentions of [undefined, {}, [null], [mention, mention], [{ ...mention, entityId: 'e1' }],
    [{ ...mention, supportedAttribute: {} }], [{ ...mention, textSpan: { ...mention.textSpan, lineIndex: 1 } }],
    [{ ...mention, textSpan: { ...mention.textSpan, startChar: 14 } }],
    [{ ...mention, textSpan: { ...mention.textSpan, endChar: 100 } }]]) {
    assert.throws(() => validateExtractedMentions(mentions, segments));
  }
  assert.throws(() => validateExtractedMentions([mention], [{ ...segments[0], text: 'Nausea.' }]), /no longer match/);
});

test('superseded annotation runs cannot overwrite a newer run or an edited source', () => {
  const db = new LocalDatabase(':memory:');
  try {
    db.saveConversation('s1', { title: 'Run ownership', rawTranscript: 'Patient: Headache since Tuesday.',
      transcriptSegments: segments, createdAt: '2026-01-01T00:00:00Z', status: 'draft', mentionExtraction: extraction }, true);
    db.saveConversation('s1', { status: 'processing', annotationRunId: 'run1', expectedAnnotationRunId: null });
    assert.throws(() => db.saveConversation('s1', { status: 'processing', annotationRunId: 'run2', expectedAnnotationRunId: null }), /superseded/);
    db.saveConversation('s1', { status: 'draft', annotationRunId: null, expectedAnnotationRunId: 'run1' });
    assert.throws(() => db.saveConversation('s1', { status: 'annotated', expectedAnnotationRunId: 'run1' }), /superseded/);
    db.saveConversation('s1', { status: 'processing', annotationRunId: 'run2', expectedAnnotationRunId: null });
    db.saveConversation('s1', { rawTranscript: 'Patient: Nausea.' });
    assert.throws(() => db.saveConversation('s1', { rawTranscript: 'Patient: Headache since Tuesday.',
      mentionExtraction: extraction, expectedAnnotationRunId: 'run2' }), /superseded/);
    assert.equal(db.getConversation('s1').rawTranscript, 'Patient: Nausea.');
    assert(!('expectedAnnotationRunId' in db.getConversation('s1')));
  } finally { db.close(); }
});
