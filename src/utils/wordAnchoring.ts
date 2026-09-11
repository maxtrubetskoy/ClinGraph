import { TranscriptSegment, Mention, TextSpan } from '../types';

export interface WordToken {
  /** 0-based sequential word index across the entire transcript text */
  globalWordIndex: number;
  /** Index of the segment in the segments array */
  segmentIndex: number;
  /** Stable unique ID of the segment */
  segmentId?: string;
  /** Speaker of the segment at time of indexing */
  speaker?: string;
  /** 0-based word index within this specific segment */
  localWordIndex: number;
  /** Character start offset within seg.text */
  startChar: number;
  /** Character end offset within seg.text */
  endChar: number;
  /** The word token string */
  word: string;
}

/**
 * Builds a sequential list of all word tokens across the entire transcript,
 * operating strictly on the segment "text" fields and completely ignoring
 * speaker tags, headers, and timestamps.
 */
export function buildGlobalWordIndex(segments: TranscriptSegment[]): WordToken[] {
  if (!segments || segments.length === 0) return [];

  const tokens: WordToken[] = [];
  let globalWordCount = 0;

  segments.forEach((seg, segIdx) => {
    const text = seg.text || '';
    // Match non-whitespace word chunks with their character positions
    const regex = /\S+/g;
    let match: RegExpExecArray | null;
    let localWordIdx = 0;

    while ((match = regex.exec(text)) !== null) {
      tokens.push({
        globalWordIndex: globalWordCount++,
        segmentIndex: segIdx,
        segmentId: seg.id,
        speaker: seg.speaker,
        localWordIndex: localWordIdx++,
        startChar: match.index,
        endChar: match.index + match[0].length,
        word: match[0]
      });
    }
  });

  return tokens;
}

/**
 * Given a segment and character offsets [startChar, endChar],
 * calculates the overlapping global word indices [globalStartWord, globalEndWord].
 */
export function calculateGlobalWordSpan(
  segments: TranscriptSegment[],
  segmentIndex: number,
  startChar: number,
  endChar: number
): { globalStartWord: number; globalEndWord: number; wordCount: number } | null {
  const tokens = buildGlobalWordIndex(segments);
  if (tokens.length === 0) return null;

  // Filter tokens belonging to this segment that overlap with [startChar, endChar]
  const overlappingTokens = tokens.filter(t => 
    t.segmentIndex === segmentIndex &&
    t.endChar > startChar &&
    t.startChar < endChar
  );

  if (overlappingTokens.length === 0) {
    // If exact overlap not found (e.g. selection inside whitespace), pick closest token
    const segTokens = tokens.filter(t => t.segmentIndex === segmentIndex);
    if (segTokens.length === 0) return null;

    let closest = segTokens[0];
    let minDist = Infinity;
    segTokens.forEach(t => {
      const dist = Math.abs(t.startChar - startChar);
      if (dist < minDist) {
        minDist = dist;
        closest = t;
      }
    });

    return {
      globalStartWord: closest.globalWordIndex,
      globalEndWord: closest.globalWordIndex,
      wordCount: 1
    };
  }

  const globalStartWord = overlappingTokens[0].globalWordIndex;
  const globalEndWord = overlappingTokens[overlappingTokens.length - 1].globalWordIndex;
  const wordCount = overlappingTokens.length;

  return { globalStartWord, globalEndWord, wordCount };
}

/**
 * Given global word indices [globalStartWord, globalEndWord],
 * maps them back to the exact current segment and local character offsets.
 *
 * If an utterance was split, merged, or had its speaker reassigned, this
 * automatically resolves the new segment, new line index, new character offsets,
 * and current speaker!
 */
export function resolveGlobalWordSpanToSegment(
  segments: TranscriptSegment[],
  globalStartWord: number,
  globalEndWord: number
): {
  segmentIndex: number;
  segmentId?: string;
  speaker?: string;
  startChar: number;
  endChar: number;
  text: string;
} | null {
  const tokens = buildGlobalWordIndex(segments);
  if (tokens.length === 0) return null;

  const startToken = tokens.find(t => t.globalWordIndex === globalStartWord);
  const endToken = tokens.find(t => t.globalWordIndex === globalEndWord) || startToken;

  if (!startToken) return null;

  const segIdx = startToken.segmentIndex;
  const targetSeg = segments[segIdx];
  if (!targetSeg) return null;

  // If start and end token are within the same segment:
  const actualEndToken = (endToken && endToken.segmentIndex === segIdx) ? endToken : startToken;

  const startChar = startToken.startChar;
  const endChar = actualEndToken.endChar;
  const text = (targetSeg.text || '').substring(startChar, endChar);

  return {
    segmentIndex: segIdx,
    segmentId: targetSeg.id,
    speaker: targetSeg.speaker,
    startChar,
    endChar,
    text
  };
}

/**
 * Searches the global word stream for a sequence of words matching targetText (case-insensitive).
 * Returns the resolved segment and character bounds.
 */
export function findWordSequenceInGlobalStream(
  segments: TranscriptSegment[],
  targetText: string,
  preferredGlobalIndex?: number
): {
  globalStartWord: number;
  globalEndWord: number;
  segmentIndex: number;
  segmentId?: string;
  speaker?: string;
  startChar: number;
  endChar: number;
  matchedText: string;
} | null {
  if (!targetText || !targetText.trim()) return null;

  const targetWords = targetText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (targetWords.length === 0) return null;

  const tokens = buildGlobalWordIndex(segments);
  if (tokens.length === 0) return null;

  // Clean punctuation from word for matching
  const cleanWord = (w: string) => w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');

  const cleanedTarget = targetWords.map(cleanWord).filter(Boolean);
  if (cleanedTarget.length === 0) return null;

  const matchCandidates: { startTokenIdx: number; endTokenIdx: number; distance: number }[] = [];

  for (let i = 0; i <= tokens.length - cleanedTarget.length; i++) {
    let allMatch = true;
    for (let j = 0; j < cleanedTarget.length; j++) {
      const tokenClean = cleanWord(tokens[i + j].word);
      if (tokenClean !== cleanedTarget[j] && !tokenClean.includes(cleanedTarget[j]) && !cleanedTarget[j].includes(tokenClean)) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      const startTok = tokens[i];
      const endTok = tokens[i + cleanedTarget.length - 1];
      const dist = preferredGlobalIndex !== undefined ? Math.abs(startTok.globalWordIndex - preferredGlobalIndex) : 0;
      matchCandidates.push({
        startTokenIdx: i,
        endTokenIdx: i + cleanedTarget.length - 1,
        distance: dist
      });
    }
  }

  if (matchCandidates.length === 0) return null;

  // Sort by distance to preferred index
  matchCandidates.sort((a, b) => a.distance - b.distance);
  const best = matchCandidates[0];

  const startTok = tokens[best.startTokenIdx];
  const endTok = tokens[best.endTokenIdx];
  const targetSeg = segments[startTok.segmentIndex];

  if (!targetSeg) return null;

  const startChar = startTok.startChar;
  const endChar = (endTok.segmentIndex === startTok.segmentIndex) ? endTok.endChar : startTok.endChar;
  const matchedText = (targetSeg.text || '').substring(startChar, endChar);

  return {
    globalStartWord: startTok.globalWordIndex,
    globalEndWord: endTok.globalWordIndex,
    segmentIndex: startTok.segmentIndex,
    segmentId: targetSeg.id,
    speaker: targetSeg.speaker,
    startChar,
    endChar,
    matchedText
  };
}

/**
 * Enriches a mention with global word count anchors based on current segments.
 */
export function enrichMentionWithGlobalWords(
  mention: Mention,
  segments: TranscriptSegment[]
): Mention {
  const span = mention.textSpan;
  if (!span) return mention;

  const segIdx = span.lineIndex >= 0 ? span.lineIndex : 0;
  const wordSpan = calculateGlobalWordSpan(segments, segIdx, span.startChar, span.endChar);

  if (!wordSpan) return mention;

  return {
    ...mention,
    globalStartWord: wordSpan.globalStartWord,
    globalEndWord: wordSpan.globalEndWord,
    textSpan: {
      ...span,
      globalStartWord: wordSpan.globalStartWord,
      globalEndWord: wordSpan.globalEndWord
    }
  };
}

/**
 * Enriches an array of mentions with global word anchors.
 */
export function enrichMentionsWithGlobalWords(
  mentions: Mention[],
  segments: TranscriptSegment[]
): Mention[] {
  if (!mentions || mentions.length === 0) return [];
  return mentions.map(m => enrichMentionWithGlobalWords(m, segments));
}
