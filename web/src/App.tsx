import * as React from 'react';
import { ArrowDown } from 'lucide-react';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import { Composer, DraftInjectionRequest } from '@/components/chat/Composer.js';
import { EmptyState } from '@/components/chat/EmptyState.js';
import { MessageItem } from '@/components/chat/MessageItem.js';
import { PendingQueueTimingHint } from '@/components/chat/PendingQueueTray.js';
import { ApiKeyDialog } from '@/components/dialogs/ApiKeyDialog.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { SettingsDialog } from '@/components/dialogs/SettingsDialog.js';
import { WorkspaceDialog } from '@/components/dialogs/WorkspaceDialog.js';
import { EngineeringPanel } from '@/components/engineering/EngineeringPanel.js';
import { OtherWorkspaceSessionsState, Sidebar } from '@/components/layout/Sidebar.js';
import { TopBar } from '@/components/layout/TopBar.js';
import { SubagentTaskView } from '@/components/subagent/SubagentTaskView.js';
import { Drawer } from '@/components/ui/Drawer.js';
import { ToastItem, ToastRegion } from '@/components/ui/ToastRegion.js';
import { useAmbientMotion } from '@/hooks/useAmbientMotion.js';
import { ChatMessage, CompactionEndEvent, useAgentStream } from '@/hooks/useAgentStream.js';
import { useColorScheme } from '@/hooks/useColorScheme.js';
import { useMediaQuery } from '@/hooks/useMediaQuery.js';
import {
  abortSubagentTask,
  abortTurn,
  ApiRequestError,
  cancelChatFormRequest,
  ChatImageAttachment,
  clearTurnQueue,
  compactSession,
  deleteSession,
  EngineeringStatus,
  enqueueTurnMessage,
  fetchEngineeringStatus,
  fetchModels,
  fetchSessionHistory,
  fetchTranslatorConfig,
  fetchWorkspaces,
  fetchWorkspaceSessions,
  ModelOption,
  ModelsState,
  openWorkspaceSession,
  ProviderStatusInfo,
  QueuedMessageItem,
  QueuedMessageMode,
  removeTurnQueueItem,
  resetSession,
  resolveEngineDisplay,
  RestoredDraftPayload,
  selectModel,
  selectSession,
  selectWorkspace,
  SessionHistoryState,
  SessionSummary,
  startTurn,
  submitChatForm,
  SubmitChatFormItemPayload,
  switchTurnQueueItemMode,
  ThinkingLevel,
  TranslatorConfigState,
  updateThinkingLevel,
} from '@/lib/api.js';
import { getActiveSubagentRoles } from '@/lib/toolLabels.js';
import { gsap, prefersReducedMotion } from '@/lib/gsap.js';
import { cn } from '@/lib/utils.js';

const ENGINEERING_PANEL_KEY = 'papercup:engineering-panel';
const SIDEBAR_PINNED_KEY = 'papercup:sidebar-pinned';

function readEngineeringPinned(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ENGINEERING_PANEL_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function readSidebarPinned(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SIDEBAR_PINNED_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError');
}

export function App() {
  const [activeWorkspace, setActiveWorkspace] = React.useState('');
  const [recentWorkspaces, setRecentWorkspaces] = React.useState<string[]>([]);
  const [engineeringStatus, setEngineeringStatus] = React.useState<EngineeringStatus | null>(null);
  const [models, setModels] = React.useState<ModelOption[]>([]);
  const [providers, setProviders] = React.useState<ProviderStatusInfo[]>([]);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const [isSwitchingModel, setIsSwitchingModel] = React.useState(false);
  const [thinkingLevel, setThinkingLevel] = React.useState<ThinkingLevel>('low');
  const [availableThinkingLevels, setAvailableThinkingLevels] = React.useState<ThinkingLevel[]>([]);
  const [isSwitchingThinking, setIsSwitchingThinking] = React.useState(false);
  const [translatorConfig, setTranslatorConfig] = React.useState<TranslatorConfigState | null>(null);

  const [isEngineeringPinned, setIsEngineeringPinned] = React.useState(readEngineeringPinned);
  const [isEngineeringDrawerOpen, setIsEngineeringDrawerOpen] = React.useState(false);
  const [isSidebarPinned, setIsSidebarPinned] = React.useState(readSidebarPinned);
  const [isSidebarDrawerOpen, setIsSidebarDrawerOpen] = React.useState(false);
  const [isSwitcherOpen, setIsSwitcherOpen] = React.useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = React.useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [pendingDeleteSession, setPendingDeleteSession] = React.useState<SessionSummary | null>(null);
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const toastSeqRef = React.useRef(0);

  const pushToast = React.useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `toast-${Date.now()}-${++toastSeqRef.current}`;
    setToasts((prev) => [...prev.slice(-2), { ...toast, id }]);
  }, []);

  const dismissToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const isAnyModalOpen =
    isSettingsOpen ||
    isSwitcherOpen ||
    isApiKeyModalOpen ||
    Boolean(pendingDeleteSession);
  const [isAtBottom, setIsAtBottom] = React.useState(true);
  const [hasUnreadStreamUpdate, setHasUnreadStreamUpdate] = React.useState(false);
  const [activeSubagentView, setActiveSubagentView] = React.useState<{
    taskId: string | null;
    roleFilter?: string;
  } | null>(null);
  const [otherWorkspaceSessions, setOtherWorkspaceSessions] = React.useState<
    Record<string, OtherWorkspaceSessionsState>
  >({});

  const isDesktopSidebar = useMediaQuery('(min-width: 64rem)');
  const isDesktopEngineering = useMediaQuery('(min-width: 80rem)');

  const sidebarDrawerId = React.useId();
  const engineeringDrawerId = React.useId();

  const {
    preference: schemePreference,
    setPreference: setSchemePreference,
    toggleQuickScheme,
    systemScheme,
    resolvedScheme,
  } = useColorScheme();
  const { ambientEnabled, setAmbientEnabled, motionAllowed } = useAmbientMotion();

  React.useEffect(() => {
    if (isDesktopSidebar && isSidebarDrawerOpen) {
      setIsSidebarDrawerOpen(false);
    }
  }, [isDesktopSidebar, isSidebarDrawerOpen]);

  React.useEffect(() => {
    if (isDesktopEngineering && isEngineeringDrawerOpen) {
      setIsEngineeringDrawerOpen(false);
    }
  }, [isDesktopEngineering, isEngineeringDrawerOpen]);

  const applyModelsState = React.useCallback((state: ModelsState) => {
    setModels(state.models);
    setSelectedModel(state.current);
    if (Array.isArray(state.providers)) {
      setProviders(state.providers);
    }
    if (state.thinkingLevel) {
      setThinkingLevel(state.thinkingLevel);
    }
    if (Array.isArray(state.availableThinkingLevels)) {
      setAvailableThinkingLevels(state.availableThinkingLevels);
    }
  }, []);

  const activeWorkspaceRef = React.useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const workspaceFetchEpochRef = React.useRef(0);
  const workspaceFetchAbortRef = React.useRef<AbortController | null>(null);
  const engineeringReqSeqRef = React.useRef(0);
  const otherWorkspaceSessionsRef = React.useRef(otherWorkspaceSessions);
  otherWorkspaceSessionsRef.current = otherWorkspaceSessions;
  const inFlightOtherWsRef = React.useRef<Set<string>>(new Set());

  const refreshEngineeringStatus = React.useCallback((forceRefresh = false) => {
    const epoch = workspaceFetchEpochRef.current;
    const reqSeq = ++engineeringReqSeqRef.current;
    return fetchEngineeringStatus(forceRefresh)
      .then((status) => {
        if (workspaceFetchEpochRef.current !== epoch || engineeringReqSeqRef.current !== reqSeq) {
          return;
        }
        setEngineeringStatus(status);
      })
      .catch((err) => {
        if (!isAbortError(err)) {
          console.error('Failed to load engineering status:', err);
        }
      });
  }, []);

  const hydrateFromReconnectRef = React.useRef<() => void>(() => {});
  const loadWorkspaceDataRef = React.useRef<(forceRefreshEngineering?: boolean) => void>(() => {});
  const handleStreamReconnect = React.useCallback(() => {
    hydrateFromReconnectRef.current();
  }, []);
  const handleBatchProgress = React.useCallback(() => {
    void refreshEngineeringStatus(false);
  }, [refreshEngineeringStatus]);
  const handleSkillsUpdated = React.useCallback(
    (skills: string[]) => {
      setEngineeringStatus((prev) => (prev ? { ...prev, skills } : prev));
      void refreshEngineeringStatus(true);
    },
    [refreshEngineeringStatus]
  );
  const handleSmokeConfigUpdated = React.useCallback(() => {
    void refreshEngineeringStatus(true);
  }, [refreshEngineeringStatus]);
  const handleExternalWorkspaceChanged = React.useCallback((workspace: string) => {
    if (workspace.trim().toLowerCase() !== activeWorkspaceRef.current.trim().toLowerCase()) {
      setActiveSubagentView(null);
      loadWorkspaceDataRef.current(true);
    }
  }, []);
  const handleSessionReady = React.useCallback((sid: string | null) => {
    if (sid) {
      setActiveSessionId((prev) => prev ?? sid);
    }
  }, []);
  const handleCompactionEnd = React.useCallback(
    (ev: CompactionEndEvent) => {
      if (ev.status === 'error' && ev.error && ev.reason !== 'manual') {
        pushToast({
          tone: 'warning',
          title: '上下文压缩失败',
          message: ev.error,
          durationMs: 5200,
        });
      }
    },
    [pushToast]
  );

  const {
    messages,
    isStreaming,
    isThinking,
    isCompacting,
    queuedCompaction,
    setQueuedCompaction,
    turnPhase,
    retryInfo,
    currentThinking,
    currentResponse,
    currentTools,
    pendingQueue,
    setPendingQueue,
    lastRestoredDraft,
    subagentTasks,
    activeDirectSubagentTaskId,
    activeModel,
    latestThinkingLevel,
    latestModelsState,
    latestTranslatorConfig,
    latestSmokeConfig,
    translatorSyncStatus,
    latestSessionState,
    latestSessionsList,
    tokenUsage,
    applyTokenUsage,
    chatForms,
    upsertChatForm,
    appendCompactionResult,
    hydrateSessionState,
    subscribeSubagentStream,
    subscribeSubagentQueue,
    subscribeSubagentQueueRestored,
    addUserMessage,
    removeMessage,
    addErrorMessage,
  } = useAgentStream({
    onReconnect: handleStreamReconnect,
    onBatchProgress: handleBatchProgress,
    onSkillsUpdated: handleSkillsUpdated,
    onSmokeConfigUpdated: handleSmokeConfigUpdated,
    onWorkspaceChanged: handleExternalWorkspaceChanged,
    onSessionReady: handleSessionReady,
    onCompactionEnd: handleCompactionEnd,
  });

  const [mainQueueBusyItemId, setMainQueueBusyItemId] = React.useState<string | null>(null);
  const [mainQueueClearing, setMainQueueClearing] = React.useState(false);
  const [mainQueueAnnouncement, setMainQueueAnnouncement] = React.useState('');
  const [mainDraftInjection, setMainDraftInjection] = React.useState<DraftInjectionRequest | null>(
    null
  );
  const handledMainRestoreIdsRef = React.useRef<Set<string>>(new Set());

  const applyMainRestoredDraft = React.useCallback(
    (
      restored: RestoredDraftPayload | null | undefined,
      reason: 'aborted' | 'error' | 'cleared' = 'aborted'
    ) => {
      if (!restored?.text?.trim()) return;
      if (handledMainRestoreIdsRef.current.has(restored.restoreId)) return;
      handledMainRestoreIdsRef.current.add(restored.restoreId);
      if (handledMainRestoreIdsRef.current.size > 40) {
        const first = handledMainRestoreIdsRef.current.values().next().value;
        if (first) handledMainRestoreIdsRef.current.delete(first);
      }
      setMainDraftInjection({ id: restored.restoreId, text: restored.text });
      const dropHint =
        restored.droppedFollowUpCount > 0
          ? `（已舍弃其余 ${restored.droppedFollowUpCount} 条后续排队）`
          : '';
      const message =
        reason === 'cleared'
          ? `已清空队列并将消息恢复到输入框${dropHint}`
          : `已将未送达消息恢复到输入框${dropHint}`;
      setMainQueueAnnouncement(message);
      pushToast({
        tone: 'info',
        title: '未送达指令已回填输入框',
        message,
        durationMs: 5200,
      });
    },
    [pushToast]
  );

  React.useEffect(() => {
    if (lastRestoredDraft) {
      applyMainRestoredDraft(lastRestoredDraft);
    }
  }, [lastRestoredDraft, applyMainRestoredDraft]);

  const applySessionState = React.useCallback(
    (state: SessionHistoryState) => {
      hydrateSessionState(state);
      if (state.workspace) {
        setActiveWorkspace(state.workspace);
      }
      setActiveSessionId(state.sessionId);
      if (Array.isArray(state.sessions)) {
        setSessions(state.sessions);
      }
    },
    [hydrateSessionState]
  );

  const beginWorkspaceFetchBatch = React.useCallback(() => {
    workspaceFetchAbortRef.current?.abort();
    const controller = new AbortController();
    workspaceFetchAbortRef.current = controller;
    const epoch = ++workspaceFetchEpochRef.current;
    engineeringReqSeqRef.current += 1;
    return { epoch, signal: controller.signal };
  }, []);

  React.useEffect(() => {
    return () => {
      workspaceFetchAbortRef.current?.abort();
    };
  }, []);

  hydrateFromReconnectRef.current = () => {
    const { epoch, signal } = beginWorkspaceFetchBatch();
    fetchSessionHistory(signal)
      .then((state) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        applySessionState(state);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
    fetchModels(signal)
      .then((state) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        applyModelsState(state);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
    fetchTranslatorConfig(signal)
      .then((cfg) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        setTranslatorConfig(cfg);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
    fetchEngineeringStatus(false, signal)
      .then((status) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        setEngineeringStatus(status);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
  };

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  const loadWorkspaceData = React.useCallback(
    (forceRefreshEngineering = false) => {
      const { epoch, signal } = beginWorkspaceFetchBatch();

      fetchWorkspaces(signal)
        .then((ws) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          setActiveWorkspace(ws.active);
          setRecentWorkspaces(ws.recent || [ws.active]);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error('Failed to load workspaces:', err);
        });

      fetchSessionHistory(signal)
        .then((state) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          applySessionState(state);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error('Failed to load session history:', err);
        });

      fetchModels(signal)
        .then((state) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          applyModelsState(state);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error('Failed to load models:', err);
        });

      fetchTranslatorConfig(signal)
        .then((cfg) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          setTranslatorConfig(cfg);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error('Failed to load translator config:', err);
        });

      fetchEngineeringStatus(forceRefreshEngineering, signal)
        .then((status) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          setEngineeringStatus(status);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error('Failed to load engineering status:', err);
        });
    },
    [applyModelsState, applySessionState, beginWorkspaceFetchBatch]
  );
  loadWorkspaceDataRef.current = loadWorkspaceData;

  React.useEffect(() => {
    setSelectedModel(activeModel);
  }, [activeModel]);

  React.useEffect(() => {
    if (latestThinkingLevel) {
      setThinkingLevel(latestThinkingLevel);
    }
  }, [latestThinkingLevel]);

  const wasStreamingRef = React.useRef(false);
  React.useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      void refreshEngineeringStatus(false);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, refreshEngineeringStatus]);

  React.useEffect(() => {
    if (latestModelsState) {
      applyModelsState(latestModelsState);
    }
  }, [latestModelsState, applyModelsState]);

  const seenSyncSeqsRef = React.useRef<Set<number>>(new Set());

  const markSyncSeqHandled = React.useCallback((seq: number | undefined) => {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
    seenSyncSeqsRef.current.add(seq);
    if (seenSyncSeqsRef.current.size > 60) {
      const first = seenSyncSeqsRef.current.values().next().value;
      if (first !== undefined) seenSyncSeqsRef.current.delete(first);
    }
  }, []);

  React.useEffect(() => {
    if (latestTranslatorConfig) {
      setTranslatorConfig(latestTranslatorConfig);
    }
  }, [latestTranslatorConfig]);

  React.useEffect(() => {
    if (!translatorSyncStatus) return;
    if (translatorSyncStatus.seq !== undefined) {
      if (seenSyncSeqsRef.current.has(translatorSyncStatus.seq)) {
        return;
      }
      markSyncSeqHandled(translatorSyncStatus.seq);
    }
    if (translatorSyncStatus.phase === 'ready' || translatorSyncStatus.phase === 'error') {
      void refreshEngineeringStatus(true);
    }
    if (isSettingsOpen || translatorSyncStatus.status === 'skipped') return;

    if (
      translatorSyncStatus.phase === 'ready' &&
      (translatorSyncStatus.status === 'started' || translatorSyncStatus.status === 'restarted')
    ) {
      pushToast({
        tone: 'success',
        title: 'Ollama 后台服务已就绪',
        message: translatorSyncStatus.message,
        durationMs: 7500,
      });
    } else if (translatorSyncStatus.phase === 'error') {
      pushToast({
        tone: 'warning',
        title: '本机 Ollama 自动拉起未完成',
        message: translatorSyncStatus.message,
        durationMs: 7500,
      });
    }
  }, [translatorSyncStatus, isSettingsOpen, markSyncSeqHandled, pushToast, refreshEngineeringStatus]);

  React.useEffect(() => {
    if (latestSessionState) {
      applySessionState(latestSessionState);
    }
  }, [latestSessionState, applySessionState]);

  React.useEffect(() => {
    if (latestSessionsList) {
      setActiveSessionId(latestSessionsList.sessionId);
      setSessions(latestSessionsList.sessions);
    }
  }, [latestSessionsList]);

  const handleModelChange = async (modelKey: string) => {
    setIsSwitchingModel(true);
    try {
      const updated = await selectModel(modelKey);
      applyModelsState(updated);
    } catch (err) {
      console.error('Failed to switch model:', err);
      addErrorMessage(err instanceof Error ? err.message : '切换模型失败');
    } finally {
      setIsSwitchingModel(false);
    }
  };

  const handleThinkingChange = async (level: ThinkingLevel) => {
    setIsSwitchingThinking(true);
    try {
      const updated = await updateThinkingLevel(level);
      applyModelsState(updated);
    } catch (err) {
      console.error('Failed to switch thinking level:', err);
      addErrorMessage(err instanceof Error ? err.message : '切换思考深度失败');
    } finally {
      setIsSwitchingThinking(false);
    }
  };

  const invalidateOtherWorkspaceCache = React.useCallback((wsPath: string) => {
    const lower = wsPath.toLowerCase();
    setOtherWorkspaceSessions((prev) => {
      let changed = false;
      const next: Record<string, OtherWorkspaceSessionsState> = {};
      for (const [key, val] of Object.entries(prev)) {
        if (key.toLowerCase() === lower) {
          changed = true;
          continue;
        }
        next[key] = val;
      }
      return changed ? next : prev;
    });
  }, []);

  const handleWorkspaceChanged = (newActive: string, recent: string[]) => {
    const { epoch, signal } = beginWorkspaceFetchBatch();
    setActiveWorkspace(newActive);
    setRecentWorkspaces(recent);
    setActiveSubagentView(null);
    invalidateOtherWorkspaceCache(newActive);
    fetchEngineeringStatus(false, signal)
      .then((status) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        setEngineeringStatus(status);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
    fetchSessionHistory(signal)
      .then((state) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        applySessionState(state);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
    fetchModels(signal)
      .then((state) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        applyModelsState(state);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
    fetchTranslatorConfig(signal)
      .then((cfg) => {
        if (workspaceFetchEpochRef.current !== epoch) return;
        setTranslatorConfig(cfg);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
  };

  const handleExpandOtherWorkspace = React.useCallback((wsPath: string, force = false) => {
    const cur = otherWorkspaceSessionsRef.current[wsPath];
    if (inFlightOtherWsRef.current.has(wsPath) || cur?.loading) return;
    if (cur?.loaded && !cur.error && !force) return;

    inFlightOtherWsRef.current.add(wsPath);
    setOtherWorkspaceSessions((prev) => ({
      ...prev,
      [wsPath]: {
        loading: true,
        loaded: false,
        sessions: prev[wsPath]?.sessions ?? [],
      },
    }));

    fetchWorkspaceSessions(wsPath)
      .then((res) => {
        setOtherWorkspaceSessions((prev) => ({
          ...prev,
          [wsPath]: {
            loading: false,
            loaded: true,
            sessions: res.sessions,
          },
        }));
      })
      .catch((err) => {
        setOtherWorkspaceSessions((prev) => ({
          ...prev,
          [wsPath]: {
            loading: false,
            loaded: false,
            error: err instanceof Error ? err.message : '加载失败',
            sessions: [],
          },
        }));
      })
      .finally(() => {
        inFlightOtherWsRef.current.delete(wsPath);
      });
  }, []);

  const handleOpenWorkspaceSession = async (wsPath: string, sessionId: string) => {
    if (isStreaming || isCompacting || Boolean(activeDirectSubagentTaskId)) return;
    try {
      const res = await openWorkspaceSession(wsPath, sessionId);
      const { epoch, signal } = beginWorkspaceFetchBatch();
      setActiveWorkspace(res.workspaces.active);
      setRecentWorkspaces(res.workspaces.recent || [res.workspaces.active]);
      setActiveSubagentView(null);
      invalidateOtherWorkspaceCache(res.workspaces.active);
      applySessionState(res.session);
      fetchEngineeringStatus(false, signal)
        .then((status) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          setEngineeringStatus(status);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error(err);
        });
      fetchModels(signal)
        .then((state) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          applyModelsState(state);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error(err);
        });
      fetchTranslatorConfig(signal)
        .then((cfg) => {
          if (workspaceFetchEpochRef.current !== epoch) return;
          setTranslatorConfig(cfg);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error(err);
        });
    } catch (err) {
      console.error('Failed to open workspace session:', err);
      addErrorMessage(err instanceof Error ? err.message : '打开历史工作区对话失败');
    }
  };

  const handleQuickSwitchWorkspace = async (wsPath: string) => {
    if (isStreaming || isCompacting || Boolean(activeDirectSubagentTaskId)) return;
    try {
      const res = await selectWorkspace(wsPath);
      handleWorkspaceChanged(res.active, res.recent);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
      addErrorMessage(err instanceof Error ? err.message : '切换工作区失败');
    }
  };

  const handleNewSession = async () => {
    if (isStreaming || isCompacting || Boolean(activeDirectSubagentTaskId)) return;
    try {
      setActiveSubagentView(null);
      const fresh = await resetSession();
      applySessionState(fresh);
      if (activeWorkspace) invalidateOtherWorkspaceCache(activeWorkspace);
    } catch (err) {
      console.error('Error resetting session:', err);
      addErrorMessage(err instanceof Error ? err.message : '新建对话失败');
    }
  };

  const handleSelectSession = async (sessionId: string) => {
    if (isStreaming || isCompacting || Boolean(activeDirectSubagentTaskId)) return;
    try {
      setActiveSubagentView(null);
      if (sessionId === activeSessionId) return;
      const next = await selectSession(sessionId);
      applySessionState(next);
    } catch (err) {
      console.error('Error switching session:', err);
      addErrorMessage(err instanceof Error ? err.message : '切换对话失败');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (isStreaming || isCompacting || Boolean(activeDirectSubagentTaskId)) return;
    try {
      const next = await deleteSession(sessionId);
      applySessionState(next);
      if (activeWorkspace) invalidateOtherWorkspaceCache(activeWorkspace);
    } catch (err) {
      console.error('Error deleting session:', err);
      addErrorMessage(err instanceof Error ? err.message : '删除对话失败');
    }
  };

  const confirmDeleteSession = async () => {
    if (!pendingDeleteSession) return;
    const targetId = pendingDeleteSession.id;
    setPendingDeleteSession(null);
    await handleDeleteSession(targetId);
  };

  React.useEffect(() => {
    loadWorkspaceData();
  }, [loadWorkspaceData]);

  React.useEffect(() => {
    const root = scrollRef.current;
    const sentinel = bottomRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsAtBottom(entry.isIntersecting);
        if (entry.isIntersecting) {
          setHasUnreadStreamUpdate(false);
        }
      },
      { root, rootMargin: '0px 0px 96px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeSubagentView]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (activeSubagentView) return;
    if (el && isAtBottom) {
      el.scrollTop = el.scrollHeight;
      setHasUnreadStreamUpdate(false);
    } else if (isStreaming && !isAtBottom) {
      setHasUnreadStreamUpdate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentThinking, currentResponse, currentTools, isCompacting]);

  React.useEffect(() => {
    if (!activeSubagentView || activeSubagentView.taskId || !activeSubagentView.roleFilter) {
      return;
    }
    const match = subagentTasks.find((t) => t.role === activeSubagentView.roleFilter);
    if (match) {
      setActiveSubagentView({ taskId: match.taskId, roleFilter: activeSubagentView.roleFilter });
    }
  }, [activeSubagentView, subagentTasks]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    setHasUnreadStreamUpdate(false);
    if (prefersReducedMotion()) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    gsap.to(el, {
      scrollTo: { y: 'max' },
      duration: 0.45,
      ease: 'power3.out',
      overwrite: 'auto',
    });
  };

  const handleOpenSubagentTask = (taskId: string, role?: string) => {
    setActiveSubagentView({ taskId, roleFilter: role });
  };

  const handleOpenSubagentRole = (role: string) => {
    const roleMatches = subagentTasks.filter((t) => t.role === role);
    const preferred = roleMatches.find((t) => t.status === 'running') ?? roleMatches[0];
    setActiveSubagentView({
      taskId: preferred?.taskId ?? null,
      roleFilter: role,
    });
  };

  const handleSend = async (prompt: string, images?: ChatImageAttachment[]): Promise<boolean> => {
    setActiveSubagentView(null);
    const hasImages = Boolean(images && images.length > 0);
    const optimisticText = prompt.trim() ? prompt : hasImages ? '请查看附带的图片并协助定位问题。' : prompt;
    const optimisticMsgId = addUserMessage(optimisticText, images);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    try {
      await startTurn(prompt, selectedModel || undefined, images);
      return true;
    } catch (err) {
      console.error('Error triggering turn:', err);
      removeMessage(optimisticMsgId);
      pushToast({
        tone: 'warning',
        title: '发送消息失败',
        message: err instanceof Error ? err.message : '无法连接服务端',
      });
      return false;
    }
  };

  const handleCompact = async (focus?: string): Promise<boolean> => {
    setActiveSubagentView(null);
    try {
      const res = await compactSession(focus);
      if (res.tokenUsage) {
        applyTokenUsage(res.tokenUsage);
      }
      if (res.status === 'queued') {
        const resolvedFocus = res.focus ?? focus;
        setQueuedCompaction(resolvedFocus ? { focus: resolvedFocus } : {});
        setMainQueueAnnouncement('已排队：本轮结束后压缩上下文');
        pushToast({
          tone: 'info',
          title: '已排队：本轮结束后压缩上下文',
          message: res.message || '将在当前回合完成后自动执行上下文压缩。',
          durationMs: 4200,
        });
        return true;
      }
      if (res.status === 'noop') {
        pushToast({
          tone: 'info',
          title: '当前对话较短，无需压缩',
          message: res.message || '当前上下文较短，暂无需压缩。',
          durationMs: 4000,
        });
        return true;
      }
      if (res.status === 'compacted' && res.result) {
        appendCompactionResult(res.result);
      }
      return true;
    } catch (err) {
      pushToast({
        tone: 'warning',
        title: '压缩上下文失败',
        message: err instanceof Error ? err.message : '操作失败',
        durationMs: 5200,
      });
      return false;
    }
  };

  const handleSubmitChatForm = React.useCallback(
    async (
      formId: string,
      payload: { items: SubmitChatFormItemPayload[]; dismissedNames?: string[]; autoContinue: boolean }
    ) => {
      const res = await submitChatForm(formId, {
        items: payload.items,
        ...(payload.dismissedNames?.length ? { dismissedNames: payload.dismissedNames } : {}),
        autoContinue: payload.autoContinue,
        model: selectedModel || undefined,
      });
      upsertChatForm(res.form);
      void refreshEngineeringStatus(false);

      if (res.startedTurn && res.userPrompt) {
        addUserMessage(res.userPrompt);
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
        pushToast({
          tone: 'success',
          title: '角色译名已锁定',
          message: `已锁定 ${res.form.items.length} 位角色译名（同步 ${res.glossaryEntriesAdded} 条术语），正在继续翻译…`,
        });
      } else {
        pushToast({
          tone: 'success',
          title: '角色译名已保存并锁定',
          message: `已锁定 ${res.form.items.length} 位角色译名并同步 ${res.glossaryEntriesAdded} 条术语。`,
        });
      }
    },
    [addUserMessage, pushToast, refreshEngineeringStatus, selectedModel, upsertChatForm]
  );

  const handleCancelChatForm = React.useCallback(
    async (formId: string) => {
      const res = await cancelChatFormRequest(formId);
      upsertChatForm(res.form);
      pushToast({
        tone: 'info',
        title: '已取消角色确认表单',
        message: '你可以继续在对话中指示 Paper Cup 重新整理角色表。',
      });
    },
    [pushToast, upsertChatForm]
  );

  const handleQueueSend = async (
    prompt: string,
    mode: QueuedMessageMode,
    images?: ChatImageAttachment[]
  ): Promise<boolean> => {
    try {
      const res = await enqueueTurnMessage(prompt, mode, images);
      setPendingQueue(res.queue);
      setMainQueueAnnouncement(mode === 'steer' ? '已加入插话队列' : '已加入排队队列');
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'TURN_NOT_RUNNING' && !activeDirectSubagentTaskId) {
        return handleSend(prompt, images);
      }
      pushToast({
        tone: 'warning',
        title: mode === 'steer' ? '发送插话失败' : '加入排队失败',
        message: err instanceof Error ? err.message : '操作失败',
      });
      return false;
    }
  };

  const handleSwitchMainQueueMode = async (item: QueuedMessageItem, nextMode: QueuedMessageMode) => {
    setMainQueueBusyItemId(item.id);
    try {
      const res = await switchTurnQueueItemMode(item.id, nextMode);
      setPendingQueue(res.queue);
      setMainQueueAnnouncement(nextMode === 'steer' ? '已升为插话' : '已转为排队');
    } catch (err) {
      if (err instanceof ApiRequestError && err.queue) {
        setPendingQueue(err.queue);
      }
      if (err instanceof ApiRequestError && err.code === 'ALREADY_DELIVERED') {
        setMainQueueAnnouncement('该消息已送达模型');
      } else {
        pushToast({
          tone: 'warning',
          title: '切换队列模式失败',
          message: err instanceof Error ? err.message : '操作失败',
        });
      }
    } finally {
      setMainQueueBusyItemId(null);
    }
  };

  const handleRecallMainQueueItem = async (item: QueuedMessageItem) => {
    setMainQueueBusyItemId(item.id);
    try {
      const res = await removeTurnQueueItem(item.id);
      setPendingQueue(res.queue);
      const recalledText = res.removed?.text || item.text;
      const recalledImages = res.removedImages;
      if (recalledText || (recalledImages && recalledImages.length > 0)) {
        setMainDraftInjection({
          id: `recall-${item.id}-${Date.now()}`,
          text: recalledText,
          ...(recalledImages?.length ? { images: recalledImages } : {}),
        });
        setMainQueueAnnouncement('已撤回至输入框编辑');
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.queue) {
        setPendingQueue(err.queue);
      }
      if (err instanceof ApiRequestError && err.code === 'ALREADY_DELIVERED') {
        setMainQueueAnnouncement('该消息已送达模型，无法撤回');
      } else {
        pushToast({
          tone: 'warning',
          title: '撤回队列消息失败',
          message: err instanceof Error ? err.message : '操作失败',
        });
      }
    } finally {
      setMainQueueBusyItemId(null);
    }
  };

  const handleDeleteMainQueueItem = async (item: QueuedMessageItem) => {
    setMainQueueBusyItemId(item.id);
    try {
      const res = await removeTurnQueueItem(item.id);
      setPendingQueue(res.queue);
      setMainQueueAnnouncement('已删除待投递消息');
    } catch (err) {
      if (err instanceof ApiRequestError && err.queue) {
        setPendingQueue(err.queue);
      }
      if (!(err instanceof ApiRequestError && err.code === 'ALREADY_DELIVERED')) {
        pushToast({
          tone: 'warning',
          title: '删除队列消息失败',
          message: err instanceof Error ? err.message : '操作失败',
        });
      }
    } finally {
      setMainQueueBusyItemId(null);
    }
  };

  const handleClearMainQueue = async () => {
    setMainQueueClearing(true);
    try {
      const res = await clearTurnQueue();
      setPendingQueue(res.queue);
      if (res.restoredDraft?.text) {
        applyMainRestoredDraft(res.restoredDraft, 'cleared');
      } else {
        setMainQueueAnnouncement('已清空全部待投递消息');
      }
    } catch (err) {
      pushToast({
        tone: 'warning',
        title: '清空队列失败',
        message: err instanceof Error ? err.message : '操作失败',
      });
    } finally {
      setMainQueueClearing(false);
    }
  };

  const handleAbort = async () => {
    try {
      const res = await abortTurn();
      if (res?.restoredDraft) {
        applyMainRestoredDraft(res.restoredDraft, 'aborted');
      }
    } catch (err) {
      console.error('Error aborting turn:', err);
      addErrorMessage(err instanceof Error ? err.message : '中止执行失败');
    }
  };

  const handleAbortSubagentTask = async (
    targetTaskId: string
  ): Promise<RestoredDraftPayload | null> => {
    try {
      const res = await abortSubagentTask(targetTaskId);
      return res?.restoredDraft ?? null;
    } catch (err) {
      console.error('Error aborting subagent task:', err);
      pushToast({
        tone: 'warning',
        title: '中止子代理失败',
        message: err instanceof Error ? err.message : '中止执行失败',
      });
      return null;
    }
  };

  const toggleEngineeringPanel = React.useCallback(() => {
    if (isDesktopEngineering) {
      setIsEngineeringPinned((prev) => {
        const next = !prev;
        try {
          window.localStorage.setItem(ENGINEERING_PANEL_KEY, next ? 'open' : 'closed');
        } catch {
          // Ignore storage error
        }
        return next;
      });
    } else {
      setIsEngineeringDrawerOpen((prev) => !prev);
    }
  }, [isDesktopEngineering]);

  const toggleSidebar = React.useCallback(() => {
    if (isDesktopSidebar) {
      setIsSidebarPinned((prev) => {
        const next = !prev;
        try {
          window.localStorage.setItem(SIDEBAR_PINNED_KEY, next ? 'open' : 'closed');
        } catch {
          // Ignore storage error
        }
        return next;
      });
    } else {
      setIsSidebarDrawerOpen((prev) => !prev);
    }
  }, [isDesktopSidebar]);

  const hasRunningTool = currentTools.some((t) => t.result === undefined || t.result === null);
  const statusLabel = !isStreaming
    ? '就绪'
    : turnPhase === 'retrying'
      ? retryInfo?.maxAttempts
        ? `重试连接 (${retryInfo.attempt}/${retryInfo.maxAttempts})`
        : '重试连接中'
      : turnPhase === 'connecting'
        ? '连接网关中'
        : isThinking || turnPhase === 'thinking'
          ? '思考中'
          : hasRunningTool || turnPhase === 'tool'
            ? '调用工具中'
            : '生成中';

  const streamingMessage: ChatMessage = {
    id: 'streaming',
    role: 'assistant',
    content: currentResponse,
    thinking: currentThinking || undefined,
    tools: currentTools.length > 0 ? currentTools : undefined,
    timestamp: '',
  };

  const isEmpty = messages.length === 0 && !isStreaming && !isCompacting;
  const isSidebarVisible = isDesktopSidebar ? isSidebarPinned : isSidebarDrawerOpen;
  const isEngineeringOpen = isDesktopEngineering ? isEngineeringPinned : isEngineeringDrawerOpen;
  const engineLabel = React.useMemo(
    () => resolveEngineDisplay(engineeringStatus).shortLabel,
    [engineeringStatus]
  );
  const hasEngineeringAlert = Boolean(
    (engineeringStatus?.batchProgress?.qaFailed ?? 0) > 0 ||
      (engineeringStatus?.postQa && !engineeringStatus.postQa.ok)
  );
  const activeSubagentRoles = React.useMemo(
    () =>
      getActiveSubagentRoles(currentTools, {
        translatorMode: translatorConfig?.effective.mode,
      }),
    [currentTools, translatorConfig?.effective.mode]
  );

  const activeSubagentRole = React.useMemo(() => {
    if (!activeSubagentView) return null;
    if (activeSubagentView.taskId) {
      const found = subagentTasks.find((t) => t.taskId === activeSubagentView.taskId);
      if (found) return found.role;
    }
    return activeSubagentView.roleFilter ?? null;
  }, [activeSubagentView, subagentTasks]);

  const isAnyTurnBusy = isStreaming || isCompacting || Boolean(activeDirectSubagentTaskId);
  const topStatusLabel = isCompacting
    ? '正在压缩上下文'
    : !isStreaming
      ? activeDirectSubagentTaskId
        ? '子代理对话中'
        : '就绪'
      : statusLabel;

  const runningToolItem = React.useMemo(
    () => currentTools.find((t) => t.result === undefined || t.result === null) ?? null,
    [currentTools]
  );

  const runningDelegatedSubagent = React.useMemo(() => {
    if (!isStreaming) return null;
    return (
      subagentTasks.find(
        (t) =>
          t.status === 'running' &&
          t.role !== 'translator' &&
          (!activeSessionId || !t.sessionId || t.sessionId === activeSessionId)
      ) ?? null
    );
  }, [isStreaming, subagentTasks, activeSessionId]);

  const mainQueueTimingHint = React.useMemo<PendingQueueTimingHint | null>(() => {
    if (!isStreaming) return null;
    if (runningDelegatedSubagent) {
      return {
        text: `子代理 ${runningDelegatedSubagent.role} 运行中，返回后接入主对话`,
        actionLabel: `前往 ${runningDelegatedSubagent.role} 插话`,
        onAction: () =>
          handleOpenSubagentTask(runningDelegatedSubagent.taskId, runningDelegatedSubagent.role),
      };
    }
    if (runningToolItem) {
      return {
        text: `待当前工具 (${runningToolItem.tool}) 安全完成后立即介入`,
      };
    }
    return {
      text: '待当前推理步骤结束后立即介入',
    };
  }, [isStreaming, runningDelegatedSubagent, runningToolItem]);

  const handleOpenActiveDirectSubagent = React.useCallback(() => {
    if (!activeDirectSubagentTaskId) return;
    const found = subagentTasks.find((t) => t.taskId === activeDirectSubagentTaskId);
    handleOpenSubagentTask(activeDirectSubagentTaskId, found?.role);
  }, [activeDirectSubagentTaskId, subagentTasks]);

  const sidebarProps = {
    activeWorkspace,
    engineLabel,
    recentWorkspaces,
    onOpenWorkspaceSwitcher: () => setIsSwitcherOpen(true),
    sessions,
    activeSessionId,
    busy: isAnyTurnBusy,
    onNewSession: () => void handleNewSession(),
    onSelectSession: (id: string) => void handleSelectSession(id),
    onRequestDeleteSession: (session: SessionSummary) => setPendingDeleteSession(session),
    otherWorkspaceSessions,
    onExpandOtherWorkspace: handleExpandOtherWorkspace,
    onOpenWorkspaceSession: (wsPath: string, sessionId: string) =>
      void handleOpenWorkspaceSession(wsPath, sessionId),
    onSwitchWorkspace: (wsPath: string) => void handleQuickSwitchWorkspace(wsPath),
    isEngineeringActive: isEngineeringOpen,
    onToggleEngineering: toggleEngineeringPanel,
    activeSubagentRoles,
    subagentTasks,
    activeSubagentRole,
    onOpenSubagentRole: handleOpenSubagentRole,
    schemePreference,
    resolvedScheme,
    onOpenSettings: () => setIsSettingsOpen(true),
    onOpenApiKey: () => setIsApiKeyModalOpen(true),
  };

  return (
    <div
      className="relative flex h-dvh w-full overflow-hidden bg-canvas text-ink"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      <div className="pc-studio-ambient" aria-hidden="true" />
      <div className="pc-paper-grain" aria-hidden="true" />

      {isDesktopSidebar ? (
        isSidebarPinned && (
          <aside className="relative z-10 h-full w-[16.75rem] shrink-0" aria-label="导航侧边栏">
            <Sidebar {...sidebarProps} />
          </aside>
        )
      ) : (
        <Drawer
          id={sidebarDrawerId}
          side="start"
          isOpen={isSidebarDrawerOpen}
          onClose={() => setIsSidebarDrawerOpen(false)}
          ariaLabel="导航侧边栏"
        >
          <Sidebar
            {...sidebarProps}
            inDrawer
            onCloseDrawer={() => setIsSidebarDrawerOpen(false)}
          />
        </Drawer>
      )}

      <main
        className={cn(
          'pc-stage-frame relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden lg:my-2.5 lg:rounded-[22px]',
          isDesktopSidebar && isSidebarPinned ? 'lg:ml-1' : 'lg:ml-2.5',
          isDesktopEngineering && isEngineeringPinned ? 'xl:mr-1.5' : 'lg:mr-2.5'
        )}
      >
        <TopBar
          activeWorkspace={activeWorkspace}
          engineLabel={engineLabel}
          onOpenWorkspaceSwitcher={() => setIsSwitcherOpen(true)}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={(id) => void handleSelectSession(id)}
          resolvedScheme={resolvedScheme}
          onToggleQuickScheme={toggleQuickScheme}
          isStreaming={isAnyTurnBusy}
          statusLabel={topStatusLabel}
          motionAllowed={motionAllowed}
          isDesktopSidebar={isDesktopSidebar}
          isSidebarVisible={isSidebarVisible}
          onToggleSidebar={toggleSidebar}
          sidebarDrawerId={sidebarDrawerId}
          isDesktopEngineering={isDesktopEngineering}
          isEngineeringOpen={isEngineeringOpen}
          hasEngineeringAlert={hasEngineeringAlert}
          onToggleEngineering={toggleEngineeringPanel}
          engineeringDrawerId={engineeringDrawerId}
        />

        {activeSubagentView ? (
          <SubagentTaskView
            taskId={activeSubagentView.taskId}
            roleFilter={activeSubagentView.roleFilter}
            tasks={subagentTasks}
            currentSessionId={activeSessionId}
            isMainTurnRunning={isStreaming}
            motionAllowed={motionAllowed}
            modelSupportsImage={models.find((m) => m.key === (selectedModel || models[0]?.key))?.supportsImage}
            activeDirectSubagentTaskId={activeDirectSubagentTaskId}
            subscribeSubagentStream={subscribeSubagentStream}
            subscribeSubagentQueue={subscribeSubagentQueue}
            subscribeSubagentQueueRestored={subscribeSubagentQueueRestored}
            onShowToast={pushToast}
            onBackToChat={() => setActiveSubagentView(null)}
            onSelectTask={(nextId) => {
              const matched = subagentTasks.find((t) => t.taskId === nextId);
              setActiveSubagentView({
                taskId: nextId,
                roleFilter: matched?.role ?? activeSubagentView.roleFilter,
              });
            }}
            onAbortTurn={() => void handleAbort()}
            onAbortSubagentTask={handleAbortSubagentTask}
          />
        ) : (
          <div
            ref={scrollRef}
            data-scrolled-up={(!isAtBottom && !isEmpty) || undefined}
            className="pc-stage-scroll pc-scroller relative flex-1"
          >
            <div
              className={cn(
                'w-full',
                isEmpty ? 'pt-4 pb-6' : 'mx-auto max-w-[49rem] px-4 pt-6 pb-16 sm:px-6'
              )}
            >
              {isEmpty ? (
                <EmptyState
                  onSelectPrompt={handleSend}
                  motionAllowed={motionAllowed}
                  activeWorkspace={activeWorkspace}
                  engineeringStatus={engineeringStatus}
                  onOpenWorkspaceSwitcher={() => setIsSwitcherOpen(true)}
                />
              ) : (
                <>
                  <div role="log" aria-label="对话记录" className="space-y-8">
                    {messages.map((m) => (
                      <MessageItem
                        key={m.id}
                        message={m}
                        isTurnBusy={isAnyTurnBusy}
                        motionAllowed={motionAllowed}
                        subagentTasks={subagentTasks}
                        onOpenSubagentTask={handleOpenSubagentTask}
                        chatForms={chatForms}
                        onSubmitChatForm={handleSubmitChatForm}
                        onCancelChatForm={handleCancelChatForm}
                      />
                    ))}
                  </div>

                  {isStreaming && (
                    <div className="mt-8">
                      <MessageItem
                        message={streamingMessage}
                        isStreaming
                        isThinking={isThinking}
                        isTurnBusy={isAnyTurnBusy}
                        statusLabel={`${statusLabel}…`}
                        motionAllowed={motionAllowed}
                        subagentTasks={subagentTasks}
                        onOpenSubagentTask={handleOpenSubagentTask}
                        chatForms={chatForms}
                        onSubmitChatForm={handleSubmitChatForm}
                        onCancelChatForm={handleCancelChatForm}
                      />
                    </div>
                  )}

                  {isCompacting && (
                    <div
                      role="status"
                      aria-live="polite"
                      className="mt-6 flex items-center justify-center gap-2 rounded-xl border border-line bg-well/65 px-3.5 py-2 text-xs text-ink-2"
                    >
                      <PixelCupLoader className="text-string" />
                      <span>正在压缩上下文…</span>
                    </div>
                  )}
                </>
              )}
              <div ref={bottomRef} className="h-px" aria-hidden="true" />
            </div>

            {!isEmpty && (
              <div className="pc-scroll-bottom-wrap">
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="pc-scroll-bottom inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-raised/95 px-3.5 py-1.5 text-xs font-medium text-ink shadow-[var(--shadow-card)] backdrop-blur-sm transition-colors hover:border-string hover:text-string-ink cursor-pointer"
                >
                  <ArrowDown className="size-3.5" aria-hidden="true" />
                  <span>
                    {hasUnreadStreamUpdate
                      ? '有新进展 · 回到最新输出'
                      : isStreaming
                        ? '回到最新输出'
                        : '回到底部'}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        <div
          className={cn(
            'pc-composer-scrim pointer-events-none relative z-20 -mt-8 shrink-0 px-3 pt-6 sm:px-6',
            activeSubagentView && 'hidden'
          )}
          aria-hidden={Boolean(activeSubagentView) || undefined}
          style={{ paddingBottom: 'max(0.875rem, env(safe-area-inset-bottom, 0px))' }}
        >
          <div className="pointer-events-auto">
            <Composer
              onSend={handleSend}
              onQueueSend={handleQueueSend}
              onCompact={handleCompact}
              onAbort={handleAbort}
              busy={isAnyTurnBusy}
              isMainStreaming={isStreaming}
              isCompacting={isCompacting}
              queuedCompaction={queuedCompaction}
              isBlockedByDirectSubagent={Boolean(activeDirectSubagentTaskId) && !isStreaming}
              onOpenActiveSubagent={handleOpenActiveDirectSubagent}
              pendingQueue={pendingQueue}
              queueTimingHint={mainQueueTimingHint}
              queueBusyItemId={mainQueueBusyItemId}
              queueClearing={mainQueueClearing}
              queueStatusAnnouncement={mainQueueAnnouncement}
              onSwitchQueueMode={(item, mode) => void handleSwitchMainQueueMode(item, mode)}
              onRecallQueueItem={(item) => void handleRecallMainQueueItem(item)}
              onDeleteQueueItem={(item) => void handleDeleteMainQueueItem(item)}
              onClearQueue={() => void handleClearMainQueue()}
              draftInjection={mainDraftInjection}
              onDraftInjectionConsumed={(id) =>
                setMainDraftInjection((prev) => (prev?.id === id ? null : prev))
              }
              motionAllowed={motionAllowed}
              models={models}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              switchingModel={isSwitchingModel}
              thinkingLevel={thinkingLevel}
              availableThinkingLevels={availableThinkingLevels}
              onThinkingChange={handleThinkingChange}
              switchingThinking={isSwitchingThinking}
              onOpenApiKeyModal={() => setIsApiKeyModalOpen(true)}
              tokenUsage={tokenUsage}
            />
          </div>
        </div>
      </main>

      {isDesktopEngineering ? (
        isEngineeringPinned && (
          <aside
            className="pc-stage-frame relative z-10 w-[22rem] shrink-0 overflow-hidden xl:my-2.5 xl:mr-2.5 xl:ml-1 xl:rounded-[22px]"
            aria-label="视觉小说工程画像"
          >
            <EngineeringPanel
              status={engineeringStatus}
              onRefresh={() => loadWorkspaceData(true)}
              onClose={() => {
                setIsEngineeringPinned(false);
                try {
                  window.localStorage.setItem(ENGINEERING_PANEL_KEY, 'closed');
                } catch {
                  // Ignore storage error
                }
              }}
              onSendPrompt={handleSend}
              busy={isAnyTurnBusy}
            />
          </aside>
        )
      ) : (
        <Drawer
          id={engineeringDrawerId}
          side="end"
          isOpen={isEngineeringDrawerOpen}
          onClose={() => setIsEngineeringDrawerOpen(false)}
          ariaLabel="视觉小说工程画像"
        >
          <EngineeringPanel
            status={engineeringStatus}
            onRefresh={() => loadWorkspaceData(true)}
            onClose={() => setIsEngineeringDrawerOpen(false)}
            closeDataAutofocus
            onSendPrompt={(prompt) => {
              setIsEngineeringDrawerOpen(false);
              void handleSend(prompt);
            }}
            busy={isAnyTurnBusy}
            inDrawer
          />
        </Drawer>
      )}

      <WorkspaceDialog
        isOpen={isSwitcherOpen}
        onClose={() => setIsSwitcherOpen(false)}
        activeWorkspace={activeWorkspace}
        recentWorkspaces={recentWorkspaces}
        busy={isAnyTurnBusy}
        onWorkspaceChanged={handleWorkspaceChanged}
      />

      <ApiKeyDialog
        isOpen={isApiKeyModalOpen}
        onClose={() => setIsApiKeyModalOpen(false)}
        providers={providers}
        currentModel={selectedModel}
        busy={isAnyTurnBusy}
        onModelsUpdated={applyModelsState}
      />

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        preference={schemePreference}
        systemScheme={systemScheme}
        onSelectScheme={setSchemePreference}
        ambientEnabled={ambientEnabled}
        onToggleAmbient={setAmbientEnabled}
        onOpenApiKey={() => setIsApiKeyModalOpen(true)}
        translatorConfig={translatorConfig}
        latestSmokeConfig={latestSmokeConfig}
        onTranslatorConfigUpdated={(next) => {
          markSyncSeqHandled(next.ollamaSync?.syncSeq);
          setTranslatorConfig(next);
          void refreshEngineeringStatus(true);
        }}
        onOllamaSyncSeq={markSyncSeqHandled}
        onShowToast={pushToast}
        busy={isAnyTurnBusy}
      />

      <ConfirmDialog
        isOpen={Boolean(pendingDeleteSession)}
        onClose={() => setPendingDeleteSession(null)}
        onConfirm={confirmDeleteSession}
        title="删除对话"
        description={
          pendingDeleteSession
            ? `确定要删除会话「${pendingDeleteSession.title}」吗？此操作仅移除会话记录，不会删除工作区目录中的任何游戏文件。`
            : ''
        }
        busy={isAnyTurnBusy}
      />

      <ToastRegion toasts={toasts} onDismiss={dismissToast} suppress={isAnyModalOpen} />
    </div>
  );
}
