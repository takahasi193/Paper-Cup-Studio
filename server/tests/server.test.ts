import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { serve } from '@hono/node-server';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, getSystemMessageText } from '@earendil-works/pi-ai';
import { AgentService } from '../src/agent/agent-service.js';
import { computeCompactionThresholds } from '../src/agent/compaction.js';
import { buildRestoredDraft } from '../src/agent/message-queue.js';
import {
  DEFAULT_LOCAL_TRANSLATOR_CONFIG,
  LOCAL_ENDPOINT_PRESETS,
  LocalTranslatorClient,
  pickPreferredLocalModel,
  probeLocalTranslatorEndpoint,
} from '../src/agent/local-translator.js';
import {
  DEFAULT_MAGPIE_BASE_URL,
  MAGPIE_KEYLESS_RUNTIME_TOKEN,
  normalizeMagpieBaseUrl,
} from '../src/agent/provider-discovery.js';
import {
  DEFAULT_OLLAMA_OPTIMIZATION_ENV,
  buildOllamaSpawnEnv,
  buildWindowsOllamaPersistScript,
  buildWindowsOllamaReadEnvScript,
  detectLocalOllamaOrigin,
  inspectOllamaBinary,
  type OllamaSyncInput,
} from '../src/agent/ollama-sync.js';
import { createApiRouter } from '../src/api/routes.js';
import { SubagentManager, classifySubagentError } from '../src/subagents/subagent-manager.js';
import { createVnTools } from '../src/agent/vn-tools.js';
import { PAPERCUP_SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { config } from '../src/config.js';
import {
  collectProtectedWorkspaceSnapshot,
  createGuardedBuiltinToolDefinitions,
  detectBlockedProtectedBashCommand,
  detectBlockedProtectedFilePath,
  diffProtectedWorkspaceSnapshots,
  readVnResearchConfig,
} from '../src/security/guarded-tools.js';
import {
  detectBlockedBashHeredocCommand,
  detectBlockedExternalWriteCommand,
  detectBlockedProcessControlCommand,
  detectBlockedSecretCommand,
  isRestrictedSecretPath,
  redactSecrets,
} from '../src/security/secrets.js';
import { BUILTIN_SUBAGENTS } from '../src/subagents/roles.js';
import { NSA_MANIFEST, RPA_MANIFEST, packDeltaXp3, repackNsa, repackRpa, scanWorkspace, unpackNsa, unpackPeZip, unpackXp3 } from '../src/vn/archives.js';
import { applyResults, classifyUnpacked } from '../src/vn/classify.js';
import {
  acceptVnRelease,
  classifyVnScripts,
  detectVnEngines,
  getVnStatus,
  learnVnSkill,
  mergeVnBatches,
  promoteVnSkill,
  releaseVnPatch,
  runVnSmokeTest,
  unpackVnArchives,
  writebackVnCopy,
} from '../src/vn/core.js';
import { createSmokeVisionBridge } from '../src/agent/smoke-vision.js';
import {
  SMOKE_FAILURES_REL,
  SMOKE_REPAIR_REL,
  SMOKE_REPORT_REL,
  getWindowsSmokeDriverSource,
  parseTextractorOutputChunk,
  prepareSmokeSandbox,
  prepareSmokeSandboxFromOverlay,
  readSmokeRepairState,
  writeWindowsSmokeDriverScript,
  type SmokeExecutionDriver,
} from '../src/vn/smoke.js';
import { DEFAULT_SMOKE_CONFIG, findLocaleEmulatorProfileGuid, inspectSmokeTools, saveGlobalSmokeConfig } from '../src/vn/smoke-config.js';
import { decodeBytes, encodeText, loadProfile, projectHarnessDir } from '../src/vn/profile.js';
import { detectModelFamily } from '../src/vn/tokens.js';
import { parseExtractOutputJsonl } from '../src/vn/workflow.js';
import {
  cleanLocalModelOutput,
  extractEnvelopeAndMask,
  reassembleUnit,
  sliceGlossaryForUnits,
} from '../src/vn/translation-packet.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');

const ALL_ISOLATED_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'X_AI_API_KEY',
  'GROQ_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'MODELSCOPE_API_KEY',
  'ARK_API_KEY',
  'VOLCENGINE_API_KEY',
  'SILICONFLOW_API_KEY',
  'MAGPIE_API_KEY',
  'MAGPIE_BASE_URL',
  'MAGPIE_MODEL',
  'PI_OFFLINE',
  'PAPERCUP_HOME',
  'USERPROFILE',
  'HOME',
] as const;

async function withIsolatedHomeAndEnv<T>(
  prefix: string,
  fn: (ctx: { root: string; home: string; ws: string }) => Promise<T>,
  options?: { offline?: boolean; clearProviderEnvs?: boolean }
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  const saved = new Map<string, string | undefined>(
    ALL_ISOLATED_ENV_KEYS.map((k) => [k, process.env[k]])
  );
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    if (options?.clearProviderEnvs !== false) {
      for (const k of ALL_ISOLATED_ENV_KEYS) {
        delete process.env[k];
      }
    }
    delete process.env.PAPERCUP_HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    if (options?.offline) {
      process.env.PI_OFFLINE = '1';
    }
    return await fn({ root, home, ws });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Preset-agnostic extractor for mock local MT HTTP servers: handles `sakura`,
 * `hy-mt`, and `plain-lines` (including numbered `1: ...` blocks) without
 * locking onto a single prompt's punctuation.
 */
function extractMockMtLines(userMsg: string): { lines: string[]; numbered: boolean } {
  const paragraphs = userMsg
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const lastBlock = paragraphs[paragraphs.length - 1] ?? '';
  const blockLines = lastBlock
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // If the instruction line is attached directly above the source lines (sakura / plain-lines), drop that instruction header line.
  const payloadLines =
    blockLines.length > 1 && /[：:]$/.test(blockLines[0])
      ? blockLines.slice(1)
      : blockLines;
  const numbered =
    payloadLines.length > 0 && payloadLines.every((l) => /^\d+\s*[:：]\s*/.test(l));
  const lines = numbered
    ? payloadLines.map((l) => l.replace(/^\d+\s*[:：]\s*/, '').trim())
    : payloadLines;
  return { lines, numbered };
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function runTests() {
  console.log('--- Running Server Tests ---');
  await withIsolatedHomeAndEnv('papercup-core-', async ({ ws: coreWs }) => {
    const agentService = new AgentService(coreWs, { sessionMode: 'memory' });
    const app = createApiRouter(agentService);
    let loopService: AgentService | null = null;
    try {
      // 1. ヘルスチェックテスト
      const resHealth = await app.request('/health');
      console.log('1. Health check status:', resHealth.status);
      const healthJson = await resHealth.json();
      console.log('   Health response:', healthJson);
      assert(healthJson.status === 'ok', 'Health check failed');

      // 2. ワークスペースチェックテスト
      const resWs = await app.request('/api/workspaces');
      console.log('2. Workspaces status:', resWs.status);
      const wsJson = await resWs.json();
      console.log('   Active workspace:', wsJson.active);
      assert(Boolean(wsJson.active) && path.resolve(wsJson.active) === path.resolve(coreWs), 'Workspace check failed');

      // 3. エンジニアリング状態テスト（構造化 engineId / engineName / engineKnown 含む実質アサーション）
      const resEng = await app.request('/api/engineering/status');
      console.log('3. Engineering status code:', resEng.status);
      const engJson = await resEng.json();
      console.log('   Engineering result:', engJson);
      assert(
        resEng.status === 200 &&
          path.resolve(engJson.workspace) === path.resolve(coreWs) &&
          typeof engJson.engine === 'string' &&
          engJson.engineKnown === false &&
          engJson.engineId === null &&
          engJson.engineName === null &&
          engJson.hasUnpacked === false &&
          engJson.hasBuild === false &&
          Array.isArray(engJson.skills) &&
          engJson.translator?.mode === 'cloud_subagent',
        `Unexpected empty-workspace engineering status: ${JSON.stringify(engJson)}`
      );
      // Drop a synthetic XP3 archive into isolated workspace and verify structured engine detection
      packDeltaXp3([['scenario/init.ks', encodeText('*start\r\nテスト[p]\r\n', 'cp932')]], path.join(coreWs, 'data.xp3'));
      const resEngDetected = await app.request('/api/engineering/status?refresh=1');
      assert(resEngDetected.status === 200, `Expected 200 on refreshed engineering status, got ${resEngDetected.status}`);
      const engDetected = await resEngDetected.json();
      assert(
        engDetected.engineKnown === true &&
          engDetected.engineId === 'kirikiri' &&
          typeof engDetected.engineName === 'string' &&
          engDetected.engineName.length > 0,
        `Expected structured kirikiri engine summary, got ${JSON.stringify(engDetected)}`
      );
      fs.rmSync(path.join(coreWs, 'data.xp3'), { force: true });

      // 4. セッション初期化・Shellパスおよび全アクティブワークフローツール検証テスト
      console.log('4. Initializing Agent Session...');
      console.log('   Resolved Bash Path:', config.bashPath || '(none)');
      if (process.platform === 'win32' && config.bashPath) {
        assert(
          !config.bashPath.toLowerCase().includes('system32'),
          `Bash path unexpectedly resolved to WSL System32: ${config.bashPath}`
        );
      }

      await agentService.initSession();
      const session = (agentService as any).currentSession;
      assert(Boolean(session), 'Session failed to initialize');

      const activeTools: string[] = session.getActiveToolNames();
      console.log('   Active Session Tools:', activeTools);
      for (const requiredTool of [
        'ls',
        'find',
        'vn_detect',
        'vn_status',
        'vn_unpack',
        'vn_classify',
        'vn_extract_roster',
        'vn_request_character_confirmation',
        'vn_qa',
        'vn_apply',
        'vn_repack',
        'vn_accept',
        'vn_release',
        'vn_learn_skill',
        'vn_promote_skill',
        'vn_plan',
        'vn_checkpoint',
        'vn_merge',
        'vn_writeback',
        'vn_smoke_test',
        'vn_translate_batches',
        'vn_post_qa_parallel',
        'delegate_task',
        'create_subagent',
      ]) {
        assert(activeTools.includes(requiredTool), `Required tool not active: ${requiredTool}`);
      }

      // 5. サブエージェント隔離初期化（systemPrompt getter エラー回避・ツール権限分離）検証
      console.log('5. Verifying SubagentManager session creation & tool isolation...');
      const subagentManager = new SubagentManager();
      subagentManager.setCustomToolsProvider(() => createVnTools(() => coreWs));

      const translatorSub = await subagentManager.createSubagentSession('translator', { cwd: coreWs });
      try {
        assert(
          translatorSub.session.systemPrompt.includes('You translate visual-novel text into Chinese'),
          'translator systemPrompt did not apply via DefaultResourceLoader'
        );
        assert(
          translatorSub.session.getActiveToolNames().length === 0,
          `translator should have 0 tools, got: ${translatorSub.session.getActiveToolNames().join(', ')}`
        );
      } finally {
        translatorSub.session.dispose?.();
      }

      const checkerSub = await subagentManager.createSubagentSession('role-checker', { cwd: coreWs });
      try {
        assert(
          checkerSub.session.systemPrompt.includes('You review visual-novel translations'),
          'role-checker systemPrompt did not apply'
        );
        assert(
          checkerSub.session.getActiveToolNames().length === 0,
          `role-checker should have 0 tools, got: ${checkerSub.session.getActiveToolNames().join(', ')}`
        );
      } finally {
        checkerSub.session.dispose?.();
      }

      const reverserSub = await subagentManager.createSubagentSession('reverser', { cwd: coreWs });
      try {
        assert(
          reverserSub.session.systemPrompt.includes('vn_learn_skill'),
          'reverser systemPrompt missing vn_learn_skill instructions'
        );
        const revTools = reverserSub.session.getActiveToolNames();
        for (const expectedTool of ['read', 'write', 'edit', 'ls', 'find', 'bash', 'vn_detect', 'vn_learn_skill']) {
          assert(revTools.includes(expectedTool), `reverser missing expected tool ${expectedTool}, got: ${revTools.join(', ')}`);
        }
        assert(!revTools.includes('vn_apply'), 'reverser should not receive vn_apply');
        assert(!revTools.includes('delegate_task'), 'reverser should not receive delegate_task');
        const loadedSkillNames = (reverserSub.session as any)._resourceLoader
          ?.getSkills?.()
          ?.skills?.map((s: any) => s.name) ?? [];
        assert(
          loadedSkillNames.includes('vn-reverse-engineering'),
          `reverser should load bundled vn-reverse-engineering skill by default, got: ${loadedSkillNames.join(', ')}`
        );
        assert(
          !loadedSkillNames.includes('reverse-engineer-anything'),
          `reverser should NOT load obsolete reverse-engineer-anything skill, got: ${loadedSkillNames.join(', ')}`
        );
      } finally {
        reverserSub.session.dispose?.();
      }

      // 6. 動的サブエージェント生成（権限境界含む）・異常終了・AbortSignal・VNツール契約検証
      console.log('6. Verifying create_subagent, privilege boundaries, delegate_task guards, and vn_* tool contracts...');
      const subTools = subagentManager.createTools(() => coreWs);
      const delegateTool = subTools.find((t) => t.name === 'delegate_task')!;
      const createTool = subTools.find((t) => t.name === 'create_subagent')!;

      const createdRes = await (createTool.execute as any)('tc-create', {
        name: 'proofreader',
        description: 'Checks punctuation.',
        instructions: 'Check Chinese punctuation strictly.',
        allowedTools: ['read'],
      });
      assert(createdRes.details?.name === 'proofreader', 'create_subagent failed');

      // Built-in role overwrite and privileged tool escalation must be rejected
      const overwriteBuiltinRes = await (createTool.execute as any)('tc-create-overwrite', {
        name: 'translator',
        description: 'Attempt to overwrite built-in translator',
        instructions: 'Malicious override',
        allowedTools: ['read'],
      });
      assert(
        overwriteBuiltinRes.isError === true,
        `create_subagent must reject overwriting built-in roles: ${JSON.stringify(overwriteBuiltinRes)}`
      );
      const forbiddenToolsRes = await (createTool.execute as any)('tc-create-priv', {
        name: 'reverser_helper',
        description: 'Attempt to escalate privileged tools',
        instructions: 'Bypass writeback',
        allowedTools: ['bash', 'vn_writeback', 'vn_accept', 'vn_release', 'delegate_task'],
      });
      assert(
        forbiddenToolsRes.isError === true,
        `create_subagent must reject privileged tools (vn_writeback/vn_accept/vn_release/delegate_task): ${JSON.stringify(forbiddenToolsRes)}`
      );

      const dynamicSub = await subagentManager.createSubagentSession('proofreader', { cwd: coreWs });
      try {
        assert(
          dynamicSub.session.systemPrompt.includes('Check Chinese punctuation strictly.'),
          'dynamic subagent systemPrompt did not apply'
        );
        const dynTools = dynamicSub.session.getActiveToolNames();
        assert(dynTools.length === 1 && dynTools[0] === 'read', `Expected ['read'], got: ${dynTools.join(', ')}`);
      } finally {
        dynamicSub.session.dispose?.();
      }

      const unknownRoleRes = await (delegateTool.execute as any)('tc-unknown', {
        role: 'missing-role',
        task: 'hello',
      });
      assert(unknownRoleRes.isError === true && unknownRoleRes.details?.status === 'error', 'Unknown role should return isError=true');

      const abortedController = new AbortController();
      abortedController.abort();
      const abortedRes = await (delegateTool.execute as any)(
        'tc-abort',
        { role: 'translator', task: 'hello' },
        abortedController.signal
      );
      assert(
        abortedRes.isError === true && String(abortedRes.content?.[0]?.text || '').includes('aborted'),
        'Pre-aborted delegate_task should fail cleanly with aborted message'
      );

      const vnTools = createVnTools(() => coreWs);
      const vnQaTool = vnTools.find((t) => t.name === 'vn_qa')!;
      const vnAcceptTool = vnTools.find((t) => t.name === 'vn_accept')!;

      const qaMissingRes = await (vnQaTool.execute as any)('tc-qa-empty', {});
      assert(qaMissingRes.isError === true, 'vn_qa without args should return isError=true');

      const qaMixedRes = await (vnQaTool.execute as any)('tc-qa-mixed', {
        pairs: '.papercup/data/results/scenario.jsonl',
        source: 'こんにちは',
        target: '你好',
      });
      assert(qaMixedRes.isError === true, 'vn_qa mixing pairs and source/target should return isError=true');

      const acceptMissingRes = await (vnAcceptTool.execute as any)('tc-accept-missing', {
        archive: '../out.xp3',
      });
      assert(acceptMissingRes.isError === true, 'vn_accept without report or track+input should return isError=true');

      const vnLearnTool = vnTools.find((t) => t.name === 'vn_learn_skill')!;
      const vnPromoteTool = vnTools.find((t) => t.name === 'vn_promote_skill')!;
      const learnEmptyRes = await (vnLearnTool.execute as any)('tc-learn-empty', {
        engine: '',
        unpackScript: 'unpack.py',
        repackScript: 'repack.py',
      });
      assert(learnEmptyRes.isError === true, 'vn_learn_skill with empty engine should return isError=true');
      const promoteEmptyRes = await (vnPromoteTool.execute as any)('tc-promote-empty', { skill: '  ' });
      assert(promoteEmptyRes.isError === true, 'vn_promote_skill with empty skill should return isError=true');

      // 7. ターン制御 API (/api/turns/start 排他・/api/turns/abort) 検証
      console.log('7. Verifying turn control endpoints (/api/turns/start & /api/turns/abort)...');
      const resMissingPrompt = await app.request('/api/turns/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert(resMissingPrompt.status === 400, `Expected 400 on missing prompt, got ${resMissingPrompt.status}`);

      const resAbortIdle = await app.request('/api/turns/abort', { method: 'POST' });
      assert(resAbortIdle.status === 200, `Expected 200 on idle abort, got ${resAbortIdle.status}`);
      const abortJson = await resAbortIdle.json();
      assert(abortJson.ok === true && abortJson.aborted === false, 'Idle abort should return aborted=false');

      // 8. オフライン Faux モデルを使った主ループ + Subagent 委譲ループ完走テスト
      console.log('8. Verifying full offline Agent loop + delegate_task subagent loop completion...');
      loopService = new AgentService(coreWs, { sessionMode: 'memory' });
      const loopRouter = createApiRouter(loopService);
      await loopService.initSession();

      const mainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const subFaux = createFauxCore({ tokensPerSecond: 10000 });
      const loopSession = (loopService as any).currentSession;
      loopSession.agent.state.model = mainFaux.getModel();
      loopSession.agent.streamFunction = mainFaux.streamSimple;
      loopSession._modelRuntime.hasConfiguredAuth = () => true;

      const loopSubManager = (loopService as any).subagentManager as SubagentManager;
      const origCreateSub = loopSubManager.createSubagentSession.bind(loopSubManager);
      let capturedSubSystemPrompt = '';

      loopSubManager.createSubagentSession = async (roleName, opts) => {
        const res = await origCreateSub(roleName, opts);
        (res.session as any).agent.state.model = subFaux.getModel();
        (res.session as any).agent.streamFunction = subFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      subFaux.setResponses([
        (ctx) => {
          const sysMsg = ctx.messages.find((m) => m.role === 'system');
          capturedSubSystemPrompt = sysMsg ? getSystemMessageText(sysMsg as any) : '';
          return fauxAssistantMessage('{"id":1,"target":"你好"}');
        },
      ]);

      mainFaux.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall('vn_detect', {}, { id: 'tc-vn-detect' }),
          ]),
        (ctx) => {
          const hasDetectResult = ctx.messages.some(
            (m) => m.role === 'toolResult' && (m as any).toolName === 'vn_detect'
          );
          assert(hasDetectResult, 'Main loop turn 2 did not receive vn_detect toolResult');
          return fauxAssistantMessage([
            fauxToolCall(
              'delegate_task',
              { role: 'translator', task: '{"id":1,"source":"こんにちは"}' },
              { id: 'tc-delegate-translator' }
            ),
          ]);
        },
        (ctx) => {
          const delegateResult = ctx.messages.find(
            (m) => m.role === 'toolResult' && (m as any).toolName === 'delegate_task'
          ) as any;
          assert(delegateResult && delegateResult.isError !== true, 'delegate_task toolResult failed unexpectedly');
          const text = (delegateResult.content || []).map((c: any) => c.text || '').join('');
          assert(text.includes('"target":"你好"'), `Expected translated JSONL in delegate result, got: ${text}`);
          return fauxAssistantMessage('本地化委譲ループが完了しました。');
        },
      ]);

      const observedEvents: Array<{ type: string; data: any }> = [];
      const onLoopEvent = (ev: { type: string; data: any }) => observedEvents.push(ev);
      loopService.on('agent_event', onLoopEvent);

      try {
        await loopService.executeTurn('检测引擎并翻译样本');
      } finally {
        loopService.off('agent_event', onLoopEvent);
      }

      assert(
        capturedSubSystemPrompt.includes('You translate visual-novel text into Chinese'),
        `Subagent LLM context did not receive translator prompt: ${capturedSubSystemPrompt}`
      );
      assert(
        observedEvents.some((e) => e.type === 'tool_start' && e.data.tool === 'vn_detect'),
        'Missing tool_start for vn_detect'
      );
      assert(
        observedEvents.some((e) => e.type === 'tool_start' && e.data.tool === 'delegate_task'),
        'Missing tool_start for delegate_task'
      );
      assert(
        observedEvents.some((e) => e.type === 'subagent_delta' && e.data.role === 'translator'),
        'Missing subagent_delta event for translator'
      );
      const finishedEv = observedEvents.find((e) => e.type === 'turn_finished');
      assert(finishedEv?.data?.status === 'completed', `Expected turn_finished completed, got ${JSON.stringify(finishedEv)}`);
      assert(!loopService.isBusy(), 'AgentService remained busy after turn completion');

      // 9. 実行中ターンの /api/turns/start 排他 (409) & /api/turns/abort 割り込み終了テスト
      console.log('9. Verifying in-flight turn busy 409 and abort via POST /api/turns/abort...');
      let notifySubRunning: (() => void) | undefined;
      const subRunningPromise = new Promise<void>((resolve) => {
        notifySubRunning = resolve;
      });

      subFaux.setResponses([
        (_ctx, opts) =>
          new Promise((resolve) => {
            notifySubRunning?.();
            const timer = setTimeout(() => {
              resolve(fauxAssistantMessage('late response'));
            }, 5000);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
              },
              { once: true }
            );
          }),
      ]);

      mainFaux.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'delegate_task',
              { role: 'translator', task: '{"id":2,"source":"テスト"}' },
              { id: 'tc-abort-sub' }
            ),
          ]),
        () => fauxAssistantMessage('should not reach final message after abort'),
      ]);

      const abortEvents: Array<{ type: string; data: any }> = [];
      const onAbortEvent = (ev: { type: string; data: any }) => abortEvents.push(ev);
      loopService.on('agent_event', onAbortEvent);

      const runningTurn = loopService.executeTurn('run and abort');
      await subRunningPromise;
      // Real in-flight busy 409 check (no private isRunningTurn flag spoofing)
      const resBusy = await loopRouter.request('/api/turns/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'test real concurrent guard' }),
      });
      assert(resBusy.status === 409, `Expected 409 when turn is genuinely in flight, got ${resBusy.status}`);
      const abortRes = await loopRouter.request('/api/turns/abort', { method: 'POST' });
      assert(abortRes.status === 200, `Expected 200 from abort endpoint, got ${abortRes.status}`);
      const abortBody = await abortRes.json();
      assert(abortBody.ok === true && abortBody.aborted === true, `Expected aborted=true, got ${JSON.stringify(abortBody)}`);

      await runningTurn;
      loopService.off('agent_event', onAbortEvent);

      const abortedFinish = abortEvents.find((e) => e.type === 'turn_finished');
      assert(abortedFinish?.data?.status === 'aborted', `Expected turn_finished aborted, got ${JSON.stringify(abortedFinish)}`);
      assert(!loopService.isBusy(), 'AgentService remained busy after abort');
    } finally {
      (agentService as any).disposeCurrentSessionState?.(true);
      (loopService as any)?.disposeCurrentSessionState?.(true);
    }
  });

  // 10. 未知エンジン封包 -> reverser 委譲 -> unpack/repack 作成 -> vn_learn_skill 検証封装 -> vn_unpack -> vn_classify -> vn_promote_skill 一気通貫テスト
  console.log('10. Verifying end-to-end unknown-engine learning + skill packaging loop...');
  await withIsolatedHomeAndEnv('papercup-srv-learn-', async ({ home: tmpHome, ws: tmpWs }) => {
    // 合成 .ypf アーカイブを作成 (magic b"YPF\\x00", 1 file "scene.txt")
    const entryName = Buffer.from('scene.txt', 'utf-8');
    const entryData = Buffer.from('「未知エンジンの台詞です」\n', 'utf-8');
    const ypfBuf = Buffer.concat([
      Buffer.from('YPF\x00', 'ascii'),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([entryName.length, 0]),
      entryName,
      Buffer.from([entryData.length, 0, 0, 0]),
      entryData,
    ]);
    fs.writeFileSync(path.join(tmpWs, 'script.ypf'), ypfBuf);

    const learnService = new AgentService(tmpWs, { sessionMode: 'memory' });
    const learnRouter = createApiRouter(learnService);
    try {
      await learnService.initSession();

      const learnMainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const learnSubFaux = createFauxCore({ tokensPerSecond: 10000 });
      const learnMainSession = (learnService as any).currentSession;
      learnMainSession.agent.state.model = learnMainFaux.getModel();
      learnMainSession.agent.streamFunction = learnMainFaux.streamSimple;
      learnMainSession._modelRuntime.hasConfiguredAuth = () => true;

      const learnSubMgr = (learnService as any).subagentManager as SubagentManager;
      const origLearnCreateSub = learnSubMgr.createSubagentSession.bind(learnSubMgr);
      let capturedReverserSystem = '';

      learnSubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origLearnCreateSub(roleName, opts);
        (res.session as any).agent.state.model = learnSubFaux.getModel();
        (res.session as any).agent.streamFunction = learnSubFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      const ypfUnpackPy = [
        'import sys',
        'from pathlib import Path',
        'archive, dest = Path(sys.argv[1]), Path(sys.argv[2])',
        'blob = archive.read_bytes()',
        'if not blob.startswith(b"YPF\\x00"):',
        '    raise SystemExit("bad magic")',
        'count = int.from_bytes(blob[4:8], "little")',
        'pos = 8',
        'dest.mkdir(parents=True, exist_ok=True)',
        'for _ in range(count):',
        '    nlen = int.from_bytes(blob[pos:pos + 2], "little")',
        '    pos += 2',
        '    name = blob[pos:pos + nlen].decode("utf-8")',
        '    pos += nlen',
        '    size = int.from_bytes(blob[pos:pos + 4], "little")',
        '    pos += 4',
        '    data = blob[pos:pos + size]',
        '    pos += size',
        '    if name.startswith(".") or "/" in name or "\\\\" in name or name == "..":',
        '        raise SystemExit("bad entry")',
        '    (dest / name).write_bytes(data)',
        '',
      ].join('\n');

      const ypfRepackPy = [
        'import sys',
        'from pathlib import Path',
        'source, dest = Path(sys.argv[1]), Path(sys.argv[2])',
        'files = sorted((p for p in source.iterdir() if p.is_file() and not p.name.startswith(".")), key=lambda p: p.name)',
        'payload = bytearray()',
        'for path in files:',
        '    raw = path.name.encode("utf-8")',
        '    data = path.read_bytes()',
        '    payload += len(raw).to_bytes(2, "little") + raw + len(data).to_bytes(4, "little") + data',
        'dest.write_bytes(b"YPF\\x00" + len(files).to_bytes(4, "little") + payload)',
        '',
      ].join('\n');

      learnSubFaux.setResponses([
        (ctx) => {
          const sysMsg = ctx.messages.find((m) => m.role === 'system');
          capturedReverserSystem = sysMsg ? getSystemMessageText(sysMsg as any) : '';
          return fauxAssistantMessage([
            fauxToolCall(
              'write',
              { path: '.papercup/tmp/yuris/unpack.py', content: ypfUnpackPy },
              { id: 'tc-rev-write-unpack' }
            ),
            fauxToolCall(
              'write',
              { path: '.papercup/tmp/yuris/repack.py', content: ypfRepackPy },
              { id: 'tc-rev-write-repack' }
            ),
          ]);
        },
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'vn_learn_skill',
              {
                engine: 'yuris',
                archive: 'script.ypf',
                unpackScript: '.papercup/tmp/yuris/unpack.py',
                repackScript: '.papercup/tmp/yuris/repack.py',
                suffix: '.ypf',
                magicHex: '59504600',
                classifyProfile: 'plain',
                classifyExtensions: ['.txt'],
                note: 'YPF0 container synthetic test',
              },
              { id: 'tc-rev-learn' }
            ),
          ]),
        (ctx) => {
          const learnRes = ctx.messages.find(
            (m) => m.role === 'toolResult' && (m as any).toolName === 'vn_learn_skill'
          ) as any;
          assert(learnRes && learnRes.isError !== true, `vn_learn_skill failed inside reverser: ${JSON.stringify(learnRes)}`);
          return fauxAssistantMessage([fauxToolCall('vn_detect', {}, { id: 'tc-rev-detect' })]);
        },
        (ctx) => {
          const detectRes = ctx.messages.find(
            (m) => m.role === 'toolResult' && (m as any).toolName === 'vn_detect'
          ) as any;
          const detectText = (detectRes?.content || []).map((c: any) => c.text || '').join('');
          assert(detectText.includes('ready') && detectText.includes('skill unpack'), `Expected ready skill unpack, got: ${detectText}`);
          return fauxAssistantMessage('Learned skill engine-yuris for script.ypf.');
        },
      ]);

      learnMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_detect', {}, { id: 'tc-main-detect-1' })]),
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'delegate_task',
              { role: 'reverser', task: 'Analyze script.ypf and package its unpack/repack skill.' },
              { id: 'tc-main-rev' }
            ),
          ]),
        () => fauxAssistantMessage([fauxToolCall('vn_unpack', {}, { id: 'tc-main-unpack' })]),
        () =>
          fauxAssistantMessage([
            fauxToolCall('vn_classify', { unpacked: '.papercup/tmp/unpacked/script', out: '.papercup/data/build' }, { id: 'tc-main-classify' }),
          ]),
        () =>
          fauxAssistantMessage([
            fauxToolCall('vn_promote_skill', { skill: 'engine-yuris' }, { id: 'tc-main-promote' }),
          ]),
        () => fauxAssistantMessage('未知引擎技能封装、解包分类与全局提升均已完成。'),
      ]);

      const learnEvents: Array<{ type: string; data: any }> = [];
      const onLearnEvent = (ev: { type: string; data: any }) => learnEvents.push(ev);
      learnService.on('agent_event', onLearnEvent);
      try {
        await learnService.executeTurn('学习这个未知引擎封包并完成解包分类');
      } finally {
        learnService.off('agent_event', onLearnEvent);
      }

      assert(
        !capturedReverserSystem.includes('EARLY_BLOCKER: CP932_VS_ZH_CN') &&
          capturedReverserSystem.includes('PAPERCUP_TARGET_ENCODING') &&
          capturedReverserSystem.includes('vn_learn_skill'),
        `Reverser system prompt should embed non-blocking CP932 delta-patch reversing guidelines`
      );
      assert(
        learnEvents.some(
          (e) =>
            e.type === 'skills_updated' &&
            Array.isArray(e.data?.skills) &&
            e.data.skills.includes('engine-yuris')
        ),
        'Missing skills_updated event containing engine-yuris'
      );
      assert(
        fs.existsSync(path.join(tmpWs, '.papercup', 'skills', 'engine-yuris', 'SKILL.md')),
        'Project SKILL.md was not created'
      );
      assert(
        fs.existsSync(path.join(tmpHome, '.papercup', 'skills', 'engine-yuris', 'unpack.py')) &&
          fs.existsSync(path.join(tmpHome, '.papercup', 'skills', 'engine-yuris', 'engine.json')),
        'Promoted global skill unpack.py and self-contained engine.json were not created'
      );
      assert(
        fs.readFileSync(path.join(tmpWs, '.papercup', 'tmp', 'unpacked', 'script', 'scene.txt'), 'utf-8').includes('未知エンジンの台詞です'),
        'Extracted script content did not match'
      );
      assert(
        fs.existsSync(path.join(tmpWs, '.papercup', 'data', 'build', 'scenario.jsonl')),
        'vn_classify did not generate .papercup/data/build/scenario.jsonl'
      );

      const engStatusRes = await learnRouter.request('/api/engineering/status');
      assert(engStatusRes.status === 200, `Expected 200 from engineering status, got ${engStatusRes.status}`);
      const engStatusBody = await engStatusRes.json();
      assert(
        Array.isArray(engStatusBody.skills) && engStatusBody.skills.includes('engine-yuris'),
        `Expected engine-yuris in engineering skills, got ${JSON.stringify(engStatusBody)}`
      );
    } finally {
      (learnService as any).disposeCurrentSessionState?.(true);
    }
  });

  console.log('11. Verifying model listing and runtime model switching endpoints...');
  await withIsolatedHomeAndEnv(
    'papercup-key-test-',
    async ({ ws: keyWs }) => {
      const modelService = new AgentService(keyWs, { sessionMode: 'memory' });
      const modelRouter = createApiRouter(modelService);
      try {
        await modelService.initSession();

        const modelSession = (modelService as any).currentSession;
        const fauxPro = createFauxCore({ tokensPerSecond: 10000 });
        const fauxFlash = createFauxCore({ tokensPerSecond: 10000 });
        const fauxProModel = { ...fauxPro.getModel(), provider: 'faux', id: 'faux-pro', name: 'Faux Pro' };
        const fauxFlashModel = { ...fauxFlash.getModel(), provider: 'faux', id: 'faux-flash', name: 'Faux Flash' };

        const runtime = modelSession.modelRuntime;
        runtime.getAvailableSnapshot = () => [fauxProModel, fauxFlashModel];
        runtime.checkAuth = async (providerId: string) => (providerId === 'faux' ? { type: 'api_key' } : undefined);
        runtime.hasConfiguredAuth = (providerId: string) => providerId === 'faux';
        runtime.getModel = (providerId: string, modelId: string) => {
          if (providerId === 'faux' && modelId === 'faux-pro') return fauxProModel;
          if (providerId === 'faux' && modelId === 'faux-flash') return fauxFlashModel;
          return undefined;
        };
        modelSession.agent.state.model = fauxProModel;
        modelSession.agent.streamFunction = fauxPro.streamSimple;

        const listRes = await modelRouter.request('/api/models');
        assert(listRes.status === 200, `Expected 200 from /api/models, got ${listRes.status}`);
        const listBody = await listRes.json();
        assert(listBody.current === 'faux/faux-pro', `Expected current faux/faux-pro, got ${JSON.stringify(listBody)}`);
        assert(
          Array.isArray(listBody.models) &&
            listBody.models.some((m: any) => m.key === 'faux/faux-pro') &&
            listBody.models.some((m: any) => m.key === 'faux/faux-flash') &&
            listBody.models.every((m: any) => !('apiKey' in m) && !('headers' in m)),
          `Unexpected /api/models payload: ${JSON.stringify(listBody)}`
        );

        const emptySelectRes = await modelRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: '   ' }),
        });
        assert(emptySelectRes.status === 400, `Expected 400 for empty model, got ${emptySelectRes.status}`);

        const unknownSelectRes = await modelRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'unknown/does-not-exist' }),
        });
        assert(unknownSelectRes.status === 400, `Expected 400 for unknown model, got ${unknownSelectRes.status}`);

        const modelEvents: Array<{ type: string; data: any }> = [];
        const onModelEvent = (ev: { type: string; data: any }) => modelEvents.push(ev);
        modelService.on('agent_event', onModelEvent);

        const selectRes = await modelRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'faux/faux-flash' }),
        });
        assert(selectRes.status === 200, `Expected 200 from /api/models/select, got ${selectRes.status}`);
        const selectBody = await selectRes.json();
        assert(selectBody.ok === true && selectBody.current === 'faux/faux-flash', `Model did not switch: ${JSON.stringify(selectBody)}`);
        assert(modelSession.model?.id === 'faux-flash', 'AgentSession.model did not update to faux-flash');
        assert(
          modelEvents.some((e) => e.type === 'model_changed' && e.data?.model === 'faux/faux-flash'),
          'Missing model_changed SSE event after /api/models/select'
        );

        // Verify /api/turns/start applies explicit model and inherits into delegate_task subagent
        let delegatedModelId: string | undefined;
        const fauxModelSub = createFauxCore({ tokensPerSecond: 10000 });
        fauxModelSub.setResponses([() => fauxAssistantMessage('{"id":1,"target":"测试"}')]);
        const modelSubMgr = (modelService as any).subagentManager as SubagentManager;
        const origModelCreateSub = modelSubMgr.createSubagentSession.bind(modelSubMgr);
        modelSubMgr.createSubagentSession = async (roleName, opts) => {
          delegatedModelId = opts?.model?.id;
          const res = await origModelCreateSub(roleName, opts);
          (res.session as any).agent.state.model = fauxModelSub.getModel();
          (res.session as any).agent.streamFunction = fauxModelSub.streamSimple;
          (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
          return res;
        };
        fauxPro.setResponses([
          () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'translator', task: '{"id":1,"source":"テスト"}' }, { id: 'tc-model-sub' })]),
          () => fauxAssistantMessage('模型切换测试完成。'),
        ]);

        const busyModelCheck = new Promise<void>((resolve, reject) => {
          const onBusy = async (ev: { type: string }) => {
            if (ev.type !== 'turn_started') return;
            modelService.off('agent_event', onBusy);
            try {
              const busySelect = await modelRouter.request('/api/models/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'faux/faux-flash' }),
              });
              assert(busySelect.status === 409, `Expected 409 while busy, got ${busySelect.status}`);
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          modelService.on('agent_event', onBusy);
        });

        const finishedWait = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            modelService.off('agent_event', onFinished);
            reject(new Error('Timed out waiting for turn_finished in model switching test'));
          }, 5000);
          const onFinished = (ev: { type: string }) => {
            if (ev.type === 'turn_finished') {
              clearTimeout(timer);
              modelService.off('agent_event', onFinished);
              resolve();
            }
          };
          modelService.on('agent_event', onFinished);
        });
        const startModelRes = await modelRouter.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '测试模型切换', model: 'faux/faux-pro' }),
        });
        assert(startModelRes.status === 200, `Expected 200 from /api/turns/start with model, got ${startModelRes.status}`);
        await busyModelCheck;
        await finishedWait;
        modelService.off('agent_event', onModelEvent);

        assert(modelSession.model?.id === 'faux-pro', `Expected session model switched back to faux-pro, got ${modelSession.model?.id}`);
        assert(delegatedModelId === 'faux-pro', `Expected subagent to inherit faux-pro, got ${delegatedModelId}`);
      } finally {
        (modelService as any).disposeCurrentSessionState?.(true);
      }

      // Verify POST /api/models/key injects runtime key, refreshes models, emits SSE, shares runtime with subagents, and never leaks secrets
      const origGlobalFetch = globalThis.fetch;
      const keyService = new AgentService(keyWs, { sessionMode: 'memory' });
      const keyRouter = createApiRouter(keyService);
      try {
        await keyService.initSession();
        const keySession = (keyService as any).currentSession;

        const missingProviderRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: '   ', apiKey: 'AIza-dummy' }),
        });
        assert(missingProviderRes.status === 400, `Expected 400 for empty provider, got ${missingProviderRes.status}`);

        const unknownProviderRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'not-a-provider', apiKey: 'AIza-dummy' }),
        });
        assert(unknownProviderRes.status === 400, `Expected 400 for unknown provider, got ${unknownProviderRes.status}`);

        const keyEvents: Array<{ type: string; data: any }> = [];
        const onKeyEvent = (ev: { type: string; data: any }) => keyEvents.push(ev);
        keyService.on('agent_event', onKeyEvent);

        const setKeyRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'google', apiKey: 'AIza-faux-test-secret' }),
        });
        assert(setKeyRes.status === 200, `Expected 200 from /api/models/key, got ${setKeyRes.status}`);
        const setKeyBody = await setKeyRes.json();
        assert(setKeyBody.ok === true, 'Expected ok: true from /api/models/key');
        assert(
          typeof setKeyBody.current === 'string' && setKeyBody.current.startsWith('google/'),
          `Expected auto-selected google/* model, got ${setKeyBody.current}`
        );
        assert(
          Array.isArray(setKeyBody.models) && setKeyBody.models.some((m: any) => m.provider === 'google'),
          'Expected google models to appear after setting runtime API key'
        );
        const googleMeta = setKeyBody.providers?.find((p: any) => p.id === 'google');
        assert(
          googleMeta?.configured === true && googleMeta?.source === 'runtime',
          `Expected google provider configured via runtime, got ${JSON.stringify(googleMeta)}`
        );
        assert(
          !JSON.stringify(setKeyBody).includes('AIza-faux-test-secret') &&
            !JSON.stringify(keyEvents).includes('AIza-faux-test-secret'),
          'API key secret must never appear in HTTP responses or SSE events'
        );
        assert(
          keyEvents.some((e) => e.type === 'models_updated' && e.data?.current?.startsWith('google/')),
          'Missing models_updated SSE event after setting API key'
        );

        // Verify busy /api/models/key returns 409 during a real in-flight turn AND subagent receives shared runtime credentials
        const fauxGoogleMain = createFauxCore({ tokensPerSecond: 10000 });
        const fauxGoogleSub = createFauxCore({ tokensPerSecond: 10000 });
        keySession.agent.streamFunction = fauxGoogleMain.streamSimple;
        let notifyKeyTurnRunning!: () => void;
        const keyTurnRunning = new Promise<void>((r) => (notifyKeyTurnRunning = r));
        let releaseKeyTurn!: () => void;
        const keyTurnGate = new Promise<void>((r) => (releaseKeyTurn = r));
        fauxGoogleMain.setResponses([
          async () => {
            notifyKeyTurnRunning();
            await keyTurnGate;
            return fauxAssistantMessage([
              fauxToolCall(
                'delegate_task',
                { role: 'translator', task: '{"id":1,"source":"テスト"}' },
                { id: 'tc-key-sub' }
              ),
            ]);
          },
          () => fauxAssistantMessage('done'),
        ]);
        fauxGoogleSub.setResponses([() => fauxAssistantMessage('{"id":1,"target":"测试"}')]);

        const keySubMgr = (keyService as any).subagentManager as SubagentManager;
        const origKeyCreateSub = keySubMgr.createSubagentSession.bind(keySubMgr);
        let subReceivedGoogleRuntimeAuth = false;
        keySubMgr.createSubagentSession = async (roleName, opts) => {
          subReceivedGoogleRuntimeAuth =
            opts?.modelRuntime?.getProviderAuthStatus?.('google')?.source === 'runtime';
          const res = await origKeyCreateSub(roleName, opts);
          (res.session as any).agent.state.model = fauxGoogleSub.getModel();
          (res.session as any).agent.streamFunction = fauxGoogleSub.streamSimple;
          return res;
        };
        const keyTurnPromise = keyService.executeTurn('test key subagent');
        await keyTurnRunning;
        const busyKeyRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'google', apiKey: 'AIza-faux-test-secret' }),
        });
        assert(busyKeyRes.status === 409, `Expected 409 on /api/models/key while turn is genuinely running, got ${busyKeyRes.status}`);
        releaseKeyTurn();
        await keyTurnPromise;
        assert(subReceivedGoogleRuntimeAuth, 'Subagent did not inherit shared runtime API key credentials');

        // Switch API key to another provider and verify previous provider models are removed
        const switchKeyRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'anthropic', apiKey: 'sk-ant-faux-test-secret' }),
        });
        assert(switchKeyRes.status === 200, `Expected 200 switching runtime key, got ${switchKeyRes.status}`);
        const switchKeyBody = await switchKeyRes.json();
        assert(
          typeof switchKeyBody.current === 'string' && switchKeyBody.current.startsWith('anthropic/'),
          `Expected current switched to anthropic/*, got ${switchKeyBody.current}`
        );
        assert(
          Array.isArray(switchKeyBody.models) &&
            switchKeyBody.models.some((m: any) => m.provider === 'anthropic') &&
            !switchKeyBody.models.some((m: any) => m.provider === 'google'),
          `Expected only anthropic models and zero google models after switching key, got ${JSON.stringify(switchKeyBody.models)}`
        );
        const anthropicMeta = switchKeyBody.providers?.find((p: any) => p.id === 'anthropic');
        const googleAfterSwitchMeta = switchKeyBody.providers?.find((p: any) => p.id === 'google');
        assert(
          anthropicMeta?.configured === true && anthropicMeta?.source === 'runtime',
          `Expected anthropic configured via runtime, got ${JSON.stringify(anthropicMeta)}`
        );
        assert(
          googleAfterSwitchMeta?.configured === false && googleAfterSwitchMeta?.source === null,
          `Expected google unconfigured after switching key, got ${JSON.stringify(googleAfterSwitchMeta)}`
        );
        assert(
          !JSON.stringify(switchKeyBody).includes('sk-ant-faux-test-secret') &&
            !JSON.stringify(keyEvents).includes('sk-ant-faux-test-secret'),
          'Switched API key secret must never appear in HTTP responses or SSE events'
        );

        // Switch API key to ModelScope with a custom model ID (generic contract: presets + custom model + zero previous models)
        const msKeyRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'modelscope',
            apiKey: 'ms-faux-test-secret',
            customModel: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
          }),
        });
        assert(msKeyRes.status === 200, `Expected 200 setting modelscope runtime key, got ${msKeyRes.status}`);
        const msKeyBody = await msKeyRes.json();
        assert(
          msKeyBody.current === 'modelscope/Qwen/Qwen3-30B-A3B-Instruct-2507',
          `Expected current modelscope/Qwen/Qwen3-30B-A3B-Instruct-2507, got ${msKeyBody.current}`
        );
        assert(
          Array.isArray(msKeyBody.models) &&
            msKeyBody.models.length >= 2 &&
            msKeyBody.models.every((m: any) => m.provider === 'modelscope') &&
            msKeyBody.models.some((m: any) => m.key === 'modelscope/Qwen/Qwen3-30B-A3B-Instruct-2507'),
          `Unexpected ModelScope models list: ${JSON.stringify(msKeyBody.models)}`
        );
        assert(
          keySession.model?.baseUrl === 'https://api-inference.modelscope.cn/v1' &&
            keySession.model?.api === 'openai-completions',
          `Unexpected ModelScope resolved model config: ${JSON.stringify(keySession.model)}`
        );
        assert(
          !JSON.stringify(msKeyBody).includes('ms-faux-test-secret') &&
            !JSON.stringify(keyEvents).includes('ms-faux-test-secret'),
          'ModelScope API key secret must never appear in HTTP responses or SSE events'
        );

        const msSelectDynamicRes = await keyRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'modelscope/ZhipuAI/GLM-5.2' }),
        });
        assert(msSelectDynamicRes.status === 200, `Expected 200 selecting ModelScope model with slash ID, got ${msSelectDynamicRes.status}`);
        const msSelectDynamicBody = await msSelectDynamicRes.json();
        assert(
          msSelectDynamicBody.current === 'modelscope/ZhipuAI/GLM-5.2',
          `Expected current modelscope/ZhipuAI/GLM-5.2, got ${msSelectDynamicBody.current}`
        );

        // Switch API key to Volcengine Ark with a custom endpoint ID (ep-*) and verify generic reasoning / mandatory-thinking behavior
        const arkKeyRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'volcengine',
            apiKey: 'ark-faux-test-secret',
            customModel: 'ep-20260101-test01',
          }),
        });
        assert(arkKeyRes.status === 200, `Expected 200 setting volcengine runtime key, got ${arkKeyRes.status}`);
        const arkKeyBody = await arkKeyRes.json();
        assert(
          arkKeyBody.current === 'volcengine/ep-20260101-test01',
          `Expected current volcengine/ep-20260101-test01, got ${arkKeyBody.current}`
        );
        assert(
          Array.isArray(arkKeyBody.models) &&
            arkKeyBody.models.length >= 2 &&
            arkKeyBody.models.every((m: any) => m.provider === 'volcengine') &&
            arkKeyBody.models.some((m: any) => m.key === 'volcengine/ep-20260101-test01' && m.reasoning === false),
          `Unexpected Volcengine Ark models list: ${JSON.stringify(arkKeyBody.models)}`
        );
        const arkMeta = arkKeyBody.providers?.find((p: any) => p.id === 'volcengine');
        assert(
          arkMeta?.configured === true && arkMeta?.source === 'runtime' && arkMeta?.envVar === 'ARK_API_KEY',
          `Unexpected Volcengine Ark provider metadata: ${JSON.stringify(arkMeta)}`
        );
        assert(
          keySession.model?.baseUrl === 'https://ark.cn-beijing.volces.com/api/v3' &&
            keySession.model?.api === 'openai-completions' &&
            keySession.model?.reasoning === false,
          `Unexpected Volcengine Ark resolved ep-* model config: ${JSON.stringify(keySession.model)}`
        );
        assert(
          !JSON.stringify(arkKeyBody).includes('ark-faux-test-secret') &&
            !JSON.stringify(keyEvents).includes('ark-faux-test-secret'),
          'Volcengine Ark API key secret must never appear in HTTP responses or SSE events'
        );

        const arkReasoningPreset = arkKeyBody.models.find((m: any) => m.provider === 'volcengine' && m.reasoning === true && m.id.includes('doubao'));
        assert(Boolean(arkReasoningPreset), `Expected at least one reasoning doubao preset in Volcengine list: ${JSON.stringify(arkKeyBody.models)}`);
        const arkSelectSeedRes = await keyRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: arkReasoningPreset.key }),
        });
        assert(arkSelectSeedRes.status === 200, `Expected 200 selecting Volcengine Doubao reasoning model, got ${arkSelectSeedRes.status}`);
        const arkSelectSeedBody = await arkSelectSeedRes.json();
        assert(
          keySession.model?.reasoning === true &&
            Array.isArray(arkSelectSeedBody.availableThinkingLevels) &&
            arkSelectSeedBody.availableThinkingLevels.includes('low') &&
            detectModelFamily(arkReasoningPreset.key) === 'doubao',
          `Unexpected Volcengine Doubao reasoning capabilities: ${JSON.stringify(arkSelectSeedBody)}`
        );

        const arkSelectR1Res = await keyRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'volcengine/deepseek-r1-dynamic' }),
        });
        assert(arkSelectR1Res.status === 200, `Expected 200 selecting Volcengine DeepSeek R1, got ${arkSelectR1Res.status}`);
        const arkSelectR1Body = await arkSelectR1Res.json();
        assert(
          Array.isArray(arkSelectR1Body.availableThinkingLevels) &&
            arkSelectR1Body.availableThinkingLevels.length > 0 &&
            !arkSelectR1Body.availableThinkingLevels.includes('off'),
          `Expected mandatory thinking (no 'off') for Volcengine DeepSeek R1, got ${JSON.stringify(arkSelectR1Body.availableThinkingLevels)}`
        );

        const arkSelectDynamicEpRes = await keyRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'volcengine/ep-20260202-dyn02' }),
        });
        assert(arkSelectDynamicEpRes.status === 200, `Expected 200 selecting dynamic Ark ep-* endpoint, got ${arkSelectDynamicEpRes.status}`);
        const arkSelectDynamicEpBody = await arkSelectDynamicEpRes.json();
        assert(
          arkSelectDynamicEpBody.current === 'volcengine/ep-20260202-dyn02',
          `Expected current volcengine/ep-20260202-dyn02, got ${arkSelectDynamicEpBody.current}`
        );

        // Switch API key to SiliconFlow with live catalog sync + non-chat filtering + custom Pro/* model
        delete process.env.PI_OFFLINE;
        globalThis.fetch = (async (input: any, init?: any) => {
          const url = typeof input === 'string' ? input : input?.url || '';
          if (url.startsWith('https://api.siliconflow.cn/v1/models')) {
            const auth = new Headers(init?.headers).get('Authorization');
            assert(auth === 'Bearer sk-siliconflow-faux-test-secret', `Expected Bearer auth on SiliconFlow catalog fetch, got ${auth}`);
            return new Response(
              JSON.stringify({
                object: 'list',
                data: [
                  { id: 'deepseek-ai/DeepSeek-V3.2', sub_type: 'chat' },
                  { id: 'Qwen/Qwen3-32B', sub_type: 'chat' },
                  { id: 'Qwen/Qwen2.5-72B-Instruct', sub_type: 'chat' },
                  { id: 'zai-org/GLM-4.7', sub_type: 'chat' },
                  { id: 'BAAI/bge-m3', sub_type: 'embedding' },
                  { id: 'black-forest-labs/FLUX.1-dev', sub_type: 'text-to-image' },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (url.startsWith('https://ark.cn-beijing.volces.com/api/v3/models')) {
            return new Response(
              JSON.stringify({
                object: 'list',
                data: [
                  { id: 'doubao-seed-live-pro', domain: 'LLM' },
                  { id: 'doubao-seedream-5.0', domain: 'Text2Image' },
                  { id: 'doubao-embedding-large-text', domain: 'Embedding' },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return origGlobalFetch(input, init);
        }) as typeof fetch;

        const sfKeyRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'siliconflow',
            apiKey: 'sk-siliconflow-faux-test-secret',
            customModel: 'Pro/deepseek-ai/DeepSeek-V3.2',
          }),
        });
        assert(sfKeyRes.status === 200, `Expected 200 setting siliconflow runtime key, got ${sfKeyRes.status}`);
        const sfKeyBody = await sfKeyRes.json();
        assert(
          sfKeyBody.current === 'siliconflow/Pro/deepseek-ai/DeepSeek-V3.2',
          `Expected current siliconflow/Pro/deepseek-ai/DeepSeek-V3.2, got ${sfKeyBody.current}`
        );
        assert(
          Array.isArray(sfKeyBody.models) &&
            sfKeyBody.models.some((m: any) => m.key === 'siliconflow/deepseek-ai/DeepSeek-V3.2') &&
            sfKeyBody.models.some((m: any) => m.key === 'siliconflow/Qwen/Qwen2.5-72B-Instruct') &&
            sfKeyBody.models.some((m: any) => m.key === 'siliconflow/Pro/deepseek-ai/DeepSeek-V3.2') &&
            !sfKeyBody.models.some((m: any) => m.id === 'BAAI/bge-m3' || m.id === 'black-forest-labs/FLUX.1-dev') &&
            !sfKeyBody.models.some((m: any) => m.provider === 'volcengine' || m.provider === 'modelscope'),
          `Unexpected SiliconFlow models list: ${JSON.stringify(sfKeyBody.models)}`
        );
        const sfMeta = sfKeyBody.providers?.find((p: any) => p.id === 'siliconflow');
        assert(
          sfMeta?.configured === true && sfMeta?.source === 'runtime' && sfMeta?.envVar === 'SILICONFLOW_API_KEY',
          `Unexpected SiliconFlow provider metadata: ${JSON.stringify(sfMeta)}`
        );
        assert(
          keySession.model?.baseUrl === 'https://api.siliconflow.cn/v1' &&
            keySession.model?.api === 'openai-completions' &&
            keySession.model?.reasoning === true &&
            Array.isArray(sfKeyBody.availableThinkingLevels) &&
            sfKeyBody.availableThinkingLevels.includes('low'),
          `Unexpected SiliconFlow resolved model config: ${JSON.stringify(sfKeyBody)}`
        );
        assert(
          !JSON.stringify(sfKeyBody).includes('sk-siliconflow-faux-test-secret') &&
            !JSON.stringify(keyEvents).includes('sk-siliconflow-faux-test-secret'),
          'SiliconFlow API key secret must never appear in HTTP responses or SSE events'
        );

        const sfSelectNonThinkingRes = await keyRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'siliconflow/Qwen/Qwen2.5-72B-Instruct' }),
        });
        assert(sfSelectNonThinkingRes.status === 200, `Expected 200 selecting non-thinking SiliconFlow model, got ${sfSelectNonThinkingRes.status}`);
        assert(
          keySession.model?.reasoning === false,
          `Expected reasoning === false on non-thinking Qwen2.5 model, got ${keySession.model?.reasoning}`
        );

        const sfSelectDynamicRes = await keyRouter.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'siliconflow/Pro/Qwen/Qwen3-32B' }),
        });
        assert(sfSelectDynamicRes.status === 200, `Expected 200 selecting dynamic SiliconFlow slash model, got ${sfSelectDynamicRes.status}`);
        const sfSelectDynamicBody = await sfSelectDynamicRes.json();
        assert(
          sfSelectDynamicBody.current === 'siliconflow/Pro/Qwen/Qwen3-32B' && keySession.model?.reasoning === true,
          `Expected dynamic Pro/Qwen/Qwen3-32B with reasoning === true, got ${JSON.stringify(sfSelectDynamicBody.current)}`
        );

        // Also verify mocked Volcengine catalog filters out non-chat models (seedream / embedding)
        const arkLiveRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'volcengine', apiKey: 'ark-faux-live-secret' }),
        });
        assert(arkLiveRes.status === 200, `Expected 200 refreshing Volcengine live catalog, got ${arkLiveRes.status}`);
        const arkLiveBody = await arkLiveRes.json();
        assert(
          arkLiveBody.models.some((m: any) => m.key === 'volcengine/doubao-seed-live-pro') &&
            !arkLiveBody.models.some((m: any) => m.id === 'doubao-seedream-5.0' || m.id === 'doubao-embedding-large-text'),
          `Volcengine catalog should exclude non-chat models: ${JSON.stringify(arkLiveBody.models)}`
        );
        assert(
          !JSON.stringify(arkLiveBody).includes('ark-faux-live-secret'),
          'Volcengine live secret must never appear in HTTP response'
        );

        // Clear Volcengine runtime key and verify models refresh cleanly
        process.env.PI_OFFLINE = '1';
        const clearKeyRes = await keyRouter.request('/api/models/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'volcengine', apiKey: '' }),
        });
        assert(clearKeyRes.status === 200, `Expected 200 clearing volcengine runtime key, got ${clearKeyRes.status}`);
        const clearKeyBody = await clearKeyRes.json();
        const arkClearedMeta = clearKeyBody.providers?.find((p: any) => p.id === 'volcengine');
        assert(
          arkClearedMeta?.configured === false && arkClearedMeta?.source === null,
          `Expected volcengine provider unconfigured after clear, got ${JSON.stringify(arkClearedMeta)}`
        );
        assert(
          clearKeyBody.current === null && Array.isArray(clearKeyBody.models) && clearKeyBody.models.length === 0,
          `Expected no models and current === null after clearing volcengine key, got ${JSON.stringify(clearKeyBody)}`
        );

        // Verify environment-variable startup detection for ARK_API_KEY and SILICONFLOW_API_KEY
        process.env.ARK_API_KEY = 'ark-env-faux-test-secret';
        const envArkService = new AgentService(keyWs, { sessionMode: 'memory' });
        try {
          const envArkState = await envArkService.getModelsState();
          const envArkMeta = envArkState.providers.find((p) => p.id === 'volcengine');
          assert(
            envArkMeta?.configured === true &&
              envArkMeta?.source === 'environment' &&
              typeof envArkState.current === 'string' &&
              envArkState.current.startsWith('volcengine/') &&
              !JSON.stringify(envArkState).includes('ark-env-faux-test-secret'),
            `Expected ARK_API_KEY environment startup configuration, got ${JSON.stringify(envArkState)}`
          );
        } finally {
          (envArkService as any).disposeCurrentSessionState?.(true);
          delete process.env.ARK_API_KEY;
        }

        process.env.SILICONFLOW_API_KEY = 'sk-siliconflow-env-faux-secret';
        const envSfService = new AgentService(keyWs, { sessionMode: 'memory' });
        try {
          const envSfState = await envSfService.getModelsState();
          const envSfMeta = envSfState.providers.find((p) => p.id === 'siliconflow');
          assert(
            envSfMeta?.configured === true &&
              envSfMeta?.source === 'environment' &&
              typeof envSfState.current === 'string' &&
              envSfState.current.startsWith('siliconflow/') &&
              !JSON.stringify(envSfState).includes('sk-siliconflow-env-faux-secret'),
            `Expected SILICONFLOW_API_KEY environment startup configuration, got ${JSON.stringify(envSfState)}`
          );
        } finally {
          (envSfService as any).disposeCurrentSessionState?.(true);
          delete process.env.SILICONFLOW_API_KEY;
        }

        keyService.off('agent_event', onKeyEvent);
      } finally {
        globalThis.fetch = origGlobalFetch;
        (keyService as any).disposeCurrentSessionState?.(true);
      }
    },
    { offline: true }
  );

  console.log('12. Verifying disk session persistence, restart recovery, and session reset...');
  await withIsolatedHomeAndEnv('papercup-persist-test-', async ({ home: persistHome, ws: persistWs }) => {
    let s1: AgentService | null = null;
    let s2: AgentService | null = null;
    let s3: AgentService | null = null;
    let s4: AgentService | null = null;
    try {
      // 1) Initial service instance runs turn 1 with vn_detect tool call under default sessionMode='persist'
      s1 = new AgentService(persistWs);
      await s1.initSession();
      const s1Faux = createFauxCore({ tokensPerSecond: 10000 });
      const s1Sess = (s1 as any).currentSession;
      s1Sess.agent.state.model = s1Faux.getModel();
      s1Sess.agent.streamFunction = s1Faux.streamSimple;
      s1Sess._modelRuntime.hasConfiguredAuth = () => true;
      s1Faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_detect', {}, { id: 'tc-p-detect' })]),
        () => fauxAssistantMessage('已保存第 1 轮检测结果。'),
      ]);
      await s1.executeTurn('先检测封包');
      (s1 as any).disposeCurrentSessionState?.(true);
      s1 = null;

      const projectsDir = path.join(persistHome, '.papercup', 'projects');
      assert(fs.existsSync(projectsDir), 'Expected ~/.papercup/projects directory for persisted sessions');
      assert(!fs.existsSync(path.join(persistWs, '.papercup', 'sessions')), 'Should not pollute workspace with sessions dir');

      // 2) Simulated restart: brand-new AgentService instance must restore conversation history & continue context
      s2 = new AgentService(persistWs);
      const s2Router = createApiRouter(s2);
      const histRes = await s2Router.request('/api/session/history');
      assert(histRes.status === 200, `Expected 200 from /api/session/history, got ${histRes.status}`);
      const histBody = await histRes.json();
      assert(histBody.persisted === true, 'Expected persisted: true');
      const sessionAId: string = histBody.sessionId;
      assert(Boolean(sessionAId), 'Expected non-empty sessionId for Session A');
      assert(
        Array.isArray(histBody.sessions) && histBody.sessions.length === 1 && histBody.sessions[0].id === sessionAId,
        `Expected 1 session summary for Session A, got ${JSON.stringify(histBody.sessions)}`
      );
      assert(
        Array.isArray(histBody.messages) &&
          histBody.messages.length === 2 &&
          histBody.messages[0].role === 'user' &&
          histBody.messages[0].content === '先检测封包' &&
          histBody.messages[1].role === 'assistant' &&
          histBody.messages[1].content.includes('已保存第 1 轮检测结果') &&
          Array.isArray(histBody.messages[1].tools) &&
          histBody.messages[1].tools[0]?.tool === 'vn_detect' &&
          histBody.messages[1].tools[0]?.result !== undefined,
        `Unexpected restored session history: ${JSON.stringify(histBody)}`
      );

      const s2Faux = createFauxCore({ tokensPerSecond: 10000 });
      const s2Sess = (s2 as any).currentSession;
      s2Sess.agent.state.model = s2Faux.getModel();
      s2Sess.agent.streamFunction = s2Faux.streamSimple;
      s2Sess._modelRuntime.hasConfiguredAuth = () => true;
      let seenHistoryCount = 0;
      s2Faux.setResponses([
        (ctx) => {
          seenHistoryCount = ctx.messages.length;
          return fauxAssistantMessage('已接续此前对话继续处理。');
        },
      ]);
      await s2.executeTurn('继续处理');
      assert(seenHistoryCount >= 4, `Expected resumed LLM context to include prior turn messages, got ${seenHistoryCount}`);

      // 3) Create Session B draft via POST /api/session/new — must NOT persist or appear in sessions until first prompt
      const newBRes = await s2Router.request('/api/session/new', { method: 'POST' });
      assert(newBRes.status === 200, `Expected 200 from /api/session/new, got ${newBRes.status}`);
      const newBBody = await newBRes.json();
      const sessionBId: string = newBBody.sessionId;
      const persistSessionDir = (s2 as any).resolveSessionDir(persistWs);
      const jsonlFilesAfterDraftB = fs.readdirSync(persistSessionDir).filter((f) => f.endsWith('.jsonl'));
      assert(
        newBBody.ok === true &&
          Boolean(sessionBId) &&
          sessionBId !== sessionAId &&
          Array.isArray(newBBody.messages) &&
          newBBody.messages.length === 0 &&
          Array.isArray(newBBody.sessions) &&
          newBBody.sessions.length === 1 &&
          newBBody.sessions[0].id === sessionAId &&
          jsonlFilesAfterDraftB.length === 1,
        `Expected Session B draft NOT to persist or appear in sessions before first prompt, got sessions=${JSON.stringify(newBBody.sessions)}, files=${JSON.stringify(jsonlFilesAfterDraftB)}`
      );

      // Switching away from empty draft leaves zero orphan files on disk; creating fresh draft again stays uncommitted
      await s2Router.request('/api/sessions/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionAId }),
      });
      assert(
        fs.readdirSync(persistSessionDir).filter((f) => f.endsWith('.jsonl')).length === 1,
        'Abandoning an empty draft must leave zero extra .jsonl files on disk'
      );
      const newB2Body = await (await s2Router.request('/api/session/new', { method: 'POST' })).json();
      const sessionBCommittedId: string = newB2Body.sessionId;
      assert(
        newB2Body.sessions.length === 1 &&
          fs.readdirSync(persistSessionDir).filter((f) => f.endsWith('.jsonl')).length === 1,
        'Second empty draft must also wait for first user prompt before archiving'
      );

      const s2BFaux = createFauxCore({ tokensPerSecond: 10000 });
      const s2BSess = (s2 as any).currentSession;
      s2BSess.agent.state.model = s2BFaux.getModel();
      s2BSess.agent.streamFunction = s2BFaux.streamSimple;
      s2BSess._modelRuntime.hasConfiguredAuth = () => true;
      let notifyS2BBusy!: () => void;
      const s2BBusyStarted = new Promise<void>((r) => (notifyS2BBusy = r));
      let releaseS2BBusy!: () => void;
      const s2BBusyGate = new Promise<void>((r) => (releaseS2BBusy = r));
      s2BFaux.setResponses([
        async () => {
          notifyS2BBusy();
          await s2BBusyGate;
          return fauxAssistantMessage('会话 B 回复完成。');
        },
      ]);
      const turnBPromise = s2.executeTurn('测试第二个会话');
      await s2BBusyStarted;

      // Verify 409 busy guard on /api/sessions/select during a genuine in-flight turn
      const busySelectSessRes = await s2Router.request('/api/sessions/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionAId }),
      });
      assert(
        busySelectSessRes.status === 409,
        `Expected 409 selecting session while turn is running, got ${busySelectSessRes.status}`
      );
      releaseS2BBusy();
      await turnBPromise;

      const jsonlFilesAfterTurnB = fs.readdirSync(persistSessionDir).filter((f) => f.endsWith('.jsonl'));
      assert(
        jsonlFilesAfterTurnB.length === 2,
        `Expected Session B to commit to disk after first user prompt, got files=${JSON.stringify(jsonlFilesAfterTurnB)}`
      );

      const sessionsListRes = await s2Router.request('/api/sessions');
      assert(sessionsListRes.status === 200, `Expected 200 from /api/sessions, got ${sessionsListRes.status}`);
      const sessionsListBody = await sessionsListRes.json();
      assert(
        sessionsListBody.sessions.some((s: any) => s.id === sessionAId && s.title.includes('先检测封包')) &&
          sessionsListBody.sessions.some((s: any) => s.id === sessionBCommittedId && s.title.includes('测试第二个会话')),
        `Expected both Session A and Session B titles in list, got ${JSON.stringify(sessionsListBody.sessions)}`
      );

      // Verify 404 guard on /api/sessions/select
      const missingSessRes = await s2Router.request('/api/sessions/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'non-existent-session' }),
      });
      assert(missingSessRes.status === 404, `Expected 404 selecting unknown session, got ${missingSessRes.status}`);

      // 4) Switch back to Session A and verify restart resumes Session A
      const switchARes = await s2Router.request('/api/sessions/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionAId }),
      });
      assert(switchARes.status === 200, `Expected 200 switching back to Session A, got ${switchARes.status}`);
      const switchABody = await switchARes.json();
      assert(
        switchABody.sessionId === sessionAId &&
          switchABody.messages.some((m: any) => m.content.includes('已保存第 1 轮检测结果')),
        `Expected Session A messages restored after switch, got ${JSON.stringify(switchABody)}`
      );
      (s2 as any).disposeCurrentSessionState?.(true);
      s2 = null;

      s3 = new AgentService(persistWs);
      const s3Router = createApiRouter(s3);
      const s3Hist = await s3.getSessionHistory();
      assert(
        s3Hist.sessionId === sessionAId && s3Hist.sessions.length === 2,
        `Expected restarted service to resume selected Session A with 2 sessions, got ${JSON.stringify(s3Hist)}`
      );

      // 5) Delete Session A and verify active session falls back to Session B, then delete Session B
      const delARes = await s3Router.request('/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionAId }),
      });
      assert(delARes.status === 200, `Expected 200 deleting Session A, got ${delARes.status}`);
      const delABody = await delARes.json();
      assert(
        delABody.sessionId === sessionBCommittedId &&
          delABody.sessions.length === 1 &&
          delABody.messages.some((m: any) => m.content.includes('会话 B 回复完成')),
        `Expected fallback to Session B after deleting Session A, got ${JSON.stringify(delABody)}`
      );

      const delBRes = await s3Router.request('/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionBCommittedId }),
      });
      assert(delBRes.status === 200, `Expected 200 deleting Session B, got ${delBRes.status}`);
      const delBBody = await delBRes.json();
      assert(delBBody.messages.length === 0, 'Expected empty messages after deleting last session');
      (s3 as any).disposeCurrentSessionState?.(true);
      s3 = null;

      s4 = new AgentService(persistWs);
      const s4Hist = await s4.getSessionHistory();
      assert(s4Hist.messages.length === 0, `Expected fresh session after all deleted, got ${JSON.stringify(s4Hist)}`);
    } finally {
      (s1 as any)?.disposeCurrentSessionState?.(true);
      (s2 as any)?.disposeCurrentSessionState?.(true);
      (s3 as any)?.disposeCurrentSessionState?.(true);
      (s4 as any)?.disposeCurrentSessionState?.(true);
    }
  });

  // 13. 無ツールサブエージェントの偽 tool_call 拒否（合法 JSONL 誤爆回避含む）・.env 全ツール遮断・メトリクス/診断ログ・Thinking レベル検証
  console.log('13. Verifying tool-less <tool_call> rejection, .env guards, subagent diagnostics, and thinking controls...');
  await withIsolatedHomeAndEnv('papercup-obs-test-', async ({ home: obsHome, ws: obsWs }) => {
    fs.writeFileSync(path.join(obsWs, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "third"\n', 'utf-8');
    fs.mkdirSync(path.join(obsHome, '.papercup'), { recursive: true });
    fs.writeFileSync(
      path.join(obsHome, '.papercup', 'config.toml'),
      'api_key = "sk-ant-top-secret-value-123456"\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(obsWs, '.env'), 'GEMINI_API_KEY=AIzaSySecretTestValue1234567890\n', 'utf-8');

    const obsService = new AgentService(obsWs, { sessionMode: 'persist' });
    const obsRouter = createApiRouter(obsService);
    try {
      await obsService.initSession();

      // Check thinking defaults and /api/models/thinking transitions deterministically with an explicit reasoning model
      const obsReasoningFaux = createFauxCore({ provider: 'faux-obs-think', models: [{ id: 'obs-think-1', reasoning: true }] });
      const initModelsRes = await obsRouter.request('/api/models');
      const initModelsBody = await initModelsRes.json();
      assert(
        initModelsBody.current === null &&
          initModelsBody.thinkingLevel === 'off' &&
          Array.isArray(initModelsBody.availableThinkingLevels) &&
          initModelsBody.availableThinkingLevels.includes('low'),
        `Expected keyless session to clamp thinkingLevel='off' with standard availableThinkingLevels, got ${JSON.stringify(initModelsBody)}`
      );

      // Attach explicit reasoning model and verify real thinkingLevel transitions (low -> high -> off) + invalid 400
      const obsInitSession = (obsService as any).currentSession;
      obsInitSession.agent.state.model = obsReasoningFaux.getModel();
      const badThinkRes = await obsRouter.request('/api/models/thinking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingLevel: 'invalid-level' }),
      });
      assert(badThinkRes.status === 400, `Expected 400 for invalid thinkingLevel, got ${badThinkRes.status}`);

      for (const targetLevel of ['low', 'high', 'off'] as const) {
        const setThinkRes = await obsRouter.request('/api/models/thinking', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thinkingLevel: targetLevel }),
        });
        assert(setThinkRes.status === 200, `Expected 200 setting thinkingLevel '${targetLevel}', got ${setThinkRes.status}`);
        const setThinkBody = await setThinkRes.json();
        assert(
          setThinkBody.thinkingLevel === targetLevel,
          `Expected thinkingLevel '${targetLevel}', got ${setThinkBody.thinkingLevel}`
        );
      }

      // Verify subagent role thinking defaults deterministically using the same explicit reasoning model
      const obsSubMgr = (obsService as any).subagentManager as SubagentManager;
      const tCheck = await obsSubMgr.createSubagentSession('translator', {
        cwd: obsWs,
        model: obsReasoningFaux.getModel(),
      });
      try {
        assert(tCheck.session.thinkingLevel === 'off', `Expected translator thinkingLevel 'off', got ${tCheck.session.thinkingLevel}`);
      } finally {
        tCheck.session.dispose?.();
      }
      const rCheck = await obsSubMgr.createSubagentSession('role-checker', {
        cwd: obsWs,
        model: obsReasoningFaux.getModel(),
      });
      try {
        const rAvail: string[] = rCheck.session.getAvailableThinkingLevels?.() ?? [];
        assert(
          rAvail.includes('low') && rCheck.session.thinkingLevel === 'low',
          `Expected role-checker with reasoning model to select thinkingLevel='low', avail=${JSON.stringify(rAvail)}, got=${rCheck.session.thinkingLevel}`
        );
      } finally {
        rCheck.session.dispose?.();
      }

      const obsMainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const obsSubFaux = createFauxCore({ tokensPerSecond: 10000 });
      const obsSession = (obsService as any).currentSession;
      obsSession.agent.state.model = obsMainFaux.getModel();
      obsSession.agent.streamFunction = obsMainFaux.streamSimple;
      obsSession._modelRuntime.hasConfiguredAuth = () => true;

      const origObsCreateSub = obsSubMgr.createSubagentSession.bind(obsSubMgr);
      obsSubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origObsCreateSub(roleName, opts);
        (res.session as any).agent.state.model = obsSubFaux.getModel();
        (res.session as any).agent.streamFunction = obsSubFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      // 1) First call returns unexecuted <tool_call> XML -> must be flagged as isError=true
      // 2) Second call returns valid translation JSONL -> succeeds and writes diagnostics
      // 3) Third call returns valid JSONL whose dialogue legitimately contains <invoke> and <tool_call> -> must NOT be falsely rejected!
      obsSubFaux.setResponses([
        () => fauxAssistantMessage('<tool_call><function=functions.read>{"path":"work/batches/batch_001.jsonl"}</function></tool_call>'),
        () => fauxAssistantMessage('{"id":1,"target":"已翻译台词"}'),
        () => fauxAssistantMessage('{"id":2,"target":"终端显示了<invoke>和<tool_call>字样。"}'),
      ]);

      obsMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('read', { path: path.join(obsHome, '.papercup', 'config.toml') }, { id: 'tc-sec-global' })]),
        () => fauxAssistantMessage([fauxToolCall('read', { path: 'papercup.toml' }, { id: 'tc-sec-ws' })]),
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'cat ~/.papercup/config.toml' }, { id: 'tc-sec-bash' })]),
        // Actually test .env fixture across read, edit, write, and bash
        () => fauxAssistantMessage([fauxToolCall('read', { path: '.env' }, { id: 'tc-sec-env-read' })]),
        () => fauxAssistantMessage([fauxToolCall('edit', { path: '.env', edits: [{ oldText: 'GEMINI_API_KEY', newText: 'X' }] }, { id: 'tc-sec-env-edit' })]),
        () => fauxAssistantMessage([fauxToolCall('write', { path: '.env', content: 'HACK=1\n' }, { id: 'tc-sec-env-write' })]),
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'cat .env' }, { id: 'tc-sec-env-bash' })]),
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'translator', task: 'translate batch_001' }, { id: 'tc-sub-xml' })]),
        (ctx) => {
          const globalRead = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sec-global') as any;
          assert(globalRead?.isError === true, 'Reading ~/.papercup/config.toml must be blocked');
          const wsRead = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sec-ws') as any;
          assert(wsRead?.isError !== true, `Reading workspace papercup.toml must succeed, got: ${JSON.stringify(wsRead)}`);
          const bashBlocked = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sec-bash') as any;
          assert(bashBlocked?.isError === true, 'Bash reading ~/.papercup/config.toml must be blocked');
          for (const envCallId of ['tc-sec-env-read', 'tc-sec-env-edit', 'tc-sec-env-write', 'tc-sec-env-bash']) {
            const envRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === envCallId) as any;
            assert(
              envRes?.isError === true && !JSON.stringify(envRes).includes('AIzaSySecretTestValue1234567890'),
              `Guarded tool ${envCallId} on .env must be blocked without leaking key, got: ${JSON.stringify(envRes)}`
            );
          }
          const xmlRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sub-xml') as any;
          assert(xmlRes?.isError === true, 'Tool-less subagent returning <tool_call> XML must have isError=true');
          return fauxAssistantMessage([
            fauxToolCall('delegate_task', { role: 'translator', task: '{"id":1,"source":"翻訳テスト"}' }, { id: 'tc-sub-ok' }),
          ]);
        },
        (ctx) => {
          const okRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sub-ok') as any;
          assert(okRes && okRes.isError !== true, 'Second translator call should succeed');
          assert(okRes.details?.metrics?.role === 'translator' && typeof okRes.details?.metrics?.durationMs === 'number', 'Missing metrics in delegate_task details');
          return fauxAssistantMessage([
            fauxToolCall(
              'delegate_task',
              { role: 'translator', task: '<batch id="b">\n{"id":2,"source":"端末に<invoke>と<tool_call>が表示された。"}\n</batch>' },
              { id: 'tc-sub-valid-jsonl-tags' }
            ),
          ]);
        },
        (ctx) => {
          const tagRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sub-valid-jsonl-tags') as any;
          assert(
            tagRes && tagRes.isError !== true,
            `Valid translator JSONL containing <invoke>/<tool_call> in dialogue must NOT be rejected, got: ${JSON.stringify(tagRes)}`
          );
          return fauxAssistantMessage('观测与安全测试完成。');
        },
      ]);

      await obsService.executeTurn('运行安全与观测检验');
      assert(
        fs.readFileSync(path.join(obsWs, '.env'), 'utf-8').includes('AIzaSySecretTestValue1234567890'),
        'Blocked .env write/edit must leave original .env untouched on disk'
      );

      // Verify sanitized diagnostics JSONL was written without raw text or secrets
      const diagFile = path.join(obsWs, '.papercup', 'tmp', 'diagnostics', 'subagents.jsonl');
      assert(fs.existsSync(diagFile), 'Expected .papercup/tmp/diagnostics/subagents.jsonl to be written');
      const diagLines = fs.readFileSync(diagFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      assert(diagLines.length === 3, `Expected 3 subagent diagnostic entries, got ${diagLines.length}`);
      assert(
        diagLines[0].status === 'error' && diagLines[1].status === 'success' && diagLines[2].status === 'success',
        `Unexpected diag statuses: ${JSON.stringify(diagLines)}`
      );
      const diagText = fs.readFileSync(diagFile, 'utf-8');
      assert(
        !diagText.includes('已翻译台词') &&
          !diagText.includes('sk-ant-top-secret') &&
          !diagText.includes('AIzaSySecretTestValue1234567890'),
        'Diagnostics log must not contain raw translations or secrets'
      );

      // Verify persisted session file never contains secret string
      const sessionFile = (obsService as any).sessionManager.getSessionFile();
      if (sessionFile && fs.existsSync(sessionFile)) {
        const sessionContent = fs.readFileSync(sessionFile, 'utf-8');
        assert(
          !sessionContent.includes('sk-ant-top-secret-value-123456') &&
            !sessionContent.includes('AIzaSySecretTestValue1234567890'),
          'Persisted session must never contain secret'
        );
      }

      // Verify orphaned toolCall in persisted session is marked interrupted instead of spinning forever
      const mgr = (obsService as any).sessionManager;
      mgr.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '模拟被强杀的请求' }],
        timestamp: Date.now(),
      });
      mgr.appendMessage({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-orphan', name: 'delegate_task', arguments: { role: 'translator', task: '...' } }],
        api: 'openai-completions',
        provider: 'faux',
        model: 'faux',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: Date.now(),
      });
      const orphanHistRes = await obsRouter.request('/api/session/history');
      const orphanHistBody = await orphanHistRes.json();
      const lastAssist = orphanHistBody.messages[orphanHistBody.messages.length - 1];
      assert(
        orphanHistBody.isRunning === false &&
          lastAssist.tools?.[0]?.isError === true &&
          lastAssist.tools?.[0]?.result?.details?.status === 'interrupted' &&
          lastAssist.content.includes('中断'),
        `Orphaned toolCall must be marked interrupted when idle, got: ${JSON.stringify(lastAssist)}`
      );
    } finally {
      (obsService as any).disposeCurrentSessionState?.(true);
    }
  });

  // 14. ランダム空きポート上の実 HTTP + SSE 同期＆実行中キャンセル検証（:3100 競合なし）
  console.log('14. Verifying ephemeral-port HTTP/SSE sync_state, refresh snapshot, and cascading abort...');
  await withIsolatedHomeAndEnv('papercup-sse-test-', async ({ ws: sseWs }) => {
    const sseService = new AgentService(sseWs, { sessionMode: 'memory' });
    const sseRouter = createApiRouter(sseService);
    let httpServer: ReturnType<typeof serve> | null = null;
    try {
      await sseService.initSession();
      const sseSession = (sseService as any).currentSession;
      const sseMainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const sseSubFaux = createFauxCore({ tokensPerSecond: 10000 });
      sseSession.agent.state.model = sseMainFaux.getModel();
      sseSession.agent.streamFunction = sseMainFaux.streamSimple;
      sseSession._modelRuntime.hasConfiguredAuth = () => true;

      const sseSubMgr = (sseService as any).subagentManager as SubagentManager;
      const origSseSub = sseSubMgr.createSubagentSession.bind(sseSubMgr);
      let notifyInFlight: (() => void) | undefined;
      const inFlightPromise = new Promise<void>((resolve) => {
        notifyInFlight = resolve;
      });
      sseSubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origSseSub(roleName, opts);
        (res.session as any).agent.state.model = sseSubFaux.getModel();
        (res.session as any).agent.streamFunction = sseSubFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      sseSubFaux.setResponses([
        (_ctx, opts) =>
          new Promise((resolve) => {
            notifyInFlight?.();
            const t = setTimeout(() => resolve(fauxAssistantMessage('late')), 5000);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
              },
              { once: true }
            );
          }),
      ]);
      sseMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'translator', task: '{"id":1,"source":"x"}' }, { id: 'tc-http-sub' })]),
        () => fauxAssistantMessage('unreachable'),
      ]);

      httpServer = serve({ fetch: sseRouter.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => httpServer!.once('listening', resolve));
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      assert(port > 0, `Expected ephemeral port > 0, got ${port}`);
      const baseUrl = `http://127.0.0.1:${port}`;

      // Seed an earlier interrupted toolCall before starting the live HTTP turn
      const sseMgr = (sseService as any).sessionManager;
      sseMgr.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '早前的断线任务' }],
        timestamp: Date.now() - 5000,
      });
      sseMgr.appendMessage({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-prior-orphan', name: 'delegate_task', arguments: { role: 'translator', task: 'old' } }],
        api: 'openai-completions',
        provider: 'faux',
        model: 'faux',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: Date.now() - 4000,
      });

      // Check SSE initial sync_state event while idle
      const sseAbort = new AbortController();
      const sseRes = await fetch(`${baseUrl}/api/turns/stream`, { signal: sseAbort.signal });
      const reader = sseRes.body!.getReader();
      const firstChunk = await reader.read();
      const sseText = new TextDecoder().decode(firstChunk.value);
      sseAbort.abort();
      assert(sseText.includes('event: sync_state') && sseText.includes('"isRunning":false'), `Unexpected initial SSE payload: ${sseText}`);

      // Start real HTTP turn and inspect /api/turns/status & /api/session/history mid-flight (refresh simulation)
      const startHttp = await fetch(`${baseUrl}/api/turns/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '实机刷新与取消测试' }),
      });
      assert(startHttp.status === 200, `Expected 200 starting HTTP turn, got ${startHttp.status}`);
      await inFlightPromise;

      const statusDuring = await (await fetch(`${baseUrl}/api/turns/status`)).json();
      const histDuring = await (await fetch(`${baseUrl}/api/session/history`)).json();
      assert(statusDuring.isRunning === true && statusDuring.activeTurn?.tools?.length === 1, `Expected active turn snapshot, got ${JSON.stringify(statusDuring)}`);
      assert(histDuring.isRunning === true && histDuring.activeTurn?.tools?.[0]?.tool === 'delegate_task', `Expected running history snapshot, got ${JSON.stringify(histDuring)}`);

      const priorHistMsg = histDuring.messages.find((m: any) => m.role === 'assistant');
      assert(
        priorHistMsg?.tools?.[0]?.result?.details?.status === 'interrupted' &&
          priorHistMsg?.tools?.[0]?.isError === true,
        `Earlier orphaned toolCall must remain interrupted during an active turn refresh, got ${JSON.stringify(priorHistMsg)}`
      );

      const abortHttp = await (await fetch(`${baseUrl}/api/turns/abort`, { method: 'POST' })).json();
      assert(abortHttp.ok === true && abortHttp.aborted === true, `Expected abort via HTTP, got ${JSON.stringify(abortHttp)}`);

      // Wait briefly for turn cleanup
      const deadline = Date.now() + 3000;
      while (sseService.isBusy() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert(!sseService.isBusy(), 'Expected turn to become idle promptly after cascading HTTP abort');
    } finally {
      httpServer?.close();
      (sseService as any).disposeCurrentSessionState?.(true);
    }
  });

  console.log(
    '\n15. Verifying Phase 2 workflow: vn_plan -> vn_translate_batches (direct write + cap rotation) -> vn_post_qa_parallel -> vn_writeback (delta patch) -> vn_accept -> vn_release...'
  );
  await withIsolatedHomeAndEnv('papercup-p2-', async ({ root: tmpP2Root, ws: tmpP2Ws }) => {
    const tmpP2Export = path.join(tmpP2Root, 'game.translated-test');
    fs.mkdirSync(path.join(tmpP2Ws, 'vn'), { recursive: true });
    fs.mkdirSync(path.join(tmpP2Ws, '.papercup', 'tmp', 'p2ypf'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpP2Ws, 'papercup.toml'),
      [
        '[vn.localization]',
        'narrative_pov = "first"',
        'player_address = "你"',
        'source_lang = "ja"',
        'target_lang = "zh"',
        'max_len_ratio = 3.0',
        'glossary_file = "vn/glossary.json"',
        'persona_file = "vn/persona.json"',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpP2Ws, 'vn', 'glossary.json'), JSON.stringify({ 先輩: '前辈' }), 'utf8');
    fs.writeFileSync(path.join(tmpP2Ws, 'vn', 'persona.json'), JSON.stringify({ ヒロイン: '温柔体贴的学妹' }), 'utf8');
    fs.writeFileSync(path.join(tmpP2Ws, 'Game.exe'), Buffer.from('MZ-p2-exe'));

    const storyText = [
      '先輩、今日は本当にお天気がよくて気持ちがとってもいいですね！',
      'それでは学校の中庭まで一緒にお散歩しながらお話ししましょう。[p]',
      '放課後になったら資料室で明日の発表の準備を手伝ってください。',
      'また明日も同じ時間に正門の前で待ち合わせすることにしましょう。',
    ].join('\n') + '\n';
    const storyBytes = Buffer.from(storyText, 'utf8');
    const storyName = Buffer.from('story.txt', 'utf8');
    const ypfP2 = Buffer.concat([
      Buffer.from('YPF\x00', 'ascii'),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([storyName.length, 0]),
      storyName,
      Buffer.from([
        storyBytes.length & 0xff,
        (storyBytes.length >> 8) & 0xff,
        (storyBytes.length >> 16) & 0xff,
        (storyBytes.length >> 24) & 0xff,
      ]),
      storyBytes,
    ]);
    fs.writeFileSync(path.join(tmpP2Ws, 'script.ypf'), ypfP2);

    const parseYpfEntries = (buf: Buffer): Record<string, Buffer> => {
      assert(buf.subarray(0, 4).toString('ascii') === 'YPF\x00', 'Invalid YPF magic');
      const count = buf.readUInt32LE(4);
      let pos = 8;
      const out: Record<string, Buffer> = {};
      for (let i = 0; i < count; i++) {
        const nlen = buf.readUInt16LE(pos);
        pos += 2;
        const name = buf.subarray(pos, pos + nlen).toString('utf8');
        pos += nlen;
        const size = buf.readUInt32LE(pos);
        pos += 4;
        out[name] = buf.subarray(pos, pos + size);
        pos += size;
      }
      return out;
    };

    const p2UnpackPy = [
      'import sys',
      'from pathlib import Path',
      'archive, dest = Path(sys.argv[1]), Path(sys.argv[2])',
      'blob = archive.read_bytes()',
      'if not blob.startswith(b"YPF\\x00"): raise SystemExit("bad")',
      'count = int.from_bytes(blob[4:8], "little")',
      'pos = 8',
      'dest.mkdir(parents=True, exist_ok=True)',
      'for _ in range(count):',
      '    nlen = int.from_bytes(blob[pos:pos+2], "little"); pos += 2',
      '    name = blob[pos:pos+nlen].decode("utf-8"); pos += nlen',
      '    size = int.from_bytes(blob[pos:pos+4], "little"); pos += 4',
      '    data = blob[pos:pos+size]; pos += size',
      '    (dest / name).write_bytes(data)',
      '',
    ].join('\n');
    const p2RepackPy = [
      'import sys',
      'from pathlib import Path',
      'src, dest = Path(sys.argv[1]), Path(sys.argv[2])',
      'files = [p for p in sorted(src.iterdir()) if p.is_file() and not p.name.startswith(".") and not p.name.endswith(".bak")]',
      'payload = bytearray()',
      'for p in files:',
      '    raw = p.name.encode("utf-8"); data = p.read_bytes()',
      '    payload += len(raw).to_bytes(2, "little") + raw + len(data).to_bytes(4, "little") + data',
      'dest.write_bytes(b"YPF\\x00" + len(files).to_bytes(4, "little") + payload)',
      '',
    ].join('\n');
    const p2ApplyPy = [
      'import json, sys',
      'from pathlib import Path',
      'res_path, root_dir = Path(sys.argv[1]), Path(sys.argv[2])',
      'by_file = {}',
      'for raw in res_path.read_text(encoding="utf-8-sig").splitlines():',
      '    if not raw.strip(): continue',
      '    r = json.loads(raw)',
      '    by_file.setdefault(str(r["file"]), {})[int(r["line"])] = str(r["target"])',
      'for rel, rep in by_file.items():',
      '    f = root_dir / rel',
      '    lines = f.read_text(encoding="utf-8-sig").splitlines(keepends=True)',
      '    for ln, tgt in rep.items():',
      '        eol = "\\n" if lines[ln - 1].endswith("\\n") else ""',
      '        lines[ln - 1] = tgt + eol',
      '    f.write_text("".join(lines), encoding="utf-8", newline="")',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpP2Ws, '.papercup', 'tmp', 'p2ypf', 'unpack.py'), p2UnpackPy, 'utf8');
    fs.writeFileSync(path.join(tmpP2Ws, '.papercup', 'tmp', 'p2ypf', 'repack.py'), p2RepackPy, 'utf8');
    fs.writeFileSync(path.join(tmpP2Ws, '.papercup', 'tmp', 'p2ypf', 'apply.py'), p2ApplyPy, 'utf8');

    const p2Service = new AgentService(tmpP2Ws, { sessionMode: 'memory' });
    try {
      await p2Service.initSession();
      const p2Events: Array<{ type: string; data: any }> = [];
      p2Service.on('agent_event', (ev: any) => p2Events.push(ev));

      const p2MainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const p2MainSession = (p2Service as any).currentSession;
      p2MainSession.agent.state.model = p2MainFaux.getModel();
      p2MainSession.agent.streamFunction = p2MainFaux.streamSimple;
      p2MainSession._modelRuntime.hasConfiguredAuth = () => true;

      const p2SubMgr = (p2Service as any).subagentManager as SubagentManager;
      const origP2CreateSub = p2SubMgr.createSubagentSession.bind(p2SubMgr);
      let xmlRetryInjected = false;
      let story2Attempts = 0;
      const translatorFirstPrompts: string[] = [];

      p2SubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origP2CreateSub(roleName, opts);
        const subFaux = createFauxCore({ tokensPerSecond: 10000 });
        (res.session as any).agent.state.model = subFaux.getModel();
        (res.session as any).agent.streamFunction = subFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;

        if (roleName === 'translator') {
          let turnInSub = 0;
          const translatorRespond = (ctx: any) => {
            turnInSub++;
            const userMsgs = ctx.messages.filter((m: any) => m.role === 'user');
            const latestUser = userMsgs[userMsgs.length - 1];
            const promptText =
              typeof latestUser?.content === 'string'
                ? latestUser.content
                : Array.isArray(latestUser?.content)
                  ? latestUser.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('')
                  : '';
            if (turnInSub === 1) {
              translatorFirstPrompts.push(promptText);
            }

            // First translator call tests <tool_call> auto-retry in fresh session
            if (!xmlRetryInjected) {
              xmlRetryInjected = true;
              return fauxAssistantMessage('<tool_call>write_out</tool_call>');
            }

            const batchMatch = promptText.match(/<batch\b[^>]*>\s*([\s\S]*?)\s*<\/batch>/i);
            const batchBody = batchMatch ? batchMatch[1] : promptText;
            const lines = batchBody
              .split(/\r?\n/)
              .filter((l: string) => l.trim().startsWith('{'))
              .map((l: string) => JSON.parse(l));
            const outJsonl = lines
              .map((row: any) => {
                if (String(row.id) === 'story.txt#1') return JSON.stringify({ id: row.id, target: '前辈，今天天气真好心情也特别愉快！' });
                if (String(row.id) === 'story.txt#2') {
                  story2Attempts += 1;
                  // Deliberately drop [p] on initial batch_001 pass so vn_post_qa_parallel catches it, then restore on force fix
                  return JSON.stringify({
                    id: row.id,
                    target: story2Attempts > 1 ? '那么我们一起去学校中庭边散步边聊吧。[p]' : '那么我们一起去学校中庭边散步边聊吧。',
                  });
                }
                if (String(row.id) === 'story.txt#3') return JSON.stringify({ id: row.id, target: '放学后请来资料室帮忙准备明天的发表。' });
                return JSON.stringify({ id: row.id, target: '明天同一时间我们也在正门前集合吧。' });
              })
              .join('\n');
            return fauxAssistantMessage(outJsonl);
          };
          subFaux.setResponses(Array.from({ length: 10 }, () => translatorRespond));
        } else if (roleName === 'role-checker') {
          subFaux.setResponses([
            () => fauxAssistantMessage('Persona and glossary consistency verified with zero tone mismatches.'),
          ]);
        }
        return res;
      };

      let observedTranslateToolText = '';
      p2MainFaux.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'vn_learn_skill',
              {
                engine: 'p2ypf',
                archive: 'script.ypf',
                unpackScript: '.papercup/tmp/p2ypf/unpack.py',
                repackScript: '.papercup/tmp/p2ypf/repack.py',
                applyScript: '.papercup/tmp/p2ypf/apply.py',
                encoding: 'utf-8',
                suffix: '.ypf',
                magicHex: '59504600',
                classifyProfile: 'plain',
                classifyExtensions: ['.txt'],
                requireWriteback: true,
              },
              { id: 'tc-p2-learn' }
            ),
          ]),
        () => fauxAssistantMessage([fauxToolCall('vn_unpack', { engine: 'p2ypf', dest: '.papercup/tmp/unpacked' }, { id: 'tc-p2-unpack' })]),
        () => fauxAssistantMessage([fauxToolCall('vn_classify', { unpacked: '.papercup/tmp/unpacked', out: '.papercup/data/build', engine: 'p2ypf' }, { id: 'tc-p2-classify' })]),
        () => fauxAssistantMessage([fauxToolCall('vn_checkpoint', { action: 'save', stage: 'baseline', summary: 'classified' }, { id: 'tc-p2-cp1' })]),
        // Inspect analysis first, then save config & split into 4 batches capped at 105 tokens per session
        () => fauxAssistantMessage([fauxToolCall('vn_plan', { model: 'deepseek-chat' }, { id: 'tc-p2-plan-read' })]),
        (ctx) => {
          const planReadRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-plan-read') as any;
          const planJson = JSON.parse((planReadRes.content[0]?.text || '{}'));
          assert(planJson.analysis?.total_rows === 4, `Expected 4 total_rows from vn_plan, got ${JSON.stringify(planJson)}`);
          return fauxAssistantMessage([
            fauxToolCall(
              'vn_plan',
              {
                model: 'deepseek-chat',
                batchMaxLines: 1,
                batchMaxSourceTokens: 100,
                sessionMaxSourceTokens: 105,
                concurrency: 1,
                generateBatches: true,
                note: 'force per-session cap rotation test',
              },
              { id: 'tc-p2-plan-gen' }
            ),
          ]);
        },
        (ctx) => {
          const genRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-plan-gen') as any;
          const genJson = JSON.parse((genRes.content[0]?.text || '{}'));
          assert(genJson.batches?.total_batches === 4, `Expected 4 batches, got ${JSON.stringify(genJson.batches)}`);
          return fauxAssistantMessage([
            fauxToolCall(
              'vn_translate_batches',
              { checkpointInterval: 2, contextSummary: 'Lighthearted schoolyard banter' },
              { id: 'tc-p2-trans' }
            ),
          ]);
        },
        (ctx) => {
          const transRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-trans') as any;
          assert(transRes?.isError !== true, `Expected vn_translate_batches success, got: ${transRes?.content?.[0]?.text}`);
          observedTranslateToolText = (transRes?.content ?? []).map((b: any) => b?.text || '').join('\n');
          const details = transRes.details;
          assert(details.succeeded === 4 && details.failed === 0, `Expected 4 succeeded batches, got ${JSON.stringify(details)}`);
          assert(details.sessionRotations >= 2, `Expected automatic session rotation on cap, got ${details.sessionRotations}`);
          return fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 2, concurrency: 2 }, { id: 'tc-p2-qa-1' })]);
        },
        (ctx) => {
          const qaRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-qa-1') as any;
          const qaJson = qaRes.details;
          assert(qaJson.deterministicFailed === 1, `Expected 1 QA failure on missing [p], got ${JSON.stringify(qaJson)}`);
          assert(
            Array.isArray(qaJson.affectedBatchIds) && qaJson.affectedBatchIds.includes('batch_001'),
            `Expected batch_001 in affectedBatchIds, got ${JSON.stringify(qaJson.affectedBatchIds)}`
          );
          return fauxAssistantMessage([
            fauxToolCall('vn_translate_batches', { batchIds: ['batch_001'], force: true }, { id: 'tc-p2-fix' }),
          ]);
        },
        () => fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 2, concurrency: 2 }, { id: 'tc-p2-qa-2' })]),
        (ctx) => {
          const qaRes2 = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-qa-2') as any;
          assert(qaRes2.details.ok === true && qaRes2.details.deterministicFailed === 0, `Expected QA pass after fix, got ${JSON.stringify(qaRes2.details)}`);
          assert(qaRes2.details.roleCheckerChunksReviewed >= 2, 'Expected parallel role-checker chunk reviews');
          return fauxAssistantMessage([fauxToolCall('vn_checkpoint', { action: 'save', stage: 'qa', qaVerified: true, summary: 'QA passed' }, { id: 'tc-p2-cp2' })]);
        },
        () => fauxAssistantMessage([fauxToolCall('vn_writeback', { dest: tmpP2Export }, { id: 'tc-p2-wb' })]),
        (ctx) => {
          const wbRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-wb') as any;
          assert(wbRes && wbRes.isError !== true, `Expected vn_writeback success, got: ${wbRes?.content?.[0]?.text}`);
          return fauxAssistantMessage([
            fauxToolCall(
              'vn_accept',
              { archive: path.join(tmpP2Export, 'patch_manifest.json'), track: 'scenario', input: '.papercup/data/results/scenario.jsonl' },
              { id: 'tc-p2-accept' }
            ),
          ]);
        },
        (ctx) => {
          const accRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-accept') as any;
          assert(accRes && accRes.isError !== true, `Expected vn_accept success, got: ${accRes?.content?.[0]?.text}`);
          return fauxAssistantMessage([fauxToolCall('vn_release', {}, { id: 'tc-p2-release' })]);
        },
        (ctx) => {
          const relRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-p2-release') as any;
          assert(relRes && relRes.isError !== true, `Expected vn_release success, got: ${relRes?.content?.[0]?.text}`);
          return fauxAssistantMessage('全流程已完成（仅供个人学习）：共翻译 4 段，增量补丁包已导出并验收发布。');
        },
      ]);

      await p2Service.executeTurn('开始全面本地化当前游戏');
      const histAfter = await p2Service.getSessionHistory();
      const turnErrs = histAfter.messages.filter((m) => m.error || (m.tools ?? []).some((t) => t.isError));
      assert(
        !turnErrs.length,
        `Phase 2 faux turn failed earlier: ${JSON.stringify(
          histAfter.messages.map((m) => ({
            role: m.role,
            error: m.error,
            tools: (m.tools ?? []).map((t) => ({ tool: t.tool, isError: t.isError, res: JSON.stringify(t.result || '').slice(0, 1600) })),
          })),
          null,
          2
        )}`
      );

      // Verify original archive untouched & unpack repacked script.ypf to verify ALL 4 translations + restored [p]
      assert(fs.readFileSync(path.join(tmpP2Ws, 'script.ypf')).equals(ypfP2), 'Original script.ypf must remain byte-identical!');
      assert(fs.existsSync(path.join(tmpP2Export, 'patch_manifest.json')), 'Delta patch patch_manifest.json must exist');
      assert(fs.existsSync(path.join(tmpP2Export, 'files', 'script.ypf')), 'Delta patch files/script.ypf must exist');
      assert(!fs.existsSync(path.join(tmpP2Export, 'Game.exe')), 'Delta patch must NOT clone original Game.exe');
      assert(!fs.existsSync(path.join(tmpP2Export, 'build')), 'Delta patch must not leak build/ directory');
      const repackedEntries = parseYpfEntries(fs.readFileSync(path.join(tmpP2Export, 'files', 'script.ypf')));
      const repackedStoryLines = (repackedEntries['story.txt']?.toString('utf8') ?? '').trim().split(/\r?\n/);
      assert(
        repackedStoryLines.length === 4 &&
          repackedStoryLines[0] === '前辈，今天天气真好心情也特别愉快！' &&
          repackedStoryLines[1] === '那么我们一起去学校中庭边散步边聊吧。[p]' &&
          repackedStoryLines[2] === '放学后请来资料室帮忙准备明天的发表。' &&
          repackedStoryLines[3] === '明天同一时间我们也在正门前集合吧。',
        `Repacked script.ypf story.txt missing expected 4 translations or restored [p]: ${JSON.stringify(repackedStoryLines)}`
      );
      assert(fs.existsSync(path.join(tmpP2Ws, '.papercup', 'tmp', 'work', 'out', 'batch_000.jsonl')), 'Batch outputs must be persisted directly on disk');
      assert(fs.existsSync(path.join(tmpP2Ws, '.papercup', 'data', 'vn', 'post_qa_report.json')), 'Post-QA report must exist');
      assert(fs.existsSync(path.join(tmpP2Ws, '.papercup', 'data', 'release', 'README.md')), 'Release notes .papercup/data/release/README.md must exist');
      assert(fs.readFileSync(path.join(tmpP2Ws, '.papercup', 'data', 'release', 'README.md'), 'utf8').includes('仅供个人学习'), 'Release notes must include 仅供个人学习');

      // Verify vn_translate_batches toolResult summary returned to main context does NOT echo raw translated JSONL lines
      assert(
        observedTranslateToolText.length > 0 &&
          !observedTranslateToolText.includes('前辈，今天天气真好心情也特别愉快') &&
          !observedTranslateToolText.includes('那么我们一起去学校中庭边散步边聊吧'),
        `vn_translate_batches toolResult must stay compact and not dump raw translations into main context: ${observedTranslateToolText}`
      );

      // Verify rotated sessions received compact <glossary> + <adjacent_context> instead of unbounded full history
      assert(translatorFirstPrompts.some((p) => p.includes('<adjacent_context>') && p.includes('<glossary>')), 'Rotated sessions must carry glossary + adjacent_context');
      assert(p2Events.some((e) => e.type === 'batch_progress'), 'Expected live batch_progress events');

      // Verify M3 /api/engineering/status exposes plan, batchProgress, checkpoints, and postQa
      const p2Router = createApiRouter(p2Service);
      const p2EngRes = await p2Router.request('/api/engineering/status');
      assert(p2EngRes.status === 200, `Expected 200 from p2 engineering status, got ${p2EngRes.status}`);
      const p2Eng = await p2EngRes.json();
      assert(p2Eng.plan?.modelFamily === 'deepseek' && p2Eng.plan?.sessionMaxSourceTokens === 105, `Expected plan summary, got ${JSON.stringify(p2Eng.plan)}`);
      assert(
        p2Eng.batchProgress?.totalBatches === 4 &&
          p2Eng.batchProgress?.qaPassed === 4 &&
          p2Eng.batchProgress?.savedPendingQa === 0 &&
          p2Eng.batchProgress?.pendingBatches === 0,
        `Expected batchProgress qaPassed=4, got ${JSON.stringify(p2Eng.batchProgress)}`
      );
      assert(
        (p2Eng.checkpoints?.count ?? 0) >= 2 && p2Eng.checkpoints?.latest?.qaVerified === true,
        `Expected verified checkpoint summary, got ${JSON.stringify(p2Eng.checkpoints)}`
      );
      assert(p2Eng.postQa?.ok === true && p2Eng.postQa?.deterministicPassed === 4, `Expected postQa summary, got ${JSON.stringify(p2Eng.postQa)}`);
    } finally {
      (p2Service as any).disposeCurrentSessionState?.(true);
    }
  });

  // 16. 子 Agent 可观测性持久化、活动/进展分离、16KB 大输出转存、3次失败换路与主子中止一致性验证
  console.log('16. Verifying subagent observability persistence, activity/progress separation, 16KB spillover, 3-failure pivot, and abort consistency...');
  await withIsolatedHomeAndEnv('papercup-obs2-test-', async ({ ws: obs2Ws }) => {
    fs.writeFileSync(
      path.join(obs2Ws, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "third"\n\n[vn.research]\nmax_tool_output_chars = 16384\nmax_consecutive_failures = 3\n',
      'utf-8'
    );

    const obs2Service = new AgentService(obs2Ws, { sessionMode: 'persist' });
    const obs2Router = createApiRouter(obs2Service);
    try {
      await obs2Service.initSession();
      const obs2Session = (obs2Service as any).currentSession;
      const obs2MainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const obs2SubFaux = createFauxCore({ tokensPerSecond: 10000 });
      obs2Session.agent.state.model = obs2MainFaux.getModel();
      obs2Session.agent.streamFunction = obs2MainFaux.streamSimple;
      obs2Session._modelRuntime.hasConfiguredAuth = () => true;

      const obs2SubMgr = (obs2Service as any).subagentManager as SubagentManager;
      const origObs2CreateSub = obs2SubMgr.createSubagentSession.bind(obs2SubMgr);
      obs2SubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origObs2CreateSub(roleName, opts);
        (res.session as any).agent.state.model = obs2SubFaux.getModel();
        (res.session as any).agent.streamFunction = obs2SubFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      const bigBashCmd =
        'i=0; echo "HEAD_OK"; while [ $i -lt 450 ]; do echo "line_$i padding_0123456789_0123456789_0123456789"; i=$((i+1)); done; echo "sk-ant-oversized-secret-123456"; echo "TAIL_OK"';

      let midFlightTaskSummary: any = null;
      obs2SubFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('bash', { command: bigBashCmd }, { id: 'tc-obs2-big' })]),
        async (ctx) => {
          const bigRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-obs2-big') as any;
          const bigText = String(bigRes?.content?.[0]?.text || '');
          assert(bigRes?.details?.truncated === true, `Expected >16KB bash output to be truncated, got details=${JSON.stringify(bigRes?.details)}`);
          assert(typeof bigRes?.details?.savedOutputPath === 'string' && bigRes.details.savedOutputPath.includes('.papercup/tmp/diagnostics/tool-outputs/'), `Expected savedOutputPath, got ${JSON.stringify(bigRes?.details)}`);
          assert(bigText.includes('HEAD_OK') && bigText.includes('TAIL_OK'), 'Truncated summary must preserve head and tail markers');
          assert(!bigText.includes('sk-ant-oversized-secret-123456'), 'Secret in oversized output must be redacted in summary');
          const savedLogAbs = path.join(obs2Ws, bigRes.details.savedOutputPath);
          assert(fs.existsSync(savedLogAbs), `Expected saved output log at ${savedLogAbs}`);
          const savedLogText = fs.readFileSync(savedLogAbs, 'utf-8');
          assert(!savedLogText.includes('sk-ant-oversized-secret-123456') && savedLogText.includes('[REDACTED]'), 'Secret in saved tool-output log must be redacted');

          // Verify mid-flight task API already records activity while lastProgressAt stays null (no artifact written yet)
          const listRes = await obs2Router.request('/api/subagents/tasks');
          const listJson = await listRes.json();
          assert(listRes.status === 200 && Array.isArray(listJson.tasks) && listJson.tasks.length === 1, `Expected 1 active subagent task, got ${JSON.stringify(listJson)}`);
          midFlightTaskSummary = listJson.tasks[0];
          assert(
            midFlightTaskSummary.status === 'running' &&
              Boolean(midFlightTaskSummary.lastActivityAt) &&
              midFlightTaskSummary.lastProgressAt === null &&
              midFlightTaskSummary.artifactsCount === 0,
            `Expected activity without false progress before file write, got ${JSON.stringify(midFlightTaskSummary)}`
          );

          return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo "probe fail 1"; exit 1' }, { id: 'tc-obs2-f1' })]);
        },
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'echo "probe fail 2"; exit 1' }, { id: 'tc-obs2-f2' })]),
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'echo "probe fail 3"; exit 1' }, { id: 'tc-obs2-f3' })]),
        (ctx) => {
          const f3Res = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-obs2-f3') as any;
          const f3Text = String(f3Res?.content?.[0]?.text || '');
          assert(f3Text.includes('[换路提醒 / PIVOT REQUIRED]'), `Expected 3rd consecutive failure to inject pivot notice, got: ${f3Text}`);
          return fauxAssistantMessage([
            fauxToolCall(
              'write',
              { path: '.papercup/research/demo/01-layout.md', content: '# Layout\nVerified magic and endianness.\n' },
              { id: 'tc-obs2-write' }
            ),
          ]);
        },
        () => fauxAssistantMessage('已完成阶段性结构分析并写入 .papercup/research/demo/01-layout.md，尚未封装正式 skill。'),
      ]);

      obs2MainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Research demo archive layout' }, { id: 'tc-obs2-main-1' })]),
        () => fauxAssistantMessage('reverser 已完成阶段性落盘。'),
      ]);

      await obs2Service.executeTurn('研究未知封包');

      // Verify task persistence files and REST detail endpoint after completion
      const tasksAfter1 = await (await obs2Router.request('/api/subagents/tasks')).json();
      assert(tasksAfter1.tasks?.length === 1, `Expected 1 completed task, got ${JSON.stringify(tasksAfter1)}`);
      const task1Id = tasksAfter1.tasks[0].taskId;
      const task1File = path.join(obs2Ws, '.papercup', 'tmp', 'diagnostics', 'subagent-tasks', `${task1Id}.json`);
      const eventsFile = path.join(obs2Ws, '.papercup', 'tmp', 'diagnostics', 'subagent-events.jsonl');
      assert(fs.existsSync(task1File), `Expected task snapshot file ${task1File}`);
      assert(fs.existsSync(eventsFile), `Expected subagent events log ${eventsFile}`);

      const detail1Res = await obs2Router.request(`/api/subagents/tasks/${encodeURIComponent(task1Id)}`);
      assert(detail1Res.status === 200, `Expected 200 from detail endpoint, got ${detail1Res.status}`);
      const detail1 = await detail1Res.json();
      assert(
        detail1.status === 'completed' &&
          detail1.activityState === 'completed' &&
          detail1.lastProgressAt !== null &&
          Array.isArray(detail1.artifacts) &&
          detail1.artifacts.includes('.papercup/research/demo/01-layout.md') &&
          Array.isArray(detail1.pivotWarnings) &&
          detail1.pivotWarnings.length >= 1 &&
          Array.isArray(detail1.toolCalls) &&
          detail1.toolCalls.length === 5 &&
          Boolean(detail1.toolCalls[0]?.savedOutputPath),
        `Unexpected completed task detail: ${JSON.stringify(detail1)}`
      );

      // Run a second reverser task and abort the main turn mid-flight to verify task separation & abort consistency
      let notifyObs2InFlight: (() => void) | undefined;
      const obs2InFlight = new Promise<void>((resolve) => {
        notifyObs2InFlight = resolve;
      });
      obs2SubFaux.setResponses([
        (_ctx, opts) =>
          new Promise((resolve) => {
            notifyObs2InFlight?.();
            const t = setTimeout(() => resolve(fauxAssistantMessage('late')), 5000);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
              },
              { once: true }
            );
          }),
      ]);
      obs2MainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Second research attempt' }, { id: 'tc-obs2-main-2' })]),
        () => fauxAssistantMessage('unreachable'),
      ]);

      const turn2Promise = obs2Service.executeTurn('再次研究封包').catch(() => {});
      await obs2InFlight;

      const tasksDuring2 = await (await obs2Router.request('/api/subagents/tasks')).json();
      assert(tasksDuring2.tasks?.length === 2, `Expected 2 separate tasks for same role, got ${JSON.stringify(tasksDuring2)}`);
      const runningTask2 = tasksDuring2.tasks.find((t: any) => t.taskId !== task1Id);
      assert(runningTask2 && runningTask2.status === 'running', `Expected 2nd task running, got ${JSON.stringify(runningTask2)}`);

      const abortedFlag = await obs2Service.abortTurn();
      assert(abortedFlag === true, 'Expected abortTurn() to return true');
      await turn2Promise;

      const detail2 = await (await obs2Router.request(`/api/subagents/tasks/${encodeURIComponent(runningTask2.taskId)}`)).json();
      assert(
        detail2.status === 'aborted' && detail2.activityState === 'aborted' && !obs2Service.isBusy(),
        `Expected aborted task and idle main turn after abortTurn(), got task=${JSON.stringify(detail2)}, busy=${obs2Service.isBusy()}`
      );
    } finally {
      (obs2Service as any).disposeCurrentSessionState?.(true);
    }
  });

  // 17. 并发 initSession 单飞锁与防重复 delta 广播验证（含真实跨工作区 ws1 -> ws2 切换抢占场景）
  console.log('17. Verifying concurrent initSession single-flight deduplication and cross-workspace preemption...');
  await withIsolatedHomeAndEnv('papercup-init-race-', async ({ root: raceRoot }) => {
    // Provide a deterministic offline dummy key so initSession resolves an initial model and exercises model_change deduplication
    process.env.GEMINI_API_KEY = 'AIzaSyTestRaceDummyKey0000000000000';
    const raceWs1 = path.join(raceRoot, 'ws1');
    const raceWs2 = path.join(raceRoot, 'ws2');
    fs.mkdirSync(raceWs1, { recursive: true });
    fs.mkdirSync(raceWs2, { recursive: true });

    const raceService = new AgentService(raceWs1, { sessionMode: 'persist' });
    const raceRouter = createApiRouter(raceService);
    try {
      let sessionReadyCount = 0;
      let streamedThinking = '';
      let streamedText = '';
      raceService.on('agent_event', (evt) => {
        if (evt.type === 'session_ready') sessionReadyCount += 1;
        if (evt.type === 'thinking_delta') streamedThinking += String(evt.data?.delta || '');
        if (evt.type === 'text_delta') streamedText += String(evt.data?.delta || '');
      });

      const [histRes, modelsRes] = await Promise.all([
        raceRouter.request('/api/session/history'),
        raceRouter.request('/api/models'),
        raceService.initSession(),
      ]);
      assert(histRes.status === 200 && modelsRes.status === 200, 'Concurrent startup endpoints must return 200');
      assert(sessionReadyCount === 1, `Expected exactly 1 session_ready on concurrent init, got ${sessionReadyCount}`);

      const raceSession1 = (raceService as any).currentSession;
      assert(
        raceSession1?._eventListeners?.length === 1,
        `Expected exactly 1 session event listener after concurrent init, got ${raceSession1?._eventListeners?.length}`
      );

      const initEntries = (raceService as any).sessionManager?.getEntries?.() ?? [];
      const thinkingInitEntries = initEntries.filter((e: any) => e.type === 'thinking_level_change');
      assert(
        thinkingInitEntries.length === 1,
        `Expected exactly 1 thinking_level_change header entry on concurrent init, got ${thinkingInitEntries.length}`
      );
      const modelInitEntries = initEntries.filter((e: any) => e.type === 'model_change');
      assert(
        modelInitEntries.length === 1,
        `Expected exactly 1 initial model_change header entry on concurrent init, got ${modelInitEntries.length}`
      );

      const raceFaux = createFauxCore({ tokensPerSecond: 10000 });
      raceSession1.agent.state.model = raceFaux.getModel();
      raceSession1.agent.streamFunction = raceFaux.streamSimple;
      raceSession1._modelRuntime.hasConfiguredAuth = () => true;

      const expectedThinking = 'Engine archive detected. Inspect structure cleanly.';
      const expectedText = '我将开始对这个游戏进行本地化流程，首先检查工作区状态并检测游戏引擎。';
      raceFaux.setResponses([
        () => fauxAssistantMessage([fauxThinking(expectedThinking), fauxText(expectedText)]),
      ]);

      await raceService.executeTurn('测试并发初始化流式输出');
      assert(
        streamedThinking === expectedThinking,
        `Expected non-duplicated thinking_delta stream (${expectedThinking.length} chars), got ${streamedThinking.length} chars: ${streamedThinking}`
      );
      assert(
        streamedText === expectedText,
        `Expected non-duplicated text_delta stream (${expectedText.length} chars), got ${streamedText.length} chars: ${streamedText}`
      );

      const sessionFile1 = (raceService as any).sessionManager?.getSessionFile?.();
      assert(sessionFile1 && fs.existsSync(sessionFile1), 'Expected persisted session file after executeTurn');
      const persistedEntries = fs
        .readFileSync(sessionFile1, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const persistedAssistant = persistedEntries.filter((e) => e.type === 'message' && e.message?.role === 'assistant');
      assert(
        persistedAssistant.length === 1,
        `Expected 1 persisted assistant message on disk, got ${persistedAssistant.length}`
      );

      // Genuine cross-workspace mid-flight preemption: raceWs1 init in flight -> switch to raceWs2!
      (raceService as any).disposeCurrentSessionState?.(true);
      raceService.setWorkspace(raceWs1);
      const inFlightInitWs1 = raceService.initSession();
      await Promise.resolve();
      raceService.setWorkspace(raceWs2);
      const [, histAfterSwitchRes] = await Promise.all([
        inFlightInitWs1,
        raceRouter.request('/api/session/history'),
        raceRouter.request('/api/models'),
      ]);
      const histAfterSwitch = await histAfterSwitchRes.json();
      const raceSession2 = (raceService as any).currentSession;
      assert(
        raceSession2 && raceSession2._eventListeners?.length === 1,
        `Expected exactly 1 listener after ws1->ws2 mid-flight preemption & concurrent re-init, got ${raceSession2?._eventListeners?.length}`
      );
      assert(
        path.resolve(raceService.getWorkspace()) === path.resolve(raceWs2) &&
          path.resolve(histAfterSwitch.workspace) === path.resolve(raceWs2) &&
          Array.isArray(histAfterSwitch.messages) &&
          histAfterSwitch.messages.length === 0,
        `Expected active workspace and clean history for ws2 (${raceWs2}), got ws=${raceService.getWorkspace()}, hist=${JSON.stringify(histAfterSwitch)}`
      );
    } finally {
      (raceService as any).disposeCurrentSessionState?.(true);
    }
  }, { offline: true });

  // 18. 持久化工作区重启恢复、/api/workspaces 与 /api/session/history 一致性及无效目录清理验证
  console.log('18. Verifying persisted active workspace restore & /api/workspaces consistency...');
  await withIsolatedHomeAndEnv('papercup-ws-restore-', async ({ root: wsTestRoot, home: wsHome }) => {
    const wsA = path.join(wsTestRoot, 'wsA');
    const wsB = path.join(wsTestRoot, 'ゲーム_日本語_wsB');
    const wsDead = path.join(wsTestRoot, 'deleted_ws');
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    let wsSvc1: AgentService | null = null;
    let wsSvc2: AgentService | null = null;
    let memSvc: AgentService | null = null;
    try {
      // 1) Initial service on wsA -> switch to wsB -> run a turn so wsB has a persisted session
      wsSvc1 = new AgentService(wsA, { sessionMode: 'persist' });
      const wsRouter1 = createApiRouter(wsSvc1);
      const selRes = await wsRouter1.request('/api/workspaces/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: wsB }),
      });
      assert(selRes.status === 200, 'Expected POST /api/workspaces/select to succeed');
      const selJson = await selRes.json();
      assert(path.resolve(selJson.active) === path.resolve(wsB), `Expected active=${wsB}, got ${selJson.active}`);

      await wsSvc1.initSession();
      const wsSess1 = (wsSvc1 as any).currentSession;
      const wsFaux = createFauxCore({ tokensPerSecond: 10000 });
      wsSess1.agent.state.model = wsFaux.getModel();
      wsSess1.agent.streamFunction = wsFaux.streamSimple;
      wsSess1._modelRuntime.hasConfiguredAuth = () => true;
      wsFaux.setResponses([() => fauxAssistantMessage([fauxText('已保存该游戏工作区的翻译进度。')])]);
      await wsSvc1.executeTurn('继续昨天的游戏翻译');
      (wsSvc1 as any).disposeCurrentSessionState?.(true);
      wsSvc1 = null;

      // 2) Inject a nonexistent dead active path into workspaces.json to simulate stale test/deleted folder recovery
      const regFile = path.join(wsHome, '.papercup', 'workspaces.json');
      const savedReg = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
      fs.writeFileSync(
        regFile,
        JSON.stringify({ active: wsDead, recent: [wsDead, ...savedReg.recent] }, null, 2),
        'utf-8'
      );

      // 3) Restart with AgentService() (no initialWorkspace, matching src/index.ts): must restore wsB & its session
      wsSvc2 = new AgentService(undefined, { sessionMode: 'persist' });
      const wsRouter2 = createApiRouter(wsSvc2);
      const [wsListRes, histRes2, engRes2] = await Promise.all([
        wsRouter2.request('/api/workspaces'),
        wsRouter2.request('/api/session/history'),
        wsRouter2.request('/api/engineering/status'),
      ]);
      assert(wsListRes.status === 200 && histRes2.status === 200 && engRes2.status === 200, 'Expected 200 after restart');
      const wsListJson = await wsListRes.json();
      const histJson2 = await histRes2.json();
      const engJson2 = await engRes2.json();

      assert(path.resolve(wsListJson.active) === path.resolve(wsB), `Expected restored active=${wsB}, got ${wsListJson.active}`);
      assert(path.resolve(histJson2.workspace) === path.resolve(wsB), `Expected history.workspace=${wsB}, got ${histJson2.workspace}`);
      assert(path.resolve(engJson2.workspace) === path.resolve(wsB), `Expected engineering.workspace=${wsB}, got ${engJson2.workspace}`);
      assert(!wsListJson.recent.some((p: string) => path.resolve(p) === path.resolve(wsDead)), 'Expected deleted workspace path to be pruned');
      assert(
        Array.isArray(histJson2.sessions) && histJson2.sessions.length === 1 && histJson2.messages.length >= 2,
        `Expected restored persisted session on wsB, got sessions=${histJson2.sessions?.length}, msgs=${histJson2.messages?.length}`
      );

      // 4) Memory-mode AgentService with explicit initialWorkspace must align /api/workspaces & /api/session/history without mutating workspaces.json
      memSvc = new AgentService(wsA, { sessionMode: 'memory' });
      const memRouter = createApiRouter(memSvc);
      const memWsJson = await (await memRouter.request('/api/workspaces')).json();
      const memHistJson = await (await memRouter.request('/api/session/history')).json();
      assert(path.resolve(memWsJson.active) === path.resolve(wsA), `Expected memory active=${wsA}, got ${memWsJson.active}`);
      assert(path.resolve(memHistJson.workspace) === path.resolve(wsA), `Expected memory history.workspace=${wsA}, got ${memHistJson.workspace}`);
      const regAfterMem = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
      assert(path.resolve(regAfterMem.active) === path.resolve(wsB), `Memory service must not overwrite workspaces.json active (${regAfterMem.active})`);
    } finally {
      (wsSvc1 as any)?.disposeCurrentSessionState?.(true);
      (wsSvc2 as any)?.disposeCurrentSessionState?.(true);
      (memSvc as any)?.disposeCurrentSessionState?.(true);
    }
  });

  // 19. 引擎级系统文本（PE+ZIP 解包后技能增强 + KAG / Ren'Py 内置分类）全管线分类、翻译、安全写回与重封包验证
  console.log('\n19. Verifying engine-level post-unpack skill enhancement, KAG/RenPy classification, and PE+ZIP repack pipeline...');
  const buildTestPeZip = (files: Array<[string, Buffer]>): Buffer => {
    const peStub = Buffer.alloc(64, 0);
    peStub.write('MZ', 0, 'ascii');
    const lfhChunks: Buffer[] = [];
    const cdChunks: Buffer[] = [];
    let localOffset = 0;

    for (const [name, data] of files) {
      const compressed = zlib.deflateRawSync(data);
      const crc = zlib.crc32(data) >>> 0;
      const nameBuf = Buffer.from(name, 'utf8');
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(0x800, 6);
      lfh.writeUInt16LE(8, 8);
      lfh.writeUInt16LE(0, 10);
      lfh.writeUInt16LE(0x0021, 12);
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(compressed.length, 18);
      lfh.writeUInt32LE(data.length, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28);
      lfhChunks.push(lfh, nameBuf, compressed);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE((3 << 8) | 20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x800, 8);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0x0021, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compressed.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(localOffset, 42);
      cdChunks.push(cd, nameBuf);

      localOffset += lfh.length + nameBuf.length + compressed.length;
    }

    const cdBuf = Buffer.concat(cdChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(localOffset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([peStub, ...lfhChunks, cdBuf, eocd]);
  };

  await withIsolatedHomeAndEnv('papercup-sys-text-', async ({ root: sysRoot, home: sysHome }) => {
    const sysWs = path.join(sysRoot, 'pezip_game');
    const sysExport = path.join(sysRoot, 'pezip_game.patch');
    const sysVerifyDir = path.join(sysRoot, 'verify_repacked');
    fs.mkdirSync(sysWs, { recursive: true });

    const peZipService = new AgentService(sysWs, { sessionMode: 'memory' });
    try {
      fs.writeFileSync(
        path.join(sysWs, 'papercup.toml'),
        ['[vn.localization]', 'narrative_pov = "first"', 'source_lang = "ja"', 'target_lang = "zh"', ''].join('\n'),
        'utf8'
      );

      // Minimal PE+ZIP bundle with builtin KAG scenario + companion JSON system strings + raster UI asset
      const peZipExe = buildTestPeZip([
        ['tyrano/tyrano.js', Buffer.from('var ENGINE = {};\n', 'utf8')],
        [
          'data/system/ui_strings.json',
          Buffer.from(
            JSON.stringify({ go_title: 'タイトルに戻りますか？', err_msg: 'エラーが発生しました' }, null, 2) + '\n',
            'utf8'
          ),
        ],
        ['data/ui/menu_button_save.gif', Buffer.from('GIF89a', 'ascii')],
        [
          'data/scenario/title_screen.ks',
          Buffer.from(
            [
              '*start',
              '[ptext layer="0" text="タイトルメニュー" name="chara_box"]',
              '[glink text="はい" target="*はい"]',
              '#主人公',
              'おはようございます！[p]',
              '',
            ].join('\n'),
            'utf8'
          ),
        ],
      ]);
      const exePath = path.join(sysWs, 'SamplePeZip.exe');
      fs.writeFileSync(exePath, peZipExe);

      await peZipService.initSession();
      const tSess = (peZipService as any).currentSession;
      const tFaux = createFauxCore({ tokensPerSecond: 10000 });
      tSess.agent.state.model = tFaux.getModel();
      tSess.agent.streamFunction = tFaux.streamSimple;
      tSess._modelRuntime.hasConfiguredAuth = () => true;

      const peZipSubMgr = (peZipService as any).subagentManager as SubagentManager;
      const origPeZipCreate = peZipSubMgr.createSubagentSession.bind(peZipSubMgr);
      peZipSubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origPeZipCreate(roleName, opts);
        const subFaux = createFauxCore({ tokensPerSecond: 10000 });
        (res.session as any).agent.state.model = subFaux.getModel();
        (res.session as any).agent.streamFunction = subFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        if (roleName === 'reverser') {
          const researchDir = path.join(sysWs, '.papercup', 'research', 'tyrano');
          const tmpSkillDir = path.join(sysWs, '.papercup', 'tmp', 'tyrano');
          fs.mkdirSync(researchDir, { recursive: true });
          fs.mkdirSync(tmpSkillDir, { recursive: true });
          fs.writeFileSync(
            path.join(researchDir, '03-text-mapping.json'),
            JSON.stringify(
              {
                engine: 'tyrano',
                scenario_scripts: ['data/scenario/*.ks'],
                system_text: ['data/system/ui_strings.json'],
                raster_ui: ['data/ui/menu_button_save.gif'],
              },
              null,
              2
            ),
            'utf8'
          );

          // Minimal generic extract.py / apply.py exercising the server's post-unpack skill integration
          const genericExtractPy = [
            'import json, sys',
            'from pathlib import Path',
            'root, out_path = Path(sys.argv[1]), Path(sys.argv[2])',
            'ui_f = root / "data" / "system" / "ui_strings.json"',
            'rows = []',
            'if ui_f.is_file():',
            '    obj = json.loads(ui_f.read_text(encoding="utf-8-sig"))',
            '    for idx, (k, v) in enumerate(obj.items(), 1):',
            '        rows.append({"id": f"ui_strings:{k}", "file": "data/system/ui_strings.json", "line": idx, "kind": "system", "source": v})',
            'out_path.write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", encoding="utf-8")',
            '',
          ].join('\n');

          const genericApplyPy = [
            'import json, sys',
            'from pathlib import Path',
            'res_path, root = Path(sys.argv[1]), Path(sys.argv[2])',
            'rows = [json.loads(l) for l in res_path.read_text(encoding="utf-8-sig").splitlines() if l.strip()]',
            'ui_f = root / "data" / "system" / "ui_strings.json"',
            'ui_obj = json.loads(ui_f.read_text(encoding="utf-8-sig")) if ui_f.is_file() else {}',
            'ui_changed = False',
            'ks_by_file = {}',
            'for r in rows:',
            '    if r["file"] == "data/system/ui_strings.json":',
            '        key = r["id"].split(":", 1)[1]',
            '        ui_obj[key] = r["target"]',
            '        ui_changed = True',
            '    else:',
            '        ks_by_file.setdefault(r["file"], []).append(r)',
            'if ui_changed:',
            '    ui_f.write_text(json.dumps(ui_obj, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8", newline="\\n")',
            'for rel, items in ks_by_file.items():',
            '    f = root / rel',
            '    lines = f.read_text(encoding="utf-8-sig").splitlines(keepends=True)',
            '    for it in items:',
            '        ln = int(it["line"]) - 1',
            '        src, tgt = it["source"], it["target"]',
            '        if "target=" in lines[ln] and "text=" in lines[ln]:',
            '            lines[ln] = lines[ln].replace(f\'text="{src}"\', f\'text="{tgt}"\', 1)',
            '        else:',
            '            lines[ln] = lines[ln].replace(src, tgt, 1)',
            '    f.write_text("".join(lines), encoding="utf-8", newline="")',
            '',
          ].join('\n');

          fs.writeFileSync(path.join(tmpSkillDir, 'extract.py'), genericExtractPy, 'utf8');
          fs.writeFileSync(path.join(tmpSkillDir, 'apply.py'), genericApplyPy, 'utf8');

          subFaux.setResponses([
            (ctx) => {
              const sysMsg = ctx.messages.find((m: any) => m.role === 'system') as any;
              const revPrompt = sysMsg ? getSystemMessageText(sysMsg) : String((res.session as any).agent.state.systemPrompt || '');
              // Generic reverser contract assertions (no single-game file literals)
              assert(
                revPrompt.includes('extract.py') &&
                  revPrompt.includes('03-text-mapping.json') &&
                  revPrompt.includes('raster') &&
                  revPrompt.includes('unpackedDir') &&
                  revPrompt.includes('system/UI'),
                `reverser prompt must instruct generic system/UI audit & post-unpack skill packaging, got: ${revPrompt.slice(0, 400)}`
              );
              return fauxAssistantMessage([
                fauxToolCall(
                  'vn_learn_skill',
                  {
                    engine: 'tyrano',
                    unpackedDir: '.papercup/tmp/unpacked',
                    extractScript: '.papercup/tmp/tyrano/extract.py',
                    applyScript: '.papercup/tmp/tyrano/apply.py',
                    classifyProfile: 'kag',
                    classifyExtensions: ['.ks'],
                    classifyTags: { ptext: 'system', title: 'system' },
                    systemTextFiles: ['data/system/ui_strings.json'],
                    rasterUiAssets: ['data/ui/menu_button_save.gif'],
                    encoding: 'utf-8',
                    note: 'Generic PE+ZIP post-unpack companion system string table.',
                    requireWriteback: true,
                  },
                  { id: 'tc-rev-tyr-learn' }
                ),
              ]);
            },
            (ctx) => {
              const learnRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-rev-tyr-learn') as any;
              assert(learnRes && learnRes.isError !== true, `reverser vn_learn_skill failed: ${learnRes?.content?.[0]?.text}`);
              return fauxAssistantMessage('已完成 unpacked/ 结构审计并产出已验证的 post-unpack 技能。');
            },
          ]);
        } else if (roleName === 'translator') {
          const transMap: Record<string, string> = {
            '#主人公': '#主角',
            'おはようございます！[p]': '早上好！[p]',
            'タイトルメニュー': '标题菜单',
            'はい': '是',
            'タイトルに戻りますか？': '要返回标题画面吗？',
            'エラーが発生しました': '发生错误',
          };
          const respondFn = (ctx: any) => {
            const lastUser = [...ctx.messages].reverse().find((m: any) => m.role === 'user');
            const promptText =
              typeof lastUser?.content === 'string'
                ? lastUser.content
                : Array.isArray(lastUser?.content)
                  ? lastUser.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
                  : '';
            if (promptText.includes('<character_roster>') && promptText.includes('主人公 => 主角')) {
              tyranoTranslatorSawRoster = true;
            }
            const batchMatch = promptText.match(/<batch\b[^>]*>\s*([\s\S]*?)\s*<\/batch>/i);
            const batchBody = batchMatch ? batchMatch[1] : promptText;
            const rows = batchBody
              .split(/\r?\n/)
              .filter((l: string) => l.trim().startsWith('{'))
              .map((l: string) => JSON.parse(l));
            const out = rows
              .map((row: any) => JSON.stringify({ id: row.id, target: transMap[String(row.source)] ?? String(row.source) }))
              .join('\n');
            return fauxAssistantMessage(out);
          };
          subFaux.setResponses(Array.from({ length: 10 }, () => respondFn));
        } else if (roleName === 'role-checker') {
          subFaux.setResponses(
            Array.from({ length: 6 }, () => () => fauxAssistantMessage('Terminology and system UI labels look clean.'))
          );
        }
        return res;
      };
      let tyranoTranslatorSawRoster = false;
      let tyranoPendingFormId = '';

      tFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_detect', {}, { id: 'tc-tyr-detect' })]),
        (ctx) => {
          const detRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-detect') as any;
          assert(detRes?.isError !== true && detRes.content[0].text.includes('tyrano'), `Expected tyrano detect, got ${detRes?.content?.[0]?.text}`);
          return fauxAssistantMessage([fauxToolCall('vn_unpack', { dest: '.papercup/tmp/unpacked' }, { id: 'tc-tyr-unpack' })]);
        },
        (ctx) => {
          const unpRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-unpack') as any;
          assert(unpRes?.isError !== true, `Expected vn_unpack success, got ${unpRes?.content?.[0]?.text}`);
          const peManifest = JSON.parse(fs.readFileSync(path.join(sysWs, '.papercup', 'tmp', 'unpacked', '.pe-zip-manifest.json'), 'utf8'));
          assert(peManifest.engine === 'tyrano', `Expected manifest engine=tyrano, got ${peManifest.engine}`);
          return fauxAssistantMessage([
            fauxToolCall(
              'delegate_task',
              {
                role: 'reverser',
                task: '审计已解包到 .papercup/tmp/unpacked/ 的引擎结构与系统文本，通过 vn_learn_skill(unpackedDir=".papercup/tmp/unpacked") 生成技能与指引。',
              },
              { id: 'tc-tyr-rev' }
            ),
          ]);
        },
        (ctx) => {
          const revRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-rev') as any;
          assert(revRes?.isError !== true, `Expected reverser post-unpack analysis success, got ${revRes?.content?.[0]?.text}`);
          return fauxAssistantMessage([fauxToolCall('vn_detect', {}, { id: 'tc-tyr-detect-after' })]);
        },
        (ctx) => {
          const detAfter = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-detect-after') as any;
          const detAfterText = String(detAfter?.content?.[0]?.text || '');
          assert(
            detAfterText.includes('ready') && detAfterText.includes('skill:tyrano'),
            `Expected vn_detect to show builtin + ready analysis skill, got ${detAfterText}`
          );
          return fauxAssistantMessage([fauxToolCall('vn_classify', { unpacked: '.papercup/tmp/unpacked', out: '.papercup/data/build' }, { id: 'tc-tyr-classify' })]);
        },
        (ctx) => {
          const clsRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-classify') as any;
          assert(clsRes?.isError !== true, `Expected vn_classify success, got ${clsRes?.content?.[0]?.text}`);
          const manifest = JSON.parse(fs.readFileSync(path.join(sysWs, '.papercup', 'data', 'vn', 'text.json'), 'utf8'));
          assert(manifest.engine === 'tyrano' && manifest.profile === 'kag', `Expected engine=tyrano profile=kag, got ${JSON.stringify(manifest)}`);
          assert(
            Array.isArray(manifest.warnings) && manifest.warnings.some((w: string) => w.includes('menu_button_save.gif')),
            `Expected non-blocking raster UI warning from engine.json system_text.raster_ui, got ${JSON.stringify(manifest.warnings)}`
          );
          const scenRows = fs
            .readFileSync(path.join(sysWs, '.papercup', 'data', 'build', 'scenario.jsonl'), 'utf8')
            .trim()
            .split(/\r?\n/)
            .map((l) => JSON.parse(l));
          const uiRows = fs
            .readFileSync(path.join(sysWs, '.papercup', 'data', 'build', 'ui.jsonl'), 'utf8')
            .trim()
            .split(/\r?\n/)
            .map((l) => JSON.parse(l));
          assert(
            scenRows.length === 2 &&
              scenRows[0].source === '#主人公' &&
              scenRows[1].source === 'おはようございます！[p]',
            `Unexpected scenario rows: ${JSON.stringify(scenRows)}`
          );
          const uiSources = uiRows.map((r: any) => String(r.source));
          for (const expectedSrc of ['タイトルに戻りますか？', 'エラーが発生しました', 'タイトルメニュー', 'はい']) {
            assert(uiSources.includes(expectedSrc), `Missing merged UI text "${expectedSrc}" in ${JSON.stringify(uiSources)}`);
          }
          return fauxAssistantMessage([fauxToolCall('vn_extract_roster', {}, { id: 'tc-tyr-roster' })]);
        },
        (ctx) => {
          const rosterRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-roster') as any;
          assert(rosterRes?.isError !== true, `Expected vn_extract_roster success, got ${rosterRes?.content?.[0]?.text}`);
          const extracted = JSON.parse(String(rosterRes?.content?.[0]?.text || '{}'));
          assert(
            extracted.status === 'unconfirmed' &&
              extracted.totalCharacters === 1 &&
              extracted.characters?.[0]?.sourceName === '主人公',
            `Expected Tyrano #主人公 extracted in Step 19, got ${JSON.stringify(extracted)}`
          );
          return fauxAssistantMessage([
            fauxToolCall(
              'vn_request_character_confirmation',
              {
                characters: [{ sourceName: '主人公', defaultTarget: '主角', gender: 'male' }],
              },
              { id: 'tc-tyr-confirm-form' }
            ),
          ]);
        },
        (ctx) => {
          const formRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-confirm-form') as any;
          assert(
            formRes?.isError !== true && typeof formRes?.details?.chatFormId === 'string',
            `Expected vn_request_character_confirmation formId, got ${JSON.stringify(formRes)}`
          );
          tyranoPendingFormId = formRes.details.chatFormId;
          return fauxAssistantMessage('请核对并提交角色译名确认表。');
        },
      ]);

      await peZipService.executeTurn('测试 PE+ZIP 解包后技能全管线（阶段1：解包分类并发送角色译名表单）');
      assert(tyranoPendingFormId.length > 0, 'Expected pending character form ID after Turn 1');
      const formsBeforeSubmit = peZipService.getChatFormsState();
      assert(
        formsBeforeSubmit.forms.some((f) => f.formId === tyranoPendingFormId && f.status === 'pending') &&
          formsBeforeSubmit.roster?.status === 'draft',
        `Expected pending form + draft roster before submission: ${JSON.stringify(formsBeforeSubmit)}`
      );

      const tyrSubmitRes = await peZipService.submitCharacterForm(tyranoPendingFormId, {
        items: [{ sourceName: '主人公', targetName: '主角', gender: 'male' }],
        autoContinue: false,
      });
      assert(
        tyrSubmitRes.form.status === 'submitted' && tyrSubmitRes.roster.status === 'locked',
        `Expected locked roster after form submission: ${JSON.stringify(tyrSubmitRes)}`
      );

      tFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_plan', { model: 'deepseek-chat', generateBatches: true }, { id: 'tc-tyr-plan' })]),
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { concurrency: 1, checkpointInterval: 0 }, { id: 'tc-tyr-trans' })]),
        () => fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 20, concurrency: 1 }, { id: 'tc-tyr-qa' })]),
        (ctx) => {
          const qaRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-qa') as any;
          assert(qaRes?.details?.ok === true && qaRes?.details?.deterministicFailed === 0, `Expected QA ok, got ${JSON.stringify(qaRes?.details)}`);
          return fauxAssistantMessage([fauxToolCall('vn_writeback', { dest: sysExport }, { id: 'tc-tyr-wb' })]);
        },
        (ctx) => {
          const wbRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-wb') as any;
          assert(wbRes?.isError !== true, `Expected vn_writeback success, got ${wbRes?.content?.[0]?.text}`);
          return fauxAssistantMessage([
            fauxToolCall('vn_accept', { archive: path.join(sysExport, 'patch_manifest.json'), track: 'scenario', input: '.papercup/data/results/scenario.jsonl' }, { id: 'tc-tyr-acc-scn' }),
            fauxToolCall('vn_accept', { archive: path.join(sysExport, 'patch_manifest.json'), track: 'ui', input: '.papercup/data/results/ui.jsonl' }, { id: 'tc-tyr-acc-ui' }),
          ]);
        },
        () => fauxAssistantMessage([fauxToolCall('vn_release', {}, { id: 'tc-tyr-rel' })]),
        () => fauxAssistantMessage([fauxToolCall('vn_promote_skill', { skill: 'engine-tyrano' }, { id: 'tc-tyr-promote' })]),
        () => fauxAssistantMessage('PE+ZIP 系统文本与剧情本地化完成（仅供个人学习）。'),
      ]);

      await peZipService.executeTurn('角色译名已锁定，继续规划、翻译、QA、写回与发布。');
      assert(tyranoTranslatorSawRoster, 'Expected Step 19 translator to receive locked <character_roster> containing 主人公 => 主角');
      const tHist = await peZipService.getSessionHistory();
      const tErrs = tHist.messages.filter((m) => m.error || (m.tools ?? []).some((t) => t.isError));
      assert(!tErrs.length, `PE+ZIP skill pipeline had errors: ${JSON.stringify(tErrs)}`);
      assert(fs.readFileSync(exePath).equals(peZipExe), 'Original SamplePeZip.exe must remain untouched');

      const skillMdPath = path.join(sysWs, '.papercup', 'skills', 'engine-tyrano', 'SKILL.md');
      const skillMdText = fs.readFileSync(skillMdPath, 'utf8');
      assert(
        skillMdText.includes('data/system/ui_strings.json') && skillMdText.includes('menu_button_save.gif'),
        `Generated SKILL.md missing expected system-text & raster-UI instructions: ${skillMdText}`
      );
      assert(
        fs.existsSync(path.join(sysHome, '.papercup', 'skills', 'engine-tyrano', 'extract.py')) &&
          fs.existsSync(path.join(sysHome, '.papercup', 'skills', 'engine-tyrano', 'apply.py')) &&
          fs.existsSync(path.join(sysHome, '.papercup', 'skills', 'engine-tyrano', 'engine.json')),
        'Expected vn_promote_skill to copy SKILL.md, extract.py, apply.py, and self-contained engine.json globally'
      );

      unpackPeZip(path.join(sysExport, 'files', 'SamplePeZip.exe'), sysVerifyDir);
      const outUiJson = JSON.parse(fs.readFileSync(path.join(sysVerifyDir, 'data', 'system', 'ui_strings.json'), 'utf8'));
      assert(
        outUiJson.go_title === '要返回标题画面吗？' && outUiJson.err_msg === '发生错误',
        `Expected companion UI JSON writeback in repacked PE+ZIP: ${JSON.stringify(outUiJson)}`
      );
      const outTitleKs = fs.readFileSync(path.join(sysVerifyDir, 'data', 'scenario', 'title_screen.ks'), 'utf8');
      assert(outTitleKs.includes('[ptext layer="0" text="标题菜单" name="chara_box"]'), `Expected ptext text writeback only: ${outTitleKs}`);
      assert(outTitleKs.includes('[glink text="是" target="*はい"]'), `Expected glink target="*はい" preserved: ${outTitleKs}`);
      assert(outTitleKs.includes('#主角') && outTitleKs.includes('早上好！[p]'), `Expected scenario writeback: ${outTitleKs}`);

      // Lightweight generic KAG / Ren'Py tag classification & writeback checks
      const kkWs = path.join(sysRoot, 'kk_ws');
      const kkUnpacked = path.join(kkWs, 'unpacked');
      fs.mkdirSync(path.join(kkUnpacked, 'scenario'), { recursive: true });
      fs.writeFileSync(
        path.join(kkWs, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh"\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(kkUnpacked, 'scenario', 'first.ks'),
        '[title name="第一章"]\n[ptext layer="0" text="字幕" name="speaker_id"]\n[ptext text="%text"]\n',
        'utf8'
      );
      const kkCls = classifyUnpacked(kkUnpacked, { engine: 'kirikiri' });
      assert(
        kkCls.ui.length === 2 && kkCls.ui[0].source === '第一章' && kkCls.ui[1].source === '字幕',
        `Expected only [title] and [ptext text=...] in Kirikiri UI (skipping name="speaker_id" and %text), got ${JSON.stringify(kkCls.ui)}`
      );
      const kkProf = loadProfile(kkWs).profile;
      assert(kkProf !== null, 'Expected Kirikiri profile loaded');
      applyResults(
        kkWs,
        'unpacked',
        kkCls.ui.map((r) => ({
          ...r,
          ok: true,
          track: 'ui',
          target: r.source === '第一章' ? '开篇第一章' : '字幕文本',
        })),
        kkProf!,
        { glossary: {}, persona: {}, lessons: [], personaErrors: [] },
        'ui'
      );
      const kkKsAfter = fs.readFileSync(path.join(kkUnpacked, 'scenario', 'first.ks'), 'utf8');
      assert(
        kkKsAfter.includes('[title name="开篇第一章"]') && kkKsAfter.includes('text="字幕文本" name="speaker_id"'),
        `Expected Kirikiri ks writeback: ${kkKsAfter}`
      );

      const rpWs = path.join(sysRoot, 'rp_ws');
      const rpUnpacked = path.join(rpWs, 'unpacked');
      fs.mkdirSync(path.join(rpUnpacked, 'game'), { recursive: true });
      fs.writeFileSync(
        path.join(rpWs, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh"\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(rpUnpacked, 'game', 'screens.rpy'),
        [
          'screen prefs():',
          '    label _("Music Volume")',
          '    tooltip _("Quit now")',
          '    alt _("Main Logo")',
          '    title _("Exit")',
          'label start:',
          '    e "Hello."',
          '',
        ].join('\n'),
        'utf8'
      );
      const rpCls = classifyUnpacked(rpUnpacked, { engine: 'renpy' });
      assert(
        rpCls.scenario.length === 1 && rpCls.scenario[0].source === 'Hello.',
        `Expected only dialogue in RenPy scenario, got ${JSON.stringify(rpCls.scenario)}`
      );
      const rpUiSources = rpCls.ui.map((r) => r.source);
      for (const s of ['Music Volume', 'Quit now', 'Main Logo', 'Exit']) {
        assert(rpUiSources.includes(s), `Missing expected RenPy UI text "${s}" in ${JSON.stringify(rpUiSources)}`);
      }
    } finally {
      (peZipService as any).disposeCurrentSessionState?.(true);
    }
  });

  // 20. 子 Agent 额度熔断、错误分类精度、QA 断点续检（含 narrative_pov locHash 失效）与中断恢复上下文验证
  console.log('\n20. Verifying subagent error classification, quota circuit-breaker, post-QA checkpoint resume/locHash invalidation, and interruption recovery...');
  // Unit assertions on classifySubagentError boundaries (retryable 429 vs HTTP 401/403 vs bare "pos 401" vs Chinese quota)
  {
    const rate429 = classifySubagentError('HTTP 429 Too Many Requests: rate limit exceeded');
    assert(rate429.kind === 'rate_limited' && rate429.fatalForPool === false, `Retryable 429 must not trip pool: ${JSON.stringify(rate429)}`);
    const auth401 = classifySubagentError('HTTP 401 Unauthorized: invalid api key');
    assert(auth401.kind === 'auth_error' && auth401.fatalForPool === true, `HTTP 401 must trip pool as auth_error: ${JSON.stringify(auth401)}`);
    const auth403 = classifySubagentError('status: 403 Forbidden');
    assert(auth403.kind === 'auth_error' && auth403.fatalForPool === true, `HTTP 403 must trip pool as auth_error: ${JSON.stringify(auth403)}`);
    const bare401 = classifySubagentError('SyntaxError: JSON parse error at pos 401');
    assert(bare401.kind === 'error' && bare401.fatalForPool === false, `Bare number 401 must NOT be misclassified as auth_error: ${JSON.stringify(bare401)}`);
    const zhQuota = classifySubagentError('请求失败：当前账户余额不足，请充值');
    assert(zhQuota.kind === 'quota_exhausted' && zhQuota.fatalForPool === true, `Chinese 余额不足 must classify as quota_exhausted: ${JSON.stringify(zhQuota)}`);
    const resExhausted = classifySubagentError('RESOURCE_EXHAUSTED: quota exceeded');
    assert(resExhausted.kind === 'quota_exhausted' && resExhausted.fatalForPool === true, `RESOURCE_EXHAUSTED must classify as quota_exhausted: ${JSON.stringify(resExhausted)}`);
  }

  await withIsolatedHomeAndEnv('papercup-qa-int-', async ({ ws: qaIntWs }) => {
    fs.mkdirSync(path.join(qaIntWs, '.papercup', 'data', 'build'), { recursive: true });
    fs.mkdirSync(path.join(qaIntWs, '.papercup', 'tmp', 'work', 'batches'), { recursive: true });
    fs.mkdirSync(path.join(qaIntWs, '.papercup', 'tmp', 'work', 'out'), { recursive: true });
    fs.mkdirSync(path.join(qaIntWs, 'vn'), { recursive: true });

    fs.writeFileSync(
      path.join(qaIntWs, 'papercup.toml'),
      [
        '[vn.localization]',
        'narrative_pov = "first"',
        'source_lang = "ja"',
        'target_lang = "zh"',
        'glossary_file = "vn/glossary.json"',
        'persona_file = "vn/persona.json"',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(qaIntWs, 'vn', 'glossary.json'), JSON.stringify({ 先輩: '前辈' }), 'utf8');
    fs.writeFileSync(path.join(qaIntWs, 'vn', 'persona.json'), JSON.stringify({ 美咲: '温柔冷静的后辈' }), 'utf8');

    const qaRows = [
      { id: 's1.ks#1', file: 's1.ks', line: 1, scene: 'intro', speaker: '美咲', kind: 'say', source: '先輩、おはようございます。', track: 'scenario' },
      { id: 's1.ks#2', file: 's1.ks', line: 2, scene: 'intro', speaker: '美咲', kind: 'say', source: '今日もいい天気ですね。', track: 'scenario' },
      { id: 's1.ks#3', file: 's1.ks', line: 3, scene: 'intro', speaker: '美咲', kind: 'say', source: '資料室に行きましょうか。', track: 'scenario' },
      { id: 's1.ks#4', file: 's1.ks', line: 4, scene: 'intro', speaker: '美咲', kind: 'say', source: '午後の発表も頑張りましょう。', track: 'scenario' },
      { id: 's1.ks#5', file: 's1.ks', line: 5, scene: 'intro', speaker: '美咲', kind: 'say', source: 'お疲れさまでした。', track: 'scenario' },
    ];
    fs.writeFileSync(path.join(qaIntWs, '.papercup', 'data', 'build', 'scenario.jsonl'), qaRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(qaIntWs, '.papercup', 'tmp', 'work', 'batches', 'batch_000.jsonl'), qaRows.slice(0, 2).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(qaIntWs, '.papercup', 'tmp', 'work', 'batches', 'batch_001.jsonl'), qaRows.slice(2, 4).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(qaIntWs, '.papercup', 'tmp', 'work', 'batches', 'batch_002.jsonl'), qaRows.slice(4, 5).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(
      path.join(qaIntWs, '.papercup', 'tmp', 'work', 'batches', 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          batches: [
            { batch_id: 'batch_000', file: '.papercup/tmp/work/batches/batch_000.jsonl', track: 'scenario', rows: 2, estimated_source_tokens: 40, estimated_tokens_with_margin: 50, ids: ['s1.ks#1', 's1.ks#2'] },
            { batch_id: 'batch_001', file: '.papercup/tmp/work/batches/batch_001.jsonl', track: 'scenario', rows: 2, estimated_source_tokens: 40, estimated_tokens_with_margin: 50, ids: ['s1.ks#3', 's1.ks#4'] },
            { batch_id: 'batch_002', file: '.papercup/tmp/work/batches/batch_002.jsonl', track: 'scenario', rows: 1, estimated_source_tokens: 20, estimated_tokens_with_margin: 30, ids: ['s1.ks#5'] },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const qaIntService = new AgentService(qaIntWs, { sessionMode: 'persist' });
    try {
      await qaIntService.initSession();
      const qaIntSession = (qaIntService as any).currentSession;
      const qaIntMainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const qaIntSubFaux = createFauxCore({ tokensPerSecond: 10000 });
      qaIntSession.agent.state.model = qaIntMainFaux.getModel();
      qaIntSession.agent.streamFunction = qaIntMainFaux.streamSimple;
      qaIntSession._modelRuntime.hasConfiguredAuth = () => true;

      const qaIntSubMgr = (qaIntService as any).subagentManager as SubagentManager;
      const origQaIntCreateSub = qaIntSubMgr.createSubagentSession.bind(qaIntSubMgr);
      let qaIntSubRole = '';
      let qaIntRoleCheckerCalls = 0;
      let qaIntTranslatorCalls = 0;
      qaIntSubMgr.createSubagentSession = async (roleName, opts) => {
        qaIntSubRole = roleName;
        if (roleName === 'role-checker') qaIntRoleCheckerCalls++;
        if (roleName === 'translator') qaIntTranslatorCalls++;
        const res = await origQaIntCreateSub(roleName, opts);
        (res.session as any).agent.state.model = qaIntSubFaux.getModel();
        (res.session as any).agent.streamFunction = qaIntSubFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      // Turn 1: translate hits fatal 429 insufficient balance on batch_001 -> must circuit-break without retrying or firing batch_002
      qaIntSubFaux.setResponses([
        () =>
          fauxAssistantMessage(
            ['{"id":"s1.ks#1","target":"前辈，早上好。"}', '{"id":"s1.ks#2","target":"今天天气也真好呢。"}'].join('\n')
          ),
        () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429: {"message":"insufficient balance","request_id":"req-t1"}' }),
      ]);

      let tr1Observed: any = null;
      qaIntMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { concurrency: 1, checkpointInterval: 0 }, { id: 'tc-qi-tr1' })]),
        (ctx) => {
          tr1Observed = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-qi-tr1') ?? null;
          return fauxAssistantMessage('翻译在 batch_001 遇到额度耗尽并已暂停，已完成 batch_000。');
        },
      ]);
      await qaIntService.executeTurn('开始翻译');
      assert(tr1Observed?.isError === true, `Expected interrupted translate result isError=true, got ${JSON.stringify(tr1Observed)}`);
      assert(
        tr1Observed.details?.interrupted === true &&
          tr1Observed.details?.interruptKind === 'quota_exhausted' &&
          tr1Observed.details?.succeeded === 1 &&
          tr1Observed.details?.failed === 1 &&
          tr1Observed.details?.remainingPending === 1 &&
          tr1Observed.details?.sessionsOpened === 1 &&
          tr1Observed.details?.resumable === true,
        `Expected immediate quota circuit-break in vn_translate_batches without session retry: ${JSON.stringify(tr1Observed?.details)}`
      );
      assert(qaIntTranslatorCalls === 1, `Expected 1 translator session opened before quota circuit-break, got ${qaIntTranslatorCalls}`);

      // Turn 2: resume remaining batches, then run post_qa -> quota hits on chunk 1 -> chunk 2 never runs, chunk 0 stays checkpointed
      qaIntSubFaux.setResponses([
        () =>
          fauxAssistantMessage(
            ['{"id":"s1.ks#3","target":"我们去资料室吧。"}', '{"id":"s1.ks#4","target":"下午的发表也一起加油吧。"}'].join('\n')
          ),
        () => fauxAssistantMessage('{"id":"s1.ks#5","target":"辛苦了。"}'),
        () => fauxAssistantMessage('OK: consistent (chunk 0)'),
        () =>
          fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: '429: {"code":"SetLimitExceeded","message":"Your account has reached the usage limit"}',
          }),
      ]);

      let tr2Observed: any = null;
      let qa1Observed: any = null;
      let qaSkipObserved: any = null;
      qaIntMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { includeFailed: true, concurrency: 1, checkpointInterval: 0 }, { id: 'tc-qi-tr2' })]),
        (ctx) => {
          tr2Observed = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-qi-tr2') ?? null;
          return fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 2, concurrency: 1 }, { id: 'tc-qi-qa1' })]);
        },
        (ctx) => {
          qa1Observed = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-qi-qa1') ?? null;
          return fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { skipRoleChecker: true, batchMaxLines: 2 }, { id: 'tc-qi-qaskip' })]);
        },
        (ctx) => {
          qaSkipObserved = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-qi-qaskip') ?? null;
          return fauxAssistantMessage('确定性检查已运行，语义复核仍余 2 片待续检。');
        },
      ]);
      await qaIntService.executeTurn('继续完成翻译并执行 QA');
      assert(
        tr2Observed?.isError !== true && tr2Observed?.details?.ok === true && tr2Observed?.details?.succeeded === 2 && tr2Observed?.details?.skipped === 1,
        `Expected resume to skip batch_000 and translate 2 remaining batches, got ${JSON.stringify(tr2Observed?.details)}`
      );
      assert(qa1Observed?.isError === true, `Expected interrupted vn_post_qa_parallel to surface isError=true, got ${JSON.stringify(qa1Observed)}`);
      assert(
        qa1Observed.details?.interrupted === true &&
          qa1Observed.details?.interruptKind === 'quota_exhausted' &&
          qa1Observed.details?.roleCheckerChunksReviewed === 1 &&
          qa1Observed.details?.roleCheckerChunksTotal === 3 &&
          qa1Observed.details?.roleCheckerPendingChunks === 2 &&
          qa1Observed.details?.roleCheckerErrors === 1 &&
          qa1Observed.details?.semanticQaComplete === false &&
          qa1Observed.details?.resumable === true,
        `Expected structured partial post-QA state on quota circuit-break, got ${JSON.stringify(qa1Observed?.details)}`
      );
      assert(
        qaSkipObserved?.isError !== true &&
          qaSkipObserved?.details?.roleCheckerChunksReviewed === 1 &&
          qaSkipObserved?.details?.roleCheckerReusedChunks === 1 &&
          qaSkipObserved?.details?.roleCheckerPendingChunks === 2 &&
          qaSkipObserved?.details?.semanticQaComplete === false &&
          typeof qaSkipObserved?.details?.resumeHint === 'string',
        `Expected skipRoleChecker to preserve cached chunk 0 and report 2 pending chunks, got ${JSON.stringify(qaSkipObserved?.details)}`
      );
      assert(qaIntRoleCheckerCalls === 2, `Expected circuit-breaker to stop after chunk 1 without running chunk 2, got ${qaIntRoleCheckerCalls}`);
      assert(fs.existsSync(path.join(qaIntWs, '.papercup', 'data', 'vn', 'post_qa_state.json')), 'Expected .papercup/data/vn/post_qa_state.json to exist');

      // Re-run interrupted QA cleanly into interrupted status file, then simulate reverser subagent failure with artifacts + parent abort
      qaIntRoleCheckerCalls = 0;
      qaIntSubFaux.setResponses([
        // note: chunk 0 is already cached in post_qa_state.json so first call hits chunk 1 directly!
        () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429: {"message":"insufficient balance"}' }),
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'write',
              { path: '.papercup/research/demo/01-layout.md', content: '# Demo layout\nVerified header bytes.\n' },
              { id: 'tc-qi-rev-write' }
            ),
          ]),
        () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429: {"message":"insufficient balance"}' }),
      ]);

      let revResObserved: any = null;
      qaIntMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 2, concurrency: 1 }, { id: 'tc-qi-qa-int' })]),
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Inspect extra layout' }, { id: 'tc-qi-rev' })]),
        (ctx) => {
          revResObserved = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-qi-rev') ?? null;
          return fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'Request aborted' });
        },
      ]);
      await qaIntService.executeTurn('续检并排查附加脚本');
      const revTextObserved = String(revResObserved?.content?.[0]?.text || '');
      assert(
        revResObserved?.isError === true &&
          revResObserved.details?.interruptKind === 'quota_exhausted' &&
          Array.isArray(revResObserved.details?.artifacts) &&
          revResObserved.details.artifacts.includes('.papercup/research/demo/01-layout.md') &&
          revTextObserved.includes('[subagent_interruption_summary]') &&
          revTextObserved.includes('.papercup/research/demo/01-layout.md'),
        `Expected delegate_task failure text+details to expose interruption summary & artifacts, got ${JSON.stringify(revResObserved)}`
      );

      const statusDuringInt = getVnStatus(qaIntWs);
      assert(statusDuringInt.includes('语义QA状态：已中断') && statusDuringInt.includes('1/3'), `Expected vn_status to surface interrupted QA state, got:\n${statusDuringInt}`);
      const engDuringInt = await qaIntService.getEngineeringStatus();
      assert(
        engDuringInt.postQa?.interrupted === true &&
          engDuringInt.postQa?.interruptKind === 'quota_exhausted' &&
          engDuringInt.postQa?.roleCheckerPendingChunks === 2,
        `Expected getEngineeringStatus.postQa interruption metadata, got ${JSON.stringify(engDuringInt.postQa)}`
      );

      // Turn 4 ("继续"): parent must receive automatic Interruption Recovery Context without UI clutter, and vn_post_qa_parallel resumes ONLY chunks 1 & 2!
      let sawRecoveryContext = false;
      let recoveryMsgDebug: any = null;
      let qaFinalObserved: any = null;
      qaIntRoleCheckerCalls = 0;
      qaIntSubFaux.setResponses([
        () => fauxAssistantMessage('OK: consistent (chunk 1)'),
        () => fauxAssistantMessage('OK: consistent (chunk 2)'),
      ]);
      qaIntMainFaux.setResponses([
        (ctx) => {
          const recoveryMsg = ctx.messages.find((m) => {
            const content = Array.isArray(m.content) ? m.content.map((b: any) => b?.text || '').join('\n') : String(m.content || '');
            return content.includes('[系统中断恢复上下文 / Interruption Recovery Context]');
          }) as any;
          recoveryMsgDebug = ctx.messages.slice(-4);
          const recoveryText = recoveryMsg
            ? Array.isArray(recoveryMsg.content)
              ? recoveryMsg.content.map((b: any) => b?.text || '').join('\n')
              : String(recoveryMsg.content || '')
            : '';
          sawRecoveryContext = Boolean(
            recoveryMsg &&
              recoveryText.includes('subagent=reverser') &&
              recoveryText.includes('.papercup/research/demo/01-layout.md') &&
              recoveryText.includes('reviewed=1/3 pending=2')
          );
          return fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 2, concurrency: 2 }, { id: 'tc-qi-qa-resume' })]);
        },
        (ctx) => {
          qaFinalObserved = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-qi-qa-resume') ?? null;
          return fauxAssistantMessage('已续检全部剩余分片并通过 QA。');
        },
      ]);
      await qaIntService.executeTurn('继续');
      assert(sawRecoveryContext, `Expected compact interruption recovery context in parent LLM messages, got ${JSON.stringify(recoveryMsgDebug)}`);
      assert(
        qaFinalObserved?.isError !== true &&
          qaFinalObserved?.details?.ok === true &&
          qaFinalObserved?.details?.roleCheckerReusedChunks === 1 &&
          qaFinalObserved?.details?.roleCheckerChunksReviewed === 3 &&
          qaFinalObserved?.details?.roleCheckerPendingChunks === 0 &&
          qaFinalObserved?.details?.semanticQaComplete === true &&
          qaIntRoleCheckerCalls === 2,
        `Expected resume to reuse chunk 0 and only invoke role-checker 2 times for remaining chunks, got calls=${qaIntRoleCheckerCalls}, details=${JSON.stringify(qaFinalObserved?.details)}`
      );

      // Mutating narrative_pov in papercup.toml must invalidate post_qa_state.json locHash and force re-review of all 3 chunks
      fs.writeFileSync(
        path.join(qaIntWs, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "third"',
          'source_lang = "ja"',
          'target_lang = "zh"',
          'glossary_file = "vn/glossary.json"',
          'persona_file = "vn/persona.json"',
          '',
        ].join('\n'),
        'utf8'
      );
      qaIntRoleCheckerCalls = 0;
      let qaPovInvalidated: any = null;
      qaIntSubFaux.setResponses([
        () => fauxAssistantMessage('OK: consistent under third-person POV (chunk 0)'),
        () => fauxAssistantMessage('OK: consistent under third-person POV (chunk 1)'),
        () => fauxAssistantMessage('OK: consistent under third-person POV (chunk 2)'),
      ]);
      qaIntMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 2, concurrency: 1 }, { id: 'tc-qi-qa-pov' })]),
        (ctx) => {
          qaPovInvalidated = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-qi-qa-pov') ?? null;
          return fauxAssistantMessage('视角变更后已全量重审。');
        },
      ]);
      await qaIntService.executeTurn('修改 narrative_pov 后重跑 QA');
      assert(
        qaPovInvalidated?.isError !== true &&
          qaPovInvalidated?.details?.ok === true &&
          qaPovInvalidated?.details?.roleCheckerReusedChunks === 0 &&
          qaPovInvalidated?.details?.roleCheckerChunksReviewed === 3 &&
          qaIntRoleCheckerCalls === 3,
        `Changing narrative_pov must invalidate locHash cache and re-review all 3 chunks, got calls=${qaIntRoleCheckerCalls}, details=${JSON.stringify(qaPovInvalidated?.details)}`
      );

      const histCheck = await qaIntService.getSessionHistory();
      assert(
        !histCheck.messages.some((m) => m.content.includes('[系统中断恢复上下文')),
        'Internal interruption recovery context (display:false) must not clutter UI chat bubbles'
      );
      assert(qaIntSubRole !== '', 'Expected subagents to have executed');

      // Subsequent turn after completed turn must NOT inject interruption recovery context again
      let hasDupRecovery = false;
      qaIntMainFaux.setResponses([
        (ctx) => {
          hasDupRecovery = ctx.messages.slice(-2).some((m) => {
            const content = Array.isArray(m.content) ? m.content.map((b: any) => b?.text || '').join('\n') : String(m.content || '');
            return content.includes('[系统中断恢复上下文');
          });
          return fauxAssistantMessage('状态确认完毕。');
        },
      ]);
      await qaIntService.executeTurn('确认状态');
      assert(!hasDupRecovery, 'Completed turn must not re-trigger interruption recovery injection');
    } finally {
      (qaIntService as any).disposeCurrentSessionState?.(true);
    }
  });

  // 21. 文件夹选择器、跨工作区会话懒加载与直达、历史工具输出裁剪、扫描过滤/缓存与网关预热/重试事件
  console.log('21. Verifying folder picker, cross-workspace lazy sessions, history truncation, scan skip & warmup/retry...');
  await withIsolatedHomeAndEnv('papercup-ux-perf-', async ({ root: u21Root }) => {
    let u21Svc: AgentService | null = null;
    let u21PickSvc: AgentService | null = null;
    try {
      const u21WsA = path.join(u21Root, 'game-alpha');
      const u21WsB = path.join(u21Root, 'game-beta');
      const u21WsUnreg = path.join(u21Root, 'unregistered-dir');
      fs.mkdirSync(u21WsA, { recursive: true });
      fs.mkdirSync(u21WsB, { recursive: true });
      fs.mkdirSync(u21WsUnreg, { recursive: true });

      // 1) Folder picker route + busy 409 guard
      let pickerMode: 'pick' | 'cancel' = 'pick';
      u21PickSvc = new AgentService(u21WsA, {
        sessionMode: 'memory',
        folderPicker: async () =>
          pickerMode === 'pick' ? { canceled: false, path: u21WsB } : { canceled: true, path: null },
      });
      const u21PickRouter = createApiRouter(u21PickSvc);
      const pickOkRes = await u21PickRouter.request('/api/workspaces/pick', { method: 'POST', body: '{}' });
      assert(pickOkRes.status === 200, `Expected 200 from /api/workspaces/pick, got ${pickOkRes.status}`);
      const pickOkJson = await pickOkRes.json();
      assert(
        pickOkJson.ok === true && pickOkJson.canceled === false && path.resolve(pickOkJson.path) === path.resolve(u21WsB),
        `Expected picked path ${u21WsB}, got ${JSON.stringify(pickOkJson)}`
      );

      pickerMode = 'cancel';
      const pickCancelJson = await (
        await u21PickRouter.request('/api/workspaces/pick', { method: 'POST', body: '{}' })
      ).json();
      assert(
        pickCancelJson.ok === true && pickCancelJson.canceled === true && pickCancelJson.path === null,
        `Expected canceled folder pick result, got ${JSON.stringify(pickCancelJson)}`
      );

      (u21PickSvc as any).isRunningTurn = true;
      const pickBusyRes = await u21PickRouter.request('/api/workspaces/pick', { method: 'POST', body: '{}' });
      (u21PickSvc as any).isRunningTurn = false;
      assert(pickBusyRes.status === 409, `Expected 409 from /api/workspaces/pick while busy, got ${pickBusyRes.status}`);

      // 2) Cross-workspace lazy session listing + atomic open-session + large toolResult history truncation + warmup() contract
      fs.writeFileSync(path.join(u21WsA, 'big.txt'), 'X'.repeat(9500), 'utf-8');
      u21Svc = new AgentService(u21WsA, { sessionMode: 'persist' });
      const u21Router = createApiRouter(u21Svc);

      assert((u21Svc as any).currentSession === null, 'Fresh AgentService must not have initialized session before warmup()');
      await u21Svc.warmup();
      assert(Boolean((u21Svc as any).currentSession), 'warmup() must initialize the active session eagerly');
      const warmHistBeforeInit = await u21Svc.getSessionHistory();
      assert(Boolean(warmHistBeforeInit.sessionId), 'warmup() must produce a valid sessionId');
      await u21Svc.initSession();
      const warmHistAfterInit = await u21Svc.getSessionHistory();
      assert(
        warmHistAfterInit.sessionId === warmHistBeforeInit.sessionId,
        `initSession() after warmup() must reuse warmed session (${warmHistBeforeInit.sessionId} vs ${warmHistAfterInit.sessionId})`
      );

      const sA1Faux = createFauxCore({ tokensPerSecond: 10000 });
      const sA1Sess = (u21Svc as any).currentSession;
      sA1Sess.agent.state.model = sA1Faux.getModel();
      sA1Sess.agent.streamFunction = sA1Faux.streamSimple;
      sA1Sess._modelRuntime.hasConfiguredAuth = () => true;
      sA1Faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('read', { path: 'big.txt' }, { id: 'tc-u21-read-big' })]),
        () => fauxAssistantMessage('Alpha 会话 1 已读取 big.txt。'),
      ]);
      await u21Svc.executeTurn('Alpha 第一会话测试');
      const wsASession1Id = (await u21Svc.getSessionHistory()).sessionId!;
      const wsASession1File = (u21Svc as any).sessionManager?.getSessionFile?.() as string;

      // Verify large toolResult is truncated in UI history DTO but intact on disk .jsonl
      const histBig = await u21Svc.getSessionHistory();
      const readTool = histBig.messages
        .flatMap((m) => m.tools ?? [])
        .find((t) => t.callId === 'tc-u21-read-big');
      const readOutText = String(readTool?.result?.content?.[0]?.text || '');
      assert(
        readOutText.includes('历史预览已截断') && readOutText.length < 5000,
        `Expected >4KB toolResult to be truncated in history DTO, got len=${readOutText.length}`
      );
      const rawDiskJsonl = fs.readFileSync(wsASession1File, 'utf-8');
      assert(
        rawDiskJsonl.includes('X'.repeat(9000)),
        'Full toolResult text must remain untouched in persisted .jsonl on disk'
      );

      // Record a subagent task bound to wsASession1Id to verify session filtering later
      const u21SubMgr = (u21Svc as any).subagentManager as SubagentManager;
      u21SubMgr.markTaskProgress(u21WsA, 'fake-unused', 'noop');
      const fakeTaskDir = path.join(u21WsA, '.papercup', 'tmp', 'diagnostics', 'subagent-tasks');
      fs.mkdirSync(fakeTaskDir, { recursive: true });
      fs.writeFileSync(
        path.join(fakeTaskDir, 'subtask-u21-old.json'),
        JSON.stringify({
          taskId: 'subtask-u21-old',
          sessionId: wsASession1Id,
          role: 'reverser',
          model: null,
          thinkingLevel: 'low',
          status: 'completed',
          activityState: 'completed',
          stage: 'detect',
          startedAt: '2026-11-19T01:00:00.000Z',
          lastActivityAt: '2026-11-19T01:00:01.000Z',
          lastProgressAt: '2026-11-19T01:00:01.000Z',
          lastProgressSummary: 'done',
          durationMs: 100,
          toolCalls: [],
          errorCount: 0,
          artifacts: [],
          consecutiveHypothesisFailures: 0,
          pivotWarnings: [],
          retryCount: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          taskPrompt: 'old task',
          maxConsecutiveFailures: 3,
          responsePreview: '',
        }),
        'utf-8'
      );

      // Create second session in wsA
      const sA2State = await u21Svc.createNewSession();
      const wsASession2Id = sA2State.sessionId!;
      assert(
        !(sA2State.subagentTasks ?? []).some((t) => t.taskId === 'subtask-u21-old'),
        'Session 2 history must filter subagentTasks to current sessionId'
      );
      const sA2Faux = createFauxCore({ tokensPerSecond: 10000 });
      const sA2Sess = (u21Svc as any).currentSession;
      sA2Sess.agent.state.model = sA2Faux.getModel();
      sA2Sess.agent.streamFunction = sA2Faux.streamSimple;
      sA2Sess._modelRuntime.hasConfiguredAuth = () => true;
      sA2Faux.setResponses([() => fauxAssistantMessage('Alpha 会话 2 回复完成。')]);
      await u21Svc.executeTurn('Alpha 第二会话');

      // Switch to wsB and run a turn there
      const selBRes = await u21Router.request('/api/workspaces/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: u21WsB }),
      });
      assert(selBRes.status === 200, `Expected 200 switching to wsB, got ${selBRes.status}`);
      await u21Svc.initSession();
      const sBFaux = createFauxCore({ tokensPerSecond: 10000 });
      const sBSess = (u21Svc as any).currentSession;
      sBSess.agent.state.model = sBFaux.getModel();
      sBSess.agent.streamFunction = sBFaux.streamSimple;
      sBSess._modelRuntime.hasConfiguredAuth = () => true;
      sBFaux.setResponses([() => fauxAssistantMessage('Beta 会话回复完成。')]);
      await u21Svc.executeTurn('Beta 会话');

      // Lazy list wsA sessions while wsB remains active
      const lazyRes = await u21Router.request(`/api/workspaces/sessions?workspace=${encodeURIComponent(u21WsA)}`);
      assert(lazyRes.status === 200, `Expected 200 from /api/workspaces/sessions, got ${lazyRes.status}`);
      const lazyJson = await lazyRes.json();
      assert(
        lazyJson.sessions.length === 2 &&
          lazyJson.sessions.some((s: any) => s.id === wsASession1Id && s.title.includes('Alpha 第一会话')) &&
          lazyJson.sessions.some((s: any) => s.id === wsASession2Id && s.title.includes('Alpha 第二会话')),
        `Expected 2 lazy sessions for wsA, got ${JSON.stringify(lazyJson)}`
      );
      assert(
        path.resolve(u21Svc.getWorkspace()) === path.resolve(u21WsB),
        `Lazy listing wsA must NOT alter active workspace (${u21Svc.getWorkspace()})`
      );

      // Unregistered directory must be rejected
      const unregRes = await u21Router.request(`/api/workspaces/sessions?workspace=${encodeURIComponent(u21WsUnreg)}`);
      assert(unregRes.status === 404, `Expected 404 for unregistered workspace query, got ${unregRes.status}`);

      // Atomic open-session jumping from wsB directly into wsASession1Id
      const openRes = await u21Router.request('/api/workspaces/open-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: u21WsA, sessionId: wsASession1Id }),
      });
      assert(openRes.status === 200, `Expected 200 from /api/workspaces/open-session, got ${openRes.status}`);
      const openJson = await openRes.json();
      assert(
        openJson.ok === true &&
          path.resolve(openJson.workspaces.active) === path.resolve(u21WsA) &&
          openJson.session.sessionId === wsASession1Id &&
          openJson.session.messages.some((m: any) => m.content.includes('Alpha 会话 1 已读取 big.txt')),
        `Expected open-session to switch workspace to wsA and load session 1, got ${JSON.stringify(openJson)}`
      );

      // 3) scanWorkspace skips .papercup/tmp/unpacked/ & patch/ and getEngineeringStatus cache + ?refresh=1
      const fakeUnpackedDir = path.join(u21WsA, '.papercup', 'tmp', 'unpacked');
      const fakePatchDir = path.join(u21WsA, 'patch', 'files');
      fs.mkdirSync(fakeUnpackedDir, { recursive: true });
      fs.mkdirSync(fakePatchDir, { recursive: true });
      fs.writeFileSync(path.join(fakeUnpackedDir, 'ignored.rpa'), 'RPA-3.0 0000000000000018 00000000\n\x00', 'latin1');
      fs.writeFileSync(path.join(fakePatchDir, 'patched.rpa'), 'RPA-3.0 0000000000000018 00000000\n\x00', 'latin1');
      const scanFiltered = scanWorkspace(u21WsA, null);
      assert(
        !scanFiltered.hits.some((h) => h.path.startsWith('.papercup/') || h.path.startsWith('patch/')),
        `Expected scanWorkspace to skip .papercup/tmp/unpacked/ and patch/, got ${JSON.stringify(scanFiltered.hits)}`
      );

      const engCached1 = await u21Svc.getEngineeringStatus();
      assert(engCached1.hasBuild === false, 'Expected initial hasBuild=false');
      fs.mkdirSync(path.join(u21WsA, '.papercup', 'data', 'build'), { recursive: true });
      const engCached2 = await u21Svc.getEngineeringStatus();
      assert(engCached2.hasBuild === false, 'Expected cached engineering status within TTL');
      const engRefreshedRes = await u21Router.request('/api/engineering/status?refresh=1');
      assert(engRefreshedRes.status === 200, `Expected 200 from /api/engineering/status?refresh=1, got ${engRefreshedRes.status}`);
      const engRefreshed = await engRefreshedRes.json();
      assert(engRefreshed.hasBuild === true, 'Expected ?refresh=1 to bypass cache and detect new .papercup/data/build/ directory');

      // 4) auto_retry_start / auto_retry_end telemetry & turn_retry SSE forwarding
      const retryEvents: any[] = [];
      const onRetryEvt = (evt: any) => {
        if (evt.type === 'turn_retry') retryEvents.push(evt.data);
      };
      u21Svc.on('agent_event', onRetryEvt);
      try {
        (u21Svc as any).isRunningTurn = true;
        (u21Svc as any).activeTurnSnapshot = {
          sessionId: wsASession1Id,
          model: 'faux/test',
          isThinking: false,
          phase: 'connecting',
          thinking: '',
          response: '',
          tools: [],
          startedAt: new Date().toISOString(),
        };
        (u21Svc as any).handlePiSessionEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 250 });
        const syncDuringRetry = u21Svc.getTurnSyncState();
        assert(
          retryEvents.length === 1 &&
            retryEvents[0].attempt === 1 &&
            retryEvents[0].maxAttempts === 3 &&
            syncDuringRetry.activeTurn?.phase === 'retrying',
          `Expected turn_retry event and retrying snapshot phase, got events=${JSON.stringify(retryEvents)} sync=${JSON.stringify(syncDuringRetry)}`
        );
        (u21Svc as any).handlePiSessionEvent({ type: 'auto_retry_end', success: true, attempt: 1 });
        assert(
          u21Svc.getTurnSyncState().activeTurn?.phase === 'connecting',
          `Expected phase reset to connecting after auto_retry_end(success=true), got ${u21Svc.getTurnSyncState().activeTurn?.phase}`
        );
      } finally {
        u21Svc.off('agent_event', onRetryEvt);
        (u21Svc as any).isRunningTurn = false;
        (u21Svc as any).activeTurnSnapshot = null;
      }
    } finally {
      (u21PickSvc as any)?.disposeCurrentSessionState?.(true);
      (u21Svc as any)?.disposeCurrentSessionState?.(true);
    }
  });

  console.log('22. Verifying API key auto-detection, live supported-model filtering, metadata deprecation, and dynamic health version...');
  await withIsolatedHomeAndEnv('papercup-autodetect-test-', async ({ ws: u22Ws }) => {
    const googleFakeKey = 'AIzaSyFauxTestKey1234567890abcdef';
    const anthropicFakeKey = 'sk-ant-api03-faux-test-secret-01';
    const openaiFakeKey = 'sk-proj-faux-openai-test-secret-02';
    const deepseekAmbiguousKey = 'sk-faux-deepseek-ambiguous-03';
    const invalidAmbiguousKey = 'sk-faux-invalid-key-04';

    const probeRequests: Array<{ url: string; auth: string | null; xGoog: string | null; xApi: string | null }> = [];
    const mockProbeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const auth = headers.get('Authorization');
      const xGoog = headers.get('x-goog-api-key');
      const xApi = headers.get('x-api-key');
      probeRequests.push({ url, auth, xGoog, xApi });

      if (url.startsWith('https://generativelanguage.googleapis.com/')) {
        assert(!url.includes(googleFakeKey), 'Google probe URL must never contain API key in query string');
        if (xGoog === googleFakeKey) {
          return new Response(
            JSON.stringify({
              models: [
                { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro (Deprecated)', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/deep-research-preview-04-2026', displayName: 'Deep Research', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/imagen-3.0-generate-002', displayName: 'Imagen 3', supportedGenerationMethods: ['predict'] },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
      }

      if (url.startsWith('https://api.anthropic.com/v1/models')) {
        if (xApi === anthropicFakeKey) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
                { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
                { id: 'claude-3-7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet' },
                { id: 'claude-4-retired-meta', display_name: 'Claude 4 Retired', status: 'retired' },
                { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet (Legacy)' },
                { id: 'claude-2.1', display_name: 'Claude 2.1 (Retired)' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ error: 'invalid x-api-key' }), { status: 401 });
      }

      if (url.startsWith('https://api.openai.com/v1/models')) {
        if (auth === `Bearer ${openaiFakeKey}`) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-5.4' },
                { id: 'gpt-4.1' },
                { id: 'gpt-4o-2024-05-13' },
                { id: 'o1' },
                { id: 'gpt-5-deprecated-meta', deprecated: true },
                { id: 'gpt-5-retired-meta', status: 'retired' },
                { id: 'gpt-3.5-turbo' },
                { id: 'gpt-4' },
                { id: 'gpt-4-turbo' },
                { id: 'o1-mini' },
                { id: 'whisper-1' },
                { id: 'text-embedding-3-large' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }

      if (url.startsWith('https://api.deepseek.com/models')) {
        if (auth === `Bearer ${deepseekAmbiguousKey}`) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'deepseek-chat' },
                { id: 'deepseek-reasoner' },
                { id: 'deepseek-coder' },
                { id: 'deepseek-v2-chat' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }

      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    };

    const u22Svc = new AgentService(u22Ws, {
      sessionMode: 'memory',
      probeFetch: mockProbeFetch,
    });
    try {
      const u22App = createApiRouter(u22Svc);

      const expectedRootVersion = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
      ).version;
      const betaHealthRes = await u22App.request('/health');
      const betaHealthJson = await betaHealthRes.json();
      assert(
        betaHealthJson.version === expectedRootVersion,
        `Expected /health version to match root package.json (${expectedRootVersion}), got ${JSON.stringify(betaHealthJson)}`
      );

      // 22a. Google AIza prefix auto-detection + deprecation/non-chat filtering
      const googleAutoRes = await u22App.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'auto', apiKey: googleFakeKey }),
      });
      assert(googleAutoRes.status === 200, `Expected 200 on Google auto key detect, got ${googleAutoRes.status}`);
      const googleAutoBody = await googleAutoRes.json();
      assert(
        googleAutoBody.detectedProvider === 'google' &&
          googleAutoBody.detectionMethod === 'prefix-verified' &&
          googleAutoBody.liveModelCount === 2 &&
          googleAutoBody.filteredOutCount === 5 &&
          googleAutoBody.models.some((m: any) => m.key === 'google/gemini-2.5-flash') &&
          googleAutoBody.models.some((m: any) => m.key === 'google/gemini-3-flash-preview') &&
          !googleAutoBody.models.some((m: any) => /gemini-1\.5|gemini-2\.0|embedding|imagen|deep-research/.test(m.id)) &&
          !JSON.stringify(googleAutoBody).includes(googleFakeKey),
        `Unexpected Google auto-detected models payload: ${JSON.stringify(googleAutoBody)}`
      );

      // 22b. Anthropic sk-ant- prefix auto-detection: active claude-3-7 retained, retired metadata & legacy claude-2.1/3.5 filtered
      const antAutoRes = await u22App.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'auto', apiKey: anthropicFakeKey }),
      });
      assert(antAutoRes.status === 200, `Expected 200 on Anthropic auto key detect, got ${antAutoRes.status}`);
      const antAutoBody = await antAutoRes.json();
      assert(
        antAutoBody.detectedProvider === 'anthropic' &&
          antAutoBody.models.some((m: any) => m.key === 'anthropic/claude-sonnet-4-6') &&
          antAutoBody.models.some((m: any) => m.key === 'anthropic/claude-3-7-sonnet-20250219') &&
          !antAutoBody.models.some((m: any) => /claude-3-5|claude-2\.1|claude-4-retired-meta/.test(m.id)) &&
          !JSON.stringify(antAutoBody).includes(anthropicFakeKey),
        `Unexpected Anthropic auto-detected models payload: ${JSON.stringify(antAutoBody)}`
      );

      // 22c. OpenAI sk-proj- prefix: active gpt-4o & o1 MUST be retained; deprecated/retired metadata & retired legacy/non-chat filtered
      const openaiAutoRes = await u22App.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: openaiFakeKey }),
      });
      assert(openaiAutoRes.status === 200, `Expected 200 on omitted provider auto key detect, got ${openaiAutoRes.status}`);
      const openaiAutoBody = await openaiAutoRes.json();
      assert(
        openaiAutoBody.detectedProvider === 'openai' &&
          openaiAutoBody.models.some((m: any) => m.key === 'openai/gpt-5.4') &&
          openaiAutoBody.models.some((m: any) => m.key === 'openai/gpt-4.1') &&
          openaiAutoBody.models.some((m: any) => m.key === 'openai/gpt-4o-2024-05-13') &&
          openaiAutoBody.models.some((m: any) => m.key === 'openai/o1' && m.reasoning === true) &&
          !openaiAutoBody.models.some((m: any) =>
            /gpt-3\.5|gpt-4-turbo|o1-mini|whisper|text-embedding|^gpt-4$|deprecated-meta|retired-meta/.test(m.id)
          ),
        `Unexpected OpenAI filtered models payload: ${JSON.stringify(openaiAutoBody)}`
      );

      // 22d. Read-only /api/models/key/detect preview + ambiguous sk- concurrent probe identifying DeepSeek
      const dsPreviewRes = await u22App.request('/api/models/key/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: deepseekAmbiguousKey }),
      });
      assert(dsPreviewRes.status === 200, `Expected 200 on DeepSeek detect preview, got ${dsPreviewRes.status}`);
      const dsPreviewBody = await dsPreviewRes.json();
      assert(
        dsPreviewBody.provider === 'deepseek' &&
          dsPreviewBody.detectionMethod === 'probe' &&
          dsPreviewBody.liveModelCount === 2 &&
          dsPreviewBody.filteredOutCount === 2 &&
          !JSON.stringify(dsPreviewBody).includes(deepseekAmbiguousKey),
        `Unexpected DeepSeek preview: ${JSON.stringify(dsPreviewBody)}`
      );
      // Read-only preview must not alter currently active openai model
      const afterPreviewModels = await (await u22App.request('/api/models')).json();
      assert(
        String(afterPreviewModels.current).startsWith('openai/'),
        `Detect preview must remain read-only; got active model ${afterPreviewModels.current}`
      );

      // Apply ambiguous sk- DeepSeek key -> auto-switches and synthesizes live deepseek-chat & deepseek-reasoner
      const dsApplyRes = await u22App.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'auto', apiKey: deepseekAmbiguousKey }),
      });
      assert(dsApplyRes.status === 200, `Expected 200 applying ambiguous DeepSeek key, got ${dsApplyRes.status}`);
      const dsApplyBody = await dsApplyRes.json();
      assert(
        dsApplyBody.detectedProvider === 'deepseek' &&
          dsApplyBody.detectionMethod === 'probe' &&
          dsApplyBody.models.some((m: any) => m.key === 'deepseek/deepseek-chat') &&
          dsApplyBody.models.some((m: any) => m.key === 'deepseek/deepseek-reasoner') &&
          !dsApplyBody.models.some((m: any) => /deepseek-coder|deepseek-v2/.test(m.id)) &&
          typeof dsApplyBody.current === 'string' &&
          dsApplyBody.current.startsWith('deepseek/') &&
          !JSON.stringify(dsApplyBody).includes(deepseekAmbiguousKey),
        `Unexpected DeepSeek apply payload: ${JSON.stringify(dsApplyBody)}`
      );

      const dsSelectRes = await u22App.request('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek/deepseek-reasoner' }),
      });
      assert(dsSelectRes.status === 200, `Expected 200 selecting dynamic deepseek-reasoner, got ${dsSelectRes.status}`);
      const dsSelectBody = await dsSelectRes.json();
      assert(
        dsSelectBody.current === 'deepseek/deepseek-reasoner' &&
          (u22Svc as any).currentSession?.model?.reasoning === true,
        `Expected deepseek/deepseek-reasoner selected with reasoning=true`
      );

      // 22e. All-401 invalid ambiguous key returns clean 400 with zero raw key leaks
      const badRes = await u22App.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'auto', apiKey: invalidAmbiguousKey }),
      });
      assert(badRes.status === 400, `Expected 400 on rejected key, got ${badRes.status}`);
      const badBody = await badRes.json();
      assert(
        typeof badBody.error === 'string' &&
          badBody.error.length > 0 &&
          !badBody.error.includes(invalidAmbiguousKey),
        `Error message must describe failure cleanly without leaking key: ${JSON.stringify(badBody)}`
      );
    } finally {
      (u22Svc as any).disposeCurrentSessionState?.(true);
    }
  });

  // 23. 本地翻译专用模型 + 确定性结构体交接 + 多预设 + 双模式无缝切换集成测试
  console.log('\n23. Verifying dual-mode translator, deterministic TranslationPacket handoff, multi-preset, binary split, TM dedupe, and row escalation...');
  await withIsolatedHomeAndEnv('papercup-local-mt-', async ({ home: mtHome, ws: mtWs }) => {
    fs.mkdirSync(path.join(mtWs, '.papercup', 'data', 'build'), { recursive: true });
    fs.mkdirSync(path.join(mtWs, '.papercup', 'tmp', 'work', 'batches'), { recursive: true });
    fs.mkdirSync(path.join(mtWs, '.papercup', 'tmp', 'work', 'out'), { recursive: true });
    fs.mkdirSync(path.join(mtWs, 'vn'), { recursive: true });

    // 23a. 确定性剥离/还原/引号平衡/输出清洗/术语切片单元测试
    const masked1 = extractEnvelopeAndMask('[font color=red]「おはよう、%PLAYER%！[r]元気？」[l][p]');
    assert(
      masked1.envelope.leadingControls === '[font color=red]' &&
        masked1.envelope.openingQuote === '「' &&
        masked1.envelope.closingQuote === '」' &&
        masked1.envelope.trailingControls === '[l][p]' &&
        masked1.cleanSource === 'おはよう、⟦0⟧！⟦1⟧元気？' &&
        masked1.inlineTokens.length === 2,
      `Unexpected envelope/mask result: ${JSON.stringify(masked1)}`
    );
    const unbalancedQuotes = extractEnvelopeAndMask('「A」と「B」');
    assert(
      unbalancedQuotes.envelope.openingQuote === '' &&
        unbalancedQuotes.envelope.closingQuote === '' &&
        unbalancedQuotes.cleanSource === '「A」と「B」',
      `Unbalanced outer quotes must NOT be peeled: ${JSON.stringify(unbalancedQuotes)}`
    );
    const sampleUnit = {
      id: 'u#1',
      track: 'scenario' as const,
      file: 's1.ks',
      line: 1,
      scene: 'intro',
      speaker: '美咲',
      kind: 'say',
      originalSource: '[font color=red]「おはよう、%PLAYER%！[r]元気？」[l][p]',
      envelope: masked1.envelope,
      cleanSource: masked1.cleanSource,
      inlineTokens: masked1.inlineTokens,
      route: 'pending' as const,
    };
    const cleanedOut = cleanLocalModelOutput(
      '<think>internal reasoning</think>\n译文：【美咲】「早上好，⟦0⟧！⟦1⟧精神吗？」',
      sampleUnit
    );
    assert(
      cleanedOut === '早上好，⟦0⟧！⟦1⟧精神吗？',
      `Expected cleanLocalModelOutput to strip think/chatter/speaker/outer quote, got: ${cleanedOut}`
    );
    const testProf = {
      narrativePov: 'first',
      playerAddress: '',
      mixedRules: '',
      sourceLang: 'ja',
      targetLang: 'zh',
      maxLenRatio: 0,
      maxLenAbs: 0,
      requireGlossary: false,
      residueCheck: true,
      glossaryFile: '',
      personaFile: '',
    };
    const reassembled = reassembleUnit(
      sampleUnit,
      '<think>ok</think>译文：「早上好，⟦0⟧！⟦1⟧精神吗？」',
      testProf,
      {}
    );
    assert(
      reassembled.qaOk === true &&
        reassembled.finalTarget === '[font color=red]「早上好，%PLAYER%！[r]精神吗？」[l][p]',
      `Unexpected reassembled unit: ${JSON.stringify(reassembled)}`
    );
    const slicedGloss = sliceGlossaryForUnits([sampleUnit], { おはよう: '早上好', 学園: '学园' });
    assert(
      slicedGloss['おはよう'] === '早上好' && slicedGloss['学園'] === undefined,
      `Glossary slice should only include matched terms: ${JSON.stringify(slicedGloss)}`
    );

    // Local OpenAI-compatible HTTP mock server (preset-agnostic line extraction)
    const localApiSecret = 'local-secret-token-999';
    const localChatRequests: Array<{ lines: string[]; numbered: boolean; frequencyPenalty?: number; auth?: string }> = [];
    let requireLocalBearer = false;
    let allowMultiLineResponse = false;
    const translateSingleLine = (line: string, freqPenalty?: number): string => {
      if (line === 'こんにちは。') return '<think>thinking</think>\n译文：「你好。」';
      if (line === 'おはよう。') return '早上好。';
      if (line === '⟦0⟧、元気？') return '⟦0⟧，精神吗？';
      if (line === 'ねえ、⟦0⟧、元気？') return '喂，⟦0⟧，精神吗？';
      if (line === '今日はいい天気。') return '今天天气真好。';
      if (line === '風が強いですね。') {
        return typeof freqPenalty === 'number' && freqPenalty > 0
          ? '风真大啊。'
          : '风很大啊风很大啊风很大啊风很大啊风很大啊风很大啊';
      }
      if (line === '学園に行こう。') {
        // Deliberately omit glossary term "学园" so qaReport triggers row-level cloud escalation
        return '去学校吧。';
      }
      return `本地:${line}`;
    };
    const localServer = http.createServer((req, res) => {
      const authHeader = String(req.headers.authorization || '');
      if (requireLocalBearer && authHeader !== `Bearer ${localApiSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized local token' } }));
        return;
      }

      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'sakura-14b-qwen2.5-v1.0-q4_k_m', object: 'model' },
              { id: 'Qwen/Qwen2-7B-Instruct-GGUF', object: 'model' },
            ],
          })
        );
        return;
      }

      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const userMsg = String(body.messages?.[body.messages.length - 1]?.content || '');
          const { lines: inputLines, numbered } = extractMockMtLines(userMsg);

          localChatRequests.push({
            lines: inputLines,
            numbered,
            frequencyPenalty: body.frequency_penalty,
            auth: authHeader,
          });

          let content = '';
          if (inputLines.length > 1 && !allowMultiLineResponse) {
            // Intentionally misalign multi-line output to force binary packet split
            content = '行数故意不匹配';
          } else if (inputLines.length > 1) {
            const translated = inputLines.map((l) => translateSingleLine(l, body.frequency_penalty));
            content = numbered
              ? translated.map((t, idx) => `${idx + 1}: ${t}`).join('\n')
              : translated.join('\n');
          } else {
            const line = inputLines[0] || '';
            content = translateSingleLine(line, body.frequency_penalty);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-local-1',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
            })
          );
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', () => resolve()));
    const localPort = (localServer.address() as any).port;
    const localBaseUrl = `http://127.0.0.1:${localPort}/v1`;

    let mtService: AgentService | null = null;
    try {
      fs.writeFileSync(
        path.join(mtWs, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh"',
          'glossary_file = "vn/glossary.json"',
          '',
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(path.join(mtWs, 'vn', 'glossary.json'), JSON.stringify({ 学園: '学园' }), 'utf8');

      const mtRows = [
        { id: 's1.ks#1', file: 's1.ks', line: 1, scene: 'intro', speaker: '美咲', kind: 'say', source: '「こんにちは。」[p]', track: 'scenario' },
        { id: 's1.ks#2', file: 's1.ks', line: 2, scene: 'intro', speaker: '美咲', kind: 'say', source: '「こんにちは。」[l][r]', track: 'scenario' },
        { id: 's1.ks#3', file: 's1.ks', line: 3, scene: 'intro', speaker: '美咲', kind: 'say', source: '[font]「%PLAYER%、元気？」[p]', track: 'scenario' },
        { id: 's1.ks#4', file: 's1.ks', line: 4, scene: 'intro', speaker: '', kind: 'say', source: '今日はいい天気。', track: 'scenario' },
        { id: 's1.ks#5', file: 's1.ks', line: 5, scene: 'intro', speaker: '', kind: 'say', source: '風が強いですね。', track: 'scenario' },
        { id: 's1.ks#6', file: 's1.ks', line: 6, scene: 'intro', speaker: '', kind: 'say', source: '学園に行こう。', track: 'scenario' },
        { id: 's2.ks#1', file: 's2.ks', line: 1, scene: 'outro', speaker: '', kind: 'say', source: 'また明日ね。', track: 'scenario' },
        { id: 's2.ks#2', file: 's2.ks', line: 2, scene: 'outro', speaker: '', kind: 'say', source: 'おやすみなさい。', track: 'scenario' },
      ];
      fs.writeFileSync(path.join(mtWs, '.papercup', 'data', 'build', 'scenario.jsonl'), mtRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(path.join(mtWs, '.papercup', 'tmp', 'work', 'batches', 'batch_000.jsonl'), mtRows.slice(0, 6).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(path.join(mtWs, '.papercup', 'tmp', 'work', 'batches', 'batch_001.jsonl'), mtRows.slice(6, 8).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(
        path.join(mtWs, '.papercup', 'tmp', 'work', 'batches', 'manifest.json'),
        JSON.stringify(
          {
            schema: 1,
            batches: [
              { batch_id: 'batch_000', file: '.papercup/tmp/work/batches/batch_000.jsonl', track: 'scenario', rows: 6, estimated_source_tokens: 120, estimated_tokens_with_margin: 140, ids: mtRows.slice(0, 6).map((r) => r.id) },
              { batch_id: 'batch_001', file: '.papercup/tmp/work/batches/batch_001.jsonl', track: 'scenario', rows: 2, estimated_source_tokens: 40, estimated_tokens_with_margin: 50, ids: mtRows.slice(6, 8).map((r) => r.id) },
            ],
          },
          null,
          2
        ),
        'utf8'
      );

      mtService = new AgentService(mtWs, { sessionMode: 'persist' });
      await mtService.initSession();
      const mtSession = (mtService as any).currentSession;
      const mtMainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const mtSubFaux = createFauxCore({ tokensPerSecond: 10000 });
      mtSession.agent.state.model = mtMainFaux.getModel();
      mtSession.agent.streamFunction = mtMainFaux.streamSimple;
      mtSession._modelRuntime.hasConfiguredAuth = () => true;

      const mtSubMgr = (mtService as any).subagentManager as SubagentManager;
      const origMtCreateSub = mtSubMgr.createSubagentSession.bind(mtSubMgr);
      let cloudTranslatorCalls = 0;
      let cloudTranslatorBatches: Array<Array<{ id: string; source: string }>> = [];
      mtSubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origMtCreateSub(roleName, opts);
        (res.session as any).agent.state.model = mtSubFaux.getModel();
        (res.session as any).agent.streamFunction = mtSubFaux.streamSimple;
        if (roleName === 'translator') {
          mtSubFaux.setResponses([
            (ctx) => {
              cloudTranslatorCalls++;
              const lastUser = [...ctx.messages].reverse().find((m: any) => m.role === 'user');
              const promptText =
                typeof lastUser?.content === 'string'
                  ? lastUser.content
                  : Array.isArray(lastUser?.content)
                    ? lastUser.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
                    : '';
              const batchMatch = promptText.match(/<batch\b[^>]*>\s*([\s\S]*?)\s*<\/batch>/i);
              const batchBody = batchMatch ? batchMatch[1] : promptText;
              const rows = batchBody
                .split(/\r?\n/)
                .filter((l: string) => l.trim().startsWith('{'))
                .map((l: string) => JSON.parse(l));
              cloudTranslatorBatches.push(rows);
              const cloudDict: Record<string, string> = {
                '学園に行こう。': '去学园吧。',
                'また明日ね。': '明天见哦。',
                'おやすみなさい。': '晚安。',
              };
              return fauxAssistantMessage(
                rows.map((r: any) => JSON.stringify({ id: r.id, target: cloudDict[String(r.source)] || `云:${r.source}` })).join('\n')
              );
            },
          ]);
        }
        return res;
      };

      const mtApp = createApiRouter(mtService);

      // 23b. /api/translator/probe & /api/translator/config 持久化与密钥隔离
      const probeRes = await mtApp.request('/api/translator/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: localBaseUrl }),
      });
      assert(probeRes.status === 200, `Expected 200 on translator probe, got ${probeRes.status}`);
      const probeBody = await probeRes.json();
      assert(
        probeBody.models.some((m: any) => m.id === 'sakura-14b-qwen2.5-v1.0-q4_k_m') &&
          probeBody.models.some((m: any) => m.id === 'Qwen/Qwen2-7B-Instruct-GGUF'),
        `Probe must retain local GGUF/Qwen2 names unfiltered: ${JSON.stringify(probeBody)}`
      );

      requireLocalBearer = true;
      const cfgSaveRes = await mtApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local_mt',
          baseUrl: localBaseUrl,
          model: 'sakura-14b-qwen2.5-v1.0-q4_k_m',
          apiKey: localApiSecret,
          preset: 'sakura',
          packetLines: 4,
          concurrency: 1,
          escalateFailedRows: true,
          useTmCache: true,
          disableThinking: true,
        }),
      });
      assert(cfgSaveRes.status === 200, `Expected 200 saving translator config, got ${cfgSaveRes.status}`);
      const cfgSaveBody = await cfgSaveRes.json();
      assert(
        cfgSaveBody.effective.mode === 'local_mt' &&
          cfgSaveBody.effective.hasApiKey === true &&
          !JSON.stringify(cfgSaveBody).includes(localApiSecret),
        `Translator config response must mask apiKey: ${JSON.stringify(cfgSaveBody)}`
      );
      const persistedCfgPath = path.join(mtHome, '.papercup', 'translator.json');
      assert(fs.existsSync(persistedCfgPath), 'Expected ~/.papercup/translator.json persisted');
      assert(
        isRestrictedSecretPath(persistedCfgPath, mtWs) === true,
        '~/.papercup/translator.json must be protected by secrets path guard'
      );

      // 23c. 运行 batch_000 本地翻译全链路（TM 去重 + 二分退避 + 退化重试 + 单失败行云端升舱）
      mtMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { batchIds: ['batch_000'], checkpointInterval: 0 }, { id: 'tc-mt-b0' })]),
        (ctx) => {
          const resTool = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-mt-b0') as any;
          assert(resTool?.isError !== true, `batch_000 local_mt failed: ${resTool?.content?.[0]?.text}`);
          return fauxAssistantMessage('batch_000 本地翻译完成。');
        },
      ]);
      await mtService.executeTurn('使用本地模型翻译 batch_000');

      assert(
        cloudTranslatorCalls === 1 &&
          cloudTranslatorBatches.length === 1 &&
          cloudTranslatorBatches[0].length === 1 &&
          cloudTranslatorBatches[0][0].id === 's1.ks#6',
        `Expected ONLY 1 failed row (s1.ks#6) escalated to cloud translator, got calls=${cloudTranslatorCalls}, batches=${JSON.stringify(cloudTranslatorBatches)}`
      );
      assert(
        localChatRequests.some((r) => typeof r.frequencyPenalty === 'number' && r.frequencyPenalty > 0),
        'Expected degeneration retry with frequency_penalty > 0'
      );
      assert(
        !localChatRequests.some((r) => r.lines.length === 1 && r.lines[0] === 'こんにちは。' && localChatRequests.filter((x) => x.lines.length === 1 && x.lines[0] === 'こんにちは。').length > 1),
        'Expected intra-batch duplicate s1.ks#2 to hit TM cache without calling local model twice'
      );

      const outB0 = fs
        .readFileSync(path.join(mtWs, '.papercup', 'tmp', 'work', 'out', 'batch_000.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      assert(outB0.length === 6, `Expected 6 rows in batch_000.jsonl, got ${outB0.length}`);
      assert(outB0[0].target === '「你好。」[p]', `Unexpected s1#1 target: ${outB0[0].target}`);
      assert(outB0[1].target === '「你好。」[l][r]', `Unexpected s1#2 TM-wrapped target: ${outB0[1].target}`);
      assert(outB0[2].target === '[font]「%PLAYER%，精神吗？」[p]', `Unexpected s1#3 target: ${outB0[2].target}`);
      assert(outB0[3].target === '今天天气真好。', `Unexpected s1#4 target: ${outB0[3].target}`);
      assert(outB0[4].target === '风真大啊。', `Unexpected s1#5 target after degeneration retry: ${outB0[4].target}`);
      assert(outB0[5].target === '去学园吧。', `Unexpected s1#6 cloud-escalated target: ${outB0[5].target}`);

      const mtProg = JSON.parse(fs.readFileSync(path.join(mtWs, '.papercup', 'data', 'vn', 'progress.json'), 'utf8'));
      assert(
        mtProg.batches.batch_000.mode === 'local_mt' &&
          mtProg.batches.batch_000.route_stats.tm_cache === 1 &&
          mtProg.batches.batch_000.route_stats.cloud_escalated === 1 &&
          mtProg.batches.batch_000.route_stats.local_mt === 4,
        `Unexpected batch_000 progress route_stats: ${JSON.stringify(mtProg.batches.batch_000)}`
      );

      const engAfterLocal = await (await mtApp.request('/api/engineering/status?refresh=1')).json();
      assert(
        engAfterLocal.translator?.mode === 'local_mt' &&
          engAfterLocal.batchProgress?.routeStats?.tmCache === 1 &&
          engAfterLocal.batchProgress?.routeStats?.cloudEscalated === 1,
        `Engineering status missing local translator / routeStats: ${JSON.stringify(engAfterLocal)}`
      );

      // 23c-2. 端到端覆盖 hy-mt 与 plain-lines 多行/单行预设（验证非 Sakura 预设的提示构造与响应解析）
      allowMultiLineResponse = true;
      const presetMask2 = extractEnvelopeAndMask('ねえ、%PLAYER%、元気？');
      const presetUnits = [
        {
          id: 'p#1',
          track: 'scenario' as const,
          file: 'p.ks',
          line: 1,
          scene: 'preset',
          speaker: '美咲',
          kind: 'say',
          originalSource: 'おはよう。',
          envelope: { leadingControls: '', openingQuote: '', closingQuote: '', trailingControls: '' },
          cleanSource: 'おはよう。',
          inlineTokens: [],
          route: 'pending' as const,
        },
        {
          id: 'p#2',
          track: 'scenario' as const,
          file: 'p.ks',
          line: 2,
          scene: 'preset',
          speaker: '美咲',
          kind: 'say',
          originalSource: 'ねえ、%PLAYER%、元気？',
          envelope: presetMask2.envelope,
          cleanSource: presetMask2.cleanSource,
          inlineTokens: presetMask2.inlineTokens,
          route: 'pending' as const,
        },
      ];
      const basePresetPacket = {
        schema: 1 as const,
        batchId: 'preset-batch',
        packetId: 'preset-pkt',
        track: 'scenario' as const,
        context: {
          sourceLang: 'ja',
          targetLang: 'zh-CN',
          narrativePov: 'first',
          glossarySlice: {},
          speakerHints: {},
          prevContext: [],
        },
        units: presetUnits,
      };
      const hyMtClient = new LocalTranslatorClient({
        ...DEFAULT_LOCAL_TRANSLATOR_CONFIG,
        mode: 'local_mt',
        baseUrl: localBaseUrl,
        model: 'hy-mt1.5-7b',
        apiKey: localApiSecret,
        preset: 'hy-mt',
      });
      const hyMtRes = await hyMtClient.translatePacketWithBinarySplit(basePresetPacket);
      assert(
        hyMtRes.calls === 1 &&
          hyMtRes.targets.length === 2 &&
          hyMtRes.targets[0] === '早上好。' &&
          hyMtRes.targets[1] === '喂，⟦0⟧，精神吗？',
        `hy-mt multi-line preset failed: ${JSON.stringify(hyMtRes)}`
      );

      const reqCountBeforePlain = localChatRequests.length;
      const plainClient = new LocalTranslatorClient({
        ...DEFAULT_LOCAL_TRANSLATOR_CONFIG,
        mode: 'local_mt',
        baseUrl: localBaseUrl,
        model: 'Qwen/Qwen2-7B-Instruct-GGUF',
        apiKey: localApiSecret,
        preset: 'plain-lines',
      });
      const plainMultiRes = await plainClient.translatePacketWithBinarySplit(basePresetPacket);
      const plainMultiReq = localChatRequests[reqCountBeforePlain];
      assert(
        plainMultiReq?.numbered === true &&
          plainMultiRes.calls === 1 &&
          plainMultiRes.targets.length === 2 &&
          plainMultiRes.targets[0] === '早上好。' &&
          plainMultiRes.targets[1] === '喂，⟦0⟧，精神吗？',
        `plain-lines numbered multi-line preset failed: req=${JSON.stringify(plainMultiReq)}, res=${JSON.stringify(plainMultiRes)}`
      );
      const plainSingleRes = await plainClient.translatePacketWithBinarySplit({
        ...basePresetPacket,
        packetId: 'preset-pkt-single',
        units: [presetUnits[0]],
      });
      assert(
        plainSingleRes.calls === 1 &&
          plainSingleRes.targets.length === 1 &&
          plainSingleRes.targets[0] === '早上好。',
        `plain-lines single-line preset failed: ${JSON.stringify(plainSingleRes)}`
      );
      allowMultiLineResponse = false;

      // 23d. 中途无缝切回云端 Subagent 续译 batch_001 并执行 vn_merge 合并检验
      const switchCloudRes = await mtApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'cloud_subagent' }),
      });
      assert(switchCloudRes.status === 200, 'Expected 200 switching back to cloud_subagent');

      cloudTranslatorBatches = [];
      mtMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { checkpointInterval: 0 }, { id: 'tc-mt-b1' })]),
        (ctx) => {
          const resTool = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-mt-b1') as any;
          assert(resTool?.isError !== true, `batch_001 cloud resume failed: ${resTool?.content?.[0]?.text}`);
          return fauxAssistantMessage('剩余批次云端续译完成。');
        },
      ]);
      await mtService.executeTurn('切回云端模式续译剩余批次');

      assert(
        cloudTranslatorBatches.length === 1 &&
          cloudTranslatorBatches[0].length === 2 &&
          cloudTranslatorBatches[0][0].id === 's2.ks#1',
        `Expected ONLY pending batch_001 translated by cloud after mode switch, got ${JSON.stringify(cloudTranslatorBatches)}`
      );
      const mergedMt = mergeVnBatches(mtWs, { track: 'scenario' });
      assert(
        mergedMt.ok === true && mergedMt.total_passed === 8 && mergedMt.total_failed === 0,
        `Expected 8/8 merged rows passing QA after hybrid local+cloud translation, got ${JSON.stringify(mergedMt)}`
      );

      // 23e. 本地端点不可达 Fail-Fast（严禁静默回退全量云端）
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
      cloudTranslatorCalls = 0;
      const switchClosedRes = await mtApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'local_mt', baseUrl: localBaseUrl, model: 'sakura-14b-qwen2.5-v1.0-q4_k_m' }),
      });
      assert(switchClosedRes.status === 200, 'Expected config update ok');

      mtMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { batchIds: ['batch_001'], force: true, checkpointInterval: 0 }, { id: 'tc-mt-failfast' })]),
        (ctx) => {
          const resTool = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-mt-failfast') as any;
          assert(resTool?.isError === true, 'Unreachable local endpoint must fail batch run');
          return fauxAssistantMessage('本地端点不可达，已按 Fail-Fast 原则中止。');
        },
      ]);
      await mtService.executeTurn('验证本地端点断连不静默回退云端');
      assert(
        cloudTranslatorCalls === 0,
        `Fail-Fast violation: unreachable local endpoint fell back to cloud (${cloudTranslatorCalls} calls)`
      );

      // 23f. 工作区 papercup.toml [vn.translator] 覆盖优先级测试
      await mtApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'cloud_subagent' }),
      });
      fs.appendFileSync(
        path.join(mtWs, 'papercup.toml'),
        '\n[vn.translator]\nmode = "local_mt"\npreset = "hy-mt"\npacket_lines = 4\n',
        'utf8'
      );
      const overrideRes = await mtApp.request('/api/translator/config');
      assert(overrideRes.status === 200, 'Expected 200 on translator config GET');
      const overrideBody = await overrideRes.json();
      assert(
        overrideBody.global.mode === 'cloud_subagent' &&
          overrideBody.workspaceOverride?.mode === 'local_mt' &&
          overrideBody.effective.mode === 'local_mt' &&
          overrideBody.effective.preset === 'hy-mt' &&
          overrideBody.effective.packetLines === 4,
        `Workspace [vn.translator] override precedence failed: ${JSON.stringify(overrideBody)}`
      );
    } finally {
      try {
        localServer.close();
      } catch {
        // Ignore if already closed
      }
      (mtService as any)?.disposeCurrentSessionState?.(true);
    }
  });

  // 24. 实时 Token 消耗统计（Pi 原生 SessionManager.appendUsage + 云端/本地拆分 + 估算兜底 + 会话切换持久化）
  console.log('24. Verifying real-time token usage tracking, cloud/local split, fallback estimation & persistence...');
  await withIsolatedHomeAndEnv('papercup-tok-', async ({ ws: tokWs }) => {
    fs.mkdirSync(path.join(tokWs, 'vn'), { recursive: true });
    fs.mkdirSync(path.join(tokWs, '.papercup', 'data', 'build'), { recursive: true });
    fs.mkdirSync(path.join(tokWs, '.papercup', 'tmp', 'work', 'batches'), { recursive: true });
    fs.mkdirSync(path.join(tokWs, '.papercup', 'tmp', 'work', 'out'), { recursive: true });

    let tokOmitUsage = false;
    const tokLocalServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'sakura-test-mt', object: 'model' }] }));
        return;
      }
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const userMsg = String(body.messages?.[body.messages.length - 1]?.content || '');
          const { lines: inputLines, numbered } = extractMockMtLines(userMsg);
          const outLines = inputLines.map((line) => {
            if (line.includes('月が綺麗')) return '今晚月色真美。';
            if (line.includes('学園の前')) return '在学校前面等着。'; // Intentionally omit glossary term 学园 -> cloud escalation
            return `译:${line}`;
          });
          const rendered = numbered
            ? outLines.map((l, idx) => `${idx + 1}: ${l}`).join('\n')
            : outLines.join('\n');
          const payload: any = {
            id: 'chatcmpl-tok-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: rendered }, finish_reason: 'stop' }],
            ...(tokOmitUsage ? {} : { usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } }),
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => tokLocalServer.listen(0, '127.0.0.1', () => resolve()));
    const tokLocalBaseUrl = `http://127.0.0.1:${(tokLocalServer.address() as any).port}/v1`;

    let tokService: AgentService | null = null;
    let tokService2: AgentService | null = null;
    try {
      fs.writeFileSync(
        path.join(tokWs, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh"\nglossary_file = "vn/glossary.json"\n',
        'utf8'
      );
      fs.writeFileSync(path.join(tokWs, 'vn', 'glossary.json'), JSON.stringify({ 学園: '学园' }), 'utf8');

      const tokRows = [
        { id: 't1.ks#1', file: 't1.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはようございます。', track: 'scenario' },
        { id: 't1.ks#2', file: 't1.ks', line: 2, scene: 's1', speaker: '', kind: 'say', source: '今日も頑張りましょう。', track: 'scenario' },
        { id: 't2.ks#1', file: 't2.ks', line: 1, scene: 's2', speaker: '', kind: 'say', source: '今夜は月が綺麗ですね。', track: 'scenario' },
        { id: 't2.ks#2', file: 't2.ks', line: 2, scene: 's2', speaker: '', kind: 'say', source: '学園の前で待ってる。', track: 'scenario' },
      ];
      fs.writeFileSync(path.join(tokWs, '.papercup', 'data', 'build', 'scenario.jsonl'), tokRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(path.join(tokWs, '.papercup', 'tmp', 'work', 'batches', 'batch_000.jsonl'), tokRows.slice(0, 2).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(path.join(tokWs, '.papercup', 'tmp', 'work', 'batches', 'batch_001.jsonl'), tokRows.slice(2, 4).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(
        path.join(tokWs, '.papercup', 'tmp', 'work', 'batches', 'manifest.json'),
        JSON.stringify(
          {
            schema: 1,
            batches: [
              { batch_id: 'batch_000', file: '.papercup/tmp/work/batches/batch_000.jsonl', track: 'scenario', rows: 2, estimated_source_tokens: 40, estimated_tokens_with_margin: 50, ids: tokRows.slice(0, 2).map((r) => r.id) },
              { batch_id: 'batch_001', file: '.papercup/tmp/work/batches/batch_001.jsonl', track: 'scenario', rows: 2, estimated_source_tokens: 40, estimated_tokens_with_margin: 50, ids: tokRows.slice(2, 4).map((r) => r.id) },
            ],
          },
          null,
          2
        ),
        'utf8'
      );

      tokService = new AgentService(tokWs, { sessionMode: 'persist' });
      await tokService.initSession();
      const tokSession = (tokService as any).currentSession;
      const tokMainFaux = createFauxCore({ tokensPerSecond: 10000 });
      const tokSubFaux = createFauxCore({ tokensPerSecond: 10000 });
      tokSession.agent.state.model = tokMainFaux.getModel();
      tokSession.agent.streamFunction = tokMainFaux.streamSimple;
      tokSession._modelRuntime.hasConfiguredAuth = () => true;

      const tokSubMgr = (tokService as any).subagentManager as SubagentManager;
      const origTokCreateSub = tokSubMgr.createSubagentSession.bind(tokSubMgr);
      tokSubMgr.createSubagentSession = async (roleName, opts) => {
        const res = await origTokCreateSub(roleName, opts);
        (res.session as any).agent.state.model = tokSubFaux.getModel();
        (res.session as any).agent.streamFunction = tokSubFaux.streamSimple;
        return res;
      };

      const tokApp = createApiRouter(tokService);
      const tokenUsageEvents: any[] = [];
      tokService.on('agent_event', (ev: any) => {
        if (ev?.type === 'token_usage') {
          tokenUsageEvents.push(ev.data);
        }
      });

      // 24a. 主会话 Pi 原生统计 + 实时 SSE token_usage 推送 + API 同步一致
      tokMainFaux.setResponses([() => fauxAssistantMessage('你好，我已准备好协助本地化工作。')]);
      await tokService.executeTurn('你好，请确认状态');

      assert(tokenUsageEvents.length >= 2, `Expected multiple token_usage SSE events, got ${tokenUsageEvents.length}`);
      const afterTurn1 = (await (await tokApp.request('/api/session/history')).json()).tokenUsage;
      const syncTurn1 = (await (await tokApp.request('/api/turns/status')).json()).tokenUsage;
      const piStatsAfterTurn1 = tokSession.getSessionStats();
      const turn1PromptTokens = afterTurn1
        ? afterTurn1.cloud.input + afterTurn1.cloud.cacheRead + afterTurn1.cloud.cacheWrite
        : 0;
      assert(
        afterTurn1 &&
          turn1PromptTokens > 0 &&
          afterTurn1.cloud.output > 0 &&
          afterTurn1.cloud.totalTokens === piStatsAfterTurn1.tokens.total &&
          afterTurn1.local.totalTokens === 0 &&
          afterTurn1.breakdown.main.calls >= 1 &&
          afterTurn1.currentTurn.live === false &&
          syncTurn1.total.totalTokens === afterTurn1.total.totalTokens,
        `Unexpected main-session tokenUsage after Turn 1: api=${JSON.stringify(afterTurn1)}, pi=${JSON.stringify(piStatsAfterTurn1.tokens)}`
      );

      // 24b. cloud_subagent 模式翻译 batch_000（计入 cloudTranslator，不计入 local）
      await tokApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'cloud_subagent' }),
      });
      tokSubFaux.setResponses([
        () =>
          fauxAssistantMessage(
            [
              JSON.stringify({ id: 't1.ks#1', target: '早上好。' }),
              JSON.stringify({ id: 't1.ks#2', target: '今天也请加油。' }),
            ].join('\n')
          ),
      ]);
      tokMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { batchIds: ['batch_000'], checkpointInterval: 0 }, { id: 'tc-tok-cloud' })]),
        (ctx) => {
          const resTool = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tok-cloud') as any;
          assert(resTool?.details?.cloudUsage?.totalTokens > 0 && resTool?.details?.localUsage?.totalTokens === 0, `Expected cloudUsage > 0 & localUsage == 0, got ${JSON.stringify(resTool?.details)}`);
          return fauxAssistantMessage('云端批译完成。');
        },
      ]);
      await tokService.executeTurn('用云端模式翻译 batch_000');

      const afterCloud = (await (await tokApp.request('/api/session/history')).json()).tokenUsage;
      const piStatsAfterCloud = tokSession.getSessionStats();
      assert(
        afterCloud.breakdown.cloudTranslator.totalTokens > 0 &&
          afterCloud.breakdown.cloudTranslator.calls >= 1 &&
          afterCloud.local.totalTokens === 0 &&
          afterCloud.cloud.totalTokens === afterCloud.total.totalTokens &&
          afterCloud.total.totalTokens === piStatsAfterCloud.tokens.total,
        `Cloud subagent usage mismatch: afterCloud=${JSON.stringify(afterCloud)}, piStats=${JSON.stringify(piStatsAfterCloud.tokens)}`
      );

      // 24c. local_mt 模式翻译 batch_001（服务端返回精确 usage 120/45/165 + 单失败行云端升舱严格隔离）
      await tokApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local_mt',
          baseUrl: tokLocalBaseUrl,
          model: 'sakura-test-mt',
          preset: 'sakura',
          packetLines: 4,
          concurrency: 1,
          escalateFailedRows: true,
          useTmCache: false,
        }),
      });
      tokSubFaux.setResponses([
        () => fauxAssistantMessage(JSON.stringify({ id: 't2.ks#2', target: '在学园前面等着。' })),
      ]);
      tokMainFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { batchIds: ['batch_001'], checkpointInterval: 0 }, { id: 'tc-tok-local1' })]),
        (ctx) => {
          const resTool = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tok-local1') as any;
          assert(
            resTool?.details?.localUsage?.totalTokens === 165 && resTool?.details?.cloudUsage?.totalTokens > 0,
            `Expected split localUsage=165 and escalation cloudUsage>0, got ${JSON.stringify(resTool?.details)}`
          );
          return fauxAssistantMessage('本地+升舱混合翻译完成。');
        },
      ]);
      await tokService.executeTurn('用本地模式翻译 batch_001');

      const afterLocalExact = (await (await tokApp.request('/api/session/history')).json()).tokenUsage;
      assert(
        afterLocalExact.local.input === 120 &&
          afterLocalExact.local.output === 45 &&
          afterLocalExact.local.totalTokens === 165 &&
          !afterLocalExact.local.estimated &&
          afterLocalExact.breakdown.localMt.calls === 1 &&
          afterLocalExact.breakdown.cloudEscalation.totalTokens > 0 &&
          afterLocalExact.breakdown.cloudEscalation.calls >= 1 &&
          afterLocalExact.total.totalTokens === afterLocalExact.cloud.totalTokens + afterLocalExact.local.totalTokens &&
          afterLocalExact.currentTurn.local.totalTokens === 165 &&
          afterLocalExact.currentTurn.cloud.totalTokens > 0 &&
          afterLocalExact.translatorMode === 'local_mt',
        `Local exact + escalation split assertion failed: ${JSON.stringify(afterLocalExact)}`
      );

      // 24d. 本地服务省略 usage 时走确定性估算兜底并标记 estimated: true
      tokOmitUsage = true;
      tokMainFaux.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'vn_translate_batches',
              { batchIds: ['batch_001'], force: true, escalateFailedRows: false, checkpointInterval: 0 },
              { id: 'tc-tok-local-est' }
            ),
          ]),
        () => fauxAssistantMessage('已完成本地估算测试。'),
      ]);
      await tokService.executeTurn('验证本地省略 usage 的确定性估算');

      const histBeforeRestart = await (await tokApp.request('/api/session/history')).json();
      const afterLocalEst = histBeforeRestart.tokenUsage;
      assert(
        afterLocalEst.local.input > 120 &&
          afterLocalEst.local.output > 45 &&
          afterLocalEst.local.totalTokens > 165 &&
          afterLocalEst.local.estimated === true &&
          afterLocalEst.breakdown.localMt.calls === 2,
        `Fallback local estimation failed: ${JSON.stringify(afterLocalEst)}`
      );

      // Verify Pi SessionManager.buildSessionContext() excludes appendUsage entries from LLM context
      const llmCtxMessages = (tokService as any).sessionManager.buildSessionContext().messages;
      assert(
        Array.isArray(llmCtxMessages) && llmCtxMessages.every((m: any) => m.type !== 'usage' && m.role !== 'usage'),
        'Session usage entries must never leak into Pi LLM prompt context'
      );

      const firstSessionId = histBeforeRestart.sessionId;
      (tokService as any).disposeCurrentSessionState(true);
      tokService = null;

      // 24e. 重建 AgentService 验证持久化恢复 + 新建/切换会话 Token 状态严格隔离
      tokService2 = new AgentService(tokWs, { sessionMode: 'persist' });
      const tokApp2 = createApiRouter(tokService2);
      const reloadedHist = await (await tokApp2.request('/api/session/history')).json();
      const reloadedTok = reloadedHist.tokenUsage;
      assert(
        reloadedHist.sessionId === firstSessionId &&
          reloadedTok.cloud.totalTokens === afterLocalEst.cloud.totalTokens &&
          reloadedTok.local.totalTokens === afterLocalEst.local.totalTokens &&
          reloadedTok.breakdown.cloudTranslator.totalTokens === afterLocalEst.breakdown.cloudTranslator.totalTokens &&
          reloadedTok.breakdown.cloudEscalation.totalTokens === afterLocalEst.breakdown.cloudEscalation.totalTokens &&
          reloadedTok.breakdown.localMt.totalTokens === afterLocalEst.breakdown.localMt.totalTokens &&
          reloadedTok.local.estimated === true,
        `Token usage persistence reload mismatch: expected=${JSON.stringify(afterLocalEst)}, got=${JSON.stringify(reloadedTok)}`
      );

      const newSessRes = await (await tokApp2.request('/api/session/new', { method: 'POST' })).json();
      assert(
        newSessRes.sessionId !== firstSessionId &&
          newSessRes.tokenUsage.total.totalTokens === 0 &&
          newSessRes.tokenUsage.cloud.totalTokens === 0 &&
          newSessRes.tokenUsage.local.totalTokens === 0,
        `New session must reset tokenUsage to 0: ${JSON.stringify(newSessRes.tokenUsage)}`
      );

      const switchBackRes = await (
        await tokApp2.request('/api/sessions/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: firstSessionId }),
        })
      ).json();
      assert(
        switchBackRes.sessionId === firstSessionId &&
          switchBackRes.tokenUsage.cloud.totalTokens === afterLocalEst.cloud.totalTokens &&
          switchBackRes.tokenUsage.local.totalTokens === afterLocalEst.local.totalTokens,
        `Switching back to session must restore its tokenUsage: ${JSON.stringify(switchBackRes.tokenUsage)}`
      );
    } finally {
      try {
        tokLocalServer.close();
      } catch {
        // Ignore if already closed
      }
      (tokService as any)?.disposeCurrentSessionState?.(true);
      (tokService2 as any)?.disposeCurrentSessionState?.(true);
    }
  });

  // 25. 本机 Ollama 并发自动同步、只读环境变量脚本、422 降级与非聊天模型过滤测试（全隔离 + 纯离线 Mock，严禁触碰宿主机 Ollama 或 ~/.papercup）
  console.log('25. Verifying local Ollama default tuning, read-only env script, auto-sync SSE lifecycle, 422 kwargs fallback, and non-chat filtering...');
  await withIsolatedHomeAndEnv('papercup-ollama-sync-', async ({ root: syncRoot, ws: syncWs }) => {
    assert(
      DEFAULT_LOCAL_TRANSLATOR_CONFIG.mode === 'cloud_subagent' &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.baseUrl === 'http://127.0.0.1:11434/v1' &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.preset === 'sakura' &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.packetLines === 8 &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.concurrency === 3 &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.contextWindow === 4 &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.escalateFailedRows === true &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.useTmCache === true &&
        DEFAULT_LOCAL_TRANSLATOR_CONFIG.disableThinking === true,
      `Unexpected DEFAULT_LOCAL_TRANSLATOR_CONFIG: ${JSON.stringify(DEFAULT_LOCAL_TRANSLATOR_CONFIG)}`
    );
    assert(
      DEFAULT_OLLAMA_OPTIMIZATION_ENV.OLLAMA_FLASH_ATTENTION === '1' &&
        DEFAULT_OLLAMA_OPTIMIZATION_ENV.OLLAMA_KV_CACHE_TYPE === 'q8_0' &&
        DEFAULT_OLLAMA_OPTIMIZATION_ENV.OLLAMA_CONTEXT_LENGTH === '2048',
      `Unexpected DEFAULT_OLLAMA_OPTIMIZATION_ENV: ${JSON.stringify(DEFAULT_OLLAMA_OPTIMIZATION_ENV)}`
    );

    const builtSpawnEnv = buildOllamaSpawnEnv({
      origin: 'http://127.0.0.1:11434',
      concurrency: 3,
      modelsDir: 'D:\\ollama_models',
      baseEnv: { NO_PROXY: 'corp.local' },
    });
    assert(
      builtSpawnEnv.OLLAMA_NUM_PARALLEL === '3' &&
        builtSpawnEnv.OLLAMA_FLASH_ATTENTION === '1' &&
        builtSpawnEnv.OLLAMA_KV_CACHE_TYPE === 'q8_0' &&
        builtSpawnEnv.OLLAMA_CONTEXT_LENGTH === '2048' &&
        builtSpawnEnv.OLLAMA_HOST === 'http://127.0.0.1:11434' &&
        builtSpawnEnv.OLLAMA_MODELS === 'D:\\ollama_models' &&
        builtSpawnEnv.NO_PROXY === 'corp.local,localhost,127.0.0.1,::1',
      `Unexpected buildOllamaSpawnEnv result: ${JSON.stringify(builtSpawnEnv)}`
    );
    assert(
      buildOllamaSpawnEnv({ origin: 'http://127.0.0.1:11434', concurrency: 99, baseEnv: {} }).OLLAMA_NUM_PARALLEL === '8' &&
        buildOllamaSpawnEnv({ origin: 'http://127.0.0.1:11434', concurrency: 0, baseEnv: {} }).OLLAMA_NUM_PARALLEL === '1',
      'Expected buildOllamaSpawnEnv to clamp concurrency into [1, 8]'
    );

    // Windows env script must be strictly read-only (never mutates user registry via SetEnvironmentVariable)
    const winReadEnvScript = buildWindowsOllamaReadEnvScript();
    const winPersistAlias = buildWindowsOllamaPersistScript();
    assert(
      winReadEnvScript === winPersistAlias &&
        winReadEnvScript.includes('GetEnvironmentVariable("OLLAMA_MODELS", "User")') &&
        winReadEnvScript.includes('GetEnvironmentVariable("NO_PROXY", "User")') &&
        !winReadEnvScript.includes('SetEnvironmentVariable') &&
        !winReadEnvScript.includes('PC_SYNC_'),
      `Windows Ollama env script must be strictly read-only without registry mutation: ${winReadEnvScript}`
    );

    const syncMockNotOllama = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end('Not Found');
    });
    const syncMockOllama = http.createServer((req, res) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.40.16' }));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });
    await new Promise<void>((resolve) => syncMockNotOllama.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => syncMockOllama.listen(0, '127.0.0.1', () => resolve()));
    const nonOllamaPort = (syncMockNotOllama.address() as any).port;
    const mockOllamaPort = (syncMockOllama.address() as any).port;

    let syncService: AgentService | null = null;
    let nonOllamaSvc: AgentService | null = null;
    let autoService: AgentService | null = null;
    try {
      // 25a. detectLocalOllamaOrigin 必须严格识别回环 /api/version 且放行非 Ollama 端点
      const remoteDet = await detectLocalOllamaOrigin('http://192.168.1.50:11434/v1');
      assert(remoteDet.isOllama === false && remoteDet.reason === 'remote_endpoint', `Remote endpoint must be rejected: ${JSON.stringify(remoteDet)}`);

      const notOllamaDet = await detectLocalOllamaOrigin(`http://127.0.0.1:${nonOllamaPort}/v1`);
      assert(notOllamaDet.isOllama === false && notOllamaDet.reason === 'not_ollama', `404 endpoint must not be treated as Ollama: ${JSON.stringify(notOllamaDet)}`);

      const okOllamaDet = await detectLocalOllamaOrigin(`http://127.0.0.1:${mockOllamaPort}/v1`);
      assert(
        okOllamaDet.isOllama === true && okOllamaDet.version === '0.40.16' && okOllamaDet.running === true,
        `Mock /api/version endpoint should be detected as Ollama: ${JSON.stringify(okOllamaDet)}`
      );

      // 25a-2. Non-Ollama loopback endpoint WITHOUT ollamaSyncer stub must NOT leave dangling phase:'restarting' SSE
      nonOllamaSvc = new AgentService(syncWs, { sessionMode: 'persist' });
      const nonOllamaApp = createApiRouter(nonOllamaSvc);
      const nonOllamaSyncEvents: Array<{ phase: string; status?: string }> = [];
      nonOllamaSvc.on('agent_event', (ev: any) => {
        if (ev?.type === 'translator_sync_status') {
          nonOllamaSyncEvents.push(ev.data);
        }
      });
      const nonOllamaSaveRes = await nonOllamaApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local_mt',
          baseUrl: `http://127.0.0.1:${nonOllamaPort}/v1`,
          model: 'local-generic-mt',
        }),
      });
      assert(nonOllamaSaveRes.status === 200, `Expected 200 saving non-Ollama loopback config, got ${nonOllamaSaveRes.status}`);
      const nonOllamaSaveBody = await nonOllamaSaveRes.json();
      assert(
        nonOllamaSaveBody.ollamaSync?.status === 'skipped' &&
          nonOllamaSaveBody.ollamaSync?.reason === 'not_ollama' &&
          !nonOllamaSyncEvents.some((e) => e.phase === 'restarting'),
        `Non-Ollama loopback save must skip without dangling restarting SSE: body=${JSON.stringify(nonOllamaSaveBody)}, events=${JSON.stringify(nonOllamaSyncEvents)}`
      );
      (nonOllamaSvc as any).disposeCurrentSessionState?.(true);
      nonOllamaSvc = null;
      // Clear isolated translator.json so 25b verifies fresh defaults
      fs.rmSync(path.join(process.env.HOME!, '.papercup', 'translator.json'), { force: true });

      // 25b. POST /api/translator/config 并发同步生命周期、syncSeq 单调对齐与失败保底保存
      const syncCalls: OllamaSyncInput[] = [];
      let failNextSync = false;
      syncService = new AgentService(syncWs, {
        sessionMode: 'memory',
        ollamaSyncer: async (input) => {
          syncCalls.push(input);
          if (failNextSync) {
            return {
              attempted: true,
              synced: false,
              status: 'failed',
              concurrency: input.concurrency,
              origin: 'http://127.0.0.1:11434',
              reason: 'restart_timeout',
              message: 'simulated ollama restart failure',
            };
          }
          return {
            attempted: true,
            synced: true,
            status: 'restarted',
            concurrency: input.concurrency,
            origin: 'http://127.0.0.1:11434',
            version: '0.40.16',
            optimizations: {
              flashAttention: true,
              kvCacheType: 'q8_0',
              contextLength: 2048,
            },
            message: `本机 Ollama 已重启，并发=${input.concurrency}（FA=1 / KV=q8_0 / CTX=2048）已生效。`,
          };
        },
      });
      const syncApp = createApiRouter(syncService);
      const syncEvents: Array<{ seq?: number; phase: string; message: string; concurrency?: number }> = [];
      syncService.on('agent_event', (ev: any) => {
        if (ev?.type === 'translator_sync_status') {
          syncEvents.push(ev.data);
        }
      });

      const initialCfgRes = await syncApp.request('/api/translator/config');
      assert(initialCfgRes.status === 200, `Expected 200 on initial GET /api/translator/config, got ${initialCfgRes.status}`);
      const initialCfgBody = await initialCfgRes.json();
      assert(
        initialCfgBody.global?.packetLines === 8 && initialCfgBody.global?.concurrency === 3,
        `Expected fresh default global packetLines=8 and concurrency=3, got ${JSON.stringify(initialCfgBody.global)}`
      );

      const defaultLocalSaveRes = await syncApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local_mt',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'sakura-7b-qwen2.5-v1.0:iq4xs',
        }),
      });
      assert(defaultLocalSaveRes.status === 200, `Expected 200 on default local_mt save, got ${defaultLocalSaveRes.status}`);
      const defaultLocalSaveBody = await defaultLocalSaveRes.json();
      assert(
        syncCalls.length === 1 &&
          syncCalls[0].concurrency === 3 &&
          defaultLocalSaveBody.effective?.packetLines === 8 &&
          defaultLocalSaveBody.effective?.concurrency === 3 &&
          typeof defaultLocalSaveBody.ollamaSync?.syncSeq === 'number',
        `Expected omitted fields to inherit default packetLines=8, concurrency=3 and emit syncSeq: ${JSON.stringify(defaultLocalSaveBody)}`
      );

      const localSaveRes = await syncApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local_mt',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'sakura-7b-qwen2.5-v1.0:iq4xs',
          concurrency: 2,
        }),
      });
      assert(localSaveRes.status === 200, `Expected 200 on local_mt save, got ${localSaveRes.status}`);
      const localSaveBody = await localSaveRes.json();
      const readyEv2 = syncEvents.find((e) => e.phase === 'ready' && e.concurrency === 2);
      assert(
        syncCalls.length === 2 &&
          syncCalls[1].concurrency === 2 &&
          localSaveBody.ollamaSync?.status === 'restarted' &&
          localSaveBody.ollamaSync?.concurrency === 2 &&
          typeof localSaveBody.ollamaSync?.syncSeq === 'number' &&
          localSaveBody.ollamaSync.syncSeq > defaultLocalSaveBody.ollamaSync.syncSeq &&
          readyEv2?.seq === localSaveBody.ollamaSync.syncSeq &&
          syncEvents.some((e) => e.phase === 'restarting' && e.concurrency === 2),
        `Expected restarted sync + monotonically aligned syncSeq SSE lifecycle: body=${JSON.stringify(localSaveBody)}, events=${JSON.stringify(syncEvents)}`
      );

      const cloudSaveRes = await syncApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'cloud_subagent' }),
      });
      const cloudSaveBody = await cloudSaveRes.json();
      assert(
        cloudSaveRes.status === 200 && syncCalls.length === 2 && cloudSaveBody.ollamaSync?.status === 'skipped',
        `cloud_subagent save must skip Ollama restart: ${JSON.stringify(cloudSaveBody)}`
      );

      failNextSync = true;
      const failSaveRes = await syncApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local_mt',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'sakura-7b-qwen2.5-v1.0:iq4xs',
          concurrency: 3,
        }),
      });
      const failSaveBody = await failSaveRes.json();
      assert(
        failSaveRes.status === 200 &&
          failSaveBody.effective?.concurrency === 3 &&
          failSaveBody.ollamaSync?.status === 'failed' &&
          syncEvents[syncEvents.length - 1]?.phase === 'error',
        `Config must still save when sync fails and report error status: ${JSON.stringify(failSaveBody)}`
      );

      // 25c. inspectOllamaBinary 路径校验、pickPreferredLocalModel 非聊天模型过滤与 HTTP 422 chat_template_kwargs 回退
      const binDir = path.join(syncRoot, 'custom-ollama');
      fs.mkdirSync(binDir, { recursive: true });
      const exeName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
      const mockCliBin = path.join(binDir, exeName);
      fs.writeFileSync(mockCliBin, 'stub', 'utf8');
      assert(
        inspectOllamaBinary(mockCliBin).binaryPath === path.resolve(mockCliBin) &&
          inspectOllamaBinary(mockCliBin).source === 'custom',
        'inspectOllamaBinary should accept direct executable path'
      );
      assert(
        inspectOllamaBinary(binDir).binaryPath === path.resolve(mockCliBin) &&
          inspectOllamaBinary(binDir).source === 'custom',
        'inspectOllamaBinary should resolve executable inside chosen directory'
      );
      if (process.platform === 'win32') {
        const trayAppExe = path.join(binDir, 'ollama app.exe');
        fs.writeFileSync(trayAppExe, 'stub-tray', 'utf8');
        assert(
          inspectOllamaBinary(trayAppExe).binaryPath === path.resolve(mockCliBin),
          'inspectOllamaBinary should resolve sibling ollama.exe when user selects ollama app.exe'
        );
      }
      const badCustom = inspectOllamaBinary(path.join(syncRoot, 'missing-ollama.exe'));
      assert(
        badCustom.binaryPath === null && badCustom.invalidCustomPath === true,
        `Nonexistent custom Ollama path must fail inspection clearly: ${JSON.stringify(badCustom)}`
      );

      assert(pickPreferredLocalModel([]) === null, 'Empty model list must yield null suggestedModel');
      assert(
        pickPreferredLocalModel([
          { id: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest' },
          { id: 'bge-reranker-v2-m3', name: 'bge-reranker-v2-m3' },
        ]) === null,
        'pickPreferredLocalModel must return null when only embedding/rerank models exist'
      );
      assert(
        pickPreferredLocalModel([
          { id: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest' },
          { id: 'bge-reranker-v2-m3', name: 'bge-reranker-v2-m3' },
          { id: 'qwen2.5:7b', name: 'qwen2.5:7b' },
        ]) === 'qwen2.5:7b',
        'pickPreferredLocalModel must skip embedding/rerank models and pick chat model'
      );
      assert(
        pickPreferredLocalModel([
          { id: 'qwen2.5:7b', name: 'qwen2.5:7b' },
          { id: 'hy-mt1.5-7b', name: 'hy-mt1.5-7b' },
          { id: 'sakura-7b-qwen2.5-v1.0:iq4xs', name: 'sakura-7b-qwen2.5-v1.0:iq4xs' },
        ]) === 'sakura-7b-qwen2.5-v1.0:iq4xs',
        'pickPreferredLocalModel should prioritize Sakura over generic models'
      );
      assert(
        pickPreferredLocalModel([
          { id: 'qwen2.5:7b', name: 'qwen2.5:7b' },
          { id: 'hy-mt1.5-7b', name: 'hy-mt1.5-7b' },
        ]) === 'hy-mt1.5-7b',
        'pickPreferredLocalModel should prioritize HY-MT when Sakura is absent'
      );

      // HTTP 422 rejecting chat_template_kwargs must transparently retry without it & remember rejection
      const kwargsSentFlags: boolean[] = [];
      const fallback422Client = new LocalTranslatorClient(
        {
          ...DEFAULT_LOCAL_TRANSLATOR_CONFIG,
          mode: 'local_mt',
          baseUrl: 'http://127.0.0.1:18080/v1',
          model: 'strict-vllm-mt',
          preset: 'sakura',
          disableThinking: true,
        },
        async (_url, init) => {
          const parsed = JSON.parse(String(init?.body || '{}'));
          const hasKwargs = parsed.chat_template_kwargs !== undefined;
          kwargsSentFlags.push(hasKwargs);
          if (hasKwargs) {
            return new Response(
              JSON.stringify({ detail: [{ type: 'extra_forbidden', loc: ['body', 'chat_template_kwargs'] }] }),
              { status: 422, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-422-ok',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: '早上好。' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      );
      const fallbackPacket = {
        schema: 1 as const,
        batchId: 'b422',
        packetId: 'p422',
        track: 'scenario' as const,
        context: {
          sourceLang: 'ja',
          targetLang: 'zh-CN',
          narrativePov: 'first',
          glossarySlice: {},
          speakerHints: {},
          prevContext: [],
        },
        units: [
          {
            id: 'u422#1',
            track: 'scenario' as const,
            file: 's.ks',
            line: 1,
            scene: 's',
            speaker: '',
            kind: 'say',
            originalSource: 'おはよう。',
            envelope: { leadingControls: '', openingQuote: '', closingQuote: '', trailingControls: '' },
            cleanSource: 'おはよう。',
            inlineTokens: [],
            route: 'pending' as const,
          },
        ],
      };
      const fbRes1 = await fallback422Client.translatePacketWithBinarySplit(fallbackPacket);
      const fbRes2 = await fallback422Client.translatePacketWithBinarySplit({ ...fallbackPacket, packetId: 'p422-2' });
      assert(
        fbRes1.targets[0] === '早上好。' &&
          fbRes2.targets[0] === '早上好。' &&
          kwargsSentFlags.length === 3 &&
          kwargsSentFlags[0] === true &&
          kwargsSentFlags[1] === false &&
          kwargsSentFlags[2] === false,
        `Expected HTTP 422 chat_template_kwargs retry + sticky fallback, got flags=${JSON.stringify(kwargsSentFlags)}, res1=${JSON.stringify(fbRes1)}`
      );

      // 25d-25f. 文件选择器、状态探测、探针自动拉起以及翻译前自动拉起（全离线 Stub）
      const autoRoot = path.join(syncRoot, 'auto-ws');
      fs.mkdirSync(path.join(autoRoot, '.papercup', 'data', 'build'), { recursive: true });
      fs.mkdirSync(path.join(autoRoot, '.papercup', 'tmp', 'work', 'batches'), { recursive: true });
      fs.mkdirSync(path.join(autoRoot, '.papercup', 'tmp', 'work', 'out'), { recursive: true });
      fs.writeFileSync(
        path.join(autoRoot, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh"\n',
        'utf8'
      );
      const autoRow = {
        id: 'a1.ks#1',
        file: 'a1.ks',
        line: 1,
        scene: 's1',
        speaker: '',
        kind: 'say',
        source: 'おはようございます。',
        track: 'scenario',
      };
      fs.writeFileSync(path.join(autoRoot, '.papercup', 'data', 'build', 'scenario.jsonl'), JSON.stringify(autoRow) + '\n', 'utf8');
      fs.writeFileSync(path.join(autoRoot, '.papercup', 'tmp', 'work', 'batches', 'batch_000.jsonl'), JSON.stringify(autoRow) + '\n', 'utf8');
      fs.writeFileSync(
        path.join(autoRoot, '.papercup', 'tmp', 'work', 'batches', 'manifest.json'),
        JSON.stringify(
          {
            schema: 1,
            batches: [
              {
                batch_id: 'batch_000',
                file: '.papercup/tmp/work/batches/batch_000.jsonl',
                track: 'scenario',
                rows: 1,
                estimated_source_tokens: 20,
                estimated_tokens_with_margin: 30,
                ids: [autoRow.id],
              },
            ],
          },
          null,
          2
        ),
        'utf8'
      );

      let mockOllamaUp = false;
      let mockInstalledModels: string[] = ['sakura-7b-qwen2.5-v1.0:iq4xs', 'llama3:8b'];
      let failStartSync = false;
      let localChatCalls = 0;
      const autoSyncCalls: OllamaSyncInput[] = [];

      const mockLocalFetch: typeof fetch = async (inputUrl, init) => {
        const url = String(inputUrl);
        if (!mockOllamaUp) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
        }
        if (url.endsWith('/api/version')) {
          return new Response(JSON.stringify({ version: '0.40.16' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: mockInstalledModels.map((m) => ({ name: m, model: m })),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/v1/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: mockInstalledModels.map((id) => ({ id, object: 'model' })),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/v1/chat/completions') && init?.method === 'POST') {
          localChatCalls++;
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-auto-1',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: '早上好。' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not found', { status: 404 });
      };

      autoService = new AgentService(autoRoot, {
        sessionMode: 'memory',
        filePicker: async () => ({ canceled: false, path: mockCliBin }),
        localTranslatorFetch: mockLocalFetch,
        ollamaSyncer: async (input) => {
          autoSyncCalls.push(input);
          if (failStartSync) {
            return {
              attempted: true,
              synced: false,
              status: 'failed',
              concurrency: input.concurrency,
              origin: 'http://127.0.0.1:11434',
              reason: 'binary_not_found',
              message: '未在本机找到 ollama 可执行文件，请点击浏览选择。',
            };
          }
          mockOllamaUp = true;
          return {
            attempted: true,
            synced: true,
            status: 'started',
            concurrency: input.concurrency,
            origin: 'http://127.0.0.1:11434',
            version: '0.40.16',
            managedByPaperCup: true,
            binaryPath: input.ollamaPath || mockCliBin,
            optimizations: { flashAttention: true, kvCacheType: 'q8_0', contextLength: 2048 },
            message: `本机 Ollama 已在后台自动启动（由 Paper Cup 托管运行），并发=${input.concurrency}。`,
          };
        },
      });
      await autoService.initSession();
      const autoSession = (autoService as any).currentSession;
      const autoFaux = createFauxCore({ tokensPerSecond: 10000 });
      autoSession.agent.state.model = autoFaux.getModel();
      autoSession.agent.streamFunction = autoFaux.streamSimple;
      autoSession._modelRuntime.hasConfiguredAuth = () => true;
      const autoApp = createApiRouter(autoService);

      // 25d-1: 文件选择器
      const pickRes = await autoApp.request('/api/translator/ollama/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert(pickRes.status === 200, `Expected 200 from /api/translator/ollama/pick, got ${pickRes.status}`);
      const pickBody = await pickRes.json();
      assert(pickBody.canceled === false && pickBody.path === mockCliBin, `Unexpected pick body: ${JSON.stringify(pickBody)}`);

      // 25d-2: 探测模型在 Ollama 未启动时自动拉起并返回推荐模型
      const probeAutoRes = await autoApp.request('/api/translator/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'http://127.0.0.1:11434/v1',
          ollamaPath: mockCliBin,
          concurrency: 3,
        }),
      });
      assert(probeAutoRes.status === 200, `Expected 200 from auto-start probe, got ${probeAutoRes.status}`);
      const probeAutoBody = await probeAutoRes.json();
      assert(
        probeAutoBody.ok === true &&
          probeAutoBody.ollamaAutoStarted === true &&
          probeAutoBody.ollamaManaged === true &&
          probeAutoBody.suggestedModel === 'sakura-7b-qwen2.5-v1.0:iq4xs' &&
          autoSyncCalls.length === 1 &&
          autoSyncCalls[0].forceRestart === false &&
          autoSyncCalls[0].ollamaPath === mockCliBin,
        `Expected probe to auto-start Ollama and pick Sakura model: ${JSON.stringify(probeAutoBody)}`
      );

      // 25d-3: 无本地模型时 /status 与 /start 必须明确返回 suggestedModel=null 与空列表供前端提示
      mockInstalledModels = [];
      const statusEmptyRes = await autoApp.request(
        `/api/translator/ollama/status?baseUrl=${encodeURIComponent('http://127.0.0.1:11434/v1')}&ollamaPath=${encodeURIComponent(mockCliBin)}`
      );
      const statusEmptyBody = await statusEmptyRes.json();
      assert(
        statusEmptyRes.status === 200 &&
          statusEmptyBody.running === true &&
          statusEmptyBody.binarySource === 'custom' &&
          Array.isArray(statusEmptyBody.models) &&
          statusEmptyBody.models.length === 0 &&
          statusEmptyBody.suggestedModel === null,
        `Unexpected empty-models status response: ${JSON.stringify(statusEmptyBody)}`
      );

      // 25e: POST /api/translator/ollama/start 显式启动
      mockInstalledModels = ['sakura-7b-qwen2.5-v1.0:iq4xs'];
      mockOllamaUp = false;
      const explicitStartRes = await autoApp.request('/api/translator/ollama/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'http://127.0.0.1:11434/v1',
          ollamaPath: mockCliBin,
          concurrency: 3,
          forceRestart: false,
        }),
      });
      const explicitStartBody = await explicitStartRes.json();
      assert(
        explicitStartRes.status === 200 &&
          explicitStartBody.ok === true &&
          explicitStartBody.ollamaSync?.status === 'started' &&
          explicitStartBody.suggestedModel === 'sakura-7b-qwen2.5-v1.0:iq4xs',
        `Unexpected /api/translator/ollama/start body: ${JSON.stringify(explicitStartBody)}`
      );

      // 25f: vn_translate_batches 翻译前自动拉起与缺失二进制 Fail-Fast
      await autoApp.request('/api/translator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local_mt',
          baseUrl: 'http://127.0.0.1:11434/v1',
          ollamaPath: mockCliBin,
          model: 'sakura-7b-qwen2.5-v1.0:iq4xs',
          concurrency: 3,
        }),
      });

      mockOllamaUp = false;
      failStartSync = true;
      autoFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { batchIds: ['batch_000'], checkpointInterval: 0 }, { id: 'tc-auto-fail' })]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-auto-fail') as any;
          assert(tr?.isError === true, 'Batch translation must fail-fast when pre-flight Ollama start fails');
          return fauxAssistantMessage('启动失败已中止。');
        },
      ]);
      await autoService.executeTurn('验证翻译前 Ollama 拉起失败中止');
      assert(localChatCalls === 0, `Local chat should not run when pre-flight start failed (${localChatCalls})`);

      failStartSync = false;
      autoFaux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_translate_batches', { batchIds: ['batch_000'], checkpointInterval: 0 }, { id: 'tc-auto-ok' })]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-auto-ok') as any;
          assert(tr?.isError !== true && tr?.details?.ok === true, `Expected pre-flight auto-started batch success: ${JSON.stringify(tr)}`);
          return fauxAssistantMessage('自动拉起并完成本地翻译。');
        },
      ]);
      await autoService.executeTurn('验证翻译前自动拉起本地 Ollama 并翻译');
      assert(localChatCalls === 1, `Expected 1 local chat completion call after pre-flight auto-start, got ${localChatCalls}`);

      const engWithRuntime = await autoService.getEngineeringStatus({ forceRefresh: true });
      assert(
        engWithRuntime.translator?.mode === 'local_mt' &&
          engWithRuntime.translator?.ollamaRunning === true &&
          engWithRuntime.translator?.ollamaManaged === true &&
          engWithRuntime.translator?.concurrency === 3,
        `Engineering status should expose live Ollama runtime flags: ${JSON.stringify(engWithRuntime.translator)}`
      );
    } finally {
      (autoService as any)?.disposeCurrentSessionState?.(true);
      (nonOllamaSvc as any)?.disposeCurrentSessionState?.(true);
      (syncService as any)?.disposeCurrentSessionState?.(true);
      try {
        syncMockNotOllama.close();
      } catch {
        // Ignore
      }
      try {
        syncMockOllama.close();
      } catch {
        // Ignore
      }
    }
  });

  // 26. 沙箱边界、Host 包管理拦截、narrative_pov="source"、Reverser 预算/Pivot 熔断与持久化计数、提取契约、Direct/多归档流水线全闭环
  console.log('26. Verifying workspace sandbox, host mutation guards, source POV, reverser pivot/budget stops, extract contract, and direct/multi-archive pipelines...');
  await withIsolatedHomeAndEnv('papercup-s26-', async ({ root: root26, home: home26 }) => {
    // 26a: write/edit 工作区沙箱越界、Windows 尾部带点路径 & bash 宿主机包管理拦截
    const ws26a = path.join(root26, 'ws26a');
    fs.mkdirSync(ws26a, { recursive: true });
    fs.writeFileSync(path.join(ws26a, 'in_ws.txt'), 'ok\n', 'utf8');
    const guardedTools26 = createGuardedBuiltinToolDefinitions(ws26a, ['read', 'write', 'edit', 'bash'], {
      bashPath: config.bashPath,
    });
    const writeTool26 = guardedTools26.find((t) => t.name === 'write')!;
    const editTool26 = guardedTools26.find((t) => t.name === 'edit')!;
    const bashTool26 = guardedTools26.find((t) => t.name === 'bash')!;

    const outsideTarget = path.join(root26, 'outside_escape.txt');
    const wEsc = await (writeTool26.execute as any)('t26-w1', { path: '../outside_escape.txt', content: 'bad' });
    assert(wEsc.isError === true && !fs.existsSync(outsideTarget), `write outside workspace must be blocked: ${JSON.stringify(wEsc)}`);
    const eEsc = await (editTool26.execute as any)('t26-e1', {
      path: outsideTarget,
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    assert(eEsc.isError === true, `edit outside workspace must be blocked: ${JSON.stringify(eEsc)}`);

    if (process.platform === 'win32') {
      const wDot = await (writeTool26.execute as any)('t26-wdot', { path: 'ghost../evil.txt', content: 'bad' });
      assert(wDot.isError === true, `Windows trailing-dot directory segment must be blocked: ${JSON.stringify(wDot)}`);
    }

    for (const blockedCmd of [
      'pip install capstone',
      'python -m pip install requests',
      'npm install lodash',
      'grep -rl "vn_learn_skill" /c/Users/demo/Python312/Lib/site-packages/*/',
      'find /usr/local/lib/node_modules -name "*.js"',
    ]) {
      const bRes = await (bashTool26.execute as any)('t26-b', { command: blockedCmd });
      assert(
        bRes.isError === true && String(bRes.content?.[0]?.text || '').includes('prohibited'),
        `bash command "${blockedCmd}" should be blocked, got: ${JSON.stringify(bRes)}`
      );
    }
    const allowedWsBash = await (bashTool26.execute as any)('t26-ok-ls', { command: 'ls in_ws.txt && echo workspace_ok' });
    assert(
      allowedWsBash.isError !== true && String(allowedWsBash.content?.[0]?.text || '').includes('workspace_ok'),
      `Workspace-local ls/echo should NOT be blocked: ${JSON.stringify(allowedWsBash)}`
    );

    // 26b: narrative_pov = "source" + main_bash_timeout_sec & reverser 默认/覆写阈值
    const defaultResearch26 = readVnResearchConfig(ws26a);
    assert(
      defaultResearch26.mainBashTimeoutSec === 90 &&
        defaultResearch26.hardStopConsecutiveFailures === 0 &&
        defaultResearch26.maxReverserToolCalls === 0 &&
        defaultResearch26.maxReverserDurationMs === 60 * 60 * 1000 &&
        defaultResearch26.maxReverserStallCalls === 0,
      `Unexpected default VnResearchConfig: ${JSON.stringify(defaultResearch26)}`
    );
    fs.writeFileSync(
      path.join(ws26a, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n\n[vn.research]\nmain_bash_timeout_sec = 45\nmax_reverser_stall_calls = 7\n',
      'utf8'
    );
    const overrideResearch26 = readVnResearchConfig(ws26a);
    assert(
      overrideResearch26.mainBashTimeoutSec === 45 && overrideResearch26.maxReverserStallCalls === 7,
      `Expected papercup.toml [vn.research] overrides, got ${JSON.stringify(overrideResearch26)}`
    );
    const loadedSrcPov = loadProfile(ws26a);
    assert(
      loadedSrcPov.configured && loadedSrcPov.errors.length === 0 && loadedSrcPov.profile?.narrativePov === 'source',
      `Expected narrative_pov="source" to be valid, got: ${JSON.stringify(loadedSrcPov)}`
    );
    const statusSrcPov = getVnStatus(ws26a);
    assert(statusSrcPov.includes('状态：就绪') && statusSrcPov.includes('叙事视角：source'), `Unexpected vn_status: ${statusSrcPov}`);

    // 26c: Reverser Pivot 不被琐碎命令清零 + 5 次硬熔断 + 工具次数上限熔断 + 持久化计数准确非零
    const ws26c = path.join(root26, 'ws26c');
    fs.mkdirSync(ws26c, { recursive: true });
    fs.writeFileSync(
      path.join(ws26c, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n\n[vn.research]\nmax_consecutive_failures = 3\nhard_stop_consecutive_failures = 5\nmax_reverser_tool_calls = 20\n',
      'utf8'
    );
    const svc26c = new AgentService(ws26c, { sessionMode: 'persist' });
    await svc26c.initSession();
    try {
      const mainFaux26c = createFauxCore({ tokensPerSecond: 10000 });
      const subFaux26c = createFauxCore({ tokensPerSecond: 10000 });
      const mainSess26c = (svc26c as any).currentSession;
      mainSess26c.agent.state.model = mainFaux26c.getModel();
      mainSess26c.agent.streamFunction = mainFaux26c.streamSimple;
      mainSess26c._modelRuntime.hasConfiguredAuth = () => true;
      const subMgr26c = (svc26c as any).subagentManager as SubagentManager;
      const origCreate26c = subMgr26c.createSubagentSession.bind(subMgr26c);
      let createCalls26c = 0;
      subMgr26c.createSubagentSession = async (roleName, opts) => {
        createCalls26c += 1;
        const res = await origCreate26c(roleName, opts);
        (res.session as any).agent.state.model = subFaux26c.getModel();
        (res.session as any).agent.streamFunction = subFaux26c.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      subFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'echo fail1; exit 1' }, { id: 'tc-26c-f1' })]),
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'ls -la' }, { id: 'tc-26c-ls' })]),
        () => fauxAssistantMessage([fauxToolCall('write', { path: '.papercup/tmp/probe1.py', content: 'print(1)\n' }, { id: 'tc-26c-w' })]),
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'echo fail2; exit 1' }, { id: 'tc-26c-f2' })]),
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'echo inspect_only' }, { id: 'tc-26c-echo' })]),
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'echo fail3; exit 1' }, { id: 'tc-26c-f3' })]),
        (ctx) => {
          const f3 = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-f3') as any;
          assert(
            String(f3?.content?.[0]?.text || '').includes('[换路提醒 / PIVOT REQUIRED]'),
            `Trivial ls/write/echo must NOT reset failure counter before 3rd fail: ${JSON.stringify(f3)}`
          );
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo fail4; exit 1' }, { id: 'tc-26c-f4' })]);
        },
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'echo fail5; exit 1' }, { id: 'tc-26c-f5' })]),
        () => fauxAssistantMessage('should be aborted by hard stop'),
      ]);
      let hardStopResultText = '';
      mainFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Test pivot hard stop' }, { id: 'tc-26c-main-1' })]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-main-1') as any;
          assert(tr?.isError === true, `5th consecutive failure must hard-stop reverser: ${JSON.stringify(tr)}`);
          hardStopResultText = String(tr?.content?.[0]?.text || '');
          assert(hardStopResultText.includes('硬熔断阈值'), `Expected hard-stop message, got: ${hardStopResultText}`);
          return fauxAssistantMessage('已收到硬熔断报告。');
        },
      ]);
      await svc26c.executeTurn('测试连续失败硬熔断');

      const tasksDir26c = path.join(ws26c, '.papercup', 'tmp', 'diagnostics', 'subagent-tasks');
      const taskFiles26c = fs.readdirSync(tasksDir26c).filter((f) => f.endsWith('.json')).sort();
      assert(taskFiles26c.length === 1, `Expected 1 persisted task json, got ${taskFiles26c.length}`);
      const snap1 = JSON.parse(fs.readFileSync(path.join(tasksDir26c, taskFiles26c[0]), 'utf8'));
      assert(
        snap1.status === 'aborted' &&
          snap1.toolCallCount === 8 &&
          snap1.errorCount === 5 &&
          snap1.artifactsCount === 1 &&
          snap1.pivotWarningCount >= 3,
        `Persisted snapshot counters must reflect real counts, got: ${JSON.stringify({
          status: snap1.status,
          toolCallCount: snap1.toolCallCount,
          errorCount: snap1.errorCount,
          artifactsCount: snap1.artifactsCount,
          pivotWarningCount: snap1.pivotWarningCount,
        })}`
      );

      // 预算上限测试: max_reverser_tool_calls = 4
      fs.writeFileSync(
        path.join(ws26c, 'papercup.toml'),
        '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n\n[vn.research]\nmax_reverser_tool_calls = 4\n',
        'utf8'
      );
      subFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-b1' })]),
        (ctx) => {
          const b1 = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-b1') as any;
          assert(String(b1?.content?.[0]?.text || '').includes('[预算提醒]'), `Expected budget warning when 3 calls remain: ${JSON.stringify(b1)}`);
          return fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-b2' })]);
        },
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-b3' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-b4' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-b5' })]),
        () => fauxAssistantMessage('should not reach after budget abort'),
      ]);
      mainFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Test tool budget' }, { id: 'tc-26c-main-2' })]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-main-2') as any;
          const txt = String(tr?.content?.[0]?.text || '');
          assert(tr?.isError === true && txt.includes('单轮工具调用上限'), `Expected tool budget abort, got: ${txt}`);
          return fauxAssistantMessage('已收到工具上限报告。');
        },
      ]);
      await svc26c.executeTurn('测试调用次数上限熔断');

      // 阶梯预算提醒测试: max_reverser_tool_calls = 10 -> 第 5 次(50%) / 第 7 次(剩3) / 第 8 次(剩2)
      fs.writeFileSync(
        path.join(ws26c, 'papercup.toml'),
        '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n\n[vn.research]\nmax_reverser_tool_calls = 10\n',
        'utf8'
      );
      const tieredObservations: Record<number, string> = {};
      const tieredCalls: Array<() => any> = [];
      for (let step = 1; step <= 11; step++) {
        const prevCallIdx = step - 1;
        tieredCalls.push((ctx?: any) => {
          if (prevCallIdx >= 1 && ctx?.messages) {
            const prevRes = ctx.messages.find((m: any) => m.role === 'toolResult' && m.toolCallId === `tc-26c-t${prevCallIdx}`);
            tieredObservations[prevCallIdx] = String(prevRes?.content?.[0]?.text || '');
          }
          return fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: `tc-26c-t${step}` })]);
        });
      }
      tieredCalls.push(() => fauxAssistantMessage('should not reach after 10-call budget abort'));
      subFaux26c.setResponses(tieredCalls);
      mainFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Test tiered budget notices' }, { id: 'tc-26c-main-3' })]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-main-3') as any;
          const txt = String(tr?.content?.[0]?.text || '');
          assert(tr?.isError === true && txt.includes('单轮工具调用上限（10 次）'), `Expected 10-call budget abort, got: ${txt}`);
          return fauxAssistantMessage('已收到 10 次上限阶梯预算测试结果。');
        },
      ]);
      await svc26c.executeTurn('测试阶梯预算提醒');
      assert(
        tieredObservations[5]?.includes('[预算提醒]') && tieredObservations[5]?.includes('已用过半'),
        `Expected 50% budget warning on call 5/10, got: ${tieredObservations[5]}`
      );
      assert(
        tieredObservations[7]?.includes('[预算提醒]') && tieredObservations[7]?.includes('7/10'),
        `Expected 7/10 budget warning on call 7/10, got: ${tieredObservations[7]}`
      );
      assert(
        tieredObservations[8]?.includes('[预算提醒]') && tieredObservations[8]?.includes('8/10') && tieredObservations[8]?.includes('仅剩 2 次'),
        `Expected 8/10 (remaining 2) budget warning on call 8/10, got: ${tieredObservations[8]}`
      );
      assert(
        BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('heredoc') &&
          BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('PIVOT REQUIRED') &&
          BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('row["target"]') &&
          BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('half-width katakana') &&
          BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('lookup keys') &&
          PAPERCUP_SYSTEM_PROMPT.includes('harness') &&
          PAPERCUP_SYSTEM_PROMPT.includes('vn_promote_skill') &&
          PAPERCUP_SYSTEM_PROMPT.includes('全局依赖目录') &&
          PAPERCUP_SYSTEM_PROMPT.includes('resumeTaskId'),
        'Updated system prompts missing required generic reverser/main-agent guardrail clauses'
      );

      // 无进展停滞熔断测试: max_reverser_stall_calls = 6 (写文件重置计数后再连续 6 次纯读/ls 触发熔断)
      fs.writeFileSync(
        path.join(ws26c, 'papercup.toml'),
        '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n\n[vn.research]\nmax_reverser_tool_calls = 20\nmax_reverser_stall_calls = 6\n',
        'utf8'
      );
      let sawStallWarning = false;
      const stallCalls: Array<(ctx?: any) => any> = [
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st1' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st2' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st3' })]),
        (ctx) => {
          const r3 = ctx.messages.find((m: any) => m.role === 'toolResult' && m.toolCallId === 'tc-26c-st3');
          sawStallWarning = String(r3?.content?.[0]?.text || '').includes('[停滞提醒]');
          return fauxAssistantMessage([
            fauxToolCall('write', { path: '.papercup/tmp/stall_reset.py', content: 'print("progress")\n' }, { id: 'tc-26c-stw' }),
          ]);
        },
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st4' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st5' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st6' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st7' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st8' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-st9' })]),
        () => fauxAssistantMessage('should not reach after stall stop'),
      ];
      subFaux26c.setResponses(stallCalls);
      let stallStopDetails: any = null;
      let stallStopText = '';
      mainFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Test stall stop' }, { id: 'tc-26c-main-stall' })]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-main-stall') as any;
          stallStopDetails = tr?.details ?? null;
          stallStopText = String(tr?.content?.[0]?.text || '');
          assert(tr?.isError === true, `Expected stall stop error result, got: ${JSON.stringify(tr)}`);
          return fauxAssistantMessage('已收到停滞熔断通知。');
        },
      ]);
      await svc26c.executeTurn('测试无进展停滞熔断');
      assert(sawStallWarning, 'Expected [停滞提醒] after 3 stall calls before write reset');
      assert(
        stallStopText.includes('停滞熔断') &&
          stallStopText.includes('resumable=true') &&
          stallStopDetails?.resumable === true &&
          typeof stallStopDetails?.resumeTaskId === 'string',
        `Expected resumable stall stop metadata, got: ${stallStopText}`
      );

      // resumeTaskId 热缓存续跑测试（预算中止后续跑复用同会话 + 历史保留 + 全新预算 + 过期回退）
      fs.writeFileSync(
        path.join(ws26c, 'papercup.toml'),
        '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n\n[vn.research]\nmax_reverser_tool_calls = 4\nmax_reverser_stall_calls = 15\n',
        'utf8'
      );
      createCalls26c = 0;
      subFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-r1-1' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-r1-2' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-r1-3' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-r1-4' })]),
        () => fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-r1-5' })]),
        () => fauxAssistantMessage('should abort at call 5 before text'),
      ]);
      let resumeId1 = '';
      mainFaux26c.setResponses([
        () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'reverser', task: 'Stage 0 probe task-alpha' }, { id: 'tc-26c-m-r1' })]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-m-r1') as any;
          assert(
            tr?.isError === true && tr?.details?.resumable === true && typeof tr?.details?.resumeTaskId === 'string',
            `Turn 1 reverser should pause resumably, got: ${JSON.stringify(tr)}`
          );
          resumeId1 = tr.details.resumeTaskId;
          return fauxAssistantMessage('暂存恢复点');
        },
      ]);
      await svc26c.executeTurn('第 1 轮热缓存准备');
      assert(createCalls26c === 1 && resumeId1.length > 0, `Expected 1 session created and valid resumeId1, got ${createCalls26c}`);

      // Turn 2: 传入 resumeTaskId 热缓存续跑，不新建会话，且可访问 Turn 1 历史上下文与全新 4 次预算
      let turn2SawTurn1History: boolean = false;
      let turn2Res: any = null;
      subFaux26c.setResponses([
        (ctx) => {
          turn2SawTurn1History = JSON.stringify(ctx.messages).includes('Stage 0 probe task-alpha');
          return fauxAssistantMessage([fauxToolCall('ls', { path: '.' }, { id: 'tc-26c-r2-1' })]);
        },
        () => fauxAssistantMessage('已完成剩余收尾并打包就绪。'),
      ]);
      mainFaux26c.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall('delegate_task', { role: 'reverser', resumeTaskId: resumeId1, task: '继续完成最后一步' }, { id: 'tc-26c-m-r2' }),
          ]),
        (ctx) => {
          turn2Res = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-m-r2') ?? null;
          return fauxAssistantMessage('已通过热缓存续跑完成。');
        },
      ]);
      await svc26c.executeTurn('第 2 轮传入 resumeTaskId 续跑');
      assert(
        createCalls26c === 1 &&
          Boolean(turn2SawTurn1History) &&
          turn2Res?.isError !== true &&
          turn2Res?.details?.resumed === true &&
          turn2Res?.details?.resumedFromTaskId === resumeId1 &&
          turn2Res?.details?.resumeFallback === false &&
          turn2Res?.details?.resumable === true &&
          String(turn2Res?.content?.[0]?.text || '').includes('[reverser_session'),
        `Expected warm-cache reuse without recreating session, got createCalls=${createCalls26c}, hist=${turn2SawTurn1History}, res=${JSON.stringify(turn2Res)}`
      );

      // Turn 3: 失效/未知 resumeTaskId 优雅降级为新会话并前置提醒
      let turn3SawFallbackNote: boolean = false;
      let turn3Res: any = null;
      subFaux26c.setResponses([
        (ctx) => {
          turn3SawFallbackNote = JSON.stringify(ctx.messages).includes('subtask-reverser-expired-999 expired');
          return fauxAssistantMessage('已在新会话接续完成。');
        },
      ]);
      mainFaux26c.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'delegate_task',
              { role: 'reverser', resumeTaskId: 'subtask-reverser-expired-999', task: '降级检查并完成' },
              { id: 'tc-26c-m-r3' }
            ),
          ]),
        (ctx) => {
          turn3Res = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-26c-m-r3') ?? null;
          return fauxAssistantMessage('降级续跑完成。');
        },
      ]);
      await svc26c.executeTurn('第 3 轮验证失效 resumeTaskId 优雅降级');
      assert(
        createCalls26c === 2 &&
          Boolean(turn3SawFallbackNote) &&
          turn3Res?.isError !== true &&
          turn3Res?.details?.resumed === false &&
          turn3Res?.details?.resumeFallback === true,
        `Expected graceful fallback for expired resumeTaskId, got createCalls=${createCalls26c}, note=${turn3SawFallbackNote}, res=${JSON.stringify(turn3Res)}`
      );
    } finally {
      (svc26c as any).disposeCurrentSessionState?.(true);
    }

    // 26d: parseExtractOutputJsonl 拆分精准报错 + scenario/ui 别名归一化
    const dir26d = path.join(root26, 'ws26d');
    fs.mkdirSync(dir26d, { recursive: true });
    fs.writeFileSync(path.join(dir26d, 'a.bin'), 'x', 'utf8');
    const expectExtractErr = (jsonlContent: string, expectedSubstr: string) => {
      const p = path.join(dir26d, 'bad.jsonl');
      fs.writeFileSync(p, jsonlContent + '\n', 'utf8');
      let errMsg = '';
      try {
        parseExtractOutputJsonl(p, dir26d, new Set());
      } catch (err: any) {
        errMsg = String(err?.message || err);
      }
      assert(errMsg.includes(expectedSubstr), `Expected parseExtractOutputJsonl error "${expectedSubstr}", got: "${errMsg}"`);
    };
    expectExtractErr(JSON.stringify({ id: '1', file: 'a.bin', offset: 12, source: 'こんにちは' }), 'line');
    expectExtractErr(JSON.stringify({ id: '1', file: 'a.bin', line: 1, source: '   ' }), 'source');
    expectExtractErr(JSON.stringify({ id: '1', file: 'a.bin', line: 1, source: 'a\nb' }), '换行');
    expectExtractErr(JSON.stringify({ id: '1', file: 'a.bin', line: 1, kind: 'invalid_kind', source: 'こんにちは' }), 'kind=');

    const goodExtractPath = path.join(dir26d, 'good.jsonl');
    fs.writeFileSync(
      goodExtractPath,
      [
        JSON.stringify({ id: 's1', file: 'a.bin', line: 1, kind: 'scenario', source: '「おはよう」' }),
        JSON.stringify({ id: 'u1', file: 'a.bin', line: 2, kind: 'ui', source: 'セーブ' }),
        JSON.stringify({ id: 'u2', file: 'a.bin', line: 3, source: 'ロード' }),
      ].join('\n') + '\n',
      'utf8'
    );
    const parsed26d = parseExtractOutputJsonl(goodExtractPath, dir26d, new Set());
    assert(
      parsed26d.length === 3 &&
        parsed26d[0].kind === 'say' &&
        parsed26d[1].kind === 'system' &&
        parsed26d[2].kind === 'system',
      `Expected scenario->say and ui->system normalization, got: ${JSON.stringify(parsed26d)}`
    );

    // 26e: pipeline="direct" 单文件二进制剧本端到端闭环（含大媒体存根跳过 + 忽略 Version.txt + 默认 CP932->GBK 策略与 UTF-8 覆盖 + vn_accept + vn_release）
    const ws26e = path.join(root26, 'ws26e');
    const game26e = path.join(ws26e, 'game');
    fs.mkdirSync(path.join(ws26e, '.papercup', 'tmp'), { recursive: true });
    fs.mkdirSync(game26e, { recursive: true });
    fs.writeFileSync(
      path.join(ws26e, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n',
      'utf8'
    );
    const origAinBuf = execFileSync(
      config.pythonPath,
      [
        '-c',
        'import json,sys; sys.stdout.buffer.write(json.dumps({"msg":["\\u300c\\u304a\\u306f\\u3088\\u3046\\u300d","\\u300c\\u4eca\\u65e5\\u306f\\u3044\\u3044\\u5929\\u6c17\\u3060\\u306d\\u300d"],"str":["\\u30bb\\u30fc\\u30d6","Version.asd"]}, ensure_ascii=False, separators=(",",":")).encode("cp932"))',
      ],
      { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }
    );
    const ainPath26e = path.join(game26e, 'script.ain');
    fs.writeFileSync(ainPath26e, origAinBuf);
    fs.writeFileSync(path.join(game26e, 'Version.txt'), '1.01\n', 'utf8');
    fs.writeFileSync(path.join(game26e, 'media.alm'), Buffer.alloc(1500 * 1024, 0xaa)); // >1 MiB heavy media

    const directExtractPy = [
      'import json, os, sys',
      'root, out_path = sys.argv[1], sys.argv[2]',
      'ain = os.path.join(root, "script.ain")',
      'data = json.loads(open(ain, "rb").read().decode("cp932"))',
      'rows = []',
      'ln = 0',
      'for i, s in enumerate(data["msg"]):',
      '    ln += 1',
      '    rows.append({"id": f"msg:{i}", "file": "script.ain", "line": ln, "kind": "say", "source": s})',
      'for i, s in enumerate(data["str"]):',
      '    if s.endswith(".asd"): continue',
      '    ln += 1',
      '    rows.append({"id": f"str:{i}", "file": "script.ain", "line": ln, "kind": "system", "source": s})',
      'with open(out_path, "w", encoding="utf-8") as f:',
      '    for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\\n")',
      '',
    ].join('\n');
    const directApplyPy = [
      'import json, os, sys',
      'res_path, root = sys.argv[1], sys.argv[2]',
      'enc = os.environ.get("PAPERCUP_TARGET_ENCODING") or "cp932"',
      'ain = os.path.join(root, "script.ain")',
      'data = json.loads(open(ain, "rb").read().decode("cp932"))',
      'for line in open(res_path, "r", encoding="utf-8"):',
      '    if not line.strip(): continue',
      '    r = json.loads(line)',
      '    sec, idx = r["id"].split(":", 1)',
      '    val = r.get("target", r["source"])',
      '    val.encode(enc)',
      '    data[sec][int(idx)] = val',
      'with open(ain, "wb") as f:',
      '    f.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(enc))',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(ws26e, '.papercup', 'tmp', 'extract.py'), directExtractPy, 'utf8');
    fs.writeFileSync(path.join(ws26e, '.papercup', 'tmp', 'apply.py'), directApplyPy, 'utf8');

    const learnDirectRes = await learnVnSkill(ws26e, {
      engine: 'sys42test',
      pipeline: 'direct',
      unpackedDir: 'game',
      extractScript: '.papercup/tmp/extract.py',
      applyScript: '.papercup/tmp/apply.py',
      encoding: 'cp932',
      systemTextFiles: ['script.ain'],
    });
    assert(
      learnDirectRes.status === 'adopted' && learnDirectRes.summary.includes('harness 目录'),
      `Expected direct skill adoption with harness path note, got: ${JSON.stringify(learnDirectRes)}`
    );

    const detect26e = detectVnEngines(ws26e);
    assert(detect26e.includes('ready  direct skill'), `vn_detect should report direct skill ready, got: ${detect26e}`);

    let unpackDirectErr = '';
    try {
      await unpackVnArchives(ws26e);
    } catch (err: any) {
      unpackDirectErr = String(err?.message || err);
    }
    assert(unpackDirectErr.includes('direct'), `vn_unpack should reject direct skill cleanly, got: ${unpackDirectErr}`);

    const classify26e = await classifyVnScripts(ws26e, {});
    assert(
      classify26e.includes('剧情 2 条；界面 1 条'),
      `Expected direct classify 2 scenario + 1 ui (excluding Version.txt & Version.asd), got: ${classify26e}`
    );

    fs.mkdirSync(path.join(ws26e, '.papercup', 'data', 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(ws26e, '.papercup', 'data', 'results', 'scenario.jsonl'),
      [
        JSON.stringify({ id: 'msg:0', file: 'script.ain', line: 1, kind: 'say', track: 'scenario', source: '「おはよう」', target: '「早上好」', ok: true }),
        JSON.stringify({ id: 'msg:1', file: 'script.ain', line: 2, kind: 'say', track: 'scenario', source: '「今日はいい天気だね」', target: '「今天天气真好啊」', ok: true }),
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws26e, '.papercup', 'data', 'results', 'ui.jsonl'),
      JSON.stringify({ id: 'str:0', file: 'script.ain', line: 3, kind: 'system', track: 'ui', source: 'セーブ', target: '保存进度', ok: true }) + '\n',
      'utf8'
    );

    // Default direct CP932->GBK auto strategy (without encoding override)
    const exportDir26eGbk = path.join(root26, 'export26e-gbk');
    const wb26eGbk = await writebackVnCopy(ws26e, { dest: exportDir26eGbk });
    assert(
      wb26eGbk.writeback_mode === 'direct_skill_apply' &&
        wb26eGbk.strategy === 'direct_file_replace' &&
        wb26eGbk.encoding === 'gbk' &&
        wb26eGbk.hook_needed === true &&
        fs.existsSync(path.join(exportDir26eGbk, 'papercup_patch.ini')),
      `Default direct CP932->GBK writeback mismatch: ${JSON.stringify(wb26eGbk)}`
    );
    const exportedAinGbk = JSON.parse(decodeBytes(fs.readFileSync((wb26eGbk.repacked_archives as string[])[0]), 'gbk').text);
    assert(
      exportedAinGbk.msg[0] === '「早上好」' && exportedAinGbk.str[0] === '保存进度',
      `Exported default GBK direct .ain missing translations: ${JSON.stringify(exportedAinGbk)}`
    );

    // Explicit UTF-8 override + verify heavy media.alm & untouched Version.txt do NOT leak into delta patch bundle
    const exportDir26e = path.join(root26, 'export26e');
    const wb26e = await writebackVnCopy(ws26e, { dest: exportDir26e, encoding: 'utf-8' });
    assert(
      wb26e.writeback_mode === 'direct_skill_apply' &&
        wb26e.strategy === 'direct_file_replace' &&
        Array.isArray(wb26e.repacked_archives) &&
        (wb26e.repacked_archives as string[]).length === 1 &&
        fs.existsSync(String(wb26e.manifest_path)) &&
        !fs.existsSync(path.join(exportDir26e, 'files', 'game', 'media.alm')) &&
        !fs.existsSync(path.join(exportDir26e, 'files', 'game', 'Version.txt')) &&
        !fs.existsSync(path.join(exportDir26e, 'files', 'media.alm')) &&
        !fs.existsSync(path.join(exportDir26e, 'files', 'Version.txt')),
      `Unexpected direct patch bundle outcome (or untouched media/Version.txt leaked): ${JSON.stringify(wb26e)}`
    );
    const exportedAin26e = (wb26e.repacked_archives as string[])[0];
    const exportedAinJson = JSON.parse(fs.readFileSync(exportedAin26e, 'utf8'));
    assert(
      exportedAinJson.msg[0] === '「早上好」' && exportedAinJson.str[0] === '保存进度',
      `Exported direct .ain should contain UTF-8 simplified Chinese translations: ${JSON.stringify(exportedAinJson)}`
    );
    assert(fs.readFileSync(ainPath26e).equals(origAinBuf), 'Original .ain file must remain untouched');

    const accScen = acceptVnRelease(ws26e, { archive: String(wb26e.manifest_path), track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
    const accUi = acceptVnRelease(ws26e, { archive: String(wb26e.manifest_path), track: 'ui', input: '.papercup/data/results/ui.jsonl' });
    assert(!accScen.blocked && !accUi.blocked, `Expected acceptance pass, got: ${accScen.text} / ${accUi.text}`);
    const relNote26e = releaseVnPatch(ws26e, { dryRun: true });
    assert(
      relNote26e.includes('跟随原文（source）') && relNote26e.includes('增量补丁') && relNote26e.includes('仅供个人学习'),
      `Expected release note with source POV label & patch info, got: ${relNote26e}`
    );

    // 26f: 同引擎多归档自定义技能端到端闭环 (script.bin + data.bin) + 项目级 engine.json 隔离与显式 promoteVnSkill 晋升
    const ws26f = path.join(root26, 'ws26f');
    fs.mkdirSync(path.join(ws26f, '.papercup', 'tmp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws26f, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "first"\n',
      'utf8'
    );
    const makeEscaArchive = (files: Array<[string, string]>) => {
      const parts: Buffer[] = [Buffer.from('ESCA', 'ascii'), Buffer.from([files.length, 0, 0, 0])];
      for (const [name, content] of files) {
        const nb = Buffer.from(name, 'utf8');
        const cb = Buffer.from(content, 'utf8');
        parts.push(Buffer.from([nb.length, 0]), nb, Buffer.from([cb.length & 0xff, (cb.length >> 8) & 0xff, 0, 0]), cb);
      }
      return Buffer.concat(parts);
    };
    const origScriptBin = makeEscaArchive([['s01.bin', '「ここは迷宮か」']]);
    const origDataBin = makeEscaArchive([['ui01.bin', '戦闘開始']]);
    fs.writeFileSync(path.join(ws26f, 'script.bin'), origScriptBin);
    fs.writeFileSync(path.join(ws26f, 'data.bin'), origDataBin);

    const multiUnpackPy = [
      'import sys',
      'from pathlib import Path',
      'blob = Path(sys.argv[1]).read_bytes()',
      'dest = Path(sys.argv[2]); dest.mkdir(parents=True, exist_ok=True)',
      'assert blob[:4] == b"ESCA"',
      'cnt = int.from_bytes(blob[4:8], "little")',
      'pos = 8',
      'for _ in range(cnt):',
      '    nl = int.from_bytes(blob[pos:pos+2], "little"); pos += 2',
      '    nm = blob[pos:pos+nl].decode("utf-8"); pos += nl',
      '    cl = int.from_bytes(blob[pos:pos+4], "little"); pos += 4',
      '    (dest / nm).write_bytes(blob[pos:pos+cl]); pos += cl',
      '',
    ].join('\n');
    const multiRepackPy = [
      'import sys',
      'from pathlib import Path',
      'src, dst = Path(sys.argv[1]), Path(sys.argv[2])',
      'files = sorted([p for p in src.iterdir() if p.is_file() and not p.name.startswith(".") and not p.name.endswith(".bak")], key=lambda p: p.name)',
      'out = bytearray(b"ESCA" + len(files).to_bytes(4, "little"))',
      'for p in files:',
      '    nb = p.name.encode("utf-8"); cb = p.read_bytes()',
      '    out += len(nb).to_bytes(2, "little") + nb + len(cb).to_bytes(4, "little") + cb',
      'dst.write_bytes(out)',
      '',
    ].join('\n');
    const multiExtractPy = [
      'import json, sys',
      'from pathlib import Path',
      'root, out_path = Path(sys.argv[1]), Path(sys.argv[2])',
      'rows = []',
      'ln = 0',
      'for p in sorted(root.rglob("*.bin")):',
      '    ln += 1',
      '    rel = p.relative_to(root).as_posix()',
      '    kind = "scenario" if p.name.startswith("s") else "ui"',
      '    rows.append({"id": f"{rel}#1", "file": rel, "line": ln, "kind": kind, "source": p.read_text(encoding="utf-8")})',
      'out_path.write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", encoding="utf-8")',
      '',
    ].join('\n');
    const multiApplyPy = [
      'import json, sys',
      'from pathlib import Path',
      'res_path, root = Path(sys.argv[1]), Path(sys.argv[2])',
      'for line in res_path.read_text(encoding="utf-8").splitlines():',
      '    if not line.strip(): continue',
      '    r = json.loads(line)',
      '    (root / r["file"]).write_text(r.get("target", r["source"]), encoding="utf-8")',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(ws26f, '.papercup', 'tmp', 'unpack.py'), multiUnpackPy, 'utf8');
    fs.writeFileSync(path.join(ws26f, '.papercup', 'tmp', 'repack.py'), multiRepackPy, 'utf8');
    fs.writeFileSync(path.join(ws26f, '.papercup', 'tmp', 'extract.py'), multiExtractPy, 'utf8');
    fs.writeFileSync(path.join(ws26f, '.papercup', 'tmp', 'apply.py'), multiApplyPy, 'utf8');

    const learnMulti = await learnVnSkill(ws26f, {
      engine: 'escatest',
      archive: 'script.bin',
      unpackScript: '.papercup/tmp/unpack.py',
      repackScript: '.papercup/tmp/repack.py',
      extractScript: '.papercup/tmp/extract.py',
      applyScript: '.papercup/tmp/apply.py',
      suffix: '.bin',
      magicHex: '45534341',
      classifyExtensions: ['.bin'],
      encoding: 'utf-8',
    });
    assert(learnMulti.status === 'adopted', `Multi-archive skill learn failed: ${JSON.stringify(learnMulti)}`);
    const escaProjectEngineJson = path.join(projectHarnessDir(ws26f, path.join(home26, '.papercup')), 'engine.json');
    const escaGlobalEngineJson = path.join(home26, '.papercup', 'skills', 'engine-escatest', 'engine.json');
    assert(
      fs.existsSync(escaProjectEngineJson) && !fs.existsSync(escaGlobalEngineJson),
      `learnVnSkill must keep engine.json workspace-local until promoted: local=${fs.existsSync(escaProjectEngineJson)}, global=${fs.existsSync(escaGlobalEngineJson)}`
    );
    const learnedEscaEngine = JSON.parse(fs.readFileSync(escaProjectEngineJson, 'utf8'));
    assert(
      !learnedEscaEngine.classify,
      `vn_learn_skill must strip binary .bin from classifyExtensions when extract.py is present, got: ${JSON.stringify(learnedEscaEngine)}`
    );

    const detect26f = detectVnEngines(ws26f);
    assert(
      detect26f.includes('script.bin  ready  skill unpack') && detect26f.includes('data.bin  ready  skill unpack'),
      `Expected both script.bin and data.bin ready, got: ${detect26f}`
    );
    const unpack26f = await unpackVnArchives(ws26f);
    assert(unpack26f.includes('script.bin') && unpack26f.includes('data.bin'), `Expected both archives unpacked, got: ${unpack26f}`);

    const classify26f = await classifyVnScripts(ws26f, { unpacked: '.papercup/tmp/unpacked', out: '.papercup/data/build' });
    assert(
      classify26f.includes('剧情 1 条；界面 1 条') && !classify26f.includes('无法解码') && !classify26f.includes('未知引擎'),
      `Expected 1 scenario + 1 ui cleanly without binary decode warnings, got: ${classify26f}`
    );
    // 兼容旧版遗留 engine.json 中仅含 binary classify.extensions=[".bin"] 的场景
    fs.writeFileSync(
      escaProjectEngineJson,
      JSON.stringify({ ...learnedEscaEngine, classify: { extensions: ['.bin'] } }, null, 2) + '\n',
      'utf8'
    );
    const classifyLegacy26f = await classifyVnScripts(ws26f, { unpacked: '.papercup/tmp/unpacked', out: '.papercup/data/build' });
    assert(
      classifyLegacy26f.includes('剧情 1 条；界面 1 条') && !classifyLegacy26f.includes('无法解码') && !classifyLegacy26f.includes('未知引擎'),
      `Legacy binary-only classify.extensions must also skip plain-text scan when extract.py exists, got: ${classifyLegacy26f}`
    );
    fs.writeFileSync(escaProjectEngineJson, JSON.stringify(learnedEscaEngine, null, 2) + '\n', 'utf8');

    fs.mkdirSync(path.join(ws26f, '.papercup', 'data', 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(ws26f, '.papercup', 'data', 'results', 'scenario.jsonl'),
      JSON.stringify({ id: 'script/s01.bin#1', file: 'script/s01.bin', line: 1, kind: 'say', track: 'scenario', source: '「ここは迷宮か」', target: '「这里是迷宫吗」', ok: true }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws26f, '.papercup', 'data', 'results', 'ui.jsonl'),
      JSON.stringify({ id: 'data/ui01.bin#1', file: 'data/ui01.bin', line: 2, kind: 'system', track: 'ui', source: '戦闘開始', target: '开始战斗', ok: true }) + '\n',
      'utf8'
    );

    const exportDir26f = path.join(root26, 'export26f');
    const wb26f = await writebackVnCopy(ws26f, { dest: exportDir26f });
    const repacked26f = (wb26f.repacked_archives as string[]).map((p) => path.basename(p)).sort();
    assert(
      wb26f.writeback_mode === 'skill_apply' &&
        repacked26f.length === 2 &&
        repacked26f[0] === 'data.bin' &&
        repacked26f[1] === 'script.bin' &&
        fs.existsSync(path.join(exportDir26f, 'patch_manifest.json')),
      `Expected both data.bin and script.bin in delta patch bundle, got: ${JSON.stringify(wb26f)}`
    );
    assert(fs.readFileSync(path.join(exportDir26f, 'files', 'script.bin')).toString('utf8').includes('「这里是迷宫吗」'), 'Patched script.bin missing translation');
    assert(fs.readFileSync(path.join(exportDir26f, 'files', 'data.bin')).toString('utf8').includes('开始战斗'), 'Patched data.bin missing translation');
    assert(fs.readFileSync(path.join(ws26f, 'script.bin')).equals(origScriptBin), 'Original script.bin must remain untouched');
    assert(fs.readFileSync(path.join(ws26f, 'data.bin')).equals(origDataBin), 'Original data.bin must remain untouched');

    // Explicit promoteVnSkill copies both scripts (skills/) & engine.json (engines/) into global ~/.papercup/
    promoteVnSkill(ws26f, 'engine-escatest');
    assert(
      fs.existsSync(escaGlobalEngineJson) &&
        fs.existsSync(path.join(home26, '.papercup', 'skills', 'engine-escatest', 'unpack.py')),
      'promoteVnSkill must promote both engine.json and skill scripts to global ~/.papercup/'
    );
  });

  // 27. 子代理对话面板后端流式、多轮持久化与直接交互接口验证
  console.log('27. Verifying subagent chat panel streaming, bounded messages[], direct follow-up, sync, and abort...');
  await withIsolatedHomeAndEnv('papercup-subagent-chat-27-', async ({ ws: ws27 }) => {
    fs.writeFileSync(
      path.join(ws27, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n',
      'utf8'
    );

    const svc27 = new AgentService(ws27, { sessionMode: 'persist' });
    await svc27.initSession();
    const router27 = createApiRouter(svc27);
    try {
      const mainFaux27 = createFauxCore({ tokensPerSecond: 10000 });
      const subFaux27 = createFauxCore({ tokensPerSecond: 10000 });
      const mainSess27 = (svc27 as any).currentSession;
      mainSess27.agent.state.model = mainFaux27.getModel();
      mainSess27.agent.streamFunction = mainFaux27.streamSimple;
      mainSess27._modelRuntime.hasConfiguredAuth = () => true;

      const subMgr27 = (svc27 as any).subagentManager as SubagentManager;
      const origCreate27 = subMgr27.createSubagentSession.bind(subMgr27);
      let createCalls27 = 0;
      subMgr27.createSubagentSession = async (roleName, opts) => {
        createCalls27 += 1;
        const res = await origCreate27(roleName, opts);
        (res.session as any).agent.state.model = subFaux27.getModel();
        (res.session as any).agent.streamFunction = subFaux27.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      const streamDeltas27: any[] = [];
      svc27.on('agent_event', (ev: { type: string; data: any }) => {
        if (ev.type === 'subagent_stream_delta') {
          streamDeltas27.push(ev.data);
        }
      });

      // 27a: Reverser 多轮思考 + 工具 + 超长 thinking 裁剪 + 落盘 messages[]
      const longThinking27 = '思'.repeat(20 * 1024);
      subFaux27.setResponses([
        () =>
          fauxAssistantMessage([
            fauxThinking('分析未知封包头部魔数与索引结构...'),
            fauxText('先列出目录确认样本文件。'),
            fauxToolCall('ls', { path: '.' }, { id: 'tc-27a-ls' }),
          ]),
        () =>
          fauxAssistantMessage([
            fauxThinking(longThinking27),
            fauxText('逆向初步结论：已定位核心脚本区段。'),
          ]),
      ]);
      let taskId1 = '';
      mainFaux27.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall('delegate_task', { role: 'reverser', task: '请侦察样本目录并给出结构结论' }, { id: 'tc-27a-main' }),
          ]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-27a-main') as any;
          taskId1 = String(tr?.details?.taskId || '');
          assert(taskId1.length > 0 && tr?.details?.resumable === true, `Expected valid resumable taskId1, got: ${JSON.stringify(tr)}`);
          return fauxAssistantMessage('主代理已收到 Reverser 初步结构报告。');
        },
      ]);
      await svc27.executeTurn('委派 reverser 检查结构');

      const sawThinkingDelta = streamDeltas27.some((d) => d.taskId === taskId1 && d.kind === 'thinking');
      const sawTextDelta = streamDeltas27.some((d) => d.taskId === taskId1 && d.kind === 'text');
      assert(sawThinkingDelta && sawTextDelta, `Expected streamed thinking & text deltas for ${taskId1}, got ${streamDeltas27.length} events`);

      const detailRes1 = await router27.request(`/api/subagents/tasks/${encodeURIComponent(taskId1)}`);
      assert(detailRes1.status === 200, `GET task detail failed: ${detailRes1.status}`);
      const snap27a = await detailRes1.json();
      assert(
        snap27a.interactive === true &&
          snap27a.resumable === true &&
          snap27a.threadId === taskId1 &&
          Array.isArray(snap27a.messages) &&
          snap27a.messages.length === 3,
        `Expected 3 interactive messages in snap27a, got: ${JSON.stringify(snap27a)}`
      );
      assert(
        snap27a.messages[0].role === 'user' &&
          snap27a.messages[0].origin === 'delegated' &&
          snap27a.messages[1].thinking?.includes('魔数') &&
          snap27a.messages[1].tools?.[0]?.tool === 'ls' &&
          snap27a.messages[1].tools?.[0]?.status === 'completed' &&
          typeof snap27a.messages[2].thinking === 'string' &&
          snap27a.messages[2].thinking.length <= 16 * 1024 &&
          snap27a.messages[2].thinking.includes('已按上限裁剪') &&
          snap27a.messages[2].content.includes('已定位核心脚本区段'),
        `Unexpected message sequence or clipping in snap27a: ${JSON.stringify(snap27a.messages)}`
      );
      const diskSnap27a = JSON.parse(
        fs.readFileSync(path.join(ws27, '.papercup', 'tmp', 'diagnostics', 'subagent-tasks', `${taskId1}.json`), 'utf8')
      );
      assert(Array.isArray(diskSnap27a.messages) && diskSnap27a.messages.length === 3, 'Persisted JSON missing messages[]');

      // 27b: translator 角色排除消息持久化与直接聊天接口
      subFaux27.setResponses([() => fauxAssistantMessage('{"id":1,"target":"翻译条目1"}')]);
      const hist27b = await svc27.getSessionHistory();
      await subMgr27.runSubagentWithMetrics('translator', 'translate entry 1', {
        cwd: ws27,
        sessionId: hist27b.sessionId,
        taskId: 'subtask-translator-27b',
        model: subFaux27.getModel(),
        modelRuntime: mainSess27._modelRuntime,
        recordDiagnostics: true,
      });
      const snap27b = svc27.getSubagentTask('subtask-translator-27b');
      assert(
        snap27b?.interactive === false && snap27b.messages === undefined && snap27b.resumable !== true,
        `Translator must exclude chat transcript & warm cache, got: ${JSON.stringify(snap27b)}`
      );
      const msgTransRes = await router27.request('/api/subagents/tasks/subtask-translator-27b/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '尝试直连 translator' }),
      });
      assert(msgTransRes.status === 400, `Expected 400 when messaging translator, got ${msgTransRes.status}`);

      // 27c: POST /api/subagents/tasks/:taskId/message 命中热缓存直聊 + 线程连续 + 主会话静默同步
      const waitDirectIdle = async (timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const stRes = await router27.request('/api/turns/status');
          const stJson = await stRes.json();
          if (!stJson.activeDirectSubagentTaskId && !stJson.isRunning) {
            return;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('Timed out waiting for direct subagent turn to settle');
      };

      const createCallsBefore27c = createCalls27;
      let sawTurn1AndDirectPrompt = false;
      subFaux27.setResponses([
        (ctx) => {
          const serialized = JSON.stringify(ctx.messages);
          sawTurn1AndDirectPrompt =
            serialized.includes('请侦察样本目录并给出结构结论') &&
            serialized.includes('请继续核对索引表偏移量');
          return fauxAssistantMessage([
            fauxThinking('在热缓存上下文中直接核对 0x20 偏移'),
            fauxText('已核对：索引表起始偏移为 0x20，共 128 项。'),
          ]);
        },
      ]);
      const directRes27c = await router27.request(`/api/subagents/tasks/${encodeURIComponent(taskId1)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '请继续核对索引表偏移量' }),
      });
      assert(directRes27c.status === 202, `Expected 202 for direct subagent message, got ${directRes27c.status}`);
      const directBody27c = await directRes27c.json();
      const taskId2 = String(directBody27c.taskId || '');
      assert(
        directBody27c.ok === true &&
          taskId2.length > 0 &&
          taskId2 !== taskId1 &&
          directBody27c.threadId === taskId1,
        `Unexpected 27c response payload: ${JSON.stringify(directBody27c)}`
      );
      await waitDirectIdle();

      const snap27c = svc27.getSubagentTask(taskId2);
      assert(
        createCalls27 === createCallsBefore27c &&
          sawTurn1AndDirectPrompt &&
          snap27c?.threadId === taskId1 &&
          snap27c?.resumedFromTaskId === taskId1 &&
          Array.isArray(snap27c?.messages) &&
          snap27c.messages.length === 5 &&
          snap27c.messages[3].role === 'user' &&
          snap27c.messages[3].origin === 'direct_user' &&
          snap27c.messages[3].content === '请继续核对索引表偏移量' &&
          snap27c.messages[4].thinking?.includes('0x20 偏移') &&
          snap27c.messages[4].content.includes('索引表起始偏移为 0x20'),
        `Direct warm follow-up mismatch: createCalls=${createCalls27}/${createCallsBefore27c}, snap=${JSON.stringify(snap27c)}`
      );

      const mainCtx27c: any[] = (svc27 as any).sessionManager.buildSessionContext().messages;
      const syncEntry27c = mainCtx27c.find(
        (m) => m?.role === 'custom' && m?.customType === 'papercup_subagent_direct_sync'
      );
      assert(
        Boolean(syncEntry27c) &&
          String(syncEntry27c.content).includes('请继续核对索引表偏移量') &&
          String(syncEntry27c.content).includes('索引表起始偏移为 0x20'),
        `Expected hidden papercup_subagent_direct_sync in main context, got: ${JSON.stringify(mainCtx27c.map((m) => ({ role: m.role, customType: m.customType })))}`
      );
      const historyAfter27c = await (await router27.request('/api/session/history')).json();
      assert(
        !JSON.stringify(historyAfter27c.messages).includes('papercup_subagent_direct_sync') &&
          !JSON.stringify(historyAfter27c.messages).includes('请继续核对索引表偏移量'),
        'Hidden subagent sync entry must NOT surface in /api/session/history visible messages'
      );

      // 27d: 热缓存过期降级 + 保持干净用户气泡与同 threadId
      subMgr27.disposeResumableSessions(ws27);
      const expiredCheck2 = await (await router27.request(`/api/subagents/tasks/${encodeURIComponent(taskId2)}`)).json();
      assert(expiredCheck2.resumable === false, 'disposeResumableSessions must flip task resumable=false');

      let sawFallbackContext27d = false;
      subFaux27.setResponses([
        (ctx) => {
          sawFallbackContext27d = JSON.stringify(ctx.messages).includes('expired or unavailable');
          return fauxAssistantMessage('缓存已过期，但已基于历史摘要完成末尾校验。');
        },
      ]);
      const directRes27d = await router27.request(`/api/subagents/tasks/${encodeURIComponent(taskId2)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '补充校验末尾校验和' }),
      });
      assert(directRes27d.status === 202, `Expected 202 on fallback direct follow-up, got ${directRes27d.status}`);
      const taskId3 = String((await directRes27d.json()).taskId || '');
      await waitDirectIdle();

      const snap27d = svc27.getSubagentTask(taskId3);
      assert(
        createCalls27 === createCallsBefore27c + 1 &&
          sawFallbackContext27d &&
          snap27d?.threadId === taskId1 &&
          snap27d?.messages?.some(
            (m) => m.role === 'user' && m.origin === 'direct_user' && m.content === '补充校验末尾校验和'
          ),
        `Expected clean user bubble without internal fallback note and continuous threadId, got: ${JSON.stringify(snap27d)}`
      );

      // 27e: 404 / 400 参数校验 + 并发 409 冲突保护 + abort 中止直接对话
      const notFoundRes = await router27.request('/api/subagents/tasks/nonexistent-subtask-27/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      assert(notFoundRes.status === 404, `Expected 404 for unknown taskId, got ${notFoundRes.status}`);

      const emptyMsgRes = await router27.request(`/api/subagents/tasks/${encodeURIComponent(taskId3)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '   ' }),
      });
      assert(emptyMsgRes.status === 400, `Expected 400 for empty message, got ${emptyMsgRes.status}`);

      let notify27eStarted: (() => void) | undefined;
      const started27ePromise = new Promise<void>((resolve) => {
        notify27eStarted = resolve;
      });
      subFaux27.setResponses([
        (_ctx, opts) =>
          new Promise((resolve) => {
            notify27eStarted?.();
            const timer = setTimeout(() => {
              resolve(fauxAssistantMessage('late response 27e'));
            }, 5000);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
              },
              { once: true }
            );
          }),
      ]);
      const runningDirectRes = await router27.request(`/api/subagents/tasks/${encodeURIComponent(taskId3)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '长耗时任务等待中止测试' }),
      });
      assert(runningDirectRes.status === 202, `Expected 202 starting abort test, got ${runningDirectRes.status}`);
      const runningTaskId27e = String((await runningDirectRes.json()).taskId || '');
      await started27ePromise;

      const conflictRes = await router27.request(`/api/subagents/tasks/${encodeURIComponent(taskId3)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '并发冲突测试消息' }),
      });
      assert(conflictRes.status === 409, `Expected 409 conflict while direct task is active, got ${conflictRes.status}`);

      const abortDirectRes = await router27.request(
        `/api/subagents/tasks/${encodeURIComponent(runningTaskId27e)}/abort`,
        { method: 'POST' }
      );
      assert(abortDirectRes.status === 200, `Expected 200 from direct abort endpoint, got ${abortDirectRes.status}`);
      const abortDirectBody = await abortDirectRes.json();
      assert(abortDirectBody.ok === true && abortDirectBody.aborted === true, `Expected aborted=true, got ${JSON.stringify(abortDirectBody)}`);
      await waitDirectIdle();
      const abortedSnap27e = svc27.getSubagentTask(runningTaskId27e);
      assert(abortedSnap27e?.status === 'aborted', `Expected aborted status after POST /abort, got: ${abortedSnap27e?.status}`);
    } finally {
      (svc27 as any).disposeCurrentSessionState?.(true);
    }
  });

  // 28. API Key 与模型/思考深度本地持久化 (~/.papercup/auth.json) 与重启自动恢复验证
  console.log('\n28. Verifying API key, model, custom model & thinking level local persistence (~/.papercup/auth.json)...');
  await withIsolatedHomeAndEnv('papercup-auth-persist-28-', async ({ home: home28, ws: ws28 }) => {
    const dsSecret28 = 'sk-deepseek-persist-test-28a';
    const arkSecret28 = '11111111-2222-3333-4444-555555555555';
    const authPath28 = path.join(home28, '.papercup', 'auth.json');

    const mockProbeFetch28 = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const auth = new Headers(init?.headers).get('Authorization');
      if (url.startsWith('https://api.deepseek.com/models') && auth === `Bearer ${dsSecret28}`) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'deepseek-chat' },
              { id: 'deepseek-reasoner' },
              { id: 'deepseek-coder' },
              { id: 'deepseek-v2-chat' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    };

    let svc28_1: AgentService | null = null;
    let svc28_2: AgentService | null = null;
    let svc28_3: AgentService | null = null;
    let svc28_4: AgentService | null = null;
    let mem28: AgentService | null = null;
    let redactSvc28: AgentService | null = null;
    let corruptSvc28: AgentService | null = null;
    try {
      // 28a: 保存 Key + 选模 + 思考深度，重启后离线无感自动恢复
      svc28_1 = new AgentService(ws28, {
        sessionMode: 'persist',
        probeFetch: mockProbeFetch28,
      });
      const router28_1 = createApiRouter(svc28_1);
      const events28_1: Array<{ type: string; data: any }> = [];
      svc28_1.on('agent_event', (ev) => events28_1.push(ev));

      const setDsRes = await router28_1.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'auto', apiKey: dsSecret28 }),
      });
      assert(setDsRes.status === 200, `Expected 200 saving DeepSeek key, got ${setDsRes.status}`);
      const setDsBody = await setDsRes.json();
      const dsMeta1 = setDsBody.providers?.find((p: any) => p.id === 'deepseek');
      assert(
        setDsBody.detectedProvider === 'deepseek' &&
          setDsBody.models?.some((m: any) => m.key === 'deepseek/deepseek-chat') &&
          setDsBody.models?.some((m: any) => m.key === 'deepseek/deepseek-reasoner') &&
          !setDsBody.models?.some((m: any) => /deepseek-coder|deepseek-v2/.test(m.id)) &&
          dsMeta1?.configured === true &&
          dsMeta1?.source === 'stored' &&
          dsMeta1?.savedLocally === true &&
          !JSON.stringify(setDsBody).includes(dsSecret28) &&
          !JSON.stringify(events28_1).includes(dsSecret28),
        `Unexpected 28a save payload: ${JSON.stringify(setDsBody)}`
      );

      assert(fs.existsSync(authPath28), `Expected persisted auth file at ${authPath28}`);
      const diskAuth1 = JSON.parse(fs.readFileSync(authPath28, 'utf8'));
      assert(
        diskAuth1.activeProvider === 'deepseek' &&
          diskAuth1.providers?.deepseek?.apiKey === dsSecret28,
        `Unexpected persisted auth.json content: ${JSON.stringify(diskAuth1)}`
      );
      assert(
        isRestrictedSecretPath(authPath28, ws28) &&
          isRestrictedSecretPath(path.join(home28, '.papercup', 'auth.json.tmp.123.abc'), ws28) &&
          detectBlockedSecretCommand('cat ~/.papercup/auth.json', ws28) !== null,
        '~/.papercup/auth.json and temp siblings must be blocked by secrets guard'
      );

      const selReasonerRes = await router28_1.request('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek/deepseek-reasoner' }),
      });
      assert(selReasonerRes.status === 200, `Expected 200 selecting deepseek-reasoner, got ${selReasonerRes.status}`);
      const setThinkRes = await router28_1.request('/api/models/thinking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingLevel: 'high' }),
      });
      assert(setThinkRes.status === 200, `Expected 200 setting thinkingLevel high, got ${setThinkRes.status}`);
      (svc28_1 as any).disposeCurrentSessionState?.(true);
      svc28_1 = null;

      process.env.PI_OFFLINE = '1';
      svc28_2 = new AgentService(ws28, { sessionMode: 'persist' });
      const router28_2 = createApiRouter(svc28_2);
      const restoredModelsRes = await router28_2.request('/api/models');
      assert(restoredModelsRes.status === 200, `Expected 200 on restored /api/models, got ${restoredModelsRes.status}`);
      const restoredModelsBody = await restoredModelsRes.json();
      const restoredDsMeta = restoredModelsBody.providers?.find((p: any) => p.id === 'deepseek');
      assert(
        restoredModelsBody.current === 'deepseek/deepseek-reasoner' &&
          restoredModelsBody.thinkingLevel === 'high' &&
          restoredModelsBody.models?.some((m: any) => m.key === 'deepseek/deepseek-chat') &&
          restoredModelsBody.models?.some((m: any) => m.key === 'deepseek/deepseek-reasoner') &&
          !restoredModelsBody.models?.some((m: any) => /deepseek-coder|deepseek-v2/.test(m.id)) &&
          restoredDsMeta?.configured === true &&
          restoredDsMeta?.source === 'stored' &&
          restoredDsMeta?.savedLocally === true &&
          !JSON.stringify(restoredModelsBody).includes(dsSecret28),
        `Expected offline restart restore of model/thinking/models, got: ${JSON.stringify(restoredModelsBody)}`
      );
      const restoredSession2 = (svc28_2 as any).currentSession;
      const resolvedAuth2 = await restoredSession2?.modelRuntime?.getAuth?.(restoredSession2.model);
      assert(
        resolvedAuth2?.auth?.apiKey === dsSecret28,
        'Expected restored ModelRuntime to resolve persisted API key for active model'
      );

      // 28b: 保存第二个厂商 (volcengine + customModel)，重启恢复后使用 useStored 免填密钥切回 DeepSeek
      const setArkRes = await router28_2.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'volcengine',
          apiKey: arkSecret28,
          customModel: 'ep-20261120-persist',
        }),
      });
      assert(setArkRes.status === 200, `Expected 200 saving volcengine key, got ${setArkRes.status}`);
      const setArkBody = await setArkRes.json();
      const arkMeta2 = setArkBody.providers?.find((p: any) => p.id === 'volcengine');
      const dsMeta2 = setArkBody.providers?.find((p: any) => p.id === 'deepseek');
      assert(
        setArkBody.current === 'volcengine/ep-20261120-persist' &&
          arkMeta2?.configured === true &&
          arkMeta2?.savedLocally === true &&
          arkMeta2?.source === 'stored' &&
          dsMeta2?.configured === false &&
          dsMeta2?.savedLocally === true &&
          dsMeta2?.source === null &&
          !JSON.stringify(setArkBody).includes(arkSecret28) &&
          !JSON.stringify(setArkBody).includes(dsSecret28),
        `Unexpected multi-provider save state: ${JSON.stringify(setArkBody)}`
      );
      (svc28_2 as any).disposeCurrentSessionState?.(true);
      svc28_2 = null;

      svc28_3 = new AgentService(ws28, { sessionMode: 'persist' });
      const router28_3 = createApiRouter(svc28_3);
      const restoredArkBody = await (await router28_3.request('/api/models')).json();
      assert(
        restoredArkBody.current === 'volcengine/ep-20261120-persist' &&
          restoredArkBody.models?.some((m: any) => m.key === 'volcengine/ep-20261120-persist'),
        `Expected volcengine customModel restored on restart, got: ${JSON.stringify(restoredArkBody)}`
      );

      const useStoredDsRes = await router28_3.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'deepseek', useStored: true }),
      });
      assert(useStoredDsRes.status === 200, `Expected 200 switching with useStored:true, got ${useStoredDsRes.status}`);
      const useStoredDsBody = await useStoredDsRes.json();
      const dsMeta3 = useStoredDsBody.providers?.find((p: any) => p.id === 'deepseek');
      const arkMeta3 = useStoredDsBody.providers?.find((p: any) => p.id === 'volcengine');
      assert(
        typeof useStoredDsBody.current === 'string' &&
          useStoredDsBody.current.startsWith('deepseek/') &&
          useStoredDsBody.models?.some((m: any) => m.key === 'deepseek/deepseek-chat') &&
          useStoredDsBody.models?.some((m: any) => m.key === 'deepseek/deepseek-reasoner') &&
          !useStoredDsBody.models?.some((m: any) => /deepseek-coder/.test(m.id)) &&
          dsMeta3?.configured === true &&
          dsMeta3?.source === 'stored' &&
          dsMeta3?.savedLocally === true &&
          arkMeta3?.configured === false &&
          arkMeta3?.savedLocally === true &&
          arkMeta3?.source === null &&
          !JSON.stringify(useStoredDsBody).includes(dsSecret28) &&
          !JSON.stringify(useStoredDsBody).includes(arkSecret28),
        `Unexpected useStored switch state: ${JSON.stringify(useStoredDsBody)}`
      );

      const missingStoredRes = await router28_3.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', useStored: true }),
      });
      assert(missingStoredRes.status === 400, `Expected 400 for unsaved provider with useStored:true, got ${missingStoredRes.status}`);
      const autoStoredRes = await router28_3.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'auto', useStored: true }),
      });
      assert(autoStoredRes.status === 400, `Expected 400 for auto provider with useStored:true, got ${autoStoredRes.status}`);

      // 28c: 单独清除未启用厂商不打断当前活跃模型；清除活跃厂商后重启保持清空
      const clearInactiveArkRes = await router28_3.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'volcengine', apiKey: '' }),
      });
      assert(clearInactiveArkRes.status === 200, `Expected 200 clearing inactive volcengine, got ${clearInactiveArkRes.status}`);
      const clearInactiveArkBody = await clearInactiveArkRes.json();
      const arkAfterClear = clearInactiveArkBody.providers?.find((p: any) => p.id === 'volcengine');
      const dsAfterClearArk = clearInactiveArkBody.providers?.find((p: any) => p.id === 'deepseek');
      assert(
        typeof clearInactiveArkBody.current === 'string' &&
          clearInactiveArkBody.current.startsWith('deepseek/') &&
          !arkAfterClear?.savedLocally &&
          arkAfterClear?.configured === false &&
          dsAfterClearArk?.configured === true &&
          dsAfterClearArk?.savedLocally === true &&
          !fs.readFileSync(authPath28, 'utf8').includes(arkSecret28) &&
          fs.readFileSync(authPath28, 'utf8').includes(dsSecret28),
        `Clearing inactive provider must keep active provider intact: ${JSON.stringify(clearInactiveArkBody)}`
      );

      const clearActiveDsRes = await router28_3.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'deepseek', apiKey: '' }),
      });
      assert(clearActiveDsRes.status === 200, `Expected 200 clearing active deepseek, got ${clearActiveDsRes.status}`);
      const clearActiveDsBody = await clearActiveDsRes.json();
      const dsAfterClear = clearActiveDsBody.providers?.find((p: any) => p.id === 'deepseek');
      assert(
        clearActiveDsBody.current === null &&
          Array.isArray(clearActiveDsBody.models) &&
          clearActiveDsBody.models.length === 0 &&
          dsAfterClear?.configured === false &&
          !dsAfterClear?.savedLocally &&
          !fs.readFileSync(authPath28, 'utf8').includes(dsSecret28),
        `Expected active provider cleared cleanly: ${JSON.stringify(clearActiveDsBody)}`
      );
      (svc28_3 as any).disposeCurrentSessionState?.(true);
      svc28_3 = null;

      svc28_4 = new AgentService(ws28, { sessionMode: 'persist' });
      const router28_4 = createApiRouter(svc28_4);
      const afterClearRestart = await (await router28_4.request('/api/models')).json();
      assert(
        afterClearRestart.current === null &&
          Array.isArray(afterClearRestart.models) &&
          afterClearRestart.models.length === 0,
        `Expected cleared state to persist across restart, got: ${JSON.stringify(afterClearRestart)}`
      );
      (svc28_4 as any).disposeCurrentSessionState?.(true);
      svc28_4 = null;

      // 28d: memory 模式隔离、多厂商脱敏覆盖与损坏 auth.json 优雅降级
      fs.writeFileSync(
        authPath28,
        JSON.stringify(
          {
            version: 1,
            activeProvider: 'deepseek',
            preferredModel: 'deepseek/deepseek-chat',
            preferredThinkingLevel: 'medium',
            providers: {
              deepseek: { apiKey: dsSecret28 },
              volcengine: { apiKey: arkSecret28 },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      mem28 = new AgentService(ws28, { sessionMode: 'memory' });
      const memRouter28 = createApiRouter(mem28);
      const memModels28 = await (await memRouter28.request('/api/models')).json();
      assert(
        memModels28.current === null && memModels28.models.length === 0,
        `Memory mode must not hydrate from ~/.papercup/auth.json, got: ${JSON.stringify(memModels28)}`
      );
      await memRouter28.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', apiKey: 'AIza-mem-only-28d' }),
      });
      const authDiskAfterMem = fs.readFileSync(authPath28, 'utf8');
      assert(
        authDiskAfterMem.includes(dsSecret28) && !authDiskAfterMem.includes('AIza-mem-only-28d'),
        'Memory mode must not overwrite ~/.papercup/auth.json'
      );
      (mem28 as any).disposeCurrentSessionState?.(true);
      mem28 = null;

      redactSvc28 = new AgentService(ws28, { sessionMode: 'persist' });
      const redactedBoth = redactSecrets(
        `a=${dsSecret28} b=${arkSecret28}`,
        (redactSvc28 as any).getAllKnownSecrets()
      );
      assert(
        redactedBoth === 'a=[REDACTED] b=[REDACTED]',
        `Expected getAllKnownSecrets() to redact both active and inactive persisted keys, got: ${redactedBoth}`
      );
      (redactSvc28 as any).disposeCurrentSessionState?.(true);
      redactSvc28 = null;

      fs.writeFileSync(authPath28, '{invalid json!!!', 'utf8');
      corruptSvc28 = new AgentService(ws28, { sessionMode: 'persist' });
      const corruptRouter28 = createApiRouter(corruptSvc28);
      const corruptModelsRes = await corruptRouter28.request('/api/models');
      assert(corruptModelsRes.status === 200, `Corrupt auth.json must degrade gracefully, got ${corruptModelsRes.status}`);
      const corruptModelsBody = await corruptModelsRes.json();
      assert(
        corruptModelsBody.current === null && Array.isArray(corruptModelsBody.models) && corruptModelsBody.models.length === 0,
        `Expected empty models on corrupt auth.json, got: ${JSON.stringify(corruptModelsBody)}`
      );
    } finally {
      (svc28_1 as any)?.disposeCurrentSessionState?.(true);
      (svc28_2 as any)?.disposeCurrentSessionState?.(true);
      (svc28_3 as any)?.disposeCurrentSessionState?.(true);
      (svc28_4 as any)?.disposeCurrentSessionState?.(true);
      (mem28 as any)?.disposeCurrentSessionState?.(true);
      (redactSvc28 as any)?.disposeCurrentSessionState?.(true);
      (corruptSvc28 as any)?.disposeCurrentSessionState?.(true);
    }
  });

  // 29. 默认轻量化增量补丁包、引擎分层编码/Hook 自动策略、双轨写回重组装与批处理安装器验证
  console.log('29. Verifying delta patch bundles (XP3/RPA/NSA), dual-track CP932->UTF-16LE/GBK auto strategy, patch_manifest acceptance, and ASCII CRLF installers...');
  await withIsolatedHomeAndEnv('papercup-delta-patch-29-', async ({ root: root29 }) => {
    const makeFakePeExe = (arch: 'x86' | 'x64'): Buffer => {
      const buf = Buffer.alloc(256, 0);
      buf[0] = 0x4d; // 'M'
      buf[1] = 0x5a; // 'Z'
      buf.writeUInt32LE(0x80, 0x3c);
      buf[0x80] = 0x50; // 'P'
      buf[0x81] = 0x45; // 'E'
      buf.writeUInt16LE(arch === 'x86' ? 0x014c : 0x8664, 0x84);
      return buf;
    };
    const assertAsciiCrlfBat = (batPath: string): void => {
      const raw = fs.readFileSync(batPath);
      for (let i = 0; i < raw.length; i++) {
        assert(raw[i] <= 0x7e, `Non-ASCII byte 0x${raw[i].toString(16)} found in ${batPath}`);
      }
      const text = raw.toString('ascii');
      assert(!/chcp\s+65001/i.test(text), `Batch script must not call chcp 65001: ${batPath}`);
      assert(text.includes('\r\n'), `Batch script must use CRLF: ${batPath}`);
      const stripped = text.replace(/\r\n/g, '');
      assert(!stripped.includes('\n'), `Batch script contains bare LF: ${batPath}`);
    };
    const writeTrackResultsFromManifest = (
      ws: string,
      translate: (row: { track: string; source: string; id: string }, index: number) => string
    ): { scenarioCount: number; uiCount: number } => {
      const byTrack: Record<string, string[]> = { scenario: [], ui: [] };
      let idx = 0;
      for (const track of ['scenario', 'ui'] as const) {
        const buildFile = path.join(ws, '.papercup', 'data', 'build', `${track}.jsonl`);
        if (!fs.existsSync(buildFile)) continue;
        const rawLines = fs
          .readFileSync(buildFile, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        for (const rawLine of rawLines) {
          const row = JSON.parse(rawLine) as Record<string, unknown>;
          const src = String(row.source ?? row.text ?? '');
          const target = translate({ track, source: src, id: String(row.id || '') }, idx++);
          byTrack[track].push(
            JSON.stringify({
              id: row.id,
              file: row.file,
              line: row.line,
              kind: row.kind,
              track,
              source: src,
              target,
              ok: true,
            })
          );
        }
      }
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      if (byTrack.scenario.length) {
        fs.writeFileSync(path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'), byTrack.scenario.join('\n') + '\n', 'utf8');
      }
      if (byTrack.ui.length) {
        fs.writeFileSync(path.join(ws, '.papercup', 'data', 'results', 'ui.jsonl'), byTrack.ui.join('\n') + '\n', 'utf8');
      }
      return { scenarioCount: byTrack.scenario.length, uiCount: byTrack.ui.length };
    };

    // 29a. KiriKiri XP3 dual-track (scenario + UI): CP932 source -> UTF-16LE BOM delta patch.xp3 / patch2.xp3 overlay, skipping untouched media/archives
    const wsXp3 = path.join(root29, 'ws-xp3');
    fs.mkdirSync(wsXp3, { recursive: true });
    fs.writeFileSync(
      path.join(wsXp3, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "first"\n',
      'utf8'
    );
    fs.writeFileSync(path.join(wsXp3, 'Game.exe'), makeFakePeExe('x86'));
    const ksCp932 = encodeText('*start\r\nおはよう、世界。[p]\r\n[glink text="セーブ" target="*save"]\r\n', 'cp932');
    packDeltaXp3(
      [
        ['scenario/first.ks', ksCp932],
        ['image/bg01.png', Buffer.alloc(4096, 0x5a)],
      ],
      path.join(wsXp3, 'data.xp3')
    );
    packDeltaXp3([['voice/v01.ogg', Buffer.alloc(2048, 0x33)]], path.join(wsXp3, 'voice.xp3'));

    await unpackVnArchives(wsXp3);
    await classifyVnScripts(wsXp3, {});
    const xp3Counts = writeTrackResultsFromManifest(wsXp3, (row) => {
      if (row.track === 'ui') return '保存进度';
      return row.source.includes('[p]') ? '早上好，爱丽丝・世界。[p]' : '早上好，爱丽丝・世界。';
    });
    assert(
      xp3Counts.scenarioCount >= 1 && xp3Counts.uiCount >= 1,
      `Expected both scenario and ui KiriKiri lines, got ${JSON.stringify(xp3Counts)}`
    );

    const patchXp3Dir1 = path.join(root29, 'patch-xp3-1');
    const wbXp3_1 = await writebackVnCopy(wsXp3, { dest: patchXp3Dir1 });
    assert(
      wbXp3_1.strategy === 'xp3_overlay' &&
        wbXp3_1.encoding === 'utf-16le-bom' &&
        wbXp3_1.hook_needed === false &&
        !fs.existsSync(path.join(patchXp3Dir1, 'papercup_patch.ini')) &&
        !fs.existsSync(path.join(patchXp3Dir1, 'Game.exe')) &&
        !fs.existsSync(path.join(patchXp3Dir1, 'files', 'voice.xp3')) &&
        fs.existsSync(path.join(patchXp3Dir1, 'files', 'patch.xp3')) &&
        fs.existsSync(path.join(patchXp3Dir1, 'sources', 'scenario.jsonl')) &&
        fs.existsSync(path.join(patchXp3Dir1, 'sources', 'ui.jsonl')) &&
        fs.existsSync(path.join(patchXp3Dir1, 'patch_manifest.json')),
      `Unexpected XP3 dual-track delta patch outcome: ${JSON.stringify(wbXp3_1)}`
    );

    const verifyXp3Dir = path.join(root29, 'verify-xp3');
    unpackXp3(path.join(patchXp3Dir1, 'files', 'patch.xp3'), verifyXp3Dir);
    assert(!fs.existsSync(path.join(verifyXp3Dir, 'image', 'bg01.png')), 'Delta patch.xp3 must NOT include untouched image/bg01.png');
    const patchedKsBuf = fs.readFileSync(path.join(verifyXp3Dir, 'scenario', 'first.ks'));
    assert(patchedKsBuf[0] === 0xff && patchedKsBuf[1] === 0xfe, 'KiriKiri delta script must begin with UTF-16LE BOM');
    const decodedKs = decodeBytes(patchedKsBuf);
    assert(
      decodedKs.encoding === 'utf-16le-bom' &&
        decodedKs.text.includes('早上好，爱丽丝・世界。') &&
        decodedKs.text.includes('保存进度'),
      `Expected UTF-16LE BOM dual-track translated KiriKiri script (scenario + ui), got: ${JSON.stringify(decodedKs)}`
    );

    // Existing patch.xp3 in workspace -> automatically select patch2.xp3
    packDeltaXp3([['dummy.txt', Buffer.from('existing', 'utf8')]], path.join(wsXp3, 'patch.xp3'));
    const patchXp3Dir2 = path.join(root29, 'patch-xp3-2');
    const wbXp3_2 = await writebackVnCopy(wsXp3, { dest: patchXp3Dir2 });
    const xp3Arts2 = wbXp3_2.artifacts as Array<{ install_rel: string }>;
    assert(
      fs.existsSync(path.join(patchXp3Dir2, 'files', 'patch2.xp3')) &&
        xp3Arts2.some((a) => a.install_rel === 'patch2.xp3'),
      `Expected patch2.xp3 when patch.xp3 already exists, got: ${JSON.stringify(wbXp3_2)}`
    );

    // 29b. Ren'Py RPA: UTF-8 loose file overlay under files/game/script.rpy (no .rpa repacked)
    const wsRpa = path.join(root29, 'ws-rpa');
    const rpaSrc = path.join(root29, 'rpa-src');
    fs.mkdirSync(path.join(wsRpa, 'game'), { recursive: true });
    fs.mkdirSync(rpaSrc, { recursive: true });
    fs.writeFileSync(
      path.join(wsRpa, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "first"\n',
      'utf8'
    );
    fs.writeFileSync(path.join(rpaSrc, 'script.rpy'), 'label start:\n    "おはよう、世界。"\n', 'utf8');
    fs.writeFileSync(path.join(rpaSrc, 'untouched.png'), Buffer.alloc(1024, 0x42));
    fs.writeFileSync(path.join(rpaSrc, RPA_MANIFEST), JSON.stringify({ version: '3.0', key: 0x12345678, files: [] }), 'utf8');
    repackRpa(rpaSrc, path.join(wsRpa, 'game', 'archive.rpa'));

    await unpackVnArchives(wsRpa);
    await classifyVnScripts(wsRpa, {});
    const rpaCounts = writeTrackResultsFromManifest(wsRpa, () => '早上好，世界。');
    assert(rpaCounts.scenarioCount >= 1, `Expected >=1 Ren'Py scenario line, got ${JSON.stringify(rpaCounts)}`);

    const patchRpaDir = path.join(root29, 'patch-rpa');
    const wbRpa = await writebackVnCopy(wsRpa, { dest: patchRpaDir });
    const rpaArts = wbRpa.artifacts as Array<{ kind: string; install_rel: string; action: string }>;
    assert(
      wbRpa.strategy === 'rpa_loose_overlay' &&
        wbRpa.encoding === 'utf-8' &&
        wbRpa.hook_needed === false &&
        fs.existsSync(path.join(patchRpaDir, 'files', 'game', 'script.rpy')) &&
        !fs.existsSync(path.join(patchRpaDir, 'files', 'game', 'archive.rpa')) &&
        !fs.existsSync(path.join(patchRpaDir, 'files', 'game', 'untouched.png')) &&
        rpaArts.length === 1 &&
        rpaArts[0].kind === 'loose_file' &&
        rpaArts[0].install_rel === 'game/script.rpy' &&
        rpaArts[0].action === 'add',
      `Unexpected RPA loose overlay outcome: ${JSON.stringify(wbRpa)}`
    );
    assert(
      fs.readFileSync(path.join(patchRpaDir, 'files', 'game', 'script.rpy'), 'utf8').includes('早上好，世界。'),
      'Loose script.rpy missing Simplified Chinese translation'
    );

    // 29c. NScripter NSA dual-track (scenario + ui): CP932 -> GBK auto strategy + GBK compat fallback (incl. '・') + papercup_patch.ini + unconditional dual-track acceptance/tamper + [vn.patch] re-assembly
    const wsNsa = path.join(root29, 'ws-nsa');
    const nsaSrc = path.join(root29, 'nsa-src');
    fs.mkdirSync(wsNsa, { recursive: true });
    fs.mkdirSync(path.join(nsaSrc, 'cg'), { recursive: true });
    fs.writeFileSync(
      path.join(wsNsa, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "first"\n',
      'utf8'
    );
    fs.writeFileSync(path.join(wsNsa, 'nscr.exe'), makeFakePeExe('x86'));
    const nsaScriptCp932 = encodeText(
      '*define\r\ngame\r\n*start\r\nおはよう、世界。\\\r\nselect "続ける",*start,"終わる",*end\r\n*end\r\nend\r\n',
      'cp932'
    );
    fs.writeFileSync(path.join(nsaSrc, '0.txt'), nsaScriptCp932);
    fs.writeFileSync(path.join(nsaSrc, 'cg', 'bg.bmp'), Buffer.alloc(2048, 0x22));
    fs.writeFileSync(path.join(nsaSrc, NSA_MANIFEST), JSON.stringify({ version: 1, files: [] }), 'utf8');
    repackNsa(nsaSrc, path.join(wsNsa, 'arc.nsa'));
    const origNsaBuf = fs.readFileSync(path.join(wsNsa, 'arc.nsa'));

    // Direct GBK compat fallback unit verification (including U+30FB katakana middle dot)
    const gbkCompatBuf = encodeText('〜・♪♡♥', 'gbk');
    assert(
      decodeBytes(gbkCompatBuf, 'gbk').text === '～·☆☆★',
      `Expected GBK compat fallback mapping, got: ${decodeBytes(gbkCompatBuf, 'gbk').text}`
    );

    await unpackVnArchives(wsNsa);
    await classifyVnScripts(wsNsa, {});
    // Explicitly partition into scenario + ui tracks so multi-track builtin GBK transcode (trackFiles.length === 2) is unconditionally exercised!
    const allNsaBuildRows = fs
      .readFileSync(path.join(wsNsa, '.papercup', 'data', 'build', 'scenario.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const nsaSelectRow = allNsaBuildRows.find((r) => String(r.source ?? '').includes('続ける'));
    const nsaScenBuildRows: Array<Record<string, unknown>> = allNsaBuildRows
      .filter((r) => r !== nsaSelectRow)
      .map((r) => ({ ...r, track: 'scenario' }));
    assert(
      nsaScenBuildRows.some((r) => String(r.source ?? '').includes('おはよう')) && Boolean(nsaSelectRow),
      `Expected both dialogue and select rows in classified NScripter build: ${JSON.stringify(allNsaBuildRows)}`
    );
    const nsaUiBuildRow: Record<string, unknown> = { ...nsaSelectRow!, track: 'ui', kind: 'choice' };
    fs.writeFileSync(
      path.join(wsNsa, '.papercup', 'data', 'build', 'scenario.jsonl'),
      nsaScenBuildRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(path.join(wsNsa, '.papercup', 'data', 'build', 'ui.jsonl'), JSON.stringify(nsaUiBuildRow) + '\n', 'utf8');
    // Keep .papercup/data/vn/text.json track counts synchronized with our dual-track split
    const nsaTextManifestPath = path.join(wsNsa, '.papercup', 'data', 'vn', 'text.json');
    const nsaTextManifest = JSON.parse(fs.readFileSync(nsaTextManifestPath, 'utf8'));
    nsaTextManifest.scenario = nsaScenBuildRows.length;
    nsaTextManifest.ui = 1;
    fs.writeFileSync(nsaTextManifestPath, JSON.stringify(nsaTextManifest, null, 2) + '\n', 'utf8');

    fs.mkdirSync(path.join(wsNsa, '.papercup', 'data', 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(wsNsa, '.papercup', 'data', 'results', 'scenario.jsonl'),
      nsaScenBuildRows
        .map((r) => {
          const src = String(r.source ?? '');
          const suffix = src.endsWith('\\') ? '\\' : '';
          const target = src.includes('おはよう') ? `早上好〜爱丽丝・星之歌♪♡♥${suffix}` : src;
          return JSON.stringify({
            id: r.id,
            file: r.file,
            line: r.line,
            kind: r.kind,
            track: 'scenario',
            source: src,
            target,
            ok: true,
          });
        })
        .join('\n') + '\n',
      'utf8'
    );
    const nsaUiSrc = String(nsaUiBuildRow.source);
    fs.writeFileSync(
      path.join(wsNsa, '.papercup', 'data', 'results', 'ui.jsonl'),
      JSON.stringify({
        id: nsaUiBuildRow.id,
        file: nsaUiBuildRow.file,
        line: nsaUiBuildRow.line,
        kind: nsaUiBuildRow.kind,
        track: 'ui',
        source: nsaUiSrc,
        target: nsaUiSrc.replace('続ける', '继续游戏').replace('終わる', '退出游戏'),
        ok: true,
      }) + '\n',
      'utf8'
    );

    const patchNsaGbk = path.join(root29, 'patch-nsa-gbk');
    const wbNsa1 = await writebackVnCopy(wsNsa, { dest: patchNsaGbk });
    const hook1 = wbNsa1.hook as Record<string, unknown>;
    const tracksAppliedNsa1 = (wbNsa1.tracks_applied ?? {}) as Record<string, number>;
    assert(
      wbNsa1.strategy === 'archive_replace' &&
        wbNsa1.encoding === 'gbk' &&
        wbNsa1.source_encoding === 'cp932' &&
        wbNsa1.hook_needed === true &&
        tracksAppliedNsa1.scenario === nsaScenBuildRows.length &&
        tracksAppliedNsa1.ui === 1 &&
        hook1.codepage === 936 &&
        hook1.charset === 134 &&
        hook1.target_exe === 'nscr.exe' &&
        hook1.target_arch === 'x86' &&
        fs.existsSync(path.join(patchNsaGbk, 'papercup_patch.ini')),
      `Unexpected NScripter dual-track GBK patch outcome: ${JSON.stringify(wbNsa1)}`
    );
    const iniText = fs.readFileSync(path.join(patchNsaGbk, 'papercup_patch.ini'), 'utf8');
    assert(
      iniText.includes('encoding=gbk') &&
        iniText.includes('codepage=936') &&
        iniText.includes('charset=134') &&
        iniText.includes('target_exe=nscr.exe') &&
        iniText.includes('target_arch=x86'),
      `Unexpected papercup_patch.ini contents: ${iniText}`
    );

    const verifyNsaGbkDir = path.join(root29, 'verify-nsa-gbk');
    unpackNsa(path.join(patchNsaGbk, 'files', 'arc.nsa'), verifyNsaGbkDir);
    const rawPatchedNsaBuf = fs.readFileSync(path.join(verifyNsaGbkDir, '0.txt'));
    assert(
      !rawPatchedNsaBuf.includes(Buffer.from('早上好', 'utf8')),
      'Multi-track GBK writeback must transcode 0.txt to GBK bytes rather than leaving UTF-8'
    );
    const patchedNsaTextGbk = decodeBytes(rawPatchedNsaBuf, 'gbk').text;
    assert(
      patchedNsaTextGbk.includes('早上好～爱丽丝·星之歌☆☆★') &&
        patchedNsaTextGbk.includes('继续游戏') &&
        patchedNsaTextGbk.includes('退出游戏'),
      `Expected dual-track GBK 0.txt with fallback symbols (incl. ・->·) and UI choices, got: ${patchedNsaTextGbk}`
    );

    // Unconditionally accept BOTH scenario & ui on patch_manifest.json & check release note metadata
    const accNsaScen = acceptVnRelease(wsNsa, {
      archive: String(wbNsa1.manifest_path),
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(!accNsaScen.blocked, `Expected scenario acceptance on patch_manifest.json, got: ${accNsaScen.text}`);
    const accNsaUi = acceptVnRelease(wsNsa, {
      archive: String(wbNsa1.manifest_path),
      track: 'ui',
      input: '.papercup/data/results/ui.jsonl',
    });
    assert(!accNsaUi.blocked, `Expected ui acceptance on patch_manifest.json, got: ${accNsaUi.text}`);
    const relNsaNote = releaseVnPatch(wsNsa, { dryRun: true });
    assert(
      relNsaNote.includes('增量补丁') &&
        relNsaNote.includes('archive_replace') &&
        relNsaNote.includes('gbk') &&
        relNsaNote.includes('CP936') &&
        relNsaNote.includes('papercup_patch.ini') &&
        relNsaNote.includes('仅供个人学习'),
      `Release note missing patch metadata: ${relNsaNote}`
    );

    // Tamper detection on patch_manifest.json artifact
    const patchedNsaPath = path.join(patchNsaGbk, 'files', 'arc.nsa');
    const goodPatchedNsaBuf = fs.readFileSync(patchedNsaPath);
    const tampered = Buffer.from(goodPatchedNsaBuf);
    tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(patchedNsaPath, tampered);
    const tamperedAcc = acceptVnRelease(wsNsa, {
      archive: String(wbNsa1.manifest_path),
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(
      tamperedAcc.blocked && tamperedAcc.text.includes('哈希或字节数与清单不一致'),
      `Expected tampered patch artifact to fail acceptance, got: ${JSON.stringify(tamperedAcc)}`
    );
    fs.writeFileSync(patchedNsaPath, goodPatchedNsaBuf);

    // Re-assemble with [vn.patch] override (encoding = "utf-8", hook_mode = "none")
    fs.appendFileSync(
      path.join(wsNsa, 'papercup.toml'),
      '\n[vn.patch]\nencoding = "utf-8"\nhook_mode = "none"\n',
      'utf8'
    );
    const statusWithPatchCfg = getVnStatus(wsNsa);
    assert(statusWithPatchCfg.includes('[vn.patch]'), `Expected vn_status to report [vn.patch] override, got: ${statusWithPatchCfg}`);

    const patchNsaUtf8 = path.join(root29, 'patch-nsa-utf8');
    const wbNsa2 = await writebackVnCopy(wsNsa, { dest: patchNsaUtf8 });
    assert(
      wbNsa2.encoding === 'utf-8' &&
        wbNsa2.hook_needed === false &&
        !fs.existsSync(path.join(patchNsaUtf8, 'papercup_patch.ini')),
      `Expected [vn.patch] re-assembly override to UTF-8 with hook_mode=none, got: ${JSON.stringify(wbNsa2)}`
    );
    const verifyNsaUtf8Dir = path.join(root29, 'verify-nsa-utf8');
    unpackNsa(path.join(patchNsaUtf8, 'files', 'arc.nsa'), verifyNsaUtf8Dir);
    const patchedNsaTextUtf8 = fs.readFileSync(path.join(verifyNsaUtf8Dir, '0.txt'), 'utf8');
    assert(
      patchedNsaTextUtf8.includes('早上好〜爱丽丝・星之歌♪♡♥') &&
        patchedNsaTextUtf8.includes('继续游戏') &&
        patchedNsaTextUtf8.includes('退出游戏'),
      `Expected UTF-8 re-assembled 0.txt to preserve original Unicode symbols & UI track, got: ${patchedNsaTextUtf8}`
    );
    assert(fs.readFileSync(path.join(wsNsa, 'arc.nsa')).equals(origNsaBuf), 'Original arc.nsa must remain byte-identical');

    // 29d. Pure-ASCII CRLF batch scripts + live Windows install/uninstall roundtrip
    assertAsciiCrlfBat(path.join(patchXp3Dir1, 'install_patch.bat'));
    assertAsciiCrlfBat(path.join(patchXp3Dir1, 'uninstall_patch.bat'));
    assertAsciiCrlfBat(path.join(patchNsaGbk, 'install_patch.bat'));
    assertAsciiCrlfBat(path.join(patchNsaGbk, 'uninstall_patch.bat'));

    if (process.platform === 'win32') {
      const dummyGame = path.join(root29, 'dummy-nsa-game');
      fs.mkdirSync(dummyGame, { recursive: true });
      fs.writeFileSync(path.join(dummyGame, 'arc.nsa'), origNsaBuf);
      fs.writeFileSync(path.join(dummyGame, 'nscr.exe'), makeFakePeExe('x86'));

      execFileSync('cmd.exe', ['/c', path.join(patchNsaGbk, 'install_patch.bat'), dummyGame], { stdio: 'pipe' });
      assert(fs.readFileSync(path.join(dummyGame, 'arc.nsa')).equals(goodPatchedNsaBuf), 'install_patch.bat did not install patched arc.nsa');
      assert(fs.existsSync(path.join(dummyGame, 'papercup_patch.ini')), 'install_patch.bat did not install papercup_patch.ini');
      assert(
        fs.readFileSync(path.join(dummyGame, '.papercup_backup', 'arc.nsa')).equals(origNsaBuf),
        'install_patch.bat did not back up original arc.nsa'
      );

      execFileSync('cmd.exe', ['/c', path.join(patchNsaGbk, 'uninstall_patch.bat'), dummyGame], { stdio: 'pipe' });
      assert(fs.readFileSync(path.join(dummyGame, 'arc.nsa')).equals(origNsaBuf), 'uninstall_patch.bat did not restore original arc.nsa');
      assert(!fs.existsSync(path.join(dummyGame, 'papercup_patch.ini')), 'uninstall_patch.bat did not remove papercup_patch.ini');
      assert(!fs.existsSync(path.join(dummyGame, '.papercup_backup')), 'uninstall_patch.bat did not clean up empty .papercup_backup');
    }

    // 29e. Prompt regression guard: no Stage 0 CP932 hard stop anywhere
    assert(
      !PAPERCUP_SYSTEM_PROMPT.includes('EARLY_BLOCKER: CP932_VS_ZH_CN') &&
        !BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('EARLY_BLOCKER: CP932_VS_ZH_CN'),
      'CP932 early blocker hard stop must be removed from prompts'
    );
  });

  // 30. 系统护栏加固（禁 bash 越界写盘、禁 heredoc、禁启停游戏进程、消费端寻址约束与手工 unpack 提示）
  console.log('30. Verifying bash external-write/process/heredoc guards, manual unpack hint, and reverser consumer-side addressing prompts...');
  await withIsolatedHomeAndEnv('papercup-guards-30-', async ({ root: root30, ws: ws30 }) => {
    fs.mkdirSync(path.join(ws30, '.papercup', 'tmp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws30, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n',
      'utf8'
    );

    // 30a. External write via bash must be blocked; workspace writes & external read-only commands must pass
    const blockedExternalWrites = [
      'cp .papercup/tmp/pal/charset.json E:/papercup_patch/sample_zhCN_v2/charset.json',
      'mkdir -p E:/papercup_patch/sample_zhCN_v2/tools',
      'D=/e/pcup_diag; rm -rf $D; mkdir -p $D',
      'for t in t_orig t_v2; do cp -r .papercup/tmp/run_base /e/pcup_diag/$t; done',
      'cd /e/pcup_diag && cat > runtest.bat',
      'cat > /e/pcup_diag/drive.py',
      'rm -rf ../escape_dir',
    ];
    for (const cmd of blockedExternalWrites) {
      assert(
        detectBlockedExternalWriteCommand(cmd, ws30) !== null,
        `Expected external bash write to be blocked: ${cmd}`
      );
    }

    const allowedBashCommands = [
      'cp .papercup/tmp/a.txt unpacked/a.txt',
      'mkdir -p .papercup/tmp/pal && python .papercup/tmp/probe.py > .papercup/tmp/out.txt 2>/dev/null',
      'python -c "if 2 > 1: print(\'ok\')"',
      'ls C:/Windows/Fonts/ | head -5',
      'sha256sum E:/papercup_patch/sample_zhCN/data.pac',
      'rm -rf .papercup/tmp/old',
    ];
    for (const cmd of allowedBashCommands) {
      assert(
        detectBlockedExternalWriteCommand(cmd, ws30) === null,
        `Unexpected false positive in external write guard for: ${cmd} -> ${detectBlockedExternalWriteCommand(cmd, ws30)}`
      );
    }

    // 30b. Process control / game launching via bash must be blocked; CLI/read-only commands must pass
    const blockedProcessCmds = [
      'taskkill //IM sample_game.exe //F',
      'start "" sample_game.exe',
      'Start-Process sample_game.exe',
      'cmd //c runtest.bat "E:\\pcup_diag\\t_v2"',
      'cmd //c "mklink /J run_v_orig\\bgm.pac E:\\orig\\bgm.pac"',
      './sample_game/sample_game.exe',
    ];
    for (const cmd of blockedProcessCmds) {
      assert(
        detectBlockedProcessControlCommand(cmd) !== null,
        `Expected process-control command to be blocked: ${cmd}`
      );
    }

    const allowedProcessCmds = [
      'python .papercup/tmp/probe.py',
      'python -c "import os; start = 1; print(start)"',
      'git status --short',
      'certutil -hashfile sample_game/data.pac SHA256',
      'powershell -NoProfile -Command "Get-WinEvent -MaxEvents 1"',
    ];
    for (const cmd of allowedProcessCmds) {
      assert(
        detectBlockedProcessControlCommand(cmd) === null,
        `Unexpected false positive in process guard for: ${cmd} -> ${detectBlockedProcessControlCommand(cmd)}`
      );
    }

    // 30c. Bash heredocs must be blocked; quoted bit-shifts and <<< here-strings must pass
    for (const cmd of [
      "cat > .papercup/tmp/a.py <<'EOF'\nprint(1)\nEOF",
      'python - <<EOF\nprint(1)\nEOF',
      'cat <<-END\nhi\nEND',
    ]) {
      assert(detectBlockedBashHeredocCommand(cmd) !== null, `Expected heredoc to be blocked: ${cmd}`);
    }
    for (const cmd of [
      'python -c "print(1 << 8); print(\'a << b\')"',
      'echo "a << EOF"',
      'grep foo <<< "foo bar"',
    ]) {
      assert(
        detectBlockedBashHeredocCommand(cmd) === null,
        `Unexpected false positive in heredoc guard for: ${cmd}`
      );
    }

    // 30d. Guarded bash tool returns blocked error without executing shell (using temp-dir sibling outside ws30, no hardcoded drive letter)
    const outsideBlockedDir30 = path.join(root30, 'pcup_diag_should_not_exist');
    const outsideBlockedPosix30 = outsideBlockedDir30.replace(/\\/g, '/');
    const guardedTools30 = createGuardedBuiltinToolDefinitions(ws30, ['bash']);
    const bashTool30 = guardedTools30.find((t) => t.name === 'bash')!;
    for (const cmd of [
      `mkdir -p "${outsideBlockedPosix30}"`,
      'taskkill //IM notepad.exe //F',
      "cat > .papercup/tmp/t.py <<'EOF'\nprint(1)\nEOF",
    ]) {
      const res = (await bashTool30.execute('tc-30', { command: cmd }, undefined, undefined, {} as any)) as any;
      assert(
        res?.isError === true && res?.details?.blocked === true,
        `Expected guarded bash tool to block "${cmd}", got: ${JSON.stringify(res)}`
      );
    }
    assert(!fs.existsSync(outsideBlockedDir30), 'Blocked external mkdir must not have executed');

    // 30e. Manual unpack.py output in .papercup/tmp/unpacked/ without .skill-manifest.json produces explicit vn_unpack hint
    fs.mkdirSync(path.join(ws30, '.papercup', 'tmp', 'unpacked', 'data.pac'), { recursive: true });
    fs.writeFileSync(path.join(ws30, '.papercup', 'tmp', 'unpacked', 'data.pac', '_pac_manifest.json'), '{"format":"PAC "}\n', 'utf8');
    let manualUnpackErr = '';
    try {
      await writebackVnCopy(ws30, { dest: path.join(root30, 'patch-fail') });
    } catch (err) {
      manualUnpackErr = (err as Error).message;
    }
    assert(
      manualUnpackErr.includes('vn_unpack') && manualUnpackErr.includes('.skill-manifest.json'),
      `Expected actionable vn_unpack manifest error, got: ${manualUnpackErr}`
    );

    // 30f. Prompt constraint regression checks
    assert(
      BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('Consumer-Side Addressing Verification') &&
        BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('offset/pointer') &&
        BUILTIN_SUBAGENTS.reverser.systemPrompt.includes('control_pattern'),
      'Reverser prompt missing mandatory consumer-side addressing or control_pattern constraints'
    );
    assert(
      PAPERCUP_SYSTEM_PROMPT.includes('崩溃/异常与“补丁未生效”故障排查铁律') &&
        PAPERCUP_SYSTEM_PROMPT.includes('严禁手工调用 `unpack.py`') &&
        PAPERCUP_SYSTEM_PROMPT.includes('严禁通过 `bash` 启动或 `taskkill` 游戏'),
      'Main system prompt missing crash-diagnosis or sandbox/process-guard constraints'
    );
  });

  // 31. 受控运行时冒烟测试（vn_smoke_test）：UI 配置持久化、硬链接隔离、类 ESLint 规则引擎、2 轮自修上限、多模态降级与 vn_accept 门禁
  console.log('31. Verifying runtime smoke test (vn_smoke_test), config API, hardlink sandbox, ESLint rules, vision fallback, and accept gate...');
  await withIsolatedHomeAndEnv('papercup-smoke-31-', async ({ root: root31, ws: ws31 }) => {
    const toolsRoot31 = path.join(root31, 'tools');
    fs.mkdirSync(path.join(ws31, 'save'), { recursive: true });
    fs.mkdirSync(path.join(toolsRoot31, 'Textractor', 'x86'), { recursive: true });
    fs.mkdirSync(path.join(toolsRoot31, 'Textractor', 'x64'), { recursive: true });
    fs.mkdirSync(path.join(toolsRoot31, 'LE'), { recursive: true });
    const fakeTr86 = path.join(toolsRoot31, 'Textractor', 'x86', 'TextractorCLI.exe');
    const fakeTr64 = path.join(toolsRoot31, 'Textractor', 'x64', 'TextractorCLI.exe');
    const fakeLe = path.join(toolsRoot31, 'LE', 'LEProc.exe');
    fs.writeFileSync(fakeTr86, 'MZ', 'ascii');
    fs.writeFileSync(fakeTr64, 'MZ', 'ascii');
    fs.writeFileSync(fakeLe, 'MZ', 'ascii');

    let svc31: AgentService | null = null;
    let svc31Reload: AgentService | null = null;
    try {
      // Build synthetic KiriKiri workspace with x86 PE Game.exe, user save, and a homograph proper-noun line
      fs.writeFileSync(
        path.join(ws31, 'papercup.toml'),
        '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "first"\n',
        'utf8'
      );
      const peX86 = Buffer.alloc(256, 0);
      peX86[0] = 0x4d;
      peX86[1] = 0x5a;
      peX86.writeUInt32LE(0x80, 0x3c);
      peX86[0x80] = 0x50;
      peX86[0x81] = 0x45;
      peX86.writeUInt16LE(0x014c, 0x84);
      fs.writeFileSync(path.join(ws31, 'Game.exe'), peX86);
      fs.writeFileSync(path.join(ws31, 'save', 'user_save.dat'), 'DO_NOT_TOUCH', 'utf8');

      const ksOrig = encodeText('*start\r\n桜井咲[p]\r\nおはよう、世界。[p]\r\n今日はいい天気だね。[p]\r\n', 'cp932');
      packDeltaXp3(
        [
          ['scenario/first.ks', ksOrig],
          ['image/bg.png', Buffer.alloc(1024, 0x77)],
        ],
        path.join(ws31, 'data.xp3')
      );
      const origXp3Buf = fs.readFileSync(path.join(ws31, 'data.xp3'));

      await unpackVnArchives(ws31);
      await classifyVnScripts(ws31, {});
      const buildRows = fs
        .readFileSync(path.join(ws31, '.papercup', 'data', 'build', 'scenario.jsonl'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const writeResults31 = (firstGreetingTarget: string) => {
        fs.mkdirSync(path.join(ws31, '.papercup', 'data', 'results'), { recursive: true });
        fs.writeFileSync(
          path.join(ws31, '.papercup', 'data', 'results', 'scenario.jsonl'),
          buildRows
            .map((r) => {
              const src = String(r.source ?? r.text ?? '');
              let target = src;
              if (src.includes('桜井咲')) target = '桜井咲[p]'; // Homograph (source === target)
              else if (src.includes('おはよう')) target = firstGreetingTarget;
              else target = '今天天气真好呢。[p]';
              return JSON.stringify({
                id: r.id,
                file: r.file,
                line: r.line,
                kind: r.kind,
                track: 'scenario',
                source: src,
                target,
                ok: true,
              });
            })
            .join('\n') + '\n',
          'utf8'
        );
      };
      writeResults31('早上好，世界。[p]');

      // 31a. REST API & global persistence + tool auto-discovery
      svc31 = new AgentService(ws31, {
        sessionMode: 'persist',
        filePicker: async (opts) => ({
          canceled: false,
          path: opts?.title?.includes('Textractor') ? fakeTr86 : fakeLe,
        }),
      });
      const router31 = createApiRouter(svc31);

      const getInitRes = await router31.request('/api/smoke/config');
      assert(getInitRes.status === 200, `Expected 200 on GET /api/smoke/config, got ${getInitRes.status}`);
      const getInitBody = await getInitRes.json();
      assert(getInitBody.effective.enabled === false, 'Smoke gate should default to disabled');

      const pickTrRes = await router31.request('/api/smoke/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'textractor' }),
      });
      const pickTrBody = await pickTrRes.json();
      assert(pickTrRes.status === 200 && pickTrBody.path === fakeTr86, `Unexpected smoke pick response: ${JSON.stringify(pickTrBody)}`);

      const saveSmokeRes = await router31.request('/api/smoke/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          visionEnabled: true,
          textractorPath: fakeTr86,
          localeEmulatorPath: path.dirname(fakeLe),
          timeoutSec: 60,
          advanceSteps: 12,
        }),
      });
      assert(saveSmokeRes.status === 200, `Expected 200 saving smoke config, got ${saveSmokeRes.status}`);
      const saveSmokeBody = await saveSmokeRes.json();
      assert(
        saveSmokeBody.effective.enabled === true &&
          saveSmokeBody.tools.textractor.available === true &&
          saveSmokeBody.tools.textractor.x86Path === fakeTr86 &&
          saveSmokeBody.tools.textractor.x64Path === fakeTr64 &&
          saveSmokeBody.tools.localeEmulator.available === true &&
          saveSmokeBody.tools.localeEmulator.leProcPath === fakeLe,
        `Unexpected saved smoke config state: ${JSON.stringify(saveSmokeBody)}`
      );
      (svc31 as any).disposeCurrentSessionState?.(true);
      svc31 = null;

      // Restart recovery of ~/.papercup/smoke.json
      svc31Reload = new AgentService(ws31, { sessionMode: 'persist' });
      const reloadedCfg = svc31Reload.getSmokeConfigState();
      assert(
        reloadedCfg.global.enabled === true &&
          reloadedCfg.global.timeoutSec === 60 &&
          reloadedCfg.global.advanceSteps === 12 &&
          reloadedCfg.tools.textractor.x86Path === fakeTr86,
        `Expected persisted smoke.json reload, got: ${JSON.stringify(reloadedCfg)}`
      );
      (svc31Reload as any).disposeCurrentSessionState?.(true);
      svc31Reload = null;

      // 31b. Build delta patch & verify hardlink sandbox isolation + inode safety + auto cleanup
      const patchDir31 = path.join(root31, 'patch-31');
      const wb31 = await writebackVnCopy(ws31, { dest: patchDir31 });
      const manifest31 = String(wb31.manifest_path);
      assert(
        fs.existsSync(path.join(ws31, '.papercup', 'data', 'vn', 'last-patch.json')),
        'writebackVnCopy should record .papercup/data/vn/last-patch.json for vn_smoke_test auto-discovery'
      );

      const sb = prepareSmokeSandbox(ws31, manifest31);
      assert(fs.existsSync(sb.exePath) && sb.exeArch === 'x86', `Expected x86 exe in sandbox: ${sb.exePath}`);
      assert(fs.existsSync(path.join(sb.sandboxDir, 'patch.xp3')), 'Patched patch.xp3 must be overlaid in sandbox');
      assert(
        !fs.existsSync(path.join(sb.sandboxDir, 'save', 'user_save.dat')) &&
          fs.existsSync(path.join(sb.sandboxDir, 'save')),
        'Sandbox must have isolated empty save/ without user save data'
      );
      sb.cleanup();
      assert(!fs.existsSync(sb.sandboxDir), 'Sandbox cleanup must remove temporary hardlink directory');
      assert(fs.readFileSync(path.join(ws31, 'data.xp3')).equals(origXp3Buf), 'Original data.xp3 must remain untouched');

      // 31c. Hard gate blocks when smoke test not yet run
      const accBeforeSmoke = acceptVnRelease(ws31, {
        archive: manifest31,
        track: 'scenario',
        input: '.papercup/data/results/scenario.jsonl',
      });
      assert(
        accBeforeSmoke.blocked && accBeforeSmoke.text.includes('accept.smoke.missing'),
        `Expected vn_accept to block when smoke gate enabled & unrun, got: ${JSON.stringify(accBeforeSmoke)}`
      );

      // Round 1 fail: runtime.crash (with 0x00030761) + real UTF-8-as-CP932 pure-Hanzi (zero half-width katakana / U+FFFD) text.mojibake + vision refusal graceful degradation
      const realUtf8AsCp932Mojibake = decodeBytes(
        Buffer.from('世界朋友冒险希望选择结束', 'utf8'),
        'cp932'
      ).text;
      assert(
        !/[\uFFFD\uFF61-\uFF9F]/.test(realUtf8AsCp932Mojibake),
        `Mojibake test fixture must be pure all-Hanzi without half-width katakana or U+FFFD: ${realUtf8AsCp932Mojibake}`
      );
      const dummyPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      const mockCrashDriver: SmokeExecutionDriver = {
        async run(input) {
          const f1 = path.join(input.framesDir, '01_title.png');
          fs.writeFileSync(f1, dummyPng);
          return {
            launched: true,
            windowFound: true,
            windowTitle: 'Test Game',
            inputMode: 'background',
            stepsAdvanced: 3,
            durationMs: 2400,
            processExitedEarly: true,
            exitCode: -1073741819,
            hungDetected: false,
            frozenScreen: false,
            crashEvent: {
              faultingModule: 'Game.exe',
              exceptionCode: '0xc0000005',
              faultOffset: '0x00030761',
            },
            frames: [{ label: 'title', step: 0, path: f1, hash: 'h1', width: 1, height: 1 }],
            textractorLines: [realUtf8AsCp932Mojibake],
          };
        },
      };
      const smokeFail1 = await runVnSmokeTest(ws31, {
        driver: mockCrashDriver,
        vision: {
          inspectFrames: async () => ({
            status: 'skipped',
            reason: '视觉审核触发内容审查或模型拒答，已自动降级为 warning（不阻断验收）。',
            defects: [],
          }),
        },
      });
      const findings1 = smokeFail1.findings as Array<{ ruleId: string; severity: string }>;
      assert(
        smokeFail1.ok === false &&
          smokeFail1.repairRound === 1 &&
          smokeFail1.repairLimitReached === false &&
          findings1.some((f) => f.ruleId === 'runtime.crash' && f.severity === 'error') &&
          findings1.some((f) => f.ruleId === 'text.mojibake' && f.severity === 'error') &&
          findings1.some((f) => f.ruleId === 'vision.skipped' && f.severity === 'warning'),
        `Unexpected round-1 smoke failure report (all-Hanzi UTF-8-as-CP932 mojibake="${realUtf8AsCp932Mojibake}"): ${JSON.stringify(smokeFail1)}`
      );
      const accAfterFail = acceptVnRelease(ws31, {
        archive: manifest31,
        track: 'scenario',
        input: '.papercup/data/results/scenario.jsonl',
      });
      assert(
        accAfterFail.blocked && accAfterFail.text.includes('accept.smoke.failed') && accAfterFail.text.includes('0x00030761'),
        `Expected vn_accept to block with fault offset on failed smoke report, got: ${JSON.stringify(accAfterFail)}`
      );

      // Round 2 fail: homograph ('桜井咲') must NOT mask text.not_patched + repairLimitReached=true
      const mockNotPatchedDriver: SmokeExecutionDriver = {
        async run() {
          return {
            launched: true,
            windowFound: true,
            windowTitle: 'Test Game',
            inputMode: 'foreground_fallback',
            stepsAdvanced: 12,
            durationMs: 4100,
            processExitedEarly: false,
            exitCode: 0,
            hungDetected: false,
            frozenScreen: false,
            frames: [],
            textractorLines: ['桜井咲', 'おはよう、世界。', '今日はいい天気だね。'],
          };
        },
      };
      const smokeFail2 = await runVnSmokeTest(ws31, {
        driver: mockNotPatchedDriver,
        skipVision: true,
      });
      const findings2 = smokeFail2.findings as Array<{ ruleId: string; severity: string }>;
      assert(
        smokeFail2.ok === false &&
          smokeFail2.repairRound === 2 &&
          smokeFail2.repairLimitReached === true &&
          findings2.some((f) => f.ruleId === 'text.not_patched' && f.severity === 'error'),
        `Expected round-2 repairLimitReached + text.not_patched (despite homograph line), got: ${JSON.stringify(smokeFail2)}`
      );

      // Escape hatch: allowSkipSmoke=true allows accept with warning & surfaces in release note
      const accSkipped = acceptVnRelease(ws31, {
        archive: manifest31,
        track: 'scenario',
        input: '.papercup/data/results/scenario.jsonl',
        allowSkipSmoke: true,
      });
      assert(
        !accSkipped.blocked && accSkipped.text.includes('accept.smoke.skipped_override'),
        `Expected allowSkipSmoke escape hatch to pass with warning, got: ${JSON.stringify(accSkipped)}`
      );
      const relSkipped = releaseVnPatch(ws31, { dryRun: true });
      assert(relSkipped.includes('已显式跳过门禁'), `Expected release note to record skip override: ${relSkipped}`);

      // Passing run (with non-blocking vision warning) resets repairRound=0 and unlocks normal vn_accept
      const mockPassDriver: SmokeExecutionDriver = {
        async run(input) {
          const f1 = path.join(input.framesDir, '01_title.png');
          const f2 = path.join(input.framesDir, '02_dialogue_start.png');
          fs.writeFileSync(f1, dummyPng);
          fs.writeFileSync(f2, dummyPng);
          return {
            launched: true,
            windowFound: true,
            windowTitle: 'Test Game',
            inputMode: 'background',
            stepsAdvanced: 12,
            durationMs: 3200,
            processExitedEarly: false,
            exitCode: 0,
            hungDetected: false,
            frozenScreen: false,
            frames: [
              { label: 'title', step: 0, path: f1, hash: 'h1', width: 1, height: 1 },
              { label: 'dialogue_start', step: 2, path: f2, hash: 'h2', width: 1, height: 1 },
            ],
            textractorLines: ['早上好，世界。', '今天天气真好呢。'],
          };
        },
      };
      const smokePass = await runVnSmokeTest(ws31, {
        driver: mockPassDriver,
        vision: {
          inspectFrames: async () => ({
            status: 'checked',
            defects: [{ severity: 'warning', kind: 'tofu_boxes', description: '标题角落存在 1 处轻微缺字', frame: 'title' }],
          }),
        },
      });
      assert(
        smokePass.ok === true &&
          smokePass.errorCount === 0 &&
          smokePass.warningCount === 1 &&
          smokePass.repairRound === 0 &&
          smokePass.repairLimitReached === false &&
          (smokePass.textractor as any)?.matchedTranslated >= 2,
        `Expected clean smoke pass with 1 vision warning, got: ${JSON.stringify(smokePass)}`
      );

      const accAfterPass = acceptVnRelease(ws31, {
        archive: manifest31,
        track: 'scenario',
        input: '.papercup/data/results/scenario.jsonl',
      });
      assert(!accAfterPass.blocked, `Expected normal vn_accept to pass after smoke pass, got: ${JSON.stringify(accAfterPass)}`);
      const relPassed = releaseVnPatch(ws31, { dryRun: true });
      assert(relPassed.includes('运行时冒烟测试：通过'), `Expected release note to include smoke pass summary: ${relPassed}`);

      // Stale smoke report detection when translation genuinely changes & patch is rebuilt (no manual manifest timestamp hack)
      writeResults31('早安，全新世界。[p]');
      const patchDir31B = path.join(root31, 'patch-31-b');
      const wb31B = await writebackVnCopy(ws31, { dest: patchDir31B });
      const manifest31B = String(wb31B.manifest_path);
      const accStale = acceptVnRelease(ws31, {
        archive: manifest31B,
        track: 'scenario',
        input: '.papercup/data/results/scenario.jsonl',
      });
      assert(
        accStale.blocked && accStale.text.includes('accept.smoke.stale'),
        `Expected genuinely rebuilt patch manifest to trigger accept.smoke.stale, got: ${JSON.stringify(accStale)}`
      );

      // 31d. createSmokeVisionBridge text-only degradation, safety refusal fallback & JSON parsing
      const frameSample = path.join(root31, 'sample.png');
      fs.writeFileSync(frameSample, dummyPng);
      let visionCallCount = 0;
      const textOnlyBridge = createSmokeVisionBridge({
        getModel: () => ({ id: 'deepseek-chat', provider: 'deepseek', input: ['text'] } as any),
        getModelRuntime: () =>
          ({
            completeSimple: async () => {
              visionCallCount++;
              throw new Error('should not be called');
            },
          }) as any,
      });
      const textOnlyRes = await textOnlyBridge.inspectFrames!(
        [{ label: 'title', path: frameSample }],
        { targetLang: 'zh-CN', sampleTranslations: [] }
      );
      assert(
        textOnlyRes.status === 'skipped' && visionCallCount === 0,
        `Text-only model must skip vision without calling completeSimple: ${JSON.stringify(textOnlyRes)}`
      );

      const refusalBridge = createSmokeVisionBridge({
        getModel: () => ({ id: 'vision-model', provider: 'google', input: ['text', 'image'] } as any),
        getModelRuntime: () =>
          ({
            completeSimple: async () => ({
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: 'Sorry, I cannot assist with explicit content in this image.' }],
            }),
          }) as any,
      });
      const refusalRes = await refusalBridge.inspectFrames!(
        [{ label: 'title', path: frameSample }],
        { targetLang: 'zh-CN', sampleTranslations: [] }
      );
      assert(
        refusalRes.status === 'skipped' && refusalRes.defects.length === 0,
        `Moderation refusal must gracefully degrade to skipped warning: ${JSON.stringify(refusalRes)}`
      );

      let recordedVisionUsage = false;
      const workingVisionBridge = createSmokeVisionBridge({
        getModel: () => ({ id: 'vision-model', provider: 'google', input: ['text', 'image'] } as any),
        getModelRuntime: () =>
          ({
            completeSimple: async () => ({
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: '{"found": true, "xNorm": 0.52, "yNorm": 0.74, "label": "はじめから"}' }],
              usage: { input: 120, output: 18, cacheRead: 0, cacheWrite: 0, totalTokens: 138, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            }),
          }) as any,
        onUsage: () => {
          recordedVisionUsage = true;
        },
      });
      const btnRes = await workingVisionBridge.locateStartButton!(frameSample);
      assert(
        btnRes.found === true && btnRes.xNorm === 0.52 && btnRes.yNorm === 0.74 && recordedVisionUsage,
        `Unexpected vision start-button parse result: ${JSON.stringify(btnRes)}`
      );

      // 31e. Tool registration, nested Textractor dir + LEConfig.xml profile selection + Textractor UTF-16LE/Clipboard filter + prompt coverage
      const nestedTrRoot = path.join(root31, 'tr-zip-root');
      fs.mkdirSync(path.join(nestedTrRoot, 'Textractor', 'x86'), { recursive: true });
      fs.mkdirSync(path.join(nestedTrRoot, 'Textractor', 'x64'), { recursive: true });
      const nested86 = path.join(nestedTrRoot, 'Textractor', 'x86', 'TextractorCLI.exe');
      const nested64 = path.join(nestedTrRoot, 'Textractor', 'x64', 'TextractorCLI.exe');
      fs.writeFileSync(nested86, 'MZ', 'utf8');
      fs.writeFileSync(nested64, 'MZ', 'utf8');
      fs.writeFileSync(
        path.join(path.dirname(fakeLe), 'LEConfig.xml'),
        '<?xml version="1.0" encoding="utf-8"?><LEConfig><Profiles>' +
          '<Profile Name="JP" Guid="guid-ja-932" MainMenu="true"><Location>ja-JP</Location></Profile>' +
          '<Profile Name="ZH" Guid="guid-zh-936" MainMenu="true"><Location>zh-CN</Location></Profile>' +
          '</Profiles></LEConfig>',
        'utf8'
      );
      const nestedInspect = inspectSmokeTools({
        ...DEFAULT_SMOKE_CONFIG,
        textractorPath: nestedTrRoot,
        localeEmulatorPath: fakeLe,
      });
      assert(
        nestedInspect.textractor.available &&
          nestedInspect.textractor.x86Path === nested86 &&
          nestedInspect.textractor.x64Path === nested64 &&
          nestedInspect.localeEmulator.note.includes('ja-JP') &&
          nestedInspect.localeEmulator.note.includes('zh-CN'),
        `Nested Textractor/ and LEConfig.xml inspection failed: ${JSON.stringify(nestedInspect)}`
      );
      assert(
        findLocaleEmulatorProfileGuid(fakeLe, 936) === 'guid-zh-936' &&
          findLocaleEmulatorProfileGuid(fakeLe, 932) === 'guid-ja-932',
        `LEConfig.xml GUID selection mismatch: 936=${findLocaleEmulatorProfileGuid(fakeLe, 936)}, 932=${findLocaleEmulatorProfileGuid(fakeLe, 932)}`
      );
      const parsedTrLines = parseTextractorOutputChunk(
        Buffer.from(
          "Usage: {'attach'|'detach'|hookcode} -Pprocessid\r\n" +
            '[1:0:0:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:Clipboard:HB0@0] secret-clipboard-noise\r\n' +
            "[0:0:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:Console:HB0@0] Textractor: couldn't inject\r\n" +
            '[2:1A4:75C01234:0:0:TextOutA:HS0@0] 早上好，世界。\r\n',
          'utf16le'
        )
      );
      assert(
        parsedTrLines.length === 1 && parsedTrLines[0] === '早上好，世界。',
        `Expected Textractor parser to decode UTF-16LE and strip Clipboard/Console noise, got: ${JSON.stringify(parsedTrLines)}`
      );

      const vnTools31 = createVnTools(() => ws31);
      assert(vnTools31.some((t) => t.name === 'vn_smoke_test'), 'vn_smoke_test must be registered in createVnTools');
      assert(
        PAPERCUP_SYSTEM_PROMPT.includes('vn_smoke_test') && PAPERCUP_SYSTEM_PROMPT.includes('最多 2 轮'),
        'PAPERCUP_SYSTEM_PROMPT missing vn_smoke_test and 2-round repair limit guidance'
      );
    } finally {
      (svc31 as any)?.disposeCurrentSessionState?.(true);
      (svc31Reload as any)?.disposeCurrentSessionState?.(true);
    }
  });

  // 32. 烟测驱动编码与工具故障分流（harness.driver_failed）、旧状态兼容、失败现场保留、备份源封包拒绝及受保护文件硬护栏
  console.log('32. Verifying smoke driver ASCII+BOM, harness failure accounting, legacy repair compat, failure diagnostics retention, backup-source rejection, and protected file guards...');
  await withIsolatedHomeAndEnv('papercup-hardening-32-', async ({ root: root32, home: home32, ws: ws32 }) => {
    fs.mkdirSync(path.join(ws32, 'game', 'backup'), { recursive: true });
    fs.mkdirSync(path.join(ws32, '.papercup', 'tmp', 'work', 'out'), { recursive: true });
    fs.mkdirSync(path.join(ws32, '.papercup', 'tmp'), { recursive: true });

    // 32a. Smoke driver PS1 source must be 100% pure ASCII, written with UTF-8 BOM, and use structural dialog/event detection (not fragile CJK button-label hacks)
    const psSrc = getWindowsSmokeDriverSource();
    const nonAsciiMatches = psSrc.match(/[^\x00-\x7F]/g);
    assert(
      !nonAsciiMatches,
      `Smoke driver PS1 must be strictly ASCII, found non-ASCII chars: ${JSON.stringify(nonAsciiMatches)}`
    );
    assert(
      psSrc.includes('GetClassNameW') &&
        psSrc.includes('"Button"') &&
        psSrc.includes('IsErrorDialog') &&
        psSrc.includes("ProviderName = 'Application Error'") &&
        psSrc.includes('$props[3]') &&
        psSrc.includes('$props[6]') &&
        psSrc.includes('$props[7]') &&
        psSrc.includes("event = 'driver_ready'"),
      'Smoke driver PS1 must use structural Win32 dialog/button class checks, structured Event ID 1000 Properties, and emit driver_ready'
    );
    const driverOut = path.join(root32, 'driver_check.ps1');
    writeWindowsSmokeDriverScript(driverOut);
    const driverBytes = fs.readFileSync(driverOut);
    assert(
      driverBytes.length > 3 && driverBytes[0] === 0xef && driverBytes[1] === 0xbb && driverBytes[2] === 0xbf,
      'writeWindowsSmokeDriverScript must prepend UTF-8 BOM (EF BB BF)'
    );
    assert(
      !/[^\x00-\x7F]/.test(driverBytes.subarray(3).toString('utf8')),
      'Written PS1 body after UTF-8 BOM must remain pure ASCII'
    );

    // Prepare synthetic KiriKiri workspace with game/data.xp3, game/backup/data.xp3, Game.exe, engine.dll
    fs.writeFileSync(
      path.join(ws32, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n',
      'utf8'
    );
    const peX86 = Buffer.alloc(256, 0);
    peX86[0] = 0x4d;
    peX86[1] = 0x5a;
    peX86.writeUInt32LE(0x80, 0x3c);
    peX86[0x80] = 0x50;
    peX86[0x81] = 0x45;
    peX86.writeUInt16LE(0x014c, 0x84);
    fs.writeFileSync(path.join(ws32, 'game', 'Game.exe'), peX86);
    fs.writeFileSync(path.join(ws32, 'game', 'engine.dll'), peX86);

    const ksOrig = encodeText('*start\r\nテスト台詞一。[p]\r\nテスト台詞二。[p]\r\n', 'cp932');
    packDeltaXp3([['scenario/first.ks', ksOrig]], path.join(ws32, 'game', 'data.xp3'));
    fs.copyFileSync(path.join(ws32, 'game', 'data.xp3'), path.join(ws32, 'game', 'backup', 'data.xp3'));
    fs.copyFileSync(path.join(ws32, 'game', 'data.xp3'), path.join(ws32, 'game', 'data.xp3.bak'));

    // 32d (part 1): vn_detect / scanWorkspace skips backup/ and *.bak
    const scan32 = scanWorkspace(ws32, home32);
    assert(
      scan32.hits.length === 1 && scan32.hits[0].path === 'game/data.xp3',
      `scanWorkspace must detect only game/data.xp3 and skip backup/ & *.bak, got: ${JSON.stringify(scan32.hits)}`
    );

    // Unpack original archive & build valid .papercup/data/results/scenario.jsonl
    await unpackVnArchives(ws32, { archive: 'game/data.xp3', dest: '.papercup/tmp/unpacked/data.xp3' });
    await classifyVnScripts(ws32, {});
    const buildRows32 = fs
      .readFileSync(path.join(ws32, '.papercup', 'data', 'build', 'scenario.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.mkdirSync(path.join(ws32, '.papercup', 'data', 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(ws32, '.papercup', 'data', 'results', 'scenario.jsonl'),
      buildRows32
        .map((r, i) =>
          JSON.stringify({
            id: r.id,
            file: r.file,
            line: r.line,
            kind: r.kind,
            track: 'scenario',
            source: r.source ?? r.text,
            target: i === 0 ? '测试台词一。[p]' : '测试台词二。[p]',
            ok: true,
          })
        )
        .join('\n') + '\n',
      'utf8'
    );

    // 32d (part 2): vn_writeback rejects manifests sourced from backup/, *.bak, or non-original paths with original path recommendation
    unpackXp3(path.join(ws32, 'game', 'backup', 'data.xp3'), path.join(ws32, 'unpacked_backup', 'data.xp3'));
    let backupWritebackErr = '';
    const badPatchDest = path.join(root32, 'patch-from-backup');
    try {
      await writebackVnCopy(ws32, { unpacked: 'unpacked_backup', dest: badPatchDest });
    } catch (err) {
      backupWritebackErr = (err as Error).message;
    }
    assert(
      backupWritebackErr.includes('game/backup/data.xp3') && backupWritebackErr.includes('game/data.xp3'),
      `Expected writeback from backup/ to be rejected with recommendation game/data.xp3, got: ${backupWritebackErr}`
    );
    assert(
      !fs.existsSync(path.join(badPatchDest, 'patch_manifest.json')),
      'Rejected backup-source writeback must not emit patch_manifest.json'
    );

    // Also test *.bak source rejection
    unpackXp3(path.join(ws32, 'game', 'data.xp3.bak'), path.join(ws32, 'unpacked_bak', 'data.xp3'));
    let bakWritebackErr = '';
    try {
      await writebackVnCopy(ws32, { unpacked: 'unpacked_bak', dest: path.join(root32, 'patch-from-bak') });
    } catch (err) {
      bakWritebackErr = (err as Error).message;
    }
    assert(
      bakWritebackErr.includes('game/data.xp3.bak') && bakWritebackErr.includes('game/data.xp3'),
      `Expected writeback from *.bak to be rejected with recommendation, got: ${bakWritebackErr}`
    );

    // Also test manifest pointing to a non-existent/misplaced copy path not in vn_detect hits
    fs.mkdirSync(path.join(ws32, 'unpacked_misplaced', 'data.xp3'), { recursive: true });
    unpackXp3(path.join(ws32, 'game', 'data.xp3'), path.join(ws32, 'unpacked_misplaced', 'data.xp3'));
    const misplacedManifestPath = path.join(ws32, 'unpacked_misplaced', 'data.xp3', '.xp3-manifest.json');
    const misplacedM = JSON.parse(fs.readFileSync(misplacedManifestPath, 'utf8'));
    misplacedM.source = path.join(ws32, 'tmp_copy', 'data.xp3');
    fs.writeFileSync(misplacedManifestPath, JSON.stringify(misplacedM, null, 2) + '\n', 'utf8');
    let misplacedErr = '';
    try {
      await writebackVnCopy(ws32, { unpacked: 'unpacked_misplaced', dest: path.join(root32, 'patch-from-misplaced') });
    } catch (err) {
      misplacedErr = (err as Error).message;
    }
    assert(
      misplacedErr.includes('tmp_copy/data.xp3') && misplacedErr.includes('game/data.xp3'),
      `Expected writeback from misplaced non-detected source to be rejected, got: ${misplacedErr}`
    );

    // Clean temporary unpacked dirs and run a legitimate writeback from original game/data.xp3
    fs.rmSync(path.join(ws32, 'unpacked_backup'), { recursive: true, force: true });
    fs.rmSync(path.join(ws32, 'unpacked_bak'), { recursive: true, force: true });
    fs.rmSync(path.join(ws32, 'unpacked_misplaced'), { recursive: true, force: true });
    const patchDir32 = path.join(root32, 'patch-32');
    const wb32 = await writebackVnCopy(ws32, { dest: patchDir32 });
    const manifest32 = String(wb32.manifest_path);

    // 32b. Legacy repair-state auto-reset compatibility (without mutating disk) + structured lastFailureKind='patch'/'harness'
    const smokeDir32 = path.join(ws32, '.papercup', 'data', 'vn', 'smoke');
    fs.mkdirSync(smokeDir32, { recursive: true });
    const repairPath32 = path.join(ws32, SMOKE_REPAIR_REL);
    const reportPath32 = path.join(ws32, SMOKE_REPORT_REL);

    // Case 1: Legacy pre-failureKind Add-Type / PS1 encoding failure recorded as runtime.launch_failed with durationMs=0
    const legacyStateRaw =
      JSON.stringify(
        {
          schema: 1,
          resultsDigest: 'legacy-digest',
          failedRounds: 2,
          maxRepairRounds: 2,
          lastRunAt: '2026-11-21T04:41:41Z',
          lastOk: false,
          lastErrorRules: ['runtime.launch_failed'],
        },
        null,
        2
      ) + '\n';
    fs.writeFileSync(repairPath32, legacyStateRaw, 'utf8');
    fs.writeFileSync(
      reportPath32,
      JSON.stringify(
        {
          schema: 1,
          createdAt: '2026-11-21T04:41:41Z',
          patchManifestPath: manifest32,
          patchManifestSha256: 'abc',
          targetExe: 'game/Game.exe',
          targetArch: 'x86',
          usedLocaleEmulator: false,
          usedTextractor: false,
          inputMode: 'none',
          durationMs: 0,
          stepsAdvanced: 0,
          repairRound: 2,
          maxRepairRounds: 2,
          repairLimitReached: true,
          ok: false,
          errorCount: 1,
          warningCount: 0,
          findings: [
            {
              ruleId: 'runtime.launch_failed',
              severity: 'error',
              message: 'Add-Type : _papercup_smoke_driver.ps1:300 compile error',
              evidence: { exitCode: null, crashEvent: null },
            },
          ],
          screenshots: [],
          summary: 'legacy fail',
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    const compatRead = readSmokeRepairState(ws32);
    assert(
      compatRead !== null && compatRead.failedRounds === 0,
      `Expected legacy infra repair-state to normalize failedRounds=0, got: ${JSON.stringify(compatRead)}`
    );
    assert(
      fs.readFileSync(repairPath32, 'utf8') === legacyStateRaw,
      'readSmokeRepairState must not mutate legacy workspace repair-state.json on disk'
    );

    // Case 2: Structured lastFailureKind='patch' MUST preserve failedRounds=2 even when durationMs=0, stepsAdvanced=0, exitCode=null, crashEvent=null
    fs.writeFileSync(
      repairPath32,
      JSON.stringify(
        {
          schema: 1,
          resultsDigest: 'patch-digest',
          failedRounds: 2,
          maxRepairRounds: 2,
          lastRunAt: '2026-11-21T04:42:00Z',
          lastOk: false,
          lastFailureKind: 'patch',
          lastErrorRules: ['runtime.launch_failed'],
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      reportPath32,
      JSON.stringify(
        {
          schema: 1,
          createdAt: '2026-11-21T04:42:00Z',
          failureKind: 'patch',
          patchManifestPath: manifest32,
          patchManifestSha256: 'abc',
          targetExe: 'game/Game.exe',
          targetArch: 'x86',
          usedLocaleEmulator: false,
          usedTextractor: false,
          inputMode: 'none',
          durationMs: 0,
          stepsAdvanced: 0,
          repairRound: 2,
          maxRepairRounds: 2,
          repairLimitReached: true,
          ok: false,
          errorCount: 1,
          warningCount: 0,
          findings: [
            {
              ruleId: 'runtime.launch_failed',
              severity: 'error',
              message: 'Game.exe refused to start due to bad patch',
              evidence: { exitCode: null, crashEvent: null },
            },
          ],
          screenshots: [],
          summary: 'real patch launch fail at t=0',
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    const genuineRead = readSmokeRepairState(ws32);
    assert(
      genuineRead !== null && genuineRead.failedRounds === 2,
      `Structured lastFailureKind='patch' must preserve failedRounds=2 even with durationMs=0/exitCode=null, got: ${JSON.stringify(genuineRead)}`
    );

    // Case 3: Structured lastFailureKind='harness' normalizes failedRounds=0
    fs.writeFileSync(
      repairPath32,
      JSON.stringify(
        {
          schema: 1,
          resultsDigest: 'harness-digest',
          failedRounds: 2,
          maxRepairRounds: 2,
          lastRunAt: '2026-11-21T04:43:00Z',
          lastOk: false,
          lastFailureKind: 'harness',
          lastErrorRules: ['harness.driver_failed'],
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    const harnessStateRead = readSmokeRepairState(ws32);
    assert(
      harnessStateRead !== null && harnessStateRead.failedRounds === 0,
      `Structured lastFailureKind='harness' must normalize failedRounds=0, got: ${JSON.stringify(harnessStateRead)}`
    );

    // Clear stale fake report/state before live runSmokeTest sequence
    fs.rmSync(repairPath32, { force: true });
    fs.rmSync(reportPath32, { force: true });

    const dummyPng32 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    // Harness driver failures (3 consecutive runs) must NOT increment failedRounds or trigger repairLimitReached
    const mockHarnessFailDriver: SmokeExecutionDriver = {
      async run(input) {
        writeWindowsSmokeDriverScript(path.join(input.sandboxDir, '_papercup_smoke_driver.ps1'));
        return {
          launched: false,
          harnessFailed: true,
          harnessError: 'Add-Type compile failed before exe start',
          driverLog: {
            stdout: 'driver init\n',
            stderr: 'Add-Type : simulated syntax error\n',
            exitCode: 1,
          },
          windowFound: false,
          inputMode: 'none',
          stepsAdvanced: 0,
          durationMs: 0,
          processExitedEarly: true,
          hungDetected: false,
          frozenScreen: true,
          frames: [],
          textractorLines: [],
        };
      },
    };

    for (let i = 0; i < 3; i++) {
      const harnessRep = await runVnSmokeTest(ws32, {
        patchManifest: manifest32,
        driver: mockHarnessFailDriver,
        skipVision: true,
      });
      const hFindings = harnessRep.findings as Array<{ ruleId: string; severity: string }>;
      assert(
        harnessRep.ok === false &&
          harnessRep.failureKind === 'harness' &&
          harnessRep.repairRound === 0 &&
          harnessRep.repairLimitReached === false &&
          hFindings.some((f) => f.ruleId === 'harness.driver_failed' && f.severity === 'error') &&
          !hFindings.some((f) => f.ruleId === 'runtime.launch_failed') &&
          String(harnessRep.summary).includes('非补丁问题') &&
          !String(harnessRep.summary).includes('停止自修'),
        `Harness failure run #${i + 1} misclassified: ${JSON.stringify(harnessRep)}`
      );
    }

    const statusAfterHarness = getVnStatus(ws32);
    assert(
      statusAfterHarness.includes('工具故障') && statusAfterHarness.includes('不计自修轮数'),
      `getVnStatus should distinguish harness failure from patch rounds: ${statusAfterHarness}`
    );

    // Genuine runtime.launch_failed (exe started then exited with code 1) increments round -> 1
    const mockRealLaunchFailDriver: SmokeExecutionDriver = {
      async run(input) {
        writeWindowsSmokeDriverScript(path.join(input.sandboxDir, '_papercup_smoke_driver.ps1'));
        const f1 = path.join(input.framesDir, '01_title.png');
        fs.writeFileSync(f1, dummyPng32);
        return {
          launched: false,
          harnessFailed: false,
          launchError: 'Game.exe exited immediately with code 1',
          driverLog: { stdout: '{"event":"driver_ready"}\n', stderr: '', exitCode: 0 },
          windowFound: false,
          inputMode: 'none',
          stepsAdvanced: 0,
          durationMs: 420,
          processExitedEarly: true,
          exitCode: 1,
          hungDetected: false,
          frozenScreen: true,
          frames: [{ label: 'title', step: 0, path: f1, hash: 'h1', width: 1, height: 1 }],
          textractorLines: [],
        };
      },
    };
    const realFail1 = await runVnSmokeTest(ws32, {
      patchManifest: manifest32,
      driver: mockRealLaunchFailDriver,
      skipVision: true,
    });
    assert(
      realFail1.ok === false &&
        realFail1.failureKind === 'patch' &&
        realFail1.repairRound === 1 &&
        realFail1.repairLimitReached === false &&
        (realFail1.findings as Array<{ ruleId: string }>).some((f) => f.ruleId === 'runtime.launch_failed'),
      `Real launch failure #1 must count as patch round 1: ${JSON.stringify(realFail1)}`
    );

    // Interleaved harness failure must preserve repairRound=1 (neither increment nor wipe)
    const interleavedHarness = await runVnSmokeTest(ws32, {
      patchManifest: manifest32,
      driver: mockHarnessFailDriver,
      skipVision: true,
    });
    assert(
      interleavedHarness.ok === false &&
        interleavedHarness.failureKind === 'harness' &&
        interleavedHarness.repairRound === 1 &&
        interleavedHarness.repairLimitReached === false,
      `Interleaved harness failure must keep repairRound=1 without triggering limit: ${JSON.stringify(interleavedHarness)}`
    );

    // Second genuine launch failure hits repairRound=2 & repairLimitReached=true
    const realFail2 = await runVnSmokeTest(ws32, {
      patchManifest: manifest32,
      driver: mockRealLaunchFailDriver,
      skipVision: true,
    });
    assert(
      realFail2.ok === false &&
        realFail2.failureKind === 'patch' &&
        realFail2.repairRound === 2 &&
        realFail2.repairLimitReached === true &&
        String(realFail2.summary).includes('已达自动修复轮数上限'),
      `Real launch failure #2 must reach round 2 limit: ${JSON.stringify(realFail2)}`
    );

    // 32c. Verify failure diagnostics retention (driver.ps1, logs, frames, NO hardlinked game files) + max 3 cap
    const diagDirRel = String(realFail2.diagnosticsDir || '');
    assert(Boolean(diagDirRel), `Expected diagnosticsDir on failure report: ${JSON.stringify(realFail2)}`);
    const diagDirAbs = path.join(ws32, diagDirRel);
    assert(
      fs.existsSync(path.join(diagDirAbs, '_papercup_smoke_driver.ps1')) &&
        fs.existsSync(path.join(diagDirAbs, 'driver.stdout.log')) &&
        fs.existsSync(path.join(diagDirAbs, 'frames', '01_title.png')) &&
        fs.existsSync(path.join(diagDirAbs, 'meta.json')),
      `Missing expected retained diagnostic artifacts in ${diagDirAbs}`
    );
    assert(
      !fs.existsSync(path.join(diagDirAbs, 'game')) &&
        !fs.existsSync(path.join(diagDirAbs, 'Game.exe')) &&
        !fs.existsSync(path.join(diagDirAbs, 'data.xp3')),
      `Retained diagnostics directory must NOT contain hardlinked game files: ${diagDirAbs}`
    );
    const smokeHardlinkRoot = path.join(ws32, '.papercup', 'tmp', 'smoke');
    const lingeringSandboxes = fs.existsSync(smokeHardlinkRoot)
      ? fs.readdirSync(smokeHardlinkRoot).filter((name) => name !== 'frames' && name !== 'failures')
      : [];
    assert(
      lingeringSandboxes.length === 0,
      `Hardlink sandbox directories must be cleaned up after failure, found: ${JSON.stringify(lingeringSandboxes)}`
    );
    const failureRuns = fs.readdirSync(path.join(ws32, SMOKE_FAILURES_REL));
    assert(
      failureRuns.length === 3,
      `Failure diagnostics retention must be capped at 3 runs (ran 6 failures), got ${failureRuns.length}: ${JSON.stringify(failureRuns)}`
    );

    // Passing smoke run must NOT create a new failure directory and keeps cap at 3
    const passRep32 = await runVnSmokeTest(ws32, {
      patchManifest: manifest32,
      driver: {
        async run() {
          return {
            launched: true,
            windowFound: true,
            windowTitle: 'OK Game',
            inputMode: 'background',
            stepsAdvanced: 10,
            durationMs: 1800,
            processExitedEarly: false,
            exitCode: 0,
            hungDetected: false,
            frozenScreen: false,
            frames: [],
            textractorLines: ['测试台词一。', '测试台词二。'],
          };
        },
      },
      skipVision: true,
    });
    assert(
      passRep32.ok === true && passRep32.diagnosticsDir === undefined && passRep32.repairRound === 0,
      `Expected clean pass without diagnosticsDir, got: ${JSON.stringify(passRep32)}`
    );
    assert(
      fs.readdirSync(path.join(ws32, SMOKE_FAILURES_REL)).length === 3,
      'Passing run must not add extra failure diagnostic directories'
    );

    // 32e. Protected file guards (.papercup/data/results/*.jsonl + detected archives + game *.exe/*.dll) & post-bash atomic rollback audit
    const guarded32 = createGuardedBuiltinToolDefinitions(ws32, ['read', 'write', 'edit', 'bash'], {
      bashPath: config.bashPath,
      homeDir: home32,
    });
    const readTool32 = guarded32.find((t) => t.name === 'read')!;
    const writeTool32 = guarded32.find((t) => t.name === 'write')!;
    const editTool32 = guarded32.find((t) => t.name === 'edit')!;
    const bashTool32 = guarded32.find((t) => t.name === 'bash')!;

    // read on .papercup/data/results/scenario.jsonl must be allowed
    const readRes32 = (await readTool32.execute('r32', { path: '.papercup/data/results/scenario.jsonl' }, undefined, undefined, {} as any)) as any;
    assert(!readRes32?.isError, `read on .papercup/data/results/scenario.jsonl must succeed: ${JSON.stringify(readRes32)}`);

    // write/edit on protected paths must be blocked
    for (const p of ['.papercup/data/results/scenario.jsonl', '.papercup/data/results/ui.jsonl', 'game/data.xp3', 'game/Game.exe', 'game/engine.dll']) {
      assert(
        detectBlockedProtectedFilePath(p, ws32, 'write', home32) !== null,
        `Expected detectBlockedProtectedFilePath to block ${p}`
      );
      const wRes = (await writeTool32.execute('w32', { path: p, content: 'x' }, undefined, undefined, {} as any)) as any;
      assert(wRes?.isError === true && wRes?.details?.blocked === true, `write to ${p} must be blocked`);
      const eRes = (await editTool32.execute(
        'e32',
        { path: p, edits: [{ oldText: 'a', newText: 'b' }] },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert(eRes?.isError === true && eRes?.details?.blocked === true, `edit on ${p} must be blocked`);
    }

    // write to .papercup/tmp/work/out/, .papercup/tmp/, and .papercup/tmp/unpacked/ must be allowed (even .exe/.xp3 inside .papercup/tmp/)
    for (const p of ['.papercup/tmp/work/out/batch_000.jsonl', '.papercup/tmp/shadow.jsonl', '.papercup/tmp/unpacked/test.dll']) {
      assert(
        detectBlockedProtectedFilePath(p, ws32, 'write', home32) === null,
        `Unexpected false positive blocking write to ${p}`
      );
      const wOk = (await writeTool32.execute('w32-ok', { path: p, content: 'ok\n' }, undefined, undefined, {} as any)) as any;
      assert(!wOk?.isError, `Allowed write to ${p} failed: ${JSON.stringify(wOk)}`);
    }

    // Heuristic bash write guard checks
    const snap32 = collectProtectedWorkspaceSnapshot(ws32, home32);
    const blockedBash32 = [
      'cp -f .papercup/tmp/shadow.jsonl .papercup/data/results/scenario.jsonl',
      'cp -f .papercup/tmp/shadow.jsonl .papercup/data/results/',
      'cp -f game/backup/data.xp3 game/data.xp3',
      'cp -f game/backup/data.xp3 game/',
      'mv .papercup/data/results/scenario.jsonl .papercup/tmp/moved.jsonl',
      'mv game/Game.exe .papercup/tmp/Game.exe',
      'rm -f .papercup/data/results/*.jsonl',
      'rm -rf .papercup/data/results',
      'rm -rf game',
      'echo "{}" > .papercup/data/results/ui.jsonl',
      'echo "{}" | tee .papercup/data/results/scenario.jsonl',
      "sed -i 's/a/b/g' .papercup/data/results/scenario.jsonl",
      'truncate -s 0 game/data.xp3',
      'dd if=/dev/zero of=game/engine.dll bs=1 count=4',
    ];
    for (const cmd of blockedBash32) {
      assert(
        detectBlockedProtectedBashCommand(cmd, ws32, snap32) !== null,
        `Expected protected bash guard to block: ${cmd}`
      );
      const bRes = (await bashTool32.execute('b32-blk', { command: cmd }, undefined, undefined, {} as any)) as any;
      assert(
        bRes?.isError === true && bRes?.details?.blocked === true,
        `Guarded bash tool must block "${cmd}", got: ${JSON.stringify(bRes)}`
      );
    }

    // Legitimate read-only & temp-dir bash commands must pass without mutation alert
    const allowedBash32 = [
      'head -n 1 .papercup/data/results/scenario.jsonl',
      'cp .papercup/data/results/scenario.jsonl .papercup/tmp/read_copy.jsonl',
      "sed -n '1p' .papercup/data/results/scenario.jsonl",
      'echo "hello" > .papercup/tmp/ok.txt',
    ];
    for (const cmd of allowedBash32) {
      assert(
        detectBlockedProtectedBashCommand(cmd, ws32, snap32) === null,
        `Unexpected false positive in protected bash guard for: ${cmd}`
      );
      const bOk = (await bashTool32.execute('b32-ok', { command: cmd }, undefined, undefined, {} as any)) as any;
      assert(
        !bOk?.isError && !bOk?.details?.protectedFileMutations,
        `Allowed bash command "${cmd}" should succeed cleanly without mutation warning: ${JSON.stringify(bOk)}`
      );
    }

    // Post-bash mutation audit catches indirect script bypasses, returns isError=true, AND atomically rolls back .papercup/data/results/scenario.jsonl
    const origResults32 = fs.readFileSync(path.join(ws32, '.papercup', 'data', 'results', 'scenario.jsonl'), 'utf8');
    const bypassCmd = `node -e "const fs=require('fs'); fs.appendFileSync('.papercup/data/results/scenario.jsonl','TAMPERED\\n'); fs.appendFileSync('game/engine.dll','X');"`;
    const bypassRes = (await bashTool32.execute('b32-audit', { command: bypassCmd }, undefined, undefined, {} as any)) as any;
    const bypassText = String(bypassRes?.content?.[0]?.text || '');
    const bypassMuts = (bypassRes?.details?.protectedFileMutations || []) as Array<{ rel: string; change: string; restored?: boolean }>;
    assert(
      bypassRes?.isError === true &&
        bypassText.includes('PROTECTED FILE MUTATION DETECTED') &&
        bypassMuts.some((m) => m.rel === '.papercup/data/results/scenario.jsonl' && m.change === 'modified' && m.restored === true) &&
        bypassMuts.some((m) => m.rel === 'game/engine.dll' && m.change === 'modified') &&
        fs.readFileSync(path.join(ws32, '.papercup', 'data', 'results', 'scenario.jsonl'), 'utf8') === origResults32,
      `Post-bash mutation audit must return isError=true, report mutations, and atomically restore .papercup/data/results/scenario.jsonl: ${JSON.stringify(bypassRes)}`
    );

    // Direct unit check on diffProtectedWorkspaceSnapshots for created/deleted detection
    const snapBeforeDiff = collectProtectedWorkspaceSnapshot(ws32, home32);
    fs.writeFileSync(path.join(ws32, '.papercup', 'data', 'results', 'extra.jsonl'), '{}\n', 'utf8');
    fs.rmSync(path.join(ws32, 'game', 'engine.dll'), { force: true });
    const snapAfterDiff = collectProtectedWorkspaceSnapshot(ws32, home32);
    const diffRes32 = diffProtectedWorkspaceSnapshots(snapBeforeDiff, snapAfterDiff);
    assert(
      diffRes32.some((m) => m.rel === '.papercup/data/results/extra.jsonl' && m.change === 'created') &&
        diffRes32.some((m) => m.rel === 'game/engine.dll' && m.change === 'deleted'),
      `diffProtectedWorkspaceSnapshots failed to detect created/deleted protected files: ${JSON.stringify(diffRes32)}`
    );

    // Prompt regression check for newly added rules
    assert(
      PAPERCUP_SYSTEM_PROMPT.includes('禁止擅自改写 `.papercup/data/results/*.jsonl` 与游戏原始文件') &&
        PAPERCUP_SYSTEM_PROMPT.includes('harness.driver_failed') &&
        PAPERCUP_SYSTEM_PROMPT.includes('严禁从 `backup/`'),
      'PAPERCUP_SYSTEM_PROMPT missing protected-file guard, harness.driver_failed, or backup-unpack constraint'
    );
  });

  // 33. 自定义编码双通道放行 + 技能环境变量透传 + --force 清空旧产物 + vn_smoke_test 免清单直测与 vn_accept 门禁联动
  console.log('33. Verifying custom skill codec passthrough, --force stale files cleanup, overlay smoke test, and overlay vn_accept gate...');
  await withIsolatedHomeAndEnv('papercup-codec-overlay-33-', async ({ root: root33, home: home33, ws: ws33 }) => {
    const ws33Builtin = path.join(root33, 'ws33-builtin');
    fs.mkdirSync(path.join(ws33, 'game'), { recursive: true });
    fs.mkdirSync(path.join(ws33, '.papercup', 'tools'), { recursive: true });
    fs.mkdirSync(path.join(ws33, '.papercup', 'tmp'), { recursive: true });
    fs.mkdirSync(ws33Builtin, { recursive: true });

    // Build a minimal custom binary archive format "MPK1" (json index + raw blobs) with TEXT.DAT + DEFAULT_FONT.DAT
    fs.writeFileSync(
      path.join(ws33, 'papercup.toml'),
      [
        '[vn.localization]',
        'source_lang = "ja"',
        'target_lang = "zh-CN"',
        'narrative_pov = "source"',
        '',
        '[vn.patch]',
        'charset_file = ".papercup/tools/charset.json"',
        'font_scale = 26',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws33, '.papercup', 'tools', 'charset.json'),
      JSON.stringify({ mode: 'custom-bitmap', tag: 'PAL_V3_CHARSET' }, null, 2) + '\n',
      'utf8'
    );

    const peX86 = Buffer.alloc(256, 0);
    peX86[0] = 0x4d;
    peX86[1] = 0x5a;
    peX86.writeUInt32LE(0x80, 0x3c);
    peX86[0x80] = 0x50;
    peX86[0x81] = 0x45;
    peX86.writeUInt16LE(0x014c, 0x84);
    fs.writeFileSync(path.join(ws33, 'game', 'PalGame.exe'), peX86);

    const packMpk = (members: Record<string, Buffer>, outPath: string) => {
      const names = Object.keys(members).sort();
      const header: Array<{ name: string; len: number }> = [];
      const chunks: Buffer[] = [];
      for (const n of names) {
        header.push({ name: n, len: members[n].length });
        chunks.push(members[n]);
      }
      const meta = Buffer.from(JSON.stringify(header), 'utf8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(meta.length, 0);
      fs.writeFileSync(outPath, Buffer.concat([Buffer.from('MPK1', 'ascii'), lenBuf, meta, ...chunks]));
    };
    const unpackMpkToMap = (mpkPath: string): Record<string, Buffer> => {
      const raw = fs.readFileSync(mpkPath);
      assert(raw.subarray(0, 4).toString('ascii') === 'MPK1', 'Invalid MPK1 magic');
      const metaLen = raw.readUInt32LE(4);
      const header = JSON.parse(raw.subarray(8, 8 + metaLen).toString('utf8')) as Array<{ name: string; len: number }>;
      let off = 8 + metaLen;
      const out: Record<string, Buffer> = {};
      for (const h of header) {
        out[h.name] = raw.subarray(off, off + h.len);
        off += h.len;
      }
      return out;
    };

    const origTextBytes = encodeText('おはよう、世界。\r\nさようなら。\r\n', 'cp932');
    const origFontBytes = Buffer.from('ORIG_BITMAP_FONT_DATA_V1', 'ascii');
    const origMpkPath = path.join(ws33, 'game', 'data.mpk');
    packMpk({ 'TEXT.DAT': origTextBytes, 'DEFAULT_FONT.DAT': origFontBytes }, origMpkPath);
    const origMpkBuf = fs.readFileSync(origMpkPath);

    // Candidate skill scripts: unpack.py, repack.py, extract.py, apply.py
    // apply.py UNCONDITIONALLY requires PAPERCUP_WORKSPACE & PAPERCUP_PATCH_OPTIONS_JSON on EVERY call (including learnVnSkill roundtrip — no else backdoor!)
    fs.writeFileSync(
      path.join(ws33, '.papercup', 'tmp', 'unpack.py'),
      [
        'import json, os, struct, sys',
        'src, dst = sys.argv[1], sys.argv[2]',
        'os.makedirs(dst, exist_ok=True)',
        'raw = open(src, "rb").read()',
        'assert raw[:4] == b"MPK1"',
        'mlen = struct.unpack_from("<I", raw, 4)[0]',
        'hdr = json.loads(raw[8:8+mlen].decode("utf-8"))',
        'off = 8 + mlen',
        'for item in hdr:',
        '    p = os.path.join(dst, item["name"])',
        '    os.makedirs(os.path.dirname(p), exist_ok=True)',
        '    open(p, "wb").write(raw[off:off+item["len"]])',
        '    off += item["len"]',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws33, '.papercup', 'tmp', 'repack.py'),
      [
        'import json, os, struct, sys',
        'src, dst = sys.argv[1], sys.argv[2]',
        'names = sorted(f for f in os.listdir(src) if not f.startswith(".") and not f.endswith(".bak") and os.path.isfile(os.path.join(src, f)))',
        'hdr, blobs = [], []',
        'for n in names:',
        '    b = open(os.path.join(src, n), "rb").read()',
        '    hdr.append({"name": n, "len": len(b)})',
        '    blobs.append(b)',
        'meta = json.dumps(hdr, separators=(",", ":")).encode("utf-8")',
        'os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)',
        'with open(dst, "wb") as out:',
        '    out.write(b"MPK1" + struct.pack("<I", len(meta)) + meta + b"".join(blobs))',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws33, '.papercup', 'tmp', 'extract.py'),
      [
        'import json, os, sys',
        'root, out_p = sys.argv[1], sys.argv[2]',
        'target = None',
        'rel = None',
        'for dirpath, _, files in os.walk(root):',
        '    if "TEXT.DAT" in files:',
        '        target = os.path.join(dirpath, "TEXT.DAT")',
        '        rel = os.path.relpath(target, root).replace("\\\\", "/")',
        '        break',
        'assert target is not None',
        'lines = open(target, "rb").read().decode("cp932").splitlines()',
        'with open(out_p, "w", encoding="utf-8") as out:',
        '    for idx, line in enumerate(lines, 1):',
        '        if line.strip():',
        '            out.write(json.dumps({"id": f"t_{idx}", "file": rel, "line": idx, "kind": "say", "source": line}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws33, '.papercup', 'tmp', 'apply.py'),
      [
        'import json, os, sys',
        'res_p, root = sys.argv[1], sys.argv[2]',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING", "")',
        'ws_env = os.environ.get("PAPERCUP_WORKSPACE", "")',
        'opts = json.loads(os.environ.get("PAPERCUP_PATCH_OPTIONS_JSON", "{}"))',
        'assert ws_env and os.path.isdir(ws_env), f"missing PAPERCUP_WORKSPACE: {ws_env}"',
        'cs_rel = opts.get("charset_file", "")',
        'assert cs_rel, f"missing charset_file in PAPERCUP_PATCH_OPTIONS_JSON: {opts}"',
        'cs = json.load(open(os.path.join(ws_env, cs_rel), encoding="utf-8"))',
        'assert opts.get("font_scale") == 26, f"unexpected font_scale: {opts}"',
        'rows = [json.loads(l) for l in open(res_p, encoding="utf-8") if l.strip()]',
        'rel = rows[0]["file"]',
        'text_path = os.path.join(root, rel)',
        'font_path = os.path.join(os.path.dirname(text_path), "DEFAULT_FONT.DAT")',
        'if enc in ("pal-charset", "custom:pal-v2"):',
        '    payload = f"[{enc}|{cs[\'tag\']}]" + "|".join(r["target"] for r in rows)',
        '    open(text_path, "wb").write(payload.encode("utf-8"))',
        '    open(font_path, "wb").write(f"REBUILT_FONT:{enc}:{opts.get(\'font_scale\')}".encode("ascii"))',
        'else:',
        '    assert enc == "cp932", f"unexpected target encoding: {enc}"',
        '    existing = open(text_path, "rb").read().decode("cp932").splitlines()',
        '    for r in rows:',
        '        idx = int(r["line"]) - 1',
        '        existing[idx] = r.get("target") or r["source"]',
        '    txt = "\\r\\n".join(existing) + "\\r\\n"',
        '    open(text_path, "wb").write(txt.encode(enc))',
      ].join('\n') + '\n',
      'utf8'
    );

    // 33a. Learn skill with customEncodings: ['pal-charset'] and verify project-local engine.json + unconditional env passthrough
    const learnRes33 = await learnVnSkill(ws33, {
      engine: 'palmock',
      unpackScript: '.papercup/tmp/unpack.py',
      repackScript: '.papercup/tmp/repack.py',
      extractScript: '.papercup/tmp/extract.py',
      applyScript: '.papercup/tmp/apply.py',
      encoding: 'cp932',
      customEncodings: ['pal-charset'],
      archive: 'game/data.mpk',
      magicHex: '4d504b31',
      overwrite: true,
    });
    assert(learnRes33.status === 'adopted', `Expected palmock skill to learn cleanly, got: ${JSON.stringify(learnRes33)}`);
    const palmockProjectEnginePath = path.join(projectHarnessDir(ws33, path.join(home33, '.papercup')), 'engine.json');
    const palmockGlobalEnginePath = path.join(home33, '.papercup', 'skills', 'engine-palmock', 'engine.json');
    const palmockLegacyGlobalEnginePath = path.join(home33, '.papercup', 'engines', 'palmock', 'engine.json');
    assert(
      fs.existsSync(palmockProjectEnginePath) && !fs.existsSync(palmockGlobalEnginePath) && !fs.existsSync(palmockLegacyGlobalEnginePath),
      `palmock engine.json must be workspace-local until promoted: local=${fs.existsSync(palmockProjectEnginePath)}, global=${fs.existsSync(palmockGlobalEnginePath)}`
    );
    const learnedEngJson = JSON.parse(fs.readFileSync(palmockProjectEnginePath, 'utf8'));
    assert(
      Array.isArray(learnedEngJson.custom_encodings) &&
        learnedEngJson.custom_encodings.includes('pal-charset') &&
        Array.isArray(learnedEngJson.writeback?.custom_encodings) &&
        learnedEngJson.writeback.custom_encodings.includes('pal-charset'),
      `Expected custom_encodings in workspace engine.json, got: ${JSON.stringify(learnedEngJson)}`
    );

    await unpackVnArchives(ws33);
    await classifyVnScripts(ws33, {});
    const buildRows33 = fs
      .readFileSync(path.join(ws33, '.papercup', 'data', 'build', 'scenario.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.mkdirSync(path.join(ws33, '.papercup', 'data', 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(ws33, '.papercup', 'data', 'results', 'scenario.jsonl'),
      buildRows33
        .map((r, i) =>
          JSON.stringify({
            id: r.id,
            file: r.file,
            line: r.line,
            kind: r.kind,
            track: 'scenario',
            source: r.source ?? r.text,
            target: i === 0 ? '早上好，世界。' : '再见。',
            ok: true,
          })
        )
        .join('\n') + '\n',
      'utf8'
    );

    // Channel 1: declared custom encoding `pal-charset` succeeds, passes env + [vn.patch] customOptions, packs rebuilt DEFAULT_FONT.DAT + TEXT.DAT, hook_needed=false
    const patchDeclaredDir = path.join(root33, 'patch-declared');
    const wbDeclared = await writebackVnCopy(ws33, { encoding: 'pal-charset', dest: patchDeclaredDir });
    assert(
      wbDeclared.encoding === 'pal-charset' &&
        wbDeclared.hook_needed === false &&
        Array.isArray(wbDeclared.changed_files) &&
        (wbDeclared.changed_files as string[]).includes('game/data.mpk::TEXT.DAT') &&
        (wbDeclared.changed_files as string[]).includes('game/data.mpk::DEFAULT_FONT.DAT'),
      `Declared custom codec writeback failed or missed rebuilt font asset: ${JSON.stringify(wbDeclared)}`
    );
    const declaredMembers = unpackMpkToMap(path.join(patchDeclaredDir, 'files', 'game', 'data.mpk'));
    assert(
      declaredMembers['TEXT.DAT'].toString('utf8') === '[pal-charset|PAL_V3_CHARSET]早上好，世界。|再见。' &&
        declaredMembers['DEFAULT_FONT.DAT'].toString('ascii') === 'REBUILT_FONT:pal-charset:26',
      `Unexpected custom-codec packed members: text=${declaredMembers['TEXT.DAT']?.toString('utf8')}, font=${declaredMembers['DEFAULT_FONT.DAT']?.toString('ascii')}`
    );
    assert(
      fs.readFileSync(path.join(patchDeclaredDir, 'sources', 'scenario.jsonl'), 'utf8').includes('早上好，世界。'),
      'Patch sources/ must preserve real Simplified Chinese translations without shadow encoding'
    );

    // Channel 2: `custom:` prefixed encoding succeeds on skill apply without pre-declaration
    const patchPrefixedDir = path.join(root33, 'patch-prefixed');
    const wbPrefixed = await writebackVnCopy(ws33, { encoding: 'custom:pal-v2', dest: patchPrefixedDir });
    const prefixedMembers = unpackMpkToMap(path.join(patchPrefixedDir, 'files', 'game', 'data.mpk'));
    assert(
      wbPrefixed.encoding === 'custom:pal-v2' &&
        wbPrefixed.hook_needed === false &&
        prefixedMembers['TEXT.DAT'].toString('utf8').startsWith('[custom:pal-v2|PAL_V3_CHARSET]'),
      `custom: prefixed skill encoding failed: ${JSON.stringify(wbPrefixed)}`
    );

    // Undeclared bare custom encoding is rejected on skill apply
    let undeclaredErr = '';
    try {
      await writebackVnCopy(ws33, { encoding: 'undeclared-codec', dest: path.join(root33, 'patch-undeclared') });
    } catch (err) {
      undeclaredErr = (err as Error).message;
    }
    assert(
      undeclaredErr.includes('custom:') && undeclaredErr.includes('custom_encodings'),
      `Expected undeclared bare custom encoding to be rejected with guidance, got: ${undeclaredErr}`
    );

    // Builtin apply strictly rejects even `custom:` prefixed encodings
    fs.writeFileSync(
      path.join(ws33Builtin, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "source"\n',
      'utf8'
    );
    packDeltaXp3([['scenario/a.ks', encodeText('*start\r\nこんにちは。[p]\r\n', 'cp932')]], path.join(ws33Builtin, 'data.xp3'));
    await unpackVnArchives(ws33Builtin);
    await classifyVnScripts(ws33Builtin, {});
    const bRowsBuiltin = fs
      .readFileSync(path.join(ws33Builtin, '.papercup', 'data', 'build', 'scenario.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.mkdirSync(path.join(ws33Builtin, '.papercup', 'data', 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(ws33Builtin, '.papercup', 'data', 'results', 'scenario.jsonl'),
      bRowsBuiltin
        .map((r) =>
          JSON.stringify({
            id: r.id,
            file: r.file,
            line: r.line,
            kind: r.kind,
            track: 'scenario',
            source: r.source ?? r.text,
            target: '你好。[p]',
            ok: true,
          })
        )
        .join('\n') + '\n',
      'utf8'
    );
    let builtinCustomErr = '';
    try {
      await writebackVnCopy(ws33Builtin, { encoding: 'custom:foo', dest: path.join(root33, 'patch-builtin-fail') });
    } catch (err) {
      builtinCustomErr = (err as Error).message;
    }
    assert(
      builtinCustomErr.includes('不支持的写回编码'),
      `Builtin apply must strictly reject custom: encoding, got: ${builtinCustomErr}`
    );

    // 33b. vn_writeback --force cleans stale files/ and papercup_patch.ini ONLY after validation passes, keeping user files intact
    const forceDest = path.join(root33, 'patch-force-clean');
    fs.mkdirSync(path.join(forceDest, 'files', 'game', 'backup'), { recursive: true });
    fs.writeFileSync(path.join(forceDest, 'files', 'game', 'backup', 'stale.mpk'), 'STALE', 'utf8');
    fs.writeFileSync(path.join(forceDest, 'papercup_patch.ini'), '[patch]\ncodepage=936\n', 'utf8');
    fs.writeFileSync(path.join(forceDest, 'user_notes.txt'), 'KEEP_ME', 'utf8');

    // Failed run with force=true must NOT wipe existing files/
    let forceFailErr = '';
    try {
      await writebackVnCopy(ws33, { dest: forceDest, force: true, encoding: 'undeclared-codec' });
    } catch (err) {
      forceFailErr = (err as Error).message;
    }
    assert(
      Boolean(forceFailErr) && fs.existsSync(path.join(forceDest, 'files', 'game', 'backup', 'stale.mpk')),
      'Failed force writeback must leave pre-existing files/ intact'
    );

    // Successful run with force=true wipes stale files/ & unused papercup_patch.ini while preserving user_notes.txt
    await writebackVnCopy(ws33, { dest: forceDest, force: true, encoding: 'pal-charset' });
    assert(
      !fs.existsSync(path.join(forceDest, 'files', 'game', 'backup', 'stale.mpk')) &&
        !fs.existsSync(path.join(forceDest, 'papercup_patch.ini')) &&
        fs.existsSync(path.join(forceDest, 'files', 'game', 'data.mpk')) &&
        fs.readFileSync(path.join(forceDest, 'user_notes.txt'), 'utf8') === 'KEEP_ME',
      'Successful force writeback must purge stale managed outputs while preserving unrelated user files'
    );

    // 33c. vn_smoke_test overlayPath (directory & single file) + vn_accept bidirectional same-SHA-256 gate
    saveGlobalSmokeConfig({ enabled: true, visionEnabled: false }, path.join(home33, '.papercup'));

    const v2OverlayDir = path.join(root33, 'v2-full-bundle');
    fs.mkdirSync(path.join(v2OverlayDir, 'game'), { recursive: true });
    fs.writeFileSync(path.join(v2OverlayDir, 'README.md'), '# v2 bundle\n', 'utf8');
    const v2ArchivePath = path.join(v2OverlayDir, 'game', 'data.mpk');
    fs.copyFileSync(path.join(patchDeclaredDir, 'files', 'game', 'data.mpk'), v2ArchivePath);

    // Mutually exclusive patchManifest & overlayPath rejected
    let mutualErr = '';
    try {
      await runVnSmokeTest(ws33, {
        patchManifest: String(wbDeclared.manifest_path),
        overlayPath: v2OverlayDir,
        skipVision: true,
      });
    } catch (err) {
      mutualErr = (err as Error).message;
    }
    assert(mutualErr.includes('不能同时指定'), `Expected mutual exclusion error, got: ${mutualErr}`);

    // Sandbox overlay isolation & inode safety check
    const ovSb = prepareSmokeSandboxFromOverlay(ws33, v2OverlayDir, { homeDir: path.join(home33, '.papercup') });
    assert(
      ovSb.mode === 'overlay' &&
        ovSb.overlayFiles.some((f) => f.rel === 'game/data.mpk') &&
        fs.readFileSync(path.join(ovSb.sandboxDir, 'game', 'data.mpk')).equals(fs.readFileSync(v2ArchivePath)),
      'Overlay sandbox must replace game/data.mpk with overlay content'
    );
    ovSb.cleanup();
    assert(
      !fs.existsSync(ovSb.sandboxDir) && fs.readFileSync(origMpkPath).equals(origMpkBuf),
      'Overlay sandbox cleanup must remove temp dir and leave workspace original archive untouched'
    );

    const mockOverlayPassDriver: SmokeExecutionDriver = {
      async run() {
        return {
          launched: true,
          windowFound: true,
          windowTitle: 'PalGame',
          inputMode: 'background',
          stepsAdvanced: 10,
          durationMs: 1600,
          processExitedEarly: false,
          exitCode: 0,
          hungDetected: false,
          frozenScreen: false,
          frames: [],
          textractorLines: ['早上好，世界。', '再见。'],
        };
      },
    };

    const ovSmokeRes = await runVnSmokeTest(ws33, {
      overlayPath: v2OverlayDir,
      driver: mockOverlayPassDriver,
      skipVision: true,
    });
    assert(
      ovSmokeRes.ok === true &&
        ovSmokeRes.mode === 'overlay' &&
        Array.isArray(ovSmokeRes.overlayFiles) &&
        (ovSmokeRes.overlayFiles as Array<{ rel: string }>).some((f) => f.rel === 'game/data.mpk'),
      `Overlay directory smoke test failed: ${JSON.stringify(ovSmokeRes)}`
    );

    // vn_accept passes hard smoke gate when accepting the exact same SHA-256 standalone archive!
    const accOvPass = acceptVnRelease(ws33, {
      archive: v2ArchivePath,
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(!accOvPass.blocked, `Expected vn_accept to pass for matching overlay archive SHA-256, got: ${accOvPass.text}`);
    const relOv = releaseVnPatch(ws33, { dryRun: true });
    assert(relOv.includes('覆盖直测'), `Expected release note to mark overlay smoke pass: ${relOv}`);

    // Accepting a patch_manifest.json while latest smoke report is overlay mode -> accept.smoke.stale
    const accManifestMismatch = acceptVnRelease(ws33, {
      archive: String(wbDeclared.manifest_path),
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(
      accManifestMismatch.blocked && accManifestMismatch.text.includes('accept.smoke.stale'),
      `Expected manifest acceptance to reject overlay-only smoke report, got: ${accManifestMismatch.text}`
    );

    // Mutate standalone archive -> SHA-256 no longer matches overlay report -> accept.smoke.stale
    const v2ArchiveModified = path.join(root33, 'data.mpk');
    fs.copyFileSync(path.join(patchPrefixedDir, 'files', 'game', 'data.mpk'), v2ArchiveModified);
    const accOvStale = acceptVnRelease(ws33, {
      archive: v2ArchiveModified,
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(
      accOvStale.blocked && accOvStale.text.includes('accept.smoke.stale'),
      `Expected mutated standalone archive to trigger accept.smoke.stale, got: ${accOvStale.text}`
    );

    // Single-file overlayPath auto-infers unique overlayTarget (`game/data.mpk`) and unlocks vn_accept for that file
    const singleFileSmoke = await runVnSmokeTest(ws33, {
      overlayPath: v2ArchiveModified,
      driver: mockOverlayPassDriver,
      skipVision: true,
    });
    assert(
      singleFileSmoke.ok === true &&
        singleFileSmoke.mode === 'overlay' &&
        singleFileSmoke.overlayTarget === 'game/data.mpk',
      `Single-file overlayPath auto-target inference failed: ${JSON.stringify(singleFileSmoke)}`
    );
    const accSinglePass = acceptVnRelease(ws33, {
      archive: v2ArchiveModified,
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(!accSinglePass.blocked, `Expected vn_accept to pass after single-file overlay smoke test, got: ${accSinglePass.text}`);

    // Passing a patch bundle dir (containing patch_manifest.json) as overlayPath routes automatically to manifest mode
    const autoManifestSmoke = await runVnSmokeTest(ws33, {
      overlayPath: patchDeclaredDir,
      driver: mockOverlayPassDriver,
      skipVision: true,
    });
    assert(
      autoManifestSmoke.ok === true && autoManifestSmoke.mode === 'manifest',
      `Expected overlayPath pointing to patch bundle dir to auto-route to manifest mode, got: ${JSON.stringify(autoManifestSmoke)}`
    );

    // Reverse gate checks (manifest smoke report vs untested standalone archive / empty patchManifestSha256):
    // 1. Accepting an untested standalone archive (not matching the manifest's artifact SHA-256) must block with accept.smoke.stale
    const accUntestedStandalone = acceptVnRelease(ws33, {
      archive: v2ArchiveModified,
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(
      accUntestedStandalone.blocked && accUntestedStandalone.text.includes('accept.smoke.stale'),
      `Manifest smoke report must NOT pass an untested standalone archive with a different SHA-256: ${accUntestedStandalone.text}`
    );

    // 2. Empty patchManifestSha256 in saved smoke report must block manifest acceptance with accept.smoke.stale
    const smokeReportPath33 = path.join(ws33, SMOKE_REPORT_REL);
    const savedRep33 = JSON.parse(fs.readFileSync(smokeReportPath33, 'utf8'));
    savedRep33.patchManifestSha256 = '';
    fs.writeFileSync(smokeReportPath33, JSON.stringify(savedRep33, null, 2) + '\n', 'utf8');
    const accEmptySha = acceptVnRelease(ws33, {
      archive: String(wbDeclared.manifest_path),
      track: 'scenario',
      input: '.papercup/data/results/scenario.jsonl',
    });
    assert(
      accEmptySha.blocked && accEmptySha.text.includes('accept.smoke.stale'),
      `Empty patchManifestSha256 in smoke report must block manifest acceptance with accept.smoke.stale: ${accEmptySha.text}`
    );
  });

  // 34. 本地 Magpie 网关全链路集成测试（无密钥/带令牌、动态 BaseURL、真实 HTTP SSE 聊天流与视觉模态、持久化重启恢复、Env 启动与本地翻译端点兼容）
  console.log(
    '\n34. Verifying local Magpie gateway integration (keyless/keyed auth, dynamic baseUrl, real HTTP SSE & vision, persistence, env hydration, local MT preset)...'
  );
  await withIsolatedHomeAndEnv('papercup-magpie-', async ({ root: root34, home: home34, ws: ws34 }) => {
    // Unit checks on URL normalization & model family detection
    assert(
      normalizeMagpieBaseUrl('http://127.0.0.1:3425') === DEFAULT_MAGPIE_BASE_URL &&
        normalizeMagpieBaseUrl('http://127.0.0.1:3425/') === DEFAULT_MAGPIE_BASE_URL &&
        normalizeMagpieBaseUrl('http://127.0.0.1:4567/custom/v1/') === 'http://127.0.0.1:4567/custom/v1',
      'normalizeMagpieBaseUrl must normalize default root path to /v1 and preserve explicit subpaths'
    );
    assert(
      detectModelFamily('magpie/claude-sonnet-4-5') === 'claude' &&
        detectModelFamily('magpie/gpt-5') === 'openai' &&
        detectModelFamily('magpie/gemini-2.5-pro') === 'gemini',
      'detectModelFamily must resolve upstream vendor family through magpie/ prefix'
    );
    assert(
      LOCAL_ENDPOINT_PRESETS.some((p) => p.id === 'magpie' && p.baseUrl === DEFAULT_MAGPIE_BASE_URL),
      'LOCAL_ENDPOINT_PRESETS must expose Magpie default endpoint'
    );

    const magpieToken = 'mgp-secret-token-xyz-987654';
    let requireMagpieAuth = false;
    let emptyCatalogMode = false;
    const magpieModelHits: Array<{ path: string; auth: string | null }> = [];
    const magpieChatHits: Array<{
      path: string;
      auth: string | null;
      model: string;
      stream: boolean;
      hasImage: boolean;
    }> = [];

    const magpieServer = http.createServer((req, res) => {
      const reqUrl = req.url || '/';
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
      if (requireMagpieAuth && authHeader !== `Bearer ${magpieToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid Magpie token' } }));
        return;
      }

      if (req.method === 'GET' && reqUrl.endsWith('/models')) {
        magpieModelHits.push({ path: reqUrl, auth: authHeader });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: emptyCatalogMode
              ? []
              : [
                  { id: 'claude-sonnet-4-5', object: 'model' },
                  { id: 'gpt-5', object: 'model' },
                  { id: 'deepseek-chat', object: 'model' },
                  { id: 'text-embedding-3-small', object: 'model' },
                  { id: 'whisper-1', object: 'model' },
                ],
          })
        );
        return;
      }

      if (req.method === 'POST' && reqUrl.endsWith('/chat/completions')) {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const hasImage = messages.some(
            (m: any) =>
              Array.isArray(m?.content) &&
              m.content.some((p: any) => p?.type === 'image_url')
          );
          magpieChatHits.push({
            path: reqUrl,
            auth: authHeader,
            model: String(body.model || ''),
            stream: body.stream === true,
            hasImage,
          });
          const replyText = hasImage ? '{"defects":[]}' : 'magpie ok';
          if (body.stream === true) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            const chunk1 = {
              id: 'chatcmpl-magpie-1',
              object: 'chat.completion.chunk',
              model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }],
            };
            const chunk2 = {
              id: 'chatcmpl-magpie-1',
              object: 'chat.completion.chunk',
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
            };
            res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
            res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-magpie-1',
                object: 'chat.completion',
                model: body.model,
                choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
              })
            );
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => magpieServer.listen(0, '127.0.0.1', () => resolve()));
    const magpiePort = (magpieServer.address() as any).port;
    const magpieRootUrl = `http://127.0.0.1:${magpiePort}`;
    const magpieV1Url = `${magpieRootUrl}/v1`;

    let svc34a: AgentService | null = null;
    let svc34b: AgentService | null = null;
    let svc34Env: AgentService | null = null;
    let sseServer34: any = null;
    try {
      svc34a = new AgentService(ws34, { sessionMode: 'persist' });
      const app34a = createApiRouter(svc34a);

      // 34a. Keyless Magpie connect with bare origin URL (auto-normalized to /v1)
      const connectRes = await app34a.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'magpie', apiKey: '', baseUrl: magpieRootUrl }),
      });
      assert(connectRes.status === 200, `Expected 200 on keyless Magpie connect, got ${connectRes.status}`);
      const connectBody = await connectRes.json();
      const magpieProv = (connectBody.providers as any[]).find((p) => p.id === 'magpie');
      assert(
        connectBody.detectedProvider === 'magpie' &&
          connectBody.detectionMethod === 'manual-verified' &&
          connectBody.liveModelCount === 3 &&
          connectBody.filteredOutCount === 2 &&
          connectBody.models.some((m: any) => m.key === 'magpie/claude-sonnet-4-5' && m.reasoning === true) &&
          connectBody.models.some((m: any) => m.key === 'magpie/gpt-5' && m.reasoning === true) &&
          connectBody.models.some((m: any) => m.key === 'magpie/deepseek-chat' && m.reasoning === false) &&
          !connectBody.models.some((m: any) => /embedding|whisper/i.test(m.id)) &&
          magpieProv?.configured === true &&
          magpieProv?.source === 'stored' &&
          magpieProv?.savedLocally === true &&
          magpieProv?.supportsBaseUrl === true &&
          magpieProv?.apiKeyOptional === true &&
          magpieProv?.hasApiKey === false &&
          magpieProv?.baseUrl === magpieV1Url,
        `Unexpected keyless Magpie connect payload: ${JSON.stringify(connectBody)}`
      );
      assert(
        magpieModelHits.length === 1 &&
          magpieModelHits[0].path === '/v1/models' &&
          magpieModelHits[0].auth === null,
        `Keyless /models probe must omit Authorization header: ${JSON.stringify(magpieModelHits)}`
      );

      // Ensure keyless runtime sentinel 'magpie' is NEVER added to secret redaction list
      const knownSecretsKeyless = Array.from((svc34a as any).getAllKnownSecrets() as Iterable<string>);
      assert(
        !knownSecretsKeyless.includes(MAGPIE_KEYLESS_RUNTIME_TOKEN) &&
          redactSecrets('using magpie local gateway', knownSecretsKeyless) === 'using magpie local gateway',
        `Keyless sentinel must not cause false-positive redaction of "magpie": ${JSON.stringify(knownSecretsKeyless)}`
      );

      // 34b. Real HTTP streaming chat completion over /api/turns/stream SSE + multimodal Smoke Vision (keyless => auth === null!)
      const selectClaudeRes = await app34a.request('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'magpie/claude-sonnet-4-5' }),
      });
      assert(selectClaudeRes.status === 200, `Expected 200 selecting magpie/claude-sonnet-4-5`);
      const activeClaudeModel = (svc34a as any).currentSession?.model;
      assert(
        activeClaudeModel?.provider === 'magpie' &&
          activeClaudeModel?.baseUrl === magpieV1Url &&
          Array.isArray(activeClaudeModel?.input) &&
          activeClaudeModel.input.includes('image'),
        `magpie/claude-sonnet-4-5 must infer image modality and dynamic baseUrl: ${JSON.stringify(activeClaudeModel)}`
      );

      // Real HTTP SSE chat turn through Magpie streaming /v1/chat/completions
      const ssePort34 = await new Promise<number>((resolve) => {
        sseServer34 = serve({ fetch: app34a.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
          resolve(info.port);
        });
      });
      const sseAbort34 = new AbortController();
      const sseEvents34: Array<{ event: string; data: any }> = [];
      let receivedMagpieFinish!: () => void;
      const magpieFinishPromise = new Promise<void>((resolve) => {
        receivedMagpieFinish = resolve;
      });
      const sseResponse34 = await fetch(`http://127.0.0.1:${ssePort34}/api/turns/stream`, {
        signal: sseAbort34.signal,
      });
      assert(sseResponse34.ok && sseResponse34.body, `Expected open SSE stream on 34b, got ${sseResponse34.status}`);
      const sseReader34 = sseResponse34.body!.getReader();
      const ssePump34 = (async () => {
        const decoder = new TextDecoder();
        let buf = '';
        let curEv = 'message';
        try {
          while (true) {
            const { value, done } = await sseReader34.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('event:')) {
                curEv = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                const raw = line.slice(5).trim();
                let parsed: any = raw;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  // keep raw string
                }
                sseEvents34.push({ event: curEv, data: parsed });
                if (curEv === 'turn_finished' || curEv === 'turn_error') {
                  receivedMagpieFinish();
                }
              }
            }
          }
        } catch {
          // Expected when aborted
        }
      })();

      const startTurn34Res = await fetch(`http://127.0.0.1:${ssePort34}/api/turns/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'ping magpie streaming' }),
      });
      assert(startTurn34Res.status === 200, `Expected 200 starting real Magpie HTTP turn, got ${startTurn34Res.status}`);
      await Promise.race([
        magpieFinishPromise,
        new Promise<void>((_r, reject) => setTimeout(() => reject(new Error('Timed out waiting for Magpie SSE turn_finished')), 8000)),
      ]);
      sseAbort34.abort();
      await ssePump34;
      await new Promise<void>((resolve) => sseServer34.close(() => resolve()));
      sseServer34 = null;

      assert(
        magpieChatHits.some(
          (h) =>
            h.path === '/v1/chat/completions' &&
            h.model === 'claude-sonnet-4-5' &&
            h.stream === true &&
            h.hasImage === false &&
            h.auth === null
        ) &&
          sseEvents34.some((e) => e.event === 'text_delta' && String(e.data?.delta || '').includes('magpie ok')) &&
          sseEvents34.some((e) => e.event === 'turn_finished'),
        `Expected real HTTP streaming Magpie turn with auth===null and SSE text_delta/turn_finished: hits=${JSON.stringify(magpieChatHits)}, sse=${JSON.stringify(sseEvents34)}`
      );

      const tinyPngPath = path.join(root34, 'frame.png');
      fs.writeFileSync(
        tinyPngPath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b0AAAAASUVORK5CYII=',
          'base64'
        )
      );
      const visionBridge = createSmokeVisionBridge({
        getModel: () => (svc34a as any).currentSession?.model,
        getModelRuntime: () => (svc34a as any).currentSession?.modelRuntime,
      });
      const visionOut = await visionBridge.inspectFrames!(
        [{ label: 'title', path: tinyPngPath }],
        { targetLang: 'zh', sampleTranslations: ['测试译文'] }
      );
      assert(
        visionOut.status === 'checked' &&
          visionOut.defects.length === 0 &&
          magpieChatHits.some(
            (h) =>
              h.path === '/v1/chat/completions' &&
              h.model === 'claude-sonnet-4-5' &&
              h.hasImage === true &&
              h.auth === null
          ),
        `Expected real HTTP multimodal vision via keyless Magpie (auth===null) to succeed, got visionOut=${JSON.stringify(visionOut)} hits=${JSON.stringify(magpieChatHits)}`
      );

      // Switching to pure-text magpie/deepseek-chat degrades vision cleanly
      await app34a.request('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'magpie/deepseek-chat' }),
      });
      const deepseekModel = (svc34a as any).currentSession?.model;
      assert(
        Array.isArray(deepseekModel?.input) && !deepseekModel.input.includes('image'),
        `magpie/deepseek-chat should remain text-only`
      );
      const visionSkipped = await visionBridge.inspectFrames!(
        [{ label: 'title', path: tinyPngPath }],
        { targetLang: 'zh', sampleTranslations: [] }
      );
      assert(
        visionSkipped.status === 'skipped',
        `Pure-text Magpie model should skip vision cleanly, got ${JSON.stringify(visionSkipped)}`
      );

      // 34c. Persistence on disk & restart recovery (keyless)
      const authPath34 = path.join(home34, '.papercup', 'auth.json');
      const authDisk = JSON.parse(fs.readFileSync(authPath34, 'utf8'));
      assert(
        authDisk.activeProvider === 'magpie' &&
          authDisk.preferredModel === 'magpie/deepseek-chat' &&
          authDisk.providers?.magpie?.keyless === true &&
          authDisk.providers?.magpie?.apiKey === undefined &&
          authDisk.providers?.magpie?.baseUrl === magpieV1Url &&
          Array.isArray(authDisk.providers?.magpie?.liveModels) &&
          authDisk.providers.magpie.liveModels.length === 3,
        `Unexpected persisted keyless auth.json: ${JSON.stringify(authDisk)}`
      );

      // Restart simulation: brand-new AgentService restores keyless Magpie automatically
      (svc34a as any).disposeCurrentSessionState?.(true);
      svc34a = null;
      svc34b = new AgentService(ws34, { sessionMode: 'persist' });
      const app34b = createApiRouter(svc34b);
      const restoredState = await (await app34b.request('/api/models')).json();
      const restoredProv = (restoredState.providers as any[]).find((p) => p.id === 'magpie');
      assert(
        restoredState.current === 'magpie/deepseek-chat' &&
          restoredState.models.length === 3 &&
          restoredProv?.configured === true &&
          restoredProv?.source === 'stored' &&
          restoredProv?.baseUrl === magpieV1Url &&
          (svc34b as any).currentSession?.model?.baseUrl === magpieV1Url,
        `Restart recovery for keyless Magpie failed: ${JSON.stringify(restoredState)}`
      );

      // 34d. Keyed Magpie auth rejection (401) + valid token + custom model + dynamic baseUrl update + redaction
      requireMagpieAuth = true;
      const unauthRes = await app34b.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'magpie', apiKey: '', baseUrl: magpieV1Url }),
      });
      assert(unauthRes.status === 400, `Expected 400 on 401 Magpie gateway, got ${unauthRes.status}`);
      const unauthBody = await unauthRes.json();
      assert(
        String(unauthBody.error).includes('401') && String(unauthBody.error).includes('令牌'),
        `Expected actionable 401 Magpie error, got ${JSON.stringify(unauthBody)}`
      );

      const keyedRes = await app34b.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'magpie',
          apiKey: magpieToken,
          baseUrl: `${magpieRootUrl}/custom/v1`,
          customModel: 'my-local-qwen3-vl',
        }),
      });
      assert(keyedRes.status === 200, `Expected 200 on keyed Magpie connect, got ${keyedRes.status}`);
      const keyedBody = await keyedRes.json();
      const keyedProv = (keyedBody.providers as any[]).find((p) => p.id === 'magpie');
      assert(
        keyedBody.current === 'magpie/my-local-qwen3-vl' &&
          !JSON.stringify(keyedBody).includes(magpieToken) &&
          keyedProv?.hasApiKey === true &&
          keyedProv?.baseUrl === `${magpieRootUrl}/custom/v1` &&
          (svc34b as any).currentSession?.model?.baseUrl === `${magpieRootUrl}/custom/v1` &&
          (svc34b as any).currentSession?.model?.input?.includes('image'),
        `Unexpected keyed Magpie + customModel payload: ${JSON.stringify(keyedBody)}`
      );
      const knownSecretsKeyed = Array.from((svc34b as any).getAllKnownSecrets() as Iterable<string>);
      assert(
        redactSecrets(`token=${magpieToken}`, knownSecretsKeyed) === 'token=[REDACTED]',
        'Real Magpie token must be redacted by getAllKnownSecrets'
      );

      // 34e. Empty /models catalog rejected without customModel, accepted with customModel; unreachable fails fast
      emptyCatalogMode = true;
      const emptyNoCustomRes = await app34b.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'magpie', apiKey: magpieToken, baseUrl: magpieV1Url }),
      });
      // Because savedRecord still holds customModels ('my-local-qwen3-vl'), clear first to test truly empty Magpie
      const clearRes = await app34b.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'magpie', apiKey: '', clear: true }),
      });
      assert(clearRes.status === 200, `Expected 200 clearing Magpie, got ${clearRes.status}`);
      const clearBody = await clearRes.json();
      const clearedProv = (clearBody.providers as any[]).find((p) => p.id === 'magpie');
      assert(
        clearBody.current === null &&
          clearedProv?.configured === false &&
          !clearedProv?.savedLocally,
        `Expected Magpie cleared cleanly, got ${JSON.stringify(clearBody)}`
      );
      const authAfterClear = JSON.parse(fs.readFileSync(authPath34, 'utf8'));
      assert(
        !authAfterClear.providers?.magpie && authAfterClear.activeProvider === null,
        `Expected magpie deleted from auth.json after clear: ${JSON.stringify(authAfterClear)}`
      );
      assert(emptyNoCustomRes.status === 200, 'When prior customModels existed, empty /models still kept customModel');

      const trulyEmptyRes = await app34b.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'magpie', apiKey: magpieToken, baseUrl: magpieV1Url }),
      });
      assert(
        trulyEmptyRes.status === 400,
        `Expected 400 when Magpie /models is empty and no customModel provided, got ${trulyEmptyRes.status}`
      );

      // Unreachable Magpie returns clear 400 error (does not silently succeed)
      const unreachableRes = await app34b.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'magpie', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1' }),
      });
      assert(
        unreachableRes.status === 400,
        `Expected 400 on unreachable Magpie gateway, got ${unreachableRes.status}`
      );
      const unreachableBody = await unreachableRes.json();
      assert(
        String(unreachableBody.error).includes('无法连接 Magpie'),
        `Expected actionable unreachable Magpie message, got ${JSON.stringify(unreachableBody)}`
      );

      // 34f. Local MT endpoint probing & Ollama non-interference + MAGPIE_BASE_URL env startup hydration
      emptyCatalogMode = false;
      requireMagpieAuth = false;
      const ollamaDetect = await detectLocalOllamaOrigin(magpieV1Url);
      assert(
        ollamaDetect.isOllama === false,
        `Magpie gateway must never be misidentified as Ollama: ${JSON.stringify(ollamaDetect)}`
      );
      const localProbe = await probeLocalTranslatorEndpoint(magpieV1Url);
      assert(
        localProbe.ok && localProbe.models.some((m) => m.id === 'gpt-5'),
        `Local translator probe against Magpie failed: ${JSON.stringify(localProbe)}`
      );

      process.env.MAGPIE_BASE_URL = magpieRootUrl;
      svc34Env = new AgentService(ws34, { sessionMode: 'memory' });
      const envState = await svc34Env.getModelsState();
      const envProv = envState.providers.find((p) => p.id === 'magpie');
      assert(
        envProv?.configured === true &&
          envProv?.baseUrl === magpieV1Url &&
          envState.models.some((m) => m.key === 'magpie/gpt-5') &&
          Boolean(envState.current?.startsWith('magpie/')),
        `MAGPIE_BASE_URL env auto-hydration failed: ${JSON.stringify(envState)}`
      );
    } finally {
      if (sseServer34) {
        try {
          await new Promise<void>((resolve) => sseServer34.close(() => resolve()));
        } catch {
          // Ignore
        }
      }
      (svc34a as any)?.disposeCurrentSessionState?.(true);
      (svc34b as any)?.disposeCurrentSessionState?.(true);
      (svc34Env as any)?.disposeCurrentSessionState?.(true);
      await new Promise<void>((resolve) => magpieServer.close(() => resolve()));
    }
  });

  // 35. 主对话与交互式子代理统一 Steer / Follow-up 队列、404/409/clear、willRetry 保护、persist 持久化恢复、并发 turnLock 与忙锁验证
  console.log('\n35. Verifying unified Steer & Follow-up queue, 404/409/clear, willRetry protection, persist reload, concurrent turnLock & busy workspace guards...');
  await withIsolatedHomeAndEnv('papercup-steer-35-', async ({ root: root35, ws: ws35 }) => {
    // Pure helper unit assertions for buildRestoredDraft
    const pureEmpty = buildRestoredDraft([], []);
    assert(pureEmpty === null, 'Empty queues must yield null restoredDraft');
    const pureMulti = buildRestoredDraft(['S1', 'S2'], ['F1', 'F2', 'F3']);
    assert(
      pureMulti !== null &&
        pureMulti.text === 'S1\n\nS2\n\nF1' &&
        pureMulti.steeringCount === 2 &&
        pureMulti.restoredFollowUpCount === 1 &&
        pureMulti.droppedFollowUpCount === 2,
      `Unexpected buildRestoredDraft output: ${JSON.stringify(pureMulti)}`
    );
    const pureFollowOnly = buildRestoredDraft([], ['EarliestF', 'LaterF']);
    assert(
      pureFollowOnly !== null &&
        pureFollowOnly.text === 'EarliestF' &&
        pureFollowOnly.steeringCount === 0 &&
        pureFollowOnly.restoredFollowUpCount === 1 &&
        pureFollowOnly.droppedFollowUpCount === 1,
      `Expected only earliest followUp restored, got: ${JSON.stringify(pureFollowOnly)}`
    );

    const mainFaux35 = createFauxCore({ provider: 'faux-steer-main', models: [{ id: 'steer-main-1', reasoning: true }] });
    const subFaux35 = createFauxCore({ provider: 'faux-steer-sub', models: [{ id: 'steer-sub-1', reasoning: true }] });

    const svc35 = new AgentService(ws35, { sessionMode: 'memory' });
    const router35 = createApiRouter(svc35);
    const events35: Array<{ type: string; data: any }> = [];
    svc35.on('agent_event', (ev: { type: string; data: any }) => {
      events35.push(ev);
    });

    const waitUntil = async (pred: () => boolean, label: string, timeoutMs = 6000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Timed out waiting for: ${label}`);
    };

    let persistSvc35a: AgentService | null = null;
    let persistSvc35b: AgentService | null = null;
    try {
      await (svc35 as any).initSession();
      const mainSess35 = (svc35 as any).currentSession;
      mainSess35.agent.state.model = mainFaux35.getModel();
      mainSess35.agent.streamFunction = mainFaux35.streamSimple;
      mainSess35._modelRuntime.hasConfiguredAuth = () => true;
      assert(
        mainSess35.steeringMode === 'all' && mainSess35.followUpMode === 'one-at-a-time',
        `Expected main session steeringMode=all & followUpMode=one-at-a-time, got ${mainSess35.steeringMode} / ${mainSess35.followUpMode}`
      );

      const subMgr35 = (svc35 as any).subagentManager as SubagentManager;
      const origCreate35 = subMgr35.createSubagentSession.bind(subMgr35);
      subMgr35.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate35(roleName, opts);
        assert(
          (res.session as any).steeringMode === 'all' &&
            (res.session as any).followUpMode === 'one-at-a-time',
          `Expected subagent steeringMode=all & followUpMode=one-at-a-time, got ${(res.session as any).steeringMode} / ${(res.session as any).followUpMode}`
        );
        (res.session as any).agent.state.model = subFaux35.getModel();
        (res.session as any).agent.streamFunction = subFaux35.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      // 35a. Main conversation Steer (all) + multi-segment streaming + history refresh consistency
      let notify35aStep1!: () => void;
      const step1Started35a = new Promise<void>((r) => (notify35aStep1 = r));
      let release35aStep1!: () => void;
      const step1Gate35a = new Promise<void>((r) => (release35aStep1 = r));

      let notify35aStep2!: () => void;
      const step2Started35a = new Promise<void>((r) => (notify35aStep2 = r));
      let release35aStep2!: () => void;
      const step2Gate35a = new Promise<void>((r) => (release35aStep2 = r));

      let step2SeenUsers: string[] = [];
      mainFaux35.setResponses([
        async () => {
          notify35aStep1();
          await step1Gate35a;
          return fauxAssistantMessage('第一段初步方案。');
        },
        async (ctx) => {
          step2SeenUsers = ctx.messages
            .filter((m) => m.role === 'user')
            .map((m) =>
              typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                  ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
                  : ''
            );
          notify35aStep2();
          await step2Gate35a;
          return fauxAssistantMessage('已采纳全部两条插话纠正并完成方案。');
        },
      ]);

      const turn35aPromise = svc35.executeTurn('初始分析请求');
      await step1Started35a;

      // Verify busy workspace select & remove are rejected with 409 while a turn is active
      const altWs35 = path.join(root35, 'alt-ws-35');
      fs.mkdirSync(altWs35, { recursive: true });
      const busySelWsRes = await router35.request('/api/workspaces/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: altWs35 }),
      });
      assert(busySelWsRes.status === 409, `Expected 409 on /api/workspaces/select while busy, got ${busySelWsRes.status}`);
      const busyRemWsRes = await router35.request('/api/workspaces/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: ws35 }),
      });
      assert(busyRemWsRes.status === 409, `Expected 409 on /api/workspaces/remove while busy, got ${busyRemWsRes.status}`);

      const s1Res = await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '改用 UTF-8 编码', mode: 'steer' }),
      });
      assert(s1Res.status === 202, `Expected 202 queueing steer S1, got ${s1Res.status}`);
      const s2Res = await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '同时跳过备份目录', mode: 'steer' }),
      });
      assert(s2Res.status === 202, `Expected 202 queueing steer S2, got ${s2Res.status}`);
      const statusMid35a = await (await router35.request('/api/turns/status')).json();
      assert(
        statusMid35a.pendingQueue?.steering?.length === 2 && statusMid35a.pendingQueue?.followUp?.length === 0,
        `Expected 2 pending steer items in /api/turns/status, got: ${JSON.stringify(statusMid35a.pendingQueue)}`
      );

      release35aStep1();
      await step2Started35a;

      assert(
        step2SeenUsers.length === 3 &&
          step2SeenUsers[0] === '初始分析请求' &&
          step2SeenUsers[1] === '改用 UTF-8 编码' &&
          step2SeenUsers[2] === '同时跳过备份目录',
        `Expected steeringMode=all to deliver both steers together before step 2, got: ${JSON.stringify(step2SeenUsers)}`
      );

      const segCommits35a = events35.filter((e) => e.type === 'turn_segment_commit');
      const injectedUsers35a = events35.filter((e) => e.type === 'turn_user_injected');
      assert(
        segCommits35a.length === 1 &&
          segCommits35a[0].data?.message?.content === '第一段初步方案。' &&
          injectedUsers35a.length === 2 &&
          injectedUsers35a.every((e) => e.data?.message?.deliveryMode === 'steer'),
        `Expected 1 assistant segment commit (no blank assistant between batched steers) & 2 steer injections, got commits=${JSON.stringify(segCommits35a)} injected=${JSON.stringify(injectedUsers35a)}`
      );

      // Mid-turn refresh consistency check while step 2 is in flight
      const midHistory35a = await (await router35.request('/api/session/history')).json();
      assert(
        midHistory35a.isRunning === true &&
          midHistory35a.messages.length === 4 &&
          midHistory35a.messages[0].content === '初始分析请求' &&
          midHistory35a.messages[1].role === 'assistant' &&
          midHistory35a.messages[1].content === '第一段初步方案。' &&
          midHistory35a.messages[2].content === '改用 UTF-8 编码' &&
          midHistory35a.messages[2].deliveryMode === 'steer' &&
          midHistory35a.messages[3].content === '同时跳过备份目录' &&
          midHistory35a.messages[3].deliveryMode === 'steer' &&
          midHistory35a.pendingQueue?.steering?.length === 0,
        `Mid-turn history mismatch after steer delivery: ${JSON.stringify(midHistory35a.messages)}`
      );

      release35aStep2();
      await turn35aPromise;

      const finalHistory35a = await (await router35.request('/api/session/history')).json();
      assert(
        finalHistory35a.isRunning === false &&
          finalHistory35a.messages.length === 5 &&
          finalHistory35a.messages[2].deliveryMode === 'steer' &&
          finalHistory35a.messages[3].deliveryMode === 'steer' &&
          finalHistory35a.messages[4].content === '已采纳全部两条插话纠正并完成方案。',
        `Post-turn history mismatch: ${JSON.stringify(finalHistory35a.messages)}`
      );

      // 35b. Follow-up one-at-a-time + queue PATCH/DELETE/404 NOT_FOUND/409 ALREADY_DELIVERED/clear + idle 409 check
      const idleQueueRes = await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'idle test', mode: 'steer' }),
      });
      assert(idleQueueRes.status === 409, `Expected 409 when idle, got ${idleQueueRes.status}`);
      const idleQueueBody = await idleQueueRes.json();
      assert(idleQueueBody.code === 'TURN_NOT_RUNNING', `Expected TURN_NOT_RUNNING code, got: ${JSON.stringify(idleQueueBody)}`);

      events35.length = 0;
      let notify35bStep1!: () => void;
      const step1Started35b = new Promise<void>((r) => (notify35bStep1 = r));
      let release35bStep1!: () => void;
      const step1Gate35b = new Promise<void>((r) => (release35bStep1 = r));
      let notify35bStep2!: () => void;
      const step2Started35b = new Promise<void>((r) => (notify35bStep2 = r));
      let release35bStep2!: () => void;
      const step2Gate35b = new Promise<void>((r) => (release35bStep2 = r));

      let step2QueueSnapshot: any = null;
      mainFaux35.setResponses([
        async () => {
          notify35bStep1();
          await step1Gate35b;
          return fauxAssistantMessage('第1轮主任务完成。');
        },
        async () => {
          step2QueueSnapshot = svc35.getMainQueueState();
          notify35bStep2();
          await step2Gate35b;
          return fauxAssistantMessage('第2轮处理了第一条 followUp。');
        },
        async () => fauxAssistantMessage('第3轮处理了第二条 followUp。'),
      ]);

      const turn35bPromise = svc35.executeTurn('测试排队顺序');
      await step1Started35b;

      const qA = await (
        await router35.request('/api/turns/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '排在第二的任务A', mode: 'steer' }),
        })
      ).json();
      const qB = await (
        await router35.request('/api/turns/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '将被撤回的任务B', mode: 'followUp' }),
        })
      ).json();
      const qC = await (
        await router35.request('/api/turns/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '最先执行的任务C', mode: 'followUp' }),
        })
      ).json();

      // Unknown queue ID must return 404 NOT_FOUND (distinct from 409 ALREADY_DELIVERED)
      const unknownPatchRes = await router35.request('/api/turns/queue/never-existed-id-35b', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'steer' }),
      });
      assert(unknownPatchRes.status === 404, `Expected 404 patching unknown queue ID, got ${unknownPatchRes.status}`);
      assert((await unknownPatchRes.json()).code === 'NOT_FOUND', 'Expected NOT_FOUND code on unknown PATCH');
      const unknownDelRes = await router35.request('/api/turns/queue/never-existed-id-35b', {
        method: 'DELETE',
      });
      assert(unknownDelRes.status === 404, `Expected 404 deleting unknown queue ID, got ${unknownDelRes.status}`);
      assert((await unknownDelRes.json()).code === 'NOT_FOUND', 'Expected NOT_FOUND code on unknown DELETE');

      // Switch A from steer -> followUp (placed after B, C), then remove B -> leaving followUp: [C, A]
      const patchARes = await router35.request(`/api/turns/queue/${encodeURIComponent(qA.item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'followUp' }),
      });
      assert(patchARes.status === 200, `Expected 200 switching A to followUp, got ${patchARes.status}`);
      const delBRes = await router35.request(`/api/turns/queue/${encodeURIComponent(qB.item.id)}`, {
        method: 'DELETE',
      });
      assert(delBRes.status === 200, `Expected 200 deleting B, got ${delBRes.status}`);
      const delBBody = await delBRes.json();
      assert(
        delBBody.removed?.text === '将被撤回的任务B' &&
          delBBody.queue.steering.length === 0 &&
          delBBody.queue.followUp.map((i: any) => i.text).join(',') === '最先执行的任务C,排在第二的任务A',
        `Unexpected queue state after PATCH/DELETE: ${JSON.stringify(delBBody)}`
      );

      release35bStep1();
      await step2Started35b;
      // Under followUpMode=one-at-a-time, C was delivered while A must still be pending!
      assert(
        step2QueueSnapshot.steering.length === 0 &&
          step2QueueSnapshot.followUp.length === 1 &&
          step2QueueSnapshot.followUp[0].text === '排在第二的任务A',
        `Expected followUpMode=one-at-a-time to leave A pending during C's turn, got: ${JSON.stringify(step2QueueSnapshot)}`
      );
      // Verify attempting to delete already-delivered C returns 409 ALREADY_DELIVERED
      const staleDelC = await router35.request(`/api/turns/queue/${encodeURIComponent(qC.item.id)}`, {
        method: 'DELETE',
      });
      assert(staleDelC.status === 409, `Expected 409 removing already-delivered C, got ${staleDelC.status}`);
      assert((await staleDelC.json()).code === 'ALREADY_DELIVERED', 'Expected ALREADY_DELIVERED error code');

      release35bStep2();
      await turn35bPromise;

      const injected35b = events35.filter((e) => e.type === 'turn_user_injected').map((e) => e.data.message);
      assert(
        injected35b.length === 2 &&
          injected35b[0].content === '最先执行的任务C' &&
          injected35b[0].deliveryMode === 'followUp' &&
          injected35b[1].content === '排在第二的任务A' &&
          injected35b[1].deliveryMode === 'followUp',
        `Unexpected followUp delivery sequence: ${JSON.stringify(injected35b)}`
      );

      // 35b-2. DELETE /api/turns/queue clears all pending items and returns restoredDraft + concurrent /api/turns/start turnLock check
      let notify35bClear!: () => void;
      const clearStarted35b = new Promise<void>((r) => (notify35bClear = r));
      let release35bClear!: () => void;
      const clearGate35b = new Promise<void>((r) => (release35bClear = r));
      mainFaux35.setResponses([
        async () => {
          notify35bClear();
          await clearGate35b;
          return fauxAssistantMessage('清空队列测试完成。');
        },
      ]);
      const [raceStart1, raceStart2] = await Promise.all([
        router35.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '并发启动测试1' }),
        }),
        router35.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '并发启动测试2' }),
        }),
      ]);
      const raceStatuses = [raceStart1.status, raceStart2.status].sort();
      assert(
        raceStatuses[0] === 200 && raceStatuses[1] === 409,
        `Concurrent /api/turns/start must atomically yield [200, 409] via synchronous turnLock, got ${JSON.stringify(raceStatuses)}`
      );
      await clearStarted35b;
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '待清空插话', mode: 'steer' }),
      });
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '待清空后续1', mode: 'followUp' }),
      });
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '待清空后续2', mode: 'followUp' }),
      });
      const clearMainRes = await router35.request('/api/turns/queue', { method: 'DELETE' });
      assert(clearMainRes.status === 200, `Expected 200 on DELETE /api/turns/queue, got ${clearMainRes.status}`);
      const clearMainBody = await clearMainRes.json();
      assert(
        clearMainBody.ok === true &&
          clearMainBody.queue.steering.length === 0 &&
          clearMainBody.queue.followUp.length === 0 &&
          clearMainBody.restoredDraft?.text === '待清空插话\n\n待清空后续1' &&
          clearMainBody.restoredDraft?.droppedFollowUpCount === 1,
        `Unexpected DELETE /api/turns/queue payload: ${JSON.stringify(clearMainBody)}`
      );
      // Verify agent_end(willRetry=true) preserves pending queue while agent_end(willRetry=false) clears/restores it
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '重试期间保留的插话', mode: 'steer' }),
      });
      (svc35 as any).lastTurnError = '429 transient rate limit';
      (svc35 as any).activeTurnRestoredDraft = null;
      (svc35 as any).handlePiSessionEvent({ type: 'agent_end', willRetry: true });
      assert(
        svc35.getMainQueueState().steering.length === 1 && (svc35 as any).activeTurnRestoredDraft === null,
        `agent_end(willRetry=true) must NOT wipe pending queue: ${JSON.stringify(svc35.getMainQueueState())}`
      );
      (svc35 as any).handlePiSessionEvent({ type: 'agent_end', willRetry: false });
      assert(
        svc35.getMainQueueState().steering.length === 0 &&
          (svc35 as any).activeTurnRestoredDraft?.text === '重试期间保留的插话',
        `agent_end(willRetry=false) must clear queue and build restoredDraft: ${JSON.stringify((svc35 as any).activeTurnRestoredDraft)}`
      );
      (svc35 as any).lastTurnError = undefined;
      (svc35 as any).activeTurnRestoredDraft = null;
      release35bClear();
      await waitUntil(() => !svc35.isBusy(), 'turn idle after clear/willRetry check');

      // 35c. Abort & Error restore draft rule: all steer + ONLY earliest followUp, zero leftover on next turn
      events35.length = 0;
      let notify35cAbortStarted!: () => void;
      const abortStarted35c = new Promise<void>((r) => (notify35cAbortStarted = r));
      mainFaux35.setResponses([
        (_ctx, opts) =>
          new Promise((resolve) => {
            notify35cAbortStarted();
            const timer = setTimeout(() => resolve(fauxAssistantMessage('late 35c')), 5000);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
              },
              { once: true }
            );
          }),
      ]);

      const abortTurnPromise = svc35.executeTurn('即将中止的回合');
      await abortStarted35c;

      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '紧急纠偏', mode: 'steer' }),
      });
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '后续任务1', mode: 'followUp' }),
      });
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '后续任务2', mode: 'followUp' }),
      });
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '后续任务3', mode: 'followUp' }),
      });

      const abortRes35c = await router35.request('/api/turns/abort', { method: 'POST' });
      assert(abortRes35c.status === 200, `Expected 200 from /api/turns/abort, got ${abortRes35c.status}`);
      const abortBody35c = await abortRes35c.json();
      await abortTurnPromise;

      assert(
        abortBody35c.aborted === true &&
          abortBody35c.restoredDraft?.text === '紧急纠偏\n\n后续任务1' &&
          abortBody35c.restoredDraft?.steeringCount === 1 &&
          abortBody35c.restoredDraft?.restoredFollowUpCount === 1 &&
          abortBody35c.restoredDraft?.droppedFollowUpCount === 2,
        `Unexpected abort restoredDraft payload: ${JSON.stringify(abortBody35c)}`
      );
      const finishEv35c = events35.find((e) => e.type === 'turn_finished');
      assert(
        finishEv35c?.data?.restoredDraft?.restoreId === abortBody35c.restoredDraft.restoreId,
        `Expected turn_finished SSE to carry identical restoreId for dedup, got: ${JSON.stringify(finishEv35c)}`
      );

      // Next turn must NOT consume any leftover queued messages!
      let nextTurnCalls35c = 0;
      mainFaux35.setResponses([
        () => {
          nextTurnCalls35c += 1;
          return fauxAssistantMessage('干净的新回合回复。');
        },
        () => {
          nextTurnCalls35c += 1;
          return fauxAssistantMessage('不应被残留队列触发。');
        },
      ]);
      await svc35.executeTurn('全新独立提问');
      assert(nextTurnCalls35c === 1, `Expected zero leftover queue executions after abort, got ${nextTurnCalls35c} LLM calls`);

      // Error path with 2 followUps restores ONLY earliest followUp
      events35.length = 0;
      let notify35cErrStarted!: () => void;
      const errStarted35c = new Promise<void>((r) => (notify35cErrStarted = r));
      let release35cErr!: () => void;
      const errGate35c = new Promise<void>((r) => (release35cErr = r));
      mainFaux35.setResponses([
        async () => {
          notify35cErrStarted();
          await errGate35c;
          return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 invalid api key' });
        },
      ]);
      const errTurnPromise = svc35.executeTurn('触发模型报错');
      await errStarted35c;
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '早排队', mode: 'followUp' }),
      });
      await router35.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '晚排队', mode: 'followUp' }),
      });
      release35cErr();
      await errTurnPromise;
      const errEv35c = events35.find((e) => e.type === 'turn_error');
      assert(
        errEv35c?.data?.restoredDraft?.text === '早排队' &&
          errEv35c?.data?.restoredDraft?.steeringCount === 0 &&
          errEv35c?.data?.restoredDraft?.restoredFollowUpCount === 1 &&
          errEv35c?.data?.restoredDraft?.droppedFollowUpCount === 1,
        `Expected turn_error to restore only earliest followUp, got: ${JSON.stringify(errEv35c)}`
      );

      // 35d. Delegated subagent (reverser) live Steer + stall/failure reset (explicit budget preserved) + main session note
      events35.length = 0;
      const tomlPath35d = path.join(ws35, 'papercup.toml');
      fs.writeFileSync(
        tomlPath35d,
        '[vn.research]\nmax_reverser_tool_calls = 25\nmax_reverser_stall_calls = 15\n',
        'utf8'
      );
      let notifySub35dStep2!: () => void;
      const subStep2Started35d = new Promise<void>((r) => (notifySub35dStep2 = r));
      let releaseSub35dStep2!: () => void;
      const subStep2Gate35d = new Promise<void>((r) => (releaseSub35dStep2 = r));

      let delegatedTaskId35d = '';
      let sub35dSawSteer: boolean = false;
      let preSteerFailureCount = 0;
      let preSteerStallCount = 0;
      let preSteerMaxTools = 0;
      let postSteerFailureCount = -1;
      let postSteerStallCount = -1;
      let postSteerMaxTools = 0;
      let mainSawSteerToolNote = '';
      let mainSawSteerDetailsCount = 0;

      subFaux35.setResponses([
        // Step 1: trigger a tool failure (read missing file) to increment consecutiveHypothesisFailures & callsSinceProgress
        () =>
          fauxAssistantMessage([
            fauxToolCall('read', { path: 'definitely_missing_sample_35d.bin' }, { id: 'tc-35d-fail-read' }),
          ]),
        // Step 2: pause while user steers the running delegated reverser
        async () => {
          const runningTasks = svc35.listSubagentTasks().filter((t) => t.status === 'running' && t.role === 'reverser');
          delegatedTaskId35d = runningTasks[0]?.taskId || '';
          const snapBefore = delegatedTaskId35d ? svc35.getSubagentTask(delegatedTaskId35d) : null;
          preSteerFailureCount = snapBefore?.consecutiveHypothesisFailures ?? 0;
          preSteerStallCount = snapBefore?.callsSinceProgress ?? 0;
          preSteerMaxTools = snapBefore?.maxToolCalls ?? 0;
          notifySub35dStep2();
          await subStep2Gate35d;
          return fauxAssistantMessage('准备尝试旧假设。');
        },
        // Step 3: invoked immediately because of user steer!
        (ctx) => {
          const userTexts = ctx.messages
            .filter((m) => m.role === 'user')
            .map((m) =>
              typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                  ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
                  : ''
            );
          sub35dSawSteer = userTexts.some((t) => t.includes('不要盲猜，直接检查 header'));
          const snapAfter = delegatedTaskId35d ? svc35.getSubagentTask(delegatedTaskId35d) : null;
          postSteerFailureCount = snapAfter?.consecutiveHypothesisFailures ?? -1;
          postSteerStallCount = snapAfter?.callsSinceProgress ?? -1;
          postSteerMaxTools = snapAfter?.maxToolCalls ?? 0;
          return fauxAssistantMessage('已收到人工插话指导，改用 header 检查并得出结论。');
        },
      ]);

      mainFaux35.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall('delegate_task', { role: 'reverser', task: '分析样本结构' }, { id: 'tc-35d-del' }),
          ]),
        (ctx) => {
          const tr = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-35d-del') as any;
          mainSawSteerToolNote = Array.isArray(tr?.content)
            ? tr.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
            : '';
          mainSawSteerDetailsCount = Number(tr?.details?.userSteerCount ?? 0);
          return fauxAssistantMessage('主代理已整合人工纠偏后的逆向结果。');
        },
      ]);

      try {
        const turn35dPromise = svc35.executeTurn('委派 reverser 分析封包');
        await subStep2Started35d;
        assert(
          delegatedTaskId35d.length > 0 && preSteerFailureCount >= 1 && preSteerStallCount >= 1 && preSteerMaxTools === 25,
          `Expected active delegated reverser with failure/stall counts >= 1 and explicit maxToolCalls=25 before steer, got id=${delegatedTaskId35d}, fail=${preSteerFailureCount}, stall=${preSteerStallCount}, maxTools=${preSteerMaxTools}`
        );

        const subSteerRes = await router35.request(
          `/api/subagents/tasks/${encodeURIComponent(delegatedTaskId35d)}/queue`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '不要盲猜，直接检查 header', mode: 'steer' }),
          }
        );
        assert(subSteerRes.status === 202, `Expected 202 steering delegated reverser, got ${subSteerRes.status}`);

        releaseSub35dStep2();
        await turn35dPromise;
      } finally {
        fs.rmSync(tomlPath35d, { force: true });
      }

      assert(
        Boolean(sub35dSawSteer) &&
          postSteerFailureCount === 0 &&
          postSteerStallCount === 0 &&
          postSteerMaxTools === 25,
        `Expected delegated steer delivery to reset failure/stall counts while preserving explicit maxToolCalls=25, got saw=${sub35dSawSteer}, fail=${postSteerFailureCount}, stall=${postSteerStallCount}, maxTools=${postSteerMaxTools}`
      );
      assert(
        mainSawSteerDetailsCount === 1 &&
          mainSawSteerToolNote.includes('[user_steered_subagent count=1') &&
          mainSawSteerToolNote.includes('不要盲猜，直接检查 header'),
        `Expected delegate_task result to include compact user_steered_subagent note, got count=${mainSawSteerDetailsCount}, note=${mainSawSteerToolNote}`
      );
      const snap35dFinal = svc35.getSubagentTask(delegatedTaskId35d);
      assert(
        snap35dFinal?.messages?.some(
          (m) => m.role === 'user' && m.origin === 'direct_user' && m.deliveryMode === 'steer' && m.content.includes('不要盲猜')
        ) === true,
        `Expected steered user message recorded in subagent snapshot messages, got: ${JSON.stringify(snap35dFinal?.messages)}`
      );

      // 35e. Completed task 409, translator 400, direct subagent queue ops (incl. live PATCH/DELETE/clear) & abort restore rule
      const endedSubQueueRes = await router35.request(
        `/api/subagents/tasks/${encodeURIComponent(delegatedTaskId35d)}/queue`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '已结束任务测试', mode: 'steer' }),
        }
      );
      assert(endedSubQueueRes.status === 409, `Expected 409 on completed subagent task, got ${endedSubQueueRes.status}`);
      assert((await endedSubQueueRes.json()).code === 'TASK_NOT_RUNNING', 'Expected TASK_NOT_RUNNING code');

      // Run a translator task to verify translator role rejects queue endpoint with 400
      subFaux35.setResponses([() => fauxAssistantMessage('{"id":1,"target":"测试译文"}')]);
      const transRun35e = await subMgr35.runSubagentWithMetrics('translator', '{"id":1,"source":"テスト"}', {
        cwd: ws35,
        sessionId: (svc35 as any).sessionManager?.getSessionId?.() ?? null,
      });
      const transQueueRes = await router35.request(
        `/api/subagents/tasks/${encodeURIComponent(transRun35e.taskId)}/queue`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '不应该允许', mode: 'steer' }),
        }
      );
      assert(transQueueRes.status === 400, `Expected 400 for translator queue request, got ${transQueueRes.status}`);

      // Direct subagent chat: queue steer + 2 followUps, verify live queue state after PATCH, test DELETE /queue clear, then re-queue & abort
      events35.length = 0;
      let notifyDirect35e!: () => void;
      const directStarted35e = new Promise<void>((r) => (notifyDirect35e = r));
      subFaux35.setResponses([
        (_ctx, opts) =>
          new Promise((resolve) => {
            notifyDirect35e();
            const timer = setTimeout(() => resolve(fauxAssistantMessage('late direct 35e')), 5000);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
              },
              { once: true }
            );
          }),
      ]);

      const directStartRes = await router35.request(
        `/api/subagents/tasks/${encodeURIComponent(delegatedTaskId35d)}/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '直接对话启动测试' }),
        }
      );
      assert(directStartRes.status === 202, `Expected 202 starting direct subagent chat, got ${directStartRes.status}`);
      const directTaskId35e = String((await directStartRes.json()).taskId || '');
      await directStarted35e;

      await router35.request(`/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '子代理插话1', mode: 'steer' }),
      });
      const subQ2 = await (
        await router35.request(`/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '子代理后续1', mode: 'followUp' }),
        })
      ).json();
      await router35.request(`/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '子代理后续2', mode: 'followUp' }),
      });

      // Verify PATCH updates live queue state cleanly
      const subPatchRes = await router35.request(
        `/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue/${encodeURIComponent(subQ2.item.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'steer' }),
        }
      );
      assert(subPatchRes.status === 200 && (await subPatchRes.json()).queue.steering.length === 2, 'Subagent PATCH steer failed');
      const subPatchBackRes = await router35.request(
        `/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue/${encodeURIComponent(subQ2.item.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'followUp' }),
        }
      );
      assert(subPatchBackRes.status === 200, 'Subagent PATCH back to followUp failed');
      const subPatchBackBody = await subPatchBackRes.json();
      // Inspect live queue state (not stale creation response!)
      assert(
        subPatchBackBody.queue.steering.map((i: any) => i.text).join(',') === '子代理插话1' &&
          subPatchBackBody.queue.followUp.map((i: any) => i.text).join(',') === '子代理后续2,子代理后续1',
        `Live subagent queue order mismatch after PATCH back: ${JSON.stringify(subPatchBackBody.queue)}`
      );

      // Verify DELETE /api/subagents/tasks/:taskId/queue clears subagent queue and returns restoredDraft
      const clearSubRes = await router35.request(
        `/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue`,
        { method: 'DELETE' }
      );
      assert(clearSubRes.status === 200, `Expected 200 clearing subagent queue, got ${clearSubRes.status}`);
      const clearSubBody = await clearSubRes.json();
      assert(
        clearSubBody.ok === true &&
          clearSubBody.queue.steering.length === 0 &&
          clearSubBody.queue.followUp.length === 0 &&
          clearSubBody.restoredDraft?.text === '子代理插话1\n\n子代理后续2' &&
          clearSubBody.restoredDraft?.droppedFollowUpCount === 1,
        `Unexpected DELETE subagent queue payload: ${JSON.stringify(clearSubBody)}`
      );

      // Re-queue steer + 2 followUps to test abort restore path
      await router35.request(`/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '子代理插话1', mode: 'steer' }),
      });
      await router35.request(`/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '子代理后续2', mode: 'followUp' }),
      });
      await router35.request(`/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '子代理后续1', mode: 'followUp' }),
      });

      const abortSubRes35e = await router35.request(
        `/api/subagents/tasks/${encodeURIComponent(directTaskId35e)}/abort`,
        { method: 'POST' }
      );
      assert(abortSubRes35e.status === 200, `Expected 200 aborting direct subagent, got ${abortSubRes35e.status}`);
      const abortSubBody35e = await abortSubRes35e.json();
      await waitUntil(() => !svc35.isBusy(), 'direct subagent idle after abort');

      assert(
        abortSubBody35e.aborted === true &&
          abortSubBody35e.restoredDraft?.text === '子代理插话1\n\n子代理后续2' &&
          abortSubBody35e.restoredDraft?.steeringCount === 1 &&
          abortSubBody35e.restoredDraft?.restoredFollowUpCount === 1 &&
          abortSubBody35e.restoredDraft?.droppedFollowUpCount === 1,
        `Unexpected subagent abort restoredDraft: ${JSON.stringify(abortSubBody35e)}`
      );
      const subRestoredEv = events35.find(
        (e) => e.type === 'subagent_queue_restored' && e.data?.taskId === directTaskId35e
      );
      assert(
        subRestoredEv?.data?.restoredDraft?.restoreId === abortSubBody35e.restoredDraft.restoreId,
        `Expected subagent_queue_restored SSE with matching restoreId, got: ${JSON.stringify(subRestoredEv)}`
      );

      // 35f. persist mode session reload preserves user deliveryMode ('steer' & 'followUp') across server restart
      const persistWs35 = path.join(root35, 'persist-delivery-ws');
      fs.mkdirSync(persistWs35, { recursive: true });
      const persistFaux35 = createFauxCore({ provider: 'faux-persist-35', models: [{ id: 'persist-35-1', reasoning: true }] });
      persistSvc35a = new AgentService(persistWs35, { sessionMode: 'persist' });
      await (persistSvc35a as any).initSession();
      const persistSess35a = (persistSvc35a as any).currentSession;
      persistSess35a.agent.state.model = persistFaux35.getModel();
      persistSess35a.agent.streamFunction = persistFaux35.streamSimple;
      persistSess35a._modelRuntime.hasConfiguredAuth = () => true;
      const persistRouter35a = createApiRouter(persistSvc35a);

      let notifyP35!: () => void;
      const startedP35 = new Promise<void>((r) => (notifyP35 = r));
      let releaseP35!: () => void;
      const gateP35 = new Promise<void>((r) => (releaseP35 = r));
      persistFaux35.setResponses([
        async () => {
          notifyP35();
          await gateP35;
          return fauxAssistantMessage('第一段持久化回复。');
        },
        async () => fauxAssistantMessage('已处理持久化插话。'),
        async () => fauxAssistantMessage('已处理持久化后续。'),
      ]);
      const pTurn35 = persistSvc35a.executeTurn('持久化初始问题');
      await startedP35;
      await persistRouter35a.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '持久化插话消息', mode: 'steer' }),
      });
      await persistRouter35a.request('/api/turns/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '持久化后续消息', mode: 'followUp' }),
      });
      releaseP35();
      await pTurn35;
      (persistSvc35a as any).disposeCurrentSessionState?.(true);
      persistSvc35a = null;

      persistSvc35b = new AgentService(persistWs35, { sessionMode: 'persist' });
      const persistRouter35b = createApiRouter(persistSvc35b);
      const reloadedDeliveryHist = await (await persistRouter35b.request('/api/session/history')).json();
      const reloadedSteerMsg = reloadedDeliveryHist.messages.find((m: any) => m.content === '持久化插话消息');
      const reloadedFollowMsg = reloadedDeliveryHist.messages.find((m: any) => m.content === '持久化后续消息');
      assert(
        reloadedSteerMsg?.deliveryMode === 'steer' && reloadedFollowMsg?.deliveryMode === 'followUp',
        `Expected persisted deliveryMode restored across restart, got messages=${JSON.stringify(reloadedDeliveryHist.messages)}`
      );

      console.log('Step 35 passed (main & subagent Steer/Follow-up queue, 404/409/clear, willRetry, persist reload, concurrent turnLock & busy guards).');
    } finally {
      (persistSvc35a as any)?.disposeCurrentSessionState?.(true);
      (persistSvc35b as any)?.disposeCurrentSessionState?.(true);
      (svc35 as any).disposeCurrentSessionState?.(true);
    }
  });

  // 36. Grok-Bot-style character confirmation form full E2E over HTTP + SSE + autoContinue wake-up + locked roster injection
  console.log('\n36. Verifying end-to-end character roster extraction, in-chat confirmation form HTTP/SSE, busy 409 guard, autoContinue wake-up & locked roster injection...');
  await withIsolatedHomeAndEnv('papercup-char-form-36-', async ({ root: root36 }) => {
    const ws36 = path.join(root36, 'renpy-ws');
    const unpacked36 = path.join(ws36, '.papercup', 'tmp', 'unpacked');
    fs.mkdirSync(path.join(unpacked36, 'game'), { recursive: true });
    fs.writeFileSync(
      path.join(ws36, 'papercup.toml'),
      '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(unpacked36, 'game', 'script.rpy'),
      [
        'define e = Character("エル")',
        'define r = Character("レイ")',
        'label start:',
        '    e "おはよう、レイ！"',
        '    r "エルちゃん、今日も元気だな。"',
        '    e "もちろん！出発しよう。"',
        '',
      ].join('\n'),
      'utf8'
    );

    const mainFaux36 = createFauxCore({ provider: 'faux-main-36', models: [{ id: 'main-36-1', reasoning: true }] });
    const svc36 = new AgentService(ws36, { sessionMode: 'memory' });
    let httpServer36: ReturnType<typeof serve> | null = null;
    const sseAbort36 = new AbortController();

    const waitUntil36 = async (cond: () => boolean, label: string, timeoutMs = 8000) => {
      const start = Date.now();
      while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    try {
      await (svc36 as any).initSession();
      const sess36 = (svc36 as any).currentSession;
      sess36.agent.state.model = mainFaux36.getModel();
      sess36.agent.streamFunction = mainFaux36.streamSimple;
      sess36._modelRuntime.hasConfiguredAuth = () => true;

      const translatorPrompts36: string[] = [];
      const roleCheckerPrompts36: string[] = [];

      const subMgr36 = (svc36 as any).subagentManager as SubagentManager;
      const origCreateSub36 = subMgr36.createSubagentSession.bind(subMgr36);
      subMgr36.createSubagentSession = async (roleName, opts) => {
        const res = await origCreateSub36(roleName, opts);
        const subFaux = createFauxCore({ provider: `faux-sub-36-${roleName}`, models: [{ id: `sub-36-${roleName}`, reasoning: false }] });
        (res.session as any).agent.state.model = subFaux.getModel();
        (res.session as any).agent.streamFunction = subFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;

        if (roleName === 'translator') {
          const transMap: Record<string, string> = {
            'エル': '艾露',
            'レイ': '雷伊',
            'おはよう、レイ！': '早上好，雷伊！',
            'エルちゃん、今日も元気だな。': '小艾露，今天也很有精神啊。',
            'もちろん！出発しよう。': '当然！我们出发吧。',
          };
          const respondFn = (ctx: any) => {
            const lastUser = [...ctx.messages].reverse().find((m: any) => m.role === 'user');
            const promptText =
              typeof lastUser?.content === 'string'
                ? lastUser.content
                : Array.isArray(lastUser?.content)
                  ? lastUser.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
                  : '';
            translatorPrompts36.push(promptText);
            const batchMatch = promptText.match(/<batch\b[^>]*>\s*([\s\S]*?)\s*<\/batch>/i);
            const batchBody = batchMatch ? batchMatch[1] : promptText;
            const rows = batchBody
              .split(/\r?\n/)
              .filter((l: string) => l.trim().startsWith('{'))
              .map((l: string) => JSON.parse(l));
            const out = rows
              .map((row: any) => JSON.stringify({ id: row.id, target: transMap[String(row.source)] ?? String(row.source) }))
              .join('\n');
            return fauxAssistantMessage(out);
          };
          subFaux.setResponses(Array.from({ length: 8 }, () => respondFn));
        } else if (roleName === 'role-checker') {
          const reviewFn = (ctx: any) => {
            const lastUser = [...ctx.messages].reverse().find((m: any) => m.role === 'user');
            const promptText =
              typeof lastUser?.content === 'string'
                ? lastUser.content
                : Array.isArray(lastUser?.content)
                  ? lastUser.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
                  : '';
            roleCheckerPrompts36.push(promptText);
            return fauxAssistantMessage('Character names and aliases are fully consistent.');
          };
          subFaux.setResponses(Array.from({ length: 6 }, () => reviewFn));
        }
        return res;
      };

      const router36 = createApiRouter(svc36);
      httpServer36 = serve({ fetch: router36.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => httpServer36!.once('listening', resolve));
      const addr36 = httpServer36.address();
      const port36 = typeof addr36 === 'object' && addr36 ? addr36.port : 0;
      assert(port36 > 0, `Expected ephemeral port > 0 for Step 36, got ${port36}`);
      const baseUrl36 = `http://127.0.0.1:${port36}`;

      // Open a live HTTP SSE stream to verify real wire-level sync_state & chat_form_updated events
      const sseFrames36: Array<{ event: string; data: any }> = [];
      let sseWireBuffer = '';
      const sseStreamRes = await fetch(`${baseUrl36}/api/turns/stream`, { signal: sseAbort36.signal });
      assert(sseStreamRes.status === 200 && sseStreamRes.body, 'Failed to open live SSE stream in Step 36');
      const sseReader36 = sseStreamRes.body.getReader();
      const sseDecoder36 = new TextDecoder();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await sseReader36.read();
            if (done) break;
            sseWireBuffer += sseDecoder36.decode(value, { stream: true });
            const blocks = sseWireBuffer.split('\n\n');
            sseWireBuffer = blocks.pop() ?? '';
            for (const block of blocks) {
              const lines = block.split('\n');
              const evLine = lines.find((l) => l.startsWith('event:'));
              const dataLine = lines.find((l) => l.startsWith('data:'));
              if (!evLine || !dataLine) continue;
              const evName = evLine.slice('event:'.length).trim();
              try {
                sseFrames36.push({ event: evName, data: JSON.parse(dataLine.slice('data:'.length).trim()) });
              } catch {
                // Ignore non-JSON heartbeat/comment frames
              }
            }
          }
        } catch {
          // Stream closed via AbortController on teardown
        }
      })();
      await waitUntil36(() => sseFrames36.some((f) => f.event === 'sync_state'), 'initial sync_state SSE frame');

      // Turn 1: classify -> plan -> extract_roster -> attempt vn_translate_batches (MUST be blocked!) -> request_character_confirmation
      let extractedPayload36: any = null;
      let blockedTransResult36: any = null;
      let createdFormId36 = '';

      mainFaux36.setResponses([
        () => fauxAssistantMessage([fauxToolCall('vn_classify', { unpacked: '.papercup/tmp/unpacked', out: '.papercup/data/build' }, { id: 'tc-36-cls' })]),
        () => fauxAssistantMessage([fauxToolCall('vn_plan', { model: 'deepseek-chat', generateBatches: true }, { id: 'tc-36-plan' })]),
        () => fauxAssistantMessage([fauxToolCall('vn_extract_roster', {}, { id: 'tc-36-extract' })]),
        (ctx) => {
          const extRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-36-extract') as any;
          assert(extRes?.isError !== true, `vn_extract_roster failed: ${extRes?.content?.[0]?.text}`);
          extractedPayload36 = JSON.parse(String(extRes?.content?.[0]?.text || '{}'));
          // Intentionally attempt vn_translate_batches BEFORE character confirmation to verify deterministic gate
          return fauxAssistantMessage([
            fauxToolCall('vn_translate_batches', { concurrency: 1, checkpointInterval: 0 }, { id: 'tc-36-blocked-trans' }),
          ]);
        },
        (ctx) => {
          blockedTransResult36 = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-36-blocked-trans') as any;
          return fauxAssistantMessage([
            fauxToolCall(
              'vn_request_character_confirmation',
              {
                title: '出场角色译名确认',
                characters: [
                  { sourceName: 'エル', defaultTarget: '埃尔', gender: 'female', note: '元气少女' },
                  { sourceName: 'レイ', defaultTarget: '雷', gender: 'male' },
                ],
              },
              { id: 'tc-36-req-form' }
            ),
          ]);
        },
        (ctx) => {
          const formRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-36-req-form') as any;
          assert(
            formRes?.isError !== true &&
              formRes?.details?.status === 'awaiting_user_confirmation' &&
              formRes?.details?.chatFormKind === 'character_roster' &&
              typeof formRes?.details?.chatFormId === 'string',
            `Unexpected vn_request_character_confirmation result: ${JSON.stringify(formRes)}`
          );
          createdFormId36 = formRes.details.chatFormId;
          return fauxAssistantMessage('已发送角色译名确认表，请在下方表单核对并提交。');
        },
      ]);

      await svc36.executeTurn('请分类并提取出场角色译名确认表');

      // Assert extraction & pre-confirmation block
      assert(
        extractedPayload36?.status === 'unconfirmed' &&
          extractedPayload36?.totalCharacters === 2 &&
          extractedPayload36?.characters?.some(
            (c: any) => c.sourceName === 'エル' && c.speakerIds.includes('e') && c.occurrences === 3 && c.samples.length === 2
          ) &&
          extractedPayload36?.characters?.some(
            (c: any) => c.sourceName === 'レイ' && c.speakerIds.includes('r') && c.occurrences === 2 && c.samples.length === 1
          ),
        `Unexpected vn_extract_roster output: ${JSON.stringify(extractedPayload36)}`
      );
      assert(
        blockedTransResult36?.isError === true &&
          String(blockedTransResult36?.content?.[0]?.text || '').includes('角色译名尚未锁定'),
        `Expected vn_translate_batches to be blocked before confirmation, got: ${JSON.stringify(blockedTransResult36)}`
      );
      assert(createdFormId36.length > 0, 'Expected createdFormId36');

      // Verify live SSE received chat_form_updated (pending)
      await waitUntil36(
        () => sseFrames36.some((f) => f.event === 'chat_form_updated' && f.data?.formId === createdFormId36 && f.data?.status === 'pending'),
        'chat_form_updated pending SSE frame'
      );

      // Verify GET /api/vn/forms, GET /api/session/history, and fresh SSE sync_state
      const formsListRes = await (await fetch(`${baseUrl36}/api/vn/forms`)).json();
      assert(
        formsListRes.forms?.some((f: any) => f.formId === createdFormId36 && f.status === 'pending') &&
          formsListRes.roster?.status === 'draft',
        `Unexpected GET /api/vn/forms response: ${JSON.stringify(formsListRes)}`
      );

      const hist36 = await (await fetch(`${baseUrl36}/api/session/history`)).json();
      assert(
        Array.isArray(hist36.chatForms) &&
          hist36.chatForms.some((f: any) => f.formId === createdFormId36 && f.status === 'pending'),
        `Expected pending form in /api/session/history chatForms: ${JSON.stringify(hist36.chatForms)}`
      );
      const reqFormToolInHist = hist36.messages
        .flatMap((m: any) => m.tools ?? [])
        .find((t: any) => t.callId === 'tc-36-req-form');
      assert(
        reqFormToolInHist?.result?.details?.chatFormId === createdFormId36 &&
          reqFormToolInHist?.result?.details?.chatFormKind === 'character_roster',
        `Expected chatFormId & chatFormKind preserved in /api/session/history tool details: ${JSON.stringify(reqFormToolInHist)}`
      );

      // Verify reconnect sync_state contains chatForms
      const syncAbort36 = new AbortController();
      const syncSseRes = await fetch(`${baseUrl36}/api/turns/stream`, { signal: syncAbort36.signal });
      const syncChunk = await syncSseRes.body!.getReader().read();
      const syncText = new TextDecoder().decode(syncChunk.value);
      syncAbort36.abort();
      assert(
        syncText.includes('event: sync_state') && syncText.includes(createdFormId36) && syncText.includes('"chatForms"'),
        `Expected sync_state SSE to include chatForms with ${createdFormId36}, got: ${syncText.slice(0, 600)}`
      );

      // Verify POST /api/vn/forms/:formId/submit validation rejects malformed/blank/duplicate payloads (400) without mutating
      for (const badBody of [
        {},
        { items: 'not-an-array' },
        { items: [{ sourceName: '   ', targetName: '艾露' }] },
        { items: [{ sourceName: 'エル', targetName: '   ' }] },
        {
          items: [
            { sourceName: 'エル', targetName: '艾露' },
            { sourceName: 'エル', targetName: '埃尔' },
          ],
        },
      ]) {
        const badRes = await fetch(`${baseUrl36}/api/vn/forms/${encodeURIComponent(createdFormId36)}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(badBody),
        });
        assert(badRes.status === 400, `Expected 400 for invalid submit payload ${JSON.stringify(badBody)}, got ${badRes.status}`);
      }
      const traversalRes = await fetch(`${baseUrl36}/api/vn/forms/${encodeURIComponent('../evil')}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ sourceName: 'エル', targetName: '艾露' }] }),
      });
      assert(traversalRes.status === 404, `Expected 404 for unsafe formId traversal, got ${traversalRes.status}`);

      // Verify POST /api/vn/forms/:formId/submit with autoContinue=true returns 409 when busy WITHOUT mutating state!
      let notifyBusy36!: () => void;
      const busyStarted36 = new Promise<void>((r) => (notifyBusy36 = r));
      let releaseBusy36!: () => void;
      const busyGate36 = new Promise<void>((r) => (releaseBusy36 = r));
      mainFaux36.setResponses([
        async () => {
          notifyBusy36();
          await busyGate36;
          return fauxAssistantMessage('临时忙碌轮次结束。');
        },
      ]);
      const busyTurnPromise = svc36.executeTurn('占用当前轮次以测试 409');
      await busyStarted36;

      const busySubmitRes = await fetch(`${baseUrl36}/api/vn/forms/${encodeURIComponent(createdFormId36)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoContinue: true,
          items: [
            { sourceName: 'エル', targetName: '艾露' },
            { sourceName: 'レイ', targetName: '雷伊' },
          ],
        }),
      });
      assert(busySubmitRes.status === 409, `Expected 409 submitting with autoContinue=true while busy, got ${busySubmitRes.status}`);
      const afterBusyState = await (await fetch(`${baseUrl36}/api/vn/forms`)).json();
      assert(
        afterBusyState.forms.find((f: any) => f.formId === createdFormId36)?.status === 'pending' &&
          afterBusyState.roster?.status === 'draft',
        `Busy 409 submit MUST NOT mutate form or characters.json: ${JSON.stringify(afterBusyState)}`
      );
      releaseBusy36();
      await busyTurnPromise;

      // Now submit edited target names & aliases with autoContinue=true -> locks characters.json, emits SSE, wakes Agent!
      let wakeUpPromptSeen = '';
      let postSubmitTranslateRes: any = null;
      let postSubmitQaRes: any = null;

      mainFaux36.setResponses([
        (ctx) => {
          const lastUser = [...ctx.messages].reverse().find((m: any) => m.role === 'user') as any;
          wakeUpPromptSeen =
            typeof lastUser?.content === 'string'
              ? lastUser.content
              : Array.isArray(lastUser?.content)
                ? lastUser.content.map((p: any) => p?.text || '').join('\n')
                : '';
          return fauxAssistantMessage([
            fauxToolCall('vn_translate_batches', { concurrency: 1, checkpointInterval: 0 }, { id: 'tc-36-trans-ok' }),
          ]);
        },
        (ctx) => {
          postSubmitTranslateRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-36-trans-ok') as any;
          return fauxAssistantMessage([
            fauxToolCall('vn_post_qa_parallel', { batchMaxLines: 20, concurrency: 1 }, { id: 'tc-36-qa-ok' }),
          ]);
        },
        (ctx) => {
          postSubmitQaRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-36-qa-ok') as any;
          return fauxAssistantMessage('已按锁定角色译名完成翻译与审校。');
        },
      ]);

      const submitRes36 = await fetch(`${baseUrl36}/api/vn/forms/${encodeURIComponent(createdFormId36)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoContinue: true,
          items: [
            {
              sourceName: 'エル',
              targetName: '艾露',
              gender: 'female',
              aliases: [{ source: 'エルちゃん', target: '小艾露' }],
              note: '开朗少女',
            },
            {
              sourceName: 'レイ',
              targetName: '雷伊',
              gender: 'male',
            },
          ],
        }),
      });
      assert(submitRes36.status === 200, `Expected 200 submitting character form, got ${submitRes36.status}`);
      const submitBody36 = await submitRes36.json();
      assert(
        submitBody36.ok === true &&
          submitBody36.startedTurn === true &&
          submitBody36.editedCount === 2 &&
          submitBody36.glossaryEntriesAdded === 3 &&
          submitBody36.form?.status === 'submitted' &&
          submitBody36.roster?.status === 'locked' &&
          String(submitBody36.userPrompt || '').includes('エル → 艾露') &&
          String(submitBody36.userPrompt || '').includes('レイ → 雷伊'),
        `Unexpected submit response: ${JSON.stringify(submitBody36)}`
      );

      // Wait for auto-woken Agent turn to complete
      await waitUntil36(() => !svc36.isBusy() && postSubmitQaRes !== null, 'auto-continued turn completion');

      // Verify live SSE received chat_form_updated (submitted)
      await waitUntil36(
        () => sseFrames36.some((f) => f.event === 'chat_form_updated' && f.data?.formId === createdFormId36 && f.data?.status === 'submitted'),
        'chat_form_updated submitted SSE frame'
      );

      // Verify persisted locked .papercup/data/vn/characters.json
      const lockedDiskRoster = JSON.parse(fs.readFileSync(path.join(ws36, '.papercup', 'data', 'vn', 'characters.json'), 'utf8'));
      assert(
        lockedDiskRoster.status === 'locked' &&
          lockedDiskRoster.characters.find((c: any) => c.sourceName === 'エル')?.targetName === '艾露' &&
          lockedDiskRoster.characters.find((c: any) => c.sourceName === 'エル')?.aliases?.[0]?.target === '小艾露' &&
          lockedDiskRoster.characters.find((c: any) => c.sourceName === 'レイ')?.targetName === '雷伊',
        `Unexpected locked characters.json on disk: ${JSON.stringify(lockedDiskRoster)}`
      );

      // Verify cancelling an already submitted form returns 409 CONFLICT
      const cancelSubmittedRes = await fetch(`${baseUrl36}/api/vn/forms/${encodeURIComponent(createdFormId36)}/cancel`, {
        method: 'POST',
      });
      assert(cancelSubmittedRes.status === 409, `Expected 409 cancelling submitted form, got ${cancelSubmittedRes.status}`);

      // Verify wake-up message, translator & role-checker <character_roster> injection, and clean deterministic QA
      assert(
        wakeUpPromptSeen.includes('[角色译名表单已提交]') && wakeUpPromptSeen.includes('エル → 艾露'),
        `Expected Agent wake-up prompt to include locked character summary, got: ${wakeUpPromptSeen}`
      );
      assert(
        postSubmitTranslateRes?.isError !== true && postSubmitTranslateRes?.details?.ok === true,
        `Expected vn_translate_batches to succeed after confirmation, got: ${JSON.stringify(postSubmitTranslateRes)}`
      );
      assert(
        postSubmitQaRes?.isError !== true &&
          postSubmitQaRes?.details?.ok === true &&
          postSubmitQaRes?.details?.deterministicFailed === 0,
        `Expected vn_post_qa_parallel ok after confirmation, got: ${JSON.stringify(postSubmitQaRes)}`
      );

      const allTransPrompts = translatorPrompts36.join('\n---\n');
      assert(
        allTransPrompts.includes('<character_roster>') &&
          allTransPrompts.includes('エル => 艾露') &&
          allTransPrompts.includes('エルちゃん=>小艾露') &&
          allTransPrompts.includes('レイ => 雷伊'),
        `Cloud translator must receive locked <character_roster> with aliases, got:\n${allTransPrompts}`
      );

      const allRcPrompts = roleCheckerPrompts36.join('\n---\n');
      assert(
        allRcPrompts.includes('<character_roster>') &&
          allRcPrompts.includes('エル => 艾露') &&
          allRcPrompts.includes('レイ => 雷伊'),
        `role-checker must receive locked <character_roster>, got:\n${allRcPrompts}`
      );

      // Verify full-stack excludedNames + dismissedNames + 0-character submission via vn_request_character_confirmation & HTTP POST /submit
      let dismissedFormId36 = '';
      mainFaux36.setResponses([
        () =>
          fauxAssistantMessage([
            fauxToolCall(
              'vn_request_character_confirmation',
              {
                title: '排除非角色候选确认',
                characters: [{ sourceName: 'エル', defaultTarget: '艾露', gender: 'female' }],
                excludedNames: [{ sourceName: 'レイ', reason: '测试预排除项' }],
              },
              { id: 'tc-36-req-dismiss' }
            ),
          ]),
        (ctx) => {
          const fRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-36-req-dismiss') as any;
          assert(
            fRes?.isError !== true &&
              typeof fRes?.details?.chatFormId === 'string' &&
              fRes?.details?.chatForm?.excludedItems?.length === 1 &&
              fRes?.details?.chatForm?.excludedItems?.[0]?.sourceName === 'レイ',
            `Expected excludedItems in vn_request_character_confirmation result: ${JSON.stringify(fRes)}`
          );
          dismissedFormId36 = fRes.details.chatFormId;
          return fauxAssistantMessage('已发送含预排除项的确认表单。');
        },
      ]);
      await svc36.executeTurn('发送含预排除项的角色确认表单');
      assert(dismissedFormId36.length > 0, 'Expected dismissedFormId36');

      // Submit 0-character form dismissing all remaining candidates -> 200 OK, locked with dismissedNames, no glossary pollution
      const zeroSubmitRes36 = await fetch(`${baseUrl36}/api/vn/forms/${encodeURIComponent(dismissedFormId36)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoContinue: false,
          items: [],
          dismissedNames: ['エル', 'レイ'],
        }),
      });
      assert(zeroSubmitRes36.status === 200, `Expected 200 submitting 0-character dismissed form, got ${zeroSubmitRes36.status}`);
      const zeroSubmitBody36 = await zeroSubmitRes36.json();
      assert(
        zeroSubmitBody36.ok === true &&
          zeroSubmitBody36.roster?.status === 'locked' &&
          zeroSubmitBody36.roster?.characters?.length === 0 &&
          zeroSubmitBody36.glossaryEntriesAdded === 0 &&
          zeroSubmitBody36.roster?.dismissedNames?.includes('エル') &&
          zeroSubmitBody36.roster?.dismissedNames?.includes('レイ'),
        `Unexpected 0-character dismissed submit response: ${JSON.stringify(zeroSubmitBody36)}`
      );
      const diskAfterZero36 = JSON.parse(fs.readFileSync(path.join(ws36, '.papercup', 'data', 'vn', 'characters.json'), 'utf8'));
      assert(
        diskAfterZero36.status === 'locked' &&
          Array.isArray(diskAfterZero36.dismissedNames) &&
          diskAfterZero36.dismissedNames.includes('エル') &&
          diskAfterZero36.dismissedNames.includes('レイ'),
        `Expected persisted dismissedNames in characters.json: ${JSON.stringify(diskAfterZero36)}`
      );

      console.log('Step 36 passed (full E2E character roster extraction, HTTP/SSE form lifecycle, dismissedNames/0-char lock, 400/404/409 guards, autoContinue wake-up & locked <character_roster> injection).');
    } finally {
      sseAbort36.abort();
      if (httpServer36) {
        await new Promise<void>((resolve) => httpServer36!.close(() => resolve()));
      }
      (svc36 as any).disposeCurrentSessionState?.(true);
    }
  });

  // 37. Three-layer context compaction E2E integration:
  //     - Main session POST /api/session/compact (noop -> compacted), SSE compaction_start/compaction_end,
  //       breakdown.compaction usage, diagnostic checkpoint artifact, full history preservation + compaction divider
  //     - Queued post-turn /compact (202 queued + compaction_queued SSE + auto-compact on normal completion,
  //       and queue clearing on abort & on error)
  //     - Subagent compaction: translator auto-compaction disabled + 400, interactive reverser idle & running-queued
  //       compaction (compactionCount, contextUsage, divider in snapshot.messages, usage forwarding), offline 409 & missing 404
  //     - Custom provider discovered contextWindow propagation into registered model definitions
  await withIsolatedHomeAndEnv('papercup-compact-', async ({ ws: ws37 }) => {
    const savedKeepRecent = process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS;
    process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS = '1024';

    // Seed a research file so workspace anchor & research immutability are exercised on real disk
    const researchDemoDir = path.join(ws37, '.papercup', 'research', 'engine-demo');
    fs.mkdirSync(researchDemoDir, { recursive: true });
    fs.writeFileSync(path.join(researchDemoDir, '01-layout.md'), 'magic=DEMO header=0x20\n', 'utf8');

    const mainFaux37 = createFauxCore({ provider: 'faux-main-37', models: [{ id: 'main-37-1', reasoning: false }] });
    const svc37 = new AgentService(ws37, { sessionMode: 'memory' });
    let httpServer37: ReturnType<typeof serve> | null = null;
    const sseAbort37 = new AbortController();

    const waitUntil37 = async (cond: () => boolean, label: string, timeoutMs = 10000) => {
      const start = Date.now();
      while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    try {
      await (svc37 as any).initSession();
      const sess37 = (svc37 as any).currentSession;
      sess37.agent.state.model = mainFaux37.getModel();
      sess37.agent.streamFunction = mainFaux37.streamSimple;
      sess37._modelRuntime.hasConfiguredAuth = () => true;

      // Capture subagent settingsManager & inject faux streams for translator and reverser
      let translatorCompactionEnabledSeen: boolean | undefined;
      let reverserFaux37: ReturnType<typeof createFauxCore> | null = null;
      const subMgr37 = (svc37 as any).subagentManager as SubagentManager;
      const origCreateSub37 = subMgr37.createSubagentSession.bind(subMgr37);
      subMgr37.createSubagentSession = async (roleName, opts) => {
        const res = await origCreateSub37(roleName, opts);
        if (roleName === 'translator') {
          translatorCompactionEnabledSeen = (res.session as any).settingsManager?.getCompactionEnabled?.();
        }
        const subFaux = createFauxCore({
          provider: roleName === 'reverser' ? 'faux-main-37' : `faux-sub-37-${roleName}`,
          models: [{ id: roleName === 'reverser' ? 'main-37-1' : `sub-37-${roleName}`, reasoning: false }],
        });
        (res.session as any).agent.state.model = subFaux.getModel();
        (res.session as any).agent.streamFunction = subFaux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        if (roleName === 'translator') {
          subFaux.setResponses([fauxAssistantMessage('{"id":"1","target":"你好"}')]);
        } else if (roleName === 'reverser') {
          reverserFaux37 = subFaux;
          const longAnalysis = (tag: string) =>
            `${tag} 分析结论：` + '二进制偏移 0x0040 索引表结构与 XOR 密钥验证记录。'.repeat(320);
          subFaux.setResponses([
            () =>
              fauxAssistantMessage([
                fauxToolCall('read', { path: '.papercup/research/engine-demo/01-layout.md' }, { id: 'tc-rev-37-1' }),
              ]),
            () => fauxAssistantMessage(longAnalysis('Reverser-Step1')),
            () => fauxAssistantMessage('## Reverser Compaction Summary\n- Verified header offset 0x0040\n- Disproven XOR 0x55 hypothesis'),
          ]);
        }
        return res;
      };

      const router37 = createApiRouter(svc37);
      httpServer37 = serve({ fetch: router37.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => httpServer37!.once('listening', resolve));
      const addr37 = httpServer37.address();
      const port37 = typeof addr37 === 'object' && addr37 ? addr37.port : 0;
      assert(port37 > 0, `Expected ephemeral port > 0 for Step 37, got ${port37}`);
      const baseUrl37 = `http://127.0.0.1:${port37}`;

      // Open live SSE stream to observe compaction_start / compaction_end / compaction_queued frames
      const sseFrames37: Array<{ event: string; data: any }> = [];
      let sseBuf37 = '';
      const sseRes37 = await fetch(`${baseUrl37}/api/turns/stream`, { signal: sseAbort37.signal });
      assert(sseRes37.status === 200 && sseRes37.body, 'Failed to open live SSE stream in Step 37');
      const sseReader37 = sseRes37.body.getReader();
      const sseDecoder37 = new TextDecoder();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await sseReader37.read();
            if (done) break;
            sseBuf37 += sseDecoder37.decode(value, { stream: true });
            const blocks = sseBuf37.split('\n\n');
            sseBuf37 = blocks.pop() ?? '';
            for (const block of blocks) {
              const lines = block.split('\n');
              const evLine = lines.find((l) => l.startsWith('event:'));
              const dataLine = lines.find((l) => l.startsWith('data:'));
              if (!evLine || !dataLine) continue;
              const evName = evLine.slice('event:'.length).trim();
              try {
                sseFrames37.push({ event: evName, data: JSON.parse(dataLine.slice('data:'.length).trim()) });
              } catch {
                // Ignore non-JSON heartbeat frames
              }
            }
          }
        } catch {
          // Stream aborted during teardown
        }
      })();
      await waitUntil37(() => sseFrames37.some((f) => f.event === 'sync_state'), 'initial sync_state SSE frame');

      // --- Part A: Main session POST /api/session/compact (noop on empty, compacted on multi-turn) ---
      const emptyCompactRes = await fetch(`${baseUrl37}/api/session/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert(emptyCompactRes.status === 200, `Expected 200 for empty session compact, got ${emptyCompactRes.status}`);
      const emptyCompactJson = await emptyCompactRes.json();
      assert(
        emptyCompactJson.ok === true && emptyCompactJson.status === 'noop',
        `Expected noop on empty session, got: ${JSON.stringify(emptyCompactJson)}`
      );

      // Run 2 substantial turns (> keepRecentTokens=1024) so compaction produces a real summary
      const padText = (label: string) =>
        `${label}：` + '这是一段用于填充多轮对话上下文的中文测试内容，确保超过保留阈值。'.repeat(160);
      mainFaux37.setResponses([
        () => fauxAssistantMessage(padText('第一轮回复')),
        () => fauxAssistantMessage(padText('第二轮回复')),
        () => fauxAssistantMessage('## Main Compaction Summary\n- Stage: unpack verified\n- Locked roster: 艾露, 雷伊'),
      ]);
      await svc37.executeTurn(padText('第一轮提问'));
      await svc37.executeTurn(padText('第二轮提问'));

      const manualCompactRes = await fetch(`${baseUrl37}/api/session/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: '保留角色表与解包路径' }),
      });
      assert(manualCompactRes.status === 200, `Expected 200 for manual compaction, got ${manualCompactRes.status}`);
      const manualCompactJson = await manualCompactRes.json();
      assert(
        manualCompactJson.ok === true &&
          manualCompactJson.status === 'compacted' &&
          manualCompactJson.result?.reason === 'manual' &&
          manualCompactJson.result?.focus === '保留角色表与解包路径' &&
          typeof manualCompactJson.result?.id === 'string' &&
          manualCompactJson.result.summary.includes('Main Compaction Summary') &&
          manualCompactJson.result.summary.includes('## Workspace State Snapshot (Authoritative Disk Truth)') &&
          typeof manualCompactJson.result.checkpointPath === 'string' &&
          manualCompactJson.result.checkpointPath.startsWith('.papercup/tmp/diagnostics/compactions/'),
        `Unexpected manual compaction result: ${JSON.stringify(manualCompactJson)}`
      );

      // Verify compaction_start & compaction_end SSE events
      await waitUntil37(
        () =>
          sseFrames37.some((f) => f.event === 'compaction_start' && f.data?.reason === 'manual' && f.data?.phase === 'compacting') &&
          sseFrames37.some(
            (f) =>
              f.event === 'compaction_end' &&
              f.data?.status === 'compacted' &&
              f.data?.result?.id === manualCompactJson.result.id
          ),
        'main compaction_start and compaction_end SSE frames'
      );

      // Verify breakdown.compaction usage accounting & main contextUsage.triggerTokens exposure
      assert(
        (manualCompactJson.tokenUsage?.breakdown?.compaction?.totalTokens ?? 0) > 0 &&
          (manualCompactJson.tokenUsage?.breakdown?.compaction?.calls ?? 0) >= 1,
        `Expected non-zero breakdown.compaction usage, got: ${JSON.stringify(manualCompactJson.tokenUsage?.breakdown?.compaction)}`
      );
      const mainCtxUsage37 = manualCompactJson.tokenUsage?.contextUsage;
      assert(
        mainCtxUsage37 &&
          mainCtxUsage37.contextWindow > 0 &&
          mainCtxUsage37.triggerTokens === computeCompactionThresholds(mainCtxUsage37.contextWindow, 'main').triggerTokens,
        `Expected main tokenUsage.contextUsage.triggerTokens to match computeCompactionThresholds('main'), got: ${JSON.stringify(mainCtxUsage37)}`
      );
      const statusUsage37 = await (await fetch(`${baseUrl37}/api/turns/status`)).json();
      assert(
        statusUsage37.tokenUsage?.contextUsage?.triggerTokens === mainCtxUsage37.triggerTokens,
        `Expected /api/turns/status tokenUsage.contextUsage.triggerTokens=${mainCtxUsage37.triggerTokens}, got: ${JSON.stringify(statusUsage37.tokenUsage?.contextUsage)}`
      );

      // Verify diagnostic checkpoint written ONLY under .papercup/tmp/diagnostics/compactions/, never .papercup/research/
      const ckptAbs37 = path.join(ws37, manualCompactJson.result.checkpointPath);
      assert(fs.existsSync(ckptAbs37), `Expected checkpoint artifact on disk at ${ckptAbs37}`);
      assert(
        fs.readdirSync(researchDemoDir).length === 1 && fs.readdirSync(researchDemoDir)[0] === '01-layout.md',
        'Compaction checkpoint must NEVER write into .papercup/research/'
      );

      // Verify FULL pre-compaction message preservation + role:'compaction' divider in /api/session/history
      const histAfterManual = await (await fetch(`${baseUrl37}/api/session/history`)).json();
      assert(
        histAfterManual.isCompacting === false && histAfterManual.queuedCompaction === null,
        `Unexpected compaction state in history: ${JSON.stringify({ isCompacting: histAfterManual.isCompacting, queuedCompaction: histAfterManual.queuedCompaction })}`
      );
      const rolesAfterManual = histAfterManual.messages.map((m: any) => m.role);
      assert(
        rolesAfterManual.length === 5 &&
          rolesAfterManual[0] === 'user' &&
          rolesAfterManual[1] === 'assistant' &&
          rolesAfterManual[2] === 'user' &&
          rolesAfterManual[3] === 'assistant' &&
          rolesAfterManual[4] === 'compaction' &&
          histAfterManual.messages[0].content.includes('第一轮提问') &&
          histAfterManual.messages[1].content.includes('第一轮回复') &&
          histAfterManual.messages[2].content.includes('第二轮提问') &&
          histAfterManual.messages[3].content.includes('第二轮回复') &&
          histAfterManual.messages[4].id === manualCompactJson.result.id &&
          histAfterManual.messages[4].compaction?.reason === 'manual' &&
          histAfterManual.messages[4].compaction?.focus === '保留角色表与解包路径' &&
          histAfterManual.messages[4].compaction?.checkpointPath === manualCompactJson.result.checkpointPath,
        `Expected all pre-compaction messages preserved + compaction divider, got roles=${JSON.stringify(rolesAfterManual)} msgs=${JSON.stringify(histAfterManual.messages.map((m: any) => ({ id: m.id, role: m.role, compaction: m.compaction })))}`
      );

      // Defense-in-depth: POST /api/turns/start with '/compact' right after compaction returns 200 noop without starting a turn
      const slashStartRes = await fetch(`${baseUrl37}/api/turns/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '/compact' }),
      });
      assert(slashStartRes.status === 200, `Expected 200 for /compact via /api/turns/start, got ${slashStartRes.status}`);
      const slashStartJson = await slashStartRes.json();
      assert(slashStartJson.status === 'noop', `Expected noop for immediate repeat /compact, got ${JSON.stringify(slashStartJson)}`);

      // --- Part B: Queued post-turn /compact (202 queued -> auto-compacts after normal turn, cleared on abort & error) ---
      let notifyTurn3Started!: () => void;
      const turn3Started = new Promise<void>((r) => (notifyTurn3Started = r));
      let releaseTurn3!: () => void;
      const turn3Gate = new Promise<void>((r) => (releaseTurn3 = r));

      mainFaux37.setResponses([
        async () => {
          notifyTurn3Started();
          await turn3Gate;
          return fauxAssistantMessage(padText('第三轮回复'));
        },
        () => fauxAssistantMessage('## Queued Post-Turn Summary\n- Captured Turn 3 insights cleanly'),
      ]);

      const turn3Promise = svc37.executeTurn(padText('第三轮提问'));
      await turn3Started;

      const queuedRes = await fetch(`${baseUrl37}/api/session/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: '保留第三轮分析' }),
      });
      assert(queuedRes.status === 202, `Expected 202 when queueing /compact during running turn, got ${queuedRes.status}`);
      const queuedJson = await queuedRes.json();
      assert(
        queuedJson.ok === true && queuedJson.status === 'queued' && queuedJson.focus === '保留第三轮分析',
        `Unexpected queued compact response: ${JSON.stringify(queuedJson)}`
      );
      await waitUntil37(
        () => sseFrames37.some((f) => f.event === 'compaction_queued' && f.data?.queued === true && f.data?.focus === '保留第三轮分析'),
        'compaction_queued=true SSE frame'
      );
      const statusWhileQueued = await (await fetch(`${baseUrl37}/api/turns/status`)).json();
      assert(
        statusWhileQueued.queuedCompaction?.focus === '保留第三轮分析',
        `Expected queuedCompaction in /api/turns/status, got ${JSON.stringify(statusWhileQueued.queuedCompaction)}`
      );

      const compactEndsBeforeTurn3 = sseFrames37.filter((f) => f.event === 'compaction_end' && f.data?.status === 'compacted').length;
      releaseTurn3();
      await turn3Promise;

      await waitUntil37(
        () =>
          sseFrames37.filter((f) => f.event === 'compaction_end' && f.data?.status === 'compacted').length === compactEndsBeforeTurn3 + 1 &&
          sseFrames37.some((f) => f.event === 'compaction_queued' && f.data?.queued === false),
        'post-turn queued compaction completion'
      );
      const histAfterQueued = await (await fetch(`${baseUrl37}/api/session/history`)).json();
      const compactionDividersAfterTurn3 = histAfterQueued.messages.filter((m: any) => m.role === 'compaction');
      assert(
        compactionDividersAfterTurn3.length === 2 &&
          compactionDividersAfterTurn3[1].compaction?.focus === '保留第三轮分析' &&
          histAfterQueued.queuedCompaction === null,
        `Expected 2 compaction dividers & cleared queue after Turn 3, got: ${JSON.stringify(compactionDividersAfterTurn3)}`
      );

      // Verify queued compaction is CLEARED on abort (does NOT compact)
      let notifyAbortTurn!: () => void;
      const abortTurnStarted = new Promise<void>((r) => (notifyAbortTurn = r));
      mainFaux37.setResponses([
        async (_ctx, options) => {
          notifyAbortTurn();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve();
            options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return fauxAssistantMessage('', { stopReason: 'aborted' });
        },
      ]);
      const abortTurnPromise = svc37.executeTurn(padText('第四轮将被中止'));
      await abortTurnStarted;

      const queueBeforeAbort = await fetch(`${baseUrl37}/api/session/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: 'should-clear-on-abort' }),
      });
      assert(queueBeforeAbort.status === 202, `Expected 202 queueing compact before abort, got ${queueBeforeAbort.status}`);
      const queuedClearEventsBeforeAbort = sseFrames37.filter((f) => f.event === 'compaction_queued' && f.data?.queued === false).length;

      const abortHttpRes = await fetch(`${baseUrl37}/api/turns/abort`, { method: 'POST' });
      assert(abortHttpRes.status === 200, `Expected 200 aborting turn, got ${abortHttpRes.status}`);
      await abortTurnPromise;
      await waitUntil37(
        () => sseFrames37.filter((f) => f.event === 'compaction_queued' && f.data?.queued === false).length > queuedClearEventsBeforeAbort,
        'compaction_queued=false emitted on abort'
      );
      const histAfterAbort = await (await fetch(`${baseUrl37}/api/session/history`)).json();
      assert(
        histAfterAbort.queuedCompaction === null &&
          histAfterAbort.messages.filter((m: any) => m.role === 'compaction').length === 2,
        `Queued compaction must be cleared without compacting on abort, got count=${histAfterAbort.messages.filter((m: any) => m.role === 'compaction').length}`
      );

      // Verify queued compaction is CLEARED on turn error (does NOT compact)
      let notifyErrTurn!: () => void;
      const errTurnStarted = new Promise<void>((r) => (notifyErrTurn = r));
      let releaseErrTurn!: () => void;
      const errTurnGate = new Promise<void>((r) => (releaseErrTurn = r));
      mainFaux37.setResponses([
        async () => {
          notifyErrTurn();
          await errTurnGate;
          return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'HTTP 500 upstream gateway error' });
        },
      ]);
      const errTurnPromise = svc37.executeTurn(padText('第五轮将出错'));
      await errTurnStarted;

      const queueBeforeErr = await fetch(`${baseUrl37}/api/session/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: 'should-clear-on-error' }),
      });
      assert(queueBeforeErr.status === 202, `Expected 202 queueing compact before error, got ${queueBeforeErr.status}`);
      const queuedClearEventsBeforeErr = sseFrames37.filter((f) => f.event === 'compaction_queued' && f.data?.queued === false).length;
      releaseErrTurn();
      await errTurnPromise;
      await waitUntil37(
        () => sseFrames37.filter((f) => f.event === 'compaction_queued' && f.data?.queued === false).length > queuedClearEventsBeforeErr,
        'compaction_queued=false emitted on error'
      );
      const histAfterErr = await (await fetch(`${baseUrl37}/api/session/history`)).json();
      assert(
        histAfterErr.queuedCompaction === null &&
          histAfterErr.messages.filter((m: any) => m.role === 'compaction').length === 2,
        `Queued compaction must be cleared without compacting on error, got count=${histAfterErr.messages.filter((m: any) => m.role === 'compaction').length}`
      );

      // --- Part C: Subagent compaction (translator 400 + disabled; reverser idle & running-queued; offline 409; missing 404) ---
      const transRun = await subMgr37.runSubagentWithMetrics('translator', 'Translate line 1', {
        cwd: ws37,
        model: mainFaux37.getModel(),
        modelRuntime: sess37._modelRuntime,
        sessionId: (svc37 as any).sessionManager?.getSessionId?.() ?? null,
        recordDiagnostics: true,
      });
      assert(
        translatorCompactionEnabledSeen === false,
        `translator auto-compaction must be explicitly disabled, saw: ${String(translatorCompactionEnabledSeen)}`
      );
      const transSnap37 = await (await fetch(`${baseUrl37}/api/subagents/tasks/${encodeURIComponent(transRun.taskId)}`)).json();
      assert(
        transSnap37.contextUsage === null ||
          (transSnap37.contextUsage.triggerTokens === undefined && !('triggerTokens' in transSnap37.contextUsage)),
        `Expected translator snapshot contextUsage to omit triggerTokens, got: ${JSON.stringify(transSnap37.contextUsage)}`
      );
      const transCompactRes = await fetch(`${baseUrl37}/api/subagents/${encodeURIComponent(transRun.taskId)}/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert(transCompactRes.status === 400, `Expected 400 compacting translator subagent, got ${transCompactRes.status}`);

      // Interactive reverser task (kept hot in resumableSessions)
      const revRun = await subMgr37.runSubagentWithMetrics(
        'reverser',
        padText('请分析 DEMO.pak 文件头并验证偏移结构'),
        {
          cwd: ws37,
          model: mainFaux37.getModel(),
          modelRuntime: sess37._modelRuntime,
          sessionId: (svc37 as any).sessionManager?.getSessionId?.() ?? null,
          recordDiagnostics: true,
        }
      );
      assert(revRun.resumable === true, 'Reverser session should remain hot/resumable after clean completion');

      const compactionTokensBeforeSub = svc37.getSessionTokenUsage().breakdown.compaction.totalTokens;
      const revIdleCompactRes = await fetch(`${baseUrl37}/api/subagents/${encodeURIComponent(revRun.taskId)}/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: '保留二进制头偏移' }),
      });
      assert(revIdleCompactRes.status === 200, `Expected 200 for idle reverser compact, got ${revIdleCompactRes.status}`);
      const revIdleCompactJson = await revIdleCompactRes.json();
      assert(
        revIdleCompactJson.ok === true &&
          revIdleCompactJson.status === 'compacted' &&
          revIdleCompactJson.taskId === revRun.taskId &&
          revIdleCompactJson.result?.summary?.includes('Reverser Compaction Summary') &&
          revIdleCompactJson.result?.checkpointPath?.startsWith('.papercup/tmp/diagnostics/compactions/'),
        `Unexpected idle reverser compact response: ${JSON.stringify(revIdleCompactJson)}`
      );

      const revSnapAfterIdle = await (await fetch(`${baseUrl37}/api/subagents/tasks/${encodeURIComponent(revRun.taskId)}`)).json();
      const expectedRevTrigger37 = revSnapAfterIdle.contextUsage?.contextWindow
        ? computeCompactionThresholds(revSnapAfterIdle.contextUsage.contextWindow, 'reverser').triggerTokens
        : undefined;
      assert(
        revSnapAfterIdle.compactionCount === 1 &&
          revSnapAfterIdle.contextUsage &&
          revSnapAfterIdle.contextUsage.contextWindow > 0 &&
          revSnapAfterIdle.contextUsage.triggerTokens === expectedRevTrigger37 &&
          Array.isArray(revSnapAfterIdle.messages) &&
          revSnapAfterIdle.messages.some(
            (m: any) =>
              m.role === 'compaction' &&
              m.id === revIdleCompactJson.result.id &&
              m.compaction?.reason === 'manual' &&
              m.compaction?.focus === '保留二进制头偏移'
          ),
        `Expected updated compactionCount, contextUsage (with reverser triggerTokens=${String(expectedRevTrigger37)}) & compaction divider on reverser snapshot: ${JSON.stringify({ compactionCount: revSnapAfterIdle.compactionCount, contextUsage: revSnapAfterIdle.contextUsage, msgRoles: revSnapAfterIdle.messages?.map((m: any) => m.role) })}`
      );
      const compactionTokensAfterSub = svc37.getSessionTokenUsage().breakdown.compaction.totalTokens;
      assert(
        compactionTokensAfterSub > compactionTokensBeforeSub,
        `Expected subagent compaction usage forwarded into main breakdown.compaction (${compactionTokensBeforeSub} -> ${compactionTokensAfterSub})`
      );

      // Running-queued compaction on interactive reverser via direct subagent message
      assert(reverserFaux37 !== null, 'Expected reverser faux handle');
      let notifyRevRunning!: () => void;
      const revRunningStarted = new Promise<void>((r) => (notifyRevRunning = r));
      let releaseRevRunning!: () => void;
      const revRunningGate = new Promise<void>((r) => (releaseRevRunning = r));
      reverserFaux37!.setResponses([
        async () => {
          notifyRevRunning();
          await revRunningGate;
          return fauxAssistantMessage(padText('Reverser 第二轮直接对话回复'));
        },
        () => fauxAssistantMessage('## Reverser Queued Compaction Summary\n- Confirmed round-trip unpack/repack script'),
        () => fauxAssistantMessage('## Reverser Queued Split-Turn Context\n- Confirmed round-trip unpack/repack script'),
      ]);

      const directMsgRes = await fetch(`${baseUrl37}/api/subagents/tasks/${encodeURIComponent(revRun.taskId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: padText('继续验证第二轮逆向细节') }),
      });
      assert(directMsgRes.status === 202, `Expected 202 starting direct reverser turn, got ${directMsgRes.status}`);
      const directMsgJson = await directMsgRes.json();
      const revTask2Id = directMsgJson.taskId;
      await revRunningStarted;

      const revQueuedRes = await fetch(`${baseUrl37}/api/subagents/${encodeURIComponent(revTask2Id)}/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: '保留二轮逆向结论' }),
      });
      assert(revQueuedRes.status === 202, `Expected 202 queueing compact on running reverser, got ${revQueuedRes.status}`);
      const revQueuedJson = await revQueuedRes.json();
      assert(
        revQueuedJson.ok === true && revQueuedJson.status === 'queued' && revQueuedJson.focus === '保留二轮逆向结论',
        `Unexpected running reverser queued compact response: ${JSON.stringify(revQueuedJson)}`
      );
      const revSnapWhileQueued = await (await fetch(`${baseUrl37}/api/subagents/tasks/${encodeURIComponent(revTask2Id)}`)).json();
      assert(
        revSnapWhileQueued.queuedCompaction?.focus === '保留二轮逆向结论',
        `Expected queuedCompaction on running reverser snapshot: ${JSON.stringify(revSnapWhileQueued.queuedCompaction)}`
      );

      releaseRevRunning();
      await waitUntil37(() => !svc37.isBusy(), 'direct reverser turn + post-turn compaction completion');

      const revSnapAfterQueued = await (await fetch(`${baseUrl37}/api/subagents/tasks/${encodeURIComponent(revTask2Id)}`)).json();
      const revCompactionDividers = (revSnapAfterQueued.messages ?? []).filter((m: any) => m.role === 'compaction');
      assert(
        revSnapAfterQueued.status === 'completed' &&
          revSnapAfterQueued.compactionCount === 2 &&
          !revSnapAfterQueued.queuedCompaction &&
          revCompactionDividers.length >= 2 &&
          revCompactionDividers[revCompactionDividers.length - 1].compaction?.focus === '保留二轮逆向结论',
        `Expected reverser post-turn queued compaction to increment compactionCount to 2 & append divider: ${JSON.stringify({ status: revSnapAfterQueued.status, compactionCount: revSnapAfterQueued.compactionCount, queuedCompaction: revSnapAfterQueued.queuedCompaction, dividers: revCompactionDividers.length })}`
      );

      // Evict hot session -> offline subagent returns 409; missing subagent returns 404
      subMgr37.disposeResumableSessions(ws37);
      const offlineCompactRes = await fetch(`${baseUrl37}/api/subagents/${encodeURIComponent(revTask2Id)}/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert(offlineCompactRes.status === 409, `Expected 409 compacting offline subagent, got ${offlineCompactRes.status}`);

      const missingCompactRes = await fetch(`${baseUrl37}/api/subagents/nonexistent-subagent-37/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert(missingCompactRes.status === 404, `Expected 404 compacting missing subagent, got ${missingCompactRes.status}`);

      // --- Part D: Custom provider discovered contextWindow propagation into registered model definitions ---
      const mockModelsServer37 = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: [
                { id: 'custom-256k-chat', context_length: 262144 },
                { id: 'custom-64k-chat', max_model_len: 65536 },
                { id: 'custom-small-invalid', context_length: 1024 },
                { id: 'custom-default-ctx' },
              ],
            })
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => mockModelsServer37.listen(0, '127.0.0.1', resolve));
      const mockAddr37 = mockModelsServer37.address();
      const mockPort37 = typeof mockAddr37 === 'object' && mockAddr37 ? mockAddr37.port : 0;
      const mockBaseUrl37 = `http://127.0.0.1:${mockPort37}/v1`;
      try {
        await svc37.setProviderApiKey('magpie', '', undefined, { baseUrl: mockBaseUrl37 });
        const runtime37 = (svc37 as any).sharedModelRuntime;
        const reg256k = runtime37.getModel('magpie', 'custom-256k-chat');
        const reg64k = runtime37.getModel('magpie', 'custom-64k-chat');
        const regInvalid = runtime37.getModel('magpie', 'custom-small-invalid');
        const regDefault = runtime37.getModel('magpie', 'custom-default-ctx');
        assert(
          reg256k?.contextWindow === 262144 &&
            reg64k?.contextWindow === 65536 &&
            regInvalid?.contextWindow === 131072 &&
            regDefault?.contextWindow === 131072,
          `Expected discovered contextWindow propagated with 131072 fallback, got: ${JSON.stringify({
            m256: reg256k?.contextWindow,
            m64: reg64k?.contextWindow,
            mBad: regInvalid?.contextWindow,
            mDef: regDefault?.contextWindow,
          })}`
        );
      } finally {
        await new Promise<void>((resolve) => mockModelsServer37.close(() => resolve()));
      }

      console.log('Step 37 passed (main /compact noop+compacted+history preservation+checkpoint+SSE+usage, queued post-turn /compact+abort/error clearing, subagent translator 400 + reverser idle/queued/offline 409/missing 404, and custom provider contextWindow propagation).');
    } finally {
      if (savedKeepRecent === undefined) delete process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS;
      else process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS = savedKeepRecent;
      sseAbort37.abort();
      if (httpServer37) {
        await new Promise<void>((resolve) => httpServer37!.close(() => resolve()));
      }
      (svc37 as any).disposeCurrentSessionState?.(true);
    }
  });

  console.log('\n--- All Server Integration Tests Passed Successfully! ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
