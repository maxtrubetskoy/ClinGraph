import { useEffect, useRef, useState } from 'react';
import { Download, History, X } from 'lucide-react';
import type { AnnotationCheckpoint, AnnotationCheckpointSummary, Conversation } from '../types';

interface Props {
  conversation: Conversation;
  onClose: () => void;
  onRestored: (conversation: Conversation) => void;
  listCheckpoints: (id: string) => Promise<AnnotationCheckpointSummary[]>;
  getCheckpoint: (id: string, checkpointId: string) => Promise<AnnotationCheckpoint>;
  createCheckpoint: (id: string, label: string) => Promise<AnnotationCheckpoint>;
  restoreCheckpoint: (id: string, checkpointId: string) => Promise<Conversation>;
}

const shortSchema = (version: string) => version.replace('sha256:', '').slice(0, 12);

export default function AnnotationHistory({ conversation, onClose, onRestored, listCheckpoints, getCheckpoint, createCheckpoint, restoreCheckpoint }: Props) {
  const [rows, setRows] = useState<AnnotationCheckpointSummary[]>([]);
  const [selected, setSelected] = useState<AnnotationCheckpoint | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    listCheckpoints(conversation.id).then(result => { if (active) setRows(result); })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; previouslyFocused?.focus(); };
  }, [conversation.id, listCheckpoints]);

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); } catch (err) { setError(err instanceof Error ? err.message : 'Checkpoint operation failed'); }
    finally { setBusy(false); }
  };
  const download = () => {
    if (!selected) return;
    // Export the untouched archive, not a reconstruction through current annotation migrations.
    const url = URL.createObjectURL(new Blob([JSON.stringify(selected, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${conversation.id}_checkpoint_v${selected.version}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    onKeyDown={event => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab') {
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]'));
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <section role="dialog" aria-modal="true" aria-labelledby="annotation-history-title"
      className="dialog-surface bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
      <header className="p-5 border-b flex items-start justify-between gap-4">
        <div><h2 id="annotation-history-title" className="font-semibold flex items-center gap-2"><History className="w-5 h-5" />Annotation history</h2>
          <p className="text-sm text-slate-500">{conversation.title}</p></div>
        <button ref={closeButton} onClick={onClose} disabled={busy} aria-label="Close annotation history" className="p-1 disabled:opacity-40"><X /></button>
      </header>
      <div className="p-5 overflow-y-auto space-y-4">
        <p className="text-sm text-slate-600">Checkpoints preserve saved source text, segments, annotations, encounter time, and the complete schema. Save open annotation forms first. Audio and AI credentials are not included.</p>
        <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
          event.preventDefault();
          void perform(async () => {
            const checkpoint = await createCheckpoint(conversation.id, label);
            setSelected(checkpoint); setConfirmRestore(false); setLabel('');
            setRows(await listCheckpoints(conversation.id));
          });
        }}>
          <label className="flex-1 text-sm min-w-48">Checkpoint label (optional)
            <input value={label} onChange={event => setLabel(event.target.value)} maxLength={200} disabled={busy}
              placeholder="e.g. Human-reviewed baseline" className="block border rounded-lg px-3 py-2 w-full mt-1" /></label>
          <button disabled={busy || conversation.status === 'processing'} className="btn btn-primary">Save checkpoint</button>
        </form>
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</p>}
        {busy && <p role="status" className="text-sm text-slate-500">Loading / saving checkpoint…</p>}
        <div className="grid md:grid-cols-[260px_1fr] gap-4">
          <nav aria-label="Saved checkpoints" className="space-y-2">
            {!busy && !rows.length && <p className="text-sm text-slate-500">No checkpoints yet.</p>}
            {rows.map(row => <button key={row.id} disabled={busy} aria-pressed={selected?.id === row.id}
              onClick={() => void perform(async () => { setSelected(await getCheckpoint(conversation.id, row.id)); setConfirmRestore(false); })}
              className={`block w-full text-left rounded-lg border p-3 text-sm disabled:opacity-50 ${selected?.id === row.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
              <span className="font-semibold">v{row.version} · {row.label || (row.reason === 'before-ai' ? 'Before AI regeneration' : 'Checkpoint')}</span>
              <time dateTime={row.createdAt} className="block text-xs text-slate-500">{new Date(row.createdAt).toLocaleString()}</time>
              <span className="block text-xs text-slate-500">Schema {shortSchema(row.schemaVersion)} · {row.entityCount} entities · {row.mentionCount} mentions</span>
            </button>)}
          </nav>
          {selected ? <article aria-label="Checkpoint preview" className="space-y-3 min-w-0">
            <h3 className="font-semibold">Checkpoint v{selected.version}{selected.label ? ` — ${selected.label}` : ''}</h3>
            <p className="text-xs text-slate-500 break-all">Schema version: {selected.schemaVersion}</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={download} disabled={busy} className="btn btn-secondary"><Download className="w-4 h-4" />Download checkpoint JSON</button>
              <button onClick={() => setConfirmRestore(true)} disabled={busy} className="btn btn-primary">Restore as new session</button>
            </div>
            {confirmRestore && <div className="border border-brand-200 bg-brand-50 p-3 rounded-lg text-sm space-y-2">
              <p>Create a separate editable session with this source text, annotation, and captured schema? The current session and checkpoint remain unchanged. Audio is not copied. Older annotations may be migrated for the current editor; the downloaded checkpoint stays exact.</p>
              <button disabled={busy} onClick={() => void perform(async () => onRestored(await restoreCheckpoint(conversation.id, selected.id)))}
                className="bg-brand-600 text-white rounded px-3 py-1.5 mr-2 disabled:opacity-40">Create restored session</button>
              <button disabled={busy} onClick={() => setConfirmRestore(false)} className="border rounded px-3 py-1.5">Cancel restore</button>
            </div>}
            <h4 className="text-sm font-semibold">Source text at checkpoint</h4>
            <pre tabIndex={0} className="text-xs whitespace-pre-wrap break-words bg-slate-50 border rounded-lg p-3 max-h-64 overflow-auto">{selected.snapshot.rawTranscript || '(Empty source text)'}</pre>
            <details><summary className="text-sm cursor-pointer">Captured schema ({selected.schema.categories.length} categories)</summary>
              <pre tabIndex={0} className="text-xs whitespace-pre-wrap break-words bg-slate-50 p-3 max-h-64 overflow-auto">{JSON.stringify(selected.schema.categories, null, 2)}</pre></details>
            <details><summary className="text-sm cursor-pointer">Annotation snapshot (read-only JSON)</summary>
              <pre tabIndex={0} className="text-xs whitespace-pre-wrap break-words bg-slate-50 p-3 max-h-80 overflow-auto">{JSON.stringify(selected.snapshot.annotation ?? null, null, 2)}</pre></details>
          </article> : <p className="text-sm text-slate-500">Select a checkpoint to preview, download, or restore it.</p>}
        </div>
      </div>
    </section>
  </div>;
}
