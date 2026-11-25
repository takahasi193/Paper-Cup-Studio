import * as React from 'react';
import { ChevronRight, FileText, Minimize2 } from 'lucide-react';
import { CopyButton } from '@/components/ui/CopyButton.js';
import { ChatMessage } from '@/hooks/useAgentStream.js';
import { CompactionReason } from '@/lib/api.js';
import { useGsapDetails } from '@/lib/gsap.js';
import { cn } from '@/lib/utils.js';
import { MarkdownContent } from './MarkdownContent.js';

export interface CompactionDividerCardProps {
  message: ChatMessage;
}

export function formatCompactionTokens(value: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
}

export function getCompactionReasonMeta(reason?: CompactionReason): {
  label: string;
  badgeClassName: string;
} {
  switch (reason) {
    case 'manual':
      return {
        label: '手动',
        badgeClassName: 'border-voice/30 bg-voice-soft text-voice',
      };
    case 'overflow':
      return {
        label: '溢出恢复',
        badgeClassName: 'border-warn/35 bg-warn-soft text-warn',
      };
    case 'threshold':
    default:
      return {
        label: '自动阈值',
        badgeClassName: 'border-line bg-surface-raised text-ink-2',
      };
  }
}

function summarizeFocus(focus?: string): string {
  if (!focus) return '';
  const compact = focus.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length <= 36 ? compact : `${compact.slice(0, 36)}…`;
}

export function CompactionDividerCard({ message }: CompactionDividerCardProps) {
  const [open, setOpen] = React.useState(false);
  const { detailsRef, bodyRef, chevronRef, handleSummaryClick, handleToggle } = useGsapDetails({
    onOpenChange: setOpen,
  });

  const meta = message.compaction;
  const reasonMeta = getCompactionReasonMeta(meta?.reason);
  const hasTokenDelta =
    typeof meta?.tokensBefore === 'number' &&
    typeof meta?.tokensAfter === 'number' &&
    Number.isFinite(meta.tokensBefore) &&
    Number.isFinite(meta.tokensAfter) &&
    (meta.tokensBefore > 0 || meta.tokensAfter > 0);
  const focusPreview = summarizeFocus(meta?.focus);
  const summaryText = message.content?.trim() || '';

  return (
    <div className="my-1 w-full">
      <details ref={detailsRef} onToggle={handleToggle} className="pc-details w-full">
        <summary
          onClick={handleSummaryClick}
          className="group flex w-full cursor-pointer list-none items-center gap-2.5 select-none"
        >
          <span className="h-px flex-1 bg-line transition-colors group-hover:bg-line-strong" aria-hidden="true" />
          <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border border-line bg-well/65 px-3 py-1 text-xs text-ink-2 transition-colors group-hover:border-line-strong group-hover:text-ink">
            <Minimize2 className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
            <span className="font-medium text-ink-2 group-hover:text-ink">上下文已压缩</span>
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0.25 text-[10px] font-medium leading-4',
                reasonMeta.badgeClassName
              )}
            >
              {reasonMeta.label}
            </span>
            {hasTokenDelta && (
              <span className="font-mono text-[11px] tabular-nums text-ink-3">
                {formatCompactionTokens(meta!.tokensBefore)} → {formatCompactionTokens(meta!.tokensAfter)}
              </span>
            )}
            {focusPreview && (
              <span
                className="max-w-[14rem] truncate text-[11px] text-ink-3"
                title={meta?.focus}
              >
                · {focusPreview}
              </span>
            )}
            <span className="inline-flex items-center gap-0.5 pl-0.5 text-[11px] text-ink-3">
              <span>{open ? '收起' : '摘要'}</span>
              <ChevronRight
                ref={chevronRef}
                className="pc-chevron size-3.5 shrink-0"
                aria-hidden="true"
              />
            </span>
          </span>
          <span className="h-px flex-1 bg-line transition-colors group-hover:bg-line-strong" aria-hidden="true" />
        </summary>

        <div
          ref={bodyRef}
          className="mt-2.5 rounded-xl border border-line bg-well/45 px-4 py-3 text-xs leading-6 text-ink-2"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-1.5 text-[11px] text-ink-3">
            <div className="flex flex-wrap items-center gap-2">
              {message.timestamp && <time className="font-mono">{message.timestamp}</time>}
              {meta?.focus && (
                <span className="text-ink-2">
                  压缩聚焦：<span className="text-ink">{meta.focus}</span>
                </span>
              )}
            </div>
            {summaryText && (
              <CopyButton getText={() => summaryText} ariaLabel="复制压缩摘要" compact />
            )}
          </div>

          {summaryText ? (
            <div className="pc-scroller max-h-96 overflow-y-auto pr-1 text-[0.8125rem] leading-6 text-ink-2">
              <MarkdownContent content={summaryText} />
            </div>
          ) : (
            <p className="text-ink-3">（无压缩摘要文本）</p>
          )}

          {meta?.checkpointPath && (
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-line/70 pt-2 font-mono text-[11px] text-ink-3 break-all">
              <FileText className="size-3 shrink-0" aria-hidden="true" />
              <span>归档快照：{meta.checkpointPath}</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
