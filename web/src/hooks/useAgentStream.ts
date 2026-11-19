import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ActiveTurnSnapshot,
  ModelsState,
  SessionHistoryState,
  SessionSummary,
  SubagentTaskSummary,
  ThinkingLevel,
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
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: ToolCallItem[];
  timestamp: string;
  error?: boolean;
}

export interface UseAgentStreamOptions {
  onReconnect?: () => void;
  onBatchProgress?: () => void;
}

function upsertSubagentTaskList(
  prev: SubagentTaskSummary[],
  incoming: SubagentTaskSummary
): SubagentTaskSummary[] {
  const next = prev.filter((t) => t.taskId !== incoming.taskId);
  next.unshift(incoming);
  next.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return next.slice(0, 120);
}

export function useAgentStream(options?: UseAgentStreamOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('connecting');
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts?: number } | null>(null);
  const [currentThinking, setCurrentThinking] = useState('');
  const [currentResponse, setCurrentResponse] = useState('');
  const [currentTools, setCurrentTools] = useState<ToolCallItem[]>([]);
  const [subagentTasks, setSubagentTasks] = useState<SubagentTaskSummary[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [latestThinkingLevel, setLatestThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [latestModelsState, setLatestModelsState] = useState<ModelsState | null>(null);
  const [latestSessionState, setLatestSessionState] = useState<SessionHistoryState | null>(null);
  const [latestSessionsList, setLatestSessionsList] = useState<{
    sessionId: string | null;
    sessions: SessionSummary[];
  } | null>(null);

  const thinkingRef = useRef('');
  const responseRef = useRef('');
  const toolsRef = useRef<ToolCallItem[]>([]);
  const turnErroredRef = useRef(false);
  const isStreamingRef = useRef(false);
  const hasOpenedSseRef = useRef(false);
  const msgSeqRef = useRef(0);
  const onReconnectRef = useRef(options?.onReconnect);
  onReconnectRef.current = options?.onReconnect;
  const onBatchProgressRef = useRef(options?.onBatchProgress);
  onBatchProgressRef.current = options?.onBatchProgress;

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
      try {
        const data = JSON.parse(e.data);
        if (Array.isArray(data?.subagentTasks)) {
          setSubagentTasks(data.subagentTasks as SubagentTaskSummary[]);
        }
        if (data?.isRunning && data?.activeTurn) {
          applyActiveTurnSnapshot(data.activeTurn as ActiveTurnSnapshot);
        } else if (data?.isRunning === false && isStreamingRef.current) {
          isStreamingRef.current = false;
          setIsStreaming(false);
          setIsThinking(false);
          resetStreaming();
          onReconnectRef.current?.();
        }
      } catch {
        // Ignore malformed sync_state payload
      }
    });

    es.addEventListener('subagent_task_updated', (e) => {
      try {
        const summary = JSON.parse(e.data) as SubagentTaskSummary;
        if (!summary?.taskId) return;
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
                subagentTaskId: t.tool === 'delegate_task' ? summary.taskId : summary.taskId,
                ...(t.tool !== 'delegate_task' ? { subagentTaskIds: nextIds } : {}),
              };
            });
            setCurrentTools([...toolsRef.current]);
          }
        }
      } catch {
        // Ignore malformed subagent_task_updated payload
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

    es.addEventListener('batch_progress', () => {
      onBatchProgressRef.current?.();
    });

    es.addEventListener('session_changed', (e) => {
      try {
        const data = JSON.parse(e.data) as SessionHistoryState;
        turnErroredRef.current = false;
        isStreamingRef.current = Boolean(data?.isRunning);
        setIsStreaming(Boolean(data?.isRunning));
        setIsThinking(Boolean(data?.activeTurn?.isThinking));
        if (Array.isArray(data?.subagentTasks)) {
          setSubagentTasks(data.subagentTasks);
        }
        if (data?.isRunning && data?.activeTurn) {
          applyActiveTurnSnapshot(data.activeTurn);
        } else {
          resetStreaming();
        }
        if (Array.isArray(data?.messages)) {
          setMessages(data.messages);
        }
        if (data && Array.isArray(data.sessions)) {
          setLatestSessionState(data);
        }
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('sessions_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && Array.isArray(data.sessions)) {
          setLatestSessionsList({
            sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
            sessions: data.sessions,
          });
        }
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('session_reset', () => {
      turnErroredRef.current = false;
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
      setMessages([]);
      resetStreaming();
    });

    es.addEventListener('turn_started', (e) => {
      turnErroredRef.current = false;
      isStreamingRef.current = true;
      setIsStreaming(true);
      setIsThinking(false);
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
      setIsThinking(true);
      setTurnPhase('thinking');
      setRetryInfo(null);
      const data = JSON.parse(e.data);
      thinkingRef.current += data.delta;
      setCurrentThinking(thinkingRef.current);
    });

    es.addEventListener('text_delta', (e) => {
      setIsThinking(false); // テキスト到着時点で思考フェーズは完了
      setTurnPhase('generating');
      setRetryInfo(null);
      const data = JSON.parse(e.data);
      responseRef.current += data.delta;
      setCurrentResponse(responseRef.current);
    });

    es.addEventListener('subagent_delta', (e) => {
      try {
        const data = JSON.parse(e.data);
        const deltaLen = typeof data?.delta === 'string' ? data.delta.length : 0;
        if (!deltaLen) return;
        const callId = typeof data?.callId === 'string' && data.callId ? data.callId : undefined;
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
      } catch {
        // Ignore malformed subagent_delta event
      }
    });

    es.addEventListener('tool_start', (e) => {
      setIsThinking(false);
      setTurnPhase('tool');
      setRetryInfo(null);
      const data = JSON.parse(e.data);
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
      const data = JSON.parse(e.data);
      const callId = typeof data?.callId === 'string' && data.callId ? data.callId : undefined;
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
    });

    es.addEventListener('turn_finished', (e) => {
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);

      // turn_error 直後の finally による重複「已完成任务。」を抑制
      if (turnErroredRef.current) {
        turnErroredRef.current = false;
        resetStreaming();
        return;
      }

      let aborted = false;
      try {
        aborted = JSON.parse(e.data)?.status === 'aborted';
      } catch {
        aborted = false;
      }

      const finalThinking = thinkingRef.current;
      const finalResponse = responseRef.current;
      const finalTools = toolsRef.current;
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
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
      const data = JSON.parse(e.data);
      const finalThinking = thinkingRef.current;
      const finalTools = toolsRef.current;

      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: `执行出错: ${data.message || '未知错误'}`,
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

  const addUserMessage = (prompt: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'user',
        content: prompt,
        timestamp: new Date().toLocaleTimeString(),
      },
    ]);
  };

  const addErrorMessage = (message: string) => {
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
  };

  const hydrateMessages = useCallback((history: ChatMessage[]) => {
    setMessages(history);
  }, []);

  const hydrateSessionState = useCallback(
    (state: SessionHistoryState) => {
      setMessages(state.messages || []);
      if (Array.isArray(state.subagentTasks)) {
        setSubagentTasks(state.subagentTasks);
      }
      if (state.isRunning && state.activeTurn) {
        applyActiveTurnSnapshot(state.activeTurn);
      } else {
        isStreamingRef.current = false;
        setIsStreaming(false);
        setIsThinking(false);
        resetStreaming();
      }
    },
    [applyActiveTurnSnapshot, resetStreaming]
  );

  return {
    messages,
    isStreaming,
    isThinking,
    turnPhase,
    retryInfo,
    currentThinking,
    currentResponse,
    currentTools,
    subagentTasks,
    activeModel,
    latestThinkingLevel,
    latestModelsState,
    latestSessionState,
    latestSessionsList,
    hydrateMessages,
    hydrateSessionState,
    addUserMessage,
    addErrorMessage,
  };
}
