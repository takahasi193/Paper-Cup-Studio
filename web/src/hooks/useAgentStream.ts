import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ActiveTurnSnapshot,
  ChatFormRecord,
  ChatImageAttachment,
  CompactionMessageMeta,
  CompactionReason,
  CompactionSummaryInfo,
  ModelsState,
  PendingQueueState,
  QueuedCompactionInfo,
  QueuedMessageMode,
  RestoredDraftPayload,
  SessionHistoryState,
  SessionSummary,
  SessionTokenUsageSnapshot,
  SmokeConfigState,
  SubagentQueueRestoredEvent,
  SubagentQueueUpdatedEvent,
  SubagentStreamDeltaEvent,
  SubagentTaskSummary,
  ThinkingLevel,
  TranslatorConfigState,
  TurnPhase,
} from '@/lib/api.js';

export interface ToolCallItem {
  callId?: string;
  tool: string;
  args?: any;
  result?: any;
  isError?: boolean;
  liveDeltaChars?: number;
  subagentTaskId?: string;
  subagentTaskIds?: string[];
  subagentRole?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'compaction';
  content: string;
  images?: ChatImageAttachment[];
  thinking?: string;
  tools?: ToolCallItem[];
  timestamp: string;
  error?: boolean;
  deliveryMode?: QueuedMessageMode;
  compaction?: CompactionMessageMeta;
}

export interface CompactionEndEvent {
  reason?: CompactionReason;
  status?: 'compacted' | 'noop' | 'aborted' | 'error';
  result?: CompactionSummaryInfo;
  error?: string;
}

const EMPTY_QUEUE: PendingQueueState = { steering: [], followUp: [] };

function normalizeQueueState(raw: any): PendingQueueState {
  return {
    steering: Array.isArray(raw?.steering) ? raw.steering : [],
    followUp: Array.isArray(raw?.followUp) ? raw.followUp : [],
  };
}

export function toCompactionChatMessage(result: CompactionSummaryInfo): ChatMessage {
  const parsedDate = result.timestamp ? new Date(result.timestamp) : null;
  const timestamp =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toLocaleTimeString()
      : result.timestamp || '';
  return {
    id: result.id,
    role: 'compaction',
    content: result.summary || '',
    timestamp,
    compaction: {
      reason: result.reason,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      ...(result.focus ? { focus: result.focus } : {}),
      ...(result.checkpointPath ? { checkpointPath: result.checkpointPath } : {}),
    },
  };
}

export function appendCompactionMessageIfMissing(
  prev: ChatMessage[],
  result: CompactionSummaryInfo
): ChatMessage[] {
  if (!result?.id) return prev;
  if (prev.some((m) => m.id === result.id)) return prev;
  return [...prev, toCompactionChatMessage(result)];
}

export function shouldSkipEmptyTurnFinish(params: {
  aborted: boolean;
  hadCommittedSegment: boolean;
  thinking: string;
  response: string;
  toolsCount: number;
}): boolean {
  return (
    !params.aborted &&
    params.hadCommittedSegment &&
    !params.thinking &&
    !params.response &&
    params.toolsCount === 0
  );
}

export interface UseAgentStreamOptions {
  onReconnect?: () => void;
  onBatchProgress?: () => void;
  onSkillsUpdated?: (skills: string[]) => void;
  onSmokeConfigUpdated?: (config: SmokeConfigState) => void;
  onWorkspaceChanged?: (workspace: string) => void;
  onSessionReady?: (sessionId: string | null) => void;
  onCompactionEnd?: (ev: CompactionEndEvent) => void;
}

export const MAX_SUBAGENT_TASKS = 80;

export function parseSseJson<T = any>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function upsertSubagentTaskList(
  prev: SubagentTaskSummary[],
  incoming: SubagentTaskSummary
): SubagentTaskSummary[] {
  const next = prev.filter((t) => t.taskId !== incoming.taskId);
  next.unshift(incoming);
  next.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return next.slice(0, MAX_SUBAGENT_TASKS);
}

export function useAgentStream(options?: UseAgentStreamOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [queuedCompaction, setQueuedCompaction] = useState<QueuedCompactionInfo | null>(null);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('connecting');
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts?: number } | null>(null);
  const [currentThinking, setCurrentThinking] = useState('');
  const [currentResponse, setCurrentResponse] = useState('');
  const [currentTools, setCurrentTools] = useState<ToolCallItem[]>([]);
  const [pendingQueue, setPendingQueue] = useState<PendingQueueState>(EMPTY_QUEUE);
  const [lastRestoredDraft, setLastRestoredDraft] = useState<RestoredDraftPayload | null>(null);
  const [subagentTasks, setSubagentTasks] = useState<SubagentTaskSummary[]>([]);
  const [activeDirectSubagentTaskId, setActiveDirectSubagentTaskId] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [latestThinkingLevel, setLatestThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [latestModelsState, setLatestModelsState] = useState<ModelsState | null>(null);
  const [latestTranslatorConfig, setLatestTranslatorConfig] = useState<TranslatorConfigState | null>(null);
  const [latestSmokeConfig, setLatestSmokeConfig] = useState<SmokeConfigState | null>(null);
  const [translatorSyncStatus, setTranslatorSyncStatus] = useState<{
    seq?: number;
    phase: 'starting' | 'restarting' | 'ready' | 'error';
    status?: 'started' | 'restarted' | 'already_running' | 'skipped' | 'failed';
    message: string;
    concurrency?: number;
    version?: string;
    managedByPaperCup?: boolean;
  } | null>(null);
  const [latestSessionState, setLatestSessionState] = useState<SessionHistoryState | null>(null);
  const [latestSessionsList, setLatestSessionsList] = useState<{
    sessionId: string | null;
    sessions: SessionSummary[];
  } | null>(null);
  const [tokenUsage, setTokenUsage] = useState<SessionTokenUsageSnapshot | null>(null);
  const [chatForms, setChatForms] = useState<Record<string, ChatFormRecord>>({});

  const thinkingRef = useRef('');
  const responseRef = useRef('');
  const toolsRef = useRef<ToolCallItem[]>([]);
  const turnErroredRef = useRef(false);
  const segmentCommittedInTurnRef = useRef(false);
  const isStreamingRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const hasOpenedSseRef = useRef(false);
  const msgSeqRef = useRef(0);
  const subagentStreamListenersRef = useRef<Set<(ev: SubagentStreamDeltaEvent) => void>>(new Set());
  const subagentQueueListenersRef = useRef<Set<(ev: SubagentQueueUpdatedEvent) => void>>(new Set());
  const subagentQueueRestoredListenersRef = useRef<Set<(ev: SubagentQueueRestoredEvent) => void>>(
    new Set()
  );
  const onReconnectRef = useRef(options?.onReconnect);
  onReconnectRef.current = options?.onReconnect;
  const onBatchProgressRef = useRef(options?.onBatchProgress);
  onBatchProgressRef.current = options?.onBatchProgress;
  const onSkillsUpdatedRef = useRef(options?.onSkillsUpdated);
  onSkillsUpdatedRef.current = options?.onSkillsUpdated;
  const onSmokeConfigUpdatedRef = useRef(options?.onSmokeConfigUpdated);
  onSmokeConfigUpdatedRef.current = options?.onSmokeConfigUpdated;
  const onWorkspaceChangedRef = useRef(options?.onWorkspaceChanged);
  onWorkspaceChangedRef.current = options?.onWorkspaceChanged;
  const onSessionReadyRef = useRef(options?.onSessionReady);
  onSessionReadyRef.current = options?.onSessionReady;
  const onCompactionEndRef = useRef(options?.onCompactionEnd);
  onCompactionEndRef.current = options?.onCompactionEnd;

  const nextId = () => `${Date.now()}-${++msgSeqRef.current}`;

  const resetStreaming = useCallback(() => {
    thinkingRef.current = '';
    responseRef.current = '';
    toolsRef.current = [];
    setCurrentThinking('');
    setCurrentResponse('');
    setCurrentTools([]);
    setTurnPhase('connecting');
    setRetryInfo(null);
  }, []);

  const applyActiveTurnSnapshot = useCallback((snapshot: ActiveTurnSnapshot) => {
    isStreamingRef.current = true;
    turnErroredRef.current = false;
    thinkingRef.current = snapshot.thinking || '';
    responseRef.current = snapshot.response || '';
    toolsRef.current = Array.isArray(snapshot.tools)
      ? snapshot.tools.map((t) => ({ ...t }))
      : [];
    const resolvedPhase: TurnPhase =
      snapshot.phase ??
      (snapshot.isThinking ? 'thinking' : snapshot.response ? 'generating' : 'connecting');
    setIsStreaming(true);
    setIsThinking(Boolean(snapshot.isThinking));
    setTurnPhase(resolvedPhase);
    setRetryInfo(
      resolvedPhase === 'retrying' && typeof snapshot.retryAttempt === 'number'
        ? {
            attempt: snapshot.retryAttempt,
            ...(typeof snapshot.retryMaxAttempts === 'number'
              ? { maxAttempts: snapshot.retryMaxAttempts }
              : {}),
          }
        : null
    );
    setCurrentThinking(thinkingRef.current);
    setCurrentResponse(responseRef.current);
    setCurrentTools([...toolsRef.current]);
    if (snapshot.model) {
      setActiveModel(snapshot.model);
    }
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/turns/stream');

    es.onopen = () => {
      if (hasOpenedSseRef.current) {
        onReconnectRef.current?.();
      } else {
        hasOpenedSseRef.current = true;
      }
    };

    es.addEventListener('sync_state', (e) => {
      const data = parseSseJson(e.data);
      if (!data) return;
      if ('sessionId' in data) {
        activeSessionIdRef.current = typeof data.sessionId === 'string' ? data.sessionId : null;
      }
      if (Array.isArray(data.subagentTasks)) {
        setSubagentTasks((data.subagentTasks as SubagentTaskSummary[]).slice(0, MAX_SUBAGENT_TASKS));
      }
      if ('activeDirectSubagentTaskId' in data) {
        setActiveDirectSubagentTaskId(data.activeDirectSubagentTaskId ?? null);
      }
      if (data.tokenUsage) {
        setTokenUsage(data.tokenUsage as SessionTokenUsageSnapshot);
      }
      if (Array.isArray(data.chatForms)) {
        const nextForms: Record<string, ChatFormRecord> = {};
        for (const f of data.chatForms as ChatFormRecord[]) {
          if (f?.formId) nextForms[f.formId] = f;
        }
        setChatForms(nextForms);
      }
      if (data.pendingQueue) {
        setPendingQueue(normalizeQueueState(data.pendingQueue));
      } else if (data.isRunning === false) {
        setPendingQueue(EMPTY_QUEUE);
      }
      if (typeof data.isCompacting === 'boolean') {
        setIsCompacting(data.isCompacting);
      }
      if ('queuedCompaction' in data) {
        setQueuedCompaction(data.queuedCompaction ?? null);
      } else if (data.isRunning === false) {
        setQueuedCompaction(null);
      }
      if (data.isRunning && data.activeTurn) {
        applyActiveTurnSnapshot(data.activeTurn as ActiveTurnSnapshot);
      } else if (data.isRunning === false && isStreamingRef.current) {
        isStreamingRef.current = false;
        segmentCommittedInTurnRef.current = false;
        setIsStreaming(false);
        setIsThinking(false);
        resetStreaming();
        onReconnectRef.current?.();
      }
    });

    es.addEventListener('compaction_start', (e) => {
      const data = parseSseJson<{
        reason?: CompactionReason;
        phase?: string;
        focus?: string;
      }>(e.data);
      setIsCompacting(true);
      if (data?.reason === 'manual') {
        setQueuedCompaction(null);
      }
    });

    es.addEventListener('compaction_end', (e) => {
      const data = parseSseJson<CompactionEndEvent>(e.data);
      setIsCompacting(false);
      if (data?.status === 'compacted' && data.result) {
        const result = data.result;
        if (
          isStreamingRef.current &&
          !thinkingRef.current &&
          !responseRef.current &&
          toolsRef.current.length === 0
        ) {
          segmentCommittedInTurnRef.current = true;
        }
        setMessages((prev) => appendCompactionMessageIfMissing(prev, result));
      }
      if (data) {
        onCompactionEndRef.current?.(data);
      }
    });

    es.addEventListener('compaction_queued', (e) => {
      const data = parseSseJson<{ queued?: boolean; focus?: string }>(e.data);
      if (!data) return;
      if (data.queued) {
        setQueuedCompaction(data.focus ? { focus: data.focus } : {});
      } else {
        setQueuedCompaction(null);
      }
    });

    es.addEventListener('chat_form_updated', (e) => {
      const form = parseSseJson<ChatFormRecord>(e.data);
      if (!form?.formId) return;
      setChatForms((prev) => ({
        ...prev,
        [form.formId]: form,
      }));
    });

    es.addEventListener('turn_queue_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        setPendingQueue(normalizeQueueState(data));
      } catch {
        // Ignore malformed turn_queue_updated payload
      }
    });

    es.addEventListener('turn_segment_commit', (e) => {
      try {
        const data = JSON.parse(e.data);
        const committed = data?.message as ChatMessage | undefined;
        if (committed && committed.role === 'assistant') {
          segmentCommittedInTurnRef.current = true;
          setMessages((prev) =>
            prev.some((m) => m.id === committed.id) ? prev : [...prev, committed]
          );
        }
        setIsThinking(false);
        resetStreaming();
      } catch {
        // Ignore malformed turn_segment_commit payload
      }
    });

    es.addEventListener('turn_user_injected', (e) => {
      try {
        const data = JSON.parse(e.data);
        const injected = data?.message as ChatMessage | undefined;
        if (injected && injected.role === 'user' && (injected.content || injected.images?.length)) {
          segmentCommittedInTurnRef.current = false;
          setMessages((prev) =>
            prev.some((m) => m.id === injected.id) ? prev : [...prev, injected]
          );
        }
      } catch {
        // Ignore malformed turn_user_injected payload
      }
    });

    es.addEventListener('subagent_queue_updated', (e) => {
      try {
        const queueEvent = JSON.parse(e.data) as SubagentQueueUpdatedEvent;
        if (!queueEvent?.taskId || !queueEvent?.queue) return;
        for (const listener of subagentQueueListenersRef.current) {
          try {
            listener(queueEvent);
          } catch {
            // Isolate listener errors
          }
        }
      } catch {
        // Ignore malformed subagent_queue_updated payload
      }
    });

    es.addEventListener('subagent_queue_restored', (e) => {
      try {
        const restoredEvent = JSON.parse(e.data) as SubagentQueueRestoredEvent;
        if (!restoredEvent?.taskId || !restoredEvent?.restoredDraft) return;
        for (const listener of subagentQueueRestoredListenersRef.current) {
          try {
            listener(restoredEvent);
          } catch {
            // Isolate listener errors
          }
        }
      } catch {
        // Ignore malformed subagent_queue_restored payload
      }
    });

    es.addEventListener('subagent_stream_delta', (e) => {
      try {
        const deltaEvent = JSON.parse(e.data) as SubagentStreamDeltaEvent;
        if (!deltaEvent?.taskId || !deltaEvent?.messageId) return;
        for (const listener of subagentStreamListenersRef.current) {
          try {
            listener(deltaEvent);
          } catch {
            // Isolate listener errors
          }
        }
      } catch {
        // Ignore malformed subagent_stream_delta payload
      }
    });

    es.addEventListener('subagent_task_updated', (e) => {
      const summary = parseSseJson<SubagentTaskSummary>(e.data);
      if (!summary?.taskId) return;
      if (
        summary.sessionId &&
        activeSessionIdRef.current &&
        summary.sessionId !== activeSessionIdRef.current
      ) {
        return;
      }
      setSubagentTasks((prev) => upsertSubagentTaskList(prev, summary));
      if (summary.parentCallId) {
        const idx = toolsRef.current.findIndex((t) => t.callId === summary.parentCallId);
        if (idx !== -1) {
          toolsRef.current = toolsRef.current.map((t, i) => {
            if (i !== idx) return t;
            const nextIds = t.subagentTaskIds ? [...t.subagentTaskIds] : [];
            if (!nextIds.includes(summary.taskId)) {
              nextIds.push(summary.taskId);
            }
            return {
              ...t,
              subagentRole: summary.role,
              subagentTaskId: summary.taskId,
              ...(t.tool !== 'delegate_task' ? { subagentTaskIds: nextIds } : {}),
            };
          });
          setCurrentTools([...toolsRef.current]);
        }
      }
    });

    es.addEventListener('model_changed', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data?.model === 'string' && data.model) {
          setActiveModel(data.model);
        } else if (data?.model === null) {
          setActiveModel(null);
        }
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('thinking_changed', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data?.thinkingLevel === 'string' && data.thinkingLevel) {
          setLatestThinkingLevel(data.thinkingLevel as ThinkingLevel);
        }
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('models_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && Array.isArray(data.models)) {
          setLatestModelsState(data as ModelsState);
        }
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('translator_config_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.global && data.effective) {
          setLatestTranslatorConfig(data as TranslatorConfigState);
        }
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('translator_sync_status', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (
          data &&
          (data.phase === 'starting' ||
            data.phase === 'restarting' ||
            data.phase === 'ready' ||
            data.phase === 'error') &&
          typeof data.message === 'string'
        ) {
          setTranslatorSyncStatus({
            ...(typeof data.seq === 'number' ? { seq: data.seq } : {}),
            phase: data.phase,
            ...(typeof data.status === 'string' ? { status: data.status } : {}),
            message: data.message,
            ...(typeof data.concurrency === 'number' ? { concurrency: data.concurrency } : {}),
            ...(typeof data.version === 'string' && data.version ? { version: data.version } : {}),
            ...(typeof data.managedByPaperCup === 'boolean'
              ? { managedByPaperCup: data.managedByPaperCup }
              : {}),
          });
        }
      } catch {
        // Ignore malformed translator_sync_status payload
      }
    });

    es.addEventListener('batch_progress', () => {
      onBatchProgressRef.current?.();
    });

    es.addEventListener('skills_updated', (e) => {
      const data = parseSseJson<{ skills?: unknown }>(e.data);
      const skills = Array.isArray(data?.skills) ? data.skills.map(String) : [];
      onSkillsUpdatedRef.current?.(skills);
    });

    es.addEventListener('smoke_config_updated', (e) => {
      const data = parseSseJson<SmokeConfigState>(e.data);
      if (data && data.global && data.effective) {
        setLatestSmokeConfig(data);
        onSmokeConfigUpdatedRef.current?.(data);
      }
    });

    es.addEventListener('workspace_changed', (e) => {
      const data = parseSseJson<{ workspace?: unknown }>(e.data);
      if (typeof data?.workspace === 'string' && data.workspace) {
        onWorkspaceChangedRef.current?.(data.workspace);
      }
    });

    es.addEventListener('session_ready', (e) => {
      const data = parseSseJson<{ sessionId?: unknown }>(e.data);
      const sid = typeof data?.sessionId === 'string' ? data.sessionId : null;
      if (sid !== null) {
        activeSessionIdRef.current = sid;
      }
      onSessionReadyRef.current?.(sid);
    });

    es.addEventListener('token_usage', (e) => {
      const data = parseSseJson<SessionTokenUsageSnapshot>(e.data);
      if (data && typeof data === 'object' && data.total) {
        setTokenUsage(data);
      }
    });

    es.addEventListener('session_changed', (e) => {
      const data = parseSseJson<SessionHistoryState>(e.data);
      if (!data) return;
      turnErroredRef.current = false;
      segmentCommittedInTurnRef.current = false;
      isStreamingRef.current = Boolean(data.isRunning);
      activeSessionIdRef.current = data.sessionId ?? null;
      setIsStreaming(Boolean(data.isRunning));
      setIsThinking(Boolean(data.activeTurn?.isThinking));
      setIsCompacting(Boolean(data.isCompacting));
      setQueuedCompaction(data.queuedCompaction ?? null);
      setActiveDirectSubagentTaskId(data.activeDirectSubagentTaskId ?? null);
      if (Array.isArray(data.subagentTasks)) {
        setSubagentTasks(data.subagentTasks.slice(0, MAX_SUBAGENT_TASKS));
      }
      if (data.tokenUsage) {
        setTokenUsage(data.tokenUsage);
      }
      if (data.pendingQueue) {
        setPendingQueue(normalizeQueueState(data.pendingQueue));
      } else {
        setPendingQueue(EMPTY_QUEUE);
      }
      if (data.isRunning && data.activeTurn) {
        applyActiveTurnSnapshot(data.activeTurn);
      } else {
        resetStreaming();
      }
      if (Array.isArray(data.messages)) {
        setMessages(data.messages);
      }
      if (Array.isArray(data.sessions)) {
        setLatestSessionState(data);
      }
    });

    es.addEventListener('sessions_updated', (e) => {
      const data = parseSseJson<{ sessionId?: unknown; sessions?: SessionSummary[] }>(e.data);
      if (data && Array.isArray(data.sessions)) {
        const sid = typeof data.sessionId === 'string' ? data.sessionId : null;
        if (sid !== null) {
          activeSessionIdRef.current = sid;
        }
        setLatestSessionsList({
          sessionId: sid,
          sessions: data.sessions,
        });
      }
    });

    es.addEventListener('session_reset', (e) => {
      turnErroredRef.current = false;
      segmentCommittedInTurnRef.current = false;
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
      setIsCompacting(false);
      setQueuedCompaction(null);
      setMessages([]);
      setPendingQueue(EMPTY_QUEUE);
      setActiveDirectSubagentTaskId(null);
      setSubagentTasks([]);
      resetStreaming();
      const data = parseSseJson<{ sessionId?: unknown }>(e.data);
      const resetSid = typeof data?.sessionId === 'string' ? data.sessionId : null;
      activeSessionIdRef.current = resetSid;
      if (resetSid) {
        setTokenUsage((prev) => (prev && prev.sessionId === resetSid ? prev : null));
      } else {
        setTokenUsage(null);
      }
    });

    es.addEventListener('turn_started', (e) => {
      turnErroredRef.current = false;
      segmentCommittedInTurnRef.current = false;
      isStreamingRef.current = true;
      setIsStreaming(true);
      setIsThinking(false);
      setPendingQueue(EMPTY_QUEUE);
      try {
        const data = JSON.parse(e.data);
        if (typeof data?.model === 'string' && data.model) {
          setActiveModel(data.model);
        }
      } catch {
        // Ignore optional metadata parse error
      }
      resetStreaming();
    });

    es.addEventListener('turn_retry', (e) => {
      setIsThinking(false);
      setTurnPhase('retrying');
      try {
        const data = JSON.parse(e.data);
        const attempt = typeof data?.attempt === 'number' ? data.attempt : 1;
        const maxAttempts = typeof data?.maxAttempts === 'number' ? data.maxAttempts : undefined;
        setRetryInfo({ attempt, ...(maxAttempts !== undefined ? { maxAttempts } : {}) });
      } catch {
        setRetryInfo({ attempt: 1 });
      }
    });

    es.addEventListener('thinking_delta', (e) => {
      const data = parseSseJson<{ delta?: unknown }>(e.data);
      if (!data || typeof data.delta !== 'string') return;
      setIsThinking(true);
      setTurnPhase('thinking');
      setRetryInfo(null);
      thinkingRef.current += data.delta;
      setCurrentThinking(thinkingRef.current);
    });

    es.addEventListener('text_delta', (e) => {
      const data = parseSseJson<{ delta?: unknown }>(e.data);
      if (!data || typeof data.delta !== 'string') return;
      setIsThinking(false); // テキスト到着時点で思考フェーズは完了
      setTurnPhase('generating');
      setRetryInfo(null);
      responseRef.current += data.delta;
      setCurrentResponse(responseRef.current);
    });

    es.addEventListener('subagent_delta', (e) => {
      const data = parseSseJson(e.data);
      if (!data) return;
      const deltaLen = typeof data.delta === 'string' ? data.delta.length : 0;
      if (!deltaLen) return;
      const callId = typeof data.callId === 'string' && data.callId ? data.callId : undefined;
      const idx = callId
        ? toolsRef.current.findIndex((t) => t.callId === callId)
        : toolsRef.current.findIndex(
            (t) => t.tool === 'delegate_task' && (t.result === undefined || t.result === null)
          );
      if (idx !== -1) {
        toolsRef.current = toolsRef.current.map((t, i) =>
          i === idx ? { ...t, liveDeltaChars: (t.liveDeltaChars ?? 0) + deltaLen } : t
        );
        setCurrentTools([...toolsRef.current]);
      }
    });

    es.addEventListener('tool_start', (e) => {
      const data = parseSseJson(e.data);
      if (!data || typeof data.tool !== 'string') return;
      setIsThinking(false);
      setTurnPhase('tool');
      setRetryInfo(null);
      toolsRef.current = [
        ...toolsRef.current,
        {
          ...(typeof data.callId === 'string' && data.callId ? { callId: data.callId } : {}),
          tool: data.tool,
          args: data.args,
          ...(typeof data.subagentRole === 'string' ? { subagentRole: data.subagentRole } : {}),
        },
      ];
      setCurrentTools([...toolsRef.current]);
    });

    es.addEventListener('tool_end', (e) => {
      const data = parseSseJson(e.data);
      if (!data) return;
      const callId = typeof data.callId === 'string' && data.callId ? data.callId : undefined;
      let pendingIdx = callId
        ? toolsRef.current.findIndex(
            (t) => t.callId === callId && (t.result === undefined || t.result === null)
          )
        : -1;
      if (pendingIdx === -1) {
        pendingIdx = toolsRef.current.findIndex(
          (t) => t.tool === data.tool && (t.result === undefined || t.result === null)
        );
      }
      if (pendingIdx !== -1) {
        toolsRef.current = toolsRef.current.map((t, idx) =>
          idx === pendingIdx
            ? {
                ...t,
                result: data.result,
                isError: Boolean(data.isError),
                ...(typeof data.subagentTaskId === 'string'
                  ? { subagentTaskId: data.subagentTaskId }
                  : {}),
                ...(Array.isArray(data.subagentTaskIds)
                  ? { subagentTaskIds: data.subagentTaskIds }
                  : {}),
                ...(typeof data.subagentRole === 'string'
                  ? { subagentRole: data.subagentRole }
                  : {}),
              }
            : t
        );
      }
      setCurrentTools([...toolsRef.current]);
      const stillHasRunningTool = toolsRef.current.some(
        (t) => t.result === undefined || t.result === null
      );
      if (!stillHasRunningTool && isStreamingRef.current) {
        setTurnPhase('thinking');
      }
    });

    es.addEventListener('turn_finished', (e) => {
      isStreamingRef.current = false;
      const hadCommittedSegment = segmentCommittedInTurnRef.current;
      segmentCommittedInTurnRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
      setPendingQueue(EMPTY_QUEUE);

      const parsed = parseSseJson(e.data);
      if (parsed?.restoredDraft?.text) {
        setLastRestoredDraft(parsed.restoredDraft as RestoredDraftPayload);
      }

      // turn_error 直後の finally による重複「已完成任务。」を抑制
      if (turnErroredRef.current) {
        turnErroredRef.current = false;
        resetStreaming();
        return;
      }

      const aborted = parsed?.status === 'aborted';

      const finalThinking = thinkingRef.current;
      const finalResponse = responseRef.current;
      const finalTools = toolsRef.current;

      if (
        shouldSkipEmptyTurnFinish({
          aborted,
          hadCommittedSegment,
          thinking: finalThinking,
          response: finalResponse,
          toolsCount: finalTools.length,
        })
      ) {
        resetStreaming();
        return;
      }

      const resolvedContent = aborted
        ? finalResponse
          ? `${finalResponse}\n\n*(已手动中止)*`
          : '已中止任务。'
        : finalResponse || '已完成任务。';

      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: resolvedContent,
          thinking: finalThinking || undefined,
          tools: finalTools.length > 0 ? [...finalTools] : undefined,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);

      resetStreaming();
    });

    es.addEventListener('turn_error', (e) => {
      turnErroredRef.current = true;
      segmentCommittedInTurnRef.current = false;
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
      setPendingQueue(EMPTY_QUEUE);
      const data = parseSseJson(e.data);
      if (data?.restoredDraft?.text) {
        setLastRestoredDraft(data.restoredDraft as RestoredDraftPayload);
      }
      const finalThinking = thinkingRef.current;
      const finalResponse = responseRef.current;
      const finalTools = toolsRef.current;
      const errNotice = `执行出错: ${data?.message || '未知错误'}`;
      const content = finalResponse ? `${finalResponse}\n\n${errNotice}` : errNotice;

      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content,
          thinking: finalThinking || undefined,
          tools: finalTools.length > 0 ? [...finalTools] : undefined,
          timestamp: new Date().toLocaleTimeString(),
          error: true,
        },
      ]);

      resetStreaming();
    });

    return () => {
      es.close();
    };
  }, [applyActiveTurnSnapshot, resetStreaming]);

  const addUserMessage = useCallback(
    (prompt: string, images?: ChatImageAttachment[]): string => {
      const id = nextId();
      setMessages((prev) => [
        ...prev,
        {
          id,
          role: 'user',
          content: prompt,
          ...(images && images.length > 0 ? { images } : {}),
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
      return id;
    },
    []
  );

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const addErrorMessage = useCallback((message: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'assistant',
        content: `请求失败: ${message}`,
        timestamp: new Date().toLocaleTimeString(),
        error: true,
      },
    ]);
  }, []);

  const hydrateMessages = useCallback((history: ChatMessage[]) => {
    setMessages(history);
  }, []);

  const hydrateSessionState = useCallback(
    (state: SessionHistoryState) => {
      activeSessionIdRef.current = state.sessionId ?? null;
      setMessages(state.messages || []);
      if (Array.isArray(state.subagentTasks)) {
        setSubagentTasks(state.subagentTasks.slice(0, MAX_SUBAGENT_TASKS));
      }
      setActiveDirectSubagentTaskId(state.activeDirectSubagentTaskId ?? null);
      if (state.tokenUsage) {
        setTokenUsage(state.tokenUsage);
      }
      if (Array.isArray(state.chatForms)) {
        const nextForms: Record<string, ChatFormRecord> = {};
        for (const f of state.chatForms) {
          if (f?.formId) nextForms[f.formId] = f;
        }
        setChatForms(nextForms);
      } else {
        setChatForms({});
      }
      if (state.isRunning && state.pendingQueue) {
        setPendingQueue(normalizeQueueState(state.pendingQueue));
      } else {
        setPendingQueue(EMPTY_QUEUE);
      }
      setIsCompacting(Boolean(state.isCompacting));
      setQueuedCompaction(state.queuedCompaction ?? null);
      if (state.isRunning && state.activeTurn) {
        applyActiveTurnSnapshot(state.activeTurn);
      } else {
        isStreamingRef.current = false;
        segmentCommittedInTurnRef.current = false;
        setIsStreaming(false);
        setIsThinking(false);
        resetStreaming();
      }
    },
    [applyActiveTurnSnapshot, resetStreaming]
  );

  const subscribeSubagentStream = useCallback((listener: (ev: SubagentStreamDeltaEvent) => void) => {
    subagentStreamListenersRef.current.add(listener);
    return () => {
      subagentStreamListenersRef.current.delete(listener);
    };
  }, []);

  const subscribeSubagentQueue = useCallback((listener: (ev: SubagentQueueUpdatedEvent) => void) => {
    subagentQueueListenersRef.current.add(listener);
    return () => {
      subagentQueueListenersRef.current.delete(listener);
    };
  }, []);

  const subscribeSubagentQueueRestored = useCallback(
    (listener: (ev: SubagentQueueRestoredEvent) => void) => {
      subagentQueueRestoredListenersRef.current.add(listener);
      return () => {
        subagentQueueRestoredListenersRef.current.delete(listener);
      };
    },
    []
  );

  const upsertChatForm = useCallback((form: ChatFormRecord) => {
    if (!form?.formId) return;
    setChatForms((prev) => ({
      ...prev,
      [form.formId]: form,
    }));
  }, []);

  const appendCompactionResult = useCallback((result: CompactionSummaryInfo) => {
    setMessages((prev) => appendCompactionMessageIfMissing(prev, result));
  }, []);

  const applyTokenUsage = useCallback((nextUsage: SessionTokenUsageSnapshot) => {
    setTokenUsage(nextUsage);
  }, []);

  return {
    messages,
    isStreaming,
    isThinking,
    isCompacting,
    queuedCompaction,
    setQueuedCompaction,
    turnPhase,
    retryInfo,
    currentThinking,
    currentResponse,
    currentTools,
    pendingQueue,
    setPendingQueue,
    lastRestoredDraft,
    subagentTasks,
    activeDirectSubagentTaskId,
    activeModel,
    latestThinkingLevel,
    latestModelsState,
    latestTranslatorConfig,
    latestSmokeConfig,
    translatorSyncStatus,
    latestSessionState,
    latestSessionsList,
    tokenUsage,
    applyTokenUsage,
    chatForms,
    upsertChatForm,
    appendCompactionResult,
    hydrateMessages,
    hydrateSessionState,
    subscribeSubagentStream,
    subscribeSubagentQueue,
    subscribeSubagentQueueRestored,
    addUserMessage,
    removeMessage,
    addErrorMessage,
  };
}
