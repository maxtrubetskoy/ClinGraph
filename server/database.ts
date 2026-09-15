import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../src/types';
import type { AnnotationCheckpoint, AnnotationCheckpointSummary, Conversation, SessionGroup, UserAiConfig } from '../src/types';
import { schemaSnapshot, validateSchemaSnapshot } from './checkpoints';
import { normalizeEvidence } from '../src/utils/evidence';
import { normalizeTemporal, validateEncounterTime } from '../src/utils/temporal';
import { ANNOTATION_CONCURRENCY_ERROR, isValidAnnotationConcurrency } from '../src/utils/annotationConcurrency';

export class StorageError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateId(id: string) {
  if (!/^[\w-]{1,128}$/.test(id)) throw new StorageError(400, 'Invalid record ID');
}
export function validateConversation(data: any) {
  if (!isObject(data) || typeof data.title !== 'string' || !data.title.trim() ||
      typeof data.rawTranscript !== 'string' || !Array.isArray(data.transcriptSegments) ||
      !['draft', 'processing', 'annotated', 'failed'].includes(data.status) ||
      typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) {
    throw new StorageError(400, 'Invalid conversation');
  }
  if (data.transcriptSegments.some((s: any) => !isObject(s) ||
      typeof s.id !== 'string' || typeof s.speaker !== 'string' || typeof s.text !== 'string')) {
    throw new StorageError(400, 'Invalid transcript segments');
  }
  if (data.annotation != null && (!isObject(data.annotation) ||
      !Array.isArray(data.annotation.entities) || !Array.isArray(data.annotation.relations) ||
      !isObject(data.annotation.clinicalNotes) ||
      (data.annotation.mentions != null && !Array.isArray(data.annotation.mentions)))) {
    throw new StorageError(400, 'Invalid annotation');
  }
}

/** One local workspace. JSON preserves custom annotation categories and mention metadata. */
export class LocalDatabase {
  private db: DatabaseSync;
  constructor(public filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES session_groups(id) ON DELETE SET NULL,
        data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE INDEX IF NOT EXISTS conversations_group ON conversations(group_id);
      CREATE INDEX IF NOT EXISTS conversations_created ON conversations(json_extract(data, '$.createdAt') DESC);
      CREATE TABLE IF NOT EXISTS audio (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL, content BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS annotation_checkpoints (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version > 0),
        summary TEXT NOT NULL CHECK(json_valid(summary)),
        data TEXT NOT NULL CHECK(json_valid(data)),
        UNIQUE(conversation_id, version)
      );
      CREATE TRIGGER IF NOT EXISTS annotation_checkpoints_immutable
        BEFORE UPDATE ON annotation_checkpoints BEGIN
          SELECT RAISE(ABORT, 'Annotation checkpoints are immutable');
        END;
      PRAGMA user_version = 2;
    `);
  }
  close() { this.db.close(); }
  private conversation(row: any): Conversation {
    const data = JSON.parse(row.data);
    if (data.annotation) data.annotation = normalizeEvidence(data.annotation,
      data.schemaSnapshot?.categories || (row.group_id ? this.getGroup(row.group_id).settings?.annotationSchema : undefined));
    return { ...data, id: row.id, groupId: row.group_id,
      hasAudio: Boolean(row.has_audio), audioLocalId: row.has_audio ? row.id : undefined };
  }
  listConversations(): Conversation[] {
    return this.db.prepare(`SELECT c.*, EXISTS(SELECT 1 FROM audio WHERE conversation_id = c.id) AS has_audio
      FROM conversations c ORDER BY json_extract(data, '$.createdAt') DESC, id DESC`).all().map(r => this.conversation(r));
  }
  getConversation(id: string): Conversation {
    validateId(id);
    const row = this.db.prepare(`SELECT c.*, EXISTS(SELECT 1 FROM audio WHERE conversation_id = c.id) AS has_audio
      FROM conversations c WHERE id = ?`).get(id);
    if (!row) throw new StorageError(404, 'Conversation not found');
    return this.conversation(row);
  }
  saveConversation(id: string, input: unknown, create = false): Conversation {
    validateId(id);
    if (!isObject(input)) throw new StorageError(400, 'Expected a conversation object');
    if (input.id !== undefined && input.id !== id) throw new StorageError(400, 'Record ID cannot change');
    if (create && this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) {
      throw new StorageError(409, 'Conversation already exists');
    }
    const previous = create ? undefined : this.getConversation(id);
    const data = { ...previous, ...input, id } as Conversation;
    validateConversation(data);
    // A previous run's utterance indices no longer describe an edited transcript.
    if (previous && input.annotationProgress === undefined && (
      data.rawTranscript !== previous.rawTranscript ||
      JSON.stringify(data.transcriptSegments) !== JSON.stringify(previous.transcriptSegments)
    )) data.annotationProgress = null;
    if (data.groupId != null) {
      if (typeof data.groupId !== 'string') throw new StorageError(400, 'Invalid group ID');
      this.getGroup(data.groupId);
    }
    try {
      if (data.schemaSnapshot != null) validateSchemaSnapshot(data.schemaSnapshot);
      if (data.encounterTime !== undefined) {
        validateEncounterTime(data.encounterTime);
        data.encounterTime = normalizeTemporal(data.encounterTime);
      }
      if (data.annotation) data.annotation = normalizeEvidence(data.annotation,
        data.schemaSnapshot?.categories || (data.groupId ? this.getGroup(data.groupId).settings?.annotationSchema : undefined));
    } catch (error) { throw new StorageError(400, error instanceof Error ? error.message : 'Invalid annotation or encounter time'); }
    delete data.audioDataUrl;
    delete data.audioLocalId;
    const values = [data.groupId || null, JSON.stringify(data), id];
    if (create) this.db.prepare('INSERT INTO conversations (group_id, data, id) VALUES (?, ?, ?)').run(...values);
    else this.db.prepare('UPDATE conversations SET group_id = ?, data = ? WHERE id = ?').run(...values);
    return this.getConversation(id);
  }
  deleteConversation(id: string) {
    this.getConversation(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private requireConversation(id: string) {
    validateId(id);
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) {
      throw new StorageError(404, 'Conversation not found');
    }
  }
  listCheckpoints(id: string): AnnotationCheckpointSummary[] {
    this.requireConversation(id);
    return this.db.prepare('SELECT summary FROM annotation_checkpoints WHERE conversation_id = ? ORDER BY version DESC')
      .all(id).map(row => JSON.parse(row.summary as string));
  }
  getCheckpoint(conversationId: string, checkpointId: string): AnnotationCheckpoint {
    this.requireConversation(conversationId);
    validateId(checkpointId);
    const row = this.db.prepare('SELECT data FROM annotation_checkpoints WHERE conversation_id = ? AND id = ?')
      .get(conversationId, checkpointId);
    if (!row) throw new StorageError(404, 'Checkpoint not found');
    // Historical data must never pass through today's schema/annotation migrations.
    return JSON.parse(row.data as string);
  }
  createCheckpoint(id: string, input: unknown = {}): AnnotationCheckpoint {
    if (!isObject(input) || (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 200)) ||
        (input.reason !== undefined && !['manual', 'before-ai'].includes(input.reason))) {
      throw new StorageError(400, 'Invalid checkpoint label or reason');
    }
    return this.transaction(() => {
      const conversation = this.getConversation(id);
      if (conversation.status === 'processing') throw new StorageError(409, 'Wait for annotation processing to finish before checkpointing');
      const configuredSchema = conversation.schemaSnapshot?.categories ||
        (conversation.groupId ? this.getGroup(conversation.groupId).settings?.annotationSchema : undefined);
      let schema;
      try {
        schema = schemaSnapshot(normalizeAnnotationSchema(configuredSchema?.length ? configuredSchema : DEFAULT_ANNOTATION_SCHEMA));
        validateSchemaSnapshot(schema);
      } catch (error) { throw new StorageError(400, error instanceof Error ? error.message : 'Invalid annotation schema'); }
      const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM annotation_checkpoints WHERE conversation_id = ?').get(id)!;
      const summary: AnnotationCheckpointSummary = {
        id: 'checkpoint_' + randomUUID(), conversationId: id, version: Number(row.next),
        createdAt: new Date().toISOString(), label: input.label?.trim() || '', reason: input.reason || 'manual',
        schemaVersion: schema.version, entityCount: conversation.annotation?.entities.length || 0,
        mentionCount: conversation.annotation?.mentions?.length || 0,
      };
      // Explicit allowlist: no audio, provider settings, credentials, or transient UI state.
      const { title, rawTranscript, transcriptSegments, annotation, encounterTime, encounterType, status, createdAt, groupId, restoredFrom } = conversation;
      const checkpoint: AnnotationCheckpoint = {
        ...summary, snapshotFormatVersion: 1, schema,
        snapshot: { title, rawTranscript, transcriptSegments, annotation, encounterTime, encounterType, status, createdAt, groupId, restoredFrom },
      };
      this.db.prepare('INSERT INTO annotation_checkpoints (id, conversation_id, version, summary, data) VALUES (?, ?, ?, ?, ?)')
        .run(checkpoint.id, id, checkpoint.version, JSON.stringify(summary), JSON.stringify(checkpoint));
      return this.getCheckpoint(id, checkpoint.id);
    });
  }
  restoreCheckpoint(conversationId: string, checkpointId: string): Conversation {
    return this.transaction(() => {
      const checkpoint = this.getCheckpoint(conversationId, checkpointId);
      if (checkpoint.snapshotFormatVersion !== 1) throw new StorageError(409, 'Unsupported checkpoint format; download the snapshot instead');
      // Restoring forks a new working session. The original session and every checkpoint stay untouched.
      const groupId = checkpoint.snapshot.groupId;
      return this.saveConversation('session_' + randomUUID(), {
        ...checkpoint.snapshot,
        title: `${checkpoint.snapshot.title} (restored v${checkpoint.version})`,
        createdAt: new Date().toISOString(),
        groupId: groupId && this.db.prepare('SELECT 1 FROM session_groups WHERE id = ?').get(groupId) ? groupId : null,
        schemaSnapshot: checkpoint.schema,
        restoredFrom: { conversationId, checkpointId, version: checkpoint.version, schemaVersion: checkpoint.schemaVersion },
        hasAudio: false, status: checkpoint.snapshot.annotation ? 'annotated' : 'draft',
      }, true);
    });
  }
  listGroups(): SessionGroup[] {
    return this.db.prepare("SELECT id, data FROM session_groups ORDER BY json_extract(data, '$.createdAt') DESC, id DESC")
      .all().map((row: any) => ({ ...JSON.parse(row.data), id: row.id }));
  }
  getGroup(id: string): SessionGroup {
    validateId(id);
    const row = this.db.prepare('SELECT data FROM session_groups WHERE id = ?').get(id);
    if (!row) throw new StorageError(404, 'Session group not found');
    return { ...JSON.parse(row.data as string), id };
  }
  saveGroup(id: string, input: unknown, create = false): SessionGroup {
    validateId(id);
    if (!isObject(input)) throw new StorageError(400, 'Expected a group object');
    if (input.id !== undefined && input.id !== id) throw new StorageError(400, 'Record ID cannot change');
    if (create && this.db.prepare('SELECT 1 FROM session_groups WHERE id = ?').get(id)) {
      throw new StorageError(409, 'Group already exists');
    }
    const data = { ...(create ? {} : this.getGroup(id)), ...input, id } as SessionGroup;
    if (typeof data.name !== 'string' || !data.name.trim() || typeof data.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(data.createdAt)) || (data.settings != null && !isObject(data.settings))) {
      throw new StorageError(400, 'Invalid session group');
    }
    if (create) this.db.prepare('INSERT INTO session_groups (id, data) VALUES (?, ?)').run(id, JSON.stringify(data));
    else this.db.prepare('UPDATE session_groups SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
    return this.getGroup(id);
  }
  deleteGroup(id: string) {
    this.getGroup(id);
    this.db.prepare('DELETE FROM session_groups WHERE id = ?').run(id);
  }
  getAudio(id: string) {
    this.getConversation(id);
    const row = this.db.prepare('SELECT mime_type, content FROM audio WHERE conversation_id = ?').get(id);
    if (!row) throw new StorageError(404, 'Audio not found');
    return { mimeType: row.mime_type as string, content: Buffer.from(row.content as Uint8Array) };
  }
  saveAudio(id: string, mimeType: string, content: Buffer) {
    this.getConversation(id);
    if (!content.length) throw new StorageError(400, 'Audio is empty');
    if (!/^(audio\/[\w.+-]+|video\/webm|application\/octet-stream)$/.test(mimeType)) {
      throw new StorageError(400, 'Unsupported audio content type');
    }
    this.db.prepare(`INSERT INTO audio (conversation_id, mime_type, content) VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET mime_type = excluded.mime_type, content = excluded.content`)
      .run(id, mimeType, content);
    return this.getConversation(id);
  }
  deleteAudio(id: string) {
    this.getConversation(id);
    this.db.prepare('DELETE FROM audio WHERE conversation_id = ?').run(id);
    return this.getConversation(id);
  }
  getSettings(): UserAiConfig | null {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get();
    return row ? JSON.parse(row.data as string) : null;
  }
  saveSettings(input: unknown) {
    if (!isObject(input)) throw new StorageError(400, 'Invalid AI settings');
    for (const key of ['annotation', 'transcription']) {
      const config = input[key];
      if (!isObject(config) || !['gemini', 'openai'].includes(config.provider) ||
          ['model', 'apiKey', 'baseUrl'].some(field => typeof config[field] !== 'string')) {
        throw new StorageError(400, 'Invalid AI provider configuration');
      }
    }
    if (input.annotation.concurrency !== undefined && !isValidAnnotationConcurrency(input.annotation.concurrency)) {
      throw new StorageError(400, ANNOTATION_CONCURRENCY_ERROR);
    }
    this.db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(JSON.stringify(input));
    return this.getSettings();
  }
}
