import * as React from 'react';
import { X } from 'lucide-react';
import { gsap, prefersReducedMotion } from '@/lib/gsap.js';
import { cn } from '@/lib/utils.js';

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ReactNode;
  maxWidthClass?: string;
  children: React.ReactNode;
}

const supportsClosedBy = () =>
  typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;

export function Dialog({
  isOpen,
  onClose,
  title,
  icon,
  maxWidthClass,
  children,
}: DialogProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const pointerDownOutsideRef = React.useRef(false);
  const titleId = React.useId();

  React.useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const reduced = prefersReducedMotion();
    let rafId: number | undefined;

    if (isOpen) {
      gsap.killTweensOf(dialog);
      if (!dialog.open) {
        dialog.showModal();
      }
      gsap.fromTo(
        dialog,
        {
          opacity: 0,
          scale: reduced ? 1 : 0.96,
          y: reduced ? 0 : 10,
          '--dialog-backdrop': 0,
        },
        {
          opacity: 1,
          scale: 1,
          y: 0,
          '--dialog-backdrop': 1,
          duration: reduced ? 0.1 : 0.28,
          ease: 'power3.out',
          clearProps: 'transform',
        }
      );

      rafId = requestAnimationFrame(() => {
        const target = dialog.querySelector<HTMLElement>('[data-autofocus]');
        target?.focus();
      });
    } else if (dialog.open) {
      gsap.killTweensOf(dialog);
      gsap.to(dialog, {
        opacity: 0,
        scale: reduced ? 1 : 0.97,
        y: reduced ? 0 : 8,
        '--dialog-backdrop': 0,
        duration: reduced ? 0.08 : 0.18,
        ease: 'power2.in',
        onComplete: () => {
          if (dialog.open) {
            dialog.close();
          }
          gsap.set(dialog, { clearProps: 'opacity,transform' });
        },
      });
    }

    return () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [isOpen]);

  const isOutsideRect = (e: { clientX: number; clientY: number }, dialog: HTMLDialogElement) => {
    const r = dialog.getBoundingClientRect();
    return (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    );
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (supportsClosedBy()) return;
    const dialog = dialogRef.current;
    pointerDownOutsideRef.current = !!dialog && e.target === dialog && isOutsideRect(e, dialog);
  };

  const handleClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (supportsClosedBy()) return;
    const dialog = dialogRef.current;
    const startedOutside = pointerDownOutsideRef.current;
    pointerDownOutsideRef.current = false;
    if (!dialog || e.target !== dialog || !startedOutside) return;
    if (isOutsideRect(e, dialog)) onClose();
  };

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      onCancel={handleCancel}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onClose={() => {
        if (isOpen) onClose();
      }}
      aria-labelledby={titleId}
      className={cn('pc-dialog', maxWidthClass)}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line bg-sheet/65 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <h2 id={titleId} className="truncate text-[0.9375rem] font-semibold tracking-tight text-ink">
            {title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-well hover:text-ink cursor-pointer"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>
      <div className="pc-scroller max-h-[calc(88dvh-3.5rem)] overflow-y-auto">{children}</div>
    </dialog>
  );
}
