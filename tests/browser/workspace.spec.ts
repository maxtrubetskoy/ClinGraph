import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('no-login session creation, manual annotation, reload, local link, and JSONL export', async ({ page, request }) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (/^https?:/.test(req.url()) && !req.url().startsWith('http://127.0.0.1:3108/')) externalRequests.push(req.url()); });
  const title = `Browser test ${Date.now()}`;
  let id: string | undefined;
  try {
    await page.goto('/');
    await expect(page.getByText('Local workspace · No login')).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign In/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await page.getByLabel('Session Title (Optional)').fill(title);
    await page.getByRole('button', { name: 'Create Session', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
    const workspace = await (await request.get('/api/workspace')).json();
    id = workspace.conversations.find((c: any) => c.title === title).id;
    // A short silent WAV tests upload/playback without a physical microphone or provider.
    const wav = Buffer.alloc(44 + 3200);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40);
    await page.locator('#audio-upload-input').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav });
    await expect(page.locator('audio')).toBeVisible();
    expect(await (await request.get(`/api/conversations/${id}/audio`)).body()).toEqual(wav);
    const editor = page.locator('textarea').first();
    await editor.fill('Patient: No headache today.');
    await page.getByRole('button', { name: 'Annotate Manually', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/conversations/${id}`)).json()).status).toBe('annotated');
    await page.reload();
    await expect(editor).toHaveValue('Patient: No headache today.');
    await expect(page.locator('audio')).toBeVisible();
    const utterance = page.locator('[data-segment-idx="0"] .select-text');
    await utterance.evaluate(element => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 3);
      range.setEnd(element.firstChild!, 11);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('select').filter({ has: page.locator('option[value="symptoms"]') }).selectOption('symptoms');
    await page.getByRole('button', { name: 'Create Entity', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/conversations/${id}`)).json()).annotation.mentions.length).toBe(1);
    await page.getByRole('button', { name: 'Session Link', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Local Session Link' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto(`/?session=${id}`);
    await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
    await page.getByTitle('Export annotated dataset (JSONL)').click();
    await expect(page.getByRole('heading', { name: 'Export Annotated Dataset (JSONL)' })).toBeVisible();
    await page.getByRole('button', { name: /Full Session Record/ }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
    const downloaded = await downloadPromise;
    const record = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
    expect(record.rawTranscript).toBe('Patient: No headache today.');
    expect(record.mentions[0].textSpan.text).toBe('headache');
    expect(record.mentions[0].polarity).toBe('unassigned');
    expect(record.entities[0].id).toBe(record.mentions[0].entityId);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.screenshot({ path: 'test-results/local-workspace.png', fullPage: true });
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    const workspace = await (await request.get('/api/workspace')).json();
    for (const conversation of workspace.conversations) {
      if (conversation.title === title) await request.delete(`/api/conversations/${conversation.id}`);
    }
  }
});
