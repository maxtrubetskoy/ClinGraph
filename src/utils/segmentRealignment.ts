import { TranscriptSegment, Mention, Entity, TextSpan } from '../types';
import {
  calculateGlobalWordSpan,
  resolveGlobalWordSpanToSegment,
  findWordSequenceInGlobalStream,
  enrichMentionWithGlobalWords
} from './wordAnchoring';

/**
 * Finds the occurrence of targetText within text closest to preferredOffset (case-insensitive).
 */
export function findClosestOccurrence(
  fullText: string,
  targetText: string,
  preferredOffset: number = 0
): { start: number; end: number } {
  if (!fullText || !targetText) return { start: -1, end: -1 };

  const lowerFull = fullText.toLowerCase();
  const lowerTarget = targetText.toLowerCase().trim();
  if (!lowerTarget) return { start: -1, end: -1 };

  let bestStart = -1;
  let minDistance = Infinity;

  let pos = lowerFull.indexOf(lowerTarget);
  while (pos !== -1) {
    const dist = Math.abs(pos - preferredOffset);
    if (dist < minDistance) {
      minDistance = dist;
      bestStart = pos;
    }
    pos = lowerFull.indexOf(lowerTarget, pos + 1);
  }

  if (bestStart !== -1) {
    return {
      start: bestStart,
      end: bestStart + lowerTarget.length
    };
  }

  return { start: -1, end: -1 };
}

/**
 * Generates a collision-resistant unique segment ID.
 */
export function generateSegmentId(prefix: string = 'seg'): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 7);
  return `${prefix}_${time}_${rand}`;
}

/**
 * Computes simple word-based similarity between two texts (0 to 1).
 */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const aNorm = a.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const bNorm = b.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  if (aNorm === bNorm) return 1;

  const wordsA = new Set(aNorm.split(/\s+/).filter(Boolean));
  const wordsB = new Set(bNorm.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  wordsA.forEach(w => {
    if (wordsB.has(w)) intersection++;
  });

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Reconciles newly parsed segments with existing segments to preserve stable segment IDs.
 * - Prevents ID shifting when utterances are inserted, deleted, or split.
 * - If an utterance was split into 2+, the first part keeps the original ID, and subsequent parts get derivative IDs.
 */
export function reconcileSegmentsWithExisting(
  newSegments: TranscriptSegment[],
  oldSegments: TranscriptSegment[] = []
): TranscriptSegment[] {
  if (!newSegments || newSegments.length === 0) return [];
  if (!oldSegments || oldSegments.length === 0) {
    return newSegments.map((seg, idx) => ({
      ...seg,
      id: seg.id && !seg.id.match(/^seg_\d+$/) ? seg.id : generateSegmentId(`seg_${idx + 1}`)
    }));
  }

  const assignedOldIds = new Set<string>();
  const reconciled: TranscriptSegment[] = [];

  // Track old segments that were split into multiple new segments
  const splitCounter: Record<string, number> = {};

  for (let i = 0; i < newSegments.length; i++) {
    const newSeg = newSegments[i];
    const newText = newSeg.text.trim();
    let bestOldSeg: TranscriptSegment | null = null;
    let bestScore = -1;
    let matchType: 'exact' | 'split' | 'similar' | 'none' = 'none';

    // Look for best matching old segment
    for (let j = 0; j < oldSegments.length; j++) {
      const oldSeg = oldSegments[j];
      const oldText = oldSeg.text.trim();

      // Proximity penalty: distance between indices
      const distPenalty = Math.abs(i - j) * 0.05;

      // 1. Exact match on text
      if (oldText === newText) {
        const score = 1.0 - distPenalty + (oldSeg.speaker === newSeg.speaker ? 0.2 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestOldSeg = oldSeg;
          matchType = 'exact';
        }
        continue;
      }

      // 2. Split detection: old segment contains new segment
      if (oldText.length > newText.length && oldText.includes(newText) && newText.length >= 8) {
        const score = 0.85 - distPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestOldSeg = oldSeg;
          matchType = 'split';
        }
        continue;
      }

      // 3. Merge detection: new segment contains old segment
      if (newText.length > oldText.length && newText.includes(oldText) && oldText.length >= 8) {
        const score = 0.8 - distPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestOldSeg = oldSeg;
          matchType = 'split';
        }
        continue;
      }

      // 4. Word similarity
      const sim = textSimilarity(oldText, newText);
      if (sim > 0.4) {
        const score = sim - distPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestOldSeg = oldSeg;
          matchType = 'similar';
        }
      }
    }

    if (bestOldSeg && bestScore > 0.35) {
      if (!assignedOldIds.has(bestOldSeg.id)) {
        // First segment to match this old segment keeps its ID
        assignedOldIds.add(bestOldSeg.id);
        reconciled.push({
          ...newSeg,
          id: bestOldSeg.id
        });
      } else {
        // Subsequent segment from a split utterance gets a derived stable ID
        const count = (splitCounter[bestOldSeg.id] || 1) + 1;
        splitCounter[bestOldSeg.id] = count;
        reconciled.push({
          ...newSeg,
          id: `${bestOldSeg.id}_split_${count}`
        });
      }
    } else {
      // Brand-new inserted utterance gets a fresh unique ID
      reconciled.push({
        ...newSeg,
        id: generateSegmentId(`seg_${i + 1}`)
      });
    }
  }

  return reconciled;
}

/**
 * Realigns all mention spans and entity textSpans when transcript segments are modified,
 * inserted, deleted, or split.
 *
 * Handles:
 * 1. An utterance split into several: automatically migrates mentions to the specific split
 *    child segment where the mention text actually lives, updating lineIndex, offsets, and speaker!
 * 2. Utterance insertion: automatically shifts lineIndex of subsequent mentions without breaking.
 * 3. Text editing / typos: recalibrates startChar and endChar.
 */
export function realignMentionsWithSegments(
  oldSegments: TranscriptSegment[] = [],
  newSegments: TranscriptSegment[] = [],
  mentions: Mention[] = [],
  entities: Entity[] = []
): { realignedMentions: Mention[]; realignedEntities: Entity[] } {
  if (!newSegments || newSegments.length === 0) {
    return { realignedMentions: mentions, realignedEntities: entities };
  }

  // Create lookup maps for fast matching
  const segmentById = new Map<string, { seg: TranscriptSegment; index: number }>();
  newSegments.forEach((seg, idx) => {
    segmentById.set(seg.id, { seg, index: idx });
  });

  const realignedMentions = mentions.map(m => {
    const span = m.textSpan;
    if (!span) return m;

    const targetText = (span.text || '').trim();
    if (!targetText) return m;

    const oldLineIdx = span.lineIndex >= 0 ? span.lineIndex : -1;
    const oldStartChar = span.startChar ?? 0;
    const oldSegId = m.segmentId || span.segmentId;
    const oldSegment = oldLineIdx >= 0 && oldLineIdx < oldSegments.length ? oldSegments[oldLineIdx] : null;

    // 0. Primary Anchor: Global Word Count
    // Operates strictly on the concatenated "text" fields, completely immune to utterance splits,
    // merges, speaker corrections (e.g. Doctor to Patient), and timestamp shifts.
    let gStart = m.globalStartWord ?? span.globalStartWord;
    let gEnd = m.globalEndWord ?? span.globalEndWord;

    if (gStart === undefined && oldSegments.length > 0 && oldLineIdx >= 0 && oldLineIdx < oldSegments.length) {
      const calc = calculateGlobalWordSpan(oldSegments, oldLineIdx, oldStartChar, span.endChar);
      if (calc) {
        gStart = calc.globalStartWord;
        gEnd = calc.globalEndWord;
      }
    }

    if (gStart !== undefined && gEnd !== undefined) {
      const wordResolved = resolveGlobalWordSpanToSegment(newSegments, gStart, gEnd);
      if (wordResolved && wordResolved.text && (
        wordResolved.text.toLowerCase().includes(targetText.toLowerCase()) ||
        targetText.toLowerCase().includes(wordResolved.text.toLowerCase())
      )) {
        return {
          ...m,
          globalStartWord: gStart,
          globalEndWord: gEnd,
          segmentId: wordResolved.segmentId,
          speaker: wordResolved.speaker || m.speaker,
          textSpan: {
            ...span,
            lineIndex: wordResolved.segmentIndex,
            startChar: wordResolved.startChar,
            endChar: wordResolved.endChar,
            text: wordResolved.text || span.text,
            segmentId: wordResolved.segmentId,
            speaker: wordResolved.speaker || span.speaker,
            globalStartWord: gStart,
            globalEndWord: gEnd
          }
        };
      }
    }

    // 1. Direct segmentId candidate
    let directCandidate: { seg: TranscriptSegment; index: number } | null = null;
    if (oldSegId && segmentById.has(oldSegId)) {
      directCandidate = segmentById.get(oldSegId)!;
    }

    // Check if direct candidate contains the mention text
    if (directCandidate) {
      const occurrence = findClosestOccurrence(directCandidate.seg.text, targetText, oldStartChar);
      if (occurrence.start >= 0) {
        return {
          ...m,
          segmentId: directCandidate.seg.id,
          speaker: directCandidate.seg.speaker || m.speaker,
          textSpan: {
            ...span,
            lineIndex: directCandidate.index,
            startChar: occurrence.start,
            endChar: occurrence.end,
            text: directCandidate.seg.text.substring(occurrence.start, occurrence.end) || span.text,
            segmentId: directCandidate.seg.id,
            speaker: directCandidate.seg.speaker || span.speaker
          }
        };
      }
    }

    // 2. Utterance was split or inserted: Search across candidate segments in newSegments
    // Prioritize:
    // a) Segments whose ID derives from oldSegId (e.g. seg_xxx_split_2)
    // b) Segments whose text is a substring of oldSegment (split children!)
    // c) Segments geographically close to oldLineIdx
    interface CandidateScore {
      seg: TranscriptSegment;
      index: number;
      occurrence: { start: number; end: number };
      score: number;
    }

    const candidates: CandidateScore[] = [];

    newSegments.forEach((seg, idx) => {
      const occurrence = findClosestOccurrence(seg.text, targetText, oldStartChar);
      if (occurrence.start < 0) return;

      let score = 50;

      // Bonus if ID matches or is a split child of oldSegId
      if (oldSegId) {
        if (seg.id === oldSegId) score += 50;
        else if (seg.id.startsWith(oldSegId)) score += 40;
      }

      // Bonus if this new segment was split from oldSegment's text
      if (oldSegment && oldSegment.text.includes(seg.text)) {
        score += 35;
      }

      // Proximity to old line index
      const distance = Math.abs(idx - (oldLineIdx >= 0 ? oldLineIdx : idx));
      score -= distance * 4;

      // Speaker match bonus
      if (m.speaker && seg.speaker.toLowerCase() === m.speaker.toLowerCase()) {
        score += 15;
      }

      candidates.push({ seg, index: idx, occurrence, score });
    });

    if (candidates.length > 0) {
      // Pick highest scoring candidate
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];

      const wordSpan = calculateGlobalWordSpan(newSegments, best.index, best.occurrence.start, best.occurrence.end);
      const gStartWord = wordSpan?.globalStartWord ?? gStart;
      const gEndWord = wordSpan?.globalEndWord ?? gEnd;

      return {
        ...m,
        globalStartWord: gStartWord,
        globalEndWord: gEndWord,
        segmentId: best.seg.id,
        speaker: best.seg.speaker || m.speaker,
        textSpan: {
          ...span,
          lineIndex: best.index,
          startChar: best.occurrence.start,
          endChar: best.occurrence.end,
          text: best.seg.text.substring(best.occurrence.start, best.occurrence.end) || span.text,
          segmentId: best.seg.id,
          speaker: best.seg.speaker || span.speaker,
          globalStartWord: gStartWord,
          globalEndWord: gEndWord
        }
      };
    }

    // 3. Try global word stream sequence search across the entire transcript text
    const streamMatched = findWordSequenceInGlobalStream(newSegments, targetText, gStart);
    if (streamMatched) {
      return {
        ...m,
        globalStartWord: streamMatched.globalStartWord,
        globalEndWord: streamMatched.globalEndWord,
        segmentId: streamMatched.segmentId,
        speaker: streamMatched.speaker || m.speaker,
        textSpan: {
          ...span,
          lineIndex: streamMatched.segmentIndex,
          startChar: streamMatched.startChar,
          endChar: streamMatched.endChar,
          text: streamMatched.matchedText || span.text,
          segmentId: streamMatched.segmentId,
          speaker: streamMatched.speaker || span.speaker,
          globalStartWord: streamMatched.globalStartWord,
          globalEndWord: streamMatched.globalEndWord
        }
      };
    }

    // Fallback: If text was not found anywhere, keep original data or adjust line index if segmentId matched
    if (directCandidate) {
      return {
        ...m,
        segmentId: directCandidate.seg.id,
        speaker: directCandidate.seg.speaker || m.speaker,
        textSpan: {
          ...span,
          lineIndex: directCandidate.index,
          segmentId: directCandidate.seg.id,
          speaker: directCandidate.seg.speaker || span.speaker
        }
      };
    }

    return m;
  }).map(m => enrichMentionWithGlobalWords(m, newSegments));

  // Also realign entity.textSpan for all entities
  const mentionByEntityId = new Map<string, Mention>();
  realignedMentions.forEach(m => {
    if (m.entityId) {
      mentionByEntityId.set(m.entityId, m);
    }
  });

  const realignedEntities = entities.map(ent => {
    if (!ent.textSpan) return ent;

    // Check if there is an updated mention for this entity
    const matchingMention = mentionByEntityId.get(ent.id);
    if (matchingMention && matchingMention.textSpan) {
      return {
        ...ent,
        textSpan: matchingMention.textSpan
      };
    }

    // Otherwise realign the entity span directly
    const targetText = ent.textSpan.text || ent.name;
    const oldLineIdx = ent.textSpan.lineIndex >= 0 ? ent.textSpan.lineIndex : -1;
    const oldSegId = ent.textSpan.segmentId;

    let targetSeg: { seg: TranscriptSegment; index: number } | null = null;
    if (oldSegId && segmentById.has(oldSegId)) {
      targetSeg = segmentById.get(oldSegId)!;
    } else if (oldLineIdx >= 0 && oldLineIdx < newSegments.length) {
      targetSeg = { seg: newSegments[oldLineIdx], index: oldLineIdx };
    }

    if (targetSeg) {
      const occurrence = findClosestOccurrence(targetSeg.seg.text, targetText, ent.textSpan.startChar);
      if (occurrence.start >= 0) {
        return {
          ...ent,
          textSpan: {
            ...ent.textSpan,
            lineIndex: targetSeg.index,
            startChar: occurrence.start,
            endChar: occurrence.end,
            segmentId: targetSeg.seg.id,
            speaker: targetSeg.seg.speaker
          }
        };
      }
    }

    return ent;
  });

  return { realignedMentions, realignedEntities };
}

/**
 * Splits a single transcript segment into two separate utterances cleanly,
 * and updates raw transcript text, segments, mentions, and entities.
 */
export function splitSegmentAtOffset(
  segments: TranscriptSegment[],
  segmentIndex: number,
  splitCharOffset: number,
  newSpeaker: string = 'Patient',
  rawTranscript: string = '',
  mentions: Mention[] = [],
  entities: Entity[] = []
): {
  updatedSegments: TranscriptSegment[];
  updatedTranscript: string;
  updatedMentions: Mention[];
  updatedEntities: Entity[];
} {
  if (segmentIndex < 0 || segmentIndex >= segments.length) {
    return {
      updatedSegments: segments,
      updatedTranscript: rawTranscript,
      updatedMentions: mentions,
      updatedEntities: entities
    };
  }

  const targetSeg = segments[segmentIndex];
  const fullText = targetSeg.text;

  // Split text into two parts
  const part1Text = fullText.substring(0, splitCharOffset).trim();
  const part2Text = fullText.substring(splitCharOffset).trim();

  if (!part1Text || !part2Text) {
    return {
      updatedSegments: segments,
      updatedTranscript: rawTranscript,
      updatedMentions: mentions,
      updatedEntities: entities
    };
  }

  const seg1: TranscriptSegment = {
    ...targetSeg,
    text: part1Text
  };

  const seg2: TranscriptSegment = {
    id: generateSegmentId(`${targetSeg.id}_split`),
    speaker: newSpeaker,
    text: part2Text,
    timestamp: targetSeg.timestamp
  };

  const updatedSegments = [
    ...segments.slice(0, segmentIndex),
    seg1,
    seg2,
    ...segments.slice(segmentIndex + 1)
  ];

  // Format new transcript string
  const updatedTranscript = updatedSegments
    .map(s => {
      const prefix = s.timestamp ? `[${s.timestamp}] ` : '';
      return `${prefix}${s.speaker}: ${s.text}`;
    })
    .join('\n');

  // Realign mentions & entities across the split segments
  const { realignedMentions, realignedEntities } = realignMentionsWithSegments(
    segments,
    updatedSegments,
    mentions,
    entities
  );

  return {
    updatedSegments,
    updatedTranscript,
    updatedMentions: realignedMentions,
    updatedEntities: realignedEntities
  };
}

/**
 * Changes the speaker of a segment and updates associated mentions.
 */
export function changeSegmentSpeaker(
  segments: TranscriptSegment[],
  segmentIndex: number,
  newSpeaker: string,
  rawTranscript: string = '',
  mentions: Mention[] = []
): {
  updatedSegments: TranscriptSegment[];
  updatedTranscript: string;
  updatedMentions: Mention[];
} {
  if (segmentIndex < 0 || segmentIndex >= segments.length) {
    return { updatedSegments: segments, updatedTranscript: rawTranscript, updatedMentions: mentions };
  }

  const targetSeg = segments[segmentIndex];
  const updatedSegments = segments.map((seg, idx) => {
    if (idx === segmentIndex) {
      return { ...seg, speaker: newSpeaker };
    }
    return seg;
  });

  const updatedMentions = mentions.map(m => {
    if (m.segmentId === targetSeg.id || m.textSpan?.lineIndex === segmentIndex) {
      return {
        ...m,
        speaker: newSpeaker,
        textSpan: {
          ...m.textSpan,
          speaker: newSpeaker
        }
      };
    }
    return m;
  });

  const updatedTranscript = updatedSegments
    .map(s => {
      const prefix = s.timestamp ? `[${s.timestamp}] ` : '';
      return `${prefix}${s.speaker}: ${s.text}`;
    })
    .join('\n');

  return {
    updatedSegments,
    updatedTranscript,
    updatedMentions
  };
}
