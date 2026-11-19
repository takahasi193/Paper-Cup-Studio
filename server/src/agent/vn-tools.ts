import { Type } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import {
  acceptVnRelease,
  applyVnTranslations,
  classifyVnScripts,
  detectVnEngines,
  getVnStatus,
  learnVnSkill,
  mergeVnBatches,
  planVnTranslation,
  promoteVnSkill,
  releaseVnPatch,
  repackVnArchives,
  runVnCheckpoint,
  unpackVnArchives,
  verifyVnQa,
  writebackVnCopy,
  type VnGateResult,
} from '../vn/core.js';
import {
  type BatchProgressEvent,
  runPostQaParallel,
  runTranslateBatches,
} from './batch-orchestrator.js';
import { redactSecrets } from '../security/secrets.js';
import type {
  SubagentManager,
  SubagentTaskUpdatedListener,
} from '../subagents/subagent-manager.js';

function mergeAbortSignals(a?: AbortSignal, b?: AbortSignal): { signal?: AbortSignal; cleanup: () => void } {
  if (!a && !b) return { signal: undefined, cleanup: () => {} };
  if (a && !b) return { signal: a, cleanup: () => {} };
  if (!a && b) return { signal: b, cleanup: () => {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a!.aborted || b!.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }
  a!.addEventListener('abort', onAbort, { once: true });
  b!.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      a!.removeEventListener('abort', onAbort);
      b!.removeEventListener('abort', onAbort);
    },
  };
}

interface FormattedVnResult {
  text: string;
  isError?: boolean;
}

async function executeVnTool<T>(
  cwd: string,
  fallbackText: string,
  action: (workspace: string, signal?: AbortSignal) => T | Promise<T>,
  format: (result: T) => FormattedVnResult,
  signal?: AbortSignal,
  extraSignal?: AbortSignal,
  getKnownSecrets?: () => Iterable<string>
) {
  const merged = mergeAbortSignals(signal, extraSignal);
  try {
    const result = await action(cwd, merged.signal);
    const formatted = format(result);
    const output = redactSecrets(formatted.text.trim() || fallbackText, getKnownSecrets?.());
    const isError = Boolean(formatted.isError);
    return {
      content: [{ type: 'text' as const, text: output }],
      details: { exitCode: isError ? 1 : 0 },
      ...(isError ? { isError: true } : {}),
    };
  } catch (err: any) {
    const output = redactSecrets(String(err?.message || err).trim() || fallbackText, getKnownSecrets?.());
    return {
      content: [{ type: 'text' as const, text: output }],
      details: { exitCode: 1 },
      isError: true,
    };
  } finally {
    merged.cleanup();
  }
}

function validationError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { exitCode: 1 },
    isError: true,
  };
}

export interface VnToolOptions {
  onSkillChanged?: () => void | Promise<void>;
  getTurnSignal?: () => AbortSignal | undefined;
  getKnownSecrets?: () => Iterable<string>;
  subagentManager?: SubagentManager;
  getModel?: () => any;
  getModelRuntime?: () => any;
  getSessionId?: () => string | null;
  shouldRecordDiagnostics?: () => boolean;
  onSubagentActivity?: (role: string, delta: string, callId?: string) => void;
  onBatchProgress?: (event: BatchProgressEvent) => void;
  onTaskUpdated?: SubagentTaskUpdatedListener;
}

export function createVnTools(cwdProvider: () => string, options?: VnToolOptions) {
  const runAction = <T>(
    fallbackText: string,
    action: (workspace: string, signal?: AbortSignal) => T | Promise<T>,
    format: (result: T) => FormattedVnResult,
    signal?: AbortSignal
  ) =>
    executeVnTool(
      cwdProvider(),
      fallbackText,
      action,
      format,
      signal,
      options?.getTurnSignal?.(),
      options?.getKnownSecrets
    );

  const runText = (
    fallbackText: string,
    action: (workspace: string, signal?: AbortSignal) => string | Promise<string>,
    signal?: AbortSignal
  ) => runAction(fallbackText, action, (text) => ({ text }), signal);

  const runGate = (
    fallbackText: string,
    action: (workspace: string, signal?: AbortSignal) => VnGateResult | Promise<VnGateResult>,
    signal?: AbortSignal
  ) => runAction(fallbackText, action, (res) => ({ text: res.text, isError: res.blocked }), signal);

  const vnDetectTool = defineTool({
    name: 'vn_detect',
    label: 'Detect VN Engine',
    description: 'Detect the visual novel engine and available archive unpack paths in the workspace.',
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, signal) =>
      runText('No engine detected.', (ws) => detectVnEngines(ws), signal),
  });

  const vnStatusTool = defineTool({
    name: 'vn_status',
    label: 'VN Status',
    description:
      'Call directly as a tool (never via bash): check localization profile readiness (source_lang, target_lang, narrative_pov), acceptance state, translated/expected segment progress, and remaining batch counts.',
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, signal) =>
      runText('Status check completed.', (ws) => getVnStatus(ws), signal),
  });

  const vnUnpackTool = defineTool({
    name: 'vn_unpack',
    label: 'VN Unpack',
    description: 'Unpack the visual novel game archive (.rpa, .xp3, .nsa, etc.) into unpacked/<archive>.',
    parameters: Type.Object({
      archive: Type.Optional(Type.String({ description: 'Optional specific archive filename to unpack' })),
      dest: Type.Optional(Type.String({ description: 'Optional destination directory inside workspace' })),
      engine: Type.Optional(Type.String({ description: 'Optional explicit engine identifier' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runText(
        'Unpack completed.',
        (ws, abortSig) =>
          unpackVnArchives(ws, { engine: params.engine, dest: params.dest, archive: params.archive }, abortSig),
        signal
      ),
  });

  const vnClassifyTool = defineTool({
    name: 'vn_classify',
    label: 'VN Classify Scripts',
    description:
      'Call directly as a tool (never via bash): classify unpacked script files into build/scenario.jsonl (dialogue) and build/ui.jsonl (system UI) and record totals in .papercup/vn/text.json.',
    parameters: Type.Object({
      unpacked: Type.Optional(Type.String({ description: 'Unpacked scripts directory path, default unpacked' })),
      out: Type.Optional(Type.String({ description: 'Output directory for classified files, default build' })),
      engine: Type.Optional(Type.String({ description: 'Optional explicit engine name for classify override lookup' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runText(
        'Classification completed.',
        (ws) => classifyVnScripts(ws, { unpacked: params.unpacked, out: params.out, engine: params.engine }),
        signal
      ),
  });

  const vnQaTool = defineTool({
    name: 'vn_qa',
    label: 'VN QA Verification',
    description:
      'Call directly as a tool (never via bash): run deterministic QA checks on visual novel translations. Provide either `pairs` (path to JSONL with {source, target} lines; full track files of any segment count are supported and return summary + up to 200 findings when >200 rows) OR both inline text strings `source` and `target`.',
    parameters: Type.Object({
      pairs: Type.Optional(Type.String({ description: 'Path to JSONL file containing {source, target} objects' })),
      source: Type.Optional(Type.String({ description: 'Inline Japanese/source text line (use with target, not pairs)' })),
      target: Type.Optional(Type.String({ description: 'Inline Chinese/target text line (use with source, not pairs)' })),
      json: Type.Optional(Type.Boolean({ description: 'Output machine-readable JSON report' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const hasPairs = typeof params.pairs === 'string' && params.pairs.trim() !== '';
      const hasInline = params.source !== undefined || params.target !== undefined;

      if (hasPairs && hasInline) {
        return validationError('vn_qa accepts either `pairs` OR `source`+`target`, not both.');
      }
      if (!hasPairs && (params.source === undefined || params.target === undefined)) {
        return validationError('vn_qa requires either `pairs` (JSONL path) OR both `source` and `target` strings.');
      }

      return runGate(
        'QA completed.',
        (ws) =>
          verifyVnQa(ws, {
            pairs: hasPairs ? params.pairs!.trim() : undefined,
            source: hasPairs ? undefined : params.source,
            target: hasPairs ? undefined : params.target,
            json: params.json,
          }),
        signal
      );
    },
  });

  const vnApplyTool = defineTool({
    name: 'vn_apply',
    label: 'VN Apply Translation',
    description:
      'Safely apply full-track translated JSONL results back into unpacked scripts with QA pre-checks, full-coverage gate against .papercup/vn/text.json, and .bak backups.',
    parameters: Type.Object({
      track: Type.String({ description: 'Track name: scenario or ui' }),
      input: Type.String({ description: 'Path to merged translation results JSONL file' }),
      root: Type.String({ description: 'Path to unpacked game directory (e.g. unpacked/<archive>)' }),
      scene: Type.Optional(Type.String({ description: 'Optional scene filter' })),
      encoding: Type.Optional(Type.String({ description: 'Optional explicit output encoding' })),
      json: Type.Optional(Type.Boolean({ description: 'Output machine-readable JSON summary' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runText(
        'Apply completed.',
        (ws) =>
          applyVnTranslations(ws, {
            track: params.track,
            input: params.input,
            root: params.root,
            scene: params.scene,
            encoding: params.encoding,
            json: params.json,
          }),
        signal
      ),
  });

  const vnRepackTool = defineTool({
    name: 'vn_repack',
    label: 'VN Repack Archive',
    description: 'Repack modified unpacked scripts into a new archive outside the workspace without overwriting original files.',
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: 'Unpacked source directory (e.g. unpacked/<archive>)' })),
      dest: Type.Optional(Type.String({ description: 'Optional export directory outside workspace' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'Preview target output path without writing files' })),
      force: Type.Optional(Type.Boolean({ description: 'Allow overwriting existing files in export destination' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runText(
        'Repack completed.',
        (ws, abortSig) =>
          repackVnArchives(
            ws,
            { source: params.source, dest: params.dest, dryRun: params.dryRun, force: params.force },
            abortSig
          ),
        signal
      ),
  });

  const vnAcceptTool = defineTool({
    name: 'vn_accept',
    label: 'VN Accept Release Gate',
    description:
      'Run final deterministic acceptance validation (including full-track coverage vs .papercup/vn/text.json) for a translated track and repacked archive before release. Supply `archive` plus either `track` + `input` (translator results JSONL) or `report`.',
    parameters: Type.Object({
      archive: Type.String({ description: 'Path to the newly repacked archive returned by vn_repack' }),
      track: Type.Optional(Type.String({ description: 'Track name (scenario or ui), paired with input' })),
      input: Type.Optional(Type.String({ description: 'Path to merged results JSONL file, paired with track' })),
      report: Type.Optional(Type.String({ description: 'Optional report JSON path from vn report (alternative to track + input)' })),
      allowNoResidueCheck: Type.Optional(Type.Boolean({ description: 'Explicitly override residue_check=false rejection if user confirmed' })),
      json: Type.Optional(Type.Boolean({ description: 'Output machine-readable JSON result' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const hasReport = typeof params.report === 'string' && params.report.trim() !== '';
      const hasTrackInput =
        typeof params.track === 'string' &&
        params.track.trim() !== '' &&
        typeof params.input === 'string' &&
        params.input.trim() !== '';

      if (!hasReport && !hasTrackInput) {
        return validationError('vn_accept requires `archive` together with either `report` or both `track` and `input`.');
      }

      return runGate(
        'Acceptance check completed.',
        (ws) =>
          acceptVnRelease(ws, {
            archive: params.archive,
            report: hasReport ? params.report!.trim() : undefined,
            track: hasReport ? undefined : params.track!.trim(),
            input: hasReport ? undefined : params.input!.trim(),
            allowNoResidueCheck: params.allowNoResidueCheck,
            json: params.json,
          }),
        signal
      );
    },
  });

  const vnReleaseTool = defineTool({
    name: 'vn_release',
    label: 'VN Release Notes & Gate',
    description: 'Verify all accepted tracks and generate final release notes for the localized visual novel patch.',
    parameters: Type.Object({
      track: Type.Optional(Type.String({ description: 'Optional single track degradation filter (scenario or ui)' })),
      note: Type.Optional(Type.String({ description: 'Optional release note text' })),
      out: Type.Optional(Type.String({ description: 'Optional release note file path inside workspace' })),
      overwrite: Type.Optional(Type.Boolean({ description: 'Allow overwriting an existing release note file' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'Preview release note without writing file' })),
      json: Type.Optional(Type.Boolean({ description: 'Output machine-readable JSON result' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runText(
        'Release completed.',
        (ws) =>
          releaseVnPatch(ws, {
            track: params.track,
            note: params.note,
            out: params.out,
            overwrite: params.overwrite,
            dryRun: params.dryRun,
            json: params.json,
          }),
        signal
      ),
  });

  const vnLearnSkillTool = defineTool({
    name: 'vn_learn_skill',
    label: 'Learn Engine Unpack & System-Text Skill',
    description:
      'Verify candidate unpack.py/repack.py (for unknown archives) OR unpackedDir analysis scripts (extract.py/apply.py/classify rules for unpacked builtin containers), run identity + 1-line _WB mutation writeback roundtrip checks, and package into .papercup/skills/engine-<engine>/ plus engine.json.',
    parameters: Type.Object({
      engine: Type.String({ description: 'Lowercase engine identifier (e.g. yuris, tyrano, kirikiri)' }),
      unpackScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to candidate unpack.py (<archive> <dest>) for unknown archives' })),
      repackScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to candidate repack.py (<src_dir> <dest_archive>) for unknown archives' })),
      unpackedDir: Type.Optional(Type.String({ description: 'Relative path inside workspace to already-unpacked directory (e.g. "unpacked") when packaging post-unpack system-text/classify/apply skill without custom unpack/repack scripts' })),
      extractScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to supplemental UI/system extractor extract.py (<unpacked_dir> <out_ui_jsonl>)' })),
      applyScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to custom apply.py (<results_jsonl> <unpacked_dir>) when built-in classifyProfile writeback is insufficient' })),
      encoding: Type.Optional(Type.String({ description: 'Script encoding declared for this engine (e.g. cp932, utf-8, utf-16le)' })),
      controlPattern: Type.Optional(Type.String({ description: 'Optional regex matching custom engine control tags' })),
      requireWriteback: Type.Optional(Type.Boolean({ description: 'Require identity + 1-line mutation writeback verification before saving ready skill (default true)' })),
      archive: Type.Optional(Type.String({ description: 'Relative path inside workspace to sample archive' })),
      suffix: Type.Optional(Type.String({ description: 'Optional archive extension matcher (e.g. .ypf)' })),
      magicHex: Type.Optional(Type.String({ description: 'Optional container magic header hex bytes (e.g. 59504600)' })),
      magicOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 4096, description: 'Optional byte offset for magicHex, default 0' })),
      classifyProfile: Type.Optional(
        Type.Union([Type.Literal('kag'), Type.Literal('renpy'), Type.Literal('plain')], {
          description: 'Optional built-in script classifier preset to bind in engine.json',
        })
      ),
      classifyExtensions: Type.Optional(
        Type.Array(Type.String(), { description: 'Optional script file extensions (e.g. [".txt"])' })
      ),
      classifyTags: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: 'Optional tag -> kind mapping merged into engine.json classify.tags (e.g. {"ptext":"system","tb_ptext_show":"system"})',
        })
      ),
      classifyTextAttrs: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Optional ordered text attribute names stored in engine.json classify.text_attrs',
        })
      ),
      systemTextFiles: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Discovered engine-level system/UI text sources recorded in SKILL.md and engine.json',
        })
      ),
      rasterUiAssets: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Discovered image-baked UI/menu assets (not text-translatable) recorded as non-blocking notice in SKILL.md',
        })
      ),
      note: Type.Optional(Type.String({ description: 'Concise format/system-text/evidence note saved in SKILL.md' })),
      overwrite: Type.Optional(Type.Boolean({ description: 'Overwrite existing project skill/profile for this engine' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'Verify and preview diff without writing files' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const engine = params.engine.trim();
      const unpackScript = params.unpackScript?.trim() || '';
      const repackScript = params.repackScript?.trim() || '';
      const unpackedDir = params.unpackedDir?.trim() || '';
      const hasPackers = Boolean(unpackScript || repackScript);
      if (!engine || (hasPackers && (!unpackScript || !repackScript)) || (!hasPackers && !unpackedDir)) {
        return validationError(
          'vn_learn_skill requires non-empty `engine` plus either both `unpackScript`+`repackScript` OR `unpackedDir`.'
        );
      }

      const res = await runAction(
        'Skill learning completed.',
        (ws, abortSig) =>
          learnVnSkill(
            ws,
            {
              engine,
              unpackScript: unpackScript || undefined,
              repackScript: repackScript || undefined,
              unpackedDir: unpackedDir || undefined,
              extractScript: params.extractScript?.trim() || undefined,
              applyScript: params.applyScript?.trim() || undefined,
              encoding: params.encoding?.trim() || undefined,
              controlPattern: params.controlPattern?.trim() || undefined,
              requireWriteback: params.requireWriteback !== false,
              archive: params.archive?.trim() || undefined,
              suffix: params.suffix?.trim() || undefined,
              magicHex: params.magicHex?.trim() || undefined,
              magicOffset: params.magicOffset,
              classifyProfile: params.classifyProfile,
              classifyExtensions: params.classifyExtensions?.map((ext) => ext.trim()).filter(Boolean),
              classifyTags: params.classifyTags,
              classifyTextAttrs: params.classifyTextAttrs?.map((a) => a.trim()).filter(Boolean),
              systemTextFiles: params.systemTextFiles?.map((s) => s.trim()).filter(Boolean),
              rasterUiAssets: params.rasterUiAssets?.map((s) => s.trim()).filter(Boolean),
              note: params.note?.trim() || undefined,
              overwrite: params.overwrite,
              dryRun: params.dryRun,
            },
            abortSig
          ),
        (outcome) => ({ text: outcome.summary, isError: outcome.status === 'diagnosed' }),
        signal
      );
      const output = res.content[0]?.text || '';
      const rejected = !params.dryRun && output.includes('未写入技能');
      const isError = Boolean(res.isError) || rejected;
      if (!isError && !params.dryRun) {
        await options?.onSkillChanged?.();
      }
      return {
        content: res.content,
        details: { ...(res.details ?? {}), engine, rejected },
        ...(isError ? { isError: true } : {}),
      };
    },
  });

  const vnPromoteSkillTool = defineTool({
    name: 'vn_promote_skill',
    label: 'Promote Engine Skill Globally',
    description:
      'Promote a verified project-level skill (e.g. engine-yuris) into the user global skill directory (~/.papercup/skills/) for reuse across workspaces.',
    parameters: Type.Object({
      skill: Type.String({ description: 'Project skill name to promote (e.g. engine-yuris)' }),
      overwrite: Type.Optional(Type.Boolean({ description: 'Allow overwriting an existing global skill with the same name' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'Preview diff without writing to global skills' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const skill = params.skill.trim();
      if (!skill) {
        return validationError('vn_promote_skill requires non-empty `skill` name (e.g. engine-yuris).');
      }
      const result = await runText(
        'Skill promotion completed.',
        (ws) => promoteVnSkill(ws, skill, { overwrite: params.overwrite, dryRun: params.dryRun }),
        signal
      );
      if (!result.isError && !params.dryRun) {
        await options?.onSkillChanged?.();
      }
      return result;
    },
  });

  const vnPlanTool = defineTool({
    name: 'vn_plan',
    label: 'VN Text Plan & Batch Split',
    description:
      'Analyze classified build/*.jsonl rows (counts, distributions, scene boundaries, per-model-family token estimates), save rational batch/session/concurrency limits in .papercup/vn/plan.json, and optionally split work/batches/batch_xxx.jsonl.',
    parameters: Type.Object({
      model: Type.Optional(Type.String({ description: 'Target translation model name for tokenizer family calibration' })),
      family: Type.Optional(Type.String({ description: 'Optional explicit model family (qwen/deepseek/gemini/claude/openai/generic)' })),
      batchMaxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: 'Max rows per batch (1..500)' })),
      batchMaxSourceTokens: Type.Optional(Type.Integer({ minimum: 100, description: 'Max estimated source tokens per batch (>=100)' })),
      sessionMaxSourceTokens: Type.Optional(Type.Integer({ minimum: 100, description: 'Max cumulative source tokens per translator session before automatic rotation (>= batchMaxSourceTokens)' })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: 'Concurrent translator worker lanes (1..16)' })),
      marginRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5, description: 'Safety margin ratio, default 0.10' })),
      generateBatches: Type.Optional(Type.Boolean({ description: 'Save plan config and generate boundary-aware work/batches/batch_xxx.jsonl + manifest.json' })),
      force: Type.Optional(Type.Boolean({ description: 'Allow overwriting/regenerating batches when work/out already contains outputs' })),
      note: Type.Optional(Type.String({ description: 'Adjustment note recorded in .papercup/vn/plan.json config_history' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const res = await runAction(
        'Plan analysis completed.',
        (ws) =>
          planVnTranslation(ws, {
            model: params.model,
            family: params.family,
            batchMaxLines: params.batchMaxLines,
            batchMaxSourceTokens: params.batchMaxSourceTokens,
            sessionMaxSourceTokens: params.sessionMaxSourceTokens,
            concurrency: params.concurrency,
            marginRatio: params.marginRatio,
            generateBatches: params.generateBatches,
            force: params.force,
            note: params.note,
          }),
        (payload) => ({ text: JSON.stringify(payload, null, 2) }),
        signal
      );
      if (!res.isError && params.generateBatches) {
        options?.onBatchProgress?.({
          type: 'plan',
          summary: 'Generated batch manifest',
          timestamp: new Date().toISOString(),
        });
      }
      return res;
    },
  });

  const vnCheckpointTool = defineTool({
    name: 'vn_checkpoint',
    label: 'VN Local Git Checkpoint',
    description:
      'Manage isolated local Git checkpoints inside the game workspace (never adds remotes/pushes, ignores archives & secrets). Commits mark [saved/pending-qa] vs [qa-verified].',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('init'),
        Type.Literal('save'),
        Type.Literal('list'),
        Type.Literal('rollback'),
      ]),
      stage: Type.Optional(Type.String({ description: 'Stage name for save (e.g. classify, batch, qa, pre-writeback)' })),
      summary: Type.Optional(Type.String({ description: 'Short summary note for checkpoint commit' })),
      qaVerified: Type.Optional(Type.Boolean({ description: 'Set true ONLY after full deterministic + semantic QA passed' })),
      commit: Type.Optional(Type.String({ description: 'Target commit ref for rollback' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      let checkpointPayload: Record<string, unknown> | null = null;
      const res = await runAction(
        'Checkpoint operation completed.',
        async (ws) => {
          checkpointPayload = await runVnCheckpoint(ws, {
            action: params.action,
            stage: params.stage,
            summary: params.summary,
            qaVerified: params.qaVerified,
            commit: params.commit,
          });
          return checkpointPayload;
        },
        (payload) => ({ text: JSON.stringify(payload, null, 2) }),
        signal
      );
      if (!res.isError && params.action === 'save' && checkpointPayload) {
        const parsed = checkpointPayload as Record<string, any>;
        options?.onBatchProgress?.({
          type: 'checkpoint',
          commit: parsed.commit ? String(parsed.commit) : undefined,
          summary: parsed.summary ? String(parsed.summary) : params.summary,
          status: parsed.qa_verified ? 'qa_verified' : 'saved_pending_qa',
          timestamp: new Date().toISOString(),
        });
      }
      return res;
    },
  });

  const vnMergeTool = defineTool({
    name: 'vn_merge',
    label: 'VN Merge Batches & Run Deterministic QA',
    description:
      'Merge work/out/batch_*.jsonl in deterministic order into results/scenario.jsonl and results/ui.jsonl, computing genuine qa_report ok/findings per row and updating .papercup/vn/progress.json.',
    parameters: Type.Object({
      track: Type.Optional(Type.String({ description: 'Optional track filter (scenario or ui)' })),
      allowPartial: Type.Optional(Type.Boolean({ description: 'Allow merging before all batches are present (blocked at final writeback/release)' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runAction(
        'Merge completed.',
        (ws) => mergeVnBatches(ws, { track: params.track, allowPartial: params.allowPartial }),
        (payload) => ({ text: JSON.stringify(payload, null, 2), isError: !payload.ok }),
        signal
      ),
  });

  const vnWritebackTool = defineTool({
    name: 'vn_writeback',
    label: 'VN Export & Writeback Independent Game Copy',
    description:
      'Write full QA-verified results/<track>.jsonl back into an isolated staging copy and export a clean repacked game copy OUTSIDE the workspace (<ws>.translated-.../ or dest), leaving original archives and workspace/unpacked/ unmodified.',
    parameters: Type.Object({
      dest: Type.Optional(Type.String({ description: 'Optional destination directory outside workspace (auto-generated sibling dir if omitted)' })),
      unpacked: Type.Optional(Type.String({ description: 'Optional unpacked dir path inside workspace' })),
      encoding: Type.Optional(Type.String({ description: 'Optional writeback encoding override' })),
      force: Type.Optional(Type.Boolean({ description: 'Allow writing into non-empty external destination directory' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const res = await runAction(
        'Independent game copy writeback completed.',
        (ws, abortSig) =>
          writebackVnCopy(
            ws,
            {
              dest: params.dest?.trim(),
              unpacked: params.unpacked?.trim(),
              encoding: params.encoding?.trim(),
              force: params.force,
            },
            abortSig
          ),
        (payload) => ({ text: JSON.stringify(payload, null, 2) }),
        signal
      );
      if (!res.isError) {
        options?.onBatchProgress?.({
          type: 'writeback',
          summary: 'Exported independent game copy',
          timestamp: new Date().toISOString(),
        });
      }
      return res;
    },
  });

  const vnTranslateBatchesTool = defineTool({
    name: 'vn_translate_batches',
    label: 'VN Programmatic Batch Translation Orchestrator',
    description:
      'Programmatically translate pending batches from work/batches/manifest.json via isolated translator subagent sessions, enforcing per-session token caps with auto session rotation, strict lightweight validation + direct persistence into work/out/batch_xxx.jsonl, and periodic local Git checkpoints. Returns ONLY concise status metrics — never prints raw JSONL lines to main agent.',
    parameters: Type.Object({
      batchIds: Type.Optional(Type.Array(Type.String(), { description: 'Optional explicit batch IDs (e.g. ["batch_000"]); omit to translate all pending batches' })),
      startBatch: Type.Optional(Type.String({ description: 'Optional inclusive start batch ID' })),
      endBatch: Type.Optional(Type.String({ description: 'Optional inclusive end batch ID' })),
      track: Type.Optional(Type.String({ description: 'Optional track filter: scenario or ui' })),
      includeFailed: Type.Optional(Type.Boolean({ description: 'Re-run batches marked qa_failed' })),
      force: Type.Optional(Type.Boolean({ description: 'Re-translate even if already checked in to work/out' })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: 'Concurrent translator worker lanes (defaults to plan.json concurrency)' })),
      sessionMaxSourceTokens: Type.Optional(Type.Integer({ minimum: 100, description: 'Override per-session cumulative source token cap before rotating to a fresh session' })),
      glossary: Type.Optional(Type.String({ description: 'Optional concise glossary override' })),
      personaSummary: Type.Optional(Type.String({ description: 'Optional concise persona override' })),
      contextSummary: Type.Optional(Type.String({ description: 'Short story/style cue injected into translator sessions' })),
      checkpointInterval: Type.Optional(Type.Integer({ minimum: 0, description: 'Save local Git [saved/pending-qa] checkpoint every N batches (default 10, 0 disables)' })),
    }),
    execute: async (toolCallId, params, signal) => {
      if (!options?.subagentManager) {
        return validationError('vn_translate_batches requires subagentManager runtime context.');
      }
      const merged = mergeAbortSignals(signal, options.getTurnSignal?.());
      try {
        const summary = await runTranslateBatches(
          {
            cwd: cwdProvider(),
            subagentManager: options.subagentManager,
            model: options.getModel?.(),
            modelRuntime: options.getModelRuntime?.(),
            signal: merged.signal,
            sessionId: options.getSessionId?.() ?? null,
            parentCallId: toolCallId,
            recordDiagnostics: options.shouldRecordDiagnostics?.() ?? false,
            getKnownSecrets: options.getKnownSecrets,
            onDelta: (role, delta) => options.onSubagentActivity?.(role, delta, toolCallId),
            onBatchProgress: options.onBatchProgress,
            onTaskUpdated: options.onTaskUpdated,
          },
          params
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
          details: { exitCode: summary.ok ? 0 : 1, ...summary },
          ...(summary.ok ? {} : { isError: true }),
        };
      } catch (err: any) {
        const safeErr = redactSecrets(String(err?.message || err), options.getKnownSecrets?.());
        return {
          content: [{ type: 'text' as const, text: safeErr }],
          details: { exitCode: 1, error: safeErr },
          isError: true,
        };
      } finally {
        merged.cleanup();
      }
    },
  });

  const vnPostQaParallelTool = defineTool({
    name: 'vn_post_qa_parallel',
    label: 'VN Post-Translation Merge, Deterministic QA & Parallel Role Check',
    description:
      'Merge all checked-in batches into results/<track>.jsonl with genuine deterministic qa_report results, then run parallel role-checker semantic reviews with incremental chunk persistence (.papercup/vn/post_qa_state.json) and fatal quota circuit-breaking. Re-running resumes ONLY unfinished/changed chunks cleanly.',
    parameters: Type.Object({
      track: Type.Optional(Type.String({ description: 'Optional track filter: scenario or ui' })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: 'Concurrent role-checker workers (defaults to plan.json concurrency)' })),
      batchMaxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'Lines per role-checker review chunk (default 60)' })),
      skipRoleChecker: Type.Optional(
        Type.Boolean({
          description:
            'Run deterministic merge + qa_report only without launching new LLM role-checker calls (reuses cached chunk reviews). Never use this to bypass pending/interrupted semantic QA unless explicitly instructed by user.',
        })
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      if (!options?.subagentManager) {
        return validationError('vn_post_qa_parallel requires subagentManager runtime context.');
      }
      const merged = mergeAbortSignals(signal, options.getTurnSignal?.());
      try {
        const summary = await runPostQaParallel(
          {
            cwd: cwdProvider(),
            subagentManager: options.subagentManager,
            model: options.getModel?.(),
            modelRuntime: options.getModelRuntime?.(),
            signal: merged.signal,
            sessionId: options.getSessionId?.() ?? null,
            parentCallId: toolCallId,
            recordDiagnostics: options.shouldRecordDiagnostics?.() ?? false,
            getKnownSecrets: options.getKnownSecrets,
            onDelta: (role, delta) => options.onSubagentActivity?.(role, delta, toolCallId),
            onBatchProgress: options.onBatchProgress,
            onTaskUpdated: options.onTaskUpdated,
          },
          params
        );
        const hasSubagentFailure = Boolean(summary.interrupted || summary.roleCheckerErrors > 0);
        const resumeHint = hasSubagentFailure
          ? 'role-checker interrupted/errored; completed chunks are persisted in .papercup/vn/post_qa_state.json. Report interruption & progress upward first, then re-run vn_post_qa_parallel (without skipRoleChecker=true) to resume remaining chunks — do NOT manually replace role-checker.'
          : params.skipRoleChecker && (summary.roleCheckerPendingChunks ?? 0) > 0
            ? `Semantic QA still has ${summary.roleCheckerPendingChunks} pending chunks; run vn_post_qa_parallel without skipRoleChecker=true before writeback/release.`
            : undefined;
        const payload = resumeHint ? { ...summary, resumeHint } : summary;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          details: { exitCode: summary.ok ? 0 : 1, ...payload },
          ...(hasSubagentFailure ? { isError: true } : summary.ok ? {} : { isError: false }),
        };
      } catch (err: any) {
        const safeErr = redactSecrets(String(err?.message || err), options.getKnownSecrets?.());
        return {
          content: [{ type: 'text' as const, text: safeErr }],
          details: { exitCode: 1, error: safeErr, interrupted: Boolean(merged.signal?.aborted) },
          isError: true,
        };
      } finally {
        merged.cleanup();
      }
    },
  });

  return [
    vnDetectTool,
    vnStatusTool,
    vnUnpackTool,
    vnClassifyTool,
    vnPlanTool,
    vnTranslateBatchesTool,
    vnPostQaParallelTool,
    vnMergeTool,
    vnCheckpointTool,
    vnWritebackTool,
    vnQaTool,
    vnApplyTool,
    vnRepackTool,
    vnAcceptTool,
    vnReleaseTool,
    vnLearnSkillTool,
    vnPromoteSkillTool,
  ];
}
