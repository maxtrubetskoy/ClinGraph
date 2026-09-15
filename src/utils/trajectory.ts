import { formatTemporal, normalizeTemporal, validateTemporal } from './temporal';
import type { TemporalValue } from './temporal';

export const TRAJECTORY_DIRECTIONS = ['improved', 'worsened', 'unchanged', 'unassigned'] as const;
export type TrajectoryDirection = typeof TRAJECTORY_DIRECTIONS[number];

/** One clinical comparison, not a numeric trend or the entity's current severity/status. */
export interface TrajectoryValue {
  type: 'trajectory';
  direction: TrajectoryDirection;
  comparedTo: TemporalValue | null;
  text?: string;
}

export const isTrajectoryValue = (value: unknown): value is TrajectoryValue =>
  value !== null && typeof value === 'object' && (value as any).type === 'trajectory';

export function validateTrajectory(value: unknown): asserts value is TrajectoryValue | null {
  if (value === null) return;
  if (!isTrajectoryValue(value) || !TRAJECTORY_DIRECTIONS.includes(value.direction) ||
      (value.text !== undefined && typeof value.text !== 'string')) throw new Error('Choose improved, worsened, unchanged, or unassigned trajectory');
  validateTemporal(value.comparedTo);
  if (value.comparedTo?.kind === 'duration') throw new Error('Trajectory comparison requires a time point or interval, not a duration');
}

/** Preserve legacy wording without inventing a comparison time or interpreting numeric changes. */
export function normalizeTrajectory(value: unknown): TrajectoryValue | null {
  if (value === undefined || value === null || (typeof value === 'string' && /^(|unassigned|unspecified)$/i.test(value.trim()))) return null;
  if (typeof value === 'string') {
    const literal = value.trim().toLowerCase();
    const direction: TrajectoryDirection = literal === 'better' || literal === 'improved' ? 'improved'
      : literal === 'worse' || literal === 'worsened' ? 'worsened' : literal === 'unchanged' ? 'unchanged' : 'unassigned';
    return { type: 'trajectory', direction, comparedTo: null, text: value };
  }
  if (!isTrajectoryValue(value)) throw new Error('Expected a structured trajectory value');
  const normalized: TrajectoryValue = { type: 'trajectory', direction: value.direction,
    comparedTo: normalizeTemporal(value.comparedTo), ...(value.text !== undefined ? { text: value.text } : {}) };
  validateTrajectory(normalized);
  return normalized;
}

export function trajectoryError(value: unknown): string | null {
  try { normalizeTrajectory(value); return null; } catch (error) { return (error as Error).message; }
}

export function formatTrajectory(value: TrajectoryValue): string {
  const direction = value.direction === 'unassigned' ? 'Direction unassigned'
    : value.direction[0].toUpperCase() + value.direction.slice(1);
  return direction + ' compared with ' + (value.comparedTo ? formatTemporal(value.comparedTo) : 'unspecified time') +
    (value.text ? ' · “' + value.text + '”' : '');
}
