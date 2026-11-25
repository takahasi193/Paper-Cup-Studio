import * as React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { ChatImageAttachment } from '@/lib/api.js';
import { toImageDataUrl } from '@/lib/imageAttachments.js';
import { ImageLightbox } from './ImageLightbox.js';

interface ImageAttachmentStripProps {
  images: readonly ChatImageAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  modelSupportsImage?: boolean;
  modelLabel?: string | null;
}

export function ImageAttachmentStrip({
  images,
  onRemove,
  disabled = false,
  modelSupportsImage,
  modelLabel,
}: ImageAttachmentStripProps) {
  const [previewIndex, setPreviewIndex] = React.useState<number | null>(null);

  if (images.length === 0) return null;

  return (
    <div className="space-y-1.5 border-b border-line/70 px-3.5 pt-3 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        {images.map((img, idx) => {
          const src = toImageDataUrl(img);
          const alt = img.name || `附件图片 ${idx + 1}`;
          return (
            <div key={`${idx}-${img.name || img.mimeType}`} className="group relative shrink-0">
              <button
                type="button"
                onClick={() => setPreviewIndex(idx)}
                title={`点击放大查看${img.name ? `「${img.name}」` : ''}`}
                aria-label={`放大预览图片 ${idx + 1}${img.name ? `：${img.name}` : ''}`}
                className="block size-14 overflow-hidden rounded-xl border border-line-strong bg-well/70 shadow-xs transition-colors hover:border-string focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-string cursor-pointer"
              >
                {src ? (
                  <img src={src} alt={alt} className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-[10px] text-ink-3">
                    无效
                  </span>
                )}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(idx)}
                aria-label={`移除图片 ${idx + 1}${img.name ? `：${img.name}` : ''}`}
                title="移除图片"
                className="absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full border border-line-strong bg-surface-raised text-ink-2 shadow-xs transition-colors hover:border-danger hover:bg-danger hover:text-on-string disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      {modelSupportsImage === false && (
        <div
          role="alert"
          className="flex items-center gap-1.5 rounded-xl border border-warn/40 bg-warn-soft px-2.5 py-1 text-[11px] text-warn"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            当前模型{modelLabel ? `（${modelLabel}）` : ''}不支持图片输入，请切换至支持视觉的模型或移除图片后发送。
          </span>
        </div>
      )}

      <ImageLightbox
        images={images}
        activeIndex={previewIndex}
        onChangeIndex={setPreviewIndex}
      />
    </div>
  );
}
