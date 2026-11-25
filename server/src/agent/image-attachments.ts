import path from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image (decoded)
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB per message (decoded)
export const DEFAULT_IMAGE_ONLY_PROMPT = '请查看附带的图片并协助定位问题。';

export interface ChatImageAttachment {
  mimeType: SupportedImageMimeType;
  data: string;
  name?: string;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function normalizeImageMimeType(raw: unknown): SupportedImageMimeType | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'image/jpg') return 'image/jpeg';
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(base)
    ? (base as SupportedImageMimeType)
    : null;
}

export function detectImageMimeFromMagicBytes(buf: Buffer): SupportedImageMimeType | null {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF87a / GIF89a
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      return 'image/gif';
    }
  }
  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function sanitizeImageName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const stripped = path.basename(raw.trim()).replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '');
  if (!stripped) return undefined;
  return stripped.length > 120 ? stripped.slice(0, 120) : stripped;
}

export function validateAndNormalizeImageAttachments(raw: unknown): ChatImageAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('图片附件参数格式无效：expected an array of images.');
  }
  if (raw.length === 0) return [];
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`单条消息最多附带 ${MAX_IMAGES_PER_MESSAGE} 张图片（当前 ${raw.length} 张）。`);
  }

  let totalBytes = 0;
  const normalized: ChatImageAttachment[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第 ${i + 1} 张图片附件格式无效。`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.data !== 'string' || !rec.data.trim()) {
      throw new Error(`第 ${i + 1} 张图片缺少有效的 Base64 数据。`);
    }

    let rawData = rec.data.trim();
    let declaredMimeRaw: unknown = rec.mimeType;
    const dataUrlMatch = /^data:([^;,\s]+);base64,([\s\S]+)$/i.exec(rawData);
    if (dataUrlMatch) {
      if (!declaredMimeRaw) {
        declaredMimeRaw = dataUrlMatch[1];
      }
      rawData = dataUrlMatch[2];
    }

    const declaredMime = normalizeImageMimeType(declaredMimeRaw);
    if (!declaredMime) {
      throw new Error(
        `第 ${i + 1} 张图片类型不支持，仅支持 PNG / JPEG / GIF / WebP 格式。`
      );
    }

    const cleanBase64 = rawData.replace(/\s+/g, '');
    if (
      cleanBase64.length === 0 ||
      cleanBase64.length % 4 !== 0 ||
      !BASE64_PATTERN.test(cleanBase64)
    ) {
      throw new Error(`第 ${i + 1} 张图片 Base64 编码无效。`);
    }

    const decoded = Buffer.from(cleanBase64, 'base64');
    if (decoded.length === 0) {
      throw new Error(`第 ${i + 1} 张图片内容为空。`);
    }
    if (decoded.length > MAX_IMAGE_BYTES) {
      const limitMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
      throw new Error(`第 ${i + 1} 张图片超过单张大小限制（${limitMb} MB）。`);
    }
    totalBytes += decoded.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      const totalMb = Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024));
      throw new Error(`附件图片总大小超过限制（${totalMb} MB）。`);
    }

    const detectedMime = detectImageMimeFromMagicBytes(decoded);
    if (!detectedMime) {
      throw new Error(`第 ${i + 1} 张图片文件头校验失败，请确认文件为有效的 PNG / JPEG / GIF / WebP 图片。`);
    }

    const name = sanitizeImageName(rec.name);
    normalized.push({
      mimeType: detectedMime,
      data: cleanBase64,
      ...(name ? { name } : {}),
    });
  }

  return normalized;
}

export function toPiImageContents(images?: readonly ChatImageAttachment[]): ImageContent[] {
  if (!Array.isArray(images) || images.length === 0) return [];
  return images.map((img) => ({
    type: 'image' as const,
    data: img.data,
    mimeType: img.mimeType,
  }));
}

export function extractImagesFromContent(content: unknown): ChatImageAttachment[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImageAttachment[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;
    if (rec.type !== 'image') continue;
    if (typeof rec.data !== 'string' || !rec.data.trim()) continue;
    const mimeType = normalizeImageMimeType(rec.mimeType);
    if (!mimeType) continue;
    out.push({
      mimeType,
      data: rec.data.trim(),
    });
  }
  return out;
}

export function summarizeUserMessagePreview(content: unknown, extractedText: string): string {
  const trimmed = String(extractedText || '').trim();
  const imgs = extractImagesFromContent(content);
  if (imgs.length > 0 && (!trimmed || trimmed === DEFAULT_IMAGE_ONLY_PROMPT)) {
    return imgs.length > 1 ? `[图片 ×${imgs.length}]` : '[图片]';
  }
  return trimmed;
}

export function modelSupportsImageInput(model: { input?: unknown } | null | undefined): boolean {
  if (!model || typeof model !== 'object') return false;
  return Array.isArray(model.input) && model.input.includes('image');
}

export function inferCustomModelInputModalities(id: string): ('text' | 'image')[] {
  const lower = String(id || '').toLowerCase();
  if (
    /(?:claude-(?:3|4|5|opus|sonnet|haiku|fable)|gemini-(?:1\.5|2|3|4)|gpt-(?:4o|4\.1|5|6)|(?:^|[-_./])o[34](?:$|[-_.])|grok-(?:2-vision|3|4)|doubao-seed|qwen.*vl|qwen3[.-][5-9]|glm-4(?:\.[5-9])?v|glm-[5-9]v|kimi-k2[.-]5|kimi-k3|internvl|pixtral|vision|(?:^|[-_./])vl(?:$|[-_.])|omni)/i.test(
      lower
    )
  ) {
    return ['text', 'image'];
  }
  return ['text'];
}
