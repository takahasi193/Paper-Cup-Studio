/**
 * API Key 自动识别与各厂商可用对话模型探测引擎（纯 Node 内置 fetch，零外部依赖）。
 * - 依据密钥格式进行前缀快速识别与并发 /models 探活；
 * - 剔除各厂商已下线、过时或非对话模态模型，仅保留当前受支持且可对话模型；
 * - 全程严禁在返回值、日志或错误信息中回显原始 API Key。
 */

export type ProviderProbeFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface DiscoveredLiveModel {
  id: string;
  name: string;
  reasoning: boolean;
}

export type DetectionMethod =
  | 'prefix-verified'
  | 'probe'
  | 'prefix-offline'
  | 'manual-verified'
  | 'manual-offline';

export interface ProviderDiscoveryResult {
  provider: string;
  providerName: string;
  detectionMethod: DetectionMethod;
  liveModels: DiscoveredLiveModel[] | null;
  rawModelCount: number;
  filteredOutCount: number;
}

export interface KeyPrefixHint {
  exactProvider?: string;
  candidates: readonly string[];
  ambiguous: boolean;
  label: string;
}

interface ProviderProbeSpec {
  id: string;
  name: string;
  modelsUrl: string;
  authVerifyUrl?: string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  parseModels: (payload: any, providerId: string) => {
    models: DiscoveredLiveModel[];
    rawCount: number;
  };
}

const JWT_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NON_CHAT_MODEL_RE =
  /(?:^|[-_/.:])(?:embed|embedding|embeddings|rerank|reranker|whisper|tts|asr|audio|speech|realtime|transcribe|transcription|moderation|dall-e|imagen|veo|sora|video|image-edit|text-to-image|image-to-image|stable-diffusion|sdxl|flux|kolors|cosyvoice|fish-speech|sensevoice|wan2|cogvideo|hunyuanvideo|babbage|davinci|curie|ada|robotics|computer-use|deep-research|aqa|lyria|chirp|search-preview|seedream|seedance|t2i|i2v|t2v|safeguard|shieldgemma)(?:$|[-_/.:])|^(?:dall-e|whisper|tts|text-embedding|omni-moderation|babbage|davinci)/i;

const DEPRECATED_META_STATUS_RE = /^(?:deprecated|retired|disabled|inactive|shutdown|sunset|legacy|archived)$/i;
const DEPRECATED_TEXT_META_RE = /\b(?:deprecated|discontinued|retired|shut\s*down|has been turned down|no longer supported)\b/i;

function inferGenericReasoning(id: string): boolean {
  const lower = id.toLowerCase();
  if (
    /(?:^|[-_./])(?:reason|reasoner|thinking|qwq|deepseek-r1|r1-distill|gpt-5|gpt-6|o3|o4|claude-(?:opus|sonnet|haiku|fable)-(?:4|5)|gemini-(?:2\.5|3|4)|grok-4|kimi-k2[.-]5|kimi-k3|glm-(?:4\.[5-9]|5|z1)|minimax-m)/i.test(
      lower
    ) &&
    !/(?:chat-latest|non-thinking)/i.test(lower)
  ) {
    return true;
  }
  return false;
}

function isPastDateString(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed < Date.now();
}

function isOutdatedProviderModelId(providerId: string, modelId: string): boolean {
  const p = providerId.toLowerCase();
  const id = modelId.trim().toLowerCase();
  if (!id) return true;

  // OpenRouter synthetic routing prefixes (~*) or free test toys are excluded unless concrete model
  if (p === 'openrouter' && id.startsWith('~')) {
    return true;
  }

  // Extract vendor sub-prefix when multiplexed through aggregators like OpenRouter
  const effectiveVendor =
    p === 'openrouter' && id.includes('/') ? id.slice(0, id.indexOf('/')) : p;
  const bareId =
    p === 'openrouter' && id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;

  if (effectiveVendor === 'openai' || effectiveVendor === 'azure-openai-responses') {
    if (
      /^gpt-3(?:\.5)?(?:$|-)/.test(bareId) ||
      bareId === 'gpt-4' ||
      /^gpt-4-(?:0314|0613|32k|turbo|vision|1106|0125)(?:$|-)/.test(bareId) ||
      /^gpt-4\.5(?:-|$)/.test(bareId) ||
      bareId === 'chatgpt-4o-latest' ||
      /^gpt-4o(?:-\d{4}-\d{2}-\d{2})?$/.test(bareId) ||
      /^gpt-4o-mini-\d{4}-\d{2}-\d{2}$/.test(bareId) ||
      bareId === 'o1' ||
      /^o1-(?:preview|mini|pro|\d{4})(?:$|-)/.test(bareId) ||
      /^ft:/.test(bareId) ||
      /^(?:text|code)-(?:davinci|curie|babbage|ada|cushman)/.test(bareId)
    ) {
      return true;
    }
  }

  if (effectiveVendor === 'google' || effectiveVendor === 'google-vertex') {
    if (
      /^gemini-1(?:\.0|\.5)?(?:-|$)/.test(bareId) ||
      /^gemini-2\.0(?:-|$)/.test(bareId) ||
      /^gemini-(?:pro|ultra)(?:-vision)?$/.test(bareId) ||
      /^gemma-2(?:-|$)/.test(bareId) ||
      /^(?:palm|chat-bison|text-bison|code-bison|codechat-bison|learnlm)/.test(bareId)
    ) {
      return true;
    }
  }

  if (effectiveVendor === 'anthropic') {
    if (
      /^claude-(?:instant|2(?:\.[01])?)(?:$|-)/.test(bareId) ||
      /^claude-3(?:$|[.-](?:opus|sonnet|haiku|5|7))/.test(bareId)
    ) {
      return true;
    }
  }

  if (effectiveVendor === 'deepseek') {
    if (bareId === 'deepseek-coder' || /^deepseek-v2(?:\.5)?(?:$|-)/.test(bareId)) {
      return true;
    }
  }

  if (effectiveVendor === 'x-ai' || effectiveVendor === 'xai') {
    if (/^grok-(?:1|2|beta|vision-beta)(?:$|-)/.test(bareId)) {
      return true;
    }
  }

  if (effectiveVendor === 'groq') {
    if (
      /^llama2(?:$|-)/.test(bareId) ||
      /^llama-?3-[0-9]+b(?!.*3\.[13])/.test(bareId) ||
      /^mixtral-8x7b/.test(bareId) ||
      /^gemma(?:2-9b|-7b)/.test(bareId)
    ) {
      return true;
    }
  }

  if (effectiveVendor === 'moonshotai' || effectiveVendor === 'moonshot') {
    if (/^moonshot-v1(?:$|-)/.test(bareId)) {
      return true;
    }
  }

  if (
    effectiveVendor === 'minimax' &&
    /^(?:abab[0-9]|minimax-01)/.test(bareId)
  ) {
    return true;
  }

  if (p === 'modelscope' || p === 'siliconflow' || p === 'volcengine') {
    if (
      /(?:^|\/)(?:qwen1\.5|qwen-?(?:7b|14b|72b)-chat|qwen2(?:\.0)?-|chatglm(?:2|3)?-|baichuan2?-|yi-1\.5-|deepseek-v2(?:\.5)?-|doubao-(?:lite|pro)-4k)/i.test(
        bareId
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * 统一判断模型是否属于当前可支持且未过时/非下线的对话模型。
 */
export function isSupportedLiveChatModel(
  providerId: string,
  modelId: string,
  rawEntry?: any
): boolean {
  const p = providerId.trim().toLowerCase();
  const id = modelId.trim();
  if (!p || !id) return false;
  if (p === 'faux') return true;

  if (rawEntry && typeof rawEntry === 'object') {
    if (rawEntry.deprecated === true || rawEntry.disabled === true || rawEntry.is_deprecated === true) {
      return false;
    }
    const status = typeof rawEntry.status === 'string' ? rawEntry.status.trim() : '';
    if (status && DEPRECATED_META_STATUS_RE.test(status)) {
      return false;
    }
    if (isPastDateString(rawEntry.deprecation_date) || isPastDateString(rawEntry.sunset_date)) {
      return false;
    }
    const desc =
      typeof rawEntry.description === 'string'
        ? rawEntry.description
        : typeof rawEntry.displayName === 'string'
          ? rawEntry.displayName
          : '';
    if (desc && DEPRECATED_TEXT_META_RE.test(desc)) {
      return false;
    }
    if (p === 'google' && Array.isArray(rawEntry.supportedGenerationMethods)) {
      const methods: string[] = rawEntry.supportedGenerationMethods.map((x: unknown) => String(x));
      if (methods.length > 0 && !methods.includes('generateContent')) {
        return false;
      }
    }
    if (p === 'siliconflow') {
      const subType = typeof rawEntry.sub_type === 'string' ? rawEntry.sub_type.toLowerCase() : '';
      if (subType && subType !== 'chat') return false;
    }
    if (p === 'volcengine') {
      const domain = typeof rawEntry.domain === 'string' ? rawEntry.domain : '';
      const taskType = typeof rawEntry.task_type === 'string' ? rawEntry.task_type : '';
      if ((domain && NON_CHAT_MODEL_RE.test(domain)) || (taskType && NON_CHAT_MODEL_RE.test(taskType))) {
        return false;
      }
    }
    if (p === 'modelscope' && /image-edit/i.test(id)) {
      return false;
    }
  }

  if (NON_CHAT_MODEL_RE.test(id)) {
    return false;
  }

  if (isOutdatedProviderModelId(p, id)) {
    return false;
  }

  return true;
}

function parseOpenAIStyleCatalog(
  payload: any,
  providerId: string
): { models: DiscoveredLiveModel[]; rawCount: number } {
  const entries: any[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];
  const models: DiscoveredLiveModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!isSupportedLiveChatModel(providerId, id, entry)) continue;
    const displayName =
      typeof entry?.display_name === 'string' && entry.display_name.trim()
        ? entry.display_name.trim()
        : typeof entry?.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : id;
    models.push({
      id,
      name: displayName,
      reasoning:
        typeof entry?.reasoning === 'boolean' ? entry.reasoning : inferGenericReasoning(id),
    });
  }
  return { models, rawCount: seen.size };
}

function parseGoogleCatalog(
  payload: any,
  providerId: string
): { models: DiscoveredLiveModel[]; rawCount: number } {
  const entries: any[] = Array.isArray(payload?.models) ? payload.models : [];
  const models: DiscoveredLiveModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const rawName = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const id = rawName.replace(/^models\//i, '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!isSupportedLiveChatModel(providerId, id, entry)) continue;
    const displayName =
      typeof entry?.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim()
        : id;
    models.push({
      id,
      name: displayName,
      reasoning: inferGenericReasoning(id),
    });
  }
  return { models, rawCount: seen.size };
}

const bearerHeaders = (apiKey: string): Record<string, string> => ({
  Accept: 'application/json',
  Authorization: `Bearer ${apiKey}`,
});

const PROVIDER_PROBE_SPECS: Record<string, ProviderProbeSpec> = {
  google: {
    id: 'google',
    name: 'Google AI Studio (Gemini)',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    buildHeaders: (apiKey) => ({
      Accept: 'application/json',
      'x-goog-api-key': apiKey,
    }),
    parseModels: parseGoogleCatalog,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    modelsUrl: 'https://api.anthropic.com/v1/models?limit=100',
    buildHeaders: (apiKey) => ({
      Accept: 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }),
    parseModels: parseOpenAIStyleCatalog,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    modelsUrl: 'https://api.openai.com/v1/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    modelsUrl: 'https://api.deepseek.com/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    authVerifyUrl: 'https://openrouter.ai/api/v1/auth/key',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    modelsUrl: 'https://api.x.ai/v1/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  moonshotai: {
    id: 'moonshotai',
    name: 'Moonshot (Kimi)',
    modelsUrl: 'https://api.moonshot.ai/v1/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    modelsUrl: 'https://api.minimax.io/v1/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  modelscope: {
    id: 'modelscope',
    name: 'ModelScope (魔搭)',
    modelsUrl: 'https://api-inference.modelscope.cn/v1/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  volcengine: {
    id: 'volcengine',
    name: '火山方舟 (Volcengine Ark)',
    modelsUrl: 'https://ark.cn-beijing.volces.com/api/v3/models',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    modelsUrl: 'https://api.siliconflow.cn/v1/models?type=text&sub_type=chat',
    buildHeaders: bearerHeaders,
    parseModels: parseOpenAIStyleCatalog,
  },
};

const AMBIGUOUS_SK_CANDIDATES = [
  'openai',
  'deepseek',
  'siliconflow',
  'moonshotai',
  'modelscope',
  'minimax',
] as const;

const GENERIC_NON_SK_CANDIDATES = [
  'volcengine',
  'modelscope',
  'siliconflow',
  'deepseek',
  'moonshotai',
  'openai',
  'minimax',
] as const;

/**
 * 仅根据 API Key 前缀/结构特征推断可能的提供商，绝不记录或返回密钥本身。
 */
export function inferProviderHintsFromKey(apiKey: string): KeyPrefixHint {
  const key = apiKey.trim();
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) {
    return {
      exactProvider: 'google',
      candidates: ['google'],
      ambiguous: false,
      label: 'Google AI Studio (Gemini)',
    };
  }
  if (/^sk-ant-/i.test(key)) {
    return {
      exactProvider: 'anthropic',
      candidates: ['anthropic'],
      ambiguous: false,
      label: 'Anthropic (Claude)',
    };
  }
  if (/^sk-or-/i.test(key)) {
    return {
      exactProvider: 'openrouter',
      candidates: ['openrouter'],
      ambiguous: false,
      label: 'OpenRouter',
    };
  }
  if (/^xai-/i.test(key)) {
    return {
      exactProvider: 'xai',
      candidates: ['xai'],
      ambiguous: false,
      label: 'xAI (Grok)',
    };
  }
  if (/^gsk_/i.test(key)) {
    return {
      exactProvider: 'groq',
      candidates: ['groq'],
      ambiguous: false,
      label: 'Groq',
    };
  }
  if (/^ms-/i.test(key)) {
    return {
      exactProvider: 'modelscope',
      candidates: ['modelscope'],
      ambiguous: false,
      label: 'ModelScope (魔搭)',
    };
  }
  if (/^sk-(?:proj|svcacct|admin)-/i.test(key)) {
    return {
      exactProvider: 'openai',
      candidates: ['openai'],
      ambiguous: false,
      label: 'OpenAI',
    };
  }
  if (/^sk-api-/i.test(key) || JWT_RE.test(key)) {
    return {
      exactProvider: 'minimax',
      candidates: ['minimax'],
      ambiguous: false,
      label: 'MiniMax',
    };
  }
  if (UUID_RE.test(key)) {
    return {
      exactProvider: 'volcengine',
      candidates: ['volcengine'],
      ambiguous: false,
      label: '火山方舟 (Volcengine Ark)',
    };
  }
  if (/^sk-/i.test(key)) {
    return {
      candidates: AMBIGUOUS_SK_CANDIDATES,
      ambiguous: true,
      label: 'OpenAI / DeepSeek / 硅基流动 / Moonshot / 魔搭（通用 sk- 格式）',
    };
  }
  return {
    candidates: GENERIC_NON_SK_CANDIDATES,
    ambiguous: true,
    label: '火山方舟 / 魔搭 / 其他兼容网关',
  };
}

type ProbeOutcome =
  | {
      kind: 'ok';
      provider: string;
      providerName: string;
      models: DiscoveredLiveModel[];
      rawCount: number;
    }
  | {
      kind: 'auth_error';
      provider: string;
      providerName: string;
      status: number;
    }
  | {
      kind: 'unavailable';
      provider: string;
      providerName: string;
      status?: number;
    };

async function probeSingleProvider(
  spec: ProviderProbeSpec,
  apiKey: string,
  fetchFn: ProviderProbeFetch,
  timeoutMs = 4500
): Promise<ProbeOutcome> {
  const headers = spec.buildHeaders(apiKey);
  try {
    if (spec.authVerifyUrl) {
      const authRes = await fetchFn(spec.authVerifyUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (authRes.status === 401 || authRes.status === 403) {
        return {
          kind: 'auth_error',
          provider: spec.id,
          providerName: spec.name,
          status: authRes.status,
        };
      }
      if (!authRes.ok) {
        return {
          kind: 'unavailable',
          provider: spec.id,
          providerName: spec.name,
          status: authRes.status,
        };
      }
    }

    const res = await fetchFn(spec.modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'auth_error',
        provider: spec.id,
        providerName: spec.name,
        status: res.status,
      };
    }
    if (!res.ok) {
      return {
        kind: 'unavailable',
        provider: spec.id,
        providerName: spec.name,
        status: res.status,
      };
    }
    const payload = await res.json();
    const { models, rawCount } = spec.parseModels(payload, spec.id);
    return {
      kind: 'ok',
      provider: spec.id,
      providerName: spec.name,
      models,
      rawCount,
    };
  } catch {
    return {
      kind: 'unavailable',
      provider: spec.id,
      providerName: spec.name,
    };
  }
}

export interface DiscoverProviderOptions {
  requestedProvider: string;
  apiKey: string;
  fetchImpl?: ProviderProbeFetch;
  offline?: boolean;
}

/**
 * 自动或校验指定提供商的 API Key，并从官方 /models 端点实时提取“受支持且未过时”的对话模型。
 */
export async function discoverProviderAndModels(
  options: DiscoverProviderOptions
): Promise<ProviderDiscoveryResult> {
  const trimmedKey = options.apiKey.trim();
  const requested = (options.requestedProvider || 'auto').trim();
  const isAuto = !requested || requested.toLowerCase() === 'auto';
  const offline = options.offline ?? process.env.PI_OFFLINE !== undefined;
  const hasCustomFetch = Boolean(options.fetchImpl);
  const fetchFn: ProviderProbeFetch = options.fetchImpl ?? globalThis.fetch;

  if (!trimmedKey) {
    throw new Error('API Key cannot be empty.');
  }

  if (isAuto) {
    const hint = inferProviderHintsFromKey(trimmedKey);

    if (hint.exactProvider) {
      const spec = PROVIDER_PROBE_SPECS[hint.exactProvider];
      if (!spec) {
        return {
          provider: hint.exactProvider,
          providerName: hint.label,
          detectionMethod: 'prefix-offline',
          liveModels: null,
          rawModelCount: 0,
          filteredOutCount: 0,
        };
      }
      if (offline && !hasCustomFetch) {
        return {
          provider: spec.id,
          providerName: spec.name,
          detectionMethod: 'prefix-offline',
          liveModels: null,
          rawModelCount: 0,
          filteredOutCount: 0,
        };
      }
      const outcome = await probeSingleProvider(spec, trimmedKey, fetchFn);
      if (outcome.kind === 'auth_error') {
        throw new Error(
          `已识别为 ${spec.name} 密钥格式，但网关鉴权被拒绝 (HTTP ${outcome.status})，请检查 API Key 是否有效。`
        );
      }
      if (outcome.kind === 'ok') {
        return {
          provider: spec.id,
          providerName: spec.name,
          detectionMethod: 'prefix-verified',
          liveModels: outcome.models,
          rawModelCount: outcome.rawCount,
          filteredOutCount: Math.max(0, outcome.rawCount - outcome.models.length),
        };
      }
      return {
        provider: spec.id,
        providerName: spec.name,
        detectionMethod: 'prefix-offline',
        liveModels: null,
        rawModelCount: 0,
        filteredOutCount: 0,
      };
    }

    // Ambiguous key format (e.g. shared sk-* prefix): concurrently probe candidate endpoints
    if (offline && !hasCustomFetch) {
      throw new Error(
        '当前处于离线模式且该密钥前缀为通用格式，请先手动选择具体提供商或开启网络连接后重试。'
      );
    }

    const candidateSpecs = hint.candidates
      .map((id) => PROVIDER_PROBE_SPECS[id])
      .filter((s): s is ProviderProbeSpec => Boolean(s));

    const results = await Promise.all(
      candidateSpecs.map((spec) => probeSingleProvider(spec, trimmedKey, fetchFn))
    );

    const matched = results.find(
      (r): r is Extract<ProbeOutcome, { kind: 'ok' }> => r.kind === 'ok'
    );
    if (matched) {
      return {
        provider: matched.provider,
        providerName: matched.providerName,
        detectionMethod: 'probe',
        liveModels: matched.models,
        rawModelCount: matched.rawCount,
        filteredOutCount: Math.max(0, matched.rawCount - matched.models.length),
      };
    }

    const hadAuthRejection = results.some((r) => r.kind === 'auth_error');
    if (hadAuthRejection) {
      throw new Error(
        `已自动探测 ${candidateSpecs.map((s) => s.id).join(' / ')}，均返回鉴权失败；请检查密钥是否正确或手动选择对应提供商。`
      );
    }
    throw new Error(
      `无法连接到候选网关完成自动识别 (${candidateSpecs.map((s) => s.id).join(' / ')})，请检查网络或手动指定提供商。`
    );
  }

  // Manual provider selected by user
  const spec = PROVIDER_PROBE_SPECS[requested];
  if (!spec || (offline && !hasCustomFetch)) {
    return {
      provider: requested,
      providerName: spec?.name || requested,
      detectionMethod: 'manual-offline',
      liveModels: null,
      rawModelCount: 0,
      filteredOutCount: 0,
    };
  }

  const outcome = await probeSingleProvider(spec, trimmedKey, fetchFn);
  if (outcome.kind === 'auth_error') {
    throw new Error(
      `${spec.name} 鉴权失败 (HTTP ${outcome.status})，请检查该 API Key 是否属于 ${spec.name} 且处于有效状态。`
    );
  }
  if (outcome.kind === 'ok') {
    return {
      provider: spec.id,
      providerName: spec.name,
      detectionMethod: 'manual-verified',
      liveModels: outcome.models,
      rawModelCount: outcome.rawCount,
      filteredOutCount: Math.max(0, outcome.rawCount - outcome.models.length),
    };
  }
  return {
    provider: spec.id,
    providerName: spec.name,
    detectionMethod: 'manual-offline',
    liveModels: null,
    rawModelCount: 0,
    filteredOutCount: 0,
  };
}
