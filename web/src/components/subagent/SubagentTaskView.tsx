import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  FileCode2,
  FolderOutput,
  RefreshCw,
  Square,
} from 'lucide-react';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import { MarkdownContent } from '@/components/chat/MarkdownContent.js';
import { formatToolDuration } from '@/components/chat/ToolCallBlock.js';
import {
  fetchSubagentTaskDetail,
  SubagentTaskSnapshot,
  SubagentTaskSummary,
  SubagentTaskToolEvent,
} from '@/lib/api.js';
import { useGsapDetails } from '@/lib/gsap.js';
import { formatRelativeTime } from '@/lib/relativeTime.js';
import { getToolDisplayLabel } from '@/lib/toolLabels.js';
import { cn } from '@/lib/utils.js';

interface SubagentTaskViewProps {
  taskId: string | null;
  roleFilter?: string;
  tasks: SubagentTaskSummary[];
  currentSessionId: string | null;
  isMainTurnRunning: boolean;
  onBackToChat: () => void;
  onSelectTask: (taskId: string) => void;
  onAbortTurn: () => void;
}

function formatIsoTime(iso?: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatActivityLabel(task: SubagentTaskSummary): string {
  if (task.activityState === 'running_tool') return '正在执行工具';
  if (task.activityState === 'waiting_model') return '等待模型响应';
  if (task.activityState === 'completed') return '执行已完成';
  if (task.activityState === 'aborted') return '已中止';
  if (task.activityState === 'unknown') return '状态未知';
  return '执行异常';
}

function formatTaskStatusBadge(task: SubagentTaskSummary): {
  label: string;
  tone: string;
} {
  if (task.activityState === 'unknown') {
    return {
      label: '状态未知',
      tone: 'border-warn/40 bg-warn-soft text-warn',
    };
  }
  if (task.status === 'running') {
    return {
      label: formatActivityLabel(task),
      tone: 'border-string/45 bg-string-soft text-string-ink',
    };
  }
  if (task.status === 'aborted') {
    return {
      label: '已中止',
      tone: 'border-warn/40 bg-warn-soft text-warn',
    };
  }
  if (task.status === 'error') {
    return {
      label: '执行失败',
      tone: 'border-danger/40 bg-danger-soft text-danger',
    };
  }
  return {
    label: '已完成',
    tone: 'border-ok/40 bg-ok-soft text-ok',
  };
}

function SubagentTimelineToolRow({
  event,
  index,
  controlledOpen,
  onOpenChange,
}: {
  event: SubagentTaskToolEvent;
  index: number;
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { detailsRef, bodyRef, chevronRef, handleSummaryClick, handleToggle } = useGsapDetails({
    controlledOpen,
    onOpenChange,
  });

  const isRunning = event.status === 'running';
  const isAborted = event.status === 'aborted';
  const isError = event.status === 'error' || Boolean(event.isError);
  const label = getToolDisplayLabel(event.tool, event.args);

  return (
    <details
      ref={detailsRef}
      open={controlledOpen}
      onToggle={handleToggle}
      className={cn(
        'pc-details overflow-hidden rounded-xl border transition-colors',
        isRunning
          ? 'border-string/45 bg-string-soft/40'
          : isAborted
            ? 'border-warn/35 bg-warn-soft/35'
            : isError
              ? 'border-danger/35 bg-danger-soft/35'
              : 'border-line bg-sheet hover:border-line-strong'
      )}
    >
      <summary
        onClick={handleSummaryClick}
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs"
      >
        <ChevronRight
          ref={chevronRef}
          className="pc-chevron size-3.5 shrink-0 text-ink-3"
          aria-hidden="true"
        />
        <span className="font-mono text-[11px] text-ink-3">#{index + 1}</span>
        {isRunning ? (
          <PixelCupLoader className="text-string" />
        ) : isAborted ? (
          <Square className="size-3.5 shrink-0 text-warn" aria-hidden="true" />
        ) : isError ? (
          <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
        )}
        <span className="shrink-0 font-medium text-ink">{label}</span>
        <code className="shrink-0 rounded bg-well px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
          {event.tool}
        </code>
        {event.argsSummary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">
            {event.argsSummary}
          </span>
        )}
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
          {event.producedArtifact && (
            <span className="rounded-full border border-ok/35 bg-ok-soft px-1.5 py-0.5 text-ok">
              产出文件
            </span>
          )}
          {event.savedOutputPath && (
            <span className="rounded-full border border-warn/35 bg-warn-soft px-1.5 py-0.5 text-warn">
              已落盘日志
            </span>
          )}
          {typeof event.durationMs === 'number' && (
            <span>{formatToolDuration(event.durationMs)}</span>
          )}
          <span>{formatIsoTime(event.startedAt)}</span>
        </span>
      </summary>

      <div ref={bodyRef} className="space-y-2.5 border-t border-line bg-canvas/60 px-3 py-3 text-xs">
        <div className="flex flex-wrap gap-3 font-mono text-[11px] text-ink-3">
          <span>开始: {formatIsoTime(event.startedAt)}</span>
          {event.endedAt && <span>结束: {formatIsoTime(event.endedAt)}</span>}
          {typeof event.durationMs === 'number' && (
            <span>耗时: {formatToolDuration(event.durationMs)}</span>
          )}
        </div>
        {event.producedArtifact && (
          <div className="rounded-lg border border-ok/30 bg-ok-soft/40 px-2.5 py-1.5 text-ink">
            <span className="font-medium text-ok">写入产物：</span>
            <code className="font-mono text-[11px]">{event.producedArtifact}</code>
          </div>
        )}
        {event.savedOutputPath && (
          <div className="rounded-lg border border-warn/35 bg-warn-soft/45 px-2.5 py-1.5 text-ink">
            <span className="font-medium text-warn">完整输出已转存：</span>
            <code className="font-mono text-[11px]">{event.savedOutputPath}</code>
          </div>
        )}
        {event.args !== undefined && (
          <div>
            <div className="mb-1 text-[11px] font-semibold text-ink-3">参数</div>
            <pre className="pc-scroller max-h-40 overflow-auto rounded-lg border border-line bg-well p-2 font-mono text-[11px] text-ink">
              <code>
                {typeof event.args === 'string' ? event.args : JSON.stringify(event.args, null, 2)}
              </code>
            </pre>
          </div>
        )}
        {event.resultSummary && (
          <div>
            <div className="mb-1 text-[11px] font-semibold text-ink-3">结果摘要</div>
            <pre className="pc-scroller max-h-56 overflow-auto rounded-lg border border-line bg-well p-2 font-mono text-[11px] text-ink-2 whitespace-pre-wrap break-all">
              <code>{event.resultSummary}</code>
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

export function SubagentTaskView({
  taskId,
  roleFilter,
  tasks,
  currentSessionId,
  isMainTurnRunning,
  onBackToChat,
  onSelectTask,
  onAbortTurn,
}: SubagentTaskViewProps) {
  const [detail, setDetail] = React.useState<SubagentTaskSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = React.useState(false);
  const [openByIdx, setOpenByIdx] = React.useState<Record<number, boolean>>({});
  const taskSelectId = React.useId();

  const liveSummary = React.useMemo(
    () => (taskId ? tasks.find((t) => t.taskId === taskId) : undefined),
    [taskId, tasks]
  );

  const loadDetail = React.useCallback(async () => {
    if (!taskId) {
      setDetail(null);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const snap = await fetchSubagentTaskDetail(taskId);
      setDetail(snap);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载子任务详情失败');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  React.useEffect(() => {
    void loadDetail();
    setOnlyErrors(false);
    setOpenByIdx({});
  }, [loadDetail]);

  React.useEffect(() => {
    if (!taskId || !liveSummary) return;
    void fetchSubagentTaskDetail(taskId)
      .then(setDetail)
      .catch(() => {
        // Keep previously loaded detail if transient fetch fails
      });
  }, [
    taskId,
    liveSummary?.lastActivityAt,
    liveSummary?.status,
    liveSummary?.toolCallCount,
    liveSummary?.lastProgressAt,
    liveSummary?.pivotWarningCount,
  ]);

  const selectableTasks = React.useMemo(() => {
    if (!roleFilter) return tasks;
    const roleMatches = tasks.filter((t) => t.role === roleFilter);
    return roleMatches.length > 0 ? roleMatches : tasks;
  }, [tasks, roleFilter]);

  const activeTask = detail ?? liveSummary ?? null;
  const toolCalls = detail?.toolCalls ?? [];
  const errorCallsCount = toolCalls.filter((t) => t.status === 'error' || t.isError).length;
  const visibleToolCalls = onlyErrors
    ? toolCalls
        .map((event, idx) => ({ event, idx }))
        .filter(({ event }) => event.status === 'error' || event.isError)
    : toolCalls.map((event, idx) => ({ event, idx }));

  const badge = activeTask ? formatTaskStatusBadge(activeTask) : null;

  return (
    <div className="mx-auto w-full max-w-[52rem] space-y-5 px-4 pt-5 pb-12 sm:px-6">
      {/* Top navigation & task selector */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line-strong bg-surface-raised px-3.5 py-2.5 shadow-[var(--shadow-card)]">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBackToChat}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:border-line-strong hover:bg-well cursor-pointer"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            <span>返回主对话</span>
          </button>

          {selectableTasks.length > 0 && (
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor={taskSelectId} className="visually-hidden">
                选择子代理任务记录
              </label>
              <select
                id={taskSelectId}
                value={taskId || ''}
                onChange={(e) => {
                  if (e.target.value) onSelectTask(e.target.value);
                }}
                aria-label="选择子代理任务记录"
                className="pc-select max-w-[min(22rem,55vw)] truncate rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-xs text-ink cursor-pointer"
              >
                {selectableTasks.map((t) => {
                  const shortId = t.taskId.slice(-6);
                  const st = formatTaskStatusBadge(t).label;
                  const sameSession = currentSessionId && t.sessionId === currentSessionId;
                  return (
                    <option key={t.taskId} value={t.taskId}>
                      {`${t.role} · ${st} · ${formatIsoTime(t.startedAt)} · #${shortId}${sameSession ? ' (当前会话)' : ''}`}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {taskId && (
            <button
              type="button"
              onClick={() => void loadDetail()}
              disabled={loading}
              aria-label="刷新子任务详情"
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden="true" />
              <span>刷新</span>
            </button>
          )}
          {(activeTask?.status === 'running' || isMainTurnRunning) && (
            <button
              type="button"
              onClick={onAbortTurn}
              className="inline-flex items-center gap-1.5 rounded-lg border border-danger/45 bg-danger-soft px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 cursor-pointer"
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
              <span>停止任务</span>
            </button>
          )}
        </div>
      </div>

      {loadError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-xs text-danger"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span>{loadError}</span>
        </div>
      )}

      {!activeTask ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-sheet/70 px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink">
            {roleFilter ? `角色「${roleFilter}」暂无子任务记录` : '暂无可查看的子代理任务'}
          </p>
          <p className="mt-1.5 text-xs text-ink-3">
            当主会话通过委派或批处理启动该角色后，可在此实时查看其工具调用时间线、落盘产物与异常详情。
          </p>
        </div>
      ) : (
        <>
          {/* Identity & Metadata Card */}
          <section className="rounded-2xl border border-line-strong bg-surface-raised p-4 shadow-[var(--shadow-card)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-base font-semibold text-ink">
                    子代理任务 · <span className="font-mono">{activeTask.role}</span>
                  </h1>
                  {badge && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
                        badge.tone
                      )}
                    >
                      {activeTask.status === 'running' && activeTask.activityState !== 'unknown' && (
                        <PixelCupLoader className="text-current" />
                      )}
                      <span>{badge.label}</span>
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-ink-3">
                  <span>taskId: {activeTask.taskId}</span>
                  <span>stage: {activeTask.stage}</span>
                  <span>session: {activeTask.sessionId || '未知'}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-2">
                <span className="rounded-lg border border-line bg-canvas px-2 py-1">
                  模型: {activeTask.model || '默认'}
                </span>
                <span className="rounded-lg border border-line bg-canvas px-2 py-1">
                  思考: {activeTask.thinkingLevel}
                </span>
              </div>
            </div>
          </section>

          {/* Activity vs Progress Separation Grid */}
          <div className="grid gap-3 sm:grid-cols-3">
            <section className="rounded-2xl border border-line-strong bg-surface-raised p-3.5 shadow-[var(--shadow-card)]">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
                <Activity className="size-3.5 text-string" aria-hidden="true" />
                <span>实际活动状态</span>
              </div>
              <p className="mt-2 text-sm font-medium text-ink">{formatActivityLabel(activeTask)}</p>
              <dl className="mt-2 space-y-1 text-[11.5px] text-ink-3 tabular-nums">
                <div className="flex justify-between gap-2">
                  <dt>最近活动</dt>
                  <dd className="font-mono text-ink-2">
                    {formatIsoTime(activeTask.lastActivityAt)}
                    {formatRelativeTime(activeTask.lastActivityAt)
                      ? ` (${formatRelativeTime(activeTask.lastActivityAt)})`
                      : ''}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>总耗时</dt>
                  <dd className="font-mono text-ink-2">
                    {formatToolDuration(activeTask.durationMs) || '0ms'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>工具调用</dt>
                  <dd className="font-mono text-ink-2">
                    {activeTask.toolCallCount} 次
                    {activeTask.errorCount > 0 ? `（失败 ${activeTask.errorCount}）` : ''}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-2xl border border-line-strong bg-surface-raised p-3.5 shadow-[var(--shadow-card)]">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
                <FolderOutput className="size-3.5 text-ok" aria-hidden="true" />
                <span>有效进展与落盘</span>
              </div>
              {activeTask.lastProgressAt ? (
                <>
                  <p className="mt-2 text-sm font-medium text-ink">
                    {activeTask.lastProgressSummary || '已产生落盘成果'}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-ink-3">
                    最近产出: {formatIsoTime(activeTask.lastProgressAt)}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs leading-5 text-ink-3">
                  暂无新落盘产物（仅有探测或模型推理活动；有活动不代表卡死）
                </p>
              )}
              {detail && detail.artifacts.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {detail.artifacts.slice(0, 5).map((art) => (
                    <li
                      key={art}
                      className="flex items-center gap-1.5 truncate font-mono text-[11px] text-ok"
                      title={art}
                    >
                      <FileCode2 className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{art}</span>
                    </li>
                  ))}
                  {detail.artifacts.length > 5 && (
                    <li className="font-mono text-[10.5px] text-ink-3">
                      +{detail.artifacts.length - 5} 个更多产物
                    </li>
                  )}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-line-strong bg-surface-raised p-3.5 shadow-[var(--shadow-card)]">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
                <Clock className="size-3.5 text-voice" aria-hidden="true" />
                <span>模型用量与连续失败</span>
              </div>
              {detail ? (
                <dl className="mt-2 space-y-1 text-[11.5px] text-ink-3 tabular-nums">
                  <div className="flex justify-between gap-2">
                    <dt>Total Tokens</dt>
                    <dd className="font-mono text-ink-2">
                      {detail.usage.totalTokens.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Input / Output</dt>
                    <dd className="font-mono text-ink-2">
                      {detail.usage.input.toLocaleString()} / {detail.usage.output.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Cache Read</dt>
                    <dd className="font-mono text-ink-2">
                      {detail.usage.cacheRead.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>连续失败 / 换路阈值</dt>
                    <dd
                      className={cn(
                        'font-mono',
                        detail.consecutiveHypothesisFailures > 0 ? 'font-medium text-warn' : 'text-ink-2'
                      )}
                    >
                      {detail.consecutiveHypothesisFailures} / {detail.maxConsecutiveFailures}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-xs text-ink-3">加载用量统计中…</p>
              )}
            </section>
          </div>

          {/* Pivot Warnings & Error Notice */}
          {detail && detail.pivotWarnings.length > 0 && (
            <section
              role="status"
              className="space-y-1.5 rounded-2xl border border-warn/45 bg-warn-soft/50 p-3.5 text-xs text-ink"
            >
              <div className="flex items-center gap-2 font-semibold text-warn">
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                <span>连续失败换路预警（{detail.pivotWarnings.length}）</span>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-ink-2">
                {detail.pivotWarnings.map((warn, i) => (
                  <li key={i}>{warn}</li>
                ))}
              </ul>
            </section>
          )}

          {activeTask.error && (
            <section
              role="alert"
              className="flex items-start gap-2.5 rounded-2xl border border-danger/35 bg-danger-soft p-3.5 text-xs leading-5 text-danger"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="whitespace-pre-wrap break-words">{activeTask.error}</div>
            </section>
          )}

          {/* Delegated Task Prompt */}
          {detail?.taskPrompt && (
            <details className="pc-details overflow-hidden rounded-2xl border border-line bg-sheet">
              <summary className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs font-medium text-ink hover:bg-well/60">
                <span>收到的委派任务指令</span>
                <span className="font-mono text-[11px] text-ink-3">
                  {detail.taskPrompt.length} 字
                </span>
              </summary>
              <pre className="pc-scroller max-h-64 overflow-auto border-t border-line bg-canvas/55 p-3.5 font-mono text-[11.5px] leading-5 text-ink-2 whitespace-pre-wrap break-words">
                <code>{detail.taskPrompt}</code>
              </pre>
            </details>
          )}

          {/* Tool Calls Timeline */}
          <section className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">
                工具调用时间线（{toolCalls.length}）
              </h2>
              <div className="flex flex-wrap items-center gap-1.5">
                {errorCallsCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setOnlyErrors((v) => !v)}
                    aria-pressed={onlyErrors}
                    className={cn(
                      'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
                      onlyErrors
                        ? 'border-danger bg-danger-soft text-danger'
                        : 'border-danger/35 bg-sheet text-danger hover:bg-danger-soft/60'
                    )}
                  >
                    {onlyErrors ? '显示全部调用' : `仅看失败项 (${errorCallsCount})`}
                  </button>
                )}
                {toolCalls.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const next: Record<number, boolean> = {};
                        visibleToolCalls.forEach(({ idx }) => {
                          next[idx] = true;
                        });
                        setOpenByIdx(next);
                      }}
                      className="rounded-lg border border-line bg-sheet px-2.5 py-1 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink cursor-pointer"
                    >
                      展开全部
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenByIdx({})}
                      className="rounded-lg border border-line bg-sheet px-2.5 py-1 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink cursor-pointer"
                    >
                      全部收起
                    </button>
                  </>
                )}
              </div>
            </div>

            {visibleToolCalls.length === 0 ? (
              <div className="rounded-2xl border border-line bg-sheet px-4 py-6 text-center text-xs text-ink-3">
                {toolCalls.length === 0
                  ? '该子任务暂无工具调用记录（可能为无工具角色或尚未执行工具）。'
                  : '当前筛选条件下没有匹配的工具调用。'}
              </div>
            ) : (
              <div className="space-y-2">
                {visibleToolCalls.map(({ event, idx }) => (
                  <SubagentTimelineToolRow
                    key={`${event.callId}-${idx}`}
                    event={event}
                    index={idx}
                    controlledOpen={openByIdx[idx] ?? false}
                    onOpenChange={(open) =>
                      setOpenByIdx((prev) => ({
                        ...prev,
                        [idx]: open,
                      }))
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* Response Preview */}
          {detail?.responsePreview && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-ink">子任务输出摘要</h2>
              <div className="pc-scroller max-h-96 overflow-auto rounded-2xl border border-line-strong bg-surface-raised p-4 shadow-[var(--shadow-card)]">
                <MarkdownContent content={detail.responsePreview} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
