import { formatTemporal, isTemporalValue } from './temporal';
import { formatTrajectory, isTrajectoryValue } from './trajectory';
import type { Entity } from '../types';
import { isProcedureReferenceValue } from './procedureReferences';

export function formatAttributeValue(value: unknown, entities?: Entity[]): string {
  if (value === null || value === undefined || value === '') return 'Unassigned';
  if (isTemporalValue(value)) return formatTemporal(value);
  if (isTrajectoryValue(value)) return formatTrajectory(value);
  if (isProcedureReferenceValue(value)) return value.procedureIds.length
    ? value.procedureIds.map(id => entities?.find(entity => entity.id === id)?.name || `Procedure (${id})`).join(', ')
    : 'Unassigned';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
