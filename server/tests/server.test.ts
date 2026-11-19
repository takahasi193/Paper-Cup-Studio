import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { serve } from '@hono/node-server';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, getSystemMessageText } from '@earendil-works/pi-ai';
import { AgentService } from '../src/agent/agent-service.js';
import { createApiRouter } from '../src/api/routes.js';
import { SubagentManager } from '../src/subagents/subagent-manager.js';
import { createVnTools } from '../src/agent/vn-tools.js';
import { config } from '../src/config.js';
import { scanWorkspace, unpackPeZip } from '../src/vn/archives.js';
import { applyResults, classifyUnpacked } from '../src/vn/classify.js';
import { getVnStatus } from '../src/vn/core.js';
import { loadProfile } from '../src/vn/profile.js';
import { detectModelFamily } from '../src/vn/tokens.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function runTests() {
  console.log('--- Running Server Tests ---');
  const agentService = new AgentService(process.cwd(), { sessionMode: 'memory' });
  const app = createApiRouter(agentService);

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
  assert(Boolean(wsJson.active), 'Workspace check failed');

  // 3. エンジニアリング状態テスト
  const resEng = await app.request('/api/engineering/status');
  console.log('3. Engineering status code:', resEng.status);
  const engJson = await resEng.json();
  console.log('   Engineering result:', engJson);

  // 4. セッション初期化・Shellパスおよびワークフローツール検証テスト
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
    'vn_qa',
    'vn_apply',
    'vn_repack',
    'vn_accept',
    'vn_release',
    'vn_learn_skill',
    'vn_promote_skill',
    'delegate_task',
    'create_subagent',
  ]) {
    assert(activeTools.includes(requiredTool), `Required tool not active: ${requiredTool}`);
  }

  // 5. サブエージェント隔離初期化（systemPrompt getter エラー回避・ツール権限分離）検証
  console.log('5. Verifying SubagentManager session creation & tool isolation...');
  const subagentManager = new SubagentManager();
  subagentManager.setCustomToolsProvider(() => createVnTools(() => process.cwd()));

  const translatorSub = await subagentManager.createSubagentSession('translator', { cwd: process.cwd() });
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

  const checkerSub = await subagentManager.createSubagentSession('role-checker', { cwd: process.cwd() });
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

  const reverserSub = await subagentManager.createSubagentSession('reverser', { cwd: process.cwd() });
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
      loadedSkillNames.includes('reverse-engineer-anything'),
      `reverser should load bundled REA skill, got: ${loadedSkillNames.join(', ')}`
    );
  } finally {
    reverserSub.session.dispose?.();
  }

  // 6. 動的サブエージェント生成・異常終了・AbortSignal・VNツール契約検証
  console.log('6. Verifying create_subagent, delegate_task guards, and vn_* tool contracts...');
  const subTools = subagentManager.createTools(() => process.cwd());
  const delegateTool = subTools.find((t) => t.name === 'delegate_task')!;
  const createTool = subTools.find((t) => t.name === 'create_subagent')!;

  const createdRes = await (createTool.execute as any)('tc-create', {
    name: 'proofreader',
    description: 'Checks punctuation.',
    instructions: 'Check Chinese punctuation strictly.',
    allowedTools: ['read'],
  });
  assert(createdRes.details?.name === 'proofreader', 'create_subagent failed');

  const dynamicSub = await subagentManager.createSubagentSession('proofreader', { cwd: process.cwd() });
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

  const vnTools = createVnTools(() => process.cwd());
  const vnQaTool = vnTools.find((t) => t.name === 'vn_qa')!;
  const vnAcceptTool = vnTools.find((t) => t.name === 'vn_accept')!;

  const qaMissingRes = await (vnQaTool.execute as any)('tc-qa-empty', {});
  assert(qaMissingRes.isError === true, 'vn_qa without args should return isError=true');

  const qaMixedRes = await (vnQaTool.execute as any)('tc-qa-mixed', {
    pairs: 'results/scenario.jsonl',
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

  (agentService as any).isRunningTurn = true;
  try {
    const resBusy = await app.request('/api/turns/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test concurrent guard' }),
    });
    assert(resBusy.status === 409, `Expected 409 when busy, got ${resBusy.status}`);
  } finally {
    (agentService as any).isRunningTurn = false;
  }

  // 8. オフライン Faux モデルを使った主ループ + Subagent 委譲ループ完走テスト
  console.log('8. Verifying full offline Agent loop + delegate_task subagent loop completion...');
  const loopService = new AgentService(process.cwd(), { sessionMode: 'memory' });
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

  // 9. 実行中ターンの /api/turns/abort 割り込み終了テスト
  console.log('9. Verifying in-flight turn abort via POST /api/turns/abort...');
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
  const abortRes = await loopRouter.request('/api/turns/abort', { method: 'POST' });
  assert(abortRes.status === 200, `Expected 200 from abort endpoint, got ${abortRes.status}`);
  const abortBody = await abortRes.json();
  assert(abortBody.ok === true && abortBody.aborted === true, `Expected aborted=true, got ${JSON.stringify(abortBody)}`);

  await runningTurn;
  loopService.off('agent_event', onAbortEvent);

  const abortedFinish = abortEvents.find((e) => e.type === 'turn_finished');
  assert(abortedFinish?.data?.status === 'aborted', `Expected turn_finished aborted, got ${JSON.stringify(abortedFinish)}`);
  assert(!loopService.isBusy(), 'AgentService remained busy after abort');

  // 10. 未知エンジン封包 -> reverser 委譲 -> unpack/repack 作成 -> vn_learn_skill 検証封装 -> vn_unpack -> vn_classify -> vn_promote_skill 一気通貫テスト
  console.log('10. Verifying end-to-end unknown-engine learning + skill packaging loop...');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-srv-learn-'));
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;

  try {
    const tmpHome = path.join(tmpRoot, 'home');
    const tmpWs = path.join(tmpRoot, 'game');
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpWs, { recursive: true });
    process.env.USERPROFILE = tmpHome;
    process.env.HOME = tmpHome;

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
          fauxToolCall('vn_classify', { unpacked: 'unpacked/script', out: 'build' }, { id: 'tc-main-classify' }),
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
      capturedReverserSystem.includes('reverse-engineer-anything'),
      `Reverser system prompt should embed available REA skill metadata`
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
      fs.existsSync(path.join(tmpHome, '.papercup', 'skills', 'engine-yuris', 'unpack.py')),
      'Promoted global skill unpack.py was not created'
    );
    assert(
      fs.readFileSync(path.join(tmpWs, 'unpacked', 'script', 'scene.txt'), 'utf-8').includes('未知エンジンの台詞です'),
      'Extracted script content did not match'
    );
    assert(
      fs.existsSync(path.join(tmpWs, 'build', 'scenario.jsonl')),
      'vn_classify did not generate build/scenario.jsonl'
    );

    const engStatusRes = await learnRouter.request('/api/engineering/status');
    assert(engStatusRes.status === 200, `Expected 200 from engineering status, got ${engStatusRes.status}`);
    const engStatusBody = await engStatusRes.json();
    assert(
      Array.isArray(engStatusBody.skills) && engStatusBody.skills.includes('engine-yuris'),
      `Expected engine-yuris in engineering skills, got ${JSON.stringify(engStatusBody)}`
    );

    learnMainSession.dispose?.();
  } finally {
    if (prevUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = prevUserProfile;
    }
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('11. Verifying model listing and runtime model switching endpoints...');
  const modelService = new AgentService(process.cwd(), { sessionMode: 'memory' });
  const modelRouter = createApiRouter(modelService);
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
  modelSession.dispose?.();

  // Verify POST /api/models/key injects runtime key, refreshes models, emits SSE, shares runtime with subagents, and never leaks secrets
  const ISOLATED_KEY_ENV_VARS = [
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'XAI_API_KEY',
    'GROQ_API_KEY',
    'MOONSHOT_API_KEY',
    'MINIMAX_API_KEY',
    'MODELSCOPE_API_KEY',
    'ARK_API_KEY',
    'VOLCENGINE_API_KEY',
    'SILICONFLOW_API_KEY',
    'PI_OFFLINE',
    'USERPROFILE',
    'HOME',
  ] as const;
  const savedKeyEnv = new Map<string, string | undefined>(
    ISOLATED_KEY_ENV_VARS.map((name) => [name, process.env[name]])
  );
  const origGlobalFetch = globalThis.fetch;
  const keyTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-key-test-'));
  try {
    for (const name of ISOLATED_KEY_ENV_VARS) {
      delete process.env[name];
    }
    process.env.PI_OFFLINE = '1';
    process.env.USERPROFILE = keyTmpHome;
    process.env.HOME = keyTmpHome;

    const keyService = new AgentService(process.cwd(), { sessionMode: 'memory' });
    const keyRouter = createApiRouter(keyService);
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

    (keyService as any).isRunningTurn = true;
    try {
      const busyKeyRes = await keyRouter.request('/api/models/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', apiKey: 'AIza-faux-test-secret' }),
      });
      assert(busyKeyRes.status === 409, `Expected 409 on /api/models/key while busy, got ${busyKeyRes.status}`);
    } finally {
      (keyService as any).isRunningTurn = false;
    }

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

    // Verify subagents receive the shared ModelRuntime with runtime credentials via real delegate_task
    const fauxGoogleMain = createFauxCore({ tokensPerSecond: 10000 });
    const fauxGoogleSub = createFauxCore({ tokensPerSecond: 10000 });
    keySession.agent.streamFunction = fauxGoogleMain.streamSimple;
    fauxGoogleMain.setResponses([
      () =>
        fauxAssistantMessage([
          fauxToolCall(
            'delegate_task',
            { role: 'translator', task: '{"id":1,"source":"テスト"}' },
            { id: 'tc-key-sub' }
          ),
        ]),
      () => fauxAssistantMessage('done'),
    ]);
    fauxGoogleSub.setResponses([() => fauxAssistantMessage('{"id":1,"target":"测试"}')]);

    const keySubMgr = (keyService as any).subagentManager as SubagentManager;
    const origKeyCreateSub = keySubMgr.createSubagentSession.bind(keySubMgr);
    let subHasGoogleRuntimeAuth = false;
    let subSharesRuntime = false;
    keySubMgr.createSubagentSession = async (roleName, opts) => {
      const res = await origKeyCreateSub(roleName, opts);
      subSharesRuntime = (res.session as any)._modelRuntime === keySession.modelRuntime;
      subHasGoogleRuntimeAuth =
        (res.session as any)._modelRuntime?.getProviderAuthStatus?.('google')?.source === 'runtime';
      (res.session as any).agent.state.model = fauxGoogleSub.getModel();
      (res.session as any).agent.streamFunction = fauxGoogleSub.streamSimple;
      return res;
    };
    await keyService.executeTurn('test key subagent');
    assert(subSharesRuntime && subHasGoogleRuntimeAuth, 'Subagent did not inherit shared runtime API key');

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

    // Switch API key to ModelScope with a custom model ID and verify presets + custom model + zero previous models
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
        msKeyBody.models.some((m: any) => m.key === 'modelscope/Qwen/Qwen3.8-Flash-Next') &&
        msKeyBody.models.some((m: any) => m.key === 'modelscope/deepseek-ai/DeepSeek-V4.1-Flash') &&
        msKeyBody.models.some((m: any) => m.key === 'modelscope/Qwen/Qwen3-30B-A3B-Instruct-2507') &&
        !msKeyBody.models.some((m: any) => m.provider === 'anthropic' || m.provider === 'google'),
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

    // Switch API key to Volcengine Ark (火山方舟) with a custom endpoint ID (ep-*) and verify presets + compat + zero previous models
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
        arkKeyBody.models.some((m: any) => m.key === 'volcengine/doubao-seed-2-0-pro-260215') &&
        arkKeyBody.models.some((m: any) => m.key === 'volcengine/doubao-seed-1-6-flash-250828') &&
        arkKeyBody.models.some((m: any) => m.key === 'volcengine/deepseek-v3-2-251201') &&
        arkKeyBody.models.some((m: any) => m.key === 'volcengine/ep-20260101-test01') &&
        !arkKeyBody.models.some((m: any) => m.provider === 'modelscope' || m.provider === 'anthropic'),
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

    const arkSelectSeedRes = await keyRouter.request('/api/models/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'volcengine/doubao-seed-2-0-pro-260215' }),
    });
    assert(arkSelectSeedRes.status === 200, `Expected 200 selecting Volcengine Doubao Seed model, got ${arkSelectSeedRes.status}`);
    assert(
      keySession.model?.reasoning === true &&
        keySession.model?.compat?.thinkingFormat === 'deepseek' &&
        detectModelFamily('volcengine/doubao-seed-2-0-pro-260215') === 'doubao',
      `Unexpected Volcengine Doubao Seed compat/family: ${JSON.stringify(keySession.model)}`
    );

    const arkSelectR1Res = await keyRouter.request('/api/models/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'volcengine/deepseek-r1-250528' }),
    });
    assert(arkSelectR1Res.status === 200, `Expected 200 selecting Volcengine DeepSeek R1, got ${arkSelectR1Res.status}`);
    const arkSelectR1Body = await arkSelectR1Res.json();
    assert(
      keySession.model?.thinkingLevelMap?.off === null &&
        Array.isArray(arkSelectR1Body.availableThinkingLevels) &&
        !arkSelectR1Body.availableThinkingLevels.includes('off'),
      `Expected mandatory thinking for Volcengine DeepSeek R1, got ${JSON.stringify(arkSelectR1Body.availableThinkingLevels)}`
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

    // Switch API key to SiliconFlow (硅基流动) with live catalog sync + non-chat filtering + custom Pro/* model
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
              { id: 'doubao-seed-2-0-pro-260215', domain: 'LLM' },
              { id: 'doubao-seedream-5.0', domain: 'Text2Image' },
              { id: 'doubao-embedding-large-text-250515', domain: 'Embedding' },
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
        keySession.model?.compat?.thinkingFormat === 'qwen',
      `Unexpected SiliconFlow resolved model config: ${JSON.stringify(keySession.model)}`
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
      arkLiveBody.models.some((m: any) => m.key === 'volcengine/doubao-seed-2-0-pro-260215') &&
        !arkLiveBody.models.some((m: any) => m.id === 'doubao-seedream-5.0' || m.id === 'doubao-embedding-large-text-250515'),
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
    const envArkService = new AgentService(process.cwd(), { sessionMode: 'memory' });
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
    (envArkService as any).currentSession?.dispose?.();
    delete process.env.ARK_API_KEY;

    process.env.SILICONFLOW_API_KEY = 'sk-siliconflow-env-faux-secret';
    const envSfService = new AgentService(process.cwd(), { sessionMode: 'memory' });
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
    (envSfService as any).currentSession?.dispose?.();
    delete process.env.SILICONFLOW_API_KEY;

    keyService.off('agent_event', onKeyEvent);
    keySession.dispose?.();
  } finally {
    globalThis.fetch = origGlobalFetch;
    for (const [name, value] of savedKeyEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(keyTmpHome, { recursive: true, force: true });
  }

  console.log('12. Verifying disk session persistence, restart recovery, and session reset...');
  const persistRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-persist-test-'));
  const persistHome = path.join(persistRoot, 'home');
  const persistWs = path.join(persistRoot, 'ws');
  const pPrevUserProfile = process.env.USERPROFILE;
  const pPrevHome = process.env.HOME;

  try {
    fs.mkdirSync(persistHome, { recursive: true });
    fs.mkdirSync(persistWs, { recursive: true });
    process.env.USERPROFILE = persistHome;
    process.env.HOME = persistHome;

    // 1) Initial service instance runs turn 1 with vn_detect tool call under default sessionMode='persist'
    const s1 = new AgentService(persistWs);
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
    s1Sess.dispose?.();

    const projectsDir = path.join(persistHome, '.papercup', 'projects');
    assert(fs.existsSync(projectsDir), 'Expected ~/.papercup/projects directory for persisted sessions');
    assert(!fs.existsSync(path.join(persistWs, '.papercup', 'sessions')), 'Should not pollute workspace with sessions dir');

    // 2) Simulated restart: brand-new AgentService instance must restore conversation history & continue context
    const s2 = new AgentService(persistWs);
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

    // 3) Create Session B via POST /api/session/new and verify both sessions coexist in workspace
    const newBRes = await s2Router.request('/api/session/new', { method: 'POST' });
    assert(newBRes.status === 200, `Expected 200 from /api/session/new, got ${newBRes.status}`);
    const newBBody = await newBRes.json();
    const sessionBId: string = newBBody.sessionId;
    assert(
      newBBody.ok === true &&
        Boolean(sessionBId) &&
        sessionBId !== sessionAId &&
        Array.isArray(newBBody.messages) &&
        newBBody.messages.length === 0 &&
        Array.isArray(newBBody.sessions) &&
        newBBody.sessions.length === 2,
      `Expected Session B created alongside Session A, got ${JSON.stringify(newBBody)}`
    );

    const s2BFaux = createFauxCore({ tokensPerSecond: 10000 });
    const s2BSess = (s2 as any).currentSession;
    s2BSess.agent.state.model = s2BFaux.getModel();
    s2BSess.agent.streamFunction = s2BFaux.streamSimple;
    s2BSess._modelRuntime.hasConfiguredAuth = () => true;
    s2BFaux.setResponses([() => fauxAssistantMessage('会话 B 回复完成。')]);
    await s2.executeTurn('测试第二个会话');

    const sessionsListRes = await s2Router.request('/api/sessions');
    assert(sessionsListRes.status === 200, `Expected 200 from /api/sessions, got ${sessionsListRes.status}`);
    const sessionsListBody = await sessionsListRes.json();
    assert(
      sessionsListBody.sessions.some((s: any) => s.id === sessionAId && s.title.includes('先检测封包')) &&
        sessionsListBody.sessions.some((s: any) => s.id === sessionBId && s.title.includes('测试第二个会话')),
      `Expected both Session A and Session B titles in list, got ${JSON.stringify(sessionsListBody.sessions)}`
    );

    // Verify 404/409 guards on /api/sessions/select
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
    ((s2 as any).currentSession)?.dispose?.();

    const s3 = new AgentService(persistWs);
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
      delABody.sessionId === sessionBId &&
        delABody.sessions.length === 1 &&
        delABody.messages.some((m: any) => m.content.includes('会话 B 回复完成')),
      `Expected fallback to Session B after deleting Session A, got ${JSON.stringify(delABody)}`
    );

    const delBRes = await s3Router.request('/api/sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionBId }),
    });
    assert(delBRes.status === 200, `Expected 200 deleting Session B, got ${delBRes.status}`);
    const delBBody = await delBRes.json();
    assert(delBBody.messages.length === 0, 'Expected empty messages after deleting last session');
    ((s3 as any).currentSession)?.dispose?.();

    const s4 = new AgentService(persistWs);
    const s4Hist = await s4.getSessionHistory();
    assert(s4Hist.messages.length === 0, `Expected fresh session after all deleted, got ${JSON.stringify(s4Hist)}`);
    ((s4 as any).currentSession)?.dispose?.();
  } finally {
    if (pPrevUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = pPrevUserProfile;
    }
    if (pPrevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = pPrevHome;
    }
    fs.rmSync(persistRoot, { recursive: true, force: true });
  }

  // 13. 無ツールサブエージェントの偽 tool_call 拒否・メトリクス/診断ログ記録・Thinking レベル検証
  console.log('13. Verifying tool-less <tool_call> rejection, subagent diagnostics, and thinking controls...');
  const obsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-obs-test-'));
  const obsPrevProfile = process.env.USERPROFILE;
  const obsPrevHome = process.env.HOME;
  try {
    const obsHome = path.join(obsRoot, 'home');
    const obsWs = path.join(obsRoot, 'game');
    fs.mkdirSync(obsHome, { recursive: true });
    fs.mkdirSync(obsWs, { recursive: true });
    fs.writeFileSync(path.join(obsWs, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "third"\n', 'utf-8');
    fs.mkdirSync(path.join(obsHome, '.papercup'), { recursive: true });
    fs.writeFileSync(
      path.join(obsHome, '.papercup', 'config.toml'),
      'api_key = "sk-ant-top-secret-value-123456"\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(obsWs, '.env'), 'GEMINI_API_KEY=AIzaSySecretTestValue1234567890\n', 'utf-8');
    process.env.USERPROFILE = obsHome;
    process.env.HOME = obsHome;

    const obsService = new AgentService(obsWs, { sessionMode: 'persist' });
    const obsRouter = createApiRouter(obsService);
    await obsService.initSession();

    // Check thinking defaults and /api/models/thinking API
    const initModelsRes = await obsRouter.request('/api/models');
    const initModelsBody = await initModelsRes.json();
    assert(
      Array.isArray(initModelsBody.availableThinkingLevels) &&
        initModelsBody.availableThinkingLevels.includes(initModelsBody.thinkingLevel),
      `Expected valid thinkingLevel in availableThinkingLevels, got ${JSON.stringify(initModelsBody)}`
    );
    if (initModelsBody.availableThinkingLevels.includes('low')) {
      assert(initModelsBody.thinkingLevel === 'low', `Expected default main thinkingLevel 'low', got ${initModelsBody.thinkingLevel}`);
    }
    const badThinkRes = await obsRouter.request('/api/models/thinking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: 'invalid-level' }),
    });
    assert(badThinkRes.status === 400, `Expected 400 for invalid thinkingLevel, got ${badThinkRes.status}`);

    const setThinkRes = await obsRouter.request('/api/models/thinking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: 'off' }),
    });
    assert(setThinkRes.status === 200, `Expected 200 setting thinkingLevel, got ${setThinkRes.status}`);
    const setThinkBody = await setThinkRes.json();
    assert(setThinkBody.thinkingLevel === 'off', `Expected thinkingLevel 'off', got ${setThinkBody.thinkingLevel}`);

    // Verify subagent role thinking defaults
    const obsSubMgr = (obsService as any).subagentManager as SubagentManager;
    const tCheck = await obsSubMgr.createSubagentSession('translator', { cwd: obsWs });
    assert(tCheck.session.thinkingLevel === 'off', `Expected translator thinkingLevel 'off', got ${tCheck.session.thinkingLevel}`);
    tCheck.session.dispose?.();
    const rCheck = await obsSubMgr.createSubagentSession('role-checker', { cwd: obsWs });
    const rAvail: string[] = rCheck.session.getAvailableThinkingLevels?.() ?? ['off', 'low', 'medium', 'high'];
    const expectedRoleCheckerThinking = rAvail.includes('low') ? 'low' : rCheck.session.thinkingLevel;
    assert(
      rCheck.session.thinkingLevel === expectedRoleCheckerThinking && rAvail.includes(rCheck.session.thinkingLevel),
      `Expected role-checker thinkingLevel clamped inside ${JSON.stringify(rAvail)}, got ${rCheck.session.thinkingLevel}`
    );
    rCheck.session.dispose?.();

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
    obsSubFaux.setResponses([
      () => fauxAssistantMessage('<tool_call><function=functions.read>{"path":"work/batches/batch_001.jsonl"}</function></tool_call>'),
      () => fauxAssistantMessage('{"id":1,"target":"已翻译台词"}'),
    ]);

    obsMainFaux.setResponses([
      () => fauxAssistantMessage([fauxToolCall('read', { path: path.join(obsHome, '.papercup', 'config.toml') }, { id: 'tc-sec-global' })]),
      () => fauxAssistantMessage([fauxToolCall('read', { path: 'papercup.toml' }, { id: 'tc-sec-ws' })]),
      () => fauxAssistantMessage([fauxToolCall('bash', { command: 'cat ~/.papercup/config.toml' }, { id: 'tc-sec-bash' })]),
      () => fauxAssistantMessage([fauxToolCall('delegate_task', { role: 'translator', task: 'translate batch_001' }, { id: 'tc-sub-xml' })]),
      (ctx) => {
        const globalRead = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sec-global') as any;
        assert(globalRead?.isError === true, 'Reading ~/.papercup/config.toml must be blocked');
        const wsRead = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sec-ws') as any;
        assert(wsRead?.isError !== true, `Reading workspace papercup.toml must succeed, got: ${JSON.stringify(wsRead)}`);
        const bashBlocked = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-sec-bash') as any;
        assert(bashBlocked?.isError === true, 'Bash reading ~/.papercup/config.toml must be blocked');
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
        return fauxAssistantMessage('观测与安全测试完成。');
      },
    ]);

    await obsService.executeTurn('运行安全与观测检验');

    // Verify sanitized diagnostics JSONL was written without raw text or secrets
    const diagFile = path.join(obsWs, '.papercup', 'diagnostics', 'subagents.jsonl');
    assert(fs.existsSync(diagFile), 'Expected .papercup/diagnostics/subagents.jsonl to be written');
    const diagLines = fs.readFileSync(diagFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert(diagLines.length === 2, `Expected 2 subagent diagnostic entries, got ${diagLines.length}`);
    assert(diagLines[0].status === 'error' && diagLines[1].status === 'success', `Unexpected diag statuses: ${JSON.stringify(diagLines)}`);
    const diagText = fs.readFileSync(diagFile, 'utf-8');
    assert(!diagText.includes('已翻译台词') && !diagText.includes('sk-ant-top-secret'), 'Diagnostics log must not contain raw translations or secrets');

    // Verify persisted session file never contains secret string
    const sessionFile = (obsService as any).sessionManager.getSessionFile();
    if (sessionFile && fs.existsSync(sessionFile)) {
      const sessionContent = fs.readFileSync(sessionFile, 'utf-8');
      assert(!sessionContent.includes('sk-ant-top-secret-value-123456'), 'Persisted session must never contain secret');
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

    obsSession.dispose?.();
  } finally {
    if (obsPrevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = obsPrevProfile;
    if (obsPrevHome === undefined) delete process.env.HOME;
    else process.env.HOME = obsPrevHome;
    fs.rmSync(obsRoot, { recursive: true, force: true });
  }

  // 14. ランダム空きポート上の実 HTTP + SSE 同期＆実行中キャンセル検証（:3100 競合なし）
  console.log('14. Verifying ephemeral-port HTTP/SSE sync_state, refresh snapshot, and cascading abort...');
  const sseService = new AgentService(process.cwd(), { sessionMode: 'memory' });
  const sseRouter = createApiRouter(sseService);
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

  const httpServer = serve({ fetch: sseRouter.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  assert(port > 0, `Expected ephemeral port > 0, got ${port}`);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
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
    httpServer.close();
    sseSession.dispose?.();
  }

  console.log(
    '\n15. Verifying Phase 2 workflow: vn_plan -> vn_translate_batches (direct write + cap rotation) -> vn_post_qa_parallel -> vn_writeback (independent copy) -> vn_accept -> vn_release...'
  );
  const tmpP2Root = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-p2-'));
  const prevP2UserProfile = process.env.USERPROFILE;
  const prevP2Home = process.env.HOME;
  const tmpP2Home = path.join(tmpP2Root, 'home');
  const tmpP2Ws = path.join(tmpP2Root, 'game');
  const tmpP2Export = path.join(tmpP2Root, 'game.translated-test');
  fs.mkdirSync(tmpP2Home, { recursive: true });
  process.env.USERPROFILE = tmpP2Home;
  process.env.HOME = tmpP2Home;
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
    Buffer.concat([
      Buffer.from([
        storyBytes.length & 0xff,
        (storyBytes.length >> 8) & 0xff,
        (storyBytes.length >> 16) & 0xff,
        (storyBytes.length >> 24) & 0xff,
      ]),
    ]),
    storyBytes,
  ]);
  fs.writeFileSync(path.join(tmpP2Ws, 'script.ypf'), ypfP2);

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
  const subSessionCreates: Array<{ role: string }> = [];
  const translatorFirstPrompts: string[] = [];

  p2SubMgr.createSubagentSession = async (roleName, opts) => {
    subSessionCreates.push({ role: roleName });
    const res = await origP2CreateSub(roleName, opts);
    const subFaux = createFauxCore({ tokensPerSecond: 10000 });
    (res.session as any).agent.state.model = subFaux.getModel();
    (res.session as any).agent.streamFunction = subFaux.streamSimple;
    (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;

    if (roleName === 'translator') {
      const subSessionIdx = subSessionCreates.filter((s) => s.role === 'translator').length;
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
        if (subSessionIdx === 1 && turnInSub === 1) {
          return fauxAssistantMessage('<tool_call>write_out</tool_call>');
        }

        const batchMatch = promptText.match(/<batch\b[^>]*>\s*([\s\S]*?)\s*<\/batch>/i);
        const batchBody = batchMatch ? batchMatch[1] : promptText;
        const lines = batchBody
          .split(/\r?\n/)
          .filter((l: string) => l.trim().startsWith('{'))
          .map((l: string) => JSON.parse(l));
        const isForceFixCall = promptText.includes('batch_001') && turnInSub === 1 && subSessionIdx >= 4;
        const outJsonl = lines
          .map((row: any) => {
            if (String(row.id) === 'story.txt#1') return JSON.stringify({ id: row.id, target: '前辈，今天天气真好心情也特别愉快！' });
            if (String(row.id) === 'story.txt#2') {
              // Deliberately drop [p] on initial batch_001 pass so vn_post_qa_parallel catches it, then restore on force fix
              const hasFixHint = translatorFirstPrompts.filter((p) => p.includes('story.txt#2')).length > 1;
              return JSON.stringify({
                id: row.id,
                target: hasFixHint || isForceFixCall ? '那么我们一起去学校中庭边散步边聊吧。[p]' : '那么我们一起去学校中庭边散步边聊吧。',
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
    () => fauxAssistantMessage([fauxToolCall('vn_unpack', { engine: 'p2ypf', dest: 'unpacked' }, { id: 'tc-p2-unpack' })]),
    () => fauxAssistantMessage([fauxToolCall('vn_classify', { unpacked: 'unpacked', out: 'build', engine: 'p2ypf' }, { id: 'tc-p2-classify' })]),
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
          { archive: path.join(tmpP2Export, 'script.ypf'), track: 'scenario', input: 'results/scenario.jsonl' },
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
      return fauxAssistantMessage('全流程已完成（仅供个人学习）：共翻译 4 段，独立游戏副本已导出并验收发布。');
    },
  ]);

  try {
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

    // Verify original archive and workspace unpacked remain untouched while external copy has translated archive
    assert(fs.readFileSync(path.join(tmpP2Ws, 'script.ypf')).equals(ypfP2), 'Original script.ypf must remain byte-identical!');
    assert(fs.existsSync(path.join(tmpP2Export, 'script.ypf')), 'Independent copy script.ypf must exist');
    assert(fs.existsSync(path.join(tmpP2Export, 'Game.exe')), 'Independent copy Game.exe must exist');
    assert(!fs.existsSync(path.join(tmpP2Export, 'build')), 'Export copy must not leak build/ directory');
    assert(!fs.readFileSync(path.join(tmpP2Export, 'script.ypf')).equals(ypfP2), 'Exported script.ypf must reflect translations');
    assert(fs.existsSync(path.join(tmpP2Ws, 'work', 'out', 'batch_000.jsonl')), 'Batch outputs must be persisted directly on disk');
    assert(fs.existsSync(path.join(tmpP2Ws, '.papercup', 'vn', 'post_qa_report.json')), 'Post-QA report must exist');
    assert(fs.existsSync(path.join(tmpP2Ws, 'release', 'README.md')), 'Release notes release/README.md must exist');
    assert(fs.readFileSync(path.join(tmpP2Ws, 'release', 'README.md'), 'utf8').includes('仅供个人学习'), 'Release notes must include 仅供个人学习');

    // Verify main agent NEVER echoed raw translated JSONL lines in assistant messages
    const assistantTexts = histAfter.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
    assert(!assistantTexts.includes('前辈，今天天气真好心情也特别愉快'), 'Main agent must not regenerate/echo translated batch JSONL!');

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
    p2SessionDispose();
  }

  function p2SessionDispose() {
    (p2Service as any).currentSession?.dispose?.();
    if (prevP2UserProfile !== undefined) process.env.USERPROFILE = prevP2UserProfile;
    else delete process.env.USERPROFILE;
    if (prevP2Home !== undefined) process.env.HOME = prevP2Home;
    else delete process.env.HOME;
    fs.rmSync(tmpP2Root, { recursive: true, force: true });
  }

  // 16. 子 Agent 可观测性持久化、活动/进展分离、16KB 大输出转存、3次失败换路与主子中止一致性验证
  console.log('16. Verifying subagent observability persistence, activity/progress separation, 16KB spillover, 3-failure pivot, and abort consistency...');
  const obs2Root = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-obs2-test-'));
  const obs2PrevProfile = process.env.USERPROFILE;
  const obs2PrevHome = process.env.HOME;
  try {
    const obs2Home = path.join(obs2Root, 'home');
    const obs2Ws = path.join(obs2Root, 'game');
    fs.mkdirSync(obs2Home, { recursive: true });
    fs.mkdirSync(obs2Ws, { recursive: true });
    fs.writeFileSync(
      path.join(obs2Ws, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "third"\n\n[vn.research]\nmax_tool_output_chars = 16384\nmax_consecutive_failures = 3\n',
      'utf-8'
    );
    process.env.USERPROFILE = obs2Home;
    process.env.HOME = obs2Home;

    const obs2Service = new AgentService(obs2Ws, { sessionMode: 'persist' });
    const obs2Router = createApiRouter(obs2Service);
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
        assert(typeof bigRes?.details?.savedOutputPath === 'string' && bigRes.details.savedOutputPath.includes('.papercup/diagnostics/tool-outputs/'), `Expected savedOutputPath, got ${JSON.stringify(bigRes?.details)}`);
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
    const task1File = path.join(obs2Ws, '.papercup', 'diagnostics', 'subagent-tasks', `${task1Id}.json`);
    const eventsFile = path.join(obs2Ws, '.papercup', 'diagnostics', 'subagent-events.jsonl');
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

    obs2Session.dispose?.();
  } finally {
    if (obs2PrevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = obs2PrevProfile;
    if (obs2PrevHome === undefined) delete process.env.HOME;
    else process.env.HOME = obs2PrevHome;
    fs.rmSync(obs2Root, { recursive: true, force: true });
  }

  // 17. 并发 initSession 单飞锁与防重复 delta 广播验证（含工作区切换抢占场景）
  console.log('17. Verifying concurrent initSession single-flight deduplication and single delta streaming...');
  const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-init-race-'));
  const racePrevProfile = process.env.USERPROFILE;
  const racePrevHome = process.env.HOME;
  try {
    const raceHome = path.join(raceRoot, 'home');
    const raceWs1 = path.join(raceRoot, 'ws1');
    const raceWs2 = path.join(raceRoot, 'ws2');
    fs.mkdirSync(raceHome, { recursive: true });
    fs.mkdirSync(raceWs1, { recursive: true });
    fs.mkdirSync(raceWs2, { recursive: true });
    process.env.USERPROFILE = raceHome;
    process.env.HOME = raceHome;

    const raceService = new AgentService(raceWs1, { sessionMode: 'persist' });
    const raceRouter = createApiRouter(raceService);
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

    const expectedThinking = 'Tyrano engine detected, pe-zip. First inspect structure cleanly.';
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

    // Mid-flight workspace switch preemption followed by concurrent API initialization calls
    raceService.setWorkspace(raceWs2);
    const inFlightInit = raceService.initSession();
    await Promise.resolve();
    raceService.setWorkspace(raceWs2);
    await Promise.all([
      inFlightInit,
      raceRouter.request('/api/session/history'),
      raceRouter.request('/api/models'),
    ]);
    const raceSession2 = (raceService as any).currentSession;
    assert(
      raceSession2 && raceSession2._eventListeners?.length === 1,
      `Expected exactly 1 listener after mid-flight preemption & concurrent re-init, got ${raceSession2?._eventListeners?.length}`
    );
    assert(
      path.resolve((raceService as any).getWorkspace()) === path.resolve(raceWs2),
      `Expected active workspace to stay ws2 (${raceWs2}), got ${(raceService as any).getWorkspace()}`
    );

    (raceService as any).disposeCurrentSessionState?.(true);
  } finally {
    if (racePrevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = racePrevProfile;
    if (racePrevHome === undefined) delete process.env.HOME;
    else process.env.HOME = racePrevHome;
    fs.rmSync(raceRoot, { recursive: true, force: true });
  }

  // 18. 持久化工作区重启恢复、/api/workspaces 与 /api/session/history 一致性及无效目录清理验证
  console.log('18. Verifying persisted active workspace restore & /api/workspaces consistency...');
  const wsTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-ws-restore-'));
  const wsPrevProfile = process.env.USERPROFILE;
  const wsPrevHome = process.env.HOME;
  try {
    const wsHome = path.join(wsTestRoot, 'home');
    const wsA = path.join(wsTestRoot, 'wsA');
    const wsB = path.join(wsTestRoot, 'ゲーム_日本語_wsB');
    const wsDead = path.join(wsTestRoot, 'deleted_ws');
    fs.mkdirSync(wsHome, { recursive: true });
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    process.env.USERPROFILE = wsHome;
    process.env.HOME = wsHome;

    // 1) Initial service on wsA -> switch to wsB -> run a turn so wsB has a persisted session
    const wsSvc1 = new AgentService(wsA, { sessionMode: 'persist' });
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

    // 2) Inject a nonexistent dead active path into workspaces.json to simulate stale test/deleted folder recovery
    const regFile = path.join(wsHome, '.papercup', 'workspaces.json');
    const savedReg = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
    fs.writeFileSync(
      regFile,
      JSON.stringify({ active: wsDead, recent: [wsDead, ...savedReg.recent] }, null, 2),
      'utf-8'
    );

    // 3) Restart with AgentService() (no initialWorkspace, matching src/index.ts): must restore wsB & its session
    const wsSvc2 = new AgentService(undefined, { sessionMode: 'persist' });
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
    const memSvc = new AgentService(wsA, { sessionMode: 'memory' });
    const memRouter = createApiRouter(memSvc);
    const memWsJson = await (await memRouter.request('/api/workspaces')).json();
    const memHistJson = await (await memRouter.request('/api/session/history')).json();
    assert(path.resolve(memWsJson.active) === path.resolve(wsA), `Expected memory active=${wsA}, got ${memWsJson.active}`);
    assert(path.resolve(memHistJson.workspace) === path.resolve(wsA), `Expected memory history.workspace=${wsA}, got ${memHistJson.workspace}`);
    const regAfterMem = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
    assert(path.resolve(regAfterMem.active) === path.resolve(wsB), `Memory service must not overwrite workspaces.json active (${regAfterMem.active})`);

    (wsSvc2 as any).disposeCurrentSessionState?.(true);
    (memSvc as any).disposeCurrentSessionState?.(true);
  } finally {
    if (wsPrevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = wsPrevProfile;
    if (wsPrevHome === undefined) delete process.env.HOME;
    else process.env.HOME = wsPrevHome;
    fs.rmSync(wsTestRoot, { recursive: true, force: true });
  }

  // 19. 引擎级系统文本（TyranoScript / Kirikiri / Ren'Py）全管线分类、翻译、安全写回与重封包验证
  console.log('\n19. Verifying engine-level system text extraction, writeback, and PE+ZIP repack pipeline...');
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

  const sysRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-sys-text-'));
  const prevSysProfile = process.env.USERPROFILE;
  const prevSysHome = process.env.HOME;
  const sysHome = path.join(sysRoot, 'home');
  const sysWs = path.join(sysRoot, 'tyrano_game');
  const sysExport = path.join(sysRoot, 'tyrano_game.translated');
  const sysVerifyDir = path.join(sysRoot, 'verify_repacked');
  fs.mkdirSync(sysHome, { recursive: true });
  fs.mkdirSync(sysWs, { recursive: true });
  process.env.USERPROFILE = sysHome;
  process.env.HOME = sysHome;

  const tyranoService = new AgentService(sysWs, { sessionMode: 'memory' });
  try {
    fs.writeFileSync(
      path.join(sysWs, 'papercup.toml'),
      ['[vn.localization]', 'narrative_pov = "first"', 'source_lang = "ja"', 'target_lang = "zh"', ''].join('\n'),
      'utf8'
    );

    const peZipExe = buildTestPeZip([
      [
        'index.html',
        Buffer.from('<!DOCTYPE html><html><head><title>テスト学園</title></head><body></body></html>\n', 'utf8'),
      ],
      ['tyrano/tyrano.js', Buffer.from('var TYRANO = {};\n', 'utf8')],
      [
        'tyrano/lang.js',
        Buffer.from(
          'window.tyrano_lang = {word: {"go_title": "タイトルに戻ります。よろしいですか？", "not_saved": "まだ、保存されているデータがありません", "err_short": "エラーが発生しました", "err_long": "エラーが発生しました。スクリプトを確認して下さい", "newline_msg": "行1\\n行2"}, novel: {"file_menu_button_save": "menu_button_save.gif"}};\n',
          'utf8'
        ),
      ],
      [
        'tyrano/libs.js',
        Buffer.from(
          [
            '/* $.alert("コメント内は無視"); */',
            'var quoteRe = /[\'"]/; alert("セーブできませんでした"); $.confirm("上書きしますか？", okFn, cancelFn);',
            'alert("[camera] デバッグ用");',
            '',
          ].join('\n'),
          'utf8'
        ),
      ],
      [
        'tyrano/html/menu.html',
        Buffer.from(
          [
            '<div class="menu_close" title="メニューを閉じる">閉じる</div>',
            '<div>データ {{:num}} 保存済み</div>',
            '<input type="button" value="戻る">',
            '<script>var x = "<div>スクリプト内は無視</div>";</script>',
            '<img src="tyrano/images/kag/menu_button_save.gif">',
            '',
          ].join('\n'),
          'utf8'
        ),
      ],
      ['tyrano/images/kag/menu_button_save.gif', Buffer.from('GIF89a', 'ascii')],
      [
        'data/system/Config.tjs',
        Buffer.from('//;System.title=コメントアウト\n;System.title=テスト学園の物語\n', 'utf8'),
      ],
      [
        'data/scenario/system/builder.ks',
        Buffer.from('[macro name="tb_ptext_show"]\n[ptext text="%text" name="chara_name_area"]\n[endmacro]\n', 'utf8'),
      ],
      [
        'data/scenario/title_screen.ks',
        Buffer.from(
          [
            '*start',
            '[ptext layer="0" text="タイトルメニュー" name="あゆめ"]',
            '[tb_ptext_show text="第1章" layer="0"]',
            '[glink text="はい" target="*はい"]',
            '#主人公',
            'おはようございます！[p]',
            '',
          ].join('\n'),
          'utf8'
        ),
      ],
    ]);
    const exePath = path.join(sysWs, 'MenheraTest.exe');
    fs.writeFileSync(exePath, peZipExe);

    await tyranoService.initSession();
    const tSess = (tyranoService as any).currentSession;
    const tFaux = createFauxCore({ tokensPerSecond: 10000 });
    tSess.agent.state.model = tFaux.getModel();
    tSess.agent.streamFunction = tFaux.streamSimple;
    tSess._modelRuntime.hasConfiguredAuth = () => true;

    const tyranoSubMgr = (tyranoService as any).subagentManager as SubagentManager;
    const origTyranoCreate = tyranoSubMgr.createSubagentSession.bind(tyranoSubMgr);
    tyranoSubMgr.createSubagentSession = async (roleName, opts) => {
      const res = await origTyranoCreate(roleName, opts);
      const subFaux = createFauxCore({ tokensPerSecond: 10000 });
      (res.session as any).agent.state.model = subFaux.getModel();
      (res.session as any).agent.streamFunction = subFaux.streamSimple;
      (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
      if (roleName === 'reverser') {
        const tyranoResearchDir = path.join(sysWs, '.papercup', 'research', 'tyrano');
        const tyranoTmpDir = path.join(sysWs, '.papercup', 'tmp', 'tyrano');
        fs.mkdirSync(tyranoResearchDir, { recursive: true });
        fs.mkdirSync(tyranoTmpDir, { recursive: true });
        fs.writeFileSync(
          path.join(tyranoResearchDir, '03-text-mapping.json'),
          JSON.stringify(
            {
              engine: 'tyrano',
              scenario_scripts: ['data/scenario/*.ks'],
              system_text: ['tyrano/lang.js (word)', 'tyrano/libs.js (alert/confirm)', 'tyrano/html/*.html', 'index.html', 'data/system/Config.tjs'],
              raster_ui: ['tyrano/images/kag/menu_button_save.gif'],
            },
            null,
            2
          ),
          'utf8'
        );

        const tyranoExtractPy = [
          'import json, re, sys',
          'from pathlib import Path',
          'root, out_path = Path(sys.argv[1]), Path(sys.argv[2])',
          'rows = []',
          'lang_f = root / "tyrano" / "lang.js"',
          'if lang_f.is_file():',
          '    txt = lang_f.read_text(encoding="utf-8-sig")',
          '    wm = re.search(r"word\\s*:\\s*\\{(.*?)\\}", txt, re.S)',
          '    if wm:',
          '        for km in re.finditer(r\'"([^"]+)"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"\', wm.group(1)):',
          '            k, v = km.group(1), km.group(2)',
          '            rows.append({"id": f"tyrano/lang.js#1:word:{k}", "file": "tyrano/lang.js", "line": 1, "scene": "", "speaker": "", "kind": "system", "source": v, "tyrano_op": {"kind": "lang_word", "key": k}})',
          'libs_f = root / "tyrano" / "libs.js"',
          'if libs_f.is_file():',
          '    txt = libs_f.read_text(encoding="utf-8-sig")',
          '    for lno, line in enumerate(txt.splitlines(), 1):',
          '        if line.strip().startswith("/*"):',
          '            continue',
          '        for idx, cm in enumerate(re.finditer(r\'(?:alert|\\$\\.confirm)\\("((?:\\\\.|[^"\\\\])*)"\', line)):',
          '            val = cm.group(1)',
          '            if val.startswith("["):',
          '                continue',
          '            rows.append({"id": f"tyrano/libs.js#{lno}:call#{idx}", "file": "tyrano/libs.js", "line": lno, "scene": "", "speaker": "", "kind": "system", "source": val, "tyrano_op": {"kind": "js_call", "occ": idx}})',
          'idx_f = root / "index.html"',
          'if idx_f.is_file():',
          '    for lno, line in enumerate(idx_f.read_text(encoding="utf-8-sig").splitlines(), 1):',
          '        tm = re.search(r"<title>(.*?)</title>", line)',
          '        if tm and tm.group(1).strip():',
          '            rows.append({"id": f"index.html#{lno}:title", "file": "index.html", "line": lno, "scene": "", "speaker": "", "kind": "system", "source": tm.group(1).strip(), "tyrano_op": {"kind": "html_title"}})',
          'menu_f = root / "tyrano" / "html" / "menu.html"',
          'if menu_f.is_file():',
          '    for lno, line in enumerate(menu_f.read_text(encoding="utf-8-sig").splitlines(), 1):',
          '        if "<script>" in line or "<img " in line:',
          '            continue',
          '        am = re.search(r\'title="([^"]+)"\', line)',
          '        if am:',
          '            rows.append({"id": f"tyrano/html/menu.html#{lno}:title", "file": "tyrano/html/menu.html", "line": lno, "scene": "", "speaker": "", "kind": "system", "source": am.group(1), "tyrano_op": {"kind": "attr", "attr": "title"}})',
          '        bm = re.search(r\'value="([^"]+)"\', line)',
          '        if bm:',
          '            rows.append({"id": f"tyrano/html/menu.html#{lno}:val", "file": "tyrano/html/menu.html", "line": lno, "scene": "", "speaker": "", "kind": "system", "source": bm.group(1), "tyrano_op": {"kind": "attr", "attr": "value"}})',
          '        dm = re.search(r">([^<]+)<", line)',
          '        if dm and dm.group(1).strip():',
          '            raw = dm.group(1).strip()',
          '            if "{{:num}}" in raw:',
          '                parts = [p.strip() for p in re.split(r"\\{\\{[^}]+\\}\\}", raw) if p.strip()]',
          '                for pi, p in enumerate(parts):',
          '                    rows.append({"id": f"tyrano/html/menu.html#{lno}:seg#{pi}", "file": "tyrano/html/menu.html", "line": lno, "scene": "", "speaker": "", "kind": "system", "source": p, "tyrano_op": {"kind": "plain_sub"}})',
          '            else:',
          '                rows.append({"id": f"tyrano/html/menu.html#{lno}:text", "file": "tyrano/html/menu.html", "line": lno, "scene": "", "speaker": "", "kind": "system", "source": raw, "tyrano_op": {"kind": "plain_sub"}})',
          'cfg_f = root / "data" / "system" / "Config.tjs"',
          'if cfg_f.is_file():',
          '    for lno, line in enumerate(cfg_f.read_text(encoding="utf-8-sig").splitlines(), 1):',
          '        if line.lstrip().startswith("//"):',
          '            continue',
          '        cm = re.match(r"^(\\s*;?System\\.title\\s*=\\s*)(.+)$", line)',
          '        if cm:',
          '            rows.append({"id": f"data/system/Config.tjs#{lno}:title", "file": "data/system/Config.tjs", "line": lno, "scene": "", "speaker": "", "kind": "system", "source": cm.group(2).strip(), "tyrano_op": {"kind": "cfg_title"}})',
          'out_path.write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", encoding="utf-8")',
          '',
        ].join('\n');

        const tyranoApplyPy = [
          'import json, re, sys',
          'from pathlib import Path',
          'res_path, root = Path(sys.argv[1]), Path(sys.argv[2])',
          'rows_by_file = {}',
          'for raw in res_path.read_text(encoding="utf-8-sig").splitlines():',
          '    if not raw.strip(): continue',
          '    obj = json.loads(raw)',
          '    rows_by_file.setdefault(obj["file"], []).append(obj)',
          'def esc_js(s):',
          '    out = []',
          '    i = 0',
          '    while i < len(s):',
          '        if s[i] == "\\\\" and i + 1 < len(s):',
          '            out.append(s[i:i+2]); i += 2; continue',
          '        if s[i] == \'"\': out.append(\'\\\\"\')',
          '        else: out.append(s[i])',
          '        i += 1',
          '    return "".join(out)',
          'for rel, items in rows_by_file.items():',
          '    fpath = root / rel',
          '    txt = fpath.read_text(encoding="utf-8-sig")',
          '    lines = txt.splitlines(keepends=True)',
          '    for item in items:',
          '        src, tgt, op = item["source"], item["target"], item.get("tyrano_op") or {}',
          '        kind = op.get("kind")',
          '        ln = int(item["line"]) - 1',
          '        if kind == "lang_word":',
          '            key = op["key"]',
          '            pat = re.compile(r\'"\' + re.escape(key) + r\'"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"\')',
          '            lines[ln] = pat.sub(lambda m: m.group(0)[:-len(m.group(1))-1] + esc_js(tgt) + \'"\', lines[ln], count=1)',
          '        elif kind == "js_call":',
          '            occ = int(op["occ"])',
          '            cnt = [-1]',
          '            def repl_call(m):',
          '                cnt[0] += 1',
          '                if cnt[0] == occ:',
          '                    return m.group(1) + esc_js(tgt) + \'"\'',
          '                return m.group(0)',
          '            lines[ln] = re.sub(r\'((?:alert|\\$\\.confirm)\\(")((?:\\\\.|[^"\\\\])*)"\', repl_call, lines[ln])',
          '        elif kind == "attr":',
          '            a = op["attr"]',
          '            lines[ln] = re.sub(a + r\'="\' + re.escape(src) + r\'"\', lambda m: f\'{a}="{tgt}"\', lines[ln], count=1)',
          '        elif kind == "cfg_title":',
          '            lines[ln] = re.sub(r"(=\\s*)" + re.escape(src), lambda m: m.group(1) + tgt, lines[ln], count=1)',
          '        elif rel.endswith(".ks") and "target=" in lines[ln] and "text=" in lines[ln]:',
          '            lines[ln] = lines[ln].replace(f\'text="{src}"\', f\'text="{tgt}"\', 1)',
          '        else:',
          '            lines[ln] = lines[ln].replace(src, tgt, 1)',
          '    fpath.write_text("".join(lines), encoding="utf-8", newline="")',
          '',
        ].join('\n');

        fs.writeFileSync(path.join(tyranoTmpDir, 'extract.py'), tyranoExtractPy, 'utf8');
        fs.writeFileSync(path.join(tyranoTmpDir, 'apply.py'), tyranoApplyPy, 'utf8');

        subFaux.setResponses([
          (ctx) => {
            const sysMsg = ctx.messages.find((m: any) => m.role === 'system');
            const revPrompt = sysMsg ? getSystemMessageText(sysMsg) : String((res.session as any).agent.state.systemPrompt || '');
            assert(
              revPrompt.includes('extract.py') &&
                revPrompt.includes('03-text-mapping.json') &&
                revPrompt.includes('raster') &&
                revPrompt.includes('Config.tjs') &&
                revPrompt.includes('unpackedDir'),
              `reverser prompt must instruct engine-level system-text/UI audit & post-unpack skill packaging, got: ${revPrompt.slice(0, 400)}`
            );
            return fauxAssistantMessage([
              fauxToolCall(
                'vn_learn_skill',
                {
                  engine: 'tyrano',
                  unpackedDir: 'unpacked',
                  extractScript: '.papercup/tmp/tyrano/extract.py',
                  applyScript: '.papercup/tmp/tyrano/apply.py',
                  classifyProfile: 'kag',
                  classifyExtensions: ['.ks'],
                  classifyTags: { ptext: 'system', mtext: 'system', tb_ptext_show: 'system', title: 'system' },
                  systemTextFiles: [
                    'tyrano/lang.js (word)',
                    'tyrano/libs.js (alert/confirm)',
                    'tyrano/html/*.html',
                    'index.html (<title>)',
                    'data/system/Config.tjs (;System.title)',
                  ],
                  rasterUiAssets: ['tyrano/images/kag/menu_button_save.gif'],
                  encoding: 'utf-8',
                  note: 'TyranoScript word dict separates UI prompts from novel image filenames; Config.tjs leading semicolon is active syntax; preserve {{:num}} and glink targets.',
                  requireWriteback: true,
                },
                { id: 'tc-rev-tyr-learn' }
              ),
            ]);
          },
          (ctx) => {
            const learnRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-rev-tyr-learn') as any;
            assert(learnRes && learnRes.isError !== true, `reverser vn_learn_skill failed: ${learnRes?.content?.[0]?.text}`);
            return fauxAssistantMessage('已完成 unpacked/ 结构与引擎级系统文本审计，并产出已验证的 engine-tyrano 技能与提示。');
          },
        ]);
      } else if (roleName === 'translator') {
        const transMap: Record<string, string> = {
          '#主人公': '#主角',
          'おはようございます！[p]': '早上好！[p]',
          'タイトルメニュー': '标题菜单',
          '第1章': '第1章',
          'はい': '是',
          'テスト学園': '测试学园',
          'テスト学園の物語': '测试学园物语',
          'タイトルに戻ります。よろしいですか？': '要返回标题画面吗？',
          'まだ、保存されているデータがありません': '还没有保存的数据',
          'エラーが発生しました': '发生错误',
          'エラーが発生しました。スクリプトを確認して下さい': '发生错误，请检查脚本。',
          '行1\\n行2': '第一行\\n第二行',
          'セーブできませんでした': '无法"保存"',
          '上書きしますか？': '要覆盖吗？',
          'メニューを閉じる': '关闭菜单',
          '閉じる': '关闭',
          'データ': '数据',
          '保存済み': '已保存',
          '戻る': '返回',
        };
        const respondFn = (ctx: any) => {
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

    tFaux.setResponses([
      () => fauxAssistantMessage([fauxToolCall('vn_detect', {}, { id: 'tc-tyr-detect' })]),
      (ctx) => {
        const detRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-detect') as any;
        assert(detRes?.isError !== true && detRes.content[0].text.includes('tyrano'), `Expected tyrano detect, got ${detRes?.content?.[0]?.text}`);
        return fauxAssistantMessage([fauxToolCall('vn_unpack', { dest: 'unpacked' }, { id: 'tc-tyr-unpack' })]);
      },
      (ctx) => {
        const unpRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-unpack') as any;
        assert(unpRes?.isError !== true, `Expected vn_unpack success, got ${unpRes?.content?.[0]?.text}`);
        const peManifest = JSON.parse(fs.readFileSync(path.join(sysWs, 'unpacked', '.pe-zip-manifest.json'), 'utf8'));
        assert(peManifest.engine === 'tyrano', `Expected manifest engine=tyrano, got ${peManifest.engine}`);
        return fauxAssistantMessage([
          fauxToolCall(
            'delegate_task',
            {
              role: 'reverser',
              task: '审计已解包到 unpacked/ 的 TyranoScript 结构与引擎级系统文本，通过 vn_learn_skill(unpackedDir="unpacked") 生成 engine-tyrano 技能与指引。',
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
        assert(
          detAfter?.content?.[0]?.text?.includes('ready  builtin unpack + skill:tyrano'),
          `Expected vn_detect to show builtin + ready analysis skill, got ${detAfter?.content?.[0]?.text}`
        );
        return fauxAssistantMessage([fauxToolCall('vn_classify', { unpacked: 'unpacked', out: 'build' }, { id: 'tc-tyr-classify' })]);
      },
      (ctx) => {
        const clsRes = ctx.messages.find((m) => m.role === 'toolResult' && (m as any).toolCallId === 'tc-tyr-classify') as any;
        assert(clsRes?.isError !== true, `Expected vn_classify success, got ${clsRes?.content?.[0]?.text}`);
        const manifest = JSON.parse(fs.readFileSync(path.join(sysWs, '.papercup', 'vn', 'text.json'), 'utf8'));
        assert(manifest.engine === 'tyrano' && manifest.profile === 'kag', `Expected engine=tyrano profile=kag, got ${JSON.stringify(manifest)}`);
        assert(
          Array.isArray(manifest.warnings) && manifest.warnings.some((w: string) => w.includes('menu_button_')),
          `Expected non-blocking menu image warning, got ${JSON.stringify(manifest.warnings)}`
        );
        const scenRows = fs
          .readFileSync(path.join(sysWs, 'build', 'scenario.jsonl'), 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((l) => JSON.parse(l));
        const uiRows = fs
          .readFileSync(path.join(sysWs, 'build', 'ui.jsonl'), 'utf8')
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
        for (const expectedSrc of [
          'タイトルに戻ります。よろしいですか？',
          'エラーが発生しました',
          'エラーが発生しました。スクリプトを確認して下さい',
          '行1\\n行2',
          'セーブできませんでした',
          '上書きしますか？',
          '閉じる',
          'メニューを閉じる',
          '戻る',
          'テスト学園',
          'テスト学園の物語',
          'タイトルメニュー',
          '第1章',
          'はい',
        ]) {
          assert(uiSources.includes(expectedSrc), `Missing expected UI system text "${expectedSrc}" in ${JSON.stringify(uiSources)}`);
        }
        for (const unwanted of ['menu_button_save.gif', 'コメント内は無視', '[camera] デバッグ用', 'スクリプト内は無視', '%text', 'あゆめ', 'コメントアウト']) {
          assert(!uiSources.some((s: string) => s.includes(unwanted)), `Should not extract "${unwanted}", got ${JSON.stringify(uiSources)}`);
        }
        return fauxAssistantMessage([fauxToolCall('vn_plan', { model: 'deepseek-chat', generateBatches: true }, { id: 'tc-tyr-plan' })]);
      },
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
          fauxToolCall('vn_accept', { archive: path.join(sysExport, 'MenheraTest.exe'), track: 'scenario', input: 'results/scenario.jsonl' }, { id: 'tc-tyr-acc-scn' }),
          fauxToolCall('vn_accept', { archive: path.join(sysExport, 'MenheraTest.exe'), track: 'ui', input: 'results/ui.jsonl' }, { id: 'tc-tyr-acc-ui' }),
        ]);
      },
      () => fauxAssistantMessage([fauxToolCall('vn_release', {}, { id: 'tc-tyr-rel' })]),
      () => fauxAssistantMessage([fauxToolCall('vn_promote_skill', { skill: 'engine-tyrano' }, { id: 'tc-tyr-promote' })]),
      () => fauxAssistantMessage('TyranoScript 系统文本与剧情本地化完成（仅供个人学习）。'),
    ]);

    await tyranoService.executeTurn('测试 TyranoScript 系统文本全管线');
    const tHist = await tyranoService.getSessionHistory();
    const tErrs = tHist.messages.filter((m) => m.error || (m.tools ?? []).some((t) => t.isError));
    assert(!tErrs.length, `Tyrano pipeline had errors: ${JSON.stringify(tErrs)}`);
    assert(fs.readFileSync(exePath).equals(peZipExe), 'Original MenheraTest.exe must remain untouched');

    const skillMdPath = path.join(sysWs, '.papercup', 'skills', 'engine-tyrano', 'SKILL.md');
    const skillMdText = fs.readFileSync(skillMdPath, 'utf8');
    assert(
      skillMdText.includes('tyrano/lang.js') && skillMdText.includes('menu_button_save.gif') && skillMdText.includes('Config.tjs'),
      `Generated SKILL.md missing expected system-text & raster-UI instructions: ${skillMdText}`
    );
    assert(
      fs.existsSync(path.join(sysHome, '.papercup', 'skills', 'engine-tyrano', 'extract.py')) &&
        fs.existsSync(path.join(sysHome, '.papercup', 'skills', 'engine-tyrano', 'apply.py')) &&
        fs.existsSync(path.join(sysHome, '.papercup', 'engines', 'tyrano', 'engine.json')),
      'Expected vn_promote_skill to copy SKILL.md, extract.py, apply.py, and engine.json globally'
    );

    unpackPeZip(path.join(sysExport, 'MenheraTest.exe'), sysVerifyDir);
    const outLangJs = fs.readFileSync(path.join(sysVerifyDir, 'tyrano', 'lang.js'), 'utf8');
    const langSandbox: any = { window: {} };
    vm.runInNewContext(outLangJs, langSandbox);
    assert(langSandbox.window.tyrano_lang.word.go_title === '要返回标题画面吗？', `Unexpected lang.word.go_title: ${outLangJs}`);
    assert(langSandbox.window.tyrano_lang.word.err_short === '发生错误', `Unexpected lang.word.err_short: ${outLangJs}`);
    assert(langSandbox.window.tyrano_lang.word.err_long === '发生错误，请检查脚本。', `Unexpected lang.word.err_long: ${outLangJs}`);
    assert(langSandbox.window.tyrano_lang.word.newline_msg === '第一行\n第二行', `Unexpected lang.word.newline_msg: ${outLangJs}`);
    assert(
      langSandbox.window.tyrano_lang.novel.file_menu_button_save === 'menu_button_save.gif',
      `Must preserve lang.novel asset name: ${outLangJs}`
    );

    const outLibsJs = fs.readFileSync(path.join(sysVerifyDir, 'tyrano', 'libs.js'), 'utf8');
    assert(outLibsJs.includes('alert("无法\\"保存\\"");'), `Expected escaped quote in alert(): ${outLibsJs}`);
    assert(outLibsJs.includes('$.confirm("要覆盖吗？", okFn, cancelFn);'), `Expected $.confirm writeback: ${outLibsJs}`);
    assert(outLibsJs.includes('/* $.alert("コメント内は無視"); */'), `Commented code must stay intact: ${outLibsJs}`);
    assert(outLibsJs.includes('alert("[camera] デバッグ用");'), `Dev [tag] debug alert must stay intact: ${outLibsJs}`);

    const outMenuHtml = fs.readFileSync(path.join(sysVerifyDir, 'tyrano', 'html', 'menu.html'), 'utf8');
    assert(outMenuHtml.includes('<div class="menu_close" title="关闭菜单">关闭</div>'), `Expected menu HTML text & attr writeback: ${outMenuHtml}`);
    assert(outMenuHtml.includes('<div>数据 {{:num}} 已保存</div>'), `Expected jsrender template preserved: ${outMenuHtml}`);
    assert(outMenuHtml.includes('<input type="button" value="返回">'), `Expected input button value writeback: ${outMenuHtml}`);
    assert(outMenuHtml.includes('<div>スクリプト内は無視</div>'), `Script block HTML string must stay untouched: ${outMenuHtml}`);

    const outIndexHtml = fs.readFileSync(path.join(sysVerifyDir, 'index.html'), 'utf8');
    assert(outIndexHtml.includes('<title>测试学园</title>'), `Expected index.html title writeback: ${outIndexHtml}`);

    const outConfigTjs = fs.readFileSync(path.join(sysVerifyDir, 'data', 'system', 'Config.tjs'), 'utf8');
    assert(outConfigTjs.includes(';System.title=测试学园物语'), `Expected Config.tjs title writeback: ${outConfigTjs}`);
    assert(outConfigTjs.includes('//;System.title=コメントアウト'), `Commented Config.tjs title must stay untouched: ${outConfigTjs}`);

    const outTitleKs = fs.readFileSync(path.join(sysVerifyDir, 'data', 'scenario', 'title_screen.ks'), 'utf8');
    assert(outTitleKs.includes('[ptext layer="0" text="标题菜单" name="あゆめ"]'), `Expected ptext text writeback only: ${outTitleKs}`);
    assert(outTitleKs.includes('[tb_ptext_show text="第1章" layer="0"]'), `Expected tb_ptext_show writeback: ${outTitleKs}`);
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
      '[title name="第一章"]\n[ptext layer="0" text="字幕" name="あゆめ"]\n[ptext text="%text"]\n',
      'utf8'
    );
    const kkCls = classifyUnpacked(kkUnpacked, { engine: 'kirikiri' });
    assert(
      kkCls.ui.length === 2 && kkCls.ui[0].source === '第一章' && kkCls.ui[1].source === '字幕',
      `Expected only [title] and [ptext text=...] in Kirikiri UI (skipping name="あゆめ" and %text), got ${JSON.stringify(kkCls.ui)}`
    );
    const kkProf = loadProfile(kkWs).profile;
    applyResults(
      kkWs,
      'unpacked',
      kkCls.ui.map((r) => ({
        ...r,
        ok: true,
        track: 'ui',
        target: r.source === '第一章' ? '开篇第一章' : '字幕文本',
      })),
      kkProf,
      { glossary: {}, persona: {} },
      'ui'
    );
    const kkKsAfter = fs.readFileSync(path.join(kkUnpacked, 'scenario', 'first.ks'), 'utf8');
    assert(
      kkKsAfter.includes('[title name="开篇第一章"]') && kkKsAfter.includes('text="字幕文本" name="あゆめ"'),
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
    (tyranoService as any).currentSession?.dispose?.();
    if (prevSysProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevSysProfile;
    if (prevSysHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevSysHome;
    fs.rmSync(sysRoot, { recursive: true, force: true });
  }

  // 20. 子 Agent 额度熔断、QA 断点续检与中断恢复上下文验证
  console.log('\n20. Verifying subagent quota circuit-breaker, post-QA checkpoint resume, and interruption recovery context...');
  const qaIntRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-qa-int-'));
  const prevQaIntProfile = process.env.USERPROFILE;
  const prevQaIntHome = process.env.HOME;
  const qaIntHome = path.join(qaIntRoot, 'home');
  const qaIntWs = path.join(qaIntRoot, 'ws');
  fs.mkdirSync(qaIntHome, { recursive: true });
  fs.mkdirSync(path.join(qaIntWs, 'build'), { recursive: true });
  fs.mkdirSync(path.join(qaIntWs, 'work', 'batches'), { recursive: true });
  fs.mkdirSync(path.join(qaIntWs, 'work', 'out'), { recursive: true });
  fs.mkdirSync(path.join(qaIntWs, 'vn'), { recursive: true });
  process.env.USERPROFILE = qaIntHome;
  process.env.HOME = qaIntHome;

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
  fs.writeFileSync(path.join(qaIntWs, 'build', 'scenario.jsonl'), qaRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(qaIntWs, 'work', 'batches', 'batch_000.jsonl'), qaRows.slice(0, 2).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(qaIntWs, 'work', 'batches', 'batch_001.jsonl'), qaRows.slice(2, 4).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(qaIntWs, 'work', 'batches', 'batch_002.jsonl'), qaRows.slice(4, 5).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    path.join(qaIntWs, 'work', 'batches', 'manifest.json'),
    JSON.stringify(
      {
        version: 1,
        batches: [
          { batch_id: 'batch_000', file: 'work/batches/batch_000.jsonl', track: 'scenario', rows: 2, estimated_source_tokens: 40, estimated_tokens_with_margin: 50, ids: ['s1.ks#1', 's1.ks#2'] },
          { batch_id: 'batch_001', file: 'work/batches/batch_001.jsonl', track: 'scenario', rows: 2, estimated_source_tokens: 40, estimated_tokens_with_margin: 50, ids: ['s1.ks#3', 's1.ks#4'] },
          { batch_id: 'batch_002', file: 'work/batches/batch_002.jsonl', track: 'scenario', rows: 1, estimated_source_tokens: 20, estimated_tokens_with_margin: 30, ids: ['s1.ks#5'] },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const qaIntService = new AgentService(qaIntWs, { sessionMode: 'persist' });
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

  try {
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
    assert(fs.existsSync(path.join(qaIntWs, '.papercup', 'vn', 'post_qa_state.json')), 'Expected .papercup/vn/post_qa_state.json to exist');

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
    (qaIntService as any).currentSession?.dispose?.();
    if (prevQaIntProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevQaIntProfile;
    if (prevQaIntHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevQaIntHome;
    fs.rmSync(qaIntRoot, { recursive: true, force: true });
  }

  // 21. 文件夹选择器、跨工作区会话懒加载与直达、历史工具输出裁剪、扫描过滤/缓存与网关预热/重试事件
  console.log('21. Verifying folder picker, cross-workspace lazy sessions, history truncation, scan skip & warmup/retry...');
  const u21Root = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-ux-perf-'));
  const u21PrevProfile = process.env.USERPROFILE;
  const u21PrevHome = process.env.HOME;
  let u21Svc: AgentService | null = null;
  let u21PickSvc: AgentService | null = null;
  try {
    const u21Home = path.join(u21Root, 'home');
    const u21WsA = path.join(u21Root, 'game-alpha');
    const u21WsB = path.join(u21Root, 'game-beta');
    const u21WsUnreg = path.join(u21Root, 'unregistered-dir');
    fs.mkdirSync(u21Home, { recursive: true });
    fs.mkdirSync(u21WsA, { recursive: true });
    fs.mkdirSync(u21WsB, { recursive: true });
    fs.mkdirSync(u21WsUnreg, { recursive: true });
    process.env.USERPROFILE = u21Home;
    process.env.HOME = u21Home;

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

    // 2) Cross-workspace lazy session listing + atomic open-session + large toolResult history truncation
    fs.writeFileSync(path.join(u21WsA, 'big.txt'), 'X'.repeat(9500), 'utf-8');
    u21Svc = new AgentService(u21WsA, { sessionMode: 'persist' });
    const u21Router = createApiRouter(u21Svc);

    await u21Svc.warmup();
    await u21Svc.initSession();

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
    const fakeTaskDir = path.join(u21WsA, '.papercup', 'diagnostics', 'subagent-tasks');
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

    // 3) scanWorkspace skips unpacked/ and getEngineeringStatus cache + ?refresh=1
    const fakeUnpackedDir = path.join(u21WsA, 'unpacked');
    fs.mkdirSync(fakeUnpackedDir, { recursive: true });
    fs.writeFileSync(path.join(fakeUnpackedDir, 'ignored.rpa'), 'RPA-3.0 0000000000000018 00000000\n\x00', 'latin1');
    const scanFiltered = scanWorkspace(u21WsA, null);
    assert(
      !scanFiltered.hits.some((h) => h.path.startsWith('unpacked/')),
      `Expected scanWorkspace to skip unpacked/, got ${JSON.stringify(scanFiltered.hits)}`
    );

    const engCached1 = await u21Svc.getEngineeringStatus();
    assert(engCached1.hasBuild === false, 'Expected initial hasBuild=false');
    fs.mkdirSync(path.join(u21WsA, 'build'), { recursive: true });
    const engCached2 = await u21Svc.getEngineeringStatus();
    assert(engCached2.hasBuild === false, 'Expected cached engineering status within TTL');
    const engRefreshedRes = await u21Router.request('/api/engineering/status?refresh=1');
    assert(engRefreshedRes.status === 200, `Expected 200 from /api/engineering/status?refresh=1, got ${engRefreshedRes.status}`);
    const engRefreshed = await engRefreshedRes.json();
    assert(engRefreshed.hasBuild === true, 'Expected ?refresh=1 to bypass cache and detect new build/ directory');

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
    if (u21PrevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = u21PrevProfile;
    if (u21PrevHome === undefined) delete process.env.HOME;
    else process.env.HOME = u21PrevHome;
    fs.rmSync(u21Root, { recursive: true, force: true });
  }

  console.log('22. Verifying API key auto-detection, live supported-model filtering, and beta health...');
  const u22Root = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-autodetect-test-'));
  const u22Home = path.join(u22Root, 'home');
  const u22Ws = path.join(u22Root, 'ws');
  const u22PrevProfile = process.env.USERPROFILE;
  const u22PrevHome = process.env.HOME;
  const u22SavedEnv = new Map<string, string | undefined>();
  for (const name of [
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'MODELSCOPE_API_KEY',
    'ARK_API_KEY',
    'SILICONFLOW_API_KEY',
    'MINIMAX_API_KEY',
    'MOONSHOT_API_KEY',
  ]) {
    u22SavedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  fs.mkdirSync(u22Home, { recursive: true });
  fs.mkdirSync(u22Ws, { recursive: true });
  process.env.USERPROFILE = u22Home;
  process.env.HOME = u22Home;

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
              { id: 'gpt-3.5-turbo' },
              { id: 'gpt-4' },
              { id: 'gpt-4-turbo' },
              { id: 'gpt-4o-2024-05-13' },
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

  let u22Svc: AgentService | null = null;
  try {
    u22Svc = new AgentService(u22Ws, {
      sessionMode: 'memory',
      probeFetch: mockProbeFetch,
    });
    const u22App = createApiRouter(u22Svc);

    const betaHealthRes = await u22App.request('/health');
    const betaHealthJson = await betaHealthRes.json();
    assert(
      betaHealthJson.version === '0.1.0-beta.1',
      `Expected beta health version 0.1.0-beta.1, got ${JSON.stringify(betaHealthJson)}`
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

    // 22b. Anthropic sk-ant- prefix auto-detection + legacy Claude filtering
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
        !antAutoBody.models.some((m: any) => /claude-3-5|claude-2\.1/.test(m.id)) &&
        !JSON.stringify(antAutoBody).includes(anthropicFakeKey),
      `Unexpected Anthropic auto-detected models payload: ${JSON.stringify(antAutoBody)}`
    );

    // 22c. OpenAI sk-proj- prefix + deprecated legacy GPT/O1/Whisper rejection
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
        !openaiAutoBody.models.some((m: any) =>
          /gpt-3\.5|gpt-4-turbo|gpt-4o-2024|o1-mini|whisper|text-embedding|^gpt-4$/.test(m.id)
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
    (u22Svc as any)?.disposeCurrentSessionState?.(true);
    for (const [name, value] of u22SavedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (u22PrevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = u22PrevProfile;
    if (u22PrevHome === undefined) delete process.env.HOME;
    else process.env.HOME = u22PrevHome;
    fs.rmSync(u22Root, { recursive: true, force: true });
  }

  console.log('\n--- All Server Integration Tests Passed Successfully! ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
