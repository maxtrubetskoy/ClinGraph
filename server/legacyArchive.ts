import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { StorageError } from './database';
import type { ArchivedSession, ArchivedSessionSummary } from '../src/lib/legacyArchive';

/** Intentionally exposes no mutation operations and does not import annotation normalizers. */
export class LegacyArchive {
  constructor(private db: Firestore, private userId: string) {}
  private async owned(collection: string, id: string) {
    if (!id || id.includes('/') || Buffer.byteLength(id, 'utf8') > 1500) throw new StorageError(400, 'Invalid archive ID');
    const snapshot = await this.db.collection(collection).doc(id).get();
    if (!snapshot.exists || snapshot.data()!.userId !== this.userId) throw new StorageError(404, 'Archived record not found');
    return snapshot;
  }
  async list(): Promise<ArchivedSessionSummary[]> {
    const result = await this.db.collection('clinical_conversations').where('userId', '==', this.userId)
      .select('title', 'createdAt').get();
    return result.docs.map(snapshot => ({ id: snapshot.id,
      title: typeof snapshot.data().title === 'string' ? snapshot.data().title : 'Untitled archived session',
      createdAt: typeof snapshot.data().createdAt === 'string' ? snapshot.data().createdAt : ''
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async get(id: string): Promise<ArchivedSession> {
    const snapshot = await this.owned('clinical_conversations', id);
    const record = snapshot.data()!;
    let group: ArchivedSession['group'] = null;
    if (typeof record.groupId === 'string' && record.groupId) {
      try {
        const saved = await this.owned('session_groups', record.groupId);
        group = { id: saved.id, record: saved.data()! };
      } catch (error) {
        if (!(error instanceof StorageError && [400, 404].includes(error.status))) throw error;
      }
    }
    return { id: snapshot.id, record, group };
  }
  async audio(id: string) {
    const record = (await this.owned('clinical_conversations', id)).data()!;
    const match = typeof record.audioDataUrl === 'string' && record.audioDataUrl.match(/^data:(audio\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new StorageError(404, 'No audio is stored in this archived record');
    return { mimeType: match[1], content: Buffer.from(match[2], 'base64') };
  }
}

export function legacyArchiveApi(db: Firestore) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(405).json({ error: 'Archived sessions are read-only.' }); return;
    }
    next();
  });
  const route = (operation: (req: express.Request, res: express.Response, archive: LegacyArchive) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { void operation(req, res, new LegacyArchive(db, res.locals.userId)).catch(next); };
  router.get('/sessions', route(async (_req, res, archive) => res.json(await archive.list())));
  router.get('/sessions/:id', route(async (req, res, archive) => res.json(await archive.get(req.params.id))));
  router.get('/sessions/:id/audio', route(async (req, res, archive) => {
    const audio = await archive.audio(req.params.id);
    res.type(audio.mimeType).send(audio.content);
  }));
  router.use((_req, res) => res.status(404).json({ error: 'Archive endpoint not found' }));
  return router;
}
