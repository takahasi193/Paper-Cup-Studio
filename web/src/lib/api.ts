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
  modelCount: number;
}

export interface ModelOption {
  key: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
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
  | 'completed'
  | 'error'
  | 'aborted'
  | 'unknown';

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

export interface SubagentTaskSummary {
  taskId: string;
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

export interface SessionHistoryState {
  sessionId: string | null;
  persisted: boolean;
  workspace: string;
  messages: PersistedChatMessage[];
  sessions: SessionSummary[];
  isRunning?: boolean;
  activeTurn?: ActiveTurnSnapshot | null;
  subagentTasks?: SubagentTaskSummary[];
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

export interface EngineeringBatchProgress {
  totalBatches: number;
  pendingBatches: number;
  savedPendingQa: number;
  qaPassed: number;
  qaFailed: number;
  totalRows: number;
  checkedInRows: number;
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
  rawStatus: string;
  hasUnpacked: boolean;
  hasBuild: boolean;
  skills?: string[];
  plan?: EngineeringPlanSummary | null;
  batchProgress?: EngineeringBatchProgress | null;
  checkpoints?: { count: number; latest: EngineeringCheckpointInfo | null } | null;
  postQa?: EngineeringPostQaSummary | null;
}

export async function fetchWorkspaces(): Promise<WorkspaceState> {
  const res = await fetch('/api/workspaces');
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
  workspacePath: string
): Promise<{ workspace: string; sessions: SessionSummary[] }> {
  const query = `?workspace=${encodeURIComponent(workspacePath)}`;
  const res = await fetch(`/api/workspaces/sessions${query}`);
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

export async function fetchEngineeringStatus(forceRefresh = false): Promise<EngineeringStatus> {
  const res = await fetch(forceRefresh ? '/api/engineering/status?refresh=1' : '/api/engineering/status');
  if (!res.ok) throw new Error('Failed to fetch engineering status');
  return res.json();
}

export async function startTurn(prompt: string, model?: string): Promise<{ ok: boolean }> {
  const res = await fetch('/api/turns/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to start turn' }));
    throw new Error(err.error || 'Failed to start turn');
  }
  return res.json();
}

export async function abortTurn(): Promise<{ ok: boolean; aborted: boolean }> {
  const res = await fetch('/api/turns/abort', {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to abort turn' }));
    throw new Error(err.error || 'Failed to abort turn');
  }
  return res.json();
}

export async function fetchModels(): Promise<ModelsState> {
  const res = await fetch('/api/models');
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
  customModel?: string
): Promise<ModelsState & ApiKeyDetectionMeta & { ok: boolean }> {
  const res = await fetch('/api/models/key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      apiKey,
      ...(customModel ? { customModel } : {}),
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

export async function fetchSessionHistory(): Promise<SessionHistoryState> {
  const res = await fetch('/api/session/history');
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

export async function fetchSubagentTaskDetail(taskId: string): Promise<SubagentTaskSnapshot> {
  const res = await fetch(`/api/subagents/tasks/${encodeURIComponent(taskId)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load subagent task detail' }));
    throw new Error(err.error || 'Failed to load subagent task detail');
  }
  return res.json();
}
