import TemporalEditor from './TemporalEditor';
import TrajectoryEditor from './TrajectoryEditor';
import { trajectoryError } from '../utils/trajectory';
import LegacyStatusReview from './LegacyStatusReview';
import { resolveLegacyStatus } from '../utils/legacyStatusReview';
import { observationStatusReview } from '../utils/observationStatus';
import { mentionRoleLabel, mentionContextLabel, setMentionEvidenceRole, summarizeEntityClaims, type MentionEvidenceRole } from '../utils/mentionContext';
import { formatAttributeValue } from '../utils/attributeValues';
import ProcedureReferenceEditor from './ProcedureReferenceEditor';
import { temporalError } from '../utils/temporal';
import type { TemporalValue } from '../utils/temporal';
import React, { useState, useEffect, useRef } from 'react';
import { ClinicalCategory, Entity, ClinicalSymptom, ClinicalCondition, ClinicalMedication, ClinicalFollowUp, Relation, ClinicalMeasurement, Mention, AnnotationCategory, AnnotationAttribute, DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema, getPrimaryAttribute, getItemDisplayName } from '../types';
import { Plus, Trash2, Edit2, Check, X, ShieldAlert, Pill, Activity, CalendarCheck, Link2, Beaker, Search, Settings, Tags, Layers, Syringe, Users, ClipboardCheck, FileCode, HeartHandshake } from 'lucide-react';
import { getMentionAttributeName, retargetMention, sameEvidenceTarget } from '../utils/evidence';
import ExportJsonlModal from './ExportJsonlModal';

const mentionFieldLabelClass = 'text-2xs font-semibold text-slate-500 uppercase font-sans';
const mentionFieldSelectClass = 'w-full text-2xs font-semibold bg-white border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-400 cursor-pointer';

interface ClinicalNotesViewProps {
  clinicalNotes?: ClinicalCategory;
  entities: Entity[];
  relations: Relation[];
  mentions?: Mention[];
  onUpdateNotes: (updatedNotes: ClinicalCategory, updatedEntities: Entity[], updatedRelations?: Relation[], updatedMentions?: Mention[]) => void;
  selectedEntityId?: string | null;
  onSelectEntity: (id: string | null) => void;
  selectedMentionId?: string | null;
  onSelectMention?: (id: string | null) => void;
  isReadOnly?: boolean;
  segments?: any[];
  annotationSchema?: AnnotationCategory[];
  encounterType?: 'dialogue' | 'note';
  encounterTime?: TemporalValue | null;
}

export function getCategoryForEntity(ent: Entity, activeSchema: AnnotationCategory[]): AnnotationCategory | null {
  if (!ent || !ent.type) return null;
  const explicitCategory = activeSchema.find(category => category.id === ent.categoryId);
  if (explicitCategory) return explicitCategory;
  const typeLower = (ent.type || '').toLowerCase().trim();
  const nameLower = (ent.name || '').toLowerCase().trim();

  // 0. Speaker / Meta roles are NEVER clinical categories
  const speakerRoles = ['patient', 'patiënt', 'doctor', 'dokter', 'arts', 'huisarts', 'specialist', 'behandelaar', 'zorgverlener', 'verpleegkundige', 'assistent', 'mevrouw', 'meneer', 'dhr', 'mw', 'person', 'persoon'];
  if (speakerRoles.includes(nameLower) || speakerRoles.includes(typeLower) || typeLower === 'person' || typeLower === 'other') {
    return null;
  }

  // 1. Direct match by category ID (e.g. ent.type === "fhir_conditions" or "conditions")
  const directCat = activeSchema.find(c => c.id.toLowerCase() === typeLower);
  if (directCat) {
    return directCat;
  }

  // 2. Normalized match by category ID (without fhir_ or trailing s)
  const normType = typeLower.replace(/^fhir_/, '').replace(/s$/, '');
  const normCat = activeSchema.find(c => {
    const cNorm = c.id.toLowerCase().replace(/^fhir_/, '').replace(/s$/, '');
    return cNorm === normType;
  });
  if (normCat) {
    return normCat;
  }

  // 2b. Check if entity type or name indicates social history / lifestyle status
  const isSocialEntity = typeLower.includes('social') || typeLower.includes('lifestyle') || typeLower.includes('habit') ||
    nameLower.includes('smoke') || nameLower.includes('smoking') || nameLower.includes('tobacco') || nameLower.includes('cigarette') ||
    nameLower.includes('rook') || nameLower.includes('roken') || nameLower.includes('vape') || nameLower.includes('vaping') ||
    nameLower.includes('alcohol') || nameLower.includes('drink') || nameLower.includes('drank') || nameLower.includes('substance') ||
    nameLower.includes('drug') || nameLower.includes('employment') || nameLower.includes('occupation') || nameLower.includes('living') ||
    nameLower.includes('woonsituatie') || nameLower.includes('beroep');

  if (isSocialEntity) {
    const socialCat = activeSchema.find(c => c.id.toLowerCase().includes('social') || (c.displayName || '').toLowerCase().includes('social'));
    if (socialCat) {
      return socialCat;
    }
  }

  // 3. Match by entityType (e.g. Condition, MedicationStatement, Immunization, Procedure, etc.)
  const entityTypeMatches = activeSchema.filter(c => {
    const cTypeNorm = (c.entityType || '').toLowerCase().replace(/^fhir_/, '').replace(/s$/, '');
    return cTypeNorm === normType || (c.entityType || '').toLowerCase() === typeLower;
  });
  if (entityTypeMatches.length === 1) {
    return entityTypeMatches[0];
  } else if (entityTypeMatches.length > 1) {
    if (typeLower === 'observation' || normType === 'observation') {
      if (isSocialEntity) {
        const socialCat = entityTypeMatches.find(c => c.id.toLowerCase().includes('social') || (c.displayName || '').toLowerCase().includes('social'));
        if (socialCat) return socialCat;
      }
      const measCat = entityTypeMatches.find(c => c.id.toLowerCase().includes('observ') || c.id.toLowerCase().includes('meas'));
      if (measCat) return measCat;
    }
    const condCat = activeSchema.find(c => (c.id.toLowerCase().includes('condition') && !c.id.toLowerCase().includes('family')) || ((c.entityType || '').toLowerCase().includes('condition') && !(c.entityType || '').toLowerCase().includes('family')));
    if (condCat && entityTypeMatches.some(c => c.id === condCat.id)) return condCat;
    return entityTypeMatches[0];
  }

  return null;
}

function shouldEntityGoToCategory(ent: Entity, cat: AnnotationCategory, activeSchema: AnnotationCategory[]): boolean {
  if (!ent || !cat) return false;
  const targetCat = getCategoryForEntity(ent, activeSchema);
  return targetCat?.id === cat.id;
}

function isSupportEntity(ent: Entity, activeSchema: AnnotationCategory[]): boolean {
  if (!ent || !ent.type) return false;
  return getCategoryForEntity(ent, activeSchema) === null;
}

// Retrieves an attribute value from a clinical note item safely,
// resolving case differences and equivalent field names, never conflating different status roles.
export function getResolvedAttributeValue(item: Record<string, any>, attr: AnnotationAttribute): any {
  if (!item || !attr) return undefined;

  // 1. Direct match
  if (item[attr.name] !== undefined && item[attr.name] !== null && item[attr.name] !== '') {
    return item[attr.name];
  }

  const targetNameLower = attr.name.toLowerCase();

  // 2. Case-insensitive key match in item
  const keyMatch = Object.keys(item).find(k => k.toLowerCase() === targetNameLower);
  if (keyMatch && item[keyMatch] !== undefined && item[keyMatch] !== null && item[keyMatch] !== '') {
    return item[keyMatch];
  }

  // Temporal roles are not interchangeable: duration must never fill onset.
  if (attr.type === 'temporal' || attr.type === 'trajectory' || attr.type === 'procedure-reference') return null;

  // 3. Clinical alias lookup
  const aliasMap: Record<string, string[]> = {
    clinicalstatus: ['clinical_status', 'conditionstatus'],
    status: [],
    verificationstatus: ['verification_status'],
    severity: ['intensity', 'grade'],
    details: ['description', 'notes', 'comment', 'note'],
    description: ['details', 'notes', 'comment', 'note'],
    name: ['title', 'task', 'medication', 'vaccine', 'condition', 'reportName'],
    task: ['name', 'title'],
    title: ['name', 'task'],
    dosage: ['dose', 'amount'],
    action: ['plan', 'instruction'],
    value: ['result', 'measurement', 'val']
  };

  const aliases = aliasMap[targetNameLower] || [];
  for (const alias of aliases) {
    if (item[alias] !== undefined && item[alias] !== null && item[alias] !== '') {
      return item[alias];
    }
    const aliasKey = Object.keys(item).find(k => k.toLowerCase() === alias.toLowerCase());
    if (aliasKey && item[aliasKey] !== undefined && item[aliasKey] !== null && item[aliasKey] !== '') {
      return item[aliasKey];
    }
  }

  return undefined;
}

// Robustly matches a value against a list of select choices case-insensitively,
// and if not present, dynamically includes it in options so existing data is NEVER lost or displayed as unassigned.
export function matchChoiceInsensitive(
  value: any,
  availableChoices: string[],
  fallback = ''
): { selectedValue: string; options: string[] } {
  const choices = Array.isArray(availableChoices) ? [...availableChoices] : [];
  const str = String(value ?? '').trim();
  if (!str) {
    const unassigned = choices.find(c => c.toLowerCase() === 'unassigned') || fallback || choices[0] || '';
    return { selectedValue: unassigned, options: choices };
  }

  const match = choices.find(c => c.toLowerCase() === str.toLowerCase());
  if (match) {
    return { selectedValue: match, options: choices };
  }

  // If choices contains something with slash matching e.g. "None / Denied" vs "none" or "refuted"
  const partialMatch = choices.find(c => {
    const cLower = c.toLowerCase();
    const strLower = str.toLowerCase();
    return cLower.includes(strLower) || strLower.includes(cLower);
  });
  if (partialMatch) {
    return { selectedValue: partialMatch, options: choices };
  }

  // Not in choices: dynamically add to choices so it displays faithfully and doesn't get reset
  choices.push(str);
  return { selectedValue: str, options: choices };
}

export default function ClinicalNotesView({
  clinicalNotes = { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] },
  entities,
  relations = [],
  mentions = [],
  onUpdateNotes,
  selectedEntityId,
  onSelectEntity,
  selectedMentionId = null,
  onSelectMention,
  isReadOnly = false,
  segments = [],
  annotationSchema,
  encounterType = 'dialogue',
  encounterTime
}: ClinicalNotesViewProps) {
  const activeSchema = React.useMemo(() => {
    const base = annotationSchema && annotationSchema.length > 0 ? annotationSchema : DEFAULT_ANNOTATION_SCHEMA;
    return normalizeAnnotationSchema(base);
  }, [annotationSchema]);

  const [editingIndex, setEditingIndex] = useState<{ category: string; index: number } | null>(null);
  const [correctingSpeakerMentionId, setCorrectingSpeakerMentionId] = useState<string | null>(null);

  // Clear Annotations Confirmation State
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showExportJsonlModal, setShowExportJsonlModal] = useState(false);

  const renderAttributeEvidence = (entityId: string) => {
    const entity = entities.find(e => e.id === entityId);
    const linkedAttributes = (entity?.attributes || []).map(attribute => ({
      ...attribute,
      evidence: mentions.filter(m => m.target?.kind === 'attribute' && m.target.attributeId === attribute.id)
    })).filter(attribute => attribute.evidence.length > 0);
    if (!linkedAttributes.length) return null;
    return <div className="mt-2 border-t border-violet-100 pt-2 space-y-2" data-testid={`attribute-evidence-${entityId}`}>
      <p className="text-2xs font-semibold text-violet-700">Attribute evidence</p>
      {linkedAttributes.map(attribute => <div key={attribute.id} className="text-xs">
        <span className="font-semibold">{attribute.name}: </span>
        <span>{formatAttributeValue(attribute.value, entities)}</span>
        <div className="flex flex-wrap gap-1 mt-1">
          {attribute.evidence.map(mention => <button key={mention.id} type="button"
            className="px-2 py-1 rounded border border-violet-200 text-violet-800 bg-violet-50 cursor-pointer"
            onClick={event => { event.stopPropagation(); onSelectEntity(entityId); onSelectMention?.(mention.id); }}>
            “{mention.textSpan.text}”
          </button>)}
        </div>
      </div>)}
    </div>;
  };

  const renderEntityConflictsAndSummary = (entityId: string) => {
    const summary = summarizeEntityClaims(mentions || [], entityId);
    if (!summary.directCount) return null;
    const fields = [['Temporality', summary.temporality], ['Polarity', summary.polarity], ['Certainty', summary.certainty]] as const;
    return (
      <div data-testid={`entity-claim-summary-${entityId}`} className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded-lg text-2xs space-y-1">
        <p className="font-semibold">Direct entity evidence only</p>
        <p>{summary.referenceCount} name/reference · {summary.claimCount} asserted patient claims · {summary.unassignedCount} role unassigned</p>
        {summary.unassignedCount > 0 && <p className="text-amber-700">Unassigned roles are excluded from claim summaries. Existing context labels are retained for review.</p>}
        {summary.claimCount === 0 ? <p className="text-slate-500">No asserted patient-specific entity claims. Attribute evidence does not assert the whole entity.</p> : (
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-1">
            {fields.map(([label, field]) => <span key={label} className={field.conflict ? 'text-amber-700' : 'text-slate-600'}>
              {label}: {field.text}{field.conflict && ' (differing claims)'}
            </span>)}
          </div>
        )}
      </div>
    );
  };

  const renderMentionsSubWindow = (entityId: string) => {
    const entityMentions = (mentions || []).filter(m => m.entityId === entityId);

    if (entityMentions.length === 0) {
      return (
        <div className="mt-3 pt-3 border-t border-slate-100 text-2xs text-slate-500 italic">
          No explicit dialogue or document mentions mapped.
        </div>
      );
    }

    const parentEntity = entities.find(e => e.id === entityId);
    return (
      <div className="mt-3 pt-3 border-t border-slate-100 space-y-3 animate-fadeIn">
        <div className="text-2xs font-semibold text-slate-500 uppercase font-sans tracking-wider flex items-center justify-between">
          <span>Entity and attribute evidence ({entityMentions.length})</span>
          <span className="text-2xs text-brand-500 font-medium">Click a mention card to trace in transcript</span>
        </div>

        <div className="space-y-2.5">
          {entityMentions.map((mention, mIdx) => {
            const isMentionSelected = selectedMentionId === mention.id;
            const segment = segments?.find((s, idx) => {
              if (mention.segmentId && s.id === mention.segmentId) return true;
              if (mention.textSpan?.segmentId && s.id === mention.textSpan.segmentId) return true;
              if (idx === mention.textSpan?.lineIndex) {
                if (!mention.textSpan?.text || s.text.toLowerCase().includes(mention.textSpan.text.toLowerCase())) {
                  return true;
                }
              }
              return false;
            }) || (mention.textSpan?.text ? segments?.find(s => s.text.toLowerCase().includes(mention.textSpan.text.toLowerCase())) : undefined);
            const resolvedLineIndex = segment && segments ? segments.indexOf(segment) : mention.textSpan.lineIndex;
            const derivedSpeaker = segment ? segment.speaker.toLowerCase() : 'patient';
            const speakerDisplay = mention.speaker || derivedSpeaker;
            const isSpeakerCorrected = mention.speaker && mention.speaker !== derivedSpeaker;
            const isCorrectingSpeaker = correctingSpeakerMentionId === mention.id;
            const functionDisplay = mention.function || 'unassigned';

            const isExceptionPolarity = mention.polarity && mention.polarity !== 'positive';
            const isExceptionCertainty = mention.certainty && mention.certainty !== 'certain';
            const isExceptionTemporality = mention.temporality && mention.temporality !== 'current';
            const isExceptionExperiencer = mention.experiencer && mention.experiencer !== 'patient';

            const handleAttributeChange = (field: 'speaker' | 'polarity' | 'certainty' | 'temporality' | 'experiencer' | 'function' | 'evidenceRole', value: string) => {
              if (isReadOnly) return;
              const updatedMentions = (mentions || []).map(m => {
                if (m.id === mention.id) {
                  if (field === 'evidenceRole') return setMentionEvidenceRole(m, value as MentionEvidenceRole);
                  return { ...m, [field]: value };
                }
                return m;
              });
              onUpdateNotes(clinicalNotes, entities, relations, updatedMentions);
            };

            const handleResetSpeaker = () => {
              if (isReadOnly) return;
              const updatedMentions = (mentions || []).map(m => {
                if (m.id === mention.id) {
                  const { speaker, ...rest } = m;
                  return rest;
                }
                return m;
              });
              onUpdateNotes(clinicalNotes, entities, relations, updatedMentions);
              setCorrectingSpeakerMentionId(null);
            };

            const handleDeleteThisMention = (e: React.MouseEvent) => {
              e.stopPropagation();
              if (isReadOnly) return;
              const updatedMentions = (mentions || []).filter(m => m.id !== mention.id);
              if (selectedMentionId === mention.id && onSelectMention) {
                onSelectMention(null);
              }
              onUpdateNotes(clinicalNotes, entities, relations, updatedMentions);
            };

            return (
              <div
                key={mention.id || mIdx}
                id={`mention-card-${mention.id}`}
                className={`border rounded-lg p-2.5 space-y-2 transition-all duration-200 cursor-pointer hover:border-brand-300 hover:bg-brand-50/10 group ${
                  isMentionSelected
                    ? 'bg-brand-50/80 border-brand-500 ring-2 ring-brand-100 shadow-sm'
                    : 'bg-slate-50/80 border-slate-150'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onSelectMention) {
                    onSelectMention(mention.id === selectedMentionId ? null : mention.id);
                  }
                }}
              >
                {isMentionSelected ? (
                  <>
                    {/* Header with segment reference and Delete action */}
                    <div className="flex items-center justify-between text-2xs gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-slate-500 bg-slate-200/60 px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse"></span>
                          {encounterType === 'note' ? `Section ${resolvedLineIndex + 1}` : `Segment U-${resolvedLineIndex}`}
                        </span>
                        <span className="font-semibold italic text-slate-700 truncate" title={mention.textSpan.text}>
                          "{mention.textSpan.text}"
                        </span>
                      </div>
                      {!isReadOnly && (
                        <button
                          type="button"
                          onClick={handleDeleteThisMention}
                          className="flex items-center gap-1 text-2xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200/80 px-2 py-0.5 rounded transition-all cursor-pointer shrink-0"
                          title="Delete this specific mention highlight (retains parent entity)"
                        >
                          <Trash2 className="w-3 h-3 text-rose-500" />
                          <span>Delete Mention</span>
                        </button>
                      )}
                    </div>

                    {/* Speaker Info Bar (Static by default, editable on secondary action) */}
                    {encounterType !== 'note' && (
                      <div className="flex items-center justify-between text-2xs bg-slate-100/80 px-2 py-1 rounded-md" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5 text-slate-600">
                          <span className="font-semibold uppercase tracking-wider text-2xs text-slate-500 font-sans">Speaker:</span>
                          {isCorrectingSpeaker ? (
                            <select
                              value={(mention.speaker || derivedSpeaker || 'unassigned').toLowerCase()}
                              onChange={(e) => {
                                handleAttributeChange('speaker', e.target.value);
                                setCorrectingSpeakerMentionId(null);
                              }}
                              className="text-2xs font-semibold bg-white border border-slate-300 rounded px-1.5 py-0.5 text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-400"
                            >
                              <option value="unassigned">Unassigned</option>
                              <option value="patient">Patient (derived)</option>
                              <option value="doctor">Doctor</option>
                              <option value="relative">Relative</option>
                              <option value="other">Other</option>
                            </select>
                          ) : (
                            <span className="font-semibold text-slate-800 capitalize flex items-center gap-1">
                              {speakerDisplay}
                              {isSpeakerCorrected && (
                                <span className="text-2xs text-brand-500 font-medium normal-case bg-brand-50 px-1 py-0.2 rounded font-mono">
                                  (corrected)
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {!isCorrectingSpeaker && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setCorrectingSpeakerMentionId(mention.id);
                              }}
                              className="text-2xs text-brand-600 hover:text-brand-800 font-semibold underline cursor-pointer"
                            >
                              Correct Speaker
                            </button>
                          )}
                          {isSpeakerCorrected && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleResetSpeaker();
                              }}
                              className="text-2xs text-rose-500 hover:text-rose-700 font-semibold underline cursor-pointer"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="rounded-md border border-brand-100 bg-white p-2 space-y-1" onClick={e => e.stopPropagation()}>
                      <label className="flex flex-col gap-0.5">
                        <span className={mentionFieldLabelClass}>Evidence role</span>
                        <select aria-label={`Evidence role for ${mention.textSpan.text}`}
                          value={mention.evidenceRole || 'unassigned'} disabled={isReadOnly}
                          onChange={event => handleAttributeChange('evidenceRole', event.target.value)}
                          className={`${mentionFieldSelectClass} ${
                            !mention.evidenceRole || mention.evidenceRole === 'unassigned'
                              ? 'border-dashed border-slate-300 text-slate-500 bg-slate-50/50 italic'
                              : 'border-slate-200 text-slate-700'
                          }`}>
                          <option value="unassigned">Unassigned — not yet annotated</option>
                          <option value="reference">Name / reference — identifies what is discussed</option>
                          <option value="claim">Claim evidence — supports a statement or assessment</option>
                        </select>
                      </label>
                      <p className="text-2xs text-slate-500">
                        {mention.evidenceRole === 'reference'
                          ? 'This span identifies a referent, not a finding. Defaults: neutral polarity and not-applicable temporality/claim certainty. Function may describe the surrounding question without making the name itself future or asserting a result.'
                          : mention.evidenceRole === 'claim'
                          ? 'Certainty describes the speaker’s commitment to this claim, not annotation confidence. An uncertain assessment can still be asserted. Context applies only to the evidence target below.'
                          : 'Choose the role explicitly. Existing labels are retained; an unassigned role is not treated as a clinical assertion.'}
                      </p>
                    </div>

                    {/* Responsive attributes layout - wraps cleanly on narrow sidebars */}
                    <div className="flex flex-wrap gap-2" onClick={e => e.stopPropagation()}>
                      {/* Polarity */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className={mentionFieldLabelClass}>Polarity</span>
                        <select
                          aria-label={`Polarity for ${mention.textSpan.text}`}
                          value={(mention.polarity || 'unassigned').toLowerCase()}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('polarity', e.target.value)}
                          className={`${mentionFieldSelectClass} ${
                            (mention.polarity || '').toLowerCase() === 'negative'
                              ? 'border-rose-200 text-rose-700 bg-rose-50/10 font-semibold'
                              : (mention.polarity || '').toLowerCase() === 'unassigned' || !mention.polarity
                              ? 'border-dashed border-slate-300 text-slate-500 bg-slate-50/50 italic'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="unassigned">Unassigned</option>
                          <option value="positive">Positive</option>
                          <option value="negative">Negative</option>
                          <option value="neutral">Neutral</option>
                        </select>
                      </div>

                      {/* Certainty */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className={mentionFieldLabelClass}>Certainty</span>
                        <select
                          aria-label={`Claim certainty for ${mention.textSpan.text}`}
                          value={(mention.certainty || 'unassigned').toLowerCase()}
                          disabled={isReadOnly || mention.evidenceRole === 'reference'}
                          onChange={(e) => handleAttributeChange('certainty', e.target.value)}
                          className={`${mentionFieldSelectClass} ${
                            (mention.certainty || '').toLowerCase() === 'uncertain' || (mention.certainty || '').toLowerCase() === 'hypothetical'
                              ? 'border-amber-200 text-amber-700 bg-amber-50/10 font-semibold'
                              : (mention.certainty || '').toLowerCase() === 'unassigned' || !mention.certainty
                              ? 'border-dashed border-slate-300 text-slate-500 bg-slate-50/50 italic'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="unassigned">Unassigned</option>
                          <option value="not_applicable">Not applicable — no certainty judgment</option>
                          <option value="certain">Certain</option>
                          <option value="uncertain">Uncertain</option>
                          <option value="hypothetical">Hypothetical</option>
                        </select>
                      </div>

                      {/* Temporality */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className={mentionFieldLabelClass}>Temporality</span>
                        <select
                          aria-label={`Temporality for ${mention.textSpan.text}`}
                          title="Time of the supported claim, not the surrounding utterance. Not applicable means no clinical time applies; unassigned means not yet annotated."
                          value={(mention.temporality || 'unassigned').toLowerCase()}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('temporality', e.target.value)}
                          className={`${mentionFieldSelectClass} ${
                            (mention.temporality || '').toLowerCase() === 'past' || (mention.temporality || '').toLowerCase() === 'future'
                              ? 'border-blue-200 text-blue-700 bg-blue-50/10 font-semibold'
                              : (mention.temporality || '').toLowerCase() === 'unassigned' || !mention.temporality
                              ? 'border-dashed border-slate-300 text-slate-500 bg-slate-50/50 italic'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="unassigned">Unassigned</option>
                          <option value="not_applicable">Not applicable — no claim time</option>
                          <option value="current">Current</option>
                          <option value="past">Past / History</option>
                          <option value="future">Future</option>
                        </select>
                      </div>

                      {/* Experiencer */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className={mentionFieldLabelClass}>Experiencer</span>
                        <select
                          aria-label={`Experiencer for ${mention.textSpan.text}`}
                          value={(mention.experiencer || 'unassigned').toLowerCase()}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('experiencer', e.target.value)}
                          className={`${mentionFieldSelectClass} ${
                            (mention.experiencer || '').toLowerCase() === 'unassigned' || !mention.experiencer
                              ? 'border-dashed border-slate-300 text-slate-500 bg-slate-50/50 italic'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="unassigned">Unassigned</option>
                          <option value="patient">Patient</option>
                          <option value="family">Family</option>
                          <option value="other">Other</option>
                        </select>
                      </div>

                      {/* Mention Function */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className={mentionFieldLabelClass}>Speech function</span>
                        <select
                          aria-label={`Speech function for ${mention.textSpan.text}`}
                          value={(mention.function || 'unassigned').toLowerCase()}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('function', e.target.value)}
                          className={`${mentionFieldSelectClass} ${
                            (mention.function || '').toLowerCase() === 'questioned'
                              ? 'border-amber-200 text-amber-700 bg-amber-50/10 font-semibold'
                              : (mention.function || '').toLowerCase() === 'hypothetical'
                              ? 'border-purple-200 text-purple-700 bg-purple-50/10 font-semibold'
                              : (mention.function || '').toLowerCase() === 'explanatory'
                              ? 'border-slate-350 text-slate-700 bg-slate-50/10 font-semibold'
                              : (mention.function || '').toLowerCase() === 'unassigned' || !mention.function
                              ? 'border-dashed border-slate-300 text-slate-500 bg-slate-50/50 italic'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="unassigned">Unassigned</option>
                          <option value="not_applicable">Not applicable — no speech act to label</option>
                          <option value="asserted">Asserted</option>
                          <option value="questioned">Questioned</option>
                          <option value="hypothetical">Hypothetical</option>
                          <option value="explanatory">General/explanatory</option>
                        </select>
                      </div>

                      <div className="flex flex-col gap-0.5 flex-1 min-w-[160px]">
                        <span className={mentionFieldLabelClass}>Evidence target</span>
                        <select
                          aria-label={`Evidence target for ${mention.textSpan.text}`}
                          value={mention.target?.kind === 'attribute' ? mention.target.attributeId : '__entity__'}
                          disabled={isReadOnly}
                          onChange={event => {
                            const target = event.target.value === '__entity__'
                              ? { kind: 'entity' as const, entityId }
                              : { kind: 'attribute' as const, entityId, attributeId: event.target.value };
                            onUpdateNotes(clinicalNotes, entities, relations,
                              mentions.map(m => m.id === mention.id ? retargetMention(m, target) : m));
                          }}
                          className={`${mentionFieldSelectClass} border-slate-200 text-slate-700`}
                        >
                          <option value="__entity__">Entity itself</option>
                          {(parentEntity?.attributes || []).map(attribute => (
                            <option key={attribute.id} value={attribute.id}>
                              {attribute.name}: {formatAttributeValue(attribute.value, entities)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Apply to All Mentions Action */}
                    <div className="flex justify-end pt-1" onClick={e => e.stopPropagation()}>
                      <button
                        disabled={isReadOnly || !mention.evidenceRole || mention.evidenceRole === 'unassigned'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isReadOnly || !mention.evidenceRole || mention.evidenceRole === 'unassigned') return;
                          const currentPolarity = mention.polarity || 'unassigned';
                          const currentCertainty = mention.certainty || 'unassigned';
                          const currentTemporality = mention.temporality || 'unassigned';
                          const currentExperiencer = mention.experiencer || 'unassigned';
                          const currentFunction = mention.function || 'unassigned';
                          const currentSpeaker = mention.speaker;

                          const updatedMentions = (mentions || []).map(m => {
                            if (sameEvidenceTarget(m, mention) && m.evidenceRole === mention.evidenceRole) {
                              return {
                                ...m,
                                polarity: currentPolarity,
                                certainty: currentCertainty,
                                temporality: currentTemporality,
                                experiencer: currentExperiencer,
                                function: currentFunction,
                                ...(currentSpeaker ? { speaker: currentSpeaker } : {})
                              };
                            }
                            return m;
                          });
                          onUpdateNotes(clinicalNotes, entities, relations, updatedMentions);
                        }}
                        className="flex items-center gap-1 text-2xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 px-2 py-1 rounded transition-colors cursor-pointer"
                      >
                        <Layers className="w-2.5 h-2.5" />
                        Apply context to the same target and role
                      </button>
                    </div>
                  </>
                ) : (
                  /* Collapsed Card view */
                  <div className="flex items-center justify-between text-xs py-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-brand-600 bg-brand-50 px-1.5 py-0.5 rounded-md font-semibold text-2xs">
                        U-{resolvedLineIndex}
                      </span>
                      <span className="text-slate-500 font-medium font-sans select-none">·</span>
                      <span className="text-slate-700 font-semibold capitalize text-2xs">{speakerDisplay}</span>
                      <span className="text-2xs text-brand-700 bg-brand-50 px-1 rounded">{mentionRoleLabel(mention.evidenceRole)}</span>
                      <span className="text-slate-500 font-medium font-sans select-none">·</span>
                      <span className={`font-semibold capitalize text-2xs px-1 py-0.2 rounded ${
                        functionDisplay === 'questioned' ? 'text-amber-600 bg-amber-50' :
                        functionDisplay === 'hypothetical' ? 'text-purple-600 bg-purple-50' :
                        ['explanatory', 'not_applicable'].includes(functionDisplay) ? 'text-slate-600 bg-slate-100 font-medium' :
                        functionDisplay === 'unassigned' ? 'text-slate-500 bg-slate-100 font-medium italic border border-dashed border-slate-300' :
                        'text-emerald-600 bg-emerald-50'
                      }`}>
                        Function: {mentionContextLabel(functionDisplay)}
                      </span>
                      {/* Exception Badges */}
                      {isExceptionPolarity && (
                        <span className={`text-2xs font-semibold px-1 py-0.2 rounded uppercase border ${
                          mention.polarity === 'negative'
                            ? 'bg-rose-50 text-rose-600 border-rose-100'
                            : mention.polarity === 'unassigned'
                            ? 'bg-slate-50 text-slate-500 border-dashed border-slate-300 italic'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}>
                          {mention.polarity}
                        </span>
                      )}
                      {isExceptionCertainty && (
                        <span className={`text-2xs font-semibold px-1 py-0.2 rounded uppercase border ${
                          mention.certainty === 'uncertain' || mention.certainty === 'hypothetical'
                            ? 'bg-amber-50 text-amber-600 border-amber-100'
                            : mention.certainty === 'unassigned'
                            ? 'bg-slate-50 text-slate-500 border-dashed border-slate-300 italic'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}>
                          Certainty: {mentionContextLabel(mention.certainty)}
                        </span>
                      )}
                      {isExceptionTemporality && (
                        <span className={`text-2xs font-semibold px-1 py-0.2 rounded uppercase border ${
                          mention.temporality === 'past' || mention.temporality === 'future'
                            ? 'bg-blue-50 text-blue-600 border-blue-100'
                            : mention.temporality === 'unassigned'
                            ? 'bg-slate-50 text-slate-500 border-dashed border-slate-300 italic'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}>
                          Temporality: {mentionContextLabel(mention.temporality)}
                        </span>
                      )}
                      {isExceptionExperiencer && (
                        <span className={`text-2xs font-semibold px-1 py-0.2 rounded uppercase border ${
                          mention.experiencer === 'other'
                            ? 'bg-orange-50 text-orange-600 border-orange-100'
                            : mention.experiencer === 'unassigned'
                            ? 'bg-slate-50 text-slate-500 border-dashed border-slate-300 italic'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}>
                          {mention.experiencer === 'other' ? 'Other Experiencer' : mention.experiencer}
                        </span>
                      )}
                      {getMentionAttributeName(mention, entities) && (
                        <span className="text-2xs font-semibold px-1.5 py-0.2 rounded font-mono bg-violet-50 text-violet-700 border border-violet-200" title={`Supported Entity Attribute: ${getMentionAttributeName(mention, entities)}`}>
                          attr: {getMentionAttributeName(mention, entities)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-2xs text-slate-500 italic max-w-[140px] truncate select-none block" title={mention.textSpan.text}>
                        "{mention.textSpan.text}"
                      </span>
                      {!isReadOnly && (
                        <button
                          type="button"
                          onClick={handleDeleteThisMention}
                          className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded transition-all cursor-pointer"
                          title="Delete this mention (keeps entity)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const handleClearAllAnnotations = () => {
    const emptyNotes: ClinicalCategory = {
      symptoms: [],
      conditions: [],
      medications: [],
      followUps: [],
      measurements: []
    };
    onUpdateNotes(emptyNotes, [], []);
    onSelectEntity(null);
    setShowClearConfirm(false);
  };

  const prevSelectedMentionRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSelectedMentionRef.current === selectedMentionId) return;
    prevSelectedMentionRef.current = selectedMentionId;
    if (!selectedMentionId) return;

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
      return;
    }

    setTimeout(() => {
      const card = document.getElementById(`mention-card-${selectedMentionId}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  }, [selectedMentionId]);

  // New Relation States
  const [newRelSource, setNewRelSource] = useState<string>('');
  const [newRelType, setNewRelType] = useState<string>('TREATS');
  const [newRelTarget, setNewRelTarget] = useState<string>('');

  useEffect(() => {
    if (selectedEntityId) {
      setNewRelSource(selectedEntityId);
    }
  }, [selectedEntityId]);

  // Auto-synchronize any clinical-type entities from the knowledge graph into the structured clinical notes
  const schemaKeysString = activeSchema.map(c => (clinicalNotes[c.id] || []).length).join(',');

  useEffect(() => {
    if (isReadOnly) return;

    let hasChanges = false;
    const updatedNotes = { ...clinicalNotes };

    // Build a set of all entity IDs already assigned in ANY category of clinicalNotes
    const allAssignedEntityIds = new Set<string>();
    activeSchema.forEach(cat => {
      const items = clinicalNotes[cat.id] || [];
      items.forEach((item: any) => {
        if (item && item.entityId) {
          allAssignedEntityIds.add(item.entityId);
        }
      });
    });

    activeSchema.forEach(cat => {
      const currentItems = clinicalNotes[cat.id] || [];
      const missingItems: any[] = [];

      entities.forEach(ent => {
        // If entity is already assigned in any category, do not auto-inject into another category
        if (allAssignedEntityIds.has(ent.id)) {
          return;
        }

        if (shouldEntityGoToCategory(ent, cat, activeSchema)) {
          const alreadyExists = currentItems.some((s: any) => s.entityId === ent.id);
          if (!alreadyExists) {
            const newItem: any = {
              entityId: ent.id
            };
            cat.attributes.forEach(attr => {
              if (attr.name === 'name' || attr.name === 'task') {
                newItem[attr.name] = ent.name;
              } else if (attr.name === 'details') {
                newItem[attr.name] = ent.description || '';
              } else if (attr.type === 'select') {
                // Defaults are not clinical conclusions; preserve known values without inferring from negation.
                newItem[attr.name] = ent.attributes?.find(a => a.name === attr.name)?.value
                  ?? attr.choices?.[0] ?? 'Unassigned';
              } else if (attr.type === 'boolean') {
                newItem[attr.name] = false;
              } else if (attr.type === 'procedure-reference') {
                newItem[attr.name] = ent.attributes?.find(a => a.name === attr.name)?.value ?? null;
              } else {
                newItem[attr.name] = '';
              }
            });
            missingItems.push(newItem);
            allAssignedEntityIds.add(ent.id);
            hasChanges = true;
          }
        }
      });

      if (missingItems.length > 0) {
        updatedNotes[cat.id] = [...currentItems, ...missingItems];
      }
    });

    if (hasChanges) {
      onUpdateNotes(updatedNotes, entities);
    }
  }, [
    entities,
    schemaKeysString,
    onUpdateNotes,
    isReadOnly,
    activeSchema
  ]);

  const handleAddRelation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRelSource || !newRelType || !newRelTarget) return;
    if (newRelSource === newRelTarget) {
      alert("Source and Target cannot be the same entity.");
      return;
    }

    const newRelation: Relation = {
      id: `r_user_${Date.now()}`,
      source: newRelSource,
      target: newRelTarget,
      type: newRelType.toUpperCase()
    };

    const updatedRelations = [...relations, newRelation];
    onUpdateNotes(clinicalNotes, entities, updatedRelations);

    // Reset target but keep source
    setNewRelTarget('');
  };

  const handleDeleteRelation = (relId: string) => {
    const updatedRelations = relations.filter(r => r.id !== relId);
    onUpdateNotes(clinicalNotes, entities, updatedRelations);
  };

  // Local Form States
  const [activeForm, setActiveForm] = useState<Record<string, any>>({});
  const structuredFormInvalid = activeSchema.find(cat => cat.id === editingIndex?.category)?.attributes.some(attr =>
    attr.type === 'trajectory' ? trajectoryError(activeForm[attr.name]) :
    attr.type === 'temporal' && typeof activeForm[attr.name] !== 'string' && temporalError(activeForm[attr.name] ?? null));
  const [supportForm, setSupportForm] = useState<Partial<Entity>>({});

  const itemRefs = React.useRef<{ [key: string]: HTMLDivElement | null }>({});

  // UMLS Mapping States
  const [mappingStates, setMappingStates] = useState<{ [key: string]: 'loading' | 'success' | 'error' }>({});
  const [isMappingAll, setIsMappingAll] = useState(false);
  const [mapAllProgress, setMapAllProgress] = useState({ current: 0, total: 0 });

  // Manual UMLS Edit & Search States
  const [activeUmlsEditEntityId, setActiveUmlsEditEntityId] = useState<string | null>(null);
  const [umlsSearchQuery, setUmlsSearchQuery] = useState('');
  const [umlsSearchResults, setUmlsSearchResults] = useState<{ cui: string; name: string }[]>([]);
  const [isUmlsSearching, setIsUmlsSearching] = useState(false);
  const [customUmlsMapping, setCustomUmlsMapping] = useState({
    cui: '',
    preferredName: '',
    rxnorm: '',
    snomed: '',
    icd10: '',
    loinc: ''
  });
  const [fetchCodesLoading, setFetchCodesLoading] = useState(false);
  const [umlsEditError, setUmlsEditError] = useState('');

  const handleOpenUmlsEdit = (entityId: string) => {
    const entity = entities.find(e => e.id === entityId);
    if (!entity) return;

    setActiveUmlsEditEntityId(entityId);
    setUmlsSearchQuery(entity.name);
    setUmlsSearchResults([]);
    setUmlsEditError('');
    setCustomUmlsMapping({
      cui: entity.umlsMapping?.cui || '',
      preferredName: entity.umlsMapping?.preferredName || entity.name,
      rxnorm: entity.umlsMapping?.rxnorm || '',
      snomed: entity.umlsMapping?.snomed || '',
      icd10: entity.umlsMapping?.icd10 || '',
      loinc: entity.umlsMapping?.loinc || ''
    });
  };

  const handleUmlsSearch = async () => {
    if (!umlsSearchQuery.trim()) return;
    setIsUmlsSearching(true);
    setUmlsEditError('');
    setUmlsSearchResults([]);

    try {
      const response = await apiFetch('/api/umls/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: umlsSearchQuery })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned status ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setUmlsSearchResults(data.results);
        if (data.results.length === 0) {
          setUmlsEditError('No matching concepts found in UMLS for your query.');
        }
      } else {
        throw new Error(data.error || 'Failed to fetch search results');
      }
    } catch (err: any) {
      console.error('UMLS Search Error:', err);
      setUmlsEditError(err.message || 'Error searching UMLS database.');
    } finally {
      setIsUmlsSearching(false);
    }
  };

  const handleSelectSearchResult = async (result: { cui: string; name: string }) => {
    setFetchCodesLoading(true);
    setUmlsEditError('');

    // Set CUI and Preferred Name immediately
    setCustomUmlsMapping(prev => ({
      ...prev,
      cui: result.cui,
      preferredName: result.name,
      rxnorm: '',
      snomed: '',
      icd10: '',
      loinc: ''
    }));

    try {
      const response = await apiFetch('/api/umls/concept-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cui: result.cui })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch vocabulary codes (Status ${response.status})`);
      }

      const resJson = await response.json();
      if (resJson.success && resJson.data) {
        setCustomUmlsMapping(prev => ({
          ...prev,
          rxnorm: resJson.data.rxnorm || '',
          snomed: resJson.data.snomed || '',
          icd10: resJson.data.icd10 || '',
          loinc: resJson.data.loinc || ''
        }));
      }
    } catch (err: any) {
      console.error('Error fetching concept codes:', err);
      setUmlsEditError('Concept selected, but failed to retrieve some specific vocabulary codes.');
    } finally {
      setFetchCodesLoading(false);
    }
  };

  const handleSaveCustomUmlsMapping = () => {
    if (!activeUmlsEditEntityId) return;

    // Save mapping to entities
    const updatedEntities = entities.map(ent => {
      if (ent.id === activeUmlsEditEntityId) {
        return {
          ...ent,
          umlsMapping: {
            cui: customUmlsMapping.cui,
            preferredName: customUmlsMapping.preferredName || ent.name,
            rxnorm: customUmlsMapping.rxnorm || undefined,
            snomed: customUmlsMapping.snomed || undefined,
            icd10: customUmlsMapping.icd10 || undefined,
            loinc: customUmlsMapping.loinc || undefined
          }
        };
      }
      return ent;
    });

    onUpdateNotes(clinicalNotes, updatedEntities, relations);

    // Update mappingState to 'success'
    setMappingStates(prev => ({ ...prev, [activeUmlsEditEntityId]: 'success' }));
    setActiveUmlsEditEntityId(null);
  };

  const handleRemoveUmlsMapping = () => {
    if (!activeUmlsEditEntityId) return;

    const updatedEntities = entities.map(ent => {
      if (ent.id === activeUmlsEditEntityId) {
        const { umlsMapping, ...rest } = ent;
        return rest;
      }
      return ent;
    });

    onUpdateNotes(clinicalNotes, updatedEntities, relations);

    // Clear mapping state
    setMappingStates(prev => {
      const copy = { ...prev };
      delete copy[activeUmlsEditEntityId];
      return copy;
    });
    setActiveUmlsEditEntityId(null);
  };

  const handleMapEntity = async (entityId: string, name: string, type: string) => {
    setMappingStates(prev => ({ ...prev, [entityId]: 'loading' }));

    try {
      const response = await apiFetch('/api/umls/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server error ${response.status}`);
      }

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'UMLS mapping failed');
      }

      const umlsMapping = result.data ? {
        cui: result.data.cui,
        preferredName: result.data.preferredName,
        rxnorm: result.data.rxnorm,
        snomed: result.data.snomed,
        icd10: result.data.icd10
      } : {
        cui: "",
        preferredName: name,
        error: "No matching concept found in UMLS"
      };

      // Update the entities list
      const updatedEntities = entities.map(ent => {
        if (ent.id === entityId) {
          return { ...ent, umlsMapping };
        }
        return ent;
      });

      onUpdateNotes(clinicalNotes, updatedEntities, relations);
      setMappingStates(prev => ({ ...prev, [entityId]: 'success' }));
    } catch (err: any) {
      console.error(`Error mapping ${name}:`, err);
      setMappingStates(prev => ({ ...prev, [entityId]: 'error' }));

      // Save error status on entity
      const updatedEntities = entities.map(ent => {
        if (ent.id === entityId) {
          return {
            ...ent,
            umlsMapping: {
              cui: "",
              preferredName: name,
              error: err.message || "Failed to map to UMLS"
            }
          };
        }
        return ent;
      });
      onUpdateNotes(clinicalNotes, updatedEntities, relations);
    }
  };

  const handleMapAllEntities = async () => {
    // Map Symptoms, Conditions, Medications, Measurements, Observations, and Social History
    const mappableTypes = ['Symptom', 'Condition', 'Medication', 'Measurement', 'Observation', 'SocialHistory', 'SocialStatus'];
    const targets = entities.filter(ent => mappableTypes.includes(ent.type) && !ent.umlsMapping?.cui);

    if (targets.length === 0) {
      alert("All clinical entities are already mapped or no mappable entities were found!");
      return;
    }

    setIsMappingAll(true);
    setMapAllProgress({ current: 0, total: targets.length });

    let currentEntities = [...entities];

    for (let i = 0; i < targets.length; i++) {
      const ent = targets[i];
      setMapAllProgress({ current: i + 1, total: targets.length });
      setMappingStates(prev => ({ ...prev, [ent.id]: 'loading' }));

      try {
        const response = await apiFetch('/api/umls/map', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ent.name, type: ent.type })
        });

        if (response.ok) {
          const result = await response.json();
          if (result.success && result.data) {
            const umlsMapping = {
              cui: result.data.cui,
              preferredName: result.data.preferredName,
              rxnorm: result.data.rxnorm,
              snomed: result.data.snomed,
              icd10: result.data.icd10
            };
            currentEntities = currentEntities.map(e => e.id === ent.id ? { ...e, umlsMapping } : e);
            setMappingStates(prev => ({ ...prev, [ent.id]: 'success' }));
          } else {
            const umlsMapping = {
              cui: "",
              preferredName: ent.name,
              error: "No matching concept found in UMLS"
            };
            currentEntities = currentEntities.map(e => e.id === ent.id ? { ...e, umlsMapping } : e);
            setMappingStates(prev => ({ ...prev, [ent.id]: 'error' }));
          }
        } else {
          setMappingStates(prev => ({ ...prev, [ent.id]: 'error' }));
        }
      } catch (err) {
        setMappingStates(prev => ({ ...prev, [ent.id]: 'error' }));
      }
    }

    onUpdateNotes(clinicalNotes, currentEntities, relations);
    setIsMappingAll(false);
  };

  const renderUmlsBadges = (entityId: string, name: string, type: string) => {
    const entity = entities.find(e => e.id === entityId);
    const mapping = entity?.umlsMapping;
    const state = mappingStates[entityId];

    if (state === 'loading' || (mapping && mapping.loading)) {
      return (
        <div className="flex items-center gap-1.5 mt-2 text-2xs text-slate-500 font-mono">
          <span className="w-2.5 h-2.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></span>
          <span>Connecting UMLS...</span>
        </div>
      );
    }

    if (!mapping) {
      return (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMapEntity(entityId, name, type);
            }}
            className="flex items-center gap-1 text-2xs font-semibold text-blue-600 hover:text-blue-700 hover:bg-blue-50 border border-blue-100 px-2 py-0.5 rounded transition-all cursor-pointer bg-white"
          >
            <Link2 className="w-2.5 h-2.5" />
            <span>Map UMLS</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenUmlsEdit(entityId);
            }}
            className="flex items-center gap-1 text-2xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded transition-all cursor-pointer bg-white"
            title="Search or define UMLS codes manually"
          >
            <Search className="w-2.5 h-2.5" />
            <span>Manual Search/Edit</span>
          </button>
        </div>
      );
    }

    if (mapping.error) {
      return (
        <div className="flex flex-col gap-1.5 mt-2">
          <div className="flex items-center justify-between gap-2 p-1.5 bg-rose-50 border border-rose-100 rounded text-2xs text-rose-600 font-medium">
            <div className="flex items-center gap-1 truncate">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 text-rose-500" />
              <span className="truncate">{mapping.error}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMapEntity(entityId, name, type);
              }}
              className="text-2xs text-blue-600 hover:underline font-semibold shrink-0 cursor-pointer bg-transparent border-0"
            >
              Retry
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleOpenUmlsEdit(entityId);
              }}
              className="flex items-center gap-1 text-2xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 px-2 py-0.5 rounded transition-all cursor-pointer bg-white"
            >
              <Search className="w-2.5 h-2.5" />
              <span>Search / Edit Manually</span>
            </button>
          </div>
        </div>
      );
    }

    if (!mapping.cui) {
      return (
        <div className="mt-2 flex items-center justify-between gap-2 bg-slate-50 border border-slate-100 rounded px-1.5 py-1">
          <span className="text-2xs font-mono text-slate-500 italic">No UMLS match found</span>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMapEntity(entityId, name, type);
              }}
              className="text-2xs text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            >
              Re-map
            </button>
            <span className="text-slate-300 text-2xs">|</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleOpenUmlsEdit(entityId);
              }}
              className="text-2xs text-slate-500 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            >
              Search/Edit
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="mt-2 pt-1.5 border-t border-dashed border-slate-100 flex flex-wrap gap-1 items-center" onClick={e => e.stopPropagation()}>
        <span className="text-2xs font-semibold text-slate-500 uppercase tracking-wider mr-1 font-sans">UMLS:</span>

        <a
          href={`https://uts.nlm.nih.gov/uts/umls/concept/${mapping.cui}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-2xs font-mono font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800 border border-slate-200 transition-colors"
          title={`UMLS Concept Unique Identifier (CUI): ${mapping.preferredName}`}
        >
          <span>{mapping.cui}</span>
        </a>

        {mapping.snomed && (
          <a
            href={`https://terminologie.nictiz.nl/art-decor/snomed-ct?conceptId=${mapping.snomed}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-2xs font-mono font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 hover:text-purple-900 border border-purple-100 transition-colors"
            title="SNOMED-CT Code"
          >
            <span>SNOMED: {mapping.snomed}</span>
          </a>
        )}

        {mapping.rxnorm && (
          <a
            href={`https://mor.nlm.nih.gov/RxNav/search?searchBy=NameOrCode&searchTerm=${mapping.rxnorm}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-2xs font-mono font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 hover:bg-sky-100 hover:text-sky-900 border border-sky-100 transition-colors"
            title="RxNorm Code"
          >
            <span>RxNorm: {mapping.rxnorm}</span>
          </a>
        )}

        {mapping.icd10 && (
          <a
            href={`https://icd.who.int/browse10/2019/en#/${mapping.icd10}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-2xs font-mono font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-900 border border-emerald-100 transition-colors"
            title="ICD-10 (Dutch/General) Code"
          >
            <span>ICD-10: {mapping.icd10}</span>
          </a>
        )}

        {mapping.loinc && (
          <a
            href={`https://loinc.org/${mapping.loinc}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-2xs font-mono font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-900 border border-amber-100 transition-colors"
            title="LOINC Code"
          >
            <span>LOINC: {mapping.loinc}</span>
          </a>
        )}

        <div className="flex gap-1.5 ml-auto">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenUmlsEdit(entityId);
            }}
            className="text-2xs text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            title="Edit UMLS codes manually"
          >
            Edit
          </button>
          <span className="text-2xs text-slate-300">|</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMapEntity(entityId, name, type);
            }}
            className="text-2xs text-slate-500 hover:text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            title="Refresh UMLS mapping"
          >
            Re-map
          </button>
        </div>
      </div>
    );
  };

  const prevSelectedEntityRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSelectedEntityRef.current === selectedEntityId) return;
    prevSelectedEntityRef.current = selectedEntityId;
    if (!selectedEntityId) return;

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
      return;
    }

    if (itemRefs.current[selectedEntityId]) {
      itemRefs.current[selectedEntityId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [selectedEntityId]);

  // Triggered when a row is clicked
  const handleItemClick = (entityId: string) => {
    onSelectEntity(entityId === selectedEntityId ? null : entityId);
  }  // Delete Action
  const handleDelete = (category: string, index: number, entityId: string) => {
    const updatedNotes = { ...clinicalNotes };
    if (!updatedNotes[category]) {
      updatedNotes[category] = [];
    }
    updatedNotes[category] = (updatedNotes[category] as any[]).filter((_, idx) => idx !== index);

    // Also clean up references in other categories if any existed
    activeSchema.forEach(cat => {
      if (cat.id !== category && updatedNotes[cat.id]) {
        updatedNotes[cat.id] = (updatedNotes[cat.id] as any[]).filter((item: any) => item.entityId !== entityId);
      }
    });

    // Also remove from general entities array
    const updatedEntities = entities.filter(e => e.id !== entityId);
    const updatedMentions = mentions.filter(m => m.entityId !== entityId);
    const updatedRelations = relations.filter(r => r.source !== entityId && r.target !== entityId);

    onUpdateNotes(updatedNotes, updatedEntities, updatedRelations, updatedMentions);
    if (selectedEntityId === entityId) {
      onSelectEntity(null);
    }
  };

  // Start Editing
  const startEdit = (category: string, index: number, item: any) => {
    setEditingIndex({ category, index });
    if (category === 'support') {
      setSupportForm(item);
    } else {
      const cat = activeSchema.find(c => c.id === category);
      const initialForm = { ...item };
      if (cat) {
        cat.attributes.forEach(attr => {
          const val = (initialForm[attr.name] !== undefined && initialForm[attr.name] !== '')
            ? initialForm[attr.name]
            : getResolvedAttributeValue(initialForm, attr);

          if (val !== undefined && val !== null && val !== '') {
            if (attr.type === 'select' && Array.isArray(attr.choices)) {
              const { selectedValue } = matchChoiceInsensitive(val, attr.choices);
              initialForm[attr.name] = selectedValue;
            } else {
              initialForm[attr.name] = val;
            }
          }
        });

      }
      setActiveForm(initialForm);
    }
  };

  // Cancel Editing
  const cancelEdit = () => {
    setEditingIndex(null);
    setActiveForm({});
    setSupportForm({});
  };

  // Save Editing
  const saveEdit = (category: string, index: number) => {
    if (category !== 'support' && structuredFormInvalid) return;
    const updatedNotes = { ...clinicalNotes };
    const updatedEntities = [...entities];

    if (category === 'support') {
      const supportEnts = entities.filter(ent => isSupportEntity(ent, activeSchema));
      const targetEntity = supportEnts[index];
      if (targetEntity) {
        const entIdx = updatedEntities.findIndex(e => e.id === targetEntity.id);
        if (entIdx > -1) {
          updatedEntities[entIdx] = {
            ...updatedEntities[entIdx],
            name: supportForm.name || targetEntity.name,
            type: supportForm.type || targetEntity.type,
            description: supportForm.description || targetEntity.description || ''
          };
        }
      }
    } else {
      const cat = activeSchema.find(c => c.id === category);
      if (!cat) return;

      const categoryItems = getCategoryItems(cat);
      const currentItem = categoryItems[index];
      if (!currentItem) return;

      const primaryAttr = getPrimaryAttribute(cat);
      // Determine what the user edited as the primary identifier (title, task, medication, vaccine, name, etc.)
      const primaryName =
        (activeForm[primaryAttr.name] !== undefined && activeForm[primaryAttr.name] !== '')
          ? String(activeForm[primaryAttr.name]).trim()
          : (activeForm.name ||
             activeForm.task ||
             activeForm.title ||
             activeForm.medication ||
             activeForm.vaccine ||
             activeForm.condition ||
             activeForm.reportName ||
             activeForm.description ||
             currentItem[primaryAttr.name] ||
             currentItem.name ||
             currentItem.task ||
             currentItem.title ||
             `Updated ${cat.displayName}`);

      const updatedItem = {
        ...currentItem,
        ...activeForm,
        [primaryAttr.name]: primaryName,
        name: primaryName,
      };

      if (primaryAttr.name === 'task' || updatedItem.task !== undefined) {
        updatedItem.task = primaryName;
      }
      if (primaryAttr.name === 'title' || updatedItem.title !== undefined) {
        updatedItem.title = primaryName;
      }

      if (!updatedNotes[category]) updatedNotes[category] = [];
      const noteIdx = (updatedNotes[category] as any[]).findIndex((item: any) => item.entityId === currentItem.entityId);
      if (noteIdx > -1) {
        updatedNotes[category][noteIdx] = updatedItem;
      } else {
        updatedNotes[category].push(updatedItem);
      }

      // Update matching entity in entities list
      const entIdx = updatedEntities.findIndex(e => e.id === updatedItem.entityId);
      if (entIdx > -1) {
        const detailsParts = cat.attributes
          .filter(attr => attr.name !== primaryAttr.name && attr.name !== 'name' && attr.name !== 'task' && attr.name !== 'title')
          .map(attr => {
            const val = updatedItem[attr.name];
            if (val === undefined || val === '' || val === null) return null;
            return `${attr.name}: ${formatAttributeValue(val, entities)}`;
          })
          .filter(Boolean);

        updatedEntities[entIdx] = {
          ...updatedEntities[entIdx],
          name: primaryName,
          type: cat.entityType,
          description: detailsParts.join(' | ') || `Annotated in ${cat.displayName}`
        };
      }
    }

    onUpdateNotes(updatedNotes, updatedEntities);
    cancelEdit();
  };

  const handleDeleteSupport = (entityId: string) => {
    const updatedNotes = { ...clinicalNotes };
    const updatedEntities = entities.filter(e => e.id !== entityId);

    // Also clean up references in clinicalNotes arrays
    activeSchema.forEach(cat => {
      if (updatedNotes[cat.id]) {
        updatedNotes[cat.id] = (updatedNotes[cat.id] as any[]).filter(s => s.entityId !== entityId);
      }
    });

    const updatedMentions = mentions.filter(m => m.entityId !== entityId);
    const updatedRelations = relations.filter(r => r.source !== entityId && r.target !== entityId);

    onUpdateNotes(updatedNotes, updatedEntities, updatedRelations, updatedMentions);
    if (selectedEntityId === entityId) {
      onSelectEntity(null);
    }
  };

  const handleAddNewSupportItem = () => {
    const updatedNotes = { ...clinicalNotes };
    const updatedEntities = [...entities];
    const newId = `e_user_${Date.now()}`;

    updatedEntities.push({
      id: newId,
      name: 'New Person or Attribute',
      type: 'Person',
      description: 'Support person or attribute node'
    });

    onUpdateNotes(updatedNotes, updatedEntities);

    const supportEnts = updatedEntities.filter(ent => isSupportEntity(ent, activeSchema));
    const newIndex = supportEnts.findIndex(e => e.id === newId);
    if (newIndex > -1) {
      setEditingIndex({ category: 'support', index: newIndex });
      setSupportForm({
        name: 'New Person or Attribute',
        type: 'Person',
        description: 'Support person or attribute node'
      });
    }
  };

  // Add Item to Category
  const handleAddNewItem = (category: string) => {
    const updatedNotes = { ...clinicalNotes };
    const updatedEntities = [...entities];
    const newId = `e_user_${Date.now()}`;

    const cat = activeSchema.find(c => c.id === category);
    if (!cat) return;

    const primaryAttr = getPrimaryAttribute(cat);
    const defaultDisplayName = `New ${cat.displayName.endsWith('s') ? cat.displayName.slice(0, -1) : cat.displayName}`;

    const newItem: any = { entityId: newId };
    cat.attributes.forEach(attr => {
      if (attr.name === primaryAttr.name || attr.name === 'name' || attr.name === 'task' || attr.name === 'title') {
        newItem[attr.name] = defaultDisplayName;
      } else if (attr.type === 'select') {
        const unassignedChoice = attr.choices?.find(c => c.toLowerCase() === 'unassigned');
        newItem[attr.name] = unassignedChoice || (attr.choices && attr.choices.length > 0 ? attr.choices[0] : 'unassigned');
      } else if (attr.type === 'boolean') {
        newItem[attr.name] = false;
      } else if (attr.type === 'procedure-reference') {
        newItem[attr.name] = null;
      } else {
        newItem[attr.name] = attr.name.toLowerCase().includes('status') ? 'unassigned' : '';
      }
    });
    newItem[primaryAttr.name] = defaultDisplayName;
    newItem.name = defaultDisplayName;

    if (!updatedNotes[category]) {
      updatedNotes[category] = [];
    }
    updatedNotes[category] = [...(updatedNotes[category] as any[]), newItem];

    const detailsParts = cat.attributes
      .filter(attr => attr.name !== primaryAttr.name && attr.name !== 'name' && attr.name !== 'task' && attr.name !== 'title')
      .map(attr => {
        const val = newItem[attr.name];
        if (val === undefined || val === '' || val === null) return null;
        return `${attr.name}: ${formatAttributeValue(val, entities)}`;
      })
      .filter(Boolean);

    updatedEntities.push({
      id: newId,
      name: defaultDisplayName,
      type: cat.entityType,
      categoryId: cat.id,
      description: detailsParts.join(' | ') || `Added manually to ${cat.displayName}`
    });

    onUpdateNotes(updatedNotes, updatedEntities);

    // Set to editing immediately
    const lastIndex = (updatedNotes[category] as any[]).length - 1;
    startEdit(category, lastIndex, (updatedNotes[category] as any[])[lastIndex]);
  };

  const getCategoryIcon = (catId: string) => {
    const id = catId.toLowerCase();
    if (id.includes('social') || id.includes('lifestyle') || id.includes('habit')) return <HeartHandshake className="w-4.5 h-4.5 text-lime-600" />;
    if (id.includes('symptom') || id.includes('allergy')) return <Activity className="w-4.5 h-4.5 text-amber-600" />;
    if (id.includes('family') || id.includes('history')) return <Users className="w-4.5 h-4.5 text-teal-600" />;
    if (id.includes('condition') || id.includes('disorder') || id.includes('disease')) return <Activity className="w-4.5 h-4.5 text-emerald-600" />;
    if (id.includes('immunization') || id.includes('vaccine')) return <Syringe className="w-4.5 h-4.5 text-orange-600" />;
    if (id.includes('medication') || id.includes('drug') || id.includes('treatment')) return <Pill className="w-4.5 h-4.5 text-brand-600" />;
    if (id.includes('procedure')) return <Activity className="w-4.5 h-4.5 text-violet-600" />;
    if (id.includes('follow') || id.includes('action') || id.includes('task') || id.includes('plan') || id.includes('servicerequest') || id.includes('request')) return <CalendarCheck className="w-4.5 h-4.5 text-rose-600" />;
    if (id.includes('diagnostic') || id.includes('report')) return <ClipboardCheck className="w-4.5 h-4.5 text-fuchsia-600" />;
    if (id.includes('meas') || id.includes('test') || id.includes('lab') || id.includes('vital') || id.includes('observation')) return <Beaker className="w-4.5 h-4.5 text-sky-600" />;
    return <Tags className="w-4.5 h-4.5 text-slate-600" />;
  };

  const getCategoryItems = (cat: AnnotationCategory): any[] => {
    const result: any[] = [];
    const seenEntityIds = new Set<string>();

    const addItems = (itemsList: any[]) => {
      if (!Array.isArray(itemsList)) return;
      itemsList.forEach(item => {
        if (!item) return;
        const eId = item.entityId;
        if (eId) {
          if (seenEntityIds.has(eId)) return;
          seenEntityIds.add(eId);
        }
        const primaryAttr = getPrimaryAttribute(cat);
        const linkedEnt = eId ? entities.find(e => e.id === eId) : null;
        const resolvedName = getItemDisplayName(item, cat, linkedEnt);

        result.push({
          ...item,
          [primaryAttr.name]: item[primaryAttr.name] || resolvedName,
          name: item[primaryAttr.name] || item.name || resolvedName
        });
      });
    };

    if (clinicalNotes && clinicalNotes[cat.id]) {
      addItems(clinicalNotes[cat.id]);
    }

    if (result.length === 0 && clinicalNotes) {
      Object.keys(clinicalNotes).forEach(key => {
        if (key === cat.id) return;
        const keyLower = key.toLowerCase();
        const catIdLower = cat.id.toLowerCase();
        const catEntityTypeLower = (cat.entityType || '').toLowerCase();

        if (
          keyLower === catIdLower ||
          keyLower.includes(catIdLower) ||
          catIdLower.includes(keyLower) ||
          (catEntityTypeLower && keyLower.includes(catEntityTypeLower))
        ) {
          const rawItems = (clinicalNotes as any)[key];
          if (Array.isArray(rawItems)) {
            rawItems.forEach(item => {
              if (!item) return;
              const linkedEnt = item.entityId ? entities.find(e => e.id === item.entityId) : null;
              if (linkedEnt) {
                if (shouldEntityGoToCategory(linkedEnt, cat, activeSchema)) {
                  addItems([item]);
                }
              } else {
                if (keyLower === catIdLower || (catEntityTypeLower && keyLower === catEntityTypeLower)) {
                  addItems([item]);
                }
              }
            });
          }
        }
      });
    }

    (entities || []).forEach(ent => {
      if (ent && ent.id && !seenEntityIds.has(ent.id)) {
        if (shouldEntityGoToCategory(ent, cat, activeSchema)) {
          seenEntityIds.add(ent.id);
          const primaryAttr = getPrimaryAttribute(cat);
          const newItem: any = {
            entityId: ent.id,
            name: ent.name
          };
          newItem[primaryAttr.name] = ent.name;
          if (ent.description) {
            const detailAttr = cat.attributes.find(attr => attr.name === 'details' || attr.name === 'dosage' || attr.name === 'value') || cat.attributes[1];
            if (detailAttr) {
              newItem[detailAttr.name] = ent.description;
            }
          }
          result.push(newItem);
        }
      }
    });

    return result;
  };

  const supportEnts = entities.filter(ent => isSupportEntity(ent, activeSchema));

  return (
    <div className="space-y-4">
      {/* Clinical Workspace Header with Export JSONL & Clear All Buttons */}
      <div className="panel px-4 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4.5 h-4.5 text-slate-500" />
          <h3 className="section-heading">Clinical details</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowExportJsonlModal(true)}
            className="btn btn-secondary"
            title="Export entities, mentions, and relations to JSONL format"
          >
            <FileCode className="w-3.5 h-3.5" />
            <span>Export JSONL</span>
          </button>

          {!isReadOnly && (
            <>
              {showClearConfirm ? (
                <div className="flex items-center gap-1.5 bg-rose-50 border border-rose-100 px-2.5 py-1.5 rounded-lg animate-in fade-in duration-200">
                  <span className="text-2xs text-rose-700 font-medium">Delete all annotations?</span>
                  <button
                    onClick={handleClearAllAnnotations}
                    className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-2xs rounded shadow-sm transition-all cursor-pointer"
                  >
                    Yes, Clear
                  </button>
                  <button
                    onClick={() => setShowClearConfirm(false)}
                    className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-semibold text-2xs rounded transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="px-2.5 py-1.5 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 text-slate-500 border border-slate-200 rounded-lg text-2xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                  title="Delete all clinical annotated entities and relationships"
                >
                  <Trash2 className="w-3.5 h-3.5 text-slate-500 hover:text-rose-500 transition-colors" />
                  <span>Clear All Annotations</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {isReadOnly && (
        <>
          <style dangerouslySetInnerHTML={{__html: `
            button[title*="Delete"],
            button[title*="Edit"],
            button[title*="Add"],
            button:has(.lucide-trash2),
            button:has(.lucide-edit2),
            button:has(.lucide-plus),
            button:has(.lucide-link2),
            form {
              display: none !important;
            }
          `}} />
          <div className="bg-brand-50 border border-brand-100 rounded-xl p-4 text-brand-800 text-xs flex items-start gap-3">
            <ShieldAlert className="w-4 h-4 text-brand-600 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold">Read-Only Mode:</span> This is a shared clinical session. You can explore the interactive knowledge graph and UMLS term mappings, but editing has been disabled. To customize this session, click the <strong className="text-brand-950 font-semibold">"Clone Session"</strong> button at the top right to copy it to your account!
            </div>
          </div>
        </>
      )}
      {/* UMLS Mapping Dashboard Control */}
      <div className="panel p-4 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="p-1.5 bg-brand-50 text-brand-600 rounded-lg shrink-0 mt-0.5">
            <Beaker className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h3 className="section-heading">
              UMLS Terminology Mapping
            </h3>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              Standardize medical concepts with RxNorm, SNOMED-CT, ICD-10, and LOINC.
            </p>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          {isMappingAll ? (
            <div className="flex-1 flex items-center gap-3">
              <div className="flex-1 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-brand-500 h-1.5 transition-all duration-300"
                  style={{ width: `${(mapAllProgress.current / mapAllProgress.total) * 100}%` }}
                ></div>
              </div>
              <span className="text-2xs text-slate-500 font-mono whitespace-nowrap shrink-0">
                {mapAllProgress.current} of {mapAllProgress.total} mapped
              </span>
            </div>
          ) : (
            <>
              <span className="text-2xs text-slate-500 font-mono">
                Automatic concept mapping
              </span>
              <button
                onClick={handleMapAllEntities}
                className="btn btn-secondary"
              >
                <Link2 className="w-3 h-3" />
                <span>Auto-Map All</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Dynamic Schema-Driven Annotation Categories */}
      {activeSchema.map(cat => {
        const items = getCategoryItems(cat);
        const isCatEmpty = items.length === 0;

        return (
          <div key={cat.id} className="panel p-4">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-slate-50 border border-slate-100 rounded-lg">
                  {getCategoryIcon(cat.id)}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{cat.displayName}</h3>
                  <p className="text-2xs text-slate-500 mt-0.5">Annotate details for {cat.displayName.toLowerCase()}</p>
                </div>
              </div>
              {!isReadOnly && (
                <button
                  onClick={() => handleAddNewItem(cat.id)}
                  title={`Add ${cat.displayName.endsWith('s') ? cat.displayName.slice(0, -1) : cat.displayName}`}
                  className="icon-button text-brand-600 bg-brand-50"
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
            </div>

            {isCatEmpty ? (
              <p className="text-xs text-slate-500 italic text-center py-4">No {cat.displayName.toLowerCase()} documented in annotations.</p>
            ) : (
              <div className="space-y-3">
                {items.map((item, idx) => {
                  const isSelected = selectedEntityId === item.entityId;
                  const isEditing = editingIndex?.category === cat.id && editingIndex?.index === idx;

                  // Find primary attribute
                  const primaryAttr = getPrimaryAttribute(cat);
                  const primaryValue = getItemDisplayName(item, cat, item.entityId ? (entities.find(e => e.id === item.entityId)) : null);

                  return (
                    <div
                      key={`${cat.id}-${idx}`}
                      ref={el => { itemRefs.current[item.entityId] = el; }}
                      onClick={() => !isEditing && handleItemClick(item.entityId)}
                      className={`p-3 rounded-xl border transition-all duration-200 group relative ${
                        isEditing
                          ? 'border-brand-400 bg-brand-50/10 ring-2 ring-brand-50'
                          : isSelected
                          ? 'border-brand-400 bg-brand-50/40 shadow-sm'
                          : 'border-slate-150 bg-slate-50/40 hover:border-slate-300 hover:bg-slate-50/80 cursor-pointer'
                      }`}
                    >
                      {(entities.find(entity => entity.id === item.entityId)?.attributes || []).filter(attribute => observationStatusReview(attribute)).map(attribute => {
                        const assessment = entities.find(entity => entity.id === item.entityId)?.attributes?.find(a => a.name.toLowerCase() === 'diagnosticassessment');
                        return <LegacyStatusReview key={attribute.id} attribute={attribute} assessment={assessment}
                          evidenceCount={mentions.filter(m => m.target?.kind === 'attribute' && m.target.entityId === item.entityId && m.target.attributeId === attribute.id).length}
                          readOnly={isReadOnly} editing={isEditing}
                          onResolve={async resolution => {
                            const reviewed = resolveLegacyStatus({ evidenceVersion: 2, observationStatusVersion: 1,
                              entities, mentions, relations, clinicalNotes }, item.entityId, attribute.id, resolution, activeSchema);
                            await onUpdateNotes(reviewed.clinicalNotes, reviewed.entities, reviewed.relations, reviewed.mentions);
                          }} />;
                      })}
                      {isEditing ? (
                        <form
                          onSubmit={(e) => { e.preventDefault(); saveEdit(cat.id, idx); }}
                          onClick={e => e.stopPropagation()}
                          className="space-y-4"
                        >
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
                            {cat.attributes.map(attr => {
                              const attrDisplayName = attr.displayName || attr.name.replace(/([A-Z])/g, ' $1').replace(/^[a-z]/, (str: string) => str.toUpperCase()).trim();
                              return (
                                <div key={attr.name} className={attr.type === 'temporal' || attr.type === 'trajectory' || attr.type === 'procedure-reference' ? 'flex flex-col gap-1 md:col-span-2' : 'flex flex-col gap-1'}>
                                  <span className="text-2xs font-semibold text-slate-500 uppercase font-sans tracking-wider min-h-[28px] flex items-end pb-1 leading-tight">
                                    {attrDisplayName}
                                  </span>
                                  {attr.type === 'procedure-reference' ? (
                                    <ProcedureReferenceEditor value={activeForm[attr.name] ?? null} entities={entities}
                                      onChange={value => setActiveForm({ ...activeForm, [attr.name]: value })} />
                                  ) : attr.type === 'trajectory' ? (
                                    <TrajectoryEditor label={attrDisplayName} value={activeForm[attr.name] ?? null}
                                      context={{ encounterTime, entities }}
                                      attributeId={entities.find(entity => entity.id === item.entityId)?.attributes?.find(a => a.name === attr.name)?.id}
                                      onChange={value => setActiveForm({ ...activeForm, [attr.name]: value })} />
                                  ) : attr.type === 'temporal' ? (
                                    <TemporalEditor label={attrDisplayName} value={activeForm[attr.name] ?? null}
                                      mode={attr.temporalMode} context={{ encounterTime, entities }}
                                      attributeId={entities.find(entity => entity.id === item.entityId)?.attributes?.find(a => a.name === attr.name)?.id}
                                      onChange={value => setActiveForm({ ...activeForm, [attr.name]: value })} />
                                  ) : attr.type === 'select' ? (
                                    (() => {
                                      const rawVal = (activeForm[attr.name] !== undefined && activeForm[attr.name] !== '')
                                        ? activeForm[attr.name]
                                        : getResolvedAttributeValue(activeForm, attr);
                                      const { selectedValue, options } = matchChoiceInsensitive(rawVal, attr.choices || [], 'unassigned');
                                      return (
                                        <select
                                          aria-label={attrDisplayName}
                                          value={selectedValue}
                                          onChange={e => {
                                            const val = e.target.value;
                                            const nextForm = { ...activeForm, [attr.name]: val };
                                            setActiveForm(nextForm);
                                          }}
                                          className="w-full text-xs border border-slate-200 hover:border-slate-300 focus:border-brand-500 rounded-lg px-2.5 h-9 bg-white focus:ring-1 focus:ring-brand-400 focus:outline-none transition-colors shadow-sm cursor-pointer"
                                        >
                                          {options.map(choice => (
                                            <option key={choice} value={choice}>{choice === 'legacy_refuted' ? 'Legacy refuted — review needed' : choice}</option>
                                          ))}
                                        </select>
                                      );
                                    })()
                                  ) : attr.type === 'boolean' ? (
                                    <div className="flex items-center h-9">
                                      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none">
                                        <input
                                          type="checkbox"
                                          checked={!!((activeForm[attr.name] !== undefined && activeForm[attr.name] !== '') ? activeForm[attr.name] : getResolvedAttributeValue(activeForm, attr))}
                                          onChange={e => setActiveForm({ ...activeForm, [attr.name]: e.target.checked })}
                                          className="rounded border-slate-300 text-brand-600 focus:ring-brand-400 h-4 w-4"
                                        />
                                        {attr.hint || `Is ${attrDisplayName}`}
                                      </label>
                                    </div>
                                  ) : attr.type === 'textarea' ? (
                                    <textarea
                                      value={(activeForm[attr.name] !== undefined && activeForm[attr.name] !== '') ? activeForm[attr.name] : (getResolvedAttributeValue(activeForm, attr) || '')}
                                      onChange={e => setActiveForm({ ...activeForm, [attr.name]: e.target.value })}
                                      className="w-full text-xs border border-slate-200 hover:border-slate-300 focus:border-brand-500 rounded-lg px-2.5 py-1.5 focus:ring-1 focus:ring-brand-400 focus:outline-none min-h-[72px] bg-white transition-colors shadow-sm"
                                      placeholder={attr.hint || `Enter ${attrDisplayName.toLowerCase()}`}
                                    />
                                  ) : (
                                    <input
                                      type={attr.type === 'number' ? 'number' : 'text'}
                                      value={(activeForm[attr.name] !== undefined && activeForm[attr.name] !== '') ? activeForm[attr.name] : (getResolvedAttributeValue(activeForm, attr) || '')}
                                      onChange={e => setActiveForm({ ...activeForm, [attr.name]: e.target.value })}
                                      className="w-full text-xs border border-slate-200 hover:border-slate-300 focus:border-brand-500 rounded-lg px-2.5 h-9 bg-white focus:ring-1 focus:ring-brand-400 focus:outline-none transition-colors shadow-sm"
                                      placeholder={attr.hint || `Enter ${attrDisplayName.toLowerCase()}`}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          <div className="flex justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                              className="px-3 py-1.5 border rounded-lg text-slate-600 hover:bg-slate-50 font-semibold text-xs cursor-pointer transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={Boolean(structuredFormInvalid)}
                              className="disabled:opacity-40 px-3 py-1.5 bg-brand-600 text-white rounded-lg hover:bg-brand-500 font-semibold text-xs cursor-pointer shadow-sm transition-colors"
                            >
                              Save
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-slate-800 font-semibold text-xs">
                                {primaryValue}
                              </span>

                            </div>
                            {!isReadOnly && (
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                                <button
                                  aria-label={`Edit ${primaryValue}`}
                                  onClick={(e) => { e.stopPropagation(); startEdit(cat.id, idx, item); }}
                                  className="p-1 text-slate-500 hover:text-brand-500 cursor-pointer"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </button>
                                <button
                                  aria-label={`Delete ${primaryValue}`}
                                  onClick={(e) => { e.stopPropagation(); handleDelete(cat.id, idx, item.entityId); }}
                                  className="p-1 text-slate-500 hover:text-rose-500 cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Attributes render */}
                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            {cat.attributes
                              .filter(attr => attr.name !== primaryAttr.name)
                              .map(attr => {
                                const val = (item[attr.name] !== undefined && item[attr.name] !== '')
                                  ? item[attr.name]
                                  : getResolvedAttributeValue(item, attr);
                                if (val === undefined || val === '' || val === null) return null;
                                const isNegativeAttr = typeof val === 'string' && /^(absent|refuted|denied|none|negative|none \/ denied|refuted \/ absent)$/i.test(val.trim());
                                const isBoldValue = attr.type === 'select' && String(val).toLowerCase() !== 'unspecified' && String(val).toLowerCase() !== 'unassigned';
                                const attrDisplayName = attr.displayName || attr.name.replace(/([A-Z])/g, ' $1').replace(/^[a-z]/, (str: string) => str.toUpperCase()).trim();
                                return (
                                  <span
                                    key={attr.name}
                                    className={`text-2xs px-1.5 py-0.5 rounded-md font-medium border ${
                                      isNegativeAttr
                                        ? 'bg-rose-50 text-rose-700 border-rose-200 font-semibold'
                                        : isBoldValue
                                          ? 'bg-brand-50/50 text-brand-700 border-brand-100 font-semibold'
                                          : 'bg-slate-100/50 text-slate-600 border-slate-200'
                                    }`}
                                  >
                                    <span className="text-slate-500 font-mono font-medium">{attrDisplayName}:</span> {val === true ? 'Yes' : val === false ? 'No' : formatAttributeValue(val, entities)}
                                  </span>
                                );
                              })}
                          </div>

                          {renderUmlsBadges(item.entityId, primaryValue, cat.entityType)}
                          {renderAttributeEvidence(item.entityId)}

                          {isSelected && (
                            <>
                              {renderEntityConflictsAndSummary(item.entityId)}
                              {renderMentionsSubWindow(item.entityId)}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Clinical Attributes & Support Nodes Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-amber-50 text-amber-600 rounded-lg">
              <Tags className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Clinical Attributes & Support Nodes</h3>
              <p className="text-2xs text-slate-500 mt-0.5">Dosages, Providers, Patients, or other helper terms</p>
            </div>
          </div>
          <button
            onClick={handleAddNewSupportItem}
            title="Add Attribute"
            className="p-1.5 text-amber-600 hover:text-amber-700 bg-amber-50/70 hover:bg-amber-100 rounded-lg transition-all cursor-pointer flex items-center justify-center shrink-0"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {supportEnts.length === 0 ? (
          <p className="text-xs text-slate-500 italic text-center py-4">No additional support attributes documented.</p>
        ) : (
          <div className="space-y-2.5">
            {supportEnts.map((ent, idx) => {
              const isSelected = selectedEntityId === ent.id;
              const isEditing = editingIndex?.category === 'support' && editingIndex?.index === idx;

              return (
                <div
                  key={ent.id}
                  ref={el => { itemRefs.current[ent.id] = el; }}
                  onClick={() => !isEditing && handleItemClick(ent.id)}
                  className={`border rounded-lg p-3 transition-all relative border-l-4 group ${
                    isSelected
                      ? 'border-l-amber-500 border-y-slate-200 border-r-slate-200 bg-amber-50/10 shadow-sm'
                      : 'border-l-slate-200 border-y-slate-100 border-r-slate-100 bg-slate-50/20'
                  } ${!isEditing ? 'cursor-pointer' : ''}`}
                >
                  {isEditing ? (
                    <div className="space-y-2.5" onClick={e => e.stopPropagation()}>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-2xs font-semibold text-slate-500 uppercase font-sans">Attribute Name</label>
                          <input
                            type="text"
                            value={supportForm.name || ''}
                            onChange={e => setSupportForm({ ...supportForm, name: e.target.value })}
                            placeholder="e.g. 50mg, Dr. Smith"
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400 mt-0.5"
                          />
                        </div>
                        <div>
                          <label className="text-2xs font-semibold text-slate-500 uppercase font-sans">Entity Type</label>
                          <select
                            value={supportForm.type || 'Dosage'}
                            onChange={e => setSupportForm({ ...supportForm, type: e.target.value as any })}
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400 mt-0.5 bg-white"
                          >
                            <optgroup label="Support / Attribute Types">
                              <option value="Person">Person (Patient, Provider, Speaker, etc.)</option>
                              <option value="Dosage">Dosage</option>
                              <option value="Patient">Patient (Legacy)</option>
                              <option value="Doctor">Doctor (Legacy)</option>
                              <option value="Other">Other</option>
                            </optgroup>
                            <optgroup label="Convert to Schema Type (Moves item to top tables)">
                              <option value="Symptom">Symptom</option>
                              <option value="Condition">Condition</option>
                              <option value="Medication">Medication</option>
                              <option value="FollowUp">Follow-up Task</option>
                              <option value="Measurement">Measurement / Lab</option>
                            </optgroup>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-2xs font-semibold text-slate-500 uppercase font-sans">Description / Notes</label>
                        <input
                          type="text"
                          value={supportForm.description || ''}
                          onChange={e => setSupportForm({ ...supportForm, description: e.target.value })}
                          placeholder="Brief context or notes"
                          className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400 mt-0.5"
                        />
                      </div>
                      <div className="flex justify-end gap-1.5 pt-1">
                        <button
                          onClick={cancelEdit}
                          className="p-1 text-slate-500 hover:text-slate-600 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => saveEdit('support', idx)}
                          className="p-1 bg-amber-500 hover:bg-amber-600 text-white rounded cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="text-xs font-semibold text-slate-800">{ent.name}</h4>
                          <div className="flex gap-1.5 mt-1">
                            <span className="text-2xs font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                              {ent.type}
                            </span>
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit('support', idx, ent); }}
                            className="p-1 text-slate-500 hover:text-amber-500 cursor-pointer"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteSupport(ent.id); }}
                            className="p-1 text-slate-500 hover:text-rose-500 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      {ent.description && (
                        <p className="text-2xs text-slate-500 mt-1.5 border-t border-dashed border-slate-100/80 pt-1">
                          {ent.description}
                        </p>
                      )}
                      {renderUmlsBadges(ent.id, ent.name, ent.type)}
                      {isSelected && (
                        <>
                          {renderEntityConflictsAndSummary(ent.id)}
                          {renderMentionsSubWindow(ent.id)}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Graph Relations Manager */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-brand-50 text-brand-600 rounded-lg">
              <Link2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Graph Relations Manager</h3>
              <p className="text-2xs text-slate-500 mt-0.5">Link manual additions to create structured concepts</p>
            </div>
          </div>
          {selectedEntityId && (
            <div className="bg-amber-50 border border-amber-100 px-2 py-0.5 rounded text-2xs font-medium text-amber-700 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>
              Focusing: {entities.find(e => e.id === selectedEntityId)?.name || 'Focus Entity'}
            </div>
          )}
        </div>

        {/* Add Relation Form */}
        <form onSubmit={handleAddRelation} className="space-y-3 bg-slate-50/50 p-3 rounded-lg border border-slate-100">
          <div className="text-2xs font-semibold text-slate-500 uppercase font-sans tracking-wider">
            Establish New Relationship
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {/* Source Entity Select */}
            <div>
              <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">Source Entity</label>
              <select
                value={newRelSource}
                onChange={e => setNewRelSource(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-400 bg-white"
              >
                <option value="">-- Choose Source --</option>
                {entities.map(ent => (
                  <option key={ent.id} value={ent.id}>
                    ({ent.type}) {ent.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Relationship Type Select */}
            <div>
              <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">Relationship Type</label>
              <select
                value={newRelType}
                onChange={e => setNewRelType(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-400 bg-white"
              >
                <optgroup label="Person Status & Experience">
                  <option value="EXPERIENCING">EXPERIENCING (Person &rarr; Symptom)</option>
                  <option value="TAKING">TAKING (Person &rarr; Medication)</option>
                  <option value="AGREED_TO">AGREED_TO (Person &rarr; FollowUp)</option>
                  <option value="HAS_MEASUREMENT">HAS_MEASUREMENT (Person &rarr; Measurement)</option>
                  <option value="DIAGNOSED_WITH">DIAGNOSED_WITH (Person &rarr; Condition)</option>
                </optgroup>

                <optgroup label="Clinical Associations">
                  <option value="TREATS">TREATS (Medication &rarr; Symptom/Condition)</option>
                  <option value="PRESCRIBED_FOR">PRESCRIBED_FOR (Medication &rarr; Condition)</option>
                  <option value="PREVENTS">PREVENTS (Medication &rarr; Condition)</option>
                  <option value="INDICATED_FOR">INDICATED_FOR (Medication &rarr; Condition)</option>
                  <option value="ASSOCIATED_WITH">ASSOCIATED_WITH (Measurement &rarr; Condition)</option>
                  <option value="MONITORING_DRUG">MONITORING_DRUG (Measurement &rarr; Medication)</option>
                  <option value="AFFECTS_MEASUREMENT">AFFECTS_MEASUREMENT (Medication &rarr; Measurement)</option>
                  <option value="HAS_TARGET">HAS_TARGET (Measurement &rarr; Measurement/Other)</option>
                  <option value="TARGET_VALUE">TARGET_VALUE (Measurement &rarr; Measurement/Other)</option>
                  <option value="NORMAL_VALUE">NORMAL_VALUE (Measurement &rarr; Measurement/Other)</option>
                </optgroup>

                <optgroup label="Drug & Dosage Linkage">
                  <option value="HAS_DOSAGE">HAS_DOSAGE (Medication &rarr; Dosage)</option>
                  <option value="DOSAGE_FOR">DOSAGE_FOR (Dosage &rarr; Medication)</option>
                  <option value="REPLACES">REPLACES (Medication &rarr; Medication)</option>
                  <option value="SWITCHED_TO">SWITCHED_TO (Medication &rarr; Medication)</option>
                  <option value="COMBINED_WITH">COMBINED_WITH (Medication &rarr; Medication)</option>
                  <option value="CONTRAINDICATED_WITH">CONTRAINDICATED_WITH (Medication &rarr; Medication)</option>
                </optgroup>

                <optgroup label="Medical Orders & Actions">
                  <option value="PRESCRIBED">PRESCRIBED (Person/Provider &rarr; Medication)</option>
                  <option value="SCHEDULED">SCHEDULED (Person/Provider &rarr; FollowUp)</option>
                  <option value="ORDERED_BY">ORDERED_BY (Measurement/Lab &rarr; Person/Provider)</option>
                  <option value="COOPERATES_WITH">COOPERATES_WITH (Person &rarr; Person)</option>
                </optgroup>

                <optgroup label="Care Plan Attribution & Timing">
                  <option value="PROPOSED_BY">PROPOSED_BY (Condition/Treatment &rarr; Person/Provider)</option>
                  <option value="DIAGNOSED_BY">DIAGNOSED_BY (Condition &rarr; Person/Provider)</option>
                  <option value="PRESCRIBED_BY">PRESCRIBED_BY (Medication &rarr; Person/Provider)</option>
                  <option value="SCHEDULED_BY">SCHEDULED_BY (FollowUp &rarr; Person/Provider)</option>
                  <option value="CANCELLED_BY">CANCELLED_BY (FollowUp &rarr; Person/Provider)</option>
                  <option value="CONSIDERED_BY">CONSIDERED_BY (Condition/Medication &rarr; Person/Provider)</option>
                  <option value="DISCONTINUED_BY">DISCONTINUED_BY (Medication &rarr; Person/Provider)</option>
                  <option value="MEASURES">MEASURES (Measurement &rarr; Person)</option>
                  <option value="MEASURED_BY">MEASURED_BY (Measurement &rarr; Person/Provider)</option>
                </optgroup>
              </select>
            </div>

            {/* Target Entity Select */}
            <div>
              <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">Target Entity</label>
              <select
                value={newRelTarget}
                onChange={e => setNewRelTarget(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-400 bg-white"
              >
                <option value="">-- Choose Target --</option>
                {entities.map(ent => (
                  <option key={ent.id} value={ent.id}>
                    ({ent.type}) {ent.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={!newRelSource || !newRelTarget}
              className={`flex items-center gap-1 text-2xs font-semibold px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                !newRelSource || !newRelTarget
                  ? 'bg-slate-50 text-slate-500 border-slate-100 cursor-not-allowed'
                  : 'bg-brand-600 hover:bg-brand-700 text-white border-brand-500 hover:shadow-md'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Link Entities</span>
            </button>
          </div>
        </form>

        {/* Existing Relations List */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-semibold text-slate-500 uppercase font-sans tracking-wider">
              Active Map Connections ({relations.length})
            </span>
          </div>

          {relations.length === 0 ? (
            <p className="text-xs text-slate-500 italic text-center py-4 bg-slate-50/20 border border-dashed border-slate-100 rounded-lg">
              No custom graph connections established.
            </p>
          ) : (
            <div className="max-h-[220px] overflow-y-auto space-y-1.5 pr-1 border rounded-lg p-2 bg-slate-50/20 scrollbar-thin">
              {relations.map((rel) => {
                const sourceEnt = entities.find(e => e.id === rel.source);
                const targetEnt = entities.find(e => e.id === rel.target);
                const isFocused = selectedEntityId && (rel.source === selectedEntityId || rel.target === selectedEntityId);

                return (
                  <div
                    key={rel.id}
                    className={`flex items-center justify-between p-2 rounded-md border text-xs transition-all ${
                      isFocused
                        ? 'bg-brand-50/40 border-brand-200 shadow-sm'
                        : 'bg-white border-slate-100 hover:border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1 flex-wrap font-medium">
                      <span
                        onClick={() => onSelectEntity(rel.source)}
                        className={`cursor-pointer px-1.5 py-0.5 rounded text-2xs bg-slate-100 text-slate-700 hover:bg-slate-200 ${
                          rel.source === selectedEntityId ? 'ring-1 ring-amber-500 font-semibold' : ''
                        }`}
                      >
                        {sourceEnt ? sourceEnt.name : 'Unknown'}
                      </span>
                      <span className="text-2xs font-semibold text-brand-600 bg-brand-50 border border-brand-100 px-1.5 py-0.2 rounded uppercase font-sans">
                        {rel.type}
                      </span>
                      <span
                        onClick={() => onSelectEntity(rel.target)}
                        className={`cursor-pointer px-1.5 py-0.5 rounded text-2xs bg-slate-100 text-slate-700 hover:bg-slate-200 ${
                          rel.target === selectedEntityId ? 'ring-1 ring-amber-500 font-semibold' : ''
                        }`}
                      >
                        {targetEnt ? targetEnt.name : 'Unknown'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteRelation(rel.id)}
                      className="p-1 text-slate-500 hover:text-rose-500 rounded transition-colors cursor-pointer ml-2"
                      title="Delete connection"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Raw Object Preview */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm mt-6">
        <div className="text-2xs font-semibold text-slate-500 uppercase mb-2 tracking-wider font-sans">
          Clinical Instance Registry (JSON Node binding)
        </div>
        <div className="bg-slate-900 rounded-lg p-3 text-2xs font-mono text-emerald-400 overflow-x-auto max-h-[160px] scrollbar-thin select-all">
          <pre>{JSON.stringify({
            selectedNodeId: selectedEntityId || 'None (Click a node or entity to bind)',
            selectedEntity: selectedEntityId ? entities.find(e => e.id === selectedEntityId) : null,
            schemaType: selectedEntityId ? entities.find(e => e.id === selectedEntityId)?.type : 'ClinicalEntity',
            bindingProperties: selectedEntityId ? (() => {
              const result: any = {};
              Object.entries(clinicalNotes).forEach(([key, items]) => {
                if (Array.isArray(items)) {
                  const found = items.find((item: any) => item && item.entityId === selectedEntityId);
                  if (found) {
                    result[key] = found;
                  }
                }
              });
              return Object.keys(result).length > 0 ? result : 'Entity is not yet bound to any clinical statement properties';
            })() : 'No active selection'
          }, null, 2)}</pre>
        </div>
      </div>

      {/* UMLS Manual Search and Override Modal */}
      {activeUmlsEditEntityId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs"
          onClick={() => setActiveUmlsEditEntityId(null)}
        >
          <div
            className="dialog-surface bg-white rounded-xl shadow-xl border border-slate-200 max-w-2xl w-full flex flex-col overflow-hidden max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Beaker className="w-5 h-5 text-blue-400" />
                <div>
                  <h3 className="font-semibold text-sm">Manual UMLS Concept Mapping</h3>
                  <p className="text-2xs text-slate-300 font-mono mt-0.5">
                    Entity: "{entities.find(e => e.id === activeUmlsEditEntityId)?.name}" ({entities.find(e => e.id === activeUmlsEditEntityId)?.type})
                  </p>
                </div>
              </div>
              <button
                onClick={() => setActiveUmlsEditEntityId(null)}
                className="text-slate-500 hover:text-white transition-colors cursor-pointer p-1 rounded-md hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-5 divide-y divide-slate-100 max-h-[calc(90vh-120px)] scrollbar-thin">

              {/* Part 1: UTS Search Engine */}
              <div className="space-y-3">
                <div>
                  <h4 className="text-2xs font-semibold text-slate-500 uppercase tracking-wider font-sans flex items-center gap-1.5">
                    <Search className="w-3.5 h-3.5 text-blue-500" />
                    <span>Search UMLS Metathesaurus</span>
                  </h4>
                  <p className="text-2xs text-slate-500 mt-1">
                    Query NLM's UTS to search over 100 vocabularies. Selected concepts will automatically auto-fill code registries.
                  </p>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={umlsSearchQuery}
                    onChange={(e) => setUmlsSearchQuery(e.target.value)}
                    placeholder="Search query (e.g. edema, heart failure, paracetamol)..."
                    className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2 bg-slate-50/50 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:bg-white"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleUmlsSearch();
                      }
                    }}
                  />
                  <button
                    onClick={handleUmlsSearch}
                    disabled={isUmlsSearching || !umlsSearchQuery.trim()}
                    className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-100 disabled:text-slate-500 text-white font-semibold text-xs rounded-lg transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
                  >
                    {isUmlsSearching ? (
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    <span>Search</span>
                  </button>
                </div>

                {umlsEditError && (
                  <p className="text-2xs text-rose-500 font-medium bg-rose-50 border border-rose-100 rounded-md p-2 flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>{umlsEditError}</span>
                  </p>
                )}

                {umlsSearchResults.length > 0 && (
                  <div className="border border-slate-100 rounded-lg overflow-hidden bg-slate-50/50 max-h-[160px] overflow-y-auto scrollbar-thin">
                    <div className="bg-slate-100 px-3 py-1.5 text-2xs font-semibold text-slate-500 uppercase tracking-wider font-sans">
                      Query matches ({umlsSearchResults.length})
                    </div>
                    <div className="divide-y divide-slate-100">
                      {umlsSearchResults.map((res) => (
                        <button
                          key={res.cui}
                          onClick={() => handleSelectSearchResult(res)}
                          disabled={fetchCodesLoading}
                          className="w-full text-left px-3 py-2 text-xs hover:bg-white flex items-center justify-between gap-4 transition-colors disabled:opacity-50"
                        >
                          <span className="font-medium text-slate-700 truncate">{res.name}</span>
                          <span className="font-mono text-2xs text-blue-600 font-semibold bg-blue-50 px-1.5 py-0.5 rounded shrink-0">
                            CUI: {res.cui}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Part 2: Custom / Direct Mapping Overrides */}
              <div className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-2xs font-semibold text-slate-500 uppercase tracking-wider font-sans flex items-center gap-1.5">
                    <Settings className="w-3.5 h-3.5 text-purple-500" />
                    <span>Direct Registry Overrides</span>
                  </h4>
                  {fetchCodesLoading && (
                    <div className="flex items-center gap-1.5 text-2xs text-purple-600 font-semibold font-mono animate-pulse">
                      <span className="w-2.5 h-2.5 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin"></span>
                      <span>Resolving vocabulary mappings...</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Concept Name */}
                  <div className="md:col-span-2">
                    <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">
                      Preferred Concept Name
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.preferredName}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, preferredName: e.target.value }))}
                      placeholder="Preferred standardized term name..."
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>

                  {/* CUI */}
                  <div>
                    <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">
                      UMLS CUI (Concept Unique Identifier)
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.cui}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, cui: e.target.value }))}
                      placeholder="CXXXXXXX"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>

                  {/* SNOMED */}
                  <div>
                    <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">
                      SNOMED-CT Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.snomed}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, snomed: e.target.value }))}
                      placeholder="e.g. 29857009"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>

                  {/* RxNorm */}
                  <div>
                    <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">
                      RxNorm Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.rxnorm}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, rxnorm: e.target.value }))}
                      placeholder="e.g. 1191"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>

                  {/* ICD-10 */}
                  <div>
                    <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">
                      ICD-10 Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.icd10}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, icd10: e.target.value }))}
                      placeholder="e.g. I10, R60.9"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>

                  {/* LOINC */}
                  <div>
                    <label className="block text-2xs font-semibold text-slate-500 uppercase font-sans mb-1">
                      LOINC Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.loinc}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, loinc: e.target.value }))}
                      placeholder="e.g. 1751-7"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={handleRemoveUmlsMapping}
                disabled={!entities.find(e => e.id === activeUmlsEditEntityId)?.umlsMapping}
                className="px-3 py-2 text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-lg font-semibold text-xs transition-all disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:border-transparent cursor-pointer"
              >
                Clear/Remove Mapping
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveUmlsEditEntityId(null)}
                  className="px-3.5 py-2 hover:bg-slate-100 text-slate-700 font-semibold text-xs rounded-lg transition-all border border-slate-200 cursor-pointer bg-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveCustomUmlsMapping}
                  disabled={!customUmlsMapping.cui}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-100 disabled:text-slate-500 disabled:border-transparent text-white font-semibold text-xs rounded-lg transition-all cursor-pointer shadow-xs border border-brand-500 hover:shadow-md"
                >
                  Save Mapping
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ExportJsonlModal
        isOpen={showExportJsonlModal}
        onClose={() => setShowExportJsonlModal(false)}
        entities={entities}
        mentions={mentions}
        relations={relations}
        clinicalNotes={clinicalNotes}
      />
    </div>
  );
}
import { apiFetch } from '../firebase';
