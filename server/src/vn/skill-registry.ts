/**
 * Unified 3-tier engine skill discovery, mandatory SHA-256 integrity verification,
 * runtime workspace binding, and sanitized PR-ready skill package export.
 *
 * Pure TypeScript using Node standard modules only.
 * Discovery priority:
 *   1) workspace: <workspace>/.papercup/skills/
 *   2) global:    <homeDir>/skills/  (default ~/.papercup/skills/)
 *   3) repo:      <PaperCup>/skills/ (or PAPERCUP_REPO_SKILLS_DIR)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_SCHEMA_VERSION = 1;

export const SKILL_TIERS = ['workspace', 'global', 'repo'] as const;
export type SkillTier = (typeof SKILL_TIERS)[number];

export const SKILL_RUNTIME_SCRIPTS = ['unpack.py', 'repack.py', 'extract.py', 'apply.py'] as const;
export type SkillRuntimeScript = (typeof SKILL_RUNTIME_SCRIPTS)[number];

export const SKILL_OPTIONAL_SCRIPTS = ['test_fixture.py'] as const;
export type SkillOptionalScript = (typeof SKILL_OPTIONAL_SCRIPTS)[number];

export const SCRIPT_DIGEST_FIELDS: Record<SkillRuntimeScript, string> = {
  'unpack.py': 'unpack-sha256',
  'repack.py': 'repack-sha256',
  'extract.py': 'extract-sha256',
  'apply.py': 'apply-sha256',
};

export const SKILL_MD_DIGEST_FIELD = 'skill-sha256';
export const SKILL_POINTER_FIELD = 'skill';

export const FORBIDDEN_EXPORT_ENGINE_KEYS = new Set([
  'direct_root',
  'source_sample',
  'source-sample',
  'source_sha256',
  'source-sha256',
  'workspace',
  'game_dir',
  'local_path',
]);

export const FORBIDDEN_EXPORT_FRONTMATTER_KEYS = new Set([
  'source-sample',
  'source-sha256',
  'direct-root',
  'workspace',
  'game-dir',
  'local-path',
]);

const ENGINE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_SKILL_JSON_BYTES = 64 * 1024;
const MAX_SKILL_MD_BYTES = 64 * 1024;
const MAX_SKILL_SCRIPT_BYTES = 256 * 1024;

const SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;
const SECRET_PAIR_RE =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key)\s*[=:]\s*(?:['"][A-Za-z0-9_+/.:=-]{8,}['"]|[A-Za-z0-9_+/.=-]{16,}\b)|\b(?:token|secret|password|passwd|cookie)\s*[=:]\s*['"][A-Za-z0-9_+/.:=-]{12,}['"]/i;

const MACHINE_PATH_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'windows_drive_path', re: /(?:^|[\s"'`(=,:])([A-Za-z]:\\[^\s"'`),;]+)/ },
  { label: 'windows_drive_slash_path', re: /(?:^|[\s"'`(=,:])([A-Za-z]:\/[^\s"'`),;]+)/ },
  { label: 'unc_path', re: /(?:^|[\s"'`(=,:])(\\\\[A-Za-z0-9._-]+\\[^\s"'`),;]+)/ },
  { label: 'unix_home_path', re: /(?:^|[\s"'`(=,:])(\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`),;]*)?)/ },
  { label: 'msys_drive_path', re: /(?:^|[\s"'`(=,:])(\/[a-z]\/(?:Users|Program Files|Windows)\/[^\s"'`),;]+)/i },
];

const INTERNAL_OR_BACKUP_TOP_DIRS = new Set([
  '.papercup',
  '.git',
  '.hg',
  '.svn',
  'work',
  'build',
  'results',
  'release',
  'patch',
  'classify-src',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
]);
const BACKUP_DIR_SEGMENTS = new Set(['backup', 'backups', '.papercup_backup', 'papercup_backup']);

export interface SkillDiscoveryOptions {
  homeDir?: string | null;
  workspaceSkillsDir?: string | null;
  globalSkillsDir?: string | null;
  repoSkillsDir?: string | null;
}

export interface SkillTierRoot {
  tier: SkillTier;
  dir: string;
}

export interface SkillPackageRecord {
  skillName: string;
  engine: string;
  tier: SkillTier;
  directory: string;
  engineJsonPath: string | null;
  skillMdPath: string;
  engineJson: Record<string, unknown> | null;
  scripts: Partial<Record<SkillRuntimeScript, string>>;
  hasTestFixture: boolean;
}

export interface SkillIntegrityResult {
  ok: boolean;
  errors: string[];
  verifiedFiles: Record<string, string>;
}

export interface RegistrySkillBinding {
  state: 'ready' | 'mismatch' | 'absent';
  tier?: SkillTier;
  skillName?: string;
  engine?: string;
  directory?: string;
  engineJson?: Record<string, unknown>;
  overrideBuiltin?: boolean;
  verifiedFiles?: Record<string, string>;
  errors?: string[];
}

export interface DynamicWorkspaceBinding {
  engine: string;
  skillName: string;
  tier: SkillTier;
  directory: string;
  pipeline: string;
  boundDirectRoot: string | null;
  matchedPaths: string[];
  runtimeEngineJson: Record<string, unknown>;
  integrity: SkillIntegrityResult;
}

export interface ExportSanitizedSkillOptions {
  sourceSkillDir: string;
  engineJson?: Record<string, unknown> | null;
  targetDir: string;
  overwrite?: boolean;
  dryRun?: boolean;
  includeTestFixture?: boolean;
}

export interface ExportSanitizedSkillResult {
  status: 'dry-run' | 'exported';
  skillName: string;
  engine: string;
  targetDir: string;
  files: string[];
  engineJson: Record<string, unknown>;
  strippedFields: string[];
  warnings: string[];
}

export class SkillRegistryError extends Error {}

function isSymlinkSafe(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function realpathSafe(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function defaultHomeDir(): string {
  const override = (process.env.PAPERCUP_HOME || '').trim();
  if (override) return path.resolve(override);
  const home = (process.env.USERPROFILE || process.env.HOME || os.homedir()).trim();
  return path.join(home, '.papercup');
}

export function isSafeSkillName(name: string): boolean {
  const trimmed = name.trim();
  return Boolean(trimmed && trimmed.length <= 64 && ENGINE_NAME_RE.test(trimmed));
}

export function deriveEngineFromSkillName(skillName: string): string {
  const low = skillName.trim().toLowerCase();
  if (low.startsWith('engine-') && low.length > 'engine-'.length) {
    return low.slice('engine-'.length);
  }
  return low;
}

/**
 * Canonical LF-normalized SHA-256 for UTF-8 skill text files (`SKILL.md`, `*.py`).
 * Matches raw SHA-256 identically for LF files and prevents false tamper errors
 * when Git checks out CRLF line endings on Windows.
 */
export function hashSkillTextContent(content: string | Buffer): string {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function hashSkillFile(filePath: string, maxBytes = MAX_SKILL_SCRIPT_BYTES): string {
  if (isSymlinkSafe(filePath) || !fs.existsSync(filePath)) {
    throw new SkillRegistryError(`技能文件不存在或是符号链接：${filePath}`);
  }
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size <= 0 || st.size > maxBytes) {
    throw new SkillRegistryError(`技能文件大小不合法：${filePath}`);
  }
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0x00)) {
    throw new SkillRegistryError(`技能文本文件包含 NUL 二进制字节：${filePath}`);
  }
  return hashSkillTextContent(buf);
}

export function containsSecretMaterial(text: string): boolean {
  return SECRET_RE.test(text) || SECRET_PAIR_RE.test(text);
}

export function findForbiddenLocalPath(text: string): { label: string; match: string } | null {
  for (const rule of MACHINE_PATH_PATTERNS) {
    const m = rule.re.exec(text);
    if (m) {
      return { label: rule.label, match: m[1] || m[0] };
    }
  }
  return null;
}

export function resolveRepoSkillsDir(override?: string | null): string | null {
  if (override === null) return null;
  if (typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  const envDir = (process.env.PAPERCUP_REPO_SKILLS_DIR || '').trim();
  if (envDir) {
    return path.resolve(envDir);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', '..', 'skills'),
    path.resolve(here, '..', '..', 'skills'),
    path.resolve(process.cwd(), 'skills'),
    path.resolve(process.cwd(), '..', 'skills'),
  ];
  for (const cand of candidates) {
    if (!isSymlinkSafe(cand) && fs.existsSync(cand)) {
      try {
        if (fs.statSync(cand).isDirectory()) {
          return realpathSafe(cand);
        }
      } catch {
        // ignore unreadable candidate
      }
    }
  }
  return null;
}

export function resolveSkillTierRoots(
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): SkillTierRoot[] {
  const roots: SkillTierRoot[] = [];

  if (options.workspaceSkillsDir !== null) {
    if (typeof options.workspaceSkillsDir === 'string' && options.workspaceSkillsDir.trim()) {
      roots.push({ tier: 'workspace', dir: path.resolve(options.workspaceSkillsDir.trim()) });
    } else if (workspace && workspace.trim()) {
      roots.push({ tier: 'workspace', dir: path.join(realpathSafe(workspace), '.papercup', 'skills') });
    }
  }

  if (options.globalSkillsDir !== null) {
    if (typeof options.globalSkillsDir === 'string' && options.globalSkillsDir.trim()) {
      roots.push({ tier: 'global', dir: path.resolve(options.globalSkillsDir.trim()) });
    } else {
      const homeDir = options.homeDir === undefined ? defaultHomeDir() : options.homeDir;
      if (homeDir && homeDir.trim()) {
        roots.push({ tier: 'global', dir: path.join(path.resolve(homeDir.trim()), 'skills') });
      }
    }
  }

  const repoDir = resolveRepoSkillsDir(options.repoSkillsDir);
  if (repoDir) {
    roots.push({ tier: 'repo', dir: repoDir });
  }

  return roots;
}

export function collectSkillRootPaths(
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { dir } of resolveSkillTierRoots(workspace, options)) {
    if (isSymlinkSafe(dir) || !fs.existsSync(dir)) continue;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const real = realpathSafe(dir);
      const key = process.platform === 'win32' ? real.toLowerCase() : real;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(real);
      }
    } catch {
      // ignore unreadable dir
    }
  }
  return out;
}

/**
 * Collect deduplicated winning skill directories across the 3 tiers
 * (`workspace` > `global` > `repo`) so higher tiers shadow lower tiers cleanly
 * without duplicate-skill collisions in Pi Agent SDK `loadSkills`.
 */
export function collectDeduplicatedSkillDirs(
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): string[] {
  const out: string[] = [];
  const seenNames = new Set<string>();
  for (const { dir } of resolveSkillTierRoots(workspace, options)) {
    if (isSymlinkSafe(dir) || !fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || !ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (isSymlinkSafe(full)) continue;
      const mdPath = path.join(full, 'SKILL.md');
      if (isSymlinkSafe(mdPath) || !fs.existsSync(mdPath)) continue;
      try {
        if (!fs.statSync(mdPath).isFile()) continue;
      } catch {
        continue;
      }
      const key = ent.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      out.push(realpathSafe(full));
    }
  }
  return out;
}

function isPathInsideDir(parentDir: string, targetPath: string): boolean {
  const base = realpathSafe(parentDir);
  const child = realpathSafe(targetPath);
  const rel = path.relative(base, child);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Mandatory execution-time SHA-256 guard for Python scripts residing under the
 * `global` (`~/.papercup/skills/`) or `repo` (`<PaperCup>/skills/`) skill tiers.
 * Throws `SkillRegistryError` if `engine.json` is missing, the script digest is absent,
 * or any file in the skill package fails SHA-256 verification.
 */
export function assertSkillScriptVerified(
  scriptPath: string,
  options: SkillDiscoveryOptions = {}
): void {
  const resolvedScript = realpathSafe(scriptPath);
  const roots = resolveSkillTierRoots(null, { ...options, workspaceSkillsDir: null });
  const matchedRoot = roots.find(
    (r) => (r.tier === 'global' || r.tier === 'repo') && fs.existsSync(r.dir) && isPathInsideDir(r.dir, resolvedScript)
  );
  if (!matchedRoot) return;

  const skillDir = path.dirname(resolvedScript);
  const skillName = path.basename(skillDir);
  if (!isSafeSkillName(skillName)) {
    throw new SkillRegistryError(`技能目录名不合法，拒绝执行：${skillDir}`);
  }

  let engineJson = readSkillEngineJsonFile(path.join(skillDir, 'engine.json'));
  if (!engineJson && matchedRoot.tier === 'global') {
    const homeDir = options.homeDir === undefined ? defaultHomeDir() : options.homeDir;
    const engineName = deriveEngineFromSkillName(skillName);
    if (homeDir && isSafeSkillName(engineName)) {
      engineJson = readSkillEngineJsonFile(path.join(path.resolve(homeDir), 'engines', engineName, 'engine.json'));
    }
  }
  if (!engineJson) {
    throw new SkillRegistryError(`${matchedRoot.tier} 技能 ${skillName} 缺少 engine.json，拒绝执行 ${path.basename(resolvedScript)}`);
  }

  const pkg: SkillPackageRecord = {
    skillName,
    engine:
      typeof engineJson.name === 'string' && isSafeSkillName(engineJson.name)
        ? engineJson.name.trim().toLowerCase()
        : deriveEngineFromSkillName(skillName),
    tier: matchedRoot.tier,
    directory: skillDir,
    engineJsonPath: fs.existsSync(path.join(skillDir, 'engine.json')) ? path.join(skillDir, 'engine.json') : null,
    skillMdPath: path.join(skillDir, 'SKILL.md'),
    engineJson,
    scripts: {},
    hasTestFixture: fs.existsSync(path.join(skillDir, 'test_fixture.py')),
  };

  const integrity = verifySkillPackageIntegrity(pkg, {
    engineJsonOverride: engineJson,
    requireAllPresentScriptsHashed: true,
  });
  if (!integrity.ok) {
    throw new SkillRegistryError(
      `${matchedRoot.tier} 技能 ${skillName} SHA-256 完整性校验失败，拒绝执行：${integrity.errors.join('；')}`
    );
  }
}

function readSkillEngineJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (isSymlinkSafe(filePath) || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_SKILL_JSON_BYTES) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readSkillPackageAtDir(dir: string, tier: SkillTier): SkillPackageRecord | null {
  if (isSymlinkSafe(dir) || !fs.existsSync(dir)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;

  const skillName = path.basename(dir);
  if (!isSafeSkillName(skillName)) return null;

  const skillMdPath = path.join(dir, 'SKILL.md');
  if (isSymlinkSafe(skillMdPath) || !fs.existsSync(skillMdPath)) return null;
  try {
    if (!fs.statSync(skillMdPath).isFile()) return null;
  } catch {
    return null;
  }

  const candidateEngineJsonPath = path.join(dir, 'engine.json');
  const hasEngineJson = !isSymlinkSafe(candidateEngineJsonPath) && fs.existsSync(candidateEngineJsonPath);
  const engineJson = hasEngineJson ? readSkillEngineJsonFile(candidateEngineJsonPath) : null;

  // Global and repo tiers are self-contained packages requiring engine.json.
  // Workspace tier may still have legacy split engine.json in project harness.
  if (tier !== 'workspace' && !hasEngineJson) {
    return null;
  }

  const rawEngine = typeof engineJson?.name === 'string' ? engineJson.name.trim().toLowerCase() : '';
  const engine = rawEngine && isSafeSkillName(rawEngine) ? rawEngine : deriveEngineFromSkillName(skillName);

  const scripts: Partial<Record<SkillRuntimeScript, string>> = {};
  for (const script of SKILL_RUNTIME_SCRIPTS) {
    const p = path.join(dir, script);
    if (fs.existsSync(p)) {
      scripts[script] = p;
    }
  }

  const fixturePath = path.join(dir, 'test_fixture.py');
  const hasTestFixture = !isSymlinkSafe(fixturePath) && fs.existsSync(fixturePath);

  return {
    skillName,
    engine,
    tier,
    directory: realpathSafe(dir),
    engineJsonPath: hasEngineJson ? candidateEngineJsonPath : null,
    skillMdPath,
    engineJson,
    scripts,
    hasTestFixture,
  };
}

/**
 * Discover all skill packages across tiers without deduplicating shadowed lower-priority tiers.
 */
export function discoverAllTierSkillPackages(
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): SkillPackageRecord[] {
  const results: SkillPackageRecord[] = [];
  for (const { tier, dir } of resolveSkillTierRoots(workspace, options)) {
    if (isSymlinkSafe(dir) || !fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || !ent.isDirectory()) continue;
      const pkg = readSkillPackageAtDir(path.join(dir, ent.name), tier);
      if (pkg) results.push(pkg);
    }
  }
  return results;
}

/**
 * Discover active skill packages using 3-tier priority:
 *   workspace (.papercup/skills/) > global (~/.papercup/skills/) > repo (<PaperCup>/skills/)
 */
export function discoverSkillPackages(
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): SkillPackageRecord[] {
  const all = discoverAllTierSkillPackages(workspace, options);
  const winners: SkillPackageRecord[] = [];
  const seenSkills = new Set<string>();
  const seenEngines = new Set<string>();

  for (const pkg of all) {
    const skillKey = pkg.skillName.toLowerCase();
    const engineKey = pkg.engine.toLowerCase();
    if (seenSkills.has(skillKey) || seenEngines.has(engineKey)) continue;
    seenSkills.add(skillKey);
    seenEngines.add(engineKey);
    winners.push(pkg);
  }
  return winners;
}

export function findSkillPackageByEngine(
  engine: string,
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): SkillPackageRecord | null {
  const norm = engine.trim().toLowerCase();
  if (!norm || !isSafeSkillName(norm)) return null;
  const pkgs = discoverSkillPackages(workspace, options);
  return pkgs.find((p) => p.engine.toLowerCase() === norm || p.skillName.toLowerCase() === `engine-${norm}`) ?? null;
}

export function findSkillPackageByName(
  skillName: string,
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): SkillPackageRecord | null {
  const norm = skillName.trim().toLowerCase();
  if (!norm || !isSafeSkillName(norm)) return null;
  const pkgs = discoverSkillPackages(workspace, options);
  return pkgs.find((p) => p.skillName.toLowerCase() === norm) ?? null;
}

function readDigestField(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  if (typeof val !== 'string') return '';
  return val.trim().toLowerCase();
}

/**
 * Verify SHA-256 integrity of SKILL.md and all `.py` runtime scripts against `engine.json`.
 * Mandatory before executing any script from `global` or `repo` tiers (and recommended for workspace).
 */
export function verifySkillPackageIntegrity(
  pkg: SkillPackageRecord,
  options: {
    engineJsonOverride?: Record<string, unknown> | null;
    requireAllPresentScriptsHashed?: boolean;
  } = {}
): SkillIntegrityResult {
  const errors: string[] = [];
  const verifiedFiles: Record<string, string> = {};
  const requireAllPresent = options.requireAllPresentScriptsHashed ?? true;

  if (isSymlinkSafe(pkg.directory)) {
    return { ok: false, errors: [`技能目录是符号链接：${pkg.directory}`], verifiedFiles };
  }

  const engineJson = options.engineJsonOverride ?? pkg.engineJson;
  if (!engineJson || typeof engineJson !== 'object' || Array.isArray(engineJson)) {
    return { ok: false, errors: [`缺少或无法解析 engine.json：${pkg.directory}`], verifiedFiles };
  }

  // Validate SKILL.md SHA-256
  const expectedSkillSha = readDigestField(engineJson, SKILL_MD_DIGEST_FIELD);
  if (!SHA256_RE.test(expectedSkillSha)) {
    errors.push(`engine.json 缺少合法的 ${SKILL_MD_DIGEST_FIELD}`);
  } else {
    try {
      const actual = hashSkillFile(pkg.skillMdPath, MAX_SKILL_MD_BYTES);
      if (actual !== expectedSkillSha) {
        errors.push(`SKILL.md SHA-256 校验失败（期望 ${expectedSkillSha.slice(0, 12)}，实际 ${actual.slice(0, 12)}）`);
      } else {
        verifiedFiles['SKILL.md'] = actual;
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  const pipeline = String(engineJson.pipeline || '').trim().toLowerCase();
  const requiredScripts = new Set<SkillRuntimeScript>();
  if (pipeline === 'skill') {
    requiredScripts.add('unpack.py');
    requiredScripts.add('repack.py');
  } else if (pipeline === 'direct') {
    requiredScripts.add('extract.py');
    requiredScripts.add('apply.py');
  }

  // Check every runtime script: both declared hashes and present files on disk
  for (const script of SKILL_RUNTIME_SCRIPTS) {
    const digestField = SCRIPT_DIGEST_FIELDS[script];
    const expected = readDigestField(engineJson, digestField);
    const scriptPath = path.join(pkg.directory, script);
    const existsOnDisk = fs.existsSync(scriptPath);
    const isRequired = requiredScripts.has(script);

    if (isRequired && !SHA256_RE.test(expected)) {
      errors.push(`pipeline=${pipeline} 要求在 engine.json 中声明合法的 ${digestField}`);
      continue;
    }

    if (expected && !SHA256_RE.test(expected)) {
      errors.push(`engine.json 中 ${digestField} 格式不合法`);
      continue;
    }

    if (existsOnDisk && !expected && requireAllPresent) {
      errors.push(`发现未在 engine.json 中声明 ${digestField} 的可执行脚本：${script}`);
      continue;
    }

    if (expected && !existsOnDisk) {
      errors.push(`engine.json 声明了 ${digestField}，但缺少脚本文件：${script}`);
      continue;
    }

    if (expected && existsOnDisk) {
      try {
        const actual = hashSkillFile(scriptPath, MAX_SKILL_SCRIPT_BYTES);
        if (actual !== expected) {
          errors.push(`${script} SHA-256 校验失败（期望 ${expected.slice(0, 12)}，实际 ${actual.slice(0, 12)}）`);
        } else {
          verifiedFiles[script] = actual;
        }
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }

  // Reject any unexpected stray .py runtime files (anything other than known runtime scripts or test_fixture.py)
  try {
    for (const ent of fs.readdirSync(pkg.directory, { withFileTypes: true })) {
      if (!ent.name.toLowerCase().endsWith('.py')) continue;
      if (
        !(SKILL_RUNTIME_SCRIPTS as readonly string[]).includes(ent.name) &&
        !(SKILL_OPTIONAL_SCRIPTS as readonly string[]).includes(ent.name)
      ) {
        errors.push(`技能目录包含未登记的 Python 文件：${ent.name}`);
      }
    }
  } catch (err) {
    errors.push(`无法读取技能目录：${(err as Error).message}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    verifiedFiles,
  };
}

/**
 * Resolve an engine's active skill binding across the 3-tier registry with mandatory
 * SHA-256 verification for global and repo tiers (and co-located workspace engine.json).
 */
export function resolveSkillBindingFromRegistry(
  workspace: string | null,
  engine: string,
  options: SkillDiscoveryOptions & {
    kind?: string;
    projectHarnessEngineJson?: Record<string, unknown> | null;
  } = {}
): RegistrySkillBinding {
  const norm = engine.trim().toLowerCase();
  if (!norm || !isSafeSkillName(norm)) return { state: 'absent' };

  const pkg = findSkillPackageByEngine(norm, workspace, options);
  if (!pkg) return { state: 'absent' };

  const effectiveEngineJson =
    pkg.tier === 'workspace' ? (pkg.engineJson ?? options.projectHarnessEngineJson ?? null) : pkg.engineJson;
  if (!effectiveEngineJson) {
    return {
      state: 'mismatch',
      tier: pkg.tier,
      skillName: pkg.skillName,
      engine: pkg.engine,
      directory: pkg.directory,
      errors: ['缺少 engine.json 元数据'],
    };
  }

  const pipeline = String(effectiveEngineJson.pipeline || '').trim().toLowerCase();
  const isUnpackSkill = pipeline === 'skill';
  const isDirectSkill = pipeline === 'direct';
  const isBuiltinAnalysisSkill =
    pipeline === 'builtin' &&
    typeof effectiveEngineJson[SKILL_POINTER_FIELD] === 'string' &&
    Boolean(String(effectiveEngineJson[SKILL_POINTER_FIELD]).trim());

  if (!isUnpackSkill && !isDirectSkill && !isBuiltinAnalysisSkill) {
    return { state: 'absent' };
  }

  const kind = (options.kind || '').trim().toLowerCase();
  const kinds = Array.isArray(effectiveEngineJson.kinds) ? effectiveEngineJson.kinds.map((k) => String(k).toLowerCase()) : [];
  if (kind && kinds.length > 0 && !kinds.includes(kind)) {
    return { state: 'absent' };
  }

  const integrity = verifySkillPackageIntegrity(pkg, {
    engineJsonOverride: effectiveEngineJson,
    requireAllPresentScriptsHashed: true,
  });

  if (!integrity.ok) {
    return {
      state: 'mismatch',
      tier: pkg.tier,
      skillName: pkg.skillName,
      engine: pkg.engine,
      directory: pkg.directory,
      engineJson: effectiveEngineJson,
      errors: integrity.errors,
    };
  }

  const overrideBuiltin = pkg.tier === 'workspace' && effectiveEngineJson.override_builtin === true;

  return {
    state: 'ready',
    tier: pkg.tier,
    skillName: pkg.skillName,
    engine: pkg.engine,
    directory: pkg.directory,
    engineJson: effectiveEngineJson,
    ...(overrideBuiltin ? { overrideBuiltin: true } : {}),
    verifiedFiles: integrity.verifiedFiles,
  };
}

/**
 * List engine profiles from all 3 tiers (highest priority wins per engine).
 * Useful for `loadCustomMatchers`, `resolveEngineJson`, and `resolveWorkspaceControlPattern`.
 */
export function listRegistryEngineProfiles(
  workspace?: string | null,
  options: SkillDiscoveryOptions = {}
): Array<{ engine: string; tier: SkillTier; skillName: string; directory: string; engineJson: Record<string, unknown> }> {
  const pkgs = discoverSkillPackages(workspace, options);
  const out: Array<{ engine: string; tier: SkillTier; skillName: string; directory: string; engineJson: Record<string, unknown> }> = [];
  for (const pkg of pkgs) {
    if (!pkg.engineJson) continue;
    out.push({
      engine: pkg.engine,
      tier: pkg.tier,
      skillName: pkg.skillName,
      directory: pkg.directory,
      engineJson: { name: pkg.engine, ...pkg.engineJson },
    });
  }
  return out;
}

/* ========================= Dynamic Workspace Binding (vn_detect) ========================= */

function isInternalOrBackupRel(relPosix: string): boolean {
  const cleaned = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!cleaned || cleaned === '.') return false;
  const segs = cleaned.split('/').filter(Boolean);
  if (!segs.length) return false;
  const firstLow = segs[0].toLowerCase();
  if (
    INTERNAL_OR_BACKUP_TOP_DIRS.has(firstLow) ||
    (firstLow.startsWith('.') && firstLow !== '.') ||
    /^unpacked(?:$|[0-9._-])/i.test(firstLow)
  ) {
    return true;
  }
  for (let i = 0; i < segs.length; i++) {
    if (BACKUP_DIR_SEGMENTS.has(segs[i].toLowerCase())) return true;
  }
  return false;
}

function commonParentPosix(relPaths: readonly string[]): string {
  const dirs = relPaths
    .map((p) => {
      const norm = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      const dir = path.posix.dirname(norm);
      return dir === '.' ? '' : dir;
    })
    .filter((d) => !isInternalOrBackupRel(d));

  if (dirs.length === 0) return '.';
  const splitDirs = dirs.map((d) => (d ? d.split('/').filter(Boolean) : []));
  const common: string[] = [];
  const first = splitDirs[0];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (splitDirs.every((parts) => parts[i] === seg)) {
      common.push(seg);
    } else {
      break;
    }
  }
  return common.length > 0 ? common.join('/') : '.';
}

/**
 * Dynamically determine the runtime `direct_root` inside `workspace` for a `direct` skill
 * without ever mutating global or repo skill files.
 */
export function resolveDynamicDirectRoot(
  workspace: string,
  engineJson: Record<string, unknown>,
  matchedPaths: readonly string[] = []
): string | null {
  const ws = realpathSafe(workspace);
  if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) return null;

  const validMatched = matchedPaths
    .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''))
    .filter((p) => p && !p.startsWith('..') && !path.isAbsolute(p) && !isInternalOrBackupRel(p));

  if (validMatched.length > 0) {
    return commonParentPosix(validMatched);
  }

  // Fallback: probe system_text.files inside workspace root or immediate game subdirs
  const sysText = engineJson.system_text;
  const targetFiles =
    sysText && typeof sysText === 'object' && !Array.isArray(sysText) && Array.isArray((sysText as Record<string, unknown>).files)
      ? ((sysText as Record<string, unknown>).files as unknown[])
          .filter((f): f is string => typeof f === 'string' && Boolean(f.trim()))
          .map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      : [];

  if (targetFiles.length > 0) {
    for (const rel of targetFiles) {
      const candidate = path.join(ws, rel);
      if (!isSymlinkSafe(candidate) && fs.existsSync(candidate)) {
        return '.';
      }
    }
    try {
      for (const ent of fs.readdirSync(ws, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || isInternalOrBackupRel(ent.name)) continue;
        for (const rel of targetFiles) {
          const candidate = path.join(ws, ent.name, rel);
          if (!isSymlinkSafe(candidate) && fs.existsSync(candidate)) {
            return ent.name;
          }
        }
      }
    } catch {
      // ignore unreadable workspace
    }
  }

  return '.';
}

/**
 * Dynamically bind a discovered skill package to a concrete workspace at runtime (`vn_detect`).
 * Returns a fresh cloned `runtimeEngineJson` without mutating the skill package on disk.
 */
export function bindSkillToWorkspace(
  pkg: SkillPackageRecord,
  workspace: string,
  options: {
    matchedPaths?: readonly string[];
    engineJsonOverride?: Record<string, unknown> | null;
  } = {}
): DynamicWorkspaceBinding {
  const baseEngineJson = options.engineJsonOverride ?? pkg.engineJson;
  const integrity = verifySkillPackageIntegrity(pkg, {
    engineJsonOverride: baseEngineJson,
    requireAllPresentScriptsHashed: true,
  });

  if (!baseEngineJson) {
    throw new SkillRegistryError(`技能 ${pkg.skillName} 缺少 engine.json，无法绑定工作区`);
  }

  // Deep clone so runtime workspace fields never mutate cached or on-disk objects
  const runtimeEngineJson = JSON.parse(JSON.stringify(baseEngineJson)) as Record<string, unknown>;
  const pipeline = String(runtimeEngineJson.pipeline || '').trim().toLowerCase();
  const matchedPaths = (options.matchedPaths ?? [])
    .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean);

  let boundDirectRoot: string | null = null;
  if (pipeline === 'direct') {
    boundDirectRoot = resolveDynamicDirectRoot(workspace, runtimeEngineJson, matchedPaths);
    if (boundDirectRoot) {
      runtimeEngineJson.direct_root = boundDirectRoot;
    }
  }

  return {
    engine: pkg.engine,
    skillName: pkg.skillName,
    tier: pkg.tier,
    directory: pkg.directory,
    pipeline,
    boundDirectRoot,
    matchedPaths,
    runtimeEngineJson,
    integrity,
  };
}

/* ========================= Sanitization & PR-Ready Export ========================= */

function assertCleanExportContent(label: string, text: string): void {
  if (containsSecretMaterial(text)) {
    throw new SkillRegistryError(`${label} 包含疑似凭据或密钥，拒绝导出`);
  }
  const localPath = findForbiddenLocalPath(text);
  if (localPath) {
    throw new SkillRegistryError(`${label} 包含本机绝对路径（${localPath.label}: ${localPath.match}），请先泛化为相对路径后再导出`);
  }
}

export function sanitizeSkillMarkdownForExport(rawMd: string): {
  markdown: string;
  strippedFields: string[];
} {
  const normalized = rawMd.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_SKILL_MD_BYTES) {
    throw new SkillRegistryError('SKILL.md 超过 64 KiB 上限，拒绝导出');
  }
  if (/disable-model-invocation:\s*(?:true|yes|1)/i.test(normalized)) {
    throw new SkillRegistryError('草稿技能（disable-model-invocation: true）不能导出');
  }
  if (normalized.includes('PAPERCUP_DRAFT')) {
    throw new SkillRegistryError('技能包含 PAPERCUP_DRAFT 标记，不能导出');
  }

  const strippedFields: string[] = [];
  let output = normalized;

  if (normalized.startsWith('---\n')) {
    const endIdx = normalized.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const frontmatterLines = normalized.slice(4, endIdx).split('\n');
      const body = normalized.slice(endIdx + 5);
      const keptLines: string[] = [];
      for (const line of frontmatterLines) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = line.slice(0, colon).trim().toLowerCase();
          if (FORBIDDEN_EXPORT_FRONTMATTER_KEYS.has(key)) {
            strippedFields.push(`frontmatter.${key}`);
            continue;
          }
        }
        keptLines.push(line);
      }
      output = `---\n${keptLines.join('\n')}\n---\n${body}`;
    }
  }

  output = output.trimEnd() + '\n';
  assertCleanExportContent('SKILL.md', output);

  return { markdown: output, strippedFields };
}

export function sanitizeEngineJsonForExport(
  raw: Record<string, unknown>,
  digests: {
    skillSha256: string;
    scriptDigests: Partial<Record<SkillRuntimeScript, string>>;
  }
): {
  engineJson: Record<string, unknown>;
  strippedFields: string[];
  warnings: string[];
} {
  const cloned = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const strippedFields: string[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(cloned)) {
    if (FORBIDDEN_EXPORT_ENGINE_KEYS.has(key.toLowerCase())) {
      delete cloned[key];
      strippedFields.push(`engine.json.${key}`);
    }
  }

  const engineName = typeof cloned.name === 'string' ? cloned.name.trim().toLowerCase() : '';
  if (!engineName || !isSafeSkillName(engineName)) {
    throw new SkillRegistryError(`engine.json 缺少合法的 name 字段：${String(cloned.name ?? '')}`);
  }
  cloned.name = engineName;
  cloned.schema_version = SKILL_SCHEMA_VERSION;

  const skillName =
    typeof cloned[SKILL_POINTER_FIELD] === 'string' && isSafeSkillName(String(cloned[SKILL_POINTER_FIELD]))
      ? String(cloned[SKILL_POINTER_FIELD]).trim().toLowerCase()
      : `engine-${engineName}`;
  cloned[SKILL_POINTER_FIELD] = skillName;
  cloned[SKILL_MD_DIGEST_FIELD] = digests.skillSha256;

  // Reset and populate exact script SHA-256 digests
  for (const script of SKILL_RUNTIME_SCRIPTS) {
    const field = SCRIPT_DIGEST_FIELDS[script];
    const hash = digests.scriptDigests[script];
    if (hash) {
      cloned[field] = hash;
    } else {
      delete cloned[field];
    }
  }

  // Normalize system_text relative paths and reject absolute paths
  if (cloned.system_text && typeof cloned.system_text === 'object' && !Array.isArray(cloned.system_text)) {
    const sys = cloned.system_text as Record<string, unknown>;
    for (const listKey of ['files', 'raster_ui']) {
      if (Array.isArray(sys[listKey])) {
        const cleanedList: string[] = [];
        for (const item of sys[listKey] as unknown[]) {
          if (typeof item !== 'string') continue;
          const norm = item.trim().replace(/\\/g, '/').replace(/^\.\//, '');
          if (!norm) continue;
          if (path.isAbsolute(norm) || /^[A-Za-z]:/.test(norm) || norm.startsWith('..')) {
            warnings.push(`已剥离 system_text.${listKey} 中的非法路径：${item}`);
            strippedFields.push(`engine.json.system_text.${listKey}`);
            continue;
          }
          if (!cleanedList.includes(norm)) cleanedList.push(norm);
        }
        if (cleanedList.length > 0) sys[listKey] = cleanedList;
        else delete sys[listKey];
      }
    }
  }

  const serialized = JSON.stringify(cloned, null, 2) + '\n';
  assertCleanExportContent('engine.json', serialized);

  return { engineJson: cloned, strippedFields, warnings };
}

/**
 * Export a verified skill directory as a clean, self-contained, PR-ready package:
 *   <targetDir>/{engine.json, SKILL.md, unpack.py?, repack.py?, extract.py?, apply.py?, test_fixture.py?}
 * Strips `direct_root`, `source-sample`, `source-sha256`, rejects secrets/local paths,
 * normalizes line endings to LF, and embeds exact SHA-256 digests into `engine.json`.
 */
export function exportSanitizedSkillPackage(
  options: ExportSanitizedSkillOptions
): ExportSanitizedSkillResult {
  const sourceDir = path.resolve(options.sourceSkillDir);
  if (isSymlinkSafe(sourceDir) || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new SkillRegistryError(`源技能目录不存在或是符号链接：${sourceDir}`);
  }

  const sourceMdPath = path.join(sourceDir, 'SKILL.md');
  if (isSymlinkSafe(sourceMdPath) || !fs.existsSync(sourceMdPath) || !fs.statSync(sourceMdPath).isFile()) {
    throw new SkillRegistryError(`源技能缺少 SKILL.md：${sourceMdPath}`);
  }

  const rawMd = fs.readFileSync(sourceMdPath, 'utf8');
  const { markdown: cleanMd, strippedFields: mdStripped } = sanitizeSkillMarkdownForExport(rawMd);
  const skillSha256 = hashSkillTextContent(cleanMd);

  const sourceEngineJson =
    options.engineJson ?? readSkillEngineJsonFile(path.join(sourceDir, 'engine.json'));
  if (!sourceEngineJson) {
    throw new SkillRegistryError(`缺少 engine.json 元数据，无法导出自包含技能包：${sourceDir}`);
  }

  const scriptTexts: Partial<Record<SkillRuntimeScript | SkillOptionalScript, string>> = {};
  const scriptDigests: Partial<Record<SkillRuntimeScript, string>> = {};

  for (const script of SKILL_RUNTIME_SCRIPTS) {
    const src = path.join(sourceDir, script);
    if (!fs.existsSync(src)) continue;
    if (isSymlinkSafe(src) || !fs.statSync(src).isFile()) {
      throw new SkillRegistryError(`脚本是符号链接或非普通文件：${script}`);
    }
    const st = fs.statSync(src);
    if (st.size <= 0 || st.size > MAX_SKILL_SCRIPT_BYTES) {
      throw new SkillRegistryError(`脚本大小不合法：${script}`);
    }
    const raw = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (raw.includes('PAPERCUP_DRAFT')) {
      throw new SkillRegistryError(`脚本 ${script} 包含 PAPERCUP_DRAFT 标记，不能导出`);
    }
    assertCleanExportContent(script, raw);
    const normalized = raw.endsWith('\n') ? raw : raw + '\n';
    scriptTexts[script] = normalized;
    scriptDigests[script] = hashSkillTextContent(normalized);
  }

  if (options.includeTestFixture !== false) {
    const fixturePath = path.join(sourceDir, 'test_fixture.py');
    if (fs.existsSync(fixturePath)) {
      if (isSymlinkSafe(fixturePath) || !fs.statSync(fixturePath).isFile()) {
        throw new SkillRegistryError('test_fixture.py 是符号链接或非普通文件');
      }
      const raw = fs.readFileSync(fixturePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      assertCleanExportContent('test_fixture.py', raw);
      scriptTexts['test_fixture.py'] = raw.endsWith('\n') ? raw : raw + '\n';
    }
  }

  const { engineJson: cleanEngineJson, strippedFields: jsonStripped, warnings } = sanitizeEngineJsonForExport(
    sourceEngineJson,
    { skillSha256, scriptDigests }
  );

  const pipeline = String(cleanEngineJson.pipeline || '').trim().toLowerCase();
  if (pipeline === 'skill' && (!scriptTexts['unpack.py'] || !scriptTexts['repack.py'])) {
    throw new SkillRegistryError('pipeline=skill 导出包必须同时包含 unpack.py 与 repack.py');
  }
  if (pipeline === 'direct' && (!scriptTexts['extract.py'] || !scriptTexts['apply.py'])) {
    throw new SkillRegistryError('pipeline=direct 导出包必须同时包含 extract.py 与 apply.py');
  }

  const engine = String(cleanEngineJson.name);
  const skillName = String(cleanEngineJson[SKILL_POINTER_FIELD] || `engine-${engine}`);
  const targetDir = path.resolve(options.targetDir);
  const files = ['engine.json', 'SKILL.md', ...Object.keys(scriptTexts).sort()];
  const strippedFields = [...mdStripped, ...jsonStripped];

  if (options.dryRun) {
    return {
      status: 'dry-run',
      skillName,
      engine,
      targetDir,
      files,
      engineJson: cleanEngineJson,
      strippedFields,
      warnings,
    };
  }

  if (isSymlinkSafe(targetDir)) {
    throw new SkillRegistryError(`目标目录不能是符号链接：${targetDir}`);
  }
  if (fs.existsSync(targetDir) && !options.overwrite) {
    const existing = fs.readdirSync(targetDir);
    if (existing.length > 0) {
      throw new SkillRegistryError(`目标目录已存在且非空：${targetDir}（设置 overwrite=true 才会覆盖）`);
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const engineJsonText = JSON.stringify(cleanEngineJson, null, 2) + '\n';
  fs.writeFileSync(path.join(targetDir, 'engine.json'), engineJsonText, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), cleanMd, 'utf8');

  // Write present scripts and remove stale optional scripts on overwrite
  for (const script of [...SKILL_RUNTIME_SCRIPTS, ...SKILL_OPTIONAL_SCRIPTS]) {
    const dest = path.join(targetDir, script);
    const content = scriptTexts[script];
    if (content !== undefined) {
      fs.writeFileSync(dest, content, 'utf8');
    } else if (options.overwrite && fs.existsSync(dest) && !isSymlinkSafe(dest)) {
      fs.rmSync(dest, { force: true });
    }
  }

  return {
    status: 'exported',
    skillName,
    engine,
    targetDir,
    files,
    engineJson: cleanEngineJson,
    strippedFields,
    warnings,
  };
}
