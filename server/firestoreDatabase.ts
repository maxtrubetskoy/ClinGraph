import { randomUUID } from 'node:crypto';
import type { Firestore, DocumentReference, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { StorageError, isObject, validateConversation, validateId } from './database';
import { schemaSnapshot, validateSchemaSnapshot } from './checkpoints';
import { normalizeEvidence } from '../src/utils/evidence';
import { normalizeTemporal, validateEncounterTime } from '../src/utils/temporal';
import { parseTranscriptToSegments } from '../src/utils/transcriptParser';
import { ANNOTATION_CONCURRENCY_ERROR, isValidAnnotationConcurrency } from '../src/utils/annotationConcurrency';
import { DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../src/types';
import type { AnnotationCheckpoint, AnnotationCheckpointSummary, Conversation, SessionGroup, UserAiConfig } from '../src/types';
import type { WorkspaceDatabase } from './workspace';

const jsonCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const newestFirst = <T extends { createdAt: string; id: string }>(rows: T[]) => rows.sort((a, b) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

/** User-scoped storage over the original AI Studio collections. */
export class FirestoreDatabase implements WorkspaceDatabase {
  private prefix: string;
  constructor(private db: Firestore, private bucket: Bucket, private userId: string) {
    if (!userId || userId.includes('/') || userId.length > 128) throw new StorageError(401, 'Invalid signed-in user');
    this.prefix = `clingraph/${encodeURIComponent(db.databaseId)}/users/${encodeURIComponent(userId)}/`;
  }

  private ref(collection: string, id: string) {
    validateId(id);
    return this.db.collection(collection).doc(id);
  }
  private read(ref: DocumentReference, tx?: Transaction) { return tx ? tx.get(ref) : ref.get(); }
  private async owned(collection: string, id: string, tx?: Transaction) {
    const snapshot = await this.read(this.ref(collection, id), tx);
    if (!snapshot.exists || snapshot.data()!.userId !== this.userId) throw new StorageError(404, 'Record not found');
    return snapshot;
  }
  private file(path: string) {
    if (!path.startsWith(this.prefix)) throw new StorageError(403, 'Invalid workspace object');
    return this.bucket.file(path);
  }
  private async decode(snapshot: DocumentSnapshot): Promise<any> {
    const document = snapshot.data()!;
    if (document.payloadFormat === 1) {
      const payload = document.payload ?? (await this.file(document.payloadPath).download())[0].toString('utf8');
      return JSON.parse(payload);
    }
    // Existing Firestore records used fields directly. Reads do not rewrite them.
    return { ...document, id: snapshot.id };
  }
  private async encode(value: unknown, scope: string) {
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, 'utf8') <= 700_000) return { payloadFormat: 1, payload };
    // Keep large transcripts/checkpoints below Firestore's document size limit.
    const payloadPath = `${this.prefix}${scope}/${randomUUID()}.json`;
    await this.file(payloadPath).save(payload, { resumable: false, contentType: 'application/json',
      metadata: { cacheControl: 'private, no-store' } });
    return { payloadFormat: 1, payloadPath };
  }
  private async groupIfPresent(id: string | null | undefined, tx?: Transaction): Promise<SessionGroup | undefined> {
    if (!id) return undefined;
    const snapshot = await this.read(this.ref('session_groups', id), tx);
    if (!snapshot.exists || snapshot.data()!.userId !== this.userId) return undefined;
    return { ...await this.decode(snapshot), id, userId: this.userId };
  }
  private async conversation(snapshot: DocumentSnapshot, tx?: Transaction, includeLegacyAudio = false): Promise<Conversation> {
    const value = await this.decode(snapshot);
    value.rawTranscript ??= '';
    value.transcriptSegments ??= parseTranscriptToSegments(value.rawTranscript, value.encounterType || 'dialogue');
    const group = await this.groupIfPresent(value.groupId, tx);
    const audio = snapshot.data()!.audio;
    if (value.annotation) value.annotation = normalizeEvidence(value.annotation, value.schemaSnapshot?.categories || group?.settings?.annotationSchema);
    const hasAudio = Boolean(audio || value.audioDataUrl?.startsWith('data:audio/'));
    return { ...value, id: snapshot.id, userId: this.userId, groupId: group?.id || null,
      hasAudio, audioLocalId: hasAudio ? snapshot.id : undefined,
      audioDataUrl: includeLegacyAudio ? value.audioDataUrl : undefined };
  }
  async listConversations(): Promise<Conversation[]> {
    const snapshots = await this.db.collection('clinical_conversations').where('userId', '==', this.userId).get();
    return newestFirst(await Promise.all(snapshots.docs.map(snapshot => this.conversation(snapshot))));
  }
  async getConversation(id: string): Promise<Conversation> {
    return this.conversation(await this.owned('clinical_conversations', id));
  }
  async saveConversation(id: string, input: unknown, create = false): Promise<Conversation> {
    const ref = this.ref('clinical_conversations', id);
    if (!isObject(input) || (input.id !== undefined && input.id !== id)) throw new StorageError(400, 'Invalid conversation record');
    await this.db.runTransaction(async tx => {
      const snapshot = await this.read(ref, tx);
      if (create && snapshot.exists) throw new StorageError(409, 'Conversation already exists');
      if (!create && (!snapshot.exists || snapshot.data()!.userId !== this.userId)) throw new StorageError(404, 'Conversation not found');
      const previous = snapshot.exists ? await this.conversation(snapshot, tx, true) : undefined;
      const value = { ...previous, ...input, id, userId: this.userId, isShared: false } as Conversation;
      validateConversation(value);
      const group = await this.groupIfPresent(value.groupId, tx);
      if (value.groupId != null && !group) throw new StorageError(404, 'Session group not found');
      if (previous && input.annotationProgress === undefined && (previous.rawTranscript !== value.rawTranscript ||
          JSON.stringify(previous.transcriptSegments) !== JSON.stringify(value.transcriptSegments))) value.annotationProgress = null;
      try {
        if (value.schemaSnapshot != null) validateSchemaSnapshot(value.schemaSnapshot);
        if (value.encounterTime !== undefined) { validateEncounterTime(value.encounterTime); value.encounterTime = normalizeTemporal(value.encounterTime); }
        if (value.annotation) value.annotation = normalizeEvidence(value.annotation, value.schemaSnapshot?.categories || group?.settings?.annotationSchema);
      } catch (error) { throw new StorageError(400, error instanceof Error ? error.message : 'Invalid annotation'); }
      // Preserve existing embedded audio on edits; new audio uses the upload endpoint.
      if (previous?.audioDataUrl && !snapshot.data()?.audio) value.audioDataUrl = previous.audioDataUrl;
      else delete value.audioDataUrl;
      delete value.audioLocalId;
      delete value.sharedGroupData;
      const stored = await this.encode(value, `conversations/${id}/versions`);
      tx.set(ref, { ...stored, userId: this.userId, title: value.title, createdAt: value.createdAt, groupId: value.groupId || null,
        audio: snapshot.data()?.audio || null, checkpointVersion: snapshot.data()?.checkpointVersion || 0 });
    });
    return this.getConversation(id);
  }
  async deleteConversation(id: string): Promise<void> {
    const ref = this.ref('clinical_conversations', id);
    await this.db.runTransaction(async tx => {
      await this.owned('clinical_conversations', id, tx);
      const history = await tx.get(ref.collection('checkpoints'));
      history.docs.forEach(snapshot => tx.delete(snapshot.ref));
      tx.delete(ref);
    });
    // Versioned objects are private. Remove only this owner's conversation objects.
    await this.bucket.deleteFiles({ prefix: `${this.prefix}conversations/${id}/` }).catch(error => {
      console.error('Could not clean up deleted conversation objects:', error.code || 'STORAGE_CLEANUP_FAILED');
    });
  }
  async listGroups(): Promise<SessionGroup[]> {
    const snapshots = await this.db.collection('session_groups').where('userId', '==', this.userId).get();
    return newestFirst(await Promise.all(snapshots.docs.map(async snapshot => ({ ...await this.decode(snapshot), id: snapshot.id, userId: this.userId }))));
  }
  async getGroup(id: string): Promise<SessionGroup> { return { ...await this.decode(await this.owned('session_groups', id)), id, userId: this.userId }; }
  async saveGroup(id: string, input: unknown, create = false): Promise<SessionGroup> {
    const ref = this.ref('session_groups', id);
    if (!isObject(input) || (input.id !== undefined && input.id !== id)) throw new StorageError(400, 'Invalid session group');
    await this.db.runTransaction(async tx => {
      const snapshot = await this.read(ref, tx);
      if (create && snapshot.exists) throw new StorageError(409, 'Group already exists');
      if (!create && (!snapshot.exists || snapshot.data()!.userId !== this.userId)) throw new StorageError(404, 'Session group not found');
      const value = { ...(snapshot.exists ? await this.decode(snapshot) : {}), ...input, id, userId: this.userId };
      if (typeof value.name !== 'string' || !value.name.trim() || typeof value.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(value.createdAt)) || (value.settings != null && !isObject(value.settings))) throw new StorageError(400, 'Invalid session group');
      tx.set(ref, { ...await this.encode(value, `groups/${id}`), userId: this.userId, createdAt: value.createdAt });
    });
    return this.getGroup(id);
  }
  async deleteGroup(id: string): Promise<void> {
    await this.db.runTransaction(async tx => {
      const group = await this.owned('session_groups', id, tx);
      const conversations = await tx.get(this.db.collection('clinical_conversations').where('userId', '==', this.userId).where('groupId', '==', id));
      const updates = await Promise.all(conversations.docs.map(async snapshot => {
        const value = { ...await this.decode(snapshot), groupId: null };
        return { ref: snapshot.ref, data: { ...await this.encode(value, `conversations/${snapshot.id}/versions`),
          userId: this.userId, title: value.title, createdAt: value.createdAt, groupId: null,
          audio: snapshot.data().audio || null, checkpointVersion: snapshot.data().checkpointVersion || 0 } };
      }));
      updates.forEach(update => tx.set(update.ref, update.data));
      tx.delete(group.ref);
    });
  }
  async getSettings(): Promise<UserAiConfig | null> {
    const snapshot = await this.db.collection('user_settings').doc(this.userId).get();
    if (!snapshot.exists) return null;
    const data = await this.decode(snapshot);
    const { transcription, annotation } = data;
    return { transcription, annotation };
  }
  async saveSettings(input: unknown): Promise<UserAiConfig> {
    if (!isObject(input)) throw new StorageError(400, 'Invalid AI settings');
    for (const key of ['annotation', 'transcription']) {
      const value = input[key];
      if (!isObject(value) || !['gemini', 'openai'].includes(value.provider) ||
          ['model', 'apiKey', 'baseUrl'].some(field => typeof value[field] !== 'string')) throw new StorageError(400, 'Invalid AI provider configuration');
    }
    if (input.annotation.concurrency !== undefined && !isValidAnnotationConcurrency(input.annotation.concurrency)) throw new StorageError(400, ANNOTATION_CONCURRENCY_ERROR);
    const value = jsonCopy({ annotation: input.annotation, transcription: input.transcription }) as UserAiConfig;
    await this.db.collection('user_settings').doc(this.userId).set({ ...await this.encode(value, 'settings'), userId: this.userId });
    return value;
  }
  async getAudio(id: string) {
    const snapshot = await this.owned('clinical_conversations', id);
    const audio = snapshot.data()!.audio;
    if (!audio) {
      const value = await this.decode(snapshot);
      const legacy = value.audioDataUrl?.match(/^data:(audio\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (legacy) return { mimeType: legacy[1], content: Buffer.from(legacy[2], 'base64') };
      throw new StorageError(404, 'Audio not found');
    }
    return { mimeType: audio.mimeType as string, content: (await this.file(audio.path).download())[0] };
  }
  async saveAudio(id: string, mimeType: string, content: Buffer): Promise<Conversation> {
    await this.owned('clinical_conversations', id);
    if (!content.length) throw new StorageError(400, 'Audio is empty');
    if (!/^(audio\/[\w.+-]+|video\/webm|application\/octet-stream)$/.test(mimeType)) throw new StorageError(400, 'Unsupported audio content type');
    const path = `${this.prefix}conversations/${id}/audio/${randomUUID()}`;
    await this.file(path).save(content, { resumable: false, contentType: mimeType, metadata: { cacheControl: 'private, no-store' } });
    try {
      const previousPath = await this.db.runTransaction(async tx => {
        const snapshot = await this.owned('clinical_conversations', id, tx);
        tx.update(snapshot.ref, { audio: { path, mimeType } });
        return snapshot.data()!.audio?.path as string | undefined;
      });
      if (previousPath) await this.file(previousPath).delete().catch(() => {});
    } catch (error) { await this.file(path).delete().catch(() => {}); throw error; }
    return this.getConversation(id);
  }
  async deleteAudio(id: string): Promise<Conversation> {
    const previousPath = await this.db.runTransaction(async tx => {
      const snapshot = await this.owned('clinical_conversations', id, tx);
      const value = await this.decode(snapshot);
      delete value.audioDataUrl;
      const encoded = await this.encode(value, `conversations/${id}/versions`);
      tx.set(snapshot.ref, { ...encoded, userId: this.userId, title: value.title, createdAt: value.createdAt,
        groupId: value.groupId || null, audio: null, checkpointVersion: snapshot.data()!.checkpointVersion || 0 });
      return snapshot.data()!.audio?.path as string | undefined;
    });
    if (previousPath) await this.file(previousPath).delete().catch(() => {});
    return this.getConversation(id);
  }
  async listCheckpoints(id: string): Promise<AnnotationCheckpointSummary[]> {
    const conversation = await this.owned('clinical_conversations', id);
    const history = await conversation.ref.collection('checkpoints').get();
    return history.docs.map(snapshot => snapshot.data().summary as AnnotationCheckpointSummary).sort((a, b) => b.version - a.version);
  }
  async getCheckpoint(id: string, checkpointId: string): Promise<AnnotationCheckpoint> {
    const conversation = await this.owned('clinical_conversations', id);
    validateId(checkpointId);
    const snapshot = await conversation.ref.collection('checkpoints').doc(checkpointId).get();
    if (!snapshot.exists) throw new StorageError(404, 'Checkpoint not found');
    // Immutable archives bypass all working-annotation normalization.
    return this.decode(snapshot);
  }
  async createCheckpoint(id: string, input: unknown = {}): Promise<AnnotationCheckpoint> {
    if (!isObject(input) || (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 200)) ||
        (input.reason !== undefined && !['manual', 'before-ai'].includes(input.reason))) throw new StorageError(400, 'Invalid checkpoint label or reason');
    const checkpointId = 'checkpoint_' + randomUUID();
    await this.db.runTransaction(async tx => {
      const document = await this.owned('clinical_conversations', id, tx);
      const conversation = await this.conversation(document, tx);
      if (conversation.status === 'processing') throw new StorageError(409, 'Wait for annotation processing to finish before checkpointing');
      const group = await this.groupIfPresent(conversation.groupId, tx);
      const configuredSchema = conversation.schemaSnapshot?.categories || group?.settings?.annotationSchema;
      const schema = schemaSnapshot(normalizeAnnotationSchema(configuredSchema?.length ? configuredSchema : DEFAULT_ANNOTATION_SCHEMA));
      validateSchemaSnapshot(schema);
      const version = (document.data()!.checkpointVersion || 0) + 1;
      const summary: AnnotationCheckpointSummary = { id: checkpointId, conversationId: id, version,
        createdAt: new Date().toISOString(), label: input.label?.trim() || '', reason: input.reason || 'manual',
        schemaVersion: schema.version, entityCount: conversation.annotation?.entities.length || 0,
        mentionCount: conversation.annotation?.mentions?.length || 0 };
      const { title, rawTranscript, transcriptSegments, annotation, encounterTime, encounterType, status, createdAt, groupId, restoredFrom } = conversation;
      const checkpoint: AnnotationCheckpoint = { ...summary, snapshotFormatVersion: 1, schema,
        snapshot: { title, rawTranscript, transcriptSegments, annotation, encounterTime, encounterType, status, createdAt, groupId, restoredFrom } };
      const stored = await this.encode(checkpoint, `conversations/${id}/checkpoints/${checkpointId}`);
      tx.create(document.ref.collection('checkpoints').doc(checkpointId), { ...stored, summary, userId: this.userId });
      tx.update(document.ref, { checkpointVersion: version });
    });
    return this.getCheckpoint(id, checkpointId);
  }
  async restoreCheckpoint(id: string, checkpointId: string): Promise<Conversation> {
    const checkpoint = await this.getCheckpoint(id, checkpointId);
    if (checkpoint.snapshotFormatVersion !== 1) throw new StorageError(409, 'Unsupported checkpoint format; download the snapshot instead');
    const group = await this.groupIfPresent(checkpoint.snapshot.groupId);
    return this.saveConversation('session_' + randomUUID(), {
      ...checkpoint.snapshot, title: `${checkpoint.snapshot.title} (restored v${checkpoint.version})`, createdAt: new Date().toISOString(),
      groupId: group?.id || null, schemaSnapshot: checkpoint.schema,
      restoredFrom: { conversationId: id, checkpointId, version: checkpoint.version, schemaVersion: checkpoint.schemaVersion },
      hasAudio: false, status: checkpoint.snapshot.annotation ? 'annotated' : 'draft',
    }, true);
  }
}
