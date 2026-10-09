import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('one Dutch pronoun can link to Cellcept and Prednison, with independent editing, reload and export', async ({ page, request }) => {
  const id = 'multiple-targets-' + Date.now();
  const read = async () => (await (await request.get('/api/conversations/' + id)).json()).annotation;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.put('/api/conversations/' + id, { data: { title: 'Shared medication reference', createdAt: new Date().toISOString(), status: 'annotated',
    rawTranscript: 'Clinician: En je gebruikt ook nog de Cellcept en de Prednison?\nPatient: Ja ja die heb ik wel gewoon normaal gebruikt ja.',
    transcriptSegments: [
      { id: 's0', speaker: 'Clinician', text: 'En je gebruikt ook nog de Cellcept en de Prednison?', timestamp: '03:45 - 03:49' },
      { id: 's1', speaker: 'Patient', text: 'Ja ja die heb ik wel gewoon normaal gebruikt ja.', timestamp: '03:49 - 03:52' }
    ],
    annotation: { evidenceVersion: 2, entities: ['Cellcept', 'Prednison'].map(name => ({ id: name.toLowerCase(), name, type: 'Medication', categoryId: 'medications',
      attributes: [{ id: name + '-name', name: 'name', value: name }, { id: name + '-action', name: 'action', value: 'Continue' }] })),
      mentions: [{ id: 'die', entityType: 'Medication', entityId: 'cellcept', target: { kind: 'entity', entityId: 'cellcept' },
        evidenceRole: 'reference', certainty: 'not_applicable', textSpan: { lineIndex: 1, startChar: 6, endChar: 9, text: 'die' } }],
      relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  } });
  try {
    await page.goto('/?session=' + id);
    await page.locator('#mention-die').click();
    const transcriptLinks = page.getByRole('region', { name: 'Transcript Mention links for die', exact: true });
    await transcriptLinks.getByLabel('Transcript Link entity to die', { exact: true }).selectOption('prednison');
    await expect.poll(async () => (await read()).mentions[0].targets?.length).toBe(2);
    expect((await read()).mentions).toHaveLength(1);
    expect((await read()).mentions[0].evidenceRole).toBe('reference');
    await expect(page.locator('#mention-die')).toHaveCount(1);
    await expect(page.locator('#mention-die')).toHaveAttribute('title', /Cellcept, Prednison/);
    await page.reload();
    await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
    const graph = page.getByRole('region', { name: 'Evidence graph' });
    await expect(graph.locator('li[data-node-kind="mention"]')).toHaveCount(2);
    const prednison = graph.locator('li[data-node-kind="entity"]').filter({ hasText: 'Prednison' });
    await prednison.getByRole('button', { name: '“die”', exact: true }).click();
    const noteLinks = page.getByRole('region', { name: 'Mention links for die', exact: true });
    await noteLinks.getByLabel('Evidence target for die · Prednison', { exact: true }).selectOption('Prednison-action');
    await expect.poll(async () => (await read()).mentions[0].targets?.find((t: any) => t.entityId === 'prednison')?.attributeId).toBe('Prednison-action');
    expect((await read()).mentions[0].targets.find((t: any) => t.entityId === 'cellcept').kind).toBe('entity');
    await page.getByRole('button', { name: 'Entity Relations', exact: true }).click();
    await page.locator('svg text').filter({ hasText: /^Cellcept$/ }).click();
    await expect(page.getByRole('heading', { name: 'Cellcept', exact: true })).toBeVisible();
    await expect(page.getByText('Supported Attributes:', { exact: true })).toHaveCount(0);
    await page.locator('svg text').filter({ hasText: /^Prednison$/ }).click();
    await expect(page.getByRole('heading', { name: 'Prednison', exact: true })).toBeVisible();
    await expect(page.getByText('Supported Attributes:', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
    await graph.locator('li[data-node-kind="entity"]').filter({ hasText: 'Prednison' }).getByRole('button', { name: '“die”', exact: true }).click();
    await page.getByTitle('Export annotated dataset (JSONL)').click();
    await page.getByRole('button', { name: /Full Session Record/ }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
    const exported = JSON.parse(await readFile((await (await downloadPromise).path())!, 'utf8'));
    expect(exported.mentions).toHaveLength(1);
    expect(exported.mentions[0].targets).toHaveLength(2);
    expect(exported.evidenceGraph.nodes.filter((n: any) => n.kind === 'mention')).toHaveLength(1);
    expect(exported.evidenceGraph.edges.filter((e: any) => e.type === 'EVIDENCED_BY')).toHaveLength(2);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await noteLinks.getByRole('button', { name: 'Remove link to Cellcept', exact: true }).click();
    await expect.poll(async () => (await read()).mentions[0].target?.entityId).toBe('prednison');
    await page.reload();
    expect((await read()).mentions[0].target).toEqual({ kind: 'attribute', entityId: 'prednison', attributeId: 'Prednison-action' });
    expect((await read()).mentions).toHaveLength(1);
    await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
    await page.locator('#mention-die').click();
    await transcriptLinks.getByLabel('Transcript Link entity to die', { exact: true }).selectOption('cellcept');
    await expect.poll(async () => (await read()).mentions[0].targets?.length).toBe(2);
    await page.screenshot({ path: 'test-results/multiple-mention-targets.png', fullPage: true });
    await page.getByRole('button', { name: 'Delete Cellcept', exact: true }).click();
    await expect.poll(async () => (await read()).entities.length).toBe(1);
    expect((await read()).mentions[0].target).toEqual({ kind: 'attribute', entityId: 'prednison', attributeId: 'Prednison-action' });
    await page.reload();
    expect((await read()).mentions).toHaveLength(1);
    await page.getByRole('button', { name: 'Delete Prednison', exact: true }).click();
    await expect.poll(async () => (await read()).entities.length).toBe(0);
    expect((await read()).mentions).toHaveLength(1);
    expect((await read()).mentions[0].target).toBeNull();
    await page.locator('#mention-die').click();
    await expect(transcriptLinks).toContainText('This mention is unlinked');
    expect(errors).toEqual([]);
  } finally { await request.delete('/api/conversations/' + id); }
});
