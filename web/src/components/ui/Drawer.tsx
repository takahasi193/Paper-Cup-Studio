import * as React from 'react';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  side: 'start' | 'end';
  ariaLabel: string;
  id?: string;
  children: React.ReactNode;
}

export function Drawer({ isOpen, onClose, side, ariaLabel, id, children }: DrawerProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const sheetRef = React.useRef<HTMLDivElement>(null);

  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  const phaseRef = React.useRef<'idle' | 'opening' | 'open' | 'closing'>('idle');
  const closeFallbackTimerRef = React.useRef<number | null>(null);

  const clearFallbackTimer = () => {
    if (closeFallbackTimerRef.current !== null) {
      window.clearTimeout(closeFallbackTimerRef.current);
      closeFallbackTimerRef.current = null;
    }
  };

  const finalizeClosed = React.useCallback(() => {
    clearFallbackTimer();
    const dialog = dialogRef.current;
    phaseRef.current = 'idle';
    if (dialog?.open) {
      dialog.close();
    }
    if (isOpenRef.current) {
      onCloseRef.current();
    }
  }, []);

  const requestAnimatedClose = React.useCallback(() => {
    const dialog = dialogRef.current;
    const scroller = scrollerRef.current;
    const sheet = sheetRef.current;
    if (!dialog?.open || !scroller || !sheet) {
      finalizeClosed();
      return;
    }
    phaseRef.current = 'closing';
    const closedLeft = side === 'start' ? sheet.offsetWidth : 0;

    const handleCloseScrollEnd = () => {
      if (phaseRef.current === 'closing' && Math.abs(scroller.scrollLeft - closedLeft) <= 2) {
        finalizeClosed();
      }
    };
    if ('onscrollend' in window) {
      scroller.addEventListener('scrollend', handleCloseScrollEnd, { once: true });
    }
    scroller.scrollTo({ left: closedLeft, behavior: 'auto' });

    clearFallbackTimer();
    closeFallbackTimerRef.current = window.setTimeout(() => {
      scroller.removeEventListener('scrollend', handleCloseScrollEnd);
      if (phaseRef.current === 'closing' && dialog.open) {
        finalizeClosed();
      }
    }, 650);
  }, [finalizeClosed, side]);

  // IntersectionObserver monitors sheet visibility inside the dialog viewport
  React.useEffect(() => {
    const dialog = dialogRef.current;
    const sheet = sheetRef.current;
    if (!dialog || !sheet) return;

    const visibleThreshold = Math.min(0.05, 1 / Math.max(320, window.innerWidth));
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry || !dialog.open) return;
        if (entry.intersectionRatio >= 0.98 && phaseRef.current === 'opening') {
          phaseRef.current = 'open';
        } else if (
          entry.intersectionRatio < visibleThreshold &&
          (phaseRef.current === 'open' || phaseRef.current === 'closing')
        ) {
          finalizeClosed();
        }
      },
      { root: dialog, threshold: [visibleThreshold, 1] }
    );

    observer.observe(sheet);
    return () => observer.disconnect();
  }, [finalizeClosed]);

  // Backdrop opacity scroll fallback when animation-timeline: scroll() is unsupported
  React.useEffect(() => {
    const dialog = dialogRef.current;
    const scroller = scrollerRef.current;
    const sheet = sheetRef.current;
    if (!dialog || !scroller || !sheet) return;
    if (typeof CSS !== 'undefined' && CSS.supports('animation-timeline: scroll()')) {
      return;
    }

    const handleScroll = () => {
      const width = Math.max(1, sheet.offsetWidth);
      const ratio =
        side === 'start'
          ? 1 - scroller.scrollLeft / width
          : scroller.scrollLeft / width;
      dialog.style.setProperty('--drawer-backdrop', String(Math.max(0, Math.min(1, ratio))));
    };

    scroller.addEventListener('scroll', handleScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', handleScroll);
  }, [side]);

  // Synchronize React `isOpen` prop with native top-layer <dialog>
  React.useEffect(() => {
    const dialog = dialogRef.current;
    const scroller = scrollerRef.current;
    const sheet = sheetRef.current;
    if (!dialog || !scroller || !sheet) return;

    let cancelled = false;
    let openScrollEndCleanup: (() => void) | null = null;

    if (isOpen) {
      clearFallbackTimer();
      phaseRef.current = 'opening';
      if (!dialog.open) {
        dialog.showModal();
      }

      const openLeft = side === 'start' ? 0 : sheet.offsetWidth;
      const closedLeft = side === 'start' ? sheet.offsetWidth : 0;
      const supportsInitialTarget =
        typeof CSS !== 'undefined' && CSS.supports('scroll-initial-target', 'nearest');

      const startOpenScroll = async () => {
        if (!supportsInitialTarget) {
          scroller.scrollTo({ left: closedLeft, behavior: 'instant' });
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        }
        if (cancelled || !dialog.open) return;

        const markOpenIfSettled = () => {
          if (cancelled || !dialog.open || phaseRef.current !== 'opening') return;
          if (Math.abs(scroller.scrollLeft - openLeft) <= 2) {
            phaseRef.current = 'open';
          }
        };

        if ('onscrollend' in window) {
          scroller.addEventListener('scrollend', markOpenIfSettled, { once: true });
          openScrollEndCleanup = () => scroller.removeEventListener('scrollend', markOpenIfSettled);
        }

        scroller.scrollTo({ left: openLeft, behavior: 'auto' });
        const target = sheet.querySelector<HTMLElement>('[data-autofocus]');
        target?.focus({ preventScroll: true });

        // Instant scroll (e.g., prefers-reduced-motion) may already be at openLeft on next frame
        requestAnimationFrame(() => {
          markOpenIfSettled();
        });
      };

      void startOpenScroll();
    } else if (dialog.open) {
      requestAnimatedClose();
    }

    return () => {
      cancelled = true;
      openScrollEndCleanup?.();
    };
  }, [isOpen, requestAnimatedClose, side]);

  React.useEffect(() => () => clearFallbackTimer(), []);

  return (
    <dialog
      ref={dialogRef}
      id={id}
      data-side={side}
      aria-label={ariaLabel}
      onCancel={(e) => {
        if (e.cancelable) {
          e.preventDefault();
          requestAnimatedClose();
        }
      }}
      onClose={() => {
        clearFallbackTimer();
        phaseRef.current = 'idle';
        if (isOpenRef.current) onCloseRef.current();
      }}
      onClick={(e) => {
        const sheet = sheetRef.current;
        if (sheet && !sheet.contains(e.target as Node)) {
          requestAnimatedClose();
        }
      }}
      className="pc-drawer"
    >
      <div ref={scrollerRef} className="pc-drawer-scroller">
        <div ref={sheetRef} className="pc-drawer-sheet">
          {children}
        </div>
      </div>
    </dialog>
  );
}
