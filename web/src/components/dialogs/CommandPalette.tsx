import * as React from 'react';
import {
  ArrowRight,
  Folder,
  FolderOpen,
  KeyRound,
  MessageSquare,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import { SUGGESTIONS } from '@/components/chat/EmptyState.js';
import { ResolvedColorScheme } from '@/hooks/useColorScheme.js';
import { SessionSummary } from '@/lib/api.js';
import { gsap, prefersReducedMotion } from '@/lib/gsap.js';
import { getPathBase, splitPathTail } from '@/lib/paths.js';
import { formatRelativeTime } from '@/lib/relativeTime.js';
import { cn } from '@/lib/utils.js';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  busy: boolean;
  activeWorkspace: string;
  recentWorkspaces: string[];
  sessions: SessionSummary[];
  activeSessionId: string | null;
  resolvedScheme: ResolvedColorScheme;
  isSidebarVisible: boolean;
  isEngineeringVisible: boolean;
  onSendPrompt: (prompt: string) => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onBrowseWorkspace: () => void;
  onOpenWorkspaceSwitcher: () => void;
  onSwitchWorkspace: (workspacePath: string) => void;
  onToggleQuickScheme: (origin?: { x: number; y: number }) => void;
  onToggleSidebar: () => void;
  onToggleEngineering: () => void;
  onOpenApiKey: () => void;
  onOpenSettings: () => void;
}

type CommandGroupId = 'workflow' | 'workspace' | 'session' | 'system';

interface PaletteAction {
  id: string;
  group: CommandGroupId;
  groupLabel: string;
  title: string;
  subtitle?: string;
  keywords: string;
  badge?: string;
  shortcut?: string;
  disabled?: boolean;
  icon: React.ReactNode;
  run: () => void;
}

const supportsClosedBy = () =>
  typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;

const GROUP_ORDER: readonly CommandGroupId[] = ['workflow', 'workspace', 'session', 'system'];

export function CommandPalette({
  isOpen,
  onClose,
  busy,
  activeWorkspace,
  recentWorkspaces,
  sessions,
  activeSessionId,
  resolvedScheme,
  isSidebarVisible,
  isEngineeringVisible,
  onSendPrompt,
  onNewSession,
  onSelectSession,
  onBrowseWorkspace,
  onOpenWorkspaceSwitcher,
  onSwitchWorkspace,
  onToggleQuickScheme,
  onToggleSidebar,
  onToggleEngineering,
  onOpenApiKey,
  onOpenSettings,
}: CommandPaletteProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const pointerDownOutsideRef = React.useRef(false);
  const activeItemRef = React.useRef<HTMLButtonElement>(null);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const searchInputId = React.useId();

  React.useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const reduced = prefersReducedMotion();
    let rafId: number | undefined;

    if (isOpen) {
      gsap.killTweensOf(dialog);
      if (!dialog.open) {
        dialog.showModal();
      }
      gsap.fromTo(
        dialog,
        {
          opacity: 0,
          scale: reduced ? 1 : 0.96,
          y: reduced ? 0 : -8,
          '--dialog-backdrop': 0,
        },
        {
          opacity: 1,
          scale: 1,
          y: 0,
          '--dialog-backdrop': 1,
          duration: reduced ? 0.1 : 0.24,
          ease: 'power3.out',
          clearProps: 'transform',
        }
      );

      rafId = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    } else if (dialog.open) {
      gsap.killTweensOf(dialog);
      gsap.to(dialog, {
        opacity: 0,
        scale: reduced ? 1 : 0.97,
        y: reduced ? 0 : -6,
        '--dialog-backdrop': 0,
        duration: reduced ? 0.08 : 0.16,
        ease: 'power2.in',
        onComplete: () => {
          if (dialog.open) {
            dialog.close();
          }
          gsap.set(dialog, { clearProps: 'opacity,transform' });
        },
      });
    }

    return () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [isOpen]);

  const actions = React.useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];

    list.push({
      id: 'new-session',
      group: 'workflow',
      groupLabel: '快速工作流',
      title: '新建对话',
      subtitle: '在当前工作区开启空白会话',
      keywords: 'new session chat 新建 对话',
      shortcut: 'Alt N',
      disabled: busy,
      badge: busy ? '执行中' : undefined,
      icon: <Plus className="size-4 text-string" aria-hidden="true" />,
      run: () => {
        onClose();
        onNewSession();
      },
    });

    for (const item of SUGGESTIONS) {
      list.push({
        id: `suggestion-${item.num}`,
        group: 'workflow',
        groupLabel: '快速工作流',
        title: item.title,
        subtitle: item.subtitle,
        keywords: `${item.title} ${item.subtitle} ${item.prompt}`,
        disabled: busy,
        badge: busy ? '执行中' : undefined,
        icon: <Sparkles className="size-4 text-string" aria-hidden="true" />,
        run: () => {
          onClose();
          onSendPrompt(item.prompt);
        },
      });
    }

    list.push({
      id: 'ws-browse',
      group: 'workspace',
      groupLabel: '工作区',
      title: '浏览选择游戏目录…',
      subtitle: '打开系统原生目录选择窗口并立即切换',
      keywords: 'browse folder picker workspace 浏览 文件夹 目录 工作区',
      disabled: busy,
      badge: busy ? '执行中' : undefined,
      icon: <FolderOpen className="size-4 text-string" aria-hidden="true" />,
      run: () => {
        onClose();
        onBrowseWorkspace();
      },
    });

    list.push({
      id: 'ws-manage',
      group: 'workspace',
      groupLabel: '工作区',
      title: '管理所有工作区',
      subtitle: activeWorkspace || '输入路径或移除历史登记工作区',
      keywords: 'workspace manager switch open 管理 切换 工作区',
      icon: <Folder className="size-4 text-ink-2" aria-hidden="true" />,
      run: () => {
        onClose();
        onOpenWorkspaceSwitcher();
      },
    });

    const activeLower = activeWorkspace.toLowerCase();
    for (const ws of recentWorkspaces) {
      if (!ws.trim() || ws.toLowerCase() === activeLower) continue;
      const base = getPathBase(ws) || ws;
      const { prefix } = splitPathTail(ws);
      list.push({
        id: `ws-switch-${ws}`,
        group: 'workspace',
        groupLabel: '工作区',
        title: `切换到「${base}」`,
        subtitle: prefix ? `${prefix}${base}` : ws,
        keywords: `switch workspace ${ws} ${base} 切换 工作区`,
        disabled: busy,
        badge: busy ? '执行中' : undefined,
        icon: <Folder className="size-4 text-ink-3" aria-hidden="true" />,
        run: () => {
          onClose();
          onSwitchWorkspace(ws);
        },
      });
    }

    for (const session of sessions) {
      const isCurrent = session.id === activeSessionId;
      const rel = formatRelativeTime(session.updatedAt);
      list.push({
        id: `session-${session.id}`,
        group: 'session',
        groupLabel: '当前工作区对话',
        title: session.title,
        subtitle: rel ? `最近更新 ${rel}` : undefined,
        keywords: `session chat history ${session.title}`,
        badge: isCurrent ? '当前' : undefined,
        disabled: busy || isCurrent,
        icon: (
          <MessageSquare
            className={cn('size-4', isCurrent ? 'text-string' : 'text-ink-3')}
            aria-hidden="true"
          />
        ),
        run: () => {
          onClose();
          onSelectSession(session.id);
        },
      });
    }

    list.push({
      id: 'sys-theme',
      group: 'system',
      groupLabel: '界面与系统',
      title: resolvedScheme === 'dark' ? '切换为浅色「纸」主题' : '切换为深色「夜」主题',
      subtitle: '即刻柔和切换纸质光影，再按一次还原跟随系统',
      keywords: 'theme dark light mode paper night 主题 深色 浅色 外观',
      icon:
        resolvedScheme === 'dark' ? (
          <Sun className="size-4 text-string" aria-hidden="true" />
        ) : (
          <Moon className="size-4 text-voice" aria-hidden="true" />
        ),
      run: () => {
        onClose();
        onToggleQuickScheme({
          x: Math.round(window.innerWidth / 2),
          y: Math.round(window.innerHeight / 2),
        });
      },
    });

    list.push({
      id: 'sys-engineering',
      group: 'system',
      groupLabel: '界面与系统',
      title: isEngineeringVisible ? '收起工程画像面板' : '打开工程画像面板',
      subtitle: '查看识别引擎、流水线进度与翻译规划配额',
      keywords: 'engineering inspector status panel 工程 画像 面板',
      shortcut: 'Ctrl .',
      icon: <PanelRight className="size-4 text-ink-2" aria-hidden="true" />,
      run: () => {
        onClose();
        onToggleEngineering();
      },
    });

    list.push({
      id: 'sys-sidebar',
      group: 'system',
      groupLabel: '界面与系统',
      title: isSidebarVisible ? '收起导航侧边栏（专注模式）' : '展开导航侧边栏',
      subtitle: '切换主工作区对话舞台视野宽度',
      keywords: 'sidebar focus mode 侧边栏 专注 视野',
      icon: <PanelLeft className="size-4 text-ink-2" aria-hidden="true" />,
      run: () => {
        onClose();
        onToggleSidebar();
      },
    });

    list.push({
      id: 'sys-apikey',
      group: 'system',
      groupLabel: '界面与系统',
      title: '配置模型 API Key',
      subtitle: '管理 Gemini、Claude、OpenAI、DeepSeek 等模型凭据',
      keywords: 'api key model provider token 密钥 模型',
      disabled: busy,
      badge: busy ? '执行中' : undefined,
      icon: <KeyRound className="size-4 text-ink-2" aria-hidden="true" />,
      run: () => {
        onClose();
        onOpenApiKey();
      },
    });

    list.push({
      id: 'sys-settings',
      group: 'system',
      groupLabel: '界面与系统',
      title: '偏好设置',
      subtitle: '外观跟随策略、环境动效开关与模型凭据入口',
      keywords: 'settings preferences motion 外观 设置 动效',
      icon: <SlidersHorizontal className="size-4 text-ink-2" aria-hidden="true" />,
      run: () => {
        onClose();
        onOpenSettings();
      },
    });

    return list;
  }, [
    activeSessionId,
    activeWorkspace,
    busy,
    isEngineeringVisible,
    isSidebarVisible,
    onBrowseWorkspace,
    onClose,
    onNewSession,
    onOpenApiKey,
    onOpenSettings,
    onOpenWorkspaceSwitcher,
    onSelectSession,
    onSendPrompt,
    onSwitchWorkspace,
    onToggleEngineering,
    onToggleQuickScheme,
    onToggleSidebar,
    recentWorkspaces,
    resolvedScheme,
    sessions,
  ]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    const terms = q.split(/\s+/).filter(Boolean);
    return actions.filter((item) => {
      const hay = `${item.title} ${item.subtitle ?? ''} ${item.keywords}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [actions, query]);

  const orderedGroups = React.useMemo(() => {
    const sections: Array<{ group: CommandGroupId; label: string; items: PaletteAction[] }> = [];
    for (const g of GROUP_ORDER) {
      const items = filtered.filter((a) => a.group === g);
      if (items.length > 0) {
        sections.push({ group: g, label: items[0].groupLabel, items });
      }
    }
    return sections;
  }, [filtered]);

  const flatItems = React.useMemo(
    () => orderedGroups.flatMap((s) => s.items),
    [orderedGroups]
  );

  React.useEffect(() => {
    if (flatItems.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((prev) => {
      if (prev >= 0 && prev < flatItems.length && !flatItems[prev].disabled) {
        return prev;
      }
      const firstEnabled = flatItems.findIndex((i) => !i.disabled);
      return firstEnabled === -1 ? 0 : firstEnabled;
    });
  }, [flatItems]);

  React.useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const moveSelection = (delta: 1 | -1) => {
    if (flatItems.length === 0) return;
    let next = activeIndex;
    for (let step = 0; step < flatItems.length; step++) {
      next = (next + delta + flatItems.length) % flatItems.length;
      if (!flatItems[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const idx = flatItems.findIndex((i) => !i.disabled);
      if (idx !== -1) setActiveIndex(idx);
    } else if (e.key === 'End') {
      e.preventDefault();
      for (let i = flatItems.length - 1; i >= 0; i--) {
        if (!flatItems[i].disabled) {
          setActiveIndex(i);
          break;
        }
      }
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      const target = flatItems[activeIndex];
      if (target && !target.disabled) {
        e.preventDefault();
        target.run();
      }
    }
  };

  const isOutsideRect = (e: { clientX: number; clientY: number }, dialog: HTMLDialogElement) => {
    const r = dialog.getBoundingClientRect();
    return (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    );
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (supportsClosedBy()) return;
    const dialog = dialogRef.current;
    pointerDownOutsideRef.current = !!dialog && e.target === dialog && isOutsideRect(e, dialog);
  };

  const handleClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (supportsClosedBy()) return;
    const dialog = dialogRef.current;
    const startedOutside = pointerDownOutsideRef.current;
    pointerDownOutsideRef.current = false;
    if (!dialog || e.target !== dialog || !startedOutside) return;
    if (isOutsideRect(e, dialog)) onClose();
  };

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    onClose();
  };

  let renderOffset = 0;

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      onCancel={handleCancel}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onClose={() => {
        if (isOpen) onClose();
      }}
      aria-label="命令面板"
      style={{ '--dialog-max-w': '38rem' } as React.CSSProperties}
      className="pc-dialog"
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="size-4 shrink-0 text-string" aria-hidden="true" />
          <label htmlFor={searchInputId} className="visually-hidden">
            搜索工作流、工作区、历史对话或命令
          </label>
          <input
            ref={inputRef}
            id={searchInputId}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            data-autofocus=""
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="搜索命令、本地化工作流、工作区或历史对话…"
            className="h-8 min-w-0 flex-1 bg-transparent text-[0.9375rem] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              aria-label="清空搜索"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-well hover:text-ink cursor-pointer"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="pc-kbd shrink-0 hover:border-string hover:text-ink cursor-pointer"
            aria-label="关闭命令面板"
          >
            Esc
          </button>
        </div>

        <div className="pc-scroller max-h-[min(58dvh,25rem)] space-y-3 overflow-y-auto p-2.5">
          {orderedGroups.length === 0 ? (
            <div className="py-10 text-center text-xs text-ink-3">
              未找到匹配「{query.trim()}」的命令或会话
            </div>
          ) : (
            orderedGroups.map((section) => (
              <div key={section.group} className="space-y-1">
                <div className="px-2.5 pt-1 text-[10.5px] font-semibold tracking-wider text-ink-3 uppercase">
                  {section.label}
                </div>
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const idx = renderOffset++;
                    const isSelected = idx === activeIndex && !item.disabled;
                    return (
                      <button
                        key={item.id}
                        ref={isSelected ? activeItemRef : undefined}
                        type="button"
                        disabled={item.disabled}
                        onMouseEnter={() => {
                          if (!item.disabled) setActiveIndex(idx);
                        }}
                        onClick={() => {
                          if (!item.disabled) item.run();
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer',
                          isSelected
                            ? 'border-string/35 bg-string-soft text-ink'
                            : 'border-transparent text-ink-2 hover:bg-well/80 hover:text-ink'
                        )}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-sheet">
                          {item.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[0.8125rem] font-medium text-ink">
                            {item.title}
                          </span>
                          {item.subtitle && (
                            <span className="block truncate text-[11px] text-ink-3">
                              {item.subtitle}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {item.badge && (
                            <span className="rounded-full border border-line-strong bg-sheet px-2 py-0.5 text-[10.5px] font-medium text-ink-2">
                              {item.badge}
                            </span>
                          )}
                          {item.shortcut && <kbd className="pc-kbd">{item.shortcut}</kbd>}
                          {isSelected && (
                            <ArrowRight className="size-3.5 text-string-ink" aria-hidden="true" />
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-canvas/65 px-4 py-2 text-[11px] text-ink-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <kbd className="pc-kbd">↑</kbd>
              <kbd className="pc-kbd">↓</kbd>
              <span>选择</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="pc-kbd">Enter</kbd>
              <span>执行</span>
            </span>
          </div>
          <span>Paper Cup Studio</span>
        </footer>
      </div>
    </dialog>
  );
}
