/**
 * Cloud multimodal vision adapter for `vn_smoke_test`.
 *
 * Lives in `server/src/agent/` (NOT `server/src/vn/`) so the deterministic VN core
 * never issues network requests. Uses the active Pi SDK `ModelRuntime` and `Model`
 * directly, with automatic degradation when:
 * - the active model does not support `'image'` input modality,
 * - the provider returns a safety/content-moderation refusal (common for R-18 VNs), or
 * - the response is malformed/unavailable.
 */

import fs from 'node:fs';
import type { AssistantMessage, Context, ImageContent, Model, TextContent, Usage } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SmokeVisionBridge, SmokeVisionDefect } from '../vn/smoke.js';

const REFUSAL_RE =
  /(?:content[_\s-]?filter|prohibited[_\s-]?content|safety|policy\s*violation|inappropriate|explicit|nsfw|i\s+(?:cannot|can't|am\s+unable\s+to)\s+(?:assist|help|view|analyze|process)|sorry,?\s*i\s+(?:cannot|can't)|无法(?:查看|分析|处理|协助|识别)|内容审查|敏感内容|违反.*政策)/i;

function modelSupportsVision(model: Model<any> | null | undefined): boolean {
  if (!model || typeof model !== 'object') return false;
  const input = (model as { input?: unknown }).input;
  return Array.isArray(input) && input.includes('image');
}

function extractAssistantText(msg: AssistantMessage): string {
  if (!Array.isArray(msg?.content)) return '';
  return msg.content
    .filter((b): b is TextContent => Boolean(b && b.type === 'text' && typeof (b as TextContent).text === 'string'))
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function tryParseJsonObject(candidate: string): Record<string, unknown> | null {
  const s = candidate.trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseLooseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = tryParseJsonObject(match[1] || '');
    if (parsed) return parsed;
  }
  return tryParseJsonObject(trimmed);
}

function loadPngImageContent(framePath: string): ImageContent | null {
  try {
    if (!fs.existsSync(framePath) || !fs.statSync(framePath).isFile()) return null;
    const buf = fs.readFileSync(framePath);
    if (!buf.length) return null;
    return {
      type: 'image',
      data: buf.toString('base64'),
      mimeType: 'image/png',
    };
  } catch {
    return null;
  }
}

export function createSmokeVisionBridge(options: {
  getModel: () => Model<any> | undefined;
  getModelRuntime: () => ModelRuntime | undefined;
  onUsage?: (provider: string, modelId: string, usage: Usage) => void;
}): SmokeVisionBridge {
  return {
    async locateStartButton(framePath, signal) {
      const model = options.getModel();
      const runtime = options.getModelRuntime();
      if (!model || !runtime) {
        return { found: false, skippedReason: '当前会话无可用模型运行时，跳过标题按钮识别。' };
      }
      if (!modelSupportsVision(model)) {
        return { found: false, skippedReason: `当前模型 ${model.id} 不支持图像输入，跳过标题按钮识别。` };
      }
      const img = loadPngImageContent(framePath);
      if (!img) {
        return { found: false, skippedReason: '标题截图不可读，跳过按钮识别。' };
      }

      const context: Context = {
        systemPrompt:
          'You inspect a visual novel screenshot to locate the main menu "Start / New Game / はじめから / START / 开始游戏" button. Distinguish carefully between: (1) splash/brand logo/disclaimer/warning screens -> no start button yet, return {"found": false}; (2) title menu screens with menu buttons -> return {"found": true, "xNorm": number, "yNorm": number, "label": string} where xNorm and yNorm are normalized [0.05..0.95] coordinates of the Start/New Game button center; (3) active in-game dialogue/gameplay screens -> already past title screen, return {"found": false}. Reply ONLY with a single JSON object.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Determine whether this screenshot shows a title menu with a Start / New Game (はじめから / NEW GAME / START / 开始游戏) button. If it is a splash/logo/disclaimer screen (not yet at the title menu) or already an active dialogue/gameplay screen, return {"found": false}. Otherwise return {"found": true, "xNorm": number, "yNorm": number, "label": string}.',
              },
              img,
            ],
            timestamp: Date.now(),
          },
        ],
      };

      try {
        const res = await runtime.completeSimple(model, context, { signal });
        if (res.usage) options.onUsage?.(model.provider, model.id, res.usage);
        if (res.stopReason === 'error') {
          const errMsg = res.errorMessage || '视觉模型调用失败';
          return {
            found: false,
            skippedReason: REFUSAL_RE.test(errMsg)
              ? '标题按钮识别触发内容审查/拒答，已降级跳过。'
              : `标题按钮识别失败已降级：${errMsg}`,
          };
        }
        const text = extractAssistantText(res);
        // Always parse structured JSON BEFORE testing REFUSAL_RE so legitimate JSON containing words
        // like "explicit", "safety", or "inappropriate" in button labels is never misclassified as refusal.
        const obj = parseLooseJsonObject(text);
        if (obj && typeof obj.found === 'boolean') {
          if (obj.found !== true) {
            return { found: false };
          }
          const x = Number(obj.xNorm);
          const y = Number(obj.yNorm);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { found: false };
          }
          return {
            found: true,
            xNorm: Math.max(0.05, Math.min(0.95, x)),
            yNorm: Math.max(0.05, Math.min(0.95, y)),
            label: typeof obj.label === 'string' ? obj.label : undefined,
          };
        }
        if (REFUSAL_RE.test(text)) {
          return { found: false, skippedReason: '标题按钮识别触发模型拒答，已降级跳过。' };
        }
        return { found: false };
      } catch (err: any) {
        const msg = String(err?.message || err);
        return {
          found: false,
          skippedReason: REFUSAL_RE.test(msg)
            ? '标题按钮识别触发内容审查/拒答，已降级跳过。'
            : `标题按钮识别异常已降级：${msg}`,
        };
      }
    },

    async inspectFrames(frames, ctx, signal) {
      const model = options.getModel();
      const runtime = options.getModelRuntime();
      if (!model || !runtime) {
        return { status: 'skipped', reason: '当前会话无可用模型运行时，已跳过视觉检查。', defects: [] };
      }
      if (!modelSupportsVision(model)) {
        return {
          status: 'skipped',
          reason: `当前模型 ${model.id} 不支持图像输入（纯文本模型），已降级为 warning。`,
          defects: [],
        };
      }

      const isPreTranslateProbe = ctx.probeMode === 'pre_translate';
      const contentParts: Array<TextContent | ImageContent> = [
        {
          type: 'text',
          text: [
            `Inspect these ${frames.length} visual novel patch smoke-test screenshot(s) (target language: ${ctx.targetLang}).`,
            ...(isPreTranslateProbe
              ? [
                  'NOTE: This is a pre-translation 1-line smoke probe (only a single line was modified to verify engine loading/repacking/encoding). Remaining original Japanese dialogue is EXPECTED and NOT a defect.',
                ]
              : []),
            'Inspect ONLY the in-game canvas / client area; IGNORE OS non-client chrome (Windows window title bar, window borders, or native Win32 top menu bars if visible).',
            'Check ONLY for in-game localization/rendering defects:',
            '1. "error_dialog" (severity: "error"): engine crash popup or error dialog visible.',
            '2. "mojibake" (severity: "error"): garbled/corrupted characters or half-width katakana gibberish in in-game dialogue or in-game UI (ignore OS window title bar text).',
            ...(!isPreTranslateProbe
              ? [
                  '3. "untranslated_dialogue" (severity: "error"): dialogue box clearly still displays untranslated Japanese sentences (ignore baked image title/menu buttons).',
                ]
              : []),
            `${isPreTranslateProbe ? 3 : 4}. "tofu_boxes" (severity: "warning"): missing font glyphs shown as empty boxes/squares/question marks/missing-glyph middots ("·"), OR horizontally overlapping/colliding glyphs caused by GDI font fallback metrics mismatch (check carefully in both pre_translate and post_translate modes).`,
            `${isPreTranslateProbe ? 4 : 5}. "text_overflow" (severity: "warning"): text clipping or overflowing outside the textbox.`,
            `${isPreTranslateProbe ? 5 : 6}. "blank_or_black_screen" (severity: "error"): all or nearly all captured frames are solid black, solid white, or completely blank/unrendered (game stuck on black screen or failed to render title/dialogue).`,
            ctx.sampleTranslations.length
              ? `Sample expected translated lines: ${ctx.sampleTranslations.slice(0, 4).join(' | ')}`
              : '',
            'Reply ONLY with strict JSON: {"defects": [{"severity": "error"|"warning", "kind": "...", "description": "简体中文简短说明", "frame": "<label>"}]}. Return {"defects": []} if no defects.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ];

      let loadedCount = 0;
      for (const f of frames) {
        const img = loadPngImageContent(f.path);
        if (!img) continue;
        contentParts.push({ type: 'text', text: `Frame label: ${f.label}` });
        contentParts.push(img);
        loadedCount++;
      }
      if (loadedCount === 0) {
        return { status: 'skipped', reason: '没有可读的截图文件，跳过视觉检查。', defects: [] };
      }

      const context: Context = {
        systemPrompt:
          'You are a strict visual novel localization QA inspector. Report concrete rendering or localization defects in JSON only; never hallucinate defects when frames look clean.',
        messages: [
          {
            role: 'user',
            content: contentParts,
            timestamp: Date.now(),
          },
        ],
      };

      try {
        const res = await runtime.completeSimple(model, context, { signal });
        if (res.usage) options.onUsage?.(model.provider, model.id, res.usage);
        if (res.stopReason === 'error') {
          const errMsg = res.errorMessage || '视觉模型调用失败';
          return {
            status: 'skipped',
            reason: REFUSAL_RE.test(errMsg)
              ? '视觉审核触发内容审查或模型拒答，已自动降级为 warning（不阻断验收）。'
              : `视觉模型返回错误，已降级跳过：${errMsg}`,
            defects: [],
          };
        }
        const text = extractAssistantText(res);
        // Always parse structured JSON BEFORE testing REFUSAL_RE so defect descriptions containing
        // words like "Explicit mojibake" or "Inappropriate encoding" are never misclassified as refusals.
        const obj = parseLooseJsonObject(text);
        if (obj && Array.isArray(obj.defects)) {
          const defects: SmokeVisionDefect[] = [];
          for (const item of obj.defects) {
            if (!item || typeof item !== 'object') continue;
            const rec = item as Record<string, unknown>;
            const desc = typeof rec.description === 'string' ? rec.description.trim() : '';
            if (!desc) continue;
            const kind = typeof rec.kind === 'string' && rec.kind.trim() ? rec.kind.trim() : 'visual_issue';
            const sev = rec.severity === 'error' ? 'error' : 'warning';
            const frame = typeof rec.frame === 'string' && rec.frame.trim() ? rec.frame.trim() : undefined;
            defects.push({ severity: sev, kind, description: desc, ...(frame ? { frame } : {}) });
          }
          return { status: 'checked', defects };
        }
        if (REFUSAL_RE.test(text)) {
          return {
            status: 'skipped',
            reason: '视觉审核触发内容审查或模型拒答，已自动降级为 warning（不阻断验收）。',
            defects: [],
          };
        }
        return {
          status: 'skipped',
          reason: '视觉模型未返回合法 JSON 报告，已降级跳过。',
          defects: [],
        };
      } catch (err: any) {
        const msg = String(err?.message || err);
        return {
          status: 'skipped',
          reason: REFUSAL_RE.test(msg)
            ? '视觉审核触发内容审查或模型拒答，已自动降级为 warning（不阻断验收）。'
            : `视觉模型调用异常已降级跳过：${msg}`,
          defects: [],
        };
      }
    },
  };
}
