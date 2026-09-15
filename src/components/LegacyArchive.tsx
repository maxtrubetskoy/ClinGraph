import { useEffect, useRef, useState } from 'react';
import { Archive, Download, X } from 'lucide-react';
import { request } from '../lib/localApi';
import { apiFetch } from '../firebase';
import type { ArchivedSession, ArchivedSessionSummary } from '../lib/legacyArchive';

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const display = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
function OriginalJson({ value }: { value: unknown }) {
  return <pre className="text-xs whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded-xl p-4 max-h-96 overflow-auto">{display(value)}</pre>;
}

export default function LegacyArchive({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<ArchivedSessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [record, setRecord] = useState<ArchivedSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const controller = new AbortController();
    void request<ArchivedSessionSummary[]>('/archive/sessions', { signal: controller.signal })
      .then(data => { setSessions(data); setSelected(data[0]?.id || null); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); previousFocus?.focus(); };
  }, []);
  useEffect(() => {
    setRecord(null); setAudioUrl(''); setError('');
    if (!selected) return;
    const controller = new AbortController();
    let url = '';
    setDetailLoading(true);
    void request<ArchivedSession>(`/archive/sessions/${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then(async data => {
        if (controller.signal.aborted) return;
        setRecord(data); setDetailLoading(false);
        if (typeof data.record.audioDataUrl !== 'string') return;
        const response = await apiFetch(`/api/archive/sessions/${encodeURIComponent(selected)}/audio`, { signal: controller.signal });
        if (!response.ok) return;
        const blob = await response.blob();
        if (!controller.signal.aborted) { url = URL.createObjectURL(blob); setAudioUrl(url); }
      }).catch(error => { if (!controller.signal.aborted) { setError(error.message); setDetailLoading(false); } });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [selected]);
  const download = () => {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `archived-session-${record.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const annotation = object(record?.record.annotation);
  const notes = object(annotation?.clinicalNotes);
  return <div className="fixed inset-0 z-50 bg-slate-900/40 p-3 sm:p-6 flex items-center justify-center">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="archive-title" className="bg-white rounded-2xl shadow-xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const elements = dialog.current?.querySelectorAll<HTMLElement>('button, a[href], audio, summary, [tabindex="0"]');
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="p-5 border-b flex items-start justify-between gap-3">
        <div><h2 id="archive-title" className="text-lg font-semibold flex items-center gap-2"><Archive className="w-5 h-5" />Legacy archive</h2>
          <p className="text-sm text-slate-500 mt-1">Read-only · Original sessions and annotation values are preserved. New sessions use the current schema.</p></div>
        <button ref={close} onClick={onClose} className="icon-button" aria-label="Close archive"><X className="w-5 h-5" /></button>
      </header>
      {error && <p role="alert" className="p-4 text-sm text-rose-700">{error}</p>}
      {loading ? <p role="status" className="p-6 text-slate-500">Loading archived sessions…</p> : sessions.length === 0
        ? <p className="p-6 text-slate-500">No archived sessions for this account.</p>
        : <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
          <nav aria-label="Archived sessions" className="sm:w-64 shrink-0 overflow-auto max-h-40 sm:max-h-none border-b sm:border-b-0 sm:border-r p-3 space-y-1">
            {sessions.map(session => <button key={session.id} onClick={() => setSelected(session.id)} aria-current={selected === session.id ? 'true' : undefined}
              className={`w-full text-left rounded-lg px-3 py-3 ${selected === session.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-slate-50'}`}>
              <span className="text-sm font-medium block break-words">{session.title}</span>
              <span className="text-xs text-slate-500">{session.createdAt.slice(0, 10)}</span>
            </button>)}
          </nav>
          <section aria-label="Archived session contents" tabIndex={0} className="flex-1 min-w-0 overflow-auto p-5 space-y-6">
            {detailLoading && <p role="status">Loading original record…</p>}
            {record && <>
              <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{display(record.record.title) || 'Untitled archived session'}</h3>
                <button className="btn btn-secondary" onClick={download}><Download className="w-4 h-4" />Download original JSON</button></div>
              <section><h4 className="font-medium mb-2">Original transcript</h4>
                <OriginalJson value={record.record.rawTranscript ?? record.record.transcriptSegments ?? ''} /></section>
              {audioUrl && <audio controls src={audioUrl} className="w-full" aria-label="Archived audio" />}
              {!audioUrl && record.record.hasAudio === true && <p className="text-sm text-slate-500">This record references audio that was stored only in the original browser.</p>}
              {notes && <section><h4 className="font-medium mb-3">Original clinical notes</h4>
                <div className="space-y-4">{Object.entries(notes).map(([category, items]) => <div key={category}>
                  <h5 className="text-sm font-medium text-slate-600 mb-2">{category}</h5><OriginalJson value={items} />
                </div>)}</div></section>}
              <details><summary className="cursor-pointer font-medium">All original annotation fields</summary><div className="mt-3"><OriginalJson value={record.record.annotation ?? null} /></div></details>
              <details><summary className="cursor-pointer font-medium">Saved group and schema</summary>
                <p className="text-sm text-slate-500 my-3">Shown as stored. The original version did not capture a schema snapshot for every session.</p>
                <OriginalJson value={record.group ?? record.record.sharedGroupData ?? null} /></details>
            </>}
          </section>
        </div>}
    </div>
  </div>;
}
