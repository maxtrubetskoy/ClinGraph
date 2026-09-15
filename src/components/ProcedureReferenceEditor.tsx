import type { Entity } from '../types';
import { formatAttributeValue } from '../utils/attributeValues';
import { isProcedureEntity, isProcedureReferenceValue, type ProcedureReferenceValue } from '../utils/procedureReferences';

export default function ProcedureReferenceEditor({ value, entities, onChange }: {
  value: unknown;
  entities: Entity[];
  onChange: (value: ProcedureReferenceValue | null) => void;
}) {
  const ids = isProcedureReferenceValue(value) ? value.procedureIds : [];
  const procedures = entities.filter(isProcedureEntity);
  const available = procedures.filter(entity => !ids.includes(entity.id));
  const label = (entity: Entity) => {
    const time = entity.attributes?.find(attribute => ['performed', 'performedTime'].includes(attribute.name))?.value;
    const sameName = procedures.filter(other => other.name === entity.name).length > 1;
    return `${entity.name}${time ? ` · ${formatAttributeValue(time)}` : ''}${sameName ? ` (${entity.id})` : ''}`;
  };
  return (
    <div className="space-y-2">
      {ids.length > 0 && <ul className="flex flex-wrap gap-2">
        {ids.map(id => {
          const procedure = procedures.find(entity => entity.id === id);
          return <li key={id} className="inline-flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs text-brand-800">
            <span>{procedure ? label(procedure) : 'Missing procedure'}</span>
            <button type="button" aria-label={`Unlink ${procedure?.name || id}`} className="text-brand-600 hover:text-brand-900 cursor-pointer"
              onClick={() => {
                const remaining = ids.filter(current => current !== id);
                onChange(remaining.length ? { type: 'procedure-reference', procedureIds: remaining } : null);
              }}>×</button>
          </li>;
        })}
      </ul>}
      <select aria-label="Part of procedure" value="" disabled={!available.length}
        className="w-full text-xs border border-slate-200 hover:border-slate-300 focus:border-brand-500 rounded-lg px-2.5 h-9 bg-white focus:ring-1 focus:ring-brand-400 focus:outline-none transition-colors shadow-sm cursor-pointer disabled:bg-slate-50 disabled:text-slate-400"
        onChange={event => {
          if (event.target.value) onChange({ type: 'procedure-reference', procedureIds: [...ids, event.target.value] });
        }}>
        <option value="">{available.length ? (ids.length ? 'Link another procedure…' : 'Select a procedure…') : procedures.length ? 'All procedures linked' : 'No procedure events yet'}</option>
        {available.map(entity => <option key={entity.id} value={entity.id}>{label(entity)}</option>)}
      </select>
      <p className="text-2xs text-slate-500">{procedures.length
        ? 'Link the procedure that produced this measurement when the source supports the connection.'
        : 'Add a Procedure event to this session, then link it here.'}</p>
    </div>
  );
}
