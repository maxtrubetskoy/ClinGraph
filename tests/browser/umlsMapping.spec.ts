import { expect, test } from '@playwright/test';
import { DEFAULT_ANNOTATION_SCHEMA, FHIR_ANNOTATION_SCHEMA } from '../../src/types';

let sessionId: string;
let groupId: string | undefined;

test.beforeEach(() => {
  sessionId = 'umls-mapping-' + Date.now();
  groupId = undefined;
});

test.afterEach(async ({ request }) => {
  await request.delete('/api/conversations/' + sessionId);
  if (groupId) await request.delete('/api/groups/' + groupId);
});

function session(entities: unknown[]) {
  return {
    title: 'UMLS regression', createdAt: new Date().toISOString(), status: 'annotated', groupId,
    rawTranscript: 'Patient: Headache.', transcriptSegments: [{ id: 's0', speaker: 'Patient', text: 'Headache.' }],
    annotation: { entities, mentions: [], relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] } }
  };
}

test('auto-mapping handles schema IDs, legacy types and custom categories, preserving existing mappings', async ({ page, request }) => {
  groupId = sessionId + '-group';
  await request.put('/api/groups/' + groupId, { data: {
    name: 'UMLS schema coverage', createdAt: new Date().toISOString(), settings: {
      annotationSchema: [...DEFAULT_ANNOTATION_SCHEMA, ...FHIR_ANNOTATION_SCHEMA,
        { id: 'custom_lab', entityType: 'LabFinding', displayName: 'Custom labs', attributes: [{ name: 'name', type: 'text' }] }]
    }
  } });
  await request.put('/api/conversations/' + sessionId, { data: session([
    { id: 'symptom', name: 'Headache', type: 'symptoms', categoryId: 'symptoms' },
    { id: 'condition', name: 'Hypertension', type: 'fhir_conditions' },
    { id: 'procedure', name: 'Electrocardiography', type: 'Procedure' },
    { id: 'custom', name: 'Creatinine', type: 'LabFinding', categoryId: 'custom_lab' },
    { id: 'legacy', name: 'Nausea', type: ' symptom ' },
    { id: 'mapped', name: 'Aspirin', type: 'medications', umlsMapping: { cui: 'C0004057', preferredName: 'Aspirin', rxnorm: '1191' } },
    { id: 'speaker', name: 'Patient', type: 'Patient' }
  ]) });
  const names: string[] = [];
  await page.route('**/api/umls/map', async route => {
    const { name } = route.request().postDataJSON();
    names.push(name);
    await route.fulfill({ json: { success: true, data: { cui: 'C0000001', preferredName: name, loinc: '2160-0' } } });
  });
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('/?session=' + sessionId);
  await page.getByRole('button', { name: 'Auto-Map All', exact: true }).click();
  const read = async () => (await (await request.get('/api/conversations/' + sessionId)).json()).annotation.entities;
  await expect.poll(async () => (await read()).filter((entity: any) => entity.umlsMapping?.cui).length).toBe(6);
  expect(names).toEqual(['Headache', 'Hypertension', 'Electrocardiography', 'Creatinine', 'Nausea']);
  expect(dialogs).toEqual([]);
  const saved = await read();
  expect(saved.find((entity: any) => entity.id === 'custom').umlsMapping.loinc).toBe('2160-0');
  expect(saved.find((entity: any) => entity.id === 'mapped').umlsMapping).toEqual({ cui: 'C0004057', preferredName: 'Aspirin', rxnorm: '1191' });
  expect(saved.find((entity: any) => entity.id === 'speaker').umlsMapping).toBeUndefined();
  await page.reload();
  await page.getByRole('button', { name: 'Auto-Map All', exact: true }).click();
  await expect.poll(() => dialogs).toEqual(['All clinical entities are already mapped.']);
  expect(names).toHaveLength(5);
});

test('bulk mapping displays and persists API configuration errors and allows a successful retry', async ({ page, request }) => {
  await request.put('/api/conversations/' + sessionId, { data: session([
    { id: 'symptom', name: 'Headache', type: 'Symptom' }
  ]) });
  await page.goto('/?session=' + sessionId);
  await page.getByRole('button', { name: 'Auto-Map All', exact: true }).click();
  await expect(page.getByText(/UMLS_API_KEY environment variable is not configured/)).toBeVisible();
  const read = async () => (await (await request.get('/api/conversations/' + sessionId)).json()).annotation.entities[0];
  await expect.poll(async () => (await read()).umlsMapping?.error).toContain('UMLS_API_KEY');
  await page.reload();
  await expect(page.getByText(/UMLS_API_KEY environment variable is not configured/)).toBeVisible();
  await page.route('**/api/umls/map', route => route.fulfill({ json: {
    success: true, data: { cui: 'C0018681', preferredName: 'Headache', loinc: 'test-code' }
  } }));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await read()).umlsMapping).toEqual({ cui: 'C0018681', preferredName: 'Headache', loinc: 'test-code' });
});

test('bulk mapping distinguishes provider failures from a successful search with no match and retries both', async ({ page, request }) => {
  await request.put('/api/conversations/' + sessionId, { data: session([
    { id: 'failed', name: 'Headache', type: 'Symptom' },
    { id: 'unmatched', name: 'Unknown concept', type: 'Condition' }
  ]) });
  let retry = false;
  await page.route('**/api/umls/map', route => {
    const { name } = route.request().postDataJSON();
    return route.fulfill({ json: retry
      ? { success: true, data: { cui: 'C0000001', preferredName: name } }
      : name === 'Headache' ? { success: false, error: 'Terminology service unavailable' } : { success: true, data: null }
    });
  });
  await page.goto('/?session=' + sessionId);
  await page.getByRole('button', { name: 'Auto-Map All', exact: true }).click();
  await expect(page.getByText('Terminology service unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No matching concept found in UMLS', { exact: true })).toBeVisible();
  retry = true;
  await page.getByRole('button', { name: 'Auto-Map All', exact: true }).click();
  await expect.poll(async () => {
    const saved = await (await request.get('/api/conversations/' + sessionId)).json();
    return saved.annotation.entities.filter((entity: any) => entity.umlsMapping?.cui).length;
  }).toBe(2);
});

test('an annotation with only a speaker reports no clinical entities, not that everything is mapped', async ({ page, request }) => {
  await request.put('/api/conversations/' + sessionId, { data: session([
    { id: 'speaker', name: 'Patient', type: 'Patient' }
  ]) });
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('/?session=' + sessionId);
  await page.getByRole('button', { name: 'Auto-Map All', exact: true }).click();
  await expect.poll(() => dialogs).toEqual(['No clinical entities were found to map. Extract mentions and map entities, or add a clinical entity first.']);
});
