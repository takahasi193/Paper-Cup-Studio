/**
 * High-level deterministic VN workflows:
 * - Unknown-engine skill verification, packaging & promotion (learn / promote)
 * - Shared staging helpers (delta patch bundle assembly lives in patch.ts)
 * - Local Git checkpoints
 * - Acceptance validation (single archive or delta patch_manifest.json) & AI-disclosed release notes
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  APPLY_DIGEST,
  BUILTIN_ARCHIVE_KINDS,
  EXTRACT_DIGEST,
  NO_UNPACKER_KINDS,
  REPACK_DIGEST,
  SKILL_DIGEST,
  SKILL_MANIFEST,
  SKILL_POINTER,
  UNPACK_DIGEST,
  commitHarness,
  findUnpackManifests,
  globalEnginesDir,
  isEngineName,
  listHarnessVersions,
  loadEngineProfile,
  loadProjectHarnessEngineJson,
  matchLibrary,
  resolveEngineJson,
  runPythonScript,
  scanWorkspace,
  sha256Hex,
  skillBinding,
  staysInside,
  testBuiltinArchiveUnpackable,
  type ArchiveHit,
  type UnknownFile,
} from './archives.js';
import {
  TRACKS,
  TRACK_LABELS,
  applyPartial,
  applyResults,
  applyStatus,
  classifyUnpacked,
  manifestTrackCount,
  readManifest,
  type TextLine,
  type TrackName,
} from './classify.js';
import {
  displayRel,
  insideWorkspace,
  isSafeCustomEncodingName,
  isSymlinkPath,
  loadWorkspacePatchConfig,
  memoryDigest,
  personaDigest,
  profileDigest,
  projectHarnessDir,
  realpathSafe,
  resolveWorkspaceControlPattern,
  type LocalizationProfile,
  type ProjectMemory,
} from './profile.js';
import { qaReport } from './qa.js';
import { getSmokeConfigState, readSmokeReport } from './smoke-config.js';
import {
  WORKSPACE_ACCEPTANCE_REL,
  WORKSPACE_BUILD_REL,
  WORKSPACE_CHECKPOINTS_REL,
  WORKSPACE_DEFAULT_RELEASE_REL,
  WORKSPACE_LOGS_REL,
  WORKSPACE_RELEASE_REL,
  WORKSPACE_RESULTS_REL,
  WORKSPACE_VN_REL,
  resolveWorkspacePaths,
} from './workspace-paths.js';
import {
  bindSkillToWorkspace,
  discoverSkillPackages,
  exportSanitizedSkillPackage,
  findSkillPackageByEngine,
  resolveDynamicDirectRoot,
  sanitizeSkillMarkdownForExport,
} from './skill-registry.js';

const execFileAsync = promisify(execFile);

export const BINARY_CLASSIFY_EXTS = new Set(['.bin', '.ain', '.dat', '.arc', '.pak', '.xp3', '.rpa', '.nsa', '.exe', '.dll']);

export const CHECKPOINTS_REL = WORKSPACE_CHECKPOINTS_REL;
export const ACCEPTANCE_REL = WORKSPACE_ACCEPTANCE_REL;
export const DEFAULT_RELEASE_REL = WORKSPACE_DEFAULT_RELEASE_REL;
export const FORBIDDEN_RELEASE_PHRASES = ['人工汉化', '个人汉化', '汉化完成', '人工翻译完成'];

export const MAX_ARCHIVE_LEARN_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACT_FILES = 8192;
const MAX_EXTRACT_FILE = 16 * 1024 * 1024;
const MAX_EXTRACT_TOTAL = 64 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;
const SECRET_PAIR_RE =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key)\s*[=:]\s*(?:['"][A-Za-z0-9_+/.:=-]{8,}['"]|[A-Za-z0-9_+/.=-]{16,}\b)|\b(?:token|secret|password|passwd|cookie)\s*[=:]\s*['"][A-Za-z0-9_+/.:=-]{12,}['"]/i;
const RESERVED_ENGINES = new Set(['renpy', 'kirikiri', 'nscripter']);

export class LearnError extends Error {}
export class ExportCopyError extends Error {}
export class CheckpointError extends Error {}
export class AcceptanceError extends Error {}
export class ReleaseError extends Error {}

function containsSecret(text: string): boolean {
  return SECRET_RE.test(text) || SECRET_PAIR_RE.test(text);
}

function normalizeExt(raw: string): string {
  let text = raw.trim().toLowerCase();
  if (!text) return '';
  if (!text.startsWith('.')) text = '.' + text;
  if (text === '.' || text === '..' || /[/\\ ]/.test(text)) {
    throw new LearnError(`扩展名不合法：${raw}。`);
  }
  return text;
}

function deriveCustomKind(filePath: string, suffix: string): string {
  const ext = suffix.trim() ? normalizeExt(suffix) : path.extname(filePath).toLowerCase();
  const raw = ext.replace(/^\.+/, '').toLowerCase() || 'custom';
  if (!raw || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) || BUILTIN_ARCHIVE_KINDS.has(raw) || NO_UNPACKER_KINDS.has(raw)) {
    return 'custom';
  }
  return raw;
}

function snapshotDir(root: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  let total = 0;
  const base = realpathSafe(root);
  function walk(dir: string) {
    if (isSymlinkPath(dir)) throw new LearnError('解包结果含符号链接目录');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (isSymlinkPath(full)) throw new LearnError(`解包结果含符号链接：${ent.name}`);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const resolved = realpathSafe(full);
        const relCheck = path.relative(base, resolved);
        if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new LearnError('解包结果逃逸目标目录');
        const data = fs.readFileSync(full);
        total += data.length;
        if (found.size >= MAX_EXTRACT_FILES || data.length > MAX_EXTRACT_FILE || total > MAX_EXTRACT_TOTAL) {
          throw new LearnError('解包结果超过上限');
        }
        found.set(relCheck.replace(/\\/g, '/'), data);
      }
    }
  }
  walk(base);
  if (found.size === 0 || [...found.values()].every((b) => b.length === 0)) {
    throw new LearnError('没有解出非空文件');
  }
  return found;
}

function snapshotsEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, buf] of a.entries()) {
    const other = b.get(k);
    if (!other || !buf.equals(other)) return false;
  }
  return true;
}

function readLocalScript(workspace: string, relOrAbs: string): string {
  const full = insideWorkspace(workspace, relOrAbs);
  if (!full || isSymlinkPath(full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new LearnError(`脚本不存在或是符号链接：${relOrAbs}。`);
  }
  const st = fs.statSync(full);
  if (st.size <= 0 || st.size > MAX_SCRIPT_BYTES) throw new LearnError('脚本大小不合法。');
  const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.includes('PAPERCUP_DRAFT')) throw new LearnError('草稿脚本不能学习。');
  if (containsSecret(text)) throw new LearnError('脚本包含疑似凭据。');
  return text.endsWith('\n') ? text : text + '\n';
}

export function unlinkBaksRecursive(dir: string): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (isSymlinkPath(full)) continue;
    if (ent.isDirectory()) unlinkBaksRecursive(full);
    else if (ent.isFile() && ent.name.endsWith('.bak')) fs.rmSync(full, { force: true });
  }
}

function firstTextProbe(dir: string): Record<string, unknown> | null {
  function findFiles(cur: string): string[] {
    const res: string[] = [];
    for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(cur, ent.name);
      if (isSymlinkPath(p) || ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) res.push(...findFiles(p));
      else if (ent.isFile()) res.push(p);
    }
    return res;
  }
  for (const p of findFiles(dir)) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const lines = txt.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
          const rel = path.relative(dir, p).replace(/\\/g, '/');
          return {
            id: `${rel}#${i + 1}`,
            file: rel,
            line: i + 1,
            scene: '',
            speaker: '',
            kind: 'say',
            track: 'scenario',
            source: lines[i].trim(),
            target: lines[i].trim(),
            ok: true,
          };
        }
      }
    } catch {
      // ignore binary
    }
  }
  return null;
}

const IDENT_RE = /^[A-Za-z_]\w*$/;
const VALID_CLASSIFY_KINDS = new Set(['say', 'choice', 'name', 'button', 'menu', 'system']);
const EXTRACT_KIND_ALIASES: Record<string, string> = {
  scenario: 'say',
  dialogue: 'say',
  ui: 'system',
};
const BACKUP_OR_INTERNAL_TOP_DIRS = new Set([
  '.papercup',
  '.git',
  '.hg',
  '.svn',
  'patch',
  'work',
  'build',
  'results',
  'release',
  'classify-src',
]);
const BACKUP_DIR_SEGMENTS = new Set(['backup', 'backups', '.papercup_backup', 'papercup_backup']);

export function isBackupOrNonOriginalArchiveRel(relPosix: string): boolean {
  const cleaned = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!cleaned) return false;
  const segs = cleaned.split('/').filter(Boolean);
  if (!segs.length) return false;
  const firstLow = segs[0].toLowerCase();
  if (
    BACKUP_OR_INTERNAL_TOP_DIRS.has(firstLow) ||
    (firstLow.startsWith('.') && firstLow !== '.') ||
    /^unpacked(?:$|[0-9._-])/i.test(firstLow)
  ) {
    return true;
  }
  for (let i = 0; i < segs.length - 1; i++) {
    if (BACKUP_DIR_SEGMENTS.has(segs[i].toLowerCase())) {
      return true;
    }
  }
  const baseLow = segs[segs.length - 1].toLowerCase();
  if (baseLow.endsWith('.bak') || baseLow.endsWith('.backup') || baseLow.endsWith('.orig')) {
    return true;
  }
  return false;
}

const HEAVY_MEDIA_SUFFIXES = new Set([
  '.ogg', '.wav', '.mp3', '.flac', '.m4a', '.mp4', '.webm', '.avi', '.wmv', '.mkv', '.mpg', '.mov',
  '.ald', '.alm', '.bgi', '.wai', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.dds',
  '.exe', '.dll', '.so', '.dylib',
]);
const REDIST_ARCHIVE_SUFFIXES = new Set(['.cab', '.msi', '.msp', '.iso']);
const STAGE_SKIP_SUBDIRS = new Set(['directx', 'redist', '_commonredist', 'vcredist', 'dotnetfx', 'backup', 'backups', 'patch']);
const TEXT_SCRIPT_SUFFIXES = new Set([
  '.txt', '.ks', '.tjs', '.rpy', '.json', '.jsonl', '.js', '.ts', '.html', '.htm', '.css',
  '.ini', '.cfg', '.toml', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.md', '.inc',
]);
const MAX_STAGE_MEDIA_BYTES = 1024 * 1024;
const MAX_STAGE_BINARY_BYTES = 8 * 1024 * 1024;

function copyAnalysisStageDir(
  srcDir: string,
  dstDir: string,
  keepTargets?: Set<string>,
  relPrefix = '',
  skipTopDirs?: Set<string>
): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const full = path.join(srcDir, ent.name);
    if (isSymlinkPath(full)) continue;
    const out = path.join(dstDir, ent.name);
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.')) continue;
      const lowDir = ent.name.toLowerCase();
      if (!relPrefix && skipTopDirs?.has(lowDir)) continue;
      if (STAGE_SKIP_SUBDIRS.has(lowDir) && !(keepTargets && keepTargets.has(rel.toLowerCase()))) continue;
      copyAnalysisStageDir(full, out, keepTargets, rel, undefined);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      const st = fs.statSync(full);
      const isProtected = Boolean(
        keepTargets && (keepTargets.has(rel.toLowerCase()) || keepTargets.has(ent.name.toLowerCase()))
      );
      if (
        !isProtected &&
        (REDIST_ARCHIVE_SUFFIXES.has(ext) ||
          (HEAVY_MEDIA_SUFFIXES.has(ext) && st.size > MAX_STAGE_MEDIA_BYTES) ||
          (!TEXT_SCRIPT_SUFFIXES.has(ext) && st.size > MAX_STAGE_BINARY_BYTES))
      ) {
        fs.writeFileSync(out, Buffer.alloc(0));
      } else {
        fs.copyFileSync(full, out);
      }
    }
  }
}

export function parseExtractOutputJsonl(filePath: string, baseDir: string, existingIds: Set<string>): TextLine[] {
  if (isSymlinkPath(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return [];
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const out: TextLine[] = [];
  raw.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行不是合法 JSON：${(err as Error).message}`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行必须是 JSON 对象。`);
    }
    const rec = obj as Record<string, unknown>;
    const rel = typeof rec.file === 'string' ? rec.file.trim().replace(/\\/g, '/') : '';
    if (!rel) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行缺少有效的 file 字段（需为相对路径）。`);
    }
    const lineNum = typeof rec.line === 'number' && Number.isInteger(rec.line) && rec.line >= 1 ? rec.line : 0;
    if (!lineNum) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行缺少有效的正整数 line 字段（不能用 offset 替代 line）。`);
    }
    const source = typeof rec.source === 'string' ? rec.source : '';
    if (!source.trim()) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行 source 为空或仅含空白字符，请过滤空白行。`);
    }
    if (source.includes('\n') || source.includes('\r')) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行 source 包含原始换行符，请转义为字面量 \\n。`);
    }
    const targetFile = insideWorkspace(baseDir, rel);
    if (!targetFile || isSymlinkPath(targetFile) || !fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行引用了不存在或越界的脚本文件：${rel}`);
    }
    let kind = 'system';
    if (rec.kind !== undefined && rec.kind !== null && String(rec.kind).trim() !== '') {
      const rawKind = String(rec.kind).trim().toLowerCase();
      const mapped = EXTRACT_KIND_ALIASES[rawKind] ?? rawKind;
      if (!VALID_CLASSIFY_KINDS.has(mapped)) {
        throw new LearnError(
          `extract.py 第 ${idx + 1} 行 kind="${String(rec.kind)}" 不合法；仅支持 say / choice / name / button / menu / system（或别名 scenario / ui）。`
        );
      }
      kind = mapped;
    }
    const id = String(rec.id || `${rel}#${lineNum}:sys#${idx}`).trim();
    if (existingIds.has(id)) return;
    existingIds.add(id);
    out.push({
      ...(rec as Record<string, unknown>),
      id,
      file: rel,
      line: lineNum,
      scene: typeof rec.scene === 'string' ? rec.scene : '',
      speaker: typeof rec.speaker === 'string' ? rec.speaker : '',
      kind,
      source,
    } as TextLine);
  });
  return out;
}

export async function runSkillExtractRows(
  baseDir: string,
  extractPyPath: string,
  existingIds: Set<string>,
  signal?: AbortSignal
): Promise<TextLine[]> {
  const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-extract-'));
  const outJsonl = path.join(tmpOutDir, 'extract_ui.jsonl');
  try {
    await runPythonScript(extractPyPath, [baseDir, outJsonl], baseDir, undefined, signal);
    return parseExtractOutputJsonl(outJsonl, baseDir, existingIds);
  } finally {
    fs.rmSync(tmpOutDir, { recursive: true, force: true });
  }
}

export function resolveReadySkillScript(
  workspace: string,
  homeDir: string | null,
  manifests: string[],
  scriptName: string,
  fallbackEngine = ''
): { engine: string; scriptPath: string } | null {
  const engineCandidates: string[] = [];
  for (const m of manifests) {
    try {
      const data = JSON.parse(fs.readFileSync(m, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      const eng = typeof data.engine === 'string' ? data.engine.trim().toLowerCase() : '';
      if (eng && eng !== 'pe-zip' && !engineCandidates.includes(eng)) engineCandidates.push(eng);
    } catch {
      // ignore invalid manifest
    }
  }
  const fb = fallbackEngine.trim().toLowerCase();
  if (fb && !engineCandidates.includes(fb)) engineCandidates.push(fb);

  for (const eng of engineCandidates) {
    const binding = skillBinding(workspace, homeDir, eng);
    if (binding.state === 'mismatch') {
      const reason = binding.errors?.length ? `（${binding.errors.join('；')}）` : '';
      throw new Error(`${eng} 的技能 SHA-256 完整性校验失败，拒绝执行 ${scriptName}${reason}`);
    }
    if (binding.state === 'ready' && binding.directory) {
      const cand = path.join(binding.directory, scriptName);
      if (!isSymlinkPath(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return { engine: eng, scriptPath: cand };
      }
    }
  }
  return null;
}

export interface LearnOptions {
  homeDir: string | null;
  engine?: string;
  pipeline?: 'skill' | 'builtin' | 'direct';
  archive?: string;
  sampleArchive?: string;
  unpackedDir?: string;
  unpackScript?: string;
  repackScript?: string;
  extractScript?: string;
  applyScript?: string;
  encoding?: string;
  customEncodings?: string[];
  controlPattern?: string;
  requireWriteback?: boolean;
  confirmLowScenarioCoverage?: boolean;
  suffix?: string;
  magicHex?: string;
  magicOffset?: number;
  classifyProfile?: string;
  classifyExtensions?: string[];
  classifyTags?: Record<string, string>;
  classifyTextAttrs?: string[];
  systemTextFiles?: string[];
  rasterUiAssets?: string[];
  note?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  signal?: AbortSignal;
}

function cleanStringList(items?: string[]): string[] {
  const out: string[] = [];
  for (const raw of items || []) {
    const trimmed = String(raw || '').trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

interface WritebackRoundtripStats {
  totalRows: number;
  scenarioRows: number;
  uiRows: number;
  kindCounts: Record<string, number>;
}

interface WritebackRoundtripResult {
  verified: boolean;
  stats: WritebackRoundtripStats;
}

const LOW_SCENARIO_MIN_TOTAL_ROWS = 30;
const LOW_SCENARIO_MIN_SAY_ROWS = 10;
const LOW_SCENARIO_MIN_SAY_RATIO = 0.05;

function buildMutatedTargetText(source: string): string {
  const token = `M${crypto.randomBytes(2).toString('hex')}`;
  if (source.endsWith('\\n')) {
    return `${source.slice(0, -2)}${token}\\n`;
  }
  return `${source}${token}`;
}

function summarizeExtractedRows(rows: readonly Record<string, unknown>[]): WritebackRoundtripStats {
  let scenarioRows = 0;
  let uiRows = 0;
  const kindCounts: Record<string, number> = {};
  for (const row of rows) {
    const kind = String(row.kind || 'unknown').trim().toLowerCase() || 'unknown';
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;
    if (String(row.track || '') === 'scenario' || kind === 'say') {
      scenarioRows += 1;
    } else {
      uiRows += 1;
    }
  }
  return {
    totalRows: rows.length,
    scenarioRows,
    uiRows,
    kindCounts,
  };
}

function getRowFileExt(row: Record<string, unknown>): string {
  const file = String(row.file || '').trim().replace(/\\/g, '/');
  const ext = path.posix.extname(file).toLowerCase();
  return ext || '<none>';
}

function pickRepresentativeRow(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const sayLong = rows.find((r) => String(r.kind || '').toLowerCase() === 'say' && String(r.source || '').length >= 4);
  if (sayLong) return sayLong;
  const anySay = rows.find((r) => String(r.kind || '').toLowerCase() === 'say');
  if (anySay) return anySay;
  const longerRow = rows.find((r) => String(r.source || '').length >= 6);
  if (longerRow) return longerRow;
  return rows[0];
}

export function pickMutationRowsByFormat(
  rows: readonly Record<string, unknown>[]
): Array<{ ext: string; row: Record<string, unknown> }> {
  if (!rows.length) return [];
  const groups = new Map<string, { ext: string; rows: Array<Record<string, unknown>>; count: number; sayCount: number }>();
  for (const row of rows) {
    const ext = getRowFileExt(row);
    let grp = groups.get(ext);
    if (!grp) {
      grp = { ext, rows: [], count: 0, sayCount: 0 };
      groups.set(ext, grp);
    }
    grp.rows.push(row);
    grp.count += 1;
    if (String(row.kind || '').trim().toLowerCase() === 'say') {
      grp.sayCount += 1;
    }
  }

  const allGroups = [...groups.values()];
  const total = rows.length;
  const selectedExts: string[] = [];
  const addExt = (ext: string) => {
    if (!selectedExts.includes(ext)) selectedExts.push(ext);
  };

  // 1) Dominant scenario (`say`) extension
  const sayGroups = allGroups
    .filter((g) => g.sayCount > 0)
    .sort((a, b) => b.sayCount - a.sayCount || b.count - a.count || a.ext.localeCompare(b.ext));
  if (sayGroups.length > 0) {
    addExt(sayGroups[0].ext);
  }

  // 2) Dominant overall extension by row count
  const byCount = [...allGroups].sort(
    (a, b) => b.count - a.count || b.sayCount - a.sayCount || a.ext.localeCompare(b.ext)
  );
  if (byCount.length > 0) {
    addExt(byCount[0].ext);
  }

  // 3) Every extension containing `say` rows with >= 5% share
  for (const g of sayGroups) {
    if (g.count / total >= LOW_SCENARIO_MIN_SAY_RATIO || g.sayCount / total >= LOW_SCENARIO_MIN_SAY_RATIO) {
      addExt(g.ext);
    }
  }

  // 4) Top 3 extensions overall (preferring formats with `say` rows)
  const ranked = [...allGroups].sort(
    (a, b) =>
      (b.sayCount > 0 ? 1 : 0) - (a.sayCount > 0 ? 1 : 0) ||
      b.count - a.count ||
      b.sayCount - a.sayCount ||
      a.ext.localeCompare(b.ext)
  );
  for (const g of ranked.slice(0, 3)) {
    addExt(g.ext);
  }

  return selectedExts.map((ext) => ({
    ext,
    row: pickRepresentativeRow(groups.get(ext)!.rows),
  }));
}

async function verifyWritebackRoundtrip(params: {
  tmpDir: string;
  engine: string;
  prepareUnpackedDir: (destDir: string) => Promise<void>;
  baselineSnapshot: Map<string, Buffer>;
  repackAndVerify?: (srcDir: string, archiveOut: string, outDir: string) => Promise<void>;
  extractText: string;
  applyText: string;
  classifySpec: Record<string, unknown> | null;
  skipClassify?: boolean;
  encoding: string;
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<WritebackRoundtripResult> {
  const {
    tmpDir,
    engine,
    prepareUnpackedDir,
    baselineSnapshot,
    repackAndVerify,
    extractText,
    applyText,
    classifySpec,
    skipClassify,
    encoding,
    extraEnv,
    signal,
  } = params;
  const emptyStats: WritebackRoundtripStats = { totalRows: 0, scenarioRows: 0, uiRows: 0, kindCounts: {} };
  if (!applyText && !(classifySpec && classifySpec.profile)) {
    return { verified: false, stats: emptyStats };
  }

  const extractPy = path.join(tmpDir, 'extract.py');
  const applyPy = path.join(tmpDir, 'apply.py');
  if (extractText) fs.writeFileSync(extractPy, extractText, 'utf8');
  if (applyText) fs.writeFileSync(applyPy, applyText, 'utf8');

  const permissiveProfile: LocalizationProfile = {
    narrativePov: 'third',
    playerAddress: '',
    mixedRules: '',
    sourceLang: 'ja',
    targetLang: 'zh',
    maxLenRatio: 0,
    maxLenAbs: 0,
    requireGlossary: false,
    residueCheck: false,
    glossaryFile: '',
    personaFile: '',
  };
  const permissiveMem: ProjectMemory = { glossary: {}, persona: {}, lessons: [], personaErrors: [] };

  const collectRows = async (unpackedDir: string) => {
    let baseRows: Array<Record<string, unknown>> = [];
    if (!skipClassify) {
      try {
        const cls = classifyUnpacked(unpackedDir, {
          engine,
          engineProfile: classifySpec ? { classify: classifySpec } : null,
        });
        baseRows = cls.lines.map((row) => ({
          ...row,
          track: row.kind === 'say' ? 'scenario' : 'ui',
          target: row.source,
          ok: true,
        }));
      } catch (err) {
        if (!applyText && !extractText) throw new LearnError(`写回验证分类失败：${(err as Error).message}`);
      }
    }
    const existingIds = new Set(baseRows.map((r) => String(r.id || '')));
    const extraRows = extractText
      ? (await runSkillExtractRows(unpackedDir, extractPy, existingIds, signal)).map((row) => ({
          ...row,
          track: row.kind === 'say' ? 'scenario' : 'ui',
          target: row.source,
          ok: true,
        }))
      : [];
    const allRows = [...baseRows, ...extraRows];
    if (!allRows.length && applyText) {
      const probe = firstTextProbe(unpackedDir);
      if (probe) allRows.push(probe);
    }
    if (!allRows.length) {
      throw new LearnError('未抽出任何可写回文本行，无法完成写回双验证。');
    }
    return { allRows, baseRows, extraRows };
  };

  // 1) Identity writeback roundtrip
  const wsId = path.join(tmpDir, 'ws_identity');
  const dirId = path.join(wsId, 'unpacked');
  fs.mkdirSync(dirId, { recursive: true });
  await prepareUnpackedDir(dirId);
  const { allRows: idRows, extraRows: idExtraRows } = await collectRows(dirId);
  const idJsonl = path.join(wsId, 'identity.jsonl');
  fs.writeFileSync(idJsonl, idRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  if (applyText) {
    await runPythonScript(applyPy, [idJsonl, dirId], dirId, undefined, signal, extraEnv);
  } else {
    const firstTrack = String(idRows[0].track);
    applyResults(wsId, dirId, idRows.filter((r) => r.track === firstTrack), permissiveProfile, permissiveMem, firstTrack, {
      encoding: encoding || undefined,
    });
  }
  unlinkBaksRecursive(dirId);
  if (repackAndVerify) {
    const rebuiltId = path.join(tmpDir, 'wb_id.bin');
    const againId = path.join(tmpDir, 'wb_id_out');
    fs.mkdirSync(againId, { recursive: true });
    await repackAndVerify(dirId, rebuiltId, againId);
    if (!snapshotsEqual(snapshotDir(againId), baselineSnapshot)) {
      throw new LearnError('原样写回并重打包后再解包，与原始提取内容不一致');
    }
  } else if (!snapshotsEqual(snapshotDir(dirId), baselineSnapshot)) {
    throw new LearnError('原样写回后文件内容发生意外改动，未通过身份保真校验');
  }

  // 2) Per-format randomized variable-length target mutation + readback roundtrip
  const wsMut = path.join(tmpDir, 'ws_mut');
  const dirMut = path.join(wsMut, 'unpacked');
  fs.mkdirSync(dirMut, { recursive: true });
  await prepareUnpackedDir(dirMut);
  const mutFromExtra = idExtraRows.length > 0;
  const sampledFormats = pickMutationRowsByFormat(mutFromExtra ? idExtraRows : idRows);
  const mutItems = sampledFormats.map(({ ext, row }) => {
    const originalSource = String(row.source);
    const mutatedTarget = buildMutatedTargetText(originalSource);
    return {
      ext,
      origRow: row,
      originalSource,
      mutatedTarget,
      mutRow: {
        ...row,
        source: originalSource,
        target: mutatedTarget,
      } as Record<string, unknown>,
    };
  });
  const mutJsonl = path.join(wsMut, 'mut.jsonl');
  fs.writeFileSync(mutJsonl, mutItems.map((m) => JSON.stringify(m.mutRow)).join('\n') + '\n', 'utf8');
  if (applyText) {
    await runPythonScript(applyPy, [mutJsonl, dirMut], dirMut, undefined, signal, extraEnv);
  } else {
    const byTrack = new Map<string, Array<Record<string, unknown>>>();
    for (const item of mutItems) {
      const tr = String(item.mutRow.track || 'scenario');
      const arr = byTrack.get(tr) ?? [];
      arr.push(item.mutRow);
      byTrack.set(tr, arr);
    }
    for (const [tr, trRows] of byTrack.entries()) {
      applyResults(wsMut, dirMut, trRows, permissiveProfile, permissiveMem, tr, {
        encoding: encoding || undefined,
      });
    }
  }
  unlinkBaksRecursive(dirMut);
  let verifyReadbackDir = dirMut;
  if (repackAndVerify) {
    const rebuiltMut = path.join(tmpDir, 'wb_mut.bin');
    const againMut = path.join(tmpDir, 'wb_mut_out');
    fs.mkdirSync(againMut, { recursive: true });
    await repackAndVerify(dirMut, rebuiltMut, againMut);
    if (snapshotsEqual(snapshotDir(againMut), baselineSnapshot)) {
      throw new LearnError('微改写回并重打包后解包结果未发生任何变化，写回脚本未生效（请确认 apply.py 真正读取并写入了 target 字段）');
    }
    verifyReadbackDir = againMut;
  } else if (snapshotsEqual(snapshotDir(dirMut), baselineSnapshot)) {
    throw new LearnError('微改写回后文件内容未发生任何变化，写回未生效（请确认 apply.py 真正读取并写入了 target 字段）');
  }

  // Re-run extract.py on the mutated output to prove apply.py truly persisted variable-length `target`
  // across every sampled file format and preserved row structure and untouched neighbor rows.
  if (extractText && mutFromExtra) {
    const reExtracted = await runSkillExtractRows(verifyReadbackDir, extractPy, new Set(), signal);
    if (reExtracted.length !== idExtraRows.length) {
      throw new LearnError(
        `微改写回后重跑 extract.py 行数发生异常变化（原 ${idExtraRows.length} 行 -> 现 ${reExtracted.length} 行），可能破坏了文本表或边界结构`
      );
    }
    const mutatedIds = new Set<string>();
    for (const item of mutItems) {
      const targetId = String(item.origRow.id || '');
      const targetFile = String(item.origRow.file || '');
      const targetLine = Number(item.origRow.line || 0);
      if (targetId) mutatedIds.add(targetId);
      const matchedMut =
        reExtracted.find((r) => String(r.id || '') === targetId) ??
        reExtracted.find((r) => String(r.file || '') === targetFile && Number(r.line || 0) === targetLine);
      if (!matchedMut) {
        throw new LearnError(`微改写回后重跑 extract.py 未找回格式 ${item.ext} 目标行（file=${targetFile}, id=${targetId}），请检查写回逻辑与 ID 稳定性`);
      }
      if (String(matchedMut.source || '') !== item.mutatedTarget) {
        throw new LearnError(
          `格式 ${item.ext}（${targetFile}）变长微改写回后重跑 extract.py 读回内容与预期 target 不一致（期望「${item.mutatedTarget.slice(0, 60)}」，实际「${String(matchedMut.source || '').slice(0, 60)}」）；请确认 apply.py 优先写入完整变长 row["target"] 且无等长写回锁`
        );
      }
    }
    const reById = new Map(reExtracted.map((r) => [String(r.id || ''), r]));
    const sampledExtSet = new Set(mutItems.map((m) => m.ext));
    const neighborsCheckedByExt = new Map<string, number>();
    for (const orig of idExtraRows) {
      const oid = String(orig.id || '');
      if (!oid || mutatedIds.has(oid)) continue;
      const ext = getRowFileExt(orig);
      const countForExt = neighborsCheckedByExt.get(ext) ?? 0;
      if (sampledExtSet.has(ext) ? countForExt >= 2 : neighborsCheckedByExt.size >= sampledExtSet.size) continue;
      const after = reById.get(oid);
      if (!after || String(after.source || '') !== String(orig.source || '')) {
        throw new LearnError(`格式 ${ext} 微改写回后相邻未修改行（id=${oid}）发生损坏或漂移，请检查变长写回与偏移/槽位更新逻辑`);
      }
      neighborsCheckedByExt.set(ext, countForExt + 1);
    }
  }

  return {
    verified: true,
    stats: summarizeExtractedRows(idRows),
  };
}

export function buildUnpackNoMatchGuidance(params: {
  availableHits: readonly ArchiveHit[];
  engineArg?: string;
  archiveArg?: string;
  unknownFiles?: readonly UnknownFile[];
}): string {
  const { availableHits, engineArg = '', archiveArg = '', unknownFiles = [] } = params;
  if (!availableHits.length) {
    const failedBuiltin = unknownFiles.filter((u) =>
      /nbz|malformed (?:xp3|rpa|nsa)/i.test(String(u.reason || ''))
    );
    if (failedBuiltin.length > 0) {
      const desc = failedBuiltin
        .slice(0, 5)
        .map((u) => `${u.path} (${u.reason})`)
        .join('、');
      return `检测到内置格式变体/受保护封包但内置解包器不支持：${desc}。请先通过 vn_detect 查看详情并委派 reverser 逆向注册项目级覆盖技能（vn_learn_skill），再运行 vn_unpack。`;
    }
    return '没有可解包的 RPA、XP3、PE+ZIP、NSA 或已就绪自定义技能封包。';
  }

  const engineLabels: string[] = [];
  const seenEng = new Set<string>();
  for (const h of availableHits) {
    const key = `${h.engine}|${h.kind}`;
    if (seenEng.has(key)) continue;
    seenEng.add(key);
    engineLabels.push(`${h.engine} (kind=${h.kind})`);
  }
  const archiveCandidates = availableHits.slice(0, 10).map((h) => h.path);
  const candHint = `可用 engine：${engineLabels.join('、')}；可用 archive：${archiveCandidates.join('、')}${availableHits.length > 10 ? ' 等' : ''}（或省略 engine/archive 自动解包全部）。`;

  const normEng = engineArg.trim().toLowerCase();
  if (normEng && !availableHits.some((h) => h.engine.toLowerCase() === normEng)) {
    const matchedKind = availableHits.some((h) => h.kind.toLowerCase() === normEng);
    if (matchedKind) {
      return `参数 engine="${engineArg}" 传入的是封包格式 kind 而非引擎标识 engine。${candHint}`;
    }
    return `未找到匹配 engine="${engineArg}" 的可解包封包。${candHint}`;
  }

  if (archiveArg.trim()) {
    return `未找到匹配路径 archive="${archiveArg}" 的可解包封包。${candHint}`;
  }

  return `没有可解包的 RPA、XP3、PE+ZIP、NSA 或已就绪自定义技能封包。${candHint}`;
}

export async function learnUnpackSkill(
  workspace: string,
  options: LearnOptions
): Promise<{ status: string; engine: string; summary: string; skill?: string; digest?: string }> {
  const root = realpathSafe(workspace);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new LearnError(`工作区不存在：${workspace}`);
  const engineArg = (options.engine || '').trim().toLowerCase();
  if (engineArg && !isEngineName(engineArg)) throw new LearnError(`引擎名不合法：${options.engine}`);

  const hasArchivePackers = Boolean(options.unpackScript?.trim() || options.repackScript?.trim());
  if (hasArchivePackers && (!options.unpackScript?.trim() || !options.repackScript?.trim())) {
    return { status: 'diagnosed', engine: engineArg, summary: '自定义解包学习必须同时提供 --unpack 与 --repack 脚本。未写入技能。' };
  }
  if (!hasArchivePackers && !options.unpackedDir?.trim()) {
    return {
      status: 'diagnosed',
      engine: engineArg,
      summary: '未提供解包/重打包脚本时，必须提供 --unpackedDir 进行内置解包后系统文本/写回分析学习。未写入技能。',
    };
  }

  const scan = scanWorkspace(root, options.homeDir);
  const requestedPipeline = (options.pipeline || '').trim().toLowerCase();
  if (requestedPipeline && !['skill', 'builtin', 'direct'].includes(requestedPipeline)) {
    return { status: 'diagnosed', engine: engineArg, summary: `pipeline 只能是 skill、builtin 或 direct：${options.pipeline}。未写入技能。` };
  }
  if (hasArchivePackers && (requestedPipeline === 'builtin' || requestedPipeline === 'direct')) {
    return { status: 'diagnosed', engine: engineArg, summary: `提供 unpackScript/repackScript 时 pipeline 不能设为 ${requestedPipeline}。未写入技能。` };
  }

  let chosenHit: ArchiveHit | null = null;
  let isCustom = false;
  let overrideBuiltin = false;
  let builtinCheck: ReturnType<typeof testBuiltinArchiveUnpackable> = {
    isBuiltinFormat: false,
    canUnpack: false,
    reason: '',
  };
  let directMode = false;
  let unpackedAbs = '';

  if (hasArchivePackers) {
    if (options.archive) {
      const resolvedArch = insideWorkspace(root, options.archive);
      if (!resolvedArch || isSymlinkPath(resolvedArch) || !fs.existsSync(resolvedArch) || !fs.statSync(resolvedArch).isFile()) {
        return { status: 'diagnosed', engine: engineArg, summary: `样本封包不存在或是符号链接：${options.archive}。未写入技能。` };
      }
      const relArch = path.relative(root, resolvedArch).replace(/\\/g, '/');
      if (!relArch || relArch.startsWith('..') || path.isAbsolute(relArch) || isBackupOrNonOriginalArchiveRel(relArch)) {
        return {
          status: 'diagnosed',
          engine: engineArg,
          summary: `样本封包「${options.archive}」位于内部临时、备份或非原始目录，拒绝作为学习样本以防伪造魔数或路径错位。请指定工作区内的原始游戏封包。未写入技能。`,
        };
      }
      const matched = scan.hits.filter((h) => path.resolve(root, h.path) === resolvedArch);
      const matchedBuiltin = matched.find((h) => BUILTIN_ARCHIVE_KINDS.has(h.kind) && h.extra?.override_builtin !== 1) ?? null;
      builtinCheck = testBuiltinArchiveUnpackable(resolvedArch, matchedBuiltin);
      const archStatForBuiltin = fs.statSync(resolvedArch);
      if (builtinCheck.isBuiltinFormat && builtinCheck.canUnpack && (archStatForBuiltin.size <= MAX_ARCHIVE_LEARN_BYTES || !options.sampleArchive?.trim())) {
        return { status: 'diagnosed', engine: engineArg, summary: '这些封包已有内置解包器，不改写成技能。未写入技能。' };
      }
      if (builtinCheck.isBuiltinFormat && !builtinCheck.canUnpack) {
        overrideBuiltin = true;
      }
      const targetEngine = engineArg || (matched[0]?.engine ?? '');
      if (!targetEngine) {
        return { status: 'diagnosed', engine: '', summary: '指定 --archive 学习未知封包时必须同时提供 --engine 引擎名。未写入技能。' };
      }
      if (RESERVED_ENGINES.has(targetEngine)) {
        return {
          status: 'diagnosed',
          engine: targetEngine,
          summary: overrideBuiltin
            ? `引擎 ${targetEngine} 为内置引擎保留名称，请改用自定义引擎名（如 ${targetEngine}-custom）注册项目级覆盖技能。未写入技能。`
            : `引擎 ${targetEngine} 为内置引擎保留名称，拒绝改写成技能。未写入技能。`,
        };
      }
      const exact = matched.find((h) => h.engine === targetEngine);
      if (exact && !overrideBuiltin) {
        chosenHit = exact;
      } else {
        isCustom = true;
        chosenHit = {
          engine: targetEngine,
          path: relArch,
          kind: overrideBuiltin && builtinCheck.builtinKind ? builtinCheck.builtinKind : deriveCustomKind(resolvedArch, options.suffix || ''),
          version: '',
          extra: overrideBuiltin ? { override_builtin: 1 } : {},
        };
      }
    } else {
      const hits = scan.hits.filter((h) => !engineArg || h.engine === engineArg);
      const learnable = hits.filter((h) => !BUILTIN_ARCHIVE_KINDS.has(h.kind) && h.kind !== 'nscript' && !(h.engine === 'unity' && h.kind === 'serialized'));
      if (learnable.length > 0) {
        const names = Array.from(new Set(learnable.map((h) => h.engine))).sort();
        if (!engineArg && names.length > 1) {
          return { status: 'diagnosed', engine: '', summary: `有多个可学习的引擎（${names.join('、')}）。请用 --engine 指定一个。未写入技能。` };
        }
        chosenHit = learnable[0];
      } else {
        // Check if an unrecognized/failed builtin archive can be overridden with an explicit non-reserved engine
        const failedBuiltinHit =
          engineArg && !RESERVED_ENGINES.has(engineArg)
            ? scan.hits.find((h) => {
                if (!BUILTIN_ARCHIVE_KINDS.has(h.kind)) return false;
                const chk = testBuiltinArchiveUnpackable(path.join(root, h.path), h);
                return chk.isBuiltinFormat && !chk.canUnpack;
              })
            : undefined;
        if (failedBuiltinHit) {
          overrideBuiltin = true;
          isCustom = true;
          builtinCheck = { isBuiltinFormat: true, builtinKind: failedBuiltinHit.kind, canUnpack: false, reason: 'builtin failed' };
          chosenHit = {
            engine: engineArg,
            path: failedBuiltinHit.path,
            kind: failedBuiltinHit.kind,
            version: '',
            extra: { override_builtin: 1 },
          };
        } else {
          if (!hits.length) {
            return {
              status: 'diagnosed',
              engine: engineArg,
              summary: engineArg ? `没有引擎 ${engineArg} 的封包。未写入技能。` : '没有可以交给技能学习的封包。未写入技能。',
            };
          }
          return { status: 'diagnosed', engine: engineArg, summary: '这些封包已有内置解包器或不支持自定义脚本学习。未写入技能。' };
        }
      }
    }
  } else {
    const resolvedDir = insideWorkspace(root, options.unpackedDir!.trim());
    if (!resolvedDir || isSymlinkPath(resolvedDir) || !fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      return { status: 'diagnosed', engine: engineArg, summary: `解包分析目录不存在或不是目录：${options.unpackedDir}。未写入技能。` };
    }
    unpackedAbs = resolvedDir;
    let manifestEngine = '';
    const dirManifests = findUnpackManifests(resolvedDir);
    for (const mp of dirManifests) {
      try {
        const obj = JSON.parse(fs.readFileSync(mp, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
        const eng = typeof obj.engine === 'string' ? obj.engine.trim().toLowerCase() : '';
        if (eng && eng !== 'pe-zip') {
          manifestEngine = eng;
          break;
        }
      } catch {
        // ignore invalid manifest
      }
    }
    const matchingHits = scan.hits.filter((h) => (!engineArg || h.engine === engineArg) && (!options.archive || h.path === options.archive));
    const targetEngine = engineArg || manifestEngine || matchingHits[0]?.engine || '';
    if (!targetEngine || !isEngineName(targetEngine)) {
      return { status: 'diagnosed', engine: engineArg, summary: '无解包脚本学习时必须提供或可推断合法的 engine 引擎名。未写入技能。' };
    }
    const hasBuiltinHit = matchingHits.some((h) => BUILTIN_ARCHIVE_KINDS.has(h.kind));
    if (requestedPipeline === 'direct') {
      if (!options.extractScript?.trim() || !options.applyScript?.trim()) {
        return {
          status: 'diagnosed',
          engine: targetEngine,
          summary: 'direct 管道技能必须同时提供 extractScript 与 applyScript。未写入技能。',
        };
      }
      directMode = true;
    } else if (
      !requestedPipeline &&
      dirManifests.length === 0 &&
      !hasBuiltinHit &&
      Boolean(options.extractScript?.trim()) &&
      Boolean(options.applyScript?.trim())
    ) {
      directMode = true;
    }

    if (directMode) {
      const candDirectRel = path.relative(root, resolvedDir).replace(/\\/g, '/') || '.';
      if (candDirectRel !== '.' && isBackupOrNonOriginalArchiveRel(candDirectRel)) {
        return {
          status: 'diagnosed',
          engine: targetEngine,
          summary: `direct 模式学习目录「${candDirectRel}」位于内部临时或备份目录，会导致后续 vn_writeback 的 install_rel 错位。请直接指向工作区内的原始游戏目录后重试。未写入技能。`,
        };
      }
    }

    const matchedHit = matchingHits.find((h) => h.engine === targetEngine) ?? matchingHits[0];
    chosenHit = {
      engine: targetEngine,
      path: matchedHit?.path || path.relative(root, resolvedDir).replace(/\\/g, '/') || '.',
      kind: directMode ? 'direct' : matchedHit?.kind || 'builtin',
      version: matchedHit?.version || '',
      extra: matchedHit?.extra || {},
    };
  }

  const systemTextFiles = cleanStringList(options.systemTextFiles);
  let matchSpec: Record<string, unknown> | null = null;
  const archiveAbs = hasArchivePackers ? path.join(root, chosenHit.path) : '';
  const archiveStat = hasArchivePackers ? fs.statSync(archiveAbs) : null;
  let verifyArchiveAbs = archiveAbs;
  const sampleArchiveArg = (options.sampleArchive || '').trim();
  if (hasArchivePackers && sampleArchiveArg) {
    if (!archiveStat || archiveStat.size <= MAX_ARCHIVE_LEARN_BYTES) {
      return {
        status: 'diagnosed',
        engine: chosenHit.engine,
        summary: '真实封包 archive 未超过 64 MiB，请直接使用真实 archive 验证，无需传入 sampleArchive。未写入技能。',
      };
    }
    const sampleAbs = insideWorkspace(root, sampleArchiveArg);
    if (!sampleAbs || isSymlinkPath(sampleAbs) || !fs.existsSync(sampleAbs) || !fs.statSync(sampleAbs).isFile()) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: `子集样本 sampleArchive 不存在或是符号链接：${sampleArchiveArg}。未写入技能。` };
    }
    const sampleStat = fs.statSync(sampleAbs);
    if (sampleStat.size <= 0 || sampleStat.size > MAX_ARCHIVE_LEARN_BYTES) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: `sampleArchive 为空或超过 64 MiB 上限：${sampleArchiveArg}。未写入技能。` };
    }
    const realExt = path.extname(archiveAbs).toLowerCase();
    const sampleExt = path.extname(sampleAbs).toLowerCase();
    if (realExt !== sampleExt) {
      return {
        status: 'diagnosed',
        engine: chosenHit.engine,
        summary: `sampleArchive 扩展名（${sampleExt || '无'}）与真实 archive（${realExt || '无'}）不一致，拒绝校验。未写入技能。`,
      };
    }
    const magicOff = options.magicOffset ?? 0;
    const hex = (options.magicHex || '').replace(/\s+/g, '').toLowerCase();
    if (hex && (hex.length % 2 !== 0 || hex.length > 64 || !/^[0-9a-f]+$/.test(hex))) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: 'magic-hex 格式不合法。未写入技能。' };
    }
    const cmpLen = hex
      ? hex.length / 2
      : Math.min(16, archiveStat.size - magicOff, sampleStat.size - magicOff);
    if (cmpLen <= 0 || (!hex && cmpLen < Math.min(4, sampleStat.size))) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: 'sampleArchive 或真实 archive 长度不足以完成 magicOffset 处魔数比对。未写入技能。' };
    }
    const archMagic = Buffer.alloc(cmpLen);
    const sampleMagic = Buffer.alloc(cmpLen);
    const fdArch = fs.openSync(archiveAbs, 'r');
    try {
      if (fs.readSync(fdArch, archMagic, 0, cmpLen, magicOff) !== cmpLen) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: '读取真实 archive 魔数失败。未写入技能。' };
      }
    } finally {
      fs.closeSync(fdArch);
    }
    const fdSample = fs.openSync(sampleAbs, 'r');
    try {
      if (fs.readSync(fdSample, sampleMagic, 0, cmpLen, magicOff) !== cmpLen) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: '读取 sampleArchive 魔数失败。未写入技能。' };
      }
    } finally {
      fs.closeSync(fdSample);
    }
    if (!archMagic.equals(sampleMagic)) {
      return {
        status: 'diagnosed',
        engine: chosenHit.engine,
        summary: `sampleArchive 在偏移 ${magicOff} 处的魔数与真实 archive 不一致（${sampleMagic.toString('hex')} != ${archMagic.toString('hex')}），拒绝作为大封包校验样本。未写入技能。`,
      };
    }
    if (builtinCheck.isBuiltinFormat && builtinCheck.canUnpack) {
      const sampleBuiltin = testBuiltinArchiveUnpackable(sampleAbs);
      if (sampleBuiltin.isBuiltinFormat && sampleBuiltin.canUnpack) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: '这些封包已有内置解包器，不改写成技能。未写入技能。' };
      }
      overrideBuiltin = true;
      isCustom = true;
      chosenHit.kind = sampleBuiltin.builtinKind || builtinCheck.builtinKind || chosenHit.kind;
      chosenHit.extra = { ...(chosenHit.extra || {}), override_builtin: 1 };
    }
    verifyArchiveAbs = sampleAbs;
  }

  if (hasArchivePackers && (isCustom || overrideBuiltin || (options.suffix || '').trim() || (options.magicHex || '').trim())) {
    const magicOff = options.magicOffset ?? 0;
    const hex = (options.magicHex || '').replace(/\s+/g, '').toLowerCase();
    let magicBuf = Buffer.alloc(0);
    if (hex) {
      if (hex.length % 2 !== 0 || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: 'magic-hex 格式不合法。未写入技能。' };
      }
      magicBuf = Buffer.from(hex, 'hex');
      const fd = fs.openSync(archiveAbs, 'r');
      const actual = Buffer.alloc(magicBuf.length);
      try {
        fs.readSync(fd, actual, 0, magicBuf.length, magicOff);
      } finally {
        fs.closeSync(fd);
      }
      if (!actual.equals(magicBuf)) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: '样本封包在指定偏移处与 magic-hex 不一致。未写入技能。' };
      }
    }
    const ext = (options.suffix || '').trim() ? normalizeExt(options.suffix!) : path.extname(archiveAbs).toLowerCase();
    const extensions = ext && !(ext === '.exe' && magicBuf.length === 0) ? [ext] : [];
    if (!extensions.length && !magicBuf.length) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: '无扩展名未知封包至少需要提供 --suffix 或 --magic 识别特征。未写入技能。' };
    }
    matchSpec = {};
    if (extensions.length) matchSpec.extensions = extensions;
    if (magicBuf.length) {
      matchSpec.magic_hex = hex;
      if (magicOff) matchSpec.magic_offset = magicOff;
    }
  } else if (directMode) {
    const extRaw = (options.suffix || '').trim()
      ? normalizeExt(options.suffix!)
      : systemTextFiles.length
        ? path.extname(systemTextFiles[0]).toLowerCase()
        : '';
    const hex = (options.magicHex || '').replace(/\s+/g, '').toLowerCase();
    const magicOff = options.magicOffset ?? 0;
    let magicBuf = Buffer.alloc(0);
    if (hex) {
      if (hex.length % 2 !== 0 || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: 'magic-hex 格式不合法。未写入技能。' };
      }
      magicBuf = Buffer.from(hex, 'hex');
      if (systemTextFiles.length) {
        const sampleCand = insideWorkspace(unpackedAbs, systemTextFiles[0]);
        if (sampleCand && !isSymlinkPath(sampleCand) && fs.existsSync(sampleCand) && fs.statSync(sampleCand).isFile()) {
          const fd = fs.openSync(sampleCand, 'r');
          const actual = Buffer.alloc(magicBuf.length);
          try {
            fs.readSync(fd, actual, 0, magicBuf.length, magicOff);
          } finally {
            fs.closeSync(fd);
          }
          if (!actual.equals(magicBuf)) {
            return { status: 'diagnosed', engine: chosenHit.engine, summary: '直写样本文件在指定偏移处与 magic-hex 不一致。未写入技能。' };
          }
        }
      }
    }
    const extensions = extRaw && !(extRaw === '.exe' && magicBuf.length === 0) ? [extRaw] : [];
    if (extensions.length || magicBuf.length) {
      matchSpec = {};
      if (extensions.length) matchSpec.extensions = extensions;
      if (magicBuf.length) {
        matchSpec.magic_hex = hex;
        if (magicOff) matchSpec.magic_offset = magicOff;
      }
    }
  }

  const classifyProfile = (options.classifyProfile || '').trim().toLowerCase();
  if (classifyProfile && !['kag', 'renpy', 'plain'].includes(classifyProfile)) {
    return { status: 'diagnosed', engine: chosenHit.engine, summary: 'classify-profile 只能是 kag、renpy 或 plain。未写入技能。' };
  }
  let classifyExts: string[] = [];
  for (const raw of options.classifyExtensions || []) {
    for (const part of String(raw).split(',')) {
      if (!part.trim()) continue;
      const ext = normalizeExt(part);
      if (!classifyExts.includes(ext)) classifyExts.push(ext);
    }
  }
  const classifyTags: Record<string, string> = {};
  if (options.classifyTags) {
    for (const [tag, kind] of Object.entries(options.classifyTags)) {
      if (!IDENT_RE.test(tag)) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: `classifyTags 含有非法标签名：${tag}。未写入技能。` };
      }
      if (!VALID_CLASSIFY_KINDS.has(kind)) {
        return { status: 'diagnosed', engine: chosenHit.engine, summary: `classifyTags.${tag} 不是合法分类：${kind}。未写入技能。` };
      }
      classifyTags[tag] = kind;
    }
  }
  const classifyTextAttrs: string[] = [];
  for (const attr of options.classifyTextAttrs || []) {
    const trimmed = String(attr || '').trim();
    if (!trimmed) continue;
    if (!IDENT_RE.test(trimmed)) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: `classifyTextAttrs 含有非法属性名：${trimmed}。未写入技能。` };
    }
    if (!classifyTextAttrs.includes(trimmed)) classifyTextAttrs.push(trimmed);
  }
  // When extract.py handles binary containers and no text-script classify rules exist, drop binary extensions so vn_classify won't run the plain-text scanner over binaries.
  if (
    options.extractScript?.trim() &&
    !classifyProfile &&
    Object.keys(classifyTags).length === 0 &&
    classifyTextAttrs.length === 0 &&
    classifyExts.length > 0
  ) {
    classifyExts = classifyExts.filter((ext) => !BINARY_CLASSIFY_EXTS.has(ext));
  }
  const classifySpec: Record<string, unknown> | null =
    classifyProfile || classifyExts.length || Object.keys(classifyTags).length || classifyTextAttrs.length
      ? {
          ...(classifyProfile ? { profile: classifyProfile } : {}),
          ...(classifyExts.length ? { extensions: classifyExts } : {}),
          ...(Object.keys(classifyTags).length ? { tags: classifyTags } : {}),
          ...(classifyTextAttrs.length ? { text_attrs: classifyTextAttrs } : {}),
        }
      : null;

  const rasterUiAssets = cleanStringList(options.rasterUiAssets);
  const noteText = (options.note || '').trim();
  const systemTextSpec: Record<string, unknown> | null =
    systemTextFiles.length || rasterUiAssets.length || noteText
      ? {
          ...(systemTextFiles.length ? { files: systemTextFiles } : {}),
          ...(rasterUiAssets.length ? { raster_ui: rasterUiAssets } : {}),
          ...(noteText ? { notes: [noteText] } : {}),
        }
      : null;

  let unpackText = '';
  let repackText = '';
  let extractText = '';
  let applyText = '';
  try {
    if (hasArchivePackers) {
      unpackText = readLocalScript(root, options.unpackScript!);
      repackText = readLocalScript(root, options.repackScript!);
    }
    if (options.extractScript) extractText = readLocalScript(root, options.extractScript);
    if (options.applyScript) applyText = readLocalScript(root, options.applyScript);
  } catch (err) {
    return { status: 'diagnosed', engine: chosenHit.engine, summary: `${(err as Error).message}未写入技能。` };
  }

  if (options.requireWriteback && !applyText && !(classifySpec && classifySpec.profile)) {
    return {
      status: 'diagnosed',
      engine: chosenHit.engine,
      summary: '技能验证失败：必须提供 --apply 写回脚本或 --classify-profile 文本规则以完成原样/微改写回双重验证。未写入技能。',
    };
  }

  const encodingVal = (options.encoding || '').trim() || 'auto';
  let wsPatchCfg: ReturnType<typeof loadWorkspacePatchConfig> | null = null;
  try {
    wsPatchCfg = loadWorkspacePatchConfig(root);
  } catch {
    wsPatchCfg = null;
  }
  const verifyTargetEncoding =
    encodingVal !== 'auto'
      ? encodingVal
      : wsPatchCfg && wsPatchCfg.encoding !== 'auto'
        ? wsPatchCfg.encoding
        : '';
  const applyExtraEnv: Record<string, string> = {
    PAPERCUP_WORKSPACE: root,
    PAPERCUP_PATCH_OPTIONS_JSON: JSON.stringify(wsPatchCfg?.customOptions ?? {}),
    ...(verifyTargetEncoding ? { PAPERCUP_TARGET_ENCODING: verifyTargetEncoding } : {}),
  };
  const origArchive = hasArchivePackers
    ? (() => {
        const vst = fs.statSync(verifyArchiveAbs);
        if (!vst.size || vst.size > MAX_ARCHIVE_LEARN_BYTES) {
          return null;
        }
        return fs.readFileSync(verifyArchiveAbs);
      })()
    : Buffer.alloc(0);
  if (hasArchivePackers && !origArchive) {
    return {
      status: 'diagnosed',
      engine: chosenHit.engine,
      summary:
        archiveStat && archiveStat.size > MAX_ARCHIVE_LEARN_BYTES && !sampleArchiveArg
          ? '技能验证失败：真实封包超过 64 MiB，请提供工作区内 <= 64 MiB 且扩展名与魔数完全一致的 sampleArchive 完成往返校验。未写入技能。'
          : '技能验证失败：封包为空或超过 64 MiB。未写入技能。',
    };
  }
  const verifyArchiveBuf: Buffer = origArchive ?? Buffer.alloc(0);

  let extracted: Map<string, Buffer>;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-learn-'));
  try {
    let writebackVerified = false;
    let wbStats: WritebackRoundtripStats = { totalRows: 0, scenarioRows: 0, uiRows: 0, kindCounts: {} };
    if (hasArchivePackers) {
      const unpackPy = path.join(tmpDir, 'unpack.py');
      const repackPy = path.join(tmpDir, 'repack.py');
      fs.writeFileSync(unpackPy, unpackText, 'utf8');
      fs.writeFileSync(repackPy, repackText, 'utf8');

      const dest = path.join(tmpDir, 'out');
      fs.mkdirSync(dest);
      await runPythonScript(unpackPy, [verifyArchiveAbs, dest], dest, undefined, options.signal);
      extracted = snapshotDir(dest);
      fs.writeFileSync(path.join(dest, SKILL_MANIFEST), '{}\n', 'utf8');
      const rebuilt = path.join(tmpDir, 'rebuilt.bin');
      await runPythonScript(repackPy, [dest, rebuilt], dest, undefined, options.signal);
      if (isSymlinkPath(rebuilt) || !fs.existsSync(rebuilt) || fs.statSync(rebuilt).size <= 0) {
        throw new LearnError('回包没有写出封包');
      }
      const again = path.join(tmpDir, 'out2');
      fs.mkdirSync(again);
      await runPythonScript(unpackPy, [rebuilt, again], again, undefined, options.signal);
      if (!snapshotsEqual(snapshotDir(again), extracted)) {
        throw new LearnError('回包后再解包，文件内容不一致');
      }

      const positions = Array.from(new Set([0, Math.floor(verifyArchiveBuf.length / 2), verifyArchiveBuf.length - 1]));
      let anyChangedOrFailed = false;
      for (const idx of positions) {
        const mut = Buffer.from(verifyArchiveBuf);
        mut[idx] ^= 0x5a;
        const mutBin = path.join(tmpDir, `mut-${idx}.bin`);
        const mutOut = path.join(tmpDir, `mut-${idx}`);
        fs.writeFileSync(mutBin, mut);
        fs.mkdirSync(mutOut);
        try {
          await runPythonScript(unpackPy, [mutBin, mutOut], mutOut, undefined, options.signal);
          if (!snapshotsEqual(snapshotDir(mutOut), extracted)) {
            anyChangedOrFailed = true;
            break;
          }
        } catch {
          anyChangedOrFailed = true;
          break;
        }
      }
      if (!anyChangedOrFailed) {
        throw new LearnError('改一个字节后解包结果不变，脚本没有读取封包');
      }

      const wbOutcome = await verifyWritebackRoundtrip({
        tmpDir,
        engine: chosenHit.engine,
        prepareUnpackedDir: async (dir) => {
          await runPythonScript(unpackPy, [verifyArchiveAbs, dir], dir, undefined, options.signal);
        },
        baselineSnapshot: extracted,
        repackAndVerify: async (dir, rebuiltBin, outDir) => {
          fs.writeFileSync(path.join(dir, SKILL_MANIFEST), '{}\n', 'utf8');
          await runPythonScript(repackPy, [dir, rebuiltBin], dir, undefined, options.signal);
          await runPythonScript(unpackPy, [rebuiltBin, outDir], outDir, undefined, options.signal);
        },
        extractText,
        applyText,
        classifySpec,
        skipClassify: !classifySpec && Boolean(extractText) && Boolean(applyText),
        encoding: encodingVal === 'auto' ? '' : encodingVal,
        extraEnv: applyExtraEnv,
        signal: options.signal,
      });
      writebackVerified = wbOutcome.verified;
      wbStats = wbOutcome.stats;
    } else {
      const keepTargets = new Set<string>();
      for (const rel of systemTextFiles) {
        const norm = rel.trim().replace(/\\/g, '/').toLowerCase();
        if (!norm) continue;
        keepTargets.add(norm);
        keepTargets.add(path.posix.basename(norm));
      }
      const skipTopDirs =
        unpackedAbs === root
          ? new Set(['patch', 'unpacked', 'build', 'work', 'results', 'release', 'node_modules', '__pycache__', '.venv', 'venv'])
          : undefined;
      const baseStage = path.join(tmpDir, 'base_unpacked');
      copyAnalysisStageDir(unpackedAbs, baseStage, keepTargets, '', skipTopDirs);
      extracted = snapshotDir(baseStage);

      const wbOutcome = await verifyWritebackRoundtrip({
        tmpDir,
        engine: chosenHit.engine,
        prepareUnpackedDir: async (dir) => {
          copyAnalysisStageDir(unpackedAbs, dir, keepTargets, '', skipTopDirs);
        },
        baselineSnapshot: extracted,
        extractText,
        applyText,
        classifySpec,
        skipClassify: directMode || (!classifySpec && Boolean(extractText) && Boolean(applyText)),
        encoding: encodingVal === 'auto' ? '' : encodingVal,
        extraEnv: applyExtraEnv,
        signal: options.signal,
      });
      writebackVerified = wbOutcome.verified;
      wbStats = wbOutcome.stats;
    }

    // General VN completeness invariant: for full-extraction pipelines (skill / direct),
    // reject skills that extract many UI/system rows yet almost zero scenario dialogue (`say`)
    // unless explicitly confirmed with evidence (`confirmLowScenarioCoverage: true`).
    if (
      (hasArchivePackers || directMode) &&
      writebackVerified &&
      !options.confirmLowScenarioCoverage &&
      wbStats.totalRows >= LOW_SCENARIO_MIN_TOTAL_ROWS &&
      (wbStats.scenarioRows === 0 ||
        (wbStats.scenarioRows < LOW_SCENARIO_MIN_SAY_ROWS &&
          wbStats.scenarioRows / wbStats.totalRows < LOW_SCENARIO_MIN_SAY_RATIO))
    ) {
      const dist = Object.entries(wbStats.kindCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      throw new LearnError(
        `剧情覆盖率过低：共抽取 ${wbStats.totalRows} 行，但剧情轨（say）仅 ${wbStats.scenarioRows} 行（界面轨 ${wbStats.uiRows} 行；分类分布：${dist}）。` +
          `这通常意味着提取脚本只抽到了引擎字符串/UI/报错表，漏掉了混淆、压缩或独立存放的剧情消息区段。` +
          `请先在可执行文件/运行时中追溯实际对白加载与解码逻辑并补全 extract.py/apply.py；仅当已核验证实样本确无更多剧情文本时，才可显式传入 confirmLowScenarioCoverage=true 并在 note 中注明证据`
      );
    }

    if (!options.homeDir) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: '验证通过，但没有用户目录，未写入技能。' };
    }
    const skillName = `engine-${chosenHit.engine}`;
    const existingGlobal = loadEngineProfile(options.homeDir, chosenHit.engine);
    if (hasArchivePackers && existingGlobal && String(existingGlobal.pipeline || '').toLowerCase() === 'builtin') {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: '已有内置画像，拒绝覆盖。未写入技能。' };
    }
    const existingProjHarness = loadProjectHarnessEngineJson(root, options.homeDir);
    const existingProjMatches =
      existingProjHarness !== null &&
      String(existingProjHarness.name || '').trim().toLowerCase() === chosenHit.engine &&
      Boolean(existingProjHarness.skill);
    const skillDir = resolveWorkspacePaths(root).skillDir(skillName);
    const occupied =
      existingProjMatches ||
      ['SKILL.md', 'unpack.py', 'repack.py', 'extract.py', 'apply.py'].some((f) => fs.existsSync(path.join(skillDir, f)));
    if (occupied && !options.overwrite) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: '已有技能或画像。加 --overwrite 才会覆盖。未写入技能。' };
    }

    const pipelineMode = hasArchivePackers ? 'skill' : directMode ? 'direct' : 'builtin';
    const sampleSha =
      hasArchivePackers && archiveStat && archiveStat.size <= MAX_ARCHIVE_LEARN_BYTES ? sha256Hex(verifyArchiveBuf) : '';
    const wbMode = applyText ? 'skill_apply' : classifySpec ? 'builtin_apply' : 'unspecified';
    const declaredCustomEncodings: string[] = [];
    for (const rawEnc of options.customEncodings ?? []) {
      const cleaned = String(rawEnc || '').trim().toLowerCase();
      if (!cleaned) continue;
      if (!isSafeCustomEncodingName(cleaned)) {
        return {
          status: 'diagnosed',
          engine: chosenHit.engine,
          summary: `customEncodings 包含非法编码标识：${rawEnc}（仅允许字母/数字/._- 或 custom:<名称>）。未写入技能。`,
        };
      }
      if (!declaredCustomEncodings.includes(cleaned)) declaredCustomEncodings.push(cleaned);
    }
    const writebackSpec: Record<string, unknown> = {
      mode: wbMode,
      encoding: encodingVal,
      ...(declaredCustomEncodings.length ? { custom_encodings: declaredCustomEncodings } : {}),
      control_pattern: (options.controlPattern || '').trim(),
      repack_cmd: hasArchivePackers ? 'vn_repack' : directMode ? 'direct_apply' : `builtin_${chosenHit.kind}`,
      verified: writebackVerified,
    };

    const bodyParts: string[] = [];
    if (hasArchivePackers) {
      bodyParts.push(
        `Verified unpack, classification & writeback procedure for ${chosenHit.engine} (${chosenHit.kind}).\n\n` +
          'Container scripts: `unpack.py <archive> <dest_dir>` and `repack.py <source_dir> <dest_archive>`.\n' +
          'Ignore dotfiles (such as `.skill-manifest.json`) and `*.bak`; never overwrite the original archive.\n' +
          'Only active when `engine.json` pipeline is `skill` and SHA-256 digests match.'
      );
    } else if (directMode) {
      bodyParts.push(
        `Verified direct single-file / compiled script extraction & writeback skill for ${chosenHit.engine}.\n\n` +
          'No outer archive unpack/repack needed: skip `vn_unpack`, run `vn_classify` -> `vn_writeback` (clones a clean independent game copy and executes `apply.py`).'
      );
    } else {
      bodyParts.push(
        `Verified post-unpack system-text & writeback analysis skill for ${chosenHit.engine} (container: ${chosenHit.kind}).\n\n` +
          'Container unpacking & repacking use Paper Cup built-in handlers (do NOT re-implement unpack.py/repack.py).'
      );
    }
    if (extractText) {
      bodyParts.push(`## Supplemental System Text Extraction\nRun via \`extract.py <unpacked_dir> <out_ui_jsonl>\` during \`vn_classify\` to merge engine-level UI/system lines into \`${WORKSPACE_BUILD_REL}/ui.jsonl\`.`);
    }
    bodyParts.push(
      applyText
        ? '## Custom Writeback\nCustom writeback script `apply.py <results_jsonl> <unpacked_dir>` handles safe formatting/escaping & target preservation during `vn_apply` / `vn_writeback`.'
        : `## Writeback Rule\n\`${JSON.stringify(writebackSpec)}\``
    );
    if (matchSpec) bodyParts.push(`## Container Signature Rule\n\`${JSON.stringify(matchSpec)}\``);
    if (classifySpec) bodyParts.push(`## Script Classification Rule\n\`${JSON.stringify(classifySpec)}\``);
    if (systemTextFiles.length || rasterUiAssets.length || noteText) {
      const sysLines = ['## Engine-Level System Text Rules'];
      if (systemTextFiles.length) {
        sysLines.push('### System Text Sources (UI Track)', ...systemTextFiles.map((s) => `- ${s}`));
      }
      if (rasterUiAssets.length) {
        sysLines.push(
          '### Raster / Image-Baked UI Assets (Do NOT Image-Translate)',
          ...rasterUiAssets.map((s) => `- ${s}`),
          '- Keep raster button/menu images untranslated unless the user explicitly enables image localization.'
        );
      }
      if (noteText) {
        sysLines.push('### Format Notes & Caveats', noteText);
      }
      bodyParts.push(sysLines.join('\n'));
    }
    const body = bodyParts.join('\n\n');

    const evidence =
      (hasArchivePackers
        ? `learn verified; extracted ${extracted.size} files; roundtrip matched; mutation changed output`
        : directMode
          ? `direct verified; checked ${extracted.size} files`
          : `post-unpack verified; checked ${extracted.size} files`) +
      (extractText ? '; extract.py verified' : '') +
      (writebackVerified ? '; identity+mutation writeback verified' : '');

    const publishedMd =
      [
        '---',
        `name: ${skillName}`,
        `description: Verified ${hasArchivePackers ? 'unpack, system-text & writeback' : directMode ? 'direct script extraction & writeback' : 'system-text analysis & writeback'} skill for ${chosenHit.engine} (${chosenHit.kind}).`,
        'generated-by: vn_learn_skill',
        `generated-at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
        `source-engine: ${chosenHit.engine}`,
        `source-sample: ${chosenHit.path}`,
        ...(sampleSha ? [`source-sha256: ${sampleSha}`] : []),
        `evidence: ${evidence}`,
        '---',
        body.trim(),
        '',
      ].join('\n');

    const skillDigest = sha256Hex(Buffer.from(publishedMd, 'utf8'));
    const directRootRel = directMode ? path.relative(root, unpackedAbs).replace(/\\/g, '/') || '.' : '';
    const enginePayload: Record<string, unknown> = {
      name: chosenHit.engine,
      kinds: [chosenHit.kind],
      versions: chosenHit.version ? [chosenHit.version] : [],
      pipeline: pipelineMode,
      ...(overrideBuiltin ? { override_builtin: true } : {}),
      ...(directMode ? { direct_root: directRootRel } : {}),
      [SKILL_POINTER]: skillName,
      [SKILL_DIGEST]: skillDigest,
      ...(hasArchivePackers
        ? {
            [UNPACK_DIGEST]: sha256Hex(Buffer.from(unpackText, 'utf8')),
            [REPACK_DIGEST]: sha256Hex(Buffer.from(repackText, 'utf8')),
          }
        : {}),
      writeback: writebackSpec,
      ...(declaredCustomEncodings.length ? { custom_encodings: declaredCustomEncodings } : {}),
    };
    if (extractText) enginePayload[EXTRACT_DIGEST] = sha256Hex(Buffer.from(extractText, 'utf8'));
    if (applyText) enginePayload[APPLY_DIGEST] = sha256Hex(Buffer.from(applyText, 'utf8'));
    if (matchSpec) enginePayload.match = matchSpec;
    if (classifySpec) enginePayload.classify = classifySpec;
    if (systemTextSpec) enginePayload.system_text = systemTextSpec;
    const engineJsonText = JSON.stringify(enginePayload, null, 2) + '\n';

    if (options.dryRun) {
      return {
        status: 'dry-run',
        engine: chosenHit.engine,
        skill: skillName,
        digest: skillDigest,
        summary: `验证通过（${extracted.size} 个文件）。dry-run，未写入技能。`,
      };
    }

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), publishedMd, 'utf8');
    if (hasArchivePackers) {
      fs.writeFileSync(path.join(skillDir, 'unpack.py'), unpackText, 'utf8');
      fs.writeFileSync(path.join(skillDir, 'repack.py'), repackText, 'utf8');
    } else {
      fs.rmSync(path.join(skillDir, 'unpack.py'), { force: true });
      fs.rmSync(path.join(skillDir, 'repack.py'), { force: true });
    }
    if (extractText) fs.writeFileSync(path.join(skillDir, 'extract.py'), extractText, 'utf8');
    else fs.rmSync(path.join(skillDir, 'extract.py'), { force: true });
    if (applyText) fs.writeFileSync(path.join(skillDir, 'apply.py'), applyText, 'utf8');
    else fs.rmSync(path.join(skillDir, 'apply.py'), { force: true });

    const engRoot = projectHarnessDir(root, options.homeDir);
    const harnessUpdates: Record<string, string> = { 'engine.json': engineJsonText };
    if (!hasArchivePackers && systemTextSpec) {
      harnessUpdates['structure.md'] = publishedMd;
    }
    commitHarness(engRoot, harnessUpdates, noteText || `learn skill ${skillName}`);

    const harnessEngineJsonPath = path.join(engRoot, 'engine.json').replace(/\\/g, '/');
    const trackSummary =
      wbStats.totalRows > 0 ? `，样本抽取共 ${wbStats.totalRows} 行（剧情 ${wbStats.scenarioRows} / 界面 ${wbStats.uiRows}）` : '';
    return {
      status: 'adopted',
      engine: chosenHit.engine,
      skill: skillName,
      digest: skillDigest,
      summary: hasArchivePackers
        ? `已把 ${chosenHit.engine} 的解包与规则写成技能 ${skillName}（${extracted.size} 个文件，回包一致${trackSummary}）。pipeline 为 skill，vn_unpack 会执行技能目录里的脚本。SHA-256 ${skillDigest.slice(0, 12)}。（engine.json 已写入 harness 目录 ${harnessEngineJsonPath}，不在 .papercup/skills/${skillName}/ 下）`
        : directMode
          ? `已把 ${chosenHit.engine} 的直抽/直写脚本写成技能 ${skillName}（pipeline 为 direct，${extracted.size} 个样本文件，双写回校验通过${trackSummary}）。跳过 vn_unpack，直接走 vn_classify -> vn_writeback。SHA-256 ${skillDigest.slice(0, 12)}。（engine.json 已写入 harness 目录 ${harnessEngineJsonPath}，不在 .papercup/skills/${skillName}/ 下）`
          : `已把 ${chosenHit.engine} 的系统文本分析与写回写成技能 ${skillName}（${extracted.size} 个文件，双写回校验通过${trackSummary}）。SHA-256 ${skillDigest.slice(0, 12)}。（engine.json 已写入 harness 目录 ${harnessEngineJsonPath}，不在 .papercup/skills/${skillName}/ 下）`,
    };
  } catch (err) {
    if (err instanceof LearnError) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: `技能验证失败：${err.message}。未写入技能。` };
    }
    return { status: 'diagnosed', engine: chosenHit.engine, summary: `技能验证失败：${(err as Error).message}。未写入技能。` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface PromoteSkillOptions {
  overwrite?: boolean;
  dryRun?: boolean;
  exportDir?: string;
  includeTestFixture?: boolean;
}

export interface PromoteSkillResult {
  status: string;
  name: string;
  summary: string;
  targetDir?: string;
  strippedFields?: string[];
  files?: string[];
}

export function promoteSkill(
  workspace: string,
  homeDir: string | null,
  name: string,
  options: PromoteSkillOptions = {}
): PromoteSkillResult {
  const chosen = name.trim();
  if (!isEngineName(chosen) || chosen.length > 64) {
    throw new Error('技能名称不合法：需匹配 [a-z0-9]+(-[a-z0-9]+)*，最长 64 个字符');
  }
  const explicitExport = (options.exportDir || '').trim();
  if (!explicitExport && !homeDir) {
    throw new Error('提升技能到用户全局目录需要用户目录（或提供 exportDir 导出独立干净技能包）');
  }

  const sourceDir = resolveWorkspacePaths(workspace).skillDir(chosen);
  const sourceMd = path.join(sourceDir, 'SKILL.md');
  if (isSymlinkPath(sourceMd) || !fs.existsSync(sourceMd) || !fs.statSync(sourceMd).isFile()) {
    throw new Error(`项目级技能不存在：${sourceMd}。`);
  }

  const targetDir = explicitExport
    ? path.resolve(workspace, explicitExport)
    : path.join(homeDir!, 'skills', chosen);

  // Locate engine.json from co-located workspace skill dir first, then project harness
  let sourceEngineJson: Record<string, unknown> | null = null;
  const localEngineJsonPath = path.join(sourceDir, 'engine.json');
  if (!isSymlinkPath(localEngineJsonPath) && fs.existsSync(localEngineJsonPath) && fs.statSync(localEngineJsonPath).isFile()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localEngineJsonPath, 'utf8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        sourceEngineJson = parsed;
      }
    } catch {
      throw new Error(`项目级技能 engine.json 解析失败：${localEngineJsonPath}`);
    }
  }
  if (!sourceEngineJson && homeDir) {
    const projEngJsonPath = path.join(projectHarnessDir(workspace, homeDir), 'engine.json');
    if (!isSymlinkPath(projEngJsonPath) && fs.existsSync(projEngJsonPath) && fs.statSync(projEngJsonPath).isFile()) {
      try {
        const projObj = JSON.parse(fs.readFileSync(projEngJsonPath, 'utf8')) as Record<string, unknown>;
        const engName = typeof projObj.name === 'string' ? projObj.name.trim().toLowerCase() : '';
        if (engName && projObj.skill === chosen && isEngineName(engName)) {
          sourceEngineJson = projObj;
        }
      } catch {
        // ignore invalid harness engine.json
      }
    }
  }

  // Self-contained engine skill export/promotion with full sanitization & fresh SHA-256 digests
  if (sourceEngineJson) {
    const exported = exportSanitizedSkillPackage({
      sourceSkillDir: sourceDir,
      engineJson: sourceEngineJson,
      targetDir,
      overwrite: Boolean(options.overwrite),
      dryRun: Boolean(options.dryRun),
      includeTestFixture: options.includeTestFixture ?? true,
    });
    const strippedNote = exported.strippedFields.length
      ? `已自动脱敏剥离：${exported.strippedFields.join('、')}。`
      : '';
    const filesNote = exported.files.length ? `包含文件：${exported.files.join('、')}。` : '';
    if (options.dryRun) {
      return {
        status: 'dry-run',
        name: chosen,
        targetDir: exported.targetDir,
        strippedFields: exported.strippedFields,
        files: exported.files,
        summary: `dry-run，未写入 ${exported.targetDir}。${filesNote}${strippedNote}`,
      };
    }
    return {
      status: explicitExport ? 'exported' : 'promoted',
      name: chosen,
      targetDir: exported.targetDir,
      strippedFields: exported.strippedFields,
      files: exported.files,
      summary: explicitExport
        ? `已脱敏导出自包含技能包 ${chosen} 到 ${exported.targetDir}。${filesNote}${strippedNote}`
        : `已脱敏提升自包含技能包 ${chosen} 到 ${exported.targetDir}。${filesNote}${strippedNote}`,
    };
  }

  // Fallback for non-engine documentation skills (no engine.json)
  const rawMdText = fs.readFileSync(sourceMd, 'utf8');
  if (Buffer.byteLength(rawMdText, 'utf8') > 32 * 1024) throw new Error('技能全文超过 32 KiB，拒绝提升。');
  const { markdown: sanitizedMd, strippedFields } = sanitizeSkillMarkdownForExport(rawMdText);
  const targetMd = path.join(targetDir, 'SKILL.md');
  if (options.dryRun) {
    return {
      status: 'dry-run',
      name: chosen,
      targetDir,
      strippedFields,
      files: ['SKILL.md'],
      summary: `dry-run，未写入 ${targetMd}。`,
    };
  }
  if (fs.existsSync(targetMd) && !options.overwrite) {
    throw new Error(`用户级技能已存在：${targetMd}。加 --overwrite 才会覆盖。`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetMd, sanitizedMd, 'utf8');
  return {
    status: explicitExport ? 'exported' : 'promoted',
    name: chosen,
    targetDir,
    strippedFields,
    files: ['SKILL.md'],
    summary: `已提升 ${chosen} 到 ${targetMd}。`,
  };
}

/* ========================= Shared Staging Helpers ========================= */

export function copyTreeRecursive(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const full = path.join(srcDir, ent.name);
    if (isSymlinkPath(full)) continue;
    if (ent.isDirectory()) copyTreeRecursive(full, path.join(dstDir, ent.name));
    else if (ent.isFile()) fs.copyFileSync(full, path.join(dstDir, ent.name));
  }
}

function workspaceHasDirectSkillTargets(workspace: string, engineJson: Record<string, unknown>): string[] {
  const ws = realpathSafe(workspace);
  const sysText = engineJson.system_text;
  const targetFiles =
    sysText && typeof sysText === 'object' && !Array.isArray(sysText) && Array.isArray((sysText as Record<string, unknown>).files)
      ? ((sysText as Record<string, unknown>).files as unknown[])
          .filter((f): f is string => typeof f === 'string' && Boolean(f.trim()) && !f.includes('*'))
          .map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      : [];
  if (!targetFiles.length) return [];
  const found: string[] = [];
  for (const rel of targetFiles) {
    const cand = path.join(ws, rel);
    if (!isSymlinkPath(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      found.push(rel);
    }
  }
  if (found.length) return found;
  try {
    for (const ent of fs.readdirSync(ws, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || isBackupOrNonOriginalArchiveRel(ent.name)) continue;
      for (const rel of targetFiles) {
        const cand = path.join(ws, ent.name, rel);
        if (!isSymlinkPath(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          found.push(`${ent.name}/${rel}`);
        }
      }
      if (found.length) return found;
    }
  } catch {
    // ignore unreadable workspace
  }
  return found;
}

export function resolveReadyDirectSkill(
  workspace: string,
  homeDir: string | null,
  fallbackEngine = ''
): { engine: string; profile: Record<string, unknown>; applyPy: string } | null {
  const candidates: Array<{ engine: string; matchedPaths: string[]; explicit: boolean }> = [];
  const seen = new Set<string>();
  const addCandidate = (eng: string, matchedPaths: string[], explicit: boolean) => {
    const norm = eng.trim().toLowerCase();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    candidates.push({ engine: norm, matchedPaths, explicit });
  };

  const fb = fallbackEngine.trim().toLowerCase();
  if (fb) addCandidate(fb, [], true);
  const proj = loadProjectHarnessEngineJson(workspace, homeDir);
  const projName = typeof proj?.name === 'string' ? proj.name.trim().toLowerCase() : '';
  if (projName) addCandidate(projName, [], true);

  const scan = scanWorkspace(workspace, homeDir);
  const hitsByEngine = new Map<string, string[]>();
  for (const hit of scan.hits) {
    const eng = hit.engine.trim().toLowerCase();
    if (!eng) continue;
    const list = hitsByEngine.get(eng) ?? [];
    list.push(hit.path);
    hitsByEngine.set(eng, list);
  }
  for (const [eng, paths] of hitsByEngine.entries()) {
    addCandidate(eng, paths, true);
  }

  // Also discover global/repo/workspace self-contained direct skills matching files in this workspace
  for (const pkg of discoverSkillPackages(workspace, { homeDir })) {
    if (!pkg.engineJson || String(pkg.engineJson.pipeline || '').trim().toLowerCase() !== 'direct') continue;
    if (seen.has(pkg.engine.toLowerCase())) continue;
    const matched = workspaceHasDirectSkillTargets(workspace, pkg.engineJson);
    if (matched.length > 0) {
      addCandidate(pkg.engine, matched, false);
    }
  }

  for (const cand of candidates) {
    const prof = resolveEngineJson(workspace, cand.engine, homeDir);
    if (!prof || String(prof.pipeline || '').trim().toLowerCase() !== 'direct') continue;
    const binding = skillBinding(workspace, homeDir, cand.engine);
    if (binding.state === 'mismatch') {
      const reason = binding.errors?.length ? `（${binding.errors.join('；')}）` : '';
      throw new Error(`${cand.engine} 的技能 SHA-256 完整性校验失败，拒绝执行 direct 写回${reason}`);
    }
    if (binding.state !== 'ready' || !binding.directory) continue;
    const applyPy = path.join(binding.directory, 'apply.py');
    if (isSymlinkPath(applyPy) || !fs.existsSync(applyPy) || !fs.statSync(applyPy).isFile()) continue;

    // Dynamically bind direct_root at runtime when the skill package omits machine-local direct_root
    let runtimeProfile = prof;
    if (!String(prof.direct_root || '').trim()) {
      const pkg = findSkillPackageByEngine(cand.engine, workspace, { homeDir });
      if (pkg) {
        const dynamic = bindSkillToWorkspace(pkg, workspace, {
          matchedPaths: cand.matchedPaths.length ? cand.matchedPaths : hitsByEngine.get(cand.engine) ?? [],
          engineJsonOverride: prof,
        });
        runtimeProfile = dynamic.runtimeEngineJson;
      } else {
        const dynamicRoot = resolveDynamicDirectRoot(
          workspace,
          prof,
          cand.matchedPaths.length ? cand.matchedPaths : hitsByEngine.get(cand.engine) ?? []
        );
        runtimeProfile = { ...prof, ...(dynamicRoot ? { direct_root: dynamicRoot } : {}) };
      }
    }
    return { engine: cand.engine, profile: runtimeProfile, applyPy };
  }
  return null;
}

/* ========================= Local Git Checkpoints ========================= */

const DEFAULT_GITIGNORE = [
  '.git/',
  'patch/',
  '.env',
  '.env.*',
  '*.bak',
  '*.rpa',
  '*.xp3',
  '*.nsa',
  '*.sar',
  '*.pak',
  '*.pac',
  '*.ypf',
  '*.dat',
  '*.bin',
  '*.ain',
  '*.ald',
  '*.alm',
  '*.arc',
  '*.pfs',
  '*.pck',
  '*.wolf',
  '*.bgi',
  '*.wai',
  '*.exe',
  '*.dll',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.webp',
  '*.bmp',
  '*.tlg',
  '*.mp3',
  '*.ogg',
  '*.wav',
  '*.flac',
  '*.mp4',
  '*.wmv',
  '*.avi',
  '*.mpg',
  '*.mpeg',
  '*.webm',
  '*.zip',
  '*.7z',
  '*.rar',
  '.papercup/tmp/',
  `${WORKSPACE_CHECKPOINTS_REL}`,
  '.papercup_backup/',
  '',
].join('\n');

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 15000 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new CheckpointError((e.stderr || e.message || String(err)).trim());
  }
}

export async function ensureLocalGitRepo(workspace: string): Promise<string> {
  const ws = realpathSafe(workspace);
  const gitDir = path.join(ws, '.git');
  if (!fs.existsSync(gitDir)) {
    await runGit(['init'], ws);
    await runGit(['config', 'user.name', 'Paper Cup'], ws);
    await runGit(['config', 'user.email', 'local@papercup.invalid'], ws);
  }
  const gi = path.join(ws, '.gitignore');
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, DEFAULT_GITIGNORE, 'utf8');
  }
  return gitDir;
}

export function listCheckpoints(workspace: string): Array<Record<string, unknown>> {
  const p = path.join(workspace, CHECKPOINTS_REL);
  if (isSymlinkPath(p) || !fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as { checkpoints?: unknown };
    return Array.isArray(data.checkpoints) ? (data.checkpoints as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

export async function createCheckpoint(
  workspace: string,
  stage: string,
  summary: string,
  qaVerified = false
): Promise<{ commit: string; stage: string; summary: string; qa_verified: boolean; skipped_clean: boolean; timestamp: string }> {
  const ws = realpathSafe(workspace);
  const wsPaths = resolveWorkspacePaths(ws);
  await ensureLocalGitRepo(ws);
  const targets: string[] = [];
  for (const rel of [
    '.gitignore',
    'papercup.toml',
    WORKSPACE_BUILD_REL,
    WORKSPACE_RESULTS_REL,
    WORKSPACE_RELEASE_REL,
    WORKSPACE_LOGS_REL,
  ]) {
    if (fs.existsSync(path.join(ws, rel))) targets.push(rel);
  }
  const vnMetaDir = wsPaths.vnDir;
  if (!isSymlinkPath(vnMetaDir) && fs.existsSync(vnMetaDir) && fs.statSync(vnMetaDir).isDirectory()) {
    for (const ent of fs.readdirSync(vnMetaDir, { withFileTypes: true })) {
      if (ent.name === 'checkpoints.json') continue;
      targets.push(`${WORKSPACE_VN_REL}/${ent.name}`);
    }
  }
  if (targets.length) {
    await runGit(['add', '--', ...targets], ws);
  }
  const { stdout: stagedOut } = await runGit(['diff', '--cached', '--name-only'], ws);
  let commitHash = '';
  let skippedClean = false;
  if (!stagedOut.trim()) {
    skippedClean = true;
    try {
      const { stdout: head } = await runGit(['rev-parse', '--short', 'HEAD'], ws);
      commitHash = head.trim();
    } catch {
      commitHash = 'none';
    }
  } else {
    await runGit(['commit', '-m', `[${stage}] ${summary}`], ws);
    const { stdout: head } = await runGit(['rev-parse', '--short', 'HEAD'], ws);
    commitHash = head.trim();
  }

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const existing = listCheckpoints(ws);
  existing.push({
    commit: commitHash,
    stage,
    summary,
    qa_verified: qaVerified,
    skipped_clean: skippedClean,
    timestamp: ts,
  });
  const cpPath = path.join(ws, CHECKPOINTS_REL);
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({ schema: 1, checkpoints: existing }, null, 2) + '\n', 'utf8');
  return { commit: commitHash, stage, summary, qa_verified: qaVerified, skipped_clean: skippedClean, timestamp: ts };
}

export async function rollbackCheckpoint(workspace: string, commitRef: string): Promise<string> {
  const ws = realpathSafe(workspace);
  const ref = commitRef.trim();
  if (!ref) throw new CheckpointError('vn checkpoint rollback 需要 --commit。');
  const { stdout: resolved } = await runGit(['rev-parse', '--short', ref], ws);
  const restorePaths = [WORKSPACE_VN_REL, WORKSPACE_BUILD_REL, WORKSPACE_RESULTS_REL, WORKSPACE_RELEASE_REL].filter((p) =>
    fs.existsSync(path.join(ws, p))
  );
  if (restorePaths.length) {
    await runGit(['checkout', resolved.trim(), '--', ...restorePaths], ws);
  }
  return resolved.trim();
}

/* ========================= Acceptance & Release ========================= */

export interface AcceptanceFinding {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface AcceptanceResult {
  ok: boolean;
  blocked: boolean;
  findings: AcceptanceFinding[];
  record: Record<string, unknown> | null;
}

export function delegatedReport(
  workspace: string,
  profile: LocalizationProfile,
  memory: ProjectMemory,
  resultsPath: string,
  track: string,
  quality: string,
  options: { homeDir?: string | null; controlPattern?: string | null } = {}
): Record<string, unknown> | null {
  if (!TRACKS.includes(track as TrackName)) throw new AcceptanceError('报告轨道只能是 scenario 或 ui。');
  const source = insideWorkspace(workspace, resultsPath);
  if (!source || isSymlinkPath(source) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new AcceptanceError(`译文结果必须是工作区内的普通文件：${resultsPath}`);
  }
  const controlPattern =
    options.controlPattern !== undefined
      ? options.controlPattern
      : resolveWorkspaceControlPattern(workspace, options.homeDir);
  const payload = fs.readFileSync(source);
  const text = payload.toString('utf8').replace(/^\uFEFF/, '');
  const records: Array<Record<string, unknown>> = [];
  const seenIds = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(l) as Record<string, unknown>;
    } catch (err) {
      throw new AcceptanceError(`译文结果第 ${i + 1} 行不是 JSON：${(err as Error).message}`);
    }
    const idVal = item.id !== undefined ? String(item.id).trim() : '';
    if (idVal) {
      if (seenIds.has(idVal)) throw new AcceptanceError(`译文结果第 ${i + 1} 行 id 重复：${idVal}`);
      seenIds.add(idVal);
    }
    if (typeof item.source !== 'string' || !item.source.trim()) throw new AcceptanceError(`译文结果第 ${i + 1} 行缺少非空 source。`);
    if (typeof item.target !== 'string' || !item.target.trim()) throw new AcceptanceError(`译文结果第 ${i + 1} 行缺少非空 target。`);
    if (item.target.includes('\n') || item.target.includes('\r')) throw new AcceptanceError(`译文结果第 ${i + 1} 行的译文含换行。`);
    if (item.ok !== true) throw new AcceptanceError(`译文结果第 ${i + 1} 行 ok 不是 true；QA 未过的段落不能写入报告。`);
    if (item.track !== undefined && item.track !== track) {
      throw new AcceptanceError(`译文结果第 ${i + 1} 行是 ${String(item.track)}，与 --track ${track} 不一致。`);
    }
    records.push(item);
  }
  if (!records.length) return null;

  const qaErrors: string[] = [];
  records.forEach((rec, idx) => {
    const rep = qaReport(String(rec.source), String(rec.target), profile, memory.glossary, { controlPattern });
    if (rep.blocked) {
      const msg = rep.findings.filter((f) => f.severity === 'error').map((f) => `[${f.rule}] ${f.message}`).join('；');
      qaErrors.push(`${idx + 1}. ${msg}`);
    }
  });
  if (qaErrors.length) throw new AcceptanceError('译文未通过 QA，未写报告：\n' + qaErrors.slice(0, 20).join('\n'));

  return {
    schema: 2,
    model: 'translator',
    track,
    profile_digest: profileDigest(profile),
    memory_digest: memoryDigest(memory),
    persona_digest: personaDigest(memory.persona),
    quality,
    segments: { total: records.length, passed: records.length, failed: 0 },
    output: {
      path: displayRel(source, workspace),
      sha256: sha256Hex(payload),
      bytes: payload.length,
    },
  };
}

export function validateAcceptance(
  workspace: string,
  homeDir: string | null,
  profile: LocalizationProfile,
  memory: ProjectMemory,
  archivePath: string,
  options: { report?: Record<string, unknown> | null; reportPath?: string | null; allowNoResidueCheck?: boolean; allowSkipSmoke?: boolean } = {}
): AcceptanceResult {
  const ws = realpathSafe(workspace);
  const findings: AcceptanceFinding[] = [];
  const add = (rule: string, severity: 'error' | 'warning', message: string) => findings.push({ rule, severity, message });

  let report = options.report ?? null;
  if (!report) {
    if (!options.reportPath) {
      add('accept.report.missing', 'error', '验收需要翻译报告，或 --track 与 translator 的结果 JSONL。');
      return { ok: false, blocked: true, findings, record: null };
    }
    const rp = insideWorkspace(ws, options.reportPath);
    if (!rp || isSymlinkPath(rp) || !fs.existsSync(rp) || !fs.statSync(rp).isFile()) {
      add('accept.report.missing', 'error', `翻译报告必须在工作区内且为普通文件：${options.reportPath}`);
      return { ok: false, blocked: true, findings, record: null };
    }
    report = JSON.parse(fs.readFileSync(rp, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  }

  if (report.schema !== 2) {
    add('accept.report.invalid', 'error', '翻译报告 schema 必须是 2。');
    return { ok: false, blocked: true, findings, record: null };
  }
  const track = String(report.track || '');
  if (!TRACKS.includes(track as TrackName)) {
    add('accept.track.invalid', 'error', '翻译报告是混轨或未标注轨道。');
    return { ok: false, blocked: true, findings, record: null };
  }
  if (report.profile_digest !== profileDigest(profile)) add('accept.profile.stale', 'error', '报告生成后本地化 profile 已变更；先重新翻译。');
  if (report.memory_digest !== memoryDigest(memory)) add('accept.memory.stale', 'error', '报告生成后术语表、人设或教训已变更；先重新翻译。');
  if (report.persona_digest !== personaDigest(memory.persona)) add('accept.persona.stale', 'error', '报告生成后人设的阶段或转折已变更；先重新翻译。');
  const reportQuality = String(report.quality || '');
  if (reportQuality === 'degraded') {
    add('accept.quality', 'error', '翻译质量标记为 degraded；修复 profile 或记忆错误后重新翻译。');
  } else if (reportQuality === 'unreviewed') {
    add('accept.quality.unreviewed', 'warning', '当前未配置术语表或人设记忆（quality=unreviewed），建议补充以提升一致性。');
  } else if (reportQuality !== 'ok') {
    add('accept.quality', 'error', `翻译质量标记无效：${reportQuality || '(空)'}；补齐术语表与记忆后重新翻译。`);
  }
  if (!profile.residueCheck) {
    if (!options.allowNoResidueCheck) {
      add('accept.residue.disabled', 'error', 'profile 设置了 residue_check=false；请恢复或传 --allow-no-residue-check。');
    } else {
      add('accept.residue.disabled_override', 'warning', '已显式绕过 residue_check=false 门禁。');
    }
  }

  const segs = (report.segments && typeof report.segments === 'object' ? report.segments : {}) as Record<string, unknown>;
  const total = Number(segs.total ?? 0);
  const passed = Number(segs.passed ?? 0);
  const failed = Number(segs.failed ?? 0);
  if (total < 1 || passed + failed !== total) add('accept.segments.invalid', 'error', '报告的段落统计不完整或不合法。');
  else if (failed > 0) add('accept.segments.failed', 'error', `${failed} 段译文未通过；先修好并重新生成报告。`);

  const expectedTotal = manifestTrackCount(ws, track);
  if (expectedTotal !== null && expectedTotal > 0 && total > 0 && total < expectedTotal) {
    add('accept.coverage.incomplete', 'error', `${TRACK_LABELS[track]}仅覆盖 ${total}/${expectedTotal} 段。`);
  }

  const output = (report.output && typeof report.output === 'object' ? report.output : {}) as Record<string, unknown>;
  const outRel = String(output.path || '');
  const expectedDigest = String(output.sha256 || '').toLowerCase();
  const expectedBytes = Number(output.bytes ?? 0);
  const cand = outRel ? insideWorkspace(ws, outRel) : null;
  if (!cand || isSymlinkPath(cand) || !fs.existsSync(cand) || !fs.statSync(cand).isFile()) {
    add('accept.output.missing', 'error', `译文输出文件不存在：${outRel}`);
  } else {
    const outBuf = fs.readFileSync(cand);
    if (sha256Hex(outBuf) !== expectedDigest || outBuf.length !== expectedBytes) {
      add('accept.output.digest', 'error', '译文输出文件与报告的哈希不一致；重新生成报告。');
    }
  }

  let arch = insideWorkspace(ws, archivePath);
  let external = false;
  if (!arch) {
    if (!path.isAbsolute(archivePath)) add('accept.archive.outside', 'error', '回包必须在工作区内，或给出工作区外的绝对路径。');
    else {
      arch = realpathSafe(archivePath);
      external = true;
    }
  }
  let archiveRel = '';
  let archiveDigest = '';
  let archiveBytes = 0;
  let patchSummary: Record<string, unknown> | null = null;
  if (arch) {
    if (isSymlinkPath(arch) || !fs.existsSync(arch) || !fs.statSync(arch).isFile()) {
      add('accept.archive.missing', 'error', `回包或补丁清单不存在：${archivePath}`);
    } else {
      archiveRel = external ? arch.replace(/\\/g, '/') : displayRel(arch, ws);
      const ab = fs.readFileSync(arch);
      archiveDigest = sha256Hex(ab);
      archiveBytes = ab.length;
      if (archiveBytes <= 0) {
        add('accept.archive.empty', 'error', '回包是空文件。');
      } else if (path.basename(arch).toLowerCase() === 'patch_manifest.json') {
        let pm: Record<string, unknown> | null = null;
        try {
          pm = JSON.parse(ab.toString('utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
        } catch {
          add('accept.patch.invalid', 'error', '补丁清单 patch_manifest.json 不是合法 JSON。');
        }
        if (pm) {
          if (pm.schema !== 1 || pm.format !== 'papercup-delta-patch') {
            add('accept.patch.invalid', 'error', '补丁清单格式或 schema 版本无效（期望 schema=1, format=papercup-delta-patch）。');
          } else if (!Array.isArray(pm.artifacts) || pm.artifacts.length === 0) {
            add('accept.patch.empty', 'error', '补丁清单不包含任何有效产物（artifacts 为空）。');
          } else {
            const patchDir = path.dirname(arch);
            for (const item of pm.artifacts) {
              if (!item || typeof item !== 'object') {
                add('accept.patch.artifact_invalid', 'error', '补丁产物条目格式错误。');
                continue;
              }
              const rec = item as Record<string, unknown>;
              const pRel = typeof rec.patch_rel === 'string' ? rec.patch_rel.trim() : '';
              const iRel = typeof rec.install_rel === 'string' ? rec.install_rel.trim() : '';
              const expectedArtSha = typeof rec.sha256 === 'string' ? rec.sha256.trim().toLowerCase() : '';
              const expectedArtBytes = Number(rec.bytes ?? -1);
              if (!pRel || !iRel || !expectedArtSha || !Number.isFinite(expectedArtBytes) || expectedArtBytes <= 0) {
                add('accept.patch.artifact_invalid', 'error', `补丁产物元数据不完整：${pRel || '(空路径)'}`);
                continue;
              }
              try {
                staysInside('.', iRel);
              } catch {
                add('accept.patch.artifact_outside', 'error', `补丁安装目标路径越界：${iRel}`);
                continue;
              }
              const artFull = insideWorkspace(patchDir, pRel);
              if (!artFull || artFull === realpathSafe(patchDir)) {
                add('accept.patch.artifact_outside', 'error', `补丁产物路径越界或经由符号链接逃逸：${pRel}`);
                continue;
              }
              if (isSymlinkPath(artFull) || !fs.existsSync(artFull) || !fs.statSync(artFull).isFile()) {
                add('accept.patch.artifact_missing', 'error', `补丁产物不存在：${pRel}`);
                continue;
              }
              const artBuf = fs.readFileSync(artFull);
              if (artBuf.length !== expectedArtBytes || sha256Hex(artBuf) !== expectedArtSha) {
                add('accept.patch.artifact_digest', 'error', `补丁产物哈希或字节数与清单不一致：${pRel}`);
              }
            }
            patchSummary = {
              manifest: archiveRel,
              strategy: String(pm.strategy || ''),
              engine: String(pm.engine || ''),
              encoding: pm.encoding && typeof pm.encoding === 'object' ? pm.encoding : undefined,
              hook: pm.hook && typeof pm.hook === 'object' ? pm.hook : undefined,
              artifacts_count: pm.artifacts.length,
              changed_files_count: Array.isArray(pm.changed_files) ? pm.changed_files.length : 0,
            };
          }
        }
      }
    }
  }

  const hits = homeDir ? matchLibrary(ws, homeDir) : [];
  const mismatched = hits.filter((h) => h.status === 'mismatch');
  if (mismatched.length) {
    add('accept.l2.mismatch', 'error', `全局 L2 画像与工作区封包不一致：${mismatched.map((h) => h.engine).join('、')}`);
  } else if (!hits.some((h) => h.status === 'ready')) {
    add('accept.l2.absent', 'warning', '没有 ready 的 L2 证据；验收只覆盖译文与回包。');
  }

  const versions = listHarnessVersions(projectHarnessDir(ws, homeDir));
  const latestHarness = versions.length ? { version: versions[versions.length - 1].versionId, digest: versions[versions.length - 1].digest } : {};
  if (!versions.length) add('accept.harness.missing', 'warning', '项目还没有采纳过的支架版本。');

  // Optional hard gate: runtime smoke test verification when enabled in global smoke.json or [vn.smoke]
  const smokeCfg = getSmokeConfigState(ws, homeDir).effective;
  const smokeReport = readSmokeReport(ws);
  let smokeRecord: Record<string, unknown> | null = null;

  const isOverlayReport = smokeReport?.mode === 'overlay';
  const overlayMatchesArchive = Boolean(
    isOverlayReport &&
      !patchSummary &&
      archiveDigest &&
      Array.isArray(smokeReport?.overlayFiles) &&
      smokeReport.overlayFiles.some((f) => String(f.sha256 || '').toLowerCase() === archiveDigest.toLowerCase())
  );
  const manifestMatchesArchive = Boolean(
    !isOverlayReport &&
      patchSummary &&
      smokeReport?.patchManifestSha256 &&
      archiveDigest &&
      smokeReport.patchManifestSha256.toLowerCase() === archiveDigest.toLowerCase()
  );
  const manifestArtifactMatchesArchive = (() => {
    if (isOverlayReport || patchSummary || !smokeReport?.patchManifestPath || !smokeReport?.patchManifestSha256 || !archiveDigest) {
      return false;
    }
    try {
      const mp = path.resolve(smokeReport.patchManifestPath);
      if (isSymlinkPath(mp) || !fs.existsSync(mp) || !fs.statSync(mp).isFile()) return false;
      const raw = fs.readFileSync(mp);
      if (sha256Hex(raw).toLowerCase() !== smokeReport.patchManifestSha256.toLowerCase()) return false;
      const pm = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      if (!pm || !Array.isArray(pm.artifacts)) return false;
      return pm.artifacts.some(
        (a) =>
          a &&
          typeof a === 'object' &&
          String((a as Record<string, unknown>).sha256 || '').toLowerCase() === archiveDigest.toLowerCase()
      );
    } catch {
      return false;
    }
  })();
  const smokeTargetMatches = patchSummary ? manifestMatchesArchive : overlayMatchesArchive || manifestArtifactMatchesArchive;
  const buildSmokeRecord = (): Record<string, unknown> => ({
    ok: true,
    mode: isOverlayReport ? 'overlay' : 'manifest',
    ...(isOverlayReport && smokeReport?.overlayPath ? { overlayPath: smokeReport.overlayPath } : {}),
    ...(overlayMatchesArchive || manifestArtifactMatchesArchive ? { matchedSha256: archiveDigest } : {}),
    warningCount: smokeReport!.warningCount,
    stepsAdvanced: smokeReport!.stepsAdvanced,
    durationMs: smokeReport!.durationMs,
    usedTextractor: smokeReport!.usedTextractor,
    visionStatus: smokeReport!.vision?.status ?? 'skipped',
    createdAt: smokeReport!.createdAt,
  });

  if (smokeCfg.enabled) {
    if (options.allowSkipSmoke) {
      add('accept.smoke.skipped_override', 'warning', '已显式跳过运行时冒烟测试门禁（allowSkipSmoke=true）。');
      smokeRecord = { skipped_override: true };
    } else if (!smokeReport) {
      add(
        'accept.smoke.missing',
        'error',
        '已启用冒烟测试门禁，尚未运行 vn_smoke_test；请先运行 vn_smoke_test 验证补丁，或经用户确认传 allowSkipSmoke=true 跳过。'
      );
    } else if (!smokeTargetMatches) {
      add(
        'accept.smoke.stale',
        'error',
        patchSummary
          ? isOverlayReport
            ? '当前冒烟报告为免清单覆盖直测模式，与待验收的 patch_manifest.json 不匹配；请针对该 patch_manifest.json 运行 vn_smoke_test。'
            : '补丁清单在冒烟测试后已变更或缺少清单哈希，当前冒烟报告已过期；请重新运行 vn_smoke_test。'
          : isOverlayReport
            ? '待验收封包的 SHA-256 未命中最近一次覆盖直测冒烟报告（产物可能已变更）；请使用该文件或所在目录重新运行 vn_smoke_test(overlayPath=...)。'
            : '待验收独立封包的 SHA-256 未命中最近一次冒烟测试的覆盖文件或补丁清单产物；请针对该封包运行 vn_smoke_test(overlayPath=...)。'
      );
    } else if (!smokeReport.ok || smokeReport.errorCount > 0) {
      const errRules = smokeReport.findings
        .filter((f) => f.severity === 'error')
        .map((f) => f.ruleId)
        .join(', ');
      const offsetNote = smokeReport.crash?.faultOffset ? `，故障偏移 ${smokeReport.crash.faultOffset}` : '';
      add(
        'accept.smoke.failed',
        'error',
        `冒烟测试未通过（${smokeReport.errorCount} error：${errRules || 'unknown'}${offsetNote}）；先修复并重跑 vn_smoke_test，或经用户确认传 allowSkipSmoke=true 跳过。`
      );
    } else if (smokeReport.vision?.skippedByParam === true && !smokeReport.usedTextractor) {
      add(
        'accept.smoke.unverified',
        'error',
        '冒烟测试显式传入了 skipVision=true 且 Textractor 未捕获渲染文本，缺少有效的运行时画面/文本验证；请去掉 skipVision=true 重新运行 vn_smoke_test，或经用户确认传 allowSkipSmoke=true 跳过。'
      );
    } else {
      smokeRecord = buildSmokeRecord();
      if (smokeReport.warningCount > 0) {
        add(
          'accept.smoke.warnings',
          'warning',
          `冒烟测试通过但含 ${smokeReport.warningCount} 条 warning（${smokeReport.findings.filter((f) => f.severity === 'warning').map((f) => f.ruleId).join(', ')}）。`
        );
      }
    }
  } else if (smokeReport && smokeReport.ok && smokeTargetMatches) {
    smokeRecord = buildSmokeRecord();
  }

  const blocked = findings.some((f) => f.severity === 'error');
  if (blocked) return { ok: false, blocked: true, findings, record: null };

  const manifest = readManifest(ws);
  const manifestDigest = typeof manifest?.digest === 'string' ? manifest.digest : '';
  const archiveBlock: Record<string, unknown> = { path: archiveRel, sha256: archiveDigest, bytes: archiveBytes };
  if (external) archiveBlock.external = true;
  if (patchSummary) archiveBlock.format = 'papercup-delta-patch';

  const trackBlock: Record<string, unknown> = {
    path: outRel,
    sha256: expectedDigest,
    bytes: expectedBytes,
    segments: total,
    persona_digest: personaDigest(memory.persona),
    archive: archiveBlock,
    partial: applyPartial(ws, track),
  };
  if (expectedTotal !== null && expectedTotal > 0) trackBlock.expected_segments = expectedTotal;
  if (manifestDigest) trackBlock.manifest_digest = manifestDigest;

  const engineSet = new Set<string>(hits.filter((h) => h.status === 'ready').map((h) => h.engine));
  const patchEngine = patchSummary && typeof patchSummary.engine === 'string' ? patchSummary.engine.trim() : '';
  if (patchEngine) engineSet.add(patchEngine);
  const manifestEngine = manifest && typeof manifest.engine === 'string' ? manifest.engine.trim() : '';
  if (manifestEngine) engineSet.add(manifestEngine);

  const record: Record<string, unknown> = {
    schema: 2,
    accepted: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    model: String(report.model || ''),
    quality: reportQuality || 'ok',
    track,
    tracks: { [track]: trackBlock },
    translation: { path: outRel, sha256: expectedDigest, segments: total },
    archive: archiveBlock,
    profile: { digest: profileDigest(profile), memory_digest: memoryDigest(memory) },
    harness: latestHarness,
    engines: Array.from(engineSet).sort(),
    summary: patchSummary
      ? `已验收：${total} 段译文；补丁清单 ${archiveRel}（${Number(patchSummary.artifacts_count || 0)} 个产物）。`
      : `已验收：${total} 段译文；回包 ${archiveRel}。`,
  };
  if (patchSummary) record.patch = patchSummary;
  if (smokeRecord) record.smoke = smokeRecord;
  if (manifestDigest) record.manifest_digest = manifestDigest;
  if (!profile.residueCheck) record.residue_check = false;

  return { ok: true, blocked: false, findings, record };
}

export function readAcceptance(workspace: string): Record<string, unknown> | null {
  const p = path.join(workspace, ACCEPTANCE_REL);
  if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    return data && data.schema === 2 ? data : null;
  } catch {
    return null;
  }
}

export function mergeAcceptance(prev: Record<string, unknown> | null, next: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...next };
  if (!prev || prev.schema !== 2) return merged;
  if (JSON.stringify(prev.profile) !== JSON.stringify(next.profile)) return merged;
  if (prev.manifest_digest && next.manifest_digest && prev.manifest_digest !== next.manifest_digest) return merged;
  const tracks = { ...((prev.tracks as Record<string, unknown>) || {}), ...((next.tracks as Record<string, unknown>) || {}) };
  merged.tracks = tracks;
  const mergedEngines = Array.from(
    new Set([
      ...(Array.isArray(prev.engines) ? prev.engines.map((e) => String(e).trim()).filter(Boolean) : []),
      ...(Array.isArray(next.engines) ? next.engines.map((e) => String(e).trim()).filter(Boolean) : []),
    ])
  ).sort();
  if (mergedEngines.length) merged.engines = mergedEngines;
  if (!merged.patch && prev.patch) merged.patch = prev.patch;
  if (!merged.smoke && prev.smoke) merged.smoke = prev.smoke;
  return merged;
}

export function writeAcceptance(workspace: string, record: Record<string, unknown>): string {
  const p = path.join(workspace, ACCEPTANCE_REL);
  if (isSymlinkPath(p)) throw new AcceptanceError(`验收记录不能是符号链接：${p}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return p;
}

export function acceptanceState(workspace: string, profile: LocalizationProfile, memory: ProjectMemory): {
  state: 'accepted' | 'stale' | 'invalid' | 'none';
  record: Record<string, unknown> | null;
} {
  const ws = realpathSafe(workspace);
  const p = path.join(ws, ACCEPTANCE_REL);
  const record = readAcceptance(ws);
  if (!record) return { state: fs.existsSync(p) || isSymlinkPath(p) ? 'invalid' : 'none', record: null };
  const pBlock = (record.profile && typeof record.profile === 'object' ? record.profile : {}) as Record<string, unknown>;
  if (pBlock.digest !== profileDigest(profile) || pBlock.memory_digest !== memoryDigest(memory)) {
    return { state: 'stale', record };
  }
  const manifest = readManifest(ws);
  const curDigest = typeof manifest?.digest === 'string' ? manifest.digest : '';
  if (curDigest && record.manifest_digest && record.manifest_digest !== curDigest) {
    return { state: 'stale', record };
  }
  const applied = applyStatus(ws);
  const tracks = record.tracks as Record<string, unknown> | undefined;
  if (tracks && typeof tracks === 'object') {
    for (const [tName, val] of Object.entries(tracks)) {
      const tb = (val && typeof val === 'object' ? val : {}) as Record<string, unknown>;
      if (curDigest && tb.manifest_digest && tb.manifest_digest !== curDigest) return { state: 'stale', record };
      if (applied && applied.track === tName && applied.stale) return { state: 'stale', record };
      if (TRACKS.includes(tName as TrackName) && typeof tb.sha256 === 'string' && tb.sha256) {
        const rf = resolveWorkspacePaths(ws).resultsTrackFile(tName);
        if (isSymlinkPath(rf) || !fs.existsSync(rf) || !fs.statSync(rf).isFile()) {
          return { state: 'stale', record };
        }
        if (sha256Hex(fs.readFileSync(rf)) !== tb.sha256.toLowerCase()) {
          return { state: 'stale', record };
        }
      }
    }
  }
  return { state: 'accepted', record };
}

export function buildReleaseNote(
  profile: LocalizationProfile,
  memory: ProjectMemory,
  record: Record<string, unknown>,
  options: { note?: string; humanClaim?: string; track?: string } = {}
): string {
  const note = options.note || '';
  if (note.length > 1000) throw new ReleaseError('附加说明超过 1000 个字符。');
  const bad = FORBIDDEN_RELEASE_PHRASES.filter((p) => note.includes(p));
  if (bad.length) throw new ReleaseError(`附加说明包含不允许的措辞：${bad.join('、')}。`);

  const humanClaim = options.humanClaim || '';
  if (Buffer.byteLength(humanClaim, 'utf8') > 32 * 1024) {
    throw new ReleaseError('人工审核声明超过 32 KiB 上限。');
  }
  const badClaim = FORBIDDEN_RELEASE_PHRASES.filter((p) => humanClaim.includes(p));
  if (badClaim.length) {
    throw new ReleaseError(`人工审核声明包含不允许的措辞：${badClaim.join('、')}。`);
  }

  const translation = (record.translation as Record<string, unknown>) || {};
  const patchInfo = record.patch && typeof record.patch === 'object' ? (record.patch as Record<string, unknown>) : null;
  const patchEngFallback = patchInfo && typeof patchInfo.engine === 'string' && patchInfo.engine.trim() ? patchInfo.engine.trim() : '';
  const engines =
    Array.isArray(record.engines) && record.engines.length
      ? record.engines.join('、')
      : patchEngFallback || '未记录';
  const povLabels: Record<string, string> = { first: '第一人称', second: '第二人称', third: '第三人称', mixed: '混合视角', source: '跟随原文' };
  const pov = povLabels[profile.narrativePov] || profile.narrativePov;
  const lockedCharCount = Array.isArray(memory.characters) ? memory.characters.length : 0;
  const charSummarySuffix = lockedCharCount > 0 ? `；锁定角色：${lockedCharCount} 位` : '';

  const tracksObj = record.tracks && typeof record.tracks === 'object' ? (record.tracks as Record<string, unknown>) : null;
  let translationSummary = `${String(translation.path || '未记录')}（${Number(translation.segments || 0)} 段）`;
  if (tracksObj) {
    const orderedKeys = options.track
      ? [options.track].filter((k) => Boolean(tracksObj[k]))
      : TRACKS.filter((t) => Boolean(tracksObj[t]));
    const trackSummaries: Array<{ label: string; path: string; segments: number }> = [];
    for (const k of orderedKeys) {
      const tb = tracksObj[k];
      if (!tb || typeof tb !== 'object') continue;
      const rec = tb as Record<string, unknown>;
      const tPath = String(rec.path || '').trim();
      const segs = Number(rec.segments || 0);
      if (tPath || segs > 0) {
        trackSummaries.push({ label: TRACK_LABELS[k] || k, path: tPath || '未记录', segments: segs });
      }
    }
    if (trackSummaries.length > 1) {
      const totalSegs = trackSummaries.reduce((acc, s) => acc + s.segments, 0);
      translationSummary =
        trackSummaries.map((s) => `${s.label} ${s.path}（${s.segments} 段）`).join('｜') + `；共 ${totalSegs} 段`;
    } else if (trackSummaries.length === 1) {
      translationSummary = `${trackSummaries[0].path}（${trackSummaries[0].segments} 段）`;
    }
  }

  const lines = [
    '# AI 本地化补丁 / AI Localization Patch',
    '',
    '本补丁的译文由 Paper Cup 使用 AI 模型生成，并经过确定性检查与验收记录。',
    'The translations in this patch were produced with an AI model by Paper Cup and passed deterministic checks and an acceptance record.',
    '',
    '说明：本补丁不宣称达到人工校对质量。',
    'Note: this patch does not claim human-level proofreading quality.',
    '',
    '用途：仅供个人学习使用，请支持正版。',
    'Purpose: for personal study only; please support the official release.',
    '',
    '## 配置摘要',
    '',
    `- 模型：${String(record.model || '未记录')}`,
    `- 语言：${profile.sourceLang} -> ${profile.targetLang}`,
    `- 叙事视角：${pov}（${profile.narrativePov}）`,
    `- 术语表：${Object.keys(memory.glossary).length} 条；人设：${Object.keys(memory.persona).length} 条${charSummarySuffix}`,
    `- 译文：${translationSummary}`,
    `- 质量标记：${String(record.quality || '未记录')}`,
    `- 验收时间：${String(record.accepted || '未记录')}`,
    `- 引擎：${engines}`,
  ];
  if (patchInfo) {
    const strategy = String(patchInfo.strategy || 'delta_patch');
    const artCount = Number(patchInfo.artifacts_count || 0);
    const changedCount = Number(patchInfo.changed_files_count || 0);
    lines.push(`- 交付形态：增量补丁（策略 \`${strategy}\`，${artCount} 个产物，${changedCount} 个变更脚本）`);
    const enc = patchInfo.encoding && typeof patchInfo.encoding === 'object' ? (patchInfo.encoding as Record<string, unknown>) : null;
    if (enc && (enc.source_detected || enc.target)) {
      lines.push(`- 补丁编码：${String(enc.source_detected || '未知')} -> ${String(enc.target || '未知')}`);
    }
    const hook = patchInfo.hook && typeof patchInfo.hook === 'object' ? (patchInfo.hook as Record<string, unknown>) : null;
    if (hook && hook.needed === true) {
      lines.push(
        `- 编码/区域 Hook：需要（\`${String(hook.mode || 'win32_proxy')}\`，CP${Number(hook.codepage || 936)} / Charset ${Number(hook.charset || 134)}，配置 \`${String(hook.config_file || 'papercup_patch.ini')}\`）`
      );
    } else if (hook) {
      lines.push('- 编码/区域 Hook：无需额外 Hook（原生支持）');
    }
  }
  const smokeInfo = record.smoke && typeof record.smoke === 'object' ? (record.smoke as Record<string, unknown>) : null;
  if (smokeInfo) {
    if (smokeInfo.skipped_override === true) {
      lines.push('- 运行时冒烟测试：已显式跳过门禁（allowSkipSmoke=true）');
    } else if (smokeInfo.ok === true) {
      const warnCount = Number(smokeInfo.warningCount || 0);
      const steps = Number(smokeInfo.stepsAdvanced || 0);
      const modeLabel = smokeInfo.mode === 'overlay' ? '覆盖直测，' : '';
      lines.push(
        `- 运行时冒烟测试：通过（${modeLabel}推进 ${steps} 步，${warnCount} warning${smokeInfo.usedTextractor ? '，已启用 Textractor' : ''}${smokeInfo.visionStatus === 'checked' ? '，已启用视觉检查' : ''}）`
      );
    }
  }
  if (options.track) lines.push(`- 发布轨道：仅${TRACK_LABELS[options.track] || options.track}（显式降级）`);
  if (note.trim()) {
    lines.push('', '## 附加说明', '', note.trim());
  }
  if (options.humanClaim?.trim()) {
    lines.push('', '## 人工审核/润色声明', '', options.humanClaim.trim());
  }
  return lines.join('\n') + '\n';
}

export function writeRelease(workspace: string, outRel: string, content: string, overwrite = false): string {
  const dest = insideWorkspace(workspace, outRel);
  if (!dest) throw new ReleaseError('发布说明必须写在工作区内。');
  if (isSymlinkPath(dest) || (fs.existsSync(dest) && fs.statSync(dest).isDirectory())) {
    throw new ReleaseError(`发布路径无效：${outRel}`);
  }
  if (fs.existsSync(dest) && !overwrite) {
    throw new ReleaseError(`发布说明已存在：${outRel}。加 --overwrite 覆盖。`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  return dest;
}
