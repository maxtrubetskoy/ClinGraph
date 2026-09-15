import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnnotationResponse } from '../src/lib/annotationStream';
import type { AnnotationProgress } from '../src/types';

function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      // Network chunks can divide UTF-8 characters and JSON records anywhere.
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('annotation stream decodes fragmented UTF-8, heartbeats, and the final result', async () => {
  const progress: AnnotationProgress = { stage: 'extracting', utterances: [{ lineIndex: 2, status: 'in_progress' }] };
  const result = { type: 'result', success: true, data: { title: 'Évaluation' }, progress: {
    stage: 'complete', utterances: [{ lineIndex: 2, status: 'complete' }]
  } };
  const updates: AnnotationProgress[] = [];
  const response = stream(JSON.stringify({ type: 'progress', progress }) + '\n{"type":"heartbeat"}\n' + JSON.stringify(result));
  assert.deepEqual(await readAnnotationResponse(response, update => updates.push(update)), result);
  assert.deepEqual(updates, [progress, result.progress]);
});

test('failed and interrupted annotation streams never report success', async () => {
  const progress: AnnotationProgress = { stage: 'failed', error: 'Provider unavailable', utterances: [{ lineIndex: 0, status: 'skipped' }] };
  const updates: AnnotationProgress[] = [];
  await assert.rejects(readAnnotationResponse(stream(JSON.stringify({ type: 'result', success: false, error: progress.error, progress }) + '\n'),
    update => updates.push(update)), /Provider unavailable/);
  assert.deepEqual(updates, [progress]);
  await assert.rejects(readAnnotationResponse(stream('{"type":"heartbeat"}\n'), () => {}), /connection interrupted/);
  await assert.rejects(readAnnotationResponse(stream('{broken json}\n'), () => {}), SyntaxError);
});

test('annotation reader accepts legacy JSON and rejects pre-stream HTTP errors', async () => {
  const result = { success: true, data: { entities: [] } };
  assert.deepEqual(await readAnnotationResponse(Response.json(result), () => {}), result);
  await assert.rejects(readAnnotationResponse(Response.json({ success: false, error: 'Invalid transcript' }, { status: 400 }), () => {}), /Invalid transcript/);
});
