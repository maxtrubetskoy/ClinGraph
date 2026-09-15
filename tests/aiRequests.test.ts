import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aiTimeoutMs, callOpenAiChat, logAi, runAiRequest, AiRequestError } from '../server/aiRequests';

const directory = mkdtempSync(path.join(tmpdir(), 'clingraph-ai-requests-'));
const logFile = path.join(directory, 'requests.jsonl');
const previous = { timeout: process.env.CLINGRAPH_AI_TIMEOUT_MS, log: process.env.CLINGRAPH_AI_LOG_PATH };
before(() => { process.env.CLINGRAPH_AI_LOG_PATH = logFile; });
after(() => {
  for (const [key, value] of [['CLINGRAPH_AI_TIMEOUT_MS', previous.timeout], ['CLINGRAPH_AI_LOG_PATH', previous.log]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});
const records = (requestId: string) => readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.requestId === requestId);
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('the shared deadline defaults to three minutes and rejects invalid settings', () => {
  delete process.env.CLINGRAPH_AI_TIMEOUT_MS;
  assert.equal(aiTimeoutMs(), 180000);
  for (const value of ['0', '-1', 'abc', '1.5', '900001', '']) {
    process.env.CLINGRAPH_AI_TIMEOUT_MS = value;
    assert.throws(aiTimeoutMs, /CLINGRAPH_AI_TIMEOUT_MS/);
  }
});

test('a slow complete response succeeds within its configured budget; logs contain metadata only', async () => {
  process.env.CLINGRAPH_AI_TIMEOUT_MS = '1000';
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer TEST_PRIVATE_KEY');
    for await (const _ of req) { /* Consume the request body without logging it. */ }
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'upstream-123' });
    res.write(' ');
    setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: 'PRIVATE_COMPLETION' } }],
      usage: { prompt_tokens: 123, completion_tokens: 45 } })), 120);
  });
  try {
    const baseUrl = await listen(server);
    assert.equal(await callOpenAiChat({ baseUrl: baseUrl + '/', model: 'test-model', apiKey: 'TEST_PRIVATE_KEY' }, 'PRIVATE_TRANSCRIPT',
      { requestId: 'slow-success', stage: 'clustering', attempt: 1 }), 'PRIVATE_COMPLETION');
    const rows = records('slow-success');
    assert.deepEqual(rows.map(row => row.event), ['request_started', 'response_headers', 'request_completed']);
    assert.equal(rows[2].timeoutMs, 1000);
    assert(rows[2].elapsedMs >= 120);
    assert.equal(rows[2].httpStatus, 200);
    assert.equal(rows[2].upstreamRequestId, 'upstream-123');
    assert.equal(rows[2].promptTokens, 123);
    assert.equal(rows[2].completionTokens, 45);
    const log = readFileSync(logFile, 'utf8');
    for (const secret of ['TEST_PRIVATE_KEY', 'PRIVATE_TRANSCRIPT', 'PRIVATE_COMPLETION']) assert(!log.includes(secret));
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
  } finally { await close(server); }
});

test('deadline aborts a stalled response body after headers and reports 504', async () => {
  process.env.CLINGRAPH_AI_TIMEOUT_MS = '120';
  let closed = false;
  const server = createServer((req, res) => {
    res.on('close', () => { closed = true; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(' ');
  });
  try {
    const baseUrl = await listen(server);
    await assert.rejects(callOpenAiChat({ baseUrl, model: 'test' }, 'synthetic',
      { requestId: 'body-timeout', stage: 'mention-extraction', utteranceIndex: 12, attempt: 2 }), (error: AiRequestError) => {
        assert.equal(error.status, 504); assert.equal(error.code, 'AI_TIMEOUT');
        assert.match(error.message, /utterance 12/); assert.match(error.message, /body-timeout/); return true;
      });
    for (let i = 0; i < 20 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(closed, 'The outgoing connection must be cancelled, not merely stop being awaited');
    const rows = records('body-timeout');
    assert.equal(rows.at(-1).reason, 'AI_TIMEOUT');
    assert.equal(rows.at(-1).httpStatus, 200);
    assert.equal(rows.at(-1).attempt, 2);
    assert(rows.at(-1).elapsedMs >= 120);
  } finally { await close(server); }
});

test('parent cancellation aborts an in-flight operation and does not start a cancelled one', async () => {
  process.env.CLINGRAPH_AI_TIMEOUT_MS = '1000';
  const parent = new AbortController();
  let aborted = false;
  const pending = runAiRequest({ requestId: 'cancelled', stage: 'mention-extraction', signal: parent.signal }, {}, signal =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })));
  await new Promise(resolve => setTimeout(resolve, 5));
  parent.abort();
  await assert.rejects(pending, (error: AiRequestError) => error.code === 'AI_CANCELLED');
  assert(aborted);
  let started = false;
  await assert.rejects(runAiRequest({ requestId: 'already-cancelled', stage: 'clustering', signal: parent.signal }, {}, async () => { started = true; }),
    (error: AiRequestError) => error.code === 'AI_CANCELLED');
  assert.equal(started, false);
});

test('oversized logs rotate while retaining a previous file', () => {
  writeFileSync(logFile, 'x'.repeat(5 * 1024 * 1024));
  logAi({ requestId: 'rotated', stage: 'annotation' }, 'annotation_completed');
  assert.equal(statSync(logFile + '.1').size, 5 * 1024 * 1024);
  assert.equal(records('rotated').length, 1);
});
