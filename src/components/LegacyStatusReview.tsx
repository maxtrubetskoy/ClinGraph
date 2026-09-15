import { useState } from 'react';
import type { EntityAttribute } from '../types';
import { DIAGNOSTIC_ASSESSMENTS, observationStatusReview } from '../utils/observationStatus';
import type { LegacyStatusResolution } from '../utils/legacyStatusReview';
import { formatAttributeValue } from '../utils/attributeValues';

interface Props {
  attribute: EntityAttribute;
  assessment?: EntityAttribute;
  evidenceCount: number;
  readOnly?: boolean;
  editing?: boolean;
  onResolve: (resolution: LegacyStatusResolution) => void | Promise<void>;
}

const labels: Record<string, string> = {
  unassigned: 'Unassigned — insufficient evidence', supported: 'Supported — finding affirmed',
  suspected: 'Suspected', not_suspected: 'Not suspected — no current basis for suspicion',
  absent: 'Absent — stated absence or denial', ruled_out: 'Ruled out — explicit diagnostic exclusion',
  indeterminate: 'Indeterminate — explicitly inconclusive'
};

export default function LegacyStatusReview({ attribute, assessment, evidenceCount, readOnly, editing, onResolve }: Props) {
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const warning = observationStatusReview(attribute);
  if (!warning) return null;
  const canKeep = attribute.id !== assessment?.id;
  const mapping = choice.startsWith('assessment:');
  const disabled = readOnly || editing || saving;
  return (
    <section aria-label={`Legacy status review for ${attribute.name}`} data-testid={`legacy-status-review-${attribute.id}`}
      className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 space-y-2"
      onClick={event => event.stopPropagation()}>
      <p role="note">{warning}</p>
      <p>Preserved field: <strong>{attribute.name}</strong>. Current diagnostic assessment: <strong>{formatAttributeValue(assessment?.value)}</strong>.</p>
      {!readOnly && <>
        <label className="block font-semibold">
          Resolve this legacy value
          <select aria-label={`Legacy review action for ${attribute.name}`} value={choice} disabled={disabled}
            onChange={event => { setChoice(event.target.value); setError(''); }}
            className="block w-full mt-1 p-1.5 rounded border border-amber-300 bg-white text-xs">
            <option value="">Choose after reviewing the source evidence</option>
            {canKeep && <option value="keep-context">Keep current assessment; retain legacy value as historical context</option>}
            {assessment && DIAGNOSTIC_ASSESSMENTS.map(value => <option key={value} value={`assessment:${value}`}>Set assessment: {labels[value]}</option>)}
          </select>
        </label>
        {mapping && <p>
          This will set diagnostic assessment to <strong>{labels[choice.slice('assessment:'.length)]}</strong>
          {canKeep ? ` and move ${evidenceCount} evidence link(s) from this legacy field to that assessment.` : '.'}
          {' '}The original value and source spans remain preserved. Other legacy fields are not resolved automatically.
        </p>}
        {choice === 'keep-context' && <p>Marks only this legacy field as reviewed. The current assessment and all evidence links stay unchanged.</p>}
        {editing && <p>Save or cancel the entity edit before resolving this legacy value.</p>}
        {error && <p role="alert" className="text-rose-700">{error}</p>}
        <button type="button" disabled={disabled || !choice} className="rounded bg-amber-800 text-white px-2 py-1 text-xs disabled:opacity-40"
          onClick={async () => {
            if (!choice || disabled) return;
            setSaving(true); setError('');
            try {
              await onResolve(choice === 'keep-context' ? { kind: 'keep-context' } : { kind: 'assessment', value: choice.slice('assessment:'.length) });
            } catch (error) { setError(error instanceof Error ? error.message : 'Could not save the review'); }
            finally { setSaving(false); }
          }}>{saving ? 'Saving review…' : 'Resolve legacy status'}</button>
      </>}
    </section>
  );
}
