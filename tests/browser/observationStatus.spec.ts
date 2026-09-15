import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

let fixtureId: string | undefined;
test.afterEach(async ({ request }) => {
  if (!fixtureId) return;
  await request.delete('/api/conversations/' + fixtureId);
  await request.delete('/api/groups/' + fixtureId + '-group');
  fixtureId = undefined;
});

test('legacy refuted workflow migrates visibly; independent assessment/status edits and evidence survive reload/export', async ({ page, request }) => {
  const id = fixtureId = 'status-browser-' + Date.now();
  const groupId = id + '-group';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  expect((await request.put('/api/groups/' + groupId, { data: {
    name: 'Legacy status test', createdAt: '2026-09-11T00:00:00Z', settings: { annotationSchema: [
      { id: 'fhir_symptoms', entityType: 'Symptom', displayName: 'FHIR Observation (Symptom)', attributes: [
        { name: 'name', type: 'text' }, { name: 'status', type: 'select', choices: ['registered', 'final', 'refuted'], hint: 'Old mixed status field' }
      ] }
    ] }
  } })).status()).toBe(201);
  const text = 'No grounds to suspect a headache.';
  expect((await request.put('/api/conversations/' + id, { data: {
    title: 'Observation status regression', groupId, status: 'annotated', createdAt: '2026-01-01T00:00:00Z',
    rawTranscript: 'Clinician: ' + text, transcriptSegments: [{ id: 'seg1', speaker: 'Clinician', text }],
    annotation: { evidenceVersion: 2, entities: [{ id: 'e1', categoryId: 'fhir_symptoms', type: 'Symptom', name: 'Headache', attributes: [
      { id: 'name-1', name: 'name', value: 'Headache' }, { id: 'old-status-1', name: 'status', value: 'refuted' }
    ] }], mentions: [{ id: 'm1', entityId: 'e1', entityType: 'Symptom', speaker: 'Clinician', certainty: 'uncertain', polarity: 'negative',
      target: { kind: 'attribute', entityId: 'e1', attributeId: 'old-status-1' },
      textSpan: { lineIndex: 0, segmentId: 'seg1', startChar: 0, endChar: 20, text: 'No grounds to suspect' } }],
    relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  } })).status()).toBe(201);
  const read = async () => (await request.get('/api/conversations/' + id)).json();
  const attribute = async (name: string) => (await read()).annotation.entities[0].attributes.find((a: any) => a.name === name);
  expect((await attribute('diagnosticAssessment')).id).toBe('old-status-1');
  expect((await attribute('status')).value).toBe('unassigned');

  await page.goto('/?session=' + id);
  await expect(page.getByRole('heading', { name: 'Observation status regression', level: 2 })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('Review legacy status');
  await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
  const workflow = page.getByLabel('Result status', { exact: true });
  const assessment = page.getByLabel('Diagnostic assessment', { exact: true });
  await expect(workflow).toHaveValue('unassigned');
  await expect(workflow.locator('option[value="refuted"]')).toHaveCount(0);
  await expect(assessment).toHaveValue('legacy_refuted');
  await assessment.selectOption('not_suspected');
  await workflow.selectOption('final');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await attribute('diagnosticAssessment')).value).toBe('not_suspected');
  expect((await attribute('status')).value).toBe('final');
  await expect(page.getByRole('note')).toHaveCount(0);
  const saved = await read();
  expect(saved.annotation.mentions[0].target.attributeId).toBe('old-status-1');
  expect(saved.annotation.mentions[0].certainty).toBe('uncertain');
  expect((await attribute('diagnosticAssessment')).migration.originalValue).toBe('refuted');

  // New invalid workflow writes fail without changing a valid assessment/result pair.
  const invalid = structuredClone(saved.annotation);
  invalid.entities[0].attributes.find((a: any) => a.name === 'status').value = 'refuted';
  expect((await request.patch('/api/conversations/' + id, { data: { annotation: invalid } })).status()).toBe(400);
  expect((await read()).annotation).toEqual(saved.annotation);
  await page.reload();
  await page.getByRole('button', { name: 'Edit Headache', exact: true }).click();
  await expect(workflow).toHaveValue('final');
  await expect(assessment).toHaveValue('not_suspected');
  await workflow.selectOption('preliminary');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await attribute('status')).value).toBe('preliminary');
  expect((await attribute('diagnosticAssessment')).value).toBe('not_suspected');

  await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Evidence graph' });
  const assessmentNode = graph.locator('[data-node-kind="attribute"]').filter({ hasText: 'diagnosticAssessment =' });
  await expect(assessmentNode).toContainText('not_suspected');
  await expect(assessmentNode.getByRole('button', { name: '“No grounds to suspect”', exact: true })).toBeVisible();
  const workflowNode = graph.locator('[data-node-kind="attribute"]').filter({ hasText: 'status =' });
  await expect(workflowNode).toContainText('preliminary');
  await expect(workflowNode.getByRole('button')).toHaveCount(0);

  await page.getByTitle('Export annotated dataset (JSONL)').click();
  await page.getByRole('button', { name: /Full Session Record/ }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  expect(exported.observationStatusVersion).toBe(1);
  expect(exported.entities[0].attributes.find((a: any) => a.id === 'old-status-1').name).toBe('diagnosticAssessment');
  expect(exported.mentions[0].target.attributeId).toBe('old-status-1');
  expect(errors).toEqual([]);
});

test('preserved legacy fields can be mapped or retained explicitly and warnings stay resolved after reload/export', async ({ page, request }) => {
  const id = fixtureId = 'preserved-status-browser-' + Date.now();
  const groupId = id + '-group';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  expect((await request.put('/api/groups/' + groupId, { data: {
    name: 'Preserved legacy review', createdAt: '2026-09-11T00:00:00Z', settings: { annotationSchema: [
      { id: 'fhir_symptoms', entityType: 'Symptom', displayName: 'Symptoms', attributes: [
        { name: 'name', type: 'text' }, { name: 'status', type: 'select', choices: ['final', 'refuted'] }
      ] }
    ] }
  } })).status()).toBe(201);
  const text = 'No. Previously denied.';
  expect((await request.put('/api/conversations/' + id, { data: {
    title: 'Preserved legacy review regression', groupId, status: 'annotated', createdAt: '2026-09-11T00:00:00Z',
    rawTranscript: 'Patient: ' + text, transcriptSegments: [{ id: 'seg1', speaker: 'Patient', text }],
    annotation: { evidenceVersion: 2, entities: [{ id: 'e1', categoryId: 'fhir_symptoms', type: 'Symptom', name: 'Headache', attributes: [
      { id: 'name', name: 'name', value: 'Headache' }, { id: 'old-status', name: 'status', value: 'refuted' },
      { id: 'assessment', name: 'diagnosticAssessment', value: 'not_suspected' },
      { id: 'historical', name: 'legacyStatus', value: 'refuted', migration: { kind: 'observation-status', originalName: 'status', originalValue: 'refuted' } }
    ] }], mentions: [{ id: 'm1', entityId: 'e1', entityType: 'Symptom', evidenceRole: 'claim', polarity: 'negative', certainty: 'certain',
      function: 'asserted', speaker: 'Patient', target: { kind: 'attribute', entityId: 'e1', attributeId: 'old-status' },
      textSpan: { lineIndex: 0, startChar: 0, endChar: 2, text: 'No' } },
    { id: 'm2', entityId: 'e1', entityType: 'Symptom', target: { kind: 'attribute', entityId: 'e1', attributeId: 'historical' },
      textSpan: { lineIndex: 0, startChar: 4, endChar: 21, text: 'Previously denied' } }],
    relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  } })).status()).toBe(201);
  const read = async () => (await (await request.get('/api/conversations/' + id)).json()).annotation;
  const initial = await read();
  const field = (annotation: any, id: string) => annotation.entities[0].attributes.find((a: any) => a.id === id);
  expect(field(initial, 'old-status').name).toBe('legacyStatus1');
  await page.goto('/?session=' + id);
  await expect(page.getByRole('heading', { name: 'Preserved legacy review regression', level: 2 })).toBeVisible();
  const currentReview = page.getByTestId('legacy-status-review-old-status');
  const historicalReview = page.getByTestId('legacy-status-review-historical');
  await expect(currentReview).toBeVisible();
  await expect(historicalReview).toBeVisible();
  await expect(currentReview.getByRole('button', { name: 'Resolve legacy status' })).toBeDisabled();

  // Graph warnings provide a path back to the actual review controls.
  await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Evidence graph' });
  await graph.locator('[data-node-kind="attribute"]').filter({ hasText: 'legacyStatus1 =' })
    .getByRole('button', { name: 'Review in clinical notes', exact: true }).click();
  await currentReview.getByLabel('Legacy review action for legacyStatus1', { exact: true }).selectOption('assessment:absent');
  await expect(currentReview).toContainText('move 1 evidence link(s)');
  await expect(currentReview).toContainText('not_suspected');
  await currentReview.getByRole('button', { name: 'Resolve legacy status', exact: true }).click();
  await expect.poll(async () => field(await read(), 'assessment').value).toBe('absent');
  await expect(currentReview).toHaveCount(0);
  await expect(historicalReview).toBeVisible();
  const mapped = await read();
  expect(mapped.mentions[0]).toEqual({ ...initial.mentions[0], target: { kind: 'attribute', entityId: 'e1', attributeId: 'assessment' } });
  expect(mapped.mentions[1]).toEqual(initial.mentions[1]);
  expect(field(mapped, 'old-status').value).toBe('refuted');
  expect(field(mapped, 'old-status').migration.review.previousAssessmentValue).toBe('not_suspected');
  expect(mapped.entities[0].attributes.find((a: any) => a.name === 'status').value).toBe('unassigned');

  await historicalReview.getByLabel('Legacy review action for legacyStatus', { exact: true }).selectOption('keep-context');
  await historicalReview.getByRole('button', { name: 'Resolve legacy status', exact: true }).click();
  await expect(historicalReview).toHaveCount(0);
  const saved = await read();
  expect(saved.mentions).toEqual(mapped.mentions);
  expect(field(saved, 'assessment').value).toBe('absent');
  expect(field(saved, 'historical').migration.review.decision).toBe('retained-as-context');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Preserved legacy review regression', level: 2 })).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
  await page.getByRole('button', { name: 'Evidence Graph', exact: true }).click();
  await expect(graph.getByRole('button', { name: 'Review in clinical notes' })).toHaveCount(0);
  await expect(graph.getByText('Legacy value reviewed; original value retained in migration history.', { exact: true })).toHaveCount(2);
  await expect(graph.locator('[data-node-kind="attribute"]').filter({ hasText: 'diagnosticAssessment =' }).getByRole('button', { name: '“No”', exact: true })).toBeVisible();

  await page.getByTitle('Export annotated dataset (JSONL)').click();
  await page.getByRole('button', { name: /Full Session Record/ }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .jsonl', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  expect(field(exported, 'old-status').migration.originalValue).toBe('refuted');
  expect(field(exported, 'old-status').migration.review.movedMentionIds).toEqual(['m1']);
  expect(exported.mentions).toEqual(saved.mentions);
  expect(errors).toEqual([]);
});
