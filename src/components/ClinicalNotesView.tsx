import React, { useState, useEffect } from 'react';
import { ClinicalCategory, Entity, ClinicalSymptom, ClinicalCondition, ClinicalMedication, ClinicalFollowUp, Relation, ClinicalMeasurement, Mention, AnnotationCategory, AnnotationAttribute, DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../types';
import { Plus, Trash2, Edit2, Check, X, ShieldAlert, Pill, Activity, CalendarCheck, Link2, Beaker, Search, Settings, Tags, Layers, Syringe, Users, ClipboardCheck } from 'lucide-react';

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
}

function shouldEntityGoToCategory(ent: Entity, cat: AnnotationCategory, activeSchema: AnnotationCategory[]): boolean {
  if (!ent || !ent.type || !cat) return false;
  const entType = (ent.type || '').trim();
  const entTypeLower = entType.toLowerCase();

  const catIdLower = (cat.id || '').toLowerCase();
  const catDisplayNameLower = (cat.displayName || '').toLowerCase();
  const catEntityTypeLower = (cat.entityType || '').toLowerCase();

  // 1. Direct match on Category ID, Display Name, or EntityType
  if (entTypeLower === catIdLower || entTypeLower === catDisplayNameLower || entTypeLower === catEntityTypeLower) {
    // If another category in activeSchema matches ent.type exact ID, prefer that exact ID match
    const exactOtherCat = activeSchema.find(c => c.id.toLowerCase() === entTypeLower && c.id.toLowerCase() !== catIdLower);
    if (exactOtherCat) {
      return false;
    }
    return true;
  }

  // 2. Normalized matching (ignoring fhir_ prefix, plural 's')
  const normEntType = entTypeLower.replace(/^fhir_/, '').replace(/s$/, '');
  const normCatId = catIdLower.replace(/^fhir_/, '').replace(/s$/, '');
  const normCatDisplayName = catDisplayNameLower.replace(/^fhir_/, '').replace(/s$/, '');
  const normCatEntityType = catEntityTypeLower.replace(/^fhir_/, '').replace(/s$/, '');

  if (normEntType === normCatId || normEntType === normCatDisplayName || normEntType === normCatEntityType) {
    const exactOtherCat = activeSchema.find(c => {
      const cNormId = c.id.toLowerCase().replace(/^fhir_/, '').replace(/s$/, '');
      return cNormId === normEntType && c.id.toLowerCase() !== catIdLower;
    });
    if (exactOtherCat) {
      return false;
    }
    return true;
  }

  // 3. Sub-category disambiguation when multiple categories share entityType
  if (catEntityTypeLower && (entTypeLower.includes(normCatEntityType) || normEntType.includes(normCatEntityType))) {
    const name = (ent.name || '').toLowerCase();
    const desc = (ent.description || '').toLowerCase();

    // Procedures vs Service Requests
    if (catIdLower.includes('procedure') || normCatId === 'procedure') {
      const isProcedure = entTypeLower.includes('procedure') || name.includes('procedure') || name.includes('surgery') || name.includes('operatie') || name.includes('scan') || name.includes('mri');
      if (isProcedure) return true;
    } else if (catIdLower.includes('servicerequest') || catIdLower.includes('followup') || catIdLower.includes('request')) {
      const isProcedure = entTypeLower.includes('procedure') || name.includes('procedure') || name.includes('surgery') || name.includes('operatie') || name.includes('scan') || name.includes('mri');
      if (!isProcedure) return true;
    }

    // Allergies vs Symptoms
    if (catIdLower.includes('allergy') || catIdLower.includes('intolerance')) {
      const isAllergy = entTypeLower.includes('allergy') || name.includes('allergy') || name.includes('allergie') || name.includes('intoleran') || desc.includes('allergy');
      if (isAllergy) return true;
    } else if (catIdLower.includes('symptom')) {
      const isAllergy = entTypeLower.includes('allergy') || name.includes('allergy') || name.includes('allergie') || name.includes('intoleran') || desc.includes('allergy');
      if (!isAllergy) return true;
    }

    // Family History vs Conditions
    if (catIdLower.includes('family') || catIdLower.includes('history')) {
      const isFamily = entTypeLower.includes('family') || name.includes('vader') || name.includes('moeder') || name.includes('father') || name.includes('mother') || name.includes('sibling') || name.includes('family');
      if (isFamily) return true;
    } else if (catIdLower.includes('condition')) {
      const isFamily = entTypeLower.includes('family') || name.includes('vader') || name.includes('moeder') || name.includes('father') || name.includes('mother') || name.includes('sibling') || name.includes('family');
      if (!isFamily) return true;
    }

    // Diagnostic Reports vs Observations
    if (catIdLower.includes('report') || catIdLower.includes('diagnostic')) {
      const isReport = entTypeLower.includes('report') || name.includes('report') || name.includes('panel') || name.includes('verslag') || name.includes('cbc');
      if (isReport) return true;
    } else if (catIdLower.includes('observation') || catIdLower.includes('measurement')) {
      const isReport = entTypeLower.includes('report') || name.includes('report') || name.includes('panel') || name.includes('verslag') || name.includes('cbc');
      if (!isReport) return true;
    }
  }

  return false;
}

function isSupportEntity(ent: Entity, activeSchema: AnnotationCategory[]): boolean {
  if (!ent || !ent.type) return false;

  // 1. If it matches ANY category in the active schema, it's NOT a support entity
  if (activeSchema.some(cat => shouldEntityGoToCategory(ent, cat, activeSchema))) {
    return false;
  }

  // 2. If its type matches any category id, displayName, or entityType in activeSchema
  const tLower = ent.type.toLowerCase().trim();
  const matchesAnyCategory = activeSchema.some(cat => 
    cat.id.toLowerCase() === tLower ||
    cat.displayName.toLowerCase() === tLower ||
    cat.entityType.toLowerCase() === tLower ||
    tLower.includes(cat.entityType.toLowerCase()) ||
    cat.id.toLowerCase().includes(tLower)
  );

  if (matchesAnyCategory) {
    return false;
  }

  return true;
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
  encounterType = 'dialogue'
}: ClinicalNotesViewProps) {
  const activeSchema = React.useMemo(() => {
    const base = annotationSchema && annotationSchema.length > 0 ? annotationSchema : DEFAULT_ANNOTATION_SCHEMA;
    return normalizeAnnotationSchema(base);
  }, [annotationSchema]);

  const [editingIndex, setEditingIndex] = useState<{ category: string; index: number } | null>(null);
  const [correctingSpeakerMentionId, setCorrectingSpeakerMentionId] = useState<string | null>(null);

  // Clear Annotations Confirmation State
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const renderEntityConflictsAndSummary = (entityId: string) => {
    const entityMentions = (mentions || []).filter(m => m.entityId === entityId);
    if (entityMentions.length === 0) return null;

    // 1. Gather all functions
    const functions = entityMentions.map(m => m.function || 'asserted');
    const funcCounts: { [key: string]: number } = {};
    functions.forEach(f => { funcCounts[f] = (funcCounts[f] || 0) + 1; });
    const funcSummary = Object.entries(funcCounts)
      .map(([f, count]) => `${count} ${f === 'explanatory' ? 'general/explanatory' : f}`)
      .join(', ');

    // Filter mentions for entity summary calculation to only asserted patient-specific mentions
    const summaryMentions = entityMentions.filter(m => {
      const isAsserted = (m.function || 'asserted') === 'asserted';
      const isPatientSpecific = (m.experiencer || 'patient') === 'patient';
      return isAsserted && isPatientSpecific;
    });

    // 2. Gather temporalities (calculated only from summaryMentions)
    const temporalities = summaryMentions.map(m => m.temporality || 'current');
    const tempCounts: { [key: string]: number } = {};
    temporalities.forEach(t => { tempCounts[t] = (tempCounts[t] || 0) + 1; });
    const hasTempConflict = Object.keys(tempCounts).length > 1;
    const tempSummary = Object.entries(tempCounts)
      .map(([t, count]) => `${count} ${t}`)
      .join(', ');

    // 3. Gather polarities (calculated only from summaryMentions)
    const polarities = summaryMentions.map(m => m.polarity || 'positive');
    const polCounts: { [key: string]: number } = {};
    polarities.forEach(p => { polCounts[p] = (polCounts[p] || 0) + 1; });
    const hasPolConflict = Object.keys(polCounts).length > 1;
    const polSummary = Object.entries(polCounts)
      .map(([p, count]) => `${count} ${p}`)
      .join(', ');

    // 4. Gather certainties (calculated only from summaryMentions)
    const certainties = summaryMentions.map(m => m.certainty || 'certain');
    const certCounts: { [key: string]: number } = {};
    certainties.forEach(c => { certCounts[c] = (certCounts[c] || 0) + 1; });
    const hasCertConflict = Object.keys(certCounts).length > 1;
    const certSummary = Object.entries(certCounts)
      .map(([c, count]) => `${count} ${c}`)
      .join(', ');

    const hasAnyConflict = hasTempConflict || hasPolConflict || hasCertConflict;

    return (
      <div className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] space-y-1">
        <div className="flex items-center justify-between font-medium text-slate-500">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="font-bold text-indigo-600 font-mono">{entityMentions.length} mentions</span>
            <span>·</span>
            <span className="text-slate-600">{funcSummary}</span>
          </div>
          {hasAnyConflict && (
            <span className="text-[9px] bg-amber-50 text-amber-700 font-bold px-1.5 py-0.5 rounded flex items-center gap-1 border border-amber-200">
              <span className="w-1 h-1 rounded-full bg-amber-500 animate-ping"></span>
              Conflict detected
            </span>
          )}
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 text-slate-400 font-mono text-[9px] pt-1 border-t border-slate-100">
          <div>
            <span className="text-slate-500 font-semibold">Temporality:</span>{' '}
            <span className={hasTempConflict ? 'text-amber-600 font-bold' : 'text-slate-600'}>
              {hasTempConflict ? tempSummary : (temporalities[0] || 'current')}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-semibold">Polarity:</span>{' '}
            <span className={hasPolConflict ? 'text-rose-600 font-bold' : 'text-slate-600'}>
              {hasPolConflict ? polSummary : (polarities[0] || 'positive')}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-semibold">Certainty:</span>{' '}
            <span className={hasCertConflict ? 'text-purple-600 font-bold' : 'text-slate-600'}>
              {hasCertConflict ? certSummary : (certainties[0] || 'certain')}
            </span>
          </div>
        </div>
      </div>
    );
  };

  const renderMentionsSubWindow = (entityId: string) => {
    const entityMentions = (mentions || []).filter(m => m.entityId === entityId);
    
    if (entityMentions.length === 0) {
      return (
        <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-400 italic">
          No explicit dialogue or document mentions mapped.
        </div>
      );
    }

    return (
      <div className="mt-3 pt-3 border-t border-slate-100 space-y-3 animate-fadeIn">
        <div className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider flex items-center justify-between">
          <span>Mentions ({entityMentions.length})</span>
          <span className="text-[9px] text-indigo-500 font-medium">Click a mention card to trace in transcript</span>
        </div>
        
        <div className="space-y-2.5">
          {entityMentions.map((mention, mIdx) => {
            const isMentionSelected = selectedMentionId === mention.id;
            const segment = segments?.find((s, idx) => idx === mention.textSpan.lineIndex);
            const derivedSpeaker = segment ? segment.speaker.toLowerCase() : 'patient';
            const speakerDisplay = mention.speaker || derivedSpeaker;
            const isSpeakerCorrected = mention.speaker && mention.speaker !== derivedSpeaker;
            const isCorrectingSpeaker = correctingSpeakerMentionId === mention.id;
            const functionDisplay = mention.function || 'asserted';

            const isExceptionPolarity = mention.polarity && mention.polarity !== 'positive';
            const isExceptionCertainty = mention.certainty && mention.certainty !== 'certain';
            const isExceptionTemporality = mention.temporality && mention.temporality !== 'current';
            const isExceptionExperiencer = mention.experiencer && mention.experiencer !== 'patient';

            const handleAttributeChange = (field: 'speaker' | 'polarity' | 'certainty' | 'temporality' | 'experiencer' | 'function', value: string) => {
              if (isReadOnly) return;
              const updatedMentions = (mentions || []).map(m => {
                if (m.id === mention.id) {
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

            return (
              <div
                key={mention.id || mIdx}
                id={`mention-card-${mention.id}`}
                className={`border rounded-lg p-2.5 space-y-2 transition-all duration-200 cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/10 ${
                  isMentionSelected
                    ? 'bg-indigo-50/80 border-indigo-500 ring-2 ring-indigo-100 shadow-sm'
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
                    {/* Header with segment reference */}
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-mono text-slate-500 bg-slate-200/60 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></span>
                        {encounterType === 'note' ? `Section ${mention.textSpan.lineIndex + 1}` : `Segment U-${mention.textSpan.lineIndex}`}
                      </span>
                      <span className="font-semibold italic text-slate-700 max-w-[200px] truncate" title={mention.textSpan.text}>
                        "{mention.textSpan.text}"
                      </span>
                    </div>

                    {/* Speaker Info Bar (Static by default, editable on secondary action) */}
                    {encounterType !== 'note' && (
                      <div className="flex items-center justify-between text-[10px] bg-slate-100/80 px-2 py-1 rounded-md" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5 text-slate-600">
                          <span className="font-semibold uppercase tracking-wider text-[8px] text-slate-400 font-mono">Speaker:</span>
                          {isCorrectingSpeaker ? (
                            <select
                              value={mention.speaker || derivedSpeaker}
                              onChange={(e) => {
                                handleAttributeChange('speaker', e.target.value);
                                setCorrectingSpeakerMentionId(null);
                              }}
                              className="text-[9px] font-bold bg-white border border-slate-300 rounded px-1.5 py-0.5 text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                            >
                              <option value="patient">Patient (derived)</option>
                              <option value="doctor">Doctor</option>
                              <option value="relative">Relative</option>
                              <option value="other">Other</option>
                            </select>
                          ) : (
                            <span className="font-bold text-slate-800 capitalize flex items-center gap-1">
                              {speakerDisplay}
                              {isSpeakerCorrected && (
                                <span className="text-[8px] text-indigo-500 font-medium normal-case bg-indigo-50 px-1 py-0.2 rounded font-mono">
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
                              className="text-[9px] text-indigo-600 hover:text-indigo-800 font-semibold underline cursor-pointer"
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
                              className="text-[9px] text-rose-500 hover:text-rose-700 font-semibold underline cursor-pointer"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Responsive attributes layout - wraps cleanly on narrow sidebars */}
                    <div className="flex flex-wrap gap-2" onClick={e => e.stopPropagation()}>
                      {/* Polarity */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className="text-[8px] font-bold text-slate-400 uppercase font-mono">Polarity</span>
                        <select
                          value={mention.polarity || 'positive'}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('polarity', e.target.value)}
                          className={`w-full text-[9px] font-semibold bg-white border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer ${
                            mention.polarity === 'negative' 
                              ? 'border-rose-200 text-rose-700 bg-rose-50/10' 
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="positive">Positive</option>
                          <option value="negative">Negative</option>
                          <option value="neutral">Neutral</option>
                        </select>
                      </div>

                      {/* Certainty */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className="text-[8px] font-bold text-slate-400 uppercase font-mono">Certainty</span>
                        <select
                          value={mention.certainty || 'certain'}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('certainty', e.target.value)}
                          className={`w-full text-[9px] font-semibold bg-white border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer ${
                            mention.certainty !== 'certain' 
                              ? 'border-amber-200 text-amber-700 bg-amber-50/10' 
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="certain">Certain</option>
                          <option value="uncertain">Uncertain</option>
                          <option value="hypothetical">Hypothetical</option>
                        </select>
                      </div>

                      {/* Temporality */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className="text-[8px] font-bold text-slate-400 uppercase font-mono">Temporality</span>
                        <select
                          value={mention.temporality || 'current'}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('temporality', e.target.value)}
                          className={`w-full text-[9px] font-semibold bg-white border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer ${
                            mention.temporality !== 'current' 
                              ? 'border-blue-200 text-blue-700 bg-blue-50/10' 
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="current">Current</option>
                          <option value="past">Past / History</option>
                          <option value="future">Future</option>
                        </select>
                      </div>

                      {/* Experiencer */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className="text-[8px] font-bold text-slate-400 uppercase font-mono">Experiencer</span>
                        <select
                          value={mention.experiencer || 'patient'}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('experiencer', e.target.value)}
                          className="w-full text-[9px] font-semibold bg-white border border-slate-200 rounded px-1 py-0.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer"
                        >
                          <option value="patient">Patient</option>
                          <option value="family">Family</option>
                          <option value="other">Other</option>
                        </select>
                      </div>

                      {/* Mention Function */}
                      <div className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
                        <span className="text-[8px] font-bold text-slate-400 uppercase font-mono">Function</span>
                        <select
                          value={mention.function || 'asserted'}
                          disabled={isReadOnly}
                          onChange={(e) => handleAttributeChange('function', e.target.value)}
                          className={`w-full text-[9px] font-semibold bg-white border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer ${
                            mention.function === 'questioned'
                              ? 'border-amber-200 text-amber-700 bg-amber-50/10 font-bold'
                              : mention.function === 'hypothetical'
                              ? 'border-purple-200 text-purple-700 bg-purple-50/10 font-bold'
                              : mention.function === 'explanatory'
                              ? 'border-slate-350 text-slate-700 bg-slate-50/10 font-bold'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="asserted">Asserted</option>
                          <option value="questioned">Questioned</option>
                          <option value="hypothetical">Hypothetical</option>
                          <option value="explanatory">General/explanatory</option>
                        </select>
                      </div>
                    </div>

                    {/* Apply to All Mentions Action */}
                    <div className="flex justify-end pt-1" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentPolarity = mention.polarity || 'positive';
                          const currentCertainty = mention.certainty || 'certain';
                          const currentTemporality = mention.temporality || 'current';
                          const currentExperiencer = mention.experiencer || 'patient';
                          const currentFunction = mention.function || 'asserted';
                          const currentSpeaker = mention.speaker;

                          const updatedMentions = (mentions || []).map(m => {
                            if (m.entityId === mention.entityId) {
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
                        className="flex items-center gap-1 text-[9px] font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded transition-colors cursor-pointer"
                      >
                        <Layers className="w-2.5 h-2.5" />
                        Apply these attributes to all {entityMentions.length} mentions
                      </button>
                    </div>
                  </>
                ) : (
                  /* Collapsed Card view */
                  <div className="flex items-center justify-between text-xs py-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-md font-semibold text-[9px]">
                        U-{mention.textSpan.lineIndex}
                      </span>
                      <span className="text-slate-400 font-medium font-sans select-none">·</span>
                      <span className="text-slate-700 font-bold capitalize text-[10px]">{speakerDisplay}</span>
                      <span className="text-slate-400 font-medium font-sans select-none">·</span>
                      <span className={`font-bold capitalize text-[10px] px-1 py-0.2 rounded ${
                        functionDisplay === 'questioned' ? 'text-amber-600 bg-amber-50' :
                        functionDisplay === 'hypothetical' ? 'text-purple-600 bg-purple-50' :
                        functionDisplay === 'explanatory' ? 'text-slate-600 bg-slate-100 font-medium' :
                        'text-emerald-600 bg-emerald-50'
                      }`}>
                        {functionDisplay === 'explanatory' ? 'General/explanatory' : functionDisplay}
                      </span>
                      {/* Exception Badges */}
                      {isExceptionPolarity && (
                        <span className="text-[8px] bg-rose-50 text-rose-600 border border-rose-100 font-bold px-1 py-0.2 rounded uppercase">
                          {mention.polarity}
                        </span>
                      )}
                      {isExceptionCertainty && (
                        <span className="text-[8px] bg-amber-50 text-amber-600 border border-amber-100 font-bold px-1 py-0.2 rounded uppercase">
                          {mention.certainty}
                        </span>
                      )}
                      {isExceptionTemporality && (
                        <span className="text-[8px] bg-blue-50 text-blue-600 border border-blue-100 font-bold px-1 py-0.2 rounded uppercase">
                          {mention.temporality}
                        </span>
                      )}
                      {isExceptionExperiencer && (
                        <span className="text-[8px] bg-orange-50 text-orange-600 border border-orange-100 font-bold px-1 py-0.2 rounded uppercase">
                          {mention.experiencer === 'other' ? 'Other Experiencer' : mention.experiencer}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-500 italic max-w-[150px] truncate select-none block" title={mention.textSpan.text}>
                      "{mention.textSpan.text}"
                    </span>
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

  useEffect(() => {
    if (selectedMentionId) {
      setTimeout(() => {
        const card = document.getElementById(`mention-card-${selectedMentionId}`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 100);
    }
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

    activeSchema.forEach(cat => {
      const currentItems = clinicalNotes[cat.id] || [];
      const missingItems: any[] = [];

      entities.forEach(ent => {
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
                newItem[attr.name] = attr.choices && attr.choices.length > 0 ? attr.choices[0] : 'Unspecified';
              } else if (attr.type === 'boolean') {
                newItem[attr.name] = false;
              } else {
                newItem[attr.name] = '';
              }
            });
            missingItems.push(newItem);
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
      const response = await fetch('/api/umls/search', {
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
      const response = await fetch('/api/umls/concept-codes', {
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
      const response = await fetch('/api/umls/map', {
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
    // Map Symptoms, Conditions, Medications, and Measurements
    const mappableTypes = ['Symptom', 'Condition', 'Medication', 'Measurement'];
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
        const response = await fetch('/api/umls/map', {
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
        <div className="flex items-center gap-1.5 mt-2 text-[10px] text-slate-400 font-mono">
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
            className="flex items-center gap-1 text-[9px] font-semibold text-blue-600 hover:text-blue-700 hover:bg-blue-50 border border-blue-100 px-2 py-0.5 rounded transition-all cursor-pointer bg-white"
          >
            <Link2 className="w-2.5 h-2.5" />
            <span>Map UMLS</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenUmlsEdit(entityId);
            }}
            className="flex items-center gap-1 text-[9px] font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded transition-all cursor-pointer bg-white"
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
          <div className="flex items-center justify-between gap-2 p-1.5 bg-rose-50 border border-rose-100 rounded text-[9px] text-rose-600 font-medium">
            <div className="flex items-center gap-1 truncate">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 text-rose-500" />
              <span className="truncate">{mapping.error}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMapEntity(entityId, name, type);
              }}
              className="text-[9px] text-blue-600 hover:underline font-semibold shrink-0 cursor-pointer bg-transparent border-0"
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
              className="flex items-center gap-1 text-[9px] font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 px-2 py-0.5 rounded transition-all cursor-pointer bg-white"
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
          <span className="text-[9px] font-mono text-slate-400 italic">No UMLS match found</span>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMapEntity(entityId, name, type);
              }}
              className="text-[9px] text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            >
              Re-map
            </button>
            <span className="text-slate-300 text-[9px]">|</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleOpenUmlsEdit(entityId);
              }}
              className="text-[9px] text-slate-500 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            >
              Search/Edit
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="mt-2 pt-1.5 border-t border-dashed border-slate-100 flex flex-wrap gap-1 items-center" onClick={e => e.stopPropagation()}>
        <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mr-1 font-mono">UMLS:</span>
        
        <a
          href={`https://uts.nlm.nih.gov/uts/umls/concept/${mapping.cui}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800 border border-slate-200 transition-colors"
          title={`UMLS Concept Unique Identifier (CUI): ${mapping.preferredName}`}
        >
          <span>{mapping.cui}</span>
        </a>

        {mapping.snomed && (
          <a
            href={`https://terminologie.nictiz.nl/art-decor/snomed-ct?conceptId=${mapping.snomed}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 hover:text-purple-900 border border-purple-100 transition-colors"
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
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 hover:bg-sky-100 hover:text-sky-900 border border-sky-100 transition-colors"
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
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-900 border border-emerald-100 transition-colors"
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
            className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-900 border border-amber-100 transition-colors"
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
            className="text-[8px] text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            title="Edit UMLS codes manually"
          >
            Edit
          </button>
          <span className="text-[8px] text-slate-300">|</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMapEntity(entityId, name, type);
            }}
            className="text-[8px] text-slate-400 hover:text-blue-600 hover:underline font-semibold cursor-pointer bg-transparent border-0"
            title="Refresh UMLS mapping"
          >
            Re-map
          </button>
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (selectedEntityId && itemRefs.current[selectedEntityId]) {
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
    
    // Also remove from general entities array
    const updatedEntities = entities.filter(e => e.id !== entityId);
    const updatedMentions = mentions.filter(m => m.entityId !== entityId);

    onUpdateNotes(updatedNotes, updatedEntities, relations, updatedMentions);
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
      setActiveForm(item);
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

      const updatedItem = { ...currentItem, ...activeForm };
      if (!updatedNotes[category]) updatedNotes[category] = [];
      const noteIdx = (updatedNotes[category] as any[]).findIndex((item: any) => item.entityId === currentItem.entityId);
      if (noteIdx > -1) {
        updatedNotes[category][noteIdx] = updatedItem;
      } else {
        updatedNotes[category].push(updatedItem);
      }

      // Update matching entity
      const entIdx = updatedEntities.findIndex(e => e.id === updatedItem.entityId);
      if (entIdx > -1) {
        const primaryName = updatedItem.name || updatedItem.task || `Updated ${cat.displayName}`;
        const detailsParts = cat.attributes
          .filter(attr => attr.name !== 'name' && attr.name !== 'task')
          .map(attr => {
            const val = updatedItem[attr.name];
            if (val === undefined || val === '' || val === null) return null;
            return `${attr.name}: ${val}`;
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

    onUpdateNotes(updatedNotes, updatedEntities, relations, updatedMentions);
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

    const newItem: any = { entityId: newId };
    cat.attributes.forEach(attr => {
      if (attr.name === 'name' || attr.name === 'task') {
        newItem[attr.name] = `New ${cat.displayName.endsWith('s') ? cat.displayName.slice(0, -1) : cat.displayName}`;
      } else if (attr.type === 'select') {
        newItem[attr.name] = attr.choices && attr.choices.length > 0 ? attr.choices[0] : 'Unspecified';
      } else if (attr.type === 'boolean') {
        newItem[attr.name] = false;
      } else {
        newItem[attr.name] = '';
      }
    });

    if (!updatedNotes[category]) {
      updatedNotes[category] = [];
    }
    updatedNotes[category] = [...(updatedNotes[category] as any[]), newItem];

    const detailsParts = cat.attributes
      .filter(attr => attr.name !== 'name' && attr.name !== 'task')
      .map(attr => {
        const val = newItem[attr.name];
        if (val === undefined || val === '' || val === null) return null;
        return `${attr.name}: ${val}`;
      })
      .filter(Boolean);

    updatedEntities.push({
      id: newId,
      name: newItem.name || newItem.task || `New ${cat.displayName}`,
      type: cat.entityType,
      description: detailsParts.join(' | ') || `Added manually to ${cat.displayName}`
    });

    onUpdateNotes(updatedNotes, updatedEntities);
    
    // Set to editing immediately
    const lastIndex = (updatedNotes[category] as any[]).length - 1;
    startEdit(category, lastIndex, (updatedNotes[category] as any[])[lastIndex]);
  };

  const getCategoryIcon = (catId: string) => {
    const id = catId.toLowerCase();
    if (id.includes('symptom') || id.includes('allergy')) return <Activity className="w-4.5 h-4.5 text-amber-600" />;
    if (id.includes('family') || id.includes('history')) return <Users className="w-4.5 h-4.5 text-teal-600" />;
    if (id.includes('condition') || id.includes('disorder') || id.includes('disease')) return <Activity className="w-4.5 h-4.5 text-emerald-600" />;
    if (id.includes('immunization') || id.includes('vaccine')) return <Syringe className="w-4.5 h-4.5 text-orange-600" />;
    if (id.includes('medication') || id.includes('drug') || id.includes('treatment')) return <Pill className="w-4.5 h-4.5 text-indigo-600" />;
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
        const primaryAttr = cat.attributes.find(a => a.name === 'name' || a.name === 'task') || cat.attributes[0];
        const linkedEnt = eId ? entities.find(e => e.id === eId) : null;
        const resolvedName = item.name || item.task || item[primaryAttr.name] || linkedEnt?.name || '';

        result.push({
          ...item,
          name: item.name || resolvedName,
          task: item.task || resolvedName,
          [primaryAttr.name]: item[primaryAttr.name] || resolvedName
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
          const primaryAttr = cat.attributes.find(attr => attr.name === 'name' || attr.name === 'task') || cat.attributes[0];
          const newItem: any = {
            entityId: ent.id,
            name: ent.name,
            task: ent.name
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
    <div className="space-y-6">
      {/* Clinical Workspace Header with Clear All Button */}
      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4.5 h-4.5 text-slate-500" />
          <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider font-mono">Clinical Workspace</span>
        </div>
        {!isReadOnly && (
          <div className="flex items-center gap-2">
            {showClearConfirm ? (
              <div className="flex items-center gap-1.5 bg-rose-50 border border-rose-100 px-2.5 py-1.5 rounded-lg animate-in fade-in duration-200">
                <span className="text-[10px] text-rose-700 font-medium">Delete all annotations?</span>
                <button
                  onClick={handleClearAllAnnotations}
                  className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-[9px] rounded shadow-sm transition-all cursor-pointer"
                >
                  Yes, Clear
                </button>
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-semibold text-[9px] rounded transition-all cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="px-2.5 py-1.5 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 text-slate-500 border border-slate-200 rounded-lg text-[11px] font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                title="Delete all clinical annotated entities and relationships"
              >
                <Trash2 className="w-3.5 h-3.5 text-slate-400 hover:text-rose-500 transition-colors" />
                <span>Clear All Annotations</span>
              </button>
            )}
          </div>
        )}
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
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-indigo-800 text-xs flex items-start gap-3">
            <ShieldAlert className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />
            <div>
              <span className="font-bold">Read-Only Mode:</span> This is a shared clinical session. You can explore the interactive knowledge graph and UMLS term mappings, but editing has been disabled. To customize this session, click the <strong className="text-indigo-950 font-bold">"Clone Session"</strong> button at the top right to copy it to your account!
            </div>
          </div>
        </>
      )}
      {/* UMLS Mapping Dashboard Control */}
      <div className="bg-slate-900 text-white rounded-xl p-4.5 shadow-md border border-slate-800 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="p-1.5 bg-blue-500/20 text-blue-400 rounded-lg shrink-0 mt-0.5">
            <Beaker className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h3 className="font-semibold text-xs leading-tight uppercase tracking-wider text-slate-300 font-mono">
              UMLS Terminology Mapping
            </h3>
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
              Standardize medical concepts: <strong className="text-sky-300 font-medium">RxNorm</strong> for drugs, <strong className="text-purple-300 font-medium">SNOMED-CT</strong> for symptoms, <strong className="text-emerald-300 font-medium">ICD-10</strong> for conditions, and <strong className="text-amber-300 font-medium">LOINC</strong> for lab measurements.
            </p>
          </div>
        </div>
        
        <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          {isMappingAll ? (
            <div className="flex-1 flex items-center gap-3">
              <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div 
                  className="bg-blue-500 h-1.5 transition-all duration-300" 
                  style={{ width: `${(mapAllProgress.current / mapAllProgress.total) * 100}%` }}
                ></div>
              </div>
              <span className="text-[10px] text-slate-400 font-mono whitespace-nowrap shrink-0">
                {mapAllProgress.current} of {mapAllProgress.total} mapped
              </span>
            </div>
          ) : (
            <>
              <span className="text-[10px] text-slate-500 font-mono">
                Automatic concept mapping
              </span>
              <button
                onClick={handleMapAllEntities}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-[11px] rounded-lg shadow-sm transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
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
          <div key={cat.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm animate-fadeIn">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-slate-50 border border-slate-100 rounded-lg">
                  {getCategoryIcon(cat.id)}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{cat.displayName}</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">Annotate details for {cat.displayName.toLowerCase()}</p>
                </div>
              </div>
              {!isReadOnly && (
                <button
                  onClick={() => handleAddNewItem(cat.id)}
                  title={`Add ${cat.displayName.endsWith('s') ? cat.displayName.slice(0, -1) : cat.displayName}`}
                  className="p-1.5 text-indigo-600 hover:text-indigo-700 bg-indigo-50/70 hover:bg-indigo-100 rounded-lg transition-all cursor-pointer flex items-center justify-center shrink-0"
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
            </div>

            {isCatEmpty ? (
              <p className="text-xs text-slate-400 italic text-center py-4">No {cat.displayName.toLowerCase()} documented in annotations.</p>
            ) : (
              <div className="space-y-3">
                {items.map((item, idx) => {
                  const isSelected = selectedEntityId === item.entityId;
                  const isEditing = editingIndex?.category === cat.id && editingIndex?.index === idx;

                  // Find primary attribute (either 'name' or 'task' or first string)
                  const primaryAttr = cat.attributes.find(attr => attr.name === 'name' || attr.name === 'task') || cat.attributes[0];
                  const primaryValue = item.name || item.task || item[primaryAttr.name] || (item.entityId ? (entities.find(e => e.id === item.entityId)?.name) : '') || `New ${cat.displayName}`;

                  return (
                    <div
                      key={`${cat.id}-${idx}`}
                      ref={el => { itemRefs.current[item.entityId] = el; }}
                      onClick={() => !isEditing && handleItemClick(item.entityId)}
                      className={`p-3 rounded-xl border transition-all duration-200 group relative ${
                        isEditing
                          ? 'border-indigo-400 bg-indigo-50/10 ring-2 ring-indigo-50'
                          : isSelected
                          ? 'border-indigo-400 bg-indigo-50/40 shadow-sm'
                          : 'border-slate-150 bg-slate-50/40 hover:border-slate-300 hover:bg-slate-50/80 cursor-pointer'
                      }`}
                    >
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
                                <div key={attr.name} className="flex flex-col gap-1">
                                  <span className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider min-h-[28px] flex items-end pb-1 leading-tight">
                                    {attrDisplayName}
                                  </span>
                                  {attr.type === 'select' ? (
                                    <select
                                      value={activeForm[attr.name] || ''}
                                      onChange={e => setActiveForm({ ...activeForm, [attr.name]: e.target.value })}
                                      className="w-full text-xs border border-slate-200 hover:border-slate-300 focus:border-indigo-500 rounded-lg px-2.5 h-9 bg-white focus:ring-1 focus:ring-indigo-400 focus:outline-none transition-colors shadow-sm"
                                    >
                                      {(attr.choices || []).map(choice => (
                                        <option key={choice} value={choice}>{choice}</option>
                                      ))}
                                    </select>
                                  ) : attr.type === 'boolean' ? (
                                    <div className="flex items-center h-9">
                                      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none">
                                        <input
                                          type="checkbox"
                                          checked={!!activeForm[attr.name]}
                                          onChange={e => setActiveForm({ ...activeForm, [attr.name]: e.target.checked })}
                                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-400 h-4 w-4"
                                        />
                                        {attr.hint || `Is ${attrDisplayName}`}
                                      </label>
                                    </div>
                                  ) : attr.type === 'textarea' ? (
                                    <textarea
                                      value={activeForm[attr.name] || ''}
                                      onChange={e => setActiveForm({ ...activeForm, [attr.name]: e.target.value })}
                                      className="w-full text-xs border border-slate-200 hover:border-slate-300 focus:border-indigo-500 rounded-lg px-2.5 py-1.5 focus:ring-1 focus:ring-indigo-400 focus:outline-none min-h-[72px] bg-white transition-colors shadow-sm"
                                      placeholder={attr.hint || `Enter ${attrDisplayName.toLowerCase()}`}
                                    />
                                  ) : (
                                    <input
                                      type={attr.type === 'number' ? 'number' : 'text'}
                                      value={activeForm[attr.name] || ''}
                                      onChange={e => setActiveForm({ ...activeForm, [attr.name]: e.target.value })}
                                      className="w-full text-xs border border-slate-200 hover:border-slate-300 focus:border-indigo-500 rounded-lg px-2.5 h-9 bg-white focus:ring-1 focus:ring-indigo-400 focus:outline-none transition-colors shadow-sm"
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
                              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 font-bold text-xs cursor-pointer shadow-sm transition-colors"
                            >
                              Save
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-slate-800 font-bold text-xs">
                                {primaryValue}
                              </span>
                            </div>
                            {!isReadOnly && (
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => { e.stopPropagation(); startEdit(cat.id, idx, item); }}
                                  className="p-1 text-slate-400 hover:text-indigo-500 cursor-pointer"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDelete(cat.id, idx, item.entityId); }}
                                  className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Attributes render */}
                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            {cat.attributes
                              .filter(attr => attr.name !== primaryAttr.name && item[attr.name] !== undefined && item[attr.name] !== '')
                              .map(attr => {
                                const val = item[attr.name];
                                const isBoldValue = attr.type === 'select' && val !== 'Unspecified';
                                const attrDisplayName = attr.displayName || attr.name.replace(/([A-Z])/g, ' $1').replace(/^[a-z]/, (str: string) => str.toUpperCase()).trim();
                                return (
                                  <span
                                    key={attr.name}
                                    className={`text-[9px] px-1.5 py-0.5 rounded-md font-medium border ${
                                      isBoldValue
                                        ? 'bg-indigo-50/50 text-indigo-700 border-indigo-100 font-bold'
                                        : 'bg-slate-100/50 text-slate-600 border-slate-200'
                                    }`}
                                  >
                                    <span className="text-slate-400 font-mono font-medium">{attrDisplayName}:</span> {val === true ? 'Yes' : val === false ? 'No' : String(val)}
                                  </span>
                                );
                              })}
                          </div>

                          {renderUmlsBadges(item.entityId, primaryValue, cat.entityType)}

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
              <p className="text-[10px] text-slate-400 mt-0.5">Dosages, Providers, Patients, or other helper terms</p>
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
          <p className="text-xs text-slate-400 italic text-center py-4">No additional support attributes documented.</p>
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
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Attribute Name</label>
                          <input
                            type="text"
                            value={supportForm.name || ''}
                            onChange={e => setSupportForm({ ...supportForm, name: e.target.value })}
                            placeholder="e.g. 50mg, Dr. Smith"
                            className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400 mt-0.5"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Entity Type</label>
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
                        <label className="text-[10px] font-bold text-slate-400 uppercase font-mono">Description / Notes</label>
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
                          className="p-1 text-slate-400 hover:text-slate-600 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
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
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                              {ent.type}
                            </span>
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit('support', idx, ent); }}
                            className="p-1 text-slate-400 hover:text-amber-500 cursor-pointer"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteSupport(ent.id); }}
                            className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      {ent.description && (
                        <p className="text-[10px] text-slate-500 mt-1.5 border-t border-dashed border-slate-100/80 pt-1">
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
            <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg">
              <Link2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Graph Relations Manager</h3>
              <p className="text-[10px] text-slate-400 mt-0.5">Link manual additions to create structured concepts</p>
            </div>
          </div>
          {selectedEntityId && (
            <div className="bg-amber-50 border border-amber-100 px-2 py-0.5 rounded text-[10px] font-medium text-amber-700 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>
              Focusing: {entities.find(e => e.id === selectedEntityId)?.name || 'Focus Entity'}
            </div>
          )}
        </div>

        {/* Add Relation Form */}
        <form onSubmit={handleAddRelation} className="space-y-3 bg-slate-50/50 p-3 rounded-lg border border-slate-100">
          <div className="text-[10px] font-bold text-slate-500 uppercase font-mono tracking-wider">
            Establish New Relationship
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {/* Source Entity Select */}
            <div>
              <label className="block text-[9px] font-bold text-slate-400 uppercase font-mono mb-1">Source Entity</label>
              <select
                value={newRelSource}
                onChange={e => setNewRelSource(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
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
              <label className="block text-[9px] font-bold text-slate-400 uppercase font-mono mb-1">Relationship Type</label>
              <select
                value={newRelType}
                onChange={e => setNewRelType(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
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
              <label className="block text-[9px] font-bold text-slate-400 uppercase font-mono mb-1">Target Entity</label>
              <select
                value={newRelTarget}
                onChange={e => setNewRelTarget(e.target.value)}
                required
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
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
              className={`flex items-center gap-1 text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                !newRelSource || !newRelTarget
                  ? 'bg-slate-50 text-slate-400 border-slate-100 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-500 hover:shadow-md'
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
            <span className="text-[10px] font-bold text-slate-500 uppercase font-mono tracking-wider">
              Active Map Connections ({relations.length})
            </span>
          </div>

          {relations.length === 0 ? (
            <p className="text-xs text-slate-400 italic text-center py-4 bg-slate-50/20 border border-dashed border-slate-100 rounded-lg">
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
                        ? 'bg-indigo-50/40 border-indigo-200 shadow-sm'
                        : 'bg-white border-slate-100 hover:border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1 flex-wrap font-medium">
                      <span
                        onClick={() => onSelectEntity(rel.source)}
                        className={`cursor-pointer px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-700 hover:bg-slate-200 ${
                          rel.source === selectedEntityId ? 'ring-1 ring-amber-500 font-bold' : ''
                        }`}
                      >
                        {sourceEnt ? sourceEnt.name : 'Unknown'}
                      </span>
                      <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.2 rounded uppercase font-mono">
                        {rel.type}
                      </span>
                      <span
                        onClick={() => onSelectEntity(rel.target)}
                        className={`cursor-pointer px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-700 hover:bg-slate-200 ${
                          rel.target === selectedEntityId ? 'ring-1 ring-amber-500 font-bold' : ''
                        }`}
                      >
                        {targetEnt ? targetEnt.name : 'Unknown'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteRelation(rel.id)}
                      className="p-1 text-slate-400 hover:text-rose-500 rounded transition-colors cursor-pointer ml-2"
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
        <div className="text-[10px] font-bold text-slate-400 uppercase mb-2 tracking-wider font-mono">
          Clinical Instance Registry (JSON Node binding)
        </div>
        <div className="bg-slate-900 rounded-lg p-3 text-[10.5px] font-mono text-emerald-400 overflow-x-auto max-h-[160px] scrollbar-thin select-all">
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
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs"
          onClick={() => setActiveUmlsEditEntityId(null)}
        >
          <div 
            className="bg-white rounded-xl shadow-2xl border border-slate-200 max-w-2xl w-full flex flex-col overflow-hidden max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Beaker className="w-5 h-5 text-blue-400" />
                <div>
                  <h3 className="font-semibold text-sm">Manual UMLS Concept Mapping</h3>
                  <p className="text-[10px] text-slate-300 font-mono mt-0.5">
                    Entity: "{entities.find(e => e.id === activeUmlsEditEntityId)?.name}" ({entities.find(e => e.id === activeUmlsEditEntityId)?.type})
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setActiveUmlsEditEntityId(null)}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer p-1 rounded-md hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-5 divide-y divide-slate-100 max-h-[calc(90vh-120px)] scrollbar-thin">
              
              {/* Part 1: UTS Search Engine */}
              <div className="space-y-3">
                <div>
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider font-mono flex items-center gap-1.5">
                    <Search className="w-3.5 h-3.5 text-blue-500" />
                    <span>Search UMLS Metathesaurus</span>
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Query NLM's UTS to search over 100 vocabularies. Selected concepts will automatically auto-fill code registries.
                  </p>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={umlsSearchQuery}
                    onChange={(e) => setUmlsSearchQuery(e.target.value)}
                    placeholder="Search query (e.g. edema, heart failure, paracetamol)..."
                    className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2 bg-slate-50/50 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white"
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
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-100 disabled:text-slate-400 text-white font-semibold text-xs rounded-lg transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
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
                  <p className="text-[11px] text-rose-500 font-medium bg-rose-50 border border-rose-100 rounded-md p-2 flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>{umlsEditError}</span>
                  </p>
                )}

                {umlsSearchResults.length > 0 && (
                  <div className="border border-slate-100 rounded-lg overflow-hidden bg-slate-50/50 max-h-[160px] overflow-y-auto scrollbar-thin">
                    <div className="bg-slate-100 px-3 py-1.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider font-mono">
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
                          <span className="font-mono text-[10px] text-blue-600 font-bold bg-blue-50 px-1.5 py-0.5 rounded shrink-0">
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
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider font-mono flex items-center gap-1.5">
                    <Settings className="w-3.5 h-3.5 text-purple-500" />
                    <span>Direct Registry Overrides</span>
                  </h4>
                  {fetchCodesLoading && (
                    <div className="flex items-center gap-1.5 text-[10px] text-purple-600 font-semibold font-mono animate-pulse">
                      <span className="w-2.5 h-2.5 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin"></span>
                      <span>Resolving vocabulary mappings...</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Concept Name */}
                  <div className="md:col-span-2">
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      Preferred Concept Name
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.preferredName}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, preferredName: e.target.value }))}
                      placeholder="Preferred standardized term name..."
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* CUI */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      UMLS CUI (Concept Unique Identifier)
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.cui}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, cui: e.target.value }))}
                      placeholder="CXXXXXXX"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* SNOMED */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      SNOMED-CT Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.snomed}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, snomed: e.target.value }))}
                      placeholder="e.g. 29857009"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* RxNorm */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      RxNorm Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.rxnorm}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, rxnorm: e.target.value }))}
                      placeholder="e.g. 1191"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* ICD-10 */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      ICD-10 Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.icd10}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, icd10: e.target.value }))}
                      placeholder="e.g. I10, R60.9"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>

                  {/* LOINC */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono mb-1">
                      LOINC Code
                    </label>
                    <input
                      type="text"
                      value={customUmlsMapping.loinc}
                      onChange={(e) => setCustomUmlsMapping(prev => ({ ...prev, loinc: e.target.value }))}
                      placeholder="e.g. 1751-7"
                      className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
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
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-transparent text-white font-semibold text-xs rounded-lg transition-all cursor-pointer shadow-xs border border-indigo-500 hover:shadow-md"
                >
                  Save Mapping
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
