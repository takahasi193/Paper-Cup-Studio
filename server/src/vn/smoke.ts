/**
 * Deterministic runtime smoke-testing engine (`vn_smoke_test`) for localized VN patches.
 *
 * Architecture:
 * - Zero external npm/Python dependencies; stays strictly deterministic (network/LLM vision
 *   callbacks are injected from `server/src/agent/smoke-vision.ts`).
 * - Builds an NTFS hardlink sandbox under `<ws>/.papercup/smoke/<runId>/` so original game
 *   directories, archives, and `save/` files are NEVER modified.
 * - Launches the game inside a Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
 *   with hard timeout + AbortSignal cancellation, background-first input (`PrintWindow` +
 *   `PostMessage`) with brief foreground fallback (`SendInput`), optional Textractor CLI
 *   text hooking, and Windows Application Event Log (ID 1000) crash-offset capture.
 * - Evaluates ESLint-style rules (`runtime.*`, `text.*`, `vision.*`, `hook.*`) and writes
 *   `.papercup/vn/smoke/report.json` for `vn_accept` gating and bounded auto-repair (<= 2 rounds).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import {
  SKILL_MANIFEST,
  findUnpackManifests,
  resolveEngineJson,
  runPythonScript,
  scanWorkspace,
  sha256Hex,
  skillBinding,
  staysInside,
} from './archives.js';
import { TRACKS, applyResults, readManifest, readResultsJsonl } from './classify.js';
import { loadPatchedFontManifest, resolvePatchedFontFile, scanWorkspaceBundledFonts } from './fonts.js';
import {
  LAST_PATCH_META_REL,
  assertNoDestructiveShrinkReplace,
  buildApplyPythonEnv,
  buildPatchIni,
  collectSkillCustomEncodings,
  detectChangedEntriesInManifestDir,
  inspectPrimaryGameExe,
  isBackupOrNonOriginalArchiveRel,
  probeSourceEncoding,
  readLastPatchMeta,
  readPeArchitecture,
  readSkillEncodingHint,
  readSkillRuntimeCharsetHint,
  resolvePatchEncodingAndHook,
  snapshotFiles,
  stageDirectWorkspaceSubset,
  validateWritebackSourceArchive,
  type PatchHookMeta,
  type PatchManifest,
} from './patch.js';
import { chooseProxyDllName, resolvePrebuiltProxyDll } from './win32-proxy.js';
import {
  displayRel,
  encodeText,
  isSymlinkPath,
  loadWorkspacePatchConfig,
  normalizeGbkCompatText,
  realpathSafe,
  resolveWorkspaceControlPattern,
  type LocalizationProfile,
  type ProjectMemory,
} from './profile.js';
import { SKILL_RUNTIME_SCRIPTS, hashSkillTextContent } from './skill-registry.js';
import {
  SMOKE_PRE_TRANSLATE_REL,
  SMOKE_REPORT_REL,
  findLocaleEmulatorProfileGuid,
  getSmokeConfigState,
  listLocaleEmulatorProfiles,
  readPreTranslateSmokeRecord,
  readSmokeReport,
  selectTextractorCliForArch,
  type PreTranslateSmokeProbeInfo,
  type PreTranslateSmokeRecord,
  type SmokeCapturedFrame,
  type SmokeCrashInfo,
  type SmokeFinding,
  type SmokeOverlayFileEntry,
  type SmokeReport,
  type SmokeRuleId,
  type SmokeRuleSeverity,
  type SmokeTestConfig,
  type SmokeVisionDefect,
} from './smoke-config.js';
import { copyTreeRecursive, resolveReadyDirectSkill, unlinkBaksRecursive } from './workflow.js';
import {
  WORKSPACE_PATCH_GUIDE_REL,
  WORKSPACE_SMOKE_FAILURES_REL,
  WORKSPACE_SMOKE_FRAMES_REL,
  WORKSPACE_SMOKE_REPAIR_REL,
  resolveWorkspacePaths,
} from './workspace-paths.js';

export {
  LAST_PATCH_META_REL,
  SMOKE_PRE_TRANSLATE_REL,
  SMOKE_REPORT_REL,
  readLastPatchMeta,
  readPreTranslateSmokeRecord,
  readSmokeReport,
  type PreTranslateSmokeProbeInfo,
  type PreTranslateSmokeRecord,
  type SmokeCapturedFrame,
  type SmokeCrashInfo,
  type SmokeFinding,
  type SmokeOverlayFileEntry,
  type SmokeReport,
  type SmokeRuleId,
  type SmokeRuleSeverity,
  type SmokeVisionDefect,
};
export const SMOKE_FRAMES_REL = WORKSPACE_SMOKE_FRAMES_REL;
export const SMOKE_REPAIR_REL = WORKSPACE_SMOKE_REPAIR_REL;
export const SMOKE_FAILURES_REL = WORKSPACE_SMOKE_FAILURES_REL;
export const MAX_RETAINED_SMOKE_FAILURES = 3;
export const SMOKE_HARNESS_ERROR_RULES = new Set(['harness.driver_failed']);

let smokeRunSeq = 0;

export function isHarnessOnlyErrors(errorRules: readonly string[]): boolean {
  return errorRules.length > 0 && errorRules.every((r) => SMOKE_HARNESS_ERROR_RULES.has(r));
}

export class SmokeError extends Error {}

export interface SmokeVisionBridge {
  locateStartButton?: (
    framePath: string,
    signal?: AbortSignal
  ) => Promise<{
    found: boolean;
    xNorm?: number;
    yNorm?: number;
    label?: string;
    skippedReason?: string;
  }>;
  inspectFrames?: (
    frames: Array<{ label: string; path: string }>,
    context: {
      targetLang: string;
      sampleTranslations: string[];
      probeMode?: 'post_translate' | 'pre_translate';
    },
    signal?: AbortSignal
  ) => Promise<{
    status: 'checked' | 'skipped';
    reason?: string;
    defects: SmokeVisionDefect[];
  }>;
}

export interface SmokeDriverInput {
  sandboxDir: string;
  exePath: string;
  exeArch: 'x86' | 'x64' | 'unknown';
  framesDir: string;
  config: SmokeTestConfig;
  useLocaleEmulator: boolean;
  leProcPath: string | null;
  leProfileGuid?: string | null;
  textractorCliPath: string | null;
  vision?: SmokeVisionBridge;
  signal?: AbortSignal;
}

export interface SmokeDriverLog {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

export interface SmokeDriverRunResult {
  launched: boolean;
  launchError?: string;
  harnessFailed?: boolean;
  harnessError?: string;
  driverLog?: SmokeDriverLog;
  windowFound: boolean;
  windowTitle?: string;
  mainProcessName?: string;
  observedProcessNames?: string[];
  inputMode: 'background' | 'foreground_fallback' | 'none';
  stepsAdvanced: number;
  durationMs: number;
  processExitedEarly: boolean;
  windowWaitTimeout?: boolean;
  observedWindows?: string[];
  exitCode?: number | null;
  hungDetected: boolean;
  frozenScreen: boolean;
  errorDialog?: { title: string; text: string } | null;
  crashEvent?: SmokeCrashInfo | null;
  frames: Array<{
    label: 'title' | 'dialogue_start' | 'dialogue_mid' | 'dialogue_end' | 'error';
    step: number;
    path: string;
    hash: string;
    width: number;
    height: number;
  }>;
  textractorLines: string[];
  visionClickAttempted?: boolean;
  visionClickSkippedReason?: string;
}

export interface SmokeExecutionDriver {
  run(input: SmokeDriverInput): Promise<SmokeDriverRunResult>;
}

export interface SmokeRepairState {
  schema: 1;
  resultsDigest: string;
  failedRounds: number;
  maxRepairRounds: number;
  lastRunAt: string;
  lastOk: boolean;
  lastFailureKind?: 'patch' | 'harness';
  lastErrorRules: string[];
  lastInfraError?: {
    at: string;
    rules: string[];
  };
}

// VCS & Paper Cup internal metadata directories skipped at any depth.
const SANDBOX_EXCLUDE_ANY_DEPTH_DIRS = new Set(['.git', '.hg', '.svn', '.papercup']);

// Paper Cup engineering / build directories skipped ONLY at workspace root (depth === 0)
// so game-owned nested resource folders like `data/release/` or `game/work/` are preserved.
export const DEFAULT_SANDBOX_EXCLUDE_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'patch',
  'unpacked',
  'build',
  'work',
  'results',
  'release',
  'backup',
  'backups',
]);
const SANDBOX_EXCLUDE_TOP_DIRS = DEFAULT_SANDBOX_EXCLUDE_DIRS;

// User save directories skipped ONLY at workspace root or immediately next to the game executable.
const SANDBOX_SAVE_DIRS = new Set(['save', 'saves', 'savedata']);

const SANDBOX_EXCLUDE_ROOT_FILES = new Set([
  'papercup.toml',
  WORKSPACE_PATCH_GUIDE_REL,
  'unpack.py',
  'repack.py',
  'extract.py',
  'apply.py',
]);

// Only large read-only archive/media files (>= 4 MiB) are hardlinked into the sandbox.
// All smaller files and any mutable config/save/script extensions are copied so runtime writes
// NEVER mutate original workspace files through shared NTFS inodes.
const SANDBOX_HARDLINK_MIN_BYTES = 4 * 1024 * 1024;

const SANDBOX_MUTABLE_EXTS = new Set([
  '.ini',
  '.cfg',
  '.conf',
  '.sav',
  '.save',
  '.dat',
  '.cf',
  '.log',
  '.json',
  '.xml',
  '.toml',
  '.yaml',
  '.yml',
  '.txt',
  '.csv',
  '.ks',
  '.tjs',
  '.scn',
  '.rpy',
  '.rpyc',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.reg',
  '.env',
  '.bak',
]);

function toPosix(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '');
}

function shouldHardlinkSandboxFile(src: string, sizeBytes: number): boolean {
  if (sizeBytes < SANDBOX_HARDLINK_MIN_BYTES) return false;
  const ext = path.extname(src).toLowerCase();
  if (!ext || SANDBOX_MUTABLE_EXTS.has(ext)) return false;
  // General invariant: any large (>= 4 MiB) non-mutable game asset/archive/font/media file
  // can be safely hardlinked into the sandbox; overlay writes always unlink before replacing.
  return true;
}

function stageFileToSandbox(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(src).size;
  } catch {
    sizeBytes = 0;
  }
  if (shouldHardlinkSandboxFile(src, sizeBytes)) {
    try {
      fs.linkSync(src, dst);
      return;
    } catch {
      // fall back to full copy when cross-volume or link limit reached
    }
  }
  fs.copyFileSync(src, dst);
}

function writeSmokeReport(workspace: string, report: SmokeReport): string {
  const ws = realpathSafe(workspace);
  const p = path.join(ws, SMOKE_REPORT_REL);
  if (isSymlinkPath(p)) throw new SmokeError(`冒烟报告路径不能是符号链接：${p}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return p;
}

function writePreTranslateSmokeRecord(workspace: string, record: PreTranslateSmokeRecord): string {
  const ws = realpathSafe(workspace);
  const p = resolveWorkspacePaths(ws).smokePreTranslateFile;
  if (isSymlinkPath(p)) throw new SmokeError(`前置冒烟记录路径不能是符号链接：${p}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function computeResultsDigest(workspace: string): string {
  const wsPaths = resolveWorkspacePaths(workspace);
  const parts: string[] = [];
  for (const track of TRACKS) {
    const fp = wsPaths.resultsTrackFile(track);
    if (!isSymlinkPath(fp) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      parts.push(`${track}:${sha256Hex(fs.readFileSync(fp))}`);
    }
  }
  return sha256Hex(Buffer.from(parts.join('|'), 'utf8'));
}

const LEGACY_HARNESS_MSG_RE =
  /Add-Type|_papercup_smoke_driver\.ps1|冒烟驱动进程异常退出|不是 Windows|TerminatorExpectedAtEndOfString|ParserError/i;

function isLegacyInfraRepairState(ws: string, state: SmokeRepairState): boolean {
  if (!state.failedRounds || !Array.isArray(state.lastErrorRules) || state.lastErrorRules.length === 0) {
    return false;
  }
  // Structured state persisted by current versions: never override a confirmed patch failure.
  if (state.lastFailureKind === 'patch') {
    return false;
  }
  if (state.lastFailureKind === 'harness' || isHarnessOnlyErrors(state.lastErrorRules)) {
    return true;
  }
  // Legacy compatibility ONLY for historical pre-failureKind reports with explicit PS1/driver errors.
  if (!state.lastErrorRules.every((r) => r === 'runtime.launch_failed')) {
    return false;
  }
  const report = readSmokeReport(ws);
  if (!report || report.ok) return false;
  if (report.failureKind === 'patch') return false;
  if (report.failureKind === 'harness') return true;
  if (report.durationMs !== 0 || report.stepsAdvanced !== 0) return false;
  const errFindings = report.findings.filter((f) => f.severity === 'error');
  if (!errFindings.length || !errFindings.every((f) => f.ruleId === 'runtime.launch_failed')) {
    return false;
  }
  return errFindings.every((f) => LEGACY_HARNESS_MSG_RE.test(f.message || ''));
}

export function readSmokeRepairState(workspace: string): SmokeRepairState | null {
  const ws = realpathSafe(workspace);
  const p = path.join(ws, SMOKE_REPAIR_REL);
  if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as SmokeRepairState;
    if (!parsed || parsed.schema !== 1) return null;
    if (isLegacyInfraRepairState(ws, parsed)) {
      return {
        ...parsed,
        failedRounds: 0,
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

function updateSmokeRepairState(
  workspace: string,
  ok: boolean,
  errorRules: string[],
  maxRepairRounds: number,
  options: { isInfraFailure?: boolean; mode?: 'manifest' | 'overlay' } = {}
): SmokeRepairState {
  const ws = realpathSafe(workspace);
  const resultsDigest = computeResultsDigest(ws);
  const prev = readSmokeRepairState(ws);
  const sameRunSeries = Boolean(prev && prev.resultsDigest === resultsDigest);
  const prevFailed = sameRunSeries ? prev!.failedRounds : 0;
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const isInfra = Boolean(!ok && options.isInfraFailure);

  let next: SmokeRepairState;
  if (ok) {
    if (options.mode === 'overlay' && sameRunSeries && prevFailed > 0) {
      // Diagnostic overlay runs must NOT wipe prior manifest auto-repair failure rounds.
      next = {
        schema: 1,
        resultsDigest,
        failedRounds: prevFailed,
        maxRepairRounds,
        lastRunAt: nowIso,
        lastOk: Boolean(prev?.lastOk),
        ...(prev?.lastFailureKind ? { lastFailureKind: prev.lastFailureKind } : {}),
        lastErrorRules: prev?.lastErrorRules ?? [],
      };
    } else {
      next = {
        schema: 1,
        resultsDigest,
        failedRounds: 0,
        maxRepairRounds,
        lastRunAt: nowIso,
        lastOk: true,
        lastErrorRules: [],
      };
    }
  } else if (isInfra) {
    // Harness/tooling failures must NOT consume patch auto-repair rounds or wipe prior patch error rules.
    next = {
      schema: 1,
      resultsDigest,
      failedRounds: prevFailed,
      maxRepairRounds,
      lastRunAt: nowIso,
      lastOk: prevFailed === 0 ? false : Boolean(prev?.lastOk),
      lastFailureKind: prevFailed > 0 ? (prev?.lastFailureKind ?? 'patch') : 'harness',
      lastErrorRules: prevFailed > 0 && prev?.lastErrorRules?.length ? prev.lastErrorRules : errorRules,
      lastInfraError: {
        at: nowIso,
        rules: errorRules,
      },
    };
  } else {
    next = {
      schema: 1,
      resultsDigest,
      failedRounds: prevFailed + 1,
      maxRepairRounds,
      lastRunAt: nowIso,
      lastOk: false,
      lastFailureKind: 'patch',
      lastErrorRules: errorRules,
    };
  }

  const p = path.join(ws, SMOKE_REPAIR_REL);
  if (!isSymlinkPath(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
  return next;
}

function pruneSmokeFailureDirs(workspace: string, maxRetained = MAX_RETAINED_SMOKE_FAILURES): void {
  const ws = realpathSafe(workspace);
  const failuresRoot = path.join(ws, SMOKE_FAILURES_REL);
  if (isSymlinkPath(failuresRoot) || !fs.existsSync(failuresRoot)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(failuresRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(failuresRoot, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { name: e.name, full, mtimeMs };
    })
    // Sort newest first; break mtime ties lexicographically (run-<ts>-<seq>-<pid>)
    .sort((a, b) => (b.mtimeMs !== a.mtimeMs ? b.mtimeMs - a.mtimeMs : b.name.localeCompare(a.name)));

  for (const stale of dirs.slice(Math.max(0, maxRetained))) {
    try {
      if (!isSymlinkPath(stale.full)) {
        fs.rmSync(stale.full, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup failures
    }
  }
}

function preserveSmokeFailureDiagnostics(params: {
  workspace: string;
  runId: string;
  failureKind: 'patch' | 'harness';
  errorRules: string[];
  driverScriptBytes?: Buffer | null;
  driverLog?: SmokeDriverLog;
  frames?: Array<{ path: string }>;
  extraMeta?: Record<string, unknown>;
}): { diagnosticsDir: string; diagnosticsFiles: string[] } {
  const ws = realpathSafe(params.workspace);
  const failureDir = path.join(ws, SMOKE_FAILURES_REL, params.runId);
  fs.mkdirSync(failureDir, { recursive: true });
  const saved: string[] = [];

  if (params.driverScriptBytes && params.driverScriptBytes.length > 0) {
    const p = path.join(failureDir, '_papercup_smoke_driver.ps1');
    fs.writeFileSync(p, params.driverScriptBytes);
    saved.push(displayRel(p, ws));
  }
  if (params.driverLog?.stdout && params.driverLog.stdout.trim()) {
    const p = path.join(failureDir, 'driver.stdout.log');
    fs.writeFileSync(p, params.driverLog.stdout, 'utf8');
    saved.push(displayRel(p, ws));
  }
  if (params.driverLog?.stderr && params.driverLog.stderr.trim()) {
    const p = path.join(failureDir, 'driver.stderr.log');
    fs.writeFileSync(p, params.driverLog.stderr, 'utf8');
    saved.push(displayRel(p, ws));
  }
  if (params.frames && params.frames.length > 0) {
    const dstFramesDir = path.join(failureDir, 'frames');
    for (const f of params.frames) {
      if (!f.path || isSymlinkPath(f.path) || !fs.existsSync(f.path)) continue;
      fs.mkdirSync(dstFramesDir, { recursive: true });
      const dst = path.join(dstFramesDir, path.basename(f.path));
      try {
        fs.copyFileSync(f.path, dst);
        saved.push(displayRel(dst, ws));
      } catch {
        // best-effort screenshot copy
      }
    }
  }
  const metaPath = path.join(failureDir, 'meta.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        runId: params.runId,
        createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        failureKind: params.failureKind,
        errorRules: params.errorRules,
        driverExitCode: params.driverLog?.exitCode ?? null,
        ...(params.extraMeta ?? {}),
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  saved.push(displayRel(metaPath, ws));

  pruneSmokeFailureDirs(ws, MAX_RETAINED_SMOKE_FAILURES);
  return {
    diagnosticsDir: displayRel(failureDir, ws),
    diagnosticsFiles: saved,
  };
}

function hardlinkWorkspaceToSandbox(ws: string, sandboxDir: string, chosenExeRel?: string): void {
  const rawGameRoot = chosenExeRel ? toPosix(path.dirname(toPosix(chosenExeRel))) : '';
  const gameRootRel = rawGameRoot && rawGameRoot !== '.' ? rawGameRoot.toLowerCase() : '';
  const walkLink = (srcCur: string, dstCur: string, depth: number, curRelLow: string) => {
    fs.mkdirSync(dstCur, { recursive: true });
    for (const ent of fs.readdirSync(srcCur, { withFileTypes: true })) {
      const srcFull = path.join(srcCur, ent.name);
      if (isSymlinkPath(srcFull)) continue;
      const low = ent.name.toLowerCase();
      if (ent.isDirectory()) {
        if (SANDBOX_EXCLUDE_ANY_DEPTH_DIRS.has(low)) continue;
        if (depth === 0 && (ent.name.startsWith('.') || SANDBOX_EXCLUDE_TOP_DIRS.has(low))) continue;
        if ((depth === 0 || (gameRootRel && curRelLow === gameRootRel)) && SANDBOX_SAVE_DIRS.has(low)) continue;
        const nextRelLow = curRelLow ? `${curRelLow}/${low}` : low;
        walkLink(srcFull, path.join(dstCur, ent.name), depth + 1, nextRelLow);
      } else if (ent.isFile()) {
        if (low.endsWith('.bak')) continue;
        if (depth === 0 && SANDBOX_EXCLUDE_ROOT_FILES.has(low)) continue;
        stageFileToSandbox(srcFull, path.join(dstCur, ent.name));
      }
    }
  };
  walkLink(ws, sandboxDir, 0, '');
}

function resolveSandboxExeAndSave(sandboxDir: string, chosenExeRel: string): string {
  const exePath = path.resolve(sandboxDir, chosenExeRel);
  const exeCheck = path.relative(sandboxDir, exePath);
  if (
    !exeCheck ||
    exeCheck.startsWith('..') ||
    path.isAbsolute(exeCheck) ||
    isSymlinkPath(exePath) ||
    !fs.existsSync(exePath) ||
    !fs.statSync(exePath).isFile()
  ) {
    throw new SmokeError(`隔离沙箱中不存在目标可执行文件：${chosenExeRel}`);
  }
  // Create isolated empty save/ dir next to exe so game never fails on missing save folder
  fs.mkdirSync(path.join(path.dirname(exePath), 'save'), { recursive: true });
  return exePath;
}

function collectSandboxBasenameMap(sandboxDir: string): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  const walk = (cur: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (isSymlinkPath(full)) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = toPosix(path.relative(sandboxDir, full));
        const key = ent.name.toLowerCase();
        const arr = byBase.get(key) ?? [];
        arr.push(rel);
        byBase.set(key, arr);
      }
    }
  };
  walk(sandboxDir);
  return byBase;
}

function pathStartsWithPrefix(relPosix: string, prefixPosix: string): boolean {
  const normRel = toPosix(relPosix).replace(/\/+$/, '');
  const normPrefix = toPosix(prefixPosix).replace(/\/+$/, '');
  if (!normPrefix || normPrefix === '.') return true;
  if (process.platform === 'win32') {
    const lowRel = normRel.toLowerCase();
    const lowPrefix = normPrefix.toLowerCase();
    return lowRel === lowPrefix || lowRel.startsWith(`${lowPrefix}/`);
  }
  return normRel === normPrefix || normRel.startsWith(`${normPrefix}/`);
}

const NON_ARCHIVE_OVERLAY_EXTS = new Set([
  '.ttf',
  '.otf',
  '.ttc',
  '.exe',
  '.dll',
  '.ini',
  '.json',
  '.txt',
  '.ks',
  '.scn',
  '.rpy',
]);

function overlaySingleFileIntoSandbox(
  sandboxDir: string,
  srcFile: string,
  targetRel: string
): SmokeOverlayFileEntry & { originalBytes: number } {
  const normRel = toPosix(targetRel);
  staysInside('.', normRel);
  const dstArt = path.resolve(sandboxDir, normRel);
  const dstRelCheck = path.relative(sandboxDir, dstArt);
  if (!dstRelCheck || dstRelCheck.startsWith('..') || path.isAbsolute(dstRelCheck)) {
    throw new SmokeError(`覆盖目标路径越界：${targetRel}`);
  }
  fs.mkdirSync(path.dirname(dstArt), { recursive: true });
  const existedBefore = fs.existsSync(dstArt);
  let originalBytes = 0;
  if (existedBefore) {
    try {
      originalBytes = fs.statSync(dstArt).size;
    } catch {
      originalBytes = 0;
    }
    fs.unlinkSync(dstArt); // Sever hardlink so original workspace file inode is NEVER mutated
  }
  const buf = fs.readFileSync(srcFile);
  fs.writeFileSync(dstArt, buf);
  return {
    rel: normRel,
    sha256: sha256Hex(buf),
    bytes: buf.length,
    existedBefore,
    originalBytes,
  };
}

/**
 * Create an isolated hardlink copy of the workspace game files under `.papercup/smoke/<runId>/`,
 * overlay all artifacts from `patch_manifest.json` (unlinking hardlinks BEFORE writing so
 * original files' inodes are never modified), and prepare an empty isolated `save/` directory.
 */
export function prepareSmokeSandbox(
  workspace: string,
  patchManifestPath: string,
  options: { exeOverride?: string; proxyBinDir?: string | null } = {}
): {
  mode: 'manifest';
  runId: string;
  sandboxDir: string;
  manifest: PatchManifest;
  manifestSha256: string;
  exeRel: string;
  exePath: string;
  exeArch: 'x86' | 'x64' | 'unknown';
  usedProxyDll?: string;
  cleanup: () => void;
} {
  const ws = realpathSafe(workspace);
  const wsPaths = resolveWorkspacePaths(ws);
  const absManifest = path.isAbsolute(patchManifestPath) ? path.resolve(patchManifestPath) : path.resolve(ws, patchManifestPath);
  if (isSymlinkPath(absManifest) || !fs.existsSync(absManifest) || !fs.statSync(absManifest).isFile()) {
    throw new SmokeError(`补丁清单不存在：${patchManifestPath}`);
  }
  const rawManifest = fs.readFileSync(absManifest);
  const manifestSha256 = sha256Hex(rawManifest);
  let manifest: PatchManifest;
  try {
    manifest = JSON.parse(rawManifest.toString('utf8').replace(/^\uFEFF/, '')) as PatchManifest;
  } catch {
    throw new SmokeError(`补丁清单不是合法 JSON：${patchManifestPath}`);
  }
  if (manifest.schema !== 1 || manifest.format !== 'papercup-delta-patch' || !Array.isArray(manifest.artifacts)) {
    throw new SmokeError(`补丁清单格式无效（期望 papercup-delta-patch schema=1）：${patchManifestPath}`);
  }

  const patchDir = path.dirname(absManifest);
  const exeInfo = inspectPrimaryGameExe(ws);
  const chosenExeRel = toPosix(
    options.exeOverride?.trim() || manifest.hook?.target_exe || exeInfo.exeRel || ''
  );
  if (!chosenExeRel) {
    throw new SmokeError('工作区中未找到游戏主程序 (.exe)，无法执行运行时冒烟测试；可通过 exe 参数显式指定。');
  }

  const runId = `run-${Date.now()}-${String(++smokeRunSeq).padStart(3, '0')}-${process.pid}`;
  const sandboxDir = wsPaths.smokeSandboxDir(runId);
  fs.mkdirSync(sandboxDir, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on Windows file lock release
    }
  };

  try {
    // 1. Stage workspace game files into sandbox (copy small/mutable files; hardlink only large read-only archives/media)
    hardlinkWorkspaceToSandbox(ws, sandboxDir, chosenExeRel);

    // 2. Apply delta patch artifacts on top — ALWAYS unlink any existing hardlink first!
    for (const art of manifest.artifacts) {
      const pRel = typeof art.patch_rel === 'string' ? toPosix(art.patch_rel) : '';
      const iRel = typeof art.install_rel === 'string' ? toPosix(art.install_rel) : '';
      if (!pRel || !iRel) {
        throw new SmokeError('补丁清单包含空路径产物。');
      }
      const srcArt = path.resolve(patchDir, pRel);
      const srcRelCheck = path.relative(patchDir, srcArt);
      if (!srcRelCheck || srcRelCheck.startsWith('..') || path.isAbsolute(srcRelCheck)) {
        throw new SmokeError(`补丁产物路径越界：${pRel}`);
      }
      if (isSymlinkPath(srcArt) || !fs.existsSync(srcArt) || !fs.statSync(srcArt).isFile()) {
        throw new SmokeError(`补丁产物缺失：${pRel}`);
      }
      const overlaid = overlaySingleFileIntoSandbox(sandboxDir, srcArt, iRel);
      if (art.action === 'replace' && !overlaid.existedBefore) {
        throw new SmokeError(
          `补丁清单产物「${iRel}」标记为 replace，但隔离沙箱中不存在同名原文件（游戏主程序位于 ${chosenExeRel}）；请核对 install_rel 是否缺少或多余游戏子目录前缀。`
        );
      }
      if (art.action === 'replace' && art.kind === 'replace_archive' && overlaid.existedBefore) {
        assertNoDestructiveShrinkReplace(
          {
            action: 'replace',
            targetRel: iRel,
            originalBytes: overlaid.originalBytes,
            replacementBytes: overlaid.bytes,
            contextLabel: 'vn_smoke_test(manifest)',
          },
          (msg) => new SmokeError(msg)
        );
      }
    }

    const exePath = resolveSandboxExeAndSave(sandboxDir, chosenExeRel);
    const detectedArch = readPeArchitecture(exePath);
    const exeArch =
      manifest.hook?.target_arch && manifest.hook.target_arch !== 'unknown'
        ? manifest.hook.target_arch
        : detectedArch !== 'unknown'
          ? detectedArch
          : exeInfo.arch;

    let usedProxyDll: string | undefined;
    const bundledProxyArt = manifest.artifacts.find(
      (art) => art.kind === 'hook_proxy' && typeof art.install_rel === 'string' && art.install_rel.trim()
    );
    if (bundledProxyArt) {
      usedProxyDll = path.posix.basename(toPosix(bundledProxyArt.install_rel));
    } else if (manifest.hook?.needed && manifest.hook.mode !== 'none') {
      const patchConfig = loadWorkspacePatchConfig(ws);
      const absChosenExe = path.join(ws, ...chosenExeRel.split('/'));
      const proxyDllName = manifest.hook.proxy_dll ?? chooseProxyDllName(absChosenExe, patchConfig.proxyDll);
      const resolvedProxy = resolvePrebuiltProxyDll(exeArch, proxyDllName, { binDir: options.proxyBinDir });
      if (resolvedProxy) {
        const rawExeDir = toPosix(path.posix.dirname(chosenExeRel));
        const exeDirPosix = rawExeDir && rawExeDir !== '.' ? rawExeDir : '';
        const proxyTargetRel = exeDirPosix ? `${exeDirPosix}/${proxyDllName}` : proxyDllName;
        overlaySingleFileIntoSandbox(sandboxDir, resolvedProxy.path, proxyTargetRel);

        const iniTargetRel = exeDirPosix ? `${exeDirPosix}/papercup_patch.ini` : 'papercup_patch.ini';
        const absSandboxIni = path.join(sandboxDir, ...iniTargetRel.split('/'));
        if (!fs.existsSync(absSandboxIni)) {
          const configRel = manifest.hook.config_file ? toPosix(manifest.hook.config_file) : 'papercup_patch.ini';
          const existingConfigInSandbox = path.join(sandboxDir, ...configRel.split('/'));
          if (
            !isSymlinkPath(existingConfigInSandbox) &&
            fs.existsSync(existingConfigInSandbox) &&
            fs.statSync(existingConfigInSandbox).isFile()
          ) {
            overlaySingleFileIntoSandbox(sandboxDir, existingConfigInSandbox, iniTargetRel);
          } else {
            const tmpIni = path.join(sandboxDir, `_papercup_tmp_patch_${process.pid}.ini`);
            const iniContent = buildPatchIni({
              engine: manifest.engine || 'custom',
              strategy: manifest.strategy || 'archive_replace',
              targetLang: manifest.target_lang || 'zh',
              targetEncoding: manifest.encoding?.target || 'gbk',
              hook: { ...manifest.hook, proxy_dll: proxyDllName },
            });
            fs.writeFileSync(tmpIni, iniContent, 'utf8');
            try {
              overlaySingleFileIntoSandbox(sandboxDir, tmpIni, iniTargetRel);
            } finally {
              fs.rmSync(tmpIni, { force: true });
            }
          }
        }
        usedProxyDll = proxyDllName;
      }
    }

    return {
      mode: 'manifest',
      runId,
      sandboxDir,
      manifest,
      manifestSha256,
      exeRel: chosenExeRel,
      exePath,
      exeArch,
      ...(usedProxyDll ? { usedProxyDll } : {}),
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Create an isolated hardlink sandbox directly from an external overlay directory
 * (e.g. a repacked v2 bundle directory) or a single replacement file (e.g. a repacked `data.pac`),
 * without requiring a `patch_manifest.json`.
 */
export function prepareSmokeSandboxFromOverlay(
  workspace: string,
  overlayPath: string,
  options: {
    overlayTarget?: string | null;
    exeOverride?: string;
    homeDir?: string | null;
  } = {}
): {
  mode: 'overlay';
  runId: string;
  sandboxDir: string;
  overlayPath: string;
  overlayTarget?: string;
  overlayDigest: string;
  overlayFiles: SmokeOverlayFileEntry[];
  exeRel: string;
  exePath: string;
  exeArch: 'x86' | 'x64' | 'unknown';
  cleanup: () => void;
} {
  const ws = realpathSafe(workspace);
  const wsPaths = resolveWorkspacePaths(ws);
  const absOverlay = path.isAbsolute(overlayPath) ? path.resolve(overlayPath) : path.resolve(ws, overlayPath);
  if (isSymlinkPath(absOverlay) || !fs.existsSync(absOverlay)) {
    throw new SmokeError(`覆盖文件或目录不存在（或为符号链接）：${overlayPath}`);
  }
  const st = fs.statSync(absOverlay);
  if (!st.isFile() && !st.isDirectory()) {
    throw new SmokeError(`overlayPath 必须是常规文件或目录：${overlayPath}`);
  }

  const exeInfo = inspectPrimaryGameExe(ws);
  const chosenExeRel = toPosix(options.exeOverride?.trim() || exeInfo.exeRel || '');
  if (!chosenExeRel) {
    throw new SmokeError('工作区中未找到游戏主程序 (.exe)，无法执行运行时冒烟测试；可通过 exe 参数显式指定。');
  }

  let resolvedTarget = options.overlayTarget?.trim() ? toPosix(options.overlayTarget.trim()).replace(/\/+$/, '') : '';
  if (st.isFile() && !resolvedTarget) {
    const baseLow = path.basename(absOverlay).toLowerCase();
    const detected = scanWorkspace(ws, options.homeDir ?? null).hits.filter(
      (h) => !isBackupOrNonOriginalArchiveRel(h.path) && path.basename(h.path).toLowerCase() === baseLow
    );
    if (detected.length === 1) {
      resolvedTarget = toPosix(detected[0].path);
    } else if (detected.length > 1) {
      throw new SmokeError(
        `overlayPath 是单文件「${path.basename(absOverlay)}」，工作区存在多个同名封包（${detected.map((d) => d.path).join('、')}），请通过 overlayTarget 显式指定目标相对路径。`
      );
    } else {
      throw new SmokeError(
        `overlayPath 是单文件「${path.basename(absOverlay)}」，请通过 overlayTarget 指定其在游戏目录中的相对路径（例如 gyakumajyo_try/data.pac）。`
      );
    }
  }

  const runId = `run-${Date.now()}-${String(++smokeRunSeq).padStart(3, '0')}-${process.pid}`;
  const sandboxDir = wsPaths.smokeSandboxDir(runId);
  fs.mkdirSync(sandboxDir, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on Windows file lock release
    }
  };

  try {
    hardlinkWorkspaceToSandbox(ws, sandboxDir, chosenExeRel);
    const sandboxBasenames = collectSandboxBasenameMap(sandboxDir);
    const overlayFiles: SmokeOverlayFileEntry[] = [];

    const stageCheckedOverlayFile = (srcFile: string, targetRel: string) => {
      const overlaid = overlaySingleFileIntoSandbox(sandboxDir, srcFile, targetRel);
      const ext = path.posix.extname(overlaid.rel).toLowerCase();
      if (overlaid.existedBefore && !NON_ARCHIVE_OVERLAY_EXTS.has(ext)) {
        assertNoDestructiveShrinkReplace(
          {
            action: 'replace',
            targetRel: overlaid.rel,
            originalBytes: overlaid.originalBytes,
            replacementBytes: overlaid.bytes,
            contextLabel: 'vn_smoke_test(overlay)',
          },
          (msg) => new SmokeError(msg)
        );
      }
      const { originalBytes: _orig, ...entry } = overlaid;
      overlayFiles.push(entry);
    };

    if (st.isFile()) {
      stageCheckedOverlayFile(absOverlay, resolvedTarget);
    } else {
      const prefix = resolvedTarget ? `${resolvedTarget.replace(/\/+$/, '')}/` : '';
      const walkOverlay = (curDir: string) => {
        for (const ent of fs.readdirSync(curDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(curDir, ent.name);
          if (isSymlinkPath(full)) continue;
          const low = ent.name.toLowerCase();
          if (ent.isDirectory()) {
            if (ent.name.startsWith('.')) continue;
            walkOverlay(full);
          } else if (ent.isFile()) {
            if (ent.name.startsWith('.') || low.endsWith('.bak')) continue;
            const relInside = toPosix(path.relative(absOverlay, full));
            if (resolvedTarget && pathStartsWithPrefix(relInside, resolvedTarget)) {
              throw new SmokeError(
                `overlayPath 目录内已包含「${resolvedTarget}/」子目录（命中 ${relInside}），再传 overlayTarget="${resolvedTarget}" 会导致双层嵌套路径且无法覆盖原文件；请省略 overlayTarget 后重试。`
              );
            }
            const targetRel = `${prefix}${relInside}`;
            stageCheckedOverlayFile(full, targetRel);
          }
        }
      };
      walkOverlay(absOverlay);
      if (!overlayFiles.length) {
        throw new SmokeError(`overlayPath 目录内没有可用于覆盖沙箱的文件：${overlayPath}`);
      }
      overlayFiles.sort((a, b) => a.rel.localeCompare(b.rel));
    }

    // General invariant: prevent silent no-op ("ghost") overlays that miss existing game files.
    const replacedAny = overlayFiles.some((f) => f.existedBefore);
    if (!replacedAny) {
      const misplacedHints: string[] = [];
      for (const f of overlayFiles) {
        const baseKey = path.posix.basename(f.rel).toLowerCase();
        const existingMatches = sandboxBasenames.get(baseKey);
        if (existingMatches && existingMatches.length > 0) {
          misplacedHints.push(`「${f.rel}」未命中原文件（沙箱中同名文件位于 ${existingMatches.slice(0, 2).join('、')}）`);
        }
      }
      if (misplacedHints.length > 0) {
        throw new SmokeError(
          `覆盖直测未替换任何已有游戏文件，疑似路径错位：${misplacedHints.slice(0, 3).join('；')}。请修正 overlayPath 目录结构或 overlayTarget。`
        );
      }
    }

    const overlayDigest = sha256Hex(
      Buffer.from(overlayFiles.map((f) => `${f.rel}:${f.sha256}`).join('\n'), 'utf8')
    );
    const exePath = resolveSandboxExeAndSave(sandboxDir, chosenExeRel);
    const detectedArch = readPeArchitecture(exePath);
    const exeArch = detectedArch !== 'unknown' ? detectedArch : exeInfo.arch;

    return {
      mode: 'overlay',
      runId,
      sandboxDir,
      overlayPath: absOverlay.replace(/\\/g, '/'),
      ...(resolvedTarget ? { overlayTarget: resolvedTarget } : {}),
      overlayDigest,
      overlayFiles,
      exeRel: chosenExeRel,
      exePath,
      exeArch,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Create an isolated hardlink sandbox under `.papercup/tmp/re-trace/<runId>/`
 * for read-only Win32 API / hardware-breakpoint tracing without touching original files.
 */
export function prepareReadOnlyTraceSandbox(
  workspace: string,
  exeRel: string
): {
  runId: string;
  sandboxDir: string;
  exeRel: string;
  exePath: string;
  exeArch: 'x86' | 'x64' | 'unknown';
  cleanup: () => void;
} {
  const ws = realpathSafe(workspace);
  const wsPaths = resolveWorkspacePaths(ws);
  const trimmedRel = toPosix(String(exeRel ?? '').trim()).replace(/^\.\//, '');
  if (!trimmedRel || path.isAbsolute(trimmedRel) || !trimmedRel.toLowerCase().endsWith('.exe')) {
    throw new SmokeError(`目标可执行文件必须是工作区内的 .exe 相对路径：${exeRel}`);
  }
  const absExe = path.resolve(ws, trimmedRel);
  const relCheck = path.relative(ws, absExe);
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new SmokeError(`目标可执行文件路径越界：${exeRel}`);
  }
  if (isSymlinkPath(absExe) || !fs.existsSync(absExe) || !fs.statSync(absExe).isFile()) {
    throw new SmokeError(`目标可执行文件不存在（或为符号链接）：${exeRel}`);
  }
  const realExe = realpathSafe(absExe);
  const realCheck = path.relative(ws, realExe);
  if (!realCheck || realCheck.startsWith('..') || path.isAbsolute(realCheck)) {
    throw new SmokeError(`目标可执行文件真实路径越界：${exeRel}`);
  }

  const normalizedExeRel = toPosix(relCheck);
  const runId = `trace-${Date.now()}-${String(++smokeRunSeq).padStart(3, '0')}-${process.pid}`;
  const sandboxDir = wsPaths.reTraceSandboxDir(runId);
  fs.mkdirSync(sandboxDir, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on Windows file lock release
    }
  };

  try {
    hardlinkWorkspaceToSandbox(ws, sandboxDir, normalizedExeRel);
    const exePath = resolveSandboxExeAndSave(sandboxDir, normalizedExeRel);
    const detectedArch = readPeArchitecture(exePath);
    const exeInfo = inspectPrimaryGameExe(ws);
    const exeArch = detectedArch !== 'unknown' ? detectedArch : exeInfo.arch;
    return {
      runId,
      sandboxDir,
      exeRel: normalizedExeRel,
      exePath,
      exeArch,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/* ========================= Rule Evaluation (ESLint-style) ========================= */

function normalizeMatchText(s: string): string {
  return s
    .replace(/\[[^\]]*\]|<[^>]*>/g, '')
    .replace(/[\s\u3000「」『』“”"'()（）【】…—\-.,，。！？!?]/g, '')
    .trim();
}

function normalizeMojibakeFingerprint(s: string): string {
  return s
    .replace(/\[[^\]]*\]|<[^>]*>/g, '')
    .replace(/[\uFFFD\uE000-\uF8FF\s\u3000]/g, '')
    .trim();
}

let cp932DecodeMapCache: Map<string, number[]> | null = null;
function getCp932ByteMapForMojibake(): Map<string, number[]> {
  if (cp932DecodeMapCache) return cp932DecodeMapCache;
  const map = new Map<string, number[]>();
  const dec = new TextDecoder('shift_jis', { fatal: true });
  const b1 = Buffer.alloc(1);
  for (let a = 0xa1; a <= 0xdf; a++) {
    b1[0] = a;
    try {
      const ch = dec.decode(b1);
      if (!map.has(ch)) map.set(ch, [a]);
    } catch {
      // ignore unmapped
    }
  }
  const b2 = Buffer.alloc(2);
  for (let a = 0x81; a <= 0xfc; a++) {
    if (a > 0x9f && a < 0xe0) continue;
    b2[0] = a;
    for (let c = 0x40; c <= 0xfc; c++) {
      if (c === 0x7f) continue;
      b2[1] = c;
      try {
        const ch = dec.decode(b2);
        if (!map.has(ch)) map.set(ch, [a, c]);
      } catch {
        // ignore unmapped
      }
    }
  }
  // Windows MultiByteToWideChar(932) maps single undefined lead/trailer bytes to PUA U+F8F0..U+F8F3
  map.set('\uF8F0', [0xa0]);
  map.set('\uF8F1', [0xfd]);
  map.set('\uF8F2', [0xfe]);
  map.set('\uF8F3', [0xff]);
  cp932DecodeMapCache = map;
  return map;
}

/**
 * Deterministic check for UTF-8 CJK bytes mis-decoded by a CP932/Shift_JIS engine
 * (e.g. "世界" -> "荳也阜" with 0 U+FFFD and 0 half-width katakana).
 * Re-encodes CP932 characters back to bytes and checks whether >=60% of non-ASCII bytes
 * form >=2 valid 3-byte UTF-8 CJK sequences (U+3000..U+303F / U+4E00..U+9FFF).
 */
function isUtf8DecodedAsCp932(line: string): boolean {
  const rev = getCp932ByteMapForMojibake();
  const bytes: number[] = [];
  let nonAsciiChars = 0;
  let unmappedNonAscii = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) {
      bytes.push(cp);
      continue;
    }
    nonAsciiChars++;
    const mapped = rev.get(ch);
    if (!mapped) {
      unmappedNonAscii++;
      bytes.push(0x00);
      continue;
    }
    for (const byte of mapped) bytes.push(byte);
  }
  if (nonAsciiChars < 3 || unmappedNonAscii > nonAsciiChars * 0.2) return false;
  let nonAsciiBytes = 0;
  for (const b of bytes) {
    if (b >= 0x80) nonAsciiBytes++;
  }
  if (nonAsciiBytes < 6) return false;
  let validTriplets = 0;
  let i = 0;
  while (i < bytes.length) {
    const x = bytes[i];
    if (x >= 0xe3 && x <= 0xe9 && i + 2 < bytes.length) {
      const y = bytes[i + 1];
      const z = bytes[i + 2];
      if (y >= 0x80 && y <= 0xbf && z >= 0x80 && z <= 0xbf) {
        const cp = ((x & 0x0f) << 12) | ((y & 0x3f) << 6) | (z & 0x3f);
        if ((cp >= 0x3000 && cp <= 0x303f) || (cp >= 0x4e00 && cp <= 0x9fff)) {
          validTriplets++;
          i += 3;
          continue;
        }
      }
    }
    i++;
  }
  return validTriplets >= 2 && (validTriplets * 3) / nonAsciiBytes >= 0.6;
}

function bestProbeMatchLength(norm: string, probes: readonly string[]): number {
  let best = 0;
  for (const p of probes) {
    if (p.includes(norm) || norm.includes(p)) {
      const len = Math.min(norm.length, p.length);
      if (len > best) best = len;
    }
  }
  return best;
}

function analyzeTextractorSamples(
  lines: string[],
  workspace: string,
  targetLang: string,
  extraSampleTargets: readonly string[] = []
): {
  linesCaptured: number;
  matchedTranslated: number;
  matchedSource: number;
  mojibakeLines: string[];
  sampleLines: string[];
} {
  const isZh = /^zh(?:[-_]|$)/i.test(targetLang.trim());
  const sources: string[] = [];
  const targets: string[] = [];
  const mojibakeFingerprints: string[] = [];
  const mojibakeFpSet = new Set<string>();
  const looseSjisDecoder = isZh ? new TextDecoder('shift_jis', { fatal: false }) : null;
  let fingerprintRows = 0;

  const addMojibakeFingerprints = (rawTarget: string) => {
    if (!looseSjisDecoder || !rawTarget || fingerprintRows >= 3000) return;
    const cleanTarget = rawTarget.replace(/\[[^\]]*\]|<[^>]*>/g, '').trim();
    if (cleanTarget.length >= 2 && /[^\x00-\x7F]/.test(cleanTarget)) {
      fingerprintRows++;
      const addFp = (decoded: string) => {
        if (decoded === cleanTarget) return;
        const fpNorm = normalizeMojibakeFingerprint(decoded);
        if (fpNorm.length >= 3 && !mojibakeFpSet.has(fpNorm)) {
          mojibakeFpSet.add(fpNorm);
          mojibakeFingerprints.push(fpNorm);
        }
      };
      addFp(looseSjisDecoder.decode(Buffer.from(cleanTarget, 'utf8')));
      try {
        const gbkBuf = encodeText(cleanTarget, 'gbk');
        addFp(looseSjisDecoder.decode(gbkBuf));
      } catch {
        // ignore lines containing non-GBK characters
      }
    }
  };

  for (const extra of extraSampleTargets) {
    const rawTarget = String(extra || '').trim();
    if (!rawTarget) continue;
    const t = normalizeMatchText(rawTarget);
    if (t.length >= 3) targets.push(t);
    addMojibakeFingerprints(rawTarget);
  }

  const wsPaths = resolveWorkspacePaths(workspace);
  for (const track of TRACKS) {
    const fp = wsPaths.resultsTrackFile(track);
    if (isSymlinkPath(fp) || !fs.existsSync(fp)) continue;
    try {
      for (const row of readResultsJsonl(fp)) {
        const rawSource = String(row.source || '').trim();
        const rawTarget = String(row.target || '').trim();
        const s = normalizeMatchText(rawSource);
        const t = normalizeMatchText(rawTarget);
        // Filter out identical source === target lines (e.g. shared kanji speaker/location names)
        // so an unpatched Japanese game can never bypass text.not_patched via homographs.
        if (!(s && t && s === t)) {
          if (s.length >= 3) sources.push(s);
          if (t.length >= 3) targets.push(t);
        }
        // Build deterministic mis-decoding fingerprints (UTF-8->CP932 and GBK->CP932) from known targets
        addMojibakeFingerprints(rawTarget);
      }
    } catch {
      // ignore unreadable track file
    }
  }

  let matchedTranslated = 0;
  let matchedSource = 0;
  const mojibakeLines: string[] = [];
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);

    const norm = normalizeMatchText(trimmed);
    let hitTarget = false;
    let hitSource = false;
    if (norm.length >= 3) {
      const targetLen = bestProbeMatchLength(norm, targets);
      const sourceLen = bestProbeMatchLength(norm, sources);
      if (targetLen > 0 && sourceLen === 0) {
        hitTarget = true;
        matchedTranslated++;
      } else if (sourceLen > 0 && targetLen === 0) {
        hitSource = true;
        matchedSource++;
      } else if (targetLen > sourceLen) {
        hitTarget = true;
        matchedTranslated++;
      } else if (sourceLen > targetLen) {
        hitSource = true;
        matchedSource++;
      }
    }

    // Detect mojibake:
    // 1. Unicode replacement char U+FFFD
    // 2. Private Use Area U+E000..U+F8FF (e.g. Windows CP932 0xA0 -> U+F8F0) on non-matching zh lines
    // 3. Deterministic mis-decoding fingerprint match against workspace results/*.jsonl targets
    // 4. Mathematical CP932 -> UTF-8 CJK round-trip detection (catches all-kanji UTF-8-as-CP932 & short UI text)
    // 5. Half-width Katakana burst (classic GBK-as-CP932, including short UI text >= 3 non-ASCII chars)
    const hasReplacement = trimmed.includes('\uFFFD');
    const hasPua = isZh && !hitTarget && !hitSource && /[\uE000-\uF8FF]/.test(trimmed);
    const nonAscii = trimmed.replace(/[\x00-\x7F]/g, '');
    const halfKana = (trimmed.match(/[\uFF61-\uFF9F]/g) ?? []).length;
    const hasHalfKanaBurst =
      isZh &&
      !hitTarget &&
      !hitSource &&
      ((nonAscii.length >= 6 && halfKana >= 4 && halfKana / nonAscii.length >= 0.15) ||
        (nonAscii.length >= 3 && halfKana >= 3 && halfKana / nonAscii.length >= 0.5));
    const fpNorm = isZh && !hitTarget && !hitSource ? normalizeMojibakeFingerprint(trimmed) : '';
    const hitsKnownFingerprint =
      fpNorm.length >= 3 &&
      mojibakeFingerprints.some((fp) => fp.includes(fpNorm) || fpNorm.includes(fp));
    const isUtf8AsCp932Hit = isZh && !hitTarget && !hitSource && isUtf8DecodedAsCp932(trimmed);

    if (hasReplacement || hasPua || hitsKnownFingerprint || isUtf8AsCp932Hit || hasHalfKanaBurst) {
      mojibakeLines.push(trimmed);
    }
  }

  return {
    linesCaptured: deduped.length,
    matchedTranslated,
    matchedSource,
    mojibakeLines,
    sampleLines: deduped.slice(0, 12),
  };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Deterministic pure-TS check for solid/uniform-color PNG screenshots (e.g. stuck black/white screen).
 * Supports standard 8-bit non-interlaced RGB (colorType=2) and RGBA (colorType=6) PNGs.
 * Returns `{ uniform: false }` for unreadable, tiny (<16x16), or unsupported mock files.
 */
export function isUniformColorPng(filePath: string): { uniform: boolean; r?: number; g?: number; b?: number } {
  try {
    if (!filePath || isSymlinkPath(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { uniform: false };
    }
    const buf = fs.readFileSync(filePath);
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return { uniform: false };
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = 0;
    const idatParts: Buffer[] = [];
    let off = 8;
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.subarray(off + 4, off + 8).toString('ascii');
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > buf.length) break;
      if (type === 'IHDR' && len >= 13) {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'IDAT') {
        idatParts.push(buf.subarray(dataStart, dataEnd));
      } else if (type === 'IEND') {
        break;
      }
      off = dataEnd + 4;
    }
    if (
      width < 16 ||
      height < 16 ||
      width * height > 16_000_000 ||
      bitDepth !== 8 ||
      interlace !== 0 ||
      (colorType !== 2 && colorType !== 6) ||
      idatParts.length === 0
    ) {
      return { uniform: false };
    }
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idatParts));
    if (raw.length < height * (stride + 1)) return { uniform: false };

    let prevRow = new Uint8Array(stride);
    let curRow = new Uint8Array(stride);
    let r0 = -1;
    let g0 = -1;
    let b0 = -1;
    const tolerance = 4;

    for (let y = 0; y < height; y++) {
      const rowOff = y * (stride + 1);
      const filter = raw[rowOff];
      for (let i = 0; i < stride; i++) {
        const x = raw[rowOff + 1 + i];
        const a = i >= bpp ? curRow[i - bpp] : 0;
        const b = prevRow[i];
        const c = i >= bpp ? prevRow[i - bpp] : 0;
        let val = x;
        if (filter === 1) val = (x + a) & 0xff;
        else if (filter === 2) val = (x + b) & 0xff;
        else if (filter === 3) val = (x + ((a + b) >> 1)) & 0xff;
        else if (filter === 4) val = (x + paethPredictor(a, b, c)) & 0xff;
        else if (filter !== 0) return { uniform: false };
        curRow[i] = val;
      }
      for (let px = 0; px < width; px++) {
        const idx = px * bpp;
        const r = curRow[idx];
        const g = curRow[idx + 1];
        const bl = curRow[idx + 2];
        if (r0 < 0) {
          r0 = r;
          g0 = g;
          b0 = bl;
        } else if (
          Math.abs(r - r0) > tolerance ||
          Math.abs(g - g0) > tolerance ||
          Math.abs(bl - b0) > tolerance
        ) {
          return { uniform: false };
        }
      }
      const swap = prevRow;
      prevRow = curRow;
      curRow = swap;
    }
    return { uniform: true, r: r0, g: g0, b: b0 };
  } catch {
    return { uniform: false };
  }
}

export function evaluateSmokeRules(params: {
  driverResult: SmokeDriverRunResult;
  workspace: string;
  targetLang: string;
  textractorConfigured: boolean;
  textractorArchMismatch?: { exeArch: 'x86' | 'x64' };
  leProfileWarning?: string;
  visionEnabled: boolean;
  visionSkippedByParam?: boolean;
  probeMode?: 'post_translate' | 'pre_translate';
  extraSampleTargets?: readonly string[];
  visionInspection?: {
    status: 'checked' | 'skipped';
    reason?: string;
    defects: SmokeVisionDefect[];
  };
}): {
  findings: SmokeFinding[];
  textractorSummary: NonNullable<SmokeReport['textractor']>;
  crash?: SmokeCrashInfo;
} {
  const {
    driverResult,
    workspace,
    targetLang,
    textractorConfigured,
    textractorArchMismatch,
    leProfileWarning,
    visionEnabled,
    visionSkippedByParam = false,
    probeMode = 'post_translate',
    extraSampleTargets = [],
    visionInspection,
  } = params;
  const isPreTranslateProbe = probeMode === 'pre_translate';
  const findings: SmokeFinding[] = [];
  const add = (ruleId: SmokeRuleId, severity: SmokeRuleSeverity, message: string, evidence?: Record<string, unknown>) => {
    findings.push(evidence ? { ruleId, severity, message, evidence } : { ruleId, severity, message });
  };

  if (leProfileWarning) {
    add('runtime.locale_emulator_profile_missing', 'warning', leProfileWarning);
  }

  if (driverResult.harnessFailed) {
    add(
      'harness.driver_failed',
      'error',
      `冒烟测试驱动自身启动或执行失败（工具故障，非补丁问题）：${
        driverResult.harnessError || driverResult.launchError || '驱动未在游戏启动前正常回报就绪状态。'
      }`,
      {
        driverExitCode: driverResult.driverLog?.exitCode ?? null,
      }
    );
  } else if (!driverResult.launched || !driverResult.windowFound) {
    const isWaitTimeout = Boolean(driverResult.windowWaitTimeout && !driverResult.processExitedEarly);
    const defaultLaunchMsg = isWaitTimeout
      ? '游戏进程已启动且仍在运行，但在等待超时内未出现可见主窗口（可能卡在图形/资源初始化、后台启动器或未识别模态窗口）。'
      : '游戏进程无法正常启动或未出现可见窗口即退出。';
    add(
      'runtime.launch_failed',
      'error',
      driverResult.launchError || defaultLaunchMsg,
      {
        exitCode: driverResult.exitCode ?? null,
        crashEvent: driverResult.crashEvent ?? null,
        processExitedEarly: driverResult.processExitedEarly,
        windowWaitTimeout: isWaitTimeout,
        ...(driverResult.observedWindows?.length ? { observedWindows: driverResult.observedWindows } : {}),
      }
    );
  }

  const canBeBenignEarlyExit = Boolean(
    driverResult.processExitedEarly &&
      driverResult.launched &&
      driverResult.windowFound &&
      !driverResult.crashEvent &&
      !driverResult.errorDialog &&
      driverResult.exitCode === 0
  );
  const existingExitFrames = canBeBenignEarlyExit
    ? driverResult.frames.filter((f) => Boolean(f.path && fs.existsSync(f.path)))
    : [];
  const hasNonUniformExitFrame = existingExitFrames.some((f) => !isUniformColorPng(f.path).uniform);
  const isBenignEarlyExit =
    canBeBenignEarlyExit && hasNonUniformExitFrame && driverResult.stepsAdvanced >= 3;

  const crashInfo: SmokeCrashInfo | undefined =
    driverResult.crashEvent ||
    (driverResult.processExitedEarly && driverResult.exitCode !== 0)
      ? {
          exitCode: driverResult.exitCode ?? null,
          ...(driverResult.crashEvent || {}),
        }
      : undefined;

  if (isBenignEarlyExit) {
    add(
      'runtime.early_exit',
      'warning',
      `游戏在推进 ${driverResult.stepsAdvanced} 步后以退出码 0 提前结束（已捕获有效画面且无崩溃事件/错误弹窗，可能点中了退出选项或返回了启动器）。`,
      {
        step: driverResult.stepsAdvanced,
        exitCode: 0,
        ...(driverResult.mainProcessName ? { mainProcessName: driverResult.mainProcessName } : {}),
      }
    );
  } else if (
    driverResult.crashEvent ||
    (driverResult.processExitedEarly && driverResult.launched && driverResult.windowFound)
  ) {
    const parts: string[] = ['游戏在运行时发生崩溃或异常退出'];
    if (crashInfo?.exceptionCode) parts.push(`异常码 ${crashInfo.exceptionCode}`);
    if (crashInfo?.faultingModule && crashInfo?.faultOffset) {
      parts.push(`故障地址 ${crashInfo.faultingModule}+${crashInfo.faultOffset}`);
    } else if (crashInfo?.faultOffset) {
      parts.push(`故障偏移 ${crashInfo.faultOffset}`);
    }
    if (typeof driverResult.exitCode === 'number' && driverResult.exitCode !== 0) {
      parts.push(`退出码 0x${(driverResult.exitCode >>> 0).toString(16)}`);
    }
    add('runtime.crash', 'error', `${parts.join('，')}。`, {
      step: driverResult.stepsAdvanced,
      ...crashInfo,
    });
  }

  if (driverResult.errorDialog) {
    add(
      'runtime.error_dialog',
      'error',
      `游戏弹出错误对话框「${driverResult.errorDialog.title || 'Error'}」：${driverResult.errorDialog.text || '(无正文)'}`,
      { dialog: driverResult.errorDialog }
    );
  }

  if (driverResult.hungDetected) {
    add('runtime.hang', 'error', '检测到游戏主窗口无响应（IsHungAppWindow = true）。', {
      stepsAdvanced: driverResult.stepsAdvanced,
    });
  } else if (driverResult.frozenScreen && driverResult.windowFound && !driverResult.processExitedEarly) {
    const existingFrames = driverResult.frames.filter((f) => Boolean(f.path && fs.existsSync(f.path)));
    const uniformChecks = existingFrames.map((f) => isUniformColorPng(f.path));
    const allUniformBlank = existingFrames.length > 0 && uniformChecks.every((u) => u.uniform);
    if (allUniformBlank) {
      const sample = uniformChecks[0];
      add(
        'runtime.hang',
        'error',
        `推进 ${driverResult.stepsAdvanced} 步期间所有截图均停留在纯色/黑屏静止画面（RGB(${sample.r},${sample.g},${sample.b})），疑似补丁损坏或加载卡死。`,
        {
          inputMode: driverResult.inputMode,
          stepsAdvanced: driverResult.stepsAdvanced,
          uniformColorFrames: true,
          rgb: [sample.r, sample.g, sample.b],
        }
      );
    } else {
      add(
        'runtime.hang',
        'warning',
        `推进 ${driverResult.stepsAdvanced} 步期间画面未检测到变化（可能卡在标题按钮、需要鼠标交互或输入未生效）。`,
        { inputMode: driverResult.inputMode, stepsAdvanced: driverResult.stepsAdvanced }
      );
    }
  }

  const trStats = analyzeTextractorSamples(
    driverResult.textractorLines,
    workspace,
    targetLang,
    extraSampleTargets
  );
  if (textractorArchMismatch) {
    add(
      'hook.unavailable',
      'warning',
      `已配置 Textractor CLI，但缺少与目标程序架构（${textractorArchMismatch.exeArch}）匹配的 TextractorCLI.exe（禁止跨架构注入），已跳过挂钩文本校验。`,
      { exeArch: textractorArchMismatch.exeArch }
    );
  } else if (!textractorConfigured) {
    add('hook.unavailable', 'warning', '未配置 Textractor CLI，已跳过挂钩文本校验（可在设置页配置路径启用）。');
  } else if (trStats.linesCaptured === 0) {
    add('hook.unavailable', 'warning', 'Textractor CLI 未抓取到有效渲染文本（冷门引擎可能需要特殊钩子），已降级为崩溃/卡死与视觉检查。');
  } else {
    if (trStats.mojibakeLines.length > 0) {
      add(
        'text.mojibake',
        'error',
        `Textractor 抓取到 ${trStats.mojibakeLines.length} 条疑似乱码/CP932 字节错位文本（示例：${trStats.mojibakeLines[0].slice(0, 60)}）。`,
        { samples: trStats.mojibakeLines.slice(0, 5) }
      );
    }
    if (
      !isPreTranslateProbe &&
      trStats.matchedSource >= 2 &&
      (trStats.matchedTranslated === 0 || trStats.matchedSource > trStats.matchedTranslated * 2)
    ) {
      add(
        'text.not_patched',
        'error',
        trStats.matchedTranslated === 0
          ? `Textractor 抓取到 ${trStats.matchedSource} 条原版日文台词且 0 条命中译文，补丁可能未生效。`
          : `Textractor 抓取到 ${trStats.matchedSource} 条原版日文台词，远高于命中的 ${trStats.matchedTranslated} 条译文，补丁可能未生效或部分脚本未替换。`,
        { matchedSource: trStats.matchedSource, matchedTranslated: trStats.matchedTranslated, samples: trStats.sampleLines.slice(0, 5) }
      );
    }
  }

  if (!visionEnabled) {
    add(
      'vision.skipped',
      'warning',
      visionSkippedByParam
        ? '本次调用显式传入 skipVision=true，已跳过云端多模态视觉检查。'
        : '设置中未启用云端多模态视觉检查，已跳过截图缺陷审查。',
      visionSkippedByParam ? { skippedByParam: true } : undefined
    );
  } else if (visionInspection) {
    if (visionInspection.status === 'skipped') {
      add('vision.skipped', 'warning', visionInspection.reason || '视觉检查已降级跳过。');
    } else {
      for (const defect of visionInspection.defects) {
        if (isPreTranslateProbe && defect.kind === 'untranslated_dialogue') {
          continue;
        }
        add(
          'vision.defect',
          defect.severity === 'error' ? 'error' : 'warning',
          `[${defect.kind}] ${defect.description}${defect.frame ? `（帧：${defect.frame}）` : ''}`,
          { ...defect }
        );
      }
    }
  }

  return {
    findings,
    textractorSummary: {
      available: textractorConfigured && trStats.linesCaptured > 0,
      linesCaptured: trStats.linesCaptured,
      matchedTranslated: trStats.matchedTranslated,
      matchedSource: trStats.matchedSource,
      sampleLines: trStats.sampleLines,
    },
    crash: crashInfo,
  };
}

/* ========================= Windows Win32 Native Driver ========================= */

const WINDOWS_SMOKE_DRIVER_PS1 = String.raw`
param(
  [string]$ExePath,
  [string]$WorkDir,
  [string]$FramesDir,
  [int]$TimeoutSec = 90,
  [int]$AdvanceSteps = 25,
  [int]$MaxScreenshots = 4,
  [string]$LeProcPath = '',
  [string]$LeProfileGuid = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing | Out-Null

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace PaperCupSmoke {
  public class WinInfo {
    public IntPtr Hwnd;
    public uint Pid;
    public string Title;
    public string ClassName;
    public int Width;
    public int Height;
  }

  public static class Native {
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const int JobObjectBasicProcessIdList = 3;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint STILL_ACTIVE = 259;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint MK_LBUTTON = 0x0001;
    public const uint PW_CLIENTONLY = 0x00000001;
    public const uint PW_RENDERFULLCONTENT = 0x00000002;
    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const int GWL_STYLE = -16;
    public const int BS_TYPEMASK = 0x0F;
    public const int BS_PUSHBUTTON = 0x00;
    public const int BS_DEFPUSHBUTTON = 0x01;
    public const int BS_SPLITBUTTON = 0x0C;
    public const int BS_DEFSPLITBUTTON = 0x0D;
    public const int BS_COMMANDLINK = 0x0E;
    public const int BS_DEFCOMMANDLINK = 0x0F;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
      public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
      public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
      public int dx, dy;
      public uint mouseData, dwFlags, time;
      public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
      public ushort wVk, wScan;
      public uint dwFlags, time;
      public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
      public uint type;
      public INPUTUNION U;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, out uint lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static void EnableDpiAwareness() {
      try {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
        if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) {
          SetProcessDPIAware();
        }
      } catch {
        try {
          SetProcessDPIAware();
        } catch {}
      }
    }

    public static IntPtr CreateKillOnCloseJob() {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return IntPtr.Zero;
      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr ptr = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(info, ptr, false);
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size);
      } finally {
        Marshal.FreeHGlobal(ptr);
      }
      return job;
    }

    public static HashSet<uint> GetJobPids(IntPtr job, uint rootPid) {
      var pids = new HashSet<uint>();
      if (rootPid > 0) pids.Add(rootPid);
      if (job == IntPtr.Zero) return pids;
      int bufSize = 8 + 64 * IntPtr.Size;
      IntPtr buf = Marshal.AllocHGlobal(bufSize);
      try {
        uint retLen;
        if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf, (uint)bufSize, out retLen)) {
          int count = Marshal.ReadInt32(buf, 4);
          for (int i = 0; i < count && i < 64; i++) {
            long pidVal = IntPtr.Size == 8
              ? Marshal.ReadInt64(buf, 8 + i * 8)
              : Marshal.ReadInt32(buf, 8 + i * 4);
            if (pidVal > 0) pids.Add((uint)pidVal);
          }
        }
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      return pids;
    }

    public static List<WinInfo> FindJobWindows(HashSet<uint> pids) {
      var list = new List<WinInfo>();
      EnumWindows((hwnd, l) => {
        if (!IsWindowVisible(hwnd)) return true;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (!pids.Contains(pid)) return true;
        RECT rc;
        GetClientRect(hwnd, out rc);
        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w < 60 || h < 40) return true;
        var sbTitle = new StringBuilder(512);
        GetWindowTextW(hwnd, sbTitle, sbTitle.Capacity);
        var sbCls = new StringBuilder(256);
        GetClassNameW(hwnd, sbCls, sbCls.Capacity);
        list.Add(new WinInfo {
          Hwnd = hwnd, Pid = pid, Title = sbTitle.ToString(),
          ClassName = sbCls.ToString(), Width = w, Height = h
        });
        return true;
      }, IntPtr.Zero);
      return list;
    }

    public static string ReadDialogText(IntPtr hwnd) {
      var parts = new List<string>();
      EnumChildWindows(hwnd, (child, l) => {
        var sbCls = new StringBuilder(128);
        GetClassNameW(child, sbCls, sbCls.Capacity);
        string cls = sbCls.ToString();
        if (string.Equals(cls, "Button", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "ComboBox", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "ComboBoxEx32", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "ListBox", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "SysTabControl32", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "msctls_trackbar32", StringComparison.OrdinalIgnoreCase)) {
          return true;
        }
        var sb = new StringBuilder(512);
        GetWindowTextW(child, sb, sb.Capacity);
        string t = sb.ToString().Trim();
        if (t.Length > 0) parts.Add(t);
        return true;
      }, IntPtr.Zero);
      return string.Join(" | ", parts);
    }

    private static bool HasErrorKeyword(string s) {
      if (string.IsNullOrEmpty(s)) return false;
      string low = s.ToLowerInvariant();
      string[] keys = new string[] {
        "error", "exception", "crash", "fatal", "failed", "failure", "fault", "abort", "corrupt", "assert",
        "\u30a8\u30e9\u30fc", "\u4f8b\u5916", "\u5931\u6557", "\u7570\u5e38", "\u81f4\u547d",
        "\u9519\u8bef", "\u5f02\u5e38", "\u5931\u8d25", "\u5d29\u6e83", "\u65e0\u6cd5"
      };
      for (int i = 0; i < keys.Length; i++) {
        if (low.IndexOf(keys[i], StringComparison.Ordinal) >= 0) return true;
      }
      return false;
    }

    public static bool IsErrorDialog(IntPtr hwnd, string title, string text) {
      if (HasErrorKeyword(title) || HasErrorKeyword(text)) return true;
      if (string.IsNullOrWhiteSpace(text)) return false;
      bool hasConfigControl = false;
      EnumChildWindows(hwnd, (child, l) => {
        var sbCls = new StringBuilder(128);
        GetClassNameW(child, sbCls, sbCls.Capacity);
        string cls = sbCls.ToString();
        if (string.Equals(cls, "ComboBox", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "ComboBoxEx32", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "ListBox", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "SysTabControl32", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "msctls_trackbar32", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(cls, "msctls_updown32", StringComparison.OrdinalIgnoreCase)) {
          hasConfigControl = true;
          return false;
        }
        if (string.Equals(cls, "Button", StringComparison.OrdinalIgnoreCase)) {
          int btnType = GetWindowLongW(child, GWL_STYLE) & BS_TYPEMASK;
          bool isPush = btnType == BS_PUSHBUTTON || btnType == BS_DEFPUSHBUTTON ||
                        btnType == BS_SPLITBUTTON || btnType == BS_DEFSPLITBUTTON ||
                        btnType == BS_COMMANDLINK || btnType == BS_DEFCOMMANDLINK;
          if (!isPush) {
            hasConfigControl = true;
            return false;
          }
        }
        return true;
      }, IntPtr.Zero);
      return !hasConfigControl;
    }

    public static bool IsBitmapUniformColor(Bitmap bmp) {
      if (bmp == null || bmp.Width <= 0 || bmp.Height <= 0) return true;
      var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
      BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        int stride = Math.Abs(data.Stride);
        int totalBytes = stride * bmp.Height;
        if (totalBytes < 4) return true;
        byte[] buf = new byte[totalBytes];
        Marshal.Copy(data.Scan0, buf, 0, totalBytes);
        byte b0 = buf[0], g0 = buf[1], r0 = buf[2];
        int stepY = Math.Max(1, bmp.Height / 64);
        int stepX = Math.Max(1, bmp.Width / 64);
        for (int y = 0; y < bmp.Height; y += stepY) {
          int rowOff = y * stride;
          for (int x = 0; x < bmp.Width; x += stepX) {
            int p = rowOff + x * 4;
            if (Math.Abs(buf[p] - b0) > 2 || Math.Abs(buf[p + 1] - g0) > 2 || Math.Abs(buf[p + 2] - r0) > 2) {
              return false;
            }
          }
        }
        return true;
      } finally {
        bmp.UnlockBits(data);
      }
    }

    public static string CaptureClientPng(IntPtr hwnd, string outPath, out int width, out int height, out bool isUniform) {
      RECT rc;
      GetClientRect(hwnd, out rc);
      width = Math.Max(1, rc.Right - rc.Left);
      height = Math.Max(1, rc.Bottom - rc.Top);
      Bitmap activeBmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
      try {
        bool ok = false;
        using (var g = Graphics.FromImage(activeBmp)) {
          IntPtr hdc = g.GetHdc();
          try {
            ok = PrintWindow(hwnd, hdc, PW_CLIENTONLY | PW_RENDERFULLCONTENT);
          } finally {
            g.ReleaseHdc(hdc);
          }
        }
        if (!ok || IsBitmapUniformColor(activeBmp)) {
          POINT pt = new POINT { X = 0, Y = 0 };
          if (ClientToScreen(hwnd, ref pt) && pt.X > -32000 && pt.Y > -32000) {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            System.Threading.Thread.Sleep(120);
            var screenBmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            try {
              using (var sg = Graphics.FromImage(screenBmp)) {
                sg.CopyFromScreen(pt.X, pt.Y, 0, 0, new Size(width, height));
              }
              if (!ok || !IsBitmapUniformColor(screenBmp)) {
                activeBmp.Dispose();
                activeBmp = screenBmp;
                screenBmp = null;
              }
            } finally {
              if (screenBmp != null) screenBmp.Dispose();
            }
          }
        }
        isUniform = IsBitmapUniformColor(activeBmp);
        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
        activeBmp.Save(outPath, ImageFormat.Png);
        using (var sha = SHA256.Create())
        using (var ms = new MemoryStream()) {
          activeBmp.Save(ms, ImageFormat.Png);
          return BitConverter.ToString(sha.ComputeHash(ms.ToArray())).Replace("-", "").ToLowerInvariant();
        }
      } finally {
        if (activeBmp != null) activeBmp.Dispose();
      }
    }

    public static string CaptureClientPng(IntPtr hwnd, string outPath, out int width, out int height) {
      bool ignoredUniform;
      return CaptureClientPng(hwnd, outPath, out width, out height, out ignoredUniform);
    }

    public static void PostKey(IntPtr hwnd, int vk) {
      PostMessageW(hwnd, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
      System.Threading.Thread.Sleep(40);
      PostMessageW(hwnd, WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
    }

    public static void PostClick(IntPtr hwnd, int x, int y) {
      IntPtr lp = (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF));
      PostMessageW(hwnd, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lp);
      System.Threading.Thread.Sleep(50);
      PostMessageW(hwnd, WM_LBUTTONUP, IntPtr.Zero, lp);
    }

    public static void SendForegroundKey(IntPtr hwnd, ushort vk) {
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
      System.Threading.Thread.Sleep(80);
      var inputs = new INPUT[2];
      inputs[0].type = INPUT_KEYBOARD;
      inputs[0].U.ki.wVk = vk;
      inputs[1].type = INPUT_KEYBOARD;
      inputs[1].U.ki.wVk = vk;
      inputs[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
      SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendForegroundClick(IntPtr hwnd, int clientX, int clientY) {
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
      System.Threading.Thread.Sleep(80);
      POINT pt = new POINT { X = clientX, Y = clientY };
      if (!ClientToScreen(hwnd, ref pt)) return;
      SetCursorPos(pt.X, pt.Y);
      System.Threading.Thread.Sleep(40);
      var inputs = new INPUT[2];
      inputs[0].type = INPUT_MOUSE;
      inputs[0].U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
      inputs[1].type = INPUT_MOUSE;
      inputs[1].U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
      SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing | Out-Null
[PaperCupSmoke.Native]::EnableDpiAwareness()

function Emit-Json($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

$launchStart = (Get-Date).AddSeconds(-2)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$job = [PaperCupSmoke.Native]::CreateKillOnCloseJob()
$proc = $null
$processStarted = $false
$framesList = New-Object System.Collections.Generic.List[object]
$inputMode = 'background'
$stepsAdvanced = 0
$windowFound = $false
$windowTitle = ''
$processExitedEarly = $false
$windowWaitTimeout = $false
$observedWindows = @()
$exitCode = $null
$hungDetected = $false
$errorDialog = $null
$distinctHashes = New-Object System.Collections.Generic.HashSet[string]
$observedProcessNamesSet = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)
$exeBaseName = [System.IO.Path]::GetFileName($ExePath)
if (-not [string]::IsNullOrWhiteSpace($exeBaseName)) { $observedProcessNamesSet.Add($exeBaseName) | Out-Null }
$mainProcessName = ''
$mainProcHandle = [IntPtr]::Zero
$trackedMainPid = [uint32]0

function Record-JobProcesses($jobPids) {
  if ($null -eq $jobPids) { return }
  foreach ($jp in $jobPids) {
    try {
      $pObj = [System.Diagnostics.Process]::GetProcessById([int]$jp)
      try {
        if ($null -ne $pObj -and -not [string]::IsNullOrWhiteSpace($pObj.ProcessName)) {
          $observedProcessNamesSet.Add(($pObj.ProcessName + '.exe')) | Out-Null
        }
      } finally {
        $pObj.Dispose()
      }
    } catch {}
  }
}

function Track-MainProcess($win) {
  if ($null -eq $win) { return }
  $wpid = [uint32]$win.Pid
  if ($wpid -eq 0 -or $wpid -eq $script:trackedMainPid) { return }
  if ($script:mainProcHandle -ne [IntPtr]::Zero) {
    [PaperCupSmoke.Native]::CloseHandle($script:mainProcHandle) | Out-Null
    $script:mainProcHandle = [IntPtr]::Zero
  }
  $script:trackedMainPid = $wpid
  $script:mainProcHandle = [PaperCupSmoke.Native]::OpenProcess([PaperCupSmoke.Native]::PROCESS_QUERY_LIMITED_INFORMATION, $false, $wpid)
  try {
    $mp = [System.Diagnostics.Process]::GetProcessById([int]$wpid)
    try {
      if ($null -ne $mp -and -not [string]::IsNullOrWhiteSpace($mp.ProcessName)) {
        $script:mainProcessName = $mp.ProcessName + '.exe'
        $script:observedProcessNamesSet.Add($script:mainProcessName) | Out-Null
      }
    } finally {
      $mp.Dispose()
    }
  } catch {}
}

Emit-Json @{ event = 'driver_ready' }

try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  if (-not [string]::IsNullOrWhiteSpace($LeProcPath) -and (Test-Path -LiteralPath $LeProcPath)) {
    $psi.FileName = $LeProcPath
    if (-not [string]::IsNullOrWhiteSpace($LeProfileGuid)) {
      $psi.Arguments = '-runas ' + $LeProfileGuid + ' "' + $ExePath + '"'
    } else {
      $psi.Arguments = '-run "' + $ExePath + '"'
    }
  } else {
    $psi.FileName = $ExePath
  }
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  if ($null -eq $proc) {
    throw "Process failed to start"
  }
  $processStarted = $true
  if ($job -ne [IntPtr]::Zero) {
    [PaperCupSmoke.Native]::AssignProcessToJobObject($job, $proc.Handle) | Out-Null
  }

  # Wait for visible game window (15..25s scaled by TimeoutSec)
  $mainWin = $null
  $dismissedSetupHwnds = New-Object System.Collections.Generic.HashSet[Int64]
  $windowWaitSec = [Math]::Min(25, [Math]::Max(15, [int][Math]::Floor($TimeoutSec / 4)))
  $waitDeadline = [DateTime]::UtcNow.AddSeconds($windowWaitSec)
  while ([DateTime]::UtcNow -lt $waitDeadline) {
    $pids = [PaperCupSmoke.Native]::GetJobPids($job, [uint32]$proc.Id)
    Record-JobProcesses $pids
    $wins = [PaperCupSmoke.Native]::FindJobWindows($pids)
    foreach ($w in $wins) {
      if ($w.ClassName -eq '#32770') {
        $dlgText = [PaperCupSmoke.Native]::ReadDialogText($w.Hwnd)
        if ([PaperCupSmoke.Native]::IsErrorDialog($w.Hwnd, $w.Title, $dlgText)) {
          $errorDialog = @{ title = $w.Title; text = $dlgText }
        } else {
          $hwndKey = $w.Hwnd.ToInt64()
          if ($dismissedSetupHwnds.Add($hwndKey)) {
            [PaperCupSmoke.Native]::PostKey($w.Hwnd, 0x0D)
          }
        }
      } elseif ($null -eq $mainWin -or ($w.Width * $w.Height) -gt ($mainWin.Width * $mainWin.Height)) {
        $mainWin = $w
      }
    }
    if ($null -ne $errorDialog) { break }
    if ($null -ne $mainWin) { break }
    if ($proc.HasExited -and $pids.Count -le 1) { break }
    Start-Sleep -Milliseconds 300
  }

  if ($null -ne $mainWin) {
    $windowFound = $true
    $windowTitle = $mainWin.Title
    Track-MainProcess $mainWin

    # High-frequency title stabilization: poll every ~600ms up to 8s, skipping uniform/black frames
    # and keeping the latest non-uniform frame as 01_title.png.
    $titlePath = Join-Path $FramesDir '01_title.png'
    $stabTmpPath = Join-Path $FramesDir '_stab.png'
    $w0 = $mainWin.Width; $h0 = $mainWin.Height
    $titleHash = ''
    $hasNonUniformTitle = $false
    $prevNonUniformHash = ''
    $uniformStreak = 0
    $stabDeadline = [DateTime]::UtcNow.AddSeconds(8)
    while ([DateTime]::UtcNow -lt $stabDeadline) {
      $pids = [PaperCupSmoke.Native]::GetJobPids($job, [uint32]$proc.Id)
      Record-JobProcesses $pids
      $wins = [PaperCupSmoke.Native]::FindJobWindows($pids)
      foreach ($w in ($wins | Where-Object { $_.ClassName -eq '#32770' })) {
        $dlgText = [PaperCupSmoke.Native]::ReadDialogText($w.Hwnd)
        if ([PaperCupSmoke.Native]::IsErrorDialog($w.Hwnd, $w.Title, $dlgText)) {
          $errorDialog = @{ title = $w.Title; text = $dlgText }
          break
        } else {
          $hwndKey = $w.Hwnd.ToInt64()
          if ($dismissedSetupHwnds.Add($hwndKey)) {
            [PaperCupSmoke.Native]::PostKey($w.Hwnd, 0x0D)
          }
        }
      }
      if ($null -ne $errorDialog) { break }
      $aliveWin = $wins | Where-Object { $_.Hwnd -eq $mainWin.Hwnd } | Select-Object -First 1
      if ($null -eq $aliveWin -and $wins.Count -gt 0) {
        $aliveWin = $wins | Where-Object { $_.ClassName -ne '#32770' } | Sort-Object { $_.Width * $_.Height } -Descending | Select-Object -First 1
        if ($null -ne $aliveWin) {
          $mainWin = $aliveWin
          $windowTitle = $mainWin.Title
          Track-MainProcess $mainWin
        }
      }
      if ($null -eq $aliveWin) {
        $processExitedEarly = $true
        break
      }

      $cw = 0; $ch = 0; $cUniform = $false
      $candHash = [PaperCupSmoke.Native]::CaptureClientPng($mainWin.Hwnd, $stabTmpPath, [ref]$cw, [ref]$ch, [ref]$cUniform)
      if (-not $cUniform) {
        Copy-Item -LiteralPath $stabTmpPath -Destination $titlePath -Force
        $titleHash = $candHash
        $w0 = $cw; $h0 = $ch
        $hasNonUniformTitle = $true
        $distinctHashes.Add($candHash) | Out-Null
        $uniformStreak = 0
        if ($candHash -eq $prevNonUniformHash) {
          break
        }
        $prevNonUniformHash = $candHash
      } else {
        $prevNonUniformHash = ''
        $uniformStreak++
        if (-not $hasNonUniformTitle -and -not (Test-Path -LiteralPath $titlePath)) {
          Copy-Item -LiteralPath $stabTmpPath -Destination $titlePath -Force
          $titleHash = $candHash
          $w0 = $cw; $h0 = $ch
        }
        if ($uniformStreak -ge 2) {
          [PaperCupSmoke.Native]::PostKey($mainWin.Hwnd, 0x20)
        }
      }
      Start-Sleep -Milliseconds 600
    }
    if (Test-Path -LiteralPath $stabTmpPath) { Remove-Item -LiteralPath $stabTmpPath -Force -ErrorAction SilentlyContinue }

    if (-not (Test-Path -LiteralPath $titlePath) -and -not $processExitedEarly) {
      $cUniformFallback = $false
      $titleHash = [PaperCupSmoke.Native]::CaptureClientPng($mainWin.Hwnd, $titlePath, [ref]$w0, [ref]$h0, [ref]$cUniformFallback)
    }
    if (-not [string]::IsNullOrEmpty($titleHash)) {
      $distinctHashes.Add($titleHash) | Out-Null
    }
    $framesList.Add(@{ label = 'title'; step = 0; path = $titlePath; hash = $titleHash; width = $w0; height = $h0 }) | Out-Null

    $probePath = Join-Path $FramesDir '_probe.png'
    $pw = $w0; $ph = $h0; $pUniform = $true; $probeHash = ''
    $stillOnTitle = $true
    if (-not $processExitedEarly -and $null -eq $errorDialog) {
      # Try generic Enter/Space in background first
      [PaperCupSmoke.Native]::PostKey($mainWin.Hwnd, 0x0D)
      Start-Sleep -Milliseconds 500
      [PaperCupSmoke.Native]::PostKey($mainWin.Hwnd, 0x20)
      Start-Sleep -Milliseconds 900

      $pw = 0; $ph = 0; $pUniform = $false
      $probeHash = [PaperCupSmoke.Native]::CaptureClientPng($mainWin.Hwnd, $probePath, [ref]$pw, [ref]$ph, [ref]$pUniform)
      $stillOnTitle = ($probeHash -eq $titleHash)
      if (-not $pUniform) {
        $distinctHashes.Add($probeHash) | Out-Null
      }
    }
    $latestFrame = if (-not $pUniform -and (Test-Path -LiteralPath $probePath)) { $probePath } else { $titlePath }
    $latestWidth = if (-not $pUniform -and $pw -gt 0) { $pw } else { $w0 }
    $latestHeight = if (-not $pUniform -and $ph -gt 0) { $ph } else { $h0 }

    # Emit ready event so Node can attach Textractor CLI & optionally locate start button via vision
    Emit-Json @{
      event = 'ready'
      pid = [int]$mainWin.Pid
      windowTitle = $windowTitle
      titleFrame = $titlePath
      latestFrame = $latestFrame
      stillOnTitle = $stillOnTitle
      width = $latestWidth
      height = $latestHeight
    }

    # Wait for Node instruction (click start button or continue)
    $cmdLine = [Console]::In.ReadLine()
    if (-not $processExitedEarly -and $null -eq $errorDialog -and -not [string]::IsNullOrWhiteSpace($cmdLine)) {
      $cmd = $cmdLine | ConvertFrom-Json
      if ($cmd.action -eq 'click' -and $null -ne $cmd.xNorm -and $null -ne $cmd.yNorm) {
        $clickW = if ($latestWidth -gt 0) { $latestWidth } else { $mainWin.Width }
        $clickH = if ($latestHeight -gt 0) { $latestHeight } else { $mainWin.Height }
        $cx = [int][Math]::Round([double]$cmd.xNorm * [Math]::Max(1, $clickW))
        $cy = [int][Math]::Round([double]$cmd.yNorm * [Math]::Max(1, $clickH))
        $preClickHash = if (-not $pUniform -and -not [string]::IsNullOrEmpty($probeHash)) { $probeHash } else { $titleHash }
        [PaperCupSmoke.Native]::PostClick($mainWin.Hwnd, $cx, $cy)
        Start-Sleep -Milliseconds 900
        $acw = 0; $ach = 0; $acUniform = $false
        $afterClickHash = [PaperCupSmoke.Native]::CaptureClientPng($mainWin.Hwnd, $probePath, [ref]$acw, [ref]$ach, [ref]$acUniform)
        if ($afterClickHash -eq $preClickHash) {
          $inputMode = 'foreground_fallback'
          [PaperCupSmoke.Native]::SendForegroundClick($mainWin.Hwnd, $cx, $cy)
          Start-Sleep -Milliseconds 900
          $afterFgHash = [PaperCupSmoke.Native]::CaptureClientPng($mainWin.Hwnd, $probePath, [ref]$acw, [ref]$ach, [ref]$acUniform)
          if (-not $acUniform) { $distinctHashes.Add($afterFgHash) | Out-Null }
        } elseif (-not $acUniform) {
          $distinctHashes.Add($afterClickHash) | Out-Null
        }
      } elseif ($stillOnTitle) {
        $inputMode = 'foreground_fallback'
        [PaperCupSmoke.Native]::SendForegroundKey($mainWin.Hwnd, 0x0D)
        Start-Sleep -Milliseconds 800
      }
    }

    $midStep = [Math]::Max(2, [int][Math]::Floor($AdvanceSteps / 2))
    $hardDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(15, $TimeoutSec - 15))
    $useForeground = ($inputMode -eq 'foreground_fallback')
    $sampleTmpPath = Join-Path $FramesDir '_sample.png'
    $slotStartIdx = -1
    $slotMidIdx = -1
    $slotEndIdx = -1
    $fallbackSampleSaved = $false

    for ($step = 1; $step -le $AdvanceSteps; $step++) {
      if ($processExitedEarly -or $null -ne $errorDialog) { break }
      if ([DateTime]::UtcNow -ge $hardDeadline) { break }
      $pids = [PaperCupSmoke.Native]::GetJobPids($job, [uint32]$proc.Id)
      Record-JobProcesses $pids
      $wins = [PaperCupSmoke.Native]::FindJobWindows($pids)
      foreach ($w in ($wins | Where-Object { $_.ClassName -eq '#32770' })) {
        $dlgText = [PaperCupSmoke.Native]::ReadDialogText($w.Hwnd)
        if ([PaperCupSmoke.Native]::IsErrorDialog($w.Hwnd, $w.Title, $dlgText)) {
          $errorDialog = @{ title = $w.Title; text = $dlgText }
          break
        }
      }
      if ($null -ne $errorDialog) { break }
      $aliveWin = $wins | Where-Object { $_.Hwnd -eq $mainWin.Hwnd } | Select-Object -First 1
      if ($null -eq $aliveWin -and $wins.Count -gt 0) {
        $aliveWin = $wins | Where-Object { $_.ClassName -ne '#32770' } | Sort-Object { $_.Width * $_.Height } -Descending | Select-Object -First 1
        if ($null -ne $aliveWin) {
          $mainWin = $aliveWin
          Track-MainProcess $mainWin
        }
      }
      if ($null -eq $aliveWin) {
        $processExitedEarly = $true
        break
      }
      if ([PaperCupSmoke.Native]::IsHungAppWindow($mainWin.Hwnd)) {
        $hungDetected = $true
        break
      }

      if ($useForeground) {
        [PaperCupSmoke.Native]::SendForegroundKey($mainWin.Hwnd, 0x0D)
      } else {
        [PaperCupSmoke.Native]::PostKey($mainWin.Hwnd, 0x0D)
      }
      Start-Sleep -Milliseconds 550
      $stepsAdvanced = $step

      if (($step % 2 -eq 0) -or ($step -eq $AdvanceSteps)) {
        $fw = 0; $fh = 0; $fUniform = $false
        $fHash = [PaperCupSmoke.Native]::CaptureClientPng($mainWin.Hwnd, $sampleTmpPath, [ref]$fw, [ref]$fh, [ref]$fUniform)
        if (-not $fUniform) {
          $distinctHashes.Add($fHash) | Out-Null
          if ($MaxScreenshots -ge 2) {
            if ($slotStartIdx -lt 0) {
              $dstPath = Join-Path $FramesDir '02_dialogue_start.png'
              Copy-Item -LiteralPath $sampleTmpPath -Destination $dstPath -Force
              $entry = @{ label = 'dialogue_start'; step = $step; path = $dstPath; hash = $fHash; width = $fw; height = $fh }
              if ($fallbackSampleSaved -and $framesList.Count -ge 2) {
                $framesList[1] = $entry
                $slotStartIdx = 1
              } else {
                $framesList.Add($entry) | Out-Null
                $slotStartIdx = $framesList.Count - 1
              }
            } elseif ($MaxScreenshots -ge 4 -and ($step -le $midStep -or $slotMidIdx -lt 0)) {
              $dstPath = Join-Path $FramesDir '03_dialogue_mid.png'
              Copy-Item -LiteralPath $sampleTmpPath -Destination $dstPath -Force
              $entry = @{ label = 'dialogue_mid'; step = $step; path = $dstPath; hash = $fHash; width = $fw; height = $fh }
              if ($slotMidIdx -ge 0) {
                $framesList[$slotMidIdx] = $entry
              } else {
                $framesList.Add($entry) | Out-Null
                $slotMidIdx = $framesList.Count - 1
              }
            } elseif ($MaxScreenshots -eq 3) {
              $dstPath = Join-Path $FramesDir '03_dialogue_end.png'
              Copy-Item -LiteralPath $sampleTmpPath -Destination $dstPath -Force
              $entry = @{ label = 'dialogue_end'; step = $step; path = $dstPath; hash = $fHash; width = $fw; height = $fh }
              if ($slotEndIdx -ge 0) {
                $framesList[$slotEndIdx] = $entry
              } else {
                $framesList.Add($entry) | Out-Null
                $slotEndIdx = $framesList.Count - 1
              }
            } else {
              $dstPath = Join-Path $FramesDir '04_dialogue_end.png'
              Copy-Item -LiteralPath $sampleTmpPath -Destination $dstPath -Force
              $entry = @{ label = 'dialogue_end'; step = $step; path = $dstPath; hash = $fHash; width = $fw; height = $fh }
              if ($slotEndIdx -ge 0) {
                $framesList[$slotEndIdx] = $entry
              } else {
                $framesList.Add($entry) | Out-Null
                $slotEndIdx = $framesList.Count - 1
              }
            }
          }
        } elseif ($MaxScreenshots -ge 2 -and $slotStartIdx -lt 0 -and -not $fallbackSampleSaved) {
          $dstPath = Join-Path $FramesDir '02_dialogue_start.png'
          Copy-Item -LiteralPath $sampleTmpPath -Destination $dstPath -Force
          $framesList.Add(@{ label = 'dialogue_start'; step = $step; path = $dstPath; hash = $fHash; width = $fw; height = $fh }) | Out-Null
          $fallbackSampleSaved = $true
        }
        if ($step -ge 2 -and $step -le 4 -and $distinctHashes.Count -le 1 -and -not $useForeground) {
          $useForeground = $true
          $inputMode = 'foreground_fallback'
        }
      }
    }

    if (Test-Path -LiteralPath $sampleTmpPath) { Remove-Item -LiteralPath $sampleTmpPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue }
  } else {
    $processExitedEarly = [bool]$proc.HasExited
    $windowWaitTimeout = (-not $processExitedEarly)
    try {
      $snapPids = [PaperCupSmoke.Native]::GetJobPids($job, [uint32]$proc.Id)
      Record-JobProcesses $snapPids
      $snapWins = [PaperCupSmoke.Native]::FindJobWindows($snapPids)
      foreach ($swin in $snapWins) {
        $observedWindows += ($swin.ClassName + ':' + $swin.Title + ' (' + $swin.Width + 'x' + $swin.Height + ')')
      }
    } catch {}
    Emit-Json @{ event = 'ready'; pid = [int]$proc.Id; windowTitle = ''; titleFrame = ''; latestFrame = ''; stillOnTitle = $false; width = 0; height = 0 }
    $null = [Console]::In.ReadLine()
  }

  # Read real exit code of the actual main-window child process (e.g. when launcher spawned child engine exe)
  if ($mainProcHandle -ne [IntPtr]::Zero) {
    [uint32]$childExit = 0
    $gotExit = [PaperCupSmoke.Native]::GetExitCodeProcess($mainProcHandle, [ref]$childExit)
    if ($processExitedEarly -and $gotExit -and $childExit -eq [PaperCupSmoke.Native]::STILL_ACTIVE) {
      for ($wi = 0; $wi -lt 10; $wi++) {
        Start-Sleep -Milliseconds 50
        $gotExit = [PaperCupSmoke.Native]::GetExitCodeProcess($mainProcHandle, [ref]$childExit)
        if (-not $gotExit -or $childExit -ne [PaperCupSmoke.Native]::STILL_ACTIVE) { break }
      }
    }
    if ($gotExit -and $childExit -ne [PaperCupSmoke.Native]::STILL_ACTIVE) {
      $exitCode = [BitConverter]::ToInt32([BitConverter]::GetBytes($childExit), 0)
    }
  }
  if ($null -eq $exitCode -and $proc.HasExited) {
    $exitCode = $proc.ExitCode
  }
} catch {
  $launchErr = $_.Exception.Message
} finally {
  if ($mainProcHandle -ne [IntPtr]::Zero) {
    [PaperCupSmoke.Native]::CloseHandle($mainProcHandle) | Out-Null
    $mainProcHandle = [IntPtr]::Zero
  }
  if ($job -ne [IntPtr]::Zero) {
    [PaperCupSmoke.Native]::TerminateJobObject($job, 0) | Out-Null
    [PaperCupSmoke.Native]::CloseHandle($job) | Out-Null
  }
  if ($null -ne $proc -and -not $proc.HasExited) {
    try { $proc.Kill() } catch {}
  }
}

# Query Windows Application Event Log (ID 1000, Application Error) for crashes of ANY observed Job process during this run
$observedProcessNames = @([System.Linq.Enumerable]::ToArray($observedProcessNamesSet))
$crashEvent = $null
try {
  $evts = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = $launchStart } -MaxEvents 15 -ErrorAction SilentlyContinue
  $match = $evts | Where-Object {
    $evt = $_
    $ps = $evt.Properties
    $hit = $false
    foreach ($procExeName in $observedProcessNames) {
      if ([string]::IsNullOrWhiteSpace($procExeName)) { continue }
      if (($null -ne $ps -and $ps.Count -ge 1 -and ([string]$ps[0].Value -ieq $procExeName)) -or
          ($null -ne $ps -and $ps.Count -ge 11 -and ([string]$ps[10].Value -like "*$procExeName*")) -or
          ($null -ne $evt.Message -and $evt.Message -like "*$procExeName*")) {
        $hit = $true
        break
      }
    }
    $hit
  } | Select-Object -First 1
  if ($null -ne $match) {
    $msg = if ($null -ne $match.Message) { [string]$match.Message } else { '' }
    $mod = ''
    $code = ''
    $off = ''
    # Language-independent structured EventData Properties for Application Error ID 1000:
    # [0]=AppName, [3]=ModuleName, [6]=ExceptionCode (raw hex), [7]=FaultingOffset (raw hex)
    $props = $match.Properties
    if ($null -ne $props -and $props.Count -ge 8) {
      $rawMod = ([string]$props[3].Value).Trim()
      if (-not [string]::IsNullOrWhiteSpace($rawMod)) { $mod = $rawMod }
      $rawCode = ([string]$props[6].Value).Trim()
      if ($rawCode -match '^(?:0x)?([0-9a-fA-F]+)$') { $code = '0x' + $Matches[1].ToLowerInvariant() }
      $rawOff = ([string]$props[7].Value).Trim()
      if ($rawOff -match '^(?:0x)?([0-9a-fA-F]+)$') { $off = '0x' + $Matches[1].ToLowerInvariant() }
    }
    # Multi-language regex fallback (EN / ZH-CN / JA-JP, pure ASCII \uXXXX escapes)
    if ([string]::IsNullOrWhiteSpace($mod) -and $msg -match '(?:Faulting module name|\u9519\u8bef\u6a21\u5757\u540d\u79f0|\u969c\u5bb3\u304c\u767a\u751f\u3057\u3066\u3044\u308b\u30e2\u30b8\u30e5\u30fc\u30eb\u540d)\s*[:\uff1a]\s*([^,\uff0c\u3001\r\n]+)') {
      $mod = $Matches[1].Trim()
    }
    if ([string]::IsNullOrWhiteSpace($code) -and $msg -match '(?:Exception code|\u5f02\u5e38\u4ee3\u7801|\u4f8b\u5916\u30b3\u30fc\u30c9)\s*[:\uff1a]\s*(0x[0-9a-fA-F]+)') {
      $code = $Matches[1].Trim().ToLowerInvariant()
    }
    if ([string]::IsNullOrWhiteSpace($off) -and $msg -match '(?:Fault offset|\u9519\u8bef\u504f\u79fb\u91cf|\u969c\u5bb3\u30aa\u30d5\u30bb\u30c3\u30c8)\s*[:\uff1a]\s*(0x[0-9a-fA-F]+)') {
      $off = $Matches[1].Trim().ToLowerInvariant()
    }
    $crashEvent = @{
      faultingModule = $mod
      exceptionCode = $code
      faultOffset = $off
      rawEvent = $msg.Substring(0, [Math]::Min(600, $msg.Length))
    }
  }
} catch {}

$sw.Stop()
Emit-Json @{
  event = 'done'
  launched = ([string]::IsNullOrEmpty($launchErr))
  processStarted = $processStarted
  launchError = $launchErr
  windowFound = $windowFound
  windowTitle = $windowTitle
  mainProcessName = $mainProcessName
  observedProcessNames = $observedProcessNames
  inputMode = $(if ($windowFound) { $inputMode } else { 'none' })
  stepsAdvanced = $stepsAdvanced
  durationMs = [int]$sw.ElapsedMilliseconds
  processExitedEarly = $processExitedEarly
  windowWaitTimeout = $windowWaitTimeout
  observedWindows = $observedWindows
  exitCode = $exitCode
  hungDetected = $hungDetected
  frozenScreen = ($distinctHashes.Count -le 1)
  errorDialog = $errorDialog
  crashEvent = $crashEvent
  frames = @($framesList.ToArray())
}
`;

export function getWindowsSmokeDriverSource(): string {
  return WINDOWS_SMOKE_DRIVER_PS1;
}

/**
 * Write the Windows PowerShell smoke driver script with a UTF-8 BOM (`\uFEFF`)
 * so Windows PowerShell 5.1 never falls back to legacy ANSI (e.g. CP932) parsing.
 */
export function writeWindowsSmokeDriverScript(scriptPath: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, `\uFEFF${WINDOWS_SMOKE_DRIVER_PS1}`, 'utf8');
}

const TEXTRACTOR_HEADER_RE = /^\[([^\]]+)\]\s*(.*)$/;
const TEXTRACTOR_IGNORED_THREAD_RE = /(?:^|:)(?:Clipboard|Console)(?::|$)/i;

function parseTextractorLineWithState(
  rawLine: string,
  state: { ignoringThread: boolean }
): string | null {
  const cleaned = rawLine.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;
  const headerMatch = TEXTRACTOR_HEADER_RE.exec(cleaned);
  if (headerMatch) {
    const header = headerMatch[1];
    if (TEXTRACTOR_IGNORED_THREAD_RE.test(header)) {
      state.ignoringThread = true;
      return null;
    }
    state.ignoringThread = false;
    const stripped = headerMatch[2].trim();
    if (!stripped) return null;
    if (/^(?:Usage:|Attached|Detached|Textractor|Console|Invalid)/i.test(stripped)) return null;
    return stripped;
  }
  // Continuation line (multi-line payload without a thread header):
  // discard whenever the active thread is Clipboard/Console so multi-line clipboard content never leaks.
  if (state.ignoringThread) return null;
  if (/^(?:Usage:|Attached|Detached|Textractor|Console|Invalid)/i.test(cleaned)) return null;
  return cleaned;
}

export interface TextractorStreamParser {
  push(chunk: Buffer): string[];
  flush(): string[];
}

/**
 * Stateful Textractor CLI stdout parser that locks encoding once detected (UTF-16LE vs UTF-8),
 * preserves odd-byte code-unit boundaries via `StringDecoder`, buffers partial lines across
 * OS pipe chunks, and tracks the active Textractor thread header so multi-line Clipboard/Console
 * outputs never pollute hooked game text.
 */
export function createTextractorStreamParser(
  forcedEncoding?: 'utf16le' | 'utf8'
): TextractorStreamParser {
  let decoder: StringDecoder | null = forcedEncoding ? new StringDecoder(forcedEncoding) : null;
  let pendingInit = Buffer.alloc(0);
  let lineBuf = '';
  const threadState = { ignoringThread: false };

  const initDecoderFromBuffer = (buf: Buffer): void => {
    if (decoder) return;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      decoder = new StringDecoder('utf16le');
    } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      decoder = new StringDecoder('utf8');
    } else if (buf.includes(0)) {
      decoder = new StringDecoder('utf16le');
    } else {
      decoder = new StringDecoder('utf8');
    }
  };

  const drainCompleteLines = (text: string): string[] => {
    if (!text) return [];
    lineBuf += text;
    const parts = lineBuf.split(/\r?\n/);
    lineBuf = parts.pop() ?? '';
    const out: string[] = [];
    for (const part of parts) {
      const parsed = parseTextractorLineWithState(part, threadState);
      if (parsed) out.push(parsed);
    }
    return out;
  };

  return {
    push(chunk: Buffer): string[] {
      if (!chunk || chunk.length === 0) return [];
      if (!decoder) {
        pendingInit = pendingInit.length > 0 ? Buffer.concat([pendingInit, chunk]) : chunk;
        // Wait for at least 2 bytes before locking UTF-16LE vs UTF-8 (a 1-byte split of ASCII UTF-16LE lacks the 0x00 high byte)
        if (pendingInit.length < 2) return [];
        initDecoderFromBuffer(pendingInit);
        const toDecode = pendingInit;
        pendingInit = Buffer.alloc(0);
        return drainCompleteLines(decoder!.write(toDecode));
      }
      return drainCompleteLines(decoder.write(chunk));
    },
    flush(): string[] {
      const out: string[] = [];
      if (!decoder && pendingInit.length > 0) {
        initDecoderFromBuffer(pendingInit);
        const toDecode = pendingInit;
        pendingInit = Buffer.alloc(0);
        out.push(...drainCompleteLines(decoder!.write(toDecode)));
      }
      if (decoder) {
        const tail = decoder.end();
        if (tail) out.push(...drainCompleteLines(tail));
      }
      if (lineBuf) {
        const parsed = parseTextractorLineWithState(lineBuf, threadState);
        lineBuf = '';
        if (parsed) out.push(parsed);
      }
      return out;
    },
  };
}

export function parseTextractorOutputChunk(buf: Buffer): string[] {
  const parser = createTextractorStreamParser();
  return [...parser.push(buf), ...parser.flush()];
}

function spawnTextractorSession(cliPath: string, pid: number): {
  lines: string[];
  stop: () => void;
} {
  const lines: string[] = [];
  let child: ChildProcess | null = null;
  const parser = createTextractorStreamParser();
  const pushLines = (items: string[]) => {
    for (const line of items) {
      if (lines.length < 200) lines.push(line);
    }
  };
  try {
    child = spawn(cliPath, [], {
      cwd: path.dirname(cliPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (buf: Buffer) => {
      pushLines(parser.push(buf));
    });
    child.stdout?.on('end', () => {
      pushLines(parser.flush());
    });
    // TextractorCLI.exe reads stdin in UTF-16LE (_O_U16TEXT)
    child.stdin?.write(Buffer.from(`attach -P${pid}\r\n`, 'utf16le'));
  } catch {
    // Non-fatal: hook.unavailable warning will record this
  }
  return {
    lines,
    stop: () => {
      pushLines(parser.flush());
      if (!child) return;
      try {
        child.stdin?.write(Buffer.from(`detach -P${pid}\r\n`, 'utf16le'));
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
      child = null;
    },
  };
}

const MAX_DRIVER_LOG_CHARS = 64 * 1024;

function appendBoundedLog(buf: string, chunk: string): string {
  if (buf.length >= MAX_DRIVER_LOG_CHARS) return buf;
  return buf + chunk.slice(0, MAX_DRIVER_LOG_CHARS - buf.length);
}

export const windowsSmokeDriver: SmokeExecutionDriver = {
  async run(input: SmokeDriverInput): Promise<SmokeDriverRunResult> {
    if (process.platform !== 'win32') {
      return {
        launched: false,
        harnessFailed: true,
        harnessError: '当前运行环境不是 Windows，无法执行 Win32 游戏冒烟测试。',
        launchError: '当前运行环境不是 Windows，无法执行 Win32 游戏冒烟测试。',
        windowFound: false,
        inputMode: 'none',
        stepsAdvanced: 0,
        durationMs: 0,
        processExitedEarly: true,
        hungDetected: false,
        frozenScreen: true,
        frames: [],
        textractorLines: [],
      };
    }

    const scriptPath = path.join(input.sandboxDir, '_papercup_smoke_driver.ps1');
    writeWindowsSmokeDriverScript(scriptPath);
    fs.mkdirSync(input.framesDir, { recursive: true });

    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-ExePath',
      input.exePath,
      '-WorkDir',
      path.dirname(input.exePath),
      '-FramesDir',
      input.framesDir,
      '-TimeoutSec',
      String(input.config.timeoutSec),
      '-AdvanceSteps',
      String(input.config.advanceSteps),
      '-MaxScreenshots',
      String(input.config.maxScreenshots),
    ];
    if (input.useLocaleEmulator && input.leProcPath) {
      args.push('-LeProcPath', input.leProcPath);
      if (input.leProfileGuid) {
        args.push('-LeProfileGuid', input.leProfileGuid);
      }
    }

    return new Promise<SmokeDriverRunResult>((resolve) => {
      const child = spawn('powershell.exe', args, {
        cwd: input.sandboxDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let trSession: { lines: string[]; stop: () => void } | null = null;
      let donePayload: Record<string, unknown> | null = null;
      let driverReadyReceived = false;
      let visionClickAttempted = false;
      let visionClickSkippedReason: string | undefined;
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;
      let childClosed = false;
      let visionInFlight = false;
      const visionAbort = new AbortController();
      const rl = readline.createInterface({ input: child.stdout! });

      const buildLog = (exitCode: number | null = null): SmokeDriverLog => ({
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exitCode,
      });

      const finish = (res: SmokeDriverRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (input.signal) input.signal.removeEventListener('abort', onAbort);
        if (!visionAbort.signal.aborted) visionAbort.abort();
        try {
          rl.close();
        } catch {
          // ignore
        }
        trSession?.stop();
        try {
          if (!child.killed) child.kill();
        } catch {
          // ignore
        }
        resolve(res);
      };

      const onAbort = () => {
        if (!visionAbort.signal.aborted) visionAbort.abort();
        finish({
          launched: false,
          harnessFailed: true,
          harnessError: '冒烟测试已被用户中止。',
          launchError: '冒烟测试已被用户中止。',
          driverLog: buildLog(null),
          windowFound: false,
          inputMode: 'none',
          stepsAdvanced: 0,
          durationMs: 0,
          processExitedEarly: true,
          hungDetected: false,
          frozenScreen: false,
          frames: [],
          textractorLines: trSession?.lines ?? [],
        });
      };
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });

      const hardTimer = setTimeout(() => {
        if (!driverReadyReceived) {
          finish({
            launched: false,
            harnessFailed: true,
            harnessError: `冒烟驱动在游戏启动前超过硬超时（${input.config.timeoutSec}s）未回报就绪状态。`,
            launchError: `冒烟驱动在游戏启动前超过硬超时（${input.config.timeoutSec}s）未回报就绪状态。`,
            driverLog: buildLog(null),
            windowFound: false,
            inputMode: 'none',
            stepsAdvanced: 0,
            durationMs: input.config.timeoutSec * 1000,
            processExitedEarly: false,
            hungDetected: false,
            frozenScreen: true,
            frames: [],
            textractorLines: trSession?.lines ?? [],
          });
          return;
        }
        finish({
          launched: true,
          launchError: `冒烟测试超过硬超时（${input.config.timeoutSec}s），已强制终止进程树。`,
          driverLog: buildLog(null),
          windowFound: true,
          inputMode: 'none',
          stepsAdvanced: 0,
          durationMs: input.config.timeoutSec * 1000,
          processExitedEarly: false,
          hungDetected: true,
          frozenScreen: true,
          frames: [],
          textractorLines: trSession?.lines ?? [],
        });
      }, (input.config.timeoutSec + 10) * 1000);

      child.on('error', (err) => {
        stderrBuf = appendBoundedLog(stderrBuf, `\n[spawn error] ${err.message}\n`);
        finish({
          launched: false,
          harnessFailed: true,
          harnessError: `无法启动 PowerShell 冒烟驱动进程：${err.message}`,
          launchError: `无法启动 PowerShell 冒烟驱动进程：${err.message}`,
          driverLog: buildLog(null),
          windowFound: false,
          inputMode: 'none',
          stepsAdvanced: 0,
          durationMs: 0,
          processExitedEarly: true,
          hungDetected: false,
          frozenScreen: true,
          frames: [],
          textractorLines: trSession?.lines ?? [],
        });
      });

      const handleLine = async (line: string): Promise<void> => {
        stdoutBuf = appendBoundedLog(stdoutBuf, `${line}\n`);
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.event === 'driver_ready') {
          driverReadyReceived = true;
        } else if (msg.event === 'ready') {
          driverReadyReceived = true;
          const pid = Number(msg.pid || 0);
          if (pid > 0 && input.textractorCliPath && !settled && !childClosed) {
            trSession = spawnTextractorSession(input.textractorCliPath, pid);
          }
          const frameForVision =
            (typeof msg.latestFrame === 'string' && msg.latestFrame) ||
            (typeof msg.titleFrame === 'string' && msg.titleFrame) ||
            '';
          let reply: Record<string, unknown> = { action: 'continue' };
          if (
            !settled &&
            !childClosed &&
            frameForVision &&
            input.config.visionEnabled &&
            input.vision?.locateStartButton
          ) {
            visionClickAttempted = true;
            visionInFlight = true;
            try {
              const loc = await input.vision.locateStartButton(frameForVision, visionAbort.signal);
              if (loc.found && typeof loc.xNorm === 'number' && typeof loc.yNorm === 'number') {
                reply = { action: 'click', xNorm: loc.xNorm, yNorm: loc.yNorm };
              } else if (loc.skippedReason) {
                visionClickSkippedReason = loc.skippedReason;
              }
            } catch (err) {
              visionClickSkippedReason = `标题按钮识别异常：${(err as Error).message}`;
            } finally {
              visionInFlight = false;
            }
          }
          if (!settled && !childClosed) {
            try {
              child.stdin?.write(JSON.stringify(reply) + '\n');
            } catch {
              // ignore closed stdin
            }
          }
        } else if (msg.event === 'done') {
          donePayload = msg;
        }
      };

      // Serialize stdout JSON-line processing so async locateStartButton never races with done/close.
      let lineChain: Promise<void> = Promise.resolve();
      rl.on('line', (line) => {
        lineChain = lineChain.then(() => handleLine(line)).catch(() => {});
      });

      child.stderr?.on('data', (chunk) => {
        stderrBuf = appendBoundedLog(stderrBuf, String(chunk));
      });

      child.on('close', (code) => {
        childClosed = true;
        // If the driver process exited while a start-button vision call is still pending, cancel it immediately.
        if (visionInFlight && !visionAbort.signal.aborted) {
          visionAbort.abort();
        }
        void lineChain.finally(() => {
          if (settled) return;
          if (donePayload) {
            const rawFrames = Array.isArray(donePayload.frames)
              ? (donePayload.frames as Array<Record<string, unknown>>)
              : [];
            finish({
              launched: Boolean(donePayload.launched),
              launchError: typeof donePayload.launchError === 'string' ? donePayload.launchError : undefined,
              driverLog: buildLog(typeof code === 'number' ? code : null),
              windowFound: Boolean(donePayload.windowFound),
              windowTitle: typeof donePayload.windowTitle === 'string' ? donePayload.windowTitle : undefined,
              mainProcessName:
                typeof donePayload.mainProcessName === 'string' && donePayload.mainProcessName
                  ? donePayload.mainProcessName
                  : undefined,
              observedProcessNames: Array.isArray(donePayload.observedProcessNames)
                ? donePayload.observedProcessNames.map((v) => String(v)).filter(Boolean)
                : typeof donePayload.observedProcessNames === 'string' && donePayload.observedProcessNames
                  ? [donePayload.observedProcessNames]
                  : undefined,
              inputMode:
                donePayload.inputMode === 'foreground_fallback'
                  ? 'foreground_fallback'
                  : donePayload.inputMode === 'background'
                    ? 'background'
                    : 'none',
              stepsAdvanced: Number(donePayload.stepsAdvanced || 0),
              durationMs: Number(donePayload.durationMs || 0),
              processExitedEarly: Boolean(donePayload.processExitedEarly),
              windowWaitTimeout: Boolean(donePayload.windowWaitTimeout),
              observedWindows: Array.isArray(donePayload.observedWindows)
                ? donePayload.observedWindows.map((v) => String(v)).filter(Boolean)
                : undefined,
              exitCode: typeof donePayload.exitCode === 'number' ? donePayload.exitCode : null,
              hungDetected: Boolean(donePayload.hungDetected),
              frozenScreen: Boolean(donePayload.frozenScreen),
              errorDialog:
                donePayload.errorDialog && typeof donePayload.errorDialog === 'object'
                  ? (donePayload.errorDialog as { title: string; text: string })
                  : null,
              crashEvent:
                donePayload.crashEvent && typeof donePayload.crashEvent === 'object'
                  ? (donePayload.crashEvent as SmokeCrashInfo)
                  : null,
              frames: rawFrames.map((f) => ({
                label: (String(f.label || 'dialogue_start') as SmokeCapturedFrame['label']),
                step: Number(f.step || 0),
                path: String(f.path || ''),
                hash: String(f.hash || ''),
                width: Number(f.width || 0),
                height: Number(f.height || 0),
              })),
              textractorLines: trSession?.lines ?? [],
              visionClickAttempted,
              visionClickSkippedReason,
            });
          } else {
            const errSnippet = stderrBuf.trim().slice(0, 2000) || '冒烟驱动进程异常退出且未返回结果。';
            finish({
              launched: false,
              harnessFailed: true,
              harnessError: errSnippet,
              launchError: errSnippet,
              driverLog: buildLog(typeof code === 'number' ? code : null),
              windowFound: false,
              inputMode: 'none',
              stepsAdvanced: 0,
              durationMs: 0,
              processExitedEarly: true,
              hungDetected: false,
              frozenScreen: true,
              frames: [],
              textractorLines: trSession?.lines ?? [],
            });
          }
        });
      });
    });
  },
};

/* ========================= Pre-Translate Custom-Skill Smoke Probe & Gate ========================= */

export interface ActiveCustomSkillInfo {
  engine: string;
  skillName: string;
  pipeline: 'skill' | 'direct';
  skillDir: string;
  engineJson: Record<string, unknown>;
  applyPy?: string;
  repackPy?: string;
  skillDigest: string;
  hasUnpackedManifests: boolean;
}

export interface PreTranslateSmokeGateResult {
  allowed: boolean;
  skipped: boolean;
  skipReason?: 'non_windows' | 'smoke_disabled' | 'builtin_engine' | 'override';
  activeSkill?: ActiveCustomSkillInfo;
  record?: PreTranslateSmokeRecord | null;
  reason?: string;
}

function stableCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableCanonicalize(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableCanonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function computeCustomSkillDigest(
  engine: string,
  skillDir: string,
  engineJson: Record<string, unknown> | null
): string {
  const ej = engineJson ?? {};
  const metaPayload = stableCanonicalize({
    engine: engine.trim().toLowerCase(),
    pipeline: ej.pipeline ?? null,
    encoding: ej.encoding ?? null,
    writeback: ej.writeback ?? null,
    custom_encodings: ej.custom_encodings ?? null,
    direct_root: ej.direct_root ?? null,
    control_pattern: ej.control_pattern ?? null,
    classify: ej.classify ?? null,
    'skill-sha256': ej['skill-sha256'] ?? null,
    'unpack-sha256': ej['unpack-sha256'] ?? null,
    'repack-sha256': ej['repack-sha256'] ?? null,
    'extract-sha256': ej['extract-sha256'] ?? null,
    'apply-sha256': ej['apply-sha256'] ?? null,
  });
  const scriptHashes: Record<string, string> = {};
  for (const script of SKILL_RUNTIME_SCRIPTS) {
    const p = path.join(skillDir, script);
    if (!isSymlinkPath(p) && fs.existsSync(p)) {
      try {
        if (fs.statSync(p).isFile()) {
          const buf = fs.readFileSync(p);
          scriptHashes[script] = buf.includes(0x00) ? sha256Hex(buf) : hashSkillTextContent(buf);
        }
      } catch {
        // ignore unreadable script
      }
    }
  }
  return sha256Hex(Buffer.from(JSON.stringify({ meta: metaPayload, scripts: scriptHashes }), 'utf8'));
}

export function resolveActiveCustomSkillForPreTranslateSmoke(
  workspace: string,
  homeDir?: string | null
): ActiveCustomSkillInfo | null {
  const ws = realpathSafe(workspace);
  const wsPaths = resolveWorkspacePaths(ws);
  const resolvedHome = homeDir ?? null;
  const fallbackEngine = String(readManifest(ws)?.engine || '').trim().toLowerCase();

  const buildCustomSkillInfo = (
    engine: string,
    pipeline: 'skill' | 'direct',
    skillDir: string,
    skillName: string | undefined,
    engineJson: Record<string, unknown> | null,
    hasUnpackedManifests: boolean
  ): ActiveCustomSkillInfo => {
    const ej = engineJson ?? {};
    const applyCand = path.join(skillDir, 'apply.py');
    const repackCand = path.join(skillDir, 'repack.py');
    const applyPy =
      !isSymlinkPath(applyCand) && fs.existsSync(applyCand) && fs.statSync(applyCand).isFile()
        ? applyCand
        : undefined;
    const repackPy =
      !isSymlinkPath(repackCand) && fs.existsSync(repackCand) && fs.statSync(repackCand).isFile()
        ? repackCand
        : undefined;
    return {
      engine,
      skillName: skillName || `engine-${engine}`,
      pipeline,
      skillDir,
      engineJson: ej,
      ...(applyPy ? { applyPy } : {}),
      ...(repackPy ? { repackPy } : {}),
      skillDigest: computeCustomSkillDigest(engine, skillDir, ej),
      hasUnpackedManifests,
    };
  };

  if (!isSymlinkPath(wsPaths.unpackedDir) && fs.existsSync(wsPaths.unpackedDir)) {
    let isDir = false;
    try {
      isDir = fs.statSync(wsPaths.unpackedDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      const manifests = findUnpackManifests(wsPaths.unpackedDir);
      if (manifests.length > 0) {
        const skillManifestPath = manifests.find((m) => path.basename(m) === SKILL_MANIFEST);
        if (!skillManifestPath) {
          // Built-in container manifests (RPA/XP3/PE-ZIP/NSA) -> built-in engine, skip pre-translate gate
          return null;
        }
        let manifestEngine = fallbackEngine;
        try {
          const parsed = JSON.parse(fs.readFileSync(skillManifestPath, 'utf8').replace(/^\uFEFF/, '')) as Record<
            string,
            unknown
          >;
          if (typeof parsed?.engine === 'string' && parsed.engine.trim()) {
            manifestEngine = parsed.engine.trim().toLowerCase();
          }
        } catch {
          // fall back to manifestEngine
        }
        if (!manifestEngine) {
          throw new SmokeError('检测到自定义技能解包清单（.skill-manifest.json），但缺少 engine 标识。');
        }
        const binding = skillBinding(ws, resolvedHome, manifestEngine);
        if (binding.state === 'mismatch') {
          const detail = binding.errors?.length ? `（${binding.errors.join('；')}）` : '';
          throw new SmokeError(`${manifestEngine} 的技能 SHA-256 完整性校验失败${detail}。`);
        }
        if (binding.state !== 'ready' || !binding.directory) {
          throw new SmokeError(`未找到引擎 ${manifestEngine} 的就绪自定义技能目录。`);
        }
        const engineJson = resolveEngineJson(ws, manifestEngine, resolvedHome);
        return buildCustomSkillInfo(manifestEngine, 'skill', binding.directory, binding.skillName, engineJson, true);
      }
    }
  }

  const directSkill = resolveReadyDirectSkill(ws, resolvedHome, fallbackEngine);
  if (directSkill) {
    const binding = skillBinding(ws, resolvedHome, directSkill.engine);
    if (binding.state !== 'ready' || !binding.directory) {
      throw new SmokeError(`未找到 direct 引擎 ${directSkill.engine} 的就绪技能目录。`);
    }
    return buildCustomSkillInfo(
      directSkill.engine,
      'direct',
      binding.directory,
      binding.skillName,
      directSkill.profile,
      false
    );
  }

  if (fallbackEngine) {
    const prof = resolveEngineJson(ws, fallbackEngine, resolvedHome);
    if (prof && String(prof.pipeline || '').trim().toLowerCase() === 'skill') {
      const binding = skillBinding(ws, resolvedHome, fallbackEngine);
      if (binding.state === 'mismatch') {
        const detail = binding.errors?.length ? `（${binding.errors.join('；')}）` : '';
        throw new SmokeError(`${fallbackEngine} 的技能 SHA-256 完整性校验失败${detail}。`);
      }
      if (binding.state === 'ready' && binding.directory) {
        return buildCustomSkillInfo(fallbackEngine, 'skill', binding.directory, binding.skillName, prof, false);
      }
    }
  }

  return null;
}

function readBuildJsonlRowsSafe(filePath: string): Array<Record<string, unknown>> {
  if (isSymlinkPath(filePath) || !fs.existsSync(filePath)) return [];
  try {
    if (!fs.statSync(filePath).isFile()) return [];
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const rows: Array<Record<string, unknown>> = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rows.push(parsed as Record<string, unknown>);
        }
      } catch {
        // skip malformed line
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function isStandaloneSpeakerProbeRow(
  row: Record<string, unknown>,
  nextRow: Record<string, unknown> | undefined
): boolean {
  if (!nextRow) return false;
  const curFile = String(row.file || '');
  const nextFile = String(nextRow.file || '');
  if (curFile !== nextFile) return false;
  const s = String(row.source || '').trim();
  if (!s || s.length > 12) return false;
  if (/^[「『（(]/.test(s)) return false;
  if (/[。！？!?…]/.test(s)) return false;
  const nextSource = String(nextRow.source || '').trim();
  return /^[「『]/.test(nextSource);
}

const TEST_TEMPLATE_SCRIPT_WORDS = new Set(['dummy', 'test', 'sample', 'debug', 'template', 'tests', 'samples']);

export function isTestOrTemplateScriptPath(fileRel: string): boolean {
  const norm = fileRel.replace(/\\/g, '/').trim();
  if (!norm) return false;
  const tokenized = norm
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const tokens = tokenized.split(/[^a-z]+/).filter(Boolean);
  return tokens.some((tok) => TEST_TEMPLATE_SCRIPT_WORDS.has(tok));
}

export function pickPreTranslateProbeRows(
  workspace: string,
  maxRows = 3
): {
  track: 'scenario' | 'ui';
  rows: Array<Record<string, unknown>>;
} {
  const wsPaths = resolveWorkspacePaths(workspace);
  const limit = Math.max(1, Math.floor(maxRows || 1));

  const pickFromRows = (
    rows: Array<Record<string, unknown>>,
    skipTestTemplate: boolean
  ): Array<Record<string, unknown>> => {
    const rawValid = rows.filter((r) => typeof r.source === 'string' && r.source.trim().length > 0);
    if (!rawValid.length) return [];
    const valid = skipTestTemplate
      ? rawValid.filter((r) => !isTestOrTemplateScriptPath(String(r.file || '')))
      : rawValid;
    if (!valid.length) return [];

    const nonName = valid.filter((r) => String(r.kind || '').toLowerCase() !== 'name');
    const nonNameBase = nonName.length > 0 ? nonName : valid;

    // Filter out standalone short speaker rows (even when kind !== 'name') using original valid order.
    const nonSpeaker = valid.filter(
      (r, idx) => String(r.kind || '').toLowerCase() !== 'name' && !isStandaloneSpeakerProbeRow(r, valid[idx + 1])
    );
    const pool = nonSpeaker.length > 0 ? nonSpeaker : nonNameBase;

    const isQuotedOrDialogue = (s: string) => /^[「『]/.test(s) || s.length >= 8;
    const isClean = (s: string) => !/[\r\n]/.test(s) && !/[\[\]<>⟦⟧]/.test(s);

    let anchorIdx = pool.findIndex((r) => {
      const s = String(r.source || '').trim();
      return isClean(s) && isQuotedOrDialogue(s);
    });
    if (anchorIdx < 0) {
      anchorIdx = pool.findIndex((r) => isQuotedOrDialogue(String(r.source || '').trim()));
    }
    if (anchorIdx < 0) {
      anchorIdx = pool.findIndex((r) => {
        const s = String(r.source || '').trim();
        return s.length >= 4 && isClean(s);
      });
    }
    if (anchorIdx < 0) {
      anchorIdx = pool.findIndex((r) => String(r.source || '').trim().length >= 4);
    }
    if (anchorIdx < 0) anchorIdx = 0;

    const anchorFile = String(pool[anchorIdx].file || '');
    const selected: Array<Record<string, unknown>> = [pool[anchorIdx]];
    for (let i = anchorIdx + 1; i < pool.length && selected.length < limit; i++) {
      const cand = pool[i];
      if (String(cand.file || '') !== anchorFile) break;
      selected.push(cand);
    }
    return selected;
  };

  const scenarioRows = readBuildJsonlRowsSafe(wsPaths.buildTrackFile('scenario'));
  const uiRows = readBuildJsonlRowsSafe(wsPaths.buildTrackFile('ui'));

  for (const skipTestTemplate of [true, false]) {
    const scenarioPick = pickFromRows(scenarioRows, skipTestTemplate);
    if (scenarioPick.length > 0) {
      return { track: 'scenario', rows: scenarioPick };
    }
    const uiPick = pickFromRows(uiRows, skipTestTemplate);
    if (uiPick.length > 0) {
      return { track: 'ui', rows: uiPick };
    }
  }

  throw new SmokeError(
    '工作区 .papercup/data/build/{scenario,ui}.jsonl 中没有可用于前置冒烟测试的文本行；请先运行 vn_classify。'
  );
}

export function pickPreTranslateProbeRow(workspace: string): {
  track: 'scenario' | 'ui';
  row: Record<string, unknown>;
} {
  const picked = pickPreTranslateProbeRows(workspace, 1);
  return { track: picked.track, row: picked.rows[0] };
}

export function buildPreTranslateProbeTarget(
  source: string,
  targetEncoding: string,
  controlPattern?: string
): string {
  const encLow = targetEncoding.trim().toLowerCase();
  const useCp932Safe = encLow === 'cp932';
  const primaryProbe = useCp932Safe ? '[PCUP] 中文漢化測試' : '[PCUP] 中文探针：你读懂这句已经生效';
  const secondaryProbe = useCp932Safe ? '漢化' : '探针';
  const fallbackProbe = useCp932Safe ? '漢化測試' : '中文探针已生效';

  let prefix = '';
  let suffix = '';
  let core = source;
  const quotePairs: Array<[string, string]> = [
    ['「', '」'],
    ['『', '』'],
  ];
  for (const [open, close] of quotePairs) {
    if (core.startsWith(open) && core.endsWith(close) && core.length > open.length + close.length) {
      prefix = open;
      suffix = close;
      core = core.slice(open.length, -close.length);
      break;
    }
  }

  const patternSources: string[] = [
    '\\\\[nrt]',
    '⟦[^⟧]+⟧',
    '\\[[^\\]]+\\]',
    '<[^>]+>',
    '%(?:\\d+\\$)?[-+ #0]*(?:\\d+)?(?:\\.\\d+)?[sdifuxXo]',
  ];
  if (controlPattern && controlPattern.trim()) {
    try {
      new RegExp(controlPattern, 'g');
      patternSources.unshift(`(?:${controlPattern})`);
    } catch {
      // ignore invalid custom control pattern
    }
  }
  const combinedRe = new RegExp(patternSources.join('|'), 'g');
  const tokens: Array<{ start: number; end: number; text: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = combinedRe.exec(core)) !== null) {
    if (match[0].length === 0) {
      combinedRe.lastIndex += 1;
      continue;
    }
    tokens.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }

  let rebuiltCore = '';
  if (tokens.length === 0) {
    rebuiltCore = primaryProbe;
  } else {
    let cursor = 0;
    let placedProbe = false;
    const parts: string[] = [];
    for (const tok of tokens) {
      const gap = core.slice(cursor, tok.start);
      if (gap.trim().length > 0) {
        parts.push(placedProbe ? secondaryProbe : primaryProbe);
        placedProbe = true;
      }
      parts.push(tok.text);
      cursor = tok.end;
    }
    const trailing = core.slice(cursor);
    if (trailing.trim().length > 0 || !placedProbe) {
      parts.push(placedProbe ? secondaryProbe : primaryProbe);
    }
    rebuiltCore = parts.join('');
  }

  let result = `${prefix}${rebuiltCore}${suffix}`;
  if (result === source) {
    result =
      tokens.length === 0
        ? `${prefix}${fallbackProbe}${suffix}`
        : `${prefix}${fallbackProbe}${tokens.map((t) => t.text).join('')}${suffix}`;
  }
  return result;
}

function overlayPatchedFontsIntoDir(workspace: string, overlayDir: string): number {
  const manifest = loadPatchedFontManifest(workspace);
  if (!manifest?.entries?.length) return 0;
  let overlaid = 0;
  for (const entry of manifest.entries) {
    const installRel = toPosix(String(entry.install_rel || ''));
    if (!installRel) continue;
    try {
      staysInside('.', installRel);
    } catch {
      continue;
    }
    const srcFile = resolvePatchedFontFile(workspace, entry);
    if (!srcFile) continue;
    const dstFull = path.join(overlayDir, installRel);
    const relOut = path.relative(overlayDir, dstFull);
    if (!relOut || relOut.startsWith('..') || path.isAbsolute(relOut)) continue;
    fs.mkdirSync(path.dirname(dstFull), { recursive: true });
    fs.copyFileSync(srcFile, dstFull);
    overlaid++;
  }
  return overlaid;
}

function mirrorLastProbeArtifacts(params: {
  workspace: string;
  probeJsonlPath: string;
  overlayDir: string;
  probeInfo: PreTranslateSmokeProbeInfo;
  activeSkill: ActiveCustomSkillInfo;
  targetEncoding: string;
}): string {
  const wsPaths = resolveWorkspacePaths(params.workspace);
  const lastDir = wsPaths.smokeLastProbeDir;
  if (!isSymlinkPath(lastDir) && fs.existsSync(lastDir)) {
    fs.rmSync(lastDir, { recursive: true, force: true });
  }
  fs.mkdirSync(lastDir, { recursive: true });
  if (fs.existsSync(params.probeJsonlPath)) {
    fs.copyFileSync(params.probeJsonlPath, path.join(lastDir, 'probe.jsonl'));
  }
  copyTreeRecursive(params.overlayDir, path.join(lastDir, 'overlay'));
  const relDir = displayRel(lastDir, params.workspace);
  const metaPayload = {
    schema: 1,
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    engine: params.activeSkill.engine,
    skillName: params.activeSkill.skillName,
    pipeline: params.activeSkill.pipeline,
    skillDigest: params.activeSkill.skillDigest,
    targetEncoding: params.targetEncoding,
    savedProbeDir: relDir,
    probe: { ...params.probeInfo, savedProbeDir: relDir },
  };
  fs.writeFileSync(path.join(lastDir, 'meta.json'), JSON.stringify(metaPayload, null, 2) + '\n', 'utf8');
  return relDir;
}

async function preparePreTranslateProbeOverlay(
  workspace: string,
  profile: LocalizationProfile,
  activeSkill: ActiveCustomSkillInfo,
  options: {
    homeDir?: string | null;
    proxyBinDir?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<{
  overlayDir: string;
  probeInfo: PreTranslateSmokeProbeInfo;
  hook: PatchHookMeta;
  usedProxyDll?: string;
  cleanup: () => void;
}> {
  const ws = realpathSafe(workspace);
  const wsPaths = resolveWorkspacePaths(ws);
  const { track, rows: probeRows } = pickPreTranslateProbeRows(ws, 3);
  const primaryRow = probeRows[0];
  const rawSource = String(primaryRow.source || '');
  const rowId = String(primaryRow.id || 'probe_0');
  const rowFile = String(primaryRow.file || '');
  const rowLine = typeof primaryRow.line === 'number' && Number.isFinite(primaryRow.line) ? primaryRow.line : 1;

  const probeRoot = path.join(
    wsPaths.smokeTmpDir,
    `probe-${Date.now()}-${String(++smokeRunSeq).padStart(3, '0')}-${process.pid}`
  );
  const overlayDir = path.join(probeRoot, 'overlay');
  fs.mkdirSync(overlayDir, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(probeRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  };

  try {
    const patchConfig = loadWorkspacePatchConfig(ws);
    const exeInfo = inspectPrimaryGameExe(ws);
    const controlPattern =
      resolveWorkspaceControlPattern(ws, options.homeDir ?? null, activeSkill.engine) ?? undefined;
    const allowedCustomEncodings = collectSkillCustomEncodings(activeSkill.engineJson);
    const encHint = readSkillEncodingHint(activeSkill.engineJson);

    const buildMutRows = (targetEncoding: string) =>
      probeRows.map((row) => {
        const src = String(row.source || '');
        const probeTarget = buildPreTranslateProbeTarget(src, targetEncoding, controlPattern);
        const effTarget =
          targetEncoding.toLowerCase() === 'gbk' ? normalizeGbkCompatText(probeTarget) : probeTarget;
        return { ...row, track, target: effTarget, ok: true };
      });

    const buildProbeInfo = (
      mutRows: Array<Record<string, unknown>>,
      targetEncoding: string
    ): PreTranslateSmokeProbeInfo => {
      const additionalProbes = mutRows.slice(1).map((m, idx) => ({
        id: String(m.id || `probe_${idx + 1}`),
        file: String(m.file || ''),
        line: typeof m.line === 'number' && Number.isFinite(m.line) ? m.line : 1,
        source: String(m.source || ''),
        target: String(m.target || ''),
      }));
      return {
        track,
        id: rowId,
        file: rowFile,
        line: rowLine,
        source: rawSource,
        target: String(mutRows[0]?.target || ''),
        targetEncoding,
        ...(additionalProbes.length > 0 ? { additionalProbes } : {}),
      };
    };

    const stageHookIntoOverlay = (
      resolvedHook: PatchHookMeta,
      targetEncoding: string,
      strategy: 'direct_file_replace' | 'archive_replace'
    ): string | undefined => {
      if (!resolvedHook.needed || patchConfig.hookMode === 'none') return undefined;
      const targetExeRel = toPosix(resolvedHook.target_exe || exeInfo.exeRel || '');
      const rawExeDir = targetExeRel ? toPosix(path.posix.dirname(targetExeRel)) : '';
      const exeDirPosix = rawExeDir && rawExeDir !== '.' ? rawExeDir : '';
      const absExe = targetExeRel ? path.join(ws, ...targetExeRel.split('/')) : null;
      const proxyDllName = chooseProxyDllName(absExe, patchConfig.proxyDll);
      const effectiveHook: PatchHookMeta = {
        ...resolvedHook,
        proxy_dll: proxyDllName,
      };
      const iniRel = exeDirPosix ? `${exeDirPosix}/papercup_patch.ini` : 'papercup_patch.ini';
      const iniPath = path.join(overlayDir, ...iniRel.split('/'));
      fs.mkdirSync(path.dirname(iniPath), { recursive: true });
      fs.writeFileSync(
        iniPath,
        buildPatchIni({
          engine: activeSkill.engine,
          strategy,
          targetLang: profile.targetLang,
          targetEncoding,
          hook: effectiveHook,
        }),
        'utf8'
      );

      const resolvedProxy = resolvePrebuiltProxyDll(
        resolvedHook.target_arch ?? exeInfo.arch ?? 'unknown',
        proxyDllName,
        { binDir: options.proxyBinDir }
      );
      if (!resolvedProxy) return undefined;
      const proxyRel = exeDirPosix ? `${exeDirPosix}/${proxyDllName}` : proxyDllName;
      const proxyDst = path.join(overlayDir, ...proxyRel.split('/'));
      fs.mkdirSync(path.dirname(proxyDst), { recursive: true });
      fs.copyFileSync(resolvedProxy.path, proxyDst);
      return proxyDllName;
    };

    if (activeSkill.pipeline === 'direct') {
      if (!activeSkill.applyPy) {
        throw new SmokeError(`direct 技能 ${activeSkill.engine} 缺少 apply.py，无法生成前置微改测试补丁。`);
      }
      const directRel = String(activeSkill.engineJson.direct_root || '.').trim().replace(/\\/g, '/');
      if (directRel && directRel !== '.' && isBackupOrNonOriginalArchiveRel(directRel)) {
        throw new SmokeError(
          `拒绝生成前置冒烟补丁：direct 技能的 direct_root「${directRel}」位于内部临时或备份目录，请重新执行 vn_learn_skill。`
        );
      }
      const sourceDirectRoot = !directRel || directRel === '.' ? ws : path.resolve(ws, directRel);
      const relCheck = path.relative(ws, sourceDirectRoot);
      if (
        relCheck.startsWith('..') ||
        path.isAbsolute(relCheck) ||
        isSymlinkPath(sourceDirectRoot) ||
        !fs.existsSync(sourceDirectRoot) ||
        !fs.statSync(sourceDirectRoot).isDirectory()
      ) {
        throw new SmokeError(`direct 技能目标目录无效或越界：${directRel}`);
      }

      const explicitTargets = new Set<string>();
      for (const r of probeRows) {
        const rf = String(r.file || '').trim();
        if (rf) explicitTargets.add(rf);
      }
      const stageDirectRoot = path.join(probeRoot, 'direct');
      stageDirectWorkspaceSubset(sourceDirectRoot, stageDirectRoot, explicitTargets);

      const sourceEncoding = probeSourceEncoding(stageDirectRoot, [{ rows: probeRows }], encHint);
      const resolved = resolvePatchEncodingAndHook({
        engineKind: 'direct',
        sourceEncoding,
        profile,
        patchConfig,
        exeInfo,
        allowCustomEncoding: true,
        allowedCustomEncodings,
        runtimeCharset: readSkillRuntimeCharsetHint(activeSkill.engineJson),
      });

      const mutRows = buildMutRows(resolved.targetEncoding);
      const probeJsonl = path.join(probeRoot, 'probe.jsonl');
      fs.writeFileSync(probeJsonl, mutRows.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

      const preSnap = snapshotFiles(stageDirectRoot, new Set());
      await runPythonScript(
        activeSkill.applyPy,
        [probeJsonl, stageDirectRoot],
        stageDirectRoot,
        undefined,
        options.signal,
        buildApplyPythonEnv(ws, wsPaths.fontsDataDir, resolved.targetEncoding, patchConfig.customOptions)
      );
      unlinkBaksRecursive(stageDirectRoot);
      const postSnap = snapshotFiles(stageDirectRoot, new Set());

      const changedRels: string[] = [];
      for (const [rel, meta] of postSnap.entries()) {
        const before = preSnap.get(rel);
        if (!before || before.size !== meta.size || before.sha256 !== meta.sha256) {
          changedRels.push(rel);
        }
      }
      if (!changedRels.length) {
        throw new SmokeError('前置单条微改写回后未检测到任何变更文件，apply.py 未生效。');
      }

      const prefixRel = directRel && directRel !== '.' ? toPosix(directRel).replace(/\/+$/, '') : '';
      for (const rel of changedRels) {
        staysInside('.', rel);
        const installRel = prefixRel ? `${prefixRel}/${rel}` : rel;
        const srcFull = path.join(stageDirectRoot, rel);
        const dstFull = path.join(overlayDir, installRel);
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        fs.copyFileSync(srcFull, dstFull);
      }

      overlayPatchedFontsIntoDir(ws, overlayDir);
      const usedProxyDll = stageHookIntoOverlay(resolved.hook, resolved.targetEncoding, 'direct_file_replace');
      const probeInfo = buildProbeInfo(mutRows, resolved.targetEncoding);
      const savedProbeDir = mirrorLastProbeArtifacts({
        workspace: ws,
        probeJsonlPath: probeJsonl,
        overlayDir,
        probeInfo,
        activeSkill,
        targetEncoding: resolved.targetEncoding,
      });
      probeInfo.savedProbeDir = savedProbeDir;

      return {
        overlayDir,
        probeInfo,
        hook: resolved.hook,
        ...(usedProxyDll ? { usedProxyDll } : {}),
        cleanup,
      };
    }

    // Skill-based archive pipeline
    if (isSymlinkPath(wsPaths.unpackedDir) || !fs.existsSync(wsPaths.unpackedDir)) {
      throw new SmokeError('前置单条微改冒烟测试需要先存在 .papercup/tmp/unpacked/ 解包目录；请先运行 vn_unpack。');
    }
    const stagedUnpacked = path.join(probeRoot, 'unpacked');
    copyTreeRecursive(wsPaths.unpackedDir, stagedUnpacked);
    const manifests = findUnpackManifests(stagedUnpacked);
    const skillManifests = manifests.filter((m) => path.basename(m) === SKILL_MANIFEST);
    if (!skillManifests.length) {
      throw new SmokeError('前置单条微改冒烟测试未找到 .skill-manifest.json，请先通过 vn_unpack 解包。');
    }
    if (!activeSkill.repackPy) {
      throw new SmokeError(`自定义技能 ${activeSkill.engine} 缺少 repack.py，无法组装前置测试封包。`);
    }

    let applyRoot = stagedUnpacked;
    if (rowFile && !fs.existsSync(path.join(stagedUnpacked, rowFile))) {
      for (const m of skillManifests) {
        const cand = path.dirname(m);
        if (fs.existsSync(path.join(cand, rowFile))) {
          applyRoot = cand;
          break;
        }
      }
    }

    const sourceEncoding = probeSourceEncoding(applyRoot, [{ rows: probeRows }], encHint);
    const resolved = resolvePatchEncodingAndHook({
      engineKind: 'skill',
      sourceEncoding,
      profile,
      patchConfig,
      exeInfo,
      allowCustomEncoding: Boolean(activeSkill.applyPy),
      allowedCustomEncodings,
      runtimeCharset: readSkillRuntimeCharsetHint(activeSkill.engineJson),
    });

    const mutRows = buildMutRows(resolved.targetEncoding);
    const probeJsonl = path.join(probeRoot, 'probe.jsonl');
    fs.writeFileSync(probeJsonl, mutRows.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

    const preSnapshots = new Map<string, Map<string, { size: number; sha256: string }>>();
    for (const m of skillManifests) {
      const mDir = path.dirname(m);
      preSnapshots.set(mDir, snapshotFiles(mDir));
    }

    if (activeSkill.applyPy) {
      await runPythonScript(
        activeSkill.applyPy,
        [probeJsonl, applyRoot],
        applyRoot,
        undefined,
        options.signal,
        buildApplyPythonEnv(ws, wsPaths.fontsDataDir, resolved.targetEncoding, patchConfig.customOptions)
      );
    } else {
      const permissiveMem: ProjectMemory = { glossary: {}, persona: {}, lessons: [], personaErrors: [] };
      applyResults(ws, applyRoot, mutRows, profile, permissiveMem, track, {
        allowPartial: true,
        encoding: resolved.targetEncoding,
        controlPattern,
        homeDir: options.homeDir ?? null,
      });
    }
    unlinkBaksRecursive(stagedUnpacked);

    const detectedOriginal = scanWorkspace(ws, options.homeDir ?? null).hits.filter(
      (h) => !isBackupOrNonOriginalArchiveRel(h.path)
    );
    let repackedCount = 0;
    for (const m of skillManifests) {
      const mName = path.basename(m);
      const mDir = path.dirname(m);
      const mData = JSON.parse(fs.readFileSync(m, 'utf8')) as Record<string, unknown>;
      const preSnap = preSnapshots.get(mDir) ?? new Map();
      const changed = detectChangedEntriesInManifestDir(mDir, mData, preSnap);
      if (!changed.length) continue;

      const orig = String(mData.source || '');
      const relArchive = validateWritebackSourceArchive(ws, orig, mName, mData, detectedOriginal);
      const targetArchive = path.join(overlayDir, relArchive);
      fs.mkdirSync(path.dirname(targetArchive), { recursive: true });
      await runPythonScript(activeSkill.repackPy, [mDir, targetArchive], mDir, undefined, options.signal);
      const wsOrigArchive = path.join(ws, ...relArchive.split('/'));
      if (!isSymlinkPath(wsOrigArchive) && fs.existsSync(wsOrigArchive) && fs.statSync(wsOrigArchive).isFile()) {
        assertNoDestructiveShrinkReplace(
          {
            action: 'replace',
            targetRel: relArchive,
            originalBytes: fs.statSync(wsOrigArchive).size,
            replacementBytes: fs.statSync(targetArchive).size,
            contextLabel: 'vn_smoke_test(preTranslateProbe)',
          },
          (msg) => new SmokeError(msg)
        );
      }
      repackedCount += 1;
    }

    if (repackedCount === 0) {
      throw new SmokeError('前置单条微改写回后未检测到任何封包变更，写回脚本未生效。');
    }

    overlayPatchedFontsIntoDir(ws, overlayDir);
    const usedProxyDll = stageHookIntoOverlay(resolved.hook, resolved.targetEncoding, 'archive_replace');
    const probeInfo = buildProbeInfo(mutRows, resolved.targetEncoding);
    const savedProbeDir = mirrorLastProbeArtifacts({
      workspace: ws,
      probeJsonlPath: probeJsonl,
      overlayDir,
      probeInfo,
      activeSkill,
      targetEncoding: resolved.targetEncoding,
    });
    probeInfo.savedProbeDir = savedProbeDir;

    return {
      overlayDir,
      probeInfo,
      hook: resolved.hook,
      ...(usedProxyDll ? { usedProxyDll } : {}),
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function checkPreTranslateSmokeGate(
  workspace: string,
  options: {
    homeDir?: string | null;
    platform?: NodeJS.Platform;
    allowSkipPreTranslateSmoke?: boolean;
  } = {}
): PreTranslateSmokeGateResult {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return { allowed: true, skipped: true, skipReason: 'non_windows' };
  }
  const ws = realpathSafe(workspace);
  const smokeCfg = getSmokeConfigState(ws, options.homeDir).effective;
  if (!smokeCfg.enabled) {
    return { allowed: true, skipped: true, skipReason: 'smoke_disabled' };
  }
  const activeSkill = resolveActiveCustomSkillForPreTranslateSmoke(ws, options.homeDir);
  if (!activeSkill) {
    return { allowed: true, skipped: true, skipReason: 'builtin_engine' };
  }
  if (options.allowSkipPreTranslateSmoke) {
    return { allowed: true, skipped: true, skipReason: 'override', activeSkill };
  }

  const record = readPreTranslateSmokeRecord(ws);
  if (!record) {
    return {
      allowed: false,
      skipped: false,
      activeSkill,
      record: null,
      reason: `自定义技能「${activeSkill.engine}」已启用运行时冒烟门禁，全量批译前必须先运行一次前置单条微改冒烟探针：请先调用 vn_smoke_test(preTranslateProbe=true) 验证重封包与编码真机可加载后再执行 vn_translate_batches。`,
    };
  }
  if (record.skillDigest !== activeSkill.skillDigest || record.engine !== activeSkill.engine) {
    return {
      allowed: false,
      skipped: false,
      activeSkill,
      record,
      reason: `自定义技能「${activeSkill.engine}」脚本或配置在最近一次前置冒烟后已发生变更（技能摘要不匹配），请重新运行 vn_smoke_test(preTranslateProbe=true) 通过后再执行 vn_translate_batches。`,
    };
  }
  if (!record.ok) {
    const errRules = record.errorRules?.length ? record.errorRules.join(', ') : 'unknown';
    return {
      allowed: false,
      skipped: false,
      activeSkill,
      record,
      reason: `自定义技能「${activeSkill.engine}」批译前单条微改冒烟测试未通过（${errRules}）；请先排查修复技能写回/重封包或编码问题并重新通过 vn_smoke_test(preTranslateProbe=true) 后再开始全量批译。`,
    };
  }
  return {
    allowed: true,
    skipped: false,
    activeSkill,
    record,
  };
}

/* ========================= Top-level Smoke Test Runner ========================= */

export async function runSmokeTest(
  workspace: string,
  profile: LocalizationProfile,
  options: {
    homeDir?: string | null;
    patchManifestPath?: string | null;
    overlayPath?: string | null;
    overlayTarget?: string | null;
    preTranslateProbe?: boolean;
    exeOverride?: string;
    advanceSteps?: number;
    timeoutSec?: number;
    useLocaleEmulator?: boolean;
    skipVision?: boolean;
    proxyBinDir?: string | null;
    driver?: SmokeExecutionDriver;
    vision?: SmokeVisionBridge;
    signal?: AbortSignal;
  } = {}
): Promise<{ report: SmokeReport; reportPath: string }> {
  const ws = realpathSafe(workspace);
  const cfgState = getSmokeConfigState(ws, options.homeDir);
  const visionSkippedByParam = Boolean(options.skipVision && cfgState.effective.visionEnabled);
  const effectiveCfg: SmokeTestConfig = {
    ...cfgState.effective,
    ...(typeof options.advanceSteps === 'number'
      ? { advanceSteps: Math.max(3, Math.min(100, Math.round(options.advanceSteps))) }
      : {}),
    ...(typeof options.timeoutSec === 'number'
      ? { timeoutSec: Math.max(15, Math.min(300, Math.round(options.timeoutSec))) }
      : {}),
    ...(options.skipVision ? { visionEnabled: false } : {}),
  };

  const explicitManifest = options.patchManifestPath?.trim() || '';
  const explicitOverlay = options.overlayPath?.trim() || '';
  const isPreTranslateProbe = Boolean(options.preTranslateProbe);
  if (isPreTranslateProbe && (explicitManifest || explicitOverlay)) {
    throw new SmokeError('preTranslateProbe 不能与 patchManifest 或 overlayPath 同时指定。');
  }
  if (explicitManifest && explicitOverlay) {
    throw new SmokeError('patchManifest 与 overlayPath 不能同时指定，请二选一。');
  }

  let activeSkill: ActiveCustomSkillInfo | null = null;
  let probePrep: Awaited<ReturnType<typeof preparePreTranslateProbeOverlay>> | null = null;
  if (isPreTranslateProbe) {
    activeSkill = resolveActiveCustomSkillForPreTranslateSmoke(ws, options.homeDir ?? null);
    if (!activeSkill) {
      throw new SmokeError(
        '当前工作区未使用自定义逆向技能（内置引擎无需运行批译前单条微改冒烟探针，可于译后直接执行 vn_smoke_test）。'
      );
    }
    probePrep = await preparePreTranslateProbeOverlay(ws, profile, activeSkill, {
      homeDir: options.homeDir,
      proxyBinDir: options.proxyBinDir,
      signal: options.signal,
    });
  }

  try {
    // If overlayPath points to a patch bundle directory that already contains patch_manifest.json, route cleanly to manifest mode.
    let manifestPath = explicitManifest;
    let overlayPath = probePrep ? probePrep.overlayDir : explicitOverlay;
    if (!manifestPath && overlayPath && !probePrep) {
      const absOv = path.isAbsolute(overlayPath) ? path.resolve(overlayPath) : path.resolve(ws, overlayPath);
      if (!isSymlinkPath(absOv) && fs.existsSync(absOv) && fs.statSync(absOv).isDirectory()) {
        const autoManifest = path.join(absOv, 'patch_manifest.json');
        if (!isSymlinkPath(autoManifest) && fs.existsSync(autoManifest) && fs.statSync(autoManifest).isFile()) {
          manifestPath = autoManifest;
          overlayPath = '';
        }
      }
    }
    const wsPaths = resolveWorkspacePaths(ws);
    if (!manifestPath && !overlayPath) {
      manifestPath = readLastPatchMeta(ws)?.manifest_path || '';
      if (!manifestPath && !isSymlinkPath(wsPaths.patchManifestFile) && fs.existsSync(wsPaths.patchManifestFile)) {
        manifestPath = wsPaths.patchManifestFile;
      }
    }
    const absManifestForReport = manifestPath
      ? (path.isAbsolute(manifestPath) ? path.resolve(manifestPath) : path.resolve(ws, manifestPath))
      : '';
    if (!manifestPath && !overlayPath) {
      throw new SmokeError(
        '未指定 patchManifest / overlayPath 且工作区没有最近一次 vn_writeback 记录；请先运行 vn_writeback 生成补丁包，或通过 overlayPath 指定要测试的替换文件/目录。'
      );
    }

    let sandbox:
      | ReturnType<typeof prepareSmokeSandbox>
      | ReturnType<typeof prepareSmokeSandboxFromOverlay>;
    try {
      sandbox = overlayPath
        ? prepareSmokeSandboxFromOverlay(ws, overlayPath, {
            overlayTarget: probePrep ? undefined : options.overlayTarget,
            exeOverride: options.exeOverride,
            homeDir: options.homeDir,
          })
        : prepareSmokeSandbox(ws, manifestPath, {
            exeOverride: options.exeOverride,
            proxyBinDir: options.proxyBinDir,
          });
    } catch (err) {
      if (err instanceof SmokeError) {
        throw err;
      }
      // Unexpected OS/FS failure during sandbox preparation -> classify as harness.driver_failed (not patch failure)
      const fallbackRunId = `run-${Date.now()}-${String(++smokeRunSeq).padStart(3, '0')}-${process.pid}`;
      const errMsg = (err as Error)?.message || String(err);
      const findings: SmokeFinding[] = [
        {
          ruleId: 'harness.driver_failed',
          severity: 'error',
          message: `冒烟测试沙箱准备失败（工具故障，非补丁问题）：${errMsg}`,
        },
      ];
      const existingRepair = isPreTranslateProbe ? readSmokeRepairState(ws) : null;
      const repairState = isPreTranslateProbe
        ? {
            failedRounds: existingRepair?.failedRounds ?? 0,
            maxRepairRounds: effectiveCfg.maxRepairRounds,
          }
        : updateSmokeRepairState(ws, false, ['harness.driver_failed'], effectiveCfg.maxRepairRounds, {
            isInfraFailure: true,
          });
      const diag = preserveSmokeFailureDiagnostics({
        workspace: ws,
        runId: fallbackRunId,
        failureKind: 'harness',
        errorRules: ['harness.driver_failed'],
        driverLog: { stderr: `sandbox preparation error: ${errMsg}\n` },
      });
      let manifestSha = '';
      if (absManifestForReport) {
        try {
          manifestSha = sha256Hex(fs.readFileSync(absManifestForReport));
        } catch {
          // ignore
        }
      }
      const report: SmokeReport = {
        schema: 1,
        createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        ...(isPreTranslateProbe ? { phase: 'pre_translate' as const } : {}),
        mode: overlayPath ? 'overlay' : 'manifest',
        ...(activeSkill ? { skillEngine: activeSkill.engine, skillDigest: activeSkill.skillDigest } : {}),
        ...(probePrep ? { preTranslateProbe: probePrep.probeInfo } : {}),
        patchManifestPath: absManifestForReport ? absManifestForReport.replace(/\\/g, '/') : '',
        patchManifestSha256: manifestSha,
        ...(overlayPath && !isPreTranslateProbe ? { overlayPath: path.resolve(overlayPath).replace(/\\/g, '/') } : {}),
        targetExe: options.exeOverride?.trim() || '',
        targetArch: 'unknown',
        usedLocaleEmulator: false,
        usedTextractor: false,
        inputMode: 'none',
        durationMs: 0,
        stepsAdvanced: 0,
        repairRound: repairState.failedRounds,
        maxRepairRounds: effectiveCfg.maxRepairRounds,
        repairLimitReached: false,
        ok: false,
        failureKind: 'harness',
        errorCount: 1,
        warningCount: 0,
        findings,
        screenshots: [],
        diagnosticsDir: diag.diagnosticsDir,
        diagnosticsFiles: diag.diagnosticsFiles,
        vision: { status: 'skipped', reason: '冒烟测试在游戏启动前发生工具故障，跳过视觉检查', defects: [] },
        summary: `冒烟测试因工具故障未能完成（harness.driver_failed，非补丁问题，不计入自动修复轮数；当前已用 ${repairState.failedRounds}/${effectiveCfg.maxRepairRounds} 轮；诊断现场：${diag.diagnosticsDir}）。`,
      };
      const reportPath = writeSmokeReport(ws, report);
      if (isPreTranslateProbe && activeSkill && probePrep) {
        writePreTranslateSmokeRecord(ws, {
          schema: 1,
          phase: 'pre_translate',
          createdAt: report.createdAt,
          engine: activeSkill.engine,
          skillName: activeSkill.skillName,
          skillPipeline: activeSkill.pipeline,
          skillDigest: activeSkill.skillDigest,
          ok: false,
          failureKind: 'harness',
          targetExe: report.targetExe,
          stepsAdvanced: 0,
          durationMs: 0,
          errorCount: 1,
          warningCount: 0,
          errorRules: ['harness.driver_failed'],
          probe: probePrep.probeInfo,
          overlayFiles: [],
          reportPath: displayRel(reportPath, ws),
        });
      }
      return { report, reportPath };
    }

    const framesDir = path.join(ws, SMOKE_FRAMES_REL);
    // Clean previous frames directory so only current run's screenshots remain
    if (!isSymlinkPath(framesDir) && fs.existsSync(framesDir)) {
      fs.rmSync(framesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(framesDir, { recursive: true });

    const trCliPath = selectTextractorCliForArch(cfgState.tools, sandbox.exeArch);
    const textractorArchMismatch =
      !trCliPath && cfgState.tools.textractor.available && (sandbox.exeArch === 'x86' || sandbox.exeArch === 'x64')
        ? { exeArch: sandbox.exeArch }
        : undefined;
    const leProcPath = cfgState.tools.localeEmulator.leProcPath;
    const manifestHook = sandbox.mode === 'manifest' ? sandbox.manifest.hook : probePrep?.hook;
    const leRequested = Boolean(
      leProcPath && (options.useLocaleEmulator ?? Boolean(manifestHook?.needed))
    );
    const leTargetCodepage = manifestHook?.codepage ?? null;
    const leProfileGuid =
      leRequested && leProcPath
        ? findLocaleEmulatorProfileGuid(leProcPath, leTargetCodepage)
        : null;
    let shouldUseLe = leRequested;
    let leProfileWarning: string | undefined;
    if (leRequested && leProcPath && !leProfileGuid) {
      const existingProfiles = listLocaleEmulatorProfiles(leProcPath);
      if (leTargetCodepage != null || existingProfiles.length > 0) {
        shouldUseLe = false;
        leProfileWarning =
          leTargetCodepage != null
            ? `LEConfig.xml 中未找到匹配目标代码页 ${leTargetCodepage} 的 Locale Emulator 配置，已跳过 LE 启动以避免以错误区域代码页运行导致乱码。`
            : 'LEConfig.xml 中未找到匹配的日区（ja-JP）Locale Emulator 配置，已跳过 LE 启动。';
      }
    }

    const driver = options.driver ?? windowsSmokeDriver;
    let driverResult: SmokeDriverRunResult;
    let driverScriptBytes: Buffer | null = null;
    const driverScriptPath = path.join(sandbox.sandboxDir, '_papercup_smoke_driver.ps1');
    try {
      try {
        driverResult = await driver.run({
          sandboxDir: sandbox.sandboxDir,
          exePath: sandbox.exePath,
          exeArch: sandbox.exeArch,
          framesDir,
          config: effectiveCfg,
          useLocaleEmulator: shouldUseLe,
          leProcPath,
          leProfileGuid,
          textractorCliPath: trCliPath,
          vision: effectiveCfg.visionEnabled ? options.vision : undefined,
          signal: options.signal,
        });
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        driverResult = {
          launched: false,
          harnessFailed: true,
          harnessError: msg,
          launchError: msg,
          driverLog: { stderr: `${msg}\n` },
          windowFound: false,
          inputMode: 'none',
          stepsAdvanced: 0,
          durationMs: 0,
          processExitedEarly: true,
          hungDetected: false,
          frozenScreen: true,
          frames: [],
          textractorLines: [],
        };
      }
      try {
        if (!isSymlinkPath(driverScriptPath) && fs.existsSync(driverScriptPath) && fs.statSync(driverScriptPath).isFile()) {
          driverScriptBytes = fs.readFileSync(driverScriptPath);
        }
      } catch {
        // ignore unreadable driver script
      }
    } finally {
      // Always delete the hardlinked game sandbox so original game inodes/copies never linger
      sandbox.cleanup();
    }

    // Collect sample translations for vision reference
    const sampleTranslations: string[] = [];
    if (probePrep?.probeInfo.target) {
      sampleTranslations.push(probePrep.probeInfo.target);
      for (const extra of probePrep.probeInfo.additionalProbes ?? []) {
        if (extra.target) sampleTranslations.push(extra.target);
      }
    } else {
      const scenFile = wsPaths.resultsTrackFile('scenario');
      if (!isSymlinkPath(scenFile) && fs.existsSync(scenFile)) {
        try {
          for (const row of readResultsJsonl(scenFile).slice(0, 8)) {
            const t = String(row.target || '').trim();
            if (t) sampleTranslations.push(t);
          }
        } catch {
          // ignore
        }
      }
    }

    const validFrames: SmokeCapturedFrame[] = driverResult.frames
      .filter((f) => f.path && fs.existsSync(f.path))
      .slice(0, effectiveCfg.maxScreenshots)
      .map((f) => ({
        ...f,
        relPath: displayRel(f.path, ws),
      }));

    let visionInspection: { status: 'checked' | 'skipped'; reason?: string; defects: SmokeVisionDefect[] } | undefined;
    if (effectiveCfg.visionEnabled) {
      if (!options.vision?.inspectFrames) {
        visionInspection = { status: 'skipped', reason: '未挂载多模态视觉适配器，已降级跳过。', defects: [] };
      } else if (!validFrames.length) {
        visionInspection = { status: 'skipped', reason: '本次运行未采集到有效游戏截图，跳过视觉审查。', defects: [] };
      } else {
        try {
          visionInspection = await options.vision.inspectFrames(
            validFrames.map((f) => ({ label: f.label, path: f.path })),
            {
              targetLang: profile.targetLang,
              sampleTranslations,
              ...(isPreTranslateProbe ? { probeMode: 'pre_translate' as const } : {}),
            },
            options.signal
          );
        } catch (err) {
          visionInspection = {
            status: 'skipped',
            reason: `视觉模型调用失败已降级跳过：${(err as Error).message}`,
            defects: [],
          };
        }
      }
    }

    const evaluated = evaluateSmokeRules({
      driverResult,
      workspace: ws,
      targetLang: profile.targetLang,
      textractorConfigured: Boolean(trCliPath),
      textractorArchMismatch,
      leProfileWarning,
      visionEnabled: effectiveCfg.visionEnabled,
      visionSkippedByParam,
      ...(isPreTranslateProbe
        ? {
            probeMode: 'pre_translate' as const,
            extraSampleTargets: probePrep
              ? [
                  probePrep.probeInfo.target,
                  ...(probePrep.probeInfo.additionalProbes?.map((p) => p.target) ?? []),
                ]
              : [],
          }
        : {}),
      visionInspection,
    });

    try {
      const bundledFonts = scanWorkspaceBundledFonts(ws, profile.targetLang);
      const unpatchedMissingFonts = bundledFonts.filter((f) => f.needsPatch && !f.alreadyPatched);
      if (unpatchedMissingFonts.length > 0) {
        const details = unpatchedMissingFonts
          .slice(0, 3)
          .map(
            (f) =>
              `${f.relPath}（缺 ${f.probeMissingCount}/${f.probeTotalCount} 字，如 ${f.missingSamples.slice(0, 6).join('')}）`
          )
          .join('；');
        evaluated.findings.push({
          ruleId: 'font.missing_glyphs',
          severity: 'warning',
          message: `检测到游戏内嵌字体缺少目标语言字形（尚未经 reverser 调用 vn_patch_font 修补）：${details}。`,
          evidence: {
            fonts: unpatchedMissingFonts.map((f) => ({
              relPath: f.relPath,
              familyName: f.familyName,
              probeMissingCount: f.probeMissingCount,
              probeTotalCount: f.probeTotalCount,
              missingSamples: f.missingSamples,
            })),
          },
        });
      }
    } catch {
      // Best-effort font coverage scan
    }

    const errorFindings = evaluated.findings.filter((f) => f.severity === 'error');
    const warningFindings = evaluated.findings.filter((f) => f.severity === 'warning');
    const errorRules = errorFindings.map((f) => f.ruleId);
    const ok = errorFindings.length === 0;
    const isInfraFailure = !ok && isHarnessOnlyErrors(errorRules);
    const existingRepair = isPreTranslateProbe ? readSmokeRepairState(ws) : null;
    const repairState = isPreTranslateProbe
      ? {
          failedRounds: existingRepair?.failedRounds ?? 0,
          maxRepairRounds: effectiveCfg.maxRepairRounds,
        }
      : updateSmokeRepairState(
          ws,
          ok,
          errorRules,
          effectiveCfg.maxRepairRounds,
          { isInfraFailure, mode: sandbox.mode }
        );
    const repairLimitReached =
      !isPreTranslateProbe &&
      !ok &&
      !isInfraFailure &&
      effectiveCfg.maxRepairRounds > 0 &&
      repairState.failedRounds >= effectiveCfg.maxRepairRounds;

    let diagnosticsDir: string | undefined;
    let diagnosticsFiles: string[] | undefined;
    if (!ok) {
      const preserved = preserveSmokeFailureDiagnostics({
        workspace: ws,
        runId: sandbox.runId,
        failureKind: isInfraFailure ? 'harness' : 'patch',
        errorRules,
        driverScriptBytes,
        driverLog: driverResult.driverLog,
        frames: validFrames,
        extraMeta: {
          ...(isPreTranslateProbe ? { phase: 'pre_translate' } : {}),
          targetExe: sandbox.exeRel,
          durationMs: driverResult.durationMs,
          stepsAdvanced: driverResult.stepsAdvanced,
          exitCode: driverResult.exitCode ?? null,
        },
      });
      diagnosticsDir = preserved.diagnosticsDir;
      diagnosticsFiles = preserved.diagnosticsFiles;
    } else {
      pruneSmokeFailureDirs(ws, MAX_RETAINED_SMOKE_FAILURES);
    }

    const diagNote = diagnosticsDir ? `；诊断现场已保留于 ${diagnosticsDir}` : '';
    const summary = ok
      ? isPreTranslateProbe
        ? `批译前单条微改冒烟探针通过（引擎 ${activeSkill?.engine ?? 'custom'}）：0 error，${warningFindings.length} warning，推进 ${driverResult.stepsAdvanced} 步（耗时 ${(driverResult.durationMs / 1000).toFixed(1)}s），可开始全量批译。`
        : `冒烟测试通过：0 error，${warningFindings.length} warning，推进 ${driverResult.stepsAdvanced} 步（耗时 ${(driverResult.durationMs / 1000).toFixed(1)}s）。`
      : isInfraFailure
        ? `冒烟测试因工具故障未能完成（${errorRules.join(', ')}，非补丁问题，不计入自动修复轮数；当前已用 ${repairState.failedRounds}/${effectiveCfg.maxRepairRounds} 轮${diagNote}）。请排查冒烟驱动或运行环境后重试。`
        : isPreTranslateProbe
          ? `批译前单条微改冒烟探针失败（引擎 ${activeSkill?.engine ?? 'custom'}）：${errorFindings.length} error（${errorRules.join(', ')}），${warningFindings.length} warning${diagNote}；请先修复自定义技能写回/重封包或编码配置后再投入全量批译。`
          : `冒烟测试失败（第 ${repairState.failedRounds}/${effectiveCfg.maxRepairRounds} 轮）：${errorFindings.length} error（${errorRules.join(', ')}），${warningFindings.length} warning${diagNote}${repairLimitReached ? '；已达自动修复轮数上限，请立即停止自修并向用户呈报完整诊断报告' : ''}。`;

    const usedProxyDll = sandbox.mode === 'manifest' ? sandbox.usedProxyDll : probePrep?.usedProxyDll;

    const report: SmokeReport = {
      schema: 1,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...(isPreTranslateProbe ? { phase: 'pre_translate' as const } : {}),
      mode: sandbox.mode,
      ...(activeSkill ? { skillEngine: activeSkill.engine, skillDigest: activeSkill.skillDigest } : {}),
      ...(probePrep ? { preTranslateProbe: probePrep.probeInfo } : {}),
      patchManifestPath: sandbox.mode === 'manifest' ? absManifestForReport.replace(/\\/g, '/') : '',
      patchManifestSha256: sandbox.mode === 'manifest' ? sandbox.manifestSha256 : '',
      ...(sandbox.mode === 'overlay'
        ? {
            ...(!isPreTranslateProbe ? { overlayPath: sandbox.overlayPath } : {}),
            ...(sandbox.overlayTarget ? { overlayTarget: sandbox.overlayTarget } : {}),
            overlayDigest: sandbox.overlayDigest,
            overlayFiles: sandbox.overlayFiles,
          }
        : {}),
      targetExe: sandbox.exeRel,
      targetArch: sandbox.exeArch,
      usedLocaleEmulator: shouldUseLe,
      usedTextractor: evaluated.textractorSummary.available,
      ...(usedProxyDll ? { usedProxyDll } : {}),
      inputMode: driverResult.inputMode,
      durationMs: driverResult.durationMs,
      stepsAdvanced: driverResult.stepsAdvanced,
      repairRound: repairState.failedRounds,
      maxRepairRounds: effectiveCfg.maxRepairRounds,
      repairLimitReached,
      ok,
      ...(!ok ? { failureKind: isInfraFailure ? ('harness' as const) : ('patch' as const) } : {}),
      errorCount: errorFindings.length,
      warningCount: warningFindings.length,
      findings: evaluated.findings,
      ...(evaluated.crash ? { crash: evaluated.crash } : {}),
      textractor: evaluated.textractorSummary,
      screenshots: validFrames,
      ...(diagnosticsDir ? { diagnosticsDir, diagnosticsFiles } : {}),
      vision: effectiveCfg.visionEnabled
        ? {
            status: visionInspection?.status ?? 'skipped',
            reason: visionInspection?.reason,
            clickAttempted: driverResult.visionClickAttempted,
            defects: visionInspection?.defects ?? [],
          }
        : {
            status: 'skipped',
            reason: visionSkippedByParam ? '本次调用显式传入 skipVision=true，已跳过视觉检查' : '设置中未启用视觉检查',
            ...(visionSkippedByParam ? { skippedByParam: true } : {}),
            defects: [],
          },
      summary,
    };

    const reportPath = writeSmokeReport(ws, report);
    if (isPreTranslateProbe && activeSkill && probePrep) {
      writePreTranslateSmokeRecord(ws, {
        schema: 1,
        phase: 'pre_translate',
        createdAt: report.createdAt,
        engine: activeSkill.engine,
        skillName: activeSkill.skillName,
        skillPipeline: activeSkill.pipeline,
        skillDigest: activeSkill.skillDigest,
        ok,
        ...(!ok ? { failureKind: isInfraFailure ? ('harness' as const) : ('patch' as const) } : {}),
        targetExe: sandbox.exeRel,
        stepsAdvanced: driverResult.stepsAdvanced,
        durationMs: driverResult.durationMs,
        errorCount: errorFindings.length,
        warningCount: warningFindings.length,
        errorRules,
        probe: probePrep.probeInfo,
        overlayFiles: sandbox.mode === 'overlay' ? sandbox.overlayFiles : [],
        reportPath: displayRel(reportPath, ws),
      });
    }
    return { report, reportPath };
  } finally {
    probePrep?.cleanup();
  }
}
