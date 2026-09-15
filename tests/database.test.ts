import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDatabase, StorageError } from '../server/database';
import { aiExtractionConcurrency, mapConcurrent } from '../server/concurrency';
import { normalizeEvidence } from '../src/utils/evidence';
import { DatabaseSync } from 'node:sqlite';

const session = {
  id: 's1', title: 'Synthetic encounter', createdAt: '2026-01-01T00:00:00.000Z',
  rawTranscript: 'Patient: No headache.', transcriptSegments: [{ id: 'seg1', speaker: 'Patient', text: 'No headache.' }],
  hasAudio: false, status: 'annotated' as const,
  annotation: {
    entities: [{ id: 'e1', name: 'Headache', type: 'custom_symptoms' }], relations: [],
    clinicalNotes: { symptoms: [], medications: [], followUps: [], custom_symptoms: [{ entityId: 'e1', context: 'screened' }] },
    mentions: [{ id: 'm1', entityId: 'e1', entityType: 'custom_symptoms', polarity: 'negative',
      temporality: 'current', certainty: 'certain', experiencer: 'patient', function: 'asserted',
      textSpan: { segmentId: 'seg1', lineIndex: 0, startChar: 3, endChar: 11, text: 'headache' } }],
  },
};

test('custom annotation metadata, schema, audio, and settings survive a database restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-db-test-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  try {
    const group = { id: 'g1', name: 'Custom study', createdAt: session.createdAt,
      settings: { annotationSchema: [{ id: 'custom_symptoms', entityType: 'Symptom', displayName: 'Custom', attributes: [] }] } };
    db.saveGroup('g1', group, true);
    db.saveConversation('s1', { ...session, groupId: 'g1' }, true);
    db.saveAudio('s1', 'audio/webm', Buffer.from('synthetic audio bytes'));
    const config = { provider: 'openai', model: 'local-model', baseUrl: 'http://localhost:1234/v1', apiKey: '' };
    db.saveSettings({ annotation: { ...config, concurrency: 6 }, transcription: config });
    db.close();
    db = new LocalDatabase(filename);
    const restored = db.getConversation('s1');
    assert.deepEqual(restored.annotation, normalizeEvidence(session.annotation));
    assert.deepEqual(db.getGroup('g1'), group);
    assert.equal(restored.audioLocalId, 's1');
    assert.equal(restored.hasAudio, true);
    assert.equal(db.getAudio('s1').content.toString(), 'synthetic audio bytes');
    assert.equal(db.getSettings()?.annotation.model, 'local-model');
    assert.equal(db.getSettings()?.annotation.concurrency, 6);
    const savedSettings = db.getSettings()!;
    for (const concurrency of [0, 33, 1.5, '6', null]) {
      assert.throws(() => db.saveSettings({ ...savedSettings, annotation: { ...savedSettings.annotation, concurrency } }),
        (error: StorageError) => error.status === 400 && /concurrency/.test(error.message));
      assert.deepEqual(db.getSettings(), savedSettings);
    }
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('patches replace nested annotations, group removal detaches sessions, and audio cascades on deletion', () => {
  const db = new LocalDatabase(':memory:');
  try {
    db.saveGroup('g1', { name: 'Study', createdAt: session.createdAt }, true);
    db.saveConversation('s1', { ...session, groupId: 'g1' }, true);
    db.saveAudio('s1', 'audio/wav', Buffer.from('recording'));
    const empty = { entities: [], mentions: [], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } };
    db.saveConversation('s1', { annotation: empty, rawTranscript: '', transcriptSegments: [] });
    assert.deepEqual(db.getConversation('s1').annotation, normalizeEvidence(empty));
    assert.equal(db.getConversation('s1').title, session.title);
    db.deleteGroup('g1');
    assert.equal(db.getConversation('s1').groupId, null);
    db.deleteConversation('s1');
    assert.throws(() => db.saveConversation('s1', { title: 'Late write' }), (err: StorageError) => err.status === 404);
    db.saveConversation('s1', session, true);
    assert.equal(db.getConversation('s1').hasAudio, false);
    assert.throws(() => db.getAudio('s1'), (err: StorageError) => err.status === 404);
  } finally { db.close(); }
});

test('invalid IDs, payloads, duplicate creates, and missing groups cannot corrupt existing records', () => {
  const db = new LocalDatabase(':memory:');
  try {
    db.saveConversation('s1', session, true);
    assert.throws(() => db.saveConversation('../escape', session, true), StorageError);
    assert.throws(() => db.saveConversation('s1', session, true), (err: StorageError) => err.status === 409);
    assert.throws(() => db.saveConversation('s1', { transcriptSegments: 'invalid' }), StorageError);
    assert.throws(() => db.saveConversation('s1', { groupId: 'missing' }), StorageError);
    assert.throws(() => db.saveConversation('s1', { id: 'other' }), StorageError);
    assert.deepEqual(db.getConversation('s1').transcriptSegments, session.transcriptSegments);
  } finally { db.close(); }
});

test('legacy rows migrate on read without rewriting storage and attribute IDs survive reopening', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-migration-test-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  const old = { ...session, annotation: { ...session.annotation, mentions: [
    ...session.annotation.mentions,
    { ...session.annotation.mentions[0], id: 'm2', supportedAttribute: 'context' }
  ] } };
  try {
    const raw = new DatabaseSync(filename);
    try {
      raw.prepare('INSERT INTO conversations (id, data) VALUES (?, ?)').run('s1', JSON.stringify(old));
      const migrated = db.getConversation('s1');
      assert.equal(migrated.annotation!.mentions![1].target!.kind, 'attribute');
      assert.deepEqual(JSON.parse(raw.prepare('SELECT data FROM conversations WHERE id = ?').get('s1')!.data as string), old);
      db.saveConversation('s1', { annotation: migrated.annotation });
      const stored = JSON.parse(raw.prepare('SELECT data FROM conversations WHERE id = ?').get('s1')!.data as string);
      assert.equal(stored.annotation.evidenceVersion, 2);
      db.close();
      db = new LocalDatabase(filename);
      assert.deepEqual(db.getConversation('s1').annotation, migrated.annotation);
    } finally { raw.close(); }
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('extraction concurrency defaults to four, accepts overrides, and rejects invalid settings', () => {
  const previous = process.env.CLINGRAPH_AI_CONCURRENCY;
  try {
    delete process.env.CLINGRAPH_AI_CONCURRENCY;
    assert.equal(aiExtractionConcurrency(), 4);
    for (const value of ['1', '3', '8', '32']) {
      process.env.CLINGRAPH_AI_CONCURRENCY = value;
      assert.equal(aiExtractionConcurrency(), Number(value));
    }
    assert.equal(aiExtractionConcurrency(6), 6, 'A frontend selection overrides the environment default');
    for (const value of [0, -1, 1.5, 33, '4', '', null, true]) {
      assert.throws(() => aiExtractionConcurrency(value), (error: any) => error.status === 400 && /concurrency/.test(error.message));
    }
    for (const value of ['', '0', '-1', '1.5', '33', 'Infinity', 'abc']) {
      process.env.CLINGRAPH_AI_CONCURRENCY = value;
      assert.throws(aiExtractionConcurrency, /CLINGRAPH_AI_CONCURRENCY/);
    }
  } finally {
    if (previous === undefined) delete process.env.CLINGRAPH_AI_CONCURRENCY;
    else process.env.CLINGRAPH_AI_CONCURRENCY = previous;
  }
});

test('concurrency pool preserves order and handles rejection without an orphaned rejecting promise', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([4, 3, 2, 1], 2, async value => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, value));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [8, 6, 4, 2]);
  assert.equal(peak, 2);
  await assert.rejects(mapConcurrent([1, 2, 3], 2, async () => { throw new Error('provider failed'); }), /provider failed/);
  await assert.rejects(mapConcurrent([], 0, async () => 1), /positive integer/);
});
