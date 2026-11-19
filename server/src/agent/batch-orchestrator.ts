import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkinVnBatch, mergeVnBatches, runVnCheckpoint } from '../vn/core.js';
import { isRestrictedSecretPath, redactSecrets } from '../security/secrets.js';
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
}

export interface TranslateBatchesSummary {
  ok: boolean;
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
  succeededBatchIds: string[];
  failedBatches: Array<{ batchId: string; error: string }>;
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
}

interface LocalizationContext {
  rulesText: string;
  glossaryText: string;
  personaText: string;
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
  const result: Record<string, string> = {};
  let inSection = false;
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inSection = line === '[vn.localization]';
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const rawVal = line.slice(eq + 1).trim();
    const quotedMatch = rawVal.match(/^"(.*)"$/) || rawVal.match(/^'(.*)'$/);
    result[key] = quotedMatch ? quotedMatch[1] : rawVal;
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

function loadLocalizationContext(
  cwd: string,
  glossaryOverride?: string,
  personaOverride?: string
): LocalizationContext {
  const tomlPath = path.join(cwd, 'papercup.toml');
  let parsed: Record<string, string> = {};
  if (fs.existsSync(tomlPath) && !fs.lstatSync(tomlPath).isSymbolicLink()) {
    try {
      parsed = parseLocalizationToml(fs.readFileSync(tomlPath, 'utf8'));
    } catch {
      parsed = {};
    }
  }
  const rulePairs = [
    parsed.source_lang && parsed.target_lang ? `language=${parsed.source_lang}->${parsed.target_lang}` : '',
    parsed.narrative_pov ? `narrative_pov=${parsed.narrative_pov}` : '',
    parsed.player_address ? `player_address=${parsed.player_address}` : '',
    parsed.mixed_rules ? `mixed_rules=${parsed.mixed_rules}` : '',
  ].filter(Boolean);

  const glossaryText =
    glossaryOverride !== undefined
      ? glossaryOverride.trim()
      : readBoundedContextFile(cwd, parsed.glossary_file);
  const personaText =
    personaOverride !== undefined
      ? personaOverride.trim()
      : readBoundedContextFile(cwd, parsed.persona_file);

  return {
    rulesText: rulePairs.join('; '),
    glossaryText,
    personaText,
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

  let startIdx = 0;
  let endIdx = allBatches.length - 1;
  if (params.startBatch?.trim()) {
    const found = allBatches.findIndex((b) => b.batch_id === params.startBatch!.trim());
    if (found < 0) throw new Error(`startBatch '${params.startBatch}' not found in work/batches/manifest.json.`);
    startIdx = found;
  }
  if (params.endBatch?.trim()) {
    const found = allBatches.findIndex((b) => b.batch_id === params.endBatch!.trim());
    if (found < 0) throw new Error(`endBatch '${params.endBatch}' not found in work/batches/manifest.json.`);
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
      const outPath = path.join(cwd, 'work', 'out', `${entry.batch_id}.jsonl`);
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
        throw new Error(`Requested batchId '${wanted}' does not exist in work/batches/manifest.json.`);
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
  retryError?: string
): string {
  const parts: string[] = [];
  if (includeFullPreamble) {
    if (loc.rulesText) parts.push(`<localization_rules>\n${loc.rulesText}\n</localization_rules>`);
    if (loc.glossaryText) parts.push(`<glossary>\n${loc.glossaryText}\n</glossary>`);
    if (loc.personaText) parts.push(`<persona>\n${loc.personaText}\n</persona>`);
    if (contextSummary?.trim()) parts.push(`<context>\n${contextSummary.trim()}\n</context>`);
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

export async function runTranslateBatches(
  deps: BatchOrchestratorDeps,
  params: TranslateBatchesParams = {}
): Promise<TranslateBatchesSummary> {
  const startedAt = Date.now();
  const { cwd, subagentManager } = deps;

  const manifest = readJsonFileSafe<{ batches?: BatchManifestEntry[] }>(
    path.join(cwd, 'work', 'batches', 'manifest.json')
  );
  if (!manifest || !Array.isArray(manifest.batches) || manifest.batches.length === 0) {
    throw new Error('work/batches/manifest.json missing or empty. Run vn_plan with generateBatches=true first.');
  }

  const planData = readJsonFileSafe<{ config?: Record<string, any> }>(path.join(cwd, '.papercup', 'vn', 'plan.json'));
  const planConfig = planData?.config ?? {};
  const progressData = readJsonFileSafe<{ batches?: Record<string, any> }>(path.join(cwd, '.papercup', 'vn', 'progress.json'));
  const progressBatches = progressData?.batches ?? {};

  const sessionMaxSourceTokens = Math.max(
    100,
    Math.floor(params.sessionMaxSourceTokens ?? Number(planConfig.session_max_source_tokens || 24000))
  );
  const concurrency = Math.max(
    1,
    Math.min(16, Math.floor(params.concurrency ?? Number(planConfig.concurrency || 2)))
  );
  const checkpointInterval = params.checkpointInterval === undefined ? 10 : Math.max(0, Math.floor(params.checkpointInterval));

  const { targeted, skipped } = selectTargetBatches(manifest.batches, progressBatches, cwd, params);

  for (const batch of targeted) {
    const cost = Math.max(1, Number(batch.estimated_tokens_with_margin || batch.estimated_source_tokens || 1));
    if (cost > sessionMaxSourceTokens) {
      throw new Error(
        `Batch ${batch.batch_id} requires ${cost} estimated tokens (with margin), exceeding sessionMaxSourceTokens (${sessionMaxSourceTokens}). Run vn_plan to split smaller batches or raise sessionMaxSourceTokens.`
      );
    }
  }

  const usage = emptyUsage();
  const modelKey = deps.model?.provider && deps.model?.id ? `${deps.model.provider}/${deps.model.id}` : '';
  const totalTargeted = targeted.length;
  if (totalTargeted === 0) {
    return {
      ok: true,
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
      succeededBatchIds: [],
      failedBatches: [],
    };
  }

  const loc = loadLocalizationContext(cwd, params.glossary, params.personaSummary);
  let nextIndex = 0;
  let sessionsOpened = 0;
  let sessionRotations = 0;
  let totalSourceTokens = 0;
  const succeededBatchIds: string[] = [];
  const failedBatches: Array<{ batchId: string; error: string }> = [];
  const subagentTaskIds: string[] = [];
  let checkpointCommit: string | undefined;
  let checkpointWarning: string | undefined;
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
            attempt > 0 ? lastError : undefined
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
            });
            subagentTaskIds.push(runRes.taskId);
            addUsage(usage, runRes.metrics.usage);
          } catch (err: any) {
            if (err?.taskId) subagentTaskIds.push(String(err.taskId));
            addUsage(usage, err?.metrics?.usage);
            lastError = redactSecrets(String(err?.message || err), deps.getKnownSecrets?.());
            const cls = classifySubagentError(
              lastError,
              Boolean(deps.signal?.aborted || err?.metrics?.status === 'aborted')
            );
            if (deps.signal?.aborted || cls.fatalForPool) {
              const kind: SubagentInterruptKind = deps.signal?.aborted ? 'aborted' : cls.kind;
              const reason = lastError || 'Batch translation interrupted.';
              poolTracker.trigger(kind, reason);
              failedBatches.push({ batchId: entry.batch_id, error: reason });
              recordedFailure = true;
              break;
            }
            continue;
          }

          try {
            checkinVnBatch(cwd, entry.batch_id, {
              raw: runRes.text,
              model: modelKey,
              sessionSeq: laneSessionSeq,
            });
            checkedIn = true;
            laneUsedTokens += batchCost;
            totalSourceTokens += Number(entry.estimated_source_tokens || 0);
            succeededBatchIds.push(entry.batch_id);
            subagentManager.markTaskProgress(
              cwd,
              runRes.taskId,
              `保存批次 ${entry.batch_id}`,
              `work/out/${entry.batch_id}.jsonl`
            );

            // Update adjacent context tail using newly persisted work/out/batch_xxx.jsonl
            const outFile = path.join(cwd, 'work', 'out', `${entry.batch_id}.jsonl`);
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
          }
        }

        if (!checkedIn && !recordedFailure) {
          if (poolTracker.isAborted()) {
            const existingInt = poolTracker.getInterrupt();
            const reason = lastError || existingInt?.reason || 'Batch translation aborted.';
            poolTracker.trigger(existingInt?.kind ?? 'aborted', reason);
            failedBatches.push({ batchId: entry.batch_id, error: reason });
            break;
          }
          failedBatches.push({ batchId: entry.batch_id, error: lastError || 'Unknown batch checkin error' });
        }
        if (poolTracker.getInterrupt()) {
          break;
        }
      }
    } finally {
      laneSession?.dispose();
    }
  };

  const laneCount = Math.min(concurrency, totalTargeted);
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

  return {
    ok: failedBatches.length === 0 && !interrupted && remainingPending === 0,
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

  const manifest = readJsonFileSafe<{ batches?: BatchManifestEntry[] }>(
    path.join(cwd, 'work', 'batches', 'manifest.json')
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
    const resultsFile = path.join(cwd, 'results', `${trackName}.jsonl`);
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

  const planData = readJsonFileSafe<{ config?: Record<string, any> }>(path.join(cwd, '.papercup', 'vn', 'plan.json'));
  const concurrency = Math.max(
    1,
    Math.min(16, Math.floor(params.concurrency ?? Number(planData?.config?.concurrency || 2)))
  );
  const chunkSize = Math.max(1, Math.min(200, Math.floor(params.batchMaxLines ?? 60)));

  const loc = loadLocalizationContext(cwd);
  const locHash = sha256Text(`${loc.glossaryText}\0${loc.personaText}`);
  const stateRel = '.papercup/vn/post_qa_state.json';
  const stateAbs = path.join(cwd, stateRel);

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
            `${String(r.id ?? `${r.file || ''}#${r.line || ''}`)}\0${String(r.source ?? '')}\0${String(r.target ?? '')}`
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
    if (
      cached &&
      cached.contentHash === chunk.contentHash &&
      cached.summary &&
      !cached.summary.startsWith('ERROR')
    ) {
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

      const reviewTask = [
        loc.glossaryText ? `<glossary>\n${loc.glossaryText}\n</glossary>` : '<glossary>(empty)</glossary>',
        loc.personaText ? `<persona>\n${loc.personaText}\n</persona>` : '<persona>(empty)</persona>',
        `Review track=${chunk.track} chunk=${chunk.chunkIndex} (${chunk.rows.length} lines). Report ONLY concrete persona/register/glossary mismatches by id, or confirm consistent:\n${payloadLines}`,
      ].join('\n\n');

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
        });
        subagentTaskIds.push(res.taskId);
        addUsage(usage, res.metrics.usage);
        newlySucceeded++;
        persistedChunks[chunk.key] = {
          track: chunk.track,
          chunkIndex: chunk.chunkIndex,
          batchIds: chunk.batchIds,
          contentHash: chunk.contentHash,
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

  const reportRel = '.papercup/vn/post_qa_report.json';
  const reportAbs = path.join(cwd, reportRel);
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
