import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { Agent, fetch } from 'undici';

export interface AiRunContext { requestId: string; signal?: AbortSignal }
export interface AiRequestContext extends AiRunContext {
  stage: string;
  utteranceIndex?: number;
  attempt?: number;
}
interface Diagnostics {
  provider?: string; model?: string; endpoint?: string; promptChars?: number;
  timeoutMs?: number; elapsedMs?: number; httpStatus?: number; upstreamRequestId?: string;
  promptTokens?: number; completionTokens?: number; responseChars?: number;
  reason?: string; retryDelayMs?: number; mentionCount?: number;
}

export function aiTimeoutMs(): number {
  const value = Number(process.env.CLINGRAPH_AI_TIMEOUT_MS ?? 180000);
  if (!Number.isInteger(value) || value < 1 || value > 900000) {
    throw new Error('CLINGRAPH_AI_TIMEOUT_MS must be an integer between 1 and 900000');
  }
  return value;
}

export function aiLogPath(): string {
  return path.resolve(process.env.CLINGRAPH_AI_LOG_PATH || path.join(
    path.dirname(process.env.CLINGRAPH_DB_PATH || 'data/clingraph.sqlite'), 'logs/ai-requests.jsonl'));
}

let warnedAboutLog = false;
/** Only operational metadata belongs here: never prompts, completions, keys or raw errors. */
export function logAi(context: AiRequestContext, event: string, details: Diagnostics = {}) {
  const record = JSON.stringify({ timestamp: new Date().toISOString(), event, requestId: context.requestId,
    stage: context.stage, utteranceIndex: context.utteranceIndex, attempt: context.attempt,
    ...details });
  if (process.env.CLINGRAPH_STORAGE === 'firebase' || process.env.K_SERVICE) {
    console.log(record);
    return;
  }
  try {
    const filename = aiLogPath();
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (existsSync(filename) && statSync(filename).size >= 5 * 1024 * 1024) renameSync(filename, filename + '.1');
    appendFileSync(filename, record + '\n', { mode: 0o600 });
  } catch {
    if (!warnedAboutLog) { console.error('Could not write AI diagnostics to disk; using terminal output.'); warnedAboutLog = true; }
    console.error(record);
  }
}

export class AiRequestError extends Error {
  constructor(message: string, public status: number, public code: string, public requestId: string) { super(message); }
}

export function wrapAiError(error: unknown, scope: string): Error & { status: number; code?: string } {
  const original = error as Error & { status?: number; code?: string };
  return Object.assign(new Error(`${scope}: ${original?.message || 'Unknown error'}`, { cause: error }), {
    status: original?.status || 502, code: original?.code
  });
}

/** One deadline covers headers and the complete body, and aborts the actual transport. */
export async function runAiRequest<T>(
  context: AiRequestContext,
  details: Diagnostics,
  operation: (signal: AbortSignal, record: (details: Diagnostics) => void) => Promise<T>
): Promise<T> {
  const timeoutMs = aiTimeoutMs();
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const diagnostics: Diagnostics = { ...details, timeoutMs };
  logAi(context, 'request_started', diagnostics);
  try {
    const interrupted = new Promise<never>((_, reject) => {
      const stop = (error: AiRequestError) => { controller.abort(error); reject(error); };
      cancel = () => stop(new AiRequestError(`AI request cancelled (request ${context.requestId})`, 499, 'AI_CANCELLED', context.requestId));
      if (context.signal?.aborted) { cancel(); return; }
      context.signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => stop(new AiRequestError(
        `AI request exceeded ${timeoutMs / 1000} seconds during ${context.stage}${context.utteranceIndex === undefined ? '' : ` for utterance ${context.utteranceIndex}`} (request ${context.requestId})`,
        504, 'AI_TIMEOUT', context.requestId)), timeoutMs);
    });
    const result = await Promise.race([interrupted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal, update => {
        Object.assign(diagnostics, update);
        if (update.httpStatus !== undefined) logAi(context, 'response_headers', { ...diagnostics, elapsedMs: Date.now() - started });
      });
    })]);
    logAi(context, 'request_completed', { ...diagnostics, elapsedMs: Date.now() - started });
    return result;
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : error;
    logAi(context, 'request_failed', { ...diagnostics, elapsedMs: Date.now() - started,
      reason: failure instanceof AiRequestError ? failure.code : 'AI_REQUEST_FAILED' });
    throw failure;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', cancel);
  }
}

const dispatcher = new Agent({ headersTimeout: 900000, bodyTimeout: 900000, connectTimeout: 120000 });
interface ChatConfig { baseUrl?: string; apiKey?: string; model?: string; provider?: string }

export async function callOpenAiChat(config: ChatConfig, promptText: string,
  context: AiRequestContext = { requestId: randomUUID(), stage: 'chat', attempt: 1 }): Promise<string> {
  let url = config.baseUrl?.trim() || 'https://api.openai.com/v1';
  if (!url.includes('/chat/completions')) url = url.replace(/\/$/, '') + '/chat/completions';
  const endpoint = new URL(url);
  const payload: any = { model: config.model || 'gpt-4o', messages: [{ role: 'user', content: promptText }] };
  if (config.model && ['gpt-4', 'gpt-3.5', 'llama', 'deepseek'].some(name => config.model!.includes(name))) {
    payload.response_format = { type: 'json_object' };
  }
  return runAiRequest(context, { provider: config.provider || 'openai', model: payload.model,
    endpoint: endpoint.origin + endpoint.pathname, promptChars: promptText.length }, async (signal, record) => {
    const response = await fetch(url, { method: 'POST', headers: {
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), 'Content-Type': 'application/json'
    }, body: JSON.stringify(payload), dispatcher, signal });
    const upstreamId = response.headers.get('x-request-id') || response.headers.get('cf-ray');
    record({ httpStatus: response.status, ...(upstreamId && /^[\w:.-]{1,128}$/.test(upstreamId) ? { upstreamRequestId: upstreamId } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AiRequestError(`AI provider returned HTTP ${response.status} (request ${context.requestId})`, 502, 'AI_PROVIDER_ERROR', context.requestId);
    }
    const json: any = await response.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AiRequestError(
      `AI provider returned no response content (request ${context.requestId})`, 502, 'AI_EMPTY_RESPONSE', context.requestId);
    record({ responseChars: content.length,
      ...(Number.isFinite(json.usage?.prompt_tokens) ? { promptTokens: json.usage.prompt_tokens } : {}),
      ...(Number.isFinite(json.usage?.completion_tokens) ? { completionTokens: json.usage.completion_tokens } : {}) });
    return content;
  });
}
