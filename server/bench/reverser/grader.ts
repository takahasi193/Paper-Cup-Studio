/**
 * Strict 8-gate deterministic hard-constraint grader for the Paper Cup Reverser Benchmark.
 *
 * Every gate is purely programmatic and verifiable: zero LLM-as-judge, zero fuzzy scoring.
 * A task PASSES if and only if ALL 8 gates pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APPLY_DIGEST,
  EXTRACT_DIGEST,
  REPACK_DIGEST,
  SKILL_DIGEST,
  SKILL_MANIFEST,
  UNPACK_DIGEST,
  loadProjectHarnessEngineJson,
  runPythonScript,
  sha256Hex,
} from '../../src/vn/archives.js';
import { normalizeGbkCompatText, type LocalizationProfile } from '../../src/vn/profile.js';
import { qaReport } from '../../src/vn/qa.js';
import { copyTreeRecursive } from '../../src/vn/workflow.js';
import type { BenchGateResult, BenchTaskSpec } from './types.js';

export function snapshotDirSha256(rootDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (cur: string) => {
    if (!fs.existsSync(cur)) return;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        out.set(rel, sha256Hex(fs.readFileSync(full)));
      }
    }
  };
  walk(rootDir);
  return out;
}

interface ExtractedRow {
  id: string;
  file: string;
  line: number;
  kind: string;
  source: string;
  extra: Record<string, unknown>;
}

const VALID_EXTRACT_KINDS = new Set([
  'say',
  'name',
  'choice',
  'system',
  'button',
  'menu',
  'label',
  'title',
  'ui',
]);

function parseStrictExtractJsonl(jsonlPath: string): ExtractedRow[] {
  const rawText = fs.readFileSync(jsonlPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const seenIds = new Set<string>();
  const rows: ExtractedRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    let obj: any;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new Error(`extract.py 第 ${i + 1} 行不是合法 JSON`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(`extract.py 第 ${i + 1} 行不是 JSON 对象`);
    }
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    const file = typeof obj.file === 'string' ? obj.file.trim() : '';
    const line = Number(obj.line);
    const kind = typeof obj.kind === 'string' ? obj.kind.trim().toLowerCase() : '';
    const source = typeof obj.source === 'string' ? obj.source : '';
    if (!id) throw new Error(`extract.py 第 ${i + 1} 行缺少非空 id`);
    if (seenIds.has(id)) throw new Error(`extract.py 存在重复 id: ${id}`);
    seenIds.add(id);
    if (!file) throw new Error(`extract.py 第 ${i + 1} 行缺少非空 file`);
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`extract.py 第 ${i + 1} 行 line 非法: ${String(obj.line)}`);
    }
    if (!VALID_EXTRACT_KINDS.has(kind)) {
      throw new Error(`extract.py 第 ${i + 1} 行 kind 非法: ${kind || '(空)'}`);
    }
    if (!source) throw new Error(`extract.py 第 ${i + 1} 行缺少非空 source`);
    rows.push({ id, file, line, kind, source, extra: obj as Record<string, unknown> });
  }
  return rows;
}

async function runExtractorOnDir(extractPy: string, targetDir: string, outJsonl: string): Promise<ExtractedRow[]> {
  await runPythonScript(extractPy, [targetDir, outJsonl], targetDir);
  if (!fs.existsSync(outJsonl)) {
    throw new Error(`extract.py 未写出输出文件: ${outJsonl}`);
  }
  return parseStrictExtractJsonl(outJsonl);
}

export async function gradeReverserRun(params: {
  task: BenchTaskSpec;
  workspaceDir: string;
  homeDir: string;
  originalGameSnapshot: Map<string, string>;
}): Promise<BenchGateResult[]> {
  const { task, workspaceDir, homeDir, originalGameSnapshot } = params;
  const gates: BenchGateResult[] = [];

  const gameAbsDir = path.join(workspaceDir, task.gameRelDir);
  const engineJson = loadProjectHarnessEngineJson(workspaceDir, homeDir);
  const engineName = typeof engineJson?.name === 'string' ? engineJson.name.trim() : '';
  const skillName = typeof engineJson?.skill === 'string' ? engineJson.skill.trim() : '';
  const skillDir = skillName ? path.join(workspaceDir, '.papercup', 'skills', skillName) : '';
  const pipeline = typeof engineJson?.pipeline === 'string' ? engineJson.pipeline.trim().toLowerCase() : '';
  const wbObj =
    engineJson?.writeback && typeof engineJson.writeback === 'object' && !Array.isArray(engineJson.writeback)
      ? (engineJson.writeback as Record<string, unknown>)
      : null;

  const extractPy = skillDir ? path.join(skillDir, 'extract.py') : '';
  const applyPy = skillDir ? path.join(skillDir, 'apply.py') : '';
  const unpackPy = skillDir ? path.join(skillDir, 'unpack.py') : '';
  const repackPy = skillDir ? path.join(skillDir, 'repack.py') : '';
  const skillMd = skillDir ? path.join(skillDir, 'SKILL.md') : '';

  /* ---------- G1: Skill Adopted & Verified ---------- */
  {
    const issues: string[] = [];
    if (!engineJson) {
      issues.push('项目 harness 目录中未找到已采纳的 engine.json（reverser 未通过 vn_learn_skill）');
    } else {
      if (!engineName || !skillName) issues.push('engine.json 缺少 name 或 skill 字段');
      if (pipeline !== task.expectedPipeline) {
        issues.push(`pipeline 不符：期望 "${task.expectedPipeline}"，实际 "${pipeline || '(空)'}"`);
      }
      if (wbObj?.verified !== true) issues.push('writeback.verified 不为 true');
      if (!fs.existsSync(skillMd)) issues.push('缺少 SKILL.md');
      if (!fs.existsSync(extractPy)) issues.push('缺少 extract.py');
      if (!fs.existsSync(applyPy)) issues.push('缺少 apply.py');
      if (task.expectedPipeline === 'skill') {
        if (!fs.existsSync(unpackPy)) issues.push('skill 流水线缺少 unpack.py');
        if (!fs.existsSync(repackPy)) issues.push('skill 流水线缺少 repack.py');
      }
      const checkDigest = (field: string, fp: string) => {
        if (!fs.existsSync(fp)) return;
        const exp = typeof engineJson[field] === 'string' ? String(engineJson[field]) : '';
        const act = sha256Hex(fs.readFileSync(fp));
        if (!exp || exp !== act) issues.push(`${field} 摘要与磁盘文件不匹配`);
      };
      checkDigest(SKILL_DIGEST, skillMd);
      checkDigest(EXTRACT_DIGEST, extractPy);
      checkDigest(APPLY_DIGEST, applyPy);
      if (task.expectedPipeline === 'skill') {
        checkDigest(UNPACK_DIGEST, unpackPy);
        checkDigest(REPACK_DIGEST, repackPy);
      }
    }
    gates.push({
      id: 'G1_SKILL_ADOPTED',
      passed: issues.length === 0,
      summary:
        issues.length === 0
          ? `技能 ${skillName} (${pipeline}) 已通过 vn_learn_skill 采纳且全部 SHA-256 摘要一致`
          : issues.join('；'),
      details: { engineName, skillName, pipeline, issues },
    });
  }

  /* ---------- G2: Original Game Files Untouched ---------- */
  {
    const afterSnap = snapshotDirSha256(gameAbsDir);
    const diffs: string[] = [];
    for (const [rel, origSha] of originalGameSnapshot.entries()) {
      const act = afterSnap.get(rel);
      if (!act) diffs.push(`缺失原始文件: ${rel}`);
      else if (act !== origSha) diffs.push(`原始文件被篡改: ${rel}`);
    }
    for (const rel of afterSnap.keys()) {
      if (!originalGameSnapshot.has(rel)) diffs.push(`游戏目录遗留多余文件: ${rel}`);
    }
    gates.push({
      id: 'G2_ORIGINAL_UNTOUCHED',
      passed: diffs.length === 0,
      summary:
        diffs.length === 0
          ? `原始游戏目录 ${originalGameSnapshot.size} 个文件 100% 字节无改动`
          : diffs.slice(0, 6).join('；'),
      details: { originalFiles: originalGameSnapshot.size, diffs },
    });
  }

  /* ---------- G3: Research Artifacts Persisted ---------- */
  {
    const researchRoot = path.join(workspaceDir, '.papercup', 'research');
    const issues: string[] = [];
    let matchedDir = '';
    if (!fs.existsSync(researchRoot)) {
      issues.push('缺少 .papercup/research/ 目录');
    } else {
      const dirs = fs
        .readdirSync(researchRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const preferred = dirs.includes(engineName) ? engineName : dirs[0] || '';
      if (!preferred) {
        issues.push('.papercup/research/ 下无引擎研究子目录');
      } else {
        matchedDir = preferred;
        const rDir = path.join(researchRoot, preferred);
        for (const fname of ['01-layout.md', '02-hypotheses.md', '03-text-mapping.json']) {
          const fp = path.join(rDir, fname);
          if (!fs.existsSync(fp) || fs.statSync(fp).size < 10) {
            issues.push(`研究文档缺失或过空: .papercup/research/${preferred}/${fname}`);
          } else if (fname.endsWith('.json')) {
            try {
              const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
              if (!parsed || typeof parsed !== 'object') issues.push(`${fname} 不是有效 JSON 对象`);
            } catch {
              issues.push(`${fname} 不是合法 JSON`);
            }
          }
        }
      }
    }
    gates.push({
      id: 'G3_RESEARCH_ARTIFACTS',
      passed: issues.length === 0,
      summary:
        issues.length === 0
          ? `三阶段研究文档已完整落盘 (.papercup/research/${matchedDir}/)`
          : issues.join('；'),
      details: { researchEngineDir: matchedDir, issues },
    });
  }

  const canExecuteScripts =
    gates[0].passed &&
    fs.existsSync(extractPy) &&
    fs.existsSync(applyPy) &&
    (task.expectedPipeline === 'direct' || (fs.existsSync(unpackPy) && fs.existsSync(repackPy)));

  const tmpEval = fs.mkdtempSync(path.join(os.tmpdir(), `papercup-bench-eval-${task.difficulty}-`));
  try {
    let extractedByBucket: Array<{
      archiveRel?: string;
      rows: ExtractedRow[];
    }> = [];

    /* ---------- G4: Extraction Accuracy (Recall + Precision + Schema) ---------- */
    if (!canExecuteScripts) {
      gates.push({
        id: 'G4_EXTRACTION_ACCURACY',
        passed: false,
        summary: '跳过：前置技能未采纳或脚本缺失',
      });
    } else {
      const issues: string[] = [];
      try {
        if (task.expectedPipeline === 'direct') {
          const cleanCopy = path.join(tmpEval, 'extract_clean');
          copyTreeRecursive(gameAbsDir, cleanCopy);
          const rows = await runExtractorOnDir(extractPy, cleanCopy, path.join(tmpEval, 'extract_out.jsonl'));
          extractedByBucket = [{ rows }];
        } else {
          const archives = task.archiveRelPaths || [];
          for (let i = 0; i < archives.length; i++) {
            const archRel = archives[i];
            const archAbs = path.join(workspaceDir, archRel);
            const unpDir = path.join(tmpEval, `unp_${i}`);
            fs.mkdirSync(unpDir, { recursive: true });
            await runPythonScript(unpackPy, [archAbs, unpDir], unpDir);
            const rows = await runExtractorOnDir(extractPy, unpDir, path.join(tmpEval, `extract_${i}.jsonl`));
            extractedByBucket.push({ archiveRel: archRel, rows });
          }
        }

        const allRows = extractedByBucket.flatMap((b) => b.rows);
        const extractedBySource = new Map<string, ExtractedRow[]>();
        for (const r of allRows) {
          const arr = extractedBySource.get(r.source) ?? [];
          arr.push(r);
          extractedBySource.set(r.source, arr);
        }

        // Scenario recall
        const gtScen = task.groundTruth.filter((g) => g.track === 'scenario');
        const gtUi = task.groundTruth.filter((g) => g.track === 'ui');
        let scenHit = 0;
        let scenWrongKind = 0;
        const missingScen: string[] = [];
        for (const g of gtScen) {
          const hits = extractedBySource.get(g.source);
          if (!hits || hits.length === 0) {
            missingScen.push(g.source.slice(0, 40));
          } else if (hits.some((h) => h.kind === 'say')) {
            scenHit += 1;
          } else {
            scenWrongKind += 1;
            missingScen.push(`[错标kind=${hits[0].kind}] ${g.source.slice(0, 35)}`);
          }
        }
        let uiHit = 0;
        const missingUi: string[] = [];
        for (const g of gtUi) {
          const hits = extractedBySource.get(g.source);
          if (!hits || hits.length === 0) {
            missingUi.push(g.source.slice(0, 40));
          } else {
            uiHit += 1;
          }
        }

        const scenRecall = gtScen.length > 0 ? scenHit / gtScen.length : 1;
        const uiRecall = gtUi.length > 0 ? uiHit / gtUi.length : 1;
        if (scenRecall < task.minScenarioRecall) {
          issues.push(
            `剧情召回率不足: ${(scenRecall * 100).toFixed(1)}% (${scenHit}/${gtScen.length}, 错标kind=${scenWrongKind}, 要求 >=${(task.minScenarioRecall * 100).toFixed(0)}%)；缺失样例: ${missingScen.slice(0, 3).join(' | ')}`
          );
        }
        if (uiRecall < task.minUiRecall) {
          issues.push(
            `界面/角色召回率不足: ${(uiRecall * 100).toFixed(1)}% (${uiHit}/${gtUi.length}, 要求 >=${(task.minUiRecall * 100).toFixed(0)}%)；缺失样例: ${missingUi.slice(0, 3).join(' | ')}`
          );
        }

        // Zero-noise precision: forbidden decoys / internal keys / comments / half-width kana
        const noiseHits: string[] = [];
        for (const r of allRows) {
          for (const bad of task.forbiddenExtractedSubstrings) {
            if (r.source.includes(bad)) {
              noiseHits.push(`${r.id} 命中禁抽噪声 "${bad}": ${r.source.slice(0, 50)}`);
              break;
            }
          }
          if (noiseHits.length >= 5) break;
        }
        if (noiseHits.length > 0) {
          issues.push(`抽出了禁止提取的噪声/内部键/未解码半角假名: ${noiseHits.join('；')}`);
        }

        gates.push({
          id: 'G4_EXTRACTION_ACCURACY',
          passed: issues.length === 0,
          summary:
            issues.length === 0
              ? `抽取精准：共 ${allRows.length} 行，剧情召回 ${scenHit}/${gtScen.length} (100%)，UI/人名召回 ${uiHit}/${gtUi.length}，0 噪声泄漏`
              : issues.join('；'),
          details: {
            totalExtracted: allRows.length,
            scenHit,
            scenTotal: gtScen.length,
            scenRecall,
            uiHit,
            uiTotal: gtUi.length,
            uiRecall,
            noiseHits,
            missingScen: missingScen.slice(0, 5),
            missingUi: missingUi.slice(0, 5),
          },
        });
      } catch (err: any) {
        gates.push({
          id: 'G4_EXTRACTION_ACCURACY',
          passed: false,
          summary: `执行解包/抽取失败: ${err?.message || String(err)}`,
        });
      }
    }

    /* ---------- Helper to run full apply + optional repack + Consumer Simulator ---------- */
    const runRoundtripAndVerifyConsumer = async (
      mode: 'identity' | 'zh_writeback',
      targetEncoding: string
    ): Promise<{ ok: boolean; checkedCount: number; errors: string[] }> => {
      const gtBySource = new Map(task.groundTruth.map((g) => [g.source, g]));
      const expectedBySource = new Map<string, string>();
      for (const g of task.groundTruth) {
        expectedBySource.set(g.source, mode === 'identity' ? g.source : g.zhTranslation);
      }

      const stageGame = path.join(tmpEval, `game_${mode}`);
      copyTreeRecursive(gameAbsDir, stageGame);
      const env = {
        PAPERCUP_TARGET_ENCODING: targetEncoding,
        PAPERCUP_WORKSPACE: workspaceDir,
        PAPERCUP_PATCH_OPTIONS_JSON: '{}',
      };

      const buildPayloadRows = (rows: ExtractedRow[]) =>
        rows.map((r) => {
          const gt = gtBySource.get(r.source);
          let target = mode === 'identity' ? r.source : gt ? gt.zhTranslation : r.source;
          if (mode === 'zh_writeback' && targetEncoding === 'gbk') {
            target = normalizeGbkCompatText(target);
          }
          return {
            ...r.extra,
            id: r.id,
            file: r.file,
            line: r.line,
            kind: r.kind,
            source: r.source,
            track: r.kind === 'say' ? 'scenario' : 'ui',
            target,
            ok: true,
          };
        });

      if (task.expectedPipeline === 'direct') {
        const rows = extractedByBucket[0]?.rows ?? [];
        const jsonl = path.join(tmpEval, `apply_${mode}.jsonl`);
        fs.writeFileSync(jsonl, buildPayloadRows(rows).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        await runPythonScript(applyPy, [jsonl, stageGame], stageGame, undefined, undefined, env);
      } else {
        for (let i = 0; i < extractedByBucket.length; i++) {
          const bucket = extractedByBucket[i];
          const archRel = bucket.archiveRel!;
          const archInStage = path.join(stageGame, path.relative(task.gameRelDir, archRel));
          const unpDir = path.join(tmpEval, `wb_${mode}_${i}`);
          fs.mkdirSync(unpDir, { recursive: true });
          await runPythonScript(unpackPy, [archInStage, unpDir], unpDir);
          fs.writeFileSync(path.join(unpDir, SKILL_MANIFEST), '{}\n', 'utf8');

          const jsonl = path.join(tmpEval, `apply_${mode}_${i}.jsonl`);
          fs.writeFileSync(
            jsonl,
            buildPayloadRows(bucket.rows).map((r) => JSON.stringify(r)).join('\n') + '\n',
            'utf8'
          );
          await runPythonScript(applyPy, [jsonl, unpDir], unpDir, undefined, undefined, env);

          const repackedOut = path.join(tmpEval, `repacked_${mode}_${i}.bin`);
          await runPythonScript(repackPy, [unpDir, repackedOut], unpDir);
          if (!fs.existsSync(repackedOut) || fs.statSync(repackedOut).size === 0) {
            return { ok: false, checkedCount: 0, errors: [`repack.py 未产出有效封包: ${archRel}`] };
          }
          fs.copyFileSync(repackedOut, archInStage);
        }
      }

      return task.verifyConsumer({
        patchedGameDir: stageGame,
        appliedEncoding: targetEncoding,
        expectedBySource,
        mode,
      });
    };

    /* ---------- G5: Identity Roundtrip + Consumer Simulator ---------- */
    if (!canExecuteScripts || !gates[3].passed) {
      gates.push({
        id: 'G5_IDENTITY_ROUNDTRIP',
        passed: false,
        summary: '跳过：前置提取校验未通过',
      });
    } else {
      try {
        const res = await runRoundtripAndVerifyConsumer('identity', task.expectedSourceEncoding);
        gates.push({
          id: 'G5_IDENTITY_ROUNDTRIP',
          passed: res.ok,
          summary: res.ok
            ? `原样写回 + 消费端模拟 100% 通过（核验 ${res.checkedCount} 条）`
            : res.errors.slice(0, 4).join('；'),
          details: res as unknown as Record<string, unknown>,
        });
      } catch (err: any) {
        gates.push({
          id: 'G5_IDENTITY_ROUNDTRIP',
          passed: false,
          summary: `原样写回执行异常: ${err?.message || String(err)}`,
        });
      }
    }

    /* ---------- G6: Variable-Length Simplified Chinese Writeback + Consumer/VM Simulator ---------- */
    if (!canExecuteScripts || !gates[3].passed) {
      gates.push({
        id: 'G6_VARIABLE_LENGTH_ZH_WRITEBACK',
        passed: false,
        summary: '跳过：前置提取校验未通过',
      });
    } else {
      const zhEncoding = task.expectedSourceEncoding === 'cp932' ? 'gbk' : 'utf-8';
      try {
        const res = await runRoundtripAndVerifyConsumer('zh_writeback', zhEncoding);
        gates.push({
          id: 'G6_VARIABLE_LENGTH_ZH_WRITEBACK',
          passed: res.ok,
          summary: res.ok
            ? `变长简体中文写回 (${zhEncoding}) + 消费端/VM 模拟 100% 通过（核验 ${res.checkedCount} 条）`
            : res.errors.slice(0, 5).join('；'),
          details: { targetEncoding: zhEncoding, ...res },
        });
      } catch (err: any) {
        gates.push({
          id: 'G6_VARIABLE_LENGTH_ZH_WRITEBACK',
          passed: false,
          summary: `变长中文写回 (${zhEncoding}) 异常: ${err?.message || String(err)}`,
        });
      }
    }

    /* ---------- G7: Control Pattern & QA Contract ---------- */
    {
      const issues: string[] = [];
      const controlPattern =
        wbObj && typeof wbObj.control_pattern === 'string' ? wbObj.control_pattern.trim() : '';
      const qaProf: LocalizationProfile = {
        narrativePov: 'source',
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

      if (task.hasCustomControlTags) {
        if (!controlPattern) {
          issues.push('含自定义控制标签的题目必须在 engine.json writeback.control_pattern 中注册有效正则');
        } else {
          try {
            new RegExp(controlPattern);
          } catch {
            issues.push(`writeback.control_pattern 正则非法: ${controlPattern}`);
          }
        }
      }

      if (issues.length === 0) {
        const taggedEntries = task.groundTruth.filter((g) => /<[^>]+>|%[A-Za-z_]+%|%[0-9]*[diouxXs]/.test(g.source));
        for (const g of task.groundTruth) {
          const rep = qaReport(g.source, g.zhTranslation, qaProf, {}, { controlPattern: controlPattern || null });
          if (rep.blocked) {
            issues.push(
              `合法中文译文未通过 QA (${rep.findings.map((f) => `${f.rule}:${f.message}`).join(', ')}): ${g.source.slice(0, 40)}`
            );
            break;
          }
        }
        if (task.hasCustomControlTags && taggedEntries.length > 0 && issues.length === 0) {
          const sample = taggedEntries[0];
          const strippedTarget = sample.zhTranslation
            .replace(/<[^>]+>/g, '')
            .replace(/%[A-Za-z_]+%/g, '')
            .replace(/%[0-9]*[diouxXs]/g, '');
          const badRep = qaReport(sample.source, strippedTarget, qaProf, {}, { controlPattern });
          if (!badRep.findings.some((f) => f.rule === 'control.mismatch')) {
            issues.push(`已注册的 control_pattern (${controlPattern}) 未能拦截被删掉的自定义控制标签`);
          }
        }
      }

      gates.push({
        id: 'G7_CONTROL_PATTERN_QA',
        passed: issues.length === 0,
        summary:
          issues.length === 0
            ? task.hasCustomControlTags
              ? `自定义控制符正则 (${controlPattern}) 通过 QA 正/负向校验`
              : '全部中文译文通过确定性 QA 校验'
            : issues.join('；'),
        details: { controlPattern, issues },
      });
    }

    /* ---------- G8: Workspace Hygiene & Raster Asset Awareness ---------- */
    {
      const issues: string[] = [];
      const rootEntries = fs.readdirSync(workspaceDir, { withFileTypes: true }).map((e) => e.name);
      const strayFiles = rootEntries.filter(
        (n) => /^probe/i.test(n) || n.endsWith('.jsonl') || n.endsWith('.tmp')
      );
      if (strayFiles.length > 0) {
        issues.push(`工作区根目录遗留临时文件: ${strayFiles.join(', ')}`);
      }
      if (task.rasterAssetRelPaths && task.rasterAssetRelPaths.length > 0 && engineJson) {
        const sysObj =
          engineJson.system_text && typeof engineJson.system_text === 'object'
            ? (engineJson.system_text as Record<string, unknown>)
            : null;
        const rasterList = Array.isArray(sysObj?.raster_ui) ? sysObj.raster_ui.map(String).join(' ') : '';
        const skillText = fs.existsSync(skillMd) ? fs.readFileSync(skillMd, 'utf8') : '';
        const mentioned = task.rasterAssetRelPaths.some((r) => {
          const base = path.posix.basename(r);
          return rasterList.includes(base) || skillText.includes(base);
        });
        if (!mentioned) {
          issues.push(`未在 rasterUiAssets 或 SKILL.md 中记录图片型 UI 资产 (${task.rasterAssetRelPaths.join(', ')})`);
        }
      }
      gates.push({
        id: 'G8_HYGIENE_AND_SANDBOX',
        passed: issues.length === 0,
        summary:
          issues.length === 0
            ? '工作区整洁、无临时文件污染且栅格资产记录合规'
            : issues.join('；'),
        details: { issues },
      });
    }
  } finally {
    fs.rmSync(tmpEval, { recursive: true, force: true });
  }

  return gates;
}
