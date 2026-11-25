import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';

export const REASONING_OFF_FALLBACK_LADDER = ['none', 'minimal', 'low', null] as const;
export type ReasoningOffCandidate = (typeof REASONING_OFF_FALLBACK_LADDER)[number];

export type StreamSimpleFn = (
  model: any,
  context: any,
  options?: any
) => AsyncIterable<any> & { result?: () => Promise<any> };

const defaultReasoningOffCache = new Map<string, ReasoningOffCandidate>();
const wrappedRuntimes = new WeakSet<object>();

export function getReasoningOffCacheKey(model: any): string {
  const provider = String(model?.provider || '').trim();
  const id = String(model?.id || '').trim();
  return `${provider}/${id}`;
}

export function getCachedReasoningOffValue(
  model: any,
  cache: Map<string, ReasoningOffCandidate> = defaultReasoningOffCache
): ReasoningOffCandidate | undefined {
  const key = getReasoningOffCacheKey(model);
  if (!key || key === '/') return undefined;
  return cache.get(key);
}

export function clearReasoningOffFallbackCache(
  providerId?: string,
  cache: Map<string, ReasoningOffCandidate> = defaultReasoningOffCache
): void {
  const trimmed = typeof providerId === 'string' ? providerId.trim() : '';
  if (!trimmed) {
    cache.clear();
    return;
  }
  const prefix = `${trimmed}/`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

export function shouldProbeReasoningEffortOff(model: any, options?: any): boolean {
  if (!model || typeof model !== 'object') return false;
  if (options?.reasoning !== undefined && options.reasoning !== 'off') {
    return false;
  }
  if (model.api !== 'openai-completions') {
    return false;
  }
  if (model.reasoning !== true) {
    return false;
  }
  if (model.compat?.supportsReasoningEffort !== true) {
    return false;
  }
  const thinkingFormat = model.compat?.thinkingFormat;
  if (thinkingFormat && thinkingFormat !== 'openai') {
    return false;
  }
  const tlm = model.thinkingLevelMap;
  if (tlm && Object.prototype.hasOwnProperty.call(tlm, 'off') && tlm.off !== undefined) {
    return false;
  }
  return true;
}

const NON_400_STATUS_RE =
  /(?:^|[^\d])(?:401|402|403|404|408|409|413|422|429|500|502|503|504)(?:[^\d]|$)/;
const HTTP_400_RE =
  /(?:^|[^\d])400(?:[^\d]|$)|bad\s+request|invalid_request_error/i;
const REASONING_PARAM_RE = /reasoning_effort/i;
const REASONING_ALT_PARAM_RE = /\b(?:reasoning|effort|thinking)\b/i;
const PARAMETER_REJECTION_RE =
  /unsupported|not\s+supported|invalid|unrecognized|unknown\s+(?:parameter|field|arg)|unexpected\s+(?:parameter|field|keyword)|allowed\s+values|must\s+be\s+one\s+of|should\s+be\s+one\s+of|enum|not\s+a\s+valid|cannot\s+be|does\s+not\s+support/i;

export function isReasoningEffortRejectionError(errorMessage: string, attempted: string): boolean {
  const msg = String(errorMessage || '').trim();
  if (!msg) return false;
  if (NON_400_STATUS_RE.test(msg) && !HTTP_400_RE.test(msg)) {
    return false;
  }
  if (!HTTP_400_RE.test(msg)) {
    return false;
  }
  if (REASONING_PARAM_RE.test(msg)) {
    return true;
  }
  const escapedAttempted = attempted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attemptedValueRe = new RegExp(`['"\`\\s:=]${escapedAttempted}['"\`\\s,.)\\]]`, 'i');
  if (
    REASONING_ALT_PARAM_RE.test(msg) &&
    (PARAMETER_REJECTION_RE.test(msg) || attemptedValueRe.test(` ${msg} `))
  ) {
    return true;
  }
  return false;
}

/**
 * NEVER assign `thinkingLevelMap.off = null` when omitting `reasoning_effort`,
 * because Pi SDK's `clampThinkingLevel` interprets `off: null` as "off disallowed"
 * and clamps upward to `'minimal'`.
 */
export function applyReasoningOffCandidateToModel(
  model: any,
  candidate: ReasoningOffCandidate
): any {
  if (candidate === null) {
    return model;
  }
  return {
    ...model,
    thinkingLevelMap: {
      ...(model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
        ? model.thinkingLevelMap
        : {}),
      off: candidate,
    },
  };
}

function buildErrorAssistantMessage(model: any, errorMessage: string, aborted: boolean) {
  const stopReason: 'aborted' | 'error' = aborted ? 'aborted' : 'error';
  return {
    role: 'assistant' as const,
    content: [],
    api: model?.api ?? 'openai-completions',
    provider: model?.provider ?? '',
    model: model?.id ?? '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export function createReasoningOffFallbackStream(
  baseStreamSimple: StreamSimpleFn,
  model: any,
  context: any,
  options?: any,
  cache: Map<string, ReasoningOffCandidate> = defaultReasoningOffCache
): AssistantMessageEventStream {
  if (!shouldProbeReasoningEffortOff(model, options)) {
    return baseStreamSimple(model, context, options) as AssistantMessageEventStream;
  }

  const outStream = createAssistantMessageEventStream();
  const cacheKey = getReasoningOffCacheKey(model);
  const hasKey = Boolean(cacheKey && cacheKey !== '/');
  const cachedCandidate = hasKey ? cache.get(cacheKey) : undefined;
  const cachedStartIdx =
    cachedCandidate !== undefined ? REASONING_OFF_FALLBACK_LADDER.indexOf(cachedCandidate) : -1;
  let idx = cachedStartIdx >= 0 ? cachedStartIdx : 0;

  void (async () => {
    while (idx < REASONING_OFF_FALLBACK_LADDER.length) {
      const candidate = REASONING_OFF_FALLBACK_LADDER[idx];
      const attemptModel = applyReasoningOffCandidateToModel(model, candidate);
      const attemptOptions =
        options?.reasoning === 'off' ? { ...options, reasoning: undefined } : options;

      let bufferedStartEvent: any = null;
      let committedNonError = false;
      let retryNext = false;

      try {
        const innerStream = baseStreamSimple(attemptModel, context, attemptOptions);
        for await (const event of innerStream) {
          if (!event || typeof event !== 'object') continue;

          if (!committedNonError && event.type === 'start') {
            bufferedStartEvent = event;
            continue;
          }

          if (!committedNonError && event.type === 'error') {
            const errMsg = String(event.error?.errorMessage || event.message || '');
            const canRetry =
              candidate !== null &&
              idx < REASONING_OFF_FALLBACK_LADDER.length - 1 &&
              !options?.signal?.aborted &&
              isReasoningEffortRejectionError(errMsg, candidate);
            if (canRetry) {
              retryNext = true;
              break;
            }
            if (bufferedStartEvent) {
              outStream.push(bufferedStartEvent);
              bufferedStartEvent = null;
            }
            outStream.push(event);
            outStream.end();
            return;
          }

          if (!committedNonError) {
            committedNonError = true;
            if (hasKey) {
              cache.set(cacheKey, candidate);
            }
            if (bufferedStartEvent) {
              outStream.push(bufferedStartEvent);
              bufferedStartEvent = null;
            }
          }

          outStream.push(event);
          if (event.type === 'done' || event.type === 'error') {
            outStream.end();
            return;
          }
        }

        if (retryNext) {
          const latestCached = hasKey ? cache.get(cacheKey) : undefined;
          const latestIdx =
            latestCached !== undefined ? REASONING_OFF_FALLBACK_LADDER.indexOf(latestCached) : -1;
          idx = latestIdx > idx ? latestIdx : idx + 1;
          continue;
        }

        if (bufferedStartEvent) {
          outStream.push(bufferedStartEvent);
          bufferedStartEvent = null;
        }
        outStream.end();
        return;
      } catch (err: any) {
        const errMsg = String(err?.message || err || '');
        const canRetry =
          !committedNonError &&
          candidate !== null &&
          idx < REASONING_OFF_FALLBACK_LADDER.length - 1 &&
          !options?.signal?.aborted &&
          isReasoningEffortRejectionError(errMsg, candidate);
        if (canRetry) {
          const latestCached = hasKey ? cache.get(cacheKey) : undefined;
          const latestIdx =
            latestCached !== undefined ? REASONING_OFF_FALLBACK_LADDER.indexOf(latestCached) : -1;
          idx = latestIdx > idx ? latestIdx : idx + 1;
          continue;
        }

        if (bufferedStartEvent) {
          outStream.push(bufferedStartEvent);
          bufferedStartEvent = null;
        }
        const errAssistant = buildErrorAssistantMessage(
          attemptModel,
          errMsg || 'Stream failed',
          Boolean(options?.signal?.aborted)
        );
        outStream.push({
          type: 'error',
          reason: errAssistant.stopReason,
          error: errAssistant,
        });
        outStream.end();
        return;
      }
    }
  })();

  return outStream;
}

export function wrapModelRuntimeWithReasoningOffFallback<T extends Record<string, any>>(
  runtime: T,
  cache: Map<string, ReasoningOffCandidate> = defaultReasoningOffCache
): T {
  const target = runtime as any;
  if (!target || typeof target !== 'object' || typeof target.streamSimple !== 'function') {
    return runtime;
  }
  if (wrappedRuntimes.has(target)) {
    return runtime;
  }
  const origStreamSimple = target.streamSimple.bind(target) as StreamSimpleFn;
  target.streamSimple = (model: any, context: any, options?: any) =>
    createReasoningOffFallbackStream(origStreamSimple, model, context, options, cache);
  wrappedRuntimes.add(target);
  return runtime;
}
