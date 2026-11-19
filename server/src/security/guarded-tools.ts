import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  detectBlockedSecretCommand,
  isRestrictedSecretPath,
  redactSecrets,
  redactUnknownValue,
} from './secrets.js';

export const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 16384;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface VnResearchConfig {
  maxToolOutputChars: number;
  maxConsecutiveFailures: number;
}

export interface GuardedBuiltinToolsOptions {
  bashPath?: string;
  getKnownSecrets?: () => Iterable<string>;
  maxInlineOutputChars?: number;
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

/**
 * Reads `[vn.research]` tuning thresholds from `<cwd>/papercup.toml` with env fallbacks.
 */
export function readVnResearchConfig(cwd?: string): VnResearchConfig {
  let maxToolOutputChars = DEFAULT_MAX_INLINE_OUTPUT_CHARS;
  let maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES;

  if (cwd) {
    const tomlPath = path.join(cwd, 'papercup.toml');
    try {
      if (fs.existsSync(tomlPath) && !fs.lstatSync(tomlPath).isSymbolicLink()) {
        const raw = fs.readFileSync(tomlPath, 'utf8').replace(/^\uFEFF/, '');
        let inSection = false;
        for (const rawLine of raw.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          if (line.startsWith('[')) {
            inSection = line === '[vn.research]';
            continue;
          }
          if (!inSection) continue;
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const key = line.slice(0, eq).trim();
          const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
          if (key === 'max_tool_output_chars') {
            const n = parsePositiveInt(val);
            if (n !== undefined) maxToolOutputChars = n;
          } else if (key === 'max_consecutive_failures') {
            const n = parsePositiveInt(val);
            if (n !== undefined) maxConsecutiveFailures = n;
          }
        }
      }
    } catch {
      // Fall back to defaults on unreadable or malformed papercup.toml
    }
  }

  const envOutput = parsePositiveInt(process.env.PAPERCUP_MAX_TOOL_OUTPUT_CHARS);
  if (envOutput !== undefined) maxToolOutputChars = envOutput;
  const envFailures = parsePositiveInt(process.env.PAPERCUP_MAX_CONSECUTIVE_FAILURES);
  if (envFailures !== undefined) maxConsecutiveFailures = envFailures;

  return { maxToolOutputChars, maxConsecutiveFailures };
}

function blockedToolResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { blocked: true, reason: message },
    isError: true,
  };
}

function saveLargeToolOutput(cwd: string, toolName: string, fullText: string): string | null {
  try {
    if (!cwd || !fs.existsSync(cwd)) return null;
    const outDir = path.join(cwd, '.papercup', 'diagnostics', 'tool-outputs');
    fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTool = toolName.replace(/[^A-Za-z0-9_-]+/g, '_') || 'tool';
    const shortId = crypto.randomBytes(3).toString('hex');
    const fileName = `${ts}-${safeTool}-${shortId}.log`;
    fs.writeFileSync(path.join(outDir, fileName), fullText, 'utf8');
    return `.papercup/diagnostics/tool-outputs/${fileName}`;
  } catch {
    return null;
  }
}

function buildTruncatedOutputSummary(
  fullText: string,
  maxInlineChars: number,
  savedRelPath: string | null
): { summary: string; totalChars: number; totalLines: number } {
  const totalChars = fullText.length;
  const totalLines = fullText ? fullText.split(/\r?\n/).length : 0;
  const headLimit = Math.min(6000, Math.max(200, Math.floor(maxInlineChars * 0.5)));
  const tailLimit = Math.min(4000, Math.max(150, Math.floor(maxInlineChars * 0.3)));
  const locationNote = savedRelPath
    ? `full redacted log saved to ${savedRelPath}`
    : 'diagnostics file unavailable';

  if (totalChars <= headLimit + tailLimit + 200) {
    const clipped = fullText.slice(0, Math.max(200, maxInlineChars - 240));
    const summary = `[Output truncated (${totalChars} chars, ${totalLines} lines > ${maxInlineChars} chars); ${locationNote}]\n\n${clipped}`;
    return { summary, totalChars, totalLines };
  }

  const head = fullText.slice(0, headLimit);
  const tail = fullText.slice(-tailLimit);
  const omitted = totalChars - headLimit - tailLimit;
  const summary = [
    `[Output exceeded inline limit (${totalChars} chars, ${totalLines} lines > ${maxInlineChars} chars); ${locationNote}]`,
    '',
    `--- HEAD (${head.length} chars) ---`,
    head,
    '',
    `--- OMITTED ${omitted} chars (${locationNote}) ---`,
    '',
    `--- TAIL (${tail.length} chars) ---`,
    tail,
  ].join('\n');

  return { summary, totalChars, totalLines };
}

function spillOversizedToolResult(
  cwd: string,
  toolName: string,
  res: any,
  maxInlineChars: number
): any {
  if (!res || typeof res !== 'object') return res;
  const content: any[] = Array.isArray(res.content) ? res.content : [];
  const textParts = content.filter((part) => part && part.type === 'text' && typeof part.text === 'string');
  const joinedText = textParts.map((part) => part.text).join('\n');
  const structuredOut =
    res.structuredContent && typeof res.structuredContent.output === 'string'
      ? res.structuredContent.output
      : '';
  const candidateFullText = structuredOut.length > joinedText.length ? structuredOut : joinedText;

  if (candidateFullText.length <= maxInlineChars) {
    return res;
  }

  const savedRelPath = saveLargeToolOutput(cwd, toolName, candidateFullText);
  const { summary, totalChars, totalLines } = buildTruncatedOutputSummary(
    candidateFullText,
    maxInlineChars,
    savedRelPath
  );
  const nonTextParts = content.filter((part) => !part || part.type !== 'text');
  const baseDetails = res.details && typeof res.details === 'object' ? res.details : {};

  return {
    ...res,
    content: [{ type: 'text' as const, text: summary }, ...nonTextParts],
    ...(res.structuredContent && typeof res.structuredContent === 'object'
      ? {
          structuredContent: {
            ...res.structuredContent,
            output: summary,
            truncated: true,
            ...(savedRelPath ? { full_output_path: savedRelPath } : {}),
          },
        }
      : {}),
    details: {
      ...baseDetails,
      truncated: true,
      totalChars,
      totalLines,
      ...(savedRelPath ? { savedOutputPath: savedRelPath } : {}),
    },
  };
}

function wrapToolWithGuard(
  cwd: string,
  def: ToolDefinition<any, any>,
  guardFn: ((params: any) => string | null) | null,
  getKnownSecrets?: () => Iterable<string>,
  explicitMaxInlineChars?: number
): ToolDefinition<any, any> {
  return {
    ...def,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (guardFn) {
        const reason = guardFn(params);
        if (reason) {
          return blockedToolResult(reason);
        }
      }
      let rawRes: any;
      try {
        rawRes = await def.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (err: any) {
        const safeMsg = redactSecrets(String(err?.message || err), getKnownSecrets?.());
        throw new Error(safeMsg);
      }
      const redacted = redactUnknownValue(rawRes, getKnownSecrets?.());
      const maxInlineChars =
        parsePositiveInt(explicitMaxInlineChars) ?? readVnResearchConfig(cwd).maxToolOutputChars;
      return spillOversizedToolResult(cwd, def.name, redacted, maxInlineChars);
    },
  };
}

export function createGuardedBuiltinToolDefinitions(
  cwd: string,
  toolNames: readonly string[],
  options?: GuardedBuiltinToolsOptions
): ToolDefinition<any, any>[] {
  const getKnownSecrets = options?.getKnownSecrets;
  const maxInline = options?.maxInlineOutputChars;
  const defs: ToolDefinition<any, any>[] = [];

  for (const name of toolNames) {
    if (name === 'read') {
      const def = createReadToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) =>
            isRestrictedSecretPath(String(params?.path ?? ''), cwd)
              ? `Security guard: reading credential/secret file "${params?.path}" is prohibited.`
              : null,
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'edit') {
      const def = createEditToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) =>
            isRestrictedSecretPath(String(params?.path ?? ''), cwd)
              ? `Security guard: editing credential/secret file "${params?.path}" is prohibited.`
              : null,
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'write') {
      const def = createWriteToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) =>
            isRestrictedSecretPath(String(params?.path ?? ''), cwd)
              ? `Security guard: writing credential/secret file "${params?.path}" is prohibited.`
              : null,
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'bash') {
      const def = createBashToolDefinition(cwd, {
        ...(options?.bashPath ? { shellPath: options.bashPath } : {}),
        exposeSessionEnvironment: false,
      });
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) => {
            const reason = detectBlockedSecretCommand(String(params?.command ?? ''), cwd);
            return reason ? `Security guard: ${reason}` : null;
          },
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'ls') {
      const def = createLsToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) =>
            isRestrictedSecretPath(String(params?.path ?? ''), cwd)
              ? `Security guard: listing credential directory "${params?.path}" is prohibited.`
              : null,
          getKnownSecrets,
          maxInline
        )
      );
    } else if (name === 'find') {
      const def = createFindToolDefinition(cwd);
      defs.push(
        wrapToolWithGuard(
          cwd,
          def,
          (params) =>
            isRestrictedSecretPath(String(params?.path ?? ''), cwd)
              ? `Security guard: searching credential directory "${params?.path}" is prohibited.`
              : null,
          getKnownSecrets,
          maxInline
        )
      );
    }
  }

  return defs;
}
