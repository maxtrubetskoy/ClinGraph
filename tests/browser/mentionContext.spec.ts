import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

let fixtureId: string | undefined;
test.afterEach(async ({ request }) => {
  if (!fixtureId) return;
  await request.delete('/api/conversations/' + fixtureId);
  await request.delete('/api/groups/' + fixtureId + '-group');
  fixtureId = undefined;
});

async function selectText(page: Page, text: string) {
  await page.locator('[data-segment-idx="0"] .select-text').evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + text.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error('Missing synthetic source span');
  }, text);
}

test('references and claims can be created, scoped, reviewed, reloaded and exported without invented assertions', async ({ page, request }) => {
  const id = fixtureId = 'mention-context-browser-' + Date.now();
  const groupId = id + '-group';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  expect((await request.put('/api/groups/' + groupId, { data: {
    name: 'Mention context test', createdAt: '2026-09-11T00:00:00Z', settings: { annotationSchema: [
      { id: 'fhir_observations', entityType: 'Observation', displayName: 'Measurements', attributes: [
        { name: 'name', type: 'text' }, { name: 'interpretation', type: 'select', choices: ['unassigned', 'Low', 'Normal', 'High'] }
      ] }
    ] }
  } })).status()).toBe(201);
  const text = 'Your kidney function may be reduced. Renal function.';
  expect((await request.put('/api/conversations/' + id, { data: {
    title: 'Mention context regression', groupId, status: 'annotated', createdAt: '2026-09-11T00:00:00Z',
    rawTranscript: 'Clinician: ' + text, transcriptSegments: [{ id: 'seg1', speaker: 'Clinician', text }],
    annotation: { evidenceVersion: 2, entities: [{ id: 'e1', categoryId: 'fhir_observations', type: 'Observation', name: 'Kidney function', attributes: [
      { id: 'name-1', name: 'name', value: 'Kidney function' }, { id: 'interpretation-1', name: 'interpretation', value: 'Low' }
    ] }], mentions: [{ id: 'legacy', entityId: 'e1', entityType: 'Observation', certainty: 'certain', function: 'asserted', experiencer: 'patient',
      target: { kind: 'entity', entityId: 'e1' }, textSpan: { lineIndex: 0, startChar: text.indexOf('Renal function'), endChar: text.indexOf('Renal function') + 'Renal function'.length, text: 'Renal function' } }],
    relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  } })).status()).toBe(201);
  const read = async () => (await (await request.get('/api/conversations/' + id)).json()).annotation;
  const find = async (text: string) => (await read()).mentions.find((m: any) => m.textSpan.text === text);
  await page.goto('/?session=' + id);
  await expect(page.getByRole('heading', { name: 'Mention context regression', level: 2 })).toBeVisible();
  await page.locator('#mention-legacy').click();
  const summary = page.getByTestId('entity-claim-summary-e1');
  await expect(summary).toContainText('No asserted patient-specific entity claims');
  await expect(summary).toContainText('1 role unassigned');
  expect((await find('Renal function')).certainty).toBe('certain');

  await selectText(page, 'kidney function');
  await page.getByLabel('Evidence entity', { exact: true }).selectOption('e1');
  await page.getByLabel('New mention evidence role', { exact: true }).selectOption('reference');
  await page.getByRole('button', { name: 'Link Evidence', exact: true }).click();
  await expect.poll(async () => (await find('kidney function'))?.evidenceRole).toBe('reference');
  const name = await find('kidney function');
  const role = page.getByLabel('Evidence role for kidney function', { exact: true });
  const certainty = page.getByLabel('Claim certainty for kidney function', { exact: true });
  const speech = page.getByLabel('Speech function for kidney function', { exact: true });
  const temporality = page.getByLabel('Temporality for kidney function', { exact: true });
  const polarity = page.getByLabel('Polarity for kidney function', { exact: true });
  await expect(temporality).toHaveValue('not_applicable');
  await expect(polarity).toHaveValue('neutral');
  await expect(certainty).toHaveValue('not_applicable');
  await expect(certainty).toBeDisabled();
  await expect(speech).toHaveValue('not_applicable');
  await role.selectOption('claim');
  await expect(certainty).toBeEnabled();
  await expect(certainty).toHaveValue('unassigned');
  await expect(speech).toHaveValue('unassigned');
  await expect(temporality).toHaveValue('unassigned');
  await expect(polarity).toHaveValue('unassigned');
  // Not applicable and not yet annotated are distinct, persisted choices.
  await temporality.selectOption('not_applicable');
  await expect.poll(async () => (await find('kidney function')).temporality).toBe('not_applicable');
  await temporality.selectOption('unassigned');
  await expect.poll(async () => (await find('kidney function')).temporality).toBe('unassigned');
  await role.selectOption('reference');
  await expect(temporality).toHaveValue('not_applicable');
  await expect(polarity).toHaveValue('neutral');
  // These are defaults, not coercions of an explicit later choice.
  await polarity.selectOption('unassigned');
  await expect.poll(async () => (await find('kidney function')).polarity).toBe('unassigned');
  await polarity.selectOption('neutral');
  await speech.selectOption('questioned');
  await expect.poll(async () => (await find('kidney function')).function).toBe('questioned');
  expect((await find('kidney function')).temporality).toBe('not_applicable');

  await selectText(page, 'may be reduced');
  await page.getByLabel('Evidence entity', { exact: true }).selectOption('e1');
  await expect(page.getByLabel('New mention evidence role', { exact: true })).toHaveValue('unassigned');
  await page.getByLabel('New mention evidence role', { exact: true }).selectOption('claim');
  await page.getByRole('button', { name: 'Link Evidence', exact: true }).click();
  await expect.poll(async () => (await find('may be reduced'))?.evidenceRole).toBe('claim');
  await page.getByLabel('Claim certainty for may be reduced', { exact: true }).selectOption('uncertain');
  await page.getByLabel('Speech function for may be reduced', { exact: true }).selectOption('asserted');
  await page.getByLabel('Experiencer for may be reduced', { exact: true }).selectOption('patient');
  await page.getByLabel('Temporality for may be reduced', { exact: true }).selectOption('current');
  await expect(summary).toContainText('1 asserted patient claims');
  await page.getByRole('button', { name: 'Apply context to the same target and role', exact: true }).click();
  await expect.poll(async () => (await find('may be reduced')).certainty).toBe('uncertain');
  expect((await find('kidney function')).certainty).toBe('not_applicable');
  expect((await find('kidney function')).function).toBe('questioned');
  expect((await find('kidney function')).polarity).toBe('neutral');
  expect((await find('kidney function')).temporality).toBe('not_applicable');
  expect((await find('Renal function')).certainty).toBe('certain');
  expect((await find('Renal function')).evidenceRole).toBe('unassigned');

  await page.getByLabel('Evidence target for may be reduced', { exact: true }).selectOption('interpretation-1');
  await expect.poll(async () => (await find('may be reduced')).target.kind).toBe('attribute');
  await expect(summary).toContainText('No asserted patient-specific entity claims');
  const saved = await read();
  const claim = saved.mentions.find((m: any) => m.textSpan.text === 'may be reduced');
  expect(claim.certainty).toBe('uncertain');
  expect(claim.evidenceRole).toBe('claim');
  expect(claim.temporality).toBe('current');
  const invalid = structuredClone(saved);
  invalid.mentions.find((m: any) => m.id === name.id).certainty = 'certain';
  expect((await request.patch('/api/conversations/' + id, { data: { annotation: invalid } })).status()).toBe(400);
  expect(await read()).toEqual(saved);

  await page.reload();
  await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Evidence graph' });
  const refNode = graph.locator('[data-node-kind="mention"]').filter({ hasText: '“kidney function”' });
  await expect(refNode).toContainText('Name / reference · Certainty: Not applicable · Function: questioned');
  await expect(refNode).toContainText('Temporality: Not applicable · Polarity: neutral');
  const claimNode = graph.locator('[data-node-kind="attribute"]').filter({ hasText: 'interpretation =' });
  await expect(claimNode).toContainText('Claim evidence · Certainty: uncertain · Function: asserted');
  await page.screenshot({ path: 'test-results/mention-context-graph.png', fullPage: true });

  await page.getByTitle('Export annotated dataset (JSONL)').click();
  await page.getByRole('button', { name: /Full Session Record/ }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  expect(exported.mentionContextVersion).toBe(1);
  expect(exported.mentions).toEqual(saved.mentions);
  expect(exported.evidenceGraph.nodes.find((n: any) => n.mentionId === name.id).evidenceRole).toBe('reference');
  expect(exported.evidenceGraph.nodes.find((n: any) => n.mentionId === name.id).temporality).toBe('not_applicable');
  expect(exported.evidenceGraph.nodes.find((n: any) => n.mentionId === name.id).polarity).toBe('neutral');
  expect(errors).toEqual([]);
});
