import * as React from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Clock,
  CornerDownRight,
  FileCode2,
  Flame,
  ImagePlus,
  ListEnd,
  Minimize2,
  RefreshCw,
  Square,
  XCircle,
} from 'lucide-react';
import { PixelCupLoader } from '@/components/brand/PixelCupLoader.js';
import { formatCompactionTokens } from '@/components/chat/CompactionDividerCard.js';
import { ImageAttachmentStrip } from '@/components/chat/ImageAttachmentStrip.js';
import { MessageItem } from '@/components/chat/MessageItem.js';
import { PendingQueueTray } from '@/components/chat/PendingQueueTray.js';
import { ToolCallGroup } from '@/components/chat/ToolCallGroup.js';
import { ToastItem } from '@/components/ui/ToastRegion.js';
import { ChatMessage, ToolCallItem } from '@/hooks/useAgentStream.js';
import {
  ApiRequestError,
  ChatImageAttachment,
  clearSubagentQueue,
  compactSubagent,
  enqueueSubagentMessage,
  fetchSubagentTaskDetail,
  MAX_IMAGES_PER_MESSAGE,
  parseSlashCompactCommand,
  PendingQueueState,
  QueuedCompactionInfo,
  QueuedMessageItem,
  QueuedMessageMode,
  removeSubagentQueueItem,
  RestoredDraftPayload,
  sendSubagentMessage,
  SubagentChatMessage,
  SubagentChatToolCall,
  SubagentQueueRestoredEvent,
  SubagentQueueUpdatedEvent,
  SubagentStreamDeltaEvent,
  SubagentTaskSnapshot,
  SubagentTaskSummary,
  SubagentTaskToolEvent,
  switchSubagentQueueItemMode,
} from '@/lib/api.js';
import {
  extractClipboardImageFiles,
  readImageFilesToAttachments,
} from '@/lib/imageAttachments.js';
import {
  applyOffsetDeltaChunk,
  LiveMessageOverlay,
  PreBaselineMessageBuffer,
  reconcileBufferedChunks,
  reconcileOverlayWithSnapshot,
} from '@/lib/subagentStreamReconcile.js';
import { cn } from '@/lib/utils.js';

export interface SubagentTaskViewProps {
  taskId: string | null;
  roleFilter?: string;
  tasks: SubagentTaskSummary[];
  currentSessionId: string | null;
  isMainTurnRunning: boolean;
  motionAllowed?: boolean;
  modelSupportsImage?: boolean;
  activeDirectSubagentTaskId?: string | null;
  subscribeSubagentStream?: (listener: (ev: SubagentStreamDeltaEvent) => void) => () => void;
  subscribeSubagentQueue?: (listener: (ev: SubagentQueueUpdatedEvent) => void) => () => void;
  subscribeSubagentQueueRestored?: (
    listener: (ev: SubagentQueueRestoredEvent) => void
  ) => () => void;
  onShowToast?: (toast: Omit<ToastItem, 'id'>) => void;
  onBackToChat: () => void;
  onSelectTask: (taskId: string) => void;
  onAbortTurn: () => void;
  onAbortSubagentTask?: (taskId: string) => Promise<RestoredDraftPayload | null | void> | void;
}

const EMPTY_QUEUE: PendingQueueState = { steering: [], followUp: [] };

interface SubagentThreadGroup {
  threadId: string;
  latestTask: SubagentTaskSummary;
  turnCount: number;
  taskIds: string[];
}

const supportsFieldSizing =
  typeof window !== 'undefined' && Boolean(window.CSS?.supports?.('field-sizing', 'content'));

function roleDisplayName(role?: string | null): string {
  switch (role) {
    case 'reverser':
      return 'Reverser 逆向工程师';
    case 'role-checker':
      return 'Role Checker 审校专家';
    case 'translator':
      return 'Translator 批量译员';
    default:
      return role || 'Subagent';
  }
}

function roleAssistantLabel(role?: string | null): string {
  switch (role) {
    case 'reverser':
      return 'Reverser';
    case 'role-checker':
      return 'Role Checker';
    case 'translator':
      return 'Translator';
    default:
      return role || 'Subagent';
  }
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${mins}m ${rem}s`;
}

function formatClockTime(isoOrLabel?: string): string {
  if (!isoOrLabel) return '';
  const d = new Date(isoOrLabel);
  if (Number.isNaN(d.getTime())) return isoOrLabel;
  return d.toLocaleTimeString();
}

function statusMeta(status: SubagentTaskSummary['status'], isThinking?: boolean, activityState?: string) {
  if (activityState === 'compacting') {
    return {
      label: '正在压缩上下文…',
      className: 'border-string/35 bg-string-soft text-string-ink',
      icon: 'loader' as const,
    };
  }
  switch (status) {
    case 'running':
      return {
        label: isThinking
          ? '思考中'
          : activityState === 'running_tool'
            ? '执行工具中'
            : '生成中',
        className: 'border-string/35 bg-string-soft text-string-ink',
        icon: 'loader' as const,
      };
    case 'completed':
      return {
        label: '已完成',
        className: 'border-ok/35 bg-ok-soft text-ok',
        icon: 'ok' as const,
      };
    case 'aborted':
      return {
        label: '已中断',
        className: 'border-warn/35 bg-warn-soft text-warn',
        icon: 'warn' as const,
      };
    case 'error':
    default:
      return {
        label: '失败',
        className: 'border-danger/35 bg-danger-soft text-danger',
        icon: 'error' as const,
      };
  }
}

function mapChatToolToItem(tc: SubagentChatToolCall): ToolCallItem {
  return {
    callId: tc.callId,
    tool: tc.tool,
    args: tc.args,
    isError: tc.isError,
    result:
      tc.status === 'running'
        ? undefined
        : {
            content: tc.result ? [{ type: 'text', text: tc.result }] : [],
            isError: tc.isError,
            details: {
              ...(tc.durationMs !== undefined ? { metrics: { durationMs: tc.durationMs } } : {}),
              ...(tc.savedOutputPath ? { savedOutputPath: tc.savedOutputPath } : {}),
              status: tc.status,
            },
          },
  };
}

function mapLegacyToolToItem(tc: SubagentTaskToolEvent): ToolCallItem {
  return {
    callId: tc.callId,
    tool: tc.tool,
    args: tc.args ?? tc.argsSummary,
    isError: tc.isError,
    result:
      tc.status === 'running'
        ? undefined
        : {
            content: tc.resultSummary ? [{ type: 'text', text: tc.resultSummary }] : [],
            isError: tc.isError,
            details: {
              ...(tc.durationMs !== undefined ? { metrics: { durationMs: tc.durationMs } } : {}),
              ...(tc.savedOutputPath ? { savedOutputPath: tc.savedOutputPath } : {}),
              status: tc.status,
            },
          },
  };
}

function toDisplayMessages(
  snapshot: SubagentTaskSnapshot,
  overlays: Record<string, LiveMessageOverlay>
): Array<{ chatMessage: ChatMessage; origin?: 'delegated' | 'direct_user'; turnTaskId?: string }> {
  const source: SubagentChatMessage[] = Array.isArray(snapshot.messages)
    ? snapshot.messages
    : [
        ...(snapshot.taskPrompt
          ? [
              {
                id: `${snapshot.taskId}-legacy-u`,
                role: 'user' as const,
                content: snapshot.taskPrompt,
                timestamp: snapshot.startedAt,
                turnTaskId: snapshot.taskId,
                origin: 'delegated' as const,
              },
            ]
          : []),
        ...(snapshot.responsePreview || snapshot.toolCalls.length > 0 || snapshot.error
          ? [
              {
                id: `${snapshot.taskId}-legacy-a`,
                role: 'assistant' as const,
                content: snapshot.responsePreview || snapshot.error || '',
                tools: snapshot.toolCalls.map((t) => ({
                  callId: t.callId,
                  tool: t.tool,
                  args: t.args,
                  result: t.resultSummary,
                  isError: t.isError,
                  status: t.status,
                  durationMs: t.durationMs,
                  savedOutputPath: t.savedOutputPath,
                  producedArtifact: t.producedArtifact,
                })),
                timestamp: snapshot.endedAt || snapshot.lastActivityAt,
                error: snapshot.status === 'error' || snapshot.status === 'aborted',
                turnTaskId: snapshot.taskId,
              },
            ]
          : []),
      ];

  return source.map((m) => {
    const live = overlays[m.id];
    const snapThinking = m.thinking ?? '';
    const snapThinkingOffset = m.thinkingOffset ?? snapThinking.length;
    const snapContent = m.content ?? '';
    const snapContentOffset = m.contentOffset ?? snapContent.length;
    const resolvedThinking =
      live && live.thinking.offset > snapThinkingOffset ? live.thinking.text : snapThinking;
    const resolvedContent =
      live && live.content.offset > snapContentOffset ? live.content.text : snapContent;

    return {
      origin: m.origin,
      turnTaskId: m.turnTaskId,
      chatMessage: {
        id: m.id,
        role: m.role,
        content: resolvedContent,
        ...(Array.isArray(m.images) && m.images.length > 0 ? { images: m.images } : {}),
        ...(resolvedThinking ? { thinking: resolvedThinking } : {}),
        ...(Array.isArray(m.tools) && m.tools.length > 0
          ? { tools: m.tools.map(mapChatToolToItem) }
          : {}),
        timestamp: formatClockTime(m.timestamp),
        ...(m.error ? { error: true } : {}),
        ...(m.deliveryMode ? { deliveryMode: m.deliveryMode } : {}),
        ...(m.compaction ? { compaction: m.compaction } : {}),
      },
    };
  });
}

export function SubagentTaskView({
  taskId,
  roleFilter,
  tasks,
  currentSessionId,
  isMainTurnRunning,
  motionAllowed = true,
  modelSupportsImage,
  activeDirectSubagentTaskId = null,
  subscribeSubagentStream,
  subscribeSubagentQueue,
  subscribeSubagentQueueRestored,
  onShowToast,
  onBackToChat,
  onSelectTask,
  onAbortTurn,
  onAbortSubagentTask,
}: SubagentTaskViewProps) {
  const [detail, setDetail] = React.useState<SubagentTaskSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [overlays, setOverlays] = React.useState<Record<string, LiveMessageOverlay>>({});
  const [pendingQueue, setPendingQueue] = React.useState<PendingQueueState>(EMPTY_QUEUE);
  const [queueBusyItemId, setQueueBusyItemId] = React.useState<string | null>(null);
  const [queueClearing, setQueueClearing] = React.useState(false);
  const [queueAnnouncement, setQueueAnnouncement] = React.useState('');
  const [optimisticTurn, setOptimisticTurn] = React.useState<{
    taskId: string;
    role: string;
    priorEntries: Array<{ chatMessage: ChatMessage; origin?: 'delegated' | 'direct_user'; turnTaskId?: string }>;
    userMessage: ChatMessage;
  } | null>(null);

  const [draft, setDraft] = React.useState('');
  const [images, setImages] = React.useState<ChatImageAttachment[]>([]);
  const [imageNotice, setImageNotice] = React.useState<string | null>(null);
  const [isDraggingImage, setIsDraggingImage] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [compactingSubagent, setCompactingSubagent] = React.useState(false);
  const [localQueuedCompaction, setLocalQueuedCompaction] = React.useState<QueuedCompactionInfo | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = React.useState(true);

  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const bottomSentinelRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const baselineReadyTaskRef = React.useRef<string | null>(null);
  const preBaselineBufferRef = React.useRef<Record<string, PreBaselineMessageBuffer>>({});
  const handledRestoreIdsRef = React.useRef<Set<string>>(new Set());
  const detailRef = React.useRef<SubagentTaskSnapshot | null>(null);
  detailRef.current = detail;
  const optimisticTaskIdRef = React.useRef<string | null>(null);
  optimisticTaskIdRef.current = optimisticTurn?.taskId ?? null;
  const activeDirectTaskIdRef = React.useRef<string | null>(null);
  activeDirectTaskIdRef.current = activeDirectSubagentTaskId;
  const loadDetailAbortRef = React.useRef<AbortController | null>(null);
  const loadDetailSeqRef = React.useRef(0);
  const gapReloadTimerRef = React.useRef<number | null>(null);

  // Build thread selector groups ordered newest-first
  const { threadGroups, resolvedTaskId, activeSummary } = React.useMemo(() => {
    const filtered = roleFilter ? tasks.filter((t) => t.role === roleFilter) : tasks;
    const baseList = filtered.length > 0 ? filtered : tasks;
    const sessionScoped = currentSessionId
      ? baseList.filter((t) => !t.sessionId || t.sessionId === currentSessionId)
      : baseList;
    const sorted = [...(sessionScoped.length > 0 ? sessionScoped : baseList)].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    );

    const groupsMap = new Map<string, SubagentThreadGroup>();
    for (const item of sorted) {
      const tid = item.threadId || item.taskId;
      const existing = groupsMap.get(tid);
      if (!existing) {
        groupsMap.set(tid, {
          threadId: tid,
          latestTask: item,
          turnCount: 1,
          taskIds: [item.taskId],
        });
      } else {
        existing.turnCount += 1;
        existing.taskIds.push(item.taskId);
      }
    }

    const explicitMatch = taskId ? tasks.find((t) => t.taskId === taskId) : undefined;
    const fallbackTaskId = sorted[0]?.taskId ?? null;
    const resolved = taskId ?? fallbackTaskId;
    const summary = explicitMatch ?? (resolved ? tasks.find((t) => t.taskId === resolved) : undefined) ?? null;

    return {
      threadGroups: Array.from(groupsMap.values()),
      resolvedTaskId: resolved,
      activeSummary: summary,
    };
  }, [tasks, taskId, roleFilter, currentSessionId]);

  const resolvedTaskIdRef = React.useRef<string | null>(resolvedTaskId);
  resolvedTaskIdRef.current = resolvedTaskId;

  const scheduleGapReloadRef = React.useRef<(targetId: string) => void>(() => {});

  const applySnapshotAndReconcile = React.useCallback((snap: SubagentTaskSnapshot) => {
    const firstForTask = baselineReadyTaskRef.current !== snap.taskId;
    baselineReadyTaskRef.current = snap.taskId;
    const preBuf = firstForTask ? preBaselineBufferRef.current : {};
    if (firstForTask) {
      preBaselineBufferRef.current = {};
    }

    let needGapReload = false;
    setOverlays((prev) => {
      const next: Record<string, LiveMessageOverlay> = firstForTask ? {} : { ...prev };
      const msgs = snap.messages ?? [];
      for (const m of msgs) {
        if (m.role !== 'assistant') continue;
        const snapThinking = m.thinking ?? '';
        const snapContent = m.content ?? '';
        if (firstForTask) {
          const buf = preBuf[m.id];
          if (buf) {
            const recThinking = reconcileBufferedChunks(snapThinking, m.thinkingOffset, buf.thinking);
            const recContent = reconcileBufferedChunks(snapContent, m.contentOffset, buf.content);
            if (recThinking.gapDetected || recContent.gapDetected) {
              needGapReload = true;
            }
            if (recThinking.aheadOfSnapshot || recContent.aheadOfSnapshot) {
              next[m.id] = {
                thinking: recThinking.field,
                content: recContent.field,
              };
            }
          }
        } else {
          const existing = next[m.id];
          if (existing) {
            const recThinking = reconcileOverlayWithSnapshot(
              snapThinking,
              m.thinkingOffset,
              existing.thinking
            );
            const recContent = reconcileOverlayWithSnapshot(
              snapContent,
              m.contentOffset,
              existing.content
            );
            if (!recThinking.aheadOfSnapshot && !recContent.aheadOfSnapshot) {
              delete next[m.id];
            } else {
              next[m.id] = {
                thinking: recThinking.field,
                content: recContent.field,
              };
            }
          }
        }
      }
      return next;
    });

    detailRef.current = snap;
    setDetail(snap);
    setLoading(false);
    setPendingQueue(snap.status === 'running' && snap.pendingQueue ? snap.pendingQueue : EMPTY_QUEUE);
    if (snap.status !== 'running') {
      setLocalQueuedCompaction(null);
    } else if (snap.queuedCompaction !== undefined) {
      setLocalQueuedCompaction(snap.queuedCompaction ?? null);
    }
    setOptimisticTurn((prev) => (prev && prev.taskId === snap.taskId ? null : prev));
    setFetchError(null);

    if (needGapReload) {
      scheduleGapReloadRef.current(snap.taskId);
    }
  }, []);

  const loadDetail = React.useCallback(
    async (targetId: string, silent = false) => {
      if (!targetId) return;
      loadDetailAbortRef.current?.abort();
      const controller = new AbortController();
      loadDetailAbortRef.current = controller;
      const reqSeq = ++loadDetailSeqRef.current;

      if (!silent) {
        setLoading(true);
      }
      try {
        const snap = await fetchSubagentTaskDetail(targetId, controller.signal);
        if (
          controller.signal.aborted ||
          resolvedTaskIdRef.current !== targetId ||
          reqSeq !== loadDetailSeqRef.current ||
          snap.taskId !== targetId
        ) {
          return;
        }
        applySnapshotAndReconcile(snap);
      } catch (err: any) {
        if (
          controller.signal.aborted ||
          err?.name === 'AbortError' ||
          resolvedTaskIdRef.current !== targetId ||
          reqSeq !== loadDetailSeqRef.current
        ) {
          return;
        }
        const msg = String(err?.message || err || '加载子代理详情失败');
        const waitingOptimistic =
          optimisticTaskIdRef.current === targetId || activeDirectTaskIdRef.current === targetId;
        if (!waitingOptimistic) {
          setFetchError(msg);
        }
      } finally {
        if (
          !silent &&
          resolvedTaskIdRef.current === targetId &&
          reqSeq === loadDetailSeqRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [applySnapshotAndReconcile]
  );

  const loadDetailRef = React.useRef(loadDetail);
  loadDetailRef.current = loadDetail;

  scheduleGapReloadRef.current = (targetId: string) => {
    if (gapReloadTimerRef.current !== null) return;
    gapReloadTimerRef.current = window.setTimeout(() => {
      gapReloadTimerRef.current = null;
      if (resolvedTaskIdRef.current === targetId) {
        void loadDetailRef.current(targetId, true);
      }
    }, 120);
  };

  // Reset per-task overlay state cleanly ONLY when switching resolvedTaskId
  React.useEffect(() => {
    loadDetailAbortRef.current?.abort();
    loadDetailAbortRef.current = null;
    if (gapReloadTimerRef.current !== null) {
      window.clearTimeout(gapReloadTimerRef.current);
      gapReloadTimerRef.current = null;
    }
    baselineReadyTaskRef.current = null;
    preBaselineBufferRef.current = {};
    setOverlays({});
    setPendingQueue(EMPTY_QUEUE);
    setQueueBusyItemId(null);
    setQueueClearing(false);
    setCompactingSubagent(false);
    setLocalQueuedCompaction(null);
    setFetchError(null);
    setSendError(null);
    if (!resolvedTaskId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    void loadDetailRef.current(resolvedTaskId, false);
    return () => {
      loadDetailAbortRef.current?.abort();
      if (gapReloadTimerRef.current !== null) {
        window.clearTimeout(gapReloadTimerRef.current);
        gapReloadTimerRef.current = null;
      }
    };
  }, [resolvedTaskId]);

  // Refresh snapshot when SSE summary changes for active task
  React.useEffect(() => {
    if (!resolvedTaskId || !activeSummary) return;
    void loadDetailRef.current(resolvedTaskId, true);
  }, [
    resolvedTaskId,
    activeSummary?.status,
    activeSummary?.activityState,
    activeSummary?.toolCallCount,
    activeSummary?.artifactsCount,
    activeSummary?.lastActivityAt,
    activeSummary?.resumable,
    activeSummary?.isThinking,
    activeSummary?.lastProgressSummary,
    activeSummary?.compactionCount,
    Boolean(activeSummary?.queuedCompaction),
    activeSummary?.queuedCompaction?.focus,
  ]);

  // Safety poll while running (catches edge cases like optimistic handoff or long tool stdout)
  const effectiveStatus = activeSummary?.status ?? detail?.status;
  const isWaitingOptimistic = Boolean(optimisticTurn && optimisticTurn.taskId === resolvedTaskId);
  React.useEffect(() => {
    if (!resolvedTaskId || (effectiveStatus !== 'running' && !isWaitingOptimistic)) return undefined;
    const intervalMs = isWaitingOptimistic ? 350 : 1800;
    const timer = window.setInterval(() => {
      void loadDetailRef.current(resolvedTaskId, true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [resolvedTaskId, effectiveStatus, isWaitingOptimistic]);

  // Subscribe to live subagent_stream_delta SSE events for resolvedTaskId
  React.useEffect(() => {
    if (!subscribeSubagentStream || !resolvedTaskId) return undefined;
    return subscribeSubagentStream((ev) => {
      if (ev.taskId !== resolvedTaskId || !ev.delta) return;
      const chunk = {
        seq: ev.seq,
        offset: ev.offset,
        endOffset: ev.endOffset,
        delta: ev.delta,
      };
      if (baselineReadyTaskRef.current !== resolvedTaskId) {
        const cur = preBaselineBufferRef.current[ev.messageId] ?? { thinking: [], content: [] };
        preBaselineBufferRef.current[ev.messageId] = {
          thinking: ev.kind === 'thinking' ? [...cur.thinking, chunk] : cur.thinking,
          content: ev.kind === 'text' ? [...cur.content, chunk] : cur.content,
        };
        return;
      }

      let detectedGap = false;
      setOverlays((prev) => {
        const snapMsg = detailRef.current?.messages?.find((m) => m.id === ev.messageId);
        const snapThinking = snapMsg?.thinking ?? '';
        const snapContent = snapMsg?.content ?? '';
        const base: LiveMessageOverlay = prev[ev.messageId] ?? {
          thinking: {
            text: snapThinking,
            offset: snapMsg?.thinkingOffset ?? snapThinking.length,
          },
          content: {
            text: snapContent,
            offset: snapMsg?.contentOffset ?? snapContent.length,
          },
        };
        if (ev.kind === 'thinking') {
          const applied = applyOffsetDeltaChunk(base.thinking, chunk, { allowLegacyAppend: true });
          if (applied.gapDetected) detectedGap = true;
          if (!applied.changed) return prev;
          return {
            ...prev,
            [ev.messageId]: {
              ...base,
              thinking: applied.next,
            },
          };
        }
        const applied = applyOffsetDeltaChunk(base.content, chunk, { allowLegacyAppend: true });
        if (applied.gapDetected) detectedGap = true;
        if (!applied.changed) return prev;
        return {
          ...prev,
          [ev.messageId]: {
            ...base,
            content: applied.next,
          },
        };
      });
      if (detectedGap) {
        scheduleGapReloadRef.current(resolvedTaskId);
      }
    });
  }, [subscribeSubagentStream, resolvedTaskId]);

  const appendDraftSafely = React.useCallback((restoredText: string) => {
    const cleaned = restoredText.trim();
    if (!cleaned) return;
    setDraft((prev) => (!prev.trim() ? cleaned : `${prev.trimEnd()}\n\n${cleaned}`));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          // Ignore selection error
        }
      }
    });
  }, []);

  const applyRestoredDraft = React.useCallback(
    (restored: RestoredDraftPayload, reason: 'aborted' | 'error' | 'cleared') => {
      if (!restored?.text?.trim()) return;
      if (handledRestoreIdsRef.current.has(restored.restoreId)) return;
      handledRestoreIdsRef.current.add(restored.restoreId);
      if (handledRestoreIdsRef.current.size > 40) {
        const first = handledRestoreIdsRef.current.values().next().value;
        if (first) handledRestoreIdsRef.current.delete(first);
      }
      appendDraftSafely(restored.text);
      const dropHint =
        restored.droppedFollowUpCount > 0
          ? `（已舍弃其余 ${restored.droppedFollowUpCount} 条后续排队）`
          : '';
      const msg =
        reason === 'cleared'
          ? `已清空队列并将消息恢复到输入框${dropHint}`
          : `已将未送达消息恢复到输入框${dropHint}`;
      setQueueAnnouncement(msg);
      onShowToast?.({
        tone: 'info',
        title: '未送达指令已回填输入框',
        message: msg,
        durationMs: 5200,
      });
    },
    [appendDraftSafely, onShowToast]
  );

  // Subscribe to live subagent_queue_updated SSE events for resolvedTaskId
  React.useEffect(() => {
    if (!subscribeSubagentQueue || !resolvedTaskId) return undefined;
    return subscribeSubagentQueue((ev) => {
      if (ev.taskId !== resolvedTaskId) return;
      setPendingQueue(ev.queue ?? EMPTY_QUEUE);
    });
  }, [subscribeSubagentQueue, resolvedTaskId]);

  // Subscribe to subagent_queue_restored SSE events for resolvedTaskId
  React.useEffect(() => {
    if (!subscribeSubagentQueueRestored || !resolvedTaskId) return undefined;
    return subscribeSubagentQueueRestored((ev) => {
      if (ev.taskId !== resolvedTaskId || !ev.restoredDraft) return;
      setPendingQueue(EMPTY_QUEUE);
      applyRestoredDraft(ev.restoredDraft, ev.reason);
    });
  }, [subscribeSubagentQueueRestored, resolvedTaskId, applyRestoredDraft]);

  // Track scroll position to preserve sticky auto-scroll while streaming
  React.useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return undefined;
    const handleScroll = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      setIsAtBottom(distance < 96);
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', handleScroll);
  }, []);

  const currentSnap = detail && detail.taskId === resolvedTaskId ? detail : null;
  const activeRole = activeSummary?.role ?? currentSnap?.role ?? optimisticTurn?.role ?? roleFilter;
  const isTranslator = currentSnap?.interactive === false || activeRole === 'translator';
  const isCurrentRunning =
    activeSummary?.status === 'running' ||
    currentSnap?.status === 'running' ||
    (Boolean(resolvedTaskId) && activeDirectSubagentTaskId === resolvedTaskId) ||
    isWaitingOptimistic;
  const isCurrentThinking = Boolean(activeSummary?.isThinking ?? currentSnap?.isThinking);
  const liveProgressSummary = activeSummary?.lastProgressSummary ?? currentSnap?.lastProgressSummary ?? null;
  const effectiveActivityState = activeSummary?.activityState ?? currentSnap?.activityState;
  const isSubagentCompacting = effectiveActivityState === 'compacting' || compactingSubagent;
  const queuedSubagentCompaction =
    activeSummary?.queuedCompaction ?? currentSnap?.queuedCompaction ?? localQueuedCompaction;
  const canQueueCurrent = Boolean(resolvedTaskId && !isTranslator && isCurrentRunning && !isWaitingOptimistic);
  const isBlockedByOtherTask =
    !isCurrentRunning && (isMainTurnRunning || Boolean(activeDirectSubagentTaskId));
  const isInputDisabled = isBlockedByOtherTask || isWaitingOptimistic || sending || (!canQueueCurrent && isSubagentCompacting);
  const modelBlocksImages = images.length > 0 && modelSupportsImage === false;
  const hasDraft = draft.trim().length > 0 || images.length > 0;
  const canSubmitSubagent = hasDraft && !sending && !modelBlocksImages;

  const appendIncomingImages = React.useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const { added, errors } = await readImageFilesToAttachments(files, images);
      if (added.length > 0) {
        setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES_PER_MESSAGE));
      }
      setImageNotice(errors.length > 0 ? errors[0] : null);
    },
    [images]
  );

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = extractClipboardImageFiles(e.clipboardData);
    if (pastedImages.length === 0) return;
    const hasPlainText = Boolean(e.clipboardData?.getData('text/plain')?.trim());
    if (!hasPlainText) {
      e.preventDefault();
    }
    void appendIncomingImages(pastedImages);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingImage(false);
    if (isInputDisabled) return;
    const dropped = Array.from(e.dataTransfer?.files ?? []).filter(
      (f) => f.type.toLowerCase().startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(f.name)
    );
    if (dropped.length > 0) {
      void appendIncomingImages(dropped);
    }
  };

  const displayMessages = React.useMemo(() => {
    if (currentSnap && currentSnap.interactive !== false && currentSnap.role !== 'translator') {
      return toDisplayMessages(currentSnap, overlays);
    }
    if (optimisticTurn && optimisticTurn.taskId === resolvedTaskId) {
      return [
        ...optimisticTurn.priorEntries,
        {
          origin: 'direct_user' as const,
          turnTaskId: optimisticTurn.taskId,
          chatMessage: optimisticTurn.userMessage,
        },
        {
          origin: undefined,
          turnTaskId: optimisticTurn.taskId,
          chatMessage: {
            id: `${optimisticTurn.taskId}-pending-a`,
            role: 'assistant' as const,
            content: '',
            timestamp: '',
          },
        },
      ];
    }
    return [];
  }, [currentSnap, overlays, optimisticTurn, resolvedTaskId]);

  // Auto-scroll on new messages / deltas when already at bottom
  const lastEntry = displayMessages[displayMessages.length - 1]?.chatMessage;
  const streamTick = `${displayMessages.length}:${lastEntry?.thinking?.length ?? 0}:${lastEntry?.content.length ?? 0}:${lastEntry?.tools?.length ?? 0}`;
  React.useEffect(() => {
    if (!isAtBottom) return;
    bottomSentinelRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [isAtBottom, streamTick]);

  // JS scrollHeight fallback when field-sizing: content is unavailable
  React.useEffect(() => {
    if (supportsFieldSizing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  }, [draft]);

  const handleStopActive = async () => {
    if (resolvedTaskId && activeDirectSubagentTaskId === resolvedTaskId && onAbortSubagentTask) {
      const restored = await onAbortSubagentTask(resolvedTaskId);
      if (restored?.text) {
        applyRestoredDraft(restored, 'aborted');
      }
      return;
    }
    if (isMainTurnRunning) {
      onAbortTurn();
      return;
    }
    if (resolvedTaskId && onAbortSubagentTask) {
      const restored = await onAbortSubagentTask(resolvedTaskId);
      if (restored?.text) {
        applyRestoredDraft(restored, 'aborted');
      }
    }
  };

  const startNewDirectTurn = async (trimmed: string, attachedImages?: ChatImageAttachment[]) => {
    if (!resolvedTaskId || isTranslator) return;
    const priorSnapEntries = displayMessages;
    const hasImages = Boolean(attachedImages && attachedImages.length > 0);
    const optimisticText = trimmed || (hasImages ? '请查看附带的图片并协助定位问题。' : '');
    setSending(true);
    setSendError(null);
    try {
      const res = await sendSubagentMessage(resolvedTaskId, trimmed, attachedImages);
      setDraft('');
      setImages([]);
      setImageNotice(null);
      setOptimisticTurn({
        taskId: res.taskId,
        role: activeRole || 'reverser',
        priorEntries: priorSnapEntries,
        userMessage: {
          id: `${res.taskId}-opt-u`,
          role: 'user',
          content: optimisticText,
          ...(hasImages ? { images: attachedImages } : {}),
          timestamp: new Date().toLocaleTimeString(),
        },
      });
      setIsAtBottom(true);
      onSelectTask(res.taskId);
    } catch (err: any) {
      setSendError(err instanceof Error ? err.message : '发送消息失败');
    } finally {
      setSending(false);
    }
  };

  const handleCompactSubagent = async (focus?: string) => {
    if (!resolvedTaskId || isTranslator || sending) return;
    const previousDraft = draft;
    setSending(true);
    setCompactingSubagent(!canQueueCurrent);
    setSendError(null);
    try {
      const res = await compactSubagent(resolvedTaskId, focus);
      setDraft('');
      if (res.status === 'queued') {
        const resolvedFocus = res.focus ?? focus;
        setLocalQueuedCompaction(resolvedFocus ? { focus: resolvedFocus } : {});
        setQueueAnnouncement('已排队：本轮结束后压缩上下文');
        onShowToast?.({
          tone: 'info',
          title: '已排队：本轮结束后压缩上下文',
          message: res.message || '将在子代理当前回合完成后自动执行上下文压缩。',
          durationMs: 4200,
        });
        void loadDetail(resolvedTaskId, true);
      } else if (res.status === 'noop') {
        onShowToast?.({
          tone: 'info',
          title: '当前对话较短，无需压缩',
          message: res.message || '子代理当前上下文较短，暂无需压缩。',
          durationMs: 4000,
        });
      } else if (res.status === 'compacted') {
        setLocalQueuedCompaction(null);
        void loadDetail(resolvedTaskId, true);
      }
    } catch (err: any) {
      setDraft(previousDraft);
      setSendError(err instanceof Error ? err.message : '压缩子代理上下文失败');
    } finally {
      setCompactingSubagent(false);
      setSending(false);
    }
  };

  const handleQueueSend = async (mode: QueuedMessageMode) => {
    if (!resolvedTaskId || isTranslator || !canQueueCurrent || sending || modelBlocksImages) return;
    const trimmed = draft.trim();
    const attachedImages = images.length > 0 ? [...images] : undefined;
    if (!trimmed && !attachedImages) return;
    const compactCmd = !attachedImages ? parseSlashCompactCommand(trimmed) : null;
    if (compactCmd) {
      await handleCompactSubagent(compactCmd.focus);
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const res = await enqueueSubagentMessage(resolvedTaskId, trimmed, mode, attachedImages);
      setPendingQueue(res.queue);
      setDraft('');
      setImages([]);
      setImageNotice(null);
      setQueueAnnouncement(mode === 'steer' ? '已加入子代理插话队列' : '已加入子代理排队队列');
    } catch (err: any) {
      if (err instanceof ApiRequestError && err.code === 'TASK_NOT_RUNNING' && !isMainTurnRunning && !activeDirectSubagentTaskId) {
        setSending(false);
        await startNewDirectTurn(trimmed, attachedImages);
        return;
      }
      setSendError(err instanceof Error ? err.message : '加入队列失败');
    } finally {
      setSending(false);
    }
  };

  const handleSwitchQueueMode = async (item: QueuedMessageItem, nextMode: QueuedMessageMode) => {
    if (!resolvedTaskId) return;
    setQueueBusyItemId(item.id);
    setSendError(null);
    try {
      const res = await switchSubagentQueueItemMode(resolvedTaskId, item.id, nextMode);
      setPendingQueue(res.queue);
      setQueueAnnouncement(nextMode === 'steer' ? '已升为插话' : '已转为排队');
    } catch (err: any) {
      if (err instanceof ApiRequestError && err.queue) {
        setPendingQueue(err.queue);
      }
      if (err instanceof ApiRequestError && err.code === 'ALREADY_DELIVERED') {
        setQueueAnnouncement('该消息已送达模型');
      } else {
        setSendError(err instanceof Error ? err.message : '切换队列模式失败');
      }
    } finally {
      setQueueBusyItemId(null);
    }
  };

  const handleRecallQueueItem = async (item: QueuedMessageItem) => {
    if (!resolvedTaskId) return;
    setQueueBusyItemId(item.id);
    setSendError(null);
    try {
      const res = await removeSubagentQueueItem(resolvedTaskId, item.id);
      setPendingQueue(res.queue);
      const textToRestore = res.removed?.text || item.text;
      const recalledImages = res.removedImages;
      if (textToRestore || (recalledImages && recalledImages.length > 0)) {
        if (textToRestore) {
          appendDraftSafely(textToRestore);
        }
        if (recalledImages && recalledImages.length > 0) {
          setImages((prev) => [...prev, ...recalledImages].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
        setQueueAnnouncement('已撤回至输入框编辑');
      }
    } catch (err: any) {
      if (err instanceof ApiRequestError && err.queue) {
        setPendingQueue(err.queue);
      }
      if (err instanceof ApiRequestError && err.code === 'ALREADY_DELIVERED') {
        setQueueAnnouncement('该消息已送达模型，无法撤回');
      } else {
        setSendError(err instanceof Error ? err.message : '撤回队列消息失败');
      }
    } finally {
      setQueueBusyItemId(null);
    }
  };

  const handleDeleteQueueItem = async (item: QueuedMessageItem) => {
    if (!resolvedTaskId) return;
    setQueueBusyItemId(item.id);
    setSendError(null);
    try {
      const res = await removeSubagentQueueItem(resolvedTaskId, item.id);
      setPendingQueue(res.queue);
      setQueueAnnouncement('已删除待投递消息');
    } catch (err: any) {
      if (err instanceof ApiRequestError && err.queue) {
        setPendingQueue(err.queue);
      }
      if (!(err instanceof ApiRequestError && err.code === 'ALREADY_DELIVERED')) {
        setSendError(err instanceof Error ? err.message : '删除队列消息失败');
      }
    } finally {
      setQueueBusyItemId(null);
    }
  };

  const handleClearQueue = async () => {
    if (!resolvedTaskId) return;
    setQueueClearing(true);
    setSendError(null);
    try {
      const res = await clearSubagentQueue(resolvedTaskId);
      setPendingQueue(res.queue);
      if (res.restoredDraft?.text) {
        applyRestoredDraft(res.restoredDraft, 'cleared');
      } else {
        setQueueAnnouncement('已清空全部待投递消息');
      }
    } catch (err: any) {
      setSendError(err instanceof Error ? err.message : '清空队列失败');
    } finally {
      setQueueClearing(false);
    }
  };

  const handleSendDirect = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!resolvedTaskId || isTranslator || isInputDisabled || modelBlocksImages) return;
    const trimmed = draft.trim();
    const attachedImages = images.length > 0 ? [...images] : undefined;
    if (!trimmed && !attachedImages) return;
    const compactCmd = !attachedImages ? parseSlashCompactCommand(trimmed) : null;
    if (compactCmd) {
      await handleCompactSubagent(compactCmd.focus);
      return;
    }
    if (canQueueCurrent) {
      await handleQueueSend('steer');
      return;
    }
    await startNewDirectTurn(trimmed, attachedImages);
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (canQueueCurrent) {
        e.preventDefault();
        void handleQueueSend(e.altKey ? 'followUp' : 'steer');
        return;
      }
      if (!e.altKey) {
        e.preventDefault();
        void handleSendDirect();
      }
    }
  };

  const activeThreadId = activeSummary?.threadId ?? currentSnap?.threadId ?? resolvedTaskId;
  const currentThreadTurnCount =
    threadGroups.find((g) => g.threadId === activeThreadId)?.turnCount ?? 1;
  const meta = activeSummary
    ? statusMeta(
        activeSummary.status,
        isCurrentThinking,
        compactingSubagent ? 'compacting' : activeSummary.activityState
      )
    : currentSnap
      ? statusMeta(
          currentSnap.status,
          isCurrentThinking,
          compactingSubagent ? 'compacting' : currentSnap.activityState
        )
      : null;
  const assistantDisplayLabel = roleAssistantLabel(activeRole);
  const streamingAssistantIdx =
    displayMessages.length > 0 &&
    displayMessages[displayMessages.length - 1].chatMessage.role === 'assistant'
      ? displayMessages.length - 1
      : -1;

  const maxTools = activeSummary?.maxToolCalls ?? currentSnap?.maxToolCalls;
  const toolCount = activeSummary?.toolCallCount ?? currentSnap?.toolCallCount ?? 0;
  const maxStall = activeSummary?.maxStallCalls ?? currentSnap?.maxStallCalls;
  const stallCount = activeSummary?.callsSinceProgress ?? currentSnap?.callsSinceProgress;
  const isResumable = activeSummary?.resumable ?? currentSnap?.resumable;
  const compactionCount = activeSummary?.compactionCount ?? currentSnap?.compactionCount ?? 0;
  const subagentContextUsage = activeSummary?.contextUsage ?? currentSnap?.contextUsage ?? null;
  const subagentContextDisplay = React.useMemo(() => {
    if (!subagentContextUsage || subagentContextUsage.tokens === null) return null;
    const { tokens, contextWindow, percent, triggerTokens } = subagentContextUsage;
    const hasEffectiveTrigger =
      typeof triggerTokens === 'number' &&
      Number.isFinite(triggerTokens) &&
      triggerTokens > 0 &&
      triggerTokens < contextWindow;
    if (hasEffectiveTrigger) {
      const triggerPct = Math.min(100, Math.max(0, (tokens / triggerTokens) * 100));
      return {
        label: `上下文 ${formatCompactionTokens(tokens)} / ${formatCompactionTokens(triggerTokens)} (${triggerPct.toFixed(0)}%)`,
        windowTag: `· 窗口 ${formatCompactionTokens(contextWindow)}`,
        title: `当前上下文 ${tokens.toLocaleString()} / 自动压缩触发线 ${triggerTokens.toLocaleString()}（模型物理窗口 ${contextWindow.toLocaleString()}）`,
      };
    }
    return {
      label: `上下文 ${formatCompactionTokens(tokens)} / ${formatCompactionTokens(contextWindow)}${
        percent !== null ? ` (${Math.round(percent)}%)` : ''
      }`,
      windowTag: null,
      title: `当前上下文 ${tokens.toLocaleString()} / 模型窗口 ${contextWindow.toLocaleString()}`,
    };
  }, [subagentContextUsage]);
  const artifacts = currentSnap?.artifacts ?? [];
  const pivotWarnings = currentSnap?.pivotWarnings ?? [];

  return (
    <section
      aria-label="子代理详情与对话视图"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas/35"
    >
      {/* Compact telemetry header */}
      <header className="shrink-0 border-b border-line bg-sheet/92 px-4 py-2.5 backdrop-blur-sm sm:px-6">
        <div className="mx-auto flex w-full max-w-[49rem] flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onBackToChat}
                className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line-strong bg-surface-raised px-2.5 text-xs font-medium text-ink transition-colors hover:border-string hover:text-string-ink cursor-pointer"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                <span>返回主对话</span>
              </button>
              <span className="text-sm font-semibold text-ink">{roleDisplayName(activeRole)}</span>
              {meta && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    meta.className
                  )}
                >
                  {meta.icon === 'loader' && <PixelCupLoader className="text-string" />}
                  {meta.icon === 'ok' && <CheckCircle2 className="size-3" aria-hidden="true" />}
                  {meta.icon === 'warn' && <AlertTriangle className="size-3" aria-hidden="true" />}
                  {meta.icon === 'error' && <XCircle className="size-3" aria-hidden="true" />}
                  <span>{meta.label}</span>
                </span>
              )}
              {isResumable && !isTranslator && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-string/30 bg-string-soft/70 px-2 py-0.5 text-[11px] font-medium text-string-ink"
                  title="子代理会话仍保留在热缓存池中，可无缝接续上下文"
                >
                  <Flame className="size-3" aria-hidden="true" />
                  <span>热缓存</span>
                </span>
              )}
              {queuedSubagentCompaction && !isSubagentCompacting && !isTranslator && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-well px-2 py-0.5 text-[11px] font-medium text-ink-2"
                  title={
                    queuedSubagentCompaction.focus
                      ? `本轮结束后将压缩上下文：${queuedSubagentCompaction.focus}`
                      : '已排队：本轮结束后将自动执行 /compact'
                  }
                >
                  <Minimize2 className="size-3 text-string" aria-hidden="true" />
                  <span>已排队 /compact</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {threadGroups.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-ink-3">
                  <span className="sr-only">选择子代理会话线</span>
                  <select
                    aria-label="选择子代理会话线"
                    value={activeThreadId ?? ''}
                    onChange={(e) => {
                      const picked = threadGroups.find((g) => g.threadId === e.target.value);
                      if (picked) {
                        onSelectTask(picked.latestTask.taskId);
                      }
                    }}
                    className="h-8 max-w-[16rem] rounded-xl border border-line-strong bg-surface-raised px-2.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-string/40"
                  >
                    {threadGroups.map((grp) => {
                      const t = grp.latestTask;
                      const m = statusMeta(t.status, t.isThinking, t.activityState);
                      const stageLabel = t.activityState === 'compacting' ? '压缩中' : m.label;
                      const turnLabel = grp.turnCount > 1 ? ` · ${grp.turnCount} 轮` : '';
                      return (
                        <option key={grp.threadId} value={grp.threadId}>
                          {t.role} · {stageLabel}
                          {turnLabel} · {t.taskSummary.slice(0, 26)}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}

              {resolvedTaskId && (
                <button
                  type="button"
                  onClick={() => void loadDetail(resolvedTaskId, false)}
                  disabled={loading}
                  aria-label="刷新子代理详情"
                  className="inline-flex size-8 items-center justify-center rounded-xl border border-transparent text-ink-3 transition-colors hover:border-line-strong hover:bg-surface-raised hover:text-ink disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden="true" />
                </button>
              )}

              {(isCurrentRunning || isMainTurnRunning) && (
                <button
                  type="button"
                  onClick={() => void handleStopActive()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-danger/35 bg-danger-soft px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 cursor-pointer"
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                  <span>停止</span>
                </button>
              )}
            </div>
          </div>

          {/* Compact telemetry strip */}
          {(activeSummary || currentSnap) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
              <span className="font-mono text-ink-2">
                {(activeSummary?.model ?? currentSnap?.model) || '默认模型'} ·{' '}
                {(activeSummary?.thinkingLevel ?? currentSnap?.thinkingLevel) || 'medium'}
              </span>
              <span>
                工具 {toolCount}
                {maxTools ? `/${maxTools}` : ''} 次
              </span>
              {maxStall !== undefined && stallCount !== undefined && (
                <span>
                  停滞 {stallCount}/{maxStall}
                </span>
              )}
              {currentSnap && (
                <span>Tokens {currentSnap.usage.totalTokens.toLocaleString()}</span>
              )}
              {subagentContextDisplay && (
                <span className="font-mono tabular-nums" title={subagentContextDisplay.title}>
                  {subagentContextDisplay.label}
                  {subagentContextDisplay.windowTag && (
                    <span className="text-ink-3/75"> {subagentContextDisplay.windowTag}</span>
                  )}
                </span>
              )}
              {compactionCount > 0 && <span>已压缩 {compactionCount} 次</span>}
              <span className="inline-flex items-center gap-1 font-mono">
                <Clock className="size-3" aria-hidden="true" />
                {formatDuration(activeSummary?.durationMs ?? currentSnap?.durationMs)}
              </span>
              {currentThreadTurnCount > 1 && <span>共 {currentThreadTurnCount} 轮对话</span>}
              {currentSnap?.resumedFromTaskId && (
                <span className="font-mono">接续自 {currentSnap.resumedFromTaskId.slice(-8)}</span>
              )}
            </div>
          )}

          {/* Secondary collapsible details (content-first noise reduction) */}
          {(artifacts.length > 0 || pivotWarnings.length > 0) && (
            <div className="flex flex-wrap items-start gap-2 pt-0.5 text-xs">
              {artifacts.length > 0 && (
                <details className="rounded-lg border border-line bg-well/70 px-2.5 py-1 text-ink-2">
                  <summary className="cursor-pointer select-none font-medium text-ink">
                    落盘产物 ({artifacts.length})
                  </summary>
                  <ul className="mt-1.5 space-y-1 border-t border-line/70 pt-1.5 font-mono text-[11px]">
                    {artifacts.map((art) => (
                      <li key={art} className="flex items-center gap-1.5 break-all">
                        <FileCode2 className="size-3 shrink-0 text-string-ink" aria-hidden="true" />
                        <span>{art}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {pivotWarnings.length > 0 && (
                <details className="rounded-lg border border-warn/35 bg-warn-soft/50 px-2.5 py-1 text-warn">
                  <summary className="cursor-pointer select-none font-medium">
                    拐点 / 熔断提醒 ({pivotWarnings.length})
                  </summary>
                  <ul className="mt-1.5 space-y-1 border-t border-warn/25 pt-1.5 text-[11px] leading-5">
                    {pivotWarnings.map((w, idx) => (
                      <li key={`${idx}-${w.slice(0, 20)}`} className="whitespace-pre-wrap break-words">
                        {w}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main scroll region */}
      <div
        ref={scrollContainerRef}
        className="pc-stage-scroll pc-scroller relative min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[49rem] px-4 pt-5 pb-12 sm:px-6">
          {!resolvedTaskId && (
            <div className="rounded-2xl border border-dashed border-line-strong bg-surface-raised/60 p-8 text-center text-sm text-ink-3">
              当前工作区暂无子代理执行记录。在主对话中下达拆包、逆向或审校任务后，这里将实时呈现其思考与对话过程。
            </div>
          )}

          {fetchError && !currentSnap && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-danger/35 bg-danger-soft px-4 py-3 text-xs text-danger"
            >
              {fetchError}
            </div>
          )}

          {resolvedTaskId && isTranslator && (currentSnap || activeSummary) && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-line bg-surface-raised p-4 text-xs leading-6 text-ink-2">
                <p className="font-medium text-ink">
                  Translator 为高吞吐批量翻译节点，界面仅展示轻量摘要与工具轨迹（不保存逐条对话全文）。
                </p>
                {(isCurrentRunning || liveProgressSummary) && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mt-2.5 flex items-center gap-2 rounded-xl border border-line bg-well/75 px-3 py-2 text-xs text-ink"
                  >
                    {isCurrentRunning && <PixelCupLoader className="text-string" />}
                    <span className="font-mono">
                      {liveProgressSummary || (isCurrentThinking ? '模型思考中…' : '等待模型返回译文流…')}
                    </span>
                  </div>
                )}
                {currentSnap?.taskPrompt && (
                  <p className="mt-2 font-mono text-[11px] text-ink-3">{currentSnap.taskPrompt}</p>
                )}
                {(currentSnap?.error ?? activeSummary?.error) && (
                  <p className="mt-2 whitespace-pre-wrap text-danger">
                    {currentSnap?.error ?? activeSummary?.error}
                  </p>
                )}
              </div>
              {currentSnap && currentSnap.toolCalls.length > 0 && (
                <ToolCallGroup tools={currentSnap.toolCalls.map(mapLegacyToolToItem)} />
              )}
            </div>
          )}

          {resolvedTaskId && !isTranslator && (
            <>
              {loading && displayMessages.length === 0 ? (
                <div className="flex items-center gap-2 py-8 text-xs text-ink-3">
                  <PixelCupLoader className="text-string" />
                  <span>加载子代理对话历史…</span>
                </div>
              ) : (
                <div role="log" aria-label={`${assistantDisplayLabel} 对话记录`} className="space-y-7">
                  {displayMessages.map((entry, idx) => {
                    const isStreamingMsg =
                      isCurrentRunning && !isSubagentCompacting && idx === streamingAssistantIdx;
                    const isMsgThinking = isStreamingMsg && isCurrentThinking;
                    const userBadge =
                      entry.chatMessage.role === 'user' &&
                      !entry.chatMessage.deliveryMode &&
                      entry.origin === 'delegated'
                        ? '主代理委派'
                        : undefined;
                    return (
                      <MessageItem
                        key={entry.chatMessage.id}
                        message={entry.chatMessage}
                        isStreaming={isStreamingMsg}
                        isThinking={isMsgThinking}
                        statusLabel={
                          isMsgThinking
                            ? '深度思考中…'
                            : effectiveActivityState === 'running_tool'
                              ? '执行工具中…'
                              : '生成中…'
                        }
                        assistantLabel={assistantDisplayLabel}
                        userBadge={userBadge}
                        motionAllowed={motionAllowed}
                      />
                    );
                  })}
                </div>
              )}

              {currentSnap &&
                (currentSnap.status === 'error' || currentSnap.status === 'aborted') &&
                currentSnap.error && (
                  <div
                    role="alert"
                    className={cn(
                      'mt-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs leading-5',
                      currentSnap.status === 'aborted'
                        ? 'border-warn/35 bg-warn-soft/60 text-warn'
                        : 'border-danger/35 bg-danger-soft text-danger'
                    )}
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span className="whitespace-pre-wrap break-words">{currentSnap.error}</span>
                  </div>
                )}
            </>
          )}

          <div ref={bottomSentinelRef} className="h-px" aria-hidden="true" />
        </div>

        {!isAtBottom && displayMessages.length > 0 && (
          <div className="pointer-events-none sticky bottom-3 flex justify-center">
            <button
              type="button"
              onClick={() => {
                setIsAtBottom(true);
                bottomSentinelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
              }}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-raised/95 px-3 py-1 text-xs font-medium text-ink shadow-[var(--shadow-card)] backdrop-blur-sm hover:border-string hover:text-string-ink cursor-pointer"
            >
              <ArrowDown className="size-3.5" aria-hidden="true" />
              <span>回到底部</span>
            </button>
          </div>
        )}
      </div>

      {/* Standalone bottom composer for interactive subagent roles */}
      {resolvedTaskId && !isTranslator && (
        <div
          className="pc-composer-scrim shrink-0 px-3 pt-3 sm:px-6"
          style={{ paddingBottom: 'max(0.875rem, env(safe-area-inset-bottom, 0px))' }}
        >
          <form onSubmit={(e) => void handleSendDirect(e)} className="mx-auto w-full max-w-[49rem]">
            <PendingQueueTray
              queue={pendingQueue}
              timingHint={
                canQueueCurrent
                  ? {
                      text:
                        activeSummary?.activityState === 'running_tool'
                          ? '待当前工具安全完成后立即介入'
                          : '待当前推理步骤结束后立即介入',
                    }
                  : null
              }
              busyItemId={queueBusyItemId}
              clearing={queueClearing}
              statusAnnouncement={queueAnnouncement}
              onSwitchMode={(item, mode) => void handleSwitchQueueMode(item, mode)}
              onRecallItem={(item) => void handleRecallQueueItem(item)}
              onDeleteItem={(item) => void handleDeleteQueueItem(item)}
              onClearAll={() => void handleClearQueue()}
            />

            {isSubagentCompacting && (
              <div
                role="status"
                aria-live="polite"
                className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-well/75 px-3 py-1.5 text-[11px] text-ink-2"
              >
                <PixelCupLoader className="text-string" />
                <span className="font-medium text-ink">正在压缩上下文…</span>
              </div>
            )}

            {queuedSubagentCompaction && !isSubagentCompacting && (
              <div
                role="status"
                aria-live="polite"
                className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-well/75 px-3 py-1.5 text-[11px] text-ink-2"
              >
                <Minimize2 className="size-3.5 shrink-0 text-string" aria-hidden="true" />
                <span className="font-medium text-ink">本轮结束后将自动执行 /compact</span>
                {queuedSubagentCompaction.focus && (
                  <span
                    className="min-w-0 truncate text-ink-3"
                    title={queuedSubagentCompaction.focus}
                  >
                    · {queuedSubagentCompaction.focus}
                  </span>
                )}
              </div>
            )}

            {sendError && (
              <div
                role="alert"
                className="mb-2 rounded-xl border border-danger/35 bg-danger-soft px-3 py-1.5 text-xs text-danger"
              >
                {sendError}
              </div>
            )}

            <div
              onDragOver={(e) => {
                if (isInputDisabled) return;
                if (e.dataTransfer?.types?.includes('Files')) {
                  e.preventDefault();
                  setIsDraggingImage(true);
                }
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setIsDraggingImage(false);
                }
              }}
              onDrop={handleDrop}
              className={cn(
                'relative overflow-hidden rounded-2xl border bg-surface-raised/92 backdrop-blur-md transition-[border-color,box-shadow] shadow-[var(--shadow-float)]',
                isInputDisabled
                  ? 'border-line'
                  : isDraggingImage
                    ? 'border-string ring-2 ring-string/25'
                    : 'border-line-strong focus-within:border-string/65 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--string)_14%,transparent),var(--shadow-float)]'
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className="visually-hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  const chosen = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = '';
                  if (chosen.length > 0) {
                    void appendIncomingImages(chosen);
                  }
                }}
              />

              <ImageAttachmentStrip
                images={images}
                disabled={sending}
                modelSupportsImage={modelSupportsImage}
                onRemove={(idx) => {
                  setImages((prev) => prev.filter((_, i) => i !== idx));
                  setImageNotice(null);
                }}
              />

              {imageNotice && (
                <div
                  role="status"
                  className="border-b border-line/60 bg-danger-soft/70 px-4 py-1.5 text-[11px] text-danger"
                >
                  {imageNotice}
                </div>
              )}

              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleTextareaKeyDown}
                onPaste={handlePaste}
                rows={1}
                disabled={isInputDisabled}
                aria-label={
                  canQueueCurrent
                    ? `向运行中的 ${assistantDisplayLabel} 发送插话或排队指令`
                    : `向 ${assistantDisplayLabel} 发送消息`
                }
                placeholder={
                  canQueueCurrent
                    ? `运行中可随时插话指导 ${assistantDisplayLabel}…（Enter 插话 · Alt+Enter 排队 · 可粘贴截图）`
                    : isSubagentCompacting
                      ? '压缩完成后可继续对话…'
                      : isBlockedByOtherTask
                        ? '其他对话或子代理正在运行中，请切换至运行中的视图插话或等待完成…'
                        : isWaitingOptimistic
                          ? '正在启动子代理会话…'
                          : `直接与 ${assistantDisplayLabel} 对话追问、补充截图/线索或输入 /compact 压缩上下文…`
                }
                className="pc-textarea block w-full bg-transparent px-4 pt-3 pb-1.5 text-[0.9375rem] leading-6 text-ink placeholder:text-ink-3 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
              />

              <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1 text-[11px] text-ink-3">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isInputDisabled || images.length >= MAX_IMAGES_PER_MESSAGE}
                    aria-label="附加图片截图"
                    title={
                      images.length >= MAX_IMAGES_PER_MESSAGE
                        ? `最多附加 ${MAX_IMAGES_PER_MESSAGE} 张图片`
                        : '附加图片（支持 Ctrl+V 粘贴或拖拽上传）'
                    }
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-xl border border-line bg-well/75 text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                  >
                    <ImagePlus className="size-3.5" aria-hidden="true" />
                  </button>
                  <span className="min-w-0 truncate">
                    {canQueueCurrent
                      ? isMainTurnRunning
                        ? '插话直接作用于当前子代理（不中断运行中工具），完成后摘要回传主代理'
                        : 'Enter 插话 · Alt+Enter 排队（本步完成后无损介入，重置停滞计数）'
                      : isBlockedByOtherTask
                        ? '当前任务已结束；如需插话请切换至正在运行的对话'
                        : isResumable
                          ? '命中热缓存 · 回复后自动同步要点到主对话'
                          : '将自动摘要历史并接续新会话 · 回复后同步到主对话'}
                  </span>
                </div>

                <div className="ml-auto flex items-center gap-1.5">
                  {canQueueCurrent ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleStopActive()}
                        className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-danger/35 bg-danger-soft px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger cursor-pointer"
                      >
                        <Square className="size-3 fill-current" aria-hidden="true" />
                        <span>停止</span>
                      </button>
                      <button
                        type="button"
                        disabled={!canSubmitSubagent}
                        onClick={() => void handleQueueSend('followUp')}
                        title="排队 Follow-up (Alt+Enter)：本轮完成后顺延执行"
                        aria-label={`排入 ${assistantDisplayLabel} 队尾`}
                        className="inline-flex h-8 items-center gap-1 rounded-xl border border-voice/35 bg-voice-soft px-2.5 text-xs font-medium text-voice transition-colors hover:border-voice/60 disabled:cursor-not-allowed disabled:border-line disabled:bg-well disabled:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-voice cursor-pointer"
                      >
                        <ListEnd className="size-3.5" aria-hidden="true" />
                        <span>排队</span>
                      </button>
                      <button
                        type="submit"
                        disabled={!canSubmitSubagent}
                        title="插话 Steer (Enter)：当前步骤结束后立即介入"
                        aria-label={`向 ${assistantDisplayLabel} 发送实时插话`}
                        className="inline-flex h-8 items-center gap-1 rounded-xl bg-string px-3 text-xs font-medium text-on-string shadow-xs transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border disabled:border-line disabled:bg-well disabled:text-ink-3 disabled:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-string cursor-pointer"
                      >
                        <CornerDownRight className="size-3.5" aria-hidden="true" />
                        <span>插话</span>
                      </button>
                    </>
                  ) : isBlockedByOtherTask || isWaitingOptimistic ? (
                    <button
                      type="button"
                      onClick={() => void handleStopActive()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-danger/35 bg-danger-soft px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 cursor-pointer"
                    >
                      <Square className="size-3 fill-current" aria-hidden="true" />
                      <span>停止</span>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!canSubmitSubagent}
                      aria-label="发送给子代理"
                      className={cn(
                        'inline-flex size-8 items-center justify-center rounded-xl transition-colors cursor-pointer',
                        canSubmitSubagent
                          ? 'bg-string text-on-string shadow-sm hover:bg-string/90'
                          : 'bg-well text-ink-3 cursor-not-allowed'
                      )}
                    >
                      <ArrowUp className="size-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
