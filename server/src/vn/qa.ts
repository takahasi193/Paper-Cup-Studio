/**
 * Deterministic VN localization QA checks: control-tag preservation, placeholder check, length limits,
 * Japanese kana residue detection, and longest-match glossary checks.
 */

import type { LocalizationProfile } from './profile.js';

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

const CONTROL_PATTERN = /\[(?:ruby\b|\/)?[^\]\n]*\]|%[A-Za-z_][A-Za-z0-9_]*%|\\n|\\[A-Za-z]+(?:\[[^\]\n]*\])?/g;
const PLACEHOLDER_PATTERN = /⟦CTRL_\d+⟧/g;
const KANA_PATTERN = /[\u3040-\u309F\u30A0-\u30FF]/;

function hasUnclosedBracket(text: string): boolean {
  let inBracket = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') {
      if (inBracket) return true;
      inBracket = true;
    } else if (ch === ']') {
      if (!inBracket) return true;
      inBracket = false;
    } else if (ch === '\n') {
      if (inBracket) return true;
    }
  }
  return inBracket;
}

function extractControls(text: string): string[] {
  return text.match(CONTROL_PATTERN) ?? [];
}

function stripControls(text: string): string {
  return text.replace(CONTROL_PATTERN, '').replace(PLACEHOLDER_PATTERN, '');
}

export function qaReport(
  source: string,
  target: string,
  profile: LocalizationProfile,
  glossary: Record<string, string>
): QaReport {
  const findings: QaFinding[] = [];
  const add = (rule: string, severity: 'error' | 'warning', message: string) => {
    findings.push({ rule, severity, message });
  };

  if (!target.trim()) {
    add('target.empty', 'error', '译文不能为空。');
  }

  if (PLACEHOLDER_PATTERN.test(target)) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    add('placeholder.unrestored', 'error', '译文保留了未还原的控制符占位符 ⟦CTRL_…⟧。');
  }
  PLACEHOLDER_PATTERN.lastIndex = 0;

  if (hasUnclosedBracket(target)) {
    add('control.unclosed', 'error', '译文存在未闭合方括号控制符。');
  } else if (hasUnclosedBracket(source)) {
    // Source unclosed brackets can occur in stylized text; don't block unless controls mismatch.
  }

  const srcControls = extractControls(source);
  const tgtControls = extractControls(target);
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

  const srcPlain = stripControls(source);
  const tgtPlain = stripControls(target);

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
        if (!target.includes(expectedTgt)) {
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
      return findings.map((f) => `[${f.severity}] ${f.rule}: ${f.message}`);
    },
    asDict() {
      return {
        ok: !blocked,
        findings: findings.map((f) => ({ ...f })),
      };
    },
  };
}
