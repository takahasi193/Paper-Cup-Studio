/**
 * Deterministic VN character roster extraction, persisted in-chat confirmation forms
 * (Grok Bot `form.json` + submit-wakeup pattern), locked character store, glossary compilation,
 * and pre-translation confirmation gate.
 *
 * Pure TypeScript, zero external npm dependencies.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHARACTERS_REL,
  compileRosterToGlossary,
  isSymlinkPath,
  loadProfile,
  normalizeCharacterGender,
  readCharacterRoster,
  realpathSafe,
  resolveWorkspaceControlPattern,
  type CharacterAlias,
  type CharacterGender,
  type CharacterRosterEntry,
  type CharacterRosterStore,
  type LocalizationProfile,
} from './profile.js';
import { stripControls } from './qa.js';
import { WORKSPACE_FORMS_DIR_REL, resolveWorkspacePaths } from './workspace-paths.js';

export {
  CHARACTERS_REL,
  compileRosterToGlossary,
  readCharacterRoster,
  type CharacterAlias,
  type CharacterGender,
  type CharacterRosterEntry,
  type CharacterRosterStore,
};

export const FORMS_DIR_REL = WORKSPACE_FORMS_DIR_REL;

export type ChatFormStatus = 'pending' | 'submitted' | 'superseded' | 'cancelled';

export interface CharacterRosterFormItem {
  id: string;
  sourceName: string;
  defaultTarget: string;
  targetName: string;
  speakerIds: string[];
  aliases: CharacterAlias[];
  gender: CharacterGender;
  note?: string;
  occurrences: number;
  samples: string[];
}

export interface ChatFormExcludedItem {
  sourceName: string;
  reason?: string;
  occurrences: number;
  samples: string[];
}

export interface ChatFormRecord {
  schema: 1;
  formId: string;
  kind: 'character_roster';
  status: ChatFormStatus;
  title: string;
  description: string;
  sessionId: string | null;
  classifyDigest: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  items: CharacterRosterFormItem[];
  excludedItems?: ChatFormExcludedItem[];
  summary?: {
    total: number;
    editedCount: number;
    glossaryEntriesAdded: number;
    dismissedCount?: number;
  };
}

export type CharacterCandidateSource =
  | 'name_row'
  | 'speaker'
  | 'inline_bracket'
  | 'tyrano_tag'
  | 'standalone_say';

export interface ExtractedCharacterCandidate {
  id: string;
  sourceName: string;
  speakerIds: string[];
  occurrences: number;
  sources: CharacterCandidateSource[];
  samples: string[];
  existingTarget?: string;
  existingAliases?: CharacterAlias[];
  existingGender?: CharacterGender;
  existingNote?: string;
  dismissed?: boolean;
}

export interface CharacterRosterExtractionResult {
  status: 'empty' | 'unconfirmed' | 'stale' | 'locked';
  classifyDigest: string;
  engine: string;
  totalCharacters: number;
  lockedCount: number;
  dismissedCount: number;
  dismissedNames: string[];
  pendingFormId: string | null;
  characters: ExtractedCharacterCandidate[];
}

export interface CharacterExclusionProposalItem {
  sourceName: string;
  reason?: string;
}

export interface CharacterConfirmationProposalItem {
  id?: string;
  sourceName: string;
  defaultTarget: string;
  speakerIds?: string[];
  aliases?: CharacterAlias[];
  gender?: CharacterGender;
  note?: string;
}

export interface CharacterConfirmationSubmissionItem {
  id?: string;
  sourceName: string;
  targetName: string;
  speakerIds?: string[];
  aliases?: CharacterAlias[];
  gender?: CharacterGender;
  note?: string;
}

export interface CharacterGateResult {
  allowed: boolean;
  reason?: string;
  pendingFormId?: string | null;
  candidateCount?: number;
}

export class RosterError extends Error {}

const FORM_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,80}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SAMPLES_PER_CHARACTER = 3;
const MAX_SAMPLE_CHARS = 80;
const MAX_FORM_ITEMS = 500;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PURE_PUNCT_OR_NUM_RE = /^[\s\p{P}\p{S}0-9０-９]+$/u;
const INLINE_SPEAKER_BRACKET_RE = /^【([^】\r\n]{1,32})】/;
const TYRANO_SPEAKER_TAG_RE = /^#([^#\r\n]{1,28})$/;

function isSafeFormId(formId: string): boolean {
  return FORM_ID_RE.test(formId) && !formId.includes('..');
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  if (isSymlinkPath(targetPath)) {
    throw new RosterError(`拒绝写入符号链接：${path.basename(targetPath)}`);
  }
  const tmp = `${targetPath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    if (fs.existsSync(tmp)) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore cleanup error
      }
    }
    throw err;
  }
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (isSymlinkPath(filePath) || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function readBuildJsonl(filePath: string): Array<Record<string, unknown>> {
  try {
    if (isSymlinkPath(filePath) || !fs.existsSync(filePath)) return [];
    const st = fs.statSync(filePath);
    if (!st.isFile()) return [];
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          out.push(obj as Record<string, unknown>);
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readTextManifestMeta(workspace: string): { exists: boolean; digest: string; engine: string } {
  const manifestPath = resolveWorkspacePaths(workspace).textManifestFile;
  const obj = readJsonSafe<Record<string, unknown>>(manifestPath);
  if (!obj) return { exists: false, digest: '', engine: '' };
  return {
    exists: true,
    digest: typeof obj.digest === 'string' ? obj.digest.trim() : '',
    engine: typeof obj.engine === 'string' ? obj.engine.trim().toLowerCase() : '',
  };
}

export const normalizeGender = normalizeCharacterGender;

const INLINE_RUBY_AT_RE = /@r([^@\r\n]+)@[^@\r\n]*@/g;
const INLINE_RUBY_Aozora_RE = /[|｜]([^《\r\n]+)《[^》\r\n]*》/g;

function stripInlineRubyForName(text: string): string {
  return text.replace(INLINE_RUBY_AT_RE, '$1').replace(INLINE_RUBY_Aozora_RE, '$1');
}

function cleanSingleLine(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function normalizeAliases(raw: unknown, canonicalSource: string): CharacterAlias[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CharacterAlias[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const source = cleanSingleLine(rec.source);
    const target = cleanSingleLine(rec.target);
    if (!source || !target) continue;
    if (source === canonicalSource) continue;
    if (seen.has(source)) continue;
    seen.add(source);
    out.push({ source, target });
  }
  return out;
}

function normalizeSpeakerIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const val = cleanSingleLine(item);
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
  }
  return out;
}

function normalizeSamples(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const val = cleanSingleLine(item).slice(0, MAX_SAMPLE_CHARS);
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= MAX_SAMPLES_PER_CHARACTER) break;
  }
  return out;
}

function makeCharacterId(sourceName: string): string {
  const hash = crypto.createHash('sha256').update(sourceName, 'utf8').digest('hex').slice(0, 8);
  const ascii = sourceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return ascii ? `ch_${ascii}_${hash}` : `ch_${hash}`;
}

function isPlausibleCharacterName(name: string): boolean {
  const t = name.trim();
  if (!t || t.length > 36) return false;
  if (PURE_PUNCT_OR_NUM_RE.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return true;
}

export function writeCharacterRoster(workspace: string, store: CharacterRosterStore): string {
  const filePath = resolveWorkspacePaths(workspace).charactersFile;
  atomicWriteJson(filePath, store);
  return filePath;
}

function normalizeFormRecord(raw: unknown): ChatFormRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.schema !== 1 || rec.kind !== 'character_roster') return null;
  const formId = cleanSingleLine(rec.formId);
  if (!formId || !isSafeFormId(formId)) return null;
  const status: ChatFormStatus =
    rec.status === 'submitted' || rec.status === 'superseded' || rec.status === 'cancelled'
      ? rec.status
      : 'pending';
  const rawItems = Array.isArray(rec.items) ? rec.items : [];
  const items: CharacterRosterFormItem[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const sourceName = cleanSingleLine(r.sourceName);
    if (!sourceName) continue;
    const defaultTarget = cleanSingleLine(r.defaultTarget);
    const targetName = cleanSingleLine(r.targetName) || defaultTarget;
    const note = cleanSingleLine(r.note);
    const occ =
      typeof r.occurrences === 'number' && Number.isFinite(r.occurrences) && r.occurrences >= 0
        ? Math.floor(r.occurrences)
        : 0;
    items.push({
      id: cleanSingleLine(r.id) || makeCharacterId(sourceName),
      sourceName,
      defaultTarget,
      targetName,
      speakerIds: normalizeSpeakerIds(r.speakerIds),
      aliases: normalizeAliases(r.aliases, sourceName),
      gender: normalizeGender(r.gender),
      ...(note ? { note } : {}),
      occurrences: occ,
      samples: normalizeSamples(r.samples),
    });
  }
  const rawExcluded = Array.isArray(rec.excludedItems) ? rec.excludedItems : [];
  const excludedItems: ChatFormExcludedItem[] = [];
  const seenExcluded = new Set<string>();
  for (const item of rawExcluded) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const sourceName = cleanSingleLine(r.sourceName);
    if (!sourceName || seenExcluded.has(sourceName)) continue;
    seenExcluded.add(sourceName);
    const reason = cleanSingleLine(r.reason);
    const occ =
      typeof r.occurrences === 'number' && Number.isFinite(r.occurrences) && r.occurrences >= 0
        ? Math.floor(r.occurrences)
        : 0;
    excludedItems.push({
      sourceName,
      ...(reason ? { reason } : {}),
      occurrences: occ,
      samples: normalizeSamples(r.samples),
    });
  }
  const summaryObj =
    rec.summary && typeof rec.summary === 'object' && !Array.isArray(rec.summary)
      ? (rec.summary as Record<string, unknown>)
      : null;
  return {
    schema: 1,
    formId,
    kind: 'character_roster',
    status,
    title: cleanSingleLine(rec.title) || '角色译名确认表',
    description: cleanSingleLine(rec.description),
    sessionId: typeof rec.sessionId === 'string' && rec.sessionId.trim() ? rec.sessionId.trim() : null,
    classifyDigest: typeof rec.classifyDigest === 'string' ? rec.classifyDigest.trim() : '',
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
    ...(typeof rec.submittedAt === 'string' && rec.submittedAt ? { submittedAt: rec.submittedAt } : {}),
    items,
    ...(excludedItems.length ? { excludedItems } : {}),
    ...(summaryObj
      ? {
          summary: {
            total: Number(summaryObj.total ?? items.length),
            editedCount: Number(summaryObj.editedCount || 0),
            glossaryEntriesAdded: Number(summaryObj.glossaryEntriesAdded || 0),
            ...(typeof summaryObj.dismissedCount === 'number' && Number.isFinite(summaryObj.dismissedCount)
              ? { dismissedCount: Math.max(0, Math.floor(summaryObj.dismissedCount)) }
              : {}),
          },
        }
      : {}),
  };
}

export function readChatForm(workspace: string, formId: string): ChatFormRecord | null {
  const cleanId = formId.trim();
  if (!isSafeFormId(cleanId)) return null;
  const filePath = resolveWorkspacePaths(workspace).formFile(cleanId);
  const raw = readJsonSafe<Record<string, unknown>>(filePath);
  return normalizeFormRecord(raw);
}

export function listChatForms(workspace: string): ChatFormRecord[] {
  const dir = resolveWorkspacePaths(workspace).formsDir;
  if (isSymlinkPath(dir) || !fs.existsSync(dir)) return [];
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  const out: ChatFormRecord[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const full = path.join(dir, ent.name);
    const parsed = normalizeFormRecord(readJsonSafe<Record<string, unknown>>(full));
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export function findPendingCharacterForm(workspace: string): ChatFormRecord | null {
  return listChatForms(workspace).find((f) => f.kind === 'character_roster' && f.status === 'pending') ?? null;
}

function writeChatForm(workspace: string, record: ChatFormRecord): string {
  if (!isSafeFormId(record.formId)) {
    throw new RosterError(`非法表单 ID：${record.formId}`);
  }
  const filePath = resolveWorkspacePaths(workspace).formFile(record.formId);
  atomicWriteJson(filePath, record);
  return filePath;
}

function readOptionalGlossaryMap(workspace: string): Record<string, string> {
  const loaded = loadProfile(workspace);
  const out: Record<string, string> = {};
  const gf = loaded.profile?.glossaryFile;
  if (gf) {
    const abs = path.resolve(realpathSafe(workspace), gf);
    const obj = readJsonSafe<Record<string, unknown>>(abs);
    if (obj) {
      for (const [k, v] of Object.entries(obj)) {
        const ks = cleanSingleLine(k);
        const vs = cleanSingleLine(v);
        if (ks && vs) out[ks] = vs;
      }
    }
  }
  return out;
}

/**
 * Deterministically extracts all appearing character candidates from build/scenario.jsonl & build/ui.jsonl.
 */
export function extractCharacterCandidates(
  workspace: string,
  options?: { controlPattern?: string | null; extraGlossary?: Record<string, string> }
): CharacterRosterExtractionResult {
  const ws = realpathSafe(workspace);
  const manifestMeta = readTextManifestMeta(ws);
  const controlPattern =
    options?.controlPattern !== undefined
      ? options.controlPattern
      : resolveWorkspaceControlPattern(ws, undefined, manifestMeta.engine || undefined);

  const wsPaths = resolveWorkspacePaths(ws);
  const scenarioRows = readBuildJsonl(wsPaths.buildTrackFile('scenario'));
  const uiRows = readBuildJsonl(wsPaths.buildTrackFile('ui'));

  interface CandidateAcc {
    sourceName: string;
    speakerIds: Set<string>;
    occurrences: number;
    sources: Set<CharacterCandidateSource>;
    samples: string[];
  }

  const byName = new Map<string, CandidateAcc>();
  const speakerIdToName = new Map<string, string>();

  const ensureAcc = (
    name: string,
    srcKind: CharacterCandidateSource
  ): CandidateAcc | null => {
    const clean = cleanSingleLine(stripControls(stripInlineRubyForName(name), controlPattern));
    if (!isPlausibleCharacterName(clean)) return null;
    let acc = byName.get(clean);
    if (!acc) {
      acc = {
        sourceName: clean,
        speakerIds: new Set<string>(),
        occurrences: 0,
        sources: new Set(),
        samples: [],
      };
      byName.set(clean, acc);
    }
    acc.sources.add(srcKind);
    return acc;
  };

  const pushSample = (acc: CandidateAcc, rawText: string) => {
    if (acc.samples.length >= MAX_SAMPLES_PER_CHARACTER) return;
    const clean = cleanSingleLine(stripControls(rawText, controlPattern)).slice(0, MAX_SAMPLE_CHARS);
    if (!clean || clean === acc.sourceName) return;
    if (!acc.samples.includes(clean)) {
      acc.samples.push(clean);
    }
  };

  // Pass 1: explicit kind === 'name' rows (highest confidence; may link speakerId -> display name)
  for (const row of [...uiRows, ...scenarioRows]) {
    if (String(row.kind || '').trim().toLowerCase() !== 'name') continue;
    const rawSource = typeof row.source === 'string' ? row.source : '';
    const acc = ensureAcc(rawSource, 'name_row');
    if (!acc) continue;
    acc.occurrences += 1;
    const spk = typeof row.speaker === 'string' ? cleanSingleLine(row.speaker) : '';
    if (spk) {
      acc.speakerIds.add(spk);
      speakerIdToName.set(spk, acc.sourceName);
    }
  }

  // Pass 2: speaker fields, inline 【speaker】 brackets, and Tyrano #name tags
  let currentTyranoSpeaker: CandidateAcc | null = null;
  for (const row of scenarioRows) {
    const rawSource = typeof row.source === 'string' ? row.source : '';
    const spk = typeof row.speaker === 'string' ? cleanSingleLine(row.speaker) : '';

    if (spk) {
      const mappedDisplay = speakerIdToName.get(spk);
      const targetName = mappedDisplay || spk;
      const acc = ensureAcc(targetName, 'speaker');
      if (acc) {
        acc.speakerIds.add(spk);
        acc.occurrences += 1;
        pushSample(acc, rawSource);
      }
      currentTyranoSpeaker = acc;
      continue;
    }

    const bracketMatch = INLINE_SPEAKER_BRACKET_RE.exec(rawSource.trim());
    if (bracketMatch) {
      const acc = ensureAcc(bracketMatch[1], 'inline_bracket');
      if (acc) {
        acc.speakerIds.add(acc.sourceName);
        acc.occurrences += 1;
        const body = rawSource.trim().slice(bracketMatch[0].length);
        pushSample(acc, body || rawSource);
      }
      currentTyranoSpeaker = acc;
      continue;
    }

    if (manifestMeta.engine === 'tyrano') {
      const trimmed = rawSource.trim();
      if (trimmed === '#') {
        currentTyranoSpeaker = null;
        continue;
      }
      const tyranoMatch = TYRANO_SPEAKER_TAG_RE.exec(trimmed);
      if (tyranoMatch && !HEX_COLOR_RE.test(trimmed)) {
        const acc = ensureAcc(tyranoMatch[1], 'tyrano_tag');
        if (acc) {
          acc.speakerIds.add(acc.sourceName);
          acc.occurrences += 1;
        }
        currentTyranoSpeaker = acc;
        continue;
      }
      if (currentTyranoSpeaker) {
        pushSample(currentTyranoSpeaker, rawSource);
      }
    }
  }

  // Pass 3 (fallback): only when Passes 1 & 2 found nothing, detect standalone speaker-name lines
  // immediately preceding quoted dialogue lines (`「...」` / `『...』`) in the same file.
  if (byName.size === 0) {
    for (let i = 0; i + 1 < scenarioRows.length; i++) {
      const row = scenarioRows[i];
      const nextRow = scenarioRows[i + 1];
      const fileA = typeof row.file === 'string' ? row.file.trim() : '';
      const fileB = typeof nextRow.file === 'string' ? nextRow.file.trim() : '';
      if (fileA !== fileB) continue;

      const nextRawSource = typeof nextRow.source === 'string' ? nextRow.source : '';
      const nextTrimmed = nextRawSource.trim();
      if (!nextTrimmed.startsWith('「') && !nextTrimmed.startsWith('『')) continue;

      const rawSource = typeof row.source === 'string' ? row.source : '';
      const cleanedName = cleanSingleLine(stripControls(stripInlineRubyForName(rawSource), controlPattern));
      if (cleanedName.length < 1 || cleanedName.length > 16) continue;
      if (/^[「『（(—―・]/.test(cleanedName)) continue;
      if (/[。！？!?…]/.test(cleanedName)) continue;
      if (!isPlausibleCharacterName(cleanedName)) continue;

      const acc = ensureAcc(cleanedName, 'standalone_say');
      if (!acc) continue;
      acc.occurrences += 1;
      pushSample(acc, nextRawSource);
    }
  }

  const existingRoster = readCharacterRoster(ws);
  const existingBySource = new Map<string, CharacterRosterEntry>();
  if (existingRoster) {
    for (const ch of existingRoster.characters) {
      existingBySource.set(ch.sourceName, ch);
    }
  }
  const dismissedNames = Array.from(
    new Set((existingRoster?.dismissedNames ?? []).map((n) => cleanSingleLine(n)).filter(Boolean))
  );
  const dismissedSet = new Set(dismissedNames);
  const glossaryMap = {
    ...readOptionalGlossaryMap(ws),
    ...(options?.extraGlossary ?? {}),
  };

  const candidates: ExtractedCharacterCandidate[] = Array.from(byName.values())
    .sort((a, b) => {
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      return a.sourceName.localeCompare(b.sourceName);
    })
    .map((acc) => {
      const prev = existingBySource.get(acc.sourceName);
      const existingTarget = prev?.targetName || glossaryMap[acc.sourceName] || undefined;
      const isDismissed = dismissedSet.has(acc.sourceName) && !prev;
      return {
        id: prev?.id || makeCharacterId(acc.sourceName),
        sourceName: acc.sourceName,
        speakerIds: Array.from(acc.speakerIds).sort(),
        occurrences: acc.occurrences,
        sources: Array.from(acc.sources),
        samples: acc.samples,
        ...(existingTarget ? { existingTarget } : {}),
        ...(prev?.aliases?.length ? { existingAliases: prev.aliases } : {}),
        ...(prev?.gender && prev.gender !== 'unknown' ? { existingGender: prev.gender } : {}),
        ...(prev?.note ? { existingNote: prev.note } : {}),
        ...(isDismissed ? { dismissed: true } : {}),
      };
    });

  const pendingForm = findPendingCharacterForm(ws);

  let status: CharacterRosterExtractionResult['status'] = 'unconfirmed';
  if (candidates.length === 0 && (!existingRoster || existingRoster.characters.length === 0)) {
    status = 'empty';
  } else if (existingRoster && existingRoster.status === 'locked') {
    const digestMismatch =
      Boolean(manifestMeta.digest) &&
      Boolean(existingRoster.classifyDigest) &&
      existingRoster.classifyDigest !== manifestMeta.digest;
    const missingNewCandidate = candidates.some(
      (c) =>
        !dismissedSet.has(c.sourceName) &&
        (!existingBySource.has(c.sourceName) || !existingBySource.get(c.sourceName)?.targetName.trim())
    );
    status = digestMismatch || missingNewCandidate ? 'stale' : 'locked';
  }

  return {
    status,
    classifyDigest: manifestMeta.digest,
    engine: manifestMeta.engine,
    totalCharacters: candidates.length,
    lockedCount: existingRoster?.status === 'locked' ? existingRoster.characters.length : 0,
    dismissedCount: existingRoster?.status === 'locked' ? dismissedNames.length : 0,
    dismissedNames: existingRoster?.status === 'locked' ? dismissedNames : [],
    pendingFormId: pendingForm?.formId ?? null,
    characters: candidates,
  };
}

/**
 * Creates a persisted pending character confirmation form (.papercup/vn/forms/<formId>.json)
 * and draft .papercup/vn/characters.json, superseding any older pending form.
 */
export function createCharacterConfirmationForm(
  workspace: string,
  input: {
    title?: string;
    description?: string;
    characters: CharacterConfirmationProposalItem[];
    excludedNames?: Array<string | CharacterExclusionProposalItem>;
  },
  options?: { sessionId?: string | null }
): ChatFormRecord {
  const ws = realpathSafe(workspace);
  const rawCharacters = Array.isArray(input.characters) ? input.characters : [];
  const rawExcluded = Array.isArray(input.excludedNames) ? input.excludedNames : [];
  if (rawCharacters.length === 0 && rawExcluded.length === 0) {
    throw new RosterError('characters 与 excludedNames 不能同时为空；请至少提供一位出场角色或标明已排除的非角色候选。');
  }
  if (rawCharacters.length > MAX_FORM_ITEMS) {
    throw new RosterError(`单次角色确认表单最多支持 ${MAX_FORM_ITEMS} 位角色。`);
  }

  const extracted = extractCharacterCandidates(ws);
  const extractedByName = new Map(extracted.characters.map((c) => [c.sourceName, c]));
  const existingRoster = readCharacterRoster(ws);
  const existingByName = new Map((existingRoster?.characters ?? []).map((c) => [c.sourceName, c]));

  const seenNames = new Set<string>();
  const items: CharacterRosterFormItem[] = [];

  for (let i = 0; i < rawCharacters.length; i++) {
    const raw = rawCharacters[i];
    if (!raw || typeof raw !== 'object') {
      throw new RosterError(`第 ${i + 1} 项角色数据无效。`);
    }
    const sourceName = cleanSingleLine(raw.sourceName);
    const defaultTarget = cleanSingleLine(raw.defaultTarget);
    if (!sourceName) {
      throw new RosterError(`第 ${i + 1} 项缺少非空 sourceName。`);
    }
    if (!defaultTarget) {
      throw new RosterError(`角色「${sourceName}」缺少非空 defaultTarget（请先给出默认译名）。`);
    }
    if (seenNames.has(sourceName)) {
      continue;
    }
    seenNames.add(sourceName);

    const ext = extractedByName.get(sourceName);
    const prev = existingByName.get(sourceName);
    const mergedSpeakerIds = Array.from(
      new Set([
        ...(ext?.speakerIds ?? []),
        ...(prev?.speakerIds ?? []),
        ...normalizeSpeakerIds(raw.speakerIds),
      ])
    ).sort();
    const aliases = normalizeAliases(raw.aliases ?? prev?.aliases, sourceName);
    const gender = raw.gender ? normalizeGender(raw.gender) : prev?.gender ?? 'unknown';
    const note = cleanSingleLine(raw.note) || prev?.note || '';
    const samples = ext?.samples?.length ? ext.samples : prev?.samples ?? [];
    const occurrences = ext?.occurrences ?? prev?.occurrences ?? 0;

    items.push({
      id: cleanSingleLine(raw.id) || ext?.id || prev?.id || makeCharacterId(sourceName),
      sourceName,
      defaultTarget,
      targetName: prev?.targetName || defaultTarget,
      speakerIds: mergedSpeakerIds,
      aliases,
      gender,
      ...(note ? { note } : {}),
      occurrences,
      samples,
    });
  }

  const excludedItems: ChatFormExcludedItem[] = [];
  const seenExcluded = new Set<string>();
  for (const raw of rawExcluded) {
    const sourceName =
      typeof raw === 'string'
        ? cleanSingleLine(raw)
        : raw && typeof raw === 'object'
          ? cleanSingleLine(raw.sourceName)
          : '';
    if (!sourceName || seenNames.has(sourceName) || seenExcluded.has(sourceName)) continue;
    seenExcluded.add(sourceName);
    const reason = raw && typeof raw === 'object' ? cleanSingleLine(raw.reason) : '';
    const ext = extractedByName.get(sourceName);
    excludedItems.push({
      sourceName,
      ...(reason ? { reason } : {}),
      occurrences: ext?.occurrences ?? 0,
      samples: ext?.samples ?? [],
    });
  }

  if (items.length === 0 && excludedItems.length === 0) {
    throw new RosterError('没有有效的角色或排除条目可发送确认表单。');
  }

  const now = new Date().toISOString();
  // Mark any previously pending character_roster forms as superseded
  for (const existing of listChatForms(ws)) {
    if (existing.kind === 'character_roster' && existing.status === 'pending') {
      writeChatForm(ws, {
        ...existing,
        status: 'superseded',
        updatedAt: now,
      });
    }
  }

  const formId = `roster-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const record: ChatFormRecord = {
    schema: 1,
    formId,
    kind: 'character_roster',
    status: 'pending',
    title: cleanSingleLine(input.title) || '角色译名确认表',
    description:
      cleanSingleLine(input.description) ||
      '请核对或编辑以下出场角色的中文译名；提交后将锁定角色名册并同步至术语表，随后自动开始翻译。',
    sessionId: options?.sessionId ?? null,
    classifyDigest: extracted.classifyDigest,
    createdAt: now,
    updatedAt: now,
    items,
    ...(excludedItems.length ? { excludedItems } : {}),
  };

  writeChatForm(ws, record);

  // Only overwrite characters.json as draft if not already locked (or save draft reference)
  if (!existingRoster || existingRoster.status !== 'locked') {
    const draftDismissed = excludedItems.map((e) => e.sourceName);
    writeCharacterRoster(ws, {
      schema: 1,
      status: 'draft',
      classifyDigest: extracted.classifyDigest,
      updatedAt: now,
      formId,
      characters: items.map((it) => ({
        id: it.id,
        sourceName: it.sourceName,
        targetName: it.targetName,
        speakerIds: it.speakerIds,
        aliases: it.aliases,
        gender: it.gender,
        ...(it.note ? { note: it.note } : {}),
        occurrences: it.occurrences,
        samples: it.samples,
      })),
      ...(draftDismissed.length ? { dismissedNames: draftDismissed } : {}),
    });
  }

  return record;
}

/**
 * Validates and persists a user's character confirmation form submission, locking .papercup/vn/characters.json.
 */
export function submitCharacterConfirmationForm(
  workspace: string,
  formId: string,
  submission: {
    items: CharacterConfirmationSubmissionItem[];
    dismissedNames?: string[];
  }
): {
  form: ChatFormRecord;
  roster: CharacterRosterStore;
  editedItems: Array<{ sourceName: string; defaultTarget: string; targetName: string }>;
  glossaryEntriesAdded: number;
} {
  const ws = realpathSafe(workspace);
  const existing = readChatForm(ws, formId);
  if (!existing) {
    throw new RosterError(`NOT_FOUND: 找不到角色确认表单 ${formId}。`);
  }
  if (existing.status === 'superseded') {
    throw new RosterError('CONFLICT: 该角色确认表单已被更新的表单替代，请使用最新表单提交。');
  }
  if (existing.status === 'cancelled') {
    throw new RosterError('CONFLICT: 该角色确认表单已取消，无法提交。');
  }
  if (!Array.isArray(submission.items)) {
    throw new RosterError('提交的角色译名列表不能为空。');
  }
  if (submission.items.length > MAX_FORM_ITEMS) {
    throw new RosterError(`单次最多提交 ${MAX_FORM_ITEMS} 位角色。`);
  }

  const prevItemById = new Map(existing.items.map((it) => [it.id, it]));
  const prevItemBySource = new Map(existing.items.map((it) => [it.sourceName, it]));
  const prevExcludedBySource = new Map((existing.excludedItems ?? []).map((it) => [it.sourceName, it]));

  const seenSource = new Set<string>();
  const finalItems: CharacterRosterFormItem[] = [];
  const editedItems: Array<{ sourceName: string; defaultTarget: string; targetName: string }> = [];

  for (let i = 0; i < submission.items.length; i++) {
    const raw = submission.items[i];
    if (!raw || typeof raw !== 'object') {
      throw new RosterError(`第 ${i + 1} 行角色数据无效。`);
    }
    const sourceName = cleanSingleLine(raw.sourceName);
    const targetName = cleanSingleLine(raw.targetName);
    if (!sourceName) {
      throw new RosterError(`第 ${i + 1} 行缺少角色原名。`);
    }
    if (!targetName) {
      throw new RosterError(`角色「${sourceName}」的译名不能为空。`);
    }
    if (seenSource.has(sourceName)) {
      throw new RosterError(`存在重复的角色原名：「${sourceName}」。`);
    }
    seenSource.add(sourceName);

    const prev = (raw.id ? prevItemById.get(raw.id) : undefined) ?? prevItemBySource.get(sourceName);
    const restoredExcluded = prevExcludedBySource.get(sourceName);
    const defaultTarget = prev?.defaultTarget || targetName;
    const speakerIds = Array.from(
      new Set([...(prev?.speakerIds ?? []), ...normalizeSpeakerIds(raw.speakerIds)])
    ).sort();
    const aliases = normalizeAliases(raw.aliases ?? prev?.aliases, sourceName);
    const gender = raw.gender ? normalizeGender(raw.gender) : prev?.gender ?? 'unknown';
    const note = raw.note !== undefined ? cleanSingleLine(raw.note) : prev?.note ?? '';

    if (prev && targetName !== prev.defaultTarget) {
      editedItems.push({ sourceName, defaultTarget: prev.defaultTarget, targetName });
    } else if (!prev) {
      editedItems.push({ sourceName, defaultTarget: '', targetName });
    }

    finalItems.push({
      id: prev?.id || cleanSingleLine(raw.id) || makeCharacterId(sourceName),
      sourceName,
      defaultTarget,
      targetName,
      speakerIds,
      aliases,
      gender,
      ...(note ? { note } : {}),
      occurrences: prev?.occurrences ?? restoredExcluded?.occurrences ?? 0,
      samples: prev?.samples ?? restoredExcluded?.samples ?? [],
    });
  }

  const manifestMeta = readTextManifestMeta(ws);
  const effectiveDigest = manifestMeta.digest || existing.classifyDigest;
  const existingRoster = readCharacterRoster(ws);

  const dismissedMap = new Map<string, ChatFormExcludedItem>();
  const addDismissed = (sourceName: string, meta?: Partial<ChatFormExcludedItem>) => {
    const clean = cleanSingleLine(sourceName);
    if (!clean || seenSource.has(clean)) return;
    const cur = dismissedMap.get(clean);
    if (cur) {
      if (!cur.reason && meta?.reason) cur.reason = meta.reason;
      return;
    }
    dismissedMap.set(clean, {
      sourceName: clean,
      ...(meta?.reason ? { reason: cleanSingleLine(meta.reason) } : {}),
      occurrences: meta?.occurrences ?? 0,
      samples: meta?.samples ? normalizeSamples(meta.samples) : [],
    });
  };

  for (const ex of existing.excludedItems ?? []) {
    addDismissed(ex.sourceName, ex);
  }
  for (const prev of existing.items) {
    if (!seenSource.has(prev.sourceName)) {
      addDismissed(prev.sourceName, {
        reason: '用户在确认表单中移除',
        occurrences: prev.occurrences,
        samples: prev.samples,
      });
    }
  }
  if (
    existingRoster &&
    (!effectiveDigest || !existingRoster.classifyDigest || existingRoster.classifyDigest === effectiveDigest)
  ) {
    for (const prevName of existingRoster.dismissedNames ?? []) {
      addDismissed(prevName);
    }
  }
  for (const rawName of submission.dismissedNames ?? []) {
    addDismissed(rawName);
  }

  const finalExcludedItems = Array.from(dismissedMap.values());
  const dismissedNames = finalExcludedItems.map((e) => e.sourceName);

  if (finalItems.length === 0 && dismissedNames.length === 0) {
    throw new RosterError('提交的角色译名列表不能为空。');
  }

  const now = new Date().toISOString();
  const roster: CharacterRosterStore = {
    schema: 1,
    status: 'locked',
    classifyDigest: effectiveDigest,
    updatedAt: now,
    confirmedAt: now,
    formId: existing.formId,
    characters: finalItems.map((it) => ({
      id: it.id,
      sourceName: it.sourceName,
      targetName: it.targetName,
      speakerIds: it.speakerIds,
      aliases: it.aliases,
      gender: it.gender,
      ...(it.note ? { note: it.note } : {}),
      occurrences: it.occurrences,
      samples: it.samples,
    })),
    ...(dismissedNames.length ? { dismissedNames } : {}),
  };

  const compiledGlossary = compileRosterToGlossary(roster);
  const glossaryEntriesAdded = Object.keys(compiledGlossary).length;

  writeCharacterRoster(ws, roster);

  const updatedForm: ChatFormRecord = {
    ...existing,
    status: 'submitted',
    classifyDigest: roster.classifyDigest,
    updatedAt: now,
    submittedAt: now,
    items: finalItems,
    ...(finalExcludedItems.length ? { excludedItems: finalExcludedItems } : { excludedItems: undefined }),
    summary: {
      total: finalItems.length,
      editedCount: editedItems.length,
      glossaryEntriesAdded,
      ...(dismissedNames.length ? { dismissedCount: dismissedNames.length } : {}),
    },
  };
  writeChatForm(ws, updatedForm);

  return {
    form: updatedForm,
    roster,
    editedItems,
    glossaryEntriesAdded,
  };
}

export function cancelChatForm(workspace: string, formId: string): ChatFormRecord {
  const ws = realpathSafe(workspace);
  const existing = readChatForm(ws, formId);
  if (!existing) {
    throw new RosterError(`NOT_FOUND: 找不到角色确认表单 ${formId}。`);
  }
  if (existing.status === 'submitted') {
    throw new RosterError('CONFLICT: 已提交锁定的表单无法取消。');
  }
  const updated: ChatFormRecord = {
    ...existing,
    status: 'cancelled',
    updatedAt: new Date().toISOString(),
  };
  writeChatForm(ws, updated);
  return updated;
}

/**
 * Deterministic pre-translation confirmation gate checked by `vn_translate_batches`.
 */
export function checkCharacterConfirmationGate(
  workspace: string,
  options?: {
    profile?: LocalizationProfile | null;
    allowUnconfirmedCharacters?: boolean;
  }
): CharacterGateResult {
  if (options?.allowUnconfirmedCharacters === true) {
    return { allowed: true };
  }
  const ws = realpathSafe(workspace);

  // Rule 1: If a confirmation form is actively waiting for the user, ALWAYS block translation until submitted.
  const pendingForm = findPendingCharacterForm(ws);
  if (pendingForm) {
    return {
      allowed: false,
      pendingFormId: pendingForm.formId,
      candidateCount: pendingForm.items.length,
      reason: `角色译名确认表单（${pendingForm.formId}，共 ${pendingForm.items.length} 位角色）尚未由用户提交确认。请等待用户在对话表单中编辑并提交后再开始批量翻译。`,
    };
  }

  // Rule 2: Respect explicit opt-out in papercup.toml [vn.localization] require_character_confirmation = false
  const profile = options?.profile ?? loadProfile(ws).profile;
  if (profile && profile.requireCharacterConfirmation === false) {
    return { allowed: true };
  }

  // Rule 3: For classified workspaces (.papercup/vn/text.json present) with detected characters,
  // require locked characters.json matching the current classification before batch translation.
  const manifestMeta = readTextManifestMeta(ws);
  if (!manifestMeta.exists) {
    return { allowed: true };
  }

  const extracted = extractCharacterCandidates(ws);
  if (extracted.totalCharacters === 0) {
    return { allowed: true, candidateCount: 0 };
  }

  if (extracted.status === 'locked') {
    return { allowed: true, candidateCount: extracted.totalCharacters };
  }

  const stateHint =
    extracted.status === 'stale'
      ? '脚本已重新分类或出现了未锁定译名的新角色'
      : `检测到 ${extracted.totalCharacters} 位出场角色尚未确认译名`;
  return {
    allowed: false,
    candidateCount: extracted.totalCharacters,
    reason: `翻译前角色译名尚未锁定（${stateHint}）。请先调用 vn_extract_roster 获取出场角色，拟定默认中文译名后调用 vn_request_character_confirmation 发送对话表单，等待用户确认提交后再执行 vn_translate_batches。`,
  };
}

const GENDER_LABELS: Record<CharacterGender, string> = {
  female: '女',
  male: '男',
  other: '其他',
  unknown: '',
};

/**
 * Formats a compact, deterministic <character_roster> prompt block for translators & role-checker.
 * When roster is large (>80 entries) and `activeContextText` / `activeSpeakers` are provided,
 * slices to only relevant characters so prompts never overflow or silently truncate.
 */
export function formatCharacterRosterForPrompt(
  characters: readonly CharacterRosterEntry[],
  options?: {
    activeSpeakers?: Iterable<string>;
    activeText?: string;
    maxEntries?: number;
  }
): string {
  if (!characters.length) return '';
  const maxEntries = options?.maxEntries ?? 80;
  let selected = characters;

  if (characters.length > maxEntries && (options?.activeSpeakers || options?.activeText)) {
    const speakerSet = new Set<string>();
    if (options?.activeSpeakers) {
      for (const s of options.activeSpeakers) {
        const clean = s.trim();
        if (clean) {
          speakerSet.add(clean);
          speakerSet.add(clean.toLowerCase());
        }
      }
    }
    const text = options?.activeText || '';
    const filtered = characters.filter((ch) => {
      if (speakerSet.has(ch.sourceName) || speakerSet.has(ch.sourceName.toLowerCase())) return true;
      if (ch.speakerIds.some((id) => speakerSet.has(id) || speakerSet.has(id.toLowerCase()))) return true;
      if (text && text.includes(ch.sourceName)) return true;
      if (text && ch.aliases.some((a) => a.source && text.includes(a.source))) return true;
      return false;
    });
    if (filtered.length > 0) {
      selected = filtered;
    } else {
      selected = characters.slice(0, maxEntries);
    }
  }

  return selected
    .map((ch) => {
      const meta: string[] = [];
      const gLabel = GENDER_LABELS[ch.gender];
      if (gLabel) meta.push(gLabel);
      if (ch.speakerIds.length > 0) {
        const extraIds = ch.speakerIds.filter((id) => id !== ch.sourceName);
        if (extraIds.length > 0) meta.push(`speaker=${extraIds.join('/')}`);
      }
      if (ch.aliases.length > 0) {
        meta.push(`别名:${ch.aliases.map((a) => `${a.source}=>${a.target}`).join('、')}`);
      }
      if (ch.note) meta.push(ch.note);
      const suffix = meta.length > 0 ? `（${meta.join('；')}）` : '';
      return `${ch.sourceName} => ${ch.targetName}${suffix}`;
    })
    .join('\n');
}

/**
 * Builds the concise structured wake-up message sent into the conversation after user form submission
 * (Grok Bot submit-callback wake-up pattern).
 */
export function buildCharacterFormConfirmationMessage(
  form: ChatFormRecord,
  editedItems: ReadonlyArray<{ sourceName: string; defaultTarget: string; targetName: string }>
): string {
  const total = form.items.length;
  const editedCount = editedItems.length;
  const dismissedCount = form.summary?.dismissedCount ?? form.excludedItems?.length ?? 0;
  const dismissedNote = dismissedCount > 0 ? `，另已排除 ${dismissedCount} 项非角色条目` : '';
  const lines: string[] = [
    total > 0
      ? `[角色译名表单已提交] 已确认并锁定 ${total} 位出场角色的译名${editedCount > 0 ? `（其中修改/新增了 ${editedCount} 项）` : '（全部采用默认译名）'}${dismissedNote}，已写入 ${CHARACTERS_REL} 并同步至术语表。`
      : `[角色译名表单已提交] 已确认无出场角色需要锁定（共排除 ${dismissedCount} 项非角色条目），已写入 ${CHARACTERS_REL}。`,
  ];

  const previewLimit = 30;
  const preview = form.items.slice(0, previewLimit).map((it) => {
    const aliasText =
      it.aliases.length > 0 ? `（别名：${it.aliases.map((a) => `${a.source}→${a.target}`).join('、')}）` : '';
    const changedMark = it.targetName !== it.defaultTarget ? ' [已修改]' : '';
    return `- ${it.sourceName} → ${it.targetName}${aliasText}${changedMark}`;
  });
  if (preview.length > 0) {
    lines.push('确认译名清单：', ...preview);
  }
  if (form.items.length > previewLimit) {
    lines.push(`… 其余 ${form.items.length - previewLimit} 位角色已完整锁定在 ${CHARACTERS_REL} 中。`);
  }
  lines.push('请严格按已锁定的角色译名表继续后续规划（vn_plan）与批量翻译（vn_translate_batches）。');
  return lines.join('\n');
}
