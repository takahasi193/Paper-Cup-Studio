import * as React from 'react';
import { ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog.js';
import { ChatImageAttachment } from '@/lib/api.js';
import { toImageDataUrl } from '@/lib/imageAttachments.js';

interface ImageLightboxProps {
  images: readonly ChatImageAttachment[];
  activeIndex: number | null;
  onChangeIndex: (nextIndex: number | null) => void;
}

export function ImageLightbox({
  images,
  activeIndex,
  onChangeIndex,
}: ImageLightboxProps) {
  const isOpen = activeIndex !== null && activeIndex >= 0 && activeIndex < images.length;
  const current = isOpen && activeIndex !== null ? images[activeIndex] : null;
  const src = current ? toImageDataUrl(current) : null;
  const count = images.length;

  React.useEffect(() => {
    if (!isOpen || activeIndex === null || count <= 1) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onChangeIndex((activeIndex - 1 + count) % count);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onChangeIndex((activeIndex + 1) % count);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, activeIndex, count, onChangeIndex]);

  const title = current?.name
    ? count > 1 && activeIndex !== null
      ? `${current.name} (${activeIndex + 1}/${count})`
      : current.name
    : count > 1 && activeIndex !== null
      ? `图片预览 (${activeIndex + 1}/${count})`
      : '图片预览';

  return (
    <Dialog
      isOpen={isOpen}
      onClose={() => onChangeIndex(null)}
      title={title}
      icon={<ImageIcon className="size-4 shrink-0 text-string" aria-hidden="true" />}
      maxWidthClass="[--dialog-max-w:68rem]"
    >
      <div className="relative flex min-h-[16rem] items-center justify-center bg-well/40 p-4 sm:p-6">
        {src ? (
          <img
            src={src}
            alt={current?.name || '预览图片'}
            className="max-h-[72dvh] max-w-full rounded-xl object-contain shadow-[var(--shadow-card)]"
          />
        ) : (
          <p className="text-xs text-ink-3">无法预览此图片。</p>
        )}

        {count > 1 && activeIndex !== null && (
          <>
            <button
              type="button"
              onClick={() => onChangeIndex((activeIndex - 1 + count) % count)}
              aria-label="上一张图片"
              className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex size-9 items-center justify-center rounded-full border border-line-strong bg-surface-raised/90 text-ink shadow-[var(--shadow-card)] backdrop-blur-sm transition-colors hover:border-string hover:text-string-ink cursor-pointer"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onChangeIndex((activeIndex + 1) % count)}
              aria-label="下一张图片"
              className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex size-9 items-center justify-center rounded-full border border-line-strong bg-surface-raised/90 text-ink shadow-[var(--shadow-card)] backdrop-blur-sm transition-colors hover:border-string hover:text-string-ink cursor-pointer"
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
