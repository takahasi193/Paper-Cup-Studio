/**
 * Localization profile loader, project memory/persona/glossary store, and script encoding/skeleton utilities.
 * Pure TypeScript, zero external dependencies.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const POV_VALUES = new Set(['first', 'second', 'third', 'mixed']);
const SLUG_BAD = /[^A-Za-z0-9._-]+/g;
const MAX_LESSONS = 3;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

export class ProfileError extends Error {}
export class DecodeError extends Error {
  constructor(public readonly encoding: string) {
    super(`无法用编码 ${encoding} 解码脚本`);
  }
}
export class EncodeError extends Error {
  constructor(public readonly encoding: string) {
    super(`无法用编码 ${encoding} 表示发布稿`);
  }
}

export interface LocalizationProfile {
  narrativePov: string;
  playerAddress: string;
  mixedRules: string;
  sourceLang: string;
  targetLang: string;
  maxLenRatio: number;
  maxLenAbs: number;
  requireGlossary: boolean;
  residueCheck: boolean;
  glossaryFile: string;
  personaFile: string;
}

export interface ProfileLoad {
  configured: boolean;
  path: string | null;
  profile: LocalizationProfile | null;
  errors: string[];
}

export interface PersonaStage {
  fromScene: string;
  voice: string;
}

export interface PersonaTwist {
  atScene: string;
  note: string;
  reveals: string;
}

export interface PersonaCard {
  base: string;
  stages: PersonaStage[];
  twists: PersonaTwist[];
}

export interface ProjectMemory {
  glossary: Record<string, string>;
  persona: Record<string, PersonaCard>;
  lessons: Array<{ cue: string; lesson: string; evidence: string }>;
  personaErrors: string[];
}

export interface ReadinessState {
  ready: boolean;
  quality: 'ok' | 'unreviewed' | 'degraded';
  reasons: string[];
}

export function resolveHomeDir(): string {
  const override = (process.env.PAPERCUP_HOME || '').trim();
  if (override) return path.resolve(override);
  const home = (process.env.USERPROFILE || process.env.HOME || os.homedir()).trim();
  return path.join(home, '.papercup');
}

function slug(name: string): string {
  const cleaned = name.replace(SLUG_BAD, '_').replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || 'project';
}

export function realpathSafe(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function normCaseForHash(p: string): string {
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\').toLowerCase();
  }
  return p;
}

export function projectStorageDir(workspace: string, homeDir?: string | null): string {
  const resolved = realpathSafe(workspace);
  if (!homeDir) {
    return path.join(resolved, '.papercup', 'sessions');
  }
  const digest = crypto.createHash('sha256').update(normCaseForHash(resolved), 'utf8').digest('hex').slice(0, 8);
  return path.join(homeDir, 'projects', `${slug(path.basename(resolved))}_${digest}`, 'sessions');
}

export function projectExperienceDir(workspace: string, homeDir?: string | null): string {
  return path.join(path.dirname(projectStorageDir(workspace, homeDir)), 'experience');
}

export function projectHarnessDir(workspace: string, homeDir?: string | null): string {
  return path.join(path.dirname(projectStorageDir(workspace, homeDir)), 'harness');
}

export function insideWorkspace(workspace: string, candidatePath: string): string | null {
  try {
    const base = realpathSafe(workspace);
    const abs = path.isAbsolute(candidatePath) ? candidatePath : path.join(base, candidatePath);
    const resolved = fs.existsSync(abs) ? realpathSafe(abs) : path.resolve(abs);
    const rel = path.relative(base, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return resolved;
    }
    return null;
  } catch {
    return null;
  }
}

export function displayRel(targetPath: string, workspace: string): string {
  try {
    const rel = path.relative(realpathSafe(workspace), realpathSafe(targetPath));
    return rel ? rel.replace(/\\/g, '/') : path.basename(targetPath);
  } catch {
    return path.basename(targetPath);
  }
}

export function isSymlinkPath(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function stripTomlComment(line: string): string {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      escaped = false;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlValue(raw: string): unknown {
  const s = raw.trim();
  if (!s) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.startsWith('"')) {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s.slice(1, -1);
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
  }
  return s;
}

function parseLocalizationToml(text: string): Record<string, unknown> {
  const sections: Record<string, Record<string, unknown>> = {};
  let currentSection = '';
  const cleaned = text.replace(/^\uFEFF/, '');
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const val = parseTomlValue(line.slice(eq + 1));
    if (!sections[currentSection]) sections[currentSection] = {};
    sections[currentSection][key] = val;
  }
  return sections['vn.localization'] || {};
}

export function loadProfile(workspace: string): ProfileLoad {
  const candidates = [
    path.join(workspace, '.papercup', 'vn', 'profile.toml'),
    path.join(workspace, 'papercup.toml'),
  ];
  let chosen: string | null = null;
  for (const cand of candidates) {
    if (!isSymlinkPath(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      chosen = cand;
      break;
    }
  }
  if (!chosen) {
    return { configured: false, path: null, profile: null, errors: [] };
  }
  let raw = '';
  try {
    raw = fs.readFileSync(chosen, 'utf8');
  } catch (err) {
    return { configured: true, path: chosen, profile: null, errors: [`无法读取配置文件：${err}`] };
  }
  const tbl = parseLocalizationToml(raw);
  if (Object.keys(tbl).length === 0) {
    return { configured: false, path: chosen, profile: null, errors: [] };
  }

  const errors: string[] = [];
  const pov = typeof tbl.narrative_pov === 'string' ? tbl.narrative_pov.trim().toLowerCase() : '';
  if (!pov || !POV_VALUES.has(pov)) {
    errors.push('narrative_pov 必须是 first、second、third 或 mixed。');
  }
  const playerAddress = typeof tbl.player_address === 'string' ? tbl.player_address.trim() : '';
  const mixedRules = typeof tbl.mixed_rules === 'string' ? tbl.mixed_rules.trim() : '';
  const sourceLang = typeof tbl.source_lang === 'string' && tbl.source_lang.trim() ? tbl.source_lang.trim() : 'ja';
  const targetLang = typeof tbl.target_lang === 'string' && tbl.target_lang.trim() ? tbl.target_lang.trim() : 'zh';
  const maxLenRatio =
    typeof tbl.max_len_ratio === 'number' && Number.isFinite(tbl.max_len_ratio) && tbl.max_len_ratio >= 0
      ? tbl.max_len_ratio
      : 0;
  const maxLenAbs =
    typeof tbl.max_len_abs === 'number' && Number.isInteger(tbl.max_len_abs) && tbl.max_len_abs >= 0
      ? tbl.max_len_abs
      : 0;
  const requireGlossary = typeof tbl.require_glossary === 'boolean' ? tbl.require_glossary : false;
  const residueCheck = typeof tbl.residue_check === 'boolean' ? tbl.residue_check : true;
  const glossaryFile = typeof tbl.glossary_file === 'string' ? tbl.glossary_file.trim() : '';
  const personaFile = typeof tbl.persona_file === 'string' ? tbl.persona_file.trim() : '';

  if (errors.length > 0) {
    return { configured: true, path: chosen, profile: null, errors };
  }
  return {
    configured: true,
    path: chosen,
    profile: {
      narrativePov: pov,
      playerAddress,
      mixedRules,
      sourceLang,
      targetLang,
      maxLenRatio,
      maxLenAbs,
      requireGlossary,
      residueCheck,
      glossaryFile,
      personaFile,
    },
    errors: [],
  };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    if (isSymlinkPath(filePath) || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parsePersonaMap(data: Record<string, unknown>): {
  cards: Record<string, PersonaCard>;
  errors: string[];
} {
  const cards: Record<string, PersonaCard> = {};
  const errors: string[] = [];
  for (const [rawName, val] of Object.entries(data)) {
    const name = String(rawName).trim();
    if (!name) {
      errors.push('人设的键必须是非空字符串。');
      continue;
    }
    if (typeof val === 'string') {
      const text = val.trim();
      if (text) cards[name] = { base: text, stages: [], twists: [] };
      else errors.push(`人设「${name}」不能为空字符串。`);
      continue;
    }
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      errors.push(`人设「${name}」必须是字符串或对象。`);
      continue;
    }
    const obj = val as Record<string, unknown>;
    const base = typeof obj.base === 'string' ? obj.base.trim() : '';
    const stages: PersonaStage[] = [];
    const twists: PersonaTwist[] = [];
    if (Array.isArray(obj.stages)) {
      for (const st of obj.stages) {
        if (st && typeof st === 'object' && !Array.isArray(st)) {
          const rec = st as Record<string, unknown>;
          const from = typeof rec.from === 'string' ? rec.from.trim() : '';
          const voice = typeof rec.voice === 'string' ? rec.voice.trim() : '';
          if (from && voice) stages.push({ fromScene: from, voice });
        }
      }
    }
    if (Array.isArray(obj.twists)) {
      for (const tw of obj.twists) {
        if (tw && typeof tw === 'object' && !Array.isArray(tw)) {
          const rec = tw as Record<string, unknown>;
          const at = typeof rec.at === 'string' ? rec.at.trim() : '';
          const note = typeof rec.note === 'string' ? rec.note.trim() : '';
          const reveals = typeof rec.reveals === 'string' ? rec.reveals.trim() : '';
          if (at && note) twists.push({ atScene: at, note, reveals });
        }
      }
    }
    if (!base && stages.length === 0 && twists.length === 0) {
      errors.push(`人设「${name}」缺少 base、stages 或 twists。`);
      continue;
    }
    cards[name] = { base, stages, twists };
  }
  return { cards, errors };
}

function readLessons(filePath: string): Array<{ cue: string; lesson: string; evidence: string }> {
  try {
    if (isSymlinkPath(filePath) || !fs.existsSync(filePath)) return [];
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return [];
    const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const out: Array<{ cue: string; lesson: string; evidence: string }> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        out.push({
          cue: String((obj as Record<string, unknown>).cue ?? ''),
          lesson: String((obj as Record<string, unknown>).lesson ?? ''),
          evidence: String((obj as Record<string, unknown>).evidence ?? ''),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function loadMemory(workspace: string, homeDir?: string | null): ProjectMemory {
  const root = projectExperienceDir(workspace, homeDir);
  const rawPersona = readJsonObject(path.join(root, 'persona.json')) || {};
  const { cards, errors } = parsePersonaMap(rawPersona);
  const rawGlossary = readJsonObject(path.join(root, 'glossary.json')) || {};
  const glossary: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawGlossary)) {
    const ks = String(k).trim();
    const vs = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    if (ks && vs) glossary[ks] = vs;
  }
  return {
    glossary,
    persona: cards,
    lessons: readLessons(path.join(root, 'lessons.jsonl')),
    personaErrors: errors,
  };
}

export function loadProfileMemory(workspace: string, homeDir: string | null, profile: LocalizationProfile): ProjectMemory {
  const base = loadMemory(workspace, homeDir);
  const glossary = { ...base.glossary };
  let persona = { ...base.persona };
  const personaErrors = [...base.personaErrors];

  if (profile.glossaryFile) {
    const resolved = insideWorkspace(workspace, profile.glossaryFile);
    if (!resolved || isSymlinkPath(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ProfileError(`glossary_file 不存在或不在工作区内：${profile.glossaryFile}`);
    }
    const extra = readJsonObject(resolved);
    if (!extra) {
      throw new ProfileError(`glossary_file 不是合法的 JSON 对象：${profile.glossaryFile}`);
    }
    for (const [k, v] of Object.entries(extra)) {
      const ks = String(k).trim();
      const vs = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
      if (ks && vs) glossary[ks] = vs;
    }
  }

  if (profile.personaFile) {
    const resolved = insideWorkspace(workspace, profile.personaFile);
    if (!resolved || isSymlinkPath(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ProfileError(`persona_file 不存在或不在工作区内：${profile.personaFile}`);
    }
    const extraPersona = readJsonObject(resolved);
    if (!extraPersona) {
      throw new ProfileError(`persona_file 不是合法的 JSON 对象：${profile.personaFile}`);
    }
    const parsed = parsePersonaMap(extraPersona);
    persona = { ...persona, ...parsed.cards };
    personaErrors.push(...parsed.errors);
  }

  return { glossary, persona, lessons: base.lessons, personaErrors };
}

export function readiness(profile: LocalizationProfile, memory: ProjectMemory): ReadinessState {
  const reasons: string[] = [];
  if (memory.personaErrors.length > 0) {
    reasons.push(...memory.personaErrors);
  }
  if (profile.requireGlossary && Object.keys(memory.glossary).length === 0) {
    reasons.push('require_glossary=true，但术语表为空。');
  }
  const quality: 'ok' | 'unreviewed' | 'degraded' =
    reasons.length > 0 ? 'degraded' : Object.keys(memory.glossary).length > 0 || Object.keys(memory.persona).length > 0 ? 'ok' : 'ok';
  return {
    ready: reasons.length === 0,
    quality,
    reasons,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',') + '}';
}

export function profileDigest(profile: LocalizationProfile): string {
  const payload = {
    glossary_file: profile.glossaryFile,
    max_len_abs: profile.maxLenAbs,
    max_len_ratio: profile.maxLenRatio,
    mixed_rules: profile.mixedRules,
    narrative_pov: profile.narrativePov,
    persona_file: profile.personaFile,
    player_address: profile.playerAddress,
    require_glossary: profile.requireGlossary,
    residue_check: profile.residueCheck,
    source_lang: profile.sourceLang,
    target_lang: profile.targetLang,
  };
  return crypto.createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

function digestCard(name: string, card: PersonaCard): unknown[] {
  return [
    name,
    card.base,
    card.stages.map((s) => [s.fromScene, s.voice]),
    card.twists.map((t) => [t.atScene, t.note, t.reveals]),
  ];
}

export function personaDigest(persona: Record<string, PersonaCard>): string {
  const arr = Object.entries(persona)
    .map(([n, c]) => digestCard(n, c))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(stableJson(arr), 'utf8').digest('hex');
}

export function memoryDigest(memory: ProjectMemory): string {
  const payload = {
    glossary: Object.entries(memory.glossary).sort((a, b) => a[0].localeCompare(b[0])),
    lessons: memory.lessons.slice(-MAX_LESSONS).map((l) => [l.cue, l.lesson, l.evidence]),
    persona: Object.entries(memory.persona)
      .map(([n, c]) => digestCard(n, c))
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return crypto.createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

/* ---------- Skeleton, Line Split & CP932/UTF-8 Encoding ---------- */

export type PieceKind = 'text' | 'literal' | 'control';
export type EngineProfile = 'kag' | 'renpy';

export interface Piece {
  kind: PieceKind;
  value: string;
}

export class Skeleton {
  constructor(
    public readonly pieces: Piece[] = [],
    public readonly profile: EngineProfile = 'kag'
  ) {}

  source(): string {
    return this.pieces.map((p) => p.value).join('');
  }

  textSlots(): string[] {
    return this.pieces.filter((p) => p.kind === 'text').map((p) => p.value);
  }

  hasText(): boolean {
    return this.pieces.some((p) => p.kind === 'text');
  }
}

export interface SplitLines {
  newline: string;
  trailingNewline: boolean;
  lines: string[];
}

export interface ParsedLine {
  locked: boolean;
  speaker: string | null;
  anchor: string | null;
  skeleton: Skeleton;
}

export function splitLines(text: string): SplitLines {
  if (!text) return { newline: '\n', trailingNewline: false, lines: [] };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith(newline);
  const parts = text.split(newline);
  if (trailingNewline) parts.pop();
  return { newline, trailingNewline, lines: parts };
}

function pushTextPiece(buffer: string, pieces: Piece[]): void {
  if (!buffer) return;
  const trimmed = buffer.trim();
  if (!trimmed) {
    pieces.push({ kind: 'literal', value: buffer });
    return;
  }
  const start = buffer.indexOf(trimmed);
  const end = start + trimmed.length;
  if (start > 0) pieces.push({ kind: 'literal', value: buffer.slice(0, start) });
  pieces.push({ kind: 'text', value: trimmed });
  if (end < buffer.length) pieces.push({ kind: 'literal', value: buffer.slice(end) });
}

export function lexInline(inputText: string, profile: EngineProfile = 'kag'): Skeleton {
  const pieces: Piece[] = [];
  let text = '';
  let i = 0;
  while (i < inputText.length) {
    const ch = inputText[i];
    if (ch === '\\' && inputText[i + 1] === 'n') {
      pushTextPiece(text, pieces);
      text = '';
      pieces.push({ kind: 'control', value: '\\n' });
      i += 2;
      continue;
    }
    if (ch === '\r') {
      pushTextPiece(text, pieces);
      text = '';
      if (inputText[i + 1] === '\n') {
        pieces.push({ kind: 'control', value: '\r\n' });
        i += 2;
      } else {
        pieces.push({ kind: 'control', value: '\r' });
        i += 1;
      }
      continue;
    }
    if (ch === '\n') {
      pushTextPiece(text, pieces);
      text = '';
      pieces.push({ kind: 'control', value: '\n' });
      i += 1;
      continue;
    }
    if (profile === 'renpy' && ((ch === '{' && inputText[i + 1] === '{') || (ch === '}' && inputText[i + 1] === '}') || (ch === '[' && inputText[i + 1] === '[') || (ch === ']' && inputText[i + 1] === ']'))) {
      pushTextPiece(text, pieces);
      text = '';
      pieces.push({ kind: 'control', value: ch + ch });
      i += 2;
      continue;
    }
    if (ch === '[' || (profile === 'renpy' && ch === '{')) {
      pushTextPiece(text, pieces);
      text = '';
      const closer = ch === '[' ? ']' : '}';
      const closeIdx = inputText.indexOf(closer, i + 1);
      if (closeIdx < 0) {
        pieces.push({ kind: 'control', value: inputText.slice(i) });
        i = inputText.length;
      } else {
        pieces.push({ kind: 'control', value: inputText.slice(i, closeIdx + 1) });
        i = closeIdx + 1;
      }
      continue;
    }
    if (ch === ']' || (profile === 'renpy' && ch === '}')) {
      pushTextPiece(text, pieces);
      text = '';
      pieces.push({ kind: 'control', value: ch });
      i += 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  pushTextPiece(text, pieces);
  return new Skeleton(pieces, profile);
}

function splitKsSpeaker(line: string): { speaker: string | null; prefix: Piece | null; rest: string } {
  if (!line.startsWith('【')) return { speaker: null, prefix: null, rest: line };
  const end = line.indexOf('】');
  if (end < 0) return { speaker: null, prefix: null, rest: line };
  const name = line.slice(1, end);
  if (!name.trim()) return { speaker: null, prefix: null, rest: line };
  return {
    speaker: name,
    prefix: { kind: 'control', value: line.slice(0, end + 1) },
    rest: line.slice(end + 1),
  };
}

export function parseKsLine(line: string): ParsedLine {
  const trimmed = line.replace(/^\s+/, '');
  if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith(';')) {
    return {
      locked: true,
      speaker: null,
      anchor: null,
      skeleton: new Skeleton(line ? [{ kind: 'control', value: line }] : [], 'kag'),
    };
  }
  if (trimmed.startsWith('*')) {
    const rest = trimmed.replace(/^\*+\s*/, '');
    const anchor = rest.split('|', 1)[0].trim();
    return {
      locked: true,
      speaker: null,
      anchor,
      skeleton: new Skeleton(line ? [{ kind: 'control', value: line }] : [], 'kag'),
    };
  }
  const { speaker, prefix, rest } = splitKsSpeaker(line);
  const skel = lexInline(rest, 'kag');
  const pieces = prefix ? [prefix, ...skel.pieces] : skel.pieces;
  const full = new Skeleton(pieces, 'kag');
  return { locked: !full.hasText(), speaker, anchor: null, skeleton: full };
}

function tryDecode(buf: Buffer, encoding: 'utf-8' | 'shift_jis'): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function hasKana(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3040 && c <= 0x309f) || (c >= 0x30a0 && c <= 0x30ff)) return true;
  }
  return false;
}

function cjkScore(text: string): number {
  if (!text) return 0;
  let hits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x2000 && code <= 0x206f) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xff01 && code <= 0xff60)
    ) {
      hits += 1;
    }
  }
  return hits / text.length;
}

function isAsciiBuffer(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) return false;
  }
  return true;
}

export function detectEncoding(data: Buffer): string {
  if (data.length === 0) return 'utf-8';
  if (data.subarray(0, 3).equals(UTF8_BOM)) return 'utf-8-bom';
  const utf8 = tryDecode(data, 'utf-8');
  const cp932 = tryDecode(data, 'shift_jis');
  if (utf8 !== null && cp932 === null) return 'utf-8';
  if (cp932 !== null && utf8 === null) return 'cp932';
  if (utf8 === null) throw new DecodeError('unknown');
  if (isAsciiBuffer(data) || hasKana(utf8) || cjkScore(utf8) >= cjkScore(cp932!)) {
    return 'utf-8';
  }
  return 'cp932';
}

export function decodeBytes(data: Buffer, encoding?: string | null): { text: string; encoding: string } {
  const chosen = (encoding || '').trim().toLowerCase() || detectEncoding(data);
  if (chosen === 'utf-8-bom' || chosen === 'utf-8-sig') {
    const slice = data.subarray(0, 3).equals(UTF8_BOM) ? data.subarray(3) : data;
    const text = tryDecode(slice, 'utf-8');
    if (text === null) throw new DecodeError(chosen);
    return { text, encoding: 'utf-8-bom' };
  }
  if (chosen === 'utf-8' || chosen === 'utf8') {
    const slice = data.subarray(0, 3).equals(UTF8_BOM) ? data.subarray(3) : data;
    const text = tryDecode(slice, 'utf-8');
    if (text === null) throw new DecodeError('utf-8');
    return { text, encoding: 'utf-8' };
  }
  if (chosen === 'cp932' || chosen === 'shift_jis' || chosen === 'shift-jis' || chosen === 'sjis') {
    const text = tryDecode(data, 'shift_jis');
    if (text === null) throw new DecodeError(chosen);
    return { text, encoding: 'cp932' };
  }
  if (chosen === 'utf-16le' || chosen === 'utf16le') {
    const slice = data.subarray(0, 2).equals(UTF16LE_BOM) ? data.subarray(2) : data;
    return { text: slice.toString('utf16le'), encoding: 'utf-16le' };
  }
  try {
    const text = new TextDecoder(chosen, { fatal: true }).decode(data);
    return { text, encoding: chosen };
  } catch {
    throw new DecodeError(chosen);
  }
}

let cp932ReverseMap: Map<string, number[]> | null = null;
function getCp932EncodeMap(): Map<string, number[]> {
  if (cp932ReverseMap) return cp932ReverseMap;
  const map = new Map<string, number[]>();
  const dec = new TextDecoder('shift_jis', { fatal: true });
  // Half-width katakana 0xA1..0xDF
  const single = Buffer.alloc(1);
  for (let b = 0xa1; b <= 0xdf; b++) {
    single[0] = b;
    try {
      const ch = dec.decode(single);
      if (!map.has(ch)) map.set(ch, [b]);
    } catch {
      // ignore unmapped
    }
  }
  // Double-byte Shift_JIS / CP932
  const dbl = Buffer.alloc(2);
  for (let b1 = 0x81; b1 <= 0xfc; b1++) {
    if (b1 > 0x9f && b1 < 0xe0) continue;
    dbl[0] = b1;
    for (let b2 = 0x40; b2 <= 0xfc; b2++) {
      if (b2 === 0x7f) continue;
      dbl[1] = b2;
      try {
        const ch = dec.decode(dbl);
        if (!map.has(ch)) map.set(ch, [b1, b2]);
      } catch {
        // ignore unmapped
      }
    }
  }
  cp932ReverseMap = map;
  return map;
}

export function normalizeEncodingName(value?: string | null): string | null {
  if (!value) return null;
  const name = value.trim().toLowerCase();
  if (!name) return null;
  if (name === 'utf-8-bom' || name === 'utf-8-sig') return 'utf-8-bom';
  if (name === 'utf-8' || name === 'utf8') return 'utf-8';
  if (name === 'cp932' || name === 'shift_jis' || name === 'shift-jis' || name === 'sjis') return 'cp932';
  if (name === 'utf-16le' || name === 'utf16le') return 'utf-16le';
  throw new Error(`不支持的写回编码：${value}`);
}

export function encodeText(text: string, encoding: string): Buffer {
  const norm = encoding.trim().toLowerCase();
  if (norm === 'utf-8-bom' || norm === 'utf-8-sig') {
    return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]);
  }
  if (norm === 'utf-8' || norm === 'utf8') {
    return Buffer.from(text, 'utf8');
  }
  if (norm === 'utf-16le' || norm === 'utf16le') {
    return Buffer.from(text, 'utf16le');
  }
  if (norm === 'cp932' || norm === 'shift_jis' || norm === 'shift-jis' || norm === 'sjis') {
    const rev = getCp932EncodeMap();
    const out: number[] = [];
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (code <= 0x7f) {
        out.push(code);
        continue;
      }
      const mapped = rev.get(ch);
      if (!mapped) throw new EncodeError(encoding);
      for (const byte of mapped) out.push(byte);
    }
    return Buffer.from(out);
  }
  throw new EncodeError(encoding);
}

export function decodeCp932Bytes(buf: Buffer): string {
  try {
    return new TextDecoder('shift_jis', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

export function encodeCp932Bytes(text: string): Buffer {
  return encodeText(text, 'cp932');
}
