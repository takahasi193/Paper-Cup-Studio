import * as React from 'react';
import { ArrowDown } from 'lucide-react';
import { Composer } from '@/components/chat/Composer.js';
import { EmptyState } from '@/components/chat/EmptyState.js';
import { MessageItem } from '@/components/chat/MessageItem.js';
import { ApiKeyDialog } from '@/components/dialogs/ApiKeyDialog.js';
import { CommandPalette } from '@/components/dialogs/CommandPalette.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { SettingsDialog } from '@/components/dialogs/SettingsDialog.js';
import { WorkspaceDialog } from '@/components/dialogs/WorkspaceDialog.js';
import { EngineeringPanel } from '@/components/engineering/EngineeringPanel.js';
import { OtherWorkspaceSessionsState, Sidebar } from '@/components/layout/Sidebar.js';
import { TopBar } from '@/components/layout/TopBar.js';
import { SubagentTaskView } from '@/components/subagent/SubagentTaskView.js';
import { Drawer } from '@/components/ui/Drawer.js';
import { useAmbientMotion } from '@/hooks/useAmbientMotion.js';
import { ChatMessage, useAgentStream } from '@/hooks/useAgentStream.js';
import { useColorScheme } from '@/hooks/useColorScheme.js';
import { useMediaQuery } from '@/hooks/useMediaQuery.js';
import {
  abortTurn,
  deleteSession,
  EngineeringStatus,
  fetchEngineeringStatus,
  fetchModels,
  fetchSessionHistory,
  fetchWorkspaces,
  fetchWorkspaceSessions,
  ModelOption,
  ModelsState,
  openWorkspaceSession,
  pickWorkspaceFolder,
  ProviderStatusInfo,
  resetSession,
  selectModel,
  selectSession,
  selectWorkspace,
  SessionHistoryState,
  SessionSummary,
  startTurn,
  ThinkingLevel,
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

function extractEngineLabel(status: EngineeringStatus | null): string | null {
  const first = (status?.engine || '').trim().split(/\r?\n/)[0] || '';
  if (!first || first.includes('未识别') || first.toLowerCase().startsWith('unknown')) {
    return null;
  }
  return first.split(/\s+/)[0] || first;
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

  const [isEngineeringPinned, setIsEngineeringPinned] = React.useState(readEngineeringPinned);
  const [isEngineeringDrawerOpen, setIsEngineeringDrawerOpen] = React.useState(false);
  const [isSidebarPinned, setIsSidebarPinned] = React.useState(readSidebarPinned);
  const [isSidebarDrawerOpen, setIsSidebarDrawerOpen] = React.useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = React.useState(false);
  const [isSwitcherOpen, setIsSwitcherOpen] = React.useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = React.useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [pendingDeleteSession, setPendingDeleteSession] = React.useState<SessionSummary | null>(null);
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

  const hydrateFromReconnectRef = React.useRef<() => void>(() => {});
  const handleStreamReconnect = React.useCallback(() => {
    hydrateFromReconnectRef.current();
  }, []);
  const handleBatchProgress = React.useCallback(() => {
    fetchEngineeringStatus().then(setEngineeringStatus).catch(console.error);
  }, []);

  const {
    messages,
    isStreaming,
    isThinking,
    turnPhase,
    retryInfo,
    currentThinking,
    currentResponse,
    currentTools,
    subagentTasks,
    activeModel,
    latestThinkingLevel,
    latestModelsState,
    latestSessionState,
    latestSessionsList,
    hydrateSessionState,
    addUserMessage,
    addErrorMessage,
  } = useAgentStream({
    onReconnect: handleStreamReconnect,
    onBatchProgress: handleBatchProgress,
  });

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

  hydrateFromReconnectRef.current = () => {
    fetchSessionHistory().then(applySessionState).catch(console.error);
    fetchModels().then(applyModelsState).catch(console.error);
    fetchEngineeringStatus().then(setEngineeringStatus).catch(console.error);
  };

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  const loadWorkspaceData = React.useCallback(
    (forceRefreshEngineering = false) => {
      fetchWorkspaces()
        .then((ws) => {
          setActiveWorkspace(ws.active);
          setRecentWorkspaces(ws.recent || [ws.active]);
        })
        .catch((err) => {
          console.error('Failed to load workspaces:', err);
        });

      fetchSessionHistory()
        .then(applySessionState)
        .catch((err) => {
          console.error('Failed to load session history:', err);
        });

      fetchModels()
        .then(applyModelsState)
        .catch((err) => {
          console.error('Failed to load models:', err);
        });

      fetchEngineeringStatus(forceRefreshEngineering)
        .then(setEngineeringStatus)
        .catch((err) => {
          console.error('Failed to load engineering status:', err);
        });
    },
    [applyModelsState, applySessionState]
  );

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
      fetchEngineeringStatus().then(setEngineeringStatus).catch(console.error);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  React.useEffect(() => {
    if (latestModelsState) {
      applyModelsState(latestModelsState);
    }
  }, [latestModelsState, applyModelsState]);

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
    setActiveWorkspace(newActive);
    setRecentWorkspaces(recent);
    setActiveSubagentView(null);
    invalidateOtherWorkspaceCache(newActive);
    fetchEngineeringStatus().then(setEngineeringStatus).catch(console.error);
    fetchSessionHistory().then(applySessionState).catch(console.error);
    fetchModels().then(applyModelsState).catch(console.error);
  };

  const handleExpandOtherWorkspace = React.useCallback(
    (wsPath: string, force = false) => {
      let shouldFetch = false;
      setOtherWorkspaceSessions((prev) => {
        const cur = prev[wsPath];
        if (cur?.loading) return prev;
        if (cur?.loaded && !cur.error && !force) return prev;
        shouldFetch = true;
        return {
          ...prev,
          [wsPath]: {
            loading: true,
            loaded: false,
            sessions: cur?.sessions ?? [],
          },
        };
      });
      if (!shouldFetch) return;
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
        });
    },
    []
  );

  const handleOpenWorkspaceSession = async (wsPath: string, sessionId: string) => {
    if (isStreaming) return;
    try {
      const res = await openWorkspaceSession(wsPath, sessionId);
      setActiveWorkspace(res.workspaces.active);
      setRecentWorkspaces(res.workspaces.recent || [res.workspaces.active]);
      setActiveSubagentView(null);
      invalidateOtherWorkspaceCache(res.workspaces.active);
      applySessionState(res.session);
      fetchEngineeringStatus().then(setEngineeringStatus).catch(console.error);
      fetchModels().then(applyModelsState).catch(console.error);
    } catch (err) {
      console.error('Failed to open workspace session:', err);
      addErrorMessage(err instanceof Error ? err.message : '打开历史工作区对话失败');
    }
  };

  const handleQuickSwitchWorkspace = async (wsPath: string) => {
    if (isStreaming) return;
    try {
      const res = await selectWorkspace(wsPath);
      handleWorkspaceChanged(res.active, res.recent);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
      addErrorMessage(err instanceof Error ? err.message : '切换工作区失败');
    }
  };

  const handleNewSession = async () => {
    if (isStreaming) return;
    try {
      const fresh = await resetSession();
      applySessionState(fresh);
      if (activeWorkspace) invalidateOtherWorkspaceCache(activeWorkspace);
    } catch (err) {
      console.error('Error resetting session:', err);
      addErrorMessage(err instanceof Error ? err.message : '新建对话失败');
    }
  };

  const handleSelectSession = async (sessionId: string) => {
    if (isStreaming || sessionId === activeSessionId) return;
    try {
      const next = await selectSession(sessionId);
      applySessionState(next);
    } catch (err) {
      console.error('Error switching session:', err);
      addErrorMessage(err instanceof Error ? err.message : '切换对话失败');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (isStreaming) return;
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
  }, [messages, currentThinking, currentResponse, currentTools]);

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

  const handleSend = async (prompt: string) => {
    setActiveSubagentView(null);
    addUserMessage(prompt);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    try {
      await startTurn(prompt, selectedModel || undefined);
    } catch (err) {
      console.error('Error triggering turn:', err);
      addErrorMessage(err instanceof Error ? err.message : '无法连接服务端');
    }
  };

  const handleAbort = async () => {
    try {
      await abortTurn();
    } catch (err) {
      console.error('Error aborting turn:', err);
      addErrorMessage(err instanceof Error ? err.message : '中止执行失败');
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

  const handleBrowseWorkspaceFromPalette = async () => {
    if (isStreaming) return;
    try {
      const picked = await pickWorkspaceFolder(activeWorkspace || undefined);
      if (!picked.canceled && picked.path) {
        await handleQuickSwitchWorkspace(picked.path);
      }
    } catch (err) {
      addErrorMessage(err instanceof Error ? err.message : '打开系统目录选择器失败');
    }
  };

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === '.') {
        e.preventDefault();
        toggleEngineeringPanel();
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
        if (!isStreaming) {
          e.preventDefault();
          void handleNewSession();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleEngineeringPanel, isStreaming]);

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

  const isEmpty = messages.length === 0 && !isStreaming;
  const isSidebarVisible = isDesktopSidebar ? isSidebarPinned : isSidebarDrawerOpen;
  const isEngineeringOpen = isDesktopEngineering ? isEngineeringPinned : isEngineeringDrawerOpen;
  const engineLabel = React.useMemo(() => extractEngineLabel(engineeringStatus), [engineeringStatus]);
  const hasEngineeringAlert = Boolean(
    (engineeringStatus?.batchProgress?.qaFailed ?? 0) > 0 ||
      (engineeringStatus?.postQa && !engineeringStatus.postQa.ok)
  );
  const activeSubagentRoles = React.useMemo(
    () => getActiveSubagentRoles(currentTools),
    [currentTools]
  );

  const activeSubagentRole = React.useMemo(() => {
    if (!activeSubagentView) return null;
    if (activeSubagentView.taskId) {
      const found = subagentTasks.find((t) => t.taskId === activeSubagentView.taskId);
      if (found) return found.role;
    }
    return activeSubagentView.roleFilter ?? null;
  }, [activeSubagentView, subagentTasks]);

  const sidebarProps = {
    activeWorkspace,
    engineLabel,
    recentWorkspaces,
    onOpenWorkspaceSwitcher: () => setIsSwitcherOpen(true),
    sessions,
    activeSessionId,
    busy: isStreaming,
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
          onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
          resolvedScheme={resolvedScheme}
          onToggleQuickScheme={toggleQuickScheme}
          isStreaming={isStreaming}
          statusLabel={statusLabel}
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

        <div
          ref={scrollRef}
          data-scrolled-up={(!isAtBottom && !isEmpty && !activeSubagentView) || undefined}
          className="pc-stage-scroll pc-scroller relative flex-1"
        >
          {activeSubagentView ? (
            <SubagentTaskView
              taskId={activeSubagentView.taskId}
              roleFilter={activeSubagentView.roleFilter}
              tasks={subagentTasks}
              currentSessionId={activeSessionId}
              isMainTurnRunning={isStreaming}
              onBackToChat={() => setActiveSubagentView(null)}
              onSelectTask={(nextId) => {
                const matched = subagentTasks.find((t) => t.taskId === nextId);
                setActiveSubagentView({
                  taskId: nextId,
                  roleFilter: matched?.role ?? activeSubagentView.roleFilter,
                });
              }}
              onAbortTurn={() => void handleAbort()}
            />
          ) : (
            <div
              className={cn(
                'mx-auto w-full max-w-[49rem] px-4 sm:px-6',
                isEmpty ? 'pt-3 pb-4' : 'pt-6 pb-16'
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
                        motionAllowed={motionAllowed}
                        subagentTasks={subagentTasks}
                        onOpenSubagentTask={handleOpenSubagentTask}
                      />
                    ))}
                  </div>

                  {isStreaming && (
                    <div className="mt-8">
                      <MessageItem
                        message={streamingMessage}
                        isStreaming
                        isThinking={isThinking}
                        statusLabel={`${statusLabel}…`}
                        motionAllowed={motionAllowed}
                        subagentTasks={subagentTasks}
                        onOpenSubagentTask={handleOpenSubagentTask}
                      />
                    </div>
                  )}
                </>
              )}
              <div ref={bottomRef} className="h-px" aria-hidden="true" />
            </div>
          )}

          {!isEmpty && !activeSubagentView && (
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

        {!activeSubagentView && (
          <div
            className="pc-composer-scrim pointer-events-none relative z-20 -mt-8 shrink-0 px-3 pt-6 sm:px-6"
            style={{ paddingBottom: 'max(0.875rem, env(safe-area-inset-bottom, 0px))' }}
          >
            <div className="pointer-events-auto">
              <Composer
                onSend={handleSend}
                onAbort={handleAbort}
                busy={isStreaming}
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
              />
            </div>
          </div>
        )}
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
              busy={isStreaming}
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
            busy={isStreaming}
            inDrawer
          />
        </Drawer>
      )}

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        busy={isStreaming}
        activeWorkspace={activeWorkspace}
        recentWorkspaces={recentWorkspaces}
        sessions={sessions}
        activeSessionId={activeSessionId}
        resolvedScheme={resolvedScheme}
        isSidebarVisible={isSidebarVisible}
        isEngineeringVisible={isEngineeringOpen}
        onSendPrompt={(prompt) => void handleSend(prompt)}
        onNewSession={() => void handleNewSession()}
        onSelectSession={(id) => void handleSelectSession(id)}
        onBrowseWorkspace={() => void handleBrowseWorkspaceFromPalette()}
        onOpenWorkspaceSwitcher={() => setIsSwitcherOpen(true)}
        onSwitchWorkspace={(wsPath) => void handleQuickSwitchWorkspace(wsPath)}
        onToggleQuickScheme={toggleQuickScheme}
        onToggleSidebar={toggleSidebar}
        onToggleEngineering={toggleEngineeringPanel}
        onOpenApiKey={() => setIsApiKeyModalOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <WorkspaceDialog
        isOpen={isSwitcherOpen}
        onClose={() => setIsSwitcherOpen(false)}
        activeWorkspace={activeWorkspace}
        recentWorkspaces={recentWorkspaces}
        busy={isStreaming}
        onWorkspaceChanged={handleWorkspaceChanged}
      />

      <ApiKeyDialog
        isOpen={isApiKeyModalOpen}
        onClose={() => setIsApiKeyModalOpen(false)}
        providers={providers}
        currentModel={selectedModel}
        busy={isStreaming}
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
        busy={isStreaming}
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
        busy={isStreaming}
      />
    </div>
  );
}
