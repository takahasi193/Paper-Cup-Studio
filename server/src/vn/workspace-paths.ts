/**
 * Single source of truth for the Paper Cup workspace directory layout.
 *
 * Simplified two-tier `.papercup/` layout + built-in `<workspace>/patch/`:
 *   <workspace>/
 *   ├── papercup.toml                    # User localization profile & settings
 *   ├── patch/                           # Default delta patch bundle (in-place updated)
 *   ├── 补丁说明.md                       # Root-level user patch guide (synced on writeback)
 *   └── .papercup/
 *       ├── skills/                      # Project-level learned engine skills
 *       ├── research/                    # Reverser research notes
 *       ├── data/                        # Persistent translation & engineering assets
 *       │   ├── build/                   # Classified scenario.jsonl / ui.jsonl
 *       │   ├── logs/                    # Cross-session handoff & daily progress logs (HANDOFF.md, YYYY-MM-DD.md)
 *       │   ├── results/                 # QA-verified merged results/*.jsonl
 *       │   ├── release/                 # Release notes (README.md)
 *       │   └── vn/                      # VN state & manifests (text, plan, progress, apply, acceptance, checkpoints, characters, forms, last-patch, post_qa, smoke report)
 *       └── tmp/                         # Disposable caches (safe to delete anytime)
 *           ├── unpacked/                # Unpacked archive staging
 *           ├── work/                    # Batch splits (batches/), per-batch outputs (out/), counts.json
 *           ├── smoke/                   # Hardlink sandboxes (<runId>/), frames/, failures/
 *           └── diagnostics/             # Subagent task logs & spilled tool outputs
 *
 * Pure TypeScript using only Node standard modules (zero circular dependencies).
 */

import fs from 'node:fs';
import path from 'node:path';

export const PAPERCUP_DIR_REL = '.papercup';
export const PAPERCUP_DATA_REL = '.papercup/data';
export const PAPERCUP_TMP_REL = '.papercup/tmp';
export const PAPERCUP_SKILLS_REL = '.papercup/skills';
export const PAPERCUP_RESEARCH_REL = '.papercup/research';
export const PAPERCUP_SESSIONS_REL = '.papercup/sessions';

export const WORKSPACE_TOML_REL = 'papercup.toml';
export const WORKSPACE_PATCH_REL = 'patch';
export const WORKSPACE_PATCH_MANIFEST_REL = 'patch/patch_manifest.json';
export const WORKSPACE_PATCH_GUIDE_REL = '补丁说明.md';

// Persistent engineering & translation assets under .papercup/data/
export const WORKSPACE_BUILD_REL = '.papercup/data/build';
export const WORKSPACE_RESULTS_REL = '.papercup/data/results';
export const WORKSPACE_RELEASE_REL = '.papercup/data/release';
export const WORKSPACE_DEFAULT_RELEASE_REL = '.papercup/data/release/README.md';
export const WORKSPACE_VN_REL = '.papercup/data/vn';
export const WORKSPACE_PROFILE_TOML_REL = '.papercup/data/vn/profile.toml';
export const WORKSPACE_MANIFEST_REL = '.papercup/data/vn/text.json';
export const WORKSPACE_APPLY_REL = '.papercup/data/vn/apply.json';
export const WORKSPACE_PLAN_REL = '.papercup/data/vn/plan.json';
export const WORKSPACE_PROGRESS_REL = '.papercup/data/vn/progress.json';
export const WORKSPACE_CHECKPOINTS_REL = '.papercup/data/vn/checkpoints.json';
export const WORKSPACE_ACCEPTANCE_REL = '.papercup/data/vn/acceptance.json';
export const WORKSPACE_CHARACTERS_REL = '.papercup/data/vn/characters.json';
export const WORKSPACE_FORMS_DIR_REL = '.papercup/data/vn/forms';
export const WORKSPACE_LAST_PATCH_REL = '.papercup/data/vn/last-patch.json';
export const WORKSPACE_POST_QA_STATE_REL = '.papercup/data/vn/post_qa_state.json';
export const WORKSPACE_POST_QA_REPORT_REL = '.papercup/data/vn/post_qa_report.json';
export const WORKSPACE_SMOKE_DATA_REL = '.papercup/data/vn/smoke';
export const WORKSPACE_SMOKE_REPORT_REL = '.papercup/data/vn/smoke/report.json';
export const WORKSPACE_SMOKE_REPAIR_REL = '.papercup/data/vn/smoke/repair-state.json';
export const WORKSPACE_SMOKE_PRE_TRANSLATE_REL = '.papercup/data/vn/smoke/pre-translate.json';
export const WORKSPACE_FONTS_DATA_REL = '.papercup/data/vn/fonts';
export const WORKSPACE_FONTS_MANIFEST_REL = '.papercup/data/vn/fonts/manifest.json';
export const WORKSPACE_FONT_REMAP_REL = '.papercup/data/vn/fonts/char_remap.json';
export const WORKSPACE_LOGS_REL = '.papercup/data/logs';
export const WORKSPACE_HANDOFF_LOG_REL = '.papercup/data/logs/HANDOFF.md';

// Disposable caches under .papercup/tmp/
export const WORKSPACE_UNPACKED_REL = '.papercup/tmp/unpacked';
export const WORKSPACE_WORK_REL = '.papercup/tmp/work';
export const WORKSPACE_BATCHES_DIR_REL = '.papercup/tmp/work/batches';
export const WORKSPACE_BATCHES_MANIFEST_REL = '.papercup/tmp/work/batches/manifest.json';
export const WORKSPACE_WORK_OUT_REL = '.papercup/tmp/work/out';
export const WORKSPACE_COUNTS_REL = '.papercup/tmp/work/counts.json';
export const WORKSPACE_SMOKE_TMP_REL = '.papercup/tmp/smoke';
export const WORKSPACE_SMOKE_FRAMES_REL = '.papercup/tmp/smoke/frames';
export const WORKSPACE_SMOKE_FAILURES_REL = '.papercup/tmp/smoke/failures';
export const WORKSPACE_SMOKE_LAST_PROBE_REL = '.papercup/tmp/smoke/last-probe';
export const WORKSPACE_RE_TRACE_TMP_REL = '.papercup/tmp/re-trace';
export const WORKSPACE_DIAGNOSTICS_REL = '.papercup/tmp/diagnostics';
export const WORKSPACE_SUBAGENT_TASKS_REL = '.papercup/tmp/diagnostics/subagent-tasks';
export const WORKSPACE_TOOL_OUTPUTS_REL = '.papercup/tmp/diagnostics/tool-outputs';
export const WORKSPACE_COMPACTIONS_REL = `${WORKSPACE_DIAGNOSTICS_REL}/compactions`;

/**
 * Reserved Paper Cup cache subdirectories under `.papercup/tmp/` (distinguished from
 * reverser probe scratch folders such as `.papercup/tmp/<engine>/`).
 */
export const WORKSPACE_TMP_RESERVED_SUBDIRS = new Set(['unpacked', 'work', 'smoke', 're-trace', 'diagnostics']);

export interface WorkspacePaths {
  root: string;
  papercupDir: string;
  dataDir: string;
  tmpDir: string;
  skillsDir: string;
  researchDir: string;
  sessionsDir: string;

  papercupTomlFile: string;
  patchDir: string;
  patchManifestFile: string;
  patchGuideFile: string;

  buildDir: string;
  resultsDir: string;
  releaseDir: string;
  defaultReleaseFile: string;
  vnDir: string;
  profileTomlFile: string;
  textManifestFile: string;
  applyReportFile: string;
  planFile: string;
  progressFile: string;
  checkpointsFile: string;
  acceptanceFile: string;
  charactersFile: string;
  formsDir: string;
  lastPatchFile: string;
  postQaStateFile: string;
  postQaReportFile: string;
  smokeDataDir: string;
  smokeReportFile: string;
  smokeRepairStateFile: string;
  smokePreTranslateFile: string;
  fontsDataDir: string;
  fontsManifestFile: string;
  fontRemapFile: string;
  logsDir: string;
  handoffLogFile: string;

  unpackedDir: string;
  workDir: string;
  batchesDir: string;
  batchesManifestFile: string;
  workOutDir: string;
  countsFile: string;
  smokeTmpDir: string;
  smokeFramesDir: string;
  smokeFailuresDir: string;
  smokeLastProbeDir: string;
  reTraceTmpDir: string;
  diagnosticsDir: string;
  subagentTasksDir: string;
  toolOutputsDir: string;
  compactionsDir: string;

  buildTrackFile(track: string): string;
  resultsTrackFile(track: string): string;
  batchInputFile(batchId: string): string;
  batchInputRel(batchId: string): string;
  batchOutFile(batchId: string): string;
  batchOutRel(batchId: string): string;
  smokeSandboxDir(runId: string): string;
  smokeFailureDir(runId: string): string;
  reTraceSandboxDir(runId: string): string;
  formFile(formId: string): string;
  skillDir(skillName: string): string;
  researchEngineDir(engine: string): string;
  subagentTaskFile(taskId: string): string;
}

export type ResolvedWorkspacePaths = WorkspacePaths;

function realpathSafeLocal(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function resolveWorkspacePaths(workspace: string): WorkspacePaths {
  const root = realpathSafeLocal(workspace);
  const papercupDir = path.join(root, '.papercup');
  const dataDir = path.join(papercupDir, 'data');
  const tmpDir = path.join(papercupDir, 'tmp');
  const skillsDir = path.join(papercupDir, 'skills');
  const researchDir = path.join(papercupDir, 'research');
  const sessionsDir = path.join(papercupDir, 'sessions');

  const papercupTomlFile = path.join(root, WORKSPACE_TOML_REL);
  const patchDir = path.join(root, WORKSPACE_PATCH_REL);
  const patchManifestFile = path.join(patchDir, 'patch_manifest.json');
  const patchGuideFile = path.join(root, WORKSPACE_PATCH_GUIDE_REL);

  const buildDir = path.join(dataDir, 'build');
  const resultsDir = path.join(dataDir, 'results');
  const releaseDir = path.join(dataDir, 'release');
  const defaultReleaseFile = path.join(releaseDir, 'README.md');
  const vnDir = path.join(dataDir, 'vn');
  const profileTomlFile = path.join(vnDir, 'profile.toml');
  const textManifestFile = path.join(vnDir, 'text.json');
  const applyReportFile = path.join(vnDir, 'apply.json');
  const planFile = path.join(vnDir, 'plan.json');
  const progressFile = path.join(vnDir, 'progress.json');
  const checkpointsFile = path.join(vnDir, 'checkpoints.json');
  const acceptanceFile = path.join(vnDir, 'acceptance.json');
  const charactersFile = path.join(vnDir, 'characters.json');
  const formsDir = path.join(vnDir, 'forms');
  const lastPatchFile = path.join(vnDir, 'last-patch.json');
  const postQaStateFile = path.join(vnDir, 'post_qa_state.json');
  const postQaReportFile = path.join(vnDir, 'post_qa_report.json');
  const smokeDataDir = path.join(vnDir, 'smoke');
  const smokeReportFile = path.join(smokeDataDir, 'report.json');
  const smokeRepairStateFile = path.join(smokeDataDir, 'repair-state.json');
  const smokePreTranslateFile = path.join(smokeDataDir, 'pre-translate.json');
  const fontsDataDir = path.join(root, WORKSPACE_FONTS_DATA_REL);
  const fontsManifestFile = path.join(root, WORKSPACE_FONTS_MANIFEST_REL);
  const fontRemapFile = path.join(root, WORKSPACE_FONT_REMAP_REL);
  const logsDir = path.join(dataDir, 'logs');
  const handoffLogFile = path.join(logsDir, 'HANDOFF.md');

  const unpackedDir = path.join(tmpDir, 'unpacked');
  const workDir = path.join(tmpDir, 'work');
  const batchesDir = path.join(workDir, 'batches');
  const batchesManifestFile = path.join(batchesDir, 'manifest.json');
  const workOutDir = path.join(workDir, 'out');
  const countsFile = path.join(workDir, 'counts.json');
  const smokeTmpDir = path.join(tmpDir, 'smoke');
  const smokeFramesDir = path.join(smokeTmpDir, 'frames');
  const smokeFailuresDir = path.join(smokeTmpDir, 'failures');
  const smokeLastProbeDir = path.join(root, WORKSPACE_SMOKE_LAST_PROBE_REL);
  const reTraceTmpDir = path.join(tmpDir, 're-trace');
  const diagnosticsDir = path.join(tmpDir, 'diagnostics');
  const subagentTasksDir = path.join(diagnosticsDir, 'subagent-tasks');
  const toolOutputsDir = path.join(diagnosticsDir, 'tool-outputs');
  const compactionsDir = path.join(diagnosticsDir, 'compactions');

  return {
    root,
    papercupDir,
    dataDir,
    tmpDir,
    skillsDir,
    researchDir,
    sessionsDir,

    papercupTomlFile,
    patchDir,
    patchManifestFile,
    patchGuideFile,

    buildDir,
    resultsDir,
    releaseDir,
    defaultReleaseFile,
    vnDir,
    profileTomlFile,
    textManifestFile,
    applyReportFile,
    planFile,
    progressFile,
    checkpointsFile,
    acceptanceFile,
    charactersFile,
    formsDir,
    lastPatchFile,
    postQaStateFile,
    postQaReportFile,
    smokeDataDir,
    smokeReportFile,
    smokeRepairStateFile,
    smokePreTranslateFile,
    fontsDataDir,
    fontsManifestFile,
    fontRemapFile,
    logsDir,
    handoffLogFile,

    unpackedDir,
    workDir,
    batchesDir,
    batchesManifestFile,
    workOutDir,
    countsFile,
    smokeTmpDir,
    smokeFramesDir,
    smokeFailuresDir,
    smokeLastProbeDir,
    reTraceTmpDir,
    diagnosticsDir,
    subagentTasksDir,
    toolOutputsDir,
    compactionsDir,

    buildTrackFile: (track: string) => path.join(buildDir, `${track}.jsonl`),
    resultsTrackFile: (track: string) => path.join(resultsDir, `${track}.jsonl`),
    batchInputFile: (batchId: string) => path.join(batchesDir, `${batchId}.jsonl`),
    batchInputRel: (batchId: string) => `${WORKSPACE_BATCHES_DIR_REL}/${batchId}.jsonl`,
    batchOutFile: (batchId: string) => path.join(workOutDir, `${batchId}.jsonl`),
    batchOutRel: (batchId: string) => `${WORKSPACE_WORK_OUT_REL}/${batchId}.jsonl`,
    smokeSandboxDir: (runId: string) => path.join(smokeTmpDir, runId),
    smokeFailureDir: (runId: string) => path.join(smokeFailuresDir, runId),
    reTraceSandboxDir: (runId: string) => path.join(reTraceTmpDir, runId),
    formFile: (formId: string) => path.join(formsDir, `${formId}.json`),
    skillDir: (skillName: string) => path.join(skillsDir, skillName),
    researchEngineDir: (engine: string) => path.join(researchDir, engine),
    subagentTaskFile: (taskId: string) => path.join(subagentTasksDir, `${taskId}.json`),
  };
}
