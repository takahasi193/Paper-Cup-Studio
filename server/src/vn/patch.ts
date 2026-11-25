/**
 * Deterministic lightweight delta patch bundle builder.
 *
 * Replaces full-game directory cloning with compact, re-assemblable patch bundles:
 * - KiriKiri (.xp3): UTF-16LE BOM delta overlay archive (`patch.xp3` / `patch2.xp3`...)
 * - Ren'Py (.rpa): UTF-8 loose script overlay (`files/<dir>/...`)
 * - PE+ZIP (TyranoBuilder / NW / Electron-like): UTF-8 repacked changed archive only
 * - NScripter (.nsa) / legacy CP932 custom skills / direct scripts:
 *   GBK (default for zh*) or explicit encoding + `papercup_patch.ini` hook config (Phase 1)
 * - Always writes `patch_manifest.json`, `sources/<track>.jsonl`, pure-ASCII CRLF
 *   `install_patch.bat` / `uninstall_patch.bat`, and `README.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  NSA_MANIFEST,
  PEZIP_MANIFEST,
  RPA_MANIFEST,
  SKILL_MANIFEST,
  XP3_MANIFEST,
  findUnpackManifests,
  packDeltaXp3,
  repackNsa,
  repackPeZip,
  resolveEngineJson,
  runPythonScript,
  scanWorkspace,
  sha256Hex,
  skillBinding,
  staysInside,
  type ArchiveHit,
} from './archives.js';
import {
  TRACKS,
  TRACK_LABELS,
  applyResults,
  manifestTrackCount,
  readManifest,
  readResultsJsonl,
  type TrackName,
} from './classify.js';
import {
  detectEncoding,
  encodeText,
  insideWorkspace,
  isSymlinkPath,
  loadWorkspacePatchConfig,
  normalizeEncodingName,
  normalizeGbkCompatText,
  normalizeRuntimeCharsetHint,
  realpathSafe,
  resolveWorkspaceControlPattern,
  tryNormalizeBuiltinEncoding,
  type LocalizationProfile,
  type PatchConfig,
  type ProjectMemory,
  type RuntimeCharsetHint,
} from './profile.js';
import { qaReport } from './qa.js';
import { loadPatchedFontManifest, resolvePatchedFontFile } from './fonts.js';
import {
  ExportCopyError,
  copyTreeRecursive,
  isBackupOrNonOriginalArchiveRel,
  resolveReadyDirectSkill,
  resolveReadySkillScript,
  unlinkBaksRecursive,
} from './workflow.js';
import {
  WORKSPACE_LAST_PATCH_REL,
  WORKSPACE_PATCH_GUIDE_REL,
  WORKSPACE_PATCH_REL,
  WORKSPACE_RESULTS_REL,
  WORKSPACE_UNPACKED_REL,
  resolveWorkspacePaths,
} from './workspace-paths.js';
import {
  chooseProxyDllName,
  readPeMachineArch,
  resolvePrebuiltProxyDll,
  type ProxyDllName,
} from './win32-proxy.js';

export { isBackupOrNonOriginalArchiveRel };

export const LAST_PATCH_META_REL = WORKSPACE_LAST_PATCH_REL;

const BACKUP_ARCHIVE_DIR_SEGMENTS = new Set(['backup', 'backups', '.papercup_backup', 'papercup_backup']);

function normArchiveRelKey(rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

function expectedEngineFromManifest(mName: string, mData: Record<string, unknown>): string {
  const eng = typeof mData.engine === 'string' ? mData.engine.trim().toLowerCase() : '';
  if (eng) return eng;
  if (mName === XP3_MANIFEST) return 'kirikiri';
  if (mName === RPA_MANIFEST) return 'renpy';
  if (mName === NSA_MANIFEST) return 'nscripter';
  if (mName === PEZIP_MANIFEST) return 'pe-zip';
  return '';
}

function recommendOriginalArchivePaths(
  relArchive: string,
  expectedEngine: string,
  detectedOriginal: ArchiveHit[]
): string[] {
  if (!detectedOriginal.length) return [];
  const baseLow = path.basename(relArchive).toLowerCase();
  const byName = detectedOriginal
    .filter((h) => path.basename(h.path).toLowerCase() === baseLow)
    .map((h) => h.path);
  if (byName.length) return byName.slice(0, 3);
  if (expectedEngine) {
    const byEngine = detectedOriginal
      .filter((h) => h.engine.toLowerCase() === expectedEngine || h.kind.toLowerCase() === expectedEngine)
      .map((h) => h.path);
    if (byEngine.length) return byEngine.slice(0, 3);
  }
  return detectedOriginal.slice(0, 3).map((h) => h.path);
}

export function validateWritebackSourceArchive(
  ws: string,
  orig: string,
  mName: string,
  mData: Record<string, unknown>,
  detectedOriginal: ArchiveHit[]
): string {
  if (!orig || !orig.trim()) {
    return 'archive.bin';
  }
  const rawRel = path.relative(ws, realpathSafe(orig));
  const expectedEngine = expectedEngineFromManifest(mName, mData);

  if (!rawRel || rawRel.startsWith('..') || path.isAbsolute(rawRel)) {
    const recs = recommendOriginalArchivePaths(path.basename(orig), expectedEngine, detectedOriginal);
    const recHint = recs.length ? `（推荐原始封包：${recs.join('、')}）` : '';
    throw new ExportCopyError(
      `拒绝生成补丁：解包源「${orig}」位于工作区之外，无法确定正确的游戏目录 install_rel。请从 vn_detect 识别的原始封包位置重新执行 vn_unpack${recHint}。`
    );
  }

  const relArchive = toPosix(rawRel);
  if (isBackupOrNonOriginalArchiveRel(relArchive)) {
    const recs = recommendOriginalArchivePaths(relArchive, expectedEngine, detectedOriginal);
    const recHint = recs.length ? `（推荐从以下原始位置重新 vn_unpack：${recs.join('、')}）` : '';
    throw new ExportCopyError(
      `拒绝生成补丁：解包源「${relArchive}」位于备份或非原始游戏位置，直接回包会导致 install_rel 错误指向该路径。请改从 vn_detect 识别的原始封包位置重新执行 vn_unpack${recHint}。`
    );
  }

  if (detectedOriginal.length > 0) {
    const detectedKeys = new Set(detectedOriginal.map((h) => normArchiveRelKey(h.path)));
    if (!detectedKeys.has(normArchiveRelKey(relArchive))) {
      const baseLow = path.basename(relArchive).toLowerCase();
      const hasMatchingOriginal = detectedOriginal.some(
        (h) =>
          path.basename(h.path).toLowerCase() === baseLow ||
          (expectedEngine && (h.engine.toLowerCase() === expectedEngine || h.kind.toLowerCase() === expectedEngine))
      );
      if (hasMatchingOriginal) {
        const recs = recommendOriginalArchivePaths(relArchive, expectedEngine, detectedOriginal);
        const recHint = recs.length ? `（推荐从以下原始位置重新 vn_unpack：${recs.join('、')}）` : '';
        throw new ExportCopyError(
          `拒绝生成补丁：解包源「${relArchive}」不在 vn_detect 识别出的原始封包位置中，继续回包会导致 install_rel 错位。请改从原始封包位置重新执行 vn_unpack${recHint}。`
        );
      }
    }
  }

  return relArchive;
}

export function readLastPatchMeta(workspace: string): {
  manifest_path: string;
  patch_dir: string;
  sha256: string;
  created_at: string;
} | null {
  const ws = realpathSafe(workspace);
  const p = path.join(ws, LAST_PATCH_META_REL);
  if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (typeof data.manifest_path === 'string' && data.manifest_path.trim()) {
      return {
        manifest_path: data.manifest_path,
        patch_dir: String(data.patch_dir || path.dirname(data.manifest_path)),
        sha256: String(data.sha256 || ''),
        created_at: String(data.created_at || ''),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export type PatchStrategy =
  | 'xp3_overlay'
  | 'rpa_loose_overlay'
  | 'archive_replace'
  | 'direct_file_replace';

export interface PatchHookMeta {
  needed: boolean;
  mode: 'none' | 'win32_proxy';
  phase: 'phase1_config_ready' | 'phase2_proxy_bundled';
  proxy_dll?: ProxyDllName;
  proxy_bundled?: boolean;
  codepage?: number;
  charset?: number;
  font_name?: string;
  force_font_name?: boolean;
  enable_width_compat?: boolean;
  config_file?: string;
  target_exe?: string | null;
  target_arch?: 'x86' | 'x64' | 'unknown';
  note?: string;
}

export interface PatchArtifactEntry {
  kind:
    | 'overlay_archive'
    | 'loose_file'
    | 'replace_archive'
    | 'replace_file'
    | 'hook_config'
    | 'hook_proxy'
    | 'font_patch';
  patch_rel: string;
  install_rel: string;
  action: 'add' | 'replace';
  sha256: string;
  bytes: number;
  source_archive?: string;
  changed_files?: number;
}

export interface PatchManifest {
  schema: 1;
  format: 'papercup-delta-patch';
  created_at: string;
  engine: string;
  engine_kind: string;
  strategy: PatchStrategy;
  writeback_mode: 'builtin_apply' | 'skill_apply' | 'direct_skill_apply';
  source_lang: string;
  target_lang: string;
  encoding: {
    source_detected: string;
    target: string;
    override: boolean;
  };
  hook: PatchHookMeta;
  tracks_applied: Record<string, number>;
  changed_files: string[];
  artifacts: PatchArtifactEntry[];
  sources: Record<string, { path: string; sha256: string; bytes: number; segments: number }>;
  install_scripts: {
    windows_install: string;
    windows_uninstall: string;
  };
}

export interface BuildPatchBundleResult {
  patch_dir: string;
  export_dir: string;
  manifest_path: string;
  strategy: PatchStrategy;
  writeback_mode: 'builtin_apply' | 'skill_apply' | 'direct_skill_apply';
  encoding: string;
  source_encoding: string;
  hook_needed: boolean;
  hook: PatchHookMeta;
  tracks_applied: Record<string, number>;
  changed_files: string[];
  artifacts: PatchArtifactEntry[];
  repacked_archives: string[];
  patch_bytes: number;
  install_script: string;
  uninstall_script: string;
  patch_guide_path: string;
}

const MANIFEST_BASENAMES = new Set([
  RPA_MANIFEST,
  XP3_MANIFEST,
  PEZIP_MANIFEST,
  NSA_MANIFEST,
  SKILL_MANIFEST,
]);

const STAGE_EXCLUDE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.papercup',
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
]);

const DIRECT_SKIP_EXTS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.ogg',
  '.wav',
  '.mp3',
  '.flac',
  '.m4a',
  '.mp4',
  '.wmv',
  '.mpg',
  '.mpeg',
  '.avi',
  '.webm',
  '.mkv',
  '.mov',
  '.ald',
  '.alm',
  '.bgi',
  '.wai',
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.tga',
  '.dds',
  '.tlg',
  '.webp',
  '.psd',
]);

const MAX_DIRECT_COMPANION_BYTES = 32 * 1024 * 1024;
const UNINSTALLER_EXE_RE =
  /^(?:unins\d*|uninstall(?:er)?|install(?:$|[_.\-\s\d])|installer|setup|dx(?:web)?setup|vc_?redist|config(?:$|[_.\-\s\d])|crash(?:reporter|handler|sender)|updat(?:er|e(?:$|[_.\-\s\d]))|startup(?:$|[_.\-\s\d])|support[_-]?tools?|autorun)/i;
const LAUNCHER_EXE_RE = /(?:^|[_.\-\s])launcher(?:$|[_.\-\s\d])/i;

export const SHRINK_REPLACE_MIN_ORIGINAL_BYTES = 10 * 1024 * 1024;
export const SHRINK_REPLACE_MIN_RATIO = 0.5;

export interface DestructiveShrinkReplaceCheck {
  action: 'add' | 'replace';
  targetRel: string;
  originalBytes: number;
  replacementBytes: number;
  incrementalOverlay?: boolean;
  contextLabel?: string;
}

/**
 * Pure guard against destructive shrunk archive replacement (`action === 'replace'`).
 * Never blocks `action === 'add'` (e.g. `patch.xp3` incremental overlays).
 */
export function getDestructiveShrinkReplaceReason(input: DestructiveShrinkReplaceCheck): string | null {
  if (input.action !== 'replace') return null;
  if (input.incrementalOverlay) return null;
  if (!Number.isFinite(input.originalBytes) || !Number.isFinite(input.replacementBytes)) return null;
  if (input.originalBytes <= SHRINK_REPLACE_MIN_ORIGINAL_BYTES) return null;
  if (input.replacementBytes >= input.originalBytes * SHRINK_REPLACE_MIN_RATIO) return null;

  const origMiB = (input.originalBytes / (1024 * 1024)).toFixed(2);
  const newMiB = (input.replacementBytes / (1024 * 1024)).toFixed(2);
  const pct = ((input.replacementBytes / input.originalBytes) * 100).toFixed(1);
  const prefix = input.contextLabel ? `${input.contextLabel}：` : '';
  return (
    `${prefix}拦截破坏性缩水替换「${input.targetRel}」（action=replace，原封包 ${origMiB} MiB / ${input.originalBytes} B -> 新封包 ${newMiB} MiB / ${input.replacementBytes} B，仅为原体积 ${pct}% < 50%）。` +
    `体积骤减通常意味着仅部分解包了脚本而丢失原始媒体/CG/语音等资源，直接覆盖会导致缺资源崩溃或黑屏。` +
    `请完整解包原始封包并保留全部媒体资源后再重打包，或改用引擎增量覆盖包（action: "add"，如 patch.xp3 等外挂补丁机制）。`
  );
}

export function assertNoDestructiveShrinkReplace(
  input: DestructiveShrinkReplaceCheck,
  createError: (message: string) => Error = (message) => new ExportCopyError(message)
): void {
  const reason = getDestructiveShrinkReplaceReason(input);
  if (reason) {
    throw createError(reason);
  }
}

function toPosix(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isPureAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7e || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return false;
    }
  }
  return true;
}

export function readPeArchitecture(filePath: string): 'x86' | 'x64' | 'unknown' {
  return readPeMachineArch(filePath);
}

const MAX_EXE_SCAN_DEPTH = 4;

function classifyExePriorityTier(fileName: string): number {
  const stem = fileName.replace(/\.exe$/i, '');
  if (UNINSTALLER_EXE_RE.test(stem)) return 2;
  if (LAUNCHER_EXE_RE.test(stem)) return 1;
  return 0;
}

function computeArchiveProximity(exeDirPosix: string, archiveDirs: string[]): number {
  if (!archiveDirs.length) return 0;
  const eParts = exeDirPosix ? exeDirPosix.split('/').filter(Boolean) : [];
  let best = Number.POSITIVE_INFINITY;
  for (const archDir of archiveDirs) {
    if (exeDirPosix === archDir) return 0;
    const aParts = archDir ? archDir.split('/').filter(Boolean) : [];
    const minLen = Math.min(eParts.length, aParts.length);
    let common = 0;
    while (common < minLen && eParts[common].toLowerCase() === aParts[common].toLowerCase()) {
      common++;
    }
    let dist: number;
    if (common === eParts.length) {
      // Executable sits above the archive directory (e.g. Game.exe at root, data/main.xp3)
      dist = aParts.length - common;
    } else if (common > 0) {
      // Executable and archive share a non-root workspace subdirectory (e.g. game/bin/Game.exe & game/data/main.xp3)
      dist = 1 + (eParts.length - common) + (aParts.length - common);
    } else {
      dist = 99;
    }
    if (dist < best) best = dist;
  }
  return Number.isFinite(best) ? best : 0;
}

export function inspectPrimaryGameExe(
  workspace: string,
  options: { homeDir?: string | null } = {}
): {
  exeRel: string | null;
  arch: 'x86' | 'x64' | 'unknown';
} {
  let archiveDirs: string[] = [];
  try {
    const scan = scanWorkspace(workspace, options.homeDir ?? null);
    const knownPaths = scan.hits
      .filter((h) => !isBackupOrNonOriginalArchiveRel(h.path))
      .map((h) => h.path);
    const sourcePaths =
      knownPaths.length > 0
        ? knownPaths
        : scan.unknown
            .filter((u) => !isBackupOrNonOriginalArchiveRel(u.path) && u.size >= 64 * 1024)
            .map((u) => u.path);
    archiveDirs = Array.from(
      new Set(
        sourcePaths.map((p) => {
          const d = toPosix(path.posix.dirname(toPosix(p)));
          return d === '.' ? '' : d;
        })
      )
    );
  } catch {
    archiveDirs = [];
  }

  const candidates: Array<{
    rel: string;
    full: string;
    size: number;
    depth: number;
    priorityTier: number;
    archiveProximity: number;
  }> = [];
  const collectDir = (dir: string, depth: number) => {
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
        const low = ent.name.toLowerCase();
        if (
          depth < MAX_EXE_SCAN_DEPTH &&
          !ent.name.startsWith('.') &&
          !STAGE_EXCLUDE_DIRS.has(low) &&
          !BACKUP_ARCHIVE_DIR_SEGMENTS.has(low)
        ) {
          collectDir(full, depth + 1);
        }
        continue;
      }
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.exe')) continue;
      try {
        const st = fs.statSync(full);
        const rel = toPosix(path.relative(workspace, full));
        const rawDir = toPosix(path.posix.dirname(rel));
        const exeDir = rawDir === '.' ? '' : rawDir;
        candidates.push({
          rel,
          full,
          size: st.size,
          depth,
          priorityTier: classifyExePriorityTier(ent.name),
          archiveProximity: computeArchiveProximity(exeDir, archiveDirs),
        });
      } catch {
        // ignore unreadable file
      }
    }
  };
  collectDir(workspace, 0);
  if (!candidates.length) return { exeRel: null, arch: 'unknown' };
  candidates.sort((a, b) => {
    if (a.priorityTier !== b.priorityTier) return a.priorityTier - b.priorityTier;
    if (a.archiveProximity !== b.archiveProximity) return a.archiveProximity - b.archiveProximity;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.size !== b.size) return b.size - a.size;
    return a.rel.localeCompare(b.rel);
  });
  const chosen = candidates[0];
  return { exeRel: chosen.rel, arch: readPeArchitecture(chosen.full) };
}

export function readSkillEncodingHint(engineJson: Record<string, unknown> | null | undefined): string | undefined {
  if (!engineJson || typeof engineJson !== 'object') return undefined;
  const wb = engineJson.writeback;
  const wbEnc =
    wb && typeof wb === 'object' && !Array.isArray(wb) && typeof (wb as Record<string, unknown>).encoding === 'string'
      ? String((wb as Record<string, unknown>).encoding).trim()
      : '';
  if (wbEnc && wbEnc.toLowerCase() !== 'auto') return wbEnc;
  const topEnc = typeof engineJson.encoding === 'string' ? engineJson.encoding.trim() : '';
  if (topEnc && topEnc.toLowerCase() !== 'auto') return topEnc;
  return undefined;
}

export function readSkillRuntimeCharsetHint(
  engineJson: Record<string, unknown> | null | undefined
): RuntimeCharsetHint | undefined {
  if (!engineJson || typeof engineJson !== 'object') return undefined;
  const wb = engineJson.writeback;
  if (wb && typeof wb === 'object' && !Array.isArray(wb)) {
    const wbHint = normalizeRuntimeCharsetHint((wb as Record<string, unknown>).runtime_charset);
    if (wbHint) return wbHint;
  }
  return normalizeRuntimeCharsetHint(engineJson.runtime_charset);
}

export function buildApplyPythonEnv(
  ws: string,
  fontsDataDir: string,
  targetEncoding: string,
  customOptions?: Record<string, string | number | boolean>
): Record<string, string> {
  const env: Record<string, string> = {
    PAPERCUP_TARGET_ENCODING: targetEncoding,
    PAPERCUP_WORKSPACE: ws,
    PAPERCUP_PATCH_OPTIONS_JSON: JSON.stringify(customOptions ?? {}),
  };
  const remapPath = path.join(fontsDataDir, 'char_remap.json');
  try {
    if (!isSymlinkPath(remapPath) && fs.existsSync(remapPath) && fs.statSync(remapPath).isFile()) {
      env.PAPERCUP_CHAR_REMAP_PATH = remapPath;
    }
  } catch {
    // ignore unreadable remap file
  }
  return env;
}

export function snapshotFiles(
  rootDir: string,
  excludeBasenames: Set<string> = MANIFEST_BASENAMES
): Map<string, { size: number; sha256: string }> {
  const snap = new Map<string, { size: number; sha256: string }>();
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
        if (excludeBasenames.has(ent.name) || ent.name.endsWith('.bak')) continue;
        const rel = toPosix(path.relative(rootDir, full));
        const buf = fs.readFileSync(full);
        snap.set(rel, { size: buf.length, sha256: sha256Hex(buf) });
      }
    }
  };
  walk(rootDir);
  return snap;
}

export function probeSourceEncoding(
  rootDir: string,
  trackFiles: Array<{ rows: Array<Record<string, unknown>> }>,
  profileHint?: string
): string {
  const hint = (profileHint || '').trim().toLowerCase();
  if (hint) {
    try {
      const norm = normalizeEncodingName(hint);
      if (norm) return norm;
    } catch {
      // fall through to file sampling
    }
  }
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const tf of trackFiles) {
    for (const row of tf.rows) {
      if (seen.size >= 10) break;
      const rel = typeof row.file === 'string' ? row.file.trim() : '';
      if (!rel || seen.has(rel)) continue;
      const full = path.resolve(rootDir, rel);
      const check = path.relative(rootDir, full);
      if (!check || check.startsWith('..') || path.isAbsolute(check)) continue;
      if (isSymlinkPath(full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      seen.add(rel);
      try {
        const buf = fs.readFileSync(full);
        const enc = detectEncoding(buf);
        counts.set(enc, (counts.get(enc) || 0) + 1);
      } catch {
        // binary or undecodable -> record as unknown
        counts.set('unknown', (counts.get('unknown') || 0) + 1);
      }
    }
  }
  if (!counts.size) return 'unknown';
  // Prefer cp932 if any sampled text is cp932 (mixed ASCII files report utf-8)
  if (counts.has('cp932')) return 'cp932';
  if (counts.has('utf-16le-bom')) return 'utf-16le-bom';
  if (counts.has('utf-8-bom')) return 'utf-8-bom';
  if (counts.has('utf-8')) return 'utf-8';
  return 'unknown';
}

export function collectSkillCustomEncodings(engineJson: Record<string, unknown> | null): string[] {
  if (!engineJson || typeof engineJson !== 'object') return [];
  const out: string[] = [];
  const pushList = (raw: unknown) => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const cleaned = item.trim().toLowerCase();
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
  };
  pushList(engineJson.custom_encodings);
  const wb = engineJson.writeback;
  if (wb && typeof wb === 'object' && !Array.isArray(wb)) {
    pushList((wb as Record<string, unknown>).custom_encodings);
  }
  return out;
}

function resetManagedPatchDirOutputs(patchDir: string, options: { keepHookConfig: boolean }): void {
  for (const sub of ['files', 'sources']) {
    const p = path.join(patchDir, sub);
    if (!isSymlinkPath(p) && fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
  if (!options.keepHookConfig) {
    const iniPath = path.join(patchDir, 'papercup_patch.ini');
    if (!isSymlinkPath(iniPath) && fs.existsSync(iniPath) && fs.statSync(iniPath).isFile()) {
      fs.rmSync(iniPath, { force: true });
    }
  }
}

export function resolvePatchEncodingAndHook(params: {
  engineKind: 'xp3' | 'rpa' | 'pe-zip' | 'nsa' | 'skill' | 'direct';
  sourceEncoding: string;
  profile: LocalizationProfile;
  patchConfig: PatchConfig;
  explicitEncoding?: string | null;
  exeInfo: { exeRel: string | null; arch: 'x86' | 'x64' | 'unknown' };
  allowCustomEncoding?: boolean;
  allowedCustomEncodings?: readonly string[];
  runtimeCharset?: RuntimeCharsetHint;
}): {
  targetEncoding: string;
  override: boolean;
  customEncodingUsed: boolean;
  hook: PatchHookMeta;
} {
  const {
    engineKind,
    sourceEncoding,
    profile,
    patchConfig,
    explicitEncoding,
    exeInfo,
    allowCustomEncoding = false,
    allowedCustomEncodings,
    runtimeCharset,
  } = params;
  const encOpts = { allowCustom: allowCustomEncoding, allowedCustomEncodings };
  let overrideEnc: string | null = null;
  if (explicitEncoding && explicitEncoding.trim()) {
    overrideEnc = normalizeEncodingName(explicitEncoding, encOpts);
  } else if (patchConfig.encoding && patchConfig.encoding !== 'auto') {
    overrideEnc = normalizeEncodingName(patchConfig.encoding, encOpts);
  }

  const isZh = /^zh(?:[-_]|$)/i.test(profile.targetLang.trim());
  const isNativeUnicodeEngine = engineKind === 'xp3' || engineKind === 'rpa' || engineKind === 'pe-zip';
  const isLegacyCp932Engine =
    engineKind === 'nsa' ||
    ((engineKind === 'skill' || engineKind === 'direct') &&
      (sourceEncoding === 'cp932' || sourceEncoding === 'unknown'));
  const isUnicodeSource =
    sourceEncoding === 'utf-8' ||
    sourceEncoding === 'utf-8-bom' ||
    sourceEncoding === 'utf-16le-bom' ||
    sourceEncoding === 'utf-16le';
  const effectiveRuntimeCharset = patchConfig.runtimeCharset ?? runtimeCharset;
  const isUnicodeRuntimeShiftJis = isZh && isUnicodeSource && effectiveRuntimeCharset === 'shift_jis';

  let defaultEncoding: string;
  if (engineKind === 'xp3') {
    defaultEncoding = 'utf-16le-bom';
  } else if (engineKind === 'rpa' || engineKind === 'pe-zip') {
    defaultEncoding = 'utf-8';
  } else if (isLegacyCp932Engine && isZh) {
    defaultEncoding = 'gbk';
  } else if (isUnicodeSource) {
    defaultEncoding = sourceEncoding;
  } else {
    defaultEncoding = 'utf-8';
  }

  const targetEncoding = overrideEnc || defaultEncoding;
  const customEncodingUsed = tryNormalizeBuiltinEncoding(targetEncoding) === null;

  let hookNeeded = false;
  if (patchConfig.hookMode === 'win32_proxy') {
    hookNeeded = true;
  } else if (patchConfig.hookMode === 'none') {
    hookNeeded = false;
  } else if (customEncodingUsed) {
    // Custom charset / bitmap-font codecs run under the game's native codepage unless win32_proxy is explicitly requested
    hookNeeded = false;
  } else if (
    isZh &&
    ((!isNativeUnicodeEngine && isLegacyCp932Engine && targetEncoding !== 'cp932') ||
      isUnicodeRuntimeShiftJis)
  ) {
    hookNeeded = true;
  }

  if (!hookNeeded) {
    return {
      targetEncoding,
      override: Boolean(overrideEnc),
      customEncodingUsed,
      hook: {
        needed: false,
        mode: 'none',
        phase: 'phase1_config_ready',
        target_exe: exeInfo.exeRel,
        target_arch: exeInfo.arch,
      },
    };
  }

  const defaultCodepage =
    isUnicodeRuntimeShiftJis || targetEncoding === 'gbk'
      ? 936
      : targetEncoding === 'utf-8' || targetEncoding === 'utf-8-bom'
        ? 65001
        : 936;
  const codepage = patchConfig.codepage ?? defaultCodepage;
  const charset = patchConfig.charset ?? (isZh ? 134 : 1);
  const fontName = patchConfig.fontName ?? (isZh ? 'SimHei' : 'Segoe UI');
  const forceFontName = Boolean(patchConfig.forceFontName);
  const enableWidthCompat = patchConfig.enableWidthCompat ?? true;
  const note = isUnicodeRuntimeShiftJis
    ? `脚本本身为 Unicode (${targetEncoding})，但目标引擎在运行时强制使用 Shift-JIS (SHIFTJIS_CHARSET 0x80 / CP932) 渲染或判定全半角；已按全局策略生成 GBK (CP936 / 0x86) 运行时配置 papercup_patch.ini 供 Win32 Proxy Hook 或外部转区工具加载（若需零 DLL 纯资产交付，可改用 vn_patch_font(remapMode="sjis_fullwidth_slots") 生成重映射字库并经 PAPERCUP_CHAR_REMAP_PATH 查表写回）。`
    : codepage === 936
      ? '原版引擎为 CP932/Shift-JIS，补丁已转为 GBK (CP936) 并附带 papercup_patch.ini；运行游戏时请配合编码/区域 Hook（如内置 Phase 2 Paper Cup Proxy DLL 或 Locale Emulator 简体中文配置）。'
      : `原版引擎为 CP932/Shift-JIS，补丁已按 ${targetEncoding} (CP${codepage}) 输出并附带 papercup_patch.ini；运行游戏时请配合支持该代码页的外部 Hook 或兼容运行时。`;

  return {
    targetEncoding,
    override: Boolean(overrideEnc),
    customEncodingUsed,
    hook: {
      needed: true,
      mode: 'win32_proxy',
      phase: 'phase1_config_ready',
      ...(patchConfig.proxyDll ? { proxy_dll: patchConfig.proxyDll } : {}),
      codepage,
      charset,
      font_name: fontName,
      force_font_name: forceFontName,
      enable_width_compat: enableWidthCompat,
      config_file: 'papercup_patch.ini',
      target_exe: exeInfo.exeRel,
      target_arch: exeInfo.arch,
      note,
    },
  };
}

export function pickAvailableXp3OverlayName(
  workspace: string,
  archiveRelDir: string,
  usedNames: Set<string> = new Set()
): string {
  const dir = archiveRelDir && archiveRelDir !== '.' ? path.join(workspace, archiveRelDir) : workspace;
  const existing = new Set<string>();
  try {
    for (const name of fs.readdirSync(dir)) {
      existing.add(name.toLowerCase());
    }
  } catch {
    // ignore missing dir
  }
  const candidates = ['patch.xp3'];
  for (let n = 2; n <= 99; n++) candidates.push(`patch${n}.xp3`);
  for (const cand of candidates) {
    const key = `${archiveRelDir || '.'}/${cand}`.toLowerCase();
    if (!existing.has(cand.toLowerCase()) && !usedNames.has(key)) {
      usedNames.add(key);
      return cand;
    }
  }
  throw new ExportCopyError('无法找到可用的 KiriKiri 增量补丁包文件名（patch.xp3 ~ patch99.xp3 均已占用）。');
}

export function buildPatchIni(manifest: {
  engine: string;
  strategy: PatchStrategy | string;
  targetLang: string;
  targetEncoding: string;
  hook: PatchHookMeta;
}): string {
  const lines = [
    '; Paper Cup Localization Patch Configuration',
    '; Compatible with Paper Cup Win32 Proxy Hook (Phase 2) or third-party codepage/locale loaders.',
    '[patch]',
    `engine=${manifest.engine}`,
    `strategy=${manifest.strategy}`,
    `target_lang=${manifest.targetLang}`,
    `encoding=${manifest.targetEncoding}`,
    `codepage=${manifest.hook.codepage ?? 936}`,
    `charset=${manifest.hook.charset ?? 134}`,
    `font_name=${manifest.hook.font_name ?? 'SimHei'}`,
    `force_font_name=${manifest.hook.force_font_name ? 1 : 0}`,
    `enable_width_compat=${manifest.hook.enable_width_compat === false ? 0 : 1}`,
    `target_exe=${manifest.hook.target_exe ?? ''}`,
    `target_arch=${manifest.hook.target_arch ?? 'unknown'}`,
  ];
  if (manifest.hook.proxy_dll) {
    lines.push(`proxy_dll=${manifest.hook.proxy_dll}`);
  }
  return lines.join('\r\n') + '\r\n';
}

export function buildInstallBatchScripts(artifacts: PatchArtifactEntry[]): {
  installBat: string;
  uninstallBat: string;
} {
  const allAscii = artifacts.every((a) => isPureAscii(a.patch_rel) && isPureAscii(a.install_rel));

  const installLines: string[] = [
    '@echo off',
    'setlocal enableextensions',
    'set "PATCH_DIR=%~dp0"',
    'if "%PATCH_DIR:~-1%"=="\\" set "PATCH_DIR=%PATCH_DIR:~0,-1%"',
    'for %%I in ("%PATCH_DIR%\\..") do set "DEFAULT_GAME_DIR=%%~fI"',
    'set "GAME_DIR=%~1"',
    'set "INTERACTIVE=0"',
    'if "%GAME_DIR%"=="" (',
    '  set "INTERACTIVE=1"',
    '  echo Default target game directory: "%DEFAULT_GAME_DIR%"',
    '  set /p "GAME_DIR=Press Enter to install to parent directory [..], or enter game root path: "',
    ')',
    'if not "%GAME_DIR%"=="" set "GAME_DIR=%GAME_DIR:"=%"',
    'if "%GAME_DIR%"=="" set "GAME_DIR=%DEFAULT_GAME_DIR%"',
    'if "%GAME_DIR:~-1%"=="\\" set "GAME_DIR=%GAME_DIR:~0,-1%"',
    'if not exist "%GAME_DIR%\\" (',
    '  echo Error: Game directory not found: %GAME_DIR%',
    '  if "%INTERACTIVE%"=="1" pause',
    '  exit /b 1',
    ')',
    'set "BACKUP_DIR=%GAME_DIR%\\.papercup_backup"',
    'echo Installing Paper Cup localization patch into "%GAME_DIR%"...',
  ];

  const uninstallLines: string[] = [
    '@echo off',
    'setlocal enableextensions',
    'set "PATCH_DIR=%~dp0"',
    'if "%PATCH_DIR:~-1%"=="\\" set "PATCH_DIR=%PATCH_DIR:~0,-1%"',
    'for %%I in ("%PATCH_DIR%\\..") do set "DEFAULT_GAME_DIR=%%~fI"',
    'set "GAME_DIR=%~1"',
    'set "INTERACTIVE=0"',
    'if "%GAME_DIR%"=="" (',
    '  set "INTERACTIVE=1"',
    '  echo Default target game directory: "%DEFAULT_GAME_DIR%"',
    '  set /p "GAME_DIR=Press Enter to uninstall from parent directory [..], or enter game root path: "',
    ')',
    'if not "%GAME_DIR%"=="" set "GAME_DIR=%GAME_DIR:"=%"',
    'if "%GAME_DIR%"=="" set "GAME_DIR=%DEFAULT_GAME_DIR%"',
    'if "%GAME_DIR:~-1%"=="\\" set "GAME_DIR=%GAME_DIR:~0,-1%"',
    'if not exist "%GAME_DIR%\\" (',
    '  echo Error: Game directory not found: %GAME_DIR%',
    '  if "%INTERACTIVE%"=="1" pause',
    '  exit /b 1',
    ')',
    'set "BACKUP_DIR=%GAME_DIR%\\.papercup_backup"',
    'echo Uninstalling Paper Cup localization patch from "%GAME_DIR%"...',
  ];

  if (allAscii) {
    const hasReplace = artifacts.some((a) => a.action === 'replace');
    const backupSubdirs = new Set<string>();
    if (hasReplace) {
      installLines.push('if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"');
    }
    for (const art of artifacts) {
      const winPatch = art.patch_rel.replace(/\//g, '\\');
      const winInstall = art.install_rel.replace(/\//g, '\\');
      const installParent = path.win32.dirname(winInstall);
      if (art.action === 'replace') {
        if (installParent && installParent !== '.') {
          installLines.push(`if not exist "%BACKUP_DIR%\\${installParent}" mkdir "%BACKUP_DIR%\\${installParent}"`);
          let curParent = installParent;
          while (curParent && curParent !== '.') {
            backupSubdirs.add(curParent);
            const nextParent = path.win32.dirname(curParent);
            if (nextParent === curParent) break;
            curParent = nextParent;
          }
        }
        installLines.push(
          `if exist "%GAME_DIR%\\${winInstall}" if not exist "%BACKUP_DIR%\\${winInstall}" copy /Y "%GAME_DIR%\\${winInstall}" "%BACKUP_DIR%\\${winInstall}" >nul || exit /b 1`
        );
      }
      if (installParent && installParent !== '.') {
        installLines.push(`if not exist "%GAME_DIR%\\${installParent}" mkdir "%GAME_DIR%\\${installParent}"`);
      }
      installLines.push(`copy /Y "%PATCH_DIR%\\${winPatch}" "%GAME_DIR%\\${winInstall}" >nul || exit /b 1`);

      if (art.action === 'add') {
        uninstallLines.push(`if exist "%GAME_DIR%\\${winInstall}" del /F /Q "%GAME_DIR%\\${winInstall}"`);
      } else {
        uninstallLines.push(
          `if exist "%BACKUP_DIR%\\${winInstall}" (copy /Y "%BACKUP_DIR%\\${winInstall}" "%GAME_DIR%\\${winInstall}" >nul & del /F /Q "%BACKUP_DIR%\\${winInstall}")`
        );
      }
    }
    if (hasReplace) {
      const sortedSubdirs = [...backupSubdirs].sort((a, b) => b.split('\\').length - a.split('\\').length || b.length - a.length);
      for (const sub of sortedSubdirs) {
        uninstallLines.push(`if exist "%BACKUP_DIR%\\${sub}" rd "%BACKUP_DIR%\\${sub}" 2>nul`);
      }
      uninstallLines.push('if exist "%BACKUP_DIR%" rd "%BACKUP_DIR%" 2>nul');
    }
  } else {
    // Non-ASCII filenames: delegate cleanly to PowerShell reading $env:PATCH_DIR/$env:GAME_DIR (safe for quotes/special chars) while keeping .bat pure ASCII.
    installLines.push(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = $env:PATCH_DIR; $g = $env:GAME_DIR; $b = Join-Path $g \'.papercup_backup\'; $m = Get-Content -LiteralPath (Join-Path $p \'patch_manifest.json\') -Raw -Encoding UTF8 | ConvertFrom-Json; foreach ($a in $m.artifacts) { $src = Join-Path $p $a.patch_rel; $dst = Join-Path $g $a.install_rel; if ($a.action -eq \'replace\' -and (Test-Path -LiteralPath $dst)) { $bk = Join-Path $b $a.install_rel; if (-not (Test-Path -LiteralPath $bk)) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bk) | Out-Null; Copy-Item -LiteralPath $dst -Destination $bk -Force } }; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null; Copy-Item -LiteralPath $src -Destination $dst -Force }" || exit /b 1'
    );
    uninstallLines.push(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = $env:PATCH_DIR; $g = $env:GAME_DIR; $b = Join-Path $g \'.papercup_backup\'; $m = Get-Content -LiteralPath (Join-Path $p \'patch_manifest.json\') -Raw -Encoding UTF8 | ConvertFrom-Json; foreach ($a in $m.artifacts) { $dst = Join-Path $g $a.install_rel; if ($a.action -eq \'add\') { if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force } } else { $bk = Join-Path $b $a.install_rel; if (Test-Path -LiteralPath $bk) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null; Copy-Item -LiteralPath $bk -Destination $dst -Force; Remove-Item -LiteralPath $bk -Force } } }; if (Test-Path -LiteralPath $b) { Get-ChildItem -LiteralPath $b -Directory -Recurse | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force } }; if (-not (Get-ChildItem -LiteralPath $b -Force)) { Remove-Item -LiteralPath $b -Force } }" || exit /b 1'
    );
  }

  installLines.push('echo Patch installation completed.', 'if "%INTERACTIVE%"=="1" pause', 'exit /b 0');
  uninstallLines.push('echo Patch uninstallation completed.', 'if "%INTERACTIVE%"=="1" pause', 'exit /b 0');

  return {
    installBat: installLines.join('\r\n') + '\r\n',
    uninstallBat: uninstallLines.join('\r\n') + '\r\n',
  };
}

function buildPatchReadme(manifest: PatchManifest, totalBytes: number): string {
  const lines = [
    '# Paper Cup 本地化增量补丁 / Paper Cup Delta Localization Patch',
    '',
    '本补丁由 Paper Cup 确定性流水线自动组装，**仅包含发生变更的增量文件与元数据**，不含未修改的原版素材与可执行文件。',
    '用途：仅供个人学习使用，请支持正版。 / Purpose: for personal study only; please support the official release.',
    '',
    '## 补丁摘要',
    '',
    `- 引擎：\`${manifest.engine}\`（类型：\`${manifest.engine_kind}\`）`,
    `- 补丁策略：\`${manifest.strategy}\``,
    `- 语言：\`${manifest.source_lang}\` -> \`${manifest.target_lang}\``,
    `- 编码：源检测 \`${manifest.encoding.source_detected}\` -> 补丁写回 \`${manifest.encoding.target}\`${manifest.encoding.override ? '（显式覆盖）' : ''}`,
    `- 变更脚本数：${manifest.changed_files.length} 个`,
    `- 补丁产物数：${manifest.artifacts.length} 个（约 ${(totalBytes / 1024).toFixed(1)} KiB）`,
    `- Hook 需求：${
      manifest.hook.needed
        ? `需要（\`${manifest.hook.mode}\`，${
            manifest.hook.proxy_bundled
              ? `Phase 2 已内置 \`${manifest.hook.proxy_dll ?? 'version.dll'}\``
              : 'Phase 1 配置就绪'
          }，CP${manifest.hook.codepage} / Charset ${manifest.hook.charset} / 字体 ${manifest.hook.font_name}）`
        : '无需额外 Hook（原生支持）'
    }`,
    '',
    '## 安装与卸载',
    '',
    '- **Windows 一键安装**：直接双击 `install_patch.bat` 并按回车，默认安装到上级游戏目录 `..`；也可拖拽游戏文件夹到脚本上或运行 `install_patch.bat "<你的游戏根目录>"`（覆盖类文件会自动备份至游戏根目录下的 `.papercup_backup/`，不会破坏原始文件）。',
    '- **Windows 一键卸载**：直接双击 `uninstall_patch.bat` 并按回车（默认还原上级游戏目录 `..`），或运行 `uninstall_patch.bat "<你的游戏根目录>"`（移除新增补丁文件并从 `.papercup_backup/` 恢复被替换的原文件）。',
    '- **手动安装**：按 `patch_manifest.json` 中 `artifacts` 列表，将 `files/` 下对应文件复制到游戏根目录相同相对路径。',
    '',
  ];

  if (manifest.hook.needed) {
    const configRel = manifest.hook.config_file || 'papercup_patch.ini';
    const proxyHint = manifest.hook.proxy_bundled
      ? `- 运行方式：本补丁已内置 Phase 2 Win32 Proxy DLL（\`${manifest.hook.proxy_dll ?? 'version.dll'}\`）与 \`${configRel}\`，运行 \`install_patch.bat\` 会自动将二者部署到游戏可执行文件同目录，直接启动游戏即可生效（无需额外配置 Locale Emulator）。`
      : `- 运行方式：将 \`${configRel}\` 与补丁文件一同安装至游戏目录，并通过支持对应代码页的加载器运行（例如运行 \`node server/native/win32-proxy/build.mjs\` 编译内置 Win32 Proxy DLL 后重新打包，或使用 Locale Emulator 简体中文配置，或改用 \`vn_patch_font(remapMode="sjis_fullwidth_slots")\` 零 DLL 方案）。`;
    lines.push(
      '## 编码与 Hook 说明（CP932 引擎适配）',
      '',
      manifest.hook.note ||
        '目标引擎原版仅原生支持 Shift-JIS (CP932)。本补丁已自动转换目标编码并生成 `papercup_patch.ini`。',
      '',
      proxyHint,
      '- 重新组装：本补丁包内 `sources/` 目录保留了完整译文 JSONL。若希望改为 UTF-8 输出或禁用 Hook，可在工作区 `papercup.toml` 的 `[vn.patch]` 中配置 `encoding = "utf-8"` / `hook_mode = "none"` 后重新运行 `vn_writeback`。',
      ''
    );
  }

  lines.push(
    '## 产物清单',
    '',
    ...manifest.artifacts.map(
      (a) => `- \`${a.patch_rel}\` -> 游戏目录 \`${a.install_rel}\`（\`${a.action}\`，${a.bytes} B，SHA-256 \`${a.sha256.slice(0, 12)}...\`）`
    ),
    ''
  );
  return lines.join('\n');
}

export function buildWorkspacePatchGuide(
  manifest: PatchManifest,
  totalBytes: number,
  options: { isBuiltinPatchDir: boolean; patchDir: string }
): string {
  const patchDisplay = options.isBuiltinPatchDir ? `${WORKSPACE_PATCH_REL}/` : options.patchDir.replace(/\\/g, '/');
  const lines = [
    '# 汉化补丁使用说明 / Paper Cup Patch Guide',
    '',
    '本补丁由 Paper Cup 自动组装，仅包含发生变更的增量补丁文件与元数据，未修改任何原始游戏文件。',
    '用途：仅供个人学习使用，请支持正版。 / Purpose: for personal study only; please support the official release.',
    '',
    '## 一键安装与卸载',
    '',
  ];

  if (options.isBuiltinPatchDir) {
    lines.push(
      `- **安装补丁**：打开本目录下的 \`${WORKSPACE_PATCH_REL}\` 文件夹，双击 \`install_patch.bat\` 并直接按回车（默认自动安装到当前游戏目录 \`..\`；需要覆盖的原文件会自动备份到 \`.papercup_backup/\`）。`,
      `- **卸载还原**：打开 \`${WORKSPACE_PATCH_REL}\` 文件夹，双击 \`uninstall_patch.bat\` 并直接按回车，即可移除补丁文件并从 \`.papercup_backup/\` 还原原版文件。`,
      `- **指定其他游戏目录**：可将任意游戏目录拖拽到 \`${WORKSPACE_PATCH_REL}\\install_patch.bat\` 上，或在命令行执行 \`${WORKSPACE_PATCH_REL}\\install_patch.bat "<游戏根目录>"\`。`,
      ''
    );
  } else {
    lines.push(
      `- **外部导出目录**：\`${patchDisplay}\``,
      `- **安装补丁**：在导出目录运行 \`install_patch.bat "<你的游戏根目录>"\`（覆盖类文件会自动备份至 \`.papercup_backup/\`）。`,
      `- **卸载还原**：在导出目录运行 \`uninstall_patch.bat "<你的游戏根目录>"\`。`,
      ''
    );
  }

  lines.push(
    '## 补丁概要',
    '',
    `- 更新时间：\`${manifest.created_at}\``,
    `- 补丁位置：\`${patchDisplay}\``,
    `- 引擎：\`${manifest.engine}\`（类型：\`${manifest.engine_kind}\`）`,
    `- 补丁策略：\`${manifest.strategy}\``,
    `- 语言：\`${manifest.source_lang}\` -> \`${manifest.target_lang}\``,
    `- 编码：源检测 \`${manifest.encoding.source_detected}\` -> 补丁写回 \`${manifest.encoding.target}\`${manifest.encoding.override ? '（显式覆盖）' : ''}`,
    `- 变更脚本数：${manifest.changed_files.length} 个`,
    `- 补丁产物数：${manifest.artifacts.length} 个（约 ${(totalBytes / 1024).toFixed(1)} KiB）`,
    `- Hook 需求：${
      manifest.hook.needed
        ? `需要（\`${manifest.hook.mode}\`，${
            manifest.hook.proxy_bundled
              ? `Phase 2 已内置 \`${manifest.hook.proxy_dll ?? 'version.dll'}\``
              : 'Phase 1 配置就绪'
          }，CP${manifest.hook.codepage} / Charset ${manifest.hook.charset} / 字体 ${manifest.hook.font_name}）`
        : '无需额外 Hook（原生支持）'
    }`,
    ''
  );

  if (manifest.hook.needed) {
    const configRel = manifest.hook.config_file || 'papercup_patch.ini';
    lines.push(
      '## 编码与运行提示',
      '',
      manifest.hook.note ||
        '目标引擎原版仅原生支持 Shift-JIS (CP932)。本补丁已自动转换目标编码并附带 `papercup_patch.ini`。',
      '',
      manifest.hook.proxy_bundled
        ? `- Phase 2 Win32 Proxy DLL（\`${manifest.hook.proxy_dll ?? 'version.dll'}\`）与 \`${configRel}\` 已随补丁自动打包；执行 \`install_patch.bat\` 后直接启动游戏即可加载，无需 Locale Emulator。`
        : `- 未检测到预编译的 Phase 2 Proxy DLL：可运行 \`node server/native/win32-proxy/build.mjs\` 编译内置 Proxy DLL 后重打补丁，或使用 Locale Emulator（简体中文 / CP936 配置），或改用 \`vn_patch_font(remapMode="sjis_fullwidth_slots")\` 零 DLL 方案。`,
      ''
    );
  }

  const patchPrefix = patchDisplay.endsWith('/') ? patchDisplay : `${patchDisplay}/`;
  lines.push(
    '## 产物与工程说明',
    '',
    ...manifest.artifacts.map(
      (a) => `- \`${a.patch_rel}\` -> \`${a.install_rel}\`（\`${a.action}\`，${a.bytes} B，SHA-256 \`${a.sha256.slice(0, 12)}...\`）`
    ),
    '',
    `- 补丁包内同步附带详细清单 \`${patchPrefix}patch_manifest.json\` 与 \`${patchPrefix}README.md\`。`,
    '- 持久化译文与工程状态位于 `.papercup/data/`，解包与冒烟等临时缓存位于 `.papercup/tmp/`（可随时清理，不影响已生成的补丁与译文）。',
    ''
  );

  return lines.join('\n');
}

export function stageDirectWorkspaceSubset(
  sourceDirectRoot: string,
  stageDirectRoot: string,
  explicitTargets: Set<string>
): void {
  fs.mkdirSync(stageDirectRoot, { recursive: true });
  const copySingleRel = (relPosix: string) => {
    const cleaned = toPosix(relPosix);
    if (!cleaned) return;
    const src = path.resolve(sourceDirectRoot, cleaned);
    const relCheck = path.relative(sourceDirectRoot, src);
    if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return;
    if (isSymlinkPath(src) || !fs.existsSync(src) || !fs.statSync(src).isFile()) return;
    const dst = path.join(stageDirectRoot, relCheck);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };

  for (const rel of explicitTargets) copySingleRel(rel);

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
        if (ent.name.startsWith('.') || STAGE_EXCLUDE_DIRS.has(ent.name.toLowerCase())) continue;
        walk(full);
      } else if (ent.isFile()) {
        if (ent.name === 'papercup.toml' || ent.name === WORKSPACE_PATCH_GUIDE_REL || ent.name.endsWith('.bak')) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (DIRECT_SKIP_EXTS.has(ext)) continue;
        try {
          const st = fs.statSync(full);
          if (st.size > MAX_DIRECT_COMPANION_BYTES) continue;
        } catch {
          continue;
        }
        const rel = path.relative(sourceDirectRoot, full);
        const dst = path.join(stageDirectRoot, rel);
        if (!fs.existsSync(dst)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(full, dst);
        }
      }
    }
  };
  walk(sourceDirectRoot);
}

function manifestKindFromFilename(mName: string): 'xp3' | 'rpa' | 'pe-zip' | 'nsa' | 'skill' {
  if (mName === XP3_MANIFEST) return 'xp3';
  if (mName === RPA_MANIFEST) return 'rpa';
  if (mName === PEZIP_MANIFEST) return 'pe-zip';
  if (mName === NSA_MANIFEST) return 'nsa';
  if (mName === SKILL_MANIFEST) return 'skill';
  throw new ExportCopyError(`不支持重打包的清单类型：${mName}`);
}

function manifestEngineLabel(mName: string, mData: Record<string, unknown>): string {
  if (mName === XP3_MANIFEST) return 'kirikiri';
  if (mName === RPA_MANIFEST) return 'renpy';
  if (mName === PEZIP_MANIFEST) return 'pe-zip';
  if (mName === NSA_MANIFEST) return 'nscripter';
  return String(mData.engine || 'custom').trim() || 'custom';
}

export function detectChangedEntriesInManifestDir(
  mDir: string,
  mData: Record<string, unknown>,
  preSnap: Map<string, { size: number; sha256: string }>
): Array<{ internalRel: string; fullPath: string; buf: Buffer }> {
  const manifestLookup = new Map<string, { size: number; sha256: string }>();
  if (Array.isArray(mData.files)) {
    for (const item of mData.files) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? toPosix(rec.name) : '';
      const sha = typeof rec.sha256 === 'string' ? rec.sha256.toLowerCase() : '';
      const size = typeof rec.size === 'number' ? rec.size : -1;
      if (name && sha && size >= 0) {
        manifestLookup.set(name, { size, sha256: sha });
      }
    }
  }

  const changed: Array<{ internalRel: string; fullPath: string; buf: Buffer }> = [];
  const walk = (cur: string) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, ent.name);
      if (isSymlinkPath(full)) continue;
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (MANIFEST_BASENAMES.has(ent.name) || ent.name.endsWith('.bak')) continue;
      const internalRel = toPosix(path.relative(mDir, full));
      staysInside('.', internalRel);
      const buf = fs.readFileSync(full);
      const digest = sha256Hex(buf);
      const baseRef = manifestLookup.get(internalRel) ?? preSnap.get(internalRel);
      if (!baseRef || baseRef.size !== buf.length || baseRef.sha256 !== digest) {
        changed.push({ internalRel, fullPath: full, buf });
      }
    }
  };
  walk(mDir);
  return changed;
}

export async function buildPatchBundle(
  workspace: string,
  profile: LocalizationProfile,
  memory: ProjectMemory,
  options: {
    homeDir?: string | null;
    dest?: string | null;
    unpackedRoot?: string | null;
    encoding?: string | null;
    force?: boolean;
    proxyBinDir?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<BuildPatchBundleResult> {
  const ws = realpathSafe(workspace);
  const wsPaths = resolveWorkspacePaths(ws);
  const unpackedDir = options.unpackedRoot ? insideWorkspace(ws, options.unpackedRoot) : wsPaths.unpackedDir;
  const hasUnpackedDir = Boolean(
    unpackedDir && !isSymlinkPath(unpackedDir) && fs.existsSync(unpackedDir) && fs.statSync(unpackedDir).isDirectory()
  );
  const unpackedManifests = hasUnpackedDir && unpackedDir ? findUnpackManifests(unpackedDir) : [];
  const manifestFallbackEngine = String(readManifest(ws)?.engine || '');
  const directSkill =
    !unpackedManifests.length ? resolveReadyDirectSkill(ws, options.homeDir ?? null, manifestFallbackEngine) : null;

  if (!hasUnpackedDir && !directSkill) {
    throw new ExportCopyError(`工作区还没有 ${WORKSPACE_UNPACKED_REL}/ 解包目录；先解包脚本再生成增量补丁。`);
  }
  if (hasUnpackedDir && !unpackedManifests.length && !directSkill) {
    const hasFiles = unpackedDir ? fs.readdirSync(unpackedDir).length > 0 : false;
    throw new ExportCopyError(
      hasFiles
        ? '解包目录中未找到 Paper Cup 封包清单（如 .skill-manifest.json / .papercup-*.json），检测到目录非空，可能为手工调用 unpack.py 产出。请先通过 vn_unpack 重新解包，严禁手工绕过 vn_unpack / vn_writeback。'
        : '解包目录中未找到封包清单，无法生成增量补丁；请先通过 vn_unpack 解包。'
    );
  }

  const rawDest = options.dest?.trim() || '';
  let patchDir = rawDest ? path.resolve(ws, rawDest) : wsPaths.patchDir;
  patchDir = path.resolve(patchDir);
  if (isSymlinkPath(patchDir)) {
    throw new ExportCopyError(`补丁输出目录不能是符号链接：${patchDir}`);
  }
  const normCmp = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const isBuiltinPatchDir = normCmp(patchDir) === normCmp(wsPaths.patchDir);
  const relToWs = path.relative(ws, patchDir);
  const isInsideWs = relToWs === '' || (!relToWs.startsWith('..') && !path.isAbsolute(relToWs));
  if (isInsideWs && !isBuiltinPatchDir) {
    throw new ExportCopyError(`补丁输出目录只能使用默认 ${WORKSPACE_PATCH_REL}/ 目录或工作区之外的路径：${patchDir}`);
  }
  if (!isBuiltinPatchDir && fs.existsSync(patchDir)) {
    const ents = fs.readdirSync(patchDir);
    if (ents.length && !options.force) {
      throw new ExportCopyError(`补丁输出目录已存在且非空：${patchDir}；换一个 dest 或加 force=true。`);
    }
  }
  const shouldResetManagedOutputs = isBuiltinPatchDir || Boolean(options.force);

  // Validate required tracks and load translated JSONL rows
  const trackFiles: Array<{ track: TrackName; file: string; rows: Array<Record<string, unknown>> }> = [];
  for (const track of TRACKS) {
    const expected = manifestTrackCount(ws, track);
    const resPath = wsPaths.resultsTrackFile(track);
    if (expected !== null && expected > 0) {
      if (isSymlinkPath(resPath) || !fs.existsSync(resPath)) {
        throw new ExportCopyError(`${TRACK_LABELS[track]}需要 ${expected} 段译文，但缺少 ${WORKSPACE_RESULTS_REL}/${track}.jsonl。`);
      }
      const rows = readResultsJsonl(resPath);
      if (rows.length < expected) {
        throw new ExportCopyError(`${TRACK_LABELS[track]}仅覆盖 ${rows.length}/${expected} 段，拒绝生成不完整补丁。`);
      }
      trackFiles.push({ track, file: resPath, rows });
    } else if (!isSymlinkPath(resPath) && fs.existsSync(resPath) && fs.statSync(resPath).isFile()) {
      const rows = readResultsJsonl(resPath);
      if (rows.length) trackFiles.push({ track, file: resPath, rows });
    }
  }
  if (!trackFiles.length) {
    throw new ExportCopyError(`${WORKSPACE_RESULTS_REL}/ 目录下没有任何译文（scenario.jsonl / ui.jsonl）；先完成翻译再生成补丁。`);
  }

  const patchConfig = loadWorkspacePatchConfig(ws);
  const exeInfo = inspectPrimaryGameExe(ws);

  const validateTracksForCustomApply = (explicitEngine?: string): Record<string, number> => {
    const controlPattern = resolveWorkspaceControlPattern(ws, options.homeDir ?? null, explicitEngine || manifestFallbackEngine);
    const applied: Record<string, number> = {};
    for (const tf of trackFiles) {
      for (const r of tf.rows) {
        if (r.ok !== true) throw new ExportCopyError(`${String(r.id || '段落')} 未通过 QA，拒绝导出。`);
        const rep = qaReport(String(r.source || ''), String(r.target || ''), profile, memory.glossary, { controlPattern });
        if (rep.blocked) {
          throw new ExportCopyError(`QA 拦截：${rep.findings.map((f) => f.message).join('；')}`);
        }
      }
      applied[tf.track] = tf.rows.length;
    }
    return applied;
  };

  const prepareCombinedResultsFile = (
    combinedPath: string,
    targetEncoding?: string
  ): { file: string; cleanup: () => void } => {
    const needsGbkCompat = (targetEncoding || '').trim().toLowerCase() === 'gbk';
    if (trackFiles.length === 1 && !needsGbkCompat) {
      return { file: trackFiles[0].file, cleanup: () => {} };
    }
    fs.mkdirSync(path.dirname(combinedPath), { recursive: true });
    const lines = trackFiles.flatMap((tf) =>
      tf.rows.map((r) => {
        if (needsGbkCompat && typeof r.target === 'string') {
          const compat = normalizeGbkCompatText(r.target);
          if (compat !== r.target) {
            return JSON.stringify({ ...r, target: compat });
          }
        }
        return JSON.stringify(r);
      })
    );
    fs.writeFileSync(combinedPath, lines.join('\n') + '\n', 'utf8');
    return {
      file: combinedPath,
      cleanup: () => {
        try {
          if (fs.existsSync(combinedPath)) fs.unlinkSync(combinedPath);
        } catch {
          // ignore
        }
      },
    };
  };

  const finalizeBundle = (meta: {
    engine: string;
    engineKind: string;
    strategy: PatchStrategy;
    writebackMode: 'builtin_apply' | 'skill_apply' | 'direct_skill_apply';
    sourceEncoding: string;
    targetEncoding: string;
    override: boolean;
    hook: PatchHookMeta;
    tracksApplied: Record<string, number>;
    changedFiles: string[];
    artifacts: PatchArtifactEntry[];
    repackedArchives: string[];
  }): BuildPatchBundleResult => {
    fs.mkdirSync(patchDir, { recursive: true });

    const allArtifacts = [...meta.artifacts];
    const patchedFonts = loadPatchedFontManifest(ws);
    for (const fontEntry of patchedFonts.entries) {
      const installRel = fontEntry.install_rel.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!installRel) continue;
      try {
        staysInside('.', installRel);
      } catch {
        continue;
      }
      const dupKey = normArchiveRelKey(installRel);
      if (allArtifacts.some((a) => normArchiveRelKey(a.install_rel) === dupKey)) continue;
      const srcFont = resolvePatchedFontFile(ws, fontEntry);
      if (!srcFont) continue;
      const patchRel = `files/${installRel}`;
      const dstFont = path.join(patchDir, ...patchRel.split('/'));
      fs.mkdirSync(path.dirname(dstFont), { recursive: true });
      fs.copyFileSync(srcFont, dstFont);
      const buf = fs.readFileSync(dstFont);
      allArtifacts.push({
        kind: 'font_patch',
        patch_rel: patchRel,
        install_rel: installRel,
        action: 'replace',
        sha256: sha256Hex(buf),
        bytes: buf.length,
      });
    }

    if (meta.hook.needed) {
      const targetExePosix = meta.hook.target_exe ? toPosix(meta.hook.target_exe) : '';
      const rawExeDir = targetExePosix ? toPosix(path.posix.dirname(targetExePosix)) : '';
      const exeDirPosix = rawExeDir && rawExeDir !== '.' ? rawExeDir : '';
      const absTargetExe = targetExePosix ? path.join(ws, ...targetExePosix.split('/')) : null;
      const proxyDllName = chooseProxyDllName(absTargetExe, patchConfig.proxyDll);
      meta.hook.proxy_dll = proxyDllName;

      const iniPatchRel = exeDirPosix ? `files/${exeDirPosix}/papercup_patch.ini` : 'papercup_patch.ini';
      const iniInstallRel = exeDirPosix ? `${exeDirPosix}/papercup_patch.ini` : 'papercup_patch.ini';
      meta.hook.config_file = iniInstallRel;

      if (exeDirPosix) {
        const staleRootIni = path.join(patchDir, 'papercup_patch.ini');
        if (!isSymlinkPath(staleRootIni) && fs.existsSync(staleRootIni) && fs.statSync(staleRootIni).isFile()) {
          fs.rmSync(staleRootIni, { force: true });
        }
      }

      const iniContent = buildPatchIni({
        engine: meta.engine,
        strategy: meta.strategy,
        targetLang: profile.targetLang,
        targetEncoding: meta.targetEncoding,
        hook: meta.hook,
      });
      const iniBuf = Buffer.from(iniContent, 'utf8');
      const iniPath = path.join(patchDir, ...iniPatchRel.split('/'));
      fs.mkdirSync(path.dirname(iniPath), { recursive: true });
      fs.writeFileSync(iniPath, iniBuf);
      allArtifacts.push({
        kind: 'hook_config',
        patch_rel: iniPatchRel,
        install_rel: iniInstallRel,
        action: 'add',
        sha256: sha256Hex(iniBuf),
        bytes: iniBuf.length,
      });

      const resolvedProxy = resolvePrebuiltProxyDll(meta.hook.target_arch ?? 'unknown', proxyDllName, {
        binDir: options.proxyBinDir,
      });
      if (resolvedProxy) {
        const proxyPatchRel = exeDirPosix ? `files/${exeDirPosix}/${proxyDllName}` : `files/${proxyDllName}`;
        const proxyInstallRel = exeDirPosix ? `${exeDirPosix}/${proxyDllName}` : proxyDllName;
        const dupKey = normArchiveRelKey(proxyInstallRel);
        if (!allArtifacts.some((a) => normArchiveRelKey(a.install_rel) === dupKey)) {
          const dstProxy = path.join(patchDir, ...proxyPatchRel.split('/'));
          fs.mkdirSync(path.dirname(dstProxy), { recursive: true });
          fs.copyFileSync(resolvedProxy.path, dstProxy);
          const wsOrigProxy = path.join(ws, ...proxyInstallRel.split('/'));
          const existsInWs =
            !isSymlinkPath(wsOrigProxy) && fs.existsSync(wsOrigProxy) && fs.statSync(wsOrigProxy).isFile();
          allArtifacts.push({
            kind: 'hook_proxy',
            patch_rel: proxyPatchRel,
            install_rel: proxyInstallRel,
            action: existsInWs ? 'replace' : 'add',
            sha256: resolvedProxy.sha256,
            bytes: resolvedProxy.bytes,
          });
        }
        meta.hook.phase = 'phase2_proxy_bundled';
        meta.hook.proxy_bundled = true;
        meta.hook.note = `已内置 Phase 2 Win32 Proxy DLL（${proxyDllName}，${resolvedProxy.arch}）与 ${iniInstallRel}（CP${meta.hook.codepage ?? 936} / Charset ${meta.hook.charset ?? 134} / 字体 ${meta.hook.font_name ?? 'SimHei'}）；install_patch.bat 会自动将其部署到游戏可执行文件同目录，直接启动游戏即可生效。`;
      } else {
        meta.hook.phase = 'phase1_config_ready';
        meta.hook.proxy_bundled = false;
        meta.hook.note = `当前未检测到预编译的 Phase 2 Proxy DLL（${proxyDllName}，目标架构 ${meta.hook.target_arch ?? 'unknown'}），已输出 Phase 1 配置 ${iniInstallRel}（CP${meta.hook.codepage ?? 936} / Charset ${meta.hook.charset ?? 134}）。可通过 node server/native/win32-proxy/build.mjs 编译 Proxy DLL 后重新打包，或使用 Locale Emulator 简体中文配置，或改用 vn_patch_font(remapMode="sjis_fullwidth_slots") 零 DLL 字库重映射方案。`;
      }
    }

    // Copy translated JSONL sources for future re-assembly
    const sourcesDir = path.join(patchDir, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true });
    const sourcesRecord: PatchManifest['sources'] = {};
    for (const tf of trackFiles) {
      const destSource = path.join(sourcesDir, `${tf.track}.jsonl`);
      const buf = fs.readFileSync(tf.file);
      fs.writeFileSync(destSource, buf);
      sourcesRecord[tf.track] = {
        path: `sources/${tf.track}.jsonl`,
        sha256: sha256Hex(buf),
        bytes: buf.length,
        segments: tf.rows.length,
      };
    }

    const { installBat, uninstallBat } = buildInstallBatchScripts(allArtifacts);
    const installScriptPath = path.join(patchDir, 'install_patch.bat');
    const uninstallScriptPath = path.join(patchDir, 'uninstall_patch.bat');
    fs.writeFileSync(installScriptPath, installBat, 'ascii');
    fs.writeFileSync(uninstallScriptPath, uninstallBat, 'ascii');

    const manifestObj: PatchManifest = {
      schema: 1,
      format: 'papercup-delta-patch',
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      engine: meta.engine,
      engine_kind: meta.engineKind,
      strategy: meta.strategy,
      writeback_mode: meta.writebackMode,
      source_lang: profile.sourceLang,
      target_lang: profile.targetLang,
      encoding: {
        source_detected: meta.sourceEncoding,
        target: meta.targetEncoding,
        override: meta.override,
      },
      hook: meta.hook,
      tracks_applied: meta.tracksApplied,
      changed_files: Array.from(new Set(meta.changedFiles)).sort(),
      artifacts: allArtifacts,
      sources: sourcesRecord,
      install_scripts: {
        windows_install: 'install_patch.bat',
        windows_uninstall: 'uninstall_patch.bat',
      },
    };

    const manifestPath = path.join(patchDir, 'patch_manifest.json');
    const manifestJsonStr = JSON.stringify(manifestObj, null, 2) + '\n';
    fs.writeFileSync(manifestPath, manifestJsonStr, 'utf8');
    const lastMetaPath = wsPaths.lastPatchFile;
    if (!isSymlinkPath(lastMetaPath)) {
      fs.mkdirSync(path.dirname(lastMetaPath), { recursive: true });
      fs.writeFileSync(
        lastMetaPath,
        JSON.stringify(
          {
            manifest_path: manifestPath,
            patch_dir: patchDir,
            sha256: sha256Hex(Buffer.from(manifestJsonStr, 'utf8')),
            created_at: manifestObj.created_at,
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
    }

    const patchBytes = allArtifacts.reduce((acc, a) => acc + a.bytes, 0);
    const readmePath = path.join(patchDir, 'README.md');
    fs.writeFileSync(readmePath, buildPatchReadme(manifestObj, patchBytes), 'utf8');

    const guidePath = wsPaths.patchGuideFile;
    if (!isSymlinkPath(guidePath)) {
      const guideTmp = `${guidePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(
          guideTmp,
          buildWorkspacePatchGuide(manifestObj, patchBytes, { isBuiltinPatchDir, patchDir }),
          'utf8'
        );
        fs.renameSync(guideTmp, guidePath);
      } catch (err) {
        if (fs.existsSync(guideTmp)) {
          try {
            fs.rmSync(guideTmp, { force: true });
          } catch {
            // ignore cleanup error
          }
        }
        throw err;
      }
    }

    return {
      patch_dir: patchDir,
      export_dir: patchDir,
      manifest_path: manifestPath,
      strategy: meta.strategy,
      writeback_mode: meta.writebackMode,
      encoding: meta.targetEncoding,
      source_encoding: meta.sourceEncoding,
      hook_needed: meta.hook.needed,
      hook: meta.hook,
      tracks_applied: meta.tracksApplied,
      changed_files: manifestObj.changed_files,
      artifacts: allArtifacts,
      repacked_archives: meta.repackedArchives,
      patch_bytes: patchBytes,
      install_script: installScriptPath,
      uninstall_script: uninstallScriptPath,
      patch_guide_path: guidePath,
    };
  };

  const stageRoot = path.join(wsPaths.tmpDir, `patch-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stageRoot, { recursive: true });

  try {
    if (directSkill) {
      const tracksApplied = validateTracksForCustomApply(directSkill.engine);
      const directRel = String(directSkill.profile.direct_root || '.').trim().replace(/\\/g, '/');
      if (directRel && directRel !== '.' && isBackupOrNonOriginalArchiveRel(directRel)) {
        throw new ExportCopyError(
          `拒绝生成补丁：direct 技能的 direct_root「${directRel}」位于内部临时或备份目录，直接回包会导致 install_rel 错位。请改用工作区内的原始游戏目录重新执行 vn_learn_skill。`
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
        throw new ExportCopyError(`direct 技能目标目录无效或越界：${directRel}`);
      }

      const explicitTargets = new Set<string>();
      for (const tf of trackFiles) {
        for (const r of tf.rows) {
          if (typeof r.file === 'string' && r.file.trim()) explicitTargets.add(r.file.trim());
        }
      }
      const sysText = directSkill.profile.system_text;
      if (sysText && typeof sysText === 'object' && !Array.isArray(sysText) && Array.isArray((sysText as Record<string, unknown>).files)) {
        for (const f of (sysText as Record<string, unknown>).files as unknown[]) {
          if (typeof f === 'string' && f.trim()) explicitTargets.add(f.trim());
        }
      }

      const stageDirectRoot = path.join(stageRoot, 'direct');
      stageDirectWorkspaceSubset(sourceDirectRoot, stageDirectRoot, explicitTargets);

      const profileEncHint = readSkillEncodingHint(directSkill.profile);
      const sourceEncoding = probeSourceEncoding(stageDirectRoot, trackFiles, profileEncHint);
      const allowedCustomEncodings = collectSkillCustomEncodings(directSkill.profile);
      const resolved = resolvePatchEncodingAndHook({
        engineKind: 'direct',
        sourceEncoding,
        profile,
        patchConfig,
        explicitEncoding: options.encoding,
        exeInfo,
        allowCustomEncoding: true,
        allowedCustomEncodings,
        runtimeCharset: readSkillRuntimeCharsetHint(directSkill.profile),
      });

      const preSnap = snapshotFiles(stageDirectRoot, new Set());
      const prepared = prepareCombinedResultsFile(
        path.join(stageRoot, 'direct-combined.jsonl'),
        resolved.targetEncoding
      );
      try {
        await runPythonScript(
          directSkill.applyPy,
          [prepared.file, stageDirectRoot],
          stageDirectRoot,
          undefined,
          options.signal,
          buildApplyPythonEnv(ws, wsPaths.fontsDataDir, resolved.targetEncoding, patchConfig.customOptions)
        );
      } finally {
        prepared.cleanup();
      }
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
        throw new ExportCopyError('direct 技能写回后未检测到任何变更文件，拒绝生成空补丁。');
      }
      changedRels.sort();

      if (shouldResetManagedOutputs) {
        resetManagedPatchDirOutputs(patchDir, { keepHookConfig: resolved.hook.needed });
      }
      const filesRoot = path.join(patchDir, 'files');
      fs.mkdirSync(filesRoot, { recursive: true });
      const artifacts: PatchArtifactEntry[] = [];
      const repackedArchives: string[] = [];
      const changedFiles: string[] = [];

      const prefixRel = directRel && directRel !== '.' ? toPosix(directRel).replace(/\/+$/, '') : '';
      for (const rel of changedRels) {
        staysInside('.', rel);
        const installRel = prefixRel ? `${prefixRel}/${rel}` : rel;
        const patchRel = `files/${installRel}`;
        const srcFull = path.join(stageDirectRoot, rel);
        const dstFull = path.join(patchDir, patchRel);
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        const buf = fs.readFileSync(srcFull);
        fs.writeFileSync(dstFull, buf);
        const wsOrig = path.join(ws, installRel);
        const existsInWs = !isSymlinkPath(wsOrig) && fs.existsSync(wsOrig) && fs.statSync(wsOrig).isFile();
        artifacts.push({
          kind: 'replace_file',
          patch_rel: patchRel,
          install_rel: installRel,
          action: existsInWs ? 'replace' : 'add',
          sha256: sha256Hex(buf),
          bytes: buf.length,
        });
        repackedArchives.push(dstFull);
        changedFiles.push(installRel);
      }

      return finalizeBundle({
        engine: directSkill.engine,
        engineKind: 'direct',
        strategy: 'direct_file_replace',
        writebackMode: 'direct_skill_apply',
        sourceEncoding,
        targetEncoding: resolved.targetEncoding,
        override: resolved.override,
        hook: resolved.hook,
        tracksApplied,
        changedFiles,
        artifacts,
        repackedArchives,
      });
    }

    // Archive-based unpacked workflow
    const stagedUnpacked = path.join(stageRoot, 'unpacked');
    copyTreeRecursive(unpackedDir!, stagedUnpacked);
    const manifests = findUnpackManifests(stagedUnpacked);
    if (!manifests.length) {
      throw new ExportCopyError('解包目录中未找到封包清单，无法生成增量补丁。');
    }

    const customApply = resolveReadySkillScript(ws, options.homeDir ?? null, manifests, 'apply.py', manifestFallbackEngine);
    const customApplyPy = customApply?.scriptPath || null;

    // Locate target root matching result file paths
    let applyRoot = stagedUnpacked;
    const sampleFileRel = String(trackFiles[0].rows[0]?.file || '');
    if (sampleFileRel && !fs.existsSync(path.join(stagedUnpacked, sampleFileRel))) {
      for (const m of manifests) {
        const cand = path.dirname(m);
        if (fs.existsSync(path.join(cand, sampleFileRel))) {
          applyRoot = cand;
          break;
        }
      }
    }

    const firstManifestName = path.basename(manifests[0]);
    const firstManifestData = JSON.parse(fs.readFileSync(manifests[0], 'utf8')) as Record<string, unknown>;
    const primaryKind = manifestKindFromFilename(firstManifestName);
    const primaryEngine = manifestEngineLabel(firstManifestName, firstManifestData);

    const skillEngineProfile = customApply
      ? resolveEngineJson(ws, customApply.engine, options.homeDir ?? null)
      : null;
    const allowedCustomEncodings = collectSkillCustomEncodings(skillEngineProfile);

    const sourceEncoding = probeSourceEncoding(
      applyRoot,
      trackFiles,
      readSkillEncodingHint(skillEngineProfile)
    );
    const resolved = resolvePatchEncodingAndHook({
      engineKind: primaryKind,
      sourceEncoding,
      profile,
      patchConfig,
      explicitEncoding: options.encoding,
      exeInfo,
      allowCustomEncoding: Boolean(customApplyPy),
      allowedCustomEncodings,
      runtimeCharset: readSkillRuntimeCharsetHint(skillEngineProfile),
    });

    // Snapshot each manifest directory BEFORE apply so SKILL_MANIFEST (which lacks per-file sha256) detects changes accurately
    const preSnapshots = new Map<string, Map<string, { size: number; sha256: string }>>();
    for (const m of manifests) {
      const mDir = path.dirname(m);
      preSnapshots.set(mDir, snapshotFiles(mDir));
    }

    let tracksApplied: Record<string, number> = {};
    const writebackMode: 'builtin_apply' | 'skill_apply' = customApplyPy ? 'skill_apply' : 'builtin_apply';
    const resolvedControlPattern = resolveWorkspaceControlPattern(
      ws,
      options.homeDir ?? null,
      customApply?.engine || manifestFallbackEngine || primaryEngine
    );

    if (customApplyPy) {
      tracksApplied = validateTracksForCustomApply(customApply?.engine || primaryEngine);
      const prepared = prepareCombinedResultsFile(
        path.join(stageRoot, 'combined-results.jsonl'),
        resolved.targetEncoding
      );
      try {
        await runPythonScript(
          customApplyPy,
          [prepared.file, applyRoot],
          applyRoot,
          undefined,
          options.signal,
          buildApplyPythonEnv(ws, wsPaths.fontsDataDir, resolved.targetEncoding, patchConfig.customOptions)
        );
      } finally {
        prepared.cleanup();
      }
    } else if (trackFiles.length === 1) {
      const tf = trackFiles[0];
      const outcome = applyResults(ws, applyRoot, tf.rows, profile, memory, tf.track, {
        encoding: resolved.targetEncoding,
        controlPattern: resolvedControlPattern,
        homeDir: options.homeDir ?? null,
      });
      tracksApplied[tf.track] = outcome.applied;
    } else {
      // Multi-track builtin apply: apply all tracks into lossless UTF-8 first so tracks touching the same script never mis-detect GBK/Shift-JIS, then transcode touched files once.
      const touchedRelPaths = new Set<string>();
      for (const tf of trackFiles) {
        const outcome = applyResults(ws, applyRoot, tf.rows, profile, memory, tf.track, {
          encoding: 'utf-8',
          controlPattern: resolvedControlPattern,
          homeDir: options.homeDir ?? null,
        });
        tracksApplied[tf.track] = outcome.applied;
        for (const item of outcome.report.files) {
          if (item && typeof item.path === 'string' && item.path.trim()) {
            touchedRelPaths.add(item.path);
          }
        }
      }
      if (resolved.targetEncoding !== 'utf-8') {
        for (const rel of touchedRelPaths) {
          const full = path.resolve(applyRoot, rel);
          const text = fs.readFileSync(full, 'utf8');
          let outBuf: Buffer;
          try {
            outBuf = encodeText(text, resolved.targetEncoding);
          } catch (err) {
            throw new ExportCopyError(`译文无法用编码 ${resolved.targetEncoding} 写回 ${rel}：${(err as Error).message}`);
          }
          fs.writeFileSync(full, outBuf);
        }
      }
    }

    unlinkBaksRecursive(stagedUnpacked);

    const detectedOriginal = scanWorkspace(ws, options.homeDir ?? null).hits.filter(
      (h) => !isBackupOrNonOriginalArchiveRel(h.path)
    );

    const pendingManifests: Array<{
      mName: string;
      mDir: string;
      mData: Record<string, unknown>;
      relArchive: string;
      cleanArchiveDir: string;
      changed: Array<{ internalRel: string; buf: Buffer }>;
    }> = [];

    for (const m of manifests) {
      const mName = path.basename(m);
      const mDir = path.dirname(m);
      const mData = JSON.parse(fs.readFileSync(m, 'utf8')) as Record<string, unknown>;
      const preSnap = preSnapshots.get(mDir) ?? new Map();
      const changed = detectChangedEntriesInManifestDir(mDir, mData, preSnap);
      if (!changed.length) {
        continue; // Skip untouched archives (e.g. voice / CG archives)
      }
      const orig = String(mData.source || '');
      const relArchive = validateWritebackSourceArchive(ws, orig, mName, mData, detectedOriginal);
      const archiveDirRel = toPosix(path.dirname(relArchive));
      const cleanArchiveDir = archiveDirRel === '.' ? '' : archiveDirRel;
      pendingManifests.push({ mName, mDir, mData, relArchive, cleanArchiveDir, changed });
    }

    if (!pendingManifests.length) {
      throw new ExportCopyError('没有任何脚本因译文发生变化，拒绝生成空补丁。');
    }

    if (shouldResetManagedOutputs) {
      resetManagedPatchDirOutputs(patchDir, { keepHookConfig: resolved.hook.needed });
    }
    const filesRoot = path.join(patchDir, 'files');
    fs.mkdirSync(filesRoot, { recursive: true });

    const artifacts: PatchArtifactEntry[] = [];
    const repackedArchives: string[] = [];
    const changedFiles: string[] = [];

    // Group XP3 changed files by game-relative archive directory so multiple modified XP3 archives merge into a single clean patch.xp3 overlay
    const xp3Groups = new Map<
      string,
      { entries: Map<string, Buffer>; extra: boolean; sourceArchives: string[] }
    >();
    let chosenStrategy: PatchStrategy | null = null;

    for (const { mName, mDir, mData, relArchive, cleanArchiveDir, changed } of pendingManifests) {

      if (mName === XP3_MANIFEST) {
        chosenStrategy = chosenStrategy ?? 'xp3_overlay';
        const group = xp3Groups.get(cleanArchiveDir) ?? {
          entries: new Map<string, Buffer>(),
          extra: false,
          sourceArchives: [] as string[],
        };
        if (String(mData.version) === 'extra') group.extra = true;
        group.sourceArchives.push(relArchive);
        for (const item of changed) {
          group.entries.set(item.internalRel, item.buf);
          changedFiles.push(item.internalRel);
        }
        xp3Groups.set(cleanArchiveDir, group);
      } else if (mName === RPA_MANIFEST) {
        chosenStrategy = chosenStrategy ?? 'rpa_loose_overlay';
        for (const item of changed) {
          const installRel = cleanArchiveDir ? `${cleanArchiveDir}/${item.internalRel}` : item.internalRel;
          const patchRel = `files/${installRel}`;
          const dstFull = path.join(patchDir, patchRel);
          fs.mkdirSync(path.dirname(dstFull), { recursive: true });
          fs.writeFileSync(dstFull, item.buf);
          const wsExisting = path.join(ws, installRel);
          const existsInWs =
            !isSymlinkPath(wsExisting) && fs.existsSync(wsExisting) && fs.statSync(wsExisting).isFile();
          artifacts.push({
            kind: 'loose_file',
            patch_rel: patchRel,
            install_rel: installRel,
            action: existsInWs ? 'replace' : 'add',
            sha256: sha256Hex(item.buf),
            bytes: item.buf.length,
            source_archive: relArchive,
          });
          repackedArchives.push(dstFull);
          changedFiles.push(installRel);
        }
      } else {
        chosenStrategy = chosenStrategy ?? 'archive_replace';
        const patchRel = `files/${relArchive}`;
        const targetArchive = path.join(patchDir, patchRel);
        fs.mkdirSync(path.dirname(targetArchive), { recursive: true });

        if (mName === SKILL_MANIFEST) {
          const engine = String(mData.engine || '');
          const binding = skillBinding(ws, options.homeDir ?? null, engine);
          if (binding.state !== 'ready' || !binding.directory) {
            const detail = binding.errors?.length ? `（${binding.errors.join('；')}）` : '';
            throw new ExportCopyError(`${engine} 的技能与画像不一致，拒绝回包${detail}。`);
          }
          await runPythonScript(
            path.join(binding.directory, 'repack.py'),
            [mDir, targetArchive],
            mDir,
            undefined,
            options.signal
          );
        } else if (mName === PEZIP_MANIFEST) {
          repackPeZip(mDir, targetArchive);
        } else if (mName === NSA_MANIFEST) {
          repackNsa(mDir, targetArchive);
        } else {
          throw new ExportCopyError(`不支持重打包的清单类型：${mName}`);
        }

        const outBuf = fs.readFileSync(targetArchive);
        const wsOrigArchive = path.join(ws, ...relArchive.split('/'));
        if (!isSymlinkPath(wsOrigArchive) && fs.existsSync(wsOrigArchive) && fs.statSync(wsOrigArchive).isFile()) {
          assertNoDestructiveShrinkReplace({
            action: 'replace',
            targetRel: relArchive,
            originalBytes: fs.statSync(wsOrigArchive).size,
            replacementBytes: outBuf.length,
            contextLabel: 'vn_writeback',
          });
        }
        artifacts.push({
          kind: 'replace_archive',
          patch_rel: patchRel,
          install_rel: relArchive,
          action: 'replace',
          sha256: sha256Hex(outBuf),
          bytes: outBuf.length,
          source_archive: relArchive,
          changed_files: changed.length,
        });
        repackedArchives.push(targetArchive);
        for (const item of changed) changedFiles.push(`${relArchive}::${item.internalRel}`);
      }
    }

    // Emit merged XP3 delta overlay archives
    if (xp3Groups.size > 0) {
      const usedOverlayNames = new Set<string>();
      for (const [dirRel, group] of [...xp3Groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const overlayName = pickAvailableXp3OverlayName(ws, dirRel, usedOverlayNames);
        const installRel = dirRel ? `${dirRel}/${overlayName}` : overlayName;
        const patchRel = `files/${installRel}`;
        const destArchive = path.join(patchDir, patchRel);
        packDeltaXp3([...group.entries.entries()], destArchive, { extra: group.extra });
        const outBuf = fs.readFileSync(destArchive);
        artifacts.push({
          kind: 'overlay_archive',
          patch_rel: patchRel,
          install_rel: installRel,
          action: 'add',
          sha256: sha256Hex(outBuf),
          bytes: outBuf.length,
          source_archive: group.sourceArchives.join(', '),
          changed_files: group.entries.size,
        });
        repackedArchives.push(destArchive);
      }
    }

    if (!artifacts.length) {
      throw new ExportCopyError('没有任何脚本因译文发生变化，拒绝生成空补丁。');
    }

    return finalizeBundle({
      engine: primaryEngine,
      engineKind: primaryKind,
      strategy: chosenStrategy ?? 'archive_replace',
      writebackMode,
      sourceEncoding,
      targetEncoding: resolved.targetEncoding,
      override: resolved.override,
      hook: resolved.hook,
      tracksApplied,
      changedFiles,
      artifacts,
      repackedArchives,
    });
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}
