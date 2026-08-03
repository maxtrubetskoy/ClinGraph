import React, { useEffect, useRef, useState } from 'react';
import { TranscriptSegment, Entity, ClinicalCategory, EntityType, Mention, Relation } from '../types';
import { MessageSquare, Plus, X, Sparkles, Brain, Info, FileText } from 'lucide-react';

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
  encounterType = 'dialogue'
}: RawTranscriptViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const [pendingAnnotation, setPendingAnnotation] = useState<{
    lineIndex: number;
    startChar: number;
    endChar: number;
    text: string;
  } | null>(null);

  const [newEntityType, setNewEntityType] = useState<EntityType>('Symptom');
  const [selectedEntityToMap, setSelectedEntityToMap] = useState<string>('__new__');

  // Reset selectedEntityToMap when type changes
  useEffect(() => {
    setSelectedEntityToMap('__new__');
  }, [newEntityType]);

  // Derive mentions from entities for older sessions or default state
  const derivedMentions: Mention[] = mentions && mentions.length > 0
    ? mentions
    : (entities || [])
        .filter(ent => ent.textSpan && ent.textSpan.lineIndex >= 0)
        .map(ent => ({
          id: `m_${ent.id}`,
          textSpan: ent.textSpan!,
          entityType: ent.type,
          entityId: ent.id
        }));

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

    const notes = clinicalNotes || { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] };
    const currentEntities = entities || [];
    const currentMentions = derivedMentions;

    let targetEntityId = selectedEntityToMap;
    let updatedEntities = [...currentEntities];
    let updatedNotes = { ...notes };

    if (selectedEntityToMap === '__new__') {
      targetEntityId = `e_user_${Date.now()}`;
      const newEntity: Entity = {
        id: targetEntityId,
        name: pendingAnnotation.text,
        type: newEntityType,
        description: `${newEntityType} (Annotated manually from dialogue)`,
      };
      updatedEntities.push(newEntity);

      if (newEntityType === 'Symptom') {
        const newSymptom = {
          entityId: targetEntityId,
          name: pendingAnnotation.text,
          severity: 'Unspecified',
          onset: 'Unspecified',
          details: 'Selected from dialogue'
        };
        updatedNotes.symptoms = [...(updatedNotes.symptoms || []), newSymptom];
      } else if (newEntityType === 'Condition') {
        const newCond = {
          entityId: targetEntityId,
          name: pendingAnnotation.text,
          status: 'Active',
          details: 'Selected from dialogue'
        };
        updatedNotes.conditions = [...(updatedNotes.conditions || []), newCond];
      } else if (newEntityType === 'Medication') {
        const newMed = {
          entityId: targetEntityId,
          name: pendingAnnotation.text,
          action: 'Discussed',
          dosage: 'Unspecified',
          details: 'Selected from dialogue'
        };
        updatedNotes.medications = [...(updatedNotes.medications || []), newMed];
      } else if (newEntityType === 'FollowUp') {
        const newFol = {
          entityId: targetEntityId,
          task: pendingAnnotation.text,
          due: 'Unspecified',
          assignee: 'Patient'
        };
        updatedNotes.followUps = [...(updatedNotes.followUps || []), newFol];
      } else if (newEntityType === 'Measurement') {
        const newMeas = {
          entityId: targetEntityId,
          name: pendingAnnotation.text,
          value: 'Unspecified',
          status: 'Stable',
          details: 'Selected from dialogue'
        };
        updatedNotes.measurements = [...(updatedNotes.measurements || []), newMeas];
      }
    }

    const newMentionId = `m_user_${Date.now()}`;
    const newMention: Mention = {
      id: newMentionId,
      textSpan: {
        lineIndex: pendingAnnotation.lineIndex,
        startChar: pendingAnnotation.startChar,
        endChar: pendingAnnotation.endChar,
        text: pendingAnnotation.text
      },
      entityType: newEntityType,
      entityId: targetEntityId
    };

    const updatedMentions = [...currentMentions, newMention];

    onUpdateNotes(updatedNotes, updatedEntities, undefined, updatedMentions);
    setPendingAnnotation(null);
    setSelectedEntityToMap('__new__');
    if (onSelectEntity && targetEntityId) {
      onSelectEntity(targetEntityId);
    }
  };

  // Auto-scroll to highlighted segment or specific mention when selections change
  useEffect(() => {
    if (!containerRef.current) return;

    if (selectedMentionId) {
      const element = containerRef.current.querySelector(`#mention-${selectedMentionId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Pulse animation effect
        element.classList.add('ring-4', 'ring-indigo-400', 'ring-offset-1', 'scale-110');
        const timer = setTimeout(() => {
          element.classList.remove('ring-4', 'ring-indigo-400', 'ring-offset-1', 'scale-110');
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
      const firstMention = derivedMentions.find(m => m.entityId === selectedEntityId);
      if (firstMention && firstMention.textSpan && firstMention.textSpan.lineIndex >= 0) {
        const lineIdx = firstMention.textSpan.lineIndex;
        const element = containerRef.current.querySelector(`[data-segment-idx="${lineIdx}"]`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }
  }, [selectedEntityId, selectedMentionId, derivedMentions]);

  if (!segments || segments.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 text-center shadow-sm">
        <MessageSquare className="w-8 h-8 text-slate-300 mx-auto mb-2" />
        <p className="text-xs text-slate-400 italic">No structured transcription dialogue available yet.</p>
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
    switch (type) {
      case 'Symptom':
        return 'bg-amber-50 text-amber-800 border-amber-200';
      case 'Condition':
        return 'bg-orange-50 text-orange-800 border-orange-200';
      case 'Medication':
        return 'bg-emerald-50 text-emerald-800 border-emerald-200';
      case 'Dosage':
        return 'bg-sky-50 text-sky-800 border-sky-200';
      case 'FollowUp':
        return 'bg-purple-50 text-purple-800 border-purple-200';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
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

  const renderSegmentText = (segText: string, segIdx: number) => {
    if (derivedMentions.length === 0) return segText;

    // Filter and realign mentions belonging to this segment index
    const segMentions = derivedMentions.filter(m => 
      m.textSpan && 
      m.textSpan.lineIndex === segIdx
    ).map(m => {
      const span = m.textSpan!;
      let startChar = span.startChar;
      let endChar = span.endChar;

      // If text is provided, find the closest case-insensitive match to align offsets perfectly
      if (span.text && span.text.trim().length > 0) {
        const aligned = findClosestOccurrence(segText, span.text, span.startChar);
        startChar = aligned.start;
        endChar = aligned.end;
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
          className={`inline-block px-1 py-0.5 mx-0.5 rounded font-medium cursor-pointer transition-all duration-200 border text-[11px] ${
            isMentionSelected
              ? 'bg-indigo-600 text-white border-indigo-700 ring-2 ring-indigo-400 scale-105 font-bold shadow-md'
              : isSelected
                ? 'bg-blue-600 text-white border-blue-700 ring-2 ring-blue-300 scale-105 font-semibold shadow-sm'
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

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col h-[calc(100vh-200px)] max-h-[calc(100vh-8rem)] min-h-[400px]">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100 shrink-0">
        <div className="flex items-center gap-2">
          {encounterType === 'note' ? (
            <FileText className="w-4 h-4 text-indigo-500" />
          ) : (
            <MessageSquare className="w-4 h-4 text-blue-500" />
          )}
          <h3 className="text-sm font-semibold text-slate-800">
            {encounterType === 'note' ? 'Annotated Clinical Document' : 'Diarized Conversation Dialogue'}
          </h3>
        </div>
        <div className="text-right">
          <span className="text-[10px] text-slate-400 font-mono block">Click terms to inspect</span>
          <span className="text-[9px] text-blue-500 font-medium block">Highlight text to annotate new entity</span>
        </div>
      </div>

      {pendingAnnotation && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 shadow-sm animate-fadeIn shrink-0">
          <div className="flex items-center justify-between pb-2 border-b border-blue-100">
            <span className="text-[11px] font-bold text-blue-800 uppercase tracking-wider font-mono flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-blue-600 animate-pulse" />
              New Entity Annotation
            </span>
            <button
              onClick={() => setPendingAnnotation(null)}
              className="text-slate-400 hover:text-slate-600 cursor-pointer font-bold"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-2.5 space-y-2.5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <span className="text-[9px] font-bold text-slate-400 uppercase font-mono">Selected Span</span>
                <div className="mt-1 p-2 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 italic truncate" title={pendingAnnotation.text}>
                  "{pendingAnnotation.text}"
                </div>
                <div className="mt-0.5 text-[8px] text-slate-400 font-mono">
                  Utterance U-{pendingAnnotation.lineIndex}, chars {pendingAnnotation.startChar}-{pendingAnnotation.endChar}
                </div>
              </div>

              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase font-mono">Entity Type</label>
                <select
                  value={newEntityType}
                  onChange={(e) => setNewEntityType(e.target.value as EntityType)}
                  className="w-full text-xs border border-slate-200 rounded-lg p-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 mt-1 bg-white font-medium"
                >
                  <option value="Symptom">Symptom</option>
                  <option value="Condition">Condition</option>
                  <option value="Medication">Medication</option>
                  <option value="Dosage">Dosage</option>
                  <option value="FollowUp">Follow-up Task</option>
                  <option value="Measurement">Measurement</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            {/* Clinical Concept Mapping dropdown */}
            <div className="bg-slate-50 border border-slate-200 p-2.5 rounded-lg space-y-1.5">
              <label className="text-[9px] font-bold text-slate-400 uppercase font-mono block">Clinical Concept Mapping</label>
              <select
                value={selectedEntityToMap}
                onChange={(e) => setSelectedEntityToMap(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-lg p-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white font-medium"
              >
                <option value="__new__">🆕 Create brand new clinical entity: "{pendingAnnotation.text}"</option>
                {entities.filter(ent => ent.type === newEntityType).map(ent => (
                  <option key={ent.id} value={ent.id}>
                    🔗 Link to existing {ent.type}: {ent.name}
                  </option>
                ))}
              </select>
              <p className="text-[9px] text-slate-400 leading-normal">
                {selectedEntityToMap === '__new__' 
                  ? "This will add a new entry to the clinical tables and register a new canonical entity."
                  : "This will add a new occurrence (highlight) of this term in the text, but map it to the same row in your clinical notes, avoiding duplicates."}
              </p>
            </div>

            <div className="flex justify-end gap-1.5 border-t border-blue-100/50 pt-2.5">
              <button
                onClick={() => setPendingAnnotation(null)}
                className="px-2.5 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateEntityFromSpan}
                className="px-3.5 py-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create Entity</span>
              </button>
            </div>
          </div>
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
                    ? 'bg-indigo-50/40 border-indigo-200 shadow-sm ring-1 ring-indigo-100' 
                    : 'hover:bg-slate-50/50'
                }`}
              >
                {showHeader ? (
                  <div className="flex items-center gap-2 mb-2 select-none border-b border-slate-100 pb-1.5">
                    <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                      {seg.speaker}
                    </span>
                    <span className="text-[9px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded font-mono font-medium">
                      Section {idx + 1}
                    </span>
                  </div>
                ) : (
                  <div className="text-[9px] text-slate-400 font-mono mb-1.5 select-none">
                    Paragraph {idx + 1}
                  </div>
                )}
                <div 
                  className="text-[13px] leading-relaxed text-slate-750 select-text cursor-text font-serif"
                  onMouseUp={(e) => handleTextSelection(e, idx)}
                >
                  {renderSegmentText(seg.text, idx)}
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
              className={`flex gap-4 items-start border-b border-slate-50/50 pb-3 last:border-0 last:pb-0 transition-all duration-300 p-2 rounded-xl ${
                isSelectedSegment ? 'bg-blue-50/40 border-l-2 border-l-blue-500 shadow-sm ring-1 ring-blue-100' : ''
              }`}
            >
              <div className="shrink-0 w-24 text-[10px] font-bold mt-1 uppercase tracking-wider select-none">
                <div className="flex flex-col gap-1">
                  <span className={speakerColor}>[{seg.speaker}]</span>
                  <span className="inline-block text-[9px] bg-slate-100 text-slate-600 px-1 py-0.5 rounded font-mono w-fit mt-0.5" title={`Utterance ID: U-${idx} (lineIndex in annotation JSON)`}>
                    U-{idx}
                  </span>
                </div>
                <span className="block text-[8px] font-mono text-slate-400 font-normal mt-1" title="Actual or estimated timing bracket">
                  [{seg.displayTimestamp}]
                </span>
              </div>
              <div 
                className="flex-1 text-xs leading-relaxed text-slate-700 select-text cursor-text"
                onMouseUp={(e) => handleTextSelection(e, idx)}
              >
                {renderSegmentText(seg.text, idx)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
