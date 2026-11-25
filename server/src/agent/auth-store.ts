import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { DiscoveredLiveModel } from './provider-discovery.js';

export interface PersistedProviderAuth {
  apiKey?: string;
  baseUrl?: string;
  keyless?: boolean;
  customModels?: string[];
  liveModels?: DiscoveredLiveModel[];
  updatedAt?: string;
}

export interface PersistedApiAuthState {
  version: 1;
  activeProvider: string | null;
  preferredModel: string | null;
  preferredThinkingLevel: ThinkingLevel | null;
  providers: Record<string, PersistedProviderAuth>;
  updatedAt?: string;
}

const VALID_THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const MAX_CUSTOM_MODELS_PER_PROVIDER = 64;
const MAX_LIVE_MODELS_PER_PROVIDER = 1000;

export function createEmptyPersistedAuthState(): PersistedApiAuthState {
  return {
    version: 1,
    activeProvider: null,
    preferredModel: null,
    preferredThinkingLevel: null,
    providers: {},
  };
}

export function normalizePersistedAuthState(raw: unknown): PersistedApiAuthState {
  const empty = createEmptyPersistedAuthState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return empty;
  }

  const obj = raw as Record<string, unknown>;
  const rawActive = typeof obj.activeProvider === 'string' ? obj.activeProvider.trim() : '';
  const rawPreferredModel = typeof obj.preferredModel === 'string' ? obj.preferredModel.trim() : '';
  const rawThinking =
    typeof obj.preferredThinkingLevel === 'string' ? obj.preferredThinkingLevel.trim() : '';

  const preferredThinkingLevel: ThinkingLevel | null = VALID_THINKING_LEVELS.has(
    rawThinking as ThinkingLevel
  )
    ? (rawThinking as ThinkingLevel)
    : null;

  const providers: Record<string, PersistedProviderAuth> = {};
  if (obj.providers && typeof obj.providers === 'object' && !Array.isArray(obj.providers)) {
    for (const [rawPid, rawEntry] of Object.entries(obj.providers as Record<string, unknown>)) {
      const pid = rawPid.trim();
      if (!pid || pid === '__proto__' || pid === 'constructor' || pid === 'prototype') {
        continue;
      }
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const apiKey =
        typeof entry.apiKey === 'string' && entry.apiKey.trim() ? entry.apiKey.trim() : undefined;
      let baseUrl: string | undefined;
      if (typeof entry.baseUrl === 'string' && entry.baseUrl.trim()) {
        try {
          const parsed = new URL(entry.baseUrl.trim());
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            baseUrl = entry.baseUrl.trim().replace(/\/+$/, '');
          }
        } catch {
          // Ignore malformed persisted baseUrl
        }
      }
      const keyless = !apiKey && entry.keyless === true ? true : undefined;

      const customModels: string[] = [];
      if (Array.isArray(entry.customModels)) {
        const seenCustom = new Set<string>();
        for (const item of entry.customModels) {
          if (typeof item !== 'string') continue;
          const cleaned = item.trim();
          if (!cleaned || seenCustom.has(cleaned)) continue;
          seenCustom.add(cleaned);
          customModels.push(cleaned);
          if (customModels.length >= MAX_CUSTOM_MODELS_PER_PROVIDER) break;
        }
      }

      const liveModels: DiscoveredLiveModel[] = [];
      if (Array.isArray(entry.liveModels)) {
        const seenLive = new Set<string>();
        for (const item of entry.liveModels) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const rec = item as Record<string, unknown>;
          const id = typeof rec.id === 'string' ? rec.id.trim() : '';
          if (!id || seenLive.has(id)) continue;
          if (typeof rec.name !== 'string' || typeof rec.reasoning !== 'boolean') continue;
          seenLive.add(id);
          liveModels.push({
            id,
            name: rec.name.trim() || id,
            reasoning: rec.reasoning,
          });
          if (liveModels.length >= MAX_LIVE_MODELS_PER_PROVIDER) break;
        }
      }

      if (!apiKey && !keyless && !baseUrl && customModels.length === 0 && liveModels.length === 0) {
        continue;
      }

      const updatedAt =
        typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
          ? entry.updatedAt.trim()
          : undefined;

      providers[pid] = {
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(keyless ? { keyless: true } : {}),
        ...(customModels.length > 0 ? { customModels } : {}),
        ...(liveModels.length > 0 ? { liveModels } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      };
    }
  }

  const activeRec = rawActive ? providers[rawActive] : undefined;
  const activeProvider = rawActive && activeRec && (activeRec.apiKey || activeRec.keyless) ? rawActive : null;
  const updatedAt =
    typeof obj.updatedAt === 'string' && obj.updatedAt.trim() ? obj.updatedAt.trim() : undefined;

  return {
    version: 1,
    activeProvider,
    preferredModel: rawPreferredModel || null,
    preferredThinkingLevel,
    providers,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function loadPersistedAuthState(filePath: string): PersistedApiAuthState {
  try {
    if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
      return createEmptyPersistedAuthState();
    }
    const rawText = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!rawText.trim()) {
      return createEmptyPersistedAuthState();
    }
    const parsed = JSON.parse(rawText);
    return normalizePersistedAuthState(parsed);
  } catch {
    return createEmptyPersistedAuthState();
  }
}

export function savePersistedAuthState(filePath: string, state: PersistedApiAuthState): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error('Refusing to write credentials to a symbolic link.');
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const normalized = normalizePersistedAuthState(state);
  const stamped: PersistedApiAuthState = {
    ...normalized,
    updatedAt: new Date().toISOString(),
  };

  const tmpPath = path.join(
    dir,
    `${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`
  );
  const payload = `${JSON.stringify(stamped, null, 2)}\n`;
  try {
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

export function collectPersistedSecrets(state: PersistedApiAuthState): string[] {
  const secrets: string[] = [];
  for (const entry of Object.values(state.providers)) {
    if (typeof entry?.apiKey === 'string' && entry.apiKey.trim()) {
      secrets.push(entry.apiKey.trim());
    }
  }
  return secrets;
}
