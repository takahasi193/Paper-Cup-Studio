/**
 * Local OpenAI-compatible dedicated MT client (SakuraLLM / HY-MT / plain-lines)
 * using Node's built-in fetch with zero external dependencies.
 *
 * Responsibilities:
 * - Config normalization, masking & precedence merge (call > workspace > global)
 * - Unfiltered local /v1/models probing (preserves GGUF / local quantized IDs)
 * - Preset prompt formatting for non-instruction / weak-instruction MT models
 * - Degeneration detection & frequency_penalty retry
 * - Automatic binary packet split fallback on line-count mismatch
 * - Fail-fast LocalTranslatorEndpointError (never silently falls back to full cloud MT)
 */

import { redactSecrets } from '../security/secrets.js';
import { NON_CHAT_MODEL_RE } from './provider-discovery.js';
import type { LocalMtPreset, TranslatorMode, TranslatorOverrideConfig } from '../vn/profile.js';
import { detectModelFamily, estimateTextTokens } from '../vn/tokens.js';
import type {
  TranslationContextPair,
  TranslationPacket,
  TranslationUnit,
} from '../vn/translation-packet.js';

export interface LocalTranslatorConfig {
  mode: TranslatorMode;
  baseUrl: string;
  model: string;
  ollamaPath: string;
  apiKey: string;
  preset: LocalMtPreset;
  packetLines: number;
  concurrency: number;
  contextWindow: number;
  timeoutMs: number;
  escalateFailedRows: boolean;
  useTmCache: boolean;
  disableThinking: boolean;
}

export interface PublicLocalTranslatorConfig {
  mode: TranslatorMode;
  baseUrl: string;
  model: string;
  ollamaPath: string;
  hasApiKey: boolean;
  preset: LocalMtPreset;
  packetLines: number;
  concurrency: number;
  contextWindow: number;
  timeoutMs: number;
  escalateFailedRows: boolean;
  useTmCache: boolean;
  disableThinking: boolean;
}

export interface LocalEndpointPresetInfo {
  id: string;
  name: string;
  baseUrl: string;
}

export const LOCAL_ENDPOINT_PRESETS: readonly LocalEndpointPresetInfo[] = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'magpie', name: 'Magpie', baseUrl: 'http://127.0.0.1:3425/v1' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
];

export const DEFAULT_LOCAL_TRANSLATOR_CONFIG: LocalTranslatorConfig = {
  mode: 'cloud_subagent',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: '',
  ollamaPath: '',
  apiKey: '',
  preset: 'sakura',
  packetLines: 8,
  concurrency: 3,
  contextWindow: 4,
  timeoutMs: 120_000,
  escalateFailedRows: true,
  useTmCache: true,
  disableThinking: true,
};

export class LocalTranslatorEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalTranslatorEndpointError';
  }
}

export function normalizeLocalBaseUrl(rawUrl: string): string {
  const trimmed = String(rawUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`本地端点 URL 格式无效：${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`本地端点 URL 仅支持 http:// 或 https:// 协议：${trimmed}`);
  }
  return trimmed;
}

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  const n = typeof val === 'number' ? val : typeof val === 'string' && val.trim() ? Number(val) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeTranslatorConfig(
  raw: Partial<LocalTranslatorConfig> | Record<string, unknown> | null | undefined,
  base: LocalTranslatorConfig = DEFAULT_LOCAL_TRANSLATOR_CONFIG
): LocalTranslatorConfig {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode: TranslatorMode =
    src.mode === 'local_mt' || src.mode === 'cloud_subagent' ? src.mode : base.mode;
  const preset: LocalMtPreset =
    src.preset === 'sakura' || src.preset === 'hy-mt' || src.preset === 'plain-lines'
      ? src.preset
      : base.preset;

  let baseUrl = base.baseUrl;
  if (typeof src.baseUrl === 'string') {
    const trimmed = src.baseUrl.trim();
    baseUrl = trimmed ? normalizeLocalBaseUrl(trimmed) : '';
  }

  const model = typeof src.model === 'string' ? src.model.trim() : base.model;
  const ollamaPath =
    typeof src.ollamaPath === 'string'
      ? src.ollamaPath.trim().replace(/^"(.*)"$/, '$1').trim()
      : base.ollamaPath;
  const apiKey = typeof src.apiKey === 'string' ? src.apiKey.trim() : base.apiKey;

  return {
    mode,
    baseUrl,
    model,
    ollamaPath,
    apiKey,
    preset,
    packetLines: clampInt(src.packetLines, base.packetLines, 1, 50),
    concurrency: clampInt(src.concurrency, base.concurrency, 1, 8),
    contextWindow: clampInt(src.contextWindow, base.contextWindow, 0, 12),
    timeoutMs: clampInt(src.timeoutMs, base.timeoutMs, 5_000, 600_000),
    escalateFailedRows:
      typeof src.escalateFailedRows === 'boolean' ? src.escalateFailedRows : base.escalateFailedRows,
    useTmCache: typeof src.useTmCache === 'boolean' ? src.useTmCache : base.useTmCache,
    disableThinking:
      typeof src.disableThinking === 'boolean' ? src.disableThinking : base.disableThinking,
  };
}

export function toPublicTranslatorConfig(cfg: LocalTranslatorConfig): PublicLocalTranslatorConfig {
  return {
    mode: cfg.mode,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    ollamaPath: cfg.ollamaPath,
    hasApiKey: Boolean(cfg.apiKey.trim()),
    preset: cfg.preset,
    packetLines: cfg.packetLines,
    concurrency: cfg.concurrency,
    contextWindow: cfg.contextWindow,
    timeoutMs: cfg.timeoutMs,
    escalateFailedRows: cfg.escalateFailedRows,
    useTmCache: cfg.useTmCache,
    disableThinking: cfg.disableThinking,
  };
}

export function pickPreferredLocalModel(models: readonly LocalProbeModel[]): string | null {
  if (!Array.isArray(models) || models.length === 0) return null;
  const chatCandidates = models.filter(
    (m) => m && typeof m.id === 'string' && m.id.trim() && !NON_CHAT_MODEL_RE.test(m.id) && !NON_CHAT_MODEL_RE.test(m.name || '')
  );
  if (chatCandidates.length === 0) return null;
  const sakura = chatCandidates.find((m) => /sakura/i.test(m.id) || /sakura/i.test(m.name));
  if (sakura) return sakura.id;
  const hyMt = chatCandidates.find((m) => /hy[-_]?mt/i.test(m.id) || /hy[-_]?mt/i.test(m.name));
  if (hyMt) return hyMt.id;
  return chatCandidates[0].id || null;
}

export function mergeTranslatorConfig(
  globalCfg: LocalTranslatorConfig = DEFAULT_LOCAL_TRANSLATOR_CONFIG,
  wsOverride?: TranslatorOverrideConfig | null,
  callOverride?: Partial<LocalTranslatorConfig> | null
): LocalTranslatorConfig {
  let merged = normalizeTranslatorConfig(globalCfg, DEFAULT_LOCAL_TRANSLATOR_CONFIG);
  if (wsOverride && typeof wsOverride === 'object') {
    merged = normalizeTranslatorConfig(wsOverride, merged);
  }
  if (callOverride && typeof callOverride === 'object') {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(callOverride)) {
      if (v !== undefined) patch[k] = v;
    }
    merged = normalizeTranslatorConfig(patch, merged);
  }
  return merged;
}

export interface LocalProbeModel {
  id: string;
  name: string;
}

export interface LocalProbeResult {
  ok: true;
  baseUrl: string;
  models: LocalProbeModel[];
}

export async function probeLocalTranslatorEndpoint(
  rawBaseUrl: string,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
): Promise<LocalProbeResult> {
  const baseUrl = normalizeLocalBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    throw new LocalTranslatorEndpointError('本地端点 URL 不能为空。');
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const apiKey = options.apiKey?.trim() || '';
  const secrets = apiKey ? [apiKey] : undefined;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const url = `${baseUrl}/models`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    });
  } catch (err: any) {
    const safeMsg = redactSecrets(String(err?.message || err), secrets);
    throw new LocalTranslatorEndpointError(`无法连接本地模型端点 (${url}): ${safeMsg}`);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const safeDetail = redactSecrets(bodyText.slice(0, 200), secrets);
    throw new LocalTranslatorEndpointError(
      `本地端点探测失败 (HTTP ${res.status})${safeDetail ? `: ${safeDetail}` : ''}`
    );
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch (err: any) {
    throw new LocalTranslatorEndpointError(`本地端点返回了无效的 JSON：${String(err?.message || err)}`);
  }

  const rawEntries: any[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const models: LocalProbeModel[] = [];
  const seen = new Set<string>();
  for (const item of rawEntries) {
    const id =
      typeof item === 'string'
        ? item.trim()
        : typeof item?.id === 'string'
          ? item.id.trim()
          : typeof item?.model === 'string'
            ? item.model.trim()
            : typeof item?.name === 'string'
              ? item.name.trim()
              : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof item?.name === 'string' && item.name.trim()
        ? item.name.trim()
        : typeof item?.display_name === 'string' && item.display_name.trim()
          ? item.display_name.trim()
          : id;
    models.push({ id, name });
  }

  return { ok: true, baseUrl, models };
}

export function detectTranslationDegeneration(source: string, target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return true;
  if (trimmed.length > Math.max(240, source.length * 6)) {
    return true;
  }
  const sourceHasLongCharRun = /([\s\S])\1{7,}/.test(source);
  if (!sourceHasLongCharRun && /([^\s…—.。！!？?\-~～])\1{9,}/.test(trimmed)) {
    return true;
  }
  if (/([^\s…—.。！!？?\-~～]{3,}?)\1{4,}/.test(trimmed)) {
    return true;
  }
  return false;
}

function stripThinkingAndFences(rawText: string): string {
  let out = String(rawText ?? '').replace(/^\uFEFF/, '');
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<think>[\s\S]*$/gi, '');
  out = out.trim();
  if (out.startsWith('```')) {
    const lines = out.split(/\r?\n/);
    if (lines.length >= 2 && lines[lines.length - 1].trim().startsWith('```')) {
      out = lines.slice(1, -1).join('\n').trim();
    }
  }
  return out;
}

function parsePresetLines(
  rawText: string,
  expectedCount: number,
  preset: LocalMtPreset,
  units: TranslationUnit[]
): string[] | null {
  const cleaned = stripThinkingAndFences(rawText);
  if (!cleaned) return null;

  if (expectedCount === 1) {
    let single = cleaned.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (preset === 'plain-lines' && !/^\d+\s*[.:：、]/.test(units[0]?.cleanSource || '')) {
      single = single.replace(/^1\s*[.:：、]\s*/, '').trim();
    }
    return single ? [single] : null;
  }

  const nonEmptyLines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (preset === 'plain-lines') {
    const byIndex = new Map<number, string>();
    const numberedRe = /^(\d+)\s*[.:：、]\s*(.*)$/;
    let matchedAll = nonEmptyLines.length === expectedCount;
    for (const line of nonEmptyLines) {
      const m = numberedRe.exec(line);
      if (!m) {
        matchedAll = false;
        break;
      }
      const num = Number(m[1]);
      if (num < 1 || num > expectedCount || byIndex.has(num)) {
        matchedAll = false;
        break;
      }
      byIndex.set(num, m[2].trim());
    }
    if (matchedAll && byIndex.size === expectedCount) {
      const ordered: string[] = [];
      for (let i = 1; i <= expectedCount; i++) {
        const val = byIndex.get(i) ?? '';
        if (!val) return null;
        ordered.push(val);
      }
      return ordered;
    }
  }

  if (nonEmptyLines.length !== expectedCount) {
    return null;
  }

  // Strip accidental 1./1: numbering only if ALL lines were numbered and source lines were not
  const allNumbered = nonEmptyLines.every((l, idx) =>
    new RegExp(`^${idx + 1}\\s*[.:：、]\\s*`).test(l)
  );
  const sourcesNumbered = units.some((u) => /^\d+\s*[.:：、]/.test(u.cleanSource));
  if (allNumbered && !sourcesNumbered) {
    return nonEmptyLines.map((l) => l.replace(/^\d+\s*[.:：、]\s*/, '').trim());
  }

  return nonEmptyLines;
}

function buildMessagesForPacket(
  packet: TranslationPacket,
  preset: LocalMtPreset,
  contextWindow: number
): Array<{ role: 'system' | 'user'; content: string }> {
  const { context, units } = packet;
  const glossaryEntries = Object.entries(context.glossarySlice);
  const speakerEntries = Object.entries(context.speakerHints);
  const prevPairs =
    contextWindow > 0 ? context.prevContext.slice(-contextWindow) : [];

  const blocks: string[] = [];

  if (preset === 'sakura') {
    const systemContent =
      context.sourceLang.startsWith('ja') && context.targetLang.startsWith('zh')
        ? '你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。'
        : `You are a visual-novel translation model. Translate naturally from ${context.sourceLang} into ${context.targetLang}.`;

    if (glossaryEntries.length > 0) {
      blocks.push(
        `根据以下术语表：\n${glossaryEntries.map(([src, tgt]) => `${src}->${tgt}`).join('\n')}`
      );
    }
    if (speakerEntries.length > 0) {
      blocks.push(
        `角色语气参考：\n${speakerEntries.map(([spk, hint]) => `${spk}: ${hint}`).join('\n')}`
      );
    }
    if (prevPairs.length > 0) {
      blocks.push(
        `参考上文：\n${prevPairs
          .map((p) => `${p.speaker ? `${p.speaker}：` : ''}${p.target}`)
          .join('\n')}`
      );
    }

    const linesText = units.map((u) => u.cleanSource).join('\n');
    const instruction =
      units.length === 1
        ? '将下面的文本翻译成中文，保留原文中的 ⟦0⟧ 类占位符，只输出译文：'
        : `将下面的文本逐行翻译成中文（共${units.length}行，每行对应一句，保留原文中的 ⟦0⟧ 类占位符，不要输出编号或解释）：`;
    blocks.push(`${instruction}\n${linesText}`);

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: blocks.join('\n\n') },
    ];
  }

  if (preset === 'hy-mt') {
    if (glossaryEntries.length > 0) {
      blocks.push(
        `参考术语表翻译，将以下术语按指定译法翻译：\n${glossaryEntries
          .map(([src, tgt]) => `${src} -> ${tgt}`)
          .join('\n')}`
      );
    }
    if (prevPairs.length > 0) {
      blocks.push(
        `前文语境：\n${prevPairs
          .map((p) => `${p.speaker ? `[${p.speaker}] ` : ''}${p.source} => ${p.target}`)
          .join('\n')}`
      );
    }
    const linesText = units.map((u) => u.cleanSource).join('\n');
    const targetName = context.targetLang.startsWith('zh') ? '中文' : context.targetLang;
    const instruction =
      units.length === 1
        ? `将以下文本翻译为${targetName}，保留 ⟦0⟧ 占位符，只输出译文，不要额外解释。`
        : `将以下${units.length}行文本逐行翻译为${targetName}，保持严格一一对应的${units.length}行输出，保留 ⟦0⟧ 占位符，不要额外解释。`;
    blocks.push(`${instruction}\n\n${linesText}`);

    return [
      { role: 'system', content: `你是一个专业的游戏本地化翻译模型，只输出准确自然的${targetName}译文。` },
      { role: 'user', content: blocks.join('\n\n') },
    ];
  }

  // 'plain-lines' preset
  if (glossaryEntries.length > 0) {
    blocks.push(
      `术语表：\n${glossaryEntries.map(([src, tgt]) => `${src} => ${tgt}`).join('\n')}`
    );
  }
  if (speakerEntries.length > 0) {
    blocks.push(
      `角色参考：\n${speakerEntries.map(([spk, hint]) => `${spk}: ${hint}`).join('\n')}`
    );
  }
  if (prevPairs.length > 0) {
    blocks.push(
      `前文：\n${prevPairs
        .map((p) => `${p.speaker ? `[${p.speaker}] ` : ''}${p.source} => ${p.target}`)
        .join('\n')}`
    );
  }
  const targetName = context.targetLang.startsWith('zh') ? '简体中文' : context.targetLang;
  if (units.length === 1) {
    blocks.push(
      `将下面一行${context.sourceLang}视觉小说文本翻译成${targetName}，保留所有 ⟦0⟧ 占位符，仅输出译文：\n${units[0].cleanSource}`
    );
  } else {
    const numbered = units.map((u, idx) => `${idx + 1}: ${u.cleanSource}`).join('\n');
    blocks.push(
      `将下面 ${units.length} 行${context.sourceLang}视觉小说文本逐行翻译成${targetName}，严格按 "1: 译文" 格式输出 ${units.length} 行，保留所有 ⟦0⟧ 占位符：\n${numbered}`
    );
  }
  return [
    { role: 'system', content: `将视觉小说文本翻译为${targetName}，只输出译文。` },
    { role: 'user', content: blocks.join('\n\n') },
  ];
}

function linkAbortSignals(
  timeoutMs: number,
  external?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`本地模型请求超时 (${timeoutMs}ms)`));
  }, timeoutMs);

  const onExt = () => {
    ctrl.abort((external as any)?.reason ?? new Error('Aborted'));
  };
  if (external) {
    if (external.aborted) {
      onExt();
    } else {
      external.addEventListener('abort', onExt, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (external) {
        external.removeEventListener('abort', onExt);
      }
    },
  };
}

export interface LocalUsageDelta {
  input: number;
  output: number;
  totalTokens: number;
  estimated: boolean;
  model: string;
}

export interface LocalPacketTranslateResult {
  targets: string[];
  calls: number;
  usage: {
    input: number;
    output: number;
    totalTokens: number;
    estimated?: boolean;
  };
}

export class LocalTranslatorClient {
  private fetchFn: typeof fetch;
  private chatTemplateKwargsRejected = false;

  constructor(
    private readonly config: LocalTranslatorConfig,
    fetchImpl?: typeof fetch,
    private readonly onUsage?: (delta: LocalUsageDelta) => void
  ) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
  }

  private async requestChatCompletion(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: { temperature: number; frequencyPenalty?: number; signal?: AbortSignal }
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; totalTokens: number; estimated: boolean }> {
    const baseUrl = normalizeLocalBaseUrl(this.config.baseUrl);
    if (!baseUrl) {
      throw new LocalTranslatorEndpointError('未配置本地模型端点 URL。');
    }
    if (!this.config.model.trim()) {
      throw new LocalTranslatorEndpointError('未配置本地翻译模型名称。');
    }

    const endpointUrl = `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const apiKey = this.config.apiKey.trim();
    const secrets = apiKey ? [apiKey] : undefined;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const sendOnce = async (includeThinkingKwargs: boolean) => {
      const body: Record<string, unknown> = {
        model: this.config.model.trim(),
        messages,
        stream: false,
        temperature: options.temperature,
      };
      if (options.frequencyPenalty && options.frequencyPenalty > 0) {
        body.frequency_penalty = options.frequencyPenalty;
      }
      if (includeThinkingKwargs) {
        body.chat_template_kwargs = { enable_thinking: false };
      }

      const linked = linkAbortSignals(this.config.timeoutMs, options.signal);
      let res: Response;
      try {
        res = await this.fetchFn(endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: linked.signal,
        });
      } catch (err: any) {
        if (options.signal?.aborted) {
          throw err;
        }
        const safeMsg = redactSecrets(String(err?.message || err), secrets);
        throw new LocalTranslatorEndpointError(`本地模型连接失败 (${endpointUrl}): ${safeMsg}`);
      } finally {
        linked.cleanup();
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const safeErrBody = redactSecrets(errBody.slice(0, 300), secrets);
        if (
          (res.status === 400 || res.status === 422) &&
          includeThinkingKwargs &&
          /chat_template_kwargs|enable_thinking|extra_forbidden|unknown|unrecognized|invalid/i.test(errBody)
        ) {
          return { retryWithoutThinkingKwargs: true as const };
        }
        throw new LocalTranslatorEndpointError(
          `本地模型返回 HTTP ${res.status} (${endpointUrl})${safeErrBody ? `: ${safeErrBody}` : ''}`
        );
      }

      const payload: any = await res.json().catch((err: any) => {
        throw new LocalTranslatorEndpointError(
          `本地模型响应 JSON 解析失败：${String(err?.message || err)}`
        );
      });
      const content = payload?.choices?.[0]?.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((p: any) => p && typeof p.text === 'string')
                .map((p: any) => p.text)
                .join('\n')
            : '';
      const usage = payload?.usage ?? {};
      const rawInput = Number(usage.prompt_tokens || 0);
      const rawOutput = Number(usage.completion_tokens || 0);
      const rawTotal = Number(usage.total_tokens || 0);
      const family = detectModelFamily(this.config.model);

      let inputTokens = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0;
      let outputTokens = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0;
      let estimated = false;

      if (inputTokens <= 0 && messages.some((m) => Boolean(m.content?.trim()))) {
        inputTokens = messages.reduce((sum, m) => sum + estimateTextTokens(m.content, family) + 4, 0);
        estimated = true;
      }
      if (outputTokens <= 0 && text.trim().length > 0) {
        outputTokens = estimateTextTokens(text, family);
        estimated = true;
      }
      const totalTokens =
        !estimated && Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : inputTokens + outputTokens;

      return {
        retryWithoutThinkingKwargs: false as const,
        text,
        inputTokens,
        outputTokens,
        totalTokens,
        estimated,
      };
    };

    const useKwargs = this.config.disableThinking && !this.chatTemplateKwargsRejected;
    const first = await sendOnce(useKwargs);
    if (first.retryWithoutThinkingKwargs) {
      this.chatTemplateKwargsRejected = true;
      const retried = await sendOnce(false);
      if (retried.retryWithoutThinkingKwargs) {
        throw new LocalTranslatorEndpointError('本地模型端点拒绝请求参数 (HTTP 400/422)。');
      }
      return retried;
    }
    return first;
  }

  async translatePacketWithBinarySplit(
    packet: TranslationPacket,
    signal?: AbortSignal
  ): Promise<LocalPacketTranslateResult> {
    const accUsage: LocalPacketTranslateResult['usage'] = { input: 0, output: 0, totalTokens: 0 };
    let totalCalls = 0;

    const addCallUsage = (res: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimated: boolean;
    }) => {
      totalCalls++;
      accUsage.input += res.inputTokens;
      accUsage.output += res.outputTokens;
      accUsage.totalTokens += res.totalTokens;
      if (res.estimated) {
        accUsage.estimated = true;
      }
      if (res.inputTokens > 0 || res.outputTokens > 0 || res.totalTokens > 0) {
        this.onUsage?.({
          input: res.inputTokens,
          output: res.outputTokens,
          totalTokens: res.totalTokens,
          estimated: res.estimated,
          model: this.config.model.trim() || 'local',
        });
      }
    };

    const translateSlice = async (
      units: TranslationUnit[],
      prevContext: TranslationContextPair[],
      suffix: string
    ): Promise<string[]> => {
      if (units.length === 0) return [];
      if (signal?.aborted) {
        throw new Error('Batch translation aborted.');
      }

      const subPacket: TranslationPacket = {
        ...packet,
        packetId: `${packet.packetId}${suffix}`,
        context: {
          ...packet.context,
          prevContext,
        },
        units,
      };
      const messages = buildMessagesForPacket(subPacket, this.config.preset, this.config.contextWindow);
      const res = await this.requestChatCompletion(messages, {
        temperature: 0.1,
        signal,
      });
      addCallUsage(res);

      const parsed = parsePresetLines(res.text, units.length, this.config.preset, units);
      const hasDegeneration =
        parsed !== null &&
        parsed.some((line, idx) => detectTranslationDegeneration(units[idx].cleanSource, line));

      if (parsed && !hasDegeneration) {
        return parsed;
      }

      if (units.length === 1) {
        const retryRes = await this.requestChatCompletion(messages, {
          temperature: 0.25,
          frequencyPenalty: 0.25,
          signal,
        });
        addCallUsage(retryRes);
        const retryParsed = parsePresetLines(retryRes.text, 1, this.config.preset, units);
        if (retryParsed && retryParsed[0]?.trim()) {
          return retryParsed;
        }
        return [parsed?.[0]?.trim() || retryParsed?.[0]?.trim() || ''];
      }

      // Line-count mismatch or multi-line degeneration -> deterministic binary split
      const mid = Math.floor(units.length / 2);
      const leftUnits = units.slice(0, mid);
      const rightUnits = units.slice(mid);
      const leftTargets = await translateSlice(leftUnits, prevContext, `${suffix}.L`);

      const updatedPrev = [...prevContext];
      for (let i = 0; i < leftUnits.length; i++) {
        if (leftTargets[i]?.trim()) {
          updatedPrev.push({
            ...(leftUnits[i].speaker ? { speaker: leftUnits[i].speaker } : {}),
            source: leftUnits[i].cleanSource,
            target: leftTargets[i],
          });
        }
      }
      const rightPrev =
        this.config.contextWindow > 0 ? updatedPrev.slice(-this.config.contextWindow) : [];
      const rightTargets = await translateSlice(rightUnits, rightPrev, `${suffix}.R`);
      return [...leftTargets, ...rightTargets];
    };

    const targets = await translateSlice(packet.units, packet.context.prevContext, '');
    return { targets, calls: totalCalls, usage: accUsage };
  }
}
