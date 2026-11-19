import * as React from 'react';
import { ChevronRight, SquareTerminal, Wrench } from 'lucide-react';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import { ToolCallItem } from '@/hooks/useAgentStream.js';
import { SubagentTaskSummary } from '@/lib/api.js';
import { useGsapDetails } from '@/lib/gsap.js';
import { cn } from '@/lib/utils.js';
import { formatToolDuration, ToolCallBlock } from './ToolCallBlock.js';

interface ToolCallGroupProps {
  tools: ToolCallItem[];
  subagentTasks?: SubagentTaskSummary[];
  onOpenSubagentTask?: (taskId: string, role?: string) => void;
}

function isToolFinished(t: ToolCallItem): boolean {
  return t.result !== undefined && t.result !== null;
}

function isToolFailed(t: ToolCallItem): boolean {
  if (t.isError) return true;
  if (t.result && typeof t.result === 'object') {
    const r = t.result as Record<string, any>;
    return Boolean(r.isError || r.details?.status === 'interrupted' || r.details?.status === 'aborted');
  }
  return false;
}

function getToolDurationMs(t: ToolCallItem): number {
  if (t.result && typeof t.result === 'object') {
    const ms = (t.result as Record<string, any>)?.details?.metrics?.durationMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
      return ms;
    }
  }
  return 0;
}

function findLinkedTask(
  tool: ToolCallItem,
  subagentTasks: SubagentTaskSummary[]
): SubagentTaskSummary | undefined {
  if (subagentTasks.length === 0) return undefined;
  if (tool.subagentTaskId) {
    const exact = subagentTasks.find((s) => s.taskId === tool.subagentTaskId);
    if (exact) return exact;
  }
  if (tool.subagentTaskIds && tool.subagentTaskIds.length > 0) {
    const lastId = tool.subagentTaskIds[tool.subagentTaskIds.length - 1];
    const match = subagentTasks.find((s) => s.taskId === lastId);
    if (match) return match;
  }
  if (tool.callId) {
    return subagentTasks.find((s) => s.parentCallId === tool.callId);
  }
  return undefined;
}

/**
 * 工具调用分组：参考 Claude Code Desktop，以一行可折叠摘要呈现
 * （「运行了 N 条命令 · 失败 1 · 12.3s」），展开后为无边框紧凑行列表；
 * 折叠时仍实时露出正在执行的调用，保证过程可见。
 */
export function ToolCallGroup({
  tools,
  subagentTasks = [],
  onOpenSubagentTask,
}: ToolCallGroupProps) {
  const [open, setOpen] = React.useState(false);
  const { detailsRef, bodyRef, chevronRef, handleSummaryClick, handleToggle } = useGsapDetails({
    onOpenChange: setOpen,
  });

  if (tools.length === 0) return null;

  const renderRow = (t: ToolCallItem, index: number) => (
    <ToolCallBlock
      key={t.callId || index}
      tool={t.tool}
      args={t.args}
      result={t.result}
      isError={t.isError}
      liveDeltaChars={t.liveDeltaChars}
      subagentTaskId={t.subagentTaskId}
      subagentTaskIds={t.subagentTaskIds}
      subagentRole={t.subagentRole}
      linkedSubagentTask={findLinkedTask(t, subagentTasks)}
      onOpenSubagentTask={onOpenSubagentTask}
    />
  );

  if (tools.length === 1) {
    return <div className="-mx-1.5">{renderRow(tools[0], 0)}</div>;
  }

  let completedCount = 0;
  let runningCount = 0;
  let errorCount = 0;
  let totalDurationMs = 0;
  tools.forEach((t) => {
    if (!isToolFinished(t)) runningCount += 1;
    else if (isToolFailed(t)) errorCount += 1;
    else completedCount += 1;
    totalDurationMs += getToolDurationMs(t);
  });

  const allBash = tools.every((t) => t.tool === 'bash');
  const isRunning = runningCount > 0;
  const title = isRunning
    ? `正在执行 · ${tools.length - runningCount}/${tools.length}`
    : allBash
      ? `运行了 ${tools.length} 条命令`
      : `调用了 ${tools.length} 个工具`;
  const SummaryIcon = allBash ? SquareTerminal : Wrench;

  const runningEntries = tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => !isToolFinished(tool));

  return (
    <div>
      <details ref={detailsRef} onToggle={handleToggle} className="pc-details w-full">
        <summary
          onClick={handleSummaryClick}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised/85 px-2.5 py-1 text-xs text-ink-2 shadow-2xs transition-colors hover:border-line-strong hover:text-ink"
        >
          <ChevronRight ref={chevronRef} className="pc-chevron size-3.5 shrink-0" aria-hidden="true" />
          {isRunning ? (
            <PixelCupLoader className="text-string" />
          ) : (
            <SummaryIcon className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className={cn(isRunning && 'font-medium text-string-ink')}>{title}</span>
          {errorCount > 0 && <span className="text-danger">· 失败 {errorCount}</span>}
          {!isRunning && completedCount > 0 && errorCount > 0 && (
            <span>· 成功 {completedCount}</span>
          )}
          {totalDurationMs > 0 && (
            <span className="font-mono tabular-nums">· {formatToolDuration(totalDurationMs)}</span>
          )}
        </summary>
        <div ref={bodyRef} className="mt-0.5 ml-[7px] border-l border-line pl-2">
          {tools.map((t, index) => renderRow(t, index))}
        </div>
      </details>

      {!open && runningEntries.length > 0 && (
        <div className="mt-0.5 ml-[7px] border-l border-string/40 pl-2">
          {runningEntries.map(({ tool, index }) => renderRow(tool, index))}
        </div>
      )}
    </div>
  );
}
