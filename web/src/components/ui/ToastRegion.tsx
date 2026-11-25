import * as React from 'react';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';

export interface ToastItem {
  id: string;
  tone: 'success' | 'info' | 'warning' | 'error';
  title: string;
  message: string;
  durationMs?: number;
}

interface ToastRegionProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  suppress?: boolean;
}

interface SingleToastProps {
  toast: ToastItem;
  index: number;
  suppress: boolean;
  onShown: (toast: ToastItem) => void;
  onDismiss: (id: string, viaUserAction: boolean) => void;
}

function SingleToast({ toast, index, suppress, onShown, onDismiss }: SingleToastProps) {
  const domId = React.useId();
  const elRef = React.useRef<HTMLDivElement>(null);
  const shownOnceRef = React.useRef(false);
  const isClosingByEffectRef = React.useRef(false);
  const pausedRef = React.useRef(false);
  const timerRef = React.useRef<number | null>(null);

  const clearDismissTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleDismiss = React.useCallback(() => {
    clearDismissTimer();
    if (suppress || pausedRef.current) return;
    const ms = toast.durationMs ?? 6500;
    if (ms <= 0) return;
    timerRef.current = window.setTimeout(() => {
      const el = elRef.current;
      if (el && el.contains(document.activeElement)) {
        pausedRef.current = true;
        return;
      }
      isClosingByEffectRef.current = true;
      try {
        el?.hidePopover?.();
      } catch {
        // Ignore if already hidden
      }
      onDismiss(toast.id, false);
    }, ms);
  }, [clearDismissTimer, onDismiss, suppress, toast.durationMs, toast.id]);

  React.useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;

    if (suppress) {
      clearDismissTimer();
      return undefined;
    }

    let observer: MutationObserver | null = null;
    const cleanupWaiters = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      document.removeEventListener('close', handleDialogClosed, true);
    };

    const promotePopover = () => {
      if (suppress || !elRef.current) return;
      // Wait for any closing modal <dialog> to finish its exit transition without timer polling
      if (document.querySelector('dialog[open]')) {
        if (!observer && typeof MutationObserver !== 'undefined' && document.body) {
          observer = new MutationObserver(() => {
            if (!document.querySelector('dialog[open]')) {
              cleanupWaiters();
              promotePopover();
            }
          });
          observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['open'],
            childList: true,
            subtree: true,
          });
          document.addEventListener('close', handleDialogClosed, true);
        }
        return;
      }
      cleanupWaiters();
      try {
        if (!elRef.current.matches(':popover-open')) {
          elRef.current.showPopover?.();
        }
      } catch {
        // Ignore browsers without Popover API
      }
      if (!shownOnceRef.current) {
        shownOnceRef.current = true;
        onShown(toast);
      }
      scheduleDismiss();
    };

    function handleDialogClosed() {
      if (!document.querySelector('dialog[open]')) {
        cleanupWaiters();
        promotePopover();
      }
    }

    promotePopover();

    return () => {
      cleanupWaiters();
      clearDismissTimer();
    };
  }, [clearDismissTimer, onShown, scheduleDismiss, suppress, toast]);

  React.useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;

    const handleNativeToggle = (event: Event) => {
      const toggleEv = event as ToggleEvent;
      if (toggleEv.newState === 'closed') {
        clearDismissTimer();
        if (isClosingByEffectRef.current) {
          isClosingByEffectRef.current = false;
          return;
        }
        onDismiss(toast.id, true);
      }
    };

    el.addEventListener('toggle', handleNativeToggle);
    return () => {
      el.removeEventListener('toggle', handleNativeToggle);
    };
  }, [clearDismissTimer, onDismiss, toast.id]);

  const Icon =
    toast.tone === 'success'
      ? CheckCircle2
      : toast.tone === 'warning' || toast.tone === 'error'
        ? CircleAlert
        : Info;

  return (
    <div
      ref={elRef}
      id={domId}
      popover="manual"
      data-tone={toast.tone}
      style={{ '--toast-index': index } as React.CSSProperties}
      onMouseEnter={() => {
        pausedRef.current = true;
        clearDismissTimer();
      }}
      onMouseLeave={() => {
        if (!elRef.current?.contains(document.activeElement)) {
          pausedRef.current = false;
          scheduleDismiss();
        }
      }}
      onFocus={() => {
        pausedRef.current = true;
        clearDismissTimer();
      }}
      onBlur={(e) => {
        const nextFocused = e.relatedTarget as Node | null;
        if (!nextFocused || !elRef.current?.contains(nextFocused)) {
          pausedRef.current = false;
          scheduleDismiss();
        }
      }}
      className="pc-toast p-3.5 text-xs"
    >
      <div className="flex items-start gap-2.5">
        <Icon className="pc-toast-icon mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="font-semibold leading-snug text-ink">{toast.title}</div>
          <div className="leading-relaxed text-ink-2">{toast.message}</div>
        </div>
        <button
          type="button"
          popoverTarget={domId}
          popoverTargetAction="hide"
          aria-label="关闭通知"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-well hover:text-ink cursor-pointer"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function ToastRegion({ toasts, onDismiss, suppress = false }: ToastRegionProps) {
  const regionRef = React.useRef<HTMLDivElement>(null);
  const priorFocusRef = React.useRef<HTMLElement | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = React.useState('');

  React.useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (regionRef.current?.contains(target)) {
        const related = e.relatedTarget as HTMLElement | null;
        if (related && !regionRef.current.contains(related)) {
          priorFocusRef.current = related;
        }
      } else if (!target.closest?.('.pc-toast')) {
        priorFocusRef.current = target;
      }
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, []);

  const handleShown = React.useCallback((toast: ToastItem) => {
    const textOnly = `${toast.title}：${toast.message}`;
    const docAny = document as any;
    if (typeof docAny.ariaNotify === 'function') {
      try {
        docAny.ariaNotify(textOnly);
        return;
      } catch {
        // Fall through to live region
      }
    }
    setLiveAnnouncement(textOnly);
  }, []);

  const handleDismissToast = React.useCallback(
    (id: string, viaUserAction: boolean) => {
      if (viaUserAction) {
        const remainingCloseBtn = regionRef.current?.querySelector<HTMLElement>(
          '.pc-toast:popover-open button[popovertargetaction="hide"]'
        );
        if (remainingCloseBtn) {
          remainingCloseBtn.focus();
        } else if (priorFocusRef.current && priorFocusRef.current.isConnected) {
          priorFocusRef.current.focus();
        }
      }
      onDismiss(id);
    },
    [onDismiss]
  );

  return (
    <div ref={regionRef} role="region" aria-label="系统通知" className="pc-toast-region">
      <p className="visually-hidden">屏幕阅读器通知</p>
      <div aria-live="polite" className="visually-hidden">
        {liveAnnouncement}
      </div>

      {toasts.map((toast, idx) => (
        <SingleToast
          key={toast.id}
          toast={toast}
          index={idx}
          suppress={suppress}
          onShown={handleShown}
          onDismiss={handleDismissToast}
        />
      ))}
    </div>
  );
}
