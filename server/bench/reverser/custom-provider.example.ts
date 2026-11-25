/**
 * Example pluggable API adapter for `npm run bench:reverser -- --adapter ./bench/reverser/custom-provider.example.ts`
 *
 * Copy this file and customize `baseUrl`, `apiKey`, headers, or Pi SDK `Model` definition
 * to plug ANY custom LLM gateway or proprietary API into the Reverser Benchmark.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { BenchProviderConfig, BenchResolvedRuntime } from './types.js';

export default async function createBenchProvider(
  config: BenchProviderConfig
): Promise<BenchResolvedRuntime> {
  const baseUrl = (config.baseUrl || process.env.MY_CUSTOM_BASE_URL || 'http://127.0.0.1:3425/v1').replace(/\/+$/, '');
  const apiKey = (config.apiKey || process.env.MY_CUSTOM_API_KEY || '').trim();
  const modelId = (config.model || process.env.MY_CUSTOM_MODEL || 'my-model').trim();
  const providerId = 'my-custom-api';

  const runtime = await ModelRuntime.create();
  const model = {
    id: modelId,
    name: modelId,
    provider: providerId,
    api: 'openai-completions' as const,
    baseUrl,
    reasoning: true,
    input: ['text'] as Array<'text' | 'image'>,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: 'openai' as const,
      maxTokensField: 'max_tokens' as const,
    },
  };

  runtime.registerProvider(providerId, {
    baseUrl,
    api: 'openai-completions',
    apiKey: apiKey || 'custom-keyless',
    models: [model],
  });
  await runtime.setRuntimeApiKey(providerId, apiKey || 'custom-keyless');
  await runtime.refresh?.({ allowNetwork: false, providers: [providerId] });

  return {
    model: runtime.getModel(providerId, modelId) ?? model,
    modelRuntime: runtime,
    providerLabel: `${providerId} (${baseUrl})`,
    modelLabel: modelId,
    thinkingLevel: config.thinkingLevel ?? 'max',
    knownSecrets: apiKey ? [apiKey] : [],
  };
}
