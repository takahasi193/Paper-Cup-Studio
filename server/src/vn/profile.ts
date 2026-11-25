/**
 * Localization profile loader, project memory/persona/glossary store, and script encoding/skeleton utilities.
 * Pure TypeScript, zero external dependencies.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE_CHARACTERS_REL, resolveWorkspacePaths } from './workspace-paths.js';
import { findSkillPackageByEngine } from './skill-registry.js';
import { normalizeProxyDllName, type ProxyDllName } from './win32-proxy.js';

export const POV_VALUES = new Set(['first', 'second', 'third', 'mixed', 'source']);
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
  constructor(public readonly encoding: string, detail?: string) {
    super(detail ? `无法用编码 ${encoding} 表示发布稿：${detail}` : `无法用编码 ${encoding} 表示发布稿`);
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
  requireCharacterConfirmation?: boolean;
  glossaryFile: string;
  personaFile: string;
}

export const CHARACTERS_REL = WORKSPACE_CHARACTERS_REL;

export type CharacterGender = 'female' | 'male' | 'unknown' | 'other';

export interface CharacterAlias {
  source: string;
  target: string;
}

export interface CharacterRosterEntry {
  id: string;
  sourceName: string;
  targetName: string;
  speakerIds: string[];
  aliases: CharacterAlias[];
  gender: CharacterGender;
  note?: string;
  occurrences: number;
  samples: string[];
}

export interface CharacterRosterStore {
  schema: 1;
  status: 'draft' | 'locked';
  classifyDigest: string;
  updatedAt: string;
  confirmedAt?: string;
  formId?: string;
  characters: CharacterRosterEntry[];
  dismissedNames?: string[];
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
  characters?: CharacterRosterEntry[];
  charactersStatus?: 'none' | 'draft' | 'locked';
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
    return resolveWorkspacePaths(resolved).sessionsDir;
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

export function resolvePathWithAncestors(targetPath: string, maxSymlinkHops = 16): string | null {
  let cur = path.resolve(targetPath);
  const tail: string[] = [];
  let hops = 0;

  while (true) {
    if (isSymlinkPath(cur)) {
      if (hops >= maxSymlinkHops) return null;
      hops++;
      try {
        const rawTarget = fs.readlinkSync(cur);
        const cleanedTarget = process.platform === 'win32' ? rawTarget.replace(/^\\\\\?\\/, '') : rawTarget;
        cur = path.resolve(path.dirname(cur), cleanedTarget);
        continue;
      } catch {
        return null;
      }
    }
    if (fs.existsSync(cur)) {
      const real = realpathSafe(cur);
      return tail.length ? path.resolve(real, ...tail.reverse()) : real;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return tail.length ? path.resolve(cur, ...tail.reverse()) : cur;
    }
    tail.push(path.basename(cur));
    cur = parent;
  }
}

export function insideWorkspace(workspace: string, candidatePath: string): string | null {
  try {
    const base = realpathSafe(workspace);
    const abs = path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(base, candidatePath);
    const resolved = resolvePathWithAncestors(abs);
    if (!resolved) return null;
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

export type TranslatorMode = 'cloud_subagent' | 'local_mt';
export type LocalMtPreset = 'sakura' | 'hy-mt' | 'plain-lines';

export interface TranslatorOverrideConfig {
  mode?: TranslatorMode;
  baseUrl?: string;
  model?: string;
  ollamaPath?: string;
  preset?: LocalMtPreset;
  packetLines?: number;
  concurrency?: number;
  contextWindow?: number;
  timeoutMs?: number;
  escalateFailedRows?: boolean;
  useTmCache?: boolean;
  disableThinking?: boolean;
}

export type PatchHookMode = 'auto' | 'win32_proxy' | 'none';
export type RuntimeCharsetHint = 'shift_jis' | 'gbk' | 'unicode';

export function normalizeRuntimeCharsetHint(raw?: unknown): RuntimeCharsetHint | undefined {
  if (typeof raw === 'number') {
    if (raw === 128) return 'shift_jis';
    if (raw === 134) return 'gbk';
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'shift_jis' || s === 'shift-jis' || s === 'sjis' || s === 'cp932' || s === '0x80' || s === '128') {
    return 'shift_jis';
  }
  if (s === 'gbk' || s === 'cp936' || s === 'gb2312' || s === '0x86' || s === '134') {
    return 'gbk';
  }
  if (
    s === 'unicode' ||
    s === 'utf-8' ||
    s === 'utf8' ||
    s === 'utf-16' ||
    s === 'utf16' ||
    s === 'utf-16le' ||
    s === 'utf-16le-bom' ||
    s === 'utf-8-bom'
  ) {
    return 'unicode';
  }
  return undefined;
}

export interface PatchConfig {
  mode: 'delta_patch';
  encoding: string;
  hookMode: PatchHookMode;
  proxyDll?: ProxyDllName;
  runtimeCharset?: RuntimeCharsetHint;
  codepage?: number;
  charset?: number;
  fontName?: string;
  forceFontName?: boolean;
  enableWidthCompat?: boolean;
  customOptions?: Record<string, string | number | boolean>;
}

export function parseTomlSections(text: string): Record<string, Record<string, unknown>> {
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
  return sections;
}

function parseLocalizationToml(text: string): Record<string, unknown> {
  return parseTomlSections(text)['vn.localization'] || {};
}

export function pickTomlString(tbl: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = tbl[key];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

export function pickTomlBool(tbl: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = tbl[key];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

export function pickTomlInt(
  tbl: Record<string, unknown>,
  min: number,
  max: number,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const v = tbl[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(min, Math.min(max, Math.round(v)));
    }
  }
  return undefined;
}

export function readWorkspaceTomlSection(workspace: string, section: string): Record<string, unknown> | null {
  const wsPaths = resolveWorkspacePaths(workspace);
  const candidates = [
    wsPaths.profileTomlFile,
    wsPaths.papercupTomlFile,
  ];
  for (const cand of candidates) {
    if (isSymlinkPath(cand) || !fs.existsSync(cand)) continue;
    try {
      if (!fs.statSync(cand).isFile()) continue;
      const raw = fs.readFileSync(cand, 'utf8');
      const tbl = parseTomlSections(raw)[section];
      if (!tbl || Object.keys(tbl).length === 0) continue;
      return tbl;
    } catch {
      // Ignore unreadable override file
    }
  }
  return null;
}

export function loadWorkspaceTranslatorOverride(workspace: string): TranslatorOverrideConfig | null {
  const tbl = readWorkspaceTomlSection(workspace, 'vn.translator');
  if (!tbl) return null;

  const out: TranslatorOverrideConfig = {};
  const rawMode = pickTomlString(tbl, 'mode');
  if (rawMode === 'cloud_subagent' || rawMode === 'local_mt') {
    out.mode = rawMode;
  }
  const baseUrl = pickTomlString(tbl, 'base_url', 'baseUrl');
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        out.baseUrl = baseUrl.replace(/\/+$/, '');
      }
    } catch {
      // Ignore invalid URL in workspace override
    }
  }
  const model = pickTomlString(tbl, 'model');
  if (model) out.model = model;

  const ollamaPath = pickTomlString(tbl, 'ollama_path', 'ollamaPath');
  if (ollamaPath) out.ollamaPath = ollamaPath;

  const rawPreset = pickTomlString(tbl, 'preset');
  if (rawPreset === 'sakura' || rawPreset === 'hy-mt' || rawPreset === 'plain-lines') {
    out.preset = rawPreset;
  }

  const packetLines = pickTomlInt(tbl, 1, 50, 'packet_lines', 'packetLines');
  if (packetLines !== undefined) out.packetLines = packetLines;

  const concurrency = pickTomlInt(tbl, 1, 8, 'concurrency');
  if (concurrency !== undefined) out.concurrency = concurrency;

  const contextWindow = pickTomlInt(tbl, 0, 12, 'context_window', 'contextWindow');
  if (contextWindow !== undefined) out.contextWindow = contextWindow;

  const timeoutMs = pickTomlInt(tbl, 5000, 600000, 'timeout_ms', 'timeoutMs');
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  const escalateFailedRows = pickTomlBool(tbl, 'escalate_failed_rows', 'escalateFailedRows');
  if (escalateFailedRows !== undefined) out.escalateFailedRows = escalateFailedRows;

  const useTmCache = pickTomlBool(tbl, 'use_tm_cache', 'useTmCache');
  if (useTmCache !== undefined) out.useTmCache = useTmCache;

  const disableThinking = pickTomlBool(tbl, 'disable_thinking', 'disableThinking');
  if (disableThinking !== undefined) out.disableThinking = disableThinking;

  return Object.keys(out).length > 0 ? out : null;
}

const RESERVED_PATCH_TOML_KEYS = new Set([
  'mode',
  'encoding',
  'hook_mode',
  'hookMode',
  'proxy_dll',
  'proxyDll',
  'runtime_charset',
  'runtimeCharset',
  'codepage',
  'charset',
  'font_name',
  'fontName',
  'force_font_name',
  'forceFontName',
  'enable_width_compat',
  'enableWidthCompat',
]);

export function loadWorkspacePatchConfig(workspace: string): PatchConfig {
  const out: PatchConfig = {
    mode: 'delta_patch',
    encoding: 'auto',
    hookMode: 'auto',
  };
  const tbl = readWorkspaceTomlSection(workspace, 'vn.patch');
  if (!tbl) return out;

  const rawEncoding = pickTomlString(tbl, 'encoding');
  if (rawEncoding) {
    const trimmed = rawEncoding.trim();
    const low = trimmed.toLowerCase();
    if (low === 'auto') {
      out.encoding = 'auto';
    } else {
      const builtin = tryNormalizeBuiltinEncoding(trimmed);
      if (builtin) {
        out.encoding = builtin;
      } else if (isSafeCustomEncodingName(trimmed)) {
        // Keep declared custom encoding name for downstream validation against skill engine.json
        out.encoding = low;
      } else {
        throw new Error(`不支持的写回编码：${rawEncoding}`);
      }
    }
  }
  const rawHook = pickTomlString(tbl, 'hook_mode', 'hookMode');
  if (rawHook === 'auto' || rawHook === 'win32_proxy' || rawHook === 'none') {
    out.hookMode = rawHook;
  }
  const proxyDll = normalizeProxyDllName(pickTomlString(tbl, 'proxy_dll', 'proxyDll'));
  if (proxyDll) out.proxyDll = proxyDll;
  const runtimeCharset = normalizeRuntimeCharsetHint(tbl.runtime_charset ?? tbl.runtimeCharset);
  if (runtimeCharset) out.runtimeCharset = runtimeCharset;
  const codepage = pickTomlInt(tbl, 1, 65001, 'codepage');
  if (codepage !== undefined) out.codepage = codepage;
  const charset = pickTomlInt(tbl, 0, 255, 'charset');
  if (charset !== undefined) out.charset = charset;
  const fontName = pickTomlString(tbl, 'font_name', 'fontName');
  if (fontName) out.fontName = fontName;
  const forceFontName = pickTomlBool(tbl, 'force_font_name', 'forceFontName');
  if (forceFontName !== undefined) out.forceFontName = forceFontName;
  const enableWidthCompat = pickTomlBool(tbl, 'enable_width_compat', 'enableWidthCompat');
  if (enableWidthCompat !== undefined) out.enableWidthCompat = enableWidthCompat;

  const customOptions: Record<string, string | number | boolean> = {};
  for (const [key, val] of Object.entries(tbl)) {
    if (RESERVED_PATCH_TOML_KEYS.has(key)) continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      customOptions[key] = val;
    }
  }
  if (Object.keys(customOptions).length > 0) {
    out.customOptions = customOptions;
  }

  return out;
}

export function loadProfile(workspace: string): ProfileLoad {
  const wsPaths = resolveWorkspacePaths(workspace);
  const candidates = [
    wsPaths.profileTomlFile,
    wsPaths.papercupTomlFile,
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
    errors.push('narrative_pov 必须是 first、second、third、mixed 或 source（跟随原文）。');
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
  const requireCharacterConfirmation =
    typeof tbl.require_character_confirmation === 'boolean' ? tbl.require_character_confirmation : true;
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
      requireCharacterConfirmation,
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

const ENGINE_NAME_SAFE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function extractControlPatternFromEngineJson(obj: Record<string, unknown> | null): string | null {
  if (!obj) return null;
  const wb = obj.writeback;
  if (wb && typeof wb === 'object' && !Array.isArray(wb)) {
    const wbPat = (wb as Record<string, unknown>).control_pattern;
    if (typeof wbPat === 'string' && wbPat.trim()) {
      return wbPat.trim();
    }
  }
  const topPat = obj.control_pattern;
  if (typeof topPat === 'string' && topPat.trim()) {
    return topPat.trim();
  }
  return null;
}

function readSmallEngineJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    if (isSymlinkPath(filePath) || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > 32 * 1024) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function resolveWorkspaceControlPattern(
  workspace: string,
  homeDir?: string | null,
  explicitEngine?: string
): string | null {
  const ws = realpathSafe(workspace);
  const effectiveHome = homeDir === undefined ? resolveHomeDir() : homeDir;
  const normExplicit = (explicitEngine || '').trim().toLowerCase();

  // 1) Project-level harness engine.json takes precedence when engine matches or is unspecified
  const projJson = readSmallEngineJsonObject(path.join(projectHarnessDir(ws, effectiveHome), 'engine.json'));
  const projEngine = typeof projJson?.name === 'string' ? projJson.name.trim().toLowerCase() : '';
  if (projJson && (!normExplicit || !projEngine || projEngine === normExplicit)) {
    const pat = extractControlPatternFromEngineJson(projJson);
    if (pat) return pat;
  }

  // 2) Resolve candidate engine name from explicit arg -> .papercup/data/vn/text.json -> project harness -> unpacked skill manifest
  const wsPaths = resolveWorkspacePaths(ws);
  const candidateEngines: string[] = [];
  const pushEng = (val: unknown) => {
    const s = typeof val === 'string' ? val.trim().toLowerCase() : '';
    if (s && ENGINE_NAME_SAFE_RE.test(s) && !candidateEngines.includes(s)) {
      candidateEngines.push(s);
    }
  };
  pushEng(normExplicit);
  const textManifest = readJsonObject(wsPaths.textManifestFile);
  pushEng(textManifest?.engine);
  pushEng(projEngine);

  if (candidateEngines.length === 0) {
    const unpackedDir = wsPaths.unpackedDir;
    if (!isSymlinkPath(unpackedDir) && fs.existsSync(unpackedDir)) {
      try {
        if (fs.statSync(unpackedDir).isDirectory()) {
          const directManifest = readSmallEngineJsonObject(path.join(unpackedDir, '.skill-manifest.json'));
          pushEng(directManifest?.engine);
          for (const ent of fs.readdirSync(unpackedDir, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
            const subManifest = readSmallEngineJsonObject(path.join(unpackedDir, ent.name, '.skill-manifest.json'));
            pushEng(subManifest?.engine);
          }
        }
      } catch {
        // Ignore unreadable unpacked directory
      }
    }
  }

  // 3) 3-tier self-contained skill registry (workspace > global > repo)
  for (const eng of candidateEngines) {
    const pkg = findSkillPackageByEngine(eng, ws, { homeDir: effectiveHome });
    const pat = extractControlPatternFromEngineJson(pkg?.engineJson ?? null);
    if (pat) return pat;
  }

  if (effectiveHome) {
    for (const eng of candidateEngines) {
      const globalJson = readSmallEngineJsonObject(path.join(effectiveHome, 'engines', eng, 'engine.json'));
      const pat = extractControlPatternFromEngineJson(globalJson);
      if (pat) return pat;
    }
  }
  return null;
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
    if (obj.base !== undefined && typeof obj.base !== 'string') {
      errors.push(`人设「${name}」的 base 必须是字符串。`);
    }
    const base = typeof obj.base === 'string' ? obj.base.trim() : '';
    const stages: PersonaStage[] = [];
    const twists: PersonaTwist[] = [];
    if (obj.stages !== undefined) {
      if (!Array.isArray(obj.stages)) {
        errors.push(`人设「${name}」的 stages 必须是数组。`);
      } else {
        obj.stages.forEach((st, idx) => {
          if (!st || typeof st !== 'object' || Array.isArray(st)) {
            errors.push(`人设「${name}」的 stages[${idx}] 必须是对象。`);
            return;
          }
          const rec = st as Record<string, unknown>;
          const from = typeof rec.from === 'string' ? rec.from.trim() : '';
          const voice = typeof rec.voice === 'string' ? rec.voice.trim() : '';
          if (!from || !voice) {
            errors.push(`人设「${name}」的 stages[${idx}] 必须包含非空字符串 from 与 voice。`);
            return;
          }
          stages.push({ fromScene: from, voice });
        });
      }
    }
    if (obj.twists !== undefined) {
      if (!Array.isArray(obj.twists)) {
        errors.push(`人设「${name}」的 twists 必须是数组。`);
      } else {
        obj.twists.forEach((tw, idx) => {
          if (!tw || typeof tw !== 'object' || Array.isArray(tw)) {
            errors.push(`人设「${name}」的 twists[${idx}] 必须是对象。`);
            return;
          }
          const rec = tw as Record<string, unknown>;
          const at = typeof rec.at === 'string' ? rec.at.trim() : '';
          const note = typeof rec.note === 'string' ? rec.note.trim() : '';
          if (rec.reveals !== undefined && typeof rec.reveals !== 'string') {
            errors.push(`人设「${name}」的 twists[${idx}].reveals 必须是字符串。`);
            return;
          }
          const reveals = typeof rec.reveals === 'string' ? rec.reveals.trim() : '';
          if (!at || !note) {
            errors.push(`人设「${name}」的 twists[${idx}] 必须包含非空字符串 at 与 note。`);
            return;
          }
          twists.push({ atScene: at, note, reveals });
        });
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

export function normalizeCharacterGender(raw: unknown): CharacterGender {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'female' || s === 'f' || s === '女' || s === '女性') return 'female';
  if (s === 'male' || s === 'm' || s === '男' || s === '男性') return 'male';
  if (s === 'other' || s === '其他' || s === '非二元' || s === '中性') return 'other';
  return 'unknown';
}

export function readCharacterRoster(workspace: string): CharacterRosterStore | null {
  const wsPaths = resolveWorkspacePaths(workspace);
  const raw = readJsonObject(wsPaths.charactersFile);
  if (!raw || raw.schema !== 1 || !Array.isArray(raw.characters)) return null;
  const status: 'draft' | 'locked' = raw.status === 'locked' ? 'locked' : 'draft';
  const characters: CharacterRosterEntry[] = [];
  for (const item of raw.characters) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const sourceName = String(rec.sourceName ?? '').replace(/[\r\n]+/g, ' ').trim();
    const targetName = String(rec.targetName ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!sourceName) continue;
    const id =
      String(rec.id ?? '').replace(/[\r\n]+/g, ' ').trim() ||
      `ch_${crypto.createHash('sha256').update(sourceName, 'utf8').digest('hex').slice(0, 8)}`;
    const speakerIds = Array.isArray(rec.speakerIds)
      ? Array.from(
          new Set(
            rec.speakerIds
              .map((s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim())
              .filter(Boolean)
          )
        )
      : [];
    const aliases: CharacterAlias[] = [];
    const seenAlias = new Set<string>();
    if (Array.isArray(rec.aliases)) {
      for (const a of rec.aliases) {
        if (!a || typeof a !== 'object') continue;
        const ar = a as Record<string, unknown>;
        const as = String(ar.source ?? '').replace(/[\r\n]+/g, ' ').trim();
        const at = String(ar.target ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (!as || !at || as === sourceName || seenAlias.has(as)) continue;
        seenAlias.add(as);
        aliases.push({ source: as, target: at });
      }
    }
    const samples = Array.isArray(rec.samples)
      ? Array.from(
          new Set(
            rec.samples
              .map((s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80))
              .filter(Boolean)
          )
        ).slice(0, 3)
      : [];
    const note = String(rec.note ?? '').replace(/[\r\n]+/g, ' ').trim();
    const occ =
      typeof rec.occurrences === 'number' && Number.isFinite(rec.occurrences) && rec.occurrences >= 0
        ? Math.floor(rec.occurrences)
        : 0;
    characters.push({
      id,
      sourceName,
      targetName,
      speakerIds,
      aliases,
      gender: normalizeCharacterGender(rec.gender),
      ...(note ? { note } : {}),
      occurrences: occ,
      samples,
    });
  }
  const dismissedNames = Array.isArray(raw.dismissedNames)
    ? Array.from(
        new Set(
          raw.dismissedNames
            .map((s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim())
            .filter(Boolean)
        )
      )
    : [];
  return {
    schema: 1,
    status,
    classifyDigest: typeof raw.classifyDigest === 'string' ? raw.classifyDigest.trim() : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    ...(typeof raw.confirmedAt === 'string' && raw.confirmedAt ? { confirmedAt: raw.confirmedAt } : {}),
    ...(typeof raw.formId === 'string' && raw.formId ? { formId: raw.formId } : {}),
    characters,
    ...(dismissedNames.length ? { dismissedNames } : {}),
  };
}

const PURE_KANA_READING_RE = /^[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u30FC・･\s]+$/;

export function compileRosterToGlossary(
  roster: CharacterRosterStore | null | undefined,
  options?: { skipKanaIdentityAliases?: boolean }
): Record<string, string> {
  if (!roster || roster.status !== 'locked' || !Array.isArray(roster.characters)) {
    return {};
  }
  const skipKanaIdentity = Boolean(options?.skipKanaIdentityAliases);
  const out: Record<string, string> = {};
  for (const ch of roster.characters) {
    const src = ch.sourceName.trim();
    const tgt = ch.targetName.trim();
    if (src && tgt) {
      out[src] = tgt;
    }
    for (const alias of ch.aliases || []) {
      const aSrc = alias.source.trim();
      const aTgt = alias.target.trim();
      if (!aSrc || !aTgt || aSrc in out) continue;
      if (skipKanaIdentity && aSrc === aTgt && PURE_KANA_READING_RE.test(aTgt)) continue;
      out[aSrc] = aTgt;
    }
  }
  return out;
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

  const roster = readCharacterRoster(workspace);
  let characters: CharacterRosterEntry[] = [];
  let charactersStatus: 'none' | 'draft' | 'locked' = 'none';
  if (roster) {
    charactersStatus = roster.status;
    if (roster.status === 'locked') {
      characters = roster.characters;
      Object.assign(
        glossary,
        compileRosterToGlossary(roster, {
          skipKanaIdentityAliases:
            profile.residueCheck && profile.targetLang.toLowerCase().startsWith('zh'),
        })
      );
    }
  }

  return {
    glossary,
    persona,
    lessons: base.lessons,
    personaErrors,
    characters,
    charactersStatus,
  };
}

export function readiness(profile: LocalizationProfile, memory: ProjectMemory): ReadinessState {
  const reasons: string[] = [];
  if (memory.personaErrors.length > 0) {
    reasons.push(...memory.personaErrors);
  }
  if (profile.requireGlossary && Object.keys(memory.glossary).length === 0) {
    reasons.push('require_glossary=true，但术语表为空。');
  }
  const hasMemory = Object.keys(memory.glossary).length > 0 || Object.keys(memory.persona).length > 0;
  const quality: 'ok' | 'unreviewed' | 'degraded' =
    reasons.length > 0 ? 'degraded' : hasMemory ? 'ok' : 'unreviewed';
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

function tryDecode(buf: Buffer, encoding: 'utf-8' | 'shift_jis' | 'gbk'): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function hasKana(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3041 && c <= 0x3096) || (c >= 0x30a1 && c <= 0x30fa)) return true;
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
  if (data.length >= 2 && data.subarray(0, 2).equals(UTF16LE_BOM) && (data.length - 2) % 2 === 0) {
    return 'utf-16le-bom';
  }
  if (isAsciiBuffer(data)) return 'utf-8';
  const utf8 = tryDecode(data, 'utf-8');
  const cp932 = tryDecode(data, 'shift_jis');
  const gbk = tryDecode(data, 'gbk');

  if (utf8 !== null) {
    if (cp932 === null && gbk === null) return 'utf-8';
    const utfScore = cjkScore(utf8);
    const maxLegacyScore = Math.max(cp932 !== null ? cjkScore(cp932) : -1, gbk !== null ? cjkScore(gbk) : -1);
    if (hasKana(utf8) || utfScore >= maxLegacyScore) {
      return 'utf-8';
    }
  }

  if (cp932 !== null && gbk === null) return 'cp932';
  if (gbk !== null && cp932 === null) return 'gbk';
  if (cp932 !== null && gbk !== null) {
    if (hasKana(cp932)) return 'cp932';
    if (cjkScore(gbk) > cjkScore(cp932)) return 'gbk';
    return 'cp932';
  }
  throw new DecodeError('unknown');
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
  if (chosen === 'utf-16le-bom' || chosen === 'utf-16' || chosen === 'utf16') {
    const slice = data.subarray(0, 2).equals(UTF16LE_BOM) ? data.subarray(2) : data;
    return { text: slice.toString('utf16le'), encoding: 'utf-16le-bom' };
  }
  if (chosen === 'utf-16le' || chosen === 'utf16le') {
    const slice = data.subarray(0, 2).equals(UTF16LE_BOM) ? data.subarray(2) : data;
    return { text: slice.toString('utf16le'), encoding: 'utf-16le' };
  }
  const isGbk = chosen === 'gbk' || chosen === 'cp936' || chosen === 'gb2312';
  try {
    const text = new TextDecoder(isGbk ? 'gbk' : chosen, { fatal: true }).decode(data);
    return { text, encoding: isGbk ? 'gbk' : chosen };
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

const GBK_COMPAT_FALLBACK: Record<string, string> = {
  '\u301C': '\uFF5E', // 〜 -> ～
  '\u30FB': '\u00B7', // ・ -> ·
  '\u266A': '\u2606', // ♪ -> ☆
  '\u2661': '\u2606', // ♡ -> ☆
  '\u2665': '\u2605', // ♥ -> ★
};

export function normalizeGbkCompatText(text: string): string {
  if (!text) return text;
  let changed = false;
  let out = '';
  for (const ch of text) {
    const mapped = GBK_COMPAT_FALLBACK[ch];
    if (mapped) {
      out += mapped;
      changed = true;
    } else {
      out += ch;
    }
  }
  return changed ? out : text;
}

let gbkReverseMap: Map<string, number[]> | null = null;
function getGbkEncodeMap(): Map<string, number[]> {
  if (gbkReverseMap) return gbkReverseMap;
  const map = new Map<string, number[]>();
  const dec = new TextDecoder('gbk', { fatal: true });
  const euro = Buffer.from([0x80]);
  try {
    const ch = dec.decode(euro);
    if (!map.has(ch)) map.set(ch, [0x80]);
  } catch {
    // ignore
  }
  const dbl = Buffer.alloc(2);
  for (let b1 = 0x81; b1 <= 0xfe; b1++) {
    dbl[0] = b1;
    for (let b2 = 0x40; b2 <= 0xfe; b2++) {
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
  gbkReverseMap = map;
  return map;
}

function encodeDoubleByteText(
  text: string,
  encoding: string,
  rev: Map<string, number[]>,
  fallback?: Record<string, string>
): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x7f) {
      out.push(code);
      continue;
    }
    const mapped = rev.get(ch) ?? (fallback?.[ch] ? rev.get(fallback[ch]) : undefined);
    if (!mapped) {
      throw new EncodeError(encoding, `无法编码字符 U+${code.toString(16).toUpperCase().padStart(4, '0')} (${ch})`);
    }
    for (const byte of mapped) out.push(byte);
  }
  return Buffer.from(out);
}

const SAFE_CUSTOM_ENCODING_BARE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_CUSTOM_ENCODING_PREFIXED_RE = /^custom:[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isSafeCustomEncodingName(value?: string | null): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return SAFE_CUSTOM_ENCODING_PREFIXED_RE.test(trimmed) || SAFE_CUSTOM_ENCODING_BARE_RE.test(trimmed);
}

export function tryNormalizeBuiltinEncoding(value?: string | null): string | null {
  if (!value) return null;
  const name = value.trim().toLowerCase();
  if (!name) return null;
  if (name === 'utf-8-bom' || name === 'utf-8-sig') return 'utf-8-bom';
  if (name === 'utf-8' || name === 'utf8') return 'utf-8';
  if (name === 'cp932' || name === 'shift_jis' || name === 'shift-jis' || name === 'sjis') return 'cp932';
  if (name === 'utf-16le-bom' || name === 'utf-16' || name === 'utf16') return 'utf-16le-bom';
  if (name === 'utf-16le' || name === 'utf16le') return 'utf-16le';
  if (name === 'gbk' || name === 'cp936' || name === 'gb2312') return 'gbk';
  return null;
}

export function normalizeEncodingName(
  value?: string | null,
  options?: { allowCustom?: boolean; allowedCustomEncodings?: readonly string[] }
): string | null {
  if (!value) return null;
  const name = value.trim().toLowerCase();
  if (!name) return null;
  const builtin = tryNormalizeBuiltinEncoding(name);
  if (builtin) return builtin;

  if (options?.allowCustom) {
    if (SAFE_CUSTOM_ENCODING_PREFIXED_RE.test(name)) {
      return name;
    }
    const allowedSet = new Set(
      (options.allowedCustomEncodings ?? [])
        .map((s) => s.trim().toLowerCase())
        .filter((s) => SAFE_CUSTOM_ENCODING_BARE_RE.test(s) || SAFE_CUSTOM_ENCODING_PREFIXED_RE.test(s))
    );
    if (SAFE_CUSTOM_ENCODING_BARE_RE.test(name) && allowedSet.has(name)) {
      return name;
    }
    throw new Error(
      `不支持的写回编码：${value}（技能自定义编码须使用 custom:<名称> 前缀，或在 engine.json 的 custom_encodings 中预先声明）`
    );
  }

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
  if (norm === 'utf-16le-bom' || norm === 'utf-16' || norm === 'utf16') {
    return Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]);
  }
  if (norm === 'utf-16le' || norm === 'utf16le') {
    return Buffer.from(text, 'utf16le');
  }
  if (norm === 'cp932' || norm === 'shift_jis' || norm === 'shift-jis' || norm === 'sjis') {
    return encodeDoubleByteText(text, encoding, getCp932EncodeMap());
  }
  if (norm === 'gbk' || norm === 'cp936' || norm === 'gb2312') {
    return encodeDoubleByteText(text, encoding, getGbkEncodeMap(), GBK_COMPAT_FALLBACK);
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
