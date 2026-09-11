import { TranscriptSegment } from '../types';

/**
 * Scans text and extracts all balanced top-level JSON objects.
 * Works seamlessly for:
 * - Single-line JSONL: `{"speaker": "Doctor", "text": "Hello"}`
 * - Multi-line indented/tabulated JSON:
 *   ```json
 *   {
 *     "speaker": "Patient",
 *     "text": "Ja.",
 *     "timestamp": "00:01 - 00:02"
 *   }
 *   ```
 * - Concatenated or newline-separated JSON objects
 */
export function extractJsonObjects(text: string): any[] {
  if (!text || typeof text !== 'string') return [];

  const trimmed = text.trim();
  if (!trimmed) return [];

  // Check if the entire string is a single JSON array e.g. [ {...}, {...} ]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsedArray = JSON.parse(trimmed);
      if (Array.isArray(parsedArray)) {
        return parsedArray.filter(item => item && typeof item === 'object' && !Array.isArray(item));
      }
    } catch (e) {
      // Fall through to streaming scanner
    }
  }

  const results: any[] = [];
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          const jsonStr = text.substring(startIndex, i + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              results.push(parsed);
            }
          } catch (e) {
            // ignore invalid fragment
          }
          startIndex = -1;
        }
      }
    }
  }

  return results;
}

/**
 * Checks if the text represents a JSON or JSONL structure (single-line, multi-line, or array of objects).
 */
export function isJsonOrJsonlFormat(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      // ignore
    }
  }

  const jsonObjects = extractJsonObjects(text);
  return jsonObjects.length > 0;
}

/**
 * Parses dialogue transcript text into structured TranscriptSegment array.
 * Supports:
 * - Tabulated / multi-line formatted JSON objects
 * - Single-line JSONL
 * - JSON arrays
 * - "Speaker: text" lines (with optional timestamp prefix "[00:00 - 00:05] Speaker: text")
 * - Unstructured dialogue lines
 */
export function parseDialogueTextToSegments(text: string): TranscriptSegment[] {
  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Try extracting JSON objects
  const jsonObjects = extractJsonObjects(text);
  if (jsonObjects.length > 0) {
    const hasDialogueKeys = jsonObjects.some(
      obj => 'speaker' in obj || 'text' in obj || 'role' in obj || 'content' in obj || 'utterance' in obj
    );

    if (hasDialogueKeys) {
      return jsonObjects.map((obj, idx) => {
        const speaker = obj.speaker || obj.role || obj.name || obj.author || 'Speaker';
        const textContent = obj.text ?? obj.content ?? obj.utterance ?? obj.message ?? '';
        const timestamp = obj.timestamp || obj.time || undefined;

        return {
          id: obj.id || `seg_${idx + 1}`,
          speaker: String(speaker).trim() || 'Speaker',
          text: typeof textContent === 'string' ? textContent : JSON.stringify(textContent),
          ...(timestamp ? { timestamp: String(timestamp).trim() } : {})
        };
      });
    }
  }

  // 2. Parse text lines for "Speaker: Message" or "[00:01 - 00:02] Speaker: Message"
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  return lines.map((line, idx) => {
    // Check for optional timestamp prefix e.g. "[00:00 - 00:05]" or "(00:00 - 00:05)"
    let timestamp: string | undefined = undefined;
    let restOfLine = line;

    const tsMatch = line.match(/^(\[|\()(\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?)(\]|\))\s*(.*)$/);
    if (tsMatch) {
      timestamp = tsMatch[2].trim();
      restOfLine = tsMatch[4].trim();
    }

    const colonIdx = restOfLine.indexOf(':');
    if (colonIdx > 0 && colonIdx < 40) {
      const potentialSpeaker = restOfLine.substring(0, colonIdx).trim();
      const content = restOfLine.substring(colonIdx + 1).trim();
      // Ensure speaker doesn't look like a URL or weird symbol
      if (!potentialSpeaker.includes('http') && !potentialSpeaker.includes('\n')) {
        return {
          id: `seg_${idx + 1}`,
          speaker: potentialSpeaker,
          text: content || restOfLine,
          ...(timestamp ? { timestamp } : {})
        };
      }
    }

    return {
      id: `seg_${idx + 1}`,
      speaker: 'Speaker',
      text: restOfLine,
      ...(timestamp ? { timestamp } : {})
    };
  });
}

/**
 * Parses clinical note / unstructured document text into segments (paragraphs or SOAP fields).
 */
export function parseNoteTextToSegments(text: string): TranscriptSegment[] {
  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Check if it's a JSON object (e.g. SOAP fields)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        return Object.entries(obj).map(([key, val], idx) => {
          let textVal = '';
          if (typeof val === 'string') {
            textVal = val;
          } else {
            textVal = JSON.stringify(val, null, 2);
          }
          return {
            id: `seg_${idx + 1}`,
            speaker: key,
            text: textVal
          };
        });
      }
    } catch (e) {
      // Fallback if JSON parse fails
    }
  }

  // 2. Treat as plain text, split by double newlines into paragraphs
  const paragraphs = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  return paragraphs.map((para, idx) => {
    const headerMatch = para.match(/^([A-Za-z0-9\s\-\.\#\:\(\)]+?)\:\s*\n?([\s\S]*)$/);
    if (headerMatch && headerMatch[1] && headerMatch[1].length < 40 && !headerMatch[1].includes('\n')) {
      const header = headerMatch[1].trim();
      const content = headerMatch[2].trim();
      if (content.length > 0) {
        return {
          id: `seg_${idx + 1}`,
          speaker: header,
          text: content
        };
      }
    }

    return {
      id: `seg_${idx + 1}`,
      speaker: 'Document',
      text: para
    };
  });
}

/**
 * Unified parser for any encounter type.
 */
export function parseTranscriptToSegments(
  text: string,
  encounterType: 'dialogue' | 'note' = 'dialogue'
): TranscriptSegment[] {
  if (encounterType === 'note') {
    return parseNoteTextToSegments(text);
  }
  return parseDialogueTextToSegments(text);
}
