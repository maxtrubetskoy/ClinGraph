import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FHIR_ANNOTATION_SCHEMA } from '../../src/types';

async function selectPhrase(page: Page, text: string) {
  await page.locator('[data-segment-idx="0"] .select-text').evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + text.length);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
    }
    throw new Error('Missing phrase: ' + text);
  }, text);
}

test('FHIR timing fields, encounter anchor, source evidence and computed exports survive reload', async ({ page, request }) => {
  const id = 'time-browser-' + Date.now();
  const groupId = id + '-group';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const text = 'Headache began about a week ago and lasted 2 days. Blood pressure was measured 5 hours ago.';
  const read = async () => (await request.get('/api/conversations/' + id)).json();
  const timeValue = async (entityId: string, name: string) =>
    (await read()).annotation.entities.find((e: any) => e.id === entityId).attributes.find((a: any) => a.name === name).value;
  expect((await request.put('/api/groups/' + groupId, { data: {
    name: 'Temporal FHIR test', createdAt: '2026-09-11T00:00:00Z',
    settings: { annotationSchema: FHIR_ANNOTATION_SCHEMA.filter(c => ['fhir_symptoms', 'fhir_observations'].includes(c.id)) }
  } })).status()).toBe(201);
  try {
    expect((await request.put('/api/conversations/' + id, { data: {
      title: 'Temporal annotation test', groupId, createdAt: '2040-01-01T00:00:00Z', status: 'annotated',
      rawTranscript: 'Patient: ' + text, transcriptSegments: [{ id: 'seg1', speaker: 'Patient', text }],
      annotation: { evidenceVersion: 2, entities: [
        { id: 'symptom', name: 'Headache', type: 'Symptom', categoryId: 'fhir_symptoms',
          attributes: [{ id: 'symptom-name', name: 'name', value: 'Headache' }] },
        { id: 'measurement', name: 'Blood pressure', type: 'Observation', categoryId: 'fhir_observations',
          attributes: [{ id: 'measurement-name', name: 'name', value: 'Blood pressure' }, { id: 'measurement-value', name: 'value', value: '120/80' }] }
      ], mentions: [], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
    } })).status()).toBe(201);
    await page.goto('/?session=' + id);
    await expect(page.getByRole('heading', { name: 'Temporal annotation test', level: 2 })).toBeVisible();
    const editEncounter = async (date: string) => {
      await page.getByRole('button', { name: 'Edit encounter time', exact: true }).click();
      await page.getByLabel('Encounter time format', { exact: true }).selectOption('absolute');
      await page.getByLabel('Encounter time date', { exact: true }).fill(date);
      await page.getByRole('button', { name: 'Save encounter time', exact: true }).click();
      await expect.poll(async () => (await read()).encounterTime?.date).toBe(date);
    };
    await editEncounter('2026');
    expect((await read()).createdAt).toBe('2040-01-01T00:00:00Z');

    await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
    await page.getByLabel('Onset format', { exact: true }).selectOption('relative');
    await page.getByLabel('Onset offset', { exact: true }).fill('-1');
    await page.getByLabel('Onset unit', { exact: true }).selectOption('wk');
    await page.getByLabel('Onset precision', { exact: true }).selectOption('week');
    await page.getByLabel('Onset qualifier', { exact: true }).selectOption('approximate');
    await page.getByLabel('Onset source text', { exact: true }).fill('about a week ago');
    await expect(page.getByRole('group', { name: 'Onset timing', exact: true }).getByRole('status')).toContainText('Unresolved');
    await page.getByLabel('Duration format', { exact: true }).selectOption('duration');
    await page.getByLabel('Duration amount', { exact: true }).fill('-2');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Duration amount', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await timeValue('symptom', 'onset'))?.kind).toBe('relative');
    expect((await timeValue('symptom', 'duration')).amount.value).toBe(2);
    expect(await timeValue('symptom', 'resolutionTime')).toBeNull();

    await selectPhrase(page, 'about a week ago');
    await page.getByLabel('Annotation schema category', { exact: true }).selectOption('fhir_symptoms');
    await page.getByLabel('Evidence entity', { exact: true }).selectOption('symptom');
    await page.getByLabel('Evidence supports', { exact: true }).selectOption('attribute');
    const onsetId = (await read()).annotation.entities[0].attributes.find((a: any) => a.name === 'onset').id;
    await page.getByLabel('Evidence attribute', { exact: true }).selectOption(onsetId);
    await page.getByRole('button', { name: 'Link Evidence', exact: true }).click();
    await expect.poll(async () => (await read()).annotation.mentions.length).toBe(1);

    await page.getByRole('button', { name: 'Edit Blood pressure', exact: true }).click();
    await page.getByLabel('Effective Time format', { exact: true }).selectOption('relative');
    await page.getByLabel('Effective Time offset', { exact: true }).fill('-5');
    await page.getByLabel('Effective Time unit', { exact: true }).selectOption('h');
    await page.getByLabel('Effective Time precision', { exact: true }).selectOption('hour');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await timeValue('measurement', 'effectiveTime'))?.offset.value).toBe(-5);
    await editEncounter('2026-09-11T02:00:00+02:00');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Temporal annotation test', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
    const graph = page.getByRole('region', { name: 'Evidence graph' });
    await expect(graph.getByText('Derived: 2026-09-10T19:00:00Z (hour precision)', { exact: true })).toBeVisible();
    await expect(graph.getByRole('button', { name: '“about a week ago”', exact: true })).toBeVisible();
    await graph.screenshot({ path: 'test-results/temporal-evidence-graph.png' });

    await page.getByTitle('Export annotated dataset (JSONL)').click();
    await page.getByRole('button', { name: /Full Session Record/ }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
    const downloaded = await downloading;
    const exported = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
    expect(exported.encounterTime.date).toBe('2026-09-11T02:00:00+02:00');
    const exportedOnset = exported.entities[0].attributes.find((a: any) => a.name === 'onset');
    expect(exportedOnset.id).toBe(onsetId);
    expect(exportedOnset.value.offset).toEqual({ value: -1, unit: 'wk' });
    expect(exportedOnset.resolvedTime.qualifier).toBe('approximate');
    expect(exported.mentions[0].target.attributeId).toBe(onsetId);
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: 'Edit encounter time', exact: true }).click();
    await page.getByLabel('Encounter time format', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Save encounter time', exact: true }).click();
    await expect.poll(async () => (await read()).encounterTime).toBeNull();
    await expect(graph.getByText('Derived:', { exact: false })).toHaveCount(0);
    expect((await read()).annotation.mentions[0].target.attributeId).toBe(onsetId);
    expect(errors).toEqual([]);
  } finally {
    await request.delete('/api/conversations/' + id);
    await request.delete('/api/groups/' + groupId);
  }
});
