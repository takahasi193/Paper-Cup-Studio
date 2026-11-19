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
      roots.add(path.resolve(candidate.trim()));
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

export function isRestrictedSecretPath(rawPath: string, cwd: string): boolean {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed) return false;

  const expanded = expandHomeVariables(trimmed);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(cwd, expanded);
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

    if (isInsideDir(resolved, piDir) || isInsideDir(resolved, sshDir) || isInsideDir(resolved, awsDir) || isInsideDir(resolved, gnupgDir)) {
      return true;
    }

    if (isInsideDir(resolved, papercupDir)) {
      if (SECRET_FILE_BASENAMES.has(base) || base.startsWith('credentials')) {
        return true;
      }
    }

    if (
      normResolved === normalizeForCompare(path.join(homeRoot, '.netrc')) ||
      normResolved === normalizeForCompare(path.join(homeRoot, '.npmrc'))
    ) {
      return true;
    }
  }

  return false;
}

export function detectBlockedSecretCommand(command: string, cwd: string): string | null {
  if (!command || typeof command !== 'string') return null;

  if (/[.~/\\$%].*\.papercup[\\/]+(?:config\.toml|auth\.json|credentials)/i.test(command)) {
    return 'Access to global .papercup credential configuration is prohibited.';
  }
  if (/(?:~|\$HOME|%USERPROFILE%|\$\{HOME\}|\$\{USERPROFILE\})[\\/]+(?:\.pi|\.ssh|\.aws|\.gnupg)\b/i.test(command)) {
    return 'Access to credential directories (.pi/.ssh/.aws/.gnupg) is prohibited.';
  }
  if (/(?:^|[\s"'=/\\])\.env(?:\.[a-z0-9_-]+)?(?=$|[\s"';&|])/i.test(command)) {
    const envMatches = command.match(/(?:^|[\s"'=/\\])(\.env(?:\.[a-z0-9_-]+)?)(?=$|[\s"';&|])/gi) ?? [];
    for (const m of envMatches) {
      const cleaned = m.replace(/^[\s"'=/\\]+/, '').toLowerCase();
      if (!SAFE_ENV_TEMPLATE_NAMES.has(cleaned)) {
        return `Access to ${cleaned} is prohibited.`;
      }
    }
  }
  if (/(?:^|[;&|]\s*)(?:printenv|set\s*$|env\s*(?:$|[|>;])|Get-ChildItem\s+Env:|dir\s+env:|ls\s+env:)/im.test(command)) {
    return 'Dumping process environment variables is prohibited.';
  }
  if (/(?:\$env:|\$|%)(?:[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)/i.test(command)) {
    return 'Printing secret environment variables is prohibited.';
  }

  // Also scan path-like tokens inside the command
  const tokens = command.match(/(?:"[^"]+"|'[^']+'|\S+)/g) ?? [];
  for (const token of tokens) {
    const stripped = token.replace(/^['"]|['"]$/g, '');
    if (!stripped || stripped.startsWith('-')) continue;
    if (isRestrictedSecretPath(stripped, cwd)) {
      return `Access to restricted credential path "${stripped}" is prohibited.`;
    }
  }

  return null;
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
    .replace(/\bms-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}/g, '[REDACTED]')
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
