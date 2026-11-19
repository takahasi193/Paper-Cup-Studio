import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { BUILTIN_SUBAGENTS, SubagentProfile } from './roles.js';
import { config } from '../config.js';
import {
  createGuardedBuiltinToolDefinitions,
  readVnResearchConfig,
} from '../security/guarded-tools.js';
import { redactSecrets, redactUnknownValue } from '../security/secrets.js';

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

export function classifySubagentError(
  message: string,
  isAborted = false
): { kind: SubagentInterruptKind; fatalForPool: boolean } {
  const raw = String(message || '').trim();
  const lower = raw.toLowerCase();
  if (
    /insufficient[\s_-]*(?:balance|quota)|setlimitexceeded|exceeded your current quota|quota[\s_-]*exceeded|credit[\s_-]*balance|billing|\b402\b/i.test(
      lower
    )
  ) {
    return { kind: 'quota_exhausted', fatalForPool: true };
  }
  if (
    /\b(401|403)\b|unauthorized|invalid[\s_-]*api[\s_-]*key|authentication failed|permission denied/i.test(
      lower
    )
  ) {
    return { kind: 'auth_error', fatalForPool: true };
  }
  if (isAborted || /\b(?:subagent execution aborted|request aborted|operation was aborted|abort(?:ed)?)\b/i.test(lower)) {
    return { kind: 'aborted', fatalForPool: true };
  }
  if (/rate[\s_-]*limit|too many requests|\b429\b/i.test(lower)) {
    return { kind: 'rate_limited', fatalForPool: false };
  }
  if (/inappropriate content|content moderation|content_filter|data_inspection_failed/i.test(lower)) {
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
      return /\babort|中止/i.test(trimmed) ? trimmed : `Subagent execution aborted: ${trimmed}`;
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
}

export type SubagentTaskUpdatedListener = (
  summary: SubagentTaskSummary,
  snapshot: SubagentTaskSnapshot
) => void;

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
  recordDiagnostics?: boolean;
  onTaskUpdated?: SubagentTaskUpdatedListener;
}

export interface SubagentRunResult {
  taskId: string;
  text: string;
  metrics: SubagentRunMetrics;
  snapshot: SubagentTaskSnapshot;
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
      recordDiagnostics?: boolean;
      onTaskUpdated?: SubagentTaskUpdatedListener;
    }
  ) => Promise<SubagentRunResult>;
  dispose: () => void;
}

interface ToolOutcomeMeta {
  isError: boolean;
  resultSummary?: string;
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
  lastPersistAtMs: number;
  finalized: boolean;
  finalize: (status: SubagentTaskStatus, activityState: SubagentActivityState, errorMsg?: string) => void;
}

const TOOL_CALL_MARKUP_RE = /<tool_call\b|<\/tool_call>|<function\s*=|<\/function>|<invoke\b/i;
const MAX_TASK_PROMPT_CHARS = 4000;
const MAX_RESPONSE_PREVIEW_CHARS = 12000;
const MAX_RESULT_SUMMARY_CHARS = 800;
const MAX_ARGS_STRING_CHARS = 1200;
const DELTA_PERSIST_INTERVAL_MS = 800;
const MAX_MEMORY_TASKS_PER_CWD = 120;

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

function inferSubagentStage(roleName: string, toolName?: string, args?: unknown): string {
  if (roleName === 'translator') return 'translate';
  if (roleName === 'role-checker') return 'review';
  if (!toolName) return 'starting';
  if (toolName === 'vn_detect') return 'detect';
  if (toolName === 'vn_learn_skill') return 'verify_skill';
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

export function toSubagentTaskSummary(snapshot: SubagentTaskSnapshot): SubagentTaskSummary {
  const errorCount = snapshot.toolCalls.filter((t) => t.status === 'error' || t.isError).length;
  return {
    taskId: snapshot.taskId,
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
    taskSummary: clipText(snapshot.taskPrompt.replace(/\s+/g, ' ').trim(), 160),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

function formatSubagentFailureText(
  roleName: string,
  status: 'error' | 'aborted',
  interruptKind: SubagentInterruptKind,
  safeMsg: string,
  taskId: string,
  snapshot?: SubagentTaskSnapshot
): string {
  const header = `Subagent ${roleName} ${status === 'aborted' ? 'aborted' : 'failed'}: ${safeMsg}`;
  if (!snapshot) return header;
  const metaParts = [
    `taskId=${taskId}`,
    `status=${status}`,
    `kind=${interruptKind}`,
    `stage=${snapshot.stage}`,
    `toolCalls=${snapshot.toolCalls.length}`,
    `durationMs=${snapshot.durationMs}`,
  ];
  const lines = [header, '[subagent_interruption_summary]', metaParts.join(' ')];
  if (snapshot.lastProgressSummary) {
    lines.push(`progress=${clipText(snapshot.lastProgressSummary, 240)}`);
  }
  if (snapshot.artifacts.length > 0) {
    lines.push(`artifacts=${snapshot.artifacts.slice(0, 10).join(', ')}`);
  }
  if (roleName !== 'translator' && snapshot.responsePreview) {
    lines.push(`responseTail=${clipTailText(snapshot.responsePreview.replace(/\s+/g, ' ').trim(), 240)}`);
  }
  lines.push(
    'next=Report this interruption upward; when resuming, continue directly from persisted progress/artifacts rather than manually re-probing or replacing this subagent.'
  );
  lines.push('[/subagent_interruption_summary]');
  return lines.join('\n');
}

export function detectInvalidToollessOutput(roleName: string, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return `Subagent '${roleName}' returned an empty response.`;
  }
  if (TOOL_CALL_MARKUP_RE.test(trimmed)) {
    return `Subagent '${roleName}' has no tools enabled (allowedTools=[]) and returned raw tool-call markup instead of text. Pass the complete source text or JSONL inline in delegate_task.task instead of file paths.`;
  }
  return null;
}

function appendSubagentDiagnostic(cwd: string, metrics: SubagentRunMetrics): void {
  try {
    if (!cwd || !fs.existsSync(cwd)) return;
    const diagDir = path.join(cwd, '.papercup', 'diagnostics');
    fs.mkdirSync(diagDir, { recursive: true });
    const logPath = path.join(diagDir, 'subagents.jsonl');
    fs.appendFileSync(logPath, `${JSON.stringify(metrics)}\n`, 'utf-8');
  } catch {
    // Diagnostics persistence must never break primary workflow execution
  }
}

function persistTaskSnapshotToDisk(cwd: string, snapshot: SubagentTaskSnapshot): void {
  try {
    if (!cwd || !fs.existsSync(cwd)) return;
    const tasksDir = path.join(cwd, '.papercup', 'diagnostics', 'subagent-tasks');
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
    const diagDir = path.join(cwd, '.papercup', 'diagnostics');
    fs.mkdirSync(diagDir, { recursive: true });
    fs.appendFileSync(path.join(diagDir, 'subagent-events.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8');
  } catch {
    // Ignore non-fatal event log errors
  }
}

function cloneTaskSnapshot(snapshot: SubagentTaskSnapshot): SubagentTaskSnapshot {
  return {
    ...snapshot,
    artifacts: [...snapshot.artifacts],
    pivotWarnings: [...snapshot.pivotWarnings],
    usage: { ...snapshot.usage },
    toolCalls: snapshot.toolCalls.map((t) => ({ ...t })),
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
  private sessionTrackerRefs = new WeakMap<object, { current: ActiveSubagentRunContext | null }>();
  private activeRuns = new Map<string, ActiveSubagentRunContext>();
  private memoryTasksByCwd = new Map<string, Map<string, SubagentTaskSnapshot>>();
  private diskTasksCacheByCwd = new Map<
    string,
    Map<string, { mtimeMs: number; size: number; snapshot: SubagentTaskSnapshot }>
  >();

  constructor() {
    for (const [name, profile] of Object.entries(BUILTIN_SUBAGENTS)) {
      this.profiles.set(name, profile);
    }
  }

  setCustomToolsProvider(provider: (() => ToolDefinition[]) | null): void {
    this.customToolsProvider = provider;
  }

  setOnTaskUpdated(listener: SubagentTaskUpdatedListener | null): void {
    this.defaultOnTaskUpdated = listener;
  }

  getProfile(name: string): SubagentProfile | undefined {
    return this.profiles.get(name);
  }

  registerProfile(profile: SubagentProfile): void {
    this.profiles.set(profile.name, profile);
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

  private wrapSubagentTool(
    cwd: string,
    def: ToolDefinition<any, any>,
    getRun: () => ActiveSubagentRunContext | null
  ): ToolDefinition<any, any> {
    return {
      ...def,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
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
            /Command exited with code [1-9]\d*|Traceback \(most recent call last\):/i.test(textOut));
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
              progressSummary = `写入 ${rel}`;
            }
          } else if (def.name === 'vn_learn_skill' && !rawRes?.details?.rejected) {
            const eng = String(paramObj.engine || rawRes?.details?.engine || 'custom').trim();
            producedArtifact = `.papercup/skills/engine-${eng}/`;
            progressSummary = `验证并封装引擎技能 engine-${eng}`;
          } else if (def.name === 'vn_detect' && /ready\s+skill\s+unpack/i.test(textOut)) {
            progressSummary = '确认引擎解包技能已就绪';
          }
        }

        let pivotNotice: string | null = null;
        if (run && !run.finalized) {
          const snap = run.snapshot;
          const nowIso = new Date().toISOString();
          snap.lastActivityAt = nowIso;

          if (producedArtifact) {
            if (!snap.artifacts.includes(producedArtifact)) {
              snap.artifacts.push(producedArtifact);
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

          if (isFailure) {
            snap.consecutiveHypothesisFailures += 1;
            if (snap.consecutiveHypothesisFailures >= snap.maxConsecutiveFailures) {
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
          } else if (
            def.name === 'bash' ||
            def.name === 'vn_learn_skill' ||
            ((def.name === 'write' || def.name === 'edit') &&
              producedArtifact &&
              /hypothes/i.test(producedArtifact) &&
              snap.pivotWarnings.length > 0)
          ) {
            snap.consecutiveHypothesisFailures = 0;
          }

          run.toolOutcomeByCallId.set(toolCallId, {
            isError: isFailure,
            resultSummary: clipText(textOut, MAX_RESULT_SUMMARY_CHARS),
            ...(savedOutputPath ? { savedOutputPath } : {}),
            ...(producedArtifact ? { producedArtifact } : {}),
          });
        }

        if (thrownError) {
          const baseMsg = redactSecrets(String(thrownError?.message || thrownError), secrets);
          throw new Error(pivotNotice ? `${baseMsg}\n\n${pivotNotice}` : baseMsg);
        }

        if (pivotNotice) {
          return appendPivotNoticeToResult(rawRes, pivotNotice);
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
      if (fs.existsSync(path.join(cwd, '.papercup', 'diagnostics', 'subagent-tasks', `${taskId}.json`))) {
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
      run.finalize('aborted', 'aborted', reason);
      try {
        void run.session?.abort?.();
      } catch {
        // Ignore underlying abort error
      }
    }
  }

  listTasks(cwd: string, sessionId?: string | null, options?: { limit?: number }): SubagentTaskSummary[] {
    const cwdKey = normalizeWorkspaceKey(cwd);
    const byId = new Map<string, SubagentTaskSnapshot>();
    const memMap = this.memoryTasksByCwd.get(cwdKey);
    if (memMap) {
      for (const snap of memMap.values()) {
        byId.set(snap.taskId, cloneTaskSnapshot(snap));
      }
    }

    const tasksDir = path.join(cwd, '.papercup', 'diagnostics', 'subagent-tasks');
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
            if (parsed.status === 'running' && !this.activeRuns.has(parsed.taskId)) {
              parsed.status = 'error';
              parsed.interruptKind = parsed.interruptKind || 'aborted';
              parsed.activityState = 'unknown';
              parsed.error = parsed.error || '服务已重启或连接中断，任务结束状态未知。';
              parsed.toolCalls = (parsed.toolCalls ?? []).map((t) =>
                t.status === 'running' ? { ...t, status: 'error' as const, isError: true } : t
              );
            }
            byId.set(parsed.taskId, parsed);
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
      return cloneTaskSnapshot(mem);
    }

    const filePath = path.join(cwd, '.papercup', 'diagnostics', 'subagent-tasks', `${cleanId}.json`);
    try {
      if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SubagentTaskSnapshot;
      if (parsed.status === 'running' && !this.activeRuns.has(parsed.taskId)) {
        parsed.status = 'error';
        parsed.interruptKind = parsed.interruptKind || 'aborted';
        parsed.activityState = 'unknown';
        parsed.error = parsed.error || '服务已重启或连接中断，任务结束状态未知。';
        parsed.toolCalls = (parsed.toolCalls ?? []).map((t) =>
          t.status === 'running' ? { ...t, status: 'error' as const, isError: true } : t
        );
      }
      return parsed;
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
    if (config.bashPath) {
      settingsManager.setShellPath(config.bashPath);
    }

    const skillPaths = (profile.skillPaths ?? []).filter((p) => fs.existsSync(p));
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.cwd,
      settingsManager,
      noExtensions: true,
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
    const guardedBuiltins =
      allowedTools.length > 0
        ? createGuardedBuiltinToolDefinitions(options.cwd, allowedTools, {
            bashPath: config.bashPath,
            getKnownSecrets: options.getKnownSecrets,
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

    const { session } = await createAgentSession({
      sessionManager,
      settingsManager,
      resourceLoader,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...toolConfig,
    });

    this.sessionTrackerRefs.set(session, trackerRef);

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
    const resolvedThinking = String(options.thinkingLevel ?? profile.defaultThinkingLevel ?? 'medium');
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
          recordDiagnostics: runOptions.recordDiagnostics,
          onTaskUpdated: runOptions.onTaskUpdated,
        }),
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
      recordDiagnostics?: boolean;
      onTaskUpdated?: SubagentTaskUpdatedListener;
    }
  ): Promise<SubagentRunResult> {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const taskId = options.taskId || generateTaskId(roleName);
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
    const safeTaskPrompt =
      roleName === 'translator'
        ? `[translator batch prompt: ${task.length} chars]`
        : clipText(redactSecrets(task, options.getKnownSecrets?.()), MAX_TASK_PROMPT_CHARS);

    const snapshot: SubagentTaskSnapshot = {
      taskId,
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
      taskSummary: clipText(safeTaskPrompt.replace(/\s+/g, ' ').trim(), 160),
      taskPrompt: safeTaskPrompt,
      maxConsecutiveFailures: researchConfig.maxConsecutiveFailures,
      artifacts: [],
      pivotWarnings: [],
      retryCount: 0,
      usage: { ...usage },
      toolCalls: [],
      responsePreview: '',
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

    const runCtx: ActiveSubagentRunContext = {
      cwd: options.cwd,
      session,
      snapshot,
      recordDiagnostics: Boolean(options.recordDiagnostics),
      getKnownSecrets: options.getKnownSecrets,
      onTaskUpdated: options.onTaskUpdated,
      toolOutcomeByCallId: new Map(),
      lastPersistAtMs: 0,
      finalized: false,
      finalize: (status, activityState, errorMsg) => {
        if (runCtx.finalized) return;
        runCtx.finalized = true;
        const nowIso = new Date().toISOString();
        snapshot.status = status;
        snapshot.activityState = activityState;
        snapshot.endedAt = nowIso;
        snapshot.lastActivityAt = nowIso;
        snapshot.durationMs = Math.max(0, Date.now() - startedAt);
        snapshot.usage = {
          ...usage,
          ...(hasReasoningTokens ? { reasoningTokens } : {}),
        };
        if (errorMsg) {
          snapshot.error = redactSecrets(errorMsg, options.getKnownSecrets?.());
        }
        if (status === 'error' || status === 'aborted') {
          snapshot.interruptKind = classifySubagentError(
            snapshot.error || errorMsg || '',
            status === 'aborted'
          ).kind;
        }
        for (const tc of snapshot.toolCalls) {
          if (tc.status === 'running') {
            tc.status = status === 'aborted' ? 'aborted' : 'error';
            tc.endedAt = nowIso;
            tc.isError = true;
          }
        }
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

    const onAbort = () => {
      const abortMsg = resolveAbortReason(options.signal, snapshot.error, lastErrorMessage);
      runCtx.finalize('aborted', 'aborted', abortMsg);
      void session.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        if (update && update.type === 'text_delta') {
          const safeDelta = redactSecrets(String(update.delta || ''), options.getKnownSecrets?.());
          responseText += safeDelta;
          options.onDelta?.(safeDelta);
          if (!runCtx.finalized) {
            snapshot.lastActivityAt = new Date().toISOString();
            snapshot.activityState = 'waiting_model';
            snapshot.durationMs = Math.max(0, Date.now() - startedAt);
            if (roleName !== 'translator') {
              snapshot.responsePreview = clipTailText(
                redactSecrets(responseText, options.getKnownSecrets?.()),
                MAX_RESPONSE_PREVIEW_CHARS
              );
            }
            this.emitAndPersistSnapshot(runCtx, false);
          }
        } else if (update && update.type === 'thinking_delta') {
          if (!runCtx.finalized) {
            snapshot.lastActivityAt = new Date().toISOString();
            snapshot.activityState = 'waiting_model';
            snapshot.durationMs = Math.max(0, Date.now() - startedAt);
            this.emitAndPersistSnapshot(runCtx, false);
          }
        }
      } else if (event.type === 'tool_execution_start') {
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
          snapshot.toolCalls.push({
            callId,
            tool: toolName,
            argsSummary: summarizeArgs(event.args, options.getKnownSecrets),
            args: boundUnknownArgs(event.args, options.getKnownSecrets),
            status: 'running',
            startedAt: nowIso,
          });
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
          if (matchingCall) {
            matchingCall.status = isErr ? 'error' : 'completed';
            matchingCall.endedAt = nowIso;
            matchingCall.durationMs = dur;
            matchingCall.isError = isErr;
            matchingCall.resultSummary =
              outcome?.resultSummary ?? clipText(extractResultText(event.result, options.getKnownSecrets), MAX_RESULT_SUMMARY_CHARS);
            const outPath = outcome?.savedOutputPath ?? event.result?.details?.savedOutputPath;
            if (typeof outPath === 'string' && outPath) {
              matchingCall.savedOutputPath = outPath;
            }
            if (outcome?.producedArtifact) {
              matchingCall.producedArtifact = outcome.producedArtifact;
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
        const msg = event.message;
        lastStopReason = msg.stopReason;
        lastErrorMessage = msg.errorMessage;
        if (msg.stopReason === 'error' && msg.errorMessage) {
          const cls = classifySubagentError(String(msg.errorMessage), false);
          if (cls.fatalForPool && typeof session.setAutoRetryEnabled === 'function') {
            session.setAutoRetryEnabled(false);
          }
        }
        if (msg.provider && msg.model) {
          observedModelKey = `${msg.provider}/${msg.model}`;
          snapshot.model = observedModelKey;
        }
        if (msg.usage && typeof msg.usage === 'object') {
          usage.input = addNumber(usage.input, msg.usage.input);
          usage.output = addNumber(usage.output, msg.usage.output);
          usage.cacheRead = addNumber(usage.cacheRead, msg.usage.cacheRead);
          usage.cacheWrite = addNumber(usage.cacheWrite, msg.usage.cacheWrite);
          usage.totalTokens = addNumber(usage.totalTokens, msg.usage.totalTokens);
          const rawReasoning = msg.usage.reasoning ?? msg.usage.reasoningTokens;
          if (typeof rawReasoning === 'number' && Number.isFinite(rawReasoning) && rawReasoning >= 0) {
            reasoningTokens += rawReasoning;
            hasReasoningTokens = true;
          }
          snapshot.usage = {
            ...usage,
            ...(hasReasoningTokens ? { reasoningTokens } : {}),
          };
        }
      }
    });

    try {
      if (typeof session.setAutoRetryEnabled === 'function') {
        session.setAutoRetryEnabled(true);
      }
      await session.prompt(task);
      const trimmed = redactSecrets(responseText.trim(), options.getKnownSecrets?.());
      if (roleName !== 'translator') {
        snapshot.responsePreview = clipTailText(trimmed, MAX_RESPONSE_PREVIEW_CHARS);
      }

      if (options.signal?.aborted || lastStopReason === 'aborted' || (runCtx.finalized && snapshot.status === 'aborted')) {
        const abortMsg = redactSecrets(
          resolveAbortReason(options.signal, snapshot.error, lastErrorMessage),
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
        err.snapshot = cloneTaskSnapshot(snapshot);
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
        err.snapshot = cloneTaskSnapshot(snapshot);
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
          err.snapshot = cloneTaskSnapshot(snapshot);
          throw err;
        }
      }

      if (roleName === 'role-checker' && !snapshot.lastProgressAt) {
        const nowIso = new Date().toISOString();
        snapshot.lastProgressAt = nowIso;
        snapshot.lastProgressSummary = '完成译文语义复核';
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
      return { taskId, text: trimmed, metrics: successMetrics, snapshot: cloneTaskSnapshot(snapshot) };
    } catch (error: any) {
      if (!error?.metrics) {
        const isAborted =
          Boolean(options.signal?.aborted) ||
          snapshot.status === 'aborted' ||
          String(error?.message || '').toLowerCase().includes('aborted');
        const msg = isAborted
          ? resolveAbortReason(options.signal, snapshot.error, error?.message, lastErrorMessage)
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
        error.snapshot = cloneTaskSnapshot(snapshot);
      }
      throw error;
    } finally {
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
    const managed = await this.createManagedSubagentSession(roleName, options);
    try {
      return await managed.prompt(task, {
        onDelta: options.onDelta,
        signal: options.signal,
        sessionId: options.sessionId,
        parentCallId: options.parentCallId,
        taskId: options.taskId,
        recordDiagnostics: options.recordDiagnostics,
        onTaskUpdated: options.onTaskUpdated,
      });
    } finally {
      managed.dispose();
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
    }
  ) {
    if (customToolsProvider) {
      this.customToolsProvider = customToolsProvider;
    }
    if (options?.onTaskUpdated) {
      this.defaultOnTaskUpdated = options.onTaskUpdated;
    }
    const delegateTaskTool = defineTool({
      name: 'delegate_task',
      label: 'Delegate Task to Subagent',
      description: `Delegate a scoped task to a specialized subagent (e.g., translator, role-checker, reverser).
The subagent runs in an isolated context and returns its final answer without polluting this conversation.`,
      parameters: Type.Object({
        role: Type.String({ description: 'Specialist role name: translator, role-checker, reverser, etc.' }),
        task: Type.String({ description: 'The task assignment including all required text or JSONL' }),
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
            recordDiagnostics: options?.recordDiagnosticsProvider?.() ?? false,
            onDelta: (delta) => onSubagentActivity?.(params.role, delta, toolCallId),
            onTaskUpdated: options?.onTaskUpdated,
          });
          return {
            content: [{ type: 'text', text: result.text }],
            details: {
              taskId: result.taskId,
              role: params.role,
              status: 'success',
              metrics: result.metrics,
              artifacts: result.snapshot.artifacts,
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
          const text = formatSubagentFailureText(
            params.role,
            status,
            interruptKind,
            safeMsg,
            resolvedTaskId,
            snap
          );
          return {
            content: [{ type: 'text', text }],
            details: {
              taskId: resolvedTaskId,
              role: params.role,
              status,
              interruptKind,
              error: safeMsg,
              ...(snap?.stage ? { stage: snap.stage } : {}),
              ...(snap?.lastProgressSummary ? { lastProgressSummary: snap.lastProgressSummary } : {}),
              ...(error?.metrics ? { metrics: error.metrics } : {}),
              ...(snap?.artifacts ? { artifacts: snap.artifacts } : {}),
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
          ], { description: 'Optional default thinking level for this role' })
        ),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        this.registerProfile({
          name: params.name,
          description: params.description,
          systemPrompt: params.instructions,
          allowedTools: params.allowedTools ?? [],
          ...(params.thinkingLevel ? { defaultThinkingLevel: params.thinkingLevel } : {}),
        });
        return {
          content: [{ type: 'text', text: `Created subagent role '${params.name}'. You can now delegate work to it with delegate_task.` }],
          details: { name: params.name },
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
  const abortNow = () => controller.abort();
  if (a!.aborted || b!.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }
  a!.addEventListener('abort', abortNow, { once: true });
  b!.addEventListener('abort', abortNow, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      a!.removeEventListener('abort', abortNow);
      b!.removeEventListener('abort', abortNow);
    },
  };
}
