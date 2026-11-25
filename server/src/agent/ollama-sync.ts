/**
 * Local Ollama concurrency & performance synchronization utility.
 * Pure Node.js standard library implementation: detects loopback Ollama instances,
 * injects OLLAMA_NUM_PARALLEL alongside default optimization flags
 * (OLLAMA_FLASH_ATTENTION=1, OLLAMA_KV_CACHE_TYPE=q8_0, OLLAMA_CONTEXT_LENGTH=2048)
 * exclusively into the Paper Cup-managed child process environment (without mutating
 * user-level OS registry variables), restarts the local Ollama process on demand,
 * and polls readiness so settings take effect immediately.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pickPreferredLocalModel } from './local-translator.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_OLLAMA_OPTIMIZATION_ENV = {
  OLLAMA_FLASH_ATTENTION: '1',
  OLLAMA_KV_CACHE_TYPE: 'q8_0',
  OLLAMA_CONTEXT_LENGTH: '2048',
} as const;

export interface OllamaSyncOptimizations {
  flashAttention: boolean;
  kvCacheType: string;
  contextLength: number;
}

export interface OllamaSyncResult {
  attempted: boolean;
  synced: boolean;
  status: 'started' | 'restarted' | 'already_running' | 'skipped' | 'failed';
  concurrency: number;
  origin?: string;
  version?: string;
  reason?: string;
  managedByPaperCup?: boolean;
  binaryPath?: string;
  optimizations?: OllamaSyncOptimizations;
  syncSeq?: number;
  message: string;
}

export interface OllamaSyncInput {
  baseUrl: string;
  concurrency: number;
  ollamaPath?: string;
  forceRestart?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type OllamaSyncFn = (input: OllamaSyncInput) => Promise<OllamaSyncResult>;

export interface OllamaOriginDetection {
  isOllama: boolean;
  origin?: string;
  version?: string;
  reason?: string;
  running?: boolean;
  reachable?: boolean;
}

export interface OllamaBinaryInspection {
  binaryPath: string | null;
  source: 'custom' | 'auto' | 'none';
  invalidCustomPath?: boolean;
}

export interface OllamaStatusResult {
  isLocalTarget: boolean;
  running: boolean;
  origin?: string;
  version?: string;
  binaryPath: string | null;
  binarySource: 'custom' | 'auto' | 'none';
  invalidCustomPath?: boolean;
  models: Array<{ id: string; name: string }>;
  suggestedModel: string | null;
  managedByPaperCup: boolean;
  lastSyncedConcurrency?: number;
  optimizations?: OllamaSyncOptimizations;
  reason?: string;
}

let lastManagedState: {
  origin: string;
  concurrency: number;
  version?: string;
  updatedAt: number;
} | null = null;

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1' || lower === '[::1]';
}

export function isLocalOllamaCandidate(rawBaseUrl: string): boolean {
  const trimmed = String(rawBaseUrl || '').trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isLoopbackHostname(parsed.hostname) && parsed.port === '11434';
  } catch {
    return false;
  }
}

function isRegularFileSafe(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function inspectOllamaBinary(customPath?: string): OllamaBinaryInspection {
  const rawCustom = typeof customPath === 'string' ? customPath.trim().replace(/^"(.*)"$/, '$1').trim() : '';
  if (rawCustom) {
    try {
      const resolved = path.resolve(rawCustom);
      if (fs.existsSync(resolved)) {
        const st = fs.statSync(resolved);
        if (st.isDirectory()) {
          const exeName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
          const cand = path.join(resolved, exeName);
          if (isRegularFileSafe(cand)) {
            return { binaryPath: cand, source: 'custom' };
          }
          return { binaryPath: null, source: 'none', invalidCustomPath: true };
        }
        if (st.isFile()) {
          if (process.platform === 'win32' && path.basename(resolved).toLowerCase() === 'ollama app.exe') {
            const siblingCli = path.join(path.dirname(resolved), 'ollama.exe');
            if (isRegularFileSafe(siblingCli)) {
              return { binaryPath: siblingCli, source: 'custom' };
            }
          }
          return { binaryPath: resolved, source: 'custom' };
        }
      }
    } catch {
      // Fall through to invalid custom path
    }
    return { binaryPath: null, source: 'none', invalidCustomPath: true };
  }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
      process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe')
        : '',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : '',
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (isRegularFileSafe(candidate)) {
        return { binaryPath: candidate, source: 'auto' };
      }
    }
    try {
      const out = execFileSync('where.exe', ['ollama'], { encoding: 'utf8', windowsHide: true });
      const firstLine = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && isRegularFileSafe(line));
      if (firstLine) return { binaryPath: firstLine, source: 'auto' };
    } catch {
      return { binaryPath: null, source: 'none' };
    }
    return { binaryPath: null, source: 'none' };
  }

  try {
    const found = execFileSync('which', ['ollama'], { encoding: 'utf8' }).trim();
    if (found && isRegularFileSafe(found)) {
      return { binaryPath: found, source: 'auto' };
    }
  } catch {
    // Fallback to well-known locations
  }
  for (const candidate of ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama']) {
    if (isRegularFileSafe(candidate)) {
      return { binaryPath: candidate, source: 'auto' };
    }
  }
  return { binaryPath: null, source: 'none' };
}

export function resolveOllamaBinary(customPath?: string): string | null {
  return inspectOllamaBinary(customPath).binaryPath;
}

export async function detectLocalOllamaOrigin(
  rawBaseUrl: string,
  fetchImpl?: typeof fetch,
  customOllamaPath?: string
): Promise<OllamaOriginDetection> {
  const trimmed = String(rawBaseUrl || '').trim();
  if (!trimmed) {
    return { isOllama: false, reason: 'empty_url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { isOllama: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { isOllama: false, reason: 'invalid_protocol' };
  }

  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!isLoopbackHostname(parsed.hostname)) {
    return { isOllama: false, origin, reason: 'remote_endpoint' };
  }

  const fetchFn = fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchFn(`${origin}/api/version`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { isOllama: false, origin, reason: 'not_ollama', reachable: true };
    }
    const data: any = await res.json().catch(() => null);
    const version = typeof data?.version === 'string' ? data.version.trim() : '';
    if (!version) {
      return { isOllama: false, origin, reason: 'not_ollama', reachable: true };
    }
    return { isOllama: true, origin, version, running: true, reachable: true };
  } catch {
    if (parsed.port === '11434' && resolveOllamaBinary(customOllamaPath) !== null) {
      return { isOllama: true, origin, running: false, reachable: false };
    }
    return { isOllama: false, origin, reason: 'not_ollama', reachable: false };
  }
}

export async function getLocalOllamaStatus(input: {
  baseUrl: string;
  ollamaPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<OllamaStatusResult> {
  const inspection = inspectOllamaBinary(input.ollamaPath);
  const trimmed = String(input.baseUrl || '').trim();
  const baseFields = {
    binaryPath: inspection.binaryPath,
    binarySource: inspection.source,
    ...(inspection.invalidCustomPath ? { invalidCustomPath: true } : {}),
  };

  if (!trimmed) {
    return {
      isLocalTarget: false,
      running: false,
      ...baseFields,
      models: [],
      suggestedModel: null,
      managedByPaperCup: false,
      reason: 'empty_url',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      isLocalTarget: false,
      running: false,
      ...baseFields,
      models: [],
      suggestedModel: null,
      managedByPaperCup: false,
      reason: 'invalid_url',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      isLocalTarget: false,
      running: false,
      ...baseFields,
      models: [],
      suggestedModel: null,
      managedByPaperCup: false,
      reason: 'invalid_protocol',
    };
  }

  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!isLoopbackHostname(parsed.hostname)) {
    return {
      isLocalTarget: false,
      running: false,
      origin,
      ...baseFields,
      models: [],
      suggestedModel: null,
      managedByPaperCup: false,
      reason: 'remote_endpoint',
    };
  }

  const fetchFn = input.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchFn(`${origin}/api/version`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return {
        isLocalTarget: false,
        running: false,
        origin,
        ...baseFields,
        models: [],
        suggestedModel: null,
        managedByPaperCup: false,
        reason: 'not_ollama',
      };
    }
    const data: any = await res.json().catch(() => null);
    const version = typeof data?.version === 'string' ? data.version.trim() : '';
    if (!version) {
      return {
        isLocalTarget: false,
        running: false,
        origin,
        ...baseFields,
        models: [],
        suggestedModel: null,
        managedByPaperCup: false,
        reason: 'not_ollama',
      };
    }

    const models: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    try {
      const tagsRes = await fetchFn(`${origin}/api/tags`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2000),
      });
      if (tagsRes.ok) {
        const tagsPayload: any = await tagsRes.json().catch(() => null);
        const list = Array.isArray(tagsPayload?.models) ? tagsPayload.models : [];
        for (const item of list) {
          const id =
            typeof item?.name === 'string' && item.name.trim()
              ? item.name.trim()
              : typeof item?.model === 'string' && item.model.trim()
                ? item.model.trim()
                : typeof item?.id === 'string' && item.id.trim()
                  ? item.id.trim()
                  : '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          models.push({ id, name: id });
        }
      }
    } catch {
      // Ignore /api/tags hiccup; version already confirmed running
    }

    const managed = lastManagedState?.origin === origin;
    return {
      isLocalTarget: true,
      running: true,
      origin,
      version,
      ...baseFields,
      models,
      suggestedModel: pickPreferredLocalModel(models),
      managedByPaperCup: managed,
      ...(managed && lastManagedState
        ? {
            lastSyncedConcurrency: lastManagedState.concurrency,
            optimizations: {
              flashAttention: true,
              kvCacheType: DEFAULT_OLLAMA_OPTIMIZATION_ENV.OLLAMA_KV_CACHE_TYPE,
              contextLength: Number(DEFAULT_OLLAMA_OPTIMIZATION_ENV.OLLAMA_CONTEXT_LENGTH),
            },
          }
        : {}),
    };
  } catch {
    const isCandidate = parsed.port === '11434';
    return {
      isLocalTarget: isCandidate,
      running: false,
      origin,
      ...baseFields,
      models: [],
      suggestedModel: null,
      managedByPaperCup: false,
      reason: isCandidate
        ? inspection.invalidCustomPath
          ? 'invalid_custom_path'
          : inspection.binaryPath
            ? 'not_running'
            : 'binary_not_found'
        : 'not_ollama',
    };
  }
}

function clampConcurrency(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(8, Math.round(raw)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeNoProxy(existing?: string | null): string {
  const base = (existing || '').trim();
  if (!base) return 'localhost,127.0.0.1,::1';
  if (base.includes('127.0.0.1')) return base;
  return `${base},localhost,127.0.0.1,::1`;
}

export function buildOllamaSpawnEnv(options: {
  origin: string;
  concurrency: number;
  baseEnv?: NodeJS.ProcessEnv;
  modelsDir?: string;
  noProxy?: string;
}): NodeJS.ProcessEnv {
  const base = options.baseEnv ?? process.env;
  const clamped = clampConcurrency(options.concurrency);
  return {
    ...base,
    ...(options.modelsDir ? { OLLAMA_MODELS: options.modelsDir } : {}),
    OLLAMA_HOST: options.origin,
    OLLAMA_NUM_PARALLEL: String(clamped),
    ...DEFAULT_OLLAMA_OPTIMIZATION_ENV,
    NO_PROXY: mergeNoProxy(options.noProxy ?? base.NO_PROXY),
  };
}

export function buildWindowsOllamaReadEnvScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$models = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")',
    '$noProxy = [Environment]::GetEnvironmentVariable("NO_PROXY", "User")',
    'Write-Output (ConvertTo-Json @{ models = $models; noProxy = $noProxy } -Compress)',
  ].join('; ');
}

/**
 * @deprecated Paper Cup no longer mutates Windows User-level registry variables
 * (OLLAMA_NUM_PARALLEL / OLLAMA_CONTEXT_LENGTH / etc.) so other local apps are unaffected.
 * Optimization flags are passed exclusively via `buildOllamaSpawnEnv` to the managed child process.
 * Kept as a read-only compatibility alias returning `buildWindowsOllamaReadEnvScript()`.
 */
export function buildWindowsOllamaPersistScript(): string {
  return buildWindowsOllamaReadEnvScript();
}

async function readWindowsOllamaEnv(): Promise<{ modelsDir?: string; noProxy?: string }> {
  const psScript = buildWindowsOllamaReadEnvScript();

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        windowsHide: true,
        timeout: 4000,
      }
    );
    const parsed = JSON.parse(stdout.trim() || '{}');
    return {
      ...(typeof parsed?.models === 'string' && parsed.models.trim()
        ? { modelsDir: parsed.models.trim() }
        : {}),
      ...(typeof parsed?.noProxy === 'string' && parsed.noProxy.trim()
        ? { noProxy: parsed.noProxy.trim() }
        : {}),
    };
  } catch {
    return {
      ...(process.env.OLLAMA_MODELS?.trim() ? { modelsDir: process.env.OLLAMA_MODELS.trim() } : {}),
      ...(process.env.NO_PROXY?.trim() ? { noProxy: process.env.NO_PROXY.trim() } : {}),
    };
  }
}

async function forceStopExistingOllama(): Promise<void> {
  if (process.platform === 'win32') {
    for (const imageName of ['ollama app.exe', 'ollama.exe']) {
      try {
        await execFileAsync('taskkill.exe', ['/F', '/T', '/IM', imageName], {
          windowsHide: true,
          timeout: 4000,
        });
      } catch {
        // Ignore when target process is not running
      }
    }
    return;
  }

  try {
    await execFileAsync('pkill', ['-x', 'ollama'], { timeout: 4000 });
  } catch {
    // Ignore when target process is not running
  }
}

export async function syncLocalOllamaConcurrency(input: OllamaSyncInput): Promise<OllamaSyncResult> {
  const concurrency = clampConcurrency(input.concurrency);
  const forceRestart = input.forceRestart !== false;
  const inspection = inspectOllamaBinary(input.ollamaPath);
  const detection = await detectLocalOllamaOrigin(input.baseUrl, input.fetchImpl, input.ollamaPath);

  if (!detection.isOllama || !detection.origin) {
    if (isLocalOllamaCandidate(input.baseUrl) && detection.reachable === false && !inspection.binaryPath) {
      return {
        attempted: true,
        synced: false,
        status: 'failed',
        concurrency,
        ...(detection.origin ? { origin: detection.origin } : {}),
        reason: inspection.invalidCustomPath ? 'invalid_custom_path' : 'binary_not_found',
        message: inspection.invalidCustomPath
          ? '指定的 Ollama 程序路径无效，请重新选择 ollama.exe 或留空以自动检测。'
          : '未在本机找到 ollama 可执行文件，请先安装 Ollama 或点击「浏览…」手动选择 ollama.exe 路径。',
      };
    }
    return {
      attempted: false,
      synced: false,
      status: 'skipped',
      concurrency,
      ...(detection.origin ? { origin: detection.origin } : {}),
      reason: detection.reason || 'not_ollama',
      message: '',
    };
  }

  const origin = detection.origin;
  const wasRunning = Boolean(detection.running);

  if (!forceRestart && wasRunning) {
    const managed = lastManagedState?.origin === origin;
    return {
      attempted: false,
      synced: true,
      status: 'already_running',
      concurrency,
      origin,
      ...(detection.version ? { version: detection.version } : {}),
      managedByPaperCup: managed,
      ...(inspection.binaryPath ? { binaryPath: inspection.binaryPath } : {}),
      message: '本机 Ollama 已在运行。',
    };
  }

  const ollamaBin = inspection.binaryPath;
  if (!ollamaBin) {
    return {
      attempted: true,
      synced: false,
      status: 'failed',
      concurrency,
      origin,
      reason: inspection.invalidCustomPath ? 'invalid_custom_path' : 'binary_not_found',
      message: inspection.invalidCustomPath
        ? '指定的 Ollama 程序路径无效，请重新选择 ollama.exe 或留空以自动检测。'
        : '未在本机找到 ollama 可执行文件，无法自动启动或同步并发。',
    };
  }

  let persistedModelsDir: string | undefined;
  let persistedNoProxy: string | undefined;

  if (process.platform === 'win32') {
    const envMeta = await readWindowsOllamaEnv();
    persistedModelsDir = envMeta.modelsDir;
    persistedNoProxy = envMeta.noProxy;
  }

  if (forceRestart || wasRunning) {
    await forceStopExistingOllama();
    await sleep(450);
  }

  const spawnEnv = buildOllamaSpawnEnv({
    origin,
    concurrency,
    modelsDir: persistedModelsDir,
    noProxy: persistedNoProxy,
  });

  let spawnErrorMsg = '';
  try {
    const child = spawn(ollamaBin, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: spawnEnv,
    });
    child.once('error', (err) => {
      spawnErrorMsg = String(err?.message || err);
    });
    child.unref();
  } catch (err: any) {
    return {
      attempted: true,
      synced: false,
      status: 'failed',
      concurrency,
      origin,
      reason: 'spawn_failed',
      message: `启动 Ollama 进程失败：${String(err?.message || err)}`,
    };
  }

  const fetchFn = input.fetchImpl ?? globalThis.fetch;
  const deadline = Date.now() + Math.max(2000, input.timeoutMs ?? 25_000);
  while (Date.now() < deadline) {
    if (spawnErrorMsg) {
      return {
        attempted: true,
        synced: false,
        status: 'failed',
        concurrency,
        origin,
        reason: 'spawn_failed',
        message: `启动 Ollama 服务出错：${spawnErrorMsg}`,
      };
    }
    try {
      const res = await fetchFn(`${origin}/api/version`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        const version = typeof data?.version === 'string' && data.version.trim() ? data.version.trim() : undefined;
        lastManagedState = {
          origin,
          concurrency,
          ...(version ? { version } : {}),
          updatedAt: Date.now(),
        };
        return {
          attempted: true,
          synced: true,
          status: wasRunning ? 'restarted' : 'started',
          concurrency,
          origin,
          ...(version ? { version } : {}),
          managedByPaperCup: true,
          binaryPath: ollamaBin,
          optimizations: {
            flashAttention: true,
            kvCacheType: DEFAULT_OLLAMA_OPTIMIZATION_ENV.OLLAMA_KV_CACHE_TYPE,
            contextLength: Number(DEFAULT_OLLAMA_OPTIMIZATION_ENV.OLLAMA_CONTEXT_LENGTH),
          },
          message: wasRunning
            ? `本机 Ollama 已在后台完成重启（原终端窗口已退出并由 Paper Cup 接管运行），并发=${concurrency}（FA=1 / KV=q8_0 / CTX=2048）已生效。`
            : `本机 Ollama 已在后台自动启动（由 Paper Cup 托管运行），并发=${concurrency}（FA=1 / KV=q8_0 / CTX=2048）已生效。`,
        };
      }
    } catch {
      // Wait for server socket to bind
    }
    await sleep(350);
  }

  return {
    attempted: true,
    synced: false,
    status: 'failed',
    concurrency,
    origin,
    reason: 'restart_timeout',
    message: `Ollama 启动后在规定时间内未响应 (${origin})，请检查本机服务日志或 Ollama 路径。`,
  };
}

export async function ensureLocalOllamaRunning(input: OllamaSyncInput): Promise<OllamaSyncResult> {
  return syncLocalOllamaConcurrency({
    ...input,
    forceRestart: false,
  });
}
