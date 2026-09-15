import { ANNOTATION_CONCURRENCY_ERROR, DEFAULT_ANNOTATION_CONCURRENCY, isValidAnnotationConcurrency } from '../src/utils/annotationConcurrency';

/** Maximum simultaneous utterance extractions within one annotation run. */
export function aiExtractionConcurrency(configured?: unknown): number {
  if (configured !== undefined) {
    if (!isValidAnnotationConcurrency(configured)) throw Object.assign(new Error(ANNOTATION_CONCURRENCY_ERROR), { status: 400 });
    return configured;
  }
  const value = Number(process.env.CLINGRAPH_AI_CONCURRENCY ?? DEFAULT_ANNOTATION_CONCURRENCY);
  if (!isValidAnnotationConcurrency(value)) {
    throw new Error('CLINGRAPH_AI_CONCURRENCY must be an integer between 1 and 32');
  }
  return value;
}

export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
