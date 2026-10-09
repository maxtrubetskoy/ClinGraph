import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('mentions persist across reload and mapping failure; retry never repeats extraction', async ({ page, request }) => {
  const id = 'annotation-stages-' + Date.now();
  let extractions = 0;
  let mappings = 0;
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages[0].content as string;
    let result: unknown;
    if (prompt.includes('Extracted Mentions from Step 1:')) {
      mappings++;
      if (mappings === 1) { res.writeHead(503).end('Unavailable'); return; }
      result = { entities: [{ name: 'Headache', type: 'symptoms', mentionIds: ['m1'],
        attributeMentionIds: mappings === 3 ? {} : { onset: ['m2'] }, attributes: { onset: mappings === 3
          ? { type: 'temporal', kind: 'absolute', date: '2026-99-40', precision: 'invalid', qualifier: 'maybe', text: 'Tuesday' }
          : 'Tuesday' } }] };
    } else {
      extractions++;
      result = { mentions: [
        { lineIndex: 0, literalText: 'Headache', canonicalName: 'Headache', type: 'symptoms', evidenceTarget: { kind: 'entity' } },
        { lineIndex: 0, literalText: 'Tuesday', canonicalName: 'Headache', type: 'symptoms', evidenceTarget: { kind: 'attribute', attributeName: 'onset' } }
      ] };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const port = (provider.address() as { port: number }).port;
  const previousSettings = (await (await request.get('/api/workspace')).json()).settings;
  const model = { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stages', apiKey: '' };
  const read = async () => (await request.get('/api/conversations/' + id)).json();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await request.put('/api/settings', { data: { annotation: model, transcription: model } });
    await request.put('/api/conversations/' + id, { data: {
      title: 'Independent stages', createdAt: new Date().toISOString(), status: 'annotated',
      rawTranscript: 'Patient: Headache since Tuesday.', transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Headache since Tuesday.' }],
      annotation: { entities: [{ id: 'curated', name: 'Curated headache', type: 'Symptom', categoryId: 'symptoms' }],
        mentions: [], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
    } });
    await page.goto('/?session=' + id);
    const map = page.getByRole('button', { name: 'Map entities', exact: true });
    await expect(map).toBeDisabled();
    await page.getByRole('button', { name: 'Extract mentions', exact: true }).click();
    await expect(map).toBeEnabled();
    const extracted = (await read()).mentionExtraction;
    expect(extracted.mentions).toHaveLength(2);
    expect(extracted.mentions[1].supportedAttribute).toBe('onset');
    expect((await read()).annotation.entities[0].id).toBe('curated');
    expect(mappings).toBe(0);
    await page.reload();
    await expect(page.getByText('2 extracted mentions saved', { exact: true })).toBeVisible();
    await map.click();
    await expect(page.getByText('Entity mapping failed', { exact: true })).toBeVisible();
    expect((await read()).mentionExtraction).toEqual(extracted);
    expect((await read()).annotation.entities[0].id).toBe('curated');
    await expect(page.getByText('Explore annotations', { exact: true })).toBeVisible();
    // Simulate a tab closing mid-request before it can clear persisted processing status.
    await request.patch('/api/conversations/' + id, { data: { status: 'processing', annotationProgress: null } });
    await page.reload();
    await page.getByRole('button', { name: 'Resume saved mentions', exact: true }).click();
    await expect(map).toBeEnabled();
    await map.click();
    await expect(page.getByText('Entity mapping complete', { exact: true })).toBeVisible();
    await expect.poll(async () => (await read()).annotation.entities[0].id).toBe('e1');
    const saved = await read();
    expect(saved.annotation.mentions.map((m: any) => m.id)).toEqual(['m1', 'm2']);
    expect(saved.annotation.mentions[1].target.kind).toBe('attribute');
    expect(saved.mentionExtraction).toEqual(extracted);
    expect(extractions).toBe(1);
    expect(mappings).toBe(2);
    // A later mapping with an invalid date and an omitted assignment still saves all mentions.
    await map.click();
    await expect(page.getByText('Entity mapping complete with warnings', { exact: true })).toBeVisible();
    const review = page.getByRole('region', { name: 'AI mapping review' });
    await expect(review).toContainText('2 warnings');
    await expect(review).toContainText('1 mention is currently unlinked');
    expect((await read()).annotation.mentions).toHaveLength(2);
    expect((await read()).annotation.mentions[1].target).toBeNull();
    await page.reload();
    await expect(review).toBeVisible();
    await review.getByText('Review mapping warnings', { exact: true }).click();
    await expect(review).toContainText('No entity was mapped; mention kept unlinked for review.');
    await review.getByText('Original model value', { exact: true }).click();
    await expect(review.locator('pre')).toContainText('2026-99-40');
    const warnings = (await read()).annotation.mappingIssues;
    await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
    await page.getByLabel('Onset source text', { exact: true }).fill('Tuesday (reviewed)');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await read()).annotation.entities[0].attributes.find((a: any) => a.name === 'onset').value.text).toBe('Tuesday (reviewed)');
    expect((await read()).annotation.mappingIssues).toEqual(warnings);
    await page.reload();
    await expect(review).toBeVisible();
    await review.getByText('Review mapping warnings', { exact: true }).click();
    await review.getByText('Original model value', { exact: true }).click();
    await expect(review.locator('pre')).toContainText('2026-99-40');
    expect(extractions).toBe(1);
    expect(mappings).toBe(3);
    const source = page.getByRole('textbox', { name: 'Conversation transcript', exact: true });
    await source.fill('Patient: Nausea.');
    await expect(map).toBeDisabled();
    await source.blur();
    await expect.poll(async () => (await read()).mentionExtraction).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await request.delete('/api/conversations/' + id);
    await request.put('/api/settings', { data: previousSettings || { annotation: model, transcription: model } });
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

test('another tab leaves live mapping alone and an explicitly superseded result cannot overwrite edits', async ({ page, context, request }) => {
  const id = 'annotation-tabs-' + Date.now();
  let finishMapping!: () => void;
  const pending = new Promise<void>(resolve => { finishMapping = resolve; });
  const second = await context.newPage();
  try {
    await request.put('/api/conversations/' + id, { data: {
      title: 'Two tabs', createdAt: new Date().toISOString(), status: 'draft', rawTranscript: 'Patient: Headache.',
      transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Headache.' }],
      mentionExtraction: { mentions: [{ id: 'm1', entityId: null, entityType: 'Symptom',
        textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'Headache' } }],
        progress: { operation: 'extraction', stage: 'complete', utterances: [{ lineIndex: 0, status: 'complete' }] } }
    } });
    await page.route('**/api/map-entities', async route => {
      await pending;
      await route.fulfill({ json: { success: true, progress: { operation: 'mapping', stage: 'complete', utterances: [] },
        data: { entities: [], mentions: [], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } } } });
    });
    await page.goto('/?session=' + id);
    await page.getByRole('button', { name: 'Map entities', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mapping entities…', exact: true })).toBeVisible();
    await second.goto('/?session=' + id);
    const resume = second.getByRole('button', { name: 'Resume saved mentions', exact: true });
    await expect(resume).toBeVisible();
    await expect(second.getByRole('textbox', { name: 'Conversation transcript', exact: true })).toBeDisabled();
    expect((await (await request.get('/api/conversations/' + id)).json()).status).toBe('processing');
    await resume.click();
    await second.getByRole('textbox', { name: 'Conversation transcript', exact: true }).fill('Patient: Nausea.');
    await second.getByRole('textbox', { name: 'Conversation transcript', exact: true }).blur();
    await expect.poll(async () => (await (await request.get('/api/conversations/' + id)).json()).rawTranscript).toBe('Patient: Nausea.');
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/conversations/' + id) && response.status() === 409);
    finishMapping();
    await rejected;
    await expect(page.getByRole('textbox', { name: 'Conversation transcript', exact: true })).toHaveValue('Patient: Nausea.');
    const saved = await (await request.get('/api/conversations/' + id)).json();
    expect(saved.rawTranscript).toBe('Patient: Nausea.');
    expect(saved.mentionExtraction).toBeNull();
    expect(saved.annotation).toBeUndefined();
  } finally {
    finishMapping();
    await second.close();
    await request.delete('/api/conversations/' + id);
  }
});

test('mapping uses the current saved extraction when acquiring a run, never a stale tab copy', async ({ page, request }) => {
  const id = 'annotation-stale-start-' + Date.now();
  let releaseStart!: () => void;
  const gate = new Promise<void>(resolve => { releaseStart = resolve; });
  let enteredStart!: () => void;
  const starting = new Promise<void>(resolve => { enteredStart = resolve; });
  let mappingCalls = 0;
  try {
    await request.put('/api/conversations/' + id, { data: {
      title: 'Stale source', createdAt: new Date().toISOString(), status: 'draft', rawTranscript: 'Patient: Headache.',
      transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Headache.' }],
      mentionExtraction: { mentions: [{ id: 'm1', entityId: null, entityType: 'Symptom',
        textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'Headache' } }],
        progress: { operation: 'extraction', stage: 'complete', utterances: [{ lineIndex: 0, status: 'complete' }] } }
    } });
    await page.route('**/api/conversations/' + id, async route => {
      if (route.request().method() === 'PATCH' && route.request().postDataJSON().status === 'processing') {
        enteredStart();
        await gate;
      }
      await route.continue();
    });
    await page.route('**/api/map-entities', async route => {
      mappingCalls++;
      await route.fulfill({ status: 502, json: { success: false, error: 'Stale mapping should not be requested' } });
    });
    await page.goto('/?session=' + id);
    await page.getByRole('button', { name: 'Map entities', exact: true }).click();
    await starting;
    await request.patch('/api/conversations/' + id, { data: { rawTranscript: 'Patient: Nausea.',
      transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Nausea.' }] } });
    releaseStart();
    await expect(page.getByText('Entity mapping failed', { exact: true })).toBeVisible();
    expect(mappingCalls).toBe(0);
    const saved = await (await request.get('/api/conversations/' + id)).json();
    expect(saved.rawTranscript).toBe('Patient: Nausea.');
    expect(saved.mentionExtraction).toBeNull();
    expect(saved.annotation).toBeUndefined();
  } finally { releaseStart(); await request.delete('/api/conversations/' + id); }
});
