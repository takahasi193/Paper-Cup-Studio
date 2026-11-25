#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = path.dirname(__filename);

const TARGETS = [
  { name: 'version.dll', sources: ['proxy_core.c', 'proxy_version.c'], def: 'version.def' },
  { name: 'winmm.dll', sources: ['proxy_core.c', 'proxy_winmm.c'], def: 'winmm.def' },
];

const EXPECTED_PE_MACHINE = {
  x86: 0x014c,
  x64: 0x8664,
};

function parseArgs(argv) {
  let arch = 'all';
  let strict = false;
  let outDir = path.join(SRC_DIR, 'bin');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--arch=')) {
      arch = arg.slice(7).toLowerCase();
    } else if (arg === '--arch' && argv[i + 1]) {
      arch = argv[++i].toLowerCase();
    } else if (arg.startsWith('--out-dir=')) {
      outDir = path.resolve(arg.slice(10));
    } else if (arg === '--out-dir' && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node build.mjs [--arch=x86|x64|all] [--strict] [--out-dir=<dir>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (arch !== 'x86' && arch !== 'x64' && arch !== 'all') {
    throw new Error(`Invalid --arch value: ${arch} (expected x86, x64, or all)`);
  }

  return {
    arches: arch === 'all' ? ['x86', 'x64'] : [arch],
    strict,
    outDir,
  };
}

function readPeMachine(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Not a valid MZ executable/DLL: ${filePath}`);
  }
  const peOffset = buf.readInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 6 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Not a valid PE image: ${filePath}`);
  }
  return buf.readUInt16LE(peOffset + 4);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function withPrependedPath(dir) {
  if (!dir) return process.env;
  const cur = process.env.PATH || process.env.Path || '';
  return { ...process.env, PATH: `${dir}${path.delimiter}${cur}` };
}

function detectActiveMsvc() {
  const res = spawnSync('cl.exe', [], { encoding: 'utf8' });
  if (res.error && res.error.code === 'ENOENT') return null;
  const banner = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (/\bfor\s+x64\b/i.test(banner) || /\bfor\s+amd64\b/i.test(banner)) {
    return { kind: 'msvc-env', arch: 'x64', label: 'cl.exe (PATH x64)' };
  }
  if (/\bfor\s+x86\b/i.test(banner) || /\bfor\s+80x86\b/i.test(banner)) {
    return { kind: 'msvc-env', arch: 'x86', label: 'cl.exe (PATH x86)' };
  }
  return null;
}

function discoverVsWhereVcvars(arch) {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;

  const res = spawnSync(
    vswhere,
    ['-all', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) return null;

  const batName = arch === 'x64' ? 'vcvars64.bat' : 'vcvars32.bat';
  const dirs = String(res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const installDir of dirs) {
    const vcvars = path.join(installDir, 'VC', 'Auxiliary', 'Build', batName);
    if (fs.existsSync(vcvars)) {
      return { kind: 'msvc-vcvars', arch, vcvars, label: `MSVC (${batName})` };
    }
  }
  return null;
}

function matchesGccArch(machine, arch) {
  const m = String(machine || '').trim().toLowerCase();
  if (arch === 'x64') return m.startsWith('x86_64');
  if (arch === 'x86') return /^(i[3-6]86|x86(?!_64))/.test(m);
  return false;
}

function discoverMingw(arch) {
  const candidates = arch === 'x64'
    ? [
        'C:\\msys64\\ucrt64\\bin\\gcc.exe',
        'C:\\msys64\\mingw64\\bin\\gcc.exe',
        'D:\\Qt\\Tools\\mingw1310_64\\bin\\gcc.exe',
        'x86_64-w64-mingw32-gcc',
        'gcc',
      ]
    : [
        'C:\\msys64\\mingw32\\bin\\gcc.exe',
        'i686-w64-mingw32-gcc',
        'gcc',
      ];

  for (const candidate of candidates) {
    const isAbs = path.isAbsolute(candidate);
    if (isAbs && !fs.existsSync(candidate)) continue;
    const env = isAbs ? withPrependedPath(path.dirname(candidate)) : process.env;
    const probe = spawnSync(candidate, ['-dumpmachine'], { encoding: 'utf8', env });
    if (probe.error || probe.status !== 0) continue;
    const machine = String(probe.stdout || '').trim();
    if (!matchesGccArch(machine, arch)) continue;
    return {
      kind: 'mingw',
      arch,
      gcc: candidate,
      env,
      label: `MinGW (${machine} @ ${candidate})`,
    };
  }
  return null;
}

function resolveToolchain(arch) {
  const activeMsvc = detectActiveMsvc();
  if (activeMsvc && activeMsvc.arch === arch) return activeMsvc;
  const vsMsvc = discoverVsWhereVcvars(arch);
  if (vsMsvc) return vsMsvc;
  return discoverMingw(arch);
}

function compileWithMsvc(toolchain, target, outDll, tempDir) {
  const srcs = target.sources.map((s) => `"${path.join(SRC_DIR, s)}"`).join(' ');
  const defPath = path.join(SRC_DIR, target.def);
  const base = path.basename(target.name, '.dll');
  const objDir = path.join(tempDir, `${toolchain.arch}_${base}`);
  fs.mkdirSync(objDir, { recursive: true });

  const clCmd = [
    'cl',
    '/nologo',
    '/O2',
    '/LD',
    '/MT',
    '/W4',
    `/Fe:"${outDll}"`,
    `/Fo:"${objDir}\\"`,
    srcs,
    '/link',
    `/DEF:"${defPath}"`,
    'kernel32.lib',
    `/IMPLIB:"${path.join(objDir, `${base}.lib`)}"`,
  ].join(' ');

  const cmd = toolchain.kind === 'msvc-vcvars'
    ? `call "${toolchain.vcvars}" >nul && ${clCmd}`
    : clCmd;

  const res = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], {
    cwd: SRC_DIR,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `MSVC build failed for ${target.name} (${toolchain.arch}):\n${res.stdout || ''}\n${res.stderr || ''}`.trim()
    );
  }
}

function compileWithMingw(toolchain, target, outDll) {
  const srcs = target.sources.map((s) => path.join(SRC_DIR, s));
  const defPath = path.join(SRC_DIR, target.def);
  const entryFlag = toolchain.arch === 'x64'
    ? '-Wl,--entry,DllMain'
    : '-Wl,--entry,_DllMain@12';
  const extraX86Flags = toolchain.arch === 'x86'
    ? ['-Wl,--enable-stdcall-fixup', '-Wl,--kill-at']
    : [];

  const args = [
    '-shared',
    '-O2',
    '-s',
    '-nostdlib',
    '-DPC_NOSTDLIB',
    '-Wall',
    '-Wextra',
    entryFlag,
    ...extraX86Flags,
    ...srcs,
    defPath,
    '-lkernel32',
    '-o',
    outDll,
  ];

  const res = spawnSync(toolchain.gcc, args, {
    cwd: SRC_DIR,
    env: toolchain.env,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `MinGW build failed for ${target.name} (${toolchain.arch}):\n${res.stdout || ''}\n${res.stderr || ''}`.trim()
    );
  }
}

function loadExistingManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-proxy-build-'));

  const manifestPath = path.join(opts.outDir, 'manifest.json');
  const existing = loadExistingManifest(manifestPath);
  const archesRecord = (existing && typeof existing.arches === 'object' && existing.arches) || {};
  const missingArches = [];
  let builtArches = 0;

  try {
    for (const arch of opts.arches) {
      const toolchain = resolveToolchain(arch);
      if (!toolchain) {
        console.warn(`[win32-proxy] WARNING: No ${arch} C toolchain (MSVC or MinGW) found; skipping ${arch}.`);
        missingArches.push(arch);
        continue;
      }

      console.log(`[win32-proxy] Building ${arch} proxy DLLs using ${toolchain.label}...`);
      const archOutDir = path.join(opts.outDir, arch);
      fs.mkdirSync(archOutDir, { recursive: true });

      const builtTargets = [];
      for (const target of TARGETS) {
        const outDll = path.join(archOutDir, target.name);
        if (toolchain.kind === 'mingw') {
          compileWithMingw(toolchain, target, outDll);
        } else {
          compileWithMsvc(toolchain, target, outDll, tempDir);
        }

        const stat = fs.statSync(outDll);
        if (!stat.isFile() || stat.size === 0) {
          throw new Error(`Built DLL is missing or empty: ${outDll}`);
        }
        const machine = readPeMachine(outDll);
        const expected = EXPECTED_PE_MACHINE[arch];
        if (machine !== expected) {
          throw new Error(
            `PE machine mismatch for ${outDll}: expected 0x${expected.toString(16)}, got 0x${machine.toString(16)}`
          );
        }

        const sha256 = sha256File(outDll);
        builtTargets.push({
          name: target.name,
          rel: `${arch}/${target.name}`,
          machine: `0x${machine.toString(16).padStart(4, '0')}`,
          bytes: stat.size,
          sha256,
        });
        console.log(
          `[win32-proxy]   -> ${arch}/${target.name} (${stat.size} bytes, machine=0x${machine.toString(16).padStart(4, '0')}, sha256=${sha256.slice(0, 12)}...)`
        );
      }

      archesRecord[arch] = {
        toolchain: toolchain.label,
        built_at: new Date().toISOString(),
        dlls: builtTargets,
      };
      builtArches += 1;
    }

    const artifacts = [];
    for (const archKey of ['x86', 'x64']) {
      const entry = archesRecord[archKey];
      if (!entry || !Array.isArray(entry.dlls)) continue;
      for (const dll of entry.dlls) {
        artifacts.push({ arch: archKey, ...dll });
      }
    }

    const manifest = {
      schema: 1,
      built_at: new Date().toISOString(),
      arches: archesRecord,
      artifacts,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    if (opts.strict && missingArches.length > 0) {
      console.error(`[win32-proxy] ERROR (--strict): missing toolchain(s) for: ${missingArches.join(', ')}`);
      process.exit(1);
    }
    if (builtArches === 0) {
      console.error('[win32-proxy] ERROR: 0 architectures were built.');
      process.exit(1);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
