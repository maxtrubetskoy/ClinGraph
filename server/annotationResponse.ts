import type { Request, Response } from 'express';
import type { AnnotationProgress } from '../src/types';

/** Both independent stages share the same streaming/error protocol. */
export function annotationResponse(req: Request, res: Response, requestId: string, operation: 'extraction' | 'mapping') {
  const streaming = req.get('Accept')?.includes('application/x-ndjson');
  const progress: AnnotationProgress = { requestId, operation, stage: 'preparing', utterances: [] };
  const publishProgress = () => {
    if (streaming && !res.destroyed && !res.writableEnded) res.write(JSON.stringify({ type: 'progress', progress }) + '\n');
  };
  const finish = (status: number, result: Record<string, unknown>) => {
    if (res.destroyed) return;
    const payload = { ...result, requestId, progress };
    if (streaming) res.end(JSON.stringify({ type: 'result', ...payload }) + '\n');
    else res.status(status).json(payload);
  };
  if (streaming) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    publishProgress();
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write('{"type":"heartbeat"}\n');
    }, 15000);
    res.once('close', () => clearInterval(heartbeat));
  }
  return { progress, publishProgress, finish };
}
