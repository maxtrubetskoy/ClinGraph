import type { ReactNode } from 'react';
import type { Entity } from '../types';
import { formatAttributeValue } from '../utils/attributeValues';
import { datePrecision, formatResolvedTime, isTemporalValue, normalizeTemporal, resolveTemporal, temporalError, TIME_PRECISIONS, TIME_UNITS } from '../utils/temporal';
import type { TemporalContext, TemporalValue, TimeAnchor, TimePrecision, TimeQualifier, TimeUnit } from '../utils/temporal';

interface Props {
  label: string;
  value: unknown;
  onChange: (value: TemporalValue | null) => void;
  mode?: 'event' | 'duration' | 'encounter';
  context?: TemporalContext;
  attributeId?: string;
  disabled?: boolean;
}
const inputClass = 'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 focus:border-brand-500';
const labels = { absolute: 'Absolute date / time', relative: 'Relative offset', interval: 'Interval', duration: 'Duration / range', text: 'Unresolved text' };

export default function TemporalEditor({ label, value, onChange, mode, context = {}, attributeId, disabled }: Props) {
  let temporal: TemporalValue | null = null;
  try { temporal = normalizeTemporal(value); } catch { if (isTemporalValue(value)) temporal = value; }
  const kinds: TemporalValue['kind'][] = mode === 'encounter' ? ['absolute', 'text']
    : mode === 'duration' ? ['duration', 'text'] : mode === 'event' ? ['absolute', 'relative', 'interval', 'text']
    : ['absolute', 'relative', 'interval', 'duration', 'text'];
  const update = (fields: Record<string, unknown>) => onChange({ ...temporal, ...fields } as TemporalValue);
  const changeKind = (kind: string) => {
    if (!kind) return onChange(null);
    const common = { type: 'temporal' as const, text: temporal?.text || '', precision: 'unknown' as TimePrecision, qualifier: 'exact' as TimeQualifier };
    if (kind === 'absolute') onChange({ ...common, kind, date: '' });
    if (kind === 'relative') onChange({ ...common, kind, precision: 'day', anchor: { kind: 'encounter' }, offset: { value: NaN, unit: 'd' } });
    if (kind === 'interval') onChange({ ...common, kind, start: '', endStatus: 'unknown' });
    if (kind === 'duration') onChange({ ...common, kind, precision: 'day', amount: { value: NaN, unit: 'd' } });
    if (kind === 'text') onChange({ ...common, kind });
  };
  const anchorOptions = (context.entities || []).flatMap((entity: Entity) => (entity.attributes || [])
    .filter(a => a.valueType === 'temporal' && a.temporalMode !== 'duration' && a.id !== attributeId)
    .map(a => ({ id: a.id, entityId: entity.id, label: entity.name + ' · ' + a.name })));
  const error = temporalError(value === undefined || value === '' ? null : typeof value === 'string' ? normalizeTemporal(value) : value);
  const resolved = resolveTemporal(temporal, context);
  const field = (name: string, control: ReactNode) => <label className="block space-y-1"><span className="text-2xs text-slate-500">{name}</span>{control}</label>;
  const dateField = (name: string, date: string | undefined, onValue: (value: string) => void) => field(name,
    <input className={inputClass} aria-label={label + ' ' + name.toLowerCase()} value={date || ''} placeholder="YYYY-MM-DD or date-time with +02:00 / Z"
      onChange={event => onValue(event.target.value)} />);
  const unitField = (unit: TimeUnit, onValue: (unit: TimeUnit) => void) => field('Unit',
    <select className={inputClass} aria-label={label + ' unit'} value={unit} onChange={event => onValue(event.target.value as TimeUnit)}>
      {Object.entries(TIME_UNITS).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
    </select>);

  return <fieldset aria-label={label + ' timing'} disabled={disabled} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
    {field('Format', <select className={inputClass} aria-label={label + ' format'} value={temporal?.kind || ''} onChange={event => changeKind(event.target.value)}>
      <option value="">Unassigned</option>
      {kinds.map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}
    </select>)}
    {temporal && <>
      {temporal.kind === 'absolute' && dateField('Date', temporal.date, date => update({ date, precision: datePrecision(date) || 'unknown' }))}
      {temporal.kind === 'relative' && <>
        <div className="grid grid-cols-2 gap-2">
          {field('Signed offset (− before, + after)', <input aria-label={label + ' offset'} className={inputClass} type="number" step="any"
            value={Number.isNaN(temporal.offset.value) ? '' : temporal.offset.value}
            onChange={event => update({ offset: { ...temporal.offset, value: event.target.value === '' ? NaN : Number(event.target.value) } })} />)}
          {unitField(temporal.offset.unit, unit => update({ offset: { ...temporal.offset, unit } }))}
        </div>
        {field('Relative to', <select aria-label={label + ' anchor'} className={inputClass}
          value={temporal.anchor.kind === 'attribute' ? temporal.anchor.attributeId : temporal.anchor.kind}
          onChange={event => {
            const selected = anchorOptions.find(a => a.id === event.target.value);
            const anchor: TimeAnchor = selected ? { kind: 'attribute', entityId: selected.entityId, attributeId: selected.id }
              : event.target.value === 'encounter' ? { kind: 'encounter' } : { kind: 'unknown' };
            update({ anchor });
          }}>
          <option value="encounter">Clinical encounter time</option>
          <option value="unknown">Unknown / unnamed event</option>
          {anchorOptions.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>)}
        {temporal.anchor.kind === 'unknown' && field('Anchor description', <input className={inputClass} aria-label={label + ' anchor description'}
          value={temporal.anchor.label || ''} onChange={event => update({ anchor: { kind: 'unknown', label: event.target.value } })} />)}
        <p className="text-2xs text-slate-500">“Last week” is a calendar interval, not −1 week. Keep ambiguous expressions as unresolved text.</p>
      </>}
      {temporal.kind === 'duration' && <div className="grid grid-cols-2 gap-2">
        {field('Amount / minimum', <input type="number" min="0" step="any" className={inputClass} aria-label={label + ' amount'}
          value={Number.isNaN(temporal.amount.value) ? '' : temporal.amount.value}
          onChange={event => update({ amount: { ...temporal.amount, value: event.target.value === '' ? NaN : Number(event.target.value) } })} />)}
        {unitField(temporal.amount.unit, unit => update({ amount: { ...temporal.amount, unit } }))}
        {field('Maximum (optional)', <input type="number" min="0" step="any" className={inputClass} aria-label={label + ' maximum'}
          value={temporal.amount.maxValue ?? ''} onChange={event => {
            const { maxValue, ...amount } = temporal.amount;
            update({ amount: { ...amount, ...(event.target.value === '' ? {} : { maxValue: Number(event.target.value) }) } });
          }} />)}
      </div>}
      {temporal.kind === 'interval' && <>
        {dateField('Start', temporal.start, start => update({ start, precision: datePrecision(start) || 'unknown' }))}
        {field('End state', <select aria-label={label + ' end state'} className={inputClass} value={temporal.endStatus}
          onChange={event => update({ endStatus: event.target.value, end: undefined })}>
          <option value="unknown">Unknown end</option><option value="ongoing">Explicitly ongoing</option><option value="known">Known end</option>
        </select>)}
        {temporal.endStatus === 'known' && dateField('End', temporal.end, end => update({ end }))}
      </>}
      {temporal.kind !== 'text' && <div className="grid grid-cols-2 gap-2">
        {field('Qualifier', <select className={inputClass} aria-label={label + ' qualifier'} value={temporal.qualifier}
          onChange={event => update({ qualifier: event.target.value })}>
          <option value="exact">Exact / unqualified</option><option value="approximate">Approximate</option>
          {temporal.kind !== 'duration' && temporal.kind !== 'interval' && <><option value="before">Before</option><option value="after">After</option></>}
        </select>)}
        {(temporal.kind === 'relative' || temporal.kind === 'duration') && field('Source precision', <select className={inputClass}
          aria-label={label + ' precision'} value={temporal.precision} onChange={event => update({ precision: event.target.value })}>
          {TIME_PRECISIONS.map(precision => <option key={precision} value={precision}>{precision}</option>)}
        </select>)}
      </div>}
      {field(temporal.kind === 'text' ? 'Unresolved expression' : 'Original wording (optional)', <input className={inputClass}
        aria-label={label + ' source text'} value={temporal.text || ''} onChange={event => update({ text: event.target.value })} />)}
      {temporal.kind === 'relative' && <p className="text-2xs text-violet-700" role="status">
        {resolved ? 'Derived: ' + formatResolvedTime(resolved)
          : 'Unresolved: requires a sufficiently precise anchor. Calendar-month/year arithmetic is not inferred.'}
      </p>}
      {!error && <p className="text-2xs text-slate-500">{formatAttributeValue(temporal)}</p>}
    </>}
    {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
  </fieldset>;
}
