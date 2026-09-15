import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FHIR_ANNOTATION_SCHEMA } from '../../src/types';

let fixtureId: string | undefined;
test.afterEach(async ({ request }) => {
  if (!fixtureId) return;
  await request.delete('/api/conversations/' + fixtureId);
  await request.delete('/api/groups/' + fixtureId + '-group');
  fixtureId = undefined;
});

test('measurement links survive edit, rename, reload, graph and export; deleting a procedure retains evidence', async ({ page, request }) => {
  const id = fixtureId = 'procedure-browser-' + Date.now();
  const groupId = id + '-group';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const read = async () => (await request.get('/api/conversations/' + id)).json();
  const partOf = async () => (await read()).annotation.entities.find((entity: any) => entity.id === 'volume').attributes.find((attribute: any) => attribute.name === 'partOf');
  expect((await request.put('/api/groups/' + groupId, { data: {
    name: 'Procedure link test', createdAt: '2026-09-14', settings: {
      annotationSchema: FHIR_ANNOTATION_SCHEMA.filter(category => ['fhir_observations', 'fhir_procedures', 'fhir_conditions'].includes(category.id))
    }
  } })).status()).toBe(201);
  const procedure = (id: string, performed: string) => ({ id, name: 'Ultrasound', type: 'fhir_procedures', categoryId: 'fhir_procedures', attributes: [
    { id: id + '-name', name: 'name', value: 'Ultrasound' }, { id: id + '-time', name: 'performed', value: performed }
  ] });
  expect((await request.put('/api/conversations/' + id, { data: {
    title: 'Kidney volume procedure test', groupId, createdAt: '2040-01-01T00:00:00Z', status: 'annotated',
    rawTranscript: 'Clinician: On the ultrasound, total kidney volume was about 2300 mL.',
    transcriptSegments: [{ id: 'seg1', speaker: 'Clinician', text: 'On the ultrasound, total kidney volume was about 2300 mL.' }],
    annotation: { evidenceVersion: 2, entities: [
      { id: 'volume', name: 'Total kidney volume', type: 'Observation', categoryId: 'fhir_observations', attributes: [
        { id: 'volume-name', name: 'name', value: 'Total kidney volume' },
        { id: 'volume-value', name: 'value', value: 'about 2300 mL' },
        { id: 'volume-procedure', name: 'partOf', value: null }
      ] }, procedure('scan', 'about two months ago'), procedure('scan2', 'last year'),
      { id: 'condition', name: 'ADPKD', type: 'Condition', categoryId: 'fhir_conditions', attributes: [{ id: 'condition-name', name: 'name', value: 'ADPKD' }] }
    ], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] },
    mentions: [{ id: 'link-evidence', entityId: 'volume', entityType: 'Observation', evidenceRole: 'claim', certainty: 'uncertain', function: 'asserted',
      target: { kind: 'attribute', entityId: 'volume', attributeId: 'volume-procedure' },
      textSpan: { lineIndex: 0, segmentId: 'seg1', startChar: 0, endChar: 17, text: 'On the ultrasound' } }]
    }
  } })).status()).toBe(201);
  await page.goto('/?session=' + id);
  await expect(page.getByRole('heading', { name: 'Kidney volume procedure test', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Total kidney volume', exact: true }).click();
  const picker = page.getByLabel('Part of procedure', { exact: true });
  await expect(picker.locator('option')).toHaveCount(3);
  await expect(picker).toContainText('Ultrasound · about two months ago (scan)');
  await expect(picker).not.toContainText('ADPKD');
  await picker.selectOption('scan');
  await picker.selectOption('scan2');
  await expect(picker).toBeDisabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await partOf()).value?.procedureIds).toEqual(['scan', 'scan2']);
  const before = await read();
  expect(before.annotation.entities[0].attributes.find((attribute: any) => attribute.name === 'effectiveTime').value).toBeNull();
  await page.reload();
  await page.getByRole('button', { name: 'Edit Ultrasound', exact: true }).first().click();
  await page.getByPlaceholder('Procedure or therapy name (e.g., Appendectomy, Chest X-ray)').fill('Renal ultrasound');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await read()).annotation.entities.find((entity: any) => entity.id === 'scan').name).toBe('Renal ultrasound');
  expect((await partOf()).value.procedureIds).toEqual(['scan', 'scan2']);
  await page.getByRole('button', { name: 'Edit Total kidney volume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlink Renal ultrasound', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Unlink Ultrasound', exact: true }).click();
  await page.locator('form').filter({ has: picker }).screenshot({ path: 'test-results/procedure-reference-editor.png' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await partOf()).value.procedureIds).toEqual(['scan']);
  await page.getByRole('button', { name: 'Entity Relations', exact: true }).click();
  await expect(page.locator('svg text').filter({ hasText: /^PART_OF$/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Evidence graph' });
  await expect(graph.locator('[data-node-kind="entity"]')).toHaveCount(4);
  const attribute = graph.locator('[data-node-kind="attribute"]').filter({ hasText: 'partOf =' });
  await expect(attribute).toContainText('partOf = Renal ultrasound');
  await expect(attribute.getByRole('button', { name: '“On the ultrasound”', exact: true })).toBeVisible();
  await attribute.getByRole('button', { name: 'Open procedure: Renal ultrasound', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dialogue', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTitle('Export annotated dataset (JSONL)').click();
  await page.getByRole('button', { name: /Full Session Record/ }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  expect(exported.entities[0].attributes.find((attribute: any) => attribute.name === 'partOf').value.procedureIds).toEqual(['scan']);
  expect(exported.evidenceGraph.edges.filter((edge: any) => edge.type === 'PART_OF')).toEqual([
    { source: id + ':entity:volume', target: id + ':entity:scan', type: 'PART_OF', attributeId: 'volume-procedure' }
  ]);
  expect(exported.mentions[0].certainty).toBe('uncertain');
  await page.getByRole('button', { name: 'Close export', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Renal ultrasound', exact: true }).click();
  await expect.poll(async () => (await partOf()).value).toBeNull();
  expect((await partOf()).id).toBe('volume-procedure');
  const after = await read();
  expect(after.annotation.mentions).toEqual(before.annotation.mentions);
  expect(after.annotation.entities[0].attributes.find((attribute: any) => attribute.name === 'value').value).toBe('about 2300 mL');
  // Invalid external updates must be rejected, rather than silently discarding broken references.
  const invalid = structuredClone(after.annotation);
  invalid.entities[0].attributes.find((attribute: any) => attribute.name === 'partOf').value = { type: 'procedure-reference', procedureIds: ['condition'] };
  expect((await request.patch('/api/conversations/' + id, { data: { annotation: invalid } })).status()).toBe(400);
  expect((await partOf()).value).toBeNull();
  expect(errors).toEqual([]);
});
