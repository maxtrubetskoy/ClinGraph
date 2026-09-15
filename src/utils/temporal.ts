import type { Entity } from '../types';

export type TimeUnit = 'a' | 'mo' | 'wk' | 'd' | 'h' | 'min' | 's';
export type TimePrecision = 'unknown' | 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';
export type TimeQualifier = 'exact' | 'approximate' | 'before' | 'after';
export type TimeAnchor =
  | { kind: 'encounter' }
  | { kind: 'attribute'; entityId: string; attributeId: string }
  | { kind: 'unknown'; label?: string };

interface TemporalBase {
  type: 'temporal';
  precision: TimePrecision;
  qualifier: TimeQualifier;
  text?: string;
}
export type TemporalValue = TemporalBase & (
  | { kind: 'absolute'; date: string }
  | { kind: 'relative'; anchor: TimeAnchor; offset: { value: number; unit: TimeUnit } }
  | { kind: 'interval'; start?: string; end?: string; endStatus: 'unknown' | 'ongoing' | 'known' }
  | { kind: 'duration'; amount: { value: number; maxValue?: number; unit: TimeUnit } }
  | { kind: 'text'; text: string }
);
export interface TemporalContext { encounterTime?: TemporalValue | null; entities?: Entity[] }
export interface ResolvedTime { date: string; precision: TimePrecision; qualifier: TimeQualifier }

export const TIME_UNITS: Record<TimeUnit, string> = { a: 'years', mo: 'months', wk: 'weeks', d: 'days', h: 'hours', min: 'minutes', s: 'seconds' };
export const TIME_PRECISIONS: TimePrecision[] = ['unknown', 'year', 'month', 'week', 'day', 'hour', 'minute', 'second'];
export const isTemporalValue = (value: unknown): value is TemporalValue =>
  value !== null && typeof value === 'object' && (value as any).type === 'temporal';

/** Returns the precision actually present; never fills absent calendar fields. */
export function datePrecision(value: string): TimePrecision | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1 || (month && (m < 1 || m > 12))) return null;
  if (day) {
    const date = new Date(0); date.setUTCFullYear(y, m, 0);
    if (d < 1 || d > date.getUTCDate()) return null;
  }
  if (hour !== undefined) {
    if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59) return null;
    if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 ||
        (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0))) return null;
    return second === undefined ? 'minute' : 'second';
  }
  return day ? 'day' : month ? 'month' : 'year';
}

export function validateTemporal(value: unknown): asserts value is TemporalValue | null {
  if (value === null) return;
  if (!isTemporalValue(value)) throw new Error('Expected a structured temporal value');
  if (!TIME_PRECISIONS.includes(value.precision) || !['exact', 'approximate', 'before', 'after'].includes(value.qualifier) ||
      (value.text !== undefined && typeof value.text !== 'string')) throw new Error('Invalid temporal precision, qualifier, or source text');
  const checkDate = (date: unknown) => {
    if (typeof date !== 'string' || !datePrecision(date)) throw new Error('Use a valid YYYY, YYYY-MM, YYYY-MM-DD, or date-time with an explicit UTC offset');
  };
  const checkAmount = (amount: any, signed: boolean) => {
    if (!amount || typeof amount.value !== 'number' || !Number.isFinite(amount.value) ||
        (!signed && amount.value < 0) || !Object.hasOwn(TIME_UNITS, amount.unit)) throw new Error('Use a finite amount and a valid time unit; durations cannot be negative');
  };
  switch (value.kind) {
    case 'absolute':
      checkDate(value.date);
      if (value.precision !== datePrecision(value.date)) throw new Error('Date precision must match the supplied date');
      break;
    case 'relative':
      checkAmount(value.offset, true);
      if (!value.anchor || !['encounter', 'attribute', 'unknown'].includes(value.anchor.kind)) throw new Error('Choose a time anchor');
      if (value.anchor.kind === 'attribute' && (typeof value.anchor.entityId !== 'string' || !value.anchor.entityId ||
          typeof value.anchor.attributeId !== 'string' || !value.anchor.attributeId)) throw new Error('Choose an attribute anchor');
      if (value.anchor.kind === 'unknown' && value.anchor.label !== undefined && typeof value.anchor.label !== 'string') throw new Error('Invalid anchor label');
      break;
    case 'duration':
      checkAmount(value.amount, false);
      if (value.amount.maxValue !== undefined && (typeof value.amount.maxValue !== 'number' || !Number.isFinite(value.amount.maxValue) ||
          value.amount.maxValue < value.amount.value)) throw new Error('Duration range must end at or above its start');
      if (value.qualifier === 'before' || value.qualifier === 'after') throw new Error('A duration is an amount, not an event date');
      break;
    case 'interval':
      if (value.start) checkDate(value.start);
      if (value.end) checkDate(value.end);
      if (!value.start && !value.end) throw new Error('Provide at least one interval boundary, or retain unresolved text');
      if (!['unknown', 'ongoing', 'known'].includes(value.endStatus) || (value.endStatus === 'known') !== Boolean(value.end)) throw new Error('Known interval ends require an end date; unknown/ongoing ends must be empty');
      if (value.start && value.end && datePrecision(value.start) === datePrecision(value.end)) {
        const reversed = value.start.includes('T') ? Date.parse(value.start) > Date.parse(value.end) : value.start > value.end;
        if (reversed) throw new Error('Interval end cannot precede its start');
      }
      break;
    case 'text':
      if (!value.text?.trim()) throw new Error('Enter the unresolved time expression, or clear the attribute');
      break;
    default: throw new Error('Unsupported temporal kind');
  }
}

export function temporalError(value: unknown): string | null {
  try { validateTemporal(value); return null; } catch (error) { return (error as Error).message; }
}

/** Legacy strings remain text, not guessed dates or offsets. */
export function normalizeTemporal(value: unknown): TemporalValue | null {
  if (value === undefined || value === null || (typeof value === 'string' && /^(|unassigned|unspecified)$/i.test(value.trim()))) return null;
  if (typeof value === 'string') return { type: 'temporal', kind: 'text', text: value, precision: 'unknown', qualifier: 'exact' };
  validateTemporal(value);
  // Calculated dates are never trusted as stored/model-produced facts.
  const { resolved, ...original } = value as TemporalValue & { resolved?: unknown };
  return original as TemporalValue;
}

export function validateEncounterTime(value: unknown) {
  validateTemporal(value);
  if (value && value.kind !== 'absolute' && value.kind !== 'text') throw new Error('Encounter time must be an absolute date/time or unresolved text');
}

/** Validate anchor ownership and cycles, even when an anchor's date is still unknown. */
export function validateTemporalAnchors(entities: Entity[], additionalValues: unknown[] = []) {
  const attributes = new Map(entities.flatMap(entity => (entity.attributes || []).map(attribute =>
    [attribute.id, { attribute, entityId: entity.id }] as const)));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error('Temporal anchors cannot form a cycle');
    visiting.add(id);
    visitValue(attributes.get(id)!.attribute.value);
    visiting.delete(id); done.add(id);
  };
  const visitValue = (value: unknown) => {
    if (isTemporalValue(value)) {
      validateTemporal(value);
      if (value.kind === 'relative' && value.anchor.kind === 'attribute') {
        const target = attributes.get(value.anchor.attributeId);
        if (!target || target.entityId !== value.anchor.entityId || target.attribute.valueType !== 'temporal' ||
            target.attribute.temporalMode === 'duration' || (isTemporalValue(target.attribute.value) && target.attribute.value.kind === 'duration')) {
          throw new Error('Temporal anchor references a missing or non-event temporal attribute');
        }
        visit(value.anchor.attributeId);
      }
    }
  };
  attributes.forEach((_, id) => visit(id));
  additionalValues.forEach(visitValue);
}

/** Conservative derived preview. No createdAt fallback; coarse/unknown anchors stay unresolved. */
export function resolveTemporal(value: unknown, context: TemporalContext = {}, visited = new Set<string>()): ResolvedTime | null {
  if (!isTemporalValue(value) || temporalError(value)) return null;
  if (value.kind === 'absolute') return { date: value.date, precision: value.precision, qualifier: value.qualifier };
  if (value.kind !== 'relative' || value.anchor.kind === 'unknown' || value.precision === 'unknown') return null;
  let anchor: unknown;
  if (value.anchor.kind === 'encounter') anchor = context.encounterTime;
  else {
    if (visited.has(value.anchor.attributeId)) return null;
    visited = new Set(visited).add(value.anchor.attributeId);
    const reference = value.anchor;
    anchor = context.entities?.find(entity => entity.id === reference.entityId)?.attributes?.find(a => a.id === reference.attributeId)?.value;
  }
  const base = resolveTemporal(anchor, context, visited);
  if (!base || base.qualifier === 'before' || base.qualifier === 'after' ||
      (base.qualifier === 'approximate' && ['before', 'after'].includes(value.qualifier))) return null;
  const { unit, value: offset } = value.offset;
  // Calendar months/years need an explicit arithmetic policy; preserve them without fabricating a day.
  if (unit === 'a' || unit === 'mo') return null;
  const rank = (precision: TimePrecision) => TIME_PRECISIONS.indexOf(precision);
  const required = { wk: 'day', d: 'day', h: 'hour', min: 'minute', s: 'second' } as const;
  if (rank(base.precision) < rank(required[unit])) return null;
  if (!Number.isInteger(offset) && !base.date.includes('T')) return null;
  const milliseconds = { wk: 604800000, d: 86400000, h: 3600000, min: 60000, s: 1000 }[unit];
  const timestamp = Date.parse(base.date.includes('T') ? base.date : base.date + 'T00:00:00Z') + offset * milliseconds;
  if (!Number.isFinite(timestamp)) return null;
  const result = new Date(timestamp);
  if (result.getUTCFullYear() < 1 || result.getUTCFullYear() > 9999) return null;
  // Keep source granularity: never advertise a result as more precise than the expression or anchor.
  const precision = rank(value.precision) < rank(base.precision) ? value.precision : base.precision;
  const iso = result.toISOString();
  // Preserve the nominal calculation, not a rounded/invented midnight. Precision is explicit metadata.
  const date = !base.date.includes('T') ? iso.slice(0, 10)
    : base.precision === 'minute' && unit !== 's' ? iso.slice(0, 16) + 'Z' : iso.slice(0, 19) + 'Z';
  return { date, precision, qualifier: base.qualifier === 'approximate' ? 'approximate' : value.qualifier };
}

export function formatTemporal(value: TemporalValue): string {
  const qualifier = value.qualifier === 'approximate' ? 'about ' : value.qualifier === 'exact' ? '' : value.qualifier + ' ';
  const quantity = (amount: number, unit: TimeUnit) => amount + ' ' + (Math.abs(amount) === 1 ? TIME_UNITS[unit].slice(0, -1) : TIME_UNITS[unit]);
  switch (value.kind) {
    case 'absolute': return qualifier + value.date;
    case 'relative': {
      const anchor = value.anchor?.kind === 'encounter' ? 'encounter' : value.anchor?.kind === 'attribute' ? 'linked event' : value.anchor?.label || 'unknown anchor';
      return qualifier + quantity(Math.abs(value.offset.value), value.offset.unit) + (value.offset.value < 0 ? ' before ' : ' after ') + anchor;
    }
    case 'duration': return qualifier + (value.amount.maxValue === undefined ? quantity(value.amount.value, value.amount.unit)
      : value.amount.value + '–' + value.amount.maxValue + ' ' + TIME_UNITS[value.amount.unit]);
    case 'interval': return qualifier + (value.start || 'unknown start') + ' → ' + (value.end || (value.endStatus === 'ongoing' ? 'ongoing' : 'unknown end'));
    case 'text': return value.text;
  }
}

export function formatResolvedTime(value: ResolvedTime): string {
  const date = value.precision === 'year' ? value.date.slice(0, 4) : value.precision === 'month' ? value.date.slice(0, 7)
    : ['week', 'day'].includes(value.precision) ? value.date.slice(0, 10) : value.date;
  return (value.qualifier === 'exact' ? '' : value.qualifier + ' ') + date + ' (' + value.precision + ' precision)';
}
