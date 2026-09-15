import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

let fixtureId: string | undefined;
test.afterEach(async ({ request }) => {
  if (!fixtureId) return;
  const workspace = await (await request.get('/api/workspace')).json();
  for (const session of workspace.conversations) {
    if (session.id === fixtureId || session.restoredFrom?.conversationId === fixtureId) {
      await request.delete('/api/conversations/' + session.id);
    }
  }
  if (workspace.groups.some((group: any) => group.id === fixtureId + '-group')) {
    await request.delete('/api/groups/' + fixtureId + '-group');
  }
  fixtureId = undefined;
});

test('checkpoint UI captures pending text, freezes schema, downloads exact history and restores independently', async ({ page, request }) => {
  const id = fixtureId = 'checkpoints-browser-' + Date.now();
  const groupId = id + '-group';
  const schema = [{ id: 'custom_observation', entityType: 'Observation', displayName: 'Original schema category', attributes: [
    { name: 'name', type: 'text' }, { name: 'interpretation', type: 'select', choices: ['unassigned', 'stable', 'unstable'] }
  ] }];
  expect((await request.put('/api/groups/' + groupId, { data: { name: 'Checkpoint test study', createdAt: '2026-01-01T00:00:00Z',
    settings: { annotationSchema: schema } } })).status()).toBe(201);
  expect((await request.put('/api/conversations/' + id, { data: {
    title: 'Checkpoint browser regression', createdAt: '2026-01-01T00:00:00Z', status: 'annotated', groupId,
    rawTranscript: 'Clinician: Stable.', transcriptSegments: [{ id: 'seg1', speaker: 'Clinician', text: 'Stable.' }],
    annotation: { evidenceVersion: 2, entities: [{ id: 'e1', categoryId: 'custom_observation', type: 'Observation', name: 'Kidney function',
      attributes: [{ id: 'a1', name: 'interpretation', value: 'stable' }] }],
      mentions: [{ id: 'm1', entityId: 'e1', entityType: 'Observation', target: { kind: 'attribute', entityId: 'e1', attributeId: 'a1' },
        textSpan: { segmentId: 'seg1', lineIndex: 0, startChar: 0, endChar: 6, text: 'Stable' } }],
      relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  } })).status()).toBe(201);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const read = async () => (await request.get('/api/conversations/' + id)).json();
  const checkpoints = async () => (await request.get('/api/conversations/' + id + '/checkpoints')).json();
  await page.goto('/?session=' + id);
  await expect(page.getByRole('heading', { name: 'Checkpoint browser regression', level: 2 })).toBeVisible();
  // Click immediately: blur must flush the 450ms debounce before the checkpoint save queue.
  const source = 'Clinician: Stable. Newly saved source — é.';
  await page.locator('textarea').first().fill(source);
  await page.getByRole('button', { name: 'Annotation history', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Annotation history', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Checkpoint label (optional)').fill('Reviewed baseline');
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(dialog.getByRole('article', { name: 'Checkpoint preview' })).toContainText(source);
  await expect.poll(async () => (await checkpoints()).length).toBe(1);
  const firstSummary = (await checkpoints())[0];
  const first = await (await request.get('/api/conversations/' + id + '/checkpoints/' + firstSummary.id)).json();
  expect(first.snapshot.rawTranscript).toBe(source);
  expect(first.snapshot.annotation).toEqual((await read()).annotation);
  await dialog.screenshot({ path: 'test-results/annotation-history.png' });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download checkpoint JSON', exact: true }).click();
  const downloaded = await downloadPromise;
  expect(JSON.parse(await readFile((await downloaded.path())!, 'utf8'))).toEqual(first);
  await dialog.getByRole('button', { name: 'Close annotation history' }).click();

  const newAnnotation = structuredClone(first.snapshot.annotation);
  newAnnotation.entities[0].attributes.find((a: any) => a.id === 'a1').value = 'unstable';
  expect((await request.patch('/api/conversations/' + id, { data: {
    rawTranscript: 'Clinician: Different source.', transcriptSegments: [{ id: 'different', speaker: 'Clinician', text: 'Different source.' }], annotation: newAnnotation
  } })).status()).toBe(200);
  expect((await request.patch('/api/groups/' + groupId, { data: { settings: {
    annotationSchema: [{ ...schema[0], displayName: 'Changed schema category' }]
  } } })).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Annotation history', exact: true }).click();
  await dialog.getByLabel('Checkpoint label (optional)').fill('Changed version');
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect.poll(async () => (await checkpoints()).length).toBe(2);
  expect((await checkpoints())[0].schemaVersion).not.toBe(first.schemaVersion);
  await dialog.getByRole('button', { name: /v1 · Reviewed baseline/ }).click();
  await expect(dialog.getByRole('article', { name: 'Checkpoint preview' })).toContainText(source);
  await dialog.getByRole('button', { name: 'Restore as new session', exact: true }).click();
  await expect(dialog).toContainText('current session and checkpoint remain unchanged');
  await dialog.getByRole('button', { name: 'Create restored session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Checkpoint browser regression (restored v1)', level: 2 })).toBeVisible();
  await expect(page.locator('textarea').first()).toHaveValue(source);
  await expect(page.getByText('This restored session uses its captured schema', { exact: false })).toBeVisible();
  const restoredId = new URL(page.url()).searchParams.get('session');
  expect(restoredId).not.toBe(id);
  const restored = await (await request.get('/api/conversations/' + restoredId)).json();
  expect(restored.schemaSnapshot).toEqual(first.schema);
  expect(restored.annotation).toEqual(first.snapshot.annotation);
  expect((await read()).rawTranscript).toBe('Clinician: Different source.');
  expect(await (await request.get('/api/conversations/' + id + '/checkpoints/' + first.id)).json()).toEqual(first);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Checkpoint browser regression (restored v1)', level: 2 })).toBeVisible();
  await expect(page.locator('textarea').first()).toHaveValue(source);
  expect(errors).toEqual([]);
});

test('AI regeneration checkpoints the curated annotation before replacing it', async ({ page, request }) => {
  const id = fixtureId = 'checkpoint-ai-browser-' + Date.now();
  expect((await request.put('/api/conversations/' + id, { data: {
    title: 'AI checkpoint regression', createdAt: '2026-01-01T00:00:00Z', status: 'annotated',
    rawTranscript: 'Patient: Headache.', transcriptSegments: [{ id: 'seg1', speaker: 'Patient', text: 'Headache.' }],
    annotation: { entities: [{ id: 'curated', name: 'Curated headache', type: 'Symptom', categoryId: 'symptoms' }], relations: [], mentions: [],
      clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  } })).status()).toBe(201);
  const initial = await (await request.get('/api/conversations/' + id)).json();
  let sawCheckpointBeforeModelCall = false;
  await page.route('**/api/annotate', async route => {
    const history = await (await request.get('/api/conversations/' + id + '/checkpoints')).json();
    sawCheckpointBeforeModelCall = history.length === 1 && history[0].reason === 'before-ai';
    await route.fulfill({ json: { success: true, data: {
      title: 'Synthetic model output', entities: [], mentions: [], transcriptSegments: initial.transcriptSegments,
      clinicalNotes: { symptoms: [], medications: [], followUps: [] }
    } } });
  });
  await page.goto('/?session=' + id);
  await page.getByRole('button', { name: 'Generate AI Annotations', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/conversations/' + id)).json()).annotation.entities.length).toBe(0);
  expect(sawCheckpointBeforeModelCall).toBe(true);
  const history = await (await request.get('/api/conversations/' + id + '/checkpoints')).json();
  const checkpoint = await (await request.get('/api/conversations/' + id + '/checkpoints/' + history[0].id)).json();
  expect(checkpoint.snapshot.annotation).toEqual(initial.annotation);
  expect(checkpoint.snapshot.rawTranscript).toEqual(initial.rawTranscript);
  expect(checkpoint.snapshot.status).toBe('annotated');
});
