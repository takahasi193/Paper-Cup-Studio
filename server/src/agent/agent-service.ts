import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  loadSkills,
} from '@earendil-works/pi-coding-agent';
import { createVnTools } from './vn-tools.js';
import {
  classifySubagentError,
  SubagentManager,
  type SubagentTaskSnapshot,
  type SubagentTaskSummary,
} from '../subagents/subagent-manager.js';
import { detectVnEngines, getVnStatus } from '../vn/core.js';
import { realpathSafe } from '../vn/profile.js';
import { PAPERCUP_SYSTEM_PROMPT } from './prompt.js';
import {
  pickFolderNative,
  type FolderPickerFn,
  type FolderPickResult,
} from './folder-picker.js';
import {
  discoverProviderAndModels,
  isSupportedLiveChatModel,
  type DetectionMethod,
  type DiscoveredLiveModel,
  type ProviderProbeFetch,
} from './provider-discovery.js';
import { WorkspaceManager, WorkspaceRegistry } from './workspace-manager.js';
import { config, resolvePapercupConfigDir } from '../config.js';
import { createGuardedBuiltinToolDefinitions } from '../security/guarded-tools.js';
import { redactSecrets, redactUnknownValue } from '../security/secrets.js';

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
}

export type ProviderAuthSource = 'runtime' | 'stored' | 'environment' | null;

export interface ProviderStatusInfo {
  id: string;
  name: string;
  envVar?: string;
  configured: boolean;
  source: ProviderAuthSource;
  modelCount: number;
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

type CustomOpenAIProviderId = 'modelscope' | 'volcengine' | 'siliconflow';

interface CustomOpenAIPreset {
  id: string;
  name: string;
  reasoning?: boolean;
}

interface CustomOpenAIProviderSpec {
  id: CustomOpenAIProviderId;
  name: string;
  envVar: string;
  baseUrl: string;
  catalogUrl: string;
  thinkingFormat: 'qwen' | 'deepseek';
  resolveApiKeyRef: () => string;
  inferReasoning: (id: string) => boolean;
  requiresMandatoryThinking?: (id: string) => boolean;
  requiresReasoningContent: (id: string) => boolean;
  filterLiveModel: (id: string, entry: any) => boolean;
  presets: readonly CustomOpenAIPreset[];
}

const MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.cn/v1';
const VOLCENGINE_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

const NON_CHAT_LIVE_MODEL_RE = /(?:seedream|seedance|embedding|embed|rerank|whisper|tts|asr|audio|speech|video|image-edit|text-to-image|image-to-image|stable-diffusion|flux|kolors|cosyvoice|fish-speech|sensevoice|wan2|cogvideo|hunyuanvideo|t2i|i2v|t2v)/i;

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
    requiresReasoningContent: (id) => id.toLowerCase().includes('deepseek'),
    filterLiveModel: (id) => !/image-edit/i.test(id),
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
    requiresMandatoryThinking: (id) =>
      /(?:deepseek-r1|kimi-k2-thinking)/i.test(id),
    requiresReasoningContent: (id) => {
      const lower = id.toLowerCase();
      return lower.includes('deepseek') || lower.includes('doubao-seed') || lower.includes('kimi') || lower.includes('glm');
    },
    filterLiveModel: (id, entry) => {
      if (NON_CHAT_LIVE_MODEL_RE.test(id)) return false;
      const domain = typeof entry?.domain === 'string' ? entry.domain : '';
      const taskType = typeof entry?.task_type === 'string' ? entry.task_type : '';
      if (domain && NON_CHAT_LIVE_MODEL_RE.test(domain)) return false;
      if (taskType && NON_CHAT_LIVE_MODEL_RE.test(taskType)) return false;
      return true;
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
    requiresReasoningContent: (id) => id.toLowerCase().includes('deepseek'),
    filterLiveModel: (id, entry) => {
      if (NON_CHAT_LIVE_MODEL_RE.test(id)) return false;
      const subType = typeof entry?.sub_type === 'string' ? entry.sub_type.toLowerCase() : '';
      if (subType && subType !== 'chat') return false;
      return true;
    },
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
};

const CUSTOM_OPENAI_PROVIDER_LIST: readonly CustomOpenAIProviderSpec[] = Object.values(CUSTOM_OPENAI_PROVIDERS);

function isCustomOpenAIProviderId(providerId: string): providerId is CustomOpenAIProviderId {
  return Object.hasOwn(CUSTOM_OPENAI_PROVIDERS, providerId);
}

function buildCustomOpenAIModelDefinition(
  spec: CustomOpenAIProviderSpec,
  id: string,
  name?: string,
  reasoningOverride?: boolean
) {
  const reasoning = reasoningOverride ?? spec.inferReasoning(id);
  const mandatoryThinking = reasoning && Boolean(spec.requiresMandatoryThinking?.(id));
  return {
    id,
    name: name ?? id,
    type: 'chat' as const,
    api: 'openai-completions' as const,
    provider: spec.id,
    baseUrl: spec.baseUrl,
    reasoning,
    ...(mandatoryThinking ? { thinkingLevelMap: { off: null } } : {}),
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsLongCacheRetention: false,
      requiresReasoningContentOnAssistantMessages: reasoning && spec.requiresReasoningContent(id),
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
  { id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY' },
  { id: 'moonshotai', name: 'Moonshot (Kimi)', envVar: 'MOONSHOT_API_KEY' },
  { id: 'minimax', name: 'MiniMax', envVar: 'MINIMAX_API_KEY' },
];

export type SessionMode = 'persist' | 'memory';
export type TurnPhase = 'connecting' | 'retrying' | 'thinking' | 'tool' | 'generating';

export interface AgentServiceOptions {
  sessionMode?: SessionMode;
  folderPicker?: FolderPickerFn;
  probeFetch?: ProviderProbeFetch;
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
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: PersistedToolCall[];
  timestamp: string;
  error?: boolean;
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

export interface TurnSyncState {
  isRunning: boolean;
  sessionId: string | null;
  activeTurn: ActiveTurnSnapshot | null;
  subagentTasks: SubagentTaskSummary[];
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
  activeTurn: ActiveTurnSnapshot | null;
  subagentTasks: SubagentTaskSummary[];
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
  private probeFetch?: ProviderProbeFetch;
  private pickFolderInFlight: Promise<FolderPickResult> | null = null;
  private currentSession: any = null;
  private initSessionPromise: Promise<void> | null = null;
  private sessionEpoch = 0;
  private sessionManager: SessionManager | null = null;
  private sharedModelRuntime: any = null;
  private sharedModelRuntimePromise: Promise<any> | null = null;
  private customProvidersInitialized = false;
  private resourceLoader: DefaultResourceLoader | null = null;
  private subagentManager = new SubagentManager();
  private isRunningTurn = false;
  private turnAborted = false;
  private activeTurnAbortController: AbortController | null = null;
  private activeTurnSnapshot: ActiveTurnSnapshot | null = null;
  private activeTurnPrompt = '';
  private activeTurnStartedAtLabel = '';
  private turnBaseMessageCount = 0;
  private turnTiming: {
    startedAt: number;
    promptCalledAt: number;
    firstTokenAt: number | null;
    retries: number;
    modelKey: string;
  } | null = null;
  private pendingSkillReload = false;
  private preferredModelKey: string | null = null;
  private preferredThinkingLevel: ThinkingLevel | null = null;
  private runtimeApiKeys = new Map<string, string>();
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
    if (this.currentSession) {
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
    return this.isRunningTurn;
  }

  private collectSkillPaths(): string[] {
    const globalConfigDir = this.resolveGlobalConfigDir();
    return [
      path.join(this.activeWorkspace, '.papercup', 'skills'),
      path.join(globalConfigDir, 'skills'),
    ].filter((dir) => fs.existsSync(dir));
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
    for (const root of this.collectSkillPaths()) {
      try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (
            entry.isDirectory() &&
            entry.name.startsWith('engine-') &&
            fs.existsSync(path.join(root, entry.name, 'SKILL.md'))
          ) {
            names.add(entry.name);
          }
        }
      } catch {
        // Ignore unreadable skill directories
      }
    }
    return Array.from(names).sort();
  }

  constructor(initialWorkspace?: string, options?: AgentServiceOptions) {
    super();
    this.sessionMode = options?.sessionMode ?? 'persist';
    this.folderPicker = options?.folderPicker ?? pickFolderNative;
    this.probeFetch = options?.probeFetch;
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

  private installSessionRedaction(manager: SessionManager): void {
    if (this.wrappedSessionManagers.has(manager)) {
      return;
    }
    this.wrappedSessionManagers.add(manager);
    const origAppend = manager.appendMessage.bind(manager);
    manager.appendMessage = ((message: any) => {
      const sanitized = redactUnknownValue(message, this.runtimeApiKeys.values());
      return origAppend(sanitized);
    }) as typeof manager.appendMessage;
  }

  private projectMessages(
    rawMessages: readonly any[],
    options?: { markUnresolvedToolsInterrupted?: boolean }
  ): PersistedChatMessage[] {
    const markInterrupted = options?.markUnresolvedToolsInterrupted ?? true;
    const projected: PersistedChatMessage[] = [];
    let activeAssistant: PersistedChatMessage | null = null;
    const toolByCallId = new Map<string, PersistedToolCall>();
    let seq = 0;

    const flushAssistant = () => {
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
        } else {
          activeAssistant.content = '已完成任务。';
        }
      }
      projected.push(activeAssistant);
      activeAssistant = null;
      toolByCallId.clear();
    };

    for (const msg of rawMessages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'user') {
        flushAssistant();
        const text = this.extractText(msg.content);
        if (!text.trim()) continue;
        projected.push({
          id: `hist-${++seq}`,
          role: 'user',
          content: text,
          timestamp: this.formatTimestamp(msg.timestamp),
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
    flushAssistant();
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
    const rawMsgs = manager.buildSessionContext?.().messages ?? [];
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
          firstUserText = this.extractText(msg.content);
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
        messageCount++;
        const msg = entry.message;
        if (!msg || typeof msg !== 'object') continue;
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
          const text = this.extractText(msg.content);
          if (text) {
            firstMessage = text;
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

  async listSessionsForWorkspace(workspacePath: string): Promise<SessionSummary[]> {
    if (this.sessionMode === 'memory') {
      const map = this.getWorkspaceMemoryMap(workspacePath);
      return Array.from(map.values())
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.seq - a.seq)
        .map((rec) => this.summarizeSessionManager(rec.manager, rec.updatedAtMs));
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
      if (meta && meta.cwdMatches) {
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
      summaries.unshift(this.summarizeSessionManager(this.sessionManager));
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
      sessionId,
      activeTurn,
      subagentTasks: this.listSubagentTasks(sessionId, SUBAGENT_TASKS_HISTORY_LIMIT),
    };
  }

  async getSessionHistory(): Promise<SessionHistoryState> {
    await this.initSession();
    const sessionId = this.sessionManager?.getSessionId?.() ?? null;
    const raw = this.sessionManager?.buildSessionContext?.().messages ?? [];
    const projected = this.projectMessages(raw, {
      markUnresolvedToolsInterrupted: true,
    });
    const isActiveRunning = Boolean(
      this.isRunningTurn && this.activeTurnSnapshot && this.activeTurnSnapshot.sessionId === sessionId
    );
    const messages = isActiveRunning
      ? [
          ...projected.slice(0, this.turnBaseMessageCount),
          {
            id: 'active-user',
            role: 'user' as const,
            content: this.activeTurnPrompt,
            timestamp: this.activeTurnStartedAtLabel,
          },
        ]
      : projected;
    return {
      sessionId,
      persisted: this.sessionMode === 'persist',
      workspace: this.activeWorkspace,
      messages,
      sessions: await this.listWorkspaceSessions(),
      isRunning: this.isRunningTurn,
      activeTurn: isActiveRunning
        ? {
            ...this.activeTurnSnapshot!,
            tools: this.activeTurnSnapshot!.tools.map((t) => ({ ...t })),
          }
        : null,
      subagentTasks: this.listSubagentTasks(sessionId, SUBAGENT_TASKS_HISTORY_LIMIT),
    };
  }

  async createNewSession(): Promise<SessionHistoryState> {
    if (this.isRunningTurn) {
      throw new Error('Cannot start a new session while a turn is in progress.');
    }
    this.disposeCurrentSessionState(true);
    if (this.sessionMode === 'memory') {
      const fresh = SessionManager.inMemory(this.activeWorkspace);
      this.getWorkspaceMemoryMap().set(fresh.getSessionId(), {
        manager: fresh,
        updatedAtMs: Date.now(),
        seq: ++this.memorySeq,
      });
      this.sessionManager = fresh;
    } else {
      const sessionDir = this.resolveSessionDir(this.activeWorkspace);
      const fresh = SessionManager.create(this.activeWorkspace, sessionDir);
      const sessionFile = fresh.getSessionFile();
      const header = fresh.getHeader();
      if (sessionFile && header) {
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf-8');
        this.bumpSessionFileMtime(sessionFile, sessionDir);
        this.sessionManager = SessionManager.open(sessionFile, sessionDir, this.activeWorkspace);
      } else {
        this.sessionManager = fresh;
      }
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
    if (this.isRunningTurn) {
      throw new Error('Cannot switch session while a turn is in progress.');
    }
    const targetId = sessionId.trim();
    if (!targetId) {
      throw new Error('Session identifier cannot be empty.');
    }
    if (this.sessionManager?.getSessionId?.() === targetId && this.currentSession) {
      return this.getSessionHistory();
    }

    if (this.sessionMode === 'memory') {
      const rec = this.getWorkspaceMemoryMap().get(targetId);
      if (!rec) {
        throw new Error(`Session not found: ${targetId}`);
      }
      rec.updatedAtMs = Date.now();
      rec.seq = ++this.memorySeq;
      this.disposeCurrentSessionState(true);
      this.sessionManager = rec.manager;
    } else {
      const sessionDir = this.resolveSessionDir(this.activeWorkspace);
      const filePath = SessionManager.findById(this.activeWorkspace, targetId, sessionDir);
      if (!filePath) {
        throw new Error(`Session not found: ${targetId}`);
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
    if (this.isRunningTurn) {
      throw new Error('Cannot delete session while a turn is in progress.');
    }
    const targetId = sessionId.trim();
    if (!targetId) {
      throw new Error('Session identifier cannot be empty.');
    }

    const isActive = this.sessionManager?.getSessionId?.() === targetId;

    if (this.sessionMode === 'memory') {
      const map = this.getWorkspaceMemoryMap();
      if (!map.has(targetId)) {
        throw new Error(`Session not found: ${targetId}`);
      }
      map.delete(targetId);
      if (isActive) {
        this.disposeCurrentSessionState(true);
      }
    } else {
      const sessionDir = this.resolveSessionDir(this.activeWorkspace);
      const filePath = SessionManager.findById(this.activeWorkspace, targetId, sessionDir);
      if (!filePath) {
        throw new Error(`Session not found: ${targetId}`);
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
    if (this.isRunningTurn) {
      throw new Error('Cannot pick workspace folder while a turn is in progress.');
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
      throw new Error('Workspace parameter cannot be empty.');
    }
    const resolved = path.resolve(trimmed);
    const targetKey = this.workspaceKey(resolved);
    const reg = this.getWorkspaces();
    const matched = reg.recent.find((p) => this.workspaceKey(p) === targetKey);
    if (!matched) {
      throw new Error(`Workspace is not registered: ${resolved}`);
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
    if (this.isRunningTurn) {
      throw new Error('Cannot switch workspace or session while a turn is in progress.');
    }
    const trimmedWs = workspacePath.trim();
    const targetId = sessionId.trim();
    if (!trimmedWs) {
      throw new Error('Workspace parameter cannot be empty.');
    }
    if (!targetId) {
      throw new Error('Session identifier cannot be empty.');
    }

    const resolvedWs = path.resolve(trimmedWs);
    if (!fs.existsSync(resolvedWs) || !fs.statSync(resolvedWs).isDirectory()) {
      throw new Error(`Directory does not exist: ${resolvedWs}`);
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
        throw new Error(`Session not found: ${targetId}`);
      }
    } else {
      nextPersistDir = this.resolveSessionDir(resolvedWs);
      nextPersistFile = SessionManager.findById(resolvedWs, targetId, nextPersistDir);
      if (!nextPersistFile) {
        throw new Error(`Session not found: ${targetId}`);
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
    const switched = this.workspaceManager.switchWorkspace(newPath);
    this.activeWorkspace = switched;
    this.invalidateEngineeringStatusCache();

    // 前のディレクトリバインディングを解放するため、以前の Pi セッションを適切に破棄
    this.disposeCurrentSessionState(true);

    this.emitEvent('workspace_changed', { workspace: this.activeWorkspace });
    return this.activeWorkspace;
  }

  removeWorkspace(targetPath: string): WorkspaceRegistry {
    this.workspaceManager.removeWorkspace(targetPath);
    const reg = this.workspaceManager.getRegistry();
    if (reg.active !== this.activeWorkspace) {
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
    try {
      const detected = detectVnEngines(this.activeWorkspace).trim();
      if (detected) {
        detectedEngine = detected;
      }
    } catch {
      // Keep fallback 'unknown' when engine detection fails
    }

    // unpacked および build フォルダの存在確認
    const unpackedDir = path.join(this.activeWorkspace, 'unpacked');
    const hasUnpacked = fs.existsSync(unpackedDir);

    const buildDir = path.join(this.activeWorkspace, 'build');
    const hasBuild = fs.existsSync(buildDir);

    const planDoc = this.readWorkspaceJson(path.join('.papercup', 'vn', 'plan.json'));
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

    const batchManifest = this.readWorkspaceJson(path.join('work', 'batches', 'manifest.json'));
    const progressDoc = this.readWorkspaceJson(path.join('.papercup', 'vn', 'progress.json'));
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
          }
        : null;

    const cpDoc = this.readWorkspaceJson(path.join('.papercup', 'vn', 'checkpoints.json'));
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

    const postQaDoc = this.readWorkspaceJson(path.join('.papercup', 'vn', 'post_qa_report.json'));
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

    const statusDoc = {
      workspace: this.activeWorkspace,
      engine: detectedEngine,
      rawStatus,
      hasUnpacked,
      hasBuild,
      skills: this.listEngineSkills(),
      plan,
      batchProgress,
      checkpoints,
      postQa,
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

  private isProviderConfiguredInRuntime(runtime: any, providerId: string): boolean {
    if (this.clearedProviders.has(providerId)) {
      return false;
    }
    const authStatus = runtime?.getProviderAuthStatus?.(providerId);
    const hasAuthFallback = Boolean(runtime?.hasConfiguredAuth?.(providerId));
    return Boolean(authStatus?.configured || hasAuthFallback || this.runtimeApiKeys.has(providerId));
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
      const configured =
        !isCleared &&
        Boolean(authStatus?.configured || hasAuthFallback || this.runtimeApiKeys.has(id));
      let source: ProviderAuthSource = null;
      if (configured) {
        if (authStatus?.source === 'runtime' || this.runtimeApiKeys.has(id)) {
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

      return {
        id,
        name,
        ...(envVar ? { envVar } : {}),
        configured,
        source,
        modelCount,
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
      .filter((p) => p.modelCount > 0 || p.configured)
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
    if (this.isRunningTurn) {
      throw new Error('Cannot change thinking level while a turn is in progress.');
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
    const baseModels = this.liveCustomProviderModels.get(providerId) ?? DEFAULT_CUSTOM_PROVIDER_MODELS[providerId];
    let customMap = this.customProviderModels.get(providerId);
    if (!customMap) {
      customMap = new Map<string, any>();
      this.customProviderModels.set(providerId, customMap);
    }
    if (!baseModels.some((m) => m.id === cleanId) && !customMap.has(cleanId)) {
      customMap.set(cleanId, buildCustomOpenAIModelDefinition(spec, cleanId));
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
      return;
    }

    this.liveProviderModelAllowlist.set(
      providerId,
      new Set(liveModels.map((m) => m.id))
    );

    if (isCustomOpenAIProviderId(providerId)) {
      const spec = CUSTOM_OPENAI_PROVIDERS[providerId];
      const defaults = DEFAULT_CUSTOM_PROVIDER_MODELS[providerId];
      const defaultById = new Map(defaults.map((m) => [m.id, m]));
      const liveIds = new Set(liveModels.map((m) => m.id));
      const ordered: any[] = [];
      for (const preset of defaults) {
        if (liveIds.has(preset.id)) {
          ordered.push(preset);
        }
      }
      for (const item of liveModels) {
        if (!defaultById.has(item.id)) {
          ordered.push(
            buildCustomOpenAIModelDefinition(spec, item.id, item.name, item.reasoning)
          );
        }
      }
      if (ordered.length > 0) {
        this.liveCustomProviderModels.set(providerId, ordered);
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
      synthesized.push({
        ...template,
        id: item.id,
        name: item.name || item.id,
        reasoning: item.reasoning,
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
      const baseModels = this.liveCustomProviderModels.get(spec.id) ?? DEFAULT_CUSTOM_PROVIDER_MODELS[spec.id];
      const mergedById = new Map<string, any>();
      for (const model of baseModels) {
        mergedById.set(model.id, model);
      }
      const customMap = this.customProviderModels.get(spec.id);
      if (customMap) {
        for (const [id, model] of customMap) {
          if (!mergedById.has(id)) {
            mergedById.set(id, model);
          }
        }
      }
      runtime.registerProvider(spec.id, {
        name: spec.name,
        baseUrl: spec.baseUrl,
        api: 'openai-completions',
        apiKey: spec.resolveApiKeyRef(),
        models: Array.from(mergedById.values()),
      });
    }
    await runtime.refresh?.({ allowNetwork: false, providers: specs.map((s) => s.id) });
  }

  async setProviderApiKey(
    providerId: string,
    apiKey: string,
    customModelId?: string
  ): Promise<ApiKeyUpdateResult> {
    if (this.isRunningTurn) {
      throw new Error('Cannot update API key while a turn is in progress.');
    }
    const trimmedKey = apiKey.trim();
    const rawProvider = providerId.trim();
    const isAuto = !rawProvider || rawProvider.toLowerCase() === 'auto';
    if (!rawProvider && !trimmedKey) {
      throw new Error('Provider identifier cannot be empty.');
    }

    await this.initSession();
    const runtime = this.currentSession?.modelRuntime;
    const knownProviders: readonly any[] = runtime?.getProviders?.() ?? [];

    let trimmedProvider = rawProvider;
    let detectionMeta: Omit<ApiKeyUpdateResult, keyof ModelsState> = {};

    if (trimmedKey) {
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
        apiKey: trimmedKey,
        fetchImpl: this.probeFetch,
      });
      trimmedProvider = discovery.provider;

      const resolvedExists = Boolean(
        runtime?.getProvider?.(trimmedProvider) ||
          knownProviders.some((p) => p.id === trimmedProvider)
      );
      if (!resolvedExists) {
        throw new Error(`Unknown provider: ${trimmedProvider}`);
      }

      this.applyDiscoveredLiveModels(
        runtime,
        trimmedProvider,
        discovery.liveModels,
        discovery.rawModelCount
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
    }

    let preferredCustomModelId = '';
    if (trimmedKey && isCustomOpenAIProviderId(trimmedProvider)) {
      if (customModelId?.trim()) {
        preferredCustomModelId = this.registerCustomProviderModel(trimmedProvider, customModelId);
      }
      await this.ensureCustomProvidersRegistered(runtime, [trimmedProvider]);
    }

    if (trimmedKey) {
      for (const prevProvider of Array.from(this.runtimeApiKeys.keys())) {
        if (prevProvider !== trimmedProvider) {
          await runtime.removeRuntimeApiKey(prevProvider);
          this.runtimeApiKeys.delete(prevProvider);
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
      await runtime.setRuntimeApiKey(trimmedProvider, trimmedKey);
      this.runtimeApiKeys.set(trimmedProvider, trimmedKey);
    } else {
      await runtime.removeRuntimeApiKey(trimmedProvider);
      this.runtimeApiKeys.delete(trimmedProvider);
      this.clearedProviders.add(trimmedProvider);
    }

    const available = this.getAvailableModels(runtime);
    const current = this.currentSession?.model;
    const currentKey = current ? `${current.provider}/${current.id}` : null;
    const isCurrentAvailable = Boolean(
      currentKey && available.some((m) => `${m.provider}/${m.id}` === currentKey)
    );

    if (trimmedKey) {
      if (
        !current ||
        !isCurrentAvailable ||
        current.provider !== trimmedProvider ||
        Boolean(preferredCustomModelId && current.id !== preferredCustomModelId)
      ) {
        const providerModels = available.filter((m) => m.provider === trimmedProvider);
        const nextModel = this.pickDefaultProviderModel(providerModels, preferredCustomModelId);
        if (nextModel) {
          await this.currentSession.setModel(nextModel);
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
    await Promise.allSettled([
      this.initSession().then(() => this.warmProviderApi(this.currentSession?.model?.api)),
      this.warmProviderApi('openai-completions'),
    ]);
  }

  private async getOrCreateModelRuntime(): Promise<any> {
    if (this.sharedModelRuntime) {
      return this.sharedModelRuntime;
    }
    if (this.sharedModelRuntimePromise) {
      return this.sharedModelRuntimePromise;
    }
    const pending = (async () => {
      const runtime = await ModelRuntime.create();
      if (!this.customProvidersInitialized) {
        await this.ensureCustomProvidersRegistered(runtime);
        this.customProvidersInitialized = true;
      }
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
    if (this.isRunningTurn) {
      throw new Error('Cannot switch model while a turn is in progress.');
    }
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
    }
    void this.warmProviderApi(target?.api);
    this.preferredModelKey = targetKey;
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

      const vnTools = createVnTools(() => this.activeWorkspace, {
        onSkillChanged: () => this.refreshLoadedSkills(),
        getTurnSignal: () => this.activeTurnAbortController?.signal,
        getKnownSecrets: () => this.runtimeApiKeys.values(),
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
      });
      const subagentTools = this.subagentManager.createTools(
        () => this.activeWorkspace,
        emitSubagentActivity,
        () => this.currentSession?.model,
        () => vnTools,
        () => this.currentSession?.modelRuntime,
        {
          turnAbortSignalProvider: () => this.activeTurnAbortController?.signal,
          getKnownSecrets: () => this.runtimeApiKeys.values(),
          sessionIdProvider: () => this.sessionManager?.getSessionId?.() ?? null,
          recordDiagnosticsProvider: () => this.sessionMode === 'persist',
          onTaskUpdated: handleSubagentTaskUpdated,
        }
      );

      if (!this.sessionManager) {
        if (this.sessionMode === 'memory') {
          const map = this.getWorkspaceMemoryMap();
          const latest = Array.from(map.values()).sort(
            (a, b) => b.updatedAtMs - a.updatedAtMs || b.seq - a.seq
          )[0];
          if (latest) {
            this.sessionManager = latest.manager;
          } else {
            const fresh = SessionManager.inMemory(this.activeWorkspace);
            map.set(fresh.getSessionId(), {
              manager: fresh,
              updatedAtMs: Date.now(),
              seq: ++this.memorySeq,
            });
            this.sessionManager = fresh;
          }
        } else {
          const sessionDir = this.resolveSessionDir(this.activeWorkspace);
          try {
            this.sessionManager = SessionManager.continueRecent(this.activeWorkspace, sessionDir);
          } catch (err) {
            console.warn(`Failed to resume session in ${sessionDir}, starting fresh:`, err);
            this.sessionManager = SessionManager.create(this.activeWorkspace, sessionDir);
          }
        }
      }
      this.installSessionRedaction(this.sessionManager);

      const settingsManager = SettingsManager.inMemory();
      if (config.bashPath) {
        settingsManager.setShellPath(config.bashPath);
      }

      const resourceLoader = new DefaultResourceLoader({
        cwd: this.activeWorkspace,
        agentDir: this.activeWorkspace,
        settingsManager,
        noExtensions: true,
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

      const guardedBuiltins = createGuardedBuiltinToolDefinitions(
        this.activeWorkspace,
        ['read', 'bash', 'edit', 'write', 'ls', 'find'],
        {
          bashPath: config.bashPath,
          getKnownSecrets: () => this.runtimeApiKeys.values(),
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
      if (this.preferredThinkingLevel && typeof session.setThinkingLevel === 'function') {
        try {
          session.setThinkingLevel(this.preferredThinkingLevel);
        } catch {
          // Ignore model clamping edge errors
        }
      }

      if (this.runtimeApiKeys.size > 0 && session.modelRuntime?.setRuntimeApiKey) {
        for (const [providerId, key] of this.runtimeApiKeys) {
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
        CUSTOM_OPENAI_PROVIDER_LIST.some((spec) =>
          this.isProviderConfiguredInRuntime(session.modelRuntime, spec.id)
        )
      ) {
        const firstAvailable = this.pickDefaultProviderModel(this.getAvailableModels(session.modelRuntime));
        if (firstAvailable) {
          try {
            await session.setModel(firstAvailable);
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
          const fallback = sessionAvailable[0];
          if (fallback) {
            try {
              await session.setModel(fallback);
              this.preferredModelKey = `${fallback.provider}/${fallback.id}`;
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

      // セッションイベントをフック
      session.subscribe((event: any) => {
        this.handlePiSessionEvent(event);
      });
      subscribed = true;

      void this.warmProviderApi(session.model?.api);
      this.emitEvent('session_ready', { sessionId: this.sessionManager?.getSessionId?.() });
    } catch (err) {
      if (!subscribed) {
        cleanupSession(session);
      }
      throw err;
    }
  }

  private handlePiSessionEvent(event: any): void {
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (!update) return;

      if (update.type === 'text_delta') {
        if (this.turnTiming && this.turnTiming.firstTokenAt === null) {
          this.turnTiming.firstTokenAt = performance.now();
        }
        const safeDelta = redactSecrets(String(update.delta || ''), this.runtimeApiKeys.values());
        if (this.activeTurnSnapshot) {
          this.activeTurnSnapshot.isThinking = false;
          this.activeTurnSnapshot.phase = 'generating';
          this.activeTurnSnapshot.retryAttempt = undefined;
          this.activeTurnSnapshot.retryMaxAttempts = undefined;
          this.activeTurnSnapshot.response += safeDelta;
        }
        this.emitEvent('text_delta', { delta: safeDelta });
      } else if (update.type === 'thinking_delta') {
        if (this.turnTiming && this.turnTiming.firstTokenAt === null) {
          this.turnTiming.firstTokenAt = performance.now();
        }
        const safeDelta = redactSecrets(String(update.delta || ''), this.runtimeApiKeys.values());
        if (this.activeTurnSnapshot) {
          this.activeTurnSnapshot.isThinking = true;
          this.activeTurnSnapshot.phase = 'thinking';
          this.activeTurnSnapshot.retryAttempt = undefined;
          this.activeTurnSnapshot.retryMaxAttempts = undefined;
          this.activeTurnSnapshot.thinking += safeDelta;
        }
        this.emitEvent('thinking_delta', { delta: safeDelta });
      }
    } else if (event.type === 'tool_execution_start') {
      if (this.turnTiming && this.turnTiming.firstTokenAt === null) {
        this.turnTiming.firstTokenAt = performance.now();
      }
      const safeArgs = redactUnknownValue(event.args, this.runtimeApiKeys.values());
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
      const safeResult = redactUnknownValue(event.result, this.runtimeApiKeys.values());
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
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.stopReason === 'error') {
        const rawErr = String(event.message.errorMessage || '模型请求返回错误。');
        const cls = classifySubagentError(rawErr, false);
        if (cls.fatalForPool && typeof this.currentSession?.setAutoRetryEnabled === 'function') {
          this.currentSession.setAutoRetryEnabled(false);
        }
        this.lastTurnError = redactSecrets(rawErr, this.runtimeApiKeys.values());
      } else {
        this.lastTurnError = undefined;
      }
    }
  }

  async abortTurn(): Promise<boolean> {
    if (!this.isRunningTurn || !this.currentSession) {
      return false;
    }
    this.turnAborted = true;
    this.activeTurnAbortController?.abort();
    this.subagentManager.abortActiveTasks('主会话已手动中止任务。');
    await this.currentSession.abort();
    return true;
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
        const reason = redactSecrets(String(task.error || task.status), this.runtimeApiKeys.values()).slice(0, 140);
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

    const postQaDoc = this.readWorkspaceJson(path.join('.papercup', 'vn', 'post_qa_report.json'));
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
        `- post_qa: status=${postQaDoc.interrupted ? 'interrupted' : 'partial'}${kind} reviewed=${reviewed}/${total} pending=${pending} errors=${errs} state=.papercup/vn/post_qa_state.json -> 直接调用 vn_post_qa_parallel 续检剩余分片，严禁传 skipRoleChecker=true 或手动替代 role-checker`
      );
    }

    const progressDoc = this.readWorkspaceJson(path.join('.papercup', 'vn', 'progress.json'));
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

  async executeTurn(prompt: string, options?: { model?: string }): Promise<void> {
    if (this.isRunningTurn) {
      throw new Error('A turn is already in progress.');
    }

    const turnStartedAt = performance.now();
    await this.initSession();
    if (typeof this.currentSession?.setAutoRetryEnabled === 'function') {
      this.currentSession.setAutoRetryEnabled(true);
    }
    if (this.pendingSkillReload && this.currentSession?.reload) {
      await this.currentSession.reload();
      this.pendingSkillReload = false;
    }
    const requestedModel = options?.model?.trim();
    if (requestedModel && !this.isSameModelRef(this.currentSession?.model, requestedModel)) {
      await this.selectModel(requestedModel);
    }

    const rawBefore = this.sessionManager?.buildSessionContext?.().messages ?? [];
    await this.injectInterruptionRecoveryIfNeeded(rawBefore);
    this.turnBaseMessageCount = this.projectMessages(rawBefore, {
      markUnresolvedToolsInterrupted: true,
    }).length;
    this.activeTurnAbortController = new AbortController();
    this.activeTurnPrompt = prompt;
    this.activeTurnStartedAtLabel = new Date().toLocaleTimeString();

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

    this.emitEvent('turn_started', { prompt, model: activeModelKey });

    const promptCalledAt = performance.now();
    this.turnTiming = {
      startedAt: turnStartedAt,
      promptCalledAt,
      firstTokenAt: null,
      retries: 0,
      modelKey: activeModelKey || 'unknown',
    };

    try {
      await this.currentSession.prompt(prompt);
      if (!this.turnAborted && this.lastTurnError) {
        this.emitEvent('turn_error', { message: this.lastTurnError });
      }
    } catch (error: any) {
      const safeErrorMsg = redactSecrets(String(error?.message || error), this.runtimeApiKeys.values());
      this.emitEvent('turn_error', { message: safeErrorMsg });
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
      this.isRunningTurn = false;
      this.turnAborted = false;
      this.lastTurnError = undefined;
      this.activeTurnAbortController = null;
      this.activeTurnSnapshot = null;
      this.activeTurnPrompt = '';
      this.activeTurnStartedAtLabel = '';
      this.turnBaseMessageCount = 0;
      this.invalidateEngineeringStatusCache();
      if (this.sessionMode === 'memory' && this.sessionManager) {
        const rec = this.getWorkspaceMemoryMap().get(this.sessionManager.getSessionId());
        if (rec) {
          rec.updatedAtMs = Date.now();
          rec.seq = ++this.memorySeq;
        }
      }
      this.emitEvent('turn_finished', { status });
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
