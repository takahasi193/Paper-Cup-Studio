import { Type } from '@sinclair/typebox';
import type { Usage } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_CLOUD_CONCURRENCY,
  DEFAULT_POST_QA_CHUNK_LINES,
  MAX_CLOUD_CONCURRENCY,
} from '../vn/classify.js';
import {
  acceptVnRelease,
  applyVnTranslations,
  classifyVnScripts,
  detectVnEngines,
  extractVnRoster,
  getVnStatus,
  learnVnSkill,
  mergeVnBatches,
  planVnTranslation,
  promoteVnSkill,
  releaseVnPatch,
  repackVnArchives,
  requestVnCharacterConfirmation,
  runVnCheckpoint,
  runVnSmokeTest,
  unpackVnArchives,
  verifyVnQa,
  writebackVnCopy,
  type VnGateResult,
} from '../vn/core.js';
import type { ChatFormRecord } from '../vn/roster.js';
import type { SmokeExecutionDriver } from '../vn/smoke.js';
import {
  type BatchProgressEvent,
  runPostQaParallel,
  runTranslateBatches,
} from './batch-orchestrator.js';
import { createSmokeVisionBridge } from './smoke-vision.js';
import type {
  LocalTranslatorConfig,
  LocalUsageDelta,
  PublicLocalTranslatorConfig,
} from './local-translator.js';
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
  getTranslatorConfig?: () => LocalTranslatorConfig;
  getPublicTranslatorConfig?: () => PublicLocalTranslatorConfig;
  localTranslatorFetch?: typeof fetch;
  onLocalUsage?: (delta: LocalUsageDelta) => void;
  ensureLocalEndpointReady?: (cfg: LocalTranslatorConfig) => Promise<void>;
  smokeDriver?: SmokeExecutionDriver;
  onVisionUsage?: (provider: string, modelId: string, usage: Usage) => void;
  onChatFormUpdated?: (form: ChatFormRecord) => void;
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
    description: 'Unpack the visual novel game archive (.rpa, .xp3, .nsa, etc.) into .papercup/tmp/unpacked/<archive>.',
    parameters: Type.Object({
      archive: Type.Optional(Type.String({ description: 'Optional specific archive filename to unpack' })),
      dest: Type.Optional(Type.String({ description: 'Optional destination directory inside workspace' })),
      engine: Type.Optional(
        Type.String({
          description:
            'Optional explicit engine identifier (e.g. kirikiri, renpy, nscripter, or custom skill name — NOT archive kind like xp3/rpa)',
        })
      ),
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
      'Call directly as a tool (never via bash): classify unpacked script files into .papercup/data/build/scenario.jsonl (dialogue) and .papercup/data/build/ui.jsonl (system UI) and record totals in .papercup/data/vn/text.json.',
    parameters: Type.Object({
      unpacked: Type.Optional(Type.String({ description: 'Unpacked scripts directory path, default .papercup/tmp/unpacked' })),
      out: Type.Optional(Type.String({ description: 'Output directory for classified files, default .papercup/data/build' })),
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
      'Safely apply full-track translated JSONL results back into unpacked scripts with QA pre-checks, full-coverage gate against .papercup/data/vn/text.json, and .bak backups.',
    parameters: Type.Object({
      track: Type.String({ description: 'Track name: scenario or ui' }),
      input: Type.String({ description: 'Path to merged translation results JSONL file' }),
      root: Type.String({ description: 'Path to unpacked game directory (e.g. .papercup/tmp/unpacked/<archive>)' }),
      scene: Type.Optional(Type.String({ description: 'Optional scene filter' })),
      allowPartial: Type.Optional(
        Type.Boolean({ description: 'Explicitly allow partial track writeback (blocked at final release)' })
      ),
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
            allowPartial: params.allowPartial,
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
      source: Type.Optional(Type.String({ description: 'Unpacked source directory (e.g. .papercup/tmp/unpacked/<archive>)' })),
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
      'Run final deterministic acceptance validation (including full-track coverage vs .papercup/data/vn/text.json) for a translated track and patch bundle (`patch_manifest.json` from vn_writeback, verifying all artifact SHA-256 & byte lengths) or single repacked archive before release. Supply `archive` plus either `track` + `input` (translator results JSONL) or `report`.',
    parameters: Type.Object({
      archive: Type.String({
        description:
          'Path to `patch_manifest.json` (recommended, returned as manifest_path by vn_writeback) or a single repacked archive file',
      }),
      track: Type.Optional(Type.String({ description: 'Track name (scenario or ui), paired with input' })),
      input: Type.Optional(Type.String({ description: 'Path to merged results JSONL file, paired with track' })),
      report: Type.Optional(Type.String({ description: 'Optional report JSON path from vn report (alternative to track + input)' })),
      allowNoResidueCheck: Type.Optional(Type.Boolean({ description: 'Explicitly override residue_check=false rejection if user confirmed' })),
      allowSkipSmoke: Type.Optional(
        Type.Boolean({
          description:
            'Explicitly skip runtime smoke-test gate when enabled (only use if user approved skipping for DRM/special titles)',
        })
      ),
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
            allowSkipSmoke: params.allowSkipSmoke,
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
      claimHumanReviewed: Type.Optional(
        Type.String({
          description: 'Optional relative path inside workspace to a human proofreading/review disclosure file (<= 32 KiB)',
        })
      ),
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
            claimHumanReviewed: params.claimHumanReviewed,
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
      'Verify candidate unpack.py/repack.py (for unknown archives or failed/protected builtin variants, setting override_builtin=true) OR unpackedDir analysis/direct scripts (extract.py/apply.py for unpacked containers or direct single-file scripts like .ain), run identity + per-format variable-length target-mutation & extract.py readback roundtrip checks, enforce scenario-coverage completeness (rejecting full-extraction skills with >=30 rows and near-zero `say` dialogue unless confirmLowScenarioCoverage=true), and package into .papercup/skills/engine-<engine>/ plus harness engine.json. For >64 MiB real `archive` files, also pass `sampleArchive` (<=64 MiB workspace subset with identical extension & magic bytes at magicOffset). Note: extract.py JSONL rows must contain id, file, positive integer line (not offset), kind (say/system/choice/name/button/menu; scenario/ui accepted as aliases), and non-empty single-line source; apply.py MUST write row["target"] (falling back to source only if target is absent).',
    parameters: Type.Object({
      engine: Type.String({ description: 'Lowercase engine identifier (e.g. yuris, tyrano, sys42)' }),
      pipeline: Type.Optional(
        Type.Union([Type.Literal('skill'), Type.Literal('builtin'), Type.Literal('direct')], {
          description: 'Optional skill pipeline mode: skill (unpack/repack), builtin (post-unpack analysis), or direct (single-file extract/apply without outer archive)',
        })
      ),
      unpackScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to candidate unpack.py (<archive> <dest>) for unknown archives' })),
      repackScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to candidate repack.py (<src_dir> <dest_archive>) for unknown archives' })),
      unpackedDir: Type.Optional(Type.String({ description: 'Relative path inside workspace to already-unpacked directory (e.g. ".papercup/tmp/unpacked") or game script directory (for pipeline="direct")' })),
      extractScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to extractor extract.py (<dir> <out_jsonl>); each JSONL line requires id, file, line>=1, kind, non-empty single-line source' })),
      applyScript: Type.Optional(Type.String({ description: 'Relative path inside workspace to custom apply.py (<results_jsonl> <dir>)' })),
      encoding: Type.Optional(Type.String({ description: 'Script encoding declared for this engine (e.g. cp932, utf-8, utf-16le)' })),
      customEncodings: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Optional custom codec names handled by this skill apply.py (e.g. ["pal-charset"]); written into engine.json custom_encodings so vn_writeback passes PAPERCUP_TARGET_ENCODING/PAPERCUP_WORKSPACE/PAPERCUP_PATCH_OPTIONS_JSON cleanly',
        })
      ),
      controlPattern: Type.Optional(Type.String({ description: 'Optional regex matching custom engine control tags' })),
      requireWriteback: Type.Optional(Type.Boolean({ description: 'Require identity + randomized target-mutation & readback writeback verification before saving ready skill (default true)' })),
      confirmLowScenarioCoverage: Type.Optional(
        Type.Boolean({
          description:
            'Explicitly confirm that the target game/sample genuinely contains very few or zero scenario dialogue (`say`) rows after auditing binary sections/runtime loaders (default false; required only when total>=30 and `say` is 0 or <10 & <5%)',
        })
      ),
      archive: Type.Optional(Type.String({ description: 'Relative path inside workspace to the real original game archive (never inside .papercup/tmp/ or backup dirs)' })),
      sampleArchive: Type.Optional(
        Type.String({
          description:
            'Optional relative path inside workspace to a <= 64 MiB subset archive with identical extension and magic bytes at magicOffset, used for roundtrip verification when real `archive` exceeds 64 MiB',
        })
      ),
      suffix: Type.Optional(Type.String({ description: 'Optional archive extension matcher (e.g. .ypf)' })),
      magicHex: Type.Optional(Type.String({ description: 'Optional container magic header hex bytes (e.g. 59504600)' })),
      magicOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 4096, description: 'Optional byte offset for magicHex, default 0' })),
      classifyProfile: Type.Optional(
        Type.Union([Type.Literal('kag'), Type.Literal('renpy'), Type.Literal('plain')], {
          description: 'Optional built-in script classifier preset to bind in engine.json',
        })
      ),
      classifyExtensions: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Optional plain-text script extensions for built-in classifier (e.g. [".ks", ".txt"]); omit binary extensions like .bin/.ain/.dat when extractScript handles extraction',
        })
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

      let outcomeStatus = '';
      const res = await runAction(
        'Skill learning completed.',
        async (ws, abortSig) => {
          const outcome = await learnVnSkill(
            ws,
            {
              engine,
              pipeline: params.pipeline,
              unpackScript: unpackScript || undefined,
              repackScript: repackScript || undefined,
              unpackedDir: unpackedDir || undefined,
              extractScript: params.extractScript?.trim() || undefined,
              applyScript: params.applyScript?.trim() || undefined,
              encoding: params.encoding?.trim() || undefined,
              customEncodings: params.customEncodings?.map((e) => e.trim()).filter(Boolean),
              controlPattern: params.controlPattern?.trim() || undefined,
              requireWriteback: params.requireWriteback !== false,
              confirmLowScenarioCoverage: Boolean(params.confirmLowScenarioCoverage),
              archive: params.archive?.trim() || undefined,
              sampleArchive: params.sampleArchive?.trim() || undefined,
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
          );
          outcomeStatus = outcome.status;
          return outcome;
        },
        (outcome) => ({ text: outcome.summary, isError: outcome.status === 'diagnosed' }),
        signal
      );
      const rejected = !params.dryRun && (Boolean(res.isError) || outcomeStatus !== 'adopted');
      const isError = Boolean(res.isError) || rejected;
      if (!isError && !params.dryRun) {
        await options?.onSkillChanged?.();
      }
      return {
        content: res.content,
        details: { ...(res.details ?? {}), engine, status: outcomeStatus || (isError ? 'diagnosed' : 'adopted'), rejected },
        ...(isError ? { isError: true } : {}),
      };
    },
  });

  const vnPromoteSkillTool = defineTool({
    name: 'vn_promote_skill',
    label: 'Promote or Export Sanitized Engine Skill',
    description:
      'Sanitize (strip direct_root/source-sample/local paths & recompute SHA-256 digests) and promote a verified project-level skill into ~/.papercup/skills/ as a self-contained package, or export a clean PR-ready skill package to `exportDir`.',
    parameters: Type.Object({
      skill: Type.String({ description: 'Project skill name to promote or export (e.g. engine-nexas-pacf)' }),
      overwrite: Type.Optional(Type.Boolean({ description: 'Allow overwriting an existing destination skill with the same name' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'Preview sanitized export without writing files' })),
      exportDir: Type.Optional(
        Type.String({
          description: 'Optional destination directory to export a clean PR-ready self-contained skill package instead of writing to ~/.papercup/skills/',
        })
      ),
      includeTestFixture: Type.Optional(
        Type.Boolean({ description: 'Include test_fixture.py when present in the source skill directory (default true)' })
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const skill = params.skill.trim();
      if (!skill) {
        return validationError('vn_promote_skill requires non-empty `skill` name (e.g. engine-nexas-pacf).');
      }
      const result = await runText(
        'Skill promotion completed.',
        (ws) =>
          promoteVnSkill(ws, skill, {
            overwrite: params.overwrite,
            dryRun: params.dryRun,
            exportDir: params.exportDir?.trim() || undefined,
            includeTestFixture: params.includeTestFixture,
          }),
        signal
      );
      if (!result.isError && !params.dryRun && !params.exportDir?.trim()) {
        await options?.onSkillChanged?.();
      }
      return result;
    },
  });

  const vnPlanTool = defineTool({
    name: 'vn_plan',
    label: 'VN Text Plan & Batch Split',
    description:
      'Analyze classified .papercup/data/build/*.jsonl rows (counts, distributions, scene boundaries, per-model-family token estimates), save rational batch/session/concurrency limits in .papercup/data/vn/plan.json, and optionally split .papercup/tmp/work/batches/batch_xxx.jsonl.',
    parameters: Type.Object({
      model: Type.Optional(Type.String({ description: 'Target translation model name for tokenizer family calibration' })),
      family: Type.Optional(Type.String({ description: 'Optional explicit model family (qwen/deepseek/gemini/claude/openai/generic)' })),
      batchMaxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: 'Max rows per batch (1..500)' })),
      batchMaxSourceTokens: Type.Optional(Type.Integer({ minimum: 100, description: 'Max estimated source tokens per batch (>=100)' })),
      sessionMaxSourceTokens: Type.Optional(Type.Integer({ minimum: 100, description: 'Max cumulative source tokens per translator session before automatic rotation (>= batchMaxSourceTokens)' })),
      concurrency: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_CLOUD_CONCURRENCY,
          description: `Concurrent translator worker lanes (1..${MAX_CLOUD_CONCURRENCY}, cloud default ${DEFAULT_CLOUD_CONCURRENCY})`,
        })
      ),
      marginRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5, description: 'Safety margin ratio, default 0.10' })),
      generateBatches: Type.Optional(Type.Boolean({ description: 'Save plan config and generate boundary-aware .papercup/tmp/work/batches/batch_xxx.jsonl + manifest.json' })),
      force: Type.Optional(Type.Boolean({ description: 'Allow overwriting/regenerating batches when .papercup/tmp/work/out already contains outputs' })),
      note: Type.Optional(Type.String({ description: 'Adjustment note recorded in .papercup/data/vn/plan.json config_history' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      if (
        params.batchMaxSourceTokens !== undefined &&
        params.sessionMaxSourceTokens !== undefined &&
        params.sessionMaxSourceTokens < params.batchMaxSourceTokens
      ) {
        return validationError('vn_plan requires sessionMaxSourceTokens >= batchMaxSourceTokens.');
      }
      const res = await runAction(
        'Plan analysis completed.',
        (ws) => {
          const pubCfg = options?.getPublicTranslatorConfig?.();
          return planVnTranslation(ws, {
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
            ...(pubCfg
              ? {
                  translatorConfig: {
                    mode: pubCfg.mode,
                    model: pubCfg.model,
                    preset: pubCfg.preset,
                    packetLines: pubCfg.packetLines,
                    concurrency: pubCfg.concurrency,
                  },
                }
              : {}),
          });
        },
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
      'Merge .papercup/tmp/work/out/batch_*.jsonl in deterministic order into .papercup/data/results/scenario.jsonl and .papercup/data/results/ui.jsonl, computing genuine qa_report ok/findings per row and updating .papercup/data/vn/progress.json.',
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
    label: 'VN Build Delta Patch Bundle',
    description:
      'Write full QA-verified .papercup/data/results/<track>.jsonl into an isolated staging copy and assemble a lightweight, re-assemblable delta patch bundle inside <workspace>/patch/ by default (safe in-place overwrite after validation passes, or external export via explicit dest) containing only changed artifacts under files/, patch_manifest.json, sources/<track>.jsonl, one-click install_patch.bat/uninstall_patch.bat (defaulting to parent game dir ..), README.md, and optional papercup_patch.ini, while syncing <workspace>/补丁说明.md. Original game files and .papercup/tmp/unpacked/ remain untouched.',
    parameters: Type.Object({
      dest: Type.Optional(
        Type.String({ description: 'Optional patch output directory outside workspace (defaults to built-in <workspace>/patch/ with safe in-place update)' })
      ),
      unpacked: Type.Optional(Type.String({ description: 'Optional unpacked dir path inside workspace (defaults to .papercup/tmp/unpacked)' })),
      encoding: Type.Optional(
        Type.String({
          description:
            'Optional patch encoding override (builtin: gbk, utf-8, utf-8-bom, utf-16le, utf-16le-bom, cp932; skill apply.py also supports custom:<name> or codecs declared in engine.json custom_encodings); defaults to engine-tiered auto strategy or [vn.patch]',
        })
      ),
      force: Type.Optional(Type.Boolean({ description: 'Allow writing into non-empty external destination directory (built-in patch/ always updates safely in place after validation)' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const res = await runAction(
        'Delta patch bundle built.',
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
          summary: 'Built delta localization patch bundle',
          timestamp: new Date().toISOString(),
        });
      }
      return res;
    },
  });

  const vnSmokeTestTool = defineTool({
    name: 'vn_smoke_test',
    label: 'VN Runtime Patch Smoke Test',
    description:
      'Run a controlled, ESLint-style runtime smoke test of a delta patch bundle (patchManifest), an external overlay directory / single replacement file (overlayPath + optional overlayTarget), OR a one-click pre-translation 1-line custom-skill probe (preTranslateProbe=true, which deterministically modifies 1 row in an isolated temp staging copy, runs apply/repack without touching data/results or tmp/unpacked, tests the real game in an NTFS hardlink sandbox, and unlocks vn_translate_batches). Writes .papercup/data/vn/smoke/report.json (and pre-translate.json when preTranslateProbe=true). Never use bash to launch game executables directly.',
    parameters: Type.Object({
      patchManifest: Type.Optional(
        Type.String({
          description:
            'Path to patch_manifest.json returned by vn_writeback (defaults to the latest vn_writeback bundle when overlayPath and preTranslateProbe are omitted)',
        })
      ),
      overlayPath: Type.Optional(
        Type.String({
          description:
            'Optional external overlay directory (mirrored relative to game root) or single replacement archive/file to smoke test without patch_manifest.json; mutually exclusive with patchManifest and preTranslateProbe',
        })
      ),
      overlayTarget: Type.Optional(
        Type.String({
          description:
            'Relative path inside game directory when overlayPath is a single file (e.g. "game/data.pac"; auto-inferred when unique in vn_detect) or optional subdir prefix when overlayPath is a directory',
        })
      ),
      preTranslateProbe: Type.Optional(
        Type.Boolean({
          description:
            'One-click pre-translation 1-line micro-edit smoke probe for custom reverse-engineered skills (mutually exclusive with patchManifest and overlayPath). Must pass before vn_translate_batches when smoke gating is enabled.',
        })
      ),
      exe: Type.Optional(Type.String({ description: 'Optional relative path to game executable inside workspace' })),
      advanceSteps: Type.Optional(Type.Number({ description: 'Optional dialogue advance steps (3..100, default from settings)' })),
      timeoutSec: Type.Optional(Type.Number({ description: 'Optional hard timeout in seconds (15..300, default from settings)' })),
      useLocaleEmulator: Type.Optional(Type.Boolean({ description: 'Override whether to launch via configured LEProc.exe' })),
      skipVision: Type.Optional(Type.Boolean({ description: 'Skip cloud multimodal vision inspection for this run' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const visionBridge =
        !params.skipVision && options?.getModel && options?.getModelRuntime
          ? createSmokeVisionBridge({
              getModel: options.getModel,
              getModelRuntime: options.getModelRuntime,
              onUsage: options.onVisionUsage,
            })
          : undefined;
      const res = await runAction(
        'Runtime smoke test finished.',
        (ws, abortSig) =>
          runVnSmokeTest(
            ws,
            {
              patchManifest: params.patchManifest?.trim(),
              overlayPath: params.overlayPath?.trim(),
              overlayTarget: params.overlayTarget?.trim(),
              preTranslateProbe: params.preTranslateProbe,
              exe: params.exe?.trim(),
              advanceSteps: params.advanceSteps,
              timeoutSec: params.timeoutSec,
              useLocaleEmulator: params.useLocaleEmulator,
              skipVision: params.skipVision,
              driver: options?.smokeDriver,
              vision: visionBridge,
            },
            abortSig
          ),
        (payload) => ({ text: JSON.stringify(payload, null, 2), isError: false }),
        signal
      );
      if (!res.isError) {
        options?.onBatchProgress?.({
          type: 'writeback',
          summary: 'Completed runtime smoke test',
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
      'Programmatically translate pending batches from .papercup/tmp/work/batches/manifest.json via isolated translator subagent sessions, enforcing per-session token caps with auto session rotation, strict lightweight validation + direct persistence into .papercup/tmp/work/out/batch_xxx.jsonl, and periodic local Git checkpoints. Returns ONLY concise status metrics — never prints raw JSONL lines to main agent.',
    parameters: Type.Object({
      batchIds: Type.Optional(Type.Array(Type.String(), { description: 'Optional explicit batch IDs (e.g. ["batch_000"]); omit to translate all pending batches' })),
      startBatch: Type.Optional(Type.String({ description: 'Optional inclusive start batch ID' })),
      endBatch: Type.Optional(Type.String({ description: 'Optional inclusive end batch ID' })),
      track: Type.Optional(Type.String({ description: 'Optional track filter: scenario or ui' })),
      includeFailed: Type.Optional(Type.Boolean({ description: 'Re-run batches marked qa_failed' })),
      force: Type.Optional(Type.Boolean({ description: 'Re-translate even if already checked in to .papercup/tmp/work/out' })),
      concurrency: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_CLOUD_CONCURRENCY,
          description: `Concurrent translator worker lanes (1..${MAX_CLOUD_CONCURRENCY}; defaults to plan.json concurrency or ${DEFAULT_CLOUD_CONCURRENCY} in cloud mode)`,
        })
      ),
      sessionMaxSourceTokens: Type.Optional(Type.Integer({ minimum: 100, description: 'Override per-session cumulative source token cap before rotating to a fresh session' })),
      glossary: Type.Optional(Type.String({ description: 'Optional concise glossary override' })),
      personaSummary: Type.Optional(Type.String({ description: 'Optional concise persona override' })),
      contextSummary: Type.Optional(Type.String({ description: 'Short story/style cue injected into translator sessions' })),
      checkpointInterval: Type.Optional(Type.Integer({ minimum: 0, description: 'Save local Git [saved/pending-qa] checkpoint every N batches (default 10, 0 disables)' })),
      mode: Type.Optional(
        Type.Union([Type.Literal('cloud_subagent'), Type.Literal('local_mt')], {
          description: 'Optional override translator mode for this run (cloud_subagent or local_mt)',
        })
      ),
      preset: Type.Optional(
        Type.Union([Type.Literal('sakura'), Type.Literal('hy-mt'), Type.Literal('plain-lines')], {
          description: 'Optional local MT prompt preset override (sakura, hy-mt, or plain-lines)',
        })
      ),
      packetLines: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: 'Optional local MT packet line count override (1..50)',
        })
      ),
      escalateFailedRows: Type.Optional(
        Type.Boolean({
          description: 'Optional toggle for row-level cloud repair on QA-failed local MT rows',
        })
      ),
      allowUnconfirmedCharacters: Type.Optional(
        Type.Boolean({
          description:
            'Explicitly bypass the pre-translation character roster confirmation gate (ONLY when the user explicitly asks to skip character confirmation)',
        })
      ),
      allowSkipPreTranslateSmoke: Type.Optional(
        Type.Boolean({
          description:
            'Explicitly bypass the pre-translation custom-skill smoke-probe gate (ONLY when the user explicitly asks to skip pre-translation smoke testing)',
        })
      ),
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
            translatorConfig: options.getTranslatorConfig?.(),
            localFetch: options.localTranslatorFetch,
            onLocalUsage: options.onLocalUsage,
            ensureLocalEndpointReady: options.ensureLocalEndpointReady,
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
      'Merge all checked-in batches into .papercup/data/results/<track>.jsonl with genuine deterministic qa_report results, then run parallel role-checker semantic reviews with incremental chunk persistence (.papercup/data/vn/post_qa_state.json) and fatal quota circuit-breaking. Re-running resumes ONLY unfinished/changed chunks cleanly.',
    parameters: Type.Object({
      track: Type.Optional(Type.String({ description: 'Optional track filter: scenario or ui' })),
      concurrency: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_CLOUD_CONCURRENCY,
          description: `Concurrent role-checker workers (1..${MAX_CLOUD_CONCURRENCY}; defaults to plan.json concurrency or ${DEFAULT_CLOUD_CONCURRENCY})`,
        })
      ),
      batchMaxLines: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: `Lines per role-checker review chunk (1..200, default ${DEFAULT_POST_QA_CHUNK_LINES})`,
        })
      ),
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
          ? 'role-checker interrupted/errored; completed chunks are persisted in .papercup/data/vn/post_qa_state.json. Report interruption & progress upward first, then re-run vn_post_qa_parallel (without skipRoleChecker=true) to resume remaining chunks — do NOT manually replace role-checker.'
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

  const vnExtractRosterTool = defineTool({
    name: 'vn_extract_roster',
    label: 'VN Extract Character Roster',
    description:
      'Deterministically scan classified .papercup/data/build/scenario.jsonl and .papercup/data/build/ui.jsonl to extract all appearing character names, speaker IDs, occurrence counts, short sample dialogue lines, and existing locked/glossary translations. Call this after vn_classify and BEFORE vn_translate_batches so you can propose consistent default Chinese translations via vn_request_character_confirmation.',
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, signal) =>
      runAction(
        'Character roster extracted.',
        (ws) => extractVnRoster(ws),
        (payload) => ({ text: JSON.stringify(payload, null, 2) }),
        signal
      ),
  });

  const vnRequestCharacterConfirmationTool = defineTool({
    name: 'vn_request_character_confirmation',
    label: 'VN Send Character Confirmation Form',
    description:
      'Send an interactive editable character name confirmation form directly into the user chat conversation (persisted in .papercup/data/vn/forms/<formId>.json). Provide EVERY real appearing character in `characters` with a proposed defaultTarget Chinese translation (plus optional gender, aliases such as surname/given-name splits, and brief note). Put any false-positive non-character candidates from vn_extract_roster (UI buttons, SFX labels, system terms, etc.) into `excludedNames` with a short reason instead of forcing them into the character list; once submitted, excluded entries are persisted in characters.json as dismissedNames and never pollute the glossary. After calling this tool, briefly notify the user to review/edit and submit the form, then STOP your turn and wait — NEVER start vn_translate_batches before the user submits the form.',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Optional form heading (default: 角色译名确认表)' })),
      description: Type.Optional(Type.String({ description: 'Optional concise helper description shown above the form' })),
      characters: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String({ description: 'Optional character id from vn_extract_roster' })),
          sourceName: Type.String({ description: 'Exact source character name from the game' }),
          defaultTarget: Type.String({ description: 'Agent-proposed default Chinese translation (non-empty)' }),
          speakerIds: Type.Optional(
            Type.Array(Type.String(), { description: 'Optional script speaker identifiers mapped to this character' })
          ),
          aliases: Type.Optional(
            Type.Array(
              Type.Object({
                source: Type.String({ description: 'Source surname, given name, or nickname variant' }),
                target: Type.String({ description: 'Corresponding fixed target translation' }),
              }),
              { description: 'Optional surname/given-name/nickname translation pairs to lock alongside the full name' }
            )
          ),
          gender: Type.Optional(
            Type.Union([
              Type.Literal('female'),
              Type.Literal('male'),
              Type.Literal('unknown'),
              Type.Literal('other'),
            ])
          ),
          note: Type.Optional(Type.String({ description: 'Optional short role/pronoun/tone note for user reference' })),
        }),
        { minItems: 0, description: 'All genuine appearing characters with default proposed translations (may be empty only when excludedNames covers all extracted false positives)' }
      ),
      excludedNames: Type.Optional(
        Type.Array(
          Type.Object({
            sourceName: Type.String({ description: 'Exact extracted candidate sourceName that is NOT a character (e.g. button, SFX, system label)' }),
            reason: Type.Optional(Type.String({ description: 'Short explanation of why this candidate is not a character' })),
          }),
          { description: 'Optional non-character false positives to dismiss from the confirmation gate without polluting glossary/roster' }
        )
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const merged = mergeAbortSignals(signal, options?.getTurnSignal?.());
      try {
        const form = requestVnCharacterConfirmation(
          cwdProvider(),
          {
            title: params.title,
            description: params.description,
            characters: params.characters,
            excludedNames: params.excludedNames,
          },
          { sessionId: options?.getSessionId?.() ?? null }
        );
        options?.onChatFormUpdated?.(form);
        const excludedCount = form.excludedItems?.length ?? 0;
        const excludedHint = excludedCount > 0 ? `，另预排除 ${excludedCount} 项非角色候选` : '';
        const text = [
          `已向对话界面发送角色译名确认表单（formId=${form.formId}，共 ${form.items.length} 位角色${excludedHint}，状态=awaiting_user_confirmation）。`,
          '表单已持久化到 .papercup/data/vn/forms/，等待用户在对话中编辑并点击提交。',
          '【指令】请简短提醒用户在下方表单核对/修改待译名并点击提交，然后立即结束当前回复并等待用户提交；在用户提交锁定前严禁调用 vn_translate_batches。',
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text }],
          details: {
            exitCode: 0,
            status: 'awaiting_user_confirmation',
            chatFormId: form.formId,
            chatFormKind: form.kind,
            chatForm: form,
          } as Record<string, unknown>,
        };
      } catch (err: any) {
        const safeErr = redactSecrets(String(err?.message || err), options?.getKnownSecrets?.());
        return {
          content: [{ type: 'text' as const, text: safeErr }],
          details: { exitCode: 1, error: safeErr } as Record<string, unknown>,
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
    vnExtractRosterTool,
    vnRequestCharacterConfirmationTool,
    vnPlanTool,
    vnTranslateBatchesTool,
    vnPostQaParallelTool,
    vnMergeTool,
    vnCheckpointTool,
    vnWritebackTool,
    vnSmokeTestTool,
    vnQaTool,
    vnApplyTool,
    vnRepackTool,
    vnAcceptTool,
    vnReleaseTool,
    vnLearnSkillTool,
    vnPromoteSkillTool,
  ];
}
