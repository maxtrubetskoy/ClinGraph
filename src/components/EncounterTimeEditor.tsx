import { useState } from 'react';
import TemporalEditor from './TemporalEditor';
import { formatAttributeValue } from '../utils/attributeValues';
import { normalizeTemporal, temporalError, validateEncounterTime } from '../utils/temporal';
import type { TemporalValue } from '../utils/temporal';

interface Props { value?: TemporalValue | null; onSave: (value: TemporalValue | null) => Promise<void> }
export default function EncounterTimeEditor({ value, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TemporalValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <section aria-label="Clinical encounter time" className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-xs font-semibold text-slate-700">Clinical encounter time</h3>
        <p className="text-xs text-slate-500 mt-1">{formatAttributeValue(value)} · independent of workspace creation time</p></div>
      {!editing && <button type="button" className="btn btn-secondary"
        onClick={() => { setDraft(value || null); setError(''); setEditing(true); }}>Edit encounter time</button>}
    </div>
    {editing && <div className="mt-3 space-y-3 max-w-xl">
      <TemporalEditor label="Encounter time" value={draft} mode="encounter" onChange={setDraft} disabled={saving} />
      {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
      <div className="flex gap-3">
        <button type="button" className="btn btn-primary"
          disabled={saving || Boolean(temporalError(draft))} onClick={async () => {
            setError(''); setSaving(true);
            try { validateEncounterTime(draft); await onSave(normalizeTemporal(draft)); setEditing(false); }
            catch (error) { setError((error as Error).message); }
            finally { setSaving(false); }
          }}>Save encounter time</button>
        <button type="button" disabled={saving} className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel encounter time</button>
      </div>
    </div>}
  </section>;
}
