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

function resolvePython(): string {
  // ワークスペース内の仮想環境を確認
  const venvPython = process.platform === 'win32'
    ? path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
    : path.join(process.cwd(), '.venv', 'bin', 'python');

  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python';
}

function resolveBash(): string | undefined {
  if (process.platform !== 'win32') {
    return process.env.SHELL || undefined;
  }

  // 1. 環境変数による明示的指定
  if (process.env.PAPERCUP_SHELL && fs.existsSync(process.env.PAPERCUP_SHELL)) {
    return process.env.PAPERCUP_SHELL;
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL) && !process.env.SHELL.toLowerCase().includes('system32')) {
    return process.env.SHELL;
  }

  // 2. Windows 環境下の Git Bash 候補パス（C/D/E ドライブ）
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    'D:\\Git\\bin\\bash.exe',
    'E:\\Git\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
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
