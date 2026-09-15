import express from 'express';
import type { WorkspaceDatabase } from './workspace';

export function localApi(source: WorkspaceDatabase | ((req: express.Request) => WorkspaceDatabase)) {
  const router = express.Router();
  const database = (req: express.Request) => typeof source === 'function' ? source(req) : source;
  const route = (operation: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { void operation(req, res).catch(next); };
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/workspace', route(async (req, res) => {
    const db = database(req);
    const [conversations, groups, settings] = await Promise.all([db.listConversations(), db.listGroups(), db.getSettings()]);
    res.json({ conversations, groups, settings });
  }));
  router.get('/conversations/:id', route(async (req, res) => res.json(await database(req).getConversation(req.params.id))));
  router.put('/conversations/:id', route(async (req, res) => res.status(201).json(await database(req).saveConversation(req.params.id, req.body, true))));
  router.patch('/conversations/:id', route(async (req, res) => res.json(await database(req).saveConversation(req.params.id, req.body))));
  router.delete('/conversations/:id', route(async (req, res) => { await database(req).deleteConversation(req.params.id); res.sendStatus(204); }));
  router.get('/conversations/:id/checkpoints', route(async (req, res) => res.json(await database(req).listCheckpoints(req.params.id))));
  router.post('/conversations/:id/checkpoints', route(async (req, res) => res.status(201).json(await database(req).createCheckpoint(req.params.id, req.body))));
  router.get('/conversations/:id/checkpoints/:checkpointId', route(async (req, res) => res.json(await database(req).getCheckpoint(req.params.id, req.params.checkpointId))));
  router.post('/conversations/:id/checkpoints/:checkpointId/restore', route(async (req, res) =>
    res.status(201).json(await database(req).restoreCheckpoint(req.params.id, req.params.checkpointId))));
  router.put('/groups/:id', route(async (req, res) => res.status(201).json(await database(req).saveGroup(req.params.id, req.body, true))));
  router.patch('/groups/:id', route(async (req, res) => res.json(await database(req).saveGroup(req.params.id, req.body))));
  router.delete('/groups/:id', route(async (req, res) => { await database(req).deleteGroup(req.params.id); res.sendStatus(204); }));
  router.put('/settings', route(async (req, res) => res.json(await database(req).saveSettings(req.body))));
  router.get('/conversations/:id/audio', route(async (req, res) => {
    const audio = await database(req).getAudio(req.params.id);
    res.type(audio.mimeType).send(audio.content);
  }));
  router.put('/conversations/:id/audio', express.raw({ type: () => true, limit: '50mb' }), route(async (req, res) => {
    const mimeType = (req.get('content-type') || 'application/octet-stream').split(';')[0];
    if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'Expected audio bytes' }); return; }
    res.json(await database(req).saveAudio(req.params.id, mimeType, req.body));
  }));
  router.delete('/conversations/:id/audio', route(async (req, res) => res.json(await database(req).deleteAudio(req.params.id))));
  return router;
}

/** The login-free API is for loopback use; reject browser requests from other origins. */
export const localOnly: express.RequestHandler = (req, res, next) => {
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname)) {
    res.status(403).json({ error: 'ClinGraph only accepts localhost requests' }); return;
  }
  const origin = req.get('origin');
  if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
    res.status(403).json({ error: 'Cross-origin requests are not allowed' }); return;
  }
  next();
};
