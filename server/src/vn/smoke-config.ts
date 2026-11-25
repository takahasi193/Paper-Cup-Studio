/**
 * Global & workspace configuration for runtime patch smoke testing (`vn_smoke_test`).
 *
 * Persisted globally at `~/.papercup/smoke.json` (editable via Web UI Settings),
 * with optional per-workspace overrides via `papercup.toml [vn.smoke]`.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  isSymlinkPath,
  pickTomlBool,
  pickTomlInt,
  pickTomlString,
  readWorkspaceTomlSection,
  realpathSafe,
  resolveHomeDir,
} from './profile.js';
import {
  WORKSPACE_SMOKE_PRE_TRANSLATE_REL,
  WORKSPACE_SMOKE_REPORT_REL,
  resolveWorkspacePaths,
} from './workspace-paths.js';

export const SMOKE_REPORT_REL = WORKSPACE_SMOKE_REPORT_REL;
export const SMOKE_PRE_TRANSLATE_REL = WORKSPACE_SMOKE_PRE_TRANSLATE_REL;

export type SmokeRuleSeverity = 'error' | 'warning' | 'info';

export type SmokeRuleId =
  | 'harness.driver_failed'
  | 'runtime.launch_failed'
  | 'runtime.locale_emulator_profile_missing'
  | 'runtime.crash'
  | 'runtime.early_exit'
  | 'runtime.error_dialog'
  | 'runtime.hang'
  | 'hook.unavailable'
  | 'text.mojibake'
  | 'text.not_patched'
  | 'font.missing_glyphs'
  | 'vision.skipped'
  | 'vision.defect';

export interface SmokeFinding {
  ruleId: SmokeRuleId | (string & {});
  severity: SmokeRuleSeverity;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface SmokeCrashInfo {
  exitCode?: number | null;
  faultingModule?: string;
  exceptionCode?: string;
  faultOffset?: string;
  rawEvent?: string;
}

export interface SmokeCapturedFrame {
  label: 'title' | 'dialogue_start' | 'dialogue_mid' | 'dialogue_end' | 'error';
  step: number;
  path: string;
  relPath: string;
  hash: string;
  width: number;
  height: number;
}

export interface SmokeVisionDefect {
  severity: 'error' | 'warning';
  kind: string;
  description: string;
  frame?: string;
}

export interface SmokeOverlayFileEntry {
  rel: string;
  sha256: string;
  bytes: number;
  existedBefore?: boolean;
}

export interface PreTranslateSmokeProbeInfo {
  track: 'scenario' | 'ui';
  id: string;
  file: string;
  line: number;
  source: string;
  target: string;
  targetEncoding: string;
  additionalProbes?: Array<{
    id: string;
    file: string;
    line: number;
    source: string;
    target: string;
  }>;
  savedProbeDir?: string;
}

export interface PreTranslateSmokeRecord {
  schema: 1;
  phase: 'pre_translate';
  createdAt: string;
  engine: string;
  skillName: string;
  skillPipeline: 'skill' | 'direct';
  skillDigest: string;
  ok: boolean;
  failureKind?: 'patch' | 'harness';
  targetExe: string;
  stepsAdvanced: number;
  durationMs: number;
  errorCount: number;
  warningCount: number;
  errorRules: string[];
  probe: PreTranslateSmokeProbeInfo;
  overlayFiles: SmokeOverlayFileEntry[];
  reportPath: string;
}

export interface SmokeReport {
  schema: 1;
  createdAt: string;
  phase?: 'post_translate' | 'pre_translate';
  mode?: 'manifest' | 'overlay';
  skillEngine?: string;
  skillDigest?: string;
  preTranslateProbe?: PreTranslateSmokeProbeInfo;
  patchManifestPath: string;
  patchManifestSha256: string;
  overlayPath?: string;
  overlayTarget?: string;
  overlayDigest?: string;
  overlayFiles?: SmokeOverlayFileEntry[];
  targetExe: string;
  targetArch: 'x86' | 'x64' | 'unknown';
  usedLocaleEmulator: boolean;
  usedTextractor: boolean;
  usedProxyDll?: string;
  inputMode: 'background' | 'foreground_fallback' | 'none';
  durationMs: number;
  stepsAdvanced: number;
  repairRound: number;
  maxRepairRounds: number;
  repairLimitReached: boolean;
  ok: boolean;
  failureKind?: 'patch' | 'harness';
  errorCount: number;
  warningCount: number;
  findings: SmokeFinding[];
  crash?: SmokeCrashInfo;
  textractor?: {
    available: boolean;
    linesCaptured: number;
    matchedTranslated: number;
    matchedSource: number;
    sampleLines: string[];
  };
  screenshots: SmokeCapturedFrame[];
  diagnosticsDir?: string;
  diagnosticsFiles?: string[];
  vision?: {
    status: 'checked' | 'skipped';
    reason?: string;
    skippedByParam?: boolean;
    clickAttempted?: boolean;
    defects: SmokeVisionDefect[];
  };
  summary: string;
}

export function readSmokeReport(workspace: string): SmokeReport | null {
  const p = resolveWorkspacePaths(workspace).smokeReportFile;
  if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as SmokeReport;
    return parsed && parsed.schema === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function readPreTranslateSmokeRecord(workspace: string): PreTranslateSmokeRecord | null {
  const p = resolveWorkspacePaths(workspace).smokePreTranslateFile;
  if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as PreTranslateSmokeRecord;
    return parsed && parsed.schema === 1 && parsed.phase === 'pre_translate' ? parsed : null;
  } catch {
    return null;
  }
}

export interface SmokeTestConfig {
  enabled: boolean;
  visionEnabled: boolean;
  textractorPath: string;
  localeEmulatorPath: string;
  timeoutSec: number;
  advanceSteps: number;
  maxScreenshots: number;
  maxRepairRounds: number;
}

export type SmokeOverrideConfig = Partial<SmokeTestConfig>;

export interface SmokeToolStatus {
  platformSupported: boolean;
  textractor: {
    configured: boolean;
    available: boolean;
    x86Path: string | null;
    x64Path: string | null;
    fallbackPath: string | null;
    note: string;
  };
  localeEmulator: {
    configured: boolean;
    available: boolean;
    leProcPath: string | null;
    note: string;
  };
}

export interface SmokeConfigState {
  global: SmokeTestConfig;
  workspaceOverride: SmokeOverrideConfig | null;
  effective: SmokeTestConfig;
  tools: SmokeToolStatus;
}

export const DEFAULT_SMOKE_CONFIG: SmokeTestConfig = {
  enabled: false,
  visionEnabled: true,
  textractorPath: '',
  localeEmulatorPath: '',
  timeoutSec: 90,
  advanceSteps: 25,
  maxScreenshots: 4,
  maxRepairRounds: 2,
};

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizePathInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^["']|["']$/g, '');
}

export function normalizeSmokeConfig(
  raw: Partial<Record<string, unknown>> | null | undefined,
  base: SmokeTestConfig = DEFAULT_SMOKE_CONFIG
): SmokeTestConfig {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : base.enabled,
    visionEnabled: typeof src.visionEnabled === 'boolean' ? src.visionEnabled : base.visionEnabled,
    textractorPath:
      src.textractorPath !== undefined ? normalizePathInput(src.textractorPath) : base.textractorPath,
    localeEmulatorPath:
      src.localeEmulatorPath !== undefined
        ? normalizePathInput(src.localeEmulatorPath)
        : base.localeEmulatorPath,
    timeoutSec: clampInt(src.timeoutSec, base.timeoutSec, 15, 300),
    advanceSteps: clampInt(src.advanceSteps, base.advanceSteps, 3, 100),
    maxScreenshots: clampInt(src.maxScreenshots, base.maxScreenshots, 1, 6),
    maxRepairRounds: clampInt(src.maxRepairRounds, base.maxRepairRounds, 0, 5),
  };
}

export function resolveSmokeConfigPath(homeDir?: string | null): string {
  const root = homeDir && homeDir.trim() ? path.resolve(homeDir) : resolveHomeDir();
  return path.join(root, 'smoke.json');
}

export function loadGlobalSmokeConfig(homeDir?: string | null): SmokeTestConfig {
  const filePath = resolveSmokeConfigPath(homeDir);
  if (isSymlinkPath(filePath) || !fs.existsSync(filePath)) {
    return { ...DEFAULT_SMOKE_CONFIG };
  }
  try {
    if (!fs.statSync(filePath).isFile()) return { ...DEFAULT_SMOKE_CONFIG };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    return normalizeSmokeConfig(parsed, DEFAULT_SMOKE_CONFIG);
  } catch {
    return { ...DEFAULT_SMOKE_CONFIG };
  }
}

export function saveGlobalSmokeConfig(
  patch: Partial<SmokeTestConfig>,
  homeDir?: string | null
): SmokeTestConfig {
  const filePath = resolveSmokeConfigPath(homeDir);
  if (isSymlinkPath(filePath)) {
    throw new Error(`Refusing to write symlink smoke config: ${filePath}`);
  }
  const current = loadGlobalSmokeConfig(homeDir);
  const next = normalizeSmokeConfig({ ...current, ...patch }, current);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  return next;
}

export function loadWorkspaceSmokeOverride(workspace: string): SmokeOverrideConfig | null {
  const tbl = readWorkspaceTomlSection(workspace, 'vn.smoke');
  if (!tbl) return null;
  const out: SmokeOverrideConfig = {};
  const enabled = pickTomlBool(tbl, 'enabled');
  if (enabled !== undefined) out.enabled = enabled;
  const visionEnabled = pickTomlBool(tbl, 'vision_enabled', 'visionEnabled');
  if (visionEnabled !== undefined) out.visionEnabled = visionEnabled;
  const textractorPath = pickTomlString(tbl, 'textractor_path', 'textractorPath');
  if (textractorPath !== undefined) out.textractorPath = textractorPath;
  const localeEmulatorPath = pickTomlString(tbl, 'locale_emulator_path', 'localeEmulatorPath');
  if (localeEmulatorPath !== undefined) out.localeEmulatorPath = localeEmulatorPath;
  const timeoutSec = pickTomlInt(tbl, 15, 300, 'timeout_sec', 'timeoutSec');
  if (timeoutSec !== undefined) out.timeoutSec = timeoutSec;
  const advanceSteps = pickTomlInt(tbl, 3, 100, 'advance_steps', 'advanceSteps');
  if (advanceSteps !== undefined) out.advanceSteps = advanceSteps;
  const maxScreenshots = pickTomlInt(tbl, 1, 6, 'max_screenshots', 'maxScreenshots');
  if (maxScreenshots !== undefined) out.maxScreenshots = maxScreenshots;
  const maxRepairRounds = pickTomlInt(tbl, 0, 5, 'max_repair_rounds', 'maxRepairRounds');
  if (maxRepairRounds !== undefined) out.maxRepairRounds = maxRepairRounds;
  return Object.keys(out).length > 0 ? out : null;
}

export function mergeSmokeConfig(
  globalCfg: SmokeTestConfig,
  wsOverride: SmokeOverrideConfig | null
): SmokeTestConfig {
  if (!wsOverride) return { ...globalCfg };
  return normalizeSmokeConfig({ ...globalCfg, ...wsOverride }, globalCfg);
}

function isRegularFile(p: string): boolean {
  try {
    return !isSymlinkPath(p) && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isRegularDir(p: string): boolean {
  try {
    return !isSymlinkPath(p) && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNamedExeInDir(dir: string, targets: string[]): string | null {
  for (const name of targets) {
    const direct = path.join(dir, name);
    if (isRegularFile(direct)) return direct;
  }
  try {
    const entries = fs.readdirSync(dir);
    for (const target of targets) {
      const low = target.toLowerCase();
      const found = entries.find((e) => e.toLowerCase() === low);
      if (found) {
        const full = path.join(dir, found);
        if (isRegularFile(full)) return full;
      }
    }
  } catch {
    // ignore unreadable directory
  }
  return null;
}

export interface LocaleEmulatorProfile {
  guid: string;
  name: string;
  location: string;
}

export function listLocaleEmulatorProfiles(leProcPath: string): LocaleEmulatorProfile[] {
  if (!leProcPath) return [];
  const cfgPath = path.join(path.dirname(leProcPath), 'LEConfig.xml');
  if (!isRegularFile(cfgPath)) return [];
  try {
    const xml = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
    const out: LocaleEmulatorProfile[] = [];
    const re = /<Profile\b([^>]*)>([\s\S]*?)<\/Profile>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1] || '';
      const body = m[2] || '';
      const guid = /\bGuid="([^"]+)"/i.exec(attrs)?.[1]?.trim() || '';
      const name = /\bName="([^"]+)"/i.exec(attrs)?.[1]?.trim() || '';
      const location = /<Location>\s*([^<]+?)\s*<\/Location>/i.exec(body)?.[1]?.trim() || '';
      if (guid) out.push({ guid, name, location });
    }
    return out;
  } catch {
    return [];
  }
}

const LE_CODEPAGE_LOCALES: Record<number, readonly string[]> = {
  936: ['zh-cn', 'zh-sg', 'zh-hans', 'zh-hans-cn', 'zh-hans-sg'],
  932: ['ja-jp', 'ja'],
  950: ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant', 'zh-hant-tw', 'zh-hant-hk'],
  949: ['ko-kr', 'ko'],
};

export function findLocaleEmulatorProfileGuid(
  leProcPath: string | null | undefined,
  targetCodepage?: number | null
): string | null {
  if (!leProcPath) return null;
  const profiles = listLocaleEmulatorProfiles(leProcPath);
  if (!profiles.length) return null;

  const effectiveCp = typeof targetCodepage === 'number' ? targetCodepage : 932;
  const compatLocales = LE_CODEPAGE_LOCALES[effectiveCp];
  if (!compatLocales) return null;

  const normLoc = (raw: string) => raw.trim().toLowerCase().replace(/_/g, '-');
  for (const wanted of compatLocales) {
    const exact = profiles.find((p) => normLoc(p.location) === wanted);
    if (exact) return exact.guid;
  }
  // Allow subtag prefix fallback ONLY for unambiguous single-codepage languages (ja/ko),
  // NEVER across zh-CN (CP936) and zh-TW (CP950), and NEVER blindly fall back to profiles[0].
  if (effectiveCp === 932 || effectiveCp === 949) {
    const prefix = effectiveCp === 932 ? 'ja-' : 'ko-';
    const byLang = profiles.find((p) => normLoc(p.location).startsWith(prefix));
    if (byLang) return byLang.guid;
  }
  return null;
}

function scanTextractorDir(dir: string): {
  x86Path: string | null;
  x64Path: string | null;
  fallbackPath: string | null;
} {
  let x86Path: string | null = null;
  let x64Path: string | null = null;
  const sub86 = path.join(dir, 'x86');
  const sub64 = path.join(dir, 'x64');
  if (isRegularDir(sub86)) x86Path = findNamedExeInDir(sub86, ['TextractorCLI.exe']);
  if (isRegularDir(sub64)) x64Path = findNamedExeInDir(sub64, ['TextractorCLI.exe']);
  const fallbackPath = findNamedExeInDir(dir, ['TextractorCLI.exe']);
  return { x86Path, x64Path, fallbackPath };
}

export function inspectSmokeTools(cfg: SmokeTestConfig): SmokeToolStatus {
  const platformSupported = process.platform === 'win32';

  // Inspect Textractor CLI (supports root folder, 1-level nested Textractor/ folder, or direct TextractorCLI.exe)
  let x86Path: string | null = null;
  let x64Path: string | null = null;
  let fallbackPath: string | null = null;
  const rawTr = cfg.textractorPath.trim();
  if (rawTr) {
    const resolved = path.resolve(rawTr);
    if (isRegularFile(resolved)) {
      const parentName = path.basename(path.dirname(resolved)).toLowerCase();
      const grandParent = path.dirname(path.dirname(resolved));
      if (parentName === 'x86') {
        x86Path = resolved;
        const sib64 = path.join(grandParent, 'x64');
        if (isRegularDir(sib64)) x64Path = findNamedExeInDir(sib64, ['TextractorCLI.exe']);
      } else if (parentName === 'x64') {
        x64Path = resolved;
        const sib86 = path.join(grandParent, 'x86');
        if (isRegularDir(sib86)) x86Path = findNamedExeInDir(sib86, ['TextractorCLI.exe']);
      } else {
        fallbackPath = resolved;
      }
    } else if (isRegularDir(resolved)) {
      const top = scanTextractorDir(resolved);
      x86Path = top.x86Path;
      x64Path = top.x64Path;
      fallbackPath = top.fallbackPath;
      if (!x86Path && !x64Path && !fallbackPath) {
        for (const subName of ['Textractor', 'textractor']) {
          const nested = path.join(resolved, subName);
          if (isRegularDir(nested)) {
            const inner = scanTextractorDir(nested);
            if (inner.x86Path || inner.x64Path || inner.fallbackPath) {
              x86Path = inner.x86Path;
              x64Path = inner.x64Path;
              fallbackPath = inner.fallbackPath;
              break;
            }
          }
        }
      }
    }
  }
  const trAvailable = Boolean(x86Path || x64Path || fallbackPath);
  const trNote = !rawTr
    ? '未配置（可选；未配置时跳过文本钩子规则，仅做崩溃/卡死与视觉检查）'
    : trAvailable
      ? `已就绪（${[x86Path ? 'x86' : '', x64Path ? 'x64' : '', !x86Path && !x64Path && fallbackPath ? path.basename(fallbackPath) : ''].filter(Boolean).join(' + ')}）`
      : `未找到 TextractorCLI.exe：${rawTr}`;

  // Inspect Locale Emulator (LEProc.exe + optional LEConfig.xml profiles)
  let leProcPath: string | null = null;
  const rawLe = cfg.localeEmulatorPath.trim();
  if (rawLe) {
    const resolved = path.resolve(rawLe);
    if (isRegularFile(resolved)) {
      leProcPath = resolved;
    } else if (isRegularDir(resolved)) {
      leProcPath = findNamedExeInDir(resolved, ['LEProc.exe']);
    }
  }
  const leAvailable = Boolean(leProcPath);
  const leProfiles = leProcPath ? listLocaleEmulatorProfiles(leProcPath) : [];
  const leLocSummary = leProfiles
    .map((p) => p.location)
    .filter(Boolean)
    .join(' / ');
  const leNote = !rawLe
    ? '未配置（可选；部分 CP932/GBK 引擎如需区域模拟可指定 LEProc.exe）'
    : leAvailable
      ? leLocSummary
        ? `已就绪（${path.basename(leProcPath!)}，配置：${leLocSummary}）`
        : `已就绪（${path.basename(leProcPath!)}）`
      : `未找到 LEProc.exe：${rawLe}`;

  return {
    platformSupported,
    textractor: {
      configured: Boolean(rawTr),
      available: trAvailable,
      x86Path,
      x64Path,
      fallbackPath,
      note: trNote,
    },
    localeEmulator: {
      configured: Boolean(rawLe),
      available: leAvailable,
      leProcPath,
      note: leNote,
    },
  };
}

export function selectTextractorCliForArch(
  tools: SmokeToolStatus,
  arch: 'x86' | 'x64' | 'unknown'
): string | null {
  // Never cross-fallback x86 <-> x64 because cross-architecture DLL injection always fails on Windows.
  if (arch === 'x64') return tools.textractor.x64Path || tools.textractor.fallbackPath || null;
  if (arch === 'x86') return tools.textractor.x86Path || tools.textractor.fallbackPath || null;
  return tools.textractor.x86Path || tools.textractor.fallbackPath || tools.textractor.x64Path || null;
}

export function getSmokeConfigState(workspace: string, homeDir?: string | null): SmokeConfigState {
  const globalCfg = loadGlobalSmokeConfig(homeDir);
  const wsOverride = loadWorkspaceSmokeOverride(workspace);
  const effective = mergeSmokeConfig(globalCfg, wsOverride);
  const tools = inspectSmokeTools(effective);
  return {
    global: globalCfg,
    workspaceOverride: wsOverride,
    effective,
    tools,
  };
}
