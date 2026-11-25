import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import { streamSimple as openAiCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  loadSkills,
} from '@earendil-works/pi-coding-agent';
import {
  clearReasoningOffFallbackCache,
  wrapModelRuntimeWithReasoningOffFallback,
} from './reasoning-effort-fallback.js';
import { createVnTools } from './vn-tools.js';
import { createReverserTools } from './reverser-tools.js';
import {
  classifySubagentError,
  SubagentManager,
  type SubagentCompactResult,
  type SubagentQueueRestoredEvent,
  type SubagentQueueUpdatedEvent,
  type SubagentStreamDeltaEvent,
  type SubagentTaskSnapshot,
  type SubagentTaskSummary,
  type SubagentUserSteerNote,
} from '../subagents/subagent-manager.js';
import {
  applyCompactionSettingsForModel,
  computeCompactionThresholds,
  createPaperCupCompactionExtension,
  estimateRealProjectedContextTokens,
  extractCompactionSummaryInfo,
  hasPostUsageContextEdit,
  isPaperCupContextOverflow,
  readPaperCupCompactionConfig,
  type CompactionReason,
  type CompactionSummaryInfo,
} from './compaction.js';
import {
  applyPaperCupQueueModes,
  type PendingQueueState,
  type QueuedMessageItem,
  type QueuedMessageMode,
  type QueueMutationResult,
  type RestoredDraftPayload,
  SessionQueueController,
} from './message-queue.js';
import {
  type ChatImageAttachment,
  DEFAULT_IMAGE_ONLY_PROMPT,
  extractImagesFromContent,
  inferCustomModelInputModalities,
  modelSupportsImageInput,
  summarizeUserMessagePreview,
  toPiImageContents,
  validateAndNormalizeImageAttachments,
} from './image-attachments.js';
import { detectVnEngineSummary, getVnStatus } from '../vn/core.js';
import {
  WORKSPACE_BATCHES_MANIFEST_REL,
  WORKSPACE_CHECKPOINTS_REL,
  WORKSPACE_PLAN_REL,
  WORKSPACE_POST_QA_REPORT_REL,
  WORKSPACE_POST_QA_STATE_REL,
  WORKSPACE_PROGRESS_REL,
  resolveWorkspacePaths,
} from '../vn/workspace-paths.js';
import { detectModelFamily, estimateTextTokens } from '../vn/tokens.js';
import { collectDeduplicatedSkillDirs } from '../vn/skill-registry.js';
import {
  loadWorkspaceTranslatorOverride,
  realpathSafe,
  type CharacterRosterStore,
  type TranslatorOverrideConfig,
} from '../vn/profile.js';
import {
  buildCharacterFormConfirmationMessage,
  cancelChatForm,
  listChatForms,
  readCharacterRoster,
  submitCharacterConfirmationForm,
  type CharacterConfirmationSubmissionItem,
  type ChatFormRecord,
} from '../vn/roster.js';
import {
  DEFAULT_SMOKE_CONFIG,
  inspectSmokeTools,
  loadGlobalSmokeConfig,
  loadWorkspaceSmokeOverride,
  mergeSmokeConfig,
  normalizeSmokeConfig,
  readSmokeReport,
  saveGlobalSmokeConfig,
  type SmokeConfigState,
  type SmokeReport,
  type SmokeTestConfig,
} from '../vn/smoke-config.js';
import type { SmokeExecutionDriver } from '../vn/smoke.js';
import {
  DEFAULT_LOCAL_TRANSLATOR_CONFIG,
  LOCAL_ENDPOINT_PRESETS,
  LocalTranslatorEndpointError,
  mergeTranslatorConfig,
  normalizeTranslatorConfig,
  pickPreferredLocalModel,
  probeLocalTranslatorEndpoint,
  toPublicTranslatorConfig,
  type LocalEndpointPresetInfo,
  type LocalProbeModel,
  type LocalProbeResult,
  type LocalTranslatorConfig,
  type LocalUsageDelta,
  type PublicLocalTranslatorConfig,
} from './local-translator.js';
import {
  detectLocalOllamaOrigin,
  getLocalOllamaStatus,
  isLocalOllamaCandidate,
  isLoopbackHostname,
  syncLocalOllamaConcurrency,
  type OllamaStatusResult,
  type OllamaSyncFn,
  type OllamaSyncResult,
} from './ollama-sync.js';
import { PAPERCUP_SYSTEM_PROMPT } from './prompt.js';
import {
  pickFileNative,
  pickFolderNative,
  type FilePickerFn,
  type FolderPickerFn,
  type FolderPickResult,
} from './folder-picker.js';
import {
  DEFAULT_MAGPIE_BASE_URL,
  MAGPIE_KEYLESS_RUNTIME_TOKEN,
  discoverProviderAndModels,
  inferContextWindowFromModelId,
  isSupportedLiveChatModel,
  normalizeMagpieBaseUrl,
  resolveDefaultMagpieBaseUrl,
  type DetectionMethod,
  type DiscoveredLiveModel,
  type ProviderProbeFetch,
} from './provider-discovery.js';
import {
  collectPersistedSecrets,
  createEmptyPersistedAuthState,
  loadPersistedAuthState,
  savePersistedAuthState,
  type PersistedApiAuthState,
} from './auth-store.js';
import { WorkspaceManager, WorkspaceRegistry } from './workspace-manager.js';
import { config, resolvePapercupConfigDir } from '../config.js';
import {
  createGuardedBuiltinToolDefinitions,
  DEFAULT_MAIN_BASH_MAX_TIMEOUT_SEC,
  readVnResearchConfig,
} from '../security/guarded-tools.js';
import { redactSecrets, redactUnknownValue } from '../security/secrets.js';

export class AppError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

const DELIVERY_MODE_CUSTOM_TYPE = 'papercup_user_delivery_mode';

function createKeylessFetchWrapper(baseFetch?: typeof fetch): typeof fetch {
  const targetFetch = baseFetch ?? globalThis.fetch;
  return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const nextInit: RequestInit = { ...(init ?? {}) };
    const headers = new Headers(
      nextInit.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.delete('authorization');
    nextInit.headers = headers;
    return targetFetch(input, nextInit);
  };
}

export interface AgentEvent {
  type: string;
  data: any;
  timestamp: string;
}

export interface ModelOption {
  key: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportsImage?: boolean;
}

export type ProviderAuthSource = 'runtime' | 'stored' | 'environment' | null;

export interface ProviderStatusInfo {
  id: string;
  name: string;
  envVar?: string;
  configured: boolean;
  source: ProviderAuthSource;
  savedLocally?: boolean;
  modelCount: number;
  baseUrl?: string;
  defaultBaseUrl?: string;
  supportsBaseUrl?: boolean;
  apiKeyOptional?: boolean;
  hasApiKey?: boolean;
}

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface ModelsState {
  current: string | null;
  models: ModelOption[];
  providers: ProviderStatusInfo[];
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
}

interface FeaturedProviderMeta {
  id: string;
  name: string;
  envVar: string;
}

type CustomOpenAIProviderId = 'modelscope' | 'volcengine' | 'siliconflow' | 'magpie';

interface CustomOpenAIPreset {
  id: string;
  name: string;
  reasoning?: boolean;
}

interface CustomOpenAIProviderSpec {
  id: CustomOpenAIProviderId;
  name: string;
  envVar: string;
  baseUrlEnvVar?: string;
  modelEnvVar?: string;
  baseUrl: string;
  catalogUrl: string;
  thinkingFormat: 'qwen' | 'deepseek' | 'openai';
  supportsReasoningEffort?: boolean;
  supportsBaseUrl?: boolean;
  apiKeyOptional?: boolean;
  resolveDefaultBaseUrl?: () => string;
  normalizeBaseUrl?: (raw?: string | null, fallback?: string) => string;
  resolveApiKeyRef: () => string;
  inferReasoning: (id: string) => boolean;
  inferInput?: (id: string) => ('text' | 'image')[];
  requiresMandatoryThinking?: (id: string) => boolean;
  requiresReasoningContent: (id: string) => boolean;
  requiresToolsWithToolHistory?: (id: string) => boolean;
  presets: readonly CustomOpenAIPreset[];
}

const MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.cn/v1';
const VOLCENGINE_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

const CUSTOM_OPENAI_PROVIDERS: Record<CustomOpenAIProviderId, CustomOpenAIProviderSpec> = {
  modelscope: {
    id: 'modelscope',
    name: 'ModelScope (魔搭)',
    envVar: 'MODELSCOPE_API_KEY',
    baseUrl: MODELSCOPE_BASE_URL,
    catalogUrl: `${MODELSCOPE_BASE_URL}/models`,
    thinkingFormat: 'qwen',
    resolveApiKeyRef: () => '$MODELSCOPE_API_KEY',
    inferReasoning: () => true,
    inferInput: inferCustomModelInputModalities,
    requiresReasoningContent: (id) => id.toLowerCase().includes('deepseek'),
    presets: [
      { id: 'Qwen/Qwen3.8-Flash-Next', name: 'Qwen3.8 Flash Next', reasoning: true },
      { id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8 27B', reasoning: true },
      { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5 397B A17B', reasoning: true },
      { id: 'Qwen/Qwen3.5-122B-A10B', name: 'Qwen3.5 122B A10B', reasoning: true },
      { id: 'Qwen/Qwen3.5-35B-A3B', name: 'Qwen3.5 35B A3B', reasoning: true },
      { id: 'Qwen/Qwen3.5-27B', name: 'Qwen3.5 27B', reasoning: true },
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash', reasoning: true },
      { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', reasoning: true },
      { id: 'ZhipuAI/GLM-5.2', name: 'GLM-5.2', reasoning: true },
      { id: 'ZhipuAI/GLM-4.7-Flash', name: 'GLM-4.7 Flash', reasoning: true },
      { id: 'moonshotai/Kimi-K3.1-Pro', name: 'Kimi K3.1 Pro', reasoning: true },
      { id: 'MiniMax/MiniMax-M3', name: 'MiniMax M3', reasoning: true },
      { id: 'stepfun-ai/Step-5-Preview', name: 'Step-5 Preview', reasoning: true },
      { id: 'stepfun-ai/Step-3.7-Flash', name: 'Step-3.7 Flash', reasoning: true },
    ],
  },
  volcengine: {
    id: 'volcengine',
    name: '火山方舟 (Volcengine Ark)',
    envVar: 'ARK_API_KEY',
    baseUrl: VOLCENGINE_ARK_BASE_URL,
    catalogUrl: `${VOLCENGINE_ARK_BASE_URL}/models`,
    thinkingFormat: 'deepseek',
    resolveApiKeyRef: () =>
      !process.env.ARK_API_KEY && process.env.VOLCENGINE_API_KEY
        ? '$VOLCENGINE_API_KEY'
        : '$ARK_API_KEY',
    inferReasoning: (id) => {
      const lower = id.toLowerCase();
      // 不透明的推理接入点 ep-* 无法从 ID 判断是否支持 thinking 参数，关闭主动下发以避免 400（服务端若回传 reasoning_content 仍可正常解析）
      if (lower.startsWith('ep-')) {
        return false;
      }
      if (
        /(?:doubao-(?:1[.-]5|pro|lite)|translation|instruct|coder)/.test(lower) &&
        !lower.includes('thinking')
      ) {
        return false;
      }
      return /(?:doubao-seed|thinking|reasoner|deepseek-r1|deepseek-v3[.-][12]|deepseek-v4|kimi-k2|glm-4[.-][5-9]|glm-[5-9])/.test(lower);
    },
    inferInput: inferCustomModelInputModalities,
    requiresMandatoryThinking: (id) =>
      /(?:deepseek-r1|kimi-k2-thinking)/i.test(id),
    requiresReasoningContent: (id) => {
      const lower = id.toLowerCase();
      return lower.includes('deepseek') || lower.includes('doubao-seed') || lower.includes('kimi') || lower.includes('glm');
    },
    presets: [
      { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro', reasoning: true },
      { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao Seed 2.0 Lite', reasoning: true },
      { id: 'doubao-seed-1-6-flash-250828', name: 'Doubao Seed 1.6 Flash', reasoning: true },
      { id: 'doubao-seed-1-6-251015', name: 'Doubao Seed 1.6', reasoning: true },
      { id: 'doubao-seed-1-6-lite-251015', name: 'Doubao Seed 1.6 Lite', reasoning: true },
      { id: 'deepseek-v3-2-251201', name: 'DeepSeek V3.2', reasoning: true },
      { id: 'deepseek-r1-250528', name: 'DeepSeek R1', reasoning: true },
      { id: 'kimi-k2-thinking-251104', name: 'Kimi K2 Thinking', reasoning: true },
      { id: 'glm-4-7-251222', name: 'GLM-4.7', reasoning: true },
    ],
  },
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    envVar: 'SILICONFLOW_API_KEY',
    baseUrl: SILICONFLOW_BASE_URL,
    catalogUrl: `${SILICONFLOW_BASE_URL}/models?type=text&sub_type=chat`,
    thinkingFormat: 'qwen',
    resolveApiKeyRef: () => '$SILICONFLOW_API_KEY',
    inferReasoning: (id) => {
      const lower = id.toLowerCase();
      if (/(?:qwen2|deepseek-v2|instruct|coder)/.test(lower) && !/(?:thinking|r1|qwq)/.test(lower)) {
        return false;
      }
      return /(?:thinking|reasoner|qwq|deepseek-r1|deepseek-v3[.-][12]|deepseek-v4|qwen3|glm-z1|glm-4[.-][5-9]|glm-[5-9]|kimi-k2[.-]5|kimi-k3|minimax-m|hunyuan-a13b)/.test(lower);
    },
    inferInput: inferCustomModelInputModalities,
    requiresReasoningContent: (id) => id.toLowerCase().includes('deepseek'),
    presets: [
      { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', reasoning: true },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', reasoning: false },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', reasoning: true },
      { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B A22B', reasoning: true },
      { id: 'Qwen/Qwen3-32B', name: 'Qwen3 32B', reasoning: true },
      { id: 'Qwen/Qwen3-14B', name: 'Qwen3 14B', reasoning: true },
      { id: 'Qwen/Qwen3-8B', name: 'Qwen3 8B', reasoning: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B Instruct', reasoning: false },
      { id: 'zai-org/GLM-4.7', name: 'GLM-4.7', reasoning: true },
      { id: 'moonshotai/Kimi-K2-Instruct', name: 'Kimi K2 Instruct', reasoning: false },
      { id: 'moonshotai/Kimi-K2-Thinking', name: 'Kimi K2 Thinking', reasoning: true },
    ],
  },
  magpie: {
    id: 'magpie',
    name: 'Magpie (本地网关)',
    envVar: 'MAGPIE_API_KEY',
    baseUrlEnvVar: 'MAGPIE_BASE_URL',
    modelEnvVar: 'MAGPIE_MODEL',
    baseUrl: DEFAULT_MAGPIE_BASE_URL,
    catalogUrl: `${DEFAULT_MAGPIE_BASE_URL}/models`,
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
    supportsBaseUrl: true,
    apiKeyOptional: true,
    resolveDefaultBaseUrl: resolveDefaultMagpieBaseUrl,
    normalizeBaseUrl: normalizeMagpieBaseUrl,
    resolveApiKeyRef: () =>
      !process.env.MAGPIE_API_KEY && process.env.MAGPIE_BASE_URL?.trim()
        ? MAGPIE_KEYLESS_RUNTIME_TOKEN
        : '$MAGPIE_API_KEY',
    inferReasoning: (id) => {
      const lower = id.toLowerCase();
      if (/(?:chat-latest|non-thinking)/i.test(lower)) {
        return false;
      }
      if (/(?:instruct|coder)/i.test(lower) && !/(?:thinking|reasoner|deepseek-r1|qwq|gpt-5|gpt-6)/i.test(lower)) {
        return false;
      }
      return /(?:^|[-_./])(?:reason|reasoner|thinking|qwq|deepseek-r1|deepseek-v3[.-][12]|deepseek-v4|r1-distill|gpt-5|gpt-6|o1|o3|o4|claude-3[.-]7|claude-(?:opus|sonnet|haiku|fable)-(?:4|5)|gemini-(?:2\.5|3|4)|grok-4|qwen3|doubao-seed|kimi-k2[.-]5|kimi-k3|glm-(?:4\.[5-9]|5|z1)|minimax-m)/i.test(
        lower
      );
    },
    inferInput: inferCustomModelInputModalities,
    requiresReasoningContent: (id) => /(?:deepseek|kimi|glm|doubao-seed)/i.test(id),
    requiresToolsWithToolHistory: (id) => id.toLowerCase().includes('claude'),
    presets: [],
  },
};

const CUSTOM_OPENAI_PROVIDER_LIST: readonly CustomOpenAIProviderSpec[] = Object.values(CUSTOM_OPENAI_PROVIDERS);

function isCustomOpenAIProviderId(providerId: string): providerId is CustomOpenAIProviderId {
  return Object.hasOwn(CUSTOM_OPENAI_PROVIDERS, providerId);
}

function buildCustomOpenAIModelDefinition(
  spec: CustomOpenAIProviderSpec,
  id: string,
  name?: string,
  reasoningOverride?: boolean,
  baseUrlOverride?: string,
  contextWindowOverride?: number
) {
  const reasoning = reasoningOverride ?? spec.inferReasoning(id);
  const mandatoryThinking = reasoning && Boolean(spec.requiresMandatoryThinking?.(id));
  const input: ('text' | 'image')[] = spec.inferInput ? spec.inferInput(id) : ['text'];
  const inferredCtx = inferContextWindowFromModelId(id);
  const contextWindow =
    typeof contextWindowOverride === 'number' &&
    Number.isFinite(contextWindowOverride) &&
    contextWindowOverride >= 2048
      ? Math.floor(contextWindowOverride)
      : inferredCtx ?? 131072;
  return {
    id,
    name: name ?? id,
    type: 'chat' as const,
    api: 'openai-completions' as const,
    provider: spec.id,
    baseUrl: baseUrlOverride ?? spec.baseUrl,
    reasoning,
    ...(mandatoryThinking ? { thinkingLevelMap: { off: null } } : {}),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 16384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: Boolean(spec.supportsReasoningEffort),
      supportsLongCacheRetention: false,
      requiresReasoningContentOnAssistantMessages: reasoning && spec.requiresReasoningContent(id),
      ...(spec.requiresToolsWithToolHistory?.(id) ? { requiresToolsWithToolHistory: true } : {}),
      maxTokensField: 'max_tokens' as const,
      supportsStrictMode: false,
      thinkingFormat: spec.thinkingFormat,
    },
  };
}

const DEFAULT_CUSTOM_PROVIDER_MODELS: Record<CustomOpenAIProviderId, any[]> = {
  modelscope: CUSTOM_OPENAI_PROVIDERS.modelscope.presets.map((p) =>
    buildCustomOpenAIModelDefinition(CUSTOM_OPENAI_PROVIDERS.modelscope, p.id, p.name, p.reasoning)
  ),
  volcengine: CUSTOM_OPENAI_PROVIDERS.volcengine.presets.map((p) =>
    buildCustomOpenAIModelDefinition(CUSTOM_OPENAI_PROVIDERS.volcengine, p.id, p.name, p.reasoning)
  ),
  siliconflow: CUSTOM_OPENAI_PROVIDERS.siliconflow.presets.map((p) =>
    buildCustomOpenAIModelDefinition(CUSTOM_OPENAI_PROVIDERS.siliconflow, p.id, p.name, p.reasoning)
  ),
  magpie: [],
};

const FEATURED_PROVIDERS: readonly FeaturedProviderMeta[] = [
  { id: 'google', name: 'Google AI Studio (Gemini)', envVar: 'GEMINI_API_KEY' },
  { id: 'anthropic', name: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'xai', name: 'xAI (Grok)', envVar: 'XAI_API_KEY' },
  { id: 'modelscope', name: 'ModelScope (魔搭)', envVar: 'MODELSCOPE_API_KEY' },
  { id: 'volcengine', name: '火山方舟 (Volcengine Ark)', envVar: 'ARK_API_KEY' },
  { id: 'siliconflow', name: 'SiliconFlow (硅基流动)', envVar: 'SILICONFLOW_API_KEY' },
  { id: 'magpie', name: 'Magpie (本地网关)', envVar: 'MAGPIE_API_KEY' },
  { id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY' },
  { id: 'moonshotai', name: 'Moonshot (Kimi)', envVar: 'MOONSHOT_API_KEY' },
  { id: 'minimax', name: 'MiniMax', envVar: 'MINIMAX_API_KEY' },
];

export type SessionMode = 'persist' | 'memory';
export type TurnPhase = 'connecting' | 'retrying' | 'thinking' | 'tool' | 'generating';

export interface AgentServiceOptions {
  sessionMode?: SessionMode;
  folderPicker?: FolderPickerFn;
  filePicker?: FilePickerFn;
  probeFetch?: ProviderProbeFetch;
  localTranslatorFetch?: typeof fetch;
  ollamaSyncer?: OllamaSyncFn;
  smokeDriver?: SmokeExecutionDriver;
}

export interface TranslatorConfigState {
  global: PublicLocalTranslatorConfig;
  workspaceOverride: TranslatorOverrideConfig | null;
  effective: PublicLocalTranslatorConfig;
  endpointPresets: readonly LocalEndpointPresetInfo[];
}

export interface TranslatorConfigUpdateResult extends TranslatorConfigState {
  ollamaSync?: OllamaSyncResult;
}

export interface TranslatorProbeResult extends LocalProbeResult {
  suggestedModel: string | null;
  ollamaAutoStarted?: boolean;
  ollamaVersion?: string;
  ollamaManaged?: boolean;
  ollamaSyncSeq?: number;
}

export interface TranslatorConfigUpdateInput {
  mode?: 'cloud_subagent' | 'local_mt';
  baseUrl?: string;
  model?: string;
  ollamaPath?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  preset?: 'sakura' | 'hy-mt' | 'plain-lines';
  packetLines?: number;
  concurrency?: number;
  contextWindow?: number;
  timeoutMs?: number;
  escalateFailedRows?: boolean;
  useTmCache?: boolean;
  disableThinking?: boolean;
}

export interface ApiKeyUpdateResult extends ModelsState {
  detectedProvider?: string;
  detectedProviderName?: string;
  detectionMethod?: DetectionMethod;
  liveModelCount?: number;
  filteredOutCount?: number;
}

export interface ApiKeyDetectPreview {
  provider: string;
  providerName: string;
  detectionMethod: DetectionMethod;
  liveModelCount: number;
  filteredOutCount: number;
  sampleModels: string[];
}

const MAX_HISTORY_TOOL_RESULT_TEXT_CHARS = 4096;
const ENGINEERING_STATUS_CACHE_TTL_MS = 15_000;
const SUBAGENT_TASKS_HISTORY_LIMIT = 80;

function toSafeNonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function toSafeNonNegNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function createEmptyTokenBucket(): TokenUsageBucket {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    calls: 0,
  };
}

function addUsageToBucket(
  bucket: TokenUsageBucket,
  rawUsage: any,
  options?: { estimated?: boolean; countCall?: boolean }
): void {
  if (!rawUsage || typeof rawUsage !== 'object') return;
  const input = toSafeNonNegInt(rawUsage.input);
  const output = toSafeNonNegInt(rawUsage.output);
  const cacheRead = toSafeNonNegInt(rawUsage.cacheRead);
  const cacheWrite = toSafeNonNegInt(rawUsage.cacheWrite);
  const rawTotal = toSafeNonNegInt(rawUsage.totalTokens);
  const entryTotal = rawTotal > 0 ? rawTotal : input + output + cacheRead + cacheWrite;

  bucket.input += input;
  bucket.output += output;
  bucket.cacheRead += cacheRead;
  bucket.cacheWrite += cacheWrite;
  bucket.totalTokens += entryTotal;

  const rawReasoning = rawUsage.reasoning ?? rawUsage.reasoningTokens;
  if (typeof rawReasoning === 'number' && Number.isFinite(rawReasoning) && rawReasoning >= 0) {
    bucket.reasoningTokens = (bucket.reasoningTokens ?? 0) + Math.round(rawReasoning);
  }
  if (options?.countCall !== false) {
    bucket.calls += 1;
  }
  if (options?.estimated) {
    bucket.estimated = true;
  }
}

const PROVIDER_API_PRELOADERS: Record<string, () => Promise<unknown>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'openai-codex-responses': () => import('@earendil-works/pi-ai/api/openai-codex-responses'),
  'azure-openai-responses': () => import('@earendil-works/pi-ai/api/azure-openai-responses'),
  'bedrock-converse-stream': () => import('@earendil-works/pi-ai/api/bedrock-converse-stream'),
  'mistral-conversations': () => import('@earendil-works/pi-ai/api/mistral-conversations'),
  'google-vertex': () => import('@earendil-works/pi-ai/api/google-vertex'),
};

const warmedApis = new Set<string>();
const warmingApiPromises = new Map<string, Promise<void>>();

const HISTORY_TOOL_DETAIL_KEYS = [
  'status',
  'exitCode',
  'isError',
  'taskId',
  'subagentTaskIds',
  'role',
  'metrics',
  'savedOutputPath',
  'artifacts',
  'interruptKind',
  'ok',
  'rejected',
  'engine',
  'chatFormId',
  'chatFormKind',
] as const;

function truncateToolResultForHistory(
  rawContent: unknown,
  rawDetails: unknown
): { content: any[]; details: Record<string, unknown> | undefined } {
  const detailsObj =
    rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : undefined;
  const savedOutputPath =
    typeof detailsObj?.savedOutputPath === 'string' && detailsObj.savedOutputPath
      ? detailsObj.savedOutputPath
      : undefined;

  let prunedDetails: Record<string, unknown> | undefined;
  if (detailsObj) {
    const kept: Record<string, unknown> = {};
    for (const key of HISTORY_TOOL_DETAIL_KEYS) {
      if (detailsObj[key] !== undefined) {
        kept[key] = detailsObj[key];
      }
    }
    if (Object.keys(kept).length > 0) {
      prunedDetails = kept;
    }
  }

  const contentList = Array.isArray(rawContent) ? rawContent : [];
  const truncatedContent = contentList.map((part) => {
    if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
      return part;
    }
    if (part.text.length <= MAX_HISTORY_TOOL_RESULT_TEXT_CHARS) {
      return part;
    }
    const origLen = part.text.length;
    const suffix = `\n…（历史预览已截断，原长 ${origLen} 字符${savedOutputPath ? `；完整输出位于 ${savedOutputPath}` : ''}）`;
    return {
      ...part,
      text: `${part.text.slice(0, MAX_HISTORY_TOOL_RESULT_TEXT_CHARS)}${suffix}`,
    };
  });

  return { content: truncatedContent, details: prunedDetails };
}

export interface PersistedToolCall {
  callId?: string;
  tool: string;
  args?: any;
  result?: any;
  isError?: boolean;
  liveDeltaChars?: number;
  subagentTaskId?: string;
  subagentTaskIds?: string[];
  subagentRole?: string;
}

export interface PersistedChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'compaction';
  content: string;
  images?: ChatImageAttachment[];
  thinking?: string;
  tools?: PersistedToolCall[];
  timestamp: string;
  error?: boolean;
  deliveryMode?: QueuedMessageMode;
  compaction?: {
    reason: CompactionReason;
    tokensBefore: number;
    tokensAfter: number;
    focus?: string;
    checkpointPath?: string;
  };
}

export interface CompactSessionResult {
  ok: true;
  status: 'compacted' | 'noop' | 'queued';
  result?: CompactionSummaryInfo;
  message?: string;
  tokenUsage?: SessionTokenUsageSnapshot;
  focus?: string;
}

export interface ActiveTurnSnapshot {
  sessionId: string | null;
  model: string | null;
  isThinking: boolean;
  phase?: TurnPhase;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  thinking: string;
  response: string;
  tools: PersistedToolCall[];
  startedAt: string;
}

export interface TokenUsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens?: number;
  calls: number;
  estimated?: boolean;
}

export interface SessionTokenUsageSnapshot {
  sessionId: string | null;
  total: TokenUsageBucket;
  cloud: TokenUsageBucket;
  local: TokenUsageBucket;
  breakdown: {
    main: TokenUsageBucket;
    cloudTranslator: TokenUsageBucket;
    cloudEscalation: TokenUsageBucket;
    roleChecker: TokenUsageBucket;
    reverser: TokenUsageBucket;
    smokeVision: TokenUsageBucket;
    otherSubagents: TokenUsageBucket;
    compaction: TokenUsageBucket;
    localMt: TokenUsageBucket;
  };
  currentTurn: {
    cloud: TokenUsageBucket;
    local: TokenUsageBucket;
    totalTokens: number;
    live: boolean;
  };
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    triggerTokens?: number;
  } | null;
  translatorMode: 'cloud_subagent' | 'local_mt';
  cloudCostUsd: number;
  updatedAt: string;
}

export interface TurnSyncState {
  isRunning: boolean;
  isCompacting: boolean;
  queuedCompaction: { focus?: string } | null;
  sessionId: string | null;
  activeTurn: ActiveTurnSnapshot | null;
  pendingQueue: PendingQueueState;
  activeDirectSubagentTaskId?: string | null;
  subagentTasks: SubagentTaskSummary[];
  tokenUsage: SessionTokenUsageSnapshot;
  chatForms?: ChatFormRecord[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionHistoryState {
  sessionId: string | null;
  persisted: boolean;
  workspace: string;
  messages: PersistedChatMessage[];
  sessions: SessionSummary[];
  isRunning: boolean;
  isCompacting: boolean;
  queuedCompaction: { focus?: string } | null;
  activeTurn: ActiveTurnSnapshot | null;
  pendingQueue: PendingQueueState;
  activeDirectSubagentTaskId?: string | null;
  subagentTasks: SubagentTaskSummary[];
  tokenUsage: SessionTokenUsageSnapshot;
  chatForms?: ChatFormRecord[];
}

interface MemorySessionRecord {
  manager: SessionManager;
  updatedAtMs: number;
  seq: number;
}

interface CachedSessionFileMeta {
  mtimeMs: number;
  size: number;
  filePath: string;
  cwdMatches: boolean;
  modifiedMs: number;
  summary: SessionSummary;
}

export class AgentService extends EventEmitter {
  private workspaceManager: WorkspaceManager;
  private activeWorkspace: string;
  private sessionMode: SessionMode;
  private folderPicker: FolderPickerFn;
  private filePicker: FilePickerFn;
  private probeFetch?: ProviderProbeFetch;
  private localTranslatorFetch?: typeof fetch;
  private ollamaSyncer?: OllamaSyncFn;
  private smokeDriver?: SmokeExecutionDriver;
  private translatorConfig: LocalTranslatorConfig = { ...DEFAULT_LOCAL_TRANSLATOR_CONFIG };
  private smokeConfig: SmokeTestConfig = { ...DEFAULT_SMOKE_CONFIG };
  private pickFolderInFlight: Promise<FolderPickResult> | null = null;
  private pickOllamaInFlight: Promise<FolderPickResult> | null = null;
  private pickSmokeToolInFlight: Promise<FolderPickResult> | null = null;
  private ollamaEnsureInFlight: Promise<OllamaSyncResult> | null = null;
  private syncSeq = 0;
  private lastOllamaRuntime: {
    origin: string;
    running: boolean;
    version?: string;
    managedByPaperCup: boolean;
    concurrency?: number;
    checkedAt: number;
  } | null = null;
  private currentSession: any = null;
  private initSessionPromise: Promise<void> | null = null;
  private sessionEpoch = 0;
  private sessionManager: SessionManager | null = null;
  private sharedModelRuntime: any = null;
  private sharedModelRuntimePromise: Promise<any> | null = null;
  private customProvidersInitialized = false;
  private resourceLoader: DefaultResourceLoader | null = null;
  private settingsManager: SettingsManager | null = null;
  private subagentManager = new SubagentManager();
  private isRunningTurn = false;
  private isCompacting = false;
  private queuedMainCompaction: { focus?: string } | null = null;
  private pendingManualCompactionFocus: string | undefined = undefined;
  private pendingCompactionReasonOverride: CompactionReason | undefined = undefined;
  private lastCompletedCompactionInfo: CompactionSummaryInfo | null = null;
  private turnOverflowCompactionAttempted = false;
  private turnLock = false;
  private directSubagentLock = false;
  private turnAborted = false;
  private activeTurnAbortController: AbortController | null = null;
  private activeTurnSnapshot: ActiveTurnSnapshot | null = null;
  private activeDirectSubagentTaskId: string | null = null;
  private activeDirectSubagentAbortController: AbortController | null = null;
  private activeTurnPrompt = '';
  private activeTurnImages: ChatImageAttachment[] = [];
  private activeTurnStartedAtLabel = '';
  private turnBaseMessageCount = 0;
  private mainQueueController = new SessionQueueController();
  private activeTurnCommittedMessages: PersistedChatMessage[] = [];
  private activeTurnUserMsgCount = 0;
  private activeTurnCommitSeq = 0;
  private activeTurnRestoredDraft: RestoredDraftPayload | null = null;
  private deliveredUserModes = new Map<string, QueuedMessageMode>();
  private turnTiming: {
    startedAt: number;
    promptCalledAt: number;
    firstTokenAt: number | null;
    retries: number;
    modelKey: string;
  } | null = null;
  private pendingSkillReload = false;
  private persistedAuth: PersistedApiAuthState = createEmptyPersistedAuthState();
  private preferredModelKey: string | null = null;
  private preferredThinkingLevel: ThinkingLevel | null = null;
  private runtimeApiKeys = new Map<string, string>();
  private keylessRuntimeProviders = new Set<string>();
  private customProviderBaseUrls = new Map<CustomOpenAIProviderId, string>();
  private clearedProviders = new Set<string>();
  private liveCustomProviderModels = new Map<CustomOpenAIProviderId, any[]>();
  private customProviderModels = new Map<CustomOpenAIProviderId, Map<string, any>>();
  private liveProviderModelAllowlist = new Map<string, Set<string>>();
  private liveDynamicProviderModels = new Map<string, any[]>();
  private memorySessions = new Map<string, Map<string, MemorySessionRecord>>();
  private wrappedSessionManagers = new WeakSet<SessionManager>();
  private engineeringStatusCache = new Map<string, { value: any; cachedAt: number }>();
  private sessionFileMetaCache = new Map<string, CachedSessionFileMeta>();
  private memorySeq = 0;
  private lastTurnError: string | undefined;
  private turnUsageStartEntryIndex = 0;
  private inFlightMainStreamText = '';
  private lastLiveUsageEmitMs = 0;

  private workspaceKey(workspace: string): string {
    const resolved = path.resolve(workspace);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private getWorkspaceMemoryMap(workspace = this.activeWorkspace): Map<string, MemorySessionRecord> {
    const key = this.workspaceKey(workspace);
    let map = this.memorySessions.get(key);
    if (!map) {
      map = new Map();
      this.memorySessions.set(key, map);
    }
    return map;
  }

  private disposeCurrentSessionState(clearManager: boolean): void {
    this.sessionEpoch += 1;
    this.initSessionPromise = null;
    this.turnUsageStartEntryIndex = 0;
    this.inFlightMainStreamText = '';
    this.lastLiveUsageEmitMs = 0;
    this.mainQueueController.reset();
    this.activeTurnCommittedMessages = [];
    this.activeTurnUserMsgCount = 0;
    this.activeTurnCommitSeq = 0;
    this.activeTurnRestoredDraft = null;
    this.isCompacting = false;
    this.queuedMainCompaction = null;
    this.pendingManualCompactionFocus = undefined;
    this.pendingCompactionReasonOverride = undefined;
    this.lastCompletedCompactionInfo = null;
    this.turnOverflowCompactionAttempted = false;
    this.settingsManager = null;
    if (this.activeDirectSubagentTaskId) {
      const reason = '会话或工作区已切换，已中止子代理对话。';
      this.activeDirectSubagentAbortController?.abort(reason);
      this.subagentManager.abortTask(this.activeDirectSubagentTaskId, reason);
      this.activeDirectSubagentTaskId = null;
      this.activeDirectSubagentAbortController = null;
    }
    if (this.currentSession) {
      try {
        this.currentSession.clearQueue?.();
      } catch {
        // Ignore queue cleanup error on dispose
      }
      try {
        this.currentSession.dispose?.();
      } catch (e) {
        console.warn('Error disposing previous session:', e);
      }
      this.currentSession = null;
      this.resourceLoader = null;
      this.pendingSkillReload = false;
    }
    if (clearManager) {
      this.subagentManager.disposeResumableSessions(this.activeWorkspace);
      this.sessionManager = null;
    }
  }

  private bumpSessionFileMtime(filePath: string, sessionDir: string): void {
    let maxMtimeMs = 0;
    try {
      for (const file of fs.readdirSync(sessionDir)) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const stat = fs.statSync(path.join(sessionDir, file));
          if (stat.mtimeMs > maxMtimeMs) maxMtimeMs = stat.mtimeMs;
        } catch {
          // Ignore transient stat error
        }
      }
    } catch {
      // Ignore directory scan error
    }
    const nextDate = new Date(Math.max(Date.now() + 20, maxMtimeMs + 20));
    try {
      fs.utimesSync(filePath, nextDate, nextDate);
    } catch {
      // Ignore filesystem timestamp update errors
    }
  }

  private resolveGlobalConfigDir(): string {
    return resolvePapercupConfigDir();
  }

  private resolveSessionDir(workspace: string): string {
    let canonical = path.resolve(workspace);
    try {
      canonical = fs.realpathSync(workspace);
    } catch {
      // Keep resolved path when realpath is unavailable
    }
    const normalizedForHash = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const digest = crypto.createHash('sha256').update(normalizedForHash, 'utf8').digest('hex').slice(0, 8);
    const slug =
      path
        .basename(canonical)
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '') || 'project';
    return path.join(this.resolveGlobalConfigDir(), 'projects', `${slug}_${digest}`, 'sessions');
  }

  isBusy(): boolean {
    return (
      this.isRunningTurn ||
      this.turnLock ||
      this.isCompacting ||
      this.directSubagentLock ||
      Boolean(this.activeDirectSubagentTaskId)
    );
  }

  private collectSkillPaths(): string[] {
    const globalConfigDir = this.resolveGlobalConfigDir();
    return collectDeduplicatedSkillDirs(this.activeWorkspace, { homeDir: globalConfigDir });
  }

  private invalidateEngineeringStatusCache(workspace?: string): void {
    if (workspace) {
      this.engineeringStatusCache.delete(this.workspaceKey(workspace));
    } else {
      this.engineeringStatusCache.clear();
    }
  }

  private async refreshLoadedSkills(): Promise<void> {
    if (!this.resourceLoader) {
      return;
    }
    await this.resourceLoader.reload();
    this.pendingSkillReload = true;
    this.invalidateEngineeringStatusCache();
    const skills = this.resourceLoader.getSkills?.().skills?.map((s: any) => s.name) ?? [];
    this.emitEvent('skills_updated', { skills });
  }

  private listEngineSkills(): string[] {
    const names = new Set<string>();
    for (const skillDir of this.collectSkillPaths()) {
      const name = path.basename(skillDir);
      if (name.startsWith('engine-')) {
        names.add(name);
      }
    }
    return Array.from(names).sort();
  }

  constructor(initialWorkspace?: string, options?: AgentServiceOptions) {
    super();
    this.sessionMode = options?.sessionMode ?? 'persist';
    this.folderPicker = options?.folderPicker ?? pickFolderNative;
    this.filePicker = options?.filePicker ?? pickFileNative;
    this.probeFetch = options?.probeFetch;
    this.localTranslatorFetch = options?.localTranslatorFetch;
    this.ollamaSyncer = options?.ollamaSyncer;
    this.smokeDriver = options?.smokeDriver;
    this.translatorConfig = this.loadPersistedTranslatorConfig();
    this.smokeConfig =
      this.sessionMode === 'persist'
        ? loadGlobalSmokeConfig(this.resolveGlobalConfigDir())
        : { ...DEFAULT_SMOKE_CONFIG };
    this.persistedAuth = this.loadPersistedAuth();
    if (this.persistedAuth.preferredThinkingLevel) {
      this.preferredThinkingLevel = this.persistedAuth.preferredThinkingLevel;
    }
    if (this.persistedAuth.preferredModel) {
      this.preferredModelKey = this.persistedAuth.preferredModel;
    }
    for (const [pid, rec] of Object.entries(this.persistedAuth.providers)) {
      if (isCustomOpenAIProviderId(pid)) {
        const spec = CUSTOM_OPENAI_PROVIDERS[pid];
        if (rec.baseUrl && spec.supportsBaseUrl) {
          try {
            const defaultUrl = spec.resolveDefaultBaseUrl?.() ?? spec.baseUrl;
            const normalized = spec.normalizeBaseUrl
              ? spec.normalizeBaseUrl(rec.baseUrl, defaultUrl)
              : rec.baseUrl.replace(/\/+$/, '');
            this.customProviderBaseUrls.set(pid, normalized);
          } catch {
            // Ignore invalid persisted baseUrl
          }
        }
        if (Array.isArray(rec.customModels)) {
          for (const cm of rec.customModels) {
            this.registerCustomProviderModel(pid, cm);
          }
        }
      }
    }
    const resolvedInitial = initialWorkspace ? path.resolve(initialWorkspace) : undefined;
    this.workspaceManager = new WorkspaceManager({
      configDir: this.resolveGlobalConfigDir(),
      persist: this.sessionMode === 'persist',
      initialWorkspace: resolvedInitial,
    });
    if (resolvedInitial) {
      if (
        this.sessionMode === 'persist' &&
        fs.existsSync(resolvedInitial) &&
        fs.statSync(resolvedInitial).isDirectory()
      ) {
        this.activeWorkspace = this.workspaceManager.switchWorkspace(resolvedInitial);
      } else {
        this.activeWorkspace = resolvedInitial;
      }
    } else {
      this.activeWorkspace = this.workspaceManager.getRegistry().active;
    }
  }

  private extractText(content: any): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  private formatTimestamp(ts: unknown): string {
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      return new Date(ts).toLocaleTimeString();
    }
    if (typeof ts === 'string' && ts.trim()) {
      const parsed = Date.parse(ts);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toLocaleTimeString();
      }
    }
    return '';
  }

  private *getAllKnownSecrets(): Iterable<string> {
    yield* this.runtimeApiKeys.values();
    yield* collectPersistedSecrets(this.persistedAuth);
    if (this.translatorConfig.apiKey.trim()) {
      yield this.translatorConfig.apiKey.trim();
    }
  }

  private resolveAuthConfigPath(): string {
    return path.join(this.resolveGlobalConfigDir(), 'auth.json');
  }

  private loadPersistedAuth(): PersistedApiAuthState {
    if (this.sessionMode !== 'persist') {
      return createEmptyPersistedAuthState();
    }
    return loadPersistedAuthState(this.resolveAuthConfigPath());
  }

  private savePersistedAuth(): void {
    if (this.sessionMode !== 'persist') {
      return;
    }
    savePersistedAuthState(this.resolveAuthConfigPath(), this.persistedAuth);
  }

  private recordCustomModelInPersistedAuth(providerId: CustomOpenAIProviderId, cleanModelId: string): void {
    if (this.sessionMode !== 'persist' || !cleanModelId) {
      return;
    }
    const existing = this.persistedAuth.providers[providerId] ?? {};
    const prevCustom = existing.customModels ?? [];
    if (prevCustom.includes(cleanModelId)) {
      return;
    }
    this.persistedAuth.providers[providerId] = {
      ...existing,
      customModels: [...prevCustom, cleanModelId],
    };
  }

  private resolveTranslatorConfigPath(): string {
    return path.join(this.resolveGlobalConfigDir(), 'translator.json');
  }

  private loadPersistedTranslatorConfig(): LocalTranslatorConfig {
    if (this.sessionMode !== 'persist') {
      return { ...DEFAULT_LOCAL_TRANSLATOR_CONFIG };
    }
    const filePath = this.resolveTranslatorConfigPath();
    try {
      if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
        return { ...DEFAULT_LOCAL_TRANSLATOR_CONFIG };
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
      return normalizeTranslatorConfig(raw, DEFAULT_LOCAL_TRANSLATOR_CONFIG);
    } catch {
      return { ...DEFAULT_LOCAL_TRANSLATOR_CONFIG };
    }
  }

  private savePersistedTranslatorConfig(cfg: LocalTranslatorConfig): void {
    if (this.sessionMode !== 'persist') {
      return;
    }
    const filePath = this.resolveTranslatorConfigPath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`);
    const payload = JSON.stringify(cfg, null, 2) + '\n';
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  getEffectiveTranslatorConfig(cwd = this.activeWorkspace): LocalTranslatorConfig {
    const wsOverride = loadWorkspaceTranslatorOverride(cwd);
    return mergeTranslatorConfig(this.translatorConfig, wsOverride);
  }

  getTranslatorConfigState(): TranslatorConfigState {
    const wsOverride = loadWorkspaceTranslatorOverride(this.activeWorkspace);
    const effective = mergeTranslatorConfig(this.translatorConfig, wsOverride);
    return {
      global: toPublicTranslatorConfig(this.translatorConfig),
      workspaceOverride: wsOverride,
      effective: toPublicTranslatorConfig(effective),
      endpointPresets: LOCAL_ENDPOINT_PRESETS,
    };
  }

  async pickOllamaBinary(initialPath?: string): Promise<FolderPickResult> {
    if (this.isBusy()) {
      throw new AppError('Cannot pick Ollama executable while a turn is in progress.', 409);
    }
    if (this.pickOllamaInFlight) {
      return this.pickOllamaInFlight;
    }
    const effective = this.getEffectiveTranslatorConfig();
    const pending = this.filePicker({
      initialPath: initialPath?.trim() || effective.ollamaPath || undefined,
      title: '选择本机 Ollama 可执行文件（ollama.exe）',
    }).finally(() => {
      if (this.pickOllamaInFlight === pending) {
        this.pickOllamaInFlight = null;
      }
    });
    this.pickOllamaInFlight = pending;
    return pending;
  }

  getSmokeConfigState(cwd = this.activeWorkspace): SmokeConfigState {
    const wsOverride = loadWorkspaceSmokeOverride(cwd);
    const effective = mergeSmokeConfig(this.smokeConfig, wsOverride);
    const tools = inspectSmokeTools(effective);
    return {
      global: { ...this.smokeConfig },
      workspaceOverride: wsOverride,
      effective,
      tools,
    };
  }

  updateSmokeConfig(patch: Partial<SmokeTestConfig>): SmokeConfigState {
    const next = normalizeSmokeConfig({ ...this.smokeConfig, ...patch }, this.smokeConfig);
    this.smokeConfig = next;
    if (this.sessionMode === 'persist') {
      saveGlobalSmokeConfig(next, this.resolveGlobalConfigDir());
    }
    this.invalidateEngineeringStatusCache();
    const state = this.getSmokeConfigState();
    this.emitEvent('smoke_config_updated', state);
    return state;
  }

  async pickSmokeToolBinary(
    tool: 'textractor' | 'locale_emulator',
    initialPath?: string
  ): Promise<FolderPickResult> {
    if (this.isBusy()) {
      throw new AppError('Cannot pick smoke test executable while a turn is in progress.', 409);
    }
    if (this.pickSmokeToolInFlight) {
      return this.pickSmokeToolInFlight;
    }
    const effective = this.getSmokeConfigState().effective;
    const isTr = tool === 'textractor';
    const pending = this.filePicker({
      initialPath:
        initialPath?.trim() || (isTr ? effective.textractorPath : effective.localeEmulatorPath) || undefined,
      title: isTr ? '选择 TextractorCLI.exe（或所在目录内可执行文件）' : '选择 Locale Emulator（LEProc.exe）',
      filter: isTr
        ? 'TextractorCLI (TextractorCLI.exe)|TextractorCLI.exe|可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*'
        : 'Locale Emulator (LEProc.exe)|LEProc.exe|可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*',
    }).finally(() => {
      if (this.pickSmokeToolInFlight === pending) {
        this.pickSmokeToolInFlight = null;
      }
    });
    this.pickSmokeToolInFlight = pending;
    return pending;
  }

  getLatestSmokeReport(cwd = this.activeWorkspace): SmokeReport | null {
    return readSmokeReport(cwd);
  }

  private emitTranslatorSyncStatus(payload: {
    phase: 'starting' | 'restarting' | 'ready' | 'error';
    concurrency: number;
    message: string;
    status?: OllamaSyncResult['status'];
    version?: string;
    managedByPaperCup?: boolean;
    origin?: string;
  }): number {
    const seq = ++this.syncSeq;
    this.emitEvent('translator_sync_status', {
      seq,
      target: 'ollama',
      ...payload,
    });
    return seq;
  }

  private async runOllamaSyncManaged(input: {
    baseUrl: string;
    concurrency: number;
    ollamaPath?: string;
    forceRestart: boolean;
  }): Promise<OllamaSyncResult> {
    if (!this.ollamaSyncer && this.sessionMode !== 'persist') {
      return {
        attempted: false,
        synced: false,
        status: 'skipped',
        concurrency: input.concurrency,
        reason: 'memory_mode',
        message: '',
      };
    }

    if (!input.forceRestart && this.ollamaEnsureInFlight) {
      return this.ollamaEnsureInFlight;
    }

    const execute = async (): Promise<OllamaSyncResult> => {
      if (input.forceRestart && this.ollamaEnsureInFlight) {
        await this.ollamaEnsureInFlight.catch(() => undefined);
      }

      const candidate = isLocalOllamaCandidate(input.baseUrl);
      let shouldEmitRestart = false;
      if (input.forceRestart) {
        let loopback = candidate;
        if (!loopback) {
          try {
            loopback = isLoopbackHostname(new URL(input.baseUrl).hostname);
          } catch {
            loopback = false;
          }
        }
        if (candidate) {
          shouldEmitRestart = true;
        } else if (loopback) {
          if (this.ollamaSyncer) {
            shouldEmitRestart = true;
          } else {
            const preCheck = await detectLocalOllamaOrigin(
              input.baseUrl,
              this.localTranslatorFetch,
              input.ollamaPath
            );
            if (!preCheck.isOllama) {
              return {
                attempted: false,
                synced: false,
                status: 'skipped',
                concurrency: input.concurrency,
                ...(preCheck.origin ? { origin: preCheck.origin } : {}),
                reason: preCheck.reason || 'not_ollama',
                message: '',
              };
            }
            shouldEmitRestart = true;
          }
        }
      }

      let emittedStarting = false;
      if (shouldEmitRestart) {
        emittedStarting = true;
        this.emitTranslatorSyncStatus({
          phase: 'restarting',
          concurrency: input.concurrency,
          message: `正在后台重启本机 Ollama 并切换接管（并发=${input.concurrency}，FA=1 / KV=q8_0 / CTX=2048）…`,
        });
      } else if (!input.forceRestart && candidate) {
        emittedStarting = true;
        this.emitTranslatorSyncStatus({
          phase: 'starting',
          concurrency: input.concurrency,
          message: `正在后台自动启动本机 Ollama（并发=${input.concurrency}，FA=1 / KV=q8_0 / CTX=2048）…`,
        });
      }

      const syncFn = this.ollamaSyncer ?? syncLocalOllamaConcurrency;
      const syncRes = await syncFn({
        baseUrl: input.baseUrl,
        concurrency: input.concurrency,
        ...(input.ollamaPath !== undefined ? { ollamaPath: input.ollamaPath } : {}),
        forceRestart: input.forceRestart,
        fetchImpl: this.localTranslatorFetch,
      });

      if (syncRes.origin && syncRes.status !== 'skipped') {
        this.lastOllamaRuntime = {
          origin: syncRes.origin,
          running: syncRes.synced,
          ...(syncRes.version ? { version: syncRes.version } : {}),
          managedByPaperCup: Boolean(syncRes.managedByPaperCup),
          concurrency: syncRes.concurrency,
          checkedAt: Date.now(),
        };
        this.invalidateEngineeringStatusCache();
      }

      let terminalSeq: number | undefined;
      if (syncRes.attempted) {
        terminalSeq = this.emitTranslatorSyncStatus({
          phase: syncRes.synced ? 'ready' : 'error',
          status: syncRes.status,
          concurrency: syncRes.concurrency,
          message: syncRes.message,
          ...(syncRes.version ? { version: syncRes.version } : {}),
          ...(syncRes.managedByPaperCup !== undefined ? { managedByPaperCup: syncRes.managedByPaperCup } : {}),
          ...(syncRes.origin ? { origin: syncRes.origin } : {}),
        });
      } else if (emittedStarting && syncRes.status === 'already_running') {
        terminalSeq = this.emitTranslatorSyncStatus({
          phase: 'ready',
          status: 'already_running',
          concurrency: syncRes.concurrency,
          message: syncRes.message || '本机 Ollama 已在运行。',
          ...(syncRes.version ? { version: syncRes.version } : {}),
          ...(syncRes.managedByPaperCup !== undefined ? { managedByPaperCup: syncRes.managedByPaperCup } : {}),
          ...(syncRes.origin ? { origin: syncRes.origin } : {}),
        });
      } else if (emittedStarting && syncRes.status === 'skipped') {
        terminalSeq = this.emitTranslatorSyncStatus({
          phase: 'ready',
          status: 'skipped',
          concurrency: syncRes.concurrency,
          message: '',
          ...(syncRes.origin ? { origin: syncRes.origin } : {}),
        });
      }

      return terminalSeq !== undefined ? { ...syncRes, syncSeq: terminalSeq } : syncRes;
    };

    if (!input.forceRestart) {
      const pending = execute().finally(() => {
        if (this.ollamaEnsureInFlight === pending) {
          this.ollamaEnsureInFlight = null;
        }
      });
      this.ollamaEnsureInFlight = pending;
      return pending;
    }

    return execute();
  }

  async getLocalOllamaStatus(options?: {
    baseUrl?: string;
    ollamaPath?: string;
  }): Promise<OllamaStatusResult> {
    const effective = this.getEffectiveTranslatorConfig();
    const baseUrl = options?.baseUrl?.trim() || effective.baseUrl;
    const ollamaPath = options?.ollamaPath !== undefined ? options.ollamaPath : effective.ollamaPath;
    const status = await getLocalOllamaStatus({
      baseUrl,
      ollamaPath,
      fetchImpl: this.localTranslatorFetch,
    });
    if (status.origin) {
      this.lastOllamaRuntime = {
        origin: status.origin,
        running: status.running,
        ...(status.version ? { version: status.version } : {}),
        managedByPaperCup: status.managedByPaperCup,
        ...(status.lastSyncedConcurrency !== undefined ? { concurrency: status.lastSyncedConcurrency } : {}),
        checkedAt: Date.now(),
      };
    }
    return status;
  }

  async startLocalOllama(options?: {
    baseUrl?: string;
    ollamaPath?: string;
    concurrency?: number;
    forceRestart?: boolean;
  }): Promise<{
    ok: boolean;
    ollamaSync: OllamaSyncResult;
    status: OllamaStatusResult;
    models: LocalProbeModel[];
    suggestedModel: string | null;
  }> {
    if (this.isBusy()) {
      throw new AppError('Cannot start or restart Ollama while a turn is in progress.', 409);
    }
    const effective = this.getEffectiveTranslatorConfig();
    const baseUrl = options?.baseUrl?.trim() || effective.baseUrl;
    const ollamaPath = options?.ollamaPath !== undefined ? options.ollamaPath : effective.ollamaPath;
    const concurrency =
      typeof options?.concurrency === 'number' && Number.isFinite(options.concurrency)
        ? Math.max(1, Math.min(8, Math.round(options.concurrency)))
        : effective.concurrency;

    const ollamaSync = await this.runOllamaSyncManaged({
      baseUrl,
      concurrency,
      ollamaPath,
      forceRestart: Boolean(options?.forceRestart),
    });

    const status = await this.getLocalOllamaStatus({ baseUrl, ollamaPath });
    let models: LocalProbeModel[] = status.models;
    if (models.length === 0 && (ollamaSync.synced || status.running)) {
      try {
        const probed = await probeLocalTranslatorEndpoint(baseUrl, {
          apiKey: effective.apiKey,
          fetchImpl: this.localTranslatorFetch,
        });
        if (probed.models.length > 0) {
          models = probed.models;
        }
      } catch {
        // Ignore if /v1/models fails while tags already succeeded or empty
      }
    }
    const suggestedModel = pickPreferredLocalModel(models) ?? status.suggestedModel;
    return {
      ok: ollamaSync.synced || status.running,
      ollamaSync,
      status: {
        ...status,
        models,
        suggestedModel,
      },
      models,
      suggestedModel,
    };
  }

  async updateTranslatorConfig(patch: TranslatorConfigUpdateInput): Promise<TranslatorConfigUpdateResult> {
    if (this.isBusy()) {
      throw new AppError('Cannot update translator configuration while a turn is in progress.', 409);
    }
    const nextPatch: Record<string, unknown> = { ...patch };
    if (patch.clearApiKey === true) {
      nextPatch.apiKey = '';
    } else if (patch.apiKey === undefined) {
      delete nextPatch.apiKey;
    }
    delete nextPatch.clearApiKey;

    const next = normalizeTranslatorConfig(nextPatch, this.translatorConfig);
    if (next.mode === 'local_mt' && !next.baseUrl) {
      throw new Error('本地翻译模式需要填写本地模型端点 URL（如 http://127.0.0.1:11434/v1）。');
    }

    this.translatorConfig = next;
    this.savePersistedTranslatorConfig(next);
    this.invalidateEngineeringStatusCache();
    const state = this.getTranslatorConfigState();

    let ollamaSync: OllamaSyncResult;
    if (state.effective.mode === 'local_mt' && (this.ollamaSyncer || this.sessionMode === 'persist')) {
      ollamaSync = await this.runOllamaSyncManaged({
        baseUrl: state.effective.baseUrl,
        concurrency: state.effective.concurrency,
        ollamaPath: state.effective.ollamaPath,
        forceRestart: true,
      });
    } else {
      ollamaSync = {
        attempted: false,
        synced: false,
        status: 'skipped',
        concurrency: state.effective.concurrency,
        reason: state.effective.mode !== 'local_mt' ? 'cloud_mode' : 'memory_mode',
        message: '',
      };
    }

    this.emitEvent('translator_config_updated', state);
    this.emitEvent('token_usage', this.getSessionTokenUsage());
    return {
      ...state,
      ollamaSync,
    };
  }

  async probeLocalTranslator(
    baseUrl: string,
    apiKey?: string,
    options?: { ollamaPath?: string; autoStartOllama?: boolean; concurrency?: number }
  ): Promise<TranslatorProbeResult> {
    const effective = this.getEffectiveTranslatorConfig();
    const effectiveKey =
      typeof apiKey === 'string'
        ? apiKey.trim() || this.translatorConfig.apiKey
        : this.translatorConfig.apiKey;
    try {
      const probeRes = await probeLocalTranslatorEndpoint(baseUrl, {
        apiKey: effectiveKey,
        fetchImpl: this.localTranslatorFetch,
      });
      return {
        ...probeRes,
        suggestedModel: pickPreferredLocalModel(probeRes.models),
        ollamaAutoStarted: false,
        ...(this.lastOllamaRuntime?.origin &&
        (() => {
          try {
            return new URL(baseUrl).origin === this.lastOllamaRuntime?.origin;
          } catch {
            return false;
          }
        })()
          ? {
              ...(this.lastOllamaRuntime.version ? { ollamaVersion: this.lastOllamaRuntime.version } : {}),
              ollamaManaged: this.lastOllamaRuntime.managedByPaperCup,
            }
          : {}),
      };
    } catch (err) {
      if (
        err instanceof LocalTranslatorEndpointError &&
        options?.autoStartOllama !== false &&
        isLocalOllamaCandidate(baseUrl) &&
        (this.ollamaSyncer || this.sessionMode === 'persist')
      ) {
        const concurrency =
          typeof options?.concurrency === 'number' && Number.isFinite(options.concurrency)
            ? Math.max(1, Math.min(8, Math.round(options.concurrency)))
            : effective.concurrency;
        const syncRes = await this.runOllamaSyncManaged({
          baseUrl,
          concurrency,
          ollamaPath: options?.ollamaPath !== undefined ? options.ollamaPath : effective.ollamaPath,
          forceRestart: false,
        });
        if (!syncRes.synced) {
          throw new LocalTranslatorEndpointError(syncRes.message || '自动启动本机 Ollama 失败。');
        }
        const retryRes = await probeLocalTranslatorEndpoint(baseUrl, {
          apiKey: effectiveKey,
          fetchImpl: this.localTranslatorFetch,
        });
        return {
          ...retryRes,
          suggestedModel: pickPreferredLocalModel(retryRes.models),
          ollamaAutoStarted: syncRes.status === 'started',
          ...(syncRes.version ? { ollamaVersion: syncRes.version } : {}),
          ollamaManaged: Boolean(syncRes.managedByPaperCup),
          ...(syncRes.syncSeq !== undefined ? { ollamaSyncSeq: syncRes.syncSeq } : {}),
        };
      }
      throw err;
    }
  }

  private installSessionRedaction(manager: SessionManager): void {
    if (this.wrappedSessionManagers.has(manager)) {
      return;
    }
    this.wrappedSessionManagers.add(manager);
    const origAppend = manager.appendMessage.bind(manager);
    manager.appendMessage = ((message: any) => {
      const sanitized = redactUnknownValue(message, this.getAllKnownSecrets());
      const entryId = origAppend(sanitized);
      if (
        this.sessionManager === manager &&
        (sanitized?.role === 'assistant' || (sanitized?.role === 'toolResult' && sanitized?.usage))
      ) {
        this.emitEvent('token_usage', this.getSessionTokenUsage());
      }
      return entryId;
    }) as typeof manager.appendMessage;
  }

  private rememberDeliveredUserMode(
    sessionId: string | null,
    timestamp: unknown,
    text: string,
    mode: QueuedMessageMode,
    options?: { persist?: boolean }
  ): void {
    if (!sessionId || !text.trim()) return;
    const tsPart = typeof timestamp === 'number' && Number.isFinite(timestamp) ? String(timestamp) : '0';
    const key = `${sessionId}:${tsPart}:${text}`;
    const alreadyRecorded = this.deliveredUserModes.get(key) === mode;
    this.deliveredUserModes.set(key, mode);
    if (this.deliveredUserModes.size > 400) {
      const firstKey = this.deliveredUserModes.keys().next().value;
      if (firstKey !== undefined) {
        this.deliveredUserModes.delete(firstKey);
      }
    }
    if (
      options?.persist !== false &&
      !alreadyRecorded &&
      this.sessionManager &&
      this.sessionManager.getSessionId?.() === sessionId
    ) {
      try {
        const safeText = redactSecrets(text, this.getAllKnownSecrets());
        this.sessionManager.appendCustomEntry?.(DELIVERY_MODE_CUSTOM_TYPE, {
          timestamp: tsPart,
          text: safeText,
          mode,
        });
      } catch {
        // Non-fatal: in-memory lookup still works if custom entry persistence fails
      }
    }
  }

  private collectPersistedDeliveryModes(
    sessionEntries?: readonly any[]
  ): Map<string, QueuedMessageMode> {
    const out = new Map<string, QueuedMessageMode>();
    if (!Array.isArray(sessionEntries)) return out;
    for (const entry of sessionEntries) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        entry.type !== 'custom' ||
        entry.customType !== DELIVERY_MODE_CUSTOM_TYPE
      ) {
        continue;
      }
      const data = entry.data as { timestamp?: unknown; text?: unknown; mode?: unknown } | undefined;
      if (!data || (data.mode !== 'steer' && data.mode !== 'followUp')) continue;
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text.trim()) continue;
      const tsPart =
        typeof data.timestamp === 'number' && Number.isFinite(data.timestamp)
          ? String(data.timestamp)
          : typeof data.timestamp === 'string' && data.timestamp.trim()
            ? data.timestamp.trim()
            : '0';
      out.set(`${tsPart}:${text}`, data.mode);
    }
    return out;
  }

  private lookupDeliveredUserMode(
    sessionId: string | null | undefined,
    timestamp: unknown,
    text: string,
    persistedModes?: ReadonlyMap<string, QueuedMessageMode>
  ): QueuedMessageMode | undefined {
    if (!text.trim()) return undefined;
    const tsPart = typeof timestamp === 'number' && Number.isFinite(timestamp) ? String(timestamp) : '0';
    if (sessionId) {
      const mem = this.deliveredUserModes.get(`${sessionId}:${tsPart}:${text}`);
      if (mem) return mem;
    }
    if (persistedModes) {
      return persistedModes.get(`${tsPart}:${text}`) ?? persistedModes.get(`0:${text}`);
    }
    return undefined;
  }

  private projectMessages(
    branchOrMessages: readonly any[],
    options?: {
      markUnresolvedToolsInterrupted?: boolean;
      sessionId?: string | null;
      sessionEntries?: readonly any[];
      fromBranchEntries?: boolean;
    }
  ): PersistedChatMessage[] {
    const markInterrupted = options?.markUnresolvedToolsInterrupted ?? true;
    const sessionId = options?.sessionId ?? null;
    const fromBranch = options?.fromBranchEntries === true;
    const persistedModes = this.collectPersistedDeliveryModes(
      options?.sessionEntries ?? (fromBranch ? branchOrMessages : undefined)
    );
    const omittedEntryIds = new Set<string>();
    if (fromBranch) {
      const latestEditByTarget = new Map<string, any>();
      for (const entry of branchOrMessages) {
        if (entry && typeof entry === 'object' && entry.type === 'context_edit' && typeof entry.targetId === 'string') {
          latestEditByTarget.set(entry.targetId, entry);
        }
      }
      for (const [targetId, editEntry] of latestEditByTarget) {
        if (editEntry.replacement === null) {
          omittedEntryIds.add(targetId);
        }
      }
    }
    const projected: PersistedChatMessage[] = [];
    let activeAssistant: PersistedChatMessage | null = null;
    const toolByCallId = new Map<string, PersistedToolCall>();
    let seq = 0;

    const flushAssistant = (isFinalSegment: boolean) => {
      if (!activeAssistant) return;
      if (!activeAssistant.content && !activeAssistant.thinking && !(activeAssistant.tools && activeAssistant.tools.length)) {
        activeAssistant = null;
        toolByCallId.clear();
        return;
      }
      let hadInterruptedTool = false;
      if (markInterrupted && activeAssistant.tools && activeAssistant.tools.length > 0) {
        for (const call of activeAssistant.tools) {
          if (call.result === undefined || call.result === null) {
            hadInterruptedTool = true;
            call.isError = true;
            call.result = {
              content: [{ type: 'text', text: '任务已中断（服务重启或意外中止，未收到工具返回）。' }],
              details: { status: 'interrupted' },
              isError: true,
            };
          }
        }
      }
      if (!activeAssistant.content && !activeAssistant.error) {
        if (hadInterruptedTool) {
          activeAssistant.error = true;
          activeAssistant.content = '任务已中断（服务重启或未收到工具返回）。';
        } else if (isFinalSegment) {
          activeAssistant.content = '已完成任务。';
        }
      }
      projected.push(activeAssistant);
      activeAssistant = null;
      toolByCallId.clear();
    };

    for (const item of branchOrMessages) {
      if (!item || typeof item !== 'object') continue;
      if (fromBranch) {
        if (item.type === 'compaction') {
          flushAssistant(false);
          const info = extractCompactionSummaryInfo(item);
          projected.push({
            id: info.id,
            role: 'compaction',
            content: info.summary,
            timestamp: this.formatTimestamp(info.timestamp) || info.timestamp,
            compaction: {
              reason: info.reason,
              tokensBefore: info.tokensBefore,
              tokensAfter: info.tokensAfter,
              ...(info.focus ? { focus: info.focus } : {}),
              ...(info.checkpointPath ? { checkpointPath: info.checkpointPath } : {}),
            },
          });
          continue;
        }
        if (item.type !== 'message') continue;
        if (typeof item.id === 'string' && omittedEntryIds.has(item.id)) continue;
      }
      const msg = fromBranch ? item.message : item;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'user') {
        flushAssistant(false);
        const text = this.extractText(msg.content);
        const images = extractImagesFromContent(msg.content);
        if (!text.trim() && images.length === 0) continue;
        const deliveryMode = this.lookupDeliveredUserMode(sessionId, msg.timestamp, text, persistedModes);
        projected.push({
          id: `hist-${++seq}`,
          role: 'user',
          content: text,
          ...(images.length > 0 ? { images } : {}),
          timestamp: this.formatTimestamp(msg.timestamp),
          ...(deliveryMode ? { deliveryMode } : {}),
        });
      } else if (msg.role === 'assistant') {
        if (!activeAssistant) {
          activeAssistant = {
            id: `hist-${++seq}`,
            role: 'assistant',
            content: '',
            timestamp: this.formatTimestamp(msg.timestamp),
          };
        } else if (msg.timestamp) {
          activeAssistant.timestamp = this.formatTimestamp(msg.timestamp);
        }
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            activeAssistant.thinking = activeAssistant.thinking
              ? `${activeAssistant.thinking}\n${block.thinking}`
              : block.thinking;
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            activeAssistant.content += block.text;
          } else if (block.type === 'toolCall' && typeof block.name === 'string') {
            const subRole =
              block.name === 'delegate_task' && typeof block.arguments?.role === 'string'
                ? block.arguments.role
                : block.name === 'vn_translate_batches'
                  ? 'translator'
                  : block.name === 'vn_post_qa_parallel'
                    ? 'role-checker'
                    : undefined;
            const call: PersistedToolCall = {
              ...(typeof block.id === 'string' && block.id ? { callId: block.id } : {}),
              tool: block.name,
              ...(block.arguments !== undefined ? { args: block.arguments } : {}),
              ...(subRole ? { subagentRole: subRole } : {}),
            };
            if (!activeAssistant.tools) activeAssistant.tools = [];
            activeAssistant.tools.push(call);
            if (typeof block.id === 'string' && block.id) {
              toolByCallId.set(block.id, call);
            }
          }
        }
        if (msg.stopReason === 'error') {
          activeAssistant.error = true;
          const errText = msg.errorMessage || '模型请求返回错误。';
          if (!activeAssistant.content.includes(errText)) {
            activeAssistant.content = activeAssistant.content
              ? `${activeAssistant.content}\n\n执行出错: ${errText}`
              : `执行出错: ${errText}`;
          }
        } else if (msg.stopReason === 'aborted') {
          activeAssistant.content = activeAssistant.content
            ? `${activeAssistant.content}\n\n*(已手动中止)*`
            : '已中止任务。';
        }
      } else if (msg.role === 'toolResult') {
        if (!activeAssistant) continue;
        const call =
          (typeof msg.toolCallId === 'string' ? toolByCallId.get(msg.toolCallId) : undefined) ??
          activeAssistant.tools?.find((t) => t.tool === msg.toolName && t.result === undefined);
        if (call) {
          const { content, details } = truncateToolResultForHistory(msg.content, msg.details);
          call.result = {
            content,
            details,
          };
          call.isError = msg.isError === true;
          if (typeof msg.details?.taskId === 'string' && msg.details.taskId) {
            call.subagentTaskId = msg.details.taskId;
          }
          if (Array.isArray(msg.details?.subagentTaskIds) && msg.details.subagentTaskIds.length > 0) {
            const taskIds = msg.details.subagentTaskIds.map(String);
            call.subagentTaskIds = taskIds;
            if (!call.subagentTaskId) {
              call.subagentTaskId = taskIds[taskIds.length - 1];
            }
          }
          if (typeof msg.details?.role === 'string' && msg.details.role) {
            call.subagentRole = msg.details.role;
          }
        }
      }
    }
    flushAssistant(true);
    return projected;
  }

  private formatSessionTitle(rawTitle: string | undefined): string {
    const cleaned = (rawTitle ?? '').replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned === '(no messages)') {
      return '新对话';
    }
    return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
  }

  private summarizeSessionManager(manager: SessionManager, updatedAtMs?: number): SessionSummary {
    const header = manager.getHeader?.();
    const createdAt =
      typeof header?.timestamp === 'string' && header.timestamp
        ? header.timestamp
        : new Date().toISOString();
    const branchEntries = manager.getBranch?.();
    const rawMsgs = Array.isArray(branchEntries)
      ? branchEntries
          .filter((e: any) => e && e.type === 'message' && e.message)
          .map((e: any) => e.message)
      : (manager.buildSessionContext?.().messages ?? []);
    let firstUserText = '';
    let messageCount = 0;
    let lastTs = Date.parse(createdAt) || Date.now();
    for (const msg of rawMsgs) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'user' || msg.role === 'assistant') {
        messageCount++;
        if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) {
          lastTs = Math.max(lastTs, msg.timestamp);
        }
        if (!firstUserText && msg.role === 'user') {
          firstUserText = summarizeUserMessagePreview(msg.content, this.extractText(msg.content));
        }
      }
    }
    const resolvedUpdatedMs = updatedAtMs ?? lastTs;
    return {
      id: manager.getSessionId(),
      title: this.formatSessionTitle(manager.getSessionName?.() || firstUserText),
      createdAt,
      updatedAt: new Date(resolvedUpdatedMs).toISOString(),
      messageCount,
    };
  }

  private sessionHeaderCwdMatches(headerCwd: unknown, workspacePath: string): boolean {
    if (typeof headerCwd !== 'string' || !headerCwd.trim()) {
      return true;
    }
    const targetKey = this.workspaceKey(workspacePath);
    if (this.workspaceKey(headerCwd) === targetKey) {
      return true;
    }
    try {
      const targetReal = realpathSafe(workspacePath);
      const headerReal = realpathSafe(headerCwd);
      return process.platform === 'win32'
        ? targetReal.toLowerCase() === headerReal.toLowerCase()
        : targetReal === headerReal;
    } catch {
      return false;
    }
  }

  private async readSessionFileMetaCached(
    filePath: string,
    workspacePath: string,
    stats: fs.Stats
  ): Promise<CachedSessionFileMeta | null> {
    const cacheKey = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    const cached = this.sessionFileMetaCache.get(cacheKey);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached;
    }

    let header: any = null;
    let messageCount = 0;
    let firstMessage = '';
    let name: string | undefined;
    let lastActivityTime: number | undefined;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        if (!header) {
          if (entry.type !== 'session') {
            return null;
          }
          header = entry;
          continue;
        }
        if (entry.type === 'session_info') {
          name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
          continue;
        }
        if (entry.type !== 'message') continue;
        const msg = entry.message;
        if (!msg || typeof msg !== 'object') continue;
        if (msg.role === 'user' || msg.role === 'assistant') {
          messageCount++;
        }
        const msgTs =
          typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
            ? msg.timestamp
            : typeof entry.timestamp === 'string'
              ? Date.parse(entry.timestamp)
              : NaN;
        if (Number.isFinite(msgTs)) {
          lastActivityTime = Math.max(lastActivityTime ?? 0, msgTs);
        }
        if ((msg.role === 'user' || msg.role === 'assistant') && !firstMessage && msg.role === 'user') {
          const preview = summarizeUserMessagePreview(msg.content, this.extractText(msg.content));
          if (preview) {
            firstMessage = preview;
          }
        }
      }
    } catch {
      return null;
    } finally {
      rl.close();
    }

    if (!header || typeof header.id !== 'string' || !header.id) {
      return null;
    }

    const headerTsMs = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : NaN;
    const createdMs = Number.isFinite(headerTsMs) ? headerTsMs : stats.mtimeMs;
    const modifiedMs =
      typeof lastActivityTime === 'number' && lastActivityTime > 0 ? lastActivityTime : createdMs;

    const meta: CachedSessionFileMeta = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      filePath,
      cwdMatches: this.sessionHeaderCwdMatches(header.cwd, workspacePath),
      modifiedMs,
      summary: {
        id: header.id,
        title: this.formatSessionTitle(name || firstMessage),
        createdAt: new Date(createdMs).toISOString(),
        updatedAt: new Date(modifiedMs).toISOString(),
        messageCount,
      },
    };
    this.sessionFileMetaCache.set(cacheKey, meta);
    return meta;
  }

  private sessionManagerHasMessages(manager: SessionManager | null | undefined): boolean {
    const branchEntries = manager?.getBranch?.();
    const rawMsgs = Array.isArray(branchEntries)
      ? branchEntries
          .filter((e: any) => e && e.type === 'message' && e.message)
          .map((e: any) => e.message)
      : (manager?.buildSessionContext?.().messages ?? []);
    return rawMsgs.some(
      (msg: any) => msg && typeof msg === 'object' && (msg.role === 'user' || msg.role === 'assistant')
    );
  }

  private commitMemorySessionRecord(): void {
    if (this.sessionMode !== 'memory' || !this.sessionManager) return;
    const id = this.sessionManager.getSessionId();
    const map = this.getWorkspaceMemoryMap();
    const existing = map.get(id);
    if (existing) {
      existing.updatedAtMs = Date.now();
      existing.seq = ++this.memorySeq;
      return;
    }
    map.set(id, {
      manager: this.sessionManager,
      updatedAtMs: Date.now(),
      seq: ++this.memorySeq,
    });
  }

  private async findLatestArchivedSessionFile(
    workspacePath: string,
    sessionDir: string
  ): Promise<string | null> {
    if (!fs.existsSync(sessionDir)) return null;
    let files: string[] = [];
    try {
      files = fs.readdirSync(sessionDir).filter((file) => file.endsWith('.jsonl'));
    } catch {
      return null;
    }
    const candidates: Array<{ filePath: string; stats: fs.Stats }> = [];
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          candidates.push({ filePath, stats });
        }
      } catch {
        // Ignore stat error on transient files
      }
    }
    candidates.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
    for (const candidate of candidates) {
      const meta = await this.readSessionFileMetaCached(
        candidate.filePath,
        workspacePath,
        candidate.stats
      );
      if (meta && meta.cwdMatches && meta.summary.messageCount > 0) {
        return candidate.filePath;
      }
    }
    return null;
  }

  async listSessionsForWorkspace(workspacePath: string): Promise<SessionSummary[]> {
    if (this.sessionMode === 'memory') {
      const map = this.getWorkspaceMemoryMap(workspacePath);
      return Array.from(map.values())
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.seq - a.seq)
        .map((rec) => this.summarizeSessionManager(rec.manager, rec.updatedAtMs))
        .filter((s) => s.messageCount > 0);
    }

    const sessionDir = this.resolveSessionDir(workspacePath);
    if (!fs.existsSync(sessionDir)) {
      return [];
    }

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(sessionDir).filter((file) => file.endsWith('.jsonl'));
    } catch {
      return [];
    }

    const dirPrefix = `${process.platform === 'win32' ? sessionDir.toLowerCase() : sessionDir}${path.sep}`;
    const activeFiles = new Set<string>();
    const metas: CachedSessionFileMeta[] = [];

    const tasks = entries.map(async (file) => {
      const filePath = path.join(sessionDir, file);
      const cacheKey = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
      activeFiles.add(cacheKey);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(filePath);
        if (!stats.isFile()) return;
      } catch {
        return;
      }
      const meta = await this.readSessionFileMetaCached(filePath, workspacePath, stats);
      if (meta && meta.cwdMatches && meta.summary.messageCount > 0) {
        metas.push(meta);
      }
    });
    await Promise.all(tasks);

    for (const key of Array.from(this.sessionFileMetaCache.keys())) {
      if (key.startsWith(dirPrefix) && !activeFiles.has(key)) {
        this.sessionFileMetaCache.delete(key);
      }
    }

    metas.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return metas.map((m) => ({ ...m.summary }));
  }

  async listWorkspaceSessions(): Promise<SessionSummary[]> {
    const summaries = await this.listSessionsForWorkspace(this.activeWorkspace);
    const activeId = this.sessionManager?.getSessionId?.();
    if (activeId && this.sessionManager && !summaries.some((s) => s.id === activeId)) {
      const activeSummary = this.summarizeSessionManager(this.sessionManager);
      if (activeSummary.messageCount > 0) {
        summaries.unshift(activeSummary);
      }
    }
    return summaries;
  }

  listSubagentTasks(sessionId?: string | null, limit?: number): SubagentTaskSummary[] {
    return this.subagentManager.listTasks(
      this.activeWorkspace,
      sessionId,
      limit ? { limit } : undefined
    );
  }

  getSubagentTask(taskId: string): SubagentTaskSnapshot | null {
    return this.subagentManager.getTask(this.activeWorkspace, taskId);
  }

  getMainQueueState(): PendingQueueState {
    if (!this.isRunningTurn) {
      return { steering: [], followUp: [] };
    }
    return this.mainQueueController.getState();
  }

  getTurnSyncState(): TurnSyncState {
    const sessionId = this.sessionManager?.getSessionId?.() ?? null;
    const activeTurn =
      this.isRunningTurn && this.activeTurnSnapshot
        ? {
            ...this.activeTurnSnapshot,
            tools: this.activeTurnSnapshot.tools.map((t) => ({ ...t })),
          }
        : null;
    return {
      isRunning: this.isRunningTurn,
      isCompacting: this.isCompacting,
      queuedCompaction: this.queuedMainCompaction ? { ...this.queuedMainCompaction } : null,
      sessionId,
      activeTurn,
      pendingQueue: this.getMainQueueState(),
      activeDirectSubagentTaskId: this.activeDirectSubagentTaskId,
      subagentTasks: this.listSubagentTasks(sessionId, SUBAGENT_TASKS_HISTORY_LIMIT),
      tokenUsage: this.getSessionTokenUsage(),
      chatForms: listChatForms(this.activeWorkspace),
    };
  }

  getSessionTokenUsage(): SessionTokenUsageSnapshot {
    const sessionId = this.sessionManager?.getSessionId?.() ?? null;
    const entries: any[] = this.sessionManager?.getEntries?.() ?? [];

    const total = createEmptyTokenBucket();
    const cloud = createEmptyTokenBucket();
    const local = createEmptyTokenBucket();
    const breakdown = {
      main: createEmptyTokenBucket(),
      cloudTranslator: createEmptyTokenBucket(),
      cloudEscalation: createEmptyTokenBucket(),
      roleChecker: createEmptyTokenBucket(),
      reverser: createEmptyTokenBucket(),
      smokeVision: createEmptyTokenBucket(),
      otherSubagents: createEmptyTokenBucket(),
      compaction: createEmptyTokenBucket(),
      localMt: createEmptyTokenBucket(),
    };
    const currentCloud = createEmptyTokenBucket();
    const currentLocal = createEmptyTokenBucket();
    let cloudCostUsd = 0;

    const recordCloud = (targetBucket: TokenUsageBucket, rawUsage: any, isCurrentTurn: boolean) => {
      addUsageToBucket(targetBucket, rawUsage);
      addUsageToBucket(cloud, rawUsage);
      addUsageToBucket(total, rawUsage);
      if (isCurrentTurn) {
        addUsageToBucket(currentCloud, rawUsage);
      }
      cloudCostUsd += toSafeNonNegNumber(rawUsage?.cost?.total);
    };

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') continue;
      const isCurrentTurn = i >= this.turnUsageStartEntryIndex;

      if (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.usage) {
        recordCloud(breakdown.main, entry.message.usage, isCurrentTurn);
      } else if (entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.usage) {
        recordCloud(breakdown.otherSubagents, entry.message.usage, isCurrentTurn);
      } else if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
        recordCloud(breakdown.compaction, entry.usage, isCurrentTurn);
      } else if (entry.type === 'usage' && entry.usage) {
        const kind = String(entry.kind || '');
        const isEstimated = entry.note === 'estimated';
        if (kind.startsWith('local_mt:')) {
          addUsageToBucket(breakdown.localMt, entry.usage, { estimated: isEstimated });
          addUsageToBucket(local, entry.usage, { estimated: isEstimated });
          addUsageToBucket(total, entry.usage, { estimated: isEstimated });
          if (isCurrentTurn) {
            addUsageToBucket(currentLocal, entry.usage, { estimated: isEstimated });
          }
        } else {
          const target =
            kind === 'subagent:translator'
              ? breakdown.cloudTranslator
              : kind === 'subagent:cloud_escalation'
                ? breakdown.cloudEscalation
                : kind === 'subagent:role-checker'
                  ? breakdown.roleChecker
                  : kind === 'subagent:reverser'
                    ? breakdown.reverser
                    : kind === 'cloud:smoke-vision'
                      ? breakdown.smokeVision
                      : kind === 'compaction'
                        ? breakdown.compaction
                        : breakdown.otherSubagents;
          recordCloud(target, entry.usage, isCurrentTurn);
        }
      }
    }

    let live = false;
    if (this.isRunningTurn && this.inFlightMainStreamText.length > 0) {
      const activeKey =
        this.activeTurnSnapshot?.model ||
        (this.currentSession?.model
          ? `${this.currentSession.model.provider}/${this.currentSession.model.id}`
          : '');
      const estOut = estimateTextTokens(this.inFlightMainStreamText, detectModelFamily(activeKey));
      if (estOut > 0) {
        const deltaUsage = { input: 0, output: estOut, cacheRead: 0, cacheWrite: 0, totalTokens: estOut };
        const opts = { estimated: true, countCall: false };
        addUsageToBucket(breakdown.main, deltaUsage, opts);
        addUsageToBucket(cloud, deltaUsage, opts);
        addUsageToBucket(total, deltaUsage, opts);
        addUsageToBucket(currentCloud, deltaUsage, opts);
        live = true;
      }
    }

    let contextUsage: SessionTokenUsageSnapshot['contextUsage'] = null;
    try {
      const rawCtx = this.currentSession?.getContextUsage?.();
      if (rawCtx && typeof rawCtx.contextWindow === 'number' && rawCtx.contextWindow > 0) {
        const compactionCfg = readPaperCupCompactionConfig();
        let tokens: number | null = typeof rawCtx.tokens === 'number' ? rawCtx.tokens : null;
        let percent: number | null = typeof rawCtx.percent === 'number' ? rawCtx.percent : null;
        if (tokens !== null && this.sessionManager) {
          const branch = this.sessionManager.getBranch();
          if (hasPostUsageContextEdit(branch)) {
            const realTokens = estimateRealProjectedContextTokens(
              this.sessionManager.buildSessionProjection(),
              branch
            );
            tokens = realTokens;
            percent = (realTokens / rawCtx.contextWindow) * 100;
          }
        }
        contextUsage = {
          tokens,
          contextWindow: rawCtx.contextWindow,
          percent,
          ...(compactionCfg.enabled
            ? {
                triggerTokens: computeCompactionThresholds(rawCtx.contextWindow, 'main', compactionCfg)
                  .triggerTokens,
              }
            : {}),
        };
      }
    } catch {
      // Ignore context probe errors while switching session/model
    }

    return {
      sessionId,
      total,
      cloud,
      local,
      breakdown,
      currentTurn: {
        cloud: currentCloud,
        local: currentLocal,
        totalTokens: currentCloud.totalTokens + currentLocal.totalTokens,
        live,
      },
      contextUsage,
      translatorMode: this.getEffectiveTranslatorConfig().mode,
      cloudCostUsd: Math.round(cloudCostUsd * 1e8) / 1e8,
      updatedAt: new Date().toISOString(),
    };
  }

  private recordSessionUsage(
    kind: string,
    provider: string,
    model: string,
    usage: Usage,
    options?: { sessionId?: string | null; note?: string }
  ): void {
    if (!this.sessionManager) return;
    if (options?.sessionId && this.sessionManager.getSessionId() !== options.sessionId) {
      return;
    }
    const safeNote = options?.note ? redactSecrets(options.note, this.getAllKnownSecrets()) : undefined;
    this.sessionManager.appendUsage(kind, provider, model, usage, safeNote);
    this.emitEvent('token_usage', this.getSessionTokenUsage());
  }

  async getSessionHistory(): Promise<SessionHistoryState> {
    await this.initSession();
    const sessionId = this.sessionManager?.getSessionId?.() ?? null;
    const branchEntries = this.sessionManager?.getBranch?.();
    const sessionEntries = this.sessionManager?.getEntries?.() ?? [];
    const projected = Array.isArray(branchEntries)
      ? this.projectMessages(branchEntries, {
          markUnresolvedToolsInterrupted: true,
          sessionId,
          sessionEntries,
          fromBranchEntries: true,
        })
      : this.projectMessages(this.sessionManager?.buildSessionContext?.().messages ?? [], {
          markUnresolvedToolsInterrupted: true,
          sessionId,
          sessionEntries,
        });
    const isActiveRunning = Boolean(
      this.isRunningTurn && this.activeTurnSnapshot && this.activeTurnSnapshot.sessionId === sessionId
    );
    const activeCommitted =
      this.activeTurnCommittedMessages.length > 0
        ? this.activeTurnCommittedMessages.map((m) => ({
            ...m,
            ...(Array.isArray(m.images) && m.images.length > 0
              ? { images: m.images.map((img) => ({ ...img })) }
              : {}),
            ...(Array.isArray(m.tools) ? { tools: m.tools.map((t) => ({ ...t })) } : {}),
            ...(m.compaction ? { compaction: { ...m.compaction } } : {}),
          }))
        : [
            {
              id: 'active-user',
              role: 'user' as const,
              content: this.activeTurnPrompt,
              ...(this.activeTurnImages.length > 0
                ? { images: this.activeTurnImages.map((img) => ({ ...img })) }
                : {}),
              timestamp: this.activeTurnStartedAtLabel,
            },
          ];
    const messages = isActiveRunning
      ? [...projected.slice(0, this.turnBaseMessageCount), ...activeCommitted]
      : projected;
    return {
      sessionId,
      persisted: this.sessionMode === 'persist',
      workspace: this.activeWorkspace,
      messages,
      sessions: await this.listWorkspaceSessions(),
      isRunning: this.isRunningTurn,
      isCompacting: this.isCompacting,
      queuedCompaction: this.queuedMainCompaction ? { ...this.queuedMainCompaction } : null,
      activeTurn: isActiveRunning
        ? {
            ...this.activeTurnSnapshot!,
            tools: this.activeTurnSnapshot!.tools.map((t) => ({ ...t })),
          }
        : null,
      pendingQueue: isActiveRunning ? this.getMainQueueState() : { steering: [], followUp: [] },
      activeDirectSubagentTaskId: this.activeDirectSubagentTaskId,
      subagentTasks: this.listSubagentTasks(sessionId, SUBAGENT_TASKS_HISTORY_LIMIT),
      tokenUsage: this.getSessionTokenUsage(),
      chatForms: listChatForms(this.activeWorkspace),
    };
  }

  getChatFormsState(): { forms: ChatFormRecord[]; roster: CharacterRosterStore | null } {
    return {
      forms: listChatForms(this.activeWorkspace),
      roster: readCharacterRoster(this.activeWorkspace),
    };
  }

  async submitCharacterForm(
    formId: string,
    payload: {
      items: CharacterConfirmationSubmissionItem[];
      dismissedNames?: string[];
      autoContinue?: boolean;
      model?: string;
    }
  ): Promise<{
    form: ChatFormRecord;
    roster: CharacterRosterStore;
    editedCount: number;
    glossaryEntriesAdded: number;
    startedTurn: boolean;
    userPrompt?: string;
  }> {
    const autoContinue = payload.autoContinue !== false;
    if (autoContinue && this.isBusy()) {
      throw new AppError('当前正在执行对话任务，无法在提交表单后立即唤醒 Agent。请等待当前任务完成或选择「仅保存译名」。', 409, 'CONFLICT');
    }

    const res = submitCharacterConfirmationForm(this.activeWorkspace, formId, {
      items: payload.items,
      dismissedNames: payload.dismissedNames,
    });

    this.invalidateEngineeringStatusCache();
    this.emitEvent('chat_form_updated', res.form);
    this.emitEvent('batch_progress', {
      type: 'plan',
      summary: `已锁定 ${res.roster.characters.length} 位角色译名`,
      timestamp: new Date().toISOString(),
    });

    let startedTurn = false;
    let userPrompt: string | undefined;
    if (autoContinue) {
      userPrompt = buildCharacterFormConfirmationMessage(res.form, res.editedItems);
      await this.startTurn(userPrompt, { model: payload.model });
      startedTurn = true;
    }

    return {
      form: res.form,
      roster: res.roster,
      editedCount: res.editedItems.length,
      glossaryEntriesAdded: res.glossaryEntriesAdded,
      startedTurn,
      ...(userPrompt ? { userPrompt } : {}),
    };
  }

  cancelWorkspaceChatForm(formId: string): ChatFormRecord {
    const updated = cancelChatForm(this.activeWorkspace, formId);
    this.invalidateEngineeringStatusCache();
    this.emitEvent('chat_form_updated', updated);
    return updated;
  }

  async createNewSession(): Promise<SessionHistoryState> {
    if (this.isBusy()) {
      throw new AppError('Cannot start a new session while a turn is in progress.', 409);
    }
    this.disposeCurrentSessionState(true);
    if (this.sessionMode === 'memory') {
      this.sessionManager = SessionManager.inMemory(this.activeWorkspace);
    } else {
      const sessionDir = this.resolveSessionDir(this.activeWorkspace);
      this.sessionManager = SessionManager.create(this.activeWorkspace, sessionDir);
    }
    await this.initSession();
    const state = await this.getSessionHistory();
    this.emitEvent('session_changed', state);
    this.emitEvent('session_reset', { workspace: this.activeWorkspace, sessionId: state.sessionId });
    return state;
  }

  async resetSession(): Promise<SessionHistoryState> {
    return this.createNewSession();
  }

  async selectSession(sessionId: string): Promise<SessionHistoryState> {
    if (this.isBusy()) {
      throw new AppError('Cannot switch session while a turn is in progress.', 409);
    }
    const targetId = sessionId.trim();
    if (!targetId) {
      throw new AppError('Session identifier cannot be empty.', 400);
    }
    if (this.sessionManager?.getSessionId?.() === targetId && this.currentSession) {
      return this.getSessionHistory();
    }

    if (this.sessionMode === 'memory') {
      const rec = this.getWorkspaceMemoryMap().get(targetId);
      if (!rec) {
        throw new AppError(`Session not found: ${targetId}`, 404, 'NOT_FOUND');
      }
      rec.updatedAtMs = Date.now();
      rec.seq = ++this.memorySeq;
      this.disposeCurrentSessionState(true);
      this.sessionManager = rec.manager;
    } else {
      const sessionDir = this.resolveSessionDir(this.activeWorkspace);
      const filePath = SessionManager.findById(this.activeWorkspace, targetId, sessionDir);
      if (!filePath) {
        throw new AppError(`Session not found: ${targetId}`, 404, 'NOT_FOUND');
      }
      this.bumpSessionFileMtime(filePath, sessionDir);
      this.disposeCurrentSessionState(true);
      this.sessionManager = SessionManager.open(filePath, sessionDir, this.activeWorkspace);
    }

    await this.initSession();
    const state = await this.getSessionHistory();
    this.emitEvent('session_changed', state);
    return state;
  }

  async deleteSession(sessionId: string): Promise<SessionHistoryState> {
    if (this.isBusy()) {
      throw new AppError('Cannot delete session while a turn is in progress.', 409);
    }
    const targetId = sessionId.trim();
    if (!targetId) {
      throw new AppError('Session identifier cannot be empty.', 400);
    }

    const isActive = this.sessionManager?.getSessionId?.() === targetId;

    if (this.sessionMode === 'memory') {
      const map = this.getWorkspaceMemoryMap();
      if (!map.has(targetId)) {
        throw new AppError(`Session not found: ${targetId}`, 404, 'NOT_FOUND');
      }
      map.delete(targetId);
      if (isActive) {
        this.disposeCurrentSessionState(true);
      }
    } else {
      const sessionDir = this.resolveSessionDir(this.activeWorkspace);
      const filePath = SessionManager.findById(this.activeWorkspace, targetId, sessionDir);
      if (!filePath) {
        throw new AppError(`Session not found: ${targetId}`, 404, 'NOT_FOUND');
      }
      const resolvedDir = path.resolve(sessionDir);
      const resolvedFile = path.resolve(filePath);
      const sameDir =
        process.platform === 'win32'
          ? path.dirname(resolvedFile).toLowerCase() === resolvedDir.toLowerCase()
          : path.dirname(resolvedFile) === resolvedDir;
      if (!sameDir || !resolvedFile.endsWith('.jsonl')) {
        throw new Error('Refusing to delete file outside workspace session directory.');
      }
      fs.unlinkSync(resolvedFile);
      this.sessionFileMetaCache.delete(
        process.platform === 'win32' ? resolvedFile.toLowerCase() : resolvedFile
      );
      if (isActive) {
        this.disposeCurrentSessionState(true);
      }
    }

    await this.initSession();
    const state = await this.getSessionHistory();
    this.emitEvent('session_changed', state);
    return state;
  }

  getWorkspace(): string {
    return this.activeWorkspace;
  }

  getWorkspaces(): WorkspaceRegistry {
    const reg = this.workspaceManager.getRegistry();
    const isSame =
      process.platform === 'win32'
        ? reg.active.toLowerCase() === this.activeWorkspace.toLowerCase()
        : reg.active === this.activeWorkspace;
    if (isSame) {
      return reg;
    }
    const recent = [
      this.activeWorkspace,
      ...reg.recent.filter((p) =>
        process.platform === 'win32'
          ? p.toLowerCase() !== this.activeWorkspace.toLowerCase()
          : p !== this.activeWorkspace
      ),
    ];
    return { active: this.activeWorkspace, recent };
  }

  async pickWorkspaceFolder(initialDir?: string): Promise<FolderPickResult> {
    if (this.isBusy()) {
      throw new AppError('Cannot pick workspace folder while a turn is in progress.', 409);
    }
    if (this.pickFolderInFlight) {
      return this.pickFolderInFlight;
    }
    const pending = this.folderPicker({
      initialDir: initialDir?.trim() || this.activeWorkspace,
    }).finally(() => {
      if (this.pickFolderInFlight === pending) {
        this.pickFolderInFlight = null;
      }
    });
    this.pickFolderInFlight = pending;
    return pending;
  }

  async listRegisteredWorkspaceSessions(
    workspacePath: string
  ): Promise<{ workspace: string; sessions: SessionSummary[] }> {
    const trimmed = workspacePath.trim();
    if (!trimmed) {
      throw new AppError('Workspace parameter cannot be empty.', 400);
    }
    const resolved = path.resolve(trimmed);
    const targetKey = this.workspaceKey(resolved);
    const reg = this.getWorkspaces();
    const matched = reg.recent.find((p) => this.workspaceKey(p) === targetKey);
    if (!matched) {
      throw new AppError(`Workspace is not registered: ${resolved}`, 404, 'NOT_FOUND');
    }
    const sessions =
      targetKey === this.workspaceKey(this.activeWorkspace)
        ? await this.listWorkspaceSessions()
        : await this.listSessionsForWorkspace(matched);
    return { workspace: matched, sessions };
  }

  async openWorkspaceSession(
    workspacePath: string,
    sessionId: string
  ): Promise<{ workspaces: WorkspaceRegistry; session: SessionHistoryState }> {
    if (this.isBusy()) {
      throw new AppError('Cannot switch workspace or session while a turn is in progress.', 409);
    }
    const trimmedWs = workspacePath.trim();
    const targetId = sessionId.trim();
    if (!trimmedWs) {
      throw new AppError('Workspace parameter cannot be empty.', 400);
    }
    if (!targetId) {
      throw new AppError('Session identifier cannot be empty.', 400);
    }

    const resolvedWs = path.resolve(trimmedWs);
    if (!fs.existsSync(resolvedWs) || !fs.statSync(resolvedWs).isDirectory()) {
      throw new AppError(`Directory does not exist: ${resolvedWs}`, 404, 'NOT_FOUND');
    }

    const targetKey = this.workspaceKey(resolvedWs);
    const sameWorkspace = targetKey === this.workspaceKey(this.activeWorkspace);
    if (sameWorkspace && this.sessionManager?.getSessionId?.() === targetId && this.currentSession) {
      return {
        workspaces: this.getWorkspaces(),
        session: await this.getSessionHistory(),
      };
    }

    let nextMemoryRecord: MemorySessionRecord | undefined;
    let nextPersistFile: string | undefined;
    let nextPersistDir = '';

    if (this.sessionMode === 'memory') {
      nextMemoryRecord = this.getWorkspaceMemoryMap(resolvedWs).get(targetId);
      if (!nextMemoryRecord) {
        throw new AppError(`Session not found: ${targetId}`, 404, 'NOT_FOUND');
      }
    } else {
      nextPersistDir = this.resolveSessionDir(resolvedWs);
      nextPersistFile = SessionManager.findById(resolvedWs, targetId, nextPersistDir);
      if (!nextPersistFile) {
        throw new AppError(`Session not found: ${targetId}`, 404, 'NOT_FOUND');
      }
    }

    if (!sameWorkspace) {
      const switched = this.workspaceManager.switchWorkspace(resolvedWs);
      this.activeWorkspace = switched;
      this.invalidateEngineeringStatusCache();
      this.disposeCurrentSessionState(true);
      this.emitEvent('workspace_changed', { workspace: this.activeWorkspace });
    } else {
      this.disposeCurrentSessionState(true);
    }

    if (this.sessionMode === 'memory' && nextMemoryRecord) {
      nextMemoryRecord.updatedAtMs = Date.now();
      nextMemoryRecord.seq = ++this.memorySeq;
      this.sessionManager = nextMemoryRecord.manager;
    } else if (nextPersistFile) {
      this.bumpSessionFileMtime(nextPersistFile, nextPersistDir);
      this.sessionManager = SessionManager.open(nextPersistFile, nextPersistDir, this.activeWorkspace);
    }

    await this.initSession();
    const state = await this.getSessionHistory();
    this.emitEvent('session_changed', state);
    return {
      workspaces: this.getWorkspaces(),
      session: state,
    };
  }

  setWorkspace(newPath: string): string {
    if (this.isBusy()) {
      throw new AppError('Cannot switch workspace while a turn is in progress.', 409);
    }
    const switched = this.workspaceManager.switchWorkspace(newPath);
    this.activeWorkspace = switched;
    this.invalidateEngineeringStatusCache();

    // 前のディレクトリバインディングを解放するため、以前の Pi セッションを適切に破棄
    this.disposeCurrentSessionState(true);

    this.emitEvent('workspace_changed', { workspace: this.activeWorkspace });
    return this.activeWorkspace;
  }

  removeWorkspace(targetPath: string): WorkspaceRegistry {
    if (this.isBusy()) {
      throw new AppError('Cannot remove workspace while a turn is in progress.', 409);
    }
    this.workspaceManager.removeWorkspace(targetPath);
    const reg = this.workspaceManager.getRegistry();
    if (this.workspaceKey(reg.active) !== this.workspaceKey(this.activeWorkspace)) {
      this.setWorkspace(reg.active);
    }
    return reg;
  }

  private readWorkspaceJson(relPath: string): any | null {
    const absPath = path.join(this.activeWorkspace, relPath);
    try {
      if (!fs.existsSync(absPath) || fs.lstatSync(absPath).isSymbolicLink()) {
        return null;
      }
      const raw = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getEngineeringStatus(options?: { forceRefresh?: boolean }): Promise<any> {
    const cacheKey = this.workspaceKey(this.activeWorkspace);
    if (!options?.forceRefresh) {
      const cached = this.engineeringStatusCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < ENGINEERING_STATUS_CACHE_TTL_MS) {
        return cached.value;
      }
    }

    let rawStatus = '';
    try {
      rawStatus = getVnStatus(this.activeWorkspace);
    } catch (err: any) {
      rawStatus = String(err?.message || err);
    }

    let detectedEngine = 'unknown';
    let engineId: string | null = null;
    let engineName: string | null = null;
    let engineKnown = false;
    try {
      const summary = detectVnEngineSummary(this.activeWorkspace);
      const detected = summary.text.trim();
      if (detected) {
        detectedEngine = detected;
      }
      engineId = summary.engineId;
      engineName = summary.engineName;
      engineKnown = summary.engineKnown;
    } catch {
      // Keep fallback 'unknown' when engine detection fails
    }

    const wsPaths = resolveWorkspacePaths(this.activeWorkspace);
    const hasUnpacked = fs.existsSync(wsPaths.unpackedDir);
    const hasBuild = fs.existsSync(wsPaths.buildDir);

    const planDoc = this.readWorkspaceJson(WORKSPACE_PLAN_REL);
    const planCfg = planDoc && typeof planDoc.config === 'object' ? planDoc.config : null;
    const planAnalysis = planDoc && typeof planDoc.analysis === 'object' ? planDoc.analysis : null;
    const plan = planCfg
      ? {
          model: String(planCfg.model || ''),
          modelFamily: String(planCfg.model_family || 'generic'),
          batchMaxLines: Number(planCfg.batch_max_lines || 0),
          batchMaxSourceTokens: Number(planCfg.batch_max_source_tokens || 0),
          sessionMaxSourceTokens: Number(planCfg.session_max_source_tokens || 0),
          concurrency: Number(planCfg.concurrency || 1),
          ...(planAnalysis ? { totalRows: Number(planAnalysis.total_rows || 0), estimatedSourceTokens: Number(planAnalysis.estimated_source_tokens || 0) } : {}),
        }
      : null;

    const batchManifest = this.readWorkspaceJson(WORKSPACE_BATCHES_MANIFEST_REL);
    const progressDoc = this.readWorkspaceJson(WORKSPACE_PROGRESS_REL);
    const progressSummary = progressDoc && typeof progressDoc.summary === 'object' ? progressDoc.summary : null;
    const manifestBatches: any[] = Array.isArray(batchManifest?.batches) ? batchManifest.batches : [];
    const totalBatches = progressSummary
      ? Number(progressSummary.total_batches ?? manifestBatches.length)
      : manifestBatches.length;
    const totalRows = progressSummary
      ? Number(progressSummary.total_rows ?? batchManifest?.total_rows ?? 0)
      : Number(batchManifest?.total_rows ?? 0);
    const savedPendingQa = progressSummary ? Number(progressSummary.saved_pending_qa || 0) : 0;
    const qaPassed = progressSummary ? Number(progressSummary.qa_passed || 0) : 0;
    const qaFailed = progressSummary ? Number(progressSummary.qa_failed || 0) : 0;
    const pendingBatches = progressSummary
      ? Number(progressSummary.pending_batches ?? Math.max(0, totalBatches - savedPendingQa - qaPassed - qaFailed))
      : totalBatches;
    const checkedInRows = progressSummary ? Number(progressSummary.checked_in_rows || 0) : 0;
    const rawRouteStats =
      progressSummary && typeof progressSummary.route_stats === 'object'
        ? (progressSummary.route_stats as Record<string, unknown>)
        : null;
    const routeStats = rawRouteStats
      ? {
          tmCache: Number(rawRouteStats.tm_cache || 0),
          localMt: Number(rawRouteStats.local_mt || 0),
          cloudEscalated: Number(rawRouteStats.cloud_escalated || 0),
          cloudSubagent: Number(rawRouteStats.cloud_subagent || 0),
        }
      : undefined;
    const batchProgress =
      totalBatches > 0
        ? {
            totalBatches,
            pendingBatches,
            savedPendingQa,
            qaPassed,
            qaFailed,
            totalRows,
            checkedInRows,
            ...(routeStats ? { routeStats } : {}),
          }
        : null;

    const cpDoc = this.readWorkspaceJson(WORKSPACE_CHECKPOINTS_REL);
    const cpList: any[] = Array.isArray(cpDoc?.checkpoints) ? cpDoc.checkpoints : [];
    const latestCp = cpList.length > 0 ? cpList[cpList.length - 1] : null;
    const checkpoints =
      cpList.length > 0
        ? {
            count: cpList.length,
            latest: latestCp
              ? {
                  commit: String(latestCp.commit || ''),
                  stage: String(latestCp.stage || ''),
                  qaVerified: Boolean(latestCp.qa_verified),
                  summary: String(latestCp.summary || ''),
                  timestamp: String(latestCp.timestamp || ''),
                }
              : null,
          }
        : null;

    const postQaDoc = this.readWorkspaceJson(WORKSPACE_POST_QA_REPORT_REL);
    const postQa = postQaDoc
      ? {
          ok: Boolean(postQaDoc.ok),
          deterministicPassed: Number(postQaDoc.deterministicPassed || 0),
          deterministicFailed: Number(postQaDoc.deterministicFailed || 0),
          affectedBatchIds: Array.isArray(postQaDoc.affectedBatchIds) ? postQaDoc.affectedBatchIds.map(String) : [],
          roleCheckerChunksReviewed: Number(postQaDoc.roleCheckerChunksReviewed || 0),
          ...(postQaDoc.roleCheckerChunksTotal !== undefined
            ? { roleCheckerChunksTotal: Number(postQaDoc.roleCheckerChunksTotal || 0) }
            : {}),
          ...(postQaDoc.roleCheckerPendingChunks !== undefined
            ? { roleCheckerPendingChunks: Number(postQaDoc.roleCheckerPendingChunks || 0) }
            : {}),
          ...(postQaDoc.roleCheckerErrors !== undefined
            ? { roleCheckerErrors: Number(postQaDoc.roleCheckerErrors || 0) }
            : {}),
          ...(postQaDoc.interrupted ? { interrupted: true } : {}),
          ...(typeof postQaDoc.interruptKind === 'string' && postQaDoc.interruptKind
            ? { interruptKind: postQaDoc.interruptKind }
            : {}),
        }
      : null;

    const wsTranslatorOverride = loadWorkspaceTranslatorOverride(this.activeWorkspace);
    const effectiveTranslator = mergeTranslatorConfig(this.translatorConfig, wsTranslatorOverride);
    let ollamaRuntime:
      | { running: boolean; version?: string; managedByPaperCup?: boolean }
      | null = null;
    if (effectiveTranslator.mode === 'local_mt') {
      let origin = '';
      let isLoopback = false;
      try {
        const parsed = new URL(effectiveTranslator.baseUrl);
        origin = parsed.origin;
        isLoopback = isLoopbackHostname(parsed.hostname);
      } catch {
        origin = '';
      }
      const isDefaultOllama = isLocalOllamaCandidate(effectiveTranslator.baseUrl);
      const isKnownCustomOllama = Boolean(
        origin && isLoopback && this.lastOllamaRuntime?.origin === origin && this.lastOllamaRuntime.running
      );
      if (isDefaultOllama || isKnownCustomOllama) {
        const now = Date.now();
        if (
          origin &&
          this.lastOllamaRuntime &&
          this.lastOllamaRuntime.origin === origin &&
          now - this.lastOllamaRuntime.checkedAt < ENGINEERING_STATUS_CACHE_TTL_MS
        ) {
          ollamaRuntime = {
            running: this.lastOllamaRuntime.running,
            ...(this.lastOllamaRuntime.version ? { version: this.lastOllamaRuntime.version } : {}),
            managedByPaperCup: this.lastOllamaRuntime.managedByPaperCup,
          };
        } else if (origin && (this.sessionMode === 'persist' || Boolean(this.localTranslatorFetch))) {
          try {
            const fetchFn = this.localTranslatorFetch ?? globalThis.fetch;
            const res = await fetchFn(`${origin}/api/version`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(400),
            });
            if (res.ok) {
              const payload: any = await res.json().catch(() => null);
              const ver =
                typeof payload?.version === 'string' && payload.version.trim() ? payload.version.trim() : undefined;
              const managed = Boolean(
                this.lastOllamaRuntime?.origin === origin && this.lastOllamaRuntime.managedByPaperCup
              );
              this.lastOllamaRuntime = {
                origin,
                running: true,
                ...(ver ? { version: ver } : {}),
                managedByPaperCup: managed,
                checkedAt: now,
              };
              ollamaRuntime = {
                running: true,
                ...(ver ? { version: ver } : {}),
                managedByPaperCup: managed,
              };
            } else {
              ollamaRuntime = { running: false, managedByPaperCup: false };
            }
          } catch {
            ollamaRuntime = { running: false, managedByPaperCup: false };
          }
        }
      }
    }

    const translator = {
      mode: effectiveTranslator.mode,
      model: effectiveTranslator.model,
      preset: effectiveTranslator.preset,
      baseUrl: effectiveTranslator.baseUrl,
      concurrency: effectiveTranslator.concurrency,
      escalateFailedRows: effectiveTranslator.escalateFailedRows,
      hasWorkspaceOverride: Boolean(wsTranslatorOverride),
      ...(ollamaRuntime
        ? {
            ollamaRunning: ollamaRuntime.running,
            ...(ollamaRuntime.version ? { ollamaVersion: ollamaRuntime.version } : {}),
            ollamaManaged: ollamaRuntime.managedByPaperCup,
          }
        : {}),
    };

    const statusDoc = {
      workspace: this.activeWorkspace,
      engine: detectedEngine,
      engineId,
      engineName,
      engineKnown,
      rawStatus,
      hasUnpacked,
      hasBuild,
      skills: this.listEngineSkills(),
      plan,
      batchProgress,
      checkpoints,
      postQa,
      translator,
    };
    this.engineeringStatusCache.set(cacheKey, {
      value: statusDoc,
      cachedAt: Date.now(),
    });
    return statusDoc;
  }

  private toModelOption(model: any): ModelOption {
    return {
      key: `${model.provider}/${model.id}`,
      provider: String(model.provider),
      id: String(model.id),
      name: String(model.name || model.id),
      reasoning: Boolean(model.reasoning),
      supportsImage: modelSupportsImageInput(model),
    };
  }

  private isSameModelRef(model: any, modelRef: string): boolean {
    if (!model) return false;
    const trimmed = modelRef.trim().toLowerCase();
    return (
      `${model.provider}/${model.id}`.toLowerCase() === trimmed ||
      String(model.id).toLowerCase() === trimmed
    );
  }

  private getCustomProviderBaseUrl(providerId: CustomOpenAIProviderId): string {
    const override = this.customProviderBaseUrls.get(providerId);
    if (override) return override;
    const spec = CUSTOM_OPENAI_PROVIDERS[providerId];
    const defaultBaseUrl = spec.resolveDefaultBaseUrl?.() ?? spec.baseUrl;
    const persisted = this.persistedAuth.providers[providerId]?.baseUrl;
    if (persisted && spec.supportsBaseUrl) {
      try {
        return spec.normalizeBaseUrl
          ? spec.normalizeBaseUrl(persisted, defaultBaseUrl)
          : persisted.replace(/\/+$/, '');
      } catch {
        // Fallback to default
      }
    }
    return defaultBaseUrl;
  }

  private isProviderKeyless(providerId: CustomOpenAIProviderId, resolvedApiKey?: string): boolean {
    const spec = CUSTOM_OPENAI_PROVIDERS[providerId];
    if (!spec?.apiKeyOptional) return false;
    if (this.runtimeApiKeys.has(providerId)) return false;
    if (this.keylessRuntimeProviders.has(providerId)) return true;
    const trimmed = String(resolvedApiKey ?? '').trim();
    if (!trimmed || trimmed === MAGPIE_KEYLESS_RUNTIME_TOKEN) {
      const envKey = spec.envVar ? process.env[spec.envVar]?.trim() : '';
      return !envKey;
    }
    return false;
  }

  private isProviderConfiguredInRuntime(runtime: any, providerId: string): boolean {
    if (this.clearedProviders.has(providerId)) {
      return false;
    }
    const authStatus = runtime?.getProviderAuthStatus?.(providerId);
    const hasAuthFallback = Boolean(runtime?.hasConfiguredAuth?.(providerId));
    return Boolean(
      authStatus?.configured ||
        hasAuthFallback ||
        this.runtimeApiKeys.has(providerId) ||
        this.keylessRuntimeProviders.has(providerId)
    );
  }

  private isUserCustomModel(providerId: string, modelId: string): boolean {
    if (!isCustomOpenAIProviderId(providerId)) return false;
    return Boolean(this.customProviderModels.get(providerId)?.has(modelId));
  }

  private getAvailableModels(runtime: any): any[] {
    const available: readonly any[] = runtime?.getAvailableSnapshot?.() ?? [];
    const filtered: any[] = [];
    const seenKeys = new Set<string>();

    for (const m of available) {
      const provider = String(m.provider);
      const id = String(m.id);
      if (this.clearedProviders.has(provider)) continue;
      const isCustom = this.isUserCustomModel(provider, id);
      if (!isCustom && !isSupportedLiveChatModel(provider, id)) continue;
      const allowlist = this.liveProviderModelAllowlist.get(provider);
      if (allowlist && !isCustom && !allowlist.has(id)) continue;
      const key = `${provider}/${id}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        filtered.push(m);
      }
    }

    for (const [provider, dynamicList] of this.liveDynamicProviderModels) {
      if (this.clearedProviders.has(provider)) continue;
      if (!this.isProviderConfiguredInRuntime(runtime, provider)) continue;
      const allowlist = this.liveProviderModelAllowlist.get(provider);
      for (const m of dynamicList) {
        const id = String(m.id);
        if (!isSupportedLiveChatModel(provider, id)) continue;
        if (allowlist && !allowlist.has(id)) continue;
        const key = `${provider}/${id}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          filtered.push(m);
        }
      }
    }

    return filtered;
  }

  private resolveModelFromRuntime(modelRef: string): any {
    const trimmed = modelRef.trim();
    if (!trimmed) {
      throw new Error('Model identifier cannot be empty.');
    }
    if (
      this.currentSession?.model &&
      !this.clearedProviders.has(String(this.currentSession.model.provider)) &&
      this.isSameModelRef(this.currentSession.model, trimmed)
    ) {
      return this.currentSession.model;
    }

    const runtime = this.currentSession?.modelRuntime;
    const available: readonly any[] = this.getAvailableModels(runtime);
    const lower = trimmed.toLowerCase();

    const exactKeyMatch = available.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
    if (exactKeyMatch) {
      return exactKeyMatch;
    }

    const bareMatches = available.filter((m) => String(m.id).toLowerCase() === lower);
    if (bareMatches.length === 1) {
      return bareMatches[0];
    }
    if (bareMatches.length > 1) {
      const candidates = bareMatches.map((m) => `${m.provider}/${m.id}`).join(', ');
      throw new Error(`Ambiguous model "${trimmed}"; specify provider/id (${candidates}).`);
    }

    const slashIndex = trimmed.indexOf('/');
    if (slashIndex > 0 && slashIndex < trimmed.length - 1 && runtime?.getModel) {
      const provider = trimmed.slice(0, slashIndex);
      if (!this.clearedProviders.has(provider)) {
        const modelId = trimmed.slice(slashIndex + 1);
        const allowlist = this.liveProviderModelAllowlist.get(provider);
        const isCustom = this.isUserCustomModel(provider, modelId);
        const exactRegistered = runtime.getModel(provider, modelId);
        if (
          exactRegistered &&
          (isCustom ||
            (isSupportedLiveChatModel(provider, modelId) &&
              (!allowlist || allowlist.has(modelId))))
        ) {
          return exactRegistered;
        }
      }
    }

    throw new Error(`Model not found or unavailable: ${trimmed}`);
  }

  private buildProvidersList(runtime: any, available: readonly any[]): ProviderStatusInfo[] {
    const runtimeProviders: readonly any[] = runtime?.getProviders?.() ?? [];
    const byId = new Map<string, any>(runtimeProviders.map((p) => [String(p.id), p]));
    const featuredIds = new Set(FEATURED_PROVIDERS.map((p) => p.id));

    const toStatus = (id: string, name: string, envVar?: string): ProviderStatusInfo => {
      const isCleared = this.clearedProviders.has(id);
      const authStatus = runtime?.getProviderAuthStatus?.(id);
      const hasAuthFallback = Boolean(runtime?.hasConfiguredAuth?.(id));
      const persistedRec = this.sessionMode === 'persist' ? this.persistedAuth.providers[id] : undefined;
      const hasSavedLocalKey = Boolean(persistedRec?.apiKey || persistedRec?.keyless);
      const hasRuntimeAuth = this.runtimeApiKeys.has(id) || this.keylessRuntimeProviders.has(id);
      const configured =
        !isCleared &&
        Boolean(authStatus?.configured || hasAuthFallback || hasRuntimeAuth);
      let source: ProviderAuthSource = null;
      if (configured) {
        if (hasSavedLocalKey && hasRuntimeAuth) {
          source = 'stored';
        } else if (authStatus?.source === 'runtime' || hasRuntimeAuth) {
          source = 'runtime';
        } else if (authStatus?.source === 'stored') {
          source = 'stored';
        } else {
          source = 'environment';
        }
      }
      const availableCount = available.filter((m) => m.provider === id).length;
      const supportedCatalogCount =
        runtime?.getModels?.(id)?.filter((m: any) => isSupportedLiveChatModel(id, String(m.id)))
          .length ?? 0;
      const modelCount = this.liveProviderModelAllowlist.has(id)
        ? availableCount
        : Math.max(availableCount, supportedCatalogCount);

      const customSpec = isCustomOpenAIProviderId(id) ? CUSTOM_OPENAI_PROVIDERS[id] : undefined;
      const supportsBaseUrl = Boolean(customSpec?.supportsBaseUrl);
      const apiKeyOptional = Boolean(customSpec?.apiKeyOptional);
      const baseUrl = supportsBaseUrl && customSpec ? this.getCustomProviderBaseUrl(customSpec.id) : undefined;
      const defaultBaseUrl =
        supportsBaseUrl && customSpec
          ? customSpec.resolveDefaultBaseUrl?.() ?? customSpec.baseUrl
          : undefined;
      const hasApiKey =
        apiKeyOptional && customSpec
          ? Boolean(
              this.runtimeApiKeys.has(id) ||
                persistedRec?.apiKey ||
                (customSpec.envVar && process.env[customSpec.envVar]?.trim())
            )
          : undefined;

      return {
        id,
        name,
        ...(envVar ? { envVar } : {}),
        configured,
        source,
        ...(hasSavedLocalKey ? { savedLocally: true } : {}),
        modelCount,
        ...(supportsBaseUrl ? { supportsBaseUrl: true, baseUrl, defaultBaseUrl } : {}),
        ...(apiKeyOptional ? { apiKeyOptional: true, hasApiKey } : {}),
      };
    };

    const providers: ProviderStatusInfo[] = [];
    for (const featured of FEATURED_PROVIDERS) {
      if (byId.has(featured.id) || runtimeProviders.length === 0) {
        providers.push(toStatus(featured.id, featured.name, featured.envVar));
      }
    }

    const others = runtimeProviders
      .filter((p) => !featuredIds.has(String(p.id)))
      .map((p) => toStatus(String(p.id), String(p.name || p.id)))
      .filter((p) => p.modelCount > 0 || p.configured || p.savedLocally)
      .sort((a, b) => a.name.localeCompare(b.name));

    return [...providers, ...others];
  }

  private resolveThinkingState(): {
    thinkingLevel: ThinkingLevel;
    availableThinkingLevels: ThinkingLevel[];
  } {
    const rawAvailable: readonly ThinkingLevel[] =
      typeof this.currentSession?.getAvailableThinkingLevels === 'function' && this.currentSession?.model
        ? this.currentSession.getAvailableThinkingLevels()
        : ['off', 'low', 'medium', 'high'];
    const filtered = rawAvailable.filter((lvl) => VALID_THINKING_LEVELS.includes(lvl));
    const currentLevel: ThinkingLevel =
      (this.currentSession?.thinkingLevel as ThinkingLevel) ||
      this.preferredThinkingLevel ||
      'low';
    const available = filtered.length > 0 ? Array.from(new Set(filtered)) : ['off', 'low', 'medium', 'high'];
    if (!available.includes(currentLevel)) {
      available.push(currentLevel);
    }
    return {
      thinkingLevel: currentLevel,
      availableThinkingLevels: available as ThinkingLevel[],
    };
  }

  async getModelsState(): Promise<ModelsState> {
    await this.initSession();
    const runtime = this.currentSession?.modelRuntime;
    const available = this.getAvailableModels(runtime);
    const byKey = new Map<string, ModelOption>();

    for (const model of available) {
      const opt = this.toModelOption(model);
      if (!byKey.has(opt.key)) {
        byKey.set(opt.key, opt);
      }
    }

    const active = this.currentSession?.model;
    const activeProvider = active ? String(active.provider) : '';
    const activeKey = active ? `${active.provider}/${active.id}` : null;
    const keepActive = Boolean(
      active &&
        activeKey &&
        !this.clearedProviders.has(activeProvider) &&
        (byKey.has(activeKey) || this.isProviderConfiguredInRuntime(runtime, activeProvider))
    );
    const current = keepActive ? activeKey : null;
    if (keepActive && active && activeKey && !byKey.has(activeKey)) {
      byKey.set(activeKey, this.toModelOption(active));
    }

    const thinking = this.resolveThinkingState();
    return {
      current,
      models: Array.from(byKey.values()),
      providers: this.buildProvidersList(runtime, available),
      ...thinking,
    };
  }

  async setThinkingLevel(level: string): Promise<ModelsState> {
    if (this.isBusy()) {
      throw new AppError('Cannot change thinking level while a turn is in progress.', 409);
    }
    const normalized = level.trim().toLowerCase() as ThinkingLevel;
    if (!VALID_THINKING_LEVELS.includes(normalized)) {
      throw new Error(`Invalid thinking level: ${level}`);
    }
    await this.initSession();
    if (typeof this.currentSession?.setThinkingLevel === 'function') {
      this.currentSession.setThinkingLevel(normalized);
    }
    const resolved = (this.currentSession?.thinkingLevel as ThinkingLevel) || normalized;
    this.preferredThinkingLevel = resolved;
    if (this.sessionMode === 'persist') {
      this.persistedAuth.preferredThinkingLevel = resolved;
      this.savePersistedAuth();
    }
    const nextState = await this.getModelsState();
    this.emitEvent('thinking_changed', { thinkingLevel: nextState.thinkingLevel });
    this.emitEvent('models_updated', nextState);
    return nextState;
  }

  private clearActiveSessionModel(emitEvent: boolean): void {
    if (this.currentSession?.agent?.state) {
      this.currentSession.agent.state.model = undefined;
    }
    this.preferredModelKey = null;
    if (emitEvent) {
      this.emitEvent('model_changed', { model: null });
    }
  }

  private pickDefaultProviderModel(models: readonly any[], preferredCustomModelId?: string): any {
    const isSpecializedPreview = (m: any) => {
      const id = String(m?.id || '').toLowerCase();
      return (
        id.includes('deep-research') ||
        id.includes('computer-use') ||
        id.includes('robotics')
      );
    };
    const customMatch = preferredCustomModelId
      ? models.find((m) => m.id === preferredCustomModelId)
      : undefined;
    return (
      customMatch ??
      models.find((m) => !isSpecializedPreview(m) && String(m.id).toLowerCase().includes('flash')) ??
      models.find((m) => !isSpecializedPreview(m)) ??
      models[0]
    );
  }

  private registerCustomProviderModel(providerId: CustomOpenAIProviderId, modelId: string): string {
    const spec = CUSTOM_OPENAI_PROVIDERS[providerId];
    const escapedPrefix = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cleanId = modelId.trim().replace(new RegExp(`^${escapedPrefix}/`, 'i'), '').trim();
    if (!cleanId) {
      return '';
    }
    const effectiveBaseUrl = this.getCustomProviderBaseUrl(providerId);
    const baseModels = this.liveCustomProviderModels.get(providerId) ?? DEFAULT_CUSTOM_PROVIDER_MODELS[providerId];
    let customMap = this.customProviderModels.get(providerId);
    if (!customMap) {
      customMap = new Map<string, any>();
      this.customProviderModels.set(providerId, customMap);
    }
    if (!baseModels.some((m) => m.id === cleanId)) {
      const existing = customMap.get(cleanId);
      if (!existing || existing.baseUrl !== effectiveBaseUrl) {
        customMap.set(
          cleanId,
          buildCustomOpenAIModelDefinition(spec, cleanId, undefined, undefined, effectiveBaseUrl)
        );
      }
    }
    return cleanId;
  }

  private applyDiscoveredLiveModels(
    runtime: any,
    providerId: string,
    liveModels: readonly DiscoveredLiveModel[] | null,
    rawModelCount: number
  ): void {
    if (!liveModels) {
      this.liveProviderModelAllowlist.delete(providerId);
      this.liveDynamicProviderModels.delete(providerId);
      return;
    }

    if (liveModels.length === 0 && rawModelCount === 0) {
      this.liveProviderModelAllowlist.delete(providerId);
      this.liveDynamicProviderModels.delete(providerId);
      if (isCustomOpenAIProviderId(providerId)) {
        this.liveCustomProviderModels.delete(providerId);
      }
      return;
    }

    this.liveProviderModelAllowlist.set(
      providerId,
      new Set(liveModels.map((m) => m.id))
    );

    if (isCustomOpenAIProviderId(providerId)) {
      const spec = CUSTOM_OPENAI_PROVIDERS[providerId];
      const effectiveBaseUrl = this.getCustomProviderBaseUrl(providerId);
      const defaults = DEFAULT_CUSTOM_PROVIDER_MODELS[providerId];
      const defaultById = new Map(defaults.map((m) => [m.id, m]));
      const liveById = new Map(liveModels.map((m) => [m.id, m]));
      const ordered: any[] = [];
      for (const preset of defaults) {
        const liveItem = liveById.get(preset.id);
        if (liveItem) {
          const validCtx =
            typeof liveItem.contextWindow === 'number' &&
            Number.isFinite(liveItem.contextWindow) &&
            liveItem.contextWindow >= 2048
              ? Math.floor(liveItem.contextWindow)
              : undefined;
          ordered.push(
            preset.baseUrl === effectiveBaseUrl && validCtx === undefined
              ? preset
              : {
                  ...preset,
                  baseUrl: effectiveBaseUrl,
                  ...(validCtx !== undefined ? { contextWindow: validCtx } : {}),
                }
          );
        }
      }
      for (const item of liveModels) {
        if (!defaultById.has(item.id)) {
          ordered.push(
            buildCustomOpenAIModelDefinition(
              spec,
              item.id,
              item.name,
              item.reasoning,
              effectiveBaseUrl,
              item.contextWindow
            )
          );
        }
      }
      if (ordered.length > 0) {
        this.liveCustomProviderModels.set(providerId, ordered);
      } else {
        this.liveCustomProviderModels.delete(providerId);
      }
      this.liveDynamicProviderModels.delete(providerId);
      return;
    }

    const runtimeCatalog: readonly any[] = runtime?.getModels?.(providerId) ?? [];
    if (runtimeCatalog.length === 0) {
      this.liveDynamicProviderModels.delete(providerId);
      return;
    }
    const catalogById = new Map(runtimeCatalog.map((m) => [String(m.id), m]));
    const supportedCatalog = runtimeCatalog.filter((m) =>
      isSupportedLiveChatModel(providerId, String(m.id))
    );
    const synthesized: any[] = [];

    for (const item of liveModels) {
      if (catalogById.has(item.id)) continue;
      const template =
        supportedCatalog.find((m) => Boolean(m.reasoning) === item.reasoning) ??
        supportedCatalog[0] ??
        runtimeCatalog[0];
      if (!template) continue;
      const clonedCompat =
        template.compat && typeof template.compat === 'object'
          ? {
              ...template.compat,
              ...(!item.reasoning ? { requiresReasoningContentOnAssistantMessages: false } : {}),
            }
          : template.compat;
      const validCtx =
        typeof item.contextWindow === 'number' &&
        Number.isFinite(item.contextWindow) &&
        item.contextWindow >= 2048
          ? Math.floor(item.contextWindow)
          : inferContextWindowFromModelId(item.id);
      synthesized.push({
        ...template,
        id: item.id,
        name: item.name || item.id,
        reasoning: item.reasoning,
        ...(validCtx !== undefined ? { contextWindow: validCtx } : {}),
        ...(clonedCompat ? { compat: clonedCompat } : {}),
      });
    }

    if (synthesized.length > 0) {
      this.liveDynamicProviderModels.set(providerId, synthesized);
    } else {
      this.liveDynamicProviderModels.delete(providerId);
    }
  }

  async detectApiKeyProvider(apiKey: string): Promise<ApiKeyDetectPreview> {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      throw new Error('API Key cannot be empty.');
    }
    const discovery = await discoverProviderAndModels({
      requestedProvider: 'auto',
      apiKey: trimmedKey,
      fetchImpl: this.probeFetch,
    });
    const sampleModels = discovery.liveModels
      ? discovery.liveModels.slice(0, 6).map((m) => m.id)
      : [];
    return {
      provider: discovery.provider,
      providerName: discovery.providerName,
      detectionMethod: discovery.detectionMethod,
      liveModelCount: discovery.liveModels?.length ?? 0,
      filteredOutCount: discovery.filteredOutCount,
      sampleModels,
    };
  }

  private async ensureCustomProvidersRegistered(
    runtime: any,
    targetIds?: readonly CustomOpenAIProviderId[]
  ): Promise<void> {
    if (!runtime?.registerProvider) {
      return;
    }
    const specs = targetIds
      ? targetIds.map((id) => CUSTOM_OPENAI_PROVIDERS[id])
      : CUSTOM_OPENAI_PROVIDER_LIST;
    for (const spec of specs) {
      const effectiveBaseUrl = this.getCustomProviderBaseUrl(spec.id);
      const baseModels = this.liveCustomProviderModels.get(spec.id) ?? DEFAULT_CUSTOM_PROVIDER_MODELS[spec.id];
      const mergedById = new Map<string, any>();
      for (const model of baseModels) {
        mergedById.set(
          model.id,
          model.baseUrl === effectiveBaseUrl ? model : { ...model, baseUrl: effectiveBaseUrl }
        );
      }
      const customMap = this.customProviderModels.get(spec.id);
      if (customMap) {
        for (const [id, model] of customMap) {
          if (!mergedById.has(id)) {
            mergedById.set(
              id,
              model.baseUrl === effectiveBaseUrl ? model : { ...model, baseUrl: effectiveBaseUrl }
            );
          }
        }
      }
      runtime.registerProvider(spec.id, {
        name: spec.name,
        baseUrl: effectiveBaseUrl,
        api: 'openai-completions',
        apiKey: spec.resolveApiKeyRef(),
        models: Array.from(mergedById.values()),
        ...(spec.apiKeyOptional
          ? {
              streamSimple: (model: any, context: any, streamOptions?: any) => {
                if (!this.isProviderKeyless(spec.id, streamOptions?.apiKey)) {
                  return openAiCompletionsStreamSimple(model, context, streamOptions);
                }
                const nextHeaders = streamOptions?.headers ? { ...streamOptions.headers } : undefined;
                if (nextHeaders) {
                  for (const key of Object.keys(nextHeaders)) {
                    if (key.toLowerCase() === 'authorization') {
                      delete nextHeaders[key];
                    }
                  }
                }
                return openAiCompletionsStreamSimple(model, context, {
                  ...streamOptions,
                  apiKey: streamOptions?.apiKey || MAGPIE_KEYLESS_RUNTIME_TOKEN,
                  ...(nextHeaders ? { headers: nextHeaders } : {}),
                  fetch: createKeylessFetchWrapper(streamOptions?.fetch),
                });
              },
            }
          : {}),
      });
    }
    await runtime.refresh?.({ allowNetwork: false, providers: specs.map((s) => s.id) });
  }

  async setProviderApiKey(
    providerId: string,
    apiKey: string,
    customModelId?: string,
    options?: { useStored?: boolean; baseUrl?: string; clear?: boolean }
  ): Promise<ApiKeyUpdateResult> {
    if (this.isBusy()) {
      throw new AppError('Cannot update API key while a turn is in progress.', 409);
    }
    const requestedClear = options?.clear === true;
    const useStored = options?.useStored === true;
    const trimmedKey = apiKey.trim();
    const rawProvider = providerId.trim();
    const isAuto = !rawProvider || rawProvider.toLowerCase() === 'auto';
    if (!rawProvider && !trimmedKey) {
      throw new Error('Provider identifier cannot be empty.');
    }
    if (requestedClear && isAuto) {
      throw new Error('请先选择具体的提供商以清除配置。');
    }
    if (useStored && isAuto) {
      throw new Error('请先选择具体的提供商以启用已保存的本地凭据。');
    }

    await this.initSession();
    const runtime = this.currentSession?.modelRuntime;
    const knownProviders: readonly any[] = runtime?.getProviders?.() ?? [];

    let savedRecord =
      !isAuto && this.sessionMode === 'persist'
        ? this.persistedAuth.providers[rawProvider]
        : undefined;
    const isOptionalKeyProvider =
      !isAuto &&
      isCustomOpenAIProviderId(rawProvider) &&
      Boolean(CUSTOM_OPENAI_PROVIDERS[rawProvider].apiKeyOptional);
    const isClear = requestedClear || (!isOptionalKeyProvider && !trimmedKey && !useStored);

    let effectiveKey = trimmedKey;
    if (!isClear && useStored && !effectiveKey) {
      if (savedRecord?.apiKey) {
        effectiveKey = savedRecord.apiKey;
      } else if (isOptionalKeyProvider && savedRecord?.keyless) {
        effectiveKey = '';
      } else if (!isOptionalKeyProvider) {
        throw new Error('该提供商尚未保存本地凭据，请先输入 API Key。');
      }
    }

    let effectiveBaseUrl: string | undefined;
    if (
      !isClear &&
      !isAuto &&
      isCustomOpenAIProviderId(rawProvider) &&
      CUSTOM_OPENAI_PROVIDERS[rawProvider].supportsBaseUrl
    ) {
      const spec = CUSTOM_OPENAI_PROVIDERS[rawProvider];
      const requestedBaseUrl = options?.baseUrl?.trim();
      const defaultBaseUrl = spec.resolveDefaultBaseUrl?.() ?? spec.baseUrl;
      const fallbackBaseUrl =
        savedRecord?.baseUrl || this.getCustomProviderBaseUrl(rawProvider);
      effectiveBaseUrl = spec.normalizeBaseUrl
        ? spec.normalizeBaseUrl(requestedBaseUrl || fallbackBaseUrl, defaultBaseUrl)
        : (requestedBaseUrl || fallbackBaseUrl).replace(/\/+$/, '');
    }

    let trimmedProvider = rawProvider;
    let detectionMeta: Omit<ApiKeyUpdateResult, keyof ModelsState> = {};
    let discoveredLiveModels: readonly DiscoveredLiveModel[] | null = null;

    if (!isClear) {
      if (!isAuto) {
        const providerExists = Boolean(
          runtime?.getProvider?.(trimmedProvider) ||
            knownProviders.some((p) => p.id === trimmedProvider)
        );
        if (!providerExists) {
          throw new Error(`Unknown provider: ${trimmedProvider}`);
        }
      }

      const discovery = await discoverProviderAndModels({
        requestedProvider: isAuto ? 'auto' : trimmedProvider,
        apiKey: effectiveKey,
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        fetchImpl: this.probeFetch,
      });
      trimmedProvider = discovery.provider;
      savedRecord =
        this.sessionMode === 'persist' ? this.persistedAuth.providers[trimmedProvider] : undefined;

      const resolvedExists = Boolean(
        runtime?.getProvider?.(trimmedProvider) ||
          knownProviders.some((p) => p.id === trimmedProvider)
      );
      if (!resolvedExists) {
        throw new Error(`Unknown provider: ${trimmedProvider}`);
      }

      discoveredLiveModels = discovery.liveModels;
      const fallbackCachedLiveModels =
        discovery.liveModels === null && useStored && savedRecord?.liveModels?.length
          ? savedRecord.liveModels
          : null;
      const effectiveLiveModels = discovery.liveModels ?? fallbackCachedLiveModels;
      const effectiveRawCount = discovery.liveModels
        ? discovery.rawModelCount
        : (fallbackCachedLiveModels?.length ?? 0);

      if (
        isCustomOpenAIProviderId(trimmedProvider) &&
        CUSTOM_OPENAI_PROVIDERS[trimmedProvider].presets.length === 0 &&
        discovery.liveModels !== null &&
        discovery.liveModels.length === 0 &&
        !customModelId?.trim() &&
        !(savedRecord?.customModels?.length)
      ) {
        const spec = CUSTOM_OPENAI_PROVIDERS[trimmedProvider];
        throw new Error(
          `已连接 ${spec.name} (${effectiveBaseUrl ?? this.getCustomProviderBaseUrl(trimmedProvider)})，但 /models 未返回可用的对话模型；请先在网关中配置上游渠道，或在下方填写自定义模型 ID。`
        );
      }

      if (effectiveBaseUrl && isCustomOpenAIProviderId(trimmedProvider)) {
        this.customProviderBaseUrls.set(trimmedProvider, effectiveBaseUrl);
        clearReasoningOffFallbackCache(trimmedProvider);
      }

      this.applyDiscoveredLiveModels(
        runtime,
        trimmedProvider,
        effectiveLiveModels,
        effectiveRawCount
      );

      detectionMeta = {
        detectedProvider: trimmedProvider,
        detectedProviderName: discovery.providerName,
        detectionMethod: discovery.detectionMethod,
        ...(discovery.liveModels
          ? {
              liveModelCount: discovery.liveModels.length,
              filteredOutCount: discovery.filteredOutCount,
            }
          : {}),
      };
    } else {
      const providerExists = Boolean(
        runtime?.getProvider?.(trimmedProvider) ||
          knownProviders.some((p) => p.id === trimmedProvider)
      );
      if (!providerExists) {
        throw new Error(`Unknown provider: ${trimmedProvider}`);
      }
      this.liveProviderModelAllowlist.delete(trimmedProvider);
      this.liveDynamicProviderModels.delete(trimmedProvider);
      if (isCustomOpenAIProviderId(trimmedProvider)) {
        this.customProviderModels.delete(trimmedProvider);
        this.liveCustomProviderModels.delete(trimmedProvider);
        this.customProviderBaseUrls.delete(trimmedProvider);
        clearReasoningOffFallbackCache(trimmedProvider);
      }
    }

    let preferredCustomModelId = '';
    if (!isClear && isCustomOpenAIProviderId(trimmedProvider)) {
      if (savedRecord?.customModels) {
        for (const cm of savedRecord.customModels) {
          this.registerCustomProviderModel(trimmedProvider, cm);
        }
      }
      if (customModelId?.trim()) {
        preferredCustomModelId = this.registerCustomProviderModel(trimmedProvider, customModelId);
      }
      await this.ensureCustomProvidersRegistered(runtime, [trimmedProvider]);
    } else if (isClear && isCustomOpenAIProviderId(trimmedProvider)) {
      await this.ensureCustomProvidersRegistered(runtime, [trimmedProvider]);
    }

    if (!isClear) {
      for (const prevProvider of Array.from(this.runtimeApiKeys.keys())) {
        if (prevProvider !== trimmedProvider) {
          await runtime.removeRuntimeApiKey(prevProvider);
          this.runtimeApiKeys.delete(prevProvider);
        }
      }
      for (const prevKeyless of Array.from(this.keylessRuntimeProviders)) {
        if (prevKeyless !== trimmedProvider) {
          await runtime.removeRuntimeApiKey(prevKeyless);
          this.keylessRuntimeProviders.delete(prevKeyless);
        }
      }
      for (const p of knownProviders) {
        const pid = String(p.id);
        if (pid !== trimmedProvider && this.isProviderConfiguredInRuntime(runtime, pid)) {
          this.clearedProviders.add(pid);
        }
      }
      for (const m of runtime?.getAvailableSnapshot?.() ?? []) {
        const pid = String(m.provider);
        if (pid !== trimmedProvider) {
          this.clearedProviders.add(pid);
        }
      }
      this.clearedProviders.delete(trimmedProvider);
      if (effectiveKey) {
        await runtime.setRuntimeApiKey(trimmedProvider, effectiveKey);
        this.runtimeApiKeys.set(trimmedProvider, effectiveKey);
        this.keylessRuntimeProviders.delete(trimmedProvider);
      } else {
        await runtime.setRuntimeApiKey(trimmedProvider, MAGPIE_KEYLESS_RUNTIME_TOKEN);
        this.runtimeApiKeys.delete(trimmedProvider);
        this.keylessRuntimeProviders.add(trimmedProvider);
      }
    } else {
      await runtime.removeRuntimeApiKey(trimmedProvider);
      this.runtimeApiKeys.delete(trimmedProvider);
      this.keylessRuntimeProviders.delete(trimmedProvider);
      this.clearedProviders.add(trimmedProvider);
    }

    const available = this.getAvailableModels(runtime);
    const current = this.currentSession?.model;
    const currentKey = current ? `${current.provider}/${current.id}` : null;
    const isCurrentAvailable = Boolean(
      currentKey && available.some((m) => `${m.provider}/${m.id}` === currentKey)
    );
    const currentBaseUrlChanged = Boolean(
      effectiveBaseUrl &&
        current &&
        current.provider === trimmedProvider &&
        current.baseUrl !== effectiveBaseUrl
    );

    if (!isClear) {
      if (
        !current ||
        !isCurrentAvailable ||
        current.provider !== trimmedProvider ||
        Boolean(preferredCustomModelId && current.id !== preferredCustomModelId) ||
        currentBaseUrlChanged
      ) {
        const providerModels = available.filter((m) => m.provider === trimmedProvider);
        const keepSameId =
          currentBaseUrlChanged && !preferredCustomModelId && current?.id
            ? String(current.id)
            : undefined;
        const nextModel = this.pickDefaultProviderModel(
          providerModels,
          preferredCustomModelId || keepSameId
        );
        if (nextModel) {
          await this.currentSession.setModel(nextModel);
          this.syncMainCompactionSettings();
          if (this.preferredThinkingLevel && typeof this.currentSession.setThinkingLevel === 'function') {
            try {
              this.currentSession.setThinkingLevel(this.preferredThinkingLevel);
            } catch {
              // Ignore model clamping edge errors
            }
          }
          const nextKey = `${nextModel.provider}/${nextModel.id}`;
          this.preferredModelKey = nextKey;
          this.emitEvent('model_changed', {
            model: nextKey,
            provider: nextModel.provider,
            id: nextModel.id,
            name: nextModel.name || nextModel.id,
          });
        } else if (current && !isCurrentAvailable) {
          this.clearActiveSessionModel(true);
        }
      }
    } else if (current && !isCurrentAvailable) {
      const fallbackModel = available[0];
      if (fallbackModel) {
        await this.currentSession.setModel(fallbackModel);
        this.syncMainCompactionSettings();
        const fallbackKey = `${fallbackModel.provider}/${fallbackModel.id}`;
        this.preferredModelKey = fallbackKey;
        this.emitEvent('model_changed', {
          model: fallbackKey,
          provider: fallbackModel.provider,
          id: fallbackModel.id,
          name: fallbackModel.name || fallbackModel.id,
        });
      } else {
        this.clearActiveSessionModel(true);
      }
    }

    if (this.sessionMode === 'persist') {
      if (!isClear) {
        const prevRec = this.persistedAuth.providers[trimmedProvider];
        const mergedCustom: string[] = [];
        const seenCustom = new Set<string>();
        const pushCustom = (id: string) => {
          const clean = id.trim();
          if (clean && !seenCustom.has(clean)) {
            seenCustom.add(clean);
            mergedCustom.push(clean);
          }
        };
        if (prevRec?.customModels) {
          for (const cm of prevRec.customModels) pushCustom(cm);
        }
        if (isCustomOpenAIProviderId(trimmedProvider)) {
          const customMap = this.customProviderModels.get(trimmedProvider);
          if (customMap) {
            for (const cm of customMap.keys()) pushCustom(cm);
          }
        }
        if (preferredCustomModelId) {
          pushCustom(preferredCustomModelId);
        }

        const nextLiveModels =
          discoveredLiveModels && discoveredLiveModels.length > 0
            ? [...discoveredLiveModels]
            : discoveredLiveModels === null
              ? prevRec?.liveModels
              : undefined;

        this.persistedAuth.providers[trimmedProvider] = {
          ...(effectiveKey ? { apiKey: effectiveKey } : { keyless: true }),
          ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
          ...(mergedCustom.length > 0 ? { customModels: mergedCustom } : {}),
          ...(nextLiveModels && nextLiveModels.length > 0 ? { liveModels: nextLiveModels } : {}),
          updatedAt: new Date().toISOString(),
        };
        this.persistedAuth.activeProvider = trimmedProvider;
        const activeSessionModel = this.currentSession?.model
          ? `${this.currentSession.model.provider}/${this.currentSession.model.id}`
          : null;
        if (!this.preferredModelKey && activeSessionModel) {
          this.preferredModelKey = activeSessionModel;
        }
        this.persistedAuth.preferredModel = this.preferredModelKey ?? activeSessionModel;
        this.persistedAuth.preferredThinkingLevel = this.preferredThinkingLevel;
        this.savePersistedAuth();
      } else {
        delete this.persistedAuth.providers[trimmedProvider];
        if (this.persistedAuth.activeProvider === trimmedProvider) {
          this.persistedAuth.activeProvider = null;
        }
        if (this.persistedAuth.preferredModel?.startsWith(`${trimmedProvider}/`)) {
          this.persistedAuth.preferredModel = null;
        }
        this.savePersistedAuth();
      }
    }

    const nextState = await this.getModelsState();
    void this.warmProviderApi(this.currentSession?.model?.api);
    this.emitEvent('models_updated', nextState);
    return {
      ...nextState,
      ...detectionMeta,
    };
  }

  isCurrentModel(modelRef: string): boolean {
    const trimmed = modelRef.trim();
    if (!trimmed || !this.currentSession?.model) {
      return false;
    }
    return this.isSameModelRef(this.currentSession.model, trimmed);
  }

  async warmProviderApi(apiName?: string): Promise<void> {
    const targetApi = (apiName || 'openai-completions').trim();
    const loader = PROVIDER_API_PRELOADERS[targetApi];
    if (!loader || warmedApis.has(targetApi)) {
      return;
    }
    const existing = warmingApiPromises.get(targetApi);
    if (existing) {
      return existing;
    }
    const pending = loader()
      .then(() => {
        warmedApis.add(targetApi);
      })
      .catch(() => {
        // Non-fatal prewarm failure falls back to lazy load during request
      })
      .finally(() => {
        if (warmingApiPromises.get(targetApi) === pending) {
          warmingApiPromises.delete(targetApi);
        }
      });
    warmingApiPromises.set(targetApi, pending);
    return pending;
  }

  async warmup(): Promise<void> {
    const tasks: Array<Promise<unknown>> = [
      this.initSession().then(() => this.warmProviderApi(this.currentSession?.model?.api)),
      this.warmProviderApi('openai-completions'),
    ];
    const effective = this.getEffectiveTranslatorConfig();
    if (
      (this.sessionMode === 'persist' || Boolean(this.ollamaSyncer)) &&
      effective.mode === 'local_mt' &&
      isLocalOllamaCandidate(effective.baseUrl)
    ) {
      tasks.push(
        this.runOllamaSyncManaged({
          baseUrl: effective.baseUrl,
          concurrency: effective.concurrency,
          ollamaPath: effective.ollamaPath,
          forceRestart: false,
        }).catch(() => undefined)
      );
    }
    await Promise.allSettled(tasks);
  }

  private async hydratePersistedAuthIntoRuntime(runtime: any): Promise<void> {
    if (this.sessionMode === 'persist') {
      const activeProvider = this.persistedAuth.activeProvider;
      const activeRec = activeProvider ? this.persistedAuth.providers[activeProvider] : undefined;
      if (activeProvider && activeRec && (activeRec.apiKey || activeRec.keyless)) {
        const knownProviders: readonly any[] = runtime?.getProviders?.() ?? [];
        const providerExists = Boolean(
          runtime?.getProvider?.(activeProvider) || knownProviders.some((p) => p.id === activeProvider)
        );
        if (!providerExists) {
          return;
        }

        if (
          activeRec.baseUrl &&
          isCustomOpenAIProviderId(activeProvider) &&
          CUSTOM_OPENAI_PROVIDERS[activeProvider].supportsBaseUrl
        ) {
          const spec = CUSTOM_OPENAI_PROVIDERS[activeProvider];
          try {
            const defaultBaseUrl = spec.resolveDefaultBaseUrl?.() ?? spec.baseUrl;
            this.customProviderBaseUrls.set(
              activeProvider,
              spec.normalizeBaseUrl
                ? spec.normalizeBaseUrl(activeRec.baseUrl, defaultBaseUrl)
                : activeRec.baseUrl.replace(/\/+$/, '')
            );
          } catch {
            // Ignore malformed persisted baseUrl
          }
        }

        if (activeRec.liveModels && activeRec.liveModels.length > 0) {
          this.applyDiscoveredLiveModels(
            runtime,
            activeProvider,
            activeRec.liveModels,
            activeRec.liveModels.length
          );
        }

        if (isCustomOpenAIProviderId(activeProvider)) {
          if (Array.isArray(activeRec.customModels)) {
            for (const cm of activeRec.customModels) {
              this.registerCustomProviderModel(activeProvider, cm);
            }
          }
          await this.ensureCustomProvidersRegistered(runtime, [activeProvider]);
        }

        for (const p of knownProviders) {
          const pid = String(p.id);
          if (pid !== activeProvider && this.isProviderConfiguredInRuntime(runtime, pid)) {
            this.clearedProviders.add(pid);
          }
        }
        for (const m of runtime?.getAvailableSnapshot?.() ?? []) {
          const pid = String(m.provider);
          if (pid !== activeProvider) {
            this.clearedProviders.add(pid);
          }
        }
        this.clearedProviders.delete(activeProvider);

        if (activeRec.apiKey) {
          await runtime.setRuntimeApiKey(activeProvider, activeRec.apiKey);
          this.runtimeApiKeys.set(activeProvider, activeRec.apiKey);
          this.keylessRuntimeProviders.delete(activeProvider);
        } else if (activeRec.keyless) {
          await runtime.setRuntimeApiKey(activeProvider, MAGPIE_KEYLESS_RUNTIME_TOKEN);
          this.runtimeApiKeys.delete(activeProvider);
          this.keylessRuntimeProviders.add(activeProvider);
        }
        return;
      }
    }

    // Best-effort env-var hydration for baseUrl-configurable custom providers (e.g. Magpie)
    for (const spec of CUSTOM_OPENAI_PROVIDER_LIST) {
      if (!spec.supportsBaseUrl || this.clearedProviders.has(spec.id)) continue;
      const envKey = spec.envVar ? process.env[spec.envVar]?.trim() || '' : '';
      const envBase = spec.baseUrlEnvVar ? process.env[spec.baseUrlEnvVar]?.trim() || '' : '';
      const envModel = spec.modelEnvVar ? process.env[spec.modelEnvVar]?.trim() || '' : '';
      if (!envKey && !envBase) continue;

      const effectiveBase = spec.resolveDefaultBaseUrl?.() ?? spec.baseUrl;
      this.customProviderBaseUrls.set(spec.id, effectiveBase);
      if (!envKey && spec.apiKeyOptional) {
        this.keylessRuntimeProviders.add(spec.id);
      }
      let updated = false;
      if (process.env.PI_OFFLINE === undefined || Boolean(this.probeFetch)) {
        try {
          const discovery = await discoverProviderAndModels({
            requestedProvider: spec.id,
            apiKey: envKey,
            baseUrl: effectiveBase,
            fetchImpl: this.probeFetch,
            timeoutMs: 2500,
          });
          if (discovery.liveModels && discovery.liveModels.length > 0) {
            this.applyDiscoveredLiveModels(
              runtime,
              spec.id,
              discovery.liveModels,
              discovery.rawModelCount
            );
            updated = true;
          }
        } catch {
          // Non-fatal: local gateway may not be started yet at server boot
        }
      }
      if (envModel) {
        this.registerCustomProviderModel(spec.id, envModel);
        updated = true;
      }
      if (updated) {
        await this.ensureCustomProvidersRegistered(runtime, [spec.id]);
      }
    }
  }

  private async getOrCreateModelRuntime(): Promise<any> {
    if (this.sharedModelRuntime) {
      return this.sharedModelRuntime;
    }
    if (this.sharedModelRuntimePromise) {
      return this.sharedModelRuntimePromise;
    }
    const pending = (async () => {
      const runtime = wrapModelRuntimeWithReasoningOffFallback(await ModelRuntime.create());
      if (!this.customProvidersInitialized) {
        await this.ensureCustomProvidersRegistered(runtime);
        this.customProvidersInitialized = true;
      }
      await this.hydratePersistedAuthIntoRuntime(runtime);
      this.sharedModelRuntime = runtime;
      return runtime;
    })().finally(() => {
      if (this.sharedModelRuntimePromise === pending) {
        this.sharedModelRuntimePromise = null;
      }
    });
    this.sharedModelRuntimePromise = pending;
    return pending;
  }

  async selectModel(modelRef: string): Promise<ModelsState> {
    if (this.isBusy()) {
      throw new AppError('Cannot switch model while a turn is in progress.', 409);
    }
    return this.selectModelInternal(modelRef);
  }

  private syncMainCompactionSettings(): void {
    if (!this.settingsManager) return;
    applyCompactionSettingsForModel(this.settingsManager, this.currentSession?.model, 'main');
  }

  private async selectModelInternal(modelRef: string): Promise<ModelsState> {
    await this.initSession();
    const trimmedRef = modelRef.trim();
    const slashIdx = trimmedRef.indexOf('/');
    if (slashIdx > 0) {
      const refProvider = trimmedRef.slice(0, slashIdx);
      if (isCustomOpenAIProviderId(refProvider) && !this.clearedProviders.has(refProvider)) {
        const runtime = this.currentSession?.modelRuntime;
        if (this.isProviderConfiguredInRuntime(runtime, refProvider)) {
          const customId = trimmedRef.slice(slashIdx + 1).trim();
          if (customId && !runtime?.getModel?.(refProvider, customId)) {
            this.registerCustomProviderModel(refProvider, customId);
            await this.ensureCustomProvidersRegistered(runtime, [refProvider]);
          }
        }
      }
    }
    const target = this.resolveModelFromRuntime(modelRef);
    const targetKey = `${target.provider}/${target.id}`;
    const current = this.currentSession?.model;

    if (!current || `${current.provider}/${current.id}` !== targetKey) {
      await this.currentSession.setModel(target);
      this.syncMainCompactionSettings();
      if (this.preferredThinkingLevel && typeof this.currentSession.setThinkingLevel === 'function') {
        try {
          this.currentSession.setThinkingLevel(this.preferredThinkingLevel);
        } catch {
          // Ignore model clamping edge errors
        }
      }
      this.emitEvent('model_changed', {
        model: targetKey,
        provider: target.provider,
        id: target.id,
        name: target.name || target.id,
      });
      this.emitEvent('token_usage', this.getSessionTokenUsage());
    }
    void this.warmProviderApi(target?.api);
    this.preferredModelKey = targetKey;
    if (this.sessionMode === 'persist') {
      this.persistedAuth.preferredModel = targetKey;
      if (isCustomOpenAIProviderId(target.provider) && this.isUserCustomModel(target.provider, target.id)) {
        this.recordCustomModelInPersistedAuth(target.provider, target.id);
      }
      this.savePersistedAuth();
    }
    return this.getModelsState();
  }

  async initSession(): Promise<void> {
    // 并发挂载/切换工作区时会同时触发多个初始化路径，统一收敛为单飞以避免重复创建与双重订阅
    while (!this.currentSession || this.initSessionPromise) {
      if (this.initSessionPromise) {
        await this.initSessionPromise;
        continue;
      }
      const epoch = this.sessionEpoch;
      let pending!: Promise<void>;
      pending = this.performInitSession(epoch).finally(() => {
        if (this.initSessionPromise === pending) {
          this.initSessionPromise = null;
        }
      });
      this.initSessionPromise = pending;
      await pending;
    }
  }

  private async performInitSession(epoch: number): Promise<void> {
    const isStale = (): boolean => epoch !== this.sessionEpoch;
    let session: any = null;
    let subscribed = false;

    const cleanupSession = (target: any) => {
      if (!target) return;
      try {
        target.dispose?.();
      } catch {
        // Ignore stale or partial session cleanup errors
      }
      if (this.currentSession === target) {
        this.currentSession = null;
      }
    };

    try {
      const emitSubagentActivity = (role: string, delta: string, callId?: string) => {
        if (this.activeTurnSnapshot) {
          const targetTool =
            (callId
              ? this.activeTurnSnapshot.tools.find((t) => t.callId === callId)
              : undefined) ??
            this.activeTurnSnapshot.tools.find(
              (t) =>
                (t.tool === 'delegate_task' ||
                  t.tool === 'vn_translate_batches' ||
                  t.tool === 'vn_post_qa_parallel') &&
                (t.result === undefined || t.result === null)
            );
          if (targetTool) {
            targetTool.liveDeltaChars = (targetTool.liveDeltaChars ?? 0) + delta.length;
          }
        }
        this.emitEvent('subagent_delta', { role, delta, ...(callId ? { callId } : {}) });
      };

      const handleSubagentTaskUpdated = (summary: SubagentTaskSummary) => {
        if (this.activeTurnSnapshot && summary.parentCallId) {
          const targetTool = this.activeTurnSnapshot.tools.find(
            (t) => t.callId === summary.parentCallId
          );
          if (targetTool) {
            targetTool.subagentRole = summary.role;
            if (targetTool.tool === 'delegate_task') {
              targetTool.subagentTaskId = summary.taskId;
            } else {
              const ids = targetTool.subagentTaskIds ? [...targetTool.subagentTaskIds] : [];
              if (!ids.includes(summary.taskId)) {
                ids.push(summary.taskId);
              }
              targetTool.subagentTaskIds = ids;
              targetTool.subagentTaskId = summary.taskId;
            }
          }
        }
        this.emitEvent('subagent_task_updated', summary);
      };
      this.subagentManager.setOnTaskUpdated(handleSubagentTaskUpdated);
      this.subagentManager.setOnStreamDelta((ev: SubagentStreamDeltaEvent) => {
        this.emitEvent('subagent_stream_delta', ev);
      });
      this.subagentManager.setOnQueueUpdated((ev: SubagentQueueUpdatedEvent) => {
        this.emitEvent('subagent_queue_updated', ev);
      });
      this.subagentManager.setOnQueueRestored((ev: SubagentQueueRestoredEvent) => {
        this.emitEvent('subagent_queue_restored', ev);
      });
      this.subagentManager.setOnUsage((ev) => {
        this.recordSessionUsage(ev.usageKind, ev.provider, ev.model, ev.usage, {
          sessionId: ev.sessionId,
        });
      });

      const vnTools = createVnTools(() => this.activeWorkspace, {
        onSkillChanged: () => this.refreshLoadedSkills(),
        getTurnSignal: () => this.activeTurnAbortController?.signal,
        getKnownSecrets: () => this.getAllKnownSecrets(),
        subagentManager: this.subagentManager,
        getModel: () => this.currentSession?.model,
        getModelRuntime: () => this.currentSession?.modelRuntime,
        getSessionId: () => this.sessionManager?.getSessionId?.() ?? null,
        shouldRecordDiagnostics: () => this.sessionMode === 'persist',
        onSubagentActivity: emitSubagentActivity,
        onBatchProgress: (progress) => {
          this.invalidateEngineeringStatusCache();
          this.emitEvent('batch_progress', progress);
        },
        onTaskUpdated: handleSubagentTaskUpdated,
        getTranslatorConfig: () => this.getEffectiveTranslatorConfig(),
        getPublicTranslatorConfig: () => toPublicTranslatorConfig(this.getEffectiveTranslatorConfig()),
        localTranslatorFetch: this.localTranslatorFetch,
        ensureLocalEndpointReady: async (cfg) => {
          if (
            cfg.mode === 'local_mt' &&
            isLocalOllamaCandidate(cfg.baseUrl) &&
            (this.ollamaSyncer || this.sessionMode === 'persist')
          ) {
            const res = await this.runOllamaSyncManaged({
              baseUrl: cfg.baseUrl,
              concurrency: cfg.concurrency,
              ollamaPath: cfg.ollamaPath,
              forceRestart: false,
            });
            if (res.status === 'failed') {
              throw new LocalTranslatorEndpointError(res.message || '自动启动本机 Ollama 失败。');
            }
          }
        },
        onLocalUsage: (delta: LocalUsageDelta) => {
          const piUsage: Usage = {
            input: delta.input,
            output: delta.output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: delta.totalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          this.recordSessionUsage('local_mt:translator', 'local_mt', delta.model || 'local', piUsage, {
            sessionId: this.sessionManager?.getSessionId?.() ?? null,
            note: delta.estimated ? 'estimated' : undefined,
          });
        },
        smokeDriver: this.smokeDriver,
        onVisionUsage: (provider, modelId, usage) => {
          this.recordSessionUsage('cloud:smoke-vision', provider, modelId, usage, {
            sessionId: this.sessionManager?.getSessionId?.() ?? null,
          });
        },
        onChatFormUpdated: (form) => {
          this.invalidateEngineeringStatusCache();
          this.emitEvent('chat_form_updated', form);
        },
      });
      const reverserTools = createReverserTools(() => this.activeWorkspace, {
        getKnownSecrets: () => this.getAllKnownSecrets(),
      });
      const subagentTools = this.subagentManager.createTools(
        () => this.activeWorkspace,
        emitSubagentActivity,
        () => this.currentSession?.model,
        () => [...vnTools, ...reverserTools],
        () => this.currentSession?.modelRuntime,
        {
          turnAbortSignalProvider: () => this.activeTurnAbortController?.signal,
          getKnownSecrets: () => this.getAllKnownSecrets(),
          sessionIdProvider: () => this.sessionManager?.getSessionId?.() ?? null,
          recordDiagnosticsProvider: () => this.sessionMode === 'persist',
          onTaskUpdated: handleSubagentTaskUpdated,
        }
      );

      if (!this.sessionManager) {
        if (this.sessionMode === 'memory') {
          const map = this.getWorkspaceMemoryMap();
          const latest = Array.from(map.values())
            .filter((rec) => this.sessionManagerHasMessages(rec.manager))
            .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.seq - a.seq)[0];
          this.sessionManager = latest ? latest.manager : SessionManager.inMemory(this.activeWorkspace);
        } else {
          const sessionDir = this.resolveSessionDir(this.activeWorkspace);
          try {
            const latestArchived = await this.findLatestArchivedSessionFile(
              this.activeWorkspace,
              sessionDir
            );
            if (isStale()) return;
            this.sessionManager = latestArchived
              ? SessionManager.open(latestArchived, sessionDir, this.activeWorkspace)
              : SessionManager.create(this.activeWorkspace, sessionDir);
          } catch (err) {
            console.warn(`Failed to resume session in ${sessionDir}, starting fresh:`, err);
            this.sessionManager = SessionManager.create(this.activeWorkspace, sessionDir);
          }
        }
      }
      this.installSessionRedaction(this.sessionManager);
      if (!this.isRunningTurn) {
        this.turnUsageStartEntryIndex = this.sessionManager.getEntries().length;
        this.inFlightMainStreamText = '';
        this.lastLiveUsageEmitMs = 0;
      }

      const settingsManager = SettingsManager.inMemory();
      this.settingsManager = settingsManager;
      applyPaperCupQueueModes(settingsManager);
      applyCompactionSettingsForModel(settingsManager, undefined, 'main');
      if (config.bashPath) {
        settingsManager.setShellPath(config.bashPath);
      }

      const resourceLoader = new DefaultResourceLoader({
        cwd: this.activeWorkspace,
        agentDir: this.activeWorkspace,
        settingsManager,
        noExtensions: true,
        extensionFactories: [
          createPaperCupCompactionExtension({
            role: 'main',
            cwd: this.activeWorkspace,
            getKnownSecrets: () => this.getAllKnownSecrets(),
            getModel: () => this.currentSession?.model,
            getStreamFn: () => this.currentSession?.agent?.streamFunction,
          }),
        ],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        skillsOverride: () => {
          const skillPaths = this.collectSkillPaths();
          if (skillPaths.length === 0) {
            return { skills: [], diagnostics: [] };
          }
          return loadSkills({
            cwd: this.activeWorkspace,
            agentDir: this.activeWorkspace,
            skillPaths,
            includeDefaults: false,
          });
        },
        systemPrompt: PAPERCUP_SYSTEM_PROMPT,
      });
      this.resourceLoader = resourceLoader;
      await resourceLoader.reload();
      if (isStale()) return;

      const modelRuntime = await this.getOrCreateModelRuntime();
      if (isStale()) return;

      const researchCfg = readVnResearchConfig(this.activeWorkspace);
      const skillPaths = this.collectSkillPaths().filter((p) => typeof p === 'string' && p.trim().length > 0);
      const guardedBuiltins = createGuardedBuiltinToolDefinitions(
        this.activeWorkspace,
        ['read', 'bash', 'edit', 'write', 'ls', 'find'],
        {
          bashPath: config.bashPath,
          getKnownSecrets: () => this.getAllKnownSecrets(),
          ...(skillPaths.length > 0 ? { skillReadRoots: skillPaths } : {}),
          defaultBashTimeoutSec: researchCfg.mainBashTimeoutSec,
          maxBashTimeoutSec: Math.max(researchCfg.mainBashTimeoutSec, DEFAULT_MAIN_BASH_MAX_TIMEOUT_SEC),
          agentRole: 'main',
        }
      );
      const customTools = [...guardedBuiltins, ...vnTools, ...subagentTools];
      const hasHistoryEntries = (this.sessionManager.getEntryCount?.() ?? 0) > 0;
      const initialThinking: ThinkingLevel | undefined =
        this.preferredThinkingLevel ?? (!hasHistoryEntries ? 'low' : undefined);

      const created = await createAgentSession({
        sessionManager: this.sessionManager,
        settingsManager,
        resourceLoader,
        modelRuntime,
        cwd: this.activeWorkspace,
        noTools: 'builtin',
        customTools,
        ...(initialThinking ? { thinkingLevel: initialThinking } : {}),
      });
      session = created.session;
      if (isStale()) {
        cleanupSession(session);
        return;
      }

      this.currentSession = session;
      applyPaperCupQueueModes(settingsManager, session);
      this.syncMainCompactionSettings();
      if (this.preferredThinkingLevel && typeof session.setThinkingLevel === 'function') {
        try {
          session.setThinkingLevel(this.preferredThinkingLevel);
        } catch {
          // Ignore model clamping edge errors
        }
      }

      if (
        (this.runtimeApiKeys.size > 0 || this.keylessRuntimeProviders.size > 0) &&
        session.modelRuntime?.setRuntimeApiKey
      ) {
        const runtimeEntries: Array<[string, string]> = [
          ...Array.from(this.runtimeApiKeys.entries()),
          ...Array.from(this.keylessRuntimeProviders)
            .filter((pid) => !this.runtimeApiKeys.has(pid))
            .map((pid): [string, string] => [pid, MAGPIE_KEYLESS_RUNTIME_TOKEN]),
        ];
        for (const [providerId, key] of runtimeEntries) {
          const authStatus = session.modelRuntime?.getProviderAuthStatus?.(providerId);
          if (authStatus?.configured && authStatus?.source === 'runtime') {
            continue;
          }
          try {
            await session.modelRuntime.setRuntimeApiKey(providerId, key);
          } catch (err) {
            console.warn(`Failed to restore runtime API key for ${providerId}:`, err);
          }
          if (isStale()) {
            cleanupSession(session);
            return;
          }
        }
        if (!session.model && !this.preferredModelKey) {
          const firstAvailable = this.pickDefaultProviderModel(this.getAvailableModels(session.modelRuntime));
          if (firstAvailable) {
            try {
              await session.setModel(firstAvailable);
              if (this.preferredThinkingLevel && typeof session.setThinkingLevel === 'function') {
                try {
                  session.setThinkingLevel(this.preferredThinkingLevel);
                } catch {
                  // Ignore model clamping edge errors
                }
              }
            } catch (err) {
              console.warn('Failed to select restored runtime model:', err);
            }
            if (isStale()) {
              cleanupSession(session);
              return;
            }
          }
        }
      }

      if (this.preferredModelKey && !this.isSameModelRef(session.model, this.preferredModelKey)) {
        try {
          const preferred = this.resolveModelFromRuntime(this.preferredModelKey);
          await session.setModel(preferred);
          if (this.preferredThinkingLevel && typeof session.setThinkingLevel === 'function') {
            try {
              session.setThinkingLevel(this.preferredThinkingLevel);
            } catch {
              // Ignore model clamping edge errors
            }
          }
        } catch (err) {
          console.warn(`Failed to restore preferred model ${this.preferredModelKey}:`, err);
          this.preferredModelKey = null;
        }
        if (isStale()) {
          cleanupSession(session);
          return;
        }
      }

      if (
        !session.model &&
        !this.preferredModelKey &&
        (this.runtimeApiKeys.size > 0 ||
          this.keylessRuntimeProviders.size > 0 ||
          CUSTOM_OPENAI_PROVIDER_LIST.some((spec) =>
            this.isProviderConfiguredInRuntime(session.modelRuntime, spec.id)
          ))
      ) {
        const firstAvailable = this.pickDefaultProviderModel(this.getAvailableModels(session.modelRuntime));
        if (firstAvailable) {
          try {
            await session.setModel(firstAvailable);
            if (this.preferredThinkingLevel && typeof session.setThinkingLevel === 'function') {
              try {
                session.setThinkingLevel(this.preferredThinkingLevel);
              } catch {
                // Ignore model clamping edge errors
              }
            }
          } catch (err) {
            console.warn('Failed to select custom provider model:', err);
          }
          if (isStale()) {
            cleanupSession(session);
            return;
          }
        }
      }

      const sessionAvailable = this.getAvailableModels(session.modelRuntime);
      if (session.model) {
        const sessionProvider = String(session.model.provider);
        const sessionModelId = String(session.model.id);
        const sessionModelKey = `${sessionProvider}/${sessionModelId}`;
        const isModelInAvailable = sessionAvailable.some(
          (m) => `${m.provider}/${m.id}` === sessionModelKey
        );
        const isModelSupported =
          this.isUserCustomModel(sessionProvider, sessionModelId) ||
          (isSupportedLiveChatModel(sessionProvider, sessionModelId) &&
            (!this.liveProviderModelAllowlist.has(sessionProvider) ||
              Boolean(this.liveProviderModelAllowlist.get(sessionProvider)?.has(sessionModelId))));
        if (
          this.clearedProviders.has(sessionProvider) ||
          !isModelSupported ||
          (!isModelInAvailable && !this.isProviderConfiguredInRuntime(session.modelRuntime, sessionProvider))
        ) {
          const fallback = this.pickDefaultProviderModel(sessionAvailable) ?? sessionAvailable[0];
          if (fallback) {
            try {
              await session.setModel(fallback);
              this.preferredModelKey = `${fallback.provider}/${fallback.id}`;
              if (this.preferredThinkingLevel && typeof session.setThinkingLevel === 'function') {
                try {
                  session.setThinkingLevel(this.preferredThinkingLevel);
                } catch {
                  // Ignore model clamping edge errors
                }
              }
            } catch (err) {
              console.warn('Failed to switch away from cleared provider model:', err);
            }
            if (isStale()) {
              cleanupSession(session);
              return;
            }
          } else {
            this.clearActiveSessionModel(false);
          }
        }
      }

      if (isStale()) {
        cleanupSession(session);
        return;
      }

      this.syncMainCompactionSettings();

      // セッションイベントをフック
      session.subscribe((event: any) => {
        this.handlePiSessionEvent(event);
      });
      subscribed = true;

      void this.warmProviderApi(session.model?.api);
      this.emitEvent('session_ready', { sessionId: this.sessionManager?.getSessionId?.() });
      this.emitEvent('token_usage', this.getSessionTokenUsage());
    } catch (err) {
      if (!subscribed) {
        cleanupSession(session);
      }
      throw err;
    }
  }

  private maybeEmitLiveTokenUsage(): void {
    const now = Date.now();
    if (now - this.lastLiveUsageEmitMs < 180) {
      return;
    }
    this.lastLiveUsageEmitMs = now;
    this.emitEvent('token_usage', this.getSessionTokenUsage());
  }

  private handlePiSessionEvent(event: any): void {
    if (event.type === 'queue_update') {
      if (this.isRunningTurn && !this.mainQueueController.isRebuilding) {
        this.mainQueueController.reconcileWithSession(this.currentSession);
        this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
      }
      return;
    }
    if (event.type === 'message_start' && event.message?.role === 'user') {
      if (!this.isRunningTurn) return;
      this.activeTurnUserMsgCount += 1;
      if (this.activeTurnUserMsgCount === 1) {
        return;
      }
      const snap = this.activeTurnSnapshot;
      if (snap && (snap.thinking || snap.response || snap.tools.length > 0)) {
        const committedAssistant: PersistedChatMessage = {
          id: `active-a-${++this.activeTurnCommitSeq}`,
          role: 'assistant',
          content: snap.response,
          ...(snap.thinking ? { thinking: snap.thinking } : {}),
          ...(snap.tools.length > 0 ? { tools: snap.tools.map((t) => ({ ...t })) } : {}),
          timestamp: new Date().toLocaleTimeString(),
        };
        this.activeTurnCommittedMessages.push(committedAssistant);
        this.emitEvent('turn_segment_commit', { message: committedAssistant });
        snap.thinking = '';
        snap.response = '';
        snap.tools = [];
      }
      if (snap) {
        snap.isThinking = false;
        snap.phase = 'connecting';
        snap.retryAttempt = undefined;
        snap.retryMaxAttempts = undefined;
      }
      this.inFlightMainStreamText = '';

      const rawText = this.extractText(event.message?.content);
      const images = extractImagesFromContent(event.message?.content);
      const delivered = this.mainQueueController.consumeDelivered(rawText, this.currentSession);
      const deliveryMode: QueuedMessageMode = delivered?.mode ?? 'steer';
      const displayText = delivered?.text ?? rawText;
      const curSessionId = this.sessionManager?.getSessionId?.() ?? null;
      this.rememberDeliveredUserMode(curSessionId, event.message?.timestamp, rawText, deliveryMode);
      if (displayText && displayText !== rawText) {
        this.rememberDeliveredUserMode(curSessionId, event.message?.timestamp, displayText, deliveryMode);
      }
      if (displayText.trim() || images.length > 0) {
        const injectedUser: PersistedChatMessage = {
          id: delivered?.id || `active-u-${++this.activeTurnCommitSeq}`,
          role: 'user',
          content: displayText,
          ...(images.length > 0 ? { images } : {}),
          timestamp: this.formatTimestamp(event.message?.timestamp),
          deliveryMode,
        };
        this.activeTurnCommittedMessages.push(injectedUser);
        this.emitEvent('turn_user_injected', { message: injectedUser });
      }
      this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
      return;
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (!update) return;

      if (update.type === 'text_delta') {
        if (this.turnTiming && this.turnTiming.firstTokenAt === null) {
          this.turnTiming.firstTokenAt = performance.now();
        }
        const safeDelta = redactSecrets(String(update.delta || ''), this.getAllKnownSecrets());
        this.inFlightMainStreamText += safeDelta;
        if (this.activeTurnSnapshot) {
          this.activeTurnSnapshot.isThinking = false;
          this.activeTurnSnapshot.phase = 'generating';
          this.activeTurnSnapshot.retryAttempt = undefined;
          this.activeTurnSnapshot.retryMaxAttempts = undefined;
          this.activeTurnSnapshot.response += safeDelta;
        }
        this.emitEvent('text_delta', { delta: safeDelta });
        this.maybeEmitLiveTokenUsage();
      } else if (update.type === 'thinking_delta') {
        if (this.turnTiming && this.turnTiming.firstTokenAt === null) {
          this.turnTiming.firstTokenAt = performance.now();
        }
        const safeDelta = redactSecrets(String(update.delta || ''), this.getAllKnownSecrets());
        this.inFlightMainStreamText += safeDelta;
        if (this.activeTurnSnapshot) {
          this.activeTurnSnapshot.isThinking = true;
          this.activeTurnSnapshot.phase = 'thinking';
          this.activeTurnSnapshot.retryAttempt = undefined;
          this.activeTurnSnapshot.retryMaxAttempts = undefined;
          this.activeTurnSnapshot.thinking += safeDelta;
        }
        this.emitEvent('thinking_delta', { delta: safeDelta });
        this.maybeEmitLiveTokenUsage();
      }
    } else if (event.type === 'tool_execution_start') {
      if (this.turnTiming && this.turnTiming.firstTokenAt === null) {
        this.turnTiming.firstTokenAt = performance.now();
      }
      const safeArgs = redactUnknownValue(event.args, this.getAllKnownSecrets());
      const callId = typeof event.toolCallId === 'string' && event.toolCallId ? event.toolCallId : undefined;
      const subagentRole =
        event.toolName === 'delegate_task' && typeof safeArgs?.role === 'string'
          ? safeArgs.role
          : event.toolName === 'vn_translate_batches'
            ? 'translator'
            : event.toolName === 'vn_post_qa_parallel'
              ? 'role-checker'
              : undefined;
      if (this.activeTurnSnapshot) {
        this.activeTurnSnapshot.isThinking = false;
        this.activeTurnSnapshot.phase = 'tool';
        this.activeTurnSnapshot.retryAttempt = undefined;
        this.activeTurnSnapshot.retryMaxAttempts = undefined;
        this.activeTurnSnapshot.tools.push({
          ...(callId ? { callId } : {}),
          tool: event.toolName,
          args: safeArgs,
          ...(subagentRole ? { subagentRole } : {}),
        });
      }
      this.emitEvent('tool_start', {
        ...(callId ? { callId } : {}),
        tool: event.toolName,
        args: safeArgs,
        ...(subagentRole ? { subagentRole } : {}),
      });
    } else if (event.type === 'tool_execution_end') {
      const safeResult = redactUnknownValue(event.result, this.getAllKnownSecrets());
      const callId = typeof event.toolCallId === 'string' && event.toolCallId ? event.toolCallId : undefined;
      const isError = event.isError === true;
      const taskId = typeof safeResult?.details?.taskId === 'string' ? safeResult.details.taskId : undefined;
      const taskIds = Array.isArray(safeResult?.details?.subagentTaskIds)
        ? safeResult.details.subagentTaskIds.map(String)
        : undefined;
      const subRole = typeof safeResult?.details?.role === 'string' ? safeResult.details.role : undefined;
      if (this.activeTurnSnapshot) {
        const target =
          (callId
            ? this.activeTurnSnapshot.tools.find(
                (t) => t.callId === callId && (t.result === undefined || t.result === null)
              )
            : undefined) ??
          this.activeTurnSnapshot.tools.find(
            (t) => t.tool === event.toolName && (t.result === undefined || t.result === null)
          );
        if (target) {
          target.result = safeResult;
          target.isError = isError;
          if (taskId) target.subagentTaskId = taskId;
          if (taskIds && taskIds.length > 0) {
            target.subagentTaskIds = taskIds;
            if (!target.subagentTaskId) target.subagentTaskId = taskIds[taskIds.length - 1];
          }
          if (subRole) target.subagentRole = subRole;
        }
      }
      this.emitEvent('tool_end', {
        ...(callId ? { callId } : {}),
        tool: event.toolName,
        result: safeResult,
        isError,
        ...(taskId ? { subagentTaskId: taskId } : {}),
        ...(taskIds ? { subagentTaskIds: taskIds } : {}),
        ...(subRole ? { subagentRole: subRole } : {}),
      });
    } else if (event.type === 'auto_retry_start') {
      if (this.turnTiming) {
        this.turnTiming.retries += 1;
      }
      const attempt = typeof event.attempt === 'number' ? event.attempt : undefined;
      const maxAttempts = typeof event.maxAttempts === 'number' ? event.maxAttempts : undefined;
      const delayMs = typeof event.delayMs === 'number' ? event.delayMs : undefined;
      if (this.activeTurnSnapshot) {
        this.activeTurnSnapshot.isThinking = false;
        this.activeTurnSnapshot.phase = 'retrying';
        this.activeTurnSnapshot.retryAttempt = attempt;
        this.activeTurnSnapshot.retryMaxAttempts = maxAttempts;
      }
      this.emitEvent('turn_retry', {
        ...(attempt !== undefined ? { attempt } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
      });
    } else if (event.type === 'auto_retry_end') {
      if (event.success === true && this.activeTurnSnapshot && this.activeTurnSnapshot.phase === 'retrying') {
        this.activeTurnSnapshot.phase = 'connecting';
        this.activeTurnSnapshot.retryAttempt = undefined;
        this.activeTurnSnapshot.retryMaxAttempts = undefined;
      }
    } else if (event.type === 'message_end' && event.message?.role === 'user') {
      if (this.sessionMode === 'memory') {
        this.commitMemorySessionRecord();
      }
      if (this.turnBaseMessageCount === 0) {
        const curFile = this.sessionManager?.getSessionFile?.();
        if (curFile) {
          this.sessionFileMetaCache.delete(
            process.platform === 'win32' ? curFile.toLowerCase() : curFile
          );
        }
        void this.listWorkspaceSessions()
          .then((sessions) => {
            this.emitEvent('sessions_updated', {
              sessionId: this.sessionManager?.getSessionId?.() ?? null,
              sessions,
            });
          })
          .catch(() => {
            // Ignore non-fatal session summary refresh failure
          });
      }
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      this.inFlightMainStreamText = '';
      this.lastLiveUsageEmitMs = 0;
      if (event.message.stopReason === 'error') {
        const rawErr = String(event.message.errorMessage || '模型请求返回错误。');
        const cls = classifySubagentError(rawErr, false);
        if (cls.fatalForPool && typeof this.currentSession?.setAutoRetryEnabled === 'function') {
          this.currentSession.setAutoRetryEnabled(false);
        }
        this.lastTurnError = redactSecrets(rawErr, this.getAllKnownSecrets());
      } else {
        this.lastTurnError = undefined;
      }
    } else if (event.type === 'agent_end') {
      if (this.isRunningTurn && !this.turnAborted && this.lastTurnError && event.willRetry === false) {
        const hadPending =
          this.mainQueueController.hasPending() ||
          ((this.currentSession?.getSteeringMessages?.().length ?? 0) +
            (this.currentSession?.getFollowUpMessages?.().length ?? 0)) > 0;
        if (hadPending && !this.activeTurnRestoredDraft) {
          this.activeTurnRestoredDraft = this.mainQueueController.clearForRestore(this.currentSession);
          this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
        }
      }
    } else if (event.type === 'compaction_start') {
      this.isCompacting = true;
      const reason: CompactionReason =
        this.pendingCompactionReasonOverride ??
        (event.reason === 'manual' || event.reason === 'overflow' ? event.reason : 'threshold');
      if (reason === 'overflow') {
        this.turnOverflowCompactionAttempted = true;
      }
      const focus = reason === 'manual' ? this.pendingManualCompactionFocus : undefined;
      this.emitEvent('compaction_start', {
        reason,
        phase: 'compacting',
        ...(focus ? { focus } : {}),
      });
    } else if (event.type === 'compaction_end') {
      this.isCompacting = false;
      const reason: CompactionReason =
        this.pendingCompactionReasonOverride ??
        (event.reason === 'manual' || event.reason === 'overflow' ? event.reason : 'threshold');
      const focus = reason === 'manual' ? this.pendingManualCompactionFocus : undefined;
      const errMsg = typeof event.errorMessage === 'string' ? event.errorMessage : undefined;
      const isNoop = Boolean(errMsg && /nothing to compact|already compacted|session too small/i.test(errMsg));

      if (event.result) {
        const branch: any[] = this.sessionManager?.getBranch?.() ?? [];
        let latestCompactionEntry: any = null;
        for (let i = branch.length - 1; i >= 0; i -= 1) {
          if (branch[i]?.type === 'compaction') {
            latestCompactionEntry = branch[i];
            break;
          }
        }
        let summaryInfo: CompactionSummaryInfo;
        if (latestCompactionEntry) {
          const extracted = extractCompactionSummaryInfo(
            latestCompactionEntry,
            event.result.estimatedTokensAfter
          );
          const resolvedFocus = extracted.focus ?? focus;
          summaryInfo = {
            ...extracted,
            reason,
            ...(resolvedFocus ? { focus: resolvedFocus } : {}),
          };
        } else {
          const summary = typeof event.result.summary === 'string' ? event.result.summary : '';
          const tokensBefore =
            typeof event.result.tokensBefore === 'number' && Number.isFinite(event.result.tokensBefore)
              ? Math.max(0, Math.floor(event.result.tokensBefore))
              : 0;
          const detailsTokensAfter =
            typeof event.result.details?.tokensAfter === 'number' &&
            Number.isFinite(event.result.details.tokensAfter)
              ? Math.max(0, Math.floor(event.result.details.tokensAfter))
              : undefined;
          const tokensAfter =
            detailsTokensAfter ??
            (typeof event.result.estimatedTokensAfter === 'number' &&
            Number.isFinite(event.result.estimatedTokensAfter)
              ? Math.max(0, Math.floor(event.result.estimatedTokensAfter))
              : Math.ceil(summary.length / 4));
          const resolvedFocus =
            (typeof event.result.details?.focus === 'string' && event.result.details.focus.trim()
              ? event.result.details.focus.trim()
              : undefined) ?? focus;
          const checkpointPath =
            typeof event.result.details?.checkpointPath === 'string' &&
            event.result.details.checkpointPath.trim()
              ? event.result.details.checkpointPath.trim()
              : undefined;
          const prunedCount =
            typeof event.result.details?.prunedCount === 'number' &&
            Number.isFinite(event.result.details.prunedCount) &&
            event.result.details.prunedCount > 0
              ? Math.floor(event.result.details.prunedCount)
              : undefined;
          summaryInfo = {
            id: `compact-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            timestamp: new Date().toISOString(),
            reason,
            tokensBefore,
            tokensAfter,
            summary,
            ...(resolvedFocus ? { focus: resolvedFocus } : {}),
            ...(checkpointPath ? { checkpointPath } : {}),
            ...(prunedCount !== undefined ? { prunedCount } : {}),
          };
        }

        this.lastCompletedCompactionInfo = summaryInfo;

        if (this.isRunningTurn) {
          const compactionMsg: PersistedChatMessage = {
            id: summaryInfo.id,
            role: 'compaction',
            content: summaryInfo.summary,
            timestamp: this.formatTimestamp(summaryInfo.timestamp) || summaryInfo.timestamp,
            compaction: {
              reason: summaryInfo.reason,
              tokensBefore: summaryInfo.tokensBefore,
              tokensAfter: summaryInfo.tokensAfter,
              ...(summaryInfo.focus ? { focus: summaryInfo.focus } : {}),
              ...(summaryInfo.checkpointPath ? { checkpointPath: summaryInfo.checkpointPath } : {}),
            },
          };
          if (!this.activeTurnCommittedMessages.some((m) => m.id === compactionMsg.id)) {
            if (this.activeTurnUserMsgCount === 0) {
              // Pre-prompt compaction in _prepareRun occurs before the active user message in the branch
              const firstUserIdx = this.activeTurnCommittedMessages.findIndex((m) => m.id === 'active-user');
              if (firstUserIdx >= 0) {
                this.activeTurnCommittedMessages.splice(firstUserIdx, 0, compactionMsg);
              } else {
                this.activeTurnCommittedMessages.unshift(compactionMsg);
              }
            } else {
              const snap = this.activeTurnSnapshot;
              if (snap && (snap.thinking || snap.response || snap.tools.length > 0)) {
                const committedAssistant: PersistedChatMessage = {
                  id: `active-a-${++this.activeTurnCommitSeq}`,
                  role: 'assistant',
                  content: snap.response,
                  ...(snap.thinking ? { thinking: snap.thinking } : {}),
                  ...(snap.tools.length > 0 ? { tools: snap.tools.map((t) => ({ ...t })) } : {}),
                  timestamp: new Date().toLocaleTimeString(),
                };
                this.activeTurnCommittedMessages.push(committedAssistant);
                this.emitEvent('turn_segment_commit', { message: committedAssistant });
                snap.thinking = '';
                snap.response = '';
                snap.tools = [];
              }
              this.activeTurnCommittedMessages.push(compactionMsg);
            }
          }
        }

        this.emitEvent('compaction_end', {
          reason,
          status: 'compacted',
          result: summaryInfo,
        });
      } else if (event.aborted || Boolean(errMsg && /compaction cancelled/i.test(errMsg))) {
        this.emitEvent('compaction_end', {
          reason,
          status: 'aborted',
        });
      } else if (isNoop) {
        this.emitEvent('compaction_end', {
          reason,
          status: 'noop',
        });
      } else {
        const safeErr = errMsg
          ? redactSecrets(errMsg, this.getAllKnownSecrets())
          : '上下文压缩失败。';
        this.emitEvent('compaction_end', {
          reason,
          status: 'error',
          error: safeErr,
        });
      }
      this.emitEvent('token_usage', this.getSessionTokenUsage());
    }
  }

  private normalizeChatImagesOrThrow(rawImages: unknown): ChatImageAttachment[] {
    try {
      return validateAndNormalizeImageAttachments(rawImages);
    } catch (err: any) {
      throw new AppError(String(err?.message || err || '图片附件校验失败。'), 400);
    }
  }

  private assertModelSupportsImages(model: any, images: readonly ChatImageAttachment[]): void {
    if (images.length > 0 && model && !modelSupportsImageInput(model)) {
      throw new AppError(
        `当前模型 ${model.provider}/${model.id} 不支持图片输入，请先切换至支持视觉的模型。`,
        400,
        'MODEL_NO_VISION'
      );
    }
  }

  async enqueueMainTurnMessage(
    prompt: string,
    mode: QueuedMessageMode,
    rawImages?: unknown
  ): Promise<{ item: QueuedMessageItem; queue: PendingQueueState }> {
    const images = this.normalizeChatImagesOrThrow(rawImages);
    const trimmed = String(prompt || '').trim();
    if (!trimmed && images.length === 0) {
      throw new AppError('消息内容不能为空。', 400);
    }
    if (!this.isRunningTurn || !this.currentSession) {
      if (this.activeDirectSubagentTaskId) {
        throw new AppError(
          '当前子代理直接对话正在运行，请前往子代理面板插话或停止。',
          409,
          'CONFLICT_DIRECT_SUBAGENT'
        );
      }
      throw new AppError('当前没有运行中的主对话，请直接发送消息。', 409, 'TURN_NOT_RUNNING');
    }
    this.assertModelSupportsImages(this.currentSession?.model, images);
    const effectivePrompt = trimmed || DEFAULT_IMAGE_ONLY_PROMPT;
    const result = await this.mainQueueController.enqueue(this.currentSession, effectivePrompt, mode, images);
    this.emitEvent('turn_queue_updated', result.queue);
    return result;
  }

  async switchMainQueueItemMode(
    itemId: string,
    mode: QueuedMessageMode
  ): Promise<QueueMutationResult> {
    if (!this.isRunningTurn || !this.currentSession) {
      throw new AppError('当前没有运行中的主对话。', 409, 'TURN_NOT_RUNNING');
    }
    const res = await this.mainQueueController.switchItemMode(this.currentSession, itemId, mode);
    this.emitEvent('turn_queue_updated', res.queue);
    return res;
  }

  async removeMainQueueItem(itemId: string): Promise<QueueMutationResult> {
    if (!this.isRunningTurn || !this.currentSession) {
      throw new AppError('当前没有运行中的主对话。', 409, 'TURN_NOT_RUNNING');
    }
    const res = await this.mainQueueController.removeItem(this.currentSession, itemId);
    this.emitEvent('turn_queue_updated', res.queue);
    return res;
  }

  async clearMainQueue(): Promise<{
    cleared: PendingQueueState;
    restoredDraft: RestoredDraftPayload | null;
    queue: PendingQueueState;
  }> {
    if (!this.isRunningTurn || !this.currentSession) {
      return {
        cleared: { steering: [], followUp: [] },
        restoredDraft: null,
        queue: { steering: [], followUp: [] },
      };
    }
    const res = await this.mainQueueController.clearAll(this.currentSession);
    this.emitEvent('turn_queue_updated', res.queue);
    return res;
  }

  async enqueueSubagentMessage(
    taskId: string,
    message: string,
    mode: QueuedMessageMode,
    rawImages?: unknown
  ): Promise<{ taskId: string; threadId: string; item: QueuedMessageItem; queue: PendingQueueState }> {
    const images = this.normalizeChatImagesOrThrow(rawImages);
    const trimmed = String(message || '').trim();
    if (!trimmed && images.length === 0) {
      throw new AppError('消息内容不能为空。', 400);
    }
    try {
      return await this.subagentManager.enqueueTaskMessage(
        this.activeWorkspace,
        taskId,
        trimmed || DEFAULT_IMAGE_ONLY_PROMPT,
        mode,
        images
      );
    } catch (err: any) {
      if (err?.code === 'MODEL_NO_VISION') {
        throw new AppError(String(err.message || err), 400, 'MODEL_NO_VISION');
      }
      throw err;
    }
  }

  async switchSubagentQueueItemMode(
    taskId: string,
    itemId: string,
    mode: QueuedMessageMode
  ): Promise<QueueMutationResult & { taskId: string; threadId: string }> {
    return this.subagentManager.switchTaskQueueItemMode(this.activeWorkspace, taskId, itemId, mode);
  }

  async removeSubagentQueueItem(
    taskId: string,
    itemId: string
  ): Promise<QueueMutationResult & { taskId: string; threadId: string }> {
    return this.subagentManager.removeTaskQueueItem(this.activeWorkspace, taskId, itemId);
  }

  async clearSubagentQueue(taskId: string): Promise<{
    taskId: string;
    threadId: string;
    cleared: PendingQueueState;
    restoredDraft: RestoredDraftPayload | null;
    queue: PendingQueueState;
  }> {
    return this.subagentManager.clearTaskQueue(this.activeWorkspace, taskId);
  }

  async compactMainSession(focus?: string): Promise<CompactSessionResult> {
    const cleanFocus = typeof focus === 'string' && focus.trim() ? focus.trim() : undefined;
    if (this.directSubagentLock || this.activeDirectSubagentTaskId) {
      throw new AppError(
        '当前子代理直接对话正在运行，请先等待完成或前往子代理面板执行 /compact。',
        409,
        'CONFLICT_DIRECT_SUBAGENT'
      );
    }

    if (this.isRunningTurn) {
      this.queuedMainCompaction = cleanFocus ? { focus: cleanFocus } : {};
      this.emitEvent('compaction_queued', {
        queued: true,
        ...(cleanFocus ? { focus: cleanFocus } : {}),
      });
      return {
        ok: true,
        status: 'queued',
        ...(cleanFocus ? { focus: cleanFocus } : {}),
        message: '已排入队尾，将在当前回合完成后自动执行上下文压缩。',
      };
    }

    if (this.turnLock || this.isCompacting) {
      throw new AppError('当前正在执行会话操作或上下文压缩，请稍后再试。', 409, 'CONFLICT');
    }

    this.turnLock = true;
    this.pendingManualCompactionFocus = cleanFocus;
    this.lastCompletedCompactionInfo = null;
    try {
      await this.initSession();
      if (!this.currentSession?.model) {
        throw new AppError('当前尚未选择可用模型，无法执行上下文压缩。', 400);
      }
      this.syncMainCompactionSettings();
      const compactRes = await this.currentSession.compact(cleanFocus);
      const summaryInfo =
        this.lastCompletedCompactionInfo ??
        (() => {
          const branch: any[] = this.sessionManager?.getBranch?.() ?? [];
          for (let i = branch.length - 1; i >= 0; i -= 1) {
            if (branch[i]?.type === 'compaction') {
              const extracted = extractCompactionSummaryInfo(branch[i], compactRes?.estimatedTokensAfter);
              return {
                ...extracted,
                reason: 'manual' as const,
                ...(extracted.focus || cleanFocus ? { focus: extracted.focus ?? cleanFocus } : {}),
              };
            }
          }
          const summary = typeof compactRes?.summary === 'string' ? compactRes.summary : '';
          return {
            id: `compact-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            timestamp: new Date().toISOString(),
            reason: 'manual' as const,
            tokensBefore: typeof compactRes?.tokensBefore === 'number' ? Math.max(0, Math.floor(compactRes.tokensBefore)) : 0,
            tokensAfter:
              typeof compactRes?.estimatedTokensAfter === 'number'
                ? Math.max(0, Math.floor(compactRes.estimatedTokensAfter))
                : Math.ceil(summary.length / 4),
            summary,
            ...(cleanFocus ? { focus: cleanFocus } : {}),
          };
        })();

      if (
        this.sessionMode === 'memory' &&
        this.sessionManager &&
        this.sessionManagerHasMessages(this.sessionManager)
      ) {
        this.commitMemorySessionRecord();
      }
      return {
        ok: true,
        status: 'compacted',
        result: summaryInfo,
        tokenUsage: this.getSessionTokenUsage(),
        ...(cleanFocus ? { focus: cleanFocus } : {}),
      };
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (/nothing to compact|already compacted|session too small/i.test(msg)) {
        return {
          ok: true,
          status: 'noop',
          message: '当前对话较短，暂无可压缩的上下文。',
          tokenUsage: this.getSessionTokenUsage(),
        };
      }
      if (err instanceof AppError) throw err;
      throw new AppError(redactSecrets(msg, this.getAllKnownSecrets()), 500);
    } finally {
      this.pendingManualCompactionFocus = undefined;
      this.lastCompletedCompactionInfo = null;
      this.turnLock = false;
    }
  }

  async compactSubagent(taskId: string, focus?: string): Promise<SubagentCompactResult> {
    try {
      return await this.subagentManager.compactTask(this.activeWorkspace, taskId, focus);
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      const msg = String(err?.message || err || 'Failed to compact subagent session');
      if (msg.startsWith('NOT_FOUND:')) {
        throw new AppError(msg.slice('NOT_FOUND:'.length).trim(), 404, 'NOT_FOUND');
      }
      if (msg.startsWith('CONFLICT:')) {
        throw new AppError(msg.slice('CONFLICT:'.length).trim(), 409, 'CONFLICT');
      }
      if (msg.startsWith('BAD_REQUEST:')) {
        throw new AppError(msg.slice('BAD_REQUEST:'.length).trim(), 400);
      }
      throw err;
    }
  }

  async abortTurnWithResult(): Promise<{ aborted: boolean; restoredDraft: RestoredDraftPayload | null }> {
    if (!this.isRunningTurn || !this.currentSession) {
      if (this.isCompacting && this.currentSession) {
        this.currentSession.abortCompaction?.();
        return { aborted: true, restoredDraft: null };
      }
      return this.abortDirectSubagentTaskWithResult(undefined, '用户已手动中止子代理对话。');
    }
    this.turnAborted = true;
    if (this.queuedMainCompaction) {
      this.queuedMainCompaction = null;
      this.emitEvent('compaction_queued', { queued: false });
    }
    const hadPending =
      this.mainQueueController.hasPending() ||
      ((this.currentSession.getSteeringMessages?.().length ?? 0) +
        (this.currentSession.getFollowUpMessages?.().length ?? 0)) > 0;
    if (!this.activeTurnRestoredDraft && hadPending) {
      this.activeTurnRestoredDraft = this.mainQueueController.clearForRestore(this.currentSession);
    } else {
      try {
        this.currentSession.clearQueue?.();
      } catch {
        // Ignore queue clear error
      }
      this.mainQueueController.reset();
    }
    const restoredDraft = this.activeTurnRestoredDraft;
    if (hadPending || restoredDraft) {
      this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
    }
    this.activeTurnAbortController?.abort();
    this.subagentManager.abortActiveTasks('主会话已手动中止任务。');
    await this.currentSession.abort();
    return { aborted: true, restoredDraft };
  }

  async abortTurn(): Promise<boolean> {
    const res = await this.abortTurnWithResult();
    return res.aborted;
  }

  abortDirectSubagentTaskWithResult(
    taskId?: string,
    reason = '用户已手动中止子代理对话。'
  ): { aborted: boolean; restoredDraft: RestoredDraftPayload | null } {
    const cleanId = taskId?.trim();
    if (cleanId) {
      const subRes = this.subagentManager.abortTaskWithResult(cleanId, reason);
      let aborted = subRes.aborted;
      if (this.activeDirectSubagentTaskId === cleanId) {
        this.activeDirectSubagentAbortController?.abort(reason);
        aborted = true;
      }
      return { aborted, restoredDraft: subRes.restoredDraft };
    }
    if (this.activeDirectSubagentTaskId) {
      const activeId = this.activeDirectSubagentTaskId;
      const subRes = this.subagentManager.abortTaskWithResult(activeId, reason);
      this.activeDirectSubagentAbortController?.abort(reason);
      return { aborted: subRes.aborted || true, restoredDraft: subRes.restoredDraft };
    }
    return { aborted: false, restoredDraft: null };
  }

  abortDirectSubagentTask(taskId?: string, reason = '用户已手动中止子代理对话。'): boolean {
    return this.abortDirectSubagentTaskWithResult(taskId, reason).aborted;
  }

  private async syncDirectSubagentSummaryToMain(params: {
    role: string;
    taskId: string;
    threadId: string;
    priorSessionId: string | null;
    workspace: string;
    userMessage: string;
    status: 'completed' | 'error' | 'aborted';
    replyPreview: string;
    artifacts: string[];
    userSteeredNotes?: SubagentUserSteerNote[];
    error?: string;
  }): Promise<void> {
    if (!this.currentSession?.sendCustomMessage) return;
    if (this.workspaceKey(this.activeWorkspace) !== this.workspaceKey(params.workspace)) return;
    const currentSessionId = this.sessionManager?.getSessionId?.() ?? null;
    if (params.priorSessionId && currentSessionId && params.priorSessionId !== currentSessionId) {
      return;
    }
    const secrets = this.getAllKnownSecrets();
    const compactText = (raw: string, cap: number) => {
      const cleaned = redactSecrets(String(raw || '').replace(/\s+/g, ' ').trim(), secrets);
      return cleaned.length <= cap ? cleaned : `${cleaned.slice(0, cap)}…`;
    };
    const lines = [
      '[子代理直接对话同步 / Direct Subagent Sync]',
      `role=${params.role} threadId=${params.threadId} taskId=${params.taskId} status=${params.status}`,
      `用户直接提问: ${compactText(params.userMessage, 320)}`,
    ];
    if (params.userSteeredNotes && params.userSteeredNotes.length > 0) {
      const steerNotesText = params.userSteeredNotes
        .slice(-4)
        .map((n) => `${n.mode === 'steer' ? '插话' : '排队'}: ${compactText(n.text, 120)}`)
        .join(' | ');
      lines.push(`运行中追加指令(${params.userSteeredNotes.length}): ${compactText(steerNotesText, 320)}`);
    }
    if (params.replyPreview.trim()) {
      lines.push(`子代理回复摘要: ${compactText(params.replyPreview, 800)}`);
    }
    if (params.artifacts.length > 0) {
      lines.push(`相关产物: ${params.artifacts.slice(-8).join(', ')}`);
    }
    if (params.error) {
      lines.push(`状态说明: ${compactText(params.error, 260)}`);
    }
    const summaryText = compactText(lines.join('\n'), 1600);
    try {
      await this.currentSession.sendCustomMessage(
        {
          customType: 'papercup_subagent_direct_sync',
          content: summaryText,
          display: false,
          details: {
            role: params.role,
            taskId: params.taskId,
            threadId: params.threadId,
            status: params.status,
            ...(params.userSteeredNotes && params.userSteeredNotes.length > 0
              ? { userSteerCount: params.userSteeredNotes.length }
              : {}),
          },
        },
        { triggerTurn: false }
      );
    } catch {
      // Non-fatal: direct subagent turn completed even if main session sync injection fails
    }
  }

  async startDirectSubagentMessage(
    taskId: string,
    message: string,
    rawImages?: unknown
  ): Promise<{ taskId: string; threadId: string; status: 'started' }> {
    if (this.isBusy()) {
      throw new AppError('当前主对话或子代理正在运行，请等待完成或先中止后再发送。', 409, 'CONFLICT');
    }
    const images = this.normalizeChatImagesOrThrow(rawImages);
    const trimmedMessage = String(message || '').trim();
    if (!trimmedMessage && images.length === 0) {
      throw new AppError('消息内容不能为空。', 400);
    }
    const effectiveMessage = trimmedMessage || DEFAULT_IMAGE_ONLY_PROMPT;
    const cleanTaskId = taskId.trim();
    const priorSnap = this.subagentManager.getTask(this.activeWorkspace, cleanTaskId);
    if (!priorSnap) {
      throw new AppError(`未找到子代理任务 ${cleanTaskId}`, 404, 'NOT_FOUND');
    }
    if (priorSnap.role === 'translator') {
      throw new AppError('translator 为批量译文工作角色，不支持直接聊天交互。', 400);
    }

    const cwd = this.activeWorkspace;
    this.directSubagentLock = true;
    try {
      await this.initSession();
      if (this.isRunningTurn || this.turnLock || this.activeDirectSubagentTaskId) {
        throw new AppError('当前主对话或子代理正在运行，请等待完成或先中止后再发送。', 409, 'CONFLICT');
      }
      if (this.workspaceKey(this.activeWorkspace) !== this.workspaceKey(cwd)) {
        throw new AppError('工作区已切换，请重新打开子代理会话。', 409, 'CONFLICT');
      }
      this.assertModelSupportsImages(this.currentSession?.model, images);

      const safeRoleSlug = priorSnap.role.replace(/[^A-Za-z0-9_-]+/g, '_') || 'subagent';
      const nextTaskId = `subtask-${safeRoleSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const threadId = priorSnap.threadId || priorSnap.taskId;
      const sessionId = this.sessionManager?.getSessionId?.() ?? priorSnap.sessionId ?? null;
      const controller = new AbortController();

      this.activeDirectSubagentTaskId = nextTaskId;
      this.activeDirectSubagentAbortController = controller;
      this.emitEvent('sync_state', this.getTurnSyncState());

      void (async () => {
        try {
          const result = await this.subagentManager.runSubagentWithMetrics(priorSnap.role, effectiveMessage, {
            cwd,
            signal: controller.signal,
            model: this.currentSession?.model,
            modelRuntime: this.currentSession?.modelRuntime,
            getKnownSecrets: () => this.getAllKnownSecrets(),
            sessionId,
            taskId: nextTaskId,
            resumeTaskId: priorSnap.taskId,
            origin: 'direct_user',
            ...(images.length > 0 ? { images } : {}),
            recordDiagnostics: this.sessionMode === 'persist',
            onStreamDelta: (ev) => this.emitEvent('subagent_stream_delta', ev),
          });
          await this.syncDirectSubagentSummaryToMain({
            role: priorSnap.role,
            taskId: result.taskId,
            threadId: result.snapshot.threadId || threadId,
            priorSessionId: sessionId,
            workspace: cwd,
            userMessage: effectiveMessage,
            status: 'completed',
            replyPreview: result.text || result.snapshot.responsePreview || '',
            artifacts: result.snapshot.artifacts ?? [],
            userSteeredNotes: result.userSteeredNotes,
          });
        } catch (err: any) {
          const errSnap = (err?.snapshot as SubagentTaskSnapshot | undefined) ?? this.subagentManager.getTask(cwd, nextTaskId);
          const errStatus: 'error' | 'aborted' = err?.metrics?.status === 'aborted' || errSnap?.status === 'aborted' ? 'aborted' : 'error';
          await this.syncDirectSubagentSummaryToMain({
            role: priorSnap.role,
            taskId: nextTaskId,
            threadId: errSnap?.threadId || threadId,
            priorSessionId: sessionId,
            workspace: cwd,
            userMessage: effectiveMessage,
            status: errStatus,
            replyPreview: errSnap?.responsePreview || '',
            artifacts: errSnap?.artifacts ?? [],
            userSteeredNotes: Array.isArray(err?.userSteeredNotes) ? err.userSteeredNotes : undefined,
            error: String(err?.message || errSnap?.error || err),
          });
        } finally {
          if (this.activeDirectSubagentTaskId === nextTaskId) {
            this.activeDirectSubagentTaskId = null;
            this.activeDirectSubagentAbortController = null;
          }
          this.invalidateEngineeringStatusCache(cwd);
          this.emitEvent('token_usage', this.getSessionTokenUsage());
          this.emitEvent('sync_state', this.getTurnSyncState());
        }
      })();

      return {
        taskId: nextTaskId,
        threadId,
        status: 'started',
      };
    } finally {
      this.directSubagentLock = false;
    }
  }

  private detectInterruptedTurnTail(rawMessages: readonly any[]): { tailStartMs: number; tailSignature: string } | null {
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null;

    const toolResultIds = new Set<string>();
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const msg = rawMessages[i];
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string' && msg.toolCallId) {
        toolResultIds.add(msg.toolCallId);
      }
      if (msg.role === 'assistant' && msg.stopReason === 'stop') {
        break;
      }
    }

    let hasAbnormalTail = false;
    let earliestUserMs = Number.POSITIVE_INFINITY;
    let earliestAnyMs = Number.POSITIVE_INFINITY;

    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const msg = rawMessages[i];
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'custom' && msg.customType === 'papercup_interruption_context') {
        return null;
      }
      if (msg.role === 'assistant' && msg.stopReason === 'stop') {
        break;
      }
      const ts = typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp) ? msg.timestamp : 0;
      if (ts > 0) earliestAnyMs = Math.min(earliestAnyMs, ts);
      if (msg.role === 'user' && ts > 0) {
        earliestUserMs = Math.min(earliestUserMs, ts);
      }
      if (msg.role === 'assistant') {
        if (msg.stopReason === 'aborted' || msg.stopReason === 'error') {
          hasAbnormalTail = true;
        }
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block?.type === 'toolCall' && typeof block.id === 'string' && !toolResultIds.has(block.id)) {
            hasAbnormalTail = true;
          }
        }
      } else if (msg.role === 'toolResult' && msg.isError === true) {
        const d = msg.details;
        if (d?.interrupted === true || d?.status === 'aborted' || d?.status === 'interrupted') {
          hasAbnormalTail = true;
        }
      }
    }

    if (!hasAbnormalTail) return null;
    const tailStartMs = Number.isFinite(earliestUserMs)
      ? earliestUserMs
      : Number.isFinite(earliestAnyMs)
        ? earliestAnyMs
        : 0;
    const last = rawMessages[rawMessages.length - 1];
    return {
      tailStartMs,
      tailSignature: `${rawMessages.length}:${last?.timestamp ?? 0}:${last?.role ?? ''}`,
    };
  }

  private buildInterruptionRecoveryNote(sessionId: string | null, tailStartMs: number): string | null {
    const lines: string[] = [];

    if (sessionId) {
      const recentFailed = this.subagentManager
        .listTasks(this.activeWorkspace, sessionId)
        .filter((t) => {
          if (t.status !== 'aborted' && t.status !== 'error') return false;
          const actMs = Date.parse(t.endedAt || t.lastActivityAt || t.startedAt);
          return !tailStartMs || Number.isNaN(actMs) || actMs >= tailStartMs - 1000;
        })
        .slice(0, 4);

      for (const task of recentFailed) {
        const detail = this.subagentManager.getTask(this.activeWorkspace, task.taskId);
        const artifacts = (detail?.artifacts ?? []).slice(0, 6);
        const reason = redactSecrets(String(task.error || task.status), this.getAllKnownSecrets()).slice(0, 140);
        const parts = [
          `subagent=${task.role}`,
          `status=${task.status}`,
          ...(task.interruptKind ? [`kind=${task.interruptKind}`] : []),
          `stage=${task.stage}`,
          `taskId=${task.taskId}`,
        ];
        if (task.lastProgressSummary) parts.push(`progress="${task.lastProgressSummary}"`);
        if (artifacts.length > 0) parts.push(`artifacts=[${artifacts.join(', ')}]`);
        if (reason) parts.push(`reason="${reason}"`);
        lines.push(`- ${parts.join(' ')}`);
      }
    }

    const postQaDoc = this.readWorkspaceJson(WORKSPACE_POST_QA_REPORT_REL);
    if (
      postQaDoc &&
      (postQaDoc.interrupted ||
        Number(postQaDoc.roleCheckerPendingChunks || 0) > 0 ||
        Number(postQaDoc.roleCheckerErrors || 0) > 0)
    ) {
      const reviewed = Number(postQaDoc.roleCheckerChunksReviewed || 0);
      const pending = Number(postQaDoc.roleCheckerPendingChunks || 0);
      const total = Number(postQaDoc.roleCheckerChunksTotal ?? reviewed + pending);
      const errs = Number(postQaDoc.roleCheckerErrors || 0);
      const kind = postQaDoc.interruptKind ? ` kind=${postQaDoc.interruptKind}` : '';
      lines.push(
        `- post_qa: status=${postQaDoc.interrupted ? 'interrupted' : 'partial'}${kind} reviewed=${reviewed}/${total} pending=${pending} errors=${errs} state=${WORKSPACE_POST_QA_STATE_REL} -> 直接调用 vn_post_qa_parallel 续检剩余分片，严禁传 skipRoleChecker=true 或手动替代 role-checker`
      );
    }

    const progressDoc = this.readWorkspaceJson(WORKSPACE_PROGRESS_REL);
    const summary = progressDoc?.summary;
    const totalBatches = Number(summary?.total_batches || 0);
    const pendingBatches = Number(summary?.pending_batches || 0);
    const qaFailed = Number(summary?.qa_failed || 0);
    if (totalBatches > 0 && (pendingBatches > 0 || qaFailed > 0)) {
      const done = Number(summary?.saved_pending_qa || 0) + Number(summary?.qa_passed || 0);
      lines.push(
        `- translate_batches: saved=${done}/${totalBatches} pending=${pendingBatches} qa_failed=${qaFailed} -> 直接调用 vn_translate_batches 续译未完成/失败批次`
      );
    }

    if (lines.length === 0) return null;
    return [
      '[系统中断恢复上下文 / Interruption Recovery Context]',
      '检测到上一回合发生异常中断或错误，以下是磁盘已持久化检查点与子 Agent 状态：',
      ...lines,
      '请直接基于以上已落盘状态继续未完成环节，避免在主会话重复扫描或跳过未完成的子 Agent 步骤。',
    ].join('\n');
  }

  private async injectInterruptionRecoveryIfNeeded(rawBefore: readonly any[]): Promise<void> {
    if (!this.currentSession?.sendCustomMessage) return;
    const tail = this.detectInterruptedTurnTail(rawBefore);
    if (!tail) return;
    const sessionId = this.sessionManager?.getSessionId?.() ?? null;
    const noteText = this.buildInterruptionRecoveryNote(sessionId, tail.tailStartMs);
    if (!noteText) return;
    await this.currentSession.sendCustomMessage(
      {
        customType: 'papercup_interruption_context',
        content: noteText,
        display: false,
        details: { tailSignature: tail.tailSignature },
      },
      { triggerTurn: false }
    );
  }

  /**
   * 同步上锁并完成前置选模校验后在后台启动主回合（供 POST /api/turns/start 使用，彻底消除异步 TOCTOU 窗口，
   * 同时保留无效 model 参数同步返回 400 的 HTTP 契约）。
   */
  async startTurn(prompt: string, options?: { model?: string; images?: unknown }): Promise<void> {
    if (this.isRunningTurn || this.turnLock) {
      throw new AppError('A turn is already in progress.', 409);
    }
    if (this.directSubagentLock || this.activeDirectSubagentTaskId) {
      throw new AppError('A direct subagent conversation turn is already in progress.', 409);
    }
    const normalizedImages = this.normalizeChatImagesOrThrow(options?.images);
    const rawPrompt = typeof prompt === 'string' ? prompt : '';
    if (!rawPrompt.trim() && normalizedImages.length === 0) {
      throw new AppError('Missing prompt', 400);
    }
    const effectivePrompt = rawPrompt.trim() ? rawPrompt : DEFAULT_IMAGE_ONLY_PROMPT;
    this.turnLock = true;
    const requestedModel = options?.model?.trim();
    try {
      await this.initSession();
      if (requestedModel && !this.isSameModelRef(this.currentSession?.model, requestedModel)) {
        await this.selectModelInternal(requestedModel);
      }
      this.assertModelSupportsImages(this.currentSession?.model, normalizedImages);
    } catch (err) {
      this.turnLock = false;
      throw err;
    }

    this.runLockedTurn(effectivePrompt, {
      model: requestedModel,
      images: normalizedImages,
      modelPrevalidated: true,
    }).catch((err) => {
      console.error('Turn execution error:', err);
    });
  }

  async executeTurn(prompt: string, options?: { model?: string; images?: unknown }): Promise<void> {
    if (this.isRunningTurn || this.turnLock) {
      throw new AppError('A turn is already in progress.', 409);
    }
    if (this.directSubagentLock || this.activeDirectSubagentTaskId) {
      throw new AppError('A direct subagent conversation turn is already in progress.', 409);
    }
    const normalizedImages = this.normalizeChatImagesOrThrow(options?.images);
    const rawPrompt = typeof prompt === 'string' ? prompt : '';
    if (!rawPrompt.trim() && normalizedImages.length === 0) {
      throw new AppError('Missing prompt', 400);
    }
    const effectivePrompt = rawPrompt.trim() ? rawPrompt : DEFAULT_IMAGE_ONLY_PROMPT;
    this.turnLock = true;
    return this.runLockedTurn(effectivePrompt, {
      model: options?.model?.trim(),
      images: normalizedImages,
      modelPrevalidated: false,
    });
  }

  private async runLockedTurn(
    prompt: string,
    options: { model?: string; images?: ChatImageAttachment[]; modelPrevalidated?: boolean }
  ): Promise<void> {
    const turnStartedAt = performance.now();
    const requestedModel = options.model?.trim();
    const normalizedImages = Array.isArray(options.images) ? options.images : [];
    try {
      await this.initSession();
      if (typeof this.currentSession?.setAutoRetryEnabled === 'function') {
        this.currentSession.setAutoRetryEnabled(true);
      }
      if (this.pendingSkillReload && this.currentSession?.reload) {
        await this.currentSession.reload();
        this.pendingSkillReload = false;
      }
      if (
        !options.modelPrevalidated &&
        requestedModel &&
        !this.isSameModelRef(this.currentSession?.model, requestedModel)
      ) {
        await this.selectModelInternal(requestedModel);
      }
      if (!options.modelPrevalidated) {
        this.assertModelSupportsImages(this.currentSession?.model, normalizedImages);
      }

      const branchBefore = this.sessionManager?.getBranch?.();
      const rawBefore = this.sessionManager?.buildSessionContext?.().messages ?? [];
      await this.injectInterruptionRecoveryIfNeeded(rawBefore);
      this.turnBaseMessageCount = Array.isArray(branchBefore)
        ? this.projectMessages(branchBefore, {
            markUnresolvedToolsInterrupted: true,
            sessionId: this.sessionManager?.getSessionId?.() ?? null,
            sessionEntries: this.sessionManager?.getEntries?.() ?? [],
            fromBranchEntries: true,
          }).length
        : this.projectMessages(rawBefore, {
            markUnresolvedToolsInterrupted: true,
            sessionId: this.sessionManager?.getSessionId?.() ?? null,
            sessionEntries: this.sessionManager?.getEntries?.() ?? [],
          }).length;
      this.activeTurnAbortController = new AbortController();
      this.activeTurnPrompt = prompt;
      this.activeTurnImages = normalizedImages.map((img) => ({ ...img }));
      this.activeTurnStartedAtLabel = new Date().toLocaleTimeString();
      this.mainQueueController.reset();
      try {
        this.currentSession?.clearQueue?.();
      } catch {
        // Ignore pre-turn queue cleanup error
      }
      applyPaperCupQueueModes(undefined, this.currentSession);
      this.activeTurnCommittedMessages = [
        {
          id: 'active-user',
          role: 'user',
          content: prompt,
          ...(this.activeTurnImages.length > 0
            ? { images: this.activeTurnImages.map((img) => ({ ...img })) }
            : {}),
          timestamp: this.activeTurnStartedAtLabel,
        },
      ];
      this.activeTurnUserMsgCount = 0;
      this.activeTurnCommitSeq = 0;
      this.activeTurnRestoredDraft = null;

      const activeModel = this.currentSession?.model;
      const activeModelKey = activeModel ? `${activeModel.provider}/${activeModel.id}` : requestedModel;
      this.activeTurnSnapshot = {
        sessionId: this.sessionManager?.getSessionId?.() ?? null,
        model: activeModelKey || null,
        isThinking: false,
        phase: 'connecting',
        thinking: '',
        response: '',
        tools: [],
        startedAt: new Date().toISOString(),
      };

      this.isRunningTurn = true;
      this.turnAborted = false;
      this.lastTurnError = undefined;
      this.turnOverflowCompactionAttempted = false;
      this.turnUsageStartEntryIndex = this.sessionManager?.getEntries?.().length ?? 0;
      this.inFlightMainStreamText = '';
      this.lastLiveUsageEmitMs = 0;

      this.emitEvent('token_usage', this.getSessionTokenUsage());
      this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
      this.emitEvent('turn_started', {
        prompt,
        model: activeModelKey,
        ...(normalizedImages.length > 0 ? { imageCount: normalizedImages.length } : {}),
      });

      const promptCalledAt = performance.now();
      this.turnTiming = {
        startedAt: turnStartedAt,
        promptCalledAt,
        firstTokenAt: null,
        retries: 0,
        modelKey: activeModelKey || 'unknown',
      };
    } catch (preflightErr) {
      this.turnLock = false;
      this.isRunningTurn = false;
      this.activeTurnAbortController = null;
      this.activeTurnSnapshot = null;
      this.activeTurnImages = [];
      throw preflightErr;
    }

    let turnErrored = false;
    try {
      await this.currentSession.prompt(
        prompt,
        normalizedImages.length > 0 ? { images: toPiImageContents(normalizedImages) } : undefined
      );

      // Bounded single-shot overflow recovery for Chinese / custom-gateway overflow messages
      // that Pi SDK's built-in isContextOverflow did not recognize.
      if (
        !this.turnAborted &&
        this.lastTurnError &&
        isPaperCupContextOverflow(this.lastTurnError) &&
        !this.turnOverflowCompactionAttempted
      ) {
        this.turnOverflowCompactionAttempted = true;
        const branchEntries: any[] = this.sessionManager?.getBranch?.() ?? [];
        let failedAssistantEntryId: string | null = null;
        for (let i = branchEntries.length - 1; i >= 0; i -= 1) {
          const ent = branchEntries[i];
          if (ent?.type === 'message' && ent.message?.role === 'assistant' && ent.message?.stopReason === 'error') {
            failedAssistantEntryId = ent.id;
            break;
          }
        }
        if (failedAssistantEntryId && typeof this.sessionManager?.appendContextEdit === 'function') {
          try {
            this.sessionManager.appendContextEdit(failedAssistantEntryId, null);
            this.currentSession?.refreshContext?.();
          } catch {
            // Best-effort omission before overflow compaction
          }
        }
        let recoveredViaCompact = false;
        this.pendingCompactionReasonOverride = 'overflow';
        try {
          await this.currentSession.compact();
          recoveredViaCompact = true;
        } catch {
          // If compaction cannot run (e.g. session too small or provider error), keep original error.
        } finally {
          this.pendingCompactionReasonOverride = undefined;
        }
        if (recoveredViaCompact && !this.turnAborted) {
          this.lastTurnError = undefined;
          if (this.activeTurnSnapshot) {
            this.activeTurnSnapshot.phase = 'connecting';
            this.activeTurnSnapshot.isThinking = false;
            this.activeTurnSnapshot.thinking = '';
            this.activeTurnSnapshot.response = '';
          }
          const curMsgs: any[] = this.currentSession?.messages ?? this.currentSession?.agent?.state?.messages ?? [];
          const tailMsg = curMsgs[curMsgs.length - 1];
          if (typeof this.currentSession?.agent?.continue === 'function' && tailMsg?.role !== 'assistant') {
            await this.currentSession.agent.continue();
          } else {
            await this.currentSession.prompt('请基于上述压缩后的上下文继续完成刚才未完成的任务。');
          }
        }
      }

      if (!this.turnAborted && this.lastTurnError) {
        turnErrored = true;
        if (!this.activeTurnRestoredDraft) {
          this.activeTurnRestoredDraft = this.mainQueueController.clearForRestore(this.currentSession);
        }
        this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
        this.emitEvent('turn_error', {
          message: this.lastTurnError,
          ...(this.activeTurnRestoredDraft ? { restoredDraft: this.activeTurnRestoredDraft } : {}),
        });
      } else if (!this.turnAborted && !this.lastTurnError && this.queuedMainCompaction) {
        const queued = this.queuedMainCompaction;
        this.queuedMainCompaction = null;
        this.emitEvent('compaction_queued', { queued: false });
        this.pendingManualCompactionFocus = queued.focus;
        try {
          await this.currentSession.compact(queued.focus);
        } catch {
          // Non-fatal: noop or failed post-turn compaction is already reported via compaction_end SSE
        } finally {
          this.pendingManualCompactionFocus = undefined;
        }
      }
    } catch (error: any) {
      turnErrored = true;
      if (!this.activeTurnRestoredDraft) {
        this.activeTurnRestoredDraft = this.mainQueueController.clearForRestore(this.currentSession);
      }
      this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
      const safeErrorMsg = redactSecrets(String(error?.message || error), this.getAllKnownSecrets());
      this.emitEvent('turn_error', {
        message: safeErrorMsg,
        ...(this.activeTurnRestoredDraft ? { restoredDraft: this.activeTurnRestoredDraft } : {}),
      });
      throw error;
    } finally {
      const finishedAt = performance.now();
      const timing = this.turnTiming;
      this.turnTiming = null;
      if (timing) {
        const preflightMs = Math.round(timing.promptCalledAt - timing.startedAt);
        const ttftMs =
          timing.firstTokenAt !== null ? Math.round(timing.firstTokenAt - timing.promptCalledAt) : null;
        const totalMs = Math.round(finishedAt - timing.startedAt);
        console.log(
          `[Paper Cup] Turn timing: model=${timing.modelKey} preflight=${preflightMs}ms ttft=${ttftMs !== null ? `${ttftMs}ms` : 'n/a'} total=${totalMs}ms retries=${timing.retries}`
        );
      }

      const status = this.turnAborted ? 'aborted' : 'completed';
      const hadResidualQueue =
        this.mainQueueController.hasPending() ||
        ((this.currentSession?.getSteeringMessages?.().length ?? 0) +
          (this.currentSession?.getFollowUpMessages?.().length ?? 0)) > 0;
      if ((this.turnAborted || turnErrored) && !this.activeTurnRestoredDraft && hadResidualQueue) {
        this.activeTurnRestoredDraft = this.mainQueueController.clearForRestore(this.currentSession);
      } else {
        try {
          this.currentSession?.clearQueue?.();
        } catch {
          // Ignore post-turn queue cleanup error
        }
        this.mainQueueController.reset();
      }
      const restoredDraftForFinish = this.activeTurnRestoredDraft;
      if (this.queuedMainCompaction) {
        this.queuedMainCompaction = null;
        this.emitEvent('compaction_queued', { queued: false });
      }
      this.isRunningTurn = false;
      this.turnLock = false;
      this.turnAborted = false;
      this.lastTurnError = undefined;
      this.turnOverflowCompactionAttempted = false;
      this.activeTurnAbortController = null;
      this.activeTurnSnapshot = null;
      this.activeTurnPrompt = '';
      this.activeTurnImages = [];
      this.activeTurnStartedAtLabel = '';
      this.turnBaseMessageCount = 0;
      this.activeTurnCommittedMessages = [];
      this.activeTurnUserMsgCount = 0;
      this.activeTurnCommitSeq = 0;
      this.activeTurnRestoredDraft = null;
      this.inFlightMainStreamText = '';
      this.lastLiveUsageEmitMs = 0;
      this.invalidateEngineeringStatusCache();
      if (
        this.sessionMode === 'memory' &&
        this.sessionManager &&
        this.sessionManagerHasMessages(this.sessionManager)
      ) {
        this.commitMemorySessionRecord();
      }
      if (hadResidualQueue || restoredDraftForFinish) {
        this.emitEvent('turn_queue_updated', this.mainQueueController.getState());
      }
      this.emitEvent('token_usage', this.getSessionTokenUsage());
      this.emitEvent('turn_finished', {
        status,
        ...(restoredDraftForFinish ? { restoredDraft: restoredDraftForFinish } : {}),
      });
      try {
        const sessions = await this.listWorkspaceSessions();
        this.emitEvent('sessions_updated', {
          sessionId: this.sessionManager?.getSessionId?.() ?? null,
          sessions,
        });
      } catch {
        // Ignore non-fatal session summary refresh failure
      }
    }
  }

  emitEvent(type: string, data: any): void {
    const envelope: AgentEvent = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emit('agent_event', envelope);
  }
}
