/**
 * Deterministic VN domain contract & negative invariant unit tests.
 *
 * Covers:
 * 1. Invariant #2 safe script writeback (2PC atomicity, .bak preservation, dual-track XP3/NSA transcoding)
 * 2. Path traversal & symlink/junction escape guards across profile/archives/core/workflow
 * 3. Built-in archive format variants, security boundaries & malformed inputs (RPA, XP3, PE+ZIP, NSA, scan BFS)
 * 4. Acceptance, release, skill-learning & local Git checkpoint negative gates
 * 5. QA, token estimation, profile/persona/packet slicing, and smoke-test rules/parsers/vision adapter
 *
 * 100% offline, isolated per-test temp directories, zero host ~/.papercup mutations.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  chooseProxyDllName,
  normalizeProxyDllName,
  readPeImportedDlls,
  readPeMachineArch,
  resolvePrebuiltProxyDll,
} from '../src/vn/win32-proxy.js';

import {
  ArchiveError,
  NO_UNPACKER_KINDS,
  adler32,
  detectEngineFingerprintHints,
  formatPythonErrorDetail,
  inspectPeZip,
  loadCustomMatchers,
  loadNsaIndex,
  packDeltaXp3,
  parseXp3Header,
  repackNsa,
  repackRpa,
  repackXp3,
  runPythonScript,
  scanWorkspace,
  selfCheckArchive,
  sha256Hex,
  skillBinding,
  staysInside,
  testBuiltinArchiveUnpackable,
  unpackNsa,
  unpackPeZip,
  unpackRpa,
  unpackXp3,
  type EngineFingerprintHint,
  type ScanResult,
} from '../src/vn/archives.js';
import {
  ApplyError,
  DEFAULT_CLOUD_CONCURRENCY,
  DEFAULT_POST_QA_CHUNK_LINES,
  MAX_CLOUD_CONCURRENCY,
  PlanError,
  applyResults,
  applyStatus,
  checkinBatch,
  classifyUnpacked,
  defaultPlanConfig,
  generateBatches,
  mergeTrackResults,
  readPlan,
  savePlanConfig,
  writeClassification,
} from '../src/vn/classify.js';
import {
  acceptVnRelease,
  classifyVnScripts,
  detectVnEngineSummary,
  getVnStatus,
  learnVnSkill,
  patchWorkspaceFont,
  planVnTranslation,
  promoteVnSkill,
  releaseVnPatch,
  repackVnArchives,
  unpackVnArchives,
  verifyVnQa,
  writebackVnCopy,
  type VnEngineSummary,
} from '../src/vn/core.js';
import {
  DecodeError,
  detectEncoding,
  encodeText,
  insideWorkspace,
  isSafeCustomEncodingName,
  loadProfile,
  loadProfileMemory,
  loadWorkspacePatchConfig,
  memoryDigest,
  normalizeEncodingName,
  parsePersonaMap,
  parseTomlSections,
  projectHarnessDir,
  readiness,
  resolveWorkspaceControlPattern,
  type CharacterRosterEntry,
  type LocalizationProfile,
  type ProjectMemory,
} from '../src/vn/profile.js';
import { checkCrossRowNameConsistency, qaReport } from '../src/vn/qa.js';
import {
  CHARACTERS_REL,
  FORMS_DIR_REL,
  RosterError,
  buildCharacterFormConfirmationMessage,
  cancelChatForm,
  checkCharacterConfirmationGate,
  compileRosterToGlossary,
  createCharacterConfirmationForm,
  extractCharacterCandidates,
  findPendingCharacterForm,
  formatCharacterRosterForPrompt,
  listChatForms,
  readChatForm,
  readCharacterRoster,
  submitCharacterConfirmationForm,
  writeCharacterRoster,
} from '../src/vn/roster.js';
import {
  MODEL_FAMILIES,
  detectModelFamily,
  estimateRecordTokens,
  estimateTextTokens,
  estimateWithMargin,
  resolveFamily,
} from '../src/vn/tokens.js';
import {
  sliceGlossaryForUnits,
  sliceSpeakerHints,
  type TranslationUnit,
} from '../src/vn/translation-packet.js';
import {
  AcceptanceError,
  ExportCopyError,
  MAX_ARCHIVE_LEARN_BYTES,
  ReleaseError,
  acceptanceState,
  buildReleaseNote,
  buildUnpackNoMatchGuidance,
  createCheckpoint,
  delegatedReport,
  isBackupOrNonOriginalArchiveRel,
  learnUnpackSkill,
  mergeAcceptance,
  pickMutationRowsByFormat,
  promoteSkill,
  validateAcceptance,
} from '../src/vn/workflow.js';
import {
  SHRINK_REPLACE_MIN_ORIGINAL_BYTES,
  SHRINK_REPLACE_MIN_RATIO,
  assertNoDestructiveShrinkReplace,
  buildInstallBatchScripts,
  buildPatchBundle,
  getDestructiveShrinkReplaceReason,
  inspectPrimaryGameExe,
  readLastPatchMeta,
  readSkillRuntimeCharsetHint,
  resolvePatchEncodingAndHook,
} from '../src/vn/patch.js';
import {
  WORKSPACE_COMPACTIONS_REL,
  WORKSPACE_FONTS_MANIFEST_REL,
  WORKSPACE_FONT_REMAP_REL,
  WORKSPACE_HANDOFF_LOG_REL,
  WORKSPACE_LOGS_REL,
  WORKSPACE_PATCH_GUIDE_REL,
  WORKSPACE_PATCH_REL,
  WORKSPACE_RE_TRACE_TMP_REL,
  WORKSPACE_SMOKE_LAST_PROBE_REL,
  WORKSPACE_SMOKE_PRE_TRANSLATE_REL,
  WORKSPACE_TMP_RESERVED_SUBDIRS,
  resolveWorkspacePaths,
} from '../src/vn/workspace-paths.js';
import {
  ZH_SC_ONLY_PROBE_CHARS,
  applyCharRemapText,
  inspectFontBuffer,
  loadPatchedFontManifest,
  loadWorkspaceCharRemap,
  scanWorkspaceBundledFonts,
} from '../src/vn/fonts.js';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import {
  SessionManager,
  SettingsManager,
  estimateTokens,
  shouldCompact,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_HUGE_MAIN_SOFT_CAP_TOKENS,
  DEFAULT_HUGE_REVERSER_SOFT_CAP_TOKENS,
  DEFAULT_PAPERCUP_COMPACTION_CONFIG,
  HUGE_WINDOW_THRESHOLD_TOKENS,
  applyCompactionSettingsForModel,
  archiveCompactionCheckpoint,
  buildDeterministicWorkspaceAnchor,
  buildDomainCompactionInstructions,
  computeCompactionThresholds,
  createPaperCupCompactionExtension,
  estimatePromptMessageTokens,
  estimateRealProjectedContextTokens,
  hasPostUsageContextEdit,
  isPaperCupContextOverflow,
  parseSlashCompactCommand,
  planToolResultPruneEdits,
  readPaperCupCompactionConfig,
} from '../src/agent/compaction.js';
import { discoverProviderAndModels, inferContextWindowFromModelId } from '../src/agent/provider-discovery.js';
import {
  SkillRegistryError,
  assertSkillScriptVerified,
  bindSkillToWorkspace,
  collectDeduplicatedSkillDirs,
  discoverSkillPackages,
  exportSanitizedSkillPackage,
  findSkillPackageByEngine,
  hashSkillTextContent,
  resolveSkillBindingFromRegistry,
  verifySkillPackageIntegrity,
} from '../src/vn/skill-registry.js';
import { AgentService } from '../src/agent/agent-service.js';
import {
  SMOKE_PRE_TRANSLATE_REL,
  SmokeError,
  buildPreTranslateProbeTarget,
  checkPreTranslateSmokeGate,
  computeCustomSkillDigest,
  createTextractorStreamParser,
  evaluateSmokeRules,
  getWindowsSmokeDriverSource,
  isTestOrTemplateScriptPath,
  isUniformColorPng,
  pickPreTranslateProbeRow,
  pickPreTranslateProbeRows,
  prepareReadOnlyTraceSandbox,
  prepareSmokeSandbox,
  prepareSmokeSandboxFromOverlay,
  readPreTranslateSmokeRecord,
  readSmokeRepairState,
  resolveActiveCustomSkillForPreTranslateSmoke,
  runSmokeTest,
  writeWindowsSmokeDriverScript,
  type SmokeDriverRunResult,
} from '../src/vn/smoke.js';
import {
  DEFAULT_SMOKE_CONFIG,
  findLocaleEmulatorProfileGuid,
  inspectSmokeTools,
  saveGlobalSmokeConfig,
  selectTextractorCliForArch,
} from '../src/vn/smoke-config.js';
import { createSmokeVisionBridge } from '../src/agent/smoke-vision.js';
import { runPostQaParallel, runTranslateBatches } from '../src/agent/batch-orchestrator.js';
import { DEFAULT_LOCAL_TRANSLATOR_CONFIG } from '../src/agent/local-translator.js';
import { PAPERCUP_SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { createVnTools } from '../src/agent/vn-tools.js';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BUILTIN_SUBAGENTS, resolveBuiltinReverserSkillDir } from '../src/subagents/roles.js';
import {
  REASONING_OFF_FALLBACK_LADDER,
  applyReasoningOffCandidateToModel,
  clearReasoningOffFallbackCache,
  createReasoningOffFallbackStream,
  getCachedReasoningOffValue,
  isReasoningEffortRejectionError,
  shouldProbeReasoningEffortOff,
  wrapModelRuntimeWithReasoningOffFallback,
  type ReasoningOffCandidate,
} from '../src/agent/reasoning-effort-fallback.js';
import {
  MAX_RESUMES_PER_TASK,
  MAX_REVERSER_NO_DELIVERABLE_ROUNDS,
  REVERSER_NO_DELIVERABLE_REMIND_INTERVAL,
  REVERSER_SCRATCH_SCRIPT_SPRAWL_FIRST,
  REVERSER_SCRATCH_SCRIPT_SPRAWL_STEP,
  REVERSER_SOFT_STALL_REMIND_INTERVAL,
  REVERSER_TMP_READ_REMIND_FIRST,
  REVERSER_TMP_READ_REMIND_STEP,
  SubagentManager,
  TRANSLATOR_PROGRESS_EMIT_INTERVAL_MS,
  classifySubagentError,
  detectKnownEngineHintInText,
  extractTranslatorBatchMeta,
  findLatestCompactionCheckpointPath,
  formatSubagentFailureText,
  formatTranslatorProgressSummary,
  hasResearchRecallHypotheses,
  isMeaningfulReverserArtifactPath,
  isReverserDeliverableProgressArtifact,
  isTmpScratchScriptPath,
  isTmpScratchTextReadPath,
  requiresResearchGuardrails,
  shouldEmitNoDeliverableNotice,
  shouldEmitScratchScriptSprawlNotice,
  shouldEmitSoftStallNotice,
  shouldEmitTmpReadStdoutNotice,
  type SubagentTaskSnapshot,
  type SubagentTaskSummary,
} from '../src/subagents/subagent-manager.js';
import {
  DEFAULT_ALLOW_RE_LOOKUP,
  DEFAULT_MAX_REVERSER_NO_DELIVERABLE_COMPACTIONS,
  DEFAULT_MAX_REVERSER_TOKENS,
  createGuardedBuiltinToolDefinitions,
  readVnResearchConfig,
  resolveSkillReadFallbackPath,
} from '../src/security/guarded-tools.js';
import {
  CURATED_VN_RE_REPOS,
  RE_LOOKUP_ALLOWED_HOSTS,
  createReverserTools,
  formatTraceOutput,
  validateLookupUrl,
} from '../src/agent/reverser-tools.js';
import { createApiRouter } from '../src/api/routes.js';
import {
  DEFAULT_IMAGE_ONLY_PROMPT,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  extractImagesFromContent,
  inferCustomModelInputModalities,
  modelSupportsImageInput,
  validateAndNormalizeImageAttachments,
} from '../src/agent/image-attachments.js';
import {
  SessionQueueController,
  type QueueCapableSession,
} from '../src/agent/message-queue.js';
import { config } from '../src/config.js';

/* ========================= Isolated Temp & Binary Builders ========================= */

async function withTempWorkspace<T>(
  fn: (ctx: { root: string; ws: string; homeDir: string }) => T | Promise<T>
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-vn-contracts-'));
  const ws = path.join(root, 'ws');
  const homeDir = path.join(root, 'papercup-home');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const prevPaperCupHome = process.env.PAPERCUP_HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.PAPERCUP_HOME = homeDir;
  process.env.USERPROFILE = root;
  process.env.HOME = root;
  try {
    return await fn({ root, ws, homeDir });
  } finally {
    if (prevPaperCupHome === undefined) delete process.env.PAPERCUP_HOME;
    else process.env.PAPERCUP_HOME = prevPaperCupHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeProfile(overrides: Partial<LocalizationProfile> = {}): LocalizationProfile {
  return {
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
    ...overrides,
  };
}

function makeMemory(overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    glossary: {},
    persona: {},
    lessons: [],
    personaErrors: [],
    ...overrides,
  };
}

function encodePickleDict(entries: Array<[string, number, number]>): Buffer {
  const parts: Buffer[] = [Buffer.from([0x80, 0x02, 0x7d, 0x28])]; // PROTO 2, EMPTY_DICT, MARK
  for (const [name, off, len] of entries) {
    const nb = Buffer.from(name, 'utf8');
    const hdr = Buffer.alloc(5);
    hdr[0] = 0x58; // BINUNICODE
    hdr.writeUInt32LE(nb.length, 1);
    parts.push(hdr, nb, Buffer.from([0x5d])); // EMPTY_LIST
    const offBuf = Buffer.alloc(5);
    offBuf[0] = 0x4a; // BININT
    offBuf.writeInt32LE(off, 1);
    const lenBuf = Buffer.alloc(5);
    lenBuf[0] = 0x4a; // BININT
    lenBuf.writeInt32LE(len, 1);
    parts.push(offBuf, lenBuf, Buffer.from([0x86, 0x61])); // TUPLE2, APPEND
  }
  parts.push(Buffer.from([0x75, 0x2e])); // SETITEMS, STOP
  return Buffer.concat(parts);
}

function buildRpaArchive(
  version: '2.0' | '3.0' | '3.2',
  files: Array<[string, Buffer]>,
  key = 0x12345678
): Buffer {
  const effKey = version === '2.0' ? 0 : key;
  const makeHeader = (offset: number) =>
    version === '2.0'
      ? Buffer.from(`RPA-2.0 ${offset.toString(16).padStart(16, '0')}\n`, 'ascii')
      : Buffer.from(`RPA-${version} ${offset.toString(16).padStart(16, '0')} ${effKey.toString(16).padStart(8, '0')}\n`, 'ascii');

  let cursor = makeHeader(0).length;
  const idxEntries: Array<[string, number, number]> = [];
  const blobs: Buffer[] = [];
  for (const [name, data] of files) {
    idxEntries.push([name, cursor ^ effKey, data.length ^ effKey]);
    blobs.push(data);
    cursor += data.length;
  }
  const indexBlob = zlib.deflateSync(encodePickleDict(idxEntries));
  return Buffer.concat([makeHeader(cursor), ...blobs, indexBlob]);
}

function buildRawRpaWithPickle(rawPickle: Buffer): Buffer {
  const data = Buffer.from('payload', 'ascii');
  const makeHeader = (offset: number) =>
    Buffer.from(`RPA-3.0 ${offset.toString(16).padStart(16, '0')} 00000000\n`, 'ascii');
  const offset = makeHeader(0).length + data.length;
  return Buffer.concat([makeHeader(offset), data, zlib.deflateSync(rawPickle)]);
}

function buildXp3Custom(
  entries: Array<{ name: string; data: Buffer; infoFlags?: number; corruptAdler?: boolean }>,
  options: { extraHeader?: boolean } = {}
): Buffer {
  const XP3_MAGIC = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]);
  const headerSize = options.extraHeader ? 40 : 19;
  const dataBlobs: Buffer[] = [];
  const fileChunks: Buffer[] = [];
  let cursor = headerSize;

  const makeChunk = (tag: string, body: Buffer) => {
    const h = Buffer.alloc(12);
    h.write(tag, 0, 4, 'latin1');
    h.writeBigUInt64LE(BigInt(body.length), 4);
    return Buffer.concat([h, body]);
  };

  for (const ent of entries) {
    const packed = zlib.deflateSync(ent.data);
    dataBlobs.push(packed);

    const nameUtf16 = Buffer.from(ent.name, 'utf16le');
    const info = Buffer.alloc(22 + nameUtf16.length);
    info.writeUInt32LE(ent.infoFlags ?? 0, 0);
    info.writeBigUInt64LE(BigInt(ent.data.length), 4);
    info.writeBigUInt64LE(BigInt(packed.length), 12);
    info.writeUInt16LE(ent.name.length, 20);
    nameUtf16.copy(info, 22);

    const segm = Buffer.alloc(28);
    segm.writeUInt32LE(1, 0); // compressed
    segm.writeBigUInt64LE(BigInt(cursor), 4);
    segm.writeBigUInt64LE(BigInt(ent.data.length), 12);
    segm.writeBigUInt64LE(BigInt(packed.length), 20);

    const adlr = Buffer.alloc(4);
    const checksum = (adler32(ent.data) ^ (ent.corruptAdler ? 0xff : 0)) >>> 0;
    adlr.writeUInt32LE(checksum, 0);

    fileChunks.push(makeChunk('File', Buffer.concat([makeChunk('info', info), makeChunk('segm', segm), makeChunk('adlr', adlr)])));
    cursor += packed.length;
  }

  const rawIndex = Buffer.concat(fileChunks);
  const packedIndex = zlib.deflateSync(rawIndex);
  const idxMeta = Buffer.alloc(17);
  idxMeta[0] = 1;
  idxMeta.writeBigUInt64LE(BigInt(packedIndex.length), 1);
  idxMeta.writeBigUInt64LE(BigInt(rawIndex.length), 9);

  let header: Buffer;
  if (options.extraHeader) {
    header = Buffer.alloc(40, 0);
    XP3_MAGIC.copy(header, 0);
    header.writeBigUInt64LE(0x17n, 11);
    header.writeUInt32LE(1, 19);
    header.writeUInt32LE(0x80, 23);
    header.writeBigUInt64LE(BigInt(cursor), 32);
  } else {
    header = Buffer.alloc(19, 0);
    XP3_MAGIC.copy(header, 0);
    header.writeBigUInt64LE(BigInt(cursor), 11);
  }
  return Buffer.concat([header, ...dataBlobs, idxMeta, packedIndex]);
}

function buildPeZip(files: Array<[string, Buffer]>, options: { corruptCrc?: boolean } = {}): Buffer {
  const peStub = Buffer.alloc(64, 0);
  peStub.write('MZ', 0, 'ascii');
  const lfhChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let localOffset = 0;

  for (const [name, data] of files) {
    const compressed = zlib.deflateRawSync(data);
    const crc = ((zlib.crc32(data) >>> 0) ^ (options.corruptCrc ? 0x11223344 : 0)) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x800, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfhChunks.push(lfh, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(localOffset, 42);
    cdChunks.push(cd, nameBuf);
    localOffset += lfh.length + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([peStub, ...lfhChunks, cdBuf, eocd]);
}

function encodeNsaLzssLiterals(data: Buffer): Buffer {
  // Valid NSA LZSS stream emitting every byte as 1-bit flag=1 + 8-bit literal
  const bits: number[] = [];
  for (const byte of data) {
    bits.push(1);
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  }
  const out = Buffer.alloc(Math.ceil(bits.length / 8), 0);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

function buildNsaArchive(
  entries: Array<{ name: string; data: Buffer; compression?: number; originalLen?: number }>
): Buffer {
  const indexParts: Buffer[] = [];
  const payloads: Buffer[] = [];
  let cursor = 0;
  for (const e of entries) {
    const rawName = encodeText(e.name, 'cp932');
    const comp = e.compression ?? 0;
    const payload = comp === 2 ? encodeNsaLzssLiterals(e.data) : e.data;
    const meta = Buffer.alloc(14);
    meta[0] = 0; // NUL terminator for name
    meta[1] = comp;
    meta.writeUInt32BE(cursor, 2);
    meta.writeUInt32BE(payload.length, 6);
    meta.writeUInt32BE(e.originalLen ?? e.data.length, 10);
    indexParts.push(rawName, meta);
    payloads.push(payload);
    cursor += payload.length;
  }
  const indexBlob = Buffer.concat(indexParts);
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16BE(entries.length, 0);
  hdr.writeUInt32BE(6 + indexBlob.length, 2);
  return Buffer.concat([hdr, indexBlob, ...payloads]);
}

function makeDummyPeExe(arch: 'x86' | 'x64' = 'x86'): Buffer {
  const pe = Buffer.alloc(256, 0);
  pe[0] = 0x4d;
  pe[1] = 0x5a;
  pe.writeUInt32LE(0x80, 0x3c);
  pe[0x80] = 0x50;
  pe[0x81] = 0x45;
  pe.writeUInt16LE(arch === 'x64' ? 0x8664 : 0x014c, 0x84);
  return pe;
}

function makeBaseDriverResult(overrides: Partial<SmokeDriverRunResult> = {}): SmokeDriverRunResult {
  return {
    launched: true,
    windowFound: true,
    windowTitle: 'VN Test',
    inputMode: 'background',
    stepsAdvanced: 10,
    durationMs: 2500,
    processExitedEarly: false,
    exitCode: 0,
    hungDetected: false,
    frozenScreen: false,
    frames: [],
    textractorLines: [],
    ...overrides,
  };
}

function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildTestPng(
  width: number,
  height: number,
  colorType: 2 | 6,
  pixelAt: (x: number, y: number) => [number, number, number, number?]
): Buffer {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixelAt(x, y);
      const pxOff = rowOff + 1 + x * bpp;
      raw[pxOff] = r & 0xff;
      raw[pxOff + 1] = g & 0xff;
      raw[pxOff + 2] = b & 0xff;
      if (bpp === 4) raw[pxOff + 3] = a & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filter
  ihdr[12] = 0; // non-interlaced
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ========================= 1. Invariant #2: Safe Script Writeback ========================= */

describe('1. Invariant #2: applyResults 2PC atomicity, .bak preservation & dual-track transcoding', () => {
  it('aborts atomically on file #2 0-match, >=2 ambiguous match, or explicit EncodeError with 0 writes to file #1', async () => {
    await withTempWorkspace(({ ws }) => {
      const rootDir = path.join(ws, 'unpacked', 'game');
      fs.mkdirSync(rootDir, { recursive: true });
      const f1 = path.join(rootDir, 'a_first.ks');
      const f2 = path.join(rootDir, 'b_second.ks');
      const orig1 = encodeText('おはよう[p]\r\n', 'utf-8');
      const orig2 = encodeText('同じ語 同じ語\r\n', 'cp932');
      fs.writeFileSync(f1, orig1);
      fs.writeFileSync(f2, orig2);

      const profile = makeProfile();
      const mem = makeMemory();

      // Case A: 0-match on file #2
      assert.throws(
        () =>
          applyResults(
            ws,
            'unpacked/game',
            [
              { id: '1', file: 'a_first.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true },
              { id: '2', file: 'b_second.ks', line: 1, track: 'scenario', source: '存在しない文', target: '不存在', ok: true },
            ],
            profile,
            mem,
            'scenario',
            { allowPartial: true }
          ),
        ApplyError
      );
      assert.ok(fs.readFileSync(f1).equals(orig1), 'file #1 must stay byte-identical on file #2 0-match');
      assert.equal(fs.existsSync(`${f1}.bak`), false, 'no .bak should be written on Phase 1 abort');

      // Case B: >=2 ambiguous match on file #2
      assert.throws(
        () =>
          applyResults(
            ws,
            'unpacked/game',
            [
              { id: '1', file: 'a_first.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true },
              { id: '2', file: 'b_second.ks', line: 1, track: 'scenario', source: '同じ語', target: '同词', ok: true },
            ],
            profile,
            mem,
            'scenario',
            { allowPartial: true }
          ),
        (err: unknown) => err instanceof ApplyError && err.message.includes('匹配 2 次')
      );
      assert.ok(fs.readFileSync(f1).equals(orig1), 'file #1 must stay untouched on ambiguous >=2 match');
      assert.equal(fs.existsSync(`${f1}.bak`), false);

      // Case C: explicit cp932 EncodeError on file #2 (Simplified Chinese chars unrepresentable in CP932)
      fs.writeFileSync(f2, encodeText('こんにちは\r\n', 'cp932'));
      assert.throws(
        () =>
          applyResults(
            ws,
            'unpacked/game',
            [
              { id: '1', file: 'a_first.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true },
              { id: '2', file: 'b_second.ks', line: 1, track: 'scenario', source: 'こんにちは', target: '你好欢迎纸杯工坊', ok: true },
            ],
            profile,
            mem,
            'scenario',
            { allowPartial: true, encoding: 'cp932' }
          ),
        (err: unknown) => err instanceof ApplyError && err.message.includes('cp932')
      );
      assert.ok(fs.readFileSync(f1).equals(orig1), 'file #1 must stay untouched on explicit EncodeError');
      assert.equal(fs.existsSync(`${f1}.bak`), false);
    });
  });

  it('aborts with zero disk side effects on QA failure and upgrades CP932 to utf-8-bom when encoding is auto', async () => {
    await withTempWorkspace(({ ws }) => {
      const rootDir = path.join(ws, 'unpacked', 'game');
      fs.mkdirSync(rootDir, { recursive: true });
      const f1 = path.join(rootDir, 'script.ks');
      const orig = encodeText('おはよう[p]\r\n', 'cp932');
      fs.writeFileSync(f1, orig);

      const profile = makeProfile();
      const mem = makeMemory();

      // Missing [p] triggers QA block before writing anything
      assert.throws(
        () =>
          applyResults(
            ws,
            'unpacked/game',
            [{ id: '1', file: 'script.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好', ok: true }],
            profile,
            mem,
            'scenario'
          ),
        ApplyError
      );
      assert.ok(fs.readFileSync(f1).equals(orig));
      assert.equal(fs.existsSync(`${f1}.bak`), false);
      assert.equal(fs.existsSync(path.join(ws, '.papercup', 'data', 'vn', 'apply.json')), false);

      // Implicit encoding upgrades CP932 -> utf-8-bom when Chinese chars cannot fit CP932
      const out = applyResults(
        ws,
        'unpacked/game',
        [{ id: '1', file: 'script.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '欢迎来到纸杯工坊[p]', ok: true }],
        profile,
        mem,
        'scenario'
      );
      assert.equal(out.applied, 1);
      assert.equal(out.report.files[0].encoding_before, 'cp932');
      assert.equal(out.report.files[0].encoding_after, 'utf-8-bom');
      const written = fs.readFileSync(f1);
      assert.ok(written.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
    });
  });

  it('preserves initial Japanese .bak across multi-track applies, enforces partial coverage gate, and detects applyStatus staleness', async () => {
    await withTempWorkspace(({ ws }) => {
      const rootDir = path.join(ws, 'unpacked', 'game');
      fs.mkdirSync(rootDir, { recursive: true });
      const scriptPath = path.join(rootDir, 'scene.ks');
      const origBytes = encodeText('おはよう[p]\r\n[button text="続ける"]\r\nさようなら[p]\r\n', 'cp932');
      fs.writeFileSync(scriptPath, origBytes);

      // Record manifest expecting 2 scenario rows and 1 ui row
      writeClassification(ws, '.papercup/data/build', {
        engine: 'kirikiri',
        profile: 'kag',
        warnings: [],
        files: ['scene.ks'],
        lines: [
          { id: '1', file: 'scene.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはよう[p]' },
          { id: '2', file: 'scene.ks', line: 2, scene: 's1', speaker: '', kind: 'button', source: '続ける' },
          { id: '3', file: 'scene.ks', line: 3, scene: 's1', speaker: '', kind: 'say', source: 'さようなら[p]' },
        ],
        scenario: [
          { id: '1', file: 'scene.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはよう[p]' },
          { id: '3', file: 'scene.ks', line: 3, scene: 's1', speaker: '', kind: 'say', source: 'さようなら[p]' },
        ],
        ui: [{ id: '2', file: 'scene.ks', line: 2, scene: 's1', speaker: '', kind: 'button', source: '続ける' }],
      });

      const profile = makeProfile();
      const mem = makeMemory();

      // Partial coverage (1/2) rejected by default
      assert.throws(
        () =>
          applyResults(
            ws,
            'unpacked/game',
            [{ id: '1', file: 'scene.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true }],
            profile,
            mem,
            'scenario'
          ),
        (err: unknown) => err instanceof ApplyError && err.message.includes('仅覆盖 1/2')
      );
      assert.ok(fs.readFileSync(scriptPath).equals(origBytes));

      // Explicit allowPartial succeeds and writes original .bak
      const partialOut = applyResults(
        ws,
        'unpacked/game',
        [{ id: '1', file: 'scene.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true }],
        profile,
        mem,
        'scenario',
        { allowPartial: true }
      );
      assert.equal(partialOut.partial, true);
      assert.ok(fs.readFileSync(`${scriptPath}.bak`).equals(origBytes));

      // Second track apply on the SAME file must NOT overwrite original .bak
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      const uiResPath = path.join(ws, '.papercup', 'data', 'results', 'ui.jsonl');
      fs.writeFileSync(
        uiResPath,
        JSON.stringify({ id: '2', file: 'scene.ks', line: 2, track: 'ui', source: '続ける', target: '继续', ok: true }) + '\n',
        'utf8'
      );
      const uiOut = applyResults(
        ws,
        'unpacked/game',
        [{ id: '2', file: 'scene.ks', line: 2, track: 'ui', source: '続ける', target: '继续', ok: true }],
        profile,
        mem,
        'ui'
      );
      assert.equal(uiOut.partial, false);
      assert.ok(fs.readFileSync(`${scriptPath}.bak`).equals(origBytes), 'Original Japanese .bak must survive second track apply');

      // applyStatus detects staleness when results/ui.jsonl changes
      const fresh = applyStatus(ws);
      assert.equal(fresh?.stale, false);
      fs.writeFileSync(
        uiResPath,
        JSON.stringify({ id: '2', file: 'scene.ks', line: 2, track: 'ui', source: '続ける', target: '继续游戏', ok: true }) + '\n',
        'utf8'
      );
      const staleAfterRes = applyStatus(ws);
      assert.equal(staleAfterRes?.stale, true);
      assert.ok(staleAfterRes?.staleReason.includes('译文结果已变更'));
    });
  });

  it('transcodes dual-track (scenario + ui) builtin writeback for XP3 (utf-16le-bom) and NSA (gbk)', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      // A. Dual-track KiriKiri XP3 -> patch.xp3 in UTF-16LE BOM
      const wsXp3 = path.join(root, 'dual-xp3');
      fs.mkdirSync(wsXp3, { recursive: true });
      fs.writeFileSync(path.join(wsXp3, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n', 'utf8');
      packDeltaXp3(
        [['scenario/first.ks', encodeText('*start\r\nおはよう[p]\r\n[button text="続ける"]\r\n', 'cp932')]],
        path.join(wsXp3, 'data.xp3')
      );
      await unpackVnArchives(wsXp3);
      fs.mkdirSync(path.join(wsXp3, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(wsXp3, '.papercup', 'data', 'results', 'scenario.jsonl'),
        JSON.stringify({ id: 's1', file: 'scenario/first.ks', line: 2, track: 'scenario', kind: 'say', source: 'おはよう[p]', target: '早上好[p]', ok: true }) + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(wsXp3, '.papercup', 'data', 'results', 'ui.jsonl'),
        JSON.stringify({ id: 'u1', file: 'scenario/first.ks', line: 3, track: 'ui', kind: 'button', source: '続ける', target: '继续游戏', ok: true }) + '\n',
        'utf8'
      );
      const xp3Out = path.join(root, 'patch-xp3');
      const wbXp3 = await writebackVnCopy(wsXp3, { dest: xp3Out });
      assert.equal(wbXp3.encoding, 'utf-16le-bom');
      const verifyXp3 = path.join(root, 'verify-xp3');
      unpackXp3(path.join(xp3Out, 'files', 'patch.xp3'), verifyXp3);
      const xp3Buf = fs.readFileSync(path.join(verifyXp3, 'scenario', 'first.ks'));
      assert.ok(xp3Buf.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])), 'Dual-track XP3 output must be UTF-16LE BOM');
      const xp3Text = xp3Buf.subarray(2).toString('utf16le');
      assert.ok(xp3Text.includes('早上好[p]') && xp3Text.includes('继续游戏'));

      // B. Dual-track NScripter NSA -> repacked arc.nsa in GBK + papercup_patch.ini
      const wsNsa = path.join(root, 'dual-nsa');
      fs.mkdirSync(wsNsa, { recursive: true });
      fs.writeFileSync(path.join(wsNsa, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n', 'utf8');
      fs.writeFileSync(
        path.join(wsNsa, 'arc.nsa'),
        buildNsaArchive([{ name: '0.txt', data: encodeText('おはよう、世界。\r\nselect "続ける",*start\r\n', 'cp932') }])
      );
      await unpackVnArchives(wsNsa);
      fs.mkdirSync(path.join(wsNsa, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(wsNsa, '.papercup', 'data', 'results', 'scenario.jsonl'),
        JSON.stringify({ id: 'n1', file: '0.txt', line: 1, track: 'scenario', kind: 'say', source: 'おはよう、世界。', target: '早上好，世界。', ok: true }) + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(wsNsa, '.papercup', 'data', 'results', 'ui.jsonl'),
        JSON.stringify({ id: 'n2', file: '0.txt', line: 2, track: 'ui', kind: 'choice', source: '続ける', target: '继续游戏', ok: true }) + '\n',
        'utf8'
      );
      const nsaOut = path.join(root, 'patch-nsa');
      const wbNsa = await writebackVnCopy(wsNsa, { dest: nsaOut });
      assert.equal(wbNsa.encoding, 'gbk');
      assert.equal(wbNsa.hook_needed, true);
      assert.equal(fs.existsSync(path.join(nsaOut, 'papercup_patch.ini')), true);
      const verifyNsa = path.join(root, 'verify-nsa');
      unpackNsa(path.join(nsaOut, 'files', 'arc.nsa'), verifyNsa);
      const nsaBuf = fs.readFileSync(path.join(verifyNsa, '0.txt'));
      assert.equal(detectEncoding(nsaBuf), 'gbk', 'Dual-track NSA script must be transcoded to GBK, not UTF-8');
      const nsaText = new TextDecoder('gbk', { fatal: true }).decode(nsaBuf);
      assert.ok(nsaText.includes('早上好，世界。') && nsaText.includes('继续游戏'));

      // C. generateBatches refuses overwrite without force=true
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'scenario.jsonl'),
        JSON.stringify({ id: '1', file: 'a.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはよう' }) + '\n',
        'utf8'
      );
      const cfg = {
        model: 'deepseek-chat',
        model_family: 'deepseek',
        batch_max_lines: 30,
        batch_max_source_tokens: 4000,
        session_max_source_tokens: 40000,
        concurrency: 2,
        margin_ratio: 0.1,
        note: 'init',
      };
      generateBatches(ws, cfg, { force: false });
      assert.throws(() => generateBatches(ws, cfg, { force: false }), PlanError);
      assert.doesNotThrow(() => generateBatches(ws, cfg, { force: true }));
      assert.throws(() => savePlanConfig(ws, { ...cfg, session_max_source_tokens: 1000 }, {}), PlanError);
    });
  });
});

/* ========================= 2. Path Traversal & Symlink Escape ========================= */

describe('2. Path traversal & symlink/junction escape guards', () => {
  it('rejects ../ traversal, directory junction escape, and dangling junction escape in insideWorkspace & staysInside', async () => {
    await withTempWorkspace(({ root, ws }) => {
      const outsideDir = path.join(root, 'outside-secret');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top-secret', 'utf8');

      // Lexical traversal
      assert.equal(insideWorkspace(ws, '../outside-secret/secret.txt'), null);
      assert.equal(insideWorkspace(ws, outsideDir), null);
      assert.throws(() => staysInside(ws, '../outside-secret/secret.txt'), ArchiveError);
      assert.throws(() => staysInside(ws, 'a/../../outside.txt'), ArchiveError);
      assert.throws(() => staysInside('.', 'C:/Windows/win.ini'), ArchiveError);
      assert.throws(() => staysInside('.', 'bad\x00name.txt'), ArchiveError);

      // Directory junction inside workspace pointing outside (works without admin on Windows & POSIX)
      const linkDir = path.join(ws, 'escape-link');
      fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(insideWorkspace(ws, 'escape-link/secret.txt'), null, 'existing file via outside junction must be blocked');
      assert.equal(insideWorkspace(ws, 'escape-link/nonexistent/new.txt'), null, 'non-existent file via outside junction must be blocked');
      assert.throws(() => staysInside(ws, 'escape-link/new-extracted.txt'), ArchiveError);

      // Dangling directory junction pointing to deleted outside directory
      const ephemeralOutside = path.join(root, 'ephemeral-outside');
      fs.mkdirSync(ephemeralOutside, { recursive: true });
      const danglingLink = path.join(ws, 'dangling-link');
      fs.symlinkSync(ephemeralOutside, danglingLink, process.platform === 'win32' ? 'junction' : 'dir');
      fs.rmdirSync(ephemeralOutside);
      assert.equal(insideWorkspace(ws, 'dangling-link/payload.txt'), null, 'dangling junction pointing outside must be blocked');
      assert.throws(() => staysInside(ws, 'dangling-link/payload.txt'), ArchiveError);
    });
  });

  it('blocks external path fallbacks in core.ts and workflow.ts and rejects install_rel/patch_rel escape in validateAcceptance', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n', 'utf8');
      packDeltaXp3([['a.ks', encodeText('おはよう\r\n', 'utf-8')]], path.join(ws, 'game.xp3'));

      const outsidePairs = path.join(root, 'outside-pairs.jsonl');
      fs.writeFileSync(outsidePairs, JSON.stringify({ source: 'おはよう', target: '早上好' }) + '\n', 'utf8');
      assert.throws(() => verifyVnQa(ws, { pairs: '../outside-pairs.jsonl' }), /工作区内/);
      assert.throws(() => verifyVnQa(ws, { pairs: outsidePairs }), /工作区内/);

      await assert.rejects(() => unpackVnArchives(ws, { dest: '../outside-unpacked' }), /工作区内/);
      await assert.rejects(() => repackVnArchives(ws, { source: '../outside-source' }), /工作区内/);

      const outsideReport = path.join(root, 'outside-report.json');
      fs.writeFileSync(outsideReport, JSON.stringify({ schema: 2, track: 'scenario' }), 'utf8');
      const repAcc = validateAcceptance(ws, homeDir, makeProfile(), makeMemory(), path.join(ws, 'game.xp3'), {
        reportPath: outsideReport,
      });
      assert.equal(repAcc.blocked, true);
      assert.ok(repAcc.findings.some((f) => f.rule === 'accept.report.missing'));

      // Prepare valid results for patch_manifest.json artifact path tests
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'),
        JSON.stringify({ id: '1', file: 'a.ks', line: 1, track: 'scenario', source: 'おはよう', target: '早上好', ok: true }) + '\n',
        'utf8'
      );

      // 1) install_rel traversal
      const patchDir1 = path.join(root, 'patch-bad-install');
      fs.mkdirSync(path.join(patchDir1, 'files'), { recursive: true });
      const artData = Buffer.from('patched', 'utf8');
      fs.writeFileSync(path.join(patchDir1, 'files', 'a.xp3'), artData);
      const manifest1 = path.join(patchDir1, 'patch_manifest.json');
      fs.writeFileSync(
        manifest1,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [
            { kind: 'overlay_archive', patch_rel: 'files/a.xp3', install_rel: '../../Windows/evil.dll', action: 'add', sha256: sha256Hex(artData), bytes: artData.length },
          ],
        }),
        'utf8'
      );
      const accBadInstall = acceptVnRelease(ws, { archive: manifest1, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(accBadInstall.blocked, true);
      assert.ok(accBadInstall.text.includes('accept.patch.artifact_outside'));

      // 2) patch_rel traversal
      const manifest2 = path.join(patchDir1, 'patch_manifest_rel.json');
      fs.writeFileSync(
        manifest2,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [
            { kind: 'overlay_archive', patch_rel: '../outside-pairs.jsonl', install_rel: 'patch.xp3', action: 'add', sha256: sha256Hex(artData), bytes: artData.length },
          ],
        }),
        'utf8'
      );
      // Rename to patch_manifest.json in its own dir so validateAcceptance parses it as patch_manifest.json
      const patchDir2 = path.join(root, 'patch-bad-rel');
      fs.mkdirSync(patchDir2, { recursive: true });
      const manifest2Proper = path.join(patchDir2, 'patch_manifest.json');
      fs.copyFileSync(manifest2, manifest2Proper);
      const accBadRel = acceptVnRelease(ws, { archive: manifest2Proper, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(accBadRel.blocked, true);
      assert.ok(accBadRel.text.includes('accept.patch.artifact_outside'));

      // 3) patch_rel via symlinked subdirectory pointing outside patchDir
      const patchDir3 = path.join(root, 'patch-symlink-art');
      const outsideArtDir = path.join(root, 'outside-art-target');
      fs.mkdirSync(patchDir3, { recursive: true });
      fs.mkdirSync(outsideArtDir, { recursive: true });
      fs.writeFileSync(path.join(outsideArtDir, 'escaped.xp3'), artData);
      fs.symlinkSync(outsideArtDir, path.join(patchDir3, 'files'), process.platform === 'win32' ? 'junction' : 'dir');
      const manifest3 = path.join(patchDir3, 'patch_manifest.json');
      fs.writeFileSync(
        manifest3,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [
            { kind: 'overlay_archive', patch_rel: 'files/escaped.xp3', install_rel: 'patch.xp3', action: 'add', sha256: sha256Hex(artData), bytes: artData.length },
          ],
        }),
        'utf8'
      );
      const accSymlinkArt = acceptVnRelease(ws, { archive: manifest3, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(accSymlinkArt.blocked, true);
      assert.ok(accSymlinkArt.text.includes('accept.patch.artifact_outside'));
    });
  });
});

/* ========================= 3. Archive Security & Malformed Boundaries ========================= */

describe('3. Archive formats, security boundaries & malformed inputs', () => {
  it('supports RPA-2.0/3.0/3.2 unpack + repack roundtrip and rejects malicious Pickle opcodes, truncation & Zip-Slip', async () => {
    await withTempWorkspace(({ root }) => {
      for (const ver of ['2.0', '3.0', '3.2'] as const) {
        const archPath = path.join(root, `test-${ver}.rpa`);
        const origData = Buffer.from(`label start:\n    "Hello ${ver}"\n`, 'utf8');
        fs.writeFileSync(archPath, buildRpaArchive(ver, [['script.rpy', origData]]));

        const outDir = path.join(root, `out-${ver}`);
        const names = unpackRpa(archPath, outDir);
        assert.deepEqual(names, ['script.rpy']);
        assert.ok(fs.readFileSync(path.join(outDir, 'script.rpy')).equals(origData));

        // Modify and repack roundtrip
        const updated = Buffer.from(`label start:\n    "你好 ${ver}"\n`, 'utf8');
        fs.writeFileSync(path.join(outDir, 'script.rpy'), updated);
        const repacked = path.join(root, `repacked-${ver}.rpa`);
        repackRpa(outDir, repacked);
        const verifyDir = path.join(root, `verify-${ver}`);
        unpackRpa(repacked, verifyDir);
        assert.ok(fs.readFileSync(path.join(verifyDir, 'script.rpy')).equals(updated));
      }

      // Restricted Pickle VM: reject GLOBAL os.system, REDUCE non-whitelisted, BUILD ('b'), INST ('i'), OBJ ('o')
      const maliciousPayloads: Array<[string, Buffer]> = [
        ['GLOBAL os.system', Buffer.from('cos\nsystem\n.', 'ascii')],
        ['STACK_GLOBAL os.system', Buffer.concat([Buffer.from([0x80, 0x04, 0x8c, 0x02]), Buffer.from('os'), Buffer.from([0x8c, 0x06]), Buffer.from('system'), Buffer.from([0x93, 0x2e])])],
        ['REDUCE arbitrary', Buffer.from([0x80, 0x02, 0x7d, 0x29, 0x52, 0x2e])],
        ['BUILD (0x62)', Buffer.from([0x80, 0x02, 0x7d, 0x62, 0x2e])],
        ['INST (0x69)', Buffer.from('i\nos\nsystem\n.', 'ascii')],
        ['OBJ (0x6f)', Buffer.from([0x80, 0x02, 0x28, 0x6f, 0x2e])],
        ['Truncated BINUNICODE', Buffer.from([0x80, 0x02, 0x58, 0xff, 0x00, 0x00, 0x00, 0x41])],
        ['Truncated BININT', Buffer.from([0x80, 0x02, 0x4a, 0x01])],
      ];
      for (const [label, pickleBuf] of maliciousPayloads) {
        const badPath = path.join(root, `evil-${label.replace(/[^a-z0-9]/gi, '_')}.rpa`);
        fs.writeFileSync(badPath, buildRawRpaWithPickle(pickleBuf));
        assert.throws(() => unpackRpa(badPath, path.join(root, 'evil-out')), ArchiveError, `Expected ArchiveError for ${label}`);
      }

      // RPA Zip-Slip rejected
      const slipPath = path.join(root, 'slip.rpa');
      fs.writeFileSync(slipPath, buildRpaArchive('3.0', [['../escape.rpy', Buffer.from('evil')]]));
      assert.throws(() => unpackRpa(slipPath, path.join(root, 'slip-out')), ArchiveError);
    });
  });

  it('supports XP3 v2 40B header roundtrip and rejects protected 0x80000000 entries, bad Adler32, truncation & Zip-Slip', async () => {
    await withTempWorkspace(({ root }) => {
      // XP3 v2 40-byte header
      const v2Path = path.join(root, 'v2.xp3');
      const body = encodeText('*start\r\nおはよう\r\n', 'utf-16le-bom');
      fs.writeFileSync(v2Path, buildXp3Custom([{ name: 'scenario/v2.ks', data: body }], { extraHeader: true }));
      const hdr = parseXp3Header(fs.readFileSync(v2Path).subarray(0, 64), fs.statSync(v2Path).size);
      assert.equal(hdr?.version, 'extra');

      const outV2 = path.join(root, 'v2-out');
      assert.deepEqual(unpackXp3(v2Path, outV2), ['scenario/v2.ks']);
      assert.ok(fs.readFileSync(path.join(outV2, 'scenario', 'v2.ks')).equals(body));
      const repackedV2 = path.join(root, 'v2-repacked.xp3');
      repackXp3(outV2, repackedV2);
      assert.equal(parseXp3Header(fs.readFileSync(repackedV2).subarray(0, 64), fs.statSync(repackedV2).size)?.version, 'extra');

      // Protected entry (TVP_XP3_FILE_PROTECTED = 0x80000000)
      const protPath = path.join(root, 'protected.xp3');
      fs.writeFileSync(protPath, buildXp3Custom([{ name: 'a.ks', data: Buffer.from('secret'), infoFlags: 0x80000000 }]));
      assert.throws(() => unpackXp3(protPath, path.join(root, 'prot-out')), (err: unknown) => err instanceof ArchiveError && err.message.includes('受保护'));

      // Corrupted Adler-32
      const badAdlerPath = path.join(root, 'bad-adler.xp3');
      fs.writeFileSync(badAdlerPath, buildXp3Custom([{ name: 'a.ks', data: Buffer.from('hello'), corruptAdler: true }]));
      assert.throws(() => unpackXp3(badAdlerPath, path.join(root, 'adler-out')), (err: unknown) => err instanceof ArchiveError && err.message.includes('校验和'));

      // Truncated XP3 header
      const truncPath = path.join(root, 'trunc.xp3');
      fs.writeFileSync(truncPath, Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01, 0x17, 0x00]));
      assert.throws(() => unpackXp3(truncPath, path.join(root, 'trunc-out')), ArchiveError);

      // XP3 Zip-Slip
      const slipPath = path.join(root, 'slip.xp3');
      fs.writeFileSync(slipPath, buildXp3Custom([{ name: '../escape.ks', data: Buffer.from('bad') }]));
      assert.throws(() => unpackXp3(slipPath, path.join(root, 'slip-xp3-out')), ArchiveError);
    });
  });

  it('enforces PE+ZIP CRC32 + Tyrano classification, NSA LZSS/malformed/NBZ boundaries, diagnostic-only engines & BFS scanWorkspace', async () => {
    await withTempWorkspace(({ root, ws, homeDir }) => {
      // PE+ZIP CRC32 mismatch rejected
      const badCrcExe = path.join(root, 'bad-crc.exe');
      fs.writeFileSync(badCrcExe, buildPeZip([['hello.txt', Buffer.from('hello world')]], { corruptCrc: true }));
      assert.throws(() => unpackPeZip(badCrcExe, path.join(root, 'bad-crc-out')), /CRC32/);

      // Non-Tyrano PE+ZIP (NW.js app:// + KiriKiri config.tjs without tyrano/) stays pe-zip
      const genericNwExe = path.join(root, 'generic-nw.exe');
      fs.writeFileSync(
        genericNwExe,
        buildPeZip([
          ['package.json', Buffer.from('{"main":"app://index.html"}')],
          ['data/config.tjs', Buffer.from(';krkr config')],
        ])
      );
      assert.equal(inspectPeZip(genericNwExe).engine, 'pe-zip');

      // Genuine Tyrano PE+ZIP with tyrano/tyrano.js -> tyrano
      const tyranoExe = path.join(root, 'tyrano.exe');
      fs.writeFileSync(tyranoExe, buildPeZip([['tyrano/tyrano.js', Buffer.from('var TYRANO={};')]]));
      assert.equal(inspectPeZip(tyranoExe).engine, 'tyrano');

      // NSA LZSS unpack works
      const lzssPath = path.join(root, 'lzss.nsa');
      const scriptPayload = encodeText('おはよう\r\n', 'cp932');
      fs.writeFileSync(lzssPath, buildNsaArchive([{ name: '0.txt', data: scriptPayload, compression: 2 }]));
      const lzssOut = path.join(root, 'lzss-out');
      assert.deepEqual(unpackNsa(lzssPath, lzssOut), ['0.txt']);
      assert.ok(fs.readFileSync(path.join(lzssOut, '0.txt')).equals(scriptPayload));

      // NSA malformed header rejected
      const badNsa = path.join(root, 'bad.nsa');
      fs.writeFileSync(badNsa, Buffer.from([0x00, 0x05, 0x00, 0x00, 0x00, 0x02]));
      assert.throws(() => loadNsaIndex(badNsa), ArchiveError);

      // NSA NBZ (type 4) diagnosed as unsupported (never reported as ready)
      const nbzWs = path.join(root, 'ws-nbz');
      fs.mkdirSync(nbzWs, { recursive: true });
      const nbzNsa = path.join(nbzWs, 'arc.nsa');
      fs.writeFileSync(nbzNsa, buildNsaArchive([{ name: '0.txt', data: Buffer.from('BZh91AY'), compression: 4 }]));
      assert.equal(loadNsaIndex(nbzNsa).hasNbz, true);
      const nbzScan = scanWorkspace(nbzWs, homeDir);
      assert.equal(nbzScan.hits.length, 0);
      assert.ok(nbzScan.unknown.some((u) => u.reason.includes('nbz')));
      assert.equal(
        selfCheckArchive(nbzNsa, { engine: 'nscripter', path: 'arc.nsa', kind: 'nsa', version: 'nsa', extra: {} }).ok,
        false
      );

      // Diagnostic-only boundaries: nscript.dat, Wolf RPG Data.wolf, Unity *_Data/resources.assets
      const diagWs = path.join(root, 'ws-diag');
      fs.mkdirSync(path.join(diagWs, 'MyGame_Data'), { recursive: true });
      fs.writeFileSync(path.join(diagWs, 'nscript.dat'), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      fs.writeFileSync(path.join(diagWs, 'Data.wolf'), Buffer.from([0x44, 0x58, 0x00, 0x00]));
      fs.writeFileSync(path.join(diagWs, 'Game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(path.join(diagWs, 'MyGame_Data', 'resources.assets'), Buffer.from([0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x40]));
      const diagScan = scanWorkspace(diagWs, homeDir);
      const kinds = new Set(diagScan.hits.map((h) => h.kind));
      assert.ok(kinds.has('nscript') && kinds.has('wolf') && kinds.has('serialized'));
      for (const h of diagScan.hits) {
        assert.ok(NO_UNPACKER_KINDS.has(h.kind), `Diagnostic-only kind ${h.kind} must be in NO_UNPACKER_KINDS`);
      }
      const diagSummary = detectVnEngineSummary(diagWs);
      assert.ok(diagSummary.text.includes('unsupported  当前没有解包器'));

      // Wolf incomplete layout without sibling Game.exe -> unknown
      const wolfIncomplete = path.join(root, 'ws-wolf-inc');
      fs.mkdirSync(wolfIncomplete, { recursive: true });
      fs.writeFileSync(path.join(wolfIncomplete, 'Data.wolf'), Buffer.from([0x44, 0x58, 0x00, 0x00]));
      const wolfIncScan = scanWorkspace(wolfIncomplete, homeDir);
      assert.equal(wolfIncScan.hits.length, 0);
      assert.ok(wolfIncScan.unknown.some((u) => u.reason.includes('wolf layout incomplete')));

      // scanWorkspace BFS: 270 .ogg files in audio/ must NOT starve data/scenario.xp3 or nested data/release/patch.xp3
      fs.mkdirSync(path.join(ws, 'audio'), { recursive: true });
      for (let i = 0; i < 270; i++) {
        fs.writeFileSync(path.join(ws, 'audio', `se_${String(i).padStart(3, '0')}.ogg`), Buffer.from('OggS'));
      }
      fs.mkdirSync(path.join(ws, 'data', 'release'), { recursive: true });
      packDeltaXp3([['a.ks', Buffer.from('hi')]], path.join(ws, 'data', 'scenario.xp3'));
      packDeltaXp3([['b.ks', Buffer.from('hi')]], path.join(ws, 'data', 'release', 'patch.xp3'));
      const bfsScan = scanWorkspace(ws, homeDir);
      const hitPaths = new Set(bfsScan.hits.map((h) => h.path));
      assert.ok(hitPaths.has('data/scenario.xp3'), `BFS must find data/scenario.xp3 past 270 .ogg files: ${[...hitPaths]}`);
      assert.ok(hitPaths.has('data/release/patch.xp3'), `BFS must not skip nested data/release/: ${[...hitPaths]}`);
    });
  });
});

/* ========================= 4. Acceptance / Release / Learn / Checkpoint Gates ========================= */

describe('4. Acceptance, release, skill learning & checkpoint negative gates', () => {
  it('enforces all vn_accept negative gates, quality unreviewed vs degraded, and cross-mode smoke allowlist', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n', 'utf8');
      packDeltaXp3([['scenario/a.ks', encodeText('おはよう[p]\r\nさようなら[p]\r\n', 'cp932')]], path.join(ws, 'data.xp3'));
      await unpackVnArchives(ws);

      writeClassification(ws, '.papercup/data/build', {
        engine: 'kirikiri',
        profile: 'kag',
        warnings: [],
        files: ['scenario/a.ks'],
        lines: [
          { id: 's1', file: 'scenario/a.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはよう[p]' },
          { id: 's2', file: 'scenario/a.ks', line: 2, scene: 's1', speaker: '', kind: 'say', source: 'さようなら[p]' },
        ],
        scenario: [
          { id: 's1', file: 'scenario/a.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはよう[p]' },
          { id: 's2', file: 'scenario/a.ks', line: 2, scene: 's1', speaker: '', kind: 'say', source: 'さようなら[p]' },
        ],
        ui: [],
      });

      const resDir = path.join(ws, '.papercup', 'data', 'results');
      fs.mkdirSync(resDir, { recursive: true });
      const scenFile = path.join(resDir, 'scenario.jsonl');
      const fullRows = [
        { id: 's1', file: 'scenario/a.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true },
        { id: 's2', file: 'scenario/a.ks', line: 2, track: 'scenario', source: 'さようなら[p]', target: '再见[p]', ok: true },
      ];

      // 1) Duplicate ID rejected by delegatedReport
      fs.writeFileSync(scenFile, [fullRows[0], { ...fullRows[1], id: 's1' }].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      assert.throws(
        () => delegatedReport(ws, makeProfile(), makeMemory(), '.papercup/data/results/scenario.jsonl', 'scenario', 'ok', { homeDir }),
        (err: unknown) => err instanceof AcceptanceError && err.message.includes('id 重复')
      );

      // 2) QA-blocked row rejected by delegatedReport
      fs.writeFileSync(scenFile, [fullRows[0], { ...fullRows[1], target: '再见' }].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      assert.throws(
        () => delegatedReport(ws, makeProfile(), makeMemory(), '.papercup/data/results/scenario.jsonl', 'scenario', 'ok', { homeDir }),
        (err: unknown) => err instanceof AcceptanceError && err.message.includes('未通过 QA')
      );

      // 3) Partial coverage rejected with accept.coverage.incomplete
      fs.writeFileSync(scenFile, JSON.stringify(fullRows[0]) + '\n', 'utf8');
      const partialAcc = acceptVnRelease(ws, { archive: path.join(ws, 'data.xp3'), track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(partialAcc.blocked, true);
      assert.ok(partialAcc.text.includes('accept.coverage.incomplete'));

      // 4) Write full rows and build delta patch bundle
      fs.writeFileSync(scenFile, fullRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      const patchDir = path.join(root, 'patch-acc');
      const wb = await writebackVnCopy(ws, { dest: patchDir });
      const manifestPath = String(wb.manifest_path);
      const manifestSha = sha256Hex(fs.readFileSync(manifestPath));

      // 5) residue_check=false rejected unless allowNoResidueCheck=true
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\nresidue_check = false\n', 'utf8');
      const resDisAcc = acceptVnRelease(ws, { archive: manifestPath, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(resDisAcc.blocked, true);
      assert.ok(resDisAcc.text.includes('accept.residue.disabled'));

      const resOverrideAcc = acceptVnRelease(ws, {
        archive: manifestPath,
        track: 'scenario',
        input: '.papercup/data/results/scenario.jsonl',
        allowNoResidueCheck: true,
      });
      assert.equal(resOverrideAcc.blocked, false);
      assert.ok(resOverrideAcc.text.includes('accept.residue.disabled_override'));

      // 6) quality === 'degraded' blocked vs quality === 'unreviewed' warning-only
      const prof = makeProfile();
      const mem = makeMemory();
      const degRep = delegatedReport(ws, prof, mem, '.papercup/data/results/scenario.jsonl', 'scenario', 'degraded', { homeDir })!;
      const degRes = validateAcceptance(ws, homeDir, prof, mem, manifestPath, { report: degRep });
      assert.equal(degRes.blocked, true);
      assert.ok(degRes.findings.some((f) => f.rule === 'accept.quality' && f.severity === 'error'));

      const unrevRep = delegatedReport(ws, prof, mem, '.papercup/data/results/scenario.jsonl', 'scenario', 'unreviewed', { homeDir })!;
      const unrevRes = validateAcceptance(ws, homeDir, prof, mem, manifestPath, { report: unrevRep });
      assert.equal(unrevRes.blocked, false);
      assert.ok(unrevRes.findings.some((f) => f.rule === 'accept.quality.unreviewed' && f.severity === 'warning'));
      assert.equal(unrevRes.record?.quality, 'unreviewed');

      // 7) Stale profile/memory/persona/output digests detected
      const staleProfRes = validateAcceptance(ws, homeDir, makeProfile({ narrativePov: 'third' }), mem, manifestPath, { report: unrevRep });
      assert.ok(staleProfRes.findings.some((f) => f.rule === 'accept.profile.stale'));
      const staleMemRes = validateAcceptance(ws, homeDir, prof, makeMemory({ glossary: { 先輩: '前辈' } }), manifestPath, { report: unrevRep });
      assert.ok(staleMemRes.findings.some((f) => f.rule === 'accept.memory.stale'));
      const stalePersonaRes = validateAcceptance(
        ws,
        homeDir,
        prof,
        makeMemory({ persona: { 美咲: { base: '冷静', stages: [], twists: [] } } }),
        manifestPath,
        { report: unrevRep }
      );
      assert.ok(stalePersonaRes.findings.some((f) => f.rule === 'accept.persona.stale'));

      // 8) Cross-mode smoke gate allowlist
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\n[vn.smoke]\nenabled = true\n',
        'utf8'
      );
      const smokeReportPath = path.join(ws, '.papercup', 'data', 'vn', 'smoke', 'report.json');
      fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true });
      const writeSmokeRep = (patchManifestSha256: string) => {
        fs.writeFileSync(
          smokeReportPath,
          JSON.stringify({
            schema: 1,
            createdAt: new Date().toISOString(),
            mode: 'manifest',
            patchManifestPath: manifestPath,
            patchManifestSha256,
            targetExe: 'game.exe',
            targetArch: 'x86',
            usedLocaleEmulator: false,
            usedTextractor: false,
            inputMode: 'background',
            durationMs: 1200,
            stepsAdvanced: 5,
            repairRound: 0,
            maxRepairRounds: 2,
            repairLimitReached: false,
            ok: true,
            errorCount: 0,
            warningCount: 0,
            findings: [],
            screenshots: [],
            summary: 'ok',
          }),
          'utf8'
        );
      };

      // Empty patchManifestSha256 must NOT bypass manifest acceptance
      writeSmokeRep('');
      const emptyShaAcc = acceptVnRelease(ws, { archive: manifestPath, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(emptyShaAcc.blocked, true);
      assert.ok(emptyShaAcc.text.includes('accept.smoke.stale'));

      // Valid manifest smoke report: rejects arbitrary untested standalone archive, accepts matching artifact in manifest
      writeSmokeRep(manifestSha);
      const rogueStandalone = path.join(root, 'untested-rogue.xp3');
      fs.writeFileSync(rogueStandalone, Buffer.from('ROGUE'));
      const rogueAcc = acceptVnRelease(ws, { archive: rogueStandalone, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(rogueAcc.blocked, true);
      assert.ok(rogueAcc.text.includes('accept.smoke.stale'));

      const patchXp3 = path.join(patchDir, 'files', 'patch.xp3');
      const legitArtAcc = acceptVnRelease(ws, { archive: patchXp3, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(legitArtAcc.blocked, false, `Expected manifest artifact SHA-256 to pass: ${legitArtAcc.text}`);

      // Non-gated mode must NOT attach unrelated manifest smoke record to rogue standalone archive
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n[vn.smoke]\nenabled = false\n', 'utf8');
      const nonGatedRogue = validateAcceptance(ws, homeDir, prof, mem, rogueStandalone, { report: unrevRep });
      assert.equal(nonGatedRogue.blocked, false);
      assert.equal(nonGatedRogue.record?.smoke, undefined);

      // 9) acceptanceState becomes stale on applyStatus stale OR deleted .papercup/data/results/scenario.jsonl
      const curProf = loadProfile(ws).profile!;
      const cleanAcc = acceptVnRelease(ws, { archive: manifestPath, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(cleanAcc.blocked, false);
      assert.equal(acceptanceState(ws, curProf, mem).state, 'accepted');

      // Mutate results -> stale
      const savedScen = fs.readFileSync(scenFile);
      fs.rmSync(scenFile);
      assert.equal(acceptanceState(ws, curProf, mem).state, 'stale', 'Deleting .papercup/data/results/scenario.jsonl must invalidate acceptanceState');
      fs.writeFileSync(scenFile, savedScen);
      assert.equal(acceptanceState(ws, curProf, mem).state, 'accepted');

      // Mutate apply.json manifest_digest -> applyStatus.stale -> acceptanceState stale
      const applyJsonPath = path.join(ws, '.papercup', 'data', 'vn', 'apply.json');
      const applyObj = JSON.parse(fs.readFileSync(applyJsonPath, 'utf8'));
      applyObj.manifest_digest = '0'.repeat(64);
      fs.writeFileSync(applyJsonPath, JSON.stringify(applyObj, null, 2), 'utf8');
      assert.equal(applyStatus(ws)?.stale, true);
      assert.equal(acceptanceState(ws, curProf, mem).state, 'stale');
    });
  });

  it('enforces vn_release forbidden phrases, 32 KiB humanClaim cap, missing ui track gate, overwrite/dryRun, and artifact SHA-256 re-check', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n', 'utf8');
      packDeltaXp3(
        [['scenario/a.ks', encodeText('おはよう[p]\r\n[button text="続ける"]\r\n', 'cp932')]],
        path.join(ws, 'data.xp3')
      );
      await unpackVnArchives(ws);
      writeClassification(ws, '.papercup/data/build', {
        engine: 'kirikiri',
        profile: 'kag',
        warnings: [],
        files: ['scenario/a.ks'],
        lines: [
          { id: 's1', file: 'scenario/a.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはよう[p]' },
          { id: 'u1', file: 'scenario/a.ks', line: 2, scene: 's1', speaker: '', kind: 'button', source: '続ける' },
        ],
        scenario: [{ id: 's1', file: 'scenario/a.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: 'おはよう[p]' }],
        ui: [{ id: 'u1', file: 'scenario/a.ks', line: 2, scene: 's1', speaker: '', kind: 'button', source: '続ける' }],
      });
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'),
        JSON.stringify({ id: 's1', file: 'scenario/a.ks', line: 1, track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true }) + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'results', 'ui.jsonl'),
        JSON.stringify({ id: 'u1', file: 'scenario/a.ks', line: 2, track: 'ui', source: '続ける', target: '继续', ok: true }) + '\n',
        'utf8'
      );

      const patchDir = path.join(root, 'patch-rel');
      const wb = await writebackVnCopy(ws, { dest: patchDir });
      const manifestPath = String(wb.manifest_path);

      // Accept ONLY scenario track -> release without --track must block due to missing ui track
      const accScen = acceptVnRelease(ws, { archive: manifestPath, track: 'scenario', input: '.papercup/data/results/scenario.jsonl' });
      assert.equal(accScen.blocked, false);
      assert.throws(() => releaseVnPatch(ws, { dryRun: true }), /缺少界面轨/);

      // Explicit single-track degradation allowed
      const singleDry = releaseVnPatch(ws, { track: 'scenario', dryRun: true });
      assert.ok(singleDry.includes('仅剧情轨'));
      assert.equal(fs.existsSync(path.join(ws, '.papercup', 'data', 'release', 'README.md')), false);

      // Accept ui track too
      const accUi = acceptVnRelease(ws, { archive: manifestPath, track: 'ui', input: '.papercup/data/results/ui.jsonl' });
      assert.equal(accUi.blocked, false);

      // Forbidden phrases in note and claimHumanReviewed
      assert.throws(() => releaseVnPatch(ws, { note: '本补丁由个人汉化完成', dryRun: true }), ReleaseError);
      const badClaimPath = path.join(ws, 'claim-bad.txt');
      fs.writeFileSync(badClaimPath, '本版本由人工汉化组精翻', 'utf8');
      assert.throws(() => releaseVnPatch(ws, { claimHumanReviewed: 'claim-bad.txt', dryRun: true }), ReleaseError);

      // Oversized claimHumanReviewed (> 32 KiB)
      const bigClaimPath = path.join(ws, 'claim-big.txt');
      fs.writeFileSync(bigClaimPath, 'A'.repeat(33 * 1024), 'utf8');
      assert.throws(() => releaseVnPatch(ws, { claimHumanReviewed: 'claim-big.txt', dryRun: true }), /32 KiB/);

      // Valid claim + write + overwrite=false guard
      const goodClaimPath = path.join(ws, 'claim-ok.txt');
      fs.writeFileSync(goodClaimPath, '已在本地审校关键对话并核对术语一致性。', 'utf8');
      const writtenMsg = releaseVnPatch(ws, { claimHumanReviewed: 'claim-ok.txt' });
      assert.ok(writtenMsg.includes('.papercup/data/release/README.md'));
      assert.throws(() => releaseVnPatch(ws, { overwrite: false }), ReleaseError);
      assert.doesNotThrow(() => releaseVnPatch(ws, { overwrite: true }));

      // Post-acceptance artifact tampering must block releaseVnPatch
      const patchXp3 = path.join(patchDir, 'files', 'patch.xp3');
      const origXp3 = fs.readFileSync(patchXp3);
      fs.writeFileSync(patchXp3, Buffer.concat([origXp3, Buffer.from('TAMPER')]));
      assert.throws(() => releaseVnPatch(ws, { dryRun: true }), /篡改|哈希/);
      fs.writeFileSync(patchXp3, origXp3);
    });
  });

  it('enforces vn_learn_skill 3-byte XOR, writeback roundtrip, reserved engine, .exe magic, SHA-256 tamper, and secret-filter bounds', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\n[vn.patch]\nopt_val = 7\n',
        'utf8'
      );
      const sampleBin = Buffer.concat([Buffer.from('CTK1', 'ascii'), encodeText('おはよう\r\n', 'cp932')]);
      fs.writeFileSync(path.join(ws, 'data.ctk'), sampleBin);
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));

      const realUnpack = [
        'import os, sys',
        'token = "a b".split()',
        'raw = open(sys.argv[1], "rb").read()',
        'assert raw[:4] == b"CTK1"',
        'os.makedirs(sys.argv[2], exist_ok=True)',
        'open(os.path.join(sys.argv[2], "s.txt"), "wb").write(raw[4:])',
      ].join('\n') + '\n';
      const realRepack = [
        'import os, sys',
        'secret = b"CTK1"[0:4]',
        'data = open(os.path.join(sys.argv[1], "s.txt"), "rb").read()',
        'open(sys.argv[2], "wb").write(secret + data)',
      ].join('\n') + '\n';
      const realExtract = [
        'import json, os, sys',
        'lines = open(os.path.join(sys.argv[1], "s.txt"), "rb").read().decode("cp932").splitlines()',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    for i, l in enumerate(lines, 1):',
        '        if l.strip(): f.write(json.dumps({"id": f"r{i}", "file": "s.txt", "line": i, "kind": "say", "source": l}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const realApply = [
        'import json, os, sys',
        'assert os.environ.get("PAPERCUP_WORKSPACE") and os.path.isdir(os.environ["PAPERCUP_WORKSPACE"])',
        'assert json.loads(os.environ.get("PAPERCUP_PATCH_OPTIONS_JSON", "{}")).get("opt_val") == 7',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING")',
        'assert enc == "cp932", f"bad enc {enc}"',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'open(os.path.join(sys.argv[2], "s.txt"), "wb").write(("\\r\\n".join(r["target"] for r in rows) + "\\r\\n").encode(enc))',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'unpack.py'), realUnpack, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'repack.py'), realRepack, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), realExtract, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), realApply, 'utf8');

      // 1) Reserved builtin engine name rejected
      const reservedRes = await learnVnSkill(ws, {
        engine: 'kirikiri',
        archive: 'data.ctk',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
        magicHex: '43544b31',
      });
      assert.equal(reservedRes.status, 'diagnosed');
      assert.ok(reservedRes.summary.includes('保留名称'));

      // 2) .exe without magicHex rejected
      const exeNoMagicRes = await learnVnSkill(ws, {
        engine: 'exeeng',
        archive: 'Game.exe',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
      });
      assert.equal(exeNoMagicRes.status, 'diagnosed');
      assert.ok(exeNoMagicRes.summary.includes('--magic'));

      // 3) Constant-output fake unpacker rejected by 3-byte XOR mutation
      fs.writeFileSync(
        path.join(ws, '.papercup', 'tmp', 'fake_unpack.py'),
        'import os, sys\nos.makedirs(sys.argv[2], exist_ok=True)\nopen(os.path.join(sys.argv[2], "s.txt"), "wb").write(b"constant")\n',
        'utf8'
      );
      const fakeRes = await learnVnSkill(ws, {
        engine: 'fakeeng',
        archive: 'data.ctk',
        unpackScript: '.papercup/tmp/fake_unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
        magicHex: '43544b31',
      });
      assert.equal(fakeRes.status, 'diagnosed');
      assert.ok(fakeRes.summary.includes('没有读取封包'));

      // 4) No-op apply.py rejected by _WB mutation check
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'noop_apply.py'), 'import sys\n', 'utf8');
      const noopRes = await learnVnSkill(ws, {
        engine: 'noopeng',
        archive: 'data.ctk',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/noop_apply.py',
        encoding: 'cp932',
        magicHex: '43544b31',
      });
      assert.equal(noopRes.status, 'diagnosed');
      assert.ok(noopRes.summary.includes('未生效'));

      // 5) Hardcoded API key rejected by containsSecret
      fs.writeFileSync(
        path.join(ws, '.papercup', 'tmp', 'leak_unpack.py'),
        realUnpack + 'api_key = "AIzaSySecretKeyLeakTest1234567890abcdef"\n',
        'utf8'
      );
      const leakRes = await learnVnSkill(ws, {
        engine: 'leakeng',
        archive: 'data.ctk',
        unpackScript: '.papercup/tmp/leak_unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
        magicHex: '43544b31',
      });
      assert.equal(leakRes.status, 'diagnosed');
      assert.ok(leakRes.summary.includes('疑似凭据'));

      // 6) Legitimate scripts (with `token = ...split()` & `secret = ...[0:4]`) succeed and land ONLY in project harness
      const goodRes = await learnVnSkill(ws, {
        engine: 'ctkeng',
        archive: 'data.ctk',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
        magicHex: '43544b31',
      });
      assert.equal(goodRes.status, 'adopted', `Expected adoption, got: ${JSON.stringify(goodRes)}`);
      assert.equal(fs.existsSync(path.join(homeDir, 'engines', 'ctkeng', 'engine.json')), false);
      assert.equal(fs.existsSync(path.join(projectHarnessDir(ws, homeDir), 'engine.json')), true);

      // 7) Tampering learned unpack.py causes SHA-256 mismatch and blocks vn_unpack
      const learnedUnpackPath = path.join(ws, '.papercup', 'skills', 'engine-ctkeng', 'unpack.py');
      const savedUnpack = fs.readFileSync(learnedUnpackPath, 'utf8');
      fs.writeFileSync(learnedUnpackPath, savedUnpack + '# tampered\n', 'utf8');
      assert.equal(skillBinding(ws, homeDir, 'ctkeng').state, 'mismatch');
      await assert.rejects(() => unpackVnArchives(ws), /哈希不一致/);

      // Restore & promote -> now self-contained global skills/engine-ctkeng/engine.json exists
      fs.writeFileSync(learnedUnpackPath, savedUnpack, 'utf8');
      assert.equal(skillBinding(ws, homeDir, 'ctkeng').state, 'ready');
      promoteVnSkill(ws, 'engine-ctkeng');
      assert.equal(fs.existsSync(path.join(homeDir, 'skills', 'engine-ctkeng', 'engine.json')), true);
      assert.equal(fs.existsSync(path.join(homeDir, 'skills', 'engine-ctkeng', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(homeDir, 'skills', 'engine-ctkeng', 'unpack.py')), true);
    });
  });

  it('enforces vn_learn_skill randomized target readback roundtrip, neighbor integrity, and low scenario coverage gate', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'game_direct'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
        'utf8'
      );

      // 3-line direct script fixture
      fs.writeFileSync(
        path.join(ws, 'game_direct', 'script.tbl'),
        ['おはよう世界', '今日もいい天気', 'また明日ね'].join('\n') + '\n',
        'utf8'
      );

      const goodExtract = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[1], "script.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    for i, line in enumerate(lines, 1):',
        '        if line.strip():',
        '            f.write(json.dumps({"id": f"row#{i}", "file": "script.tbl", "line": i, "kind": "say", "source": line}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const goodApply = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[2], "script.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    val = r.get("target") or r.get("source")',
        '    lines[idx] = val',
        'open(path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';

      // Defective apply #1: writes source unless target ends with legacy "_WB" marker (attempts to cheat old check)
      const cheatWbOnlyApply = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[2], "script.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    tgt = r.get("target", "")',
        '    lines[idx] = tgt if tgt.endswith("_WB") else r["source"]',
        'open(path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';

      // Defective apply #2: writes a hardcoded dummy string when target != source (mutates file bytes, but readback != target)
      const fakeMutateApply = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[2], "script.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    lines[idx] = (r["source"] + "_FIXED") if r.get("target") != r["source"] else r["source"]',
        'open(path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';

      // Defective apply #3: corrupts an untouched neighbor line on mutation
      const corruptNeighborApply = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[2], "script.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    tgt = r.get("target") or r["source"]',
        '    lines[idx] = tgt',
        '    if tgt != r["source"] and idx + 1 < len(lines):',
        '        lines[idx + 1] = "CORRUPTED_NEIGHBOR"',
        'open(path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';

      // Defective apply #4: changes total row count when mutating a line
      const rowCountShiftApply = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[2], "script.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    tgt = r.get("target") or r["source"]',
        '    lines[idx] = tgt',
        '    if tgt != r["source"]:',
        '        lines.pop()',
        'open(path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'ext_tbl.py'), goodExtract, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_good.py'), goodApply, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_cheat_wb.py'), cheatWbOnlyApply, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_fake_mut.py'), fakeMutateApply, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_neighbor.py'), corruptNeighborApply, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_rowcount.py'), rowCountShiftApply, 'utf8');

      // 1) Defective _WB-only apply.py is rejected (randomized token no longer ends with _WB)
      const cheatRes = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'tbleng',
        pipeline: 'direct',
        unpackedDir: 'game_direct',
        extractScript: '.papercup/tmp/ext_tbl.py',
        applyScript: '.papercup/tmp/app_cheat_wb.py',
        systemTextFiles: ['script.tbl'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(cheatRes.status, 'diagnosed');
      assert.ok(
        /target|未生效|不一致/.test(cheatRes.summary),
        `Expected target writeback rejection summary, got: ${cheatRes.summary}`
      );

      // 2) Defective apply.py writing fixed wrong string fails extract.py readback equality check
      const fakeMutRes = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'tbleng',
        pipeline: 'direct',
        unpackedDir: 'game_direct',
        extractScript: '.papercup/tmp/ext_tbl.py',
        applyScript: '.papercup/tmp/app_fake_mut.py',
        systemTextFiles: ['script.tbl'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(fakeMutRes.status, 'diagnosed');
      assert.ok(
        fakeMutRes.summary.includes('读回内容与预期 target 不一致'),
        `Expected readback target mismatch error, got: ${fakeMutRes.summary}`
      );

      // 3) Defective apply.py corrupting untouched neighbor row is rejected
      const neighborRes = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'tbleng',
        pipeline: 'direct',
        unpackedDir: 'game_direct',
        extractScript: '.papercup/tmp/ext_tbl.py',
        applyScript: '.papercup/tmp/app_neighbor.py',
        systemTextFiles: ['script.tbl'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(neighborRes.status, 'diagnosed');
      assert.ok(
        neighborRes.summary.includes('相邻未修改行'),
        `Expected untouched neighbor corruption error, got: ${neighborRes.summary}`
      );

      // 4) Defective apply.py changing total row count is rejected
      const rowShiftRes = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'tbleng',
        pipeline: 'direct',
        unpackedDir: 'game_direct',
        extractScript: '.papercup/tmp/ext_tbl.py',
        applyScript: '.papercup/tmp/app_rowcount.py',
        systemTextFiles: ['script.tbl'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(rowShiftRes.status, 'diagnosed');
      assert.ok(
        rowShiftRes.summary.includes('行数发生异常变化'),
        `Expected row count shift error, got: ${rowShiftRes.summary}`
      );

      // 5) Correct apply.py prioritizing row["target"] passes identity + randomized target + readback roundtrip
      const okRes = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'tbleng',
        pipeline: 'direct',
        unpackedDir: 'game_direct',
        extractScript: '.papercup/tmp/ext_tbl.py',
        applyScript: '.papercup/tmp/app_good.py',
        systemTextFiles: ['script.tbl'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(okRes.status, 'adopted', `Expected adoption for valid direct skill, got: ${JSON.stringify(okRes)}`);
      assert.ok(okRes.summary.includes('剧情 3 / 界面 0'), `Expected track stats in summary, got: ${okRes.summary}`);

      // 6) Low scenario coverage gate: 40 system rows + 2 say rows (total=42 >= 30, say=2 < 10 and 2/42 < 5%)
      const lowDir = path.join(ws, 'game_low_cov');
      fs.mkdirSync(lowDir, { recursive: true });
      const lowLines: string[] = [];
      for (let i = 1; i <= 40; i++) lowLines.push(`SYS:システム文字列_${i}`);
      lowLines.push('SAY:これは数少ない台詞その一です');
      lowLines.push('SAY:これは数少ない台詞その二です');
      fs.writeFileSync(path.join(lowDir, 'strings.tbl'), lowLines.join('\n') + '\n', 'utf8');

      const lowExtract = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[1], "strings.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    for i, line in enumerate(lines, 1):',
        '        tag, text = line.split(":", 1)',
        '        kind = "say" if tag == "SAY" else "system"',
        '        f.write(json.dumps({"id": f"l#{i}", "file": "strings.tbl", "line": i, "kind": kind, "source": text}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const lowApply = [
        'import json, os, sys',
        'path = os.path.join(sys.argv[2], "strings.tbl")',
        'lines = open(path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    tag = lines[idx].split(":", 1)[0]',
        '    lines[idx] = f"{tag}:{r.get(\'target\') or r[\'source\']}"',
        'open(path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'ext_low.py'), lowExtract, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_low.py'), lowApply, 'utf8');

      const blockedLowRes = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'lowcoveng',
        pipeline: 'direct',
        unpackedDir: 'game_low_cov',
        extractScript: '.papercup/tmp/ext_low.py',
        applyScript: '.papercup/tmp/app_low.py',
        systemTextFiles: ['strings.tbl'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(blockedLowRes.status, 'diagnosed');
      assert.ok(
        blockedLowRes.summary.includes('剧情覆盖率过低') && blockedLowRes.summary.includes('confirmLowScenarioCoverage'),
        `Expected low scenario coverage gate rejection, got: ${blockedLowRes.summary}`
      );

      // Explicitly confirming low scenario coverage adopts and reports track counts in summary
      const confirmedLowRes = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'lowcoveng',
        pipeline: 'direct',
        unpackedDir: 'game_low_cov',
        extractScript: '.papercup/tmp/ext_low.py',
        applyScript: '.papercup/tmp/app_low.py',
        systemTextFiles: ['strings.tbl'],
        encoding: 'utf-8',
        requireWriteback: true,
        confirmLowScenarioCoverage: true,
        note: 'Verified binary sections contain only system strings + 2 short dialogue stubs.',
      });
      assert.equal(confirmedLowRes.status, 'adopted', `Expected adoption with confirmLowScenarioCoverage=true: ${JSON.stringify(confirmedLowRes)}`);
      assert.ok(
        confirmedLowRes.summary.includes('共 42 行') && confirmedLowRes.summary.includes('剧情 2 / 界面 40'),
        `Expected track counts in summary, got: ${confirmedLowRes.summary}`
      );
    });
  });

  it('supports nested .exe discovery, exeOverride PE arch detection, direct writeback.encoding propagation, and GBK compat punctuation normalization', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      // 1) inspectPrimaryGameExe discovers depth=2/3 nested .exe while skipping backup/internal dirs and prioritizing non-uninstaller & shallower depth
      fs.mkdirSync(path.join(ws, 'backup'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'unpacked', 'sub'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'game', 'bin', 'release_x64'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'backup', 'HugeBackupGame.exe'), Buffer.concat([makeDummyPeExe('x64'), Buffer.alloc(4096)]));
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'InternalTool.exe'), Buffer.concat([makeDummyPeExe('x64'), Buffer.alloc(4096)]));
      fs.writeFileSync(path.join(ws, 'unpacked', 'sub', 'Unpacked.exe'), makeDummyPeExe('x64'));
      fs.writeFileSync(path.join(ws, 'unins000.exe'), Buffer.concat([makeDummyPeExe('x86'), Buffer.alloc(8192)]));
      fs.writeFileSync(path.join(ws, 'game', 'bin', 'release_x64', 'DeepGame.exe'), makeDummyPeExe('x64'));

      const deepExe = inspectPrimaryGameExe(ws);
      assert.equal(deepExe.exeRel, 'game/bin/release_x64/DeepGame.exe');
      assert.equal(deepExe.arch, 'x64');

      // Shallower non-uninstaller (depth=2) beats deeper non-uninstaller (depth=3)
      fs.writeFileSync(path.join(ws, 'game', 'bin', 'MidGame.exe'), makeDummyPeExe('x86'));
      const midExe = inspectPrimaryGameExe(ws);
      assert.equal(midExe.exeRel, 'game/bin/MidGame.exe');
      assert.equal(midExe.arch, 'x86');

      // 2) prepareSmokeSandbox (manifest) & prepareSmokeSandboxFromOverlay honor exeOverride PE arch when manifest target_arch === 'unknown'
      const patchDir = path.join(root, 'arch-patch');
      fs.mkdirSync(path.join(patchDir, 'files'), { recursive: true });
      const dummyPatch = Buffer.from('DATA', 'utf8');
      fs.writeFileSync(path.join(patchDir, 'files', 'override.bin'), dummyPatch);
      const manifestPath = path.join(patchDir, 'patch_manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          hook: { needed: false, mode: 'none', phase: 'phase1_config_ready', target_exe: null, target_arch: 'unknown' },
          artifacts: [
            {
              kind: 'replace_file',
              patch_rel: 'files/override.bin',
              install_rel: 'override.bin',
              action: 'add',
              sha256: sha256Hex(dummyPatch),
              bytes: dummyPatch.length,
            },
          ],
        }),
        'utf8'
      );

      const sbManifestX64 = prepareSmokeSandbox(ws, manifestPath, { exeOverride: 'game/bin/release_x64/DeepGame.exe' });
      try {
        assert.equal(sbManifestX64.exeRel, 'game/bin/release_x64/DeepGame.exe');
        assert.equal(sbManifestX64.exeArch, 'x64');
      } finally {
        sbManifestX64.cleanup();
      }
      const sbManifestX86 = prepareSmokeSandbox(ws, manifestPath, { exeOverride: 'game/bin/MidGame.exe' });
      try {
        assert.equal(sbManifestX86.exeRel, 'game/bin/MidGame.exe');
        assert.equal(sbManifestX86.exeArch, 'x86');
      } finally {
        sbManifestX86.cleanup();
      }

      const sbOverlayX64 = prepareSmokeSandboxFromOverlay(ws, path.join(patchDir, 'files'), {
        exeOverride: 'game/bin/release_x64/DeepGame.exe',
      });
      try {
        assert.equal(sbOverlayX64.exeArch, 'x64');
      } finally {
        sbOverlayX64.cleanup();
      }
      const sbOverlayX86 = prepareSmokeSandboxFromOverlay(ws, path.join(patchDir, 'files'), {
        exeOverride: 'game/bin/MidGame.exe',
      });
      try {
        assert.equal(sbOverlayX86.exeArch, 'x86');
      } finally {
        sbOverlayX86.cleanup();
      }

      // 3) Direct skill writeback.encoding='cp932' propagates to source_encoding & normalizes ・/〜 -> ·/～ in temp JSONL for GBK while leaving results/*.jsonl untouched
      const directWs = path.join(root, 'direct-cp932-ws');
      fs.mkdirSync(path.join(directWs, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(directWs, 'data_bin'), { recursive: true });
      fs.writeFileSync(
        path.join(directWs, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
        'utf8'
      );
      // Binary container with invalid UTF-8/CP932 header bytes so raw file sampling alone would report 'unknown'
      const binHeader = Buffer.from([0x80, 0xfe, 0xff, 0x80, 0x00, 0x01, 0x02, 0x03]);
      const samplePayload = encodeText('アリス・リーゼ～ようこそ', 'cp932');
      fs.writeFileSync(path.join(directWs, 'data_bin', 'story.bin'), Buffer.concat([binHeader, samplePayload]));

      const extractBinPy = [
        'import json, os, sys',
        'raw = open(os.path.join(sys.argv[1], "story.bin"), "rb").read()',
        'text = raw[8:].decode("cp932")',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    f.write(json.dumps({"id": "b#1", "file": "story.bin", "line": 1, "kind": "say", "source": text}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const applyBinPy = [
        'import json, os, sys',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING") or "cp932"',
        'raw = open(os.path.join(sys.argv[2], "story.bin"), "rb").read()',
        'tgt = rows[0].get("target") or rows[0]["source"]',
        'open(os.path.join(sys.argv[2], "story.bin"), "wb").write(raw[:8] + tgt.encode(enc))',
        'if enc.lower() == "gbk":',
        '    open(os.path.join(sys.argv[2], "received_target.txt"), "w", encoding="utf-8").write(tgt)',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(directWs, '.papercup', 'tmp', 'extract_bin.py'), extractBinPy, 'utf8');
      fs.writeFileSync(path.join(directWs, '.papercup', 'tmp', 'apply_bin.py'), applyBinPy, 'utf8');

      const learnedDirect = await learnUnpackSkill(directWs, {
        homeDir,
        engine: 'binlegacy',
        pipeline: 'direct',
        unpackedDir: 'data_bin',
        extractScript: '.papercup/tmp/extract_bin.py',
        applyScript: '.papercup/tmp/apply_bin.py',
        systemTextFiles: ['story.bin'],
        encoding: 'cp932',
        requireWriteback: true,
      });
      assert.equal(learnedDirect.status, 'adopted', `Direct cp932 skill failed: ${JSON.stringify(learnedDirect)}`);

      writeClassification(directWs, '.papercup/data/build', {
        engine: 'binlegacy',
        profile: 'plain',
        warnings: [],
        files: ['story.bin'],
        lines: [{ id: 'b#1', file: 'story.bin', line: 1, scene: '', speaker: '', kind: 'say', source: 'アリス・リーゼ～ようこそ' }],
        scenario: [{ id: 'b#1', file: 'story.bin', line: 1, scene: '', speaker: '', kind: 'say', source: 'アリス・リーゼ～ようこそ' }],
        ui: [],
      });

      const originalTargetWithCompatPunct = '爱丽丝・莉泽〜欢迎光临';
      const origResultJsonl =
        JSON.stringify({
          id: 'b#1',
          file: 'story.bin',
          line: 1,
          track: 'scenario',
          source: 'アリス・リーゼ～ようこそ',
          target: originalTargetWithCompatPunct,
          ok: true,
        }) + '\n';
      fs.mkdirSync(path.join(directWs, '.papercup', 'data', 'results'), { recursive: true });
      const resultsScenarioPath = path.join(directWs, '.papercup', 'data', 'results', 'scenario.jsonl');
      fs.writeFileSync(resultsScenarioPath, origResultJsonl, 'utf8');

      const directPatchOut = path.join(root, 'direct-cp932-patch');
      const wbDirect = await writebackVnCopy(directWs, { dest: directPatchOut });
      assert.equal(wbDirect.source_encoding, 'cp932', `Expected writeback.encoding='cp932' to propagate to source_encoding, got: ${wbDirect.source_encoding}`);
      assert.equal(wbDirect.encoding, 'gbk', `Expected zh-CN + cp932 direct skill to default to gbk, got: ${wbDirect.encoding}`);
      assert.equal(wbDirect.hook_needed, true);

      const receivedByApply = fs.readFileSync(path.join(directPatchOut, 'files', 'data_bin', 'received_target.txt'), 'utf8');
      assert.equal(
        receivedByApply,
        '爱丽丝·莉泽～欢迎光临',
        `Expected temp JSONL passed to apply.py to normalize ・/〜 to ·/～ for GBK, got: ${receivedByApply}`
      );
      // Original results/scenario.jsonl on disk MUST remain completely untouched
      assert.equal(fs.readFileSync(resultsScenarioPath, 'utf8'), origResultJsonl);
    });
  });

  it('keeps vn_checkpoint idempotent with untracked binaries and never stages .env', async () => {
    await withTempWorkspace(async ({ ws }) => {
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n', 'utf8');
      fs.writeFileSync(path.join(ws, '.env'), 'GEMINI_API_KEY=AIzaSyDummySecretValue000000000000000\n', 'utf8');
      fs.writeFileSync(path.join(ws, 'script.ain'), Buffer.alloc(4096, 0x41));
      fs.writeFileSync(path.join(ws, 'untracked_misc.xyz'), 'binary note', 'utf8');

      const cp1 = await createCheckpoint(ws, 'init', 'first snapshot');
      assert.equal(cp1.skipped_clean, false);

      // Second call with no VN changes must succeed with skipped_clean: true
      const cp2 = await createCheckpoint(ws, 'init', 'second no-op');
      assert.equal(cp2.skipped_clean, true);
      assert.equal(cp2.commit, cp1.commit);

      // Verify .env is NOT in git index / commit
      const { execFileSync } = await import('node:child_process');
      const tracked = execFileSync('git', ['ls-files'], { cwd: ws, encoding: 'utf8' });
      assert.equal(tracked.includes('.env'), false, '.env must never be staged in local Git checkpoint');
      assert.equal(tracked.includes('script.ain'), false, 'large binary .ain must never be staged');
    });
  });
});

/* ========================= 5. QA / Tokens / Profile / Packet / Smoke ========================= */

describe('5. QA, token estimation, profile/packet slicing & smoke engine rules', () => {
  it('validates qa.ts brackets, kana residue (allows ・, catches half-width), length limits, placeholders, custom controls & >200 priority', async () => {
    await withTempWorkspace(({ ws }) => {
      const prof = makeProfile({ maxLenRatio: 1.5, maxLenAbs: 12 });
      const gloss = { 学園祭: '学园祭', 学園: '学园' };

      // Unclosed bracket
      const unclosed = qaReport('おはよう', '早上好[p', prof, {});
      assert.ok(unclosed.blocked && unclosed.findings.some((f) => f.rule === 'control.unclosed'));

      // Kana residue: allows ・ (U+30FB), catches hiragana/katakana and half-width katakana
      assert.equal(qaReport('アリス・リーゼ', '爱丽丝・莉泽', makeProfile(), {}).blocked, false);
      assert.ok(qaReport('テスト', '测试ｱｲｳ', makeProfile(), {}).findings.some((f) => f.rule === 'source.residue'));
      assert.ok(qaReport('テスト', '测试あ', makeProfile(), {}).findings.some((f) => f.rule === 'source.residue'));

      // maxLenRatio and maxLenAbs
      assert.ok(qaReport('短い', '这是一段超过比例上限的译文', makeProfile({ maxLenRatio: 1.5 }), {}).findings.some((f) => f.rule === 'length.ratio'));
      assert.ok(qaReport('短い', '十三字绝对上限测试十三字超长', prof, {}).findings.some((f) => f.rule === 'length.absolute'));

      // Longest-match non-overlapping glossary (学園祭 wins over 学園; 学園祭 translated as 学园祭 satisfies without needing separate 学園 failure)
      assert.equal(qaReport('学園祭へようこそ', '欢迎来到学园祭', makeProfile(), gloss).blocked, false);
      assert.ok(qaReport('学園祭へようこそ', '欢迎来到校庆', makeProfile(), gloss).findings.some((f) => f.rule === 'glossary.missing'));

      // Placeholders ⟦0⟧, ⟦_0_1⟧, ⟦CTRL_0⟧ caught
      for (const bad of ['早上好⟦0⟧', '早上好⟦_0_1⟧', '早上好⟦CTRL_0⟧']) {
        assert.ok(qaReport('おはよう', bad, makeProfile(), {}).findings.some((f) => f.rule === 'placeholder.unrestored'));
      }

      // Custom controlPattern protects custom markup & prevents false kana residue inside custom control
      const customPat = '<C#[0-9A-Fa-f]{6}>|\\{voice:[^}]+\\}';
      assert.equal(
        qaReport('{voice:あゆめ}<C#FF0000>おはよう', '{voice:あゆめ}<C#FF0000>早上好', makeProfile(), {}, { controlPattern: customPat }).blocked,
        false
      );
      assert.ok(
        qaReport('<C#FF0000>おはよう', '早上好', makeProfile(), {}, { controlPattern: customPat }).findings.some((f) => f.rule === 'control.mismatch')
      );

      // verifyVnQa with >200 rows shows failing row #235 first with original index + residue_check=false warning
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\nresidue_check = false\n', 'utf8');
      const rows260: string[] = [];
      for (let i = 1; i <= 260; i++) {
        rows260.push(JSON.stringify({ source: 'おはよう[p]', target: i === 235 ? '早上好' : '早上好[p]' }));
      }
      fs.writeFileSync(path.join(ws, 'pairs260.jsonl'), rows260.join('\n') + '\n', 'utf8');
      const qaText = verifyVnQa(ws, { pairs: 'pairs260.jsonl' });
      assert.equal(qaText.blocked, true);
      assert.ok(qaText.text.includes('residue_check=false'));
      assert.ok(qaText.text.includes('235. [error] control.mismatch'));
      const qaJson = JSON.parse(verifyVnQa(ws, { pairs: 'pairs260.jsonl', json: true }).text);
      assert.equal(qaJson.total_pairs, 260);
      assert.equal(qaJson.failed_pairs, 1);
      assert.equal(qaJson.pairs[0].index, 235);
    });
  });

  it('tightens default control brackets, treats custom controlPattern as authoritative (+\\\\n), and checks unmatched bracket symmetry', () => {
    const prof = makeProfile();

    // 1) Default mode (no controlPattern): natural-language bracketed text is NOT treated as control tags
    assert.equal(qaReport('%s[音声なし]', '%s[无语音]', prof, {}).blocked, false);
    assert.equal(qaReport('[注釈]説明文', '[注释]说明文字', prof, {}).blocked, false);
    assert.equal(qaReport('[システム]保存しました', '[系统]已保存', prof, {}).blocked, false);

    // Default mode still strictly protects ASCII tag & printf-variable bracket forms
    assert.equal(qaReport('おはよう[p]', '早上好[p]', prof, {}).blocked, false);
    assert.ok(qaReport('おはよう[p]', '早上好', prof, {}).findings.some((f) => f.rule === 'control.mismatch'));
    assert.equal(qaReport('[ruby text=かな]漢字[/ruby]', '[ruby text=かな]汉字[/ruby]', prof, {}).blocked, false);
    assert.ok(
      qaReport('[ruby text=かな]漢字[/ruby]', '[ruby text=かな]汉字', prof, {}).findings.some((f) => f.rule === 'control.mismatch')
    );
    assert.equal(qaReport('座標[%d, %d]', '坐标[%d, %d]', prof, {}).blocked, false);
    assert.ok(qaReport('座標[%d, %d]', '坐标[%s, %d]', prof, {}).findings.some((f) => f.rule === 'control.mismatch'));

    // 2) Custom controlPattern is authoritative (plus universal literal \\n) without forcing KAG bracket rules
    const cPrintfPattern = '%(?:%|[-+0-9.# ]*[diouxXeEfFgGaAcspn])|[|]';
    assert.equal(
      qaReport('%s[音声なし]', '%s[无语音]', prof, {}, { controlPattern: cPrintfPattern }).blocked,
      false
    );
    assert.equal(
      qaReport('[tag]通常テキスト%02d|行二\\n行三', '[标签]普通文本%02d|第二行\\n第三行', prof, {}, { controlPattern: cPrintfPattern }).blocked,
      false
    );
    assert.ok(
      qaReport('%s|行一\\n行二', '行一\\n行二', prof, {}, { controlPattern: cPrintfPattern }).findings.some((f) => f.rule === 'control.mismatch')
    );
    assert.ok(
      qaReport('%s|行一\\n行二', '%s|行一行二', prof, {}, { controlPattern: cPrintfPattern }).findings.some((f) => f.rule === 'control.mismatch')
    );

    // 3) Unmatched bracket source/target symmetry
    assert.equal(
      qaReport(']は、既に存在します。\\n上書きしますか？', ']已存在。\\n是否覆盖？', prof, {}).blocked,
      false
    );
    assert.equal(
      qaReport('][CgName:foo]', '][CgName:foo]', prof, {}).blocked,
      false
    );
    assert.ok(
      qaReport('おはよう', '早上好[p', prof, {}).findings.some((f) => f.rule === 'control.unclosed')
    );
    assert.ok(
      qaReport('おはよう', '早上好]', prof, {}).findings.some((f) => f.rule === 'control.unclosed')
    );
    assert.ok(
      qaReport(']は存在します', ']]已存在', prof, {}).findings.some((f) => f.rule === 'control.unclosed')
    );
  });

  it('validates profile.ts & translation-packet.ts persona schema, scene inheritance, memory digest, TOML & encoding safety', async () => {
    await withTempWorkspace(({ ws, homeDir }) => {
      // Malformed PersonaCard stages/twists errors
      const parsed = parsePersonaMap({
        heroine: {
          base: 123 as unknown as string,
          stages: [{ from: 's1', voice: '' }, 'invalid' as unknown as Record<string, unknown>],
          twists: [{ at: '', note: 'twist' }, { at: 's2', note: 'ok', reveals: 456 as unknown as string }],
        },
      });
      assert.ok(parsed.errors.length >= 4);

      // sliceSpeakerHints scene-order inheritance + 180-char cap
      const makeUnit = (scene: string, source = '学園祭に行こう'): TranslationUnit => ({
        id: 'u1',
        track: 'scenario',
        file: 'a.ks',
        line: 1,
        scene,
        speaker: '美咲',
        kind: 'say',
        originalSource: source,
        envelope: { leadingControls: '', openingQuote: '', closingQuote: '', trailingControls: '' },
        cleanSource: source,
        inlineTokens: [],
        route: 'pending',
      });
      const persona = {
        美咲: {
          base: '礼貌冷静的学妹',
          stages: [
            { fromScene: 's1', voice: '保持敬语距离' },
            { fromScene: 's5', voice: '直呼名字撒娇' },
          ],
          twists: [{ atScene: 's2', note: '揭露身份', reveals: '其实是青梅竹马' }],
        },
      };
      const hS3 = sliceSpeakerHints([makeUnit('s3')], persona);
      assert.ok(hS3['美咲'].includes('保持敬语距离') && !hS3['美咲'].includes('直呼名字撒娇'));
      assert.ok(hS3['美咲'].includes('其实是青梅竹马'));
      const hS10 = sliceSpeakerHints([makeUnit('s10')], persona);
      assert.ok(hS10['美咲'].includes('直呼名字撒娇'), 'Natural scene order must sort s10 > s5');

      // 180-char hint cap + glossary longest-match slice
      const longHints = sliceSpeakerHints([makeUnit('s1')], {
        美咲: { base: '长'.repeat(240), stages: [], twists: [] },
      });
      assert.ok(longHints['美咲'].length <= 180);
      const glossSlice = sliceGlossaryForUnits([makeUnit('s1', '学園祭')], { 学園祭: '学园祭', 学園: '学园', 未使用: 'unused' });
      assert.deepEqual(glossSlice, { 学園祭: '学园祭' });

      // memoryDigest keeps only last 3 lessons (budget window)
      const memA = makeMemory({
        lessons: [
          { cue: 'c0', lesson: 'old-dropped-1', evidence: 'e0' },
          { cue: 'c1', lesson: 'l1', evidence: 'e1' },
          { cue: 'c2', lesson: 'l2', evidence: 'e2' },
          { cue: 'c3', lesson: 'l3', evidence: 'e3' },
        ],
      });
      const memB = makeMemory({
        lessons: [
          { cue: 'c0', lesson: 'different-dropped', evidence: 'e9' },
          { cue: 'c1', lesson: 'l1', evidence: 'e1' },
          { cue: 'c2', lesson: 'l2', evidence: 'e2' },
          { cue: 'c3', lesson: 'l3', evidence: 'e3' },
        ],
      });
      assert.equal(memoryDigest(memA), memoryDigest(memB));

      // Malformed TOML / invalid narrative_pov & inline # comments
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "invalid_pov" # bad\n', 'utf8');
      const badLoaded = loadProfile(ws);
      assert.equal(badLoaded.configured, true);
      assert.ok(badLoaded.errors.length > 0 && badLoaded.profile === null);

      const sections = parseTomlSections('[vn.research] # sec\nmax_reverser_tool_calls = 60 # inline\nlabel = "a # not comment"\n');
      assert.equal(sections['vn.research'].max_reverser_tool_calls, 60);
      assert.equal(sections['vn.research'].label, 'a # not comment');

      // isSafeCustomEncodingName rejects injection payloads
      assert.equal(isSafeCustomEncodingName('pal-charset'), true);
      assert.equal(isSafeCustomEncodingName('custom:pal_v2.1'), true);
      assert.equal(isSafeCustomEncodingName('custom:bad;rm -rf /'), false);
      assert.equal(isSafeCustomEncodingName('../evil'), false);
      assert.throws(() => normalizeEncodingName('unknown-enc'), /不支持的写回编码/);

      // detectEncoding distinguishes GBK, CP932, UTF-8, UTF-16LE BOM, and throws DecodeError on invalid bytes
      assert.equal(detectEncoding(encodeText('你好世界，欢迎来到纸杯工坊！', 'gbk')), 'gbk');
      assert.equal(detectEncoding(encodeText('おはよう、世界。', 'cp932')), 'cp932');
      assert.equal(detectEncoding(encodeText('早上好，世界。', 'utf-8')), 'utf-8');
      assert.equal(detectEncoding(encodeText('早上好', 'utf-16le-bom')), 'utf-16le-bom');
      assert.throws(() => detectEncoding(Buffer.from([0x80, 0xfe, 0xff, 0x80])), DecodeError);

      // resolveWorkspaceControlPattern reads writeback.control_pattern
      const hDir = projectHarnessDir(ws, homeDir);
      fs.mkdirSync(hDir, { recursive: true });
      fs.writeFileSync(path.join(hDir, 'engine.json'), JSON.stringify({ name: 'demo', writeback: { control_pattern: '<RUBY:[^>]+>' } }), 'utf8');
      assert.equal(resolveWorkspaceControlPattern(ws, homeDir), '<RUBY:[^>]+>');
    });
  });

  it('validates tokens.ts all model families, word boundaries & estimateWithMargin float precision', () => {
    const familySamples: Array<[string, string]> = [
      ['qwen-plus', 'qwen'],
      ['dashscope/custom', 'qwen'],
      ['deepseek-chat', 'deepseek'],
      ['gemini-2.5-pro', 'gemini'],
      ['google/custom-model', 'gemini'],
      ['claude-sonnet-4', 'claude'],
      ['anthropic/custom', 'claude'],
      ['gpt-4o', 'openai'],
      ['openai/o1-mini', 'openai'],
      ['o3-mini', 'openai'],
      ['o4-mini', 'openai'],
      ['glm-4-plus', 'glm'],
      ['kimi-k2', 'kimi'],
      ['moonshot-v1-8k', 'kimi'],
      ['MiniMax-M1', 'minimax'],
      ['step-2-16k', 'step'],
      ['doubao-seed-pro', 'doubao'],
      ['unknown-local-model', 'generic'],
    ];
    for (const [model, expected] of familySamples) {
      assert.equal(detectModelFamily(model), expected, `detectModelFamily(${model})`);
    }
    // Word-boundary & prefix-override regressions
    assert.equal(detectModelFamily('llama-pro1'), 'generic');
    assert.equal(detectModelFamily('hero3-chat'), 'generic');
    assert.equal(detectModelFamily('nextstep-7b'), 'generic');
    assert.equal(detectModelFamily('magpie/google/claude-sonnet'), 'claude');

    // Every registered MODEL_FAMILIES entry yields positive deterministic estimates
    for (const fam of Object.keys(MODEL_FAMILIES)) {
      assert.equal(resolveFamily('', fam), fam);
      const t = estimateTextTokens('おはようございます、学園へようこそ！123 abc', fam);
      assert.ok(t > 5, `Family ${fam} token estimate should be > 5`);
      const recT = estimateRecordTokens({ source: 'おはよう', speaker: '美咲', scene: 's1' }, fam);
      assert.ok(recT >= MODEL_FAMILIES[fam].overhead);
    }

    // IEEE-754 precision
    assert.equal(estimateWithMargin(0, 0.1), 0);
    assert.equal(estimateWithMargin(100, 0.1), 110);
    assert.equal(estimateWithMargin(100, 0.2), 120);
    assert.equal(estimateWithMargin(101, 0.1), 112);
    assert.equal(estimateWithMargin(50, -0.5), 50);
  });

  it('validates smoke sandbox copy vs hardlink isolation, Textractor UTF-16LE streaming, smoke rules, LE/Textractor config & vision JSON-first', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      // 1) prepareSmokeSandbox: <4 MiB / mutable files copied (no host inode mutation), >=4 MiB read-only archive hardlinked, nested data/release kept
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      const cfgIni = path.join(ws, 'config.ini');
      fs.writeFileSync(cfgIni, 'volume=100\r\n', 'utf8');
      fs.mkdirSync(path.join(ws, 'data', 'release'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'data', 'release', 'nested.txt'), 'keep me', 'utf8');
      const bigArchive = path.join(ws, 'voice.xp3');
      fs.writeFileSync(bigArchive, Buffer.alloc(4 * 1024 * 1024 + 64, 0x58));

      const patchDir = path.join(root, 'smoke-patch');
      fs.mkdirSync(path.join(patchDir, 'files'), { recursive: true });
      const patchPayload = Buffer.from('PATCHED_XP3', 'utf8');
      fs.writeFileSync(path.join(patchDir, 'files', 'patch.xp3'), patchPayload);
      const manifestPath = path.join(patchDir, 'patch_manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [{ kind: 'overlay_archive', patch_rel: 'files/patch.xp3', install_rel: 'patch.xp3', action: 'add', sha256: sha256Hex(patchPayload), bytes: patchPayload.length }],
        }),
        'utf8'
      );

      const sb = prepareSmokeSandbox(ws, manifestPath);
      try {
        // Mutating config.ini in sandbox MUST NOT mutate original workspace config.ini
        const sbIni = path.join(sb.sandboxDir, 'config.ini');
        fs.writeFileSync(sbIni, 'volume=0\r\n', 'utf8');
        assert.equal(fs.readFileSync(cfgIni, 'utf8'), 'volume=100\r\n');
        // Nested data/release/ must be preserved in sandbox
        assert.equal(fs.readFileSync(path.join(sb.sandboxDir, 'data', 'release', 'nested.txt'), 'utf8'), 'keep me');
        // Large >=4 MiB read-only .xp3 archive uses hardlink (same inode)
        const origStat = fs.statSync(bigArchive);
        const sbArchiveStat = fs.statSync(path.join(sb.sandboxDir, 'voice.xp3'));
        assert.equal(sbArchiveStat.ino, origStat.ino, '>=4 MiB read-only archive should be hardlinked into sandbox');
      } finally {
        sb.cleanup();
      }

      // 2) createTextractorStreamParser: UTF-16LE odd-byte split, 1-byte init split, pure-CJK chunk, split header
      const parser = createTextractorStreamParser();
      const rawLine1 = '[2:1A4:00401000:0:0:TextOutA:0] 早上好，世界。\r\n';
      const rawLine2 = '[2:1A4:00401000:0:0:TextOutA:0] 欢迎来到纸杯工坊';
      const fullUtf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rawLine1 + rawLine2, 'utf16le')]);
      const collected: string[] = [];
      // Feed 1 byte first, then odd-sized chunks (3, 5, 7 bytes) to stress odd-byte code-unit boundaries & pure-CJK chunks
      const splitSizes = [1, 3, 5, 7, 11, 13, 19, 999];
      let offset = 0;
      let si = 0;
      while (offset < fullUtf16.length) {
        const take = splitSizes[Math.min(si++, splitSizes.length - 1)];
        collected.push(...parser.push(fullUtf16.subarray(offset, offset + take)));
        offset += take;
      }
      collected.push(...parser.flush());
      assert.deepEqual(collected, ['早上好，世界。', '欢迎来到纸杯工坊']);

      // 3) evaluateSmokeRules: runtime.error_dialog, runtime.hang (error & warning), hook.unavailable, vision.defect(error), text.not_patched homograph & pure-kanji UTF-8-as-CP932 mojibake
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'),
        [
          { id: '1', source: '学生会室', target: '学生会室', ok: true }, // homograph
          { id: '2', source: 'おはようございます、先輩。', target: '早上好，前辈。', ok: true },
          { id: '3', source: '今日はとても良い天気ですね。', target: '今天天气真好呢。', ok: true },
          { id: '4', source: '世界へようこそ', target: '你好世界，欢迎来到纸杯工坊！', ok: true },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n',
        'utf8'
      );

      // Rule coverage: error_dialog + hang(error) + hook.unavailable(arch mismatch) + vision.defect(error)
      const evalMulti = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          errorDialog: { title: 'Fatal', text: 'Script syntax error' },
          hungDetected: true,
        }),
        workspace: ws,
        targetLang: 'zh-CN',
        textractorConfigured: true,
        textractorArchMismatch: { exeArch: 'x64' },
        visionEnabled: true,
        visionInspection: {
          status: 'checked',
          defects: [{ severity: 'error', kind: 'mojibake', description: 'Explicit mojibake visible', frame: 'dialogue_start' }],
        },
      });
      const rules = new Map(evalMulti.findings.map((f) => [f.ruleId, f.severity]));
      assert.equal(rules.get('runtime.error_dialog'), 'error');
      assert.equal(rules.get('runtime.hang'), 'error');
      assert.equal(rules.get('hook.unavailable'), 'warning');
      assert.equal(rules.get('vision.defect'), 'error');

      // Frozen screen (non-hung) reports runtime.hang warning
      const evalFrozen = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          frozenScreen: true,
        }),
        workspace: ws,
        targetLang: 'zh-CN',
        textractorConfigured: false,
        visionEnabled: false,
      });
      assert.ok(
        evalFrozen.findings.some((f) => f.ruleId === 'runtime.hang' && f.severity === 'warning'),
        `Frozen screen must report runtime.hang warning: ${JSON.stringify(evalFrozen.findings)}`
      );

      // Homograph ("学生会室") must NOT bypass text.not_patched when >=2 source lines appear
      const evalNotPatched = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          textractorLines: ['学生会室', 'おはようございます、先輩。', '今日はとても良い天気ですね。'],
        }),
        workspace: ws,
        targetLang: 'zh-CN',
        textractorConfigured: true,
        visionEnabled: false,
      });
      assert.ok(
        evalNotPatched.findings.some((f) => f.ruleId === 'text.not_patched' && f.severity === 'error'),
        `Homograph must not bypass text.not_patched: ${JSON.stringify(evalNotPatched.findings)}`
      );

      // Pure-kanji UTF-8 decoded as CP932 ("你好世界，欢迎来到纸杯工坊！" -> CP932) triggers text.mojibake
      const garbledCp932 = new TextDecoder('shift_jis', { fatal: false }).decode(Buffer.from('你好世界，欢迎来到纸杯工坊！', 'utf8'));
      const evalMojibake = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          textractorLines: [garbledCp932],
        }),
        workspace: ws,
        targetLang: 'zh-CN',
        textractorConfigured: true,
        visionEnabled: false,
      });
      assert.ok(
        evalMojibake.findings.some((f) => f.ruleId === 'text.mojibake' && f.severity === 'error'),
        `UTF-8-as-CP932 mojibake must trigger text.mojibake: ${JSON.stringify(evalMojibake.findings)}`
      );

      // 4) Locale Emulator: never falls back to profiles[0] (ja-JP) when CP936 missing; isolates zh-CN (936) vs zh-TW (950)
      const leDir = path.join(root, 'le');
      fs.mkdirSync(leDir, { recursive: true });
      const leProc = path.join(leDir, 'LEProc.exe');
      fs.writeFileSync(leProc, makeDummyPeExe('x86'));
      fs.writeFileSync(
        path.join(leDir, 'LEConfig.xml'),
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<LEConfig><Profiles>',
          '  <Profile Name="Run in Japanese" Guid="guid-ja"><Location>ja-JP</Location></Profile>',
          '  <Profile Name="Run in Traditional Chinese" Guid="guid-tw"><Location>zh-TW</Location></Profile>',
          '</Profiles></LEConfig>',
        ].join('\n'),
        'utf8'
      );
      assert.equal(findLocaleEmulatorProfileGuid(leProc, 936), null, 'CP936 must NOT fall back to ja-JP or zh-TW');
      assert.equal(findLocaleEmulatorProfileGuid(leProc, 950), 'guid-tw');
      assert.equal(findLocaleEmulatorProfileGuid(leProc, 932), 'guid-ja');

      // 5) Textractor arch selection: never cross-fallback x64 <-> x86
      const trDir = path.join(root, 'textractor');
      fs.mkdirSync(path.join(trDir, 'x86'), { recursive: true });
      fs.writeFileSync(path.join(trDir, 'x86', 'TextractorCLI.exe'), makeDummyPeExe('x86'));
      const toolsOnlyX86 = inspectSmokeTools({ ...DEFAULT_SMOKE_CONFIG, textractorPath: trDir });
      assert.equal(selectTextractorCliForArch(toolsOnlyX86, 'x86'), path.join(trDir, 'x86', 'TextractorCLI.exe'));
      assert.equal(selectTextractorCliForArch(toolsOnlyX86, 'x64'), null, 'x64 game must NOT fall back to x86 Textractor');

      // 6) smoke-vision: valid JSON parsed BEFORE REFUSAL_RE even when text contains "Explicit"/"safety"/"inappropriate"
      const dummyPng = path.join(root, 'frame.png');
      fs.writeFileSync(dummyPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const fakeModel = { id: 'vision-v1', provider: 'test', input: ['text', 'image'] } as any;

      const jsonWithTriggerWordsBridge = createSmokeVisionBridge({
        getModel: () => fakeModel,
        getModelRuntime: () =>
          ({
            completeSimple: async () => ({
              stopReason: 'stop',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    defects: [{ severity: 'error', kind: 'mojibake', description: 'Explicit mojibake in safety dialog', frame: 'title' }],
                  }),
                },
              ],
            }),
          }) as any,
      });
      const inspected = await jsonWithTriggerWordsBridge.inspectFrames!([{ label: 'title', path: dummyPng }], {
        targetLang: 'zh-CN',
        sampleTranslations: [],
      });
      assert.equal(inspected.status, 'checked');
      assert.equal(inspected.defects.length, 1);
      assert.equal(inspected.defects[0].severity, 'error');

      const locateWithTriggerWordsBridge = createSmokeVisionBridge({
        getModel: () => fakeModel,
        getModelRuntime: () =>
          ({
            completeSimple: async () => ({
              stopReason: 'stop',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ found: true, xNorm: 0.5, yNorm: 0.72, label: 'Start (Explicit Safety Mode)' }),
                },
              ],
            }),
          }) as any,
      });
      const located = await locateWithTriggerWordsBridge.locateStartButton!(dummyPng);
      assert.equal(located.found, true);
      assert.equal(located.xNorm, 0.5);
      assert.equal(located.yNorm, 0.72);

      const plainRefusalBridge = createSmokeVisionBridge({
        getModel: () => fakeModel,
        getModelRuntime: () =>
          ({
            completeSimple: async () => ({
              stopReason: 'stop',
              content: [{ type: 'text', text: 'Sorry, I cannot analyze this image due to safety policy.' }],
            }),
          }) as any,
      });
      const refused = await plainRefusalBridge.inspectFrames!([{ label: 'title', path: dummyPng }], {
        targetLang: 'zh-CN',
        sampleTranslations: [],
      });
      assert.equal(refused.status, 'skipped');
    });
  });

  it('enforces client-area PrintWindow capture, stateful Textractor thread filtering, generic large-file hardlink policy, and vision OS-chrome ignore prompt', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      // 1) writeWindowsSmokeDriverScript emits UTF-8 BOM and uses PW_CLIENTONLY | PW_RENDERFULLCONTENT in CaptureClientPng
      const ps1Path = path.join(root, 'driver', '_papercup_smoke_driver.ps1');
      writeWindowsSmokeDriverScript(ps1Path);
      const rawPs1Buf = fs.readFileSync(ps1Path);
      assert.equal(rawPs1Buf[0], 0xef);
      assert.equal(rawPs1Buf[1], 0xbb);
      assert.equal(rawPs1Buf[2], 0xbf);
      const ps1Src = rawPs1Buf.toString('utf8');
      const captureFnMatch = /CaptureClientPng\([\s\S]*?^\s{4}\}/m.exec(ps1Src);
      assert.ok(captureFnMatch, 'Expected CaptureClientPng method in Windows smoke driver script');
      assert.ok(
        /PrintWindow\s*\(\s*hwnd\s*,\s*hdc\s*,\s*PW_CLIENTONLY\s*\|\s*PW_RENDERFULLCONTENT\s*\)/.test(captureFnMatch![0]),
        `CaptureClientPng must pass PW_CLIENTONLY | PW_RENDERFULLCONTENT to PrintWindow:\n${captureFnMatch![0]}`
      );

      // 2) createTextractorStreamParser discards multi-line Clipboard & Console continuations while keeping Engine text
      const streamText = [
        "[0:0:Clipboard] import pandas as pd",
        "data_zs = pd.read_csv('a.csv')",
        "print(1)",
        "[1:2:Engine] 你好世界",
        "多行续句正常保留",
        "[0:0:Console] Textractor CLI attached",
        "console stray continuation line",
        "[1:2:Engine] 第二句台词",
      ].join('\r\n') + '\r\n';
      for (const enc of ['utf8', 'utf16le'] as const) {
        const parser = createTextractorStreamParser();
        const payload =
          enc === 'utf16le'
            ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(streamText, 'utf16le')])
            : Buffer.from(streamText, 'utf8');
        const out: string[] = [];
        // Split across arbitrary small chunk boundaries to test stateful line buffering
        for (let off = 0; off < payload.length; off += 7) {
          out.push(...parser.push(payload.subarray(off, off + 7)));
        }
        out.push(...parser.flush());
        assert.deepEqual(
          out,
          ['你好世界', '多行续句正常保留', '第二句台词'],
          `Stateful Textractor parser (${enc}) leaked Clipboard/Console lines or dropped Engine lines: ${JSON.stringify(out)}`
        );
      }

      // 3) Sandbox hardlink policy: any non-mutable ext >= 4 MiB (.customarc) is hardlinked (same ino),
      //    while mutable ext (.ini) >= 4 MiB is copied (different ino, host untouched on edit)
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      const bigCustomArc = path.join(ws, 'assets.customarc');
      const bigMutableIni = path.join(ws, 'large_config.ini');
      fs.writeFileSync(bigCustomArc, Buffer.alloc(4 * 1024 * 1024 + 128, 0x41));
      fs.writeFileSync(bigMutableIni, Buffer.alloc(4 * 1024 * 1024 + 128, 0x42));

      const patchDir = path.join(root, 'hl-patch');
      fs.mkdirSync(path.join(patchDir, 'files'), { recursive: true });
      const overlayBytes = Buffer.from('OVERLAY', 'utf8');
      fs.writeFileSync(path.join(patchDir, 'files', 'p.bin'), overlayBytes);
      const manifestPath = path.join(patchDir, 'patch_manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [
            {
              kind: 'replace_file',
              patch_rel: 'files/p.bin',
              install_rel: 'p.bin',
              action: 'add',
              sha256: sha256Hex(overlayBytes),
              bytes: overlayBytes.length,
            },
          ],
        }),
        'utf8'
      );

      const sb = prepareSmokeSandbox(ws, manifestPath);
      try {
        const origArcStat = fs.statSync(bigCustomArc);
        const sbArcStat = fs.statSync(path.join(sb.sandboxDir, 'assets.customarc'));
        assert.equal(sbArcStat.ino, origArcStat.ino, 'Non-mutable >=4 MiB .customarc must be hardlinked (same ino)');

        const origIniStat = fs.statSync(bigMutableIni);
        const sbIniPath = path.join(sb.sandboxDir, 'large_config.ini');
        const sbIniStat = fs.statSync(sbIniPath);
        assert.notEqual(sbIniStat.ino, origIniStat.ino, 'Mutable >=4 MiB .ini must be copied (different ino)');
        fs.writeFileSync(sbIniPath, 'mutated=1\n', 'utf8');
        assert.equal(fs.statSync(bigMutableIni).size, 4 * 1024 * 1024 + 128);
      } finally {
        sb.cleanup();
      }

      // 4) smoke-vision.ts prompt explicitly instructs ignoring OS window title bar / window borders
      const dummyPng = path.join(root, 'vision-frame.png');
      fs.writeFileSync(dummyPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      let capturedPromptText = '';
      const visionBridge = createSmokeVisionBridge({
        getModel: () => ({ id: 'vision-test', provider: 'test', input: ['text', 'image'] }) as any,
        getModelRuntime: () =>
          ({
            completeSimple: async (_model: any, ctx: any) => {
              const parts = ctx?.messages?.[0]?.content ?? [];
              capturedPromptText = parts
                .filter((p: any) => p?.type === 'text')
                .map((p: any) => p.text)
                .join('\n');
              return { stopReason: 'stop', content: [{ type: 'text', text: '{"defects":[]}' }] };
            },
          }) as any,
      });
      const res = await visionBridge.inspectFrames!([{ label: 'dialogue_start', path: dummyPng }], {
        targetLang: 'zh-CN',
        sampleTranslations: ['早上好'],
      });
      assert.equal(res.status, 'checked');
      assert.ok(
        /IGNORE OS non-client chrome/i.test(capturedPromptText) &&
          /title bar/i.test(capturedPromptText) &&
          /borders/i.test(capturedPromptText),
        `Expected smoke-vision prompt to explicitly ignore OS title bar & borders, got:\n${capturedPromptText}`
      );
    });
  });
});

describe('6. Character roster extraction, confirmation forms, memory overlay, cross-row QA & packet slicing', () => {
  it('deterministically extracts RenPy Character() speakerIds, inline 【…】, and Tyrano #name while excluding hex colors', async () => {
    await withTempWorkspace(async ({ ws }) => {
      // 1) Ren'Py workspace: define e = Character("エル"), dialogue lines, and inline 【サブキャラ】
      const unpackedRenpy = path.join(ws, '.papercup', 'tmp', 'unpacked');
      fs.mkdirSync(path.join(unpackedRenpy, 'game'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nglossary_file = "glossary.json"\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, 'glossary.json'),
        JSON.stringify({ 'エル': '旧艾露' }, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(unpackedRenpy, 'game', 'script.rpy'),
        [
          'define e = Character("エル", color="#ff00aa")',
          'label start:',
          '    e "おはよう、先輩！"',
          '    e "今日もいい天気だね。"',
          '    e "放課後に図書室へ行こう。"',
          '    e "四行目の台詞（上限3件のサンプル検証）"',
          '    "【サブキャラ】「ちょっと待って！」"',
          '    "地の文だけのナレーション。"',
          '',
        ].join('\n'),
        'utf8'
      );

      const cls = classifyUnpacked(unpackedRenpy, { engine: 'renpy' });
      const nameRow = cls.ui.find((r) => r.kind === 'name' && r.source === 'エル');
      assert.ok(nameRow, `Expected classifyUnpacked to emit kind="name" row for エル: ${JSON.stringify(cls.ui)}`);
      assert.equal(nameRow!.speaker, 'e', 'classifyRenpy must capture speaker identifier "e" on define e = Character("エル")');

      writeClassification(ws, '.papercup/data/build', cls);
      const extracted = extractCharacterCandidates(ws);
      assert.equal(extracted.status, 'unconfirmed');
      assert.equal(extracted.engine, 'renpy');
      assert.ok(extracted.classifyDigest.length > 0);
      assert.equal(extracted.totalCharacters, 2);

      const elle = extracted.characters.find((c) => c.sourceName === 'エル');
      assert.ok(elle, `Expected エル candidate in ${JSON.stringify(extracted.characters)}`);
      assert.deepEqual(elle!.speakerIds, ['e']);
      assert.equal(elle!.occurrences, 5); // 1 name_row + 4 speaker lines
      assert.ok(elle!.sources.includes('name_row') && elle!.sources.includes('speaker'));
      assert.equal(elle!.samples.length, 3, 'Samples per character must be capped at 3');
      assert.equal(elle!.existingTarget, '旧艾露', 'Existing glossary entry must pre-populate existingTarget');

      const sub = extracted.characters.find((c) => c.sourceName === 'サブキャラ');
      assert.ok(sub, `Expected inline 【サブキャラ】 candidate in ${JSON.stringify(extracted.characters)}`);
      assert.ok(sub!.sources.includes('inline_bracket'));
      assert.equal(sub!.occurrences, 1);
      assert.deepEqual(sub!.samples, ['「ちょっと待って！」']);
    });

    await withTempWorkspace(async ({ ws }) => {
      // 2) Tyrano workspace: #主人公 vs hex colors (#fff, #ffff, #ffffff, #aabbccdd) & bare # reset
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'vn'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'vn', 'text.json'),
        JSON.stringify({ schema: 1, engine: 'tyrano', profile: 'kag', digest: 'digest-tyrano-1' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'scenario.jsonl'),
        [
          JSON.stringify({ id: 's#1', file: 's.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: '#fff' }),
          JSON.stringify({ id: 's#2', file: 's.ks', line: 2, scene: 's1', speaker: '', kind: 'say', source: '#ffff' }),
          JSON.stringify({ id: 's#3', file: 's.ks', line: 3, scene: 's1', speaker: '', kind: 'say', source: '#ffffff' }),
          JSON.stringify({ id: 's#4', file: 's.ks', line: 4, scene: 's1', speaker: '', kind: 'say', source: '#aabbccdd' }),
          JSON.stringify({ id: 's#5', file: 's.ks', line: 5, scene: 's1', speaker: '', kind: 'say', source: '#主人公' }),
          JSON.stringify({ id: 's#6', file: 's.ks', line: 6, scene: 's1', speaker: '', kind: 'say', source: 'おはようございます！[p]' }),
          JSON.stringify({ id: 's#7', file: 's.ks', line: 7, scene: 's1', speaker: '', kind: 'say', source: '#' }),
          JSON.stringify({ id: 's#8', file: 's.ks', line: 8, scene: 's1', speaker: '', kind: 'say', source: '地の文（話者リセット後）' }),
        ].join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, '.papercup', 'data', 'build', 'ui.jsonl'), '', 'utf8');

      const extracted = extractCharacterCandidates(ws);
      assert.equal(extracted.status, 'unconfirmed');
      assert.equal(extracted.totalCharacters, 1);
      assert.equal(extracted.characters[0].sourceName, '主人公');
      assert.ok(extracted.characters[0].sources.includes('tyrano_tag'));
      assert.deepEqual(extracted.characters[0].samples, ['おはようございます！']);
    });

    await withTempWorkspace(async ({ ws }) => {
      // 3) Empty workspace with no appearing characters yields status="empty"
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'vn'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'vn', 'text.json'),
        JSON.stringify({ schema: 1, engine: 'kirikiri', profile: 'kag', digest: 'digest-empty-1' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'scenario.jsonl'),
        JSON.stringify({ id: 's#1', file: 's.ks', line: 1, scene: 's1', speaker: '', kind: 'say', source: '静かな朝だった。' }) + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, '.papercup', 'data', 'build', 'ui.jsonl'), '', 'utf8');

      const extracted = extractCharacterCandidates(ws);
      assert.equal(extracted.status, 'empty');
      assert.equal(extracted.totalCharacters, 0);
      assert.equal(checkCharacterConfirmationGate(ws).allowed, true);
    });
  });

  it('enforces confirmation form lifecycle, superseding, validation errors, cancel guards, and unsafe formId rejection', async () => {
    await withTempWorkspace(async ({ ws }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'vn'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'vn', 'text.json'),
        JSON.stringify({ schema: 1, engine: 'renpy', profile: 'renpy', digest: 'digest-form-1' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'scenario.jsonl'),
        JSON.stringify({ id: 's#1', file: 's.rpy', line: 1, scene: 'start', speaker: 'alice', kind: 'say', source: 'こんにちは' }) + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'ui.jsonl'),
        JSON.stringify({ id: 'u#1', file: 's.rpy', line: 0, scene: '', speaker: 'alice', kind: 'name', source: '天野 アリス' }) + '\n',
        'utf8'
      );

      // Reject invalid creation inputs
      assert.throws(
        () => createCharacterConfirmationForm(ws, { characters: [] }),
        RosterError
      );
      assert.throws(
        () => createCharacterConfirmationForm(ws, { characters: [{ sourceName: '天野 アリス', defaultTarget: '   ' }] }),
        RosterError
      );

      // Create form 1 -> persisted pending + draft characters.json
      const form1 = createCharacterConfirmationForm(
        ws,
        {
          title: '第一版角色译名',
          characters: [{ sourceName: '天野 アリス', defaultTarget: '天野 爱丽丝', gender: 'female' }],
        },
        { sessionId: 'sess-a' }
      );
      assert.equal(form1.status, 'pending');
      assert.equal(form1.sessionId, 'sess-a');
      assert.ok(fs.existsSync(path.join(ws, FORMS_DIR_REL, `${form1.formId}.json`)));
      assert.equal(readCharacterRoster(ws)?.status, 'draft');
      assert.equal(findPendingCharacterForm(ws)?.formId, form1.formId);

      // Create form 2 -> form 1 is automatically superseded
      const form2 = createCharacterConfirmationForm(ws, {
        title: '第二版角色译名',
        characters: [
          {
            sourceName: '天野 アリス',
            defaultTarget: '天野 爱丽丝',
            gender: 'female',
            aliases: [{ source: 'アリス', target: '爱丽丝' }],
          },
        ],
      });
      assert.equal(readChatForm(ws, form1.formId)?.status, 'superseded');
      assert.equal(findPendingCharacterForm(ws)?.formId, form2.formId);

      // Submitting superseded form must fail with CONFLICT
      assert.throws(
        () => submitCharacterConfirmationForm(ws, form1.formId, { items: [{ sourceName: '天野 アリス', targetName: '天野 爱丽丝' }] }),
        (err: any) => err instanceof RosterError && String(err.message).startsWith('CONFLICT:')
      );

      // Unsafe formId path traversal attempts must be rejected cleanly
      for (const badId of ['../evil', '..\\evil', 'a/b', '.hidden', 'x', '']) {
        assert.equal(readChatForm(ws, badId), null, `readChatForm must reject unsafe formId: ${badId}`);
        assert.throws(
          () => submitCharacterConfirmationForm(ws, badId, { items: [{ sourceName: '天野 アリス', targetName: '天野 爱丽丝' }] }),
          (err: any) => err instanceof RosterError && String(err.message).startsWith('NOT_FOUND:')
        );
        assert.throws(
          () => cancelChatForm(ws, badId),
          (err: any) => err instanceof RosterError && String(err.message).startsWith('NOT_FOUND:')
        );
      }

      // Invalid submission payloads must fail without mutating form2 or locking characters.json
      assert.throws(() => submitCharacterConfirmationForm(ws, form2.formId, { items: null as any }), RosterError);
      assert.throws(
        () => submitCharacterConfirmationForm(ws, form2.formId, { items: [{ sourceName: '天野 アリス', targetName: '   ' }] }),
        RosterError
      );
      assert.throws(
        () =>
          submitCharacterConfirmationForm(ws, form2.formId, {
            items: [
              { sourceName: '天野 アリス', targetName: '天野 爱丽丝' },
              { sourceName: '天野 アリス', targetName: '天野 亚莉丝' },
            ],
          }),
        RosterError
      );
      assert.equal(readChatForm(ws, form2.formId)?.status, 'pending');
      assert.equal(readCharacterRoster(ws)?.status, 'draft');

      // Cancel form2 -> status='cancelled', cannot be submitted afterwards
      const cancelled = cancelChatForm(ws, form2.formId);
      assert.equal(cancelled.status, 'cancelled');
      assert.throws(
        () => submitCharacterConfirmationForm(ws, form2.formId, { items: [{ sourceName: '天野 アリス', targetName: '天野 爱丽丝' }] }),
        (err: any) => err instanceof RosterError && String(err.message).startsWith('CONFLICT:')
      );

      // Create form3 and submit with edited target & alias -> locks characters.json, rejects subsequent cancel
      const form3 = createCharacterConfirmationForm(ws, {
        characters: [{ sourceName: '天野 アリス', defaultTarget: '天野 爱丽丝', gender: 'female' }],
      });
      const submitted = submitCharacterConfirmationForm(ws, form3.formId, {
        items: [
          {
            id: form3.items[0].id,
            sourceName: '天野 アリス',
            targetName: '天野 亚莉丝',
            gender: 'female',
            aliases: [{ source: 'アリス', target: '亚莉丝' }],
            note: '女主角，傲娇',
          },
        ],
      });
      assert.equal(submitted.form.status, 'submitted');
      assert.equal(submitted.roster.status, 'locked');
      assert.equal(submitted.editedItems.length, 1);
      assert.equal(submitted.glossaryEntriesAdded, 2);
      assert.deepEqual(compileRosterToGlossary(submitted.roster), {
        '天野 アリス': '天野 亚莉丝',
        'アリス': '亚莉丝',
      });
      assert.equal(readCharacterRoster(ws)?.status, 'locked');
      assert.equal(listChatForms(ws).length, 3);

      const wakeMsg = buildCharacterFormConfirmationMessage(submitted.form, submitted.editedItems);
      assert.ok(wakeMsg.includes('天野 アリス → 天野 亚莉丝') && wakeMsg.includes('[已修改]'));

      // Cancelling an already submitted form must be rejected with CONFLICT
      assert.throws(
        () => cancelChatForm(ws, form3.formId),
        (err: any) => err instanceof RosterError && String(err.message).startsWith('CONFLICT:')
      );
    });
  });

  it('detects stale roster on classifyDigest change or new characters and enforces confirmation gate rules', async () => {
    await withTempWorkspace(async ({ ws }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'vn'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "third"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
        'utf8'
      );
      assert.equal(loadProfile(ws).profile?.requireCharacterConfirmation, true, 'requireCharacterConfirmation must default to true');

      const writeManifest = (digest: string) => {
        fs.writeFileSync(
          path.join(ws, '.papercup', 'data', 'vn', 'text.json'),
          JSON.stringify({ schema: 1, engine: 'renpy', profile: 'renpy', digest }),
          'utf8'
        );
      };
      writeManifest('digest-v1');
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'scenario.jsonl'),
        JSON.stringify({ id: 's#1', file: 's.rpy', line: 1, scene: 's1', speaker: 'ヒロ', kind: 'say', source: '行くぞ！' }) + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, '.papercup', 'data', 'build', 'ui.jsonl'), '', 'utf8');

      // Gate blocks before confirmation
      const blockedBefore = checkCharacterConfirmationGate(ws);
      assert.equal(blockedBefore.allowed, false);
      assert.equal(blockedBefore.candidateCount, 1);

      // Lock via confirmation form
      const form = createCharacterConfirmationForm(ws, {
        characters: [{ sourceName: 'ヒロ', defaultTarget: '宏' }],
      });
      // Gate blocks while pending form exists (even if profile opts out)
      const optOutProfile = makeProfile({ requireCharacterConfirmation: false });
      const blockedByPending = checkCharacterConfirmationGate(ws, { profile: optOutProfile });
      assert.equal(blockedByPending.allowed, false, 'Pending confirmation form must block even when require_character_confirmation=false');
      assert.equal(blockedByPending.pendingFormId, form.formId);

      submitCharacterConfirmationForm(ws, form.formId, {
        items: [{ sourceName: 'ヒロ', targetName: '宏' }],
      });
      assert.equal(extractCharacterCandidates(ws).status, 'locked');
      assert.equal(checkCharacterConfirmationGate(ws).allowed, true);

      // Changing classifyDigest invalidates locked roster -> status='stale' & gate blocks
      writeManifest('digest-v2');
      assert.equal(extractCharacterCandidates(ws).status, 'stale');
      assert.equal(checkCharacterConfirmationGate(ws).allowed, false);

      // Explicit allowUnconfirmedCharacters bypasses gate
      assert.equal(checkCharacterConfirmationGate(ws, { allowUnconfirmedCharacters: true }).allowed, true);

      // Explicit require_character_confirmation = false in papercup.toml allows when no pending form exists
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "third"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nrequire_character_confirmation = false\n',
        'utf8'
      );
      const loadedOptOut = loadProfile(ws).profile;
      assert.equal(loadedOptOut?.requireCharacterConfirmation, false);
      assert.equal(checkCharacterConfirmationGate(ws).allowed, true);
    });
  });

  it('loadProfileMemory overlays ONLY locked characters.json + aliases onto glossary and exposes characters list', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.writeFileSync(
        path.join(ws, 'glossary.json'),
        JSON.stringify({ 'エル': '旧译名', '聖剣': '圣剑' }, null, 2),
        'utf8'
      );
      const profile = makeProfile({ glossaryFile: 'glossary.json' });

      // Draft roster must NOT overlay glossary or populate locked memory.characters
      writeCharacterRoster(ws, {
        schema: 1,
        status: 'draft',
        classifyDigest: 'd1',
        updatedAt: '2026-11-22T00:00:00Z',
        characters: [
          {
            id: 'ch_elle',
            sourceName: 'エル',
            targetName: '草稿艾露',
            speakerIds: ['e'],
            aliases: [{ source: 'エルちゃん', target: '草稿小艾露' }],
            gender: 'female',
            occurrences: 3,
            samples: [],
          },
        ],
      });
      const draftMem = loadProfileMemory(ws, homeDir, profile);
      assert.equal(draftMem.charactersStatus, 'draft');
      assert.deepEqual(draftMem.characters, []);
      assert.equal(draftMem.glossary['エル'], '旧译名');
      assert.equal(draftMem.glossary['エルちゃん'], undefined);

      // Locked roster MUST overlay canonical name + aliases and preserve non-character glossary terms
      writeCharacterRoster(ws, {
        schema: 1,
        status: 'locked',
        classifyDigest: 'd1',
        updatedAt: '2026-11-22T00:00:00Z',
        confirmedAt: '2026-11-22T00:00:00Z',
        characters: [
          {
            id: 'ch_elle',
            sourceName: 'エル',
            targetName: '艾露',
            speakerIds: ['e'],
            aliases: [{ source: 'エルちゃん', target: '小艾露' }],
            gender: 'female',
            note: '开朗少女',
            occurrences: 3,
            samples: [],
          },
        ],
      });
      const lockedMem = loadProfileMemory(ws, homeDir, profile);
      assert.equal(lockedMem.charactersStatus, 'locked');
      assert.equal(lockedMem.characters?.length, 1);
      assert.equal(lockedMem.glossary['エル'], '艾露');
      assert.equal(lockedMem.glossary['エルちゃん'], '小艾露');
      assert.equal(lockedMem.glossary['聖剣'], '圣剑');
    });
  });

  it('checkCrossRowNameConsistency and mergeTrackResults catch character.name_mismatch and character.name_inconsistent as ok=false', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      const lockedChars: CharacterRosterEntry[] = [
        {
          id: 'ch_elle',
          sourceName: 'エル',
          targetName: '艾露',
          speakerIds: ['e'],
          aliases: [{ source: 'エルちゃん', target: '小艾露' }],
          gender: 'female',
          occurrences: 2,
          samples: [],
        },
      ];

      // 1) Direct unit verification of checkCrossRowNameConsistency
      const directFindings = checkCrossRowNameConsistency(
        [
          { id: 'n1', kind: 'name', source: 'エル', target: '埃尔' }, // mismatch against locked '艾露'
          { id: 'n2', kind: 'name', source: 'エルちゃん', target: '艾露酱' }, // alias mismatch against '小艾露'
          { id: 'n3', kind: 'name', source: '謎の男', target: '神秘男人' }, // inconsistent with n4
          { id: 'n4', kind: 'name', source: '謎の男', target: '谜之男子' }, // inconsistent with n3
          { id: 'n5', kind: 'name', source: 'エル', target: '艾露' }, // inconsistent with n1 AND valid vs locked
          { id: 's1', kind: 'say', source: 'エル', target: '埃尔' }, // non-name row ignored by cross-row name check
        ],
        { characters: lockedChars }
      );
      assert.ok(directFindings.get('n1')?.some((f) => f.rule === 'character.name_mismatch' && f.severity === 'error'));
      assert.ok(directFindings.get('n1')?.some((f) => f.rule === 'character.name_inconsistent' && f.severity === 'error'));
      assert.ok(directFindings.get('n2')?.some((f) => f.rule === 'character.name_mismatch' && f.severity === 'error'));
      assert.ok(directFindings.get('n3')?.some((f) => f.rule === 'character.name_inconsistent' && f.severity === 'error'));
      assert.ok(directFindings.get('n4')?.some((f) => f.rule === 'character.name_inconsistent' && f.severity === 'error'));
      assert.equal(directFindings.has('s1'), false, 'Non-name rows must not trigger checkCrossRowNameConsistency');

      // 2) End-to-end mergeTrackResults integration check
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'ui.jsonl'),
        [
          JSON.stringify({ id: 'u#1', file: 'chars.rpy', line: 1, scene: '', speaker: 'e', kind: 'name', source: 'エル' }),
          JSON.stringify({ id: 'u#2', file: 'chars.rpy', line: 2, scene: '', speaker: '', kind: 'name', source: '謎の男' }),
          JSON.stringify({ id: 'u#3', file: 'chars.rpy', line: 3, scene: '', speaker: '', kind: 'name', source: '謎の男' }),
          JSON.stringify({ id: 'u#4', file: 'chars.rpy', line: 4, scene: '', speaker: '', kind: 'button', source: 'セーブ' }),
        ].join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, '.papercup', 'data', 'build', 'scenario.jsonl'), '', 'utf8');
      writeCharacterRoster(ws, {
        schema: 1,
        status: 'locked',
        classifyDigest: 'd-qa',
        updatedAt: '2026-11-22T00:00:00Z',
        confirmedAt: '2026-11-22T00:00:00Z',
        characters: lockedChars,
      });

      const plan = savePlanConfig(ws, { model: 'deepseek-chat', batchMaxLines: 20 });
      const gen = generateBatches(ws, plan.config);
      assert.equal(gen.batches.length, 1);
      const batchId = gen.batches[0].batch_id;

      checkinBatch(ws, batchId, {
        entries: [
          { id: 'u#1', target: '埃尔' }, // violates locked character name '艾露'
          { id: 'u#2', target: '神秘男人' }, // conflicts with u#3
          { id: 'u#3', target: '谜之男子' }, // conflicts with u#2
          { id: 'u#4', target: '保存' }, // valid UI button
        ],
      });

      const profile = makeProfile();
      const mem = loadProfileMemory(ws, homeDir, profile);
      const merged = mergeTrackResults(ws, 'ui', profile, mem, true, { homeDir });
      assert.equal(merged.rows, 4);
      assert.equal(merged.passed, 1);
      assert.equal(merged.failed, 3);

      const mergedRows = fs
        .readFileSync(merged.results_path, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      const rowU1 = mergedRows.find((r) => r.id === 'u#1');
      const rowU2 = mergedRows.find((r) => r.id === 'u#2');
      const rowU3 = mergedRows.find((r) => r.id === 'u#3');
      const rowU4 = mergedRows.find((r) => r.id === 'u#4');

      assert.equal(rowU1.ok, false);
      assert.ok(rowU1.findings.some((f: any) => f.rule === 'character.name_mismatch'));
      assert.equal(rowU2.ok, false);
      assert.ok(rowU2.findings.some((f: any) => f.rule === 'character.name_inconsistent'));
      assert.equal(rowU3.ok, false);
      assert.ok(rowU3.findings.some((f: any) => f.rule === 'character.name_inconsistent'));
      assert.equal(rowU4.ok, true);

      const progress = JSON.parse(fs.readFileSync(path.join(ws, '.papercup', 'data', 'vn', 'progress.json'), 'utf8'));
      assert.equal(progress.batches[batchId].status, 'qa_failed');
      assert.equal(progress.batches[batchId].failed, 3);
    });
  });

  it('sliceGlossaryForUnits and sliceSpeakerHints match locked speakerIds and inject locked target name, gender & note for local MT', () => {
    const characters: CharacterRosterEntry[] = [
      {
        id: 'ch_elle',
        sourceName: 'エル',
        targetName: '艾露',
        speakerIds: ['e', 'elle_var'],
        aliases: [{ source: 'エルちゃん', target: '小艾露' }],
        gender: 'female',
        note: '青梅竹马，元气少女',
        occurrences: 10,
        samples: [],
      },
      {
        id: 'ch_other',
        sourceName: 'レイ',
        targetName: '雷伊',
        speakerIds: ['r'],
        aliases: [{ source: 'レイ様', target: '雷伊大人' }],
        gender: 'male',
        note: '冷淡剑士',
        occurrences: 5,
        samples: [],
      },
    ];

    const units: TranslationUnit[] = [
      {
        id: 's#1',
        track: 'scenario',
        file: 'script.rpy',
        line: 10,
        scene: 'ch1',
        speaker: 'e', // Ren'Py variable identifier, NOT display name 'エル'
        kind: 'say',
        originalSource: '「おはよう、今日も頑張ろう！」',
        envelope: { leadingControls: '', openingQuote: '「', closingQuote: '」', trailingControls: '' },
        cleanSource: 'おはよう、今日も頑張ろう！',
        inlineTokens: [],
        route: 'pending',
      },
    ];

    const glossarySlice = sliceGlossaryForUnits(units, { '聖剣': '圣剑' }, null, characters);
    assert.equal(glossarySlice['エル'], '艾露', 'Must include active speaker canonical name via speakerIds match');
    assert.equal(glossarySlice['エルちゃん'], '小艾露', 'Must include active speaker aliases via speakerIds match');
    assert.equal(glossarySlice['レイ'], undefined, 'Must NOT leak inactive characters into packet glossary slice');
    assert.equal(glossarySlice['聖剣'], undefined, 'Must NOT leak unmatched base glossary terms');

    const persona = {
      'エル': { base: '称呼主角为「前辈」', stages: [], twists: [] },
      'レイ': { base: '敬语极少', stages: [], twists: [] },
    };
    const speakerHints = sliceSpeakerHints(units, persona, characters);
    assert.ok(speakerHints['e'], 'Must emit speaker hint keyed by unit.speaker ("e")');
    assert.ok(speakerHints['e'].includes('译名：艾露（女）'), `Expected locked target + gender in hint, got: ${speakerHints['e']}`);
    assert.ok(speakerHints['e'].includes('青梅竹马，元气少女'), `Expected character note in hint, got: ${speakerHints['e']}`);
    assert.ok(speakerHints['e'].includes('称呼主角为「前辈」'), `Expected persona card linked via sourceName in hint, got: ${speakerHints['e']}`);
    assert.equal(speakerHints['r'], undefined, 'Inactive speakers must not appear in speakerHints');

    // Prompt formatter includes metadata cleanly
    const formatted = formatCharacterRosterForPrompt(characters);
    assert.ok(formatted.includes('エル => 艾露（女；speaker=e/elle_var；别名:エルちゃん=>小艾露；青梅竹马，元气少女）'), formatted);
    assert.equal(CHARACTERS_REL, '.papercup/data/vn/characters.json');
  });

  it('completes dismissedNames exclusion lifecycle: excludedNames, user removals, 0-character lock, glossary isolation, and restoration', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'vn'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'vn', 'text.json'),
        JSON.stringify({ schema: 1, engine: 'renpy', profile: 'renpy', digest: 'digest-dismiss-1' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'build', 'scenario.jsonl'),
        [
          JSON.stringify({ id: 's#1', file: 's.rpy', line: 1, scene: 's1', speaker: 'エル', kind: 'say', source: 'おはよう！' }),
          JSON.stringify({ id: 's#2', file: 's.rpy', line: 2, scene: 's1', speaker: '', kind: 'say', source: '【システム】セーブしました' }),
          JSON.stringify({ id: 's#3', file: 's.rpy', line: 3, scene: 's1', speaker: '', kind: 'say', source: '【ドカーン】爆発音が響く' }),
        ].join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, '.papercup', 'data', 'build', 'ui.jsonl'), '', 'utf8');

      // 1) createCharacterConfirmationForm accepts excludedNames (string and object)
      const form1 = createCharacterConfirmationForm(ws, {
        characters: [
          { sourceName: 'エル', defaultTarget: '艾露', gender: 'female' },
          { sourceName: 'ドカーン', defaultTarget: '轰隆' },
        ],
        excludedNames: [{ sourceName: 'システム', reason: '系统提示框标签，非角色' }],
      });
      assert.equal(form1.items.length, 2);
      assert.equal(form1.excludedItems?.length, 1);
      assert.equal(form1.excludedItems?.[0].sourceName, 'システム');
      assert.deepEqual(readCharacterRoster(ws)?.dismissedNames, ['システム']);

      // 2) Submitting while removing "ドカーン" records BOTH pre-excluded "システム" AND user-removed "ドカーン" into dismissedNames
      const sub1 = submitCharacterConfirmationForm(ws, form1.formId, {
        items: [{ sourceName: 'エル', targetName: '艾露', gender: 'female' }],
      });
      assert.equal(sub1.roster.status, 'locked');
      assert.deepEqual(sub1.roster.dismissedNames?.slice().sort(), ['システム', 'ドカーン']);
      assert.equal(sub1.form.summary?.dismissedCount, 2);

      // 3) extractCharacterCandidates & checkCharacterConfirmationGate treat dismissedNames as settled (locked & allowed, NOT stale)
      const extAfter = extractCharacterCandidates(ws);
      assert.equal(extAfter.status, 'locked');
      assert.equal(extAfter.dismissedCount, 2);
      assert.deepEqual(extAfter.dismissedNames.slice().sort(), ['システム', 'ドカーン']);
      assert.equal(extAfter.characters.find((c) => c.sourceName === 'システム')?.dismissed, true);
      assert.equal(extAfter.characters.find((c) => c.sourceName === 'ドカーン')?.dismissed, true);
      assert.equal(extAfter.characters.find((c) => c.sourceName === 'エル')?.dismissed, undefined);
      assert.equal(checkCharacterConfirmationGate(ws).allowed, true);

      // 4) compileRosterToGlossary & loadProfileMemory NEVER contain dismissedNames
      const compiled = compileRosterToGlossary(sub1.roster);
      assert.deepEqual(compiled, { 'エル': '艾露' });
      assert.equal(compiled['システム'], undefined);
      assert.equal(compiled['ドカーン'], undefined);
      const mem = loadProfileMemory(ws, homeDir, makeProfile());
      assert.equal(mem.glossary['エル'], '艾露');
      assert.equal(mem.glossary['システム'], undefined);
      assert.equal(mem.glossary['ドカーン'], undefined);

      // 5) Restoring a previously dismissed item into submitted items removes it from dismissedNames and adds it to locked roster + glossary
      const subRestore = submitCharacterConfirmationForm(ws, form1.formId, {
        items: [
          { sourceName: 'エル', targetName: '艾露', gender: 'female' },
          { sourceName: 'システム', targetName: '系统娘', gender: 'other' },
        ],
      });
      assert.deepEqual(subRestore.roster.dismissedNames, ['ドカーン']);
      assert.equal(subRestore.roster.characters.some((c) => c.sourceName === 'システム' && c.targetName === '系统娘'), true);
      assert.equal(compileRosterToGlossary(subRestore.roster)['システム'], '系统娘');
      assert.equal(compileRosterToGlossary(subRestore.roster)['ドカーン'], undefined);
      assert.equal(extractCharacterCandidates(ws).status, 'locked');
      assert.equal(checkCharacterConfirmationGate(ws).allowed, true);

      // 6) All candidates are false positives -> support 0-character form & submission (items: [] + dismissedNames) passing gate
      const zeroWs = path.join(path.dirname(ws), 'ws-zero-chars');
      fs.mkdirSync(path.join(zeroWs, '.papercup', 'data', 'vn'), { recursive: true });
      fs.mkdirSync(path.join(zeroWs, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(zeroWs, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "third"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(zeroWs, '.papercup', 'data', 'vn', 'text.json'),
        JSON.stringify({ schema: 1, engine: 'renpy', profile: 'renpy', digest: 'digest-zero-1' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(zeroWs, '.papercup', 'data', 'build', 'scenario.jsonl'),
        [
          JSON.stringify({ id: 'z#1', file: 's.rpy', line: 1, scene: 's1', speaker: '', kind: 'say', source: '【通知】ロード完了' }),
          JSON.stringify({ id: 'z#2', file: 's.rpy', line: 2, scene: 's1', speaker: '', kind: 'say', source: '【SE】バタン' }),
        ].join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(zeroWs, '.papercup', 'data', 'build', 'ui.jsonl'), '', 'utf8');
      assert.equal(checkCharacterConfirmationGate(zeroWs).allowed, false);

      const zeroForm = createCharacterConfirmationForm(zeroWs, {
        characters: [],
        excludedNames: [
          { sourceName: '通知', reason: '系统提示' },
          { sourceName: 'SE', reason: '音效标记' },
        ],
      });
      assert.equal(zeroForm.items.length, 0);
      assert.equal(zeroForm.excludedItems?.length, 2);

      const zeroSub = submitCharacterConfirmationForm(zeroWs, zeroForm.formId, {
        items: [],
        dismissedNames: ['通知', 'SE'],
      });
      assert.equal(zeroSub.roster.status, 'locked');
      assert.deepEqual(zeroSub.roster.characters, []);
      assert.deepEqual(zeroSub.roster.dismissedNames?.slice().sort(), ['SE', '通知']);
      assert.deepEqual(compileRosterToGlossary(zeroSub.roster), {});
      assert.equal(extractCharacterCandidates(zeroWs).status, 'locked');
      assert.equal(checkCharacterConfirmationGate(zeroWs).allowed, true);
      const zeroWakeMsg = buildCharacterFormConfirmationMessage(zeroSub.form, zeroSub.editedItems);
      assert.ok(zeroWakeMsg.includes('无出场角色') && zeroWakeMsg.includes('排除 2 项'), zeroWakeMsg);
    });
  });
});

/* ========================= 7. Batches 1-3 Regression & Security Invariants ========================= */

describe('7. Batches 1-3 contracts: smoke sandbox/vision/direct staging, ruby/glossary/refusal, status & multi-track release', () => {
  it('7.1 rejects manifest replace ghost-overlay missing subdirectory prefix in prepareSmokeSandbox', async () => {
    await withTempWorkspace(({ root, ws }) => {
      fs.mkdirSync(path.join(ws, 'trial'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'trial', 'game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(path.join(ws, 'trial', 'Script.pac'), Buffer.from('ORIG_SCRIPT_PAC', 'utf8'));

      const patchDir = path.join(root, 'ghost-patch');
      fs.mkdirSync(path.join(patchDir, 'files'), { recursive: true });
      const patchedBytes = Buffer.from('PATCHED_SCRIPT_PAC', 'utf8');
      fs.writeFileSync(path.join(patchDir, 'files', 'Script.pac'), patchedBytes);

      const badManifestPath = path.join(patchDir, 'patch_manifest.json');
      fs.writeFileSync(
        badManifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [
            {
              kind: 'replace_file',
              patch_rel: 'files/Script.pac',
              install_rel: 'Script.pac', // missing "trial/" prefix
              action: 'replace',
              sha256: sha256Hex(patchedBytes),
              bytes: patchedBytes.length,
            },
          ],
        }),
        'utf8'
      );

      assert.throws(
        () => prepareSmokeSandbox(ws, badManifestPath),
        (err: unknown) =>
          err instanceof SmokeError &&
          err.message.includes('replace') &&
          err.message.includes('Script.pac') &&
          err.message.includes('trial/game.exe'),
        'prepareSmokeSandbox must reject replace artifact whose install_rel does not match an existing sandbox file'
      );

      // Failed prepareSmokeSandbox must clean up its temporary sandbox directory
      const smokeRoot = path.join(ws, '.papercup', 'tmp', 'smoke');
      const leftovers = fs.existsSync(smokeRoot) ? fs.readdirSync(smokeRoot) : [];
      assert.deepEqual(leftovers, [], 'Failed prepareSmokeSandbox must not leak sandbox directories');

      // Positive contrast: matching install_rel "trial/Script.pac" succeeds and replaces only the sandbox copy
      const goodManifestPath = path.join(patchDir, 'patch_manifest_good.json');
      fs.writeFileSync(
        goodManifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [
            {
              kind: 'replace_file',
              patch_rel: 'files/Script.pac',
              install_rel: 'trial/Script.pac',
              action: 'replace',
              sha256: sha256Hex(patchedBytes),
              bytes: patchedBytes.length,
            },
          ],
        }),
        'utf8'
      );
      const sb = prepareSmokeSandbox(ws, goodManifestPath);
      try {
        assert.ok(fs.readFileSync(path.join(sb.sandboxDir, 'trial', 'Script.pac')).equals(patchedBytes));
        assert.equal(fs.readFileSync(path.join(ws, 'trial', 'Script.pac'), 'utf8'), 'ORIG_SCRIPT_PAC');
      } finally {
        sb.cleanup();
      }
    });
  });

  it('7.2 rejects overlay double-nested prefix and misplaced basename, and resolves workspace-relative overlayPath with existedBefore=true', async () => {
    await withTempWorkspace(({ root, ws }) => {
      fs.mkdirSync(path.join(ws, 'trial'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'trial', 'game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(path.join(ws, 'trial', 'Script.pac'), Buffer.from('ORIG_PAC', 'utf8'));

      // 1) Double-nested prefix: overlayDir contains trial/Script.pac AND overlayTarget="trial" -> must throw SmokeError
      const doubleNestedDir = path.join(root, 'ov-double');
      fs.mkdirSync(path.join(doubleNestedDir, 'trial'), { recursive: true });
      fs.writeFileSync(path.join(doubleNestedDir, 'trial', 'Script.pac'), Buffer.from('NEW_PAC', 'utf8'));
      assert.throws(
        () => prepareSmokeSandboxFromOverlay(ws, doubleNestedDir, { overlayTarget: 'trial' }),
        (err: unknown) =>
          err instanceof SmokeError &&
          err.message.includes('trial/') &&
          err.message.includes('overlayTarget'),
        'Double-nested overlayTarget + matching subdir in overlayDir must throw SmokeError'
      );

      // 2) Misplaced basename: overlayDir contains Script.pac at root without overlayTarget (real file is trial/Script.pac) -> must throw SmokeError
      const misplacedDir = path.join(root, 'ov-misplaced');
      fs.mkdirSync(misplacedDir, { recursive: true });
      fs.writeFileSync(path.join(misplacedDir, 'Script.pac'), Buffer.from('NEW_PAC', 'utf8'));
      assert.throws(
        () => prepareSmokeSandboxFromOverlay(ws, misplacedDir),
        (err: unknown) =>
          err instanceof SmokeError &&
          err.message.includes('Script.pac') &&
          err.message.includes('trial/Script.pac'),
        'Misplaced basename overlay missing original file must throw SmokeError'
      );

      // 3) Workspace-relative overlayPath (.papercup/tmp/ov-rel containing trial/Script.pac) succeeds and sets existedBefore === true
      const relOverlay = '.papercup/tmp/ov-rel';
      const relOverlayFull = path.join(ws, '.papercup', 'tmp', 'ov-rel', 'trial');
      fs.mkdirSync(relOverlayFull, { recursive: true });
      const newPac = Buffer.from('REL_OVERLAY_PAC', 'utf8');
      fs.writeFileSync(path.join(relOverlayFull, 'Script.pac'), newPac);

      const sb = prepareSmokeSandboxFromOverlay(ws, relOverlay);
      try {
        assert.equal(sb.mode, 'overlay');
        assert.equal(sb.overlayFiles.length, 1);
        assert.equal(sb.overlayFiles[0].rel, 'trial/Script.pac');
        assert.equal(sb.overlayFiles[0].existedBefore, true);
        assert.equal(sb.overlayFiles[0].sha256, sha256Hex(newPac));
        assert.ok(fs.readFileSync(path.join(sb.sandboxDir, 'trial', 'Script.pac')).equals(newPac));
        assert.equal(fs.readFileSync(path.join(ws, 'trial', 'Script.pac'), 'utf8'), 'ORIG_PAC');
      } finally {
        sb.cleanup();
      }
    });
  });

  it('7.3 detects uniform-color black PNG frames deterministically and upgrades frozenScreen black-screen hang to error', async () => {
    await withTempWorkspace(({ root, ws }) => {
      const blackRgbPath = path.join(root, 'black-rgb.png');
      const blackRgbaPath = path.join(root, 'black-rgba.png');
      const nonUniformPath = path.join(root, 'non-uniform.png');

      fs.writeFileSync(blackRgbPath, buildTestPng(32, 32, 2, () => [0, 0, 0]));
      fs.writeFileSync(blackRgbaPath, buildTestPng(32, 32, 6, () => [0, 0, 0, 255]));
      fs.writeFileSync(
        nonUniformPath,
        buildTestPng(32, 32, 2, (_x, y) => (y < 16 ? [0, 0, 0] : [220, 180, 40]))
      );

      assert.deepEqual(isUniformColorPng(blackRgbPath), { uniform: true, r: 0, g: 0, b: 0 });
      assert.deepEqual(isUniformColorPng(blackRgbaPath), { uniform: true, r: 0, g: 0, b: 0 });
      assert.deepEqual(isUniformColorPng(nonUniformPath), { uniform: false });

      // frozenScreen + solid-black frames -> runtime.hang upgraded to severity: 'error'
      const blackEval = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          frozenScreen: true,
          frames: [
            { label: 'title', step: 0, path: blackRgbPath, hash: 'h0', width: 32, height: 32 },
            { label: 'dialogue_start', step: 5, path: blackRgbaPath, hash: 'h0', width: 32, height: 32 },
          ],
        }),
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: false,
        visionEnabled: false,
      });
      const blackHang = blackEval.findings.find((f) => f.ruleId === 'runtime.hang');
      assert.ok(blackHang, `Expected runtime.hang finding, got: ${JSON.stringify(blackEval.findings)}`);
      assert.equal(blackHang!.severity, 'error');
      assert.equal(blackHang!.evidence?.uniformColorFrames, true);
      assert.deepEqual(blackHang!.evidence?.rgb, [0, 0, 0]);

      // frozenScreen + non-uniform frames -> runtime.hang stays severity: 'warning'
      const nonUniformEval = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          frozenScreen: true,
          frames: [
            { label: 'title', step: 0, path: nonUniformPath, hash: 'h1', width: 32, height: 32 },
            { label: 'dialogue_start', step: 5, path: nonUniformPath, hash: 'h1', width: 32, height: 32 },
          ],
        }),
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: false,
        visionEnabled: false,
      });
      const nonUniformHang = nonUniformEval.findings.find((f) => f.ruleId === 'runtime.hang');
      assert.ok(nonUniformHang, `Expected runtime.hang finding, got: ${JSON.stringify(nonUniformEval.findings)}`);
      assert.equal(nonUniformHang!.severity, 'warning');
    });
  });

  it('7.4 attributes explicit skipVision=true, blocks vn_accept with accept.smoke.unverified, and keeps manifest repair rounds across overlay passes', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-Hans"\n',
        'utf8'
      );
      fs.mkdirSync(path.join(ws, 'trial'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'trial', 'game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(path.join(ws, 'trial', 'Script.pac'), Buffer.from('ORIG_PAC', 'utf8'));
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'),
        JSON.stringify({ id: 's#1', file: 'Script.pac', line: 1, track: 'scenario', source: 'おはよう', target: '早上好', ok: true }) + '\n',
        'utf8'
      );

      // Prepare patch bundle matching trial/Script.pac
      const patchDir = path.join(root, 'smoke-patch');
      fs.mkdirSync(path.join(patchDir, 'files'), { recursive: true });
      const patchedPac = Buffer.from('PATCHED_PAC_V1', 'utf8');
      fs.writeFileSync(path.join(patchDir, 'files', 'Script.pac'), patchedPac);
      const manifestPath = path.join(patchDir, 'patch_manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          engine: 'pacf',
          strategy: 'delta_patch',
          artifacts: [
            {
              kind: 'replace_file',
              patch_rel: 'files/Script.pac',
              install_rel: 'trial/Script.pac',
              action: 'replace',
              sha256: sha256Hex(patchedPac),
              bytes: patchedPac.length,
            },
          ],
        }),
        'utf8'
      );

      // Enable smoke gate & vision in isolated homeDir config
      saveGlobalSmokeConfig({ enabled: true, visionEnabled: true, maxRepairRounds: 2 }, homeDir);

      const profile = makeProfile({ targetLang: 'zh-Hans' });
      const mem = makeMemory();

      const passingDriver = {
        run: async () =>
          makeBaseDriverResult({
            stepsAdvanced: 6,
            textractorLines: [],
          }),
      };

      // 1) Explicit skipVision=true while visionEnabled=true in config
      const skipRes = await runSmokeTest(ws, profile, {
        homeDir,
        patchManifestPath: manifestPath,
        skipVision: true,
        driver: passingDriver,
      });
      assert.equal(skipRes.report.ok, true);
      assert.equal(skipRes.report.usedTextractor, false);
      assert.equal(skipRes.report.vision?.status, 'skipped');
      assert.equal(skipRes.report.vision?.skippedByParam, true);
      assert.ok(
        skipRes.report.vision?.reason?.includes('skipVision=true') &&
          !skipRes.report.vision?.reason?.includes('设置中未启用'),
        `Unexpected vision skip reason: ${skipRes.report.vision?.reason}`
      );
      const visFinding = skipRes.report.findings.find((f) => f.ruleId === 'vision.skipped');
      assert.ok(visFinding && visFinding.message.includes('skipVision=true'));
      assert.equal(visFinding!.evidence?.skippedByParam, true);

      // 2) vn_accept (both validateAcceptance and acceptVnRelease) MUST block with accept.smoke.unverified
      const scenReport = delegatedReport(
        ws,
        profile,
        mem,
        path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'),
        'scenario',
        'unreviewed',
        { homeDir }
      );
      const valAcc = validateAcceptance(ws, homeDir, profile, mem, manifestPath, { report: scenReport });
      assert.equal(valAcc.blocked, true);
      assert.ok(
        valAcc.findings.some((f) => f.rule === 'accept.smoke.unverified' && f.severity === 'error'),
        `Expected accept.smoke.unverified error finding, got: ${JSON.stringify(valAcc.findings)}`
      );
      const coreAcc = acceptVnRelease(ws, {
        archive: manifestPath,
        track: 'scenario',
        input: '.papercup/data/results/scenario.jsonl',
      });
      assert.equal(coreAcc.blocked, true);
      assert.ok(
        coreAcc.text.includes('accept.smoke.unverified'),
        `Expected acceptVnRelease to block with accept.smoke.unverified, got:\n${coreAcc.text}`
      );

      // 3) Failing manifest smoke increments failedRounds; subsequent passing overlay run MUST NOT reset failedRounds
      const failingDriver = {
        run: async () =>
          makeBaseDriverResult({
            errorDialog: { title: 'Script Error', text: 'Invalid bytecode offset' },
          }),
      };
      const failRound1 = await runSmokeTest(ws, profile, {
        homeDir,
        patchManifestPath: manifestPath,
        skipVision: true,
        driver: failingDriver,
      });
      assert.equal(failRound1.report.ok, false);
      assert.equal(readSmokeRepairState(ws)?.failedRounds, 1);

      const ovRel = '.papercup/tmp/ov-diag';
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp', 'ov-diag', 'trial'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'ov-diag', 'trial', 'Script.pac'), Buffer.from('DIAG_PAC', 'utf8'));

      const overlayPass1 = await runSmokeTest(ws, profile, {
        homeDir,
        overlayPath: ovRel,
        skipVision: true,
        driver: passingDriver,
      });
      assert.equal(overlayPass1.report.ok, true);
      assert.equal(overlayPass1.report.mode, 'overlay');
      assert.equal(
        readSmokeRepairState(ws)?.failedRounds,
        1,
        'Passing diagnostic overlay run must NOT reset manifest failedRounds to 0'
      );

      // Second manifest failure advances to 2, and another passing overlay still preserves failedRounds === 2
      const failRound2 = await runSmokeTest(ws, profile, {
        homeDir,
        patchManifestPath: manifestPath,
        skipVision: true,
        driver: failingDriver,
      });
      assert.equal(failRound2.report.ok, false);
      assert.equal(failRound2.report.repairLimitReached, true);
      assert.equal(readSmokeRepairState(ws)?.failedRounds, 2);

      const overlayPass2 = await runSmokeTest(ws, profile, {
        homeDir,
        overlayPath: ovRel,
        skipVision: true,
        driver: passingDriver,
      });
      assert.equal(overlayPass2.report.ok, true);
      assert.equal(readSmokeRepairState(ws)?.failedRounds, 2);

      // Positive contrast: a passing manifest run resets failedRounds back to 0
      const manifestPass = await runSmokeTest(ws, profile, {
        homeDir,
        patchManifestPath: manifestPath,
        skipVision: true,
        driver: passingDriver,
      });
      assert.equal(manifestPass.report.ok, true);
      assert.equal(readSmokeRepairState(ws)?.failedRounds, 0);
    });
  });

  it('7.5 guards PS1 IsErrorDialog against empty-body dialogs and requires blank_or_black_screen error check in smoke-vision prompt', async () => {
    await withTempWorkspace(async ({ root }) => {
      // 1) PS1 driver script IsErrorDialog returns false for empty body text when title/text lack error keywords
      const ps1Path = path.join(root, 'driver', '_papercup_smoke_driver.ps1');
      writeWindowsSmokeDriverScript(ps1Path);
      const ps1Src = fs.readFileSync(ps1Path, 'utf8');
      const fnMatch = /public static bool IsErrorDialog\([\s\S]*?^\s{4}\}/m.exec(ps1Src);
      assert.ok(fnMatch, 'Expected IsErrorDialog method in generated Windows smoke driver PS1');
      const body = fnMatch![0];
      const keywordIdx = body.indexOf('HasErrorKeyword(title) || HasErrorKeyword(text)');
      const emptyGuardIdx = body.indexOf('if (string.IsNullOrWhiteSpace(text)) return false;');
      const enumIdx = body.indexOf('EnumChildWindows(');
      assert.ok(keywordIdx > 0, `Expected HasErrorKeyword check in IsErrorDialog:\n${body}`);
      assert.ok(emptyGuardIdx > keywordIdx, `Expected empty-body guard after HasErrorKeyword in IsErrorDialog:\n${body}`);
      assert.ok(enumIdx > emptyGuardIdx, `Expected empty-body guard BEFORE EnumChildWindows fallback in IsErrorDialog:\n${body}`);

      // 2) smoke-vision.ts inspectFrames prompt includes blank_or_black_screen (severity: "error")
      const framePng = path.join(root, 'frame.png');
      fs.writeFileSync(framePng, buildTestPng(32, 32, 2, () => [0, 0, 0]));
      let capturedPrompt = '';
      const visionBridge = createSmokeVisionBridge({
        getModel: () => ({ id: 'vision-test', provider: 'test', input: ['text', 'image'] }) as any,
        getModelRuntime: () =>
          ({
            completeSimple: async (_model: any, ctx: any) => {
              const parts = ctx?.messages?.[0]?.content ?? [];
              capturedPrompt = parts
                .filter((p: any) => p?.type === 'text')
                .map((p: any) => p.text)
                .join('\n');
              return { stopReason: 'stop', content: [{ type: 'text', text: '{"defects":[]}' }] };
            },
          }) as any,
      });
      const res = await visionBridge.inspectFrames!([{ label: 'title', path: framePng }], {
        targetLang: 'zh-Hans',
        sampleTranslations: ['早上好'],
      });
      assert.equal(res.status, 'checked');
      assert.ok(
        capturedPrompt.includes('"blank_or_black_screen"') &&
          /"blank_or_black_screen"\s*\(severity:\s*"error"\)/.test(capturedPrompt),
        `Expected smoke-vision prompt to include "blank_or_black_screen" (severity: "error"), got:\n${capturedPrompt}`
      );
    });
  });

  it('7.6 skips DirectX/ redistributable .cab in direct vn_learn_skill staging and rejects internal/temp direct_root in both learnUnpackSkill and buildPatchBundle', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-Hans"\n',
        'utf8'
      );
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp', 'skill-input'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'trial', 'DirectX'), { recursive: true });

      const sampleScript = [
        'SAY:おはよう、今日もいい天気だね。',
        'SAY:放課後に図書室へ行こう。',
        'SAY:わかった、あとで合流しよう。',
        'SAY:それじゃあ、また後でね。',
        'SYS:セーブ',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, 'trial', 'Script.pac'), sampleScript, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'skill-input', 'Script.pac'), sampleScript, 'utf8');

      // Place >16 MiB .cab inside DirectX/ (exceeds MAX_EXTRACT_FILE=16 MiB) + loose 2 MiB .cab at trial root
      fs.writeFileSync(path.join(ws, 'trial', 'DirectX', 'Apr2005_d3dx9_25_x86.cab'), Buffer.alloc(17 * 1024 * 1024, 0x43));
      fs.writeFileSync(path.join(ws, 'trial', 'DirectX', 'DXSETUP.exe'), Buffer.alloc(2 * 1024 * 1024, 0x4d));
      fs.writeFileSync(path.join(ws, 'trial', 'redist_pkg.cab'), Buffer.alloc(2 * 1024 * 1024, 0x52));

      const extractPy = [
        'import json, os, sys',
        'base = sys.argv[1]',
        'assert not os.path.exists(os.path.join(base, "DirectX")), "DirectX/ must be skipped in analysis stage"',
        'cab_path = os.path.join(base, "redist_pkg.cab")',
        'assert os.path.exists(cab_path) and os.path.getsize(cab_path) == 0, "loose .cab must be zero-stubbed"',
        'lines = open(os.path.join(base, "Script.pac"), "r", encoding="utf-8").read().splitlines()',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    for i, line in enumerate(lines, 1):',
        '        tag, text = line.split(":", 1)',
        '        kind = "say" if tag == "SAY" else "system"',
        '        f.write(json.dumps({"id": f"p#{i}", "file": "Script.pac", "line": i, "kind": kind, "source": text}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, sys',
        'target_path = os.path.join(sys.argv[2], "Script.pac")',
        'lines = open(target_path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    tag = lines[idx].split(":", 1)[0]',
        '    lines[idx] = f"{tag}:{r.get(\'target\') or r[\'source\']}"',
        'open(target_path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'ext_dx.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_dx.py'), applyPy, 'utf8');

      // 1) Direct learning on trial/ succeeds despite 17 MiB DirectX/*.cab + loose 2 MiB .cab
      const learned = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'pacdx',
        pipeline: 'direct',
        unpackedDir: 'trial',
        extractScript: '.papercup/tmp/ext_dx.py',
        applyScript: '.papercup/tmp/app_dx.py',
        systemTextFiles: ['Script.pac'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(learned.status, 'adopted', `Expected direct skill adoption skipping DirectX/, got: ${JSON.stringify(learned)}`);

      // 2) Direct learning pointing to internal temp dir .papercup/tmp/skill-input MUST be rejected
      const badLearn = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'pacdx',
        pipeline: 'direct',
        unpackedDir: '.papercup/tmp/skill-input',
        extractScript: '.papercup/tmp/ext_dx.py',
        applyScript: '.papercup/tmp/app_dx.py',
        systemTextFiles: ['Script.pac'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(badLearn.status, 'diagnosed');
      assert.ok(
        badLearn.summary.includes('内部临时或备份目录') && badLearn.summary.includes('.papercup/tmp/skill-input'),
        `Expected internal/temp direct_root rejection, got: ${badLearn.summary}`
      );

      // 3) Poisoning engine.json with direct_root=".papercup/tmp/skill-input" causes buildPatchBundle to throw ExportCopyError
      const engJsonPath = path.join(projectHarnessDir(ws, homeDir), 'engine.json');
      const engObj = JSON.parse(fs.readFileSync(engJsonPath, 'utf8')) as Record<string, unknown>;
      engObj.direct_root = '.papercup/tmp/skill-input';
      fs.writeFileSync(engJsonPath, JSON.stringify(engObj, null, 2) + '\n', 'utf8');

      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'),
        JSON.stringify({ id: 'p#1', file: 'Script.pac', line: 1, track: 'scenario', source: 'おはよう、今日もいい天気だね。', target: '早上好，今天天气真好。', ok: true }) + '\n',
        'utf8'
      );

      await assert.rejects(
        () =>
          buildPatchBundle(ws, makeProfile({ targetLang: 'zh-Hans' }), makeMemory(), {
            homeDir,
            dest: path.join(root, 'poisoned-patch-out'),
          }),
        (err: unknown) =>
          err instanceof ExportCopyError &&
          err.message.includes('direct_root') &&
          err.message.includes('内部临时或备份目录'),
        'buildPatchBundle must throw ExportCopyError when engine.json direct_root points to internal/temp dir'
      );
    });
  });

  it('7.7 prevents ruby/glossary Catch-22 deadlock, filters pure-kana identity aliases, and strips inline ruby in extractCharacterCandidates', async () => {
    await withTempWorkspace(({ ws, homeDir }) => {
      // 1) qaReport under zh-Hans + residueCheck=true: kana-target glossary entry must NOT deadlock with source.residue, while kanji entry IS still enforced
      const zhProfile = makeProfile({ sourceLang: 'ja', targetLang: 'zh-Hans', residueCheck: true });
      const glossary = { 'なりた': 'なりた', '成田': '成田' };

      const okReport = qaReport('@r成田@なりた@', '@r成田@(narita)@', zhProfile, glossary);
      assert.equal(okReport.blocked, false, `Expected ruby/glossary Catch-22 immunity to pass QA: ${JSON.stringify(okReport.findings)}`);
      assert.equal(
        okReport.findings.some((f) => f.rule === 'glossary.missing'),
        false,
        `Kana-target glossary entry must not trigger Catch-22 glossary.missing: ${JSON.stringify(okReport.findings)}`
      );
      assert.equal(
        okReport.findings.some((f) => f.rule === 'source.residue'),
        false,
        `Translated ruby with romaji reading must pass source.residue: ${JSON.stringify(okReport.findings)}`
      );

      const missingKanjiReport = qaReport('@r成田@なりた@', '@r陈田@(narita)@', zhProfile, glossary);
      assert.equal(missingKanjiReport.blocked, true);
      assert.ok(
        missingKanjiReport.findings.some((f) => f.rule === 'glossary.missing' && f.message.includes('成田')),
        `Non-kana glossary term "成田" must still be enforced when missing: ${JSON.stringify(missingKanjiReport.findings)}`
      );

      // 2) compileRosterToGlossary({ skipKanaIdentityAliases: true }) skips pure-kana identity aliases while preserving real translations & kanji identities
      const rosterStore = {
        schema: 1 as const,
        status: 'locked' as const,
        classifyDigest: 'digest-ruby-1',
        updatedAt: '2026-11-23T00:00:00Z',
        confirmedAt: '2026-11-23T00:00:00Z',
        characters: [
          {
            id: 'ch_narita',
            sourceName: '成田',
            targetName: '成田',
            speakerIds: [],
            aliases: [
              { source: 'なりた', target: 'なりた' }, // pure-kana identity -> skipped when skipKanaIdentityAliases=true
              { source: 'ナリタ', target: 'ナリタ' }, // pure-katakana identity -> skipped
              { source: 'なりたさん', target: 'narita' }, // kana -> non-kana translation -> kept
            ],
            gender: 'male' as const,
            occurrences: 5,
            samples: [],
          },
          {
            id: 'ch_kurano',
            sourceName: '暗野木陰',
            targetName: '暗野木阴',
            speakerIds: [],
            aliases: [{ source: '斉藤', target: '齐藤' }],
            gender: 'female' as const,
            occurrences: 4,
            samples: [],
          },
        ],
      };

      const filtered = compileRosterToGlossary(rosterStore, { skipKanaIdentityAliases: true });
      assert.equal(filtered['なりた'], undefined, 'Pure-hiragana identity alias must be filtered out');
      assert.equal(filtered['ナリタ'], undefined, 'Pure-katakana identity alias must be filtered out');
      assert.equal(filtered['成田'], '成田');
      assert.equal(filtered['なりたさん'], 'narita');
      assert.equal(filtered['暗野木陰'], '暗野木阴');
      assert.equal(filtered['斉藤'], '齐藤');

      // Also verify loadProfileMemory automatically applies skipKanaIdentityAliases under zh-Hans + residueCheck=true
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-Hans"\n',
        'utf8'
      );
      writeCharacterRoster(ws, rosterStore);
      const loadedMem = loadProfileMemory(ws, homeDir, zhProfile);
      assert.equal(loadedMem.glossary['なりた'], undefined);
      assert.equal(loadedMem.glossary['暗野木陰'], '暗野木阴');
      assert.equal(loadedMem.glossary['斉藤'], '齐藤');
      assert.equal(loadedMem.glossary['なりたさん'], 'narita');

      // 3) extractCharacterCandidates strips inline ruby readings (@rBase@Reading@ and |Base《Reading》)
      const rubyWs = path.join(path.dirname(ws), 'ws-ruby-candidates');
      fs.mkdirSync(path.join(rubyWs, '.papercup', 'data', 'vn'), { recursive: true });
      fs.mkdirSync(path.join(rubyWs, '.papercup', 'data', 'build'), { recursive: true });
      fs.writeFileSync(
        path.join(rubyWs, '.papercup', 'data', 'vn', 'text.json'),
        JSON.stringify({ schema: 1, engine: 'pacf', profile: 'plain', digest: 'digest-ruby-ext' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(rubyWs, '.papercup', 'data', 'build', 'scenario.jsonl'),
        [
          JSON.stringify({ id: 'r#1', file: 's.pac', line: 1, scene: 's1', speaker: '@r暗野@くらの@@r木陰@こかげ@', kind: 'say', source: 'おはよう！' }),
          JSON.stringify({ id: 'r#2', file: 's.pac', line: 2, scene: 's1', speaker: '|成田《なりた》', kind: 'say', source: 'よろしく。' }),
          JSON.stringify({ id: 'r#3', file: 's.pac', line: 3, scene: 's1', speaker: '', kind: 'say', source: '【｜佐藤《さとう》】「行くぞ」' }),
        ].join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(rubyWs, '.papercup', 'data', 'build', 'ui.jsonl'),
        JSON.stringify({ id: 'u#1', file: 's.pac', line: 1, scene: '', speaker: '', kind: 'name', source: '@r暗野@くらの@@r木陰@こかげ@' }) + '\n',
        'utf8'
      );

      const extracted = extractCharacterCandidates(rubyWs);
      const names = extracted.characters.map((c) => c.sourceName).sort();
      assert.deepEqual(names, ['佐藤', '成田', '暗野木陰']);
      assert.equal(
        names.some((n) => /くらの|こかげ|なりた|さとう|@r|《/.test(n)),
        false,
        `Candidate names must not contain raw inline ruby syntax or readings: ${JSON.stringify(names)}`
      );
    });
  });

  it('7.8 classifies Cursor HTTP 400 usage-guidelines blocks and model refusals as non-fatal content_blocked', () => {
    const cursorBlock = classifySubagentError(
      'HTTP 400 Request blocked: This request was blocked under the model provider\'s usage guidelines.'
    );
    assert.deepEqual(cursorBlock, { kind: 'content_blocked', fatalForPool: false });

    const modelRefusal = classifySubagentError(
      'I can\'t translate this batch. It includes sexual content involving minors.'
    );
    assert.deepEqual(modelRefusal, { kind: 'content_blocked', fatalForPool: false });

    const stopHereRefusal = classifySubagentError('I have to stop here due to safety policy violation.');
    assert.deepEqual(stopHereRefusal, { kind: 'content_blocked', fatalForPool: false });

    // Contrast: real auth failure remains fatalForPool: true
    const authErr = classifySubagentError('HTTP 401 unauthorized invalid api key');
    assert.deepEqual(authErr, { kind: 'auth_error', fatalForPool: true });
  });

  it('7.9 reports .papercup/tmp/work/out batch disk progress in getVnStatus even when results/*.jsonl is still empty', async () => {
    await withTempWorkspace(({ ws }) => {
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-Hans"\n',
        'utf8'
      );
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp', 'work', 'batches'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp', 'work', 'out'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });

      fs.writeFileSync(
        path.join(ws, '.papercup', 'tmp', 'work', 'batches', 'manifest.json'),
        JSON.stringify({
          schema: 1,
          batches: [
            { batch_id: 'batch_000', line_count: 10 },
            { batch_id: 'batch_001', line_count: 12 },
            { batch_id: 'batch_002', line_count: 8 },
          ],
        }),
        'utf8'
      );
      const makeRows = (n: number, prefix: string) =>
        Array.from({ length: n }, (_, i) => JSON.stringify({ id: `${prefix}#${i + 1}`, target: `译文${i + 1}` })).join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'work', 'out', 'batch_000.jsonl'), makeRows(10, 'b0'), 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'work', 'out', 'batch_001.jsonl'), makeRows(12, 'b1'), 'utf8');

      const partialStatus = getVnStatus(ws);
      assert.ok(
        partialStatus.includes('批次进度：已落盘 2/3 批（22/30 段，尚缺 1 批）'),
        `Expected partial batch progress line in getVnStatus output, got:\n${partialStatus}`
      );

      // Completing the 3rd batch updates state to 已全部落盘
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'work', 'out', 'batch_002.jsonl'), makeRows(8, 'b2'), 'utf8');
      const fullStatus = getVnStatus(ws);
      assert.ok(
        fullStatus.includes('批次进度：已落盘 3/3 批（30/30 段，已全部落盘）'),
        `Expected completed batch progress line in getVnStatus output, got:\n${fullStatus}`
      );
    });
  });

  it('7.10 merges multi-track acceptances and renders both tracks, total segments, direct engine fallback, and locked character count in buildReleaseNote', () => {
    const profile = makeProfile({ narrativePov: 'first', sourceLang: 'ja', targetLang: 'zh-Hans' });
    const lockedCharacters: CharacterRosterEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `ch_${i + 1}`,
      sourceName: `キャラ${i + 1}`,
      targetName: `角色${i + 1}`,
      speakerIds: [`c${i + 1}`],
      aliases: [],
      gender: 'unknown',
      occurrences: 10 - i,
      samples: [],
    }));
    const memory = makeMemory({
      glossary: { '学園': '学园' },
      persona: { 'キャラ1': { base: '元气', stages: [], twists: [] } },
      characters: lockedCharacters,
      charactersStatus: 'locked',
    });

    const sharedProfileBlock = { digest: 'prof-d1', memory_digest: 'mem-d1' };
    const scenarioRec: Record<string, unknown> = {
      schema: 2,
      accepted: '2026-11-23T05:00:00Z',
      model: 'gpt-5',
      quality: 'ok',
      manifest_digest: 'man-d1',
      profile: sharedProfileBlock,
      translation: { path: 'results/scenario.jsonl', segments: 514 },
      tracks: {
        scenario: { path: 'results/scenario.jsonl', segments: 514, sha256: 'aaa' },
      },
      patch: {
        strategy: 'delta_patch',
        engine: 'pacf',
        artifacts_count: 1,
        encoding: 'cp932',
        hook_needed: false,
      },
      engines: [],
    };
    const uiRec: Record<string, unknown> = {
      schema: 2,
      accepted: '2026-11-23T05:05:00Z',
      model: 'gpt-5',
      quality: 'ok',
      manifest_digest: 'man-d1',
      profile: sharedProfileBlock,
      translation: { path: 'results/ui.jsonl', segments: 374 },
      tracks: {
        ui: { path: 'results/ui.jsonl', segments: 374, sha256: 'bbb' },
      },
      engines: [],
    };

    const merged = mergeAcceptance(scenarioRec, uiRec);
    assert.ok((merged.tracks as Record<string, unknown>).scenario, 'Merged acceptance must retain scenario track');
    assert.ok((merged.tracks as Record<string, unknown>).ui, 'Merged acceptance must retain ui track');
    assert.ok(merged.patch, 'Merged acceptance must preserve patch metadata from prev when next omits it');

    const releaseNote = buildReleaseNote(profile, memory, merged);
    assert.ok(releaseNote.includes('results/scenario.jsonl（514 段）'), `Missing scenario track in release note:\n${releaseNote}`);
    assert.ok(releaseNote.includes('results/ui.jsonl（374 段）'), `Missing ui track in release note:\n${releaseNote}`);
    assert.ok(releaseNote.includes('共 888 段'), `Missing summed total 888 segments in release note:\n${releaseNote}`);
    assert.ok(releaseNote.includes('- 引擎：pacf'), `Expected engine fallback "- 引擎：pacf" in release note:\n${releaseNote}`);
    assert.equal(releaseNote.includes('- 引擎：未记录'), false, 'Release note must not show "- 引擎：未记录" when patch.engine is pacf');
    assert.ok(releaseNote.includes('锁定角色：5 位'), `Missing locked character count in release note:\n${releaseNote}`);

    // Also verify mergeAcceptance merges non-empty engines arrays across prev & next
    const mergedWithEngines = mergeAcceptance(
      { ...scenarioRec, engines: ['pacf'] },
      { ...uiRec, engines: [] }
    );
    assert.deepEqual(mergedWithEngines.engines, ['pacf']);
  });
});

/* ========================= Suite 8: Reverser Stall-Progress & Stdout-First Guardrails ========================= */

describe('8. Reverser stall-progress separation & stdout-first efficiency guardrails', () => {
  it('8.1 isMeaningfulReverserArtifactPath separates scratch .papercup/tmp/ probes from deliverables & research docs', () => {
    const nonMeaningfulScratchPaths = [
      '',
      '   ',
      '.papercup/tmp',
      '.papercup/tmp/pacf/analyze.py',
      '.papercup/tmp/eng/probe1.py',
      '.papercup/tmp/pacf/scriptfmt.txt',
      '.papercup/tmp/pacf/out.log',
      '.papercup\\tmp\\pacf\\analyze.py',
      './.papercup/tmp/pacf/foo.py',
      '././.papercup/tmp/pacf/dump.json',
      '.PaperCup/TMP/pacf/probe_header.py',
    ];
    for (const p of nonMeaningfulScratchPaths) {
      assert.equal(
        isMeaningfulReverserArtifactPath(p),
        false,
        `Expected scratch path ${JSON.stringify(p)} NOT to count as a meaningful milestone artifact`
      );
    }

    const meaningfulDeliverablePaths = [
      '.papercup/tmp/pacf/unpack.py',
      '.papercup/tmp/pacf/repack.py',
      '.papercup/tmp/pacf/extract.py',
      '.papercup/tmp/pacf/apply.py',
      '.papercup\\tmp\\pacf\\apply.py',
      './.papercup/tmp/pacf/unpack.py',
      '.papercup/tmp/pacf/Apply.PY',
      '.papercup/research/pacf/01-layout.md',
      '.papercup/research/pacf/02-hypotheses.md',
      '.papercup/research/pacf/03-text-mapping.json',
      '.papercup/skills/engine-pacf/SKILL.md',
      '.papercup/skills/engine-pacf/apply.py',
      'papercup.toml',
      'scripts/helper.py',
    ];
    for (const p of meaningfulDeliverablePaths) {
      assert.equal(
        isMeaningfulReverserArtifactPath(p),
        true,
        `Expected deliverable/research path ${JSON.stringify(p)} to count as a meaningful milestone artifact`
      );
    }
  });

  it('8.2 isTmpScratchTextReadPath & shouldEmitTmpReadStdoutNotice detect tmp text dumps and cadence', () => {
    const scratchTextReads = [
      '.papercup/tmp/pacf/scriptfmt.txt',
      '.papercup/tmp/pacf/out.log',
      '.papercup/tmp/pacf/dump.json',
      '.papercup/tmp/pacf/rows.jsonl',
      '.papercup/tmp/pacf/notes.md',
      '.papercup/tmp/pacf/fn.asm',
      '.papercup/tmp/pacf/fn.disasm',
      '.papercup/tmp/pacf/bytes.hex',
      '.papercup/tmp/pacf/raw.out',
      '.papercup/tmp/pacf/table.csv',
      '.papercup/tmp/pacf/table.tsv',
      '.papercup\\tmp\\pacf\\scriptfmt.txt',
      './.papercup/tmp/pacf/out.log',
      '.papercup/tmp/pacf/DUMP.JSON',
    ];
    for (const p of scratchTextReads) {
      assert.equal(
        isTmpScratchTextReadPath(p),
        true,
        `Expected ${JSON.stringify(p)} to be flagged as a tmp scratch text read`
      );
    }

    const nonScratchTextReads = [
      '',
      '   ',
      '.papercup/tmp/pacf/analyze.py',
      '.papercup/tmp/pacf/apply.py',
      '.papercup/tmp/pacf/raw.bin',
      '.papercup/tmp/pacf/noext',
      '.papercup/research/pacf/01-layout.md',
      '.papercup/vn/text.json',
      'tmp/pacf/out.txt',
    ];
    for (const p of nonScratchTextReads) {
      assert.equal(
        isTmpScratchTextReadPath(p),
        false,
        `Expected ${JSON.stringify(p)} NOT to be flagged as a tmp scratch text read`
      );
    }

    assert.equal(REVERSER_TMP_READ_REMIND_FIRST, 3);
    assert.equal(REVERSER_TMP_READ_REMIND_STEP, 6);

    for (const count of [3, 9, 15, 21]) {
      assert.equal(
        shouldEmitTmpReadStdoutNotice(count),
        true,
        `Expected shouldEmitTmpReadStdoutNotice(${count}) to be true`
      );
    }
    for (const count of [-1, 0, 1, 2, 4, 5, 6, 7, 8, 10, 14, 16]) {
      assert.equal(
        shouldEmitTmpReadStdoutNotice(count),
        false,
        `Expected shouldEmitTmpReadStdoutNotice(${count}) to be false`
      );
    }
  });

  it('8.3 shouldEmitSoftStallNotice fires at 18/36/54 when not yet emitted and deduplicates repeats', () => {
    assert.equal(REVERSER_SOFT_STALL_REMIND_INTERVAL, 18);

    assert.equal(shouldEmitSoftStallNotice(18, 0), true);
    assert.equal(shouldEmitSoftStallNotice(36, 18), true);
    assert.equal(shouldEmitSoftStallNotice(54, 36), true);
    assert.equal(shouldEmitSoftStallNotice(36, 0), true);

    // Already emitted for the same callsSinceProgress -> must NOT re-emit
    assert.equal(shouldEmitSoftStallNotice(18, 18), false);
    assert.equal(shouldEmitSoftStallNotice(36, 36), false);
    assert.equal(shouldEmitSoftStallNotice(54, 54), false);

    // Non-multiples or below threshold -> must NOT emit
    for (const [calls, lastAt] of [
      [0, 0],
      [0, -1],
      [1, 0],
      [17, 0],
      [19, 0],
      [19, 18],
      [35, 18],
      [37, 18],
    ]) {
      assert.equal(
        shouldEmitSoftStallNotice(calls, lastAt),
        false,
        `Expected shouldEmitSoftStallNotice(${calls}, ${lastAt}) to be false`
      );
    }
  });

  it('8.4 SubagentManager.wrapSubagentTool enforces stall separation, stdout-first reminder, 18-call progress check, milestone resets & hard stall stop', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const mgr = new SubagentManager();

      const makeSyntheticRun = (opts?: { budgetMaxStallCalls?: number }) => {
        const nowIso = new Date().toISOString();
        let sessionAbortCalls = 0;
        const snapshot: SubagentTaskSnapshot = {
          taskId: `subtask-reverser-test-${Date.now()}`,
          sessionId: 'sess-test',
          role: 'reverser',
          model: 'faux/test',
          thinkingLevel: 'max',
          status: 'running',
          activityState: 'running_tool',
          stage: 'inspect',
          startedAt: nowIso,
          lastActivityAt: nowIso,
          lastProgressAt: null,
          lastProgressSummary: null,
          durationMs: 0,
          toolCallCount: 0,
          errorCount: 0,
          artifactsCount: 0,
          consecutiveHypothesisFailures: 0,
          pivotWarningCount: 0,
          taskSummary: 'reverse engine x',
          taskPrompt: 'reverse engine x',
          maxConsecutiveFailures: 3,
          artifacts: [],
          pivotWarnings: [],
          retryCount: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          toolCalls: [],
          responsePreview: '',
        };
        const runCtx: any = {
          cwd: ws,
          session: {
            abort: () => {
              sessionAbortCalls += 1;
            },
          },
          snapshot,
          recordDiagnostics: false,
          toolOutcomeByCallId: new Map(),
          queueController: { clearForRestore: () => null, reset: () => {}, hasPending: () => false },
          userSteeredNotes: [],
          pendingRestoredDraft: null,
          restoredDraftEmitted: false,
          emitQueueUpdate: () => {},
          lastPersistAtMs: 0,
          finalized: false,
          budgetMaxStallCalls: opts?.budgetMaxStallCalls,
          callsSinceProgress: 0,
          lastStallTurnKey: undefined,
          lastSoftStallRemindAt: 0,
          tmpTextReadCount: 0,
          finalize: (status: SubagentTaskSnapshot['status'], activityState: SubagentTaskSnapshot['activityState'], errorMsg?: string) => {
            if (runCtx.finalized) return;
            runCtx.finalized = true;
            snapshot.status = status;
            snapshot.activityState = activityState;
            if (errorMsg) snapshot.error = errorMsg;
          },
        };
        return { runCtx, snapshot, getSessionAbortCalls: () => sessionAbortCalls };
      };

      const makeWrappedTools = (getRun: () => any) => {
        const stub = (name: string) =>
          (mgr as any).wrapSubagentTool(
            ws,
            {
              name,
              label: name,
              description: `stub ${name}`,
              parameters: {},
              execute: async (_id: string, params: any) => ({
                content: [{ type: 'text', text: `${name} ok: ${JSON.stringify(params)}` }],
              }),
            },
            getRun
          );
        return {
          write: stub('write'),
          bash: stub('bash'),
          read: stub('read'),
        };
      };

      const getResultText = (res: any): string =>
        Array.isArray(res?.content)
          ? res.content
              .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
              .map((p: any) => p.text)
              .join('\n')
          : '';

      // Part A: Unset budgetMaxStallCalls -> scratch loop never resets callsSinceProgress,
      // emits [效率提醒 / STDOUT-FIRST] on 3rd tmp read, emits [进展纠偏 / PROGRESS CHECK] at 18,
      // and resets cleanly on research doc & deliverable apply.py writes.
      const soft = makeSyntheticRun();
      const softTools = makeWrappedTools(() => soft.runCtx);

      let callSeq = 0;
      for (let cycle = 1; cycle <= 6; cycle += 1) {
        const wRes = await softTools.write.execute(
          `c-${++callSeq}`,
          { path: '.papercup/tmp/x/analyze.py', content: `# cycle ${cycle}\n` },
          undefined,
          undefined,
          {}
        );
        assert.equal(soft.runCtx.callsSinceProgress, (cycle - 1) * 3 + 1);
        assert.equal(soft.snapshot.lastProgressSummary, null);
        assert.equal(getResultText(wRes).includes('[进展纠偏 / PROGRESS CHECK]'), false);

        const bRes = await softTools.bash.execute(
          `c-${++callSeq}`,
          { command: 'python .papercup/tmp/x/analyze.py' },
          undefined,
          undefined,
          {}
        );
        assert.equal(soft.runCtx.callsSinceProgress, (cycle - 1) * 3 + 2);
        assert.equal(getResultText(bRes).includes('[进展纠偏 / PROGRESS CHECK]'), false);

        const rRes = await softTools.read.execute(
          `c-${++callSeq}`,
          { path: '.papercup/tmp/x/out.txt' },
          undefined,
          undefined,
          {}
        );
        const rText = getResultText(rRes);
        assert.equal(soft.runCtx.callsSinceProgress, cycle * 3);
        assert.equal(soft.runCtx.tmpTextReadCount, cycle);

        if (cycle === 3) {
          assert.ok(
            rText.includes('[效率提醒 / STDOUT-FIRST]'),
            `Expected [效率提醒 / STDOUT-FIRST] on 3rd tmp text read, got:\n${rText}`
          );
        } else {
          assert.equal(
            rText.includes('[效率提醒 / STDOUT-FIRST]'),
            false,
            `Unexpected [效率提醒 / STDOUT-FIRST] on cycle ${cycle}:\n${rText}`
          );
        }

        if (cycle === 6) {
          assert.ok(
            rText.includes('[进展纠偏 / PROGRESS CHECK]'),
            `Expected [进展纠偏 / PROGRESS CHECK] at 18 stalled calls, got:\n${rText}`
          );
          assert.equal(soft.runCtx.lastSoftStallRemindAt, 18);
        } else {
          assert.equal(
            rText.includes('[进展纠偏 / PROGRESS CHECK]'),
            false,
            `Unexpected [进展纠偏 / PROGRESS CHECK] on cycle ${cycle} (${soft.runCtx.callsSinceProgress} stalled calls)`
          );
        }
      }
      assert.equal(soft.runCtx.finalized, false, 'Soft stall notice must NOT abort run when budgetMaxStallCalls is unset');

      // Milestone reset #1: writing research doc resets callsSinceProgress & sets lastProgressSummary
      const layoutRes = await softTools.write.execute(
        `c-${++callSeq}`,
        { path: '.papercup/research/x/01-layout.md', content: '# Layout\n' },
        undefined,
        undefined,
        {}
      );
      assert.equal(soft.runCtx.callsSinceProgress, 0);
      assert.equal(soft.runCtx.lastSoftStallRemindAt, 0);
      assert.equal(soft.snapshot.lastProgressSummary, '写入 .papercup/research/x/01-layout.md');
      assert.ok(soft.snapshot.lastProgressAt, 'lastProgressAt must be recorded on research doc write');
      assert.equal(getResultText(layoutRes).includes('[进展纠偏 / PROGRESS CHECK]'), false);

      // Reading a .py script under .papercup/tmp/ does NOT increment tmpTextReadCount or emit STDOUT-FIRST
      const pyReadRes = await softTools.read.execute(
        `c-${++callSeq}`,
        { path: '.papercup/tmp/x/analyze.py' },
        undefined,
        undefined,
        {}
      );
      assert.equal(soft.runCtx.callsSinceProgress, 1);
      assert.equal(soft.runCtx.tmpTextReadCount, 6);
      assert.equal(getResultText(pyReadRes).includes('[效率提醒 / STDOUT-FIRST]'), false);

      // Accrue 2 more scratch calls then write deliverable .papercup/tmp/x/apply.py -> resets back to 0
      await softTools.write.execute(`c-${++callSeq}`, { path: '.papercup/tmp/x/analyze.py', content: '# v2\n' }, undefined, undefined, {});
      await softTools.bash.execute(`c-${++callSeq}`, { command: 'python .papercup/tmp/x/analyze.py' }, undefined, undefined, {});
      assert.equal(soft.runCtx.callsSinceProgress, 3);

      await softTools.write.execute(
        `c-${++callSeq}`,
        { path: '.papercup/tmp/x/apply.py', content: '# deliverable apply script\n' },
        undefined,
        undefined,
        {}
      );
      assert.equal(soft.runCtx.callsSinceProgress, 0);
      assert.equal(soft.snapshot.lastProgressSummary, '写入 .papercup/tmp/x/apply.py');

      // Part B: Configured budgetMaxStallCalls = 6 -> emits [停滞提醒] at 3 and triggers [停滞熔断 / STALL STOP] at 6
      const hard = makeSyntheticRun({ budgetMaxStallCalls: 6 });
      const hardTools = makeWrappedTools(() => hard.runCtx);

      await hardTools.write.execute('h-1', { path: '.papercup/tmp/x/analyze.py', content: '# 1\n' }, undefined, undefined, {});
      await hardTools.bash.execute('h-2', { command: 'python .papercup/tmp/x/analyze.py' }, undefined, undefined, {});
      const h3Res = await hardTools.read.execute('h-3', { path: '.papercup/tmp/x/out.txt' }, undefined, undefined, {});
      assert.equal(hard.runCtx.callsSinceProgress, 3);
      assert.ok(getResultText(h3Res).includes('[停滞提醒]'), `Expected [停滞提醒] at call 3/6, got:\n${getResultText(h3Res)}`);
      assert.equal(hard.runCtx.finalized, false);

      await hardTools.write.execute('h-4', { path: '.papercup/tmp/x/analyze.py', content: '# 2\n' }, undefined, undefined, {});
      await hardTools.bash.execute('h-5', { command: 'python .papercup/tmp/x/analyze.py' }, undefined, undefined, {});
      assert.equal(hard.runCtx.callsSinceProgress, 5);
      assert.equal(hard.runCtx.finalized, false);

      const h6Res = await hardTools.read.execute('h-6', { path: '.papercup/tmp/x/out.txt' }, undefined, undefined, {});
      const h6Text = getResultText(h6Res);
      assert.equal(hard.runCtx.callsSinceProgress, 6);
      assert.ok(h6Text.includes('[停滞熔断 / STALL STOP]'), `Expected [停滞熔断 / STALL STOP] at call 6/6, got:\n${h6Text}`);
      assert.equal(hard.runCtx.finalized, true);
      assert.equal(hard.snapshot.status, 'aborted');
      assert.equal(hard.runCtx.budgetResumable, true);
      assert.equal(hard.getSessionAbortCalls(), 1);
      assert.ok(
        hard.snapshot.pivotWarnings.some((w) => w.includes('停滞熔断阈值 6 次')),
        `Expected stall stop warning in pivotWarnings, got: ${JSON.stringify(hard.snapshot.pivotWarnings)}`
      );
    });
  });

  it('8.5 SubagentManager.runSubagentWithMetrics offline faux-model run enforces papercup.toml max_reverser_stall_calls and stdout-first reminder', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const prevEnvMaxStall = process.env.PAPERCUP_REVERSER_MAX_STALL_CALLS;
      delete process.env.PAPERCUP_REVERSER_MAX_STALL_CALLS;

      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.research]\nmax_reverser_stall_calls = 6\n',
        'utf8'
      );

      const mgr = new SubagentManager();
      const faux = createFauxCore({ tokensPerSecond: 10000 });
      const origCreate = mgr.createSubagentSession.bind(mgr);
      mgr.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate(roleName, opts);
        (res.session as any).agent.state.model = faux.getModel();
        (res.session as any).agent.streamFunction = faux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };

      const observedToolResults = new Map<string, string>();
      const captureToolResult = (ctx: any, callId: string) => {
        const msg = ctx.messages.find((m: any) => m.role === 'toolResult' && m.toolCallId === callId);
        if (!msg) return;
        const text = Array.isArray(msg.content)
          ? msg.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : '';
        observedToolResults.set(callId, text);
      };

      faux.setResponses([
        // Turn 1: write scratch analyze.py (stall 1)
        () =>
          fauxAssistantMessage([
            fauxToolCall('write', { path: '.papercup/tmp/x/analyze.py', content: 'print("probe")\n' }, { id: 'e2e-1' }),
          ]),
        // Turn 2: write scratch out.txt (stall 2)
        () =>
          fauxAssistantMessage([
            fauxToolCall('write', { path: '.papercup/tmp/x/out.txt', content: 'probe dump line 1\n' }, { id: 'e2e-2' }),
          ]),
        // Turn 3: 1st read of out.txt (stall 3 -> [停滞提醒], tmpTextReadCount=1)
        () => fauxAssistantMessage([fauxToolCall('read', { path: '.papercup/tmp/x/out.txt' }, { id: 'e2e-3' })]),
        // Turn 4: 2nd read of out.txt (stall 4, tmpTextReadCount=2)
        (ctx) => {
          captureToolResult(ctx, 'e2e-3');
          return fauxAssistantMessage([fauxToolCall('read', { path: '.papercup/tmp/x/out.txt' }, { id: 'e2e-4' })]);
        },
        // Turn 5: 3rd read of out.txt (stall 5, tmpTextReadCount=3 -> [效率提醒 / STDOUT-FIRST])
        (ctx) => {
          captureToolResult(ctx, 'e2e-4');
          return fauxAssistantMessage([fauxToolCall('read', { path: '.papercup/tmp/x/out.txt' }, { id: 'e2e-5' })]);
        },
        // Turn 6: rewrite scratch analyze.py (stall 6 -> [停滞熔断 / STALL STOP])
        (ctx) => {
          captureToolResult(ctx, 'e2e-5');
          return fauxAssistantMessage([
            fauxToolCall('write', { path: '.papercup/tmp/x/analyze.py', content: 'print("probe2")\n' }, { id: 'e2e-6' }),
          ]);
        },
        () => fauxAssistantMessage('stopped'),
      ]);

      try {
        let caughtErr: any = null;
        try {
          await mgr.runSubagentWithMetrics('reverser', 'Inspect engine x container', {
            cwd: ws,
            model: faux.getModel(),
          });
        } catch (err) {
          caughtErr = err;
        }

        assert.ok(caughtErr, 'Expected reverser run to abort on 6th stalled turn');
        assert.equal(caughtErr.interruptKind, 'aborted');
        assert.equal(caughtErr.budgetResumable, true);
        assert.ok(
          String(caughtErr.message || '').includes('连续 6 次工具调用未产生新的研究记录或交付脚本'),
          `Unexpected abort error message: ${caughtErr.message}`
        );
        assert.equal(caughtErr.snapshot?.status, 'aborted');
        assert.equal(caughtErr.snapshot?.callsSinceProgress, 6);
        assert.equal(caughtErr.snapshot?.maxStallCalls, 6);
        assert.equal(caughtErr.snapshot?.lastProgressSummary, null);

        const turn3Out = observedToolResults.get('e2e-3') ?? '';
        const turn4Out = observedToolResults.get('e2e-4') ?? '';
        const turn5Out = observedToolResults.get('e2e-5') ?? '';
        assert.ok(turn3Out.includes('[停滞提醒]'), `Expected [停滞提醒] in Turn 3 toolResult, got:\n${turn3Out}`);
        assert.equal(turn3Out.includes('[效率提醒 / STDOUT-FIRST]'), false, 'Must not emit STDOUT-FIRST on 1st tmp read');
        assert.equal(turn4Out.includes('[效率提醒 / STDOUT-FIRST]'), false, 'Must not emit STDOUT-FIRST on 2nd tmp read');
        assert.ok(
          turn5Out.includes('[效率提醒 / STDOUT-FIRST]'),
          `Expected [效率提醒 / STDOUT-FIRST] in Turn 5 (3rd tmp read) toolResult, got:\n${turn5Out}`
        );
      } finally {
        mgr.disposeResumableSessions(ws);
        if (prevEnvMaxStall === undefined) {
          delete process.env.PAPERCUP_REVERSER_MAX_STALL_CALLS;
        } else {
          process.env.PAPERCUP_REVERSER_MAX_STALL_CALLS = prevEnvMaxStall;
        }
      }
    });
  });

  it('8.6 BUILTIN_SUBAGENTS.reverser.systemPrompt encodes stdout-first, literal negative-result stop-loss & progress check contracts', () => {
    const prompt = BUILTIN_SUBAGENTS.reverser.systemPrompt;
    assert.ok(prompt.length > 0, 'reverser systemPrompt must be non-empty');

    // Stdout-first probe guidance (no writing routine probe output to .papercup/tmp/ .txt/.log then read)
    assert.match(prompt, /stdout-first/i, 'Missing stdout-first guidance in reverser systemPrompt');
    assert.ok(
      prompt.includes('.txt') && prompt.includes('.log') && prompt.includes('.papercup/tmp/'),
      'Expected reverser systemPrompt to explicitly discourage scratch .txt/.log files under .papercup/tmp/'
    );
    assert.match(
      prompt,
      /extra\s+`?read`?\s+turn/i,
      'Expected reverser systemPrompt to warn against spending an extra read turn on routine probe output'
    );

    // Literal negative-result stop-loss (-1 / [])
    assert.ok(
      prompt.includes('-1') && prompt.includes('[]'),
      'Expected reverser systemPrompt to instruct literal negative-result reading (-1 and [])'
    );
    assert.ok(
      prompt.includes('02-hypotheses.md'),
      'Expected reverser systemPrompt to require logging falsified hypotheses to 02-hypotheses.md'
    );

    // Progress check & pivot markers
    assert.ok(
      prompt.includes('[进展纠偏 / PROGRESS CHECK]'),
      'Expected reverser systemPrompt to reference [进展纠偏 / PROGRESS CHECK]'
    );
    assert.ok(
      prompt.includes('[换路提醒 / PIVOT REQUIRED]'),
      'Expected reverser systemPrompt to reference [换路提醒 / PIVOT REQUIRED]'
    );
  });
});

describe('9. Dot-directory direct_root guard, D3D9 PrintWindow fallback, smoke wait-timeout diagnostics & reverser prompt contracts', () => {
  it('9.1 isBackupOrNonOriginalArchiveRel blocks top-level dot-directories while allowing valid game paths, and rejects .papercup-pacf-sample in learnUnpackSkill & buildPatchBundle', async () => {
    // 1) Pure contract on isBackupOrNonOriginalArchiveRel
    for (const blockedRel of [
      '.papercup-pacf-sample',
      './.papercup-pacf-sample',
      '.papercup-pacf-sample/Script.pac',
      '.hidden/sub',
      '.hidden\\sub',
      '.tmp-sample',
      '..',
    ]) {
      assert.equal(
        isBackupOrNonOriginalArchiveRel(blockedRel),
        true,
        `Expected isBackupOrNonOriginalArchiveRel("${blockedRel}") to be true`
      );
    }

    for (const allowedRel of [
      '.',
      './game_dir',
      'game_dir/sub',
      '根暗なクラスメイト_体験版',
      '根暗なクラスメイト_体験版/data/Script.pac',
    ]) {
      assert.equal(
        isBackupOrNonOriginalArchiveRel(allowedRel),
        false,
        `Expected isBackupOrNonOriginalArchiveRel("${allowedRel}") to be false`
      );
    }

    // 2) End-to-end negative check with learnUnpackSkill & buildPatchBundle for .papercup-pacf-sample
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-Hans"\n',
        'utf8'
      );
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup-pacf-sample'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'game_dir'), { recursive: true });

      const sampleScript = [
        'SAY:おはよう、今日もいい天気だね。',
        'SAY:放課後に図書室へ行こう。',
        'SAY:わかった、あとで合流しよう。',
        'SYS:セーブ',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup-pacf-sample', 'Script.pac'), sampleScript, 'utf8');
      fs.writeFileSync(path.join(ws, 'game_dir', 'Script.pac'), sampleScript, 'utf8');

      const extractPy = [
        'import json, os, sys',
        'lines = open(os.path.join(sys.argv[1], "Script.pac"), "r", encoding="utf-8").read().splitlines()',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    for i, line in enumerate(lines, 1):',
        '        tag, text = line.split(":", 1)',
        '        kind = "say" if tag == "SAY" else "system"',
        '        f.write(json.dumps({"id": f"d#{i}", "file": "Script.pac", "line": i, "kind": kind, "source": text}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, sys',
        'target_path = os.path.join(sys.argv[2], "Script.pac")',
        'lines = open(target_path, "r", encoding="utf-8").read().splitlines()',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'for r in rows:',
        '    idx = int(r["line"]) - 1',
        '    tag = lines[idx].split(":", 1)[0]',
        '    lines[idx] = f"{tag}:{r.get(\'target\') or r[\'source\']}"',
        'open(target_path, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'ext_dot.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_dot.py'), applyPy, 'utf8');

      const rejectedLearn = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'pacdot',
        pipeline: 'direct',
        unpackedDir: '.papercup-pacf-sample',
        extractScript: '.papercup/tmp/ext_dot.py',
        applyScript: '.papercup/tmp/app_dot.py',
        systemTextFiles: ['Script.pac'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(rejectedLearn.status, 'diagnosed');
      assert.ok(
        rejectedLearn.summary.includes('内部临时或备份目录') &&
          rejectedLearn.summary.includes('.papercup-pacf-sample'),
        `Expected learnUnpackSkill to reject .papercup-pacf-sample as direct_root, got: ${rejectedLearn.summary}`
      );

      // Adopt validly on game_dir, then poison engine.json direct_root to .papercup-pacf-sample -> buildPatchBundle must reject
      const okLearn = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'pacdot',
        pipeline: 'direct',
        unpackedDir: 'game_dir',
        extractScript: '.papercup/tmp/ext_dot.py',
        applyScript: '.papercup/tmp/app_dot.py',
        systemTextFiles: ['Script.pac'],
        encoding: 'utf-8',
        requireWriteback: true,
      });
      assert.equal(okLearn.status, 'adopted', `Expected valid direct skill adoption on game_dir, got: ${JSON.stringify(okLearn)}`);

      const engJsonPath = path.join(projectHarnessDir(ws, homeDir), 'engine.json');
      const engObj = JSON.parse(fs.readFileSync(engJsonPath, 'utf8')) as Record<string, unknown>;
      engObj.direct_root = '.papercup-pacf-sample';
      fs.writeFileSync(engJsonPath, JSON.stringify(engObj, null, 2) + '\n', 'utf8');

      fs.mkdirSync(path.join(ws, '.papercup', 'data', 'results'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'data', 'results', 'scenario.jsonl'),
        JSON.stringify({
          id: 'd#1',
          file: 'Script.pac',
          line: 1,
          track: 'scenario',
          source: 'おはよう、今日もいい天気だね。',
          target: '早上好，今天天气真好。',
          ok: true,
        }) + '\n',
        'utf8'
      );

      await assert.rejects(
        () =>
          buildPatchBundle(ws, makeProfile({ targetLang: 'zh-Hans' }), makeMemory(), {
            homeDir,
            dest: path.join(root, 'dot-direct-root-patch-out'),
          }),
        (err: unknown) =>
          err instanceof ExportCopyError &&
          err.message.includes('direct_root') &&
          err.message.includes('.papercup-pacf-sample') &&
          err.message.includes('内部临时或备份目录'),
        'buildPatchBundle must reject dot-directory direct_root ".papercup-pacf-sample" with ExportCopyError'
      );
    });
  });

  it('9.2 getWindowsSmokeDriverSource implements D3D9 PrintWindow uniform-color CopyFromScreen fallback and compiles cleanly on Windows', async () => {
    const src = getWindowsSmokeDriverSource();

    // 1) Structural contract on IsBitmapUniformColor & CaptureClientPng fallback flow
    assert.ok(src.includes('public static bool IsBitmapUniformColor(Bitmap bmp)'), 'Missing IsBitmapUniformColor helper');
    assert.ok(src.includes('BringWindowToTop'), 'Missing BringWindowToTop Win32 declaration/call');

    const captureMatch = /public static string CaptureClientPng\([\s\S]*?^\s{4}\}/m.exec(src);
    assert.ok(captureMatch, 'Expected CaptureClientPng method in Windows smoke driver source');
    const captureBody = captureMatch![0];

    const printIdx = captureBody.indexOf('PrintWindow(hwnd, hdc, PW_CLIENTONLY | PW_RENDERFULLCONTENT)');
    const fallbackIfIdx = captureBody.indexOf('if (!ok || IsBitmapUniformColor(activeBmp))');
    const bringTopIdx = captureBody.indexOf('BringWindowToTop(hwnd)');
    const copyScreenIdx = captureBody.indexOf('CopyFromScreen(');
    const keepUniformIdx = captureBody.indexOf('if (!ok || !IsBitmapUniformColor(screenBmp))');

    assert.ok(printIdx >= 0, 'CaptureClientPng must invoke PrintWindow with PW_CLIENTONLY | PW_RENDERFULLCONTENT');
    assert.ok(
      fallbackIfIdx > printIdx,
      `CaptureClientPng must check "if (!ok || IsBitmapUniformColor(activeBmp))" after PrintWindow:\n${captureBody}`
    );
    assert.ok(
      bringTopIdx > fallbackIfIdx && copyScreenIdx > bringTopIdx,
      `CaptureClientPng fallback must bring window to top before CopyFromScreen:\n${captureBody}`
    );
    assert.ok(
      keepUniformIdx > copyScreenIdx,
      `CaptureClientPng must preserve real uniform-black capture via "if (!ok || !IsBitmapUniformColor(screenBmp))":\n${captureBody}`
    );

    // 2) On Windows, verify PowerShell AST parse, C# Add-Type compilation, and IsBitmapUniformColor runtime behavior
    if (process.platform === 'win32') {
      await withTempWorkspace(({ root }) => {
        const ps1Path = path.join(root, '_papercup_smoke_driver.ps1');
        writeWindowsSmokeDriverScript(ps1Path);
        const checkerPath = path.join(root, 'check_driver.ps1');
        const checkerScript = [
          'param([string]$TargetPath)',
          '$ErrorActionPreference = "Stop"',
          '$tokens = $null; $errors = $null',
          '$ast = [System.Management.Automation.Language.Parser]::ParseFile($TargetPath, [ref]$tokens, [ref]$errors)',
          'if ($errors -and $errors.Count -gt 0) { throw ("PS1 parse errors: " + (($errors | ForEach-Object { $_.Message }) -join "; ")) }',
          '$raw = Get-Content -LiteralPath $TargetPath -Raw -Encoding UTF8',
          "$m = [regex]::Match($raw, '(?s)\\$cs\\s*=\\s*@''\\r?\\n(.*?)\\r?\\n''@')",
          'if (-not $m.Success) { throw "Failed to locate embedded C# block" }',
          'Add-Type -AssemblyName System.Drawing',
          'Add-Type -TypeDefinition $m.Groups[1].Value -ReferencedAssemblies System.Drawing',
          '$black = New-Object System.Drawing.Bitmap(16, 16, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
          'try {',
          '  for ($y = 0; $y -lt 16; $y++) { for ($x = 0; $x -lt 16; $x++) { $black.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, 0, 0, 0)) } }',
          '  $isBlackUniform = [PaperCupSmoke.Native]::IsBitmapUniformColor($black)',
          '  $black.SetPixel(8, 8, [System.Drawing.Color]::FromArgb(255, 240, 240, 240))',
          '  $isMixedUniform = [PaperCupSmoke.Native]::IsBitmapUniformColor($black)',
          '  Write-Output ("OK:" + $isBlackUniform + ":" + $isMixedUniform)',
          '} finally { $black.Dispose() }',
        ].join('\r\n');
        fs.writeFileSync(checkerPath, `\uFEFF${checkerScript}`, 'utf8');

        const out = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checkerPath, '-TargetPath', ps1Path],
          { encoding: 'utf8', timeout: 30000, windowsHide: true }
        ).trim();
        assert.equal(out, 'OK:True:False', `Expected PS1 AST parse + Add-Type + IsBitmapUniformColor check to output OK:True:False, got: ${out}`);
      });
    }
  });

  it('9.3 smoke driver & evaluateSmokeRules distinguish windowWaitTimeout from processExitedEarly and surface observedWindows', async () => {
    // 1) Driver source invariants
    const src = getWindowsSmokeDriverSource();
    assert.ok(
      src.includes('$windowWaitSec = [Math]::Min(25, [Math]::Max(15, [int][Math]::Floor($TimeoutSec / 4)))'),
      'Expected smoke driver to scale $windowWaitSec within 15..25 seconds'
    );
    assert.ok(
      src.includes('$processExitedEarly = [bool]$proc.HasExited'),
      'Expected smoke driver to set $processExitedEarly from $proc.HasExited'
    );
    assert.ok(
      src.includes('$windowWaitTimeout = (-not $processExitedEarly)'),
      'Expected smoke driver to set $windowWaitTimeout = (-not $processExitedEarly)'
    );
    assert.ok(
      src.includes('$observedWindows +=') &&
        src.includes('windowWaitTimeout = $windowWaitTimeout') &&
        src.includes('observedWindows = $observedWindows'),
      'Expected smoke driver to collect and emit observedWindows and windowWaitTimeout in done event'
    );

    // 2) evaluateSmokeRules: window wait timeout (process still alive) vs early process exit
    await withTempWorkspace(({ ws }) => {
      const baseDriverResult: SmokeDriverRunResult = {
        launched: true,
        windowFound: false,
        inputMode: 'none',
        stepsAdvanced: 0,
        durationMs: 15_200,
        processExitedEarly: false,
        windowWaitTimeout: true,
        observedWindows: ['LauncherClass:Startup (400x300)'],
        exitCode: null,
        hungDetected: false,
        frozenScreen: true,
        errorDialog: null,
        crashEvent: null,
        frames: [],
        textractorLines: [],
      };

      const timeoutEval = evaluateSmokeRules({
        driverResult: baseDriverResult,
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: false,
        visionEnabled: false,
      });

      const timeoutLaunchFinding = timeoutEval.findings.find((f) => f.ruleId === 'runtime.launch_failed');
      assert.ok(timeoutLaunchFinding, 'Expected runtime.launch_failed finding on window wait timeout');
      assert.equal(timeoutLaunchFinding!.severity, 'error');
      assert.ok(
        timeoutLaunchFinding!.message.includes('仍在运行') &&
          timeoutLaunchFinding!.message.includes('等待超时'),
        `Expected window-wait timeout wording explaining process is still running, got: ${timeoutLaunchFinding!.message}`
      );
      assert.equal(timeoutLaunchFinding!.evidence?.windowWaitTimeout, true);
      assert.equal(timeoutLaunchFinding!.evidence?.processExitedEarly, false);
      assert.deepEqual(timeoutLaunchFinding!.evidence?.observedWindows, ['LauncherClass:Startup (400x300)']);
      assert.equal(
        timeoutEval.findings.some((f) => f.ruleId === 'runtime.crash'),
        false,
        'Window wait timeout with process still running must not emit runtime.crash'
      );

      const earlyExitEval = evaluateSmokeRules({
        driverResult: {
          ...baseDriverResult,
          durationMs: 420,
          processExitedEarly: true,
          windowWaitTimeout: false,
          observedWindows: [],
          exitCode: 1,
        },
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: false,
        visionEnabled: false,
      });

      const earlyExitFinding = earlyExitEval.findings.find((f) => f.ruleId === 'runtime.launch_failed');
      assert.ok(earlyExitFinding, 'Expected runtime.launch_failed finding on early process exit');
      assert.equal(earlyExitFinding!.severity, 'error');
      assert.ok(
        earlyExitFinding!.message.includes('未出现可见窗口即退出'),
        `Expected early-exit wording in runtime.launch_failed, got: ${earlyExitFinding!.message}`
      );
      assert.equal(earlyExitFinding!.evidence?.processExitedEarly, true);
      assert.equal(earlyExitFinding!.evidence?.windowWaitTimeout, false);
      assert.equal(earlyExitFinding!.evidence?.exitCode, 1);
      assert.equal(earlyExitFinding!.evidence?.observedWindows, undefined);
      assert.equal(earlyExitEval.crash?.exitCode, 1);
    });
  });

  it('9.4 BUILTIN_SUBAGENTS.reverser.systemPrompt forbids TOC-matching jump target extraction (even with Japanese) and forbids apply.py sidecar state files in <dir>', () => {
    const prompt = BUILTIN_SUBAGENTS.reverser.systemPrompt;

    // 1) Forbid extracting script jump targets / scene filenames matching archive TOC entries even with Japanese characters
    assert.match(
      prompt,
      /script jump targets\s*\/\s*scene or chapter filenames matching archive TOC/i,
      'Expected reverser systemPrompt to forbid extracting script jump targets / scene filenames matching archive TOC entries'
    );
    assert.match(
      prompt,
      /even when they contain Japanese characters/i,
      'Expected reverser systemPrompt to explicitly cover TOC-matching jump targets containing Japanese characters'
    );
    assert.match(
      prompt,
      /translating a jump target breaks scene loading and causes black screens/i,
      'Expected reverser systemPrompt to explain that translating jump targets breaks scene loading and causes black screens'
    );

    // 2) Forbid writing auxiliary sidecar/state files (.papercup-*.json) into <dir> in apply.py
    const applyLine = prompt
      .split(/\r?\n/)
      .find((line) => line.includes('`apply.py <results_jsonl> <dir>`'));
    assert.ok(applyLine, 'Expected apply.py contract line in reverser systemPrompt');
    assert.ok(
      applyLine!.includes('.papercup-*.json') &&
        /NEVER drop auxiliary sidecar\/state files[\s\S]*into\s+`<dir>`/i.test(applyLine!),
      `Expected apply.py contract to forbid writing .papercup-*.json sidecar/state files into <dir>, got:\n${applyLine}`
    );
  });
});

/* ========================= Suite 10: TODO #107 Simplified Workspace Layout & Built-in patch/ ========================= */

describe('10. Simplified .papercup/{data,tmp} layout, anti-nesting patch/ exclusions, in-place patch/ & 补丁说明.md sync', () => {
  it('10.1 resolveWorkspacePaths returns exact single-source .papercup/{data,tmp}, patch/ & 补丁说明.md paths and typed helpers', async () => {
    await withTempWorkspace(({ ws }) => {
      const p = resolveWorkspacePaths(ws);
      const rel = (abs: string) => path.relative(p.root, abs).replace(/\\/g, '/');

      assert.equal(rel(p.dataDir), '.papercup/data');
      assert.equal(rel(p.tmpDir), '.papercup/tmp');
      assert.equal(rel(p.skillsDir), '.papercup/skills');
      assert.equal(rel(p.researchDir), '.papercup/research');
      assert.equal(rel(p.patchDir), 'patch');
      assert.equal(rel(p.patchManifestFile), 'patch/patch_manifest.json');
      assert.equal(rel(p.patchGuideFile), '补丁说明.md');

      // Persistent .papercup/data/*
      assert.equal(rel(p.buildDir), '.papercup/data/build');
      assert.equal(rel(p.resultsDir), '.papercup/data/results');
      assert.equal(rel(p.releaseDir), '.papercup/data/release');
      assert.equal(rel(p.defaultReleaseFile), '.papercup/data/release/README.md');
      assert.equal(rel(p.vnDir), '.papercup/data/vn');
      assert.equal(rel(p.profileTomlFile), '.papercup/data/vn/profile.toml');
      assert.equal(rel(p.textManifestFile), '.papercup/data/vn/text.json');
      assert.equal(rel(p.applyReportFile), '.papercup/data/vn/apply.json');
      assert.equal(rel(p.planFile), '.papercup/data/vn/plan.json');
      assert.equal(rel(p.progressFile), '.papercup/data/vn/progress.json');
      assert.equal(rel(p.checkpointsFile), '.papercup/data/vn/checkpoints.json');
      assert.equal(rel(p.acceptanceFile), '.papercup/data/vn/acceptance.json');
      assert.equal(rel(p.charactersFile), '.papercup/data/vn/characters.json');
      assert.equal(rel(p.formsDir), '.papercup/data/vn/forms');
      assert.equal(rel(p.lastPatchFile), '.papercup/data/vn/last-patch.json');
      assert.equal(rel(p.postQaStateFile), '.papercup/data/vn/post_qa_state.json');
      assert.equal(rel(p.postQaReportFile), '.papercup/data/vn/post_qa_report.json');
      assert.equal(rel(p.smokeReportFile), '.papercup/data/vn/smoke/report.json');
      assert.equal(rel(p.smokeRepairStateFile), '.papercup/data/vn/smoke/repair-state.json');

      // Disposable .papercup/tmp/*
      assert.equal(rel(p.unpackedDir), '.papercup/tmp/unpacked');
      assert.equal(rel(p.workDir), '.papercup/tmp/work');
      assert.equal(rel(p.batchesDir), '.papercup/tmp/work/batches');
      assert.equal(rel(p.batchesManifestFile), '.papercup/tmp/work/batches/manifest.json');
      assert.equal(rel(p.workOutDir), '.papercup/tmp/work/out');
      assert.equal(rel(p.countsFile), '.papercup/tmp/work/counts.json');
      assert.equal(rel(p.smokeTmpDir), '.papercup/tmp/smoke');
      assert.equal(rel(p.smokeFramesDir), '.papercup/tmp/smoke/frames');
      assert.equal(rel(p.smokeFailuresDir), '.papercup/tmp/smoke/failures');
      assert.equal(rel(p.diagnosticsDir), '.papercup/tmp/diagnostics');
      assert.equal(rel(p.subagentTasksDir), '.papercup/tmp/diagnostics/subagent-tasks');
      assert.equal(rel(p.toolOutputsDir), '.papercup/tmp/diagnostics/tool-outputs');

      // Typed helpers
      assert.equal(rel(p.buildTrackFile('scenario')), '.papercup/data/build/scenario.jsonl');
      assert.equal(rel(p.resultsTrackFile('ui')), '.papercup/data/results/ui.jsonl');
      assert.equal(rel(p.batchInputFile('batch_001')), '.papercup/tmp/work/batches/batch_001.jsonl');
      assert.equal(p.batchInputRel('batch_001'), '.papercup/tmp/work/batches/batch_001.jsonl');
      assert.equal(rel(p.batchOutFile('batch_001')), '.papercup/tmp/work/out/batch_001.jsonl');
      assert.equal(p.batchOutRel('batch_001'), '.papercup/tmp/work/out/batch_001.jsonl');
      assert.equal(rel(p.smokeSandboxDir('run-1')), '.papercup/tmp/smoke/run-1');
      assert.equal(rel(p.smokeFailureDir('run-1')), '.papercup/tmp/smoke/failures/run-1');
      assert.equal(rel(p.formFile('f-1')), '.papercup/data/vn/forms/f-1.json');
      assert.equal(rel(p.skillDir('engine-demo')), '.papercup/skills/engine-demo');
      assert.equal(rel(p.researchEngineDir('demo')), '.papercup/research/demo');
      assert.equal(rel(p.subagentTaskFile('t-1')), '.papercup/tmp/diagnostics/subagent-tasks/t-1.json');
    });
  });

  it('10.2 enforces anti-nesting exclusions for patch/ and 补丁说明.md across scanWorkspace, direct_root, smoke sandbox, and git checkpoints', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      fs.writeFileSync(path.join(ws, 'papercup.toml'), '[vn.localization]\nnarrative_pov = "first"\n', 'utf8');
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      packDeltaXp3([['scenario/a.ks', encodeText('おはよう[p]\r\n', 'cp932')]], path.join(ws, 'data.xp3'));

      // Populate <ws>/patch/ with archives & scripts + root 补丁说明.md
      fs.mkdirSync(path.join(ws, 'patch', 'files'), { recursive: true });
      packDeltaXp3([['scenario/a.ks', encodeText('早上好[p]\r\n', 'utf-16le-bom')]], path.join(ws, 'patch', 'files', 'patch.xp3'));
      packDeltaXp3([['scenario/b.ks', encodeText('nested\r\n', 'utf-8')]], path.join(ws, 'patch', 'nested.xp3'));
      fs.writeFileSync(path.join(ws, 'patch', 'Script.pac'), 'SAY:nested\n', 'utf8');
      fs.writeFileSync(path.join(ws, WORKSPACE_PATCH_GUIDE_REL), '# guide\n', 'utf8');

      // 1) scanWorkspace must ignore patch/ archives while detecting real data.xp3
      const scan = scanWorkspace(ws, homeDir);
      const hitPaths = scan.hits.map((h) => h.path);
      assert.equal(hitPaths.includes('data.xp3'), true);
      assert.equal(hitPaths.some((p) => p.startsWith('patch/')), false, `scanWorkspace must skip patch/: ${JSON.stringify(hitPaths)}`);

      // 2) isBackupOrNonOriginalArchiveRel rejects patch/ and nested patch paths
      for (const bad of ['patch', './patch', 'patch/files/patch.xp3', 'patch\\Script.pac']) {
        assert.equal(isBackupOrNonOriginalArchiveRel(bad), true, `Expected isBackupOrNonOriginalArchiveRel("${bad}") === true`);
      }

      // 3) learnUnpackSkill rejects direct_root="patch"
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.papercup', 'tmp', 'ext_p.py'),
        'import json, os, sys\nopen(sys.argv[2], "w", encoding="utf-8").write(json.dumps({"id":"1","file":"Script.pac","line":1,"kind":"say","source":"nested"})+"\\n")\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'app_p.py'), 'import sys\n', 'utf8');
      const badPatchDirect = await learnUnpackSkill(ws, {
        homeDir,
        engine: 'patchnest',
        pipeline: 'direct',
        unpackedDir: 'patch',
        extractScript: '.papercup/tmp/ext_p.py',
        applyScript: '.papercup/tmp/app_p.py',
        systemTextFiles: ['Script.pac'],
        encoding: 'utf-8',
      });
      assert.equal(badPatchDirect.status, 'diagnosed');
      assert.ok(badPatchDirect.summary.includes('内部临时或备份目录'));

      // 4) prepareSmokeSandbox & prepareSmokeSandboxFromOverlay exclude <ws>/patch/ and <ws>/补丁说明.md
      const extPatchDir = path.join(root, 'ext-smoke-patch');
      fs.mkdirSync(path.join(extPatchDir, 'files'), { recursive: true });
      const patchBytes = Buffer.from('OVERLAY_XP3', 'utf8');
      fs.writeFileSync(path.join(extPatchDir, 'files', 'patch.xp3'), patchBytes);
      const manifestPath = path.join(extPatchDir, 'patch_manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          artifacts: [
            { kind: 'overlay_archive', patch_rel: 'files/patch.xp3', install_rel: 'patch.xp3', action: 'add', sha256: sha256Hex(patchBytes), bytes: patchBytes.length },
          ],
        }),
        'utf8'
      );
      const sbManifest = prepareSmokeSandbox(ws, manifestPath);
      try {
        assert.equal(fs.existsSync(path.join(sbManifest.sandboxDir, 'patch')), false, 'Smoke sandbox must exclude workspace patch/');
        assert.equal(fs.existsSync(path.join(sbManifest.sandboxDir, WORKSPACE_PATCH_GUIDE_REL)), false, 'Smoke sandbox must exclude root 补丁说明.md');
        assert.equal(fs.existsSync(path.join(sbManifest.sandboxDir, 'Game.exe')), true);
      } finally {
        sbManifest.cleanup();
      }
      const sbOverlay = prepareSmokeSandboxFromOverlay(ws, path.join(extPatchDir, 'files'));
      try {
        assert.equal(fs.existsSync(path.join(sbOverlay.sandboxDir, 'patch')), false, 'Overlay smoke sandbox must exclude workspace patch/');
        assert.equal(fs.existsSync(path.join(sbOverlay.sandboxDir, WORKSPACE_PATCH_GUIDE_REL)), false, 'Overlay smoke sandbox must exclude root 补丁说明.md');
      } finally {
        sbOverlay.cleanup();
      }

      // 5) createCheckpoint ignores .papercup/tmp/ and patch/ while tracking .papercup/data/*
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(wsPaths.buildDir, { recursive: true });
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.mkdirSync(wsPaths.unpackedDir, { recursive: true });
      fs.writeFileSync(wsPaths.buildTrackFile('scenario'), '{"id":"1","source":"おはよう"}\n', 'utf8');
      fs.writeFileSync(wsPaths.resultsTrackFile('scenario'), '{"id":"1","source":"おはよう","target":"早上好","ok":true}\n', 'utf8');
      fs.writeFileSync(path.join(wsPaths.unpackedDir, 'temp.ks'), 'temp\n', 'utf8');

      const cp = await createCheckpoint(ws, 'baseline', 'layout check');
      assert.equal(cp.skipped_clean, false);
      const tracked = execFileSync('git', ['ls-files'], { cwd: ws, encoding: 'utf8' })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      assert.equal(tracked.includes('.papercup/data/build/scenario.jsonl'), true, `Expected .papercup/data/build tracked: ${JSON.stringify(tracked)}`);
      assert.equal(tracked.includes('.papercup/data/results/scenario.jsonl'), true, `Expected .papercup/data/results tracked: ${JSON.stringify(tracked)}`);
      assert.equal(tracked.some((f) => f.startsWith('.papercup/tmp/')), false, `.papercup/tmp/ must never be staged: ${JSON.stringify(tracked)}`);
      assert.equal(tracked.some((f) => f.startsWith('patch/')), false, `patch/ must never be staged: ${JSON.stringify(tracked)}`);
    });
  });

  it('10.3 defaults vn_writeback to <ws>/patch/ with safe in-place overwrite, failure preservation, inside-ws guard, explicit dest & 补丁说明.md sync', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.writeFileSync(
        wsPaths.papercupTomlFile,
        '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "first"\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      packDeltaXp3([['scenario/first.ks', encodeText('*start\r\nおはよう[p]\r\n', 'cp932')]], path.join(ws, 'data.xp3'));

      await unpackVnArchives(ws);
      await classifyVnScripts(ws, {});
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        JSON.stringify({ id: 'scenario/first.ks#2', file: 'scenario/first.ks', line: 2, track: 'scenario', kind: 'say', source: 'おはよう[p]', target: '纸杯工坊早上好[p]', ok: true }) + '\n',
        'utf8'
      );

      // 1) Default writeback (no dest) -> <ws>/patch/ + <ws>/补丁说明.md + <ws>/patch/README.md + last-patch.json
      const wb1 = await writebackVnCopy(ws, {});
      assert.equal(path.resolve(String(wb1.patch_dir)), path.resolve(wsPaths.patchDir));
      assert.equal(path.resolve(String(wb1.manifest_path)), path.resolve(wsPaths.patchManifestFile));
      assert.equal(path.resolve(String(wb1.patch_guide_path)), path.resolve(wsPaths.patchGuideFile));
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'files', 'patch.xp3')), true);
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'README.md')), true);
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'install_patch.bat')), true);
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'uninstall_patch.bat')), true);
      assert.equal(fs.existsSync(wsPaths.patchGuideFile), true);
      const guide1 = fs.readFileSync(wsPaths.patchGuideFile, 'utf8');
      assert.ok(guide1.includes('patch/') && guide1.includes('..') && guide1.includes('install_patch.bat'));
      const lastMeta1 = readLastPatchMeta(ws);
      assert.ok(lastMeta1 && path.resolve(lastMeta1.patch_dir) === path.resolve(wsPaths.patchDir));

      // 2) Failed in-place writeback must NOT wipe pre-existing <ws>/patch/ files
      fs.writeFileSync(path.join(wsPaths.patchDir, 'files', 'stale.xp3'), 'STALE_DATA', 'utf8');
      fs.writeFileSync(path.join(wsPaths.patchDir, 'papercup_patch.ini'), '[patch]\nstale=1\n', 'utf8');
      fs.writeFileSync(path.join(wsPaths.patchDir, 'user_keep.txt'), 'KEEP_USER', 'utf8');
      const prevPatchBytes = fs.readFileSync(path.join(wsPaths.patchDir, 'files', 'patch.xp3'));

      await assert.rejects(
        () => writebackVnCopy(ws, { encoding: 'cp932' }),
        /cp932|不支持|无法编码|无法用编码/
      );
      assert.ok(fs.readFileSync(path.join(wsPaths.patchDir, 'files', 'patch.xp3')).equals(prevPatchBytes), 'Failed writeback must preserve previous patch.xp3');
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'files', 'stale.xp3')), true, 'Failed writeback must not wipe stale managed files prematurely');

      // 3) Second succeeding default writeback safely overwrites <ws>/patch/ in place (without force=true), purges stale managed files, preserves user_keep.txt, and updates 补丁说明.md
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        JSON.stringify({ id: 'scenario/first.ks#2', file: 'scenario/first.ks', line: 2, track: 'scenario', kind: 'say', source: 'おはよう[p]', target: '欢迎来到纸杯工坊[p]', ok: true }) + '\n',
        'utf8'
      );
      const wb2 = await writebackVnCopy(ws, {});
      assert.equal(path.resolve(String(wb2.patch_dir)), path.resolve(wsPaths.patchDir));
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'files', 'stale.xp3')), false, 'In-place update must clean stale managed files/');
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'papercup_patch.ini')), false, 'In-place update must remove unused papercup_patch.ini');
      assert.equal(fs.readFileSync(path.join(wsPaths.patchDir, 'user_keep.txt'), 'utf8'), 'KEEP_USER', 'In-place update must preserve unrelated user files');
      const verifyDir = path.join(root, 'verify-inplace');
      unpackXp3(path.join(wsPaths.patchDir, 'files', 'patch.xp3'), verifyDir);
      assert.ok(fs.readFileSync(path.join(verifyDir, 'scenario', 'first.ks')).subarray(2).toString('utf16le').includes('欢迎来到纸杯工坊[p]'));

      // 4) Reject arbitrary other inside-workspace dest (only <ws>/patch or external dest allowed)
      await assert.rejects(
        () => writebackVnCopy(ws, { dest: 'custom_inside_dir' }),
        /只能使用默认 patch\/ 目录或工作区之外的路径/
      );

      // 5) Explicit external dest exports outside workspace and syncs root 补丁说明.md + external README.md
      const externalDest = path.join(root, 'external-release-patch');
      const wbExt = await writebackVnCopy(ws, { dest: externalDest });
      assert.equal(path.resolve(String(wbExt.patch_dir)), path.resolve(externalDest));
      assert.equal(fs.existsSync(path.join(externalDest, 'patch_manifest.json')), true);
      assert.equal(fs.existsSync(path.join(externalDest, 'README.md')), true);
      const guideExt = fs.readFileSync(wsPaths.patchGuideFile, 'utf8');
      assert.ok(guideExt.includes(externalDest.replace(/\\/g, '/')), `External export should sync root 补丁说明.md with external path, got:\n${guideExt}`);
    });
  });

  it('10.4 install_patch.bat / uninstall_patch.bat default interactive no-arg runs to parent dir .. (pure-ASCII CRLF + live Windows roundtrip)', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.writeFileSync(
        wsPaths.papercupTomlFile,
        '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nnarrative_pov = "first"\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, 'nscr.exe'), makeDummyPeExe('x86'));
      const origNsa = buildNsaArchive([{ name: '0.txt', data: encodeText('おはよう、世界。\r\n', 'cp932') }]);
      fs.writeFileSync(path.join(ws, 'arc.nsa'), origNsa);

      await unpackVnArchives(ws);
      await classifyVnScripts(ws, {});
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        JSON.stringify({ id: '0.txt#1', file: '0.txt', line: 1, track: 'scenario', kind: 'say', source: 'おはよう、世界。', target: '早上好，世界。', ok: true }) + '\n',
        'utf8'
      );

      const wb = await writebackVnCopy(ws, {});
      assert.equal(path.resolve(String(wb.patch_dir)), path.resolve(wsPaths.patchDir));
      const installBatPath = path.join(wsPaths.patchDir, 'install_patch.bat');
      const uninstallBatPath = path.join(wsPaths.patchDir, 'uninstall_patch.bat');

      // Pure-ASCII CRLF + default parent directory ".." contract
      for (const batPath of [installBatPath, uninstallBatPath]) {
        const raw = fs.readFileSync(batPath);
        for (let i = 0; i < raw.length; i += 1) {
          assert.ok(raw[i] <= 0x7e, `Non-ASCII byte 0x${raw[i].toString(16)} in ${batPath}`);
        }
        const text = raw.toString('ascii');
        assert.equal(/chcp\s+65001/i.test(text), false);
        assert.equal(text.includes('\r\n'), true);
        assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
        assert.ok(text.includes('"%PATCH_DIR%\\.."') && text.includes('DEFAULT_GAME_DIR'), `Expected parent dir .. default in ${batPath}`);
      }

      // Live Windows no-arg interactive roundtrip targeting parent dir <ws> from <ws>/patch/
      if (process.platform === 'win32') {
        const patchedNsaBytes = fs.readFileSync(path.join(wsPaths.patchDir, 'files', 'arc.nsa'));
        assert.equal(patchedNsaBytes.equals(origNsa), false);

        const instRes = spawnSync('cmd.exe', ['/c', installBatPath], {
          cwd: wsPaths.patchDir,
          input: '\r\n\r\n', // Enter to accept default .., Enter for pause
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(instRes.status, 0, `No-arg install_patch.bat failed:\nSTDOUT: ${instRes.stdout}\nSTDERR: ${instRes.stderr}`);
        assert.ok(fs.readFileSync(path.join(ws, 'arc.nsa')).equals(patchedNsaBytes), 'No-arg install_patch.bat must patch parent game dir ..');
        assert.equal(fs.existsSync(path.join(ws, 'papercup_patch.ini')), true);
        assert.ok(fs.readFileSync(path.join(ws, '.papercup_backup', 'arc.nsa')).equals(origNsa));

        const uninstRes = spawnSync('cmd.exe', ['/c', uninstallBatPath], {
          cwd: wsPaths.patchDir,
          input: '\r\n\r\n', // Enter to accept default .., Enter for pause
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(uninstRes.status, 0, `No-arg uninstall_patch.bat failed:\nSTDOUT: ${uninstRes.stdout}\nSTDERR: ${uninstRes.stderr}`);
        assert.ok(fs.readFileSync(path.join(ws, 'arc.nsa')).equals(origNsa), 'No-arg uninstall_patch.bat must restore original arc.nsa in parent dir ..');
        assert.equal(fs.existsSync(path.join(ws, 'papercup_patch.ini')), false);
        assert.equal(fs.existsSync(path.join(ws, '.papercup_backup')), false);
      }

      // Verify exported helper also generates pure-ASCII default-parent scripts
      const generated = buildInstallBatchScripts([
        { kind: 'overlay_archive', patch_rel: 'files/patch.xp3', install_rel: 'patch.xp3', action: 'add', sha256: '0'.repeat(64), bytes: 10 },
      ]);
      assert.ok(generated.installBat.includes('"%PATCH_DIR%\\.."') && generated.uninstallBat.includes('"%PATCH_DIR%\\.."'));
    });
  });
});

/* ========================= Suite 11: TODO #108 Community Skill Ecosystem & 3-Tier Registry ========================= */

describe('11. Community skill ecosystem: 3-tier priority, SHA-256 tamper rejection, dynamic vn_detect binding & sanitized export', () => {
  function writeSelfContainedSkill(
    tierRoot: string,
    opts: {
      engine: string;
      pipeline?: 'skill' | 'direct';
      magicHex?: string;
      suffix?: string;
      controlPattern?: string;
      marker?: string;
      systemTextFiles?: string[];
      unpackPy?: string;
      repackPy?: string;
      extractPy?: string;
      applyPy?: string;
      testFixturePy?: string;
      extraEngineFields?: Record<string, unknown>;
      extraFrontmatterLines?: string[];
    }
  ): string {
    const skillName = `engine-${opts.engine}`;
    const skillDir = path.join(tierRoot, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    const pipeline = opts.pipeline ?? 'skill';
    const marker = opts.marker ?? opts.engine;
    const magicBytes = Buffer.from(opts.magicHex ?? '54334b31', 'hex').toString('latin1');

    const skillMd = [
      '---',
      `name: ${skillName}`,
      `description: Synthetic ${marker} engine skill.`,
      ...(opts.extraFrontmatterLines ?? []),
      '---',
      '',
      `# ${skillName}`,
      '',
      `Marker: ${marker}`,
      '',
    ].join('\n');

    const scripts: Record<string, string> = {};
    if (pipeline === 'skill') {
      scripts['unpack.py'] =
        opts.unpackPy ??
        [
          'import os, sys',
          'raw = open(sys.argv[1], "rb").read()',
          `assert raw[:4] == ${JSON.stringify(magicBytes)}.encode("latin1")`,
          'os.makedirs(sys.argv[2], exist_ok=True)',
          `open(os.path.join(sys.argv[2], "s.txt"), "wb").write(raw[4:] + b"\\n#${marker}\\n")`,
          '',
        ].join('\n');
      scripts['repack.py'] =
        opts.repackPy ??
        [
          'import os, sys',
          'data = open(os.path.join(sys.argv[1], "s.txt"), "rb").read()',
          `open(sys.argv[2], "wb").write(${JSON.stringify(magicBytes)}.encode("latin1") + data)`,
          '',
        ].join('\n');
    }
    if (opts.extractPy !== undefined || pipeline === 'direct') {
      scripts['extract.py'] =
        opts.extractPy ??
        [
          'import json, os, sys',
          'lines = open(os.path.join(sys.argv[1], "story.tbl"), "r", encoding="utf-8").read().splitlines()',
          'with open(sys.argv[2], "w", encoding="utf-8") as fh:',
          '    for i, l in enumerate(lines, 1):',
          '        if l.strip(): fh.write(json.dumps({"id": f"d#{i}", "file": "story.tbl", "line": i, "kind": "say", "source": l}, ensure_ascii=False) + "\\n")',
          '',
        ].join('\n');
    }
    if (opts.applyPy !== undefined || pipeline === 'direct') {
      scripts['apply.py'] =
        opts.applyPy ??
        [
          'import json, os, sys',
          'rows = [json.loads(l) for l in open(sys.argv[1], "r", encoding="utf-8") if l.strip()]',
          'p = os.path.join(sys.argv[2], "story.tbl")',
          'lines = open(p, "r", encoding="utf-8").read().splitlines()',
          'for r in rows:',
          '    lines[int(r["line"]) - 1] = r.get("target") or r["source"]',
          'open(p, "w", encoding="utf-8", newline="\\n").write("\\n".join(lines) + "\\n")',
          '',
        ].join('\n');
    }

    const engineObj: Record<string, unknown> = {
      schema_version: 1,
      name: opts.engine,
      kinds: [opts.engine],
      pipeline,
      skill: skillName,
      'skill-sha256': hashSkillTextContent(skillMd),
      ...(pipeline === 'skill'
        ? {
            match: {
              extensions: [opts.suffix ?? '.t3k'],
              magic_hex: opts.magicHex ?? '54334b31',
              magic_offset: 0,
            },
          }
        : {}),
      writeback: {
        mode: pipeline === 'direct' ? 'direct_skill_apply' : 'builtin_apply',
        encoding: 'utf-8',
        ...(opts.controlPattern ? { control_pattern: opts.controlPattern } : {}),
        verified: true,
      },
      ...(opts.systemTextFiles ? { system_text: { files: opts.systemTextFiles } } : {}),
      ...(opts.extraEngineFields ?? {}),
    };

    const digestMap: Record<string, string> = {
      'unpack.py': 'unpack-sha256',
      'repack.py': 'repack-sha256',
      'extract.py': 'extract-sha256',
      'apply.py': 'apply-sha256',
    };
    for (const [fname, content] of Object.entries(scripts)) {
      fs.writeFileSync(path.join(skillDir, fname), content, 'utf8');
      engineObj[digestMap[fname]] = hashSkillTextContent(content);
    }
    if (opts.testFixturePy) {
      fs.writeFileSync(path.join(skillDir, 'test_fixture.py'), opts.testFixturePy, 'utf8');
    }
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
    fs.writeFileSync(path.join(skillDir, 'engine.json'), JSON.stringify(engineObj, null, 2) + '\n', 'utf8');
    return skillDir;
  }

  it('11.1 resolves 3-tier priority (workspace > global > repo) with clean fallthrough and deduplicates AgentService skill roots', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      const wsSkillsDir = path.join(ws, '.papercup', 'skills');
      const globalSkillsDir = path.join(homeDir, 'skills');
      const repoSkillsDir = path.join(root, 'mock-repo-skills');
      const prevRepoEnv = process.env.PAPERCUP_REPO_SKILLS_DIR;
      process.env.PAPERCUP_REPO_SKILLS_DIR = repoSkillsDir;

      try {
        writeSelfContainedSkill(repoSkillsDir, {
          engine: 't3eng',
          marker: 'repo-tier',
          controlPattern: '<REPO_TAG>',
        });
        writeSelfContainedSkill(globalSkillsDir, {
          engine: 't3eng',
          marker: 'global-tier',
          controlPattern: '<GLOBAL_TAG>',
        });
        writeSelfContainedSkill(wsSkillsDir, {
          engine: 't3eng',
          marker: 'workspace-tier',
          controlPattern: '<WS_TAG>',
        });
        writeSelfContainedSkill(repoSkillsDir, {
          engine: 'repoonly',
          marker: 'repo-only',
          magicHex: '52503031',
          suffix: '.rp1',
        });

        // 1) Workspace wins over global & repo
        const pkgWs = findSkillPackageByEngine('t3eng', ws, { homeDir, repoSkillsDir });
        assert.equal(pkgWs?.tier, 'workspace');
        assert.equal(resolveSkillBindingFromRegistry(ws, 't3eng', { homeDir, repoSkillsDir }).tier, 'workspace');
        assert.equal(resolveWorkspaceControlPattern(ws, homeDir, 't3eng'), '<WS_TAG>');

        // Deduplicated skill dirs: 2 unique skills (engine-t3eng from workspace, engine-repoonly from repo)
        const dedup1 = collectDeduplicatedSkillDirs(ws, { homeDir, repoSkillsDir });
        assert.equal(dedup1.length, 2);
        assert.equal(dedup1.some((d) => path.resolve(d) === path.resolve(path.join(wsSkillsDir, 'engine-t3eng'))), true);
        assert.equal(dedup1.some((d) => path.resolve(d) === path.resolve(path.join(repoSkillsDir, 'engine-repoonly'))), true);

        // AgentService lists deduplicated skills across all 3 tiers without duplicates
        const svc = new AgentService(ws, { sessionMode: 'memory' });
        try {
          const engStatus = await svc.getEngineeringStatus();
          assert.equal(engStatus.skills.filter((s) => s === 'engine-t3eng').length, 1);
          assert.equal(engStatus.skills.includes('engine-repoonly'), true);
        } finally {
          (svc as any).disposeCurrentSessionState?.(true);
        }

        // 2) Remove workspace -> falls through to global
        fs.rmSync(path.join(wsSkillsDir, 'engine-t3eng'), { recursive: true, force: true });
        assert.equal(findSkillPackageByEngine('t3eng', ws, { homeDir, repoSkillsDir })?.tier, 'global');
        assert.equal(resolveSkillBindingFromRegistry(ws, 't3eng', { homeDir, repoSkillsDir }).tier, 'global');
        assert.equal(resolveWorkspaceControlPattern(ws, homeDir, 't3eng'), '<GLOBAL_TAG>');

        // 3) Remove global -> falls through to repo
        fs.rmSync(path.join(globalSkillsDir, 'engine-t3eng'), { recursive: true, force: true });
        assert.equal(findSkillPackageByEngine('t3eng', ws, { homeDir, repoSkillsDir })?.tier, 'repo');
        assert.equal(resolveSkillBindingFromRegistry(ws, 't3eng', { homeDir, repoSkillsDir }).tier, 'repo');
        assert.equal(resolveWorkspaceControlPattern(ws, homeDir, 't3eng'), '<REPO_TAG>');

        // 4) Real repository skills/ directory discovers bundled engine-nexas-pacf
        delete process.env.PAPERCUP_REPO_SKILLS_DIR;
        const realPkgs = discoverSkillPackages(ws, { homeDir });
        const realNexas = realPkgs.find((p) => p.skillName === 'engine-nexas-pacf');
        assert.ok(realNexas && realNexas.tier === 'repo', 'Expected built-in repo skill engine-nexas-pacf to be discovered');
        assert.equal(verifySkillPackageIntegrity(realNexas!).ok, true);
      } finally {
        if (prevRepoEnv === undefined) delete process.env.PAPERCUP_REPO_SKILLS_DIR;
        else process.env.PAPERCUP_REPO_SKILLS_DIR = prevRepoEnv;
      }
    });
  });

  it('11.2 enforces mandatory SHA-256 tamper rejection on global and repo skills at binding and execution time', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      const globalSkillsDir = path.join(homeDir, 'skills');
      const repoSkillsDir = path.join(root, 'tamper-repo-skills');
      const prevRepoEnv = process.env.PAPERCUP_REPO_SKILLS_DIR;
      process.env.PAPERCUP_REPO_SKILLS_DIR = repoSkillsDir;

      try {
        // Set up one valid global skill (.glb) and one valid repo skill (.rpo)
        const glbDir = writeSelfContainedSkill(globalSkillsDir, {
          engine: 'glbeng',
          magicHex: '474c4231',
          suffix: '.glb',
          marker: 'glb',
        });
        const rpoDir = writeSelfContainedSkill(repoSkillsDir, {
          engine: 'rpoeng',
          magicHex: '52504f31',
          suffix: '.rpo',
          marker: 'rpo',
        });

        const wsGlb = path.join(root, 'ws-glb');
        const wsRpo = path.join(root, 'ws-rpo');
        fs.mkdirSync(wsGlb, { recursive: true });
        fs.mkdirSync(wsRpo, { recursive: true });
        fs.writeFileSync(path.join(wsGlb, 'data.glb'), Buffer.from('GLB1hello', 'latin1'));
        fs.writeFileSync(path.join(wsRpo, 'data.rpo'), Buffer.from('RPO1world', 'latin1'));

        // Positive: untampered global & repo skills bind ready and unpack cleanly
        assert.equal(skillBinding(wsGlb, homeDir, 'glbeng').state, 'ready');
        assert.equal(skillBinding(wsRpo, homeDir, 'rpoeng').state, 'ready');
        await unpackVnArchives(wsGlb);
        await unpackVnArchives(wsRpo);
        assert.ok(fs.readFileSync(path.join(wsGlb, '.papercup', 'tmp', 'unpacked', 'data', 's.txt'), 'utf8').includes('#glb'));
        assert.ok(fs.readFileSync(path.join(wsRpo, '.papercup', 'tmp', 'unpacked', 'data', 's.txt'), 'utf8').includes('#rpo'));

        // Negative A: tamper global unpack.py -> binding mismatch + assertSkillScriptVerified throws + runPythonScript throws + unpackVnArchives rejects
        const glbUnpack = path.join(glbDir, 'unpack.py');
        const origGlbUnpack = fs.readFileSync(glbUnpack, 'utf8');
        fs.writeFileSync(glbUnpack, origGlbUnpack + '# tampered global\n', 'utf8');
        assert.equal(skillBinding(wsGlb, homeDir, 'glbeng').state, 'mismatch');
        assert.throws(() => assertSkillScriptVerified(glbUnpack, { homeDir, repoSkillsDir }), SkillRegistryError);
        await assert.rejects(
          () => runPythonScript(glbUnpack, [path.join(wsGlb, 'data.glb'), path.join(root, 'out-g')], wsGlb),
          ArchiveError
        );
        await assert.rejects(() => unpackVnArchives(wsGlb), /哈希不一致|SHA-256|拒绝/);

        // Negative B: tamper repo unpack.py -> binding mismatch + assertSkillScriptVerified throws + runPythonScript throws + unpackVnArchives rejects
        const rpoUnpack = path.join(rpoDir, 'unpack.py');
        const origRpoUnpack = fs.readFileSync(rpoUnpack, 'utf8');
        fs.writeFileSync(rpoUnpack, origRpoUnpack + '# tampered repo\n', 'utf8');
        assert.equal(skillBinding(wsRpo, homeDir, 'rpoeng').state, 'mismatch');
        assert.throws(() => assertSkillScriptVerified(rpoUnpack, { homeDir, repoSkillsDir }), SkillRegistryError);
        await assert.rejects(
          () => runPythonScript(rpoUnpack, [path.join(wsRpo, 'data.rpo'), path.join(root, 'out-r')], wsRpo),
          ArchiveError
        );
        await assert.rejects(() => unpackVnArchives(wsRpo), /哈希不一致|SHA-256|拒绝/);

        // Negative C: undeclared stray .py inside global skill triggers integrity failure
        fs.writeFileSync(glbUnpack, origGlbUnpack, 'utf8');
        fs.writeFileSync(path.join(glbDir, 'sneaky.py'), 'print("evil")\n', 'utf8');
        assert.equal(skillBinding(wsGlb, homeDir, 'glbeng').state, 'mismatch');
        assert.throws(() => assertSkillScriptVerified(glbUnpack, { homeDir, repoSkillsDir }), SkillRegistryError);
      } finally {
        if (prevRepoEnv === undefined) delete process.env.PAPERCUP_REPO_SKILLS_DIR;
        else process.env.PAPERCUP_REPO_SKILLS_DIR = prevRepoEnv;
      }
    });
  });

  it('11.3 vn_detect dynamically binds repo/global skills to arbitrary workspaces without mutating global/repo skill files', async () => {
    await withTempWorkspace(async ({ root, homeDir }) => {
      // A. Built-in repo engine-nexas-pacf dynamically binds to synthetic PACF archive in a fresh workspace
      const repoNexasEngineJson = path.resolve(process.cwd(), '..', 'skills', 'engine-nexas-pacf', 'engine.json');
      const repoNexasBefore = fs.readFileSync(repoNexasEngineJson, 'utf8');

      const wsPacf = path.join(root, 'fresh-pacf-game');
      fs.mkdirSync(path.join(wsPacf, 'trial'), { recursive: true });
      fs.writeFileSync(path.join(wsPacf, 'trial', 'Script.pac'), Buffer.concat([Buffer.from('PACF', 'ascii'), Buffer.alloc(64, 0)]));

      const pacfSummary = detectVnEngineSummary(wsPacf);
      assert.equal(pacfSummary.engineKnown, true);
      assert.equal(pacfSummary.engineId, 'nexas-pacf');
      assert.equal(pacfSummary.engineName, 'NeXAS PACF');
      assert.ok(pacfSummary.text.includes('trial/Script.pac') && pacfSummary.text.includes('ready') && pacfSummary.text.includes('[repo]'));
      assert.ok(
        pacfSummary.bindings?.some((b) => b.engine === 'nexas-pacf' && b.tier === 'repo' && b.matchedPaths.includes('trial/Script.pac')),
        `Expected dynamic repo binding in vn_detect summary, got: ${JSON.stringify(pacfSummary.bindings)}`
      );
      assert.equal(fs.readFileSync(repoNexasEngineJson, 'utf8'), repoNexasBefore, 'vn_detect must NEVER mutate repo engine.json');

      // B. Global direct skill (with NO direct_root on disk) dynamically binds to two separate workspaces
      const globalSkillsDir = path.join(homeDir, 'skills');
      const directSkillDir = writeSelfContainedSkill(globalSkillsDir, {
        engine: 'dyndir',
        pipeline: 'direct',
        systemTextFiles: ['story.tbl'],
      });
      const globalEngineJsonPath = path.join(directSkillDir, 'engine.json');
      const globalEngineBefore = fs.readFileSync(globalEngineJsonPath, 'utf8');
      assert.equal(globalEngineBefore.includes('direct_root'), false, 'Global direct skill must not persist direct_root');

      const wsA = path.join(root, 'ws-direct-a');
      const wsB = path.join(root, 'ws-direct-b');
      fs.mkdirSync(path.join(wsA, 'game_a'), { recursive: true });
      fs.mkdirSync(wsB, { recursive: true });
      fs.writeFileSync(path.join(wsA, 'game_a', 'story.tbl'), 'おはよう世界\nまた明日ね\n', 'utf8');
      fs.writeFileSync(path.join(wsB, 'story.tbl'), 'こんにちは\n', 'utf8');

      const sumA = detectVnEngineSummary(wsA);
      const sumB = detectVnEngineSummary(wsB);
      assert.equal(sumA.engineId, 'dyndir');
      assert.equal(sumB.engineId, 'dyndir');
      assert.equal(sumA.bindings?.find((b) => b.engine === 'dyndir')?.boundDirectRoot, 'game_a');
      assert.equal(sumB.bindings?.find((b) => b.engine === 'dyndir')?.boundDirectRoot, '.');

      // classifyVnScripts executes dynamically bound global direct skill cleanly in both workspaces
      const clsA = await classifyVnScripts(wsA, {});
      const clsB = await classifyVnScripts(wsB, {});
      assert.ok(clsA.includes('剧情 2 条'), `Expected 2 scenario lines in wsA, got: ${clsA}`);
      assert.ok(clsB.includes('剧情 1 条'), `Expected 1 scenario line in wsB, got: ${clsB}`);

      // Verify bindSkillToWorkspace clones without mutating on-disk global engine.json
      const pkg = findSkillPackageByEngine('dyndir', wsA, { homeDir })!;
      const bound = bindSkillToWorkspace(pkg, wsA);
      assert.equal(bound.boundDirectRoot, 'game_a');
      assert.equal(bound.runtimeEngineJson.direct_root, 'game_a');
      assert.equal(fs.readFileSync(globalEngineJsonPath, 'utf8'), globalEngineBefore, 'Global engine.json must stay immutable');
    });
  });

  it('11.4 promoteSkill / promoteVnSkill auto-sanitizes, exports PR-ready package passing validate-skills.mjs, and rejects credentials & local paths', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      const wsSkillsDir = path.join(ws, '.papercup', 'skills');
      const skillDir = writeSelfContainedSkill(wsSkillsDir, {
        engine: 'saneng',
        magicHex: '53414e31',
        suffix: '.san',
        marker: 'san',
        testFixturePy: 'def test_ok():\n    return True\n',
        extraEngineFields: {
          direct_root: 'local_trial_dir',
          'source-sample': 'C:\\Users\\dev\\Games\\sample.san',
          'source-sha256': '1'.repeat(64),
          workspace: 'E:\\local\\ws',
        },
        extraFrontmatterLines: [
          'source-sample: D:\\Private\\Trial\\sample.san',
          'source-sha256: ' + '2'.repeat(64),
          'direct-root: local_trial_dir',
        ],
      });

      // 1) Promote to global (~/.papercup/skills/) AND separately export PR-ready package to exportDir
      const promoteGlobalMsg = promoteVnSkill(ws, 'engine-saneng', { includeTestFixture: true });
      assert.ok(promoteGlobalMsg.includes('engine-saneng') && promoteGlobalMsg.includes('脱敏'));

      const prExportDir = path.join(root, 'pr-export', 'engine-saneng');
      const exportMsg = promoteVnSkill(ws, 'engine-saneng', {
        exportDir: prExportDir,
        includeTestFixture: true,
      });
      assert.ok(exportMsg.includes('engine-saneng') && exportMsg.includes('脱敏'));

      for (const outDir of [path.join(homeDir, 'skills', 'engine-saneng'), prExportDir]) {
        assert.equal(fs.existsSync(path.join(outDir, 'engine.json')), true);
        assert.equal(fs.existsSync(path.join(outDir, 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(outDir, 'unpack.py')), true);
        assert.equal(fs.existsSync(path.join(outDir, 'repack.py')), true);
        assert.equal(fs.existsSync(path.join(outDir, 'test_fixture.py')), true);

        const engJson = JSON.parse(fs.readFileSync(path.join(outDir, 'engine.json'), 'utf8')) as Record<string, unknown>;
        assert.equal('direct_root' in engJson, false, 'direct_root must be stripped on export');
        assert.equal('source-sample' in engJson, false, 'source-sample must be stripped on export');
        assert.equal('source-sha256' in engJson, false, 'source-sha256 must be stripped on export');
        assert.equal('workspace' in engJson, false, 'workspace must be stripped on export');
        assert.equal(engJson['skill-sha256'], hashSkillTextContent(fs.readFileSync(path.join(outDir, 'SKILL.md'), 'utf8')));
        assert.equal(engJson['unpack-sha256'], hashSkillTextContent(fs.readFileSync(path.join(outDir, 'unpack.py'), 'utf8')));
        assert.equal(engJson['repack-sha256'], hashSkillTextContent(fs.readFileSync(path.join(outDir, 'repack.py'), 'utf8')));

        const exportedMd = fs.readFileSync(path.join(outDir, 'SKILL.md'), 'utf8');
        assert.equal(exportedMd.includes('source-sample:'), false);
        assert.equal(exportedMd.includes('direct-root:'), false);
      }

      // Verify PR-ready exported directory passes real scripts/validate-skills.mjs!
      const validateScript = path.resolve(process.cwd(), '..', 'scripts', 'validate-skills.mjs');
      const valRes = spawnSync(process.execPath, [validateScript, '--skill', prExportDir], {
        cwd: path.resolve(process.cwd(), '..'),
        encoding: 'utf8',
      });
      assert.equal(valRes.status, 0, `Exported PR-ready skill must pass validate-skills.mjs:\nSTDOUT: ${valRes.stdout}\nSTDERR: ${valRes.stderr}`);

      // 2) Negative: credential leak in unpack.py rejected by promoteSkill / exportSanitizedSkillPackage
      const credExportDir = path.join(root, 'should-not-exist-cred');
      const origUnpack = fs.readFileSync(path.join(skillDir, 'unpack.py'), 'utf8');
      fs.writeFileSync(path.join(skillDir, 'unpack.py'), origUnpack + 'API = "AIzaSySecretExportLeakTest1234567890abcdef"\n', 'utf8');
      assert.throws(
        () => promoteSkill(ws, homeDir, 'engine-saneng', { exportDir: credExportDir }),
        /疑似凭据|密钥/
      );
      assert.equal(fs.existsSync(credExportDir), false);

      // 3) Negative: hardcoded machine-local path in SKILL.md body rejected
      fs.writeFileSync(path.join(skillDir, 'unpack.py'), origUnpack, 'utf8');
      const origMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), origMd + '\nFound at C:\\Users\\alice\\Desktop\\MyGame\\data.san\n', 'utf8');
      assert.throws(
        () =>
          exportSanitizedSkillPackage({
            sourceSkillDir: skillDir,
            targetDir: path.join(root, 'should-not-exist-path'),
          }),
        /本机绝对路径/
      );

      // 4) Negative: draft skill rejected
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), origMd + '\nPAPERCUP_DRAFT\n', 'utf8');
      assert.throws(
        () =>
          exportSanitizedSkillPackage({
            sourceSkillDir: skillDir,
            targetDir: path.join(root, 'should-not-exist-draft'),
          }),
        /PAPERCUP_DRAFT/
      );
    });
  });
});

/* ========================= 12. Cloud Concurrency & Post-QA Chunk Defaults ========================= */

describe('12. Cloud concurrency & post-QA chunk default contracts', () => {
  function createFirstWaveConcurrencyProbe(expectedPeak: number) {
    let active = 0;
    let peak = 0;
    let gateOpen = false;
    let settleScheduled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const waiters: Array<() => void> = [];

    const openGate = () => {
      if (gateOpen) return;
      gateOpen = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      for (const release of waiters.splice(0)) release();
    };

    const enter = async () => {
      active++;
      if (active > peak) peak = active;
      if (!gateOpen) {
        if (!fallbackTimer) {
          fallbackTimer = setTimeout(openGate, 250);
        }
        if (active >= expectedPeak && !settleScheduled) {
          settleScheduled = true;
          // Brief settle window so any over-concurrency bug (> expectedPeak) is also observed before release
          settleTimer = setTimeout(openGate, 20);
        }
        await new Promise<void>((resolve) => {
          if (gateOpen) {
            resolve();
            return;
          }
          waiters.push(resolve);
        });
      }
    };

    const leave = () => {
      active--;
    };

    return {
      enter,
      leave,
      getPeak: () => peak,
    };
  }

  function writeScenarioRows(ws: string, count: number): Array<Record<string, unknown>> {
    const buildDir = path.join(ws, '.papercup', 'data', 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= count; i++) {
      rows.push({
        id: `s#${i}`,
        file: 'scene.ks',
        line: i,
        scene: 's1',
        speaker: '',
        kind: 'say',
        source: `おはよう${i}`,
      });
    }
    fs.writeFileSync(
      path.join(buildDir, 'scenario.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(path.join(buildDir, 'ui.jsonl'), '', 'utf8');
    fs.writeFileSync(
      path.join(ws, 'papercup.toml'),
      '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh"\nnarrative_pov = "first"\n',
      'utf8'
    );
    return rows;
  }

  it('12.1 exports single-source cloud concurrency & post-QA chunk constants and enforces 1..32 bounds in savePlanConfig', async () => {
    assert.equal(DEFAULT_CLOUD_CONCURRENCY, 8);
    assert.equal(MAX_CLOUD_CONCURRENCY, 32);
    assert.equal(DEFAULT_POST_QA_CHUNK_LINES, 120);
    assert.equal(defaultPlanConfig().concurrency, 8);

    await withTempWorkspace(({ root, ws }) => {
      const base = defaultPlanConfig();

      // Accepts lower bound 1 and upper bound 32
      const savedMin = savePlanConfig(ws, { ...base, concurrency: 1 }, {});
      assert.equal((savedMin.config as Record<string, unknown>).concurrency, 1);

      const savedMax = savePlanConfig(ws, { ...base, concurrency: 32 }, {});
      assert.equal((savedMax.config as Record<string, unknown>).concurrency, 32);
      const persisted = readPlan(ws);
      assert.equal((persisted?.config as Record<string, unknown> | undefined)?.concurrency, 32);

      // Rejects 0 and 33 with PlanError
      assert.throws(() => savePlanConfig(ws, { ...base, concurrency: 0 }, {}), PlanError);
      assert.throws(() => savePlanConfig(ws, { ...base, concurrency: 33 }, {}), PlanError);

      // planVnTranslation uses cloud default 8, while local_mt stays isolated at its local default (3)
      writeScenarioRows(ws, 4);
      fs.rmSync(path.join(ws, '.papercup', 'data', 'vn', 'plan.json'), { force: true });
      const cloudPlan = planVnTranslation(ws, { model: 'deepseek-chat', generateBatches: true });
      assert.equal(((cloudPlan.plan as Record<string, any>)?.config?.concurrency), 8);

      const localWs = path.join(root, 'local-plan-ws');
      fs.mkdirSync(localWs, { recursive: true });
      writeScenarioRows(localWs, 4);
      const localPlan = planVnTranslation(localWs, {
        generateBatches: true,
        translatorConfig: { mode: 'local_mt', model: 'sakura-local', preset: 'sakura', packetLines: 8, concurrency: 3 },
      });
      assert.equal(((localPlan.plan as Record<string, any>)?.config?.concurrency), 3);
      assert.equal(((localPlan.translator_advice as Record<string, any>)?.recommended_concurrency), 3);
    });
  });

  it('12.2 isolates runTranslateBatches cloud defaults/32-cap from local_mt 1..8 clamp', async () => {
    await withTempWorkspace(async ({ ws }) => {
      // Create 34 single-line scenario batches so both 8-lane default and 32-lane clamp saturate cleanly
      writeScenarioRows(ws, 34);
      generateBatches(
        ws,
        {
          ...defaultPlanConfig(),
          model: 'deepseek-chat',
          batch_max_lines: 1,
          batch_max_source_tokens: 4000,
          session_max_source_tokens: 40000,
        },
        { force: true }
      );

      // Write plan.json whose config deliberately OMITS concurrency
      const planPath = path.join(ws, '.papercup', 'data', 'vn', 'plan.json');
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(
        planPath,
        JSON.stringify(
          {
            schema: 1,
            config: {
              model: 'deepseek-chat',
              model_family: 'deepseek',
              batch_max_lines: 1,
              batch_max_source_tokens: 4000,
              session_max_source_tokens: 40000,
            },
          },
          null,
          2
        ) + '\n',
        'utf8'
      );

      const makeStubCloudSubagentManager = (probe: ReturnType<typeof createFirstWaveConcurrencyProbe>) => {
        let taskSeq = 0;
        return {
          createManagedSubagentSession: async () => ({
            prompt: async (promptText: string) => {
              await probe.enter();
              try {
                const match = /<batch[^>]*>\n([\s\S]*?)\n<\/batch>/.exec(promptText);
                const inputLines = (match?.[1] || '')
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .map((l) => JSON.parse(l) as { id: string; source: string });
                const text = inputLines
                  .map((row) => JSON.stringify({ id: row.id, target: `早上好${row.id}` }))
                  .join('\n');
                return {
                  taskId: `cloud-task-${++taskSeq}`,
                  text,
                  metrics: { usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 } },
                };
              } finally {
                probe.leave();
              }
            },
            dispose: () => {},
          }),
          markTaskProgress: () => {},
        } as unknown as SubagentManager;
      };

      // A) Cloud mode with plan.json omitting concurrency -> defaults to 8 real concurrent lanes
      const cloudDefaultProbe = createFirstWaveConcurrencyProbe(8);
      const cloudDefaultRes = await runTranslateBatches(
        { cwd: ws, subagentManager: makeStubCloudSubagentManager(cloudDefaultProbe) },
        { checkpointInterval: 0, allowUnconfirmedCharacters: true }
      );
      assert.equal(cloudDefaultRes.ok, true);
      assert.equal(cloudDefaultRes.mode, 'cloud_subagent');
      assert.equal(cloudDefaultRes.succeeded, 34);
      assert.equal(cloudDefaultRes.concurrency, 8);
      assert.equal(cloudDefaultProbe.getPeak(), 8, 'Cloud default concurrency must execute 8 parallel lanes');

      // B) Cloud mode with concurrency: 99 -> clamps to 32 real concurrent lanes
      const cloudClampProbe = createFirstWaveConcurrencyProbe(32);
      const cloudClampRes = await runTranslateBatches(
        { cwd: ws, subagentManager: makeStubCloudSubagentManager(cloudClampProbe) },
        { force: true, concurrency: 99, checkpointInterval: 0, allowUnconfirmedCharacters: true }
      );
      assert.equal(cloudClampRes.ok, true);
      assert.equal(cloudClampRes.mode, 'cloud_subagent');
      assert.equal(cloudClampRes.succeeded, 34);
      assert.equal(cloudClampRes.concurrency, 32);
      assert.equal(cloudClampProbe.getPeak(), 32, 'Cloud concurrency: 99 must clamp to 32 parallel lanes');

      // C) local_mt mode with concurrency: 99 -> keeps 1..8 clamp (99 -> 8)
      const makeLocalFetch = (probe: ReturnType<typeof createFirstWaveConcurrencyProbe>): typeof fetch =>
        (async () => {
          await probe.enter();
          try {
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: '早上好' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          } finally {
            probe.leave();
          }
        }) as unknown as typeof fetch;

      const localClampProbe = createFirstWaveConcurrencyProbe(8);
      const localClampRes = await runTranslateBatches(
        {
          cwd: ws,
          subagentManager: makeStubCloudSubagentManager(createFirstWaveConcurrencyProbe(1)),
          translatorConfig: {
            ...DEFAULT_LOCAL_TRANSLATOR_CONFIG,
            mode: 'local_mt',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'sakura-local-test',
            useTmCache: false,
            escalateFailedRows: false,
          },
          localFetch: makeLocalFetch(localClampProbe),
        },
        { mode: 'local_mt', force: true, concurrency: 99, checkpointInterval: 0, allowUnconfirmedCharacters: true }
      );
      assert.equal(localClampRes.ok, true);
      assert.equal(localClampRes.mode, 'local_mt');
      assert.equal(localClampRes.succeeded, 34);
      assert.equal(localClampRes.concurrency, 8);
      assert.equal(localClampProbe.getPeak(), 8, 'local_mt concurrency: 99 must clamp to 8, never 32');

      // D) local_mt mode omitting concurrency stays isolated from plan.json cloud concurrency (even when plan.json has 32)
      savePlanConfig(ws, { ...defaultPlanConfig(), concurrency: 32 }, {});
      const localDefaultProbe = createFirstWaveConcurrencyProbe(3);
      const localDefaultRes = await runTranslateBatches(
        {
          cwd: ws,
          subagentManager: makeStubCloudSubagentManager(createFirstWaveConcurrencyProbe(1)),
          translatorConfig: {
            ...DEFAULT_LOCAL_TRANSLATOR_CONFIG,
            mode: 'local_mt',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'sakura-local-test',
            useTmCache: false,
            escalateFailedRows: false,
          },
          localFetch: makeLocalFetch(localDefaultProbe),
        },
        { mode: 'local_mt', force: true, checkpointInterval: 0, allowUnconfirmedCharacters: true }
      );
      assert.equal(localDefaultRes.ok, true);
      assert.equal(localDefaultRes.mode, 'local_mt');
      assert.equal(localDefaultRes.concurrency, 3);
      assert.equal(localDefaultProbe.getPeak(), 3, 'local_mt omitted concurrency must remain at local default 3');
    });
  });

  it('12.3 runPostQaParallel defaults to 120-line chunks (125 rows -> 2 chunks: 120 + 5) and 8-lane concurrency (99 -> 32)', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const rows = writeScenarioRows(ws, 125);
      const gen = generateBatches(
        ws,
        {
          ...defaultPlanConfig(),
          model: 'deepseek-chat',
          batch_max_lines: 125,
          batch_max_source_tokens: 40000,
          session_max_source_tokens: 80000,
        },
        { force: true }
      );
      const batches = gen.batches as Array<{ batch_id: string }>;
      assert.equal(batches.length, 1);
      checkinBatch(ws, batches[0].batch_id, {
        entries: rows.map((r) => ({ id: String(r.id), target: `早上好${String(r.line)}` })),
      });

      // Write plan.json whose config deliberately OMITS concurrency
      const planPath = path.join(ws, '.papercup', 'data', 'vn', 'plan.json');
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(
        planPath,
        JSON.stringify(
          {
            schema: 1,
            config: {
              model: 'deepseek-chat',
              model_family: 'deepseek',
              batch_max_lines: 125,
              batch_max_source_tokens: 40000,
              session_max_source_tokens: 80000,
            },
          },
          null,
          2
        ) + '\n',
        'utf8'
      );

      const postQaStatePath = path.join(ws, '.papercup', 'data', 'vn', 'post_qa_state.json');

      // A) Default batchMaxLines -> 125 rows split into 2 chunks (120 + 5), proving default 120 rather than old 60
      const observedChunkSizes: number[] = [];
      let qaTaskSeq = 0;
      const chunkSizeSubagent = {
        runSubagentWithMetrics: async (_role: string, task: string) => {
          const headerMatch = /Review track=scenario chunk=(\d+) \((\d+) lines\)/.exec(task);
          assert.ok(headerMatch, `Unexpected role-checker prompt header: ${task.slice(0, 200)}`);
          const chunkIdx = Number(headerMatch![1]);
          const lineCount = Number(headerMatch![2]);
          observedChunkSizes[chunkIdx] = lineCount;
          return {
            taskId: `qa-chunk-${++qaTaskSeq}`,
            text: `consistent (${lineCount} lines)`,
            metrics: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } },
          };
        },
      } as unknown as SubagentManager;

      const defaultChunkRes = await runPostQaParallel({ cwd: ws, subagentManager: chunkSizeSubagent }, {});
      assert.equal(defaultChunkRes.ok, true);
      assert.equal(defaultChunkRes.deterministicPassed, 125);
      assert.equal(defaultChunkRes.deterministicFailed, 0);
      assert.equal(defaultChunkRes.roleCheckerChunksTotal, 2, '125 rows must split into 2 chunks (120 + 5), not 3');
      assert.equal(defaultChunkRes.roleCheckerChunksReviewed, 2);
      assert.deepEqual(observedChunkSizes, [120, 5]);

      // B) Default concurrency when plan.json omits concurrency -> 8 concurrent role-checker workers
      // Use batchMaxLines: 3 -> ceil(125 / 3) = 42 chunks so both 8-lane default and 32-lane clamp saturate
      fs.rmSync(postQaStatePath, { force: true });
      const qaDefaultProbe = createFirstWaveConcurrencyProbe(8);
      const qaDefaultSubagent = {
        runSubagentWithMetrics: async () => {
          await qaDefaultProbe.enter();
          try {
            return {
              taskId: `qa-def-${++qaTaskSeq}`,
              text: 'consistent',
              metrics: { usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } },
            };
          } finally {
            qaDefaultProbe.leave();
          }
        },
      } as unknown as SubagentManager;

      const qaDefaultRes = await runPostQaParallel(
        { cwd: ws, subagentManager: qaDefaultSubagent },
        { batchMaxLines: 3 }
      );
      assert.equal(qaDefaultRes.ok, true);
      assert.equal(qaDefaultRes.roleCheckerChunksTotal, 42);
      assert.equal(qaDefaultRes.roleCheckerChunksReviewed, 42);
      assert.equal(qaDefaultProbe.getPeak(), 8, 'runPostQaParallel must default to 8 concurrent workers when plan.json omits concurrency');

      // C) Explicit concurrency: 99 -> clamps to 32 concurrent role-checker workers
      fs.rmSync(postQaStatePath, { force: true });
      const qaClampProbe = createFirstWaveConcurrencyProbe(32);
      const qaClampSubagent = {
        runSubagentWithMetrics: async () => {
          await qaClampProbe.enter();
          try {
            return {
              taskId: `qa-clamp-${++qaTaskSeq}`,
              text: 'consistent',
              metrics: { usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } },
            };
          } finally {
            qaClampProbe.leave();
          }
        },
      } as unknown as SubagentManager;

      const qaClampRes = await runPostQaParallel(
        { cwd: ws, subagentManager: qaClampSubagent },
        { batchMaxLines: 3, concurrency: 99 }
      );
      assert.equal(qaClampRes.ok, true);
      assert.equal(qaClampRes.roleCheckerChunksTotal, 42);
      assert.equal(qaClampRes.roleCheckerChunksReviewed, 42);
      assert.equal(qaClampProbe.getPeak(), 32, 'runPostQaParallel concurrency: 99 must clamp to 32 workers');
    });
  });

  it('12.4 exposes concurrency.maximum === 32 in createVnTools schemas for vn_plan, vn_translate_batches, and vn_post_qa_parallel', async () => {
    await withTempWorkspace(({ ws }) => {
      const tools = createVnTools(() => ws);
      for (const toolName of ['vn_plan', 'vn_translate_batches', 'vn_post_qa_parallel'] as const) {
        const tool = tools.find((t) => t.name === toolName);
        assert.ok(tool, `Expected tool ${toolName} to exist in createVnTools`);
        const concurrencySchema = (tool!.parameters as Record<string, any>)?.properties?.concurrency;
        assert.ok(concurrencySchema, `Expected ${toolName}.parameters.properties.concurrency schema`);
        assert.equal(concurrencySchema.minimum, 1, `${toolName}.concurrency.minimum must be 1`);
        assert.equal(concurrencySchema.maximum, 32, `${toolName}.concurrency.maximum must be 32`);
        assert.equal(concurrencySchema.maximum, MAX_CLOUD_CONCURRENCY);
      }

      const postQaTool = tools.find((t) => t.name === 'vn_post_qa_parallel')!;
      const batchMaxLinesSchema = (postQaTool.parameters as Record<string, any>)?.properties?.batchMaxLines;
      assert.ok(batchMaxLinesSchema, 'Expected vn_post_qa_parallel.parameters.properties.batchMaxLines schema');
      assert.equal(batchMaxLinesSchema.minimum, 1);
      assert.equal(batchMaxLinesSchema.maximum, 200);
      assert.ok(
        String(batchMaxLinesSchema.description || '').includes('120'),
        `Expected vn_post_qa_parallel.batchMaxLines description to reference default 120, got: ${String(batchMaxLinesSchema.description)}`
      );
    });
  });
});

describe('13. Three-Layer Context Compaction Contracts & Provider contextWindow Discovery', () => {
  it('13.1 reads env compaction config defaults, valid overrides, and invalid-value fallbacks', () => {
    const defaults = readPaperCupCompactionConfig({});
    assert.deepEqual(defaults, {
      enabled: true,
      mainSoftCapTokens: 140_000,
      reverserSoftCapTokens: 120_000,
      keepRecentTokens: 20_000,
      pruneProtectTokens: 24_000,
      pruneMinReclaimTokens: 12_000,
    });
    assert.deepEqual(defaults, DEFAULT_PAPERCUP_COMPACTION_CONFIG);

    // Disabling auto-compaction via false / 0 / off / no
    for (const disabledVal of ['false', 'FALSE', '0', 'off', 'no']) {
      assert.equal(readPaperCupCompactionConfig({ PAPERCUP_COMPACT_ENABLED: disabledVal }).enabled, false);
    }
    assert.equal(readPaperCupCompactionConfig({ PAPERCUP_COMPACT_ENABLED: 'true' }).enabled, true);

    // Valid custom overrides (sets mainSoftCapExplicit / reverserSoftCapExplicit)
    const custom = readPaperCupCompactionConfig({
      PAPERCUP_COMPACT_ENABLED: 'false',
      PAPERCUP_MAIN_COMPACT_TOKENS: '96000',
      PAPERCUP_REVERSER_COMPACT_TOKENS: '80000',
      PAPERCUP_COMPACT_KEEP_RECENT_TOKENS: '12000',
      PAPERCUP_COMPACT_PRUNE_PROTECT_TOKENS: '16000',
      PAPERCUP_COMPACT_PRUNE_MIN_RECLAIM_TOKENS: '8000',
    });
    assert.deepEqual(custom, {
      enabled: false,
      mainSoftCapTokens: 96_000,
      reverserSoftCapTokens: 80_000,
      keepRecentTokens: 12_000,
      pruneProtectTokens: 16_000,
      pruneMinReclaimTokens: 8_000,
      mainSoftCapExplicit: true,
      reverserSoftCapExplicit: true,
    });

    // Explicitly setting the default numeric values MUST still mark them explicit so huge-window scaling does NOT override them
    const explicitDefaults = readPaperCupCompactionConfig({
      PAPERCUP_MAIN_COMPACT_TOKENS: '140000',
      PAPERCUP_REVERSER_COMPACT_TOKENS: '120000',
    });
    assert.equal(explicitDefaults.mainSoftCapTokens, 140_000);
    assert.equal(explicitDefaults.reverserSoftCapTokens, 120_000);
    assert.equal(explicitDefaults.mainSoftCapExplicit, true);
    assert.equal(explicitDefaults.reverserSoftCapExplicit, true);

    // Invalid, negative, decimal, or below-minimum env values fall back cleanly to defaults (and stay non-explicit)
    const invalid = readPaperCupCompactionConfig({
      PAPERCUP_MAIN_COMPACT_TOKENS: 'not-a-number',
      PAPERCUP_REVERSER_COMPACT_TOKENS: '2048', // < 4096 min
      PAPERCUP_COMPACT_KEEP_RECENT_TOKENS: '512', // < 1024 min
      PAPERCUP_COMPACT_PRUNE_PROTECT_TOKENS: '-100',
      PAPERCUP_COMPACT_PRUNE_MIN_RECLAIM_TOKENS: '12.5',
    });
    assert.deepEqual(invalid, DEFAULT_PAPERCUP_COMPACTION_CONFIG);
    assert.equal(invalid.mainSoftCapExplicit, undefined);
    assert.equal(invalid.reverserSoftCapExplicit, undefined);
  });

  it('13.2 computes dynamic compaction thresholds across small, huge (>=500K) and explicitly overridden windows and aligns Pi SDK shouldCompact', () => {
    const cfg = DEFAULT_PAPERCUP_COMPACTION_CONFIG;
    assert.equal(HUGE_WINDOW_THRESHOLD_TOKENS, 500_000);
    assert.equal(DEFAULT_HUGE_MAIN_SOFT_CAP_TOKENS, 200_000);
    assert.equal(DEFAULT_HUGE_REVERSER_SOFT_CAP_TOKENS, 180_000);

    // 32K window: baseReserve = min(24576, 8192) = 8192 -> trigger = min(24576, 26869, softCap) = 24576
    const m32 = computeCompactionThresholds(32_768, 'main', cfg);
    assert.equal(m32.baseReserveTokens, 8_192);
    assert.equal(m32.triggerTokens, 24_576);
    assert.equal(m32.postPruneSkipTokens, Math.floor(24_576 * 0.8));
    assert.equal(m32.effectiveReserveTokens, 8_192);
    assert.equal(m32.keepRecentTokens, 12_288); // capped at 50% of triggerTokens

    // 64K window: baseReserve = 16384 -> trigger = min(49152, 53739, softCap) = 49152
    const m64 = computeCompactionThresholds(65_536, 'main', cfg);
    assert.equal(m64.baseReserveTokens, 16_384);
    assert.equal(m64.triggerTokens, 49_152);
    assert.equal(m64.postPruneSkipTokens, Math.floor(49_152 * 0.8));
    assert.equal(m64.effectiveReserveTokens, 16_384);
    assert.equal(m64.keepRecentTokens, 20_000);

    // 128K window: baseReserve = 24576 -> trigger = min(106496, 107479, 140000) = 106496
    const m128 = computeCompactionThresholds(131_072, 'main', cfg);
    assert.equal(m128.baseReserveTokens, 24_576);
    assert.equal(m128.triggerTokens, 106_496);
    assert.equal(m128.postPruneSkipTokens, Math.floor(106_496 * 0.8));
    assert.equal(m128.effectiveReserveTokens, 24_576);

    // 200K & 499,999 windows (< 500K threshold): standard soft caps (140K main/subagent, 120K reverser)
    const m200 = computeCompactionThresholds(200_000, 'main', cfg);
    assert.equal(m200.triggerTokens, 140_000);
    assert.equal(m200.postPruneSkipTokens, 112_000);
    assert.equal(m200.effectiveReserveTokens, 60_000);

    const r200 = computeCompactionThresholds(200_000, 'reverser', cfg);
    assert.equal(r200.triggerTokens, 120_000);
    assert.equal(r200.postPruneSkipTokens, 96_000);
    assert.equal(r200.effectiveReserveTokens, 80_000);

    const s200 = computeCompactionThresholds(200_000, 'subagent', cfg);
    assert.equal(s200.triggerTokens, 140_000);
    assert.equal(s200.effectiveReserveTokens, 60_000);

    assert.equal(computeCompactionThresholds(499_999, 'main', cfg).triggerTokens, 140_000);
    assert.equal(computeCompactionThresholds(499_999, 'reverser', cfg).triggerTokens, 120_000);

    // >= 500K huge windows (500K & 1M & 1.05M) with default non-explicit config automatically scale soft caps
    // to 200K (main/subagent) and 180K (reverser) while stretching effectiveReserveTokens to match Pi SDK shouldCompact!
    assert.equal(computeCompactionThresholds(500_000, 'main', cfg).triggerTokens, 200_000);
    assert.equal(computeCompactionThresholds(500_000, 'subagent', cfg).triggerTokens, 200_000);
    assert.equal(computeCompactionThresholds(500_000, 'reverser', cfg).triggerTokens, 180_000);

    const m1M = computeCompactionThresholds(1_000_000, 'main', cfg);
    assert.equal(m1M.softCapTokens, 200_000);
    assert.equal(m1M.triggerTokens, 200_000);
    assert.equal(m1M.postPruneSkipTokens, 160_000);
    assert.equal(m1M.effectiveReserveTokens, 800_000);

    const s1M = computeCompactionThresholds(1_000_000, 'subagent', cfg);
    assert.equal(s1M.softCapTokens, 200_000);
    assert.equal(s1M.triggerTokens, 200_000);
    assert.equal(s1M.effectiveReserveTokens, 800_000);

    const r1M = computeCompactionThresholds(1_000_000, 'reverser', cfg);
    assert.equal(r1M.softCapTokens, 180_000);
    assert.equal(r1M.triggerTokens, 180_000);
    assert.equal(r1M.postPruneSkipTokens, 144_000);
    assert.equal(r1M.effectiveReserveTokens, 820_000);

    // Explicit env overrides (even when equal to 140000 / 120000) and custom non-default values MUST NOT scale on 1M window
    const explicitSameAsDefault = readPaperCupCompactionConfig({
      PAPERCUP_MAIN_COMPACT_TOKENS: '140000',
      PAPERCUP_REVERSER_COMPACT_TOKENS: '120000',
    });
    assert.equal(computeCompactionThresholds(1_000_000, 'main', explicitSameAsDefault).triggerTokens, 140_000);
    assert.equal(computeCompactionThresholds(1_000_000, 'subagent', explicitSameAsDefault).triggerTokens, 140_000);
    assert.equal(computeCompactionThresholds(1_000_000, 'reverser', explicitSameAsDefault).triggerTokens, 120_000);

    const customNonDefault = {
      ...DEFAULT_PAPERCUP_COMPACTION_CONFIG,
      mainSoftCapTokens: 160_000,
      reverserSoftCapTokens: 90_000,
    };
    assert.equal(computeCompactionThresholds(1_000_000, 'main', customNonDefault).triggerTokens, 160_000);
    assert.equal(computeCompactionThresholds(1_000_000, 'reverser', customNonDefault).triggerTokens, 90_000);

    // Verify applyCompactionSettingsForModel aligns Pi SDK's shouldCompact() with triggerTokens
    // AND survives subsequent SettingsManager.save() mutations (setSteeringMode/setShellPath/setDefaultThinkingLevel)
    const sm = SettingsManager.inMemory();
    const model1M = { provider: 'google', id: 'gemini-3-pro', contextWindow: 1_000_000 } as any;
    const applied = applyCompactionSettingsForModel(sm, model1M, 'reverser', cfg);
    assert.equal(applied.triggerTokens, 180_000);
    sm.setSteeringMode('all');
    sm.setFollowUpMode('one-at-a-time');
    sm.setDefaultThinkingLevel('high');
    const piSettings = sm.getCompactionSettings(model1M);
    assert.equal(piSettings.enabled, true);
    assert.equal(piSettings.reserveTokens, 820_000);
    assert.equal(piSettings.keepRecentTokens, 20_000);
    assert.equal(shouldCompact(180_000, 1_000_000, piSettings), false);
    assert.equal(shouldCompact(180_001, 1_000_000, piSettings), true);

    // Explicit env override also propagates faithfully through applyCompactionSettingsForModel
    const smExplicit = SettingsManager.inMemory();
    const appliedExplicit = applyCompactionSettingsForModel(smExplicit, model1M, 'reverser', explicitSameAsDefault);
    assert.equal(appliedExplicit.triggerTokens, 120_000);
    const piExplicitSettings = smExplicit.getCompactionSettings(model1M);
    assert.equal(piExplicitSettings.reserveTokens, 880_000);
    assert.equal(shouldCompact(120_000, 1_000_000, piExplicitSettings), false);
    assert.equal(shouldCompact(120_001, 1_000_000, piExplicitSettings), true);
  });

  it('13.3 enforces planToolResultPruneEdits Prompt Cache protection, batch threshold, pairing preservation & dedup', () => {
    const makeAssistantCall = (id: string, parentId: string | null, callId: string, toolName: string, args: Record<string, unknown>): SessionEntry =>
      ({
        type: 'message',
        id,
        parentId,
        timestamp: '2026-11-23T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: callId, name: toolName, arguments: args }],
        },
      }) as unknown as SessionEntry;

    const makeToolResult = (
      id: string,
      parentId: string,
      callId: string,
      toolName: string,
      text: string,
      details?: Record<string, unknown>
    ): SessionEntry =>
      ({
        type: 'message',
        id,
        parentId,
        timestamp: '2026-11-23T00:00:01.000Z',
        message: {
          role: 'toolResult',
          toolCallId: callId,
          toolName,
          content: [{ type: 'text', text }],
          isError: false,
          ...(details ? { details } : {}),
        },
      }) as unknown as SessionEntry;

    // Helper: ~1 token per 4 chars in Pi SDK estimateTokens
    const repeatBlock = (tag: string, chars: number) => `${tag}:HEAD\n${'x'.repeat(Math.max(0, chars - 32))}\n${tag}:TAIL`;

    // Case A: Below minReclaimTokens (12K) -> returns ZERO edits (Prompt Cache protection!)
    const smallBranch: SessionEntry[] = [
      makeAssistantCall('a1', null, 'tc1', 'bash', { command: 'hexdump old.bin' }),
      makeToolResult('tr1', 'a1', 'tc1', 'bash', repeatBlock('OLD1', 20_000)), // ~5K tokens (< 12K)
      makeAssistantCall('a2', 'tr1', 'tc2', 'read', { path: 'recent.ks' }),
      makeToolResult('tr2', 'a2', 'tc2', 'read', repeatBlock('RECENT_PROTECTED', 100_000)), // >= 24K protected tail
      makeAssistantCall('a3', 'tr2', 'tc3', 'bash', { command: 'ls' }),
      makeToolResult('tr3', 'a3', 'tc3', 'bash', repeatBlock('LATEST_TURN', 10_000)), // newest turn always protected
    ];
    const smallPlan = planToolResultPruneEdits(smallBranch, {
      pruneProtectTokens: 24_000,
      pruneMinReclaimTokens: 12_000,
    });
    assert.equal(smallPlan.edits.length, 0, 'Must emit 0 edits when candidate reclaimable < 12K tokens to protect Prompt Cache');
    assert.equal(smallPlan.prunedCount, 0);
    assert.equal(smallPlan.reclaimedTokens, 0);
    assert.equal(smallPlan.eligibleCount, 1);
    assert.ok(smallPlan.candidateReclaimedTokens > 0 && smallPlan.candidateReclaimedTokens < 12_000);

    // Case B: Reclaimable >= 12K -> returns batch context_edit replacements, skips pre-compaction & already-edited, protects recent 24K & latest turn, redacts secrets, preserves savedOutputPath & toolCall/toolResult pairing
    const secretVal = 'sk-proj-supersecret1234567890abcd';
    const largeBranch: SessionEntry[] = [
      // Pre-compaction entry MUST NOT be touched
      makeAssistantCall('pre-a', null, 'tc-pre', 'bash', { command: 'old-before-compact' }),
      makeToolResult('pre-tr', 'pre-a', 'tc-pre', 'bash', repeatBlock('PRE_COMPACT', 80_000)),
      {
        type: 'compaction',
        id: 'cmp-boundary',
        parentId: 'pre-tr',
        timestamp: '2026-11-23T00:00:02.000Z',
        summary: 'prior summary',
        firstKeptEntryId: 'pre-tr',
        tokensBefore: 50_000,
      } as unknown as SessionEntry,
      // Post-compaction already-edited entry MUST be skipped
      makeAssistantCall('a-edited', 'cmp-boundary', 'tc-ed', 'bash', { command: 'already-pruned' }),
      makeToolResult('tr-edited', 'a-edited', 'tc-ed', 'bash', repeatBlock('EDITED', 60_000)),
      {
        type: 'context_edit',
        id: 'ce-existing',
        parentId: 'tr-edited',
        timestamp: '2026-11-23T00:00:03.000Z',
        targetId: 'tr-edited',
        replacement: { content: [{ type: 'text', text: '[already edited]' }] },
      } as unknown as SessionEntry,
      // Two older oversized tool results (>= 12K reclaimable combined)
      makeAssistantCall('a-old1', 'ce-existing', 'tc-old1', 'bash', { command: `curl -H ${secretVal}` }),
      makeToolResult(
        'tr-old1',
        'a-old1',
        'tc-old1',
        'bash',
        `${secretVal}\n${repeatBlock('OLD1', 40_000)}`,
        { savedOutputPath: '.papercup/tmp/diagnostics/tool-outputs/tc-old1.txt' }
      ),
      makeAssistantCall('a-old2', 'tr-old1', 'tc-old2', 'read', { path: 'script/scene01.ks' }),
      makeToolResult('tr-old2', 'a-old2', 'tc-old2', 'read', repeatBlock('OLD2', 40_000)),
      // Protected recent 24K window
      makeAssistantCall('a-prot', 'tr-old2', 'tc-prot', 'read', { path: 'script/scene02.ks' }),
      makeToolResult('tr-prot', 'a-prot', 'tc-prot', 'read', repeatBlock('PROTECTED_24K', 100_000)),
      // Latest turn (always protected even if pruneProtectTokens were 0)
      makeAssistantCall('a-latest', 'tr-prot', 'tc-latest', 'bash', { command: 'python probe.py' }),
      makeToolResult('tr-latest', 'a-latest', 'tc-latest', 'bash', repeatBlock('LATEST_TURN', 30_000)),
    ];

    const largePlan = planToolResultPruneEdits(largeBranch, {
      pruneProtectTokens: 24_000,
      pruneMinReclaimTokens: 12_000,
      getKnownSecrets: () => [secretVal],
    });
    assert.equal(largePlan.prunedCount, 2);
    assert.equal(largePlan.edits.length, 2);
    assert.ok(largePlan.reclaimedTokens >= 12_000);
    // Chronological order: tr-old1 then tr-old2; NEVER pre-tr, tr-edited, tr-prot, or tr-latest
    assert.deepEqual(
      largePlan.edits.map((e) => e.targetId),
      ['tr-old1', 'tr-old2']
    );

    const edit1 = largePlan.edits[0];
    assert.equal(edit1.type, 'context_edit');
    assert.ok(edit1.replacement && edit1.replacement !== null, 'L1 prune must replace content in-place, never delete toolResult');
    const edit1Text = String((edit1.replacement as any).content?.[0]?.text || '');
    assert.ok(edit1Text.includes('bash'), 'Replacement must retain toolName');
    assert.ok(
      edit1Text.includes('.papercup/tmp/diagnostics/tool-outputs/tc-old1.txt'),
      'Replacement must preserve savedOutputPath hint'
    );
    assert.equal(edit1Text.includes(secretVal), false, 'Replacement must redact known secrets');

    // Even with pruneProtectTokens=0 & pruneMinReclaimTokens=0, the latest turn MUST still be protected
    const zeroProtectPlan = planToolResultPruneEdits(largeBranch, {
      pruneProtectTokens: 0,
      pruneMinReclaimTokens: 0,
    });
    assert.equal(
      zeroProtectPlan.edits.some((e) => e.targetId === 'tr-latest'),
      false,
      'Most recent assistant/toolResult turn must ALWAYS be protected'
    );
    assert.equal(
      zeroProtectPlan.edits.some((e) => e.targetId === 'tr-prot'),
      true,
      'Older turn outside latest turn becomes prunable when pruneProtectTokens=0'
    );
  });

  it('13.4 validates parseSlashCompactCommand boundaries and isPaperCupContextOverflow positive vs non-overflow errors', () => {
    assert.deepEqual(parseSlashCompactCommand('/compact'), { isCompact: true });
    assert.deepEqual(parseSlashCompactCommand('  /COMPACT   focus on glossary  '), {
      isCompact: true,
      focus: 'focus on glossary',
    });
    for (const invalid of ['', '   ', '/compaction', '/compactify', '/compact_all', 'text /compact', 'hello']) {
      assert.equal(parseSlashCompactCommand(invalid), null, `Must reject: ${JSON.stringify(invalid)}`);
    }

    // Positive Chinese & custom-gateway context overflow errors
    for (const overflowMsg of [
      '请求失败：上下文长度超出模型最大限制',
      '超出最大上下文窗口，请精简历史消息',
      '输入 token 数量超过上限 (131072)',
      'token超限：请减少输入长度',
      'API error 400: prompt is too long for this model',
      'context_length_exceeded: maximum context length is 128000 tokens',
      'This request exceeds the context window of 65536 tokens',
      'Request entity too large: max_prompt_tokens exceeded',
      'Error 400: too many tokens in input',
      'Prompt too long: 402 tokens over limit',
    ]) {
      assert.equal(
        isPaperCupContextOverflow(overflowMsg),
        true,
        `Expected context overflow=true for: ${overflowMsg}`
      );
    }

    // Negative: rate-limit / quota / billing / auth / HTTP 401/402/403/429 MUST return false
    for (const nonOverflowMsg of [
      null,
      undefined,
      '',
      'HTTP 429: Too Many Requests',
      'HTTP 429: rate limit exceeded (TPM limit)',
      'HTTP 429: too many tokens',
      'HTTP 401 Unauthorized: invalid_api_key',
      'HTTP 402 Payment Required: credit balance too low',
      '402: token超限',
      '403 Forbidden: permission_denied',
      'insufficient_quota: You exceeded your current quota',
      '配额不足，请充值后重试',
      '余额不足，无法调用模型',
      '请求限流，频率超限',
      '鉴权失败：密钥无效',
    ]) {
      assert.equal(
        isPaperCupContextOverflow(nonOverflowMsg),
        false,
        `Expected context overflow=false for: ${String(nonOverflowMsg)}`
      );
    }
  });

  it('13.5 verifies role-specific compaction instructions, deterministic workspace anchor redaction & diagnostic-only checkpoint archiving', async () => {
    const mainInst = buildDomainCompactionInstructions('main', 'preserve glossary');
    const revInst = buildDomainCompactionInstructions('reverser', 'focus on XOR key');
    const subInst = buildDomainCompactionInstructions('subagent');

    assert.ok(mainInst.includes('Locked Character Roster') && mainInst.includes('preserve glossary'));
    assert.ok(revInst.includes('DISPROVEN HYPOTHESES / DEAD ENDS') && revInst.includes('focus on XOR key'));
    assert.ok(subInst.includes('Verified Findings') && !subInst.includes('DISPROVEN HYPOTHESES'));

    await withTempWorkspace(async ({ ws }) => {
      const secretToken = 'sk-live-secret-anchor-99998888';
      const wsPaths = resolveWorkspacePaths(ws);
      assert.equal(WORKSPACE_COMPACTIONS_REL, '.papercup/tmp/diagnostics/compactions');
      assert.equal(
        wsPaths.compactionsDir,
        path.join(wsPaths.diagnosticsDir, 'compactions')
      );

      // Populate research and skill files (including a secret inside a filename or status string)
      fs.mkdirSync(path.join(wsPaths.researchDir, 'engine-demo'), { recursive: true });
      fs.writeFileSync(path.join(wsPaths.researchDir, 'engine-demo', '01-layout.md'), 'header layout\n', 'utf8');
      fs.mkdirSync(path.join(wsPaths.skillsDir, `engine-${secretToken}`), { recursive: true });
      fs.writeFileSync(path.join(wsPaths.skillsDir, `engine-${secretToken}`, 'SKILL.md'), '# demo skill\n', 'utf8');

      const revAnchor = buildDeterministicWorkspaceAnchor(ws, 'reverser', {
        getKnownSecrets: () => [secretToken],
      });
      assert.ok(revAnchor.startsWith('## Workspace State Snapshot (Authoritative Disk Truth)'));
      assert.ok(revAnchor.includes('.papercup/research/engine-demo/01-layout.md'));
      assert.equal(revAnchor.includes(secretToken), false, 'Workspace anchor must redact known secrets');

      const mainAnchor = buildDeterministicWorkspaceAnchor(ws, 'main', {
        getKnownSecrets: () => [secretToken],
      });
      assert.ok(mainAnchor.startsWith('## Workspace State Snapshot (Authoritative Disk Truth)'));
      assert.equal(mainAnchor.includes(secretToken), false, 'Main workspace anchor must redact known secrets');

      // Snapshot research dir contents before archiving checkpoint
      const researchBefore = fs.readdirSync(wsPaths.researchDir).sort();

      const checkpointRel = archiveCompactionCheckpoint(
        ws,
        'reverser',
        {
          id: 'ckpt12345678',
          timestamp: '2026-11-23T12:34:56.000Z',
          reason: 'manual',
          tokensBefore: 125_000,
          tokensAfter: 18_500,
          summary: `Verified layout. Never leak ${secretToken}.`,
          focus: `check ${secretToken}`,
          prunedCount: 3,
        },
        { getKnownSecrets: () => [secretToken] }
      );

      assert.ok(checkpointRel, 'archiveCompactionCheckpoint must return relative POSIX path');
      assert.ok(
        checkpointRel!.startsWith(`${WORKSPACE_COMPACTIONS_REL}/`) && checkpointRel!.endsWith('.md'),
        `Checkpoint must be stored under ${WORKSPACE_COMPACTIONS_REL}/, got: ${checkpointRel}`
      );
      const checkpointAbs = path.join(ws, checkpointRel!);
      assert.ok(fs.existsSync(checkpointAbs), 'Checkpoint markdown file must exist on disk');
      const archivedBody = fs.readFileSync(checkpointAbs, 'utf8');
      assert.ok(archivedBody.includes('125000 -> 18500'));
      assert.ok(archivedBody.includes('L1 Pruned Tool Results**: 3'));
      assert.equal(archivedBody.includes(secretToken), false, 'Archived checkpoint must redact known secrets');

      // .papercup/research/ MUST remain completely untouched
      assert.deepEqual(fs.readdirSync(wsPaths.researchDir).sort(), researchBefore);
    });
  });

  it('13.6 parses contextWindow metadata from /models payloads across provider schemas and rejects invalid/<2048 values', async () => {
    const mockOpenAiFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'deepseek-chat', context_length: 131072 },
            { id: 'qwen3-235b', context_window: 262144 },
            { id: 'llama-3.3-70b', max_model_len: '65536' },
            { id: 'or-routed-model', top_provider: { context_length: 200000 } },
            { id: 'small-invalid-1', context_length: 1024 },
            { id: 'small-invalid-2', context_window: 2047 },
            { id: 'float-invalid', max_model_len: 32768.5 },
            { id: 'str-invalid', context_length: 'unlimited' },
            { id: 'zero-invalid', context_length: 0 },
            { id: 'neg-invalid', context_length: -8192 },
            { id: 'no-meta-model' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch;

    const res = await discoverProviderAndModels({
      requestedProvider: 'magpie',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:3425/v1',
      fetchImpl: mockOpenAiFetch,
      offline: false,
    });
    assert.ok(Array.isArray(res.liveModels));
    const byId = new Map(res.liveModels!.map((m) => [m.id, m]));
    assert.equal(byId.get('deepseek-chat')?.contextWindow, 131_072);
    assert.equal(byId.get('qwen3-235b')?.contextWindow, 262_144);
    assert.equal(byId.get('llama-3.3-70b')?.contextWindow, 65_536);
    assert.equal(byId.get('or-routed-model')?.contextWindow, 200_000);
    for (const invalidId of [
      'small-invalid-1',
      'small-invalid-2',
      'float-invalid',
      'str-invalid',
      'zero-invalid',
      'neg-invalid',
      'no-meta-model',
    ]) {
      assert.equal(
        byId.get(invalidId)?.contextWindow,
        undefined,
        `Expected undefined contextWindow for ${invalidId}, got ${String(byId.get(invalidId)?.contextWindow)}`
      );
    }

    // Google catalog format (`inputTokenLimit`)
    const mockGoogleFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              supportedGenerationMethods: ['generateContent'],
              inputTokenLimit: 1048576,
            },
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              supportedGenerationMethods: ['generateContent'],
              inputTokenLimit: 1000, // < 2048 rejected
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch;

    const gRes = await discoverProviderAndModels({
      requestedProvider: 'google',
      apiKey: 'AIzaSyTestKey12345678901234567890',
      fetchImpl: mockGoogleFetch,
      offline: false,
    });
    const gById = new Map((gRes.liveModels ?? []).map((m) => [m.id, m]));
    assert.equal(gById.get('gemini-2.5-pro')?.contextWindow, 1_048_576);
    assert.equal(gById.get('gemini-2.5-flash')?.contextWindow, undefined);
  });

  it('13.7 excludes historical thinking blocks in estimatePromptMessageTokens & keeps estimateRealProjectedContextTokens accurate after L1 context_edit', () => {
    // 1. Unit-level checks on estimatePromptMessageTokens across every message role
    const hugeThinking = 'T'.repeat(16_384);
    const thinkingOnlyAssistant = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: hugeThinking }],
    } as unknown as AgentMessage;
    assert.equal(
      estimatePromptMessageTokens(thinkingOnlyAssistant),
      0,
      'Assistant message with only thinking blocks must contribute 0 prompt tokens'
    );

    const textAndToolCall = [
      { type: 'text', text: 'Checking header bytes.' },
      { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'hexdump -C data.pak' } },
    ];
    const withoutThinking = estimatePromptMessageTokens({
      role: 'assistant',
      content: textAndToolCall,
    } as unknown as AgentMessage);
    const withHugeThinking = estimatePromptMessageTokens({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: hugeThinking }, ...textAndToolCall],
    } as unknown as AgentMessage);
    assert.ok(withoutThinking > 0, 'text + toolCall must contribute positive prompt tokens');
    assert.equal(
      withHugeThinking,
      withoutThinking,
      'Adding a 16,384-char thinking block must NOT inflate estimatePromptMessageTokens'
    );

    assert.equal(
      estimatePromptMessageTokens({ role: 'user', content: 'A'.repeat(400) } as unknown as AgentMessage),
      100
    );
    assert.equal(
      estimatePromptMessageTokens({
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'B'.repeat(800) }],
        isError: false,
      } as unknown as AgentMessage),
      200
    );
    assert.ok(
      estimatePromptMessageTokens({
        role: 'system',
        content: 'S'.repeat(400),
        sections: { extra: 'E'.repeat(200) },
        toolsAdded: [{ name: 'bash' }],
      } as unknown as AgentMessage) >= 150
    );
    assert.equal(
      estimatePromptMessageTokens({
        role: 'compactionSummary',
        summary: 'C'.repeat(400),
      } as unknown as AgentMessage),
      100
    );

    // 2. Real SessionManager projection with 40 deep-thinking turns (40 * 16,384 chars = 163,840 phantom tokens)
    //    + oversized older toolResults, followed by L1 context_edit pruning.
    const sm = SessionManager.inMemory();
    sm.appendMessage({
      role: 'user',
      content: 'Analyze the archive container layout.',
      timestamp: Date.now(),
    });

    const mkUsage = (input: number, output = 400) => ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    // 40 deep-thinking tool turns; turns 0..3 have oversized 48,000-char (~12K token) toolResults,
    // turns 4..39 have small outputs, and turn 39 carries the latest provider usage = 125,000 tokens.
    for (let i = 0; i < 40; i++) {
      const callId = `tc-deep-${i}`;
      const isLast = i === 39;
      sm.appendMessage({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `step-${i}:` + 'R'.repeat(16_384) },
          { type: 'toolCall', id: callId, name: 'bash', arguments: { command: `probe_step_${i}.py` } },
        ],
        api: 'openai-completions',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        usage: mkUsage(isLast ? 124_600 : 10_000 + i * 2_000, 400),
        stopReason: 'toolUse',
        timestamp: Date.now() + i * 2,
      });
      const resultLen = i < 4 ? 48_000 : i >= 35 ? 20_000 : 800;
      sm.appendMessage({
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'bash',
        content: [{ type: 'text', text: `STEP_${i}_HEAD\n` + 'x'.repeat(resultLen) + `\nSTEP_${i}_TAIL` }],
        isError: false,
        timestamp: Date.now() + i * 2 + 1,
      });
    }

    const branchBeforeEdit = sm.getBranch();
    assert.equal(hasPostUsageContextEdit(branchBeforeEdit), false);
    const estBeforeEdit = estimateRealProjectedContextTokens(sm.buildSessionProjection(), branchBeforeEdit);
    // Latest usage is 124,600 + 400 = 125,000 plus the trailing toolResult (~5,000 tokens) -> ~130,000
    assert.ok(
      estBeforeEdit >= 125_000 && estBeforeEdit <= 135_000,
      `Expected pre-edit real estimate ~130K (usage + trailing toolResult), got ${estBeforeEdit}`
    );

    // Run L1 pruning and apply context_edit entries directly to the real SessionManager
    const prunePlan = planToolResultPruneEdits(branchBeforeEdit, {
      pruneProtectTokens: 24_000,
      pruneMinReclaimTokens: 12_000,
    });
    assert.ok(prunePlan.edits.length >= 4 && prunePlan.reclaimedTokens >= 45_000, `Expected >=4 pruned edits (~48K reclaimed), got ${JSON.stringify({ count: prunePlan.edits.length, reclaimed: prunePlan.reclaimedTokens })}`);
    for (const edit of prunePlan.edits) {
      sm.appendContextEdit(edit.targetId, edit.replacement);
    }

    const branchAfterEdit = sm.getBranch();
    const projAfterEdit = sm.buildSessionProjection();
    assert.equal(hasPostUsageContextEdit(branchAfterEdit), true);

    // Prove Pi SDK's raw fallback (`estimateTokens` over projection.messages when `context_edit` invalidates `lastUsage`)
    // blows up >180K due to 40 * 16,384 phantom thinking chars!
    const piRawAfterEdit = projAfterEdit.messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    assert.ok(
      piRawAfterEdit > 180_000,
      `Expected Pi SDK raw estimateTokens() fallback to blow up >180K from phantom thinking blocks, got ${piRawAfterEdit}`
    );

    // Prove our estimateRealProjectedContextTokens() stays accurate (125K - ~48K + ~5K trailing ≈ 82K < 96K postPruneSkipTokens!)
    const realAfterEdit = estimateRealProjectedContextTokens(projAfterEdit, branchAfterEdit);
    assert.ok(
      realAfterEdit < 96_000 && realAfterEdit > 60_000,
      `Expected accurate post-L1 real estimate between 60K and 96K (no phantom thinking inflation), got ${realAfterEdit}`
    );

    // 3. No-usage fallback (when no valid assistant usage exists) MUST also exclude thinking blocks
    const noUsageSm = SessionManager.inMemory();
    noUsageSm.appendMessage({ role: 'user', content: 'Hello', timestamp: Date.now() });
    noUsageSm.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Z'.repeat(80_000) },
        { type: 'text', text: 'Short reply.' },
      ],
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      usage: mkUsage(0, 0),
      stopReason: 'stop',
      timestamp: Date.now() + 1,
    });
    const noUsageEst = estimateRealProjectedContextTokens(noUsageSm.buildSessionProjection(), noUsageSm.getBranch());
    assert.ok(noUsageEst < 100, `No-usage fallback must exclude 80K thinking chars, got ${noUsageEst}`);
  });

  it('13.8 live createPaperCupCompactionExtension cancels false threshold L2 compaction after L1 prune on deep-thinking session while NEVER cancelling manual or overflow', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const sm = SessionManager.inMemory();
      const model200k = {
        provider: 'deepseek',
        id: 'deepseek-reasoner',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 16_384,
      } as any;

      sm.appendMessage({
        role: 'user',
        content: 'Inspect game.pak header and decode TOC.',
        timestamp: Date.now(),
      });

      const mkUsage = (input: number, output = 400) => ({
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });

      // Seed 40 deep-thinking turns (each with 16,384-char thinking block) + 4 oversized older toolResults (~48K reclaimable)
      // Reverser on 200K window: triggerTokens = 120,000, postPruneSkipTokens = 96,000.
      // Latest assistant usage is 124,600 + 400 = 125,000 (>= 120K trigger); after L1 reclaims ~48K, real context drops to ~82K (<= 96K).
      for (let i = 0; i < 40; i++) {
        const callId = `tc-live-${i}`;
        const isLast = i === 39;
        sm.appendMessage({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: `reason-${i}:` + 'Q'.repeat(16_384) },
            { type: 'toolCall', id: callId, name: 'bash', arguments: { command: `inspect_${i}.py` } },
          ],
          api: 'openai-completions',
          provider: 'deepseek',
          model: 'deepseek-reasoner',
          usage: mkUsage(isLast ? 124_600 : 10_000 + i * 2_000, 400),
          stopReason: 'toolUse',
          timestamp: Date.now() + i * 2,
        });
        const resultLen = i < 4 ? 48_000 : i >= 35 ? 20_000 : 600;
        sm.appendMessage({
          role: 'toolResult',
          toolCallId: callId,
          toolName: 'bash',
          content: [{ type: 'text', text: `LIVE_${i}_HEAD\n` + 'y'.repeat(resultLen) + `\nLIVE_${i}_TAIL` }],
          isError: false,
          timestamp: Date.now() + i * 2 + 1,
        });
      }

      const fauxSummary = createFauxCore({
        provider: 'deepseek',
        models: [{ id: 'deepseek-reasoner', reasoning: false, contextWindow: 200_000 }],
      });
      fauxSummary.setResponses([
        () => fauxAssistantMessage('## Manual Compaction Summary\n- Verified header offset 0x20'),
        () => fauxAssistantMessage('## Overflow Compaction Summary\n- Recovered from overflow cleanly'),
        () => fauxAssistantMessage('## Genuine Threshold Compaction Summary\n- Real context exceeded trigger'),
      ]);

      let streamFnCalls = 0;
      const countingStreamFn: StreamFn = (reqModel, reqContext, reqOptions) => {
        streamFnCalls += 1;
        return fauxSummary.streamSimple(fauxSummary.getModel(), reqContext, reqOptions);
      };

      const prunedEvents: Array<{ prunedCount: number; reclaimedTokens: number; skippedL2: boolean; tokensAfter: number }> = [];
      const ext = createPaperCupCompactionExtension({
        role: 'reverser',
        cwd: ws,
        config: DEFAULT_PAPERCUP_COMPACTION_CONFIG,
        getModel: () => model200k,
        getStreamFn: () => countingStreamFn,
        onPruned: (ev) => prunedEvents.push(ev),
      });

      const handlers = new Map<string, (...args: any[]) => any>();
      const fakePi = {
        on: (eventName: string, handler: (...args: any[]) => any) => {
          handlers.set(eventName, handler);
        },
        getSettings: () => ({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } }),
      } as any;
      ext.factory(fakePi);

      const turnEndHandler = handlers.get('turn_end');
      const beforeCompactHandler = handlers.get('session_before_compact');
      assert.ok(turnEndHandler && beforeCompactHandler, 'Extension must register turn_end and session_before_compact hooks');

      const makeCtx = () => ({
        cwd: ws,
        model: model200k,
        thinkingLevel: 'off',
        sessionManager: sm,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
          streamSimple: countingStreamFn,
        },
        getContextUsage: () => {
          const proj = sm.buildSessionProjection();
          const br = sm.getBranch();
          // Mirror Pi SDK's exact behavior: before context_edit, uses latest provider usage;
          // after any post-usage context_edit, invalidates usage and sums estimateTokens (including thinking)!
          const tokens = hasPostUsageContextEdit(br)
            ? proj.messages.reduce((sum, m) => sum + estimateTokens(m), 0)
            : estimateRealProjectedContextTokens(proj, br);
          return {
            tokens,
            contextWindow: model200k.contextWindow,
            percent: (tokens / model200k.contextWindow) * 100,
          };
        },
      });

      const buildPreparation = (tokensBefore: number) => {
        const proj = sm.buildSessionProjection();
        const splitIdx = Math.max(1, proj.entries.length - 4);
        const firstKeptEntryId = proj.entries[splitIdx].sourceEntry.id;
        const messagesToSummarize = proj.entries.slice(0, splitIdx).flatMap((pe) => pe.messages);
        return {
          firstKeptEntryId,
          messagesToSummarize,
          turnPrefixMessages: [] as AgentMessage[],
          isSplitTurn: false,
          tokensBefore,
          fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
          settings: { enabled: true, reserveTokens: 80_000, keepRecentTokens: 10_000 },
        };
      };

      // Step 1: turn_end triggers L1 deterministic pruning because real usage (~130K) >= reverser triggerTokens (120K)
      const turnEndResult = turnEndHandler!(
        {
          outcome: 'completed',
          entries: [],
          context: { contextMessages: sm.buildSessionProjection().messages },
        },
        makeCtx()
      );
      assert.ok(turnEndResult && Array.isArray(turnEndResult.entries) && turnEndResult.entries.length >= 4);
      assert.equal(prunedEvents.length, 1);
      assert.equal(prunedEvents[0].skippedL2, true, `Expected L1 to satisfy postPruneSkipTokens (96K), got ${JSON.stringify(prunedEvents[0])}`);
      assert.ok(prunedEvents[0].tokensAfter <= 96_000);

      // Commit L1 context_edit drafts onto SessionManager (as Pi SDK does after turn_end)
      for (const draft of turnEndResult.entries) {
        if (draft.type === 'context_edit') {
          sm.appendContextEdit(draft.targetId, draft.replacement);
        }
      }

      // Confirm Pi SDK's raw fallback now falsely blows up > 180K (exceeding triggerTokens=120K!)
      const rawPiAfterL1 = sm.buildSessionProjection().messages.reduce((sum, m) => sum + estimateTokens(m), 0);
      assert.ok(rawPiAfterL1 > 180_000, `Expected Pi SDK phantom thinking blow-up > 180K, got ${rawPiAfterL1}`);

      const prep = buildPreparation(rawPiAfterL1);

      // Step 2: session_before_compact(reason='threshold') MUST cancel false L2 LLM compaction with 0 LLM calls!
      const thresholdRes = await beforeCompactHandler!(
        {
          reason: 'threshold',
          preparation: prep,
          branchEntries: sm.getBranch(),
          signal: new AbortController().signal,
        },
        makeCtx()
      );
      assert.deepEqual(
        thresholdRes,
        { cancel: true },
        `False threshold L2 compaction after L1 prune must return { cancel: true }, got: ${JSON.stringify(thresholdRes)}`
      );
      assert.equal(streamFnCalls, 0, 'Cancelled threshold compaction must make ZERO LLM calls');

      // Step 3: session_before_compact(reason='manual') on the EXACT SAME session MUST NOT be cancelled!
      const manualRes = await beforeCompactHandler!(
        {
          reason: 'manual',
          preparation: prep,
          branchEntries: sm.getBranch(),
          customInstructions: 'preserve header offsets',
          signal: new AbortController().signal,
        },
        makeCtx()
      );
      assert.ok(manualRes && !manualRes.cancel && manualRes.compaction, `Manual compaction must NEVER be cancelled, got: ${JSON.stringify(manualRes)}`);
      assert.ok(manualRes.compaction.summary.includes('Manual Compaction Summary'));
      assert.equal(streamFnCalls, 1, 'Manual compaction must invoke LLM summarizer once');

      // Step 4: session_before_compact(reason='overflow') on the EXACT SAME session MUST NOT be cancelled!
      const overflowRes = await beforeCompactHandler!(
        {
          reason: 'overflow',
          preparation: prep,
          branchEntries: sm.getBranch(),
          signal: new AbortController().signal,
        },
        makeCtx()
      );
      assert.ok(overflowRes && !overflowRes.cancel && overflowRes.compaction, `Overflow compaction must NEVER be cancelled, got: ${JSON.stringify(overflowRes)}`);
      assert.ok(overflowRes.compaction.summary.includes('Overflow Compaction Summary'));
      assert.equal(streamFnCalls, 2, 'Overflow compaction must invoke LLM summarizer once');

      // Step 5: When real prompt tokens genuinely stay >= triggerTokens (120K) with no further prunable relief,
      //         reason='threshold' MUST NOT be cancelled and proceeds to L2 LLM compaction.
      sm.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Real high-context turn.' }],
        api: 'openai-completions',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        usage: mkUsage(135_000, 500),
        stopReason: 'stop',
        timestamp: Date.now() + 10_000,
      });
      const genuinePrep = buildPreparation(135_500);
      assert.ok(genuinePrep);
      const genuineThresholdRes = await beforeCompactHandler!(
        {
          reason: 'threshold',
          preparation: genuinePrep,
          branchEntries: sm.getBranch(),
          signal: new AbortController().signal,
        },
        makeCtx()
      );
      assert.ok(
        genuineThresholdRes && !genuineThresholdRes.cancel && genuineThresholdRes.compaction,
        `Genuine threshold compaction (>= triggerTokens) must proceed, got: ${JSON.stringify(genuineThresholdRes)}`
      );
      assert.ok(genuineThresholdRes.compaction.summary.includes('Genuine Threshold Compaction Summary'));
      assert.equal(streamFnCalls, 3);
    });
  });
});

/* ========================= Suite 14: Known-Engine Recall, Fingerprint Hints, Scratch-Script Sprawl & No-Deliverable Gatekeeper ========================= */

describe('14. Known-Engine Recall, Fingerprint Hints, Scratch-Script Sprawl & No-Deliverable Gatekeeper', () => {
  it('14.1 detectEngineFingerprintHints + detectVnEngineSummary surface fingerprint/TOML hints, ASCII heads, research dirs & no duplication', async () => {
    // 1) SiglusEngine via SiglusEngine.exe -> high confidence
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.writeFileSync(
        path.join(ws, 'SiglusEngine.exe'),
        Buffer.concat([Buffer.from('MZ\x90\x00SIGLUS', 'ascii'), Buffer.alloc(32, 0)]),
      );
      const scanExe = scanWorkspace(ws, homeDir);
      const hintsExe = detectEngineFingerprintHints(scanExe);
      const siglusExe = hintsExe.find((h) => h.engine === 'siglus');
      assert.ok(siglusExe, `Expected siglus hint from SiglusEngine.exe, got: ${JSON.stringify(hintsExe)}`);
      assert.equal(siglusExe.displayName, 'SiglusEngine');
      assert.equal(siglusExe.confidence, 'high');
      assert.ok(siglusExe.evidence.includes('SiglusEngine.exe'));
    });

    // 2) SiglusEngine via Scene.pck + Gameexe.dat pair -> high confidence; engineKnown stays false
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.writeFileSync(path.join(ws, 'Scene.pck'), Buffer.from([0x01, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00]));
      fs.writeFileSync(path.join(ws, 'Gameexe.dat'), Buffer.from([0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44]));

      const scanPair = scanWorkspace(ws, homeDir);
      const hintsPair = detectEngineFingerprintHints(scanPair);
      const siglusPair = hintsPair.find((h) => h.engine === 'siglus');
      assert.ok(siglusPair, `Expected siglus hint from Scene.pck + Gameexe.dat, got: ${JSON.stringify(hintsPair)}`);
      assert.equal(siglusPair.displayName, 'SiglusEngine');
      assert.equal(siglusPair.confidence, 'high');
      assert.ok(
        siglusPair.evidence.includes('Scene.pck + Gameexe.dat'),
        `Expected Scene.pck + Gameexe.dat evidence, got: ${JSON.stringify(siglusPair.evidence)}`
      );

      const summaryPair: VnEngineSummary = detectVnEngineSummary(ws);
      assert.equal(summaryPair.engineKnown, false);
      assert.equal(summaryPair.engineId, null);
      assert.equal(summaryPair.engineHints?.find((h) => h.engine === 'siglus')?.confidence, 'high');
    });

    // 3) Scene.pck alone -> medium confidence; papercup.toml engine = "siglus" merges & upgrades to high; research dir surfaced
    await withTempWorkspace(async ({ ws, homeDir }) => {
      const sceneBytes = Buffer.from([0x24, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
      fs.writeFileSync(path.join(ws, 'Scene.pck'), sceneBytes);

      const scanSolo = scanWorkspace(ws, homeDir);
      const hintsSolo = detectEngineFingerprintHints(scanSolo);
      const siglusSolo = hintsSolo.find((h) => h.engine === 'siglus');
      assert.ok(siglusSolo, `Expected siglus hint from solo Scene.pck, got: ${JSON.stringify(hintsSolo)}`);
      assert.equal(siglusSolo.confidence, 'medium');
      assert.ok(siglusSolo.evidence.includes('Scene.pck'));

      const summaryBeforeToml = detectVnEngineSummary(ws);
      assert.equal(summaryBeforeToml.engineKnown, false);
      assert.equal(summaryBeforeToml.engineHints?.find((h) => h.engine === 'siglus')?.confidence, 'medium');

      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        `[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nengine = "siglus"\n`,
        'utf8'
      );
      const researchSubdir = path.join(ws, '.papercup', 'research', 'siglus');
      fs.mkdirSync(researchSubdir, { recursive: true });
      fs.writeFileSync(path.join(researchSubdir, '01-layout.md'), '# Siglus layout notes\n', 'utf8');

      const summaryAfterToml = detectVnEngineSummary(ws);
      assert.equal(summaryAfterToml.engineKnown, false);
      assert.equal(summaryAfterToml.engineId, null);
      assert.equal(summaryAfterToml.engineName, null);

      const mergedHint = summaryAfterToml.engineHints?.find((h) => h.engine === 'siglus');
      assert.ok(mergedHint, 'Expected merged siglus hint');
      assert.equal(mergedHint.displayName, 'SiglusEngine');
      assert.equal(mergedHint.confidence, 'high');
      assert.ok(mergedHint.evidence.includes('Scene.pck'), `Missing Scene.pck in ${JSON.stringify(mergedHint.evidence)}`);
      assert.ok(
        mergedHint.evidence.includes('papercup.toml [vn.localization].engine=siglus'),
        `Missing TOML evidence in ${JSON.stringify(mergedHint.evidence)}`
      );

      assert.ok(
        summaryAfterToml.text.includes(`unknown  .pck  Scene.pck  unrecognized container  (${sceneBytes.length} B, head=24000000)`),
        `Expected factual unknown line with size & head, got:\n${summaryAfterToml.text}`
      );
      assert.ok(
        summaryAfterToml.text.includes('hint  siglus (SiglusEngine)  confidence=high  evidence='),
        `Expected formatted hint line in summary text, got:\n${summaryAfterToml.text}`
      );
      assert.ok(
        summaryAfterToml.text.includes('已有研究目录：.papercup/research/siglus'),
        `Expected research dir surfaced in summary text, got:\n${summaryAfterToml.text}`
      );
    });

    // 4) Artemis (.pfs pf8...), BGI (.arc Pack... ASCII header), YU-RIS (.ypf YPF\0)
    await withTempWorkspace(async ({ ws, homeDir }) => {
      const artemisBytes = Buffer.from('pf80\x01\x00\x00\x00\x00\x00\x00\x00', 'latin1');
      const bgiBytes = Buffer.from('PackFile    \x02\x00\x00\x00', 'latin1');
      const yurisBytes = Buffer.from('YPF\x00\xde\x01\x00\x00\x00\x00\x00\x00', 'latin1');

      fs.writeFileSync(path.join(ws, 'root.pfs'), artemisBytes);
      fs.writeFileSync(path.join(ws, 'data01000.arc'), bgiBytes);
      fs.writeFileSync(path.join(ws, 'ysbin.ypf'), yurisBytes);

      const scan = scanWorkspace(ws, homeDir);
      const byPath = new Map(scan.unknown.map((u) => [u.path, u]));
      assert.equal(byPath.get('root.pfs')?.head, '70663830');
      assert.equal(byPath.get('data01000.arc')?.head, '5061636b');
      assert.equal(byPath.get('ysbin.ypf')?.head, '59504600');

      const hints: EngineFingerprintHint[] = detectEngineFingerprintHints(scan);
      const artemis = hints.find((h) => h.engine === 'artemis');
      const bgi = hints.find((h) => h.engine === 'bgi');
      const yuris = hints.find((h) => h.engine === 'yuris');

      assert.ok(artemis && artemis.confidence === 'high' && artemis.displayName === 'Artemis Engine');
      assert.ok(artemis.evidence.some((e) => e.includes('root.pfs') && e.includes('head=70663830')));

      assert.ok(bgi && bgi.confidence === 'high' && bgi.displayName === 'BGI / Ethornell');
      assert.ok(bgi.evidence.some((e) => e.includes('data01000.arc') && e.includes('head=5061636b')));

      assert.ok(yuris && yuris.confidence === 'high' && yuris.displayName === 'YU-RIS');
      assert.ok(yuris.evidence.some((e) => e.includes('ysbin.ypf') && e.includes('head=59504600')));

      const summary = detectVnEngineSummary(ws);
      assert.equal(summary.engineKnown, false);
      assert.ok(summary.text.includes(`unknown  .arc  data01000.arc  unrecognized container  (${bgiBytes.length} B, head=5061636b)`));
      assert.ok(summary.text.includes('hint  artemis (Artemis Engine)  confidence=high'));
      assert.ok(summary.text.includes('hint  bgi (BGI / Ethornell)  confidence=high'));
      assert.ok(summary.text.includes('hint  yuris (YU-RIS)  confidence=high'));
    });

    // 5) Engines already in scan.hits are NOT duplicated in engineHints
    await withTempWorkspace(async ({ ws }) => {
      const xp3Buf = buildXp3Custom([{ name: 'scenario/start.ks', data: Buffer.from('*start\n', 'utf8') }]);
      fs.writeFileSync(path.join(ws, 'Game.xp3'), xp3Buf);
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        `[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\nengine = "kirikiri"\n`,
        'utf8'
      );

      const summary = detectVnEngineSummary(ws);
      assert.equal(summary.engineKnown, true);
      assert.equal(summary.engineId, 'kirikiri');
      assert.equal(
        (summary.engineHints ?? []).some((h) => h.engine === 'kirikiri'),
        false,
        `Detected kirikiri hit must not be duplicated in engineHints: ${JSON.stringify(summary.engineHints)}`
      );
      assert.equal(summary.text.includes('hint  kirikiri'), false);
    });

    const syntheticScan: ScanResult = {
      hits: [{ engine: 'bgi', path: 'main.arc', kind: 'custom-bgi', version: '', extra: {} }],
      unknown: [
        { path: 'voice.arc', size: 64, suffix: '.arc', head: '5061636b', reason: 'unrecognized container' },
        { path: 'root.pfs', size: 64, suffix: '.pfs', head: '70663830', reason: 'unrecognized container' },
      ],
      unknownTotal: 2,
      engines: ['bgi'],
    };
    const dedupHints = detectEngineFingerprintHints(syntheticScan);
    assert.equal(dedupHints.some((h) => h.engine === 'bgi'), false, 'Hit engine bgi must not be duplicated in hints');
    assert.equal(dedupHints.some((h) => h.engine === 'artemis'), true, 'Non-hit artemis unknown must still surface');
  });

  it('14.2 isTmpScratchScriptPath, shouldEmitScratchScriptSprawlNotice & isReverserDeliverableProgressArtifact enforce path & cadence contracts', () => {
    const scratchTruePaths = [
      '.papercup/tmp/siglus/probe1.py',
      '.papercup/tmp/siglus/probe2.py',
      '.papercup/tmp/siglus/probe3.py',
      '.papercup/tmp/siglus/probe4.py',
      '.papercup\\tmp\\x\\test.js',
      './.papercup/tmp/x/s.sh',
    ];
    for (const p of scratchTruePaths) {
      assert.equal(isTmpScratchScriptPath(p), true, `Expected isTmpScratchScriptPath(${JSON.stringify(p)}) === true`);
    }

    const scratchFalsePaths = [
      '.papercup/tmp/x/unpack.py',
      '.papercup/tmp/x/repack.py',
      '.papercup/tmp/x/extract.py',
      '.papercup/tmp/x/apply.py',
      '.papercup/tmp/unpacked/foo.py',
      '.papercup/tmp/work/foo.py',
      '.papercup/tmp/smoke/foo.py',
      '.papercup/tmp/diagnostics/foo.py',
      '.papercup/tmp/x/out.txt',
      '.papercup/research/siglus/01-layout.md',
      '.papercup/research/siglus/probe1.py',
      '',
      '   ',
    ];
    for (const p of scratchFalsePaths) {
      assert.equal(isTmpScratchScriptPath(p), false, `Expected isTmpScratchScriptPath(${JSON.stringify(p)}) === false`);
    }

    assert.equal(REVERSER_SCRATCH_SCRIPT_SPRAWL_FIRST, 4);
    assert.equal(REVERSER_SCRATCH_SCRIPT_SPRAWL_STEP, 4);
    for (const count of [0, 1, 2, 3, 5, 6, 7, 9, 10, 11]) {
      assert.equal(
        shouldEmitScratchScriptSprawlNotice(count),
        false,
        `Expected shouldEmitScratchScriptSprawlNotice(${count}) === false`
      );
    }
    for (const count of [4, 8, 12]) {
      assert.equal(
        shouldEmitScratchScriptSprawlNotice(count),
        true,
        `Expected shouldEmitScratchScriptSprawlNotice(${count}) === true`
      );
    }

    const deliverableTruePaths = [
      '.papercup/tmp/x/unpack.py',
      '.papercup/tmp/x/repack.py',
      '.papercup/tmp/x/extract.py',
      '.papercup/tmp/x/apply.py',
      '.papercup/skills/engine-siglus-pck/SKILL.md',
    ];
    for (const p of deliverableTruePaths) {
      assert.equal(
        isReverserDeliverableProgressArtifact(p),
        true,
        `Expected isReverserDeliverableProgressArtifact(${JSON.stringify(p)}) === true`
      );
    }

    const deliverableFalsePaths = [
      '.papercup/research/x/01-layout.md',
      '.papercup/tmp/x/probe1.py',
      '.papercup/tmp/unpacked/unpack.py',
    ];
    for (const p of deliverableFalsePaths) {
      assert.equal(
        isReverserDeliverableProgressArtifact(p),
        false,
        `Expected isReverserDeliverableProgressArtifact(${JSON.stringify(p)}) === false`
      );
    }
  });

  it('14.3 SubagentManager.wrapSubagentTool emits [效率提醒 / SINGLE-SCRIPT] on 4th distinct scratch script and known-engine oracle clause in 18-call PROGRESS CHECK', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const mgr = new SubagentManager();

      const makeSyntheticRun = () => {
        const nowIso = new Date().toISOString();
        const snapshot: SubagentTaskSnapshot = {
          taskId: `subtask-reverser-14-3-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          sessionId: 'sess-test-14-3',
          role: 'reverser',
          model: 'faux/test',
          thinkingLevel: 'max',
          status: 'running',
          activityState: 'running_tool',
          stage: 'inspect',
          startedAt: nowIso,
          lastActivityAt: nowIso,
          lastProgressAt: null,
          lastProgressSummary: null,
          durationMs: 0,
          toolCallCount: 0,
          errorCount: 0,
          artifactsCount: 0,
          consecutiveHypothesisFailures: 0,
          pivotWarningCount: 0,
          taskSummary: 'reverse siglus',
          taskPrompt: 'reverse siglus',
          maxConsecutiveFailures: 3,
          artifacts: [],
          pivotWarnings: [],
          retryCount: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          toolCalls: [],
          responsePreview: '',
        };
        const runCtx: any = {
          cwd: ws,
          session: { abort: () => {} },
          snapshot,
          recordDiagnostics: false,
          toolOutcomeByCallId: new Map(),
          queueController: { clearForRestore: () => null, reset: () => {}, hasPending: () => false },
          userSteeredNotes: [],
          pendingRestoredDraft: null,
          restoredDraftEmitted: false,
          emitQueueUpdate: () => {},
          lastPersistAtMs: 0,
          finalized: false,
          callsSinceProgress: 0,
          lastStallTurnKey: undefined,
          lastSoftStallRemindAt: 0,
          tmpTextReadCount: 0,
          finalize: (status: SubagentTaskSnapshot['status'], activityState: SubagentTaskSnapshot['activityState'], errorMsg?: string) => {
            if (runCtx.finalized) return;
            runCtx.finalized = true;
            snapshot.status = status;
            snapshot.activityState = activityState;
            if (errorMsg) snapshot.error = errorMsg;
          },
        };
        return { runCtx, snapshot };
      };

      const makeWrappedTools = (getRun: () => any) => {
        const stub = (name: string) =>
          (mgr as any).wrapSubagentTool(
            ws,
            {
              name,
              label: name,
              description: `stub ${name}`,
              parameters: {},
              execute: async (_id: string, params: any) => ({
                content: [{ type: 'text', text: `${name} ok: ${JSON.stringify(params)}` }],
              }),
            },
            getRun
          );
        return {
          write: stub('write'),
          edit: stub('edit'),
          bash: stub('bash'),
        };
      };

      const getResultText = (res: any): string =>
        Array.isArray(res?.content)
          ? res.content
              .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
              .map((p: any) => p.text)
              .join('\n')
          : '';

      // Part A: 4 distinct scratch scripts -> [效率提醒 / SINGLE-SCRIPT] on 4th only
      const sprawlRun = makeSyntheticRun();
      const sprawlTools = makeWrappedTools(() => sprawlRun.runCtx);
      for (let i = 1; i <= 4; i += 1) {
        const res = await sprawlTools.write.execute(
          `sprawl-${i}`,
          { path: `.papercup/tmp/siglus/probe${i}.py`, content: `# probe ${i}\n` },
          undefined,
          undefined,
          {}
        );
        const text = getResultText(res);
        if (i < 4) {
          assert.equal(
            text.includes('[效率提醒 / SINGLE-SCRIPT]'),
            false,
            `Must NOT emit [效率提醒 / SINGLE-SCRIPT] on write #${i}, got:\n${text}`
          );
        } else {
          assert.ok(
            text.includes('[效率提醒 / SINGLE-SCRIPT]'),
            `Expected [效率提醒 / SINGLE-SCRIPT] on 4th distinct scratch script, got:\n${text}`
          );
        }
      }
      assert.equal(sprawlRun.runCtx.scratchScriptPaths?.size, 4);

      // Part B: Editing the same analyze.py 4 times -> NEVER triggers [效率提醒 / SINGLE-SCRIPT]
      const reuseRun = makeSyntheticRun();
      const reuseTools = makeWrappedTools(() => reuseRun.runCtx);
      const w1 = await reuseTools.write.execute(
        'reuse-1',
        { path: '.papercup/tmp/siglus/analyze.py', content: '# v1\n' },
        undefined,
        undefined,
        {}
      );
      assert.equal(getResultText(w1).includes('[效率提醒 / SINGLE-SCRIPT]'), false);
      for (let i = 2; i <= 4; i += 1) {
        const eRes = await reuseTools.edit.execute(
          `reuse-${i}`,
          { path: '.papercup/tmp/siglus/analyze.py', oldText: `# v${i - 1}`, newText: `# v${i}` },
          undefined,
          undefined,
          {}
        );
        const eText = getResultText(eRes);
        assert.equal(
          eText.includes('[效率提醒 / SINGLE-SCRIPT]'),
          false,
          `Reusing same analyze.py (call #${i}) must NOT emit [效率提醒 / SINGLE-SCRIPT], got:\n${eText}`
        );
      }
      assert.equal(reuseRun.runCtx.scratchScriptPaths?.size, 1);

      // Part C: 18 stalled calls on reverser -> PROGRESS CHECK includes known-engine recall & byte oracle clause
      const stallRun = makeSyntheticRun();
      const stallTools = makeWrappedTools(() => stallRun.runCtx);
      for (let i = 1; i <= 17; i += 1) {
        const res = await stallTools.edit.execute(
          `stall-${i}`,
          { path: '.papercup/tmp/siglus/analyze.py', oldText: 'a', newText: `b${i}` },
          undefined,
          undefined,
          {}
        );
        assert.equal(getResultText(res).includes('[进展纠偏 / PROGRESS CHECK]'), false);
      }
      const res18 = await stallTools.bash.execute(
        'stall-18',
        { command: 'python .papercup/tmp/siglus/analyze.py' },
        undefined,
        undefined,
        {}
      );
      const text18 = getResultText(res18);
      assert.equal(stallRun.runCtx.callsSinceProgress, 18);
      assert.ok(text18.includes('[进展纠偏 / PROGRESS CHECK]'), `Expected PROGRESS CHECK at 18 stalled calls, got:\n${text18}`);
      assert.ok(
        text18.includes('回忆该引擎公开格式') && text18.includes('决定性字节验证') && text18.includes('而非继续盲扫'),
        `Expected known-engine recall & decisive byte oracle clause in PROGRESS CHECK, got:\n${text18}`
      );
    });
  });

  it('14.4 SubagentManager.runSubagentWithMetrics + delegate_task enforce MAX_REVERSER_NO_DELIVERABLE_ROUNDS gatekeeper and reset on deliverable script', async () => {
    assert.equal(MAX_RESUMES_PER_TASK, 3);
    assert.equal(MAX_REVERSER_NO_DELIVERABLE_ROUNDS, 3);

    const extractToolText = (res: any): string =>
      Array.isArray(res?.content)
        ? res.content
            .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
            .map((p: any) => p.text)
            .join('\n')
        : '';

    const setupStubbedManager = (ws: string) => {
      const mgr = new SubagentManager();
      const faux = createFauxCore({ tokensPerSecond: 10000 });
      const origCreate = mgr.createSubagentSession.bind(mgr);
      mgr.createSubagentSession = async (roleName, opts) => {
        const res = await origCreate(roleName, opts);
        (res.session as any).agent.state.model = faux.getModel();
        (res.session as any).agent.streamFunction = faux.streamSimple;
        (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
        return res;
      };
      const tools = mgr.createTools(() => ws, undefined, () => faux.getModel());
      const delegateTask = tools.find((t) => t.name === 'delegate_task');
      assert.ok(delegateTask, 'Expected delegate_task tool from SubagentManager.createTools');
      return { mgr, faux, delegateTask };
    };

    // Scenario A: 3 consecutive non-deliverable rounds hit gatekeeper & disable resume at round 3
    await withTempWorkspace(async ({ ws }) => {
      const { mgr, faux, delegateTask } = setupStubbedManager(ws);
      try {
        // Round 1: only writes scratch probe1.py
        faux.setResponses([
          () =>
            fauxAssistantMessage([
              fauxToolCall('write', { path: '.papercup/tmp/x/probe1.py', content: 'print("probe1")\n' }, { id: 'a-r1-1' }),
            ]),
          () => fauxAssistantMessage('Round 1 wrote scratch probe only.'),
        ]);
        const r1: any = await delegateTask.execute(
          'dt-a-1',
          { role: 'reverser', task: 'Analyze unknown container x (round 1)' },
          undefined,
          undefined,
          {} as any
        );
        const r1Text = extractToolText(r1);
        assert.equal(r1.details?.resumable, true);
        assert.equal(r1.details?.noDeliverableRounds, 1);
        assert.ok(typeof r1.details?.taskId === 'string' && r1.details.taskId.length > 0);
        assert.ok(
          r1Text.includes(`[reverser_session taskId=${r1.details.taskId}`),
          `Expected [reverser_session taskId=...] in Round 1 output, got:\n${r1Text}`
        );
        assert.equal(
          r1Text.includes('[reverser_gatekeeper]'),
          false,
          `Must NOT emit [reverser_gatekeeper] on Round 1, got:\n${r1Text}`
        );

        // Round 2: resumes Round 1 and only writes research doc (NOT a deliverable script/skill)
        faux.setResponses([
          () =>
            fauxAssistantMessage([
              fauxToolCall(
                'write',
                { path: '.papercup/research/x/02-hypotheses.md', content: '# Hypotheses\n- XOR candidate failed\n' },
                { id: 'a-r2-1' }
              ),
            ]),
          () => fauxAssistantMessage('Round 2 wrote hypotheses note only.'),
        ]);
        const r2: any = await delegateTask.execute(
          'dt-a-2',
          { role: 'reverser', task: 'Continue analyzing container x (round 2)', resumeTaskId: r1.details.taskId },
          undefined,
          undefined,
          {} as any
        );
        const r2Text = extractToolText(r2);
        assert.equal(r2.details?.resumed, true);
        assert.equal(r2.details?.resumable, true);
        assert.equal(r2.details?.noDeliverableRounds, 2);
        assert.ok(
          r2Text.includes(`[reverser_session taskId=${r2.details.taskId}`),
          `Expected [reverser_session ...] in Round 2 output, got:\n${r2Text}`
        );
        assert.ok(
          r2Text.includes('[reverser_gatekeeper]'),
          `Expected [reverser_gatekeeper] warning on Round 2, got:\n${r2Text}`
        );

        // Round 3: resumes Round 2 and only reads scratch file -> hits MAX_REVERSER_NO_DELIVERABLE_ROUNDS (3)
        faux.setResponses([
          () => fauxAssistantMessage([fauxToolCall('read', { path: '.papercup/tmp/x/probe1.py' }, { id: 'a-r3-1' })]),
          () => fauxAssistantMessage('Round 3 still has no deliverable script.'),
        ]);
        const r3: any = await delegateTask.execute(
          'dt-a-3',
          { role: 'reverser', task: 'Final attempt on container x (round 3)', resumeTaskId: r2.details.taskId },
          undefined,
          undefined,
          {} as any
        );
        const r3Text = extractToolText(r3);
        assert.equal(r3.details?.resumed, true);
        assert.equal(r3.details?.resumable, false);
        assert.equal(r3.details?.noDeliverableRounds, 3);
        assert.equal(
          r3Text.includes('[reverser_session'),
          false,
          `Must NOT emit [reverser_session ...] once no-deliverable cap closes resume, got:\n${r3Text}`
        );
        assert.ok(
          r3Text.includes('[reverser_gatekeeper resumable=false]'),
          `Expected [reverser_gatekeeper resumable=false] on Round 3, got:\n${r3Text}`
        );
      } finally {
        mgr.disposeResumableSessions(ws);
      }
    });

    // Scenario B: Deliverable script (.papercup/tmp/x/extract.py) resets noDeliverableRounds to 0
    await withTempWorkspace(async ({ ws }) => {
      const { mgr, faux, delegateTask } = setupStubbedManager(ws);
      try {
        // Round 1: scratch probe1.py only -> noDeliverableRounds === 1
        faux.setResponses([
          () =>
            fauxAssistantMessage([
              fauxToolCall('write', { path: '.papercup/tmp/x/probe1.py', content: 'print("probe1")\n' }, { id: 'b-r1-1' }),
            ]),
          () => fauxAssistantMessage('Round 1 wrote probe1.py.'),
        ]);
        const b1: any = await delegateTask.execute(
          'dt-b-1',
          { role: 'reverser', task: 'Inspect container x (scenario B round 1)' },
          undefined,
          undefined,
          {} as any
        );
        assert.equal(b1.details?.noDeliverableRounds, 1);
        assert.equal(b1.details?.resumable, true);

        // Round 2: deliverable extract.py -> resets noDeliverableRounds === 0, no gatekeeper warning
        faux.setResponses([
          () =>
            fauxAssistantMessage([
              fauxToolCall('write', { path: '.papercup/tmp/x/extract.py', content: 'print("extract")\n' }, { id: 'b-r2-1' }),
            ]),
          () => fauxAssistantMessage('Round 2 delivered extract.py.'),
        ]);
        const b2: any = await delegateTask.execute(
          'dt-b-2',
          { role: 'reverser', task: 'Deliver extract.py (scenario B round 2)', resumeTaskId: b1.details.taskId },
          undefined,
          undefined,
          {} as any
        );
        const b2Text = extractToolText(b2);
        assert.equal(b2.details?.resumed, true);
        assert.equal(b2.details?.noDeliverableRounds, 0);
        assert.equal(b2.details?.resumable, true);
        assert.equal(
          b2Text.includes('[reverser_gatekeeper'),
          false,
          `Must NOT emit gatekeeper warning when deliverable extract.py was produced, got:\n${b2Text}`
        );

        // Round 3: resume without deliverable -> increments cleanly from 0 to 1, still resumable
        faux.setResponses([
          () => fauxAssistantMessage([fauxToolCall('read', { path: '.papercup/tmp/x/probe1.py' }, { id: 'b-r3-1' })]),
          () => fauxAssistantMessage('Round 3 checked probe1.py without new deliverable.'),
        ]);
        const b3: any = await delegateTask.execute(
          'dt-b-3',
          { role: 'reverser', task: 'Verify details (scenario B round 3)', resumeTaskId: b2.details.taskId },
          undefined,
          undefined,
          {} as any
        );
        assert.equal(b3.details?.resumed, true);
        assert.equal(b3.details?.noDeliverableRounds, 1);
        assert.equal(b3.details?.resumable, true);
      } finally {
        mgr.disposeResumableSessions(ws);
      }
    });
  });

  it('14.5 Prompt contracts enforce Known-Engine Recall First, oracle verification, no hypothesis injection & gatekeeper stops', () => {
    const revPrompt = BUILTIN_SUBAGENTS.reverser.systemPrompt;
    assert.ok(revPrompt.includes('Known-Engine Recall First'), 'reverser prompt must encode Known-Engine Recall First');
    assert.ok(revPrompt.includes('recalled-unverified'), 'reverser prompt must require tagging recalled knowledge as recalled-unverified');
    assert.ok(revPrompt.includes('decisive byte oracle'), 'reverser prompt must require testing layers with a decisive byte oracle');
    assert.ok(revPrompt.includes('[效率提醒 / SINGLE-SCRIPT]'), 'reverser prompt must reference [效率提醒 / SINGLE-SCRIPT]');
    assert.ok(
      revPrompt.includes('NEVER preserve an unresolved container trailer verbatim') &&
        revPrompt.includes('unresolved TOC/index trailer') &&
        revPrompt.includes('verified non-runtime trailing payload'),
      'reverser prompt must distinguish unresolved TOC/index trailers from verified non-runtime trailing payloads'
    );

    const mainPrompt = PAPERCUP_SYSTEM_PROMPT;
    assert.ok(
      mainPrompt.includes('提醒 `reverser` 优先基于自身已有知识回忆该引擎公开格式并做字节级验证'),
      'PAPERCUP_SYSTEM_PROMPT must include known-engine recall reminder'
    );
    assert.ok(
      mainPrompt.includes('严禁使用“仅以给定字节事实为准，其余自行摸索”之类压制已知引擎知识的措辞'),
      'PAPERCUP_SYSTEM_PROMPT must forbid suppressing prior engine knowledge'
    );
    assert.ok(
      mainPrompt.includes('严禁在首次委派或续跑 prompt 中向 `reverser` 注入主 Agent 自己猜测的编码/加密/压缩假说'),
      'PAPERCUP_SYSTEM_PROMPT must forbid injecting speculative encoding hypotheses from main agent'
    );
    assert.ok(
      mainPrompt.includes('轮间把关只看**硬判据**是否推进') &&
        mainPrompt.includes('严禁靠不断补充新猜想空转续跑'),
      'PAPERCUP_SYSTEM_PROMPT must enforce hard-criteria gatekeeping across rounds'
    );
    assert.ok(
      mainPrompt.includes('[reverser_gatekeeper resumable=false]') && mainPrompt.includes('必须停止续跑'),
      'PAPERCUP_SYSTEM_PROMPT must require stopping on [reverser_gatekeeper resumable=false]'
    );
  });

  it('14.6 resolveBuiltinReverserSkillDir & BUILTIN_SUBAGENTS.reverser.skillPaths bind bundled vn-reverser skill without legacy rea dir or dev traces', () => {
    const skillDir = resolveBuiltinReverserSkillDir();
    assert.ok(skillDir, 'resolveBuiltinReverserSkillDir() must resolve a valid directory');
    assert.ok(
      fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory(),
      `Resolved vn-reverser skill dir must exist: ${skillDir}`
    );

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const peGuidePath = path.join(skillDir, 'references', 'pe-and-disassembly.md');
    const archiveGuidePath = path.join(skillDir, 'references', 'archive-and-codec-triage.md');
    for (const requiredFile of [skillMdPath, peGuidePath, archiveGuidePath]) {
      assert.ok(
        fs.existsSync(requiredFile) && fs.statSync(requiredFile).isFile(),
        `Expected bundled vn-reverser file to exist: ${requiredFile}`
      );
    }

    assert.ok(
      Array.isArray(BUILTIN_SUBAGENTS.reverser.skillPaths) &&
        BUILTIN_SUBAGENTS.reverser.skillPaths.includes(skillDir),
      `BUILTIN_SUBAGENTS.reverser.skillPaths must include ${skillDir}, got: ${JSON.stringify(BUILTIN_SUBAGENTS.reverser.skillPaths)}`
    );

    const legacyReaDir = path.resolve(skillDir, '..', 'rea');
    const sourceReaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/subagents/rea');
    assert.equal(
      fs.existsSync(legacyReaDir),
      false,
      `Legacy rea directory must be completely removed, still found: ${legacyReaDir}`
    );
    assert.equal(
      fs.existsSync(sourceReaDir),
      false,
      `server/src/subagents/rea must not exist, still found: ${sourceReaDir}`
    );

    const skillMd = fs.readFileSync(skillMdPath, 'utf8');
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
    assert.ok(fmMatch, 'SKILL.md must begin with valid YAML frontmatter');
    assert.match(
      fmMatch[1],
      /^name:\s*vn-reverse-engineering\s*$/m,
      `SKILL.md frontmatter must declare name: vn-reverse-engineering, got:\n${fmMatch[1]}`
    );
    assert.ok(
      skillMd.includes('references/pe-and-disassembly.md'),
      'SKILL.md must reference references/pe-and-disassembly.md'
    );
    assert.ok(
      skillMd.includes('references/archive-and-codec-triage.md'),
      'SKILL.md must reference references/archive-and-codec-triage.md'
    );

    for (const forbidden of ['AGENTS.md', 'TODO.md', 'change/', '.github/', 'export-public.mjs']) {
      assert.equal(
        skillMd.includes(forbidden),
        false,
        `SKILL.md must NOT contain private dev-trace reference ${JSON.stringify(forbidden)}`
      );
    }
  });
});

describe('15. Reverser Fast-Path Tools, Skill Read Fallback, Layer-Scoped Compaction & Budget Guardrails', () => {
  it('15.1 resolveSkillReadFallbackPath & guarded read tool resolve skill docs safely without escaping or bypassing secret guards', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      const skillDir = resolveBuiltinReverserSkillDir();
      assert.ok(skillDir && fs.existsSync(skillDir), `Expected builtin vn-reverser skillDir, got: ${skillDir}`);

      const realSkillMd = fs.realpathSync(path.join(skillDir, 'SKILL.md'));
      const realArchiveRef = fs.realpathSync(path.join(skillDir, 'references', 'archive-and-codec-triage.md'));
      const realPeRef = fs.realpathSync(path.join(skillDir, 'references', 'pe-and-disassembly.md'));

      // Mis-spelled or relative skill paths fall back to real files inside skillReadRoots
      assert.equal(
        resolveSkillReadFallbackPath('../server/src/subagents/vn-reverser/SKILL.md', ws, [skillDir]),
        realSkillMd
      );
      assert.equal(
        resolveSkillReadFallbackPath('references/archive-and-codec-triage.md', ws, [skillDir]),
        realArchiveRef
      );
      assert.equal(
        resolveSkillReadFallbackPath('references/pe-and-disassembly.md', ws, [skillDir]),
        realPeRef
      );
      assert.equal(resolveSkillReadFallbackPath('SKILL.md', ws, [skillDir]), realSkillMd);

      // Escapes, traversal after matched root, empty paths, and restricted secret paths must return null
      fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP_SECRET\n', 'utf8');
      fs.writeFileSync(path.join(root, '.env'), 'SECRET_KEY=abc\n', 'utf8');
      fs.writeFileSync(path.join(ws, '.env'), 'WS_SECRET=xyz\n', 'utf8');

      const fakeSkillRoot = path.join(root, 'fake-skill');
      fs.mkdirSync(fakeSkillRoot, { recursive: true });
      fs.writeFileSync(path.join(fakeSkillRoot, '.env'), 'FAKE_SKILL_SECRET=1\n', 'utf8');

      for (const badPath of [
        '../secret.txt',
        'vn-reverser/../secret.txt',
        'references/../../.env',
        'fake-skill/.env',
        '',
        '   ',
      ]) {
        assert.equal(
          resolveSkillReadFallbackPath(badPath, ws, [skillDir, fakeSkillRoot]),
          null,
          `Expected resolveSkillReadFallbackPath(${JSON.stringify(badPath)}) === null`
        );
      }

      // Guarded `read` tool resolves skillReadRoots cleanly while preserving secret guards
      const defs = createGuardedBuiltinToolDefinitions(ws, ['read'], { skillReadRoots: [skillDir] });
      const readTool = defs.find((d) => d.name === 'read');
      assert.ok(readTool, 'Expected guarded read tool definition');

      const extractText = (res: any): string =>
        Array.isArray(res?.content)
          ? res.content
              .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
              .map((p: any) => p.text)
              .join('\n')
          : '';

      const resSkill: any = await readTool.execute(
        'read-skill-1',
        { path: '../server/src/subagents/vn-reverser/SKILL.md' },
        undefined,
        undefined,
        {} as any
      );
      assert.notEqual(resSkill.isError, true, `Expected fallback read of SKILL.md to succeed: ${extractText(resSkill)}`);
      assert.ok(extractText(resSkill).includes('vn-reverse-engineering'));
      assert.ok(extractText(resSkill).includes('Fast 4-Stage Funnel'));

      const resRef: any = await readTool.execute(
        'read-skill-2',
        { path: 'references/archive-and-codec-triage.md' },
        undefined,
        undefined,
        {} as any
      );
      assert.notEqual(resRef.isError, true, `Expected fallback read of reference doc to succeed: ${extractText(resRef)}`);
      assert.ok(extractText(resRef).includes('Layer-Scoped Invalidation'));

      const resEnvTraversal: any = await readTool.execute(
        'read-env-1',
        { path: 'references/../../.env' },
        undefined,
        undefined,
        {} as any
      );
      assert.equal(resEnvTraversal.isError, true);
      assert.ok(extractText(resEnvTraversal).includes('Security guard'));

      const resEnvDirect: any = await readTool.execute('read-env-2', { path: '.env' }, undefined, undefined, {} as any);
      assert.equal(resEnvDirect.isError, true);
      assert.ok(extractText(resEnvDirect).includes('Security guard'));
    });
  });

  it('15.2 vn_re_lookup URL allowlist, readVnResearchConfig overrides/defaults & offline mock fetch with secret redaction', async () => {
    // 1. validateLookupUrl allowlist & SSRF/credential rejection
    for (const allowed of [
      'https://api.github.com/repos/morkt/GARbro',
      'https://raw.githubusercontent.com/morkt/GARbro/master/README.md',
      'https://www.cnblogs.com/example/p/12345.html',
      'https://blog.schnee.moe/posts/GalgameReverse1/',
    ]) {
      const parsed = validateLookupUrl(allowed);
      assert.equal(parsed.protocol, 'https:');
      assert.ok(RE_LOOKUP_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()));
    }
    assert.ok(
      CURATED_VN_RE_REPOS.some((r) => r.repo === 'YuriSizuku/GalgameReverse'),
      'CURATED_VN_RE_REPOS must include YuriSizuku/GalgameReverse'
    );

    for (const blocked of [
      'http://api.github.com/repos/morkt/GARbro',
      'https://127.0.0.1/test',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/test',
      'https://user:pass@github.com/morkt/GARbro',
      'https://evil.example.com/payload.txt',
    ]) {
      assert.throws(
        () => validateLookupUrl(blocked),
        (err: any) => err instanceof Error && err.message.length > 0,
        `Expected validateLookupUrl(${JSON.stringify(blocked)}) to reject`
      );
    }

    // 2. readVnResearchConfig defaults, TOML overrides, and PAPERCUP_RE_* env overrides
    await withTempWorkspace(async ({ ws }) => {
      const envKeys = [
        'PAPERCUP_REVERSER_MAX_NO_DELIVERABLE_COMPACTIONS',
        'PAPERCUP_REVERSER_MAX_TOKENS',
        'PAPERCUP_RE_LOOKUP_ENABLED',
        'GITHUB_TOKEN',
      ] as const;
      const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      for (const k of envKeys) delete process.env[k];

      try {
        assert.equal(DEFAULT_MAX_REVERSER_NO_DELIVERABLE_COMPACTIONS, 3);
        assert.equal(DEFAULT_MAX_REVERSER_TOKENS, 0);
        assert.equal(DEFAULT_ALLOW_RE_LOOKUP, true);

        const defaults = readVnResearchConfig(ws);
        assert.equal(defaults.maxReverserNoDeliverableCompactions, 3);
        assert.equal(defaults.maxReverserTokens, 0);
        assert.equal(defaults.allowReLookup, true);

        fs.writeFileSync(
          path.join(ws, 'papercup.toml'),
          [
            '[vn.research]',
            'max_reverser_no_deliverable_compactions = 5',
            'max_reverser_tokens = 250000',
            'allow_re_lookup = false',
            '',
          ].join('\n'),
          'utf8'
        );
        const fromToml = readVnResearchConfig(ws);
        assert.equal(fromToml.maxReverserNoDeliverableCompactions, 5);
        assert.equal(fromToml.maxReverserTokens, 250000);
        assert.equal(fromToml.allowReLookup, false);

        process.env.PAPERCUP_REVERSER_MAX_NO_DELIVERABLE_COMPACTIONS = '2';
        process.env.PAPERCUP_REVERSER_MAX_TOKENS = '42000';
        process.env.PAPERCUP_RE_LOOKUP_ENABLED = 'true';
        const fromEnv = readVnResearchConfig(ws);
        assert.equal(fromEnv.maxReverserNoDeliverableCompactions, 2);
        assert.equal(fromEnv.maxReverserTokens, 42000);
        assert.equal(fromEnv.allowReLookup, true);

        // 3. Offline vn_re_lookup with mock fetchImpl
        const requests: Array<{ url: string; headers: Record<string, string> }> = [];
        const mockFetch: typeof fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          const headers: Record<string, string> = {};
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((v, k) => {
              headers[k.toLowerCase()] = v;
            });
          }
          requests.push({ url, headers });

          if (url.startsWith('https://api.github.com/search/repositories')) {
            return new Response(
              JSON.stringify({
                items: [
                  {
                    full_name: 'example/siglus-unpacker',
                    stargazers_count: 88,
                    default_branch: 'main',
                    description: 'Siglus Scene.pck tool token_echo=ghp_secret_123',
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (url === 'https://api.github.com/repos/morkt/GARbro') {
            return new Response(JSON.stringify({ default_branch: 'master' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url === 'https://api.github.com/repos/morkt/GARbro/git/trees/master?recursive=1') {
            return new Response(
              JSON.stringify({
                truncated: false,
                tree: [
                  { type: 'tree', path: 'ArcFormats/Siglus' },
                  { type: 'blob', path: 'ArcFormats/Siglus/ArcPCK.cs' },
                  { type: 'blob', path: 'ArcFormats/BGI/ArcARC.cs' },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (url === 'https://www.cnblogs.com/re/p/siglus.html') {
            const html = [
              '<html><head><style>body{color:red}</style><script>console.log("ignore")</script></head>',
              '<body><h1>Siglus Header</h1>',
              '<p>Line 1 &amp; magic</p>',
              '<p>Line 2 &lt;XOR&gt; secret=ghp_secret_123</p>',
              '<p>Line 3 LZSS</p>',
              '<p>Line 4 End</p>',
              '</body></html>',
            ].join('');
            return new Response(html, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url === 'https://raw.githubusercontent.com/morkt/GARbro/master/big.txt') {
            // Stream 120 KB (> 64 KB limit) to verify bounded response truncation
            const lineBytes = Buffer.from('A'.repeat(1023) + '\n', 'utf8');
            let sentChunks = 0;
            const stream = new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sentChunks >= 120) {
                  controller.close();
                  return;
                }
                sentChunks += 1;
                controller.enqueue(lineBytes);
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            });
          }
          return new Response('not found', { status: 404 });
        };

        process.env.GITHUB_TOKEN = 'ghp_secret_123';
        const getText = (res: any): string =>
          Array.isArray(res?.content)
            ? res.content
                .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
                .map((p: any) => p.text)
                .join('\n')
            : '';

        // 3a. allow_re_lookup = false -> disabled message & zero HTTP requests
        process.env.PAPERCUP_RE_LOOKUP_ENABLED = 'false';
        const disabledTools = createReverserTools(() => ws, {
          fetchImpl: mockFetch,
          getKnownSecrets: () => ['ghp_secret_123'],
        });
        const lookupDisabled = disabledTools.find((t) => t.name === 'vn_re_lookup')!;
        const disabledRes: any = await lookupDisabled.execute(
          'lookup-disabled',
          { action: 'search', query: 'siglus' },
          undefined,
          undefined,
          {} as any
        );
        assert.notEqual(disabledRes.isError, true);
        assert.equal(disabledRes.details?.disabled, true);
        assert.ok(getText(disabledRes).includes('disabled'));
        assert.equal(requests.length, 0, 'Must NOT issue any fetch request when allow_re_lookup=false');

        // 3b. Enabled -> search, tree, fetch (HTML->text + slicing + 64 KB cap + secret redaction)
        process.env.PAPERCUP_RE_LOOKUP_ENABLED = 'true';
        const tools = createReverserTools(() => ws, {
          fetchImpl: mockFetch,
          getKnownSecrets: () => ['ghp_secret_123'],
        });
        const lookupTool = tools.find((t) => t.name === 'vn_re_lookup')!;

        const searchRes: any = await lookupTool.execute(
          'lookup-search',
          { action: 'search', query: 'siglus' },
          undefined,
          undefined,
          {} as any
        );
        const searchText = getText(searchRes);
        assert.notEqual(searchRes.isError, true);
        assert.ok(CURATED_VN_RE_REPOS.some((r) => r.repo === 'morkt/GARbro'));
        assert.ok(searchText.includes('morkt/GARbro'));
        assert.ok(searchText.includes('arcusmaximus/VNTranslationTools'));
        assert.ok(searchText.includes('example/siglus-unpacker'));
        assert.ok(searchText.includes('[参考约束]'));
        assert.equal(searchText.includes('ghp_secret_123'), false, 'GITHUB_TOKEN must be redacted from search output');

        const treeRes: any = await lookupTool.execute(
          'lookup-tree',
          { action: 'tree', repo: 'morkt/GARbro', query: 'siglus' },
          undefined,
          undefined,
          {} as any
        );
        const treeText = getText(treeRes);
        assert.notEqual(treeRes.isError, true);
        assert.ok(treeText.includes('ArcFormats/Siglus/ArcPCK.cs'));
        assert.equal(treeText.includes('ArcFormats/BGI/ArcARC.cs'), false, 'tree must filter out non-matching paths');
        assert.ok(treeText.includes('[参考约束]'));

        const htmlRes: any = await lookupTool.execute(
          'lookup-fetch-html',
          { action: 'fetch', url: 'https://www.cnblogs.com/re/p/siglus.html', startLine: 2, maxLines: 10 },
          undefined,
          undefined,
          {} as any
        );
        const htmlText = getText(htmlRes);
        assert.notEqual(htmlRes.isError, true);
        assert.equal(htmlText.includes('console.log'), false, 'HTML <script> must be stripped');
        assert.equal(htmlText.includes('color:red'), false, 'HTML <style> must be stripped');
        assert.ok(htmlText.includes('2: Line 1 & magic'), `Expected sliced/decoded HTML line, got:\n${htmlText}`);
        assert.ok(htmlText.includes('3: Line 2 <XOR>'));
        assert.equal(htmlText.includes('ghp_secret_123'), false, 'GITHUB_TOKEN must be redacted from fetched text');
        assert.ok(htmlText.includes('[参考约束]'));

        const bigRes: any = await lookupTool.execute(
          'lookup-fetch-big',
          { action: 'fetch', repo: 'morkt/GARbro', path: 'big.txt', startLine: 1, maxLines: 200 },
          undefined,
          undefined,
          {} as any
        );
        const bigText = getText(bigRes);
        assert.notEqual(bigRes.isError, true);
        // 64 KB cap -> at most 64 lines of 1024 B (line 65 would exceed 65536 B)
        const numberedLines = bigText.split(/\r?\n/).filter((ln) => /^\d+:\s/.test(ln));
        assert.ok(numberedLines.length <= 65, `Expected 64 KB cap (~64 lines), got ${numberedLines.length} lines`);
        const rawPayloadBytes = numberedLines.reduce((sum, ln) => sum + Buffer.byteLength(ln.replace(/^\d+:\s/, '') + '\n', 'utf8'), 0);
        assert.ok(rawPayloadBytes <= 64 * 1024 + 128, `Expected <= 64 KB fetched payload, got ${rawPayloadBytes} B`);

        // Verify Authorization header is only attached to api.github.com, never to third-party hosts
        const apiCalls = requests.filter((r) => r.url.startsWith('https://api.github.com/'));
        const nonApiCalls = requests.filter((r) => !r.url.startsWith('https://api.github.com/'));
        assert.ok(apiCalls.length >= 2);
        for (const c of apiCalls) {
          assert.equal(c.headers.authorization, 'Bearer ghp_secret_123');
        }
        assert.ok(nonApiCalls.length >= 2);
        for (const c of nonApiCalls) {
          assert.equal(c.headers.authorization, undefined, `Must NOT send GITHUB_TOKEN to ${c.url}`);
        }
      } finally {
        for (const k of envKeys) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
      }
    });
  });

  it('15.3 vn_re_inspect & vn_re_trace/prepareReadOnlyTraceSandbox enforce magic/entropy triage, path guards & isolated sandbox cleanup', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      // Build 12 KB test archive with embedded PNG, OggS, and zlib (78 9c) signatures + distinct head/tail
      const buf = Buffer.alloc(12 * 1024, 0x2a);
      Buffer.from('PACKTEST', 'ascii').copy(buf, 0);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0x40);
      Buffer.from('OggS', 'ascii').copy(buf, 0x200);
      Buffer.from([0x78, 0x9c, 0x63, 0x60]).copy(buf, 0x400);
      Buffer.from('TAIL_END_MARKER_64', 'ascii').copy(buf, buf.length - 18);
      fs.writeFileSync(path.join(ws, 'sample.arc'), buf);

      fs.writeFileSync(path.join(root, 'outside.bin'), Buffer.from('OUTSIDE_ARCHIVE', 'ascii'));
      fs.writeFileSync(path.join(root, 'outside.exe'), Buffer.from('MZ\x90\x00', 'latin1'));
      fs.writeFileSync(path.join(ws, '.env'), 'API_KEY=super_secret\n', 'utf8');
      fs.writeFileSync(path.join(ws, 'notes.dat'), Buffer.from('NOT_AN_EXE', 'ascii'));

      const fakeExe = Buffer.alloc(512, 0);
      fakeExe.write('MZ', 0, 'ascii');
      fs.writeFileSync(path.join(ws, 'Game.exe'), fakeExe);

      const tools = createReverserTools(() => ws);
      const inspectTool = tools.find((t) => t.name === 'vn_re_inspect')!;
      const traceTool = tools.find((t) => t.name === 'vn_re_trace')!;
      const getText = (res: any): string =>
        Array.isArray(res?.content)
          ? res.content
              .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
              .map((p: any) => p.text)
              .join('\n')
          : '';

      // 1. vn_re_inspect(action="archive")
      const archiveRes: any = await inspectTool.execute(
        'inspect-archive',
        { action: 'archive', path: 'sample.arc' },
        undefined,
        undefined,
        {} as any
      );
      const archiveText = getText(archiveRes);
      assert.notEqual(archiveRes.isError, true, `Expected vn_re_inspect(archive) to succeed, got:\n${archiveText}`);
      assert.ok(archiveText.includes('head64: 5041434b54455354'), `Missing head64 hex in:\n${archiveText}`);
      assert.ok(archiveText.includes('tail64:'), `Missing tail64 in:\n${archiveText}`);
      assert.ok(archiveText.includes('head_4k:'), `Missing head_4k in:\n${archiveText}`);
      assert.ok(archiveText.includes('magic_hits('), `Missing magic_hits in:\n${archiveText}`);
      assert.ok(archiveText.includes('PNG@0x40'), `Missing PNG@0x40 in:\n${archiveText}`);
      assert.ok(archiveText.includes('OGG@0x200'), `Missing OGG@0x200 in:\n${archiveText}`);
      assert.ok(archiveText.includes('ZLIB_DEF@0x400'), `Missing ZLIB_DEF@0x400 in:\n${archiveText}`);

      // 2. Security rejections & disasm missing va
      const outsideRes: any = await inspectTool.execute(
        'inspect-outside',
        { action: 'archive', path: '../outside.bin' },
        undefined,
        undefined,
        {} as any
      );
      assert.equal(outsideRes.isError, true);
      assert.ok(getText(outsideRes).includes('Security guard'));

      const envRes: any = await inspectTool.execute(
        'inspect-env',
        { action: 'archive', path: '.env' },
        undefined,
        undefined,
        {} as any
      );
      assert.equal(envRes.isError, true);
      assert.ok(getText(envRes).includes('Security guard'));

      const disasmNoVa: any = await inspectTool.execute(
        'inspect-disasm-nova',
        { action: 'disasm', path: 'Game.exe' },
        undefined,
        undefined,
        {} as any
      );
      assert.equal(disasmNoVa.isError, true);
      assert.ok(getText(disasmNoVa).includes('requires va'));

      // 3. WORKSPACE_TMP_RESERVED_SUBDIRS & prepareReadOnlyTraceSandbox isolation + cleanup
      assert.equal(WORKSPACE_RE_TRACE_TMP_REL, '.papercup/tmp/re-trace');
      assert.equal(WORKSPACE_TMP_RESERVED_SUBDIRS.has('re-trace'), true);
      assert.equal(isTmpScratchScriptPath('.papercup/tmp/re-trace/trace-1/helper.py'), false);

      assert.throws(() => prepareReadOnlyTraceSandbox(ws, 'notes.dat'), SmokeError);
      assert.throws(() => prepareReadOnlyTraceSandbox(ws, '../outside.exe'), SmokeError);

      const wsPaths = resolveWorkspacePaths(ws);
      const sandbox = prepareReadOnlyTraceSandbox(ws, 'Game.exe');
      assert.equal(sandbox.sandboxDir, wsPaths.reTraceSandboxDir(sandbox.runId));
      assert.ok(sandbox.sandboxDir.startsWith(wsPaths.reTraceTmpDir));
      assert.equal(fs.existsSync(sandbox.exePath), true);
      assert.deepEqual(fs.readFileSync(sandbox.exePath), fakeExe);

      sandbox.cleanup();
      assert.equal(fs.existsSync(sandbox.sandboxDir), false, 'prepareReadOnlyTraceSandbox.cleanup() must remove sandbox dir');
      assert.equal(fs.existsSync(path.join(ws, 'Game.exe')), true, 'Original Game.exe must remain intact');

      // 4. vn_re_trace rejects non-.exe & out-of-workspace paths (or reports unsupported on non-Windows)
      const traceNonExe: any = await traceTool.execute(
        'trace-non-exe',
        { exe: 'notes.dat', mode: 'io_trace' },
        undefined,
        undefined,
        {} as any
      );
      const traceOutside: any = await traceTool.execute(
        'trace-outside',
        { exe: '../outside.exe', mode: 'io_trace' },
        undefined,
        undefined,
        {} as any
      );
      if (process.platform === 'win32') {
        assert.equal(traceNonExe.isError, true);
        assert.equal(traceOutside.isError, true);
      } else {
        assert.equal(traceNonExe.details?.supported, false);
        assert.equal(traceOutside.details?.supported, false);
      }

      // 5. re_inspect.py KEY_WIN32_APIS includes font/encoding/locale APIs
      const skillDir = resolveBuiltinReverserSkillDir();
      assert.ok(skillDir, 'Expected builtin vn-reverser skillDir');
      const reInspectPy = fs.readFileSync(path.join(skillDir, 'scripts', 're_inspect.py'), 'utf8');
      const keyApiBlock = /KEY_WIN32_APIS\s*=\s*\{([\s\S]*?)\}/.exec(reInspectPy)?.[1] ?? '';
      assert.ok(keyApiBlock.length > 0, 'Expected KEY_WIN32_APIS set in re_inspect.py');
      for (const apiName of [
        'createfontw',
        'createfontindirectw',
        'enumfontfamiliesexw',
        'getacp',
        'getsystemdefaultlcid',
        'isdbcsleadbyte',
        'isdbcsleadbyteex',
      ]) {
        assert.ok(
          keyApiBlock.includes(`"${apiName}"`),
          `re_inspect.py KEY_WIN32_APIS missing "${apiName}"`
        );
      }
    });
  });

  it('15.4 Tool isolation invariant: reverser owns vn_re_* & vn_patch_font, translator/role-checker get 0 tools & main AgentService excludes them', async () => {
    assert.ok(Array.isArray(BUILTIN_SUBAGENTS.reverser.allowedTools));
    for (const toolName of ['vn_re_inspect', 'vn_re_lookup', 'vn_re_trace', 'vn_patch_font']) {
      assert.ok(
        BUILTIN_SUBAGENTS.reverser.allowedTools!.includes(toolName),
        `BUILTIN_SUBAGENTS.reverser.allowedTools must include ${toolName}`
      );
    }
    assert.deepEqual(BUILTIN_SUBAGENTS.translator.allowedTools, []);
    assert.deepEqual(BUILTIN_SUBAGENTS['role-checker'].allowedTools, []);
    assert.equal(requiresResearchGuardrails('font-worker', ['vn_patch_font']), true);
    assert.equal(isReverserDeliverableProgressArtifact('.papercup/data/vn/fonts/manifest.json'), true);

    await withTempWorkspace(async ({ ws }) => {
      const vnTools = createVnTools(() => ws);
      const vnToolNames = new Set(vnTools.map((t) => t.name));
      for (const revOnly of ['vn_re_inspect', 'vn_re_lookup', 'vn_re_trace', 'vn_patch_font']) {
        assert.equal(vnToolNames.has(revOnly), false, `createVnTools must NOT expose ${revOnly}`);
      }

      const reverserTools = createReverserTools(() => ws);
      const reverserToolNames = new Set(reverserTools.map((t) => t.name));
      for (const revOnly of ['vn_re_inspect', 'vn_re_lookup', 'vn_re_trace', 'vn_patch_font']) {
        assert.equal(reverserToolNames.has(revOnly), true, `createReverserTools must expose ${revOnly}`);
      }

      const mgr = new SubagentManager();
      mgr.setCustomToolsProvider(() => [...vnTools, ...reverserTools]);

      const translatorSub = await mgr.createSubagentSession('translator', { cwd: ws });
      try {
        assert.equal(translatorSub.session.getActiveToolNames().length, 0);
      } finally {
        translatorSub.session.dispose?.();
      }

      const checkerSub = await mgr.createSubagentSession('role-checker', { cwd: ws });
      try {
        assert.equal(checkerSub.session.getActiveToolNames().length, 0);
      } finally {
        checkerSub.session.dispose?.();
      }

      const reverserSub = await mgr.createSubagentSession('reverser', { cwd: ws });
      try {
        const revActive = reverserSub.session.getActiveToolNames();
        for (const expected of ['vn_re_inspect', 'vn_re_lookup', 'vn_re_trace', 'vn_patch_font', 'vn_detect', 'vn_learn_skill']) {
          assert.ok(revActive.includes(expected), `reverser session missing ${expected}, got: ${revActive.join(', ')}`);
        }
      } finally {
        reverserSub.session.dispose?.();
      }

      const svc = new AgentService(ws, { sessionMode: 'memory' });
      try {
        await svc.initSession();
        const mainTools: string[] = (svc as any).currentSession.getActiveToolNames();
        assert.ok(mainTools.includes('delegate_task'));
        assert.ok(mainTools.includes('vn_detect'));
        for (const revOnly of ['vn_re_inspect', 'vn_re_lookup', 'vn_re_trace', 'vn_patch_font']) {
          assert.equal(mainTools.includes(revOnly), false, `Main AgentService must NOT expose ${revOnly}`);
        }
      } finally {
        (svc as any).disposeCurrentSessionState?.(true);
      }
    });
  });

  it('15.5 Compaction layer-scoped invalidation, RECALL-FIRST soft notice, dual-track no-deliverable tracking, L2 compaction breaker & token cap', async () => {
    // 1. Layer-scoped compaction instructions for reverser
    const revInstructions = buildDomainCompactionInstructions('reverser');
    for (const required of [
      '[layer: raw]',
      '[layer: post-xor]',
      '[layer: post-decompress]',
      '[layer: inner-script]',
      'DISPROVEN HYPOTHESES / DEAD ENDS',
      'AUTOMATICALLY INVALIDATED',
      'NEVER carry them forward',
    ]) {
      assert.ok(
        revInstructions.includes(required),
        `buildDomainCompactionInstructions('reverser') missing ${JSON.stringify(required)}`
      );
    }

    // 2. Pure helpers + wrapSubagentTool RECALL-FIRST & 30-call NO-DELIVERABLE tracking
    assert.equal(REVERSER_NO_DELIVERABLE_REMIND_INTERVAL, 30);
    assert.equal(detectKnownEngineHintInText('unknown  .pck  Scene.pck\nhint  siglus (SiglusEngine)  confidence=high'), true);
    assert.equal(detectKnownEngineHintInText('unknown  .bin  blob.bin'), false);
    assert.equal(shouldEmitNoDeliverableNotice(29, 0), false);
    assert.equal(shouldEmitNoDeliverableNotice(30, 0), true);
    assert.equal(shouldEmitNoDeliverableNotice(30, 30), false);
    assert.equal(shouldEmitNoDeliverableNotice(60, 30), true);

    await withTempWorkspace(async ({ ws }) => {
      assert.equal(hasResearchRecallHypotheses(ws), false);

      const mgr = new SubagentManager();
      const nowIso = new Date().toISOString();
      const snapshot: SubagentTaskSnapshot = {
        taskId: `subtask-reverser-15-5-${Date.now()}`,
        sessionId: 'sess-15-5',
        role: 'reverser',
        model: 'faux/test',
        thinkingLevel: 'max',
        status: 'running',
        activityState: 'running_tool',
        stage: 'inspect',
        startedAt: nowIso,
        lastActivityAt: nowIso,
        lastProgressAt: null,
        lastProgressSummary: null,
        durationMs: 0,
        toolCallCount: 0,
        errorCount: 0,
        artifactsCount: 0,
        consecutiveHypothesisFailures: 0,
        pivotWarningCount: 0,
        taskSummary: 'reverse siglus',
        taskPrompt: 'reverse siglus',
        maxConsecutiveFailures: 3,
        artifacts: [],
        pivotWarnings: [],
        retryCount: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        toolCalls: [],
        responsePreview: '',
      };
      const runCtx: any = {
        cwd: ws,
        session: { abort: () => {} },
        snapshot,
        recordDiagnostics: false,
        toolOutcomeByCallId: new Map(),
        queueController: { clearForRestore: () => null, reset: () => {}, hasPending: () => false },
        userSteeredNotes: [],
        pendingRestoredDraft: null,
        restoredDraftEmitted: false,
        emitQueueUpdate: () => {},
        lastPersistAtMs: 0,
        finalized: false,
        callsSinceProgress: 0,
        lastStallTurnKey: undefined,
        lastSoftStallRemindAt: 0,
        callsSinceDeliverable: 0,
        lastNoDeliverableRemindAt: 0,
        compactionsSinceDeliverable: 0,
        knownEngineHintDetected: false,
        recallFirstNoticed: false,
        recallLoggedInRun: false,
        tmpTextReadCount: 0,
        scratchScriptPaths: new Set(),
        deliveredSkillOrScript: false,
        finalize: (status: SubagentTaskSnapshot['status'], activityState: SubagentTaskSnapshot['activityState'], err?: string) => {
          if (runCtx.finalized) return;
          runCtx.finalized = true;
          snapshot.status = status;
          snapshot.activityState = activityState;
          if (err) snapshot.error = err;
        },
      };

      const wrapStub = (name: string, impl?: (params: any) => string) =>
        (mgr as any).wrapSubagentTool(
          ws,
          {
            name,
            label: name,
            description: `stub ${name}`,
            parameters: {},
            execute: async (_id: string, params: any) => ({
              content: [{ type: 'text', text: impl ? impl(params) : `${name} ok` }],
            }),
          },
          () => runCtx
        );

      const getResultText = (res: any): string =>
        Array.isArray(res?.content)
          ? res.content
              .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
              .map((p: any) => p.text)
              .join('\n')
          : '';

      const vnDetect = wrapStub('vn_detect', () => 'unknown  .pck  Scene.pck\nhint  siglus (SiglusEngine)  confidence=high');
      const writeTool = wrapStub('write', (p) => `wrote ${p.path}`);
      const editTool = wrapStub('edit', (p) => `edited ${p.path}`);
      const lsTool = wrapStub('ls', () => 'Scene.pck');

      // Call 1: vn_detect reports `hint siglus`
      await vnDetect.execute('c-1', {}, undefined, undefined, {});
      assert.equal(runCtx.knownEngineHintDetected, true);
      assert.equal(runCtx.callsSinceDeliverable, 1);

      // Call 2: first probe script write triggers [阶段提醒 / RECALL-FIRST] once
      const probeWrite1 = await writeTool.execute('c-2', { path: '.papercup/tmp/siglus/probe.py' }, undefined, undefined, {});
      const probeText1 = getResultText(probeWrite1);
      assert.ok(probeText1.includes('[阶段提醒 / RECALL-FIRST]'), `Expected RECALL-FIRST on first probe write, got:\n${probeText1}`);
      assert.equal(runCtx.recallFirstNoticed, true);
      assert.equal(runCtx.callsSinceDeliverable, 2);

      // Call 3: editing probe.py does NOT repeat [阶段提醒 / RECALL-FIRST]
      const probeEdit2 = await editTool.execute('c-3', { path: '.papercup/tmp/siglus/probe.py' }, undefined, undefined, {});
      assert.equal(getResultText(probeEdit2).includes('[阶段提醒 / RECALL-FIRST]'), false);
      assert.equal(runCtx.callsSinceDeliverable, 3);

      // Calls 4..29: writing 02-hypotheses.md & ls do NOT reset callsSinceDeliverable
      for (let i = 4; i <= 29; i += 1) {
        const res =
          i % 2 === 0
            ? await writeTool.execute(`c-${i}`, { path: '.papercup/research/siglus/02-hypotheses.md' }, undefined, undefined, {})
            : await lsTool.execute(`c-${i}`, { path: '.' }, undefined, undefined, {});
        assert.equal(getResultText(res).includes('[进展纠偏 / NO-DELIVERABLE]'), false);
        assert.equal(runCtx.callsSinceDeliverable, i);
      }

      // Call 30: triggers [进展纠偏 / NO-DELIVERABLE]
      const call30 = await lsTool.execute('c-30', { path: '.' }, undefined, undefined, {});
      const text30 = getResultText(call30);
      assert.equal(runCtx.callsSinceDeliverable, 30);
      assert.ok(text30.includes('[进展纠偏 / NO-DELIVERABLE]'), `Expected NO-DELIVERABLE at call 30, got:\n${text30}`);

      // Writing real deliverable extract.py resets callsSinceDeliverable & compactionsSinceDeliverable to 0
      runCtx.compactionsSinceDeliverable = 1;
      await writeTool.execute('c-31', { path: '.papercup/tmp/siglus/extract.py' }, undefined, undefined, {});
      assert.equal(runCtx.callsSinceDeliverable, 0);
      assert.equal(runCtx.compactionsSinceDeliverable, 0);
      assert.equal(runCtx.deliveredSkillOrScript, true);

      // Also verify hasResearchRecallHypotheses reads real file on disk
      const hypDir = path.join(ws, '.papercup', 'research', 'siglus');
      fs.mkdirSync(hypDir, { recursive: true });
      fs.writeFileSync(path.join(hypDir, '02-hypotheses.md'), '# Recalled\n', 'utf8');
      assert.equal(hasResearchRecallHypotheses(ws), true);
    });

    // 3. createFauxCore L2 compaction circuit breaker (limit=2 vs 0) and max_reverser_tokens cap
    const savedCompactEnv = {
      reverserCompact: process.env.PAPERCUP_REVERSER_COMPACT_TOKENS,
      keepRecent: process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS,
      pruneMinReclaim: process.env.PAPERCUP_COMPACT_PRUNE_MIN_RECLAIM_TOKENS,
      maxTokens: process.env.PAPERCUP_REVERSER_MAX_TOKENS,
      maxNoDelivCompactions: process.env.PAPERCUP_REVERSER_MAX_NO_DELIVERABLE_COMPACTIONS,
    };
    delete process.env.PAPERCUP_REVERSER_MAX_TOKENS;
    delete process.env.PAPERCUP_REVERSER_MAX_NO_DELIVERABLE_COMPACTIONS;

    try {
      process.env.PAPERCUP_REVERSER_COMPACT_TOKENS = '4096';
      process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS = '1024';
      process.env.PAPERCUP_COMPACT_PRUNE_MIN_RECLAIM_TOKENS = '999999';

      const setupFauxMgr = (ws: string) => {
        const mgr = new SubagentManager();
        const faux = createFauxCore({
          provider: 'faux-reverser-guard',
          tokensPerSecond: 100000,
          models: [{ id: 'rev-guard-8k', reasoning: false, contextWindow: 8192 }],
        });
        const origCreate = mgr.createSubagentSession.bind(mgr);
        mgr.createSubagentSession = async (roleName, opts) => {
          const res = await origCreate(roleName, opts);
          (res.session as any).agent.state.model = faux.getModel();
          (res.session as any).agent.streamFunction = faux.streamSimple;
          (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
          return res;
        };
        const snapshots: SubagentTaskSnapshot[] = [];
        const tools = mgr.createTools(
          () => ws,
          undefined,
          () => faux.getModel(),
          undefined,
          undefined,
          { onTaskUpdated: (_s, snap) => snapshots.push(snap) }
        );
        const delegateTask = tools.find((t) => t.name === 'delegate_task')!;
        return { mgr, faux, delegateTask, snapshots };
      };

      // 3a. max_reverser_no_deliverable_compactions = 2 -> warns on 1st compaction, aborts gracefully (resumable=true) on 2nd
      await withTempWorkspace(async ({ ws }) => {
        fs.writeFileSync(
          path.join(ws, 'papercup.toml'),
          '[vn.research]\nmax_reverser_no_deliverable_compactions = 2\n',
          'utf8'
        );
        const { mgr, faux, delegateTask, snapshots } = setupFauxMgr(ws);
        try {
          const bigPayloadA = '# ' + 'A'.repeat(10_000) + '\n';
          const bigPayloadB = '# ' + 'B'.repeat(10_000) + '\n';
          const bigPayloadC = '# ' + 'C'.repeat(18_000) + '\n';
          faux.setResponses([
            () => fauxAssistantMessage([fauxToolCall('write', { path: '.papercup/tmp/x/probe1.py', content: bigPayloadA }, { id: 'c-1' })]),
            () => fauxAssistantMessage([fauxToolCall('write', { path: '.papercup/tmp/x/probe2.py', content: bigPayloadB }, { id: 'c-2' })]),
            // L2 Compaction #1 summary
            () => fauxAssistantMessage('## Compaction 1\n- [layer: raw] still probing'),
            () => fauxAssistantMessage([fauxToolCall('write', { path: '.papercup/tmp/x/probe3.py', content: bigPayloadC }, { id: 'c-3' })]),
            // L2 Compaction #2 summary -> triggers breaker & aborts Turn 4
            () => fauxAssistantMessage('## Compaction 2\n- [layer: raw] still no deliverable'),
            () => fauxAssistantMessage('should never complete after 2nd no-deliverable compaction'),
          ]);

          const res: any = await delegateTask.execute(
            'dt-compact-breaker-2',
            { role: 'reverser', task: 'Analyze unknown pack without deliverable' },
            undefined,
            undefined,
            {} as any
          );
          const outText = (res?.content ?? []).map((p: any) => p.text).join('\n');
          assert.equal(res.details?.status, 'aborted', `Expected aborted status at 2nd compaction, got:\n${outText}`);
          assert.equal(res.details?.resumable, true, `Expected resumable=true on compaction breaker abort, got:\n${outText}`);
          assert.ok(outText.includes('2 次上下文压缩'), `Expected compaction count message, got:\n${outText}`);
          assert.ok(outText.includes('resumable=true'), `Expected resumable=true in output, got:\n${outText}`);
          assert.ok(
            snapshots.some((s) => s.pivotWarnings.some((w) => w.includes('[压缩熔断预警]'))),
            'Expected [压缩熔断预警] recorded after 1st compaction'
          );
        } finally {
          mgr.disposeResumableSessions(ws);
        }
      });

      // 3b. max_reverser_no_deliverable_compactions = 0 -> disables compaction breaker across >=2 compactions
      await withTempWorkspace(async ({ ws }) => {
        fs.writeFileSync(
          path.join(ws, 'papercup.toml'),
          '[vn.research]\nmax_reverser_no_deliverable_compactions = 0\n',
          'utf8'
        );
        const { mgr, faux, delegateTask, snapshots } = setupFauxMgr(ws);
        try {
          const bigPayloadA = '# ' + 'A'.repeat(10_000) + '\n';
          const bigPayloadB = '# ' + 'B'.repeat(10_000) + '\n';
          const bigPayloadC = '# ' + 'C'.repeat(18_000) + '\n';
          faux.setResponses([
            () => fauxAssistantMessage([fauxToolCall('write', { path: '.papercup/tmp/x/probe1.py', content: bigPayloadA }, { id: 'z-1' })]),
            () => fauxAssistantMessage([fauxToolCall('write', { path: '.papercup/tmp/x/probe2.py', content: bigPayloadB }, { id: 'z-2' })]),
            () => fauxAssistantMessage('## Compaction 1\n- [layer: raw] probing'),
            () => fauxAssistantMessage([fauxToolCall('write', { path: '.papercup/tmp/x/probe3.py', content: bigPayloadC }, { id: 'z-3' })]),
            () => fauxAssistantMessage('## Compaction 2\n- [layer: raw] continuing'),
            () => fauxAssistantMessage('Completed cleanly with compaction breaker disabled.'),
          ]);

          const res: any = await delegateTask.execute(
            'dt-compact-breaker-0',
            { role: 'reverser', task: 'Analyze unknown pack with compaction breaker disabled' },
            undefined,
            undefined,
            {} as any
          );
          const outText = (res?.content ?? []).map((p: any) => p.text).join('\n');
          assert.equal(res.details?.status, 'success', `Expected completion when breaker=0, got:\n${outText}`);
          assert.ok(
            snapshots.some((s) => (s.compactionCount ?? 0) >= 2),
            'Expected >= 2 compactions to occur without tripping breaker when limit=0'
          );
          assert.equal(
            snapshots.some((s) => s.pivotWarnings.some((w) => w.includes('[压缩熔断预警]'))),
            false,
            'Must NOT emit [压缩熔断预警] when max_reverser_no_deliverable_compactions=0'
          );
        } finally {
          mgr.disposeResumableSessions(ws);
        }
      });

      // 3c. max_reverser_tokens threshold -> aborts with status='aborted'
      await withTempWorkspace(async ({ ws }) => {
        fs.writeFileSync(
          path.join(ws, 'papercup.toml'),
          '[vn.research]\nmax_reverser_tokens = 250\n',
          'utf8'
        );
        const { mgr, faux, delegateTask } = setupFauxMgr(ws);
        try {
          faux.setResponses([
            () =>
              fauxAssistantMessage([
                fauxToolCall('write', { path: '.papercup/tmp/x/probe1.py', content: 'x = 1\n'.repeat(300) }, { id: 'tok-1' }),
              ]),
            () => fauxAssistantMessage('should abort before completing turn 2'),
          ]);

          const res: any = await delegateTask.execute(
            'dt-token-cap',
            { role: 'reverser', task: 'Trigger token cap abort' },
            undefined,
            undefined,
            {} as any
          );
          const outText = (res?.content ?? []).map((p: any) => p.text).join('\n');
          assert.equal(res.details?.status, 'aborted', `Expected aborted status on token cap, got:\n${outText}`);
          assert.equal(res.details?.resumable, true);
          assert.ok(outText.includes('累计 Token 已达上限'), `Expected token cap abort reason, got:\n${outText}`);
        } finally {
          mgr.disposeResumableSessions(ws);
        }
      });
    } finally {
      if (savedCompactEnv.reverserCompact === undefined) delete process.env.PAPERCUP_REVERSER_COMPACT_TOKENS;
      else process.env.PAPERCUP_REVERSER_COMPACT_TOKENS = savedCompactEnv.reverserCompact;
      if (savedCompactEnv.keepRecent === undefined) delete process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS;
      else process.env.PAPERCUP_COMPACT_KEEP_RECENT_TOKENS = savedCompactEnv.keepRecent;
      if (savedCompactEnv.pruneMinReclaim === undefined) delete process.env.PAPERCUP_COMPACT_PRUNE_MIN_RECLAIM_TOKENS;
      else process.env.PAPERCUP_COMPACT_PRUNE_MIN_RECLAIM_TOKENS = savedCompactEnv.pruneMinReclaim;
      if (savedCompactEnv.maxTokens === undefined) delete process.env.PAPERCUP_REVERSER_MAX_TOKENS;
      else process.env.PAPERCUP_REVERSER_MAX_TOKENS = savedCompactEnv.maxTokens;
      if (savedCompactEnv.maxNoDelivCompactions === undefined) {
        delete process.env.PAPERCUP_REVERSER_MAX_NO_DELIVERABLE_COMPACTIONS;
      } else {
        process.env.PAPERCUP_REVERSER_MAX_NO_DELIVERABLE_COMPACTIONS = savedCompactEnv.maxNoDelivCompactions;
      }
    }
  });

  it('15.6 Prompt & vn-reverser skill/reference contracts encode 4-stage funnel, 3 tools, <location>, layer invalidation, 4-level ladder, gatekeeper & zero dev traces', () => {
    const revPrompt = BUILTIN_SUBAGENTS.reverser.systemPrompt;
    for (const required of [
      '4-Stage Reverse-Engineering Funnel',
      'Stage 0',
      'Stage 1',
      'Stage 2',
      'Stage 3',
      'vn_re_lookup',
      'vn_re_inspect',
      'vn_re_trace',
      '<location>',
      'Layer-Scoped Epistemic Invalidation',
      '[layer: raw]',
      '[layer: post-xor]',
      '[layer: post-decompress]',
      '[layer: inner-script]',
      'AUTOMATICALLY INVALIDATED',
      '4-Level Pragmatic Repack Ladder',
      'Native loose-file override',
      'literal-only fake-compression',
    ]) {
      assert.ok(revPrompt.includes(required), `reverser systemPrompt missing ${JSON.stringify(required)}`);
    }

    const mainPrompt = PAPERCUP_SYSTEM_PROMPT;
    for (const required of [
      'vn_re_lookup',
      'vn_re_inspect',
      'vn_re_trace',
      '只核对 4 项客观漏洞',
      '① 是否漏调 `vn_re_lookup`',
      '② Windows PE 目标是否漏跑 `vn_re_trace`',
      '③ 是否存在已发现却未跟进的调用链/邻近函数',
      '④ 是否剥离外层后未清零旧层假说并从固定头末尾重测',
    ]) {
      assert.ok(mainPrompt.includes(required), `PAPERCUP_SYSTEM_PROMPT missing ${JSON.stringify(required)}`);
    }

    const skillDir = resolveBuiltinReverserSkillDir();
    assert.ok(skillDir, 'Expected builtin vn-reverser skill directory');
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const peRef = fs.readFileSync(path.join(skillDir, 'references', 'pe-and-disassembly.md'), 'utf8');
    const arcRef = fs.readFileSync(path.join(skillDir, 'references', 'archive-and-codec-triage.md'), 'utf8');

    for (const required of [
      'Fast 4-Stage Funnel',
      'Stage 0',
      'Stage 1',
      'Stage 2',
      'Stage 3',
      'vn_re_lookup',
      'vn_re_inspect',
      'vn_re_trace',
      '<location>',
      'Two-Step Algorithm Transcription',
      '1:1',
      'semi-dynamic',
      'Layer-Scoped Invalidation',
      '[layer: raw]',
      '[layer: post-xor]',
      '[layer: post-decompress]',
      '[layer: inner-script]',
      'AUTOMATICALLY INVALIDATED',
      '4-Level Pragmatic Repack Ladder',
    ]) {
      assert.ok(skillMd.includes(required), `SKILL.md missing ${JSON.stringify(required)}`);
    }

    for (const required of [
      'vn_re_trace',
      'vn_re_inspect',
      'pe_overview',
      'xrefs',
      'disasm',
      'io_trace',
      'read_watch',
      'DR0',
      'Two-Step Algorithm Transcription',
      '1:1',
      '0x81–0x9F',
      '0xE0–0xEF',
      '0x40–0xFC',
      'Semi-Dynamic',
      'CreateFontIndirectA/W',
      'EnumFontFamiliesExA/W',
      'GetACP',
      'GetSystemDefaultLCID',
      'IsDBCSLeadByte',
      'IsDBCSLeadByteEx',
      'VA = ImageBase + RVA',
      'Consumer-Side Addressing Proof',
    ]) {
      assert.ok(peRef.includes(required), `pe-and-disassembly.md missing ${JSON.stringify(required)}`);
    }

    for (const required of [
      'vn_re_inspect(action="archive")',
      'Layer-Scoped Invalidation',
      '[layer: raw]',
      '[layer: post-xor]',
      '[layer: post-decompress]',
      'len(decompressed) == declared_usize',
      'Pragmatic Repack Ladder',
      'Hash-indexed',
      'semi-dynamic',
    ]) {
      assert.ok(arcRef.includes(required), `archive-and-codec-triage.md missing ${JSON.stringify(required)}`);
    }

    const forbiddenDevTraces = ['AGENTS.md', 'TODO.md', 'change/', '.github/', 'export-public.mjs', 'CODEX_HANDOFF.md'];
    for (const [docName, docBody] of [
      ['SKILL.md', skillMd],
      ['pe-and-disassembly.md', peRef],
      ['archive-and-codec-triage.md', arcRef],
    ] as const) {
      for (const forbidden of forbiddenDevTraces) {
        assert.equal(
          docBody.includes(forbidden),
          false,
          `${docName} must NOT leak private dev-trace ${JSON.stringify(forbidden)}`
        );
      }
    }
  });

  it('15.7 vn_re_lookup tree/search/fetch enhancements, formatTraceOutput + re_trace helpers & re_inspect xrefs/disasm edge cases', async () => {
    await withTempWorkspace(async ({ ws }) => {
      // 1. vn_re_lookup enhancements: >64KB tree JSON, multi-token filtering, master->main 404 fallback, search w/ repo & qualifier stripping + 2-token retry
      const savedLookupEnv = process.env.PAPERCUP_RE_LOOKUP_ENABLED;
      process.env.PAPERCUP_RE_LOOKUP_ENABLED = 'true';
      try {
        const bigTreeNodes = [
          { type: 'blob', path: 'ArcFormats/Siglus/ArcPCK.cs' },
          { type: 'blob', path: 'ArcFormats/Siglus/ImageNWA.cs' },
          { type: 'blob', path: 'ArcFormats/BGI/ArcARC.cs' },
        ];
        for (let i = 0; i < 2400; i += 1) {
          bigTreeNodes.push({
            type: 'blob',
            path: `Misc/Generated/PaddingDirectory/AssetEntry_${String(i).padStart(4, '0')}.cs`,
          });
        }
        const bigTreeBody = JSON.stringify({ truncated: false, tree: bigTreeNodes });
        assert.ok(
          Buffer.byteLength(bigTreeBody, 'utf8') > 128 * 1024,
          `Expected synthetic tree JSON > 128 KB, got ${Buffer.byteLength(bigTreeBody, 'utf8')}`
        );

        const searchQueriesSeen: string[] = [];
        const fetchedUrlsSeen: string[] = [];
        const mockFetch: typeof fetch = async (input) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          fetchedUrlsSeen.push(url);

          if (url === 'https://api.github.com/repos/morkt/GARbro') {
            return new Response(JSON.stringify({ default_branch: 'master' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url === 'https://api.github.com/repos/morkt/GARbro/git/trees/master?recursive=1') {
            return new Response('Not Found', { status: 404 });
          }
          if (url === 'https://api.github.com/repos/morkt/GARbro/git/trees/main?recursive=1') {
            return new Response(bigTreeBody, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.startsWith('https://api.github.com/search/repositories?')) {
            const parsed = new URL(url);
            const qParam = parsed.searchParams.get('q') || '';
            searchQueriesSeen.push(qParam);
            if (qParam === 'SiglusEngine.cs siglus') {
              return new Response(
                JSON.stringify({
                  items: [
                    {
                      full_name: 'example/siglus-re',
                      stargazers_count: 12,
                      default_branch: 'main',
                      description: 'Siglus unpacker reference',
                    },
                  ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
              );
            }
            return new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url === 'https://raw.githubusercontent.com/morkt/GARbro/master/README.md') {
            return new Response('Not Found', { status: 404 });
          }
          if (url === 'https://raw.githubusercontent.com/morkt/GARbro/main/README.md') {
            const line = Buffer.from('M'.repeat(1023) + '\n', 'utf8');
            let count = 0;
            const stream = new ReadableStream<Uint8Array>({
              pull(controller) {
                if (count >= 90) {
                  controller.close();
                  return;
                }
                count += 1;
                controller.enqueue(line);
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            });
          }
          return new Response('Not Found', { status: 404 });
        };

        const tools = createReverserTools(() => ws, { fetchImpl: mockFetch });
        const lookupTool = tools.find((t) => t.name === 'vn_re_lookup')!;
        const inspectTool = tools.find((t) => t.name === 'vn_re_inspect')!;
        const getText = (res: any): string =>
          Array.isArray(res?.content)
            ? res.content
                .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
                .map((p: any) => p.text)
                .join('\n')
            : '';

        // 1a. tree: >128 KB JSON + master->main 404 fallback + multi-token AND filtering
        const treeAndRes: any = await lookupTool.execute(
          '15-7-tree-and',
          { action: 'tree', repo: 'morkt/GARbro', query: 'siglus pck' },
          undefined,
          undefined,
          {} as any
        );
        const treeAndText = getText(treeAndRes);
        assert.notEqual(treeAndRes.isError, true, `Expected >128KB tree lookup to succeed, got:\n${treeAndText}`);
        assert.ok(treeAndText.includes('[tree] morkt/GARbro@main matched=1'));
        assert.ok(treeAndText.includes('ArcFormats/Siglus/ArcPCK.cs'));
        assert.equal(treeAndText.includes('ImageNWA.cs'), false);

        // 1b. tree: multi-token OR fallback when AND match is empty
        const treeOrRes: any = await lookupTool.execute(
          '15-7-tree-or',
          { action: 'tree', repo: 'morkt/GARbro', query: 'siglus nonexistent_token_xyz' },
          undefined,
          undefined,
          {} as any
        );
        const treeOrText = getText(treeOrRes);
        assert.notEqual(treeOrRes.isError, true);
        assert.ok(treeOrText.includes('[tree] morkt/GARbro@main matched=2'));
        assert.ok(treeOrText.includes('ArcFormats/Siglus/ArcPCK.cs'));
        assert.ok(treeOrText.includes('ArcFormats/Siglus/ImageNWA.cs'));

        // 1c. search with repo parameter delegates directly to tree filtering (no /search/repositories call)
        const searchCountBeforeRepo = searchQueriesSeen.length;
        const searchRepoRes: any = await lookupTool.execute(
          '15-7-search-repo',
          { action: 'search', repo: 'morkt/GARbro', query: 'siglus pck' },
          undefined,
          undefined,
          {} as any
        );
        const searchRepoText = getText(searchRepoRes);
        assert.notEqual(searchRepoRes.isError, true);
        assert.equal(searchQueriesSeen.length, searchCountBeforeRepo);
        assert.ok(searchRepoText.includes('Curated VN RE repositories:'));
        assert.ok(searchRepoText.includes('[tree] morkt/GARbro@main matched=1'));
        assert.ok(searchRepoText.includes('ArcFormats/Siglus/ArcPCK.cs'));
        assert.ok(searchRepoText.includes('[参考约束]'));

        // 1d. search strips filename:/path:/in:file qualifiers and retries first 2 tokens on 0 items
        const searchQualRes: any = await lookupTool.execute(
          '15-7-search-retry',
          { action: 'search', query: 'filename:SiglusEngine.cs siglus in:file pck unpacker' },
          undefined,
          undefined,
          {} as any
        );
        const searchQualText = getText(searchQualRes);
        assert.notEqual(searchQualRes.isError, true);
        assert.deepEqual(searchQueriesSeen, ['SiglusEngine.cs siglus pck unpacker', 'SiglusEngine.cs siglus']);
        assert.ok(searchQualText.includes('example/siglus-re'));
        assert.ok(searchQualText.includes('[参考约束]'));

        // 1e. fetch without explicit branch falls back master (404) -> main (200) while honoring 64 KB cap
        const fetchFallbackRes: any = await lookupTool.execute(
          '15-7-fetch-main',
          { action: 'fetch', repo: 'morkt/GARbro', path: 'README.md', startLine: 1, maxLines: 200 },
          undefined,
          undefined,
          {} as any
        );
        const fetchFallbackText = getText(fetchFallbackRes);
        assert.notEqual(fetchFallbackRes.isError, true);
        assert.ok(fetchFallbackText.includes('[fetch] https://raw.githubusercontent.com/morkt/GARbro/main/README.md'));
        assert.ok(fetchedUrlsSeen.includes('https://raw.githubusercontent.com/morkt/GARbro/master/README.md'));
        assert.ok(fetchedUrlsSeen.includes('https://raw.githubusercontent.com/morkt/GARbro/main/README.md'));
        const fetchedLines = fetchFallbackText.split(/\r?\n/).filter((ln) => /^\d+:\s/.test(ln));
        assert.ok(fetchedLines.length <= 65, `Expected 64 KB cap (~64 lines), got ${fetchedLines.length}`);

        // 2. formatTraceOutput rendering & re_trace.py Python helper checks
        const syntheticTrace = {
          ok: true,
          supported: true,
          mode: 'read_watch',
          arch: 'x86',
          stop_reason: 'hit_limit',
          main_image_base: '0x1200000',
          preferred_image_base: '0x400000',
          hooked_apis: ['CreateFileW', 'ReadFile'],
          loose_file_probes: [
            {
              api: 'CreateFileW',
              path: 'Scene.pck',
              callers_va: ['0x1210000'],
              callers_static_va: ['0x410000'],
            },
          ],
          io_events: [
            {
              api: 'ReadFile',
              path: 'Scene.pck',
              file_offset: 0,
              actual_read: 64,
              requested: 64,
              buf_addr: '0x2000000',
              head_hex: 'aabbccdd',
              callers_va: ['0x1210020'],
              callers_static_va: ['0x410020'],
            },
          ],
          read_watch: {
            armed: true,
            file: 'Scene.pck',
            read_offset: 0,
            watch_addr: '0x2000000',
            before_hex: '00112233',
            prev16_before_hex: 'deadbeef',
            hits: [
              {
                insn_va: '0x1220000',
                static_va: '0x420000',
                module: 'Game.exe',
                rva: '0x20000',
                in_main_exe: true,
                changed_from_read: true,
                regs: { eax: '0x1', ecx: '0x2000000' },
                callers_va: ['0x1230000'],
                callers_static_va: ['0x430000'],
                prev16_hex: 'cafebabe',
                after_hex: '44556677',
              },
            ],
          },
        };
        const formattedTrace = formatTraceOutput(JSON.stringify(syntheticTrace));
        assert.equal(formattedTrace.isError, false);
        for (const expected of [
          'preferredBase=0x400000',
          'staticVA=0x420000',
          'regs={eax=0x1 ecx=0x2000000}',
          'prev16=cafebabe',
          'prev16_before: deadbeef',
          'timing_note:',
          'callers=[0x410000]',
          'callers=[0x410020]',
          'callers=[0x430000]',
        ]) {
          assert.ok(
            formattedTrace.text.includes(expected),
            `formatTraceOutput missing ${JSON.stringify(expected)} in:\n${formattedTrace.text}`
          );
        }

        // Build minimal synthetic PE32 (ImageBase=0x400000, .text filled with 0xFF at VA 0x401000) and PE32+ (ImageBase=0x140000000)
        const buildMinimalPe = (is64: boolean): Buffer => {
          const buf = Buffer.alloc(0x400, 0);
          buf.write('MZ', 0, 'ascii');
          buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
          buf.write('PE\0\0', 0x80, 'ascii');
          const coffOff = 0x84;
          buf.writeUInt16LE(is64 ? 0x8664 : 0x014c, coffOff + 0); // Machine
          buf.writeUInt16LE(1, coffOff + 2); // NumberOfSections
          const optSize = is64 ? 0xf0 : 0xe0;
          buf.writeUInt16LE(optSize, coffOff + 16); // SizeOfOptionalHeader
          buf.writeUInt16LE(is64 ? 0x0022 : 0x0102, coffOff + 18); // Characteristics

          const optOff = coffOff + 20;
          buf.writeUInt16LE(is64 ? 0x020b : 0x010b, optOff + 0); // Magic
          buf.writeUInt32LE(0x1000, optOff + 16); // AddressOfEntryPoint
          if (is64) {
            buf.writeBigUInt64LE(0x140000000n, optOff + 24);
          } else {
            buf.writeUInt32LE(0x00400000, optOff + 28);
          }
          buf.writeUInt32LE(0x1000, optOff + 32); // SectionAlignment
          buf.writeUInt32LE(0x0200, optOff + 36); // FileAlignment
          buf.writeUInt16LE(6, optOff + 40); // MajorOperatingSystemVersion
          buf.writeUInt16LE(6, optOff + 48); // MajorSubsystemVersion
          buf.writeUInt32LE(0x2000, optOff + 56); // SizeOfImage
          buf.writeUInt32LE(0x0200, optOff + 60); // SizeOfHeaders
          buf.writeUInt16LE(2, optOff + 68); // Subsystem (GUI)
          buf.writeUInt32LE(16, optOff + (is64 ? 108 : 92)); // NumberOfRvaAndSizes

          const secOff = optOff + optSize;
          buf.write('.text\0\0\0', secOff + 0, 'ascii');
          buf.writeUInt32LE(0x0200, secOff + 8); // VirtualSize
          buf.writeUInt32LE(0x1000, secOff + 12); // VirtualAddress
          buf.writeUInt32LE(0x0200, secOff + 16); // SizeOfRawData
          buf.writeUInt32LE(0x0200, secOff + 20); // PointerToRawData
          buf.writeUInt32LE(0x60000020, secOff + 36); // IMAGE_SCN_MEM_EXECUTE | CNT_CODE | MEM_READ

          // Fill .text with 0xFF invalid opcodes for x86 disasm edge test
          buf.fill(0xff, 0x200, 0x400);
          return buf;
        };

        const pe32Path = path.join(ws, 'Game32.exe');
        const pe64Path = path.join(ws, 'Game64.exe');
        fs.writeFileSync(pe32Path, buildMinimalPe(false));
        fs.writeFileSync(pe64Path, buildMinimalPe(true));

        const skillDir = resolveBuiltinReverserSkillDir();
        assert.ok(skillDir, 'Expected builtin vn-reverser skillDir');
        const scriptsDir = path.join(skillDir, 'scripts');

        const pyCheck = [
          'import sys',
          'sys.path.insert(0, sys.argv[1])',
          'import re_trace',
          'assert re_trace.read_pe_preferred_image_base(sys.argv[2]) == 0x400000',
          'assert re_trace.read_pe_preferred_image_base(sys.argv[3]) == 0x140000000',
          'assert re_trace.is_os_noise_path(r"C:\\Windows\\System32\\kernel32.dll") is True',
          'assert re_trace.is_os_noise_path(r"C:\\ProgramData\\cache.dat") is True',
          'assert re_trace.is_os_noise_path("fonts/msgothic.ttc") is True',
          'assert re_trace.is_os_noise_path(r"C:\\Games\\VN\\Scene.pck") is False',
          'assert re_trace.is_os_noise_path("Gameexe.dat") is False',
          'assert re_trace.is_call_preceding_bytes(b"\\x90\\x90\\xe8\\x10\\x00\\x00\\x00", False) is True',
          'assert re_trace.is_call_preceding_bytes(b"\\x90\\x90\\x90\\x90\\x90\\xff\\xd0", False) is True',
          'assert re_trace.is_call_preceding_bytes(b"\\x90\\xff\\x15\\x00\\x10\\x40\\x00", False) is True',
          'assert re_trace.is_call_preceding_bytes(b"\\x48\\xff\\x15\\x00\\x10\\x00\\x00", True) is True',
          'assert re_trace.is_call_preceding_bytes(b"\\\\\\x00W\\x00I\\x00N", False) is False',
          'assert re_trace.is_call_preceding_bytes(b"\\x6a\\x00\\x00\\x01\\x00\\x00\\x00", False) is False',
          'print("RE_TRACE_HELPERS_OK")',
        ].join('; ');
        const pyOut = execFileSync(config.pythonPath, ['-c', pyCheck, scriptsDir, pe32Path, pe64Path], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.ok(pyOut.includes('RE_TRACE_HELPERS_OK'), `Unexpected python helper check output: ${pyOut}`);

        // 3. vn_re_inspect xrefs & disasm edge cases against synthetic PE32
        const xrefsRes: any = await inspectTool.execute(
          '15-7-xrefs-empty',
          { action: 'xrefs', path: 'Game32.exe', string: 'NONEXISTENT_STR' },
          undefined,
          undefined,
          {} as any
        );
        const xrefsText = getText(xrefsRes);
        assert.notEqual(xrefsRes.isError, true, `Expected xrefs to succeed cleanly, got:\n${xrefsText}`);
        assert.ok(xrefsText.includes('arch=x86'), `Expected arch=x86 in xrefs output, got:\n${xrefsText}`);
        assert.equal(xrefsText.includes('arch=undefined'), false, `Must NOT emit arch=undefined:\n${xrefsText}`);

        const disasmRes: any = await inspectTool.execute(
          '15-7-disasm-invalid',
          { action: 'disasm', path: 'Game32.exe', va: '0x401000' },
          undefined,
          undefined,
          {} as any
        );
        const disasmText = getText(disasmRes);
        assert.notEqual(disasmRes.isError, true, `Expected disasm on invalid bytes to succeed with note, got:\n${disasmText}`);
        assert.ok(disasmText.includes('arch=x86') && disasmText.includes('count=0'), `Expected count=0 in:\n${disasmText}`);
        assert.ok(disasmText.includes('raw_head_hex: ffffffffffffffff'), `Expected raw_head_hex in:\n${disasmText}`);
        assert.ok(disasmText.includes('note:'), `Expected note: in:\n${disasmText}`);
      } finally {
        if (savedLookupEnv === undefined) delete process.env.PAPERCUP_RE_LOOKUP_ENABLED;
        else process.env.PAPERCUP_RE_LOOKUP_ENABLED = savedLookupEnv;
      }
    });
  });

  it('15.8 Model context-window inference from model ID & compactionCheckpoint handoff contracts', async () => {
    // 1. inferContextWindowFromModelId positive & negative cases
    assert.equal(inferContextWindowFromModelId('cursor/grok-4.7@500k'), 500_000);
    assert.equal(inferContextWindowFromModelId('claude-sonnet-4-1m'), 1_000_000);
    assert.equal(inferContextWindowFromModelId('moonshot-v1-128k'), 128_000);
    for (const neg of [
      'minimax-m2',
      'kimi-k2.5',
      'qwen3-235b-a22b',
      'gpt-4o-mini',
      'gemini-2.5-pro',
      'seedream-4k',
    ]) {
      assert.equal(
        inferContextWindowFromModelId(neg),
        undefined,
        `Expected inferContextWindowFromModelId(${JSON.stringify(neg)}) === undefined`
      );
    }

    // 2. discoverProviderAndModels + extractModelContextWindow + computeCompactionThresholds
    const mockGatewayFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-pro@500k',
                displayName: 'Gemini 2.5 Pro 500K',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            { id: 'cursor/grok-4.7@500k' },
            { id: 'cursor/grok-4.7@500k-override', context_length: 262144 },
            { id: 'custom-size-model', limits: { context: 200000 } },
            { id: 'custom-max-ctx-tokens', max_context_tokens: 300000 },
            { id: 'custom-ctx-size', context_size: 400000 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const discovery = await discoverProviderAndModels({
      requestedProvider: 'magpie',
      apiKey: 'magpie',
      fetchImpl: mockGatewayFetch,
    });
    assert.ok(Array.isArray(discovery.liveModels));
    const byId = new Map(discovery.liveModels!.map((m) => [m.id, m]));
    assert.equal(byId.get('cursor/grok-4.7@500k')?.contextWindow, 500_000);
    assert.equal(byId.get('cursor/grok-4.7@500k-override')?.contextWindow, 262_144);
    assert.equal(byId.get('custom-size-model')?.contextWindow, 200_000);
    assert.equal(byId.get('custom-max-ctx-tokens')?.contextWindow, 300_000);
    assert.equal(byId.get('custom-ctx-size')?.contextWindow, 400_000);

    assert.equal(computeCompactionThresholds(500_000, 'reverser').triggerTokens, 180_000);
    assert.equal(computeCompactionThresholds(500_000, 'main').triggerTokens, 200_000);

    // 3. AgentService applies 500_000 (not 131_072 fallback) for magpie & google synthesized dynamic models
    await withTempWorkspace(async ({ ws }) => {
      const svcMagpie = new AgentService(ws, { sessionMode: 'memory', probeFetch: mockGatewayFetch });
      try {
        await svcMagpie.setProviderApiKey('magpie', 'magpie', undefined, {
          baseUrl: 'http://127.0.0.1:19999/v1',
        });
        const runtime = (svcMagpie as any).sharedModelRuntime;
        assert.equal(runtime?.getModel('magpie', 'cursor/grok-4.7@500k')?.contextWindow, 500_000);
        assert.equal(runtime?.getModel('magpie', 'cursor/grok-4.7@500k-override')?.contextWindow, 262_144);
        assert.equal(runtime?.getModel('magpie', 'custom-size-model')?.contextWindow, 200_000);
      } finally {
        (svcMagpie as any).disposeCurrentSessionState?.(true);
      }
    });

    await withTempWorkspace(async ({ ws }) => {
      const svcGoogle = new AgentService(ws, { sessionMode: 'memory', probeFetch: mockGatewayFetch });
      try {
        await svcGoogle.setProviderApiKey('google', 'AIzaSyOfflineDummyKey123456');
        const runtime = (svcGoogle as any).sharedModelRuntime;
        const available: any[] = (svcGoogle as any).getAvailableModels(runtime);
        const synthesized = available.find((m) => m.provider === 'google' && m.id === 'gemini-2.5-pro@500k');
        assert.ok(synthesized, 'Expected synthesized google/gemini-2.5-pro@500k model');
        assert.equal(synthesized.contextWindow, 500_000);
      } finally {
        (svcGoogle as any).disposeCurrentSessionState?.(true);
      }
    });

    // 4. findLatestCompactionCheckpointPath, formatSubagentFailureText & PAPERCUP_SYSTEM_PROMPT handoff guard
    const nowIso = new Date().toISOString();
    const olderCkpt = '.papercup/tmp/diagnostics/compactions/ckpt-001.md';
    const newerCkpt = '.papercup/tmp/diagnostics/compactions/ckpt-002.md';
    const snap: SubagentTaskSnapshot = {
      taskId: 'task-1',
      sessionId: 'sess-15-8',
      role: 'reverser',
      model: 'magpie/cursor/grok-4.7@500k',
      thinkingLevel: 'max',
      status: 'aborted',
      interruptKind: 'aborted',
      activityState: 'aborted',
      stage: 'inspect',
      startedAt: nowIso,
      lastActivityAt: nowIso,
      lastProgressAt: null,
      lastProgressSummary: null,
      durationMs: 1200,
      toolCallCount: 4,
      errorCount: 0,
      artifactsCount: 1,
      consecutiveHypothesisFailures: 0,
      pivotWarningCount: 1,
      taskSummary: 'reverse archive',
      taskPrompt: 'reverse archive',
      maxConsecutiveFailures: 3,
      artifacts: ['.papercup/research/demo/01-layout.md'],
      pivotWarnings: [],
      retryCount: 0,
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 },
      toolCalls: [],
      responsePreview: 'verified lzss oracle in compaction',
      messages: [
        {
          id: 'c-old',
          role: 'compaction',
          content: 'older summary',
          timestamp: nowIso,
          compaction: {
            reason: 'threshold',
            tokensBefore: 180_000,
            tokensAfter: 12_000,
            checkpointPath: `  ${olderCkpt}  `,
          },
        },
        {
          id: 'u-mid',
          role: 'user',
          content: 'continue',
          timestamp: nowIso,
        },
        {
          id: 'c-new',
          role: 'compaction',
          content: 'newer summary',
          timestamp: nowIso,
          compaction: {
            reason: 'threshold',
            tokensBefore: 180_000,
            tokensAfter: 14_000,
            checkpointPath: `  ${newerCkpt}  `,
          },
        },
      ],
    };

    assert.equal(findLatestCompactionCheckpointPath(snap), newerCkpt);
    const failureText = formatSubagentFailureText(
      'reverser',
      'aborted',
      'aborted',
      'Reverser 单轮已历经 3 次上下文压缩...',
      'task-1',
      snap,
      true
    );
    assert.ok(
      failureText.includes(`compactionCheckpoint=${newerCkpt}`),
      `Expected compactionCheckpoint=${newerCkpt} in:\n${failureText}`
    );
    assert.ok(failureText.includes('checkpointNote='), `Expected checkpointNote= in:\n${failureText}`);

    assert.ok(
      PAPERCUP_SYSTEM_PROMPT.includes('compactionCheckpoint') &&
        PAPERCUP_SYSTEM_PROMPT.includes('核对时必须一并读取该最新压缩快照') &&
        PAPERCUP_SYSTEM_PROMPT.includes('严禁用可能滞后的 `.papercup/research/` 旧笔记锁死续跑指令'),
      'PAPERCUP_SYSTEM_PROMPT must enforce reading compactionCheckpoint and forbidding stale .papercup/research/ overrides'
    );
  });
});

describe('16. Pre-Translate Custom-Skill Smoke Gate, Reasoning=Off Fallback & Translator Streaming Observability', () => {
  it('16.1 enforces pre-translate 1-line probe for custom skill pipeline, verifies sandbox micro-edit without touching results/unpacked, and re-blocks on skillDigest mismatch', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-Hans"',
          '',
          '[vn.smoke]',
          'enabled = true',
          'vision_enabled = false',
        ].join('\n') + '\n',
        'utf8'
      );

      const scriptRaw = encodeText(
        'アリス\t「おはようございます！」\r\nアリス\t今日もいい天気ですね。\r\n\tセーブ\r\n',
        'cp932'
      );
      const sampleBin = Buffer.concat([Buffer.from('CTK1', 'ascii'), scriptRaw]);
      fs.writeFileSync(path.join(ws, 'data.ctk'), sampleBin);
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));

      const unpackPy = [
        'import os, sys',
        'raw = open(sys.argv[1], "rb").read()',
        'assert raw[:4] == b"CTK1"',
        'os.makedirs(sys.argv[2], exist_ok=True)',
        'open(os.path.join(sys.argv[2], "s.txt"), "wb").write(raw[4:])',
      ].join('\n') + '\n';
      const repackPy = [
        'import os, sys',
        'data = open(os.path.join(sys.argv[1], "s.txt"), "rb").read()',
        'open(sys.argv[2], "wb").write(b"CTK1" + data)',
      ].join('\n') + '\n';
      const extractPy = [
        'import json, pathlib, sys',
        'root = pathlib.Path(sys.argv[1])',
        'rows = []',
        'for p in sorted(root.rglob("s.txt")):',
        '    rel = p.relative_to(root).as_posix()',
        '    lines = p.read_bytes().decode("cp932").splitlines()',
        '    for i, l in enumerate(lines, 1):',
        '        if not l.strip(): continue',
        '        if "\\t" in l:',
        '            spk, text = l.split("\\t", 1)',
        '            rec = {"id": f"{rel}#r{i}", "file": rel, "line": i, "kind": "say" if spk else "system", "source": text}',
        '            if spk: rec["speaker"] = spk',
        '        else:',
        '            rec = {"id": f"{rel}#r{i}", "file": rel, "line": i, "kind": "say", "source": l}',
        '        rows.append(rec)',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    for rec in rows:',
        '        f.write(json.dumps(rec, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, sys',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING", "cp932")',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'by_file = {}',
        'for r in rows:',
        '    rel = r.get("file") or "s.txt"',
        '    by_file.setdefault(rel, {})[int(r["line"])] = str(r.get("target") or r["source"])',
        'for rel, by_line in by_file.items():',
        '    target_path = os.path.join(sys.argv[2], rel)',
        '    orig_lines = open(target_path, "rb").read().decode("cp932").splitlines()',
        '    out_lines = []',
        '    for idx, line in enumerate(orig_lines, 1):',
        '        if idx in by_line:',
        '            if "\\t" in line:',
        '                spk, _ = line.split("\\t", 1)',
        '                out_lines.append(f"{spk}\\t{by_line[idx]}")',
        '            else:',
        '                out_lines.append(by_line[idx])',
        '        else:',
        '            out_lines.append(line)',
        '    open(target_path, "wb").write(("\\r\\n".join(out_lines) + "\\r\\n").encode(enc))',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'unpack.py'), unpackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'repack.py'), repackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      const learned = await learnVnSkill(ws, {
        engine: 'ctksmoke',
        archive: 'data.ctk',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
        magicHex: '43544b31',
      });
      assert.equal(learned.status, 'adopted', `Expected skill adoption, got: ${JSON.stringify(learned)}`);

      await unpackVnArchives(ws);
      await classifyVnScripts(ws, {});

      const wsPaths = resolveWorkspacePaths(ws);
      assert.equal(fs.existsSync(wsPaths.buildTrackFile('scenario')), true);
      assert.equal(fs.existsSync(wsPaths.buildTrackFile('ui')), true);
      assert.equal(fs.existsSync(path.join(wsPaths.unpackedDir, 'data', '.skill-manifest.json')), true);

      const rosterMeta = extractCharacterCandidates(ws);
      writeCharacterRoster(ws, {
        schema: 1,
        status: 'locked',
        classifyDigest: rosterMeta.classifyDigest,
        updatedAt: '2026-11-24T00:00:00Z',
        confirmedAt: '2026-11-24T00:00:00Z',
        characters: [
          {
            id: 'ch_alice',
            sourceName: 'アリス',
            targetName: '爱丽丝',
            speakerIds: ['アリス'],
            aliases: [],
            gender: 'female',
            occurrences: 2,
            samples: ['「おはようございます！」'],
          },
        ],
      });

      const profile = loadProfile(ws).profile!;
      assert.ok(profile);
      planVnTranslation(ws, { model: 'deepseek-chat', generateBatches: true });
      assert.equal(fs.existsSync(wsPaths.batchesManifestFile), true);

      // 1) Gate initially blocks on Windows before pre_translate probe passes
      const initialGate = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' });
      assert.equal(initialGate.allowed, false);
      assert.equal(initialGate.skipped, false);
      assert.equal(initialGate.record, null);
      assert.equal(initialGate.activeSkill?.engine, 'ctksmoke');
      assert.equal(initialGate.activeSkill?.pipeline, 'skill');
      assert.ok(initialGate.reason?.includes('preTranslateProbe=true'));

      let translatorSessionsOpened = 0;
      const makeStubTranslatorManager = () =>
        ({
          createManagedSubagentSession: async () => {
            translatorSessionsOpened += 1;
            return {
              prompt: async (promptText: string) => {
                const m = /<batch[^>]*>\n([\s\S]*?)\n<\/batch>/.exec(promptText);
                const rows = (m?.[1] || '')
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .map((l) => JSON.parse(l) as { id: string });
                const text = rows.map((r) => JSON.stringify({ id: r.id, target: `中文_${r.id}` })).join('\n');
                return {
                  taskId: `tr-${translatorSessionsOpened}`,
                  text,
                  metrics: { usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 } },
                };
              },
              dispose: () => {},
            };
          },
          markTaskProgress: () => {},
        }) as unknown as SubagentManager;

      if (process.platform === 'win32') {
        await assert.rejects(
          () => runTranslateBatches({ cwd: ws, subagentManager: makeStubTranslatorManager() }, { checkpointInterval: 0 }),
          /preTranslateProbe=true/
        );
        assert.equal(translatorSessionsOpened, 0, 'runTranslateBatches must block BEFORE opening any translator session');
      }

      // Snapshot unpacked files before running preTranslateProbe
      const unpackedScriptPath = path.join(wsPaths.unpackedDir, 'data', 's.txt');
      const unpackedManifestPath = path.join(wsPaths.unpackedDir, 'data', '.skill-manifest.json');
      const unpackedScriptBefore = fs.readFileSync(unpackedScriptPath);
      const unpackedManifestBefore = fs.readFileSync(unpackedManifestPath);
      assert.equal(fs.existsSync(wsPaths.resultsDir), false);

      // 2) Run preTranslateProbe with mock driver capturing repacked archive bytes from input.sandboxDir
      let capturedSandboxArchive: Buffer | null = null;
      const probeDriver = {
        run: async (input: { sandboxDir: string }) => {
          const arc = path.join(input.sandboxDir, 'data.ctk');
          assert.equal(fs.existsSync(arc), true, 'Expected repacked data.ctk in smoke sandboxDir');
          capturedSandboxArchive = fs.readFileSync(arc);
          return makeBaseDriverResult({ stepsAdvanced: 5 });
        },
      };

      const smokeRes = await runSmokeTest(ws, profile, {
        homeDir,
        preTranslateProbe: true,
        driver: probeDriver,
      });
      assert.equal(smokeRes.report.ok, true);
      assert.equal(smokeRes.report.phase, 'pre_translate');
      assert.equal(smokeRes.report.mode, 'overlay');
      assert.equal(smokeRes.report.skillEngine, 'ctksmoke');
      assert.ok(smokeRes.report.preTranslateProbe);
      assert.equal(smokeRes.report.preTranslateProbe!.track, 'scenario');
      assert.notEqual(smokeRes.report.preTranslateProbe!.target, smokeRes.report.preTranslateProbe!.source);

      // Verify repacked archive in sandboxDir actually contains the probed Chinese micro-edits AND leaves non-probe UI row untouched
      assert.ok(capturedSandboxArchive);
      assert.equal(capturedSandboxArchive!.subarray(0, 4).toString('ascii'), 'CTK1');
      const targetEnc = smokeRes.report.preTranslateProbe!.targetEncoding.toLowerCase();
      const decodedEncLabel = targetEnc === 'gbk' ? 'gbk' : 'shift_jis';
      const sandboxScriptText = new TextDecoder(decodedEncLabel).decode(capturedSandboxArchive!.subarray(4));
      assert.ok(
        sandboxScriptText.includes(smokeRes.report.preTranslateProbe!.target),
        `Expected repacked archive in sandboxDir to contain micro-edit ${smokeRes.report.preTranslateProbe!.target}, got:\n${sandboxScriptText}`
      );
      assert.equal(smokeRes.report.preTranslateProbe!.additionalProbes?.length, 1);
      assert.ok(
        sandboxScriptText.includes(smokeRes.report.preTranslateProbe!.additionalProbes![0].target),
        `Expected repacked archive in sandboxDir to contain additional probe ${smokeRes.report.preTranslateProbe!.additionalProbes![0].target}, got:\n${sandboxScriptText}`
      );
      assert.ok(
        sandboxScriptText.includes('セーブ'),
        `Expected non-probe line to stay untouched Japanese in pre-translate probe, got:\n${sandboxScriptText}`
      );

      // 3) Verify .papercup/data/results/ remains absent and .papercup/tmp/unpacked/ files remain byte-identical
      assert.equal(fs.existsSync(wsPaths.resultsDir), false, '.papercup/data/results/ must remain absent after preTranslateProbe');
      assert.equal(
        fs.readFileSync(unpackedScriptPath).equals(unpackedScriptBefore),
        true,
        '.papercup/tmp/unpacked/s.txt must remain byte-identical'
      );
      assert.equal(
        fs.readFileSync(unpackedManifestPath).equals(unpackedManifestBefore),
        true,
        '.skill-manifest.json must remain byte-identical'
      );

      // 4) Verify pre-translate.json persisted & checkPreTranslateSmokeGate now allows translation
      assert.equal(SMOKE_PRE_TRANSLATE_REL, WORKSPACE_SMOKE_PRE_TRANSLATE_REL);
      assert.equal(fs.existsSync(wsPaths.smokePreTranslateFile), true);
      const record = readPreTranslateSmokeRecord(ws);
      assert.ok(record);
      assert.equal(record!.schema, 1);
      assert.equal(record!.phase, 'pre_translate');
      assert.equal(record!.ok, true);
      assert.equal(record!.engine, 'ctksmoke');
      assert.equal(record!.skillPipeline, 'skill');
      assert.equal(record!.skillDigest, initialGate.activeSkill!.skillDigest);
      assert.deepEqual(record!.probe, smokeRes.report.preTranslateProbe);

      const passedGate = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' });
      assert.equal(passedGate.allowed, true);
      assert.equal(passedGate.skipped, false);
      assert.equal(passedGate.record?.skillDigest, passedGate.activeSkill?.skillDigest);

      if (process.platform === 'win32') {
        const batchRes = await runTranslateBatches(
          { cwd: ws, subagentManager: makeStubTranslatorManager() },
          { checkpointInterval: 0 }
        );
        assert.equal(batchRes.ok, true);
        assert.ok(translatorSessionsOpened > 0, 'runTranslateBatches must proceed to open translator session once gate passes');
      }

      // 5) Modifying apply.py in workspace skill dir:
      //    - Unsealed tamper triggers integrity mismatch SmokeError
      //    - Re-sealing apply-sha256 changes skillDigest and immediately re-blocks checkPreTranslateSmokeGate!
      const wsSkillDir = path.join(ws, '.papercup', 'skills', 'engine-ctksmoke');
      const wsApplyPath = path.join(wsSkillDir, 'apply.py');
      const updatedApply = fs.readFileSync(wsApplyPath, 'utf8') + '# updated writeback rule\n';
      fs.writeFileSync(wsApplyPath, updatedApply, 'utf8');
      assert.throws(() => checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' }), SmokeError);

      const newApplySha = hashSkillTextContent(Buffer.from(updatedApply, 'utf8'));
      for (const ejPath of [
        path.join(wsSkillDir, 'engine.json'),
        path.join(projectHarnessDir(ws, homeDir), 'engine.json'),
      ]) {
        if (fs.existsSync(ejPath)) {
          const ej = JSON.parse(fs.readFileSync(ejPath, 'utf8')) as Record<string, unknown>;
          ej['apply-sha256'] = newApplySha;
          fs.writeFileSync(ejPath, JSON.stringify(ej, null, 2) + '\n', 'utf8');
        }
      }
      // Keep project harness copy synced if present
      const harnessApply = path.join(projectHarnessDir(ws, homeDir), 'apply.py');
      if (fs.existsSync(harnessApply)) {
        fs.writeFileSync(harnessApply, updatedApply, 'utf8');
      }

      const reblockedGate = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' });
      assert.equal(reblockedGate.allowed, false);
      assert.equal(reblockedGate.skipped, false);
      assert.notEqual(reblockedGate.activeSkill?.skillDigest, record!.skillDigest);
      assert.ok(reblockedGate.reason?.includes('技能摘要不匹配'));
    });
  });

  it('16.2 covers direct-pipeline preTranslateProbe, failure isolation, evaluateSmokeRules/vision probeMode invariance, auto-skip cases & target safety', async () => {
    // A) Direct pipeline preTranslateProbe
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'game_dir'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-Hans"',
          '',
          '[vn.smoke]',
          'enabled = true',
          'vision_enabled = false',
        ].join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(ws, 'game_dir', 'Game.exe'), makeDummyPeExe('x86'));
      const origDirectBytes = encodeText('「おはよう」\r\n今日は晴れだ。\r\n', 'cp932');
      fs.writeFileSync(path.join(ws, 'game_dir', 'script.txt'), origDirectBytes);

      const directExtract = [
        'import json, os, sys',
        'lines = open(os.path.join(sys.argv[1], "script.txt"), "rb").read().decode("cp932").splitlines()',
        'with open(sys.argv[2], "w", encoding="utf-8") as f:',
        '    for i, l in enumerate(lines, 1):',
        '        if l.strip():',
        '            f.write(json.dumps({"id": f"d{i}", "file": "script.txt", "line": i, "kind": "say", "source": l}, ensure_ascii=False) + "\\n")',
      ].join('\n') + '\n';
      const directApply = [
        'import json, os, sys',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING", "cp932")',
        'rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]',
        'by_line = {int(r["line"]): str(r.get("target") or r["source"]) for r in rows}',
        'p = os.path.join(sys.argv[2], "script.txt")',
        'orig = open(p, "rb").read().decode("cp932").splitlines()',
        'out = [by_line.get(i, line) for i, line in enumerate(orig, 1)]',
        'open(p, "wb").write(("\\r\\n".join(out) + "\\r\\n").encode(enc))',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), directExtract, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), directApply, 'utf8');

      const directLearn = await learnVnSkill(ws, {
        engine: 'directsmoke',
        pipeline: 'direct',
        unpackedDir: 'game_dir',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
      });
      assert.equal(directLearn.status, 'adopted', `Expected direct skill adoption, got: ${JSON.stringify(directLearn)}`);
      await classifyVnScripts(ws, {});

      const profile = loadProfile(ws).profile!;
      const gateBefore = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' });
      assert.equal(gateBefore.allowed, false);
      assert.equal(gateBefore.activeSkill?.pipeline, 'direct');

      let sandboxDirectContent = '';
      const directProbe = await runSmokeTest(ws, profile, {
        homeDir,
        preTranslateProbe: true,
        driver: {
          run: async (input) => {
            const f = path.join(input.sandboxDir, 'game_dir', 'script.txt');
            assert.equal(fs.existsSync(f), true);
            const raw = fs.readFileSync(f);
            sandboxDirectContent = new TextDecoder('gbk').decode(raw);
            return makeBaseDriverResult({ stepsAdvanced: 4 });
          },
        },
      });
      assert.equal(directProbe.report.ok, true);
      assert.ok(sandboxDirectContent.includes(directProbe.report.preTranslateProbe!.target));
      assert.equal(fs.readFileSync(path.join(ws, 'game_dir', 'script.txt')).equals(origDirectBytes), true);
      assert.equal(readPreTranslateSmokeRecord(ws)?.skillPipeline, 'direct');
      assert.equal(checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' }).allowed, true);

      // B) Failed preTranslateProbe (runtime.crash / runtime.error_dialog) does NOT increment repair-state.json & keeps gate blocked
      const failedProbe = await runSmokeTest(ws, profile, {
        homeDir,
        preTranslateProbe: true,
        driver: {
          run: async () =>
            makeBaseDriverResult({
              processExitedEarly: true,
              exitCode: -1073741819,
              crashEvent: { exceptionCode: '0xc0000005', faultingModule: 'Game.exe', faultOffset: '0x1234' },
              errorDialog: { title: 'Fatal Error', text: 'Decode failed' },
            }),
        },
      });
      assert.equal(failedProbe.report.ok, false);
      assert.equal(failedProbe.report.phase, 'pre_translate');
      assert.equal(readSmokeRepairState(ws), null, 'preTranslateProbe failure must NOT create/increment post-translate repair-state.json');
      const failedRecord = readPreTranslateSmokeRecord(ws);
      assert.ok(failedRecord);
      assert.equal(failedRecord!.ok, false);
      assert.ok(failedRecord!.errorRules.includes('runtime.crash'));
      assert.ok(failedRecord!.errorRules.includes('runtime.error_dialog'));
      const blockedAfterFail = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' });
      assert.equal(blockedAfterFail.allowed, false);
      assert.ok(blockedAfterFail.reason?.includes('runtime.crash'));

      // C) Auto-skip: non-Windows & smoke.enabled=false on custom skill
      const linuxGate = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'linux' });
      assert.deepEqual(linuxGate, { allowed: true, skipped: true, skipReason: 'non_windows' });

      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\n[vn.smoke]\nenabled = false\n',
        'utf8'
      );
      const disabledGate = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' });
      assert.deepEqual(disabledGate, { allowed: true, skipped: true, skipReason: 'smoke_disabled' });
    });

    // D) Built-in engine (.rpa-manifest.json / .xp3-manifest.json) auto-skips pre-translate gate
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\n[vn.smoke]\nenabled = true\n',
        'utf8'
      );
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(wsPaths.unpackedDir, { recursive: true });
      fs.writeFileSync(path.join(wsPaths.unpackedDir, '.xp3-manifest.json'), '{"engine":"kirikiri"}\n', 'utf8');
      const builtinGate = checkPreTranslateSmokeGate(ws, { homeDir, platform: 'win32' });
      assert.equal(builtinGate.allowed, true);
      assert.equal(builtinGate.skipped, true);
      assert.equal(builtinGate.skipReason, 'builtin_engine');
    });

    // E) Pre-translate rule invariance (evaluateSmokeRules & smoke-vision.ts)
    await withTempWorkspace(async ({ root, ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        [
          JSON.stringify({ id: 's1', file: 's.txt', line: 1, track: 'scenario', source: 'おはようございます', target: '早上好' }),
          JSON.stringify({ id: 's2', file: 's.txt', line: 2, track: 'scenario', source: '今日もいい天気ですね', target: '今天天气真好' }),
          JSON.stringify({ id: 's3', file: 's.txt', line: 3, track: 'scenario', source: 'さようなら', target: '再见' }),
        ].join('\n') + '\n',
        'utf8'
      );

      // Untouched Japanese lines + vision untranslated_dialogue MUST NOT trigger errors in pre_translate mode
      const cleanPreEval = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          textractorLines: ['おはようございます', '今日もいい天気ですね', 'さようなら'],
        }),
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: true,
        visionEnabled: true,
        probeMode: 'pre_translate',
        visionInspection: {
          status: 'checked',
          defects: [{ severity: 'error', kind: 'untranslated_dialogue', description: 'still Japanese', frame: 'dialogue_start' }],
        },
      });
      assert.equal(cleanPreEval.findings.some((f) => f.ruleId === 'text.not_patched'), false);
      assert.equal(cleanPreEval.findings.some((f) => f.ruleId === 'vision.defect'), false);

      // Contrast: post_translate emits text.not_patched and vision.defect for the exact same input
      const postEval = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          textractorLines: ['おはようございます', '今日もいい天気ですね', 'さようなら'],
        }),
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: true,
        visionEnabled: true,
        probeMode: 'post_translate',
        visionInspection: {
          status: 'checked',
          defects: [{ severity: 'error', kind: 'untranslated_dialogue', description: 'still Japanese', frame: 'dialogue_start' }],
        },
      });
      assert.equal(postEval.findings.some((f) => f.ruleId === 'text.not_patched' && f.severity === 'error'), true);
      assert.equal(postEval.findings.some((f) => f.ruleId === 'vision.defect' && f.severity === 'error'), true);

      // Pre-translate still catches runtime.crash, runtime.error_dialog, runtime.hang, and text.mojibake
      const blackPng = path.join(root, 'black.png');
      fs.writeFileSync(blackPng, buildTestPng(16, 16, 2, () => [0, 0, 0]));
      const garbledTarget = new TextDecoder('shift_jis', { fatal: false }).decode(
        Buffer.from('早上好，今天天气真好！', 'utf8')
      );
      const brokenPreEval = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          processExitedEarly: true,
          exitCode: 1,
          crashEvent: { exceptionCode: '0xc0000005' },
          errorDialog: { title: 'Error', text: 'Crash' },
          textractorLines: [garbledTarget, 'ｿｿｿｿ'],
        }),
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: true,
        visionEnabled: false,
        probeMode: 'pre_translate',
      });
      const brokenRules = new Set(brokenPreEval.findings.filter((f) => f.severity === 'error').map((f) => f.ruleId));
      assert.equal(brokenRules.has('runtime.crash'), true);
      assert.equal(brokenRules.has('runtime.error_dialog'), true);
      assert.equal(brokenRules.has('text.mojibake'), true);

      const frozenPreEval = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          processExitedEarly: false,
          frozenScreen: true,
          frames: [{ label: 'title', step: 0, path: blackPng, hash: 'h', width: 16, height: 16 }],
        }),
        workspace: ws,
        targetLang: 'zh-Hans',
        textractorConfigured: false,
        visionEnabled: false,
        probeMode: 'pre_translate',
      });
      assert.equal(
        frozenPreEval.findings.some((f) => f.ruleId === 'runtime.hang' && f.severity === 'error'),
        true
      );

      // smoke-vision.ts prompt adjusts for probeMode === 'pre_translate' vs 'post_translate'
      const capturedPrompts: string[] = [];
      const visionBridge = createSmokeVisionBridge({
        getModel: () => ({ id: 'vision-test', provider: 'test', input: ['text', 'image'] }) as any,
        getModelRuntime: () =>
          ({
            completeSimple: async (_model: any, ctx: any) => {
              const parts = ctx?.messages?.[0]?.content ?? [];
              capturedPrompts.push(
                parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
              );
              return { stopReason: 'stop', content: [{ type: 'text', text: '{"defects":[]}' }] };
            },
          }) as any,
      });
      await visionBridge.inspectFrames!([{ label: 'title', path: blackPng }], {
        targetLang: 'zh-Hans',
        sampleTranslations: ['「中文」'],
        probeMode: 'pre_translate',
      });
      await visionBridge.inspectFrames!([{ label: 'title', path: blackPng }], {
        targetLang: 'zh-Hans',
        sampleTranslations: ['「中文」'],
        probeMode: 'post_translate',
      });
      assert.ok(capturedPrompts[0].includes('pre-translation 1-line smoke probe'));
      assert.equal(capturedPrompts[0].includes('untranslated_dialogue'), false);
      assert.ok(capturedPrompts[1].includes('untranslated_dialogue'));
    });

    // F) buildPreTranslateProbeTarget safety (tags, outer quotes, cp932 safety, target !== source)
    const tagPreserved = buildPreTranslateProbeTarget('「[wait]<ruby>おはよう</ruby>\\n世界」', 'gbk');
    assert.equal(tagPreserved.startsWith('「'), true);
    assert.equal(tagPreserved.endsWith('」'), true);
    assert.ok(tagPreserved.includes('[wait]'));
    assert.ok(tagPreserved.includes('<ruby>'));
    assert.ok(tagPreserved.includes('</ruby>'));
    assert.ok(tagPreserved.includes('\\n'));
    assert.notEqual(tagPreserved, '「[wait]<ruby>おはよう</ruby>\\n世界」');

    const cp932Safe = buildPreTranslateProbeTarget('「おはよう」', 'cp932');
    assert.equal(cp932Safe, '「[PCUP] 中文漢化測試」');
    const cp932Encoded = encodeText(cp932Safe, 'cp932');
    assert.equal(new TextDecoder('shift_jis').decode(cp932Encoded), cp932Safe);

    const gbkTarget = buildPreTranslateProbeTarget('おはようございます', 'gbk');
    assert.ok(!gbkTarget.includes('テスト'));
    assert.notEqual(gbkTarget, 'おはようございます');

    const collisionFallback = buildPreTranslateProbeTarget('「[PCUP] 中文漢化測試」', 'cp932');
    assert.notEqual(collisionFallback, '「[PCUP] 中文漢化測試」');
    assert.equal(collisionFallback.startsWith('「') && collisionFallback.endsWith('」'), true);
  });

  it('16.3 tests OpenAI-compat / Magpie thinking=off graded fallback, omission without off=null, error filtering, bypasses & SubagentManager integration', async () => {
    assert.deepEqual(REASONING_OFF_FALLBACK_LADDER, ['none', 'minimal', 'low', null]);

    const makeOpenAiReasoningModel = (overrides: Record<string, unknown> = {}) => ({
      id: 'gpt-5-compat',
      name: 'GPT-5 Compat',
      api: 'openai-completions',
      provider: 'magpie',
      baseUrl: 'http://127.0.0.1:3425/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
      compat: { supportsReasoningEffort: true },
      ...overrides,
    });

    const collectEvents = async (stream: AsyncIterable<any>) => {
      const events: any[] = [];
      for await (const ev of stream) events.push(ev);
      return events;
    };

    const makeSuccessMsg = (model: any, text = 'OK') => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    });

    const makeErrMsg = (model: any, errorMessage: string) => ({
      role: 'assistant' as const,
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
      stopReason: 'error' as const,
      errorMessage,
      timestamp: Date.now(),
    });

    // A) none (400) -> minimal (400) -> low (200 OK), cached per provider/model, 2nd call hits 'low' directly
    {
      const cache = new Map<string, ReasoningOffCandidate>();
      const model = makeOpenAiReasoningModel({ id: 'model-a' });
      const attempts: Array<string | null | undefined> = [];
      const baseStream = (m: any) => {
        const effort: string | null | undefined = m.thinkingLevelMap?.off;
        attempts.push(effort);
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => {
          s.push({ type: 'start', partial: { role: 'assistant', content: [] } } as any);
          if (effort === 'none' || effort === 'minimal') {
            const errMsg = `400 Bad Request: invalid reasoning_effort '${effort}'`;
            s.push({ type: 'error', reason: 'error', error: makeErrMsg(m, errMsg) } as any);
          } else {
            const ok = makeSuccessMsg(m, 'resolved-low');
            s.push({ type: 'text_delta', contentIndex: 0, delta: 'resolved-low', partial: ok } as any);
            s.push({ type: 'done', reason: 'stop', message: ok } as any);
          }
          s.end();
        });
        return s;
      };

      const ev1 = await collectEvents(
        createReasoningOffFallbackStream(baseStream, model, { messages: [] }, { reasoning: 'off' }, cache)
      );
      assert.deepEqual(attempts, ['none', 'minimal', 'low']);
      assert.equal(getCachedReasoningOffValue(model, cache), 'low');
      assert.equal(ev1.some((e) => e.type === 'done'), true);

      attempts.length = 0;
      const ev2 = await collectEvents(
        createReasoningOffFallbackStream(baseStream, model, { messages: [] }, { reasoning: 'off' }, cache)
      );
      assert.deepEqual(attempts, ['low'], '2nd call must use cached "low" with 0 retries');
      assert.equal(ev2.some((e) => e.type === 'done'), true);
    }

    // B) none / minimal / low all rejected (400) -> omits reasoning_effort (null WITHOUT setting thinkingLevelMap.off = null)
    {
      const cache = new Map<string, ReasoningOffCandidate>();
      const model = makeOpenAiReasoningModel({ id: 'model-b' });
      assert.equal(applyReasoningOffCandidateToModel(model, null), model);
      assert.equal(applyReasoningOffCandidateToModel(model, null).thinkingLevelMap, undefined);

      const attempts: Array<{ off: unknown; hasOffProp: boolean }> = [];
      const baseStream = (m: any) => {
        const hasOffProp = Boolean(m.thinkingLevelMap && Object.prototype.hasOwnProperty.call(m.thinkingLevelMap, 'off'));
        const offVal = m.thinkingLevelMap?.off;
        attempts.push({ off: offVal, hasOffProp });
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (typeof offVal === 'string') {
            s.push({
              type: 'error',
              reason: 'error',
              error: makeErrMsg(m, `400 Bad Request: unsupported parameter reasoning_effort=${offVal}`),
            } as any);
          } else {
            const ok = makeSuccessMsg(m, 'omitted-ok');
            s.push({ type: 'done', reason: 'stop', message: ok } as any);
          }
          s.end();
        });
        return s;
      };

      const ev1 = await collectEvents(
        createReasoningOffFallbackStream(baseStream, model, { messages: [] }, { reasoning: 'off' }, cache)
      );
      assert.deepEqual(attempts, [
        { off: 'none', hasOffProp: true },
        { off: 'minimal', hasOffProp: true },
        { off: 'low', hasOffProp: true },
        { off: undefined, hasOffProp: false },
      ]);
      assert.equal(getCachedReasoningOffValue(model, cache), null);
      assert.equal(ev1.some((e) => e.type === 'done'), true);

      attempts.length = 0;
      await collectEvents(
        createReasoningOffFallbackStream(baseStream, model, { messages: [] }, { reasoning: 'off' }, cache)
      );
      assert.deepEqual(attempts, [{ off: undefined, hasOffProp: false }]);
    }

    // C) Non-400 errors (401/429/500) and unrelated 400 errors MUST NOT retry/downgrade
    for (const nonFallbackErr of [
      '401 Unauthorized: invalid api key for reasoning_effort',
      '429 Too Many Requests: rate limit exceeded',
      '500 Internal Server Error: upstream failure',
      '400 Bad Request: maximum context length exceeded (131072 tokens)',
    ]) {
      assert.equal(
        isReasoningEffortRejectionError(nonFallbackErr, 'none'),
        false,
        `Must not classify as reasoning_effort rejection: ${nonFallbackErr}`
      );
      const cache = new Map<string, ReasoningOffCandidate>();
      const model = makeOpenAiReasoningModel({ id: 'model-err' });
      let callCount = 0;
      const baseStream = (m: any) => {
        callCount += 1;
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => {
          s.push({ type: 'error', reason: 'error', error: makeErrMsg(m, nonFallbackErr) } as any);
          s.end();
        });
        return s;
      };
      const events = await collectEvents(
        createReasoningOffFallbackStream(baseStream, model, { messages: [] }, { reasoning: 'off' }, cache)
      );
      assert.equal(callCount, 1, `Must NOT retry for non-reasoning error: ${nonFallbackErr}`);
      assert.equal(getCachedReasoningOffValue(model, cache), undefined);
      assert.equal(events.some((e) => e.type === 'error'), true);
    }

    // D) Bypass cases: reasoning=false, explicit thinkingLevelMap.off (including null), non-openai thinkingFormat, non-off level
    assert.equal(shouldProbeReasoningEffortOff(makeOpenAiReasoningModel({ reasoning: false }), { reasoning: 'off' }), false);
    assert.equal(
      shouldProbeReasoningEffortOff(makeOpenAiReasoningModel({ thinkingLevelMap: { off: null } }), { reasoning: 'off' }),
      false
    );
    assert.equal(
      shouldProbeReasoningEffortOff(makeOpenAiReasoningModel({ thinkingLevelMap: { off: 'minimal' } }), { reasoning: 'off' }),
      false
    );
    for (const fmt of ['qwen', 'deepseek', 'openrouter']) {
      assert.equal(
        shouldProbeReasoningEffortOff(makeOpenAiReasoningModel({ compat: { supportsReasoningEffort: true, thinkingFormat: fmt } }), {
          reasoning: 'off',
        }),
        false
      );
    }
    assert.equal(shouldProbeReasoningEffortOff(makeOpenAiReasoningModel(), { reasoning: 'low' }), false);
    assert.equal(shouldProbeReasoningEffortOff(makeOpenAiReasoningModel(), { reasoning: 'high' }), false);

    // E) wrapModelRuntimeWithReasoningOffFallback WeakSet idempotency + clearReasoningOffFallbackCache(providerId)
    {
      const cache = new Map<string, ReasoningOffCandidate>();
      cache.set('magpie/m1', 'low');
      cache.set('openai/m2', 'minimal');
      clearReasoningOffFallbackCache('magpie', cache);
      assert.equal(cache.has('magpie/m1'), false);
      assert.equal(cache.get('openai/m2'), 'minimal');

      let innerCalls = 0;
      const runtime = {
        streamSimple: (m: any) => {
          innerCalls += 1;
          const s = createAssistantMessageEventStream();
          queueMicrotask(() => {
            s.push({ type: 'done', reason: 'stop', message: makeSuccessMsg(m) } as any);
            s.end();
          });
          return s;
        },
      };
      wrapModelRuntimeWithReasoningOffFallback(runtime, cache);
      const wrappedOnceFn = runtime.streamSimple;
      wrapModelRuntimeWithReasoningOffFallback(runtime, cache);
      assert.equal(runtime.streamSimple, wrappedOnceFn, 'wrapModelRuntimeWithReasoningOffFallback must be WeakSet-idempotent');

      await collectEvents(runtime.streamSimple(makeOpenAiReasoningModel({ id: 'm-wrap' }), { messages: [] }, { reasoning: 'off' }));
      assert.equal(innerCalls, 1);
      assert.equal(getCachedReasoningOffValue(makeOpenAiReasoningModel({ id: 'm-wrap' }), cache), 'none');
    }

    // F) End-to-end SubagentManager integration (translator role, defaultThinkingLevel='off')
    await withTempWorkspace(async ({ ws }) => {
      const modelId = `e2e-reasoning-off-${Date.now()}`;
      clearReasoningOffFallbackCache('magpie');
      try {
        const model = makeOpenAiReasoningModel({ id: modelId });
        const observedEfforts: Array<string | undefined> = [];
        const mockRuntime: any = {
          getModel: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
          getPhysicalModel: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
          hasConfiguredAuth: () => true,
          checkAuth: async () => ({ auth: { apiKey: 'mock-key' }, source: 'memory' }),
          getAuth: async () => ({ auth: { apiKey: 'mock-key' }, source: 'memory', env: {} }),
          isUsingOAuth: () => false,
          getAvailableSnapshot: () => [model],
          getModels: () => [model],
          getAllModels: () => [model],
          getProviders: () => [{ id: model.provider, name: model.provider, getModels: () => [model] }],
          getProvider: (id: string) =>
            id === model.provider ? { id: model.provider, name: model.provider, getModels: () => [model] } : undefined,
          streamSimple: (m: any) => {
            const effort = m?.thinkingLevelMap?.off;
            observedEfforts.push(effort);
            const s = createAssistantMessageEventStream();
            queueMicrotask(() => {
              if (effort === 'none' || effort === 'minimal') {
                s.push({
                  type: 'error',
                  reason: 'error',
                  error: makeErrMsg(m, `400 Bad Request: reasoning_effort '${effort}' not supported`),
                } as any);
              } else {
                const text = '{"id":"r1","target":"早上好"}';
                const ok = makeSuccessMsg(m, text);
                s.push({ type: 'start', partial: { ...ok, content: [{ type: 'text', text: '' }] } } as any);
                s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: ok } as any);
                s.push({ type: 'done', reason: 'stop', message: ok } as any);
              }
              s.end();
            });
            return s;
          },
        };

        const mgr = new SubagentManager();
        const res1 = await mgr.runSubagentWithMetrics(
          'translator',
          '<batch id="b1" track="scenario" rows="1">\n{"id":"r1","source":"おはよう"}\n</batch>',
          { cwd: ws, model: model as any, modelRuntime: mockRuntime }
        );
        assert.equal(res1.text.trim(), '{"id":"r1","target":"早上好"}');
        assert.deepEqual(observedEfforts, ['none', 'minimal', 'low']);
        assert.equal(getCachedReasoningOffValue(model), 'low');

        observedEfforts.length = 0;
        const res2 = await mgr.runSubagentWithMetrics(
          'translator',
          '<batch id="b2" track="scenario" rows="1">\n{"id":"r1","source":"おはよう"}\n</batch>',
          { cwd: ws, model: model as any, modelRuntime: mockRuntime }
        );
        assert.equal(res2.text.trim(), '{"id":"r1","target":"早上好"}');
        assert.deepEqual(observedEfforts, ['low'], 'Second translator call must use cached "low" directly');
      } finally {
        clearReasoningOffFallbackCache('magpie');
      }
    });
  });

  it('16.4 verifies translator lightweight streaming progress observability, throttling & zero transcript/thinking leakage', async () => {
    assert.equal(TRANSLATOR_PROGRESS_EMIT_INTERVAL_MS, 500);
    assert.deepEqual(extractTranslatorBatchMeta('<batch id="batch_007" track="scenario" rows="3">\n{}\n</batch>'), {
      batchId: 'batch_007',
      expectedRows: 3,
    });
    assert.equal(
      formatTranslatorProgressSummary({
        phase: 'thinking',
        batchId: 'batch_007',
        expectedRows: 3,
        thinkingChars: 42,
        outputChars: 0,
        completedLines: 0,
      }),
      'batch_007 · 思考中（已生成 42 字符）'
    );
    assert.equal(
      formatTranslatorProgressSummary({
        phase: 'generating',
        batchId: 'batch_007',
        expectedRows: 3,
        thinkingChars: 42,
        outputChars: 55,
        completedLines: 2,
      }),
      'batch_007 · 生成译文中（已译 2/3 行 · 55 字符）'
    );
    assert.equal(
      formatTranslatorProgressSummary({
        phase: 'done',
        batchId: 'batch_007',
        expectedRows: 3,
        thinkingChars: 42,
        outputChars: 90,
        completedLines: 3,
      }),
      'batch_007 · 已返回译文（3/3 行 · 90 字符 · 思考 42 字）'
    );

    await withTempWorkspace(async ({ ws }) => {
      const model = {
        id: 'mock-translator-stream',
        name: 'Mock Translator Stream',
        api: 'openai-completions',
        provider: 'mock-tr',
        baseUrl: 'http://127.0.0.1:1/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      };

      const thinkingChunks = [
        'SECRET_THOUGHT_XYZ_1 ',
        'SECRET_THOUGHT_XYZ_2 ',
        'SECRET_THOUGHT_XYZ_3 ',
        'SECRET_THOUGHT_XYZ_4 ',
        'SECRET_THOUGHT_XYZ_5',
      ];
      const expectedThinkingChars = thinkingChunks.join('').length;

      const textChunks = [
        '{"id":"r1","target":"SECRET_JSONL_早上好"}\n',
        '{"id":"r2","target":"SECRET_JSONL_',
        '你好"}\n',
        '{"id":"r3","target":"SECRET_JSONL_再见"}',
        '\n',
      ];
      const fullJsonl = textChunks.join('');
      const expectedOutputChars = fullJsonl.length;

      const mockRuntime: any = {
        getModel: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
        getPhysicalModel: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
        hasConfiguredAuth: () => true,
        checkAuth: async () => ({ auth: { apiKey: 'mock' }, source: 'memory' }),
        getAuth: async () => ({ auth: { apiKey: 'mock' }, source: 'memory', env: {} }),
        isUsingOAuth: () => false,
        getAvailableSnapshot: () => [model],
        getModels: () => [model],
        getAllModels: () => [model],
        getProviders: () => [{ id: model.provider, name: model.provider, getModels: () => [model] }],
        getProvider: () => ({ id: model.provider, name: model.provider, getModels: () => [model] }),
        streamSimple: (m: any) => {
          const s = createAssistantMessageEventStream();
          void (async () => {
            const partialMsg: any = {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '' }],
              api: m.api,
              provider: m.provider,
              model: m.id,
              usage: {
                input: 10,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 30,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: Date.now(),
            };
            s.push({ type: 'start', partial: partialMsg } as any);
            for (const tc of thinkingChunks) {
              partialMsg.content[0].thinking += tc;
              s.push({ type: 'thinking_delta', contentIndex: 0, delta: tc, partial: partialMsg } as any);
              await new Promise((r) => setTimeout(r, 5));
            }
            for (const dc of textChunks) {
              partialMsg.content[1].text += dc;
              s.push({ type: 'text_delta', contentIndex: 1, delta: dc, partial: partialMsg } as any);
              await new Promise((r) => setTimeout(r, 5));
            }
            s.push({ type: 'done', reason: 'stop', message: partialMsg } as any);
            s.end();
          })();
          return s;
        },
      };

      const mgr = new SubagentManager();
      const observedUpdates: Array<{ summary: SubagentTaskSummary; snapshot: SubagentTaskSnapshot }> = [];
      const streamDeltaEvents: any[] = [];

      const managed = await mgr.createManagedSubagentSession('translator', {
        cwd: ws,
        model: model as any,
        modelRuntime: mockRuntime,
      });

      const promptBody =
        '<batch id="batch_007" track="scenario" rows="3">\n' +
        '{"id":"r1","source":"おはよう"}\n' +
        '{"id":"r2","source":"こんにちは"}\n' +
        '{"id":"r3","source":"さようなら"}\n' +
        '</batch>';

      const result = await managed.prompt(promptBody, {
        recordDiagnostics: true,
        onTaskUpdated: (summary, snapshot) => {
          observedUpdates.push({ summary, snapshot });
        },
        onStreamDelta: (ev) => {
          streamDeltaEvents.push(ev);
        },
      });
      managed.dispose();

      // 1) isThinking transitions: false (initial) -> true (thinking_delta) -> false (text_delta) -> false (completed)
      assert.ok(observedUpdates.length >= 4, `Expected >= 4 task updates, got ${observedUpdates.length}`);
      assert.equal(observedUpdates[0].summary.isThinking, false);
      assert.equal(observedUpdates[0].summary.status, 'running');

      const thinkingUpdates = observedUpdates.filter((u) => u.summary.status === 'running' && u.summary.isThinking === true);
      const generatingUpdates = observedUpdates.filter(
        (u) =>
          u.summary.status === 'running' &&
          u.summary.isThinking === false &&
          Boolean(u.summary.lastProgressSummary?.includes('生成译文中'))
      );
      const completedUpdate = observedUpdates[observedUpdates.length - 1];

      // 5 rapid thinking_delta + 5 rapid text_delta chunks (< 500ms) MUST be throttled to 1 transition emission each
      assert.equal(
        thinkingUpdates.length,
        1,
        `Expected 5 rapid thinking_delta chunks to throttle to 1 emission (< ${TRANSLATOR_PROGRESS_EMIT_INTERVAL_MS}ms), got ${thinkingUpdates.length}`
      );
      assert.equal(
        generatingUpdates.length,
        1,
        `Expected 5 rapid text_delta chunks to throttle to 1 emission (< ${TRANSLATOR_PROGRESS_EMIT_INTERVAL_MS}ms), got ${generatingUpdates.length}`
      );

      assert.ok(thinkingUpdates[0].summary.lastProgressSummary?.includes('batch_007'));
      assert.ok(thinkingUpdates[0].summary.lastProgressSummary?.includes('思考中'));
      assert.ok(generatingUpdates[0].summary.lastProgressSummary?.includes('batch_007'));
      assert.ok(generatingUpdates[0].summary.lastProgressSummary?.includes('/3 行'));

      assert.equal(completedUpdate.summary.status, 'completed');
      assert.equal(completedUpdate.summary.isThinking, false);
      assert.equal(
        completedUpdate.summary.lastProgressSummary,
        `batch_007 · 已返回译文（3/3 行 · ${expectedOutputChars} 字符 · 思考 ${expectedThinkingChars} 字）`
      );

      // 2) ZERO thinking text and ZERO raw JSONL body leak into snapshot.messages, responsePreview, onStreamDelta, or disk JSON
      assert.equal(streamDeltaEvents.length, 0, 'translator must emit 0 onStreamDelta events');
      assert.equal(result.snapshot.messages, undefined);
      assert.equal(result.snapshot.responsePreview, '');
      assert.equal(result.snapshot.interactive, false);

      const diskTaskFile = resolveWorkspacePaths(ws).subagentTaskFile(result.taskId);
      assert.equal(fs.existsSync(diskTaskFile), true, 'Expected persisted diagnostic task JSON on disk');
      const diskRaw = fs.readFileSync(diskTaskFile, 'utf8');
      const diskJson = JSON.parse(diskRaw) as SubagentTaskSnapshot;
      assert.equal(diskJson.messages, undefined);
      assert.equal(diskJson.responsePreview, '');
      assert.equal(diskJson.interactive, false);
      assert.equal(diskJson.isThinking, false);
      assert.equal(
        diskJson.lastProgressSummary,
        `batch_007 · 已返回译文（3/3 行 · ${expectedOutputChars} 字符 · 思考 ${expectedThinkingChars} 字）`
      );
      assert.equal(diskRaw.includes('SECRET_THOUGHT_XYZ'), false, 'Disk task JSON must not leak thinking text');
      assert.equal(diskRaw.includes('SECRET_JSONL_'), false, 'Disk task JSON must not leak raw JSONL body');
    });
  });
});

/* ========================= Suite 17 ========================= */

describe('17. Chat Image Attachments, Vision Modality Guard & Queue/Subagent Multimodal Persistence', () => {
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
  );
  const JPEG_BYTES = Buffer.from(
    '/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDAREAAhEBAxEB/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqAP/9k=',
    'base64'
  );
  const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
  const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x14, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 ', 'ascii'),
    Buffer.from([0x08, 0x00, 0x00, 0x00]),
  ]);

  const PNG_B64 = PNG_BYTES.toString('base64');
  const JPEG_B64 = JPEG_BYTES.toString('base64');
  const GIF_B64 = GIF_BYTES.toString('base64');
  const WEBP_B64 = WEBP_BYTES.toString('base64');

  function makeFauxRuntimeModels(faux: ReturnType<typeof createFauxCore>) {
    const base = faux.getModel();
    const visionModel = {
      ...base,
      provider: 'faux',
      id: 'faux-vision-1',
      name: 'Faux Vision 1',
      input: ['text', 'image'] as ('text' | 'image')[],
    };
    const textOnlyModel = {
      ...base,
      provider: 'faux',
      id: 'faux-text-1',
      name: 'Faux Text Only 1',
      input: ['text'] as ('text' | 'image')[],
    };
    return { visionModel, textOnlyModel };
  }

  function installMockRuntime(
    runtime: any,
    visionModel: any,
    textOnlyModel: any
  ): void {
    runtime.getAvailableSnapshot = () => [visionModel, textOnlyModel];
    runtime.checkAuth = async (providerId: string) =>
      providerId === 'faux' ? { type: 'api_key' } : undefined;
    runtime.hasConfiguredAuth = (providerId: string) => providerId === 'faux';
    runtime.getModel = (providerId: string, modelId: string) => {
      if (providerId === 'faux' && modelId === visionModel.id) return visionModel;
      if (providerId === 'faux' && modelId === textOnlyModel.id) return textOnlyModel;
      return undefined;
    };
  }

  async function waitUntil(pred: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for: ${label}`);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  it('17.1 validates/normalizes image attachments, canonicalizes magic-byte MIME, extracts blocks & infers vision modalities', () => {
    // Empty / nullish inputs
    assert.deepEqual(validateAndNormalizeImageAttachments(undefined), []);
    assert.deepEqual(validateAndNormalizeImageAttachments(null), []);
    assert.deepEqual(validateAndNormalizeImageAttachments([]), []);

    // Valid PNG/JPEG/GIF/WebP + data URL prefix stripping + name sanitization
    const valid = validateAndNormalizeImageAttachments([
      { mimeType: 'image/png', data: `data:image/png;base64,${PNG_B64}`, name: '../evil/shot<1>.png' },
      { mimeType: 'image/jpg', data: JPEG_B64, name: 'photo.jpg' },
      { mimeType: 'image/gif', data: GIF_B64 },
      { data: `data:image/webp;base64,${WEBP_B64}` },
    ]);
    assert.equal(valid.length, 4);
    assert.deepEqual(valid[0], { mimeType: 'image/png', data: PNG_B64, name: 'shot1.png' });
    assert.deepEqual(valid[1], { mimeType: 'image/jpeg', data: JPEG_B64, name: 'photo.jpg' });
    assert.deepEqual(valid[2], { mimeType: 'image/gif', data: GIF_B64 });
    assert.deepEqual(valid[3], { mimeType: 'image/webp', data: WEBP_B64 });

    // Magic-byte MIME canonicalization when declared mime differs from PNG header
    const canonicalized = validateAndNormalizeImageAttachments([
      { mimeType: 'image/jpeg', data: PNG_B64 },
    ]);
    assert.equal(canonicalized[0].mimeType, 'image/png');
    assert.equal(canonicalized[0].data, PNG_B64);

    // Rejects non-array
    assert.throws(() => validateAndNormalizeImageAttachments('not-array'), /expected an array/i);
    assert.throws(() => validateAndNormalizeImageAttachments({ mimeType: 'image/png', data: PNG_B64 }), /expected an array/i);

    // Rejects > MAX_IMAGES_PER_MESSAGE (4)
    assert.throws(
      () =>
        validateAndNormalizeImageAttachments(
          Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ mimeType: 'image/png', data: PNG_B64 }))
        ),
      /最多附带 4 张图片/
    );

    // Rejects > MAX_IMAGE_BYTES (10MB) single decoded bytes
    const overSingle = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_IMAGE_BYTES + 1 - PNG_BYTES.length)]).toString('base64');
    assert.throws(
      () => validateAndNormalizeImageAttachments([{ mimeType: 'image/png', data: overSingle }]),
      /超过单张大小限制/
    );

    // Rejects > MAX_TOTAL_IMAGE_BYTES (20MB) total decoded bytes (3 x 8MB = 24MB)
    const eightMb = Buffer.concat([PNG_BYTES, Buffer.alloc(8 * 1024 * 1024 - PNG_BYTES.length)]).toString('base64');
    assert.throws(
      () =>
        validateAndNormalizeImageAttachments([
          { mimeType: 'image/png', data: eightMb },
          { mimeType: 'image/png', data: eightMb },
          { mimeType: 'image/png', data: eightMb },
        ]),
      /总大小超过限制/
    );

    // Rejects invalid base64
    assert.throws(
      () => validateAndNormalizeImageAttachments([{ mimeType: 'image/png', data: 'not-valid-base64!!!' }]),
      /Base64 编码无效/
    );
    assert.throws(
      () => validateAndNormalizeImageAttachments([{ mimeType: 'image/png', data: 'abc' }]),
      /Base64 编码无效/
    );

    // Rejects non-image magic bytes (MZ / hello) even with declared image/png
    const mzB64 = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1').toString('base64');
    const helloB64 = Buffer.from('hello world!', 'utf8').toString('base64');
    assert.throws(
      () => validateAndNormalizeImageAttachments([{ mimeType: 'image/png', data: mzB64 }]),
      /文件头校验失败/
    );
    assert.throws(
      () => validateAndNormalizeImageAttachments([{ mimeType: 'image/png', data: helloB64 }]),
      /文件头校验失败/
    );

    // extractImagesFromContent
    assert.deepEqual(extractImagesFromContent('plain string'), []);
    assert.deepEqual(
      extractImagesFromContent([
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/jpg', data: ` ${JPEG_B64} ` },
        { type: 'image', mimeType: 'image/svg+xml', data: PNG_B64 },
        { type: 'image', mimeType: 'image/png', data: '   ' },
        { type: 'image', mimeType: 'image/webp', data: WEBP_B64 },
      ]),
      [
        { mimeType: 'image/jpeg', data: JPEG_B64 },
        { mimeType: 'image/webp', data: WEBP_B64 },
      ]
    );

    // modelSupportsImageInput
    assert.equal(modelSupportsImageInput({ input: ['text', 'image'] }), true);
    assert.equal(modelSupportsImageInput({ input: ['text'] }), false);
    assert.equal(modelSupportsImageInput({ input: [] }), false);
    assert.equal(modelSupportsImageInput({}), false);
    assert.equal(modelSupportsImageInput(null), false);
    assert.equal(modelSupportsImageInput(undefined), false);

    // inferCustomModelInputModalities
    for (const visionId of [
      'claude-sonnet-4-5',
      'gemini-2.5-pro',
      'gpt-4o',
      'gpt-5',
      'qwen-vl-max',
      'qwen3.5-plus',
      'glm-4.5v',
      'kimi-k2.5',
      'pixtral-large',
      'grok-4',
    ]) {
      assert.deepEqual(
        inferCustomModelInputModalities(visionId),
        ['text', 'image'],
        `Expected vision modalities for ${visionId}`
      );
    }
    for (const textId of [
      'deepseek-chat',
      'deepseek-r1',
      'llama-3.3-70b',
      'qwen3-coder-plus',
      'custom-text-only',
    ]) {
      assert.deepEqual(
        inferCustomModelInputModalities(textId),
        ['text'],
        `Expected text-only modalities for ${textId}`
      );
    }
  });

  it('17.2 handles /api/turns/start vision & text-only models, persists images in history & checks image-only summary title', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const faux = createFauxCore({ tokensPerSecond: 10000 });
      const { visionModel, textOnlyModel } = makeFauxRuntimeModels(faux);
      const svc = new AgentService(ws, { sessionMode: 'memory' });
      const app = createApiRouter(svc);

      try {
        await svc.initSession();
        const session = (svc as any).currentSession;
        installMockRuntime(session.modelRuntime, visionModel, textOnlyModel);
        session.agent.state.model = visionModel;
        session.agent.streamFunction = faux.streamSimple;

        // 1) GET /api/models reports supportsImage accurately
        const modelsRes = await app.request('/api/models');
        assert.equal(modelsRes.status, 200);
        const modelsBody = await modelsRes.json();
        const listedVision = modelsBody.models.find((m: any) => m.key === 'faux/faux-vision-1');
        const listedText = modelsBody.models.find((m: any) => m.key === 'faux/faux-text-1');
        assert.equal(listedVision?.supportsImage, true);
        assert.equal(listedText?.supportsImage, false);

        // Capture user messages received by the Pi session
        const seenUserContents: any[] = [];
        faux.setResponses([
          (ctx) => {
            const lastUser = [...ctx.messages].reverse().find((m) => m.role === 'user');
            seenUserContents.push(lastUser?.content);
            return fauxAssistantMessage('已收到首张截图。');
          },
          (ctx) => {
            const lastUser = [...ctx.messages].reverse().find((m) => m.role === 'user');
            seenUserContents.push(lastUser?.content);
            return fauxAssistantMessage('已收到带文字和图片的请求。');
          },
        ]);

        // 2) Image-only first turn (prompt: '')
        const imgOnlyRes = await app.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '',
            images: [{ mimeType: 'image/png', data: PNG_B64, name: 'first.png' }],
          }),
        });
        assert.equal(imgOnlyRes.status, 200);
        await waitUntil(() => !svc.isBusy(), 'image-only first turn completion');

        assert.equal(seenUserContents.length, 1);
        assert.ok(Array.isArray(seenUserContents[0]));
        assert.ok(
          seenUserContents[0].some((b: any) => b.type === 'image' && b.mimeType === 'image/png' && b.data === PNG_B64),
          `Pi session must receive image block: ${JSON.stringify(seenUserContents[0])}`
        );

        const histAfterFirst = await (await app.request('/api/session/history')).json();
        const firstUserMsg = histAfterFirst.messages.find((m: any) => m.role === 'user');
        assert.ok(firstUserMsg, 'Expected persisted user message in history');
        assert.deepEqual(firstUserMsg.images, [{ mimeType: 'image/png', data: PNG_B64 }]);
        assert.equal(
          histAfterFirst.sessions?.[0]?.title,
          '[图片]',
          `Expected image-only first turn summary title to default to "[图片]", got ${JSON.stringify(histAfterFirst.sessions?.[0]?.title)}`
        );

        // 3) Text + image turn
        const textImgRes = await app.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '请查看这张报错截图',
            images: [{ mimeType: 'image/jpeg', data: JPEG_B64, name: 'err.jpg' }],
          }),
        });
        assert.equal(textImgRes.status, 200);
        await waitUntil(() => !svc.isBusy(), 'text+image turn completion');

        assert.equal(seenUserContents.length, 2);
        assert.ok(
          Array.isArray(seenUserContents[1]) &&
            seenUserContents[1].some((b: any) => b.type === 'text' && b.text.includes('请查看这张报错截图')) &&
            seenUserContents[1].some((b: any) => b.type === 'image' && b.mimeType === 'image/jpeg' && b.data === JPEG_B64),
          `Pi session must receive text + image blocks: ${JSON.stringify(seenUserContents[1])}`
        );

        const histAfterSecond = await (await app.request('/api/session/history')).json();
        const userMsgs = histAfterSecond.messages.filter((m: any) => m.role === 'user');
        assert.equal(userMsgs.length, 2);
        assert.equal(userMsgs[1].content, '请查看这张报错截图');
        assert.deepEqual(userMsgs[1].images, [{ mimeType: 'image/jpeg', data: JPEG_B64 }]);

        // 4) Text-only model rejects image attachments with HTTP 400 MODEL_NO_VISION
        const switchRes = await app.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'faux/faux-text-1' }),
        });
        assert.equal(switchRes.status, 200);

        const noVisionRes = await app.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '看看这张图',
            images: [{ mimeType: 'image/png', data: PNG_B64 }],
          }),
        });
        assert.equal(noVisionRes.status, 400);
        const noVisionBody = await noVisionRes.json();
        assert.equal(noVisionBody.code, 'MODEL_NO_VISION');
      } finally {
        (svc as any).disposeCurrentSessionState?.(true);
      }
    });
  });

  it('17.3 preserves & replays queued images in SessionQueueController and /api/turns/queue while enforcing MODEL_NO_VISION', async () => {
    // Part A: Pure SessionQueueController unit tests
    const ctrl = new SessionQueueController();
    const steerLog: Array<{ text: string; images?: any[] }> = [];
    const followUpLog: Array<{ text: string; images?: any[] }> = [];
    const rawSteer: string[] = [];
    const rawFollow: string[] = [];
    const mockSession: QueueCapableSession = {
      steer: async (text, images) => {
        rawSteer.push(text);
        steerLog.push({ text, images });
      },
      followUp: async (text, images) => {
        rawFollow.push(text);
        followUpLog.push({ text, images });
      },
      clearQueue: () => {
        const snapshot = { steering: [...rawSteer], followUp: [...rawFollow] };
        rawSteer.length = 0;
        rawFollow.length = 0;
        return snapshot;
      },
      getSteeringMessages: () => [...rawSteer],
      getFollowUpMessages: () => [...rawFollow],
    };

    const enqSteer = await ctrl.enqueue(mockSession, '插话检查截图', 'steer', [
      { mimeType: 'image/png', data: PNG_B64, name: 's.png' },
    ]);
    const enqFollow = await ctrl.enqueue(mockSession, '排队检查另一张', 'followUp', [
      { mimeType: 'image/jpeg', data: JPEG_B64, name: 'f.jpg' },
    ]);

    assert.equal(enqSteer.item.imageCount, 1);
    assert.equal(enqFollow.item.imageCount, 1);
    assert.equal(enqSteer.queue.steering[0].imageCount, 1);
    assert.equal(enqFollow.queue.followUp[0].imageCount, 1);
    const stateJson = JSON.stringify(ctrl.getState());
    assert.equal(stateJson.includes(PNG_B64), false, 'Queue summary must NOT embed base64 image data');
    assert.equal(stateJson.includes(JPEG_B64), false, 'Queue summary must NOT embed base64 image data');
    assert.equal(steerLog[0].images?.[0]?.data, PNG_B64);
    assert.equal(followUpLog[0].images?.[0]?.data, JPEG_B64);

    // switchItemMode clears and replays with preserved images
    steerLog.length = 0;
    followUpLog.length = 0;
    const switched = await ctrl.switchItemMode(mockSession, enqSteer.item.id, 'followUp');
    assert.equal(switched.found, true);
    assert.equal(switched.item?.mode, 'followUp');
    assert.equal(switched.item?.imageCount, 1);
    assert.equal(switched.queue.steering.length, 0);
    assert.equal(switched.queue.followUp.length, 2);
    assert.equal(followUpLog.length, 2);
    assert.equal(followUpLog[0].images?.[0]?.data, JPEG_B64);
    assert.equal(followUpLog[1].images?.[0]?.data, PNG_B64);

    // removeItem returns removedImages and replays remaining item with images
    steerLog.length = 0;
    followUpLog.length = 0;
    const removed = await ctrl.removeItem(mockSession, enqSteer.item.id);
    assert.equal(removed.found, true);
    assert.equal(removed.removed?.imageCount, 1);
    assert.deepEqual(removed.removedImages, [{ mimeType: 'image/png', data: PNG_B64, name: 's.png' }]);
    assert.equal(removed.queue.followUp.length, 1);
    assert.equal(removed.queue.followUp[0].imageCount, 1);
    assert.equal(followUpLog.length, 1);
    assert.equal(followUpLog[0].images?.[0]?.data, JPEG_B64);

    // Part B: End-to-end /api/turns/queue with AgentService
    await withTempWorkspace(async ({ ws }) => {
      const faux = createFauxCore({ tokensPerSecond: 10000 });
      const { visionModel, textOnlyModel } = makeFauxRuntimeModels(faux);
      const svc = new AgentService(ws, { sessionMode: 'memory' });
      const app = createApiRouter(svc);

      try {
        await svc.initSession();
        const session = (svc as any).currentSession;
        installMockRuntime(session.modelRuntime, visionModel, textOnlyModel);
        session.agent.state.model = visionModel;
        session.agent.streamFunction = faux.streamSimple;

        let notifyStep1!: () => void;
        const step1Started = new Promise<void>((r) => (notifyStep1 = r));
        let releaseStep1!: () => void;
        const step1Gate = new Promise<void>((r) => (releaseStep1 = r));
        let deliveredFollowUpUser: any = null;

        faux.setResponses([
          async () => {
            notifyStep1();
            await step1Gate;
            return fauxAssistantMessage('第一步完成。');
          },
          (ctx) => {
            deliveredFollowUpUser = [...ctx.messages].reverse().find((m) => m.role === 'user');
            return fauxAssistantMessage('已处理排队中的图片消息。');
          },
        ]);

        const startRes = await app.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '开始分析' }),
        });
        assert.equal(startRes.status, 200);
        await step1Started;

        // Enqueue steer with PNG image
        const q1Res = await app.request('/api/turns/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '稍后附带截图确认',
            mode: 'steer',
            images: [{ mimeType: 'image/png', data: PNG_B64, name: 'q1.png' }],
          }),
        });
        assert.equal(q1Res.status, 202);
        const q1Body = await q1Res.json();
        assert.equal(q1Body.item?.imageCount, 1);
        assert.equal(JSON.stringify(q1Body).includes(PNG_B64), false);

        // Enqueue second steer with JPEG, then remove it and verify removedImages
        const q2Res = await app.request('/api/turns/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '撤回这条带图插话',
            mode: 'steer',
            images: [{ mimeType: 'image/jpeg', data: JPEG_B64, name: 'q2.jpg' }],
          }),
        });
        assert.equal(q2Res.status, 202);
        const q2Body = await q2Res.json();

        const delQ2Res = await app.request(`/api/turns/queue/${encodeURIComponent(q2Body.item.id)}`, {
          method: 'DELETE',
        });
        assert.equal(delQ2Res.status, 200);
        const delQ2Body = await delQ2Res.json();
        assert.deepEqual(delQ2Body.removedImages, [{ mimeType: 'image/jpeg', data: JPEG_B64, name: 'q2.jpg' }]);

        // Switch q1 from steer -> followUp and verify imageCount preserved without base64 bloat
        const patchRes = await app.request(`/api/turns/queue/${encodeURIComponent(q1Body.item.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'followUp' }),
        });
        assert.equal(patchRes.status, 200);
        const patchBody = await patchRes.json();
        assert.equal(patchBody.item?.mode, 'followUp');
        assert.equal(patchBody.item?.imageCount, 1);

        const statusRes = await app.request('/api/turns/status');
        const statusBody = await statusRes.json();
        assert.equal(statusBody.pendingQueue?.followUp?.[0]?.imageCount, 1);
        assert.equal(JSON.stringify(statusBody.pendingQueue).includes(PNG_B64), false);

        releaseStep1();
        await waitUntil(() => !svc.isBusy(), 'queued followUp turn completion');

        assert.ok(
          Array.isArray(deliveredFollowUpUser?.content) &&
            deliveredFollowUpUser.content.some(
              (b: any) => b.type === 'image' && b.mimeType === 'image/png' && b.data === PNG_B64
            ),
          `Queued followUp must deliver image block after mode switch + removal replay: ${JSON.stringify(deliveredFollowUpUser)}`
        );

        const hist = await (await app.request('/api/session/history')).json();
        const queuedUserHist = hist.messages.find((m: any) => m.role === 'user' && m.content === '稍后附带截图确认');
        assert.ok(queuedUserHist, 'Expected delivered queued user message in session history');
        assert.deepEqual(queuedUserHist.images, [{ mimeType: 'image/png', data: PNG_B64 }]);

        // Text-only model rejects queued images with HTTP 400 MODEL_NO_VISION
        const swRes = await app.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'faux/faux-text-1' }),
        });
        assert.equal(swRes.status, 200);

        let notifyTextStep!: () => void;
        const textStepStarted = new Promise<void>((r) => (notifyTextStep = r));
        let releaseTextStep!: () => void;
        const textStepGate = new Promise<void>((r) => (releaseTextStep = r));
        faux.setResponses([
          async () => {
            notifyTextStep();
            await textStepGate;
            return fauxAssistantMessage('纯文本回合完成。');
          },
        ]);

        const textStartRes = await app.request('/api/turns/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '纯文本模型启动' }),
        });
        assert.equal(textStartRes.status, 200);
        await textStepStarted;

        const rejectQueueRes = await app.request('/api/turns/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '尝试排队发图',
            mode: 'steer',
            images: [{ mimeType: 'image/png', data: PNG_B64 }],
          }),
        });
        assert.equal(rejectQueueRes.status, 400);
        const rejectQueueBody = await rejectQueueRes.json();
        assert.equal(rejectQueueBody.code, 'MODEL_NO_VISION');

        releaseTextStep();
        await waitUntil(() => !svc.isBusy(), 'text-only turn completion');
      } finally {
        (svc as any).disposeCurrentSessionState?.(true);
      }
    });
  });

  it('17.4 forwards images in direct subagent /message & /queue, persists on Snapshot.messages without Summary bloat & enforces MODEL_NO_VISION', async () => {
    await withTempWorkspace(async ({ ws }) => {
      const faux = createFauxCore({ tokensPerSecond: 10000 });
      const { visionModel, textOnlyModel } = makeFauxRuntimeModels(faux);
      const subFaux = createFauxCore({ tokensPerSecond: 10000 });
      const svc = new AgentService(ws, { sessionMode: 'memory' });
      const app = createApiRouter(svc);

      try {
        await svc.initSession();
        const session = (svc as any).currentSession;
        installMockRuntime(session.modelRuntime, visionModel, textOnlyModel);
        session.agent.state.model = visionModel;
        session.agent.streamFunction = faux.streamSimple;

        const subMgr = (svc as any).subagentManager as SubagentManager;
        const origCreateSub = subMgr.createSubagentSession.bind(subMgr);
        subMgr.createSubagentSession = async (roleName, opts) => {
          const res = await origCreateSub(roleName, opts);
          if (opts.model) {
            (res.session as any).agent.state.model = opts.model;
          }
          (res.session as any).agent.streamFunction = subFaux.streamSimple;
          (res.session as any)._modelRuntime.hasConfiguredAuth = () => true;
          return res;
        };

        // Seed an initial interactive reverser task
        const sessionId = (svc as any).sessionManager?.getSessionId?.() ?? null;
        subFaux.setResponses([fauxAssistantMessage('初始逆向分析完成。')]);
        const seedRun = await subMgr.runSubagentWithMetrics('reverser', '初始化子代理线程', {
          cwd: ws,
          model: visionModel,
          modelRuntime: session.modelRuntime,
          sessionId,
        });

        // 1) Vision model direct /message with image
        let directUserContent: any = null;
        subFaux.setResponses([
          (ctx) => {
            directUserContent = [...ctx.messages].reverse().find((m) => m.role === 'user')?.content;
            return fauxAssistantMessage('已查看截图并定位编码表。');
          },
        ]);

        const msgRes = await app.request(`/api/subagents/tasks/${encodeURIComponent(seedRun.taskId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: '请分析这张乱码截图',
            images: [{ mimeType: 'image/png', data: PNG_B64, name: 'mojibake.png' }],
          }),
        });
        assert.equal(msgRes.status, 202);
        const msgBody = await msgRes.json();
        await waitUntil(() => !svc.isBusy(), 'direct subagent message turn completion');

        assert.ok(
          Array.isArray(directUserContent) &&
            directUserContent.some((b: any) => b.type === 'image' && b.mimeType === 'image/png' && b.data === PNG_B64),
          `Subagent session must receive forwarded image block: ${JSON.stringify(directUserContent)}`
        );

        const snapRes = await app.request(`/api/subagents/tasks/${encodeURIComponent(msgBody.taskId)}`);
        assert.equal(snapRes.status, 200);
        const snapBody = (await snapRes.json()) as SubagentTaskSnapshot;
        const directSnapUser = snapBody.messages?.find(
          (m) => m.role === 'user' && m.content === '请分析这张乱码截图'
        );
        assert.ok(directSnapUser, 'Expected direct user message persisted in SubagentTaskSnapshot.messages');
        assert.deepEqual(directSnapUser.images, [{ mimeType: 'image/png', data: PNG_B64, name: 'mojibake.png' }]);

        const listRes = await app.request('/api/subagents/tasks');
        assert.equal(listRes.status, 200);
        const listBody = await listRes.json();
        assert.equal(JSON.stringify(listBody).includes(PNG_B64), false, 'SubagentTaskSummary list must NOT contain base64 bloat');
        assert.equal(
          listBody.tasks.every((t: any) => !('images' in t)),
          true,
          'SubagentTaskSummary must NOT contain images field'
        );

        // 2) Vision model /queue while direct subagent task is running
        let notifySubStep1!: () => void;
        const subStep1Started = new Promise<void>((r) => (notifySubStep1 = r));
        let releaseSubStep1!: () => void;
        const subStep1Gate = new Promise<void>((r) => (releaseSubStep1 = r));
        let steeredSubUserContent: any = null;

        subFaux.setResponses([
          async () => {
            notifySubStep1();
            await subStep1Gate;
            return fauxAssistantMessage('第一阶段完成。');
          },
          (ctx) => {
            steeredSubUserContent = [...ctx.messages].reverse().find((m) => m.role === 'user')?.content;
            return fauxAssistantMessage('已收到插话截图并继续。');
          },
        ]);

        const run2Res = await app.request(`/api/subagents/tasks/${encodeURIComponent(msgBody.taskId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '继续深入检查文件头' }),
        });
        assert.equal(run2Res.status, 202);
        const run2Body = await run2Res.json();
        await subStep1Started;

        const subQueueRes = await app.request(`/api/subagents/tasks/${encodeURIComponent(run2Body.taskId)}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: '补充十六进制截图',
            mode: 'steer',
            images: [{ mimeType: 'image/jpeg', data: JPEG_B64, name: 'hex.jpg' }],
          }),
        });
        assert.equal(subQueueRes.status, 202);
        const subQueueBody = await subQueueRes.json();
        assert.equal(subQueueBody.item?.imageCount, 1);
        assert.equal(JSON.stringify(subQueueBody).includes(JPEG_B64), false);

        releaseSubStep1();
        await waitUntil(() => !svc.isBusy(), 'queued subagent steer turn completion');

        assert.ok(
          Array.isArray(steeredSubUserContent) &&
            steeredSubUserContent.some((b: any) => b.type === 'image' && b.mimeType === 'image/jpeg' && b.data === JPEG_B64),
          `Queued subagent steer must forward image block: ${JSON.stringify(steeredSubUserContent)}`
        );

        const snap2Res = await app.request(`/api/subagents/tasks/${encodeURIComponent(run2Body.taskId)}`);
        const snap2Body = (await snap2Res.json()) as SubagentTaskSnapshot;
        const steeredSnapMsg = snap2Body.messages?.find(
          (m) => m.role === 'user' && m.content === '补充十六进制截图'
        );
        assert.ok(steeredSnapMsg, 'Expected steered user message in SubagentTaskSnapshot.messages');
        assert.deepEqual(steeredSnapMsg.images, [{ mimeType: 'image/jpeg', data: JPEG_B64 }]);

        const list2Body = await (await app.request('/api/subagents/tasks')).json();
        assert.equal(JSON.stringify(list2Body).includes(JPEG_B64), false);
        assert.equal(JSON.stringify(list2Body).includes(PNG_B64), false);

        // 3) Text-only model rejects direct subagent /message & /queue with HTTP 400 MODEL_NO_VISION
        const swRes = await app.request('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'faux/faux-text-1' }),
        });
        assert.equal(swRes.status, 200);

        const textSubMsgRes = await app.request(`/api/subagents/tasks/${encodeURIComponent(run2Body.taskId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: '看图',
            images: [{ mimeType: 'image/png', data: PNG_B64 }],
          }),
        });
        assert.equal(textSubMsgRes.status, 400);
        const textSubMsgBody = await textSubMsgRes.json();
        assert.equal(textSubMsgBody.code, 'MODEL_NO_VISION');

        let notifyTextSubStart!: () => void;
        const textSubStarted = new Promise<void>((r) => (notifyTextSubStart = r));
        let releaseTextSub!: () => void;
        const textSubGate = new Promise<void>((r) => (releaseTextSub = r));
        subFaux.setResponses([
          async () => {
            notifyTextSubStart();
            await textSubGate;
            return fauxAssistantMessage('纯文本子代理完成。');
          },
        ]);

        const textSubRunRes = await app.request(`/api/subagents/tasks/${encodeURIComponent(run2Body.taskId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '纯文本追问' }),
        });
        assert.equal(textSubRunRes.status, 202);
        const textSubRunBody = await textSubRunRes.json();
        await textSubStarted;

        const textSubQueueRes = await app.request(
          `/api/subagents/tasks/${encodeURIComponent(textSubRunBody.taskId)}/queue`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: '纯文本子代理队列发图',
              mode: 'steer',
              images: [{ mimeType: 'image/png', data: PNG_B64 }],
            }),
          }
        );
        assert.equal(textSubQueueRes.status, 400);
        const textSubQueueBody = await textSubQueueRes.json();
        assert.equal(textSubQueueBody.code, 'MODEL_NO_VISION');

        releaseTextSub();
        await waitUntil(() => !svc.isBusy(), 'text-only direct subagent turn completion');
      } finally {
        (svc as any).disposeCurrentSessionState?.(true);
      }
    });
  });
});

function buildMinimalTrueTypeFont(options: {
  familyName: string;
  unitsPerEm?: number;
  xAvgCharWidth?: number;
  cjkAdvanceWidth?: number;
  hasShiftJisCodePage?: boolean;
  hasGb2312CodePage?: boolean;
  codepoints?: Array<{ cp: number; advance: number }>;
}): Buffer {
  const unitsPerEm = options.unitsPerEm ?? 1024;
  const xAvgCharWidth = options.xAvgCharWidth ?? 1013;
  const cjkAdvance = options.cjkAdvanceWidth ?? 1024;
  const mappings = (
    options.codepoints ?? [
      { cp: 0x0041, advance: Math.round(unitsPerEm / 2) },
      { cp: 0x4e2d, advance: cjkAdvance }, // 中
      { cp: 0x6f22, advance: cjkAdvance }, // 漢
    ]
  )
    .slice()
    .sort((a, b) => a.cp - b.cp);

  const glyphCount = 1 + mappings.length; // glyph 0 = .notdef

  // Simple 4-point square contour glyph template (for valid glyf + loca)
  const makeSquareGlyph = (adv: number): Buffer => {
    const buf = Buffer.alloc(24, 0);
    buf.writeInt16BE(1, 0); // numberOfContours = 1
    buf.writeInt16BE(50, 2); // xMin
    buf.writeInt16BE(0, 4); // yMin
    buf.writeInt16BE(Math.max(100, adv - 50), 6); // xMax
    buf.writeInt16BE(Math.round(unitsPerEm * 0.75), 8); // yMax
    buf.writeUInt16BE(3, 10); // endPtsOfContours[0] = 3
    buf.writeUInt16BE(0, 12); // instructionLength = 0
    // 4 points, flags = 0x01 (on-curve) + 0x10 (xIsSame) / 0x20 (yIsSame) -> let's use positive short deltas (0x01 | 0x02 | 0x04 | 0x10 | 0x20? no, explicit 1-byte unsigned deltas with positive flags 0x10/0x20)
    // Simpler: flag = 0x01 (on-curve), x/y = 2-byte int16 deltas:
    // flags: 4 bytes of 0x01
    buf[14] = 0x01;
    buf[15] = 0x01;
    buf[16] = 0x01;
    buf[17] = 0x01;
    // Actually 16-bit deltas need 4*2 + 4*2 = 16 bytes -> let's resize cleanly
    const out = Buffer.alloc(14 + 4 + 16, 0);
    buf.copy(out, 0, 0, 14);
    out[14] = 0x01;
    out[15] = 0x01;
    out[16] = 0x01;
    out[17] = 0x01;
    const xMax = Math.max(100, adv - 50);
    const yMax = Math.round(unitsPerEm * 0.75);
    // x deltas: +50, +(xMax-50), 0, -(xMax-50)
    out.writeInt16BE(50, 18);
    out.writeInt16BE(xMax - 50, 20);
    out.writeInt16BE(0, 22);
    out.writeInt16BE(-(xMax - 50), 24);
    // y deltas: 0, 0, +yMax, 0
    out.writeInt16BE(0, 26);
    out.writeInt16BE(0, 28);
    out.writeInt16BE(yMax, 30);
    out.writeInt16BE(0, 32);
    return out;
  };

  const glyfChunks: Buffer[] = [];
  const locaOffsets: number[] = [0];
  let glyfCursor = 0;
  for (let i = 0; i < glyphCount; i++) {
    const adv = i === 0 ? Math.round(unitsPerEm / 2) : mappings[i - 1].advance;
    const g = makeSquareGlyph(adv);
    // Align to 2 bytes for short loca
    const padded = g.length % 2 === 0 ? g : Buffer.concat([g, Buffer.alloc(1)]);
    glyfChunks.push(padded);
    glyfCursor += padded.length;
    locaOffsets.push(glyfCursor);
  }
  const glyfBuf = Buffer.concat(glyfChunks);
  const locaBuf = Buffer.alloc((glyphCount + 1) * 2);
  for (let i = 0; i < locaOffsets.length; i++) {
    locaBuf.writeUInt16BE(locaOffsets[i] >> 1, i * 2);
  }

  const head = Buffer.alloc(54, 0);
  head.writeUInt32BE(0x00010000, 0); // major.minor
  head.writeUInt32BE(0x00010000, 4); // fontRevision
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  head.writeUInt16BE(0x000b, 16); // flags
  head.writeUInt16BE(unitsPerEm, 18);
  head.writeInt16BE(0, 36); // xMin
  head.writeInt16BE(0, 38); // yMin
  head.writeInt16BE(unitsPerEm, 40); // xMax
  head.writeInt16BE(unitsPerEm, 42); // yMax
  head.writeUInt16BE(8, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(0, 50); // indexToLocFormat = 0 (short)

  const hhea = Buffer.alloc(36, 0);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(Math.round(unitsPerEm * 0.85), 4); // ascender
  hhea.writeInt16BE(-Math.round(unitsPerEm * 0.15), 6); // descender
  hhea.writeUInt16BE(cjkAdvance, 10); // advanceWidthMax
  hhea.writeInt16BE(1, 32); // metricDataFormat = 0? wait offset 32 is metricDataFormat=0, offset 34 is numberOfHMetrics
  hhea.writeInt16BE(0, 32);
  hhea.writeUInt16BE(glyphCount, 34);

  const maxp = Buffer.alloc(32, 0);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(glyphCount, 4);
  maxp.writeUInt16BE(4, 6); // maxPoints
  maxp.writeUInt16BE(1, 8); // maxContours

  const os2 = Buffer.alloc(86, 0);
  os2.writeUInt16BE(1, 0); // version 1
  os2.writeInt16BE(xAvgCharWidth, 2);
  os2.writeUInt16BE(400, 4); // usWeightClass
  os2.writeUInt16BE(5, 6); // usWidthClass
  os2.writeInt16BE(Math.round(unitsPerEm * 0.85), 68); // sTypoAscender
  os2.writeInt16BE(-Math.round(unitsPerEm * 0.15), 70); // sTypoDescender
  os2.writeUInt16BE(Math.round(unitsPerEm * 0.85), 74); // usWinAscent
  os2.writeUInt16BE(Math.round(unitsPerEm * 0.15), 76); // usWinDescent
  let cpRange1 = 1; // Latin-1
  if (options.hasShiftJisCodePage) cpRange1 |= 1 << 17;
  if (options.hasGb2312CodePage) cpRange1 |= 1 << 18;
  os2.writeUInt32BE(cpRange1 >>> 0, 78);

  const hmtx = Buffer.alloc(glyphCount * 4, 0);
  hmtx.writeUInt16BE(Math.round(unitsPerEm / 2), 0);
  hmtx.writeInt16BE(50, 2);
  for (let i = 0; i < mappings.length; i++) {
    hmtx.writeUInt16BE(mappings[i].advance, (i + 1) * 4);
    hmtx.writeInt16BE(50, (i + 1) * 4 + 2);
  }

  // cmap format 4 (1 segment per mapped codepoint + 0xFFFF terminator)
  const segCount = mappings.length + 1;
  const segCountX2 = segCount * 2;
  const searchRange = 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
  const entrySelector = Math.floor(Math.log2(searchRange / 2));
  const rangeShift = segCountX2 - searchRange;
  const fmt4Len = 16 + segCount * 8;
  const cmap = Buffer.alloc(4 + 8 + fmt4Len, 0);
  cmap.writeUInt16BE(0, 0); // version
  cmap.writeUInt16BE(1, 2); // numTables
  cmap.writeUInt16BE(3, 4); // platformID = 3
  cmap.writeUInt16BE(1, 6); // encodingID = 1
  cmap.writeUInt32BE(12, 8); // offset
  const sOff = 12;
  cmap.writeUInt16BE(4, sOff); // format
  cmap.writeUInt16BE(fmt4Len, sOff + 2);
  cmap.writeUInt16BE(0, sOff + 4); // language
  cmap.writeUInt16BE(segCountX2, sOff + 6);
  cmap.writeUInt16BE(searchRange, sOff + 8);
  cmap.writeUInt16BE(entrySelector, sOff + 10);
  cmap.writeUInt16BE(rangeShift, sOff + 12);
  const endCodeOff = sOff + 14;
  const startCodeOff = endCodeOff + segCount * 2 + 2;
  const idDeltaOff = startCodeOff + segCount * 2;
  const idRangeOff = idDeltaOff + segCount * 2;
  for (let i = 0; i < mappings.length; i++) {
    const cp = mappings[i].cp;
    const gid = i + 1;
    cmap.writeUInt16BE(cp, endCodeOff + i * 2);
    cmap.writeUInt16BE(cp, startCodeOff + i * 2);
    cmap.writeInt16BE((gid - cp) & 0xffff ? ((gid - cp) << 16) >> 16 : 0, idDeltaOff + i * 2);
    cmap.writeUInt16BE(0, idRangeOff + i * 2);
  }
  cmap.writeUInt16BE(0xffff, endCodeOff + mappings.length * 2);
  cmap.writeUInt16BE(0xffff, startCodeOff + mappings.length * 2);
  cmap.writeInt16BE(1, idDeltaOff + mappings.length * 2);
  cmap.writeUInt16BE(0, idRangeOff + mappings.length * 2);

  // name table (nameID 1 = family, 2 = Regular, 4 = family, 6 = PostScript)
  const encodeUtf16Be = (s: string): Buffer => {
    const b = Buffer.alloc(s.length * 2);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
    return b;
  };
  const nameEntries: Array<{ id: number; data: Buffer }> = [
    { id: 1, data: encodeUtf16Be(options.familyName) },
    { id: 2, data: encodeUtf16Be('Regular') },
    { id: 4, data: encodeUtf16Be(options.familyName) },
    { id: 6, data: encodeUtf16Be(options.familyName.replace(/[^A-Za-z0-9_-]/g, '') || 'SubsetFont') },
  ];
  const nameHdrLen = 6 + nameEntries.length * 12;
  const nameStrings = Buffer.concat(nameEntries.map((e) => e.data));
  const nameTbl = Buffer.alloc(nameHdrLen + nameStrings.length, 0);
  nameTbl.writeUInt16BE(0, 0);
  nameTbl.writeUInt16BE(nameEntries.length, 2);
  nameTbl.writeUInt16BE(nameHdrLen, 4);
  let strCursor = 0;
  for (let i = 0; i < nameEntries.length; i++) {
    const rec = 6 + i * 12;
    const ent = nameEntries[i];
    nameTbl.writeUInt16BE(3, rec);
    nameTbl.writeUInt16BE(1, rec + 2);
    nameTbl.writeUInt16BE(0x0409, rec + 4);
    nameTbl.writeUInt16BE(ent.id, rec + 6);
    nameTbl.writeUInt16BE(ent.data.length, rec + 8);
    nameTbl.writeUInt16BE(strCursor, rec + 10);
    ent.data.copy(nameTbl, nameHdrLen + strCursor);
    strCursor += ent.data.length;
  }

  const post = Buffer.alloc(32, 0);
  post.writeUInt32BE(0x00030000, 0); // version 3.0 (no glyph names)

  const tableEntries = [
    { tag: 'OS/2', buf: os2 },
    { tag: 'cmap', buf: cmap },
    { tag: 'glyf', buf: glyfBuf },
    { tag: 'head', buf: head },
    { tag: 'hhea', buf: hhea },
    { tag: 'hmtx', buf: hmtx },
    { tag: 'loca', buf: locaBuf },
    { tag: 'maxp', buf: maxp },
    { tag: 'name', buf: nameTbl },
    { tag: 'post', buf: post },
  ].sort((a, b) => (a.tag < b.tag ? -1 : 1));

  const numTables = tableEntries.length;
  const headerSize = 12 + numTables * 16;
  const sfntChunks: Buffer[] = [Buffer.alloc(headerSize, 0)];
  let offset = headerSize;
  const calcChecksum = (b: Buffer): number => {
    let sum = 0;
    const paddedLen = Math.ceil(b.length / 4) * 4;
    for (let i = 0; i < paddedLen; i += 4) {
      let v = 0;
      for (let j = 0; j < 4; j++) {
        v = (v << 8) | (i + j < b.length ? b[i + j] : 0);
      }
      sum = (sum + (v >>> 0)) >>> 0;
    }
    return sum >>> 0;
  };

  const dir = sfntChunks[0];
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(numTables, 4);
  const sRange = 16 * Math.pow(2, Math.floor(Math.log2(numTables)));
  dir.writeUInt16BE(sRange, 6);
  dir.writeUInt16BE(Math.floor(Math.log2(numTables)), 8);
  dir.writeUInt16BE(numTables * 16 - sRange, 10);

  for (let i = 0; i < numTables; i++) {
    const { tag, buf } = tableEntries[i];
    const rec = 12 + i * 16;
    dir.write(tag, rec, 4, 'latin1');
    dir.writeUInt32BE(calcChecksum(buf), rec + 4);
    dir.writeUInt32BE(offset, rec + 8);
    dir.writeUInt32BE(buf.length, rec + 12);
    const padLen = (4 - (buf.length % 4)) % 4;
    sfntChunks.push(buf);
    if (padLen > 0) sfntChunks.push(Buffer.alloc(padLen, 0));
    offset += buf.length + padLen;
  }

  return Buffer.concat(sfntChunks);
}

describe('18. Smoke Benign Exit, Font Inspection/Patching/Writeback & Roster/Status Contracts', () => {
  it('18.1 validates evaluateSmokeRules early_exit vs crash, multi-row probe selection, patched-font auto-overlay, last-probe retention & PS1 DPI/Job compilation', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      // A) evaluateSmokeRules: benign early exit (exitCode 0 + stepsAdvanced >= 3 + non-uniform frame + no crash/errorDialog) -> warning, ok
      const nonUniformPng = path.join(root, 'nonuniform.png');
      const uniformPng = path.join(root, 'uniform.png');
      fs.writeFileSync(
        nonUniformPng,
        buildTestPng(32, 32, 2, (x, y) => [(x * 7) & 0xff, (y * 9) & 0xff, 120])
      );
      fs.writeFileSync(
        uniformPng,
        buildTestPng(32, 32, 2, () => [0, 0, 0])
      );

      const benignRes = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          processExitedEarly: true,
          exitCode: 0,
          stepsAdvanced: 3,
          mainProcessName: 'Game.exe',
          frames: [
            { label: 'title', step: 0, path: nonUniformPng, relPath: 'nonuniform.png', hash: 'h1', width: 32, height: 32 },
          ],
        }),
        workspace: ws,
        targetLang: 'zh-CN',
        textractorConfigured: false,
        visionEnabled: false,
      });
      assert.equal(
        benignRes.findings.some((f) => f.ruleId === 'runtime.early_exit' && f.severity === 'warning'),
        true,
        `Expected runtime.early_exit warning: ${JSON.stringify(benignRes.findings)}`
      );
      assert.equal(
        benignRes.findings.some((f) => f.ruleId === 'runtime.crash'),
        false,
        'Benign early exit must NOT emit runtime.crash'
      );
      assert.equal(
        benignRes.findings.every((f) => f.severity !== 'error'),
        true,
        `Benign early exit must have 0 errors (ok=true): ${JSON.stringify(benignRes.findings)}`
      );

      // stepsAdvanced < 3 -> runtime.crash (error)
      const tooShortExit = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          processExitedEarly: true,
          exitCode: 0,
          stepsAdvanced: 2,
          frames: [
            { label: 'title', step: 0, path: nonUniformPng, relPath: 'nonuniform.png', hash: 'h1', width: 32, height: 32 },
          ],
        }),
        workspace: ws,
        targetLang: 'zh-CN',
        textractorConfigured: false,
        visionEnabled: false,
      });
      assert.equal(
        tooShortExit.findings.some((f) => f.ruleId === 'runtime.crash' && f.severity === 'error'),
        true
      );
      assert.equal(tooShortExit.findings.some((f) => f.ruleId === 'runtime.early_exit'), false);

      // All uniform frames -> runtime.crash (error)
      const uniformOnlyExit = evaluateSmokeRules({
        driverResult: makeBaseDriverResult({
          processExitedEarly: true,
          exitCode: 0,
          stepsAdvanced: 5,
          frames: [
            { label: 'title', step: 0, path: uniformPng, relPath: 'uniform.png', hash: 'h2', width: 32, height: 32 },
          ],
        }),
        workspace: ws,
        targetLang: 'zh-CN',
        textractorConfigured: false,
        visionEnabled: false,
      });
      assert.equal(
        uniformOnlyExit.findings.some((f) => f.ruleId === 'runtime.crash' && f.severity === 'error'),
        true
      );

      // Non-zero exitCode or crashEvent -> runtime.crash (error)
      for (const crashCase of [
        { exitCode: 1, crashEvent: undefined },
        { exitCode: 0, crashEvent: { exceptionCode: '0xc0000005', faultingModule: 'game.dll', faultOffset: '0x1234' } },
      ]) {
        const crashed = evaluateSmokeRules({
          driverResult: makeBaseDriverResult({
            processExitedEarly: true,
            stepsAdvanced: 5,
            frames: [
              { label: 'title', step: 0, path: nonUniformPng, relPath: 'nonuniform.png', hash: 'h1', width: 32, height: 32 },
            ],
            ...crashCase,
          }),
          workspace: ws,
          targetLang: 'zh-CN',
          textractorConfigured: false,
          visionEnabled: false,
        });
        assert.equal(
          crashed.findings.some((f) => f.ruleId === 'runtime.crash' && f.severity === 'error'),
          true,
          `Expected runtime.crash for ${JSON.stringify(crashCase)}`
        );
      }

      // B) pickPreTranslateProbeRows & buildPreTranslateProbeTarget
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(path.dirname(wsPaths.buildTrackFile('scenario')), { recursive: true });
      fs.writeFileSync(
        wsPaths.buildTrackFile('scenario'),
        [
          JSON.stringify({ id: 'n1', file: 'opening.txt', line: 1, kind: 'name', source: '魔法使い' }),
          JSON.stringify({ id: 's1', file: 'opening.txt', line: 2, kind: 'say', source: '魔法使い' }),
          JSON.stringify({ id: 'd1', file: 'opening.txt', line: 3, kind: 'say', source: '「おはようございます！」' }),
          JSON.stringify({ id: 'd2', file: 'opening.txt', line: 4, kind: 'say', source: '『今日はいい天気ですね。[HERO]\\n進みましょう。』' }),
          JSON.stringify({ id: 'd3', file: 'opening.txt', line: 5, kind: 'say', source: '長いナレーションの行が続きます。' }),
          JSON.stringify({ id: 'd4', file: 'chapter2.txt', line: 1, kind: 'say', source: '「別のファイル」' }),
        ].join('\n') + '\n',
        'utf8'
      );

      const picked = pickPreTranslateProbeRows(ws, 3);
      assert.equal(picked.track, 'scenario');
      assert.deepEqual(
        picked.rows.map((r) => r.id),
        ['d1', 'd2', 'd3'],
        'pickPreTranslateProbeRows must skip kind="name" and standalone short speaker lines before 「...」 and keep 1-3 rows in opening file'
      );

      for (const enc of ['utf-8', 'utf-16le-bom', 'gbk'] as const) {
        const scTarget = buildPreTranslateProbeTarget('「こんにちは、[HERO]\\nさん！」', enc);
        assert.equal(scTarget.startsWith('「') && scTarget.endsWith('」'), true);
        assert.ok(scTarget.includes('[PCUP]'), `Missing [PCUP] prefix for ${enc}: ${scTarget}`);
        assert.ok(scTarget.includes('[HERO]') && scTarget.includes('\\n'), `Control tokens lost for ${enc}: ${scTarget}`);
        assert.ok(/[探针读懂这经]/.test(scTarget), `Expected SC-only glyph probe chars for ${enc}: ${scTarget}`);
      }
      const cp932Target = buildPreTranslateProbeTarget('『こんにちは、[HERO]\\nさん！』', 'cp932');
      assert.equal(cp932Target.startsWith('『') && cp932Target.endsWith('』'), true);
      assert.ok(cp932Target.includes('[PCUP] 中文漢化測試'));
      assert.ok(cp932Target.includes('[HERO]') && cp932Target.includes('\\n'));
      const cp932Buf = encodeText(cp932Target, 'cp932');
      assert.equal(new TextDecoder('shift_jis').decode(cp932Buf), cp932Target);

      // C) Patched font auto-overlay + last-probe/ retention in runSmokeTest(preTranslateProbe=true)
      fs.mkdirSync(path.join(ws, 'game'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.smoke]',
          'enabled = true',
          'vision_enabled = false',
        ].join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, 'game', 'opening.txt'),
        [
          '魔法使い',
          '「おはようございます！」',
          '『今日はいい天気ですね。[HERO]\\n進みましょう。』',
          '長いナレーションの行が続きます。',
        ].join('\n') + '\n',
        'utf8'
      );
      const baseFontBytes = buildMinimalTrueTypeFont({ familyName: 'ProbeGameFont', hasShiftJisCodePage: true });
      fs.writeFileSync(path.join(ws, 'game', 'GameFont.ttf'), baseFontBytes);
      // Stage a valid patched font in .papercup/data/vn/fonts/manifest.json
      const patchedFontBytes = buildMinimalTrueTypeFont({
        familyName: 'ProbeGameFont',
        hasShiftJisCodePage: true,
        hasGb2312CodePage: true,
      });
      const patchedFontAbs = path.join(wsPaths.fontsDataDir, 'files', 'game', 'GameFont.ttf');
      fs.mkdirSync(path.dirname(patchedFontAbs), { recursive: true });
      fs.writeFileSync(patchedFontAbs, patchedFontBytes);
      fs.writeFileSync(
        wsPaths.fontsManifestFile,
        JSON.stringify(
          {
            schema: 1,
            updated_at: '2026-11-25T00:00:00Z',
            entries: [
              {
                install_rel: 'game/GameFont.ttf',
                patched_rel: 'files/game/GameFont.ttf',
                base_sha256: sha256Hex(baseFontBytes),
                sha256: sha256Hex(patchedFontBytes),
                bytes: patchedFontBytes.length,
                base_family: 'ProbeGameFont',
                fallback_font: 'simhei.ttf',
                added_glyphs: 10,
                still_missing_count: 0,
                created_at: '2026-11-25T00:00:00Z',
              },
            ],
          },
          null,
          2
        ) + '\n',
        'utf8'
      );

      const directExtract = [
        'import json, pathlib, sys',
        'root = pathlib.Path(sys.argv[1])',
        'lines = (root / "opening.txt").read_text("utf-8").splitlines()',
        'rows = [{"id": f"op#{i}", "file": "opening.txt", "line": i, "kind": "say", "source": t} for i, t in enumerate(lines, 1) if t.strip()]',
        'pathlib.Path(sys.argv[2]).write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", "utf-8")',
      ].join('\n') + '\n';
      const directApply = [
        'import json, pathlib, sys',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "opening.txt"',
        'lines = p.read_bytes().decode("utf-8").splitlines()',
        'by_line = {int(r["line"]): str(r.get("target") or r["source"]) for r in rows}',
        'p.write_bytes(("\\n".join(by_line.get(i, l) for i, l in enumerate(lines, 1)) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), directExtract, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), directApply, 'utf8');

      const learned = await learnVnSkill(ws, {
        engine: 'probeoverlay',
        pipeline: 'direct',
        unpackedDir: 'game',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'utf-8',
      });
      assert.equal(learned.status, 'adopted', `probeoverlay learnVnSkill failed: ${JSON.stringify(learned)}`);
      await classifyVnScripts(ws, {});

      let sandboxSawPatchedFont = false;
      let sandboxSawProbeText = false;
      const profile = loadProfile(ws).profile!;
      const probeRes = await runSmokeTest(ws, profile, {
        homeDir,
        preTranslateProbe: true,
        driver: {
          run: async (input) => {
            const sbFont = path.join(input.sandboxDir, 'game', 'GameFont.ttf');
            const sbScript = path.join(input.sandboxDir, 'game', 'opening.txt');
            sandboxSawPatchedFont =
              fs.existsSync(sbFont) && fs.readFileSync(sbFont).equals(patchedFontBytes);
            sandboxSawProbeText =
              fs.existsSync(sbScript) && fs.readFileSync(sbScript, 'utf8').includes('[PCUP]');
            return makeBaseDriverResult({
              stepsAdvanced: 4,
              frames: [
                { label: 'title', step: 0, path: nonUniformPng, relPath: 'nonuniform.png', hash: 'h1', width: 32, height: 32 },
              ],
            });
          },
        },
      });
      assert.equal(probeRes.report.ok, true);
      assert.equal(sandboxSawPatchedFont, true, 'preTranslateProbe must overlay patched font into sandboxDir');
      assert.equal(sandboxSawProbeText, true, 'preTranslateProbe must overlay probed script into sandboxDir');
      assert.equal(probeRes.report.preTranslateProbe?.savedProbeDir, WORKSPACE_SMOKE_LAST_PROBE_REL);
      assert.equal(probeRes.report.preTranslateProbe?.additionalProbes?.length, 2);

      // Verify last-probe/ retained on disk after runSmokeTest cleanup
      assert.equal(fs.existsSync(path.join(wsPaths.smokeLastProbeDir, 'probe.jsonl')), true);
      assert.equal(fs.existsSync(path.join(wsPaths.smokeLastProbeDir, 'meta.json')), true);
      assert.equal(
        fs.existsSync(path.join(wsPaths.smokeLastProbeDir, 'overlay', 'game', 'GameFont.ttf')),
        true
      );
      const retainedProbeLines = fs
        .readFileSync(path.join(wsPaths.smokeLastProbeDir, 'probe.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/);
      assert.equal(retainedProbeLines.length, 3);

      // D) PowerShell 5.1 Parser::ParseInput & C# Add-Type compilation check on WINDOWS_SMOKE_DRIVER_PS1
      const drvSrc = getWindowsSmokeDriverSource();
      assert.ok(drvSrc.includes('EnableDpiAwareness'));
      assert.ok(drvSrc.includes('SetProcessDpiAwarenessContext'));
      assert.ok(drvSrc.includes('OpenProcess([PaperCupSmoke.Native]::PROCESS_QUERY_LIMITED_INFORMATION'));
      assert.ok(drvSrc.includes('GetExitCodeProcess'));
      assert.ok(drvSrc.includes('observedProcessNames'));

      if (process.platform === 'win32') {
        const ps1Path = path.join(root, '_smoke_driver_18.ps1');
        writeWindowsSmokeDriverScript(ps1Path);
        const checkerPath = path.join(root, 'check_18.ps1');
        fs.writeFileSync(
          checkerPath,
          [
            'param([string]$TargetPath)',
            '$ErrorActionPreference = "Stop"',
            '$raw = Get-Content -LiteralPath $TargetPath -Raw -Encoding UTF8',
            '$tokens = $null; $errors = $null',
            '[System.Management.Automation.Language.Parser]::ParseInput($raw, [ref]$tokens, [ref]$errors) | Out-Null',
            'if ($errors -and $errors.Count -gt 0) { throw ("PS_PARSE_ERR: " + ($errors | ForEach-Object { $_.Message } | Out-String)) }',
            String.raw`$m = [regex]::Match($raw, "(?s)\$cs = @'\r?\n(.*?)\r?\n'@")`,
            'if (-not $m.Success) { throw "CS_BLOCK_MISSING" }',
            'Add-Type -AssemblyName System.Drawing',
            'Add-Type -TypeDefinition $m.Groups[1].Value -ReferencedAssemblies System.Drawing',
            '$hasDpi = ([PaperCupSmoke.Native].GetMethod("EnableDpiAwareness") -ne $null)',
            '$hasExit = ([PaperCupSmoke.Native].GetMethod("GetExitCodeProcess") -ne $null)',
            'Write-Output ("PS1_18_OK:" + $hasDpi + ":" + $hasExit)',
          ].join('\r\n') + '\r\n',
          'utf8'
        );
        const out = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checkerPath, '-TargetPath', ps1Path],
          { encoding: 'utf8', timeout: 25000, windowsHide: true }
        ).trim();
        assert.equal(out, 'PS1_18_OK:True:True', `Unexpected PS1 parse/compile output: ${out}`);
      }
    });
  });

  it('18.2 verifies getVnStatus batch rows, formatPythonErrorDetail tail retention, nested .skill-manifest.json classify & Pass 3 standalone_say roster fallback', async () => {
    // 1) getVnStatus reads batches/manifest.json `rows` field (e.g. 821/10237, not /0)
    await withTempWorkspace(({ ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
        'utf8'
      );
      fs.mkdirSync(wsPaths.batchesDir, { recursive: true });
      fs.mkdirSync(wsPaths.workOutDir, { recursive: true });
      fs.writeFileSync(
        wsPaths.batchesManifestFile,
        JSON.stringify(
          {
            schema: 1,
            total_rows: 10237,
            batches: [
              { batch_id: 'b001', rows: 821 },
              { batch_id: 'b002', rows: 9416 },
            ],
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      const b001Lines = Array.from({ length: 821 }, (_, i) => JSON.stringify({ id: `r${i}`, target: `句${i}` })).join('\n') + '\n';
      fs.writeFileSync(wsPaths.batchOutFile('b001'), b001Lines, 'utf8');

      const status = getVnStatus(ws);
      assert.ok(status.includes('821/10237'), `Expected batch line progress 821/10237, got:\n${status}`);
      assert.equal(status.includes('/0 段'), false, `Batch total lines must not be /0:\n${status}`);
    });

    // 2) formatPythonErrorDetail retains exception tail on long Python tracebacks
    const longFrames = Array.from(
      { length: 40 },
      (_, idx) => `  File "unpack_very_long_module_name_${idx}.py", line ${100 + idx}, in step_${idx}\n    process_chunk(buf_${idx})`
    ).join('\n');
    const traceback = `Traceback (most recent call last):\n${longFrames}\nValueError: magic_header_mismatch_at_offset_0x40`;
    const formatted = formatPythonErrorDetail(traceback, 600);
    assert.ok(formatted.length <= 600, `Expected <= 600 chars, got ${formatted.length}`);
    assert.ok(formatted.startsWith('Traceback (most recent call last):'), `Missing traceback head: ${formatted}`);
    assert.ok(formatted.includes(' ... '), `Missing middle ellipsis: ${formatted}`);
    assert.ok(
      formatted.endsWith('ValueError: magic_header_mismatch_at_offset_0x40'),
      `Missing exception tail: ${formatted}`
    );

    // 3) classifyVnScripts auto-resolves nested .skill-manifest.json under .papercup/tmp/unpacked
    await withTempWorkspace(async ({ ws }) => {
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      const rawBin = Buffer.concat([
        Buffer.from('NST1', 'ascii'),
        encodeText('アリス\t「おはよう」\r\nアリス\t「今日もいい天気だね」\r\n\tセーブ\r\n', 'cp932'),
      ]);
      fs.writeFileSync(path.join(ws, 'nested.nst'), rawBin);

      const unpackPy = [
        'import os, sys',
        'raw = open(sys.argv[1], "rb").read()',
        'open(os.path.join(sys.argv[2], "sc.txt"), "wb").write(raw[4:])',
      ].join('\n') + '\n';
      const repackPy = [
        'import os, sys',
        'data = open(os.path.join(sys.argv[1], "sc.txt"), "rb").read()',
        'open(sys.argv[2], "wb").write(b"NST1" + data)',
      ].join('\n') + '\n';
      const extractPy = [
        'import json, pathlib, sys',
        'root = pathlib.Path(sys.argv[1])',
        'rows = []',
        'for p in sorted(root.rglob("sc.txt")):',
        '    rel = p.relative_to(root).as_posix()',
        '    for i, line in enumerate(p.read_bytes().decode("cp932").splitlines(), 1):',
        '        if not line.strip(): continue',
        '        spk, txt = line.split("\\t", 1)',
        '        rec = {"id": f"{rel}#{i}", "file": rel, "line": i, "kind": "say" if spk else "system", "source": txt}',
        '        if spk: rec["speaker"] = spk',
        '        rows.append(rec)',
        'pathlib.Path(sys.argv[2]).write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", "utf-8")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, pathlib, sys',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING") or "cp932"',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "sc.txt"',
        'orig = p.read_bytes().decode("cp932").splitlines()',
        'by_line = {int(r["line"]): str(r.get("target") or r["source"]) for r in rows}',
        'out = []',
        'for i, line in enumerate(orig, 1):',
        '    spk, txt = line.split("\\t", 1)',
        '    out.append(f"{spk}\\t{by_line.get(i, txt)}")',
        'p.write_bytes(("\\r\\n".join(out) + "\\r\\n").encode(enc))',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'unpack.py'), unpackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'repack.py'), repackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      const learned = await learnVnSkill(ws, {
        engine: 'nestedskill',
        archive: 'nested.nst',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
        magicHex: '4e535431',
      });
      assert.equal(learned.status, 'adopted');

      // Simulate nested .skill-manifest.json under .papercup/tmp/unpacked/nested/
      const wsPaths = resolveWorkspacePaths(ws);
      const nestedUnpackDir = path.join(wsPaths.unpackedDir, 'nested');
      fs.mkdirSync(nestedUnpackDir, { recursive: true });
      fs.writeFileSync(path.join(nestedUnpackDir, 'sc.txt'), rawBin.subarray(4));
      fs.writeFileSync(
        path.join(nestedUnpackDir, '.skill-manifest.json'),
        JSON.stringify({ version: 'skill', source: path.join(ws, 'nested.nst'), engine: 'nestedskill', files: [{ name: 'sc.txt' }] }),
        'utf8'
      );
      assert.equal(fs.existsSync(path.join(wsPaths.unpackedDir, '.skill-manifest.json')), false);

      const classifyOut = await classifyVnScripts(ws, {});
      assert.ok(classifyOut.includes('剧情 2 条；界面 1 条'), `Expected nested skill classify 2+1, got:\n${classifyOut}`);
    });

    // 4) extractCharacterCandidates Pass 3 fallback & non-activation when Pass 1/2 finds candidates
    await withTempWorkspace(({ ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(path.dirname(wsPaths.buildTrackFile('scenario')), { recursive: true });

      // Pass 3 activates when Passes 1 & 2 find 0 candidates
      fs.writeFileSync(
        wsPaths.buildTrackFile('scenario'),
        [
          JSON.stringify({ id: '1', file: 's01.txt', line: 1, kind: 'say', source: 'アリス' }),
          JSON.stringify({ id: '2', file: 's01.txt', line: 2, kind: 'say', source: '「おはようございます！」' }),
          JSON.stringify({ id: '3', file: 's01.txt', line: 3, kind: 'say', source: '今日はいい天気。' }),
          JSON.stringify({ id: '4', file: 's01.txt', line: 4, kind: 'say', source: '「そうですね」' }),
          JSON.stringify({ id: '5', file: 's01.txt', line: 5, kind: 'say', source: 'ボブ' }),
          JSON.stringify({ id: '6', file: 's01.txt', line: 6, kind: 'say', source: '『準備はいい？』' }),
        ].join('\n') + '\n',
        'utf8'
      );
      const pass3Res = extractCharacterCandidates(ws);
      assert.deepEqual(
        pass3Res.characters.map((c) => c.sourceName).sort(),
        ['アリス', 'ボブ']
      );
      assert.ok(pass3Res.characters.every((c) => c.sources.includes('standalone_say')));

      // Does NOT activate when speaker or kind="name" rows exist
      fs.writeFileSync(
        wsPaths.buildTrackFile('scenario'),
        [
          JSON.stringify({ id: '1', file: 's01.txt', line: 1, kind: 'say', speaker: 'アリス', source: '「おはよう」' }),
          JSON.stringify({ id: '2', file: 's01.txt', line: 2, kind: 'say', source: 'モブ' }),
          JSON.stringify({ id: '3', file: 's01.txt', line: 3, kind: 'say', source: '「えっ？」' }),
        ].join('\n') + '\n',
        'utf8'
      );
      const pass2Res = extractCharacterCandidates(ws);
      assert.deepEqual(
        pass2Res.characters.map((c) => c.sourceName),
        ['アリス'],
        'Pass 3 must NOT activate when explicit speaker rows exist'
      );

      fs.writeFileSync(
        wsPaths.buildTrackFile('scenario'),
        [
          JSON.stringify({ id: '1', file: 's01.txt', line: 1, kind: 'name', source: 'ユイ' }),
          JSON.stringify({ id: '2', file: 's01.txt', line: 2, kind: 'say', source: 'モブ' }),
          JSON.stringify({ id: '3', file: 's01.txt', line: 3, kind: 'say', source: '「えっ？」' }),
        ].join('\n') + '\n',
        'utf8'
      );
      const pass1Res = extractCharacterCandidates(ws);
      assert.deepEqual(
        pass1Res.characters.map((c) => c.sourceName),
        ['ユイ'],
        'Pass 3 must NOT activate when kind="name" rows exist'
      );
    });
  });

  it('18.3 verifies pure-TS inspectFontBuffer & scanWorkspaceBundledFonts, vn_patch_font patching, and vn_writeback font_patch bundling', async () => {
    await withTempWorkspace(async ({ root, ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(path.join(ws, 'GameData', 'dat'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.smoke]',
          'enabled = false',
        ].join('\n') + '\n',
        'utf8'
      );

      // 1) Synthetic Japanese-subset base TTF + synthetic fallback CJK TTF (completely offline & cross-platform)
      const baseFontRel = 'GameData/dat/SubsetDemo.ttf';
      const baseFontAbs = path.join(ws, ...baseFontRel.split('/'));
      const baseTtf = buildMinimalTrueTypeFont({
        familyName: 'SubsetDemo',
        unitsPerEm: 1024,
        xAvgCharWidth: 1013,
        cjkAdvanceWidth: 1024,
        hasShiftJisCodePage: true,
        hasGb2312CodePage: false,
      });
      fs.writeFileSync(baseFontAbs, baseTtf);

      const inspected = inspectFontBuffer(baseTtf);
      assert.equal(inspected.familyName, 'SubsetDemo');
      assert.equal(inspected.unitsPerEm, 1024);
      assert.equal(inspected.xAvgCharWidth, 1013);
      assert.equal(inspected.cjkAdvanceWidth, 1024);
      assert.equal(inspected.hasShiftJisCodePage, true);
      assert.equal(inspected.hasGb2312CodePage, false);
      assert.equal(inspected.mappedCodepoints.has(0x4e2d), true);
      assert.equal(inspected.mappedCodepoints.has('你'.codePointAt(0)!), false);

      const scannedBefore = scanWorkspaceBundledFonts(ws, 'zh-CN');
      assert.equal(scannedBefore.length, 1);
      assert.equal(scannedBefore[0].relPath, baseFontRel);
      assert.equal(scannedBefore[0].needsPatch, true);
      assert.equal(scannedBefore[0].alreadyPatched, false);
      assert.ok(scannedBefore[0].probeMissingCount >= ZH_SC_ONLY_PROBE_CHARS.length);

      // Synthetic fallback TTF containing all ZH_SC_ONLY_PROBE_CHARS + custom result chars (placed outside workspace)
      const fallbackPath = path.join(root, 'FallbackCJK.ttf');
      const fallbackCodepoints = Array.from(
        new Set([
          0x0041,
          0x4e2d,
          0x6f22,
          ...Array.from(ZH_SC_ONLY_PROBE_CHARS).map((c) => c.codePointAt(0)!),
          ...'测试文本早上好'.split('').map((c) => c.codePointAt(0)!),
        ])
      ).map((cp) => ({ cp, advance: 2048 }));
      fs.writeFileSync(
        fallbackPath,
        buildMinimalTrueTypeFont({
          familyName: 'FallbackCJK',
          unitsPerEm: 2048,
          xAvgCharWidth: 2000,
          cjkAdvanceWidth: 2048,
          hasShiftJisCodePage: false,
          hasGb2312CodePage: true,
          codepoints: fallbackCodepoints,
        })
      );

      // Seed target chars in results so collectWorkspaceTargetChars collects all ZH_SC_ONLY_PROBE_CHARS
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        JSON.stringify({
          id: 'seed1',
          file: 'GameData/script.txt',
          line: 1,
          kind: 'say',
          track: 'scenario',
          source: 'おはよう',
          target: `${ZH_SC_ONLY_PROBE_CHARS}测试文本早上好`,
          ok: true,
        }) + '\n',
        'utf8'
      );

      // 2) patchWorkspaceFont (vn_patch_font) patches in <30s, preserves metrics/Shift-JIS, sets GB2312, matches CJK advance
      const t0 = Date.now();
      const patchSummary = await patchWorkspaceFont(ws, {
        fallbackFont: fallbackPath,
        includeGb2312: false,
      });
      const elapsedMs = Date.now() - t0;
      assert.ok(elapsedMs < 30_000, `patchWorkspaceFont took too long: ${elapsedMs}ms`);
      assert.ok(patchSummary.includes('SubsetDemo'));

      const fontManifest = loadPatchedFontManifest(ws);
      assert.equal(fontManifest.entries.length, 1);
      assert.equal(fontManifest.entries[0].install_rel, baseFontRel);
      assert.equal(fontManifest.entries[0].base_family, 'SubsetDemo');
      assert.equal(fontManifest.entries[0].still_missing_count, 0);
      assert.equal(isReverserDeliverableProgressArtifact('.papercup/data/vn/fonts/manifest.json'), true);
      assert.equal(requiresResearchGuardrails('font-worker', ['vn_patch_font']), true);
      assert.equal(createVnTools(() => ws).some((t) => t.name === 'vn_patch_font'), false);
      assert.equal(createReverserTools(() => ws).some((t) => t.name === 'vn_patch_font'), true);
      assert.equal(Boolean(BUILTIN_SUBAGENTS.reverser.allowedTools?.includes('vn_patch_font')), true);

      const patchedFileAbs = path.join(wsPaths.fontsDataDir, ...fontManifest.entries[0].patched_rel.split('/'));
      assert.equal(fs.existsSync(patchedFileAbs), true);
      const patchedInfo = inspectFontBuffer(fs.readFileSync(patchedFileAbs));
      assert.equal(patchedInfo.familyName, 'SubsetDemo');
      assert.equal(patchedInfo.unitsPerEm, 1024);
      assert.equal(patchedInfo.xAvgCharWidth, 1013);
      assert.equal(patchedInfo.hasShiftJisCodePage, true);
      assert.equal(patchedInfo.hasGb2312CodePage, true);
      for (const ch of ['针', '你', '读', '懂', '这', '经']) {
        assert.equal(patchedInfo.mappedCodepoints.has(ch.codePointAt(0)!), true, `Missing patched glyph: ${ch}`);
      }

      // Verify hmtx advance width of newly added SC glyph ('你') matches base CJK advance (1024)
      const advCheck = execFileSync(
        config.pythonPath,
        [
          '-c',
          [
            'from fontTools.ttLib import TTFont; import sys',
            'tt = TTFont(sys.argv[1])',
            'g = tt.getBestCmap()[ord("你")]',
            'print(tt["hmtx"][g][0])',
          ].join('; '),
          patchedFileAbs,
        ],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      assert.equal(Number(advCheck), 1024);

      const scannedAfter = scanWorkspaceBundledFonts(ws, 'zh-CN');
      assert.equal(scannedAfter[0].alreadyPatched, true);
      assert.equal(scannedAfter[0].needsPatch, false);

      // 3) vn_writeback automatically includes patched font as kind='font_patch', action='replace'
      fs.writeFileSync(path.join(ws, 'GameData', 'script.txt'), 'おはよう\nおやすみ\n', 'utf8');
      const extractPy = [
        'import json, pathlib, sys',
        'p = pathlib.Path(sys.argv[1]) / "script.txt"',
        'lines = [l for l in p.read_text("utf-8").splitlines() if l.strip()]',
        'rows = [{"id": f"s{i}", "file": "script.txt", "line": i, "kind": "say", "source": t} for i, t in enumerate(lines, 1)]',
        'pathlib.Path(sys.argv[2]).write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", "utf-8")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, pathlib, sys',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "script.txt"',
        'orig = p.read_bytes().decode("utf-8").splitlines()',
        'by_line = {int(r["line"]): str(r.get("target") or r["source"]) for r in rows}',
        'p.write_bytes(("\\n".join(by_line.get(i, l) for i, l in enumerate(orig, 1)) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      const learned = await learnVnSkill(ws, {
        engine: 'fontbundletest',
        pipeline: 'direct',
        unpackedDir: 'GameData',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'utf-8',
      });
      assert.equal(learned.status, 'adopted', `fontbundletest learnVnSkill failed: ${JSON.stringify(learned)}`);
      await classifyVnScripts(ws, {});
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        [
          JSON.stringify({ id: 's1', file: 'script.txt', line: 1, kind: 'say', track: 'scenario', source: 'おはよう', target: '早上好', ok: true }),
          JSON.stringify({ id: 's2', file: 'script.txt', line: 2, kind: 'say', track: 'scenario', source: 'おやすみ', target: '晚安', ok: true }),
        ].join('\n') + '\n',
        'utf8'
      );

      const wb = await writebackVnCopy(ws, {});
      const fontArt = wb.artifacts.find((a) => a.kind === 'font_patch');
      assert.ok(fontArt, `Expected font_patch artifact in writeback result: ${JSON.stringify(wb.artifacts)}`);
      assert.equal(fontArt!.action, 'replace');
      assert.equal(fontArt!.install_rel, baseFontRel);
      assert.equal(fontArt!.patch_rel, `files/${baseFontRel}`);
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'files', ...baseFontRel.split('/'))), true);

      const patchManifest = JSON.parse(fs.readFileSync(wsPaths.patchManifestFile, 'utf8')) as {
        artifacts: Array<{ kind: string; action: string; install_rel: string; patch_rel: string }>;
      };
      assert.equal(
        patchManifest.artifacts.some((a) => a.kind === 'font_patch' && a.action === 'replace' && a.install_rel === baseFontRel),
        true
      );
      const installBat = fs.readFileSync(path.join(wsPaths.patchDir, 'install_patch.bat'), 'utf8');
      const uninstallBat = fs.readFileSync(path.join(wsPaths.patchDir, 'uninstall_patch.bat'), 'utf8');
      assert.ok(installBat.includes('SubsetDemo.ttf'));
      assert.ok(uninstallBat.includes('SubsetDemo.ttf'));
    });
  });

  it('18.4 verifies cross-session .papercup/data/logs/ path constants, getVnStatus filtering/sorting, compaction anchor, git checkpoint & prompt contracts', async () => {
    assert.equal(WORKSPACE_LOGS_REL, '.papercup/data/logs');
    assert.equal(WORKSPACE_HANDOFF_LOG_REL, '.papercup/data/logs/HANDOFF.md');

    await withTempWorkspace(async ({ root, ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      assert.equal(wsPaths.logsDir, path.join(ws, '.papercup', 'data', 'logs'));
      assert.equal(wsPaths.handoffLogFile, path.join(ws, '.papercup', 'data', 'logs', 'HANDOFF.md'));

      // 1) Absent logsDir -> getVnStatus omits progress log line
      const statusAbsent = getVnStatus(ws);
      assert.equal(statusAbsent.includes('进度日志：'), false);

      // 2) Empty logsDir & ignored entries (non-.md, hidden .md, directory, symlink) -> still omitted
      fs.mkdirSync(wsPaths.logsDir, { recursive: true });
      assert.equal(getVnStatus(ws).includes('进度日志：'), false);

      fs.writeFileSync(path.join(wsPaths.logsDir, 'notes.txt'), 'ignored\n', 'utf8');
      fs.writeFileSync(path.join(wsPaths.logsDir, '.hidden.md'), '# hidden\n', 'utf8');
      fs.mkdirSync(path.join(wsPaths.logsDir, 'sub.md'), { recursive: true });
      const outsideMd = path.join(root, 'outside-secret.md');
      fs.writeFileSync(outsideMd, '# outside\n', 'utf8');
      let symlinkCreated = false;
      try {
        fs.symlinkSync(outsideMd, path.join(wsPaths.logsDir, '2026-11-99.md'), 'file');
        symlinkCreated = true;
      } catch {
        // Windows without Developer Mode / admin privileges may reject symlinks
      }

      const statusIgnoredOnly = getVnStatus(ws);
      assert.equal(statusIgnoredOnly.includes('进度日志：'), false);
      if (symlinkCreated) {
        assert.equal(statusIgnoredOnly.includes('2026-11-99.md'), false);
      }

      // 3) HANDOFF.md alone in unconfigured workspace
      fs.writeFileSync(wsPaths.handoffLogFile, '# Handoff\n- Stage: inspect\n', 'utf8');
      const statusHandoffOnly = getVnStatus(ws);
      assert.ok(
        statusHandoffOnly.includes(`进度日志：${WORKSPACE_HANDOFF_LOG_REL}（新对话/续跑请先 read 交接单接续上下文）`),
        `Unexpected handoff-only status: ${statusHandoffOnly}`
      );

      // 4) Dated logs only (4 files -> top 3 descending) in unconfigured workspace
      fs.rmSync(wsPaths.handoffLogFile, { force: true });
      for (const dateName of ['2026-11-22.md', '2026-11-23.md', '2026-11-24.md', '2026-11-25.md']) {
        fs.writeFileSync(path.join(wsPaths.logsDir, dateName), `# ${dateName}\n- milestone\n`, 'utf8');
      }
      const statusDatedOnly = getVnStatus(ws);
      assert.ok(
        statusDatedOnly.includes(`进度日志：${WORKSPACE_LOGS_REL}/（近期：2026-11-25.md, 2026-11-24.md, 2026-11-23.md；`),
        `Expected top 3 descending dated logs, got: ${statusDatedOnly}`
      );
      assert.equal(statusDatedOnly.includes('2026-11-22.md'), false);
      assert.equal(statusDatedOnly.includes('notes.txt'), false);
      assert.equal(statusDatedOnly.includes('.hidden.md'), false);
      assert.equal(statusDatedOnly.includes('sub.md'), false);
      if (symlinkCreated) {
        assert.equal(statusDatedOnly.includes('2026-11-99.md'), false);
      }

      // 5) HANDOFF.md + dated logs in unconfigured workspace
      fs.writeFileSync(wsPaths.handoffLogFile, '# Handoff\n- Stage: qa\n', 'utf8');
      const statusUnconfiguredBoth = getVnStatus(ws);
      assert.ok(
        statusUnconfiguredBoth.includes(
          `进度日志：${WORKSPACE_HANDOFF_LOG_REL}；近期日志 2026-11-25.md, 2026-11-24.md, 2026-11-23.md`
        ),
        `Unexpected unconfigured combined status: ${statusUnconfiguredBoth}`
      );

      // 6) Configured workspace (papercup.toml) + compaction anchor propagation
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
        ].join('\n') + '\n',
        'utf8'
      );
      const statusConfigured = getVnStatus(ws);
      assert.ok(statusConfigured.includes('状态：就绪'), `Expected ready status, got: ${statusConfigured}`);
      assert.ok(
        statusConfigured.includes(
          `进度日志：${WORKSPACE_HANDOFF_LOG_REL}；近期日志 2026-11-25.md, 2026-11-24.md, 2026-11-23.md`
        ),
        `Expected progress log line in configured status: ${statusConfigured}`
      );

      const anchor = buildDeterministicWorkspaceAnchor(ws, 'main');
      assert.ok(
        anchor.includes(`进度日志：${WORKSPACE_HANDOFF_LOG_REL}；近期日志 2026-11-25.md, 2026-11-24.md, 2026-11-23.md`),
        `Expected compaction anchor to propagate progress log line, got: ${anchor}`
      );

      // 7) createCheckpoint (vn_checkpoint) commits HANDOFF.md and dated .md logs into local Git
      if (symlinkCreated) {
        fs.rmSync(path.join(wsPaths.logsDir, '2026-11-99.md'), { force: true });
      }
      const cp = await createCheckpoint(ws, 'milestone', 'progress logs snapshot');
      assert.equal(cp.skipped_clean, false);
      assert.ok(cp.commit && cp.commit !== 'none');
      const committedFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: ws,
        encoding: 'utf8',
        windowsHide: true,
      })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      assert.ok(committedFiles.includes(WORKSPACE_HANDOFF_LOG_REL), `Missing HANDOFF.md in git HEAD: ${committedFiles.join(', ')}`);
      assert.ok(committedFiles.includes(`${WORKSPACE_LOGS_REL}/2026-11-25.md`), `Missing 2026-11-25.md in git HEAD: ${committedFiles.join(', ')}`);

      // 8) System prompt instructions for reading HANDOFF.md after vn_status & writing logs without secrets/bulk JSONL
      for (const required of [
        '.papercup/data/logs/HANDOFF.md',
        'YYYY-MM-DD.md',
        '新对话或续跑首轮调用 `vn_status` 后',
        '优先 `read` 接续',
        '工作区进度日志与跨会话交接（`.papercup/data/logs/`）',
        '严禁在日志中堆砌大段原文/译文 JSONL，也严禁写入任何 API Key、Token 或凭据',
      ]) {
        assert.ok(
          PAPERCUP_SYSTEM_PROMPT.includes(required),
          `PAPERCUP_SYSTEM_PROMPT missing ${JSON.stringify(required)}`
        );
      }
    });
  });

  it('18.5 verifies runtime_charset policy (papercup.toml + engine.json) across resolvePatchEncodingAndHook and buildPatchBundle', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(path.join(ws, 'GameData'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.patch]',
          'runtime_charset = "shift_jis"',
          'keep_me = "ok"',
        ].join('\n') + '\n',
        'utf8'
      );

      const patchCfg = loadWorkspacePatchConfig(ws);
      assert.equal(patchCfg.runtimeCharset, 'shift_jis');
      assert.deepEqual(patchCfg.customOptions, { keep_me: 'ok' });

      assert.equal(readSkillRuntimeCharsetHint({ writeback: { runtime_charset: 'cp932' } }), 'shift_jis');
      assert.equal(readSkillRuntimeCharsetHint({ runtime_charset: 'sjis' }), 'shift_jis');
      assert.equal(readSkillRuntimeCharsetHint({ runtime_charset: 'utf-8' }), 'unicode');
      assert.equal(readSkillRuntimeCharsetHint(null), undefined);

      const profile = loadProfile(ws).profile!;
      const exeInfo = { exeRel: 'Game.exe', arch: 'x86' as const };

      // 1) Unicode script + runtime_charset='shift_jis' (via patchConfig and via skill hint)
      for (const sourceEnc of ['utf-16le-bom', 'utf-8'] as const) {
        const resFromToml = resolvePatchEncodingAndHook({
          engineKind: 'direct',
          sourceEncoding: sourceEnc,
          profile,
          patchConfig: patchCfg,
          exeInfo,
        });
        assert.equal(resFromToml.targetEncoding, sourceEnc);
        assert.equal(resFromToml.hook.needed, true);
        assert.equal(resFromToml.hook.mode, 'win32_proxy');
        assert.equal(resFromToml.hook.codepage, 936);
        assert.equal(resFromToml.hook.charset, 134);
        assert.equal(resFromToml.hook.font_name, 'SimHei');
        assert.equal(resFromToml.hook.config_file, 'papercup_patch.ini');
        assert.ok(resFromToml.hook.note?.includes('papercup_patch.ini'));

        const resFromSkill = resolvePatchEncodingAndHook({
          engineKind: 'skill',
          sourceEncoding: sourceEnc,
          profile,
          patchConfig: { mode: 'delta_patch', encoding: 'auto', hookMode: 'auto' },
          exeInfo,
          runtimeCharset: 'shift_jis',
        });
        assert.equal(resFromSkill.targetEncoding, sourceEnc);
        assert.equal(resFromSkill.hook.needed, true);
        assert.equal(resFromSkill.hook.codepage, 936);
        assert.equal(resFromSkill.hook.charset, 134);
      }

      // 2) Unicode script WITHOUT shift_jis runtime constraint keeps hook.needed === false
      const resUnicodeFree = resolvePatchEncodingAndHook({
        engineKind: 'direct',
        sourceEncoding: 'utf-8',
        profile,
        patchConfig: { mode: 'delta_patch', encoding: 'auto', hookMode: 'auto' },
        exeInfo,
      });
      assert.equal(resUnicodeFree.targetEncoding, 'utf-8');
      assert.equal(resUnicodeFree.hook.needed, false);
      assert.equal(resUnicodeFree.hook.mode, 'none');

      // 3) Legacy cp932 script for zh-CN auto-switches to gbk + hook.needed === true (936 / 134)
      const resLegacy = resolvePatchEncodingAndHook({
        engineKind: 'skill',
        sourceEncoding: 'cp932',
        profile,
        patchConfig: { mode: 'delta_patch', encoding: 'auto', hookMode: 'auto' },
        exeInfo,
      });
      assert.equal(resLegacy.targetEncoding, 'gbk');
      assert.equal(resLegacy.hook.needed, true);
      assert.equal(resLegacy.hook.codepage, 936);
      assert.equal(resLegacy.hook.charset, 134);

      // 4) buildPatchBundle end-to-end: direct skill with utf-8 script + engine.json writeback.runtime_charset = 'shift_jis'
      fs.writeFileSync(path.join(ws, 'GameData', 'script.txt'), 'おはよう\nおやすみ\n', 'utf8');
      const extractPy = [
        'import json, pathlib, sys',
        'p = pathlib.Path(sys.argv[1]) / "script.txt"',
        'lines = [l for l in p.read_text("utf-8").splitlines() if l.strip()]',
        'rows = [{"id": f"s{i}", "file": "script.txt", "line": i, "kind": "say", "source": t} for i, t in enumerate(lines, 1)]',
        'pathlib.Path(sys.argv[2]).write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", "utf-8")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, pathlib, sys',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING") or "utf-8"',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "script.txt"',
        'orig = p.read_bytes().decode("utf-8").splitlines()',
        'by_line = {int(r["line"]): str(r.get("target") or r["source"]) for r in rows}',
        'p.write_bytes(("\\n".join(by_line.get(i, l) for i, l in enumerate(orig, 1)) + "\\n").encode(enc))',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      // Remove runtime_charset from papercup.toml first so we verify engine.json propagation too
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        '[vn.localization]\nnarrative_pov = "first"\nsource_lang = "ja"\ntarget_lang = "zh-CN"\n',
        'utf8'
      );

      const learned = await learnVnSkill(ws, {
        engine: 'runtimecharsettest',
        pipeline: 'direct',
        unpackedDir: 'GameData',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'utf-8',
      });
      assert.equal(learned.status, 'adopted');

      // Inject writeback.runtime_charset = "shift_jis" into learned project harness engine.json
      const engineJsonPath = path.join(projectHarnessDir(ws, homeDir), 'engine.json');
      const engineJson = JSON.parse(fs.readFileSync(engineJsonPath, 'utf8')) as Record<string, unknown>;
      engineJson.writeback = { runtime_charset: 'shift_jis' };
      fs.writeFileSync(engineJsonPath, JSON.stringify(engineJson, null, 2) + '\n', 'utf8');

      await classifyVnScripts(ws, {});
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        [
          JSON.stringify({ id: 's1', file: 'script.txt', line: 1, kind: 'say', track: 'scenario', source: 'おはよう', target: '早上好', ok: true }),
          JSON.stringify({ id: 's2', file: 'script.txt', line: 2, kind: 'say', track: 'scenario', source: 'おやすみ', target: '晚安', ok: true }),
        ].join('\n') + '\n',
        'utf8'
      );

      const bundleWithHook = await buildPatchBundle(ws, profile, loadProfileMemory(ws, homeDir, profile), { homeDir });
      assert.equal(bundleWithHook.encoding, 'utf-8');
      assert.equal(bundleWithHook.hook.needed, true);
      assert.equal(bundleWithHook.hook.codepage, 936);
      assert.equal(bundleWithHook.hook.charset, 134);
      const iniPath = path.join(wsPaths.patchDir, 'papercup_patch.ini');
      assert.equal(fs.existsSync(iniPath), true);
      const iniText = fs.readFileSync(iniPath, 'utf8');
      assert.ok(iniText.includes('codepage=936'));
      assert.ok(iniText.includes('charset=134'));
      assert.ok(iniText.includes('encoding=utf-8'));

      // Remove runtime_charset from engine.json -> Unicode bundle drops papercup_patch.ini
      delete engineJson.writeback;
      fs.writeFileSync(engineJsonPath, JSON.stringify(engineJson, null, 2) + '\n', 'utf8');
      const bundleNoHook = await buildPatchBundle(ws, profile, loadProfileMemory(ws, homeDir, profile), { homeDir });
      assert.equal(bundleNoHook.encoding, 'utf-8');
      assert.equal(bundleNoHook.hook.needed, false);
      assert.equal(fs.existsSync(iniPath), false);
    });
  });

  it('18.6 verifies zero-DLL sjis_fullwidth_slots font remapping, char_remap.json, applyCharRemapText & PAPERCUP_CHAR_REMAP_PATH injection', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(path.join(ws, 'GameData', 'dat'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(
        path.join(ws, 'papercup.toml'),
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.patch]',
          'encoding = "cp932"',
        ].join('\n') + '\n',
        'utf8'
      );

      const baseFontRel = 'GameData/dat/SlotDemo.ttf';
      fs.writeFileSync(
        path.join(ws, ...baseFontRel.split('/')),
        buildMinimalTrueTypeFont({
          familyName: 'SlotDemo',
          unitsPerEm: 1024,
          xAvgCharWidth: 1013,
          cjkAdvanceWidth: 1024,
          hasShiftJisCodePage: true,
          hasGb2312CodePage: false,
        })
      );

      const nonSjisChars = ['你', '读', '针', '懂', '这', '经'];
      const sjisSharedChars = ['中', '漢', '上', '好'];
      const fallbackPath = path.join(root, 'FallbackSlotCJK.ttf');
      const fallbackCodepoints = Array.from(
        new Set([0x0041, ...[...nonSjisChars, ...sjisSharedChars].map((c) => c.codePointAt(0)!)])
      ).map((cp) => ({ cp, advance: 2048 }));
      fs.writeFileSync(
        fallbackPath,
        buildMinimalTrueTypeFont({
          familyName: 'FallbackSlotCJK',
          unitsPerEm: 2048,
          xAvgCharWidth: 2000,
          cjkAdvanceWidth: 2048,
          hasShiftJisCodePage: false,
          hasGb2312CodePage: true,
          codepoints: fallbackCodepoints,
        })
      );

      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        [
          JSON.stringify({
            id: 'r1',
            file: 'script.txt',
            line: 1,
            kind: 'say',
            track: 'scenario',
            source: 'おはよう',
            target: '你读中针懂这经',
            ok: true,
          }),
          JSON.stringify({
            id: 'r2',
            file: 'script.txt',
            line: 2,
            kind: 'say',
            track: 'scenario',
            source: 'おやすみ',
            target: '好上中',
            ok: true,
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      const patchSummary = await patchWorkspaceFont(ws, {
        fallbackFont: fallbackPath,
        includeGb2312: false,
        remapMode: 'sjis_fullwidth_slots',
      });
      assert.ok(patchSummary.includes('SlotDemo'));
      assert.ok(patchSummary.includes('char_remap.json'));
      assert.ok(patchSummary.includes('PAPERCUP_CHAR_REMAP_PATH'));

      const manifest = loadPatchedFontManifest(ws);
      assert.equal(manifest.entries.length, 1);
      assert.equal(manifest.entries[0].remap_mode, 'sjis_fullwidth_slots');
      assert.equal(manifest.entries[0].remapped_count, nonSjisChars.length);
      assert.equal(manifest.entries[0].remap_rel, WORKSPACE_FONT_REMAP_REL);

      assert.equal(WORKSPACE_FONT_REMAP_REL, '.papercup/data/vn/fonts/char_remap.json');
      assert.equal(wsPaths.fontRemapFile, path.join(ws, '.papercup', 'data', 'vn', 'fonts', 'char_remap.json'));
      const remap = loadWorkspaceCharRemap(ws);
      assert.ok(remap, 'Expected loadWorkspaceCharRemap to load char_remap.json');
      assert.equal(remap!.schema, 1);
      assert.equal(remap!.mode, 'sjis_fullwidth_slots');
      assert.equal(remap!.base_family, 'SlotDemo');
      assert.equal(remap!.remapped_count, nonSjisChars.length);
      assert.equal(remap!.overflow_count, 0);

      for (const ch of nonSjisChars) {
        assert.ok(typeof remap!.char_map[ch] === 'string' && remap!.char_map[ch].length === 1, `Expected remap for ${ch}`);
      }
      assert.equal(remap!.char_map['中'], undefined, 'CP932-encodable Hanzi 中 must NOT be remapped');

      // Verify all slot targets are unique, roundtrip in cp932, and map in output font cmap + hmtx
      const slotValues = Object.values(remap!.char_map);
      assert.equal(new Set(slotValues).size, slotValues.length, 'Remapped slots must be unique');
      const patchedFontAbs = path.join(wsPaths.fontsDataDir, ...manifest.entries[0].patched_rel.split('/'));

      const fontCheckOut = execFileSync(
        config.pythonPath,
        [
          '-c',
          [
            'import json, sys',
            'from fontTools.ttLib import TTFont',
            'tt = TTFont(sys.argv[1])',
            'cmap_data = json.loads(sys.argv[2])',
            'hmtx = tt["hmtx"]',
            'subtables = [s for s in tt["cmap"].tables if s.platformID in (0, 3) and s.format in (4, 12)]',
            'assert len(subtables) > 0',
            'for src_ch, slot_ch in cmap_data.items():',
            '    raw = slot_ch.encode("cp932")',
            '    assert len(raw) == 2 and raw.decode("cp932") == slot_ch, (src_ch, slot_ch, raw)',
            '    src_cp, slot_cp = ord(src_ch), ord(slot_ch)',
            '    for sub in subtables:',
            '        g_src = sub.cmap.get(src_cp)',
            '        g_slot = sub.cmap.get(slot_cp)',
            '        assert g_src is not None and g_slot == g_src, (src_ch, slot_ch, sub.platformID, sub.format, g_src, g_slot)',
            '        assert hmtx[g_slot][0] == 1024',
            'print("SLOT_FONT_VERIFIED")',
          ].join('\n'),
          patchedFontAbs,
          JSON.stringify(remap!.char_map),
        ],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      assert.equal(fontCheckOut, 'SLOT_FONT_VERIFIED');

      // Verify applyCharRemapText exact lossless remapping
      const remappedLine = applyCharRemapText('你读中针懂这经', remap!.char_map);
      assert.equal(
        remappedLine,
        `${remap!.char_map['你']}${remap!.char_map['读']}中${remap!.char_map['针']}${remap!.char_map['懂']}${remap!.char_map['这']}${remap!.char_map['经']}`
      );
      assert.equal(applyCharRemapText('', remap!.char_map), '');
      assert.equal(applyCharRemapText('ABC中', remap!.char_map), 'ABC中');

      // Verify buildPatchBundle injects PAPERCUP_CHAR_REMAP_PATH into apply.py env
      fs.writeFileSync(path.join(ws, 'GameData', 'script.txt'), encodeText('おはよう\nおやすみ\n', 'cp932'));
      const extractPy = [
        'import json, pathlib, sys',
        'p = pathlib.Path(sys.argv[1]) / "script.txt"',
        'lines = [l for l in p.read_bytes().decode("cp932").splitlines() if l.strip()]',
        'rows = [{"id": f"s{i}", "file": "script.txt", "line": i, "kind": "say", "source": t} for i, t in enumerate(lines, 1)]',
        'pathlib.Path(sys.argv[2]).write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", "utf-8")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, pathlib, sys',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING") or "cp932"',
        'remap_path = os.environ.get("PAPERCUP_CHAR_REMAP_PATH")',
        'char_map = json.loads(pathlib.Path(remap_path).read_text("utf-8"))["char_map"] if (remap_path and pathlib.Path(remap_path).is_file()) else {}',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "script.txt"',
        'orig = p.read_bytes().decode("cp932").splitlines()',
        'by_line = {}',
        'for r in rows:',
        '    txt = str(r.get("target") or r["source"])',
        '    by_line[int(r["line"])] = "".join(char_map.get(c, c) for c in txt)',
        'p.write_bytes(("\\n".join(by_line.get(i, l) for i, l in enumerate(orig, 1)) + "\\n").encode(enc))',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      const learned = await learnVnSkill(ws, {
        engine: 'slotremaptest',
        pipeline: 'direct',
        unpackedDir: 'GameData',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'cp932',
      });
      assert.equal(learned.status, 'adopted');
      await classifyVnScripts(ws, {});

      const slotProfile = loadProfile(ws).profile!;
      const bundle = await buildPatchBundle(ws, slotProfile, loadProfileMemory(ws, homeDir, slotProfile), { homeDir });
      assert.equal(bundle.encoding, 'cp932');
      assert.equal(bundle.hook.needed, false);
      assert.equal(
        bundle.artifacts.some((a) => a.kind === 'font_patch' && a.install_rel === baseFontRel),
        true
      );
      const patchedScriptBuf = fs.readFileSync(path.join(wsPaths.patchDir, 'files', 'GameData', 'script.txt'));
      const decodedPatched = execFileSync(
        config.pythonPath,
        ['-c', 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).read_bytes().decode("cp932"))', path.join(wsPaths.patchDir, 'files', 'GameData', 'script.txt')],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      assert.equal(decodedPatched.replace(/\r\n/g, '\n'), `${remappedLine}\n好上中`);
      assert.ok(patchedScriptBuf.length > 0);
    });
  });

  it('18.7 verifies PAPERCUP_SYSTEM_PROMPT, BUILTIN_SUBAGENTS.reverser.systemPrompt & vn-reverser/SKILL.md policy alignment', () => {
    const skillPath = path.join(resolveBuiltinReverserSkillDir(), 'SKILL.md');
    const skillMd = fs.readFileSync(skillPath, 'utf8');
    const reverserPrompt = BUILTIN_SUBAGENTS.reverser.systemPrompt;

    for (const required of [
      'Shift-JIS / CP932',
      'runtime_charset = "shift_jis"',
      'sjis_fullwidth_slots',
      'PAPERCUP_CHAR_REMAP_PATH',
      'fontTools',
      'delegate_task(role="reverser"',
    ]) {
      assert.ok(
        PAPERCUP_SYSTEM_PROMPT.includes(required),
        `PAPERCUP_SYSTEM_PROMPT missing ${JSON.stringify(required)}`
      );
    }

    for (const [label, text] of [
      ['BUILTIN_SUBAGENTS.reverser.systemPrompt', reverserPrompt],
      ['vn-reverser/SKILL.md', skillMd],
    ] as const) {
      for (const required of [
        'Shift-JIS -> GBK, Unicode -> Unicode',
        'SHIFTJIS_CHARSET',
        'runtime_charset = "shift_jis"',
        'sjis_fullwidth_slots',
        'PAPERCUP_CHAR_REMAP_PATH',
        'vn_patch_font',
      ]) {
        assert.ok(text.includes(required), `${label} missing ${JSON.stringify(required)}`);
      }
    }
  });
});

/* ========================= Suite 19: TODO #122 Win32 Proxy DLL & Pipeline Integration ========================= */

function makeSyntheticPeWithImports(arch: 'x86' | 'x64', dllNames: readonly string[]): Buffer {
  const peOffset = 0x80;
  const optOff = peOffset + 24;
  const isX64 = arch === 'x64';
  const sizeOfOptionalHeader = isX64 ? 0xf0 : 0xe0;
  const rawSectionOff = 0x200;
  const sectionVirtualAddr = 0x1000;
  const sectionRawSize = 0x400;

  const buf = Buffer.alloc(rawSectionOff + sectionRawSize, 0);
  // DOS Header
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  buf.writeUInt32LE(peOffset, 0x3c);

  // COFF Header
  buf[peOffset] = 0x50; // 'P'
  buf[peOffset + 1] = 0x45; // 'E'
  buf.writeUInt16LE(isX64 ? 0x8664 : 0x014c, peOffset + 4);
  buf.writeUInt16LE(1, peOffset + 6); // NumberOfSections
  buf.writeUInt16LE(sizeOfOptionalHeader, peOffset + 20);

  // Optional Header
  buf.writeUInt16LE(isX64 ? 0x20b : 0x10b, optOff);
  buf.writeUInt32LE(rawSectionOff, optOff + 60); // SizeOfHeaders
  const numRvaOffset = isX64 ? optOff + 108 : optOff + 92;
  const importDirOffset = isX64 ? optOff + 120 : optOff + 104;
  buf.writeUInt32LE(16, numRvaOffset);

  if (dllNames.length > 0) {
    buf.writeUInt32LE(sectionVirtualAddr, importDirOffset);
    buf.writeUInt32LE((dllNames.length + 1) * 20, importDirOffset + 4);
  }

  // Section Header (.rdata)
  const secOff = optOff + sizeOfOptionalHeader;
  Buffer.from('.rdata\0\0', 'ascii').copy(buf, secOff);
  buf.writeUInt32LE(0x1000, secOff + 8); // VirtualSize
  buf.writeUInt32LE(sectionVirtualAddr, secOff + 12); // VirtualAddress
  buf.writeUInt32LE(sectionRawSize, secOff + 16); // SizeOfRawData
  buf.writeUInt32LE(rawSectionOff, secOff + 20); // PointerToRawData

  // IMAGE_IMPORT_DESCRIPTOR[] + ASCII DLL names inside .rdata
  if (dllNames.length > 0) {
    let strCursor = (dllNames.length + 1) * 20;
    for (let i = 0; i < dllNames.length; i++) {
      const descOff = rawSectionOff + i * 20;
      const nameStr = `${dllNames[i]}\0`;
      const nameRva = sectionVirtualAddr + strCursor;
      buf.writeUInt32LE(nameRva, descOff + 12); // Name RVA
      buf.writeUInt32LE(sectionVirtualAddr + 0x300 + i * 4, descOff + 16); // FirstThunk
      Buffer.from(nameStr, 'latin1').copy(buf, rawSectionOff + strCursor);
      strCursor += nameStr.length;
    }
  }

  return buf;
}

describe('19. Win32 Proxy DLL: PE import parser, Phase 2 bundling, smoke injection & live x64 execution', () => {
  it('19.1 parses PE32/PE32+ import directories, selects proxy DLL, and rejects cross-architecture tampering', async () => {
    await withTempWorkspace(async ({ root }) => {
      const x86WinmmExe = path.join(root, 'x86_winmm.exe');
      const x64VersionExe = path.join(root, 'x64_version.exe');
      const x64KernelOnlyExe = path.join(root, 'x64_kernel_only.exe');
      const nonPeFile = path.join(root, 'not_a_pe.bin');
      const truncatedPeFile = path.join(root, 'truncated_mz.exe');

      fs.writeFileSync(x86WinmmExe, makeSyntheticPeWithImports('x86', ['KERNEL32.dll', 'WINMM.dll', 'winmm.dll']));
      fs.writeFileSync(x64VersionExe, makeSyntheticPeWithImports('x64', ['KERNEL32.dll', 'WINMM.dll', 'VERSION.dll']));
      fs.writeFileSync(x64KernelOnlyExe, makeSyntheticPeWithImports('x64', ['KERNEL32.dll']));
      fs.writeFileSync(nonPeFile, Buffer.from('not a pe executable at all', 'utf8'));
      fs.writeFileSync(truncatedPeFile, Buffer.from('MZ' + '\0'.repeat(20), 'latin1'));

      assert.equal(readPeMachineArch(x86WinmmExe), 'x86');
      assert.equal(readPeMachineArch(x64VersionExe), 'x64');
      assert.equal(readPeMachineArch(nonPeFile), 'unknown');
      assert.equal(readPeMachineArch(truncatedPeFile), 'unknown');

      assert.deepEqual(readPeImportedDlls(x86WinmmExe), ['kernel32.dll', 'winmm.dll']);
      assert.deepEqual(readPeImportedDlls(x64VersionExe), ['kernel32.dll', 'winmm.dll', 'version.dll']);
      assert.deepEqual(readPeImportedDlls(x64KernelOnlyExe), ['kernel32.dll']);
      assert.deepEqual(readPeImportedDlls(nonPeFile), []);
      assert.deepEqual(readPeImportedDlls(truncatedPeFile), []);
      assert.deepEqual(readPeImportedDlls(path.join(root, 'missing.exe')), []);

      assert.equal(chooseProxyDllName(x64VersionExe), 'version.dll');
      assert.equal(chooseProxyDllName(x86WinmmExe), 'winmm.dll');
      assert.equal(chooseProxyDllName(x64KernelOnlyExe), 'version.dll');
      assert.equal(chooseProxyDllName(null), 'version.dll');
      assert.equal(chooseProxyDllName(x64VersionExe, 'winmm.dll'), 'winmm.dll');

      assert.equal(normalizeProxyDllName('VERSION'), 'version.dll');
      assert.equal(normalizeProxyDllName('  WinMM.DLL '), 'winmm.dll');
      assert.equal(normalizeProxyDllName('d3d9.dll'), undefined);
      assert.equal(normalizeProxyDllName(''), undefined);
      assert.equal(normalizeProxyDllName(42), undefined);

      // Mock binDir with matching x86/x64 DLLs
      const binDir = path.join(root, 'mock-bin');
      fs.mkdirSync(path.join(binDir, 'x86'), { recursive: true });
      fs.mkdirSync(path.join(binDir, 'x64'), { recursive: true });
      const x86ProxyBytes = makeSyntheticPeWithImports('x86', ['KERNEL32.dll']);
      const x64ProxyBytes = makeSyntheticPeWithImports('x64', ['KERNEL32.dll']);
      const x86ProxyPath = path.join(binDir, 'x86', 'version.dll');
      const x64ProxyPath = path.join(binDir, 'x64', 'version.dll');
      fs.writeFileSync(x86ProxyPath, x86ProxyBytes);
      fs.writeFileSync(x64ProxyPath, x64ProxyBytes);

      const resolvedX64 = resolvePrebuiltProxyDll('x64', 'version.dll', { binDir });
      assert.ok(resolvedX64);
      assert.equal(path.resolve(resolvedX64!.path), path.resolve(x64ProxyPath));
      assert.equal(resolvedX64!.arch, 'x64');
      assert.equal(resolvedX64!.name, 'version.dll');
      assert.equal(resolvedX64!.bytes, x64ProxyBytes.length);
      assert.equal(resolvedX64!.sha256, crypto.createHash('sha256').update(x64ProxyBytes).digest('hex'));

      const resolvedX86 = resolvePrebuiltProxyDll('x86', 'version.dll', { binDir });
      assert.ok(resolvedX86);
      assert.equal(path.resolve(resolvedX86!.path), path.resolve(x86ProxyPath));
      assert.equal(resolvedX86!.sha256, crypto.createHash('sha256').update(x86ProxyBytes).digest('hex'));

      // Cross-architecture tampering: x86 PE placed under binDir/x64/version.dll must be REJECTED
      const tamperedBinDir = path.join(root, 'tampered-bin');
      fs.mkdirSync(path.join(tamperedBinDir, 'x64'), { recursive: true });
      fs.writeFileSync(path.join(tamperedBinDir, 'x64', 'version.dll'), x86ProxyBytes);
      assert.equal(resolvePrebuiltProxyDll('x64', 'version.dll', { binDir: tamperedBinDir }), null);
      assert.equal(resolvePrebuiltProxyDll('unknown', 'version.dll', { binDir }), null);
    });
  });

  it('19.2 bundles Phase 2 Proxy DLL + INI in buildPatchBundle, falls back to Phase 1 when missing, and omits on hook_mode="none"', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      const nestedGameDir = path.join(ws, 'StartData', 'GameData');
      fs.mkdirSync(nestedGameDir, { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });

      fs.writeFileSync(
        path.join(nestedGameDir, 'Game.exe'),
        makeSyntheticPeWithImports('x64', ['KERNEL32.dll', 'WINMM.dll'])
      );
      const origScriptText = 'おはよう\nおやすみ\n';
      fs.writeFileSync(path.join(nestedGameDir, 'script.txt'), origScriptText, 'utf8');

      fs.writeFileSync(
        wsPaths.papercupTomlFile,
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.patch]',
          'runtime_charset = "shift_jis"',
          'force_font_name = true',
          'enable_width_compat = true',
        ].join('\n') + '\n',
        'utf8'
      );

      const patchCfg = loadWorkspacePatchConfig(ws);
      assert.equal(patchCfg.runtimeCharset, 'shift_jis');
      assert.equal(patchCfg.forceFontName, true);
      assert.equal(patchCfg.enableWidthCompat, true);

      const extractPy = [
        'import json, pathlib, sys',
        'p = pathlib.Path(sys.argv[1]) / "script.txt"',
        'lines = [l for l in p.read_text("utf-8").splitlines() if l.strip()]',
        'rows = [{"id": f"s{i}", "file": "script.txt", "line": i, "kind": "say", "source": t} for i, t in enumerate(lines, 1)]',
        'pathlib.Path(sys.argv[2]).write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", "utf-8")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, pathlib, sys',
        'enc = os.environ.get("PAPERCUP_TARGET_ENCODING") or "utf-8"',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "script.txt"',
        'orig = p.read_bytes().decode("utf-8").splitlines()',
        'by_line = {int(r["line"]): str(r.get("target") or r["source"]) for r in rows}',
        'p.write_bytes(("\\n".join(by_line.get(i, l) for i, l in enumerate(orig, 1)) + "\\n").encode(enc))',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      const learned = await learnVnSkill(ws, {
        engine: 'proxybundletest',
        pipeline: 'direct',
        unpackedDir: 'StartData/GameData',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'utf-8',
      });
      assert.equal(learned.status, 'adopted');
      await classifyVnScripts(ws, {});
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        [
          JSON.stringify({ id: 's1', file: 'script.txt', line: 1, kind: 'say', track: 'scenario', source: 'おはよう', target: '早上好', ok: true }),
          JSON.stringify({ id: 's2', file: 'script.txt', line: 2, kind: 'say', track: 'scenario', source: 'おやすみ', target: '晚安', ok: true }),
        ].join('\n') + '\n',
        'utf8'
      );

      const proxyBinDir = path.join(root, 'proxy-bin');
      const emptyBinDir = path.join(root, 'empty-bin');
      fs.mkdirSync(path.join(proxyBinDir, 'x64'), { recursive: true });
      fs.mkdirSync(emptyBinDir, { recursive: true });
      const winmmBytes = makeSyntheticPeWithImports('x64', ['KERNEL32.dll']);
      fs.writeFileSync(path.join(proxyBinDir, 'x64', 'winmm.dll'), winmmBytes);

      const profile = loadProfile(ws).profile!;
      const memory = loadProfileMemory(ws, homeDir, profile);

      // 1) Phase 2 bundling with matching-arch winmm.dll
      const phase2 = await buildPatchBundle(ws, profile, memory, { homeDir, proxyBinDir });
      assert.equal(phase2.hook_needed, true);
      assert.equal(phase2.hook.needed, true);
      assert.equal(phase2.hook.phase, 'phase2_proxy_bundled');
      assert.equal(phase2.hook.proxy_bundled, true);
      assert.equal(phase2.hook.proxy_dll, 'winmm.dll');
      assert.equal(phase2.hook.target_exe, 'StartData/GameData/Game.exe');
      assert.equal(phase2.hook.target_arch, 'x64');
      assert.equal(phase2.hook.force_font_name, true);
      assert.equal(phase2.hook.enable_width_compat, true);

      const proxyArt = phase2.artifacts.find((a) => a.kind === 'hook_proxy');
      const iniArt = phase2.artifacts.find((a) => a.kind === 'hook_config');
      assert.ok(proxyArt);
      assert.ok(iniArt);
      assert.equal(proxyArt!.patch_rel, 'files/StartData/GameData/winmm.dll');
      assert.equal(proxyArt!.install_rel, 'StartData/GameData/winmm.dll');
      assert.equal(proxyArt!.action, 'add');
      assert.equal(proxyArt!.bytes, winmmBytes.length);
      assert.equal(iniArt!.patch_rel, 'files/StartData/GameData/papercup_patch.ini');
      assert.equal(iniArt!.install_rel, 'StartData/GameData/papercup_patch.ini');

      const bundledProxyPath = path.join(wsPaths.patchDir, 'files', 'StartData', 'GameData', 'winmm.dll');
      const bundledIniPath = path.join(wsPaths.patchDir, 'files', 'StartData', 'GameData', 'papercup_patch.ini');
      assert.equal(fs.existsSync(bundledProxyPath), true);
      assert.equal(fs.existsSync(bundledIniPath), true);
      assert.equal(fs.existsSync(path.join(wsPaths.patchDir, 'papercup_patch.ini')), false);
      const iniText = fs.readFileSync(bundledIniPath, 'utf8');
      assert.ok(iniText.includes('force_font_name=1'));
      assert.ok(iniText.includes('enable_width_compat=1'));
      assert.ok(iniText.includes('proxy_dll=winmm.dll'));
      assert.ok(iniText.includes('codepage=936'));
      assert.ok(iniText.includes('charset=134'));

      const installBatBytes = fs.readFileSync(phase2.install_script);
      const uninstallBatBytes = fs.readFileSync(phase2.uninstall_script);
      for (const batBytes of [installBatBytes, uninstallBatBytes]) {
        for (let i = 0; i < batBytes.length; i++) {
          assert.ok(batBytes[i] <= 0x7e, `Non-ASCII byte 0x${batBytes[i].toString(16)} in batch script`);
        }
        const batText = batBytes.toString('ascii');
        assert.equal(batText.includes('\r\n'), true);
        assert.ok(batText.includes('StartData\\GameData\\winmm.dll'));
        assert.ok(batText.includes('StartData\\GameData\\papercup_patch.ini'));
      }

      if (process.platform === 'win32') {
        const gameCopy = path.join(root, 'game-copy');
        fs.mkdirSync(path.join(gameCopy, 'StartData', 'GameData'), { recursive: true });
        fs.writeFileSync(
          path.join(gameCopy, 'StartData', 'GameData', 'Game.exe'),
          fs.readFileSync(path.join(nestedGameDir, 'Game.exe'))
        );
        fs.writeFileSync(path.join(gameCopy, 'StartData', 'GameData', 'script.txt'), origScriptText, 'utf8');

        const inst = spawnSync('cmd.exe', ['/c', phase2.install_script, gameCopy], {
          cwd: wsPaths.patchDir,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(inst.status, 0, `install_patch.bat failed: ${inst.stdout}\n${inst.stderr}`);
        assert.ok(fs.readFileSync(path.join(gameCopy, 'StartData', 'GameData', 'winmm.dll')).equals(winmmBytes));
        assert.equal(fs.existsSync(path.join(gameCopy, 'StartData', 'GameData', 'papercup_patch.ini')), true);
        assert.ok(fs.readFileSync(path.join(gameCopy, 'StartData', 'GameData', 'script.txt'), 'utf8').includes('早上好'));

        const uninst = spawnSync('cmd.exe', ['/c', phase2.uninstall_script, gameCopy], {
          cwd: wsPaths.patchDir,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(uninst.status, 0, `uninstall_patch.bat failed: ${uninst.stdout}\n${uninst.stderr}`);
        assert.equal(fs.existsSync(path.join(gameCopy, 'StartData', 'GameData', 'winmm.dll')), false);
        assert.equal(fs.existsSync(path.join(gameCopy, 'StartData', 'GameData', 'papercup_patch.ini')), false);
        assert.equal(fs.readFileSync(path.join(gameCopy, 'StartData', 'GameData', 'script.txt'), 'utf8'), origScriptText);
      }

      // 2) Missing prebuilt DLL -> graceful Phase 1 fallback
      const phase1 = await buildPatchBundle(ws, profile, memory, { homeDir, proxyBinDir: emptyBinDir });
      assert.equal(phase1.hook.needed, true);
      assert.equal(phase1.hook.phase, 'phase1_config_ready');
      assert.equal(phase1.hook.proxy_bundled, false);
      assert.equal(phase1.hook.proxy_dll, 'winmm.dll');
      assert.equal(phase1.artifacts.some((a) => a.kind === 'hook_config'), true);
      assert.equal(phase1.artifacts.some((a) => a.kind === 'hook_proxy'), false);
      assert.equal(fs.existsSync(bundledProxyPath), false);
      assert.equal(fs.existsSync(bundledIniPath), true);

      // 3) hook_mode = "none" -> hook.needed === false, neither ini nor proxy emitted
      fs.writeFileSync(
        wsPaths.papercupTomlFile,
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.patch]',
          'runtime_charset = "shift_jis"',
          'hook_mode = "none"',
        ].join('\n') + '\n',
        'utf8'
      );
      const noHook = await buildPatchBundle(ws, profile, memory, { homeDir, proxyBinDir });
      assert.equal(noHook.hook_needed, false);
      assert.equal(noHook.hook.needed, false);
      assert.equal(noHook.hook.mode, 'none');
      assert.equal(noHook.artifacts.some((a) => a.kind === 'hook_config' || a.kind === 'hook_proxy'), false);
      assert.equal(fs.existsSync(bundledProxyPath), false);
      assert.equal(fs.existsSync(bundledIniPath), false);
    });
  });

  it('19.3 injects runtime_charset, PAPERCUP_CHAR_REMAP_PATH, INI & Proxy DLL in preTranslateProbe and prepareSmokeSandbox', async () => {
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      const gameSubdir = path.join(ws, 'bin');
      fs.mkdirSync(gameSubdir, { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });
      fs.mkdirSync(wsPaths.fontsDataDir, { recursive: true });

      const exeBytes = makeSyntheticPeWithImports('x64', ['KERNEL32.dll', 'VERSION.dll']);
      fs.writeFileSync(path.join(gameSubdir, 'Game.exe'), exeBytes);
      const origScript = '「おはようございます！」\n';
      fs.writeFileSync(path.join(gameSubdir, 'script.txt'), origScript, 'utf8');

      fs.writeFileSync(
        wsPaths.papercupTomlFile,
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.smoke]',
          'enabled = true',
          'vision_enabled = false',
        ].join('\n') + '\n',
        'utf8'
      );

      // Write char_remap.json so PAPERCUP_CHAR_REMAP_PATH is injected
      fs.writeFileSync(
        wsPaths.fontRemapFile,
        JSON.stringify({ schema: 1, mode: 'sjis_fullwidth_slots', char_map: { 探: '亜', 针: '唖' } }, null, 2) + '\n',
        'utf8'
      );

      const extractPy = [
        'import json, pathlib, sys',
        'p = pathlib.Path(sys.argv[1]) / "script.txt"',
        'lines = [l for l in p.read_text("utf-8").splitlines() if l.strip()]',
        'rows = [{"id": f"s{i}", "file": "script.txt", "line": i, "kind": "say", "source": t} for i, t in enumerate(lines, 1)]',
        'pathlib.Path(sys.argv[2]).write_text("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n", "utf-8")',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, os, pathlib, sys',
        'remap_path = os.environ.get("PAPERCUP_CHAR_REMAP_PATH")',
        'char_map = json.loads(pathlib.Path(remap_path).read_text("utf-8"))["char_map"] if (remap_path and pathlib.Path(remap_path).is_file()) else {}',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "script.txt"',
        'orig = p.read_bytes().decode("utf-8").splitlines()',
        'by_line = {}',
        'for r in rows:',
        '    txt = str(r.get("target") or r["source"])',
        '    by_line[int(r["line"])] = "".join(char_map.get(c, c) for c in txt)',
        'p.write_bytes(("\\n".join(by_line.get(i, l) for i, l in enumerate(orig, 1)) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      const learned = await learnVnSkill(ws, {
        engine: 'smokeproxytest',
        pipeline: 'direct',
        unpackedDir: 'bin',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        encoding: 'utf-8',
      });
      assert.equal(learned.status, 'adopted');

      // Propagate writeback.runtime_charset = "shift_jis" via project harness engine.json
      const engineJsonPath = path.join(projectHarnessDir(ws, homeDir), 'engine.json');
      const engineJson = JSON.parse(fs.readFileSync(engineJsonPath, 'utf8')) as Record<string, unknown>;
      engineJson.writeback = { runtime_charset: 'shift_jis' };
      fs.writeFileSync(engineJsonPath, JSON.stringify(engineJson, null, 2) + '\n', 'utf8');

      await classifyVnScripts(ws, {});

      const proxyBinDir = path.join(root, 'proxy-bin');
      const emptyBinDir = path.join(root, 'empty-bin');
      fs.mkdirSync(path.join(proxyBinDir, 'x64'), { recursive: true });
      fs.mkdirSync(emptyBinDir, { recursive: true });
      const versionBytes = makeSyntheticPeWithImports('x64', ['KERNEL32.dll']);
      fs.writeFileSync(path.join(proxyBinDir, 'x64', 'version.dll'), versionBytes);

      const nonUniformPng = path.join(root, 'frame.png');
      fs.writeFileSync(nonUniformPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      let sawProxyInSandbox = false;
      let sawIniInSandbox = false;
      let sawRemappedInSandbox = false;
      const profile = loadProfile(ws).profile!;

      const probeRes = await runSmokeTest(ws, profile, {
        homeDir,
        preTranslateProbe: true,
        proxyBinDir,
        driver: {
          run: async (input) => {
            const sbProxy = path.join(input.sandboxDir, 'bin', 'version.dll');
            const sbIni = path.join(input.sandboxDir, 'bin', 'papercup_patch.ini');
            const sbScript = path.join(input.sandboxDir, 'bin', 'script.txt');
            sawProxyInSandbox = fs.existsSync(sbProxy) && fs.readFileSync(sbProxy).equals(versionBytes);
            sawIniInSandbox =
              fs.existsSync(sbIni) &&
              fs.readFileSync(sbIni, 'utf8').includes('codepage=936') &&
              fs.readFileSync(sbIni, 'utf8').includes('proxy_dll=version.dll');
            sawRemappedInSandbox =
              fs.existsSync(sbScript) && fs.readFileSync(sbScript, 'utf8').includes('亜唖');
            return makeBaseDriverResult({
              stepsAdvanced: 4,
              frames: [
                { label: 'title', step: 0, path: nonUniformPng, relPath: 'frame.png', hash: 'h1', width: 32, height: 32 },
              ],
            });
          },
        },
      });
      assert.equal(probeRes.report.ok, true);
      assert.equal(probeRes.report.usedProxyDll, 'version.dll');
      assert.equal(sawProxyInSandbox, true);
      assert.equal(sawIniInSandbox, true);
      assert.equal(sawRemappedInSandbox, true);
      assert.equal(fs.existsSync(path.join(wsPaths.smokeLastProbeDir, 'overlay', 'bin', 'version.dll')), true);
      assert.equal(fs.existsSync(path.join(wsPaths.smokeLastProbeDir, 'overlay', 'bin', 'papercup_patch.ini')), true);

      // Prepare results for buildPatchBundle + prepareSmokeSandbox verification
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        JSON.stringify({ id: 's1', file: 'script.txt', line: 1, kind: 'say', track: 'scenario', source: '「おはようございます！」', target: '「早上好，探针！」', ok: true }) + '\n',
        'utf8'
      );
      const memory = loadProfileMemory(ws, homeDir, profile);

      // A) phase2_proxy_bundled manifest -> prepareSmokeSandbox stages bundled proxy + ini
      const phase2Bundle = await buildPatchBundle(ws, profile, memory, { homeDir, proxyBinDir });
      assert.equal(phase2Bundle.hook.phase, 'phase2_proxy_bundled');
      const sbPhase2 = prepareSmokeSandbox(ws, phase2Bundle.manifest_path);
      try {
        assert.equal(sbPhase2.usedProxyDll, 'version.dll');
        assert.ok(fs.readFileSync(path.join(sbPhase2.sandboxDir, 'bin', 'version.dll')).equals(versionBytes));
        assert.equal(fs.existsSync(path.join(sbPhase2.sandboxDir, 'bin', 'papercup_patch.ini')), true);
      } finally {
        sbPhase2.cleanup();
      }

      // B) phase1_config_ready manifest -> prepareSmokeSandbox overlays proxy via proxyBinDir
      const phase1Bundle = await buildPatchBundle(ws, profile, memory, { homeDir, proxyBinDir: emptyBinDir });
      assert.equal(phase1Bundle.hook.phase, 'phase1_config_ready');
      assert.equal(phase1Bundle.hook.proxy_bundled, false);
      const sbPhase1 = prepareSmokeSandbox(ws, phase1Bundle.manifest_path, { proxyBinDir });
      try {
        assert.equal(sbPhase1.usedProxyDll, 'version.dll');
        assert.ok(fs.readFileSync(path.join(sbPhase1.sandboxDir, 'bin', 'version.dll')).equals(versionBytes));
        assert.equal(fs.existsSync(path.join(sbPhase1.sandboxDir, 'bin', 'papercup_patch.ini')), true);
      } finally {
        sbPhase1.cleanup();
      }

      // Original game directory must NEVER be modified
      assert.equal(fs.existsSync(path.join(gameSubdir, 'version.dll')), false);
      assert.equal(fs.existsSync(path.join(gameSubdir, 'papercup_patch.ini')), false);
      assert.equal(fs.readFileSync(path.join(gameSubdir, 'script.txt'), 'utf8'), origScript);
    });
  });

  const testFileDir = path.dirname(fileURLToPath(import.meta.url));
  const prebuiltX64VersionDll = path.resolve(testFileDir, '..', 'native', 'win32-proxy', 'bin', 'x64', 'version.dll');
  const findX64Gcc = (): { bin: string; env: NodeJS.ProcessEnv } | null => {
    if (process.platform !== 'win32') return null;
    const candidates = ['C:\\msys64\\ucrt64\\bin\\gcc.exe', 'C:\\msys64\\mingw64\\bin\\gcc.exe', 'gcc'];
    for (const cand of candidates) {
      const isAbs = path.isAbsolute(cand);
      if (isAbs && !fs.existsSync(cand)) continue;
      let env: NodeJS.ProcessEnv = process.env;
      if (isAbs) {
        const dir = path.dirname(cand);
        const curPath = process.env.PATH || process.env.Path || '';
        const nextPath = `${dir}${path.delimiter}${curPath}`;
        env = { ...process.env, PATH: nextPath, Path: nextPath };
      }
      const probe = spawnSync(cand, ['-dumpmachine'], { encoding: 'utf8', env, windowsHide: true });
      if (probe.status === 0 && /^x86_64/i.test((probe.stdout || '').trim())) {
        return { bin: cand, env };
      }
    }
    return null;
  };
  const x64Gcc = findX64Gcc();
  const canRunLiveX64Proxy =
    process.platform === 'win32' && fs.existsSync(prebuiltX64VersionDll) && x64Gcc !== null;

  it(
    '19.4 executes live Windows x64 version.dll proxy against a compiled C probe (GetACP, WideCharToMultiByte, CreateFontIndirectW, GetFileVersionInfoSizeW)',
    { skip: !canRunLiveX64Proxy },
    async () => {
      await withTempWorkspace(async ({ root }) => {
        const probeDir = path.join(root, 'live-x64-proxy');
        fs.mkdirSync(probeDir, { recursive: true });
        fs.copyFileSync(prebuiltX64VersionDll, path.join(probeDir, 'version.dll'));

        const logPath = path.join(probeDir, 'proxy.log');
        fs.writeFileSync(
          path.join(probeDir, 'papercup_patch.ini'),
          [
            '[patch]',
            'codepage=936',
            'charset=134',
            'font_name=SimHei',
            'force_font_name=0',
            'enable_width_compat=1',
            `log_file=${logPath}`,
          ].join('\r\n') + '\r\n',
          'utf8'
        );

        const probeC = path.join(probeDir, 'probe.c');
        const probeExe = path.join(probeDir, 'probe.exe');
        fs.writeFileSync(
          probeC,
          [
            '#include <windows.h>',
            '#include <stdio.h>',
            '',
            'int main(void) {',
            '    UINT acp = GetACP();',
            '    WCHAR wch = 0x4F60;',
            '    unsigned char mb[8] = {0};',
            '    int n = WideCharToMultiByte(932, 0, &wch, 1, (LPSTR)mb, sizeof(mb), NULL, NULL);',
            '',
            '    LOGFONTW lf;',
            '    ZeroMemory(&lf, sizeof(lf));',
            '    lf.lfHeight = 16;',
            '    lf.lfCharSet = 0x80;',
            '    lstrcpyW(lf.lfFaceName, L"MS Gothic");',
            '    HFONT hf = CreateFontIndirectW(&lf);',
            '    LOGFONTW outLf;',
            '    ZeroMemory(&outLf, sizeof(outLf));',
            '    if (hf) {',
            '        GetObjectW(hf, sizeof(outLf), &outLf);',
            '        DeleteObject(hf);',
            '    }',
            '',
            '    DWORD dummy = 0;',
            '    DWORD verSize = GetFileVersionInfoSizeW(L"kernel32.dll", &dummy);',
            '',
            '    printf("GetACP=%u\\n", acp);',
            '    printf("W2MB_932=");',
            '    for (int i = 0; i < n; i++) {',
            '        printf("%s%02X", i ? "," : "", mb[i]);',
            '    }',
            '    printf("\\n");',
            '    printf("outCharset=%u\\n", (unsigned int)outLf.lfCharSet);',
            '    printf("verSize=%lu\\n", (unsigned long)verSize);',
            '    return 0;',
            '}',
          ].join('\n') + '\n',
          'utf8'
        );

        const compile = spawnSync(x64Gcc!.bin, [probeC, '-o', probeExe, '-lgdi32', '-lversion'], {
          cwd: probeDir,
          env: x64Gcc!.env,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(compile.status, 0, `gcc compile failed:\n${compile.stdout}\n${compile.stderr}`);

        const run = spawnSync(probeExe, [], {
          cwd: probeDir,
          env: x64Gcc!.env,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(run.status, 0, `probe.exe failed (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
        assert.match(run.stdout, /\bGetACP=936\b/);
        assert.match(run.stdout, /\bW2MB_932=C4,E3\b/);
        assert.match(run.stdout, /\boutCharset=134\b/);
        const verMatch = /\bverSize=(\d+)\b/.exec(run.stdout);
        assert.ok(verMatch && Number(verMatch[1]) > 0, `Expected verSize > 0, got:\n${run.stdout}`);

        assert.equal(fs.existsSync(logPath), true, 'Expected proxy.log to be written');
        const logText = fs.readFileSync(logPath, 'utf8');
        assert.ok(
          logText.includes('[papercup-proxy] loaded arch=x64 proxy=version.dll codepage=936 charset=134'),
          `Unexpected proxy.log content:\n${logText}`
        );
      });
    }
  );
});

/* ========================= 20. #124 Builtin Override, >64MiB Magic Anchor, Per-Format Writeback & Unpack Hints ========================= */

describe('20. #124 Builtin archive skill override, >64 MiB sampleArchive magic anchor, per-format writeback & unpack hints', () => {
  it('20.1 allows project-level override_builtin skill on failed builtin XP3, routes scanWorkspace/vn_unpack, rejects passing builtin & .papercup/tmp/ fakes', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });

      // Protected XP3 (infoFlags !== 0 causes builtin loadXp3Index/testBuiltinArchiveUnpackable to fail)
      const protectedXp3 = buildXp3Custom([{ name: 'scene01.ks', data: Buffer.from('*start\nおはよう[p]\n', 'utf8'), infoFlags: 1 }]);
      fs.writeFileSync(path.join(ws, 'data', 'data.xp3'), protectedXp3);

      // Standard passing XP3 (infoFlags === 0)
      const normalXp3 = buildXp3Custom([{ name: 'plain.ks', data: Buffer.from('*start\nこんにちは[p]\n', 'utf8'), infoFlags: 0 }]);
      fs.writeFileSync(path.join(ws, 'data', 'normal.xp3'), normalXp3);

      // Fake-magic sample staged inside .papercup/tmp/
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'fake.xp3'), protectedXp3);

      const failChk = testBuiltinArchiveUnpackable(path.join(ws, 'data', 'data.xp3'));
      assert.equal(failChk.isBuiltinFormat, true);
      assert.equal(failChk.builtinKind, 'xp3');
      assert.equal(failChk.canUnpack, false);

      const passChk = testBuiltinArchiveUnpackable(path.join(ws, 'data', 'normal.xp3'));
      assert.equal(passChk.isBuiltinFormat, true);
      assert.equal(passChk.builtinKind, 'xp3');
      assert.equal(passChk.canUnpack, true);

      // Minimal custom Python scripts that roundtrip our synthetic protected XP3 via raw payload marker
      const unpackWithPayloadPy = [
        'import hashlib, pathlib, sys',
        'src = pathlib.Path(sys.argv[1]).read_bytes()',
        'if not src.startswith(b"XP3\\r\\n \\n\\x1a\\x8b\\x67\\x01"):',
        '    raise ValueError("bad xp3 magic")',
        'dst = pathlib.Path(sys.argv[2])',
        'dst.mkdir(parents=True, exist_ok=True)',
        'if b"*start\\n" in src:',
        '    idx = src.index(b"*start\\n")',
        '    (dst / "scene01.ks").write_bytes(src[idx:])',
        '    (dst / ".orig_raw.bin").write_bytes(src[:idx])',
        'else:',
        '    h = hashlib.sha256(src).hexdigest()[:8]',
        '    (dst / "scene01.ks").write_bytes(f"*start\\nおはよう_{h}[p]\\n".encode("utf-8"))',
        '    (dst / ".orig_raw.bin").write_bytes(src)',
      ].join('\n') + '\n';
      const repackPy = [
        'import pathlib, sys',
        'src_dir = pathlib.Path(sys.argv[1])',
        'ks = (src_dir / "scene01.ks").read_bytes()',
        'raw_orig = (src_dir / ".orig_raw.bin").read_bytes()',
        'hdr = raw_orig[:11] + ks',
        'pathlib.Path(sys.argv[2]).write_bytes(hdr)',
      ].join('\n') + '\n';
      const extractPy = [
        'import json, pathlib, sys',
        'p = pathlib.Path(sys.argv[1]) / "scene01.ks"',
        'lines = p.read_bytes().decode("utf-8").splitlines()',
        'rows = [{"id": "k1", "file": "scene01.ks", "line": 2, "kind": "say", "source": lines[1]}]',
        'pathlib.Path(sys.argv[2]).write_bytes(("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, pathlib, sys',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'p = pathlib.Path(sys.argv[2]) / "scene01.ks"',
        'lines = p.read_bytes().decode("utf-8").splitlines()',
        'lines[1] = str(rows[0].get("target") or rows[0]["source"])',
        'p.write_bytes(("\\n".join(lines) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'unpack.py'), unpackWithPayloadPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'repack.py'), repackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      // 1) Reject fake-magic sample inside .papercup/tmp/
      assert.equal(isBackupOrNonOriginalArchiveRel('.papercup/tmp/fake.xp3'), true);
      const fakeRes = await learnVnSkill(ws, {
        engine: 'kirikiri-protected',
        archive: '.papercup/tmp/fake.xp3',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
      });
      assert.equal(fakeRes.status, 'diagnosed');
      assert.ok(fakeRes.summary.includes('内部临时') || fakeRes.summary.includes('伪造'));

      // 2) Reject override when builtin unpacker actually succeeds on normal.xp3
      const passRes = await learnVnSkill(ws, {
        engine: 'kirikiri-protected',
        archive: 'data/normal.xp3',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
      });
      assert.equal(passRes.status, 'diagnosed');
      assert.ok(passRes.summary.includes('已有内置解包器'));

      // 3) Reject reserved engine name ("kirikiri") even on failed builtin XP3
      const reservedRes = await learnVnSkill(ws, {
        engine: 'kirikiri',
        archive: 'data/data.xp3',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
      });
      assert.equal(reservedRes.status, 'diagnosed');
      assert.ok(reservedRes.summary.includes('保留名称'));

      // 4) Accept project-level override_builtin skill on failed protected data.xp3
      const okRes = await learnVnSkill(ws, {
        engine: 'kirikiri-protected',
        archive: 'data/data.xp3',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        magicHex: '5850330d0a200a1a8b6701',
      });
      assert.equal(okRes.status, 'adopted', okRes.summary);

      const engineJsonPath = path.join(projectHarnessDir(ws, homeDir), 'engine.json');
      const engineJson = JSON.parse(fs.readFileSync(engineJsonPath, 'utf8')) as Record<string, unknown>;
      assert.equal(engineJson.override_builtin, true);

      // Remove normal.xp3 so scanWorkspace / vn_unpack exercise the override archive cleanly
      fs.rmSync(path.join(ws, 'data', 'normal.xp3'));

      const matchers = loadCustomMatchers(homeDir, ws);
      assert.ok(matchers.some((m) => m.engine === 'kirikiri-protected' && m.overrideBuiltin === true));

      const scan = scanWorkspace(ws, homeDir);
      const hit = scan.hits.find((h) => h.path === 'data/data.xp3');
      assert.ok(hit, 'Expected scanWorkspace to hit data/data.xp3');
      assert.equal(hit!.engine, 'kirikiri-protected');
      assert.equal(hit!.kind, 'xp3');
      assert.equal(hit!.extra.override_builtin, 1);

      const detected = detectVnEngineSummary(ws);
      assert.ok(detected.text.includes('override_builtin'), detected.text);

      // Unpack routes data/data.xp3 through skill unpack.py instead of failing in builtin unpackXp3
      const unpackOut = await unpackVnArchives(ws, { archive: 'data/data.xp3' });
      assert.ok(unpackOut.includes('已解包 data/data.xp3'), unpackOut);
      const unpackedKs = path.join(resolveWorkspacePaths(ws).unpackedDir, 'data', 'data', 'scene01.ks');
      assert.equal(fs.existsSync(unpackedKs), true);
      assert.ok(fs.readFileSync(unpackedKs, 'utf8').includes('おはよう'));
    });
  });

  it('20.2 enforces >64 MiB sampleArchive magic anchoring (passes matched magic, rejects mismatched magic & unanchored >64 MiB)', async () => {
    await withTempWorkspace(async ({ ws, homeDir }) => {
      fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });

      const xp3Magic = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const largeSize = MAX_ARCHIVE_LEARN_BYTES + 1024 * 1024; // 65 MiB sparse file
      const bigArchivePath = path.join(ws, 'data', 'adult.xp3');
      const fd = fs.openSync(bigArchivePath, 'w');
      try {
        fs.writeSync(fd, xp3Magic, 0, xp3Magic.length, 0);
        fs.ftruncateSync(fd, largeSize);
      } finally {
        fs.closeSync(fd);
      }

      // Valid small subset sample with identical .xp3 extension and identical magic bytes
      const matchedSample = buildXp3Custom([{ name: 's.ks', data: Buffer.from('*s\nテスト[p]\n', 'utf8'), infoFlags: 1 }]);
      // Build a small sample whose first 16 bytes match bigArchivePath exactly (xp3Magic) + payload marker
      const alignedSample = Buffer.concat([xp3Magic, Buffer.from('*s\nテスト[p]\n', 'utf8')]);
      void matchedSample;
      fs.writeFileSync(path.join(ws, 'data', 'subset_match.xp3'), alignedSample);

      // Mismatched magic sample (same .xp3 extension, different header bytes)
      fs.writeFileSync(
        path.join(ws, 'data', 'subset_bad_magic.xp3'),
        Buffer.concat([Buffer.from('BADMAGIC12345678', 'ascii'), Buffer.from('*s\nテスト[p]\n', 'utf8')])
      );

      // Mismatched extension sample
      fs.writeFileSync(path.join(ws, 'data', 'subset_bad_ext.dat'), alignedSample);

      const unpackPy = [
        'import pathlib, sys',
        'src = pathlib.Path(sys.argv[1]).read_bytes()',
        'dst = pathlib.Path(sys.argv[2])',
        'dst.mkdir(parents=True, exist_ok=True)',
        'idx = src.index(b"*s\\n")',
        '(dst / "s.ks").write_bytes(src[idx:])',
        '(dst / ".hdr.bin").write_bytes(src[:idx])',
      ].join('\n') + '\n';
      const repackPy = [
        'import pathlib, sys',
        'src_dir = pathlib.Path(sys.argv[1])',
        'hdr = (src_dir / ".hdr.bin").read_bytes()',
        'body = (src_dir / "s.ks").read_bytes()',
        'pathlib.Path(sys.argv[2]).write_bytes(hdr + body)',
      ].join('\n') + '\n';
      const extractPy = [
        'import json, pathlib, sys',
        'lines = (pathlib.Path(sys.argv[1]) / "s.ks").read_bytes().decode("utf-8").splitlines()',
        'rows = [{"id": "s1", "file": "s.ks", "line": 2, "kind": "say", "source": lines[1]}]',
        'pathlib.Path(sys.argv[2]).write_bytes((json.dumps(rows[0], ensure_ascii=False) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, pathlib, sys',
        'row = json.loads(pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines()[0])',
        'p = pathlib.Path(sys.argv[2]) / "s.ks"',
        'lines = p.read_bytes().decode("utf-8").splitlines()',
        'lines[1] = str(row.get("target") or row["source"])',
        'p.write_bytes(("\\n".join(lines) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'unpack.py'), unpackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'repack.py'), repackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      // 1) >64 MiB without sampleArchive is rejected with guidance
      const noSample = await learnVnSkill(ws, {
        engine: 'kirikiri-big',
        archive: 'data/adult.xp3',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
      });
      assert.equal(noSample.status, 'diagnosed');
      assert.ok(noSample.summary.includes('sampleArchive') && noSample.summary.includes('64 MiB'));

      // 2) Mismatched magic sampleArchive is rejected
      const badMagic = await learnVnSkill(ws, {
        engine: 'kirikiri-big',
        archive: 'data/adult.xp3',
        sampleArchive: 'data/subset_bad_magic.xp3',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
      });
      assert.equal(badMagic.status, 'diagnosed');
      assert.ok(badMagic.summary.includes('魔数') && badMagic.summary.includes('不一致'));

      // 3) Mismatched extension sampleArchive is rejected
      const badExt = await learnVnSkill(ws, {
        engine: 'kirikiri-big',
        archive: 'data/adult.xp3',
        sampleArchive: 'data/subset_bad_ext.dat',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
      });
      assert.equal(badExt.status, 'diagnosed');
      assert.ok(badExt.summary.includes('扩展名') && badExt.summary.includes('不一致'));

      // 4) Matching magic + extension sampleArchive via vn_learn_skill tool succeeds & anchors to real archive
      const tools = createVnTools(() => ws);
      const learnTool = tools.find((t) => t.name === 'vn_learn_skill')!;
      assert.ok(learnTool, 'Expected vn_learn_skill tool');
      const toolRes = (await learnTool.execute(
        't-learn-big',
        {
          engine: 'kirikiri-big',
          archive: 'data/adult.xp3',
          sampleArchive: 'data/subset_match.xp3',
          unpackScript: '.papercup/tmp/unpack.py',
          repackScript: '.papercup/tmp/repack.py',
          extractScript: '.papercup/tmp/extract.py',
          applyScript: '.papercup/tmp/apply.py',
          magicHex: '5850330d0a200a1a8b6701',
        },
        undefined,
        undefined,
        {} as any
      )) as any;
      assert.notEqual(toolRes?.isError, true, String(toolRes?.content?.[0]?.text || ''));

      const skillMd = fs.readFileSync(
        path.join(resolveWorkspacePaths(ws).skillDir('engine-kirikiri-big'), 'SKILL.md'),
        'utf8'
      );
      assert.ok(skillMd.includes('source-sample: data/adult.xp3'), 'Must anchor source-sample to real >64 MiB archive');
      const engineJson = JSON.parse(
        fs.readFileSync(path.join(projectHarnessDir(ws, homeDir), 'engine.json'), 'utf8')
      ) as Record<string, unknown>;
      assert.equal(engineJson.override_builtin, true);
    });
  });

  it('20.3 verifyWritebackRoundtrip checks every sampled format extension and catches equal-length lock in .scn even when .ks passes', async () => {
    // Pure unit check on pickMutationRowsByFormat
    const syntheticRows = [
      ...Array.from({ length: 18 }, (_, i) => ({
        id: `ks${i + 1}`,
        file: 'ui/config.ks',
        line: i + 1,
        kind: 'system',
        source: `SYS_${i + 1}`,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `scn${i + 1}`,
        file: 'scenario/ch01.scn',
        line: i + 1,
        kind: 'say',
        source: `会話テキスト${i + 1}`,
      })),
    ];
    const picked = pickMutationRowsByFormat(syntheticRows);
    assert.deepEqual(
      picked.map((p) => p.ext).sort(),
      ['.ks', '.scn'],
      'Must sample both dominant .ks and secondary .scn (>=5% & say)'
    );

    await withTempWorkspace(async ({ ws }) => {
      const gameDir = path.join(ws, 'game');
      fs.mkdirSync(gameDir, { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });

      // .ks has 10 system rows (variable-length OK); .scn has 2 say rows (~16% share, equal-length locked in apply.py)
      fs.writeFileSync(
        path.join(gameDir, 'menu.ks'),
        Array.from({ length: 10 }, (_, i) => `BTN_${i + 1}=設定項目${i + 1}`).join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(path.join(gameDir, 'main.scn'), 'SCENE\nおはよう世界\nこんにちは\n', 'utf8');

      const extractPy = [
        'import json, pathlib, sys',
        'root = pathlib.Path(sys.argv[1])',
        'rows = []',
        'for i, line in enumerate((root / "menu.ks").read_bytes().decode("utf-8").splitlines(), 1):',
        '    if "=" in line:',
        '        rows.append({"id": f"ks_{i}", "file": "menu.ks", "line": i, "kind": "system", "source": line.split("=", 1)[1]})',
        'for i, line in enumerate((root / "main.scn").read_bytes().decode("utf-8").splitlines(), 1):',
        '    if i >= 2 and line.strip():',
        '        rows.append({"id": f"scn_{i}", "file": "main.scn", "line": i, "kind": "say", "source": line})',
        'pathlib.Path(sys.argv[2]).write_bytes(("\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';

      // Buggy apply.py: writes full variable-length target for .ks, but truncates .scn to len(orig) (equal-length lock!)
      const lockedApplyPy = [
        'import json, pathlib, sys',
        'root = pathlib.Path(sys.argv[2])',
        'rows = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines() if l.strip()]',
        'by_file = {}',
        'for r in rows:',
        '    by_file.setdefault(r["file"], {})[int(r["line"])] = str(r.get("target") or r["source"])',
        'ks_p = root / "menu.ks"',
        'ks_lines = ks_p.read_bytes().decode("utf-8").splitlines()',
        'for ln, val in by_file.get("menu.ks", {}).items():',
        '    k = ks_lines[ln - 1].split("=", 1)[0]',
        '    ks_lines[ln - 1] = f"{k}={val}"',
        'ks_p.write_bytes(("\\n".join(ks_lines) + "\\n").encode("utf-8"))',
        'scn_p = root / "main.scn"',
        'scn_lines = scn_p.read_bytes().decode("utf-8").splitlines()',
        'for ln, val in by_file.get("main.scn", {}).items():',
        '    orig = scn_lines[ln - 1]',
        '    scn_lines[ln - 1] = val[:len(orig)]  # BUG: equal-length lock!',
        'scn_p.write_bytes(("\\n".join(scn_lines) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply_locked.py'), lockedApplyPy, 'utf8');

      const blockedRes = await learnVnSkill(ws, {
        engine: 'multiformat-lock-test',
        pipeline: 'direct',
        unpackedDir: 'game',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply_locked.py',
        encoding: 'utf-8',
      });
      assert.equal(blockedRes.status, 'diagnosed', 'Equal-length lock on .scn must fail verifyWritebackRoundtrip');
      assert.ok(blockedRes.summary.includes('.scn') && blockedRes.summary.includes('等长'), blockedRes.summary);

      // Fixed apply.py without equal-length lock passes
      const fixedApplyPy = lockedApplyPy.replace('    scn_lines[ln - 1] = val[:len(orig)]  # BUG: equal-length lock!', '    scn_lines[ln - 1] = val');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply_fixed.py'), fixedApplyPy, 'utf8');
      const okRes = await learnVnSkill(ws, {
        engine: 'multiformat-lock-test',
        pipeline: 'direct',
        unpackedDir: 'game',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply_fixed.py',
        encoding: 'utf-8',
      });
      assert.equal(okRes.status, 'adopted', okRes.summary);
    });
  });

  it('20.4 vn_unpack & buildUnpackNoMatchGuidance provide actionable engine/archive hints when kind is passed as engine', async () => {
    const pureGuidance = buildUnpackNoMatchGuidance({
      availableHits: [{ engine: 'kirikiri', path: 'data/data.xp3', kind: 'xp3', version: 'basic', extra: {} }],
      engineArg: 'xp3',
    });
    assert.ok(pureGuidance.includes('kind') && pureGuidance.includes('kirikiri') && pureGuidance.includes('data/data.xp3'), pureGuidance);

    await withTempWorkspace(async ({ ws }) => {
      fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'data', 'data.xp3'),
        buildXp3Custom([{ name: 'scene.ks', data: Buffer.from('hello\n', 'utf8') }])
      );

      const tools = createVnTools(() => ws);
      const unpackTool = tools.find((t) => t.name === 'vn_unpack')!;
      const res = (await unpackTool.execute('t-kind-eng', { engine: 'xp3' }, undefined, undefined, {} as any)) as any;
      assert.equal(res?.isError, true);
      const msg = String(res?.content?.[0]?.text || '');
      assert.ok(msg.includes('kirikiri') && msg.includes('data/data.xp3'), `Expected engine/archive hint, got: ${msg}`);

      const missArch = (await unpackTool.execute('t-miss-arch', { archive: 'data/missing.xp3' }, undefined, undefined, {} as any)) as any;
      assert.equal(missArch?.isError, true);
      const missMsg = String(missArch?.content?.[0]?.text || '');
      assert.ok(missMsg.includes('data/data.xp3') && missMsg.includes('kirikiri'), `Expected archive hint, got: ${missMsg}`);
    });
  });
});

/* ========================= 21. #124 Shrink-Replace Guard, PS5.1 Driver, Exe Picker & Probe Row Picker ========================= */

describe('21. #124 Shrink-replace guard, Windows PS5.1 driver Generic.List/HashSet, inspectPrimaryGameExe & pickPreTranslateProbeRows', () => {
  it('21.1 blocks action="replace" on >10 MiB archive shrunk <50% across patch.ts & smoke.ts while allowing action="add"', async () => {
    const over10MiB = SHRINK_REPLACE_MIN_ORIGINAL_BYTES + 1024 * 1024;
    const tinyRepack = 256 * 1024;

    assert.equal(SHRINK_REPLACE_MIN_ORIGINAL_BYTES, 10 * 1024 * 1024);
    assert.equal(SHRINK_REPLACE_MIN_RATIO, 0.5);

    const blockedReason = getDestructiveShrinkReplaceReason({
      action: 'replace',
      targetRel: 'data/main.xp3',
      originalBytes: over10MiB,
      replacementBytes: tinyRepack,
    });
    assert.ok(blockedReason && blockedReason.includes('action=replace') && blockedReason.includes('action: "add"'), blockedReason ?? '');
    assert.throws(
      () =>
        assertNoDestructiveShrinkReplace({
          action: 'replace',
          targetRel: 'data/main.xp3',
          originalBytes: over10MiB,
          replacementBytes: tinyRepack,
        }),
      ExportCopyError
    );

    // action: "add" is never blocked even on >10 MiB archive with tiny overlay
    assert.equal(
      getDestructiveShrinkReplaceReason({
        action: 'add',
        targetRel: 'data/patch.xp3',
        originalBytes: over10MiB,
        replacementBytes: 4096,
      }),
      null
    );
    // <= 10 MiB or >= 50% replacement is allowed
    assert.equal(
      getDestructiveShrinkReplaceReason({
        action: 'replace',
        targetRel: 'data/small.xp3',
        originalBytes: SHRINK_REPLACE_MIN_ORIGINAL_BYTES,
        replacementBytes: 1024,
      }),
      null
    );
    assert.equal(
      getDestructiveShrinkReplaceReason({
        action: 'replace',
        targetRel: 'data/main.xp3',
        originalBytes: over10MiB,
        replacementBytes: Math.ceil(over10MiB * 0.5),
      }),
      null
    );

    // End-to-end buildPatchBundle & prepareSmokeSandbox / prepareSmokeSandboxFromOverlay / preTranslateProbe checks
    await withTempWorkspace(async ({ root, ws, homeDir }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.papercup', 'tmp'), { recursive: true });
      fs.mkdirSync(wsPaths.resultsDir, { recursive: true });

      fs.writeFileSync(path.join(ws, 'Game.exe'), makeDummyPeExe('x86'));
      fs.writeFileSync(
        wsPaths.papercupTomlFile,
        [
          '[vn.localization]',
          'narrative_pov = "first"',
          'source_lang = "ja"',
          'target_lang = "zh-CN"',
          '',
          '[vn.smoke]',
          'enabled = true',
          'vision_enabled = false',
        ].join('\n') + '\n',
        'utf8'
      );

      // Sparse 11 MiB original custom archive (.pak with magic PAK1) + small 1 KiB subset sample
      const magicHdr = Buffer.from('PAK1', 'ascii');
      const payloadText = Buffer.from('おはよう[p]\n', 'utf8');
      const smallSample = Buffer.concat([magicHdr, payloadText]);
      const bigArchPath = path.join(ws, 'data', 'big.pak');
      const fd = fs.openSync(bigArchPath, 'w');
      try {
        fs.writeSync(fd, smallSample, 0, smallSample.length, 0);
        fs.ftruncateSync(fd, over10MiB);
      } finally {
        fs.closeSync(fd);
      }
      fs.writeFileSync(path.join(ws, 'data', 'subset.pak'), smallSample);

      const unpackPy = [
        'import pathlib, sys',
        'raw = pathlib.Path(sys.argv[1]).read_bytes()',
        'dst = pathlib.Path(sys.argv[2])',
        'dst.mkdir(parents=True, exist_ok=True)',
        'body = raw[4:].rstrip(b"\\x00")',
        '(dst / "script.txt").write_bytes(body)',
      ].join('\n') + '\n';
      const repackPy = [
        'import pathlib, sys',
        'body = (pathlib.Path(sys.argv[1]) / "script.txt").read_bytes()',
        'pathlib.Path(sys.argv[2]).write_bytes(b"PAK1" + body)',
      ].join('\n') + '\n';
      const extractPy = [
        'import json, pathlib, sys',
        'txt = (pathlib.Path(sys.argv[1]) / "script.txt").read_bytes().decode("utf-8").splitlines()[0]',
        'row = {"id": "1", "file": "script.txt", "line": 1, "kind": "say", "source": txt}',
        'pathlib.Path(sys.argv[2]).write_bytes((json.dumps(row, ensure_ascii=False) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';
      const applyPy = [
        'import json, pathlib, sys',
        'row = json.loads(pathlib.Path(sys.argv[1]).read_text("utf-8").splitlines()[0])',
        'p = pathlib.Path(sys.argv[2]) / "script.txt"',
        'p.write_bytes((str(row.get("target") or row["source"]) + "\\n").encode("utf-8"))',
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'unpack.py'), unpackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'repack.py'), repackPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'extract.py'), extractPy, 'utf8');
      fs.writeFileSync(path.join(ws, '.papercup', 'tmp', 'apply.py'), applyPy, 'utf8');

      // Override MAX_ARCHIVE_LEARN_BYTES check isn't needed: big.pak < 64 MiB so read+unpack works directly or use smallSample
      // Wait: over10MiB is 11 MiB <= 64 MiB! unpackPy strips trailing NULs so roundtrip on 11 MiB would drop NULs; instead test learn on subset.pak? No, big.pak needs roundtrip.
      // Let's keep a clean roundtrip-able 11 MiB archive? Actually we can unpack directly into .papercup/tmp/unpacked/data/big with .skill-manifest.json after learning on small file or matching trailing length:
      // Even simpler: learn on 11 MiB archive if repack preserves length? No, if repack preserves 11 MiB it won't shrink!
      // Simulate partial-unpack scenario: learn skill on small sample, then point .skill-manifest.json source to data/big.pak!
      const learned = await learnVnSkill(ws, {
        engine: 'shrinktest',
        archive: 'data/subset.pak',
        unpackScript: '.papercup/tmp/unpack.py',
        repackScript: '.papercup/tmp/repack.py',
        extractScript: '.papercup/tmp/extract.py',
        applyScript: '.papercup/tmp/apply.py',
        magicHex: '50414b31',
      });
      assert.equal(learned.status, 'adopted', learned.summary);

      // Stage partial unpacked directory claiming source = data/big.pak (11 MiB) with original script text
      const unpackedBigDir = path.join(wsPaths.unpackedDir, 'data', 'big');
      fs.mkdirSync(unpackedBigDir, { recursive: true });
      fs.writeFileSync(path.join(unpackedBigDir, 'script.txt'), 'おはよう[p]\n', 'utf8');
      fs.writeFileSync(
        path.join(unpackedBigDir, '.skill-manifest.json'),
        JSON.stringify({
          version: 'skill',
          source: bigArchPath,
          engine: 'shrinktest',
          files: [{ name: 'script.txt', sha256: sha256Hex(Buffer.from('おはよう[p]\n', 'utf8')) }],
        }),
        'utf8'
      );

      // Classify & populate translated result so buildPatchBundle attempts skill repack -> replace_archive
      fs.mkdirSync(wsPaths.buildDir, { recursive: true });
      fs.writeFileSync(
        wsPaths.buildTrackFile('scenario'),
        JSON.stringify({ id: '1', file: 'script.txt', line: 1, kind: 'say', source: 'おはよう[p]' }) + '\n',
        'utf8'
      );
      fs.writeFileSync(
        wsPaths.resultsTrackFile('scenario'),
        JSON.stringify({ id: '1', file: 'script.txt', line: 1, kind: 'say', track: 'scenario', source: 'おはよう[p]', target: '早上好[p]', ok: true }) + '\n',
        'utf8'
      );

      const profile = loadProfile(ws).profile!;
      const memory = loadProfileMemory(ws, homeDir, profile);

      // 1) buildPatchBundle rejects shrunk replace_archive against 11 MiB data/big.pak
      await assert.rejects(
        () => buildPatchBundle(ws, profile, memory, { homeDir }),
        (err: unknown) => err instanceof ExportCopyError && err.message.includes('缩水替换') && err.message.includes('action: "add"')
      );

      // 2) preTranslateProbe also rejects shrunk replace_archive against 11 MiB data/big.pak
      // Point unpacked dir to original content first so preTranslateProbe detects change against baseline
      fs.writeFileSync(path.join(unpackedBigDir, 'script.txt'), 'おはよう[p]\n', 'utf8');
      await assert.rejects(
        () =>
          runSmokeTest(ws, profile, {
            homeDir,
            preTranslateProbe: true,
            driver: { run: async () => makeBaseDriverResult() },
          }),
        (err: unknown) => err instanceof SmokeError && err.message.includes('缩水替换')
      );

      // 3) prepareSmokeSandboxFromOverlay rejects shrunk replacement file
      const tinyOverlay = path.join(root, 'tiny_repacked.pak');
      fs.writeFileSync(tinyOverlay, smallSample);
      assert.throws(
        () => prepareSmokeSandboxFromOverlay(ws, tinyOverlay, { overlayTarget: 'data/big.pak', homeDir }),
        (err: unknown) => err instanceof SmokeError && err.message.includes('缩水替换')
      );

      // 4) prepareSmokeSandbox rejects replace_archive manifest pointing to shrunk file, while allowing action="add"
      const fakeManifestDir = path.join(root, 'fake-patch');
      fs.mkdirSync(path.join(fakeManifestDir, 'files', 'data'), { recursive: true });
      fs.writeFileSync(path.join(fakeManifestDir, 'files', 'data', 'big.pak'), smallSample);
      const replaceManifestPath = path.join(fakeManifestDir, 'patch_manifest.json');
      fs.writeFileSync(
        replaceManifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          strategy: 'archive_replace',
          artifacts: [
            {
              kind: 'replace_archive',
              patch_rel: 'files/data/big.pak',
              install_rel: 'data/big.pak',
              action: 'replace',
              sha256: sha256Hex(smallSample),
              bytes: smallSample.length,
            },
          ],
        }),
        'utf8'
      );
      assert.throws(
        () => prepareSmokeSandbox(ws, replaceManifestPath),
        (err: unknown) => err instanceof SmokeError && err.message.includes('缩水替换')
      );

      // action="add" incremental overlay (patch.xp3) succeeds in prepareSmokeSandbox
      fs.writeFileSync(path.join(fakeManifestDir, 'files', 'data', 'patch.xp3'), smallSample);
      const addManifestPath = path.join(fakeManifestDir, 'patch_add_manifest.json');
      fs.writeFileSync(
        addManifestPath,
        JSON.stringify({
          schema: 1,
          format: 'papercup-delta-patch',
          strategy: 'delta_patch',
          artifacts: [
            {
              kind: 'overlay_archive',
              patch_rel: 'files/data/patch.xp3',
              install_rel: 'data/patch.xp3',
              action: 'add',
              sha256: sha256Hex(smallSample),
              bytes: smallSample.length,
            },
          ],
        }),
        'utf8'
      );
      const sbAdd = prepareSmokeSandbox(ws, addManifestPath);
      try {
        assert.equal(fs.existsSync(path.join(sbAdd.sandboxDir, 'data', 'patch.xp3')), true);
      } finally {
        sbAdd.cleanup();
      }
    });
  });

  it('21.2 verifies PS5.1 smoke driver Generic.List/HashSet array conversions in source and live Windows powershell', () => {
    const src = getWindowsSmokeDriverSource();
    assert.ok(src.includes('frames = @($framesList.ToArray())'), 'Expected frames = @($framesList.ToArray())');
    assert.ok(
      src.includes('$observedProcessNames = @([System.Linq.Enumerable]::ToArray($observedProcessNamesSet))'),
      'Expected Enumerable::ToArray($observedProcessNamesSet)'
    );
    // Ensure no bare @($observedProcessNamesSet) or @($framesList) remains
    assert.equal(/@\(\$observedProcessNamesSet\)/.test(src), false);
    assert.equal(/@\(\$framesList\)/.test(src), false);

    if (process.platform === 'win32') {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papercup-ps51-check-'));
      try {
        const driverPs1 = path.join(tmpDir, 'driver.ps1');
        writeWindowsSmokeDriverScript(driverPs1);

        const checkPs1 = path.join(tmpDir, 'check.ps1');
        fs.writeFileSync(
          checkPs1,
          [
            '$ErrorActionPreference = "Stop"',
            `$src = [System.IO.File]::ReadAllText('${driverPs1.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)`,
            '$tokens = $null; $errs = $null',
            '$null = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errs)',
            'if ($errs -and $errs.Count -gt 0) { throw ("Parse error: " + ($errs | ForEach-Object { $_.Message } | Out-String)) }',
            '$framesList = New-Object System.Collections.Generic.List[object]',
            '$framesList.Add(@{ label = "title"; step = 0 }) | Out-Null',
            '$set0 = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)',
            '$set1 = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)',
            '$null = $set1.Add("Game.exe")',
            '$set2 = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)',
            '$null = $set2.Add("Game.exe"); $null = $set2.Add("Child.exe")',
            '$payload = @{',
            '  frames = @($framesList.ToArray())',
            '  p0 = @([System.Linq.Enumerable]::ToArray($set0))',
            '  p1 = @([System.Linq.Enumerable]::ToArray($set1))',
            '  p2 = @([System.Linq.Enumerable]::ToArray($set2))',
            '}',
            '$json = $payload | ConvertTo-Json -Depth 4 -Compress',
            'Write-Output $json',
          ].join('\r\n') + '\r\n',
          'utf8'
        );

        const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checkPs1], {
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(res.status, 0, `powershell.exe failed: ${res.stdout}\n${res.stderr}`);
        const parsed = JSON.parse((res.stdout || '').trim()) as {
          frames: Array<{ label: string; step: number }>;
          p0: string[];
          p1: string[];
          p2: string[];
        };
        assert.equal(parsed.frames.length, 1);
        assert.equal(parsed.frames[0].label, 'title');
        assert.deepEqual(parsed.p0, []);
        assert.deepEqual(parsed.p1, ['Game.exe']);
        assert.equal(parsed.p2.length, 2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it('21.3 inspectPrimaryGameExe deprioritizes install/startup/SupportTools/launcher exes and prefers archive-colocated exe', async () => {
    await withTempWorkspace(async ({ ws }) => {
      // Root has huge non-game utilities that previously outranked smaller/nested game exes
      fs.writeFileSync(path.join(ws, 'install.exe'), Buffer.concat([makeDummyPeExe('x86'), Buffer.alloc(4096)]));
      fs.writeFileSync(path.join(ws, 'startup.exe'), Buffer.concat([makeDummyPeExe('x86'), Buffer.alloc(4096)]));
      fs.writeFileSync(path.join(ws, 'SupportTools.exe'), Buffer.concat([makeDummyPeExe('x86'), Buffer.alloc(4096)]));
      fs.writeFileSync(path.join(ws, 'GameLauncher.exe'), Buffer.concat([makeDummyPeExe('x86'), Buffer.alloc(4096)]));

      // Unrelated subdir has an earlier-alphabetically tool exe
      fs.mkdirSync(path.join(ws, 'Extras'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'Extras', 'AaaTool.exe'), Buffer.concat([makeDummyPeExe('x86'), Buffer.alloc(2048)]));

      // Real game dir co-locates archive + smaller game executable
      fs.mkdirSync(path.join(ws, 'GameData'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'GameData', 'data.xp3'),
        buildXp3Custom([{ name: 's.ks', data: Buffer.from('hi', 'utf8') }])
      );
      fs.writeFileSync(path.join(ws, 'GameData', 'RealNovel.exe'), makeDummyPeExe('x64'));

      const picked = inspectPrimaryGameExe(ws);
      assert.equal(picked.exeRel, 'GameData/RealNovel.exe');
      assert.equal(picked.arch, 'x64');
    });
  });

  it('21.4 pickPreTranslateProbeRows skips dummy/test/sample/debug/template scripts and falls back only when none else exist', async () => {
    assert.equal(isTestOrTemplateScriptPath('dummy_replay.ks'), true);
    assert.equal(isTestOrTemplateScriptPath('scenario/test_scene.ks'), true);
    assert.equal(isTestOrTemplateScriptPath('samples/intro.ks'), true);
    assert.equal(isTestOrTemplateScriptPath('debugMenu.ks'), true);
    assert.equal(isTestOrTemplateScriptPath('template_01.ks'), true);
    assert.equal(isTestOrTemplateScriptPath('scenario/prologue_01.ks'), false);
    assert.equal(isTestOrTemplateScriptPath('contest/main.ks'), false); // "contest" must not false-positive on "test"

    await withTempWorkspace(async ({ ws }) => {
      const wsPaths = resolveWorkspacePaths(ws);
      fs.mkdirSync(wsPaths.buildDir, { recursive: true });
      fs.writeFileSync(
        wsPaths.buildTrackFile('scenario'),
        [
          JSON.stringify({ id: 'd1', file: 'dummy_replay.ks', line: 1, kind: 'say', source: '「ダミーテストのセリフです」' }),
          JSON.stringify({ id: 't1', file: 'scenario/test_01.ks', line: 1, kind: 'say', source: '「テスト用の文章」' }),
          JSON.stringify({ id: 'r1', file: 'scenario/ch01.ks', line: 10, kind: 'say', source: '「おはようございます！」' }),
          JSON.stringify({ id: 'r2', file: 'scenario/ch01.ks', line: 11, kind: 'say', source: '「今日もいい天気ですね」' }),
        ].join('\n') + '\n',
        'utf8'
      );

      const picked = pickPreTranslateProbeRows(ws, 3);
      assert.equal(picked.track, 'scenario');
      assert.equal(picked.rows.length, 2);
      assert.equal(picked.rows[0].file, 'scenario/ch01.ks');

      // Fallback: when ONLY dummy/test rows exist, still returns them rather than throwing
      fs.writeFileSync(
        wsPaths.buildTrackFile('scenario'),
        JSON.stringify({ id: 'd1', file: 'dummy_replay.ks', line: 1, kind: 'say', source: '「フォールバック台詞」' }) + '\n',
        'utf8'
      );
      const fallbackPicked = pickPreTranslateProbeRows(ws, 2);
      assert.equal(fallbackPicked.rows.length, 1);
      assert.equal(fallbackPicked.rows[0].file, 'dummy_replay.ks');
    });
  });
});
