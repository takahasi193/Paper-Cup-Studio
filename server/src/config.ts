import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export interface ServerConfig {
  port: number;
  host: string;
  defaultWorkspace: string;
  configDir: string;
  pythonPath: string;
  bashPath?: string;
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findExecutableInPath(names: string[]): string | undefined {
  const rawPath = process.env.PATH || process.env.Path || '';
  if (!rawPath) return undefined;
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isRegularFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolvePython(): string {
  // 1. Check workspace virtual environment
  const venvCandidates =
    process.platform === 'win32'
      ? [path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')]
      : [
          path.join(process.cwd(), '.venv', 'bin', 'python3'),
          path.join(process.cwd(), '.venv', 'bin', 'python'),
        ];

  for (const venvPython of venvCandidates) {
    if (isRegularFile(venvPython)) {
      return venvPython;
    }
  }

  // 2. Non-Windows: prefer python3 when available on PATH
  if (process.platform !== 'win32') {
    if (findExecutableInPath(['python3'])) {
      return 'python3';
    }
    if (findExecutableInPath(['python'])) {
      return 'python';
    }
    return 'python3';
  }

  return 'python';
}

function isUsableWindowsBash(filePath: string): boolean {
  const low = filePath.toLowerCase();
  if (low.includes('\\system32\\') || low.includes('/system32/') || low.includes('\\windowsapps\\')) {
    return false;
  }
  return isRegularFile(filePath);
}

function runWhereWindows(binary: string): string[] {
  try {
    const out = execFileSync('where.exe', [binary], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function deriveGitBashFromGitExe(gitExe: string): string | undefined {
  const roots = new Set<string>();
  const addAncestors = (p: string) => {
    let dir = path.dirname(p);
    for (let i = 0; i < 3; i++) {
      roots.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  };
  addAncestors(gitExe);
  try {
    addAncestors(fs.realpathSync.native(gitExe));
  } catch {
    // ignore realpath error
  }

  for (const root of roots) {
    const candidates = [
      path.join(root, 'bin', 'bash.exe'),
      path.join(root, 'usr', 'bin', 'bash.exe'),
      // Scoop shim layout: <scoopRoot>/shims/git.exe -> <scoopRoot>/apps/git/current/bin/bash.exe
      path.join(root, 'apps', 'git', 'current', 'bin', 'bash.exe'),
    ];
    for (const cand of candidates) {
      if (isUsableWindowsBash(cand)) {
        return cand;
      }
    }
  }
  return undefined;
}

function resolveBash(): string | undefined {
  if (process.platform !== 'win32') {
    return process.env.SHELL || undefined;
  }

  // 1. Explicit environment variable overrides
  if (process.env.PAPERCUP_SHELL && isRegularFile(process.env.PAPERCUP_SHELL)) {
    return process.env.PAPERCUP_SHELL;
  }
  if (process.env.SHELL && isUsableWindowsBash(process.env.SHELL)) {
    return process.env.SHELL;
  }

  // 2. Dynamically locate Git Bash via `where.exe git` (handles Scoop, portable, custom drives)
  for (const gitExe of runWhereWindows('git')) {
    const derived = deriveGitBashFromGitExe(gitExe);
    if (derived) return derived;
  }

  // 3. Check `where.exe bash` excluding WSL/Store stubs
  for (const bashExe of runWhereWindows('bash')) {
    if (isUsableWindowsBash(bashExe)) {
      return bashExe;
    }
  }

  // 4. Standard OS / package-manager install paths
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
    ...(process.env.SCOOP ? [path.join(process.env.SCOOP, 'apps', 'git', 'current', 'bin', 'bash.exe')] : []),
    ...(process.env.USERPROFILE
      ? [path.join(process.env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe')]
      : []),
    ...(process.env.ChocolateyInstall
      ? [path.join(process.env.ChocolateyInstall, 'lib', 'git', 'tools', 'bin', 'bash.exe')]
      : []),
  ];

  for (const candidate of candidates) {
    if (isUsableWindowsBash(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolvePapercupConfigDir(): string {
  const homeRoot = process.env.USERPROFILE || process.env.HOME;
  return homeRoot ? path.join(homeRoot, '.papercup') : config.configDir;
}

const homeDir = os.homedir();
const defaultDir = path.join(homeDir, '.papercup');

export const config: ServerConfig = {
  port: Number(process.env.PORT || 3100),
  host: process.env.HOST || '127.0.0.1',
  defaultWorkspace: process.cwd(),
  configDir: defaultDir,
  pythonPath: process.env.PAPERCUP_PYTHON || resolvePython(),
  bashPath: resolveBash(),
};
