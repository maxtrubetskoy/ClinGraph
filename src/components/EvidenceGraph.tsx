import { formatAttributeValue } from '../utils/attributeValues';
import { isProcedureReferenceValue } from '../utils/procedureReferences';
import { isTrajectoryValue } from '../utils/trajectory';
import { observationStatusReview } from '../utils/observationStatus';
import { mentionRoleLabel, mentionContextLabel } from '../utils/mentionContext';
import { formatResolvedTime, resolveTemporal } from '../utils/temporal';
import type { TemporalValue } from '../utils/temporal';
import { useMemo } from 'react';
import type { AnnotationData } from '../types';
import { buildEvidenceGraph, type EvidenceGraphNode } from '../utils/evidence';

interface Props {
  sessionId: string;
  title: string;
  annotation: AnnotationData;
  encounterTime?: TemporalValue | null;
  onSelectEvidence: (entityId: string | null, mentionId: string | null) => void;
}

export default function EvidenceGraph({ sessionId, title, annotation, encounterTime, onSelectEvidence }: Props) {
  const { graph, nodes, children } = useMemo(() => {
    const graph = buildEvidenceGraph(sessionId, title, annotation, encounterTime);
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const children = new Map<string, string[]>();
    graph.edges.forEach(edge => {
      if (edge.type === 'PART_OF') return;
      if (!children.has(edge.source)) children.set(edge.source, []);
      children.get(edge.source)!.push(edge.target);
    });
    return { graph, nodes, children };
  }, [sessionId, title, annotation, encounterTime]);

  const renderNode = (node: EvidenceGraphNode) => {
    const resolved = node.kind === 'attribute' ? resolveTemporal(node.value, { encounterTime, entities: annotation.entities }) : null;
    const comparisonTime = node.kind === 'attribute' && isTrajectoryValue(node.value)
      ? resolveTemporal(node.value.comparedTo, { encounterTime, entities: annotation.entities }) : null;
    const childNodes = (children.get(node.id) || []).map(id => nodes.get(id)!);
    const attribute = node.kind === 'attribute' ? annotation.entities.find(entity => entity.id === node.entityId)?.attributes?.find(a => a.id === node.attributeId) : undefined;
    const review = attribute ? observationStatusReview(attribute) : null;
    return (
      <li key={node.id} data-node-kind={node.kind} data-node-id={node.id} className="my-2">
        <div className={node.kind === 'attribute'
          ? 'rounded-lg border border-violet-200 bg-violet-50 px-3 py-2'
          : node.kind === 'mention' ? 'rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2'
          : 'rounded-lg border border-slate-200 bg-white px-3 py-2'}>
          <span className="text-2xs uppercase tracking-wide text-slate-500 mr-2">{node.kind}</span>
          {node.kind === 'mention' ? (
            <button className="text-sm text-emerald-800 text-left hover:underline cursor-pointer"
              onClick={() => onSelectEvidence(node.entityId || null, node.mentionId || null)}>
              “{node.label}”
            </button>
          ) : (
            <span className="text-sm font-medium text-slate-800">
              {node.label}{node.kind === 'attribute' && <span className="font-normal"> = {formatAttributeValue(node.value, annotation.entities)}</span>}
            </span>
          )}
          {node.kind === 'attribute' && isProcedureReferenceValue(node.value) && <div className="mt-1 flex flex-wrap gap-2">
            {node.value.procedureIds.map(id => <button key={id} type="button" className="text-xs text-brand-700 hover:underline cursor-pointer"
              onClick={() => onSelectEvidence(id, null)}>Open procedure: {annotation.entities.find(entity => entity.id === id)?.name}</button>)}
          </div>}
          {node.kind === 'encounter' && <p className="text-xs text-slate-500 mt-1">Clinical time: {formatAttributeValue(encounterTime)}</p>}
          {node.kind === 'mention' && <p className="text-xs text-slate-600 mt-1">
            {mentionRoleLabel(node.evidenceRole)} · Certainty: {mentionContextLabel(node.certainty)} · Function: {mentionContextLabel(node.function)}
            {' · '}Temporality: {mentionContextLabel(node.temporality)} · Polarity: {mentionContextLabel(node.polarity)}
          </p>}
          {review && <div className="mt-1 text-xs text-amber-700">
            <p role="note">{review}</p>
            <button type="button" className="mt-1 underline" onClick={() => onSelectEvidence(node.entityId || null, null)}>Review in clinical notes</button>
          </div>}
          {attribute?.migration?.review && <p className="text-xs text-slate-500 mt-1">Legacy value reviewed; original value retained in migration history.</p>}
          {resolved && node.kind === 'attribute' && (node.value as any)?.kind === 'relative' &&
            <p className="text-xs text-violet-600 mt-1">Derived: {formatResolvedTime(resolved)}</p>}
          {comparisonTime && isTrajectoryValue(node.value) && node.value.comparedTo?.kind === 'relative' &&
            <p className="text-xs text-violet-600 mt-1">Comparison time (derived): {formatResolvedTime(comparisonTime)}</p>}
        </div>
        {childNodes.length > 0 && <ul className="ml-4 pl-4 border-l border-slate-300">{childNodes.map(renderNode)}</ul>}
      </li>
    );
  };

  return (
    <section aria-label="Evidence graph" className="evidence-tree h-full overflow-auto p-4 bg-slate-50/70">
      <h3 className="text-sm font-semibold text-slate-800">Evidence Graph</h3>
      <p className="text-xs text-slate-500 mt-1 mb-4">
        Each mention supports its immediate parent. Click a mention to inspect its source text.
        Patient context is local to this case; sessions are not automatically linked across patients.
      </p>
      <ul>{renderNode(graph.nodes[0])}</ul>
      {(annotation.mentions || []).some(mention => !mention.target) && (
        <p className="text-xs text-amber-700 mt-4">Unlinked mentions are retained in the full export but have no evidence edge.</p>
      )}
    </section>
  );
}
