import * as React from 'react';
import {
  ArrowUp,
  Brain,
  CornerDownRight,
  Cpu,
  ExternalLink,
  Gauge,
  ImagePlus,
  KeyRound,
  ListEnd,
  Minimize2,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import {
  ChatImageAttachment,
  MAX_IMAGES_PER_MESSAGE,
  ModelOption,
  parseSlashCompactCommand,
  PendingQueueState,
  QueuedCompactionInfo,
  QueuedMessageItem,
  QueuedMessageMode,
  SessionTokenUsageSnapshot,
  ThinkingLevel,
  TokenUsageBucket,
} from '@/lib/api.js';
import {
  extractClipboardImageFiles,
  readImageFilesToAttachments,
} from '@/lib/imageAttachments.js';
import { ImageAttachmentStrip } from './ImageAttachmentStrip.js';
import { PendingQueueTimingHint, PendingQueueTray } from './PendingQueueTray.js';
import { gsap } from '@/lib/gsap.js';

export interface DraftInjectionRequest {
  id: string;
  text: string;
  images?: ChatImageAttachment[];
}

interface ComposerProps {
  onSend: (text: string, images?: ChatImageAttachment[]) => Promise<boolean> | boolean | void;
  onQueueSend?: (
    text: string,
    mode: QueuedMessageMode,
    images?: ChatImageAttachment[]
  ) => Promise<boolean> | boolean;
  onCompact?: (focus?: string) => Promise<boolean> | boolean;
  onAbort?: () => void;
  busy?: boolean;
  isMainStreaming?: boolean;
  isCompacting?: boolean;
  queuedCompaction?: QueuedCompactionInfo | null;
  isBlockedByDirectSubagent?: boolean;
  onOpenActiveSubagent?: () => void;
  pendingQueue?: PendingQueueState;
  queueTimingHint?: PendingQueueTimingHint | null;
  queueBusyItemId?: string | null;
  queueClearing?: boolean;
  queueStatusAnnouncement?: string;
  onSwitchQueueMode?: (item: QueuedMessageItem, nextMode: QueuedMessageMode) => void;
  onRecallQueueItem?: (item: QueuedMessageItem) => void;
  onDeleteQueueItem?: (item: QueuedMessageItem) => void;
  onClearQueue?: () => void;
  draftInjection?: DraftInjectionRequest | null;
  onDraftInjectionConsumed?: (id: string) => void;
  motionAllowed?: boolean;
  models?: ModelOption[];
  selectedModel?: string | null;
  onModelChange?: (modelKey: string) => void | Promise<void>;
  switchingModel?: boolean;
  thinkingLevel?: ThinkingLevel;
  availableThinkingLevels?: ThinkingLevel[];
  onThinkingChange?: (level: ThinkingLevel) => void | Promise<void>;
  switchingThinking?: boolean;
  onOpenApiKeyModal?: () => void;
  tokenUsage?: SessionTokenUsageSnapshot | null;
}

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '思考: 关',
  minimal: '思考: 极简',
  low: '思考: 低',
  medium: '思考: 中',
  high: '思考: 高',
  xhigh: '思考: 极高',
  max: '思考: 最大',
};

function formatModelLabel(model: ModelOption): string {
  return model.name && model.name !== model.id
    ? `${model.name} · ${model.provider}`
    : model.key;
}

function formatCompactTokens(value: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
}

function formatExactTokens(value: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  return n.toLocaleString('en-US');
}

function promptTokensOf(bucket?: Pick<TokenUsageBucket, 'input' | 'cacheRead' | 'cacheWrite'> | null): number {
  if (!bucket) return 0;
  return (bucket.input ?? 0) + (bucket.cacheRead ?? 0) + (bucket.cacheWrite ?? 0);
}

const supportsFieldSizing = () =>
  typeof window !== 'undefined' && !!window.CSS?.supports?.('field-sizing', 'content');

const EMPTY_QUEUE: PendingQueueState = { steering: [], followUp: [] };

export function Composer({
  onSend,
  onQueueSend,
  onCompact,
  onAbort,
  busy = false,
  isMainStreaming = false,
  isCompacting = false,
  queuedCompaction = null,
  isBlockedByDirectSubagent = false,
  onOpenActiveSubagent,
  pendingQueue = EMPTY_QUEUE,
  queueTimingHint = null,
  queueBusyItemId = null,
  queueClearing = false,
  queueStatusAnnouncement = '',
  onSwitchQueueMode,
  onRecallQueueItem,
  onDeleteQueueItem,
  onClearQueue,
  draftInjection = null,
  onDraftInjectionConsumed,
  motionAllowed = true,
  models = [],
  selectedModel = null,
  onModelChange,
  switchingModel = false,
  thinkingLevel = 'low',
  availableThinkingLevels = [],
  onThinkingChange,
  switchingThinking = false,
  onOpenApiKeyModal,
  tokenUsage = null,
}: ComposerProps) {
  const [text, setText] = React.useState('');
  const [images, setImages] = React.useState<ChatImageAttachment[]>([]);
  const [imageNotice, setImageNotice] = React.useState<string | null>(null);
  const [isDraggingImage, setIsDraggingImage] = React.useState(false);
  const [queueSubmitting, setQueueSubmitting] = React.useState(false);
  const [idleSubmitting, setIdleSubmitting] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const pulseBarRef = React.useRef<HTMLSpanElement>(null);
  const lastInjectionIdRef = React.useRef<string | null>(null);
  const textareaId = React.useId();
  const modelSelectId = React.useId();
  const thinkingSelectId = React.useId();
  const tokenPopoverId = React.useId();

  const activeModelValue = selectedModel || models[0]?.key || '';
  const selectedOption = models.find((m) => m.key === activeModelValue);
  const modelBlocksImages = images.length > 0 && selectedOption?.supportsImage === false;
  const canQueueWhileStreaming = isMainStreaming && Boolean(onQueueSend) && !queueSubmitting;
  const isTextareaDisabled = isBlockedByDirectSubagent && !isMainStreaming;
  const hasDraft = text.trim().length > 0 || images.length > 0;
  const canSendIdle = hasDraft && !busy && !idleSubmitting && !modelBlocksImages;
  const canSubmitQueue = hasDraft && canQueueWhileStreaming && !modelBlocksImages;

  const cloudInUncached = tokenUsage?.cloud.input ?? 0;
  const cloudCacheRead = tokenUsage?.cloud.cacheRead ?? 0;
  const cloudCacheWrite = tokenUsage?.cloud.cacheWrite ?? 0;
  const cloudIn = promptTokensOf(tokenUsage?.cloud);
  const cloudOut = tokenUsage?.cloud.output ?? 0;
  const cloudTotal = tokenUsage?.cloud.totalTokens ?? 0;
  const currentCloudIn = promptTokensOf(tokenUsage?.currentTurn?.cloud);
  const localIn = tokenUsage?.local.input ?? 0;
  const localOut = tokenUsage?.local.output ?? 0;
  const localTotal = tokenUsage?.local.totalTokens ?? 0;
  const grandTotal = tokenUsage?.total.totalTokens ?? 0;
  const isLive = Boolean(tokenUsage?.currentTurn?.live);
  const translatorMode = tokenUsage?.translatorMode ?? 'cloud_subagent';
  const showLocalSection = translatorMode === 'local_mt' || localTotal > 0;
  const localSharePct = grandTotal > 0 && localTotal > 0 ? Math.round((localTotal / grandTotal) * 100) : 0;

  const cloudRoleRows = tokenUsage
    ? [
        { key: 'main', label: '主会话对话', bucket: tokenUsage.breakdown.main, alwaysShow: true },
        {
          key: 'cloudTranslator',
          label: '云端批译 (translator)',
          bucket: tokenUsage.breakdown.cloudTranslator,
          alwaysShow: false,
        },
        {
          key: 'cloudEscalation',
          label: '失败行升舱修复',
          bucket: tokenUsage.breakdown.cloudEscalation,
          alwaysShow: false,
        },
        {
          key: 'roleChecker',
          label: '角色审校 (role-checker)',
          bucket: tokenUsage.breakdown.roleChecker,
          alwaysShow: false,
        },
        {
          key: 'reverser',
          label: '逆向分析 (reverser)',
          bucket: tokenUsage.breakdown.reverser,
          alwaysShow: false,
        },
        ...(tokenUsage.breakdown.smokeVision
          ? [
              {
                key: 'smokeVision',
                label: '冒烟视觉审查',
                bucket: tokenUsage.breakdown.smokeVision,
                alwaysShow: false,
              },
            ]
          : []),
        {
          key: 'compaction',
          label: '上下文压缩摘要',
          bucket: tokenUsage.breakdown.compaction,
          alwaysShow: false,
        },
        {
          key: 'otherSubagents',
          label: '其他子代理 / 工具',
          bucket: tokenUsage.breakdown.otherSubagents,
          alwaysShow: false,
        },
      ].filter((row) => row.alwaysShow || row.bucket.totalTokens > 0 || row.bucket.calls > 0)
    : [];

  React.useLayoutEffect(() => {
    const bar = pulseBarRef.current;
    if (!busy || !bar) return undefined;

    if (!motionAllowed) {
      gsap.set(bar, { xPercent: 80 });
      return undefined;
    }

    const ctx = gsap.context(() => {
      gsap.fromTo(
        bar,
        { xPercent: -110 },
        {
          xPercent: 280,
          duration: 1.35,
          repeat: -1,
          ease: 'power1.inOut',
        }
      );
    });
    return () => ctx.revert();
  }, [busy, motionAllowed]);

  const syncHeight = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el || supportsFieldSizing()) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  }, []);

  const resetHeight = () => {
    if (textareaRef.current && !supportsFieldSizing()) {
      textareaRef.current.style.height = 'auto';
    }
  };

  React.useEffect(() => {
    if (!draftInjection) return;
    const hasText = Boolean(draftInjection.text.trim());
    const injectedImages = Array.isArray(draftInjection.images) ? draftInjection.images : [];
    if (!hasText && injectedImages.length === 0) return;
    if (lastInjectionIdRef.current === draftInjection.id) return;
    lastInjectionIdRef.current = draftInjection.id;
    if (hasText) {
      setText((prev) => {
        const cleaned = draftInjection.text.trim();
        if (!prev.trim()) return cleaned;
        return `${prev.trimEnd()}\n\n${cleaned}`;
      });
    }
    if (injectedImages.length > 0) {
      setImages((prev) => [...prev, ...injectedImages].slice(0, MAX_IMAGES_PER_MESSAGE));
    }
    onDraftInjectionConsumed?.(draftInjection.id);
    requestAnimationFrame(() => {
      syncHeight();
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          // Ignore selection error
        }
      }
    });
  }, [draftInjection, onDraftInjectionConsumed, syncHeight]);

  const appendIncomingImages = React.useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const { added, errors } = await readImageFilesToAttachments(files, images);
      if (added.length > 0) {
        setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES_PER_MESSAGE));
      }
      setImageNotice(errors.length > 0 ? errors[0] : null);
    },
    [images]
  );

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = extractClipboardImageFiles(e.clipboardData);
    if (pastedImages.length === 0) return;
    const hasPlainText = Boolean(e.clipboardData?.getData('text/plain')?.trim());
    if (!hasPlainText) {
      e.preventDefault();
    }
    void appendIncomingImages(pastedImages);
  };

  const handleDrop = (e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsDraggingImage(false);
    if (isTextareaDisabled) return;
    const dropped = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
      f.type.toLowerCase().startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(f.name)
    );
    if (dropped.length > 0) {
      void appendIncomingImages(dropped);
    }
  };

  const clearSubmittedDraft = React.useCallback((submittedRaw: string) => {
    let clearedAll = false;
    setText((current) => {
      if (current === submittedRaw) {
        clearedAll = true;
        return '';
      }
      if (submittedRaw && current.startsWith(submittedRaw)) {
        const remainder = current.slice(submittedRaw.length).replace(/^\n+/, '');
        clearedAll = remainder.length === 0;
        return remainder;
      }
      return current;
    });
    setImages([]);
    setImageNotice(null);
    if (clearedAll) {
      resetHeight();
    }
  }, []);

  const submitQueued = async (mode: QueuedMessageMode) => {
    if (!canSubmitQueue || !onQueueSend) return;
    const rawSnapshot = text;
    const trimmed = rawSnapshot.trim();
    const attached = images.length > 0 ? [...images] : undefined;
    if (!trimmed && !attached) return;
    const compactCmd = !attached ? parseSlashCompactCommand(trimmed) : null;
    if (compactCmd && onCompact) {
      setQueueSubmitting(true);
      try {
        const ok = await onCompact(compactCmd.focus);
        if (ok) {
          clearSubmittedDraft(rawSnapshot);
        }
      } finally {
        setQueueSubmitting(false);
      }
      return;
    }
    setQueueSubmitting(true);
    try {
      const ok = await onQueueSend(trimmed, mode, attached);
      if (ok) {
        clearSubmittedDraft(rawSnapshot);
      }
    } finally {
      setQueueSubmitting(false);
    }
  };

  const submit = async () => {
    if (isMainStreaming) {
      await submitQueued('steer');
      return;
    }
    if (!canSendIdle) return;
    const rawSnapshot = text;
    const trimmed = rawSnapshot.trim();
    const attached = images.length > 0 ? [...images] : undefined;
    if (!trimmed && !attached) return;
    const compactCmd = !attached ? parseSlashCompactCommand(trimmed) : null;
    if (compactCmd && onCompact) {
      setIdleSubmitting(true);
      try {
        const ok = await onCompact(compactCmd.focus);
        if (ok) {
          clearSubmittedDraft(rawSnapshot);
        }
      } finally {
        setIdleSubmitting(false);
      }
      return;
    }
    setIdleSubmitting(true);
    try {
      const result = await onSend(trimmed, attached);
      if (result !== false) {
        clearSubmittedDraft(rawSnapshot);
      }
    } finally {
      setIdleSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (isMainStreaming) {
        e.preventDefault();
        if (e.altKey) {
          void submitQueued('followUp');
        } else {
          void submitQueued('steer');
        }
        return;
      }
      if (!e.altKey) {
        e.preventDefault();
        submit();
      }
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (!supportsFieldSizing()) {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 208)}px`;
    }
  };

  return (
    <div className="mx-auto w-full max-w-[48rem]">
      {onSwitchQueueMode && onRecallQueueItem && onDeleteQueueItem && onClearQueue && (
        <PendingQueueTray
          queue={pendingQueue}
          timingHint={queueTimingHint}
          busyItemId={queueBusyItemId}
          clearing={queueClearing}
          statusAnnouncement={queueStatusAnnouncement}
          onSwitchMode={onSwitchQueueMode}
          onRecallItem={onRecallQueueItem}
          onDeleteItem={onDeleteQueueItem}
          onClearAll={onClearQueue}
        />
      )}

      {isCompacting && (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-well/75 px-3 py-1.5 text-[11px] text-ink-2"
        >
          <PixelCupLoader className="text-string" />
          <span className="font-medium text-ink">正在压缩上下文…</span>
        </div>
      )}

      {queuedCompaction && !isCompacting && (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-well/75 px-3 py-1.5 text-[11px] text-ink-2"
        >
          <Minimize2 className="size-3.5 shrink-0 text-string" aria-hidden="true" />
          <span className="font-medium text-ink">本轮结束后将自动执行 /compact</span>
          {queuedCompaction.focus && (
            <span className="min-w-0 truncate text-ink-3" title={queuedCompaction.focus}>
              · {queuedCompaction.focus}
            </span>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !isTextareaDisabled) textareaRef.current?.focus();
        }}
        onDragOver={(e) => {
          if (isTextareaDisabled) return;
          if (e.dataTransfer?.types?.includes('Files')) {
            e.preventDefault();
            setIsDraggingImage(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDraggingImage(false);
          }
        }}
        onDrop={handleDrop}
        className={`relative overflow-hidden rounded-[22px] border bg-surface-raised/95 backdrop-blur-md shadow-[var(--shadow-float)] transition-[border-color,box-shadow] focus-within:border-string focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--string)_14%,transparent),var(--shadow-float)] ${
          isDraggingImage ? 'border-string ring-2 ring-string/25' : 'border-line-strong'
        }`}
      >
        {busy && (
          <div className="pc-string-pulse" aria-hidden="true">
            <span ref={pulseBarRef} className="pc-string-pulse-bar" />
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="visually-hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const chosen = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            if (chosen.length > 0) {
              void appendIncomingImages(chosen);
            }
          }}
        />

        <ImageAttachmentStrip
          images={images}
          disabled={idleSubmitting || queueSubmitting}
          modelSupportsImage={selectedOption?.supportsImage}
          modelLabel={selectedOption?.name || selectedOption?.id || activeModelValue || null}
          onRemove={(idx) => {
            setImages((prev) => prev.filter((_, i) => i !== idx));
            setImageNotice(null);
          }}
        />

        {imageNotice && (
          <div
            role="status"
            className="border-b border-line/60 bg-danger-soft/70 px-4 py-1.5 text-[11px] text-danger"
          >
            {imageNotice}
          </div>
        )}

        <label htmlFor={textareaId} className="visually-hidden">
          {isMainStreaming ? '向运行中的 Agent 发送插话或排队指令' : '向 Agent 发送指令'}
        </label>
        <textarea
          ref={textareaRef}
          id={textareaId}
          name="prompt"
          value={text}
          disabled={isTextareaDisabled}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            isMainStreaming
              ? '运行中可随时插话纠偏…（Enter 插话 · Alt+Enter 排队 · 可粘贴截图）'
              : isCompacting
                ? '正在压缩上下文…'
                : isBlockedByDirectSubagent
                  ? '子代理直接对话运行中，请前往子代理面板插话或停止…'
                  : '传达你的语言…（解包、排查 QA、翻译调度、可粘贴/拖拽截图排查问题）'
          }
          rows={1}
          aria-label={isMainStreaming ? '向运行中的 Agent 发送插话或排队指令' : '向 Agent 发送指令'}
          className="pc-textarea block w-full bg-transparent px-4 pt-3.5 pb-1.5 text-[0.9375rem] leading-6 text-ink placeholder:text-ink-3 focus:outline-none disabled:cursor-not-allowed disabled:opacity-65"
        />

        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isTextareaDisabled || images.length >= MAX_IMAGES_PER_MESSAGE}
              aria-label="附加图片截图"
              title={
                images.length >= MAX_IMAGES_PER_MESSAGE
                  ? `最多附加 ${MAX_IMAGES_PER_MESSAGE} 张图片`
                  : '附加图片（支持 Ctrl+V 粘贴或拖拽上传）'
              }
              className="inline-flex size-7 items-center justify-center rounded-xl border border-line bg-well/75 text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              <ImagePlus className="size-3.5" aria-hidden="true" />
            </button>
          {models.length > 0 && onModelChange ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <div className="flex min-w-0 items-center gap-1 rounded-xl border border-line bg-well/75 px-2.5 py-0.5 text-xs text-ink-2">
                <Sparkles className="size-3.5 shrink-0 text-string" aria-hidden="true" />
                <label htmlFor={modelSelectId} className="visually-hidden">
                  选择对话模型
                </label>
                <select
                  id={modelSelectId}
                  name="model"
                  value={activeModelValue}
                  disabled={busy || switchingModel}
                  title={selectedOption ? `当前模型：${selectedOption.key}` : '选择对话模型'}
                  onChange={(e) => onModelChange(e.target.value)}
                  className="pc-select max-w-[44vw] truncate rounded py-0.5 pr-1 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[15rem] cursor-pointer"
                >
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>
                      {formatModelLabel(m)}
                    </option>
                  ))}
                </select>
              </div>

              {availableThinkingLevels.length > 0 && onThinkingChange && (
                <div className="flex shrink-0 items-center gap-1 rounded-xl border border-line bg-well/75 px-2.5 py-0.5 text-xs text-ink-2">
                  <Brain className="size-3.5 shrink-0 text-string" aria-hidden="true" />
                  <label htmlFor={thinkingSelectId} className="visually-hidden">
                    思考深度
                  </label>
                  <select
                    id={thinkingSelectId}
                    name="thinking"
                    value={thinkingLevel}
                    disabled={busy || switchingThinking}
                    title="调整主会话思考深度"
                    onChange={(e) => onThinkingChange(e.target.value as ThinkingLevel)}
                    className="pc-select rounded py-0.5 pr-1 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                  >
                    {availableThinkingLevels.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {THINKING_LABELS[lvl] ?? lvl}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {onOpenApiKeyModal && (
                <button
                  type="button"
                  onClick={onOpenApiKeyModal}
                  disabled={busy}
                  aria-label="配置 API Key"
                  title="配置 API Key"
                  className="inline-flex size-7 items-center justify-center rounded-xl border border-line bg-well/75 text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                >
                  <KeyRound className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          ) : onOpenApiKeyModal ? (
            <button
              type="button"
              onClick={onOpenApiKeyModal}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl border border-string/40 bg-string-soft px-3 py-1 text-xs font-medium text-string-ink transition-colors hover:border-string disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              <KeyRound className="size-3.5" aria-hidden="true" />
              <span>配置 API Key</span>
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-1 text-xs text-ink-3">
              <Sparkles className="size-3.5 text-string" aria-hidden="true" />
              <span className="font-mono">{selectedModel || 'Pi Agent'}</span>
            </span>
          )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {!busy ? (
              <span className="hidden text-[11px] text-ink-3 lg:inline">
                Enter 发送 · Shift+Enter 换行 · /compact 压缩
              </span>
            ) : isMainStreaming ? (
              <span className="hidden text-[11px] text-ink-3 xl:inline">
                Enter 插话 · Alt+Enter 排队
              </span>
            ) : null}

            <button
              type="button"
              popoverTarget={tokenPopoverId}
              aria-label={`查看实时 Token 消耗明细：云端输入 ${formatExactTokens(cloudIn)}，输出 ${formatExactTokens(cloudOut)}${localTotal > 0 ? `，本地总计 ${formatExactTokens(localTotal)}` : ''}`}
              title={`本会话 Token 消耗｜云端 入 ${formatExactTokens(cloudIn)} / 出 ${formatExactTokens(cloudOut)}${localTotal > 0 ? ` ｜ 本地 ${formatExactTokens(localTotal)}` : ''}（点击查看明细）`}
              className="inline-flex h-7 items-center gap-1.5 rounded-xl border border-line bg-well/75 px-2 font-mono text-[11px] tabular-nums text-ink-2 transition-colors hover:border-line-strong hover:text-ink cursor-pointer"
            >
              {busy || isLive ? (
                <span className="size-1.5 shrink-0 rounded-full bg-string animate-pulse" aria-hidden="true" />
              ) : (
                <Gauge className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
              )}
              <span>
                入 {formatCompactTokens(cloudIn)} · 出 {isLive ? '~' : ''}
                {formatCompactTokens(cloudOut)}
              </span>
              {localTotal > 0 && (
                <span className="inline-flex items-center gap-0.5 rounded-md bg-ok-soft px-1 py-0.25 text-[10px] font-medium text-ok">
                  <Cpu className="size-2.5" aria-hidden="true" />
                  本地 {formatCompactTokens(localTotal)}
                </span>
              )}
            </button>

            <div
              id={tokenPopoverId}
              popover="auto"
              aria-label="本会话 Token 消耗明细"
              className="pc-token-popover text-xs"
            >
              <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-line pb-2">
                <div className="flex items-center gap-1.5">
                  <Gauge className="size-3.5 text-string" aria-hidden="true" />
                  <span className="font-semibold text-ink">Token 消耗统计</span>
                  {(busy || isLive) && (
                    <span className="rounded-full bg-string-soft px-1.5 py-0.5 text-[10px] font-medium text-string-ink">
                      实时计数中
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      translatorMode === 'local_mt'
                        ? 'bg-ok-soft text-ok'
                        : 'bg-string-soft text-string-ink'
                    }`}
                  >
                    {translatorMode === 'local_mt' ? '本地 MT' : '云端 Subagent'}
                  </span>
                  <button
                    type="button"
                    popoverTarget={tokenPopoverId}
                    popoverTargetAction="hide"
                    aria-label="关闭 Token 明细"
                    className="inline-flex size-5 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-well hover:text-ink cursor-pointer"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="rounded-xl border border-line bg-well/55 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="font-medium text-ink">云端 API（计费额度）</span>
                    {tokenUsage && tokenUsage.cloudCostUsd > 0 && (
                      <span className="font-mono text-[11px] tabular-nums text-string-ink">
                        ≈ ${tokenUsage.cloudCostUsd.toFixed(4)}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px] tabular-nums">
                    <div className="rounded-lg bg-surface-raised/80 px-2 py-1">
                      <div className="text-[10px] text-ink-3">输入</div>
                      <div className="font-semibold text-ink">{formatExactTokens(cloudIn)}</div>
                    </div>
                    <div className="rounded-lg bg-surface-raised/80 px-2 py-1">
                      <div className="text-[10px] text-ink-3">输出</div>
                      <div className="font-semibold text-ink">
                        {isLive ? '~' : ''}
                        {formatExactTokens(cloudOut)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-surface-raised/80 px-2 py-1">
                      <div className="text-[10px] text-ink-3">合计</div>
                      <div className="font-semibold text-ink">{formatExactTokens(cloudTotal)}</div>
                    </div>
                  </div>
                  {(cloudCacheRead > 0 || cloudCacheWrite > 0) && (
                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
                      <span>未缓存 {formatExactTokens(cloudInUncached)}</span>
                      <span className="font-mono tabular-nums">
                        缓存读 {formatExactTokens(cloudCacheRead)} · 写 {formatExactTokens(cloudCacheWrite)}
                      </span>
                    </div>
                  )}

                  {cloudRoleRows.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-line/70 pt-2">
                      {cloudRoleRows.map((row) => (
                        <div
                          key={row.key}
                          className="flex items-center justify-between gap-2 text-[11px] text-ink-2"
                        >
                          <span className="truncate">{row.label}</span>
                          <span className="shrink-0 font-mono tabular-nums text-ink-3">
                            {formatExactTokens(promptTokensOf(row.bucket))} / {formatExactTokens(row.bucket.output)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {showLocalSection && (
                  <div className="rounded-xl border border-line bg-ok-soft/45 p-2.5">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 font-medium text-ink">
                        <Cpu className="size-3 text-ok" aria-hidden="true" />
                        本地模型（0 API 费用）
                      </span>
                      {tokenUsage?.local.estimated && (
                        <span className="rounded bg-surface-raised/80 px-1.5 py-0.5 text-[10px] text-ink-3">
                          含本地估算
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px] tabular-nums">
                      <div className="rounded-lg bg-surface-raised/80 px-2 py-1">
                        <div className="text-[10px] text-ink-3">输入</div>
                        <div className="font-semibold text-ink">{formatExactTokens(localIn)}</div>
                      </div>
                      <div className="rounded-lg bg-surface-raised/80 px-2 py-1">
                        <div className="text-[10px] text-ink-3">输出</div>
                        <div className="font-semibold text-ink">{formatExactTokens(localOut)}</div>
                      </div>
                      <div className="rounded-lg bg-surface-raised/80 px-2 py-1">
                        <div className="text-[10px] text-ink-3">合计</div>
                        <div className="font-semibold text-ink">{formatExactTokens(localTotal)}</div>
                      </div>
                    </div>
                    {localSharePct > 0 && (
                      <div className="mt-1.5 text-[11px] text-ok">
                        本地模型已分担本会话 {localSharePct}% 的总 Token 吞吐量
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1 border-t border-line pt-2 text-[11px] text-ink-2">
                  <div className="flex items-center justify-between gap-2">
                    <span>本轮增量 (云端)</span>
                    <span className="font-mono tabular-nums text-ink">
                      入 {formatExactTokens(currentCloudIn)} / 出{' '}
                      {isLive ? '~' : ''}
                      {formatExactTokens(tokenUsage?.currentTurn.cloud.output ?? 0)}
                    </span>
                  </div>
                  {(tokenUsage?.currentTurn.local.totalTokens ?? 0) > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <span>本轮增量 (本地)</span>
                      <span className="font-mono tabular-nums text-ok">
                        入 {formatExactTokens(tokenUsage?.currentTurn.local.input ?? 0)} / 出{' '}
                        {formatExactTokens(tokenUsage?.currentTurn.local.output ?? 0)}
                      </span>
                    </div>
                  )}
                  {tokenUsage?.contextUsage && tokenUsage.contextUsage.tokens !== null && (
                    <>
                      <div className="flex items-center justify-between gap-2 text-ink-3">
                        <span>Pi 当前上下文窗口</span>
                        <span className="font-mono tabular-nums">
                          {formatCompactTokens(tokenUsage.contextUsage.tokens)} /{' '}
                          {formatCompactTokens(tokenUsage.contextUsage.contextWindow)}
                          {tokenUsage.contextUsage.percent !== null
                            ? ` (${tokenUsage.contextUsage.percent.toFixed(1)}%)`
                            : ''}
                        </span>
                      </div>
                      {typeof tokenUsage.contextUsage.triggerTokens === 'number' &&
                        Number.isFinite(tokenUsage.contextUsage.triggerTokens) &&
                        tokenUsage.contextUsage.triggerTokens > 0 &&
                        tokenUsage.contextUsage.triggerTokens < tokenUsage.contextUsage.contextWindow && (
                          <div
                            className="flex items-center justify-between gap-2 text-ink-3"
                            title={`当前上下文 ${formatExactTokens(tokenUsage.contextUsage.tokens)} / 自动压缩触发线 ${formatExactTokens(tokenUsage.contextUsage.triggerTokens)}（模型物理窗口 ${formatExactTokens(tokenUsage.contextUsage.contextWindow)}）`}
                          >
                            <span>自动压缩触发线</span>
                            <span className="font-mono tabular-nums">
                              {formatCompactTokens(tokenUsage.contextUsage.triggerTokens)} (
                              {Math.min(
                                100,
                                Math.max(
                                  0,
                                  (tokenUsage.contextUsage.tokens /
                                    tokenUsage.contextUsage.triggerTokens) *
                                    100
                                )
                              ).toFixed(0)}
                              %)
                            </span>
                          </div>
                        )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {isMainStreaming ? (
              <div className="flex items-center gap-1.5">
                {onAbort && (
                  <button
                    type="button"
                    onClick={onAbort}
                    aria-label="停止执行"
                    title="停止当前执行"
                    className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-danger/35 bg-danger-soft px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger cursor-pointer"
                  >
                    <Square className="size-3 fill-current" aria-hidden="true" />
                    <span>停止</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canSubmitQueue}
                  onClick={() => void submitQueued('followUp')}
                  aria-label="排入队尾（本轮完成后顺延执行）"
                  title="排队 Follow-up (Alt+Enter)：本轮完成后顺延执行"
                  className="inline-flex h-8 items-center gap-1 rounded-xl border border-voice/35 bg-voice-soft px-2.5 text-xs font-medium text-voice transition-colors hover:border-voice/60 disabled:cursor-not-allowed disabled:border-line disabled:bg-well disabled:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-voice cursor-pointer"
                >
                  <ListEnd className="size-3.5" aria-hidden="true" />
                  <span>排队</span>
                </button>
                <button
                  type="submit"
                  disabled={!canSubmitQueue}
                  aria-label="实时插话（本步结束后立即介入）"
                  title="插话 Steer (Enter)：本步/工具完成后立即介入"
                  className="inline-flex h-8 items-center gap-1 rounded-xl bg-string px-3 text-xs font-medium text-on-string shadow-xs transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border disabled:border-line disabled:bg-well disabled:text-ink-3 disabled:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-string cursor-pointer"
                >
                  <CornerDownRight className="size-3.5" aria-hidden="true" />
                  <span>插话</span>
                </button>
              </div>
            ) : isBlockedByDirectSubagent ? (
              <div className="flex items-center gap-1.5">
                {onOpenActiveSubagent && (
                  <button
                    type="button"
                    onClick={onOpenActiveSubagent}
                    className="inline-flex h-8 items-center gap-1 rounded-xl border border-string/35 bg-string-soft px-2.5 text-xs font-medium text-string-ink transition-colors hover:border-string cursor-pointer"
                  >
                    <span>前往子代理插话</span>
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </button>
                )}
                {onAbort && (
                  <button
                    type="button"
                    onClick={onAbort}
                    aria-label="停止子代理执行"
                    title="停止当前子代理执行"
                    className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-danger px-3 text-xs font-medium text-on-string shadow-xs transition-opacity hover:opacity-90 cursor-pointer"
                  >
                    <Square className="size-3 fill-current" aria-hidden="true" />
                    <span>停止</span>
                  </button>
                )}
              </div>
            ) : (
              <button
                type="submit"
                disabled={!canSendIdle}
                aria-label={busy ? 'Agent 运行中' : '发送'}
                title="发送 (Enter)"
                className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-string px-3.5 text-xs font-medium text-on-string shadow-xs transition-[background-color,color,border-color,opacity] hover:opacity-90 disabled:cursor-not-allowed disabled:border disabled:border-line disabled:bg-well disabled:text-ink-3 disabled:shadow-none cursor-pointer"
              >
                {busy ? (
                  <progress className="pc-spinner text-on-string" aria-hidden="true" />
                ) : (
                  <ArrowUp className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
                )}
                <span>发送</span>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
