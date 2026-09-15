import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('frontend concurrency persists and controls live progress while preserving successful utterances', async ({ page, request }) => {
  const id = 'annotation-progress-' + Date.now();
  const otherId = id + '-other';
  const segments = [
    { id: 's0', speaker: 'Patient', text: 'Headache.' },
    { id: 'blank', speaker: 'Patient', text: ' ' },
    { id: 's2', speaker: 'Patient', text: 'Nausea.' },
    { id: 's3', speaker: 'Patient', text: 'Dizziness.' },
    { id: 's4', speaker: 'Patient', text: 'Cough.' },
    { id: 's5', speaker: 'Patient', text: 'Thank you.' },
    { id: 's6', speaker: 'Clinician', text: 'Goodbye.' },
  ];
  let releaseExtraction!: () => void;
  let releaseClustering!: () => void;
  const extraction = new Promise<void>(resolve => { releaseExtraction = resolve; });
  const clustering = new Promise<void>(resolve => { releaseClustering = resolve; });
  let failedAttempts = 0;
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages[0].content as string;
    let result: unknown;
    if (prompt.includes('Extracted Mentions from Step 1:')) {
      await clustering;
      result = { entities: [{ name: 'Headache', type: 'symptoms', mentionIds: ['m1'], attributes: {} }] };
    } else {
      const index = Number(prompt.match(/\[TARGET Utterance (\d+)\]/)![1]);
      if (index === 2) { failedAttempts++; res.writeHead(503).end(); return; }
      await extraction;
      result = { mentions: index === 0 ? [{ lineIndex: 0, literalText: 'Headache', canonicalName: 'Headache', type: 'symptoms', evidenceTarget: { kind: 'entity' } }] : [] };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const port = (provider.address() as { port: number }).port;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const previousSettings = (await (await request.get('/api/workspace')).json()).settings;
  const legacyModel = { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' };
  const legacySettings = { annotation: legacyModel, transcription: legacyModel };
  let sentConcurrency: unknown;
  try {
    await request.put('/api/settings', { data: legacySettings });
    await request.put('/api/conversations/' + otherId, { data: {
      title: 'Other progress session', createdAt: '2026-01-01T00:00:00Z', status: 'draft', rawTranscript: '', transcriptSegments: []
    } });
    await request.put('/api/conversations/' + id, { data: {
      title: 'AI progress browser test', createdAt: '2026-01-02T00:00:00Z', status: 'draft',
      rawTranscript: segments.map(segment => JSON.stringify(segment)).join('\n'), transcriptSegments: segments
    } });
    await page.route('**/api/annotate', async route => {
      const input = route.request().postDataJSON();
      const config = typeof input.aiConfig === 'string' ? JSON.parse(input.aiConfig) : input.aiConfig;
      sentConcurrency = config.annotation.concurrency;
      await route.continue({ postData: JSON.stringify({ ...input, aiConfig: {
        annotation: { ...config.annotation, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'progress-fixture', apiKey: '' }
      } }) });
    });
    await page.goto('/?session=' + id);
    await page.getByRole('button', { name: 'AI Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'AI Settings', exact: true });
    const concurrency = dialog.getByRole('spinbutton', { name: 'Parallel utterances', exact: true });
    const save = dialog.getByRole('button', { name: 'Save Configuration', exact: true });
    await expect(concurrency).toHaveValue('4');
    for (const invalid of ['', '0', '33', '1.5']) {
      await concurrency.fill(invalid);
      await expect(save).toBeDisabled();
      await expect(concurrency).toHaveAttribute('aria-invalid', 'true');
    }
    await concurrency.fill('3');
    await expect(save).toBeEnabled();
    await concurrency.scrollIntoViewIfNeeded();
    await dialog.screenshot({ path: 'test-results/annotation-concurrency-settings.png' });
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect((await (await request.get('/api/workspace')).json()).settings.annotation.concurrency).toBe(3);
    await page.reload();
    await page.getByRole('button', { name: 'AI Settings', exact: true }).click();
    await expect(concurrency).toHaveValue('3');
    await concurrency.fill('5');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Generate AI Annotations', exact: true }).click();
    const panel = page.getByRole('region', { name: 'AI annotation progress' });
    await expect(panel.getByText('3 in progress', { exact: true })).toBeVisible();
    await expect(panel.getByText('3 pending', { exact: true })).toBeVisible();
    expect(sentConcurrency).toBe(3);
    await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '6');
    await panel.getByText('Utterance details', { exact: true }).click();
    await expect(panel.getByRole('listitem', { name: 'Utterance 1: In progress', exact: true })).toBeVisible();
    await expect(panel.getByRole('listitem', { name: /^Utterance 2:/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hypertension Follow-up', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Other progress session', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'AI progress browser test', exact: true }).click();
    await expect(panel.getByText('3 in progress', { exact: true })).toBeVisible();
    // The failed worker must advance to another pending utterance while its peers are still running.
    await expect(panel.getByText('1 skipped due to an error', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText('3 in progress', { exact: true })).toBeVisible();
    await expect(panel.getByText('2 pending', { exact: true })).toBeVisible();
    await panel.screenshot({ path: 'test-results/annotation-progress-running.png' });
    releaseExtraction();
    await expect(panel.getByText('5 complete', { exact: true })).toBeVisible();
    await expect(panel.getByText('Organizing clinical entities…', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText('1 skipped due to an error', { exact: true })).toBeVisible();
    await expect(panel.getByText('AI annotation complete', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '6');
    releaseClustering();
    await expect(panel.getByText('AI annotation finished with skipped utterances', { exact: true })).toBeVisible();
    await expect.poll(async () => (await (await request.get('/api/conversations/' + id)).json()).status).toBe('annotated');
    expect(failedAttempts).toBe(3);
    await page.reload();
    await expect(panel.getByText('5 complete', { exact: true })).toBeVisible();
    await expect(panel.getByText('1 skipped due to an error', { exact: true })).toBeVisible();
    await panel.getByText('Utterance details', { exact: true }).click();
    await expect(panel.getByRole('listitem', { name: /^Utterance 3: Skipped due to an error/ })).toBeVisible();
    await expect(panel.getByText(/Utterance 3: AI provider returned HTTP 503/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/annotation-progress-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.screenshot({ path: 'test-results/annotation-progress.png' });
    await page.getByRole('textbox', { name: 'Conversation transcript', exact: true }).fill('Patient: Updated transcript.');
    await page.getByRole('textbox', { name: 'Conversation transcript', exact: true }).blur();
    await expect(panel).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    releaseExtraction();
    releaseClustering();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await request.delete('/api/conversations/' + id);
    await request.delete('/api/conversations/' + otherId);
    await request.put('/api/settings', { data: previousSettings || legacySettings });
  }
});

test('interrupted progress stops the spinner and preserves existing annotations', async ({ page, request }) => {
  const id = 'annotation-interrupted-' + Date.now();
  try {
    await request.put('/api/conversations/' + id, { data: {
      title: 'Interrupted annotation', createdAt: '2026-01-01T00:00:00Z', status: 'annotated', rawTranscript: 'Patient: Headache.',
      transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Headache.' }],
      annotation: { entities: [{ id: 'curated', name: 'Curated headache', type: 'Symptom', categoryId: 'symptoms' }],
        relations: [], mentions: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
    } });
    await page.route('**/api/annotate', route => route.fulfill({
      contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'progress', progress: {
        stage: 'extracting', utterances: [{ lineIndex: 0, status: 'in_progress' }]
      } }) + '\n'
    }));
    await page.goto('/?session=' + id);
    await page.getByRole('button', { name: 'Generate AI Annotations', exact: true }).click();
    const panel = page.getByRole('region', { name: 'AI annotation progress' });
    await expect(panel.getByText('AI annotation failed', { exact: true })).toBeVisible();
    await expect(panel.getByText('0 in progress', { exact: true })).toBeVisible();
    await expect(panel.getByText('1 not processed', { exact: true })).toBeVisible();
    await expect(panel.getByText(/Annotation connection interrupted/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate AI Annotations', exact: true })).toBeEnabled();
    const saved = await (await request.get('/api/conversations/' + id)).json();
    expect(saved.annotation.entities[0].id).toBe('curated');
    expect(saved.annotationProgress.stage).toBe('failed');
  } finally { await request.delete('/api/conversations/' + id); }
});
