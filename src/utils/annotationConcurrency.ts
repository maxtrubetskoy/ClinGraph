export const DEFAULT_ANNOTATION_CONCURRENCY = 4;
export const MAX_ANNOTATION_CONCURRENCY = 32;
export const ANNOTATION_CONCURRENCY_ERROR = 'Annotation concurrency must be a whole number from 1 to 32.';

export function isValidAnnotationConcurrency(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ANNOTATION_CONCURRENCY;
}
