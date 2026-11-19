import * as React from 'react';
import {
  ArrowRightLeft,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  KeyRound,
  MessageSquare,
  PanelRight,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { CupMark } from '@/components/brand/CupMark.js';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import { ColorSchemePreference, ResolvedColorScheme } from '@/hooks/useColorScheme.js';
import { SessionSummary, SubagentTaskSummary } from '@/lib/api.js';
import { gsap } from '@/lib/gsap.js';
import { getPathBase, splitPathTail } from '@/lib/paths.js';
import { formatRelativeTime } from '@/lib/relativeTime.js';
import { cn } from '@/lib/utils.js';

export interface OtherWorkspaceSessionsState {
  loading: boolean;
  loaded: boolean;
  error?: string;
  sessions: SessionSummary[];
}

interface SidebarProps {
  activeWorkspace: string;
  engineLabel?: string | null;
  recentWorkspaces?: string[];
  onOpenWorkspaceSwitcher: () => void;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  busy?: boolean;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onRequestDeleteSession: (session: SessionSummary) => void;
  otherWorkspaceSessions?: Record<string, OtherWorkspaceSessionsState>;
  onExpandOtherWorkspace?: (workspacePath: string, force?: boolean) => void;
  onOpenWorkspaceSession?: (workspacePath: string, sessionId: string) => void;
  onSwitchWorkspace?: (workspacePath: string) => void;
  isEngineeringActive: boolean;
  onToggleEngineering: () => void;
  activeSubagentRoles: Set<string>;
  subagentTasks?: SubagentTaskSummary[];
  activeSubagentRole?: string | null;
  onOpenSubagentRole?: (role: string) => void;
  schemePreference: ColorSchemePreference;
  resolvedScheme: ResolvedColorScheme;
  onOpenSettings: () => void;
  onOpenApiKey?: () => void;
  onCloseDrawer?: () => void;
  inDrawer?: boolean;
}

const BUILTIN_ROLES = ['translator', 'reverser', 'role-checker'] as const;

function SectionLabel({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="px-2 pb-1.5 text-[11px] font-semibold tracking-wide text-ink-3">
      {children}
    </h2>
  );
}

export function Sidebar({
  activeWorkspace,
  engineLabel,
  recentWorkspaces = [],
  onOpenWorkspaceSwitcher,
  sessions,
  activeSessionId,
  busy = false,
  onNewSession,
  onSelectSession,
  onRequestDeleteSession,
  otherWorkspaceSessions = {},
  onExpandOtherWorkspace,
  onOpenWorkspaceSession,
  onSwitchWorkspace,
  isEngineeringActive,
  onToggleEngineering,
  activeSubagentRoles,
  subagentTasks = [],
  activeSubagentRole = null,
  onOpenSubagentRole,
  schemePreference,
  resolvedScheme,
  onOpenSettings,
  onOpenApiKey,
  onCloseDrawer,
  inDrawer = false,
}: SidebarProps) {
  const rolesListRef = React.useRef<HTMLUListElement>(null);
  const otherWsHeadingId = React.useId();
  const { prefix: wsPrefix, base: wsBase } = splitPathTail(activeWorkspace);
  const fallbackBase = getPathBase(activeWorkspace);
  const activeLower = activeWorkspace.toLowerCase();
  const otherWorkspaces = recentWorkspaces.filter(
    (ws) => ws.trim() && ws.toLowerCase() !== activeLower
  );

  const schemeSummary =
    schemePreference === 'system'
      ? `跟随系统（${resolvedScheme === 'dark' ? '夜' : '纸'}）`
      : schemePreference === 'dark'
        ? '夜 · 深色'
        : '纸 · 浅色';

  const rolesList: string[] = [...BUILTIN_ROLES];
  for (const role of activeSubagentRoles) {
    if (!rolesList.includes(role)) {
      rolesList.push(role);
    }
  }
  for (const task of subagentTasks) {
    if (task.role && !rolesList.includes(task.role)) {
      rolesList.push(task.role);
    }
  }

  React.useLayoutEffect(() => {
    const list = rolesListRef.current;
    if (!list) return undefined;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from(Array.from(list.children), {
        y: 6,
        opacity: 0,
        duration: 0.28,
        stagger: 0.045,
        ease: 'power2.out',
        clearProps: 'transform,opacity',
      });
    });
    return () => mm.revert();
  }, []);

  return (
    <div
      className={cn(
        'flex h-full flex-col text-ink select-none',
        inDrawer ? 'bg-sheet' : 'bg-transparent'
      )}
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4 pt-1">
        <div className="flex items-center gap-2.5">
          <CupMark className="size-6 shrink-0" />
          <div className="flex items-baseline gap-1.5">
            <span className="pc-display text-[1.45rem] leading-none text-ink">Paper Cup</span>
            <span className="font-mono text-[9.5px] font-medium tracking-[0.16em] text-ink-3 uppercase">
              Studio
            </span>
          </div>
        </div>
        {onCloseDrawer && (
          <button
            type="button"
            data-autofocus=""
            onClick={onCloseDrawer}
            aria-label="关闭侧边栏"
            className="inline-flex size-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-well hover:text-ink cursor-pointer"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="space-y-2.5 px-3 pb-3">
        <button
          type="button"
          onClick={() => {
            onNewSession();
            onCloseDrawer?.();
          }}
          disabled={busy}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-line-strong bg-surface-raised px-3 py-2 text-[0.8125rem] font-semibold text-ink shadow-[var(--shadow-card)] transition-colors hover:border-string/45 hover:text-string-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
        >
          <span className="flex items-center gap-2">
            <Plus className="size-4 text-string" aria-hidden="true" />
            <span>新建对话</span>
          </span>
          <kbd className="pc-kbd">Alt N</kbd>
        </button>

        <button
          type="button"
          onClick={() => {
            onCloseDrawer?.();
            onOpenWorkspaceSwitcher();
          }}
          aria-haspopup="dialog"
          title={activeWorkspace || '点击切换工作区'}
          className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-sheet/90 px-3 py-2 text-left transition-colors hover:border-line-strong cursor-pointer"
        >
          <Folder className="size-4 shrink-0 text-string" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 text-[0.8125rem]">
              <span className="min-w-0 truncate font-semibold text-ink">
                {activeWorkspace ? wsBase || fallbackBase : '未选择工作区'}
              </span>
              {engineLabel && (
                <span className="shrink-0 rounded-full bg-well px-1.5 py-px font-mono text-[10px] font-medium text-ink-2">
                  {engineLabel}
                </span>
              )}
            </span>
            {activeWorkspace && wsPrefix && (
              <span className="mt-0.5 truncate font-mono text-[10px] text-ink-3">
                {wsPrefix}
              </span>
            )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="visually-hidden">切换工作区</span>
        </button>
      </div>

      <nav className="pc-scroller flex-1 space-y-5 overflow-y-auto px-3 pb-4" aria-label="工程导航">
        <section>
          <div className="flex items-center justify-between pr-0.5">
            <SectionLabel>对话</SectionLabel>
            <span className="pb-1.5 font-mono text-[10.5px] text-ink-3">{sessions.length}</span>
          </div>

          <ul className="pc-scroller max-h-64 space-y-0.5 overflow-y-auto">
            {sessions.map((s) => {
              const active = s.id === activeSessionId;
              const relTime = formatRelativeTime(s.updatedAt);

              return (
                <li key={s.id} className="pc-reveal-row relative">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectSession(s.id);
                      onCloseDrawer?.();
                    }}
                    disabled={busy}
                    aria-current={active ? 'true' : undefined}
                    title={s.title}
                    className={cn(
                      'relative flex w-full items-center gap-2 rounded-xl border px-2.5 py-1.5 pr-8 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 cursor-pointer',
                      active
                        ? 'border-line-strong bg-surface-raised text-ink shadow-[var(--shadow-card)]'
                        : 'border-transparent text-ink-2 hover:bg-sheet/70 hover:text-ink'
                    )}
                  >
                    {active && (
                      <span
                        className="h-4 w-0.5 shrink-0 rounded-full bg-string"
                        aria-hidden="true"
                      />
                    )}
                    <MessageSquare
                      className={cn(
                        'size-3.5 shrink-0',
                        active ? 'text-string' : 'text-ink-3'
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8125rem] font-medium">
                        {s.title}
                      </span>
                      {relTime && (
                        <span className="block truncate text-[10.5px] text-ink-3">
                          {relTime}
                        </span>
                      )}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestDeleteSession(s);
                    }}
                    disabled={busy}
                    aria-label={`删除会话 ${s.title}`}
                    title="删除会话"
                    className="pc-reveal-action absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                  >
                    <Trash2 className="size-3" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {otherWorkspaces.length > 0 && (
          <section aria-labelledby={otherWsHeadingId}>
            <SectionLabel id={otherWsHeadingId}>其他工作区</SectionLabel>
            <div className="space-y-1">
              {otherWorkspaces.map((wsPath) => {
                const wsBaseName = getPathBase(wsPath) || wsPath;
                const wsState = otherWorkspaceSessions[wsPath];

                return (
                  <details
                    key={wsPath}
                    className="pc-ws-details rounded-lg"
                    onToggle={(e) => {
                      if (e.currentTarget.open) {
                        onExpandOtherWorkspace?.(wsPath);
                      }
                    }}
                  >
                    <summary
                      title={wsPath}
                      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[0.8125rem] text-ink-2 transition-colors hover:bg-well hover:text-ink"
                    >
                      <ChevronRight
                        className="pc-ws-chevron size-3.5 shrink-0 text-ink-3"
                        aria-hidden="true"
                      />
                      <Folder className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-medium">{wsBaseName}</span>
                    </summary>

                    <div className="mt-1 ml-3 space-y-1 border-l border-line pl-2.5 pb-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onSwitchWorkspace?.(wsPath);
                          onCloseDrawer?.();
                        }}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] font-medium text-string-ink transition-colors hover:bg-string-soft disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                      >
                        <ArrowRightLeft className="size-3 shrink-0" aria-hidden="true" />
                        <span>切换到此工作区</span>
                      </button>

                      {wsState?.loading ? (
                        <p className="px-2 py-1 text-[11px] text-ink-3">加载对话中…</p>
                      ) : wsState?.error ? (
                        <div className="space-y-1 px-2 py-1 text-[11px] text-danger">
                          <p className="break-words">{wsState.error}</p>
                          <button
                            type="button"
                            onClick={() => onExpandOtherWorkspace?.(wsPath, true)}
                            className="rounded border border-danger/35 px-2 py-0.5 text-[11px] text-danger hover:bg-danger-soft cursor-pointer"
                          >
                            重试
                          </button>
                        </div>
                      ) : wsState?.loaded && wsState.sessions.length === 0 ? (
                        <p className="px-2 py-1 text-[11px] text-ink-3">暂无历史对话</p>
                      ) : wsState?.sessions && wsState.sessions.length > 0 ? (
                        <ul className="pc-scroller max-h-44 space-y-0.5 overflow-y-auto">
                          {wsState.sessions.map((s) => {
                            const relTime = formatRelativeTime(s.updatedAt);
                            return (
                              <li key={s.id}>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title={`${wsBaseName} / ${s.title}`}
                                  onClick={() => {
                                    onOpenWorkspaceSession?.(wsPath, s.id);
                                    onCloseDrawer?.();
                                  }}
                                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-ink-2 transition-colors hover:bg-well hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                                >
                                  <MessageSquare
                                    className="size-3 shrink-0 text-ink-3"
                                    aria-hidden="true"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs">{s.title}</span>
                                    {relTime && (
                                      <span className="block truncate text-[10px] text-ink-3">
                                        {relTime}
                                      </span>
                                    )}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <SectionLabel>工程</SectionLabel>
          <button
            type="button"
            onClick={() => {
              onToggleEngineering();
              onCloseDrawer?.();
            }}
            aria-pressed={isEngineeringActive}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[0.8125rem] font-medium transition-colors cursor-pointer',
              isEngineeringActive
                ? 'border-string/35 bg-string-soft text-string-ink'
                : 'border-transparent text-ink-2 hover:bg-well hover:text-ink'
            )}
          >
            <PanelRight className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left">工程画像</span>
          </button>
        </section>

        <section>
          <SectionLabel>内置子代理</SectionLabel>
          <ul ref={rolesListRef} className="space-y-1">
            {rolesList.map((role) => {
              const roleTasks = subagentTasks.filter((t) => t.role === role);
              const latestTask = roleTasks[0];
              const runningTask = roleTasks.find((t) => t.status === 'running');
              const working = Boolean(runningTask) || activeSubagentRoles.has(role);
              const isSelected = activeSubagentRole === role;

              let statusText = '待命';
              let statusTone = 'text-ink-3';
              if (working) {
                if (runningTask?.activityState === 'running_tool') {
                  statusText = `执行工具 (${runningTask.toolCallCount})`;
                } else if (runningTask?.activityState === 'waiting_model') {
                  statusText =
                    runningTask.toolCallCount > 0
                      ? `等待模型 (${runningTask.toolCallCount})`
                      : '等待模型';
                } else {
                  statusText = '工作中';
                }
                statusTone = 'font-medium text-string-ink';
              } else if (latestTask) {
                if (latestTask.activityState === 'unknown') {
                  statusText = `状态未知 (${roleTasks.length})`;
                  statusTone = 'text-warn';
                } else if (latestTask.status === 'aborted') {
                  statusText = `已中止 (${roleTasks.length})`;
                  statusTone = 'text-warn';
                } else if (latestTask.status === 'error') {
                  statusText = `异常 (${roleTasks.length})`;
                  statusTone = 'text-danger';
                } else {
                  statusText = `已完成 (${roleTasks.length})`;
                  statusTone = 'text-ok';
                }
              }

              return (
                <li key={role}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSubagentRole?.(role);
                      onCloseDrawer?.();
                    }}
                    aria-current={isSelected ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer',
                      isSelected
                        ? 'border-string/40 bg-string-soft text-ink'
                        : working
                          ? 'border-string/25 bg-string-soft/65 text-ink hover:border-string/45'
                          : 'border-transparent text-ink-2 hover:bg-well hover:text-ink'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {working ? (
                        <PixelCupLoader className="text-string" />
                      ) : (
                        <span
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            latestTask?.status === 'error'
                              ? 'bg-danger'
                              : latestTask?.status === 'aborted' || latestTask?.activityState === 'unknown'
                                ? 'bg-warn'
                                : latestTask?.status === 'completed'
                                  ? 'bg-ok'
                                  : 'bg-ink-3/60'
                          )}
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate font-mono text-[12px]">{role}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className={cn('text-[10.5px]', statusTone)}>{statusText}</span>
                      <ChevronRight className="size-3 text-ink-3" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </nav>

      <div className="flex items-center gap-1.5 border-t border-line p-3">
        <button
          type="button"
          onClick={() => {
            onCloseDrawer?.();
            onOpenSettings();
          }}
          aria-haspopup="dialog"
          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl border border-line bg-sheet/90 px-3 py-2 text-left text-xs transition-colors hover:border-line-strong cursor-pointer"
        >
          <span className="flex items-center gap-2 font-medium text-ink">
            <SlidersHorizontal className="size-3.5 text-string" aria-hidden="true" />
            <span>设置</span>
          </span>
          <span className="truncate text-[10.5px] text-ink-3">{schemeSummary}</span>
        </button>

        {onOpenApiKey && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onCloseDrawer?.();
              onOpenApiKey();
            }}
            aria-haspopup="dialog"
            aria-label="管理 API Key"
            title="管理 API Key"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-sheet/90 text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
          >
            <KeyRound className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
