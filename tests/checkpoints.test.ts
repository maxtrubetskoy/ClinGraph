import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalDatabase, StorageError } from '../server/database';
import { schemaSnapshot, validateSchemaSnapshot } from '../server/checkpoints';
import { DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../src/types';
import type { AnnotationCategory, Conversation } from '../src/types';
import { generateJsonlContent } from '../src/utils/exportJsonl';

const schema: AnnotationCategory[] = [{ id: 'custom_finding', displayName: 'Study findings', entityType: 'Observation', attributes: [
  { name: 'name', type: 'text' }, { name: 'interpretation', type: 'select', choices: ['unassigned', 'stable', 'unstable'] },
  { name: 'comment', type: 'textarea', hint: 'Do not infer' }, { name: 'count', type: 'number' }, { name: 'reviewed', type: 'boolean' },
] }];
const session: Conversation = {
  id: 's1', title: 'Checkpoint synthetic', status: 'annotated', createdAt: '2026-01-01T00:00:00Z', hasAudio: false,
  encounterType: 'dialogue', rawTranscript: 'Clinician: Stable — déjà vu.\r\n',
  transcriptSegments: [{ id: 'seg-original', speaker: 'Clinician', text: 'Stable — déjà vu.', timestamp: '00:01' }],
  encounterTime: { type: 'temporal', kind: 'absolute', date: '2026-01', precision: 'month', qualifier: 'exact' },
  annotation: { evidenceVersion: 2, entities: [{ id: 'e1', type: 'Observation', categoryId: 'custom_finding', name: 'Kidney function',
    attributes: [{ id: 'interpretation-1', name: 'interpretation', value: 'stable' }] }],
    mentions: [{ id: 'm1', entityId: 'e1', entityType: 'Observation', evidenceRole: 'claim', function: 'asserted', certainty: 'certain',
      target: { kind: 'attribute', entityId: 'e1', attributeId: 'interpretation-1' },
      textSpan: { segmentId: 'seg-original', lineIndex: 0, startChar: 0, endChar: 6, text: 'Stable' } }],
    relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } },
};
function seed(db: LocalDatabase) {
  db.saveGroup('g1', { name: 'Study', createdAt: session.createdAt, settings: { annotationSchema: schema } }, true);
  return db.saveConversation('s1', { ...session, groupId: 'g1' }, true);
}

test('checkpoints preserve exact source, annotation, schema and timestamps through edits and restarts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-checkpoints-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let db = new LocalDatabase(filename);
  try {
    const initial = seed(db);
    db.saveAudio('s1', 'audio/webm', Buffer.from('synthetic recording'));
    const config = { model: 'test', provider: 'openai' as const, baseUrl: '', apiKey: 'synthetic-secret-never-export' };
    db.saveSettings({ annotation: config, transcription: config });
    const first = db.createCheckpoint('s1', { label: ' Reviewed baseline ' });
    assert.equal(first.version, 1);
    assert.equal(first.label, 'Reviewed baseline');
    assert.equal(first.snapshotFormatVersion, 1);
    assert.equal(first.snapshot.rawTranscript, session.rawTranscript);
    assert.deepEqual(first.snapshot.transcriptSegments, session.transcriptSegments);
    assert.deepEqual(first.snapshot.annotation, initial.annotation);
    assert.deepEqual(first.snapshot.encounterTime, initial.encounterTime);
    assert.deepEqual(first.schema, schemaSnapshot(normalizeAnnotationSchema(schema)));
    assert.equal(first.schemaVersion, first.schema.version);
    assert.equal(first.entityCount, 1); assert.equal(first.mentionCount, 1);
    assert(Number.isFinite(Date.parse(first.createdAt)));
    assert(!JSON.stringify(first).includes('synthetic-secret'));
    assert(!('hasAudio' in first.snapshot));
    assert(!('audioLocalId' in first.snapshot));
    const second = db.createCheckpoint('s1');
    assert.equal(second.version, 2);
    assert.equal(second.schemaVersion, first.schemaVersion);
    const changed = structuredClone(initial.annotation!);
    changed.entities[0].attributes![0].value = 'unstable';
    db.saveConversation('s1', { annotation: changed, rawTranscript: 'New source', transcriptSegments: [] });
    const nextSchema = structuredClone(schema);
    nextSchema[0].attributes[1].hint = 'New annotation guideline';
    db.saveGroup('g1', { settings: { annotationSchema: nextSchema } });
    const third = db.createCheckpoint('s1', { reason: 'before-ai' });
    assert.equal(third.version, 3);
    assert.notEqual(third.schemaVersion, first.schemaVersion);
    assert.equal(third.reason, 'before-ai');
    assert.equal(third.snapshot.rawTranscript, 'New source');
    db.close(); db = new LocalDatabase(filename);
    assert.deepEqual(db.getCheckpoint('s1', first.id), first);
    assert.deepEqual(db.listCheckpoints('s1').map(row => row.version), [3, 2, 1]);
    assert(!('snapshot' in db.listCheckpoints('s1')[0]));
    const connection = new DatabaseSync(filename);
    try {
      assert.equal(connection.prepare('PRAGMA user_version').get()!.user_version, 2);
      assert.throws(() => connection.prepare('UPDATE annotation_checkpoints SET data = ? WHERE id = ?').run('{}', first.id), /immutable/);
    } finally { connection.close(); }
    // API callers cannot mutate stored objects by retaining references.
    first.schema.categories[0].displayName = 'Mutated client object';
    assert.notEqual(db.getCheckpoint('s1', first.id).schema.categories[0].displayName, 'Mutated client object');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('restore forks an independent session with captured schema, source, IDs and provenance; original stays unchanged', () => {
  const db = new LocalDatabase(':memory:');
  try {
    seed(db);
    db.saveAudio('s1', 'audio/webm', Buffer.from('synthetic audio'));
    const checkpoint = db.createCheckpoint('s1');
    db.saveConversation('s1', { rawTranscript: 'Edited source', transcriptSegments: [] });
    db.saveGroup('g1', { settings: { annotationSchema: [{ ...schema[0], displayName: 'Changed group schema', attributes: [] }] } });
    const original = db.getConversation('s1');
    const restored = db.restoreCheckpoint('s1', checkpoint.id);
    assert.notEqual(restored.id, 's1');
    assert.equal(restored.groupId, 'g1');
    assert.equal(restored.rawTranscript, checkpoint.snapshot.rawTranscript);
    assert.deepEqual(restored.transcriptSegments, checkpoint.snapshot.transcriptSegments);
    assert.deepEqual(restored.annotation, checkpoint.snapshot.annotation);
    assert.deepEqual(restored.schemaSnapshot, checkpoint.schema);
    assert.deepEqual(restored.restoredFrom, { conversationId: 's1', checkpointId: checkpoint.id, version: 1, schemaVersion: checkpoint.schemaVersion });
    assert.equal(restored.hasAudio, false);
    assert.deepEqual(db.getConversation('s1'), original);
    assert.deepEqual(db.getCheckpoint('s1', checkpoint.id), checkpoint);
    const restoredCheckpoint = db.createCheckpoint(restored.id);
    assert.equal(restoredCheckpoint.schemaVersion, checkpoint.schemaVersion);
    assert.deepEqual(restoredCheckpoint.snapshot.restoredFrom, restored.restoredFrom);
    const exported = JSON.parse(generateJsonlContent('full_dataset', restored, restored.annotation!.entities,
      restored.annotation!.mentions, restored.annotation!.relations, restored.annotation!.clinicalNotes));
    assert.deepEqual(exported.schemaSnapshot, checkpoint.schema);
    assert.deepEqual(exported.restoredFrom, restored.restoredFrom);
    db.deleteGroup('g1');
    const afterGroupDeletion = db.restoreCheckpoint('s1', checkpoint.id);
    assert.equal(afterGroupDeletion.groupId, null);
    assert.deepEqual(afterGroupDeletion.schemaSnapshot, checkpoint.schema);
    db.deleteConversation('s1');
    assert.deepEqual(db.getConversation(restored.id).annotation, checkpoint.snapshot.annotation);
    assert.equal(db.createCheckpoint(restored.id).schemaVersion, checkpoint.schemaVersion);
    db.saveConversation(restored.id, { schemaSnapshot: null });
    assert.equal(db.createCheckpoint(restored.id).schemaVersion, schemaSnapshot(normalizeAnnotationSchema(DEFAULT_ANNOTATION_SCHEMA)).version);
  } finally { db.close(); }
});

test('schema versions ignore object-key order but track definitions, ordering, choices and hints', () => {
  const version = schemaSnapshot(schema).version;
  const reordered = schema.map(({ attributes, entityType, displayName, id }) => ({ attributes, entityType, displayName, id }));
  assert.equal(schemaSnapshot(reordered).version, version);
  for (const mutate of [
    (copy: AnnotationCategory[]) => { copy[0].attributes.reverse(); },
    (copy: AnnotationCategory[]) => { copy[0].attributes[1].choices!.push('other'); },
    (copy: AnnotationCategory[]) => { copy[0].attributes[0].hint = 'Changed definition'; },
  ]) {
    const copy = structuredClone(schema); mutate(copy);
    assert.notEqual(schemaSnapshot(copy).version, version);
  }
  validateSchemaSnapshot(schemaSnapshot(schema));
  validateSchemaSnapshot(schemaSnapshot(normalizeAnnotationSchema(DEFAULT_ANNOTATION_SCHEMA)));
  assert.throws(() => validateSchemaSnapshot({ version: 'made-up', categories: schema }), /schema version/);
  assert.throws(() => validateSchemaSnapshot({ version, categories: 'wrong' }), /Invalid schema/);
});

test('invalid requests roll back; checkpoint IDs are session-scoped and deletion removes only that session history', () => {
  const db = new LocalDatabase(':memory:');
  try {
    seed(db);
    db.saveConversation('s2', { ...session, id: 's2', annotation: undefined, status: 'draft' }, true);
    const original = db.getConversation('s1');
    for (const input of [null, [], { label: 42 }, { label: 'x'.repeat(201) }, { reason: 'invented' }]) {
      assert.throws(() => db.createCheckpoint('s1', input), (error: StorageError) => error.status === 400);
    }
    assert.equal(db.listCheckpoints('s1').length, 0);
    const checkpoint = db.createCheckpoint('s1');
    assert.equal(checkpoint.version, 1);
    assert.throws(() => db.getCheckpoint('s2', checkpoint.id), (error: StorageError) => error.status === 404);
    assert.throws(() => db.restoreCheckpoint('s2', checkpoint.id), (error: StorageError) => error.status === 404);
    assert.equal(db.listConversations().length, 2);
    assert.deepEqual(db.getConversation('s1'), original);
    assert.throws(() => db.saveConversation('s1', { schemaSnapshot: { version: 'fake', categories: schema } }), (error: StorageError) => error.status === 400);
    db.saveConversation('s1', { status: 'processing' });
    assert.throws(() => db.createCheckpoint('s1'), (error: StorageError) => error.status === 409);
    assert.equal(db.listCheckpoints('s1').length, 1);
    const draft = db.createCheckpoint('s2');
    assert.equal(draft.snapshot.annotation, undefined);
    assert.equal(db.restoreCheckpoint('s2', draft.id).status, 'draft');
    db.deleteConversation('s1');
    db.saveConversation('s1', session, true);
    assert.deepEqual(db.listCheckpoints('s1'), []);
    assert.equal(db.listCheckpoints('s2').length, 1);
    assert.throws(() => db.listCheckpoints('missing'), (error: StorageError) => error.status === 404);
  } finally { db.close(); }
});
