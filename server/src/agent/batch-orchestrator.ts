import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CLOUD_CONCURRENCY,
  DEFAULT_POST_QA_CHUNK_LINES,
  MAX_CLOUD_CONCURRENCY,
  readManifest,
} from '../vn/classify.js';
import { checkinVnBatch, mergeVnBatches, runVnCheckpoint } from '../vn/core.js';
import {
  WORKSPACE_BATCHES_MANIFEST_REL,
  WORKSPACE_POST_QA_REPORT_REL,
  WORKSPACE_POST_QA_STATE_REL,
  resolveWorkspacePaths,
} from '../vn/workspace-paths.js';
import {
  loadProfile,
  loadProfileMemory,
  loadWorkspaceTranslatorOverride,
  parseTomlSections,
  pickTomlString,
  resolveHomeDir,
  resolveWorkspaceControlPattern,
  type CharacterRosterEntry,
  type LocalizationProfile,
  type LocalMtPreset,
  type ProjectMemory,
  type TranslatorMode,
} from '../vn/profile.js';
import { qaReport } from '../vn/qa.js';
import {
  checkCharacterConfirmationGate,
  formatCharacterRosterForPrompt,
} from '../vn/roster.js';
import { checkPreTranslateSmokeGate } from '../vn/smoke.js';
import {
  buildTranslationUnits,
  cleanLocalModelOutput,
  computeBatchRouteStats,
  partitionIntoPackets,
  reassembleUnit,
  TranslationMemoryCache,
  type BatchRouteStats,
  type TranslationContextPair,
  type TranslationUnit,
} from '../vn/translation-packet.js';
import { isRestrictedSecretPath, redactSecrets } from '../security/secrets.js';
import {
  DEFAULT_LOCAL_TRANSLATOR_CONFIG,
  LocalTranslatorClient,
  LocalTranslatorEndpointError,
  mergeTranslatorConfig,
  type LocalTranslatorConfig,
  type LocalUsageDelta,
} from './local-translator.js';
import {
  classifySubagentError,
  type ManagedSubagentSession,
  type SubagentInterruptKind,
  type SubagentManager,
  type SubagentTaskUpdatedListener,
  type SubagentUsageStats,
} from '../subagents/subagent-manager.js';

export interface BatchManifestEntry {
  batch_id: string;
  file: string;
  track: string;
  rows: number;
  chars?: number;
  estimated_source_tokens: number;
  estimated_tokens_with_margin: number;
  files?: string[];
  scenes?: string[];
  ids?: string[];
}

export interface BatchProgressEvent {
  type: 'plan' | 'checkin' | 'checkpoint' | 'post_qa' | 'writeback';
  batchId?: string;
  completed?: number;
  total?: number;
  status?: string;
  commit?: string;
  summary?: string;
  timestamp: string;
}

export interface TranslateBatchesParams {
  batchIds?: string[];
  startBatch?: string;
  endBatch?: string;
  track?: string;
  includeFailed?: boolean;
  force?: boolean;
  concurrency?: number;
  sessionMaxSourceTokens?: number;
  glossary?: string;
  personaSummary?: string;
  contextSummary?: string;
  checkpointInterval?: number;
  mode?: TranslatorMode;
  escalateFailedRows?: boolean;
  packetLines?: number;
  preset?: LocalMtPreset;
  allowUnconfirmedCharacters?: boolean;
  allowSkipPreTranslateSmoke?: boolean;
}

export interface TranslateBatchesSummary {
  ok: boolean;
  mode: TranslatorMode;
  translatorModel?: string;
  totalTargeted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  remainingPending?: number;
  sessionsOpened: number;
  sessionRotations: number;
  sessionMaxSourceTokens: number;
  concurrency: number;
  totalSourceTokens: number;
  durationMs: number;
  usage: SubagentUsageStats;
  cloudUsage?: SubagentUsageStats;
  localUsage?: SubagentUsageStats & { estimated?: boolean };
  routeStats?: {
    tmCache: number;
    localMt: number;
    cloudEscalated: number;
    cloudSubagent: number;
    qaFailed: number;
  };
  escalationWarning?: string;
  contentBlockedHint?: string;
  succeededBatchIds: string[];
  failedBatches: Array<{ batchId: string; error: string; errorKind?: SubagentInterruptKind }>;
  checkpointCommit?: string;
  checkpointWarning?: string;
  subagentTaskIds?: string[];
  interrupted?: boolean;
  interruptKind?: SubagentInterruptKind;
  interruptReason?: string;
  resumable?: boolean;
}

export interface PostQaParallelParams {
  track?: string;
  concurrency?: number;
  batchMaxLines?: number;
  skipRoleChecker?: boolean;
}

export interface PostQaParallelSummary {
  ok: boolean;
  deterministicPassed: number;
  deterministicFailed: number;
  affectedBatchIds: string[];
  sampleDeterministicIssues: Array<{
    batchId: string;
    track: string;
    id: string;
    source: string;
    target: string;
    findings: unknown[];
  }>;
  roleCheckerChunksReviewed: number;
  roleCheckerChunksTotal?: number;
  roleCheckerReusedChunks?: number;
  roleCheckerPendingChunks?: number;
  roleCheckerErrors: number;
  roleCheckerSkipped?: boolean;
  semanticQaComplete?: boolean;
  semanticFindings: Array<{
    track: string;
    chunkIndex: number;
    batchIds: string[];
    summary: string;
  }>;
  reportPath: string;
  statePath?: string;
  durationMs: number;
  usage: SubagentUsageStats;
  subagentTaskIds?: string[];
  interrupted?: boolean;
  interruptKind?: SubagentInterruptKind;
  interruptReason?: string;
  resumable?: boolean;
}

export interface BatchOrchestratorDeps {
  cwd: string;
  subagentManager: SubagentManager;
  model?: any;
  modelRuntime?: any;
  signal?: AbortSignal;
  sessionId?: string | null;
  parentCallId?: string;
  recordDiagnostics?: boolean;
  getKnownSecrets?: () => Iterable<string>;
  onDelta?: (role: string, delta: string) => void;
  onBatchProgress?: (event: BatchProgressEvent) => void;
  onTaskUpdated?: SubagentTaskUpdatedListener;
  translatorConfig?: LocalTranslatorConfig;
  localFetch?: typeof fetch;
  onLocalUsage?: (delta: LocalUsageDelta) => void;
  ensureLocalEndpointReady?: (cfg: LocalTranslatorConfig) => Promise<void>;
}

interface LocalizationContext {
  rulesText: string;
  glossaryText: string;
  personaText: string;
  characterRosterText: string;
  characters: CharacterRosterEntry[];
  glossaryMap: Record<string, string>;
}

const MAX_CONTEXT_CHARS = 8000;
const TAIL_PAIR_LIMIT = 3;

function emptyUsage(): SubagentUsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

interface PersistedPostQaChunkRecord {
  track: string;
  chunkIndex: number;
  batchIds: string[];
  contentHash: string;
  status?: 'ok';
  summary: string;
  taskId?: string;
  updatedAt: string;
}

interface PostQaStateFile {
  version: 1;
  locHash: string;
  chunks: Record<string, PersistedPostQaChunkRecord>;
  updatedAt: string;
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function mergePoolSignals(a?: AbortSignal, b?: AbortSignal): { signal?: AbortSignal; cleanup: () => void } {
  if (!a && !b) return { signal: undefined, cleanup: () => {} };
  if (a && !b) return { signal: a, cleanup: () => {} };
  if (!a && b) return { signal: b, cleanup: () => {} };
  const ctrl = new AbortController();
  const forward = (src: AbortSignal) => {
    if (!ctrl.signal.aborted) {
      ctrl.abort((src as any).reason);
    }
  };
  if (a!.aborted) {
    forward(a!);
    return { signal: ctrl.signal, cleanup: () => {} };
  }
  if (b!.aborted) {
    forward(b!);
    return { signal: ctrl.signal, cleanup: () => {} };
  }
  const onA = () => forward(a!);
  const onB = () => forward(b!);
  a!.addEventListener('abort', onA, { once: true });
  b!.addEventListener('abort', onB, { once: true });
  return {
    signal: ctrl.signal,
    cleanup: () => {
      a!.removeEventListener('abort', onA);
      b!.removeEventListener('abort', onB);
    },
  };
}

function createPoolInterruptTracker(externalSignal?: AbortSignal) {
  const internalAbort = new AbortController();
  const merged = mergePoolSignals(externalSignal, internalAbort.signal);
  let interrupt: { kind: SubagentInterruptKind; reason: string } | null = null;
  const trigger = (kind: SubagentInterruptKind, reason: string) => {
    if (!interrupt) {
      interrupt = { kind, reason };
    }
    if (!internalAbort.signal.aborted) {
      internalAbort.abort(reason);
    }
  };
  return {
    signal: merged.signal,
    cleanup: merged.cleanup,
    isAborted: () => Boolean(externalSignal?.aborted || internalAbort.signal.aborted),
    getInterrupt: () => interrupt,
    trigger,
  };
}

function addUsage(acc: SubagentUsageStats, delta?: SubagentUsageStats): void {
  if (!delta) return;
  acc.input += delta.input || 0;
  acc.output += delta.output || 0;
  acc.cacheRead += delta.cacheRead || 0;
  acc.cacheWrite += delta.cacheWrite || 0;
  acc.totalTokens += delta.totalTokens || 0;
  if (typeof delta.reasoningTokens === 'number') {
    acc.reasoningTokens = (acc.reasoningTokens ?? 0) + delta.reasoningTokens;
  }
}

function resolveInsideWorkspace(cwd: string, relPath: string): string | null {
  if (!relPath || isRestrictedSecretPath(relPath, cwd)) return null;
  const base = path.resolve(cwd);
  const resolved = path.resolve(base, relPath);
  const cmpBase = process.platform === 'win32' ? base.toLowerCase() : base;
  const cmpResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const sep = process.platform === 'win32' ? '\\' : path.sep;
  if (cmpResolved !== cmpBase && !cmpResolved.startsWith(`${cmpBase}${sep}`)) {
    return null;
  }
  try {
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  return resolved;
}

function readJsonFileSafe<T = any>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseLocalizationToml(tomlText: string): Record<string, string> {
  const section = parseTomlSections(tomlText)['vn.localization'] || {};
  const result: Record<string, string> = {};
  for (const key of [
    'source_lang',
    'target_lang',
    'narrative_pov',
    'player_address',
    'mixed_rules',
    'glossary_file',
    'persona_file',
  ]) {
    const val = pickTomlString(section, key);
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

function readBoundedContextFile(cwd: string, relPath?: string): string {
  if (!relPath) return '';
  const abs = resolveInsideWorkspace(cwd, relPath.trim());
  if (!abs || !fs.existsSync(abs)) return '';
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return '';
    const content = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').trim();
    if (content.length <= MAX_CONTEXT_CHARS) return content;
    return `${content.slice(0, MAX_CONTEXT_CHARS)}\n...(truncated)`;
  } catch {
    return '';
  }
}

function formatGlossaryMapForPrompt(
  glossary: Record<string, string>,
  options?: { activeText?: string; activeSpeakers?: Iterable<string> }
): string {
  const entries = Object.entries(glossary).filter(([k, v]) => k.trim() && v.trim());
  if (!entries.length) return '';
  const full = entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} => ${v}`)
    .join('\n');
  if (full.length <= MAX_CONTEXT_CHARS || (!options?.activeText && !options?.activeSpeakers)) {
    return full;
  }
  const speakerSet = new Set<string>();
  if (options?.activeSpeakers) {
    for (const s of options.activeSpeakers) {
      if (s.trim()) speakerSet.add(s.trim());
    }
  }
  const activeText = options?.activeText || '';
  const matched = entries.filter(([k]) => speakerSet.has(k) || (activeText && activeText.includes(k)));
  if (!matched.length) return '';
  return matched
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} => ${v}`)
    .join('\n');
}

function loadLocalizationContext(
  cwd: string,
  glossaryOverride?: string,
  personaOverride?: string
): LocalizationContext {
  const safe = loadSafeLocalization(cwd, glossaryOverride);
  const loadedProfile = loadProfile(cwd).profile;
  const parsed = loadedProfile
    ? {
        source_lang: loadedProfile.sourceLang,
        target_lang: loadedProfile.targetLang,
        narrative_pov: loadedProfile.narrativePov,
        player_address: loadedProfile.playerAddress,
        mixed_rules: loadedProfile.mixedRules,
        glossary_file: loadedProfile.glossaryFile,
        persona_file: loadedProfile.personaFile,
      }
    : (() => {
        const tomlPath = path.join(cwd, 'papercup.toml');
        if (fs.existsSync(tomlPath) && !fs.lstatSync(tomlPath).isSymbolicLink()) {
          try {
            return parseLocalizationToml(fs.readFileSync(tomlPath, 'utf8'));
          } catch {
            return {} as Record<string, string>;
          }
        }
        return {} as Record<string, string>;
      })();

  const rulePairs = [
    parsed.source_lang && parsed.target_lang ? `language=${parsed.source_lang}->${parsed.target_lang}` : '',
    parsed.narrative_pov ? `narrative_pov=${parsed.narrative_pov}` : '',
    parsed.player_address ? `player_address=${parsed.player_address}` : '',
    parsed.mixed_rules ? `mixed_rules=${parsed.mixed_rules}` : '',
  ].filter(Boolean);

  const characters = safe.memory.characters ?? [];
  const characterRosterText = formatCharacterRosterForPrompt(characters);

  const glossaryText =
    glossaryOverride !== undefined
      ? glossaryOverride.trim()
      : formatGlossaryMapForPrompt(safe.memory.glossary) ||
        readBoundedContextFile(cwd, parsed.glossary_file);
  const personaText =
    personaOverride !== undefined
      ? personaOverride.trim()
      : readBoundedContextFile(cwd, parsed.persona_file) ||
        (Object.keys(safe.memory.persona).length > 0
          ? JSON.stringify(safe.memory.persona, null, 2).slice(0, MAX_CONTEXT_CHARS)
          : '');

  return {
    rulesText: rulePairs.join('; '),
    glossaryText,
    personaText,
    characterRosterText,
    characters,
    glossaryMap: safe.memory.glossary,
  };
}

function readJsonlRecords(absPath: string): Array<Record<string, any>> {
  const raw = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
  const rows: Array<Record<string, any>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

function buildCompactBatchInputJsonl(rows: Array<Record<string, any>>): string {
  return rows
    .map((row) => {
      const compact: Record<string, unknown> = {
        id: row.id ?? `${row.file || ''}#${row.line || ''}`,
      };
      if (row.speaker) compact.speaker = row.speaker;
      if (row.scene) compact.scene = row.scene;
      compact.source = row.source ?? '';
      return JSON.stringify(compact);
    })
    .join('\n');
}

function selectTargetBatches(
  allBatches: BatchManifestEntry[],
  progressBatches: Record<string, any>,
  cwd: string,
  params: TranslateBatchesParams
): { targeted: BatchManifestEntry[]; skipped: number } {
  const trackFilter = params.track?.trim();
  const explicitSet = params.batchIds?.length ? new Set(params.batchIds.map((b) => b.trim()).filter(Boolean)) : null;

  const wsPaths = resolveWorkspacePaths(cwd);
  let startIdx = 0;
  let endIdx = allBatches.length - 1;
  if (params.startBatch?.trim()) {
    const found = allBatches.findIndex((b) => b.batch_id === params.startBatch!.trim());
    if (found < 0) throw new Error(`startBatch '${params.startBatch}' not found in ${WORKSPACE_BATCHES_MANIFEST_REL}.`);
    startIdx = found;
  }
  if (params.endBatch?.trim()) {
    const found = allBatches.findIndex((b) => b.batch_id === params.endBatch!.trim());
    if (found < 0) throw new Error(`endBatch '${params.endBatch}' not found in ${WORKSPACE_BATCHES_MANIFEST_REL}.`);
    endIdx = found;
  }
  if (endIdx < startIdx) {
    throw new Error(`Invalid batch range: endBatch '${params.endBatch}' appears before startBatch '${params.startBatch}'.`);
  }

  const targeted: BatchManifestEntry[] = [];
  let skipped = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const entry = allBatches[i];
    if (explicitSet && !explicitSet.has(entry.batch_id)) continue;
    if (trackFilter && entry.track !== trackFilter) continue;

    if (!params.force) {
      const outPath = wsPaths.batchOutFile(entry.batch_id);
      const progEntry = progressBatches[entry.batch_id];
      const hasFile = fs.existsSync(outPath);
      const status = String(progEntry?.status || '');
      if (hasFile && (status === 'saved_pending_qa' || status === 'qa_passed' || (!params.includeFailed && status === 'qa_failed'))) {
        skipped++;
        continue;
      }
    }
    targeted.push(entry);
  }

  if (explicitSet) {
    const knownIds = new Set(allBatches.map((b) => b.batch_id));
    for (const wanted of explicitSet) {
      if (!knownIds.has(wanted)) {
        throw new Error(`Requested batchId '${wanted}' does not exist in ${WORKSPACE_BATCHES_MANIFEST_REL}.`);
      }
    }
  }

  return { targeted, skipped };
}

function buildTranslatorPrompt(
  entry: BatchManifestEntry,
  compactJsonl: string,
  loc: LocalizationContext,
  includeFullPreamble: boolean,
  tailPairs: Array<{ speaker?: string; source: string; target: string }>,
  contextSummary?: string,
  retryError?: string,
  sourceRows?: Array<Record<string, any>>
): string {
  const parts: string[] = [];
  const activeSpeakers = sourceRows
    ? sourceRows.map((r) => String(r.speaker ?? '').trim()).filter(Boolean)
    : undefined;
  const activeText = sourceRows
    ? sourceRows.map((r) => String(r.source ?? '')).join('\n')
    : compactJsonl;
  const batchRosterText = loc.characters.length
    ? formatCharacterRosterForPrompt(loc.characters, { activeSpeakers, activeText })
    : loc.characterRosterText;
  const isLargeGlossary = loc.glossaryText.length > MAX_CONTEXT_CHARS && Object.keys(loc.glossaryMap).length > 0;
  const batchGlossaryText = isLargeGlossary
    ? formatGlossaryMapForPrompt(loc.glossaryMap, { activeSpeakers, activeText })
    : loc.glossaryText;

  if (includeFullPreamble) {
    if (loc.rulesText) parts.push(`<localization_rules>\n${loc.rulesText}\n</localization_rules>`);
    if (batchRosterText) parts.push(`<character_roster>\n${batchRosterText}\n</character_roster>`);
    if (batchGlossaryText) parts.push(`<glossary>\n${batchGlossaryText}\n</glossary>`);
    if (loc.personaText) parts.push(`<persona>\n${loc.personaText}\n</persona>`);
    if (contextSummary?.trim()) parts.push(`<context>\n${contextSummary.trim()}\n</context>`);
  } else {
    if (loc.characters.length > 80 && batchRosterText) {
      parts.push(`<character_roster>\n${batchRosterText}\n</character_roster>`);
    }
    if (isLargeGlossary && batchGlossaryText) {
      parts.push(`<glossary>\n${batchGlossaryText}\n</glossary>`);
    }
  }
  if (tailPairs.length > 0) {
    const tailText = tailPairs
      .map((p) => `${p.speaker ? `[${p.speaker}] ` : ''}${p.source} => ${p.target}`)
      .join('\n');
    parts.push(`<adjacent_context>\n${tailText}\n</adjacent_context>`);
  }
  if (retryError) {
    parts.push(
      `<retry_notice>\nPrevious output failed validation: ${retryError}\nReturn STRICT JSONL only, one {"id":...,"target":...} object per line in the exact same ID count and order, no empty targets, no raw newlines inside strings.\n</retry_notice>`
    );
  }
  parts.push(
    `Translate batch ${entry.batch_id} (track=${entry.track}, rows=${entry.rows}). Output ONLY JSONL lines with "id" and "target":\n<batch id="${entry.batch_id}" track="${entry.track}" rows="${entry.rows}">\n${compactJsonl}\n</batch>`
  );
  return parts.join('\n\n');
}

function loadSafeLocalization(
  cwd: string,
  glossaryOverride?: string
): { profile: LocalizationProfile; memory: ProjectMemory } {
  const homeDir = resolveHomeDir();
  const loaded = loadProfile(cwd);
  const profile: LocalizationProfile = loaded.profile ?? {
    narrativePov: 'third',
    playerAddress: '',
    mixedRules: '',
    sourceLang: 'ja',
    targetLang: 'zh',
    maxLenRatio: 0,
    maxLenAbs: 0,
    requireGlossary: false,
    residueCheck: true,
    glossaryFile: '',
    personaFile: '',
  };
  let memory: ProjectMemory = { glossary: {}, persona: {}, lessons: [], personaErrors: [] };
  try {
    memory = loadProfileMemory(cwd, homeDir, profile);
  } catch {
    // Keep empty memory when optional glossary/persona files are unreadable
  }
  if (glossaryOverride?.trim()) {
    try {
      const parsed = JSON.parse(glossaryOverride);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && k.trim() && v.trim()) {
            memory.glossary[k.trim()] = v.trim();
          }
        }
      }
    } catch {
      // Non-JSON override is still injected via prompt text when escalating
    }
  }
  return { profile, memory };
}

function stripJsonlFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const lines = trimmed.split(/\r?\n/);
    if (lines.length >= 2 && lines[lines.length - 1].trim().startsWith('```')) {
      return lines.slice(1, -1).join('\n');
    }
  }
  return trimmed;
}

function parseCloudRepairMap(rawText: string): Map<string, string> {
  const map = new Map<string, string>();
  const cleaned = stripJsonlFences(rawText);
  for (const line of cleaned.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && obj.id !== undefined && typeof obj.target === 'string') {
        const tgt = obj.target.replace(/\s*[\r\n]+\s*/g, ' ').trim();
        if (tgt) map.set(String(obj.id), tgt);
      }
    } catch {
      // Ignore unparseable line in partial repair output
    }
  }
  return map;
}

function buildRowEscalationPrompt(
  entry: BatchManifestEntry,
  units: TranslationUnit[],
  failedUnits: TranslationUnit[],
  loc: LocalizationContext,
  contextSummary?: string
): string {
  const failedSet = new Set(failedUnits.map((u) => u.id));
  const contextRows: string[] = [];
  for (let i = 0; i < units.length; i++) {
    if (!failedSet.has(units[i].id)) continue;
    for (const neighborIdx of [i - 2, i - 1, i + 1, i + 2]) {
      if (neighborIdx < 0 || neighborIdx >= units.length) continue;
      const nb = units[neighborIdx];
      if (failedSet.has(nb.id) || !nb.finalTarget?.trim()) continue;
      contextRows.push(`${nb.speaker ? `[${nb.speaker}] ` : ''}${nb.originalSource} => ${nb.finalTarget}`);
    }
  }
  const uniqueContextRows = Array.from(new Set(contextRows)).slice(0, 12);

  const compactFailedJsonl = failedUnits
    .map((u) =>
      JSON.stringify({
        id: u.id,
        ...(u.speaker ? { speaker: u.speaker } : {}),
        ...(u.scene ? { scene: u.scene } : {}),
        source: u.originalSource,
        previous_target: u.finalTarget || '',
        qa_errors: (u.qaFindings || []).map((f) => `[${f.rule}] ${f.message}`),
      })
    )
    .join('\n');

  const parts: string[] = [];
  if (loc.rulesText) parts.push(`<localization_rules>\n${loc.rulesText}\n</localization_rules>`);
  const escRoster = loc.characters.length
    ? formatCharacterRosterForPrompt(loc.characters, {
        activeSpeakers: failedUnits.map((u) => u.speaker).filter(Boolean),
        activeText: failedUnits.map((u) => u.originalSource).join('\n'),
      })
    : loc.characterRosterText;
  if (escRoster) parts.push(`<character_roster>\n${escRoster}\n</character_roster>`);
  if (loc.glossaryText) parts.push(`<glossary>\n${loc.glossaryText}\n</glossary>`);
  if (loc.personaText) parts.push(`<persona>\n${loc.personaText}\n</persona>`);
  if (contextSummary?.trim()) parts.push(`<context>\n${contextSummary.trim()}\n</context>`);
  if (uniqueContextRows.length > 0) {
    parts.push(`<adjacent_context>\n${uniqueContextRows.join('\n')}\n</adjacent_context>`);
  }
  parts.push(
    `Repair ONLY the ${failedUnits.length} failed lines from batch ${entry.batch_id} (track=${entry.track}). Preserve all control tags and glossary terms verbatim. Output ONLY JSONL lines with "id" and "target":\n<batch id="${entry.batch_id}" track="${entry.track}" rows="${failedUnits.length}">\n${compactFailedJsonl}\n</batch>`
  );
  return parts.join('\n\n');
}

export async function runTranslateBatches(
  deps: BatchOrchestratorDeps,
  params: TranslateBatchesParams = {}
): Promise<TranslateBatchesSummary> {
  const startedAt = Date.now();
  const { cwd, subagentManager } = deps;

  const wsPaths = resolveWorkspacePaths(cwd);
  const manifest = readJsonFileSafe<{ batches?: BatchManifestEntry[] }>(
    wsPaths.batchesManifestFile
  );
  if (!manifest || !Array.isArray(manifest.batches) || manifest.batches.length === 0) {
    throw new Error(`${WORKSPACE_BATCHES_MANIFEST_REL} missing or empty. Run vn_plan with generateBatches=true first.`);
  }

  const gate = checkCharacterConfirmationGate(cwd, {
    allowUnconfirmedCharacters: params.allowUnconfirmedCharacters,
  });
  if (!gate.allowed) {
    throw new Error(gate.reason || '翻译前角色译名尚未确认锁定，请先发送并提交角色译名确认表单。');
  }

  const preSmokeGate = checkPreTranslateSmokeGate(cwd, {
    homeDir: resolveHomeDir(),
    allowSkipPreTranslateSmoke: params.allowSkipPreTranslateSmoke,
  });
  if (!preSmokeGate.allowed) {
    throw new Error(
      preSmokeGate.reason ||
        '自定义技能在全量批译前必须先通过 vn_smoke_test(preTranslateProbe=true) 单条微改冒烟测试。'
    );
  }

  const planData = readJsonFileSafe<{ config?: Record<string, any> }>(wsPaths.planFile);
  const planConfig = planData?.config ?? {};
  const progressData = readJsonFileSafe<{ batches?: Record<string, any> }>(wsPaths.progressFile);
  const progressBatches = progressData?.batches ?? {};

  const wsOverride = loadWorkspaceTranslatorOverride(cwd);
  const effectiveTranslatorConfig = mergeTranslatorConfig(
    deps.translatorConfig ?? DEFAULT_LOCAL_TRANSLATOR_CONFIG,
    wsOverride,
    {
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.escalateFailedRows !== undefined ? { escalateFailedRows: params.escalateFailedRows } : {}),
      ...(params.packetLines !== undefined ? { packetLines: params.packetLines } : {}),
      ...(params.preset !== undefined ? { preset: params.preset } : {}),
    }
  );
  const activeMode: TranslatorMode = effectiveTranslatorConfig.mode;

  const sessionMaxSourceTokens = Math.max(
    100,
    Math.floor(params.sessionMaxSourceTokens ?? Number(planConfig.session_max_source_tokens || 24000))
  );
  const rawPlanConcurrency = Number(planConfig.concurrency);
  const fallbackCloudConcurrency =
    Number.isFinite(rawPlanConcurrency) && rawPlanConcurrency > 0
      ? rawPlanConcurrency
      : DEFAULT_CLOUD_CONCURRENCY;
  const concurrency =
    activeMode === 'local_mt'
      ? Math.max(1, Math.min(8, Math.floor(params.concurrency ?? effectiveTranslatorConfig.concurrency)))
      : Math.max(
          1,
          Math.min(MAX_CLOUD_CONCURRENCY, Math.floor(params.concurrency ?? fallbackCloudConcurrency))
        );
  const checkpointInterval = params.checkpointInterval === undefined ? 10 : Math.max(0, Math.floor(params.checkpointInterval));

  const { targeted, skipped } = selectTargetBatches(manifest.batches, progressBatches, cwd, params);

  if (activeMode === 'cloud_subagent') {
    for (const batch of targeted) {
      const cost = Math.max(1, Number(batch.estimated_tokens_with_margin || batch.estimated_source_tokens || 1));
      if (cost > sessionMaxSourceTokens) {
        throw new Error(
          `Batch ${batch.batch_id} requires ${cost} estimated tokens (with margin), exceeding sessionMaxSourceTokens (${sessionMaxSourceTokens}). Run vn_plan to split smaller batches or raise sessionMaxSourceTokens.`
        );
      }
    }
  }

  const usage = emptyUsage();
  const cloudUsage = emptyUsage();
  const localUsage: SubagentUsageStats & { estimated?: boolean } = emptyUsage();
  const modelKey = deps.model?.provider && deps.model?.id ? `${deps.model.provider}/${deps.model.id}` : '';
  const translatorModelLabel =
    activeMode === 'local_mt' ? effectiveTranslatorConfig.model || '' : modelKey || undefined;
  const summaryRouteStats = {
    tmCache: 0,
    localMt: 0,
    cloudEscalated: 0,
    cloudSubagent: 0,
    qaFailed: 0,
  };
  const totalTargeted = targeted.length;
  if (totalTargeted === 0) {
    return {
      ok: true,
      mode: activeMode,
      ...(translatorModelLabel ? { translatorModel: translatorModelLabel } : {}),
      totalTargeted: 0,
      succeeded: 0,
      failed: 0,
      skipped,
      sessionsOpened: 0,
      sessionRotations: 0,
      sessionMaxSourceTokens,
      concurrency,
      totalSourceTokens: 0,
      durationMs: Date.now() - startedAt,
      usage,
      cloudUsage,
      localUsage,
      routeStats: summaryRouteStats,
      succeededBatchIds: [],
      failedBatches: [],
    };
  }

  if (activeMode === 'local_mt') {
    if (!effectiveTranslatorConfig.baseUrl) {
      throw new LocalTranslatorEndpointError('本地翻译模式已启用，但未配置本地模型端点 URL（baseUrl）。');
    }
    if (!effectiveTranslatorConfig.model) {
      throw new LocalTranslatorEndpointError('本地翻译模式已启用，但未选择本地翻译模型名称（model）。');
    }
    await deps.ensureLocalEndpointReady?.(effectiveTranslatorConfig);
  }

  const loc = loadLocalizationContext(cwd, params.glossary, params.personaSummary);
  let nextIndex = 0;
  let sessionsOpened = 0;
  let sessionRotations = 0;
  let totalSourceTokens = 0;
  const succeededBatchIds: string[] = [];
  const failedBatches: Array<{ batchId: string; error: string; errorKind?: SubagentInterruptKind }> = [];
  const subagentTaskIds: string[] = [];
  let checkpointCommit: string | undefined;
  let checkpointWarning: string | undefined;
  let escalationWarning: string | undefined;
  let cloudEscalationDisabled = false;
  let lastCheckpointAtCount = 0;
  let gitLock = Promise.resolve();
  const poolTracker = createPoolInterruptTracker(deps.signal);

  const maybeCreateCheckpoint = async (stageLabel: string) => {
    gitLock = gitLock.then(async () => {
      try {
        const cpRes = await runVnCheckpoint(cwd, {
          action: 'save',
          stage: 'batch',
          summary: stageLabel,
        });
        if (cpRes.commit) checkpointCommit = String(cpRes.commit);
        deps.onBatchProgress?.({
          type: 'checkpoint',
          commit: checkpointCommit,
          summary: stageLabel,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        checkpointWarning = String(err?.message || err);
      }
    });
    await gitLock;
  };

  const laneCount = Math.min(concurrency, totalTargeted);

  if (activeMode === 'local_mt') {
    const safeLoc = loadSafeLocalization(cwd, params.glossary);
    const manifestEngine = String(readManifest(cwd)?.engine || '');
    const controlPattern =
      resolveWorkspaceControlPattern(cwd, resolveHomeDir(), manifestEngine || undefined) || '';

    const tmCache = effectiveTranslatorConfig.useTmCache ? new TranslationMemoryCache() : null;
    if (tmCache) {
      tmCache.seedFromWorkspaceOutDir(cwd, safeLoc.profile, safeLoc.memory.glossary, controlPattern);
    }

    const escalateUnits = async (
      entry: BatchManifestEntry,
      units: TranslationUnit[],
      failedUnits: TranslationUnit[]
    ): Promise<void> => {
      if (cloudEscalationDisabled || failedUnits.length === 0 || poolTracker.isAborted()) return;
      if (!deps.model && !deps.modelRuntime) {
        escalationWarning =
          escalationWarning || '未配置云端主模型，无法执行失败行云端升舱修复（已保留本地译文）。';
        return;
      }

      const repairPrompt = buildRowEscalationPrompt(
        entry,
        units,
        failedUnits,
        loc,
        params.contextSummary
      );
      try {
        const res = await subagentManager.runSubagentWithMetrics('translator', repairPrompt, {
          cwd,
          model: deps.model,
          modelRuntime: deps.modelRuntime,
          signal: poolTracker.signal,
          sessionId: deps.sessionId,
          parentCallId: deps.parentCallId,
          recordDiagnostics: deps.recordDiagnostics,
          getKnownSecrets: deps.getKnownSecrets,
          onDelta: (d) => deps.onDelta?.('translator', d),
          onTaskUpdated: deps.onTaskUpdated,
          usageKind: 'subagent:cloud_escalation',
        });
        subagentTaskIds.push(res.taskId);
        addUsage(usage, res.metrics.usage);
        addUsage(cloudUsage, res.metrics.usage);
        const repairMap = parseCloudRepairMap(res.text);
        for (const failedUnit of failedUnits) {
          const repaired = repairMap.get(failedUnit.id);
          if (!repaired) continue;
          const rep = qaReport(
            failedUnit.originalSource,
            repaired,
            safeLoc.profile,
            safeLoc.memory.glossary,
            { controlPattern }
          );
          failedUnit.route = 'cloud_escalated';
          failedUnit.finalTarget = repaired;
          failedUnit.qaOk = !rep.blocked;
          failedUnit.qaFindings = rep.findings;
        }
      } catch (err: any) {
        if (err?.taskId) subagentTaskIds.push(String(err.taskId));
        addUsage(usage, err?.metrics?.usage);
        addUsage(cloudUsage, err?.metrics?.usage);
        const safeErr = redactSecrets(String(err?.message || err), deps.getKnownSecrets?.());
        const cls = classifySubagentError(
          safeErr,
          Boolean(deps.signal?.aborted || poolTracker.isAborted() || err?.metrics?.status === 'aborted')
        );
        if (deps.signal?.aborted) {
          poolTracker.trigger('aborted', safeErr || 'Batch translation aborted.');
          return;
        }
        if (poolTracker.isAborted()) {
          return;
        }
        if (cls.fatalForPool) {
          cloudEscalationDisabled = true;
        }
        escalationWarning = `云端升舱修复不可用（${safeErr}），已降级保留本地译文。`;
      }
    };

    const runLocalLane = async () => {
      const localClient = new LocalTranslatorClient(
        effectiveTranslatorConfig,
        deps.localFetch,
        deps.onLocalUsage
      );
      let tailContext: TranslationContextPair[] = [];

      while (true) {
        if (deps.signal?.aborted) {
          poolTracker.trigger('aborted', 'Batch translation aborted.');
          break;
        }
        if (poolTracker.isAborted()) break;
        const currentIdx = nextIndex++;
        if (currentIdx >= targeted.length) break;
        const entry = targeted[currentIdx];

        const absBatchFile = resolveInsideWorkspace(cwd, entry.file);
        if (!absBatchFile || !fs.existsSync(absBatchFile)) {
          failedBatches.push({ batchId: entry.batch_id, error: `Missing batch source file: ${entry.file}` });
          continue;
        }

        const sourceRows = readJsonlRecords(absBatchFile);
        const track: 'scenario' | 'ui' = entry.track === 'ui' ? 'ui' : 'scenario';
        const units = buildTranslationUnits(sourceRows, track, {
          profile: safeLoc.profile,
          glossary: safeLoc.memory.glossary,
          controlPattern,
          tmCache,
        });

        const pendingIndices: number[] = [];
        const pendingUnits: TranslationUnit[] = [];
        const deferredDupIndices: number[] = [];
        const seenBatchTmKeys = new Set<string>();
        for (let i = 0; i < units.length; i++) {
          if (units[i].route !== 'pending') continue;
          const tmKey = tmCache ? tmCache.getKey(units[i]) : null;
          if (tmKey && seenBatchTmKeys.has(tmKey)) {
            deferredDupIndices.push(i);
            continue;
          }
          if (tmKey) seenBatchTmKeys.add(tmKey);
          pendingIndices.push(i);
          pendingUnits.push(units[i]);
        }

        const translatePendingGroup = async (
          targetIndices: number[],
          targetUnits: TranslationUnit[]
        ): Promise<string | null> => {
          if (targetUnits.length === 0) return null;
          const packets = partitionIntoPackets(
            targetUnits,
            entry.batch_id,
            track,
            effectiveTranslatorConfig.packetLines,
            {
              profile: safeLoc.profile,
              glossary: safeLoc.memory.glossary,
              persona: safeLoc.memory.persona,
              characters: safeLoc.memory.characters,
              controlPattern,
              initialPrevContext: tailContext,
            }
          );

          let unitCursor = 0;
          const batchSlidingPairs: TranslationContextPair[] = [...tailContext];
          for (let pIdx = 0; pIdx < packets.length; pIdx++) {
            if (poolTracker.isAborted()) {
              return poolTracker.getInterrupt()?.reason || 'Batch translation aborted.';
            }
            const packet = packets[pIdx];
            packet.context.prevContext =
              effectiveTranslatorConfig.contextWindow > 0
                ? batchSlidingPairs.slice(-effectiveTranslatorConfig.contextWindow)
                : [];
            try {
              const localRes = await localClient.translatePacketWithBinarySplit(
                packet,
                poolTracker.signal
              );
              usage.input += localRes.usage.input;
              usage.output += localRes.usage.output;
              usage.totalTokens += localRes.usage.totalTokens;
              localUsage.input += localRes.usage.input;
              localUsage.output += localRes.usage.output;
              localUsage.totalTokens += localRes.usage.totalTokens;
              if (localRes.usage.estimated) {
                localUsage.estimated = true;
              }

              for (let k = 0; k < packet.units.length; k++) {
                const origIdx = targetIndices[unitCursor++];
                const rawTarget = localRes.targets[k] ?? '';
                const updated = reassembleUnit(
                  units[origIdx],
                  rawTarget,
                  safeLoc.profile,
                  safeLoc.memory.glossary,
                  { controlPattern }
                );
                units[origIdx] = updated;
                if (updated.qaOk && updated.finalTarget?.trim()) {
                  batchSlidingPairs.push({
                    ...(updated.speaker ? { speaker: updated.speaker } : {}),
                    source: updated.cleanSource,
                    target: cleanLocalModelOutput(rawTarget, updated) || updated.finalTarget,
                  });
                }
              }
            } catch (err: any) {
              const safeErr = redactSecrets(String(err?.message || err), [
                effectiveTranslatorConfig.apiKey,
                ...(deps.getKnownSecrets?.() ?? []),
              ]);
              if (deps.signal?.aborted) {
                poolTracker.trigger('aborted', safeErr || 'Batch translation aborted.');
              } else if (err instanceof LocalTranslatorEndpointError) {
                // Fail-fast: never silently fall back to full cloud translation
                poolTracker.trigger('error', safeErr);
              }
              return safeErr;
            }
          }
          return null;
        };

        const batchFailedError = await translatePendingGroup(pendingIndices, pendingUnits);

        if (batchFailedError) {
          failedBatches.push({ batchId: entry.batch_id, error: batchFailedError });
          if (poolTracker.getInterrupt()) break;
          continue;
        }

        const failedUnits = units.filter((u) => u.route === 'local_mt' && u.qaOk === false);
        if (effectiveTranslatorConfig.escalateFailedRows && failedUnits.length > 0) {
          await escalateUnits(entry, units, failedUnits);
          if (deps.signal?.aborted) {
            failedBatches.push({ batchId: entry.batch_id, error: 'Batch translation aborted.' });
            break;
          }
        }

        if (tmCache) {
          for (const unit of units) {
            if (unit.route === 'local_mt' || unit.route === 'cloud_escalated') {
              tmCache.remember(unit);
            }
          }
        }

        if (deferredDupIndices.length > 0) {
          const unresolvedIndices: number[] = [];
          const unresolvedUnits: TranslationUnit[] = [];
          for (const idx of deferredDupIndices) {
            const hit = tmCache
              ? tmCache.lookup(units[idx], safeLoc.profile, safeLoc.memory.glossary, controlPattern)
              : null;
            if (hit) {
              units[idx] = hit;
            } else {
              unresolvedIndices.push(idx);
              unresolvedUnits.push(units[idx]);
            }
          }
          if (unresolvedUnits.length > 0) {
            const dupErr = await translatePendingGroup(unresolvedIndices, unresolvedUnits);
            if (dupErr) {
              failedBatches.push({ batchId: entry.batch_id, error: dupErr });
              if (poolTracker.getInterrupt()) break;
              continue;
            }
            const dupFailedUnits = unresolvedIndices
              .map((idx) => units[idx])
              .filter((u) => u.route === 'local_mt' && u.qaOk === false);
            if (effectiveTranslatorConfig.escalateFailedRows && dupFailedUnits.length > 0) {
              await escalateUnits(entry, units, dupFailedUnits);
              if (deps.signal?.aborted || poolTracker.isAborted()) {
                failedBatches.push({
                  batchId: entry.batch_id,
                  error: poolTracker.getInterrupt()?.reason || 'Batch translation aborted.',
                });
                break;
              }
            }
            if (tmCache) {
              for (const idx of unresolvedIndices) {
                const unit = units[idx];
                if (unit.route === 'local_mt' || unit.route === 'cloud_escalated') {
                  tmCache.remember(unit);
                }
              }
            }
          }
        }

        const emptyUnit = units.find((u) => !(u.finalTarget || '').trim());
        if (emptyUnit) {
          failedBatches.push({
            batchId: entry.batch_id,
            error: `本地翻译在行 ${emptyUnit.id} 返回空译文且未能修复，跳过入库。`,
          });
          continue;
        }

        const batchStats: BatchRouteStats = computeBatchRouteStats(units, 'local_mt');
        try {
          checkinVnBatch(cwd, entry.batch_id, {
            entries: units.map((u) => ({ id: u.id, target: u.finalTarget! })),
            model: `local:${effectiveTranslatorConfig.model}`,
            sessionSeq: 0,
            mode: 'local_mt',
            routeStats: batchStats,
          });
          summaryRouteStats.tmCache += batchStats.tm_cache;
          summaryRouteStats.localMt += batchStats.local_mt;
          summaryRouteStats.cloudEscalated += batchStats.cloud_escalated;
          summaryRouteStats.cloudSubagent += batchStats.cloud_subagent;
          summaryRouteStats.qaFailed += batchStats.qa_failed;
          totalSourceTokens += Number(entry.estimated_source_tokens || 0);
          succeededBatchIds.push(entry.batch_id);

          if (effectiveTranslatorConfig.contextWindow > 0) {
            tailContext = units
              .filter((u) => Boolean(u.finalTarget?.trim()))
              .slice(-effectiveTranslatorConfig.contextWindow)
              .map((u) => ({
                ...(u.speaker ? { speaker: u.speaker } : {}),
                source: u.cleanSource,
                target: u.rawLocalTarget
                  ? cleanLocalModelOutput(u.rawLocalTarget, u) || u.finalTarget || ''
                  : u.finalTarget || '',
              }));
          }

          deps.onBatchProgress?.({
            type: 'checkin',
            batchId: entry.batch_id,
            completed: succeededBatchIds.length,
            total: totalTargeted,
            status: 'saved_pending_qa',
            timestamp: new Date().toISOString(),
          });

          if (checkpointInterval > 0 && succeededBatchIds.length - lastCheckpointAtCount >= checkpointInterval) {
            lastCheckpointAtCount = succeededBatchIds.length;
            await maybeCreateCheckpoint(`saved ${succeededBatchIds.length}/${totalTargeted} batches`);
          }
        } catch (err: any) {
          failedBatches.push({
            batchId: entry.batch_id,
            error: redactSecrets(String(err?.message || err), deps.getKnownSecrets?.()),
          });
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: laneCount }, () => runLocalLane()));
    } finally {
      poolTracker.cleanup();
    }

    if (checkpointInterval > 0 && succeededBatchIds.length > lastCheckpointAtCount) {
      await maybeCreateCheckpoint(`completed run: ${succeededBatchIds.length} batches saved (pending-qa)`);
    }

    const interruptInfo = poolTracker.getInterrupt();
    const interrupted = Boolean(interruptInfo || deps.signal?.aborted);
    const remainingPending = Math.max(0, totalTargeted - succeededBatchIds.length - failedBatches.length);

    return {
      ok: failedBatches.length === 0 && !interrupted && remainingPending === 0,
      mode: 'local_mt',
      ...(translatorModelLabel ? { translatorModel: translatorModelLabel } : {}),
      totalTargeted,
      succeeded: succeededBatchIds.length,
      failed: failedBatches.length,
      skipped,
      remainingPending,
      sessionsOpened,
      sessionRotations,
      sessionMaxSourceTokens,
      concurrency: laneCount,
      totalSourceTokens,
      durationMs: Date.now() - startedAt,
      usage,
      cloudUsage,
      localUsage,
      routeStats: summaryRouteStats,
      ...(escalationWarning ? { escalationWarning } : {}),
      succeededBatchIds,
      failedBatches,
      ...(checkpointCommit ? { checkpointCommit } : {}),
      ...(checkpointWarning ? { checkpointWarning } : {}),
      ...(subagentTaskIds.length > 0 ? { subagentTaskIds } : {}),
      ...(interrupted
        ? {
            interrupted: true,
            interruptKind: interruptInfo?.kind ?? 'aborted',
            interruptReason: interruptInfo?.reason ?? 'Local translation interrupted.',
            resumable: remainingPending > 0 || failedBatches.length > 0,
          }
        : {}),
    };
  }

  const runOneLane = async () => {
    let laneSession: ManagedSubagentSession | null = null;
    let laneUsedTokens = 0;
    let laneSessionSeq = 0;
    let laneFreshSession = true;
    let tailPairs: Array<{ speaker?: string; source: string; target: string }> = [];

    const openRotatedSession = async (): Promise<ManagedSubagentSession> => {
      if (laneSession) {
        laneSession.dispose();
        laneSession = null;
        sessionRotations++;
      }
      sessionsOpened++;
      laneSessionSeq = sessionsOpened;
      laneUsedTokens = 0;
      laneFreshSession = true;
      return subagentManager.createManagedSubagentSession('translator', {
        cwd,
        model: deps.model,
        modelRuntime: deps.modelRuntime,
        getKnownSecrets: deps.getKnownSecrets,
      });
    };

    try {
      while (true) {
        if (deps.signal?.aborted) {
          poolTracker.trigger('aborted', 'Batch translation aborted.');
          break;
        }
        if (poolTracker.isAborted()) {
          break;
        }
        const currentIdx = nextIndex++;
        if (currentIdx >= targeted.length) break;
        const entry = targeted[currentIdx];

        const absBatchFile = resolveInsideWorkspace(cwd, entry.file);
        if (!absBatchFile || !fs.existsSync(absBatchFile)) {
          failedBatches.push({ batchId: entry.batch_id, error: `Missing batch source file: ${entry.file}` });
          continue;
        }

        const sourceRows = readJsonlRecords(absBatchFile);
        const compactJsonl = buildCompactBatchInputJsonl(sourceRows);
        const batchCost = Math.max(1, Number(batchCostValue(entry)));

        if (!laneSession || (laneUsedTokens > 0 && laneUsedTokens + batchCost > sessionMaxSourceTokens)) {
          laneSession = await openRotatedSession();
        }

        let checkedIn = false;
        let recordedFailure = false;
        let lastError = '';
        let lastErrorKind: SubagentInterruptKind | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (poolTracker.isAborted()) {
            if (deps.signal?.aborted) {
              poolTracker.trigger('aborted', 'Batch translation aborted.');
            }
            break;
          }
          if (attempt > 0) {
            laneSession = await openRotatedSession();
          }
          const promptText = buildTranslatorPrompt(
            entry,
            compactJsonl,
            loc,
            laneFreshSession,
            tailPairs,
            params.contextSummary,
            attempt > 0 ? lastError : undefined,
            sourceRows
          );
          laneFreshSession = false;

          let runRes;
          try {
            runRes = await laneSession!.prompt(promptText, {
              onDelta: (d) => deps.onDelta?.('translator', d),
              signal: poolTracker.signal,
              sessionId: deps.sessionId,
              parentCallId: deps.parentCallId,
              recordDiagnostics: deps.recordDiagnostics,
              onTaskUpdated: deps.onTaskUpdated,
              usageKind: 'subagent:translator',
            });
            subagentTaskIds.push(runRes.taskId);
            addUsage(usage, runRes.metrics.usage);
            addUsage(cloudUsage, runRes.metrics.usage);
          } catch (err: any) {
            if (err?.taskId) subagentTaskIds.push(String(err.taskId));
            addUsage(usage, err?.metrics?.usage);
            addUsage(cloudUsage, err?.metrics?.usage);
            lastError = redactSecrets(String(err?.message || err), deps.getKnownSecrets?.());
            const cls = classifySubagentError(
              lastError,
              Boolean(deps.signal?.aborted || err?.metrics?.status === 'aborted')
            );
            lastErrorKind = cls.kind;
            if (deps.signal?.aborted || cls.fatalForPool) {
              const kind: SubagentInterruptKind = deps.signal?.aborted ? 'aborted' : cls.kind;
              const reason = lastError || 'Batch translation interrupted.';
              poolTracker.trigger(kind, reason);
              failedBatches.push({ batchId: entry.batch_id, error: reason, errorKind: kind });
              recordedFailure = true;
              break;
            }
            if (cls.kind === 'content_blocked') {
              break;
            }
            continue;
          }

          try {
            const batchRouteStats: BatchRouteStats = {
              tm_cache: 0,
              local_mt: 0,
              cloud_escalated: 0,
              cloud_subagent: sourceRows.length,
              qa_failed: 0,
            };
            checkinVnBatch(cwd, entry.batch_id, {
              raw: runRes.text,
              model: modelKey,
              sessionSeq: laneSessionSeq,
              mode: 'cloud_subagent',
              routeStats: batchRouteStats,
            });
            summaryRouteStats.cloudSubagent += sourceRows.length;
            checkedIn = true;
            laneUsedTokens += batchCost;
            totalSourceTokens += Number(entry.estimated_source_tokens || 0);
            succeededBatchIds.push(entry.batch_id);
            subagentManager.markTaskProgress(
              cwd,
              runRes.taskId,
              `保存批次 ${entry.batch_id}`,
              wsPaths.batchOutRel(entry.batch_id)
            );

            // Update adjacent context tail using newly persisted .papercup/tmp/work/out/batch_xxx.jsonl
            const outFile = wsPaths.batchOutFile(entry.batch_id);
            if (fs.existsSync(outFile)) {
              const persisted = readJsonlRecords(outFile);
              tailPairs = persisted.slice(-TAIL_PAIR_LIMIT).map((r) => ({
                ...(r.speaker ? { speaker: String(r.speaker) } : {}),
                source: String(r.source ?? ''),
                target: String(r.target ?? ''),
              }));
            }

            deps.onBatchProgress?.({
              type: 'checkin',
              batchId: entry.batch_id,
              completed: succeededBatchIds.length,
              total: totalTargeted,
              status: 'saved_pending_qa',
              timestamp: new Date().toISOString(),
            });

            if (checkpointInterval > 0 && succeededBatchIds.length - lastCheckpointAtCount >= checkpointInterval) {
              lastCheckpointAtCount = succeededBatchIds.length;
              await maybeCreateCheckpoint(`saved ${succeededBatchIds.length}/${totalTargeted} batches`);
            }
            break;
          } catch (err: any) {
            lastError = redactSecrets(
              String(err?.message || err).trim() || 'checkin validation failed',
              deps.getKnownSecrets?.()
            );
            const cls = classifySubagentError(lastError, false);
            lastErrorKind = cls.kind;
            if (cls.kind === 'content_blocked') {
              break;
            }
          }
        }

        if (!checkedIn && !recordedFailure) {
          if (poolTracker.isAborted()) {
            const existingInt = poolTracker.getInterrupt();
            const reason = lastError || existingInt?.reason || 'Batch translation aborted.';
            poolTracker.trigger(existingInt?.kind ?? 'aborted', reason);
            failedBatches.push({ batchId: entry.batch_id, error: reason, errorKind: existingInt?.kind ?? 'aborted' });
            break;
          }
          failedBatches.push({
            batchId: entry.batch_id,
            error: lastError || 'Unknown batch checkin error',
            ...(lastErrorKind ? { errorKind: lastErrorKind } : {}),
          });
        }
        if (poolTracker.getInterrupt()) {
          break;
        }
      }
    } finally {
      laneSession?.dispose();
    }
  };

  try {
    await Promise.all(Array.from({ length: laneCount }, () => runOneLane()));
  } finally {
    poolTracker.cleanup();
  }

  if (checkpointInterval > 0 && succeededBatchIds.length > lastCheckpointAtCount) {
    await maybeCreateCheckpoint(`completed run: ${succeededBatchIds.length} batches saved (pending-qa)`);
  }

  const interruptInfo = poolTracker.getInterrupt();
  const interrupted = Boolean(interruptInfo || deps.signal?.aborted);
  const remainingPending = Math.max(0, totalTargeted - succeededBatchIds.length - failedBatches.length);

  const contentBlockedIds = failedBatches
    .filter((f) => f.errorKind === 'content_blocked')
    .map((f) => f.batchId);
  const contentBlockedHint = contentBlockedIds.length
    ? `批次 ${contentBlockedIds.join('、')} 触发了模型/网关内容审查拒答（content_blocked）。若作品属全年龄向或疑似误拒，请精简 contextSummary（移除多余年龄/年级或敏感修饰词）或切换本地翻译模型后仅对失败批次重试，避免同上下文反复重试空耗额度。`
    : undefined;

  return {
    ok: failedBatches.length === 0 && !interrupted && remainingPending === 0,
    mode: 'cloud_subagent',
    ...(translatorModelLabel ? { translatorModel: translatorModelLabel } : {}),
    totalTargeted,
    succeeded: succeededBatchIds.length,
    failed: failedBatches.length,
    skipped,
    remainingPending,
    sessionsOpened,
    sessionRotations,
    sessionMaxSourceTokens,
    concurrency: laneCount,
    totalSourceTokens,
    durationMs: Date.now() - startedAt,
    usage,
    cloudUsage,
    localUsage,
    routeStats: summaryRouteStats,
    ...(contentBlockedHint ? { contentBlockedHint } : {}),
    succeededBatchIds,
    failedBatches,
    ...(checkpointCommit ? { checkpointCommit } : {}),
    ...(checkpointWarning ? { checkpointWarning } : {}),
    ...(subagentTaskIds.length > 0 ? { subagentTaskIds } : {}),
    ...(interrupted
      ? {
          interrupted: true,
          interruptKind: interruptInfo?.kind ?? 'aborted',
          interruptReason: interruptInfo?.reason ?? 'Batch translation interrupted.',
          resumable: remainingPending > 0 || failedBatches.length > 0,
        }
      : {}),
  };
}

function batchCostValue(entry: BatchManifestEntry): number {
  const withMargin = Number(entry.estimated_tokens_with_margin);
  if (Number.isFinite(withMargin) && withMargin > 0) return withMargin;
  const raw = Number(entry.estimated_source_tokens);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 1;
}

export async function runPostQaParallel(
  deps: BatchOrchestratorDeps,
  params: PostQaParallelParams = {}
): Promise<PostQaParallelSummary> {
  const startedAt = Date.now();
  const { cwd, subagentManager } = deps;
  const usage = emptyUsage();

  const mergeJson = mergeVnBatches(cwd, {
    track: params.track?.trim() || undefined,
  });

  const wsPaths = resolveWorkspacePaths(cwd);
  const manifest = readJsonFileSafe<{ batches?: BatchManifestEntry[] }>(
    wsPaths.batchesManifestFile
  );
  const idToBatch = new Map<string, string>();
  for (const b of manifest?.batches ?? []) {
    for (const id of b.ids ?? []) {
      idToBatch.set(String(id), b.batch_id);
    }
  }

  const affectedBatchSet = new Set<string>();
  const sampleDeterministicIssues: PostQaParallelSummary['sampleDeterministicIssues'] = [];
  const mergedTracks: Array<{ track: string; rows: Array<Record<string, any>> }> = [];

  for (const t of mergeJson.tracks) {
    const trackName = String(t.track || '');
    const resultsFile = wsPaths.resultsTrackFile(trackName);
    if (!fs.existsSync(resultsFile)) continue;
    const rows = readJsonlRecords(resultsFile);
    mergedTracks.push({ track: trackName, rows });
    for (const row of rows) {
      if (row.ok === false) {
        const rowId = String(row.id ?? `${row.file || ''}#${row.line || ''}`);
        const batchId = idToBatch.get(rowId) || 'unknown';
        if (batchId !== 'unknown') affectedBatchSet.add(batchId);
        if (sampleDeterministicIssues.length < 40) {
          sampleDeterministicIssues.push({
            batchId,
            track: trackName,
            id: rowId,
            source: String(row.source ?? ''),
            target: String(row.target ?? ''),
            findings: Array.isArray(row.findings) ? row.findings : [],
          });
        }
      }
    }
  }

  const planData = readJsonFileSafe<{ config?: Record<string, any> }>(wsPaths.planFile);
  const rawPostQaPlanConcurrency = Number(planData?.config?.concurrency);
  const fallbackPostQaConcurrency =
    Number.isFinite(rawPostQaPlanConcurrency) && rawPostQaPlanConcurrency > 0
      ? rawPostQaPlanConcurrency
      : DEFAULT_CLOUD_CONCURRENCY;
  const concurrency = Math.max(
    1,
    Math.min(MAX_CLOUD_CONCURRENCY, Math.floor(params.concurrency ?? fallbackPostQaConcurrency))
  );
  const chunkSize = Math.max(
    1,
    Math.min(200, Math.floor(params.batchMaxLines ?? DEFAULT_POST_QA_CHUNK_LINES))
  );

  const loc = loadLocalizationContext(cwd);
  const locHash = sha256Text(`${loc.rulesText}\0${loc.characterRosterText}\0${loc.glossaryText}\0${loc.personaText}`);
  const stateRel = WORKSPACE_POST_QA_STATE_REL;
  const stateAbs = wsPaths.postQaStateFile;

  interface QaReviewChunk {
    key: string;
    track: string;
    chunkIndex: number;
    rows: Array<Record<string, any>>;
    batchIds: string[];
    contentHash: string;
  }

  const allChunks: QaReviewChunk[] = [];
  const trackChunkCounts = new Map<string, number>();
  for (const item of mergedTracks) {
    let idx = 0;
    for (let offset = 0; offset < item.rows.length; offset += chunkSize, idx++) {
      const slice = item.rows.slice(offset, offset + chunkSize);
      const batchIds = Array.from(
        new Set(
          slice
            .map((r) => idToBatch.get(String(r.id ?? `${r.file || ''}#${r.line || ''}`)))
            .filter((v): v is string => Boolean(v))
        )
      );
      const rowSig = slice
        .map(
          (r) =>
            `${String(r.id ?? `${r.file || ''}#${r.line || ''}`)}\0${String(r.speaker ?? '')}\0${String(r.scene ?? '')}\0${String(r.source ?? '')}\0${String(r.target ?? '')}`
        )
        .join('\n');
      const key = `${item.track}:${idx}`;
      allChunks.push({
        key,
        track: item.track,
        chunkIndex: idx,
        rows: slice,
        batchIds,
        contentHash: sha256Text(`${item.track}\0${locHash}\0${rowSig}`),
      });
    }
    trackChunkCounts.set(item.track, idx);
  }

  const existingState = readJsonFileSafe<PostQaStateFile>(stateAbs);
  const persistedChunks: Record<string, PersistedPostQaChunkRecord> =
    existingState?.version === 1 && existingState.chunks && typeof existingState.chunks === 'object'
      ? { ...existingState.chunks }
      : {};

  let stateMutated = false;
  for (const key of Object.keys(persistedChunks)) {
    const rec = persistedChunks[key];
    const limit = trackChunkCounts.get(rec?.track);
    if (limit !== undefined && (rec.chunkIndex < 0 || rec.chunkIndex >= limit)) {
      delete persistedChunks[key];
      stateMutated = true;
    }
  }

  const semanticFindings: PostQaParallelSummary['semanticFindings'] = [];
  const subagentTaskIds: string[] = [];
  const todoChunks: QaReviewChunk[] = [];
  let reusedCount = 0;

  for (const chunk of allChunks) {
    const cached = persistedChunks[chunk.key];
    const isReusableSuccess = Boolean(
      cached &&
        cached.contentHash === chunk.contentHash &&
        cached.summary &&
        (cached.status === 'ok' || (cached.status === undefined && !cached.summary.startsWith('ERROR (')))
    );
    if (isReusableSuccess && cached) {
      reusedCount++;
      semanticFindings.push({
        track: chunk.track,
        chunkIndex: chunk.chunkIndex,
        batchIds: chunk.batchIds,
        summary: cached.summary,
      });
    } else {
      if (cached) {
        delete persistedChunks[chunk.key];
        stateMutated = true;
      }
      todoChunks.push(chunk);
    }
  }

  let stateWriteLock = Promise.resolve();
  const enqueuePersistState = () => {
    const payload: PostQaStateFile = {
      version: 1,
      locHash,
      chunks: { ...persistedChunks },
      updatedAt: new Date().toISOString(),
    };
    stateWriteLock = stateWriteLock.then(() => {
      try {
        atomicWriteJson(stateAbs, payload);
      } catch {
        // Non-fatal state write failure; caller still gets returned summary
      }
    });
    return stateWriteLock;
  };

  if (stateMutated) {
    enqueuePersistState();
  }

  let roleCheckerErrors = 0;
  let newlySucceeded = 0;
  let todoCursor = 0;
  const poolTracker = createPoolInterruptTracker(deps.signal);

  const runReviewWorker = async () => {
    while (true) {
      if (deps.signal?.aborted) {
        poolTracker.trigger('aborted', 'Post-QA review aborted.');
        break;
      }
      if (poolTracker.isAborted()) {
        break;
      }
      const idx = todoCursor++;
      if (idx >= todoChunks.length) break;
      const chunk = todoChunks[idx];
      const payloadLines = chunk.rows
        .map((r) =>
          JSON.stringify({
            id: r.id ?? `${r.file || ''}#${r.line || ''}`,
            ...(r.speaker ? { speaker: r.speaker } : {}),
            ...(r.scene ? { scene: r.scene } : {}),
            source: r.source ?? '',
            target: r.target ?? '',
          })
        )
        .join('\n');

      const chunkRosterText = loc.characters.length
        ? formatCharacterRosterForPrompt(loc.characters, {
            activeSpeakers: chunk.rows.map((r) => String(r.speaker ?? '').trim()).filter(Boolean),
            activeText: chunk.rows.map((r) => String(r.source ?? '')).join('\n'),
          })
        : loc.characterRosterText;
      const reviewTask = [
        chunkRosterText ? `<character_roster>\n${chunkRosterText}\n</character_roster>` : '',
        loc.glossaryText ? `<glossary>\n${loc.glossaryText}\n</glossary>` : '<glossary>(empty)</glossary>',
        loc.personaText ? `<persona>\n${loc.personaText}\n</persona>` : '<persona>(empty)</persona>',
        `Review track=${chunk.track} chunk=${chunk.chunkIndex} (${chunk.rows.length} lines). Report ONLY concrete character-name/persona/register/glossary mismatches by id, or confirm consistent:\n${payloadLines}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      try {
        const res = await subagentManager.runSubagentWithMetrics('role-checker', reviewTask, {
          cwd,
          model: deps.model,
          modelRuntime: deps.modelRuntime,
          signal: poolTracker.signal,
          sessionId: deps.sessionId,
          parentCallId: deps.parentCallId,
          recordDiagnostics: deps.recordDiagnostics,
          getKnownSecrets: deps.getKnownSecrets,
          onDelta: (d) => deps.onDelta?.('role-checker', d),
          onTaskUpdated: deps.onTaskUpdated,
          usageKind: 'subagent:role-checker',
        });
        subagentTaskIds.push(res.taskId);
        addUsage(usage, res.metrics.usage);
        newlySucceeded++;
        persistedChunks[chunk.key] = {
          track: chunk.track,
          chunkIndex: chunk.chunkIndex,
          batchIds: chunk.batchIds,
          contentHash: chunk.contentHash,
          status: 'ok',
          summary: res.text,
          taskId: res.taskId,
          updatedAt: new Date().toISOString(),
        };
        void enqueuePersistState();
        semanticFindings.push({
          track: chunk.track,
          chunkIndex: chunk.chunkIndex,
          batchIds: chunk.batchIds,
          summary: res.text,
        });
      } catch (err: any) {
        if (err?.taskId) subagentTaskIds.push(String(err.taskId));
        addUsage(usage, err?.metrics?.usage);
        const safeErr = redactSecrets(String(err?.message || err), deps.getKnownSecrets?.());
        const cls = classifySubagentError(
          safeErr,
          Boolean(deps.signal?.aborted || err?.metrics?.status === 'aborted')
        );
        roleCheckerErrors++;
        semanticFindings.push({
          track: chunk.track,
          chunkIndex: chunk.chunkIndex,
          batchIds: chunk.batchIds,
          summary: `ERROR (${cls.kind}): ${safeErr}`,
        });
        if (deps.signal?.aborted || cls.fatalForPool) {
          const kind: SubagentInterruptKind = deps.signal?.aborted ? 'aborted' : cls.kind;
          poolTracker.trigger(kind, safeErr || 'Post-QA review interrupted.');
          break;
        }
      }
    }
  };

  try {
    if (!params.skipRoleChecker && todoChunks.length > 0) {
      await Promise.all(Array.from({ length: Math.min(concurrency, todoChunks.length) }, () => runReviewWorker()));
    } else if (deps.signal?.aborted) {
      poolTracker.trigger('aborted', 'Post-QA review aborted.');
    }
  } finally {
    poolTracker.cleanup();
    await stateWriteLock;
  }

  const totalChunks = allChunks.length;
  const reviewedChunks = reusedCount + newlySucceeded;
  const pendingChunks = Math.max(0, todoChunks.length - newlySucceeded);
  const interruptInfo = poolTracker.getInterrupt();
  const interrupted = Boolean(interruptInfo || deps.signal?.aborted);
  const semanticQaComplete = totalChunks === 0 || (!interrupted && pendingChunks === 0 && roleCheckerErrors === 0);

  const reportRel = WORKSPACE_POST_QA_REPORT_REL;
  const reportAbs = wsPaths.postQaReportFile;
  const deterministicPassed = Number(mergeJson.total_passed || 0);
  const deterministicFailed = Number(mergeJson.total_failed || 0);

  const reportPayload: PostQaParallelSummary = {
    ok: params.skipRoleChecker
      ? deterministicFailed === 0 && !interrupted
      : deterministicFailed === 0 && roleCheckerErrors === 0 && !interrupted && pendingChunks === 0,
    deterministicPassed,
    deterministicFailed,
    affectedBatchIds: Array.from(affectedBatchSet).sort(),
    sampleDeterministicIssues,
    roleCheckerChunksReviewed: reviewedChunks,
    roleCheckerChunksTotal: totalChunks,
    roleCheckerReusedChunks: reusedCount,
    roleCheckerPendingChunks: pendingChunks,
    roleCheckerErrors,
    ...(params.skipRoleChecker ? { roleCheckerSkipped: true } : {}),
    semanticQaComplete,
    semanticFindings: semanticFindings.sort((a, b) =>
      a.track === b.track ? a.chunkIndex - b.chunkIndex : a.track.localeCompare(b.track)
    ),
    reportPath: reportRel,
    statePath: stateRel,
    durationMs: Date.now() - startedAt,
    usage,
    ...(subagentTaskIds.length > 0 ? { subagentTaskIds } : {}),
    ...(interrupted
      ? {
          interrupted: true,
          interruptKind: interruptInfo?.kind ?? 'aborted',
          interruptReason: interruptInfo?.reason ?? 'Post-QA review interrupted.',
          resumable: pendingChunks > 0,
        }
      : roleCheckerErrors > 0 || (pendingChunks > 0 && !params.skipRoleChecker)
        ? {
            resumable: pendingChunks > 0,
          }
        : {}),
  };
  atomicWriteJson(reportAbs, reportPayload);

  deps.onBatchProgress?.({
    type: 'post_qa',
    completed: reviewedChunks,
    total: totalChunks,
    summary: `QA: ${deterministicPassed} passed, ${deterministicFailed} failed; semantic ${reviewedChunks}/${totalChunks}`,
    status: reportPayload.ok ? 'qa_passed' : interrupted ? 'interrupted' : 'qa_failed',
    timestamp: new Date().toISOString(),
  });

  return reportPayload;
}
