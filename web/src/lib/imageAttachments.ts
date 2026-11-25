import {
  ChatImageAttachment,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  SupportedImageMimeType,
} from './api.js';

export function isSupportedImageMimeType(mime: unknown): mime is SupportedImageMimeType {
  if (typeof mime !== 'string') return false;
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(base);
}

const SAFE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function toImageDataUrl(
  img: Pick<ChatImageAttachment, 'mimeType' | 'data'> | null | undefined
): string | null {
  if (!img || typeof img.data !== 'string') return null;
  if (!isSupportedImageMimeType(img.mimeType)) return null;
  const cleanData = img.data.replace(/\s+/g, '');
  if (!cleanData || cleanData.length % 4 !== 0 || !SAFE_BASE64_RE.test(cleanData)) {
    return null;
  }
  return `data:${img.mimeType};base64,${cleanData}`;
}

export function estimateDecodedBase64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

export function extractClipboardImageFiles(
  clipboardData: DataTransfer | null | undefined
): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  if (clipboardData.items) {
    for (let i = 0; i < clipboardData.items.length; i += 1) {
      const item = clipboardData.items[i];
      if (item && item.kind === 'file' && item.type.toLowerCase().startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length === 0 && clipboardData.files) {
    for (let i = 0; i < clipboardData.files.length; i += 1) {
      const f = clipboardData.files[i];
      if (f && f.type.toLowerCase().startsWith('image/')) {
        files.push(f);
      }
    }
  }
  return files;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('无法读取图片文件。'));
    };
    reader.onerror = () => reject(reader.error || new Error('读取图片文件失败。'));
    reader.readAsDataURL(blob);
  });
}

async function convertRasterFileToPngDataUrl(file: File): Promise<{ mimeType: SupportedImageMimeType; base64: string }> {
  const rawUrl = await readBlobAsDataUrl(file);
  const commaIdx = rawUrl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error(`图片「${file.name || '未命名'}」编码无效。`);
  }
  if (typeof document === 'undefined') {
    throw new Error(`浏览器环境不支持转换图片「${file.name || '未命名'}」。`);
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`无法解析图片「${file.name || '未命名'}」。`));
    el.src = rawUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width || 1;
  canvas.height = img.naturalHeight || img.height || 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法初始化画布以转换图片格式。');
  }
  ctx.drawImage(img, 0, 0);
  const pngUrl = canvas.toDataURL('image/png');
  const pngComma = pngUrl.indexOf(',');
  if (pngComma === -1) {
    throw new Error(`转换图片「${file.name || '未命名'}」失败。`);
  }
  return {
    mimeType: 'image/png',
    base64: pngUrl.slice(pngComma + 1),
  };
}

export async function readImageFilesToAttachments(
  files: Iterable<File>,
  existing: readonly ChatImageAttachment[]
): Promise<{ added: ChatImageAttachment[]; errors: string[] }> {
  const incoming = Array.from(files);
  const added: ChatImageAttachment[] = [];
  const errors: string[] = [];

  let currentTotalBytes = existing.reduce(
    (sum, img) => sum + estimateDecodedBase64Bytes(img.data),
    0
  );

  for (const file of incoming) {
    if (existing.length + added.length >= MAX_IMAGES_PER_MESSAGE) {
      errors.push(`每条消息最多添加 ${MAX_IMAGES_PER_MESSAGE} 张图片。`);
      break;
    }

    const rawMime = (file.type || '').toLowerCase();
    const looksLikeImage =
      rawMime.startsWith('image/') ||
      /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file.name || '');
    if (!looksLikeImage) {
      errors.push(`文件「${file.name || '未命名'}」不是支持的图片类型。`);
      continue;
    }

    const mappedMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    let resolvedMime: SupportedImageMimeType | null = isSupportedImageMimeType(mappedMime)
      ? mappedMime
      : null;

    try {
      let base64 = '';
      if (resolvedMime) {
        const dataUrl = await readBlobAsDataUrl(file);
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx === -1) {
          errors.push(`图片「${file.name || '未命名'}」读取失败。`);
          continue;
        }
        base64 = dataUrl.slice(commaIdx + 1).replace(/\s+/g, '');
      } else {
        const converted = await convertRasterFileToPngDataUrl(file);
        resolvedMime = converted.mimeType;
        base64 = converted.base64.replace(/\s+/g, '');
      }

      const bytes = estimateDecodedBase64Bytes(base64);
      if (bytes <= 0) {
        errors.push(`图片「${file.name || '未命名'}」内容为空。`);
        continue;
      }
      if (bytes > MAX_IMAGE_BYTES) {
        const limitMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
        errors.push(`图片「${file.name || '未命名'}」超过 ${limitMb} MB 单张上限。`);
        continue;
      }
      if (currentTotalBytes + bytes > MAX_TOTAL_IMAGE_BYTES) {
        const totalMb = Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024));
        errors.push(`所选图片总大小超过 ${totalMb} MB 上限。`);
        continue;
      }
      currentTotalBytes += bytes;
      added.push({
        mimeType: resolvedMime,
        data: base64,
        ...(file.name ? { name: file.name } : {}),
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `读取图片「${file.name || '未命名'}」失败。`);
    }
  }

  return { added, errors };
}
