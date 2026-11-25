#!/usr/bin/env node
/**
 * Paper Cup Reverser Benchmark CLI
 *
 * Usage:
 *   npm run bench:reverser -- --list
 *   npm run bench:reverser -- --mode oracle
 *   npm run bench:reverser -- --provider magpie --model <model-id>
 *   npm run bench:reverser -- --provider openai-compat --base-url https://... --model <id> --api-key-env MY_API_KEY
 *   npm run bench:reverser -- --adapter ./bench/reverser/custom-provider.example.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { createVnTools } from '../../src/agent/vn-tools.js';
import { createReverserTools } from '../../src/agent/reverser-tools.js';
import { redactSecrets } from '../../src/security/secrets.js';
import { SubagentManager } from '../../src/subagents/subagent-manager.js';
import { loadProjectHarnessEngineJson } from '../../src/vn/archives.js';
import { copyTreeRecursive } from '../../src/vn/workflow.js';
import { BENCH_TASKS, selectBenchTasks } from './fixtures.js';
import { gradeReverserRun, snapshotDirSha256 } from './grader.js';
import { runAdversarialChecks, runOracleForTask, type AdversarialCheckResult } from './oracles.js';
import { resolveBenchProvider } from './provider.js';
import type {
  BenchProviderConfig,
  BenchResolvedRuntime,
  BenchRunReport,
  BenchTaskReport,
  BenchTaskSpec,
} from './types.js';

interface CliOptions {
  help: boolean;
  list: boolean;
  mode: 'live' | 'oracle';
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  adapter?: string;
  tasks?: string[];
  thinking: ThinkingLevel;
  timeoutMin: number;
  outDir?: string;
  keepWorkspace: boolean;
}

const VALID_THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    help: false,
    list: false,
    mode: 'live',
    provider: 'magpie',
    thinking: 'max',
    timeoutMin: 30,
    keepWorkspace: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少取值`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--mode') {
      const v = next().trim().toLowerCase();
      if (v !== 'live' && v !== 'oracle') throw new Error(`--mode 仅支持 live 或 oracle，收到: ${v}`);
      opts.mode = v;
    } else if (a === '--provider') opts.provider = next().trim();
    else if (a === '--model') opts.model = next().trim();
    else if (a === '--base-url') opts.baseUrl = next().trim();
    else if (a === '--api-key') opts.apiKey = next();
    else if (a === '--api-key-env') opts.apiKeyEnv = next().trim();
    else if (a === '--adapter') opts.adapter = next().trim();
    else if (a === '--tasks') opts.tasks = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--thinking') {
      const v = next().trim().toLowerCase() as ThinkingLevel;
      if (!VALID_THINKING.has(v)) throw new Error(`无效 --thinking 取值: ${v}`);
      opts.thinking = v;
    } else if (a === '--timeout-min') {
      const n = Number(next());
      if (!Number.isFinite(n) || n <= 0) throw new Error(`无效 --timeout-min: ${n}`);
      opts.timeoutMin = n;
    } else if (a === '--out') opts.outDir = next().trim();
    else if (a === '--keep-workspace') opts.keepWorkspace = true;
    else throw new Error(`未知参数: ${a}（使用 --help 查看说明）`);
  }

  if (!opts.apiKey && opts.apiKeyEnv) {
    opts.apiKey = process.env[opts.apiKeyEnv] || '';
    if (!opts.apiKey) {
      throw new Error(`环境变量 ${opts.apiKeyEnv} 未设置或为空`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Paper Cup Reverser Benchmark (L1 -> L6)

用法:
  npm run bench:reverser -- [选项]

选项:
  --list                     列出全部 6 道由简到难的评测题目并退出
  --mode live|oracle         live: 调用真实 reverser 模型评测（默认）
                             oracle: 离线运行参考解 + 6 项反作弊负向自检（0 token）
  --provider <name>          默认 magpie（本地 http://127.0.0.1:3425/v1）
                             支持: magpie | openai-compat | openai | anthropic | google | deepseek | ...
  --model <id>               模型 ID（magpie 模式留空时自动探测首个可用模型）
  --base-url <url>           自定义接口地址（用于 magpie 或 openai-compat）
  --api-key <key>            直接传入 API Key（不推荐写进历史命令，优先 --api-key-env）
  --api-key-env <ENV>        从指定环境变量读取 API Key（绝不打印或写入报告）
  --adapter <file>           接入自定义 TypeScript/JS Provider Adapter 模块
  --tasks <list>             仅跑指定题目，逗号分隔，如: L1,L2 或 L4-obfuscated-msg-trap
  --thinking <level>         思考深度: off|minimal|low|medium|high|xhigh|max（默认 max）
  --timeout-min <minutes>    单题超时分钟数（默认 30）
  --out <dir>                报告与轨迹输出目录（默认 server/bench/reverser/runs/<timestamp>）
  --keep-workspace           保留临时测试工作区以便排查
`);
}

function printTaskList(): void {
  console.log('\nPaper Cup Reverser Benchmark 题库（由简到难，共 6 题，每题 8 项硬约束全过才算 PASS）：\n');
  for (const t of BENCH_TASKS) {
    const scen = t.groundTruth.filter((g) => g.track === 'scenario').length;
    const ui = t.groundTruth.filter((g) => g.track === 'ui').length;
    console.log(
      `  [${t.difficulty}] ${t.id.padEnd(28)} | ${t.tierName} | pipeline=${t.expectedPipeline.padEnd(6)} | enc=${t.expectedSourceEncoding.padEnd(5)} | GT=${scen}剧情+${ui}UI`
    );
    console.log(`       标题: ${t.title}`);
    console.log(`       考点: ${t.description}\n`);
  }
}

function timestampSlug(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0).padStart(2, '0');
  return `${m}m${rem}s`;
}

function persistTaskArtifacts(params: {
  artifactDir: string;
  workspaceDir: string;
  homeDir: string;
  taskReport: BenchTaskReport;
  snapshot?: unknown;
  reverserText?: string;
  knownSecrets?: Iterable<string>;
}): void {
  const { artifactDir, workspaceDir, homeDir, taskReport, snapshot, reverserText, knownSecrets } = params;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'gates.json'), JSON.stringify(taskReport, null, 2) + '\n', 'utf8');

  if (snapshot !== undefined) {
    const safeJson = redactSecrets(JSON.stringify(snapshot, null, 2), knownSecrets);
    fs.writeFileSync(path.join(artifactDir, 'snapshot.json'), safeJson + '\n', 'utf8');
  }
  if (reverserText !== undefined) {
    fs.writeFileSync(
      path.join(artifactDir, 'reverser-output.md'),
      redactSecrets(reverserText, knownSecrets) + '\n',
      'utf8'
    );
  }

  const researchDir = path.join(workspaceDir, '.papercup', 'research');
  if (fs.existsSync(researchDir)) {
    copyTreeRecursive(researchDir, path.join(artifactDir, 'research'));
  }
  const skillsDir = path.join(workspaceDir, '.papercup', 'skills');
  if (fs.existsSync(skillsDir)) {
    copyTreeRecursive(skillsDir, path.join(artifactDir, 'skills'));
  }
  const engineJson = loadProjectHarnessEngineJson(workspaceDir, homeDir);
  if (engineJson) {
    fs.writeFileSync(path.join(artifactDir, 'engine.json'), JSON.stringify(engineJson, null, 2) + '\n', 'utf8');
  }
}

function renderMarkdownReport(report: BenchRunReport, adversarial?: AdversarialCheckResult[]): string {
  const lines: string[] = [
    '# Paper Cup Reverser Benchmark 评测报告',
    '',
    `- 时间：${report.createdAt}`,
    `- 模式：\`${report.mode}\``,
    `- Provider / Model：\`${report.provider}\` / \`${report.model}\``,
    `- Thinking Level：\`${report.thinkingLevel}\``,
    `- 总通过率：**${report.passedTasks}/${report.totalTasks} (${(report.passRate * 100).toFixed(1)}%)**`,
    `- 总耗时：${formatDuration(report.totalDurationMs)}`,
    `- 总 Token：${report.totalUsage.totalTokens.toLocaleString()} (in=${report.totalUsage.input.toLocaleString()}, out=${report.totalUsage.output.toLocaleString()})`,
    '',
    '## 分题汇总',
    '',
    '| 难度 | 题目 ID | 状态 | 硬约束通过 | 工具调用 | 耗时 | Token |',
    '|------|---------|------|-----------|----------|------|-------|',
  ];

  for (const r of report.results) {
    const badge = r.passed ? 'PASS' : 'FAIL';
    lines.push(
      `| ${r.difficulty} | \`${r.taskId}\` | **${badge}** | ${r.passedGates}/${r.totalGates} | ${r.toolCalls} | ${formatDuration(r.durationMs)} | ${r.usage.totalTokens.toLocaleString()} |`
    );
  }

  lines.push('', '## 逐题门禁明细', '');
  for (const r of report.results) {
    lines.push(`### [${r.difficulty}] ${r.taskId} — ${r.passed ? 'PASS' : 'FAIL'}`);
    lines.push(`- 标题：${r.title}`);
    lines.push(`- 运行状态：\`${r.reverserStatus}\`${r.reverserError ? `（${r.reverserError}）` : ''}`);
    lines.push(`- 产物目录：\`${r.artifactDir}\``);
    lines.push('');
    for (const g of r.gates) {
      lines.push(`- [${g.passed ? 'x' : ' '}] **${g.id}**: ${g.summary}`);
    }
    lines.push('');
  }

  if (adversarial && adversarial.length > 0) {
    lines.push('## 反作弊 / 负向校验自检 (Adversarial Checks)', '');
    for (const a of adversarial) {
      lines.push(`- [${a.caught ? 'x' : ' '}] **${a.name}** (\`${a.taskId}\`): ${a.detail}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function runSingleTask(params: {
  task: BenchTaskSpec;
  mode: 'live' | 'oracle';
  runtime: BenchResolvedRuntime | null;
  timeoutMin: number;
  outDir: string;
  keepWorkspace: boolean;
}): Promise<BenchTaskReport> {
  const { task, mode, runtime, timeoutMin, outDir, keepWorkspace } = params;
  const startedAt = Date.now();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `papercup-bench-${task.difficulty}-`));
  const ws = path.join(tempRoot, 'workspace');
  const home = path.join(tempRoot, 'papercup-home');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const prevPaperCupHome = process.env.PAPERCUP_HOME;
  process.env.PAPERCUP_HOME = home;

  const artifactDir = path.join(outDir, task.id);
  let reverserStatus: BenchTaskReport['reverserStatus'] = mode === 'oracle' ? 'oracle' : 'error';
  let reverserError: string | undefined;
  let toolCalls = 0;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let snapshotForDisk: unknown;
  let reverserText: string | undefined;

  try {
    task.generateFixture(ws);
    const originalGameSnapshot = snapshotDirSha256(path.join(ws, task.gameRelDir));

    if (mode === 'oracle') {
      await runOracleForTask(task, ws, home);
    } else {
      if (!runtime) throw new Error('live 模式缺少已解析的模型运行时');
      const manager = new SubagentManager();
      const vnTools = createVnTools(() => ws, {
        getKnownSecrets: () => runtime.knownSecrets,
      });
      const reverserTools = createReverserTools(() => ws, {
        getKnownSecrets: () => runtime.knownSecrets,
      });
      const prompt = task.buildTaskPrompt(task.gameRelDir);
      const timeoutMs = Math.round(timeoutMin * 60_000);
      const hardGraceMs = 15_000;
      const controller = new AbortController();
      let lastPrintedTools = -1;
      let lastPrintedStage = '';
      let latestSnapshot: any;
      let softTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        const runPromise = manager.runSubagentWithMetrics('reverser', prompt, {
          cwd: ws,
          model: runtime.model,
          modelRuntime: runtime.modelRuntime,
          thinkingLevel: runtime.thinkingLevel,
          customTools: [...vnTools, ...reverserTools],
          signal: controller.signal,
          recordDiagnostics: true,
          getKnownSecrets: () => runtime.knownSecrets,
          onTaskUpdated: (summary, snap) => {
            latestSnapshot = snap;
            if (summary.toolCallCount !== lastPrintedTools || summary.stage !== lastPrintedStage) {
              lastPrintedTools = summary.toolCallCount;
              lastPrintedStage = summary.stage;
              process.stdout.write(
                `\r    [${task.difficulty}] stage=${summary.stage} | tools=${summary.toolCallCount} | elapsed=${formatDuration(Date.now() - startedAt)}   `
              );
            }
          },
        });
        // Prevent unhandled rejection if hard cutoff wins the race before runPromise settles
        runPromise.catch(() => {});

        const hardCutoffPromise = new Promise<never>((_, reject) => {
          softTimer = setTimeout(() => {
            controller.abort(new Error(`Benchmark timeout after ${timeoutMin}m`));
            hardTimer = setTimeout(() => {
              const err: any = new Error(
                `Benchmark hard cutoff after ${timeoutMin}m (+15s grace; upstream stream did not close on abort)`
              );
              err.metrics = {
                status: 'aborted',
                toolCalls: Array.isArray(latestSnapshot?.toolCalls) ? latestSnapshot.toolCalls : [],
                usage: latestSnapshot?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
              };
              err.snapshot = latestSnapshot;
              reject(err);
            }, hardGraceMs);
            hardTimer.unref?.();
          }, timeoutMs);
          softTimer.unref?.();
        });

        const res = await Promise.race([runPromise, hardCutoffPromise]);
        process.stdout.write('\n');
        reverserStatus = res.metrics.status;
        reverserError = res.metrics.error;
        toolCalls = res.metrics.toolCalls.length;
        usage = {
          input: res.metrics.usage.input,
          output: res.metrics.usage.output,
          cacheRead: res.metrics.usage.cacheRead,
          cacheWrite: res.metrics.usage.cacheWrite,
          totalTokens: res.metrics.usage.totalTokens,
        };
        snapshotForDisk = res.snapshot;
        reverserText = res.text;
      } catch (err: any) {
        process.stdout.write('\n');
        reverserStatus = err?.metrics?.status ?? (controller.signal.aborted ? 'aborted' : 'error');
        reverserError = redactSecrets(String(err?.message || err), runtime.knownSecrets);
        const snap = err?.snapshot ?? latestSnapshot;
        if (err?.metrics) {
          toolCalls = Array.isArray(err.metrics.toolCalls) ? err.metrics.toolCalls.length : 0;
          usage = {
            input: err.metrics.usage?.input ?? 0,
            output: err.metrics.usage?.output ?? 0,
            cacheRead: err.metrics.usage?.cacheRead ?? 0,
            cacheWrite: err.metrics.usage?.cacheWrite ?? 0,
            totalTokens: err.metrics.usage?.totalTokens ?? 0,
          };
        } else if (snap) {
          toolCalls = Array.isArray(snap.toolCalls) ? snap.toolCalls.length : 0;
          usage = {
            input: snap.usage?.input ?? 0,
            output: snap.usage?.output ?? 0,
            cacheRead: snap.usage?.cacheRead ?? 0,
            cacheWrite: snap.usage?.cacheWrite ?? 0,
            totalTokens: snap.usage?.totalTokens ?? 0,
          };
        }
        if (snap) snapshotForDisk = snap;
      } finally {
        if (softTimer) clearTimeout(softTimer);
        if (hardTimer) clearTimeout(hardTimer);
        manager.disposeResumableSessions(ws);
      }
    }

    const gates = await gradeReverserRun({
      task,
      workspaceDir: ws,
      homeDir: home,
      originalGameSnapshot,
    });
    const passedGates = gates.filter((g) => g.passed).length;
    const taskReport: BenchTaskReport = {
      taskId: task.id,
      difficulty: task.difficulty,
      tierName: task.tierName,
      title: task.title,
      passed: passedGates === gates.length,
      passedGates,
      totalGates: gates.length,
      gates,
      durationMs: Date.now() - startedAt,
      reverserStatus,
      ...(reverserError ? { reverserError } : {}),
      toolCalls,
      usage,
      artifactDir,
    };

    persistTaskArtifacts({
      artifactDir,
      workspaceDir: ws,
      homeDir: home,
      taskReport,
      snapshot: snapshotForDisk,
      reverserText,
      knownSecrets: runtime?.knownSecrets,
    });

    return taskReport;
  } finally {
    if (prevPaperCupHome === undefined) delete process.env.PAPERCUP_HOME;
    else process.env.PAPERCUP_HOME = prevPaperCupHome;
    if (!keepWorkspace) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } else {
      console.log(`    [keep-workspace] ${tempRoot}`);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.list) {
    printTaskList();
    return;
  }

  const tasks = selectBenchTasks(opts.tasks);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outDir = opts.outDir
    ? path.resolve(opts.outDir)
    : path.join(__dirname, 'runs', `${opts.mode}-${timestampSlug()}`);
  fs.mkdirSync(outDir, { recursive: true });

  let runtime: BenchResolvedRuntime | null = null;
  if (opts.mode === 'live') {
    const providerCfg: BenchProviderConfig = {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      thinkingLevel: opts.thinking,
      adapterPath: opts.adapter,
    };
    console.log(`[bench] 解析 Provider (${opts.adapter ? `adapter:${opts.adapter}` : opts.provider})...`);
    runtime = await resolveBenchProvider(providerCfg);
    console.log(
      `[bench] 已就绪: provider=${runtime.providerLabel}, model=${runtime.modelLabel}, thinking=${runtime.thinkingLevel}`
    );
  } else {
    console.log('[bench] 离线 Oracle 自检模式（0 LLM token）');
  }

  console.log(`[bench] 输出目录: ${outDir}`);
  console.log(`[bench] 题目列表 (${tasks.length}): ${tasks.map((t) => t.id).join(', ')}\n`);

  const runStart = Date.now();
  const results: BenchTaskReport[] = [];

  for (const task of tasks) {
    console.log(`==> [${task.difficulty}] ${task.id} — ${task.title}`);
    const rep = await runSingleTask({
      task,
      mode: opts.mode,
      runtime,
      timeoutMin: opts.timeoutMin,
      outDir,
      keepWorkspace: opts.keepWorkspace,
    });
    results.push(rep);
    console.log(
      `    结果: ${rep.passed ? 'PASS' : 'FAIL'} (${rep.passedGates}/${rep.totalGates} gates) | 耗时 ${formatDuration(rep.durationMs)} | 工具调用 ${rep.toolCalls} | Token ${rep.usage.totalTokens}`
    );
    if (!rep.passed) {
      for (const g of rep.gates.filter((x) => !x.passed)) {
        console.log(`      [FAIL] ${g.id}: ${g.summary}`);
      }
    }
    console.log('');
  }

  let adversarial: AdversarialCheckResult[] | undefined;
  if (opts.mode === 'oracle') {
    console.log('==> 运行反作弊 / 负向校验自检...');
    adversarial = await runAdversarialChecks();
    for (const a of adversarial) {
      console.log(`    [${a.caught ? 'OK-CAUGHT' : 'MISS'}] ${a.name} (${a.taskId}): ${a.detail}`);
    }
    console.log('');
  }

  const passedTasks = results.filter((r) => r.passed).length;
  const totalUsage = results.reduce(
    (acc, r) => ({
      input: acc.input + r.usage.input,
      output: acc.output + r.usage.output,
      cacheRead: acc.cacheRead + r.usage.cacheRead,
      cacheWrite: acc.cacheWrite + r.usage.cacheWrite,
      totalTokens: acc.totalTokens + r.usage.totalTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  );

  const report: BenchRunReport = {
    schema: 1,
    createdAt: new Date().toISOString(),
    mode: opts.mode,
    provider: runtime?.providerLabel ?? 'oracle',
    model: runtime?.modelLabel ?? 'reference-oracle',
    thinkingLevel: runtime?.thinkingLevel ?? 'n/a',
    totalTasks: results.length,
    passedTasks,
    passRate: results.length > 0 ? passedTasks / results.length : 0,
    totalDurationMs: Date.now() - runStart,
    totalUsage,
    results,
  };

  const reportJsonPath = path.join(outDir, 'report.json');
  const reportMdPath = path.join(outDir, 'report.md');
  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(reportMdPath, renderMarkdownReport(report, adversarial) + '\n', 'utf8');

  const advFailed = adversarial ? adversarial.filter((a) => !a.caught).length : 0;
  console.log('============================================================');
  console.log(
    `总成绩: ${passedTasks}/${results.length} PASS (${(report.passRate * 100).toFixed(1)}%) | 总耗时 ${formatDuration(report.totalDurationMs)}`
  );
  if (adversarial) {
    console.log(`反作弊自检: ${adversarial.length - advFailed}/${adversarial.length} 全部拦截`);
  }
  console.log(`报告路径: ${reportMdPath}`);
  console.log(`JSON 数据: ${reportJsonPath}`);
  console.log('============================================================');

  if (passedTasks < results.length || advFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[bench] 执行失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
