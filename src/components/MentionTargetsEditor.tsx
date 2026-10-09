import type { Entity, EvidenceTarget, Mention } from '../types';
import { getMentionTargets, setMentionTargets } from '../utils/evidenceTargets';
import { formatAttributeValue } from '../utils/attributeValues';

export default function MentionTargetsEditor({ mention, entities, onChange, readOnly = false, labelPrefix = '' }: {
  mention: Mention; entities: Entity[]; onChange: (mention: Mention) => void; readOnly?: boolean; labelPrefix?: string;
}) {
  const targets = getMentionTargets(mention);
  const available = entities.filter(entity => !targets.some(t => t.entityId === entity.id));
  const update = (links: EvidenceTarget[]) => onChange(setMentionTargets(mention, links));
  return (
    <section aria-label={`${labelPrefix}Mention links for ${mention.textSpan.text}`} className="w-full space-y-2 rounded-lg border border-slate-200 bg-white p-3"
      onClick={event => event.stopPropagation()}>
      <p className="text-xs font-semibold text-slate-700">Linked entities ({targets.length})</p>
      {targets.length > 1 && <p className="text-xs text-slate-500">One source mention, shared by these entities. Role and context apply to the source mention.</p>}
      {!targets.length && <p className="text-xs text-amber-700">This mention is unlinked. Its source text is preserved.</p>}
      {targets.map(target => {
        const entity = entities.find(e => e.id === target.entityId);
        return <div key={target.entityId} className="flex flex-wrap items-end gap-2 rounded border border-slate-100 p-2">
          <label className="flex-1 min-w-[140px] text-xs font-medium text-slate-700">
            {entity?.name || target.entityId}
            <select aria-label={`${labelPrefix}Evidence target for ${mention.textSpan.text}${targets.length > 1 ? ` · ${entity?.name || target.entityId}` : ''}`}
              value={target.kind === 'attribute' ? target.attributeId : '__entity__'} disabled={readOnly}
              onChange={event => update(targets.map(t => t.entityId !== target.entityId ? t : event.target.value === '__entity__'
                ? { kind: 'entity', entityId: target.entityId } : { kind: 'attribute', entityId: target.entityId, attributeId: event.target.value }))}
              className="mt-1 w-full rounded border border-slate-200 bg-white p-1.5 text-xs focus:ring-2 focus:ring-brand-400">
              <option value="__entity__">Entity itself</option>
              {(entity?.attributes || []).map(attribute => <option key={attribute.id} value={attribute.id}>
                {attribute.name}: {formatAttributeValue(attribute.value, entities)}
              </option>)}
            </select>
          </label>
          <button type="button" disabled={readOnly} aria-label={`${labelPrefix}Remove link to ${entity?.name || target.entityId}`}
            onClick={() => update(targets.filter(t => t.entityId !== target.entityId))}
            className="rounded border border-slate-200 px-2 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50">Remove link</button>
        </div>;
      })}
      <label className="block text-xs font-medium text-slate-700">
        {targets.length ? 'Link another entity' : 'Link an entity'}
        <select aria-label={`${labelPrefix}Link entity to ${mention.textSpan.text}`} value="" disabled={readOnly || !available.length}
          onChange={event => { if (event.target.value) update([...targets, { kind: 'entity', entityId: event.target.value }]); }}
          className="mt-1 w-full rounded border border-slate-200 bg-white p-1.5 text-xs focus:ring-2 focus:ring-brand-400">
          <option value="">{available.length ? 'Choose an entity…' : 'All entities are linked'}</option>
          {available.map(entity => <option key={entity.id} value={entity.id}>{entity.name} ({entity.type})</option>)}
        </select>
      </label>
    </section>
  );
}
