/**
 * Model-aware VN source token estimation and sizing helpers.
 * Pure TypeScript, zero external dependencies.
 */

export interface ModelWeights {
  cjk: number;
  kana: number;
  latin: number;
  digit: number;
  space: number;
  punct: number;
  other: number;
  overhead: number;
}

export const MODEL_FAMILIES: Record<string, ModelWeights> = {
  qwen: { cjk: 1.05, kana: 1.15, latin: 0.28, digit: 0.35, space: 0.15, punct: 0.65, other: 1.1, overhead: 10 },
  deepseek: { cjk: 1.02, kana: 1.12, latin: 0.27, digit: 0.34, space: 0.15, punct: 0.6, other: 1.05, overhead: 10 },
  gemini: { cjk: 0.92, kana: 1.0, latin: 0.25, digit: 0.3, space: 0.12, punct: 0.5, other: 1.0, overhead: 8 },
  claude: { cjk: 1.35, kana: 1.3, latin: 0.27, digit: 0.35, space: 0.15, punct: 0.75, other: 1.35, overhead: 10 },
  openai: { cjk: 1.25, kana: 1.22, latin: 0.26, digit: 0.33, space: 0.14, punct: 0.65, other: 1.25, overhead: 10 },
  glm: { cjk: 1.05, kana: 1.15, latin: 0.28, digit: 0.35, space: 0.15, punct: 0.65, other: 1.1, overhead: 10 },
  kimi: { cjk: 1.05, kana: 1.15, latin: 0.28, digit: 0.35, space: 0.15, punct: 0.65, other: 1.1, overhead: 10 },
  minimax: { cjk: 1.08, kana: 1.18, latin: 0.28, digit: 0.35, space: 0.15, punct: 0.65, other: 1.1, overhead: 10 },
  step: { cjk: 1.08, kana: 1.18, latin: 0.28, digit: 0.35, space: 0.15, punct: 0.65, other: 1.1, overhead: 10 },
  doubao: { cjk: 1.05, kana: 1.15, latin: 0.28, digit: 0.35, space: 0.15, punct: 0.65, other: 1.1, overhead: 10 },
  generic: { cjk: 1.2, kana: 1.25, latin: 0.28, digit: 0.35, space: 0.15, punct: 0.7, other: 1.25, overhead: 10 },
};

const FAMILY_ALIASES: Array<[string, string]> = [
  ['qwen', 'qwen'],
  ['dashscope', 'qwen'],
  ['deepseek', 'deepseek'],
  ['gemini', 'gemini'],
  ['google', 'gemini'],
  ['claude', 'claude'],
  ['anthropic', 'claude'],
  ['gpt', 'openai'],
  ['openai', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['glm', 'glm'],
  ['zhipu', 'glm'],
  ['kimi', 'kimi'],
  ['moonshot', 'kimi'],
  ['minimax', 'minimax'],
  ['abab', 'minimax'],
  ['step', 'step'],
  ['doubao', 'doubao'],
];

const ASCII_PUNCT = new Set(Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"));

function isPunctuation(ch: string): boolean {
  if (ASCII_PUNCT.has(ch)) return true;
  return /\p{P}/u.test(ch);
}

export function resolveFamily(model = '', family = ''): string {
  const chosen = family.trim().toLowerCase();
  if (chosen && chosen in MODEL_FAMILIES) return chosen;
  return detectModelFamily(model);
}

export function detectModelFamily(model = ''): string {
  const raw = model.trim().toLowerCase();
  if (!raw) return 'generic';
  const norm = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw;
  for (const [needle, family] of FAMILY_ALIASES) {
    if (norm.includes(needle) || raw.includes(needle)) {
      return family;
    }
  }
  return 'generic';
}

export function estimateTextTokens(text: string, family = 'generic'): number {
  if (!text) return 0;
  const weights = MODEL_FAMILIES[family] ?? MODEL_FAMILIES.generic;
  let score = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) {
      score += weights.kana;
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      score += weights.cjk;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      score += weights.latin;
    } else if (code >= 0x30 && code <= 0x39) {
      score += weights.digit;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      score += weights.space;
    } else if ((code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef) || isPunctuation(ch)) {
      score += weights.punct;
    } else {
      score += weights.other;
    }
  }
  return Math.max(1, Math.ceil(score));
}

export function estimateRecordTokens(record: Record<string, unknown>, family = 'generic'): number {
  const weights = MODEL_FAMILIES[family] ?? MODEL_FAMILIES.generic;
  const source = typeof record.source === 'string' ? record.source : '';
  const speaker = typeof record.speaker === 'string' ? record.speaker : '';
  const scene = typeof record.scene === 'string' ? record.scene : '';
  let tokens = estimateTextTokens(source, family);
  if (speaker) tokens += estimateTextTokens(speaker, family) + 2;
  if (scene) tokens += Math.min(8, estimateTextTokens(scene, family));
  return Math.max(1, tokens + weights.overhead);
}

export function estimateWithMargin(tokens: number, marginRatio = 0.1): number {
  if (tokens <= 0) return 0;
  return Math.ceil(tokens * (1.0 + Math.max(0.0, marginRatio)));
}

export function estimateRecordsStats(records: Array<Record<string, unknown>>, family = 'generic'): {
  min: number;
  p50: number;
  p95: number;
  max: number;
  sum: number;
} {
  if (!records.length) {
    return { min: 0, p50: 0, p95: 0, max: 0, sum: 0 };
  }
  const counts = records.map((row) => estimateRecordTokens(row, family)).sort((a, b) => a - b);
  const n = counts.length;
  const p95Idx = Math.min(n - 1, Math.max(0, Math.floor((n - 1) * 0.95)));
  return {
    min: counts[0],
    p50: counts[Math.floor(n / 2)],
    p95: counts[p95Idx],
    max: counts[n - 1],
    sum: counts.reduce((acc, v) => acc + v, 0),
  };
}
