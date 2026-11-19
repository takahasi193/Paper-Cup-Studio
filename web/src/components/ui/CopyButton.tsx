import * as React from 'react';
import { AlertCircle, Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils.js';

let lastCopyAnnouncement = '';

function legacyCopyText(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0;pointer-events:none';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

interface CopyButtonProps {
  getText: () => string;
  ariaLabel?: string;
  idleLabel?: string;
  compact?: boolean;
  className?: string;
}

/** Accessible copy button preserving keyboard focus without disabling after copy. */
export function CopyButton({
  getText,
  ariaLabel = '复制内容',
  idleLabel = '复制',
  compact = false,
  className,
}: CopyButtonProps) {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const [tipText, setTipText] = React.useState('');
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const announce = (ok: boolean) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    let msg = ok ? '已复制' : '复制失败';
    if (msg === lastCopyAnnouncement) {
      msg += '\u00A0';
    }
    lastCopyAnnouncement = msg;

    setCopyState(ok ? 'copied' : 'failed');
    setTipText('');
    requestAnimationFrame(() => {
      setTipText(msg);
    });

    timerRef.current = window.setTimeout(() => {
      setCopyState('idle');
      setTipText('');
      timerRef.current = null;
    }, 2000);
  };

  const handleCopy = async () => {
    const text = getText().trim();
    if (!text) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (!legacyCopyText(text)) {
        throw new Error('Copy failed');
      }
      announce(true);
    } catch {
      if (legacyCopyText(text)) {
        announce(true);
      } else {
        announce(false);
      }
    }
  };

  return (
    <span className={cn('pc-copy', className)}>
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={ariaLabel}
        data-copied={copyState === 'copied' ? '' : undefined}
        data-failed={copyState === 'failed' ? '' : undefined}
        className={cn(
          'pc-copy-btn inline-flex items-center justify-center gap-1 rounded-md border border-line bg-sheet/95 text-[11px] font-medium text-ink-2 transition-colors hover:border-line-strong hover:text-ink cursor-pointer',
          compact ? 'px-1.5 py-0.5' : 'px-2 py-1'
        )}
      >
        {copyState === 'copied' ? (
          <Check className="size-3.5 text-ok" aria-hidden="true" />
        ) : copyState === 'failed' ? (
          <AlertCircle className="size-3.5 text-danger" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {!compact && (
          <span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '失败' : idleLabel}</span>
        )}
      </button>
      <span className="pc-copy-tip" role="status">
        {tipText}
      </span>
    </span>
  );
}
