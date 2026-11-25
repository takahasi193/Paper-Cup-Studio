/**
 * In-process TypeScript VN domain coordinator bridging deterministic VN engine modules
 * (`archives`, `classify`, `profile`, `qa`, `workflow`) to Agent tools, batch orchestration,
 * and engineering status queries without pseudo-CLI argument serialization.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import {
  BUILTIN_ARCHIVE_KINDS,
  COMPOSE_MANIFEST,
  NO_UNPACKER_KINDS,
  NSA_MANIFEST,
  PEZIP_MANIFEST,
  RPA_MANIFEST,
  SKILL_MANIFEST,
  XP3_MANIFEST,
  collectedNamesInUnpacked,
  detectEngineFingerprintHints,
  findUnpackManifests,
  loadEngineProfile,
  loadProjectHarnessEngineJson,
  repackNsa,
  repackPeZip,
  repackRpa,
  repackXp3,
  resolveEngineJson,
  runPythonScript,
  scanWorkspace,
  selfCheckArchive,
  sha256Hex,
  skillBinding,
  staysInside,
  unpackNsa,
  unpackPeZip,
  unpackRpa,
  unpackXp3,
  type EngineFingerprintHint,
} from './archives.js';
import {
  APPLY_REL,
  PlanConfig,
  TRACKS,
  TRACK_LABELS,
  analyzeWorkspaceText,
  applyResults,
  checkinBatch,
  classifyUnpacked,
  defaultPlanConfig,
  generateBatches,
  manifestTrackCount,
  mergeTrackResults,
  readManifest,
  readPlan,
  readResultsJsonl,
  resolveClassifyProfileForUnpacked,
  savePlanConfig,
  writeClassification,
} from './classify.js';
import {
  displayRel,
  insideWorkspace,
  isSymlinkPath,
  loadProfile,
  loadProfileMemory,
  loadWorkspacePatchConfig,
  normalizeEncodingName,
  readWorkspaceTomlSection,
  readiness,
  realpathSafe,
  resolveHomeDir,
  resolveWorkspaceControlPattern,
  type LocalizationProfile,
  type LocalMtPreset,
  type ProjectMemory,
  type TranslatorMode,
} from './profile.js';
import { buildPatchBundle, collectSkillCustomEncodings } from './patch.js';
import { qaReport } from './qa.js';
import {
  cancelChatForm,
  createCharacterConfirmationForm,
  extractCharacterCandidates,
  findPendingCharacterForm,
  listChatForms,
  readCharacterRoster,
  submitCharacterConfirmationForm,
  type CharacterConfirmationProposalItem,
  type CharacterConfirmationSubmissionItem,
  type CharacterRosterExtractionResult,
  type ChatFormRecord,
} from './roster.js';
import { getSmokeConfigState, readPreTranslateSmokeRecord, readSmokeReport } from './smoke-config.js';
import {
  resolveActiveCustomSkillForPreTranslateSmoke,
  runSmokeTest,
  type SmokeExecutionDriver,
  type SmokeVisionBridge,
} from './smoke.js';
import type { BatchRouteStats } from './translation-packet.js';
import {
  BINARY_CLASSIFY_EXTS,
  DEFAULT_RELEASE_REL,
  acceptanceState,
  buildReleaseNote,
  buildUnpackNoMatchGuidance,
  createCheckpoint,
  delegatedReport,
  ensureLocalGitRepo,
  learnUnpackSkill,
  listCheckpoints,
  mergeAcceptance,
  promoteSkill,
  resolveReadyDirectSkill,
  resolveReadySkillScript,
  rollbackCheckpoint,
  runSkillExtractRows,
  validateAcceptance,
  writeAcceptance,
  writeRelease,
} from './workflow.js';
import {
  bindSkillToWorkspace,
  discoverSkillPackages,
  findSkillPackageByEngine,
  type DynamicWorkspaceBinding,
} from './skill-registry.js';
import {
  WORKSPACE_ACCEPTANCE_REL,
  WORKSPACE_BUILD_REL,
  WORKSPACE_CHARACTERS_REL,
  WORKSPACE_FONTS_MANIFEST_REL,
  WORKSPACE_FONT_REMAP_REL,
  WORKSPACE_HANDOFF_LOG_REL,
  WORKSPACE_LOGS_REL,
  WORKSPACE_RESULTS_REL,
  WORKSPACE_UNPACKED_REL,
  resolveWorkspacePaths,
} from './workspace-paths.js';
import {
  collectWorkspaceTargetChars,
  findSystemFallbackCjkFont,
  loadPatchedFontManifest,
  resolveFontPatchScriptPath,
  savePatchedFontManifest,
  scanWorkspaceBundledFonts,
  type FontRemapMode,
  type PatchedFontEntry,
} from './fonts.js';

const execFileAsync = promisify(execFile);

class VnDispatchError extends Error {}

export interface VnGateResult {
  text: string;
  blocked: boolean;
}

export interface VnMergedTrackSummary {
  track: string;
  rows: number;
  passed: number;
  failed: number;
  results_path: string;
  results_sha256: string;
}

export interface VnMergeSummary {
  ok: boolean;
  total_passed: number;
  total_failed: number;
  tracks: VnMergedTrackSummary[];
}

function resolveContext(cwd: string): { workspace: string; homeDir: string | null } {
  return { workspace: realpathSafe(cwd), homeDir: resolveHomeDir() };
}

function requireReadyLocalization(workspace: string, homeDir: string | null): {
  profile: LocalizationProfile;
  memory: ProjectMemory;
  quality: 'ok' | 'unreviewed' | 'degraded';
} {
  const loaded = loadProfile(workspace);
  if (!loaded.configured) {
    throw new VnDispatchError('未配置本地化 profile；先在工作区 papercup.toml 写入 [vn.localization]。');
  }
  if (loaded.errors.length || !loaded.profile) {
    throw new VnDispatchError(`本地化 profile 不合法：${loaded.errors.join('；')}`);
  }
  const memory = loadProfileMemory(workspace, homeDir, loaded.profile);
  const state = readiness(loaded.profile, memory);
  if (!state.ready) {
    throw new VnDispatchError(`本地化记忆未就绪：${state.reasons.join('；')}`);
  }
  return { profile: loaded.profile, memory, quality: state.quality };
}

function claimUnpackDir(outDir: string, srcArchive: string): Set<string> {
  if (!fs.existsSync(outDir)) return new Set();
  if (!fs.statSync(outDir).isDirectory()) throw new VnDispatchError(`解包目标不是目录：${outDir}`);
  const entries = fs.readdirSync(outDir);
  if (!entries.length) return new Set();
  for (const mName of [SKILL_MANIFEST, COMPOSE_MANIFEST, RPA_MANIFEST, XP3_MANIFEST, PEZIP_MANIFEST, NSA_MANIFEST]) {
    const mp = path.join(outDir, mName);
    if (!isSymlinkPath(mp) && fs.existsSync(mp) && fs.statSync(mp).isFile()) {
      try {
        const data = JSON.parse(fs.readFileSync(mp, 'utf8')) as Record<string, unknown>;
        const src = typeof data.source === 'string' ? data.source : '';
        if (!src || realpathSafe(src) !== realpathSafe(srcArchive)) {
          throw new VnDispatchError(`目标目录属于另一个封包：${outDir}（${src}）。换一个 --dest，或先清空。`);
        }
        const files = Array.isArray(data.files)
          ? (data.files as Array<Record<string, unknown>>).map((f) => String(f.name || '')).filter(Boolean)
          : [];
        return new Set(files);
      } catch (err) {
        if (err instanceof VnDispatchError) throw err;
        break;
      }
    }
  }
  throw new VnDispatchError(`目标目录非空且没有封包清单：${outDir}。换一个 --dest，或先清空。`);
}

function pruneStaleFiles(root: string, staleNames: Set<string>): number {
  let removed = 0;
  for (const name of [...staleNames].sort()) {
    const cand = insideWorkspace(root, name);
    if (cand && !isSymlinkPath(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      fs.rmSync(cand, { force: true });
      removed++;
    }
  }
  return removed;
}

function countNonEmptyLines(filePath: string): number {
  if (isSymlinkPath(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return 0;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
}

function readQaPairsFromFile(workspace: string, pairsArg: string): Array<[string, string]> {
  const p = insideWorkspace(workspace, pairsArg);
  if (!p || isSymlinkPath(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new VnDispatchError(`QA pairs 文件必须在工作区内且为普通文件：${pairsArg}`);
  }
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((it) => {
      if (Array.isArray(it)) return [String(it[0] ?? ''), String(it[1] ?? '')];
      const obj = it as Record<string, unknown>;
      return [String(obj.source ?? ''), String(obj.target ?? '')];
    });
  }
  const pairs: Array<[string, string]> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.trim().startsWith('{')) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      pairs.push([String(obj.source ?? ''), String(obj.target ?? '')]);
    } else if (line.includes('\t')) {
      const [s, t] = line.split('\t');
      pairs.push([s ?? '', t ?? '']);
    }
  }
  return pairs;
}

const ENGINE_DISPLAY_NAMES: Record<string, string> = {
  renpy: "Ren'Py",
  kirikiri: 'KiriKiri',
  nscripter: 'NScripter',
  tyrano: 'TyranoScript',
  wolf: 'Wolf RPG',
  unity: 'Unity',
  catsystem2: 'CatSystem2',
  'pe-zip': 'PE+ZIP',
  'nexas-pacf': 'NeXAS PACF',
  siglus: 'SiglusEngine',
  reallive: 'RealLive',
  artemis: 'Artemis Engine',
  bgi: 'BGI / Ethornell',
  majiro: 'Majiro',
  yuris: 'YU-RIS',
  qlie: 'QLIE',
  alicesoft: 'AliceSoft System 4',
};

export interface VnEngineSummary {
  engineId: string | null;
  engineName: string | null;
  engineKnown: boolean;
  text: string;
  bindings?: DynamicWorkspaceBinding[];
  engineHints?: EngineFingerprintHint[];
}

function findDirectSkillWorkspaceMatches(workspace: string, engineJson: Record<string, unknown>): string[] {
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
    const cand = path.join(workspace, rel);
    if (!isSymlinkPath(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      found.push(rel);
    }
  }
  if (found.length) return found;
  try {
    for (const ent of fs.readdirSync(workspace, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const low = ent.name.toLowerCase();
      if (low === 'patch' || low === 'backup' || low === 'backups') continue;
      for (const rel of targetFiles) {
        const cand = path.join(workspace, ent.name, rel);
        if (!isSymlinkPath(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          found.push(`${ent.name}/${rel}`);
        }
      }
      if (found.length) return found;
    }
  } catch {
    // ignore unreadable dir
  }
  return found;
}

export function detectVnEngineSummary(cwd: string, options: { engine?: string } = {}): VnEngineSummary {
  const { workspace, homeDir } = resolveContext(cwd);
  const filterEngine = (options.engine ?? '').trim().toLowerCase();
  const scan = scanWorkspace(workspace, homeDir);
  const hits = scan.hits.filter((h) => !filterEngine || h.engine === filterEngine);
  const lines: string[] = [];
  const runtimeBindings: DynamicWorkspaceBinding[] = [];
  const boundEngines = new Set<string>();

  const hitsByEngine = new Map<string, string[]>();
  for (const hit of hits) {
    const list = hitsByEngine.get(hit.engine) ?? [];
    list.push(hit.path);
    hitsByEngine.set(hit.engine, list);
  }

  const recordDynamicBinding = (engine: string, matchedPaths: string[], engineJsonOverride?: Record<string, unknown> | null) => {
    const norm = engine.trim().toLowerCase();
    if (!norm || boundEngines.has(norm)) return null;
    const pkg = findSkillPackageByEngine(norm, workspace, { homeDir });
    if (!pkg) return null;
    const effJson = engineJsonOverride ?? pkg.engineJson;
    if (!effJson) return null;
    const dyn = bindSkillToWorkspace(pkg, workspace, { matchedPaths, engineJsonOverride: effJson });
    boundEngines.add(norm);
    runtimeBindings.push(dyn);
    return dyn;
  };

  const projHarness = loadProjectHarnessEngineJson(workspace, homeDir);
  const projEngName = typeof projHarness?.name === 'string' ? projHarness.name.trim().toLowerCase() : '';
  const projPipeline = typeof projHarness?.pipeline === 'string' ? projHarness.pipeline.trim().toLowerCase() : '';
  const projDirectReady = Boolean(
    projEngName &&
      projPipeline === 'direct' &&
      (!filterEngine || projEngName === filterEngine) &&
      skillBinding(workspace, homeDir, projEngName).state === 'ready'
  );

  // Discover global/repo/workspace self-contained direct skills matching files in this workspace
  const dynamicDirectDetections: Array<{
    engine: string;
    directRoot: string;
    state: 'ready' | 'mismatch';
    tier: string;
  }> = [];
  for (const pkg of discoverSkillPackages(workspace, { homeDir })) {
    if (!pkg.engineJson || String(pkg.engineJson.pipeline || '').trim().toLowerCase() !== 'direct') continue;
    if (filterEngine && pkg.engine !== filterEngine) continue;
    if (hits.some((h) => h.engine === pkg.engine)) continue;
    if (projDirectReady && pkg.engine === projEngName) continue;
    const matched = findDirectSkillWorkspaceMatches(workspace, pkg.engineJson);
    if (!matched.length) continue;
    const dyn = recordDynamicBinding(pkg.engine, matched, pkg.engineJson);
    if (dyn) {
      dynamicDirectDetections.push({
        engine: pkg.engine,
        directRoot: dyn.boundDirectRoot || '.',
        state: dyn.integrity.ok ? 'ready' : 'mismatch',
        tier: pkg.tier,
      });
    }
  }

  if (!hits.length && !projDirectReady && !dynamicDirectDetections.length) lines.push('未识别到封包。');

  for (const hit of hits) {
    const version = hit.version || '-';
    let status = '';
    const binding = skillBinding(workspace, homeDir, hit.engine, hit.kind);
    const resolvedProf = resolveEngineJson(workspace, hit.engine, homeDir);
    const dyn =
      binding.state === 'ready' || binding.state === 'mismatch'
        ? recordDynamicBinding(hit.engine, hitsByEngine.get(hit.engine) ?? [hit.path], resolvedProf)
        : null;
    const tierTag = binding.tier ? ` [${binding.tier}]` : '';
    const resolvedPipeline = String(resolvedProf?.pipeline || '').trim().toLowerCase();
    const isOverrideBuiltin = Boolean(resolvedProf?.override_builtin === true && binding.overrideBuiltin);
    if (resolvedPipeline === 'direct' && binding.state === 'ready') {
      const boundRootNote = dyn?.boundDirectRoot ? ` @ ${dyn.boundDirectRoot}` : '';
      status = `  ready  direct skill${tierTag}${boundRootNote} (skip vn_unpack -> vn_classify -> vn_writeback)`;
    } else if (!BUILTIN_ARCHIVE_KINDS.has(hit.kind) || isOverrideBuiltin) {
      if (binding.state === 'ready') {
        status = `  ready  skill unpack${tierTag}${isOverrideBuiltin ? ' (override_builtin)' : ''}`;
      } else if (binding.state === 'mismatch') {
        status = `  mismatch  skill hash${tierTag}`;
      } else if (NO_UNPACKER_KINDS.has(hit.kind)) {
        status = '  unsupported  当前没有解包器';
      }
    } else if (binding.state === 'ready') {
      status = `  ready  builtin unpack + skill:${hit.engine}${tierTag}`;
    } else if (binding.state === 'mismatch') {
      status = `  mismatch  skill hash${tierTag}`;
    } else if (homeDir) {
      const prof = loadEngineProfile(homeDir, hit.engine);
      if (!prof) {
        status = '  absent  全局画像不存在';
      } else {
        const chk = selfCheckArchive(path.join(workspace, hit.path), hit, prof);
        status = `  ${chk.ok ? 'ready' : 'mismatch'}  ${chk.reason}`;
      }
    }
    lines.push(`${hit.engine}  ${hit.kind}  ${version}  ${hit.path}${status}`);
  }

  if (projDirectReady && !hits.some((h) => h.engine === projEngName)) {
    const directRoot = String(projHarness?.direct_root || '.').trim() || '.';
    recordDynamicBinding(projEngName, [], projHarness);
    lines.push(`${projEngName}  direct  -  ${directRoot}  ready  direct skill (skip vn_unpack -> vn_classify -> vn_writeback)`);
  }

  for (const det of dynamicDirectDetections) {
    if (det.state === 'ready') {
      lines.push(
        `${det.engine}  direct  -  ${det.directRoot}  ready  direct skill [${det.tier}] (skip vn_unpack -> vn_classify -> vn_writeback)`
      );
    } else {
      lines.push(`${det.engine}  direct  -  ${det.directRoot}  mismatch  skill hash [${det.tier}]`);
    }
  }

  if (scan.unknownTotal > 0) {
    if (hits.length || projDirectReady || dynamicDirectDetections.length) lines.push('');
    for (const item of scan.unknown) {
      const metaParts: string[] = [];
      if (typeof item.size === 'number' && item.size >= 0) metaParts.push(`${item.size} B`);
      if (item.head) metaParts.push(`head=${item.head}`);
      const metaSuffix = metaParts.length ? `  (${metaParts.join(', ')})` : '';
      lines.push(`unknown  ${item.suffix || '-'}  ${item.path}  ${item.reason}${metaSuffix}`);
    }
    const hidden = scan.unknownTotal - scan.unknown.length;
    if (hidden > 0) lines.push(`... 另有 ${hidden} 个未识别候选未列出`);
  }

  let engineHints = detectEngineFingerprintHints(scan);
  const locSection = readWorkspaceTomlSection(workspace, 'vn.localization');
  const declaredRaw = typeof locSection?.engine === 'string' ? locSection.engine.trim() : '';
  const declared = declaredRaw.toLowerCase();
  const declaredAlreadyKnown = Boolean(
    declared &&
      (hits.some((h) => h.engine.trim().toLowerCase() === declared) ||
        (projDirectReady && projEngName === declared) ||
        dynamicDirectDetections.some((d) => d.engine.trim().toLowerCase() === declared))
  );
  if (declared && !declaredAlreadyKnown) {
    const ev = `papercup.toml [vn.localization].engine=${declared}`;
    const existing = engineHints.find((h) => h.engine === declared);
    if (existing) {
      existing.confidence = 'high';
      if (!existing.evidence.includes(ev)) existing.evidence.push(ev);
    } else {
      engineHints.push({
        engine: declared,
        displayName: ENGINE_DISPLAY_NAMES[declared] ?? declaredRaw,
        confidence: 'high',
        evidence: [ev],
      });
    }
  }
  if (filterEngine) {
    engineHints = engineHints.filter((h) => h.engine === filterEngine);
  }
  engineHints.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return a.engine.localeCompare(b.engine);
  });

  if (engineHints.length > 0) {
    lines.push('');
    lines.push('引擎指纹线索（尚未配备内置解包器/技能，供 reverser 先回忆公开格式再逐字节验证）：');
    for (const hint of engineHints) {
      lines.push(
        `hint  ${hint.engine} (${hint.displayName})  confidence=${hint.confidence}  evidence=${hint.evidence.join('; ')}`
      );
    }
  }

  const noPrimaryEngine = !hits.length && !projDirectReady && !dynamicDirectDetections.length;
  if (noPrimaryEngine || engineHints.length > 0) {
    const researchDir = resolveWorkspacePaths(workspace).researchDir;
    if (!isSymlinkPath(researchDir) && fs.existsSync(researchDir)) {
      try {
        if (fs.statSync(researchDir).isDirectory()) {
          const researchDirs = fs
            .readdirSync(researchDir, { withFileTypes: true })
            .filter(
              (ent) =>
                ent.isDirectory() &&
                !ent.name.startsWith('.') &&
                !isSymlinkPath(path.join(researchDir, ent.name))
            )
            .map((ent) => ent.name)
            .sort((a, b) => a.localeCompare(b));
          if (researchDirs.length > 0) {
            lines.push(`已有研究目录：${researchDirs.map((d) => `.papercup/research/${d}`).join(', ')}`);
          }
        }
      } catch {
        // ignore unreadable research directory
      }
    }
  }

  try {
    const locLoaded = loadProfile(workspace);
    const targetLang =
      locLoaded.profile?.targetLang ||
      (typeof locSection?.target_lang === 'string' && locSection.target_lang.trim() ? locSection.target_lang.trim() : 'zh-CN');
    const fontCoverage = scanWorkspaceBundledFonts(workspace, targetLang).filter((f) => f.needsPatch);
    if (fontCoverage.length > 0) {
      lines.push('');
      lines.push(`字体缺字警告（检测到 ${fontCoverage.length} 个随附字体缺少目标语言字形，建议委派 reverser 调用 vn_patch_font 补全字库）：`);
      for (const fc of fontCoverage) {
        const samples = fc.missingSamples.slice(0, 8).join('');
        lines.push(
          `font  ${fc.relPath}  family=${fc.familyName || '-'}  missing=${fc.probeMissingCount}/${fc.probeTotalCount}${samples ? `  samples=${samples}` : ''}`
        );
      }
    }
  } catch {
    // ignore unreadable bundled font scan
  }

  const primaryEngineRaw =
    hits[0]?.engine ?? (projDirectReady ? projEngName : dynamicDirectDetections[0]?.engine ?? '');
  const engineId = primaryEngineRaw ? primaryEngineRaw.trim().toLowerCase() : null;
  const engineName = engineId ? ENGINE_DISPLAY_NAMES[engineId] ?? engineId : null;
  return {
    engineId,
    engineName,
    engineKnown: Boolean(engineId),
    text: lines.join('\n'),
    ...(runtimeBindings.length ? { bindings: runtimeBindings } : {}),
    ...(engineHints.length ? { engineHints } : {}),
  };
}

export function detectVnEngines(cwd: string, options: { engine?: string } = {}): string {
  return detectVnEngineSummary(cwd, options).text;
}

function summarizeWorkspaceProgressLogs(workspace: string): string | null {
  try {
    const wsPaths = resolveWorkspacePaths(workspace);
    const logsDir = wsPaths.logsDir;
    if (isSymlinkPath(logsDir) || !fs.existsSync(logsDir) || !fs.statSync(logsDir).isDirectory()) {
      return null;
    }
    let hasHandoff = false;
    const recentLogs: string[] = [];
    for (const ent of fs.readdirSync(logsDir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(logsDir, ent.name);
      if (isSymlinkPath(full) || !ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith('.md')) continue;
      if (ent.name === 'HANDOFF.md') {
        hasHandoff = true;
      } else {
        recentLogs.push(ent.name);
      }
    }
    recentLogs.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const topRecent = recentLogs.slice(0, 3);
    if (!hasHandoff && topRecent.length === 0) {
      return null;
    }
    if (hasHandoff && topRecent.length > 0) {
      return `进度日志：${WORKSPACE_HANDOFF_LOG_REL}；近期日志 ${topRecent.join(', ')}（新对话/续跑请先 read 交接单接续上下文）`;
    }
    if (hasHandoff) {
      return `进度日志：${WORKSPACE_HANDOFF_LOG_REL}（新对话/续跑请先 read 交接单接续上下文）`;
    }
    return `进度日志：${WORKSPACE_LOGS_REL}/（近期：${topRecent.join(', ')}；新对话/续跑请先 read 接续上下文）`;
  } catch {
    return null;
  }
}

export function getVnStatus(cwd: string): string {
  const { workspace, homeDir } = resolveContext(cwd);
  const progressLogLine = summarizeWorkspaceProgressLogs(workspace);
  const loaded = loadProfile(workspace);
  const lines = [`本地化 profile：${loaded.path ? displayRel(loaded.path, workspace) : '未配置'}`];
  if (!loaded.configured) {
    lines.push('状态：未配置。在工作区 papercup.toml 写 [vn.localization]，至少包含 narrative_pov（first / second / third / mixed / source）。');
    if (progressLogLine) lines.push(progressLogLine);
    return lines.join('\n');
  }
  if (loaded.errors.length || !loaded.profile) {
    lines.push('状态：配置不合法', ...loaded.errors.map((e) => `- ${e}`));
    if (progressLogLine) lines.push(progressLogLine);
    return lines.join('\n');
  }
  const profile = loaded.profile;
  const memory = loadProfileMemory(workspace, homeDir, profile);
  const state = readiness(profile, memory);
  lines.push(`状态：就绪${state.quality !== 'ok' ? `（质量标记 ${state.quality}）` : ''}`);
  if (!state.ready) lines.push('未就绪原因：', ...state.reasons.map((r) => `- ${r}`));
  lines.push(`叙事视角：${profile.narrativePov}`);
  if (profile.playerAddress) lines.push(`称呼：${profile.playerAddress}`);
  if (profile.mixedRules) lines.push(`混合视角规则：${profile.mixedRules}`);
  lines.push(`语言：${profile.sourceLang} -> ${profile.targetLang}`);
  lines.push(`长度：比例上限 ${profile.maxLenRatio || 0}；绝对上限 ${profile.maxLenAbs || '未设置'}`);
  lines.push(`术语表：${Object.keys(memory.glossary).length} 条${profile.glossaryFile ? `（${profile.glossaryFile}）` : ''}`);
  const structured = Object.values(memory.persona).filter((c) => c.stages.length || c.twists.length).length;
  lines.push(`人设：${Object.keys(memory.persona).length} 条${structured ? `，${structured} 条含阶段/转折` : ''}${profile.personaFile ? `（${profile.personaFile}）` : ''}`);
  const wsPaths = resolveWorkspacePaths(workspace);
  const rosterStore = readCharacterRoster(workspace);
  const pendingCharForm = findPendingCharacterForm(workspace);
  if (pendingCharForm) {
    lines.push(`角色名册：待用户确认表单（${pendingCharForm.formId}，共 ${pendingCharForm.items.length} 位角色）`);
  } else if (rosterStore?.status === 'locked') {
    lines.push(`角色名册：已锁定 ${rosterStore.characters.length} 位角色（${WORKSPACE_CHARACTERS_REL}）`);
  } else {
    const ext = extractCharacterCandidates(workspace, { extraGlossary: memory.glossary });
    if (ext.totalCharacters > 0) {
      lines.push(`角色名册：未确认（检测到 ${ext.totalCharacters} 位出场角色，翻译前需发送确认表单）`);
    }
  }
  if (!profile.residueCheck) lines.push('⚠ 质量警告：residue_check=false，已禁用日文假名残留检查。');
  const patchCfg = loadWorkspacePatchConfig(workspace);
  if (patchCfg.encoding !== 'auto' || patchCfg.hookMode !== 'auto' || patchCfg.codepage !== undefined || patchCfg.fontName) {
    lines.push(
      `补丁配置：[vn.patch] encoding=${patchCfg.encoding}，hook_mode=${patchCfg.hookMode}${patchCfg.codepage !== undefined ? `，codepage=${patchCfg.codepage}` : ''}${patchCfg.fontName ? `，font=${patchCfg.fontName}` : ''}`
    );
  }
  const smokeState = getSmokeConfigState(workspace, homeDir);
  const latestSmoke = readSmokeReport(workspace);
  const preTranslateSmoke = readPreTranslateSmokeRecord(workspace);
  let activeCustomSkill = null as ReturnType<typeof resolveActiveCustomSkillForPreTranslateSmoke>;
  try {
    activeCustomSkill = resolveActiveCustomSkillForPreTranslateSmoke(workspace, homeDir);
  } catch {
    activeCustomSkill = null;
  }
  if (smokeState.effective.enabled || latestSmoke || preTranslateSmoke) {
    const gateTxt = smokeState.effective.enabled ? '门禁已启用' : '门禁未启用';
    const repTxt = latestSmoke
      ? latestSmoke.ok
        ? `最近通过（${latestSmoke.warningCount} warning，推进 ${latestSmoke.stepsAdvanced} 步）`
        : latestSmoke.failureKind === 'harness'
          ? `最近因工具故障未完成（${latestSmoke.findings.filter((f) => f.severity === 'error').map((f) => f.ruleId).join(', ') || 'harness.driver_failed'}，不计自修轮数）`
          : `最近失败（${latestSmoke.errorCount} error，第 ${latestSmoke.repairRound}/${latestSmoke.maxRepairRounds} 轮）`
      : '尚未运行';
    lines.push(`冒烟测试：${gateTxt}；${repTxt}`);
    if ((smokeState.effective.enabled && activeCustomSkill) || preTranslateSmoke) {
      const preTxt = !preTranslateSmoke
        ? `尚未运行（自定义技能 ${activeCustomSkill?.engine ?? ''} 全量批译前需先跑 vn_smoke_test(preTranslateProbe=true)）`
        : activeCustomSkill &&
            (preTranslateSmoke.skillDigest !== activeCustomSkill.skillDigest ||
              preTranslateSmoke.engine !== activeCustomSkill.engine)
          ? `已过期（技能 ${activeCustomSkill.engine} 已变更，需重跑 vn_smoke_test(preTranslateProbe=true)）`
          : preTranslateSmoke.ok
            ? `已通过（引擎 ${preTranslateSmoke.engine}，${preTranslateSmoke.warningCount} warning）`
            : `未通过（${preTranslateSmoke.errorRules.join(', ') || 'error'}）`;
      lines.push(`批译前单条冒烟：${preTxt}`);
    }
  }

  const acc = acceptanceState(workspace, profile, memory);
  lines.push(`验收：${acc.state === 'accepted' ? '已验收' : acc.state === 'stale' ? '已过期' : acc.state === 'invalid' ? '记录损坏' : '未验收'}`);

  const trackParts: string[] = [];
  for (const track of TRACKS) {
    const label = TRACK_LABELS[track];
    const expected = manifestTrackCount(workspace, track);
    const resRows = countNonEmptyLines(wsPaths.resultsTrackFile(track));
    const buildRows = countNonEmptyLines(wsPaths.buildTrackFile(track));
    const resRel = `${WORKSPACE_RESULTS_REL}/${track}.jsonl`;
    const target = expected !== null ? expected : buildRows > 0 ? buildRows : null;
    if (!target) {
      if (resRows > 0) trackParts.push(`${label} ${resRel} ${resRows} 段`);
      continue;
    }
    if (resRows >= target) trackParts.push(`${label} ${resRel} ${resRows}/${target} 段（已齐）`);
    else if (resRows > 0) trackParts.push(`${label} ${resRel} ${resRows}/${target} 段（尚缺 ${target - resRows} 段）`);
    else trackParts.push(`${label} 0/${target} 段（待译）`);
  }
  if (trackParts.length) lines.push('翻译进度：' + trackParts.join('｜'));
  const batchManifestPath = wsPaths.batchesManifestFile;
  try {
    if (fs.existsSync(batchManifestPath) && !isSymlinkPath(batchManifestPath) && fs.statSync(batchManifestPath).isFile()) {
      const bm = JSON.parse(fs.readFileSync(batchManifestPath, 'utf8').replace(/^\uFEFF/, '')) as {
        total_rows?: number;
        batches?: Array<{ batch_id?: string; rows?: number; line_count?: number }>;
      };
      if (Array.isArray(bm?.batches) && bm.batches.length > 0) {
        let savedBatches = 0;
        let savedLines = 0;
        let totalLines = 0;
        for (const b of bm.batches) {
          const bid = typeof b?.batch_id === 'string' ? b.batch_id.trim() : '';
          const rawRows = b?.rows ?? b?.line_count;
          const expectedLines = typeof rawRows === 'number' && Number.isFinite(rawRows) ? rawRows : 0;
          totalLines += expectedLines;
          if (!bid) continue;
          const outFile = wsPaths.batchOutFile(bid);
          const outCount = countNonEmptyLines(outFile);
          if (outCount > 0) {
            savedBatches += 1;
            savedLines += outCount;
          }
        }
        if (totalLines === 0 && typeof bm.total_rows === 'number' && Number.isFinite(bm.total_rows)) {
          totalLines = bm.total_rows;
        }
        const remainingBatches = bm.batches.length - savedBatches;
        const batchState = remainingBatches === 0 ? '已全部落盘' : `尚缺 ${remainingBatches} 批`;
        lines.push(`批次进度：已落盘 ${savedBatches}/${bm.batches.length} 批（${savedLines}/${totalLines} 段，${batchState}）`);
      }
    }
  } catch {
    // Ignore unreadable batches manifest
  }
  const fontManifest = loadPatchedFontManifest(workspace);
  if (fontManifest.entries.length > 0) {
    lines.push(`字体补丁：已生成 ${fontManifest.entries.length} 个补全字体（${WORKSPACE_FONTS_MANIFEST_REL}）`);
  }
  const postQaReportPath = wsPaths.postQaReportFile;
  try {
    if (fs.existsSync(postQaReportPath) && !fs.lstatSync(postQaReportPath).isSymbolicLink()) {
      const pq = JSON.parse(fs.readFileSync(postQaReportPath, 'utf8'));
      const pending = Number(pq?.roleCheckerPendingChunks || 0);
      const errs = Number(pq?.roleCheckerErrors || 0);
      const reviewed = Number(pq?.roleCheckerChunksReviewed || 0);
      const total = Number(pq?.roleCheckerChunksTotal ?? reviewed + pending);
      if (pq?.interrupted || pending > 0 || errs > 0) {
        lines.push(
          `语义QA状态：${pq?.interrupted ? '已中断' : '未完成'}（已复核 ${reviewed}/${total} 片，待续检 ${pending} 片，错误 ${errs}${pq?.interruptKind ? `，原因 ${pq.interruptKind}` : ''}；可直接调用 vn_post_qa_parallel 续检）`
        );
      }
    }
  } catch {
    // Ignore unreadable post_qa_report.json
  }
  if (progressLogLine) {
    lines.push(progressLogLine);
  }
  return lines.join('\n');
}

export async function unpackVnArchives(
  cwd: string,
  options: { engine?: string; dest?: string; archive?: string } = {},
  signal?: AbortSignal
): Promise<string> {
  const { workspace, homeDir } = resolveContext(cwd);
  const engineArg = (options.engine ?? '').trim().toLowerCase();
  const destArg = (options.dest ?? '').trim();
  const archiveArg = (options.archive ?? '').trim();

  const scan = scanWorkspace(workspace, homeDir);
  const candidateHits = scan.hits.filter((h) => {
    if (BUILTIN_ARCHIVE_KINDS.has(h.kind)) return true;
    const binding = skillBinding(workspace, homeDir, h.engine, h.kind);
    return binding.state === 'ready' || binding.state === 'mismatch';
  });
  let directSkipped = 0;
  const availableHits = candidateHits.filter((h) => {
    if (BUILTIN_ARCHIVE_KINDS.has(h.kind) && h.extra?.override_builtin !== 1) return true;
    const prof = resolveEngineJson(workspace, h.engine, homeDir);
    if (String(prof?.pipeline || '').trim().toLowerCase() === 'direct') {
      directSkipped++;
      return false;
    }
    return true;
  });
  let hits = availableHits;
  if (engineArg) hits = hits.filter((h) => h.engine === engineArg);
  if (archiveArg) {
    const wantedAbs = path.isAbsolute(archiveArg) ? realpathSafe(archiveArg) : realpathSafe(path.join(workspace, archiveArg));
    const exact = hits.filter((h) => realpathSafe(path.join(workspace, h.path)) === wantedAbs);
    hits = exact.length ? exact : hits.filter((h) => path.basename(h.path) === path.basename(archiveArg));
  }
  if (!hits.length) {
    if (directSkipped > 0 && availableHits.length === 0) {
      throw new VnDispatchError('检测到 direct 直抽/直写技能，无需运行 vn_unpack，请直接调用 vn_classify。');
    }
    throw new VnDispatchError(
      buildUnpackNoMatchGuidance({
        availableHits,
        engineArg,
        archiveArg,
        unknownFiles: scan.unknown,
      })
    );
  }

  let destBase: string | null = null;
  if (destArg) {
    destBase = insideWorkspace(workspace, destArg);
    if (!destBase) {
      throw new VnDispatchError(`解包目标目录必须在工作区内：${destArg}`);
    }
  }
  const wsPaths = resolveWorkspacePaths(workspace);
  const lines: string[] = [];

  for (const hit of hits) {
    const src = path.join(workspace, hit.path);
    const relNoExt = hit.path.replace(/\.[^.]+$/, '');
    const outDir = !destBase ? path.join(wsPaths.unpackedDir, relNoExt) : hits.length === 1 ? destBase : path.join(destBase, relNoExt);
    const prevNames = claimUnpackDir(outDir, src);

    let names: string[];
    const overrideBinding = skillBinding(workspace, homeDir, hit.engine, hit.kind);
    const useOverrideSkill = Boolean(
      (hit.extra?.override_builtin === 1 || overrideBinding.overrideBuiltin) &&
        (overrideBinding.state === 'ready' || overrideBinding.state === 'mismatch')
    );
    if (!useOverrideSkill && hit.kind === 'rpa') {
      names = unpackRpa(src, outDir);
    } else if (!useOverrideSkill && hit.kind === 'xp3') {
      names = unpackXp3(src, outDir);
    } else if (!useOverrideSkill && hit.kind === 'pe-zip') {
      names = unpackPeZip(src, outDir);
    } else if (!useOverrideSkill && hit.kind === 'nsa') {
      names = unpackNsa(src, outDir);
    } else {
      const binding = overrideBinding;
      if (binding.state === 'mismatch') throw new VnDispatchError(`${hit.engine} 的技能与画像哈希不一致，拒绝解包。`);
      if (binding.state !== 'ready' || !binding.directory) throw new VnDispatchError(`${hit.engine} 没有可执行解包器。`);
      fs.mkdirSync(outDir, { recursive: true });
      await runPythonScript(path.join(binding.directory, 'unpack.py'), [realpathSafe(src), realpathSafe(outDir)], outDir, undefined, signal);
      names = collectedNamesInUnpacked(outDir, SKILL_MANIFEST);
      const manifest = {
        version: 'skill',
        source: realpathSafe(src),
        engine: hit.engine,
        files: names.map((name) => ({ name })),
      };
      fs.writeFileSync(path.join(outDir, SKILL_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }

    const nameSet = new Set(names);
    const stale = new Set([...prevNames].filter((n) => !nameSet.has(n)));
    const removed = pruneStaleFiles(outDir, stale);
    const suffix = removed ? `；清理 ${removed} 个已移除条目` : '';
    lines.push(`已解包 ${hit.path} -> ${outDir}（${names.length} 个文件${suffix}）`);
  }
  return lines.join('\n');
}

export async function repackVnArchives(
  cwd: string,
  options: { source?: string; dest?: string; dryRun?: boolean; force?: boolean } = {},
  signal?: AbortSignal
): Promise<string> {
  const { workspace, homeDir } = resolveContext(cwd);
  const sourceArg = (options.source ?? '').trim();
  const destArg = (options.dest ?? '').trim();
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);

  let sourcePath = workspace;
  if (sourceArg) {
    const resolvedSrc = insideWorkspace(workspace, sourceArg);
    if (!resolvedSrc) {
      throw new VnDispatchError(`回包源目录必须在工作区内：${sourceArg}`);
    }
    sourcePath = resolvedSrc;
  }
  const manifests = findUnpackManifests(sourcePath);
  if (!manifests.length) {
    throw new VnDispatchError(
      `没有找到 Paper Cup 封包清单（如 .skill-manifest.json / .papercup-*.json）；请通过 vn_unpack 重新解包（不要手工调用 unpack.py 写入 ${WORKSPACE_UNPACKED_REL}/），并优先使用 vn_writeback 组装增量补丁。`
    );
  }

  const wsReal = realpathSafe(workspace);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const outRoot = destArg ? path.resolve(workspace, destArg) : path.join(path.dirname(wsReal), `${path.basename(wsReal) || 'workspace'}.translated-${stamp}`);
  const relOut = path.relative(wsReal, outRoot);
  if (relOut === '' || (!relOut.startsWith('..') && !path.isAbsolute(relOut))) {
    throw new VnDispatchError(`导出目录必须写在工作区之外：${outRoot}`);
  }

  const lines: string[] = [];
  for (const mPath of manifests) {
    const mName = path.basename(mPath);
    const rootDir = path.dirname(mPath);
    const data = JSON.parse(fs.readFileSync(mPath, 'utf8')) as Record<string, unknown>;
    const original = String(data.source || '');
    if (!original) throw new VnDispatchError(`清单缺少 source：${mPath}`);
    let rel = path.relative(wsReal, realpathSafe(original));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.basename(original);
    const target = path.join(outRoot, rel);
    if (realpathSafe(target) === realpathSafe(original)) throw new VnDispatchError(`拒绝覆盖原封包：${original}。换一个 --dest`);
    if (fs.existsSync(target) && !force) throw new VnDispatchError(`目标已存在：${target}。换一个 --dest，或加 --force。`);

    if (dryRun) {
      lines.push(`将写出 ${rootDir} -> ${target}`);
      continue;
    }
    if (mName === SKILL_MANIFEST) {
      const engine = String(data.engine || '');
      const binding = skillBinding(workspace, homeDir, engine);
      if (binding.state !== 'ready' || !binding.directory) throw new VnDispatchError(`${engine} 的技能与画像不一致，拒绝回包。`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await runPythonScript(path.join(binding.directory, 'repack.py'), [realpathSafe(rootDir), path.resolve(target)], rootDir, undefined, signal);
    } else if (mName === RPA_MANIFEST) {
      repackRpa(rootDir, target);
    } else if (mName === XP3_MANIFEST) {
      repackXp3(rootDir, target);
    } else if (mName === PEZIP_MANIFEST) {
      repackPeZip(rootDir, target);
    } else if (mName === NSA_MANIFEST) {
      repackNsa(rootDir, target);
    }
    lines.push(`已写出 ${rootDir} -> ${target}`);
    lines.push(`原包未改动：${original}`);
  }
  if (dryRun) lines.push(`试运行：没有写任何文件；默认导出目录 ${outRoot}`);
  return lines.join('\n');
}

export async function classifyVnScripts(
  cwd: string,
  options: { unpacked?: string; out?: string; engine?: string; report?: string }
): Promise<string> {
  const { workspace, homeDir } = resolveContext(cwd);
  const wsPaths = resolveWorkspacePaths(workspace);
  const rawUnpacked = (options.unpacked ?? '').trim();
  const outArg = (options.out ?? '').trim() || WORKSPACE_BUILD_REL;
  const projHarness = loadProjectHarnessEngineJson(workspace, homeDir);
  const explicitEngineProf = options.engine ? resolveEngineJson(workspace, options.engine, homeDir) : null;
  let directCandidate: Record<string, unknown> | null =
    explicitEngineProf && String(explicitEngineProf.pipeline || '').trim().toLowerCase() === 'direct'
      ? explicitEngineProf
      : projHarness && String(projHarness.pipeline || '').trim().toLowerCase() === 'direct'
        ? projHarness
        : null;

  let unpackedArg = rawUnpacked || WORKSPACE_UNPACKED_REL;
  if (!rawUnpacked || rawUnpacked === WORKSPACE_UNPACKED_REL) {
    const defaultUnpackedAbs = insideWorkspace(workspace, WORKSPACE_UNPACKED_REL);
    if (!defaultUnpackedAbs || !fs.existsSync(defaultUnpackedAbs)) {
      if (!directCandidate) {
        const dynamicDirect = resolveReadyDirectSkill(workspace, homeDir, options.engine ?? '');
        if (dynamicDirect) directCandidate = dynamicDirect.profile;
      }
      if (directCandidate) {
        unpackedArg = String(directCandidate.direct_root || '.').trim() || '.';
      }
    }
  }
  if (!unpackedArg || !outArg) throw new VnDispatchError('vn classify 需要 --unpacked 与 --out。');
  const unpacked = insideWorkspace(workspace, unpackedArg);
  const out = insideWorkspace(workspace, outArg);
  if (!unpacked) throw new VnDispatchError('解包目录必须在工作区内。');
  if (!out) throw new VnDispatchError('输出目录必须在工作区内。');
  const { engine, profile } = resolveClassifyProfileForUnpacked(
    workspace,
    homeDir,
    options.engine ?? (typeof directCandidate?.name === 'string' ? directCandidate.name : ''),
    unpacked
  );
  const resolvedEngine = (engine || (typeof profile?.name === 'string' ? profile.name : '')).trim().toLowerCase();
  const binding = resolvedEngine ? skillBinding(workspace, homeDir, resolvedEngine) : { state: 'absent' as const };
  if (binding.state === 'mismatch') {
    const detail = binding.errors?.length ? `（${binding.errors.join('；')}）` : '';
    throw new VnDispatchError(`${resolvedEngine} 的技能 SHA-256 完整性校验失败，拒绝执行 extract.py${detail}。`);
  }
  const resolvedPipeline = String(profile?.pipeline || '').trim().toLowerCase();
  const classifyCfg =
    profile && profile.classify && typeof profile.classify === 'object' && !Array.isArray(profile.classify)
      ? (profile.classify as Record<string, unknown>)
      : null;
  const classifyCfgExts = Array.isArray(classifyCfg?.extensions)
    ? classifyCfg.extensions.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const classifyCfgTags =
    classifyCfg?.tags && typeof classifyCfg.tags === 'object' && !Array.isArray(classifyCfg.tags)
      ? Object.keys(classifyCfg.tags as Record<string, unknown>)
      : [];
  const classifyCfgAttrs = Array.isArray(classifyCfg?.text_attrs) ? classifyCfg.text_attrs.filter(Boolean) : [];
  const onlyBinaryClassifyExts =
    Boolean(classifyCfg) &&
    !String(classifyCfg?.profile || '').trim() &&
    classifyCfgTags.length === 0 &&
    classifyCfgAttrs.length === 0 &&
    classifyCfgExts.length > 0 &&
    classifyCfgExts.every((ext) => BINARY_CLASSIFY_EXTS.has(ext));
  const hasClassifyRule = Boolean(classifyCfg) && !onlyBinaryClassifyExts;
  const extractPyPath =
    binding.state === 'ready' && binding.directory ? path.join(binding.directory, 'extract.py') : '';
  const hasExtractPy = Boolean(
    extractPyPath && !isSymlinkPath(extractPyPath) && fs.existsSync(extractPyPath) && fs.statSync(extractPyPath).isFile()
  );

  let res;
  if (
    (resolvedPipeline === 'direct' || resolvedPipeline === 'skill') &&
    binding.state === 'ready' &&
    hasExtractPy &&
    !hasClassifyRule
  ) {
    let extractDirs: string[] = [unpacked];
    if (
      resolvedPipeline === 'skill' &&
      !fs.existsSync(path.join(unpacked, SKILL_MANIFEST))
    ) {
      const nestedManifests = findUnpackManifests(unpacked).filter(
        (m) => path.basename(m) === SKILL_MANIFEST
      );
      if (nestedManifests.length > 0) {
        extractDirs = Array.from(new Set(nestedManifests.map((m) => path.dirname(m))));
      }
    }
    const seenIds = new Set<string>();
    const extraRows: Awaited<ReturnType<typeof runSkillExtractRows>> = [];
    for (const dir of extractDirs) {
      const rows = await runSkillExtractRows(dir, extractPyPath, seenIds);
      extraRows.push(...rows);
    }
    const fileSet = new Set<string>();
    const scenario = [];
    const ui = [];
    for (const row of extraRows) {
      if (row.kind === 'say') scenario.push(row);
      else ui.push(row);
      fileSet.add(row.file);
    }
    res = {
      engine: resolvedEngine,
      profile: resolvedPipeline,
      warnings: [],
      files: Array.from(fileSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      lines: extraRows,
      scenario,
      ui,
    };
  } else {
    res = classifyUnpacked(unpacked, { engine: resolvedEngine || engine, engineProfile: profile });
    if (res.engine) {
      const resBinding = skillBinding(workspace, homeDir, res.engine);
      if (resBinding.state === 'mismatch') {
        const detail = resBinding.errors?.length ? `（${resBinding.errors.join('；')}）` : '';
        throw new VnDispatchError(`${res.engine} 的技能 SHA-256 完整性校验失败，拒绝执行 extract.py${detail}。`);
      }
      if (resBinding.state === 'ready' && resBinding.directory) {
        const extractPy = path.join(resBinding.directory, 'extract.py');
        if (!isSymlinkPath(extractPy) && fs.existsSync(extractPy) && fs.statSync(extractPy).isFile()) {
          const existingIds = new Set(res.lines.map((l) => l.id));
          const extraRows = await runSkillExtractRows(unpacked, extractPy, existingIds);
          if (extraRows.length) {
            res.lines.push(...extraRows);
            const fileSet = new Set(res.files);
            for (const row of extraRows) {
              if (row.kind === 'say') res.scenario.push(row);
              else res.ui.push(row);
              fileSet.add(row.file);
            }
            res.files = Array.from(fileSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          }
        }
      }
    }
  }
  const sysText = profile?.system_text;
  if (sysText && typeof sysText === 'object' && !Array.isArray(sysText)) {
    const rasterUi = (sysText as Record<string, unknown>).raster_ui;
    if (Array.isArray(rasterUi)) {
      const list = rasterUi.map((item) => String(item || '').trim()).filter(Boolean);
      if (list.length) {
        res.warnings.push(`检测到图片型界面素材（${list.join('、')}）；按当前引擎技能规范暂不翻译图片内文字，系统文本与界面文案已纳入界面轨。`);
      }
    }
  }

  const written = writeClassification(workspace, out, res, options.report || null);
  const lines = [
    `分类完成：引擎 ${res.engine || '未识别'}（${res.profile}）；剧情 ${res.scenario.length} 条；界面 ${res.ui.length} 条。`,
    `剧情：${displayRel(written.scenario, workspace)}`,
    `界面：${displayRel(written.ui, workspace)}`,
    `清单：${displayRel(written.manifest, workspace)}`,
  ];
  if (written.report) lines.push(`报告：${displayRel(written.report, workspace)}`);
  if (res.warnings.length) lines.push('警告：', ...res.warnings.map((w) => `- ${w}`));
  return lines.join('\n');
}

export function verifyVnQa(
  cwd: string,
  options: { pairs?: string; source?: string; target?: string; json?: boolean }
): VnGateResult {
  const { workspace, homeDir } = resolveContext(cwd);
  const { profile, memory, quality } = requireReadyLocalization(workspace, homeDir);
  const pairsArg = (options.pairs ?? '').trim();
  const pairs: Array<[string, string]> = pairsArg
    ? readQaPairsFromFile(workspace, pairsArg)
    : (() => {
        const source = options.source ?? '';
        const target = options.target ?? '';
        if (!source && !target) throw new VnDispatchError('vn qa 需要 --pairs 或 --source + --target。');
        return [[source, target]];
      })();

  const controlPattern = resolveWorkspaceControlPattern(workspace, homeDir);
  const reports = pairs.map(([src, tgt]) => qaReport(src, tgt, profile, memory.glossary, { controlPattern }));
  const blocked = reports.some((r) => r.blocked);
  const failedCount = reports.filter((r) => r.blocked).length;
  const MAX_QA = 200;
  const indexed = reports.map((r, i) => ({ index: i + 1, report: r }));
  const interesting = indexed.filter((x) => x.report.blocked || x.report.findings.length > 0);
  const targetList = interesting.length > 0 ? interesting : indexed;
  const shownList = targetList.slice(0, MAX_QA);
  const truncated = targetList.length > MAX_QA || (interesting.length === 0 && reports.length > MAX_QA);

  if (options.json) {
    const shown = shownList.map((x) => ({ index: x.index, ...x.report.asDict() }));
    const payload: Record<string, unknown> = {
      ok: !blocked,
      quality,
      residue_check: profile.residueCheck,
      total_pairs: reports.length,
      failed_pairs: failedCount,
      pairs: shown,
    };
    if (truncated) payload.truncated = true;
    return { text: JSON.stringify(payload, null, 2), blocked };
  }

  const lines = [`本地化 QA：${reports.length} 段；${blocked ? `未通过（${failedCount} 段失败）` : '通过'}`];
  if (!profile.residueCheck) {
    lines.push('⚠ 质量警告：residue_check=false，已禁用日文假名残留检查。');
  }
  for (const item of shownList) {
    const repLines = item.report.lines();
    if (repLines.length) {
      for (const l of repLines) lines.push(`${item.index}. ${l}`);
    } else {
      lines.push(`${item.index}. 通过`);
    }
  }
  if (truncated) {
    lines.push(`... 其余 ${targetList.length - shownList.length} 条已截断（共 ${reports.length} 段，失败 ${failedCount} 段）`);
  }
  return { text: lines.join('\n'), blocked };
}

export async function applyVnTranslations(
  cwd: string,
  options: {
    track: string;
    input: string;
    root: string;
    scene?: string;
    allowPartial?: boolean;
    encoding?: string;
    json?: boolean;
  }
): Promise<string> {
  const { workspace, homeDir } = resolveContext(cwd);
  if (!options.track || !options.input || !options.root) {
    throw new VnDispatchError('vn apply 需要 --track、--input 与 --root。');
  }
  const inputPath = insideWorkspace(workspace, options.input);
  const rootDir = insideWorkspace(workspace, options.root);
  if (!inputPath) throw new VnDispatchError('--input 必须在工作区内。');
  if (!rootDir || isSymlinkPath(rootDir) || !fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new VnDispatchError(`--root 必须是工作区内目录：${options.root}`);
  }
  const { profile, memory } = requireReadyLocalization(workspace, homeDir);
  const rows = readResultsJsonl(inputPath);
  const manifests = findUnpackManifests(rootDir);
  const projHarnessEng = String(loadProjectHarnessEngineJson(workspace, homeDir)?.name || '');
  const fallbackEngine = String(readManifest(workspace)?.engine || '') || projHarnessEng;
  const skillApply = resolveReadySkillScript(workspace, homeDir, manifests, 'apply.py', fallbackEngine);
  const controlPattern = resolveWorkspaceControlPattern(workspace, homeDir, skillApply?.engine || fallbackEngine);
  const sceneFilter = (options.scene ?? '').trim();
  if (skillApply) {
    const targetRows = sceneFilter ? rows.filter((r) => String(r.scene ?? '').trim() === sceneFilter) : rows;
    if (!targetRows.length) {
      throw new VnDispatchError(sceneFilter ? `没有符合场景 ${sceneFilter} 的段落。` : '结果文件没有可落盘的段落。');
    }
    for (const r of targetRows) {
      if (r.ok !== true) throw new VnDispatchError(`${String(r.id || '段落')} 未通过 QA，不能落盘。`);
      const rep = qaReport(String(r.source || ''), String(r.target || ''), profile, memory.glossary, { controlPattern });
      if (rep.blocked) {
        throw new VnDispatchError(`QA 拦截：${rep.findings.map((f) => f.message).join('；')}`);
      }
    }
    const expected = !sceneFilter ? manifestTrackCount(workspace, options.track) : null;
    const incomplete = expected !== null && expected > 0 && targetRows.length < expected;
    if (!options.allowPartial && incomplete) {
      throw new VnDispatchError(`${TRACK_LABELS[options.track] || options.track}仅覆盖 ${targetRows.length}/${expected} 段，未写入文件。`);
    }
    const reportPath = path.join(workspace, APPLY_REL);
    if (isSymlinkPath(reportPath)) {
      throw new VnDispatchError(`落盘报告不能是符号链接：${reportPath}`);
    }
    const patchCfg = loadWorkspacePatchConfig(workspace);
    const skillEngineJson = resolveEngineJson(workspace, skillApply.engine, homeDir);
    const allowedCustomEncodings = collectSkillCustomEncodings(skillEngineJson);
    const rawEnc = options.encoding?.trim() || (patchCfg.encoding !== 'auto' ? patchCfg.encoding : '');
    const normalizedEnc = rawEnc
      ? normalizeEncodingName(rawEnc, { allowCustom: true, allowedCustomEncodings })
      : null;
    const extraEnv: Record<string, string> = {
      PAPERCUP_WORKSPACE: workspace,
      PAPERCUP_PATCH_OPTIONS_JSON: JSON.stringify(patchCfg.customOptions ?? {}),
      ...(normalizedEnc ? { PAPERCUP_TARGET_ENCODING: normalizedEnc } : {}),
    };
    let effectiveInput = inputPath;
    let tmpSceneDir: string | null = null;
    if (sceneFilter) {
      tmpSceneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-apply-scene-'));
      effectiveInput = path.join(tmpSceneDir, `${options.track}.jsonl`);
      fs.writeFileSync(effectiveInput, targetRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
    try {
      await runPythonScript(skillApply.scriptPath, [effectiveInput, rootDir], rootDir, undefined, undefined, extraEnv);
    } finally {
      if (tmpSceneDir) {
        fs.rmSync(tmpSceneDir, { recursive: true, force: true });
      }
    }
    const partial = Boolean(sceneFilter || incomplete);
    const manifest = !sceneFilter ? readManifest(workspace) : null;
    const manifestDigest = typeof manifest?.digest === 'string' ? manifest.digest : '';
    const resultsFile = resolveWorkspacePaths(workspace).resultsTrackFile(options.track);
    let resultsSha256 = '';
    if (!sceneFilter && !isSymlinkPath(resultsFile) && fs.existsSync(resultsFile) && fs.statSync(resultsFile).isFile()) {
      resultsSha256 = crypto.createHash('sha256').update(fs.readFileSync(resultsFile)).digest('hex');
    }
    const applyReport: Record<string, unknown> = {
      schema: 1,
      created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      track: options.track,
      scene: sceneFilter,
      root: displayRel(rootDir, workspace),
      mode: 'skill_apply',
      engine: skillApply.engine,
      partial,
      segments: {
        total: targetRows.length,
        applied: targetRows.length,
        skipped: 0,
        ...(incomplete && expected !== null ? { expected_total: expected, missing: expected - targetRows.length } : {}),
      },
      files: [],
      skipped: [],
      ...(expected !== null ? { expected_total: expected } : {}),
      ...(manifestDigest ? { manifest_digest: manifestDigest } : {}),
      ...(resultsSha256 ? { results_sha256: resultsSha256 } : {}),
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const tmpRep = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpRep, JSON.stringify(applyReport, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpRep, reportPath);
    if (options.json) {
      return JSON.stringify(
        { ok: true, partial, applied: targetRows.length, mode: 'skill_apply', engine: skillApply.engine, report: applyReport },
        null,
        2
      );
    }
    return `落盘完成（skill_apply）：${TRACK_LABELS[options.track] || options.track} ${targetRows.length} 段 -> ${displayRel(reportPath, workspace)}。`;
  }
  const outcome = applyResults(workspace, options.root, rows, profile, memory, options.track, {
    scene: sceneFilter,
    allowPartial: Boolean(options.allowPartial),
    encoding: options.encoding || null,
    controlPattern,
    homeDir,
  });
  if (options.json) {
    return JSON.stringify({ ok: true, partial: outcome.partial, applied: outcome.applied, report: outcome.report }, null, 2);
  }
  return `落盘完成：${TRACK_LABELS[options.track] || options.track} ${outcome.applied} 段 -> ${displayRel(outcome.reportPath, workspace)}。`;
}

export function acceptVnRelease(
  cwd: string,
  options: {
    archive: string;
    report?: string;
    track?: string;
    input?: string;
    allowNoResidueCheck?: boolean;
    allowSkipSmoke?: boolean;
    json?: boolean;
  }
): VnGateResult {
  const { workspace, homeDir } = resolveContext(cwd);
  if (!options.archive) throw new VnDispatchError('vn accept 需要 --archive。');
  const { profile, memory, quality } = requireReadyLocalization(workspace, homeDir);
  const allowNoResidue = Boolean(options.allowNoResidueCheck);
  const allowSkipSmoke = Boolean(options.allowSkipSmoke);
  const reportArg = (options.report ?? '').trim();
  const trackArg = (options.track ?? '').trim();
  const inputArg = (options.input ?? '').trim();

  let res;
  if (reportArg) {
    res = validateAcceptance(workspace, homeDir, profile, memory, options.archive, {
      reportPath: reportArg,
      allowNoResidueCheck: allowNoResidue,
      allowSkipSmoke,
    });
  } else if (trackArg && inputArg) {
    const rep = delegatedReport(workspace, profile, memory, inputArg, trackArg, quality, { homeDir });
    if (!rep) {
      return { text: `跳过：${TRACK_LABELS[trackArg] || trackArg}结果没有段落，未写验收记录。`, blocked: false };
    }
    res = validateAcceptance(workspace, homeDir, profile, memory, options.archive, {
      report: rep,
      allowNoResidueCheck: allowNoResidue,
      allowSkipSmoke,
    });
  } else {
    throw new VnDispatchError('vn accept 需要 --archive，以及 --report 或 --track + --input。');
  }

  let recordPath: string | null = null;
  if (res.ok && res.record) {
    const merged = mergeAcceptance(acceptanceState(workspace, profile, memory).record, res.record);
    recordPath = writeAcceptance(workspace, merged);
  }
  if (options.json) {
    return {
      text: JSON.stringify({ ok: res.ok, findings: res.findings, record: res.record, record_path: recordPath ? displayRel(recordPath, workspace) : null }, null, 2),
      blocked: res.blocked,
    };
  }
  const lines = res.findings.map((f) => `[${f.severity}] ${f.rule}: ${f.message}`);
  if (res.ok && res.record) {
    lines.push(String(res.record.summary || '已验收'));
    if (recordPath) lines.push(`验收记录：${displayRel(recordPath, workspace)}`);
  } else {
    lines.push('验收未通过：先处理上面的 error 项，再重新运行。');
  }
  return { text: lines.join('\n'), blocked: res.blocked };
}

export function releaseVnPatch(
  cwd: string,
  options: {
    track?: string;
    note?: string;
    out?: string;
    claimHumanReviewed?: string;
    dryRun?: boolean;
    overwrite?: boolean;
    json?: boolean;
  } = {}
): string {
  const { workspace, homeDir } = resolveContext(cwd);
  const { profile, memory } = requireReadyLocalization(workspace, homeDir);
  const state = acceptanceState(workspace, profile, memory);
  if (state.state === 'none') throw new VnDispatchError('尚未验收：先运行 vn accept。');
  if (state.state === 'stale') throw new VnDispatchError('验收记录已过期：profile 或记忆已变更，需重新翻译并验收。');
  if (state.state === 'invalid' || !state.record) throw new VnDispatchError(`验收记录读不了：检查 ${WORKSPACE_ACCEPTANCE_REL}。`);

  const tracks = (state.record.tracks && typeof state.record.tracks === 'object' ? state.record.tracks : {}) as Record<string, Record<string, unknown>>;
  for (const [name, blk] of Object.entries(tracks)) {
    if (blk?.partial === true) {
      throw new VnDispatchError(`${TRACK_LABELS[name] || name}是部分落盘；发布被拒，补翻译后重新落盘并验收。`);
    }
    const expected = manifestTrackCount(workspace, name);
    const segs = typeof blk?.segments === 'number' ? blk.segments : 0;
    if (expected !== null && expected > 0 && segs < expected) {
      throw new VnDispatchError(`${TRACK_LABELS[name] || name}仅验收 ${segs}/${expected} 段；发布被拒。`);
    }
  }
  const selectedTrack = options.track ?? '';
  if (selectedTrack && Object.keys(tracks).length && !tracks[selectedTrack]) {
    throw new VnDispatchError(`验收记录没有${TRACK_LABELS[selectedTrack] || selectedTrack}；先验收该轨。`);
  }
  if (!selectedTrack && Object.keys(tracks).length) {
    const missing = TRACKS.filter((t) => (manifestTrackCount(workspace, t) || 0) > 0 && !tracks[t]);
    if (missing.length) {
      throw new VnDispatchError(`两轨齐才放行：缺少${missing.map((m) => TRACK_LABELS[m]).join('、')}验收。`);
    }
  }

  // Re-verify accepted archive / patch_manifest.json (and all listed artifacts) before releasing
  const archiveBlk =
    state.record.archive && typeof state.record.archive === 'object'
      ? (state.record.archive as Record<string, unknown>)
      : null;
  if (archiveBlk && typeof archiveBlk.path === 'string' && archiveBlk.path.trim() && typeof archiveBlk.sha256 === 'string' && archiveBlk.sha256.trim()) {
    const archPath =
      archiveBlk.external === true ? path.resolve(archiveBlk.path) : insideWorkspace(workspace, archiveBlk.path);
    if (!archPath || isSymlinkPath(archPath) || !fs.existsSync(archPath) || !fs.statSync(archPath).isFile()) {
      throw new VnDispatchError(`验收产物已不存在或不是普通文件：${archiveBlk.path}；请重新生成并验收。`);
    }
    const archBuf = fs.readFileSync(archPath);
    if (sha256Hex(archBuf).toLowerCase() !== archiveBlk.sha256.trim().toLowerCase()) {
      throw new VnDispatchError(`验收后产物哈希已变更：${archiveBlk.path}；请重新运行 vn_accept。`);
    }
    if (path.basename(archPath).toLowerCase() === 'patch_manifest.json') {
      let pm: Record<string, unknown> | null = null;
      try {
        pm = JSON.parse(archBuf.toString('utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      } catch {
        throw new VnDispatchError('补丁清单 patch_manifest.json 损坏；发布被拒。');
      }
      if (!pm || !Array.isArray(pm.artifacts) || pm.artifacts.length === 0) {
        throw new VnDispatchError('补丁清单不含有效产物；发布被拒。');
      }
      const patchDir = path.dirname(archPath);
      for (const item of pm.artifacts) {
        if (!item || typeof item !== 'object') {
          throw new VnDispatchError('补丁产物条目无效；发布被拒。');
        }
        const rec = item as Record<string, unknown>;
        const pRel = typeof rec.patch_rel === 'string' ? rec.patch_rel.trim() : '';
        const iRel = typeof rec.install_rel === 'string' ? rec.install_rel.trim() : '';
        const expSha = typeof rec.sha256 === 'string' ? rec.sha256.trim().toLowerCase() : '';
        const expBytes = Number(rec.bytes ?? -1);
        if (!pRel || !iRel || !expSha || !Number.isFinite(expBytes) || expBytes <= 0) {
          throw new VnDispatchError(`补丁产物元数据不完整：${pRel || '(空路径)'}；发布被拒。`);
        }
        try {
          staysInside('.', iRel);
        } catch {
          throw new VnDispatchError(`补丁安装目标路径越界：${iRel}；发布被拒。`);
        }
        const artFull = insideWorkspace(patchDir, pRel);
        if (!artFull || isSymlinkPath(artFull) || !fs.existsSync(artFull) || !fs.statSync(artFull).isFile()) {
          throw new VnDispatchError(`补丁产物已缺失或越界：${pRel}；请重新生成并验收。`);
        }
        const artBuf = fs.readFileSync(artFull);
        if (artBuf.length !== expBytes || sha256Hex(artBuf).toLowerCase() !== expSha) {
          throw new VnDispatchError(`补丁产物哈希在验收后被篡改：${pRel}；请重新运行 vn_accept。`);
        }
      }
    }
  }

  let humanClaim = '';
  const claimArg = options.claimHumanReviewed ?? '';
  if (claimArg) {
    const cp = insideWorkspace(workspace, claimArg);
    if (!cp || isSymlinkPath(cp) || !fs.existsSync(cp) || !fs.statSync(cp).isFile()) {
      throw new VnDispatchError(`人工声明文件无效：${claimArg}`);
    }
    if (fs.statSync(cp).size > 32 * 1024) {
      throw new VnDispatchError(`人工声明文件超过 32 KiB 上限：${claimArg}`);
    }
    humanClaim = fs.readFileSync(cp, 'utf8').trim();
  }

  const content = buildReleaseNote(profile, memory, state.record, {
    note: options.note ?? '',
    humanClaim,
    track: selectedTrack,
  });
  const targetRel = options.out || DEFAULT_RELEASE_REL;
  let written: string | null = null;
  if (!options.dryRun) {
    written = writeRelease(workspace, targetRel, content, Boolean(options.overwrite));
  }
  if (options.json) {
    return JSON.stringify({
      ok: true,
      path: written ? displayRel(written, workspace) : null,
      dry_run: Boolean(options.dryRun),
      ai_disclosure: true,
      human_claim: Boolean(humanClaim),
    }, null, 2);
  }
  return written ? `已写出发布说明：${displayRel(written, workspace)}` : content;
}

export async function learnVnSkill(
  cwd: string,
  options: {
    engine: string;
    pipeline?: 'skill' | 'builtin' | 'direct';
    unpackScript?: string;
    repackScript?: string;
    unpackedDir?: string;
    extractScript?: string;
    applyScript?: string;
    encoding?: string;
    customEncodings?: string[];
    controlPattern?: string;
    requireWriteback?: boolean;
    confirmLowScenarioCoverage?: boolean;
    archive?: string;
    sampleArchive?: string;
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
  },
  signal?: AbortSignal
): Promise<{ summary: string; status: string }> {
  const { workspace, homeDir } = resolveContext(cwd);
  const hasPackers = Boolean(options.unpackScript?.trim() || options.repackScript?.trim());
  if (hasPackers && (!options.unpackScript?.trim() || !options.repackScript?.trim())) {
    throw new VnDispatchError('使用自定义解包脚本学习时，需同时提供 unpackScript 与 repackScript。');
  }
  if (!hasPackers && !options.unpackedDir?.trim()) {
    throw new VnDispatchError('improve 需要 --unpack 与 --repack，或在内置解包后提供 --unpackedDir 进行结构与系统文本学习。');
  }
  const res = await learnUnpackSkill(workspace, {
    homeDir,
    engine: options.engine,
    pipeline: options.pipeline,
    archive: options.archive || undefined,
    sampleArchive: options.sampleArchive || undefined,
    unpackedDir: options.unpackedDir || undefined,
    unpackScript: options.unpackScript || undefined,
    repackScript: options.repackScript || undefined,
    extractScript: options.extractScript || undefined,
    applyScript: options.applyScript || undefined,
    encoding: options.encoding ?? '',
    customEncodings: options.customEncodings,
    controlPattern: options.controlPattern ?? '',
    requireWriteback: options.requireWriteback ?? true,
    confirmLowScenarioCoverage: Boolean(options.confirmLowScenarioCoverage),
    suffix: options.suffix ?? '',
    magicHex: options.magicHex ?? '',
    magicOffset: options.magicOffset ?? 0,
    classifyProfile: options.classifyProfile ?? '',
    classifyExtensions: options.classifyExtensions ?? [],
    classifyTags: options.classifyTags,
    classifyTextAttrs: options.classifyTextAttrs,
    systemTextFiles: options.systemTextFiles,
    rasterUiAssets: options.rasterUiAssets,
    note: options.note ?? '',
    dryRun: Boolean(options.dryRun),
    overwrite: Boolean(options.overwrite),
    signal,
  });
  return { summary: res.summary, status: res.status };
}

export function promoteVnSkill(
  cwd: string,
  skill: string,
  options: { overwrite?: boolean; dryRun?: boolean; exportDir?: string; includeTestFixture?: boolean } = {}
): string {
  const { workspace, homeDir } = resolveContext(cwd);
  const targetName = skill.trim();
  if (!targetName) throw new VnDispatchError('skill promote 需要指定技能名。');
  const res = promoteSkill(workspace, homeDir, targetName, {
    overwrite: Boolean(options.overwrite),
    dryRun: Boolean(options.dryRun),
    exportDir: options.exportDir,
    includeTestFixture: options.includeTestFixture,
  });
  return res.summary;
}

export interface TranslatorPlanAdviceInput {
  mode: TranslatorMode;
  model?: string;
  preset?: LocalMtPreset;
  packetLines?: number;
  concurrency?: number;
}

export function planVnTranslation(
  cwd: string,
  options: {
    model?: string;
    family?: string;
    batchMaxLines?: number;
    batchMaxSourceTokens?: number;
    sessionMaxSourceTokens?: number;
    concurrency?: number;
    marginRatio?: number;
    generateBatches?: boolean;
    force?: boolean;
    note?: string;
    translatorConfig?: TranslatorPlanAdviceInput;
  } = {}
): Record<string, unknown> {
  const { workspace } = resolveContext(cwd);
  const model = (options.model ?? '').trim();
  const family = (options.family ?? '').trim();
  const analysis = analyzeWorkspaceText(workspace, { model, family });
  const existing = readPlan(workspace) || {};
  const existingCfg = (existing.config && typeof existing.config === 'object' ? existing.config : {}) as Record<string, unknown>;

  const hasConfigArgs =
    options.batchMaxLines !== undefined ||
    options.batchMaxSourceTokens !== undefined ||
    options.sessionMaxSourceTokens !== undefined ||
    options.concurrency !== undefined ||
    options.marginRatio !== undefined ||
    Boolean(options.generateBatches);

  let planPayload: Record<string, unknown> | null = Object.keys(existing).length ? existing : null;
  let batchesPayload: Record<string, unknown> | null = null;

  if (hasConfigArgs) {
    const defaults = defaultPlanConfig();
    const isLocalMt = options.translatorConfig?.mode === 'local_mt';
    const defaultBatchMaxLines = isLocalMt ? Math.min(20, Math.max(8, (options.translatorConfig?.packetLines ?? 8) * 2)) : defaults.batch_max_lines;
    const defaultConcurrency = isLocalMt ? (options.translatorConfig?.concurrency ?? 3) : defaults.concurrency;
    const cfg: PlanConfig = {
      model: model || String(existingCfg.model || defaults.model),
      model_family: family || (model ? '' : String(existingCfg.model_family || defaults.model_family)),
      batch_max_lines: options.batchMaxLines !== undefined ? options.batchMaxLines : Number(existingCfg.batch_max_lines ?? defaultBatchMaxLines),
      batch_max_source_tokens: options.batchMaxSourceTokens !== undefined ? options.batchMaxSourceTokens : Number(existingCfg.batch_max_source_tokens ?? defaults.batch_max_source_tokens),
      session_max_source_tokens: options.sessionMaxSourceTokens !== undefined ? options.sessionMaxSourceTokens : Number(existingCfg.session_max_source_tokens ?? defaults.session_max_source_tokens),
      concurrency: options.concurrency !== undefined ? options.concurrency : Number(existingCfg.concurrency ?? defaultConcurrency),
      margin_ratio: options.marginRatio !== undefined ? options.marginRatio : Number(existingCfg.margin_ratio ?? defaults.margin_ratio),
      note: (options.note ?? '').trim() || String(existingCfg.note || defaults.note),
    };
    planPayload = savePlanConfig(workspace, cfg, analysis, cfg.note);
    if (options.generateBatches) {
      batchesPayload = generateBatches(workspace, cfg, { force: Boolean(options.force) });
    }
  }

  const out: Record<string, unknown> = { ok: true, analysis };
  if (options.translatorConfig?.mode === 'local_mt') {
    const recPacketLines = Math.max(1, Math.min(20, options.translatorConfig.packetLines ?? 8));
    const recConcurrency = Math.max(1, Math.min(8, options.translatorConfig.concurrency ?? 3));
    out.translator_advice = {
      mode: 'local_mt',
      model: options.translatorConfig.model || '(未选择本地模型)',
      preset: options.translatorConfig.preset || 'sakura',
      recommended_packet_lines: recPacketLines,
      recommended_concurrency: recConcurrency,
      note: '当前处于本地翻译专用模型模式：推荐按 packetLines（默认 8 行）切包并启用本地并发通道（默认 3 路；本机 Ollama 自动开启 Flash Attention + q8_0 KV Cache + 2048 上下文），程序会自动执行 TM 去重与失败行云端升舱。',
    };
  }
  if (planPayload) out.plan = planPayload;
  if (batchesPayload) out.batches = batchesPayload;
  return out;
}

export async function runVnCheckpoint(
  cwd: string,
  options: {
    action?: 'init' | 'save' | 'list' | 'rollback';
    stage?: string;
    summary?: string;
    qaVerified?: boolean;
    commit?: string;
  } = {}
): Promise<Record<string, unknown>> {
  const { workspace } = resolveContext(cwd);
  const sub = (options.action ?? 'save').trim().toLowerCase() || 'save';
  if (sub === 'init') {
    const repo = await ensureLocalGitRepo(workspace);
    return { ok: true, action: 'init', repo };
  }
  if (sub === 'list') {
    return { ok: true, action: 'list', checkpoints: listCheckpoints(workspace) };
  }
  if (sub === 'rollback') {
    const resolved = await rollbackCheckpoint(workspace, options.commit ?? '');
    return { ok: true, action: 'rollback', commit: resolved };
  }
  if (sub === 'save') {
    const stage = (options.stage ?? '').trim() || 'checkpoint';
    const summary = (options.summary ?? '').trim() || stage;
    const res = await createCheckpoint(workspace, stage, summary, Boolean(options.qaVerified));
    return { ok: true, action: 'save', ...res };
  }
  throw new VnDispatchError('vn checkpoint action 只能是 init / save / list / rollback。');
}

export function checkinVnBatch(
  cwd: string,
  batchId: string,
  options: {
    raw?: string | null;
    entries?: Array<{ id: string; target: string }>;
    outputFile?: string | null;
    model?: string;
    sessionSeq?: number;
    mode?: TranslatorMode;
    routeStats?: BatchRouteStats;
  } = {}
): Record<string, unknown> {
  const { workspace } = resolveContext(cwd);
  const cleanBatchId = batchId.trim();
  if (!cleanBatchId) throw new VnDispatchError('vn checkin 需要 --batch-id。');
  let inputFile: string | null = null;
  if (options.outputFile) {
    inputFile = insideWorkspace(workspace, options.outputFile);
    if (!inputFile) throw new VnDispatchError('vn checkin 的 --input 文件必须在工作区内。');
  }
  const outcome = checkinBatch(workspace, cleanBatchId, {
    outputFile: inputFile,
    raw: options.raw ?? null,
    entries: options.entries,
    model: (options.model ?? '').trim(),
    sessionSeq: Number(options.sessionSeq ?? 0),
    mode: options.mode,
    routeStats: options.routeStats,
  });
  return {
    ok: true,
    batch_id: outcome.batch_id,
    track: outcome.track,
    rows: outcome.rows,
    status: outcome.status,
    out_path: displayRel(outcome.out_path, workspace),
    out_sha256: outcome.out_sha256,
    progress_path: displayRel(outcome.progress_path, workspace),
  };
}

export function mergeVnBatches(
  cwd: string,
  options: { track?: string; allowPartial?: boolean } = {}
): VnMergeSummary {
  const { workspace, homeDir } = resolveContext(cwd);
  const { profile, memory } = requireReadyLocalization(workspace, homeDir);
  const wsPaths = resolveWorkspacePaths(workspace);
  const trackArg = (options.track ?? '').trim();
  const targetTracks = trackArg
    ? [trackArg]
    : TRACKS.filter((t) => {
        const bf = wsPaths.buildTrackFile(t);
        return fs.existsSync(bf) && countNonEmptyLines(bf) > 0;
      });
  if (!targetTracks.length) throw new VnDispatchError('批次清单中没有可合并的轨道。');

  const requireAll = !options.allowPartial;
  const outcomes = targetTracks.map((t) => mergeTrackResults(workspace, t, profile, memory, requireAll, { homeDir }));
  return {
    ok: outcomes.every((o) => o.failed === 0),
    total_passed: outcomes.reduce((acc, o) => acc + o.passed, 0),
    total_failed: outcomes.reduce((acc, o) => acc + o.failed, 0),
    tracks: outcomes.map((o) => ({
      track: o.track,
      rows: o.rows,
      passed: o.passed,
      failed: o.failed,
      results_path: displayRel(o.results_path, workspace),
      results_sha256: o.results_sha256,
    })),
  };
}

export async function writebackVnCopy(
  cwd: string,
  options: { dest?: string; unpacked?: string; encoding?: string; force?: boolean } = {},
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const { workspace, homeDir } = resolveContext(cwd);
  const { profile, memory } = requireReadyLocalization(workspace, homeDir);
  const outcome = await buildPatchBundle(workspace, profile, memory, {
    homeDir,
    dest: options.dest || null,
    unpackedRoot: options.unpacked || null,
    encoding: options.encoding || null,
    force: Boolean(options.force),
    signal,
  });
  return { ok: true, ...outcome };
}

export const buildVnPatchBundle = writebackVnCopy;

export async function runVnSmokeTest(
  cwd: string,
  options: {
    patchManifest?: string;
    overlayPath?: string;
    overlayTarget?: string;
    preTranslateProbe?: boolean;
    exe?: string;
    advanceSteps?: number;
    timeoutSec?: number;
    useLocaleEmulator?: boolean;
    skipVision?: boolean;
    driver?: SmokeExecutionDriver;
    vision?: SmokeVisionBridge;
  } = {},
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const { workspace, homeDir } = resolveContext(cwd);
  const { profile } = requireReadyLocalization(workspace, homeDir);
  const outcome = await runSmokeTest(workspace, profile, {
    homeDir,
    patchManifestPath: options.patchManifest || null,
    overlayPath: options.overlayPath || null,
    overlayTarget: options.overlayTarget || null,
    preTranslateProbe: Boolean(options.preTranslateProbe),
    exeOverride: options.exe,
    advanceSteps: options.advanceSteps,
    timeoutSec: options.timeoutSec,
    useLocaleEmulator: options.useLocaleEmulator,
    skipVision: options.skipVision,
    driver: options.driver,
    vision: options.vision,
    signal,
  });
  return {
    ...outcome.report,
    reportPath: displayRel(outcome.reportPath, workspace),
  };
}

export function extractVnRoster(cwd: string): CharacterRosterExtractionResult {
  const { workspace, homeDir } = resolveContext(cwd);
  let extraGlossary: Record<string, string> | undefined;
  const loaded = loadProfile(workspace);
  if (loaded.profile) {
    try {
      extraGlossary = loadProfileMemory(workspace, homeDir, loaded.profile).glossary;
    } catch {
      // Ignore unreadable optional glossary
    }
  }
  return extractCharacterCandidates(workspace, { extraGlossary });
}

export function requestVnCharacterConfirmation(
  cwd: string,
  input: {
    title?: string;
    description?: string;
    characters: CharacterConfirmationProposalItem[];
    excludedNames?: Array<string | { sourceName: string; reason?: string }>;
  },
  options?: { sessionId?: string | null }
): ChatFormRecord {
  const { workspace } = resolveContext(cwd);
  return createCharacterConfirmationForm(workspace, input, options);
}

export function listVnChatForms(cwd: string): ChatFormRecord[] {
  const { workspace } = resolveContext(cwd);
  return listChatForms(workspace);
}

export function submitVnCharacterForm(
  cwd: string,
  formId: string,
  submission: { items: CharacterConfirmationSubmissionItem[]; dismissedNames?: string[] }
) {
  const { workspace } = resolveContext(cwd);
  return submitCharacterConfirmationForm(workspace, formId, submission);
}

export function cancelVnChatForm(cwd: string, formId: string): ChatFormRecord {
  const { workspace } = resolveContext(cwd);
  return cancelChatForm(workspace, formId);
}

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc']);

function buildSanitizedFontEnv(): Record<string, string> {
  const allowKeys = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'WINDIR',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ];
  const env: Record<string, string> = { PYTHONIOENCODING: 'utf-8' };
  for (const k of allowKeys) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

export async function patchWorkspaceFont(
  cwd: string,
  options: {
    baseFont?: string;
    fallbackFont?: string;
    includeGb2312?: boolean;
    remapMode?: FontRemapMode;
    signal?: AbortSignal;
  } = {}
): Promise<string> {
  const { workspace } = resolveContext(cwd);
  const wsPaths = resolveWorkspacePaths(workspace);
  const rawRemapMode = options.remapMode ?? 'none';
  if (rawRemapMode !== 'none' && rawRemapMode !== 'sjis_fullwidth_slots') {
    throw new VnDispatchError(`不支持的字体重映射模式：${String(rawRemapMode)}（仅支持 none 或 sjis_fullwidth_slots）`);
  }
  const remapMode: FontRemapMode = rawRemapMode;

  const locLoaded = loadProfile(workspace);
  const locSection = readWorkspaceTomlSection(workspace, 'vn.localization');
  const targetLang =
    locLoaded.profile?.targetLang ||
    (typeof locSection?.target_lang === 'string' && locSection.target_lang.trim()
      ? locSection.target_lang.trim()
      : 'zh-CN');
  const isZhTarget = /^zh(?:[-_]|$)/i.test(targetLang.trim());

  let installRel = '';
  let resolvedBase = '';

  const explicitBase = (options.baseFont ?? '').trim();
  if (explicitBase) {
    const inside = insideWorkspace(workspace, explicitBase);
    if (!inside || isSymlinkPath(inside) || !fs.existsSync(inside) || !fs.statSync(inside).isFile()) {
      throw new VnDispatchError(`基础字体必须在工作区内且为普通文件：${explicitBase}`);
    }
    const ext = path.extname(inside).toLowerCase();
    if (!FONT_EXTS.has(ext)) {
      throw new VnDispatchError(`不支持的字体格式（仅支持 .ttf / .otf / .ttc）：${explicitBase}`);
    }
    installRel = path.relative(workspace, inside).replace(/\\/g, '/');
    if (installRel.startsWith('.papercup/') || installRel.startsWith('patch/')) {
      throw new VnDispatchError(`基础字体不能位于内部产物目录：${installRel}`);
    }
    resolvedBase = inside;
  } else {
    const scanned = scanWorkspaceBundledFonts(workspace, targetLang);
    const needing = scanned.filter((f) => f.needsPatch);
    if (needing.length === 1) {
      installRel = needing[0].relPath;
    } else if (needing.length > 1) {
      throw new VnDispatchError(
        `检测到多个缺少目标语言字形的随附字体：${needing.map((f) => f.relPath).join('、')}；请通过 baseFont 参数指定要修补的字体。`
      );
    } else if (scanned.length === 1) {
      installRel = scanned[0].relPath;
    } else if (scanned.length === 0) {
      throw new VnDispatchError('工作区中未检测到随附字体（.ttf / .otf / .ttc）；如需修补特定字体请传入 baseFont。');
    } else {
      throw new VnDispatchError(
        `检测到 ${scanned.length} 个随附字体且均已覆盖探针字形；如需强制重修请传入 baseFont：${scanned.map((f) => f.relPath).join('、')}`
      );
    }
    resolvedBase = insideWorkspace(workspace, installRel) || path.join(workspace, ...installRel.split('/'));
  }

  const explicitFallback = (options.fallbackFont ?? '').trim();
  const fallbackPath = findSystemFallbackCjkFont(explicitFallback || undefined);
  if (!fallbackPath) {
    throw new VnDispatchError(
      explicitFallback
        ? `指定的回退字体不存在或不可用：${explicitFallback}`
        : '未找到可用的系统 CJK 回退字体（如 simhei.ttf / msyh.ttc / NotoSansSC-VF.ttf / Deng.ttf / simsun.ttc）；请通过 fallbackFont 指定字体路径。'
    );
  }

  const scriptPath = resolveFontPatchScriptPath();
  const patchedRel = `files/${installRel}`;
  const outAbs = path.join(wsPaths.fontsDataDir, ...patchedRel.split('/'));
  staysInside(wsPaths.fontsDataDir, patchedRel);
  if (isSymlinkPath(outAbs)) {
    throw new VnDispatchError(`输出字体路径不能是符号链接：${outAbs}`);
  }
  if (remapMode === 'sjis_fullwidth_slots' && isSymlinkPath(wsPaths.fontRemapFile)) {
    throw new VnDispatchError(`字符重映射文件路径不能是符号链接：${wsPaths.fontRemapFile}`);
  }
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const targetChars = collectWorkspaceTargetChars(workspace);
  fs.mkdirSync(wsPaths.tmpDir, { recursive: true });
  const charsetFile = path.join(wsPaths.tmpDir, `font-charset-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(charsetFile, targetChars.join(''), 'utf8');

  const includeGb2312 = options.includeGb2312 ?? isZhTarget;
  const pyArgs = [
    '-I',
    scriptPath,
    resolvedBase,
    fallbackPath,
    outAbs,
    '--charset-file',
    charsetFile,
    ...(includeGb2312 ? ['--include-gb2312'] : []),
    ...(remapMode === 'sjis_fullwidth_slots'
      ? ['--remap-mode', 'sjis_fullwidth_slots', '--remap-out', wsPaths.fontRemapFile]
      : []),
  ];

  let stdout = '';
  try {
    const res = await execFileAsync(config.pythonPath, pyArgs, {
      cwd: workspace,
      timeout: 120_000,
      signal: options.signal,
      env: buildSanitizedFontEnv(),
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    stdout = res.stdout || '';
  } catch (err) {
    const e = err as { killed?: boolean; code?: number | string; stderr?: string; stdout?: string; message?: string };
    if (e.killed) {
      throw new VnDispatchError('字体补全超时（超过 120 秒）：patch_font.py');
    }
    const detail = ((e.stderr || e.stdout || e.message || '') as string).trim();
    if (e.code === 3 || /fonttools/i.test(detail)) {
      throw new VnDispatchError(`字体补全需要 Python fontTools 库；请先执行 pip install fonttools。详情：${detail.slice(0, 240)}`);
    }
    throw new VnDispatchError(
      `字体补全脚本失败（退出码 ${e.code ?? 1}）：${detail.replace(/\s+/g, ' ').slice(0, 240)}`
    );
  } finally {
    try {
      if (fs.existsSync(charsetFile)) fs.rmSync(charsetFile, { force: true });
    } catch {
      // ignore cleanup error
    }
  }

  let parsedOut: {
    added_glyphs?: number;
    still_missing_count?: number;
    base_family?: string;
    out_bytes?: number;
    remap_mode?: FontRemapMode;
    remapped_count?: number;
    remap_overflow_count?: number;
    remap_file?: string | null;
  } = {};
  try {
    const lastLine = stdout.trim().split(/\r?\n/).pop() || '{}';
    parsedOut = JSON.parse(lastLine) as typeof parsedOut;
  } catch {
    // non-fatal; compute from output file directly below
  }

  if (isSymlinkPath(outAbs) || !fs.existsSync(outAbs) || !fs.statSync(outAbs).isFile()) {
    throw new VnDispatchError(`字体补全未生成有效输出文件：${patchedRel}`);
  }
  if (
    remapMode === 'sjis_fullwidth_slots' &&
    (isSymlinkPath(wsPaths.fontRemapFile) ||
      !fs.existsSync(wsPaths.fontRemapFile) ||
      !fs.statSync(wsPaths.fontRemapFile).isFile())
  ) {
    throw new VnDispatchError(`字体重映射未生成有效映射文件：${WORKSPACE_FONT_REMAP_REL}`);
  }

  const baseBuf = fs.readFileSync(resolvedBase);
  const outBuf = fs.readFileSync(outAbs);
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const remappedCount =
    remapMode === 'sjis_fullwidth_slots' ? Number(parsedOut.remapped_count ?? 0) : undefined;
  const remapOverflowCount =
    remapMode === 'sjis_fullwidth_slots' ? Number(parsedOut.remap_overflow_count ?? 0) : 0;

  const newEntry: PatchedFontEntry = {
    install_rel: installRel,
    patched_rel: patchedRel,
    base_sha256: sha256Hex(baseBuf),
    sha256: sha256Hex(outBuf),
    bytes: outBuf.length,
    base_family: String(parsedOut.base_family || ''),
    fallback_font: path.basename(fallbackPath),
    added_glyphs: Number(parsedOut.added_glyphs ?? 0),
    still_missing_count: Number(parsedOut.still_missing_count ?? 0),
    created_at: nowIso,
    ...(remapMode === 'sjis_fullwidth_slots'
      ? {
          remap_mode: remapMode,
          remapped_count: remappedCount,
          remap_rel: WORKSPACE_FONT_REMAP_REL,
        }
      : {}),
  };

  const manifest = loadPatchedFontManifest(workspace);
  const normKey = (p: string) =>
    process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p.replace(/\\/g, '/');
  const filtered = manifest.entries.filter((e) => normKey(e.install_rel) !== normKey(installRel));
  filtered.push(newEntry);
  savePatchedFontManifest(workspace, {
    schema: 1,
    updated_at: nowIso,
    entries: filtered,
  });

  const summaryLines = [
    `字体补全完成：${installRel} -> .papercup/data/vn/fonts/${patchedRel}`,
    `家族名：${newEntry.base_family || '(未知)'}；回退字体：${newEntry.fallback_font}`,
    `新增字形：${newEntry.added_glyphs} 个；仍缺字形：${newEntry.still_missing_count} 个；输出大小：${newEntry.bytes} B`,
  ];
  if (remapMode === 'sjis_fullwidth_slots') {
    summaryLines.push(
      `CP932 全角空位重映射（${remapMode}）：已重映射 ${remappedCount ?? 0} 个非 SJIS 字符${
        remapOverflowCount > 0 ? `（警告：码位池溢出 ${remapOverflowCount} 个）` : ''
      }；映射表：${WORKSPACE_FONT_REMAP_REL}（vn_writeback 将自动通过 PAPERCUP_CHAR_REMAP_PATH 传给 apply.py）`
    );
  }
  summaryLines.push(
    `清单已更新：${WORKSPACE_FONTS_MANIFEST_REL}（冒烟测试与 vn_writeback 将自动打包该字体）`
  );
  return summaryLines.join('\n');
}
