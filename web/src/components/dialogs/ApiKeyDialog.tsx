import * as React from 'react';
import { Check, CircleAlert, Eye, EyeOff, KeyRound, Sparkles, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog.js';
import { ModelsState, ProviderStatusInfo, updateProviderApiKey } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';

interface ApiKeyDialogProps {
  isOpen: boolean;
  onClose: () => void;
  providers: ProviderStatusInfo[];
  currentModel: string | null;
  busy?: boolean;
  onModelsUpdated: (state: ModelsState) => void;
}

const FALLBACK_PROVIDERS: ProviderStatusInfo[] = [
  { id: 'google', name: 'Google AI Studio (Gemini)', envVar: 'GEMINI_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'anthropic', name: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'deepseek', name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'xai', name: 'xAI (Grok)', envVar: 'XAI_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'modelscope', name: 'ModelScope (魔搭)', envVar: 'MODELSCOPE_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'volcengine', name: '火山方舟 (Volcengine Ark)', envVar: 'ARK_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'siliconflow', name: 'SiliconFlow (硅基流动)', envVar: 'SILICONFLOW_API_KEY', configured: false, source: null, modelCount: 0 },
];

const QUICK_PROVIDER_COUNT = 9;

const QUICK_PROVIDER_SHORT_NAMES: Record<string, string> = {
  google: 'Google AI Studio',
  modelscope: 'ModelScope',
  volcengine: '火山方舟',
  siliconflow: '硅基流动',
};

const CUSTOM_MODEL_FIELD_META: Record<string, { label: string; placeholder: string }> = {
  modelscope: {
    label: '自定义模型 ID（可选）',
    placeholder: '如 Qwen/Qwen3.8-Flash-Next 或 deepseek-ai/DeepSeek-V4.1-Flash',
  },
  volcengine: {
    label: '自定义模型 / 接入点 ID（可选）',
    placeholder: '如 doubao-seed-2-0-pro-260215 或 ep-xxxxxxxx-xxxxx',
  },
  siliconflow: {
    label: '自定义模型 ID（可选）',
    placeholder: '如 deepseek-ai/DeepSeek-V3.2 或 Qwen/Qwen3-32B',
  },
};

function inferLocalKeyHint(rawKey: string): string {
  const key = rawKey.trim();
  if (!key) {
    return '粘贴任意厂商 API Key 后点击保存，系统将自动识别提供商、剔除过时模型并仅加载当前可用对话模型。';
  }
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) {
    return '格式匹配 Google AI Studio (Gemini) · 将自动校验并拉取受支持的 Gemini 模型';
  }
  if (/^sk-ant-/i.test(key)) {
    return '格式匹配 Anthropic (Claude) · 将自动校验并加载当前受支持的 Claude 模型';
  }
  if (/^sk-or-/i.test(key)) {
    return '格式匹配 OpenRouter · 将鉴权并过滤当前可用的最新多模型目录';
  }
  if (/^xai-/i.test(key)) {
    return '格式匹配 xAI (Grok) · 将校验并同步当前支持的 Grok 模型';
  }
  if (/^gsk_/i.test(key)) {
    return '格式匹配 Groq · 将校验并拉取当前可用的高速推理模型';
  }
  if (/^ms-/i.test(key)) {
    return '格式匹配 ModelScope (魔搭) · 将校验并过滤在线模型目录';
  }
  if (/^sk-(?:proj|svcacct|admin)-/i.test(key)) {
    return '格式匹配 OpenAI · 将校验并同步当前官方支持模型（自动排除已淘汰旧版）';
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return '格式匹配火山方舟 (Volcengine Ark) · 将同步可用对话/推理模型';
  }
  if (/^sk-api-/i.test(key) || /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    return '格式匹配 MiniMax · 将配置并加载当前可用 MiniMax 对话模型';
  }
  if (/^sk-/i.test(key)) {
    return '检测到通用 sk- 前缀 · 保存时将并发探活 OpenAI / DeepSeek / 硅基流动 / Moonshot / 魔搭 真实归属';
  }
  return '已输入密钥 · 保存时将自动探测对应网关并同步当前受支持模型';
}

function resolveInitialActiveBadge(
  providers: ProviderStatusInfo[],
  currentModel: string | null
): ProviderStatusInfo | undefined {
  const currentProvider = currentModel?.split('/')[0];
  if (currentProvider) {
    const found = providers.find((p) => p.id === currentProvider && p.configured);
    if (found) return found;
  }
  return providers.find((p) => p.configured);
}

function formatSourceLabel(provider?: ProviderStatusInfo): string {
  if (!provider?.configured) return '未配置';
  if (provider.source === 'runtime') return '已配置 · 运行时';
  if (provider.source === 'stored') return '已配置 · 本地凭据';
  return '已配置 · 环境变量';
}

export function ApiKeyDialog({
  isOpen,
  onClose,
  providers,
  currentModel,
  busy = false,
  onModelsUpdated,
}: ApiKeyDialogProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const closeTimerRef = React.useRef<number | null>(null);
  const providerSelectId = React.useId();
  const keyInputId = React.useId();
  const customModelInputId = React.useId();
  const hintId = React.useId();
  const errorId = React.useId();

  const availableProviders = providers.length > 0 ? providers : FALLBACK_PROVIDERS;
  const quickProviders = availableProviders.slice(0, QUICK_PROVIDER_COUNT);

  const [selectedProvider, setSelectedProvider] = React.useState<string>('auto');
  const [apiKey, setApiKey] = React.useState('');
  const [customModel, setCustomModel] = React.useState('');
  const [showKey, setShowKey] = React.useState(false);
  const [error, setError] = React.useState('');
  const [statusMessage, setStatusMessage] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const clearCloseTimer = React.useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => clearCloseTimer, [clearCloseTimer]);

  React.useEffect(() => {
    if (isOpen) {
      clearCloseTimer();
      setError('');
      setStatusMessage('');
      setApiKey('');
      setCustomModel('');
      setShowKey(false);
      setSelectedProvider('auto');
    } else {
      clearCloseTimer();
    }
  }, [clearCloseTimer, isOpen]);

  React.useEffect(() => {
    if (selectedProvider !== 'auto' && !availableProviders.some((p) => p.id === selectedProvider)) {
      setSelectedProvider('auto');
    }
  }, [availableProviders, selectedProvider]);

  const isAutoMode = selectedProvider === 'auto';
  const activeProvider = isAutoMode
    ? resolveInitialActiveBadge(availableProviders, currentModel)
    : availableProviders.find((p) => p.id === selectedProvider) ?? availableProviders[0];
  const customModelMeta = isAutoMode ? undefined : CUSTOM_MODEL_FIELD_META[selectedProvider];
  const keyFormatHint = isAutoMode
    ? inferLocalKeyHint(apiKey)
    : `手动指定 ${activeProvider?.name || selectedProvider} · 保存时将校验密钥并剔除过时与非对话模型`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('请输入 API Key。');
      setStatusMessage('');
      inputRef.current?.focus();
      return;
    }
    clearCloseTimer();
    setError('');
    setStatusMessage(
      isAutoMode ? '正在自动识别密钥归属并拉取可用模型…' : '正在校验密钥并同步受支持模型…'
    );
    setSaving(true);
    try {
      const updated = await updateProviderApiKey(
        selectedProvider,
        trimmed,
        !isAutoMode && customModel.trim() ? customModel.trim() : undefined
      );
      onModelsUpdated(updated);
      setApiKey('');
      setCustomModel('');

      const providerLabel = updated.detectedProviderName || updated.detectedProvider || selectedProvider;
      const liveText =
        typeof updated.liveModelCount === 'number'
          ? `已加载 ${updated.liveModelCount} 个可用模型${
              updated.filteredOutCount ? `（已过滤 ${updated.filteredOutCount} 个过时/非对话模型）` : ''
            }`
          : `共 ${updated.models.length} 个可用模型`;
      setStatusMessage(`已启用 ${providerLabel} · ${liveText}`);

      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        onClose();
      }, 650);
    } catch (err: unknown) {
      setStatusMessage('');
      setError(err instanceof Error ? err.message : '保存 API Key 失败');
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (isAutoMode) return;
    clearCloseTimer();
    setError('');
    setStatusMessage('');
    setSaving(true);
    try {
      const updated = await updateProviderApiKey(selectedProvider, '');
      onModelsUpdated(updated);
      setApiKey('');
      setCustomModel('');
      setStatusMessage(`已清除 ${activeProvider?.name || selectedProvider} 密钥`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '清除 API Key 失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="API Key 与模型同步"
      icon={<KeyRound className="size-4 text-string" aria-hidden="true" />}
    >
      <form method="post" onSubmit={handleSubmit} noValidate className="space-y-4 p-5">
        {error && (
          <div
            id={errorId}
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2 text-xs leading-5 text-danger"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {statusMessage && !error && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-xl border border-ok/35 bg-ok-soft px-3 py-2 text-xs leading-5 text-ok"
          >
            {saving ? (
              <progress className="pc-spinner text-ok" aria-hidden="true" />
            ) : (
              <Check className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span>{statusMessage}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="快速选择提供商或自动识别">
          <button
            type="button"
            aria-pressed={isAutoMode}
            onClick={() => {
              setSelectedProvider('auto');
              setCustomModel('');
              setError('');
              setStatusMessage('');
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer',
              isAutoMode
                ? 'border-string bg-string-soft text-string-ink'
                : 'border-line bg-canvas text-ink-2 hover:border-line-strong hover:text-ink'
            )}
          >
            <Sparkles className="size-3 shrink-0 text-string" aria-hidden="true" />
            <span>自动识别</span>
          </button>

          {quickProviders.map((provider) => {
            const active = provider.id === selectedProvider;
            const shortName =
              QUICK_PROVIDER_SHORT_NAMES[provider.id] ?? provider.name.split(' ')[0];

            return (
              <button
                key={provider.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setSelectedProvider(provider.id);
                  setCustomModel('');
                  setError('');
                  setStatusMessage('');
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer',
                  active
                    ? 'border-string bg-string-soft text-string-ink'
                    : 'border-line bg-canvas text-ink-2 hover:border-line-strong hover:text-ink'
                )}
              >
                {provider.configured ? (
                  <Check className="size-3 shrink-0 text-ok" aria-hidden="true" />
                ) : (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-ink-3/50"
                    aria-hidden="true"
                  />
                )}
                <span>{shortName}</span>
              </button>
            );
          })}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={providerSelectId} className="text-xs font-medium text-ink-2">
              提供商识别模式
            </label>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                activeProvider?.configured
                  ? 'border-ok/35 bg-ok-soft text-ok'
                  : 'border-line bg-canvas text-ink-3'
              )}
            >
              {activeProvider?.configured && <Check className="size-3" aria-hidden="true" />}
              {isAutoMode && activeProvider?.configured
                ? `当前：${QUICK_PROVIDER_SHORT_NAMES[activeProvider.id] ?? activeProvider.name.split(' ')[0]}`
                : formatSourceLabel(activeProvider)}
            </span>
          </div>
          <select
            id={providerSelectId}
            name="provider"
            value={selectedProvider}
            disabled={saving || busy}
            onChange={(e) => {
              setSelectedProvider(e.target.value);
              setCustomModel('');
              setError('');
              setStatusMessage('');
            }}
            className="pc-select h-9 w-full rounded-xl border border-field bg-well px-3 text-[0.8125rem] font-medium text-ink cursor-pointer"
          >
            <option value="auto">自动识别提供商（推荐 · 仅加载当前可用模型）</option>
            {availableProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.modelCount > 0 ? ` (${provider.modelCount})` : ''}
                {provider.configured ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={keyInputId} className="block text-xs font-medium text-ink-2">
            {isAutoMode ? 'API Key（自动探测厂商与最新模型）' : activeProvider?.envVar || 'API Key'}
            <span className="ml-1 text-string-ink" aria-hidden="true">
              *
            </span>
          </label>
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              id={keyInputId}
              name="apiKey"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (error) setError('');
              }}
              data-autofocus=""
              required
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              aria-invalid={error ? 'true' : 'false'}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              placeholder={
                isAutoMode
                  ? '直接粘贴 Gemini / Claude / OpenAI / DeepSeek / OpenRouter 等 Key…'
                  : activeProvider?.configured
                    ? '输入新密钥以覆盖…'
                    : '粘贴 API Key…'
              }
              className="h-9 w-full rounded-xl border border-field bg-well pr-10 pl-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-pressed={showKey}
              aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
              className="absolute right-1 inline-flex size-7 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-sheet hover:text-ink cursor-pointer"
            >
              {showKey ? (
                <EyeOff className="size-3.5" aria-hidden="true" />
              ) : (
                <Eye className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
          <p id={hintId} className="text-[11px] leading-4 text-ink-3">
            {keyFormatHint}
          </p>
        </div>

        {customModelMeta && (
          <div className="space-y-1.5">
            <label htmlFor={customModelInputId} className="block text-xs font-medium text-ink-2">
              {customModelMeta.label}
            </label>
            <input
              id={customModelInputId}
              name="customModel"
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              disabled={saving || busy}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={customModelMeta.placeholder}
              className="h-9 w-full rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div>
            {!isAutoMode && activeProvider?.configured && (
              <button
                type="button"
                onClick={() => void handleClearKey()}
                disabled={saving || busy}
                className="inline-flex items-center gap-1.5 rounded-xl border border-danger/35 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                <span>清除密钥</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="inline-flex items-center justify-center rounded-xl border border-line px-3.5 py-1.5 text-[0.8125rem] font-medium text-ink-2 transition-colors hover:bg-well hover:text-ink disabled:opacity-45 cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving || busy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-string px-4 py-1.5 text-[0.8125rem] font-medium text-on-string transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              {saving && <progress className="pc-spinner text-on-string" aria-hidden="true" />}
              <span>{isAutoMode ? '自动识别并加载模型' : '保存并刷新模型'}</span>
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
