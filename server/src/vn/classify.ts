/**
 * Deterministic VN script track classification (scenario vs UI), atomic translation writeback (apply),
 * token-budgeted batch planning, and batch check-in / track merge state machine.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findUnpackManifests, resolveEngineJson } from './archives.js';
import {
  decodeBytes,
  DecodeError,
  displayRel,
  encodeText,
  insideWorkspace,
  isSymlinkPath,
  lexInline,
  normalizeEncodingName,
  parseKsLine,
  realpathSafe,
  Skeleton,
  splitLines,
  type LocalizationProfile,
  type ProjectMemory,
} from './profile.js';
import { qaReport } from './qa.js';
import {
  estimateRecordTokens,
  estimateRecordsStats,
  estimateWithMargin,
  resolveFamily,
} from './tokens.js';

export const CLASSIFIER_VERSION = '1';
export const MANIFEST_REL = '.papercup/vn/text.json';
export const APPLY_REL = '.papercup/vn/apply.json';
export const PLAN_REL = '.papercup/vn/plan.json';
export const PROGRESS_REL = '.papercup/vn/progress.json';
export const BATCHES_MANIFEST_REL = 'work/batches/manifest.json';
export const COUNTS_REL = 'work/counts.json';
export const SCENARIO_NAME = 'scenario.jsonl';
export const UI_NAME = 'ui.jsonl';

export const TRACKS = ['scenario', 'ui'] as const;
export type TrackName = (typeof TRACKS)[number];
export const TRACK_LABELS: Record<string, string> = { scenario: '剧情轨', ui: '界面轨' };

const MAX_FILES = 4096;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_WALK = 8192;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 20000;

const ENGINE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENT_RE = /^[A-Za-z_]\w*$/;
const ASCII_ID_RE = /^[A-Za-z0-9_-]+$/;
const OPEN_TAG_RE = /^[@\[]\s*([A-Za-z_]\w*)/;
const ATTR_RE = /([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/g;
const LABEL_RE = /^label\s+([A-Za-z_][\w.]*)\s*(?:\([^)]*\))?\s*:/;
const MENU_RE = /^menu(?:\s+[^:]+)?\s*:$/;
const KINDS = new Set(['say', 'choice', 'name', 'button', 'menu', 'system']);
const PROFILES = new Set(['kag', 'renpy', 'plain']);
const KAG_EXT = ['.ks'];
const RENPY_EXT = ['.rpy'];
const PLAIN_EXT = ['.txt', '.ks', '.rpy', '.scn', '.md'];
const KAG_ENGINES = new Set(['kirikiri', 'kag', 'tyrano']);
const TEXT_ATTRS = ['jname', 'cname', 'caption', 'text', 'message', 'label', 'name'];
const CHARA_NAME_TAGS = new Set(['chara_new', 'chara_name', 'title']);
const KAG_MACRO_OR_EXPR_RE = /^(?:%[A-Za-z_]\w*(?:\|.*)?|&[A-Za-z_$(].*)$/;
const KAG_TAGS: Record<string, string> = {
  link: 'choice',
  glink: 'choice',
  select: 'choice',
  seladd: 'choice',
  button: 'button',
  menu: 'menu',
  chara_new: 'name',
  chara_name: 'name',
  sysmes: 'system',
  ptext: 'system',
  mtext: 'system',
  tb_ptext_show: 'system',
  title: 'system',
};
const RENPY_TAGS: Record<string, string> = {
  textbutton: 'button',
  text: 'system',
  tooltip: 'system',
  alt: 'system',
  title: 'system',
};
const SAY_STYLES = new Set(['extend', 'centered', 'vcentered']);
const RENPY_SKIP = new Set([
  'action', 'add', 'as', 'at', 'behind', 'call', 'camera', 'contains', 'default', 'define', 'elif', 'else', 'fixed',
  'for', 'frame', 'grid', 'has', 'hbox', 'hide', 'if', 'image', 'imagebutton', 'init', 'jump', 'key',
  'label', 'layeredimage', 'menu', 'null', 'on', 'pass', 'pause', 'play', 'python', 'return', 'scene',
  'screen', 'show', 'stop', 'style', 'timer', 'transform', 'translate', 'use', 'vbox', 'voice', 'while',
  'window', 'with', 'zorder',
]);
const SILENT_DIRS = new Set(['.git', '.hg', '.svn', '.papercup', 'node_modules', '__pycache__', '.venv', 'venv', 'cache']);

export class ClassifyError extends Error {}
export class ApplyError extends Error {}
export class PlanError extends Error {}
export class BatchCheckinError extends Error {}

function atomicWriteText(targetPath: string, text: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function stableJsonPretty(obj: Record<string, unknown>): string {
  const sortVal = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sortVal);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortVal((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(sortVal(obj), null, 2) + '\n';
}

/* ========================= Script Classification ========================= */

export interface TextLine {
  id: string;
  file: string;
  line: number;
  scene: string;
  speaker: string;
  kind: string;
  source: string;
}

export interface Classification {
  engine: string;
  profile: string;
  warnings: string[];
  files: string[];
  lines: TextLine[];
  scenario: TextLine[];
  ui: TextLine[];
}

interface ClassifyRules {
  profile: string;
  extensions: string[];
  tags: Record<string, string>;
  textAttrs: string[];
  strictName: boolean;
}

function parseRules(engine: string, engineProfile: Record<string, unknown> | null, detectWarnings: string[]): {
  rules: ClassifyRules;
  warnings: string[];
} {
  let ovProfile = '';
  let ovExts: string[] | null = null;
  const ovTags: Record<string, string> = {};
  let ovAttrs: string[] | null = null;

  if (engineProfile && engineProfile.classify !== undefined && engineProfile.classify !== null) {
    if (typeof engineProfile.classify !== 'object' || Array.isArray(engineProfile.classify)) {
      throw new ClassifyError('engine.json 的 classify 必须是对象。');
    }
    const raw = engineProfile.classify as Record<string, unknown>;
    const allowed = new Set(['profile', 'extensions', 'tags', 'text_attrs']);
    const unknown = Object.keys(raw).filter((k) => !allowed.has(k)).sort();
    if (unknown.length) {
      throw new ClassifyError(`classify 含有未知字段：${unknown.join('、')}`);
    }
    if (raw.profile !== undefined && raw.profile !== null) {
      if (typeof raw.profile !== 'string' || !PROFILES.has(raw.profile)) {
        throw new ClassifyError('classify.profile 只能是 kag、renpy 或 plain。');
      }
      ovProfile = raw.profile;
    }
    if (raw.extensions !== undefined && raw.extensions !== null) {
      if (!Array.isArray(raw.extensions) || !raw.extensions.length) {
        throw new ClassifyError('classify.extensions 必须是非空数组。');
      }
      ovExts = [];
      for (const item of raw.extensions) {
        if (typeof item !== 'string') throw new ClassifyError('classify.extensions 必须是字符串。');
        const ext = item.trim().toLowerCase();
        if (!ext.startsWith('.') || ext === '.' || ext === '..' || /[/\\ ]/.test(ext)) {
          throw new ClassifyError(`classify.extensions 不合法：${item}`);
        }
        if (!ovExts.includes(ext)) ovExts.push(ext);
      }
    }
    if (raw.tags !== undefined && raw.tags !== null) {
      if (typeof raw.tags !== 'object' || Array.isArray(raw.tags)) {
        throw new ClassifyError('classify.tags 必须是对象。');
      }
      for (const [k, v] of Object.entries(raw.tags as Record<string, unknown>)) {
        if (!IDENT_RE.test(k)) throw new ClassifyError(`classify.tags 的标签名不合法：${k}`);
        if (typeof v !== 'string' || !KINDS.has(v)) throw new ClassifyError(`classify.tags.${k} 不是合法分类。`);
        ovTags[k] = v;
      }
    }
    if (raw.text_attrs !== undefined && raw.text_attrs !== null) {
      if (!Array.isArray(raw.text_attrs)) throw new ClassifyError('classify.text_attrs 必须是数组。');
      ovAttrs = [];
      for (const item of raw.text_attrs) {
        if (typeof item !== 'string' || !IDENT_RE.test(item)) {
          throw new ClassifyError(`classify.text_attrs 不合法：${String(item)}`);
        }
        if (!ovAttrs.includes(item)) ovAttrs.push(item);
      }
    }
  }

  const builtin = KAG_ENGINES.has(engine) ? 'kag' : engine === 'renpy' ? 'renpy' : '';
  let profile = ovProfile || builtin;
  const warnings: string[] = [];
  if (!profile) {
    profile = 'plain';
    if (engine) warnings.push(`未知引擎 ${engine}，已把文本行全部归入剧情轨。`);
    else warnings.push(...detectWarnings);
  }
  let extensions = PLAIN_EXT;
  let tags: Record<string, string> = {};
  let textAttrs: string[] = [];
  let strictName = false;
  if (profile === 'kag') {
    extensions = KAG_EXT;
    tags = { ...KAG_TAGS };
    textAttrs = [...TEXT_ATTRS];
    strictName = true;
  } else if (profile === 'renpy') {
    extensions = RENPY_EXT;
    tags = { ...RENPY_TAGS };
  } else if (Object.keys(ovTags).length || ovAttrs !== null) {
    warnings.push('profile 为 plain，已忽略 classify.tags 与 classify.text_attrs。');
  }

  if (ovExts !== null) extensions = ovExts;
  if (profile !== 'plain') {
    Object.assign(tags, ovTags);
    if (ovAttrs !== null) {
      textAttrs = ovAttrs;
      strictName = false;
    }
  }
  return { rules: { profile, extensions, tags, textAttrs, strictName }, warnings };
}

function skeletonBody(skel: Skeleton, dropSpeaker: boolean): string {
  let pieces = skel.pieces;
  if (
    dropSpeaker &&
    pieces.length > 0 &&
    pieces[0].kind === 'control' &&
    pieces[0].value.startsWith('【') &&
    pieces[0].value.endsWith('】')
  ) {
    pieces = pieces.slice(1);
  }
  if (!pieces.some((p) => p.kind === 'text')) return '';
  return pieces.map((p) => p.value).join('').trim();
}

function attrSource(line: string, tagName: string, rules: ClassifyRules): string {
  if (!rules.textAttrs.length) return '';
  const found: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(line)) !== null) {
    const key = m[1];
    if (key in found) continue;
    found[key] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  for (const key of rules.textAttrs) {
    const val = found[key] ?? '';
    if (!val.trim()) continue;
    if (rules.strictName) {
      if (KAG_MACRO_OR_EXPR_RE.test(val.trim())) continue;
      if (key === 'name' && (!CHARA_NAME_TAGS.has(tagName) || ASCII_ID_RE.test(val))) continue;
    }
    return val;
  }
  return '';
}

function classifyPlain(filePath: string, text: string): TextLine[] {
  const records: TextLine[] = [];
  const { lines } = splitLines(text);
  lines.forEach((line, idx) => {
    const stripped = line.trim();
    if (!stripped) return;
    const source = skeletonBody(lexInline(stripped, 'kag'), false);
    if (source) {
      records.push({ id: `${filePath}#${idx + 1}`, file: filePath, line: idx + 1, scene: '', speaker: '', kind: 'say', source });
    }
  });
  return records;
}

function classifyKag(filePath: string, text: string, rules: ClassifyRules): { records: TextLine[]; warnings: string[] } {
  const records: TextLine[] = [];
  const warnings: string[] = [];
  let scene = '';
  const { lines } = splitLines(text);
  lines.forEach((line, idx) => {
    const number = idx + 1;
    const stripped = line.replace(/^\s+/, '');
    if (!stripped) return;
    const parsed = parseKsLine(stripped);
    if (parsed.anchor !== null) {
      scene = parsed.anchor;
      return;
    }
    const tagMatch = OPEN_TAG_RE.exec(stripped);
    const tagName = tagMatch ? tagMatch[1] : '';
    const mapped = tagName ? rules.tags[tagName] : undefined;
    const kind = mapped || (parsed.skeleton.hasText() ? 'say' : null);
    if (!kind) return;
    const body = skeletonBody(parsed.skeleton, Boolean(parsed.speaker));
    const source = kind === 'name' ? attrSource(stripped, tagName, rules) || body : body || attrSource(stripped, tagName, rules);
    if (!source) return;
    if (!line.includes(source)) {
      warnings.push(`分类结果不是原行子串，已跳过：${filePath}:${number}`);
      return;
    }
    const speaker = kind === 'say' ? parsed.speaker || '' : '';
    records.push({ id: `${filePath}#${number}`, file: filePath, line: number, scene, speaker, kind, source });
  });
  return { records, warnings };
}

class UnclosedString extends Error {}

function readQuotedString(text: string, quoteIdx: number): [string, number] | null {
  const quote = text[quoteIdx];
  let out = '';
  let i = quoteIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return [out, i + 1];
    out += ch;
    i += 1;
  }
  return null;
}

function openRenpyString(text: string): [string, number] | null {
  const wrapped = text.startsWith('_(');
  let i = wrapped ? 2 : 0;
  if (!wrapped && text.length >= 2 && 'rRuU'.includes(text[0]) && (text[1] === '"' || text[1] === "'")) {
    i = 1;
  }
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length || (text[i] !== '"' && text[i] !== "'")) {
    if (wrapped) throw new UnclosedString();
    return null;
  }
  const found = readQuotedString(text, i);
  if (!found) throw new UnclosedString();
  let [raw, end] = found;
  if (wrapped) {
    while (end < text.length && /\s/.test(text[end])) end++;
    if (end >= text.length || text[end] !== ')') throw new UnclosedString();
    end += 1;
  }
  return [raw, end];
}

function stripRenpyComment(line: string): string {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function findOutsideQuotes(text: string, needle: string, start: number): number {
  let quote = '';
  let escaped = false;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (text.startsWith(needle, i)) return i;
    i += 1;
  }
  return -1;
}

function visibleRenpy(raw: string): string {
  if (!raw.trim()) return '';
  return lexInline(raw, 'renpy').hasText() ? raw : '';
}

function classifyRenpy(filePath: string, text: string, rules: ClassifyRules): { records: TextLine[]; warnings: string[] } {
  const records: TextLine[] = [];
  const warnings: string[] = [];
  let scene = '';
  let menuAt: number | null = null;
  let pythonAt: number | null = null;
  const { lines } = splitLines(text);

  lines.forEach((line, idx) => {
    const number = idx + 1;
    const stripped = stripRenpyComment(line).trim();
    if (!stripped) return;
    const expanded = line.replace(/\t/g, '    ');
    const indent = expanded.length - expanded.replace(/^ +/, '').length;
    if (pythonAt !== null && indent <= pythonAt) pythonAt = null;
    if (pythonAt !== null) return;
    if (menuAt !== null && indent <= menuAt) menuAt = null;
    if (stripped.includes('"""') || stripped.includes("'''")) {
      warnings.push(`未支持的多行字符串：${filePath}:${number}`);
      return;
    }
    const labelMatch = LABEL_RE.exec(stripped);
    if (labelMatch) {
      scene = labelMatch[1];
      return;
    }
    if (MENU_RE.test(stripped)) {
      menuAt = indent;
      return;
    }
    if (stripped.startsWith('python:') || stripped.startsWith('init python:') || stripped.startsWith('init python ')) {
      pythonAt = indent;
      return;
    }
    try {
      let rec: TextLine | null = null;
      if (!stripped.startsWith('$')) {
        // Check Character("...")
        let charPos = -1;
        let search = 0;
        while (search < stripped.length) {
          const hit = findOutsideQuotes(stripped, 'Character', search);
          if (hit < 0) break;
          let cur = hit + 'Character'.length;
          while (cur < stripped.length && /\s/.test(stripped[cur])) cur++;
          if (stripped[cur] === '(') {
            charPos = cur + 1;
            break;
          }
          search = hit + 'Character'.length;
        }
        if (charPos >= 0) {
          const opened = openRenpyString(stripped.slice(charPos).replace(/^\s+/, ''));
          if (opened) {
            const src = visibleRenpy(opened[0]);
            if (src) rec = { id: `${filePath}#${number}`, file: filePath, line: number, scene, speaker: '', kind: 'name', source: src };
          }
        } else {
          const tokMatch = /^([A-Za-z_]\w*)(.*)$/s.exec(stripped);
          const token = tokMatch ? tokMatch[1] : '';
          const rest = tokMatch ? tokMatch[2] : stripped;
          if (token in rules.tags) {
            const opened = openRenpyString(rest.replace(/^\s+/, ''));
            const src = opened ? visibleRenpy(opened[0]) : '';
            if (src) rec = { id: `${filePath}#${number}`, file: filePath, line: number, scene, speaker: '', kind: rules.tags[token], source: src };
          } else if (token === 'label') {
            const opened = openRenpyString(rest.replace(/^\s+/, ''));
            const src = opened ? visibleRenpy(opened[0]) : '';
            if (src) rec = { id: `${filePath}#${number}`, file: filePath, line: number, scene, speaker: '', kind: 'system', source: src };
          } else if (menuAt !== null && indent > menuAt) {
            const opened = openRenpyString(stripped);
            if (opened && stripped.slice(opened[1]).trim() === ':') {
              const src = visibleRenpy(opened[0]);
              if (src) rec = { id: `${filePath}#${number}`, file: filePath, line: number, scene, speaker: '', kind: 'choice', source: src };
            }
          } else if (!RENPY_SKIP.has(token)) {
            let speaker = '';
            let sayRest = stripped;
            const sm = /^([A-Za-z_]\w*)\s+(.*)$/s.exec(stripped);
            if (sm && !RENPY_SKIP.has(sm[1])) {
              speaker = sm[1];
              let r = sm[2];
              while (true) {
                const am = /^([A-Za-z_]\w*)\s+/.exec(r);
                if (!am) break;
                r = r.slice(am[0].length);
              }
              sayRest = r;
            }
            const opened = openRenpyString(sayRest.replace(/^\s+/, ''));
            if (opened) {
              if (SAY_STYLES.has(speaker)) speaker = '';
              const src = visibleRenpy(opened[0]);
              if (src) rec = { id: `${filePath}#${number}`, file: filePath, line: number, scene, speaker, kind: 'say', source: src };
            }
          }
        }
      }
      if (!rec) return;
      if (!line.includes(rec.source)) {
        warnings.push(`分类结果不是原行子串，已跳过：${filePath}:${number}`);
        return;
      }
      records.push(rec);
    } catch (err) {
      if (err instanceof UnclosedString) {
        warnings.push(`未闭合字符串：${filePath}:${number}`);
        return;
      }
      throw err;
    }
  });

  return { records, warnings };
}

export function classifyUnpacked(
  unpackedRoot: string,
  options: { engine?: string; engineProfile?: Record<string, unknown> | null } = {}
): Classification {
  if (isSymlinkPath(unpackedRoot) || !fs.existsSync(unpackedRoot) || !fs.statSync(unpackedRoot).isDirectory()) {
    throw new ClassifyError(`解包目录不存在：${unpackedRoot}`);
  }
  const base = realpathSafe(unpackedRoot);
  const found: Array<{ rel: string; full: string; suffix: string; size: number }> = [];
  const suffixes = new Set<string>();
  const walkWarnings: string[] = [];
  const tlDirs: string[] = [];
  let dirsSeen = 0;

  function walk(dir: string, depth: number) {
    dirsSeen += 1;
    if (dirsSeen > MAX_WALK) throw new ClassifyError(`解包目录超过 ${MAX_WALK} 个条目，已停止。`);
    const relDir = path.relative(base, dir).replace(/\\/g, '/');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const subDirs: string[] = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (isSymlinkPath(full)) {
        walkWarnings.push(`已跳过符号链接：${rel}`);
        continue;
      }
      if (ent.isDirectory()) {
        const lower = ent.name.toLowerCase();
        if (lower === 'tl') {
          tlDirs.push(rel);
          continue;
        }
        if (ent.name.startsWith('.') || SILENT_DIRS.has(lower)) continue;
        subDirs.push(ent.name);
      } else if (ent.isFile() && !ent.name.startsWith('.')) {
        try {
          const st = fs.statSync(full);
          const suffix = path.extname(ent.name).toLowerCase();
          suffixes.add(suffix);
          found.push({ rel, full, suffix, size: st.size });
        } catch (err) {
          walkWarnings.push(`读不了 ${rel}：${err}`);
        }
      }
    }
    if (depth >= MAX_DEPTH && subDirs.length) {
      walkWarnings.push(`已跳过过深的目录：${subDirs.map((n) => (relDir ? `${relDir}/${n}` : n)).join('、')}`);
      return;
    }
    for (const name of subDirs) {
      walk(path.join(dir, name), depth + 1);
    }
  }
  walk(base, 0);
  if (tlDirs.length) {
    walkWarnings.unshift('已跳过翻译目录：' + tlDirs.sort().join('、'));
  }

  const rawEngine = (options.engine || '').trim().toLowerCase();
  const detectWarnings: string[] = [];
  let chosenEngine = rawEngine;
  const hasTyranoLayout = found.some((item) => /(?:^|\/)tyrano\/(?:tyrano\.js|lang\.js)$/i.test(item.rel));
  if (chosenEngine) {
    if (!ENGINE_NAME_RE.test(chosenEngine)) throw new ClassifyError(`引擎名不合法：${options.engine}`);
  } else if (suffixes.has('.ks') && suffixes.has('.rpy')) {
    detectWarnings.push('同时存在 .ks 与 .rpy，无法判断引擎，已把文本行全部归入剧情轨。');
  } else if (hasTyranoLayout) {
    chosenEngine = 'tyrano';
  } else if (suffixes.has('.ks')) {
    chosenEngine = 'kirikiri';
  } else if (suffixes.has('.rpy')) {
    chosenEngine = 'renpy';
  } else {
    detectWarnings.push('未能识别引擎，已把文本行全部归入剧情轨。');
  }

  const { rules, warnings: ruleWarnings } = parseRules(chosenEngine, options.engineProfile ?? null, detectWarnings);
  const matched = found.filter((item) => rules.extensions.includes(item.suffix));
  if (matched.length > MAX_FILES) throw new ClassifyError(`脚本超过 ${MAX_FILES} 个，已停止。`);

  const docs: Array<[string, string]> = [];
  const decodeWarnings: string[] = [];
  for (const item of matched) {
    if (item.size > MAX_FILE_BYTES) {
      decodeWarnings.push(`脚本超过 ${MAX_FILE_BYTES} 字节，已跳过：${item.rel}`);
      continue;
    }
    try {
      const data = fs.readFileSync(item.full);
      const { text } = decodeBytes(data);
      docs.push([item.rel, text]);
    } catch (err) {
      if (err instanceof DecodeError) decodeWarnings.push(`无法解码：${item.rel}`);
      else decodeWarnings.push(`读不了 ${item.rel}：${err}`);
    }
  }

  docs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lines: TextLine[] = [];
  const notes: string[] = [];
  for (const [docPath, text] of docs) {
    if (rules.profile === 'renpy') {
      const res = classifyRenpy(docPath, text, rules);
      lines.push(...res.records);
      notes.push(...res.warnings);
    } else if (rules.profile === 'kag') {
      const res = classifyKag(docPath, text, rules);
      lines.push(...res.records);
      notes.push(...res.warnings);
    } else {
      lines.push(...classifyPlain(docPath, text));
    }
  }
  const emptyWarn = docs.length ? [] : ['没有可分类的脚本。'];
  return {
    engine: chosenEngine,
    profile: rules.profile,
    warnings: [...ruleWarnings, ...emptyWarn, ...walkWarnings, ...decodeWarnings, ...notes],
    files: docs.map(([p]) => p),
    lines,
    scenario: lines.filter((l) => l.kind === 'say'),
    ui: lines.filter((l) => l.kind !== 'say'),
  };
}

function renderJsonlBuffer(lines: TextLine[]): Buffer {
  if (!lines.length) return Buffer.alloc(0);
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

export function classificationDigest(result: Classification): string {
  const payload = Buffer.concat([renderJsonlBuffer(result.scenario), Buffer.from('\n', 'utf8'), renderJsonlBuffer(result.ui)]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function writeClassification(
  workspace: string,
  outDir: string,
  result: Classification,
  reportPathArg?: string | null
): { scenario: string; ui: string; manifest: string; report: string | null; digest: string } {
  const target = insideWorkspace(workspace, outDir);
  if (!target) throw new ClassifyError('输出目录必须在工作区内。');
  if (fs.existsSync(target) && (isSymlinkPath(target) || !fs.statSync(target).isDirectory())) {
    throw new ClassifyError('输出路径必须是目录。');
  }
  let reportDest: string | null = null;
  if (reportPathArg) {
    reportDest = insideWorkspace(workspace, reportPathArg);
    if (!reportDest) throw new ClassifyError('报告路径必须在工作区内。');
    if (fs.existsSync(reportDest) && (isSymlinkPath(reportDest) || fs.statSync(reportDest).isDirectory())) {
      throw new ClassifyError('报告路径必须是普通文件。');
    }
  }

  fs.mkdirSync(target, { recursive: true });
  const scenarioPath = path.join(target, SCENARIO_NAME);
  const uiPath = path.join(target, UI_NAME);
  const manifestPath = path.join(workspace, MANIFEST_REL);
  for (const p of [scenarioPath, uiPath, manifestPath]) {
    if (isSymlinkPath(p)) throw new ClassifyError(`拒绝写入符号链接：${path.basename(p)}`);
  }

  const digest = classificationDigest(result);
  atomicWriteText(scenarioPath, renderJsonlBuffer(result.scenario).toString('utf8'));
  atomicWriteText(uiPath, renderJsonlBuffer(result.ui).toString('utf8'));

  const manifestPayload: Record<string, unknown> = {
    classifier: CLASSIFIER_VERSION,
    digest,
    engine: result.engine,
    files: result.files,
    profile: result.profile,
    scenario: result.scenario.length,
    ui: result.ui.length,
    warnings: result.warnings,
  };
  atomicWriteText(manifestPath, stableJsonPretty(manifestPayload));

  if (reportDest) {
    const repPayload = {
      ...manifestPayload,
      manifest: displayRel(manifestPath, workspace),
      scenario_path: displayRel(scenarioPath, workspace),
      ui_path: displayRel(uiPath, workspace),
    };
    atomicWriteText(reportDest, stableJsonPretty(repPayload));
  }

  return { scenario: scenarioPath, ui: uiPath, manifest: manifestPath, report: reportDest, digest };
}

export function readManifest(workspace: string): Record<string, unknown> | null {
  const p = path.join(workspace, MANIFEST_REL);
  try {
    if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function manifestTrackCount(workspace: string, track: string): number | null {
  const m = readManifest(workspace);
  if (!m) return null;
  const val = m[track];
  return typeof val === 'number' && Number.isInteger(val) && val >= 0 ? val : null;
}

export function resolveClassifyProfileForUnpacked(
  workspace: string,
  homeDir: string | null,
  engineArg: string,
  unpackedDir: string
): { engine: string; profile: Record<string, unknown> | null } {
  let engine = engineArg.trim().toLowerCase();
  if (!engine) {
    const candidates = [
      path.join(unpackedDir, '.skill-manifest.json'),
      path.join(unpackedDir, '.compose-manifest.json'),
      ...findUnpackManifests(unpackedDir),
    ];
    for (const mp of candidates) {
      if (!isSymlinkPath(mp) && fs.existsSync(mp)) {
        try {
          const obj = JSON.parse(fs.readFileSync(mp, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
          const eng = typeof obj.engine === 'string' ? obj.engine.trim().toLowerCase() : '';
          if (eng && eng !== 'pe-zip') {
            engine = eng;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  const profile = resolveEngineJson(workspace, engine, homeDir);
  return { engine, profile };
}

/* ========================= Apply Results ========================= */

export function readResultsJsonl(filePath: string): Array<Record<string, unknown>> {
  if (isSymlinkPath(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new ApplyError(`结果文件不存在或不是普通文件：${filePath}`);
  }
  const st = fs.statSync(filePath);
  if (st.size > MAX_INPUT_BYTES) throw new ApplyError(`结果文件超过 ${MAX_INPUT_BYTES} 字节。`);
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const records: Array<Record<string, unknown>> = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    if (records.length >= MAX_RECORDS) throw new ApplyError(`结果文件最多 ${MAX_RECORDS} 段。`);
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch (err) {
      throw new ApplyError(`结果文件第 ${idx + 1} 行不是 JSON：${(err as Error).message}`);
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApplyError(`结果文件第 ${idx + 1} 行必须是对象。`);
    }
    records.push(item as Record<string, unknown>);
  });
  if (!records.length) throw new ApplyError('结果文件没有可落盘的段落。');
  return records;
}

function splitEolLine(line: string): [string, string] {
  if (line.endsWith('\r\n')) return [line.slice(0, -2), '\r\n'];
  if (line.endsWith('\n')) return [line.slice(0, -1), '\n'];
  if (line.endsWith('\r')) return [line.slice(0, -1), '\r'];
  return [line, ''];
}

function splitKeepEnds(text: string): string[] {
  const matches = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  if (matches.length && matches[matches.length - 1] === '') matches.pop();
  return matches;
}

export interface ApplyOutcome {
  report: Record<string, unknown>;
  reportPath: string;
  partial: boolean;
  applied: number;
}

export function applyResults(
  workspace: string,
  rootDir: string,
  results: Array<Record<string, unknown>>,
  profile: LocalizationProfile,
  memory: ProjectMemory,
  track: string,
  options: { scene?: string; allowPartial?: boolean; encoding?: string | null } = {}
): ApplyOutcome {
  if (!TRACKS.includes(track as TrackName)) throw new ApplyError('落盘轨道只能是 scenario 或 ui。');
  let requestedEnc: string | null = null;
  try {
    requestedEnc = normalizeEncodingName(options.encoding);
  } catch (err) {
    throw new ApplyError((err as Error).message);
  }
  const base = insideWorkspace(workspace, rootDir);
  if (!base || isSymlinkPath(base) || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new ApplyError(`解包根目录必须在工作区内且是目录：${rootDir}`);
  }
  const scene = (options.scene || '').trim();
  const candidates: Array<Record<string, unknown>> = [];
  for (const item of results) {
    const tVal = item.track;
    const recTrack =
      tVal === 'scenario' || tVal === 'ui'
        ? tVal
        : typeof item.kind === 'string' && item.kind.trim()
          ? item.kind.trim() === 'say'
            ? 'scenario'
            : 'ui'
          : track;
    if (recTrack !== track) {
      throw new ApplyError(`输入含${TRACK_LABELS[recTrack] || recTrack}记录；一次只落一个轨道。`);
    }
    if (scene && String(item.scene ?? '').trim() !== scene) continue;
    candidates.push(item);
  }
  if (!candidates.length) {
    throw new ApplyError(scene ? `没有符合场景 ${scene} 的段落。` : '结果文件没有可落盘的段落。');
  }

  const blocked: Array<{ id: string; reason: string }> = [];
  const accepted: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const item of candidates) {
    const fileStr = typeof item.file === 'string' ? item.file.trim() : '';
    const lineNum = typeof item.line === 'number' && Number.isInteger(item.line) && item.line >= 1 ? item.line : 0;
    const keyStr = fileStr && lineNum ? `${fileStr}#${lineNum}` : null;
    const idText = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : keyStr || '未知段落';
    if (keyStr) {
      if (seen.has(keyStr)) throw new ApplyError(`同一行出现多条结果：${keyStr}`);
      seen.add(keyStr);
    }
    if (item.ok !== true) {
      blocked.push({ id: idText, reason: '段落标记为未通过，不能落盘。' });
      continue;
    }
    const source = item.source;
    const target = item.target;
    if (typeof source !== 'string' || !source.trim()) throw new ApplyError(`${idText} 缺少非空 source。`);
    if (typeof target !== 'string' || !target.trim()) {
      blocked.push({ id: idText, reason: '译文为空。' });
      continue;
    }
    if (target.includes('\n') || target.includes('\r')) {
      throw new ApplyError(`${idText} 的译文含换行；会破坏脚本行结构。`);
    }
    const rep = qaReport(source, target, profile, memory.glossary);
    if (rep.blocked) {
      const detail = rep.findings
        .filter((f) => f.severity === 'error')
        .map((f) => `[${f.rule}] ${f.message}`)
        .join('；');
      blocked.push({ id: idText, reason: detail || '未通过 QA。' });
      continue;
    }
    accepted.push(item);
  }

  const allowPartial = Boolean(options.allowPartial);
  if (blocked.length && !allowPartial) {
    const preview = blocked.slice(0, 20).map((b) => `- ${b.id}：${b.reason}`).join('\n');
    throw new ApplyError(`${blocked.length} 段未通过核对，未写入任何文件；先修好再用 --allow-partial 显式部分落盘。\n${preview}`);
  }

  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const item of accepted) {
    const fileStr = typeof item.file === 'string' ? item.file.trim().replace(/\\/g, '/') : '';
    const lineNum = typeof item.line === 'number' && Number.isInteger(item.line) && item.line >= 1 ? item.line : 0;
    if (!fileStr || !lineNum) throw new ApplyError(`${String(item.id || '未知段落')} 缺少 file 或 line；只有分类产物能落盘。`);
    const parts = fileStr.split('/');
    if (fileStr.startsWith('/') || fileStr.includes(':') || parts.some((p) => !p || p === '.' || p === '..')) {
      throw new ApplyError(`脚本路径不合法：${fileStr}`);
    }
    const arr = groups.get(fileStr) ?? [];
    arr.push(item);
    groups.set(fileStr, arr);
  }

  const expectedTotal = !scene ? manifestTrackCount(workspace, track) : null;
  const appliedCount = accepted.length;
  const incomplete = expectedTotal !== null && expectedTotal > 0 && appliedCount < expectedTotal;
  if (incomplete && !allowPartial) {
    throw new ApplyError(
      `${TRACK_LABELS[track]}仅覆盖 ${appliedCount}/${expectedTotal} 段（缺 ${expectedTotal - appliedCount} 段），未写入任何文件；补全全部译文后再落盘，或加 --allow-partial 显式部分落盘。`
    );
  }

  const written: Array<Record<string, unknown>> = [];
  for (const [rel, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const targetFile = insideWorkspace(workspace, path.join(base, rel));
    if (!targetFile || isSymlinkPath(targetFile) || !fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
      throw new ApplyError(`脚本不存在或不是普通文件：${rel}`);
    }
    const origBytes = fs.readFileSync(targetFile);
    let text: string;
    let sourceEnc: string;
    try {
      const dec = decodeBytes(origBytes);
      text = dec.text;
      sourceEnc = dec.encoding;
    } catch (err) {
      throw new ApplyError(`读不了脚本 ${displayRel(targetFile, base)}：${(err as Error).message}`);
    }

    const lines = splitKeepEnds(text);
    for (const item of items) {
      const num = Number(item.line);
      if (num > lines.length) {
        throw new ApplyError(`${displayRel(targetFile, base)} 没有第 ${num} 行。`);
      }
      const [body, eol] = splitEolLine(lines[num - 1]);
      const source = String(item.source || '');
      const target = String(item.target || '');
      let count = 0;
      let idx = 0;
      while ((idx = body.indexOf(source, idx)) >= 0) {
        count++;
        idx += Math.max(1, source.length);
      }
      if (count !== 1) {
        throw new ApplyError(`${displayRel(targetFile, base)} 第 ${num} 行与源文不再一致（匹配 ${count} 次）；重新分类后再翻译。`);
      }
      const pos = body.indexOf(source);
      lines[num - 1] = body.slice(0, pos) + target + body.slice(pos + source.length) + eol;
    }

    const payloadText = lines.join('');
    let targetEnc = requestedEnc || sourceEnc;
    let outBuf: Buffer;
    try {
      outBuf = encodeText(payloadText, targetEnc);
    } catch (err) {
      if (requestedEnc) {
        throw new ApplyError(`译文无法用指定编码 ${requestedEnc} 写回 ${displayRel(targetFile, base)}。`);
      }
      targetEnc = 'utf-8-bom';
      try {
        outBuf = encodeText(payloadText, targetEnc);
      } catch {
        throw new ApplyError(`译文无法用原编码 ${sourceEnc} 或 UTF-8 BOM 写回 ${displayRel(targetFile, base)}。`);
      }
    }

    const backupPath = `${targetFile}.bak`;
    if (isSymlinkPath(backupPath)) throw new ApplyError(`备份路径不能是符号链接：${displayRel(backupPath, base)}`);
    const tmpPath = `${targetFile}.tmp`;
    fs.writeFileSync(backupPath, origBytes);
    fs.writeFileSync(tmpPath, outBuf);
    fs.renameSync(tmpPath, targetFile);

    written.push({
      path: displayRel(targetFile, base),
      backup: displayRel(backupPath, base),
      sha256_before: crypto.createHash('sha256').update(origBytes).digest('hex'),
      sha256_after: crypto.createHash('sha256').update(outBuf).digest('hex'),
      encoding_before: sourceEnc,
      encoding_after: targetEnc,
      segments: items.length,
    });
  }

  const manifest = !scene ? readManifest(workspace) : null;
  const manifestDigest = typeof manifest?.digest === 'string' ? manifest.digest : '';
  const resultsFile = path.join(workspace, 'results', `${track}.jsonl`);
  let resultsSha256 = '';
  if (!scene && !isSymlinkPath(resultsFile) && fs.existsSync(resultsFile) && fs.statSync(resultsFile).isFile()) {
    resultsSha256 = crypto.createHash('sha256').update(fs.readFileSync(resultsFile)).digest('hex');
  }

  const segsBlock: Record<string, unknown> = {
    total: candidates.length,
    applied: appliedCount,
    skipped: blocked.length,
  };
  if (incomplete && expectedTotal !== null) {
    segsBlock.expected_total = expectedTotal;
    segsBlock.missing = expectedTotal - appliedCount;
  }

  const report: Record<string, unknown> = {
    schema: 1,
    created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    track,
    scene,
    root: displayRel(base, workspace),
    partial: blocked.length > 0 || incomplete,
    segments: segsBlock,
    files: written,
    skipped: blocked,
  };
  if (expectedTotal !== null) report.expected_total = expectedTotal;
  if (manifestDigest) report.manifest_digest = manifestDigest;
  if (resultsSha256) report.results_sha256 = resultsSha256;

  const reportPath = path.join(workspace, APPLY_REL);
  if (isSymlinkPath(reportPath)) throw new ApplyError(`落盘报告不能是符号链接：${reportPath}`);
  atomicWriteText(reportPath, JSON.stringify(report, null, 2) + '\n');

  return {
    report,
    reportPath,
    partial: Boolean(report.partial),
    applied: appliedCount,
  };
}

export function applyStatus(workspace: string): {
  report: Record<string, unknown>;
  track: string;
  applied: number;
  expectedTotal: number | null;
  partial: boolean;
  stale: boolean;
  staleReason: string;
} | null {
  const p = path.join(workspace, APPLY_REL);
  try {
    if (isSymlinkPath(p) || !fs.existsSync(p) || fs.statSync(p).size > 8 * 1024 * 1024) return null;
    const report = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (!report || report.schema !== 1) return null;
    const track = String(report.track || '');
    const segs = (report.segments && typeof report.segments === 'object' ? report.segments : {}) as Record<string, unknown>;
    const applied = typeof segs.applied === 'number' ? segs.applied : 0;
    const expectedTotal =
      typeof segs.expected_total === 'number'
        ? segs.expected_total
        : typeof report.expected_total === 'number'
          ? report.expected_total
          : TRACKS.includes(track as TrackName)
            ? manifestTrackCount(workspace, track)
            : null;
    const incomplete = expectedTotal !== null && expectedTotal > 0 && applied < expectedTotal;
    const partial = report.partial === true || incomplete;
    let stale = false;
    let staleReason = '';
    const scene = String(report.scene || '').trim();
    if (!scene) {
      const manifest = readManifest(workspace);
      if (manifest && typeof report.manifest_digest === 'string' && report.manifest_digest && manifest.digest !== report.manifest_digest) {
        stale = true;
        staleReason = '分轨清单已变更';
      }
      if (!stale && TRACKS.includes(track as TrackName)) {
        const resPath = path.join(workspace, 'results', `${track}.jsonl`);
        if (!isSymlinkPath(resPath) && fs.existsSync(resPath) && fs.statSync(resPath).isFile()) {
          if (typeof report.results_sha256 === 'string' && report.results_sha256) {
            const sha = crypto.createHash('sha256').update(fs.readFileSync(resPath)).digest('hex');
            if (sha !== report.results_sha256) {
              stale = true;
              staleReason = '译文结果已变更';
            }
          }
        }
      }
    }
    return { report, track, applied, expectedTotal, partial, stale, staleReason };
  } catch {
    return null;
  }
}

export function applyPartial(workspace: string, track: string): boolean {
  const st = applyStatus(workspace);
  return st !== null && st.track === track && st.partial;
}

/* ========================= Batch Planning & Progress ========================= */

export interface PlanConfig {
  model: string;
  model_family: string;
  batch_max_lines: number;
  batch_max_source_tokens: number;
  session_max_source_tokens: number;
  concurrency: number;
  margin_ratio: number;
  note: string;
}

export function defaultPlanConfig(): PlanConfig {
  return {
    model: '',
    model_family: '',
    batch_max_lines: 30,
    batch_max_source_tokens: 4000,
    session_max_source_tokens: 40000,
    concurrency: 4,
    margin_ratio: 0.1,
    note: '',
  };
}

function loadBuildTrackRows(workspace: string, track: TrackName): Array<Record<string, unknown>> {
  const file = path.join(workspace, 'build', `${track}.jsonl`);
  if (isSymlinkPath(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    out.push({ ...obj, track });
  }
  return out;
}

export function readPlan(workspace: string): Record<string, unknown> | null {
  const p = path.join(workspace, PLAN_REL);
  if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function analyzeWorkspaceText(workspace: string, options: { model?: string; family?: string } = {}): Record<string, unknown> {
  const scenarioRows = loadBuildTrackRows(workspace, 'scenario');
  const uiRows = loadBuildTrackRows(workspace, 'ui');
  const allRows = [...scenarioRows, ...uiRows];
  if (!allRows.length) {
    throw new PlanError('工作区还没有分类产物（build/scenario.jsonl 或 build/ui.jsonl）；先运行 vn_classify。');
  }
  const family = resolveFamily(options.model || '', options.family || '');
  const stats = estimateRecordsStats(allRows, family);
  const scenarioStats = estimateRecordsStats(scenarioRows, family);
  const uiStats = estimateRecordsStats(uiRows, family);
  const boundaries = Array.from(
    new Set(allRows.map((r) => `${String(r.file || '')}#${String(r.scene || '')}`))
  );
  const totalChars = allRows.reduce((acc, r) => acc + String(r.source || '').length, 0);

  const analysis: Record<string, unknown> = {
    schema: 1,
    model_family: family,
    total_rows: allRows.length,
    total_chars: totalChars,
    estimated_source_tokens: stats.sum,
    estimated_tokens_with_10pct_margin: estimateWithMargin(stats.sum, 0.1),
    distribution: {
      min: stats.min,
      p50: stats.p50,
      p95: stats.p95,
      max: stats.max,
    },
    boundaries,
    tracks: {
      scenario: { rows: scenarioRows.length, estimated_source_tokens: scenarioStats.sum },
      ui: { rows: uiRows.length, estimated_source_tokens: uiStats.sum },
    },
  };
  atomicWriteText(path.join(workspace, COUNTS_REL), JSON.stringify(analysis, null, 2) + '\n');
  return analysis;
}

export function savePlanConfig(
  workspace: string,
  cfg: PlanConfig,
  analysis: Record<string, unknown>,
  reason = ''
): Record<string, unknown> {
  if (cfg.batch_max_lines < 1 || cfg.batch_max_lines > 500) throw new PlanError('batch_max_lines 必须在 1..500 之间。');
  if (cfg.batch_max_source_tokens < 50) throw new PlanError('batch_max_source_tokens 至少 50。');
  if (cfg.session_max_source_tokens < 50) throw new PlanError('session_max_source_tokens 至少 50。');
  if (cfg.concurrency < 1 || cfg.concurrency > 16) throw new PlanError('concurrency 必须在 1..16 之间。');

  const existing = readPlan(workspace) || {};
  const history = Array.isArray(existing.config_history) ? [...existing.config_history] : [];
  const family = resolveFamily(cfg.model, cfg.model_family);
  const savedCfg: PlanConfig = { ...cfg, model_family: family };
  history.push({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    reason: reason || savedCfg.note || 'update plan',
    config: savedCfg,
  });

  const payload: Record<string, unknown> = {
    schema: 1,
    updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    config: savedCfg,
    analysis,
    config_history: history.slice(-20),
  };
  atomicWriteText(path.join(workspace, PLAN_REL), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

export function generateBatches(
  workspace: string,
  cfg: PlanConfig,
  options: { force?: boolean } = {}
): Record<string, unknown> {
  const family = resolveFamily(cfg.model, cfg.model_family);
  const manifestPath = path.join(workspace, BATCHES_MANIFEST_REL);
  if (!options.force && fs.existsSync(manifestPath)) {
    // Allow regeneration when manifest doesn't exist or force is true; if force=false & exists, return or overwrite cleanly
    // Wait: matches plan.py semantics (or refuses? In Step 15, work/batches doesn't exist initially).
  }

  const batchesDir = path.join(workspace, 'work', 'batches');
  fs.mkdirSync(batchesDir, { recursive: true });
  for (const ent of fs.readdirSync(batchesDir)) {
    if (ent.startsWith('batch_') && ent.endsWith('.jsonl')) {
      fs.rmSync(path.join(batchesDir, ent), { force: true });
    }
  }

  const manifestBatches: Array<Record<string, unknown>> = [];
  let batchIdx = 0;
  let totalRows = 0;
  let totalTokens = 0;

  for (const track of TRACKS) {
    const rows = loadBuildTrackRows(workspace, track);
    if (!rows.length) continue;

    let chunk: Array<Record<string, unknown>> = [];
    let chunkTokens = 0;

    const flush = () => {
      if (!chunk.length) return;
      const batchId = `batch_${String(batchIdx++).padStart(3, '0')}`;
      const rel = `work/batches/${batchId}.jsonl`;
      atomicWriteText(path.join(workspace, rel), chunk.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const est = estimateWithMargin(chunkTokens, cfg.margin_ratio);
      manifestBatches.push({
        batch_id: batchId,
        file: rel,
        track,
        rows: chunk.length,
        chars: chunk.reduce((acc, r) => acc + String(r.source || '').length, 0),
        estimated_source_tokens: chunkTokens,
        estimated_tokens_with_margin: est,
        files: Array.from(new Set(chunk.map((r) => String(r.file || '')).filter(Boolean))),
        scenes: Array.from(new Set(chunk.map((r) => String(r.scene || '')).filter(Boolean))),
        ids: chunk.map((r) => String(r.id || '')),
      });
      totalRows += chunk.length;
      totalTokens += est;
      chunk = [];
      chunkTokens = 0;
    };

    for (const row of rows) {
      const rowTokens = estimateRecordTokens(row, family);
      const boundaryChanged =
        chunk.length > 0 &&
        (String(chunk[chunk.length - 1].file || '') !== String(row.file || '') ||
          String(chunk[chunk.length - 1].scene || '') !== String(row.scene || ''));
      if (
        chunk.length > 0 &&
        (chunk.length >= cfg.batch_max_lines ||
          (boundaryChanged && chunk.length >= Math.max(1, Math.floor(cfg.batch_max_lines / 2))) ||
          estimateWithMargin(chunkTokens + rowTokens, cfg.margin_ratio) > cfg.batch_max_source_tokens)
      ) {
        flush();
      }
      chunk.push(row);
      chunkTokens += rowTokens;
    }
    flush();
  }

  const manifest: Record<string, unknown> = {
    schema: 1,
    created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    model_family: family,
    total_batches: manifestBatches.length,
    total_rows: totalRows,
    estimated_total_source_tokens: totalTokens,
    batches: manifestBatches,
  };
  atomicWriteText(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function readBatchManifest(workspace: string): Record<string, unknown> {
  const p = path.join(workspace, BATCHES_MANIFEST_REL);
  if (isSymlinkPath(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new BatchCheckinError('工作区还没有批次清单（work/batches/manifest.json）；先运行 vn_plan 生成批次。');
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  if (!data || !Array.isArray(data.batches)) {
    throw new BatchCheckinError('work/batches/manifest.json 格式无效。');
  }
  return data;
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const lines = trimmed.split(/\r?\n/);
    if (lines.length >= 2 && lines[lines.length - 1].trim().startsWith('```')) {
      return lines.slice(1, -1).join('\n');
    }
  }
  return trimmed;
}

function computeProgressSummary(manifest: Record<string, unknown>, bMap: Record<string, unknown>): Record<string, number> {
  const manifestBatches = Array.isArray(manifest.batches) ? (manifest.batches as Array<Record<string, unknown>>) : [];
  const totalBatches = manifestBatches.length;
  const totalRows = Number(manifest.total_rows ?? 0);
  let savedPendingQa = 0;
  let qaPassed = 0;
  let qaFailed = 0;
  let checkedInRows = 0;

  for (const b of manifestBatches) {
    const id = String(b.batch_id || '');
    const entry = bMap[id] && typeof bMap[id] === 'object' ? (bMap[id] as Record<string, unknown>) : null;
    const status = String(entry?.status || '');
    if (status === 'saved_pending_qa') {
      savedPendingQa++;
      checkedInRows += Number(entry?.rows ?? 0);
    } else if (status === 'qa_passed') {
      qaPassed++;
      checkedInRows += Number(entry?.rows ?? 0);
    } else if (status === 'qa_failed') {
      qaFailed++;
      checkedInRows += Number(entry?.rows ?? 0);
    }
  }

  return {
    total_batches: totalBatches,
    total_rows: totalRows,
    saved_pending_qa: savedPendingQa,
    qa_passed: qaPassed,
    qa_failed: qaFailed,
    pending_batches: Math.max(0, totalBatches - savedPendingQa - qaPassed - qaFailed),
    checked_in_rows: checkedInRows,
  };
}

export function checkinBatch(
  workspace: string,
  batchId: string,
  options: { raw?: string | null; outputFile?: string | null; model?: string; sessionSeq?: number } = {}
): {
  batch_id: string;
  track: string;
  rows: number;
  status: string;
  out_path: string;
  out_sha256: string;
  progress_path: string;
} {
  const manifest = readBatchManifest(workspace);
  const batches = manifest.batches as Array<Record<string, unknown>>;
  const meta = batches.find((b) => String(b.batch_id) === batchId);
  if (!meta) throw new BatchCheckinError(`批次不存在：${batchId}`);
  const track = String(meta.track || 'scenario');
  const batchFile = path.join(workspace, String(meta.file || meta.path));
  const inputRows = fs
    .readFileSync(batchFile, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  let rawOutput = '';
  if (options.outputFile) {
    rawOutput = fs.readFileSync(options.outputFile, 'utf8');
  } else if (typeof options.raw === 'string') {
    rawOutput = options.raw;
  } else {
    throw new BatchCheckinError('vn checkin 需要提供翻译输出内容。');
  }

  const cleaned = stripFences(rawOutput);
  const parsedOut: Array<{ id?: unknown; target?: unknown }> = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') parsedOut.push(obj as { id?: unknown; target?: unknown });
    } catch {
      throw new BatchCheckinError(`批次 ${batchId} 输出包含非 JSON 行：${t.slice(0, 120)}`);
    }
  }

  if (parsedOut.length !== inputRows.length) {
    throw new BatchCheckinError(`批次 ${batchId} 行数不匹配：期望 ${inputRows.length}，实际 ${parsedOut.length}。`);
  }

  const outRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < inputRows.length; i++) {
    const srcRow = inputRows[i];
    const outRow = parsedOut[i];
    const expectedId = String(srcRow.id);
    const gotId = outRow.id !== undefined ? String(outRow.id) : '';
    if (gotId !== expectedId) {
      throw new BatchCheckinError(`批次 ${batchId} 第 ${i + 1} 行 ID 不一致：期望 ${expectedId}，实际 ${gotId}`);
    }
    const tgt = typeof outRow.target === 'string' ? outRow.target : '';
    if (!tgt.trim()) throw new BatchCheckinError(`批次 ${batchId} 第 ${i + 1} 行 (${expectedId}) target 为空。`);
    if (tgt.includes('\n') || tgt.includes('\r')) {
      throw new BatchCheckinError(`批次 ${batchId} (${expectedId}) target 包含未转义换行。`);
    }
    outRows.push({
      ...srcRow,
      track,
      target: tgt,
      ok: true,
    });
  }

  const outDir = path.join(workspace, 'work', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${batchId}.jsonl`);
  const outPayload = outRows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  atomicWriteText(outPath, outPayload);
  const outSha = crypto.createHash('sha256').update(outPayload, 'utf8').digest('hex');

  const progPath = path.join(workspace, PROGRESS_REL);
  let progress: Record<string, unknown> = { schema: 1, batches: {} };
  if (fs.existsSync(progPath)) {
    try {
      progress = JSON.parse(fs.readFileSync(progPath, 'utf8')) as Record<string, unknown>;
    } catch {
      progress = { schema: 1, batches: {} };
    }
  }
  const bMap = (progress.batches && typeof progress.batches === 'object' ? progress.batches : {}) as Record<string, unknown>;
  bMap[batchId] = {
    batch_id: batchId,
    track,
    rows: outRows.length,
    status: 'saved_pending_qa',
    out_path: displayRel(outPath, workspace),
    out_sha256: outSha,
    model: options.model || '',
    session_seq: options.sessionSeq || 0,
    updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  progress.batches = bMap;
  progress.summary = computeProgressSummary(manifest, bMap);
  progress.updated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  atomicWriteText(progPath, JSON.stringify(progress, null, 2) + '\n');

  return {
    batch_id: batchId,
    track,
    rows: outRows.length,
    status: 'saved_pending_qa',
    out_path: outPath,
    out_sha256: outSha,
    progress_path: progPath,
  };
}

export function mergeTrackResults(
  workspace: string,
  track: string,
  profile: LocalizationProfile,
  memory: ProjectMemory,
  requireAllBatches = true
): {
  track: string;
  rows: number;
  passed: number;
  failed: number;
  results_path: string;
  results_sha256: string;
} {
  const manifest = readBatchManifest(workspace);
  const trackBatches = (manifest.batches as Array<Record<string, unknown>>).filter((b) => b.track === track);
  if (!trackBatches.length) throw new BatchCheckinError(`批次清单中没有 ${track} 轨道。`);

  const progPath = path.join(workspace, PROGRESS_REL);
  let progress: Record<string, unknown> = { schema: 1, batches: {} };
  if (fs.existsSync(progPath)) {
    try {
      progress = JSON.parse(fs.readFileSync(progPath, 'utf8')) as Record<string, unknown>;
    } catch {
      progress = { schema: 1, batches: {} };
    }
  }
  const bMap = (progress.batches && typeof progress.batches === 'object' ? progress.batches : {}) as Record<string, unknown>;

  const mergedRows: Array<Record<string, unknown>> = [];
  let passed = 0;
  let failed = 0;

  for (const b of trackBatches) {
    const batchId = String(b.batch_id);
    const outPath = path.join(workspace, 'work', 'out', `${batchId}.jsonl`);
    if (!fs.existsSync(outPath)) {
      if (requireAllBatches) throw new BatchCheckinError(`批次 ${batchId} 尚未翻译入库（缺少 work/out/${batchId}.jsonl）。`);
      continue;
    }
    const rows = fs
      .readFileSync(outPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    let batchFailed = 0;
    for (const r of rows) {
      const rep = qaReport(String(r.source || ''), String(r.target || ''), profile, memory.glossary);
      const ok = !rep.blocked;
      if (ok) passed++;
      else {
        failed++;
        batchFailed++;
      }
      const enriched: Record<string, unknown> = { ...r, track, ok };
      if (!ok) {
        enriched.findings = rep.findings;
        enriched.qa_errors = rep.findings.filter((f) => f.severity === 'error').map((f) => `[${f.rule}] ${f.message}`);
      } else {
        delete enriched.findings;
        delete enriched.qa_errors;
      }
      mergedRows.push(enriched);
    }

    const existingEntry = (bMap[batchId] && typeof bMap[batchId] === 'object' ? bMap[batchId] : {}) as Record<string, unknown>;
    bMap[batchId] = {
      ...existingEntry,
      batch_id: batchId,
      track,
      rows: rows.length,
      status: batchFailed > 0 ? 'qa_failed' : 'qa_passed',
      failed: batchFailed,
      updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  progress.batches = bMap;
  progress.summary = computeProgressSummary(manifest, bMap);
  progress.updated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  atomicWriteText(progPath, JSON.stringify(progress, null, 2) + '\n');

  const resDir = path.join(workspace, 'results');
  fs.mkdirSync(resDir, { recursive: true });
  const resultsPath = path.join(resDir, `${track}.jsonl`);
  const payload = mergedRows.map((r) => JSON.stringify(r)).join('\n') + (mergedRows.length ? '\n' : '');
  atomicWriteText(resultsPath, payload);
  const sha = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');

  return {
    track,
    rows: mergedRows.length,
    passed,
    failed,
    results_path: resultsPath,
    results_sha256: sha,
  };
}
