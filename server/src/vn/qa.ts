/**
 * Deterministic VN localization QA checks: control-tag preservation, placeholder check, length limits,
 * Japanese kana residue detection, and longest-match glossary checks.
 */

import type { CharacterRosterEntry, LocalizationProfile } from './profile.js';

export interface QaFinding {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface QaReport {
  blocked: boolean;
  findings: QaFinding[];
  lines(): string[];
  asDict(): {
    ok: boolean;
    findings: QaFinding[];
  };
}

export const DEFAULT_CONTROL_PATTERN =
  /\[(?:\/?[A-Za-z_][^\]\n]*|%[^\]\n]*)\]|%[A-Za-z_][A-Za-z0-9_]*%|\\n|\\[A-Za-z]+(?:\[[^\]\n]*\])?/g;
export const CONTROL_PATTERN = DEFAULT_CONTROL_PATTERN;
const PLACEHOLDER_PATTERN = /⟦(?:CTRL_\d+|\s*_?\d+(?:_\d+)*\s*)⟧/g;
const PLACEHOLDER_TEST_RE = /⟦(?:CTRL_\d+|\s*_?\d+(?:_\d+)*\s*)⟧/;
const KANA_PATTERN = /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\uFF66-\uFF9F]/;

export function buildControlPattern(customPattern?: string | null): RegExp {
  const custom = typeof customPattern === 'string' ? customPattern.trim() : '';
  if (custom) {
    try {
      const probe = new RegExp(custom);
      if (!probe.test('')) {
        // When an engine explicitly defines its control_pattern, honor it as authoritative
        // (alongside universal escaped literal `\n`) instead of forcing KAG bracket rules onto it.
        return new RegExp(`(?:${custom})|(?:\\\\n)`, 'g');
      }
    } catch {
      // Ignore invalid custom control pattern and fall back to default
    }
  }
  return new RegExp(DEFAULT_CONTROL_PATTERN.source, 'g');
}

function unmatchedBracketSignature(text: string): string {
  let depth = 0;
  const unmatched: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') {
      if (depth > 0) unmatched.push('[');
      depth += 1;
    } else if (ch === ']') {
      if (depth === 0) {
        unmatched.push(']');
      } else {
        depth -= 1;
      }
    } else if (ch === '\n') {
      while (depth > 0) {
        unmatched.push('[');
        depth -= 1;
      }
    }
  }
  while (depth > 0) {
    unmatched.push('[');
    depth -= 1;
  }
  return unmatched.join('');
}

export function extractControls(text: string, customPattern?: string | null): string[] {
  return text.match(buildControlPattern(customPattern)) ?? [];
}

export function stripControls(text: string, customPattern?: string | null): string {
  return text.replace(buildControlPattern(customPattern), '').replace(PLACEHOLDER_PATTERN, '');
}

export function qaReport(
  source: string,
  target: string,
  profile: LocalizationProfile,
  glossary: Record<string, string>,
  options?: { controlPattern?: string | null }
): QaReport {
  const findings: QaFinding[] = [];
  const add = (rule: string, severity: 'error' | 'warning', message: string) => {
    findings.push({ rule, severity, message });
  };
  const customPattern = options?.controlPattern;

  if (!target.trim()) {
    add('target.empty', 'error', '译文不能为空。');
  }

  if (!PLACEHOLDER_TEST_RE.test(source) && PLACEHOLDER_TEST_RE.test(target)) {
    add('placeholder.unrestored', 'error', '译文保留了未还原的控制符占位符 ⟦…⟧。');
  }

  const srcUnmatched = unmatchedBracketSignature(source);
  const tgtUnmatched = unmatchedBracketSignature(target);
  if (tgtUnmatched && tgtUnmatched !== srcUnmatched) {
    add('control.unclosed', 'error', '译文存在未闭合方括号控制符。');
  }

  const srcControls = extractControls(source, customPattern);
  const tgtControls = extractControls(target, customPattern);
  if (
    srcControls.length !== tgtControls.length ||
    srcControls.some((tok, idx) => tgtControls[idx] !== tok)
  ) {
    add(
      'control.mismatch',
      'error',
      `控制符不一致：原文 [${srcControls.join(' ')}]，译文 [${tgtControls.join(' ')}]。`
    );
  }

  const srcPlain = stripControls(source, customPattern);
  const tgtPlain = stripControls(target, customPattern);

  if (profile.maxLenAbs > 0 && tgtPlain.length > profile.maxLenAbs) {
    add(
      'length.absolute',
      'error',
      `译文长度 ${tgtPlain.length} 超过绝对上限 ${profile.maxLenAbs}。`
    );
  }

  if (
    profile.maxLenRatio > 0 &&
    srcPlain.length > 0 &&
    tgtPlain.length > Math.ceil(srcPlain.length * profile.maxLenRatio)
  ) {
    add(
      'length.ratio',
      'error',
      `译文长度 ${tgtPlain.length} 超过原文长度 ${srcPlain.length} 的 ${profile.maxLenRatio} 倍。`
    );
  }

  if (
    profile.residueCheck &&
    profile.targetLang.toLowerCase().startsWith('zh') &&
    target.trim() &&
    KANA_PATTERN.test(tgtPlain)
  ) {
    add('source.residue', 'error', '译文残留日文假名字符。');
  }

  // Longest-match glossary verification (non-overlapping on source text without controls)
  const terms = Object.keys(glossary)
    .filter((k) => k.trim().length > 0 && glossary[k]?.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  if (terms.length > 0 && target.trim()) {
    const occupied = new Uint8Array(srcPlain.length);
    for (const srcTerm of terms) {
      let searchFrom = 0;
      let matchedTerm = false;
      while (searchFrom < srcPlain.length) {
        const pos = srcPlain.indexOf(srcTerm, searchFrom);
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
          matchedTerm = true;
        }
        searchFrom = pos + srcTerm.length;
      }
      if (matchedTerm) {
        const expectedTgt = glossary[srcTerm];
        // General invariant: never create an impossible deadlock between `glossary.missing` and `source.residue`
        // when a glossary entry's target itself contains Japanese kana under zh* + residueCheck=true.
        const contradictsResidue =
          profile.residueCheck &&
          profile.targetLang.toLowerCase().startsWith('zh') &&
          KANA_PATTERN.test(expectedTgt);
        if (!contradictsResidue && !target.includes(expectedTgt)) {
          add('glossary.missing', 'error', `术语「${srcTerm}」未按术语表译为「${expectedTgt}」。`);
        }
      }
    }
  }

  const blocked = findings.some((f) => f.severity === 'error');
  return {
    blocked,
    findings,
    lines() {
      return findings.map((f) => `[${f.severity}] ${f.message ? `${f.rule}: ${f.message}` : f.rule}`);
    },
    asDict() {
      return {
        ok: !blocked,
        findings: findings.map((f) => ({ ...f })),
      };
    },
  };
}

export interface CrossRowNameRecord {
  id?: unknown;
  kind?: unknown;
  source?: unknown;
  target?: unknown;
}

/**
 * Deterministic cross-row character name consistency verification:
 * 1. `character.name_mismatch`: `kind === 'name'` rows matching a locked character (or alias)
 *    must translate cleanly to the locked target name.
 * 2. `character.name_inconsistent`: multiple `kind === 'name'` rows with the same source text
 *    must not produce conflicting translations across batches.
 */
export function checkCrossRowNameConsistency(
  rows: readonly CrossRowNameRecord[],
  options?: {
    characters?: readonly CharacterRosterEntry[];
    controlPattern?: string | null;
  }
): Map<string, QaFinding[]> {
  const findingsById = new Map<string, QaFinding[]>();
  const addFinding = (id: string, finding: QaFinding) => {
    const arr = findingsById.get(id) ?? [];
    arr.push(finding);
    findingsById.set(id, arr);
  };

  const controlPattern = options?.controlPattern;
  const lockedNameMap = new Map<string, string>();
  for (const ch of options?.characters ?? []) {
    const src = ch.sourceName.trim();
    const tgt = ch.targetName.trim();
    if (src && tgt) lockedNameMap.set(src, tgt);
    for (const alias of ch.aliases || []) {
      const aSrc = alias.source.trim();
      const aTgt = alias.target.trim();
      if (aSrc && aTgt && !lockedNameMap.has(aSrc)) {
        lockedNameMap.set(aSrc, aTgt);
      }
    }
  }

  const seenNameTargets = new Map<string, Array<{ id: string; target: string }>>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (String(row.kind ?? '').trim().toLowerCase() !== 'name') continue;
    const id = String(row.id ?? `row#${i}`);
    const srcPlain = stripControls(String(row.source ?? ''), controlPattern).trim();
    const tgtPlain = stripControls(String(row.target ?? ''), controlPattern).trim();
    if (!srcPlain || !tgtPlain) continue;

    const expected = lockedNameMap.get(srcPlain);
    if (expected && tgtPlain !== expected) {
      addFinding(id, {
        rule: 'character.name_mismatch',
        severity: 'error',
        message: `角色名「${srcPlain}」译为「${tgtPlain}」，与已锁定译名「${expected}」不一致。`,
      });
    }

    const bucket = seenNameTargets.get(srcPlain) ?? [];
    bucket.push({ id, target: tgtPlain });
    seenNameTargets.set(srcPlain, bucket);
  }

  for (const [srcPlain, entries] of seenNameTargets.entries()) {
    const distinctTargets = Array.from(new Set(entries.map((e) => e.target)));
    if (distinctTargets.length > 1) {
      const variants = distinctTargets.slice(0, 4).join(' / ');
      for (const entry of entries) {
        addFinding(entry.id, {
          rule: 'character.name_inconsistent',
          severity: 'error',
          message: `同一角色名「${srcPlain}」跨行出现多种译法（${variants}），请统一译名。`,
        });
      }
    }
  }

  return findingsById;
}
