import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { AgentService, AppError } from '../src/agent/agent-service.js';
import {
  createEmptyPersistedAuthState,
  loadPersistedAuthState,
  savePersistedAuthState,
} from '../src/agent/auth-store.js';
import { createApiRouter } from '../src/api/routes.js';
import { config, resolvePapercupConfigDir } from '../src/config.js';
import {
  DEFAULT_HARD_STOP_CONSECUTIVE_FAILURES,
  DEFAULT_MAIN_BASH_MAX_TIMEOUT_SEC,
  DEFAULT_MAX_REVERSER_DURATION_MS,
  DEFAULT_MAX_REVERSER_STALL_CALLS,
  DEFAULT_MAX_REVERSER_TOOL_CALLS,
  collectProtectedWorkspaceSnapshot,
  createGuardedBuiltinToolDefinitions,
  detectBlockedMainAgentReverseOrFontAction,
  detectBlockedProtectedBashCommand,
  detectBlockedProtectedFilePath,
  diffProtectedWorkspaceSnapshots,
  isPathInsideSkillReadRoots,
  isProtectedGameFontRel,
  readVnResearchConfig,
} from '../src/security/guarded-tools.js';
import {
  detectBlockedBashHeredocCommand,
  detectBlockedExternalWriteCommand,
  detectBlockedHostMutationCommand,
  detectBlockedHostSearchCommand,
  detectBlockedProcessControlCommand,
  detectBlockedSecretCommand,
  detectExternalWriteInScriptContent,
  detectHostMutationInScriptContent,
  detectHostSearchInScriptContent,
  detectProcessControlInScriptContent,
  extractBashWriteTargets,
  isPathInsideWorkspace,
  isRestrictedSecretPath,
  redactSecrets,
} from '../src/security/secrets.js';
import { BUILTIN_SUBAGENTS } from '../src/subagents/roles.js';
import {
  SubagentManager,
  toSubagentTaskSummary,
  type SubagentTaskSnapshot,
  type SubagentTaskSummary,
} from '../src/subagents/subagent-manager.js';

interface IsolatedSandbox {
  root: string;
  homeDir: string;
  workspace: string;
}

const PROVIDER_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'VOLCENGINE_API_KEY',
  'ARK_API_KEY',
  'DASHSCOPE_API_KEY',
  'MODELSCOPE_API_KEY',
  'MAGPIE_API_KEY',
  'MAGPIE_BASE_URL',
  'MAGPIE_MODEL',
  'PAPERCUP_HOME',
  'PAPERCUP_MAX_TOOL_OUTPUT_CHARS',
  'PAPERCUP_MAX_CONSECUTIVE_FAILURES',
  'PAPERCUP_REVERSER_HARD_STOP_FAILURES',
  'PAPERCUP_REVERSER_MAX_TOOL_CALLS',
  'PAPERCUP_REVERSER_MAX_DURATION_MS',
  'PAPERCUP_REVERSER_MAX_STALL_CALLS',
  'PAPERCUP_REVERSER_BASH_TIMEOUT_SEC',
  'PAPERCUP_MAIN_BASH_TIMEOUT_SEC',
] as const;

async function withIsolatedSandbox<T>(fn: (sb: IsolatedSandbox) => Promise<T> | T): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-sec-inv-'));
  const homeDir = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(homeDir, '.papercup'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const savedEnv = new Map<string, string | undefined>();
  for (const key of ['HOME', 'USERPROFILE', ...PROVIDER_ENV_KEYS]) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    return await fn({ root, homeDir, workspace });
  } finally {
    for (const [key, val] of savedEnv.entries()) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function toMsysPath(winAbsPath: string): string {
  const normalized = path.resolve(winAbsPath).replace(/\\/g, '/');
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!m) return normalized;
  return `/${m[1].toLowerCase()}/${m[2]}`;
}

function tryCreateSymlinkOrJunction(target: string, linkPath: string, isDir: boolean): boolean {
  try {
    if (isDir) {
      fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      fs.symlinkSync(target, linkPath, 'file');
    }
    return true;
  } catch {
    return false;
  }
}

describe('Invariant #4: Workspace removal never deletes user game files & honors 409 busy gate', () => {
  test('AgentService.removeWorkspace and POST /api/workspaces/remove unregister only without touching disk', async () => {
    await withIsolatedSandbox(async ({ root, homeDir, workspace }) => {
      const gameWsA = workspace;
      const gameWsB = path.join(root, 'game-ws-b');
      fs.mkdirSync(path.join(gameWsA, 'data'), { recursive: true });
      fs.mkdirSync(path.join(gameWsB, 'script'), { recursive: true });

      const exeBytesA = Buffer.from('MZ-ORIGINAL-GAME-A-BINARY-PAYLOAD');
      const xp3BytesA = Buffer.from('XP3\r\n \n\x1a\x8b\x67\x01ORIGINAL-ARCHIVE-A');
      const scriptTextA = '*start\nこんにちは世界[p]\n';
      fs.writeFileSync(path.join(gameWsA, 'Game.exe'), exeBytesA);
      fs.writeFileSync(path.join(gameWsA, 'data', 'data.xp3'), xp3BytesA);
      fs.writeFileSync(path.join(gameWsA, 'data', 'scene01.ks'), scriptTextA, 'utf8');

      const exeBytesB = Buffer.from('MZ-ORIGINAL-GAME-B-BINARY-PAYLOAD');
      const scriptTextB = 'label start:\n    "Game B intact"\n';
      fs.writeFileSync(path.join(gameWsB, 'GameB.exe'), exeBytesB);
      fs.writeFileSync(path.join(gameWsB, 'script', 'intro.rpy'), scriptTextB, 'utf8');

      const svc = new AgentService(gameWsA, { sessionMode: 'persist' });
      const app = createApiRouter(svc);

      try {
        // Register both workspaces in isolated ~/.papercup/workspaces.json
        svc.setWorkspace(gameWsB);
        svc.setWorkspace(gameWsA);

        const regPath = path.join(homeDir, '.papercup', 'workspaces.json');
        assert.equal(fs.existsSync(regPath), true, 'Expected isolated workspaces.json to exist');
        const beforeReg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        assert.equal(beforeReg.recent.length, 2);

        // 1. Direct AgentService.removeWorkspace() on non-active gameWsB
        const afterDirect = svc.removeWorkspace(gameWsB);
        assert.equal(
          afterDirect.recent.some((p) => path.resolve(p).toLowerCase() === path.resolve(gameWsB).toLowerCase()),
          false,
          'gameWsB must be removed from workspace registry'
        );
        // Disk contents of gameWsB must be 100% untouched
        assert.equal(fs.existsSync(gameWsB), true);
        assert.deepEqual(fs.readFileSync(path.join(gameWsB, 'GameB.exe')), exeBytesB);
        assert.equal(fs.readFileSync(path.join(gameWsB, 'script', 'intro.rpy'), 'utf8'), scriptTextB);

        // 2. Re-add gameWsB, then remove active gameWsA via HTTP POST /api/workspaces/remove
        svc.setWorkspace(gameWsB);
        svc.setWorkspace(gameWsA);

        const badJsonRes = await app.request('/api/workspaces/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{malformed-json',
        });
        assert.equal(badJsonRes.status, 400, 'Malformed JSON must return 400 rather than 500');

        const rmRes = await app.request('/api/workspaces/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: gameWsA }),
        });
        assert.equal(rmRes.status, 200);
        const rmBody = (await rmRes.json()) as { ok: boolean; active: string; recent: string[] };
        assert.equal(rmBody.ok, true);
        assert.equal(
          rmBody.recent.some((p) => path.resolve(p).toLowerCase() === path.resolve(gameWsA).toLowerCase()),
          false,
          'gameWsA must be removed from registry'
        );
        assert.equal(path.resolve(rmBody.active).toLowerCase(), path.resolve(gameWsB).toLowerCase());

        const persistedReg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        assert.equal(
          persistedReg.recent.some((p: string) => path.resolve(p).toLowerCase() === path.resolve(gameWsA).toLowerCase()),
          false,
          'workspaces.json must persist removal of gameWsA'
        );

        // Original game directory A and all files inside MUST remain byte-for-byte intact
        assert.equal(fs.existsSync(gameWsA), true);
        assert.deepEqual(fs.readFileSync(path.join(gameWsA, 'Game.exe')), exeBytesA);
        assert.deepEqual(fs.readFileSync(path.join(gameWsA, 'data', 'data.xp3')), xp3BytesA);
        assert.equal(fs.readFileSync(path.join(gameWsA, 'data', 'scene01.ks'), 'utf8'), scriptTextA);
      } finally {
        (svc as any).currentSession?.dispose?.();
      }
    });
  });

  test('POST /api/workspaces/remove and AgentService.removeWorkspace return 409 while a turn is busy', async () => {
    await withIsolatedSandbox(async ({ root, workspace }) => {
      const otherWs = path.join(root, 'other-ws');
      fs.mkdirSync(otherWs, { recursive: true });
      fs.writeFileSync(path.join(otherWs, 'Game.exe'), 'MZ-KEEP', 'utf8');

      const svc = new AgentService(workspace, { sessionMode: 'memory' });
      const app = createApiRouter(svc);

      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });

      try {
        await svc.initSession();
        const faux = createFauxCore({ tokensPerSecond: 10000 });
        faux.setResponses([() => fauxAssistantMessage('done')]);

        const session = (svc as any).currentSession;
        session.agent.state.model = faux.getModel();
        session._modelRuntime.hasConfiguredAuth = () => true;
        session.agent.streamFunction = (model: any, ctx: any, opts: any) => {
          const inner = faux.streamSimple(model, ctx, opts);
          const wrapped = (async function* () {
            notifyStarted();
            await gate;
            for await (const ev of inner) {
              yield ev;
            }
          })();
          (wrapped as any).result = () => inner.result();
          return wrapped;
        };

        const turnPromise = svc.executeTurn('hold busy lock');
        await started;
        assert.equal(svc.isBusy(), true, 'Service must report isBusy() === true during active turn');

        // Direct API must throw AppError(409)
        assert.throws(
          () => svc.removeWorkspace(otherWs),
          (err: unknown) => err instanceof AppError && err.status === 409
        );

        // HTTP /api/workspaces/remove and /api/workspaces/select must both return 409
        const httpRm = await app.request('/api/workspaces/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: otherWs }),
        });
        assert.equal(httpRm.status, 409);

        const httpSel = await app.request('/api/workspaces/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: otherWs }),
        });
        assert.equal(httpSel.status, 409);

        releaseGate();
        await turnPromise;
        assert.equal(svc.isBusy(), false);
        assert.equal(fs.readFileSync(path.join(otherWs, 'Game.exe'), 'utf8'), 'MZ-KEEP');
      } finally {
        releaseGate?.();
        (svc as any).currentSession?.dispose?.();
      }
    });
  });
});

describe('Credential & .env Guardrails (secrets.ts, guarded-tools.ts, auth-store.ts)', () => {
  test('read/edit/write/bash all block .env while allowing safe .env.example templates', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      const envSecretContent = 'GEMINI_API_KEY=AIzaSyDummyFixtureSecretValue123456\n';
      const envPath = path.join(workspace, '.env');
      const envLocalPath = path.join(workspace, '.env.local');
      const envExamplePath = path.join(workspace, '.env.example');
      fs.writeFileSync(envPath, envSecretContent, 'utf8');
      fs.writeFileSync(envLocalPath, 'OPENAI_API_KEY=sk-proj-dummyfixturesecret123456\n', 'utf8');
      fs.writeFileSync(envExamplePath, 'GEMINI_API_KEY=your-key-here\n', 'utf8');

      const tools = createGuardedBuiltinToolDefinitions(workspace, ['read', 'edit', 'write', 'bash'], {
        bashPath: config.bashPath,
        homeDir,
      });
      const readTool = tools.find((t) => t.name === 'read')!;
      const editTool = tools.find((t) => t.name === 'edit')!;
      const writeTool = tools.find((t) => t.name === 'write')!;
      const bashTool = tools.find((t) => t.name === 'bash')!;

      for (const secretRel of ['.env', '.env.local']) {
        const r = (await readTool.execute('r-env', { path: secretRel }, undefined, undefined, {} as any)) as any;
        assert.equal(r?.isError, true, `read(${secretRel}) must be blocked`);
        assert.equal(r?.details?.blocked, true);
        assert.equal(String(r?.content?.[0]?.text || '').includes('DummyFixtureSecret'), false);

        const e = (await editTool.execute(
          'e-env',
          { path: secretRel, edits: [{ oldText: 'GEMINI', newText: 'X' }] },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.equal(e?.isError, true, `edit(${secretRel}) must be blocked`);
        assert.equal(e?.details?.blocked, true);

        const w = (await writeTool.execute(
          'w-env',
          { path: secretRel, content: 'OVERWRITTEN=1\n' },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.equal(w?.isError, true, `write(${secretRel}) must be blocked`);
        assert.equal(w?.details?.blocked, true);
      }

      for (const cmd of ['cat .env', 'head -n 1 .env.local', 'cat<.env', 'echo X=1 >> .env']) {
        const b = (await bashTool.execute('b-env', { command: cmd }, undefined, undefined, {} as any)) as any;
        assert.equal(b?.isError, true, `bash("${cmd}") must be blocked`);
        assert.equal(b?.details?.blocked, true);
      }

      // Original .env content must remain completely untouched
      assert.equal(fs.readFileSync(envPath, 'utf8'), envSecretContent);

      // Safe .env.example template must be allowed
      const okRead = (await readTool.execute('r-ex', { path: '.env.example' }, undefined, undefined, {} as any)) as any;
      assert.notEqual(okRead?.isError, true, 'read(.env.example) must succeed');
      assert.equal(detectBlockedSecretCommand('cat .env.example', workspace), null);
    });
  });

  test('blocks secret env var printing, env dumping, and --flag=secret_path while allowing safe shell directives', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      fs.mkdirSync(path.join(homeDir, '.aws'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.aws', 'credentials'), '[default]\naws_secret_access_key=dummy\n');
      const awsCredPath = path.join(homeDir, '.aws', 'credentials');
      const awsFlagPath = process.platform === 'win32' ? toMsysPath(awsCredPath) : awsCredPath;

      const blockedCmds = [
        'echo ${GEMINI_API_KEY}',
        'echo "${ARK_API_KEY}"',
        'echo ${!OPENAI_API_KEY}',
        'echo %GEMINI_API_KEY%',
        'Write-Host $env:OPENAI_API_KEY',
        'Write-Host ${env:ANTHROPIC_API_KEY}',
        'env',
        'env -0',
        '/usr/bin/env',
        'printenv',
        'printenv GEMINI_API_KEY',
        'export -p',
        'export',
        'declare -x',
        'declare -p GEMINI_API_KEY',
        'set | cat',
        'set',
        'Get-ChildItem Env:',
        'gci env:',
        '[System.Environment]::GetEnvironmentVariables()',
        `grep --file=${awsFlagPath} foo`,
        `cat<${awsFlagPath}`,
        'bash -c "env -0"',
        'echo $(printenv)',
      ];
      for (const cmd of blockedCmds) {
        assert.notEqual(
          detectBlockedSecretCommand(cmd, workspace),
          null,
          `Expected secret guard to block: ${cmd}`
        );
      }

      const allowedCmds = [
        'set -euo pipefail',
        'export FOO=bar',
        'declare -x COUNT=1',
        'env FOO=1 python probe.py',
        'cat .env.example',
        'cat papercup.toml',
        'echo "hello world"',
      ];
      for (const cmd of allowedCmds) {
        assert.equal(
          detectBlockedSecretCommand(cmd, workspace),
          null,
          `Unexpected secret guard false positive on: ${cmd}`
        );
      }
    });
  });

  test('blocks MSYS paths, workspace symlinks/junctions to secrets/outside, and auth.json symlink write', async () => {
    await withIsolatedSandbox(async ({ root, homeDir, workspace }) => {
      const papercupDir = path.join(homeDir, '.papercup');
      const awsDir = path.join(homeDir, '.aws');
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(papercupDir, { recursive: true });
      fs.mkdirSync(awsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const authFile = path.join(papercupDir, 'auth.json');
      const awsCred = path.join(awsDir, 'credentials');
      fs.writeFileSync(authFile, JSON.stringify({ version: 1, providers: {} }), 'utf8');
      fs.writeFileSync(awsCred, '[default]\nsecret=123456\n', 'utf8');

      // 1. MSYS /<drive>/... path normalization on Windows
      if (process.platform === 'win32') {
        const msysAws = toMsysPath(awsCred);
        const msysAuth = toMsysPath(authFile);
        assert.equal(isRestrictedSecretPath(msysAws, workspace), true, `MSYS path must be restricted: ${msysAws}`);
        assert.equal(isRestrictedSecretPath(msysAuth, workspace), true, `MSYS path must be restricted: ${msysAuth}`);
        assert.notEqual(detectBlockedSecretCommand(`cat ${msysAws}`, workspace), null);
      }

      // 2. Directory symlink/junction inside workspace pointing to ~/.papercup
      const secretDirLink = path.join(workspace, 'linked_cfg');
      assert.equal(
        tryCreateSymlinkOrJunction(papercupDir, secretDirLink, true),
        true,
        'Expected symlink/junction creation to succeed in temp workspace'
      );
      assert.equal(
        isRestrictedSecretPath('linked_cfg/auth.json', workspace),
        true,
        'Reading auth.json through workspace symlink/junction must be restricted'
      );
      assert.notEqual(detectBlockedSecretCommand('cat linked_cfg/auth.json', workspace), null);

      const tools = createGuardedBuiltinToolDefinitions(workspace, ['read', 'write', 'edit'], { homeDir });
      const readTool = tools.find((t) => t.name === 'read')!;
      const writeTool = tools.find((t) => t.name === 'write')!;
      const readLinkRes = (await readTool.execute(
        'r-link',
        { path: 'linked_cfg/auth.json' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(readLinkRes?.isError, true);
      assert.equal(readLinkRes?.details?.blocked, true);

      // 3. Workspace symlink/junction escaping outside workspace must fail isPathInsideWorkspace & write guard
      const escapeLink = path.join(workspace, 'escape_dir');
      assert.equal(tryCreateSymlinkOrJunction(outsideDir, escapeLink, true), true);
      assert.equal(isPathInsideWorkspace('escape_dir/pwn.txt', workspace), false);
      const writeEscRes = (await writeTool.execute(
        'w-link-esc',
        { path: 'escape_dir/pwn.txt', content: 'escaped' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(writeEscRes?.isError, true);
      assert.equal(writeEscRes?.details?.blocked, true);
      assert.equal(fs.existsSync(path.join(outsideDir, 'pwn.txt')), false);

      // Optional file symlink to .env (when OS permits unprivileged file symlinks)
      const envTarget = path.join(outsideDir, '.env');
      fs.writeFileSync(envTarget, 'GEMINI_API_KEY=AIzaSySymlinkSecret123456789\n', 'utf8');
      const fileLink = path.join(workspace, 'innocent.txt');
      if (tryCreateSymlinkOrJunction(envTarget, fileLink, false)) {
        assert.equal(isRestrictedSecretPath('innocent.txt', workspace), true);
      }

      // 4. auth-store.ts refuses writing or loading when auth.json itself is a symlink/junction
      const symlinkedAuthPath = path.join(root, 'auth-link-test', 'auth.json');
      fs.mkdirSync(path.dirname(symlinkedAuthPath), { recursive: true });
      const linkCreated =
        tryCreateSymlinkOrJunction(authFile, symlinkedAuthPath, false) ||
        tryCreateSymlinkOrJunction(outsideDir, symlinkedAuthPath, true);
      assert.equal(linkCreated, true, 'Expected symlink or junction fixture for auth.json');
      assert.equal(fs.lstatSync(symlinkedAuthPath).isSymbolicLink(), true);

      const loaded = loadPersistedAuthState(symlinkedAuthPath);
      assert.deepEqual(loaded, createEmptyPersistedAuthState(), 'loadPersistedAuthState must ignore symlinked auth.json');
      assert.throws(
        () => savePersistedAuthState(symlinkedAuthPath, createEmptyPersistedAuthState()),
        /symbolic link/i,
        'savePersistedAuthState must refuse writing to a symbolic link'
      );
    });
  });

  test('redactSecrets masks AIza/sk/xai/gsk/JWT/Bearer keys without false-positive on "magpie"', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlBhcGVyQ3VwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = [
      'google=AIzaSyTestRedactionValue12345678',
      'openai=sk-proj-TestRedactionValue12345678',
      'anthropic=sk-ant-TestRedactionValue12345678',
      'xai=xai-TestRedactionValue12345678',
      'groq=gsk_TestRedactionValue12345678',
      `jwt=${jwt}`,
      'Authorization: Bearer super_secret_bearer_token_999999',
      'provider=using magpie local gateway',
    ].join('\n');

    const out = redactSecrets(input);
    assert.equal(out.includes('AIzaSy'), false);
    assert.equal(out.includes('sk-proj-'), false);
    assert.equal(out.includes('sk-ant-'), false);
    assert.equal(out.includes('xai-Test'), false);
    assert.equal(out.includes('gsk_Test'), false);
    assert.equal(out.includes('eyJhbGci'), false);
    assert.equal(out.includes('super_secret_bearer_token'), false);
    assert.equal(out.includes('Bearer [REDACTED]'), true);
    assert.equal(out.includes('using magpie local gateway'), true, 'Must not redact ordinary word "magpie"');
  });

  test('ls and find allow workspace-local paths while blocking outside-workspace paths, symlink escapes, and credential directories', async () => {
    await withIsolatedSandbox(async ({ root, homeDir, workspace }) => {
      // Set up workspace-local files, sibling outside dir, and restricted credential dirs
      const nestedDir = path.join(workspace, 'data', 'nested');
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'root_file.txt'), 'root\n', 'utf8');
      fs.writeFileSync(path.join(nestedDir, 'hello.txt'), 'nested\n', 'utf8');

      const outsideDir = path.join(root, 'outside');
      const outsideSub = path.join(outsideDir, 'sub');
      fs.mkdirSync(outsideSub, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'secret_outside.txt'), 'outside\n', 'utf8');
      fs.writeFileSync(path.join(outsideSub, 'deep_outside.txt'), 'deep\n', 'utf8');

      const papercupDir = path.join(homeDir, '.papercup');
      const awsDir = path.join(homeDir, '.aws');
      const sshDir = path.join(homeDir, '.ssh');
      fs.mkdirSync(papercupDir, { recursive: true });
      fs.mkdirSync(awsDir, { recursive: true });
      fs.mkdirSync(sshDir, { recursive: true });
      fs.writeFileSync(path.join(papercupDir, 'auth.json'), '{"version":1,"providers":{}}\n', 'utf8');
      fs.writeFileSync(path.join(awsDir, 'credentials'), '[default]\nsecret=1\n', 'utf8');
      fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'PRIVATE-KEY\n', 'utf8');

      const escapeLink = path.join(workspace, 'escape_link');
      const hasEscapeLink = tryCreateSymlinkOrJunction(outsideDir, escapeLink, true);
      assert.equal(hasEscapeLink, true, 'Expected symlink/junction fixture to outsideDir');

      const secretAwsLink = path.join(workspace, 'linked_aws');
      const hasSecretAwsLink = tryCreateSymlinkOrJunction(awsDir, secretAwsLink, true);
      assert.equal(hasSecretAwsLink, true, 'Expected symlink/junction fixture to ~/.aws');

      const papercupLink = path.join(workspace, 'linked_papercup');
      const hasPapercupLink = tryCreateSymlinkOrJunction(papercupDir, papercupLink, true);
      assert.equal(hasPapercupLink, true, 'Expected symlink/junction fixture to ~/.papercup');

      const tools = createGuardedBuiltinToolDefinitions(workspace, ['ls', 'find'], { homeDir });
      const lsTool = tools.find((t) => t.name === 'ls')!;
      const findTool = tools.find((t) => t.name === 'find')!;
      assert.ok(lsTool && findTool, 'Expected guarded ls and find tools');

      const getText = (res: any): string =>
        Array.isArray(res?.content)
          ? res.content.map((c: any) => String(c?.text || '')).join('\n')
          : '';

      // 1. Omitted path, ".", relative subdir, and inside-workspace absolute path all succeed
      for (const [label, lsParams, expectedEntry] of [
        ['omitted path', {}, 'root_file.txt'],
        ['dot path', { path: '.' }, 'root_file.txt'],
        ['relative subdir', { path: 'data/nested' }, 'hello.txt'],
        ['in-workspace absolute path', { path: path.join(workspace, 'data') }, 'nested'],
      ] as const) {
        const res = (await lsTool.execute(`ls-ok-${label}`, lsParams as any, undefined, undefined, {} as any)) as any;
        const text = getText(res);
        assert.notEqual(res?.isError, true, `ls(${label}) must succeed, got: ${text}`);
        assert.equal(text.includes(expectedEntry), true, `ls(${label}) missing expected "${expectedEntry}", got: ${text}`);
        assert.equal(text.includes('secret_outside.txt'), false);
      }

      for (const [label, findParams, expectedMatch] of [
        ['omitted path', { pattern: '*.txt' }, 'hello.txt'],
        ['dot path', { path: '.', pattern: '*.txt' }, 'root_file.txt'],
        ['relative subdir', { path: 'data/nested', pattern: '*.txt' }, 'hello.txt'],
        ['in-workspace absolute path', { path: path.join(workspace, 'data'), pattern: '*.txt' }, 'hello.txt'],
      ] as const) {
        const res = (await findTool.execute(`find-ok-${label}`, findParams as any, undefined, undefined, {} as any)) as any;
        const text = getText(res);
        assert.notEqual(res?.isError, true, `find(${label}) must succeed, got: ${text}`);
        assert.equal(text.includes(expectedMatch), true, `find(${label}) missing expected "${expectedMatch}", got: ${text}`);
        assert.equal(text.includes('secret_outside.txt'), false);
      }

      // 2. Outside-workspace paths (sibling traversal, parent, absolute outside path, and symlink/junction escape) MUST be blocked
      const outsideTargets = [
        '../outside',
        '..',
        outsideDir,
        outsideSub,
        'escape_link',
        'escape_link/sub',
        ...(process.platform === 'win32' ? [toMsysPath(outsideDir)] : []),
      ];

      for (const target of outsideTargets) {
        const lsRes = (await lsTool.execute('ls-out', { path: target }, undefined, undefined, {} as any)) as any;
        const lsText = getText(lsRes);
        assert.equal(lsRes?.isError, true, `ls("${target}") must be blocked, got: ${lsText}`);
        assert.equal(lsRes?.details?.blocked, true, `ls("${target}") must set details.blocked=true`);
        assert.equal(
          lsText.includes('Security guard') && lsText.includes('outside active workspace'),
          true,
          `ls("${target}") must report Security guard outside active workspace, got: ${lsText}`
        );
        assert.equal(lsText.includes('secret_outside.txt'), false);
        assert.equal(lsText.includes('deep_outside.txt'), false);

        const findRes = (await findTool.execute(
          'find-out',
          { path: target, pattern: '*' },
          undefined,
          undefined,
          {} as any
        )) as any;
        const findText = getText(findRes);
        assert.equal(findRes?.isError, true, `find("${target}") must be blocked, got: ${findText}`);
        assert.equal(findRes?.details?.blocked, true, `find("${target}") must set details.blocked=true`);
        assert.equal(
          findText.includes('Security guard') && findText.includes('outside active workspace'),
          true,
          `find("${target}") must report Security guard outside active workspace, got: ${findText}`
        );
        assert.equal(findText.includes('secret_outside.txt'), false);
        assert.equal(findText.includes('deep_outside.txt'), false);
      }

      // 3. Restricted secret/credential directories (~/.aws, ~/.ssh, workspace symlink to ~/.aws) remain blocked by credential guard,
      //    and ~/.papercup (direct, ~, MSYS, or symlink) is also blocked with Security guard without leaking auth.json
      const credentialDirTargets = [
        awsDir,
        '~/.aws',
        sshDir,
        '~/.ssh',
        'linked_aws',
        ...(process.platform === 'win32' ? [toMsysPath(awsDir)] : []),
      ];

      for (const target of credentialDirTargets) {
        const lsRes = (await lsTool.execute('ls-sec', { path: target }, undefined, undefined, {} as any)) as any;
        const lsText = getText(lsRes);
        assert.equal(lsRes?.isError, true, `ls("${target}") must block credential directory, got: ${lsText}`);
        assert.equal(lsRes?.details?.blocked, true);
        assert.equal(
          lsText.includes('Security guard') && lsText.includes('credential directory'),
          true,
          `ls("${target}") must report Security guard credential directory, got: ${lsText}`
        );
        assert.equal(lsText.includes('credentials'), false);
        assert.equal(lsText.includes('id_ed25519'), false);

        const findRes = (await findTool.execute(
          'find-sec',
          { path: target, pattern: '*' },
          undefined,
          undefined,
          {} as any
        )) as any;
        const findText = getText(findRes);
        assert.equal(findRes?.isError, true, `find("${target}") must block credential directory, got: ${findText}`);
        assert.equal(findRes?.details?.blocked, true);
        assert.equal(
          findText.includes('Security guard') && findText.includes('credential directory'),
          true,
          `find("${target}") must report Security guard credential directory, got: ${findText}`
        );
        assert.equal(findText.includes('credentials'), false);
        assert.equal(findText.includes('id_ed25519'), false);
      }

      const papercupDirTargets = [
        papercupDir,
        '~/.papercup',
        'linked_papercup',
        ...(process.platform === 'win32' ? [toMsysPath(papercupDir)] : []),
      ];

      for (const target of papercupDirTargets) {
        const lsRes = (await lsTool.execute('ls-pc', { path: target }, undefined, undefined, {} as any)) as any;
        const lsText = getText(lsRes);
        assert.equal(lsRes?.isError, true, `ls("${target}") must be blocked, got: ${lsText}`);
        assert.equal(lsRes?.details?.blocked, true);
        assert.equal(lsText.includes('Security guard'), true, `ls("${target}") must mention Security guard, got: ${lsText}`);
        assert.equal(lsText.includes('auth.json'), false);

        const findRes = (await findTool.execute(
          'find-pc',
          { path: target, pattern: '*' },
          undefined,
          undefined,
          {} as any
        )) as any;
        const findText = getText(findRes);
        assert.equal(findRes?.isError, true, `find("${target}") must be blocked, got: ${findText}`);
        assert.equal(findRes?.details?.blocked, true);
        assert.equal(findText.includes('Security guard'), true, `find("${target}") must mention Security guard, got: ${findText}`);
        assert.equal(findText.includes('auth.json'), false);
      }
    });
  });
});

describe('All 7 Shell Lexical Bypass Channels & Zero False Positives (secrets.ts, guarded-tools.ts)', () => {
  test('blocks all 7 bypass classes while keeping legitimate workspace/read-only commands unblocked', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      fs.mkdirSync(path.join(workspace, '.papercup', 'data', 'results'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'game'), { recursive: true });
      fs.mkdirSync(path.join(workspace, '.papercup', 'tmp', 'unpacked'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, '.papercup', 'data', 'results', 'scenario.jsonl'),
        '{"id":1,"target":"译文"}\n',
        'utf8'
      );
      fs.writeFileSync(path.join(workspace, 'game', 'Game.exe'), 'MZ-GAME', 'utf8');
      fs.writeFileSync(path.join(workspace, 'in_ws.txt'), 'ok\n', 'utf8');

      const snap = collectProtectedWorkspaceSnapshot(workspace, homeDir);
      const extDir = process.platform === 'win32' ? '/e/out' : '/tmp/papercup_external_out';

      // Channel 1: export / declare / for variable tracking
      assert.notEqual(detectBlockedExternalWriteCommand(`export D=${extDir}; mkdir -p $D`, workspace), null);
      assert.notEqual(
        detectBlockedExternalWriteCommand(`declare -x D=${extDir}; cp a.txt $D/out.txt`, workspace),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand(
          'for f in .papercup/data/results/scenario.jsonl; do rm -f $f; done',
          workspace,
          snap
        ),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand(
          'for f in safe.txt .papercup/data/results/scenario.jsonl; do rm -f $f; done',
          workspace,
          snap
        ),
        null
      );

      // Channel 2: subshell (...), command substitution $(...), backticks `...`, single `&`
      assert.notEqual(detectBlockedExternalWriteCommand(`(mkdir -p ${extDir})`, workspace), null);
      assert.notEqual(detectBlockedExternalWriteCommand(`(cd ${extDir} && touch a.txt)`, workspace), null);
      assert.notEqual(detectBlockedExternalWriteCommand(`echo $(mkdir -p ${extDir})`, workspace), null);
      assert.notEqual(detectBlockedExternalWriteCommand(`echo "$(mkdir -p ${extDir})"`, workspace), null);
      assert.notEqual(detectBlockedExternalWriteCommand(`echo ok & mkdir -p ${extDir}`, workspace), null);
      assert.notEqual(detectBlockedProcessControlCommand('echo `taskkill //IM game.exe //F`'), null);
      assert.notEqual(detectBlockedProcessControlCommand('echo $(taskkill //IM game.exe //F)'), null);
      assert.notEqual(detectBlockedProcessControlCommand('(taskkill //IM game.exe //F)'), null);
      assert.notEqual(
        detectBlockedProtectedBashCommand('echo `rm -f .papercup/data/results/scenario.jsonl`', workspace, snap),
        null
      );

      // Channel 3: cmd //c quoted executable + arguments
      assert.notEqual(detectBlockedProcessControlCommand('cmd //c "game.exe --windowed"'), null);
      assert.notEqual(detectBlockedProcessControlCommand('cmd //c "runtest.bat E:\\tmp"'), null);
      assert.notEqual(detectBlockedExternalWriteCommand(`cmd //c "mkdir ${extDir}"`, workspace), null);

      // Channel 4: shell wrappers bash -c / sh -c / powershell -Command / -EncodedCommand
      assert.notEqual(detectBlockedExternalWriteCommand(`bash -c "mkdir -p ${extDir}"`, workspace), null);
      assert.notEqual(
        detectBlockedProtectedBashCommand('sh -c "rm -f .papercup/data/results/scenario.jsonl"', workspace, snap),
        null
      );
      assert.notEqual(
        detectBlockedProcessControlCommand('powershell -NoProfile -Command "Start-Process game.exe"'),
        null
      );
      const encodedLaunch = Buffer.from('Start-Process game.exe', 'utf16le').toString('base64');
      assert.notEqual(
        detectBlockedProcessControlCommand(`powershell -NoProfile -EncodedCommand ${encodedLaunch}`),
        null
      );
      const encodedDelete = Buffer.from('Remove-Item .papercup/data/results/scenario.jsonl', 'utf16le').toString('base64');
      assert.notEqual(
        detectBlockedProtectedBashCommand(
          `powershell -NoProfile -EncodedCommand ${encodedDelete}`,
          workspace,
          snap
        ),
        null
      );

      // Channel 5: brace expansion {a,b}, POSIX character class [s], find -delete/-exec, xargs rm
      assert.notEqual(
        detectBlockedProtectedBashCommand('rm -f .papercup/data/results/scenario.{jsonl,bak}', workspace, snap),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand('rm -f .papercup/data/results/[s]cenario.jsonl', workspace, snap),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand('find .papercup/data/results -name "*.jsonl" -delete', workspace, snap),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand('find . -name "*.jsonl" -delete', workspace, snap),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand('find game -name "*.exe" -exec rm -f {} +', workspace, snap),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand('echo .papercup/data/results/scenario.jsonl | xargs rm -f', workspace, snap),
        null
      );
      assert.notEqual(
        detectBlockedProtectedBashCommand('find .papercup/data/results -name "*.jsonl" | xargs rm -f', workspace, snap),
        null
      );

      // Channel 6: pip intermediate flags, uv run --with, npm ci
      for (const pkgCmd of [
        'pip --quiet install capstone',
        'python -m pip -v install requests',
        'uv run --with capstone python a.py',
        'npm ci',
        'npm --prefix /tmp install lodash',
        'bash -c "pip --quiet install capstone"',
      ]) {
        assert.notEqual(
          detectBlockedHostMutationCommand(pkgCmd),
          null,
          `Expected host mutation guard to block: ${pkgCmd}`
        );
      }

      // Channel 7: cross-segment `cd` host package directory search
      for (const searchCmd of [
        'cd /c/Python312/Lib/site-packages && rg vn_learn_skill',
        'D=/c/Python312/Lib/site-packages; rg vn_learn_skill $D',
        'bash -c "cd /usr/local/lib/node_modules && find . -name \'*.js\'"',
      ]) {
        assert.notEqual(
          detectBlockedHostSearchCommand(searchCmd, workspace),
          null,
          `Expected host search guard to block: ${searchCmd}`
        );
      }

      // Legitimate commands: 0 false positives across EVERY guard
      const legitimateCmds = [
        'powershell -NoProfile -Command "Get-WinEvent -MaxEvents 1"',
        'find . -name "*.tmp" -delete',
        'find .papercup/tmp -name "*.tmp" -delete',
        'rg "hello" .papercup/tmp/unpacked/',
        'cp .papercup/tmp/a.txt .papercup/tmp/unpacked/a.txt',
        'python -c "if 2 > 1: start = 1; print(1 << 8, start)"',
        'ls in_ws.txt && echo workspace_ok',
        'head -n 1 .papercup/data/results/scenario.jsonl',
        '(cd .papercup/tmp && echo ok); touch .papercup/tmp/local.txt',
      ];
      for (const okCmd of legitimateCmds) {
        assert.equal(detectBlockedSecretCommand(okCmd, workspace), null, `secret FP: ${okCmd}`);
        assert.equal(detectBlockedHostMutationCommand(okCmd), null, `hostMutation FP: ${okCmd}`);
        assert.equal(detectBlockedHostSearchCommand(okCmd, workspace), null, `hostSearch FP: ${okCmd}`);
        assert.equal(detectBlockedBashHeredocCommand(okCmd), null, `heredoc FP: ${okCmd}`);
        assert.equal(detectBlockedProcessControlCommand(okCmd), null, `process FP: ${okCmd}`);
        assert.equal(detectBlockedExternalWriteCommand(okCmd, workspace), null, `extWrite FP: ${okCmd}`);
        assert.equal(detectBlockedProtectedBashCommand(okCmd, workspace, snap), null, `protected FP: ${okCmd}`);
      }
    });
  });
});

describe('Protected File Auto-Rollback, Sample Hash, Dir Scoping, TOML & Config (guarded-tools.ts, config.ts)', () => {
  test('afterRun and onThrow both force error reporting and atomically restore tampered/deleted .papercup/data/results/*.jsonl', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      const resultsDir = path.join(workspace, '.papercup', 'data', 'results');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.mkdirSync(path.join(workspace, 'game'), { recursive: true });
      const origScenario = '{"id":1,"source":"おはよう","target":"早上好"}\n';
      const origUi = '{"id":2,"source":"開始","target":"开始"}\n';
      const scenarioPath = path.join(resultsDir, 'scenario.jsonl');
      const uiPath = path.join(resultsDir, 'ui.jsonl');
      const roguePath = path.join(resultsDir, 'rogue.jsonl');
      const dllPath = path.join(workspace, 'game', 'engine.dll');

      fs.writeFileSync(scenarioPath, origScenario, 'utf8');
      fs.writeFileSync(uiPath, origUi, 'utf8');
      fs.writeFileSync(dllPath, 'MZ-DLL-ORIG', 'utf8');

      const guarded = createGuardedBuiltinToolDefinitions(workspace, ['bash'], {
        bashPath: config.bashPath,
        homeDir,
      });
      const bashTool = guarded[0];

      // 1. afterRun path (bash exits 0 after indirect node tamper)
      const tamperOkExitCmd =
        `node -e "const fs=require('fs'); ` +
        `fs.appendFileSync('.papercup/data/results/scenario.jsonl','CORRUPTED\\n'); ` +
        `fs.unlinkSync('.papercup/data/results/ui.jsonl'); ` +
        `fs.writeFileSync('.papercup/data/results/rogue.jsonl','{}\\n'); ` +
        `fs.appendFileSync('game/engine.dll','X');"`;

      const res1 = (await bashTool.execute(
        'tc-after',
        { command: tamperOkExitCmd },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(res1?.isError, true, 'afterRun protected mutation MUST force isError: true');
      const text1 = String(res1?.content?.[0]?.text || '');
      assert.equal(text1.includes('PROTECTED FILE MUTATION DETECTED'), true);
      const muts1 = (res1?.details?.protectedFileMutations || []) as Array<{
        rel: string;
        change: string;
        restored?: boolean;
      }>;
      assert.equal(
        muts1.some((m) => m.rel === '.papercup/data/results/scenario.jsonl' && m.change === 'modified' && m.restored === true),
        true
      );
      assert.equal(
        muts1.some((m) => m.rel === '.papercup/data/results/ui.jsonl' && m.change === 'deleted' && m.restored === true),
        true
      );
      assert.equal(
        muts1.some((m) => m.rel === '.papercup/data/results/rogue.jsonl' && m.change === 'created' && m.restored === true),
        true
      );
      assert.equal(
        muts1.some((m) => m.rel === 'game/engine.dll' && m.change === 'modified'),
        true
      );

      // Verify disk restoration
      assert.equal(fs.readFileSync(scenarioPath, 'utf8'), origScenario);
      assert.equal(fs.readFileSync(uiPath, 'utf8'), origUi);
      assert.equal(fs.existsSync(roguePath), false);

      // 2. onThrow path (bash exits non-zero after deleting .papercup/data/results/scenario.jsonl)
      const tamperFailExitCmd = `node -e "const fs=require('fs'); fs.unlinkSync('.papercup/data/results/scenario.jsonl'); process.exit(1);"`;
      let observedFailText = '';
      try {
        const res2 = (await bashTool.execute(
          'tc-throw',
          { command: tamperFailExitCmd },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.equal(res2?.isError, true);
        observedFailText = String(res2?.content?.[0]?.text || '');
      } catch (err: any) {
        observedFailText = String(err?.message || err);
      }
      assert.equal(
        observedFailText.includes('PROTECTED FILE MUTATION DETECTED'),
        true,
        `onThrow path must prepend mutation warning, got: ${observedFailText}`
      );
      assert.equal(
        fs.readFileSync(scenarioPath, 'utf8'),
        origScenario,
        'onThrow path must atomically restore deleted .papercup/data/results/scenario.jsonl'
      );
    });
  });

  test('sampleHash defeats same-length in-place patching with preserved mtime (both <=4MiB and >4MiB)', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      fs.mkdirSync(path.join(workspace, 'game'), { recursive: true });
      const smallExe = path.join(workspace, 'game', 'Game.exe');
      const largeDll = path.join(workspace, 'game', 'huge_runtime.dll');
      fs.writeFileSync(smallExe, Buffer.alloc(1024, 0x41));
      fs.writeFileSync(largeDll, Buffer.alloc(5 * 1024 * 1024, 0x42));

      const beforeSnap = collectProtectedWorkspaceSnapshot(workspace, homeDir);
      assert.ok(beforeSnap.get('game/game.exe')?.sampleHash || beforeSnap.get('game/Game.exe')?.sampleHash);

      // Patch 1 byte in-place in smallExe (middle) and largeDll (near tail) & restore exact mtime
      for (const [filePath, offset] of [
        [smallExe, 512],
        [largeDll, 5 * 1024 * 1024 - 16],
      ] as const) {
        const st = fs.statSync(filePath);
        const fd = fs.openSync(filePath, 'r+');
        try {
          const patchByte = Buffer.from([0x99]);
          fs.writeSync(fd, patchByte, 0, 1, offset);
        } finally {
          fs.closeSync(fd);
        }
        fs.utimesSync(filePath, st.atime, st.mtime);
      }

      const afterSnap = collectProtectedWorkspaceSnapshot(workspace, homeDir);
      const diff = diffProtectedWorkspaceSnapshots(beforeSnap, afterSnap);
      assert.equal(
        diff.some((m) => m.rel === 'game/Game.exe' && m.change === 'modified'),
        true,
        'Same-length utime patch on <=4 MiB binary must be detected'
      );
      assert.equal(
        diff.some((m) => m.rel === 'game/huge_runtime.dll' && m.change === 'modified'),
        true,
        'Same-length utime patch on >4 MiB binary must be detected by head/mid/tail sampleHash'
      );
    });
  });

  test('protects release/Game.exe & build/engine.dll while excluding patch/, .papercup/tmp/, and non-binary data artifacts', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      fs.mkdirSync(path.join(workspace, 'release'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'build'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'work'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'patch', 'files'), { recursive: true });
      fs.mkdirSync(path.join(workspace, '.papercup', 'tmp', 'unpacked'), { recursive: true });
      fs.mkdirSync(path.join(workspace, '.papercup', 'tmp', 'work', 'out'), { recursive: true });
      fs.mkdirSync(path.join(workspace, '.papercup', 'data', 'build'), { recursive: true });
      fs.mkdirSync(path.join(workspace, '.papercup', 'data', 'release'), { recursive: true });

      fs.writeFileSync(path.join(workspace, 'release', 'Game.exe'), 'MZ-REL', 'utf8');
      fs.writeFileSync(path.join(workspace, 'build', 'engine.dll'), 'MZ-BLD', 'utf8');
      fs.writeFileSync(path.join(workspace, 'work', 'Game.exe'), 'MZ-WRK', 'utf8');
      fs.writeFileSync(path.join(workspace, 'patch', 'files', 'Game.exe'), 'MZ-PATCH', 'utf8');

      // Protected binaries under release/, build/, work/ are NOT blanket-exempted
      for (const protectedRel of ['release/Game.exe', 'build/engine.dll', 'work/Game.exe']) {
        assert.notEqual(
          detectBlockedProtectedFilePath(protectedRel, workspace, 'write', homeDir),
          null,
          `${protectedRel} must be protected`
        );
      }
      const snap = collectProtectedWorkspaceSnapshot(workspace, homeDir);
      assert.equal(
        Array.from(snap.values()).some((e) => e.rel === 'release/Game.exe'),
        true
      );
      assert.equal(
        Array.from(snap.values()).some((e) => e.rel === 'build/engine.dll'),
        true
      );
      assert.equal(
        Array.from(snap.values()).some((e) => e.rel.startsWith('patch/')),
        false,
        'Built-in patch/ directory must be excluded from protected workspace snapshot'
      );

      // Paper Cup internal dirs, patch/ output, and non-binary data files remain writable
      const tools = createGuardedBuiltinToolDefinitions(workspace, ['write'], { homeDir });
      const writeTool = tools[0];
      for (const allowedRel of [
        '.papercup/tmp/probe.dll',
        '.papercup/tmp/unpacked/test.dll',
        '.papercup/tmp/work/out/batch_000.jsonl',
        '.papercup/data/build/scenario.jsonl',
        '.papercup/data/release/RELEASE_NOTES.md',
        'patch/files/Game.exe',
        'patch/README.md',
      ]) {
        assert.equal(
          detectBlockedProtectedFilePath(allowedRel, workspace, 'write', homeDir),
          null,
          `${allowedRel} must remain writable`
        );
        const wRes = (await writeTool.execute(
          'w-ok',
          { path: allowedRel, content: 'ok\n' },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.notEqual(wRes?.isError, true, `write(${allowedRel}) should succeed`);
      }
    });
  });

  test('readVnResearchConfig parses inline # comments in papercup.toml and .papercup/data/vn/profile.toml', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      // 1. papercup.toml with section & value inline comments
      fs.writeFileSync(
        path.join(workspace, 'papercup.toml'),
        [
          '[vn.research] # research tuning section',
          'max_reverser_tool_calls = 80 # bumped for custom engine',
          'main_bash_timeout_sec = 55 # seconds',
          'reverser_bash_timeout_sec = 42 # seconds',
          'max_consecutive_failures = 4 # pivot threshold',
        ].join('\n') + '\n',
        'utf8'
      );
      const fromPapercup = readVnResearchConfig(workspace);
      assert.equal(fromPapercup.maxReverserToolCalls, 80);
      assert.equal(fromPapercup.mainBashTimeoutSec, 55);
      assert.equal(fromPapercup.reverserBashTimeoutSec, 42);
      assert.equal(fromPapercup.maxConsecutiveFailures, 4);

      // 2. .papercup/data/vn/profile.toml takes priority over papercup.toml
      fs.mkdirSync(path.join(workspace, '.papercup', 'data', 'vn'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, '.papercup', 'data', 'vn', 'profile.toml'),
        '[vn.research] # profile override\nmax_reverser_tool_calls = 65 # override\nmain_bash_timeout_sec = 70 # override\n',
        'utf8'
      );
      const fromProfile = readVnResearchConfig(workspace);
      assert.equal(fromProfile.maxReverserToolCalls, 65);
      assert.equal(fromProfile.mainBashTimeoutSec, 70);

      // 3. Env override takes precedence over TOML
      process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS = '95';
      const fromEnv = readVnResearchConfig(workspace);
      assert.equal(fromEnv.maxReverserToolCalls, 95);
    });
  });

  test('config.ts resolves executables dynamically without hardcoded personal drives and honors env overrides', async () => {
    await withIsolatedSandbox(async ({ root, homeDir }) => {
      // 1. resolvePapercupConfigDir tracks isolated HOME/USERPROFILE
      assert.equal(resolvePapercupConfigDir(), path.join(homeDir, '.papercup'));

      // 2. Static check: config.ts must not hardcode personal drive paths D:\Git or E:\Git
      const configSrc = fs.readFileSync(path.resolve(process.cwd(), 'src', 'config.ts'), 'utf8');
      assert.equal(/['"][DE]:\\\\Git\\\\bin\\\\bash\.exe['"]/i.test(configSrc), false);

      // 3. Current process resolved config sanity
      assert.equal(typeof config.pythonPath, 'string');
      assert.ok(config.pythonPath.trim().length > 0);
      if (process.platform === 'win32' && config.bashPath) {
        assert.equal(fs.existsSync(config.bashPath), true, `Resolved bashPath must exist: ${config.bashPath}`);
        assert.equal(config.bashPath.toLowerCase().includes('\\system32\\'), false);
      }

      // 4. Env overrides PAPERCUP_PYTHON and PAPERCUP_SHELL honored in fresh module load
      const fakePy = path.join(root, 'custom-python.exe');
      const fakeBash = path.join(root, 'custom-bash.exe');
      fs.writeFileSync(fakePy, '', 'utf8');
      fs.writeFileSync(fakeBash, '', 'utf8');
      const probeOut = execFileSync(
        process.execPath,
        ['--import', 'tsx', '-e', "import { config } from './src/config.js'; console.log(JSON.stringify(config));"],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            PAPERCUP_PYTHON: fakePy,
            PAPERCUP_SHELL: fakeBash,
          },
          timeout: 15000,
          windowsHide: true,
        }
      ).trim();
      const parsedCfg = JSON.parse(probeOut.split(/\r?\n/).pop() || '{}');
      assert.equal(parsedCfg.pythonPath, fakePy);
      if (process.platform === 'win32') {
        assert.equal(parsedCfg.bashPath, fakeBash);
      }
    });
  });
});

describe('Reverser Defaults & Budget/Thinking Contract (roles.ts, guarded-tools.ts, subagent-manager.ts)', () => {
  test('reverser defaults to max thinking level and clamps cleanly across max / xhigh / high / non-reasoning models', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      assert.equal(BUILTIN_SUBAGENTS.reverser.defaultThinkingLevel, 'max');

      const faux = createFauxCore({
        provider: 'faux-thinking-contract',
        tokensPerSecond: 100000,
        models: [{ id: 'base-reasoning', reasoning: true }],
      });
      const baseModel = faux.getModel();

      const cases: Array<{ label: string; model: any; expected: string }> = [
        {
          label: 'max-capable reasoning model',
          model: { ...baseModel, id: 'model-max', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
          expected: 'max',
        },
        {
          label: 'xhigh-only reasoning model (no max)',
          model: { ...baseModel, id: 'model-xhigh', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } },
          expected: 'xhigh',
        },
        {
          label: 'standard reasoning model (up to high)',
          model: { ...baseModel, id: 'model-high', reasoning: true },
          expected: 'high',
        },
        {
          label: 'non-reasoning model',
          model: { ...baseModel, id: 'model-plain', reasoning: false },
          expected: 'off',
        },
      ];

      // 1. Direct createSubagentSession clamping check (unmodified SubagentManager)
      const directMgr = new SubagentManager();
      for (const tc of cases) {
        const { session } = await directMgr.createSubagentSession('reverser', {
          cwd: workspace,
          model: tc.model,
        });
        try {
          assert.equal(
            session.thinkingLevel,
            tc.expected,
            `createSubagentSession('reverser') for ${tc.label} must clamp to '${tc.expected}', got '${session.thinkingLevel}'`
          );
        } finally {
          session.dispose?.();
        }
      }

      // 2. Managed session + snapshot + metrics + summary reflect actual model-clamped thinkingLevel
      const managedMgr = new SubagentManager();
      const origCreate = managedMgr.createSubagentSession.bind(managedMgr);
      managedMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate(roleName, opts);
        // Attach offline stream transport ONLY — leave session.model and session.thinkingLevel untouched
        (res.session as any).agent.streamFunction = faux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      for (const tc of cases) {
        faux.setResponses([() => fauxAssistantMessage(`checked:${tc.expected}`)]);
        const managed = await managedMgr.createManagedSubagentSession('reverser', {
          cwd: workspace,
          model: tc.model,
        });
        try {
          const result = await managed.prompt(`Probe thinking clamp for ${tc.label}`);
          assert.equal(
            result.snapshot.thinkingLevel,
            tc.expected,
            `snapshot.thinkingLevel for ${tc.label} must be '${tc.expected}', got '${result.snapshot.thinkingLevel}'`
          );
          assert.equal(
            result.metrics.thinkingLevel,
            tc.expected,
            `metrics.thinkingLevel for ${tc.label} must be '${tc.expected}', got '${result.metrics.thinkingLevel}'`
          );
          assert.equal(
            toSubagentTaskSummary(result.snapshot).thinkingLevel,
            tc.expected,
            `summary.thinkingLevel for ${tc.label} must be '${tc.expected}'`
          );
        } finally {
          managed.dispose();
        }
      }
    });
  });

  test('create_subagent tool accepts xhigh and max thinkingLevel in schema and runtime profile creation', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      const mgr = new SubagentManager();
      const tools = mgr.createTools(() => workspace);
      const createTool = tools.find((t) => t.name === 'create_subagent')!;
      assert.ok(createTool, 'Expected create_subagent tool');

      const thinkingSchema = (createTool.parameters as any)?.properties?.thinkingLevel;
      const schemaLiterals: string[] = Array.isArray(thinkingSchema?.anyOf)
        ? thinkingSchema.anyOf.map((item: any) => item?.const).filter((v: unknown) => typeof v === 'string')
        : [];
      assert.equal(schemaLiterals.includes('xhigh'), true, `Schema must allow 'xhigh', got: ${JSON.stringify(schemaLiterals)}`);
      assert.equal(schemaLiterals.includes('max'), true, `Schema must allow 'max', got: ${JSON.stringify(schemaLiterals)}`);

      const xhighRes = (await createTool.execute(
        'tc-create-xhigh',
        {
          name: 'deep_probe_xhigh',
          description: 'Deep probe with xhigh thinking',
          instructions: 'Analyze binary headers thoroughly.',
          allowedTools: ['read'],
          thinkingLevel: 'xhigh',
        },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(xhighRes?.isError, true, `create_subagent(thinkingLevel='xhigh') failed: ${JSON.stringify(xhighRes)}`);
      assert.equal(mgr.getProfile('deep_probe_xhigh')?.defaultThinkingLevel, 'xhigh');

      const maxRes = (await createTool.execute(
        'tc-create-max',
        {
          name: 'deep_probe_max',
          description: 'Deep probe with max thinking',
          instructions: 'Analyze container format thoroughly.',
          allowedTools: ['read'],
          thinkingLevel: 'max',
        },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(maxRes?.isError, true, `create_subagent(thinkingLevel='max') failed: ${JSON.stringify(maxRes)}`);
      assert.equal(mgr.getProfile('deep_probe_max')?.defaultThinkingLevel, 'max');

      const faux = createFauxCore({ provider: 'faux-dyn-think', models: [{ id: 'base', reasoning: true }] });
      const maxModel = { ...faux.getModel(), id: 'dyn-max', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } };
      const highModel = { ...faux.getModel(), id: 'dyn-high', reasoning: true };

      const s1 = await mgr.createSubagentSession('deep_probe_xhigh', { cwd: workspace, model: maxModel });
      const s2 = await mgr.createSubagentSession('deep_probe_max', { cwd: workspace, model: maxModel });
      const s3 = await mgr.createSubagentSession('deep_probe_max', { cwd: workspace, model: highModel });
      try {
        assert.equal(s1.session.thinkingLevel, 'xhigh');
        assert.equal(s2.session.thinkingLevel, 'max');
        assert.equal(s3.session.thinkingLevel, 'high');
      } finally {
        s1.session.dispose?.();
        s2.session.dispose?.();
        s3.session.dispose?.();
      }
    });
  });

  test('reverser default limits disable hard-stop/stall/tool caps (0) & set 1h duration, honoring explicit 0/positive overrides while ignoring invalid values', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      assert.equal(DEFAULT_HARD_STOP_CONSECUTIVE_FAILURES, 0);
      assert.equal(DEFAULT_MAX_REVERSER_STALL_CALLS, 0);
      assert.equal(DEFAULT_MAX_REVERSER_TOOL_CALLS, 0);
      assert.equal(DEFAULT_MAX_REVERSER_DURATION_MS, 60 * 60 * 1000);

      // 1. Clean default workspace
      const defaultCfg = readVnResearchConfig(workspace);
      assert.equal(defaultCfg.hardStopConsecutiveFailures, 0);
      assert.equal(defaultCfg.maxReverserStallCalls, 0);
      assert.equal(defaultCfg.maxReverserToolCalls, 0);
      assert.equal(defaultCfg.maxReverserDurationMs, 60 * 60 * 1000);

      const tomlPath = path.join(workspace, 'papercup.toml');

      // 2. Explicit positive TOML caps
      fs.writeFileSync(
        tomlPath,
        '[vn.research]\nmax_reverser_tool_calls = 35\nhard_stop_consecutive_failures = 5\nmax_reverser_stall_calls = 8\n',
        'utf8'
      );
      const posCfg = readVnResearchConfig(workspace);
      assert.equal(posCfg.maxReverserToolCalls, 35);
      assert.equal(posCfg.hardStopConsecutiveFailures, 5);
      assert.equal(posCfg.maxReverserStallCalls, 8);

      // 3. Explicit env = "0" overrides positive TOML back to disabled/unlimited (0)
      process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS = '0';
      process.env.PAPERCUP_REVERSER_HARD_STOP_FAILURES = '0';
      process.env.PAPERCUP_REVERSER_MAX_STALL_CALLS = '0';
      const zeroEnvCfg = readVnResearchConfig(workspace);
      assert.equal(zeroEnvCfg.maxReverserToolCalls, 0);
      assert.equal(zeroEnvCfg.hardStopConsecutiveFailures, 0);
      assert.equal(zeroEnvCfg.maxReverserStallCalls, 0);
      delete process.env.PAPERCUP_REVERSER_HARD_STOP_FAILURES;
      delete process.env.PAPERCUP_REVERSER_MAX_STALL_CALLS;

      // 4. Negative and non-numeric env values are ignored (preserve TOML positive 35)
      for (const badEnv of ['-1', '-99', 'abc', 'NaN', '   ']) {
        process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS = badEnv;
        assert.equal(
          readVnResearchConfig(workspace).maxReverserToolCalls,
          35,
          `Invalid env PAPERCUP_REVERSER_MAX_TOOL_CALLS="${badEnv}" must be ignored`
        );
      }
      delete process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS;

      // 5. Explicit TOML = 0 disables duration/tool/stall/hard-stop caps, and positive env overrides it
      fs.writeFileSync(tomlPath, '[vn.research]\nmax_reverser_tool_calls = 0\nmax_reverser_duration_ms = 0\n', 'utf8');
      const zeroTomlCfg = readVnResearchConfig(workspace);
      assert.equal(zeroTomlCfg.maxReverserToolCalls, 0);
      assert.equal(zeroTomlCfg.maxReverserDurationMs, 0);
      process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS = '22';
      assert.equal(readVnResearchConfig(workspace).maxReverserToolCalls, 22);
      delete process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS;

      // 6. Negative / non-numeric TOML values are ignored and fall back to defaults
      fs.writeFileSync(
        tomlPath,
        '[vn.research]\nmax_reverser_tool_calls = -5\nmax_reverser_duration_ms = -1000\nhard_stop_consecutive_failures = -2\nmax_reverser_stall_calls = -3\n',
        'utf8'
      );
      const invalidNumCfg = readVnResearchConfig(workspace);
      assert.equal(invalidNumCfg.maxReverserToolCalls, 0);
      assert.equal(invalidNumCfg.maxReverserDurationMs, 60 * 60 * 1000);
      assert.equal(invalidNumCfg.hardStopConsecutiveFailures, 0);
      assert.equal(invalidNumCfg.maxReverserStallCalls, 0);

      fs.writeFileSync(
        tomlPath,
        '[vn.research]\nmax_reverser_tool_calls = "unlimited"\nmax_reverser_duration_ms = "forever"\n',
        'utf8'
      );
      const invalidStrCfg = readVnResearchConfig(workspace);
      assert.equal(invalidStrCfg.maxReverserToolCalls, 0);
      assert.equal(invalidStrCfg.maxReverserDurationMs, 60 * 60 * 1000);
    });
  });

  test('unlimited default (0) allows >50 reverser tool calls without abort or [预算提醒] and omits maxToolCalls from snapshot/summary', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      assert.equal(readVnResearchConfig(workspace).maxReverserToolCalls, 0);

      const faux = createFauxCore({
        provider: 'faux-unlimited-reverser',
        tokensPerSecond: 100000,
        models: [{ id: 'rev-unlimited', reasoning: true }],
      });
      const mgr = new SubagentManager();
      const origCreate = mgr.createSubagentSession.bind(mgr);
      mgr.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate(roleName, opts);
        (res.session as any).agent.streamFunction = faux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      const TOTAL_CALLS = 54;
      const observedToolTexts: string[] = [];
      const steps: Array<(ctx?: any) => any> = [];
      for (let i = 1; i <= TOTAL_CALLS; i++) {
        const prevId = i > 1 ? `tc-unlim-${i - 1}` : null;
        steps.push((ctx?: any) => {
          if (prevId && ctx?.messages) {
            const prevRes = ctx.messages.find((m: any) => m.role === 'toolResult' && m.toolCallId === prevId);
            observedToolTexts.push(String(prevRes?.content?.[0]?.text || ''));
          }
          // Periodically write a scratch file so stall-stop (15 calls without progress) does not trigger
          if (i % 10 === 0) {
            return fauxAssistantMessage([
              fauxToolCall(
                'write',
                { path: `.papercup/tmp/probe_${i}.txt`, content: `step ${i}\n` },
                { id: `tc-unlim-${i}` }
              ),
            ]);
          }
          return fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: `tc-unlim-${i}` })]);
        });
      }
      steps.push((ctx?: any) => {
        const lastRes = ctx?.messages?.find(
          (m: any) => m.role === 'toolResult' && m.toolCallId === `tc-unlim-${TOTAL_CALLS}`
        );
        observedToolTexts.push(String(lastRes?.content?.[0]?.text || ''));
        return fauxAssistantMessage('Completed 54 tool calls cleanly without budget cap.');
      });
      faux.setResponses(steps);

      const seenSummaries: SubagentTaskSummary[] = [];
      const seenSnapshots: SubagentTaskSnapshot[] = [];
      try {
        const result = await mgr.runSubagentWithMetrics('reverser', 'Run deep unlimited inspection', {
          cwd: workspace,
          model: faux.getModel(),
          recordDiagnostics: true,
          onTaskUpdated: (summary, snapshot) => {
            seenSummaries.push(summary);
            seenSnapshots.push(snapshot);
          },
        });

        assert.equal(result.snapshot.status, 'completed');
        assert.equal(result.snapshot.toolCallCount, TOTAL_CALLS);
        assert.equal(result.metrics.toolCalls.length, TOTAL_CALLS);
        assert.equal(observedToolTexts.length, TOTAL_CALLS);
        assert.equal(
          observedToolTexts.some((t) => t.includes('[预算提醒]')),
          false,
          'Unlimited reverser must NEVER emit [预算提醒] notices'
        );

        // Running & completed snapshots and summaries must omit maxToolCalls
        assert.ok(seenSummaries.some((s) => s.status === 'running'), 'Expected at least one running task update');
        for (const s of seenSummaries) {
          assert.equal(s.maxToolCalls, undefined);
          assert.equal('maxToolCalls' in s, false, `Summary must omit maxToolCalls key when unlimited: ${JSON.stringify(s)}`);
        }
        for (const snap of seenSnapshots) {
          assert.equal(snap.maxToolCalls, undefined);
        }
        assert.equal(result.snapshot.maxToolCalls, undefined);
        const finalSummary = toSubagentTaskSummary(result.snapshot);
        assert.equal(finalSummary.maxToolCalls, undefined);
        assert.equal('maxToolCalls' in finalSummary, false);
      } finally {
        mgr.disposeResumableSessions(workspace);
      }
    });
  });

  test('explicit positive PAPERCUP_REVERSER_MAX_TOOL_CALLS enforces tiered [预算提醒], exposes maxToolCalls, and aborts at cap', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      process.env.PAPERCUP_REVERSER_MAX_TOOL_CALLS = '10';
      assert.equal(readVnResearchConfig(workspace).maxReverserToolCalls, 10);

      const faux = createFauxCore({
        provider: 'faux-capped-reverser',
        tokensPerSecond: 100000,
        models: [{ id: 'rev-capped', reasoning: true }],
      });
      const mgr = new SubagentManager();
      const origCreate = mgr.createSubagentSession.bind(mgr);
      mgr.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate(roleName, opts);
        (res.session as any).agent.streamFunction = faux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      const toolTextByCall: Record<number, string> = {};
      const steps: Array<(ctx?: any) => any> = [];
      for (let i = 1; i <= 11; i++) {
        const prev = i - 1;
        steps.push((ctx?: any) => {
          if (prev >= 1 && ctx?.messages) {
            const prevRes = ctx.messages.find((m: any) => m.role === 'toolResult' && m.toolCallId === `tc-cap-${prev}`);
            toolTextByCall[prev] = String(prevRes?.content?.[0]?.text || '');
          }
          return fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: `tc-cap-${i}` })]);
        });
      }
      steps.push(() => fauxAssistantMessage('should never reach after hard cap abort'));
      faux.setResponses(steps);

      const seenSummaries: SubagentTaskSummary[] = [];
      try {
        let caughtErr: any = null;
        try {
          await mgr.runSubagentWithMetrics('reverser', 'Run capped inspection', {
            cwd: workspace,
            model: faux.getModel(),
            onTaskUpdated: (summary) => {
              seenSummaries.push(summary);
            },
          });
        } catch (err) {
          caughtErr = err;
        }

        assert.ok(caughtErr, 'Expected reverser to abort when exceeding explicit cap of 10 tool calls');
        assert.equal(caughtErr.metrics?.status, 'aborted');
        assert.equal(
          String(caughtErr.message || '').includes('单轮工具调用上限（10 次）'),
          true,
          `Unexpected abort message: ${caughtErr.message}`
        );
        assert.equal(caughtErr.snapshot?.maxToolCalls, 10);
        assert.equal(toSubagentTaskSummary(caughtErr.snapshot).maxToolCalls, 10);
        assert.ok(
          seenSummaries.some((s) => s.status === 'running' && s.maxToolCalls === 10),
          'Running summary must expose explicit maxToolCalls=10'
        );

        // Verify tiered [预算提醒] notices at 50% (call 5), 75%/remaining 3 (call 7), remaining 2 (call 8), remaining 1 (call 9)
        assert.equal(toolTextByCall[5]?.includes('[预算提醒]') && toolTextByCall[5]?.includes('已用过半'), true, `Call 5/10 missing 50% notice: ${toolTextByCall[5]}`);
        assert.equal(toolTextByCall[7]?.includes('[预算提醒]') && toolTextByCall[7]?.includes('7/10'), true, `Call 7/10 missing 7/10 notice: ${toolTextByCall[7]}`);
        assert.equal(toolTextByCall[8]?.includes('[预算提醒]') && toolTextByCall[8]?.includes('仅剩 2 次'), true, `Call 8/10 missing remaining-2 notice: ${toolTextByCall[8]}`);
        assert.equal(toolTextByCall[9]?.includes('[预算提醒]') && toolTextByCall[9]?.includes('仅剩 1 次'), true, `Call 9/10 missing remaining-1 notice: ${toolTextByCall[9]}`);
      } finally {
        mgr.disposeResumableSessions(workspace);
      }
    });
  });

  test('default config never hard-stops on 6 consecutive failures (still injects soft pivot at 3rd) or prolonged read-only turns and omits maxStallCalls', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      fs.writeFileSync(path.join(workspace, 'note.txt'), 'sample\n', 'utf8');
      const cfg = readVnResearchConfig(workspace);
      assert.equal(cfg.hardStopConsecutiveFailures, 0);
      assert.equal(cfg.maxReverserStallCalls, 0);

      const faux = createFauxCore({
        provider: 'faux-no-hardstop',
        tokensPerSecond: 100000,
        models: [{ id: 'rev-no-hardstop', reasoning: true }],
      });
      const mgr = new SubagentManager();
      const origCreate = mgr.createSubagentSession.bind(mgr);
      mgr.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate(roleName, opts);
        (res.session as any).agent.streamFunction = faux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      let sawSoftPivotAtFail3 = false;
      const steps: Array<(ctx?: any) => any> = [];
      // 6 consecutive bash failures
      for (let i = 1; i <= 6; i++) {
        const prevFail = i - 1;
        steps.push((ctx?: any) => {
          if (prevFail === 3 && ctx?.messages) {
            const tr3 = ctx.messages.find((m: any) => m.role === 'toolResult' && m.toolCallId === 'tc-nh-f3');
            sawSoftPivotAtFail3 = String(tr3?.content?.[0]?.text || '').includes('[换路提醒 / PIVOT REQUIRED]');
          }
          return fauxAssistantMessage([
            fauxToolCall('bash', { command: `echo fail_${i}; exit 1` }, { id: `tc-nh-f${i}` }),
          ]);
        });
      }
      // Followed by 18 consecutive read-only calls (exceeding legacy 15 stall limit)
      for (let i = 1; i <= 18; i++) {
        steps.push(() => fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' }, { id: `tc-nh-r${i}` })]));
      }
      steps.push(() => fauxAssistantMessage('Completed 6 failures + 18 reads cleanly under default config.'));
      faux.setResponses(steps);

      const seenSummaries: SubagentTaskSummary[] = [];
      const seenSnapshots: SubagentTaskSnapshot[] = [];
      try {
        const res = await mgr.runSubagentWithMetrics('reverser', 'Verify default no hard-stop / no stall-stop', {
          cwd: workspace,
          model: faux.getModel(),
          onTaskUpdated: (summary, snapshot) => {
            seenSummaries.push(summary);
            seenSnapshots.push(snapshot);
          },
        });

        assert.equal(res.snapshot.status, 'completed');
        assert.equal(sawSoftPivotAtFail3, true, '3rd consecutive failure must still inject soft [换路提醒 / PIVOT REQUIRED]');
        assert.equal(res.snapshot.toolCallCount, 24);
        assert.equal(res.snapshot.errorCount, 6);
        assert.equal(res.snapshot.maxStallCalls, undefined);
        assert.equal('maxStallCalls' in toSubagentTaskSummary(res.snapshot), false);
        for (const s of seenSummaries) {
          assert.equal('maxStallCalls' in s, false, `Summary must omit maxStallCalls by default: ${JSON.stringify(s)}`);
        }
        for (const snap of seenSnapshots) {
          assert.equal(snap.maxStallCalls, undefined);
        }
      } finally {
        mgr.disposeResumableSessions(workspace);
      }
    });
  });

  test('explicit max_reverser_stall_calls=3 counts parallel read calls in one turn as a single stall turn rather than tripping immediately', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      fs.writeFileSync(path.join(workspace, 'a.txt'), 'A\n', 'utf8');
      fs.writeFileSync(path.join(workspace, 'b.txt'), 'B\n', 'utf8');
      fs.writeFileSync(path.join(workspace, 'c.txt'), 'C\n', 'utf8');
      fs.writeFileSync(path.join(workspace, 'd.txt'), 'D\n', 'utf8');
      fs.writeFileSync(
        path.join(workspace, 'papercup.toml'),
        '[vn.research]\nmax_reverser_stall_calls = 3\n',
        'utf8'
      );

      const faux = createFauxCore({
        provider: 'faux-parallel-stall',
        tokensPerSecond: 100000,
        models: [{ id: 'rev-parallel-stall', reasoning: true }],
      });
      const mgr = new SubagentManager();
      const origCreate = mgr.createSubagentSession.bind(mgr);
      mgr.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate(roleName, opts);
        (res.session as any).agent.streamFunction = faux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      let reachedTurn2 = false;
      let reachedTurn3 = false;
      faux.setResponses([
        // Turn 1: 4 concurrent read calls -> must count as only 1 stall turn (NOT >= 3!)
        () =>
          fauxAssistantMessage([
            fauxToolCall('read', { path: 'a.txt' }, { id: 'tc-ps-1a' }),
            fauxToolCall('read', { path: 'b.txt' }, { id: 'tc-ps-1b' }),
            fauxToolCall('read', { path: 'c.txt' }, { id: 'tc-ps-1c' }),
            fauxToolCall('read', { path: 'd.txt' }, { id: 'tc-ps-1d' }),
          ]),
        // Turn 2: 2 concurrent read calls -> stall turn #2 (still must NOT abort)
        () => {
          reachedTurn2 = true;
          return fauxAssistantMessage([
            fauxToolCall('read', { path: 'a.txt' }, { id: 'tc-ps-2a' }),
            fauxToolCall('read', { path: 'b.txt' }, { id: 'tc-ps-2b' }),
          ]);
        },
        // Turn 3: 1 read call -> stall turn #3 -> NOW triggers stall stop
        () => {
          reachedTurn3 = true;
          return fauxAssistantMessage([fauxToolCall('read', { path: 'c.txt' }, { id: 'tc-ps-3a' })]);
        },
        () => fauxAssistantMessage('should never reach after turn-3 stall stop'),
      ]);

      try {
        let caughtErr: any = null;
        try {
          await mgr.runSubagentWithMetrics('reverser', 'Test parallel read stall counting', {
            cwd: workspace,
            model: faux.getModel(),
          });
        } catch (err) {
          caughtErr = err;
        }
        assert.equal(reachedTurn2, true, '4 parallel reads in turn 1 must NOT trigger max_reverser_stall_calls=3 immediately');
        assert.equal(reachedTurn3, true, '2 parallel reads in turn 2 must count as stall turn 2 and allow entering turn 3');
        assert.ok(caughtErr, 'Expected turn 3 to trigger stall stop at max_reverser_stall_calls=3');
        assert.equal(caughtErr.metrics?.status, 'aborted');
        assert.ok(String(caughtErr.message || '').includes('停滞熔断'), `Unexpected error: ${caughtErr.message}`);
        assert.equal(caughtErr.snapshot?.maxStallCalls, 3);
      } finally {
        mgr.disposeResumableSessions(workspace);
      }
    });
  });

  test('timeout abort via max_reverser_duration_ms returns resumable=true and resumes in-place from warm cache without fallback', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      fs.writeFileSync(
        path.join(workspace, 'papercup.toml'),
        '[vn.research]\nmax_reverser_duration_ms = 220\n',
        'utf8'
      );

      const faux = createFauxCore({
        provider: 'faux-timeout-resume',
        tokensPerSecond: 100000,
        models: [{ id: 'rev-timeout-resume', reasoning: true }],
      });
      let createCount = 0;
      let delayThisStream = true;
      const mgr = new SubagentManager();
      const origCreate = mgr.createSubagentSession.bind(mgr);
      mgr.createSubagentSession = async (roleName, opts) => {
        createCount += 1;
        const res = await origCreate(roleName, opts);
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        (res.session as any).agent.streamFunction = (model: any, ctx: any, streamOpts: any) => {
          if (!delayThisStream) {
            return faux.streamSimple(model, ctx, streamOpts);
          }
          // Simulate an in-flight model HTTP stream (holds an active event-loop handle until aborted by budgetTimer)
          const sig: AbortSignal | undefined = streamOpts?.signal;
          const abortedPromise = new Promise<any>((resolve) => {
            const keepAlive = setTimeout(() => done(), 10_000);
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              clearTimeout(keepAlive);
              resolve({
                role: 'assistant',
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: 'aborted',
                errorMessage: 'Request was aborted.',
                timestamp: Date.now(),
              });
            };
            if (sig?.aborted) {
              done();
            } else {
              sig?.addEventListener('abort', done, { once: true });
            }
          });
          const stream = (async function* () {
            const msg = await abortedPromise;
            yield { type: 'error', reason: 'aborted', error: msg };
          })();
          (stream as any).result = () => abortedPromise;
          return stream;
        };
        return res;
      };

      try {
        // Turn 1: hits 220ms timeout -> must abort with interruptKind='timeout' & resumable=true
        let timeoutErr: any = null;
        try {
          await mgr.runSubagentWithMetrics('reverser', 'Initial probe seed-token-omega', {
            cwd: workspace,
            model: faux.getModel(),
          });
        } catch (err) {
          timeoutErr = err;
        }
        assert.ok(timeoutErr, 'Expected turn 1 to abort on max_reverser_duration_ms timeout');
        assert.equal(timeoutErr.interruptKind, 'timeout');
        assert.equal(timeoutErr.resumable, true, `Timeout abort must be resumable=true, got: ${JSON.stringify({ resumable: timeoutErr.resumable, msg: timeoutErr.message })}`);
        assert.ok(typeof timeoutErr.taskId === 'string' && timeoutErr.taskId.length > 0);
        assert.equal(createCount, 1);

        // Increase timeout for Turn 2 and resume in-place using resumeTaskId
        fs.writeFileSync(
          path.join(workspace, 'papercup.toml'),
          '[vn.research]\nmax_reverser_duration_ms = 60000\n',
          'utf8'
        );
        delayThisStream = false;
        let sawInitialHistory = false;
        faux.setResponses([
          (ctx) => {
            sawInitialHistory = JSON.stringify(ctx.messages).includes('seed-token-omega');
            return fauxAssistantMessage('Resumed in-place after timeout and completed.');
          },
        ]);

        const resumedRes = await mgr.runSubagentWithMetrics('reverser', 'Continue after timeout', {
          cwd: workspace,
          model: faux.getModel(),
          resumeTaskId: timeoutErr.taskId,
        });
        assert.equal(createCount, 1, 'Resuming timed-out task must reuse warm cached session without recreating');
        assert.equal(resumedRes.resumed, true);
        assert.equal(resumedRes.resumeFallback, false);
        assert.equal(resumedRes.resumedFromTaskId, timeoutErr.taskId);
        assert.equal(sawInitialHistory, true, 'Warm-resumed session must preserve turn 1 context');
        assert.equal(resumedRes.snapshot.status, 'completed');
      } finally {
        mgr.disposeResumableSessions(workspace);
      }
    });
  });
});

describe('Inline Interpreter External-Write Bash Guard (secrets.ts)', () => {
  test('blocks inline python/node external-write commands without false positives on read-only or workspace-internal calls', async () => {
    await withIsolatedSandbox(({ workspace }) => {
      const blockedCommands: Array<{ label: string; cmd: string; expectedRawSubstr: string }> = [
        {
          label: 'python -c open() write to external Windows absolute path',
          cmd: `python -c "p=r'C:/Users/tester/.papercup/projects/p1/harness/engine.json'; open(p,'w').write('{}')"`,
          expectedRawSubstr: 'C:/Users/tester/.papercup/projects/p1/harness/engine.json',
        },
        {
          label: 'python3 -c Path.home() write_text outside workspace',
          cmd: `python3 -c "import pathlib; (pathlib.Path.home() / '.papercup' / 'x.json').write_text('{}')"`,
          expectedRawSubstr: '~',
        },
        {
          label: 'node -e fs.writeFileSync to external Windows path',
          cmd: `node -e "require('fs').writeFileSync('C:/Users/tester/out.txt', 'x')"`,
          expectedRawSubstr: 'C:/Users/tester/out.txt',
        },
        {
          label: 'python -c shutil.copy2 to /tmp external path',
          cmd: `python -c "import shutil; shutil.copy2('a.txt', '/tmp/external_out.txt')"`,
          expectedRawSubstr: '/tmp/external_out.txt',
        },
        {
          label: 'node --eval=... fs.writeFileSync using process.env.USERPROFILE',
          cmd: `node --eval="const fs=require('fs'),p=require('path'); fs.writeFileSync(p.join(process.env.USERPROFILE,'out.json'),'{}')"`,
          expectedRawSubstr: '~',
        },
        {
          label: 'python -c open() append mode with expanduser(~)',
          cmd: `python -c "import os; open(os.path.expanduser('~/notes.txt'), 'a').write('x')"`,
          expectedRawSubstr: '~/notes.txt',
        },
      ];

      for (const { label, cmd, expectedRawSubstr } of blockedCommands) {
        const targets = extractBashWriteTargets(cmd, workspace);
        assert.ok(
          targets.some((t) => t.kind === 'write' && t.raw.includes(expectedRawSubstr)),
          `Expected extractBashWriteTargets to capture "${expectedRawSubstr}" for [${label}], got: ${JSON.stringify(targets)}`
        );
        const blocked = detectBlockedExternalWriteCommand(cmd, workspace);
        assert.notEqual(
          blocked,
          null,
          `Expected detectBlockedExternalWriteCommand to block [${label}]: ${cmd}`
        );
        assert.ok(
          blocked!.includes('outside active workspace'),
          `Expected outside-workspace error message for [${label}], got: ${blocked}`
        );
      }

      const allowedCommands: Array<{ label: string; cmd: string }> = [
        {
          label: 'read-only python -c open().read() on external path',
          cmd: `python -c "print(open(r'C:/Users/tester/foo.txt').read())"`,
        },
        {
          label: 'read-only python -c open(..., "r").read() on external path',
          cmd: `python -c "print(open(r'C:/Users/tester/foo.txt', 'r', encoding='utf-8').read())"`,
        },
        {
          label: 'read-only python -c os.listdir(expanduser("~"))',
          cmd: `python -c "import os; print(os.listdir(os.path.expanduser('~')))"`,
        },
        {
          label: 'workspace-internal python -c write under .papercup/tmp/',
          cmd: `python -c "open('.papercup/tmp/probe.txt', 'w').write('ok')"`,
        },
        {
          label: 'workspace-internal node -e fs.writeFileSync under .papercup/tmp/',
          cmd: `node -e "require('fs').writeFileSync('.papercup/tmp/a.json', '{}')"`,
        },
      ];

      for (const { label, cmd } of allowedCommands) {
        const blocked = detectBlockedExternalWriteCommand(cmd, workspace);
        assert.equal(
          blocked,
          null,
          `Unexpected false positive in detectBlockedExternalWriteCommand for [${label}]: ${blocked}`
        );
      }
    });
  });

  test('allows read-only external-source copy into workspace while blocking external dst, move, alias tricks, and mixed writes', async () => {
    await withIsolatedSandbox(({ workspace }) => {
      const allowedCopies: Array<{ label: string; cmd: string }> = [
        {
          label: 'python shutil.copyfile external font -> workspace tmp',
          cmd: `python -c "import shutil; shutil.copyfile(r'C:/Windows/Fonts/simhei.ttf', '.papercup/tmp/simhei.ttf')"`,
        },
        {
          label: 'python shutil.copy2 external font -> workspace tmp',
          cmd: `python -c "import shutil; shutil.copy2(r'C:/Windows/Fonts/msyh.ttc', '.papercup/tmp/msyh.ttc')"`,
        },
        {
          label: 'node fs.copyFileSync external -> workspace tmp',
          cmd: `node -e "const fs=require('fs'); fs.copyFileSync('C:/ext/a.ttf', '.papercup/tmp/a.ttf')"`,
        },
      ];

      for (const { label, cmd } of allowedCopies) {
        const blocked = detectBlockedExternalWriteCommand(cmd, workspace);
        assert.equal(
          blocked,
          null,
          `Expected copy-only external read to be allowed for [${label}], got: ${blocked}`
        );
      }

      const blockedMutations: Array<{ label: string; cmd: string }> = [
        {
          label: 'python shutil.copyfile workspace -> external dst',
          cmd: `python -c "import shutil; shutil.copyfile('.papercup/tmp/a.ttf', r'C:/ext/out.ttf')"`,
        },
        {
          label: 'node fs.copyFileSync workspace -> external dst',
          cmd: `node -e "const fs=require('fs'); fs.copyFileSync('.papercup/tmp/a.ttf', 'C:/ext/out.ttf')"`,
        },
        {
          label: 'python shutil.move external -> workspace',
          cmd: `python -c "import shutil; shutil.move('C:/ext/a', '.papercup/tmp/b')"`,
        },
        {
          label: 'node fs.renameSync external -> workspace',
          cmd: `node -e "require('fs').renameSync('C:/ext/a', '.papercup/tmp/b')"`,
        },
        {
          label: 'python shutil.copyfile keyword dst= external trick',
          cmd: `python -c "import shutil; shutil.copyfile(dst=r'C:/ext/out.ttf', src='.papercup/tmp/a')"`,
        },
        {
          label: 'python shutil.copyfile variable named dst external trick',
          cmd: `python -c "import shutil; dst=r'C:/ext/out.ttf'; shutil.copyfile(r'C:/Windows/Fonts/simhei.ttf', dst)"`,
        },
        {
          label: 'python shutil.copyfile transitive alias dst_ext trick',
          cmd: `python -c "import shutil; dst_ext=r'C:/ext/out.ttf'; alias_out=dst_ext; shutil.copyfile('.papercup/tmp/a', alias_out)"`,
        },
        {
          label: 'python shutil.copyfile unbound dst_ext with external src trick',
          cmd: `python -c "import shutil; shutil.copyfile(r'C:/ext/src.ttf', dst_ext)"`,
        },
        {
          label: 'mixed safe copy + external write in same command',
          cmd: `python -c "import shutil; shutil.copyfile(r'C:/Windows/Fonts/simhei.ttf', '.papercup/tmp/simhei.ttf'); open(r'C:/ext/hack.txt', 'w').write('x')"`,
        },
      ];

      for (const { label, cmd } of blockedMutations) {
        const blocked = detectBlockedExternalWriteCommand(cmd, workspace);
        assert.notEqual(
          blocked,
          null,
          `Expected detectBlockedExternalWriteCommand to block [${label}]: ${cmd}`
        );
      }
    });
  });

  test('createGuardedBuiltinToolDefinitions applies 90s default bash timeout, allows up to 300s, clamps 600s to 300s, and appends clamp notice on timeout', async () => {
    await withIsolatedSandbox(async ({ workspace }) => {
      assert.equal(DEFAULT_MAIN_BASH_MAX_TIMEOUT_SEC, 300);

      const tools = createGuardedBuiltinToolDefinitions(workspace, ['bash'], {
        bashPath: config.bashPath,
        defaultBashTimeoutSec: 90,
        maxBashTimeoutSec: DEFAULT_MAIN_BASH_MAX_TIMEOUT_SEC,
      });
      const bashTool = tools.find((t) => t.name === 'bash');
      assert.ok(bashTool, 'Expected guarded bash tool definition');

      const captureTimeoutMs = async (params: Record<string, unknown>): Promise<number[]> => {
        const recordedDelays: number[] = [];
        const origSetTimeout = globalThis.setTimeout;
        (globalThis as any).setTimeout = ((fn: any, delay?: any, ...args: any[]) => {
          if (typeof delay === 'number' && delay >= 10_000) {
            recordedDelays.push(delay);
          }
          return origSetTimeout(fn, delay, ...args);
        }) as typeof setTimeout;
        try {
          const res = (await bashTool.execute('t-cap', params, undefined, undefined, {} as any)) as any;
          assert.notEqual(res?.isError, true);
        } finally {
          globalThis.setTimeout = origSetTimeout;
        }
        return recordedDelays;
      };

      const omittedDelays = await captureTimeoutMs({ command: 'echo ok' });
      assert.ok(omittedDelays.includes(90_000), `Expected default 90s (90000ms) timeout when omitted, got: ${JSON.stringify(omittedDelays)}`);

      const explicit180Delays = await captureTimeoutMs({ command: 'echo ok', timeout: 180 });
      assert.ok(explicit180Delays.includes(180_000), `Expected explicit 180s (180000ms) timeout, got: ${JSON.stringify(explicit180Delays)}`);

      const clamped600Delays = await captureTimeoutMs({ command: 'echo ok', timeout: 600 });
      assert.ok(clamped600Delays.includes(300_000), `Expected explicit 600s clamped to 300s (300000ms), got: ${JSON.stringify(clamped600Delays)}`);
      assert.equal(clamped600Delays.includes(600_000), false, '600s must not be passed through unclamped');

      // Real timeout execution: verify onThrow appends the clamp notice when clamped timeout expires
      const shortTools = createGuardedBuiltinToolDefinitions(workspace, ['bash'], {
        bashPath: config.bashPath,
        defaultBashTimeoutSec: 1,
        maxBashTimeoutSec: 1,
      });
      const shortBash = shortTools.find((t) => t.name === 'bash')!;
      let timeoutErrMsg = '';
      try {
        await shortBash.execute('t-expire', { command: 'sleep 5', timeout: 600 }, undefined, undefined, {} as any);
      } catch (err) {
        timeoutErrMsg = err instanceof Error ? err.message : String(err);
      }
      assert.ok(
        timeoutErrMsg.includes('（显式超时 600s 已按安全上限裁剪为 1s）'),
        `Expected timeout error to include clamp notice, got: ${timeoutErrMsg}`
      );
    });
  });
});

describe('TODO #121 Host Registry/Font Mutation, Game Font Auto-Rollback & Main-Agent Reverser Guardrails (secrets.ts, guarded-tools.ts)', () => {
  test('blocks CLI, PowerShell, inline Python, and workspace script registry/font mutations while allowing read-only queries and safe nonexistent/outside paths', async () => {
    await withIsolatedSandbox(async ({ root, homeDir, workspace }) => {
      const tmpDir = path.join(workspace, '.papercup', 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });

      const regFontScript = path.join(tmpDir, 'registerfont.py');
      fs.writeFileSync(
        regFontScript,
        [
          'import winreg',
          'key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", 0, winreg.KEY_SET_VALUE)',
          'winreg.SetValueEx(key, "DemoFont (TrueType)", 0, winreg.REG_SZ, "Demo.ttf")',
        ].join('\n') + '\n',
        'utf8'
      );

      const gdiFontScript = path.join(tmpDir, 'add_gdi_font.py');
      fs.writeFileSync(
        gdiFontScript,
        [
          'import ctypes',
          'ctypes.windll.gdi32.AddFontResourceW("GameData/Demo.ttf")',
        ].join('\n') + '\n',
        'utf8'
      );

      const readOnlyScript = path.join(tmpDir, 'query_reg.py');
      fs.writeFileSync(
        readOnlyScript,
        [
          'try:',
          '    import winreg',
          'except ImportError:',
          '    winreg = None',
          'if False and winreg is not None:',
          '    k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment", 0, winreg.KEY_READ)',
          '    print(winreg.QueryValueEx(k, "TEMP"))',
          'print("REG_QUERY_ALLOWED")',
        ].join('\n') + '\n',
        'utf8'
      );

      // Outside-workspace script should NOT be read/crash the host mutation scanner
      const outsideScript = path.join(root, 'outside_reg.py');
      fs.writeFileSync(
        outsideScript,
        'import winreg\nwinreg.SetValueEx(None, "X", 0, winreg.REG_SZ, "Y")\n',
        'utf8'
      );

      // Direct script content checks
      assert.notEqual(
        detectHostMutationInScriptContent('import winreg\nwinreg.SetValueEx(k, "A", 0, winreg.REG_SZ, "B")'),
        null
      );
      assert.notEqual(
        detectHostMutationInScriptContent('import ctypes\nctypes.windll.gdi32.AddFontResourceW("a.ttf")'),
        null
      );
      assert.equal(
        detectHostMutationInScriptContent(
          'import winreg\nk = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment", 0, winreg.KEY_READ)\nprint(winreg.QueryValueEx(k, "TEMP"))'
        ),
        null
      );

      const blockedCmds = [
        'reg add "HKCU\\Software\\Demo" /v Font /t REG_SZ /d Demo.ttf /f',
        'reg.exe delete "HKCU\\Software\\Demo" /f',
        'powershell -NoProfile -Command "Set-ItemProperty -Path \'HKCU:\\Software\\Demo\' -Name Font -Value Demo.ttf"',
        'python -c "import winreg; winreg.SetValueEx(None, \'Demo\', 0, winreg.REG_SZ, \'Demo.ttf\')"',
        'python -c "import ctypes; ctypes.windll.gdi32.AddFontResourceW(\'a.ttf\')"',
        'python .papercup/tmp/registerfont.py',
        'cd .papercup/tmp && python registerfont.py',
        'python .papercup/tmp/add_gdi_font.py',
      ];
      for (const cmd of blockedCmds) {
        assert.notEqual(
          detectBlockedHostMutationCommand(cmd, workspace),
          null,
          `Expected detectBlockedHostMutationCommand to block: ${cmd}`
        );
      }

      const allowedCmds = [
        'reg query "HKCU\\Software\\Demo"',
        'python -c "import winreg; k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r\'Environment\', 0, winreg.KEY_READ); print(winreg.QueryValueEx(k, \'TEMP\'))"',
        'python .papercup/tmp/query_reg.py',
        'python .papercup/tmp/nonexistent_script.py',
        `python "${outsideScript.replace(/\\/g, '/')}"`,
      ];
      for (const cmd of allowedCmds) {
        assert.equal(
          detectBlockedHostMutationCommand(cmd, workspace),
          null,
          `Unexpected false positive in detectBlockedHostMutationCommand for: ${cmd}`
        );
      }

      // Guarded bash tool end-to-end checks
      const tools = createGuardedBuiltinToolDefinitions(workspace, ['bash'], {
        bashPath: config.bashPath,
        homeDir,
        agentRole: 'subagent',
      });
      const bashTool = tools[0];

      for (const cmd of blockedCmds) {
        const res = (await bashTool.execute('t-host-block', { command: cmd }, undefined, undefined, {} as any)) as any;
        assert.equal(res?.isError, true, `Expected guarded bash to block: ${cmd}`);
        assert.ok(
          String(res?.content?.[0]?.text || '').includes('Security guard:'),
          `Expected Security guard prefix for: ${cmd}`
        );
      }

      const okRes = (await bashTool.execute(
        't-host-ok',
        { command: 'python .papercup/tmp/query_reg.py' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(okRes?.isError, true);
      assert.ok(String(okRes?.content?.[0]?.text || '').includes('REG_QUERY_ALLOWED'));
    });
  });

  test('protects game original fonts (.ttf/.otf/.ttc) across write/edit/bash and auto-restores bypassed mutations without deleting new non-results fonts', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      const gameDir = path.join(workspace, 'game');
      const resultsDir = path.join(workspace, '.papercup', 'data', 'results');
      const patchFilesDir = path.join(workspace, 'patch', 'files');
      const tmpDir = path.join(workspace, '.papercup', 'tmp');
      fs.mkdirSync(gameDir, { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.mkdirSync(patchFilesDir, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      const origTtfBytes = Buffer.from('TTF-ORIGINAL-BYTES-0123456789ABCDEF');
      const origOtfBytes = Buffer.from('OTF-ORIGINAL-BYTES-FEDCBA9876543210');
      const origTtcBytes = Buffer.from('TTC-ORIGINAL-BYTES-1122334455667788');
      const origResultsBytes = '{"id":1,"source":"おはよう","target":"早上好"}\n';

      const ttfPath = path.join(gameDir, 'OrigFont.ttf');
      const otfPath = path.join(gameDir, 'SubFont.otf');
      const ttcPath = path.join(gameDir, 'Collection.ttc');
      const scenarioPath = path.join(resultsDir, 'scenario.jsonl');

      fs.writeFileSync(ttfPath, origTtfBytes);
      fs.writeFileSync(otfPath, origOtfBytes);
      fs.writeFileSync(ttcPath, origTtcBytes);
      fs.writeFileSync(scenarioPath, origResultsBytes, 'utf8');

      // 1. isProtectedGameFontRel boundary checks
      for (const rel of ['game/OrigFont.ttf', 'game/SubFont.otf', 'Collection.ttc']) {
        assert.equal(isProtectedGameFontRel(rel), true, `Expected protected font rel: ${rel}`);
      }
      for (const rel of [
        '.papercup/data/vn/fonts/files/game/OrigFont.ttf',
        '.papercup/tmp/OrigFont.ttf',
        'patch/files/OrigFont.ttf',
        'unpacked/OrigFont.ttf',
        'game/notes.txt',
      ]) {
        assert.equal(isProtectedGameFontRel(rel), false, `Expected excluded/non-font rel: ${rel}`);
      }

      const snap = collectProtectedWorkspaceSnapshot(workspace, homeDir);
      assert.equal(snap.get('game/origfont.ttf')?.category ?? snap.get('game/OrigFont.ttf')?.category, 'game_font');
      assert.equal(snap.get('game/subfont.otf')?.category ?? snap.get('game/SubFont.otf')?.category, 'game_font');
      assert.equal(snap.get('game/collection.ttc')?.category ?? snap.get('game/Collection.ttc')?.category, 'game_font');

      // 2. write / edit pre-exec blocking on game fonts while allowing .papercup/tmp/ and patch/files/
      for (const rel of ['game/OrigFont.ttf', 'game/SubFont.otf', 'game/NewDrop.ttc']) {
        assert.notEqual(detectBlockedProtectedFilePath(rel, workspace, 'write', homeDir), null);
        assert.notEqual(detectBlockedProtectedFilePath(rel, workspace, 'edit', homeDir), null);
      }
      assert.equal(detectBlockedProtectedFilePath('.papercup/tmp/probe.ttf', workspace, 'write', homeDir), null);
      assert.equal(detectBlockedProtectedFilePath('patch/files/OrigFont.ttf', workspace, 'write', homeDir), null);

      const tools = createGuardedBuiltinToolDefinitions(workspace, ['write', 'edit', 'bash'], {
        bashPath: config.bashPath,
        homeDir,
        agentRole: 'subagent',
      });
      const writeTool = tools.find((t) => t.name === 'write')!;
      const editTool = tools.find((t) => t.name === 'edit')!;
      const bashTool = tools.find((t) => t.name === 'bash')!;

      const wRes = (await writeTool.execute(
        't-wf',
        { path: 'game/OrigFont.ttf', content: 'HACK' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(wRes?.isError, true);
      assert.ok(String(wRes?.content?.[0]?.text || '').includes('字体'));

      const eRes = (await editTool.execute(
        't-ef',
        { path: 'game/SubFont.otf', edits: [{ oldText: 'OTF', newText: 'BAD' }] },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(eRes?.isError, true);
      assert.ok(String(eRes?.content?.[0]?.text || '').includes('字体'));

      const wOk = (await writeTool.execute(
        't-wf-ok',
        { path: 'patch/files/OrigFont.ttf', content: 'PATCHED_FONT' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(wOk?.isError, true);

      // 3. bash pre-exec blocking on game font mutations
      for (const cmd of [
        'rm -f game/OrigFont.ttf',
        'mv game/SubFont.otf .papercup/tmp/SubFont.otf',
        'cp patch/files/OrigFont.ttf game/OrigFont.ttf',
        'rm -f game/*.ttc',
        'echo bad > game/OrigFont.ttf',
      ]) {
        assert.notEqual(
          detectBlockedProtectedBashCommand(cmd, workspace, snap),
          null,
          `Expected detectBlockedProtectedBashCommand to block: ${cmd}`
        );
        const bRes = (await bashTool.execute('t-bf-block', { command: cmd }, undefined, undefined, {} as any)) as any;
        assert.equal(bRes?.isError, true, `Expected guarded bash to block: ${cmd}`);
      }

      // 4. Bypassed Python mutation via bash: triggers protectedFileMutations + atomic rollback of game fonts
      //    while leaving newly created non-results .ttf files intact and cleaning up newly created results/ files.
      const bypassPy = path.join(tmpDir, 'bypass_font_mutate.py');
      fs.writeFileSync(
        bypassPy,
        [
          'import pathlib',
          'pathlib.Path("game/OrigFont.ttf").write_bytes(b"TAMPERED-FONT-DATA")',
          'pathlib.Path("game/SubFont.otf").unlink()',
          'pathlib.Path("game/NewlyCreated.ttf").write_bytes(b"NEW-USER-FONT")',
          'pathlib.Path(".papercup/data/results/rogue.jsonl").write_text("{}\\n", encoding="utf-8")',
        ].join('\n') + '\n',
        'utf8'
      );

      const resBypass = (await bashTool.execute(
        't-bypass-font',
        { command: 'python .papercup/tmp/bypass_font_mutate.py' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(resBypass?.isError, true, 'Bypassed font mutation MUST force isError: true');
      const warnText = String(resBypass?.content?.[0]?.text || '');
      assert.equal(warnText.includes('PROTECTED FILE MUTATION DETECTED'), true);
      assert.equal(warnText.includes('游戏字体'), true);

      const muts = (resBypass?.details?.protectedFileMutations || []) as Array<{
        rel: string;
        category: string;
        change: string;
        restored?: boolean;
      }>;
      assert.equal(
        muts.some((m) => m.rel === 'game/OrigFont.ttf' && m.category === 'game_font' && m.change === 'modified' && m.restored === true),
        true,
        `Expected OrigFont.ttf modified+restored in ${JSON.stringify(muts)}`
      );
      assert.equal(
        muts.some((m) => m.rel === 'game/SubFont.otf' && m.category === 'game_font' && m.change === 'deleted' && m.restored === true),
        true,
        `Expected SubFont.otf deleted+restored in ${JSON.stringify(muts)}`
      );
      assert.equal(
        muts.some((m) => m.rel === '.papercup/data/results/rogue.jsonl' && m.category === 'results' && m.change === 'created' && m.restored === true),
        true
      );

      assert.deepEqual(fs.readFileSync(ttfPath), origTtfBytes, 'OrigFont.ttf bytes must be atomically restored');
      assert.deepEqual(fs.readFileSync(otfPath), origOtfBytes, 'SubFont.otf must be atomically restored');
      assert.equal(fs.existsSync(path.join(gameDir, 'NewlyCreated.ttf')), true, 'Created non-results .ttf must NOT be deleted by rollback');
      assert.equal(fs.existsSync(path.join(resultsDir, 'rogue.jsonl')), false, 'Created results/*.jsonl must be cleaned up');
      assert.equal(fs.readFileSync(scenarioPath, 'utf8'), origResultsBytes);

      // 5. onThrow path: non-zero exit after font deletion still triggers atomic restore
      const bypassThrowPy = path.join(tmpDir, 'bypass_font_throw.py');
      fs.writeFileSync(
        bypassThrowPy,
        [
          'import pathlib, sys',
          'pathlib.Path("game/Collection.ttc").unlink()',
          'sys.exit(2)',
        ].join('\n') + '\n',
        'utf8'
      );
      let throwOut = '';
      try {
        const resThrow = (await bashTool.execute(
          't-bypass-font-throw',
          { command: 'python .papercup/tmp/bypass_font_throw.py' },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.equal(resThrow?.isError, true);
        throwOut = String(resThrow?.content?.[0]?.text || '');
      } catch (err: any) {
        throwOut = String(err?.message || err);
      }
      assert.equal(throwOut.includes('PROTECTED FILE MUTATION DETECTED'), true);
      assert.deepEqual(fs.readFileSync(ttcPath), origTtcBytes, 'Collection.ttc must be restored on non-zero exit');
    });
  });

  test('blocks main-agent reverse-engineering and fontTools/binary scripts while allowing reverser subagent and normal main-agent docs/reads', async () => {
    await withIsolatedSandbox(async ({ homeDir, workspace }) => {
      const tmpDir = path.join(workspace, '.papercup', 'tmp');
      const logsDir = path.join(workspace, '.papercup', 'data', 'logs');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'Game.exe'), 'MZ-DUMMY', 'utf8');

      // Seed an existing script that already imports fontTools (to test edit-time detection on existing file)
      const existingReScript = path.join(tmpDir, 'existing_font_script.py');
      fs.writeFileSync(existingReScript, 'from fontTools.ttLib import TTFont\nprint("old")\n', 'utf8');

      const innocuousScript = path.join(tmpDir, 'helper_note.py');
      fs.writeFileSync(innocuousScript, 'print("hello")\n', 'utf8');

      const mainTools = createGuardedBuiltinToolDefinitions(
        workspace,
        ['read', 'write', 'edit', 'bash', 'ls', 'find'],
        {
          bashPath: config.bashPath,
          homeDir,
          agentRole: 'main',
        }
      );
      const subagentTools = createGuardedBuiltinToolDefinitions(
        workspace,
        ['read', 'write', 'edit', 'bash', 'ls', 'find'],
        {
          bashPath: config.bashPath,
          homeDir,
          agentRole: 'subagent',
        }
      );

      const mainWrite = mainTools.find((t) => t.name === 'write')!;
      const mainEdit = mainTools.find((t) => t.name === 'edit')!;
      const mainBash = mainTools.find((t) => t.name === 'bash')!;
      const mainLs = mainTools.find((t) => t.name === 'ls')!;
      const mainFind = mainTools.find((t) => t.name === 'find')!;

      const subWrite = subagentTools.find((t) => t.name === 'write')!;
      const subEdit = subagentTools.find((t) => t.name === 'edit')!;
      const subBash = subagentTools.find((t) => t.name === 'bash')!;

      // Direct detector + main tool blocking for write/edit/bash
      const blockedWriteCases = [
        {
          path: '.papercup/tmp/patch_font_manual.py',
          content: 'from fontTools.ttLib import TTFont\ntt = TTFont("a.ttf")\n',
        },
        {
          path: '.papercup/tmp/hmtx_tweak.py',
          content: 'import struct\ndata = open("a.ttf", "rb").read()\n# tweak hmtx\nprint("hmtx")\n',
        },
        {
          path: '.papercup/tmp/pe_audit.py',
          content: 'import pefile\npe = pefile.PE("Game.exe")\n',
        },
        {
          path: '.papercup/tmp/shiftjis_scan.py',
          content: 'raw = open("Game.exe", "rb").read()\nprint("SHIFTJIS", 0x80)\n',
        },
      ];

      for (const c of blockedWriteCases) {
        const directMsg = detectBlockedMainAgentReverseOrFontAction('write', c, workspace);
        assert.ok(directMsg && directMsg.includes('delegate_task(role="reverser"'), `Expected main write block: ${c.path}`);

        const toolRes = (await mainWrite.execute('t-mw-block', c, undefined, undefined, {} as any)) as any;
        assert.equal(toolRes?.isError, true, `Expected main write tool to block: ${c.path}`);
        assert.ok(String(toolRes?.content?.[0]?.text || '').includes('delegate_task(role="reverser"'));
      }

      // Main edit blocked both when newText introduces binary/fontTools AND when editing an existing fontTools script
      const editInjectRes = (await mainEdit.execute(
        't-me-inject',
        { path: '.papercup/tmp/helper_note.py', edits: [{ oldText: 'print("hello")', newText: 'import pefile\nprint("hmtx")' }] },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(editInjectRes?.isError, true);
      assert.ok(String(editInjectRes?.content?.[0]?.text || '').includes('delegate_task(role="reverser"'));

      const editExistingRes = (await mainEdit.execute(
        't-me-existing',
        { path: '.papercup/tmp/existing_font_script.py', edits: [{ oldText: 'print("old")', newText: 'print("new")' }] },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.equal(editExistingRes?.isError, true);
      assert.ok(String(editExistingRes?.content?.[0]?.text || '').includes('delegate_task(role="reverser"'));

      // Main bash blocked for fontTools/TTFont/pefile/objdump/strings/existing RE script
      const blockedMainBashCmds = [
        'python -c "from fontTools.ttLib import TTFont; print(TTFont)"',
        'python -m fontTools.ttLib Game.ttf',
        'fonttools subset Demo.ttf',
        'ttx -l Demo.ttf',
        'objdump -p Game.exe',
        'strings Game.exe',
        'python .papercup/tmp/existing_font_script.py',
        'python -c "import pefile; print(pefile)"',
      ];
      for (const cmd of blockedMainBashCmds) {
        const directMsg = detectBlockedMainAgentReverseOrFontAction('bash', { command: cmd }, workspace);
        assert.ok(directMsg && directMsg.includes('delegate_task(role="reverser"'), `Expected main bash block: ${cmd}`);
        const res = (await mainBash.execute('t-mb-block', { command: cmd }, undefined, undefined, {} as any)) as any;
        assert.equal(res?.isError, true, `Expected main bash tool to block: ${cmd}`);
        assert.ok(String(res?.content?.[0]?.text || '').includes('delegate_task(role="reverser"'));
      }

      // Same operations under agentRole: 'subagent' pass the role guard
      const subWriteRes = (await subWrite.execute(
        't-sw-ok',
        { path: '.papercup/tmp/subagent_re.py', content: 'from fontTools.ttLib import TTFont\nprint("SUBAGENT_RE_OK")\n' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(subWriteRes?.isError, true);

      const subEditRes = (await subEdit.execute(
        't-se-ok',
        { path: '.papercup/tmp/existing_font_script.py', edits: [{ oldText: 'print("old")', newText: 'print("SUBAGENT_EDIT_OK")' }] },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(subEditRes?.isError, true);

      const subBashRes = (await subBash.execute(
        't-sb-ok',
        { command: 'python -c "from fontTools.ttLib import TTFont; print(\'SUBAGENT_FONTTOOLS_OK\')"' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(subBashRes?.isError, true);
      assert.ok(String(subBashRes?.content?.[0]?.text || '').includes('SUBAGENT_FONTTOOLS_OK'));

      // Normal main-agent writes (papercup.toml, HANDOFF.md) and reads/lists (ls, find, bash status) are NOT false-positived
      const mainTomlRes = (await mainWrite.execute(
        't-mw-toml',
        {
          path: 'papercup.toml',
          content: '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n[vn.patch]\nruntime_charset = "shift_jis"\n',
        },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(mainTomlRes?.isError, true);

      const mainHandoffRes = (await mainWrite.execute(
        't-mw-handoff',
        {
          path: '.papercup/data/logs/HANDOFF.md',
          content: '# Handoff\n- Observed SHIFTJIS_CHARSET overlap; delegated fontTools inspection to reverser.\n',
        },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(mainHandoffRes?.isError, true);

      const mainLsRes = (await mainLs.execute('t-mls', {}, undefined, undefined, {} as any)) as any;
      assert.notEqual(mainLsRes?.isError, true);
      const mainFindRes = (await mainFind.execute('t-mfind', { pattern: '*.md' }, undefined, undefined, {} as any)) as any;
      assert.notEqual(mainFindRes?.isError, true);
      const mainSafeBashRes = (await mainBash.execute(
        't-mbash-safe',
        { command: 'ls .papercup/data/logs && head -n 1 .papercup/data/logs/HANDOFF.md' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(mainSafeBashRes?.isError, true);
    });
  });
});

describe('TODO #123 Strict read Workspace Allowlist & Unified bash Local-Script Static Scanner (guarded-tools.ts, secrets.ts, agent-service.ts)', () => {
  test('read blocks out-of-workspace host paths (repo source/dist, ~/.papercup/, sibling dirs) while allowing workspace and explicit skillReadRoots', async () => {
    await withIsolatedSandbox(async ({ root, homeDir, workspace }) => {
      const wsFile = path.join(workspace, 'notes.txt');
      fs.writeFileSync(wsFile, 'WS_NOTE_OK\n', 'utf8');

      // Non-secret host files outside workspace
      const outsideDir = path.join(root, 'outside-host');
      const outsideNote = path.join(outsideDir, 'host_note.txt');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(outsideNote, 'HOST_SECRET_CONTENT\n', 'utf8');

      const papercupDataDir = path.join(homeDir, '.papercup');
      const papercupWorkspacesFile = path.join(papercupDataDir, 'workspaces.json');
      fs.writeFileSync(papercupWorkspacesFile, JSON.stringify({ active: workspace, recent: [workspace] }), 'utf8');

      // Paper Cup own repo source/package file outside temp sandbox
      const repoPackageJson = path.resolve(process.cwd(), 'package.json');
      assert.equal(fs.existsSync(repoPackageJson), true, 'Expected server/package.json to exist for read boundary check');

      // Explicit skillReadRoots directory (placed outside workspace under ~/.papercup/skills/demo-skill)
      const skillRoot = path.join(papercupDataDir, 'skills', 'demo-skill');
      fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
      const skillMd = path.join(skillRoot, 'SKILL.md');
      const skillRef = path.join(skillRoot, 'references', 'format.md');
      fs.writeFileSync(skillMd, '# Demo Skill\nSKILL_MD_OK\n', 'utf8');
      fs.writeFileSync(skillRef, '# Reference\nSKILL_REF_OK\n', 'utf8');

      // Workspace symlink escaping to outsideDir must NOT satisfy workspace or skillReadRoots allowlists
      const escapeLink = path.join(workspace, 'escape_read_link');
      assert.equal(tryCreateSymlinkOrJunction(outsideDir, escapeLink, true), true);

      // Direct isPathInsideSkillReadRoots checks
      assert.equal(isPathInsideSkillReadRoots(skillMd, workspace, [skillRoot]), true);
      assert.equal(isPathInsideSkillReadRoots(skillRef, workspace, [skillRoot]), true);
      assert.equal(isPathInsideSkillReadRoots(papercupWorkspacesFile, workspace, [skillRoot]), false);
      assert.equal(isPathInsideSkillReadRoots(repoPackageJson, workspace, [skillRoot]), false);
      assert.equal(isPathInsideSkillReadRoots(outsideNote, workspace, [skillRoot]), false);

      const tools = createGuardedBuiltinToolDefinitions(workspace, ['read'], {
        homeDir,
        skillReadRoots: [skillRoot],
      });
      const readTool = tools.find((t) => t.name === 'read')!;
      assert.ok(readTool, 'Expected guarded read tool');

      const getText = (res: any): string =>
        Array.isArray(res?.content) ? res.content.map((c: any) => String(c?.text || '')).join('\n') : '';

      // 1) Allowed: workspace file + explicit skillReadRoots file + fallback skill-relative path
      const okWs = (await readTool.execute('r-ws', { path: 'notes.txt' }, undefined, undefined, {} as any)) as any;
      assert.notEqual(okWs?.isError, true, getText(okWs));
      assert.ok(getText(okWs).includes('WS_NOTE_OK'));

      const okSkillAbs = (await readTool.execute('r-skill-abs', { path: skillMd }, undefined, undefined, {} as any)) as any;
      assert.notEqual(okSkillAbs?.isError, true, getText(okSkillAbs));
      assert.ok(getText(okSkillAbs).includes('SKILL_MD_OK'));

      const okSkillFallback = (await readTool.execute(
        'r-skill-fb',
        { path: 'demo-skill/references/format.md' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(okSkillFallback?.isError, true, getText(okSkillFallback));
      assert.ok(getText(okSkillFallback).includes('SKILL_REF_OK'));

      // 2) Blocked: outside host file, symlink escape, ~/.papercup/workspaces.json, Paper Cup repo package.json
      const blockedTargets = [
        outsideNote,
        '../outside-host/host_note.txt',
        'escape_read_link/host_note.txt',
        papercupWorkspacesFile,
        '~/.papercup/workspaces.json',
        repoPackageJson,
        ...(process.platform === 'win32' ? [toMsysPath(outsideNote), toMsysPath(repoPackageJson)] : []),
      ];
      for (const target of blockedTargets) {
        const res = (await readTool.execute('r-block', { path: target }, undefined, undefined, {} as any)) as any;
        const txt = getText(res);
        assert.equal(res?.isError, true, `read("${target}") must be blocked, got: ${txt}`);
        assert.equal(res?.details?.blocked, true);
        assert.ok(txt.includes('Security guard:'), `Expected Security guard message for ${target}, got: ${txt}`);
        assert.equal(txt.includes('HOST_SECRET_CONTENT'), false);
      }

      // 3) AgentService main session integration: wires skillReadRoots for main agent `read`
      const svc = new AgentService(workspace, { sessionMode: 'memory' });
      try {
        await svc.initSession();
        const session = (svc as any).currentSession;
        const customTools = (session?._customTools || session?.agent?.state?.tools || []) as any[];
        const mainRead = customTools.find((t) => t?.name === 'read');
        assert.ok(mainRead, 'Expected main session read tool');

        const svcAllowSkill = (await mainRead.execute('r-svc-skill', { path: skillMd }, undefined, undefined, {} as any)) as any;
        assert.notEqual(svcAllowSkill?.isError, true, getText(svcAllowSkill));
        assert.ok(getText(svcAllowSkill).includes('SKILL_MD_OK'));

        const svcBlockRepo = (await mainRead.execute(
          'r-svc-repo',
          { path: repoPackageJson },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.equal(svcBlockRepo?.isError, true);
        assert.ok(getText(svcBlockRepo).includes('Security guard:'));

        const svcBlockPapercup = (await mainRead.execute(
          'r-svc-pc',
          { path: papercupWorkspacesFile },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.equal(svcBlockPapercup?.isError, true);
        assert.ok(getText(svcBlockPapercup).includes('Security guard:'));
      } finally {
        (svc as any).currentSession?.dispose?.();
      }
    });
  });

  test('bash scans local .py/.ps1 scripts for external write/delete, process kill/launch, and Win32_Process/out-of-workspace traversal without false-positiving on legitimate scripts', async () => {
    await withIsolatedSandbox(async ({ root, homeDir, workspace }) => {
      const tmpDir = path.join(workspace, '.papercup', 'tmp');
      const outsideDir = path.join(root, 'outside-target');
      const outsideKeep = path.join(outsideDir, 'keep.txt');
      const outsideDrop = path.join(outsideDir, 'dropped.txt');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(outsideKeep, 'KEEP_INTACT\n', 'utf8');
      fs.writeFileSync(path.join(workspace, 'sample.bin'), 'BIN_DATA\n', 'utf8');

      // 1) Local scripts attempting out-of-workspace write/delete
      const pyExtWrite = path.join(tmpDir, 'ext_write.py');
      fs.writeFileSync(
        pyExtWrite,
        [
          'import pathlib',
          `dst = r"${outsideDrop.replace(/\\/g, '/')}"`,
          'pathlib.Path(dst).write_text("PWNED", encoding="utf-8")',
        ].join('\n') + '\n',
        'utf8'
      );
      const pyExtDelete = path.join(tmpDir, 'ext_delete.py');
      fs.writeFileSync(
        pyExtDelete,
        [
          'import os',
          `os.remove(r"${outsideKeep.replace(/\\/g, '/')}")`,
        ].join('\n') + '\n',
        'utf8'
      );
      const psExtWrite = path.join(tmpDir, 'ext_write.ps1');
      fs.writeFileSync(
        psExtWrite,
        `Set-Content -Path "${outsideDrop.replace(/\\/g, '\\')}" -Value "PWNED"\n`,
        'utf8'
      );

      // Direct content + bash command checks for external writes
      assert.notEqual(
        detectExternalWriteInScriptContent(fs.readFileSync(pyExtWrite, 'utf8'), workspace, workspace, pyExtWrite),
        null
      );
      assert.notEqual(
        detectExternalWriteInScriptContent(fs.readFileSync(psExtWrite, 'utf8'), workspace, workspace, psExtWrite),
        null
      );

      const blockedWriteCmds = [
        'python .papercup/tmp/ext_write.py',
        'cd .papercup/tmp && python ext_write.py',
        'python .papercup/tmp/ext_delete.py',
        'powershell -NoProfile -File .papercup/tmp/ext_write.ps1',
      ];
      for (const cmd of blockedWriteCmds) {
        assert.notEqual(
          detectBlockedExternalWriteCommand(cmd, workspace),
          null,
          `Expected detectBlockedExternalWriteCommand to block: ${cmd}`
        );
      }

      // 2) Local scripts attempting host process kill or launch
      const pyKill = path.join(tmpDir, 'kill_host.py');
      fs.writeFileSync(pyKill, 'import os, signal\nos.kill(999999, signal.SIGTERM)\n', 'utf8');
      const pySubprocess = path.join(tmpDir, 'launch_host.py');
      fs.writeFileSync(pySubprocess, 'import subprocess\nsubprocess.Popen(["node", "-v"])\n', 'utf8');
      const psStopProc = path.join(tmpDir, 'stop_host.ps1');
      fs.writeFileSync(psStopProc, 'Stop-Process -Name node -Force\n', 'utf8');
      const psStartProc = path.join(tmpDir, 'start_host.ps1');
      fs.writeFileSync(psStartProc, 'Start-Process -FilePath "node.exe" -ArgumentList "-v"\n', 'utf8');

      assert.notEqual(detectProcessControlInScriptContent(fs.readFileSync(pyKill, 'utf8'), pyKill), null);
      assert.notEqual(detectProcessControlInScriptContent(fs.readFileSync(pySubprocess, 'utf8'), pySubprocess), null);
      assert.notEqual(detectProcessControlInScriptContent(fs.readFileSync(psStopProc, 'utf8'), psStopProc), null);
      assert.notEqual(detectProcessControlInScriptContent(fs.readFileSync(psStartProc, 'utf8'), psStartProc), null);

      const blockedProcCmds = [
        'python .papercup/tmp/kill_host.py',
        'python .papercup/tmp/launch_host.py',
        'powershell -NoProfile -File .papercup/tmp/stop_host.ps1',
        'powershell -NoProfile -File .papercup/tmp/start_host.ps1',
      ];
      for (const cmd of blockedProcCmds) {
        assert.notEqual(
          detectBlockedProcessControlCommand(cmd, workspace),
          null,
          `Expected detectBlockedProcessControlCommand to block: ${cmd}`
        );
      }

      // 3) Local scripts attempting Win32_Process enumeration or out-of-workspace traversal
      const psWin32Proc = path.join(tmpDir, 'probe_proc.ps1');
      fs.writeFileSync(psWin32Proc, 'Get-CimInstance Win32_Process | Select-Object CommandLine\n', 'utf8');
      const pyOutWalk = path.join(tmpDir, 'walk_outside.py');
      fs.writeFileSync(
        pyOutWalk,
        `import os\nfor r, d, f in os.walk(r"${outsideDir.replace(/\\/g, '/')}"):\n    print(r)\n`,
        'utf8'
      );
      const pyHomeRglob = path.join(tmpDir, 'rglob_home.py');
      fs.writeFileSync(
        pyHomeRglob,
        'from pathlib import Path\nprint(list(Path("~").expanduser().rglob("*.json")))\n',
        'utf8'
      );

      assert.notEqual(
        detectHostSearchInScriptContent(fs.readFileSync(psWin32Proc, 'utf8'), workspace, workspace, psWin32Proc),
        null
      );
      assert.notEqual(
        detectHostSearchInScriptContent(fs.readFileSync(pyOutWalk, 'utf8'), workspace, workspace, pyOutWalk),
        null
      );
      assert.notEqual(
        detectHostSearchInScriptContent(fs.readFileSync(pyHomeRglob, 'utf8'), workspace, workspace, pyHomeRglob),
        null
      );

      const blockedSearchCmds = [
        'powershell -NoProfile -File .papercup/tmp/probe_proc.ps1',
        'python .papercup/tmp/walk_outside.py',
        'python .papercup/tmp/rglob_home.py',
      ];
      for (const cmd of blockedSearchCmds) {
        assert.notEqual(
          detectBlockedHostSearchCommand(cmd, workspace),
          null,
          `Expected detectBlockedHostSearchCommand to block: ${cmd}`
        );
      }

      // 4) Legitimate in-workspace Python & PowerShell diagnostic/unpack scripts MUST NOT false-positive
      const pyLegit = path.join(tmpDir, 'legit_unpack.py');
      fs.writeFileSync(
        pyLegit,
        [
          'import os, pathlib, shutil',
          'out_dir = pathlib.Path(".papercup/tmp/diag_out")',
          'out_dir.mkdir(parents=True, exist_ok=True)',
          '# Read-only copy from outside host into workspace stays allowed; in-workspace write & walk allowed',
          `shutil.copyfile(r"${outsideKeep.replace(/\\/g, '/')}", ".papercup/tmp/diag_out/copied.txt")`,
          '(out_dir / "diag.txt").write_text("LEGIT_WRITE", encoding="utf-8")',
          'files = []',
          'for root_dir, _, fnames in os.walk(".papercup/tmp/diag_out"):',
          '    files.extend(fnames)',
          'print("LEGIT_PY_OK", sorted(files))',
        ].join('\n') + '\n',
        'utf8'
      );
      const psLegit = path.join(tmpDir, 'legit_diag.ps1');
      fs.writeFileSync(
        psLegit,
        [
          '$items = Get-ChildItem -Path . -File | Select-Object -ExpandProperty Name',
          'Set-Content -Path .papercup/tmp/ps_diag.txt -Value ($items -join ",")',
          'Write-Output "LEGIT_PS1_OK"',
        ].join('\n') + '\n',
        'utf8'
      );

      const legitCmds = [
        'python .papercup/tmp/legit_unpack.py',
        'powershell -NoProfile -File .papercup/tmp/legit_diag.ps1',
      ];
      for (const cmd of legitCmds) {
        assert.equal(detectBlockedExternalWriteCommand(cmd, workspace), null, `False positive external write on: ${cmd}`);
        assert.equal(detectBlockedProcessControlCommand(cmd, workspace), null, `False positive process control on: ${cmd}`);
        assert.equal(detectBlockedHostSearchCommand(cmd, workspace), null, `False positive host search on: ${cmd}`);
      }

      // 5) Guarded bash tool end-to-end execution checks
      const tools = createGuardedBuiltinToolDefinitions(workspace, ['bash'], {
        bashPath: config.bashPath,
        homeDir,
        agentRole: 'main',
      });
      const bashTool = tools.find((t) => t.name === 'bash')!;

      for (const cmd of [...blockedWriteCmds, ...blockedProcCmds, ...blockedSearchCmds]) {
        const res = (await bashTool.execute('b-123-block', { command: cmd }, undefined, undefined, {} as any)) as any;
        assert.equal(res?.isError, true, `Expected guarded bash to block: ${cmd}`);
        assert.equal(res?.details?.blocked, true);
        assert.ok(String(res?.content?.[0]?.text || '').includes('Security guard:'));
      }

      // Outside target must remain completely untouched (commands never executed)
      assert.equal(fs.existsSync(outsideDrop), false);
      assert.equal(fs.readFileSync(outsideKeep, 'utf8'), 'KEEP_INTACT\n');

      // Legitimate in-workspace python script runs cleanly
      const pyOkRes = (await bashTool.execute(
        'b-123-py-ok',
        { command: 'python .papercup/tmp/legit_unpack.py' },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(pyOkRes?.isError, true, String(pyOkRes?.content?.[0]?.text || ''));
      assert.ok(String(pyOkRes?.content?.[0]?.text || '').includes('LEGIT_PY_OK'));

      if (process.platform === 'win32') {
        const psOkRes = (await bashTool.execute(
          'b-123-ps-ok',
          { command: 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .papercup/tmp/legit_diag.ps1' },
          undefined,
          undefined,
          {} as any
        )) as any;
        assert.notEqual(psOkRes?.isError, true, String(psOkRes?.content?.[0]?.text || ''));
        assert.ok(String(psOkRes?.content?.[0]?.text || '').includes('LEGIT_PS1_OK'));
      }
    });
  });
});
