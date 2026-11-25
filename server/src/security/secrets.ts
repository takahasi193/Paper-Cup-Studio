import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAFE_ENV_TEMPLATE_NAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.schema',
]);

const SECRET_FILE_BASENAMES = new Set([
  'config.toml',
  'auth.json',
  'credentials.json',
  'translator.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
]);

const SECRET_EXT_PATTERN = /\.(pem|key|p12|pfx)$/i;
const SSH_KEY_BASENAME_PATTERN = /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i;

function getHomeRoots(): string[] {
  const roots = new Set<string>();
  for (const candidate of [process.env.USERPROFILE, process.env.HOME, os.homedir()]) {
    if (candidate && candidate.trim()) {
      const resolved = path.resolve(candidate.trim());
      roots.add(resolved);
      roots.add(realpathOrResolve(resolved));
    }
  }
  return Array.from(roots);
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideDir(target: string, dir: string): boolean {
  const normTarget = normalizeForCompare(target);
  const normDir = normalizeForCompare(dir);
  const sep = process.platform === 'win32' ? '\\' : path.sep;
  return normTarget === normDir || normTarget.startsWith(`${normDir}${sep}`);
}

export function expandHomeVariables(rawPath: string): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  let expanded = rawPath.trim();
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(home, expanded.slice(1));
  }
  expanded = expanded
    .replace(/\$\{HOME\}|\$HOME\b/gi, home)
    .replace(/\$\{USERPROFILE\}|\$USERPROFILE\b|%USERPROFILE%/gi, home);
  return expanded;
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function resolveRealPathWithAncestors(resolved: string): string {
  let existing = resolved;
  const tail: string[] = [];
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  try {
    const st = fs.lstatSync(existing);
    if (st.isSymbolicLink() && !fs.existsSync(existing)) {
      const linkTarget = fs.readlinkSync(existing);
      const absTarget = path.isAbsolute(linkTarget)
        ? path.resolve(linkTarget)
        : path.resolve(path.dirname(existing), linkTarget);
      return path.join(absTarget, ...tail);
    }
  } catch {
    // fall through to realpathOrResolve
  }
  return path.join(realpathOrResolve(existing), ...tail);
}

export function normalizeShellPath(raw: string, baseDir: string): string {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  let expanded = expandHomeVariables(trimmed);
  if (process.platform === 'win32') {
    const msys = expanded.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
    if (msys) {
      expanded = `${msys[1].toUpperCase()}:/${msys[2] ?? ''}`;
    }
  }
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

function isResolvedRestrictedSecretPath(resolved: string): boolean {
  const normResolved = normalizeForCompare(resolved);
  const base = path.basename(normResolved).toLowerCase();

  if (base.startsWith('.env') && !SAFE_ENV_TEMPLATE_NAMES.has(base)) {
    return true;
  }
  if (SECRET_EXT_PATTERN.test(base) || SSH_KEY_BASENAME_PATTERN.test(base)) {
    return true;
  }

  for (const homeRoot of getHomeRoots()) {
    const papercupDir = path.join(homeRoot, '.papercup');
    const piDir = path.join(homeRoot, '.pi');
    const sshDir = path.join(homeRoot, '.ssh');
    const awsDir = path.join(homeRoot, '.aws');
    const gnupgDir = path.join(homeRoot, '.gnupg');

    if (
      isInsideDir(resolved, piDir) ||
      isInsideDir(resolved, sshDir) ||
      isInsideDir(resolved, awsDir) ||
      isInsideDir(resolved, gnupgDir)
    ) {
      return true;
    }

    if (isInsideDir(resolved, papercupDir)) {
      if (
        SECRET_FILE_BASENAMES.has(base) ||
        base.startsWith('credentials') ||
        base.startsWith('auth.json') ||
        base.startsWith('translator.json')
      ) {
        return true;
      }
    }

    if (
      normResolved === normalizeForCompare(path.join(homeRoot, '.netrc')) ||
      normResolved === normalizeForCompare(path.join(homeRoot, '.npmrc')) ||
      normResolved === normalizeForCompare(path.join(homeRoot, '.pypirc'))
    ) {
      return true;
    }
  }

  return false;
}

export function isRestrictedSecretPath(rawPath: string, cwd: string): boolean {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed) return false;

  const resolved = normalizeShellPath(trimmed, cwd);
  if (isResolvedRestrictedSecretPath(resolved)) {
    return true;
  }

  const realResolved = resolveRealPathWithAncestors(resolved);
  if (realResolved !== resolved && isResolvedRestrictedSecretPath(realResolved)) {
    return true;
  }

  return false;
}

/**
 * Resolve a write/edit target and check it stays inside the active workspace.
 * Also rejects Windows path segments ending with '.' or ' ' (e.g. "foo.."), which create
 * directories that Explorer cannot delete normally.
 */
export function isPathInsideWorkspace(rawPath: string, cwd: string): boolean {
  if (!rawPath || typeof rawPath !== 'string' || !cwd) return false;
  const trimmed = rawPath.trim();
  if (!trimmed) return false;
  const expanded = expandHomeVariables(trimmed);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);

  if (process.platform === 'win32') {
    const rawSegments = expanded.split(/[\\/]+/).filter(Boolean);
    for (const seg of rawSegments) {
      if (seg === '.' || seg === '..' || /^[A-Za-z]:$/.test(seg)) continue;
      if (/[. ]$/.test(seg)) return false;
    }
  }

  // Resolve symlinks (including dangling symlinks) on the nearest existing ancestor.
  const realTarget = resolveRealPathWithAncestors(resolved);
  const realCwd = realpathOrResolve(cwd);
  return isInsideDir(realTarget, realCwd);
}

const MAX_SHELL_RECURSION_DEPTH = 4;

const SEARCH_TOOL_NAMES = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'ls',
  'dir',
  'get-childitem',
  'gci',
  'tree',
  'fd',
  'ag',
  'ack',
]);
const HOST_PACKAGE_DIR_PATTERN =
  /(?:site-packages|dist-packages|AppData[\\/]+Roaming[\\/]+npm[\\/]+node_modules|\/usr\/(?:local\/)?lib\/node_modules)/i;

const SHELL_CONTROL_PREFIXES = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  'time',
  'command',
  'exec',
  'builtin',
  'nohup',
  'sudo',
  '!',
]);
const VAR_DECL_CMDS = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
const SAFE_REDIRECT_TARGETS = new Set(['/dev/null', 'nul', 'null', '&1', '&2', '1', '2', '-']);
const MUTATING_ALL_TARGET_CMDS = new Set([
  'mkdir',
  'rm',
  'rmdir',
  'touch',
  'tee',
  'chmod',
  'chown',
  'new-item',
  'remove-item',
  'set-content',
  'add-content',
  'out-file',
]);
const MUTATING_DEST_CMDS = new Set([
  'cp',
  'mv',
  'ln',
  'install',
  'xcopy',
  'robocopy',
  'copy-item',
  'move-item',
  'copy',
  'move',
]);
const PROCESS_KILL_CMDS = new Set(['kill', 'taskkill', 'tskill', 'stop-process', 'pkill', 'killall']);
const PROCESS_LAUNCH_CMDS = new Set(['start', 'start-process', 'invoke-item', 'explorer']);
const SAFE_CLI_BASENAMES = new Set([
  'python.exe',
  'python3.exe',
  'py.exe',
  'git.exe',
  'node.exe',
  'npm.cmd',
  'npx.cmd',
  'rg.exe',
  'grep.exe',
  'find.exe',
  'sort.exe',
  'diff.exe',
  'objdump.exe',
  'strings.exe',
  'file.exe',
  'certutil.exe',
  'powershell.exe',
  'pwsh.exe',
  'bash.exe',
  'sh.exe',
  'where.exe',
  'which.exe',
  'tar.exe',
  'unzip.exe',
  '7z.exe',
  'sha256sum.exe',
  'xxd.exe',
  'cmd.exe',
]);

interface ShellSegment {
  text: string;
  pipedFromPrev: boolean;
}

function cmdBasename(raw: string): string {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return (idx >= 0 ? cleaned.slice(idx + 1) : cleaned).toLowerCase();
}

function findMatchingParen(src: string, openIdx: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  const n = src.length;
  for (let i = openIdx; i < n; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < n) {
        i++;
      } else if (quote === '"' && ch === '$' && i + 1 < n && src[i + 1] === '(') {
        const innerEnd = findMatchingParen(src, i + 1);
        if (innerEnd > i + 1) {
          i = innerEnd;
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitShellSegments(command: string): ShellSegment[] {
  const out: ShellSegment[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let inBacktick = false;
  let parenDepth = 0;
  let nextPiped = false;
  const n = command.length;

  const flush = (pipedNext: boolean) => {
    if (cur.trim()) {
      out.push({ text: cur.trim(), pipedFromPrev: nextPiped });
    }
    cur = '';
    nextPiped = pipedNext;
  };

  for (let i = 0; i < n; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < n) {
        cur += command[++i];
      } else if (quote === '"' && ch === '$' && i + 1 < n && command[i + 1] === '(') {
        const end = findMatchingParen(command, i + 1);
        if (end > i + 1) {
          cur += command.slice(i + 1, end + 1);
          i = end;
        }
      }
      continue;
    }
    if (inBacktick) {
      cur += ch;
      if (ch === '\\' && i + 1 < n) {
        cur += command[++i];
      } else if (ch === '`') {
        inBacktick = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      cur += ch;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      cur += ch;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      cur += ch;
      continue;
    }
    if (ch === '\r') continue;

    if (parenDepth === 0) {
      if (ch === '\n' || ch === ';') {
        flush(false);
        continue;
      }
      if (ch === '|') {
        if (i + 1 < n && command[i + 1] === '|') {
          i++;
          flush(false);
        } else if (i + 1 < n && command[i + 1] === '&') {
          i++;
          flush(true);
        } else {
          flush(true);
        }
        continue;
      }
      if (ch === '&') {
        if (i + 1 < n && command[i + 1] === '&') {
          i++;
          flush(false);
          continue;
        }
        const prev = i > 0 ? command[i - 1] : '';
        const next = i + 1 < n ? command[i + 1] : '';
        if (next === '>' || prev === '>' || prev === '<') {
          cur += ch;
          continue;
        }
        flush(false);
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) {
    out.push({ text: cur.trim(), pipedFromPrev: nextPiped });
  }
  return out;
}

/**
 * Extract commands embedded inside subshells `(...)`, command substitutions `$(...)` / `` `...` ``,
 * and process substitutions `<(...)` / `>(...)` (respecting single-quote literal boundaries).
 */
function extractEmbeddedShellCommands(src: string): string[] {
  const embedded: string[] = [];
  let quote: '"' | "'" | null = null;
  const n = src.length;

  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < n) {
        i++;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '$' && i + 1 < n && src[i + 1] === '(') {
        if (i + 2 < n && src[i + 2] === '(') {
          const end = findMatchingParen(src, i + 1);
          if (end > i + 1) i = end;
          continue;
        }
        const end = findMatchingParen(src, i + 1);
        if (end > i + 1) {
          const inner = src.slice(i + 2, end).trim();
          if (inner) embedded.push(inner);
          i = end;
        }
        continue;
      }
      if (ch === '`') {
        let j = i + 1;
        let inner = '';
        while (j < n && src[j] !== '`') {
          if (src[j] === '\\' && j + 1 < n && (src[j + 1] === '`' || src[j + 1] === '$' || src[j + 1] === '\\')) {
            inner += src[++j];
          } else {
            inner += src[j];
          }
          j++;
        }
        if (j < n && src[j] === '`') {
          if (inner.trim()) embedded.push(inner.trim());
          i = j;
        }
        continue;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      i++;
      continue;
    }
    if (ch === '$' && i + 1 < n && src[i + 1] === '(') {
      if (i + 2 < n && src[i + 2] === '(') {
        const end = findMatchingParen(src, i + 1);
        if (end > i + 1) i = end;
        continue;
      }
      const end = findMatchingParen(src, i + 1);
      if (end > i + 1) {
        const inner = src.slice(i + 2, end).trim();
        if (inner) embedded.push(inner);
        i = end;
      }
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let inner = '';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\' && j + 1 < n && (src[j + 1] === '`' || src[j + 1] === '$' || src[j + 1] === '\\')) {
          inner += src[++j];
        } else {
          inner += src[j];
        }
        j++;
      }
      if (j < n && src[j] === '`') {
        if (inner.trim()) embedded.push(inner.trim());
        i = j;
      }
      continue;
    }
    if ((ch === '<' || ch === '>') && i + 1 < n && src[i + 1] === '(') {
      const end = findMatchingParen(src, i + 1);
      if (end > i + 1) {
        const inner = src.slice(i + 2, end).trim();
        if (inner) embedded.push(inner);
        i = end;
      }
      continue;
    }
    if (ch === '(') {
      if (i + 1 < n && src[i + 1] === '(') {
        const end = findMatchingParen(src, i);
        if (end > i) i = end;
        continue;
      }
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + 1 < n ? src[i + 1] : '';
      if (next === ')' || prev === '=' || /[@!?*+]/.test(prev)) {
        continue;
      }
      const end = findMatchingParen(src, i);
      if (end > i) {
        const inner = src.slice(i + 1, end).trim();
        if (inner) embedded.push(inner);
        i = end;
      }
      continue;
    }
  }

  return embedded;
}

function tokenizeShellSegment(seg: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < seg.length && (seg[i + 1] === '"' || seg[i + 1] === '\\')) {
        cur += seg[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function expandTrackedShellVars(raw: string, vars: Map<string, string>): string {
  if (!vars.size || !raw.includes('$')) return raw;
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (full, br, bare) => {
    const key = br || bare;
    return vars.has(key) ? vars.get(key)! : full;
  });
}

function expandTrackedShellVarsMulti(
  raw: string,
  vars: Map<string, string>,
  loopVars: Map<string, string[]>,
  maxExpansions = 64
): string[] {
  let results = [expandTrackedShellVars(raw, vars)];
  if (!loopVars.size || !results.some((r) => r.includes('$'))) {
    return results;
  }
  for (const [key, vals] of loopVars.entries()) {
    if (!vals.length) continue;
    const re = new RegExp(`\\$\\{${key}\\}|\\$${key}\\b`, 'g');
    const next: string[] = [];
    for (const item of results) {
      if (!re.test(item)) {
        next.push(item);
        continue;
      }
      re.lastIndex = 0;
      for (const v of vals) {
        next.push(item.replace(re, v));
        if (next.length >= maxExpansions) break;
      }
      if (next.length >= maxExpansions) break;
    }
    results = next;
  }
  return results;
}

/**
 * Expand POSIX brace expressions like `results/scenario.{jsonl,bak}` or `{a,b}/file`
 * while skipping shell parameter expansions (`${VAR}`).
 */
function expandBraceTargets(raw: string, maxExpansions = 32): string[] {
  if (!raw.includes('{') || !raw.includes('}')) return [raw];
  let results = [raw];

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const next: string[] = [];
    for (const item of results) {
      let openIdx = -1;
      let closeIdx = -1;
      for (let i = 0; i < item.length; i++) {
        if (item[i] === '{' && (i === 0 || item[i - 1] !== '$')) {
          openIdx = i;
        } else if (item[i] === '}' && openIdx >= 0) {
          const inner = item.slice(openIdx + 1, i);
          if (inner.includes(',') || /^(?:[0-9]+\.\.[0-9]+|[A-Za-z]\.\.[A-Za-z])$/.test(inner)) {
            closeIdx = i;
            break;
          }
          openIdx = -1;
        }
      }
      if (openIdx < 0 || closeIdx < 0) {
        next.push(item);
        continue;
      }
      changed = true;
      const prefix = item.slice(0, openIdx);
      const inner = item.slice(openIdx + 1, closeIdx);
      const suffix = item.slice(closeIdx + 1);
      let alts: string[];
      if (inner.includes(',')) {
        alts = inner.split(',');
      } else {
        const range = inner.match(/^([0-9]+)\.\.([0-9]+)$/) || inner.match(/^([A-Za-z])\.\.([A-Za-z])$/);
        if (range) {
          alts = [];
          const a = range[1];
          const b = range[2];
          if (/^[0-9]+$/.test(a)) {
            const start = Number(a);
            const end = Number(b);
            const step = start <= end ? 1 : -1;
            if (Math.abs(end - start) <= maxExpansions) {
              for (let k = start; step > 0 ? k <= end : k >= end; k += step) {
                alts.push(String(k));
              }
            } else {
              alts.push('*');
            }
          } else {
            const start = a.charCodeAt(0);
            const end = b.charCodeAt(0);
            const step = start <= end ? 1 : -1;
            if (Math.abs(end - start) <= maxExpansions) {
              for (let k = start; step > 0 ? k <= end : k >= end; k += step) {
                alts.push(String.fromCharCode(k));
              }
            } else {
              alts.push('*');
            }
          }
        } else {
          alts = [inner];
        }
      }
      for (const alt of alts) {
        next.push(`${prefix}${alt}${suffix}`);
        if (next.length >= maxExpansions) break;
      }
      if (next.length >= maxExpansions) break;
    }
    results = next;
    if (!changed || results.length >= maxExpansions) break;
  }
  return results;
}

const ENV_VALUE_FLAGS = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '--block-signal',
  '--default-signal',
  '--ignore-signal',
]);

interface ParsedEnvCommand {
  assigns: Array<[string, string]>;
  subTokens: string[];
  splitStrings: string[];
}

function parseEnvInvocation(args: string[]): ParsedEnvCommand {
  const assigns: Array<[string, string]> = [];
  const splitStrings: string[] = [];
  let i = 0;
  let endFlags = false;
  while (i < args.length) {
    const a = args[i];
    if (!endFlags) {
      if (a === '--') {
        endFlags = true;
        i++;
        continue;
      }
      if (a === '-S' || a === '--split-string') {
        if (i + 1 < args.length) splitStrings.push(args[++i]);
        i++;
        continue;
      }
      if (a.startsWith('--split-string=')) {
        splitStrings.push(a.slice('--split-string='.length));
        i++;
        continue;
      }
      if (ENV_VALUE_FLAGS.has(a)) {
        i += 2;
        continue;
      }
      if (a.startsWith('-')) {
        i++;
        continue;
      }
    }
    const assign = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assign) {
      assigns.push([assign[1], assign[2]]);
      i++;
      continue;
    }
    break;
  }
  return { assigns, subTokens: args.slice(i), splitStrings };
}

interface UnwrappedSegmentCommand {
  cmdTok: string;
  base: string;
  cmdName: string;
  args: string[];
  isEnvDump: boolean;
  extraNestedCommands: string[];
}

function unwrapSegmentTokens(
  rawTokens: string[],
  vars?: Map<string, string>
): UnwrappedSegmentCommand | null {
  const tokens = rawTokens.slice();
  while (tokens.length > 0 && tokens[tokens.length - 1] === '}') {
    tokens.pop();
  }
  const extraNestedCommands: string[] = [];
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    const low = tok.toLowerCase();
    if (SHELL_CONTROL_PREFIXES.has(low) || tok === '{' || tok === '}' || tok === '(' || tok === ')') {
      idx++;
      if ((low === 'command' || low === 'time' || low === 'builtin') && idx < tokens.length && tokens[idx].startsWith('-')) {
        idx++;
      } else if (low === 'exec' && idx < tokens.length && tokens[idx] === '-a') {
        idx += 2;
      }
      continue;
    }
    const assign = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assign) {
      if (vars) {
        vars.set(assign[1], expandTrackedShellVars(assign[2], vars));
      }
      idx++;
      continue;
    }
    const base = cmdBasename(tok);
    const nameNoExe = base.replace(/\.exe$/, '');
    if (nameNoExe === 'env') {
      const parsedEnv = parseEnvInvocation(tokens.slice(idx + 1));
      for (const [k, v] of parsedEnv.assigns) {
        if (vars) vars.set(k, expandTrackedShellVars(v, vars));
      }
      extraNestedCommands.push(...parsedEnv.splitStrings);
      if (parsedEnv.subTokens.length === 0) {
        return {
          cmdTok: tok,
          base,
          cmdName: 'env',
          args: tokens.slice(idx + 1),
          isEnvDump: parsedEnv.splitStrings.length === 0,
          extraNestedCommands,
        };
      }
      tokens.splice(0, tokens.length, ...parsedEnv.subTokens);
      idx = 0;
      continue;
    }
    break;
  }

  if (idx >= tokens.length) {
    if (extraNestedCommands.length > 0) {
      return {
        cmdTok: '',
        base: '',
        cmdName: '',
        args: [],
        isEnvDump: false,
        extraNestedCommands,
      };
    }
    return null;
  }

  const cmdTok = tokens[idx];
  const base = cmdBasename(cmdTok);
  const cmdName = base.replace(/\.exe$/, '');
  return {
    cmdTok,
    base,
    cmdName,
    args: tokens.slice(idx + 1),
    isEnvDump: false,
    extraNestedCommands,
  };
}

function decodePowerShellEncodedCommand(encoded: string): string | null {
  const cleaned = encoded.trim();
  if (!cleaned || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) return null;
  try {
    const decoded = Buffer.from(cleaned, 'base64').toString('utf16le').replace(/\0/g, '').trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function extractNestedShellWrapperCommand(cmdName: string, args: string[]): string | null {
  if (cmdName === 'bash' || cmdName === 'sh' || cmdName === 'zsh' || cmdName === 'dash' || cmdName === 'ash' || cmdName === 'ksh') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') break;
      if (/^-[A-Za-z]*c$/.test(a) && i + 1 < args.length) {
        return args[i + 1];
      }
    }
    return null;
  }
  if (cmdName === 'powershell' || cmdName === 'pwsh') {
    for (let i = 0; i < args.length; i++) {
      const low = args[i].toLowerCase();
      if ((low === '-command' || low === '-c' || low === '--command') && i + 1 < args.length) {
        return args.slice(i + 1).join(' ');
      }
      if ((low === '-encodedcommand' || low === '-enc' || low === '-ec' || low === '-e') && i + 1 < args.length) {
        return decodePowerShellEncodedCommand(args[i + 1]);
      }
    }
    return null;
  }
  if (cmdName === 'cmd') {
    for (let i = 0; i < args.length; i++) {
      const low = args[i].toLowerCase();
      if ((low === '/c' || low === '//c' || low === '/k' || low === '//k') && i + 1 < args.length) {
        if (args.length === i + 2) {
          return args[i + 1];
        }
        return args
          .slice(i + 1)
          .map((t) => (/\s/.test(t) ? `"${t}"` : t))
          .join(' ');
      }
    }
    return null;
  }
  return null;
}

const PIP_VALUE_FLAGS = new Set([
  '-c',
  '--constraint',
  '--proxy',
  '--retries',
  '--timeout',
  '--default-timeout',
  '--exists-action',
  '--trusted-host',
  '--cert',
  '--client-cert',
  '--cache-dir',
  '--log',
  '--python',
  '--root-user-action',
  '--keyring-provider',
]);

function detectPipMutationSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const low = a.toLowerCase();
    if (a === '--') break;
    if (PIP_VALUE_FLAGS.has(low)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (low === 'install' || low === 'uninstall' || low === 'download') {
      return low;
    }
    return null;
  }
  return null;
}

const NPM_VALUE_FLAGS = new Set(['--prefix', '-C', '--cwd', '--registry', '--userconfig', '--cache', '--loglevel']);
const PKG_MGR_MUTATION_CMDS = new Set([
  'winget',
  'choco',
  'scoop',
  'apt',
  'apt-get',
  'brew',
  'pacman',
  'yum',
  'dnf',
]);

const REG_MUTATING_SUBCOMMANDS = new Set([
  'add',
  'delete',
  'import',
  'restore',
  'copy',
  'load',
  'unload',
  'flags',
]);

const PS_REGISTRY_WRITE_CMDS = new Set([
  'set-itemproperty',
  'new-itemproperty',
  'remove-itemproperty',
  'rename-itemproperty',
  'new-item',
  'remove-item',
  'clear-itemproperty',
  'set-item',
]);

const REGISTRY_PATH_TARGET_RE =
  /(?:^|[\s"'=(,;\\])(?:hkcu|hklm|hkcr|hku|hkcc):|(?:^|[\s"'=(,;])registry::|\b(?:hkey_local_machine|hkey_current_user|hkey_classes_root|hkey_users|hkey_current_config)\b/i;

const MAX_WORKSPACE_SCRIPT_SCAN_BYTES = 256 * 1024;
const PYTHON_VALUE_FLAGS = new Set(['-W', '-X', '-Q', '--check-hash-based-pycs']);
const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '-e',
  '--eval',
  '-p',
  '--print',
  '--max-old-space-size',
  '-C',
  '--conditions',
]);
const PS_VALUE_FLAGS = new Set([
  '-executionpolicy',
  '-ep',
  '-outputformat',
  '-of',
  '-inputformat',
  '-if',
  '-windowstyle',
  '-w',
  '-version',
  '-v',
  '-workingdirectory',
  '-wd',
  '-configurationname',
  '-settingsfile',
]);
const DIRECT_SCRIPT_EXT_RE = /\.(?:py|ps1|js|mjs|cjs|vbs|bat|cmd)$/i;

function isPythonCmdName(cmdName: string): boolean {
  return cmdName === 'python' || cmdName === 'python3' || cmdName === 'py' || /^python3\.\d+$/.test(cmdName);
}

export interface ShellCommandInspection {
  cmdTok: string;
  cmdName: string;
  args: string[];
  expandedArgs: string[];
  effectiveCwd: string;
  rawEffectiveCwd: string;
  inlineCode?: string;
  scriptPath?: string;
  scriptContent?: string;
}

function stripScriptLineComments(content: string, scriptPathOrLang?: string): string {
  const isVbs = Boolean(scriptPathOrLang && /\.(?:vbs)$/i.test(scriptPathOrLang));
  return content
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*(?:#|\/\/|::|REM(?:\s|$))/i.test(line)) return false;
      if (isVbs && /^\s*'/.test(line)) return false;
      return true;
    })
    .join('\n');
}

function hasPowerShellRegistryWriteInScript(cleanedContent: string): boolean {
  const cmdletRe =
    /\b(?:Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Rename-ItemProperty|New-Item|Remove-Item|Clear-ItemProperty|Set-Item)\b/i;
  if (!cmdletRe.test(cleanedContent) || !REGISTRY_PATH_TARGET_RE.test(cleanedContent)) {
    return false;
  }

  // Track simple `$var = 'HKCU:\...'` assignments across PowerShell statements, joining backtick continuations.
  const joined = cleanedContent.replace(/`\r?\n/g, ' ');
  const statements = joined.split(/[;\r\n]+/);
  const regVars = new Set<string>();

  for (const rawStmt of statements) {
    const stmt = rawStmt.trim();
    if (!stmt) continue;

    const assign = stmt.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (assign && REGISTRY_PATH_TARGET_RE.test(assign[2])) {
      regVars.add(assign[1].toLowerCase());
    }

    if (cmdletRe.test(stmt)) {
      if (REGISTRY_PATH_TARGET_RE.test(stmt)) {
        return true;
      }
      for (const varName of regVars) {
        const varRe = new RegExp(`\\$${varName}\\b`, 'i');
        if (varRe.test(stmt)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Scan inline script text or script file content for host Windows registry or system-font
 * mutation APIs (Python winreg/_winreg writes, Win32/ctypes Reg* / AddFontResource* /
 * WriteProfileString / WM_FONTCHANGE, .NET Microsoft.Win32.Registry writes, PowerShell
 * registry cmdlets, WSH RegWrite/RegDelete, or reg.exe mutating invocations).
 */
export function detectHostMutationInScriptContent(content: string): string | null {
  if (!content || typeof content !== 'string') return null;
  const cleaned = stripScriptLineComments(content);
  if (!cleaned.trim()) return null;

  const hasWinregRef = /\b_?winreg\b/.test(cleaned);
  const hasRegistryContext =
    hasWinregRef ||
    /\b(?:OpenKey(?:Ex)?|ConnectRegistry|RegOpenKey(?:Ex)?(?:A|W)?|HKEY_(?:LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG))\b/i.test(
      cleaned
    );

  if (
    hasWinregRef &&
    /\b(?:SetValue|SetValueEx|CreateKey|CreateKeyEx|DeleteKey|DeleteKeyEx|DeleteValue|SaveKey|LoadKey|ReplaceKey|RestoreKey)\b/.test(
      cleaned
    )
  ) {
    return 'Mutating the Windows registry via Python winreg/_winreg is prohibited.';
  }

  if (
    hasRegistryContext &&
    /\b(?:KEY_WRITE|KEY_SET_VALUE|KEY_ALL_ACCESS|KEY_CREATE_SUB_KEY)\b/.test(cleaned)
  ) {
    return 'Opening a Windows registry key with write permissions (KEY_WRITE/KEY_SET_VALUE/KEY_ALL_ACCESS) is prohibited.';
  }

  if (
    /\bReg(?:SetValue|SetValueEx|CreateKey|CreateKeyEx|DeleteKey|DeleteKeyEx|DeleteValue|DeleteTree|SaveKey|LoadKey|ReplaceKey|RestoreKey)(?:A|W|ExA|ExW)?\b/.test(
      cleaned
    )
  ) {
    return 'Mutating the Windows registry via Win32 Reg* APIs is prohibited.';
  }

  if (
    /\b(?:AddFontResource(?:Ex)?|RemoveFontResource(?:Ex)?|WriteProfileString)(?:A|W)?\b/.test(cleaned) ||
    /\bWM_FONTCHANGE\b/.test(cleaned)
  ) {
    return 'Mutating host system fonts or Win32 profile settings (AddFontResource/RemoveFontResource/WriteProfileString/WM_FONTCHANGE) is prohibited.';
  }

  if (
    (/\bMicrosoft\.Win32\.Registry\b/i.test(cleaned) ||
      /\bRegistry\.(?:CurrentUser|LocalMachine|ClassesRoot|Users|CurrentConfig)\b/i.test(cleaned)) &&
    (/(?:::|\.)\s*(?:SetValue|CreateSubKey|DeleteSubKey|DeleteSubKeyTree|DeleteValue)\b/i.test(cleaned) ||
      /\bOpenSubKey\s*\([^)]*,\s*(?:\$true|true)\s*\)/i.test(cleaned))
  ) {
    return 'Mutating the Windows registry via Microsoft.Win32.Registry is prohibited.';
  }

  if (hasPowerShellRegistryWriteInScript(cleaned)) {
    return 'Mutating the Windows registry via PowerShell registry cmdlets is prohibited.';
  }

  if (
    /\b(?:RegWrite|RegDelete)\b/i.test(cleaned) &&
    /\b(?:WScript|WshShell|HKCU|HKLM|HKCR|HKU|HKCC|HKEY_)\b/i.test(cleaned)
  ) {
    return 'Mutating the Windows registry via WScript.Shell RegWrite/RegDelete is prohibited.';
  }

  if (
    /\breg(?:\.exe)?\s+(?:add|delete|import|restore|copy|load|unload|flags)\b/i.test(cleaned) ||
    /['"]reg(?:\.exe)?['"]\s*,\s*['"](?:add|delete|import|restore|copy|load|unload|flags)['"]/i.test(cleaned) ||
    /\b(?:regedit|regini)(?:\.exe)?\b/i.test(cleaned)
  ) {
    return 'Mutating the Windows registry via reg/regedit/regini inside a script is prohibited.';
  }

  return null;
}

function readSafeWorkspaceScriptFile(
  rawCandidate: string,
  effectiveCwd: string,
  baseCwd: string,
  seenResolved: Set<string>
): { scriptPath: string; scriptContent: string } | null {
  const resolved = normalizeShellPath(rawCandidate, effectiveCwd);
  const key = normalizeForCompare(resolved);
  if (seenResolved.has(key)) return null;
  if (!isPathInsideWorkspace(resolved, baseCwd)) return null;
  if (isRestrictedSecretPath(resolved, baseCwd)) return null;

  // Reject symlink leaf or any symlink directory component inside the workspace.
  const normBase = normalizeForCompare(path.resolve(baseCwd));
  let cur = path.resolve(resolved);
  let isLeaf = true;
  for (let steps = 0; steps < 64; steps++) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return null;
    if (isLeaf) {
      if (!st.isFile() || st.size > MAX_WORKSPACE_SCRIPT_SCAN_BYTES) return null;
      isLeaf = false;
    }
    if (normalizeForCompare(cur) === normBase) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  seenResolved.add(key);
  try {
    return { scriptPath: resolved, scriptContent: fs.readFileSync(resolved, 'utf8') };
  } catch {
    return null;
  }
}

function extractScriptFileCandidate(cmdTok: string, cmdName: string, args: string[]): string | null {
  if (isPythonCmdName(cmdName)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        return i + 1 < args.length ? args[i + 1] : null;
      }
      if (a === '-c' || a.startsWith('-c') || a === '-m' || a.startsWith('-m') || a === '-') {
        return null;
      }
      if (PYTHON_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (a.startsWith('-')) continue;
      return a;
    }
    return null;
  }

  if (cmdName === 'node') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        return i + 1 < args.length ? args[i + 1] : null;
      }
      if (
        a === '-e' ||
        a === '--eval' ||
        a.startsWith('--eval=') ||
        a === '-p' ||
        a === '--print' ||
        a.startsWith('--print=')
      ) {
        return null;
      }
      if (NODE_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (a.startsWith('-')) continue;
      return a;
    }
    return null;
  }

  if (cmdName === 'powershell' || cmdName === 'pwsh') {
    for (let i = 0; i < args.length; i++) {
      const low = args[i].toLowerCase();
      if (
        low === '-command' ||
        low === '-c' ||
        low === '--command' ||
        low === '-encodedcommand' ||
        low === '-enc' ||
        low === '-ec' ||
        low === '-e'
      ) {
        return null;
      }
      if ((low === '-file' || low === '-f') && i + 1 < args.length) {
        return args[i + 1];
      }
      if (PS_VALUE_FLAGS.has(low)) {
        i++;
        continue;
      }
      if (!args[i].startsWith('-') && /\.ps1$/i.test(args[i])) {
        return args[i];
      }
    }
    return null;
  }

  if (cmdName === 'cscript' || cmdName === 'wscript') {
    for (const a of args) {
      if (a.startsWith('/') || a.startsWith('-')) continue;
      return a;
    }
    return null;
  }

  if ((cmdName === '.' || cmdName === 'source') && args.length > 0 && DIRECT_SCRIPT_EXT_RE.test(args[0])) {
    return args[0];
  }

  if (DIRECT_SCRIPT_EXT_RE.test(cmdName)) {
    return cmdTok;
  }

  return null;
}

function visitShellCommandRecursive(
  command: string,
  baseCwd: string,
  currentCwd: string,
  currentRawCwd: string,
  parentVars: Map<string, string>,
  parentLoopVars: Map<string, string[]>,
  seenScripts: Set<string>,
  depth: number,
  visitor: (info: ShellCommandInspection) => string | null
): string | null {
  if (depth > MAX_SHELL_RECURSION_DEPTH) return null;
  const vars = new Map(parentVars);
  const loopVars = new Map(parentLoopVars);
  let effectiveCwd = currentCwd;
  let rawEffectiveCwd = currentRawCwd;

  const segments = splitShellSegments(command);
  for (const { text: rawSeg } of segments) {
    const seg = rawSeg.trim();
    if (!seg || seg.startsWith('#')) continue;

    for (const inner of extractEmbeddedShellCommands(seg)) {
      const hit = visitShellCommandRecursive(
        inner,
        baseCwd,
        effectiveCwd,
        rawEffectiveCwd,
        vars,
        loopVars,
        seenScripts,
        depth + 1,
        visitor
      );
      if (hit) return hit;
    }

    const { stripped } = extractShellRedirectionTargets(seg);
    const parsed = unwrapSegmentTokens(tokenizeShellSegment(stripped), vars);
    if (!parsed) continue;

    for (const extra of parsed.extraNestedCommands) {
      const hit = visitShellCommandRecursive(
        extra,
        baseCwd,
        effectiveCwd,
        rawEffectiveCwd,
        vars,
        loopVars,
        seenScripts,
        depth + 1,
        visitor
      );
      if (hit) return hit;
    }

    const { cmdTok, cmdName, args } = parsed;
    if (VAR_DECL_CMDS.has(cmdName)) {
      for (const a of args) {
        const assign = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (assign) {
          vars.set(assign[1], expandTrackedShellVars(assign[2], vars));
        }
      }
      continue;
    }
    if (cmdName === 'for' && args.length >= 3 && args[1].toLowerCase() === 'in') {
      const varName = args[0];
      const vals = args
        .slice(2)
        .flatMap((v) => expandTrackedShellVarsMulti(v, vars, loopVars))
        .flatMap((v) => expandBraceTargets(v));
      if (vals.length) loopVars.set(varName, vals);
      continue;
    }
    if (cmdName === 'done') {
      loopVars.clear();
      continue;
    }

    const expandedArgs = args
      .flatMap((a) => expandTrackedShellVarsMulti(a, vars, loopVars))
      .flatMap((a) => expandBraceTargets(a));

    const nested = extractNestedShellWrapperCommand(cmdName, args);
    if (nested) {
      if (cmdName === 'powershell' || cmdName === 'pwsh') {
        const inlinePsHit = visitor({
          cmdTok,
          cmdName,
          args,
          expandedArgs,
          effectiveCwd,
          rawEffectiveCwd,
          inlineCode: nested,
        });
        if (inlinePsHit) return inlinePsHit;
      }
      const hit = visitShellCommandRecursive(
        nested,
        baseCwd,
        effectiveCwd,
        rawEffectiveCwd,
        vars,
        loopVars,
        seenScripts,
        depth + 1,
        visitor
      );
      if (hit) return hit;
    }

    if (cmdName === 'cd' || cmdName === 'pushd' || cmdName === 'set-location') {
      const targetArg = args.find((a) => !isShellFlag(a));
      if (targetArg) {
        const expanded = expandTrackedShellVars(targetArg, vars);
        rawEffectiveCwd = expanded;
        effectiveCwd = normalizeShellPath(expanded, effectiveCwd);
      }
      continue;
    }

    const inlineCode = extractInlineInterpreterCode(cmdName, args) ?? undefined;
    let scriptPath: string | undefined;
    let scriptContent: string | undefined;

    if (!inlineCode) {
      const scriptCandidate = extractScriptFileCandidate(cmdTok, cmdName, args);
      if (scriptCandidate) {
        const expandedCandidates = expandTrackedShellVarsMulti(scriptCandidate, vars, loopVars).flatMap((v) =>
          expandBraceTargets(v)
        );
        for (const cand of expandedCandidates) {
          const loaded = readSafeWorkspaceScriptFile(cand, effectiveCwd, baseCwd, seenScripts);
          if (loaded) {
            scriptPath = loaded.scriptPath;
            scriptContent = loaded.scriptContent;
            break;
          }
        }
      }
    }

    const hit = visitor({
      cmdTok,
      cmdName,
      args,
      expandedArgs,
      effectiveCwd,
      rawEffectiveCwd,
      ...(inlineCode !== undefined ? { inlineCode } : {}),
      ...(scriptPath !== undefined ? { scriptPath, scriptContent } : {}),
    });
    if (hit) return hit;
  }

  return null;
}

/**
 * Walk parsed shell command segments (including nested wrappers, subshells, inline scripts,
 * and safe non-symlink <=256 KB workspace script files) while tracking `cd`/`pushd`/`Set-Location`.
 */
export function visitShellCommandSegments(
  command: string,
  cwd: string | undefined,
  visitor: (info: ShellCommandInspection) => string | null
): string | null {
  if (!command || typeof command !== 'string') return null;
  const baseCwd = cwd ? path.resolve(cwd) : process.cwd();
  return visitShellCommandRecursive(
    command,
    baseCwd,
    baseCwd,
    baseCwd,
    new Map(),
    new Map(),
    new Set(),
    0,
    visitor
  );
}

/**
 * Block commands that install or modify host packages/toolchains (pip/npm/winget...)
 * or mutate Windows registry / system fonts via CLI, inline code, or workspace script files.
 */
export function detectBlockedHostMutationCommand(command: string, cwd?: string): string | null {
  if (!command || typeof command !== 'string') return null;

  return visitShellCommandSegments(command, cwd, ({ cmdName, args, expandedArgs, inlineCode, scriptContent }) => {
    if (inlineCode) {
      const scriptHit = detectHostMutationInScriptContent(inlineCode);
      if (scriptHit) return scriptHit;
    }
    if (scriptContent) {
      const fileHit = detectHostMutationInScriptContent(scriptContent);
      if (fileHit) return fileHit;
    }

    if (cmdName === 'reg') {
      const sub = args.find((a) => !isShellFlag(a))?.toLowerCase();
      if (sub && REG_MUTATING_SUBCOMMANDS.has(sub)) {
        return `Mutating the Windows registry via "reg ${sub}" is prohibited.`;
      }
      return null;
    }

    if (cmdName === 'regedit' || cmdName === 'regini') {
      return `Mutating the Windows registry via "${cmdName}" is prohibited.`;
    }

    if (PS_REGISTRY_WRITE_CMDS.has(cmdName)) {
      if (expandedArgs.some((a) => REGISTRY_PATH_TARGET_RE.test(a))) {
        return `Mutating the Windows registry via PowerShell "${cmdName}" is prohibited.`;
      }
      return null;
    }

    if (cmdName === 'pip' || cmdName === 'pip3') {
      const sub = detectPipMutationSubcommand(args);
      if (sub) {
        return `Installing or modifying host packages via "${cmdName} ${sub}" is prohibited. Use Python standard library only.`;
      }
      return null;
    }

    if (isPythonCmdName(cmdName)) {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-c' || a.startsWith('-c')) break;
        if (a === '-m' && i + 1 < args.length) {
          const mod = args[i + 1].toLowerCase();
          if (mod === 'pip' || mod === 'pip3') {
            const sub = detectPipMutationSubcommand(args.slice(i + 2));
            if (sub) {
              return `Installing or modifying host packages via "${cmdName} -m ${mod} ${sub}" is prohibited. Use Python standard library only.`;
            }
          }
          break;
        }
        if (a.startsWith('-m')) {
          const mod = a.slice(2).toLowerCase();
          if (mod === 'pip' || mod === 'pip3') {
            const sub = detectPipMutationSubcommand(args.slice(i + 1));
            if (sub) {
              return `Installing or modifying host packages via "${cmdName} -m ${mod} ${sub}" is prohibited. Use Python standard library only.`;
            }
          }
          break;
        }
        if (PYTHON_VALUE_FLAGS.has(a)) {
          i++;
          continue;
        }
        if (!a.startsWith('-')) break;
      }
      return null;
    }

    if (cmdName === 'pipx') {
      const sub = args.find((a) => !a.startsWith('-'))?.toLowerCase();
      if (sub === 'install' || sub === 'uninstall' || sub === 'upgrade' || sub === 'inject' || sub === 'reinstall') {
        return `Installing or modifying host packages via "pipx ${sub}" is prohibited. Use Python standard library only.`;
      }
      return null;
    }

    if (cmdName === 'uv') {
      const nonFlags = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
      const first = nonFlags[0];
      const second = nonFlags[1];
      if (
        (first === 'pip' && (second === 'install' || second === 'uninstall' || second === 'sync')) ||
        (first === 'tool' && (second === 'install' || second === 'upgrade')) ||
        first === 'add'
      ) {
        return `Installing or modifying host packages via "uv ${[first, second].filter(Boolean).join(' ')}" is prohibited. Use Python standard library only.`;
      }
      if (
        first === 'run' &&
        args.some((a) => {
          const low = a.toLowerCase();
          return (
            low === '--with' ||
            low.startsWith('--with=') ||
            low === '--with-requirements' ||
            low.startsWith('--with-requirements=') ||
            low === '--with-editable' ||
            low.startsWith('--with-editable=')
          );
        })
      ) {
        return 'Installing or modifying host packages via "uv run --with" is prohibited. Use Python standard library only.';
      }
      return null;
    }

    if (cmdName === 'conda' || cmdName === 'mamba' || cmdName === 'micromamba') {
      const sub = args.find((a) => !a.startsWith('-'))?.toLowerCase();
      if (sub === 'install' || sub === 'remove' || sub === 'uninstall' || sub === 'update' || sub === 'create') {
        return `Installing or modifying host packages via "${cmdName} ${sub}" is prohibited. Use Python standard library only.`;
      }
      return null;
    }

    if (cmdName === 'npm' || cmdName === 'pnpm' || cmdName === 'yarn' || cmdName === 'bun') {
      const positional: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (NPM_VALUE_FLAGS.has(a)) {
          i++;
          continue;
        }
        if (a.startsWith('-')) continue;
        positional.push(a.toLowerCase());
      }
      const sub = positional[0];
      const sub2 = positional[1];
      if (
        sub === 'install' ||
        sub === 'i' ||
        sub === 'ci' ||
        sub === 'add' ||
        sub === 'uninstall' ||
        sub === 'remove' ||
        (sub === 'global' && (sub2 === 'add' || sub2 === 'install'))
      ) {
        return `Installing or modifying host packages via "${cmdName} ${sub}" is prohibited. Use Python standard library only.`;
      }
      return null;
    }

    if (PKG_MGR_MUTATION_CMDS.has(cmdName)) {
      if (cmdName === 'pacman' && args.some((a) => /^-[A-Za-z]*S/.test(a))) {
        return 'Installing or modifying host packages via "pacman -S" is prohibited. Use Python standard library only.';
      }
      const sub = args.find((a) => !a.startsWith('-'))?.toLowerCase();
      if (sub === 'install' || sub === 'upgrade' || sub === 'uninstall' || sub === 'remove') {
        return `Installing or modifying host packages via "${cmdName} ${sub}" is prohibited. Use Python standard library only.`;
      }
    }

    return null;
  });
}

function isPowerShellContext(scriptPathOrLang?: string): boolean {
  return Boolean(
    scriptPathOrLang &&
      (/\.(?:ps1)$/i.test(scriptPathOrLang) || scriptPathOrLang === 'powershell' || scriptPathOrLang === 'pwsh')
  );
}

function hasHomeDirReference(expr: string, isPowerShell: boolean): boolean {
  if (INLINE_HOME_DIR_EXPR_RE.test(expr)) return true;
  if (isPowerShell && /(?:^|[^A-Za-z0-9_])\$HOME\b/i.test(expr)) return true;
  return false;
}

function maskStringLiterals(code: string): string {
  let masked = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipQuotedLiteral(code, i);
      masked += ' '.repeat(end - i);
      i = end - 1;
    } else {
      masked += ch;
    }
  }
  return masked;
}

function collectScriptVariableAssignments(code: string): Map<string, string[]> {
  const assignments = new Map<string, string[]>();
  const addBinding = (name: string, rhs: string) => {
    const trimmed = rhs.trim();
    if (!name || !trimmed) return;
    const list = assignments.get(name) ?? [];
    if (!list.includes(trimmed)) {
      list.push(trimmed);
      assignments.set(name, list);
    }
  };

  for (const stmt of splitTopLevelStatements(code)) {
    const m = /^(?:(?:const|let|var)\s+)?(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=([^=>][\s\S]*)$/.exec(stmt);
    if (!m) continue;
    const rawName = m[1];
    const rhs = m[2].trim();
    addBinding(rawName, rhs);
    if (rawName.startsWith('$')) {
      addBinding(rawName.slice(1), rhs);
    }
  }

  // Bind simple function parameters from call sites: `def fn(a, b):` + `fn(x, y)`
  const fnParams = new Map<string, string[]>();
  const masked = maskStringLiterals(code);
  const fnDefRe = /\b(?:def|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let fm: RegExpExecArray | null;
  while ((fm = fnDefRe.exec(masked)) !== null) {
    const fnName = fm[1];
    const openIdx = fm.index + fm[0].length - 1;
    const closeIdx = findMatchingParenEnd(code, openIdx);
    if (closeIdx < 0) continue;
    const params = splitTopLevelCommaArgs(code.slice(openIdx + 1, closeIdx))
      .map((p) => p.replace(/^\$/, '').split(/[:=]/)[0].trim())
      .filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p));
    if (params.length > 0) {
      fnParams.set(fnName, params);
    }
  }
  if (fnParams.size > 0) {
    const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(masked)) !== null) {
      const fnName = cm[1];
      const params = fnParams.get(fnName);
      if (!params) continue;
      // Skip the `def fn(...)` / `function fn(...)` header itself
      const before = masked.slice(Math.max(0, cm.index - 12), cm.index);
      if (/\b(?:def|function)\s+$/.test(before)) continue;
      const openIdx = cm.index + cm[0].length - 1;
      const closeIdx = findMatchingParenEnd(code, openIdx);
      if (closeIdx < 0) continue;
      const callArgs = splitTopLevelCommaArgs(code.slice(openIdx + 1, closeIdx));
      for (let idx = 0; idx < Math.min(params.length, callArgs.length); idx++) {
        const arg = callArgs[idx].trim();
        if (!arg) continue;
        const kw = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=([^=][\s\S]*)$/);
        if (kw && params.includes(kw[1])) {
          addBinding(kw[1], kw[2]);
        } else if (!kw) {
          addBinding(params[idx], arg);
        }
      }
    }
  }

  return assignments;
}

function extractInterpolatedIdentifiers(expr: string): string[] {
  const idents: string[] = [];
  const pyInterp = /\b[fF](?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
  let m: RegExpExecArray | null;
  while ((m = pyInterp.exec(expr)) !== null) {
    const body = m[0].slice(2, -1);
    const braceRe = /\{([^{}]+)\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = braceRe.exec(body)) !== null) {
      for (const id of bm[1].match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
        idents.push(id);
      }
    }
  }
  const jsInterp = /`(?:\\.|[^`\\])*`/g;
  while ((m = jsInterp.exec(expr)) !== null) {
    const braceRe = /\$\{([^}]+)\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = braceRe.exec(m[0])) !== null) {
      for (const id of bm[1].match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
        idents.push(id);
      }
    }
  }
  const psVars = expr.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g) ?? [];
  for (const pv of psVars) {
    const clean = pv.replace(/^\$\{?|\}$/g, '');
    if (clean && clean.toLowerCase() !== 'env') {
      idents.push(clean);
    }
  }
  return idents;
}

function findMatchingParenBackward(code: string, closeIdx: number, openChar: '(' | '['): number {
  const closeChar = openChar === '(' ? ')' : ']';
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const ch = code[i];
    if (ch === closeChar) depth++;
    else if (ch === openChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractReceiverExprBeforeDot(code: string, masked: string, dotIdx: number): string {
  let i = dotIdx - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0) return '';
  const end = i + 1;
  while (i >= 0) {
    const ch = code[i];
    if (ch === ')') {
      const open = findMatchingParenBackward(masked, i, '(');
      if (open < 0) break;
      i = open - 1;
      while (i >= 0 && /\s/.test(code[i])) i--;
      while (i >= 0 && /[A-Za-z0-9_$]/.test(code[i])) i--;
      while (i >= 0 && /\s/.test(code[i])) i--;
      if (i >= 0 && code[i] === '.') {
        i--;
        while (i >= 0 && /\s/.test(code[i])) i--;
        continue;
      }
      break;
    }
    if (ch === ']') {
      const open = findMatchingParenBackward(masked, i, '[');
      if (open < 0) break;
      i = open - 1;
      while (i >= 0 && /\s/.test(code[i])) i--;
      if (i >= 0 && code[i] === '.') {
        i--;
        while (i >= 0 && /\s/.test(code[i])) i--;
        continue;
      }
      continue;
    }
    if (/[A-Za-z0-9_.$]/.test(ch)) {
      i--;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i--;
      while (i >= 0 && !(code[i] === q && code[i - 1] !== '\\')) i--;
      i--;
      break;
    }
    break;
  }
  const start = Math.max(0, i + 1);
  return code.slice(start, end).trim();
}

function isExternalLiteralCandidate(candidate: string, baseCwd: string, effectiveCwd: string): boolean {
  if (!candidate) return false;
  if (/^\$env:(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b|%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA)%/i.test(candidate)) {
    return true;
  }
  const resolved = normalizeShellPath(candidate, effectiveCwd);
  return !isPathInsideWorkspace(resolved, baseCwd);
}

function findExternalPathInScriptExpression(
  expr: string,
  assignments: Map<string, string[]>,
  baseCwd: string,
  effectiveCwd: string,
  options: { isPowerShell?: boolean; expandedCliArgs?: string[] } = {}
): string | null {
  if (!expr || !expr.trim()) return null;
  const isPowerShell = Boolean(options.isPowerShell);
  const queue: string[] = [expr.trim()];
  const seen = new Set<string>();
  let steps = 0;

  while (queue.length > 0 && steps < 64) {
    steps++;
    const cur = queue.shift()!;
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);

    if (hasHomeDirReference(cur, isPowerShell)) {
      return '~';
    }

    if (options.expandedCliArgs && /(?:sys\.argv|process\.argv|\$args\b)/i.test(cur)) {
      for (const cliArg of options.expandedCliArgs) {
        if (!cliArg || isShellFlag(cliArg)) continue;
        const resolvedCli = normalizeShellPath(cliArg, effectiveCwd);
        if (!isPathInsideWorkspace(resolvedCli, baseCwd)) {
          return cliArg;
        }
      }
    }

    for (const cand of extractAllInlineScriptPathCandidates(cur)) {
      if (isExternalLiteralCandidate(cand, baseCwd, effectiveCwd)) {
        return cand;
      }
    }

    // Check `os.path.join(...)` / `path.join(...)` / `path.resolve(...)` literal-only calls
    let curWithoutLiteralJoins = cur;
    const joinCallRe = /\b(?:os\.path\.join|posixpath\.join|ntpath\.join|path\.join|path\.resolve)\s*\(/g;
    let jm: RegExpExecArray | null;
    while ((jm = joinCallRe.exec(cur)) !== null) {
      const openIdx = jm.index + jm[0].length - 1;
      const closeIdx = findMatchingParenEnd(cur, openIdx);
      if (closeIdx < 0) continue;
      const joinArgs = splitTopLevelCommaArgs(cur.slice(openIdx + 1, closeIdx));
      const litSegs: string[] = [];
      let allLiterals = joinArgs.length > 0;
      for (const ja of joinArgs) {
        const sm = /^(?:[rRuU]?)(['"])((?:\\.|[^\\])*)\1$/.exec(ja);
        if (!sm) {
          allLiterals = false;
          break;
        }
        const isRaw = /^[rR]/.test(ja);
        litSegs.push(isRaw ? sm[2] : sm[2].replace(/\\\\/g, '\\'));
      }
      if (allLiterals && litSegs.length > 0) {
        const joined = path.join(...litSegs);
        if (isExternalLiteralCandidate(joined, baseCwd, effectiveCwd)) {
          return joined;
        }
        curWithoutLiteralJoins =
          curWithoutLiteralJoins.slice(0, jm.index) +
          ' '.repeat(closeIdx + 1 - jm.index) +
          curWithoutLiteralJoins.slice(closeIdx + 1);
      }
    }

    // Check relative `..` escape literals in the remaining expression
    const relLitRe = /(?:[rRuUbBfF]{0,2})'(?:\\.|[^'\\])*'|(?:[rRuUbBfF]{0,2})"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
    let lm: RegExpExecArray | null;
    while ((lm = relLitRe.exec(curWithoutLiteralJoins)) !== null) {
      const tok = lm[0];
      const qIdx = tok.search(/['"`]/);
      if (qIdx < 0) continue;
      const isRaw = /[rR]/.test(tok.slice(0, qIdx));
      let inner = tok.slice(qIdx + 1, -1);
      if (!isRaw) inner = inner.replace(/\\\\/g, '\\');
      const cand = inner.trim();
      if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(cand) && isExternalLiteralCandidate(cand, baseCwd, effectiveCwd)) {
        return cand;
      }
    }

    // Unquoted PowerShell path tokens (e.g. `..\outside.txt`, `~`, `C:\outside`)
    if (isPowerShell && !/['"`()]/.test(cur) && !cur.startsWith('$')) {
      if (
        /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|~(?:$|[\\/])|\.\.(?:$|[\\/]))/.test(cur) &&
        isExternalLiteralCandidate(cur, baseCwd, effectiveCwd)
      ) {
        return cur;
      }
    }

    // Follow variable references (including f-string / template / PowerShell `$var` interpolations)
    const stripped = stripStringLiteralsForIdentifierCheck(cur);
    const idCandidates = new Set<string>(extractInterpolatedIdentifiers(cur));
    const idRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let idm: RegExpExecArray | null;
    while ((idm = idRe.exec(stripped)) !== null) {
      idCandidates.add(idm[1]);
    }
    for (const ident of idCandidates) {
      const bound = assignments.get(ident) ?? assignments.get(`$${ident}`);
      if (bound) {
        for (const rhs of bound) {
          queue.push(rhs);
        }
      }
    }
  }

  return null;
}

function isWriteOpenModeExpr(modeExpr: string | undefined, assignments: Map<string, string[]>): boolean {
  if (!modeExpr) return false;
  const trimmed = modeExpr.trim();
  const litMatch = /^['"]([rwbxatU+]*)['"]$/i.exec(trimmed);
  if (litMatch) {
    return /[wxa+]/i.test(litMatch[1]);
  }
  if (/\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/.test(trimmed)) {
    return true;
  }
  const bound = assignments.get(trimmed);
  if (bound) {
    for (const rhs of bound) {
      const rhsLit = /^['"]([rwbxatU+]*)['"]$/i.exec(rhs.trim());
      if (rhsLit && /[wxa+]/i.test(rhsLit[1])) return true;
    }
  }
  return false;
}

const PS_CMDLET_VALUE_FLAGS = new Set([
  '-value',
  '-encoding',
  '-itemtype',
  '-filter',
  '-include',
  '-exclude',
  '-depth',
  '-attributes',
  '-erroraction',
  '-ea',
  '-newname',
  '-width',
  '-inputobject',
]);

function extractPowerShellCmdletPathArgs(
  args: string[],
  mode: 'single' | 'move' | 'copy' | 'list'
): string[] {
  const pathTargets: string[] = [];
  const destTargets: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const low = a.toLowerCase();
    if ((low === '-path' || low === '-literalpath' || low === '-filepath') && i + 1 < args.length) {
      pathTargets.push(args[++i]);
      continue;
    }
    if (low === '-destination' && i + 1 < args.length) {
      destTargets.push(args[++i]);
      continue;
    }
    if (PS_CMDLET_VALUE_FLAGS.has(low) && i + 1 < args.length) {
      i++;
      continue;
    }
    if (isShellFlag(a)) continue;
    positional.push(a);
  }

  if (mode === 'copy') {
    if (destTargets.length > 0) return destTargets;
    return positional.length >= 2 ? [positional[1]] : [];
  }
  if (mode === 'move') {
    const out = [...pathTargets, ...destTargets];
    if (pathTargets.length === 0 && positional.length >= 1) out.push(positional[0]);
    if (destTargets.length === 0 && positional.length >= 2) out.push(positional[1]);
    return out;
  }
  if (mode === 'list') {
    if (pathTargets.length > 0) return pathTargets;
    return positional;
  }
  // single target
  if (pathTargets.length > 0) return pathTargets;
  return positional.length >= 1 ? [positional[0]] : [];
}

function scanScriptCalls(
  cleaned: string,
  masked: string,
  re: RegExp,
  handler: (match: RegExpExecArray, openParenIdx: number, args: string[], positional: string[]) => string | null
): string | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParenEnd(cleaned, openParenIdx);
    if (closeParenIdx < 0) continue;
    const inner = cleaned.slice(openParenIdx + 1, closeParenIdx);
    const args = splitTopLevelCommaArgs(inner);
    const positional = args.filter((a) => !/^[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/.test(a));
    const hit = handler(m, openParenIdx, args, positional);
    if (hit) return hit;
  }
  return null;
}

/**
 * Scan script file or inline script content for filesystem writes/deletes/moves
 * targeting paths outside the active workspace.
 */
export function detectExternalWriteInScriptContent(
  content: string,
  baseCwd: string,
  effectiveCwd = baseCwd,
  scriptPathOrLang?: string,
  expandedCliArgs?: string[]
): string | null {
  if (!content || typeof content !== 'string') return null;
  const cleaned = stripScriptLineComments(content, scriptPathOrLang);
  if (!cleaned.trim()) return null;

  if (scriptPathOrLang && /\.(?:bat|cmd)$/i.test(scriptPathOrLang)) {
    for (const line of cleaned.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || /^@?echo\b/i.test(trimmed)) continue;
      for (const target of extractBashWriteTargets(trimmed, effectiveCwd)) {
        if (!isPathInsideWorkspace(target.resolved, baseCwd)) {
          return `Writing or mutating path "${target.raw}" outside active workspace via batch script is prohibited. Keep temporary files inside .papercup/tmp/ and use vn_writeback / vn_repack for external patch output.`;
        }
      }
    }
    return null;
  }

  const isPowerShell = isPowerShellContext(scriptPathOrLang);
  const assignments = collectScriptVariableAssignments(cleaned);
  const masked = maskStringLiterals(cleaned);
  const exprOpts = { isPowerShell, expandedCliArgs };

  const checkExpr = (expr: string | undefined): string | null => {
    if (!expr) return null;
    const extHit = findExternalPathInScriptExpression(expr, assignments, baseCwd, effectiveCwd, exprOpts);
    if (extHit) {
      return `Writing or mutating path "${extHit}" outside active workspace via script is prohibited. Keep temporary files inside .papercup/tmp/ and use vn_writeback / vn_repack for external patch output.`;
    }
    return null;
  };

  // 1. open(...) / io.open(...) / codecs.open(...) / Path(...).open(...) / fs.openSync(...)
  const openHit = scanScriptCalls(cleaned, masked, /(?:\b(?:io|codecs|fs(?:\.promises)?)\.)?\bopen(?:Sync)?\s*\(/g, (m, _openIdx, args, positional) => {
    const prefixStart = m.index;
    const isMethodCall = prefixStart > 0 && cleaned[prefixStart - 1] === '.' && !/\b(?:io|codecs|fs(?:\.promises)?)\./.test(m[0]);
    let modeExpr: string | undefined;
    for (const a of args) {
      const kw = /^mode\s*=\s*([\s\S]+)$/.exec(a);
      if (kw) {
        modeExpr = kw[1];
        break;
      }
    }
    if (isMethodCall) {
      modeExpr = modeExpr ?? positional[0];
      if (!isWriteOpenModeExpr(modeExpr, assignments)) return null;
      return checkExpr(extractReceiverExprBeforeDot(cleaned, masked, prefixStart - 1));
    }
    modeExpr = modeExpr ?? positional[1];
    if (!isWriteOpenModeExpr(modeExpr, assignments)) return null;
    let fileExpr = positional[0];
    for (const a of args) {
      const kw = /^file\s*=\s*([\s\S]+)$/.exec(a);
      if (kw) {
        fileExpr = kw[1];
        break;
      }
    }
    return checkExpr(fileExpr);
  });
  if (openHit) return openHit;

  // 2. Pathlib receiver mutations: .write_text / .write_bytes / .unlink / .rmdir / .mkdir / .touch
  const pathMutHit = scanScriptCalls(cleaned, masked, /\.(?:write_text|write_bytes|unlink|rmdir|mkdir|touch)\s*\(/g, (m) => {
    const receiver = extractReceiverExprBeforeDot(cleaned, masked, m.index);
    return checkExpr(receiver);
  });
  if (pathMutHit) return pathMutHit;

  // 3. Path.replace(dst) / Path.rename(dst) (1-arg filesystem ops; skip 2-arg str.replace)
  const pathRenameHit = scanScriptCalls(cleaned, masked, /\.(?:replace|rename)\s*\(/g, (m, _openIdx, args, positional) => {
    if (args.length !== 1) return null;
    const receiver = extractReceiverExprBeforeDot(cleaned, masked, m.index);
    return checkExpr(receiver) ?? checkExpr(positional[0]);
  });
  if (pathRenameHit) return pathRenameHit;

  // 4. Single-target file/dir mutations (Python os.*, shutil.rmtree, Node fs.*, .NET IO.File/Directory, VBS)
  const singleMutHit = scanScriptCalls(
    cleaned,
    masked,
    /(?:\bos\.(?:remove|unlink|rmdir|mkdir|makedirs)|\bshutil\.rmtree|\b(?:fs(?:\.promises)?\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|mkdirSync|mkdir|truncateSync|truncate|createWriteStream)|\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendAllLines|Delete|Create|OpenWrite|CreateDirectory)|\b(?:CreateTextFile|DeleteFile|DeleteFolder|CreateFolder))\s*\(/gi,
    (_m, _openIdx, args, positional) => {
      let target = positional[0];
      for (const a of args) {
        const kw = /^(?:path|dst)\s*=\s*([\s\S]+)$/.exec(a);
        if (kw) {
          target = kw[1];
          break;
        }
      }
      return checkExpr(target);
    }
  );
  if (singleMutHit) return singleMutHit;

  // VBS OpenTextFile(path, mode) where mode is 2 (ForWriting) or 8 (ForAppending)
  const vbsOpenHit = scanScriptCalls(cleaned, masked, /\bOpenTextFile\s*\(/gi, (_m, _openIdx, _args, positional) => {
    const mode = positional[1]?.trim();
    if (mode === '2' || mode === '8' || /\bFor(?:Writing|Appending)\b/i.test(mode ?? '')) {
      return checkExpr(positional[0]);
    }
    return null;
  });
  if (vbsOpenHit) return vbsOpenHit;

  // 5. Dual-target move/rename (check both src and dst)
  const moveHit = scanScriptCalls(
    cleaned,
    masked,
    /(?:\bos\.(?:replace|rename)|\bshutil\.move|\b(?:fs(?:\.promises)?\.)?(?:renameSync|rename)|\[(?:System\.)?IO\.(?:File|Directory)\]::(?:Move|Replace)|\b(?:MoveFile|MoveFolder))\s*\(/gi,
    (_m, _openIdx, args, positional) => {
      let src = positional[0];
      let dst = positional[1];
      for (const a of args) {
        const srcKw = /^src\s*=\s*([\s\S]+)$/.exec(a);
        if (srcKw) src = srcKw[1];
        const dstKw = /^dst\s*=\s*([\s\S]+)$/.exec(a);
        if (dstKw) dst = dstKw[1];
      }
      return checkExpr(src) ?? checkExpr(dst);
    }
  );
  if (moveHit) return moveHit;

  // 6. Copy calls (check dst only so reading external font/asset into workspace stays allowed)
  const copyHit = scanScriptCalls(
    cleaned,
    masked,
    /(?:\bshutil\.(?:copy|copy2|copyfile|copytree)|\b(?:fs(?:\.promises)?\.)?(?:copyFileSync|copyFile|cpSync|cp)|\[(?:System\.)?IO\.File\]::Copy|\b(?:CopyFile|CopyFolder))\s*\(/gi,
    (_m, _openIdx, args, positional) => {
      let dst = positional[1];
      for (const a of args) {
        const dstKw = /^dst\s*=\s*([\s\S]+)$/.exec(a);
        if (dstKw) {
          dst = dstKw[1];
          break;
        }
      }
      return checkExpr(dst);
    }
  );
  if (copyHit) return copyHit;

  // 7. PowerShell cmdlets & redirections (for .ps1 scripts or PowerShell -Command)
  if (isPowerShell || /\b(?:Set-Content|Add-Content|Out-File|Clear-Content|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i.test(cleaned)) {
    const psJoined = cleaned.replace(/`\r?\n/g, ' ');
    for (const { text: seg } of splitShellSegments(psJoined)) {
      const { targets: redirs, stripped } = extractShellRedirectionTargets(seg);
      for (const rt of redirs) {
        const exp = expandTrackedShellVars(rt, new Map());
        if (!SAFE_REDIRECT_TARGETS.has(exp.toLowerCase())) {
          const hit = checkExpr(rt);
          if (hit) return hit;
        }
      }
      const tokens = tokenizeShellSegment(stripped);
      if (tokens.length === 0) continue;
      const cmdLow = cmdBasename(tokens[0]).replace(/\.exe$/, '');
      const args = tokens.slice(1);
      if (
        cmdLow === 'set-content' ||
        cmdLow === 'add-content' ||
        cmdLow === 'out-file' ||
        cmdLow === 'new-item' ||
        cmdLow === 'clear-content' ||
        cmdLow === 'remove-item' ||
        cmdLow === 'rename-item'
      ) {
        for (const t of extractPowerShellCmdletPathArgs(args, 'single')) {
          const hit = checkExpr(t);
          if (hit) return hit;
        }
      } else if (cmdLow === 'move-item') {
        for (const t of extractPowerShellCmdletPathArgs(args, 'move')) {
          const hit = checkExpr(t);
          if (hit) return hit;
        }
      } else if (cmdLow === 'copy-item') {
        for (const t of extractPowerShellCmdletPathArgs(args, 'copy')) {
          const hit = checkExpr(t);
          if (hit) return hit;
        }
      }
    }
  }

  return null;
}

/**
 * Scan script file or inline script content for host process kill or launch APIs.
 */
export function detectProcessControlInScriptContent(
  content: string,
  scriptPathOrLang?: string
): string | null {
  if (!content || typeof content !== 'string') return null;
  const cleaned = stripScriptLineComments(content, scriptPathOrLang);
  if (!cleaned.trim()) return null;

  const isPowerShell = isPowerShellContext(scriptPathOrLang);
  const isBatch = Boolean(scriptPathOrLang && /\.(?:bat|cmd)$/i.test(scriptPathOrLang));

  if (/\b(?:Stop-Process|Start-Process|Invoke-Item)\b/i.test(cleaned)) {
    return 'Terminating or launching host processes via PowerShell process cmdlets in script is prohibited.';
  }
  if (/\.Terminate\s*\(/i.test(cleaned)) {
    return 'Terminating host processes via WMI Terminate() in script is prohibited.';
  }
  if (isPowerShell && /(?:^|[;|&({\r\n])\s*(?:kill|spps|saps)\b/im.test(cleaned)) {
    return 'Terminating or launching host processes via PowerShell alias in script is prohibited.';
  }
  if (/\b(?:taskkill|tskill|pkill|killall)(?:\.exe)?\b/i.test(cleaned)) {
    return 'Terminating host processes via taskkill/tskill/pkill/killall in script is prohibited.';
  }
  if (
    /\bos\.(?:kill|killpg|system|popen|spawn[a-z]*|exec[a-z]*)\s*\(/.test(cleaned) ||
    /\bsubprocess\.(?:run|Popen|call|check_call|check_output|getoutput|getstatusoutput)\s*\(/.test(cleaned) ||
    /\bfrom\s+subprocess\s+import\b/.test(cleaned) ||
    /\bPopen\s*\(/.test(cleaned) ||
    /\b(?:TerminateProcess|win32process\.CreateProcess)\b/.test(cleaned)
  ) {
    return 'Terminating or launching processes via Python os.kill/os.system/subprocess/Popen in script is prohibited.';
  }
  if (
    /\bprocess\.kill\s*\(/.test(cleaned) ||
    (/\bchild_process\b/.test(cleaned) &&
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b/.test(cleaned)) ||
    /\b(?:execSync|execFileSync|spawnSync)\s*\(/.test(cleaned)
  ) {
    return 'Terminating or launching processes via Node process.kill/child_process in script is prohibited.';
  }
  if (
    (/\bWScript\.Shell\b/i.test(cleaned) && /\.(?:Run|Exec)\s*\(/i.test(cleaned)) ||
    /\bShellExecute(?:A|W)?\b/i.test(cleaned)
  ) {
    return 'Launching processes via WScript.Shell/ShellExecute in script is prohibited.';
  }

  if (isBatch) {
    for (const line of cleaned.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || /^@?echo\b/i.test(trimmed)) continue;
      if (/^@?(?:start|kill|mklink)\b/i.test(trimmed)) {
        return 'Launching executables or terminating processes inside batch script is prohibited.';
      }
      const exeMatches = trimmed.match(/[^\s"';&|]+\.(?:bat|cmd|exe|msi|vbs)\b/gi) ?? [];
      for (const m of exeMatches) {
        const base = cmdBasename(m);
        if (/\.(?:bat|cmd|msi|vbs)$/i.test(base) || !SAFE_CLI_BASENAMES.has(base)) {
          return `Launching executable "${m}" inside batch script is prohibited.`;
        }
      }
    }
  }

  return null;
}

/**
 * Scan script file or inline script content for host process enumeration (Win32_Process / wmic process)
 * or out-of-workspace directory traversal (os.walk / Path.rglob / Get-ChildItem).
 */
export function detectHostSearchInScriptContent(
  content: string,
  baseCwd: string,
  effectiveCwd = baseCwd,
  scriptPathOrLang?: string
): string | null {
  if (!content || typeof content !== 'string') return null;
  const cleaned = stripScriptLineComments(content, scriptPathOrLang);
  if (!cleaned.trim()) return null;

  const isPowerShell = isPowerShellContext(scriptPathOrLang);

  // 1. Host process enumeration (exposes host command lines / secrets)
  if (
    (/\bWin32_Process\b/i.test(cleaned) &&
      /\b(?:Get-CimInstance|gcim|Get-WmiObject|gwmi|winmgmts|ManagementObjectSearcher|wmi)\b/i.test(cleaned)) ||
    /\bwmic(?:\.exe)?\s+process\b/i.test(cleaned) ||
    /['"]wmic(?:\.exe)?['"]\s*,\s*['"]process['"]/i.test(cleaned)
  ) {
    return 'Enumerating host processes (Win32_Process / wmic process) via bash or script is prohibited.';
  }

  const assignments = collectScriptVariableAssignments(cleaned);
  const masked = maskStringLiterals(cleaned);
  const exprOpts = { isPowerShell };

  const checkTraversalExpr = (expr: string | undefined): string | null => {
    if (!expr) return null;
    if (HOST_PACKAGE_DIR_PATTERN.test(expr)) {
      return 'Searching host package directories (site-packages/node_modules) is prohibited. Rely on tool schemas and workspace files instead.';
    }
    const extHit = findExternalPathInScriptExpression(expr, assignments, baseCwd, effectiveCwd, exprOpts);
    if (extHit) {
      if (HOST_PACKAGE_DIR_PATTERN.test(extHit)) {
        return 'Searching host package directories (site-packages/node_modules) is prohibited. Rely on tool schemas and workspace files instead.';
      }
      return `Traversing host directory "${extHit}" outside active workspace via script is prohibited.`;
    }
    return null;
  };

  // 2. Python / Node directory traversal calls
  const pyWalkHit = scanScriptCalls(
    cleaned,
    masked,
    /(?:\bos\.(?:walk|scandir)|\bglob\.(?:glob|iglob)|\b(?:fs(?:\.promises)?\.)?globSync)\s*\(/g,
    (_m, _openIdx, args, positional) => {
      let target = positional[0];
      for (const a of args) {
        const kw = /^(?:top|path|pathname)\s*=\s*([\s\S]+)$/.exec(a);
        if (kw) {
          target = kw[1];
          break;
        }
      }
      return checkTraversalExpr(target);
    }
  );
  if (pyWalkHit) return pyWalkHit;

  const rglobHit = scanScriptCalls(cleaned, masked, /\.(?:rglob|glob)\s*\(/g, (m) => {
    const receiver = extractReceiverExprBeforeDot(cleaned, masked, m.index);
    return checkTraversalExpr(receiver);
  });
  if (rglobHit) return rglobHit;

  const nodeReaddirHit = scanScriptCalls(
    cleaned,
    masked,
    /\b(?:fs(?:\.promises)?\.)?(?:readdirSync|readdir)\s*\(/g,
    (_m, _openIdx, args, positional) => {
      const hasRecursive = args.some((a) => /\brecursive\s*:\s*true\b/.test(a));
      if (hasRecursive || HOST_PACKAGE_DIR_PATTERN.test(positional[0] ?? '')) {
        return checkTraversalExpr(positional[0]);
      }
      return null;
    }
  );
  if (nodeReaddirHit) return nodeReaddirHit;

  // 3. PowerShell Get-ChildItem / gci targeting paths outside workspace or ~
  if (isPowerShell || /\b(?:Get-ChildItem|gci)\b/i.test(cleaned)) {
    const psJoined = cleaned.replace(/`\r?\n/g, ' ');
    for (const { text: seg } of splitShellSegments(psJoined)) {
      const { stripped } = extractShellRedirectionTargets(seg);
      const tokens = tokenizeShellSegment(stripped);
      if (tokens.length === 0) continue;
      const cmdLow = cmdBasename(tokens[0]).replace(/\.exe$/, '');
      if (cmdLow === 'get-childitem' || cmdLow === 'gci') {
        const pathArgs = extractPowerShellCmdletPathArgs(tokens.slice(1), 'list');
        for (const t of pathArgs) {
          if (/^(?:cert|alias|function|variable|wsman):/i.test(t)) continue;
          const hit = checkTraversalExpr(t);
          if (hit) return hit;
        }
      }
    }
  }

  return null;
}

function detectHostSearchInCommand(command: string, baseCwd: string): string | null {
  return visitShellCommandSegments(
    command,
    baseCwd,
    ({ cmdName, expandedArgs, effectiveCwd, rawEffectiveCwd, inlineCode, scriptPath, scriptContent }) => {
      if (inlineCode) {
        const inlineHit = detectHostSearchInScriptContent(inlineCode, baseCwd, effectiveCwd, cmdName);
        if (inlineHit) return inlineHit;
      }
      if (scriptContent) {
        const fileHit = detectHostSearchInScriptContent(scriptContent, baseCwd, effectiveCwd, scriptPath);
        if (fileHit) return fileHit;
      }

      if (cmdName === 'wmic' && expandedArgs.some((a) => a.toLowerCase() === 'process')) {
        return 'Enumerating host processes (wmic process) via bash is prohibited.';
      }
      if (
        (cmdName === 'get-ciminstance' || cmdName === 'gcim' || cmdName === 'get-wmiobject' || cmdName === 'gwmi') &&
        expandedArgs.some((a) => /\bwin32_process\b/i.test(a))
      ) {
        return `Enumerating host processes (${cmdName} Win32_Process) via bash is prohibited.`;
      }

      if (SEARCH_TOOL_NAMES.has(cmdName)) {
        const posixEffectiveCwd = effectiveCwd.replace(/\\/g, '/');
        if (
          HOST_PACKAGE_DIR_PATTERN.test(effectiveCwd) ||
          HOST_PACKAGE_DIR_PATTERN.test(posixEffectiveCwd) ||
          HOST_PACKAGE_DIR_PATTERN.test(rawEffectiveCwd) ||
          expandedArgs.some((a) => HOST_PACKAGE_DIR_PATTERN.test(a))
        ) {
          return 'Searching host package directories (site-packages/node_modules) is prohibited. Rely on tool schemas and workspace files instead.';
        }
      }
      return null;
    }
  );
}

/**
 * Block shell searches/listings against host package/runtime directories
 * (site-packages/dist-packages/global node_modules), host process enumeration,
 * or out-of-workspace traversal inside local scripts / inline code.
 */
export function detectBlockedHostSearchCommand(command: string, cwd?: string): string | null {
  if (!command || typeof command !== 'string') return null;
  const baseCwd = cwd ? path.resolve(cwd) : process.cwd();
  return detectHostSearchInCommand(command, baseCwd);
}

function isShellFlag(tok: string): boolean {
  return tok.startsWith('-') || tok.startsWith('//') || /^\/[A-Za-z?]$/.test(tok);
}

function extractShellRedirectionTargets(seg: string): { targets: string[]; stripped: string } {
  const targets: string[] = [];
  let stripped = '';
  let quote: '"' | "'" | null = null;
  const n = seg.length;
  for (let i = 0; i < n; i++) {
    const ch = seg[i];
    if (quote) {
      stripped += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < n) {
        stripped += seg[++i];
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      stripped += ch;
      continue;
    }
    // Skip process substitution `>(...)` so it isn't misread as file redirection
    if (ch === '>' && i + 1 < n && seg[i + 1] === '(') {
      stripped += ch;
      continue;
    }
    // Match unquoted [fd|&]>(>)? <target>
    const isRedirStart =
      ch === '>' ||
      ((ch === '&' || (ch >= '0' && ch <= '9')) &&
        i + 1 < n &&
        seg[i + 1] === '>' &&
        (i === 0 || /[\s;|&(]/.test(seg[i - 1])));
    if (isRedirStart) {
      let j = ch === '>' ? i + 1 : i + 2;
      if (j < n && seg[j] === '>') j++;
      while (j < n && /\s/.test(seg[j])) j++;
      if (j < n && seg[j] === '&') {
        // fd duplication like 2>&1
        j++;
        while (j < n && /[0-9-]/.test(seg[j])) j++;
        stripped += ' ';
        i = j - 1;
        continue;
      }
      let target = '';
      if (j < n && (seg[j] === '"' || seg[j] === "'")) {
        const q = seg[j++];
        while (j < n && seg[j] !== q) {
          if (seg[j] === '\\' && q === '"' && j + 1 < n) {
            target += seg[++j];
          } else {
            target += seg[j];
          }
          j++;
        }
        if (j < n && seg[j] === q) j++;
      } else {
        while (j < n && !/[\s;|&<>()]/.test(seg[j])) {
          target += seg[j++];
        }
      }
      if (target) targets.push(target);
      stripped += ' ';
      i = j - 1;
      continue;
    }
    stripped += ch;
  }
  return { targets, stripped: stripped.trim() };
}

const DELETE_TARGET_CMDS = new Set(['rm', 'rmdir', 'remove-item', 'del', 'erase']);
const PS_CONTENT_CMDS = new Set(['set-content', 'add-content', 'out-file', 'new-item']);
const XARGS_VALUE_FLAGS = new Set(['-n', '-P', '-I', '-L', '-d', '-s', '-E', '-a', '--max-args', '--max-procs', '--replace', '--delimiter', '--arg-file']);

export interface ExtractedBashWriteTarget {
  raw: string;
  expanded: string;
  resolved: string;
  kind: 'write' | 'delete_or_move';
  sourceBasenames?: string[];
}

function derivePipeHintPaths(
  cmdName: string,
  args: string[],
  vars: Map<string, string>,
  loopVars: Map<string, string[]>
): string[] {
  const expandArg = (a: string) =>
    expandTrackedShellVarsMulti(a, vars, loopVars).flatMap((v) => expandBraceTargets(v));
  if (cmdName === 'find') {
    const startDirs: string[] = [];
    const namePatterns: string[] = [];
    let seenExpr = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!seenExpr && !a.startsWith('-') && a !== '!' && a !== '(' && a !== ',') {
        startDirs.push(...expandArg(a));
        continue;
      }
      seenExpr = true;
      if ((a === '-name' || a === '-iname' || a === '-path' || a === '-ipath') && i + 1 < args.length) {
        namePatterns.push(...expandArg(args[++i]));
      }
    }
    const bases = startDirs.length ? startDirs : ['.'];
    if (namePatterns.length === 0) return bases;
    const hints: string[] = [];
    for (const b of bases) {
      const cleanBase = b.replace(/[\\/]+$/, '');
      for (const pat of namePatterns) {
        if (cleanBase === '.') {
          hints.push(pat, `**/${pat}`);
        } else {
          hints.push(`${cleanBase}/${pat}`, `${cleanBase}/**/${pat}`);
        }
      }
    }
    return hints;
  }
  if (cmdName === 'echo' || cmdName === 'printf' || cmdName === 'ls' || cmdName === 'dir') {
    return args.filter((a) => !isShellFlag(a)).flatMap((a) => expandArg(a));
  }
  return [];
}

function collectBashWriteTargets(
  command: string,
  baseCwd: string,
  parentVars: Map<string, string>,
  parentLoopVars: Map<string, string[]>,
  out: ExtractedBashWriteTarget[],
  depth: number
): void {
  if (depth > MAX_SHELL_RECURSION_DEPTH) return;
  const segments = splitShellSegments(command);
  const vars = new Map(parentVars);
  const loopVars = new Map(parentLoopVars);
  let effectiveCwd = baseCwd;
  let prevPipeHints: string[] = [];

  const pushTarget = (
    rawTarget: string,
    kind: 'write' | 'delete_or_move',
    sourceBasenames?: string[]
  ): void => {
    const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, '');
    if (!cleaned) return;
    const expandedList = expandTrackedShellVarsMulti(cleaned, vars, loopVars).flatMap((v) => expandBraceTargets(v));
    for (const expanded of expandedList) {
      if (!expanded) continue;
      if (SAFE_REDIRECT_TARGETS.has(expanded.toLowerCase())) continue;
      const resolved = normalizeShellPath(expanded, effectiveCwd);
      out.push({
        raw: rawTarget,
        expanded,
        resolved,
        kind,
        ...(sourceBasenames && sourceBasenames.length ? { sourceBasenames } : {}),
      });
    }
  };

  for (const { text: rawSeg, pipedFromPrev } of segments) {
    const seg = rawSeg.trim();
    if (!seg || seg.startsWith('#')) {
      prevPipeHints = [];
      continue;
    }

    // 0. Embedded subshells / command substitutions / process substitutions
    for (const inner of extractEmbeddedShellCommands(seg)) {
      collectBashWriteTargets(inner, effectiveCwd, vars, loopVars, out, depth + 1);
    }

    // 1. Unquoted redirections in this segment (>, >>, 1>, 2>, &>)
    const { targets: redirTargets, stripped: cleanSeg } = extractShellRedirectionTargets(seg);
    for (const target of redirTargets) {
      pushTarget(target, 'write');
    }

    const parsed = unwrapSegmentTokens(tokenizeShellSegment(cleanSeg), vars);
    if (!parsed) {
      prevPipeHints = [];
      continue;
    }

    for (const extra of parsed.extraNestedCommands) {
      collectBashWriteTargets(extra, effectiveCwd, vars, loopVars, out, depth + 1);
    }

    let { cmdName, args } = parsed;
    const currentPipeHints = derivePipeHintPaths(cmdName, args, vars, loopVars);

    // Handle `xargs [flags] <subcmd> [subargs...]` by feeding piped hints into `<subcmd>`
    if (cmdName === 'xargs') {
      let replaceToken: string | null = null;
      let i = 0;
      while (i < args.length) {
        const a = args[i];
        if (a === '--') {
          i++;
          break;
        }
        if ((a === '-I' || a === '--replace') && i + 1 < args.length) {
          replaceToken = args[++i];
          i++;
          continue;
        }
        if (a.startsWith('-I') && a.length > 2) {
          replaceToken = a.slice(2);
          i++;
          continue;
        }
        if (a.startsWith('--replace=')) {
          replaceToken = a.slice('--replace='.length);
          i++;
          continue;
        }
        if (XARGS_VALUE_FLAGS.has(a)) {
          i += 2;
          continue;
        }
        if (a.startsWith('-')) {
          i++;
          continue;
        }
        break;
      }
      const subTokens = args.slice(i);
      if (subTokens.length > 0) {
        const fedHints = pipedFromPrev && prevPipeHints.length > 0 ? prevPipeHints : [];
        let rebuiltTokens: string[];
        if (replaceToken && fedHints.length > 0) {
          rebuiltTokens = subTokens.flatMap((t) =>
            t.includes(replaceToken!) ? fedHints.map((h) => t.split(replaceToken!).join(h)) : [t]
          );
        } else {
          rebuiltTokens = [...subTokens, ...fedHints];
        }
        const rebuiltCmd = rebuiltTokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ');
        collectBashWriteTargets(rebuiltCmd, effectiveCwd, vars, loopVars, out, depth + 1);
      }
      prevPipeHints = currentPipeHints;
      continue;
    }

    prevPipeHints = currentPipeHints;

    if (VAR_DECL_CMDS.has(cmdName)) {
      for (const a of args) {
        const assign = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (assign) {
          vars.set(assign[1], expandTrackedShellVars(assign[2], vars));
        }
      }
      continue;
    }

    if (cmdName === 'for' && args.length >= 3 && args[1].toLowerCase() === 'in') {
      const varName = args[0];
      const vals = args
        .slice(2)
        .flatMap((v) => expandTrackedShellVarsMulti(v, vars, loopVars))
        .flatMap((v) => expandBraceTargets(v));
      if (vals.length) {
        loopVars.set(varName, vals);
      }
      continue;
    }

    if (cmdName === 'done') {
      loopVars.clear();
      continue;
    }

    const nestedWrapper = extractNestedShellWrapperCommand(cmdName, args);
    if (nestedWrapper) {
      collectBashWriteTargets(nestedWrapper, effectiveCwd, vars, loopVars, out, depth + 1);
      continue;
    }

    if (cmdName === 'cd' || cmdName === 'pushd' || cmdName === 'set-location') {
      const targetArg = args.find((a) => !isShellFlag(a));
      if (targetArg) {
        const expanded = expandTrackedShellVars(targetArg, vars);
        effectiveCwd = normalizeShellPath(expanded, effectiveCwd);
      }
      continue;
    }

    if (cmdName === 'find') {
      const startDirs: string[] = [];
      const namePatterns: string[] = [];
      let hasDelete = false;
      let seenExpr = false;
      const execSubcmds: string[][] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const low = a.toLowerCase();
        if (!seenExpr && !a.startsWith('-') && a !== '!' && a !== '(' && a !== ',') {
          startDirs.push(a);
          continue;
        }
        seenExpr = true;
        if (low === '-delete') {
          hasDelete = true;
          continue;
        }
        if ((low === '-name' || low === '-iname') && i + 1 < args.length) {
          namePatterns.push(args[++i]);
          continue;
        }
        if (low === '-exec' || low === '-execdir' || low === '-ok' || low === '-okdir') {
          const sub: string[] = [];
          i++;
          while (i < args.length && args[i] !== ';' && args[i] !== '\\;' && args[i] !== '+') {
            sub.push(args[i]);
            i++;
          }
          if (sub.length > 0) execSubcmds.push(sub);
        }
      }
      const bases = startDirs.length ? startDirs : ['.'];
      const buildFindCandidates = (): string[] => {
        if (namePatterns.length === 0) return [...bases];
        const cands: string[] = [];
        for (const b of bases) {
          const cleanBase = b.replace(/[\\/]+$/, '');
          for (const pat of namePatterns) {
            if (cleanBase === '.') {
              cands.push(pat, `**/${pat}`);
            } else {
              cands.push(`${cleanBase}/${pat}`, `${cleanBase}/**/${pat}`);
            }
          }
        }
        return cands;
      };
      const findCandidates = buildFindCandidates();
      if (hasDelete) {
        for (const cand of findCandidates) {
          pushTarget(cand, 'delete_or_move');
        }
      }
      for (const sub of execSubcmds) {
        const expandedSub = sub.flatMap((tok) =>
          tok.includes('{}') ? findCandidates.map((c) => tok.split('{}').join(c)) : [tok]
        );
        const rebuilt = expandedSub.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ');
        collectBashWriteTargets(rebuilt, effectiveCwd, vars, loopVars, out, depth + 1);
      }
      continue;
    }

    if (PS_CONTENT_CMDS.has(cmdName)) {
      let explicitFound = false;
      const positional: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const low = a.toLowerCase();
        if ((low === '-path' || low === '-literalpath' || low === '-filepath') && i + 1 < args.length) {
          pushTarget(args[++i], 'write');
          explicitFound = true;
          continue;
        }
        if ((low === '-value' || low === '-encoding' || low === '-itemtype') && i + 1 < args.length) {
          i++;
          continue;
        }
        if (isShellFlag(a)) continue;
        positional.push(a);
      }
      if (!explicitFound && positional.length > 0) {
        pushTarget(positional[0], 'write');
      }
      continue;
    }

    if (DELETE_TARGET_CMDS.has(cmdName)) {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const low = a.toLowerCase();
        if ((low === '-path' || low === '-literalpath') && i + 1 < args.length) {
          pushTarget(args[++i], 'delete_or_move');
          continue;
        }
        if (isShellFlag(a)) continue;
        pushTarget(a, 'delete_or_move');
      }
      continue;
    }

    if (MUTATING_ALL_TARGET_CMDS.has(cmdName)) {
      for (const a of args) {
        if (isShellFlag(a)) continue;
        pushTarget(a, 'write');
      }
      continue;
    }

    if (cmdName === 'truncate') {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if ((a === '-s' || a === '--size' || a === '-r' || a === '--reference') && i + 1 < args.length) {
          i++;
          continue;
        }
        if (isShellFlag(a)) continue;
        pushTarget(a, 'write');
      }
      continue;
    }

    if (cmdName === 'sed') {
      let inPlace = false;
      let hasScriptFlag = false;
      const positional: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--in-place' || a.startsWith('--in-place=')) {
          inPlace = true;
          continue;
        }
        if (a === '-e' || a === '--expression' || a === '-f' || a === '--file') {
          hasScriptFlag = true;
          if (i + 1 < args.length) i++;
          continue;
        }
        if (a.startsWith('--expression=') || a.startsWith('--file=')) {
          hasScriptFlag = true;
          continue;
        }
        if (/^-[A-Za-z]*i/.test(a)) {
          inPlace = true;
          continue;
        }
        if (isShellFlag(a)) continue;
        positional.push(a);
      }
      if (inPlace) {
        const fileTargets = hasScriptFlag
          ? positional
          : positional.length >= 2
            ? positional.slice(1)
            : positional;
        for (const t of fileTargets) {
          pushTarget(t, 'write');
        }
      }
      continue;
    }

    if (MUTATING_DEST_CMDS.has(cmdName)) {
      const isMove = cmdName === 'mv' || cmdName === 'move' || cmdName === 'move-item';
      const positional: string[] = [];
      let explicitDest: string | null = null;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const low = a.toLowerCase();
        if ((a === '-t' || a === '--target-directory' || low === '-destination') && i + 1 < args.length) {
          explicitDest = args[++i];
          continue;
        }
        if (a.startsWith('--target-directory=')) {
          explicitDest = a.slice('--target-directory='.length);
          continue;
        }
        if ((low === '-path' || low === '-literalpath') && i + 1 < args.length) {
          positional.push(args[++i]);
          continue;
        }
        if (isShellFlag(a)) continue;
        positional.push(a);
      }

      const toBasenames = (srcs: string[]): string[] =>
        srcs
          .flatMap((s) =>
            expandTrackedShellVarsMulti(s.trim().replace(/^['"]|['"]$/g, ''), vars, loopVars).flatMap((v) =>
              expandBraceTargets(v)
            )
          )
          .map((exp) => {
            const base = path.basename(exp.replace(/[\\/]+$/, ''));
            return base && base !== '.' && base !== '..' ? base : '';
          })
          .filter(Boolean);

      if (explicitDest !== null) {
        pushTarget(explicitDest, isMove ? 'delete_or_move' : 'write', toBasenames(positional));
        if (isMove) {
          for (const src of positional) pushTarget(src, 'delete_or_move');
        }
      } else if (positional.length >= 2) {
        const dest = positional[positional.length - 1];
        const srcs = positional.slice(0, -1);
        pushTarget(dest, isMove ? 'delete_or_move' : 'write', toBasenames(srcs));
        if (isMove) {
          for (const src of srcs) pushTarget(src, 'delete_or_move');
        }
      }
      continue;
    }

    if (cmdName === 'mklink') {
      const linkArg = args.find((a) => !isShellFlag(a));
      if (linkArg) {
        pushTarget(linkArg, 'write');
      }
      continue;
    }

    if (cmdName === 'dd') {
      for (const a of args) {
        if (/^of=/i.test(a)) {
          pushTarget(a.slice(3), 'write');
        }
      }
      continue;
    }

    if (cmdName === 'tar' || cmdName === 'unzip') {
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '-C' || args[i] === '-d') && i + 1 < args.length) {
          pushTarget(args[++i], 'write');
        }
      }
      continue;
    }

    if (
      isPythonCmdName(cmdName) ||
      cmdName === 'node' ||
      cmdName === 'ruby' ||
      cmdName === 'perl'
    ) {
      const inlineCode = extractInlineInterpreterCode(cmdName, args);
      if (inlineCode && INLINE_SCRIPT_MUTATION_RE.test(inlineCode)) {
        for (const candidate of extractInlineScriptPathCandidates(inlineCode)) {
          pushTarget(candidate, 'write');
        }
      }
      continue;
    }
  }
}

const INLINE_SCRIPT_MUTATION_RE =
  /(?:\bopen\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*['"][rwbxatU+]*[wxa+][rwbxatU+]*['"]|\bopen\s*\(\s*(?:[^()]|\([^()]*\))*,\s*mode\s*=\s*['"][rwbxatU+]*[wxa+][rwbxatU+]*['"]|\.(?:write_text|write_bytes|unlink|rmdir|mkdir|replace|rename)\s*\(|\b(?:shutil\.(?:copy\w*|move|rmtree)|os\.(?:remove|unlink|replace|rename|mkdir|makedirs|rmdir))\s*\(|\b(?:writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|copyFile|cpSync|renameSync|rename|rmSync|rm|unlinkSync|unlink|mkdirSync|mkdir|createWriteStream)\s*\(|\bFile\.(?:write|delete|unlink|rename)\b|\bopen\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*['"]\s*>>?)/i;

const INLINE_NON_COPY_MUTATION_RE =
  /(?:\bopen\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*['"][rwbxatU+]*[wxa+][rwbxatU+]*['"]|\bopen\s*\(\s*(?:[^()]|\([^()]*\))*,\s*mode\s*=\s*['"][rwbxatU+]*[wxa+][rwbxatU+]*['"]|\.(?:write_text|write_bytes|unlink|rmdir|mkdir|replace|rename)\s*\(|\b(?:shutil\.(?:copyfileobj|move|rmtree)|os\.(?:remove|unlink|replace|rename|mkdir|makedirs|rmdir))\s*\(|\b(?:writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|rmSync|rm|unlinkSync|unlink|mkdirSync|mkdir|createWriteStream)\s*\(|\bFile\.(?:write|delete|unlink|rename)\b|\bopen\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*['"]\s*>>?|\b(?:eval|exec|compile|getattr|setattr|__import__|system|popen|spawn|execSync|execFileSync)\s*\()/i;

const INLINE_COPY_CALL_RE =
  /(?:\bshutil\.(?:copy|copy2|copyfile|copytree)|\b(?:fs(?:\.promises)?\.)?(?:copyFileSync|copyFile|cpSync))\s*\(/g;

const SAFE_COPY_DST_IDENTIFIERS = new Set([
  'os',
  'path',
  'posixpath',
  'ntpath',
  'pathlib',
  'Path',
  'PurePath',
  'str',
  'join',
  'dirname',
  'basename',
  'abspath',
  'normpath',
  'expanduser',
  'homedir',
  'home',
  'resolve',
  'process',
  'env',
  'environ',
  'get',
  'True',
  'False',
  'None',
  'true',
  'false',
  'null',
  'undefined',
]);

const INLINE_HOME_DIR_EXPR_RE =
  /(?:expanduser\s*\(\s*['"]~|Path\.home\s*\(|os\.homedir\s*\(|process\.env\.(?:HOME|USERPROFILE)\b|os\.environ(?:\.get)?\s*[\[(]\s*['"](?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)['"]|\$\{?env:(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\}?|\[(?:System\.)?Environment\]::GetFolderPath\s*\()/i;

function extractInlineInterpreterCode(cmdName: string, args: string[]): string | null {
  const isPython = isPythonCmdName(cmdName);
  const isNode = cmdName === 'node';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (isPython) {
      if (a === '-c' && i + 1 < args.length) return args[i + 1];
      if (a.startsWith('-c') && a.length > 2) return a.slice(2);
      if (a === '-m' || a.startsWith('-m')) break;
      if (PYTHON_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (!a.startsWith('-')) break;
      continue;
    }
    if (isNode) {
      if ((a === '-e' || a === '--eval' || a === '-p' || a === '--print') && i + 1 < args.length) {
        return args[i + 1];
      }
      if (a.startsWith('--eval=')) return a.slice('--eval='.length);
      if (a.startsWith('--print=')) return a.slice('--print='.length);
      if (NODE_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (!a.startsWith('-')) break;
      continue;
    }
    if (a === '-e' && i + 1 < args.length) {
      return args[i + 1];
    }
    if (!a.startsWith('-')) break;
  }
  return null;
}

function skipQuotedLiteral(code: string, startIdx: number): number {
  const quote = code[startIdx];
  const isTriple =
    (quote === "'" || quote === '"') &&
    code[startIdx + 1] === quote &&
    code[startIdx + 2] === quote;
  let i = startIdx + (isTriple ? 3 : 1);
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2;
      continue;
    }
    if (isTriple) {
      if (code[i] === quote && code[i + 1] === quote && code[i + 2] === quote) {
        return i + 3;
      }
    } else if (code[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return code.length;
}

function splitTopLevelStatements(code: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedLiteral(code, i) - 1;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    else if ((ch === ';' || ch === '\n') && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const stmt = code.slice(start, i).trim();
      if (stmt) statements.push(stmt);
      start = i + 1;
    }
  }
  const tail = code.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function findMatchingParenEnd(code: string, openParenIdx: number): number {
  let depth = 0;
  for (let i = openParenIdx; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedLiteral(code, i) - 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommaArgs(inner: string): string[] {
  const args: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedLiteral(inner, i) - 1;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail || args.length > 0) args.push(tail);
  return args;
}

function stripStringLiteralsForIdentifierCheck(expr: string): string {
  let out = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedLiteral(expr, i) - 1;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

function extractCopyDestinationExpressions(code: string): string[] | null {
  if (INLINE_NON_COPY_MUTATION_RE.test(code)) return null;

  const assignments = collectScriptVariableAssignments(code);
  const codeForCallScan = maskStringLiterals(code);

  const dstExpressions: string[] = [];
  let matchCount = 0;
  INLINE_COPY_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_COPY_CALL_RE.exec(codeForCallScan)) !== null) {
    matchCount++;
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParenEnd(code, openParenIdx);
    if (closeParenIdx < 0) return null;

    const inner = code.slice(openParenIdx + 1, closeParenIdx);
    const args = splitTopLevelCommaArgs(inner);
    if (args.length < 2) return null;
    if (args.some((a) => !a || a.startsWith('*') || a.startsWith('...'))) return null;

    let dstExpr: string | null = null;
    for (const arg of args) {
      const kwMatch = /^dst\s*=\s*([\s\S]+)$/.exec(arg);
      if (kwMatch) {
        dstExpr = kwMatch[1].trim();
        break;
      }
    }
    if (dstExpr === null) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(args[1])) return null;
      dstExpr = args[1];
    }

    // Transitively resolve simple variable references in dstExpr; bail out if any identifier
    // or interpolated string cannot be cleanly resolved.
    const queue = [dstExpr];
    const seenExprs = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seenExprs.has(cur)) continue;
      seenExprs.add(cur);
      dstExpressions.push(cur);

      // Bail out on Python f-strings or JS template interpolation inside destination expressions
      // so hidden interpolated paths cannot bypass conservative scanning.
      if (/\b[fF]['"]|`[^`]*\$\{/.test(cur)) return null;

      const stripped = stripStringLiteralsForIdentifierCheck(cur);
      const idRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
      let idMatch: RegExpExecArray | null;
      while ((idMatch = idRe.exec(stripped)) !== null) {
        const ident = idMatch[1];
        const bound = assignments.get(ident);
        if (bound && bound.length > 0) {
          for (const rhs of bound) {
            queue.push(rhs);
          }
          continue;
        }
        if (SAFE_COPY_DST_IDENTIFIERS.has(ident)) continue;
        return null;
      }
    }
  }

  return matchCount > 0 ? dstExpressions : null;
}

function extractAllInlineScriptPathCandidates(code: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push(trimmed);
  };

  // Extract string literals that denote absolute, home-relative, UNC, MSYS, or env-expanded paths.
  const literalRe = /(?:[rRuUbBfF]{0,2})'(?:\\.|[^'\\])*'|(?:[rRuUbBfF]{0,2})"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(code)) !== null) {
    const tok = m[0];
    const quoteIdx = tok.search(/['"`]/);
    if (quoteIdx < 0) continue;
    const isRaw = /[rR]/.test(tok.slice(0, quoteIdx));
    let inner = tok.slice(quoteIdx + 1, -1);
    if (!isRaw) {
      inner = inner.replace(/\\\\/g, '\\');
    }
    const candidate = inner.trim();
    if (!candidate) continue;
    const looksExternal =
      /^[A-Za-z]:[\\/]/.test(candidate) ||
      /^\\\\[^\\]/.test(candidate) ||
      /^~(?:$|[\\/])/.test(candidate) ||
      /^\/(?:[A-Za-z]\/|etc\/|tmp\/|var\/|usr\/|home\/|Users\/|root\/)/.test(candidate) ||
      /\$(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b/i.test(candidate) ||
      /%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA)%/i.test(candidate);
    if (looksExternal) {
      add(candidate);
    }
  }

  // Catch Path.home() / expanduser('~') / os.homedir() combined with file mutation calls even
  // when path segments are joined separately (e.g. Path.home() / '.papercup' / ...).
  if (INLINE_HOME_DIR_EXPR_RE.test(code)) {
    add('~');
  }
  return found;
}

function extractInlineScriptPathCandidates(code: string): string[] {
  const copyDstExprs = extractCopyDestinationExpressions(code);
  if (copyDstExprs !== null) {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const expr of copyDstExprs) {
      for (const candidate of extractAllInlineScriptPathCandidates(expr)) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          found.push(candidate);
        }
      }
    }
    return found;
  }
  return extractAllInlineScriptPathCandidates(code);
}

/**
 * Quote-aware shell parser extracting all heuristic write/delete/move targets from a bash command,
 * tracking variable assignments (`VAR=`, `export`/`declare`/`for`), `cd`/`pushd`/`Set-Location`,
 * brace expansions, subshells/command substitutions, nested shell wrappers, `find -delete/-exec`, and `xargs`.
 */
export function extractBashWriteTargets(command: string, cwd: string): ExtractedBashWriteTarget[] {
  if (!command || typeof command !== 'string' || !cwd) return [];
  const out: ExtractedBashWriteTarget[] = [];
  collectBashWriteTargets(command, path.resolve(cwd), new Map(), new Map(), out, 0);
  return out;
}

/**
 * Block bash commands that write, copy, move, delete, or redirect files outside the active workspace,
 * including writes/deletes/moves inside invoked local script files or inline interpreter code.
 * External patch exports must go through vn_writeback / vn_repack rather than raw bash.
 */
export function detectBlockedExternalWriteCommand(command: string, cwd: string): string | null {
  if (!command || typeof command !== 'string' || !cwd) return null;
  for (const target of extractBashWriteTargets(command, cwd)) {
    if (!isPathInsideWorkspace(target.resolved, cwd)) {
      return `Writing or mutating path "${target.raw}" outside active workspace via bash is prohibited. Keep temporary files inside .papercup/tmp/ and use vn_writeback / vn_repack for external patch output.`;
    }
  }
  const baseCwd = path.resolve(cwd);
  return visitShellCommandSegments(
    command,
    baseCwd,
    ({ cmdName, expandedArgs, effectiveCwd, inlineCode, scriptPath, scriptContent }) => {
      if (inlineCode && (cmdName === 'powershell' || cmdName === 'pwsh')) {
        const inlineHit = detectExternalWriteInScriptContent(inlineCode, baseCwd, effectiveCwd, cmdName, expandedArgs);
        if (inlineHit) return inlineHit;
      }
      if (scriptContent) {
        const fileHit = detectExternalWriteInScriptContent(
          scriptContent,
          baseCwd,
          effectiveCwd,
          scriptPath,
          expandedArgs
        );
        if (fileHit) return fileHit;
      }
      return null;
    }
  );
}

/**
 * Block launching game executables / batch launchers or killing/spawning host processes
 * via bash CLI, inline code, or invoked local workspace script files.
 */
export function detectBlockedProcessControlCommand(command: string, cwd?: string): string | null {
  if (!command || typeof command !== 'string') return null;
  return visitShellCommandSegments(command, cwd, ({ cmdTok, cmdName, args, inlineCode, scriptPath, scriptContent }) => {
    if (inlineCode) {
      const inlineHit = detectProcessControlInScriptContent(inlineCode, cmdName);
      if (inlineHit) return inlineHit;
    }
    if (scriptContent) {
      const fileHit = detectProcessControlInScriptContent(scriptContent, scriptPath);
      if (fileHit) return fileHit;
    }

    if (!cmdTok) return null;
    const base = cmdBasename(cmdTok);

    if (PROCESS_KILL_CMDS.has(cmdName)) {
      return `Terminating host processes via "${cmdTok}" is prohibited.`;
    }
    if (PROCESS_LAUNCH_CMDS.has(cmdName)) {
      return `Launching applications or GUI processes via "${cmdTok}" is prohibited. Use static analysis and deterministic checks instead.`;
    }
    if (cmdName === 'mklink') {
      return 'Launching executables, batch scripts, or mklink via bash is prohibited. Use static analysis and deterministic verification instead.';
    }

    if (cmdName === 'cmd') {
      const joined = args.join(' ');
      if (/\b(?:start|mklink)\b/i.test(joined)) {
        return 'Launching executables, batch scripts, or mklink via cmd is prohibited. Use static analysis and deterministic verification instead.';
      }
      const exeMatches = joined.match(/[^\s"';&|]+\.(?:bat|cmd|exe|msi|vbs)\b/gi) ?? [];
      for (const m of exeMatches) {
        const mBase = cmdBasename(m);
        if (/\.(?:bat|cmd|msi|vbs)$/i.test(mBase) || !SAFE_CLI_BASENAMES.has(mBase)) {
          return 'Launching executables, batch scripts, or mklink via cmd is prohibited. Use static analysis and deterministic verification instead.';
        }
      }
      return null;
    }

    if (/\.(?:exe|bat|cmd|msi|vbs)$/i.test(base) && !SAFE_CLI_BASENAMES.has(base)) {
      return `Executing "${cmdTok}" via bash is prohibited. Do not launch game executables or batch scripts directly.`;
    }

    return null;
  });
}

/**
 * Block bash heredocs (<<EOF / <<'EOF') which silently truncate under Windows Git Bash
 * and bypass workspace write tooling. Quote-aware so bit-shifts inside python -c "..." pass.
 */
export function detectBlockedBashHeredocCommand(command: string): string | null {
  if (!command || typeof command !== 'string' || !command.includes('<<')) return null;
  let quote: '"' | "'" | null = null;
  const n = command.length;
  for (let i = 0; i < n; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < n) i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '<' && i + 1 < n && command[i + 1] === '<') {
      if (i + 2 < n && command[i + 2] === '<') {
        i += 2; // skip <<< here-string
        continue;
      }
      const tail = command.slice(i + 2);
      if (/^-?\s*(?:'[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)/.test(tail)) {
        return 'Bash heredocs (<<EOF) are prohibited on Windows/Git Bash because they can silently truncate. Use the write/edit tool to create a script under .papercup/tmp/ and run it with python.';
      }
      i++;
    }
  }
  return null;
}

const SECRET_ENV_VAR_PRINT_RE =
  /(?:\$\{?env:|\$(?:\{!?)?|%)(?:[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\}?/i;

function detectSecretCommandInCommand(
  command: string,
  baseCwd: string,
  parentVars: Map<string, string>,
  parentLoopVars: Map<string, string[]>,
  depth: number
): string | null {
  if (depth > MAX_SHELL_RECURSION_DEPTH) return null;

  if (/[.~/\\$%].*\.papercup[\\/]+(?:config\.toml|auth\.json|credentials|translator\.json)/i.test(command)) {
    return 'Access to global .papercup credential configuration is prohibited.';
  }
  if (/(?:~|\$HOME|%USERPROFILE%|\$\{HOME\}|\$\{USERPROFILE\})[\\/]+(?:\.pi|\.ssh|\.aws|\.gnupg)\b/i.test(command)) {
    return 'Access to credential directories (.pi/.ssh/.aws/.gnupg) is prohibited.';
  }
  if (/(?:^|[\s"'=/\\<>])\.env(?:\.[a-z0-9_-]+)?(?=$|[\s"';&|<>])/i.test(command)) {
    const envMatches = command.match(/(?:^|[\s"'=/\\<>])(\.env(?:\.[a-z0-9_-]+)?)(?=$|[\s"';&|<>])/gi) ?? [];
    for (const m of envMatches) {
      const cleaned = m.replace(/^[\s"'=/\\<>]+/, '').toLowerCase();
      if (!SAFE_ENV_TEMPLATE_NAMES.has(cleaned)) {
        return `Access to ${cleaned} is prohibited.`;
      }
    }
  }
  if (SECRET_ENV_VAR_PRINT_RE.test(command)) {
    return 'Printing secret environment variables is prohibited.';
  }
  if (/\[(?:System\.)?Environment\]::GetEnvironmentVariables/i.test(command)) {
    return 'Dumping process environment variables is prohibited.';
  }

  const vars = new Map(parentVars);
  const loopVars = new Map(parentLoopVars);
  let effectiveCwd = baseCwd;

  const checkPathCandidate = (rawCandidate: string): string | null => {
    const stripped = rawCandidate.replace(/^['"]|['"]$/g, '').replace(/^[<>]+/, '').trim();
    if (!stripped) return null;
    const candidates = expandTrackedShellVarsMulti(stripped, vars, loopVars).flatMap((v) => expandBraceTargets(v));
    for (const cand of candidates) {
      if (isRestrictedSecretPath(cand, effectiveCwd)) {
        return `Access to restricted credential path "${stripped}" is prohibited.`;
      }
    }
    return null;
  };

  const segments = splitShellSegments(command);
  for (const { text: rawSeg } of segments) {
    const seg = rawSeg.trim();
    if (!seg || seg.startsWith('#')) continue;

    for (const inner of extractEmbeddedShellCommands(seg)) {
      const hit = detectSecretCommandInCommand(inner, effectiveCwd, vars, loopVars, depth + 1);
      if (hit) return hit;
    }

    const { targets: redirTargets, stripped: cleanSeg } = extractShellRedirectionTargets(seg);
    for (const target of redirTargets) {
      const hit = checkPathCandidate(target);
      if (hit) return hit;
    }

    const segTokens = tokenizeShellSegment(cleanSeg);
    const parsed = unwrapSegmentTokens(segTokens, vars);
    if (!parsed) continue;

    for (const extra of parsed.extraNestedCommands) {
      const hit = detectSecretCommandInCommand(extra, effectiveCwd, vars, loopVars, depth + 1);
      if (hit) return hit;
    }

    const { cmdName, args, isEnvDump } = parsed;

    // 1. Structural environment dump checks
    if (cmdName === 'printenv' || isEnvDump) {
      return 'Dumping process environment variables is prohibited.';
    }
    if (cmdName === 'set' && args.length === 0) {
      return 'Dumping process environment variables is prohibited.';
    }
    if (cmdName === 'export') {
      const hasPrintFlag = args.some((a) => a === '-p' || a === '--print');
      const hasNonFlag = args.some((a) => !a.startsWith('-'));
      if (args.length === 0 || hasPrintFlag || !hasNonFlag) {
        return 'Dumping process environment variables is prohibited.';
      }
    }
    if (cmdName === 'declare' || cmdName === 'typeset') {
      const hasPrintFlag = args.some((a) => /^-[A-Za-z]*p/.test(a));
      const hasNonFlag = args.some((a) => !a.startsWith('-'));
      if (args.length === 0 || hasPrintFlag || !hasNonFlag) {
        return 'Dumping process environment variables is prohibited.';
      }
    }
    if (
      (cmdName === 'get-childitem' || cmdName === 'gci' || cmdName === 'dir' || cmdName === 'ls' || cmdName === 'get-item' || cmdName === 'gi') &&
      args.some((a) => /^env:/i.test(a))
    ) {
      return 'Dumping process environment variables is prohibited.';
    }

    // Track variable declarations and `for` loop values
    if (VAR_DECL_CMDS.has(cmdName)) {
      for (const a of args) {
        const assign = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (assign) {
          vars.set(assign[1], expandTrackedShellVars(assign[2], vars));
        }
      }
    } else if (cmdName === 'for' && args.length >= 3 && args[1].toLowerCase() === 'in') {
      const vals = args
        .slice(2)
        .flatMap((v) => expandTrackedShellVarsMulti(v, vars, loopVars))
        .flatMap((v) => expandBraceTargets(v));
      if (vals.length) loopVars.set(args[0], vals);
    } else if (cmdName === 'done') {
      loopVars.clear();
    }

    const nestedWrapper = extractNestedShellWrapperCommand(cmdName, args);
    if (nestedWrapper) {
      const hit = detectSecretCommandInCommand(nestedWrapper, effectiveCwd, vars, loopVars, depth + 1);
      if (hit) return hit;
    }

    if (cmdName === 'cd' || cmdName === 'pushd' || cmdName === 'set-location') {
      const targetArg = args.find((a) => !isShellFlag(a));
      if (targetArg) {
        const expanded = expandTrackedShellVars(targetArg, vars);
        effectiveCwd = normalizeShellPath(expanded, effectiveCwd);
      }
    }

    // 2. Scan path-like tokens (including `--flag=path`, `<path`, and expanded vars)
    for (const tok of segTokens) {
      const stripped = tok.replace(/^['"]|['"]$/g, '');
      if (!stripped) continue;
      if (stripped.startsWith('-')) {
        const eq = stripped.indexOf('=');
        if (eq > 0) {
          const hit = checkPathCandidate(stripped.slice(eq + 1));
          if (hit) return hit;
        }
        continue;
      }
      const eq = stripped.indexOf('=');
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(stripped)) {
        const hit = checkPathCandidate(stripped.slice(eq + 1));
        if (hit) return hit;
      }
      const hit = checkPathCandidate(stripped);
      if (hit) return hit;
      // Handle unspaced redirection like `cat</c/Users/alice/.aws/credentials`
      const ltIdx = stripped.indexOf('<');
      if (ltIdx >= 0 && ltIdx + 1 < stripped.length) {
        const redirHit = checkPathCandidate(stripped.slice(ltIdx + 1));
        if (redirHit) return redirHit;
      }
    }
  }

  return null;
}

export function detectBlockedSecretCommand(command: string, cwd: string): string | null {
  if (!command || typeof command !== 'string') return null;
  const baseCwd = cwd ? path.resolve(cwd) : process.cwd();
  return detectSecretCommandInCommand(command, baseCwd, new Map(), new Map(), 0);
}

export function collectKnownSecretValues(extraSecrets?: Iterable<string>): string[] {
  const values = new Set<string>();
  if (extraSecrets) {
    for (const s of extraSecrets) {
      if (typeof s === 'string' && s.trim().length >= 6) {
        values.add(s.trim());
      }
    }
  }
  for (const [key, val] of Object.entries(process.env)) {
    if (!val || val.trim().length < 6) continue;
    if (/(?:API_KEY|SECRET|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|BEARER)$/i.test(key)) {
      values.add(val.trim());
    }
  }
  return Array.from(values).sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, knownSecrets?: Iterable<string>): string {
  if (!text) return text;
  let out = text;

  const secrets = collectKnownSecretValues(knownSecrets);
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }

  out = out
    .replace(/\bAIza[0-9A-Za-z_-]{16,}/g, '[REDACTED]')
    .replace(/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bgsk_[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bms-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*["']?)([^\s"'\r\n,;}{]{6,})(["']?)/gi,
      (full, prefix, val, suffix) => {
        if (val.startsWith('$') || val === '[REDACTED]') return full;
        return `${prefix}[REDACTED]${suffix}`;
      }
    );

  return out;
}

export function redactUnknownValue<T>(value: T, knownSecrets?: Iterable<string>, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') {
    return redactSecrets(value, knownSecrets) as unknown as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknownValue(item, knownSecrets, seen)) as unknown as T;
  }

  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    copy[k] = redactUnknownValue(v, knownSecrets, seen);
  }
  return copy as T;
}
