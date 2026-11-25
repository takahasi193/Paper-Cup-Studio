/**
 * Paper Cup two-layer context compaction engine (L1 deterministic batch tool-result
 * pruning + L2 domain-customized LLM compaction + deterministic workspace anchor +
 * diagnostic checkpoint archiving).
 *
 * Zero external dependencies beyond Node stdlib and Pi SDK APIs.
 * All tuning knobs are environment-variable overrides (no `papercup.toml` sections).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { ImageContent, Model, TextContent, Usage } from '@earendil-works/pi-ai';
import {
  calculateContextTokens,
  compact,
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type ContextEditEntry,
  type ContextEditEntryDraft,
  type InlineExtension,
  type SessionEntry,
  type SessionProjection,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { redactSecrets } from '../security/secrets.js';
import { getVnStatus } from '../vn/core.js';
import {
  PAPERCUP_RESEARCH_REL,
  PAPERCUP_SKILLS_REL,
  WORKSPACE_COMPACTIONS_REL,
  resolveWorkspacePaths,
} from '../vn/workspace-paths.js';

export type CompactionRole = 'main' | 'reverser' | 'subagent';
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

export interface PaperCupCompactionConfig {
  enabled: boolean;
  mainSoftCapTokens: number;
  reverserSoftCapTokens: number;
  keepRecentTokens: number;
  pruneProtectTokens: number;
  pruneMinReclaimTokens: number;
  mainSoftCapExplicit?: boolean;
  reverserSoftCapExplicit?: boolean;
}

export const HUGE_WINDOW_THRESHOLD_TOKENS = 500_000;
export const DEFAULT_HUGE_MAIN_SOFT_CAP_TOKENS = 200_000;
export const DEFAULT_HUGE_REVERSER_SOFT_CAP_TOKENS = 180_000;

export const DEFAULT_PAPERCUP_COMPACTION_CONFIG: Readonly<PaperCupCompactionConfig> = Object.freeze({
  enabled: true,
  mainSoftCapTokens: 140_000,
  reverserSoftCapTokens: 120_000,
  keepRecentTokens: 20_000,
  pruneProtectTokens: 24_000,
  pruneMinReclaimTokens: 12_000,
});

export interface CompactionThresholds {
  contextWindow: number;
  softCapTokens: number;
  baseReserveTokens: number;
  triggerTokens: number;
  postPruneSkipTokens: number;
  effectiveReserveTokens: number;
  keepRecentTokens: number;
}

export interface ToolResultPruneOptions {
  pruneProtectTokens?: number;
  pruneMinReclaimTokens?: number;
  minCharsToPrune?: number;
  maxSnippetChars?: number;
  getKnownSecrets?: () => Iterable<string>;
}

export interface ToolResultPrunePlan {
  edits: ContextEditEntryDraft[];
  prunedCount: number;
  reclaimedTokens: number;
  reclaimedChars: number;
  eligibleCount: number;
  candidateReclaimedTokens: number;
}

export interface PaperCupPruneEvent {
  role: CompactionRole;
  prunedCount: number;
  reclaimedTokens: number;
  reclaimedChars: number;
  tokensBefore: number;
  tokensAfter: number;
  skippedL2: boolean;
}

export interface PaperCupCompactionExtensionOptions {
  role: CompactionRole;
  cwd: string;
  config?: PaperCupCompactionConfig;
  getKnownSecrets?: () => Iterable<string>;
  getModel?: () => Model<any> | undefined;
  getStreamFn?: () => StreamFn | undefined;
  onPruned?: (event: PaperCupPruneEvent) => void;
  onCheckpointArchived?: (checkpointPath: string, info: CompactionSummaryInfo) => void;
}

export interface CompactionEntryDetails {
  readFiles?: string[];
  modifiedFiles?: string[];
  role?: CompactionRole;
  reason?: CompactionReason;
  focus?: string;
  checkpointPath?: string;
  prunedCount?: number;
  tokensAfter?: number;
}

const DEFAULT_FALLBACK_CONTEXT_WINDOW = 131_072;
const DEFAULT_MIN_CHARS_TO_PRUNE = 1200;
const DEFAULT_MAX_SNIPPET_CHARS = 300;
const MAX_ARGS_HINT_CHARS = 120;
const MAIN_ANCHOR_MAX_CHARS = 1200;
const REVERSER_ANCHOR_MAX_CHARS = 1000;
const SUBAGENT_ANCHOR_MAX_CHARS = 800;

const DISABLED_ENV_VALUES = new Set(['0', 'false', 'off', 'no']);
const SLASH_COMPACT_RE = /^\/compact(?:\s+([\s\S]*))?$/i;

const NON_OVERFLOW_ERROR_RE =
  /\b(?:rate[\s_-]?limit|too\s+many\s+requests|requests?\s+per\s+(?:min|minute|sec|second|day)|tokens?\s+per\s+(?:min|minute|day)|tpm|rpm|insufficient[\s_-]?quota|quota[\s_-]?exceeded|exceeded\s+(?:your\s+)?(?:current\s+)?quota|billing|payment\s+required|credit\s+balance|unauthorized|forbidden|authentication|invalid[\s_-]?api[\s_-]?key|permission[\s_-]?denied|access[\s_-]?denied)\b|配额不足|余额不足|限流|频率超限|鉴权失败|认证失败|无权访问|密钥无效/i;

const NON_OVERFLOW_HTTP_STATUS_RE =
  /(?:(?:^|\b(?:http|status(?:[_\s-]?code)?|error|err|code)\s*[:=#(\[]?\s*)(?:401|402|403|429)(?!\s*(?:tokens?|chars?|bytes?|words?|k\b|m\b))\b|\[(?:401|402|403|429)\]|\((?:401|402|403|429)\))/i;

const PAPER_CUP_CONTEXT_OVERFLOW_RE =
  /上下文.*超|超出.*上下文|输入.*token.*超|token.*超限|prompt.*too\s*long|context.*length.*exceeded|context_length_exceeded|maximum\s+context\s+length|exceeds.*context\s*window|too\s+many\s+tokens|request\s+(?:entity\s+)?too\s+large|max_prompt_tokens|input\s+is\s+too\s+long/i;

function parseEnvPositiveIntWithFlag(
  raw: string | undefined,
  fallback: number,
  minValue = 1
): { value: number; explicit: boolean } {
  if (typeof raw !== 'string') return { value: fallback, explicit: false };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { value: fallback, explicit: false };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minValue) {
    return { value: fallback, explicit: false };
  }
  return { value: parsed, explicit: true };
}

function parseEnvPositiveInt(
  raw: string | undefined,
  fallback: number,
  minValue = 1
): number {
  return parseEnvPositiveIntWithFlag(raw, fallback, minValue).value;
}

/**
 * Read Paper Cup compaction settings exclusively from environment variables.
 */
export function readPaperCupCompactionConfig(
  env: NodeJS.ProcessEnv = process.env
): PaperCupCompactionConfig {
  const rawEnabled = env.PAPERCUP_COMPACT_ENABLED?.trim().toLowerCase();
  const enabled = rawEnabled ? !DISABLED_ENV_VALUES.has(rawEnabled) : DEFAULT_PAPERCUP_COMPACTION_CONFIG.enabled;

  const mainSoftCap = parseEnvPositiveIntWithFlag(
    env.PAPERCUP_MAIN_COMPACT_TOKENS,
    DEFAULT_PAPERCUP_COMPACTION_CONFIG.mainSoftCapTokens,
    4096
  );
  const reverserSoftCap = parseEnvPositiveIntWithFlag(
    env.PAPERCUP_REVERSER_COMPACT_TOKENS,
    DEFAULT_PAPERCUP_COMPACTION_CONFIG.reverserSoftCapTokens,
    4096
  );

  return {
    enabled,
    mainSoftCapTokens: mainSoftCap.value,
    reverserSoftCapTokens: reverserSoftCap.value,
    keepRecentTokens: parseEnvPositiveInt(
      env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS,
      DEFAULT_PAPERCUP_COMPACTION_CONFIG.keepRecentTokens,
      1024
    ),
    pruneProtectTokens: parseEnvPositiveInt(
      env.PAPERCUP_COMPACT_PRUNE_PROTECT_TOKENS,
      DEFAULT_PAPERCUP_COMPACTION_CONFIG.pruneProtectTokens,
      0
    ),
    pruneMinReclaimTokens: parseEnvPositiveInt(
      env.PAPERCUP_COMPACT_PRUNE_MIN_RECLAIM_TOKENS,
      DEFAULT_PAPERCUP_COMPACTION_CONFIG.pruneMinReclaimTokens,
      0
    ),
    ...(mainSoftCap.explicit ? { mainSoftCapExplicit: true } : {}),
    ...(reverserSoftCap.explicit ? { reverserSoftCapExplicit: true } : {}),
  };
}

/**
 * Compute dynamic L1/L2 compaction thresholds for a model context window and agent role.
 * `effectiveReserveTokens` aligns Pi SDK's `shouldCompact(tokens, contextWindow, settings)`
 * (`tokens > contextWindow - reserveTokens`) with `triggerTokens`.
 */
export function computeCompactionThresholds(
  contextWindow: number,
  role: CompactionRole,
  cfg: PaperCupCompactionConfig = readPaperCupCompactionConfig()
): CompactionThresholds {
  const normalizedWindow =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : DEFAULT_FALLBACK_CONTEXT_WINDOW;
  const isReverser = role === 'reverser';
  const configuredSoftCap = isReverser ? cfg.reverserSoftCapTokens : cfg.mainSoftCapTokens;
  const defaultSoftCap = isReverser
    ? DEFAULT_PAPERCUP_COMPACTION_CONFIG.reverserSoftCapTokens
    : DEFAULT_PAPERCUP_COMPACTION_CONFIG.mainSoftCapTokens;
  const softCapExplicit = isReverser ? Boolean(cfg.reverserSoftCapExplicit) : Boolean(cfg.mainSoftCapExplicit);
  const softCapTokens =
    normalizedWindow >= HUGE_WINDOW_THRESHOLD_TOKENS &&
    !softCapExplicit &&
    configuredSoftCap === defaultSoftCap
      ? isReverser
        ? DEFAULT_HUGE_REVERSER_SOFT_CAP_TOKENS
        : DEFAULT_HUGE_MAIN_SOFT_CAP_TOKENS
      : configuredSoftCap;
  const baseReserveTokens = Math.min(24_576, Math.floor(normalizedWindow * 0.25));
  const triggerTokens = Math.max(
    4096,
    Math.min(normalizedWindow - baseReserveTokens, Math.floor(normalizedWindow * 0.82), softCapTokens)
  );
  const postPruneSkipTokens = Math.floor(triggerTokens * 0.8);
  const effectiveReserveTokens = Math.max(baseReserveTokens, normalizedWindow - triggerTokens);
  const keepRecentTokens = Math.max(
    2048,
    Math.min(cfg.keepRecentTokens, Math.floor(triggerTokens * 0.5))
  );

  return {
    contextWindow: normalizedWindow,
    softCapTokens,
    baseReserveTokens,
    triggerTokens,
    postPruneSkipTokens,
    effectiveReserveTokens,
    keepRecentTokens,
  };
}

type CompactionSettingsManagerLike = Pick<SettingsManager, 'applyOverrides'> &
  Partial<Pick<SettingsManager, 'setCompactionEnabled' | 'isProjectTrusted'>>;

interface InternalProjectSettingsManager {
  settingsPaths?: { global?: string; project?: string };
  updateProjectSettings?: (
    field: 'compaction',
    update: (projectSettings: {
      compaction?: {
        enabled?: boolean;
        reserveTokens?: number;
        keepRecentTokens?: number;
        modelOverrides?: Record<string, { reserveTokens?: number; keepRecentTokens?: number }>;
      };
    }) => void
  ) => void;
}

/**
 * Synchronize Pi SDK's SettingsManager compaction settings with our computed thresholds
 * for the active model and role.
 *
 * For in-memory `SettingsManager` instances, persists token thresholds into in-memory
 * `projectSettings` (and `enabled` via `setCompactionEnabled`) so subsequent `save()`
 * calls from unrelated setters (`setShellPath`, `setSteeringMode`, `setDefaultThinkingLevel`,
 * etc.) never wipe out dynamic thresholds, while never writing to disk for file-backed managers.
 */
export function applyCompactionSettingsForModel(
  settingsManager: CompactionSettingsManagerLike,
  model: Pick<Model<any>, 'provider' | 'id' | 'contextWindow'> | undefined | null,
  role: CompactionRole,
  cfg: PaperCupCompactionConfig = readPaperCupCompactionConfig()
): CompactionThresholds {
  const contextWindow =
    model && Number.isFinite(model.contextWindow) && model.contextWindow > 0
      ? model.contextWindow
      : DEFAULT_FALLBACK_CONTEXT_WINDOW;
  const thresholds = computeCompactionThresholds(contextWindow, role, cfg);
  const modelKey =
    model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;

  const internal = settingsManager as unknown as InternalProjectSettingsManager;
  const isInMemoryProjectWritable =
    typeof internal.updateProjectSettings === 'function' &&
    !internal.settingsPaths?.project &&
    (typeof settingsManager.isProjectTrusted !== 'function' || settingsManager.isProjectTrusted());

  let persistedInMemory = false;
  if (isInMemoryProjectWritable) {
    try {
      settingsManager.setCompactionEnabled?.(cfg.enabled);
      internal.updateProjectSettings!('compaction', (project) => {
        const existingOverrides = project.compaction?.modelOverrides ?? {};
        const nextOverrides = modelKey
          ? {
              ...existingOverrides,
              [modelKey]: {
                reserveTokens: thresholds.effectiveReserveTokens,
                keepRecentTokens: thresholds.keepRecentTokens,
              },
            }
          : existingOverrides;
        project.compaction = {
          reserveTokens: thresholds.effectiveReserveTokens,
          keepRecentTokens: thresholds.keepRecentTokens,
          ...(Object.keys(nextOverrides).length > 0 ? { modelOverrides: nextOverrides } : {}),
        };
      });
      persistedInMemory = true;
    } catch {
      persistedInMemory = false;
    }
  }

  if (!persistedInMemory) {
    settingsManager.applyOverrides({
      compaction: {
        enabled: cfg.enabled,
        reserveTokens: thresholds.effectiveReserveTokens,
        keepRecentTokens: thresholds.keepRecentTokens,
        ...(modelKey
          ? {
              modelOverrides: {
                [modelKey]: {
                  reserveTokens: thresholds.effectiveReserveTokens,
                  keepRecentTokens: thresholds.keepRecentTokens,
                },
              },
            }
          : {}),
      },
    });
  }

  return thresholds;
}

/**
 * Parse a `/compact [focus]` slash command strictly (does not match `/compaction` or `/compactify`).
 */
export function parseSlashCompactCommand(
  input: string
): { isCompact: true; focus?: string } | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const match = SLASH_COMPACT_RE.exec(trimmed);
  if (!match) return null;
  const focus = match[1]?.trim();
  return focus ? { isCompact: true, focus } : { isCompact: true };
}

/**
 * Recognize common Chinese and custom-gateway context overflow errors while excluding
 * rate-limit, quota, billing, and authentication failures.
 */
export function isPaperCupContextOverflow(errorMessage?: string | null): boolean {
  if (!errorMessage || typeof errorMessage !== 'string') return false;
  const normalized = errorMessage.trim();
  if (!normalized) return false;
  if (NON_OVERFLOW_ERROR_RE.test(normalized) || NON_OVERFLOW_HTTP_STATUS_RE.test(normalized)) {
    return false;
  }
  return PAPER_CUP_CONTEXT_OVERFLOW_RE.test(normalized);
}

// ============================================================================
// L1: Deterministic Batch Tool-Result Pruning
// ============================================================================

function formatToolArgsHint(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const priorityKeys = [
    'path',
    'file',
    'filePath',
    'command',
    'pattern',
    'query',
    'archive',
    'batch_id',
    'batchId',
    'engine',
    'track',
    'action',
    'dest',
    'dir',
  ];
  const parts: string[] = [];
  for (const key of priorityKeys) {
    const val = record[key];
    if (typeof val === 'string' && val.trim()) {
      const compactVal = val.replace(/\s+/g, ' ').trim();
      parts.push(`${key}=${compactVal}`);
      if (parts.join(', ').length >= MAX_ARGS_HINT_CHARS) break;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      parts.push(`${key}=${String(val)}`);
    }
  }
  const raw = parts.length > 0 ? parts.join(', ') : safeCompactJson(record);
  if (!raw || raw === '{}') return '';
  if (raw.length <= MAX_ARGS_HINT_CHARS) return raw;
  return `${raw.slice(0, MAX_ARGS_HINT_CHARS - 3)}...`;
}

function safeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

function extractTextAndNonTextBlocks(content: unknown): {
  text: string;
  nonTextBlocks: ImageContent[];
} {
  if (typeof content === 'string') {
    return { text: content, nonTextBlocks: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', nonTextBlocks: [] };
  }
  const textParts: string[] = [];
  const nonTextBlocks: ImageContent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      textParts.push(typed.text);
    } else if (typed.type === 'image') {
      nonTextBlocks.push(block as ImageContent);
    }
  }
  return { text: textParts.join('\n'), nonTextBlocks };
}

function buildCompactHeadTailSnippet(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  const separator = '\n...\n';
  const budget = Math.max(40, maxChars - separator.length);
  const headLen = Math.ceil(budget * 0.55);
  const tailLen = Math.max(16, budget - headLen);
  const head = normalized.slice(0, headLen).trimEnd();
  const tail = normalized.slice(-tailLen).trimStart();
  return `${head}${separator}${tail}`;
}

function extractSavedOutputPath(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const rec = details as Record<string, unknown>;
  for (const key of ['savedOutputPath', 'fullOutputPath', 'full_output_path']) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

/**
 * Deterministically plan L1 batch `context_edit` replacements for older oversized `toolResult`
 * entries after the latest compaction boundary.
 *
 * Guarantees:
 * - Only inspects `message` entries after the latest `compaction` entry not already targeted by a `context_edit`.
 * - Protects the most recent assistant/toolResult turn unconditionally AND the newest `pruneProtectTokens`
 *   of `toolResult` tokens.
 * - Only emits edits when total reclaimed tokens >= `pruneMinReclaimTokens` (protecting Prompt Cache).
 * - Replaces `toolResult` content in-place (never deletes `toolResult`), preserving `toolCall`/`toolResult` pairing.
 */
export function planToolResultPruneEdits(
  branchEntries: readonly SessionEntry[],
  opts: ToolResultPruneOptions = {}
): ToolResultPrunePlan {
  const defaults = readPaperCupCompactionConfig();
  const pruneProtectTokens = Math.max(0, opts.pruneProtectTokens ?? defaults.pruneProtectTokens);
  const pruneMinReclaimTokens = Math.max(0, opts.pruneMinReclaimTokens ?? defaults.pruneMinReclaimTokens);
  const minCharsToPrune = Math.max(200, opts.minCharsToPrune ?? DEFAULT_MIN_CHARS_TO_PRUNE);
  const maxSnippetChars = Math.max(80, opts.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS);
  const knownSecrets = opts.getKnownSecrets?.();

  let lastCompactionIdx = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]?.type === 'compaction') {
      lastCompactionIdx = i;
      break;
    }
  }
  const scanStart = lastCompactionIdx + 1;

  const alreadyEditedIds = new Set<string>();
  for (let i = 0; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (entry?.type === 'context_edit' && typeof entry.targetId === 'string') {
      alreadyEditedIds.add(entry.targetId);
    }
  }

  // Collect toolCall arguments hints from assistant messages in the active post-compaction span.
  const toolCallMeta = new Map<string, { toolName: string; argsHint: string }>();
  for (let i = scanStart; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (entry?.type !== 'message' || entry.message.role !== 'assistant') continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'toolCall' && typeof block.id === 'string') {
        toolCallMeta.set(block.id, {
          toolName: block.name || 'tool',
          argsHint: formatToolArgsHint(block.arguments),
        });
      }
    }
  }

  // Always protect the most recent assistant/toolResult turn.
  let newestToolResultIdx = -1;
  for (let i = branchEntries.length - 1; i >= scanStart; i--) {
    const entry = branchEntries[i];
    if (entry?.type === 'message' && entry.message.role === 'toolResult') {
      newestToolResultIdx = i;
      break;
    }
  }
  if (newestToolResultIdx === -1) {
    return {
      edits: [],
      prunedCount: 0,
      reclaimedTokens: 0,
      reclaimedChars: 0,
      eligibleCount: 0,
      candidateReclaimedTokens: 0,
    };
  }

  let newestToolTurnAssistantIdx = -1;
  for (let i = newestToolResultIdx - 1; i >= scanStart; i--) {
    const entry = branchEntries[i];
    if (entry?.type === 'message' && entry.message.role === 'assistant') {
      newestToolTurnAssistantIdx = i;
      break;
    }
  }

  interface CandidateEdit {
    draft: ContextEditEntryDraft;
    reclaimedTokens: number;
    reclaimedChars: number;
  }

  const candidatesReversed: CandidateEdit[] = [];
  let protectedToolTokens = 0;

  for (let i = branchEntries.length - 1; i >= scanStart; i--) {
    const entry = branchEntries[i];
    if (entry?.type !== 'message' || entry.message.role !== 'toolResult') continue;
    if (alreadyEditedIds.has(entry.id)) continue;

    const msg = entry.message;
    const msgTokens = estimateTokens(msg);

    const inMostRecentToolTurn = newestToolTurnAssistantIdx === -1 || i > newestToolTurnAssistantIdx;
    if (inMostRecentToolTurn || protectedToolTokens < pruneProtectTokens) {
      protectedToolTokens += msgTokens;
      continue;
    }

    const { text, nonTextBlocks } = extractTextAndNonTextBlocks(msg.content);
    if (text.length <= minCharsToPrune) continue;

    const callMeta = typeof msg.toolCallId === 'string' ? toolCallMeta.get(msg.toolCallId) : undefined;
    const toolName = msg.toolName || callMeta?.toolName || 'tool';
    const argsHint = callMeta?.argsHint ? redactSecrets(callMeta.argsHint, knownSecrets) : '';
    const savedOutputPath = extractSavedOutputPath(msg.details);
    const originalChars = text.length;
    const originalLines = text ? text.split(/\r?\n/).length : 0;
    const snippet = redactSecrets(buildCompactHeadTailSnippet(text, maxSnippetChars), knownSecrets);

    const metaSegments = [
      `${originalChars} chars`,
      `${originalLines} lines`,
      ...(msg.isError ? ['error'] : []),
      ...(savedOutputPath ? [`saved: ${savedOutputPath}`] : []),
    ];
    const header = `[Pruned older tool output: ${toolName}${argsHint ? ` (${argsHint})` : ''} | ${metaSegments.join(' | ')}]`;
    const compactText = snippet ? `${header}\n${snippet}` : header;

    if (compactText.length >= originalChars) continue;

    const replacementContent: (TextContent | ImageContent)[] = [
      { type: 'text', text: compactText },
      ...nonTextBlocks,
    ];
    const editedTokens = estimateTokens({ ...msg, content: replacementContent });
    const reclaimedTokens = Math.max(0, msgTokens - editedTokens);
    if (reclaimedTokens <= 0) continue;

    candidatesReversed.push({
      draft: {
        type: 'context_edit',
        targetId: entry.id,
        replacement: { content: replacementContent },
      },
      reclaimedTokens,
      reclaimedChars: Math.max(0, originalChars - compactText.length),
    });
  }

  candidatesReversed.reverse();
  const candidateReclaimedTokens = candidatesReversed.reduce((sum, item) => sum + item.reclaimedTokens, 0);
  const candidateReclaimedChars = candidatesReversed.reduce((sum, item) => sum + item.reclaimedChars, 0);

  if (candidatesReversed.length === 0 || candidateReclaimedTokens < pruneMinReclaimTokens) {
    return {
      edits: [],
      prunedCount: 0,
      reclaimedTokens: 0,
      reclaimedChars: 0,
      eligibleCount: candidatesReversed.length,
      candidateReclaimedTokens,
    };
  }

  return {
    edits: candidatesReversed.map((item) => item.draft),
    prunedCount: candidatesReversed.length,
    reclaimedTokens: candidateReclaimedTokens,
    reclaimedChars: candidateReclaimedChars,
    eligibleCount: candidatesReversed.length,
    candidateReclaimedTokens,
  };
}

// ============================================================================
// L2: Domain Compaction Prompts, Deterministic Workspace Anchor & Checkpoint
// ============================================================================

/**
 * Build role-specific structured compaction instructions for Pi SDK's summarizer.
 */
export function buildDomainCompactionInstructions(
  role: CompactionRole,
  focus?: string
): string {
  let base: string;
  if (role === 'main') {
    base = [
      'Paper Cup Visual Novel Localization Session — preserve these exact structured details:',
      '1. Goal & User Constraints: narrative POV, target style, patch mode, and any explicit user rules or overrides.',
      '2. Current VN Pipeline Stage: exact stage reached (detect / unpack / classify / roster / plan / translate / post-QA / merge / writeback / smoke / accept / release) and what remains.',
      '3. Engine & Skill Status: detected VN engine, builtin vs learned/direct skill name, encoding, and control-tag pattern.',
      '4. Locked Character Roster & Glossary Decisions: exact locked character names, aliases, gender/pronouns, honorific rules, and key terminology decisions.',
      '5. Latest QA / Smoke Failure Root Causes & Blockers: exact ruleIds, failing batch IDs, file paths, and error messages.',
      '6. Next Concrete Steps: ordered immediate actions without repeating already completed stages.',
    ].join('\n');
  } else if (role === 'reverser') {
    base = [
      'Paper Cup VN Reverse-Engineering Session — preserve these exact structured details:',
      '1. Verified Binary/Container/Script Layout (TAGGED BY DATA LAYER): every verified offset, magic, header field, index/TOC layout, and codec formula MUST include its layer tag (`[layer: raw]`, `[layer: post-xor]`, `[layer: post-decompress]`, `[layer: inner-script]`).',
      '2. LAYER-SCOPED DISPROVEN HYPOTHESES / DEAD ENDS (same-layer only): list failed hypotheses tagged by the EXACT data layer on which they were tested. HARD RULE: once a new outer layer (e.g. XOR/decryption/unpacking) is verified and peeled, ALL header-size guesses, entropy conclusions, and compression rejections measured on the earlier outer layer are AUTOMATICALLY INVALIDATED — NEVER carry them forward as cross-layer "DO NOT RETRY" dead ends.',
      '3. Exact Decompression Oracle & Paths: decompression starts immediately after verified fixed header fields (never subtract unverified guessed header bytes) and must match `len(out) == declared_usize`. Preserve exact paths under `.papercup/research/`, `.papercup/skills/`, and generated scripts (`unpack.py`, `repack.py`, `extract.py`, `apply.py`, `engine.json`).',
      '4. Remaining Unknowns & Next Minimal Verification Experiment: prefer `vn_re_lookup`, `vn_re_inspect`, or `vn_re_trace` (`DR0` watchpoint) over blind scans, and list the exact next byte oracle or writeback check.',
    ].join('\n');
  } else {
    base = [
      'Paper Cup Subagent Session — preserve these exact structured details:',
      '1. Goal & Constraints: assigned task scope and non-negotiable rules.',
      '2. Verified Findings: concrete facts, measurements, or diagnoses already confirmed.',
      '3. Artifacts & Paths: exact files created, modified, or inspected.',
      '4. Blockers & Open Questions: unresolved errors or ambiguities.',
      '5. Next Steps: exact remaining actions to finish the assignment.',
    ].join('\n');
  }

  const trimmedFocus = focus?.trim();
  if (trimmedFocus) {
    return `${base}\n\nUser-specified compaction focus (prioritize preserving details relevant to this focus):\n${trimmedFocus}`;
  }
  return base;
}

function truncateAtLineBoundary(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const suffix = '\n... [truncated]';
  const budget = Math.max(80, maxChars - suffix.length);
  const sliced = trimmed.slice(0, budget);
  const lastNewline = sliced.lastIndexOf('\n');
  const cut = lastNewline >= Math.floor(budget * 0.5) ? sliced.slice(0, lastNewline) : sliced;
  return `${cut.trimEnd()}${suffix}`;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isSymlinkSafe(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function listFilesDeterministically(
  baseDir: string,
  relPrefix: string,
  maxDepth = 3,
  maxEntries = 40
): string[] {
  if (!fs.existsSync(baseDir) || isSymlinkSafe(baseDir)) return [];
  const results: string[] = [];

  const walk = (dir: string, relDir: string, depth: number) => {
    if (depth > maxDepth || results.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const ent of entries) {
      if (results.length >= maxEntries) break;
      const full = path.join(dir, ent.name);
      if (isSymlinkSafe(full)) continue;
      const relPosix = `${relDir}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(full, relPosix, depth + 1);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          results.push(`- ${relPosix} (${formatByteSize(st.size)})`);
        } catch {
          results.push(`- ${relPosix}`);
        }
      }
    }
  };

  walk(baseDir, relPrefix, 0);
  return results;
}

function listProjectSkillNames(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir) || isSymlinkSafe(skillsDir)) return [];
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && !isSymlinkSafe(path.join(skillsDir, ent.name)))
      .map((ent) => ent.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Build a deterministic, factual disk-truth workspace snapshot to append to L2 compaction summaries.
 */
export function buildDeterministicWorkspaceAnchor(
  cwd: string,
  role: CompactionRole,
  opts: { getKnownSecrets?: () => Iterable<string> } = {}
): string {
  if (!cwd || !fs.existsSync(cwd)) return '';

  let body = '';
  const wsPaths = resolveWorkspacePaths(cwd);

  if (role === 'main') {
    const sections: string[] = [];
    const skillNames = listProjectSkillNames(wsPaths.skillsDir);
    if (skillNames.length > 0) {
      sections.push(`项目技能（${PAPERCUP_SKILLS_REL}）：${skillNames.join(', ')}`);
    }
    try {
      const statusText = getVnStatus(cwd);
      if (statusText.trim()) {
        sections.push(statusText.trim());
      }
    } catch {
      // Workspace may not have VN state initialized yet; omit cleanly.
    }
    body = truncateAtLineBoundary(sections.join('\n'), MAIN_ANCHOR_MAX_CHARS);
  } else if (role === 'reverser') {
    const lines: string[] = [];
    const researchFiles = listFilesDeterministically(wsPaths.researchDir, PAPERCUP_RESEARCH_REL, 3, 25);
    const skillFiles = listFilesDeterministically(wsPaths.skillsDir, PAPERCUP_SKILLS_REL, 3, 25);
    if (researchFiles.length > 0) {
      lines.push('Research files:', ...researchFiles);
    } else {
      lines.push(`Research files: (none under ${PAPERCUP_RESEARCH_REL})`);
    }
    if (skillFiles.length > 0) {
      lines.push('Skill files:', ...skillFiles);
    } else {
      lines.push(`Skill files: (none under ${PAPERCUP_SKILLS_REL})`);
    }
    body = truncateAtLineBoundary(lines.join('\n'), REVERSER_ANCHOR_MAX_CHARS);
  } else {
    const lines: string[] = [];
    const skillNames = listProjectSkillNames(wsPaths.skillsDir);
    if (skillNames.length > 0) {
      lines.push(`Project skills: ${skillNames.join(', ')}`);
    }
    try {
      const statusText = getVnStatus(cwd);
      if (statusText.trim()) {
        lines.push(statusText.trim());
      }
    } catch {
      // Ignore if VN status is unavailable.
    }
    body = truncateAtLineBoundary(lines.join('\n'), SUBAGENT_ANCHOR_MAX_CHARS);
  }

  if (!body) return '';
  const redactedBody = redactSecrets(body, opts.getKnownSecrets?.());
  return `## Workspace State Snapshot (Authoritative Disk Truth)\n${redactedBody}`;
}

/**
 * Archive a compaction checkpoint markdown file under `.papercup/tmp/diagnostics/compactions/`.
 * Never writes to `.papercup/research/`. Swallows non-fatal filesystem errors.
 */
export function archiveCompactionCheckpoint(
  cwd: string,
  role: CompactionRole,
  info: CompactionSummaryInfo,
  opts: { getKnownSecrets?: () => Iterable<string> } = {}
): string | undefined {
  try {
    if (!cwd || !fs.existsSync(cwd)) return undefined;
    const wsPaths = resolveWorkspacePaths(cwd);
    const outDir = wsPaths.compactionsDir;
    if (isSymlinkSafe(wsPaths.papercupDir) || isSymlinkSafe(wsPaths.tmpDir) || isSymlinkSafe(wsPaths.diagnosticsDir) || isSymlinkSafe(outDir)) {
      return undefined;
    }
    fs.mkdirSync(outDir, { recursive: true });

    const tsSource = info.timestamp && !Number.isNaN(Date.parse(info.timestamp))
      ? new Date(info.timestamp).toISOString()
      : new Date().toISOString();
    const safeTs = tsSource.replace(/[:.]/g, '-');
    const safeRole = role.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase() || 'session';
    const rawId = (info.id || '').replace(/[^a-zA-Z0-9_-]+/g, '');
    const shortId = rawId.slice(0, 8) || crypto.randomBytes(3).toString('hex');
    const fileName = `${safeTs}-${safeRole}-${shortId}.md`;
    const filePath = path.join(outDir, fileName);

    const metaLines = [
      `# Compaction Checkpoint (${safeRole})`,
      '',
      `- **ID**: ${info.id || shortId}`,
      `- **Timestamp**: ${tsSource}`,
      `- **Role**: ${role}`,
      `- **Reason**: ${info.reason}`,
      `- **Tokens**: ${info.tokensBefore} -> ${info.tokensAfter}`,
      ...(info.focus ? [`- **Focus**: ${info.focus}`] : []),
      ...(typeof info.prunedCount === 'number' && info.prunedCount > 0
        ? [`- **L1 Pruned Tool Results**: ${info.prunedCount}`]
        : []),
      '',
      '---',
      '',
      info.summary,
      '',
    ];
    const redactedContent = redactSecrets(metaLines.join('\n'), opts.getKnownSecrets?.());
    fs.writeFileSync(filePath, redactedContent, 'utf8');
    return `${WORKSPACE_COMPACTIONS_REL}/${fileName}`;
  } catch {
    return undefined;
  }
}

/**
 * Helper to extract a normalized `CompactionSummaryInfo` from a persisted Pi SDK `CompactionEntry`.
 */
export function extractCompactionSummaryInfo(
  entry: CompactionEntry,
  fallbackTokensAfter?: number
): CompactionSummaryInfo {
  const details =
    entry.details && typeof entry.details === 'object'
      ? (entry.details as CompactionEntryDetails)
      : undefined;
  const reason: CompactionReason =
    details?.reason === 'manual' || details?.reason === 'threshold' || details?.reason === 'overflow'
      ? details.reason
      : 'threshold';
  const summary = typeof entry.summary === 'string' ? entry.summary : '';
  const tokensBefore =
    typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore)
      ? Math.max(0, Math.floor(entry.tokensBefore))
      : 0;
  const detailsTokensAfter =
    typeof details?.tokensAfter === 'number' && Number.isFinite(details.tokensAfter)
      ? Math.max(0, Math.floor(details.tokensAfter))
      : undefined;
  const fallback =
    typeof fallbackTokensAfter === 'number' && Number.isFinite(fallbackTokensAfter)
      ? Math.max(0, Math.floor(fallbackTokensAfter))
      : Math.ceil(summary.length / 4);
  const tokensAfter = detailsTokensAfter ?? fallback;
  const focus = typeof details?.focus === 'string' && details.focus.trim() ? details.focus.trim() : undefined;
  const checkpointPath =
    typeof details?.checkpointPath === 'string' && details.checkpointPath.trim()
      ? details.checkpointPath.trim()
      : undefined;
  const prunedCount =
    typeof details?.prunedCount === 'number' && Number.isFinite(details.prunedCount) && details.prunedCount > 0
      ? Math.floor(details.prunedCount)
      : undefined;

  return {
    id: entry.id,
    timestamp: entry.timestamp,
    reason,
    tokensBefore,
    tokensAfter,
    summary,
    ...(focus ? { focus } : {}),
    ...(checkpointPath ? { checkpointPath } : {}),
    ...(prunedCount !== undefined ? { prunedCount } : {}),
  };
}

// ============================================================================
// Accurate Prompt-Token Estimation (Excluding Historical Thinking Blocks)
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function safeJsonLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized.length : 0;
  } catch {
    return 0;
  }
}

function estimateTextAndImageContentChars(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      chars += typed.text.length;
    } else if (typed.type === 'image') {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
}

/**
 * Estimate actual prompt-contributing tokens for a single `AgentMessage`,
 * intentionally EXCLUDING historical `thinking` blocks.
 *
 * LLM providers do not accumulate historical reasoning/thinking blocks across
 * turns; summing them via Pi SDK's `estimateTokens()` after an L1 `context_edit`
 * invalidates `lastUsage` creates 100K+ phantom tokens and falsely triggers L2.
 */
export function estimatePromptMessageTokens(message: AgentMessage): number {
  if (!message || typeof message !== 'object') return 0;
  let chars = 0;
  switch (message.role) {
    case 'system': {
      const system = message as {
        content?: unknown;
        sections?: Record<string, string | undefined>;
        toolsAdded?: unknown;
      };
      chars = estimateTextAndImageContentChars(system.content);
      if (system.sections && typeof system.sections === 'object') {
        for (const section of Object.values(system.sections)) {
          if (typeof section === 'string') {
            chars += section.length;
          }
        }
      }
      if (system.toolsAdded) {
        chars += safeJsonLength(system.toolsAdded);
      }
      return Math.ceil(chars / 4);
    }
    case 'user': {
      chars = estimateTextAndImageContentChars((message as { content?: unknown }).content);
      return Math.ceil(chars / 4);
    }
    case 'assistant': {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') {
        chars += content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const typed = block as {
            type?: string;
            text?: unknown;
            name?: unknown;
            arguments?: unknown;
          };
          if (typed.type === 'text' && typeof typed.text === 'string') {
            chars += typed.text.length;
          } else if (typed.type === 'toolCall') {
            if (typeof typed.name === 'string') {
              chars += typed.name.length;
            }
            if (typed.arguments !== undefined) {
              chars += safeJsonLength(typed.arguments);
            }
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case 'custom':
    case 'toolResult': {
      chars = estimateTextAndImageContentChars((message as { content?: unknown }).content);
      return Math.ceil(chars / 4);
    }
    case 'bashExecution': {
      const bash = message as { command?: unknown; output?: unknown };
      chars =
        (typeof bash.command === 'string' ? bash.command.length : 0) +
        (typeof bash.output === 'string' ? bash.output.length : 0);
      return Math.ceil(chars / 4);
    }
    case 'branchSummary':
    case 'compactionSummary': {
      const summary = (message as { summary?: unknown }).summary;
      chars = typeof summary === 'string' ? summary.length : 0;
      return Math.ceil(chars / 4);
    }
    default:
      return 0;
  }
}

function estimateAllPromptMessagesExcludingThinking(messages: readonly AgentMessage[]): number {
  let latestSystem: AgentMessage | undefined;
  let nonSystemTokens = 0;
  for (const msg of messages) {
    if (msg.role === 'system') {
      latestSystem = msg;
    } else {
      nonSystemTokens += estimatePromptMessageTokens(msg);
    }
  }
  return (latestSystem ? estimatePromptMessageTokens(latestSystem) : 0) + nonSystemTokens;
}

function getValidAssistantUsage(msg: AgentMessage | undefined): Usage | undefined {
  if (!msg || msg.role !== 'assistant' || !('usage' in msg)) return undefined;
  const assistant = msg as { stopReason?: string; usage?: Usage };
  if (
    assistant.stopReason === 'aborted' ||
    assistant.stopReason === 'error' ||
    !assistant.usage
  ) {
    return undefined;
  }
  return calculateContextTokens(assistant.usage) > 0 ? assistant.usage : undefined;
}

function findLastCompactionIndex(branchEntries: readonly SessionEntry[]): number {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]?.type === 'compaction') {
      return i;
    }
  }
  return -1;
}

function findLatestPostCompactionUsageEntry(
  branchEntries: readonly SessionEntry[],
  projectedEntryIndexById?: ReadonlyMap<string, number>
): { entry: SessionEntry; branchIndex: number; usage: Usage } | undefined {
  const lastCompactionIdx = findLastCompactionIndex(branchEntries);
  for (let i = branchEntries.length - 1; i > lastCompactionIdx; i--) {
    const entry = branchEntries[i];
    if (!entry || entry.type !== 'message') continue;
    const usage = getValidAssistantUsage(entry.message);
    if (!usage) continue;
    if (projectedEntryIndexById && !projectedEntryIndexById.has(entry.id)) {
      continue;
    }
    return { entry, branchIndex: i, usage };
  }
  return undefined;
}

function applyContextEditToEntryMessages(
  entry: SessionEntry,
  edit: ContextEditEntry | undefined
): AgentMessage[] {
  const messages = sessionEntryToContextMessages(entry);
  if (!edit) return messages;
  const replacement = edit.replacement;
  if (replacement === null) return [];
  return messages.map((message) => {
    if (
      message.role !== 'user' &&
      message.role !== 'assistant' &&
      message.role !== 'toolResult' &&
      message.role !== 'custom'
    ) {
      return message;
    }
    const content =
      (message.role === 'assistant' || message.role === 'toolResult') &&
      typeof replacement.content === 'string'
        ? [{ type: 'text' as const, text: replacement.content }]
        : replacement.content;
    return { ...message, content } as AgentMessage;
  });
}

/**
 * Returns true if any `context_edit` entry occurred after the latest valid
 * post-compaction assistant usage entry (the exact condition where Pi SDK's
 * `estimateProjectedContextTokens()` invalidates provider `usage` and falls
 * back to summing historical `thinking` blocks).
 */
export function hasPostUsageContextEdit(branchEntries: readonly SessionEntry[]): boolean {
  const usageInfo = findLatestPostCompactionUsageEntry(branchEntries);
  if (!usageInfo) return false;
  for (let i = usageInfo.branchIndex + 1; i < branchEntries.length; i++) {
    if (branchEntries[i]?.type === 'context_edit') {
      return true;
    }
  }
  return false;
}

/**
 * Estimate real projected context tokens without historical `thinking` inflation,
 * preserving provider-measured `usage` across L1 `context_edit` pruning.
 *
 * - Finds the latest valid assistant `usage` entry on `branchEntries` after the latest `compaction`.
 * - If no `context_edit` occurred after that `usage` entry: returns
 *   `calculateContextTokens(usage) + trailingPromptTokensExcludingThinking`.
 * - If `context_edit` entries occurred after that `usage` entry: subtracts deterministically
 *   reclaimed pre-usage tokens (or `recentL1ReclaimedTokens` when larger) from `calculateContextTokens(usage)`
 *   and adds `trailingPromptTokensExcludingThinking`, respecting provider tokenization (e.g. CJK).
 * - If no valid post-compaction `usage` exists: sums `estimatePromptMessageTokens` over `projection.messages`.
 */
export function estimateRealProjectedContextTokens(
  projection: Pick<SessionProjection, 'entries' | 'messages'>,
  branchEntries: readonly SessionEntry[],
  recentL1ReclaimedTokens?: number
): number {
  const projectedEntries = Array.isArray(projection?.entries) ? projection.entries : [];
  const projectedMessages = Array.isArray(projection?.messages) ? projection.messages : [];

  const projectedEntryIndexById = new Map<string, number>();
  for (let i = 0; i < projectedEntries.length; i++) {
    const pe = projectedEntries[i];
    if (pe?.sourceEntry?.id && Array.isArray(pe.messages) && pe.messages.length > 0) {
      projectedEntryIndexById.set(pe.sourceEntry.id, i);
    }
  }

  const usageInfo = findLatestPostCompactionUsageEntry(
    branchEntries,
    projectedEntries.length > 0 ? projectedEntryIndexById : undefined
  );

  if (!usageInfo) {
    return estimateAllPromptMessagesExcludingThinking(projectedMessages);
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);

  let trailingTokens = 0;
  if (projectedEntries.length > 0) {
    const projIdx = projectedEntryIndexById.get(usageInfo.entry.id);
    if (projIdx !== undefined) {
      for (let i = projIdx + 1; i < projectedEntries.length; i++) {
        const msgs = projectedEntries[i]?.messages;
        if (!Array.isArray(msgs)) continue;
        for (const msg of msgs) {
          if (msg.role !== 'system') {
            trailingTokens += estimatePromptMessageTokens(msg);
          }
        }
      }
    }
  } else {
    let lastUsageMsgIdx = -1;
    for (let i = projectedMessages.length - 1; i >= 0; i--) {
      if (getValidAssistantUsage(projectedMessages[i])) {
        lastUsageMsgIdx = i;
        break;
      }
    }
    if (lastUsageMsgIdx >= 0) {
      for (let i = lastUsageMsgIdx + 1; i < projectedMessages.length; i++) {
        const msg = projectedMessages[i];
        if (msg && msg.role !== 'system') {
          trailingTokens += estimatePromptMessageTokens(msg);
        }
      }
    }
  }

  const postUsageEdits = new Map<string, ContextEditEntry>();
  for (let i = usageInfo.branchIndex + 1; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (entry?.type === 'context_edit' && typeof entry.targetId === 'string') {
      postUsageEdits.set(entry.targetId, entry);
    }
  }

  if (postUsageEdits.size === 0) {
    return usageTokens + trailingTokens;
  }

  const lastCompactionIdx = findLastCompactionIndex(branchEntries);
  const activePreUsageEntries = new Map<string, SessionEntry>();
  if (lastCompactionIdx >= 0) {
    const compaction = branchEntries[lastCompactionIdx] as CompactionEntry;
    let foundFirstKept = false;
    for (let i = 0; i < lastCompactionIdx; i++) {
      const entry = branchEntries[i];
      if (!entry) continue;
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept && !(entry.type === 'message' && entry.message.role === 'system')) {
        activePreUsageEntries.set(entry.id, entry);
      }
    }
    for (let i = lastCompactionIdx + 1; i <= usageInfo.branchIndex; i++) {
      const entry = branchEntries[i];
      if (entry) activePreUsageEntries.set(entry.id, entry);
    }
  } else {
    for (let i = 0; i <= usageInfo.branchIndex; i++) {
      const entry = branchEntries[i];
      if (entry) activePreUsageEntries.set(entry.id, entry);
    }
  }

  const preUsageEdits = new Map<string, ContextEditEntry>();
  for (let i = 0; i < usageInfo.branchIndex; i++) {
    const entry = branchEntries[i];
    if (entry?.type === 'context_edit' && typeof entry.targetId === 'string') {
      preUsageEdits.set(entry.targetId, entry);
    }
  }

  let deterministicReclaimed = 0;
  for (const [targetId, afterEdit] of postUsageEdits.entries()) {
    const targetEntry = activePreUsageEntries.get(targetId);
    if (!targetEntry) continue;
    const beforeMsgs = applyContextEditToEntryMessages(targetEntry, preUsageEdits.get(targetId));
    const afterMsgs = applyContextEditToEntryMessages(targetEntry, afterEdit);
    const beforeTokens = beforeMsgs.reduce((sum, msg) => sum + estimatePromptMessageTokens(msg), 0);
    const afterTokens = afterMsgs.reduce((sum, msg) => sum + estimatePromptMessageTokens(msg), 0);
    deterministicReclaimed += beforeTokens - afterTokens;
  }

  const passedReclaimed =
    typeof recentL1ReclaimedTokens === 'number' &&
    Number.isFinite(recentL1ReclaimedTokens) &&
    recentL1ReclaimedTokens > 0
      ? Math.floor(recentL1ReclaimedTokens)
      : 0;
  const reclaimedTokens = Math.max(0, deterministicReclaimed, passedReclaimed);

  return Math.max(0, usageTokens - reclaimedTokens) + trailingTokens;
}

// ============================================================================
// Pi SDK Inline Extension Factory
// ============================================================================

function sanitizeHeaders(
  rawHeaders: Record<string, string | null> | undefined
): Record<string, string> | undefined {
  if (!rawHeaders) return undefined;
  const clean: Record<string, string> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v === 'string') {
      clean[k] = v;
      hasAny = true;
    }
  }
  return hasAny ? clean : undefined;
}

/**
 * Create the Pi SDK inline extension that integrates Paper Cup's L1 batch tool-result pruning
 * (`turn_end` boundary drafts) and L2 domain-customized compaction + workspace anchor +
 * checkpoint archiving (`session_before_compact`).
 */
export function createPaperCupCompactionExtension(
  opts: PaperCupCompactionExtensionOptions
): InlineExtension {
  let pendingPrunedCount = 0;
  let lastSeenUsageEntryId: string | undefined;
  let reclaimedSinceLastAssistantUsage = 0;
  let prunedSinceLastAssistantUsage = false;

  const syncAssistantUsageTracking = (branchEntries: readonly SessionEntry[]) => {
    const latestUsageId = findLatestPostCompactionUsageEntry(branchEntries)?.entry.id;
    if (latestUsageId !== lastSeenUsageEntryId) {
      lastSeenUsageEntryId = latestUsageId;
      reclaimedSinceLastAssistantUsage = 0;
      prunedSinceLastAssistantUsage = false;
    }
  };

  return {
    name: `papercup-compaction-${opts.role}`,
    hidden: true,
    factory: (pi) => {
      pi.on('turn_end', (event, ctx) => {
        const cfg = opts.config ?? readPaperCupCompactionConfig();
        if (!cfg.enabled) return undefined;
        if (event.outcome === 'aborted') return undefined;

        const model = opts.getModel?.() ?? ctx.model;
        const usage = ctx.getContextUsage();
        const contextWindow = model?.contextWindow ?? usage?.contextWindow ?? 0;
        if (contextWindow <= 0) return undefined;

        const branch = ctx.sessionManager.getBranch();
        syncAssistantUsageTracking(branch);

        const thresholds = computeCompactionThresholds(contextWindow, opts.role, cfg);
        const hasValidUsageTokens =
          typeof usage?.tokens === 'number' && Number.isFinite(usage.tokens) && usage.tokens > 0;
        const usageInvalidatedByEdit = hasPostUsageContextEdit(branch);
        const projectedTokens =
          hasValidUsageTokens && !usageInvalidatedByEdit
            ? usage.tokens!
            : typeof ctx.sessionManager.buildSessionProjection === 'function'
              ? estimateRealProjectedContextTokens(
                  ctx.sessionManager.buildSessionProjection(),
                  branch,
                  reclaimedSinceLastAssistantUsage
                )
              : estimateAllPromptMessagesExcludingThinking(event.context.contextMessages);

        if (projectedTokens < thresholds.triggerTokens) {
          return undefined;
        }

        const plan = planToolResultPruneEdits(branch, {
          pruneProtectTokens: cfg.pruneProtectTokens,
          pruneMinReclaimTokens: cfg.pruneMinReclaimTokens,
          getKnownSecrets: opts.getKnownSecrets,
        });

        if (plan.edits.length === 0) {
          return undefined;
        }

        const tokensAfter = Math.max(0, projectedTokens - plan.reclaimedTokens);
        const skippedL2 = tokensAfter <= thresholds.postPruneSkipTokens;
        pendingPrunedCount += plan.prunedCount;
        reclaimedSinceLastAssistantUsage += plan.reclaimedTokens;
        prunedSinceLastAssistantUsage = true;

        opts.onPruned?.({
          role: opts.role,
          prunedCount: plan.prunedCount,
          reclaimedTokens: plan.reclaimedTokens,
          reclaimedChars: plan.reclaimedChars,
          tokensBefore: projectedTokens,
          tokensAfter,
          skippedL2,
        });

        return {
          entries: [...event.entries, ...plan.edits],
        };
      });

      pi.on('session_before_compact', async (event, ctx) => {
        const cfg = opts.config ?? readPaperCupCompactionConfig();
        // Manual `/compact` MUST always work even when auto compaction is disabled.
        if (event.reason !== 'manual' && !cfg.enabled) {
          return { cancel: true };
        }

        const branch = ctx.sessionManager.getBranch();
        syncAssistantUsageTracking(branch);

        const model = opts.getModel?.() ?? ctx.model;
        const projection = ctx.sessionManager.buildSessionProjection();
        const postUsageEdited = hasPostUsageContextEdit(branch);
        const realTokensBefore = estimateRealProjectedContextTokens(
          projection,
          branch,
          reclaimedSinceLastAssistantUsage
        );

        // Guard against Pi SDK false-triggering threshold compaction due to phantom historical
        // `thinking` block over-estimation after L1 `context_edit` invalidates `lastUsage`,
        // or when L1 pruning has already brought real context below trigger/post-prune threshold.
        // NEVER cancel 'manual' or 'overflow' compaction!
        if (event.reason === 'threshold') {
          const contextWindow = model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
          if (contextWindow > 0) {
            const thresholds = computeCompactionThresholds(contextWindow, opts.role, cfg);
            if (
              realTokensBefore < thresholds.triggerTokens ||
              (prunedSinceLastAssistantUsage && realTokensBefore <= thresholds.postPruneSkipTokens)
            ) {
              return { cancel: true };
            }
          }
        }

        if (!model) {
          return undefined;
        }

        const mergedInstructions = buildDomainCompactionInstructions(
          opts.role,
          event.customInstructions
        );

        let requestModel: Model<any> = model;
        let apiKey: string | undefined;
        let headers: Record<string, string> | undefined;
        let env: Record<string, string> | undefined;

        try {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (auth.ok) {
            if (auth.baseUrl) {
              requestModel = { ...model, baseUrl: auth.baseUrl };
            }
            apiKey = auth.apiKey;
            headers = sanitizeHeaders(auth.headers);
            env = auth.env;
          }
        } catch {
          // Graceful fallback: let modelRegistry.streamSimple or custom streamFn resolve auth at request time.
        }

        const customStreamFn = opts.getStreamFn?.();
        const streamFn: StreamFn =
          customStreamFn ??
          ((reqModel, reqContext, reqOptions) =>
            ctx.modelRegistry.streamSimple(reqModel, reqContext, reqOptions));

        const settings = pi.getSettings();
        const retryPolicy =
          settings.retry?.enabled === false
            ? { enabled: false, maxRetries: 0, baseDelayMs: 0 }
            : {
                enabled: settings.retry?.enabled ?? true,
                maxRetries: settings.retry?.maxRetries ?? 3,
                baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
                maxAgentDelayMs: settings.retry?.maxAgentDelayMs ?? 60_000,
              };

        const result = await compact(
          event.preparation,
          requestModel,
          apiKey,
          headers,
          mergedInstructions,
          event.signal,
          ctx.thinkingLevel,
          streamFn,
          env,
          retryPolicy
        );

        const knownSecrets = opts.getKnownSecrets?.();
        let finalSummary = redactSecrets(result.summary, knownSecrets);
        const targetCwd = opts.cwd || ctx.cwd;
        const workspaceAnchor = buildDeterministicWorkspaceAnchor(targetCwd, opts.role, {
          getKnownSecrets: opts.getKnownSecrets,
        });
        if (workspaceAnchor) {
          finalSummary = `${finalSummary.trimEnd()}\n\n${workspaceAnchor}`;
        }

        // Estimate post-compaction token footprint (system + summary + kept messages, excluding thinking).
        const latestProjection = ctx.sessionManager.buildSessionProjection();
        let latestSystem: AgentMessage | undefined;
        let keptTokens = 0;
        let keeping = false;
        for (const pe of latestProjection.entries) {
          if (pe.sourceEntry.id === result.firstKeptEntryId) {
            keeping = true;
          }
          for (const msg of pe.messages) {
            if (msg.role === 'system') {
              latestSystem = msg;
            } else if (keeping) {
              keptTokens += estimatePromptMessageTokens(msg);
            }
          }
        }
        const estimatedTokensAfter =
          (latestSystem ? estimatePromptMessageTokens(latestSystem) : 0) +
          Math.ceil(finalSummary.length / 4) +
          keptTokens;

        const effectiveTokensBefore =
          postUsageEdited && realTokensBefore > 0 ? realTokensBefore : result.tokensBefore;

        const prunedCount = pendingPrunedCount;
        pendingPrunedCount = 0;
        lastSeenUsageEntryId = undefined;
        reclaimedSinceLastAssistantUsage = 0;
        prunedSinceLastAssistantUsage = false;

        const focus = event.customInstructions?.trim() || undefined;
        const checkpointId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const checkpointInfo: CompactionSummaryInfo = {
          id: checkpointId,
          timestamp,
          reason: event.reason,
          tokensBefore: effectiveTokensBefore,
          tokensAfter: estimatedTokensAfter,
          summary: finalSummary,
          ...(focus ? { focus } : {}),
          ...(prunedCount > 0 ? { prunedCount } : {}),
        };
        const checkpointPath = archiveCompactionCheckpoint(targetCwd, opts.role, checkpointInfo, {
          getKnownSecrets: opts.getKnownSecrets,
        });
        if (checkpointPath) {
          checkpointInfo.checkpointPath = checkpointPath;
          opts.onCheckpointArchived?.(checkpointPath, checkpointInfo);
        }

        const baseDetails =
          result.details && typeof result.details === 'object'
            ? (result.details as Record<string, unknown>)
            : {};

        return {
          compaction: {
            summary: finalSummary,
            firstKeptEntryId: result.firstKeptEntryId,
            tokensBefore: effectiveTokensBefore,
            usage: result.usage,
            details: {
              ...baseDetails,
              role: opts.role,
              reason: event.reason,
              tokensAfter: estimatedTokensAfter,
              ...(focus ? { focus } : {}),
              ...(checkpointPath ? { checkpointPath } : {}),
              ...(prunedCount > 0 ? { prunedCount } : {}),
            },
          },
        };
      });
    },
  };
}
