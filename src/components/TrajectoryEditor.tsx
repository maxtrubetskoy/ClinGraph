import TemporalEditor from './TemporalEditor';
import { isTrajectoryValue, normalizeTrajectory, trajectoryError } from '../utils/trajectory';
import type { TrajectoryDirection, TrajectoryValue } from '../utils/trajectory';
import type { TemporalContext } from '../utils/temporal';

interface Props {
  label: string;
  value: unknown;
  onChange: (value: TrajectoryValue | null) => void;
  context?: TemporalContext;
  attributeId?: string;
}

export default function TrajectoryEditor({ label, value, onChange, context, attributeId }: Props) {
  let trajectory: TrajectoryValue | null = null;
  try { trajectory = normalizeTrajectory(value); } catch { if (isTrajectoryValue(value)) trajectory = value; }
  const update = (fields: Partial<TrajectoryValue>) => onChange({ type: 'trajectory', direction: 'unassigned', comparedTo: null, ...trajectory, ...fields });
  const error = trajectoryError(value);

  return <fieldset aria-label={label + ' comparison'} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
    <label className="block space-y-1">
      <span className="text-xs text-slate-600">Clinical change</span>
      <select aria-label={label + ' direction'} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs"
        value={trajectory?.direction || 'unassigned'} onChange={event => update({ direction: event.target.value as TrajectoryDirection })}>
        <option value="unassigned">Unassigned / unclear</option>
        <option value="improved">Improved (better)</option>
        <option value="worsened">Worsened (worse)</option>
        <option value="unchanged">Unchanged</option>
      </select>
    </label>
    <p className="text-2xs text-slate-500">Change is separate from severity and status. A numeric rise or fall alone does not mean better or worse.</p>
    <div className="space-y-1">
      <span className="text-xs text-slate-600">Compared with which time point?</span>
      <TemporalEditor label={label + ' comparison time'} value={trajectory?.comparedTo ?? null} mode="event"
        context={context} attributeId={attributeId} onChange={comparedTo => update({ comparedTo })} />
      <p className="text-2xs text-slate-500">Leave unassigned if not stated. Use a zero offset to link directly to another event's time.</p>
    </div>
    <label className="block space-y-1">
      <span className="text-xs text-slate-600">Original comparison wording (optional)</span>
      <input aria-label={label + ' source text'} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs"
        value={trajectory?.text || ''} placeholder="e.g. worse than a week ago"
        onChange={event => update({ text: event.target.value })} />
    </label>
    {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
    {trajectory && <button type="button" className="text-xs text-slate-500 hover:text-rose-600 cursor-pointer"
      aria-label={'Clear ' + label.toLowerCase()} onClick={() => onChange(null)}>Clear comparison</button>}
  </fieldset>;
}
