import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  detectBlockedBashHeredocCommand,
  detectBlockedExternalWriteCommand,
  detectBlockedHostMutationCommand,
  detectBlockedHostSearchCommand,
  detectBlockedProcessControlCommand,
  detectBlockedSecretCommand,
  expandHomeVariables,
  extractBashWriteTargets,
  isPathInsideWorkspace,
  isRestrictedSecretPath,
  redactSecrets,
  redactUnknownValue,
  visitShellCommandSegments,
} from './secrets.js';
import { MAX_SCAN_DEPTH, scanWorkspace } from '../vn/archives.js';
import { isSymlinkPath, readWorkspaceTomlSection, realpathSafe, resolveHomeDir } from '../vn/profile.js';
import {
  WORKSPACE_RESULTS_REL,
  WORKSPACE_TOOL_OUTPUTS_REL,
  WORKSPACE_WORK_OUT_REL,
  resolveWorkspacePaths,
} from '../vn/workspace-paths.js';

export const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 16384;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_HARD_STOP_CONSECUTIVE_FAILURES = 0;
export const DEFAULT_MAX_REVERSER_TOOL_CALLS = 0;
export const DEFAULT_MAX_REVERSER_DURATION_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_REVERSER_STALL_CALLS = 0;
export const DEFAULT_MAX_REVERSER_NO_DELIVERABLE_COMPACTIONS = 3;
export const DEFAULT_MAX_REVERSER_TOKENS = 0;
export const DEFAULT_ALLOW_RE_LOOKUP = true;
export const DEFAULT_REVERSER_BASH_TIMEOUT_SEC = 60;
export const DEFAULT_MAIN_BASH_TIMEOUT_SEC = 90;
export const DEFAULT_MAIN_BASH_MAX_TIMEOUT_SEC = 300;

export interface VnResearchConfig {
  maxToolOutputChars: number;
  maxConsecutiveFailures: number;
  hardStopConsecutiveFailures: number;
  maxReverserToolCalls: number;
  maxReverserDurationMs: number;
  maxReverserStallCalls: number;
  maxReverserNoDeliverableCompactions: number;
  maxReverserTokens: number;
  allowReLookup: boolean;
  reverserBashTimeoutSec: number;
  mainBashTimeoutSec: number;
}

export interface GuardedBuiltinToolsOptions {
  bashPath?: string;
  getKnownSecrets?: () => Iterable<string>;
  maxInlineOutputChars?: number;
  defaultBashTimeoutSec?: number;
  maxBashTimeoutSec?: number;
  homeDir?: string | null;
  skillReadRoots?: readonly string[];
  agentRole?: 'main' | 'subagent';
}

export type ProtectedFileCategory = 'results' | 'game_archive' | 'game_binary' | 'game_font';

export interface ProtectedFileSnapshotEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  category: ProtectedFileCategory;
  sampleHash?: string;
}

export interface ProtectedFileMutation {
  rel: string;
  category: ProtectedFileCategory;
  change: 'modified' | 'deleted' | 'created';
  beforeSize?: number;
  afterSize?: number;
  restored?: boolean;
}

/**
 * Only exclude VCS, dependency, virtual-env, and Paper Cup's own internal/patch/unpacked dirs.
 * Do NOT blanket-exempt top-level `release/`, `build/`, `work/`, `results/`, or `classify-src/`:
 * Paper Cup never writes `.exe`/`.dll` or original game archives there, while real games may ship
 * executables or archives under `release/Game.exe` or `build/data.xp3`.
 */
export const PROTECTED_SKIP_TOP_DIRS = new Set([
  '.papercup',
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'patch',
]);
const PROTECTED_GAME_EXCLUDE_TOP_DIRS = PROTECTED_SKIP_TOP_DIRS;

const PROTECTED_FULL_HASH_MAX_BYTES = 4 * 1024 * 1024;
const PROTECTED_SAMPLE_CHUNK_BYTES = 64 * 1024;
const MAX_SINGLE_RESULTS_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_RESULTS_BACKUP_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_FONT_BACKUP_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_FONT_BACKUP_BYTES = 96 * 1024 * 1024;
const MAX_MAIN_AGENT_SCRIPT_INSPECT_BYTES = 256 * 1024;

function normRelKey(relPosix: string): string {
  const clean = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

function isProtectedResultsJsonlRel(relPosix: string): boolean {
  const clean = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const prefix = `${WORKSPACE_RESULTS_REL}/`;
  return clean.toLowerCase().startsWith(prefix) && clean.toLowerCase().endsWith('.jsonl') && clean.length > prefix.length + 6;
}

function isResultsDirRel(relPosix: string): boolean {
  const clean = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return clean.toLowerCase() === WORKSPACE_RESULTS_REL;
}

function isExcludedFromGameProtection(relPosix: string): boolean {
  const clean = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!clean) return false;
  const seg0 = clean.split('/')[0].toLowerCase();
  if (seg0.startsWith('.')) return true;
  if (PROTECTED_GAME_EXCLUDE_TOP_DIRS.has(seg0)) return true;
  if (/^unpacked(?:$|[0-9._-])/i.test(seg0)) return true;
  return false;
}

function isProtectedGameBinaryRel(relPosix: string): boolean {
  const clean = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return !isExcludedFromGameProtection(clean) && /\.(?:exe|dll)$/i.test(clean);
}

export function isProtectedGameFontRel(relPosix: string): boolean {
  const clean = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return !isExcludedFromGameProtection(clean) && /\.(?:ttf|otf|ttc)$/i.test(clean);
}

function resolveWorkspaceRelPosix(rawPath: string, cwd: string): string | null {
  if (!rawPath || !cwd) return null;
  const expanded = expandHomeVariables(rawPath.trim());
  if (!expanded) return null;
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);

  let existing = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const realTarget = path.join(realpathSafe(existing), ...tail);
  const realCwd = realpathSafe(cwd);
  const rel = path.relative(realCwd, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function globToRegExp(globPosix: string): RegExp {
  let out = '^';
  const n = globPosix.length;
  for (let i = 0; i < n; i++) {
    const ch = globPosix[i];
    if (ch === '*') {
      if (i + 1 < n && globPosix[i + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything
        if (i + 2 < n && globPosix[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const close = globPosix.indexOf(']', i + 1);
      if (close > i + 1) {
        let body = globPosix.slice(i + 1, close);
        if (body.startsWith('!')) {
          body = `^${body.slice(1)}`;
        }
        // Escape backslashes inside character class
        body = body.replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = close;
        continue;
      }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out, process.platform === 'win32' ? 'i' : '');
}

function computeProtectedSampleHash(
  absPath: string,
  size: number,
  category: ProtectedFileCategory
): string | undefined {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(`v1:${size}:`);
    if (category === 'results' || size <= PROTECTED_FULL_HASH_MAX_BYTES) {
      hash.update(fs.readFileSync(absPath));
      return hash.digest('hex');
    }
    const fd = fs.openSync(absPath, 'r');
    try {
      const chunkLen = Math.min(PROTECTED_SAMPLE_CHUNK_BYTES, size);
      const buf = Buffer.allocUnsafe(chunkLen);
      const offsets = [
        0,
        Math.max(0, Math.floor((size - chunkLen) / 2)),
        Math.max(0, size - chunkLen),
      ];
      for (const offset of offsets) {
        const readBytes = fs.readSync(fd, buf, 0, chunkLen, offset);
        hash.update(buf.subarray(0, readBytes));
      }
      return hash.digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function protectedResultsBlockMessage(target: string, toolLabel: string): string {
  return `Security guard: 禁止通过 ${toolLabel} 直接修改、覆盖或删除译文汇总文件 "${target}"。${WORKSPACE_RESULTS_REL}/*.jsonl 只能由 vn_merge / vn_post_qa_parallel / vn_translate_batches 生成；如需修改译文，请修改 ${WORKSPACE_WORK_OUT_REL}/ 中的对应批次文件后重新合并。`;
}

function protectedGameFileBlockMessage(target: string, toolLabel: string): string {
  return `Security guard: 禁止通过 ${toolLabel} 直接修改、覆盖或删除游戏原始文件 "${target}"（封包 / .exe / .dll / 字体）。请勿直接改动游戏原始目录；字库补字请委派 reverser 使用 vn_patch_font 生成隔离修补字体，生成补丁请使用 vn_writeback（如确需替换或还原游戏文件，请在对话中向用户说明原因并由用户自行操作或使用 install_patch.bat）。`;
}

/**
 * Snapshot all protected files inside the active workspace:
 * - `results/*.jsonl` (authoritative merged localization outputs)
 * - archives recognized by `vn_detect` (`scanWorkspace`) outside Papercup working dirs
 * - `*.exe` / `*.dll` binaries and `*.ttf` / `*.otf` / `*.ttc` fonts outside Papercup working dirs
 */
export function collectProtectedWorkspaceSnapshot(
  cwd: string,
  homeDir?: string | null
): Map<string, ProtectedFileSnapshotEntry> {
  const snap = new Map<string, ProtectedFileSnapshotEntry>();
  if (!cwd) return snap;
  const realCwd = realpathSafe(cwd);
  if (!fs.existsSync(realCwd)) return snap;

  const recordFile = (absPath: string, relPosix: string, category: ProtectedFileCategory) => {
    try {
      if (isSymlinkPath(absPath)) return;
      const st = fs.statSync(absPath);
      if (!st.isFile()) return;
      const key = normRelKey(relPosix);
      if (!snap.has(key)) {
        const sampleHash = computeProtectedSampleHash(absPath, st.size, category);
        snap.set(key, {
          rel: relPosix,
          size: st.size,
          mtimeMs: st.mtimeMs,
          category,
          ...(sampleHash ? { sampleHash } : {}),
        });
      }
    } catch {
      // ignore vanished or unreadable file
    }
  };

  // 1. Existing .papercup/data/results/**/*.jsonl
  const resultsDir = resolveWorkspacePaths(realCwd).resultsDir;
  if (!isSymlinkPath(resultsDir) && fs.existsSync(resultsDir)) {
    const walkResults = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (isSymlinkPath(full)) continue;
        if (ent.isDirectory()) {
          walkResults(full, depth + 1);
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.jsonl')) {
          const rel = path.relative(realCwd, full).replace(/\\/g, '/');
          recordFile(full, rel, 'results');
        }
      }
    };
    walkResults(resultsDir, 0);
  }

  // 2. Game archives detected by vn_detect (scanWorkspace)
  try {
    const resolvedHome = homeDir === undefined ? resolveHomeDir() : homeDir;
    const scan = scanWorkspace(realCwd, resolvedHome);
    for (const hit of scan.hits) {
      const rel = hit.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || isExcludedFromGameProtection(rel)) continue;
      recordFile(path.join(realCwd, rel), rel, 'game_archive');
    }
  } catch {
    // non-fatal if workspace cannot be scanned
  }

  // 3. Game binaries (*.exe / *.dll) and original game fonts (*.ttf / *.otf / *.ttc) outside Papercup working dirs
  const walkGameAssets = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (isSymlinkPath(full)) continue;
      const rel = path.relative(realCwd, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (depth === 0 && isExcludedFromGameProtection(ent.name)) continue;
        if (ent.name.startsWith('.')) continue;
        walkGameAssets(full, depth + 1);
      } else if (ent.isFile()) {
        if (/\.(?:exe|dll)$/i.test(ent.name)) {
          if (!isExcludedFromGameProtection(rel)) {
            recordFile(full, rel, 'game_binary');
          }
        } else if (/\.(?:ttf|otf|ttc)$/i.test(ent.name)) {
          if (!isExcludedFromGameProtection(rel)) {
            recordFile(full, rel, 'game_font');
          }
        }
      }
    }
  };
  walkGameAssets(realCwd, 0);

  return snap;
}

export function diffProtectedWorkspaceSnapshots(
  before: Map<string, ProtectedFileSnapshotEntry>,
  after: Map<string, ProtectedFileSnapshotEntry>
): ProtectedFileMutation[] {
  const mutations: ProtectedFileMutation[] = [];
  for (const [key, b] of before.entries()) {
    const a = after.get(key);
    if (!a) {
      mutations.push({
        rel: b.rel,
        category: b.category,
        change: 'deleted',
        beforeSize: b.size,
      });
    } else if (
      a.size !== b.size ||
      Math.abs(a.mtimeMs - b.mtimeMs) > 0.5 ||
      (b.sampleHash !== undefined && a.sampleHash !== undefined && a.sampleHash !== b.sampleHash)
    ) {
      mutations.push({
        rel: b.rel,
        category: b.category,
        change: 'modified',
        beforeSize: b.size,
        afterSize: a.size,
      });
    }
  }
  for (const [key, a] of after.entries()) {
    if (!before.has(key)) {
      mutations.push({
        rel: a.rel,
        category: a.category,
        change: 'created',
        afterSize: a.size,
      });
    }
  }
  mutations.sort((x, y) => x.rel.localeCompare(y.rel));
  return mutations;
}

/**
 * Guard for `write` / `edit` tools against modifying `results/*.jsonl`, detected game archives,
 * game directory `*.exe` / `*.dll`, or original game fonts (`*.ttf` / `*.otf` / `*.ttc`).
 */
export function detectBlockedProtectedFilePath(
  rawPath: string,
  cwd: string,
  toolLabel: 'write' | 'edit',
  homeDir?: string | null
): string | null {
  const rel = resolveWorkspaceRelPosix(rawPath, cwd);
  if (!rel) return null;
  if (isProtectedResultsJsonlRel(rel)) {
    return protectedResultsBlockMessage(rawPath, toolLabel);
  }
  if (isProtectedGameBinaryRel(rel) || isProtectedGameFontRel(rel)) {
    return protectedGameFileBlockMessage(rawPath, toolLabel);
  }
  if (!isExcludedFromGameProtection(rel)) {
    try {
      const realCwd = realpathSafe(cwd);
      const resolvedHome = homeDir === undefined ? resolveHomeDir() : homeDir;
      const scan = scanWorkspace(realCwd, resolvedHome);
      const targetKey = normRelKey(rel);
      const hit = scan.hits.find((h) => normRelKey(h.path) === targetKey);
      if (hit) {
        return protectedGameFileBlockMessage(rawPath, toolLabel);
      }
    } catch {
      // ignore scan errors
    }
  }
  return null;
}

/**
 * Heuristic pre-execution guard for `bash` commands targeting `results/*.jsonl`,
 * detected game archives, game directory `*.exe` / `*.dll`, or game fonts `*.ttf` / `*.otf` / `*.ttc`
 * (including directory copy targets, glob wildcards, and deleting/moving ancestor directories).
 */
export function detectBlockedProtectedBashCommand(
  command: string,
  cwd: string,
  snapshot: Map<string, ProtectedFileSnapshotEntry>
): string | null {
  if (!command || typeof command !== 'string' || !cwd) return null;
  const targets = extractBashWriteTargets(command, cwd);
  if (!targets.length) return null;

  const checkRelCandidate = (relPosix: string, rawDisplay: string): string | null => {
    if (!relPosix) return null;
    if (isProtectedResultsJsonlRel(relPosix)) {
      return protectedResultsBlockMessage(rawDisplay, 'bash');
    }
    if (isProtectedGameBinaryRel(relPosix) || isProtectedGameFontRel(relPosix)) {
      return protectedGameFileBlockMessage(rawDisplay, 'bash');
    }
    const exact = snapshot.get(normRelKey(relPosix));
    if (exact) {
      return exact.category === 'results'
        ? protectedResultsBlockMessage(rawDisplay, 'bash')
        : protectedGameFileBlockMessage(rawDisplay, 'bash');
    }
    if (relPosix.includes('*') || relPosix.includes('?') || /\[[^\]]+\]/.test(relPosix)) {
      const resultsPrefix = `${WORKSPACE_RESULTS_REL}/`;
      if (
        relPosix.toLowerCase().startsWith(resultsPrefix) &&
        /(?:\.jsonl|\*|\[[^\]]+\])/i.test(relPosix.slice(resultsPrefix.length))
      ) {
        return protectedResultsBlockMessage(rawDisplay, 'bash');
      }
      if (!isExcludedFromGameProtection(relPosix) && /\.(?:exe|dll|ttf|otf|ttc)$/i.test(relPosix)) {
        return protectedGameFileBlockMessage(rawDisplay, 'bash');
      }
      const re = globToRegExp(relPosix);
      for (const entry of snapshot.values()) {
        if (re.test(entry.rel)) {
          return entry.category === 'results'
            ? protectedResultsBlockMessage(rawDisplay, 'bash')
            : protectedGameFileBlockMessage(rawDisplay, 'bash');
        }
      }
    }
    return null;
  };

  for (const target of targets) {
    const rel = resolveWorkspaceRelPosix(target.resolved, cwd);
    if (rel === null) continue;

    // 1. Direct file / wildcard match
    const directErr = checkRelCandidate(rel, target.raw);
    if (directErr) return directErr;

    // 2. Deleting or moving the `results/` dir or any ancestor directory containing protected files
    if (target.kind === 'delete_or_move') {
      if (isResultsDirRel(rel)) {
        return protectedResultsBlockMessage(target.raw, 'bash');
      }
      const prefix = rel ? `${normRelKey(rel)}/` : '';
      for (const [key, entry] of snapshot.entries()) {
        if (!prefix || key.startsWith(prefix)) {
          return entry.category === 'results'
            ? protectedResultsBlockMessage(target.raw, 'bash')
            : protectedGameFileBlockMessage(target.raw, 'bash');
        }
      }
    }

    // 3. Expanding copy/move source basenames into destination directory (e.g. `cp shadow.jsonl results/` or `cp bak/data.pac gyakumajyo_try/`)
    if (target.sourceBasenames && target.sourceBasenames.length > 0) {
      const destEndsSlash = /[\\/]$/.test(target.expanded);
      let destIsDir = destEndsSlash || isResultsDirRel(rel);
      if (!destIsDir) {
        try {
          destIsDir = fs.existsSync(target.resolved) && fs.statSync(target.resolved).isDirectory();
        } catch {
          destIsDir = false;
        }
      }
      if (destIsDir) {
        for (const base of target.sourceBasenames) {
          const candRel = rel ? `${rel}/${base}` : base;
          const err = checkRelCandidate(candRel, `${target.raw} (${base})`);
          if (err) return err;
        }
      }
    }
  }

  return null;
}

interface ProtectedBackupEntry {
  absPath: string;
  rel: string;
  content: Buffer;
}

interface BashProtectedRunState {
  snapshot: Map<string, ProtectedFileSnapshotEntry>;
  resultsBackups: Map<string, ProtectedBackupEntry>;
  fontBackups: Map<string, ProtectedBackupEntry>;
  clampedTimeout?: {
    rawTimeout: number;
    cappedTimeout: number;
  };
}

function captureCategoryBackups(
  cwd: string,
  snapshot: Map<string, ProtectedFileSnapshotEntry>,
  category: ProtectedFileCategory,
  maxSingleBytes: number,
  maxTotalBytes: number
): Map<string, ProtectedBackupEntry> {
  const backups = new Map<string, ProtectedBackupEntry>();
  const realCwd = realpathSafe(cwd);
  let totalBytes = 0;
  for (const [key, entry] of snapshot.entries()) {
    if (entry.category !== category) continue;
    if (entry.size > maxSingleBytes || totalBytes + entry.size > maxTotalBytes) {
      continue;
    }
    const absPath = path.join(realCwd, entry.rel);
    try {
      if (isSymlinkPath(absPath)) continue;
      const content = fs.readFileSync(absPath);
      backups.set(key, { absPath, rel: entry.rel, content });
      totalBytes += content.length;
    } catch {
      // ignore unreadable file
    }
  }
  return backups;
}

function atomicRestoreBackupFile(backup: ProtectedBackupEntry): boolean {
  try {
    const parentDir = path.dirname(backup.absPath);
    fs.mkdirSync(parentDir, { recursive: true });
    if (isSymlinkPath(parentDir)) return false;
    if (isSymlinkPath(backup.absPath)) {
      fs.unlinkSync(backup.absPath);
    }
    const tmpPath = `${backup.absPath}.papercup-restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, backup.content);
    try {
      fs.renameSync(tmpPath, backup.absPath);
    } catch {
      // Windows fallback if destination is briefly locked
      fs.copyFileSync(tmpPath, backup.absPath);
      fs.rmSync(tmpPath, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

function rollbackMutatedProtectedFiles(
  cwd: string,
  mutations: ProtectedFileMutation[],
  state: BashProtectedRunState
): void {
  const realCwd = realpathSafe(cwd);
  const realResultsRoot = resolveWorkspacePaths(realCwd).resultsDir;
  const normResultsRoot =
    process.platform === 'win32'
      ? `${realResultsRoot.replace(/[\\/]+$/, '').toLowerCase()}\\`
      : `${realResultsRoot.replace(/[\\/]+$/, '')}${path.sep}`;

  for (const m of mutations) {
    if (m.category !== 'results' && m.category !== 'game_font') continue;
    const key = normRelKey(m.rel);
    if (m.change === 'modified' || m.change === 'deleted') {
      const backup =
        m.category === 'results' ? state.resultsBackups.get(key) : state.fontBackups.get(key);
      if (!backup) continue;
      if (atomicRestoreBackupFile(backup)) {
        m.restored = true;
      }
    } else if (m.change === 'created' && m.category === 'results') {
      // Keep `created` auto-cleanup strictly scoped to `results/` so unrelated user files are never deleted.
      try {
        const absPath = path.resolve(realCwd, m.rel);
        const normAbs = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
        if (normAbs.startsWith(normResultsRoot)) {
          fs.rmSync(absPath, { force: true });
          m.restored = true;
        }
      } catch {
        // ignore removal failure
      }
    }
  }
}

function formatProtectedMutationWarning(mutations: ProtectedFileMutation[]): string {
  const lines = mutations.map((m) => {
    const kindLabel =
      m.category === 'results'
        ? '译文汇总'
        : m.category === 'game_archive'
          ? '游戏封包'
          : m.category === 'game_font'
            ? '游戏字体'
            : '游戏二进制';
    if (m.change === 'deleted') {
      const suffix = m.restored ? '；已自动原子回滚还原' : '';
      return `- ${m.rel}（${kindLabel}，已被删除；原大小 ${m.beforeSize ?? 0} B${suffix}）`;
    }
    if (m.change === 'created') {
      const suffix = m.restored ? '；已自动清理' : '';
      return `- ${m.rel}（${kindLabel}，被非法新建；大小 ${m.afterSize ?? 0} B${suffix}）`;
    }
    const suffix = m.restored ? '；已自动原子回滚还原' : '';
    return `- ${m.rel}（${kindLabel}，已被修改；size ${m.beforeSize ?? 0} -> ${m.afterSize ?? 0} B${suffix}）`;
  });
  return [
    '[⚠️ 安全核对告警 / PROTECTED FILE MUTATION DETECTED]',
    '检测到本次 bash 命令绕过写前拦截修改了以下受保护文件（请立即向用户如实报告并停止继续直接改写）：',
    ...lines,
    '---',
  ].join('\n');
}

const MAIN_AGENT_SCRIPT_EXT_RE = /\.(?:py|js|mjs|cjs|ts|ps1)$/i;
const MAIN_AGENT_RE_DISASM_CMDS = new Set([
  'objdump',
  'strings',
  'dumpbin',
  'readelf',
  'nm',
  'r2',
  'radare2',
  'rabin2',
]);

function mainAgentReverseBlockMessage(reason: string): string {
  return `Security guard: 主 Agent 禁止直接编写或运行逆向工程 / PE 二进制分析 / 字库解析修补脚本（${reason}）。请立即改用 delegate_task(role="reverser", ...) 委派给 reverser 子代理执行。`;
}

function detectReverseOrFontScriptReason(content: string): string | null {
  if (!content || typeof content !== 'string') return null;
  const cleaned = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:#|\/\/|REM(?:\s|$))/i.test(line))
    .join('\n');
  if (!cleaned.trim()) return null;

  if (/\b(?:fontTools|TTFont|TTCollection|pefile|capstone|keystone)\b/i.test(cleaned)) {
    return '引用了 fontTools / TTFont / TTCollection / pefile / capstone / keystone';
  }

  if (/\b(?:xAvgCharWidth|ulCodePageRange1|ulCodePageRange2|unitsPerEm|SHIFTJIS_CHARSET|GB2312_CHARSET)\b/.test(cleaned)) {
    return '操作 SFNT 字体度量或字符集常量';
  }

  if (
    /['"](?:hmtx|OS\/2)['"]/.test(cleaned) ||
    (/['"](?:cmap|glyf|loca|hhea|maxp|post)['"]/.test(cleaned) &&
      /\b(?:struct|unpack|pack|read_bytes|write_bytes|readUInt|writeUInt|readInt|writeInt|Buffer|DataView|bytearray|font|glyph|sfnt|ttf|otf|ttc|table|offset)\b/i.test(
        cleaned
      ))
  ) {
    return '解析或修改字体 SFNT 表（hmtx/cmap/OS/2 等）';
  }

  if (
    /\.(?:ttf|otf|ttc)\b/i.test(cleaned) &&
    /(?:\bopen\s*\([^)]*['"][rwb+]*b|\b(?:read_bytes|write_bytes|readFileSync|writeFileSync|readFile|writeFile|struct\.|Buffer\.|DataView|bytearray|cmap|hmtx|OS\/2|glyph|patch|sfnt)\b)/i.test(
      cleaned
    )
  ) {
    return '直接二进制读写或修补字体文件 (.ttf/.otf/.ttc)';
  }

  if (/\b(?:IMAGE_DOS_HEADER|IMAGE_NT_HEADERS|IMAGE_SECTION_HEADER|IMAGE_IMPORT_DESCRIPTOR)\b/.test(cleaned)) {
    return '解析 PE 二进制结构';
  }

  if (
    /\.(?:exe|dll)\b/i.test(cleaned) &&
    /(?:\bopen\s*\([^)]*['"][rwb+]*b|\b(?:read_bytes|write_bytes|readFileSync|writeFileSync|readFile|writeFile|struct\.|Buffer\.|DataView|bytearray|mmap|disasm|xref|rva|iat|SHIFTJIS|cp932|0x80)\b|b['"](?:MZ|PE\\x00))/i.test(
      cleaned
    )
  ) {
    return '直接解析或修改 .exe/.dll 二进制文件';
  }

  if (
    /\bSHIFT_?JIS\b/i.test(cleaned) &&
    /\b(?:0x80|charset|hmtx|cmap|OS\/2|exe|dll|ttf|otf|ttc|struct\.|xor|bytearray|patch)\b/i.test(cleaned)
  ) {
    return '在二进制/字库脚本中处理 SHIFTJIS 字符集或编码修补';
  }

  const hasBinaryIoOrCodec =
    /(?:\bopen\s*\([^)]*['"][rwb+]*b|\b(?:read_bytes|write_bytes|bytearray|zlib\.decompress|zlib\.compress|lzma\.|zstd|lzss|xor|unpack|repack|magic|header|toc|entry|offset)\b|\^\s*0x[0-9a-fA-F]+)/i.test(
      cleaned
    );
  if (
    /(?:\bstruct\.(?:unpack|pack|unpack_from|pack_into)|\bint\.from_bytes\b|\bDataView\b|\b(?:read|write)U?Int(?:16|32)\b)/.test(
      cleaned
    ) &&
    hasBinaryIoOrCodec
  ) {
    return '编写二进制结构体解析 / 解包 / 回封脚本';
  }

  if (
    /(?:\^\s*0x[0-9a-fA-F]+|\bxor\b)/i.test(cleaned) &&
    /(?:\bopen\s*\([^)]*['"][rwb+]*b|\b(?:read_bytes|write_bytes|bytearray|readFileSync|writeFileSync|Buffer\.from|unpack|repack|decrypt|encrypt)\b)/i.test(
      cleaned
    )
  ) {
    return '编写二进制 XOR 解密/解包脚本';
  }

  if (
    /\b(?:zlib\.decompress|lzma\.decompress|zstandard|zstd|lzss|def\s+(?:unpack|repack)|function\s+(?:unpack|repack))\b/i.test(
      cleaned
    ) &&
    /(?:\bopen\s*\([^)]*['"][rwb+]*b|\b(?:read_bytes|write_bytes|bytearray|struct\.|Buffer\.|seek\s*\(|offset|magic|toc|archive)\b)/i.test(
      cleaned
    )
  ) {
    return '编写二进制解压 / 解包 / 回封脚本';
  }

  return null;
}

function readExistingWorkspaceScriptForEditCheck(rawPath: string, cwd: string): string | null {
  if (!rawPath || !cwd || !isPathInsideWorkspace(rawPath, cwd) || isRestrictedSecretPath(rawPath, cwd)) {
    return null;
  }
  const expanded = expandHomeVariables(rawPath.trim());
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
  try {
    if (isSymlinkPath(resolved)) return null;
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_MAIN_AGENT_SCRIPT_INSPECT_BYTES) {
      return null;
    }
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Main-agent role guardrail blocking direct authoring or execution of reverse-engineering,
 * PE binary parsing/disassembly, or font-patching scripts (must be delegated to `reverser`).
 */
export function detectBlockedMainAgentReverseOrFontAction(
  toolName: 'write' | 'edit' | 'bash',
  params: { path?: string; content?: string; newText?: string; command?: string },
  cwd: string
): string | null {
  if (toolName === 'write' || toolName === 'edit') {
    const filePath = String(params?.path ?? '').trim();
    if (!filePath || !MAIN_AGENT_SCRIPT_EXT_RE.test(filePath)) {
      return null;
    }
    const text = toolName === 'write' ? String(params?.content ?? '') : String(params?.newText ?? '');
    const hit = detectReverseOrFontScriptReason(text);
    if (hit) {
      return mainAgentReverseBlockMessage(hit);
    }
    if (toolName === 'edit') {
      const existing = readExistingWorkspaceScriptForEditCheck(filePath, cwd);
      if (existing) {
        const existingHit = detectReverseOrFontScriptReason(existing);
        if (existingHit) {
          return mainAgentReverseBlockMessage(existingHit);
        }
      }
    }
    return null;
  }

  if (toolName === 'bash') {
    const command = String(params?.command ?? '');
    if (!command.trim()) return null;

    return visitShellCommandSegments(command, cwd, ({ cmdName, args, expandedArgs, inlineCode, scriptContent }) => {
      if (cmdName === 'fonttools' || cmdName === 'ttx') {
        return mainAgentReverseBlockMessage(`调用字体工具 ${cmdName}`);
      }

      if (cmdName === 'python' || cmdName === 'python3' || cmdName === 'py') {
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-c' || a.startsWith('-c')) break;
          if (a === '-m' && i + 1 < args.length) {
            const mod = args[i + 1].toLowerCase();
            if (/^(?:fonttools|pefile|capstone|keystone)(?:\.|$)/.test(mod)) {
              return mainAgentReverseBlockMessage(`通过 ${cmdName} -m ${args[i + 1]} 调用逆向/字库模块`);
            }
            break;
          }
          if (a.startsWith('-m')) {
            const mod = a.slice(2).toLowerCase();
            if (/^(?:fonttools|pefile|capstone|keystone)(?:\.|$)/.test(mod)) {
              return mainAgentReverseBlockMessage(`通过 ${cmdName} ${a} 调用逆向/字库模块`);
            }
            break;
          }
        }
      }

      if (MAIN_AGENT_RE_DISASM_CMDS.has(cmdName) && expandedArgs.some((a) => /\.(?:exe|dll)$/i.test(a))) {
        return mainAgentReverseBlockMessage(`对 .exe/.dll 执行 ${cmdName}`);
      }

      if (inlineCode) {
        const inlineHit = detectReverseOrFontScriptReason(inlineCode);
        if (inlineHit) return mainAgentReverseBlockMessage(inlineHit);
      }

      if (scriptContent) {
        const fileHit = detectReverseOrFontScriptReason(scriptContent);
        if (fileHit) return mainAgentReverseBlockMessage(fileHit);
      }

      return null;
    });
  }

  return null;
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function parseNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function parseBooleanFlag(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  return undefined;
}

/**
 * Reads `[vn.research]` tuning thresholds from `<cwd>/papercup.toml` with env fallbacks.
 */
export function readVnResearchConfig(cwd?: string): VnResearchConfig {
  let maxToolOutputChars = DEFAULT_MAX_INLINE_OUTPUT_CHARS;
  let maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES;
  let hardStopConsecutiveFailures = DEFAULT_HARD_STOP_CONSECUTIVE_FAILURES;
  let maxReverserToolCalls = DEFAULT_MAX_REVERSER_TOOL_CALLS;
  let maxReverserDurationMs = DEFAULT_MAX_REVERSER_DURATION_MS;
  let maxReverserStallCalls = DEFAULT_MAX_REVERSER_STALL_CALLS;
  let maxReverserNoDeliverableCompactions = DEFAULT_MAX_REVERSER_NO_DELIVERABLE_COMPACTIONS;
  let maxReverserTokens = DEFAULT_MAX_REVERSER_TOKENS;
  let allowReLookup = DEFAULT_ALLOW_RE_LOOKUP;
  let reverserBashTimeoutSec = DEFAULT_REVERSER_BASH_TIMEOUT_SEC;
  let mainBashTimeoutSec = DEFAULT_MAIN_BASH_TIMEOUT_SEC;

  if (cwd) {
    const tbl = readWorkspaceTomlSection(cwd, 'vn.research');
    if (tbl) {
      const pick = (key: string): number | undefined => parsePositiveInt(tbl[key]);
      const vOutput = pick('max_tool_output_chars');
      if (vOutput !== undefined) maxToolOutputChars = vOutput;
      const vFailures = pick('max_consecutive_failures');
      if (vFailures !== undefined) maxConsecutiveFailures = vFailures;
      const vHardStop = parseNonNegativeInt(tbl['hard_stop_consecutive_failures']);
      if (vHardStop !== undefined) hardStopConsecutiveFailures = vHardStop;
      const vMaxCalls = parseNonNegativeInt(tbl['max_reverser_tool_calls']);
      if (vMaxCalls !== undefined) maxReverserToolCalls = vMaxCalls;
      const vMaxDur = parseNonNegativeInt(tbl['max_reverser_duration_ms']);
      if (vMaxDur !== undefined) maxReverserDurationMs = vMaxDur;
      const vMaxStall = parseNonNegativeInt(tbl['max_reverser_stall_calls']);
      if (vMaxStall !== undefined) maxReverserStallCalls = vMaxStall;
      const vMaxNoDelivCompact = parseNonNegativeInt(tbl['max_reverser_no_deliverable_compactions']);
      if (vMaxNoDelivCompact !== undefined) {
        maxReverserNoDeliverableCompactions = vMaxNoDelivCompact;
      }
      const vMaxTokens = parseNonNegativeInt(tbl['max_reverser_tokens']);
      if (vMaxTokens !== undefined) maxReverserTokens = vMaxTokens;
      const vAllowLookup = parseBooleanFlag(tbl['allow_re_lookup']);
      if (vAllowLookup !== undefined) allowReLookup = vAllowLookup;
      const vBashTimeout = pick('reverser_bash_timeout_sec');
      if (vBashTimeout !== undefined) reverserBashTimeoutSec = vBashTimeout;
      const vMainBashTimeout = pick('main_bash_timeout_sec');
      if (vMainBashTimeout !== undefined) mainBashTimeoutSec = vMainBashTimeout;
    }
  }

  const envOutput = parsePositiveInt(process.env.PAPERCUP_MAX_TOOL_OUTPUT_CHARS);
  if (envOutput !== undefined) maxToolOutputChars = envOutput;
  const envFailures = parsePositiveInt(process.env.PAPERCUP_MAX_CONSECUTIVE_FAILURES);
  if (envFailures !== undefined) maxConsecutiveFailures = envFailures;
  const envHardStop = parseNonNegativeInt(process.env.PAPERCUP_REVERSER_HARD_STOP_FAILURES);
  if (envHardStop !== undefined) hardStopConsecutiveFailures = envHardStop;
  const envMaxCalls = parseNonNegativeInt(process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS);
  if (envMaxCalls !== undefined) maxReverserToolCalls = envMaxCalls;
  const envMaxDur = parseNonNegativeInt(process.env.PAPERCUP_REVERSER_MAX_DURATION_MS);
  if (envMaxDur !== undefined) maxReverserDurationMs = envMaxDur;
  const envMaxStall = parseNonNegativeInt(process.env.PAPERCUP_REVERSER_MAX_STALL_CALLS);
  if (envMaxStall !== undefined) maxReverserStallCalls = envMaxStall;
  const envMaxNoDelivCompact = parseNonNegativeInt(
    process.env.PAPERCUP_REVERSER_MAX_NO_DELIVERABLE_COMPACTIONS
  );
  if (envMaxNoDelivCompact !== undefined) {
    maxReverserNoDeliverableCompactions = envMaxNoDelivCompact;
  }
  const envMaxTokens = parseNonNegativeInt(process.env.PAPERCUP_REVERSER_MAX_TOKENS);
  if (envMaxTokens !== undefined) maxReverserTokens = envMaxTokens;
  const envAllowLookup = parseBooleanFlag(process.env.PAPERCUP_RE_LOOKUP_ENABLED);
  if (envAllowLookup !== undefined) allowReLookup = envAllowLookup;
  const envBashTimeout = parsePositiveInt(process.env.PAPERCUP_REVERSER_BASH_TIMEOUT_SEC);
  if (envBashTimeout !== undefined) reverserBashTimeoutSec = envBashTimeout;
  const envMainBashTimeout = parsePositiveInt(process.env.PAPERCUP_MAIN_BASH_TIMEOUT_SEC);
  if (envMainBashTimeout !== undefined) mainBashTimeoutSec = envMainBashTimeout;

  if (hardStopConsecutiveFailures > 0) {
    hardStopConsecutiveFailures = Math.max(maxConsecutiveFailures, hardStopConsecutiveFailures);
  }

  return {
    maxToolOutputChars,
    maxConsecutiveFailures,
    hardStopConsecutiveFailures,
    maxReverserToolCalls,
    maxReverserDurationMs,
    maxReverserStallCalls,
    maxReverserNoDeliverableCompactions,
    maxReverserTokens,
    allowReLookup,
    reverserBashTimeoutSec,
    mainBashTimeoutSec,
  };
}

function blockedToolResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { blocked: true, reason: message },
    isError: true,
  };
}

function saveLargeToolOutput(cwd: string, toolName: string, fullText: string): string | null {
  try {
    if (!cwd || !fs.existsSync(cwd)) return null;
    const outDir = resolveWorkspacePaths(cwd).toolOutputsDir;
    fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTool = toolName.replace(/[^A-Za-z0-9_-]+/g, '_') || 'tool';
    const shortId = crypto.randomBytes(3).toString('hex');
    const fileName = `${ts}-${safeTool}-${shortId}.log`;
    fs.writeFileSync(path.join(outDir, fileName), fullText, 'utf8');
    return `${WORKSPACE_TOOL_OUTPUTS_REL}/${fileName}`;
  } catch {
    return null;
  }
}

function buildTruncatedOutputSummary(
  fullText: string,
  maxInlineChars: number,
  savedRelPath: string | null
): { summary: string; totalChars: number; totalLines: number } {
  const totalChars = fullText.length;
  const totalLines = fullText ? fullText.split(/\r?\n/).length : 0;
  const headLimit = Math.min(6000, Math.max(200, Math.floor(maxInlineChars * 0.5)));
  const tailLimit = Math.min(4000, Math.max(150, Math.floor(maxInlineChars * 0.3)));
  const locationNote = savedRelPath
    ? `full redacted log saved to ${savedRelPath}`
    : 'diagnostics file unavailable';

  if (totalChars <= headLimit + tailLimit + 200) {
    const clipped = fullText.slice(0, Math.max(200, maxInlineChars - 240));
    const summary = `[Output truncated (${totalChars} chars, ${totalLines} lines > ${maxInlineChars} chars); ${locationNote}]\n\n${clipped}`;
    return { summary, totalChars, totalLines };
  }

  const head = fullText.slice(0, headLimit);
  const tail = fullText.slice(-tailLimit);
  const omitted = totalChars - headLimit - tailLimit;
  const summary = [
    `[Output exceeded inline limit (${totalChars} chars, ${totalLines} lines > ${maxInlineChars} chars); ${locationNote}]`,
    '',
    `--- HEAD (${head.length} chars) ---`,
    head,
    '',
    `--- OMITTED ${omitted} chars (${locationNote}) ---`,
    '',
    `--- TAIL (${tail.length} chars) ---`,
    tail,
  ].join('\n');

  return { summary, totalChars, totalLines };
}

function spillOversizedToolResult(
  cwd: string,
  toolName: string,
  res: any,
  maxInlineChars: number
): any {
  if (!res || typeof res !== 'object') return res;
  const content: any[] = Array.isArray(res.content) ? res.content : [];
  const textParts = content.filter((part) => part && part.type === 'text' && typeof part.text === 'string');
  const joinedText = textParts.map((part) => part.text).join('\n');
  const structuredOut =
    res.structuredContent && typeof res.structuredContent.output === 'string'
      ? res.structuredContent.output
      : '';
  const candidateFullText = structuredOut.length > joinedText.length ? structuredOut : joinedText;

  if (candidateFullText.length <= maxInlineChars) {
    return res;
  }

  const savedRelPath = saveLargeToolOutput(cwd, toolName, candidateFullText);
  const { summary, totalChars, totalLines } = buildTruncatedOutputSummary(
    candidateFullText,
    maxInlineChars,
    savedRelPath
  );
  const nonTextParts = content.filter((part) => !part || part.type !== 'text');
  const baseDetails = res.details && typeof res.details === 'object' ? res.details : {};

  return {
    ...res,
    content: [{ type: 'text' as const, text: summary }, ...nonTextParts],
    ...(res.structuredContent && typeof res.structuredContent === 'object'
      ? {
          structuredContent: {
            ...res.structuredContent,
            output: summary,
            truncated: true,
            ...(savedRelPath ? { full_output_path: savedRelPath } : {}),
          },
        }
      : {}),
    details: {
      ...baseDetails,
      truncated: true,
      totalChars,
      totalLines,
      ...(savedRelPath ? { savedOutputPath: savedRelPath } : {}),
    },
  };
}

function prependProtectedMutationWarning(res: any, mutations: ProtectedFileMutation[]): any {
  if (!mutations.length) return res;
  const warningText = formatProtectedMutationWarning(mutations);
  if (!res || typeof res !== 'object') {
    return res;
  }
  const content: any[] = Array.isArray(res.content) ? res.content : [];
  const nextContent =
    content.length > 0 && content[0]?.type === 'text' && typeof content[0].text === 'string'
      ? [{ ...content[0], text: `${warningText}\n${content[0].text}` }, ...content.slice(1)]
      : [{ type: 'text' as const, text: warningText }, ...content];
  const baseDetails = res.details && typeof res.details === 'object' ? res.details : {};
  return {
    ...res,
    isError: true,
    content: nextContent,
    ...(res.structuredContent && typeof res.structuredContent === 'object'
      ? {
          structuredContent: {
            ...res.structuredContent,
            ...(typeof res.structuredContent.output === 'string'
              ? { output: `${warningText}\n${res.structuredContent.output}` }
              : {}),
            protected_file_mutations: mutations,
          },
        }
      : {}),
    details: {
      ...baseDetails,
      protectedFileMutations: mutations,
    },
  };
}

function wrapToolWithGuard(
  cwd: string,
  def: ToolDefinition<any, any>,
  guardFn: ((params: any) => string | null) | null,
  getKnownSecrets?: () => Iterable<string>,
  explicitMaxInlineChars?: number,
  beforeExecute?: (params: any) => any,
  lifecycle?: {
    beforeRun?: (params: any) => { blockedReason?: string; state?: unknown };
    afterRun?: (res: any, state: unknown) => any;
    onThrow?: (errMsg: string, state: unknown) => string;
  }
): ToolDefinition<any, any> {
  return {
    ...def,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (guardFn) {
        const reason = guardFn(params);
        if (reason) {
          return blockedToolResult(reason);
        }
      }
      let runState: unknown;
      if (lifecycle?.beforeRun) {
        const pre = lifecycle.beforeRun(params);
        if (pre?.blockedReason) {
          return blockedToolResult(pre.blockedReason);
        }
        runState = pre?.state;
      }
      const effectiveParams = beforeExecute ? beforeExecute(params) : params;
      let rawRes: any;
      try {
        rawRes = await def.execute(toolCallId, effectiveParams, signal, onUpdate, ctx);
      } catch (err: any) {
        let safeMsg = redactSecrets(String(err?.message || err), getKnownSecrets?.());
        if (lifecycle?.onThrow) {
          safeMsg = lifecycle.onThrow(safeMsg, runState);
        }
        throw new Error(safeMsg);
      }
      const redacted = redactUnknownValue(rawRes, getKnownSecrets?.());
      const maxInlineChars =
        parsePositiveInt(explicitMaxInlineChars) ?? readVnResearchConfig(cwd).maxToolOutputChars;
      const spilled = spillOversizedToolResult(cwd, def.name, redacted, maxInlineChars);
      return lifecycle?.afterRun ? lifecycle.afterRun(spilled, runState) : spilled;
    },
  };
}

function normalizeComparePath(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isResolvedPathInsideDir(targetAbs: string, dirAbs: string): boolean {
  const normTarget = normalizeComparePath(targetAbs);
  const normDir = normalizeComparePath(dirAbs);
  const sep = process.platform === 'win32' ? '\\' : path.sep;
  return normTarget === normDir || normTarget.startsWith(`${normDir}${sep}`);
}

/**
 * Resolve `rawPath` (including symlinks/junctions) and check whether it stays inside any
 * explicit `skillReadRoots` directory.
 */
export function isPathInsideSkillReadRoots(
  rawPath: string,
  cwd: string,
  skillReadRoots?: readonly string[]
): boolean {
  if (!skillReadRoots || skillReadRoots.length === 0) return false;
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return false;
  const expanded = expandHomeVariables(trimmed);
  if (!expanded) return false;

  let candidate = expanded;
  if (process.platform === 'win32') {
    const msys = candidate.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
    if (msys) {
      candidate = `${msys[1].toUpperCase()}:/${msys[2] ?? ''}`;
    }
  }
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);

  let existing = resolved;
  const tail: string[] = [];
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  try {
    const st = fs.lstatSync(existing);
    if (st.isSymbolicLink() && !fs.existsSync(existing)) {
      const linkTarget = fs.readlinkSync(existing);
      const absTarget = path.isAbsolute(linkTarget)
        ? path.resolve(linkTarget)
        : path.resolve(path.dirname(existing), linkTarget);
      existing = absTarget;
    }
  } catch {
    // ignore
  }
  const realTarget = path.join(realpathSafe(existing), ...tail);

  for (const root of skillReadRoots) {
    const cleanRoot = String(root ?? '').trim();
    if (!cleanRoot || !fs.existsSync(cleanRoot)) continue;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(cleanRoot);
      if (!fs.statSync(realRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isResolvedPathInsideDir(realTarget, realRoot)) {
      return true;
    }
  }
  return false;
}

export function resolveSkillReadFallbackPath(
  rawPath: string,
  cwd: string,
  skillReadRoots?: readonly string[]
): string | null {
  if (!skillReadRoots || skillReadRoots.length === 0) return null;
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return null;

  const directResolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
  if (fs.existsSync(directResolved)) {
    return null;
  }

  const normalized = trimmed.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!normalized) return null;
  const segments = normalized.split('/').filter((seg) => seg.length > 0);
  if (segments.length === 0) return null;

  for (const root of skillReadRoots) {
    const cleanRoot = String(root ?? '').trim();
    if (!cleanRoot || !fs.existsSync(cleanRoot)) continue;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(cleanRoot);
      if (!fs.statSync(realRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    const rootBaseLow = path.basename(realRoot).toLowerCase();

    let suffixSegs: string[] | null = null;
    let lastMatchIdx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].toLowerCase() === rootBaseLow) {
        lastMatchIdx = i;
      }
    }
    if (lastMatchIdx >= 0 && lastMatchIdx < segments.length - 1) {
      suffixSegs = segments.slice(lastMatchIdx + 1);
    } else if (!segments.includes('..')) {
      const firstLow = segments[0].toLowerCase();
      if ((segments.length === 1 && firstLow === 'skill.md') || firstLow === 'references') {
        suffixSegs = segments;
      }
    }

    if (!suffixSegs || suffixSegs.length === 0) continue;
    if (suffixSegs.some((seg) => seg === '..' || seg === '.' || seg.includes(':'))) continue;

    const candidate = path.resolve(realRoot, ...suffixSegs);
    if (!fs.existsSync(candidate)) continue;
    let realCandidate: string;
    try {
      realCandidate = fs.realpathSync(candidate);
      if (!fs.statSync(realCandidate).isFile()) continue;
    } catch {
      continue;
    }

    const relFromRoot = path.relative(realRoot, realCandidate);
    if (!relFromRoot || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      continue;
    }
    if (isRestrictedSecretPath(realCandidate, cwd)) {
      continue;
    }
    return realCandidate;
  }

  return null;
}

export function createGuardedBuiltinToolDefinitions(
  cwd: string,
  toolNames: readonly string[],
  options?: GuardedBuiltinToolsOptions
): ToolDefinition<any, any>[] {
  const getKnownSecrets = options?.getKnownSecrets;
  const maxInline = options?.maxInlineOutputChars;
  const maxBashTimeoutSec = parsePositiveInt(options?.maxBashTimeoutSec);
  const rawDefaultBashTimeoutSec = parsePositiveInt(options?.defaultBashTimeoutSec);
  const defaultBashTimeoutSec =
    rawDefaultBashTimeoutSec !== undefined
      ? maxBashTimeoutSec !== undefined
        ? Math.min(rawDefaultBashTimeoutSec, maxBashTimeoutSec)
        : rawDefaultBashTimeoutSec
      : maxBashTimeoutSec;
  const homeDir = options?.homeDir;
  const skillReadRoots = options?.skillReadRoots;
  const agentRole = options?.agentRole ?? 'subagent';
  const defs: ToolDefinition<any, any>[] = [];

  for (const name of toolNames) {
    if (name === 'read') {
      const def = createReadToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) => {
            const p = String(params?.path ?? '');
            if (isRestrictedSecretPath(p, cwd)) {
              return `Security guard: reading credential/secret file "${params?.path}" is prohibited.`;
            }
            if (!isPathInsideWorkspace(p, cwd) && !isPathInsideSkillReadRoots(p, cwd, skillReadRoots)) {
              const fallback = resolveSkillReadFallbackPath(p, cwd, skillReadRoots);
              if (!fallback) {
                return `Security guard: reading path "${params?.path}" outside active workspace is prohibited. Use workspace-relative paths or active skill directories.`;
              }
            }
            return null;
          },
          getKnownSecrets,
          maxInline,
          (params) => {
            const rawPath = String(params?.path ?? '');
            const fallback = resolveSkillReadFallbackPath(rawPath, cwd, skillReadRoots);
            return fallback ? { ...params, path: fallback } : params;
          }
        )
      );
    } else if (name === 'edit') {
      const def = createEditToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) => {
            const p = String(params?.path ?? '');
            if (isRestrictedSecretPath(p, cwd)) {
              return `Security guard: editing credential/secret file "${p}" is prohibited.`;
            }
            if (!isPathInsideWorkspace(p, cwd)) {
              return `Security guard: editing path "${p}" outside active workspace is prohibited. Use workspace-relative paths.`;
            }
            const protectedReason = detectBlockedProtectedFilePath(p, cwd, 'edit', homeDir);
            if (protectedReason) return protectedReason;
            if (agentRole === 'main') {
              const editFragments: string[] = [];
              if (typeof params?.newText === 'string') editFragments.push(params.newText);
              if (Array.isArray(params?.edits)) {
                for (const item of params.edits) {
                  if (typeof item?.newText === 'string') editFragments.push(item.newText);
                }
              }
              const roleReason = detectBlockedMainAgentReverseOrFontAction(
                'edit',
                { path: p, newText: editFragments.join('\n') },
                cwd
              );
              if (roleReason) return roleReason;
            }
            return null;
          },
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'write') {
      const def = createWriteToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) => {
            const p = String(params?.path ?? '');
            if (isRestrictedSecretPath(p, cwd)) {
              return `Security guard: writing credential/secret file "${p}" is prohibited.`;
            }
            if (!isPathInsideWorkspace(p, cwd)) {
              return `Security guard: writing path "${p}" outside active workspace is prohibited. Use workspace-relative paths.`;
            }
            const protectedReason = detectBlockedProtectedFilePath(p, cwd, 'write', homeDir);
            if (protectedReason) return protectedReason;
            if (agentRole === 'main') {
              const roleReason = detectBlockedMainAgentReverseOrFontAction(
                'write',
                { path: p, content: typeof params?.content === 'string' ? params.content : undefined },
                cwd
              );
              if (roleReason) return roleReason;
            }
            return null;
          },
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'bash') {
      const def = createBashToolDefinition(cwd, {
        ...(options?.bashPath ? { shellPath: options.bashPath } : {}),
        exposeSessionEnvironment: false,
      });
      const resolveBashTimeout = (
        params: unknown
      ): { effectiveTimeout?: number; clampedTimeout?: { rawTimeout: number; cappedTimeout: number } } => {
        const rawTimeout =
          params && typeof params === 'object' ? Number((params as Record<string, unknown>).timeout) : Number.NaN;
        if (Number.isFinite(rawTimeout) && rawTimeout > 0) {
          if (maxBashTimeoutSec !== undefined && rawTimeout > maxBashTimeoutSec) {
            return {
              effectiveTimeout: maxBashTimeoutSec,
              clampedTimeout: { rawTimeout, cappedTimeout: maxBashTimeoutSec },
            };
          }
          return { effectiveTimeout: rawTimeout };
        }
        if (defaultBashTimeoutSec !== undefined) {
          return { effectiveTimeout: defaultBashTimeoutSec };
        }
        return {};
      };
      const formatTimeoutClampNotice = (clamped: { rawTimeout: number; cappedTimeout: number }): string =>
        `（显式超时 ${clamped.rawTimeout}s 已按安全上限裁剪为 ${clamped.cappedTimeout}s）`;
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) => {
            const cmd = String(params?.command ?? '');
            const secretReason = detectBlockedSecretCommand(cmd, cwd);
            if (secretReason) return `Security guard: ${secretReason}`;
            const hostReason = detectBlockedHostMutationCommand(cmd, cwd);
            if (hostReason) return `Security guard: ${hostReason}`;
            const hostSearchReason = detectBlockedHostSearchCommand(cmd, cwd);
            if (hostSearchReason) return `Security guard: ${hostSearchReason}`;
            const heredocReason = detectBlockedBashHeredocCommand(cmd);
            if (heredocReason) return `Security guard: ${heredocReason}`;
            const procReason = detectBlockedProcessControlCommand(cmd, cwd);
            if (procReason) return `Security guard: ${procReason}`;
            const extWriteReason = detectBlockedExternalWriteCommand(cmd, cwd);
            if (extWriteReason) return `Security guard: ${extWriteReason}`;
            if (agentRole === 'main') {
              const roleReason = detectBlockedMainAgentReverseOrFontAction('bash', { command: cmd }, cwd);
              if (roleReason) return roleReason;
            }
            return null;
          },
          getKnownSecrets,
          maxInline,
          defaultBashTimeoutSec !== undefined || maxBashTimeoutSec !== undefined
            ? (params) => {
                const { effectiveTimeout } = resolveBashTimeout(params);
                if (effectiveTimeout === undefined) return params;
                if (!params || typeof params !== 'object') return { timeout: effectiveTimeout };
                return { ...(params as Record<string, unknown>), timeout: effectiveTimeout };
              }
            : undefined,
          {
            beforeRun: (params) => {
              const cmd = String(params?.command ?? '');
              const beforeSnap = collectProtectedWorkspaceSnapshot(cwd, homeDir);
              const blockedReason = detectBlockedProtectedBashCommand(cmd, cwd, beforeSnap);
              if (blockedReason) return { blockedReason };
              const { clampedTimeout } = resolveBashTimeout(params);
              const runState: BashProtectedRunState = {
                snapshot: beforeSnap,
                resultsBackups: captureCategoryBackups(
                  cwd,
                  beforeSnap,
                  'results',
                  MAX_SINGLE_RESULTS_BACKUP_BYTES,
                  MAX_TOTAL_RESULTS_BACKUP_BYTES
                ),
                fontBackups: captureCategoryBackups(
                  cwd,
                  beforeSnap,
                  'game_font',
                  MAX_SINGLE_FONT_BACKUP_BYTES,
                  MAX_TOTAL_FONT_BACKUP_BYTES
                ),
                ...(clampedTimeout ? { clampedTimeout } : {}),
              };
              return { state: runState };
            },
            afterRun: (res, state) => {
              const runState = state as BashProtectedRunState | undefined;
              let nextRes = res;
              if (
                runState?.clampedTimeout &&
                nextRes &&
                typeof nextRes === 'object' &&
                nextRes.isError &&
                Array.isArray(nextRes.content)
              ) {
                const notice = formatTimeoutClampNotice(runState.clampedTimeout);
                nextRes = {
                  ...nextRes,
                  content: nextRes.content.map((item: any) =>
                    item?.type === 'text' &&
                    typeof item.text === 'string' &&
                    /(?:timed?\s*out|timeout)/i.test(item.text) &&
                    !item.text.includes(notice)
                      ? { ...item, text: `${item.text}${notice}` }
                      : item
                  ),
                };
              }
              if (!runState || !(runState.snapshot instanceof Map)) return nextRes;
              const afterSnap = collectProtectedWorkspaceSnapshot(cwd, homeDir);
              const mutations = diffProtectedWorkspaceSnapshots(runState.snapshot, afterSnap);
              if (!mutations.length) return nextRes;
              rollbackMutatedProtectedFiles(cwd, mutations, runState);
              return prependProtectedMutationWarning(nextRes, mutations);
            },
            onThrow: (errMsg, state) => {
              const runState = state as BashProtectedRunState | undefined;
              let outMsg = errMsg;
              if (runState?.clampedTimeout && /(?:timed?\s*out|timeout)/i.test(outMsg)) {
                outMsg = `${outMsg}${formatTimeoutClampNotice(runState.clampedTimeout)}`;
              }
              if (!runState || !(runState.snapshot instanceof Map)) return outMsg;
              const afterSnap = collectProtectedWorkspaceSnapshot(cwd, homeDir);
              const mutations = diffProtectedWorkspaceSnapshots(runState.snapshot, afterSnap);
              if (!mutations.length) return outMsg;
              rollbackMutatedProtectedFiles(cwd, mutations, runState);
              return `${formatProtectedMutationWarning(mutations)}\n${outMsg}`;
            },
          }
        )
      );
    } else if (name === 'ls') {
      const def = createLsToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) => {
            const p = String(params?.path ?? '').trim();
            if (p && isRestrictedSecretPath(p, cwd)) {
              return `Security guard: listing credential directory "${p}" is prohibited.`;
            }
            if (p && !isPathInsideWorkspace(p, cwd)) {
              return `Security guard: listing directory "${p}" outside active workspace is prohibited. Use workspace-relative paths.`;
            }
            return null;
          },
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'find') {
      const def = createFindToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) => {
            const p = String(params?.path ?? '').trim();
            if (p && isRestrictedSecretPath(p, cwd)) {
              return `Security guard: searching credential directory "${p}" is prohibited.`;
            }
            if (p && !isPathInsideWorkspace(p, cwd)) {
              return `Security guard: searching directory "${p}" outside active workspace is prohibited. Use workspace-relative paths.`;
            }
            return null;
          },
          getKnownSecrets,
          maxInline
        )
      );
    }
  }

  return defs;
}
