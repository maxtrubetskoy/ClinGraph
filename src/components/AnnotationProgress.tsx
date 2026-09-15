import { Check, Circle, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react';
import type { AnnotationProgress as Progress } from '../types';

const states = {
  complete: { label: 'Complete', Icon: Check, style: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  in_progress: { label: 'In progress', Icon: LoaderCircle, style: 'border-sky-200 bg-sky-50 text-sky-700' },
  skipped: { label: 'Skipped due to an error', Icon: CircleAlert, style: 'border-amber-200 bg-amber-50 text-amber-800' },
  pending: { label: 'Pending', Icon: Circle, style: 'border-slate-200 bg-slate-50 text-slate-500' },
};

// Diagnostics use zero-based indices; the interface numbers utterances from one.
const errorDetail = (error?: string) => error?.replace(/^Mention extraction failed for utterance \d+: /, '')
  .replace(/for utterance (\d+)/g, (_, index) => `for utterance ${Number(index) + 1}`);

export default function AnnotationProgress({ progress, encounterType = 'dialogue' }: {
  progress: Progress; encounterType?: 'dialogue' | 'note';
}) {
  const total = progress.utterances.length;
  const complete = progress.utterances.filter(item => item.status === 'complete').length;
  const skipped = progress.utterances.filter(item => item.status === 'skipped').length;
  const inProgress = progress.utterances.filter(item => item.status === 'in_progress').length;
  const pending = total - complete - skipped - inProgress;
  const running = !['complete', 'failed'].includes(progress.stage);
  const unit = encounterType === 'note' ? 'Segment' : 'Utterance';
  const stage = progress.stage === 'preparing' ? 'Preparing transcript…'
    : progress.stage === 'extracting' ? `Annotating ${unit.toLowerCase()}s…`
    : progress.stage === 'clustering' ? 'Organizing clinical entities…'
    : progress.stage === 'failed' ? 'AI annotation failed'
    : skipped ? `AI annotation finished with skipped ${unit.toLowerCase()}s` : 'AI annotation complete';
  const summary = `${complete} complete, ${inProgress} in progress, ${skipped} skipped due to an error, ${pending} ${progress.stage === 'failed' ? 'not processed' : 'pending'}`;

  return (
    <section aria-label="AI annotation progress" className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-brand-600" />
          <span>AI annotation</span>
        </div>
        <span className="text-xs text-slate-500">{complete + skipped} / {total} {unit.toLowerCase()}s processed</span>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 text-xs text-slate-600">
        {running && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin text-sky-600" />}
        <span>{stage}</span><span className="sr-only">. {summary}</span>
      </div>
      {total > 0 && <>
        <div role="progressbar" aria-label={`${unit} processing`} aria-valuemin={0} aria-valuemax={total}
          aria-valuenow={complete + skipped} aria-valuetext={summary} className="flex h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="bg-emerald-500 transition-[width]" style={{ width: `${complete / total * 100}%` }} />
          <div className="bg-amber-400 transition-[width]" style={{ width: `${skipped / total * 100}%` }} />
          <div className="bg-sky-400 motion-safe:animate-pulse transition-[width]" style={{ width: `${inProgress / total * 100}%` }} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          {Object.entries(states).map(([status, { Icon, label, style }]) => {
            const count = { complete, in_progress: inProgress, skipped, pending }[status];
            return <span key={status} className={`inline-flex items-center gap-1.5 ${style.split(' ').at(-1)}`}>
              <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${status === 'in_progress' && running ? 'motion-safe:animate-spin' : ''}`} />
              {count} {status === 'pending' && progress.stage === 'failed' ? 'not processed' : label.toLowerCase()}
            </span>;
          })}
        </div>
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer font-medium hover:text-slate-900">{unit} details</summary>
          <ol aria-label={`${unit} statuses`} className="mt-3 flex max-h-48 flex-wrap gap-2 overflow-y-auto p-1">
            {progress.utterances.map(item => {
              const { Icon, label, style } = states[item.status];
              const text = `${unit} ${item.lineIndex + 1}: ${item.status === 'pending' && progress.stage === 'failed' ? 'Not processed' : label}${item.error ? `. ${errorDetail(item.error)}` : ''}`;
              return <li key={item.lineIndex} tabIndex={0} aria-label={text} title={text}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-400 ${style}`}>
                <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${item.status === 'in_progress' ? 'motion-safe:animate-spin' : ''}`} />
                <span aria-hidden="true">{item.lineIndex + 1}</span>
              </li>;
            })}
          </ol>
          {skipped > 0 && <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-amber-800">
            {progress.utterances.filter(item => item.status === 'skipped').map(item => (
              <li key={item.lineIndex}>{unit} {item.lineIndex + 1}: {errorDetail(item.error) || 'Extraction failed after retries.'}</li>
            ))}
          </ul>}
        </details>
      </>}
      {skipped > 0 && <p className="text-xs text-amber-800">Skipped {unit.toLowerCase()}s could not be annotated after retries. Review them manually or run AI annotation again.</p>}
      {progress.error && <p className="text-xs text-rose-700">{errorDetail(progress.error)}</p>}
    </section>
  );
}
