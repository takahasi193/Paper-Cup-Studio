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

function printHelp() {
  console.log(`
Paper Cup Studio 快速启动器 (v0.1.0-beta.1)

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

function parseArgs(argv) {
  const opts = {
    dev: false,
    rebuild: false,
    open: true,
    port: Number(process.env.PORT || 3100),
    workspace: process.env.PAPERCUP_WORKSPACE || '',
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
      const p = Number(arg.slice('--port='.length));
      if (Number.isInteger(p) && p > 0 && p < 65536) opts.port = p;
    } else if (arg === '--port' && argv[i + 1]) {
      const p = Number(argv[++i]);
      if (Number.isInteger(p) && p > 0 && p < 65536) opts.port = p;
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

async function waitForUrl(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

  if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
    runSyncStep('安装服务端依赖 (server)', ['install'], SERVER_DIR);
  }
  if (!fs.existsSync(path.join(WEB_DIR, 'node_modules'))) {
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
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore exit races
      }
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

    const healthUrl = `http://127.0.0.1:${opts.port}/health`;
    const devUrl = 'http://localhost:5173/';
    const [okApi, okWeb] = await Promise.all([waitForUrl(healthUrl), waitForUrl(devUrl)]);
    if (okApi && okWeb) {
      console.log(`\n[Paper Cup] 开发工作台已就绪：${devUrl} (按 Ctrl+C 停止)\n`);
      if (opts.open) openBrowser(devUrl);
    }
    return;
  }

  const serverEntry = path.join(SERVER_DIR, 'dist', 'index.js');
  const webEntry = path.join(WEB_DIR, 'dist', 'index.html');

  if (opts.rebuild || !fs.existsSync(serverEntry)) {
    runSyncStep('编译服务端 (server)', ['run', 'build'], SERVER_DIR);
  }
  if (opts.rebuild || !fs.existsSync(webEntry)) {
    runSyncStep('构建前端静态资源 (web)', ['run', 'build'], WEB_DIR);
  }

  console.log(`[Paper Cup] 启动单端口整合服务 (http://127.0.0.1:${opts.port}/)...`);
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

  const targetUrl = `http://127.0.0.1:${opts.port}/`;
  const ready = await waitForUrl(`http://127.0.0.1:${opts.port}/health`);
  if (ready) {
    console.log(`\n[Paper Cup] 已启动：${targetUrl} (按 Ctrl+C 停止)\n`);
    if (opts.open) openBrowser(targetUrl);
  }
}

main().catch((err) => {
  console.error('[Paper Cup] 启动失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
