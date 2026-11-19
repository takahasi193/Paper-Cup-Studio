/**
 * In-process TypeScript VN domain coordinator bridging deterministic VN engine modules
 * (`archives`, `classify`, `profile`, `qa`, `workflow`) to Agent tools, batch orchestration,
 * and engineering status queries without pseudo-CLI argument serialization.
 */

import fs from 'node:fs';
import path from 'node:path';
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
  findUnpackManifests,
  loadEngineProfile,
  repackNsa,
  repackPeZip,
  repackRpa,
  repackXp3,
  runPythonScript,
  scanWorkspace,
  selfCheckArchive,
  skillBinding,
  unpackNsa,
  unpackPeZip,
  unpackRpa,
  unpackXp3,
} from './archives.js';
import {
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
  readiness,
  realpathSafe,
  resolveHomeDir,
  type LocalizationProfile,
  type ProjectMemory,
} from './profile.js';
import { qaReport } from './qa.js';
import {
  DEFAULT_RELEASE_REL,
  acceptanceState,
  buildReleaseNote,
  createCheckpoint,
  delegatedReport,
  ensureLocalGitRepo,
  learnUnpackSkill,
  listCheckpoints,
  mergeAcceptance,
  promoteSkill,
  resolveReadySkillScript,
  rollbackCheckpoint,
  runSkillExtractRows,
  validateAcceptance,
  writeAcceptance,
  writeRelease,
  writebackToIndependentCopy,
} from './workflow.js';

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
  const p = insideWorkspace(workspace, pairsArg) || path.resolve(workspace, pairsArg);
  if (!fs.existsSync(p)) throw new VnDispatchError(`找不到 QA pairs 文件：${pairsArg}`);
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

export function detectVnEngines(cwd: string, options: { engine?: string } = {}): string {
  const { workspace, homeDir } = resolveContext(cwd);
  const filterEngine = (options.engine ?? '').trim().toLowerCase();
  const scan = scanWorkspace(workspace, homeDir);
  const hits = scan.hits.filter((h) => !filterEngine || h.engine === filterEngine);
  const lines: string[] = [];
  if (!hits.length) lines.push('未识别到封包。');

  for (const hit of hits) {
    const version = hit.version || '-';
    let status = '';
    const binding = skillBinding(workspace, homeDir, hit.engine, hit.kind);
    if (!BUILTIN_ARCHIVE_KINDS.has(hit.kind)) {
      if (binding.state === 'ready') {
        status = '  ready  skill unpack';
      } else if (binding.state === 'mismatch') {
        status = '  mismatch  skill hash';
      } else if (NO_UNPACKER_KINDS.has(hit.kind)) {
        status = '  unsupported  当前没有解包器';
      }
    } else if (binding.state === 'ready') {
      status = `  ready  builtin unpack + skill:${hit.engine}`;
    } else if (binding.state === 'mismatch') {
      status = '  mismatch  skill hash';
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

  if (scan.unknownTotal > 0) {
    if (hits.length) lines.push('');
    for (const item of scan.unknown) {
      lines.push(`unknown  ${item.suffix || '-'}  ${item.path}  ${item.reason}`);
    }
    const hidden = scan.unknownTotal - scan.unknown.length;
    if (hidden > 0) lines.push(`... 另有 ${hidden} 个未识别候选未列出`);
  }
  return lines.join('\n');
}

export function getVnStatus(cwd: string): string {
  const { workspace, homeDir } = resolveContext(cwd);
  const loaded = loadProfile(workspace);
  const lines = [`本地化 profile：${loaded.path ? displayRel(loaded.path, workspace) : '未配置'}`];
  if (!loaded.configured) {
    lines.push('状态：未配置。在工作区 papercup.toml 写 [vn.localization]，至少包含 narrative_pov。');
    return lines.join('\n');
  }
  if (loaded.errors.length || !loaded.profile) {
    lines.push('状态：配置不合法', ...loaded.errors.map((e) => `- ${e}`));
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
  if (!profile.residueCheck) lines.push('⚠ 质量警告：residue_check=false，已禁用日文假名残留检查。');

  const acc = acceptanceState(workspace, profile, memory);
  lines.push(`验收：${acc.state === 'accepted' ? '已验收' : acc.state === 'stale' ? '已过期' : acc.state === 'invalid' ? '记录损坏' : '未验收'}`);

  const trackParts: string[] = [];
  for (const track of TRACKS) {
    const label = TRACK_LABELS[track];
    const expected = manifestTrackCount(workspace, track);
    const resRows = countNonEmptyLines(path.join(workspace, 'results', `${track}.jsonl`));
    const buildRows = countNonEmptyLines(path.join(workspace, 'build', `${track}.jsonl`));
    const target = expected !== null ? expected : buildRows > 0 ? buildRows : null;
    if (!target) {
      if (resRows > 0) trackParts.push(`${label} results/${track}.jsonl ${resRows} 段`);
      continue;
    }
    if (resRows >= target) trackParts.push(`${label} results/${track}.jsonl ${resRows}/${target} 段（已齐）`);
    else if (resRows > 0) trackParts.push(`${label} results/${track}.jsonl ${resRows}/${target} 段（尚缺 ${target - resRows} 段）`);
    else trackParts.push(`${label} 0/${target} 段（待译）`);
  }
  if (trackParts.length) lines.push('翻译进度：' + trackParts.join('｜'));
  const postQaReportPath = path.join(workspace, '.papercup', 'vn', 'post_qa_report.json');
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
  let hits = scan.hits.filter((h) => {
    if (BUILTIN_ARCHIVE_KINDS.has(h.kind)) return true;
    const binding = skillBinding(workspace, homeDir, h.engine, h.kind);
    return binding.state === 'ready' || binding.state === 'mismatch';
  });
  if (engineArg) hits = hits.filter((h) => h.engine === engineArg);
  if (archiveArg) {
    const wantedAbs = path.isAbsolute(archiveArg) ? realpathSafe(archiveArg) : realpathSafe(path.join(workspace, archiveArg));
    const exact = hits.filter((h) => realpathSafe(path.join(workspace, h.path)) === wantedAbs);
    hits = exact.length ? exact : hits.filter((h) => path.basename(h.path) === path.basename(archiveArg));
  }
  if (!hits.length) {
    throw new VnDispatchError('没有可解包的 RPA、XP3、PE+ZIP、NSA 或已就绪自定义技能封包。');
  }

  const destBase = destArg ? insideWorkspace(workspace, destArg) || path.resolve(workspace, destArg) : null;
  const lines: string[] = [];

  for (const hit of hits) {
    const src = path.join(workspace, hit.path);
    const relNoExt = hit.path.replace(/\.[^.]+$/, '');
    const outDir = !destBase ? path.join(workspace, 'unpacked', relNoExt) : hits.length === 1 ? destBase : path.join(destBase, relNoExt);
    const prevNames = claimUnpackDir(outDir, src);

    let names: string[];
    if (hit.kind === 'rpa') {
      names = unpackRpa(src, outDir);
    } else if (hit.kind === 'xp3') {
      names = unpackXp3(src, outDir);
    } else if (hit.kind === 'pe-zip') {
      names = unpackPeZip(src, outDir);
    } else if (hit.kind === 'nsa') {
      names = unpackNsa(src, outDir);
    } else {
      const binding = skillBinding(workspace, homeDir, hit.engine, hit.kind);
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

  const sourcePath = sourceArg ? insideWorkspace(workspace, sourceArg) || path.resolve(workspace, sourceArg) : workspace;
  const manifests = findUnpackManifests(sourcePath);
  if (!manifests.length) throw new VnDispatchError('没有找到封包清单');

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
  const unpackedArg = options.unpacked ?? '';
  const outArg = options.out ?? '';
  if (!unpackedArg || !outArg) throw new VnDispatchError('vn classify 需要 --unpacked 与 --out。');
  const unpacked = insideWorkspace(workspace, unpackedArg);
  const out = insideWorkspace(workspace, outArg);
  if (!unpacked) throw new VnDispatchError('解包目录必须在工作区内。');
  if (!out) throw new VnDispatchError('输出目录必须在工作区内。');
  const { engine, profile } = resolveClassifyProfileForUnpacked(workspace, homeDir, options.engine ?? '', unpacked);
  const res = classifyUnpacked(unpacked, { engine, engineProfile: profile });

  if (res.engine) {
    const binding = skillBinding(workspace, homeDir, res.engine);
    if (binding.state === 'ready' && binding.directory) {
      const extractPy = path.join(binding.directory, 'extract.py');
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

  const reports = pairs.map(([src, tgt]) => qaReport(src, tgt, profile, memory.glossary));
  const blocked = reports.some((r) => r.blocked);
  const MAX_QA = 100;

  if (options.json) {
    const shown = reports.slice(0, MAX_QA).map((r, i) => ({ index: i + 1, ...r.asDict() }));
    const payload: Record<string, unknown> = {
      ok: !blocked,
      quality,
      residue_check: profile.residueCheck,
      pairs: shown,
    };
    if (reports.length > MAX_QA) payload.truncated = true;
    return { text: JSON.stringify(payload, null, 2), blocked };
  }

  const lines = [`本地化 QA：${reports.length} 段；${blocked ? '未通过' : '通过'}`];
  reports.slice(0, MAX_QA).forEach((rep, idx) => {
    const repLines = rep.lines();
    if (repLines.length) {
      for (const l of repLines) lines.push(`${idx + 1}. ${l}`);
    } else {
      lines.push(`${idx + 1}. 通过`);
    }
  });
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
  const fallbackEngine = String(readManifest(workspace)?.engine || '');
  const skillApply = !options.scene ? resolveReadySkillScript(workspace, homeDir, manifests, 'apply.py', fallbackEngine) : null;
  if (skillApply) {
    for (const r of rows) {
      if (r.ok !== true) throw new VnDispatchError(`${String(r.id || '段落')} 未通过 QA，不能落盘。`);
      const rep = qaReport(String(r.source || ''), String(r.target || ''), profile, memory.glossary);
      if (rep.blocked) {
        throw new VnDispatchError(`QA 拦截：${rep.findings.map((f) => f.message).join('；')}`);
      }
    }
    const expected = manifestTrackCount(workspace, options.track);
    if (!options.allowPartial && expected !== null && expected > 0 && rows.length < expected) {
      throw new VnDispatchError(`${TRACK_LABELS[options.track] || options.track}仅覆盖 ${rows.length}/${expected} 段，未写入文件。`);
    }
    await runPythonScript(skillApply.scriptPath, [inputPath, rootDir], rootDir);
    if (options.json) {
      return JSON.stringify({ ok: true, partial: false, applied: rows.length, mode: 'skill_apply', engine: skillApply.engine }, null, 2);
    }
    return `落盘完成（skill_apply）：${TRACK_LABELS[options.track] || options.track} ${rows.length} 段。`;
  }
  const outcome = applyResults(workspace, options.root, rows, profile, memory, options.track, {
    scene: options.scene ?? '',
    allowPartial: Boolean(options.allowPartial),
    encoding: options.encoding || null,
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
    json?: boolean;
  }
): VnGateResult {
  const { workspace, homeDir } = resolveContext(cwd);
  if (!options.archive) throw new VnDispatchError('vn accept 需要 --archive。');
  const { profile, memory, quality } = requireReadyLocalization(workspace, homeDir);
  const allowNoResidue = Boolean(options.allowNoResidueCheck);
  const reportArg = (options.report ?? '').trim();
  const trackArg = (options.track ?? '').trim();
  const inputArg = (options.input ?? '').trim();

  let res;
  if (reportArg) {
    res = validateAcceptance(workspace, homeDir, profile, memory, options.archive, {
      reportPath: reportArg,
      allowNoResidueCheck: allowNoResidue,
    });
  } else if (trackArg && inputArg) {
    const rep = delegatedReport(workspace, profile, memory, inputArg, trackArg, quality);
    if (!rep) {
      return { text: `跳过：${TRACK_LABELS[trackArg] || trackArg}结果没有段落，未写验收记录。`, blocked: false };
    }
    res = validateAcceptance(workspace, homeDir, profile, memory, options.archive, {
      report: rep,
      allowNoResidueCheck: allowNoResidue,
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
  if (state.state === 'invalid' || !state.record) throw new VnDispatchError('验收记录读不了：检查 .papercup/vn/acceptance.json。');

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

  let humanClaim = '';
  const claimArg = options.claimHumanReviewed ?? '';
  if (claimArg) {
    const cp = insideWorkspace(workspace, claimArg);
    if (!cp || isSymlinkPath(cp) || !fs.existsSync(cp) || !fs.statSync(cp).isFile()) {
      throw new VnDispatchError(`人工声明文件无效：${claimArg}`);
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
    unpackScript?: string;
    repackScript?: string;
    unpackedDir?: string;
    extractScript?: string;
    applyScript?: string;
    encoding?: string;
    controlPattern?: string;
    requireWriteback?: boolean;
    archive?: string;
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
    archive: options.archive || undefined,
    unpackedDir: options.unpackedDir || undefined,
    unpackScript: options.unpackScript || undefined,
    repackScript: options.repackScript || undefined,
    extractScript: options.extractScript || undefined,
    applyScript: options.applyScript || undefined,
    encoding: options.encoding ?? '',
    controlPattern: options.controlPattern ?? '',
    requireWriteback: options.requireWriteback ?? true,
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
  options: { overwrite?: boolean; dryRun?: boolean } = {}
): string {
  const { workspace, homeDir } = resolveContext(cwd);
  const targetName = skill.trim();
  if (!targetName) throw new VnDispatchError('skill promote 需要指定技能名。');
  const res = promoteSkill(workspace, homeDir, targetName, {
    overwrite: Boolean(options.overwrite),
    dryRun: Boolean(options.dryRun),
  });
  return res.summary;
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
    const cfg: PlanConfig = {
      model: model || String(existingCfg.model || defaults.model),
      model_family: family || (model ? '' : String(existingCfg.model_family || defaults.model_family)),
      batch_max_lines: options.batchMaxLines !== undefined ? options.batchMaxLines : Number(existingCfg.batch_max_lines ?? defaults.batch_max_lines),
      batch_max_source_tokens: options.batchMaxSourceTokens !== undefined ? options.batchMaxSourceTokens : Number(existingCfg.batch_max_source_tokens ?? defaults.batch_max_source_tokens),
      session_max_source_tokens: options.sessionMaxSourceTokens !== undefined ? options.sessionMaxSourceTokens : Number(existingCfg.session_max_source_tokens ?? defaults.session_max_source_tokens),
      concurrency: options.concurrency !== undefined ? options.concurrency : Number(existingCfg.concurrency ?? defaults.concurrency),
      margin_ratio: options.marginRatio !== undefined ? options.marginRatio : Number(existingCfg.margin_ratio ?? defaults.margin_ratio),
      note: (options.note ?? '').trim() || String(existingCfg.note || defaults.note),
    };
    planPayload = savePlanConfig(workspace, cfg, analysis, cfg.note);
    if (options.generateBatches) {
      batchesPayload = generateBatches(workspace, cfg, { force: Boolean(options.force) });
    }
  }

  const out: Record<string, unknown> = { ok: true, analysis };
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
  options: { raw?: string | null; outputFile?: string | null; model?: string; sessionSeq?: number } = {}
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
    model: (options.model ?? '').trim(),
    sessionSeq: Number(options.sessionSeq ?? 0),
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
  const trackArg = (options.track ?? '').trim();
  const targetTracks = trackArg
    ? [trackArg]
    : TRACKS.filter((t) => fs.existsSync(path.join(workspace, 'build', `${t}.jsonl`)) && countNonEmptyLines(path.join(workspace, 'build', `${t}.jsonl`)) > 0);
  if (!targetTracks.length) throw new VnDispatchError('批次清单中没有可合并的轨道。');

  const requireAll = !options.allowPartial;
  const outcomes = targetTracks.map((t) => mergeTrackResults(workspace, t, profile, memory, requireAll));
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
  const outcome = await writebackToIndependentCopy(workspace, profile, memory, {
    homeDir,
    dest: options.dest || null,
    unpackedRoot: options.unpacked || null,
    encoding: options.encoding || null,
    force: Boolean(options.force),
    signal,
  });
  return { ok: true, ...outcome };
}
