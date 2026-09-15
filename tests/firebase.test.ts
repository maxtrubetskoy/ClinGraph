import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { firebaseConfig } from '../server/firebase';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST);
const projectId = 'demo-clingraph';
let child: ChildProcess;
let app: App;
let firestore: Firestore;
let legacyFirestore: Firestore;
let rules: RulesTestEnvironment;
let directory: string;
let base: string;
let logs = '';
let alice: { idToken: string; localId: string };
let bob: { idToken: string; localId: string };
const fixture = { title: 'Firebase synthetic encounter', createdAt: '2026-01-01T00:00:00Z',
  rawTranscript: 'Patient: Headache.', transcriptSegments: [{ id: 'seg1', speaker: 'Patient', text: 'Headache.' }], status: 'annotated',
  annotation: { evidenceVersion: 2, entities: [{ id: 'e1', name: 'Headache', type: 'Symptom', categoryId: 'symptoms',
    attributes: [{ id: 'severity1', name: 'severity', value: 'mild' }] }], mentions: [], relations: [],
    clinicalNotes: { symptoms: [], medications: [], followUps: [] } } };

before(async () => {
  if (!enabled) return;
  directory = mkdtempSync(path.join(tmpdir(), 'clingraph-firebase-test-'));
  app = initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, 'firebase-test');
  firestore = getFirestore(app);
  legacyFirestore = getFirestore(app, 'legacy-archive');
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':');
  rules = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: readFileSync('firestore.rules', 'utf8') } });
  const createUser = async () => {
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `test-${crypto.randomUUID()}@example.test`, password: 'test-password-only', returnSecureToken: true })
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  alice = await createUser(); bob = await createUser();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const apiPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${apiPort}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { env: {
    ...process.env, NODE_ENV: 'production', CLINGRAPH_STORAGE: 'firebase', FIREBASE_PROJECT_ID: projectId,
    FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`, FIRESTORE_DATABASE_ID: '(default)',
    LEGACY_FIRESTORE_DATABASE_ID: 'legacy-archive',
    PORT: String(apiPort), GEMINI_API_KEY: '', UMLS_API_KEY: '', CLINGRAPH_AI_LOG_PATH: path.join(directory, 'ai.jsonl'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', chunk => { logs += chunk; }); child.stderr!.on('data', chunk => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(logs);
});

test('workspace configuration rejects the original archive as a writable database', () => {
  const previous = process.env.FIRESTORE_DATABASE_ID;
  try {
    process.env.FIRESTORE_DATABASE_ID = 'ai-studio-clinicalconversa-3ce6f1dc-daba-4e40-8425-55a414691cb0';
    assert.throws(() => firebaseConfig(), /separate database/);
  } finally {
    if (previous === undefined) delete process.env.FIRESTORE_DATABASE_ID;
    else process.env.FIRESTORE_DATABASE_ID = previous;
  }
});

const oldAnnotation = {
  entities: [{ id: 'old-e1', name: 'Archived finding', type: 'Symptom' }], relations: [],
  clinicalNotes: { fhir_symptoms: [{ entityId: 'old-e1', name: 'Archived finding', status: 'refuted', onset: 'some years ago' }],
    custom_category: [{ entityId: 'old-e1', unconventional_field: { original: ['unchanged', 7] } }] },
  mentions: [{ id: 'old-m1', entityId: 'old-e1', supportedAttribute: 'status', certainty: 'uncertain',
    textSpan: { lineIndex: 0, startChar: 0, endChar: 6, text: 'Denied' } }]
};

test('legacy archive preserves the old schema exactly and rejects all mutations across databases', { skip: !enabled }, async () => {
  const oldRecord = { ...fixture, userId: alice.localId, title: 'Unconverted legacy session', annotation: oldAnnotation, groupId: 'old-group',
    audioDataUrl: 'data:audio/wav;base64,' + Buffer.from('archived audio').toString('base64') };
  const oldGroup = { userId: alice.localId, name: 'Original schema', settings: { annotationSchema: [
    { id: 'fhir_symptoms', attributes: [{ name: 'status', type: 'select', choices: ['final', 'refuted'] }] }
  ] } };
  const ref = legacyFirestore.collection('clinical_conversations').doc('archived-session');
  await ref.set(oldRecord);
  await legacyFirestore.collection('session_groups').doc('old-group').set(oldGroup);
  await legacyFirestore.collection('user_settings').doc(alice.localId).set({ oldSettings: true });
  const before = await ref.get();
  assert(!(await read('/workspace')).conversations.some((row: any) => row.id === ref.id));
  assert(!(await read('/workspace')).groups.some((row: any) => row.id === 'old-group'));
  assert.equal((await read('/workspace')).settings, null);
  assert.deepEqual(await read('/archive/sessions/' + ref.id), { id: ref.id, record: oldRecord, group: { id: 'old-group', record: oldGroup } });
  assert.equal(await (await call('/archive/sessions/' + ref.id + '/audio')).text(), 'archived audio');
  assert((await read('/archive/sessions')).some((row: any) => row.id === ref.id));
  assert.deepEqual(await read('/archive/sessions', bob), []);
  assert.equal((await call('/archive/sessions/' + ref.id, 'GET', undefined, bob)).status, 404);
  assert.equal((await call('/archive/sessions/' + ref.id + '/audio', 'GET', undefined, bob)).status, 404);
  for (const method of ['PUT', 'PATCH', 'POST', 'DELETE']) {
    for (const endpoint of ['/sessions/' + ref.id, '/sessions/' + ref.id + '/audio', '/groups/old-group', '/settings', '/sessions/' + ref.id + '/checkpoints']) {
      assert.equal((await call('/archive' + endpoint, method, {})).status, 405);
    }
  }
  assert.equal((await call('/conversations/' + ref.id, 'PATCH', { title: 'Changed' })).status, 404);
  assert.equal((await call('/conversations/' + ref.id, 'DELETE')).status, 404);
  assert.equal((await call('/conversations/' + ref.id + '/checkpoints', 'POST', {})).status, 404);
  assert.equal((await call('/groups/old-group', 'PATCH', { name: 'Changed' })).status, 404);
  // Even reusing an old ID creates an independent record only in the new database.
  assert.equal((await call('/conversations/' + ref.id, 'PUT', fixture)).status, 201);
  assert.equal((await call('/conversations/' + ref.id, 'DELETE')).status, 204);
  const after = await ref.get();
  assert.deepEqual(after.data(), oldRecord); assert(before.updateTime!.isEqual(after.updateTime!));
  assert.deepEqual((await legacyFirestore.collection('session_groups').doc('old-group').get()).data(), oldGroup);
});
after(async () => {
  if (!enabled) return;
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  await rules?.cleanup();
  if (app) await deleteApp(app);
  if (directory) rmSync(directory, { recursive: true, force: true });
});
const call = (route: string, method = 'GET', value?: unknown, user = alice) => fetch(base + '/api' + route, {
  method, headers: { Authorization: `Bearer ${user.idToken}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(value === undefined ? {} : { body: JSON.stringify(value) })
});
const read = async (route: string, user = alice) => {
  const response = await call(route, 'GET', undefined, user); assert.equal(response.status, 200, await response.clone().text()); return response.json();
};

test('Firebase API requires a verified token for workspace, audio, settings, and model calls', { skip: !enabled }, async () => {
  const runtime = await (await fetch(base + '/api/runtime')).json();
  assert.equal(runtime.storage, 'firebase'); assert.equal(runtime.firebase.projectId, projectId);
  for (const route of ['/workspace', '/settings', '/conversations/private/audio', '/annotate', '/relations', '/diarize', '/umls/search']) {
    for (const token of ['', 'invalid-token']) {
      const response = await fetch(base + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401, route);
    }
  }
  assert.equal((await read('/workspace')).conversations.length, 0);
});

test('original document layout and current annotation metadata survive writes, checkpoints, and restoration', { skip: !enabled }, async () => {
  const id = 'legacy-cloud';
  await firestore.collection('clinical_conversations').doc(id).set({ ...fixture, userId: alice.localId,
    audioDataUrl: 'data:audio/wav;base64,' + Buffer.from('legacy audio').toString('base64') });
  const original = await read('/conversations/' + id);
  assert.equal(original.annotation.entities[0].attributes.find((value: any) => value.id === 'severity1').value, 'mild');
  assert((await read('/workspace')).conversations.some((row: any) => row.id === id));
  assert.deepEqual((await read('/workspace', bob)).conversations, []);
  const progress = { stage: 'complete', utterances: [{ lineIndex: 0, status: 'complete' }] };
  assert.equal((await call('/conversations/' + id, 'PATCH', { annotationProgress: progress })).status, 200);
  assert.equal((await read('/conversations/' + id)).hasAudio, true);
  assert.equal((await call('/conversations/' + id + '/audio')).headers.get('content-type'), 'audio/wav');
  assert.equal(await (await call('/conversations/' + id + '/audio')).text(), 'legacy audio');
  const checkpoints = await Promise.all([call(`/conversations/${id}/checkpoints`, 'POST', { label: 'Baseline' }),
    call(`/conversations/${id}/checkpoints`, 'POST', { label: 'Concurrent capture' })]);
  const history = await Promise.all(checkpoints.map(async response => { assert.equal(response.status, 201, await response.clone().text()); return response.json(); }));
  assert.deepEqual(history.map(row => row.version).sort(), [1, 2]);
  const checkpoint = history[0];
  assert.deepEqual(checkpoint.snapshot.annotation, original.annotation);
  assert(!('userId' in checkpoint.snapshot)); assert(!('annotationProgress' in checkpoint.snapshot));
  const invalid = structuredClone(original.annotation);
  invalid.mentions = [{ id: 'broken', target: { kind: 'attribute', entityId: 'e1', attributeId: 'missing' }, textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'Headache' } }];
  assert.equal((await call('/conversations/' + id, 'PATCH', { annotation: invalid })).status, 400);
  assert.deepEqual((await read('/conversations/' + id)).annotation, original.annotation);
  assert.equal((await call('/conversations/' + id, 'PATCH', { rawTranscript: 'Patient: Changed.' })).status, 200);
  assert.equal((await read('/conversations/' + id)).annotationProgress, null);
  assert.deepEqual(await read(`/conversations/${id}/checkpoints/${checkpoint.id}`), checkpoint);
  const restoredResponse = await call(`/conversations/${id}/checkpoints/${checkpoint.id}/restore`, 'POST', {});
  assert.equal(restoredResponse.status, 201, await restoredResponse.clone().text());
  const restored = await restoredResponse.json();
  assert.notEqual(restored.id, id); assert.deepEqual(restored.annotation, checkpoint.snapshot.annotation);
  assert.deepEqual(restored.schemaSnapshot, checkpoint.schema); assert.equal(restored.rawTranscript, fixture.rawTranscript);
  for (const [route, method, value] of [
    [`/conversations/${id}`, 'GET'], [`/conversations/${id}`, 'PATCH', { title: 'Take over', userId: bob.localId }],
    [`/conversations/${id}`, 'DELETE'], [`/conversations/${id}/checkpoints`, 'POST', {}],
    [`/conversations/${id}/checkpoints/${checkpoint.id}`, 'GET'], [`/conversations/${id}/checkpoints/${checkpoint.id}/restore`, 'POST', {}],
    [`/conversations/${id}/audio`, 'GET']
  ] as const) assert.equal((await call(route, method, value, bob)).status, 404, route);
  const context = rules.authenticatedContext(alice.localId);
  await assertFails(getDoc(doc(context.firestore(), 'clinical_conversations', id)));
  await assertFails(setDoc(doc(context.firestore(), 'clinical_conversations', id, 'checkpoints', checkpoint.id), { replaced: true }));
});

test('settings and groups are user-scoped and group deletion detaches sessions', { skip: !enabled }, async () => {
  const config = { provider: 'openai', model: 'test-model', apiKey: 'alice-synthetic-key', baseUrl: 'http://localhost:1234/v1', concurrency: 7 };
  assert.equal((await call('/settings', 'PUT', { annotation: config, transcription: config })).status, 200);
  assert.equal((await read('/workspace')).settings.annotation.concurrency, 7);
  assert.equal((await read('/workspace', bob)).settings, null);
  assert.equal((await call('/settings', 'PUT', { annotation: { ...config, concurrency: 0 }, transcription: config })).status, 400);
  assert.equal((await read('/workspace')).settings.annotation.concurrency, 7);
  const group = { name: 'Synthetic group', createdAt: fixture.createdAt };
  assert.equal((await call('/groups/group-a', 'PUT', group)).status, 201);
  assert.equal((await call('/groups/group-b', 'PUT', group, bob)).status, 201);
  assert.equal((await call('/conversations/grouped', 'PUT', { ...fixture, groupId: 'group-b' })).status, 404);
  assert.equal((await call('/conversations/grouped', 'PUT', { ...fixture, groupId: 'group-a', userId: bob.localId })).status, 201);
  assert.equal((await read('/conversations/grouped')).userId, alice.localId);
  assert.equal((await call('/groups/group-a', 'DELETE', undefined, bob)).status, 404);
  assert.equal((await call('/groups/group-a', 'DELETE')).status, 204);
  assert.equal((await read('/conversations/grouped')).groupId, null);
  assert.equal((await call('/groups/group-a', 'PUT', group)).status, 201);
  assert.equal((await read('/conversations/grouped')).groupId, null);
});

test('large records and audio persist in Cloud Storage, with owner checks and exact checkpoint downloads', { skip: !enabled }, async () => {
  const transcript = 'Synthetic long transcript. '.repeat(40000);
  const id = 'large-cloud';
  const result = await call('/conversations/' + id, 'PUT', { ...fixture, rawTranscript: transcript });
  assert.equal(result.status, 201, await result.clone().text());
  const stored = (await firestore.collection('clinical_conversations').doc(id).get()).data()!;
  assert(stored.payloadPath); assert.equal(stored.payload, undefined);
  assert.equal((await read('/conversations/' + id)).rawTranscript, transcript);
  const response = await call(`/conversations/${id}/checkpoints`, 'POST', { label: 'Large archive' });
  assert.equal(response.status, 201, await response.clone().text());
  const checkpoint = await response.json();
  assert.equal((await read(`/conversations/${id}/checkpoints/${checkpoint.id}`)).snapshot.rawTranscript, transcript);
  const audio = Buffer.from('synthetic-audio-bytes');
  const upload = await fetch(base + `/api/conversations/${id}/audio`, { method: 'PUT', headers: {
    Authorization: `Bearer ${alice.idToken}`, 'Content-Type': 'audio/webm'
  }, body: audio });
  assert.equal(upload.status, 200, await upload.clone().text()); assert.equal((await upload.json()).hasAudio, true);
  const downloaded = await call(`/conversations/${id}/audio`); assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), audio);
  assert.equal((await call(`/conversations/${id}/audio`, 'GET', undefined, bob)).status, 404);
  assert.equal((await call(`/conversations/${id}/audio`, 'DELETE')).status, 200);
  assert.equal((await call(`/conversations/${id}/audio`)).status, 404);
  assert.equal((await call(`/conversations/${id}`, 'DELETE')).status, 204);
  assert.equal((await call(`/conversations/${id}/checkpoints/${checkpoint.id}`)).status, 404);
  const [files] = await getStorage(app).bucket().getFiles({ prefix: `clingraph/(default)/users/${alice.localId}/conversations/${id}/` });
  assert.equal(files.length, 0);
});

test('Google sign-in, cloud autosave, reload, and account switching work in the browser', { skip: !enabled, timeout: 60000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    // The emulator's optional visual library must not make auth tests depend on a CDN.
    await context.route('https://unpkg.com/**', route => route.fulfill({ status: 200, body: '',
      contentType: route.request().url().includes('.js') ? 'application/javascript' : 'text/css' }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const signIn = async (email: string) => {
      const popupPromise = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      await popup.getByRole('button', { name: 'Add new account' }).click();
      await popup.locator('#email-input').fill(email);
      await popup.locator('#display-name-input').fill(email.split('@')[0]);
      await popup.locator('#sign-in').click();
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    };
    await page.goto(base);
    await signIn('browser-alice@example.test');
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await page.getByLabel('Session Title (Optional)').fill('Alice cloud session');
    await page.getByRole('button', { name: 'Create Session', exact: true }).click();
    const heading = page.getByRole('heading', { name: 'Alice cloud session', level: 2 });
    await expect(heading).toBeVisible();
    await page.locator('textarea').first().fill('Patient: Cloud persistence.');
    await expect.poll(async () => {
      const records = await firestore.collection('clinical_conversations').where('title', '==', 'Alice cloud session').get();
      return records.docs[0]?.data().payload && JSON.parse(records.docs[0].data().payload).rawTranscript;
    }).toBe('Patient: Cloud persistence.');
    await page.reload();
    await expect(heading).toBeVisible();
    await expect(page.locator('textarea').first()).toHaveValue('Patient: Cloud persistence.');
    const user = await getAuth(app).getUserByEmail('browser-alice@example.test');
    const archived = { ...fixture, title: 'Browser legacy record', userId: user.uid, annotation: oldAnnotation };
    const oldRef = legacyFirestore.collection('clinical_conversations').doc('browser-archive');
    await oldRef.set(archived);
    const beforeArchive = await oldRef.get();
    await page.getByRole('button', { name: 'Legacy archive', exact: true }).click();
    const archiveDialog = page.getByRole('dialog', { name: 'Legacy archive' });
    await expect(archiveDialog.getByRole('heading', { name: 'Browser legacy record' })).toBeVisible();
    await expect(archiveDialog.getByText('some years ago', { exact: false }).first()).toBeVisible();
    await expect(archiveDialog.getByRole('button', { name: /delete|annotate|restore|edit/i })).toHaveCount(0);
    const downloadPromise = page.waitForEvent('download');
    await archiveDialog.getByRole('button', { name: 'Download original JSON' }).click();
    const downloaded = await downloadPromise;
    assert.deepEqual(JSON.parse(readFileSync((await downloaded.path())!, 'utf8')).record, archived);
    await page.getByRole('button', { name: 'Close archive' }).click();
    assert(beforeArchive.updateTime!.isEqual((await oldRef.get()).updateTime!));
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await signIn('browser-bob@example.test');
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
    await expect(heading).toHaveCount(0);
    await page.getByRole('button', { name: 'Legacy archive', exact: true }).click();
    await expect(page.getByText('No archived sessions for this account.')).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
