/**
 * Deterministic VN translation packet & envelope engine:
 * - Peels leading/trailing control tags and balanced outer quotes into an immutable envelope
 * - Masks inline controls into short placeholders (⟦0⟧, ⟦1⟧, ...)
 * - Slices per-packet glossary terms and active speaker personas
 * - Maintains collision-free Translation Memory (TM) deduplication
 * - Cleans local MT output, restores inline controls & envelope, and validates via qaReport
 *
 * Pure TypeScript, zero external npm dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CharacterRosterEntry, LocalizationProfile, PersonaCard } from './profile.js';
import { buildControlPattern, qaReport, stripControls, type QaFinding } from './qa.js';
import { resolveWorkspacePaths } from './workspace-paths.js';

export type TranslationRoute = 'pending' | 'tm_cache' | 'local_mt' | 'cloud_escalated';

export interface TranslationEnvelope {
  leadingControls: string;
  openingQuote: string;
  closingQuote: string;
  trailingControls: string;
}

export interface InlineControlToken {
  placeholder: string;
  raw: string;
}

export interface TranslationUnit {
  id: string;
  track: 'scenario' | 'ui';
  file: string;
  line: number;
  scene: string;
  speaker: string;
  kind: string;
  originalSource: string;
  envelope: TranslationEnvelope;
  cleanSource: string;
  inlineTokens: InlineControlToken[];
  route: TranslationRoute;
  rawLocalTarget?: string;
  finalTarget?: string;
  qaOk?: boolean;
  qaFindings?: QaFinding[];
}

export interface TranslationContextPair {
  speaker?: string;
  source: string;
  target: string;
}

export interface TranslationPacket {
  packetId: string;
  batchId: string;
  track: 'scenario' | 'ui';
  context: {
    sourceLang: string;
    targetLang: string;
    narrativePov?: string;
    playerAddress?: string;
    glossarySlice: Record<string, string>;
    speakerHints: Record<string, string>;
    prevContext: TranslationContextPair[];
  };
  units: TranslationUnit[];
}

export interface BatchRouteStats {
  tm_cache: number;
  local_mt: number;
  cloud_escalated: number;
  cloud_subagent: number;
  qa_failed: number;
}

interface ControlSpan {
  raw: string;
  start: number;
  end: number;
}

const OUTER_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['「', '」'],
  ['『', '』'],
  ['（', '）'],
];

const PLACEHOLDER_RESIDUAL_RE = /⟦(?:CTRL_\d+|\s*_?\d+(?:_\d+)*\s*)⟧/;
const CHATTER_PREFIX_RE = /^(?:译文|翻译|中文|简体中文|Translation|Output)\s*[:：]\s*/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findControlSpans(text: string, controlPattern?: string | null): ControlSpan[] {
  const re = buildControlPattern(controlPattern);
  const spans: ControlSpan[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const start = m.index ?? -1;
    if (!raw || start < 0) continue;
    spans.push({ raw, start, end: start + raw.length });
  }
  return spans;
}

function hasSingleBalancedOuterWrapper(text: string, open: string, close: string): boolean {
  if (text.length < open.length + close.length + 1) return false;
  if (!text.startsWith(open) || !text.endsWith(close)) return false;

  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0 && i < text.length - 1) {
        // Outer wrapper closed before the end (e.g. "「A」と「B」"): do not peel
        return false;
      }
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function peelBalancedOuterQuotes(middle: string): {
  openingQuote: string;
  closingQuote: string;
  inner: string;
} {
  for (const [open, close] of OUTER_QUOTE_PAIRS) {
    if (hasSingleBalancedOuterWrapper(middle, open, close)) {
      const inner = middle.slice(open.length, middle.length - close.length);
      if (inner.trim().length > 0) {
        return { openingQuote: open, closingQuote: close, inner };
      }
    }
  }
  return { openingQuote: '', closingQuote: '', inner: middle };
}

/**
 * Peels contiguous leading/trailing controls (and boundary whitespace) plus balanced outer quotes
 * into an immutable envelope, then masks any remaining inline controls as ⟦0⟧, ⟦1⟧, ...
 */
export function extractEnvelopeAndMask(
  source: string,
  controlPattern?: string | null
): {
  envelope: TranslationEnvelope;
  cleanSource: string;
  inlineTokens: InlineControlToken[];
} {
  if (!source) {
    return {
      envelope: { leadingControls: '', openingQuote: '', closingQuote: '', trailingControls: '' },
      cleanSource: '',
      inlineTokens: [],
    };
  }

  const spans = findControlSpans(source, controlPattern);

  let leftIdx = 0;
  let leftSpanIdx = 0;
  while (true) {
    let wsEnd = leftIdx;
    while (wsEnd < source.length && /\s/.test(source[wsEnd])) {
      wsEnd++;
    }
    if (leftSpanIdx < spans.length && spans[leftSpanIdx].start === wsEnd) {
      leftIdx = spans[leftSpanIdx].end;
      leftSpanIdx++;
      continue;
    }
    leftIdx = wsEnd;
    break;
  }

  let rightIdx = source.length;
  let rightSpanIdx = spans.length - 1;
  while (true) {
    let wsStart = rightIdx;
    while (wsStart > leftIdx && /\s/.test(source[wsStart - 1])) {
      wsStart--;
    }
    if (
      rightSpanIdx >= leftSpanIdx &&
      spans[rightSpanIdx].end === wsStart &&
      spans[rightSpanIdx].start >= leftIdx
    ) {
      rightIdx = spans[rightSpanIdx].start;
      rightSpanIdx--;
      continue;
    }
    rightIdx = wsStart;
    break;
  }

  const leadingControls = source.slice(0, leftIdx);
  const trailingControls = source.slice(rightIdx);
  const middle = source.slice(leftIdx, rightIdx);

  if (!middle) {
    return {
      envelope: { leadingControls, openingQuote: '', closingQuote: '', trailingControls },
      cleanSource: '',
      inlineTokens: [],
    };
  }

  const middleSpans = spans.slice(leftSpanIdx, rightSpanIdx + 1);
  let openingQuote = '';
  let closingQuote = '';
  let innerStart = leftIdx;
  let innerEnd = rightIdx;

  // Peel outer quote wrapper only when quote chars are not part of an inline control span
  const firstSpanTouchesStart = middleSpans.some((s) => s.start === leftIdx);
  const lastSpanTouchesEnd = middleSpans.some((s) => s.end === rightIdx);
  if (!firstSpanTouchesStart && !lastSpanTouchesEnd) {
    const peeled = peelBalancedOuterQuotes(middle);
    if (peeled.openingQuote) {
      openingQuote = peeled.openingQuote;
      closingQuote = peeled.closingQuote;
      innerStart = leftIdx + peeled.openingQuote.length;
      innerEnd = rightIdx - peeled.closingQuote.length;
    }
  }

  const innerRaw = source.slice(innerStart, innerEnd);
  const useAltPrefix = /⟦\d+⟧/.test(innerRaw);
  const inlineTokens: InlineControlToken[] = [];
  let cleanSource = '';
  let cursor = innerStart;

  middleSpans.forEach((span, idx) => {
    if (span.start < innerStart || span.end > innerEnd) return;
    if (span.start > cursor) {
      cleanSource += source.slice(cursor, span.start);
    }
    let placeholder = useAltPrefix ? `⟦_${idx}⟧` : `⟦${idx}⟧`;
    while (innerRaw.includes(placeholder)) {
      placeholder = `⟦_${idx}_${inlineTokens.length}⟧`;
    }
    inlineTokens.push({ placeholder, raw: span.raw });
    cleanSource += placeholder;
    cursor = span.end;
  });
  if (cursor < innerEnd) {
    cleanSource += source.slice(cursor, innerEnd);
  }

  return {
    envelope: { leadingControls, openingQuote, closingQuote, trailingControls },
    cleanSource,
    inlineTokens,
  };
}

/**
 * Longest-match non-overlapping glossary slice containing terms present in `units`
 * (including speaker names and matched locked character roster entries/aliases).
 */
export function sliceGlossaryForUnits(
  units: TranslationUnit[],
  glossary: Record<string, string>,
  controlPattern?: string | null,
  characters?: readonly CharacterRosterEntry[]
): Record<string, string> {
  const effectiveGlossary: Record<string, string> = { ...glossary };
  for (const ch of characters ?? []) {
    if (ch.sourceName.trim() && ch.targetName.trim()) {
      effectiveGlossary[ch.sourceName.trim()] = ch.targetName.trim();
    }
    for (const a of ch.aliases || []) {
      if (a.source.trim() && a.target.trim() && !(a.source.trim() in effectiveGlossary)) {
        effectiveGlossary[a.source.trim()] = a.target.trim();
      }
    }
  }

  const terms = Object.keys(effectiveGlossary)
    .filter((k) => k.trim().length > 0 && effectiveGlossary[k]?.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  if (!terms.length || !units.length) return {};

  const matched = new Map<string, string>();
  const speakerSet = new Set<string>();
  for (const unit of units) {
    const spk = unit.speaker.trim();
    if (spk) {
      speakerSet.add(spk);
      speakerSet.add(spk.toLowerCase());
      if (effectiveGlossary[spk] && !matched.has(spk)) {
        matched.set(spk, effectiveGlossary[spk]);
      }
    }
    const plain = stripControls(unit.originalSource, controlPattern);
    if (!plain) continue;
    const occupied = new Uint8Array(plain.length);
    for (const srcTerm of terms) {
      let searchFrom = 0;
      let hit = false;
      while (searchFrom < plain.length) {
        const pos = plain.indexOf(srcTerm, searchFrom);
        if (pos < 0) break;
        let overlap = false;
        for (let i = pos; i < pos + srcTerm.length; i++) {
          if (occupied[i]) {
            overlap = true;
            break;
          }
        }
        if (!overlap) {
          for (let i = pos; i < pos + srcTerm.length; i++) occupied[i] = 1;
          hit = true;
        }
        searchFrom = pos + srcTerm.length;
      }
      if (hit && !matched.has(srcTerm)) {
        matched.set(srcTerm, effectiveGlossary[srcTerm]);
      }
    }
  }

  // Also include canonical name + aliases for any speaking character matched via speakerIds
  for (const ch of characters ?? []) {
    const isActiveSpeaker =
      speakerSet.has(ch.sourceName) ||
      speakerSet.has(ch.sourceName.toLowerCase()) ||
      ch.speakerIds.some((id) => speakerSet.has(id) || speakerSet.has(id.toLowerCase()));
    if (!isActiveSpeaker) continue;
    if (ch.sourceName.trim() && ch.targetName.trim() && !matched.has(ch.sourceName.trim())) {
      matched.set(ch.sourceName.trim(), ch.targetName.trim());
    }
    for (const a of ch.aliases || []) {
      if (a.source.trim() && a.target.trim() && !matched.has(a.source.trim())) {
        matched.set(a.source.trim(), a.target.trim());
      }
    }
  }

  const out: Record<string, string> = {};
  for (const [k, v] of matched.entries()) {
    out[k] = v;
  }
  return out;
}

function findPersonaCard(
  persona: Record<string, PersonaCard>,
  speaker: string
): PersonaCard | undefined {
  if (persona[speaker]) return persona[speaker];
  const trimmed = speaker.trim();
  if (persona[trimmed]) return persona[trimmed];
  const lower = trimmed.toLowerCase();
  for (const [k, v] of Object.entries(persona)) {
    if (k.trim().toLowerCase() === lower) return v;
  }
  return undefined;
}

function tokenizeSceneOrder(scene: string): Array<number | string> {
  const tokens: Array<number | string> = [];
  const re = /(\d+)|(\D+)/g;
  for (const m of scene.trim().toLowerCase().matchAll(re)) {
    if (m[1] !== undefined) tokens.push(Number(m[1]));
    else if (m[2] !== undefined) tokens.push(m[2]);
  }
  return tokens;
}

function compareSceneOrder(a: string, b: string): number {
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (aTrim === bTrim) return 0;
  const ta = tokenizeSceneOrder(aTrim);
  const tb = tokenizeSceneOrder(bTrim);
  const len = Math.min(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const va = ta[i];
    const vb = tb[i];
    if (va === vb) continue;
    if (typeof va === 'number' && typeof vb === 'number') {
      return va - vb;
    }
    return String(va) < String(vb) ? -1 : 1;
  }
  return ta.length - tb.length;
}

function findCharacterEntry(
  characters: readonly CharacterRosterEntry[] | undefined,
  speaker: string
): CharacterRosterEntry | undefined {
  if (!characters || !characters.length) return undefined;
  const trimmed = speaker.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  return characters.find(
    (ch) =>
      ch.sourceName.trim() === trimmed ||
      ch.sourceName.trim().toLowerCase() === lower ||
      ch.speakerIds.some((id) => id.trim() === trimmed || id.trim().toLowerCase() === lower)
  );
}

/**
 * Extracts compact 1-line persona & locked character identity hints ONLY for speakers appearing in `units`.
 * Stages inherit by natural scene order (latest stage with `fromScene <= currentScene`),
 * while twists apply at `atScene` and propagate `reveals` to later scenes.
 */
export function sliceSpeakerHints(
  units: TranslationUnit[],
  persona: Record<string, PersonaCard>,
  characters?: readonly CharacterRosterEntry[]
): Record<string, string> {
  if ((!Object.keys(persona).length && !(characters && characters.length)) || !units.length) return {};
  const scenesBySpeaker = new Map<string, Set<string>>();
  for (const unit of units) {
    const spk = unit.speaker.trim();
    if (!spk) continue;
    let set = scenesBySpeaker.get(spk);
    if (!set) {
      set = new Set();
      scenesBySpeaker.set(spk, set);
    }
    if (unit.scene.trim()) {
      set.add(unit.scene.trim());
    }
  }

  const genderLabel: Record<string, string> = { female: '女', male: '男', other: '其他' };
  const hints: Record<string, string> = {};
  for (const [speaker, scenes] of scenesBySpeaker.entries()) {
    const ch = findCharacterEntry(characters, speaker);
    const card =
      findPersonaCard(persona, speaker) ||
      (ch ? findPersonaCard(persona, ch.sourceName) || findPersonaCard(persona, ch.targetName) : undefined);
    if (!card && !ch) continue;
    const parts: string[] = [];
    if (ch && ch.targetName.trim()) {
      const g = genderLabel[ch.gender] ? `（${genderLabel[ch.gender]}）` : '';
      parts.push(`译名：${ch.targetName.trim()}${g}`);
      if (ch.note) parts.push(ch.note);
    }
    if (card?.base) parts.push(card.base);

    const orderedScenes = Array.from(scenes).sort(compareSceneOrder);
    if (card && orderedScenes.length > 0 && card.stages.length > 0) {
      const sortedStages = [...card.stages]
        .filter((st) => st.fromScene && st.voice)
        .sort((a, b) => compareSceneOrder(a.fromScene, b.fromScene));
      const pickedStageKeys = new Set<string>();
      for (const curScene of orderedScenes) {
        let activeStage = sortedStages.find((st) => st.fromScene.trim() === curScene);
        if (!activeStage) {
          for (const st of sortedStages) {
            if (compareSceneOrder(st.fromScene, curScene) <= 0) {
              activeStage = st;
            }
          }
        }
        if (activeStage) {
          const key = `${activeStage.fromScene}\0${activeStage.voice}`;
          if (!pickedStageKeys.has(key)) {
            pickedStageKeys.add(key);
            parts.push(`阶段(${activeStage.fromScene}): ${activeStage.voice}`);
          }
        }
      }
    }

    if (card && orderedScenes.length > 0 && card.twists.length > 0) {
      const latestScene = orderedScenes[orderedScenes.length - 1];
      for (const tw of card.twists) {
        if (!tw.atScene) continue;
        if (scenes.has(tw.atScene)) {
          if (tw.note) {
            parts.push(`转折(${tw.atScene}): ${tw.note}${tw.reveals ? `（${tw.reveals}）` : ''}`);
          }
        } else if (tw.reveals && compareSceneOrder(tw.atScene, latestScene) <= 0) {
          parts.push(`已知(${tw.atScene}): ${tw.reveals}`);
        }
      }
    }

    const joined = parts.join('；').trim();
    if (joined) {
      hints[speaker] = joined.length > 180 ? `${joined.slice(0, 179)}…` : joined;
    }
  }
  return hints;
}

function stripOneMatchingOuterQuote(text: string): string {
  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['「', '」'],
    ['『', '』'],
    ['（', '）'],
    ['“', '”'],
    ['"', '"'],
  ];
  for (const [open, close] of quotePairs) {
    if (hasSingleBalancedOuterWrapper(text, open, close)) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

/**
 * Deterministic output cleaner for local MT models (strips <think>, fences, chatter prefixes,
 * echoed speaker names, redundant outer quotes when already captured in envelope, and raw newlines).
 */
export function cleanLocalModelOutput(rawLine: string, unit: TranslationUnit): string {
  let out = String(rawLine ?? '').replace(/^\uFEFF/, '');
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<think>[\s\S]*$/gi, '');
  out = out.trim();

  if (out.startsWith('```')) {
    const lines = out.split(/\r?\n/);
    if (lines.length >= 2 && lines[lines.length - 1].trim().startsWith('```')) {
      out = lines.slice(1, -1).join(' ').trim();
    }
  }

  // Collapse raw newlines so checkinBatch single-line JSONL invariant never breaks
  out = out.replace(/\s*[\r\n]+\s*/g, ' ').trim();

  if (!CHATTER_PREFIX_RE.test(unit.cleanSource)) {
    out = out.replace(CHATTER_PREFIX_RE, '').trim();
  }

  const spk = unit.speaker.trim();
  if (spk && !unit.cleanSource.startsWith(spk) && !unit.cleanSource.startsWith(`【${spk}】`)) {
    const escaped = escapeRegExp(spk);
    const echoedRe = new RegExp(`^(?:【${escaped}】|\\[${escaped}\\])\\s*[:：]?\\s*|^${escaped}\\s*[:：]\\s*`);
    out = out.replace(echoedRe, '').trim();
  }

  if (unit.envelope.openingQuote && unit.envelope.closingQuote) {
    out = stripOneMatchingOuterQuote(out);
  }

  return out.trim();
}

export function restoreInlineTokens(text: string, inlineTokens: InlineControlToken[]): string {
  let out = text;
  for (const tok of inlineTokens) {
    if (out.includes(tok.placeholder)) {
      out = out.split(tok.placeholder).join(tok.raw);
      continue;
    }
    const numMatch = /^⟦(_?\d+(?:_\d+)?)⟧$/.exec(tok.placeholder);
    if (numMatch) {
      const relaxed = new RegExp(`⟦\\s*${escapeRegExp(numMatch[1])}\\s*⟧`, 'g');
      out = out.replace(relaxed, tok.raw);
    }
  }
  return out;
}

export function wrapWithEnvelope(innerTarget: string, envelope: TranslationEnvelope): string {
  return `${envelope.leadingControls}${envelope.openingQuote}${innerTarget}${envelope.closingQuote}${envelope.trailingControls}`;
}

export function reassembleUnit(
  unit: TranslationUnit,
  rawLocalTarget: string,
  profile: LocalizationProfile,
  glossary: Record<string, string>,
  options?: { controlPattern?: string | null }
): TranslationUnit {
  const cleaned = cleanLocalModelOutput(rawLocalTarget, unit);
  const restored = restoreInlineTokens(cleaned, unit.inlineTokens);
  const finalTarget = wrapWithEnvelope(restored, unit.envelope);

  const report = qaReport(unit.originalSource, finalTarget, profile, glossary, {
    controlPattern: options?.controlPattern,
  });
  const findings = [...report.findings];

  if (!PLACEHOLDER_RESIDUAL_RE.test(unit.originalSource) && PLACEHOLDER_RESIDUAL_RE.test(finalTarget)) {
    findings.push({
      rule: 'placeholder.unrestored',
      severity: 'error',
      message: '译文保留了未还原的内联占位符 ⟦…⟧。',
    });
  }

  const qaOk = !findings.some((f) => f.severity === 'error');
  return {
    ...unit,
    route: 'local_mt',
    rawLocalTarget,
    finalTarget,
    qaOk,
    qaFindings: findings,
  };
}

/**
 * Collision-free in-memory Translation Memory cache.
 */
export class TranslationMemoryCache {
  private entries = new Map<string, string>();

  private buildKey(unit: TranslationUnit): string | null {
    const clean = unit.cleanSource.trim();
    if (!clean) return null;
    const inlineSig = unit.inlineTokens.map((t) => t.raw).join('\u0001');
    if (unit.track === 'ui') {
      return `ui\0${clean}\0${inlineSig}`;
    }
    return `scenario\0${unit.speaker.trim()}\0${clean}\0${inlineSig}`;
  }

  getKey(unit: TranslationUnit): string | null {
    return this.buildKey(unit);
  }

  lookup(
    unit: TranslationUnit,
    profile: LocalizationProfile,
    glossary: Record<string, string>,
    controlPattern?: string | null
  ): TranslationUnit | null {
    const key = this.buildKey(unit);
    if (!key) return null;
    const innerTarget = this.entries.get(key);
    if (!innerTarget) return null;
    const finalTarget = wrapWithEnvelope(innerTarget, unit.envelope);
    const report = qaReport(unit.originalSource, finalTarget, profile, glossary, {
      controlPattern,
    });
    if (report.blocked) return null;
    if (!PLACEHOLDER_RESIDUAL_RE.test(unit.originalSource) && PLACEHOLDER_RESIDUAL_RE.test(finalTarget)) {
      return null;
    }
    return {
      ...unit,
      route: 'tm_cache',
      finalTarget,
      qaOk: true,
      qaFindings: [],
    };
  }

  remember(unit: TranslationUnit, innerOrFinal?: string): void {
    if (unit.qaOk === false) return;
    const key = this.buildKey(unit);
    if (!key) return;
    const candidate = innerOrFinal ?? unit.finalTarget ?? '';
    if (!candidate.trim()) return;

    const env = unit.envelope;
    const prefix = `${env.leadingControls}${env.openingQuote}`;
    const suffix = `${env.closingQuote}${env.trailingControls}`;
    let inner = candidate;
    if (prefix || suffix) {
      if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) {
        return;
      }
      inner = candidate.slice(prefix.length, candidate.length - suffix.length);
    }
    if (!inner.trim()) return;
    this.entries.set(key, inner);
  }

  seedFromRows(
    rows: Array<Record<string, unknown>>,
    defaultTrack: 'scenario' | 'ui',
    profile: LocalizationProfile,
    glossary: Record<string, string>,
    controlPattern?: string | null
  ): void {
    for (const row of rows) {
      if (row.ok === false) continue;
      const source = typeof row.source === 'string' ? row.source : '';
      const target = typeof row.target === 'string' ? row.target : '';
      if (!source || !target.trim()) continue;
      const track: 'scenario' | 'ui' = row.track === 'ui' ? 'ui' : row.track === 'scenario' ? 'scenario' : defaultTrack;
      const { envelope, cleanSource, inlineTokens } = extractEnvelopeAndMask(source, controlPattern);
      if (!cleanSource.trim()) continue;
      const unit: TranslationUnit = {
        id: String(row.id ?? ''),
        track,
        file: String(row.file ?? ''),
        line: Number(row.line ?? 0),
        scene: String(row.scene ?? ''),
        speaker: String(row.speaker ?? ''),
        kind: String(row.kind ?? (track === 'ui' ? 'button' : 'say')),
        originalSource: source,
        envelope,
        cleanSource,
        inlineTokens,
        route: 'tm_cache',
        finalTarget: target,
      };
      const rep = qaReport(source, target, profile, glossary, { controlPattern });
      if (!rep.blocked) {
        this.remember(unit, target);
      }
    }
  }

  seedFromWorkspaceOutDir(
    cwd: string,
    profile: LocalizationProfile,
    glossary: Record<string, string>,
    controlPattern?: string | null
  ): void {
    const outDir = resolveWorkspacePaths(cwd).workOutDir;
    if (!fs.existsSync(outDir)) return;
    let files: string[] = [];
    try {
      files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return;
    }
    for (const file of files) {
      const full = path.join(outDir, file);
      try {
        if (fs.lstatSync(full).isSymbolicLink()) continue;
        const raw = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
        const rows: Array<Record<string, unknown>> = [];
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          rows.push(JSON.parse(line) as Record<string, unknown>);
        }
        this.seedFromRows(rows, 'scenario', profile, glossary, controlPattern);
      } catch {
        // Ignore malformed batch output while warming TM
      }
    }
  }
}

export function buildTranslationUnits(
  sourceRows: Array<Record<string, unknown>>,
  track: 'scenario' | 'ui',
  options: {
    profile: LocalizationProfile;
    glossary: Record<string, string>;
    controlPattern?: string | null;
    tmCache?: TranslationMemoryCache | null;
  }
): TranslationUnit[] {
  const units: TranslationUnit[] = [];
  for (const row of sourceRows) {
    const originalSource = String(row.source ?? '');
    const { envelope, cleanSource, inlineTokens } = extractEnvelopeAndMask(
      originalSource,
      options.controlPattern
    );
    const baseUnit: TranslationUnit = {
      id: String(row.id ?? `${row.file || ''}#${row.line || ''}`),
      track,
      file: String(row.file ?? ''),
      line: Number(row.line ?? 0),
      scene: String(row.scene ?? ''),
      speaker: String(row.speaker ?? ''),
      kind: String(row.kind ?? (track === 'ui' ? 'button' : 'say')),
      originalSource,
      envelope,
      cleanSource,
      inlineTokens,
      route: 'pending',
    };

    // Pure control-only / whitespace-only rows never require LLM translation
    if (!cleanSource.trim()) {
      units.push({
        ...baseUnit,
        route: 'tm_cache',
        finalTarget: originalSource,
        qaOk: true,
        qaFindings: [],
      });
      continue;
    }

    if (options.tmCache) {
      const hit = options.tmCache.lookup(
        baseUnit,
        options.profile,
        options.glossary,
        options.controlPattern
      );
      if (hit) {
        units.push(hit);
        continue;
      }
    }

    units.push(baseUnit);
  }
  return units;
}

export function partitionIntoPackets(
  pendingUnits: TranslationUnit[],
  batchId: string,
  track: 'scenario' | 'ui',
  packetLines: number,
  contextOpts: {
    profile: LocalizationProfile;
    glossary: Record<string, string>;
    persona: Record<string, PersonaCard>;
    characters?: readonly CharacterRosterEntry[];
    controlPattern?: string | null;
    initialPrevContext?: TranslationContextPair[];
  }
): TranslationPacket[] {
  const size = Math.max(1, Math.min(50, Math.floor(packetLines)));
  const packets: TranslationPacket[] = [];
  for (let i = 0, pIdx = 0; i < pendingUnits.length; i += size, pIdx++) {
    const slice = pendingUnits.slice(i, i + size);
    packets.push({
      packetId: `${batchId}#p${pIdx}`,
      batchId,
      track,
      context: {
        sourceLang: contextOpts.profile.sourceLang || 'ja',
        targetLang: contextOpts.profile.targetLang || 'zh',
        narrativePov: contextOpts.profile.narrativePov,
        playerAddress: contextOpts.profile.playerAddress,
        glossarySlice: sliceGlossaryForUnits(
          slice,
          contextOpts.glossary,
          contextOpts.controlPattern,
          contextOpts.characters
        ),
        speakerHints: sliceSpeakerHints(slice, contextOpts.persona, contextOpts.characters),
        prevContext: pIdx === 0 && contextOpts.initialPrevContext ? [...contextOpts.initialPrevContext] : [],
      },
      units: slice,
    });
  }
  return packets;
}

export function computeBatchRouteStats(
  units: TranslationUnit[],
  mode: 'cloud_subagent' | 'local_mt'
): BatchRouteStats {
  const stats: BatchRouteStats = {
    tm_cache: 0,
    local_mt: 0,
    cloud_escalated: 0,
    cloud_subagent: 0,
    qa_failed: 0,
  };
  if (mode === 'cloud_subagent') {
    stats.cloud_subagent = units.length;
    return stats;
  }
  for (const unit of units) {
    if (unit.route === 'tm_cache') stats.tm_cache++;
    else if (unit.route === 'cloud_escalated') stats.cloud_escalated++;
    else stats.local_mt++;
    if (unit.qaOk === false) stats.qa_failed++;
  }
  return stats;
}
