import type { Mention, TranscriptSegment } from '../types';

/** Validate the saved, unmapped spans before spending another model request on them. */
export function validateExtractedMentions(mentions: unknown, segments: TranscriptSegment[]): asserts mentions is Mention[] {
  if (!Array.isArray(mentions)) throw new Error('Extract mentions before mapping entities.');
  const ids = new Set<string>();
  for (const mention of mentions) {
    if (!mention || typeof mention.id !== 'string' || !mention.id.trim() || ids.has(mention.id) ||
        typeof mention.entityType !== 'string' || !mention.entityType.trim() ||
        mention.entityId != null || mention.target != null ||
        (mention.targets !== undefined && (!Array.isArray(mention.targets) || mention.targets.length > 0)) ||
        (mention.supportedAttribute !== undefined && typeof mention.supportedAttribute !== 'string')) {
      throw new Error('Invalid extracted mention or duplicate mention ID.');
    }
    ids.add(mention.id);
    const span = mention.textSpan;
    const text = span && segments[span.lineIndex]?.text;
    if (!span || !Number.isInteger(span.lineIndex) || !Number.isInteger(span.startChar) ||
        !Number.isInteger(span.endChar) || span.startChar < 0 || span.endChar <= span.startChar ||
        typeof text !== 'string' || span.endChar > text.length ||
        text.slice(span.startChar, span.endChar) !== span.text) {
      throw new Error('Extracted mentions no longer match the transcript. Extract mentions again.');
    }
  }
}
