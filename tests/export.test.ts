import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateJsonlContent } from '../src/utils/exportJsonl';
import { migrateToMentionsSchema } from '../src/types';

test('deleting the final mention does not regenerate it from the legacy entity span', () => {
  const annotation = {
    entities: [{ id: 'e1', name: 'Headache', type: 'Symptom', textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'headache' } }],
    relations: [], clinicalNotes: { symptoms: [], medications: [], followUps: [] }, mentions: [],
  };
  assert.deepEqual(migrateToMentionsSchema(annotation).mentions, []);
  const { mentions, ...legacy } = annotation;
  assert.equal(migrateToMentionsSchema(legacy).mentions.length, 1);
});

test('exports do not turn missing context into positive, certain, current patient assertions', () => {
  const entity = { id: 'e1', type: 'Symptom', name: 'Headache' };
  const mention = { id: 'm1', entityId: 'e1', entityType: 'Symptom',
    textSpan: { lineIndex: 0, startChar: 0, endChar: 8, text: 'headache' } };
  for (const mode of ['mentions', 'entities_mentions'] as const) {
    const row = JSON.parse(generateJsonlContent(mode, null, [entity], [mention]));
    const exported = mode === 'mentions' ? row : row.mentions[0];
    for (const attribute of ['polarity', 'certainty', 'temporality', 'experiencer', 'function']) {
      assert.equal(exported[attribute], 'unassigned');
    }
  }
});
