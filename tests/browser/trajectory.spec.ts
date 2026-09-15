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

let fixtureId: string | undefined;
test.afterEach(async ({ request }) => {
  if (fixtureId) {
    await request.delete('/api/conversations/' + fixtureId);
    await request.delete('/api/groups/' + fixtureId + '-group');
    fixtureId = undefined;
  }
});

test('trajectory direction, comparison time and direct attribute evidence survive editing, reload and export', async ({ page, request }) => {
  const id = 'trajectory-browser-' + Date.now();
  fixtureId = id;
  const groupId = id + '-group';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const text = 'Headache is worse than a week ago.';
  const read = async () => (await request.get('/api/conversations/' + id)).json();
  const trajectory = async () => (await read()).annotation.entities[0].attributes.find((a: any) => a.name === 'trajectory');
  const absolute = (date: string) => ({ type: 'temporal', kind: 'absolute', date, precision: 'day', qualifier: 'exact' });
  expect((await request.put('/api/groups/' + groupId, { data: {
    name: 'Trajectory FHIR test', createdAt: '2026-09-11T00:00:00Z',
    settings: { annotationSchema: FHIR_ANNOTATION_SCHEMA.filter(c => c.id === 'fhir_symptoms') }
  } })).status()).toBe(201);
    expect((await request.put('/api/conversations/' + id, { data: {
      title: 'Trajectory annotation test', groupId, createdAt: '2040-01-01T00:00:00Z', status: 'annotated',
      encounterTime: absolute('2026-09-11'), rawTranscript: 'Patient: ' + text,
      transcriptSegments: [{ id: 'seg1', speaker: 'Patient', text }],
      annotation: { evidenceVersion: 2, entities: [{ id: 'symptom', name: 'Headache', type: 'Symptom', categoryId: 'fhir_symptoms',
        attributes: [{ id: 'symptom-name', name: 'name', value: 'Headache' }, { id: 'symptom-onset', name: 'onset', value: absolute('2026-09-01') }] }],
      mentions: [], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
    } })).status()).toBe(201);
    const trajectoryId = (await trajectory()).id;
    expect((await trajectory()).value).toBeNull();
    await page.goto('/?session=' + id);
    await expect(page.getByRole('heading', { name: 'Trajectory annotation test', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
    await expect(page.getByLabel('Trajectory direction', { exact: true })).toHaveValue('unassigned');
    await expect(page.getByLabel('Trajectory comparison time format', { exact: true })).toHaveValue('');
    await page.getByLabel('Trajectory direction', { exact: true }).selectOption('worsened');
    await page.getByLabel('Trajectory comparison time format', { exact: true }).selectOption('absolute');
    await page.getByLabel('Trajectory comparison time date', { exact: true }).fill('2026-02-30');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Trajectory comparison time format', { exact: true }).selectOption('relative');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Trajectory comparison time offset', { exact: true }).fill('-1');
    await page.getByLabel('Trajectory comparison time unit', { exact: true }).selectOption('wk');
    await page.getByLabel('Trajectory comparison time precision', { exact: true }).selectOption('week');
    await page.getByLabel('Trajectory source text', { exact: true }).fill('worse than a week ago');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await trajectory()).value?.direction).toBe('worsened');
    expect((await trajectory()).value.comparedTo.offset).toEqual({ value: -1, unit: 'wk' });

    await selectPhrase(page, 'worse than a week ago');
    await page.getByLabel('Annotation schema category', { exact: true }).selectOption('fhir_symptoms');
    await page.getByLabel('Evidence entity', { exact: true }).selectOption('symptom');
    await page.getByLabel('Evidence supports', { exact: true }).selectOption('attribute');
    await page.getByLabel('Evidence attribute', { exact: true }).selectOption(trajectoryId);
    await page.getByRole('button', { name: 'Link Evidence', exact: true }).click();
    await expect.poll(async () => (await read()).annotation.mentions.length).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Trajectory annotation test', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
    const graph = page.getByRole('region', { name: 'Evidence graph' });
    await expect(graph.getByText('Comparison time (derived): 2026-09-04 (week precision)', { exact: true })).toBeVisible();
    const attributeNode = graph.locator('[data-node-kind="attribute"]').filter({ hasText: 'trajectory =' });
    await expect(attributeNode.getByRole('button', { name: '“worse than a week ago”', exact: true })).toBeVisible();
    await expect(attributeNode).toContainText('Worsened compared with 1 week before encounter');
    await graph.screenshot({ path: 'test-results/trajectory-evidence-graph.png' });

    await page.getByTitle('Export annotated dataset (JSONL)').click();
    await page.getByRole('button', { name: /Full Session Record/ }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
    const exported = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
    const exportedTrajectory = exported.entities[0].attributes.find((a: any) => a.name === 'trajectory');
    expect(exported.trajectoryVersion).toBe(1);
    expect(exportedTrajectory.id).toBe(trajectoryId);
    expect(exportedTrajectory.resolvedComparisonTime.date).toBe('2026-09-04');
    expect(exported.mentions[0].target).toEqual({ kind: 'attribute', entityId: 'symptom', attributeId: trajectoryId });
    expect(exported.entities[0].textSpan).toBeUndefined();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // Edit through the notes panel without losing source evidence or confusing onset with comparison time.
    await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
    await page.getByLabel('Trajectory direction', { exact: true }).selectOption('unchanged');
    await page.getByLabel('Trajectory comparison time offset', { exact: true }).fill('0');
    await page.getByLabel('Trajectory comparison time unit', { exact: true }).selectOption('d');
    await page.getByLabel('Trajectory comparison time precision', { exact: true }).selectOption('day');
    await page.getByLabel('Trajectory comparison time anchor', { exact: true }).selectOption('symptom-onset');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await trajectory()).value?.direction).toBe('unchanged');
    expect((await trajectory()).value.comparedTo.anchor).toEqual({ kind: 'attribute', entityId: 'symptom', attributeId: 'symptom-onset' });

    await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
    await page.getByLabel('Trajectory direction', { exact: true }).selectOption('improved');
    await page.getByLabel('Trajectory comparison time format', { exact: true }).selectOption('text');
    await page.getByLabel('Trajectory comparison time source text', { exact: true }).fill('the previous visit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await trajectory()).value?.direction).toBe('improved');
    expect((await trajectory()).value.comparedTo.kind).toBe('text');
    await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
    await page.getByLabel('Trajectory comparison time format', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await trajectory()).value?.comparedTo).toBeNull();
    expect((await trajectory()).value.direction).toBe('improved');
    await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
    await page.getByRole('button', { name: 'Clear trajectory', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await trajectory()).value).toBeNull();
    expect((await trajectory()).id).toBe(trajectoryId);
    expect((await read()).annotation.mentions[0].target.attributeId).toBe(trajectoryId);
    expect((await read()).annotation.entities[0].attributes.find((a: any) => a.name === 'onset').value.date).toBe('2026-09-01');
    expect(errors).toEqual([]);
});
