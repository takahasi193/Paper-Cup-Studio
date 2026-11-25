/**
 * Core types for the Paper Cup Reverser Benchmark suite.
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type BenchDifficulty = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

export type BenchPipelineKind = 'skill' | 'direct';

export interface GroundTruthTextEntry {
  /** Normalized Japanese source text expected in extract.py output. */
  source: string;
  /** Expected track / kind class. */
  track: 'scenario' | 'ui';
  /** Expected kind (e.g. say / name / choice / system). */
  kind: 'say' | 'name' | 'choice' | 'system' | 'button' | 'menu';
  /** Synthetic Simplified Chinese translation used during hard writeback verification. */
  zhTranslation: string;
}

export interface ConsumerVerificationInput {
  /** Path to the patched game directory (direct pipeline) or repacked game directory (skill pipeline). */
  patchedGameDir: string;
  /** Encoding used when applying translations (e.g. 'utf-8', 'gbk', 'cp932'). */
  appliedEncoding: string;
  /** Map from normalized source text -> expected translated text. */
  expectedBySource: Map<string, string>;
  /** Whether this verification is identity (target === source) or Chinese variable-length writeback. */
  mode: 'identity' | 'zh_writeback';
}

export interface ConsumerVerificationResult {
  ok: boolean;
  checkedCount: number;
  errors: string[];
}

export interface BenchTaskSpec {
  id: string;
  difficulty: BenchDifficulty;
  tierName: string;
  title: string;
  description: string;
  expectedPipeline: BenchPipelineKind;
  expectedSourceEncoding: 'utf-8' | 'cp932';
  /** Whether the task uses custom control tags that must be registered in engine.json control_pattern. */
  hasCustomControlTags: boolean;
  /** Relative path to game root inside the benchmark workspace (e.g. "game"). */
  gameRelDir: string;
  /** Archives to unpack (only for skill pipeline). */
  archiveRelPaths?: string[];
  /** Raster UI asset filenames expected to stay byte-identical (and optionally listed in rasterUiAssets). */
  rasterAssetRelPaths?: string[];
  /** Minimum recall thresholds (strict!). */
  minScenarioRecall: number;
  minUiRecall: number;
  /** Ground-truth entries that MUST be extracted and written back cleanly. */
  groundTruth: GroundTruthTextEntry[];
  /** Substrings / exact strings that MUST NEVER be extracted (decoys, lookup keys, comments, debug). */
  forbiddenExtractedSubstrings: string[];
  /** Prompt given to reverser (identical in style to real main-agent delegation). */
  buildTaskPrompt: (workspaceRelGameDir: string) => string;
  /** Deterministically materializes the fresh synthetic game workspace on disk. */
  generateFixture: (workspaceDir: string) => void;
  /** Executes the task's deterministic Engine / VM Consumer Simulator on patched files. */
  verifyConsumer: (input: ConsumerVerificationInput) => ConsumerVerificationResult;
}

export type GateId =
  | 'G1_SKILL_ADOPTED'
  | 'G2_ORIGINAL_UNTOUCHED'
  | 'G3_RESEARCH_ARTIFACTS'
  | 'G4_EXTRACTION_ACCURACY'
  | 'G5_IDENTITY_ROUNDTRIP'
  | 'G6_VARIABLE_LENGTH_ZH_WRITEBACK'
  | 'G7_CONTROL_PATTERN_QA'
  | 'G8_HYGIENE_AND_SANDBOX';

export interface BenchGateResult {
  id: GateId;
  passed: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface BenchTaskReport {
  taskId: string;
  difficulty: BenchDifficulty;
  tierName: string;
  title: string;
  passed: boolean;
  passedGates: number;
  totalGates: number;
  gates: BenchGateResult[];
  durationMs: number;
  reverserStatus: 'success' | 'error' | 'aborted' | 'oracle';
  reverserError?: string;
  toolCalls: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  artifactDir: string;
}

export interface BenchRunReport {
  schema: 1;
  createdAt: string;
  mode: 'live' | 'oracle';
  provider: string;
  model: string;
  thinkingLevel: string;
  totalTasks: number;
  passedTasks: number;
  passRate: number;
  totalDurationMs: number;
  totalUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  results: BenchTaskReport[];
}

export interface BenchProviderConfig {
  /** Provider name: 'magpie' | 'openai-compat' | Pi built-in provider id (e.g. 'openai', 'anthropic', 'google', 'deepseek'). */
  provider: string;
  /** Model id (optional for 'magpie' where first discovered chat model can be selected). */
  model?: string;
  /** Base URL for 'magpie' or 'openai-compat'. */
  baseUrl?: string;
  /** Runtime API key (optional for local keyless Magpie / Ollama). */
  apiKey?: string;
  /** Thinking level passed to reverser (default: 'max', auto-clamped by Pi SDK). */
  thinkingLevel?: ThinkingLevel;
  /** Optional custom adapter module path (.ts / .js / .mjs). */
  adapterPath?: string;
}

export interface BenchResolvedRuntime {
  model: any;
  modelRuntime: any;
  providerLabel: string;
  modelLabel: string;
  thinkingLevel: ThinkingLevel;
  /** Known secret strings to redact from diagnostic logs. */
  knownSecrets: string[];
}

export type BenchProviderAdapter = (
  config: BenchProviderConfig
) => Promise<BenchResolvedRuntime>;
