import * as React from 'react';
import {
  ArrowDownUp,
  CornerDownRight,
  ExternalLink,
  Image as ImageIcon,
  ListEnd,
  PencilLine,
  Trash2,
  X,
} from 'lucide-react';
import { PendingQueueState, QueuedMessageItem, QueuedMessageMode } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';

export interface PendingQueueTimingHint {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface PendingQueueTrayProps {
  queue: PendingQueueState;
  timingHint?: PendingQueueTimingHint | null;
  busyItemId?: string | null;
  clearing?: boolean;
  statusAnnouncement?: string;
  onSwitchMode: (item: QueuedMessageItem, nextMode: QueuedMessageMode) => void;
  onRecallItem: (item: QueuedMessageItem) => void;
  onDeleteItem: (item: QueuedMessageItem) => void;
  onClearAll: () => void;
}

function summarizeItemForLabel(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= 24 ? compact : `${compact.slice(0, 24)}…`;
}

export function PendingQueueTray({
  queue,
  timingHint = null,
  busyItemId = null,
  clearing = false,
  statusAnnouncement = '',
  onSwitchMode,
  onRecallItem,
  onDeleteItem,
  onClearAll,
}: PendingQueueTrayProps) {
  const steeringCount = queue.steering.length;
  const followUpCount = queue.followUp.length;
  const totalCount = steeringCount + followUpCount;

  const combinedItems = React.useMemo(
    () => [...queue.steering, ...queue.followUp],
    [queue.steering, queue.followUp]
  );

  if (totalCount === 0) {
    return statusAnnouncement ? (
      <p role="status" aria-live="polite" className="visually-hidden">
        {statusAnnouncement}
      </p>
    ) : null;
  }

  return (
    <div className="mb-2">
      <p role="status" aria-live="polite" className="visually-hidden">
        {statusAnnouncement}
      </p>

      <div className="overflow-hidden rounded-2xl border border-line-strong bg-surface-raised/92 shadow-[var(--shadow-card)] backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/80 bg-well/55 px-3 py-1.5 text-[11px]">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
            <span className="font-semibold text-ink">待投递队列</span>
            {steeringCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-string/30 bg-string-soft px-1.5 py-0.25 text-[10px] font-medium text-string-ink">
                <CornerDownRight className="size-2.5" aria-hidden="true" />
                <span>插话 {steeringCount}</span>
              </span>
            )}
            {followUpCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-voice/30 bg-voice-soft px-1.5 py-0.25 text-[10px] font-medium text-voice">
                <ListEnd className="size-2.5" aria-hidden="true" />
                <span>排队 {followUpCount}</span>
              </span>
            )}
            {timingHint?.text && (
              <span className="truncate text-ink-3" title={timingHint.text}>
                · {timingHint.text}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {timingHint?.actionLabel && timingHint.onAction && (
              <button
                type="button"
                onClick={timingHint.onAction}
                className="inline-flex min-h-6 items-center gap-1 rounded-lg border border-string/30 bg-string-soft/80 px-2 py-0.5 text-[11px] font-medium text-string-ink transition-colors hover:border-string/55 hover:bg-string-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-string cursor-pointer"
              >
                <span>{timingHint.actionLabel}</span>
                <ExternalLink className="size-3" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={onClearAll}
              disabled={clearing}
              aria-label="清空全部待投递消息"
              className="inline-flex min-h-6 items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:bg-well hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-string disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              <X className="size-3" aria-hidden="true" />
              <span>清空</span>
            </button>
          </div>
        </div>

        <ol role="list" className="max-h-36 divide-y divide-line/65 overflow-y-auto px-2 py-1">
          {combinedItems.map((item, idx) => {
            const isSteer = item.mode === 'steer';
            const nextMode: QueuedMessageMode = isSteer ? 'followUp' : 'steer';
            const isBusy = clearing || busyItemId === item.id;
            const snippet = summarizeItemForLabel(item.text);
            return (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs transition-colors hover:bg-well/45"
              >
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                    isSteer
                      ? 'border-string/30 bg-string-soft text-string-ink'
                      : 'border-voice/30 bg-voice-soft text-voice'
                  )}
                >
                  {isSteer ? (
                    <CornerDownRight className="size-2.5" aria-hidden="true" />
                  ) : (
                    <ListEnd className="size-2.5" aria-hidden="true" />
                  )}
                  <span>{isSteer ? '插话' : '排队'}</span>
                </span>

                <span
                  className="min-w-0 flex-1 truncate text-ink"
                  title={item.text}
                >
                  {item.text.replace(/\s+/g, ' ').trim()}
                </span>

                {item.imageCount && item.imageCount > 0 ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-well px-1.5 py-0.5 text-[10px] font-medium text-ink-2"
                    title={`附带 ${item.imageCount} 张图片`}
                  >
                    <ImageIcon className="size-2.5" aria-hidden="true" />
                    <span>{item.imageCount}</span>
                  </span>
                ) : null}

                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onSwitchMode(item, nextMode)}
                    title={isSteer ? '转为排队（本轮做完后顺延）' : '升为插话（本步结束后立即介入）'}
                    aria-label={
                      isSteer
                        ? `将第 ${idx + 1} 条消息「${snippet}」转为排队`
                        : `将第 ${idx + 1} 条消息「${snippet}」升为插话`
                    }
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-[11px] text-ink-3 transition-colors hover:bg-well hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                  >
                    <ArrowDownUp className="size-3" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onRecallItem(item)}
                    title="撤回至输入框编辑"
                    aria-label={`撤回第 ${idx + 1} 条消息「${snippet}」至输入框编辑`}
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-well hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                  >
                    <PencilLine className="size-3" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onDeleteItem(item)}
                    title="删除该待投递消息"
                    aria-label={`删除第 ${idx + 1} 条消息「${snippet}」`}
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                  >
                    <Trash2 className="size-3" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
