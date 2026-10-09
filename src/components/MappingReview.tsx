import type { AnnotationData } from '../types';

export default function MappingReview({ annotation }: { annotation: AnnotationData }) {
  const issues = annotation.mappingIssues || [];
  if (!issues.length) return null;
  const unlinked = (annotation.mentions || []).filter(mention => !mention.target).length;
  return (
    <section aria-label="AI mapping review" className="xl:col-span-12 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <p className="font-semibold">AI mapping saved with {issues.length} {issues.length === 1 ? 'warning' : 'warnings'}</p>
      <p className="mt-1">Valid annotations and all extracted mentions were kept. {unlinked} {unlinked === 1 ? 'mention is' : 'mentions are'} currently unlinked.</p>
      <details className="mt-3">
        <summary className="cursor-pointer font-medium">Review mapping warnings</summary>
        <p className="mt-2 text-xs">This report records the last mapping run and remains available after manual corrections. Unresolved values and unlinked mentions can be reviewed in the annotations below.</p>
        <ul className="mt-3 max-h-80 space-y-3 overflow-y-auto">
          {issues.map((issue, index) => {
            const mention = annotation.mentions?.find(m => m.id === issue.mentionId);
            return <li key={index} className="rounded-lg border border-amber-200 bg-white/70 p-3">
              <p className="font-medium">{[issue.entityName || issue.entityId, issue.attributeName,
                mention ? `“${mention.textSpan.text}” (segment ${mention.textSpan.lineIndex + 1}, ${mention.id})` : issue.mentionId].filter(Boolean).join(' · ') || 'Entity mapping'}</p>
              <p className="mt-1">{issue.message}</p>
              {issue.originalValue !== undefined && <details className="mt-2 text-xs">
                <summary className="cursor-pointer">Original model value</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words">{JSON.stringify(issue.originalValue, null, 2)}</pre>
              </details>}
            </li>;
          })}
        </ul>
      </details>
    </section>
  );
}
