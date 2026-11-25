export interface WorkspaceState {
  active: string;
  recent: string[];
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

export interface ModelOption {
  key: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportsImage?: boolean;
}

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ChatImageAttachment {
  mimeType: SupportedImageMimeType;
  data: string;
  name?: string;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelsState {
  current: string | null;
  models: ModelOption[];
  providers?: ProviderStatusInfo[];
  thinkingLevel?: ThinkingLevel;
  availableThinkingLevels?: ThinkingLevel[];
}

export type DetectionMethod =
  | 'prefix-verified'
  | 'probe'
  | 'prefix-offline'
  | 'manual-verified'
  | 'manual-offline';

export interface ApiKeyDetectionMeta {
  detectedProvider?: string;
  detectedProviderName?: string;
  detectionMethod?: DetectionMethod;
  liveModelCount?: number;
  filteredOutCount?: number;
}

export interface ApiKeyDetectPreview {
  ok: boolean;
  provider: string;
  providerName: string;
  detectionMethod: DetectionMethod;
  liveModelCount: number;
  filteredOutCount: number;
  sampleModels: string[];
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

export type SubagentTaskStatus = 'running' | 'completed' | 'error' | 'aborted';

export type SubagentActivityState =
  | 'waiting_model'
  | 'running_tool'
  | 'compacting'
  | 'completed'
  | 'error'
  | 'aborted'
  | 'unknown';

export type CompactionReason = 'manual' | 'threshold' | 'overflow';

export interface CompactionSummaryInfo {
  id: string;
  timestamp: string;
  reason: CompactionReason;
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  focus?: string;
  checkpointPath?: string;
  prunedCount?: number;
}

export interface CompactionMessageMeta {
  reason: CompactionReason;
  tokensBefore: number;
  tokensAfter: number;
  focus?: string;
  checkpointPath?: string;
}

export interface QueuedCompactionInfo {
  focus?: string;
}

export interface CompactSessionResponse {
  ok: boolean;
  status: 'compacted' | 'noop' | 'queued';
  result?: CompactionSummaryInfo;
  message?: string;
  tokenUsage?: SessionTokenUsageSnapshot;
  focus?: string;
}

export interface CompactSubagentResponse {
  ok: boolean;
  status: 'compacted' | 'noop' | 'queued';
  taskId: string;
  result?: CompactionSummaryInfo;
  message?: string;
  focus?: string;
}

const SLASH_COMPACT_RE = /^\/compact(?:\s+([\s\S]*))?$/i;

export function parseSlashCompactCommand(
  input: string
): { isCompact: true; focus?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = SLASH_COMPACT_RE.exec(trimmed);
  if (!match) return null;
  const focus = (match[1] ?? '').trim();
  return focus ? { isCompact: true, focus } : { isCompact: true };
}

export interface SubagentTaskToolEvent {
  callId: string;
  tool: string;
  argsSummary: string;
  args?: unknown;
  status: 'running' | 'completed' | 'error' | 'aborted';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  isError?: boolean;
  resultSummary?: string;
  savedOutputPath?: string;
  producedArtifact?: string;
}

export interface SubagentChatToolCall {
  callId: string;
  tool: string;
  args?: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'completed' | 'error' | 'aborted';
  durationMs?: number;
  savedOutputPath?: string;
  producedArtifact?: string;
}

export type QueuedMessageMode = 'steer' | 'followUp';

export interface QueuedMessageItem {
  id: string;
  mode: QueuedMessageMode;
  text: string;
  createdAt: string;
  imageCount?: number;
}

export interface PendingQueueState {
  steering: QueuedMessageItem[];
  followUp: QueuedMessageItem[];
}

export interface RestoredDraftPayload {
  restoreId: string;
  text: string;
  steeringCount: number;
  restoredFollowUpCount: number;
  droppedFollowUpCount: number;
}

export interface SubagentQueueUpdatedEvent {
  taskId: string;
  threadId: string;
  sessionId: string | null;
  role: string;
  queue: PendingQueueState;
}

export interface SubagentQueueRestoredEvent {
  taskId: string;
  threadId: string;
  sessionId: string | null;
  role: string;
  restoredDraft: RestoredDraftPayload;
  reason: 'aborted' | 'error';
}

export class ApiRequestError extends Error {
  status: number;
  code?: string;
  queue?: PendingQueueState;

  constructor(message: string, status: number, code?: string, queue?: PendingQueueState) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.queue = queue;
  }
}

export interface SubagentChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'compaction';
  content: string;
  images?: ChatImageAttachment[];
  contentOffset?: number;
  thinking?: string;
  thinkingOffset?: number;
  tools?: SubagentChatToolCall[];
  timestamp: string;
  error?: boolean;
  turnTaskId?: string;
  origin?: 'delegated' | 'direct_user';
  deliveryMode?: QueuedMessageMode;
  compaction?: CompactionMessageMeta;
}

export interface SubagentStreamDeltaEvent {
  taskId: string;
  threadId: string;
  sessionId: string | null;
  role: string;
  messageId: string;
  kind: 'thinking' | 'text';
  delta: string;
  seq?: number;
  offset?: number;
  endOffset?: number;
}

export interface SubagentTaskSummary {
  taskId: string;
  threadId?: string;
  resumedFromTaskId?: string;
  sessionId: string | null;
  parentCallId?: string;
  role: string;
  model: string | null;
  thinkingLevel: string;
  status: SubagentTaskStatus;
  activityState: SubagentActivityState;
  stage: string;
  startedAt: string;
  endedAt?: string;
  lastActivityAt: string;
  lastProgressAt: string | null;
  lastProgressSummary: string | null;
  durationMs: number;
  toolCallCount: number;
  errorCount: number;
  artifactsCount: number;
  consecutiveHypothesisFailures: number;
  pivotWarningCount: number;
  resumable?: boolean;
  interactive?: boolean;
  maxToolCalls?: number;
  callsSinceProgress?: number;
  maxStallCalls?: number;
  isThinking?: boolean;
  pendingQueueCount?: number;
  userSteerCount?: number;
  compactionCount?: number;
  queuedCompaction?: QueuedCompactionInfo | null;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    triggerTokens?: number;
  } | null;
  taskSummary: string;
  error?: string;
}

export interface SubagentTaskSnapshot extends SubagentTaskSummary {
  taskPrompt: string;
  maxConsecutiveFailures: number;
  artifacts: string[];
  pivotWarnings: string[];
  retryCount: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
  toolCalls: SubagentTaskToolEvent[];
  responsePreview: string;
  messages?: SubagentChatMessage[];
  pendingQueue?: PendingQueueState;
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
  compaction?: CompactionMessageMeta;
}

export type TurnPhase = 'connecting' | 'retrying' | 'thinking' | 'tool' | 'generating';

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

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
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
    smokeVision?: TokenUsageBucket;
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
  translatorMode: TranslatorMode;
  cloudCostUsd: number;
  updatedAt: string;
}

export type CharacterGender = 'female' | 'male' | 'unknown' | 'other';
export type ChatFormStatus = 'pending' | 'submitted' | 'superseded' | 'cancelled';

export interface CharacterAlias {
  source: string;
  target: string;
}

export interface CharacterRosterFormItem {
  id: string;
  sourceName: string;
  defaultTarget: string;
  targetName: string;
  speakerIds: string[];
  aliases: CharacterAlias[];
  gender: CharacterGender;
  note?: string;
  occurrences: number;
  samples: string[];
}

export interface ChatFormExcludedItem {
  sourceName: string;
  reason?: string;
  occurrences: number;
  samples: string[];
}

export interface ChatFormRecord {
  schema: 1;
  formId: string;
  kind: 'character_roster';
  status: ChatFormStatus;
  title: string;
  description: string;
  sessionId: string | null;
  classifyDigest: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  items: CharacterRosterFormItem[];
  excludedItems?: ChatFormExcludedItem[];
  summary?: {
    total: number;
    editedCount: number;
    glossaryEntriesAdded: number;
    dismissedCount?: number;
  };
}

export interface SubmitChatFormItemPayload {
  id?: string;
  sourceName: string;
  targetName: string;
  speakerIds?: string[];
  aliases?: CharacterAlias[];
  gender?: CharacterGender;
  note?: string;
}

export interface SubmitChatFormResponse {
  ok: boolean;
  form: ChatFormRecord;
  editedCount: number;
  glossaryEntriesAdded: number;
  startedTurn: boolean;
  userPrompt?: string;
}

export interface SessionHistoryState {
  sessionId: string | null;
  persisted: boolean;
  workspace: string;
  messages: PersistedChatMessage[];
  sessions: SessionSummary[];
  isRunning?: boolean;
  isCompacting?: boolean;
  queuedCompaction?: QueuedCompactionInfo | null;
  activeTurn?: ActiveTurnSnapshot | null;
  pendingQueue?: PendingQueueState;
  activeDirectSubagentTaskId?: string | null;
  subagentTasks?: SubagentTaskSummary[];
  tokenUsage?: SessionTokenUsageSnapshot;
  chatForms?: ChatFormRecord[];
}

export interface EngineeringPlanSummary {
  model: string;
  modelFamily: string;
  batchMaxLines: number;
  batchMaxSourceTokens: number;
  sessionMaxSourceTokens: number;
  concurrency: number;
  totalRows?: number;
  estimatedSourceTokens?: number;
}

export type TranslatorMode = 'cloud_subagent' | 'local_mt';
export type LocalMtPreset = 'sakura' | 'hy-mt' | 'plain-lines';

export interface PublicLocalTranslatorConfig {
  mode: TranslatorMode;
  baseUrl: string;
  model: string;
  ollamaPath: string;
  hasApiKey: boolean;
  preset: LocalMtPreset;
  packetLines: number;
  concurrency: number;
  contextWindow: number;
  timeoutMs: number;
  escalateFailedRows: boolean;
  useTmCache: boolean;
  disableThinking: boolean;
}

export interface TranslatorWorkspaceOverride {
  mode?: TranslatorMode;
  baseUrl?: string;
  model?: string;
  ollamaPath?: string;
  preset?: LocalMtPreset;
  packetLines?: number;
  concurrency?: number;
  contextWindow?: number;
  timeoutMs?: number;
  escalateFailedRows?: boolean;
  useTmCache?: boolean;
  disableThinking?: boolean;
}

export interface LocalEndpointPresetInfo {
  id: string;
  name: string;
  baseUrl: string;
}

export interface TranslatorConfigState {
  global: PublicLocalTranslatorConfig;
  workspaceOverride: TranslatorWorkspaceOverride | null;
  effective: PublicLocalTranslatorConfig;
  endpointPresets: LocalEndpointPresetInfo[];
}

export interface TranslatorConfigUpdatePayload {
  mode?: TranslatorMode;
  baseUrl?: string;
  model?: string;
  ollamaPath?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  preset?: LocalMtPreset;
  packetLines?: number;
  concurrency?: number;
  contextWindow?: number;
  timeoutMs?: number;
  escalateFailedRows?: boolean;
  useTmCache?: boolean;
  disableThinking?: boolean;
}

export interface LocalTranslatorProbeResult {
  ok: boolean;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
  suggestedModel?: string | null;
  ollamaAutoStarted?: boolean;
  ollamaVersion?: string;
  ollamaManaged?: boolean;
  ollamaSyncSeq?: number;
}

export interface OllamaSyncOptimizations {
  flashAttention: boolean;
  kvCacheType: string;
  contextLength: number;
}

export interface OllamaSyncResult {
  attempted: boolean;
  synced: boolean;
  status: 'started' | 'restarted' | 'already_running' | 'skipped' | 'failed';
  concurrency: number;
  origin?: string;
  version?: string;
  reason?: string;
  managedByPaperCup?: boolean;
  binaryPath?: string;
  optimizations?: OllamaSyncOptimizations;
  syncSeq?: number;
  message: string;
}

export interface OllamaStatusResult {
  isLocalTarget: boolean;
  running: boolean;
  origin?: string;
  version?: string;
  binaryPath: string | null;
  binarySource: 'custom' | 'auto' | 'none';
  invalidCustomPath?: boolean;
  models: Array<{ id: string; name: string }>;
  suggestedModel: string | null;
  managedByPaperCup: boolean;
  lastSyncedConcurrency?: number;
  optimizations?: OllamaSyncOptimizations;
  reason?: string;
}

export interface OllamaStartResult {
  ok: boolean;
  ollamaSync: OllamaSyncResult;
  status: OllamaStatusResult;
  models: Array<{ id: string; name: string }>;
  suggestedModel: string | null;
}

export interface TranslatorConfigUpdateResponse extends TranslatorConfigState {
  ok: boolean;
  ollamaSync?: OllamaSyncResult;
}

export interface EngineeringRouteStats {
  tmCache: number;
  localMt: number;
  cloudEscalated: number;
  cloudSubagent: number;
}

export interface EngineeringTranslatorInfo {
  mode: TranslatorMode;
  model: string;
  preset: LocalMtPreset;
  baseUrl: string;
  concurrency?: number;
  escalateFailedRows: boolean;
  hasWorkspaceOverride: boolean;
  ollamaRunning?: boolean;
  ollamaVersion?: string;
  ollamaManaged?: boolean;
}

export interface EngineeringBatchProgress {
  totalBatches: number;
  pendingBatches: number;
  savedPendingQa: number;
  qaPassed: number;
  qaFailed: number;
  totalRows: number;
  checkedInRows: number;
  routeStats?: EngineeringRouteStats;
}

export interface EngineeringCheckpointInfo {
  commit: string;
  stage: string;
  qaVerified: boolean;
  summary: string;
  timestamp: string;
}

export interface EngineeringPostQaSummary {
  ok: boolean;
  deterministicPassed: number;
  deterministicFailed: number;
  affectedBatchIds: string[];
  roleCheckerChunksReviewed: number;
  roleCheckerChunksTotal?: number;
  roleCheckerPendingChunks?: number;
  roleCheckerErrors?: number;
  interrupted?: boolean;
  interruptKind?: string;
}

export interface EngineeringStatus {
  workspace: string;
  engine: string;
  engineId?: string | null;
  engineName?: string | null;
  engineKnown?: boolean;
  rawStatus: string;
  hasUnpacked: boolean;
  hasBuild: boolean;
  skills?: string[];
  plan?: EngineeringPlanSummary | null;
  batchProgress?: EngineeringBatchProgress | null;
  checkpoints?: { count: number; latest: EngineeringCheckpointInfo | null } | null;
  postQa?: EngineeringPostQaSummary | null;
  translator?: EngineeringTranslatorInfo | null;
}

export interface ResolvedEngineDisplay {
  known: boolean;
  id: string | null;
  shortLabel: string | null;
  displayLabel: string;
  rawEngine: string;
}

export function resolveEngineDisplay(status: EngineeringStatus | null | undefined): ResolvedEngineDisplay {
  const rawEngine = (status?.engine || '').trim();
  if (!status) {
    return {
      known: false,
      id: null,
      shortLabel: null,
      displayLabel: '正在识别…',
      rawEngine: '',
    };
  }

  if (typeof status.engineKnown === 'boolean') {
    const structuredName = (status.engineName || status.engineId || '').trim();
    if (status.engineKnown && structuredName) {
      return {
        known: true,
        id: status.engineId ?? null,
        shortLabel: structuredName,
        displayLabel: structuredName,
        rawEngine,
      };
    }
    return {
      known: false,
      id: status.engineId ?? null,
      shortLabel: null,
      displayLabel: '未识别',
      rawEngine,
    };
  }

  // Fallback for legacy payloads without structured engine fields: split on two-space column delimiter
  const firstLine = rawEngine.split(/\r?\n/)[0]?.trim() || '';
  const isUnknown =
    !firstLine ||
    firstLine.includes('未识别') ||
    firstLine.toLowerCase().startsWith('unknown');
  if (isUnknown) {
    return {
      known: false,
      id: null,
      shortLabel: null,
      displayLabel: '未识别',
      rawEngine,
    };
  }
  const firstCol = firstLine.split(/\s{2,}/)[0]?.trim() || firstLine;
  return {
    known: true,
    id: firstCol,
    shortLabel: firstCol,
    displayLabel: firstLine.replace(/\s{2,}/g, ' · ') || firstCol,
    rawEngine,
  };
}

export async function fetchWorkspaces(signal?: AbortSignal): Promise<WorkspaceState> {
  const res = await fetch('/api/workspaces', { signal });
  if (!res.ok) throw new Error('Failed to load workspaces');
  return res.json();
}

export async function selectWorkspace(workspacePath: string): Promise<WorkspaceState> {
  const res = await fetch('/api/workspaces/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: workspacePath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to switch workspace' }));
    throw new Error(err.error || 'Failed to switch workspace');
  }
  return res.json();
}

export async function removeWorkspace(workspacePath: string): Promise<WorkspaceState> {
  const res = await fetch('/api/workspaces/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: workspacePath }),
  });
  if (!res.ok) throw new Error('Failed to remove workspace');
  return res.json();
}

export async function pickWorkspaceFolder(
  initialDir?: string
): Promise<{ ok: boolean; canceled: boolean; path: string | null }> {
  const res = await fetch('/api/workspaces/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initialDir ? { initialDir } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to pick workspace folder' }));
    throw new Error(err.error || 'Failed to pick workspace folder');
  }
  return res.json();
}

export async function fetchWorkspaceSessions(
  workspacePath: string,
  signal?: AbortSignal
): Promise<{ workspace: string; sessions: SessionSummary[] }> {
  const query = `?workspace=${encodeURIComponent(workspacePath)}`;
  const res = await fetch(`/api/workspaces/sessions${query}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load workspace sessions' }));
    throw new Error(err.error || 'Failed to load workspace sessions');
  }
  return res.json();
}

export async function openWorkspaceSession(
  workspacePath: string,
  sessionId: string
): Promise<{ ok: boolean; workspaces: WorkspaceState; session: SessionHistoryState }> {
  const res = await fetch('/api/workspaces/open-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: workspacePath, sessionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to open workspace session' }));
    throw new Error(err.error || 'Failed to open workspace session');
  }
  return res.json();
}

export async function fetchEngineeringStatus(
  forceRefresh = false,
  signal?: AbortSignal
): Promise<EngineeringStatus> {
  const res = await fetch(
    forceRefresh ? '/api/engineering/status?refresh=1' : '/api/engineering/status',
    { signal }
  );
  if (!res.ok) throw new Error('Failed to fetch engineering status');
  return res.json();
}

export async function startTurn(
  prompt: string,
  model?: string,
  images?: ChatImageAttachment[]
): Promise<{ ok: boolean }> {
  const res = await fetch('/api/turns/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      model,
      ...(images && images.length > 0 ? { images } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to start turn' }));
    throw new Error(err.error || 'Failed to start turn');
  }
  return res.json();
}

export async function abortTurn(): Promise<{
  ok: boolean;
  aborted: boolean;
  restoredDraft?: RestoredDraftPayload | null;
}> {
  const res = await fetch('/api/turns/abort', {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to abort turn' }));
    throw new Error(err.error || 'Failed to abort turn');
  }
  return res.json();
}

export async function enqueueTurnMessage(
  prompt: string,
  mode: QueuedMessageMode,
  images?: ChatImageAttachment[]
): Promise<{ ok: boolean; item: QueuedMessageItem; queue: PendingQueueState }> {
  const res = await fetch('/api/turns/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      mode,
      ...(images && images.length > 0 ? { images } : {}),
    }),
  });
  const body = await res.json().catch(() => ({ error: '加入待投递队列失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '加入待投递队列失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function switchTurnQueueItemMode(
  itemId: string,
  mode: QueuedMessageMode
): Promise<{ ok: boolean; found: boolean; item?: QueuedMessageItem | null; queue: PendingQueueState }> {
  const res = await fetch(`/api/turns/queue/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body = await res.json().catch(() => ({ error: '切换队列模式失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '切换队列模式失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function removeTurnQueueItem(
  itemId: string
): Promise<{
  ok: boolean;
  found: boolean;
  removed?: QueuedMessageItem | null;
  removedImages?: ChatImageAttachment[];
  queue: PendingQueueState;
}> {
  const res = await fetch(`/api/turns/queue/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
  });
  const body = await res.json().catch(() => ({ error: '移除队列消息失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '移除队列消息失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function clearTurnQueue(): Promise<{
  ok: boolean;
  cleared: PendingQueueState;
  restoredDraft: RestoredDraftPayload | null;
  queue: PendingQueueState;
}> {
  const res = await fetch('/api/turns/queue', {
    method: 'DELETE',
  });
  const body = await res.json().catch(() => ({ error: '清空队列失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '清空队列失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelsState> {
  const res = await fetch('/api/models', { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load models' }));
    throw new Error(err.error || 'Failed to load models');
  }
  return res.json();
}

export async function selectModel(model: string): Promise<ModelsState & { ok: boolean }> {
  const res = await fetch('/api/models/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to switch model' }));
    throw new Error(err.error || 'Failed to switch model');
  }
  return res.json();
}

export async function updateProviderApiKey(
  provider: string,
  apiKey: string,
  customModel?: string,
  options?: { useStored?: boolean; baseUrl?: string; clear?: boolean }
): Promise<ModelsState & ApiKeyDetectionMeta & { ok: boolean }> {
  const res = await fetch('/api/models/key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      apiKey,
      ...(customModel ? { customModel } : {}),
      ...(options?.useStored ? { useStored: true } : {}),
      ...(options?.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options?.clear ? { clear: true } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to update API key' }));
    throw new Error(err.error || 'Failed to update API key');
  }
  return res.json();
}

export async function detectApiKeyProvider(apiKey: string): Promise<ApiKeyDetectPreview> {
  const res = await fetch('/api/models/key/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to detect API key provider' }));
    throw new Error(err.error || 'Failed to detect API key provider');
  }
  return res.json();
}

export async function updateThinkingLevel(
  thinkingLevel: ThinkingLevel
): Promise<ModelsState & { ok: boolean }> {
  const res = await fetch('/api/models/thinking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thinkingLevel }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to update thinking level' }));
    throw new Error(err.error || 'Failed to update thinking level');
  }
  return res.json();
}

export async function fetchTranslatorConfig(signal?: AbortSignal): Promise<TranslatorConfigState> {
  const res = await fetch('/api/translator/config', { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load translator configuration' }));
    throw new Error(err.error || 'Failed to load translator configuration');
  }
  return res.json();
}

export async function updateTranslatorConfig(
  payload: TranslatorConfigUpdatePayload
): Promise<TranslatorConfigUpdateResponse> {
  const res = await fetch('/api/translator/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to update translator configuration' }));
    throw new Error(err.error || 'Failed to update translator configuration');
  }
  return res.json();
}

export async function probeLocalTranslator(
  baseUrl: string,
  options?: string | { apiKey?: string; ollamaPath?: string; autoStartOllama?: boolean; concurrency?: number }
): Promise<LocalTranslatorProbeResult> {
  const opts = typeof options === 'string' ? { apiKey: options } : options || {};
  const res = await fetch('/api/translator/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      ...(opts.apiKey !== undefined && opts.apiKey.trim() ? { apiKey: opts.apiKey.trim() } : {}),
      ...(opts.ollamaPath !== undefined ? { ollamaPath: opts.ollamaPath } : {}),
      ...(opts.autoStartOllama !== undefined ? { autoStartOllama: opts.autoStartOllama } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to probe local translator endpoint' }));
    throw new Error(err.error || 'Failed to probe local translator endpoint');
  }
  return res.json();
}

export async function pickOllamaBinary(
  initialPath?: string
): Promise<{ ok: boolean; canceled: boolean; path: string | null }> {
  const res = await fetch('/api/translator/ollama/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initialPath ? { initialPath } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to pick Ollama executable' }));
    throw new Error(err.error || 'Failed to pick Ollama executable');
  }
  return res.json();
}

export async function fetchLocalOllamaStatus(
  params?: {
    baseUrl?: string;
    ollamaPath?: string;
  },
  signal?: AbortSignal
): Promise<OllamaStatusResult> {
  const search = new URLSearchParams();
  if (params?.baseUrl) search.set('baseUrl', params.baseUrl);
  if (params?.ollamaPath !== undefined) search.set('ollamaPath', params.ollamaPath);
  const qs = search.toString();
  const res = await fetch(`/api/translator/ollama/status${qs ? `?${qs}` : ''}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to query local Ollama status' }));
    throw new Error(err.error || 'Failed to query local Ollama status');
  }
  return res.json();
}

export async function startLocalOllama(payload?: {
  baseUrl?: string;
  ollamaPath?: string;
  concurrency?: number;
  forceRestart?: boolean;
}): Promise<OllamaStartResult> {
  const res = await fetch('/api/translator/ollama/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to start local Ollama service' }));
    throw new Error(err.error || 'Failed to start local Ollama service');
  }
  return res.json();
}

export async function fetchSessionHistory(signal?: AbortSignal): Promise<SessionHistoryState> {
  const res = await fetch('/api/session/history', { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load session history' }));
    throw new Error(err.error || 'Failed to load session history');
  }
  return res.json();
}

export async function resetSession(): Promise<SessionHistoryState & { ok: boolean }> {
  const res = await fetch('/api/session/new', {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to start new session' }));
    throw new Error(err.error || 'Failed to start new session');
  }
  return res.json();
}

export async function compactSession(focus?: string): Promise<CompactSessionResponse> {
  const trimmed = focus?.trim();
  const res = await fetch('/api/session/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trimmed ? { focus: trimmed } : {}),
  });
  const body = await res.json().catch(() => ({ error: '压缩会话上下文失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '压缩会话上下文失败', res.status, body.code);
  }
  return body;
}

export async function selectSession(sessionId: string): Promise<SessionHistoryState & { ok: boolean }> {
  const res = await fetch('/api/sessions/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to switch session' }));
    throw new Error(err.error || 'Failed to switch session');
  }
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<SessionHistoryState & { ok: boolean }> {
  const res = await fetch('/api/sessions/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to delete session' }));
    throw new Error(err.error || 'Failed to delete session');
  }
  return res.json();
}

export async function fetchSubagentTasks(sessionId?: string | null): Promise<SubagentTaskSummary[]> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await fetch(`/api/subagents/tasks${query}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load subagent tasks' }));
    throw new Error(err.error || 'Failed to load subagent tasks');
  }
  const data = await res.json();
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

export async function fetchSubagentTaskDetail(
  taskId: string,
  signal?: AbortSignal
): Promise<SubagentTaskSnapshot> {
  const res = await fetch(`/api/subagents/tasks/${encodeURIComponent(taskId)}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load subagent task detail' }));
    throw new Error(err.error || 'Failed to load subagent task detail');
  }
  return res.json();
}

export async function sendSubagentMessage(
  taskId: string,
  message: string,
  images?: ChatImageAttachment[]
): Promise<{ ok: boolean; taskId: string; threadId: string; status: 'started' }> {
  const res = await fetch(`/api/subagents/tasks/${encodeURIComponent(taskId)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      ...(images && images.length > 0 ? { images } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '发送子代理消息失败' }));
    throw new Error(err.error || '发送子代理消息失败');
  }
  return res.json();
}

export async function abortSubagentTask(
  taskId: string
): Promise<{ ok: boolean; aborted: boolean; restoredDraft?: RestoredDraftPayload | null }> {
  const res = await fetch(`/api/subagents/tasks/${encodeURIComponent(taskId)}/abort`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '中止子代理任务失败' }));
    throw new Error(err.error || '中止子代理任务失败');
  }
  return res.json();
}

export async function enqueueSubagentMessage(
  taskId: string,
  message: string,
  mode: QueuedMessageMode,
  images?: ChatImageAttachment[]
): Promise<{ ok: boolean; taskId: string; threadId: string; item: QueuedMessageItem; queue: PendingQueueState }> {
  const res = await fetch(`/api/subagents/tasks/${encodeURIComponent(taskId)}/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      mode,
      ...(images && images.length > 0 ? { images } : {}),
    }),
  });
  const body = await res.json().catch(() => ({ error: '加入子代理待投递队列失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '加入子代理待投递队列失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function switchSubagentQueueItemMode(
  taskId: string,
  itemId: string,
  mode: QueuedMessageMode
): Promise<{ ok: boolean; found: boolean; item?: QueuedMessageItem | null; queue: PendingQueueState }> {
  const res = await fetch(
    `/api/subagents/tasks/${encodeURIComponent(taskId)}/queue/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }
  );
  const body = await res.json().catch(() => ({ error: '切换子代理队列模式失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '切换子代理队列模式失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function removeSubagentQueueItem(
  taskId: string,
  itemId: string
): Promise<{
  ok: boolean;
  found: boolean;
  removed?: QueuedMessageItem | null;
  removedImages?: ChatImageAttachment[];
  queue: PendingQueueState;
}> {
  const res = await fetch(
    `/api/subagents/tasks/${encodeURIComponent(taskId)}/queue/${encodeURIComponent(itemId)}`,
    {
      method: 'DELETE',
    }
  );
  const body = await res.json().catch(() => ({ error: '移除子代理队列消息失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '移除子代理队列消息失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function clearSubagentQueue(taskId: string): Promise<{
  ok: boolean;
  taskId: string;
  threadId: string;
  cleared: PendingQueueState;
  restoredDraft: RestoredDraftPayload | null;
  queue: PendingQueueState;
}> {
  const res = await fetch(`/api/subagents/tasks/${encodeURIComponent(taskId)}/queue`, {
    method: 'DELETE',
  });
  const body = await res.json().catch(() => ({ error: '清空子代理队列失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '清空子代理队列失败', res.status, body.code, body.queue);
  }
  return body;
}

export async function compactSubagent(
  taskId: string,
  focus?: string
): Promise<CompactSubagentResponse> {
  const trimmed = focus?.trim();
  const res = await fetch(`/api/subagents/${encodeURIComponent(taskId)}/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trimmed ? { focus: trimmed } : {}),
  });
  const body = await res.json().catch(() => ({ error: '压缩子代理上下文失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '压缩子代理上下文失败', res.status, body.code);
  }
  return body;
}

export interface SmokeTestConfig {
  enabled: boolean;
  visionEnabled: boolean;
  textractorPath: string;
  localeEmulatorPath: string;
  timeoutSec: number;
  advanceSteps: number;
  maxScreenshots: number;
  maxRepairRounds: number;
}

export interface SmokeToolStatus {
  platformSupported: boolean;
  textractor: {
    configured: boolean;
    available: boolean;
    x86Path: string | null;
    x64Path: string | null;
    fallbackPath: string | null;
    note: string;
  };
  localeEmulator: {
    configured: boolean;
    available: boolean;
    leProcPath: string | null;
    note: string;
  };
}

export interface SmokeConfigState {
  global: SmokeTestConfig;
  workspaceOverride: Partial<SmokeTestConfig> | null;
  effective: SmokeTestConfig;
  tools: SmokeToolStatus;
}

export async function fetchSmokeConfig(): Promise<SmokeConfigState> {
  const res = await fetch('/api/smoke/config');
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '读取冒烟测试配置失败' }));
    throw new Error(err.error || '读取冒烟测试配置失败');
  }
  return res.json();
}

export async function updateSmokeConfig(
  patch: Partial<SmokeTestConfig>
): Promise<SmokeConfigState & { ok: boolean }> {
  const res = await fetch('/api/smoke/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '保存冒烟测试配置失败' }));
    throw new Error(err.error || '保存冒烟测试配置失败');
  }
  return res.json();
}

export async function pickSmokeToolBinary(
  tool: 'textractor' | 'locale_emulator',
  initialPath?: string
): Promise<{ ok: boolean; canceled: boolean; path: string | null }> {
  const res = await fetch('/api/smoke/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, ...(initialPath ? { initialPath } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '选择工具路径失败' }));
    throw new Error(err.error || '选择工具路径失败');
  }
  return res.json();
}

export async function fetchChatForms(
  signal?: AbortSignal
): Promise<{ forms: ChatFormRecord[]; roster: unknown }> {
  const res = await fetch('/api/vn/forms', { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '读取角色确认表单失败' }));
    throw new Error(err.error || '读取角色确认表单失败');
  }
  return res.json();
}

export async function submitChatForm(
  formId: string,
  payload: {
    items: SubmitChatFormItemPayload[];
    dismissedNames?: string[];
    autoContinue?: boolean;
    model?: string;
  }
): Promise<SubmitChatFormResponse> {
  const res = await fetch(`/api/vn/forms/${encodeURIComponent(formId)}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({ error: '提交角色译名表单失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '提交角色译名表单失败', res.status, body.code);
  }
  return body;
}

export async function cancelChatFormRequest(
  formId: string
): Promise<{ ok: boolean; form: ChatFormRecord }> {
  const res = await fetch(`/api/vn/forms/${encodeURIComponent(formId)}/cancel`, {
    method: 'POST',
  });
  const body = await res.json().catch(() => ({ error: '取消角色确认表单失败' }));
  if (!res.ok) {
    throw new ApiRequestError(body.error || '取消角色确认表单失败', res.status, body.code);
  }
  return body;
}
