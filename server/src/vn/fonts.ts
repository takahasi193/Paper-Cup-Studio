/**
 * Pure Node.js SFNT/TTC font inspection, bundled font coverage scanning,
 * patched font manifest persistence, and fallback font / patch script resolution.
 *
 * Zero external npm dependencies and zero network requests.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspacePaths } from './workspace-paths.js';

export interface FontInspectionResult {
  familyName: string;
  fullName: string;
  unitsPerEm: number;
  xAvgCharWidth: number;
  avgWidthRatio: number;
  isFixedPitch: boolean;
  hasShiftJisCodePage: boolean;
  hasGb2312CodePage: boolean;
  cjkAdvanceWidth: number | null;
  glyphCount: number;
  mappedCodepoints: Set<number>;
}

export interface BundledFontCoverageEntry {
  relPath: string;
  familyName: string;
  bytes: number;
  unitsPerEm: number;
  xAvgCharWidth: number;
  avgWidthRatio: number;
  hasShiftJisCodePage: boolean;
  hasGb2312CodePage: boolean;
  probeTotalCount: number;
  probeMissingCount: number;
  missingSamples: string[];
  needsPatch: boolean;
  alreadyPatched: boolean;
}

export type FontRemapMode = 'none' | 'sjis_fullwidth_slots';

export interface CharRemapManifest {
  schema: 1;
  mode: FontRemapMode;
  base_family: string;
  remapped_count: number;
  overflow_count: number;
  char_map: Record<string, string>;
}

export interface PatchedFontEntry {
  install_rel: string;
  patched_rel: string;
  base_sha256: string;
  sha256: string;
  bytes: number;
  base_family: string;
  fallback_font: string;
  added_glyphs: number;
  still_missing_count: number;
  created_at: string;
  remap_mode?: FontRemapMode;
  remapped_count?: number;
  remap_rel?: string;
}

export interface PatchedFontManifest {
  schema: 1;
  updated_at: string;
  entries: PatchedFontEntry[];
}

/**
 * 60 high-frequency Simplified Chinese characters absent from JIS X 0208 (CP932),
 * ensuring Japanese-only bundled fonts reliably report missing target glyphs.
 */
export const ZH_SC_ONLY_PROBE_CHARS =
  '你这说话经读懂请样诉们过还对时么吗现实发东车门长书问爱语针为产开见进种给认让买卖飞马鸟鱼龙风电头边运达选连陈张刘杨赵';

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc']);

const EXCLUDED_SCAN_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.papercup',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'patch',
  'backup',
  'backups',
  '.papercup_backup',
  'papercup_backup',
  'unpacked',
  'build',
  'work',
  'results',
  'release',
  'tmp',
]);

const MAX_FONT_BYTES = 128 * 1024 * 1024;
const MAX_SCAN_DEPTH = 6;
const MAX_MISSING_SAMPLES = 24;

function isSymlinkLocal(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function sha256HexLocal(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeRelKey(rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

function isInsideRoot(rootDir: string, candidate: string): boolean {
  const base = path.resolve(rootDir);
  const abs = path.resolve(candidate);
  const rel = path.relative(base, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function decodeUtf16Be(slice: Buffer): string {
  const len = slice.length - (slice.length % 2);
  let out = '';
  for (let i = 0; i < len; i += 2) {
    const code = slice.readUInt16BE(i);
    if (code !== 0) out += String.fromCharCode(code);
  }
  return out.trim();
}

function isValidSfntSignature(buf: Buffer, offset: number): boolean {
  if (offset < 0 || offset + 12 > buf.length) return false;
  const tag = buf.readUInt32BE(offset);
  // 0x00010000 (TrueType), 'OTTO' (CFF/OTF), 'true' (Apple TrueType), 'typ1'
  return tag === 0x00010000 || tag === 0x4f54544f || tag === 0x74727565 || tag === 0x74797031;
}

interface SfntTable {
  offset: number;
  length: number;
}

function parseNameTable(
  buf: Buffer,
  table: SfntTable
): { familyName: string; fullName: string } {
  if (table.length < 6 || table.offset + 6 > buf.length) {
    return { familyName: '', fullName: '' };
  }
  const count = buf.readUInt16BE(table.offset + 2);
  const storageOffset = buf.readUInt16BE(table.offset + 4);
  const recordsStart = table.offset + 6;
  const storageStart = table.offset + storageOffset;
  if (recordsStart + count * 12 > table.offset + table.length || storageStart > buf.length) {
    return { familyName: '', fullName: '' };
  }

  const pickBest = (targetNameId: number): string => {
    let bestScore = -1;
    let bestText = '';
    for (let i = 0; i < count; i++) {
      const recOff = recordsStart + i * 12;
      if (recOff + 12 > buf.length) break;
      const platformID = buf.readUInt16BE(recOff);
      const encodingID = buf.readUInt16BE(recOff + 2);
      const languageID = buf.readUInt16BE(recOff + 4);
      const nameID = buf.readUInt16BE(recOff + 6);
      const length = buf.readUInt16BE(recOff + 8);
      const stringOffset = buf.readUInt16BE(recOff + 10);
      if (nameID !== targetNameId || length === 0) continue;

      const strAbs = storageStart + stringOffset;
      if (strAbs < table.offset || strAbs + length > buf.length) continue;
      const slice = buf.subarray(strAbs, strAbs + length);

      let text = '';
      let score = 0;
      if (platformID === 3) {
        text = decodeUtf16Be(slice);
        score = 100;
        if (encodingID === 1 || encodingID === 10) score += 20;
        if (languageID === 0x0409) score += 10;
        else if (languageID === 0x0804 || languageID === 0x0411) score += 5;
      } else if (platformID === 0) {
        text = decodeUtf16Be(slice);
        score = 60;
      } else if (platformID === 1 && encodingID === 0) {
        text = slice.toString('latin1').replace(/\0+/g, '').trim();
        score = 40;
        if (languageID === 0) score += 5;
      }
      if (text && score > bestScore) {
        bestScore = score;
        bestText = text;
      }
    }
    return bestText;
  };

  const familyName = pickBest(1) || pickBest(16);
  const fullName = pickBest(4) || familyName;
  return { familyName, fullName };
}

function parseCmapFormat4(
  buf: Buffer,
  subOff: number,
  subLimit: number,
  mapped: Set<number>,
  glyphLookup: Map<number, number>
): void {
  if (subOff + 14 > subLimit) return;
  const subLen = buf.readUInt16BE(subOff + 2);
  const limit = Math.min(subLimit, subOff + subLen);
  const segCountX2 = buf.readUInt16BE(subOff + 6);
  const segCount = segCountX2 >> 1;
  if (segCount === 0) return;

  const endCodeOff = subOff + 14;
  const startCodeOff = endCodeOff + segCount * 2 + 2; // +2 reservedPad
  const idDeltaOff = startCodeOff + segCount * 2;
  const idRangeOffOff = idDeltaOff + segCount * 2;
  if (idRangeOffOff + segCount * 2 > limit) return;

  for (let i = 0; i < segCount; i++) {
    const endCode = buf.readUInt16BE(endCodeOff + i * 2);
    const startCode = buf.readUInt16BE(startCodeOff + i * 2);
    if (startCode === 0xffff && endCode === 0xffff) break;
    if (endCode < startCode) continue;
    const idDelta = buf.readInt16BE(idDeltaOff + i * 2);
    const idRangeOffset = buf.readUInt16BE(idRangeOffOff + i * 2);

    for (let cp = startCode; cp <= endCode; cp++) {
      let gid = 0;
      if (idRangeOffset === 0) {
        gid = (cp + idDelta) & 0xffff;
      } else {
        const addr = idRangeOffOff + i * 2 + idRangeOffset + (cp - startCode) * 2;
        if (addr + 2 > limit) break;
        const rawGid = buf.readUInt16BE(addr);
        gid = rawGid === 0 ? 0 : (rawGid + idDelta) & 0xffff;
      }
      if (gid !== 0) {
        mapped.add(cp);
        if (cp === 0x4e2d || cp === 0x6f22) {
          glyphLookup.set(cp, gid);
        }
      }
    }
  }
}

function parseCmapFormat12(
  buf: Buffer,
  subOff: number,
  subLimit: number,
  mapped: Set<number>,
  glyphLookup: Map<number, number>
): void {
  if (subOff + 16 > subLimit) return;
  const subLen = buf.readUInt32BE(subOff + 4);
  const limit = Math.min(subLimit, subOff + subLen);
  const numGroups = buf.readUInt32BE(subOff + 12);
  const groupsStart = subOff + 16;
  const maxGroups = Math.min(numGroups, Math.floor((limit - groupsStart) / 12));

  for (let i = 0; i < maxGroups; i++) {
    const gOff = groupsStart + i * 12;
    const startChar = buf.readUInt32BE(gOff);
    const endChar = Math.min(buf.readUInt32BE(gOff + 4), 0x10ffff);
    const startGlyph = buf.readUInt32BE(gOff + 8);
    if (endChar < startChar) continue;
    for (let cp = startChar; cp <= endChar; cp++) {
      const gid = startGlyph + (cp - startChar);
      if (gid !== 0) {
        mapped.add(cp);
        if (cp === 0x4e2d || cp === 0x6f22) {
          glyphLookup.set(cp, gid);
        }
      }
    }
  }
}

function parseCmapTable(
  buf: Buffer,
  table: SfntTable
): { mappedCodepoints: Set<number>; refGlyphLookup: Map<number, number> } {
  const mappedCodepoints = new Set<number>();
  const refGlyphLookup = new Map<number, number>();
  if (table.length < 4 || table.offset + 4 > buf.length) {
    return { mappedCodepoints, refGlyphLookup };
  }
  const tableEnd = Math.min(buf.length, table.offset + table.length);
  const numTables = buf.readUInt16BE(table.offset + 2);
  const recordsStart = table.offset + 4;
  if (recordsStart + numTables * 8 > tableEnd) {
    return { mappedCodepoints, refGlyphLookup };
  }

  const subtables: Array<{ priority: number; subOff: number; format: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const recOff = recordsStart + i * 8;
    const platformID = buf.readUInt16BE(recOff);
    const encodingID = buf.readUInt16BE(recOff + 2);
    const relOff = buf.readUInt32BE(recOff + 4);
    const subOff = table.offset + relOff;
    if (subOff + 2 > tableEnd) continue;
    const format = buf.readUInt16BE(subOff);
    if (format !== 4 && format !== 12) continue;

    const isUnicode =
      platformID === 0 || (platformID === 3 && (encodingID === 1 || encodingID === 10));
    if (!isUnicode) continue;

    let priority = 10;
    if (platformID === 3 && encodingID === 10) priority = 100;
    else if (platformID === 0 && encodingID === 4) priority = 90;
    else if (platformID === 3 && encodingID === 1) priority = 80;
    else if (platformID === 0 && encodingID === 3) priority = 70;
    subtables.push({ priority, subOff, format });
  }

  // Parse lowest-priority first so highest-priority subtable wins refGlyphLookup entries
  subtables.sort((a, b) => a.priority - b.priority);
  for (const sub of subtables) {
    if (sub.format === 4) {
      parseCmapFormat4(buf, sub.subOff, tableEnd, mappedCodepoints, refGlyphLookup);
    } else if (sub.format === 12) {
      parseCmapFormat12(buf, sub.subOff, tableEnd, mappedCodepoints, refGlyphLookup);
    }
  }

  return { mappedCodepoints, refGlyphLookup };
}

function inspectSfntAtOffset(buf: Buffer, sfntOffset: number): FontInspectionResult {
  if (!isValidSfntSignature(buf, sfntOffset)) {
    throw new Error('Invalid SFNT font signature.');
  }
  const numTables = buf.readUInt16BE(sfntOffset + 4);
  const dirStart = sfntOffset + 12;
  if (dirStart + numTables * 16 > buf.length) {
    throw new Error('Truncated SFNT table directory.');
  }

  const tables = new Map<string, SfntTable>();
  for (let i = 0; i < numTables; i++) {
    const recOff = dirStart + i * 16;
    const tag = buf.subarray(recOff, recOff + 4).toString('latin1');
    const offset = buf.readUInt32BE(recOff + 8);
    const length = buf.readUInt32BE(recOff + 12);
    if (offset <= buf.length && offset + length <= buf.length) {
      tables.set(tag, { offset, length });
    }
  }

  const head = tables.get('head');
  const unitsPerEm = head && head.length >= 20 ? buf.readUInt16BE(head.offset + 18) : 1000;

  const maxp = tables.get('maxp');
  const glyphCount = maxp && maxp.length >= 6 ? buf.readUInt16BE(maxp.offset + 4) : 0;

  const post = tables.get('post');
  const isFixedPitch = post && post.length >= 16 ? buf.readUInt32BE(post.offset + 12) !== 0 : false;

  const os2 = tables.get('OS/2');
  const xAvgCharWidth = os2 && os2.length >= 4 ? buf.readInt16BE(os2.offset + 2) : 0;
  const os2Version = os2 && os2.length >= 2 ? buf.readUInt16BE(os2.offset) : 0;
  const ulCodePageRange1 =
    os2 && os2Version >= 1 && os2.length >= 82 ? buf.readUInt32BE(os2.offset + 78) : 0;
  const hasShiftJisCodePage = (ulCodePageRange1 & (1 << 17)) !== 0;
  const hasGb2312CodePage = (ulCodePageRange1 & (1 << 18)) !== 0;
  const avgWidthRatio = unitsPerEm > 0 ? xAvgCharWidth / unitsPerEm : 0;

  const nameTable = tables.get('name');
  const { familyName, fullName } = nameTable
    ? parseNameTable(buf, nameTable)
    : { familyName: '', fullName: '' };

  const cmapTable = tables.get('cmap');
  const { mappedCodepoints, refGlyphLookup } = cmapTable
    ? parseCmapTable(buf, cmapTable)
    : { mappedCodepoints: new Set<number>(), refGlyphLookup: new Map<number, number>() };

  let cjkAdvanceWidth: number | null = null;
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const refGid = refGlyphLookup.get(0x4e2d) ?? refGlyphLookup.get(0x6f22);
  if (refGid !== undefined && hhea && hhea.length >= 36 && hmtx) {
    const numberOfHMetrics = buf.readUInt16BE(hhea.offset + 34);
    if (numberOfHMetrics > 0) {
      const metricIdx = Math.min(refGid, numberOfHMetrics - 1);
      const metricOff = hmtx.offset + metricIdx * 4;
      if (metricOff + 2 <= hmtx.offset + hmtx.length) {
        cjkAdvanceWidth = buf.readUInt16BE(metricOff);
      }
    }
  }

  return {
    familyName,
    fullName,
    unitsPerEm,
    xAvgCharWidth,
    avgWidthRatio,
    isFixedPitch,
    hasShiftJisCodePage,
    hasGb2312CodePage,
    cjkAdvanceWidth,
    glyphCount,
    mappedCodepoints,
  };
}

/**
 * Pure TypeScript SFNT (.ttf/.otf) and TrueType Collection (.ttc) parser.
 */
export function inspectFontBuffer(buf: Buffer): FontInspectionResult {
  if (buf.length < 12) {
    throw new Error('Font buffer is too small.');
  }
  const magic = buf.subarray(0, 4).toString('latin1');
  if (magic === 'ttcf') {
    const numFonts = buf.readUInt32BE(8);
    if (numFonts === 0 || 12 + numFonts * 4 > buf.length) {
      throw new Error('Invalid TTC header.');
    }
    let firstValid: FontInspectionResult | null = null;
    for (let i = 0; i < numFonts; i++) {
      const faceOffset = buf.readUInt32BE(12 + i * 4);
      try {
        const res = inspectSfntAtOffset(buf, faceOffset);
        if (!firstValid) firstValid = res;
        if (res.mappedCodepoints.size > 0) return res;
      } catch {
        // try next face
      }
    }
    if (firstValid) return firstValid;
    throw new Error('No valid SFNT face found inside TTC.');
  }
  return inspectSfntAtOffset(buf, 0);
}

/**
 * Collect unique non-ASCII target characters from existing translated JSONL files
 * in `.papercup/data/results/*.jsonl` and `.papercup/tmp/work/out/*.jsonl`.
 */
export function collectWorkspaceTargetChars(workspace: string): string[] {
  const wsPaths = resolveWorkspacePaths(workspace);
  const dirs = [wsPaths.resultsDir, wsPaths.workOutDir];
  const seen = new Set<number>();
  const chars: string[] = [];

  for (const dir of dirs) {
    if (isSymlinkLocal(dir) || !fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.jsonl')) continue;
      const full = path.join(dir, ent.name);
      if (isSymlinkLocal(full)) continue;
      let content = '';
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const row = JSON.parse(trimmed) as Record<string, unknown>;
          const target = typeof row.target === 'string' ? row.target : '';
          if (!target) continue;
          for (const ch of target) {
            const cp = ch.codePointAt(0);
            if (cp === undefined || cp < 0x80) continue;
            if (!seen.has(cp)) {
              seen.add(cp);
              chars.push(ch);
            }
          }
        } catch {
          // ignore malformed JSONL line
        }
      }
    }
  }
  return chars;
}

function buildProbeCharset(workspace: string, targetLang?: string): number[] {
  const lang = (targetLang ?? 'zh-CN').trim().toLowerCase();
  const isZh = !lang || /^zh(?:[-_]|$)/.test(lang);
  const codepoints: number[] = [];
  const seen = new Set<number>();

  const pushChar = (ch: string) => {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp < 0x80 || seen.has(cp)) return;
    seen.add(cp);
    codepoints.push(cp);
  };

  if (isZh) {
    for (const ch of ZH_SC_ONLY_PROBE_CHARS) {
      pushChar(ch);
    }
  }
  for (const ch of collectWorkspaceTargetChars(workspace)) {
    pushChar(ch);
  }
  return codepoints;
}

export function loadPatchedFontManifest(workspace: string): PatchedFontManifest {
  const wsPaths = resolveWorkspacePaths(workspace);
  const manifestPath = wsPaths.fontsManifestFile;
  const empty: PatchedFontManifest = { schema: 1, updated_at: '', entries: [] };
  if (isSymlinkLocal(manifestPath) || !fs.existsSync(manifestPath)) return empty;
  try {
    const st = fs.statSync(manifestPath);
    if (!st.isFile()) return empty;
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return empty;
    const entries: PatchedFontEntry[] = [];
    for (const item of raw.entries) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const installRel = typeof rec.install_rel === 'string' ? rec.install_rel.trim() : '';
      const patchedRel = typeof rec.patched_rel === 'string' ? rec.patched_rel.trim() : '';
      const sha256 = typeof rec.sha256 === 'string' ? rec.sha256.trim().toLowerCase() : '';
      if (!installRel || !patchedRel || !sha256) continue;
      const remapMode: FontRemapMode | undefined =
        rec.remap_mode === 'none' || rec.remap_mode === 'sjis_fullwidth_slots'
          ? rec.remap_mode
          : undefined;
      const remappedCount =
        typeof rec.remapped_count === 'number' && Number.isFinite(rec.remapped_count)
          ? rec.remapped_count
          : undefined;
      const remapRel =
        typeof rec.remap_rel === 'string' && rec.remap_rel.trim() ? rec.remap_rel.trim() : undefined;
      entries.push({
        install_rel: installRel,
        patched_rel: patchedRel,
        base_sha256: typeof rec.base_sha256 === 'string' ? rec.base_sha256.trim().toLowerCase() : '',
        sha256,
        bytes: Number(rec.bytes ?? 0),
        base_family: typeof rec.base_family === 'string' ? rec.base_family : '',
        fallback_font: typeof rec.fallback_font === 'string' ? rec.fallback_font : '',
        added_glyphs: Number(rec.added_glyphs ?? 0),
        still_missing_count: Number(rec.still_missing_count ?? 0),
        created_at: typeof rec.created_at === 'string' ? rec.created_at : '',
        ...(remapMode ? { remap_mode: remapMode } : {}),
        ...(remappedCount !== undefined ? { remapped_count: remappedCount } : {}),
        ...(remapRel ? { remap_rel: remapRel } : {}),
      });
    }
    return {
      schema: 1,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
      entries,
    };
  } catch {
    return empty;
  }
}

export function savePatchedFontManifest(workspace: string, manifest: PatchedFontManifest): void {
  const wsPaths = resolveWorkspacePaths(workspace);
  const manifestPath = wsPaths.fontsManifestFile;
  if (isSymlinkLocal(manifestPath)) {
    throw new Error(`Font manifest path cannot be a symlink: ${manifestPath}`);
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const payload: PatchedFontManifest = {
    schema: 1,
    updated_at: manifest.updated_at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    entries: manifest.entries,
  };
  const tmp = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, manifestPath);
  } catch (err) {
    if (fs.existsSync(tmp)) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore cleanup error
      }
    }
    throw err;
  }
}

/**
 * Resolve a valid patched font file on disk matching a `PatchedFontEntry`'s SHA-256 and bounds.
 */
export function resolvePatchedFontFile(workspace: string, entry: PatchedFontEntry): string | null {
  const wsPaths = resolveWorkspacePaths(workspace);
  const relClean = entry.patched_rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relClean || relClean.includes('\x00')) return null;

  const candidates = [
    path.resolve(wsPaths.fontsDataDir, relClean),
    path.resolve(wsPaths.root, relClean),
  ];
  const roots = [wsPaths.fontsDataDir, wsPaths.root];

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (!isInsideRoot(roots[i], cand)) continue;
    if (isSymlinkLocal(cand) || !fs.existsSync(cand)) continue;
    try {
      const st = fs.statSync(cand);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_FONT_BYTES) continue;
      if (entry.bytes > 0 && st.size !== entry.bytes) continue;
      const buf = fs.readFileSync(cand);
      if (sha256HexLocal(buf) !== entry.sha256.toLowerCase()) continue;
      return cand;
    } catch {
      continue;
    }
  }
  return null;
}

export function scanWorkspaceBundledFonts(
  workspace: string,
  targetLang?: string
): BundledFontCoverageEntry[] {
  const wsPaths = resolveWorkspacePaths(workspace);
  const root = wsPaths.root;
  if (isSymlinkLocal(root) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return [];
  }

  const probeCodepoints = buildProbeCharset(root, targetLang);
  const manifest = loadPatchedFontManifest(root);
  const manifestByRel = new Map<string, PatchedFontEntry>();
  for (const entry of manifest.entries) {
    manifestByRel.set(normalizeRelKey(entry.install_rel), entry);
  }

  const fontFiles: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      if (isSymlinkLocal(full)) continue;
      if (ent.isDirectory()) {
        const low = ent.name.toLowerCase();
        if (ent.name.startsWith('.') || EXCLUDED_SCAN_DIRS.has(low)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (FONT_EXTS.has(ext)) {
          fontFiles.push(full);
        }
      }
    }
  };
  walk(root, 0);

  const results: BundledFontCoverageEntry[] = [];
  for (const full of fontFiles) {
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= 12 || st.size > MAX_FONT_BYTES) continue;

    let buf: Buffer;
    let info: FontInspectionResult;
    try {
      buf = fs.readFileSync(full);
      info = inspectFontBuffer(buf);
    } catch {
      continue;
    }

    const relPath = path.relative(root, full).replace(/\\/g, '/');
    const fileSha = sha256HexLocal(buf);

    const missingChars: string[] = [];
    for (const cp of probeCodepoints) {
      if (!info.mappedCodepoints.has(cp)) {
        missingChars.push(String.fromCodePoint(cp));
      }
    }

    let alreadyPatched = false;
    let patchedMissingCount = missingChars.length;
    const matchedEntry = manifestByRel.get(normalizeRelKey(relPath));
    if (matchedEntry) {
      const patchedFile = resolvePatchedFontFile(root, matchedEntry);
      if (
        patchedFile &&
        (!matchedEntry.base_sha256 ||
          matchedEntry.base_sha256 === fileSha ||
          matchedEntry.sha256 === fileSha)
      ) {
        alreadyPatched = true;
        try {
          const patchedInfo = inspectFontBuffer(fs.readFileSync(patchedFile));
          patchedMissingCount = 0;
          for (const cp of probeCodepoints) {
            if (!patchedInfo.mappedCodepoints.has(cp)) {
              patchedMissingCount++;
            }
          }
        } catch {
          alreadyPatched = false;
        }
      }
    }

    const needsPatch = alreadyPatched ? patchedMissingCount > 0 : missingChars.length > 0;

    results.push({
      relPath,
      familyName: info.familyName,
      bytes: st.size,
      unitsPerEm: info.unitsPerEm,
      xAvgCharWidth: info.xAvgCharWidth,
      avgWidthRatio: info.avgWidthRatio,
      hasShiftJisCodePage: info.hasShiftJisCodePage,
      hasGb2312CodePage: info.hasGb2312CodePage,
      probeTotalCount: probeCodepoints.length,
      probeMissingCount: missingChars.length,
      missingSamples: missingChars.slice(0, MAX_MISSING_SAMPLES),
      needsPatch,
      alreadyPatched,
    });
  }

  return results;
}

export function resolveFontPatchScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, 'scripts', 'patch_font.py'),
    path.resolve(currentDir, '..', '..', 'src', 'vn', 'scripts', 'patch_font.py'),
    path.join(process.cwd(), 'src', 'vn', 'scripts', 'patch_font.py'),
    path.join(process.cwd(), 'server', 'src', 'vn', 'scripts', 'patch_font.py'),
  ];
  for (const cand of candidates) {
    if (!isSymlinkLocal(cand) && fs.existsSync(cand)) {
      try {
        if (fs.statSync(cand).isFile()) return cand;
      } catch {
        // try next candidate
      }
    }
  }
  throw new Error(
    `Cannot locate patch_font.py script (checked: ${candidates.join(', ')}).`
  );
}

export function findSystemFallbackCjkFont(explicitPath?: string): string | null {
  const checkCandidate = (cand: string): string | null => {
    const resolved = path.resolve(cand);
    if (isSymlinkLocal(resolved) || !fs.existsSync(resolved)) return null;
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile() || st.size <= 12) return null;
      return resolved;
    } catch {
      return null;
    }
  };

  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    return checkCandidate(explicitPath.trim());
  }

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const winFonts = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts');
    candidates.push(
      'C:\\Windows\\Fonts\\simhei.ttf',
      'C:\\Windows\\Fonts\\msyh.ttc',
      'C:\\Windows\\Fonts\\NotoSansSC-VF.ttf',
      'C:\\Windows\\Fonts\\Deng.ttf',
      'C:\\Windows\\Fonts\\simsun.ttc',
      path.join(winFonts, 'simhei.ttf'),
      path.join(winFonts, 'msyh.ttc'),
      path.join(winFonts, 'NotoSansSC-VF.ttf'),
      path.join(winFonts, 'Deng.ttf'),
      path.join(winFonts, 'simsun.ttc')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/STHeiti Medium.ttc',
      '/Library/Fonts/Arial Unicode.ttf'
    );
  } else {
    candidates.push(
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
      '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'
    );
  }

  const seen = new Set<string>();
  for (const cand of candidates) {
    const key = process.platform === 'win32' ? cand.toLowerCase() : cand;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = checkCandidate(cand);
    if (hit) return hit;
  }
  return null;
}

const MAX_CHAR_REMAP_BYTES = 16 * 1024 * 1024;

/**
 * Safely load the workspace CP932 character remap manifest from
 * `.papercup/data/vn/fonts/char_remap.json`, rejecting symlinks or malformed files.
 */
export function loadWorkspaceCharRemap(workspace: string): CharRemapManifest | null {
  const wsPaths = resolveWorkspacePaths(workspace);
  const remapPath = wsPaths.fontRemapFile;
  if (isSymlinkLocal(remapPath) || !fs.existsSync(remapPath)) return null;
  try {
    const st = fs.statSync(remapPath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_CHAR_REMAP_BYTES) return null;
    const raw = JSON.parse(fs.readFileSync(remapPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema !== 1) return null;
    if (raw.mode !== 'none' && raw.mode !== 'sjis_fullwidth_slots') return null;
    if (!raw.char_map || typeof raw.char_map !== 'object' || Array.isArray(raw.char_map)) return null;

    const charMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.char_map as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length > 0 && typeof v === 'string' && v.length > 0) {
        charMap[k] = v;
      }
    }

    const remappedCount =
      typeof raw.remapped_count === 'number' && Number.isFinite(raw.remapped_count)
        ? raw.remapped_count
        : Object.keys(charMap).length;
    const overflowCount =
      typeof raw.overflow_count === 'number' && Number.isFinite(raw.overflow_count)
        ? raw.overflow_count
        : 0;

    return {
      schema: 1,
      mode: raw.mode,
      base_family: typeof raw.base_family === 'string' ? raw.base_family : '',
      remapped_count: remappedCount,
      overflow_count: overflowCount,
      char_map: charMap,
    };
  } catch {
    return null;
  }
}

/**
 * Apply single-pass codepoint remapping to text using a char_map dictionary.
 */
export function applyCharRemapText(text: string, charMap: Record<string, string>): string {
  if (!text) return text;
  if (!charMap || Object.keys(charMap).length === 0) return text;
  let changed = false;
  let out = '';
  for (const ch of text) {
    if (Object.prototype.hasOwnProperty.call(charMap, ch)) {
      const mapped = charMap[ch];
      if (typeof mapped === 'string') {
        out += mapped;
        if (mapped !== ch) changed = true;
        continue;
      }
    }
    out += ch;
  }
  return changed ? out : text;
}
