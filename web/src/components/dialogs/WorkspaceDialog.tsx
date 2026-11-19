import * as React from 'react';
import { Check, CircleAlert, Folder, FolderOpen, FolderPlus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog.js';
import { pickWorkspaceFolder, removeWorkspace, selectWorkspace } from '@/lib/api.js';
import { getPathBase, splitPathTail } from '@/lib/paths.js';
import { cn } from '@/lib/utils.js';

interface WorkspaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeWorkspace: string;
  recentWorkspaces: string[];
  busy?: boolean;
  onWorkspaceChanged: (newActive: string, recent: string[]) => void;
}

export function WorkspaceDialog({
  isOpen,
  onClose,
  activeWorkspace,
  recentWorkspaces,
  busy = false,
  onWorkspaceChanged,
}: WorkspaceDialogProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();
  const recentHeadingId = React.useId();
  const errorId = React.useId();

  const [newPath, setNewPath] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [picking, setPicking] = React.useState(false);

  React.useEffect(() => {
    if (isOpen) {
      setError('');
    }
  }, [isOpen]);

  const handleSwitch = async (targetPath: string) => {
    if (busy) {
      setError('当前有对话正在执行中，请等待完成或中止后再切换工作区。');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await selectWorkspace(targetPath);
      onWorkspaceChanged(res.active, res.recent);
      setNewPath('');
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '切换工作区失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    if (busy || loading || picking) return;
    setError('');
    setPicking(true);
    let pickedPath: string | null = null;
    try {
      const res = await pickWorkspaceFolder(newPath.trim() || activeWorkspace || undefined);
      if (!res.canceled && res.path) {
        pickedPath = res.path;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '打开系统目录选择器失败');
    } finally {
      setPicking(false);
    }
    if (pickedPath) {
      await handleSwitch(pickedPath);
    }
  };

  const handleAddNew = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPath.trim();
    if (!trimmed || busy || loading || picking) return;
    void handleSwitch(trimmed);
  };

  const handleRemove = async (pathToRemove: string) => {
    if (busy || loading || picking) return;
    setError('');
    try {
      const res = await removeWorkspace(pathToRemove);
      onWorkspaceChanged(res.active, res.recent);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '移除工作区失败');
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="切换工作区"
      icon={<Folder className="size-4 text-string" aria-hidden="true" />}
    >
      <div className="space-y-5 p-5">
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

        <form onSubmit={handleAddNew} className="space-y-1.5">
          <label htmlFor={inputId} className="block text-xs font-medium text-ink-2">
            目录路径
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              ref={inputRef}
              id={inputId}
              name="workspacePath"
              type="text"
              value={newPath}
              disabled={busy || loading || picking}
              onChange={(e) => {
                setNewPath(e.target.value);
                if (error) setError('');
              }}
              data-autofocus=""
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="E:\VisualNovels\MyGame"
              aria-describedby={error ? errorId : undefined}
              className="h-9 min-w-[12rem] flex-1 rounded-xl border border-field bg-well px-3 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 transition-colors focus:border-string focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void handleBrowse()}
              disabled={busy || loading || picking}
              title="通过系统目录窗口选择文件夹"
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-canvas px-3 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-well disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              {picking ? (
                <>
                  <progress className="pc-spinner text-string" aria-label="等待选择目录" />
                  <span>选择中</span>
                </>
              ) : (
                <>
                  <FolderOpen className="size-4 text-string" aria-hidden="true" />
                  <span>浏览…</span>
                </>
              )}
            </button>
            <button
              type="submit"
              disabled={!newPath.trim() || busy || loading || picking}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-string px-3.5 text-[0.8125rem] font-medium text-on-string transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              {loading ? (
                <>
                  <progress className="pc-spinner text-on-string" aria-label="切换中" />
                  <span>切换中</span>
                </>
              ) : (
                <>
                  <FolderPlus className="size-4" aria-hidden="true" />
                  <span>打开</span>
                </>
              )}
            </button>
          </div>
        </form>

        <section aria-labelledby={recentHeadingId}>
          <h3 id={recentHeadingId} className="mb-2 text-xs font-medium text-ink-2">
            已登记的工作区
          </h3>
          {recentWorkspaces.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong py-6 text-center text-xs text-ink-3">
              暂无记录
            </p>
          ) : (
            <ul className="pc-scroller max-h-64 space-y-1 overflow-y-auto">
              {recentWorkspaces.map((wsPath) => {
                const isActive = wsPath.toLowerCase() === activeWorkspace.toLowerCase();
                const base = getPathBase(wsPath) || wsPath;
                const { prefix, base: tail } = splitPathTail(wsPath);

                return (
                  <li key={wsPath} className="pc-reveal-row relative">
                    <button
                      type="button"
                      disabled={isActive || busy || loading || picking}
                      onClick={() => void handleSwitch(wsPath)}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors',
                        !isActive && 'pr-10 cursor-pointer hover:bg-well',
                        isActive
                          ? 'border-string/40 bg-string-soft cursor-default'
                          : 'border-transparent'
                      )}
                    >
                      <Folder
                        className={cn(
                          'size-4 shrink-0',
                          isActive ? 'text-string' : 'text-ink-3'
                        )}
                        aria-hidden="true"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[0.8125rem] font-medium text-ink">
                          {tail || base}
                        </span>
                        {prefix && (
                          <span className="truncate font-mono text-[11px] text-ink-3">
                            {prefix}
                          </span>
                        )}
                      </span>
                      {isActive && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-string/35 bg-sheet px-2 py-0.5 text-[11px] font-medium text-string-ink">
                          <Check className="size-3" aria-hidden="true" />
                          <span>当前</span>
                        </span>
                      )}
                    </button>

                    {!isActive && (
                      <button
                        type="button"
                        disabled={busy || loading || picking}
                        onClick={() => void handleRemove(wsPath)}
                        aria-label={`从列表移除 ${base}`}
                        className="pc-reveal-action absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
