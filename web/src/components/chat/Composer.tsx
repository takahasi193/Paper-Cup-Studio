import * as React from 'react';
import { ArrowUp, Brain, KeyRound, Sparkles, Square } from 'lucide-react';
import { ModelOption, ThinkingLevel } from '@/lib/api.js';
import { gsap } from '@/lib/gsap.js';

interface ComposerProps {
  onSend: (text: string) => void;
  onAbort?: () => void;
  busy?: boolean;
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

const supportsFieldSizing = () =>
  typeof window !== 'undefined' && !!window.CSS?.supports?.('field-sizing', 'content');

export function Composer({
  onSend,
  onAbort,
  busy = false,
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
}: ComposerProps) {
  const [text, setText] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const pulseBarRef = React.useRef<HTMLSpanElement>(null);
  const textareaId = React.useId();
  const modelSelectId = React.useId();
  const thinkingSelectId = React.useId();

  const canSend = text.trim().length > 0 && !busy;
  const activeModelValue = selectedModel || models[0]?.key || '';
  const selectedOption = models.find((m) => m.key === activeModelValue);

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

  const resetHeight = () => {
    if (textareaRef.current && !supportsFieldSizing()) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
    resetHeight();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      submit();
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) textareaRef.current?.focus();
        }}
        className="relative overflow-hidden rounded-[22px] border border-line-strong bg-surface-raised/95 backdrop-blur-md shadow-[var(--shadow-float)] transition-[border-color,box-shadow] focus-within:border-string focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--string)_14%,transparent),var(--shadow-float)]"
      >
        {busy && (
          <div className="pc-string-pulse" aria-hidden="true">
            <span ref={pulseBarRef} className="pc-string-pulse-bar" />
          </div>
        )}

        <label htmlFor={textareaId} className="visually-hidden">
          向 Agent 发送指令
        </label>
        <textarea
          ref={textareaRef}
          id={textareaId}
          name="prompt"
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="传达你的语言…（解包、排查 QA、翻译调度或直接提问）"
          rows={1}
          aria-label="向 Agent 发送指令"
          className="pc-textarea block w-full bg-transparent px-4 pt-3.5 pb-1.5 text-[0.9375rem] leading-6 text-ink placeholder:text-ink-3 focus:outline-none"
        />

        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 pt-1">
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

          <div className="ml-auto flex items-center gap-2.5">
            {!busy && (
              <span className="hidden text-[11px] text-ink-3 sm:inline">
                Enter 发送 · Shift+Enter 换行
              </span>
            )}
            {busy && onAbort ? (
              <button
                type="button"
                onClick={onAbort}
                aria-label="停止执行"
                title="停止当前执行"
                className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-danger px-3.5 text-xs font-medium text-on-string shadow-xs transition-opacity hover:opacity-90 cursor-pointer"
              >
                <Square className="size-3 fill-current" aria-hidden="true" />
                <span>停止执行</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
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
