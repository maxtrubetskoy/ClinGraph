import type { Mention } from '../types';

export const MENTION_EVIDENCE_ROLES = ['unassigned', 'reference', 'claim'] as const;
export type MentionEvidenceRole = typeof MENTION_EVIDENCE_ROLES[number];

/** Creation defaults only: an explicit saved value (including unassigned) wins. */
export function mentionContextDefaults(role?: MentionEvidenceRole) {
  return role === 'reference'
    ? { polarity: 'neutral', temporality: 'not_applicable', certainty: 'not_applicable', function: 'not_applicable' } as const
    : { polarity: 'unassigned', temporality: 'unassigned', certainty: 'unassigned', function: 'unassigned' } as const;
}

export function mentionRoleLabel(role?: MentionEvidenceRole): string {
  return role === 'reference' ? 'Name / reference' : role === 'claim' ? 'Claim evidence' : 'Role unassigned';
}

export function mentionContextLabel(value?: string): string {
  return value === 'not_applicable' ? 'Not applicable' : value === 'explanatory' ? 'General / explanatory' : value || 'unassigned';
}

/** A target identifies WHAT a span supports; the role identifies HOW it supports it.
 * Never guess a legacy mention's role from its target, wording, or old context labels.
 */
export function normalizeMentionContext<T extends Mention>(mention: T): T {
  const evidenceRole = mention.evidenceRole ?? 'unassigned';
  if (!MENTION_EVIDENCE_ROLES.includes(evidenceRole)) throw new Error('Invalid mention evidence role');
  const defaults = mentionContextDefaults(evidenceRole);
  const reference = evidenceRole === 'reference';
  const certainty = reference && (!mention.certainty || mention.certainty === 'unassigned')
    ? 'not_applicable' : mention.certainty || 'unassigned';
  if (reference && certainty !== 'not_applicable') {
    throw new Error('Name/reference mentions cannot carry claim certainty; use not_applicable or change the evidence role to claim');
  }
  return { ...mention, evidenceRole, certainty,
    polarity: mention.polarity || defaults.polarity,
    temporality: mention.temporality || defaults.temporality,
    function: mention.function || defaults.function };
}

/** Explicit user action, not a migration: selecting reference applies reference defaults.
 * Contextual questions/explanations remain useful, but an old assertion default does not.
 */
export function setMentionEvidenceRole(mention: Mention, evidenceRole: MentionEvidenceRole): Mention {
  if (evidenceRole === mention.evidenceRole) return mention;
  if (evidenceRole === 'reference') return { ...mention, evidenceRole, ...mentionContextDefaults('reference'),
    function: !mention.function || ['unassigned', 'asserted'].includes(mention.function) ? 'not_applicable' : mention.function };
  if (evidenceRole === 'claim' && mention.evidenceRole === 'reference') return { ...mention, evidenceRole,
    polarity: mention.polarity === 'neutral' ? 'unassigned' : mention.polarity,
    temporality: mention.temporality === 'not_applicable' ? 'unassigned' : mention.temporality,
    certainty: mention.certainty === 'not_applicable' ? 'unassigned' : mention.certainty,
    function: mention.function === 'not_applicable' ? 'unassigned' : mention.function };
  return { ...mention, evidenceRole };
}

/** Only explicit claims, not names, questions, or unreviewed legacy mentions, inform
 * a patient-assertion summary. Missing labels never imply current/positive/certain.
 */
export function summarizeEntityClaims(mentions: Mention[], entityId: string) {
  const direct = mentions.filter(m => m.target?.kind === 'entity' && m.target.entityId === entityId);
  const claims = direct.filter(m => m.evidenceRole === 'claim' && m.function === 'asserted' && m.experiencer === 'patient');
  const summarize = (field: 'polarity' | 'certainty' | 'temporality') => {
    const counts = new Map<string, number>();
    let notApplicable = 0;
    let unassigned = 0;
    for (const mention of claims) {
      const value = mention[field];
      if (value === 'not_applicable') { notApplicable++; continue; }
      if (!value || value === 'unassigned') { unassigned++; continue; }
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    const emptySummary = notApplicable
      ? unassigned ? `${notApplicable} Not applicable, ${unassigned} unassigned` : 'Not applicable'
      : 'unassigned';
    return { conflict: counts.size > 1, text: [...counts].map(([value, count]) => `${count} ${mentionContextLabel(value)}`).join(', ') || emptySummary };
  };
  return { directCount: direct.length, claimCount: claims.length,
    referenceCount: direct.filter(m => m.evidenceRole === 'reference').length,
    unassignedCount: direct.filter(m => !m.evidenceRole || m.evidenceRole === 'unassigned').length,
    polarity: summarize('polarity'), certainty: summarize('certainty'), temporality: summarize('temporality') };
}
