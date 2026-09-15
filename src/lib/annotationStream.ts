import type { AnnotationProgress } from '../types';

/** Consume live updates from the annotation POST, retaining JSON compatibility. */
export async function readAnnotationResponse(response: Response, onProgress: (progress: AnnotationProgress) => void): Promise<any> {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const result = await response.json().catch(() => {
      throw new Error('The local server returned an invalid annotation response.');
    });
    if (result.progress) onProgress(result.progress);
    if (!response.ok || !result.success) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }

  if (!response.body) throw new Error('Annotation progress is unavailable. Please try again.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.progress) onProgress(event.progress);
        if (event.type === 'result') {
          if (!event.success) throw new Error(event.error || 'AI annotation failed.');
          return event;
        }
      }
      if (done) throw new Error('Annotation connection interrupted before results were received. Please try again.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
