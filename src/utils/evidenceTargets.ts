import type { EvidenceTarget, Mention } from '../types';

/** Single-target records remain readable without rewriting existing annotations. */
export function getMentionTargets(mention: Mention): EvidenceTarget[] {
  if (mention.targets !== undefined) {
    if (!Array.isArray(mention.targets)) throw new Error('Mention targets must be an array');
    if (mention.target != null) throw new Error('Shared mentions must not also specify a singular target');
    return mention.targets;
  }
  return mention.target == null ? [] : [mention.target];
}

export const evidenceTargetKey = (target: EvidenceTarget) => JSON.stringify([
  target.entityId, target.kind, target.kind === 'attribute' ? target.attributeId : null
]);

/** Replace links explicitly, preserving the source identity and all discourse context. */
export function setMentionTargets(mention: Mention, targets: EvidenceTarget[]): Mention {
  const owners = new Set<string>();
  for (const target of targets) {
    if (!target || !['entity', 'attribute'].includes(target.kind) || typeof target.entityId !== 'string' || !target.entityId ||
      (target.kind === 'attribute' && (typeof target.attributeId !== 'string' || !target.attributeId))) throw new Error('Invalid evidence target');
    if (owners.has(target.entityId)) throw new Error('A mention can have only one evidence target per entity');
    owners.add(target.entityId);
  }
  const { supportedAttribute, targets: previousTargets, ...rest } = mention;
  const target = targets.length === 1 ? { ...targets[0] } : null;
  return { ...rest, target, entityId: target?.entityId ?? null,
    ...(targets.length > 1 ? { targets: targets.map(t => ({ ...t })) } : {}) };
}

export function isEntityEvidence(mention: Mention, entityId: string): boolean {
  return getMentionTargets(mention).some(t => t.kind === 'entity' && t.entityId === entityId);
}
export function isAttributeEvidence(mention: Mention, attributeId: string, entityId?: string): boolean {
  return getMentionTargets(mention).some(t => t.kind === 'attribute' && t.attributeId === attributeId && (!entityId || t.entityId === entityId));
}
export function mentionLinksToEntity(mention: Mention, entityId: string | null): boolean {
  return !!entityId && getMentionTargets(mention).some(t => t.entityId === entityId);
}
export function retainMentionEntities(mention: Mention, entityIds: Set<string>): Mention {
  return setMentionTargets(mention, getMentionTargets(mention).filter(t => entityIds.has(t.entityId)));
}
