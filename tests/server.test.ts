import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeTemporal } from '../src/utils/temporal';
import { FHIR_ANNOTATION_SCHEMA } from '../src/types';
import type { AnnotationProgress } from '../src/types';
import { readAnnotationResponse } from '../src/lib/annotationStream';

let child: ChildProcess;
let provider: Server;
let base: string;
let providerBase: string;
let directory: string;
let logs = '';
let providerRequests = 0;
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'clingraph-api-test-'));
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, CLINGRAPH_STORAGE: 'sqlite', NODE_ENV: 'production', GEMINI_API_KEY: '', UMLS_API_KEY: '', PORT: String(port),
      CLINGRAPH_DB_PATH: path.join(directory, 'workspace.sqlite'), CLINGRAPH_AI_TIMEOUT_MS: '1000',
      CLINGRAPH_AI_CONCURRENCY: '3',
      CLINGRAPH_AI_LOG_PATH: path.join(directory, 'ai-requests.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', chunk => { logs += chunk; });
  child.stderr!.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${logs}`);
});

after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const send = (route: string, value: unknown, method = 'POST') => fetch(`${base}/api${route}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});

async function annotate(input: Record<string, unknown>) {
  const response = await send('/extract-mentions', input);
  if (!response.ok) return response;
  const extracted = await response.json();
  const mapped = await send('/map-entities', { ...input, transcriptSegments: extracted.data.transcriptSegments, mentions: extracted.data.mentions });
  const result = await mapped.json();
  return new Response(JSON.stringify({ ...result, progress: { ...result.progress, utterances: extracted.progress.utterances } }),
    { status: mapped.status, headers: mapped.headers });
}

test('mapping validates its saved input before requesting a model and handles zero extracted mentions', async () => {
  for (const payload of [{}, { mentions: [], transcriptSegments: {} }, { mentions: null, transcriptSegments: [] },
    { mentions: [{ id: 'm1', entityType: 'Symptom', textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'Headache' } }],
      transcriptSegments: [{ speaker: 'Patient', text: 'Nausea.' }] }]) {
    assert.equal((await send('/map-entities', payload)).status, 400);
  }
  const empty = await send('/map-entities', { mentions: [], transcriptSegments: [{ speaker: 'Patient', text: 'Hello.' }] });
  assert.equal(empty.status, 200);
  const result = await empty.json();
  assert.equal(result.progress.operation, 'mapping');
  assert.deepEqual(result.data.entities, []);
  assert.deepEqual(result.data.mentions, []);
});

test('mapping keeps 120 mentions and valid entities when individual model fields and assignments are invalid', async () => {
  const segments = [{ id: 's0', speaker: 'Patient', text: 'Headache since Tuesday.' }];
  const mentions = Array.from({ length: 120 }, (_, i) => ({ id: `m${i + 1}`, entityId: null, entityType: 'symptoms',
    canonicalName: 'Headache', textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'Headache' } }));
  const invalidTime = { type: 'temporal', kind: 'absolute', date: '2026-99-40', precision: 'invalid', qualifier: 'maybe', text: 'Tuesday' };
  const fixture = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entities: [
      { name: 'Headache', type: 'symptoms', mentionIds: mentions.slice(0, 117).map(m => m.id),
        attributeMentionIds: { onset: ['m118'] }, attributes: { severity: 'Mild', onset: invalidTime } },
      null,
      { name: 'Nausea', type: 'symptoms', mentionIds: ['m117', 'm119', 'invented-mention'], attributes: { severity: 'Severe' } }
    ] }) } }] }));
  });
  const id = 'partial-mapping';
  try {
    const port = await listen(fixture);
    const response = await send('/map-entities', { mentions, transcriptSegments: segments,
      aiConfig: { annotation: { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'partial', apiKey: '' } } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true);
    assert.equal(result.progress.stage, 'complete');
    assert(result.progress.warningCount > 0);
    const data = result.data;
    assert.equal(data.entities.length, 2);
    assert.equal(data.mentions.length, 120);
    assert.equal(data.mentions.filter((m: any) => m.target).length, 118);
    assert.equal(data.mentions.find((m: any) => m.id === 'm120').target, null);
    assert.equal(data.mentions.find((m: any) => m.id === 'm117').target, null);
    const headache = data.entities.find((e: any) => e.name === 'Headache');
    assert.equal(headache.attributes.find((a: any) => a.name === 'severity').value, 'Mild');
    const onset = headache.attributes.find((a: any) => a.name === 'onset');
    assert.deepEqual(onset.value, normalizeTemporal('Tuesday'));
    assert.equal(data.mentions.find((m: any) => m.id === 'm118').target.attributeId, onset.id);
    assert(data.mappingIssues.some((issue: any) => issue.attributeName === 'onset' && JSON.stringify(issue.originalValue) === JSON.stringify(invalidTime)));
    assert(data.mappingIssues.some((issue: any) => issue.mentionId === 'm120'));
    assert.equal((await send('/conversations/' + id, { title: 'Partial result', rawTranscript: 'Patient: Headache since Tuesday.',
      transcriptSegments: segments, createdAt: new Date().toISOString(), status: 'annotated', annotation: data }, 'PUT')).status, 201);
    const saved = await (await fetch(base + '/api/conversations/' + id)).json();
    assert.deepEqual(saved.annotation.mappingIssues, data.mappingIssues);
    assert.equal(saved.annotation.mentions.length, 120);
    const checkpoint = await (await send('/conversations/' + id + '/checkpoints', {})).json();
    assert.deepEqual(checkpoint.snapshot.annotation.mappingIssues, data.mappingIssues);
  } finally {
    await fetch(base + '/api/conversations/' + id, { method: 'DELETE' });
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});

test('saved mention extraction survives mapping failure and maps on retry without re-extraction', async () => {
  let extractions = 0;
  let mappings = 0;
  const fixture = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages[0].content as string;
    let result: unknown;
    if (prompt.includes('Extracted Mentions from Step 1:')) {
      mappings++;
      if (mappings === 1) { res.writeHead(503).end('Unavailable'); return; }
      assert.match(prompt, /"attributeName": "onset"/);
      result = { entities: [{ name: 'Headache', type: 'symptoms', mentionIds: ['m1'],
        attributeMentionIds: { onset: ['m2'] }, attributes: { onset: 'Tuesday' } }] };
    } else {
      extractions++;
      result = { mentions: [
        { lineIndex: 0, literalText: 'Headache', canonicalName: 'Headache', type: 'symptoms', evidenceRole: 'reference', evidenceTarget: { kind: 'entity' } },
        { lineIndex: 0, literalText: 'Tuesday', canonicalName: 'Headache', type: 'symptoms', evidenceRole: 'claim', evidenceTarget: { kind: 'attribute', attributeName: 'onset' } }
      ] };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  const id = 'separate-annotation-stages';
  try {
    const port = await listen(fixture);
    const aiConfig = { annotation: { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stages', apiKey: '' } };
    const transcriptSegments = [{ id: 's0', speaker: 'Patient', text: 'Headache since Tuesday.' }];
    const rawTranscript = 'Patient: Headache since Tuesday.';
    const extractedResponse = await send('/extract-mentions', { transcript: rawTranscript, transcriptSegments, aiConfig });
    assert.equal(extractedResponse.status, 200);
    const extracted = await extractedResponse.json();
    assert.equal(extractions, 1);
    assert.equal(mappings, 0, 'Extracting mentions must not start mapping');
    assert.equal(extracted.data.mentions[1].supportedAttribute, 'onset');
    const mentionExtraction = { mentions: extracted.data.mentions, progress: extracted.progress };
    assert.equal((await send('/conversations/' + id, { title: 'Stages', createdAt: new Date().toISOString(),
      status: 'draft', rawTranscript, transcriptSegments, mentionExtraction }, 'PUT')).status, 201);
    const read = () => fetch(base + '/api/conversations/' + id).then(r => r.json());
    const input = { transcriptSegments, aiConfig, mentions: (await read()).mentionExtraction.mentions };
    const failed = await send('/map-entities', input);
    assert.equal(failed.status, 502);
    assert.deepEqual((await read()).mentionExtraction, mentionExtraction);
    const mapped = await send('/map-entities', { ...input, mentions: (await read()).mentionExtraction.mentions });
    assert.equal(mapped.status, 200);
    const data = (await mapped.json()).data;
    assert.equal(extractions, 1);
    assert.equal(mappings, 2);
    assert.deepEqual(data.mentions.map((m: any) => m.id), ['m1', 'm2']);
    assert.equal(data.mentions[1].target.kind, 'attribute');
    assert.equal(data.entities[0].attributes.find((a: any) => a.id === data.mentions[1].target.attributeId).name, 'onset');
    // A transcript edit invalidates saved spans instead of silently mapping stale text.
    await send('/conversations/' + id, { rawTranscript: 'Patient: Nausea.',
      transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Nausea.' }] }, 'PATCH');
    assert.equal((await read()).mentionExtraction, null);
    assert.equal((await send('/map-entities', { ...input, transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Nausea.' }] })).status, 400);
  } finally {
    await fetch(base + '/api/conversations/' + id, { method: 'DELETE' });
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});

test('checkpoint API captures server-side state, lists summaries, protects immutable history and restores a new session', async () => {
  const id = 'checkpoint-api';
  let restoredId: string | undefined;
  const session = { title: 'Checkpoint API', rawTranscript: 'Patient: Stable.', transcriptSegments: [
    { id: 'seg1', speaker: 'Patient', text: 'Stable.' }
  ], createdAt: '2026-01-01T00:00:00Z', status: 'draft' };
  try {
    assert.equal((await send('/conversations/' + id, session, 'PUT')).status, 201);
    const route = '/conversations/' + id + '/checkpoints';
    const response = await send(route, { label: 'Baseline', snapshot: { rawTranscript: 'Client must not set snapshot' }, version: 99 });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json();
    assert.equal(first.version, 1);
    assert.equal(first.snapshot.rawTranscript, session.rawTranscript);
    assert(first.schema.categories.length > 0);
    assert.match(first.schemaVersion, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await send('/conversations/' + id, { rawTranscript: 'Edited.' }, 'PATCH')).status, 200);
    assert.equal((await send(route, { label: 23 })).status, 400);
    const second = await (await send(route, { reason: 'before-ai' })).json();
    assert.equal(second.version, 2);
    const list = await (await fetch(base + '/api' + route)).json();
    assert.deepEqual(list.map((row: any) => row.version), [2, 1]);
    assert(!('snapshot' in list[0]));
    assert.equal((await send(route + '/' + first.id, { label: 'changed' }, 'PATCH')).status, 404);
    assert.equal((await fetch(base + '/api' + route + '/' + first.id, { method: 'DELETE' })).status, 404);
    assert.deepEqual(await (await fetch(base + '/api' + route + '/' + first.id)).json(), first);
    const restoredResponse = await send(route + '/' + first.id + '/restore', {});
    assert.equal(restoredResponse.status, 201);
    const restored = await restoredResponse.json(); restoredId = restored.id;
    assert.notEqual(restoredId, id);
    assert.equal(restored.rawTranscript, session.rawTranscript);
    assert.deepEqual(restored.schemaSnapshot, first.schema);
    assert.equal((await (await fetch(base + '/api/conversations/' + id)).json()).rawTranscript, 'Edited.');
    assert.equal((await fetch(base + '/api/conversations/' + restoredId + '/checkpoints/' + first.id)).status, 404);
    assert.equal((await send('/conversations/' + restoredId + '/checkpoints/' + first.id + '/restore', {})).status, 404);
  } finally {
    await fetch(base + '/api/conversations/' + id, { method: 'DELETE' });
    if (restoredId) await fetch(base + '/api/conversations/' + restoredId, { method: 'DELETE' });
  }
});

test('attribute targets survive saving and invalid attribute references return 400 without overwriting', async () => {
  const annotation = {
    evidenceVersion: 2, entities: [
      { id: 'e1', name: 'Headache', type: 'Symptom', categoryId: 'symptoms',
        attributes: [{ id: 'onset-1', name: 'onset', value: 'Tuesday' }] },
      { id: 'e2', name: 'Nausea', type: 'Symptom',
        attributes: [{ id: 'onset-2', name: 'onset', value: 'Monday' }] }
    ], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] },
    mentions: [{ id: 'm1', entityId: 'e1', entityType: 'Symptom',
      target: { kind: 'attribute', entityId: 'e1', attributeId: 'onset-1' },
      textSpan: { text: 'Tuesday', lineIndex: 0, startChar: 0, endChar: 7 } }]
  };
  const session = { title: 'Evidence validation', rawTranscript: 'Tuesday', transcriptSegments: [],
    status: 'annotated', createdAt: new Date().toISOString(), annotation };
  try {
    assert.equal((await send('/conversations/evidence-validation', session, 'PUT')).status, 201);
    const read = () => fetch(base + '/api/conversations/evidence-validation').then(r => r.json());
    const saved = await read();
    assert.deepEqual(saved.annotation.mentions[0].target, annotation.mentions[0].target);
    assert.equal(saved.annotation.entities[0].textSpan, undefined);
    for (const attributeId of ['missing', 'onset-2']) {
      const broken = structuredClone(annotation);
      broken.mentions[0].target.attributeId = attributeId;
      assert.equal((await send('/conversations/evidence-validation', { annotation: broken }, 'PATCH')).status, 400);
      assert.deepEqual(await read(), saved);
    }
    const edited = structuredClone(annotation);
    edited.entities[0].attributes[0].value = 'Wednesday';
    assert.equal((await send('/conversations/evidence-validation', { annotation: edited }, 'PATCH')).status, 200);
    const after = await read();
    assert.deepEqual(after.annotation.mentions[0].target, annotation.mentions[0].target);
    assert.deepEqual(after.annotation.clinicalNotes.symptoms[0].onset, normalizeTemporal('Wednesday'));
  } finally { await fetch(base + '/api/conversations/evidence-validation', { method: 'DELETE' }); }
});

test('workspace and CRUD work without cookies, tokens, or login; audio is stored separately', async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).authentication, false);
  assert.deepEqual(await (await fetch(`${base}/api/workspace`)).json(), { conversations: [], groups: [], settings: null });
  const session = { title: 'Synthetic', rawTranscript: 'Patient: Hello.', transcriptSegments: [],
    createdAt: new Date().toISOString(), status: 'draft', hasAudio: false };
  assert.equal((await send('/conversations/api-session', session, 'PUT')).status, 201);
  const audio = await fetch(`${base}/api/conversations/api-session/audio`, {
    method: 'PUT', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('test audio'),
  });
  assert.equal(audio.status, 200);
  assert.equal((await audio.json()).hasAudio, true);
  assert.equal(await (await fetch(`${base}/api/conversations/api-session/audio`)).text(), 'test audio');
  assert.equal((await send('/conversations/api-session', { title: 'Renamed' }, 'PATCH')).status, 200);
  assert.equal((await fetch(`${base}/api/conversations/api-session`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/conversations/api-session/audio`)).status, 404);
  assert.equal((await send('/conversations/api-session', { title: 'Late' }, 'PATCH')).status, 404);
});

test('local-only boundary rejects foreign origins and hostnames; API errors remain JSON', async () => {
  assert.equal((await fetch(`${base}/api/workspace`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(`${base}/api/workspace`, { headers: { Host: 'example.com' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/api/workspace`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const missing = await fetch(`${base}/api/not-a-route`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type')!, /json/);
  const malformed = await fetch(`${base}/api/conversations/x`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
});

test('missing AI credentials return errors, never fabricated annotations, relations, or transcripts', async () => {
  for (const [route, payload] of [
    ['/extract-mentions', { transcript: 'Patient: A headache.' }],
    ['/relations', { entities: [{ id: 'e1', name: 'Headache', type: 'Symptom' }] }],
    ['/diarize', { audioBase64: 'YQ==', audioMimeType: 'audio/webm' }],
  ] as const) {
    const response = await send(route, payload);
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.data, undefined);
    assert.equal(result.isMock, undefined);
  }
});

test('invalid frontend concurrency is rejected before annotation starts', async () => {
  for (const concurrency of [0, 33, 1.5, '4', null]) {
    const response = await annotate({ transcript: 'Patient: Headache.', aiConfig: { annotation: { concurrency } } });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.match(result.error, /concurrency/);
  }
});

test('extraction honors frontend concurrency, keeps neighboring context and clusters all mentions in transcript order', async () => {
  const segments = [
    { id: 'question', speaker: 'Clinician', text: 'Any headache?' },
    { id: 'blank', speaker: 'Patient', text: '   ' },
    { id: 'answer', speaker: 'Patient', text: 'No, but nausea since Tuesday.' },
    { id: 'question2', speaker: 'Clinician', text: 'Any dizziness?' },
    { id: 'answer2', speaker: 'Patient', text: 'Yes.' }
  ];
  const observed: number[] = [];
  const assertions: unknown[] = [];
  let clusteringCalls = 0;
  let active = 0;
  let maxActive = 0;
  const completionOrder: number[] = [];
  const fixture = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const prompt = input.messages[0].content as string;
      let result: unknown;
      if (prompt.includes('Extracted Mentions from Step 1:')) {
        clusteringCalls++;
        assert.equal(observed.length, 4);
        for (const segment of segments) assert(prompt.includes(segment.text));
        result = { entities: [
          { name: 'Headache', type: 'symptoms', mentionIds: ['m1', 'm2'], attributes: {} },
          { name: 'Nausea', type: 'symptoms', mentionIds: ['m3'], attributeMentionIds: { onset: ['m4'] }, attributes: { onset: 'Tuesday' } },
          { name: 'Dizziness', type: 'symptoms', mentionIds: ['m5', 'm6'], attributes: {} }
        ] };
      } else {
        const targets = [...prompt.matchAll(/\[TARGET Utterance (\d+)\]/g)];
        assert.equal(targets.length, 1);
        const index = Number(targets[0][1]);
        observed.push(index);
        assert.notEqual(index, 1, 'Blank utterances must not cause model calls');
        assert(prompt.includes(`[TARGET Utterance ${index}] [${segments[index].speaker}]: ${segments[index].text}`));
        const contextIndices = [...prompt.matchAll(/\[Context Utterance (\d+)\]/g)].map(match => Number(match[1]));
        assert.deepEqual(contextIndices, segments.map((_, i) => i).filter(i => i !== index && Math.abs(i - index) <= 2));
        assert.match(prompt, /Extract every distinct clinical mention and attribute-evidence span/);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, index === 0 ? 80 : 5));
        active--;
        completionOrder.push(index);
        const mention = (literalText: string, canonicalName: string, attributeName?: string) => ({
          lineIndex: index, literalText, canonicalName, type: 'symptoms',
          evidenceTarget: attributeName ? { kind: 'attribute', attributeName } : { kind: 'entity' },
          evidenceRole: attributeName || ['No', 'Yes'].includes(literalText) ? 'claim' : 'reference',
          ...(literalText === 'No' ? { polarity: 'negative', function: 'asserted', certainty: 'certain', experiencer: 'patient' } : {}),
          ...(literalText === 'Yes' ? { polarity: 'positive', function: 'asserted', certainty: 'certain', experiencer: 'patient' } : {})
        });
        result = { mentions: index === 0 ? [mention('headache', 'Headache')]
          : index === 2 ? [mention('No', 'Headache'), mention('nausea', 'Nausea'), mention('Tuesday', 'Nausea', 'onset')]
          : index === 3 ? [mention('dizziness', 'Dizziness')] : [mention('Yes', 'Dizziness')] };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    } catch (error) { assertions.push(error); res.writeHead(500).end('Fixture assertion failed'); }
  });
  try {
    const port = await listen(fixture);
    const updates: AnnotationProgress[] = [];
    let receivedLiveUpdate = false;
    const response = await fetch(base + '/api/extract-mentions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ transcriptSegments: segments,
        aiConfig: { annotation: { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'utterance-test', apiKey: '', concurrency: 2 } } })
    });
    assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
    const result = await readAnnotationResponse(response, progress => {
      updates.push(progress);
      if (progress.utterances.some(item => item.status === 'in_progress') && completionOrder.length < 4) receivedLiveUpdate = true;
    });
    assert(receivedLiveUpdate, 'Progress must arrive before extraction finishes');
    assert.equal(updates[0].stage, 'preparing');
    assert(!updates.some(update => update.stage === 'clustering'));
    assert.equal(clusteringCalls, 0);
    assert(updates.some(update => update.utterances.filter(item => item.status === 'in_progress').length === 2));
    assert(updates.every(update => update.utterances.filter(item => item.status === 'in_progress').length <= 2));
    assert.deepEqual(result.progress.utterances, [0, 2, 3, 4].map(lineIndex => ({ lineIndex, status: 'complete' })));
    assert.equal(result.progress.stage, 'complete');
    assert.deepEqual(assertions, []);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(observed, [0, 2, 3, 4]);
    assert.equal(maxActive, 2, 'The frontend concurrency selection must override the environment value of 3');
    assert.notEqual(completionOrder[0], 0);
    const mapped = await send('/map-entities', { transcriptSegments: segments, mentions: result.data.mentions,
      aiConfig: { annotation: { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'utterance-test', apiKey: '' } } });
    assert.equal(mapped.status, 200);
    result.data = (await mapped.json()).data;
    assert.equal(clusteringCalls, 1);
    assert.deepEqual(result.data.mentions.map((mention: any) => [mention.id, mention.textSpan.lineIndex, mention.textSpan.text, mention.speaker]), [
      ['m1', 0, 'headache', 'Clinician'], ['m2', 2, 'No', 'Patient'], ['m3', 2, 'nausea', 'Patient'],
      ['m4', 2, 'Tuesday', 'Patient'], ['m5', 3, 'dizziness', 'Clinician'], ['m6', 4, 'Yes', 'Patient']
    ]);
    assert.equal(result.data.mentions[0].entityId, result.data.mentions[1].entityId);
    assert.equal(result.data.mentions[4].entityId, result.data.mentions[5].entityId);
    assert.equal(result.data.mentions[1].polarity, 'negative');
    assert.equal(result.data.mentions[5].polarity, 'positive');
    const nausea = result.data.entities.find((entity: any) => entity.name === 'Nausea');
    const onset = nausea.attributes.find((attribute: any) => attribute.name === 'onset');
    assert.deepEqual(result.data.mentions[3].target, { kind: 'attribute', entityId: nausea.id, attributeId: onset.id });
  } finally { await new Promise<void>(resolve => fixture.close(() => resolve())); }
});

test('extraction skips invalid target spans after retries while preserving successful utterances', async () => {
  let clusteringCalls = 0;
  let failedAttempts = 0;
  const fixture = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages[0].content as string;
    const clustering = prompt.includes('Extracted Mentions from Step 1:');
    if (clustering) clusteringCalls++;
    if (prompt.includes('[TARGET Utterance 1]')) failedAttempts++;
    // Both utterances contain the same phrase. The second request must not reuse index 0.
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(clustering ? { entities: [
      { name: 'Headache', type: 'symptoms', mentionIds: ['m1'], attributes: {} }
    ] } : { mentions: [
      { lineIndex: 0, literalText: 'Headache', canonicalName: 'Headache', type: 'symptoms', evidenceTarget: { kind: 'entity' } }
    ] }) } }] }));
  });
  try {
    const port = await listen(fixture);
    const response = await annotate({
      transcriptSegments: [{ id: 's0', speaker: 'Clinician', text: 'Headache?' }, { id: 's1', speaker: 'Patient', text: 'Headache.' }],
      aiConfig: { annotation: { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'context-test', apiKey: '' } }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.progress.stage, 'complete');
    assert.equal(result.progress.utterances[0].status, 'complete');
    assert.equal(result.progress.utterances[1].status, 'skipped');
    assert.match(result.progress.utterances[1].error, /Mention extraction failed for utterance 1: AI mention must reference the target utterance/);
    assert.deepEqual(result.data.mentions.map((mention: any) => mention.textSpan.lineIndex), [0]);
    assert.equal(clusteringCalls, 1);
    assert.equal(failedAttempts, 3);
  } finally { await new Promise<void>(resolve => fixture.close(() => resolve())); }
});

test('an upstream body timeout is retried, cancels each connection, and returns 504 with correlated logs', async () => {
  let attempts = 0;
  let closed = 0;
  const fixture = createServer((req, res) => {
    attempts++;
    res.on('close', () => { closed++; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(' '); // OpenRouter can send headers before generation has completed.
  });
  try {
    const port = await listen(fixture);
    const response = await annotate({ transcript: 'Patient: Synthetic timeout test.',
      aiConfig: { annotation: { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'timeout-test', apiKey: '' } } });
    assert.equal(response.status, 504);
    const result = await response.json();
    assert.equal(result.code, 'AI_TIMEOUT');
    assert.equal(result.progress.stage, 'failed');
    assert.equal(result.progress.utterances[0].status, 'skipped');
    assert.equal(response.headers.get('x-request-id'), result.requestId);
    assert.match(result.error, /utterance 0/);
    assert.equal(result.data, undefined);
    assert.equal(attempts, 3);
    for (let i = 0; i < 20 && closed < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closed, 3);
    const rows = readFileSync(path.join(directory, 'ai-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.requestId === result.requestId);
    const failures = rows.filter(row => row.event === 'request_failed');
    assert.deepEqual(failures.map(row => row.attempt), [1, 2, 3]);
    assert(failures.every(row => row.reason === 'AI_TIMEOUT' && row.timeoutMs === 1000 && row.httpStatus === 200));
    assert.equal(rows.filter(row => row.event === 'retry_scheduled').length, 2);
    assert(rows.some(row => row.event === 'annotation_failed' && row.reason === 'AI_TIMEOUT'));
    assert(!JSON.stringify(rows).includes('Synthetic timeout test'));
  } finally { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});

test('OpenAI-compatible annotation and relations work with no Gemini key or local endpoint key', async () => {
  provider = createServer(async (req, res) => {
    providerRequests++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined);
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const prompt = input.messages[0].content as string;
    let result: unknown;
    if (input.model === 'failing-model') { res.writeHead(503).end('Unavailable'); return; }
    if (input.model === 'bad-span-model') {
      result = { mentions: [{ lineIndex: 0, literalText: 'invented symptom', type: 'symptoms' }] };
    } else if (input.model.startsWith('mention-')) {
      const split = input.model === 'mention-split';
      if (prompt.includes('Extracted Mentions from Step 1:')) {
        assert.match(prompt, /Reference versus claim: preserve/);
        assert.match(prompt, /"evidenceRole"/);
        result = { entities: [{ name: 'Kidney function', type: 'fhir_observations', mentionIds: ['m1'],
          attributeMentionIds: split ? { interpretation: ['m2'] } : {}, attributes: split ? { interpretation: 'Low' } : {} }] };
      } else {
        assert.match(prompt, /NEVER confidence in extraction/);
        assert.match(prompt, /Asserted and uncertain are compatible/);
        assert.match(prompt, /not_applicable means this dimension does not apply/);
        assert.match(prompt, /default polarity to neutral and temporality to not_applicable/);
        result = { mentions: [{ lineIndex: 0, literalText: 'kidney function', canonicalName: 'Kidney function', type: 'fhir_observations',
          evidenceTarget: { kind: 'entity' },
          ...(input.model === 'mention-missing' ? {} : { evidenceRole: input.model === 'mention-invalid-role' ? 'invented' : 'reference' }),
          ...(input.model === 'mention-invalid-reference' ? { certainty: 'certain' } : {}),
          ...(input.model === 'mention-question' ? { function: 'questioned' } : {}),
          ...(input.model === 'mention-explicit-unassigned' ? { polarity: 'unassigned', temporality: 'unassigned' } : {}) },
          ...(split ? [{ lineIndex: 0, literalText: 'may be reduced', canonicalName: 'Kidney function', type: 'fhir_observations',
            evidenceRole: 'claim', certainty: 'uncertain', function: 'asserted', experiencer: 'patient', temporality: 'current',
            evidenceTarget: { kind: 'attribute', attributeName: 'interpretation' } }] : [])] };
      }
    } else if (input.model.startsWith('status-')) {
      const category = input.model === 'status-condition' ? 'fhir_conditions' : 'fhir_symptoms';
      const hasCue = !['status-condition', 'status-invalid'].includes(input.model);
      const cueField = input.model === 'status-scope' ? 'severity' : 'diagnosticAssessment';
      const hasWorkflow = hasCue && input.model !== 'status-unassigned';
      if (prompt.includes('Extracted Mentions from Step 1:')) {
        assert.match(prompt, /status is RESULT WORKFLOW only/);
        assert.match(prompt, /not_suspected, NOT ruled_out or absent/);
        const attributes = input.model === 'status-condition' ? { clinicalStatus: 'active', verificationStatus: 'unconfirmed' }
          : input.model === 'status-invalid' ? { status: 'refuted' }
          : input.model === 'status-unassigned' ? { diagnosticAssessment: 'not_suspected' }
          : input.model === 'status-scope' ? { status: 'final', severity: 'unassigned' }
          : { status: 'final', diagnosticAssessment: input.model === 'status-denial' ? 'absent' : 'not_suspected' };
        result = { entities: [{ name: 'Headache', type: category,
          description: 'Synthetic regression case: negative evidence must not overwrite unrelated statuses.',
          mentionIds: ['m1'], attributeMentionIds: { ...(hasCue ? { [cueField]: ['m2'] } : {}), ...(hasWorkflow ? { status: ['m3'] } : {}) }, attributes }] };
      } else {
        result = { mentions: [{ lineIndex: 0, literalText: 'Headache', canonicalName: 'Headache', type: category,
          polarity: 'neutral', certainty: 'uncertain', function: 'asserted', evidenceTarget: { kind: 'entity' } },
          ...(hasCue ? [{ lineIndex: 0, literalText: input.model === 'status-denial' ? 'Absent' : input.model === 'status-scope' ? 'Not severe' : 'No grounds to suspect',
            canonicalName: 'Headache', type: category, polarity: 'negative', evidenceTarget: { kind: 'attribute', attributeName: cueField } }] : []),
          ...(hasWorkflow ? [{ lineIndex: 0, literalText: 'Final report', canonicalName: 'Headache', type: category,
            evidenceTarget: { kind: 'attribute', attributeName: 'status' } }] : [])
        ] };
      }
    } else if (input.model.startsWith('trajectory-')) {
      const category = input.model === 'trajectory-fhir' ? 'fhir_symptoms' : 'symptoms';
      if (prompt.includes('Extracted Mentions from Step 1:')) {
        assert.match(prompt, /Trajectory attributes/);
        assert.match(prompt, /Do not infer clinical improvement\/worsening from numeric changes/);
        result = { entities: [{ name: 'Headache', type: category, mentionIds: ['m1'], attributeMentionIds: { trajectory: ['m2'] },
          attributes: { trajectory: { type: 'trajectory', direction: 'worsened', text: 'worse than a week ago',
            comparedTo: input.model === 'trajectory-invalid'
              ? { type: 'temporal', kind: 'duration', amount: { value: 1, unit: 'wk' }, precision: 'week', qualifier: 'exact' }
              : { type: 'temporal', kind: 'relative', anchor: { kind: 'encounter' }, offset: { value: -1, unit: 'wk' },
                precision: 'week', qualifier: 'exact', text: 'a week ago' } } } }] };
      } else {
        assert.match(prompt, /comparison phrase as trajectory attribute evidence/);
        result = { mentions: [
          { lineIndex: 0, literalText: 'Headache', canonicalName: 'Headache', type: category, evidenceTarget: { kind: 'entity' } },
          { lineIndex: 0, literalText: 'worse than a week ago', canonicalName: 'Headache', type: category,
            evidenceTarget: { kind: 'attribute', attributeName: 'trajectory' } }
        ] };
      }
    } else if (input.model === 'temporal-duration') {
      result = prompt.includes('Extracted Mentions from Step 1:')
        ? { entities: [{ name: 'Headache', type: 'symptoms', mentionIds: ['m1'], attributeMentionIds: { duration: ['m2'] },
          attributes: { duration: { type: 'temporal', kind: 'duration', amount: { value: 2, unit: 'wk' },
            precision: 'week', qualifier: 'exact', text: 'two weeks' } } }] }
        : { mentions: [
          { lineIndex: 0, literalText: 'Headache', canonicalName: 'Headache', type: 'symptoms', evidenceTarget: { kind: 'entity' } },
          { lineIndex: 0, literalText: 'two weeks', canonicalName: 'Headache', type: 'symptoms', evidenceTarget: { kind: 'attribute', attributeName: 'duration' } }
        ] };
    } else if (input.model === 'temporal-measurements') {
      if (prompt.includes('Extracted Mentions from Step 1:')) {
        assert.match(prompt, /2026-09-11/);
        const effective = (value: number) => ({ type: 'temporal', kind: 'relative', anchor: { kind: 'encounter' },
          offset: { value, unit: 'd' }, precision: 'day', qualifier: 'exact', text: value === -1 ? 'yesterday' : 'today' });
        result = { entities: [
          { id: 'first', name: 'Blood pressure', type: 'fhir_observations', mentionIds: ['m1'],
            attributeMentionIds: { value: ['m2'], effectiveTime: ['m3'] }, attributes: { value: '140', effectiveTime: effective(-1),
              partOf: { type: 'procedure-reference', procedureIds: ['model-invented-id'] } } },
          { id: 'second', name: 'Blood pressure', type: 'fhir_observations', mentionIds: [],
            attributeMentionIds: { value: ['m4'], effectiveTime: ['m5'] }, attributes: { value: '120', effectiveTime: effective(0) } }
        ] };
      } else {
        result = { mentions: ['Blood pressure', '140', 'yesterday', '120', 'today'].map((literalText, index) => ({
          lineIndex: 0, literalText, canonicalName: 'Blood pressure', type: 'fhir_observations',
          evidenceTarget: index === 0 ? { kind: 'entity' } : { kind: 'attribute', attributeName: index % 2 ? 'value' : 'effectiveTime' }
        })) };
      }
    } else if (prompt.includes('Extracted Mentions from Step 1:')) {
      result = { entities: [{ id: 'e1', name: 'Headache', type: 'symptoms',
        mentionIds: input.model === 'bad-cluster-model' ? ['m1', 'm2'] : ['m1'],
        attributeMentionIds: input.model === 'unmapped-attribute-model' ? {} : { onset: ['m2'] },
        attributes: { severity: 'Mild', onset: 'Tuesday' } }] };
    } else if (prompt.includes('Strict Rules:')) {
      result = { relations: [{ source: 'e1', target: 'e2', type: 'associated_with' }] };
    } else {
      result = { mentions: [
        { lineIndex: 0, literalText: 'headache', canonicalName: 'Headache', type: 'symptoms', polarity: 'negative',
          temporality: 'current', certainty: 'certain', experiencer: 'patient', function: 'asserted', evidenceTarget: { kind: 'entity' } },
        { lineIndex: 0, literalText: 'Tuesday', canonicalName: 'Headache', type: 'symptoms',
          evidenceTarget: { kind: 'attribute', attributeName: 'onset' } }
      ] };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  providerBase = `http://127.0.0.1:${await listen(provider)}/v1`;
  const aiConfig = { annotation: { provider: 'openai', baseUrl: providerBase, model: 'test-model', apiKey: '' } };
  const response = await annotate({ transcript: 'Patient: No headache since Tuesday.', aiConfig });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.data.mentions[0].polarity, 'negative');
  assert.equal(data.data.mentions[0].entityId, data.data.entities[0].id);
  assert.equal(data.data.evidenceVersion, 2);
  assert.equal(data.data.mentions[0].target.kind, 'entity');
  const onset = data.data.entities[0].attributes.find((a: any) => a.name === 'onset');
  assert.deepEqual(onset.value, normalizeTemporal('Tuesday'));
  assert.deepEqual(data.data.mentions[1].target, { kind: 'attribute', entityId: 'e1', attributeId: onset.id });
  assert.equal(data.data.mentions[1].supportedAttribute, undefined);
  const relations = await send('/relations', { aiConfig, entities: [{ id: 'e1' }, { id: 'e2' }], transcript: 'Synthetic' });
  assert.equal(relations.status, 200);
  assert.equal((await relations.json()).data.relations[0].type, 'ASSOCIATED_WITH');
  assert.equal(providerRequests, 3);
  for (const model of ['mention-split', 'mention-reference-defaults', 'mention-question', 'mention-missing', 'mention-explicit-unassigned', 'mention-invalid-role', 'mention-invalid-reference']) {
    const response = await annotate({ transcript: model === 'mention-question' ? 'Clinician: How is your kidney function?' : 'Clinician: Your kidney function may be reduced.',
      annotationSchema: FHIR_ANNOTATION_SCHEMA, aiConfig: { annotation: { ...aiConfig.annotation, model } } });
    const result = await response.json();
    if (model.startsWith('mention-invalid')) { assert.equal(response.status, 502); assert.equal(result.data, undefined); continue; }
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.data.mentionContextVersion, 1);
    const name = result.data.mentions[0];
    assert.equal(name.evidenceRole, model === 'mention-missing' ? 'unassigned' : 'reference');
    assert.equal(name.certainty, model === 'mention-missing' ? 'unassigned' : 'not_applicable');
    assert.equal(name.function, model === 'mention-missing' ? 'unassigned' : model === 'mention-question' ? 'questioned' : 'not_applicable');
    const unassigned = ['mention-missing', 'mention-explicit-unassigned'].includes(model);
    assert.equal(name.polarity, unassigned ? 'unassigned' : 'neutral');
    assert.equal(name.temporality, unassigned ? 'unassigned' : 'not_applicable');
    assert.equal(name.experiencer, 'unassigned');
    if (model === 'mention-split') {
      const claim = result.data.mentions[1];
      assert.equal(claim.evidenceRole, 'claim');
      assert.equal(claim.certainty, 'uncertain');
      assert.equal(claim.function, 'asserted');
      assert.equal(claim.temporality, 'current');
      assert.equal(claim.target.attributeId, result.data.entities[0].attributes.find((a: any) => a.name === 'interpretation').id);
      assert.equal(name.target.kind, 'entity');
    }
  }
  for (const model of ['status-assessment', 'status-denial', 'status-unassigned', 'status-scope', 'status-condition', 'status-invalid']) {
    const phrase = model === 'status-denial' ? 'Absent' : model === 'status-scope' ? 'Not severe' : 'No grounds to suspect';
    const response = await annotate({ transcript: 'Clinician: Headache. ' + phrase + '. Final report.', annotationSchema: FHIR_ANNOTATION_SCHEMA,
      aiConfig: { annotation: { ...aiConfig.annotation, model } } });
    const result = await response.json();
    if (model === 'status-invalid') {
      assert.equal(response.status, 200);
      assert.equal(result.data.entities[0].attributes.find((a: any) => a.name === 'status').value, 'unassigned');
      assert(result.data.mappingIssues.some((issue: any) => issue.attributeName === 'status' && issue.originalValue === 'refuted'));
      continue;
    }
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.data.observationStatusVersion, 1);
    const attributes = result.data.entities[0].attributes;
    const value = (name: string) => attributes.find((a: any) => a.name === name)?.value;
    if (model === 'status-condition') {
      assert.equal(value('clinicalStatus'), 'active');
      assert.equal(value('verificationStatus'), 'unconfirmed');
      assert.equal(value('status'), undefined);
    } else {
      assert.equal(value('status'), model === 'status-unassigned' ? 'unassigned' : 'final');
      assert.equal(value('diagnosticAssessment'), model === 'status-denial' ? 'absent' : model === 'status-scope' ? 'unassigned' : 'not_suspected');
      const cueField = model === 'status-scope' ? 'severity' : 'diagnosticAssessment';
      assert.equal(result.data.mentions[1].target.attributeId, attributes.find((a: any) => a.name === cueField).id);
      assert.equal(result.data.mentions[1].polarity, 'negative');
      if (model !== 'status-unassigned') assert.equal(result.data.mentions[2].target.attributeId, attributes.find((a: any) => a.name === 'status').id);
    }
  }
  for (const model of ['trajectory-standard', 'trajectory-fhir', 'trajectory-invalid']) {
    const response = await annotate({ transcript: 'Patient: Headache is worse than a week ago.',
      ...(model === 'trajectory-fhir' ? { annotationSchema: FHIR_ANNOTATION_SCHEMA } : {}),
      aiConfig: { annotation: { ...aiConfig.annotation, model } } });
    const result = await response.json();
    if (model === 'trajectory-invalid') {
      assert.equal(response.status, 200);
      const trajectory = result.data.entities[0].attributes.find((a: any) => a.name === 'trajectory').value;
      assert.equal(trajectory.direction, 'worsened');
      assert.equal(trajectory.comparedTo, null);
      assert(result.data.mappingIssues.some((issue: any) => issue.attributeName === 'trajectory'));
      continue;
    }
    assert.equal(response.status, 200, JSON.stringify(result));
    const entity = result.data.entities[0];
    const trajectory = entity.attributes.find((a: any) => a.name === 'trajectory');
    assert.equal(trajectory.value.direction, 'worsened');
    assert.deepEqual(trajectory.value.comparedTo.offset, { value: -1, unit: 'wk' });
    assert.equal(entity.attributes.find((a: any) => a.name === 'onset').value, null);
    assert.equal(result.data.mentions[0].target.kind, 'entity');
    assert.deepEqual(result.data.mentions[1].target, { kind: 'attribute', entityId: entity.id, attributeId: trajectory.id });
    const route = '/conversations/' + model;
    assert.equal((await send(route, { title: 'Synthetic trajectory', createdAt: '2026-09-11T00:00:00Z', status: 'annotated',
      rawTranscript: 'Headache is worse than a week ago.', transcriptSegments: [], annotation: result.data }, 'PUT')).status, 201);
    trajectory.value.comparedTo.anchor = { kind: 'attribute', entityId: entity.id, attributeId: 'missing' };
    assert.equal((await send(route, { annotation: result.data }, 'PATCH')).status, 400);
    const saved = await (await fetch(base + '/api' + route)).json();
    assert.equal(saved.annotation.entities[0].attributes.find((a: any) => a.name === 'trajectory').value.comparedTo.anchor.kind, 'encounter');
    assert.equal((await fetch(base + '/api' + route, { method: 'DELETE' })).status, 204);
  }
  const timed = await annotate({
    transcript: 'Patient: Blood pressure 140 yesterday, 120 today.', annotationSchema: FHIR_ANNOTATION_SCHEMA,
    encounterTime: { type: 'temporal', kind: 'absolute', date: '2026-09-11', precision: 'day', qualifier: 'exact' },
    aiConfig: { annotation: { ...aiConfig.annotation, model: 'temporal-measurements' } }
  });
  assert.equal(timed.status, 200);
  const timedResult = (await timed.json()).data;
  assert.equal(timedResult.entities.length, 2);
  assert.ok(timedResult.entities.every((e: any) => e.attributes.find((a: any) => a.name === 'partOf').value === null));
  assert.ok(timedResult.entities.every((e: any) => e.attributes.find((a: any) => a.name === 'trajectory').value === null));
  const [firstTime, secondTime] = timedResult.entities.map((e: any) => e.attributes.find((a: any) => a.name === 'effectiveTime'));
  assert.equal(firstTime.value.offset.value, -1);
  assert.equal(secondTime.value.offset.value, 0);
  assert.notEqual(firstTime.id, secondTime.id);
  assert.equal(timedResult.mentions.find((m: any) => m.textSpan.text === 'today').target.attributeId, secondTime.id);
  const invalidTime = await annotate({ transcript: 'Synthetic',
    encounterTime: { type: 'temporal', kind: 'absolute', date: '2026-02-30', precision: 'day', qualifier: 'exact' }, aiConfig });
  assert.equal(invalidTime.status, 400);
  const durationOnly = await annotate({ transcript: 'Patient: Headache lasted two weeks.',
    aiConfig: { annotation: { ...aiConfig.annotation, model: 'temporal-duration' } } });
  assert.equal(durationOnly.status, 200);
  const durationEntity = (await durationOnly.json()).data.entities[0];
  assert.equal(durationEntity.attributes.find((a: any) => a.name === 'duration').value.kind, 'duration');
  assert.equal(durationEntity.attributes.find((a: any) => a.name === 'onset').value, null);
  const badCluster = await annotate({ transcript: 'Patient: No headache since Tuesday.',
    aiConfig: { annotation: { ...aiConfig.annotation, model: 'bad-cluster-model' } } });
  assert.equal(badCluster.status, 200);
  const deduplicated = (await badCluster.json()).data;
  assert.equal(deduplicated.mentions.length, 2);
  assert.equal(deduplicated.mentions[1].target.kind, 'attribute');
  const unmappedCluster = await annotate({ transcript: 'Patient: No headache since Tuesday.',
    aiConfig: { annotation: { ...aiConfig.annotation, model: 'unmapped-attribute-model' } } });
  assert.equal(unmappedCluster.status, 200);
  const unmappedData = (await unmappedCluster.json()).data;
  assert.equal(unmappedData.entities.length, 1);
  assert.equal(unmappedData.mentions.length, 2);
  assert.equal(unmappedData.mentions[0].target.kind, 'entity');
  assert.equal(unmappedData.mentions[1].target, null);
  assert(unmappedData.mappingIssues.some((issue: any) => issue.mentionId === unmappedData.mentions[1].id));
  const failed = await send('/relations', { aiConfig: { annotation: { ...aiConfig.annotation, model: 'failing-model' } }, entities: [{ id: 'e1' }] });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).data, undefined);
  const badSpan = await annotate({ transcript: 'Patient: No headache.',
    aiConfig: { annotation: { ...aiConfig.annotation, model: 'bad-span-model' } } });
  assert.equal(badSpan.status, 502);
  assert.equal((await badSpan.json()).data, undefined);
});
