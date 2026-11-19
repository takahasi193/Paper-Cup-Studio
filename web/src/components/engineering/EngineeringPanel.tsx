import * as React from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Compass,
  Cpu,
  FolderArchive,
  Gauge,
  GitBranch,
  Layers,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { EngineeringStatus } from '@/lib/api.js';
import { gsap, prefersReducedMotion, useGsapDetails } from '@/lib/gsap.js';
import { cn } from '@/lib/utils.js';

interface EngineeringPanelProps {
  status: EngineeringStatus | null;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
  closeDataAutofocus?: boolean;
  onSendPrompt?: (prompt: string) => void;
  busy?: boolean;
  inDrawer?: boolean;
}

const QUICK_WORKFLOWS = [
  { label: '解包识别', prompt: '解包当前游戏目录并识别引擎' },
  { label: '检查状态', prompt: '检查当前工作区的本地化状态' },
  { label: '运行 QA', prompt: '对当前译文运行确定性 QA 并汇总问题' },
  { label: '生成验收', prompt: '生成本地化验收与发布报告' },
] as const;

type StageState = 'done' | 'pending' | 'info';

function StageBead({
  icon: Icon,
  title,
  state,
  label,
  tooltip,
  last = false,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  state: StageState;
  label: string;
  tooltip?: string;
  last?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className="relative pb-3.5 last:pb-0" title={tooltip}>
      {!last && (
        <span
          className="absolute top-8 bottom-0 left-[15px] w-px bg-line-strong"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'relative flex size-8 shrink-0 items-center justify-center rounded-full border bg-sheet',
            state === 'done' && 'border-ok/50 bg-ok-soft text-ok',
            state === 'pending' && 'border-line-strong bg-canvas text-ink-3',
            state === 'info' && 'border-string/50 bg-string-soft text-string-ink'
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <span className="text-[0.8125rem] font-medium leading-snug text-ink">{title}</span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              state === 'done' && 'border-ok/35 bg-ok-soft text-ok',
              state === 'pending' && 'border-line bg-canvas text-ink-3',
              state === 'info' && 'border-string/35 bg-string-soft text-string-ink'
            )}
          >
            {state === 'done' && <Check className="size-3" aria-hidden="true" />}
            {state === 'pending' && <Clock className="size-3" aria-hidden="true" />}
            <span>{label}</span>
          </span>
        </div>
      </div>
      {children}
    </li>
  );
}

export function EngineeringPanel({
  status,
  onRefresh,
  onClose,
  closeDataAutofocus = false,
  onSendPrompt,
  busy = false,
  inDrawer = false,
}: EngineeringPanelProps) {
  const [refreshing, setRefreshing] = React.useState(false);

  const pipelineRef = React.useRef<HTMLOListElement>(null);
  const refreshIconRef = React.useRef<SVGSVGElement>(null);
  const segPassedRef = React.useRef<HTMLDivElement>(null);
  const segPendingRef = React.useRef<HTMLDivElement>(null);
  const segFailedRef = React.useRef<HTMLDivElement>(null);

  const { detailsRef, bodyRef, chevronRef, handleSummaryClick, handleToggle } = useGsapDetails();

  const rawEngine = status?.engine?.trim() || '';
  const engineFirstLine = rawEngine.split(/\r?\n/)[0] || '';
  const isUnknownEngine =
    !engineFirstLine ||
    engineFirstLine.includes('未识别') ||
    engineFirstLine.toLowerCase().startsWith('unknown');
  const engineKnown = !!status && !isUnknownEngine;
  const engineDisplay = !status
    ? '正在识别…'
    : engineFirstLine.toLowerCase().startsWith('unknown')
      ? '未识别'
      : engineFirstLine.replace(/\s{2,}/g, ' · ') || '未识别';

  const learnedSkills = status?.skills ?? [];
  const batchProgress = status?.batchProgress ?? null;
  const plan = status?.plan ?? null;
  const checkpoints = status?.checkpoints ?? null;
  const postQa = status?.postQa ?? null;

  const qaStageState: StageState = postQa
    ? postQa.ok
      ? 'done'
      : 'info'
    : batchProgress &&
        batchProgress.qaPassed > 0 &&
        batchProgress.pendingBatches === 0 &&
        batchProgress.savedPendingQa === 0 &&
        batchProgress.qaFailed === 0
      ? 'done'
      : 'info';

  const qaStageLabel = postQa
    ? postQa.ok
      ? `已通过 ${postQa.deterministicPassed} 段`
      : postQa.deterministicFailed > 0
        ? `阻塞 ${postQa.deterministicFailed} 段`
        : postQa.interrupted
          ? `QA 中断（已复核 ${postQa.roleCheckerChunksReviewed}${postQa.roleCheckerChunksTotal ? `/${postQa.roleCheckerChunksTotal}` : ''}）`
          : (postQa.roleCheckerPendingChunks ?? 0) > 0 || (postQa.roleCheckerErrors ?? 0) > 0
            ? `语义待续检 ${postQa.roleCheckerPendingChunks ?? postQa.roleCheckerErrors ?? 0} 片`
            : '语义 QA 未完成'
    : batchProgress && batchProgress.savedPendingQa > 0
      ? `${batchProgress.savedPendingQa} 批待检`
      : '写回前执行';

  // Staggered pipeline stages on mount
  React.useLayoutEffect(() => {
    const list = pipelineRef.current;
    if (!list) return undefined;

    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from(Array.from(list.children), {
        y: 7,
        opacity: 0,
        duration: 0.3,
        stagger: 0.055,
        ease: 'power2.out',
        clearProps: 'transform,opacity',
      });
    });
    return () => mm.revert();
  }, []);

  // Refresh icon GSAP rotation
  React.useLayoutEffect(() => {
    const icon = refreshIconRef.current;
    if (!icon) return undefined;

    if (!refreshing) {
      gsap.killTweensOf(icon);
      gsap.set(icon, { rotation: 0 });
      return undefined;
    }

    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.to(icon, {
        rotation: 360,
        duration: 0.8,
        repeat: -1,
        ease: 'none',
      });
    });
    return () => mm.revert();
  }, [refreshing]);

  // Animate segmented batch distribution bars via GSAP
  React.useLayoutEffect(() => {
    if (!batchProgress || batchProgress.totalBatches <= 0) return;

    const total = batchProgress.totalBatches;
    const passedPct = `${(batchProgress.qaPassed / total) * 100}%`;
    const pendingPct = `${(batchProgress.savedPendingQa / total) * 100}%`;
    const failedPct = `${(batchProgress.qaFailed / total) * 100}%`;
    const duration = prefersReducedMotion() ? 0 : 0.36;

    if (segPassedRef.current) {
      gsap.to(segPassedRef.current, { width: passedPct, duration, ease: 'power2.out' });
    }
    if (segPendingRef.current) {
      gsap.to(segPendingRef.current, { width: pendingPct, duration, ease: 'power2.out' });
    }
    if (segFailedRef.current) {
      gsap.to(segFailedRef.current, { width: failedPct, duration, ease: 'power2.out' });
    }
  }, [
    batchProgress?.qaPassed,
    batchProgress?.savedPendingQa,
    batchProgress?.qaFailed,
    batchProgress?.totalBatches,
  ]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const completionPct =
    batchProgress && batchProgress.totalRows > 0
      ? Math.min(100, Math.max(0, Math.round((batchProgress.checkedInRows / batchProgress.totalRows) * 100)))
      : 0;

  return (
    <div className={cn('flex h-full flex-col text-ink', inDrawer ? 'bg-sheet' : 'bg-transparent')}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-3 pl-4">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-string" aria-hidden="true" />
          <h2 className="text-[0.8125rem] font-semibold text-ink">工程画像</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            aria-label="刷新状态"
            title="刷新状态"
            className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-well hover:text-ink disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw ref={refreshIconRef} className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            {...(closeDataAutofocus ? { 'data-autofocus': '' } : {})}
            onClick={onClose}
            aria-label="关闭面板"
            title="关闭面板"
            className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-well hover:text-ink cursor-pointer"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="pc-scroller flex-1 space-y-3.5 overflow-y-auto p-3.5">
        {/* Ticket-style Engine Card */}
        <section
          aria-label="识别引擎"
          className="rounded-2xl border border-line-strong bg-surface-raised shadow-[var(--shadow-card)]"
        >
          <div className="px-4 pt-3.5 pb-3">
            <div className="text-[11px] font-medium text-ink-3">识别引擎</div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span
                className="truncate font-mono text-base font-semibold tracking-tight text-ink"
                title={rawEngine || undefined}
              >
                {engineDisplay}
              </span>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  engineKnown
                    ? 'border-ok/40 bg-ok-soft text-ok'
                    : 'border-line-strong bg-well text-ink-2'
                )}
              >
                {engineKnown ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : (
                  <Compass className="size-3" aria-hidden="true" />
                )}
                <span>{engineKnown ? '已识别' : '待探针'}</span>
              </span>
            </div>
          </div>
          <div className="pc-ticket-divider flex items-center justify-between px-4 py-2 text-[11px] text-ink-3">
            <span>工作区检测</span>
            <span className="font-mono">{status?.hasUnpacked ? 'UNPACKED' : 'ARCHIVE'}</span>
          </div>
        </section>

        {/* Quick Workflow Launcher */}
        {onSendPrompt && (
          <section
            aria-labelledby="quick-workflows-heading"
            className="rounded-2xl border border-line bg-surface-raised/85 p-3.5"
          >
            <h3 id="quick-workflows-heading" className="mb-2 text-[11px] font-semibold text-ink-3">
              快捷工作流
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              {QUICK_WORKFLOWS.map((wf) => (
                <button
                  key={wf.label}
                  type="button"
                  disabled={busy}
                  onClick={() => onSendPrompt(wf.prompt)}
                  className="inline-flex items-center justify-center rounded-xl border border-line bg-sheet px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-string/45 hover:bg-string-soft/45 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                >
                  {wf.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Batch Progress */}
        {batchProgress && batchProgress.totalBatches > 0 && (
          <section
            aria-labelledby="batch-progress-heading"
            className="space-y-3 rounded-2xl border border-line-strong bg-surface-raised p-4 shadow-[var(--shadow-card)]"
          >
            <div className="flex items-center justify-between gap-2">
              <h3
                id="batch-progress-heading"
                className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-3"
              >
                <ListChecks className="size-3.5 text-string" aria-hidden="true" />
                <span>批次与校验进度</span>
              </h3>
              <span className="font-mono text-[11px] text-ink-2 tabular-nums">
                {batchProgress.checkedInRows}/{batchProgress.totalRows} 段
              </span>
            </div>

            <div className="flex items-center gap-3.5">
              <div
                className="pc-ring-meter"
                style={{ '--p': `${completionPct}%` } as React.CSSProperties}
                role="img"
                aria-label={`行入库完成率 ${completionPct}%`}
              >
                <span className="relative z-10 font-mono text-[11px] font-semibold text-ink tabular-nums">
                  {completionPct}%
                </span>
              </div>

              <dl className="grid flex-1 grid-cols-3 gap-1.5 text-center">
                <div className="rounded-xl border border-line bg-sheet px-1.5 py-1.5">
                  <dt className="text-[10px] text-ink-3">总批次</dt>
                  <dd className="font-mono text-xs font-semibold text-ink tabular-nums">
                    {batchProgress.totalBatches}
                  </dd>
                </div>
                <div className="rounded-xl border border-line bg-sheet px-1.5 py-1.5">
                  <dt className="text-[10px] text-ok">通过</dt>
                  <dd className="font-mono text-xs font-semibold text-ok tabular-nums">
                    {batchProgress.qaPassed}
                  </dd>
                </div>
                <div className="rounded-xl border border-line bg-sheet px-1.5 py-1.5">
                  <dt className="text-[10px] text-ink-3">待完成</dt>
                  <dd className="font-mono text-xs font-semibold text-ink tabular-nums">
                    {batchProgress.pendingBatches + batchProgress.savedPendingQa}
                  </dd>
                </div>
              </dl>
            </div>

            {batchProgress.totalRows > 0 && (
              <progress
                className="pc-progress"
                max={batchProgress.totalRows}
                value={batchProgress.checkedInRows}
                aria-label={`行入库进度：${batchProgress.checkedInRows} / ${batchProgress.totalRows} 段`}
              />
            )}

            <div className="space-y-1.5">
              <div className="text-[11px] text-ink-3">批次校验分布</div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-line">
                {batchProgress.qaPassed > 0 && (
                  <div ref={segPassedRef} className="h-full bg-ok" />
                )}
                {batchProgress.savedPendingQa > 0 && (
                  <div ref={segPendingRef} className="h-full bg-string" />
                )}
                {batchProgress.qaFailed > 0 && (
                  <div ref={segFailedRef} className="h-full bg-danger" />
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <span className="inline-flex items-center gap-1 rounded-full border border-ok/35 bg-ok-soft px-2 py-0.5 font-medium text-ok">
                <Check className="size-3" aria-hidden="true" />
                QA 通过 {batchProgress.qaPassed}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-string/35 bg-string-soft px-2 py-0.5 font-medium text-string-ink">
                <Clock className="size-3" aria-hidden="true" />
                待校验 {batchProgress.savedPendingQa}
              </span>
              {batchProgress.qaFailed > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-danger/35 bg-danger-soft px-2 py-0.5 font-medium text-danger">
                  <CircleAlert className="size-3" aria-hidden="true" />
                  QA 阻塞 {batchProgress.qaFailed}
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-full border border-line bg-sheet px-2 py-0.5 text-ink-3">
                待译 {batchProgress.pendingBatches}
              </span>
            </div>
          </section>
        )}

        {/* Bead Pipeline */}
        <section
          aria-labelledby="pipeline-heading"
          className="rounded-2xl border border-line bg-surface-raised/85 p-4"
        >
          <h3 id="pipeline-heading" className="mb-3 text-[11px] font-semibold text-ink-3">
            流水线阶段
          </h3>
          <ol ref={pipelineRef}>
            <StageBead
              icon={FolderArchive}
              title="解包"
              state={status?.hasUnpacked ? 'done' : 'pending'}
              label={status?.hasUnpacked ? '就绪' : '未生成'}
            />
            <StageBead
              icon={Layers}
              title="分轨产物"
              state={status?.hasBuild ? 'done' : 'pending'}
              label={status?.hasBuild ? '就绪' : '未分轨'}
            />
            <StageBead
              icon={ShieldCheck}
              title="确定性 QA 与并检"
              state={qaStageState}
              label={qaStageLabel}
              last={learnedSkills.length === 0}
            />
            {learnedSkills.length > 0 && (
              <StageBead
                icon={Sparkles}
                title="已学习引擎技能"
                tooltip={learnedSkills.join(', ')}
                state="done"
                label={`${learnedSkills.length} 项`}
                last
              >
                <ul className="mt-2 ml-11 flex flex-wrap gap-1.5">
                  {learnedSkills.map((skillName) => (
                    <li
                      key={skillName}
                      className="rounded-md border border-line bg-sheet px-2 py-0.5 font-mono text-[11px] text-ink-2"
                    >
                      {skillName}
                    </li>
                  ))}
                </ul>
              </StageBead>
            )}
          </ol>
        </section>

        {/* Plan Quotas */}
        {plan && (
          <section
            aria-labelledby="plan-config-heading"
            className="space-y-2.5 rounded-2xl border border-line bg-surface-raised/85 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3
                id="plan-config-heading"
                className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-3"
              >
                <Gauge className="size-3.5 text-string" aria-hidden="true" />
                <span>翻译规划配额</span>
              </h3>
              <span className="rounded-full border border-line bg-sheet px-2 py-0.5 font-mono text-[11px] text-ink-2">
                {plan.modelFamily}
              </span>
            </div>
            <dl className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2 text-ink-2">
                <dt className="shrink-0">单批上限</dt>
                <dd className="font-mono text-ink">
                  {plan.batchMaxLines} 行 / {plan.batchMaxSourceTokens} tok
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 text-ink-2">
                <dt className="shrink-0">会话上限</dt>
                <dd className="font-mono text-ink">{plan.sessionMaxSourceTokens} tok</dd>
              </div>
              <div className="flex items-center justify-between gap-2 text-ink-2">
                <dt className="shrink-0">并发通道</dt>
                <dd className="font-mono text-ink">{plan.concurrency} 路</dd>
              </div>
              {typeof plan.estimatedSourceTokens === 'number' && (
                <div className="flex items-center justify-between gap-2 text-ink-2">
                  <dt className="shrink-0">估算源文</dt>
                  <dd className="font-mono text-ink">{plan.estimatedSourceTokens} tok</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {/* Git Checkpoints */}
        {checkpoints && checkpoints.count > 0 && (
          <section
            aria-labelledby="checkpoints-heading"
            className="space-y-2 rounded-2xl border border-line bg-surface-raised/85 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3
                id="checkpoints-heading"
                className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-3"
              >
                <GitBranch className="size-3.5 text-string" aria-hidden="true" />
                <span>本地 Git 检查点</span>
              </h3>
              <span className="rounded-full border border-line bg-sheet px-2 py-0.5 text-[11px] text-ink-2">
                {checkpoints.count} 次提交
              </span>
            </div>
            {checkpoints.latest && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-sheet px-2.5 py-2 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-mono text-ink">
                    {checkpoints.latest.commit} · {checkpoints.latest.stage}
                  </div>
                  {checkpoints.latest.summary && (
                    <div className="truncate text-[11px] text-ink-3">
                      {checkpoints.latest.summary}
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium',
                    checkpoints.latest.qaVerified
                      ? 'border-ok/35 bg-ok-soft text-ok'
                      : 'border-string/35 bg-string-soft text-string-ink'
                  )}
                >
                  {checkpoints.latest.qaVerified ? 'qa-verified' : 'saved/pending-qa'}
                </span>
              </div>
            )}
            <p className="text-[11px] leading-4 text-ink-3">
              仅作本地文本回溯快照（含媒体/封包排除），提交次数不代表翻译或 QA 完成度。
            </p>
          </section>
        )}

        {/* Raw Diagnostics inside native <details> (GSAP animated) */}
        <details
          ref={detailsRef}
          onToggle={handleToggle}
          className="pc-details rounded-2xl border border-line bg-surface-raised/85"
        >
          <summary
            onClick={handleSummaryClick}
            className="flex items-center gap-2 px-4 py-3 text-xs font-semibold text-ink-2 transition-colors hover:text-ink"
          >
            <ChevronRight
              ref={chevronRef}
              className="pc-chevron size-3.5 shrink-0 text-ink-3"
              aria-hidden="true"
            />
            <span>原始诊断</span>
          </summary>
          <div ref={bodyRef} className="border-t border-line p-3">
            <pre
              role="region"
              aria-label="原始诊断"
              tabIndex={0}
              className="pc-scroller max-h-72 overflow-auto rounded-lg border border-line bg-well p-3 font-mono text-[11.5px] leading-5 text-ink-2 whitespace-pre-wrap"
            >
              <code>{status?.rawStatus || '正在加载状态…'}</code>
            </pre>
          </div>
        </details>
      </div>
    </div>
  );
}
