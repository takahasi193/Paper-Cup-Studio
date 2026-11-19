import * as React from 'react';
import {
  Check,
  ChevronsUpDown,
  Menu,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Search,
  Sun,
} from 'lucide-react';
import { ResolvedColorScheme } from '@/hooks/useColorScheme.js';
import { SessionSummary } from '@/lib/api.js';
import { gsap } from '@/lib/gsap.js';
import { getPathBase } from '@/lib/paths.js';
import { cn } from '@/lib/utils.js';

interface TopBarProps {
  activeWorkspace: string;
  engineLabel?: string | null;
  onOpenWorkspaceSwitcher: () => void;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onOpenCommandPalette: () => void;
  resolvedScheme: ResolvedColorScheme;
  onToggleQuickScheme: (origin?: { x: number; y: number }) => void;
  isStreaming: boolean;
  statusLabel: string;
  motionAllowed: boolean;
  isDesktopSidebar: boolean;
  isSidebarVisible: boolean;
  onToggleSidebar: () => void;
  sidebarDrawerId: string;
  isDesktopEngineering: boolean;
  isEngineeringOpen: boolean;
  hasEngineeringAlert?: boolean;
  onToggleEngineering: () => void;
  engineeringDrawerId: string;
}

const isMacLike = () =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || '');

export function TopBar({
  activeWorkspace,
  engineLabel,
  onOpenWorkspaceSwitcher,
  sessions,
  activeSessionId,
  onSelectSession,
  onOpenCommandPalette,
  resolvedScheme,
  onToggleQuickScheme,
  isStreaming,
  statusLabel,
  motionAllowed,
  isDesktopSidebar,
  isSidebarVisible,
  onToggleSidebar,
  sidebarDrawerId,
  isDesktopEngineering,
  isEngineeringOpen,
  hasEngineeringAlert = false,
  onToggleEngineering,
  engineeringDrawerId,
}: TopBarProps) {
  const sessionSelectId = React.useId();
  const rippleRef = React.useRef<HTMLSpanElement>(null);
  const workspaceBase = getPathBase(activeWorkspace);

  React.useLayoutEffect(() => {
    const ring = rippleRef.current;
    if (!isStreaming || !motionAllowed || !ring) return undefined;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        ring,
        { scale: 0.7, opacity: 0.85 },
        {
          scale: 2.1,
          opacity: 0,
          duration: 1.5,
          repeat: -1,
          ease: 'power2.out',
        }
      );
    });
    return () => ctx.revert();
  }, [isStreaming, motionAllowed]);

  const handleThemeButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX > 0 ? e.clientX : rect.left + rect.width / 2;
    const y = e.clientY > 0 ? e.clientY : rect.top + rect.height / 2;
    onToggleQuickScheme({ x, y });
  };

  return (
    <header className="relative z-10 flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-sheet/80 px-3 py-2 backdrop-blur-md sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-pressed={isDesktopSidebar ? isSidebarVisible : undefined}
          aria-expanded={!isDesktopSidebar ? isSidebarVisible : undefined}
          aria-controls={!isDesktopSidebar ? sidebarDrawerId : undefined}
          aria-label={isSidebarVisible ? '收起导航侧边栏' : '展开导航侧边栏'}
          title={isSidebarVisible ? '收起侧边栏' : '展开侧边栏'}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-raised text-ink-2 transition-colors hover:border-line-strong hover:text-ink cursor-pointer"
        >
          {!isDesktopSidebar ? (
            <Menu className="size-4" aria-hidden="true" />
          ) : isSidebarVisible ? (
            <PanelLeftClose className="size-4" aria-hidden="true" />
          ) : (
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={onOpenWorkspaceSwitcher}
          aria-haspopup="dialog"
          title={activeWorkspace || '点击切换工作区'}
          className="group flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[0.8125rem] transition-colors hover:bg-well/80 cursor-pointer"
        >
          <span className="truncate font-semibold text-ink">
            {workspaceBase || '未选择工作区'}
          </span>
          {engineLabel && (
            <span className="hidden rounded-full border border-line bg-well px-2 py-0.5 font-mono text-[10.5px] font-medium text-ink-2 sm:inline-block">
              {engineLabel}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3 group-hover:text-ink" aria-hidden="true" />
          <span className="visually-hidden">（切换工作区）</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(!isDesktopSidebar || !isSidebarVisible) && sessions.length > 1 && (
          <div className="flex min-w-0 items-center gap-1 rounded-full border border-line bg-surface-raised px-2 py-0.5 text-xs text-ink-2">
            <MessageSquare className="size-3.5 shrink-0 text-string" aria-hidden="true" />
            <label htmlFor={sessionSelectId} className="visually-hidden">
              切换对话会话
            </label>
            <select
              id={sessionSelectId}
              name="session"
              value={activeSessionId || sessions[0]?.id || ''}
              disabled={isStreaming}
              onChange={(e) => {
                if (e.target.value) onSelectSession(e.target.value);
              }}
              aria-label="切换对话会话"
              className="pc-select max-w-[26vw] truncate rounded py-0.5 pr-1 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-haspopup="dialog"
          aria-label="打开命令面板"
          title="命令面板 (Ctrl+K)"
          className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-surface-raised px-2.5 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink cursor-pointer"
        >
          <Search className="size-3.5 text-ink-3" aria-hidden="true" />
          <span className="hidden md:inline">命令与检索</span>
          <kbd className="pc-kbd hidden sm:inline-flex">{isMacLike() ? '⌘K' : 'Ctrl K'}</kbd>
        </button>

        <div
          role="status"
          className={cn(
            'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium',
            isStreaming
              ? 'border-string/40 bg-string-soft text-string-ink'
              : 'border-line bg-surface-raised text-ink-2'
          )}
        >
          {isStreaming ? (
            <span className="pc-status-dot bg-string text-string" aria-hidden="true">
              {motionAllowed && (
                <span
                  ref={rippleRef}
                  className="pointer-events-none absolute -inset-[3px] rounded-full border-[1.5px] border-current"
                />
              )}
            </span>
          ) : (
            <Check className="size-3.5 text-ok" aria-hidden="true" />
          )}
          <span>{statusLabel}</span>
        </div>

        <button
          type="button"
          onClick={handleThemeButtonClick}
          aria-label={resolvedScheme === 'dark' ? '切换为浅色「纸」主题' : '切换为深色「夜」主题'}
          title={resolvedScheme === 'dark' ? '切换为浅色「纸」' : '切换为深色「夜」'}
          className="inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-ink-2 transition-colors hover:border-line hover:bg-surface-raised hover:text-ink cursor-pointer"
        >
          {resolvedScheme === 'dark' ? (
            <Sun className="size-4" aria-hidden="true" />
          ) : (
            <Moon className="size-4" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={onToggleEngineering}
          aria-pressed={isDesktopEngineering ? isEngineeringOpen : undefined}
          aria-expanded={!isDesktopEngineering ? isEngineeringOpen : undefined}
          aria-controls={!isDesktopEngineering ? engineeringDrawerId : undefined}
          aria-label="工程画像面板"
          title="工程画像 (Ctrl+.)"
          className={cn(
            'relative inline-flex size-8 items-center justify-center rounded-lg border transition-colors cursor-pointer',
            isEngineeringOpen
              ? 'border-string/40 bg-string-soft text-string-ink'
              : 'border-transparent text-ink-2 hover:border-line hover:bg-surface-raised hover:text-ink'
          )}
        >
          <PanelRight className="size-4" aria-hidden="true" />
          {hasEngineeringAlert && !isEngineeringOpen && (
            <span
              className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-danger"
              aria-hidden="true"
            />
          )}
        </button>
      </div>
    </header>
  );
}
