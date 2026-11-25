/**
 * Pluggable LLM provider loader for the Paper Cup Reverser Benchmark.
 *
 * Supports:
 * 1. Built-in local Magpie gateway (`--provider magpie`, default `http://127.0.0.1:3425/v1`, keyless or keyed)
 * 2. Any OpenAI-compatible API (`--provider openai-compat --base-url <url> --model <id>`)
 * 3. Built-in Pi SDK providers (`openai`, `anthropic`, `google`, `deepseek`, `groq`, `xai`, ...)
 * 4. External pluggable adapter module (`--adapter <path/to/adapter.ts>`) exporting `BenchProviderAdapter`
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { streamSimple as streamSimpleOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_MAGPIE_BASE_URL,
  MAGPIE_KEYLESS_RUNTIME_TOKEN,
  discoverProviderAndModels,
  normalizeMagpieBaseUrl,
  resolveDefaultMagpieBaseUrl,
} from '../../src/agent/provider-discovery.js';
import type {
  BenchProviderAdapter,
  BenchProviderConfig,
  BenchResolvedRuntime,
} from './types.js';

function createKeylessFetchWrapper(
  baseFetch?: typeof globalThis.fetch
): typeof globalThis.fetch {
  const target = baseFetch ?? globalThis.fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const auth = headers.get('authorization') || '';
    if (
      auth.trim().toLowerCase() === `bearer ${MAGPIE_KEYLESS_RUNTIME_TOKEN}` ||
      auth.trim() === MAGPIE_KEYLESS_RUNTIME_TOKEN
    ) {
      headers.delete('authorization');
    }
    return target(input, { ...init, headers });
  }) as typeof globalThis.fetch;
}

function inferReasoningSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (/(?:chat-latest|non-thinking|flash-lite)/i.test(lower)) return false;
  return /(?:reason|think|r1|o1|o3|o4|claude|gemini|gpt-5|grok|deepseek|qwq|qwen3)/i.test(lower);
}

function buildOpenAiCompatModel(
  providerId: string,
  modelId: string,
  baseUrl: string,
  reasoning: boolean
) {
  return {
    id: modelId,
    name: modelId,
    provider: providerId,
    api: 'openai-completions' as const,
    baseUrl,
    reasoning,
    input: ['text'] as Array<'text' | 'image'>,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      thinkingFormat: 'openai' as const,
      maxTokensField: 'max_tokens' as const,
    },
  };
}

/**
 * Default built-in provider resolver covering local Magpie, generic OpenAI-compatible endpoints,
 * and Pi SDK built-in providers.
 */
export async function resolveBuiltinBenchProvider(
  cfg: BenchProviderConfig
): Promise<BenchResolvedRuntime> {
  const provider = (cfg.provider || 'magpie').trim().toLowerCase();
  const thinkingLevel: ThinkingLevel = cfg.thinkingLevel ?? 'max';
  const runtime = await ModelRuntime.create();
  const knownSecrets: string[] = [];
  if (cfg.apiKey?.trim()) knownSecrets.push(cfg.apiKey.trim());

  if (provider === 'magpie') {
    const baseUrl = cfg.baseUrl?.trim()
      ? normalizeMagpieBaseUrl(cfg.baseUrl.trim(), DEFAULT_MAGPIE_BASE_URL)
      : resolveDefaultMagpieBaseUrl();
    const apiKey = (cfg.apiKey ?? process.env.MAGPIE_API_KEY ?? '').trim();
    if (apiKey) knownSecrets.push(apiKey);
    const isKeyless = !apiKey;

    let modelId = (cfg.model ?? process.env.MAGPIE_MODEL ?? '').trim();
    let reasoning = modelId ? inferReasoningSupport(modelId) : true;

    if (!modelId) {
      const discovered = await discoverProviderAndModels({
        requestedProvider: 'magpie',
        apiKey,
        baseUrl,
      });
      if (!discovered.liveModels || discovered.liveModels.length === 0) {
        throw new Error(
          `未能从本地 Magpie (${baseUrl}/models) 探测到可用聊天模型，请确认 Magpie 正在运行或显式传入 --model <id>。`
        );
      }
      modelId = discovered.liveModels[0].id;
      reasoning = discovered.liveModels[0].reasoning;
    }

    const model = buildOpenAiCompatModel('magpie', modelId, baseUrl, reasoning);
    runtime.registerProvider('magpie', {
      baseUrl,
      api: 'openai-completions',
      apiKey: apiKey || MAGPIE_KEYLESS_RUNTIME_TOKEN,
      models: [model],
      streamSimple: (m: any, context: any, streamOptions?: any) => {
        if (!isKeyless) {
          return streamSimpleOpenAICompletions(m, context, streamOptions);
        }
        const nextHeaders = streamOptions?.headers ? { ...streamOptions.headers } : undefined;
        if (nextHeaders) {
          for (const key of Object.keys(nextHeaders)) {
            if (key.toLowerCase() === 'authorization') delete nextHeaders[key];
          }
        }
        return streamSimpleOpenAICompletions(m, context, {
          ...streamOptions,
          apiKey: streamOptions?.apiKey || MAGPIE_KEYLESS_RUNTIME_TOKEN,
          ...(nextHeaders ? { headers: nextHeaders } : {}),
          fetch: createKeylessFetchWrapper(streamOptions?.fetch),
        });
      },
    });
    await runtime.setRuntimeApiKey('magpie', apiKey || MAGPIE_KEYLESS_RUNTIME_TOKEN);
    await runtime.refresh?.({ allowNetwork: false, providers: ['magpie'] });

    const resolvedModel = runtime.getModel('magpie', modelId) ?? model;
    return {
      model: resolvedModel,
      modelRuntime: runtime,
      providerLabel: `magpie (${baseUrl})`,
      modelLabel: modelId,
      thinkingLevel,
      knownSecrets,
    };
  }

  if (provider === 'openai-compat' || provider === 'custom') {
    const baseUrl = (cfg.baseUrl ?? process.env.BENCH_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('使用 openai-compat 模式时必须提供 --base-url 或环境变量 BENCH_BASE_URL。');
    }
    const modelId = (cfg.model ?? process.env.BENCH_MODEL ?? '').trim();
    if (!modelId) {
      throw new Error('使用 openai-compat 模式时必须提供 --model 或环境变量 BENCH_MODEL。');
    }
    const apiKey = (cfg.apiKey ?? process.env.BENCH_API_KEY ?? '').trim();
    if (apiKey) knownSecrets.push(apiKey);
    const isKeyless = !apiKey;
    const providerId = 'bench-openai-compat';
    const model = buildOpenAiCompatModel(providerId, modelId, baseUrl, inferReasoningSupport(modelId));

    runtime.registerProvider(providerId, {
      baseUrl,
      api: 'openai-completions',
      apiKey: apiKey || MAGPIE_KEYLESS_RUNTIME_TOKEN,
      models: [model],
      ...(isKeyless
        ? {
            streamSimple: (m: any, context: any, streamOptions?: any) =>
              streamSimpleOpenAICompletions(m, context, {
                ...streamOptions,
                apiKey: streamOptions?.apiKey || MAGPIE_KEYLESS_RUNTIME_TOKEN,
                fetch: createKeylessFetchWrapper(streamOptions?.fetch),
              }),
          }
        : {}),
    });
    await runtime.setRuntimeApiKey(providerId, apiKey || MAGPIE_KEYLESS_RUNTIME_TOKEN);
    await runtime.refresh?.({ allowNetwork: false, providers: [providerId] });

    const resolvedModel = runtime.getModel(providerId, modelId) ?? model;
    return {
      model: resolvedModel,
      modelRuntime: runtime,
      providerLabel: `openai-compat (${baseUrl})`,
      modelLabel: modelId,
      thinkingLevel,
      knownSecrets,
    };
  }

  // Built-in Pi SDK provider (e.g. openai, anthropic, google, deepseek, groq, xai)
  const modelId = (cfg.model ?? process.env.BENCH_MODEL ?? '').trim();
  if (!modelId) {
    throw new Error(`使用内置提供商 "${provider}" 时必须传入 --model <id>。`);
  }
  const apiKey = (cfg.apiKey ?? '').trim();
  if (apiKey) {
    await runtime.setRuntimeApiKey(provider, apiKey);
  }
  const resolvedModel = runtime.getModel(provider, modelId);
  if (!resolvedModel) {
    throw new Error(
      `未在 Pi SDK 注册表中找到模型 ${provider}/${modelId}；如果是自定义兼容网关请使用 --provider openai-compat --base-url <url> 或 --adapter <file>。`
    );
  }
  return {
    model: resolvedModel,
    modelRuntime: runtime,
    providerLabel: provider,
    modelLabel: modelId,
    thinkingLevel,
    knownSecrets,
  };
}

/**
 * Loads either a user-supplied custom adapter module (`--adapter`) or the built-in provider resolver.
 */
export async function resolveBenchProvider(
  cfg: BenchProviderConfig
): Promise<BenchResolvedRuntime> {
  if (cfg.adapterPath?.trim()) {
    const absPath = path.resolve(cfg.adapterPath.trim());
    const mod = await import(pathToFileURL(absPath).href);
    const adapter: BenchProviderAdapter | undefined =
      typeof mod.default === 'function'
        ? mod.default
        : typeof mod.createBenchProvider === 'function'
          ? mod.createBenchProvider
          : undefined;
    if (!adapter) {
      throw new Error(
        `自定义适配器 ${absPath} 必须导出默认函数或命名函数 createBenchProvider(config): Promise<BenchResolvedRuntime>。`
      );
    }
    return adapter(cfg);
  }
  return resolveBuiltinBenchProvider(cfg);
}
