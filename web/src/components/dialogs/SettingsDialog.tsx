import * as React from 'react';
import {
  Check,
  CircleAlert,
  Cpu,
  FolderOpen,
  KeyRound,
  Play,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog.js';
import type { ToastItem } from '@/components/ui/ToastRegion.js';
import { ColorSchemePreference, ResolvedColorScheme } from '@/hooks/useColorScheme.js';
import {
  fetchLocalOllamaStatus,
  fetchSmokeConfig,
  LocalEndpointPresetInfo,
  LocalMtPreset,
  OllamaStatusResult,
  pickOllamaBinary,
  pickSmokeToolBinary,
  probeLocalTranslator,
  SmokeConfigState,
  startLocalOllama,
  TranslatorConfigState,
  TranslatorConfigUpdateResponse,
  TranslatorMode,
  updateSmokeConfig,
  updateTranslatorConfig,
} from '@/lib/api.js';
import { cn } from '@/lib/utils.js';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  preference: ColorSchemePreference;
  systemScheme: ResolvedColorScheme;
  onSelectScheme: (pref: ColorSchemePreference, origin?: { x: number; y: number }) => void;
  ambientEnabled: boolean;
  onToggleAmbient: (enabled: boolean) => void;
  onOpenApiKey: () => void;
  translatorConfig: TranslatorConfigState | null;
  latestSmokeConfig?: SmokeConfigState | null;
  onTranslatorConfigUpdated: (state: TranslatorConfigUpdateResponse) => void;
  onOllamaSyncSeq?: (seq: number) => void;
  onShowToast?: (toast: Omit<ToastItem, 'id'>) => void;
  busy?: boolean;
}

export function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.trim().toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function isDefaultLocalOllamaUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.trim().toLowerCase();
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    return isLoopback && u.port === '11434';
  } catch {
    return false;
  }
}

function getUrlOriginSafe(rawUrl: string): string | null {
  try {
    return new URL(rawUrl.trim()).origin;
  } catch {
    return null;
  }
}

const FALLBACK_ENDPOINT_PRESETS: LocalEndpointPresetInfo[] = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'magpie', name: 'Magpie', baseUrl: 'http://127.0.0.1:3425/v1' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
];

export function SettingsDialog({
  isOpen,
  onClose,
  preference,
  systemScheme,
  onSelectScheme,
  ambientEnabled,
  onToggleAmbient,
  onOpenApiKey,
  translatorConfig,
  latestSmokeConfig = null,
  onTranslatorConfigUpdated,
  onOllamaSyncSeq,
  onShowToast,
  busy = false,
}: SettingsDialogProps) {
  const systemLabel = `跟随系统（当前：${systemScheme === 'dark' ? '深色' : '浅色'}）`;
  const lastPointerRef = React.useRef<{ x: number; y: number } | undefined>(undefined);

  const translatorHeadingId = React.useId();
  const baseUrlInputId = React.useId();
  const baseUrlHintId = React.useId();
  const baseUrlErrorId = React.useId();
  const ollamaPathInputId = React.useId();
  const ollamaPathHintId = React.useId();
  const modelInputId = React.useId();
  const modelHintId = React.useId();
  const modelErrorId = React.useId();
  const modelsDatalistId = React.useId();
  const apiKeyInputId = React.useId();
  const packetLinesId = React.useId();
  const packetLinesErrorId = React.useId();
  const concurrencyId = React.useId();
  const concurrencyErrorId = React.useId();

  const baseUrlInputRef = React.useRef<HTMLInputElement>(null);
  const modelInputRef = React.useRef<HTMLInputElement>(null);
  const packetLinesInputRef = React.useRef<HTMLInputElement>(null);
  const concurrencyInputRef = React.useRef<HTMLInputElement>(null);

  const [mode, setMode] = React.useState<TranslatorMode>('cloud_subagent');
  const [baseUrl, setBaseUrl] = React.useState('http://127.0.0.1:11434/v1');
  const [ollamaPath, setOllamaPath] = React.useState('');
  const [model, setModel] = React.useState('');
  const [apiKeyDraft, setApiKeyDraft] = React.useState('');
  const [clearApiKey, setClearApiKey] = React.useState(false);
  const [preset, setPreset] = React.useState<LocalMtPreset>('sakura');
  const [packetLinesText, setPacketLinesText] = React.useState('8');
  const [concurrencyText, setConcurrencyText] = React.useState('3');
  const [escalateFailedRows, setEscalateFailedRows] = React.useState(true);
  const [useTmCache, setUseTmCache] = React.useState(true);
  const [disableThinking, setDisableThinking] = React.useState(true);

  const [probedModels, setProbedModels] = React.useState<Array<{ id: string; name: string }>>([]);
  const [ollamaStatus, setOllamaStatus] = React.useState<OllamaStatusResult | null>(null);
  const [ollamaBusy, setOllamaBusy] = React.useState<'checking' | 'starting' | 'restarting' | null>(null);
  const [pickingOllamaPath, setPickingOllamaPath] = React.useState(false);
  const [probing, setProbing] = React.useState(false);
  const [savingTranslator, setSavingTranslator] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState('');
  const [submitError, setSubmitError] = React.useState('');
  const [baseUrlError, setBaseUrlError] = React.useState('');
  const [modelError, setModelError] = React.useState('');
  const [packetLinesError, setPacketLinesError] = React.useState('');
  const [concurrencyError, setConcurrencyError] = React.useState('');

  // Runtime Smoke Test configuration state
  const smokeHeadingId = React.useId();
  const smokeTrInputId = React.useId();
  const smokeLeInputId = React.useId();
  const smokeTimeoutId = React.useId();
  const smokeStepsId = React.useId();
  const [smokeState, setSmokeState] = React.useState<SmokeConfigState | null>(null);
  const [smokeEnabled, setSmokeEnabled] = React.useState(false);
  const [smokeVisionEnabled, setSmokeVisionEnabled] = React.useState(true);
  const [smokeTrPath, setSmokeTrPath] = React.useState('');
  const [smokeLePath, setSmokeLePath] = React.useState('');
  const [smokeTimeoutText, setSmokeTimeoutText] = React.useState('90');
  const [smokeStepsText, setSmokeStepsText] = React.useState('25');
  const [pickingSmokeTool, setPickingSmokeTool] = React.useState<'textractor' | 'locale_emulator' | null>(null);
  const [savingSmoke, setSavingSmoke] = React.useState(false);
  const [smokeMessage, setSmokeMessage] = React.useState('');
  const [smokeError, setSmokeError] = React.useState('');

  React.useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetchSmokeConfig()
      .then((cfg) => {
        if (!active) return;
        setSmokeState(cfg);
        setSmokeEnabled(cfg.global.enabled);
        setSmokeVisionEnabled(cfg.global.visionEnabled);
        setSmokeTrPath(cfg.global.textractorPath);
        setSmokeLePath(cfg.global.localeEmulatorPath);
        setSmokeTimeoutText(String(cfg.global.timeoutSec));
        setSmokeStepsText(String(cfg.global.advanceSteps));
        setSmokeError('');
        setSmokeMessage('');
      })
      .catch(() => {
        // Ignore transient smoke config fetch errors on open
      });
    return () => {
      active = false;
    };
  }, [isOpen]);

  const handlePickSmokeTool = async (tool: 'textractor' | 'locale_emulator') => {
    if (pickingSmokeTool || savingSmoke || busy) return;
    setPickingSmokeTool(tool);
    setSmokeError('');
    try {
      const init = tool === 'textractor' ? smokeTrPath : smokeLePath;
      const res = await pickSmokeToolBinary(tool, init || undefined);
      if (!res.canceled && res.path) {
        if (tool === 'textractor') setSmokeTrPath(res.path);
        else setSmokeLePath(res.path);
      }
    } catch (err: any) {
      setSmokeError(err?.message || '选择文件失败');
    } finally {
      setPickingSmokeTool(null);
    }
  };

  const handleSaveSmoke = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingSmoke || busy) return;
    const timeoutSec = Number(smokeTimeoutText.trim());
    const advanceSteps = Number(smokeStepsText.trim());
    if (!Number.isFinite(timeoutSec) || timeoutSec < 15 || timeoutSec > 300) {
      setSmokeError('单次超时需在 15–300 秒之间。');
      return;
    }
    if (!Number.isFinite(advanceSteps) || advanceSteps < 3 || advanceSteps > 100) {
      setSmokeError('剧情推进步数需在 3–100 步之间。');
      return;
    }
    setSavingSmoke(true);
    setSmokeError('');
    setSmokeMessage('');
    try {
      const next = await updateSmokeConfig({
        enabled: smokeEnabled,
        visionEnabled: smokeVisionEnabled,
        textractorPath: smokeTrPath.trim(),
        localeEmulatorPath: smokeLePath.trim(),
        timeoutSec: Math.round(timeoutSec),
        advanceSteps: Math.round(advanceSteps),
      });
      setSmokeState(next);
      setSmokeTrPath(next.global.textractorPath);
      setSmokeLePath(next.global.localeEmulatorPath);
      const msg = next.effective.enabled
        ? '已保存并启用运行时冒烟测试门禁（vn_accept 将校验冒烟报告）。'
        : '已保存运行时冒烟测试配置（门禁当前关闭，可手动调用 vn_smoke_test）。';
      setSmokeMessage(msg);
      onShowToast?.({ tone: 'success', title: '冒烟测试配置已保存', message: msg, durationMs: 6500 });
    } catch (err: any) {
      setSmokeError(err?.message || '保存冒烟测试配置失败');
    } finally {
      setSavingSmoke(false);
    }
  };

  React.useEffect(() => {
    if (!isOpen || !latestSmokeConfig) return;
    setSmokeState((prev) =>
      prev
        ? { ...prev, workspaceOverride: latestSmokeConfig.workspaceOverride, effective: latestSmokeConfig.effective, tools: latestSmokeConfig.tools }
        : latestSmokeConfig
    );
  }, [isOpen, latestSmokeConfig]);

  const wasOpenRef = React.useRef(false);
  const initializedForOpenRef = React.useRef(false);
  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const modelRef = React.useRef(model);
  modelRef.current = model;
  const baseUrlRef = React.useRef(baseUrl);
  baseUrlRef.current = baseUrl;
  const ollamaPathRef = React.useRef(ollamaPath);
  ollamaPathRef.current = ollamaPath;
  const concurrencyTextRef = React.useRef(concurrencyText);
  concurrencyTextRef.current = concurrencyText;
  const onOllamaSyncSeqRef = React.useRef(onOllamaSyncSeq);
  onOllamaSyncSeqRef.current = onOllamaSyncSeq;
  const autoBootstrappedRef = React.useRef(false);
  const ollamaOpSeqRef = React.useRef(0);

  React.useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!isOpen) {
      initializedForOpenRef.current = false;
      autoBootstrappedRef.current = false;
      ollamaOpSeqRef.current += 1;
      setOllamaBusy(null);
      return;
    }

    if (justOpened) {
      initializedForOpenRef.current = false;
      autoBootstrappedRef.current = false;
      setOllamaBusy(null);
      setOllamaStatus(null);
      setApiKeyDraft('');
      setClearApiKey(false);
      setStatusMessage('');
      setSubmitError('');
      setBaseUrlError('');
      setModelError('');
      setPacketLinesError('');
      setConcurrencyError('');
    }

    const g = translatorConfig?.global;
    if (g && !initializedForOpenRef.current) {
      initializedForOpenRef.current = true;
      setMode(g.mode);
      setBaseUrl(g.baseUrl || 'http://127.0.0.1:11434/v1');
      setOllamaPath(g.ollamaPath || '');
      setModel(g.model || '');
      setPreset(g.preset);
      setPacketLinesText(String(g.packetLines));
      setConcurrencyText(String(g.concurrency));
      setEscalateFailedRows(g.escalateFailedRows);
      setUseTmCache(g.useTmCache);
      setDisableThinking(g.disableThinking);
    }
  }, [isOpen, translatorConfig]);

  const endpointPresets =
    translatorConfig?.endpointPresets && translatorConfig.endpointPresets.length > 0
      ? translatorConfig.endpointPresets
      : FALLBACK_ENDPOINT_PRESETS;

  const isLoopbackTarget = isLoopbackHttpUrl(baseUrl);
  const isDefaultOllamaTarget = isDefaultLocalOllamaUrl(baseUrl);
  const currentOrigin = getUrlOriginSafe(baseUrl);
  const matchedOllamaStatus =
    ollamaStatus && currentOrigin && ollamaStatus.origin === currentOrigin ? ollamaStatus : null;
  const isLocalOllamaTarget =
    isDefaultOllamaTarget ||
    (isLoopbackTarget &&
      (Boolean(matchedOllamaStatus?.isLocalTarget) || ollamaPath.trim().length > 0));
  const anyOllamaControlBusy =
    probing || savingTranslator || busy || pickingOllamaPath || ollamaBusy !== null;

  // Lightweight read-only probe for custom-port loopback URLs so non-11434 local Ollama instances are detected
  React.useEffect(() => {
    if (!isOpen || mode !== 'local_mt' || !isLoopbackTarget || isDefaultOllamaTarget) {
      return undefined;
    }
    const targetUrl = baseUrl.trim();
    const targetPath = ollamaPath.trim();
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchLocalOllamaStatus({ baseUrl: targetUrl, ollamaPath: targetPath }, controller.signal)
        .then((st) => {
          if (controller.signal.aborted || !isOpenRef.current) return;
          if (getUrlOriginSafe(baseUrlRef.current) !== getUrlOriginSafe(targetUrl)) return;
          setOllamaStatus(st);
        })
        .catch(() => {
          // Ignore probe errors for non-Ollama loopback endpoints (e.g. LM Studio)
        });
    }, 320);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl, isDefaultOllamaTarget, isLoopbackTarget, isOpen, mode, ollamaPath]);

  const applyDetectedModels = React.useCallback(
    (
      nextModels: Array<{ id: string; name: string }>,
      suggested: string | null,
      prefixMessage?: string
    ) => {
      setProbedModels(nextModels);
      if (nextModels.length === 0) {
        setStatusMessage(
          prefixMessage
            ? `${prefixMessage} 尚未检测到任何本地模型，请先通过 ollama pull 下载后再探测。`
            : '已连接 Ollama 服务，但当前未检测到任何已下载的本地模型。'
        );
        return;
      }
      const autoPick = suggested || nextModels[0]?.id || '';
      if (!modelRef.current.trim() && autoPick) {
        setModel(autoPick);
        setModelError('');
        setStatusMessage(
          `${prefixMessage ? `${prefixMessage} ` : ''}已检测到 ${nextModels.length} 个本地模型，并自动填入：${autoPick}。`
        );
      } else {
        setStatusMessage(
          `${prefixMessage ? `${prefixMessage} ` : ''}已检测到 ${nextModels.length} 个本地模型。`
        );
      }
    },
    []
  );

  const runStartOrRestartOllama = React.useCallback(
    async (opts?: { baseUrlOverride?: string; ollamaPathOverride?: string; forceRestart?: boolean }) => {
      const targetUrl = (opts?.baseUrlOverride ?? baseUrlRef.current).trim() || 'http://127.0.0.1:11434/v1';
      const targetPath = opts?.ollamaPathOverride !== undefined ? opts.ollamaPathOverride : ollamaPathRef.current;
      const parsedConc = Number(concurrencyTextRef.current.trim());
      const conc =
        Number.isInteger(parsedConc) && parsedConc >= 1 && parsedConc <= 8 ? parsedConc : 3;
      const restarting = Boolean(opts?.forceRestart);
      const opSeq = ++ollamaOpSeqRef.current;

      setSubmitError('');
      setOllamaBusy(restarting ? 'restarting' : 'starting');
      setStatusMessage(
        restarting
          ? `正在后台重启本机 Ollama 并应用最优参数（并发=${conc}，FA=1 / KV=q8_0 / CTX=2048；若原手动终端窗口退出属正常接管）…`
          : `正在后台自动启动本机 Ollama（并发=${conc}，FA=1 / KV=q8_0 / CTX=2048）并扫描本地模型…`
      );
      try {
        const res = await startLocalOllama({
          baseUrl: targetUrl,
          ollamaPath: targetPath.trim(),
          concurrency: conc,
          forceRestart: restarting,
        });
        if (typeof res.ollamaSync?.syncSeq === 'number') {
          onOllamaSyncSeqRef.current?.(res.ollamaSync.syncSeq);
        }
        if (!isOpenRef.current || opSeq !== ollamaOpSeqRef.current) return;
        setOllamaStatus(res.status);
        if (!res.ok) {
          setSubmitError(res.ollamaSync.message || '自动启动本机 Ollama 失败，请检查 Ollama 程序路径。');
          setStatusMessage('');
          return;
        }
        applyDetectedModels(res.models, res.suggestedModel, res.ollamaSync.message);
      } catch (err) {
        if (!isOpenRef.current || opSeq !== ollamaOpSeqRef.current) return;
        setSubmitError(err instanceof Error ? err.message : '启动本机 Ollama 服务失败');
        setStatusMessage('');
      } finally {
        if (opSeq === ollamaOpSeqRef.current) {
          setOllamaBusy(null);
        }
      }
    },
    [applyDetectedModels]
  );

  React.useEffect(() => {
    if (!isOpen || mode !== 'local_mt' || !isDefaultOllamaTarget || autoBootstrappedRef.current) {
      return undefined;
    }
    autoBootstrappedRef.current = true;
    const targetUrl = baseUrlRef.current.trim() || 'http://127.0.0.1:11434/v1';
    const targetPath = ollamaPathRef.current.trim();
    const opSeq = ++ollamaOpSeqRef.current;

    let cancelled = false;
    void (async () => {
      setOllamaBusy('checking');
      try {
        const st = await fetchLocalOllamaStatus({ baseUrl: targetUrl, ollamaPath: targetPath });
        if (cancelled || !isOpenRef.current || opSeq !== ollamaOpSeqRef.current) return;
        setOllamaStatus(st);
        if (st.running) {
          applyDetectedModels(st.models, st.suggestedModel);
          return;
        }
        if (st.isLocalTarget && st.binaryPath) {
          setOllamaBusy('starting');
          setStatusMessage('检测到本机 Ollama 尚未运行，正在后台自动启动并拉取可用模型…');
          const parsedConc = Number(concurrencyTextRef.current.trim());
          const conc =
            Number.isInteger(parsedConc) && parsedConc >= 1 && parsedConc <= 8 ? parsedConc : 3;
          const started = await startLocalOllama({
            baseUrl: targetUrl,
            ollamaPath: targetPath,
            concurrency: conc,
            forceRestart: false,
          });
          if (typeof started.ollamaSync?.syncSeq === 'number') {
            onOllamaSyncSeqRef.current?.(started.ollamaSync.syncSeq);
          }
          if (cancelled || !isOpenRef.current || opSeq !== ollamaOpSeqRef.current) return;
          setOllamaStatus(started.status);
          if (started.ok) {
            applyDetectedModels(started.models, started.suggestedModel, started.ollamaSync.message);
          } else {
            setSubmitError(started.ollamaSync.message || '自动拉起本机 Ollama 失败。');
            setStatusMessage('');
          }
        }
      } catch {
        // Silent fallback: user can still inspect status / browse path / probe manually
      } finally {
        if (opSeq === ollamaOpSeqRef.current) {
          setOllamaBusy(null);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (opSeq === ollamaOpSeqRef.current) {
        setOllamaBusy(null);
      }
    };
  }, [applyDetectedModels, isDefaultOllamaTarget, isOpen, mode]);

  const capturePointer = (e: React.PointerEvent) => {
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleBrowseOllamaPath = async () => {
    if (anyOllamaControlBusy) return;
    setSubmitError('');
    setPickingOllamaPath(true);
    let pickedPath: string | null = null;
    try {
      const res = await pickOllamaBinary(ollamaPath.trim() || ollamaStatus?.binaryPath || undefined);
      if (!res.canceled && res.path) {
        pickedPath = res.path;
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '打开本机文件选择器失败');
    } finally {
      setPickingOllamaPath(false);
    }
    if (pickedPath && isOpenRef.current) {
      setOllamaPath(pickedPath);
      await runStartOrRestartOllama({
        ollamaPathOverride: pickedPath,
        forceRestart: Boolean(ollamaStatus?.running),
      });
    }
  };

  const handleProbeEndpoint = async () => {
    const trimmedUrl = baseUrl.trim();
    if (!trimmedUrl) {
      setBaseUrlError('请先填写本地模型端点 URL。');
      baseUrlInputRef.current?.focus();
      return;
    }
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('bad scheme');
      }
    } catch {
      setBaseUrlError('端点 URL 必须以 http:// 或 https:// 开头。');
      baseUrlInputRef.current?.focus();
      return;
    }

    setBaseUrlError('');
    setSubmitError('');
    setProbing(true);
    const parsedConc = Number(concurrencyText.trim());
    const conc =
      Number.isInteger(parsedConc) && parsedConc >= 1 && parsedConc <= 8 ? parsedConc : undefined;
    const willProbeLocalOllama =
      isDefaultLocalOllamaUrl(trimmedUrl) ||
      (isLoopbackHttpUrl(trimmedUrl) &&
        (Boolean(matchedOllamaStatus?.isLocalTarget) || ollamaPath.trim().length > 0));
    setStatusMessage(
      willProbeLocalOllama && !ollamaStatus?.running
        ? '正在检查并自动拉起本机 Ollama 后探测模型…'
        : '正在探测本地端点可用模型…'
    );
    try {
      const res = await probeLocalTranslator(trimmedUrl, {
        apiKey: apiKeyDraft || undefined,
        ollamaPath: ollamaPath.trim(),
        autoStartOllama: true,
        concurrency: conc,
      });
      if (typeof res.ollamaSyncSeq === 'number') {
        onOllamaSyncSeqRef.current?.(res.ollamaSyncSeq);
      }
      if (isLoopbackHttpUrl(trimmedUrl)) {
        void fetchLocalOllamaStatus({ baseUrl: trimmedUrl, ollamaPath: ollamaPath.trim() })
          .then((st) => {
            if (isOpenRef.current) setOllamaStatus(st);
          })
          .catch(() => undefined);
      }
      const note = res.ollamaAutoStarted
        ? `Ollama 已自动在后台启动${res.ollamaVersion ? ` (v${res.ollamaVersion})` : ''}。`
        : undefined;
      applyDetectedModels(res.models, res.suggestedModel ?? null, note);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '探测本地端点失败');
      setStatusMessage('');
      if (isLoopbackHttpUrl(trimmedUrl)) {
        void fetchLocalOllamaStatus({ baseUrl: trimmedUrl, ollamaPath: ollamaPath.trim() })
          .then((st) => {
            if (isOpenRef.current) setOllamaStatus(st);
          })
          .catch(() => undefined);
      }
    } finally {
      setProbing(false);
    }
  };

  const handleSaveTranslator = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError('');
    setStatusMessage('');

    let nextBaseUrlError = '';
    let nextModelError = '';
    let nextPacketError = '';
    let nextConcurrencyError = '';
    let firstInvalid: HTMLInputElement | null = null;

    const trimmedUrl = baseUrl.trim();
    const trimmedModel = model.trim();
    const parsedPacket = Number(packetLinesText.trim());
    const parsedConcurrency = Number(concurrencyText.trim());

    if (mode === 'local_mt') {
      if (!trimmedUrl) {
        nextBaseUrlError = '本地翻译模式需要填写本地端点 URL。';
        firstInvalid = firstInvalid ?? baseUrlInputRef.current;
      } else {
        try {
          const parsed = new URL(trimmedUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('bad protocol');
          }
        } catch {
          nextBaseUrlError = '请输入合法的 http:// 或 https:// 本地端点地址。';
          firstInvalid = firstInvalid ?? baseUrlInputRef.current;
        }
      }

      if (!trimmedModel) {
        nextModelError = '请填写或探测选择本地翻译模型 ID。';
        firstInvalid = firstInvalid ?? modelInputRef.current;
      }

      if (!Number.isInteger(parsedPacket) || parsedPacket < 1 || parsedPacket > 50) {
        nextPacketError = '单包行数需为 1 到 50 之间的整数。';
        firstInvalid = firstInvalid ?? packetLinesInputRef.current;
      }

      if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1 || parsedConcurrency > 8) {
        nextConcurrencyError = '本地并发通道需为 1 到 8 之间的整数。';
        firstInvalid = firstInvalid ?? concurrencyInputRef.current;
      }
    }

    setBaseUrlError(nextBaseUrlError);
    setModelError(nextModelError);
    setPacketLinesError(nextPacketError);
    setConcurrencyError(nextConcurrencyError);

    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const restartingLocalOllama =
      mode === 'local_mt' &&
      (isDefaultLocalOllamaUrl(trimmedUrl) ||
        (isLoopbackHttpUrl(trimmedUrl) &&
          (Boolean(matchedOllamaStatus?.isLocalTarget) || ollamaPath.trim().length > 0)));
    setSavingTranslator(true);
    setStatusMessage(
      restartingLocalOllama
        ? `正在保存配置并在后台重启本机 Ollama（并发=${parsedConcurrency}，FA=1 / KV=q8_0 / CTX=2048；若原手动终端窗口消失属正常后台接管）…`
        : '正在保存翻译引擎配置…'
    );
    try {
      const updated = await updateTranslatorConfig({
        mode,
        baseUrl: trimmedUrl,
        ...(mode === 'local_mt' ? { ollamaPath: ollamaPath.trim() } : {}),
        model: trimmedModel,
        ...(clearApiKey
          ? { clearApiKey: true }
          : apiKeyDraft.trim()
            ? { apiKey: apiKeyDraft.trim() }
            : {}),
        preset,
        ...(mode === 'local_mt'
          ? {
              packetLines: parsedPacket,
              concurrency: parsedConcurrency,
              escalateFailedRows,
              useTmCache,
              disableThinking,
            }
          : {}),
      });
      if (typeof updated.ollamaSync?.syncSeq === 'number') {
        onOllamaSyncSeqRef.current?.(updated.ollamaSync.syncSeq);
      }
      onTranslatorConfigUpdated(updated);
      setApiKeyDraft('');
      setClearApiKey(false);

      if (updated.ollamaSync?.status === 'failed') {
        setSubmitError(`翻译配置已保存，但自动重启/拉起本机 Ollama 失败：${updated.ollamaSync.message}`);
        setStatusMessage('');
        return;
      }

      const toastPayload: Omit<ToastItem, 'id'> =
        updated.ollamaSync?.status === 'restarted' || updated.ollamaSync?.status === 'started'
          ? {
              tone: 'success',
              title: 'Ollama 后台服务已就绪，配置已生效',
              message: `模型 ${updated.effective.model || 'Ollama'} 正在后台托管运行${updated.ollamaSync.version ? `（v${updated.ollamaSync.version}）` : ''}，并发=${updated.ollamaSync.concurrency}（FA=1 / KV=q8_0 / CTX=2048）。`,
              durationMs: 7500,
            }
          : {
              tone: 'success',
              title: '翻译配置已生效',
              message:
                updated.effective.mode === 'local_mt'
                  ? `已切换至本地翻译模型：${updated.effective.model || '未命名'}（并发 ${updated.effective.concurrency}）`
                  : '已切换至默认云端 Subagent 批译模式。',
              durationMs: 6500,
            };

      setStatusMessage(`${toastPayload.title}：${toastPayload.message}`);
      if (onShowToast) {
        onShowToast(toastPayload);
        onClose();
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '保存翻译配置失败');
      setStatusMessage('');
    } finally {
      setSavingTranslator(false);
    }
  };

  const workspaceOverride = translatorConfig?.workspaceOverride;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="设置"
      maxWidthClass="max-w-[34rem]"
      icon={<SlidersHorizontal className="size-4 text-string" aria-hidden="true" />}
    >
      <div className="space-y-6 p-5">
        <fieldset className="space-y-2.5">
          <legend className="text-xs font-semibold text-ink-2">外观</legend>
          <div className="space-y-2" onPointerDown={capturePointer}>
            <label className="pc-radio-card">
              <input
                type="radio"
                name="color-scheme"
                value="system"
                checked={preference === 'system'}
                data-autofocus=""
                onChange={() => onSelectScheme('system', lastPointerRef.current)}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">{systemLabel}</span>
                <span className="text-xs text-ink-3">随操作系统浅色与深色自动切换</span>
              </span>
            </label>

            <label className="pc-radio-card">
              <input
                type="radio"
                name="color-scheme"
                value="light"
                checked={preference === 'light'}
                onChange={() => onSelectScheme('light', lastPointerRef.current)}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">浅色「纸」</span>
                <span className="text-xs text-ink-3">暖象牙纸底配朱红细线</span>
              </span>
            </label>

            <label className="pc-radio-card">
              <input
                type="radio"
                name="color-scheme"
                value="dark"
                checked={preference === 'dark'}
                onChange={() => onSelectScheme('dark', lastPointerRef.current)}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">深色「夜」</span>
                <span className="text-xs text-ink-3">夜蓝墨底配亮朱红弦</span>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-1 border-t border-line pt-4">
          <legend className="sr-only">动效偏好</legend>
          <label className="pc-checkbox-label">
            <input
              type="checkbox"
              name="ambient-motion"
              checked={ambientEnabled}
              onChange={(e) => onToggleAmbient(e.target.checked)}
              className="size-4 shrink-0"
            />
            <span className="text-[0.8125rem] font-medium text-ink">环境动效</span>
          </label>
          <p className="pl-6 text-xs text-ink-3">
            控制空状态红线波动与界面过渡动效；系统开启减弱动态效果时将自动静止。
          </p>
        </fieldset>

        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          <div className="min-w-0">
            <div className="text-[0.8125rem] font-medium text-ink">云端模型凭据</div>
            <p className="text-xs text-ink-3">配置主控 Agent、逆向与语义校对使用的云端 API Key（本地持久化，重启自动恢复）</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onClose();
              onOpenApiKey();
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-well px-3.5 py-2 text-xs font-medium text-ink transition-colors hover:border-string hover:text-string-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
          >
            <KeyRound className="size-3.5" aria-hidden="true" />
            <span>管理 API Key</span>
          </button>
        </div>

        <form
          aria-labelledby={translatorHeadingId}
          onSubmit={(e) => void handleSaveTranslator(e)}
          noValidate
          className="space-y-4 border-t border-line pt-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 id={translatorHeadingId} className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
              <Cpu className="size-3.5 text-string" aria-hidden="true" />
              <span>Translator 翻译引擎</span>
            </h3>
            {translatorConfig?.effective && (
              <span className="rounded-full border border-line bg-well px-2 py-0.5 font-mono text-[11px] text-ink-2">
                {translatorConfig.effective.mode === 'local_mt' ? '本地 MT' : '云端 Subagent'}
              </span>
            )}
          </div>

          {workspaceOverride && (
            <div className="rounded-xl border border-string/35 bg-string-soft/45 px-3 py-2 text-xs text-ink-2">
              当前工作区配置文件（<span className="font-mono">papercup.toml [vn.translator]</span>）正在覆盖全局设置，实际生效模式为{' '}
              <span className="font-mono font-medium text-ink">
                {translatorConfig?.effective.mode === 'local_mt'
                  ? `local_mt (${translatorConfig.effective.model || '未指定'})`
                  : 'cloud_subagent'}
              </span>
              。
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-ink-2">翻译路由模式</legend>
            <label className="pc-radio-card">
              <input
                type="radio"
                name="translatorMode"
                value="cloud_subagent"
                checked={mode === 'cloud_subagent'}
                disabled={savingTranslator || busy}
                onChange={() => {
                  setMode('cloud_subagent');
                  setBaseUrlError('');
                  setModelError('');
                  setPacketLinesError('');
                  setConcurrencyError('');
                  setSubmitError('');
                }}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">云端 Subagent（原有模式）</span>
                <span className="text-xs text-ink-3">由主模型同源的云端 Subagent 批译 JSONL，适合短篇或高质量一步到位</span>
              </span>
            </label>

            <label className="pc-radio-card">
              <input
                type="radio"
                name="translatorMode"
                value="local_mt"
                checked={mode === 'local_mt'}
                disabled={savingTranslator || busy}
                onChange={() => {
                  autoBootstrappedRef.current = false;
                  setMode('local_mt');
                  setSubmitError('');
                }}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">本地翻译专用模型 + 确定性交接</span>
                <span className="text-xs text-ink-3">程序剥离/还原控制符与引号、TM 去重并投喂本地纯文本，仅 QA 失败行升舱云端</span>
              </span>
            </label>
          </fieldset>

          {mode === 'local_mt' && (
            <div className="space-y-4 rounded-2xl border border-line bg-sheet/55 p-3.5">
              {isLocalOllamaTarget && (
                <div className="space-y-2 rounded-xl border border-line bg-well/75 p-3 text-xs">
                  {ollamaBusy ? (
                    <div className="flex items-center gap-2 text-ink">
                      <progress className="pc-spinner text-string" aria-hidden="true" />
                      <span className="font-medium">
                        {ollamaBusy === 'checking'
                          ? '正在检测本机 Ollama 服务与模型列表…'
                          : ollamaBusy === 'restarting'
                            ? '正在后台重启并接管 Ollama（原手动终端窗口消失属正常切换）…'
                            : '正在后台自动启动本机 Ollama 服务并扫描模型…'}
                      </span>
                    </div>
                  ) : ollamaStatus?.running ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="size-2 shrink-0 rounded-full bg-ok" aria-hidden="true" />
                        <span className="font-medium text-ink">本机 Ollama 后台运行中</span>
                        {ollamaStatus.version && (
                          <span className="rounded-full border border-line bg-sheet px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
                            v{ollamaStatus.version}
                          </span>
                        )}
                        {ollamaStatus.managedByPaperCup && (
                          <span className="rounded-full border border-ok/35 bg-ok-soft px-1.5 py-0.5 text-[10.5px] font-medium text-ok">
                            Paper Cup 后台托管
                          </span>
                        )}
                        <span className="text-[11px] text-ink-3">
                          {probedModels.length > 0 ? `${probedModels.length} 个模型可用` : '暂无本地模型'}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={anyOllamaControlBusy}
                        onClick={() => void runStartOrRestartOllama({ forceRestart: true })}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line-strong bg-sheet px-2 py-1 text-[11px] font-medium text-ink transition-colors hover:border-string hover:text-string-ink disabled:opacity-45 cursor-pointer"
                      >
                        <RotateCw className="size-3" aria-hidden="true" />
                        <span>重启服务</span>
                      </button>
                    </div>
                  ) : ollamaStatus && (!ollamaStatus.binaryPath || ollamaStatus.invalidCustomPath) ? (
                    <div role="status" className="flex items-start gap-2 text-danger">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <div className="space-y-0.5">
                        <div className="font-medium">
                          {ollamaStatus.invalidCustomPath
                            ? '指定的 Ollama 程序路径无效'
                            : '未在本机检测到 Ollama 可执行文件'}
                        </div>
                        <p className="text-[11px] leading-4 text-ink-2">
                          {ollamaStatus.invalidCustomPath
                            ? '请重新点击下方「浏览…」选择正确的 ollama.exe，或清空路径以恢复自动检测。'
                            : '请先安装 Ollama，或在下方输入框填写 / 点击「浏览…」手动指定本机 ollama.exe 路径；选好后将自动后台拉起。'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5 text-ink-2">
                        <span className="size-2 shrink-0 rounded-full bg-warn" aria-hidden="true" />
                        <span>本机 Ollama 未运行（探测或保存时将自动在后台启动）</span>
                      </div>
                      <button
                        type="button"
                        disabled={anyOllamaControlBusy}
                        onClick={() => void runStartOrRestartOllama({ forceRestart: false })}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-string/45 bg-string-soft px-2.5 py-1 text-[11px] font-medium text-string-ink transition-colors hover:bg-string hover:text-on-string disabled:opacity-45 cursor-pointer"
                      >
                        <Play className="size-3" aria-hidden="true" />
                        <span>一键启动并探测</span>
                      </button>
                    </div>
                  )}

                  {!ollamaBusy && ollamaStatus?.running && ollamaStatus.models.length === 0 && probedModels.length === 0 && (
                    <div
                      role="status"
                      className="rounded-lg border border-warn/45 bg-warn-soft/55 px-2.5 py-2 text-[11px] leading-4 text-ink"
                    >
                      <div className="font-medium text-warn">服务已启动，但本机尚未检测到任何已拉取的本地模型</div>
                      <p className="mt-0.5 text-ink-2">
                        请先运行 <code className="font-mono">ollama pull hf.co/SakuraLLM/Sakura-7B-Qwen2.5-v1.0-GGUF</code> 等命令下载模型，或确认自定义 <code className="font-mono">OLLAMA_MODELS</code> 目录配置正确，再点「探测模型」。
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor={baseUrlInputId} className="block text-xs font-medium text-ink-2">
                  本地 OpenAI 兼容端点 URL
                  <span className="ml-1 text-string-ink" aria-hidden="true">
                    *
                  </span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {endpointPresets.map((ep) => (
                    <button
                      key={ep.id}
                      type="button"
                      disabled={anyOllamaControlBusy}
                      onClick={() => {
                        setBaseUrl(ep.baseUrl);
                        setBaseUrlError('');
                      }}
                      className={cn(
                        'rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-45',
                        baseUrl.trim() === ep.baseUrl
                          ? 'border-string bg-string-soft text-string-ink'
                          : 'border-line bg-well text-ink-2 hover:border-line-strong hover:text-ink'
                      )}
                    >
                      {ep.name}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    ref={baseUrlInputRef}
                    id={baseUrlInputId}
                    name="translatorBaseUrl"
                    type="url"
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      if (baseUrlError) setBaseUrlError('');
                    }}
                    disabled={savingTranslator || busy}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="next"
                    placeholder="http://127.0.0.1:11434/v1"
                    aria-invalid={baseUrlError ? 'true' : undefined}
                    aria-describedby={baseUrlError ? `${baseUrlHintId} ${baseUrlErrorId}` : baseUrlHintId}
                    className="h-10 min-w-0 flex-1 rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleProbeEndpoint()}
                    disabled={anyOllamaControlBusy}
                    className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-sheet px-3 text-xs font-medium text-ink transition-colors hover:border-string hover:text-string-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                  >
                    <RefreshCw className={cn('size-3.5', (probing || ollamaBusy === 'starting') && 'animate-spin')} aria-hidden="true" />
                    <span>
                      {probing
                        ? '探测中…'
                        : isLocalOllamaTarget && ollamaStatus && !ollamaStatus.running
                          ? '启动并探测'
                          : '探测模型'}
                    </span>
                  </button>
                </div>
                <p id={baseUrlHintId} className="text-[11px] leading-4 text-ink-3">
                  支持 Ollama、LM Studio、llama.cpp、vLLM 等本地 OpenAI 兼容服务；指向本机 Ollama 时无需手动开启终端窗口。
                </p>
                {baseUrlError && (
                  <p id={baseUrlErrorId} className="text-[11px] text-danger">
                    {baseUrlError}
                  </p>
                )}
              </div>

              {isLocalOllamaTarget && (
                <div className="space-y-1.5">
                  <label htmlFor={ollamaPathInputId} className="block text-xs font-medium text-ink-2">
                    本机 Ollama 程序路径（可选，留空自动检测）
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id={ollamaPathInputId}
                      name="ollamaExecutablePath"
                      type="text"
                      value={ollamaPath}
                      onChange={(e) => setOllamaPath(e.target.value)}
                      disabled={anyOllamaControlBusy}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder={
                        ollamaStatus?.binaryPath
                          ? `自动检测：${ollamaStatus.binaryPath}`
                          : '留空自动检测，或输入 / 浏览选择 ollama.exe'
                      }
                      aria-describedby={ollamaPathHintId}
                      className="h-10 min-w-[12rem] flex-1 rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => void handleBrowseOllamaPath()}
                      disabled={anyOllamaControlBusy}
                      title="通过系统文件选择器选择 ollama.exe"
                      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-sheet px-3 text-xs font-medium text-ink transition-colors hover:border-string hover:text-string-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                    >
                      {pickingOllamaPath ? (
                        <>
                          <progress className="pc-spinner text-string" aria-label="等待选择 Ollama 文件" />
                          <span>选择中</span>
                        </>
                      ) : (
                        <>
                          <FolderOpen className="size-3.5 text-string" aria-hidden="true" />
                          <span>浏览…</span>
                        </>
                      )}
                    </button>
                  </div>
                  <p id={ollamaPathHintId} className="text-[11px] leading-4 text-ink-3">
                    输入或选择 <code className="font-mono">ollama.exe</code> 后，服务将在后台自动启动并扫描模型；重装或自定义安装路径时可直接指定。
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor={modelInputId} className="block text-xs font-medium text-ink-2">
                  本地模型 ID
                  <span className="ml-1 text-string-ink" aria-hidden="true">
                    *
                  </span>
                </label>
                <input
                  ref={modelInputRef}
                  id={modelInputId}
                  name="translatorModel"
                  type="text"
                  list={modelsDatalistId}
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    if (modelError) setModelError('');
                  }}
                  disabled={savingTranslator || busy}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="next"
                  placeholder="如 sakura-14b-qwen2.5-v1.0 或 hy-mt1.5-7b"
                  aria-invalid={modelError ? 'true' : undefined}
                  aria-describedby={modelError ? `${modelHintId} ${modelErrorId}` : modelHintId}
                  className="h-10 w-full rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none"
                />
                <datalist id={modelsDatalistId}>
                  {probedModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </datalist>
                {probedModels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {probedModels.slice(0, 8).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        disabled={savingTranslator || busy}
                        onClick={() => {
                          setModel(m.id);
                          setModelError('');
                        }}
                        className={cn(
                          'rounded-lg border px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer',
                          model.trim() === m.id
                            ? 'border-string bg-string-soft text-string-ink'
                            : 'border-line bg-well text-ink-2 hover:border-line-strong hover:text-ink'
                        )}
                      >
                        {m.id}
                      </button>
                    ))}
                  </div>
                )}
                <p id={modelHintId} className="text-[11px] leading-4 text-ink-3">
                  保留本地完整量化/GGUF 模型名；不可达时会直接报错中止，绝不静默改走全量云端。
                </p>
                {modelError && (
                  <p id={modelErrorId} className="text-[11px] text-danger">
                    {modelError}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor={apiKeyInputId} className="block text-xs font-medium text-ink-2">
                  本地服务密钥（可选，仅在本地网关启用鉴权时填写）
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id={apiKeyInputId}
                    name="translatorApiKey"
                    type="password"
                    value={apiKeyDraft}
                    onChange={(e) => {
                      setApiKeyDraft(e.target.value);
                      if (clearApiKey) setClearApiKey(false);
                    }}
                    disabled={savingTranslator || busy}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={
                      translatorConfig?.global.hasApiKey && !clearApiKey
                        ? '已保存本地密钥（留空保持不变）'
                        : '通常留空即可'
                    }
                    className="h-10 min-w-0 flex-1 rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none"
                  />
                  {translatorConfig?.global.hasApiKey && !clearApiKey && (
                    <button
                      type="button"
                      disabled={savingTranslator || busy}
                      onClick={() => {
                        setApiKeyDraft('');
                        setClearApiKey(true);
                      }}
                      className="h-10 shrink-0 rounded-xl border border-danger/35 px-2.5 text-xs font-medium text-danger hover:bg-danger-soft cursor-pointer"
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-ink-2">模型模板预设</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(
                    [
                      { id: 'sakura', title: 'SakuraLLM', desc: '轻小说/Gal 术语表' },
                      { id: 'hy-mt', title: 'HY-MT', desc: '混元翻译极简模板' },
                      { id: 'plain-lines', title: '通用纯行', desc: 'TranslateGemma 等' },
                    ] as const
                  ).map((opt) => (
                    <label key={opt.id} className="pc-radio-card px-2.5 py-2">
                      <input
                        type="radio"
                        name="translatorPreset"
                        value={opt.id}
                        checked={preset === opt.id}
                        disabled={savingTranslator || busy}
                        onChange={() => setPreset(opt.id)}
                        className="size-4 shrink-0"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-xs font-medium text-ink">{opt.title}</span>
                        <span className="truncate text-[11px] text-ink-3">{opt.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={packetLinesId} className="block text-xs font-medium text-ink-2">
                    单包行数（1–50）
                  </label>
                  <input
                    ref={packetLinesInputRef}
                    id={packetLinesId}
                    name="packetLines"
                    type="text"
                    inputMode="numeric"
                    value={packetLinesText}
                    onChange={(e) => {
                      setPacketLinesText(e.target.value);
                      if (packetLinesError) setPacketLinesError('');
                    }}
                    disabled={savingTranslator || busy}
                    aria-invalid={packetLinesError ? 'true' : undefined}
                    aria-describedby={packetLinesError ? packetLinesErrorId : undefined}
                    className="h-10 w-full rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink focus:border-string focus:outline-none"
                  />
                  {packetLinesError && (
                    <p id={packetLinesErrorId} className="text-[11px] text-danger">
                      {packetLinesError}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label htmlFor={concurrencyId} className="block text-xs font-medium text-ink-2">
                    本地并发通道（1–8）
                  </label>
                  <input
                    ref={concurrencyInputRef}
                    id={concurrencyId}
                    name="translatorConcurrency"
                    type="text"
                    inputMode="numeric"
                    value={concurrencyText}
                    onChange={(e) => {
                      setConcurrencyText(e.target.value);
                      if (concurrencyError) setConcurrencyError('');
                    }}
                    disabled={savingTranslator || busy}
                    aria-invalid={concurrencyError ? 'true' : undefined}
                    aria-describedby={concurrencyError ? concurrencyErrorId : undefined}
                    className="h-10 w-full rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink focus:border-string focus:outline-none"
                  />
                  {concurrencyError && (
                    <p id={concurrencyErrorId} className="text-[11px] text-danger">
                      {concurrencyError}
                    </p>
                  )}
                </div>
              </div>
              <p className="text-[11px] leading-4 text-ink-3">
                指向本机 Ollama（默认 11434 端口，亦支持自定义本机端口）时，保存配置将自动同步并发（<code>OLLAMA_NUM_PARALLEL</code>）并启用 Flash Attention、<code>q8_0</code> KV Cache 与 <code>2048</code> 上下文后重启受管 Ollama 进程使其立即生效。
              </p>

              <fieldset className="space-y-1 pt-1">
                <legend className="text-xs font-medium text-ink-2">交接与升舱策略</legend>
                <label className="pc-checkbox-label flex w-full">
                  <input
                    type="checkbox"
                    name="escalateFailedRows"
                    checked={escalateFailedRows}
                    disabled={savingTranslator || busy}
                    onChange={(e) => setEscalateFailedRows(e.target.checked)}
                    className="size-4 shrink-0"
                  />
                  <span className="text-xs text-ink">QA 失败行自动升舱至云端主模型精准修复</span>
                </label>

                <label className="pc-checkbox-label flex w-full">
                  <input
                    type="checkbox"
                    name="useTmCache"
                    checked={useTmCache}
                    disabled={savingTranslator || busy}
                    onChange={(e) => setUseTmCache(e.target.checked)}
                    className="size-4 shrink-0"
                  />
                  <span className="text-xs text-ink">启用翻译记忆去重（重复 UI / 短句零请求复用）</span>
                </label>

                <label className="pc-checkbox-label flex w-full">
                  <input
                    type="checkbox"
                    name="disableThinking"
                    checked={disableThinking}
                    disabled={savingTranslator || busy}
                    onChange={(e) => setDisableThinking(e.target.checked)}
                    className="size-4 shrink-0"
                  />
                  <span className="text-xs text-ink">请求时主动关闭思考链（自动兼容不支持的本地服务端）</span>
                </label>
              </fieldset>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2 text-xs text-danger"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          {statusMessage && !submitError && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 rounded-xl border border-ok/35 bg-ok-soft px-3 py-2 text-xs text-ok"
            >
              <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{statusMessage}</span>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={anyOllamaControlBusy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-string px-4 py-2 text-xs font-medium text-on-string transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              {savingTranslator && <progress className="pc-spinner text-on-string" aria-hidden="true" />}
              <span>
                {savingTranslator
                  ? mode === 'local_mt' && isLocalOllamaTarget
                    ? '正在重启 Ollama…'
                    : '保存中…'
                  : '保存翻译配置'}
              </span>
            </button>
          </div>
        </form>

        <form
          onSubmit={handleSaveSmoke}
          noValidate
          aria-labelledby={smokeHeadingId}
          className="space-y-4 border-t border-line pt-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 id={smokeHeadingId} className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <ShieldCheck className="size-4 text-string" aria-hidden="true" />
                <span>运行时冒烟测试（Smoke Test）</span>
              </h3>
              <p className="mt-0.5 text-xs text-ink-3">
                在隔离副本沙箱中自动启动补丁后的游戏，检测崩溃偏移、卡死、Textractor 文本乱码与多模态截图缺陷（最多 2 轮自动定位修复）。
              </p>
            </div>
          </div>

          {smokeState?.workspaceOverride && (
            <div className="rounded-xl border border-line-strong bg-well px-3 py-2 text-xs text-ink-2">
              当前工作区在 <code className="font-mono text-ink">papercup.toml [vn.smoke]</code> 中配置了覆写项，将优先于下方全局设置生效。
            </div>
          )}

          <div className="space-y-2.5">
            <label className="pc-checkbox-label flex w-full">
              <input
                type="checkbox"
                name="smokeEnabled"
                checked={smokeEnabled}
                disabled={savingSmoke || busy}
                onChange={(e) => setSmokeEnabled(e.target.checked)}
                className="size-4 shrink-0"
              />
              <span className="text-xs text-ink">
                启用冒烟测试硬门禁（启用后 <code className="font-mono">vn_accept</code> 须冒烟无 error 才放行；支持显式跳过逃生舱）
              </span>
            </label>

            <label className="pc-checkbox-label flex w-full">
              <input
                type="checkbox"
                name="smokeVisionEnabled"
                checked={smokeVisionEnabled}
                disabled={savingSmoke || busy}
                onChange={(e) => setSmokeVisionEnabled(e.target.checked)}
                className="size-4 shrink-0"
              />
              <span className="text-xs text-ink">
                启用云端多模态视觉检查（单次最多抽样 4 帧，用于定位“开始游戏”按钮及检测缺字/乱码；纯文本模型或内容审核拒答时自动降级为 warning）
              </span>
            </label>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={smokeTrInputId} className="text-xs font-medium text-ink">
                  Textractor CLI 路径（可选，填目录可自动匹配 x86/x64）
                </label>
                {smokeState && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
                      smokeState.tools.textractor.available
                        ? 'bg-ok-soft text-ok'
                        : smokeState.tools.textractor.configured
                          ? 'bg-danger-soft text-danger'
                          : 'bg-well text-ink-3'
                    )}
                  >
                    {smokeState.tools.textractor.available ? '已就绪' : smokeState.tools.textractor.configured ? '未找到' : '未配置'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  id={smokeTrInputId}
                  type="text"
                  value={smokeTrPath}
                  disabled={savingSmoke || busy}
                  onChange={(e) => setSmokeTrPath(e.target.value)}
                  placeholder="例如：D:\Tools\Textractor 或 ...\x86\TextractorCLI.exe"
                  className="w-full rounded-xl border border-field bg-well px-3 py-1.5 font-mono text-xs text-ink outline-none focus:border-string"
                />
                <button
                  type="button"
                  disabled={pickingSmokeTool !== null || savingSmoke || busy}
                  onClick={() => handlePickSmokeTool('textractor')}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-sheet px-3 py-1.5 text-xs text-ink hover:border-string hover:text-string-ink disabled:opacity-45 cursor-pointer"
                >
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                  <span>{pickingSmokeTool === 'textractor' ? '选择中…' : '浏览'}</span>
                </button>
              </div>
              {smokeState && <p className="text-[11px] text-ink-3">{smokeState.tools.textractor.note}</p>}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={smokeLeInputId} className="text-xs font-medium text-ink">
                  Locale Emulator（LEProc.exe，可选）
                </label>
                {smokeState && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
                      smokeState.tools.localeEmulator.available
                        ? 'bg-ok-soft text-ok'
                        : smokeState.tools.localeEmulator.configured
                          ? 'bg-danger-soft text-danger'
                          : 'bg-well text-ink-3'
                    )}
                  >
                    {smokeState.tools.localeEmulator.available ? '已就绪' : smokeState.tools.localeEmulator.configured ? '未找到' : '未配置'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  id={smokeLeInputId}
                  type="text"
                  value={smokeLePath}
                  disabled={savingSmoke || busy}
                  onChange={(e) => setSmokeLePath(e.target.value)}
                  placeholder="例如：D:\Tools\LocaleEmulator\LEProc.exe"
                  className="w-full rounded-xl border border-field bg-well px-3 py-1.5 font-mono text-xs text-ink outline-none focus:border-string"
                />
                <button
                  type="button"
                  disabled={pickingSmokeTool !== null || savingSmoke || busy}
                  onClick={() => handlePickSmokeTool('locale_emulator')}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-sheet px-3 py-1.5 text-xs text-ink hover:border-string hover:text-string-ink disabled:opacity-45 cursor-pointer"
                >
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                  <span>{pickingSmokeTool === 'locale_emulator' ? '选择中…' : '浏览'}</span>
                </button>
              </div>
              {smokeState && <p className="text-[11px] text-ink-3">{smokeState.tools.localeEmulator.note}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor={smokeTimeoutId} className="text-xs font-medium text-ink">
                  单次硬超时（秒，15–300）
                </label>
                <input
                  id={smokeTimeoutId}
                  type="number"
                  min={15}
                  max={300}
                  value={smokeTimeoutText}
                  disabled={savingSmoke || busy}
                  onChange={(e) => setSmokeTimeoutText(e.target.value)}
                  className="w-full rounded-xl border border-field bg-well px-3 py-1.5 text-xs text-ink outline-none focus:border-string"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={smokeStepsId} className="text-xs font-medium text-ink">
                  自动推进步数（3–100）
                </label>
                <input
                  id={smokeStepsId}
                  type="number"
                  min={3}
                  max={100}
                  value={smokeStepsText}
                  disabled={savingSmoke || busy}
                  onChange={(e) => setSmokeStepsText(e.target.value)}
                  className="w-full rounded-xl border border-field bg-well px-3 py-1.5 text-xs text-ink outline-none focus:border-string"
                />
              </div>
            </div>
          </div>

          {smokeError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2 text-xs text-danger"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{smokeError}</span>
            </div>
          )}

          {smokeMessage && !smokeError && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 rounded-xl border border-ok/35 bg-ok-soft px-3 py-2 text-xs text-ok"
            >
              <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{smokeMessage}</span>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingSmoke || busy || pickingSmokeTool !== null}
              className="inline-flex items-center gap-1.5 rounded-xl bg-string px-4 py-2 text-xs font-medium text-on-string transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              {savingSmoke && <progress className="pc-spinner text-on-string" aria-hidden="true" />}
              <span>{savingSmoke ? '保存中…' : '保存冒烟配置'}</span>
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
