import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { BUILTIN_SUBAGENTS, SubagentProfile } from './roles.js';
import {
  applyPaperCupQueueModes,
  cloneQueueState,
  countQueuedMessages,
  createEmptyQueueState,
  type PendingQueueState,
  type QueuedMessageItem,
  type QueuedMessageMode,
  type QueueMutationResult,
  type RestoredDraftPayload,
  SessionQueueController,
} from '../agent/message-queue.js';
import {
  type ChatImageAttachment,
  DEFAULT_IMAGE_ONLY_PROMPT,
  extractImagesFromContent,
  modelSupportsImageInput,
  toPiImageContents,
} from '../agent/image-attachments.js';
import { wrapModelRuntimeWithReasoningOffFallback } from '../agent/reasoning-effort-fallback.js';
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
  type CompactionRole,
  type CompactionSummaryInfo,
} from '../agent/compaction.js';
import { config } from '../config.js';
import {
  createGuardedBuiltinToolDefinitions,
  readVnResearchConfig,
} from '../security/guarded-tools.js';
import { redactSecrets, redactUnknownValue } from '../security/secrets.js';
import { readWorkspaceTomlSection } from '../vn/profile.js';
import { WORKSPACE_TMP_RESERVED_SUBDIRS, resolveWorkspacePaths } from '../vn/workspace-paths.js';

export interface SubagentToolCallStat {
  tool: string;
  durationMs: number;
  isError: boolean;
}

export interface SubagentUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export type SubagentInterruptKind =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'auth_error'
  | 'aborted'
  | 'content_blocked'
  | 'timeout'
  | 'error';

const BUILTIN_ROLE_NAMES_LOWER = new Set(
  Object.keys(BUILTIN_SUBAGENTS).map((name) => name.toLowerCase())
);

export const DYNAMIC_SUBAGENT_FORBIDDEN_TOOLS = new Set([
  'vn_writeback',
  'vn_accept',
  'vn_release',
  'vn_apply',
  'vn_promote_skill',
  'vn_translate_batches',
  'vn_post_qa_parallel',
  'delegate_task',
  'create_subagent',
]);

export const DYNAMIC_SUBAGENT_ALLOWED_TOOLS = new Set([
  'read',
  'ls',
  'find',
  'grep',
  'write',
  'edit',
  'bash',
  'vn_detect',
  'vn_status',
  'vn_qa',
  'vn_learn_skill',
]);

const GUARDED_EXECUTION_TOOLS = new Set(['bash', 'write', 'edit', 'vn_learn_skill', 'vn_patch_font']);

export function requiresResearchGuardrails(roleName: string, allowedTools?: readonly string[]): boolean {
  if (roleName === 'reverser') return true;
  return Boolean(allowedTools?.some((tool) => GUARDED_EXECUTION_TOOLS.has(tool)));
}

function validateDynamicSubagentInput(
  rawName: string,
  rawAllowedTools?: readonly string[]
): { ok: true; name: string; allowedTools: string[] } | { ok: false; error: string } {
  const name = String(rawName ?? '').trim();
  if (!name) {
    return { ok: false, error: 'Subagent role name cannot be empty.' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return {
      ok: false,
      error: `Invalid subagent role name '${name}': use 1-64 alphanumeric, '-' or '_' characters.`,
    };
  }
  if (BUILTIN_ROLE_NAMES_LOWER.has(name.toLowerCase())) {
    return {
      ok: false,
      error: `Cannot overwrite built-in subagent role '${name}'. Choose a distinct custom role name.`,
    };
  }
  const normalizedTools: string[] = [];
  const seen = new Set<string>();
  const forbidden: string[] = [];
  const unapproved: string[] = [];
  for (const rawTool of rawAllowedTools ?? []) {
    const tool = String(rawTool ?? '').trim();
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    if (DYNAMIC_SUBAGENT_FORBIDDEN_TOOLS.has(tool)) {
      forbidden.push(tool);
    } else if (!DYNAMIC_SUBAGENT_ALLOWED_TOOLS.has(tool)) {
      unapproved.push(tool);
    } else {
      normalizedTools.push(tool);
    }
  }
  if (forbidden.length > 0) {
    return {
      ok: false,
      error: `Disallowed privileged tool(s) for dynamic subagent '${name}': ${forbidden.join(', ')}.`,
    };
  }
  if (unapproved.length > 0) {
    return {
      ok: false,
      error: `Tool(s) not in dynamic subagent allowlist for '${name}': ${unapproved.join(', ')}. Allowed: ${Array.from(DYNAMIC_SUBAGENT_ALLOWED_TOOLS).join(', ')}.`,
    };
  }
  return { ok: true, name, allowedTools: normalizedTools };
}

export function classifySubagentError(
  message: string,
  isAborted = false
): { kind: SubagentInterruptKind; fatalForPool: boolean } {
  const raw = String(message || '').trim();
  const lower = raw.toLowerCase();
  if (
    /insufficient[\s_-]*(?:balance|quota)|setlimitexceeded|exceeded your current quota|quota[\s_-]*exceeded|resource[\s_-]*exhausted|credit[\s_-]*balance|billing|(?:http|status|code|error)\s*[:=]?\s*402\b|\b402\s+payment\b|余额不足|额度(?:已用尽|不足)|配额(?:已用尽|不足)|账户欠费/i.test(
      raw
    )
  ) {
    return { kind: 'quota_exhausted', fatalForPool: true };
  }
  if (
    /(?:http|status|code|error)\s*[:=]?\s*(?:401|403)\b|\b(?:401|403)\s+(?:unauthorized|forbidden)\b|\bunauthorized\b|invalid[\s_-]*api[\s_-]*key|authentication\s+failed|api[\s_-]*key.*(?:invalid|expired|revoked|permission)|(?:鉴权|认证)失败|无效.*api[\s_-]*key/i.test(
      raw
    )
  ) {
    return { kind: 'auth_error', fatalForPool: true };
  }
  if (
    isAborted ||
    /\b(?:subagent execution aborted|request aborted|request was aborted|operation was aborted|this operation was aborted|turn aborted|batch translation aborted|post-qa review aborted|aborted by user)\b|已(?:手动)?中止|强制停止/i.test(
      raw
    )
  ) {
    return { kind: 'aborted', fatalForPool: true };
  }
  if (/rate[\s_-]*limit|too many requests|(?:http|status|code|error)\s*[:=]?\s*429\b|\b429\s+too many\b/i.test(lower)) {
    return { kind: 'rate_limited', fatalForPool: false };
  }
  if (
    /inappropriate content|content moderation|content_filter|data_inspection_failed|usage guidelines|policy violation|request blocked|i can'?t translate this|cannot translate this|i have to stop here|sexual content involving|unsafe content|safety policy/i.test(
      lower
    )
  ) {
    return { kind: 'content_blocked', fatalForPool: false };
  }
  if (/timeout|timed out|connect timeout|econnreset|etimedout|other side closed/i.test(lower)) {
    return { kind: 'timeout', fatalForPool: false };
  }
  return { kind: 'error', fatalForPool: false };
}

function resolveAbortReason(signal?: AbortSignal, ...fallbacks: Array<string | undefined>): string {
  const rawReason = (signal as any)?.reason;
  const signalText =
    typeof rawReason === 'string'
      ? rawReason.trim()
      : rawReason instanceof Error
        ? rawReason.message.trim()
        : '';
  const meaningfulSignal =
    signalText && !/^(?:abort(?:error)?|this operation was aborted)$/i.test(signalText)
      ? signalText
      : '';
  for (const candidate of [meaningfulSignal, ...fallbacks]) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (trimmed) {
      return /\babort|中止|熔断|上限|超时/i.test(trimmed) ? trimmed : `Subagent execution aborted: ${trimmed}`;
    }
  }
  return 'Subagent execution aborted.';
}

export interface SubagentRunMetrics {
  timestamp: string;
  sessionId?: string | null;
  taskId?: string;
  role: string;
  model: string | null;
  thinkingLevel: string;
  status: 'success' | 'error' | 'aborted';
  interruptKind?: SubagentInterruptKind;
  stopReason: string | null;
  durationMs: number;
  usage: SubagentUsageStats;
  toolCalls: SubagentToolCallStat[];
  responseChars: number;
  error?: string;
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
  compaction?: {
    reason: CompactionReason;
    tokensBefore: number;
    tokensAfter: number;
    focus?: string;
    checkpointPath?: string;
  };
}

export interface SubagentUserSteerNote {
  mode: QueuedMessageMode;
  text: string;
  timestamp: string;
}

export interface SubagentStreamDeltaEvent {
  taskId: string;
  threadId: string;
  sessionId: string | null;
  role: string;
  messageId: string;
  kind: 'thinking' | 'text';
  delta: string;
  seq: number;
  offset: number;
  endOffset: number;
}

export type SubagentStreamDeltaListener = (event: SubagentStreamDeltaEvent) => void;

export interface SubagentQueueUpdatedEvent {
  taskId: string;
  threadId: string;
  sessionId: string | null;
  role: string;
  queue: PendingQueueState;
}

export type SubagentQueueUpdatedListener = (event: SubagentQueueUpdatedEvent) => void;

export interface SubagentQueueRestoredEvent {
  taskId: string;
  threadId: string;
  sessionId: string | null;
  role: string;
  restoredDraft: RestoredDraftPayload;
  reason: 'aborted' | 'error';
}

export type SubagentQueueRestoredListener = (event: SubagentQueueRestoredEvent) => void;

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
  interruptKind?: SubagentInterruptKind;
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
  queuedCompaction?: { focus?: string } | null;
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
  usage: SubagentUsageStats;
  toolCalls: SubagentTaskToolEvent[];
  responsePreview: string;
  messages?: SubagentChatMessage[];
  pendingQueue?: PendingQueueState;
}

export type SubagentTaskUpdatedListener = (
  summary: SubagentTaskSummary,
  snapshot: SubagentTaskSnapshot
) => void;

export interface SubagentUsageDeltaEvent {
  sessionId: string | null;
  taskId: string;
  role: string;
  usageKind: string;
  provider: string;
  model: string;
  usage: Usage;
}

export type SubagentUsageListener = (event: SubagentUsageDeltaEvent) => void;

export interface SubagentSessionOptions {
  cwd: string;
  model?: any;
  modelRuntime?: any;
  thinkingLevel?: ThinkingLevel;
  customTools?: ToolDefinition[];
  getKnownSecrets?: () => Iterable<string>;
}

export interface SubagentRunOptions extends SubagentSessionOptions {
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  sessionId?: string | null;
  parentCallId?: string;
  taskId?: string;
  resumeTaskId?: string;
  origin?: 'delegated' | 'direct_user';
  images?: ChatImageAttachment[];
  recordDiagnostics?: boolean;
  onTaskUpdated?: SubagentTaskUpdatedListener;
  onStreamDelta?: SubagentStreamDeltaListener;
  usageKind?: string;
  onUsage?: SubagentUsageListener;
}

export interface SubagentRunResult {
  taskId: string;
  text: string;
  metrics: SubagentRunMetrics;
  snapshot: SubagentTaskSnapshot;
  resumed?: boolean;
  resumedFromTaskId?: string;
  resumeFallback?: boolean;
  resumable?: boolean;
  deliveredSkillOrScript?: boolean;
  noDeliverableRounds?: number;
  gatekeeperNotice?: string;
  userSteeredNotes?: SubagentUserSteerNote[];
}

export interface SubagentCompactResult {
  ok: true;
  status: 'compacted' | 'noop' | 'queued';
  taskId: string;
  result?: CompactionSummaryInfo;
  message?: string;
  focus?: string;
}

export interface ManagedSubagentSession {
  role: string;
  model: string | null;
  prompt: (
    task: string,
    runOptions?: {
      onDelta?: (delta: string) => void;
      signal?: AbortSignal;
      sessionId?: string | null;
      parentCallId?: string;
      taskId?: string;
      threadId?: string;
      resumedFromTaskId?: string;
      priorMessages?: SubagentChatMessage[];
      priorCompactionCount?: number;
      origin?: 'delegated' | 'direct_user';
      images?: ChatImageAttachment[];
      displayTaskPrompt?: string;
      recordDiagnostics?: boolean;
      onTaskUpdated?: SubagentTaskUpdatedListener;
      onStreamDelta?: SubagentStreamDeltaListener;
      usageKind?: string;
      onUsage?: SubagentUsageListener;
    }
  ) => Promise<SubagentRunResult>;
  compact?: (focus?: string) => Promise<{
    result: any;
    summaryInfo: CompactionSummaryInfo;
    contextUsage: {
      tokens: number | null;
      contextWindow: number;
      percent: number | null;
      triggerTokens?: number;
    } | null;
  }>;
  getContextUsage?: () => {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    triggerTokens?: number;
  } | null;
  waitForIdle?: () => Promise<void>;
  canResume?: () => boolean;
  dispose: () => void;
}

interface ToolOutcomeMeta {
  isError: boolean;
  resultSummary?: string;
  fullResultText?: string;
  savedOutputPath?: string;
  producedArtifact?: string;
}

interface ActiveSubagentRunContext {
  cwd: string;
  session: any;
  snapshot: SubagentTaskSnapshot;
  recordDiagnostics: boolean;
  getKnownSecrets?: () => Iterable<string>;
  onTaskUpdated?: SubagentTaskUpdatedListener;
  toolOutcomeByCallId: Map<string, ToolOutcomeMeta>;
  queueController: SessionQueueController;
  userSteeredNotes: SubagentUserSteerNote[];
  pendingRestoredDraft: RestoredDraftPayload | null;
  restoredDraftEmitted: boolean;
  emitQueueUpdate: () => void;
  lastPersistAtMs: number;
  finalized: boolean;
  budgetMaxToolCalls?: number;
  budgetHardStopFailures?: number;
  budgetMaxStallCalls?: number;
  budgetMaxNoDeliverableCompactions?: number;
  budgetMaxTokens?: number;
  callsSinceProgress: number;
  lastStallTurnKey?: string;
  lastSoftStallRemindAt: number;
  callsSinceDeliverable: number;
  lastDeliverableTurnKey?: string;
  lastNoDeliverableRemindAt: number;
  compactionsSinceDeliverable: number;
  pendingCompactionWarning?: string;
  knownEngineHintDetected: boolean;
  recallFirstNoticed: boolean;
  recallLoggedInRun: boolean;
  tmpTextReadCount: number;
  scratchScriptPaths: Set<string>;
  deliveredSkillOrScript: boolean;
  budgetResumable?: boolean;
  budgetAbortReason?: string;
  budgetTimer?: ReturnType<typeof setTimeout>;
  queuedCompaction?: { focus?: string } | null;
  finalize: (status: SubagentTaskStatus, activityState: SubagentActivityState, errorMsg?: string) => void;
}

interface ResumableSubagentEntry {
  taskId: string;
  role: string;
  cwd: string;
  cwdKey: string;
  modelKey: string | null;
  managed: ManagedSubagentSession;
  resumeCount: number;
  noDeliverableRounds: number;
  createdAtMs: number;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

const TOOL_CALL_MARKUP_RE = /<tool_call\b|<\/tool_call>|<function\s*=|<\/function>|<invoke\b/i;
const MAX_TASK_PROMPT_CHARS = 4000;
const MAX_RESPONSE_PREVIEW_CHARS = 12000;
const MAX_RESULT_SUMMARY_CHARS = 800;
const MAX_ARGS_STRING_CHARS = 1200;
const DELTA_PERSIST_INTERVAL_MS = 800;
const MAX_MEMORY_TASKS_PER_CWD = 120;
const DEFAULT_RESUMABLE_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_RESUMABLE_SESSIONS = 6;
export const MAX_RESUMES_PER_TASK = 3;
export const MAX_REVERSER_NO_DELIVERABLE_ROUNDS = 3;
const MAX_SUBAGENT_THINKING_CHARS = 16 * 1024;
const MAX_SUBAGENT_TOOL_RESULT_CHARS = 8 * 1024;
const MAX_SUBAGENT_TEXT_CHARS = 24 * 1024;
const MAX_SUBAGENT_MESSAGES = 80;
const SUBAGENT_STREAM_THROTTLE_MS = 90;
const STREAM_TRUNCATION_MARKER = '\n…[已按上限裁剪]';
export const TRANSLATOR_PROGRESS_EMIT_INTERVAL_MS = 500;

export function extractTranslatorBatchMeta(taskPrompt: string): {
  batchId?: string;
  expectedRows?: number;
} {
  const match = /<batch\b([^>]*)>/i.exec(String(taskPrompt || ''));
  if (!match) return {};
  const attrs = match[1] || '';
  const idMatch = /\bid=["']([^"']+)["']/i.exec(attrs);
  const rowsMatch = /\brows=["'](\d+)["']/i.exec(attrs);
  const batchId = idMatch?.[1]?.trim() || undefined;
  const parsedRows = rowsMatch ? Number(rowsMatch[1]) : NaN;
  const expectedRows = Number.isFinite(parsedRows) && parsedRows > 0 ? parsedRows : undefined;
  return {
    ...(batchId ? { batchId } : {}),
    ...(expectedRows !== undefined ? { expectedRows } : {}),
  };
}

export function formatTranslatorProgressSummary(state: {
  phase: 'thinking' | 'generating' | 'done';
  batchId?: string;
  expectedRows?: number;
  thinkingChars: number;
  outputChars: number;
  completedLines: number;
}): string {
  const prefix = state.batchId ? `${state.batchId} · ` : '';
  const lineLabel = state.expectedRows
    ? `${state.completedLines}/${state.expectedRows} 行`
    : `${state.completedLines} 行`;
  if (state.phase === 'thinking') {
    return `${prefix}思考中（已生成 ${state.thinkingChars} 字符）`;
  }
  if (state.phase === 'generating') {
    return `${prefix}生成译文中（已译 ${lineLabel} · ${state.outputChars} 字符）`;
  }
  const thinkSuffix = state.thinkingChars > 0 ? ` · 思考 ${state.thinkingChars} 字` : '';
  return `${prefix}已返回译文（${lineLabel} · ${state.outputChars} 字符${thinkSuffix}）`;
}

function hasBalancedSessionHistory(session: any): boolean {
  const msgs: any[] = session?.messages ?? session?.agent?.state?.messages;
  if (!Array.isArray(msgs)) return true;
  const pendingIds = new Set<string>();
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      if (pendingIds.size > 0) return false;
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b && b.type === 'toolCall' && b.id) {
          pendingIds.add(String(b.id));
        }
      }
    } else if (m.role === 'toolResult') {
      if (m.toolCallId) pendingIds.delete(String(m.toolCallId));
    }
  }
  return pendingIds.size === 0;
}

function addNumber(target: number, value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? target + value : target;
}

function normalizeWorkspaceKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function generateTaskId(roleName: string): string {
  const safeRole = roleName.replace(/[^A-Za-z0-9_-]+/g, '_') || 'subagent';
  return `subtask-${safeRole}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function clipText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function clipTailText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

function boundUnknownArgs(value: unknown, getKnownSecrets?: () => Iterable<string>): unknown {
  const redacted = redactUnknownValue(value, getKnownSecrets?.());
  if (typeof redacted === 'string') {
    return clipText(redacted, MAX_ARGS_STRING_CHARS);
  }
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return redacted;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(redacted as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = clipText(v, MAX_ARGS_STRING_CHARS);
    } else if (Array.isArray(v) && v.length > 20) {
      out[k] = [...v.slice(0, 20), `...(${v.length - 20} more)`];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summarizeArgs(args: unknown, getKnownSecrets?: () => Iterable<string>): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const preferredKeys = ['command', 'path', 'engine', 'archive', 'skill', 'pattern'];
  for (const key of preferredKeys) {
    const val = record[key];
    if (typeof val === 'string' && val.trim()) {
      const cleaned = redactSecrets(val.trim().replace(/\s+/g, ' '), getKnownSecrets?.());
      return clipText(cleaned, 140);
    }
  }
  for (const val of Object.values(record)) {
    if (typeof val === 'string' && val.trim()) {
      const cleaned = redactSecrets(val.trim().replace(/\s+/g, ' '), getKnownSecrets?.());
      return clipText(cleaned, 140);
    }
  }
  try {
    return clipText(redactSecrets(JSON.stringify(record), getKnownSecrets?.()), 140);
  } catch {
    return '';
  }
}

function extractResultText(res: any, getKnownSecrets?: () => Iterable<string>): string {
  if (!res || typeof res !== 'object') return '';
  const content: any[] = Array.isArray(res.content) ? res.content : [];
  const joined = content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
  return redactSecrets(joined, getKnownSecrets?.());
}

function resolveRelativeArtifact(cwd: string, rawPath: unknown): string | undefined {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined;
  const trimmed = rawPath.trim();
  const base = path.resolve(cwd);
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(base, trimmed);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return trimmed.replace(/\\/g, '/');
  }
  return rel.replace(/\\/g, '/');
}

export const REVERSER_SOFT_STALL_REMIND_INTERVAL = 18;
export const REVERSER_NO_DELIVERABLE_REMIND_INTERVAL = 30;
export const REVERSER_TMP_READ_REMIND_FIRST = 3;
export const REVERSER_TMP_READ_REMIND_STEP = 6;
export const REVERSER_SCRATCH_SCRIPT_SPRAWL_FIRST = 4;
export const REVERSER_SCRATCH_SCRIPT_SPRAWL_STEP = 4;

const REVERSER_DELIVERABLE_SCRIPT_BASENAMES = new Set([
  'unpack.py',
  'repack.py',
  'extract.py',
  'apply.py',
]);

const TMP_SCRATCH_SCRIPT_EXTS = new Set(['.py', '.js', '.mjs', '.ts', '.sh']);

const TMP_SCRATCH_TEXT_EXTS = new Set([
  '.txt',
  '.log',
  '.out',
  '.md',
  '.tsv',
  '.csv',
  '.hex',
  '.asm',
  '.disasm',
  '.json',
  '.jsonl',
]);

function normalizeWorkspaceRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').trim();
}

function isReservedPapercupTmpSubdir(lowerRel: string): boolean {
  if (!lowerRel.startsWith('.papercup/tmp/')) return false;
  const rest = lowerRel.slice('.papercup/tmp/'.length);
  const firstSeg = rest.split('/')[0];
  return Boolean(firstSeg && WORKSPACE_TMP_RESERVED_SUBDIRS.has(firstSeg));
}

/**
 * Distinguishes real reverser milestones (research docs, packaged skills, or deliverable
 * unpack/repack/extract/apply scripts) from repeated overwrites of scratch probe scripts
 * under `.papercup/tmp/`, preventing scratch rewrites from resetting stall counters.
 */
export function isMeaningfulReverserArtifactPath(relPath: string): boolean {
  const norm = normalizeWorkspaceRelPath(relPath);
  if (!norm) return false;
  const lower = norm.toLowerCase();
  if (lower === '.papercup/tmp' || lower.startsWith('.papercup/tmp/')) {
    if (isReservedPapercupTmpSubdir(lower)) return false;
    const base = path.posix.basename(lower);
    return REVERSER_DELIVERABLE_SCRIPT_BASENAMES.has(base);
  }
  return true;
}

/**
 * Detects reads of temporary probe text/dump outputs under `.papercup/tmp/`
 * (excluding `.py` source files and reserved Paper Cup cache subdirs such as
 * `.papercup/tmp/unpacked/`, `.papercup/tmp/diagnostics/`, `.papercup/tmp/smoke/`, `.papercup/tmp/work/`).
 */
export function isTmpScratchTextReadPath(relPath: string): boolean {
  const norm = normalizeWorkspaceRelPath(relPath);
  if (!norm) return false;
  const lower = norm.toLowerCase();
  if (!lower.startsWith('.papercup/tmp/')) return false;
  if (isReservedPapercupTmpSubdir(lower)) return false;
  const ext = path.posix.extname(lower);
  return TMP_SCRATCH_TEXT_EXTS.has(ext);
}

export function shouldEmitTmpReadStdoutNotice(tmpTextReadCount: number): boolean {
  if (tmpTextReadCount < REVERSER_TMP_READ_REMIND_FIRST) return false;
  if (tmpTextReadCount === REVERSER_TMP_READ_REMIND_FIRST) return true;
  return (tmpTextReadCount - REVERSER_TMP_READ_REMIND_FIRST) % REVERSER_TMP_READ_REMIND_STEP === 0;
}

export function shouldEmitSoftStallNotice(callsSinceProgress: number, lastSoftStallRemindAt: number): boolean {
  return (
    callsSinceProgress >= REVERSER_SOFT_STALL_REMIND_INTERVAL &&
    callsSinceProgress % REVERSER_SOFT_STALL_REMIND_INTERVAL === 0 &&
    lastSoftStallRemindAt !== callsSinceProgress
  );
}

export function isTmpScratchScriptPath(relPath: string): boolean {
  const norm = normalizeWorkspaceRelPath(relPath);
  if (!norm) return false;
  const lower = norm.toLowerCase();
  if (!lower.startsWith('.papercup/tmp/')) return false;
  if (isReservedPapercupTmpSubdir(lower)) return false;
  const ext = path.posix.extname(lower);
  if (!TMP_SCRATCH_SCRIPT_EXTS.has(ext)) return false;
  const base = path.posix.basename(lower);
  return !REVERSER_DELIVERABLE_SCRIPT_BASENAMES.has(base);
}

export function shouldEmitScratchScriptSprawlNotice(distinctScratchScriptCount: number): boolean {
  if (distinctScratchScriptCount < REVERSER_SCRATCH_SCRIPT_SPRAWL_FIRST) return false;
  if (distinctScratchScriptCount === REVERSER_SCRATCH_SCRIPT_SPRAWL_FIRST) return true;
  return (distinctScratchScriptCount - REVERSER_SCRATCH_SCRIPT_SPRAWL_FIRST) % REVERSER_SCRATCH_SCRIPT_SPRAWL_STEP === 0;
}

export function isReverserDeliverableProgressArtifact(relPath: string): boolean {
  const norm = normalizeWorkspaceRelPath(relPath);
  if (!norm) return false;
  const lower = norm.toLowerCase();
  if (lower.startsWith('.papercup/skills/')) return true;
  if (lower.startsWith('.papercup/data/vn/fonts/')) return true;
  if (lower === '.papercup/tmp' || lower.startsWith('.papercup/tmp/')) {
    if (isReservedPapercupTmpSubdir(lower)) return false;
    const base = path.posix.basename(lower);
    return REVERSER_DELIVERABLE_SCRIPT_BASENAMES.has(base);
  }
  return false;
}

export function shouldEmitNoDeliverableNotice(
  callsSinceDeliverable: number,
  lastRemindAt: number
): boolean {
  return (
    callsSinceDeliverable >= REVERSER_NO_DELIVERABLE_REMIND_INTERVAL &&
    callsSinceDeliverable % REVERSER_NO_DELIVERABLE_REMIND_INTERVAL === 0 &&
    callsSinceDeliverable > lastRemindAt
  );
}

export function detectKnownEngineHintInText(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return /(?:^|\n)hint\s+[a-z0-9_-]+/i.test(text);
}

export function hasResearchRecallHypotheses(cwd: string): boolean {
  try {
    const researchDir = resolveWorkspacePaths(cwd).researchDir;
    if (!fs.existsSync(researchDir) || !fs.statSync(researchDir).isDirectory()) {
      return false;
    }
    for (const ent of fs.readdirSync(researchDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const hypPath = path.join(researchDir, ent.name, '02-hypotheses.md');
      if (!fs.existsSync(hypPath) || !fs.statSync(hypPath).isFile()) continue;
      const body = fs.readFileSync(hypPath, 'utf8').trim();
      if (body.length > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isResearchHypothesesPath(relPath: string): boolean {
  const norm = normalizeWorkspaceRelPath(relPath).toLowerCase();
  return norm.startsWith('.papercup/research/') && norm.endsWith('/02-hypotheses.md');
}

function extractBashScriptTargetPaths(command: string): string[] {
  const matches = command.match(/(?:^|[\s"'=])((?:\.\/)?\.papercup\/tmp\/[^\s"'`|;&>]+)/gi);
  if (!matches) return [];
  return matches.map((m) => m.replace(/^[\s"'=]+/, ''));
}

function buildReverserGatekeeperNotice(
  canResume: boolean,
  nextNoDeliverableRounds: number,
  nextResumeCount: number,
  hitNoDeliverableLimit: boolean,
  hitResumeLimit: boolean,
  suppress: boolean
): string | undefined {
  if (suppress) return undefined;
  if (!canResume && (hitNoDeliverableLimit || hitResumeLimit)) {
    return `\n[reverser_gatekeeper resumable=false] 本线程已连续 ${nextNoDeliverableRounds} 轮未产出新的交付脚本或通过 vn_learn_skill（续跑次数 ${nextResumeCount}/${MAX_RESUMES_PER_TASK}），已关闭续跑。请停止继续委派并直接向用户汇报已验证事实、已证伪假设、精确阻塞点与所需外部条件（或建议切换更强模型）。`;
  }
  if (canResume && nextNoDeliverableRounds >= 2) {
    return `\n[reverser_gatekeeper] 本线程已连续 ${nextNoDeliverableRounds} 轮未产出新的交付脚本或通过 vn_learn_skill；请勿注入猜测性编码假说，仅在存在明确未验证的字节突破口时再续跑，否则请直接向用户汇报阻塞点。`;
  }
  return undefined;
}

function inferSubagentStage(roleName: string, toolName?: string, args?: unknown): string {
  if (roleName === 'translator') return 'translate';
  if (roleName === 'role-checker') return 'review';
  if (!toolName) return 'starting';
  if (toolName === 'vn_detect') return 'detect';
  if (toolName === 'vn_learn_skill') return 'verify_skill';
  if (toolName === 'vn_re_lookup') return 'research';
  if (toolName === 'vn_re_inspect' || toolName === 'vn_re_trace') return 'inspect';
  if (toolName === 'write' || toolName === 'edit') {
    const p = typeof (args as any)?.path === 'string' ? (args as any).path.replace(/\\/g, '/') : '';
    if (p.includes('.papercup/research')) return 'document_research';
    if (p.endsWith('.py')) return 'script_write';
    return 'write_file';
  }
  if (toolName === 'bash' || toolName === 'read' || toolName === 'ls' || toolName === 'find') {
    return 'inspect';
  }
  return toolName;
}

function clipBoundedStreamField(current: string, delta: string, maxChars: number): string {
  if (!delta) return current;
  if (current.endsWith(STREAM_TRUNCATION_MARKER)) return current;
  const combined = current + delta;
  if (combined.length <= maxChars) return combined;
  const bodyCap = Math.max(0, maxChars - STREAM_TRUNCATION_MARKER.length);
  return `${combined.slice(0, bodyCap)}${STREAM_TRUNCATION_MARKER}`;
}

function readSessionContextUsage(
  session: any,
  roleName?: string
): { tokens: number | null; contextWindow: number; percent: number | null; triggerTokens?: number } | null {
  try {
    const raw = session?.getContextUsage?.();
    if (raw && typeof raw.contextWindow === 'number' && raw.contextWindow > 0) {
      let tokens: number | null = typeof raw.tokens === 'number' ? raw.tokens : null;
      let percent: number | null = typeof raw.percent === 'number' ? raw.percent : null;
      const sm = session?.sessionManager;
      if (
        tokens !== null &&
        sm &&
        typeof sm.getBranch === 'function' &&
        typeof sm.buildSessionProjection === 'function'
      ) {
        const branch = sm.getBranch();
        if (hasPostUsageContextEdit(branch)) {
          const realTokens = estimateRealProjectedContextTokens(sm.buildSessionProjection(), branch);
          tokens = realTokens;
          percent = (realTokens / raw.contextWindow) * 100;
        }
      }
      let triggerTokens: number | undefined;
      if (roleName && roleName !== 'translator') {
        const compactionCfg = readPaperCupCompactionConfig();
        if (compactionCfg.enabled) {
          const compactRole: CompactionRole = roleName === 'reverser' ? 'reverser' : 'subagent';
          triggerTokens = computeCompactionThresholds(raw.contextWindow, compactRole, compactionCfg).triggerTokens;
        }
      }
      return {
        tokens,
        contextWindow: raw.contextWindow,
        percent,
        ...(triggerTokens !== undefined ? { triggerTokens } : {}),
      };
    }
  } catch {
    // Ignore context probe errors
  }
  return null;
}

function isCompactionNoopError(message?: string | null): boolean {
  return Boolean(message && /nothing to compact|already compacted|session too small/i.test(message));
}

function buildCompactionSummaryFromSession(
  session: any,
  result: any,
  reason: CompactionReason,
  focus?: string
): CompactionSummaryInfo {
  const branch: any[] = session?.sessionManager?.getBranch?.() ?? [];
  let latestEntry: any = null;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (branch[i]?.type === 'compaction') {
      latestEntry = branch[i];
      break;
    }
  }
  if (latestEntry) {
    const extracted = extractCompactionSummaryInfo(latestEntry, result?.estimatedTokensAfter);
    const resolvedFocus = extracted.focus ?? (focus?.trim() || undefined);
    return {
      ...extracted,
      reason,
      ...(resolvedFocus ? { focus: resolvedFocus } : {}),
    };
  }
  const summary = typeof result?.summary === 'string' ? result.summary : '';
  const tokensBefore =
    typeof result?.tokensBefore === 'number' && Number.isFinite(result.tokensBefore)
      ? Math.max(0, Math.floor(result.tokensBefore))
      : 0;
  const detailsTokensAfter =
    typeof result?.details?.tokensAfter === 'number' && Number.isFinite(result.details.tokensAfter)
      ? Math.max(0, Math.floor(result.details.tokensAfter))
      : undefined;
  const tokensAfter =
    detailsTokensAfter ??
    (typeof result?.estimatedTokensAfter === 'number' && Number.isFinite(result.estimatedTokensAfter)
      ? Math.max(0, Math.floor(result.estimatedTokensAfter))
      : Math.ceil(summary.length / 4));
  const resolvedFocus =
    (typeof result?.details?.focus === 'string' && result.details.focus.trim()
      ? result.details.focus.trim()
      : undefined) ?? (focus?.trim() || undefined);
  const checkpointPath =
    typeof result?.details?.checkpointPath === 'string' && result.details.checkpointPath.trim()
      ? result.details.checkpointPath.trim()
      : undefined;
  const prunedCount =
    typeof result?.details?.prunedCount === 'number' && Number.isFinite(result.details.prunedCount) && result.details.prunedCount > 0
      ? Math.floor(result.details.prunedCount)
      : undefined;
  return {
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

function normalizeUsageRecord(rawUsage: any): {
  usage: Usage;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoning?: number;
} | null {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const input = addNumber(0, rawUsage.input);
  const output = addNumber(0, rawUsage.output);
  const cacheRead = addNumber(0, rawUsage.cacheRead);
  const cacheWrite = addNumber(0, rawUsage.cacheWrite);
  const rawTotal = addNumber(0, rawUsage.totalTokens);
  const totalTokens = rawTotal > 0 ? rawTotal : input + output + cacheRead + cacheWrite;
  if (totalTokens <= 0 && input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) {
    return null;
  }
  const rawReasoning = rawUsage.reasoning ?? rawUsage.reasoningTokens;
  const reasoning =
    typeof rawReasoning === 'number' && Number.isFinite(rawReasoning) && rawReasoning >= 0
      ? rawReasoning
      : undefined;
  const rawCost = rawUsage.cost && typeof rawUsage.cost === 'object' ? rawUsage.cost : {};
  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens,
    cost: {
      input: addNumber(0, rawCost.input),
      output: addNumber(0, rawCost.output),
      cacheRead: addNumber(0, rawCost.cacheRead),
      cacheWrite: addNumber(0, rawCost.cacheWrite),
      total: addNumber(0, rawCost.total),
    },
  };
  return { usage, input, output, cacheRead, cacheWrite, totalTokens, reasoning };
}

function cloneChatMessages(messages?: SubagentChatMessage[]): SubagentChatMessage[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.map((m) => ({
    ...m,
    ...(Array.isArray(m.images) && m.images.length > 0
      ? { images: m.images.map((img) => ({ ...img })) }
      : {}),
    ...(m.role === 'assistant'
      ? {
          contentOffset: m.content.length,
          ...(m.thinking !== undefined ? { thinkingOffset: m.thinking.length } : {}),
        }
      : {}),
    ...(Array.isArray(m.tools) ? { tools: m.tools.map((t) => ({ ...t })) } : {}),
    ...(m.compaction ? { compaction: { ...m.compaction } } : {}),
  }));
}

function pushBoundedChatMessage(messages: SubagentChatMessage[], next: SubagentChatMessage): SubagentChatMessage[] {
  const updated = [...messages, next];
  if (updated.length <= MAX_SUBAGENT_MESSAGES) return updated;
  return updated.slice(-MAX_SUBAGENT_MESSAGES);
}

function buildLegacyFallbackMessages(snapshot: SubagentTaskSnapshot): SubagentChatMessage[] {
  const out: SubagentChatMessage[] = [];
  if (snapshot.taskPrompt) {
    out.push({
      id: `${snapshot.taskId}-legacy-u`,
      role: 'user',
      content: snapshot.taskPrompt,
      timestamp: snapshot.startedAt,
      turnTaskId: snapshot.taskId,
      origin: 'delegated',
    });
  }
  const hasTools = Array.isArray(snapshot.toolCalls) && snapshot.toolCalls.length > 0;
  if (snapshot.responsePreview || snapshot.error || hasTools) {
    out.push({
      id: `${snapshot.taskId}-legacy-a`,
      role: 'assistant',
      content: snapshot.responsePreview || snapshot.error || '已完成任务。',
      ...(hasTools
        ? {
            tools: snapshot.toolCalls.map((tc) => ({
              callId: tc.callId,
              tool: tc.tool,
              ...(tc.args !== undefined ? { args: tc.args } : {}),
              ...(tc.resultSummary ? { result: tc.resultSummary } : {}),
              ...(tc.isError ? { isError: tc.isError } : {}),
              status: tc.status,
              ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
              ...(tc.savedOutputPath ? { savedOutputPath: tc.savedOutputPath } : {}),
              ...(tc.producedArtifact ? { producedArtifact: tc.producedArtifact } : {}),
            })),
          }
        : {}),
      timestamp: snapshot.endedAt || snapshot.lastActivityAt,
      error: snapshot.status === 'error' || snapshot.status === 'aborted',
      turnTaskId: snapshot.taskId,
    });
  }
  return out;
}

function buildCompactResumeContextNote(requestedResumeId: string, priorSnap: SubagentTaskSnapshot | null): string {
  const lines = [
    `[Note: previous session ${requestedResumeId} expired or unavailable; starting a fresh session — read saved artifacts in .papercup/research/ once.]`,
  ];
  if (!priorSnap) return lines[0];
  if (priorSnap.artifacts.length > 0) {
    lines.push(`Prior artifacts: ${priorSnap.artifacts.slice(-10).join(', ')}`);
  }
  const priorMsgs =
    Array.isArray(priorSnap.messages) && priorSnap.messages.length > 0
      ? priorSnap.messages
      : buildLegacyFallbackMessages(priorSnap);
  const recent = priorMsgs.slice(-4);
  if (recent.length > 0) {
    lines.push('Recent prior exchanges:');
    for (const m of recent) {
      const label = m.role === 'user' ? 'User' : m.role === 'compaction' ? 'Compaction' : 'Assistant';
      const body = clipText(String(m.content || '').replace(/\s+/g, ' ').trim(), 700);
      if (body) lines.push(`- ${label}: ${body}`);
    }
  }
  return clipText(lines.join('\n'), 3500);
}

function extractUserMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

function formatUserSteeredSubagentNote(
  notes?: readonly SubagentUserSteerNote[],
  getKnownSecrets?: () => Iterable<string>
): string {
  if (!notes || notes.length === 0) return '';
  const secrets = getKnownSecrets?.();
  const compactParts = notes.slice(-3).map((n) => {
    const tag = n.mode === 'steer' ? 'steer' : 'followUp';
    const body = clipText(redactSecrets(n.text.replace(/\s+/g, ' ').trim(), secrets), 80);
    return `${tag}:${body}`;
  });
  const combined = clipText(compactParts.join(' | '), 240);
  return `\n[user_steered_subagent count=${notes.length} notes="${combined}"]`;
}

export function toSubagentTaskSummary(snapshot: SubagentTaskSnapshot): SubagentTaskSummary {
  const errorCount = snapshot.toolCalls.filter((t) => t.status === 'error' || t.isError).length;
  const pendingQueueCount =
    typeof snapshot.pendingQueueCount === 'number'
      ? snapshot.pendingQueueCount
      : countQueuedMessages(snapshot.pendingQueue);
  return {
    taskId: snapshot.taskId,
    ...(snapshot.threadId ? { threadId: snapshot.threadId } : {}),
    ...(snapshot.resumedFromTaskId ? { resumedFromTaskId: snapshot.resumedFromTaskId } : {}),
    sessionId: snapshot.sessionId,
    ...(snapshot.parentCallId ? { parentCallId: snapshot.parentCallId } : {}),
    role: snapshot.role,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    status: snapshot.status,
    ...(snapshot.interruptKind ? { interruptKind: snapshot.interruptKind } : {}),
    activityState: snapshot.activityState,
    stage: snapshot.stage,
    startedAt: snapshot.startedAt,
    ...(snapshot.endedAt ? { endedAt: snapshot.endedAt } : {}),
    lastActivityAt: snapshot.lastActivityAt,
    lastProgressAt: snapshot.lastProgressAt,
    lastProgressSummary: snapshot.lastProgressSummary,
    durationMs: snapshot.durationMs,
    toolCallCount: snapshot.toolCalls.length,
    errorCount,
    artifactsCount: snapshot.artifacts.length,
    consecutiveHypothesisFailures: snapshot.consecutiveHypothesisFailures,
    pivotWarningCount: snapshot.pivotWarnings.length,
    ...(typeof snapshot.resumable === 'boolean' ? { resumable: snapshot.resumable } : {}),
    ...(typeof snapshot.interactive === 'boolean' ? { interactive: snapshot.interactive } : {}),
    ...(typeof snapshot.maxToolCalls === 'number' && snapshot.maxToolCalls > 0
      ? { maxToolCalls: snapshot.maxToolCalls }
      : {}),
    ...(typeof snapshot.callsSinceProgress === 'number' &&
    typeof snapshot.maxStallCalls === 'number' &&
    snapshot.maxStallCalls > 0
      ? { callsSinceProgress: snapshot.callsSinceProgress, maxStallCalls: snapshot.maxStallCalls }
      : {}),
    ...(typeof snapshot.isThinking === 'boolean' ? { isThinking: snapshot.isThinking } : {}),
    ...(pendingQueueCount > 0 ? { pendingQueueCount } : {}),
    ...(typeof snapshot.userSteerCount === 'number' && snapshot.userSteerCount > 0
      ? { userSteerCount: snapshot.userSteerCount }
      : {}),
    ...(typeof snapshot.compactionCount === 'number' && snapshot.compactionCount > 0
      ? { compactionCount: snapshot.compactionCount }
      : {}),
    ...(snapshot.queuedCompaction !== undefined
      ? { queuedCompaction: snapshot.queuedCompaction ? { ...snapshot.queuedCompaction } : null }
      : {}),
    ...(snapshot.contextUsage !== undefined
      ? { contextUsage: snapshot.contextUsage ? { ...snapshot.contextUsage } : null }
      : {}),
    taskSummary: clipText(snapshot.taskPrompt.replace(/\s+/g, ' ').trim(), 160),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

export function findLatestCompactionCheckpointPath(snapshot?: SubagentTaskSnapshot): string | undefined {
  const msgs = snapshot?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return undefined;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (
      m?.role === 'compaction' &&
      typeof m.compaction?.checkpointPath === 'string' &&
      m.compaction.checkpointPath.trim()
    ) {
      return m.compaction.checkpointPath.trim();
    }
  }
  return undefined;
}

export function formatSubagentFailureText(
  roleName: string,
  status: 'error' | 'aborted',
  interruptKind: SubagentInterruptKind,
  safeMsg: string,
  taskId: string,
  snapshot?: SubagentTaskSnapshot,
  resumable = false
): string {
  const header = `Subagent ${roleName} ${status === 'aborted' ? 'aborted' : 'failed'}: ${safeMsg}`;
  if (!snapshot) return header;
  const latestCheckpoint = findLatestCompactionCheckpointPath(snapshot);
  const metaParts = [
    `taskId=${taskId}`,
    `status=${status}`,
    `kind=${interruptKind}`,
    `stage=${snapshot.stage}`,
    `toolCalls=${snapshot.toolCalls.length}`,
    `durationMs=${snapshot.durationMs}`,
    ...(resumable ? [`resumable=true`, `resumeTaskId=${taskId}`] : []),
  ];
  const lines = [header, '[subagent_interruption_summary]', metaParts.join(' ')];
  if (snapshot.lastProgressSummary) {
    lines.push(`progress=${clipText(snapshot.lastProgressSummary, 240)}`);
  }
  if (snapshot.artifacts.length > 0) {
    lines.push(`artifacts=${snapshot.artifacts.slice(0, 10).join(', ')}`);
  }
  if (latestCheckpoint) {
    lines.push(`compactionCheckpoint=${latestCheckpoint}`);
    lines.push(
      'checkpointNote=Latest compaction checkpoint may contain newer verified byte-oracle progress not yet flushed into .papercup/research/; read it before deciding or constraining any resume.'
    );
  }
  if (roleName !== 'translator' && snapshot.responsePreview) {
    lines.push(`responseTail=${clipTailText(snapshot.responsePreview.replace(/\s+/g, ' ').trim(), 240)}`);
  }
  lines.push(
    resumable
      ? `next=Session cache preserved; resume in-place via delegate_task(role="${roleName}", resumeTaskId="${taskId}", task="...") or report the interruption upward if user decision is needed.`
      : 'next=Report this interruption upward; when resuming, continue directly from persisted progress/artifacts rather than manually re-probing or replacing this subagent.'
  );
  lines.push('[/subagent_interruption_summary]');
  return lines.join('\n');
}

function isValidTranslatorJsonl(trimmed: string): boolean {
  let body = trimmed;
  if (body.startsWith('```')) {
    const lines = body.split(/\r?\n/);
    if (lines.length >= 2 && lines[lines.length - 1].trim().startsWith('```')) {
      body = lines.slice(1, -1).join('\n').trim();
    }
  }
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) return false;
    try {
      const obj = JSON.parse(line);
      if (
        !obj ||
        typeof obj !== 'object' ||
        Array.isArray(obj) ||
        obj.id === undefined ||
        typeof obj.target !== 'string'
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function detectInvalidToollessOutput(roleName: string, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return `Subagent '${roleName}' returned an empty response.`;
  }
  if (roleName === 'translator' && isValidTranslatorJsonl(trimmed)) {
    return null;
  }
  if (TOOL_CALL_MARKUP_RE.test(trimmed)) {
    return `Subagent '${roleName}' has no tools enabled (allowedTools=[]) and returned raw tool-call markup instead of text. Pass the complete source text or JSONL inline in delegate_task.task instead of file paths.`;
  }
  return null;
}

function appendSubagentDiagnostic(cwd: string, metrics: SubagentRunMetrics): void {
  try {
    if (!cwd || !fs.existsSync(cwd)) return;
    const diagDir = resolveWorkspacePaths(cwd).diagnosticsDir;
    fs.mkdirSync(diagDir, { recursive: true });
    const logPath = path.join(diagDir, 'subagents.jsonl');
    fs.appendFileSync(logPath, `${JSON.stringify(metrics)}\n`, 'utf-8');
  } catch {
    // Diagnostics persistence must never break primary workflow execution
  }
}

const TRIVIAL_SHELL_CMD_RE =
  /^(?:ls|dir|pwd|cat|head|tail|sed|awk|grep|rg|find|wc|du|stat|file|md5sum|sha256sum|xxd|hexdump|echo|mkdir|cp|mv|rm|touch|which|where|type)\b/i;
const SCRIPT_EXEC_RE = /\b(?:python3?|py|node|npx|tsx|perl|ruby|bash|sh|pwsh|powershell)\b/i;

function isTrivialShellInspectionCommand(cmd: string): boolean {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return true;
  if (SCRIPT_EXEC_RE.test(trimmed)) return false;
  const segments = trimmed
    .split(/(?:\r?\n|;|&&|\|\||\|)+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return true;
  return segments.every((seg) => /^(?:cd|pushd|popd)\b/i.test(seg) || TRIVIAL_SHELL_CMD_RE.test(seg));
}

function syncSnapshotCounters(snapshot: SubagentTaskSnapshot): void {
  snapshot.toolCallCount = snapshot.toolCalls.length;
  snapshot.errorCount = snapshot.toolCalls.filter((t) => t.status === 'error' || t.isError).length;
  snapshot.artifactsCount = snapshot.artifacts.length;
  snapshot.pivotWarningCount = snapshot.pivotWarnings.length;
}

function persistTaskSnapshotToDisk(cwd: string, snapshot: SubagentTaskSnapshot): void {
  try {
    if (!cwd || !fs.existsSync(cwd)) return;
    syncSnapshotCounters(snapshot);
    const tasksDir = resolveWorkspacePaths(cwd).subagentTasksDir;
    fs.mkdirSync(tasksDir, { recursive: true });
    const targetPath = path.join(tasksDir, `${snapshot.taskId}.json`);
    const tmpPath = `${targetPath}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    fs.renameSync(tmpPath, targetPath);
  } catch {
    // Diagnostics persistence must never break primary workflow execution
  }
}

function appendTaskEventToDisk(
  cwd: string,
  event: {
    timestamp: string;
    taskId: string;
    sessionId: string | null;
    role: string;
    type: string;
    stage: string;
    activityState: SubagentActivityState;
    tool?: string;
    callId?: string;
    status?: string;
    durationMs?: number;
    error?: string;
    artifact?: string;
    pivotWarning?: string;
  }
): void {
  try {
    if (!cwd || !fs.existsSync(cwd)) return;
    const diagDir = resolveWorkspacePaths(cwd).diagnosticsDir;
    fs.mkdirSync(diagDir, { recursive: true });
    fs.appendFileSync(path.join(diagDir, 'subagent-events.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8');
  } catch {
    // Ignore non-fatal event log errors
  }
}

function cloneTaskSnapshot(snapshot: SubagentTaskSnapshot): SubagentTaskSnapshot {
  const clonedMessages = cloneChatMessages(snapshot.messages);
  return {
    ...snapshot,
    artifacts: [...snapshot.artifacts],
    pivotWarnings: [...snapshot.pivotWarnings],
    usage: { ...snapshot.usage },
    toolCalls: snapshot.toolCalls.map((t) => ({ ...t })),
    ...(clonedMessages ? { messages: clonedMessages } : {}),
    ...(snapshot.pendingQueue ? { pendingQueue: cloneQueueState(snapshot.pendingQueue) } : {}),
    ...(snapshot.queuedCompaction !== undefined
      ? { queuedCompaction: snapshot.queuedCompaction ? { ...snapshot.queuedCompaction } : null }
      : {}),
    ...(snapshot.contextUsage !== undefined
      ? { contextUsage: snapshot.contextUsage ? { ...snapshot.contextUsage } : null }
      : {}),
  };
}

function appendPivotNoticeToResult(res: any, notice: string): any {
  if (!res || typeof res !== 'object') {
    return {
      content: [{ type: 'text' as const, text: notice }],
      isError: true,
    };
  }
  const content: any[] = Array.isArray(res.content) ? [...res.content] : [];
  const lastTextIdx = content.map((p) => p?.type).lastIndexOf('text');
  if (lastTextIdx >= 0 && typeof content[lastTextIdx]?.text === 'string') {
    content[lastTextIdx] = {
      ...content[lastTextIdx],
      text: `${content[lastTextIdx].text}\n\n${notice}`,
    };
  } else {
    content.push({ type: 'text' as const, text: notice });
  }
  return {
    ...res,
    content,
  };
}

export class SubagentManager {
  private profiles = new Map<string, SubagentProfile>();
  private customToolsProvider: (() => ToolDefinition[]) | null = null;
  private defaultOnTaskUpdated: SubagentTaskUpdatedListener | null = null;
  private defaultOnUsage: SubagentUsageListener | null = null;
  private defaultOnStreamDelta: SubagentStreamDeltaListener | null = null;
  private defaultOnQueueUpdated: SubagentQueueUpdatedListener | null = null;
  private defaultOnQueueRestored: SubagentQueueRestoredListener | null = null;
  private sessionTrackerRefs = new WeakMap<object, { current: ActiveSubagentRunContext | null }>();
  private activeRuns = new Map<string, ActiveSubagentRunContext>();
  private memoryTasksByCwd = new Map<string, Map<string, SubagentTaskSnapshot>>();
  private diskTasksCacheByCwd = new Map<
    string,
    Map<string, { mtimeMs: number; size: number; snapshot: SubagentTaskSnapshot }>
  >();
  private resumableSessions = new Map<string, ResumableSubagentEntry>();
  private compactingTasks = new Set<string>();

  constructor() {
    for (const [name, profile] of Object.entries(BUILTIN_SUBAGENTS)) {
      this.profiles.set(name, profile);
    }
  }

  private setTaskResumableFlag(cwd: string, taskId: string, resumable: boolean): void {
    const cwdKey = normalizeWorkspaceKey(cwd);
    const snap = this.memoryTasksByCwd.get(cwdKey)?.get(taskId);
    if (!snap) return;
    if (Boolean(snap.resumable) === resumable) return;
    snap.resumable = resumable;
    if (fs.existsSync(resolveWorkspacePaths(cwd).subagentTaskFile(taskId))) {
      persistTaskSnapshotToDisk(cwd, snap);
    }
    const copy = cloneTaskSnapshot(snap);
    const summary = toSubagentTaskSummary(copy);
    this.defaultOnTaskUpdated?.(summary, copy);
  }

  disposeResumableSessions(cwd?: string): void {
    const filterKey = cwd ? normalizeWorkspaceKey(cwd) : null;
    for (const [key, entry] of Array.from(this.resumableSessions.entries())) {
      if (!filterKey || entry.cwdKey === filterKey) {
        this.evictResumableEntry(key);
      }
    }
  }

  private evictResumableEntry(key: string): void {
    const entry = this.resumableSessions.get(key);
    if (!entry) return;
    if (entry.ttlTimer) {
      clearTimeout(entry.ttlTimer);
      entry.ttlTimer = undefined;
    }
    this.resumableSessions.delete(key);
    try {
      entry.managed.dispose();
    } catch {
      // Ignore disposal errors
    }
    this.setTaskResumableFlag(entry.cwd, entry.taskId, false);
  }

  private storeResumableSession(taskId: string, entry: ResumableSubagentEntry): void {
    this.evictResumableEntry(taskId);
    while (this.resumableSessions.size >= MAX_RESUMABLE_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, existing] of this.resumableSessions.entries()) {
        if (existing.createdAtMs < oldestAt) {
          oldestAt = existing.createdAtMs;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      this.evictResumableEntry(oldestKey);
    }
    entry.ttlTimer = setTimeout(() => {
      this.evictResumableEntry(taskId);
    }, DEFAULT_RESUMABLE_SESSION_TTL_MS);
    entry.ttlTimer.unref?.();
    this.resumableSessions.set(taskId, entry);
    this.setTaskResumableFlag(entry.cwd, taskId, true);
  }

  private takeResumableSession(
    resumeTaskId: string,
    roleName: string,
    cwd: string,
    requestedModelKey: string | null
  ): ResumableSubagentEntry | null {
    const id = resumeTaskId.trim();
    if (!id) return null;
    const entry = this.resumableSessions.get(id);
    if (!entry) return null;
    if (entry.ttlTimer) {
      clearTimeout(entry.ttlTimer);
      entry.ttlTimer = undefined;
    }
    this.resumableSessions.delete(id);
    this.setTaskResumableFlag(entry.cwd, entry.taskId, false);

    const cwdKey = normalizeWorkspaceKey(cwd);
    const modelMismatch = Boolean(requestedModelKey && entry.modelKey && requestedModelKey !== entry.modelKey);
    if (
      entry.role !== roleName ||
      entry.cwdKey !== cwdKey ||
      entry.resumeCount >= MAX_RESUMES_PER_TASK ||
      modelMismatch
    ) {
      try {
        entry.managed.dispose();
      } catch {
        // Ignore disposal error
      }
      return null;
    }
    return entry;
  }

  setCustomToolsProvider(provider: (() => ToolDefinition[]) | null): void {
    this.customToolsProvider = provider;
  }

  setOnTaskUpdated(listener: SubagentTaskUpdatedListener | null): void {
    this.defaultOnTaskUpdated = listener;
  }

  setOnUsage(listener: SubagentUsageListener | null): void {
    this.defaultOnUsage = listener;
  }

  setOnStreamDelta(listener: SubagentStreamDeltaListener | null): void {
    this.defaultOnStreamDelta = listener;
  }

  setOnQueueUpdated(listener: SubagentQueueUpdatedListener | null): void {
    this.defaultOnQueueUpdated = listener;
  }

  setOnQueueRestored(listener: SubagentQueueRestoredListener | null): void {
    this.defaultOnQueueRestored = listener;
  }

  getProfile(name: string): SubagentProfile | undefined {
    return this.profiles.get(name);
  }

  registerProfile(profile: SubagentProfile): void {
    const validated = validateDynamicSubagentInput(profile.name, profile.allowedTools);
    if (!validated.ok) {
      throw new Error(validated.error);
    }
    this.profiles.set(validated.name, {
      ...profile,
      name: validated.name,
      allowedTools: validated.allowedTools,
    });
  }

  listProfiles(): SubagentProfile[] {
    return Array.from(this.profiles.values());
  }

  private rememberSnapshot(cwd: string, snapshot: SubagentTaskSnapshot): void {
    const key = normalizeWorkspaceKey(cwd);
    let map = this.memoryTasksByCwd.get(key);
    if (!map) {
      map = new Map();
      this.memoryTasksByCwd.set(key, map);
    }
    map.set(snapshot.taskId, cloneTaskSnapshot(snapshot));
    if (map.size > MAX_MEMORY_TASKS_PER_CWD) {
      const sorted = Array.from(map.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      for (const old of sorted.slice(0, map.size - MAX_MEMORY_TASKS_PER_CWD)) {
        if (old.status !== 'running') {
          map.delete(old.taskId);
        }
      }
    }
  }

  private emitAndPersistSnapshot(run: ActiveSubagentRunContext, forceDisk = false): void {
    if (run.budgetMaxToolCalls !== undefined && run.budgetMaxToolCalls > 0) {
      run.snapshot.maxToolCalls = run.budgetMaxToolCalls;
    } else {
      delete run.snapshot.maxToolCalls;
    }
    if (run.budgetMaxStallCalls !== undefined && run.budgetMaxStallCalls > 0) {
      run.snapshot.maxStallCalls = run.budgetMaxStallCalls;
      run.snapshot.callsSinceProgress = run.callsSinceProgress;
    } else {
      delete run.snapshot.maxStallCalls;
      delete run.snapshot.callsSinceProgress;
    }
    syncSnapshotCounters(run.snapshot);
    const copy = cloneTaskSnapshot(run.snapshot);
    this.rememberSnapshot(run.cwd, copy);
    const now = Date.now();
    if (run.recordDiagnostics && (forceDisk || now - run.lastPersistAtMs >= DELTA_PERSIST_INTERVAL_MS)) {
      run.lastPersistAtMs = now;
      persistTaskSnapshotToDisk(run.cwd, copy);
    }
    const summary = toSubagentTaskSummary(copy);
    run.onTaskUpdated?.(summary, copy);
    if (this.defaultOnTaskUpdated && this.defaultOnTaskUpdated !== run.onTaskUpdated) {
      this.defaultOnTaskUpdated(summary, copy);
    }
  }

  private triggerReverserStop(
    run: ActiveSubagentRunContext,
    toolCallId: string,
    toolName: string,
    isErr: boolean,
    textOut: string,
    savedOutputPath: string | undefined,
    producedArtifact: string | undefined,
    stopMessage: string
  ): void {
    const snap = run.snapshot;
    const nowIso = new Date().toISOString();
    snap.pivotWarnings.push(stopMessage);
    run.budgetAbortReason = stopMessage;
    run.budgetResumable = true;
    snap.interruptKind = 'aborted';
    if (run.recordDiagnostics) {
      appendTaskEventToDisk(run.cwd, {
        timestamp: nowIso,
        taskId: snap.taskId,
        sessionId: snap.sessionId,
        role: snap.role,
        type: 'pivot_warning',
        stage: snap.stage,
        activityState: snap.activityState,
        tool: toolName,
        callId: toolCallId,
        pivotWarning: stopMessage,
      });
    }
    run.toolOutcomeByCallId.set(toolCallId, {
      isError: isErr,
      resultSummary: clipText(textOut, MAX_RESULT_SUMMARY_CHARS),
      ...(snap.role !== 'translator' ? { fullResultText: clipText(textOut, MAX_SUBAGENT_TOOL_RESULT_CHARS) } : {}),
      ...(savedOutputPath ? { savedOutputPath } : {}),
      ...(producedArtifact ? { producedArtifact } : {}),
    });
    const activeMatch = snap.toolCalls.find((t) => t.callId === toolCallId && t.status === 'running');
    if (activeMatch) {
      activeMatch.resultSummary = clipText(textOut, MAX_RESULT_SUMMARY_CHARS);
    }
    run.finalize('aborted', 'aborted', stopMessage);
    try {
      void run.session?.abort?.();
    } catch {
      // Ignore abort error
    }
  }

  private wrapSubagentTool(
    cwd: string,
    def: ToolDefinition<any, any>,
    getRun: () => ActiveSubagentRunContext | null
  ): ToolDefinition<any, any> {
    return {
      ...def,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const preRun = getRun();
        if (preRun && !preRun.finalized && preRun.budgetMaxToolCalls && preRun.budgetMaxToolCalls > 0) {
          const priorCalls = preRun.snapshot.toolCalls.filter((t) => t.callId !== toolCallId).length;
          if (priorCalls >= preRun.budgetMaxToolCalls) {
            const budgetMsg = `Reverser 达到单轮工具调用上限（${preRun.budgetMaxToolCalls} 次），已强制停止并交回主 Agent 汇报进展与阻碍。`;
            preRun.budgetAbortReason = budgetMsg;
            preRun.budgetResumable = true;
            preRun.snapshot.interruptKind = 'aborted';
            preRun.finalize('aborted', 'aborted', budgetMsg);
            try {
              void preRun.session?.abort?.();
            } catch {
              // Ignore abort error
            }
            return {
              content: [{ type: 'text' as const, text: budgetMsg }],
              isError: true,
            };
          }
        }

        let rawRes: any;
        let thrownError: any = null;
        try {
          rawRes = await def.execute(toolCallId, params, signal, onUpdate, ctx);
        } catch (err: any) {
          thrownError = err;
        }

        const run = getRun();
        const secretsFn = run?.getKnownSecrets;
        const secrets = secretsFn?.();
        const textOut = thrownError
          ? redactSecrets(String(thrownError?.message || thrownError), secrets)
          : extractResultText(rawRes, secretsFn);

        const exitCode =
          typeof rawRes?.structuredContent?.exit_code === 'number'
            ? rawRes.structuredContent.exit_code
            : undefined;
        const bashFailed =
          def.name === 'bash' &&
          ((exitCode !== undefined && exitCode !== 0) ||
            (exitCode === undefined && /(?:^|\n)Command exited with code [1-9]\d*/i.test(textOut)));
        const isFailure = Boolean(thrownError || rawRes?.isError === true || bashFailed);
        const savedOutputPath =
          typeof rawRes?.details?.savedOutputPath === 'string'
            ? rawRes.details.savedOutputPath
            : undefined;

        let producedArtifact: string | undefined;
        let progressSummary: string | undefined;
        const paramObj = params && typeof params === 'object' ? (params as Record<string, any>) : {};

        if (!isFailure) {
          if (def.name === 'write' || def.name === 'edit') {
            const rel = resolveRelativeArtifact(cwd, paramObj.path);
            if (rel) {
              producedArtifact = rel;
              if (isMeaningfulReverserArtifactPath(rel)) {
                progressSummary = `写入 ${rel}`;
              }
            }
          } else if (def.name === 'vn_learn_skill' && !rawRes?.details?.rejected) {
            const eng = String(paramObj.engine || rawRes?.details?.engine || 'custom').trim();
            producedArtifact = `.papercup/skills/engine-${eng}/`;
            progressSummary = `验证并封装引擎技能 engine-${eng}`;
          } else if (def.name === 'vn_patch_font') {
            producedArtifact = '.papercup/data/vn/fonts/manifest.json';
            progressSummary = '原位修补随附字库缺失字形';
          } else if (
            def.name === 'vn_detect' &&
            /ready\s+(?:skill\s+unpack|direct\s+skill|builtin\s+unpack\s*\+\s*skill:)/i.test(textOut)
          ) {
            progressSummary = '确认引擎解包技能已就绪';
          }
        }

        let pivotNotice: string | null = null;
        let budgetNotice: string | null = null;
        let efficiencyNotice: string | null = null;
        if (run && !run.finalized) {
          const snap = run.snapshot;
          const nowIso = new Date().toISOString();
          snap.lastActivityAt = nowIso;

          if (producedArtifact) {
            if (!snap.artifacts.includes(producedArtifact)) {
              snap.artifacts.push(producedArtifact);
            }
          }
          let deliverableProgress = false;
          if (!isFailure) {
            if (def.name === 'vn_detect' && detectKnownEngineHintInText(textOut)) {
              run.knownEngineHintDetected = true;
            }
            if (def.name === 'vn_re_lookup') {
              run.recallLoggedInRun = true;
            }
            if (
              (def.name === 'write' || def.name === 'edit') &&
              producedArtifact &&
              isResearchHypothesesPath(producedArtifact)
            ) {
              run.recallLoggedInRun = true;
            }
            if (
              (def.name === 'vn_learn_skill' && !rawRes?.details?.rejected) ||
              def.name === 'vn_patch_font' ||
              ((def.name === 'write' || def.name === 'edit') &&
                producedArtifact &&
                isReverserDeliverableProgressArtifact(producedArtifact))
            ) {
              run.deliveredSkillOrScript = true;
              deliverableProgress = true;
            }
          }
          if (progressSummary) {
            snap.lastProgressAt = nowIso;
            snap.lastProgressSummary = progressSummary;
            if (run.recordDiagnostics) {
              appendTaskEventToDisk(run.cwd, {
                timestamp: nowIso,
                taskId: snap.taskId,
                sessionId: snap.sessionId,
                role: snap.role,
                type: 'progress',
                stage: snap.stage,
                activityState: snap.activityState,
                ...(producedArtifact ? { artifact: producedArtifact } : {}),
              });
            }
          }

          const snapshotMsgs = run.snapshot.messages;
          const currentTurnKey =
            (snapshotMsgs && snapshotMsgs.length > 0 ? snapshotMsgs[snapshotMsgs.length - 1]?.id : undefined) ||
            toolCallId;
          const recordStallTurn = () => {
            if (run.lastStallTurnKey !== currentTurnKey) {
              run.callsSinceProgress += 1;
              run.lastStallTurnKey = currentTurnKey;
            }
          };
          if (deliverableProgress) {
            run.callsSinceDeliverable = 0;
            run.lastNoDeliverableRemindAt = 0;
            run.compactionsSinceDeliverable = 0;
            run.pendingCompactionWarning = undefined;
            run.lastDeliverableTurnKey = undefined;
          } else if (run.lastDeliverableTurnKey !== currentTurnKey) {
            run.callsSinceDeliverable += 1;
            run.lastDeliverableTurnKey = currentTurnKey;
          }

          if (isFailure) {
            recordStallTurn();
            snap.consecutiveHypothesisFailures += 1;
            const hardStopFailures = run.budgetHardStopFailures;
            if (hardStopFailures && hardStopFailures > 0 && snap.consecutiveHypothesisFailures >= hardStopFailures) {
              const hardMsg = `Reverser 连续无效探索已达硬熔断阈值（${snap.consecutiveHypothesisFailures} 次，最近工具: ${def.name}），已强制停止并交回主 Agent 汇报进展与阻碍。`;
              pivotNotice = `[硬熔断 / HARD STOP] ${hardMsg}`;
              this.triggerReverserStop(
                run,
                toolCallId,
                def.name,
                true,
                textOut,
                savedOutputPath,
                producedArtifact,
                hardMsg
              );
            } else if (snap.consecutiveHypothesisFailures >= snap.maxConsecutiveFailures) {
              const warningMsg = `连续失败 ${snap.consecutiveHypothesisFailures} 次（工具 ${def.name}），已触发强制换路提醒。`;
              snap.pivotWarnings.push(warningMsg);
              pivotNotice = `[换路提醒 / PIVOT REQUIRED] 已连续 ${snap.consecutiveHypothesisFailures} 次出现失败（工具: ${def.name}）。请停止重复当前无效假设：立即将失败原因与错误证据记录到 .papercup/research/<engine>/02-hypotheses.md，然后切换解析策略或如实汇报阻碍。`;
              if (run.recordDiagnostics) {
                appendTaskEventToDisk(run.cwd, {
                  timestamp: nowIso,
                  taskId: snap.taskId,
                  sessionId: snap.sessionId,
                  role: snap.role,
                  type: 'pivot_warning',
                  stage: snap.stage,
                  activityState: snap.activityState,
                  tool: def.name,
                  callId: toolCallId,
                  pivotWarning: warningMsg,
                });
              }
            }
          } else {
            if (progressSummary) {
              run.callsSinceProgress = 0;
              run.lastSoftStallRemindAt = 0;
              run.lastStallTurnKey = undefined;
            } else {
              recordStallTurn();
            }
            if (
              (def.name === 'vn_learn_skill' && !rawRes?.details?.rejected) ||
              def.name === 'vn_patch_font' ||
              (def.name === 'bash' && !isTrivialShellInspectionCommand(String(paramObj.command ?? ''))) ||
              ((def.name === 'write' || def.name === 'edit') &&
                producedArtifact &&
                /hypothes/i.test(producedArtifact) &&
                snap.pivotWarnings.length > 0)
            ) {
              snap.consecutiveHypothesisFailures = 0;
            }
          }

          if (
            !run.finalized &&
            run.budgetMaxStallCalls &&
            run.budgetMaxStallCalls > 0 &&
            run.callsSinceProgress >= run.budgetMaxStallCalls
          ) {
            const stallMsg = `Reverser 连续 ${run.callsSinceProgress} 次工具调用未产生新的研究记录或交付脚本（停滞熔断阈值 ${run.budgetMaxStallCalls} 次），已强制停止并交回主 Agent 汇报进展与阻碍。`;
            pivotNotice = [pivotNotice, `[停滞熔断 / STALL STOP] ${stallMsg}`].filter(Boolean).join('\n\n');
            this.triggerReverserStop(
              run,
              toolCallId,
              def.name,
              isFailure,
              textOut,
              savedOutputPath,
              producedArtifact,
              stallMsg
            );
          }

          if (!run.finalized) {
            run.toolOutcomeByCallId.set(toolCallId, {
              isError: isFailure,
              resultSummary: clipText(textOut, MAX_RESULT_SUMMARY_CHARS),
              ...(snap.role !== 'translator' ? { fullResultText: clipText(textOut, MAX_SUBAGENT_TOOL_RESULT_CHARS) } : {}),
              ...(savedOutputPath ? { savedOutputPath } : {}),
              ...(producedArtifact ? { producedArtifact } : {}),
            });
            if (run.budgetMaxToolCalls && run.budgetMaxToolCalls > 0 && !isFailure) {
              const usedCalls = snap.toolCalls.filter((t) => t.callId !== toolCallId).length + 1;
              const remaining = run.budgetMaxToolCalls - usedCalls;
              const halfMark = Math.floor(run.budgetMaxToolCalls * 0.5);
              const threeQuarterMark = Math.floor(run.budgetMaxToolCalls * 0.75);
              if (remaining >= 1 && remaining <= 3) {
                budgetNotice = `[预算提醒] 本轮已用 ${usedCalls}/${run.budgetMaxToolCalls} 次（仅剩 ${remaining} 次工具调用），请立刻停止探索，将已验证结论落盘并收敛总结。`;
              } else if (run.budgetMaxToolCalls >= 10 && usedCalls === threeQuarterMark) {
                budgetNotice = `[预算提醒] 本轮已用 ${usedCalls}/${run.budgetMaxToolCalls} 次（剩余 ${remaining} 次工具调用）。请立即停止零散探测，直接用 write/edit 落地脚本、跑一次整合验证并调用 vn_learn_skill。`;
              } else if (run.budgetMaxToolCalls >= 10 && usedCalls === halfMark) {
                budgetNotice = `[预算提醒] 本轮已用过半（${usedCalls}/${run.budgetMaxToolCalls} 次，剩余 ${remaining} 次）。如已完成格式确认，请立刻进入脚本编写（用 write/edit，勿用 bash heredoc）与验证阶段。`;
              }
            }
            if (
              !budgetNotice &&
              !isFailure &&
              run.budgetMaxStallCalls &&
              run.budgetMaxStallCalls >= 6 &&
              run.callsSinceProgress === run.budgetMaxStallCalls - 3
            ) {
              budgetNotice = `[停滞提醒] 已连续 ${run.callsSinceProgress} 次工具调用未产出新的研究记录或交付脚本（满 ${run.budgetMaxStallCalls} 次将自动停机；重复覆写 .papercup/tmp/ 临时探针不计入里程碑进展）。请立刻将当前结论写入 .papercup/research/ 或落地 unpack/repack/extract/apply.py。`;
            } else if (
              !budgetNotice &&
              !isFailure &&
              snap.role === 'reverser' &&
              shouldEmitSoftStallNotice(run.callsSinceProgress, run.lastSoftStallRemindAt)
            ) {
              run.lastSoftStallRemindAt = run.callsSinceProgress;
              budgetNotice = `[进展纠偏 / PROGRESS CHECK] 已连续 ${run.callsSinceProgress} 轮工具调用未产出新的研究记录（.papercup/research/）或交付脚本（unpack/repack/extract/apply.py），期间仅在修改临时探针或读取输出。请立刻自查：1) 探针结果是否已证实某字段/假说不存在（如 find 返回 -1 或空集合）？若已证伪请直接记入 02-hypotheses.md 并停止继续微调窗口重试；2) 已验证的结构/编解码逻辑请立刻写入 .papercup/research/<engine>/01-layout.md，并推进交付脚本编写与 vn_learn_skill 闭环；3) 若已识别引擎名称却仍在进行盲统计，请先回忆该引擎公开格式并做单次决定性字节验证（如解压长度匹配/明文表校验），而非继续盲扫。`;
            }
            if (
              !isFailure &&
              snap.role === 'reverser' &&
              shouldEmitNoDeliverableNotice(run.callsSinceDeliverable, run.lastNoDeliverableRemindAt)
            ) {
              run.lastNoDeliverableRemindAt = run.callsSinceDeliverable;
              const noDelivMsg = `[进展纠偏 / NO-DELIVERABLE] 本轮已连续 ${run.callsSinceDeliverable} 次工具调用未产出交付脚本（unpack/repack/extract/apply.py）或通过 vn_learn_skill（仅修改研究文档不计为交付推进）。请立刻聚焦最简闭环：1) 若尚未查开源规格，先用 vn_re_lookup 检索；2) Windows PE 目标优先用 vn_re_trace(read_watch) 下 DR0 硬件断点直接定位解密/解压指令 VA，不要继续猜；3) 若已剥离新外层，请丢弃旧层上的头长/压缩证伪结论并从固定头末尾重测；4) 回封优先考虑散文件覆盖或假压缩构造。`;
              budgetNotice = budgetNotice ? `${budgetNotice}\n\n${noDelivMsg}` : noDelivMsg;
            }
            if (run.pendingCompactionWarning) {
              const cw = run.pendingCompactionWarning;
              run.pendingCompactionWarning = undefined;
              budgetNotice = budgetNotice ? `${budgetNotice}\n\n${cw}` : cw;
            }
            if (!isFailure && snap.role === 'reverser' && run.knownEngineHintDetected && !run.recallLoggedInRun && !run.recallFirstNoticed) {
              const isProbeWrite =
                (def.name === 'write' || def.name === 'edit') &&
                Boolean(producedArtifact && isTmpScratchScriptPath(producedArtifact));
              const isProbeBash =
                def.name === 'bash' &&
                extractBashScriptTargetPaths(String(paramObj.command ?? '')).some((p) => isTmpScratchScriptPath(p));
              if (isProbeWrite || isProbeBash) {
                run.recallFirstNoticed = true;
                const recallMsg = `[阶段提醒 / RECALL-FIRST] 检测到已识别引擎线索但尚未记录公开规格假设。请优先使用 vn_re_lookup 检索开源实现（或整理已有记忆）并将结构/XOR/压缩/字符串编码假说以 \`recalled-unverified\` 写入 .papercup/research/<engine>/02-hypotheses.md，再跑单次决定性字节 oracle；如需定位文件加载或解密函数，优先用 vn_re_inspect / vn_re_trace 而非盲扫。`;
                efficiencyNotice = efficiencyNotice ? `${efficiencyNotice}\n\n${recallMsg}` : recallMsg;
              }
            }
            if (!isFailure && snap.role === 'reverser' && def.name === 'read') {
              const readRel = resolveRelativeArtifact(cwd, paramObj.path);
              if (readRel && isTmpScratchTextReadPath(readRel)) {
                run.tmpTextReadCount += 1;
                if (shouldEmitTmpReadStdoutNotice(run.tmpTextReadCount)) {
                  efficiencyNotice = `[效率提醒 / STDOUT-FIRST] 本轮已 ${run.tmpTextReadCount} 次读取 .papercup/tmp/ 下的临时文本输出（${readRel}）。把探针结果写入临时文件再额外调用 read 会多耗 1 轮完整上下文往返；请改由脚本直接 print() 精简摘要到 stdout（超 16 KB 服务端会自动截断并落盘），仅在保存大型反汇编或映射档时才写文件。`;
                }
              }
            }
            if (
              !isFailure &&
              snap.role === 'reverser' &&
              (def.name === 'write' || def.name === 'edit') &&
              producedArtifact &&
              isTmpScratchScriptPath(producedArtifact)
            ) {
              const scriptKey = normalizeWorkspaceRelPath(producedArtifact).toLowerCase();
              const scratchPaths = run.scratchScriptPaths ?? (run.scratchScriptPaths = new Set());
              if (!scratchPaths.has(scriptKey)) {
                scratchPaths.add(scriptKey);
                if (shouldEmitScratchScriptSprawlNotice(scratchPaths.size)) {
                  const sprawlMsg = `[效率提醒 / SINGLE-SCRIPT] 本轮已在 .papercup/tmp/ 下新建 ${scratchPaths.size} 个不同临时探针脚本（最近：${producedArtifact}）。请严格遵守单脚本聚合纪律：原地 edit 复用同一个分析脚本，不要继续新建 probeN.py；同时优先核对是否已先用已知引擎公开格式做字节级验证。`;
                  efficiencyNotice = efficiencyNotice ? `${efficiencyNotice}\n\n${sprawlMsg}` : sprawlMsg;
                }
              }
            }
          }
        }

        if (thrownError) {
          const baseMsg = redactSecrets(String(thrownError?.message || thrownError), secrets);
          const extra = [pivotNotice, budgetNotice, efficiencyNotice].filter(Boolean).join('\n\n');
          throw new Error(extra ? `${baseMsg}\n\n${extra}` : baseMsg);
        }

        const combinedNotice = [pivotNotice, budgetNotice, efficiencyNotice].filter(Boolean).join('\n\n');
        if (combinedNotice) {
          return appendPivotNoticeToResult(rawRes, combinedNotice);
        }
        return rawRes;
      },
    };
  }

  /**
   * 标记子任务产生了新的可核对落盘产物（供编排器写入批次译文后同步更新有效进展时间）。
   */
  markTaskProgress(cwd: string, taskId: string, summary: string, artifactPath?: string): void {
    const run = this.activeRuns.get(taskId);
    const nowIso = new Date().toISOString();
    if (run && !run.finalized) {
      run.snapshot.lastActivityAt = nowIso;
      run.snapshot.lastProgressAt = nowIso;
      run.snapshot.lastProgressSummary = summary;
      if (artifactPath && !run.snapshot.artifacts.includes(artifactPath)) {
        run.snapshot.artifacts.push(artifactPath);
      }
      if (run.recordDiagnostics) {
        appendTaskEventToDisk(run.cwd, {
          timestamp: nowIso,
          taskId: run.snapshot.taskId,
          sessionId: run.snapshot.sessionId,
          role: run.snapshot.role,
          type: 'progress',
          stage: run.snapshot.stage,
          activityState: run.snapshot.activityState,
          ...(artifactPath ? { artifact: artifactPath } : {}),
        });
      }
      this.emitAndPersistSnapshot(run, true);
      return;
    }

    const existing = this.memoryTasksByCwd.get(normalizeWorkspaceKey(cwd))?.get(taskId);
    if (existing) {
      existing.lastProgressAt = nowIso;
      existing.lastProgressSummary = summary;
      if (artifactPath && !existing.artifacts.includes(artifactPath)) {
        existing.artifacts.push(artifactPath);
      }
      syncSnapshotCounters(existing);
      if (fs.existsSync(resolveWorkspacePaths(cwd).subagentTaskFile(taskId))) {
        persistTaskSnapshotToDisk(cwd, existing);
      }
    }
  }

  /**
   * 当主会话中止时，同步终止所有活跃中的子任务并立刻落盘/广播一致的中止状态。
   */
  abortActiveTasks(reason = '主会话已手动中止任务。'): void {
    for (const run of this.activeRuns.values()) {
      if (run.finalized) continue;
      if (!run.pendingRestoredDraft) {
        run.pendingRestoredDraft = run.queueController.clearForRestore(run.session);
      }
      run.finalize('aborted', 'aborted', reason);
      try {
        void run.session?.abort?.();
      } catch {
        // Ignore underlying abort error
      }
    }
  }

  abortTaskWithResult(
    taskId: string,
    reason = '用户已手动中止子代理任务。'
  ): { aborted: boolean; restoredDraft: RestoredDraftPayload | null } {
    const cleanId = taskId.trim();
    if (!cleanId) return { aborted: false, restoredDraft: null };
    const run = this.activeRuns.get(cleanId);
    if (!run || run.finalized) return { aborted: false, restoredDraft: null };
    if (!run.pendingRestoredDraft) {
      run.pendingRestoredDraft = run.queueController.clearForRestore(run.session);
    }
    const restoredDraft = run.pendingRestoredDraft;
    run.finalize('aborted', 'aborted', reason);
    try {
      void run.session?.abort?.();
    } catch {
      // Ignore underlying abort error
    }
    return { aborted: true, restoredDraft };
  }

  abortTask(taskId: string, reason = '用户已手动中止子代理任务。'): boolean {
    return this.abortTaskWithResult(taskId, reason).aborted;
  }

  private getMutableActiveRun(cwd: string, taskId: string): ActiveSubagentRunContext {
    const cleanId = taskId.trim();
    if (!cleanId) {
      throw new Error('NOT_FOUND: 缺少子代理任务 ID。');
    }
    const active = this.activeRuns.get(cleanId);
    if (active && !active.finalized && normalizeWorkspaceKey(active.cwd) === normalizeWorkspaceKey(cwd)) {
      if (active.snapshot.role === 'translator' || active.snapshot.interactive === false) {
        throw new Error('translator 为批量译文工作角色，不支持运行中插话或排队。');
      }
      return active;
    }
    const existing = this.getTask(cwd, cleanId);
    if (!existing) {
      throw new Error(`NOT_FOUND: 未找到子代理任务 ${cleanId}`);
    }
    if (existing.role === 'translator' || existing.interactive === false) {
      throw new Error('translator 为批量译文工作角色，不支持运行中插话或排队。');
    }
    throw new Error('TASK_NOT_RUNNING: 该子代理任务当前未在运行，无法排入运行中队列。');
  }

  async enqueueTaskMessage(
    cwd: string,
    taskId: string,
    message: string,
    mode: QueuedMessageMode,
    images?: readonly ChatImageAttachment[]
  ): Promise<{ taskId: string; threadId: string; item: QueuedMessageItem; queue: PendingQueueState }> {
    const normalizedImages =
      Array.isArray(images) && images.length > 0 ? images.map((img) => ({ ...img })) : undefined;
    const trimmed = String(message || '').trim() || (normalizedImages?.length ? DEFAULT_IMAGE_ONLY_PROMPT : '');
    if (!trimmed) {
      throw new Error('消息内容不能为空。');
    }
    const run = this.getMutableActiveRun(cwd, taskId);
    if (normalizedImages?.length && run.session?.model && !modelSupportsImageInput(run.session.model)) {
      throw Object.assign(
        new Error(
          `当前模型 ${run.session.model.provider}/${run.session.model.id} 不支持图片输入，请先切换至支持视觉的模型。`
        ),
        { code: 'MODEL_NO_VISION', status: 400 }
      );
    }
    const { item, queue } = await run.queueController.enqueue(run.session, trimmed, mode, normalizedImages);
    run.emitQueueUpdate();
    return {
      taskId: run.snapshot.taskId,
      threadId: run.snapshot.threadId || run.snapshot.taskId,
      item,
      queue,
    };
  }

  async switchTaskQueueItemMode(
    cwd: string,
    taskId: string,
    itemId: string,
    targetMode: QueuedMessageMode
  ): Promise<QueueMutationResult & { taskId: string; threadId: string }> {
    const run = this.getMutableActiveRun(cwd, taskId);
    const res = await run.queueController.switchItemMode(run.session, itemId, targetMode);
    run.emitQueueUpdate();
    return {
      ...res,
      taskId: run.snapshot.taskId,
      threadId: run.snapshot.threadId || run.snapshot.taskId,
    };
  }

  async removeTaskQueueItem(
    cwd: string,
    taskId: string,
    itemId: string
  ): Promise<QueueMutationResult & { taskId: string; threadId: string }> {
    const run = this.getMutableActiveRun(cwd, taskId);
    const res = await run.queueController.removeItem(run.session, itemId);
    run.emitQueueUpdate();
    return {
      ...res,
      taskId: run.snapshot.taskId,
      threadId: run.snapshot.threadId || run.snapshot.taskId,
    };
  }

  async clearTaskQueue(
    cwd: string,
    taskId: string
  ): Promise<{
    taskId: string;
    threadId: string;
    cleared: PendingQueueState;
    restoredDraft: RestoredDraftPayload | null;
    queue: PendingQueueState;
  }> {
    const run = this.getMutableActiveRun(cwd, taskId);
    const res = await run.queueController.clearAll(run.session);
    run.emitQueueUpdate();
    return {
      ...res,
      taskId: run.snapshot.taskId,
      threadId: run.snapshot.threadId || run.snapshot.taskId,
    };
  }

  async compactTask(
    cwd: string,
    taskId: string,
    focus?: string
  ): Promise<SubagentCompactResult> {
    const cleanId = String(taskId || '').trim();
    if (!cleanId) {
      throw new Error('NOT_FOUND: 缺少子代理任务 ID。');
    }
    const cleanFocus = typeof focus === 'string' && focus.trim() ? focus.trim() : undefined;
    const cwdKey = normalizeWorkspaceKey(cwd);

    // Running subagent: queue post-turn compaction cleanly
    const active = this.activeRuns.get(cleanId);
    if (active && !active.finalized && normalizeWorkspaceKey(active.cwd) === cwdKey) {
      if (active.snapshot.role === 'translator' || active.snapshot.interactive === false) {
        throw new Error('BAD_REQUEST: translator 为批量译文工作角色，不支持上下文压缩。');
      }
      active.queuedCompaction = cleanFocus ? { focus: cleanFocus } : {};
      active.snapshot.queuedCompaction = cleanFocus ? { focus: cleanFocus } : {};
      this.emitAndPersistSnapshot(active, true);
      return {
        ok: true,
        status: 'queued',
        taskId: active.snapshot.taskId,
        ...(cleanFocus ? { focus: cleanFocus } : {}),
        message: '已排入队尾，将在子代理当前回合完成后自动执行上下文压缩。',
      };
    }

    const existing = this.getTask(cwd, cleanId);
    if (!existing) {
      throw new Error(`NOT_FOUND: 未找到子代理任务 ${cleanId}`);
    }
    if (existing.role === 'translator' || existing.interactive === false) {
      throw new Error('BAD_REQUEST: translator 为批量译文工作角色，不支持上下文压缩。');
    }

    if (this.compactingTasks.has(cleanId)) {
      throw new Error('CONFLICT: 该子代理正在执行上下文压缩，请稍候。');
    }

    const liveEntry = this.resumableSessions.get(cleanId);
    if (!liveEntry || liveEntry.cwdKey !== cwdKey || typeof liveEntry.managed.compact !== 'function') {
      throw new Error('CONFLICT: 该子代理会话已离线或未保留活跃上下文，无法压缩。');
    }

    this.compactingTasks.add(cleanId);
    const memMap = this.memoryTasksByCwd.get(cwdKey);
    const mutableSnap = memMap?.get(cleanId) ?? cloneTaskSnapshot(existing);
    if (!memMap) {
      this.rememberSnapshot(cwd, mutableSnap);
    }
    const snap = this.memoryTasksByCwd.get(cwdKey)?.get(cleanId) ?? mutableSnap;
    const prevActivity = snap.activityState;
    const prevStage = snap.stage;
    const hasDiskRecord = fs.existsSync(resolveWorkspacePaths(cwd).subagentTaskFile(cleanId));

    const publishSnap = (forceDisk: boolean) => {
      syncSnapshotCounters(snap);
      const copy = cloneTaskSnapshot(snap);
      this.rememberSnapshot(cwd, copy);
      if (forceDisk && hasDiskRecord) {
        persistTaskSnapshotToDisk(cwd, copy);
      }
      const summary = toSubagentTaskSummary(copy);
      this.defaultOnTaskUpdated?.(summary, copy);
    };

    try {
      const startIso = new Date().toISOString();
      snap.activityState = 'compacting';
      snap.stage = 'compacting';
      snap.lastActivityAt = startIso;
      if (hasDiskRecord) {
        appendTaskEventToDisk(cwd, {
          timestamp: startIso,
          taskId: cleanId,
          sessionId: snap.sessionId,
          role: snap.role,
          type: 'compaction_start',
          stage: 'compacting',
          activityState: 'compacting',
        });
      }
      publishSnap(false);

      const compactOutcome = await liveEntry.managed.compact(cleanFocus);
      const { result: rawCompactResult, summaryInfo, contextUsage } = compactOutcome;
      const doneIso = new Date().toISOString();

      snap.compactionCount = (snap.compactionCount ?? 0) + 1;
      snap.contextUsage = contextUsage;
      snap.activityState = prevActivity === 'compacting' ? 'completed' : prevActivity;
      snap.stage = prevStage === 'compacting' ? inferSubagentStage(snap.role) : prevStage;
      snap.lastActivityAt = doneIso;

      const normalizedUsage = normalizeUsageRecord(rawCompactResult?.usage);
      if (normalizedUsage) {
        snap.usage.input += normalizedUsage.input;
        snap.usage.output += normalizedUsage.output;
        snap.usage.cacheRead += normalizedUsage.cacheRead;
        snap.usage.cacheWrite += normalizedUsage.cacheWrite;
        snap.usage.totalTokens += normalizedUsage.totalTokens;
        if (normalizedUsage.reasoning !== undefined) {
          snap.usage.reasoningTokens = (snap.usage.reasoningTokens ?? 0) + normalizedUsage.reasoning;
        }
        const modelKey = liveEntry.modelKey || snap.model || '';
        const slashIdx = modelKey.indexOf('/');
        const provider = slashIdx > 0 ? modelKey.slice(0, slashIdx) : 'unknown';
        const model = slashIdx > 0 ? modelKey.slice(slashIdx + 1) : modelKey || 'unknown';
        this.defaultOnUsage?.({
          sessionId: snap.sessionId ?? null,
          taskId: cleanId,
          role: snap.role,
          usageKind: 'compaction',
          provider,
          model,
          usage: normalizedUsage.usage,
        });
      }

      const existingMsgs = Array.isArray(snap.messages) ? snap.messages : buildLegacyFallbackMessages(snap);
      if (!existingMsgs.some((m) => m.id === summaryInfo.id)) {
        snap.messages = pushBoundedChatMessage(existingMsgs, {
          id: summaryInfo.id,
          role: 'compaction',
          content: summaryInfo.summary,
          timestamp: summaryInfo.timestamp || doneIso,
          turnTaskId: cleanId,
          compaction: {
            reason: summaryInfo.reason,
            tokensBefore: summaryInfo.tokensBefore,
            tokensAfter: summaryInfo.tokensAfter,
            ...(summaryInfo.focus ? { focus: summaryInfo.focus } : {}),
            ...(summaryInfo.checkpointPath ? { checkpointPath: summaryInfo.checkpointPath } : {}),
          },
        });
      }

      if (hasDiskRecord) {
        appendTaskEventToDisk(cwd, {
          timestamp: doneIso,
          taskId: cleanId,
          sessionId: snap.sessionId,
          role: snap.role,
          type: 'compaction_end',
          stage: snap.stage,
          activityState: snap.activityState,
          status: 'compacted',
        });
      }
      publishSnap(true);

      // Refresh resumable session TTL since user actively interacted with it
      if (this.resumableSessions.get(cleanId) === liveEntry) {
        if (liveEntry.ttlTimer) {
          clearTimeout(liveEntry.ttlTimer);
        }
        liveEntry.createdAtMs = Date.now();
        liveEntry.ttlTimer = setTimeout(() => {
          this.evictResumableEntry(cleanId);
        }, DEFAULT_RESUMABLE_SESSION_TTL_MS);
        liveEntry.ttlTimer.unref?.();
      }

      return {
        ok: true,
        status: 'compacted',
        taskId: cleanId,
        result: summaryInfo,
        ...(cleanFocus ? { focus: cleanFocus } : {}),
      };
    } catch (err: any) {
      const errMsg = String(err?.message || err || '');
      const endIso = new Date().toISOString();
      snap.activityState = prevActivity === 'compacting' ? 'completed' : prevActivity;
      snap.stage = prevStage === 'compacting' ? inferSubagentStage(snap.role) : prevStage;
      snap.lastActivityAt = endIso;
      const isNoop = isCompactionNoopError(errMsg);
      if (hasDiskRecord) {
        appendTaskEventToDisk(cwd, {
          timestamp: endIso,
          taskId: cleanId,
          sessionId: snap.sessionId,
          role: snap.role,
          type: 'compaction_end',
          stage: snap.stage,
          activityState: snap.activityState,
          status: isNoop ? 'noop' : 'error',
          ...(isNoop ? {} : { error: errMsg }),
        });
      }
      publishSnap(true);
      if (isNoop) {
        return {
          ok: true,
          status: 'noop',
          taskId: cleanId,
          message: '当前子代理对话较短，暂无可压缩的上下文。',
        };
      }
      throw err;
    } finally {
      this.compactingTasks.delete(cleanId);
    }
  }

  private normalizeLoadedSnapshot(parsed: SubagentTaskSnapshot): SubagentTaskSnapshot {
    const isActive = this.activeRuns.has(parsed.taskId);
    if (parsed.status === 'running' && !isActive) {
      parsed.status = 'error';
      parsed.interruptKind = parsed.interruptKind || 'aborted';
      parsed.activityState = 'unknown';
      parsed.isThinking = false;
      parsed.error = parsed.error || '服务已重启或连接中断，任务结束状态未知。';
      parsed.toolCalls = (parsed.toolCalls ?? []).map((t) =>
        t.status === 'running' ? { ...t, status: 'error' as const, isError: true } : t
      );
      if (Array.isArray(parsed.messages)) {
        parsed.messages = parsed.messages.map((m) =>
          Array.isArray(m.tools)
            ? {
                ...m,
                tools: m.tools.map((t) => (t.status === 'running' ? { ...t, status: 'error' as const, isError: true } : t)),
              }
            : m
        );
      }
    }
    if (!isActive) {
      delete parsed.pendingQueue;
      delete parsed.pendingQueueCount;
      delete parsed.queuedCompaction;
      if (!this.compactingTasks.has(parsed.taskId) && parsed.activityState === 'compacting') {
        parsed.activityState = parsed.status === 'completed' ? 'completed' : 'unknown';
      }
    }
    parsed.resumable = this.resumableSessions.has(parsed.taskId);
    if (parsed.interactive === undefined) {
      parsed.interactive = parsed.role !== 'translator';
    }
    return parsed;
  }

  listTasks(cwd: string, sessionId?: string | null, options?: { limit?: number }): SubagentTaskSummary[] {
    const cwdKey = normalizeWorkspaceKey(cwd);
    const byId = new Map<string, SubagentTaskSnapshot>();
    const memMap = this.memoryTasksByCwd.get(cwdKey);
    if (memMap) {
      for (const snap of memMap.values()) {
        byId.set(snap.taskId, this.normalizeLoadedSnapshot(cloneTaskSnapshot(snap)));
      }
    }

    const tasksDir = resolveWorkspacePaths(cwd).subagentTasksDir;
    if (fs.existsSync(tasksDir)) {
      let diskCache = this.diskTasksCacheByCwd.get(cwdKey);
      if (!diskCache) {
        diskCache = new Map();
        this.diskTasksCacheByCwd.set(cwdKey, diskCache);
      }
      const seenFiles = new Set<string>();
      try {
        for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          seenFiles.add(entry.name);
          const taskIdHint = entry.name.slice(0, -'.json'.length);
          if (byId.has(taskIdHint)) continue;
          const filePath = path.join(tasksDir, entry.name);
          try {
            const st = fs.lstatSync(filePath);
            if (st.isSymbolicLink() || !st.isFile()) continue;
            const cached = diskCache.get(entry.name);
            let parsed: SubagentTaskSnapshot;
            if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
              parsed = cloneTaskSnapshot(cached.snapshot);
            } else {
              const rawParsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SubagentTaskSnapshot;
              if (!rawParsed?.taskId) continue;
              diskCache.set(entry.name, {
                mtimeMs: st.mtimeMs,
                size: st.size,
                snapshot: cloneTaskSnapshot(rawParsed),
              });
              parsed = rawParsed;
            }
            if (!parsed?.taskId || byId.has(parsed.taskId)) continue;
            byId.set(parsed.taskId, this.normalizeLoadedSnapshot(parsed));
          } catch {
            // Skip unreadable or partially written task JSON
          }
        }
        for (const cachedKey of Array.from(diskCache.keys())) {
          if (!seenFiles.has(cachedKey)) {
            diskCache.delete(cachedKey);
          }
        }
      } catch {
        // Ignore directory listing failure
      }
    } else {
      this.diskTasksCacheByCwd.delete(cwdKey);
    }

    const filterSession = sessionId !== undefined && sessionId !== null && sessionId !== '';
    const summaries = Array.from(byId.values())
      .filter((t) => (!filterSession ? true : t.sessionId === sessionId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(toSubagentTaskSummary);
    const limit = typeof options?.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : 0;
    return limit > 0 ? summaries.slice(0, limit) : summaries;
  }

  getTask(cwd: string, taskId: string): SubagentTaskSnapshot | null {
    const cleanId = taskId.trim();
    if (!cleanId || cleanId.includes('..') || cleanId.includes('/') || cleanId.includes('\\')) {
      return null;
    }

    const active = this.activeRuns.get(cleanId);
    if (active && normalizeWorkspaceKey(active.cwd) === normalizeWorkspaceKey(cwd)) {
      return cloneTaskSnapshot(active.snapshot);
    }

    const mem = this.memoryTasksByCwd.get(normalizeWorkspaceKey(cwd))?.get(cleanId);
    if (mem) {
      return this.normalizeLoadedSnapshot(cloneTaskSnapshot(mem));
    }

    const filePath = resolveWorkspacePaths(cwd).subagentTaskFile(cleanId);
    try {
      if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SubagentTaskSnapshot;
      return this.normalizeLoadedSnapshot(parsed);
    } catch {
      return null;
    }
  }

  /**
   * サブエージェント用の隔離された Pi AgentSession を構築する（ResourceLoader で専用プロンプトとツール権限・Thinking レベルを適用）。
   */
  async createSubagentSession(roleName: string, options: SubagentSessionOptions) {
    const profile = this.getProfile(roleName);
    if (!profile) {
      throw new Error(`Subagent role '${roleName}' not found. Available roles: ${Array.from(this.profiles.keys()).join(', ')}`);
    }

    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory();
    applyPaperCupQueueModes(settingsManager);
    if (config.bashPath) {
      settingsManager.setShellPath(config.bashPath);
    }

    const isInteractiveRole = roleName !== 'translator';
    const compactionRole: CompactionRole = roleName === 'reverser' ? 'reverser' : 'subagent';
    const activeSessionRef: { current: any } = { current: null };
    if (!isInteractiveRole) {
      settingsManager.setCompactionEnabled(false);
    } else {
      applyCompactionSettingsForModel(settingsManager, options.model, compactionRole);
    }

    const skillPaths = (profile.skillPaths ?? []).filter((p) => fs.existsSync(p));
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.cwd,
      settingsManager,
      noExtensions: true,
      ...(isInteractiveRole
        ? {
            extensionFactories: [
              createPaperCupCompactionExtension({
                role: compactionRole,
                cwd: options.cwd,
                getKnownSecrets: options.getKnownSecrets,
                getModel: () => activeSessionRef.current?.model ?? options.model,
                getStreamFn: () => activeSessionRef.current?.agent?.streamFunction,
              }),
            ],
          }
        : {}),
      noSkills: true,
      ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: profile.systemPrompt,
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();

    const trackerRef: { current: ActiveSubagentRunContext | null } = { current: null };

    const allowedTools = profile.allowedTools ?? [];
    const availableCustomTools = options.customTools ?? this.customToolsProvider?.() ?? [];
    const allowedCustomTools =
      allowedTools.length > 0
        ? availableCustomTools.filter((tool) => allowedTools.includes(tool.name))
        : [];
    const researchCfg = requiresResearchGuardrails(roleName, allowedTools)
      ? readVnResearchConfig(options.cwd)
      : null;
    const guardedBuiltins =
      allowedTools.length > 0
        ? createGuardedBuiltinToolDefinitions(options.cwd, allowedTools, {
            bashPath: config.bashPath,
            getKnownSecrets: options.getKnownSecrets,
            ...(skillPaths.length > 0 ? { skillReadRoots: skillPaths } : {}),
            ...(researchCfg ? { maxBashTimeoutSec: researchCfg.reverserBashTimeoutSec } : {}),
          })
        : [];
    const combinedTools = [...guardedBuiltins, ...allowedCustomTools].map((tool) =>
      this.wrapSubagentTool(options.cwd, tool, () => trackerRef.current)
    );
    const toolConfig =
      allowedTools.length > 0
        ? {
            noTools: 'builtin' as const,
            customTools: combinedTools,
          }
        : { noTools: 'all' as const, tools: [] as string[] };

    const thinkingLevel = options.thinkingLevel ?? profile.defaultThinkingLevel;
    const modelRuntime = options.modelRuntime
      ? wrapModelRuntimeWithReasoningOffFallback(options.modelRuntime)
      : undefined;

    const { session } = await createAgentSession({
      sessionManager,
      settingsManager,
      resourceLoader,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(modelRuntime ? { modelRuntime } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...toolConfig,
    });
    if ((session as any).modelRuntime) {
      wrapModelRuntimeWithReasoningOffFallback((session as any).modelRuntime);
    }

    activeSessionRef.current = session;
    if (isInteractiveRole) {
      applyCompactionSettingsForModel(settingsManager, session.model ?? options.model, compactionRole);
    }

    this.sessionTrackerRefs.set(session, trackerRef);
    applyPaperCupQueueModes(settingsManager, session);

    if (thinkingLevel && typeof session.setThinkingLevel === 'function') {
      try {
        session.setThinkingLevel(thinkingLevel);
      } catch {
        // Ignore clamping errors on models without explicit thinking metadata
      }
    }

    return { session, profile };
  }

  async createManagedSubagentSession(roleName: string, options: SubagentSessionOptions): Promise<ManagedSubagentSession> {
    const profile = this.getProfile(roleName);
    if (!profile) {
      throw new Error(`Subagent role '${roleName}' not found. Available roles: ${Array.from(this.profiles.keys()).join(', ')}`);
    }

    const { session } = await this.createSubagentSession(roleName, options);
    const resolvedThinking = String(
      (session.model && typeof session.thinkingLevel === 'string' ? session.thinkingLevel : undefined) ??
        options.thinkingLevel ??
        profile.defaultThinkingLevel ??
        'medium'
    );
    const resolvedModelKey =
      session.model?.provider && session.model?.id
        ? `${session.model.provider}/${session.model.id}`
        : options.model?.provider && options.model?.id
          ? `${options.model.provider}/${options.model.id}`
          : null;

    return {
      role: roleName,
      model: resolvedModelKey,
      prompt: (task, runOptions = {}) =>
        this.executeOnSession(session, profile, roleName, task, {
          cwd: options.cwd,
          resolvedThinking,
          fallbackModelKey: resolvedModelKey,
          getKnownSecrets: options.getKnownSecrets,
          onDelta: runOptions.onDelta,
          signal: runOptions.signal,
          sessionId: runOptions.sessionId,
          parentCallId: runOptions.parentCallId,
          taskId: runOptions.taskId,
          threadId: runOptions.threadId,
          resumedFromTaskId: runOptions.resumedFromTaskId,
          priorMessages: runOptions.priorMessages,
          priorCompactionCount: runOptions.priorCompactionCount,
          origin: runOptions.origin,
          images: runOptions.images,
          displayTaskPrompt: runOptions.displayTaskPrompt,
          recordDiagnostics: runOptions.recordDiagnostics,
          onTaskUpdated: runOptions.onTaskUpdated,
          onStreamDelta: runOptions.onStreamDelta,
          usageKind: runOptions.usageKind,
          onUsage: runOptions.onUsage,
        }),
      compact: async (focus?: string) => {
        const cleanFocus = typeof focus === 'string' && focus.trim() ? focus.trim() : undefined;
        const result = await session.compact(cleanFocus);
        const summaryInfo = buildCompactionSummaryFromSession(session, result, 'manual', cleanFocus);
        return {
          result,
          summaryInfo,
          contextUsage: readSessionContextUsage(session, roleName),
        };
      },
      getContextUsage: () => readSessionContextUsage(session, roleName),
      waitForIdle: () => Promise.resolve(session.waitForIdle?.()),
      canResume: () => hasBalancedSessionHistory(session),
      dispose: () => {
        session.dispose?.();
      },
    };
  }

  private async executeOnSession(
    session: any,
    profile: SubagentProfile,
    roleName: string,
    task: string,
    options: {
      cwd: string;
      resolvedThinking: string;
      fallbackModelKey: string | null;
      getKnownSecrets?: () => Iterable<string>;
      onDelta?: (delta: string) => void;
      signal?: AbortSignal;
      sessionId?: string | null;
      parentCallId?: string;
      taskId?: string;
      threadId?: string;
      resumedFromTaskId?: string;
      priorMessages?: SubagentChatMessage[];
      priorCompactionCount?: number;
      origin?: 'delegated' | 'direct_user';
      images?: ChatImageAttachment[];
      displayTaskPrompt?: string;
      recordDiagnostics?: boolean;
      onTaskUpdated?: SubagentTaskUpdatedListener;
      onStreamDelta?: SubagentStreamDeltaListener;
      usageKind?: string;
      onUsage?: SubagentUsageListener;
    }
  ): Promise<SubagentRunResult> {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const taskId = options.taskId || generateTaskId(roleName);
    const threadId = options.threadId || options.resumedFromTaskId || taskId;
    const isInteractiveRole = roleName !== 'translator';
    const resolvedThinking = options.resolvedThinking;
    const resolvedModelKey =
      session.model?.provider && session.model?.id
        ? `${session.model.provider}/${session.model.id}`
        : options.fallbackModelKey;

    const usage: SubagentUsageStats = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
    let reasoningTokens = 0;
    let hasReasoningTokens = false;
    const toolCalls: SubagentToolCallStat[] = [];
    const toolStartTimes = new Map<string, { name: string; at: number }>();

    const researchConfig = readVnResearchConfig(options.cwd);
    const displayPromptRaw = options.displayTaskPrompt ?? task;
    const safeTaskPrompt =
      roleName === 'translator'
        ? `[translator batch prompt: ${displayPromptRaw.length} chars]`
        : clipText(redactSecrets(displayPromptRaw, options.getKnownSecrets?.()), MAX_TASK_PROMPT_CHARS);

    const initialImages = Array.isArray(options.images) ? options.images.map((img) => ({ ...img })) : [];
    const initialMessages = isInteractiveRole
      ? pushBoundedChatMessage(cloneChatMessages(options.priorMessages) ?? [], {
          id: `${taskId}-u-${startedAt.toString(36)}`,
          role: 'user',
          content: clipBoundedStreamField('', safeTaskPrompt, MAX_SUBAGENT_TEXT_CHARS),
          ...(initialImages.length > 0 ? { images: initialImages } : {}),
          timestamp: startedAtIso,
          turnTaskId: taskId,
          origin: options.origin ?? 'delegated',
        })
      : undefined;

    const snapshot: SubagentTaskSnapshot = {
      taskId,
      threadId,
      ...(options.resumedFromTaskId ? { resumedFromTaskId: options.resumedFromTaskId } : {}),
      sessionId: options.sessionId ?? null,
      ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
      role: roleName,
      model: resolvedModelKey,
      thinkingLevel: resolvedThinking,
      status: 'running',
      activityState: 'waiting_model',
      stage: inferSubagentStage(roleName),
      startedAt: startedAtIso,
      lastActivityAt: startedAtIso,
      lastProgressAt: null,
      lastProgressSummary: null,
      durationMs: 0,
      toolCallCount: 0,
      errorCount: 0,
      artifactsCount: 0,
      consecutiveHypothesisFailures: 0,
      pivotWarningCount: 0,
      interactive: isInteractiveRole,
      isThinking: false,
      ...(typeof options.priorCompactionCount === 'number' && options.priorCompactionCount > 0
        ? { compactionCount: options.priorCompactionCount }
        : {}),
      queuedCompaction: null,
      contextUsage: readSessionContextUsage(session, roleName),
      taskSummary: clipText(safeTaskPrompt.replace(/\s+/g, ' ').trim(), 160),
      taskPrompt: safeTaskPrompt,
      maxConsecutiveFailures: researchConfig.maxConsecutiveFailures,
      artifacts: [],
      pivotWarnings: [],
      retryCount: 0,
      usage: { ...usage },
      toolCalls: [],
      responsePreview: '',
      ...(initialMessages ? { messages: initialMessages } : {}),
    };

    const buildMetrics = (
      status: 'success' | 'error' | 'aborted',
      stopReason: string | null,
      responseChars: number,
      modelStr: string | null,
      errorMsg?: string,
      interruptKind?: SubagentInterruptKind
    ): SubagentRunMetrics => {
      const sanitizedError = errorMsg ? redactSecrets(errorMsg, options.getKnownSecrets?.()) : undefined;
      return {
        timestamp: new Date().toISOString(),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        taskId,
        role: roleName,
        model: modelStr,
        thinkingLevel: resolvedThinking,
        status,
        ...(interruptKind ? { interruptKind } : {}),
        stopReason,
        durationMs: Math.max(0, Date.now() - startedAt),
        usage: {
          ...usage,
          ...(hasReasoningTokens ? { reasoningTokens } : {}),
        },
        toolCalls,
        responseChars,
        ...(sanitizedError ? { error: sanitizedError } : {}),
      };
    };

    let assistantStepSeq = 0;
    let streamDeltaSeq = 0;
    let currentAssistantMsg: SubagentChatMessage | null = null;
    let pendingThinkingDelta = '';
    let pendingThinkingStartOffset: number | null = null;
    let pendingTextDelta = '';
    let pendingTextStartOffset: number | null = null;
    let pendingDeltaMsgId = '';
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const streamDeltaListener = options.onStreamDelta ?? this.defaultOnStreamDelta;
    const translatorBatchMeta = !isInteractiveRole ? extractTranslatorBatchMeta(task) : {};
    let translatorThinkingChars = 0;
    let translatorOutputChars = 0;
    let translatorCompletedLines = 0;
    let translatorPendingLine = '';
    let lastTranslatorEmitAtMs = 0;
    let lastTranslatorThinkingFlag: boolean | null = null;

    const flushTranslatorPendingLine = () => {
      if (!translatorPendingLine) return;
      const trimmed = translatorPendingLine.trim();
      translatorPendingLine = '';
      if (trimmed && !trimmed.startsWith('```')) {
        translatorCompletedLines += 1;
      }
    };

    const flushStreamDeltas = () => {
      if (streamFlushTimer) {
        clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
      if (!pendingDeltaMsgId) {
        pendingThinkingDelta = '';
        pendingThinkingStartOffset = null;
        pendingTextDelta = '';
        pendingTextStartOffset = null;
        return;
      }
      if (pendingThinkingDelta) {
        const delta = pendingThinkingDelta;
        const offset = pendingThinkingStartOffset ?? 0;
        pendingThinkingDelta = '';
        pendingThinkingStartOffset = null;
        streamDeltaListener?.({
          taskId,
          threadId,
          sessionId: snapshot.sessionId,
          role: roleName,
          messageId: pendingDeltaMsgId,
          kind: 'thinking',
          delta,
          seq: ++streamDeltaSeq,
          offset,
          endOffset: offset + delta.length,
        });
      }
      if (pendingTextDelta) {
        const delta = pendingTextDelta;
        const offset = pendingTextStartOffset ?? 0;
        pendingTextDelta = '';
        pendingTextStartOffset = null;
        streamDeltaListener?.({
          taskId,
          threadId,
          sessionId: snapshot.sessionId,
          role: roleName,
          messageId: pendingDeltaMsgId,
          kind: 'text',
          delta,
          seq: ++streamDeltaSeq,
          offset,
          endOffset: offset + delta.length,
        });
      }
    };

    const queueStreamDelta = (
      messageId: string,
      kind: 'thinking' | 'text',
      delta: string,
      startOffset: number
    ) => {
      if (!delta || !streamDeltaListener) return;
      if (pendingDeltaMsgId && pendingDeltaMsgId !== messageId) {
        flushStreamDeltas();
      }
      pendingDeltaMsgId = messageId;
      if (kind === 'thinking') {
        if (!pendingThinkingDelta) {
          pendingThinkingStartOffset = startOffset;
        }
        pendingThinkingDelta += delta;
      } else {
        if (!pendingTextDelta) {
          pendingTextStartOffset = startOffset;
        }
        pendingTextDelta += delta;
      }
      if (!streamFlushTimer) {
        streamFlushTimer = setTimeout(() => {
          flushStreamDeltas();
        }, SUBAGENT_STREAM_THROTTLE_MS);
        streamFlushTimer.unref?.();
      }
    };

    const ensureCurrentAssistantMsg = (): SubagentChatMessage | null => {
      if (!isInteractiveRole) return null;
      if (currentAssistantMsg) return currentAssistantMsg;
      assistantStepSeq += 1;
      const next: SubagentChatMessage = {
        id: `${taskId}-a-${assistantStepSeq}`,
        role: 'assistant',
        content: '',
        contentOffset: 0,
        timestamp: new Date().toISOString(),
        turnTaskId: taskId,
      };
      snapshot.messages = pushBoundedChatMessage(snapshot.messages ?? [], next);
      currentAssistantMsg = snapshot.messages[snapshot.messages.length - 1] ?? next;
      return currentAssistantMsg;
    };

    const findMessageToolCall = (callId: string, toolName: string): SubagentChatToolCall | undefined => {
      const checkList = (tools?: SubagentChatToolCall[]) => {
        if (!Array.isArray(tools)) return undefined;
        return (
          (callId ? tools.find((t) => t.callId === callId && t.status === 'running') : undefined) ??
          tools.find((t) => t.tool === toolName && t.status === 'running') ??
          (callId ? tools.find((t) => t.callId === callId) : undefined)
        );
      };
      const direct = checkList(currentAssistantMsg?.tools);
      if (direct) return direct;
      if (!Array.isArray(snapshot.messages)) return undefined;
      for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
        const match = checkList(snapshot.messages[i]?.tools);
        if (match) return match;
      }
      return undefined;
    };

    const queueController = new SessionQueueController();
    const syncSnapshotPendingQueue = (state: PendingQueueState) => {
      const total = countQueuedMessages(state);
      snapshot.pendingQueue = total > 0 ? cloneQueueState(state) : undefined;
      snapshot.pendingQueueCount = total;
    };
    const emitSubagentQueueUpdate = (overrideState?: PendingQueueState) => {
      const state = overrideState ?? queueController.getState();
      syncSnapshotPendingQueue(state);
      this.defaultOnQueueUpdated?.({
        taskId,
        threadId,
        sessionId: snapshot.sessionId,
        role: roleName,
        queue: cloneQueueState(state),
      });
    };

    let initialKnownEngine = false;
    try {
      const locTbl = readWorkspaceTomlSection(options.cwd, 'vn.localization');
      if (typeof locTbl?.engine === 'string' && locTbl.engine.trim()) {
        initialKnownEngine = true;
      }
    } catch {
      // ignore
    }
    const initialRecallLogged = hasResearchRecallHypotheses(options.cwd);

    const runCtx: ActiveSubagentRunContext = {
      cwd: options.cwd,
      session,
      snapshot,
      recordDiagnostics: Boolean(options.recordDiagnostics),
      getKnownSecrets: options.getKnownSecrets,
      onTaskUpdated: options.onTaskUpdated,
      toolOutcomeByCallId: new Map(),
      queueController,
      userSteeredNotes: [],
      pendingRestoredDraft: null,
      restoredDraftEmitted: false,
      emitQueueUpdate: () => {
        if (!runCtx.finalized) {
          emitSubagentQueueUpdate();
          this.emitAndPersistSnapshot(runCtx, false);
        }
      },
      lastPersistAtMs: 0,
      finalized: false,
      callsSinceProgress: 0,
      lastSoftStallRemindAt: 0,
      callsSinceDeliverable: 0,
      lastNoDeliverableRemindAt: 0,
      compactionsSinceDeliverable: 0,
      knownEngineHintDetected: initialKnownEngine,
      recallFirstNoticed: false,
      recallLoggedInRun: initialRecallLogged,
      tmpTextReadCount: 0,
      scratchScriptPaths: new Set(),
      deliveredSkillOrScript: false,
      finalize: (status, activityState, errorMsg) => {
        if (runCtx.finalized) return;
        runCtx.finalized = true;
        flushStreamDeltas();
        const hadPendingQueue =
          queueController.hasPending() ||
          ((session.getSteeringMessages?.().length ?? 0) + (session.getFollowUpMessages?.().length ?? 0)) > 0;
        if (status === 'aborted' || status === 'error') {
          if (!runCtx.pendingRestoredDraft && hadPendingQueue) {
            runCtx.pendingRestoredDraft = queueController.clearForRestore(session);
          } else {
            try {
              session.clearQueue?.();
            } catch {
              // Ignore queue cleanup error
            }
            queueController.reset();
          }
        } else {
          try {
            session.clearQueue?.();
          } catch {
            // Ignore queue cleanup error
          }
          queueController.reset();
        }
        const emptyQueue = createEmptyQueueState();
        syncSnapshotPendingQueue(emptyQueue);
        if (hadPendingQueue || runCtx.pendingRestoredDraft) {
          this.defaultOnQueueUpdated?.({
            taskId,
            threadId,
            sessionId: snapshot.sessionId,
            role: roleName,
            queue: emptyQueue,
          });
        }
        if ((status === 'aborted' || status === 'error') && runCtx.pendingRestoredDraft && !runCtx.restoredDraftEmitted) {
          runCtx.restoredDraftEmitted = true;
          this.defaultOnQueueRestored?.({
            taskId,
            threadId,
            sessionId: snapshot.sessionId,
            role: roleName,
            restoredDraft: runCtx.pendingRestoredDraft,
            reason: status,
          });
        }
        const nowIso = new Date().toISOString();
        snapshot.status = status;
        snapshot.activityState = activityState;
        snapshot.isThinking = false;
        if (!isInteractiveRole) {
          flushTranslatorPendingLine();
          if (translatorOutputChars > 0 || translatorThinkingChars > 0) {
            snapshot.lastProgressAt = nowIso;
            snapshot.lastProgressSummary = formatTranslatorProgressSummary({
              phase: 'done',
              batchId: translatorBatchMeta.batchId,
              expectedRows: translatorBatchMeta.expectedRows,
              thinkingChars: translatorThinkingChars,
              outputChars: translatorOutputChars,
              completedLines: translatorCompletedLines,
            });
          }
        }
        snapshot.endedAt = nowIso;
        snapshot.lastActivityAt = nowIso;
        snapshot.durationMs = Math.max(0, Date.now() - startedAt);
        snapshot.queuedCompaction = null;
        runCtx.queuedCompaction = null;
        snapshot.contextUsage = readSessionContextUsage(session, roleName);
        snapshot.usage = {
          ...usage,
          ...(hasReasoningTokens ? { reasoningTokens } : {}),
        };
        if (errorMsg) {
          snapshot.error = redactSecrets(errorMsg, options.getKnownSecrets?.());
        }
        if (status === 'error' || status === 'aborted') {
          snapshot.interruptKind =
            snapshot.interruptKind ??
            classifySubagentError(snapshot.error || errorMsg || '', status === 'aborted').kind;
        }
        for (const tc of snapshot.toolCalls) {
          if (tc.status === 'running') {
            tc.status = status === 'aborted' ? 'aborted' : 'error';
            tc.endedAt = nowIso;
            tc.isError = true;
            const meta = runCtx.toolOutcomeByCallId.get(tc.callId);
            if (meta?.resultSummary && !tc.resultSummary) tc.resultSummary = meta.resultSummary;
            if (meta?.savedOutputPath && !tc.savedOutputPath) tc.savedOutputPath = meta.savedOutputPath;
            if (meta?.producedArtifact && !tc.producedArtifact) tc.producedArtifact = meta.producedArtifact;
          }
        }
        if (isInteractiveRole && Array.isArray(snapshot.messages)) {
          for (const msg of snapshot.messages) {
            if (!Array.isArray(msg.tools)) continue;
            for (const tc of msg.tools) {
              if (tc.status === 'running') {
                tc.status = status === 'aborted' ? 'aborted' : 'error';
                tc.isError = true;
                const meta = runCtx.toolOutcomeByCallId.get(tc.callId);
                if (meta?.fullResultText && !tc.result) tc.result = meta.fullResultText;
                else if (meta?.resultSummary && !tc.result) tc.result = meta.resultSummary;
                if (meta?.savedOutputPath && !tc.savedOutputPath) tc.savedOutputPath = meta.savedOutputPath;
                if (meta?.producedArtifact && !tc.producedArtifact) tc.producedArtifact = meta.producedArtifact;
              }
            }
          }
          const lastMsg = snapshot.messages[snapshot.messages.length - 1];
          if (
            lastMsg &&
            lastMsg.role === 'assistant' &&
            lastMsg.turnTaskId === taskId &&
            !lastMsg.content &&
            !lastMsg.thinking &&
            (!lastMsg.tools || lastMsg.tools.length === 0)
          ) {
            snapshot.messages.pop();
          } else if (lastMsg && lastMsg.role === 'assistant' && lastMsg.turnTaskId === taskId && status !== 'completed') {
            lastMsg.error = true;
          }
          if (currentAssistantMsg && currentAssistantMsg.thinking === '') {
            delete currentAssistantMsg.thinking;
          }
        }
        syncSnapshotCounters(snapshot);
        this.activeRuns.delete(taskId);
        if (runCtx.recordDiagnostics) {
          appendTaskEventToDisk(options.cwd, {
            timestamp: nowIso,
            taskId,
            sessionId: snapshot.sessionId,
            role: roleName,
            type: `task_${status}`,
            stage: snapshot.stage,
            activityState,
            durationMs: snapshot.durationMs,
            ...(snapshot.interruptKind ? { interruptKind: snapshot.interruptKind } : {}),
            ...(snapshot.error ? { error: snapshot.error } : {}),
          });
        }
        this.emitAndPersistSnapshot(runCtx, true);
      },
    };

    if (requiresResearchGuardrails(roleName, profile.allowedTools)) {
      const roleLabel = roleName === 'reverser' ? 'Reverser' : `子代理 ${roleName}`;
      runCtx.budgetMaxToolCalls =
        researchConfig.maxReverserToolCalls > 0 ? researchConfig.maxReverserToolCalls : undefined;
      runCtx.budgetHardStopFailures =
        researchConfig.hardStopConsecutiveFailures > 0
          ? researchConfig.hardStopConsecutiveFailures
          : undefined;
      runCtx.budgetMaxStallCalls =
        researchConfig.maxReverserStallCalls > 0 ? researchConfig.maxReverserStallCalls : undefined;
      runCtx.budgetMaxNoDeliverableCompactions =
        researchConfig.maxReverserNoDeliverableCompactions > 0
          ? researchConfig.maxReverserNoDeliverableCompactions
          : undefined;
      runCtx.budgetMaxTokens =
        researchConfig.maxReverserTokens > 0 ? researchConfig.maxReverserTokens : undefined;
      if (runCtx.budgetMaxToolCalls !== undefined) {
        snapshot.maxToolCalls = runCtx.budgetMaxToolCalls;
      }
      if (runCtx.budgetMaxStallCalls !== undefined) {
        snapshot.maxStallCalls = runCtx.budgetMaxStallCalls;
        snapshot.callsSinceProgress = 0;
      }
      if (researchConfig.maxReverserDurationMs > 0) {
        const timeoutMinutes = +(researchConfig.maxReverserDurationMs / 60000).toFixed(1);
        runCtx.budgetTimer = setTimeout(() => {
          if (runCtx.finalized) return;
          const timeoutMsg = `${roleLabel} 单轮执行超时（超过 ${timeoutMinutes} 分钟 / ${Math.round(researchConfig.maxReverserDurationMs / 1000)} 秒），已强制停止并交回主 Agent 汇报进展与阻碍。`;
          runCtx.budgetAbortReason = timeoutMsg;
          runCtx.budgetResumable = true;
          snapshot.interruptKind = 'timeout';
          runCtx.finalize('aborted', 'aborted', timeoutMsg);
          try {
            void session.abort?.();
          } catch {
            // Ignore abort error
          }
        }, researchConfig.maxReverserDurationMs);
        runCtx.budgetTimer.unref?.();
      }
    }

    if (options.signal?.aborted) {
      const abortMsg = redactSecrets(resolveAbortReason(options.signal), options.getKnownSecrets?.());
      const abortKind = classifySubagentError(abortMsg, true).kind;
      runCtx.finalize('aborted', 'aborted', abortMsg);
      const abortedMetrics = buildMetrics('aborted', 'aborted', 0, resolvedModelKey, abortMsg, abortKind);
      if (options.recordDiagnostics) {
        appendSubagentDiagnostic(options.cwd, abortedMetrics);
      }
      const err: any = new Error(abortMsg);
      err.metrics = abortedMetrics;
      err.taskId = taskId;
      err.interruptKind = abortKind;
      err.snapshot = cloneTaskSnapshot(snapshot);
      throw err;
    }

    const trackerRef = this.sessionTrackerRefs.get(session);
    if (trackerRef) {
      trackerRef.current = runCtx;
    }
    this.activeRuns.set(taskId, runCtx);
    if (runCtx.recordDiagnostics) {
      appendTaskEventToDisk(options.cwd, {
        timestamp: startedAtIso,
        taskId,
        sessionId: snapshot.sessionId,
        role: roleName,
        type: 'task_started',
        stage: snapshot.stage,
        activityState: snapshot.activityState,
      });
    }
    this.emitAndPersistSnapshot(runCtx, true);

    let responseText = '';
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    let observedModelKey: string | null = resolvedModelKey;
    let seenInitialUserMessage = false;
    let injectedUserSeq = 0;
    let prevStageBeforeCompact = snapshot.stage;
    let prevActivityBeforeCompact: SubagentActivityState = snapshot.activityState;
    let subagentOverflowCompactionAttempted = false;
    let pendingSubagentCompactFocus: string | undefined;
    let pendingSubagentCompactReasonOverride: CompactionReason | undefined;

    const onAbort = () => {
      const abortMsg = resolveAbortReason(options.signal, snapshot.error, lastErrorMessage);
      if (!runCtx.pendingRestoredDraft) {
        runCtx.pendingRestoredDraft = queueController.clearForRestore(session);
      }
      runCtx.finalize('aborted', 'aborted', abortMsg);
      void session.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === 'queue_update') {
        if (!runCtx.finalized && !queueController.isRebuilding) {
          queueController.reconcileWithSession(session);
          emitSubagentQueueUpdate();
        }
        return;
      }
      if (event.type === 'message_start' && event.message?.role === 'user') {
        if (!seenInitialUserMessage) {
          seenInitialUserMessage = true;
          return;
        }
        flushStreamDeltas();
        if (isInteractiveRole && !runCtx.finalized) {
          const rawText = extractUserMessageText(event.message?.content);
          const injectedImages = extractImagesFromContent(event.message?.content);
          const delivered = queueController.consumeDelivered(rawText, session);
          const deliveryMode: QueuedMessageMode = delivered?.mode ?? 'steer';
          const displayRaw = delivered?.text ?? rawText;
          const safeText = clipBoundedStreamField(
            '',
            redactSecrets(displayRaw, options.getKnownSecrets?.()),
            MAX_SUBAGENT_TEXT_CHARS
          );
          const nowIso = new Date().toISOString();
          injectedUserSeq += 1;

          // 如果前一个 assistant 气泡为空占位，先弹出避免产生空气泡
          if (
            currentAssistantMsg &&
            !currentAssistantMsg.content &&
            !currentAssistantMsg.thinking &&
            (!currentAssistantMsg.tools || currentAssistantMsg.tools.length === 0) &&
            Array.isArray(snapshot.messages) &&
            snapshot.messages[snapshot.messages.length - 1] === currentAssistantMsg
          ) {
            snapshot.messages.pop();
          }
          currentAssistantMsg = null;
          pendingDeltaMsgId = '';
          snapshot.isThinking = false;
          snapshot.lastActivityAt = nowIso;
          snapshot.activityState = 'waiting_model';

          if (safeText.trim() || injectedImages.length > 0) {
            snapshot.messages = pushBoundedChatMessage(snapshot.messages ?? [], {
              id: `${taskId}-u-${deliveryMode}-${injectedUserSeq}`,
              role: 'user',
              content: safeText,
              ...(injectedImages.length > 0 ? { images: injectedImages } : {}),
              timestamp: nowIso,
              turnTaskId: taskId,
              origin: 'direct_user',
              deliveryMode,
            });
            runCtx.userSteeredNotes.push({
              mode: deliveryMode,
              text: safeText || DEFAULT_IMAGE_ONLY_PROMPT,
              timestamp: nowIso,
            });
            snapshot.userSteerCount = runCtx.userSteeredNotes.length;
          }

          // 人工 Steer 投递后重置连续失败与停滞计数（不重置 maxToolCalls 与总时长预算）
          if (deliveryMode === 'steer') {
            snapshot.consecutiveHypothesisFailures = 0;
            runCtx.callsSinceProgress = 0;
            runCtx.lastSoftStallRemindAt = 0;
            runCtx.callsSinceDeliverable = 0;
            runCtx.lastNoDeliverableRemindAt = 0;
            runCtx.compactionsSinceDeliverable = 0;
            runCtx.pendingCompactionWarning = undefined;
            runCtx.tmpTextReadCount = 0;
            runCtx.scratchScriptPaths?.clear();
            runCtx.lastStallTurnKey = undefined;
            if (runCtx.budgetMaxStallCalls !== undefined && runCtx.budgetMaxStallCalls > 0) {
              snapshot.callsSinceProgress = 0;
            }
          }

          if (runCtx.recordDiagnostics) {
            appendTaskEventToDisk(options.cwd, {
              timestamp: nowIso,
              taskId,
              sessionId: snapshot.sessionId,
              role: roleName,
              type: deliveryMode === 'steer' ? 'user_steered' : 'user_followup',
              stage: snapshot.stage,
              activityState: snapshot.activityState,
            });
          }

          emitSubagentQueueUpdate();
          this.emitAndPersistSnapshot(runCtx, true);
        }
        return;
      }
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        flushStreamDeltas();
        if (isInteractiveRole && !runCtx.finalized) {
          if (
            currentAssistantMsg &&
            !currentAssistantMsg.content &&
            !currentAssistantMsg.thinking &&
            (!currentAssistantMsg.tools || currentAssistantMsg.tools.length === 0) &&
            Array.isArray(snapshot.messages) &&
            snapshot.messages[snapshot.messages.length - 1] === currentAssistantMsg
          ) {
            snapshot.messages.pop();
          }
          currentAssistantMsg = null;
          pendingDeltaMsgId = '';
          snapshot.isThinking = false;
        }
      } else if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        if (update && update.type === 'text_delta') {
          const safeDelta = redactSecrets(String(update.delta || ''), options.getKnownSecrets?.());
          responseText += safeDelta;
          options.onDelta?.(safeDelta);
          if (!runCtx.finalized) {
            const nowMs = Date.now();
            const nowIso = new Date(nowMs).toISOString();
            snapshot.lastActivityAt = nowIso;
            snapshot.activityState = 'waiting_model';
            snapshot.durationMs = Math.max(0, nowMs - startedAt);
            if (isInteractiveRole) {
              snapshot.isThinking = false;
              const msgObj = ensureCurrentAssistantMsg();
              if (msgObj && safeDelta) {
                const prevLen = msgObj.content.length;
                msgObj.content = clipBoundedStreamField(msgObj.content, safeDelta, MAX_SUBAGENT_TEXT_CHARS);
                msgObj.contentOffset = msgObj.content.length;
                const added = msgObj.content.slice(prevLen);
                if (added) {
                  queueStreamDelta(msgObj.id, 'text', added, prevLen);
                }
              }
              snapshot.responsePreview = clipTailText(
                redactSecrets(responseText, options.getKnownSecrets?.()),
                MAX_RESPONSE_PREVIEW_CHARS
              );
              this.emitAndPersistSnapshot(runCtx, false);
            } else {
              const rawDelta = String(update.delta || '');
              translatorOutputChars += rawDelta.length;
              if (rawDelta) {
                const combined = translatorPendingLine + rawDelta;
                const parts = combined.split(/\r?\n/);
                translatorPendingLine = parts.pop() ?? '';
                for (const line of parts) {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('```')) {
                    translatorCompletedLines += 1;
                  }
                }
              }
              snapshot.isThinking = false;
              snapshot.lastProgressAt = nowIso;
              snapshot.lastProgressSummary = formatTranslatorProgressSummary({
                phase: 'generating',
                batchId: translatorBatchMeta.batchId,
                expectedRows: translatorBatchMeta.expectedRows,
                thinkingChars: translatorThinkingChars,
                outputChars: translatorOutputChars,
                completedLines: translatorCompletedLines,
              });
              const transitioned = lastTranslatorThinkingFlag !== false;
              if (transitioned || nowMs - lastTranslatorEmitAtMs >= TRANSLATOR_PROGRESS_EMIT_INTERVAL_MS) {
                lastTranslatorThinkingFlag = false;
                lastTranslatorEmitAtMs = nowMs;
                this.emitAndPersistSnapshot(runCtx, false);
              }
            }
          }
        } else if (update && update.type === 'thinking_delta') {
          if (!runCtx.finalized) {
            const nowMs = Date.now();
            const nowIso = new Date(nowMs).toISOString();
            snapshot.lastActivityAt = nowIso;
            snapshot.activityState = 'waiting_model';
            snapshot.durationMs = Math.max(0, nowMs - startedAt);
            if (isInteractiveRole) {
              snapshot.isThinking = true;
              const safeThinkingDelta = redactSecrets(String(update.delta || ''), options.getKnownSecrets?.());
              const msgObj = ensureCurrentAssistantMsg();
              if (msgObj && safeThinkingDelta) {
                const prevThinking = msgObj.thinking ?? '';
                const nextThinking = clipBoundedStreamField(
                  prevThinking,
                  safeThinkingDelta,
                  MAX_SUBAGENT_THINKING_CHARS
                );
                msgObj.thinking = nextThinking;
                msgObj.thinkingOffset = nextThinking.length;
                const added = nextThinking.slice(prevThinking.length);
                if (added) {
                  queueStreamDelta(msgObj.id, 'thinking', added, prevThinking.length);
                }
              }
              this.emitAndPersistSnapshot(runCtx, false);
            } else {
              translatorThinkingChars += String(update.delta || '').length;
              snapshot.isThinking = true;
              snapshot.lastProgressAt = nowIso;
              snapshot.lastProgressSummary = formatTranslatorProgressSummary({
                phase: 'thinking',
                batchId: translatorBatchMeta.batchId,
                expectedRows: translatorBatchMeta.expectedRows,
                thinkingChars: translatorThinkingChars,
                outputChars: translatorOutputChars,
                completedLines: translatorCompletedLines,
              });
              const transitioned = lastTranslatorThinkingFlag !== true;
              if (transitioned || nowMs - lastTranslatorEmitAtMs >= TRANSLATOR_PROGRESS_EMIT_INTERVAL_MS) {
                lastTranslatorThinkingFlag = true;
                lastTranslatorEmitAtMs = nowMs;
                this.emitAndPersistSnapshot(runCtx, false);
              }
            }
          }
        }
      } else if (event.type === 'tool_execution_start') {
        flushStreamDeltas();
        const callId =
          typeof event.toolCallId === 'string' && event.toolCallId
            ? event.toolCallId
            : `${event.toolName}-${toolStartTimes.size}`;
        const toolName = String(event.toolName || 'unknown');
        const nowIso = new Date().toISOString();
        toolStartTimes.set(callId, { name: toolName, at: Date.now() });

        if (!runCtx.finalized) {
          snapshot.lastActivityAt = nowIso;
          snapshot.activityState = 'running_tool';
          snapshot.stage = inferSubagentStage(roleName, toolName, event.args);
          snapshot.durationMs = Math.max(0, Date.now() - startedAt);
          const boundedArgs = boundUnknownArgs(event.args, options.getKnownSecrets);
          snapshot.toolCalls.push({
            callId,
            tool: toolName,
            argsSummary: summarizeArgs(event.args, options.getKnownSecrets),
            args: boundedArgs,
            status: 'running',
            startedAt: nowIso,
          });
          if (isInteractiveRole) {
            snapshot.isThinking = false;
            const msgObj = ensureCurrentAssistantMsg();
            if (msgObj) {
              if (!Array.isArray(msgObj.tools)) msgObj.tools = [];
              msgObj.tools.push({
                callId,
                tool: toolName,
                args: boundedArgs,
                status: 'running',
              });
            }
          }
          if (runCtx.recordDiagnostics) {
            appendTaskEventToDisk(options.cwd, {
              timestamp: nowIso,
              taskId,
              sessionId: snapshot.sessionId,
              role: roleName,
              type: 'tool_start',
              stage: snapshot.stage,
              activityState: snapshot.activityState,
              tool: toolName,
              callId,
            });
          }
          this.emitAndPersistSnapshot(runCtx, true);
        }
      } else if (event.type === 'tool_execution_end') {
        const callId = typeof event.toolCallId === 'string' && event.toolCallId ? event.toolCallId : '';
        const started = callId ? toolStartTimes.get(callId) : undefined;
        if (callId) toolStartTimes.delete(callId);
        const dur =
          typeof event.durationMs === 'number'
            ? Math.round(event.durationMs)
            : started
              ? Math.max(0, Date.now() - started.at)
              : 0;
        const toolName = String(event.toolName || started?.name || 'unknown');
        const outcome = callId ? runCtx.toolOutcomeByCallId.get(callId) : undefined;
        const isErr = Boolean(event.isError === true || outcome?.isError);
        toolCalls.push({
          tool: toolName,
          durationMs: dur,
          isError: isErr,
        });

        if (!runCtx.finalized) {
          const nowIso = new Date().toISOString();
          snapshot.lastActivityAt = nowIso;
          snapshot.activityState = 'waiting_model';
          snapshot.durationMs = Math.max(0, Date.now() - startedAt);
          const matchingCall =
            (callId
              ? snapshot.toolCalls.find((t) => t.callId === callId && t.status === 'running')
              : undefined) ??
            snapshot.toolCalls.find((t) => t.tool === toolName && t.status === 'running');
          const outPath = outcome?.savedOutputPath ?? event.result?.details?.savedOutputPath;
          if (matchingCall) {
            matchingCall.status = isErr ? 'error' : 'completed';
            matchingCall.endedAt = nowIso;
            matchingCall.durationMs = dur;
            matchingCall.isError = isErr;
            matchingCall.resultSummary =
              outcome?.resultSummary ?? clipText(extractResultText(event.result, options.getKnownSecrets), MAX_RESULT_SUMMARY_CHARS);
            if (typeof outPath === 'string' && outPath) {
              matchingCall.savedOutputPath = outPath;
            }
            if (outcome?.producedArtifact) {
              matchingCall.producedArtifact = outcome.producedArtifact;
            }
          }
          if (isInteractiveRole) {
            const msgTool = findMessageToolCall(callId, toolName);
            if (msgTool) {
              msgTool.status = isErr ? 'error' : 'completed';
              msgTool.durationMs = dur;
              msgTool.isError = isErr;
              msgTool.result =
                outcome?.fullResultText ??
                clipText(extractResultText(event.result, options.getKnownSecrets), MAX_SUBAGENT_TOOL_RESULT_CHARS);
              if (typeof outPath === 'string' && outPath) {
                msgTool.savedOutputPath = outPath;
              }
              if (outcome?.producedArtifact) {
                msgTool.producedArtifact = outcome.producedArtifact;
              }
            }
          }
          if (runCtx.recordDiagnostics) {
            appendTaskEventToDisk(options.cwd, {
              timestamp: nowIso,
              taskId,
              sessionId: snapshot.sessionId,
              role: roleName,
              type: 'tool_end',
              stage: snapshot.stage,
              activityState: snapshot.activityState,
              tool: toolName,
              callId: callId || undefined,
              status: isErr ? 'error' : 'completed',
              durationMs: dur,
            });
          }
          this.emitAndPersistSnapshot(runCtx, true);
        }
      } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
        flushStreamDeltas();
        const msg = event.message;
        lastStopReason = msg.stopReason;
        lastErrorMessage = msg.errorMessage;
        snapshot.isThinking = false;
        if (!isInteractiveRole && !runCtx.finalized) {
          flushTranslatorPendingLine();
          if (translatorOutputChars > 0 || translatorThinkingChars > 0) {
            snapshot.lastProgressAt = new Date().toISOString();
            snapshot.lastProgressSummary = formatTranslatorProgressSummary({
              phase: 'done',
              batchId: translatorBatchMeta.batchId,
              expectedRows: translatorBatchMeta.expectedRows,
              thinkingChars: translatorThinkingChars,
              outputChars: translatorOutputChars,
              completedLines: translatorCompletedLines,
            });
          }
        }
        if (msg.stopReason === 'error' && msg.errorMessage) {
          const cls = classifySubagentError(String(msg.errorMessage), false);
          if (cls.fatalForPool && typeof session.setAutoRetryEnabled === 'function') {
            session.setAutoRetryEnabled(false);
          }
        }
        if (isInteractiveRole && !runCtx.finalized && Array.isArray(msg.content)) {
          const fallbackThinking = msg.content
            .filter((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string')
            .map((b: any) => b.thinking)
            .join('');
          const fallbackText = msg.content
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('');
          if (fallbackThinking && !currentAssistantMsg?.thinking) {
            const safeThinking = redactSecrets(fallbackThinking, options.getKnownSecrets?.());
            const target = ensureCurrentAssistantMsg();
            if (target) {
              target.thinking = clipBoundedStreamField('', safeThinking, MAX_SUBAGENT_THINKING_CHARS);
              target.thinkingOffset = target.thinking.length;
            }
          }
          if (fallbackText && !currentAssistantMsg?.content) {
            const safeText = redactSecrets(fallbackText, options.getKnownSecrets?.());
            const target = ensureCurrentAssistantMsg();
            if (target) {
              target.content = clipBoundedStreamField('', safeText, MAX_SUBAGENT_TEXT_CHARS);
              target.contentOffset = target.content.length;
            }
            if (!responseText) {
              responseText = safeText;
              snapshot.responsePreview = clipTailText(safeText, MAX_RESPONSE_PREVIEW_CHARS);
            }
          }
        }
        if (isInteractiveRole && currentAssistantMsg) {
          if (msg.stopReason === 'error') {
            currentAssistantMsg.error = true;
          }
          if (currentAssistantMsg.thinking === '') {
            delete currentAssistantMsg.thinking;
          }
        }
        if (msg.provider && msg.model) {
          observedModelKey = `${msg.provider}/${msg.model}`;
          snapshot.model = observedModelKey;
        }
        if (msg.usage && typeof msg.usage === 'object') {
          const msgInput = addNumber(0, msg.usage.input);
          const msgOutput = addNumber(0, msg.usage.output);
          const msgCacheRead = addNumber(0, msg.usage.cacheRead);
          const msgCacheWrite = addNumber(0, msg.usage.cacheWrite);
          const rawTotal = addNumber(0, msg.usage.totalTokens);
          const msgTotal = rawTotal > 0 ? rawTotal : msgInput + msgOutput + msgCacheRead + msgCacheWrite;

          usage.input += msgInput;
          usage.output += msgOutput;
          usage.cacheRead += msgCacheRead;
          usage.cacheWrite += msgCacheWrite;
          usage.totalTokens += msgTotal;
          const rawReasoning = msg.usage.reasoning ?? msg.usage.reasoningTokens;
          if (typeof rawReasoning === 'number' && Number.isFinite(rawReasoning) && rawReasoning >= 0) {
            reasoningTokens += rawReasoning;
            hasReasoningTokens = true;
          }
          snapshot.usage = {
            ...usage,
            ...(hasReasoningTokens ? { reasoningTokens } : {}),
          };

          if (msgTotal > 0 || msgInput > 0 || msgOutput > 0 || msgCacheRead > 0 || msgCacheWrite > 0) {
            const rawCost = msg.usage.cost && typeof msg.usage.cost === 'object' ? msg.usage.cost : {};
            const normalizedUsage: Usage = {
              input: msgInput,
              output: msgOutput,
              cacheRead: msgCacheRead,
              cacheWrite: msgCacheWrite,
              ...(typeof rawReasoning === 'number' && Number.isFinite(rawReasoning) && rawReasoning >= 0
                ? { reasoning: rawReasoning }
                : {}),
              totalTokens: msgTotal,
              cost: {
                input: addNumber(0, rawCost.input),
                output: addNumber(0, rawCost.output),
                cacheRead: addNumber(0, rawCost.cacheRead),
                cacheWrite: addNumber(0, rawCost.cacheWrite),
                total: addNumber(0, rawCost.total),
              },
            };
            const usageListener = options.onUsage ?? this.defaultOnUsage;
            usageListener?.({
              sessionId: options.sessionId ?? null,
              taskId,
              role: roleName,
              usageKind: options.usageKind || `subagent:${roleName}`,
              provider: String(msg.provider || session.model?.provider || 'unknown'),
              model: String(msg.responseModel || msg.model || session.model?.id || 'unknown'),
              usage: normalizedUsage,
            });
          }
          if (
            roleName === 'reverser' &&
            !runCtx.finalized &&
            runCtx.budgetMaxTokens &&
            runCtx.budgetMaxTokens > 0 &&
            usage.totalTokens >= runCtx.budgetMaxTokens
          ) {
            const tokenMsg = `Reverser 本轮累计 Token 已达上限（${usage.totalTokens} / ${runCtx.budgetMaxTokens}），已强制收尾并交回主 Agent 决断。`;
            snapshot.pivotWarnings.push(tokenMsg);
            runCtx.budgetAbortReason = tokenMsg;
            runCtx.budgetResumable = true;
            snapshot.interruptKind = 'aborted';
            try {
              void session.abort?.();
            } catch {
              // ignore
            }
          }
        }
        if (isInteractiveRole && !runCtx.finalized) {
          snapshot.contextUsage = readSessionContextUsage(session, roleName);
          this.emitAndPersistSnapshot(runCtx, false);
        }
      } else if (event.type === 'compaction_start') {
        const rawReason: CompactionReason =
          pendingSubagentCompactReasonOverride ??
          (event.reason === 'manual' || event.reason === 'overflow' ? event.reason : 'threshold');
        if (rawReason === 'overflow') {
          subagentOverflowCompactionAttempted = true;
        }
        flushStreamDeltas();
        if (!runCtx.finalized) {
          const nowIso = new Date().toISOString();
          if (snapshot.stage !== 'compacting') {
            prevStageBeforeCompact = snapshot.stage;
          }
          if (snapshot.activityState !== 'compacting') {
            prevActivityBeforeCompact = snapshot.activityState;
          }
          snapshot.activityState = 'compacting';
          snapshot.stage = 'compacting';
          if (isInteractiveRole) {
            snapshot.isThinking = false;
          }
          snapshot.lastActivityAt = nowIso;
          snapshot.durationMs = Math.max(0, Date.now() - startedAt);
          if (runCtx.recordDiagnostics) {
            appendTaskEventToDisk(options.cwd, {
              timestamp: nowIso,
              taskId,
              sessionId: snapshot.sessionId,
              role: roleName,
              type: 'compaction_start',
              stage: 'compacting',
              activityState: 'compacting',
            });
          }
          this.emitAndPersistSnapshot(runCtx, true);
        }
      } else if (event.type === 'compaction_end') {
        const reason: CompactionReason =
          pendingSubagentCompactReasonOverride ??
          (event.reason === 'manual' || event.reason === 'overflow' ? event.reason : 'threshold');
        const nowIso = new Date().toISOString();
        snapshot.lastActivityAt = nowIso;
        snapshot.durationMs = Math.max(0, Date.now() - startedAt);
        snapshot.stage = prevStageBeforeCompact === 'compacting' ? inferSubagentStage(roleName) : prevStageBeforeCompact;
        if (!runCtx.finalized) {
          snapshot.activityState =
            !event.aborted && prevActivityBeforeCompact === 'running_tool'
              ? 'running_tool'
              : 'waiting_model';
        }
        snapshot.contextUsage = readSessionContextUsage(session, roleName);

        if (event.result) {
          snapshot.compactionCount = (snapshot.compactionCount ?? 0) + 1;
          const summaryInfo = buildCompactionSummaryFromSession(
            session,
            event.result,
            reason,
            reason === 'manual' ? pendingSubagentCompactFocus : undefined
          );
          const normalizedUsage = normalizeUsageRecord(event.result?.usage);
          if (normalizedUsage) {
            usage.input += normalizedUsage.input;
            usage.output += normalizedUsage.output;
            usage.cacheRead += normalizedUsage.cacheRead;
            usage.cacheWrite += normalizedUsage.cacheWrite;
            usage.totalTokens += normalizedUsage.totalTokens;
            if (normalizedUsage.reasoning !== undefined) {
              reasoningTokens += normalizedUsage.reasoning;
              hasReasoningTokens = true;
            }
            snapshot.usage = {
              ...usage,
              ...(hasReasoningTokens ? { reasoningTokens } : {}),
            };
            const usageListener = options.onUsage ?? this.defaultOnUsage;
            usageListener?.({
              sessionId: options.sessionId ?? null,
              taskId,
              role: roleName,
              usageKind: 'compaction',
              provider: String(session.model?.provider || 'unknown'),
              model: String(session.model?.id || 'unknown'),
              usage: normalizedUsage.usage,
            });
          }

          if (roleName === 'reverser' && !runCtx.finalized) {
            runCtx.compactionsSinceDeliverable += 1;
            const maxNoDelivCompactions = runCtx.budgetMaxNoDeliverableCompactions;
            if (maxNoDelivCompactions && maxNoDelivCompactions > 0) {
              if (runCtx.compactionsSinceDeliverable >= maxNoDelivCompactions) {
                const compactStopMsg = `Reverser 单轮已历经 ${runCtx.compactionsSinceDeliverable} 次上下文压缩仍未产出交付脚本或通过 vn_learn_skill（阈值 ${maxNoDelivCompactions} 次），已强制收尾并交回主 Agent 决断。`;
                snapshot.pivotWarnings.push(compactStopMsg);
                runCtx.budgetAbortReason = compactStopMsg;
                runCtx.budgetResumable = true;
                snapshot.interruptKind = 'aborted';
                try {
                  void session.abort?.();
                } catch {
                  // ignore
                }
              } else if (
                maxNoDelivCompactions >= 2 &&
                runCtx.compactionsSinceDeliverable === maxNoDelivCompactions - 1
              ) {
                const warnMsg = `[压缩熔断预警] 本轮已发生 ${runCtx.compactionsSinceDeliverable}/${maxNoDelivCompactions} 次上下文压缩仍未产出交付脚本（unpack/repack/extract/apply.py）或通过 vn_learn_skill；再发生 1 次无交付压缩将强制交回主 Agent。请立即停止重复试错，直接验证核心消费端并收敛交付！`;
                snapshot.pivotWarnings.push(warnMsg);
                runCtx.pendingCompactionWarning = warnMsg;
              }
            }
            if (
              !runCtx.budgetAbortReason &&
              runCtx.budgetMaxTokens &&
              runCtx.budgetMaxTokens > 0 &&
              usage.totalTokens >= runCtx.budgetMaxTokens
            ) {
              const tokenMsg = `Reverser 本轮累计 Token 已达上限（${usage.totalTokens} / ${runCtx.budgetMaxTokens}），已强制收尾并交回主 Agent 决断。`;
              snapshot.pivotWarnings.push(tokenMsg);
              runCtx.budgetAbortReason = tokenMsg;
              runCtx.budgetResumable = true;
              snapshot.interruptKind = 'aborted';
              try {
                void session.abort?.();
              } catch {
                // ignore
              }
            }
          }

          if (isInteractiveRole) {
            currentAssistantMsg = null;
            pendingDeltaMsgId = '';
            const curMsgs = snapshot.messages ?? [];
            if (!curMsgs.some((m) => m.id === summaryInfo.id)) {
              snapshot.messages = pushBoundedChatMessage(curMsgs, {
                id: summaryInfo.id,
                role: 'compaction',
                content: summaryInfo.summary,
                timestamp: summaryInfo.timestamp || nowIso,
                turnTaskId: taskId,
                compaction: {
                  reason: summaryInfo.reason,
                  tokensBefore: summaryInfo.tokensBefore,
                  tokensAfter: summaryInfo.tokensAfter,
                  ...(summaryInfo.focus ? { focus: summaryInfo.focus } : {}),
                  ...(summaryInfo.checkpointPath ? { checkpointPath: summaryInfo.checkpointPath } : {}),
                },
              });
            }
          }

          if (runCtx.recordDiagnostics) {
            appendTaskEventToDisk(options.cwd, {
              timestamp: nowIso,
              taskId,
              sessionId: snapshot.sessionId,
              role: roleName,
              type: 'compaction_end',
              stage: snapshot.stage,
              activityState: snapshot.activityState,
              status: 'compacted',
            });
          }
        } else if (runCtx.recordDiagnostics) {
          const errText = typeof event.errorMessage === 'string' ? event.errorMessage : undefined;
          const isCancelledOrAborted =
            Boolean(event.aborted) || Boolean(errText && /compaction cancelled/i.test(errText));
          const status = isCancelledOrAborted ? 'aborted' : isCompactionNoopError(errText) ? 'noop' : 'error';
          appendTaskEventToDisk(options.cwd, {
            timestamp: nowIso,
            taskId,
            sessionId: snapshot.sessionId,
            role: roleName,
            type: 'compaction_end',
            stage: snapshot.stage,
            activityState: snapshot.activityState,
            status,
            ...(status === 'error' && errText ? { error: redactSecrets(errText, options.getKnownSecrets?.()) } : {}),
          });
        }

        if (!runCtx.finalized) {
          this.emitAndPersistSnapshot(runCtx, true);
        }
      } else if (event.type === 'agent_end') {
        if (!runCtx.finalized && lastStopReason === 'error' && event.willRetry === false) {
          const hadPending =
            queueController.hasPending() ||
            ((session.getSteeringMessages?.().length ?? 0) + (session.getFollowUpMessages?.().length ?? 0)) > 0;
          if (hadPending && !runCtx.pendingRestoredDraft) {
            runCtx.pendingRestoredDraft = queueController.clearForRestore(session);
            emitSubagentQueueUpdate();
          }
        }
      }
    });

    try {
      if (typeof session.setAutoRetryEnabled === 'function') {
        session.setAutoRetryEnabled(true);
      }
      applyPaperCupQueueModes(undefined, session);
      try {
        session.clearQueue?.();
      } catch {
        // Ignore pre-run queue cleanup error
      }
      await session.prompt(
        task,
        initialImages.length > 0 ? { images: toPiImageContents(initialImages) } : undefined
      );

      // Bounded single-shot overflow recovery for Chinese / custom-gateway overflow messages
      // that Pi SDK's built-in isContextOverflow did not recognize.
      if (
        isInteractiveRole &&
        !options.signal?.aborted &&
        !runCtx.finalized &&
        lastStopReason === 'error' &&
        lastErrorMessage &&
        isPaperCupContextOverflow(lastErrorMessage) &&
        !subagentOverflowCompactionAttempted
      ) {
        subagentOverflowCompactionAttempted = true;
        const branchEntries: any[] = session?.sessionManager?.getBranch?.() ?? [];
        let failedAssistantEntryId: string | null = null;
        for (let i = branchEntries.length - 1; i >= 0; i -= 1) {
          const ent = branchEntries[i];
          if (ent?.type === 'message' && ent.message?.role === 'assistant' && ent.message?.stopReason === 'error') {
            failedAssistantEntryId = ent.id;
            break;
          }
        }
        if (failedAssistantEntryId && typeof session?.sessionManager?.appendContextEdit === 'function') {
          try {
            session.sessionManager.appendContextEdit(failedAssistantEntryId, null);
            session.refreshContext?.();
          } catch {
            // Best-effort omission before overflow compaction
          }
        }
        let recoveredViaCompact = false;
        pendingSubagentCompactReasonOverride = 'overflow';
        try {
          await session.compact();
          recoveredViaCompact = true;
        } catch {
          // If compaction itself cannot run (e.g. session too small or model error), keep original error.
        } finally {
          pendingSubagentCompactReasonOverride = undefined;
        }
        if (recoveredViaCompact && !options.signal?.aborted && !runCtx.finalized) {
          lastStopReason = undefined;
          lastErrorMessage = undefined;
          const curMsgs: any[] = session?.messages ?? session?.agent?.state?.messages ?? [];
          const tailMsg = curMsgs[curMsgs.length - 1];
          if (typeof session?.agent?.continue === 'function' && tailMsg?.role !== 'assistant') {
            await session.agent.continue();
          } else {
            await session.prompt('请基于上述压缩后的上下文继续完成刚才未完成的任务。');
          }
        }
      }

      const trimmed = redactSecrets(responseText.trim(), options.getKnownSecrets?.());
      if (isInteractiveRole) {
        snapshot.responsePreview = clipTailText(trimmed, MAX_RESPONSE_PREVIEW_CHARS);
      }

      if (options.signal?.aborted || lastStopReason === 'aborted' || (runCtx.finalized && snapshot.status === 'aborted')) {
        const abortMsg = redactSecrets(
          resolveAbortReason(options.signal, runCtx.budgetAbortReason, snapshot.error, lastErrorMessage),
          options.getKnownSecrets?.()
        );
        runCtx.finalize('aborted', 'aborted', abortMsg);
        const abortKind = snapshot.interruptKind ?? classifySubagentError(abortMsg, true).kind;
        const abortedMetrics = buildMetrics(
          'aborted',
          lastStopReason ?? 'aborted',
          trimmed.length,
          observedModelKey,
          abortMsg,
          abortKind
        );
        if (options.recordDiagnostics) {
          appendSubagentDiagnostic(options.cwd, abortedMetrics);
        }
        const err: any = new Error(abortMsg);
        err.metrics = abortedMetrics;
        err.taskId = taskId;
        err.interruptKind = abortKind;
        err.budgetResumable = Boolean(runCtx.budgetResumable && !options.signal?.aborted);
        err.deliveredSkillOrScript = runCtx.deliveredSkillOrScript;
        err.snapshot = cloneTaskSnapshot(snapshot);
        if (runCtx.userSteeredNotes.length > 0) {
          err.userSteeredNotes = [...runCtx.userSteeredNotes];
        }
        throw err;
      }

      if (lastStopReason === 'error') {
        const errText = lastErrorMessage || 'Subagent model request failed.';
        runCtx.finalize('error', 'error', errText);
        const errKind = snapshot.interruptKind ?? classifySubagentError(errText, false).kind;
        const errMetrics = buildMetrics('error', 'error', trimmed.length, observedModelKey, errText, errKind);
        if (options.recordDiagnostics) {
          appendSubagentDiagnostic(options.cwd, errMetrics);
        }
        const err: any = new Error(errText);
        err.metrics = errMetrics;
        err.taskId = taskId;
        err.interruptKind = errKind;
        err.deliveredSkillOrScript = runCtx.deliveredSkillOrScript;
        err.snapshot = cloneTaskSnapshot(snapshot);
        if (runCtx.userSteeredNotes.length > 0) {
          err.userSteeredNotes = [...runCtx.userSteeredNotes];
        }
        throw err;
      }

      const hasTools = (profile.allowedTools ?? []).length > 0;
      if (!hasTools) {
        const invalidReason = detectInvalidToollessOutput(roleName, trimmed);
        if (invalidReason) {
          runCtx.finalize('error', 'error', invalidReason);
          const errKind = snapshot.interruptKind ?? classifySubagentError(invalidReason, false).kind;
          const errMetrics = buildMetrics(
            'error',
            lastStopReason ?? 'stop',
            trimmed.length,
            observedModelKey,
            invalidReason,
            errKind
          );
          if (options.recordDiagnostics) {
            appendSubagentDiagnostic(options.cwd, errMetrics);
          }
          const err: any = new Error(invalidReason);
          err.metrics = errMetrics;
          err.taskId = taskId;
          err.interruptKind = errKind;
          err.deliveredSkillOrScript = runCtx.deliveredSkillOrScript;
          err.snapshot = cloneTaskSnapshot(snapshot);
          if (runCtx.userSteeredNotes.length > 0) {
            err.userSteeredNotes = [...runCtx.userSteeredNotes];
          }
          throw err;
        }
      }

      if (roleName === 'role-checker' && !snapshot.lastProgressAt) {
        const nowIso = new Date().toISOString();
        snapshot.lastProgressAt = nowIso;
        snapshot.lastProgressSummary = '完成译文语义复核';
      }

      // Execute any queued post-turn /compact before finalizing completed state
      if (isInteractiveRole && runCtx.queuedCompaction && !options.signal?.aborted && !runCtx.finalized) {
        const queued = runCtx.queuedCompaction;
        runCtx.queuedCompaction = null;
        snapshot.queuedCompaction = null;
        this.emitAndPersistSnapshot(runCtx, false);
        pendingSubagentCompactFocus = queued.focus;
        try {
          await session.compact(queued.focus);
        } catch {
          // Non-fatal: noop or failed post-turn compaction should not fail an already completed turn
        } finally {
          pendingSubagentCompactFocus = undefined;
        }
      }

      runCtx.finalize('completed', 'completed');
      const successMetrics = buildMetrics(
        'success',
        lastStopReason ?? 'stop',
        trimmed.length,
        observedModelKey
      );
      if (options.recordDiagnostics) {
        appendSubagentDiagnostic(options.cwd, successMetrics);
      }
      return {
        taskId,
        text: trimmed,
        metrics: successMetrics,
        snapshot: cloneTaskSnapshot(snapshot),
        deliveredSkillOrScript: runCtx.deliveredSkillOrScript,
        ...(runCtx.userSteeredNotes.length > 0 ? { userSteeredNotes: [...runCtx.userSteeredNotes] } : {}),
      };
    } catch (error: any) {
      if (!error?.metrics) {
        const isAborted =
          Boolean(options.signal?.aborted) ||
          snapshot.status === 'aborted' ||
          String(error?.message || '').toLowerCase().includes('aborted');
        const msg = isAborted
          ? resolveAbortReason(options.signal, runCtx.budgetAbortReason, snapshot.error, error?.message, lastErrorMessage)
          : error?.message || String(error);
        runCtx.finalize(isAborted ? 'aborted' : 'error', isAborted ? 'aborted' : 'error', msg);
        const errKind = snapshot.interruptKind ?? classifySubagentError(msg, isAborted).kind;
        const errMetrics = buildMetrics(
          isAborted ? 'aborted' : 'error',
          lastStopReason ?? (isAborted ? 'aborted' : 'error'),
          responseText.trim().length,
          observedModelKey,
          msg,
          errKind
        );
        if (options.recordDiagnostics) {
          appendSubagentDiagnostic(options.cwd, errMetrics);
        }
        error.metrics = errMetrics;
        error.taskId = taskId;
        error.interruptKind = errKind;
        error.budgetResumable = Boolean(isAborted && runCtx.budgetResumable && !options.signal?.aborted);
        error.deliveredSkillOrScript = runCtx.deliveredSkillOrScript;
        error.snapshot = cloneTaskSnapshot(snapshot);
        if (runCtx.userSteeredNotes.length > 0) {
          error.userSteeredNotes = [...runCtx.userSteeredNotes];
        }
      }
      throw error;
    } finally {
      flushStreamDeltas();
      try {
        session.clearQueue?.();
      } catch {
        // Ignore post-run queue cleanup error
      }
      queueController.reset();
      if (runCtx.budgetTimer) {
        clearTimeout(runCtx.budgetTimer);
        runCtx.budgetTimer = undefined;
      }
      if (trackerRef && trackerRef.current === runCtx) {
        trackerRef.current = null;
      }
      this.activeRuns.delete(taskId);
      options.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    }
  }

  async runSubagentWithMetrics(roleName: string, task: string, options: SubagentRunOptions): Promise<SubagentRunResult> {
    const profile = this.getProfile(roleName);
    if (!profile) {
      throw new Error(`Subagent role '${roleName}' not found. Available roles: ${Array.from(this.profiles.keys()).join(', ')}`);
    }

    const isInteractiveRole = roleName !== 'translator';
    const requestedResumeId = (options.resumeTaskId || '').trim();
    const resolvedTaskId = options.taskId || generateTaskId(roleName);
    const requestedModelKey =
      options.model?.provider && options.model?.id
        ? `${options.model.provider}/${options.model.id}`
        : null;

    let priorSnap =
      isInteractiveRole && requestedResumeId ? this.getTask(options.cwd, requestedResumeId) : null;
    if (priorSnap && priorSnap.role !== roleName) {
      priorSnap = null;
    }

    let resumedEntry: ResumableSubagentEntry | null = null;
    if (isInteractiveRole && requestedResumeId) {
      resumedEntry = this.takeResumableSession(requestedResumeId, roleName, options.cwd, requestedModelKey);
      if (resumedEntry) {
        try {
          await resumedEntry.managed.waitForIdle?.();
        } catch {
          // Ignore waitForIdle failure before checking session history balance
        }
        if (resumedEntry.managed.canResume && !resumedEntry.managed.canResume()) {
          try {
            resumedEntry.managed.dispose();
          } catch {
            // Ignore disposal error
          }
          resumedEntry = null;
        }
      }
    }

    const resumed = Boolean(resumedEntry);
    const resumeFallback = Boolean(isInteractiveRole && requestedResumeId && !resumedEntry);
    const managed = resumedEntry ? resumedEntry.managed : await this.createManagedSubagentSession(roleName, options);
    const nextResumeCount = resumedEntry ? resumedEntry.resumeCount + 1 : 0;
    const threadId = priorSnap?.threadId || priorSnap?.taskId || resumedEntry?.taskId || resolvedTaskId;
    const priorMessages = priorSnap
      ? priorSnap.messages && priorSnap.messages.length > 0
        ? priorSnap.messages
        : buildLegacyFallbackMessages(priorSnap)
      : undefined;
    const effectiveTask = resumeFallback
      ? `${buildCompactResumeContextNote(requestedResumeId, priorSnap)}\n\n${task}`
      : task;

    try {
      const result = await managed.prompt(effectiveTask, {
        onDelta: options.onDelta,
        signal: options.signal,
        sessionId: options.sessionId,
        parentCallId: options.parentCallId,
        taskId: resolvedTaskId,
        threadId,
        ...(requestedResumeId
          ? { resumedFromTaskId: resumedEntry?.taskId || priorSnap?.taskId || requestedResumeId }
          : {}),
        ...(priorMessages && priorMessages.length > 0 ? { priorMessages } : {}),
        ...(typeof priorSnap?.compactionCount === 'number' && priorSnap.compactionCount > 0
          ? { priorCompactionCount: priorSnap.compactionCount }
          : {}),
        origin: options.origin,
        ...(Array.isArray(options.images) && options.images.length > 0 ? { images: options.images } : {}),
        displayTaskPrompt: task,
        recordDiagnostics: options.recordDiagnostics,
        onTaskUpdated: options.onTaskUpdated,
        onStreamDelta: options.onStreamDelta,
        usageKind: options.usageKind,
        onUsage: options.onUsage,
      });

      const isReverser = roleName === 'reverser';
      const deliveredThisRun = Boolean(result.deliveredSkillOrScript);
      const priorNoDeliverable = isReverser ? (resumedEntry?.noDeliverableRounds ?? 0) : 0;
      const nextNoDeliverableRounds = isReverser ? (deliveredThisRun ? 0 : priorNoDeliverable + 1) : 0;
      const hitNoDeliverableLimit = isReverser && nextNoDeliverableRounds >= MAX_REVERSER_NO_DELIVERABLE_ROUNDS;
      const hitResumeLimit = nextResumeCount >= MAX_RESUMES_PER_TASK;

      const canSaveForResume =
        isInteractiveRole &&
        !options.signal?.aborted &&
        !hitResumeLimit &&
        !hitNoDeliverableLimit &&
        (managed.canResume?.() ?? true);
      if (canSaveForResume) {
        this.storeResumableSession(result.taskId, {
          taskId: result.taskId,
          role: roleName,
          cwd: options.cwd,
          cwdKey: normalizeWorkspaceKey(options.cwd),
          modelKey: result.snapshot.model || managed.model || requestedModelKey,
          managed,
          resumeCount: nextResumeCount,
          noDeliverableRounds: nextNoDeliverableRounds,
          createdAtMs: Date.now(),
        });
      } else {
        managed.dispose();
      }

      const gatekeeperNotice = isReverser
        ? buildReverserGatekeeperNotice(
            canSaveForResume,
            nextNoDeliverableRounds,
            nextResumeCount,
            hitNoDeliverableLimit,
            hitResumeLimit,
            Boolean(options.signal?.aborted)
          )
        : undefined;

      return {
        ...result,
        resumed,
        ...(resumed && resumedEntry ? { resumedFromTaskId: resumedEntry.taskId } : {}),
        resumeFallback,
        resumable: canSaveForResume,
        ...(isReverser ? { noDeliverableRounds: nextNoDeliverableRounds } : {}),
        ...(gatekeeperNotice ? { gatekeeperNotice } : {}),
      };
    } catch (error: any) {
      const resolvedId = String(error?.taskId || resolvedTaskId);
      const interruptKind = error?.interruptKind ?? error?.metrics?.interruptKind;
      const isReverser = roleName === 'reverser';
      const deliveredThisRun = Boolean(error?.deliveredSkillOrScript);
      const priorNoDeliverable = isReverser ? (resumedEntry?.noDeliverableRounds ?? 0) : 0;
      const nextNoDeliverableRounds = isReverser ? (deliveredThisRun ? 0 : priorNoDeliverable + 1) : 0;
      const hitNoDeliverableLimit = isReverser && nextNoDeliverableRounds >= MAX_REVERSER_NO_DELIVERABLE_ROUNDS;
      const hitResumeLimit = nextResumeCount >= MAX_RESUMES_PER_TASK;

      const canSaveOnAbort =
        isInteractiveRole &&
        Boolean(resolvedId) &&
        error?.budgetResumable === true &&
        !options.signal?.aborted &&
        interruptKind !== 'quota_exhausted' &&
        interruptKind !== 'auth_error' &&
        !hitResumeLimit &&
        !hitNoDeliverableLimit;

      let savedForResume = false;
      if (canSaveOnAbort) {
        try {
          await managed.waitForIdle?.();
        } catch {
          // Ignore waitForIdle failure before checking session history balance
        }
        if (managed.canResume?.() ?? true) {
          this.storeResumableSession(resolvedId, {
            taskId: resolvedId,
            role: roleName,
            cwd: options.cwd,
            cwdKey: normalizeWorkspaceKey(options.cwd),
            modelKey: error?.snapshot?.model || managed.model || requestedModelKey,
            managed,
            resumeCount: nextResumeCount,
            noDeliverableRounds: nextNoDeliverableRounds,
            createdAtMs: Date.now(),
          });
          savedForResume = true;
        }
      }
      if (!savedForResume) {
        try {
          managed.dispose();
        } catch {
          // Ignore disposal error
        }
      }
      const gatekeeperNotice = isReverser
        ? buildReverserGatekeeperNotice(
            savedForResume,
            nextNoDeliverableRounds,
            nextResumeCount,
            hitNoDeliverableLimit,
            hitResumeLimit,
            Boolean(options.signal?.aborted) ||
              interruptKind === 'quota_exhausted' ||
              interruptKind === 'auth_error'
          )
        : undefined;
      if (error && typeof error === 'object') {
        error.resumable = savedForResume;
        error.resumed = resumed;
        error.resumeFallback = resumeFallback;
        if (isReverser) {
          error.noDeliverableRounds = nextNoDeliverableRounds;
        }
        if (gatekeeperNotice) {
          error.gatekeeperNotice = gatekeeperNotice;
        }
        if (resumed && resumedEntry) {
          error.resumedFromTaskId = resumedEntry.taskId;
        }
      }
      throw error;
    }
  }

  async runSubagent(roleName: string, task: string, options: SubagentRunOptions): Promise<string> {
    const result = await this.runSubagentWithMetrics(roleName, task, options);
    return result.text;
  }

  createTools(
    cwdProvider: () => string,
    onSubagentActivity?: (role: string, delta: string, callId?: string) => void,
    modelProvider?: () => any,
    customToolsProvider?: () => ToolDefinition[],
    modelRuntimeProvider?: () => any,
    options?: {
      turnAbortSignalProvider?: () => AbortSignal | undefined;
      getKnownSecrets?: () => Iterable<string>;
      sessionIdProvider?: () => string | null;
      recordDiagnosticsProvider?: () => boolean;
      onTaskUpdated?: SubagentTaskUpdatedListener;
      onUsage?: SubagentUsageListener;
    }
  ) {
    if (customToolsProvider) {
      this.customToolsProvider = customToolsProvider;
    }
    if (options?.onTaskUpdated) {
      this.defaultOnTaskUpdated = options.onTaskUpdated;
    }
    if (options?.onUsage) {
      this.defaultOnUsage = options.onUsage;
    }
    const delegateTaskTool = defineTool({
      name: 'delegate_task',
      label: 'Delegate Task to Subagent',
      description: `Delegate a scoped task to a specialized subagent (e.g., translator, role-checker, reverser).
The subagent runs in an isolated context and returns its final answer without polluting this conversation.`,
      parameters: Type.Object({
        role: Type.String({ description: 'Specialist role name: translator, role-checker, reverser, etc.' }),
        task: Type.String({ description: 'The task assignment including all required text or JSONL' }),
        resumeTaskId: Type.Optional(
          Type.String({
            description:
              'Optional prior resumable reverser taskId to continue in-place with its existing session context and KV cache.',
          })
        ),
      }),
      execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
        const combined = combineAbortSignals(signal, options?.turnAbortSignalProvider?.());
        const taskId = generateTaskId(params.role);
        try {
          const cwd = cwdProvider();
          const result = await this.runSubagentWithMetrics(params.role, params.task, {
            cwd,
            signal: combined.signal,
            model: modelProvider?.(),
            modelRuntime: modelRuntimeProvider?.(),
            getKnownSecrets: options?.getKnownSecrets,
            sessionId: options?.sessionIdProvider?.(),
            parentCallId: toolCallId,
            taskId,
            resumeTaskId: params.resumeTaskId,
            recordDiagnostics: options?.recordDiagnosticsProvider?.() ?? false,
            onDelta: (delta) => onSubagentActivity?.(params.role, delta, toolCallId),
            onTaskUpdated: options?.onTaskUpdated,
            onUsage: options?.onUsage,
          });
          const sessionNote =
            params.role === 'reverser' && result.resumable
              ? `\n[reverser_session taskId=${result.taskId} resumable=true (pass resumeTaskId="${result.taskId}" to continue in-place with warm cache)]`
              : '';
          const gatekeeperNote = params.role === 'reverser' && result.gatekeeperNotice ? result.gatekeeperNotice : '';
          const steerNote = formatUserSteeredSubagentNote(result.userSteeredNotes, options?.getKnownSecrets);
          return {
            content: [{ type: 'text', text: `${result.text}${steerNote}${sessionNote}${gatekeeperNote}` }],
            details: {
              taskId: result.taskId,
              role: params.role,
              status: 'success',
              metrics: result.metrics,
              artifacts: result.snapshot.artifacts,
              resumed: Boolean(result.resumed),
              resumable: Boolean(result.resumable),
              resumeFallback: Boolean(result.resumeFallback),
              ...(typeof result.noDeliverableRounds === 'number'
                ? { noDeliverableRounds: result.noDeliverableRounds }
                : {}),
              ...(result.resumable ? { resumeTaskId: result.taskId } : {}),
              ...(result.resumedFromTaskId ? { resumedFromTaskId: result.resumedFromTaskId } : {}),
              ...(result.userSteeredNotes && result.userSteeredNotes.length > 0
                ? {
                    userSteerCount: result.userSteeredNotes.length,
                    userSteeredNotes: result.userSteeredNotes,
                  }
                : {}),
            },
          };
        } catch (error: any) {
          const safeMsg = redactSecrets(String(error?.message || error), options?.getKnownSecrets?.());
          const status: 'aborted' | 'error' = error?.metrics?.status === 'aborted' ? 'aborted' : 'error';
          const interruptKind: SubagentInterruptKind =
            error?.interruptKind ??
            error?.metrics?.interruptKind ??
            classifySubagentError(safeMsg, status === 'aborted').kind;
          const resolvedTaskId = String(error?.taskId || taskId);
          const snap = error?.snapshot as SubagentTaskSnapshot | undefined;
          const latestCheckpoint = findLatestCompactionCheckpointPath(snap);
          const isResumable = Boolean(error?.resumable);
          const errSteeredNotes = Array.isArray(error?.userSteeredNotes)
            ? (error.userSteeredNotes as SubagentUserSteerNote[])
            : undefined;
          const steerNote = formatUserSteeredSubagentNote(errSteeredNotes, options?.getKnownSecrets);
          const gatekeeperNote =
            params.role === 'reverser' && typeof error?.gatekeeperNotice === 'string'
              ? error.gatekeeperNotice
              : '';
          const text = `${formatSubagentFailureText(
            params.role,
            status,
            interruptKind,
            safeMsg,
            resolvedTaskId,
            snap,
            isResumable
          )}${steerNote}${gatekeeperNote}`;
          return {
            content: [{ type: 'text', text }],
            details: {
              taskId: resolvedTaskId,
              role: params.role,
              status,
              interruptKind,
              error: safeMsg,
              resumed: Boolean(error?.resumed),
              resumable: isResumable,
              resumeFallback: Boolean(error?.resumeFallback),
              ...(typeof error?.noDeliverableRounds === 'number'
                ? { noDeliverableRounds: error.noDeliverableRounds }
                : {}),
              ...(isResumable ? { resumeTaskId: resolvedTaskId } : {}),
              ...(error?.resumedFromTaskId ? { resumedFromTaskId: error.resumedFromTaskId } : {}),
              ...(snap?.stage ? { stage: snap.stage } : {}),
              ...(snap?.lastProgressSummary ? { lastProgressSummary: snap.lastProgressSummary } : {}),
              ...(error?.metrics ? { metrics: error.metrics } : {}),
              ...(snap?.artifacts ? { artifacts: snap.artifacts } : {}),
              ...(latestCheckpoint ? { compactionCheckpoint: latestCheckpoint } : {}),
              ...(errSteeredNotes && errSteeredNotes.length > 0
                ? {
                    userSteerCount: errSteeredNotes.length,
                    userSteeredNotes: errSteeredNotes,
                  }
                : {}),
            },
            isError: true,
          };
        } finally {
          combined.cleanup();
        }
      },
    });

    const createSubagentTool = defineTool({
      name: 'create_subagent',
      label: 'Create Dynamic Subagent',
      description: 'Create a new specialized subagent role for this session that can subsequently be called via delegate_task.',
      parameters: Type.Object({
        name: Type.String({ description: 'Unique role name (e.g. proofreader)' }),
        description: Type.String({ description: 'Short description of what this role does' }),
        instructions: Type.String({ description: 'System prompt instructions for this role' }),
        allowedTools: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Optional tool allowlist for this role (e.g. ["read", "bash"]); defaults to no tools.',
          })
        ),
        thinkingLevel: Type.Optional(
          Type.Union([
            Type.Literal('off'),
            Type.Literal('minimal'),
            Type.Literal('low'),
            Type.Literal('medium'),
            Type.Literal('high'),
            Type.Literal('xhigh'),
            Type.Literal('max'),
          ], { description: 'Optional default thinking level for this role' })
        ),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        const validated = validateDynamicSubagentInput(params.name, params.allowedTools);
        if (!validated.ok) {
          return {
            content: [{ type: 'text', text: validated.error }],
            details: { rejected: true, name: params.name, error: validated.error },
            isError: true,
          };
        }
        this.registerProfile({
          name: validated.name,
          description: params.description,
          systemPrompt: params.instructions,
          allowedTools: validated.allowedTools,
          ...(params.thinkingLevel ? { defaultThinkingLevel: params.thinkingLevel } : {}),
        });
        return {
          content: [{ type: 'text', text: `Created subagent role '${validated.name}'. You can now delegate work to it with delegate_task.` }],
          details: { name: validated.name, allowedTools: validated.allowedTools },
        };
      },
    });

    return [delegateTaskTool, createSubagentTool];
  }
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): { signal?: AbortSignal; cleanup: () => void } {
  if (!a && !b) return { signal: undefined, cleanup: () => {} };
  if (a && !b) return { signal: a, cleanup: () => {} };
  if (!a && b) return { signal: b, cleanup: () => {} };
  const controller = new AbortController();
  const forward = (src: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort((src as any).reason);
    }
  };
  if (a!.aborted) {
    forward(a!);
    return { signal: controller.signal, cleanup: () => {} };
  }
  if (b!.aborted) {
    forward(b!);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onA = () => forward(a!);
  const onB = () => forward(b!);
  a!.addEventListener('abort', onA, { once: true });
  b!.addEventListener('abort', onB, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      a!.removeEventListener('abort', onA);
      b!.removeEventListener('abort', onB);
    },
  };
}
