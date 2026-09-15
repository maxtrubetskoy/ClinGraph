import { formatAttributeValue } from '../utils/attributeValues';
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { TranscriptSegment, Entity, ClinicalCategory, EntityType, Mention, Relation, AnnotationCategory, DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema, getPrimaryAttribute, getItemDisplayName } from '../types';
import { MessageSquare, Plus, X, Sparkles, Brain, Info, FileText, Trash2, Scissors, ChevronDown, UserCheck } from 'lucide-react';
import { getMentionAttributeName } from '../utils/evidence';
import { mentionRoleLabel, mentionContextLabel, mentionContextDefaults, normalizeMentionContext, type MentionEvidenceRole } from '../utils/mentionContext';
import { calculateGlobalWordSpan } from '../utils/wordAnchoring';

const annotationFieldLabelClass = 'text-2xs font-semibold text-slate-500 uppercase font-sans';
const annotationFieldSelectClass = 'w-full text-xs border border-slate-200 rounded-lg p-1.5 focus:outline-none focus:ring-2 focus:ring-brand-400 bg-white font-medium text-slate-800';

interface RawTranscriptViewProps {
  segments: TranscriptSegment[];
  entities?: Entity[];
  mentions?: Mention[];
  selectedEntityId?: string | null;
  onSelectEntity?: (id: string | null) => void;
  selectedMentionId?: string | null;
  onSelectMention?: (id: string | null) => void;
  onUpdateNotes?: (updatedNotes: ClinicalCategory, updatedEntities: Entity[], updatedRelations?: Relation[], updatedMentions?: Mention[]) => void;
  clinicalNotes?: ClinicalCategory;
  encounterType?: 'dialogue' | 'note';
  annotationSchema?: AnnotationCategory[];
  onSplitUtterance?: (segmentIndex: number, splitCharOffset: number, newSpeaker: string) => void;
  onChangeSpeaker?: (segmentIndex: number, newSpeaker: string) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getSegmentsWithTimestamps(segmentsList: TranscriptSegment[]): (TranscriptSegment & { displayTimestamp: string })[] {
  let accumulatedSeconds = 0;
  return segmentsList.map((seg) => {
    let ts = seg.timestamp || '';
    if (!ts) {
      // Estimate 150 words per minute => 2.5 words per second
      const words = seg.text.split(/\s+/).filter(Boolean).length || 5;
      const duration = Math.max(Math.round(words / 2.5), 3); // minimum 3 seconds
      const endSeconds = accumulatedSeconds + duration;
      ts = `${formatTime(accumulatedSeconds)} - ${formatTime(endSeconds)}`;
      accumulatedSeconds = endSeconds + 1; // 1 second break between turns
    } else {
      // Try to parse existing format like "MM:SS - MM:SS" to keep sequential flow in sync
      const match = ts.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (match) {
        const endSec = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
        accumulatedSeconds = endSec + 1;
      } else {
        accumulatedSeconds += 10;
      }
    }
    return {
      ...seg,
      displayTimestamp: ts
    };
  });
}

function getSelectionCharacterOffsetWithin(element: HTMLElement) {
  let start = 0;
  let end = 0;
  const doc = element.ownerDocument || document;
  const win = doc.defaultView || window;
  const sel = win.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.startContainer, range.startOffset);
    start = preCaretRange.toString().length;
    end = start + range.toString().length;
  }
  return { start, end };
}

export default function RawTranscriptView({
  segments,
  entities = [],
  mentions = [],
  selectedEntityId = null,
  onSelectEntity,
  selectedMentionId = null,
  onSelectMention,
  onUpdateNotes,
  clinicalNotes,
  encounterType = 'dialogue',
  annotationSchema,
  onSplitUtterance,
  onChangeSpeaker
}: RawTranscriptViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const activeSchema = useMemo(() => {
    const base = annotationSchema && annotationSchema.length > 0 ? annotationSchema : DEFAULT_ANNOTATION_SCHEMA;
    return normalizeAnnotationSchema(base);
  }, [annotationSchema]);

  const [pendingAnnotation, setPendingAnnotation] = useState<{
    lineIndex: number;
    startChar: number;
    endChar: number;
    text: string;
  } | null>(null);

  const [annotationMode, setAnnotationMode] = useState<'annotate' | 'split'>('annotate');
  const [splitSpeaker, setSplitSpeaker] = useState<string>('Patient');

  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(() => {
    return activeSchema[0]?.id || 'symptoms';
  });
  const [selectedEntityToMap, setSelectedEntityToMap] = useState<string>('__new__');
  const [evidenceKind, setEvidenceKind] = useState<'entity' | 'attribute'>('entity');
  const [selectedAttributeId, setSelectedAttributeId] = useState('');
  const [evidenceRole, setEvidenceRole] = useState<MentionEvidenceRole>('unassigned');
  useEffect(() => { setEvidenceRole('unassigned'); }, [pendingAnnotation]);
  useEffect(() => {
    if (selectedEntityToMap === '__new__') setEvidenceKind('entity');
    setSelectedAttributeId('');
  }, [selectedEntityToMap, pendingAnnotation]);
  const parentEntity = entities.find(entity => entity.id === selectedEntityToMap);
  const attributeOptions = parentEntity?.attributes || [];

  // Synchronize selectedCategoryId if activeSchema changes
  useEffect(() => {
    if (activeSchema.length > 0 && !activeSchema.some(c => c.id === selectedCategoryId)) {
      setSelectedCategoryId(activeSchema[0].id);
    }
  }, [activeSchema, selectedCategoryId]);

  const selectedCategory = useMemo(() => {
    return activeSchema.find(c => c.id === selectedCategoryId) || activeSchema[0];
  }, [activeSchema, selectedCategoryId]);

  // Reset selectedEntityToMap when category changes
  useEffect(() => {
    setSelectedEntityToMap('__new__');
  }, [selectedCategoryId]);

  // Eligible existing entities matching the selected category
  const eligibleEntitiesForCategory = useMemo(() => {
    if (!selectedCategory) return entities;
    return entities.filter(ent => {
      if (ent.categoryId) return ent.categoryId === selectedCategory.id;
      const entTypeLower = (ent.type || '').toLowerCase();
      const catIdLower = (selectedCategory.id || '').toLowerCase();
      const catDisplayNameLower = (selectedCategory.displayName || '').toLowerCase();
      const catEntityTypeLower = (selectedCategory.entityType || '').toLowerCase();

      return (
        entTypeLower === catIdLower ||
        entTypeLower === catDisplayNameLower ||
        entTypeLower === catEntityTypeLower ||
        entTypeLower.includes(catEntityTypeLower) ||
        catEntityTypeLower.includes(entTypeLower)
      );
    });
  }, [entities, selectedCategory]);

  const derivedMentions = mentions;

  const enrichedSegments = getSegmentsWithTimestamps(segments);

  const handleTextSelection = (event: React.MouseEvent<HTMLDivElement>, lineIndex: number) => {
    if (!onUpdateNotes) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    const container = event.currentTarget;
    const offsets = getSelectionCharacterOffsetWithin(container);

    if (offsets.start >= 0 && offsets.end > offsets.start) {
      const seg = enrichedSegments[lineIndex];
      const currentSpeaker = (seg?.speaker || '').toLowerCase();
      const defaultOpposite = currentSpeaker.includes('doc') || currentSpeaker.includes('dr') || currentSpeaker.includes('physician')
        ? 'Patient'
        : 'Doctor';
      setSplitSpeaker(defaultOpposite);
      setAnnotationMode('annotate');
      setPendingAnnotation({
        lineIndex,
        startChar: offsets.start,
        endChar: offsets.end,
        text: selectedText
      });
    }
  };

  const handleCreateEntityFromSpan = () => {
    if (!pendingAnnotation || !onUpdateNotes) return;
    if (evidenceKind === 'attribute' && !attributeOptions.some(attribute => attribute.id === selectedAttributeId)) return;

    const notes = clinicalNotes || { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] };
    const currentEntities = entities || [];
    const currentMentions = derivedMentions;

    let targetEntityId = selectedEntityToMap;
    let updatedEntities = [...currentEntities];
    let updatedNotes: Record<string, any> = { ...notes };

    const targetCat = selectedCategory || activeSchema[0];
    const catId = targetCat ? targetCat.id : 'symptoms';
    const catEntityType = targetCat ? targetCat.entityType : 'Symptom';
    const primaryAttr = getPrimaryAttribute(targetCat);

    if (selectedEntityToMap === '__new__') {
      targetEntityId = `e_user_${Date.now()}`;

      const newItem: Record<string, any> = { entityId: targetEntityId };
      if (targetCat && targetCat.attributes && targetCat.attributes.length > 0) {
        targetCat.attributes.forEach(attr => {
          if (attr.name === primaryAttr.name || attr.name === 'name' || attr.name === 'task' || attr.name === 'title') {
            newItem[attr.name] = pendingAnnotation.text;
          } else if (attr.type === 'select') {
            const unassignedChoice = attr.choices?.find(c => c.toLowerCase() === 'unassigned');
            newItem[attr.name] = unassignedChoice || (attr.choices && attr.choices.length > 0 ? attr.choices[0] : 'unassigned');
          } else if (attr.type === 'boolean') {
            newItem[attr.name] = false;
          } else {
            newItem[attr.name] = attr.name.toLowerCase().includes('status') ? 'unassigned' : '';
          }
        });
      } else {
        newItem.name = pendingAnnotation.text;
        newItem.details = 'Selected from dialogue';
      }
      newItem[primaryAttr.name] = pendingAnnotation.text;
      newItem.name = pendingAnnotation.text;

      if (!updatedNotes[catId]) {
        updatedNotes[catId] = [];
      }
      updatedNotes[catId] = [...(updatedNotes[catId] as any[]), newItem];

      const detailsParts = targetCat?.attributes
        ?.filter(attr => attr.name !== primaryAttr.name && attr.name !== 'name' && attr.name !== 'task' && attr.name !== 'title' && newItem[attr.name])
        ?.map(attr => `${attr.name}: ${formatAttributeValue(newItem[attr.name])}`)
        ?.filter(Boolean) || [];

      const targetSeg = enrichedSegments[pendingAnnotation.lineIndex];
      const wordSpan = calculateGlobalWordSpan(
        enrichedSegments,
        pendingAnnotation.lineIndex,
        pendingAnnotation.startChar,
        pendingAnnotation.endChar
      );

      const newEntity: Entity = {
        id: targetEntityId,
        name: pendingAnnotation.text,
        type: catEntityType,
        categoryId: catId,
        description: detailsParts.join(' | ') || `${targetCat?.displayName || catEntityType} (Annotated manually from dialogue)`,
        textSpan: {
          lineIndex: pendingAnnotation.lineIndex,
          startChar: pendingAnnotation.startChar,
          endChar: pendingAnnotation.endChar,
          text: pendingAnnotation.text,
          segmentId: targetSeg?.id,
          speaker: targetSeg?.speaker,
          globalStartWord: wordSpan?.globalStartWord,
          globalEndWord: wordSpan?.globalEndWord
        }
      };
      updatedEntities.push(newEntity);
    }

    const targetSeg = enrichedSegments[pendingAnnotation.lineIndex];
    const wordSpan = calculateGlobalWordSpan(
      enrichedSegments,
      pendingAnnotation.lineIndex,
      pendingAnnotation.startChar,
      pendingAnnotation.endChar
    );

    const newMentionId = `m_user_${Date.now()}`;
    const newMention: Mention = normalizeMentionContext({
      id: newMentionId,
      segmentId: targetSeg?.id,
      globalStartWord: wordSpan?.globalStartWord,
      globalEndWord: wordSpan?.globalEndWord,
      textSpan: {
        lineIndex: pendingAnnotation.lineIndex,
        startChar: pendingAnnotation.startChar,
        endChar: pendingAnnotation.endChar,
        text: pendingAnnotation.text,
        segmentId: targetSeg?.id,
        speaker: targetSeg?.speaker,
        globalStartWord: wordSpan?.globalStartWord,
        globalEndWord: wordSpan?.globalEndWord
      },
      speaker: targetSeg?.speaker || 'unassigned',
      entityType: catEntityType,
      entityId: targetEntityId,
      evidenceRole,
      target: evidenceKind === 'attribute'
        ? { kind: 'attribute', entityId: targetEntityId, attributeId: selectedAttributeId }
        : { kind: 'entity', entityId: targetEntityId },
      ...mentionContextDefaults(evidenceRole),
      experiencer: 'unassigned',
    });

    const updatedMentions = [...currentMentions, newMention];

    // Explicitly flag to NEVER auto-scroll away to older mentions when adding a mention
    skipAutoScrollRef.current = true;

    onUpdateNotes(updatedNotes as ClinicalCategory, updatedEntities, undefined, updatedMentions);
    setPendingAnnotation(null);
    setSelectedAttributeId('');
    setSelectedEntityToMap('__new__');
    // Selecting an entity clears the old mention selection in App. Select the new
    // mention afterwards so its role/context editor remains open after creation.
    if (onSelectEntity && targetEntityId) {
      onSelectEntity(targetEntityId);
    }
    if (onSelectMention) {
      onSelectMention(newMentionId);
    }
  };

  const skipAutoScrollRef = useRef<boolean>(false);
  const prevSelectionRef = useRef<{ entityId: string | null; mentionId: string | null }>({
    entityId: null,
    mentionId: null
  });

  // Auto-scroll to highlighted segment or specific mention ONLY when selections explicitly change
  useEffect(() => {
    if (!containerRef.current) return;

    // If a mention was just added by the user, do NOT scroll away to older mentions!
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      prevSelectionRef.current = {
        entityId: selectedEntityId,
        mentionId: selectedMentionId
      };
      return;
    }

    const selectionChanged =
      prevSelectionRef.current.entityId !== selectedEntityId ||
      prevSelectionRef.current.mentionId !== selectedMentionId;

    prevSelectionRef.current = {
      entityId: selectedEntityId,
      mentionId: selectedMentionId
    };

    // If selection did not change or no selection is active, or if user is interacting with an input / textarea, do NOT scroll
    if (!selectionChanged || (!selectedMentionId && !selectedEntityId)) return;

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
      return;
    }

    if (selectedMentionId) {
      const element = containerRef.current.querySelector(`#mention-${selectedMentionId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Pulse animation effect
        element.classList.add('ring-4', 'ring-brand-400', 'ring-offset-1', 'scale-110');
        const timer = setTimeout(() => {
          element.classList.remove('ring-4', 'ring-brand-400', 'ring-offset-1', 'scale-110');
        }, 2500);
        return () => clearTimeout(timer);
      } else {
        // Fallback: scroll to the segment containing the selected mention
        const mention = derivedMentions.find(m => m.id === selectedMentionId);
        if (mention && mention.textSpan && mention.textSpan.lineIndex >= 0) {
          const lineIdx = mention.textSpan.lineIndex;
          const element = containerRef.current.querySelector(`[data-segment-idx="${lineIdx}"]`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      }
    } else if (selectedEntityId) {
      // If any mention for this entity is already in view, do NOT jump/scroll
      const entityMentions = derivedMentions.filter(m => m.entityId === selectedEntityId);
      const isAnyMentionVisible = entityMentions.some(m => {
        const el = containerRef.current?.querySelector(`#mention-${m.id}`) as HTMLElement | null;
        if (!el || !containerRef.current) return false;
        const elRect = el.getBoundingClientRect();
        const contRect = containerRef.current.getBoundingClientRect();
        return elRect.top >= contRect.top && elRect.bottom <= contRect.bottom;
      });

      if (!isAnyMentionVisible) {
        const firstMention = entityMentions[0];
        if (firstMention && firstMention.textSpan && firstMention.textSpan.lineIndex >= 0) {
          const lineIdx = firstMention.textSpan.lineIndex;
          const element = containerRef.current.querySelector(`[data-segment-idx="${lineIdx}"]`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      }
    }
  }, [selectedEntityId, selectedMentionId, derivedMentions]);

  if (!segments || segments.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 text-center shadow-sm">
        <MessageSquare className="w-8 h-8 text-slate-300 mx-auto mb-2" />
        <p className="text-xs text-slate-500 italic">No structured transcription dialogue available yet.</p>
      </div>
    );
  }

  // Helper to determine speaker color class
  const getSpeakerColorClass = (speaker: string) => {
    const name = speaker.toLowerCase();
    if (name.includes('doc') || name.includes('dr') || name.includes('physician')) {
      return 'text-blue-500';
    } else if (name.includes('pat') || name.includes('sarah') || name.includes('miller') || name.includes('patient')) {
      return 'text-emerald-500';
    } else {
      return 'text-purple-500';
    }
  };

  const getEntityTypeColor = (type: string) => {
    const t = (type || '').toLowerCase();
    if (t.includes('social') || t.includes('lifestyle') || t.includes('habit')) {
      return 'bg-lime-50 text-lime-800 border-lime-200';
    }
    if (t.includes('symptom') || t.includes('allergy')) {
      return 'bg-amber-50 text-amber-800 border-amber-200';
    }
    if (t.includes('condition') || t.includes('disease') || t.includes('disorder')) {
      return 'bg-orange-50 text-orange-800 border-orange-200';
    }
    if (t.includes('medication') || t.includes('drug') || t.includes('treatment') || t.includes('statement')) {
      return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    }
    if (t.includes('dosage')) {
      return 'bg-sky-50 text-sky-800 border-sky-200';
    }
    if (t.includes('follow') || t.includes('task') || t.includes('plan') || t.includes('procedure') || t.includes('servicerequest') || t.includes('request')) {
      return 'bg-purple-50 text-purple-800 border-purple-200';
    }
    if (t.includes('meas') || t.includes('lab') || t.includes('vital') || t.includes('observation') || t.includes('diagnostic')) {
      return 'bg-teal-50 text-teal-800 border-teal-200';
    }
    return 'bg-blue-50 text-blue-800 border-blue-200';
  };

  const findClosestOccurrence = (text: string, term: string, targetIndex: number) => {
    const lowerText = text.toLowerCase();
    const lowerTerm = term.toLowerCase();

    let bestStart = -1;
    let minDiff = Infinity;

    let index = lowerText.indexOf(lowerTerm);
    while (index !== -1) {
      const diff = Math.abs(index - targetIndex);
      if (diff < minDiff) {
        minDiff = diff;
        bestStart = index;
      }
      index = lowerText.indexOf(lowerTerm, index + 1);
    }

    if (bestStart !== -1) {
      return { start: bestStart, end: bestStart + term.length };
    }
    return { start: targetIndex, end: targetIndex + term.length };
  };

  const renderSegmentText = (segText: string, segIdx: number, segId?: string) => {
    if (derivedMentions.length === 0) return segText;

    // Filter and realign mentions belonging to this segment:
    // Match by segmentId OR lineIndex (with verification that text belongs here)
    const segMentions = derivedMentions.filter(m => {
      if (!m.textSpan) return false;
      // 1. Direct segmentId match
      if (segId && (m.segmentId === segId || m.textSpan.segmentId === segId)) {
        return true;
      }
      // 2. Direct line index match IF the segment text actually contains the span text
      if (m.textSpan.lineIndex === segIdx) {
        if (!m.textSpan.text || segText.toLowerCase().includes(m.textSpan.text.toLowerCase())) {
          return true;
        }
      }
      // 3. Resilient fallback: If this segment contains m.textSpan.text, but m's assigned lineIndex points to a segment that does not have it
      if (m.textSpan.text && segText.toLowerCase().includes(m.textSpan.text.toLowerCase())) {
        const assignedIdx = m.textSpan.lineIndex;
        const assignedSeg = segments && assignedIdx >= 0 && assignedIdx < segments.length ? segments[assignedIdx] : null;
        if (!assignedSeg || !assignedSeg.text.toLowerCase().includes(m.textSpan.text.toLowerCase())) {
          return true;
        }
      }
      return false;
    }).map(m => {
      const span = m.textSpan!;
      let startChar = span.startChar;
      let endChar = span.endChar;

      // If text is provided, find the closest case-insensitive match to align offsets perfectly
      if (span.text && span.text.trim().length > 0) {
        const aligned = findClosestOccurrence(segText, span.text, span.startChar);
        if (aligned.start >= 0) {
          startChar = aligned.start;
          endChar = aligned.end;
        }
      }

      return {
        ...m,
        textSpan: {
          ...span,
          startChar,
          endChar
        }
      };
    }).filter(m =>
      m.textSpan.startChar >= 0 &&
      m.textSpan.endChar > m.textSpan.startChar &&
      m.textSpan.startChar <= segText.length
    );

    if (segMentions.length === 0) return segText;

    // Sort spans to ensure left-to-right processing, avoiding duplicates
    const sortedMentions = [...segMentions].sort((a, b) => {
      const startA = a.textSpan!.startChar;
      const startB = b.textSpan!.startChar;
      return startA - startB;
    });

    const elements: React.ReactNode[] = [];
    let cur = 0;

    for (let i = 0; i < sortedMentions.length; i++) {
      const mention = sortedMentions[i];
      const span = mention.textSpan!;

      // Skip if there's overlap with previous processed span
      if (span.startChar < cur) continue;

      // Add preceding plain text
      if (span.startChar > cur) {
        elements.push(segText.substring(cur, span.startChar));
      }

      // Add highlighted span
      const isSelected = selectedEntityId === mention.entityId;
      const isMentionSelected = selectedMentionId === mention.id;
      const typeColorClass = getEntityTypeColor(mention.entityType);

      // Find canonical entity name if mapped
      const mappedEntity = entities.find(e => e.id === mention.entityId);
      const tooltipText = mappedEntity
        ? `${mention.entityType}: ${mappedEntity.name} ${mappedEntity.umlsMapping ? '🧬 UMLS Mapped' : ''}`
        : `${mention.entityType}: "${span.text}" (Unmapped)`;

      elements.push(
        <span
          key={`m-highlight-${mention.id}-${i}`}
          id={`mention-${mention.id}`}
          onClick={(e) => {
            e.stopPropagation();
            if (onSelectEntity && mention.entityId) {
              onSelectEntity(mention.entityId === selectedEntityId ? null : mention.entityId);
            }
            if (onSelectMention) {
              onSelectMention(mention.id === selectedMentionId ? null : mention.id);
            }
          }}
          className={`inline-block px-1 py-0.5 mx-0.5 rounded font-medium cursor-pointer transition-all duration-200 border text-2xs ${
            isMentionSelected
              ? 'bg-brand-600 text-white border-brand-700 ring-2 ring-brand-400 scale-105 font-semibold shadow-md'
              : isSelected
                ? 'bg-brand-600 text-white border-brand-700 ring-2 ring-brand-300 scale-105 font-semibold shadow-sm'
                : `${typeColorClass} hover:brightness-95 hover:scale-102`
          }`}
          title={tooltipText}
        >
          {segText.substring(span.startChar, span.endChar)}
        </span>
      );

      cur = span.endChar;
    }

    // Add remaining plain text
    if (cur < segText.length) {
      elements.push(segText.substring(cur));
    }

    return elements;
  };

  const activeSelectedMention = selectedMentionId
    ? derivedMentions.find(m => m.id === selectedMentionId)
    : null;
  const activeSelectedMentionEntity = activeSelectedMention
    ? entities.find(e => e.id === activeSelectedMention.entityId)
    : null;

  return (
    <div className="flex flex-col h-[calc(100dvh-200px)] min-h-[440px]">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-4 border-b border-slate-100 shrink-0">
        <div className="flex items-center gap-2">
          {encounterType === 'note' ? (
            <FileText className="w-4 h-4 text-brand-500" />
          ) : (
            <MessageSquare className="w-4 h-4 text-brand-600" />
          )}
          <h3 className="text-sm font-semibold text-slate-800">
            {encounterType === 'note' ? 'Annotated document' : 'Annotated dialogue'}
          </h3>
        </div>
        <div className="text-right">
          <span className="text-2xs text-slate-500 block">Click a term to inspect</span>
          <span className="text-2xs text-brand-600 font-medium block">Select text to add an annotation</span>
        </div>
      </div>

      {activeSelectedMention && !pendingAnnotation && (
        <div className="bg-brand-50/90 border border-brand-200/90 rounded-xl p-2.5 mb-4 shadow-xs flex items-center justify-between gap-3 animate-fadeIn shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="text-2xs font-semibold uppercase tracking-wider text-brand-700 font-sans flex items-center gap-1 shrink-0">
              <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
              Selected Mention:
            </span>
            <span className="text-xs font-semibold italic text-slate-800 bg-white px-2 py-0.5 rounded border border-brand-100 shadow-xs truncate max-w-[200px]" title={activeSelectedMention.textSpan?.text}>
              "{activeSelectedMention.textSpan?.text}"
            </span>
            <span className="text-2xs bg-brand-100 text-brand-800 px-1.5 py-0.5 rounded font-mono font-medium shrink-0">
              {encounterType === 'note' ? `Section ${(activeSelectedMention.textSpan?.lineIndex ?? 0) + 1}` : `U-${activeSelectedMention.textSpan?.lineIndex}`}
            </span>
            {(activeSelectedMention.globalStartWord !== undefined || activeSelectedMention.textSpan?.globalStartWord !== undefined) && (
              <span className="text-2xs bg-slate-200/80 text-slate-700 px-1.5 py-0.5 rounded font-mono font-medium shrink-0" title="Global word count offset across text stream (invariant to utterance splits & speaker changes)">
                Word W{activeSelectedMention.globalStartWord ?? activeSelectedMention.textSpan?.globalStartWord}{(activeSelectedMention.globalEndWord ?? activeSelectedMention.textSpan?.globalEndWord) !== undefined && (activeSelectedMention.globalEndWord ?? activeSelectedMention.textSpan?.globalEndWord) !== (activeSelectedMention.globalStartWord ?? activeSelectedMention.textSpan?.globalStartWord) ? `–W${activeSelectedMention.globalEndWord ?? activeSelectedMention.textSpan?.globalEndWord}` : ''}
              </span>
            )}
            {activeSelectedMention.canonicalName && (
              <span className="text-2xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded font-medium shrink-0" title="Canonical Concept (EN)">
                EN: <strong>{activeSelectedMention.canonicalName}</strong>
              </span>
            )}
            {getMentionAttributeName(activeSelectedMention, entities) && (
              <span className="text-2xs bg-violet-50 text-violet-700 border border-violet-200 px-1.5 py-0.5 rounded font-mono font-semibold shrink-0" title="Supported Entity Attribute">
                attr: {getMentionAttributeName(activeSelectedMention, entities)}
              </span>
            )}
            <span className="text-2xs bg-white text-brand-700 px-1.5 py-0.5 rounded border border-brand-200">
              {mentionRoleLabel(activeSelectedMention.evidenceRole)}
            </span>
            {activeSelectedMention.polarity && (
              <span className={`text-2xs px-1.5 py-0.5 rounded font-mono font-medium shrink-0 border ${
                activeSelectedMention.polarity === 'negative'
                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}>
                {activeSelectedMention.polarity}
              </span>
            )}
            {activeSelectedMention.temporality && (
              <span className="text-2xs bg-slate-50 text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded font-mono font-medium shrink-0">
                Temporality: {mentionContextLabel(activeSelectedMention.temporality)}
              </span>
            )}
            {activeSelectedMention.certainty && (
              <span className="text-2xs bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded font-mono font-medium shrink-0">
                Certainty: {mentionContextLabel(activeSelectedMention.certainty)}
              </span>
            )}
            {activeSelectedMention.experiencer && activeSelectedMention.experiencer !== 'patient' && (
              <span className="text-2xs bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded font-mono font-medium shrink-0">
                exp: {activeSelectedMention.experiencer}
              </span>
            )}
            {activeSelectedMention.function && (
              <span className="text-2xs bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded font-mono font-medium shrink-0">
                Function: {mentionContextLabel(activeSelectedMention.function)}
              </span>
            )}
            {activeSelectedMentionEntity && (
              <span className="text-2xs text-slate-600 font-medium truncate max-w-[200px]">
                Mapped to: <strong className="text-slate-900">{activeSelectedMentionEntity.name}</strong> ({activeSelectedMention.entityType || activeSelectedMentionEntity.type})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onUpdateNotes && (
              <button
                type="button"
                onClick={() => {
                  const updatedMentions = (mentions || []).filter(m => m.id !== activeSelectedMention.id);
                  if (onSelectMention) onSelectMention(null);
                  const notes = clinicalNotes || { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] };
                  onUpdateNotes(notes, entities, undefined, updatedMentions);
                }}
                className="flex items-center gap-1 text-2xs font-semibold text-rose-600 hover:text-rose-700 bg-white hover:bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-lg transition-colors cursor-pointer shadow-xs"
                title="Delete this mention highlight from text (keeps entity in clinical notes)"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                <span>Delete Mention</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (onSelectMention) onSelectMention(null);
              }}
              className="p-1 text-slate-500 hover:text-slate-600 hover:bg-slate-200/60 rounded-lg transition-colors cursor-pointer"
              title="Deselect mention"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {pendingAnnotation && (
        <div className="bg-blue-50/90 border border-blue-200 rounded-xl p-3 mb-4 shadow-md animate-fadeIn shrink-0">
          <div className="flex items-center justify-between pb-2 border-b border-blue-100">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAnnotationMode('annotate')}
                className={`px-2.5 py-1 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer ${
                  annotationMode === 'annotate'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-blue-100/60'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Annotate Entity</span>
              </button>

              {onSplitUtterance && encounterType !== 'note' && (
                <button
                  type="button"
                  onClick={() => setAnnotationMode('split')}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer ${
                    annotationMode === 'split'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-blue-100/60'
                  }`}
                >
                  <Scissors className="w-3.5 h-3.5" />
                  <span>Split Utterance at Selection</span>
                </button>
              )}
            </div>

            <button
              onClick={() => setPendingAnnotation(null)}
              className="text-slate-500 hover:text-slate-600 cursor-pointer font-semibold p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {annotationMode === 'annotate' ? (
            <div className="mt-2.5 space-y-2.5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <span className="text-2xs font-semibold text-slate-500 uppercase font-sans">Selected Span</span>
                  <div className="mt-1 p-2 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 italic truncate" title={pendingAnnotation.text}>
                    "{pendingAnnotation.text}"
                  </div>
                  <div className="mt-0.5 text-2xs text-slate-500 font-mono">
                    Utterance U-{pendingAnnotation.lineIndex}, chars {pendingAnnotation.startChar}-{pendingAnnotation.endChar}
                  </div>
                </div>

                <div>
                  <label className={annotationFieldLabelClass}>Annotation Schema Category</label>
                  <select
                    aria-label="Annotation schema category"
                    value={selectedCategoryId}
                    onChange={(e) => {
                      setSelectedCategoryId(e.target.value);
                      setSelectedEntityToMap('__new__');
                    }}
                    className={`${annotationFieldSelectClass} mt-1`}
                  >
                    {activeSchema.map(cat => (
                      <option key={cat.id} value={cat.id}>
                        {cat.displayName} ({cat.entityType})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Clinical Concept Mapping dropdown */}
              <div className="bg-slate-50 border border-slate-200 p-2.5 rounded-lg space-y-1.5">
                <label className={`${annotationFieldLabelClass} block`}>Clinical Concept Mapping</label>
                <select
                  aria-label="Evidence entity"
                  value={selectedEntityToMap}
                  onChange={(e) => setSelectedEntityToMap(e.target.value)}
                  className={annotationFieldSelectClass}
                >
                  <option value="__new__">🆕 Create new {selectedCategory?.displayName || 'entity'}: "{pendingAnnotation.text}"</option>
                  {eligibleEntitiesForCategory.map(ent => (
                    <option key={ent.id} value={ent.id}>
                      🔗 Link to existing {selectedCategory?.displayName || ent.type}: {ent.name}
                    </option>
                  ))}
                </select>
                <p className="text-2xs text-slate-500 leading-normal">
                  {selectedEntityToMap === '__new__'
                    ? `This will add a new entry to the ${selectedCategory?.displayName || 'clinical'} schema category and register a new canonical entity.`
                    : "Choose whether this text supports the entity itself or one specific attribute below."}
                </p>
              </div>

              <div className="bg-white border border-slate-200 p-2.5 rounded-lg space-y-2">
                <label className="block">
                  <span className={annotationFieldLabelClass}>Evidence supports</span>
                  <select aria-label="Evidence supports" value={evidenceKind}
                    onChange={event => setEvidenceKind(event.target.value as 'entity' | 'attribute')}
                    className={`${annotationFieldSelectClass} mt-1 block`}>
                    <option value="entity">Entity itself</option>
                    <option value="attribute" disabled={selectedEntityToMap === '__new__'}>A specific attribute</option>
                  </select>
                </label>
                {evidenceKind === 'attribute' && (
                  <label className="block">
                    <span className={annotationFieldLabelClass}>Attribute</span>
                    <select aria-label="Evidence attribute" value={selectedAttributeId}
                      onChange={event => setSelectedAttributeId(event.target.value)}
                      className={`${annotationFieldSelectClass} mt-1 block`}>
                      <option value="">Choose an attribute</option>
                      {attributeOptions.map(attribute => (
                        <option key={attribute.id} value={attribute.id}>
                          {attribute.name}: {formatAttributeValue(attribute.value, entities)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="text-2xs text-slate-500">
                  {evidenceKind === 'attribute'
                    ? 'This mention will support only the selected attribute. Edit its value in the clinical notes.'
                    : 'This mention will support the entity itself. To ground an attribute, select an existing entity and choose a specific attribute.'}
                </p>
              </div>

              <div className="flex justify-end gap-1.5 border-t border-blue-100/50 pt-2.5">
                <label className="text-slate-500 mr-auto">
                  <span className={annotationFieldLabelClass}>Evidence role</span>
                  <select aria-label="New mention evidence role" value={evidenceRole}
                    onChange={event => setEvidenceRole(event.target.value as MentionEvidenceRole)}
                    className={`${annotationFieldSelectClass} mt-1 block`}>
                    <option value="unassigned">Unassigned — decide later</option>
                    <option value="reference">Name / reference</option>
                    <option value="claim">Claim evidence</option>
                  </select>
                  <span className="block text-2xs mt-1 max-w-[260px]">
                    {evidenceRole === 'reference' ? 'Identifies what is discussed. Polarity starts neutral; temporality, certainty, and function start as not applicable.'
                      : evidenceRole === 'claim' ? 'Supports a claim. Set its certainty and speech function in the mention editor.'
                      : 'Role is separate from whether the target is an entity or attribute.'}
                  </span>
                </label>
                <button
                  onClick={() => setPendingAnnotation(null)}
                  className="px-2.5 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateEntityFromSpan}
                  disabled={evidenceKind === 'attribute' && !selectedAttributeId}
                  className="px-3.5 py-1 bg-brand-600 hover:bg-brand-700 text-white font-semibold text-xs rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{selectedEntityToMap === '__new__' ? 'Create Entity' : 'Link Evidence'}</span>
                </button>
              </div>
            </div>
          ) : (
            /* Utterance Splitting Mode */
            <div className="mt-2.5 space-y-2.5">
              <p className="text-xs text-slate-700">
                Split utterance <span className="font-mono font-semibold text-brand-700 bg-brand-50 px-1 py-0.5 rounded">U-{pendingAnnotation.lineIndex}</span> into two separate speaker turns right at this cursor position:
              </p>

              {(() => {
                const targetSeg = enrichedSegments[pendingAnnotation.lineIndex];
                const fullText = targetSeg?.text || '';
                const turn1Text = fullText.substring(0, pendingAnnotation.startChar).trim();
                const turn2Text = fullText.substring(pendingAnnotation.startChar).trim();

                return (
                  <div className="space-y-2 text-xs">
                    <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                      <span className="text-2xs font-semibold text-slate-500 uppercase font-sans block mb-1">
                        Turn 1 · {targetSeg?.speaker || 'Speaker'} (Unchanged)
                      </span>
                      <p className="font-mono text-slate-700 text-2xs leading-relaxed break-words bg-slate-50 p-2 rounded">
                        {turn1Text || <span className="italic text-slate-500">(empty)</span>}
                      </p>
                    </div>

                    <div className="bg-white border border-brand-200 rounded-lg p-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-2xs font-semibold text-brand-600 uppercase font-sans">
                          Turn 2 · New Utterance Speaker
                        </span>
                        <select
                          value={splitSpeaker}
                          onChange={(e) => setSplitSpeaker(e.target.value)}
                          className="text-xs font-semibold bg-brand-50 border border-brand-200 text-brand-800 rounded px-2 py-0.5 focus:ring-2 focus:ring-brand-400"
                        >
                          <option value="Patient">Patient</option>
                          <option value="Doctor">Doctor</option>
                          <option value="Clinician">Clinician</option>
                          <option value="Nurse">Nurse</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <p className="font-mono text-slate-700 text-2xs leading-relaxed break-words bg-brand-50/40 p-2 rounded border border-brand-100">
                        {turn2Text || <span className="italic text-slate-500">(empty)</span>}
                      </p>
                    </div>

                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-2xs text-emerald-800 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span>
                        Mentions inside both turns will be strictly preserved and assigned to the correct utterance & speaker!
                      </span>
                    </div>

                    <div className="flex justify-end gap-1.5 border-t border-blue-100/50 pt-2">
                      <button
                        onClick={() => setPendingAnnotation(null)}
                        className="px-2.5 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          if (onSplitUtterance) {
                            onSplitUtterance(pendingAnnotation.lineIndex, pendingAnnotation.startChar, splitSpeaker);
                          }
                          setPendingAnnotation(null);
                        }}
                        className="px-3.5 py-1 bg-brand-600 hover:bg-brand-700 text-white font-semibold text-xs rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-1.5"
                      >
                        <Scissors className="w-3.5 h-3.5" />
                        <span>Confirm & Split Utterance</span>
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto space-y-4 pr-1.5 scroll-smooth">
        {enrichedSegments.map((seg, idx) => {
          const isSelectedSegment = selectedEntityId && derivedMentions.some(m =>
            m.entityId === selectedEntityId &&
            m.textSpan &&
            m.textSpan.lineIndex === idx
          );

          if (encounterType === 'note') {
            // Document section layout for notes (first-class clinical documents)
            const showHeader = seg.speaker &&
              seg.speaker !== 'Document' &&
              seg.speaker !== 'Unknown' &&
              seg.speaker !== 'Speaker' &&
              seg.speaker.trim() !== '';

            return (
              <div
                key={seg.id}
                data-segment-idx={idx}
                className={`transition-all duration-300 p-4 rounded-xl border border-transparent ${
                  isSelectedSegment
                    ? 'bg-brand-50/40 border-brand-200 shadow-sm ring-1 ring-brand-100'
                    : 'hover:bg-slate-50/50'
                }`}
              >
                {showHeader ? (
                  <div className="flex items-center gap-2 mb-2 select-none border-b border-slate-100 pb-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-brand-700">
                      {seg.speaker}
                    </span>
                    <span className="text-2xs bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded font-mono font-medium">
                      Section {idx + 1}
                    </span>
                  </div>
                ) : (
                  <div className="text-2xs text-slate-500 font-mono mb-1.5 select-none">
                    Paragraph {idx + 1}
                  </div>
                )}
                <div
                  className="text-sm leading-relaxed text-slate-700 select-text cursor-text"
                  onMouseUp={(e) => handleTextSelection(e, idx)}
                >
                  {renderSegmentText(seg.text, idx, seg.id)}
                </div>
              </div>
            );
          }

          // Dialogue conversational layout
          const speakerColor = getSpeakerColorClass(seg.speaker);
          return (
            <div
              key={seg.id}
              data-segment-idx={idx}
              className={`flex flex-col sm:flex-row gap-2 sm:gap-4 items-start border-b border-slate-100 pb-4 last:border-0 last:pb-0 transition-all duration-300 p-2 rounded-lg ${
                isSelectedSegment ? 'bg-blue-50/40 border-l-2 border-l-blue-500 shadow-sm ring-1 ring-blue-100' : ''
              }`}
            >
              <div className="shrink-0 w-24 text-2xs font-semibold mt-1 uppercase tracking-wider select-none">
                <div className="flex flex-col gap-1">
                  {onChangeSpeaker ? (
                    <div className="flex items-center gap-1 group relative">
                      <select
                        value={seg.speaker}
                        onChange={(e) => onChangeSpeaker(idx, e.target.value)}
                        className={`text-2xs font-semibold uppercase rounded px-1 py-0.5 border border-slate-200 hover:border-blue-300 bg-white/90 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-400 cursor-pointer ${speakerColor}`}
                        title="Click to switch speaker for this utterance"
                      >
                        <option value={seg.speaker}>{seg.speaker}</option>
                        {['Doctor', 'Patient', 'Clinician', 'Nurse', 'Other'].filter(s => s.toLowerCase() !== seg.speaker.toLowerCase()).map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <span className={speakerColor}>[{seg.speaker}]</span>
                  )}
                  <span className="inline-block text-2xs bg-slate-100 text-slate-600 px-1 py-0.5 rounded font-mono w-fit mt-0.5" title={`Utterance ID: U-${idx} (lineIndex in annotation JSON)`}>
                    U-{idx}
                  </span>
                </div>
                <span className="block text-2xs font-mono text-slate-500 font-normal mt-1" title="Actual or estimated timing bracket">
                  [{seg.displayTimestamp}]
                </span>
              </div>
              <div
                className="flex-1 min-w-0 text-sm leading-relaxed text-slate-700 select-text cursor-text"
                onMouseUp={(e) => handleTextSelection(e, idx)}
              >
                {renderSegmentText(seg.text, idx, seg.id)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
