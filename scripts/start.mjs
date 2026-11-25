#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT_DIR, 'server');
const WEB_DIR = path.join(ROOT_DIR, 'web');

export function readAppVersion(rootDir = ROOT_DIR) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback if root package.json is unavailable
  }
  return '0.0.0-dev';
}

export function parsePortValue(raw, sourceLabel) {
  const str = String(raw ?? '').trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`无效端口 (${sourceLabel}): "${raw}"，需为 1–65535 之间的整数。`);
  }
  const port = Number(str);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error(`端口超出范围 (${sourceLabel}): ${port}，需为 1–65535 之间的整数。`);
  }
  return port;
}

function printHelp() {
  const version = readAppVersion();
  console.log(`
Paper Cup Studio 快速启动器 (v${version})

用法:
  node scripts/start.mjs [选项]

选项:
  --dev               同时启动服务端与 Vite 开发服务器 (热更新模式，打开 http://localhost:5173)
  --rebuild           启动前强制重新构建 server 与 web 生产产物
  --no-open           仅启动服务，不自动打开系统默认浏览器
  --port=<端口>       指定服务端监听端口 (默认: 3100)
  --workspace=<目录>  指定初始视觉小说工作区目录
  -h, --help          显示帮助信息
`);
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    dev: false,
    rebuild: false,
    open: true,
    port: env.PORT !== undefined && String(env.PORT).trim() !== ''
      ? parsePortValue(env.PORT, 'PORT')
      : 3100,
    workspace: env.PAPERCUP_WORKSPACE || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '--dev') {
      opts.dev = true;
    } else if (arg === '--rebuild') {
      opts.rebuild = true;
    } else if (arg === '--no-open') {
      opts.open = false;
    } else if (arg.startsWith('--port=')) {
      opts.port = parsePortValue(arg.slice('--port='.length), '--port');
    } else if (arg === '--port') {
      if (!argv[i + 1]) {
        throw new Error('缺少 --port 参数值。');
      }
      opts.port = parsePortValue(argv[++i], '--port');
    } else if (arg.startsWith('--workspace=')) {
      opts.workspace = arg.slice('--workspace='.length);
    } else if (arg === '--workspace' && argv[i + 1]) {
      opts.workspace = argv[++i];
    }
  }
  return opts;
}

// Pi Agent SDK and its undici dependency declare engines.node >= 22.19.0
// (undici uses zlib.createZstdDecompress, which older 22.x builds lack).
const MIN_NODE = [22, 19, 0];

function checkNodeVersion() {
  const cur = process.versions.node.split('.').map((n) => Number(n) || 0);
  const i = MIN_NODE.findIndex((v, idx) => cur[idx] !== v);
  const tooOld = i !== -1 && cur[i] < MIN_NODE[i];
  if (tooOld) {
    console.error(`[Paper Cup] 需要 Node.js >= ${MIN_NODE.join('.')}（当前为 v${process.versions.node}）。`);
    console.error(`[Paper Cup] 当前使用的 Node 路径：${process.execPath}`);
    console.error('[Paper Cup] 请升级 Node.js（https://nodejs.org/），或调整 PATH 让较新的 node.exe 排在前面。');
    process.exit(1);
  }
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function hasBin(dir, name) {
  const binDir = path.join(dir, 'node_modules', '.bin');
  return fs.existsSync(path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name));
}

function getLatestMtimeMs(targetPath) {
  let maxMtime = 0;
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }
  const stack = [targetPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        } catch {
          // Ignore transient unreadable file
        }
      }
    }
  }
  return maxMtime;
}

export function isBuildStale(distEntry, inputPaths) {
  let distStat;
  try {
    distStat = fs.statSync(distEntry);
  } catch {
    return true;
  }
  const distMtime = distStat.mtimeMs;
  for (const input of inputPaths) {
    if (getLatestMtimeMs(input) > distMtime) {
      return true;
    }
  }
  return false;
}

function runSyncStep(label, args, cwd) {
  console.log(`[Paper Cup] ${label}...`);
  const res = spawnSync(npmCmd(), args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    throw new Error(`${label} failed with exit code ${res.status ?? 'unknown'}`);
  }
}

async function waitForUrl(url, timeoutMs = 45000, shouldAbort = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // Wait for service startup
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Ignore exit races
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Non-fatal if browser auto-open fails in headless terminals
  }
}

async function main() {
  checkNodeVersion();
  const opts = parseArgs(process.argv.slice(2));

  const serverEntry = path.join(SERVER_DIR, 'dist', 'index.js');
  const webEntry = path.join(WEB_DIR, 'dist', 'index.html');
  const serverBuildInputs = [
    path.join(SERVER_DIR, 'src'),
    path.join(SERVER_DIR, 'package.json'),
    path.join(SERVER_DIR, 'tsconfig.json'),
  ];
  const webBuildInputs = [
    path.join(WEB_DIR, 'src'),
    path.join(WEB_DIR, 'index.html'),
    path.join(WEB_DIR, 'vite.config.ts'),
    path.join(WEB_DIR, 'package.json'),
    path.join(WEB_DIR, 'tsconfig.json'),
  ];
  const serverNeedsBuild = !opts.dev && (opts.rebuild || isBuildStale(serverEntry, serverBuildInputs));
  const webNeedsBuild = !opts.dev && (opts.rebuild || isBuildStale(webEntry, webBuildInputs));
  const needServerBuildDeps = opts.dev || serverNeedsBuild;
  const needWebDeps = opts.dev || webNeedsBuild;

  if (
    needServerBuildDeps
      ? !hasBin(SERVER_DIR, 'tsx') || !hasBin(SERVER_DIR, 'tsc')
      : !fs.existsSync(path.join(SERVER_DIR, 'node_modules'))
  ) {
    const installArgs = needServerBuildDeps ? ['install'] : ['install', '--omit=dev'];
    runSyncStep('安装服务端依赖 (server)', installArgs, SERVER_DIR);
  }
  if (needWebDeps && (!fs.existsSync(path.join(WEB_DIR, 'node_modules')) || !hasBin(WEB_DIR, 'vite'))) {
    runSyncStep('安装前端依赖 (web)', ['install'], WEB_DIR);
  }

  const sharedEnv = {
    ...process.env,
    PORT: String(opts.port),
    HOST: process.env.HOST || '127.0.0.1',
    ...(opts.workspace ? { PAPERCUP_WORKSPACE: path.resolve(opts.workspace) } : {}),
  };

  const children = [];
  let shuttingDown = false;

  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      killProcessTree(child);
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', () => {
    cleanup();
  });

  if (opts.dev) {
    console.log('[Paper Cup] 以开发模式启动服务端与前端...');
    const serverProc = spawn(npmCmd(), ['run', 'dev'], {
      cwd: SERVER_DIR,
      env: sharedEnv,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    const webProc = spawn(npmCmd(), ['run', 'dev'], {
      cwd: WEB_DIR,
      env: sharedEnv,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    children.push(serverProc, webProc);

    serverProc.on('exit', (code) => {
      if (!shuttingDown) {
        cleanup();
        process.exit(code ?? 1);
      }
    });
    webProc.on('exit', (code) => {
      if (!shuttingDown) {
        cleanup();
        process.exit(code ?? 1);
      }
    });

    const healthUrl = `http://${sharedEnv.HOST}:${opts.port}/health`;
    const devUrl = 'http://localhost:5173/';
    const [okApi, okWeb] = await Promise.all([
      waitForUrl(healthUrl, 45000, () => shuttingDown),
      waitForUrl(devUrl, 45000, () => shuttingDown),
    ]);
    if (!okApi || !okWeb) {
      const failed = [
        !okApi ? `服务端 (${healthUrl})` : null,
        !okWeb ? `前端开发服务器 (${devUrl})` : null,
      ]
        .filter(Boolean)
        .join('、');
      cleanup();
      throw new Error(`等待服务就绪超时 (45s)：${failed} 未响应，已终止子进程。`);
    }
    console.log(`\n[Paper Cup] 开发工作台已就绪：${devUrl} (按 Ctrl+C 停止)\n`);
    if (opts.open) openBrowser(devUrl);
    return;
  }

  if (serverNeedsBuild) {
    runSyncStep('编译服务端 (server)', ['run', 'build'], SERVER_DIR);
  }
  if (webNeedsBuild) {
    runSyncStep('构建前端静态资源 (web)', ['run', 'build'], WEB_DIR);
  }

  console.log(`[Paper Cup] 启动单端口整合服务 (http://${sharedEnv.HOST}:${opts.port}/)...`);
  const serverProc = spawn(process.execPath, [serverEntry], {
    cwd: ROOT_DIR,
    env: sharedEnv,
    stdio: 'inherit',
  });
  children.push(serverProc);

  serverProc.on('exit', (code) => {
    if (!shuttingDown) {
      process.exit(code ?? 0);
    }
  });

  const targetUrl = `http://${sharedEnv.HOST}:${opts.port}/`;
  const healthUrl = `http://${sharedEnv.HOST}:${opts.port}/health`;
  const ready = await waitForUrl(healthUrl, 45000, () => shuttingDown);
  if (!ready) {
    cleanup();
    throw new Error(`等待服务端就绪超时 (45s)：${healthUrl} 未响应，已终止子进程。`);
  }
  console.log(`\n[Paper Cup] 已启动：${targetUrl} (按 Ctrl+C 停止)\n`);
  if (opts.open) openBrowser(targetUrl);
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
}

if (isDirectEntry()) {
  main().catch((err) => {
    console.error('[Paper Cup] 启动失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
