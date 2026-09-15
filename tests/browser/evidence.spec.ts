import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function selectText(page: Page, text: string) {
  await page.locator('[data-segment-idx="0"] .select-text').evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf(text);
      if (start === -1) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error('Text not found: ' + text);
  }, text);
}

test('attribute evidence can be created, retargeted, edited, reloaded, graphed and exported', async ({ page, request }) => {
  const id = 'attribute-browser-' + Date.now();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const read = async () => (await (await request.get('/api/conversations/' + id)).json()).annotation;
  const created = await request.put('/api/conversations/' + id, { data: {
    title: 'Attribute evidence test', createdAt: new Date().toISOString(), status: 'annotated',
    rawTranscript: 'Patient: A headache since Tuesday.',
    transcriptSegments: [{ id: 'seg1', speaker: 'Patient', text: 'A headache since Tuesday.' }],
    annotation: { evidenceVersion: 2, entities: [], relations: [], mentions: [],
      clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  } });
  expect(created.status()).toBe(201);
  try {
    await page.goto('/?session=' + id);
    await expect(page.getByRole('heading', { name: 'Attribute evidence test', level: 2 })).toBeVisible();
    await selectText(page, 'headache');
    await page.getByLabel('Annotation schema category', { exact: true }).selectOption('symptoms');
    await page.getByRole('button', { name: 'Create Entity', exact: true }).click();
    await expect.poll(async () => (await read()).mentions.length).toBe(1);
    const first = await read();
    const entityId = first.entities[0].id;
    const onset = first.entities[0].attributes.find((a: any) => a.name === 'onset');
    expect(first.mentions[0].target).toEqual({ kind: 'entity', entityId });

    await selectText(page, 'Tuesday');
    await page.getByLabel('Evidence entity', { exact: true }).selectOption(entityId);
    await page.getByLabel('Evidence supports', { exact: true }).selectOption('attribute');
    await expect(page.getByRole('button', { name: 'Link Evidence', exact: true })).toBeDisabled();
    await page.getByLabel('Evidence attribute', { exact: true }).selectOption(onset.id);
    await page.getByRole('button', { name: 'Link Evidence', exact: true }).click();
    await expect.poll(async () => (await read()).mentions.length).toBe(2);
    const linked = await read();
    const attributeMention = linked.mentions.find((m: any) => m.textSpan.text === 'Tuesday');
    expect(attributeMention.target).toEqual({ kind: 'attribute', entityId, attributeId: onset.id });
    expect(linked.entities).toHaveLength(1);
    expect(linked.entities[0].textSpan.text).toBe('headache');

    const attributeEvidence = page.getByTestId('attribute-evidence-' + entityId);
    await attributeEvidence.getByRole('button', { name: '“Tuesday”' }).click();
    const target = page.getByLabel('Evidence target for Tuesday', { exact: true });
    await expect(target).toHaveValue(onset.id);
    await target.selectOption('__entity__');
    await expect.poll(async () => (await read()).mentions.find((m: any) => m.id === attributeMention.id).target.kind).toBe('entity');
    await target.selectOption(onset.id);
    await expect.poll(async () => (await read()).mentions.find((m: any) => m.id === attributeMention.id).target.attributeId).toBe(onset.id);

    await page.getByRole('button', { name: 'Edit headache', exact: true }).click();
    await page.getByLabel('Onset format', { exact: true }).selectOption('text');
    await page.getByLabel('Onset source text', { exact: true }).fill('Tuesday');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await read()).entities[0].attributes.find((a: any) => a.id === onset.id).value.text).toBe('Tuesday');
    expect((await read()).entities[0].attributes.map((a: any) => a.name)).toEqual(first.entities[0].attributes.map((a: any) => a.name));

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Attribute evidence test', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
    const graph = page.getByRole('region', { name: 'Evidence graph' });
    await expect(graph.locator('li[data-node-kind="patient"]')).toHaveCount(1);
    await expect(graph.locator('li[data-node-kind="encounter"]')).toHaveCount(1);
    await expect(graph.locator('li[data-node-kind="entity"] > ul > li[data-node-kind="mention"]')).toHaveCount(1);
    await expect(graph.locator('li[data-node-kind="attribute"] > ul > li[data-node-kind="mention"]')).toHaveCount(1);
    await expect(graph.getByText('onset = Tuesday', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/attribute-evidence-graph.png', fullPage: true });

    await page.getByTitle('Export annotated dataset (JSONL)').click();
    await page.getByRole('button', { name: /Full Session Record/ }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
    const download = await downloadPromise;
    const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(exported.mentions.find((m: any) => m.id === attributeMention.id).target.attributeId).toBe(onset.id);
    expect(exported.evidenceGraph.edges.filter((e: any) => e.type === 'EVIDENCED_BY')).toHaveLength(2);
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    await graph.getByRole('button', { name: '“Tuesday”', exact: true }).click();
    await expect(page.getByLabel('Evidence target for Tuesday', { exact: true })).toHaveValue(onset.id);
    await page.getByTitle('Delete this specific mention highlight (retains parent entity)').click();
    await expect.poll(async () => (await read()).mentions.length).toBe(1);
    await page.reload();
    expect((await read()).entities[0].attributes.find((a: any) => a.id === onset.id).value.text).toBe('Tuesday');
    expect((await read()).mentions).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await request.delete('/api/conversations/' + id); }
});
