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
  {
    id: 'magpie',
    name: 'Magpie (本地网关)',
    envVar: 'MAGPIE_API_KEY',
    configured: false,
    source: null,
    modelCount: 0,
    supportsBaseUrl: true,
    baseUrl: 'http://127.0.0.1:3425/v1',
    defaultBaseUrl: 'http://127.0.0.1:3425/v1',
    apiKeyOptional: true,
    hasApiKey: false,
  },
  { id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'moonshotai', name: 'Moonshot (Kimi)', envVar: 'MOONSHOT_API_KEY', configured: false, source: null, modelCount: 0 },
  { id: 'minimax', name: 'MiniMax', envVar: 'MINIMAX_API_KEY', configured: false, source: null, modelCount: 0 },
];

const QUICK_PROVIDER_COUNT = 10;

const QUICK_PROVIDER_SHORT_NAMES: Record<string, string> = {
  google: 'Google AI Studio',
  modelscope: 'ModelScope',
  volcengine: '火山方舟',
  siliconflow: '硅基流动',
  moonshotai: 'Moonshot',
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

function getProviderShortName(provider?: ProviderStatusInfo): string {
  if (!provider) return '';
  return QUICK_PROVIDER_SHORT_NAMES[provider.id] ?? provider.name.split(' ')[0];
}

function validateGatewayBaseUrl(rawUrl: string, providerLabel: string, exampleUrl: string): string {
  const trimmed = rawUrl.trim();
  const hint = exampleUrl ? `，例如 ${exampleUrl}` : '';
  if (!trimmed) {
    return `请输入 ${providerLabel} 网关地址${hint}。`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `网关地址需以 http:// 或 https:// 开头${hint}。`;
    }
    return '';
  } catch {
    return `网关地址格式无效，请输入完整 URL${hint}。`;
  }
}

function inferAutoDetectHint(rawKey: string): string {
  const key = rawKey.trim();
  if (!key) {
    return '粘贴任意厂商 API Key 后点击保存，系统将由服务端自动识别提供商、过滤不可用模型并加载当前受支持的对话模型；密钥将持久保存于本机 ~/.papercup/auth.json，重启后自动恢复。';
  }
  return '已输入密钥 · 保存时将由服务端自动探测归属网关并同步当前受支持的对话模型';
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
  return providers.find((p) => p.configured) ?? providers.find((p) => p.savedLocally);
}

function formatSourceLabel(provider?: ProviderStatusInfo): string {
  if (!provider?.configured) {
    return provider?.savedLocally ? '本地已保存 · 未启用' : '未配置';
  }
  if (provider.source === 'runtime') return '已配置 · 运行时';
  if (provider.source === 'stored') return '已配置 · 本地持久';
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
  const baseUrlInputRef = React.useRef<HTMLInputElement>(null);
  const closeTimerRef = React.useRef<number | null>(null);
  const providerSelectId = React.useId();
  const baseUrlInputId = React.useId();
  const baseUrlHintId = React.useId();
  const baseUrlErrorId = React.useId();
  const keyInputId = React.useId();
  const customModelInputId = React.useId();
  const hintId = React.useId();
  const errorId = React.useId();

  const availableProviders = providers.length > 0 ? providers : FALLBACK_PROVIDERS;
  const quickProviders = availableProviders.slice(0, QUICK_PROVIDER_COUNT);

  const [selectedProvider, setSelectedProvider] = React.useState<string>('auto');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [baseUrlTouched, setBaseUrlTouched] = React.useState(false);
  const [baseUrlError, setBaseUrlError] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [connectKeyless, setConnectKeyless] = React.useState(false);
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

  const syncProviderFields = React.useCallback(
    (nextProviderId: string) => {
      clearCloseTimer();
      setSelectedProvider(nextProviderId);
      setCustomModel('');
      setConnectKeyless(false);
      setError('');
      setBaseUrlError('');
      setBaseUrlTouched(false);
      setStatusMessage('');
      const target = availableProviders.find((p) => p.id === nextProviderId);
      if (target?.supportsBaseUrl) {
        setBaseUrl(target.baseUrl || target.defaultBaseUrl || '');
      }
    },
    [availableProviders, clearCloseTimer]
  );

  React.useEffect(() => {
    if (isOpen) {
      clearCloseTimer();
      setError('');
      setBaseUrlError('');
      setBaseUrlTouched(false);
      setStatusMessage('');
      setApiKey('');
      setConnectKeyless(false);
      setCustomModel('');
      setShowKey(false);
      setSelectedProvider('auto');
      const firstGateway = availableProviders.find((p) => p.supportsBaseUrl);
      setBaseUrl(firstGateway?.baseUrl || firstGateway?.defaultBaseUrl || '');
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
  const activeShortName = getProviderShortName(activeProvider) || selectedProvider;
  const supportsBaseUrl = !isAutoMode && Boolean(activeProvider?.supportsBaseUrl);
  const defaultBaseUrl = activeProvider?.defaultBaseUrl || '';
  const isOptionalKey = !isAutoMode && Boolean(activeProvider?.apiKeyOptional);
  const canUseStored = !isAutoMode && Boolean(activeProvider?.savedLocally);
  const hasSavedSecretKey = Boolean(canUseStored && (!isOptionalKey || activeProvider?.hasApiKey));
  const canSubmitWithoutKey = isOptionalKey || canUseStored;
  const customModelMeta = isAutoMode
    ? undefined
    : CUSTOM_MODEL_FIELD_META[selectedProvider] ??
      (supportsBaseUrl
        ? {
            label: '自定义模型 ID（可选）',
            placeholder: '留空自动拉取 /v1/models，或手填具体模型 ID',
          }
        : undefined);
  const keyFormatHint = isAutoMode
    ? inferAutoDetectHint(apiKey)
    : isOptionalKey
      ? hasSavedSecretKey
        ? connectKeyless
          ? `将以无密钥模式连接 ${activeProvider?.name || selectedProvider}（不沿用本地已保存令牌）。`
          : `已检测到本地保存的 ${activeShortName} 访问令牌（~/.papercup/auth.json），留空沿用当前令牌并刷新模型，或输入新令牌覆盖。`
        : `${activeProvider?.name || selectedProvider} 默认无需密钥，可直接留空点击连接；若网关已启用鉴权令牌，请在此填写并自动持久保存。`
      : canUseStored
        ? `手动指定 ${activeProvider?.name || selectedProvider} · 已检测到本地持久化密钥（~/.papercup/auth.json），留空可直接启用/刷新模型，或输入新密钥覆盖`
        : `手动指定 ${activeProvider?.name || selectedProvider} · 保存时将校验密钥并持久保存至本机（~/.papercup/auth.json），重启后自动恢复`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    const trimmedBaseUrl = baseUrl.trim();

    if (supportsBaseUrl) {
      const urlErr = validateGatewayBaseUrl(trimmedBaseUrl, activeShortName, defaultBaseUrl);
      if (urlErr) {
        setBaseUrlError(urlErr);
        setBaseUrlTouched(true);
        setError('');
        setStatusMessage('');
        baseUrlInputRef.current?.focus();
        return;
      }
      setBaseUrlError('');
    }

    const useStored = !isAutoMode && !trimmed && hasSavedSecretKey && !(isOptionalKey && connectKeyless);
    if (!trimmed && !canSubmitWithoutKey) {
      setError('请输入 API Key。');
      setStatusMessage('');
      inputRef.current?.focus();
      return;
    }
    clearCloseTimer();
    setError('');
    setStatusMessage(
      isOptionalKey
        ? `正在连接 ${activeProvider?.name || selectedProvider} (${trimmedBaseUrl}) 并拉取可用模型…`
        : useStored
          ? `正在使用本地保存的 ${activeProvider?.name || selectedProvider} 凭据同步模型…`
          : isAutoMode
            ? '正在自动识别密钥归属并拉取可用模型…'
            : '正在校验密钥并同步受支持模型…'
    );
    setSaving(true);
    try {
      const updated = await updateProviderApiKey(
        selectedProvider,
        useStored ? '' : trimmed,
        !isAutoMode && customModel.trim() ? customModel.trim() : undefined,
        {
          ...(useStored ? { useStored: true } : {}),
          ...(supportsBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
        }
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
      if (supportsBaseUrl) {
        baseUrlInputRef.current?.focus();
      } else {
        inputRef.current?.focus();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (isAutoMode) return;
    clearCloseTimer();
    setError('');
    setBaseUrlError('');
    setStatusMessage('');
    setSaving(true);
    try {
      const updated = await updateProviderApiKey(selectedProvider, '', undefined, { clear: true });
      onModelsUpdated(updated);
      setApiKey('');
      setCustomModel('');
      if (supportsBaseUrl) {
        setBaseUrl(defaultBaseUrl);
        setBaseUrlTouched(false);
      }
      setStatusMessage(
        isOptionalKey
          ? `已清除 ${activeProvider?.name || selectedProvider} 的本地连接配置`
          : activeProvider?.savedLocally
            ? `已清除 ${activeProvider?.name || selectedProvider} 的本地持久化密钥`
            : `已清除 ${activeProvider?.name || selectedProvider} 密钥`
      );
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
            disabled={saving || busy}
            aria-pressed={isAutoMode}
            onClick={() => syncProviderFields('auto')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer',
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
            const shortName = getProviderShortName(provider);

            return (
              <button
                key={provider.id}
                type="button"
                disabled={saving || busy}
                aria-pressed={active}
                onClick={() => syncProviderFields(provider.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer',
                  active
                    ? 'border-string bg-string-soft text-string-ink'
                    : 'border-line bg-canvas text-ink-2 hover:border-line-strong hover:text-ink'
                )}
              >
                {provider.configured ? (
                  <Check className="size-3 shrink-0 text-ok" aria-hidden="true" />
                ) : provider.savedLocally ? (
                  <KeyRound className="size-3 shrink-0 text-string" aria-hidden="true" />
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
                  : activeProvider?.savedLocally
                    ? 'border-string/35 bg-string-soft text-string-ink'
                    : 'border-line bg-canvas text-ink-3'
              )}
            >
              {activeProvider?.configured ? (
                <Check className="size-3" aria-hidden="true" />
              ) : activeProvider?.savedLocally ? (
                <KeyRound className="size-3" aria-hidden="true" />
              ) : null}
              {isAutoMode && activeProvider?.configured
                ? `当前：${getProviderShortName(activeProvider)}`
                : isAutoMode && activeProvider?.savedLocally
                  ? `本地已存：${getProviderShortName(activeProvider)}`
                  : formatSourceLabel(activeProvider)}
            </span>
          </div>
          <select
            id={providerSelectId}
            name="provider"
            value={selectedProvider}
            disabled={saving || busy}
            onChange={(e) => syncProviderFields(e.target.value)}
            className="pc-select h-9 w-full rounded-xl border border-field bg-well px-3 text-[0.8125rem] font-medium text-ink cursor-pointer"
          >
            <option value="auto">自动识别提供商（推荐 · 仅加载当前可用模型）</option>
            {availableProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.modelCount > 0 ? ` (${provider.modelCount})` : ''}
                {provider.configured ? ' ✓' : provider.savedLocally ? '（已保存）' : ''}
              </option>
            ))}
          </select>
        </div>

        {supportsBaseUrl && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={baseUrlInputId} className="block text-xs font-medium text-ink-2">
                本地网关地址 (Base URL)
                <span className="ml-1 text-string-ink" aria-hidden="true">
                  *
                </span>
              </label>
              {baseUrl.trim() !== defaultBaseUrl && (
                <button
                  type="button"
                  disabled={saving || busy}
                  onClick={() => {
                    setBaseUrl(defaultBaseUrl);
                    setBaseUrlError('');
                    setBaseUrlTouched(false);
                  }}
                  className="text-[11px] font-medium text-string-ink underline-offset-2 hover:underline disabled:opacity-45 cursor-pointer"
                >
                  恢复默认
                </button>
              )}
            </div>
            <p id={baseUrlHintId} className="text-[11px] leading-4 text-ink-3">
              默认 {defaultBaseUrl}，兼容 OpenAI 协议（/v1/models 与 /v1/chat/completions），可按本地端口自定义。
            </p>
            <input
              ref={baseUrlInputRef}
              id={baseUrlInputId}
              name="baseUrl"
              type="url"
              inputMode="url"
              value={baseUrl}
              onChange={(e) => {
                const nextVal = e.target.value;
                setBaseUrl(nextVal);
                setBaseUrlTouched(true);
                if (
                  isOptionalKey &&
                  hasSavedSecretKey &&
                  activeProvider?.baseUrl &&
                  nextVal.trim().replace(/\/+$/, '') !== activeProvider.baseUrl.replace(/\/+$/, '')
                ) {
                  setConnectKeyless(true);
                }
                if (baseUrlError) setBaseUrlError('');
                if (error) setError('');
              }}
              onBlur={() => {
                if (baseUrlTouched) {
                  setBaseUrlError(validateGatewayBaseUrl(baseUrl, activeShortName, defaultBaseUrl));
                }
              }}
              disabled={saving || busy}
              required
              autoComplete="url"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              aria-invalid={baseUrlError ? 'true' : 'false'}
              aria-describedby={baseUrlError ? `${baseUrlHintId} ${baseUrlErrorId}` : baseUrlHintId}
              placeholder={defaultBaseUrl}
              className={cn(
                'h-9 w-full rounded-xl border bg-well px-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-string-ink',
                baseUrlError
                  ? 'border-danger focus:border-danger'
                  : 'border-field focus:border-string'
              )}
            />
            {baseUrlError && (
              <p
                id={baseUrlErrorId}
                className="flex items-start gap-1.5 text-[11px] leading-4 text-danger"
              >
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{baseUrlError}</span>
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor={keyInputId} className="block text-xs font-medium text-ink-2">
            {isAutoMode
              ? 'API Key（自动探测厂商与最新模型）'
              : isOptionalKey
                ? `API Key（可选${activeProvider?.envVar ? ` · ${activeProvider.envVar}` : ''}）`
                : activeProvider?.envVar || 'API Key'}
            {!canSubmitWithoutKey && (
              <span className="ml-1 text-string-ink" aria-hidden="true">
                *
              </span>
            )}
          </label>
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              id={keyInputId}
              name="apiKey"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              disabled={saving || busy}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (e.target.value.trim()) setConnectKeyless(false);
                if (error) setError('');
              }}
              data-autofocus=""
              required={!canSubmitWithoutKey}
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
                  : isOptionalKey
                    ? hasSavedSecretKey && !connectKeyless
                      ? '已本地保存令牌（留空沿用当前令牌，或输入新令牌覆盖）…'
                      : `本地网关默认可留空；若已开启鉴权请填写 ${activeShortName} 令牌…`
                    : canUseStored
                      ? activeProvider?.configured
                        ? '已本地保存（留空直接刷新模型，或输入新密钥覆盖）…'
                        : '已本地保存（留空直接启用该厂商，或输入新密钥覆盖）…'
                      : activeProvider?.configured
                        ? '输入新密钥以覆盖…'
                        : '粘贴 API Key…'
              }
              className="h-9 w-full rounded-xl border border-field bg-well pr-10 pl-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
            />
            <button
              type="button"
              disabled={saving || busy}
              onClick={() => setShowKey((v) => !v)}
              aria-pressed={showKey}
              aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
              className="absolute right-1 inline-flex size-7 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-sheet hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              {showKey ? (
                <EyeOff className="size-3.5" aria-hidden="true" />
              ) : (
                <Eye className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
          {isOptionalKey && hasSavedSecretKey && !apiKey.trim() && (
            <label className="pc-checkbox-label flex items-center gap-2 pt-0.5 text-[11px] text-ink-2">
              <input
                type="checkbox"
                checked={connectKeyless}
                disabled={saving || busy}
                onChange={(e) => setConnectKeyless(e.target.checked)}
                className="size-3.5 shrink-0"
              />
              <span>无密钥直连（不使用已保存令牌）</span>
            </label>
          )}
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
            {!isAutoMode && (activeProvider?.configured || activeProvider?.savedLocally) && (
              <button
                type="button"
                onClick={() => void handleClearKey()}
                disabled={saving || busy}
                className="inline-flex items-center gap-1.5 rounded-xl border border-danger/35 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                <span>
                  {isOptionalKey
                    ? '清除本地配置'
                    : activeProvider?.savedLocally
                      ? '清除本地密钥'
                      : '清除密钥'}
                </span>
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
              <span>
                {isAutoMode
                  ? '自动识别并保存'
                  : isOptionalKey
                    ? !apiKey.trim() &&
                      !connectKeyless &&
                      activeProvider?.configured &&
                      baseUrl.trim().replace(/\/+$/, '') ===
                        (activeProvider.baseUrl || defaultBaseUrl).replace(/\/+$/, '')
                      ? `刷新 ${activeShortName} 模型`
                      : '连接并拉取模型'
                    : !apiKey.trim() && canUseStored
                      ? activeProvider?.configured
                        ? '刷新模型'
                        : '启用已保存密钥'
                      : '保存并刷新模型'}
              </span>
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
