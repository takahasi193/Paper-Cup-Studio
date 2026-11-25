import * as React from 'react';
import { CircleAlert } from 'lucide-react';
import { CupMark } from '@/components/brand/CupMark.js';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import { CopyButton } from '@/components/ui/CopyButton.js';
import { CharacterRosterFormCard } from './CharacterRosterFormCard.js';
import { CompactionDividerCard } from './CompactionDividerCard.js';
import { ImageLightbox } from './ImageLightbox.js';
import { MarkdownContent } from './MarkdownContent.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { ToolCallGroup } from './ToolCallGroup.js';
import { ChatMessage } from '@/hooks/useAgentStream.js';
import {
  ChatFormRecord,
  SubagentTaskSummary,
  SubmitChatFormItemPayload,
} from '@/lib/api.js';
import { toImageDataUrl } from '@/lib/imageAttachments.js';
import { gsap } from '@/lib/gsap.js';
import { cn } from '@/lib/utils.js';

interface MessageItemProps {
  message: ChatMessage;
  isStreaming?: boolean;
  isThinking?: boolean;
  isTurnBusy?: boolean;
  statusLabel?: string;
  assistantLabel?: string;
  userBadge?: string;
  userBadgeTone?: 'default' | 'steer' | 'followUp';
  motionAllowed?: boolean;
  subagentTasks?: SubagentTaskSummary[];
  onOpenSubagentTask?: (taskId: string, role?: string) => void;
  chatForms?: Record<string, ChatFormRecord>;
  onSubmitChatForm?: (
    formId: string,
    payload: { items: SubmitChatFormItemPayload[]; dismissedNames?: string[]; autoContinue: boolean }
  ) => Promise<void>;
  onCancelChatForm?: (formId: string) => Promise<void>;
}

export const MessageItem = React.memo(function MessageItem({
  message,
  isStreaming = false,
  isThinking = false,
  isTurnBusy = false,
  statusLabel,
  assistantLabel = 'Paper Cup',
  userBadge,
  userBadgeTone,
  motionAllowed = true,
  subagentTasks = [],
  onOpenSubagentTask,
  chatForms,
  onSubmitChatForm,
  onCancelChatForm,
}: MessageItemProps) {
  const articleRef = React.useRef<HTMLElement>(null);
  const avatarRingRef = React.useRef<HTMLSpanElement>(null);
  const cursorRef = React.useRef<HTMLSpanElement>(null);
  const [previewImageIdx, setPreviewImageIdx] = React.useState<number | null>(null);

  // Entry reveal on message mount
  React.useLayoutEffect(() => {
    const el = articleRef.current;
    if (!el) return undefined;

    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from(el, {
        y: 8,
        opacity: 0,
        duration: 0.26,
        ease: 'power2.out',
        clearProps: 'transform,opacity',
      });
    });
    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.from(el, {
        opacity: 0,
        duration: 0.1,
        clearProps: 'opacity',
      });
    });
    return () => mm.revert();
  }, []);

  // Acoustic halo ripple around CupMark while streaming
  React.useLayoutEffect(() => {
    if (!isStreaming || !motionAllowed || !avatarRingRef.current) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        avatarRingRef.current,
        { scale: 0.94, opacity: 0.72 },
        {
          scale: 1.24,
          opacity: 0,
          duration: 1.5,
          repeat: -1,
          ease: 'power2.out',
        }
      );
    });
    return () => ctx.revert();
  }, [isStreaming, motionAllowed]);

  // Streaming cursor pulse
  const hasContent = Boolean(message.content);
  React.useLayoutEffect(() => {
    if (!isStreaming || isThinking || !hasContent || !cursorRef.current) {
      return undefined;
    }
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      if (!cursorRef.current) return;
      gsap.to(cursorRef.current, {
        opacity: 0.25,
        scaleY: 0.8,
        duration: 0.52,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
    });
    return () => mm.revert();
  }, [isStreaming, isThinking, hasContent]);

  if (message.role === 'user') {
    const resolvedBadge =
      userBadge ??
      (message.deliveryMode === 'steer'
        ? '插话'
        : message.deliveryMode === 'followUp'
          ? '排队'
          : undefined);
    const resolvedTone =
      userBadgeTone ??
      (message.deliveryMode === 'steer'
        ? 'steer'
        : message.deliveryMode === 'followUp'
          ? 'followUp'
          : 'default');
    const userImages = Array.isArray(message.images) ? message.images : [];
    return (
      <article
        ref={articleRef}
        className="pc-reveal-row flex flex-col items-end gap-1.5"
        aria-label="你的消息"
      >
        {resolvedBadge && (
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-medium',
              resolvedTone === 'followUp'
                ? 'border-voice/30 bg-voice-soft text-voice'
                : 'border-string/30 bg-string-soft/75 text-string-ink'
            )}
          >
            {resolvedBadge}
          </span>
        )}
        <div className="max-w-[min(86%,38rem)] rounded-2xl rounded-br-sm border border-line-strong bg-surface-raised px-4 py-2.5 text-[0.9375rem] leading-7 text-ink whitespace-pre-wrap break-words shadow-[var(--shadow-card)]">
          {userImages.length > 0 && (
            <div className={cn('flex flex-wrap gap-2', message.content ? 'mb-2' : '')}>
              {userImages.map((img, idx) => {
                const src = toImageDataUrl(img);
                return (
                  <button
                    key={`${idx}-${img.name || img.mimeType}`}
                    type="button"
                    onClick={() => setPreviewImageIdx(idx)}
                    aria-label={`放大查看图片 ${idx + 1}${img.name ? `：${img.name}` : ''}`}
                    className="overflow-hidden rounded-xl border border-line bg-well/60 transition-colors hover:border-string focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-string cursor-pointer"
                  >
                    {src ? (
                      <img
                        src={src}
                        alt={img.name || `用户图片 ${idx + 1}`}
                        className="max-h-44 max-w-[14rem] object-cover"
                      />
                    ) : (
                      <span className="flex h-20 w-24 items-center justify-center text-xs text-ink-3">
                        图片不可用
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {message.content}
        </div>
        {userImages.length > 0 && (
          <ImageLightbox
            images={userImages}
            activeIndex={previewImageIdx}
            onChangeIndex={setPreviewImageIdx}
          />
        )}
        <div className="flex items-center gap-2 px-1">
          {message.timestamp && (
            <time className="pc-reveal-action font-mono text-[11px] text-ink-3">
              {message.timestamp}
            </time>
          )}
          {message.content && (
            <CopyButton
              getText={() => message.content}
              ariaLabel="复制我的消息"
              compact
              className="pc-reveal-action"
            />
          )}
        </div>
      </article>
    );
  }

  if (message.role === 'compaction') {
    return (
      <article ref={articleRef} className="w-full" aria-label="上下文已压缩">
        <CompactionDividerCard message={message} />
      </article>
    );
  }

  const hasTools = Boolean(message.tools && message.tools.length > 0);
  const linkedChatForms = React.useMemo(() => {
    if (!message.tools?.length) return [];
    const seen = new Set<string>();
    const out: ChatFormRecord[] = [];
    for (const t of message.tools) {
      const details =
        t.result && typeof t.result === 'object' ? (t.result as Record<string, any>).details : null;
      const formId = typeof details?.chatFormId === 'string' ? details.chatFormId : '';
      if (!formId || seen.has(formId)) continue;
      seen.add(formId);
      const live = chatForms?.[formId];
      const fallback = details?.chatForm as ChatFormRecord | undefined;
      if (live) out.push(live);
      else if (fallback?.formId) out.push(fallback);
    }
    return out;
  }, [message.tools, chatForms]);
  const isEmpty = !message.content && !message.thinking && !hasTools && linkedChatForms.length === 0;

  return (
    <article
      ref={articleRef}
      className="pc-reveal-row flex items-start gap-3.5"
      aria-label={`${assistantLabel} 的回复`}
      aria-busy={isStreaming || undefined}
    >
      <div
        className={cn(
          'relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border bg-surface-raised shadow-[var(--shadow-card)]',
          isStreaming ? 'border-string' : 'border-line-strong'
        )}
        aria-hidden="true"
      >
        <CupMark className="size-5" />
        {isStreaming && motionAllowed && (
          <span
            ref={avatarRingRef}
            className="pointer-events-none absolute -inset-1 rounded-2xl border border-string/60"
          />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2.5">
        <header className="flex min-h-7 flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-ink">{assistantLabel}</span>
          {isStreaming ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-string/35 bg-string-soft px-2 py-0.5 font-medium text-string-ink">
              <PixelCupLoader className="text-string" />
              <span>{statusLabel}</span>
            </span>
          ) : (
            <>
              {message.timestamp && (
                <time className="pc-reveal-action font-mono text-[11px] text-ink-3">
                  {message.timestamp}
                </time>
              )}
              {message.content && (
                <CopyButton
                  getText={() => message.content}
                  ariaLabel="复制助手回复"
                  compact
                  className="pc-reveal-action"
                />
              )}
            </>
          )}
        </header>

        {message.thinking && (
          <ThinkingBlock thinking={message.thinking} isStreaming={isStreaming && isThinking} />
        )}

        {hasTools && (
          <ToolCallGroup
            tools={message.tools!}
            subagentTasks={subagentTasks}
            onOpenSubagentTask={onOpenSubagentTask}
          />
        )}

        {message.error && message.content ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-sm leading-6 text-danger"
          >
            <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <span className="whitespace-pre-wrap break-words">{message.content}</span>
          </div>
        ) : message.content ? (
          <div className="max-w-[70ch] text-[0.9375rem] leading-7 text-ink">
            <MarkdownContent content={message.content} isStreaming={isStreaming} />
            {isStreaming && !isThinking && (
              <span ref={cursorRef} className="pc-stream-cursor mt-1" aria-hidden="true" />
            )}
          </div>
        ) : (
          isStreaming &&
          isEmpty && (
            <div className="flex h-7 items-center gap-2 text-xs text-ink-3">
              <PixelCupLoader className="text-string" label="等待回复" />
              <span>{statusLabel || '连接网关中…'}</span>
            </div>
          )
        )}

        {linkedChatForms.length > 0 && onSubmitChatForm && (
          <div className="space-y-3">
            {linkedChatForms.map((form) => (
              <CharacterRosterFormCard
                key={form.formId}
                form={form}
                isTurnBusy={isTurnBusy}
                onSubmitForm={onSubmitChatForm}
                onCancelForm={onCancelChatForm}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
});
