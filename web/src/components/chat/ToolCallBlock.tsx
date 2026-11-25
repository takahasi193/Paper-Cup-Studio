import * as React from 'react';
import { ArrowUpRight, ChevronRight, FileText } from 'lucide-react';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import { SubagentTaskSummary } from '@/lib/api.js';
import { useGsapDetails } from '@/lib/gsap.js';
import { getToolDisplayLabel } from '@/lib/toolLabels.js';
import { cn } from '@/lib/utils.js';

interface ToolCallBlockProps {
  tool: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  liveDeltaChars?: number;
  subagentTaskId?: string;
  subagentTaskIds?: string[];
  subagentRole?: string;
  linkedSubagentTask?: SubagentTaskSummary;
  onOpenSubagentTask?: (taskId: string, role?: string) => void;
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export type ToolTone = 'running' | 'ok' | 'error' | 'warn';

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const PREVIEW_KEYS = [
  'command',
  'path',
  'file',
  'pattern',
  'query',
  'role',
  'track',
  'batchId',
  'message',
] as const;

function previewArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of PREVIEW_KEYS) {
    const val = record[key];
    if (typeof val === 'string' && val.trim()) {
      return val.replace(/\s+/g, ' ');
    }
  }
  const values = Object.values(record);
  const firstString = values.find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (firstString) return firstString.replace(/\s+/g, ' ');
  return values.length > 0 ? JSON.stringify(args) : '';
}

/** IN：命令类参数直接显示原文，其余以 JSON 展示。 */
function formatInput(args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    const keys = Object.keys(record);
    if (typeof record.command === 'string' && keys.length <= 2) return record.command;
    if (keys.length === 1 && typeof record[keys[0]] === 'string') return record[keys[0]] as string;
  }
  return formatValue(args);
}

/** OUT：优先提取 Pi 工具结果中的文本块，否则回退到完整 JSON。 */
function formatOutput(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (c): c is { type: string; text: string } =>
            Boolean(c) && typeof c === 'object' && (c as any).type === 'text' && typeof (c as any).text === 'string'
        )
        .map((c) => c.text);
      if (texts.length > 0 && texts.some((t) => t.trim() !== '')) return texts.join('\n');
    }
  }
  return formatValue(result);
}

export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function formatMetricsBadge(metrics: unknown): string {
  if (!metrics || typeof metrics !== 'object') return '';
  const record = metrics as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.durationMs === 'number') {
    parts.push(formatToolDuration(record.durationMs));
  }
  const usage = record.usage as Record<string, unknown> | undefined;
  const totalTok = usage?.totalTokens;
  if (typeof totalTok === 'number' && totalTok > 0) {
    parts.push(`${formatTokens(totalTok)} tok`);
  }
  if (typeof record.stopReason === 'string' && record.stopReason && record.stopReason !== 'stop') {
    parts.push(record.stopReason);
  }
  return parts.filter(Boolean).join(' · ');
}

function describeSubagentActivity(task: SubagentTaskSummary): string {
  if (task.activityState === 'running_tool') return '执行工具中';
  if (task.activityState === 'waiting_model') {
    if (task.isThinking) return '思考中';
    if (task.lastProgressSummary) return '生成中';
    return '等待模型';
  }
  if (task.activityState === 'aborted') return '已中止';
  if (task.activityState === 'unknown') return '状态未知';
  if (task.activityState === 'error') return '执行失败';
  return '已完成';
}

export const TOOL_TONE_DOT: Record<ToolTone, string> = {
  running: 'bg-string',
  ok: 'bg-ok',
  error: 'bg-danger',
  warn: 'bg-warn',
};

export function ToolCallBlock({
  tool,
  args,
  result,
  isError = false,
  liveDeltaChars,
  subagentTaskId,
  subagentTaskIds,
  subagentRole,
  linkedSubagentTask,
  onOpenSubagentTask,
  controlledOpen,
  onOpenChange,
}: ToolCallBlockProps) {
  const { detailsRef, bodyRef, chevronRef, handleSummaryClick, handleToggle } = useGsapDetails({
    controlledOpen,
    onOpenChange,
  });

  const isFinished = result !== undefined && result !== null;
  const resultObj = result && typeof result === 'object' ? (result as Record<string, any>) : null;
  const isInterrupted = Boolean(resultObj?.details?.status === 'interrupted');
  const isAborted = Boolean(resultObj?.details?.status === 'aborted');
  const hasError = isError || Boolean(resultObj?.isError);
  const metrics = resultObj?.details?.metrics;
  const metricsBadge = isFinished ? formatMetricsBadge(metrics) : '';
  const durationMs = typeof metrics?.durationMs === 'number' ? (metrics.durationMs as number) : undefined;
  const preview = previewArgs(args);
  const hasArgs = Boolean(args && typeof args === 'object' && Object.keys(args as object).length > 0);
  const displayLabel = getToolDisplayLabel(tool, args);
  const savedOutputPath =
    typeof resultObj?.details?.savedOutputPath === 'string'
      ? (resultObj.details.savedOutputPath as string)
      : undefined;

  const targetTaskId =
    linkedSubagentTask?.taskId ||
    subagentTaskId ||
    (typeof resultObj?.details?.taskId === 'string' ? resultObj.details.taskId : undefined) ||
    subagentTaskIds?.[subagentTaskIds.length - 1] ||
    (Array.isArray(resultObj?.details?.subagentTaskIds)
      ? String(resultObj.details.subagentTaskIds[resultObj.details.subagentTaskIds.length - 1] || '')
      : undefined);

  const effectiveRole =
    linkedSubagentTask?.role ||
    subagentRole ||
    (typeof resultObj?.details?.role === 'string' ? resultObj.details.role : undefined);

  const tone: ToolTone = !isFinished
    ? 'running'
    : isInterrupted || isAborted
      ? 'warn'
      : hasError
        ? 'error'
        : 'ok';

  const statusText =
    tone === 'running'
      ? '执行中'
      : isInterrupted
        ? '已中断'
        : isAborted
          ? '已中止'
          : tone === 'error'
            ? '失败'
            : '完成';

  return (
    <details
      ref={detailsRef}
      open={controlledOpen}
      onToggle={handleToggle}
      className="pc-details group/tool w-full"
    >
      <summary
        onClick={handleSummaryClick}
        title={`${tool} · ${statusText}`}
        className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[0.8125rem] leading-5 transition-colors hover:bg-well group-open/tool:bg-well/70"
      >
        <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
          <span className={cn('size-1.5 rounded-full', TOOL_TONE_DOT[tone])} />
        </span>
        <span className="visually-hidden">{statusText}：</span>

        <span
          className={cn(
            'shrink-0 font-medium',
            tone === 'error' ? 'text-danger' : tone === 'running' ? 'text-ink' : 'text-ink-2'
          )}
        >
          {displayLabel}
        </span>

        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-3">{preview}</span>

        <span className="flex shrink-0 items-center gap-2 text-[11px] text-ink-3">
          {linkedSubagentTask && (
            <span className="hidden max-w-64 truncate font-mono sm:inline">
              {linkedSubagentTask.role === 'translator' && linkedSubagentTask.lastProgressSummary ? (
                linkedSubagentTask.lastProgressSummary
              ) : (
                <>
                  {describeSubagentActivity(linkedSubagentTask)} · {linkedSubagentTask.toolCallCount} 次工具
                  {linkedSubagentTask.artifactsCount > 0 && (
                    <span className="text-ok"> · {linkedSubagentTask.artifactsCount} 产物</span>
                  )}
                </>
              )}
            </span>
          )}
          {targetTaskId && onOpenSubagentTask && (
            <button
              type="button"
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenSubagentTask(targetTaskId, effectiveRole);
              }}
              className="inline-flex items-center justify-center gap-0.5 rounded px-1 font-medium text-string-ink transition-colors hover:bg-string-soft cursor-pointer"
            >
              <span>子任务</span>
              <ArrowUpRight className="size-3" aria-hidden="true" />
            </button>
          )}

          {tone === 'running' ? (
            <>
              {typeof liveDeltaChars === 'number' && liveDeltaChars > 0 && (
                <span className="font-mono text-string-ink">{liveDeltaChars} 字</span>
              )}
              <PixelCupLoader className="text-string" />
            </>
          ) : (
            <>
              {tone !== 'ok' && (
                <span className={tone === 'error' ? 'text-danger' : 'text-warn'}>{statusText}</span>
              )}
              {durationMs !== undefined && (
                <span className="font-mono tabular-nums">{formatToolDuration(durationMs)}</span>
              )}
            </>
          )}

          <ChevronRight
            ref={chevronRef}
            className="pc-chevron size-3.5 shrink-0 opacity-0 transition-opacity group-hover/tool:opacity-100 group-open/tool:opacity-100"
            aria-hidden="true"
          />
        </span>
      </summary>

      <div ref={bodyRef} className="pt-1 pb-2 pl-6">
        {savedOutputPath && (
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
            <FileText className="size-3 shrink-0 text-warn" aria-hidden="true" />
            <span className="shrink-0">完整脱敏输出已落盘：</span>
            <code className="truncate font-mono text-ink-2">{savedOutputPath}</code>
          </p>
        )}
        <div className="overflow-hidden rounded-xl border border-line-strong bg-surface-raised font-mono text-[11.5px] leading-5 shadow-[var(--shadow-card)]">
          {hasArgs && (
            <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] border-b border-line">
              <span className="px-2.5 py-2 text-[10px] font-semibold tracking-wider text-ink-3">IN</span>
              <pre
                role="region"
                aria-label="输入"
                tabIndex={0}
                className="pc-scroller max-h-40 overflow-auto py-2 pr-2.5 text-ink whitespace-pre-wrap break-all"
              >
                <code>{formatInput(args)}</code>
              </pre>
            </div>
          )}
          <div className="grid grid-cols-[2.5rem_minmax(0,1fr)]">
            <span className="px-2.5 py-2 text-[10px] font-semibold tracking-wider text-ink-3">OUT</span>
            {isFinished ? (
              <pre
                role="region"
                aria-label="输出"
                tabIndex={0}
                className={cn(
                  'pc-scroller max-h-64 overflow-auto py-2 pr-2.5 whitespace-pre-wrap break-all',
                  tone === 'error' ? 'text-danger' : 'text-ink-2'
                )}
              >
                <code>{formatOutput(result)}</code>
              </pre>
            ) : (
              <p className="flex items-center gap-2 py-2 pr-2.5 font-sans text-xs text-ink-3">
                <PixelCupLoader className="text-string" />
                <span>
                  {typeof liveDeltaChars === 'number' && liveDeltaChars > 0
                    ? `等待工具返回…（已接收子代理输出 ${liveDeltaChars} 字）`
                    : '等待工具返回…'}
                </span>
              </p>
            )}
          </div>
          {metricsBadge && (durationMs === undefined || metricsBadge !== formatToolDuration(durationMs)) && (
            <div className="border-t border-line px-2.5 py-1 text-[10.5px] text-ink-3">{metricsBadge}</div>
          )}
        </div>
      </div>
    </details>
  );
}
