import { createHash } from 'node:crypto';
import type { AnnotationCategory, AnnotationSchemaSnapshot } from '../src/types';

// Array order is meaningful (category, field, and choice order); object key order is not.
function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
  );
  return value;
}

export function schemaSnapshot(categories: AnnotationCategory[]): AnnotationSchemaSnapshot {
  const copy = JSON.parse(JSON.stringify(categories));
  return {
    version: 'sha256:' + createHash('sha256').update(JSON.stringify(canonicalize(copy))).digest('hex'),
    categories: copy,
  };
}

export function validateSchemaSnapshot(value: any): void {
  if (!value || !Array.isArray(value.categories) || !value.categories.length ||
      value.categories.some((cat: any) => !cat || typeof cat.id !== 'string' || !cat.id ||
        typeof cat.displayName !== 'string' || typeof cat.entityType !== 'string' ||
        !Array.isArray(cat.attributes) || cat.attributes.some((attr: any) => !attr ||
          typeof attr.name !== 'string' || !attr.name || !['text', 'textarea', 'number', 'select', 'boolean', 'temporal', 'trajectory', 'procedure-reference'].includes(attr.type) ||
          (attr.choices !== undefined && (!Array.isArray(attr.choices) || attr.choices.some((c: any) => typeof c !== 'string'))))) ||
      value.version !== schemaSnapshot(value.categories).version) {
    throw new Error('Invalid schema snapshot or schema version');
  }
}
