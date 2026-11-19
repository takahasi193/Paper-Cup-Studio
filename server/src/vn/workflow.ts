/**
 * High-level deterministic VN workflows:
 * - Unknown-engine skill verification, packaging & promotion (learn / promote)
 * - Independent export-copy writeback (never mutating original game files or workspace unpacked/)
 * - Local Git checkpoints
 * - Acceptance validation & AI-disclosed release notes
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  APPLY_DIGEST,
  BUILTIN_ARCHIVE_KINDS,
  EXTRACT_DIGEST,
  NO_UNPACKER_KINDS,
  NSA_MANIFEST,
  PEZIP_MANIFEST,
  REPACK_DIGEST,
  RPA_MANIFEST,
  SKILL_DIGEST,
  SKILL_MANIFEST,
  SKILL_POINTER,
  UNPACK_DIGEST,
  XP3_MANIFEST,
  commitHarness,
  findUnpackManifests,
  globalEnginesDir,
  isEngineName,
  listHarnessVersions,
  loadEngineProfile,
  matchLibrary,
  repackNsa,
  repackPeZip,
  repackRpa,
  repackXp3,
  resolveEngineJson,
  runPythonScript,
  scanWorkspace,
  sha256Hex,
  skillBinding,
  type ArchiveHit,
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
  readResultsJsonl,
  type TextLine,
  type TrackName,
} from './classify.js';
import {
  displayRel,
  insideWorkspace,
  isSymlinkPath,
  memoryDigest,
  personaDigest,
  profileDigest,
  projectHarnessDir,
  realpathSafe,
  type LocalizationProfile,
  type ProjectMemory,
} from './profile.js';
import { qaReport } from './qa.js';

const execFileAsync = promisify(execFile);

export const CHECKPOINTS_REL = '.papercup/vn/checkpoints.json';
export const ACCEPTANCE_REL = '.papercup/vn/acceptance.json';
export const DEFAULT_RELEASE_REL = 'release/README.md';
export const FORBIDDEN_RELEASE_PHRASES = ['人工汉化', '个人汉化', '汉化完成', '人工翻译完成'];

const MAX_ARCHIVE_LEARN_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACT_FILES = 8192;
const MAX_EXTRACT_FILE = 16 * 1024 * 1024;
const MAX_EXTRACT_TOTAL = 64 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;
const SECRET_PAIR_RE = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|cookie)\s*[=:]\s*\S+/i;
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

function unlinkBaksRecursive(dir: string): void {
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
const HEAVY_MEDIA_SUFFIXES = new Set([
  '.ogg', '.wav', '.mp3', '.flac', '.m4a', '.mp4', '.webm', '.avi', '.wmv', '.mkv', '.mpg', '.mov',
]);
const MAX_STAGE_MEDIA_BYTES = 1024 * 1024;

function copyAnalysisStageDir(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const full = path.join(srcDir, ent.name);
    if (isSymlinkPath(full)) continue;
    const out = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      copyAnalysisStageDir(full, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      const st = fs.statSync(full);
      if (HEAVY_MEDIA_SUFFIXES.has(ext) && st.size > MAX_STAGE_MEDIA_BYTES) {
        fs.writeFileSync(out, Buffer.alloc(0));
      } else {
        fs.copyFileSync(full, out);
      }
    }
  }
}

function parseExtractOutputJsonl(filePath: string, baseDir: string, existingIds: Set<string>): TextLine[] {
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
    const lineNum = typeof rec.line === 'number' && Number.isInteger(rec.line) && rec.line >= 1 ? rec.line : 0;
    const source = typeof rec.source === 'string' ? rec.source : '';
    if (!rel || !lineNum || !source.trim() || source.includes('\n') || source.includes('\r')) {
      throw new LearnError(`extract.py 第 ${idx + 1} 行缺少有效的 file / line / source。`);
    }
    const targetFile = insideWorkspace(baseDir, rel);
    if (!targetFile || isSymlinkPath(targetFile) || !fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
      throw new LearnError(`extract.py 引用了不存在或越界的脚本文件：${rel}`);
    }
    const kind = typeof rec.kind === 'string' && VALID_CLASSIFY_KINDS.has(rec.kind.trim()) ? rec.kind.trim() : 'system';
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
  archive?: string;
  unpackedDir?: string;
  unpackScript?: string;
  repackScript?: string;
  extractScript?: string;
  applyScript?: string;
  encoding?: string;
  controlPattern?: string;
  requireWriteback?: boolean;
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

async function verifyWritebackRoundtrip(params: {
  tmpDir: string;
  engine: string;
  prepareUnpackedDir: (destDir: string) => Promise<void>;
  baselineSnapshot: Map<string, Buffer>;
  repackAndVerify?: (srcDir: string, archiveOut: string, outDir: string) => Promise<void>;
  extractText: string;
  applyText: string;
  classifySpec: Record<string, unknown> | null;
  encoding: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { tmpDir, engine, prepareUnpackedDir, baselineSnapshot, repackAndVerify, extractText, applyText, classifySpec, encoding, signal } =
    params;
  if (!applyText && !(classifySpec && classifySpec.profile)) return false;

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
    await runPythonScript(applyPy, [idJsonl, dirId], dirId, undefined, signal);
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

  // 2) 1-line _WB mutation roundtrip
  const wsMut = path.join(tmpDir, 'ws_mut');
  const dirMut = path.join(wsMut, 'unpacked');
  fs.mkdirSync(dirMut, { recursive: true });
  await prepareUnpackedDir(dirMut);
  const mutTargetSource = idExtraRows[0] ?? idRows[0];
  const mutRow: Record<string, unknown> = { ...mutTargetSource, target: `${String(mutTargetSource.source)}_WB` };
  const mutJsonl = path.join(wsMut, 'mut.jsonl');
  fs.writeFileSync(mutJsonl, JSON.stringify(mutRow) + '\n', 'utf8');
  if (applyText) {
    await runPythonScript(applyPy, [mutJsonl, dirMut], dirMut, undefined, signal);
  } else {
    applyResults(wsMut, dirMut, [mutRow], permissiveProfile, permissiveMem, String(mutRow.track), {
      encoding: encoding || undefined,
    });
  }
  unlinkBaksRecursive(dirMut);
  if (repackAndVerify) {
    const rebuiltMut = path.join(tmpDir, 'wb_mut.bin');
    const againMut = path.join(tmpDir, 'wb_mut_out');
    fs.mkdirSync(againMut, { recursive: true });
    await repackAndVerify(dirMut, rebuiltMut, againMut);
    if (snapshotsEqual(snapshotDir(againMut), baselineSnapshot)) {
      throw new LearnError('微改单行写回并重打包后解包结果未发生任何变化，写回脚本未生效');
    }
  } else if (snapshotsEqual(snapshotDir(dirMut), baselineSnapshot)) {
    throw new LearnError('微改单行写回后文件内容未发生任何变化，写回未生效');
  }

  return true;
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
  let chosenHit: ArchiveHit | null = null;
  let isCustom = false;
  let unpackedAbs = '';

  if (hasArchivePackers) {
    if (options.archive) {
      const resolvedArch = insideWorkspace(root, options.archive);
      if (!resolvedArch || isSymlinkPath(resolvedArch) || !fs.existsSync(resolvedArch) || !fs.statSync(resolvedArch).isFile()) {
        return { status: 'diagnosed', engine: engineArg, summary: `样本封包不存在或是符号链接：${options.archive}。未写入技能。` };
      }
      const matched = scan.hits.filter((h) => path.resolve(root, h.path) === resolvedArch);
      for (const m of matched) {
        if (BUILTIN_ARCHIVE_KINDS.has(m.kind)) {
          return { status: 'diagnosed', engine: engineArg, summary: '这些封包已有内置解包器，不改写成技能。未写入技能。' };
        }
      }
      const targetEngine = engineArg || (matched[0]?.engine ?? '');
      if (!targetEngine) {
        return { status: 'diagnosed', engine: '', summary: '指定 --archive 学习未知封包时必须同时提供 --engine 引擎名。未写入技能。' };
      }
      if (RESERVED_ENGINES.has(targetEngine)) {
        return { status: 'diagnosed', engine: targetEngine, summary: `引擎 ${targetEngine} 为内置引擎保留名称，拒绝改写成技能。未写入技能。` };
      }
      const exact = matched.find((h) => h.engine === targetEngine);
      if (exact) {
        chosenHit = exact;
      } else {
        isCustom = true;
        chosenHit = {
          engine: targetEngine,
          path: path.relative(root, resolvedArch).replace(/\\/g, '/'),
          kind: deriveCustomKind(resolvedArch, options.suffix || ''),
          version: '',
          extra: {},
        };
      }
    } else {
      const hits = scan.hits.filter((h) => !engineArg || h.engine === engineArg);
      if (!hits.length) {
        return {
          status: 'diagnosed',
          engine: engineArg,
          summary: engineArg ? `没有引擎 ${engineArg} 的封包。未写入技能。` : '没有可以交给技能学习的封包。未写入技能。',
        };
      }
      const learnable = hits.filter((h) => !BUILTIN_ARCHIVE_KINDS.has(h.kind) && h.kind !== 'nscript' && !(h.engine === 'unity' && h.kind === 'serialized'));
      if (!learnable.length) {
        return { status: 'diagnosed', engine: engineArg, summary: '这些封包已有内置解包器或不支持自定义脚本学习。未写入技能。' };
      }
      const names = Array.from(new Set(learnable.map((h) => h.engine))).sort();
      if (!engineArg && names.length > 1) {
        return { status: 'diagnosed', engine: '', summary: `有多个可学习的引擎（${names.join('、')}）。请用 --engine 指定一个。未写入技能。` };
      }
      chosenHit = learnable[0];
    }
  } else {
    const resolvedDir = insideWorkspace(root, options.unpackedDir!.trim());
    if (!resolvedDir || isSymlinkPath(resolvedDir) || !fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      return { status: 'diagnosed', engine: engineArg, summary: `解包分析目录不存在或不是目录：${options.unpackedDir}。未写入技能。` };
    }
    unpackedAbs = resolvedDir;
    let manifestEngine = '';
    for (const mp of findUnpackManifests(resolvedDir)) {
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
      return { status: 'diagnosed', engine: engineArg, summary: '内置解包后分析学习必须提供或可推断合法的 engine 引擎名。未写入技能。' };
    }
    const matchedHit = matchingHits.find((h) => h.engine === targetEngine) ?? matchingHits[0];
    chosenHit = {
      engine: targetEngine,
      path: matchedHit?.path || path.relative(root, resolvedDir).replace(/\\/g, '/'),
      kind: matchedHit?.kind || 'builtin',
      version: matchedHit?.version || '',
      extra: matchedHit?.extra || {},
    };
  }

  let matchSpec: Record<string, unknown> | null = null;
  const archiveAbs = hasArchivePackers ? path.join(root, chosenHit.path) : '';
  if (hasArchivePackers && (isCustom || (options.suffix || '').trim() || (options.magicHex || '').trim())) {
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
  }

  const classifyProfile = (options.classifyProfile || '').trim().toLowerCase();
  if (classifyProfile && !['kag', 'renpy', 'plain'].includes(classifyProfile)) {
    return { status: 'diagnosed', engine: chosenHit.engine, summary: 'classify-profile 只能是 kag、renpy 或 plain。未写入技能。' };
  }
  const classifyExts: string[] = [];
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
  const classifySpec: Record<string, unknown> | null =
    classifyProfile || classifyExts.length || Object.keys(classifyTags).length || classifyTextAttrs.length
      ? {
          ...(classifyProfile ? { profile: classifyProfile } : {}),
          ...(classifyExts.length ? { extensions: classifyExts } : {}),
          ...(Object.keys(classifyTags).length ? { tags: classifyTags } : {}),
          ...(classifyTextAttrs.length ? { text_attrs: classifyTextAttrs } : {}),
        }
      : null;

  const systemTextFiles = cleanStringList(options.systemTextFiles);
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
  const origArchive = hasArchivePackers ? fs.readFileSync(archiveAbs) : Buffer.alloc(0);
  if (hasArchivePackers && (!origArchive.length || origArchive.length > MAX_ARCHIVE_LEARN_BYTES)) {
    return { status: 'diagnosed', engine: chosenHit.engine, summary: '技能验证失败：封包为空或超过 64 MiB。未写入技能。' };
  }

  let extracted: Map<string, Buffer>;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-learn-'));
  try {
    let writebackVerified = false;
    if (hasArchivePackers) {
      const unpackPy = path.join(tmpDir, 'unpack.py');
      const repackPy = path.join(tmpDir, 'repack.py');
      fs.writeFileSync(unpackPy, unpackText, 'utf8');
      fs.writeFileSync(repackPy, repackText, 'utf8');

      const dest = path.join(tmpDir, 'out');
      fs.mkdirSync(dest);
      await runPythonScript(unpackPy, [archiveAbs, dest], dest, undefined, options.signal);
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

      const positions = Array.from(new Set([0, Math.floor(origArchive.length / 2), origArchive.length - 1]));
      let anyChangedOrFailed = false;
      for (const idx of positions) {
        const mut = Buffer.from(origArchive);
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

      writebackVerified = await verifyWritebackRoundtrip({
        tmpDir,
        engine: chosenHit.engine,
        prepareUnpackedDir: async (dir) => {
          await runPythonScript(unpackPy, [archiveAbs, dir], dir, undefined, options.signal);
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
        encoding: encodingVal === 'auto' ? '' : encodingVal,
        signal: options.signal,
      });
    } else {
      const baseStage = path.join(tmpDir, 'base_unpacked');
      copyAnalysisStageDir(unpackedAbs, baseStage);
      extracted = snapshotDir(baseStage);

      writebackVerified = await verifyWritebackRoundtrip({
        tmpDir,
        engine: chosenHit.engine,
        prepareUnpackedDir: async (dir) => {
          copyAnalysisStageDir(unpackedAbs, dir);
        },
        baselineSnapshot: extracted,
        extractText,
        applyText,
        classifySpec,
        encoding: encodingVal === 'auto' ? '' : encodingVal,
        signal: options.signal,
      });
    }

    if (!options.homeDir) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: '验证通过，但没有用户目录，未写入技能。' };
    }
    const skillName = `engine-${chosenHit.engine}`;
    const existingGlobal = loadEngineProfile(options.homeDir, chosenHit.engine);
    if (hasArchivePackers && existingGlobal && String(existingGlobal.pipeline || '').toLowerCase() === 'builtin') {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: '已有内置画像，拒绝覆盖。未写入技能。' };
    }
    const existingLocal = resolveEngineJson(root, chosenHit.engine, options.homeDir);
    const skillDir = path.join(root, '.papercup', 'skills', skillName);
    const occupied =
      (hasArchivePackers && existingGlobal !== null) ||
      (!hasArchivePackers && existingLocal !== null && Boolean(existingLocal.skill)) ||
      ['SKILL.md', 'unpack.py', 'repack.py', 'extract.py', 'apply.py'].some((f) => fs.existsSync(path.join(skillDir, f)));
    if (occupied && !options.overwrite) {
      return { status: 'diagnosed', engine: chosenHit.engine, summary: '已有技能或画像。加 --overwrite 才会覆盖。未写入技能。' };
    }

    const sampleSha = hasArchivePackers ? sha256Hex(origArchive) : '';
    const wbMode = applyText ? 'skill_apply' : classifySpec ? 'builtin_apply' : 'unspecified';
    const writebackSpec = {
      mode: wbMode,
      encoding: encodingVal,
      control_pattern: (options.controlPattern || '').trim(),
      repack_cmd: hasArchivePackers ? 'vn_repack' : `builtin_${chosenHit.kind}`,
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
    } else {
      bodyParts.push(
        `Verified post-unpack system-text & writeback analysis skill for ${chosenHit.engine} (container: ${chosenHit.kind}).\n\n` +
          'Container unpacking & repacking use Paper Cup built-in handlers (do NOT re-implement unpack.py/repack.py).'
      );
    }
    if (extractText) {
      bodyParts.push('## Supplemental System Text Extraction\nRun via `extract.py <unpacked_dir> <out_ui_jsonl>` during `vn_classify` to merge engine-level UI/system lines into `build/ui.jsonl`.');
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
        : `post-unpack verified; checked ${extracted.size} files`) +
      (extractText ? '; extract.py verified' : '') +
      (writebackVerified ? '; identity+mutation writeback verified' : '');

    const publishedMd =
      [
        '---',
        `name: ${skillName}`,
        `description: Verified ${hasArchivePackers ? 'unpack, system-text & writeback' : 'system-text analysis & writeback'} skill for ${chosenHit.engine} (${chosenHit.kind}).`,
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
    const enginePayload: Record<string, unknown> = {
      name: chosenHit.engine,
      kinds: [chosenHit.kind],
      versions: chosenHit.version ? [chosenHit.version] : [],
      pipeline: hasArchivePackers ? 'skill' : 'builtin',
      [SKILL_POINTER]: skillName,
      [SKILL_DIGEST]: skillDigest,
      ...(hasArchivePackers
        ? {
            [UNPACK_DIGEST]: sha256Hex(Buffer.from(unpackText, 'utf8')),
            [REPACK_DIGEST]: sha256Hex(Buffer.from(repackText, 'utf8')),
          }
        : {}),
      writeback: writebackSpec,
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

    const engRoot = hasArchivePackers
      ? path.join(globalEnginesDir(options.homeDir), chosenHit.engine)
      : projectHarnessDir(root, options.homeDir);
    const harnessUpdates: Record<string, string> = { 'engine.json': engineJsonText };
    if (!hasArchivePackers && systemTextSpec) {
      harnessUpdates['structure.md'] = publishedMd;
    }
    commitHarness(engRoot, harnessUpdates, noteText || `learn skill ${skillName}`);

    return {
      status: 'adopted',
      engine: chosenHit.engine,
      skill: skillName,
      digest: skillDigest,
      summary: hasArchivePackers
        ? `已把 ${chosenHit.engine} 的解包与规则写成技能 ${skillName}（${extracted.size} 个文件，回包一致）。pipeline 为 skill，vn_unpack 会执行技能目录里的脚本。SHA-256 ${skillDigest.slice(0, 12)}。`
        : `已把 ${chosenHit.engine} 的系统文本分析与写回写成技能 ${skillName}（${extracted.size} 个文件，双写回校验通过）。SHA-256 ${skillDigest.slice(0, 12)}。`,
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

export function promoteSkill(
  workspace: string,
  homeDir: string | null,
  name: string,
  options: { overwrite?: boolean; dryRun?: boolean } = {}
): { status: string; name: string; summary: string } {
  if (!homeDir) throw new Error('提升技能需要用户目录');
  const chosen = name.trim();
  if (!isEngineName(chosen) || chosen.length > 64) {
    throw new Error('技能名称不合法：需匹配 [a-z0-9]+(-[a-z0-9]+)*，最长 64 个字符');
  }
  const sourceDir = path.join(workspace, '.papercup', 'skills', chosen);
  const sourceMd = path.join(sourceDir, 'SKILL.md');
  if (isSymlinkPath(sourceMd) || !fs.existsSync(sourceMd) || !fs.statSync(sourceMd).isFile()) {
    throw new Error(`项目级技能不存在：${sourceMd}。`);
  }
  const mdText = fs.readFileSync(sourceMd, 'utf8');
  if (Buffer.byteLength(mdText, 'utf8') > 32 * 1024) throw new Error('技能全文超过 32 KiB，拒绝提升。');
  if (containsSecret(mdText)) throw new Error('技能包含疑似凭据，拒绝提升。');
  if (/disable-model-invocation:\s*(?:true|yes|1)/i.test(mdText)) {
    throw new Error('草稿技能不能提升为用户级；先发布并补齐验证证据。');
  }

  const targetDir = path.join(homeDir, 'skills', chosen);
  const targetMd = path.join(targetDir, 'SKILL.md');
  if (options.dryRun) {
    return { status: 'dry-run', name: chosen, summary: `dry-run，未写入 ${targetMd}。` };
  }
  if (fs.existsSync(targetMd) && !options.overwrite) {
    throw new Error(`用户级技能已存在：${targetMd}。加 --overwrite 才会覆盖。`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetMd, mdText, 'utf8');
  const copied: string[] = [];
  for (const script of ['unpack.py', 'repack.py', 'extract.py', 'apply.py']) {
    const src = path.join(sourceDir, script);
    if (!isSymlinkPath(src) && fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(targetDir, script));
      copied.push(script);
    }
  }
  const projEngJsonPath = path.join(projectHarnessDir(workspace, homeDir), 'engine.json');
  if (!isSymlinkPath(projEngJsonPath) && fs.existsSync(projEngJsonPath) && fs.statSync(projEngJsonPath).isFile()) {
    try {
      const projObj = JSON.parse(fs.readFileSync(projEngJsonPath, 'utf8')) as Record<string, unknown>;
      const engName = typeof projObj.name === 'string' ? projObj.name.trim().toLowerCase() : '';
      if (engName && projObj.skill === chosen && isEngineName(engName)) {
        commitHarness(
          path.join(globalEnginesDir(homeDir), engName),
          { 'engine.json': fs.readFileSync(projEngJsonPath, 'utf8') },
          `promote skill ${chosen}`
        );
      }
    } catch {
      // ignore invalid harness engine.json
    }
  }
  return {
    status: 'promoted',
    name: chosen,
    summary: `已提升 ${chosen} 到 ${targetMd}。${copied.length ? `同时复制了 ${copied.join('、')}。` : ''}`,
  };
}

/* ========================= Export Copy Writeback ========================= */

const EXPORT_EXCLUDE_DIRS = new Set([
  '.git', '.hg', '.svn', '.papercup', 'node_modules', '__pycache__', '.venv', 'venv', 'unpacked', 'build', 'work', 'results', 'release',
]);

function copySkeletonRecursive(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const full = path.join(srcDir, ent.name);
    if (isSymlinkPath(full)) continue;
    if (ent.isDirectory()) {
      if (EXPORT_EXCLUDE_DIRS.has(ent.name.toLowerCase()) || ent.name.startsWith('.')) continue;
      copySkeletonRecursive(full, path.join(dstDir, ent.name));
    } else if (ent.isFile()) {
      if (ent.name === 'papercup.toml' || ent.name.endsWith('.bak')) continue;
      fs.copyFileSync(full, path.join(dstDir, ent.name));
    }
  }
}

function copyTreeRecursive(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const full = path.join(srcDir, ent.name);
    if (isSymlinkPath(full)) continue;
    if (ent.isDirectory()) copyTreeRecursive(full, path.join(dstDir, ent.name));
    else if (ent.isFile()) fs.copyFileSync(full, path.join(dstDir, ent.name));
  }
}

export async function writebackToIndependentCopy(
  workspace: string,
  profile: LocalizationProfile,
  memory: ProjectMemory,
  options: { homeDir?: string | null; dest?: string | null; unpackedRoot?: string | null; encoding?: string | null; force?: boolean; signal?: AbortSignal } = {}
): Promise<{ export_dir: string; writeback_mode: string; tracks_applied: Record<string, number>; repacked_archives: string[] }> {
  const ws = realpathSafe(workspace);
  const unpackedDir = options.unpackedRoot ? insideWorkspace(ws, options.unpackedRoot) : path.join(ws, 'unpacked');
  if (!unpackedDir || isSymlinkPath(unpackedDir) || !fs.existsSync(unpackedDir) || !fs.statSync(unpackedDir).isDirectory()) {
    throw new ExportCopyError('工作区还没有 unpacked/ 解包目录；先解包脚本再执行整套写回。');
  }

  let exportDir = options.dest
    ? path.resolve(options.dest)
    : path.join(path.dirname(ws), `${path.basename(ws) || 'workspace'}.translated-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
  exportDir = path.resolve(exportDir);
  const relToWs = path.relative(ws, exportDir);
  if (relToWs === '' || (!relToWs.startsWith('..') && !path.isAbsolute(relToWs))) {
    throw new ExportCopyError(`导出目录必须写在工作区之外：${exportDir}`);
  }
  if (fs.existsSync(exportDir)) {
    const ents = fs.readdirSync(exportDir);
    if (ents.length && !options.force) {
      throw new ExportCopyError(`导出目录已存在且非空：${exportDir}；换一个 --dest 或加 --force。`);
    }
  }

  // Determine available tracks with translations
  const trackFiles: Array<{ track: TrackName; file: string; rows: Array<Record<string, unknown>> }> = [];
  for (const track of TRACKS) {
    const expected = manifestTrackCount(ws, track);
    const resPath = path.join(ws, 'results', `${track}.jsonl`);
    if (expected !== null && expected > 0) {
      if (isSymlinkPath(resPath) || !fs.existsSync(resPath)) {
        throw new ExportCopyError(`${TRACK_LABELS[track]}需要 ${expected} 段译文，但缺少 results/${track}.jsonl。`);
      }
      const rows = readResultsJsonl(resPath);
      if (rows.length < expected) {
        throw new ExportCopyError(`${TRACK_LABELS[track]}仅覆盖 ${rows.length}/${expected} 段，拒绝写入独立副本。`);
      }
      trackFiles.push({ track, file: resPath, rows });
    } else if (!isSymlinkPath(resPath) && fs.existsSync(resPath) && fs.statSync(resPath).isFile()) {
      const rows = readResultsJsonl(resPath);
      if (rows.length) trackFiles.push({ track, file: resPath, rows });
    }
  }
  if (!trackFiles.length) {
    throw new ExportCopyError('results/ 目录下没有任何译文（scenario.jsonl / ui.jsonl）；先完成翻译再写回。');
  }

  const stageRoot = path.join(ws, '.papercup', 'tmp', `export-${process.pid}-${Date.now()}`);
  const stagedUnpacked = path.join(stageRoot, 'unpacked');
  fs.mkdirSync(stageRoot, { recursive: true });
  try {
    copyTreeRecursive(unpackedDir, stagedUnpacked);
    const manifests = findUnpackManifests(stagedUnpacked);
    if (!manifests.length) throw new ExportCopyError('解包目录中未找到封包清单，无法写回并重打包。');

    const manifestFallbackEngine = String(readManifest(ws)?.engine || '');
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

    const tracksApplied: Record<string, number> = {};
    const writebackMode = customApplyPy ? 'skill_apply' : 'builtin_apply';

    for (const tf of trackFiles) {
      if (customApplyPy) {
        // Validate QA deterministically before running custom apply.py
        for (const r of tf.rows) {
          if (r.ok !== true) throw new ExportCopyError(`${String(r.id || '段落')} 未通过 QA，拒绝导出。`);
          const rep = qaReport(String(r.source || ''), String(r.target || ''), profile, memory.glossary);
          if (rep.blocked) {
            throw new ExportCopyError(`QA 拦截：${rep.findings.map((f) => f.message).join('；')}`);
          }
        }
        await runPythonScript(customApplyPy, [tf.file, applyRoot], applyRoot, undefined, options.signal);
        tracksApplied[tf.track] = tf.rows.length;
      } else {
        const outcome = applyResults(ws, applyRoot, tf.rows, profile, memory, tf.track, { encoding: options.encoding });
        tracksApplied[tf.track] = outcome.applied;
      }
    }

    unlinkBaksRecursive(stagedUnpacked);
    copySkeletonRecursive(ws, exportDir);

    const repackedArchives: string[] = [];
    for (const m of manifests) {
      const mName = path.basename(m);
      const mDir = path.dirname(m);
      const mData = JSON.parse(fs.readFileSync(m, 'utf8')) as Record<string, unknown>;
      const orig = String(mData.source || '');
      let rel = orig ? path.relative(ws, realpathSafe(orig)) : path.basename(orig);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.basename(orig || 'archive.bin');
      const targetArchive = path.join(exportDir, rel);
      fs.mkdirSync(path.dirname(targetArchive), { recursive: true });

      if (mName === SKILL_MANIFEST) {
        const engine = String(mData.engine || '');
        const binding = options.homeDir ? skillBinding(ws, options.homeDir, engine) : { state: 'absent' as const };
        if (binding.state !== 'ready' || !binding.directory) {
          throw new ExportCopyError(`${engine} 的技能与画像不一致，拒绝回包。`);
        }
        await runPythonScript(path.join(binding.directory, 'repack.py'), [mDir, targetArchive], mDir, undefined, options.signal);
      } else if (mName === RPA_MANIFEST) {
        repackRpa(mDir, targetArchive);
      } else if (mName === XP3_MANIFEST) {
        repackXp3(mDir, targetArchive);
      } else if (mName === PEZIP_MANIFEST) {
        repackPeZip(mDir, targetArchive);
      } else if (mName === NSA_MANIFEST) {
        repackNsa(mDir, targetArchive);
      } else {
        throw new ExportCopyError(`不支持重打包的清单类型：${mName}`);
      }
      repackedArchives.push(targetArchive);
    }

    return {
      export_dir: exportDir,
      writeback_mode: writebackMode,
      tracks_applied: tracksApplied,
      repacked_archives: repackedArchives,
    };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

/* ========================= Local Git Checkpoints ========================= */

const DEFAULT_GITIGNORE = [
  '.git/',
  'unpacked/',
  '*.rpa',
  '*.xp3',
  '*.nsa',
  '*.sar',
  '*.pak',
  '*.ypf',
  '*.dat',
  '*.bin',
  '*.exe',
  '*.dll',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.webp',
  '*.mp3',
  '*.ogg',
  '*.wav',
  '*.mp4',
  '.papercup/diagnostics/',
  '.papercup/tmp/',
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
  await ensureLocalGitRepo(ws);
  const targets = ['.gitignore', 'papercup.toml', 'vn', '.papercup/vn', 'build', 'work', 'results', 'release'].filter((p) =>
    fs.existsSync(path.join(ws, p))
  );
  if (targets.length) {
    await runGit(['add', '--', ...targets], ws);
  }
  const { stdout: statusOut } = await runGit(['status', '--porcelain'], ws);
  let commitHash = '';
  let skippedClean = false;
  if (!statusOut.trim()) {
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
  const restorePaths = ['.papercup/vn', 'build', 'work', 'results', 'release'].filter((p) =>
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
  quality: string
): Record<string, unknown> | null {
  if (!TRACKS.includes(track as TrackName)) throw new AcceptanceError('报告轨道只能是 scenario 或 ui。');
  const source = insideWorkspace(workspace, resultsPath);
  if (!source || isSymlinkPath(source) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new AcceptanceError(`译文结果必须是工作区内的普通文件：${resultsPath}`);
  }
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
    const rep = qaReport(String(rec.source), String(rec.target), profile, memory.glossary);
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
  options: { report?: Record<string, unknown> | null; reportPath?: string | null; allowNoResidueCheck?: boolean } = {}
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
    const rp = insideWorkspace(ws, options.reportPath) || path.resolve(options.reportPath);
    if (isSymlinkPath(rp) || !fs.existsSync(rp) || !fs.statSync(rp).isFile()) {
      add('accept.report.missing', 'error', `翻译报告不存在或不是普通文件：${options.reportPath}`);
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
  if (report.quality !== 'ok') add('accept.quality', 'error', `翻译质量标记为 ${String(report.quality)}；补齐术语表与记忆后重新翻译。`);
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
  if (arch) {
    if (isSymlinkPath(arch) || !fs.existsSync(arch) || !fs.statSync(arch).isFile()) {
      add('accept.archive.missing', 'error', `回包不存在：${archivePath}`);
    } else {
      archiveRel = external ? arch.replace(/\\/g, '/') : displayRel(arch, ws);
      const ab = fs.readFileSync(arch);
      archiveDigest = sha256Hex(ab);
      archiveBytes = ab.length;
      if (archiveBytes <= 0) add('accept.archive.empty', 'error', '回包是空文件。');
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

  const blocked = findings.some((f) => f.severity === 'error');
  if (blocked) return { ok: false, blocked: true, findings, record: null };

  const manifest = readManifest(ws);
  const manifestDigest = typeof manifest?.digest === 'string' ? manifest.digest : '';
  const archiveBlock: Record<string, unknown> = { path: archiveRel, sha256: archiveDigest, bytes: archiveBytes };
  if (external) archiveBlock.external = true;

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

  const record: Record<string, unknown> = {
    schema: 2,
    accepted: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    model: String(report.model || ''),
    quality: 'ok',
    track,
    tracks: { [track]: trackBlock },
    translation: { path: outRel, sha256: expectedDigest, segments: total },
    archive: archiveBlock,
    profile: { digest: profileDigest(profile), memory_digest: memoryDigest(memory) },
    harness: latestHarness,
    engines: Array.from(new Set(hits.filter((h) => h.status === 'ready').map((h) => h.engine))).sort(),
    summary: `已验收：${total} 段译文；回包 ${archiveRel}。`,
  };
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
        const rf = path.join(ws, 'results', `${tName}.jsonl`);
        if (!isSymlinkPath(rf) && fs.existsSync(rf) && sha256Hex(fs.readFileSync(rf)) !== tb.sha256.toLowerCase()) {
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

  const translation = (record.translation as Record<string, unknown>) || {};
  const engines = Array.isArray(record.engines) && record.engines.length ? record.engines.join('、') : '未记录';
  const povLabels: Record<string, string> = { first: '第一人称', second: '第二人称', third: '第三人称', mixed: '混合视角' };
  const pov = povLabels[profile.narrativePov] || profile.narrativePov;

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
    `- 术语表：${Object.keys(memory.glossary).length} 条；人设：${Object.keys(memory.persona).length} 条`,
    `- 译文：${String(translation.path || '未记录')}（${Number(translation.segments || 0)} 段）`,
    `- 质量标记：${String(record.quality || '未记录')}`,
    `- 验收时间：${String(record.accepted || '未记录')}`,
    `- 引擎：${engines}`,
  ];
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
