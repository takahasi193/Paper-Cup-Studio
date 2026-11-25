import crypto from 'node:crypto';
import type { ImageContent } from '@earendil-works/pi-ai';
import {
  type ChatImageAttachment,
  DEFAULT_IMAGE_ONLY_PROMPT,
  toPiImageContents,
} from './image-attachments.js';

export type QueuedMessageMode = 'steer' | 'followUp';

export interface QueuedMessageItem {
  id: string;
  mode: QueuedMessageMode;
  text: string;
  createdAt: string;
  imageCount?: number;
}

export interface PendingQueueState {
  steering: QueuedMessageItem[];
  followUp: QueuedMessageItem[];
}

export interface RestoredDraftPayload {
  restoreId: string;
  text: string;
  steeringCount: number;
  restoredFollowUpCount: number;
  droppedFollowUpCount: number;
}

export interface DeliveredQueueMatch {
  id: string;
  mode: QueuedMessageMode;
  text: string;
}

export interface QueueMutationResult {
  found: boolean;
  alreadyDelivered?: boolean;
  removed?: QueuedMessageItem | null;
  removedImages?: ChatImageAttachment[];
  item?: QueuedMessageItem | null;
  queue: PendingQueueState;
}

interface InternalQueueEntry {
  id: string;
  mode: QueuedMessageMode;
  text: string;
  wireText: string;
  createdAt: string;
  images?: ChatImageAttachment[];
}

export interface QueueCapableSession {
  steer?: (text: string, images?: ImageContent[]) => Promise<unknown>;
  followUp?: (text: string, images?: ImageContent[]) => Promise<unknown>;
  clearQueue?: () => { steering: string[]; followUp: string[] };
  getSteeringMessages?: () => readonly string[];
  getFollowUpMessages?: () => readonly string[];
  setSteeringMode?: (mode: 'all' | 'one-at-a-time') => void;
  setFollowUpMode?: (mode: 'all' | 'one-at-a-time') => void;
}

export function createEmptyQueueState(): PendingQueueState {
  return { steering: [], followUp: [] };
}

export function cloneQueueState(state: PendingQueueState): PendingQueueState {
  return {
    steering: state.steering.map((item) => ({ ...item })),
    followUp: state.followUp.map((item) => ({ ...item })),
  };
}

export function countQueuedMessages(state?: PendingQueueState | null): number {
  if (!state) return 0;
  return state.steering.length + state.followUp.length;
}

/**
 * 构建中止 / 异常中断时的无损回填草稿：
 * - 保留全部未送达的 Steer（因为 Steer 为合并投递语义 `all`）；
 * - 若队列中有多条 Follow-up，仅保留最早那一条（followUp[0]），其余丢弃并计数。
 */
export function buildRestoredDraft(
  steeringTexts: readonly string[],
  followUpTexts: readonly string[]
): RestoredDraftPayload | null {
  const cleanSteer = steeringTexts.map((s) => String(s || '').trim()).filter(Boolean);
  const cleanFollowUp = followUpTexts.map((s) => String(s || '').trim()).filter(Boolean);
  const keptFollowUp = cleanFollowUp.length > 0 ? [cleanFollowUp[0]] : [];
  const droppedFollowUpCount = Math.max(0, cleanFollowUp.length - keptFollowUp.length);
  const parts = [...cleanSteer, ...keptFollowUp];
  if (parts.length === 0) {
    return null;
  }
  return {
    restoreId: `restore-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    text: parts.join('\n\n'),
    steeringCount: cleanSteer.length,
    restoredFollowUpCount: keptFollowUp.length,
    droppedFollowUpCount,
  };
}

function generateQueueItemId(mode: QueuedMessageMode): string {
  return `q-${mode}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function toPublicItem(entry: InternalQueueEntry): QueuedMessageItem {
  return {
    id: entry.id,
    mode: entry.mode,
    text: entry.text,
    createdAt: entry.createdAt,
    ...(entry.images?.length ? { imageCount: entry.images.length } : {}),
  };
}

function alignEntriesWithRawTexts(
  entries: InternalQueueEntry[],
  rawTexts: readonly string[],
  mode: QueuedMessageMode
): { aligned: InternalQueueEntry[]; dropped: InternalQueueEntry[] } {
  const pool = [...entries];
  const aligned: InternalQueueEntry[] = [];
  for (const raw of rawTexts) {
    const rawStr = String(raw ?? '');
    let idx = pool.findIndex((e) => e.wireText === rawStr);
    if (idx === -1) {
      idx = pool.findIndex((e) => e.text === rawStr);
    }
    if (idx !== -1) {
      const [matched] = pool.splice(idx, 1);
      matched.mode = mode;
      matched.wireText = rawStr;
      aligned.push(matched);
    } else if (rawStr.trim()) {
      aligned.push({
        id: generateQueueItemId(mode),
        mode,
        text: rawStr,
        wireText: rawStr,
        createdAt: new Date().toISOString(),
      });
    }
  }
  return { aligned, dropped: pool };
}

/**
 * 封装单个 Pi AgentSession 的 Steer / Follow-up 队列管理：
 * - 维护稳定 itemId，支持单条撤回、删除、模式切换与一键清空；
 * - 通过同步原子的 `session.clearQueue()` 对齐防止把已投递消息重复入队；
 * - 追踪 Pi 先于 `message_start(user)` 触发 `queue_update` 而出队的条目，确保 `consumeDelivered()` 100% 命中投递模式。
 */
export class SessionQueueController {
  private steering: InternalQueueEntry[] = [];
  private followUp: InternalQueueEntry[] = [];
  private awaitingDelivery: InternalQueueEntry[] = [];
  private knownItemIds = new Set<string>();
  private deliveredItemIds = new Set<string>();
  private queueEpoch = 0;
  private rebuilding = false;
  private opChain: Promise<void> = Promise.resolve();

  get isRebuilding(): boolean {
    return this.rebuilding;
  }

  getState(): PendingQueueState {
    return {
      steering: this.steering.map(toPublicItem),
      followUp: this.followUp.map(toPublicItem),
    };
  }

  hasPending(): boolean {
    return this.steering.length > 0 || this.followUp.length > 0;
  }

  reset(): void {
    this.queueEpoch += 1;
    this.steering = [];
    this.followUp = [];
    this.awaitingDelivery = [];
    this.knownItemIds.clear();
    this.deliveredItemIds.clear();
    this.rebuilding = false;
  }

  private rememberBoundedId(set: Set<string>, id: string, limit = 256): void {
    if (!id) return;
    set.add(id);
    while (set.size > limit) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  private recordKnownEntries(entries: readonly InternalQueueEntry[]): void {
    for (const entry of entries) {
      this.rememberBoundedId(this.knownItemIds, entry.id);
    }
  }

  private isKnownDeliveredId(itemId: string): boolean {
    return (
      this.deliveredItemIds.has(itemId) ||
      this.awaitingDelivery.some((entry) => entry.id === itemId)
    );
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private recordAwaitingDelivery(dropped: InternalQueueEntry[]): void {
    if (dropped.length === 0) return;
    for (const entry of dropped) {
      this.rememberBoundedId(this.knownItemIds, entry.id);
      this.rememberBoundedId(this.deliveredItemIds, entry.id);
    }
    this.awaitingDelivery.push(...dropped);
    if (this.awaitingDelivery.length > 32) {
      this.awaitingDelivery.splice(0, this.awaitingDelivery.length - 32);
    }
  }

  reconcileWithSession(session?: QueueCapableSession | null): PendingQueueState {
    if (!session || this.rebuilding) {
      return this.getState();
    }
    const rawSteer = session.getSteeringMessages?.();
    const rawFollow = session.getFollowUpMessages?.();
    if (Array.isArray(rawSteer)) {
      const res = alignEntriesWithRawTexts(this.steering, rawSteer, 'steer');
      this.steering = res.aligned;
      this.recordKnownEntries(res.aligned);
      this.recordAwaitingDelivery(res.dropped);
    }
    if (Array.isArray(rawFollow)) {
      const res = alignEntriesWithRawTexts(this.followUp, rawFollow, 'followUp');
      this.followUp = res.aligned;
      this.recordKnownEntries(res.aligned);
      this.recordAwaitingDelivery(res.dropped);
    }
    return this.getState();
  }

  async enqueue(
    session: QueueCapableSession,
    text: string,
    mode: QueuedMessageMode,
    images?: readonly ChatImageAttachment[]
  ): Promise<{ item: QueuedMessageItem; queue: PendingQueueState }> {
    const normalizedImages =
      Array.isArray(images) && images.length > 0 ? images.map((img) => ({ ...img })) : undefined;
    const trimmed = String(text || '').trim() || (normalizedImages?.length ? DEFAULT_IMAGE_ONLY_PROMPT : '');
    if (!trimmed) {
      throw new Error('消息内容不能为空。');
    }
    return this.runSerialized(async () => {
      const myEpoch = this.queueEpoch;
      const entry: InternalQueueEntry = {
        id: generateQueueItemId(mode),
        mode,
        text: trimmed,
        wireText: trimmed,
        createdAt: new Date().toISOString(),
        ...(normalizedImages ? { images: normalizedImages } : {}),
      };
      this.rememberBoundedId(this.knownItemIds, entry.id);
      const targetList = mode === 'steer' ? this.steering : this.followUp;
      const beforeLen =
        mode === 'steer'
          ? (session.getSteeringMessages?.().length ?? 0)
          : (session.getFollowUpMessages?.().length ?? 0);

      // 预插入本地列表，确保即使在极端微任务窗口内立刻被消费也能在 message_start 命中
      targetList.push(entry);
      this.rebuilding = true;
      try {
        const piImages = normalizedImages?.length ? toPiImageContents(normalizedImages) : undefined;
        if (mode === 'steer') {
          if (typeof session.steer !== 'function') {
            throw new Error('当前会话不支持 Steer 插话。');
          }
          if (piImages) {
            await session.steer(trimmed, piImages);
          } else {
            await session.steer(trimmed);
          }
        } else {
          if (typeof session.followUp !== 'function') {
            throw new Error('当前会话不支持 Follow-up 排队。');
          }
          if (piImages) {
            await session.followUp(trimmed, piImages);
          } else {
            await session.followUp(trimmed);
          }
        }
        if (this.queueEpoch !== myEpoch) {
          try {
            session.clearQueue?.();
          } catch {
            // Ignore cleanup failure after epoch invalidation
          }
          return {
            item: toPublicItem(entry),
            queue: this.getState(),
          };
        }
        const afterRaw =
          mode === 'steer'
            ? (session.getSteeringMessages?.() ?? [])
            : (session.getFollowUpMessages?.() ?? []);
        if (afterRaw.length > beforeLen) {
          const latestWire = afterRaw[afterRaw.length - 1];
          if (typeof latestWire === 'string' && latestWire.length > 0) {
            entry.wireText = latestWire;
          }
        }
      } catch (err) {
        if (this.queueEpoch === myEpoch) {
          const rollbackIdx = targetList.findIndex((e) => e.id === entry.id);
          if (rollbackIdx !== -1) {
            targetList.splice(rollbackIdx, 1);
          }
        }
        this.knownItemIds.delete(entry.id);
        throw err;
      } finally {
        if (this.queueEpoch === myEpoch) {
          this.rebuilding = false;
        }
      }

      this.reconcileWithSession(session);
      return {
        item: toPublicItem(entry),
        queue: this.getState(),
      };
    });
  }

  /**
   * 当 Pi 触发 `message_start(role === 'user')` 时识别该消息来自 steer 还是 followUp，
   * 并同步推进本地队列状态。
   */
  consumeDelivered(
    deliveredText: string,
    session?: QueueCapableSession | null
  ): DeliveredQueueMatch | null {
    const raw = String(deliveredText ?? '');
    const awaitIdx = this.awaitingDelivery.findIndex((e) => e.wireText === raw || e.text === raw);
    if (awaitIdx !== -1) {
      const [matched] = this.awaitingDelivery.splice(awaitIdx, 1);
      this.rememberBoundedId(this.deliveredItemIds, matched.id);
      this.reconcileWithSession(session);
      return { id: matched.id, mode: matched.mode, text: matched.text };
    }
    const steerIdx = this.steering.findIndex((e) => e.wireText === raw || e.text === raw);
    if (steerIdx !== -1) {
      const [matched] = this.steering.splice(steerIdx, 1);
      this.rememberBoundedId(this.deliveredItemIds, matched.id);
      this.reconcileWithSession(session);
      return { id: matched.id, mode: 'steer', text: matched.text };
    }
    const followIdx = this.followUp.findIndex((e) => e.wireText === raw || e.text === raw);
    if (followIdx !== -1) {
      const [matched] = this.followUp.splice(followIdx, 1);
      this.rememberBoundedId(this.deliveredItemIds, matched.id);
      this.reconcileWithSession(session);
      return { id: matched.id, mode: 'followUp', text: matched.text };
    }

    // 兜底：若文本被规范化未能精确匹配，优先消费 awaitingDelivery 队首，再按队列长度差判断
    if (this.awaitingDelivery.length > 0) {
      const matched = this.awaitingDelivery.shift()!;
      this.rememberBoundedId(this.deliveredItemIds, matched.id);
      this.reconcileWithSession(session);
      return { id: matched.id, mode: matched.mode, text: matched.text };
    }
    if (session && !this.rebuilding) {
      const piSteerLen = session.getSteeringMessages?.().length;
      if (typeof piSteerLen === 'number' && this.steering.length > piSteerLen) {
        const matched = this.steering.shift()!;
        this.rememberBoundedId(this.deliveredItemIds, matched.id);
        this.reconcileWithSession(session);
        return { id: matched.id, mode: 'steer', text: matched.text };
      }
      const piFollowLen = session.getFollowUpMessages?.().length;
      if (typeof piFollowLen === 'number' && this.followUp.length > piFollowLen) {
        const matched = this.followUp.shift()!;
        this.rememberBoundedId(this.deliveredItemIds, matched.id);
        this.reconcileWithSession(session);
        return { id: matched.id, mode: 'followUp', text: matched.text };
      }
    }
    return null;
  }

  private async replayToSession(
    session: QueueCapableSession,
    nextSteering: InternalQueueEntry[],
    nextFollowUp: InternalQueueEntry[],
    expectedEpoch: number
  ): Promise<boolean> {
    if (this.queueEpoch !== expectedEpoch) {
      return false;
    }
    this.steering = nextSteering;
    this.followUp = nextFollowUp;
    for (const entry of nextSteering) {
      if (this.queueEpoch !== expectedEpoch) {
        try {
          session.clearQueue?.();
        } catch {
          // Ignore stale replay cleanup error
        }
        return false;
      }
      const piImages = entry.images?.length ? toPiImageContents(entry.images) : undefined;
      if (piImages) {
        await session.steer?.(entry.wireText, piImages);
      } else {
        await session.steer?.(entry.wireText);
      }
      if (this.queueEpoch !== expectedEpoch) {
        try {
          session.clearQueue?.();
        } catch {
          // Ignore stale replay cleanup error
        }
        return false;
      }
    }
    for (const entry of nextFollowUp) {
      if (this.queueEpoch !== expectedEpoch) {
        try {
          session.clearQueue?.();
        } catch {
          // Ignore stale replay cleanup error
        }
        return false;
      }
      const piImages = entry.images?.length ? toPiImageContents(entry.images) : undefined;
      if (piImages) {
        await session.followUp?.(entry.wireText, piImages);
      } else {
        await session.followUp?.(entry.wireText);
      }
      if (this.queueEpoch !== expectedEpoch) {
        try {
          session.clearQueue?.();
        } catch {
          // Ignore stale replay cleanup error
        }
        return false;
      }
    }
    return this.queueEpoch === expectedEpoch;
  }

  async removeItem(session: QueueCapableSession, itemId: string): Promise<QueueMutationResult> {
    const cleanId = itemId.trim();
    if (!cleanId) {
      return { found: false, alreadyDelivered: false, removed: null, queue: this.getState() };
    }
    return this.runSerialized(async () => {
      const myEpoch = this.queueEpoch;
      this.rebuilding = true;
      try {
        const cleared = session.clearQueue?.() ?? {
          steering: this.steering.map((e) => e.wireText),
          followUp: this.followUp.map((e) => e.wireText),
        };
        const steerAlign = alignEntriesWithRawTexts(this.steering, cleared.steering, 'steer');
        const followAlign = alignEntriesWithRawTexts(this.followUp, cleared.followUp, 'followUp');
        this.recordKnownEntries(steerAlign.aligned);
        this.recordKnownEntries(followAlign.aligned);
        this.recordAwaitingDelivery(steerAlign.dropped);
        this.recordAwaitingDelivery(followAlign.dropped);
        const liveSteer = steerAlign.aligned;
        const liveFollow = followAlign.aligned;

        let removed: InternalQueueEntry | null = null;
        const steerIdx = liveSteer.findIndex((e) => e.id === cleanId);
        if (steerIdx !== -1) {
          removed = liveSteer.splice(steerIdx, 1)[0];
        } else {
          const followIdx = liveFollow.findIndex((e) => e.id === cleanId);
          if (followIdx !== -1) {
            removed = liveFollow.splice(followIdx, 1)[0];
          }
        }

        const replayed = await this.replayToSession(session, liveSteer, liveFollow, myEpoch);
        if (!replayed) {
          return {
            found: false,
            alreadyDelivered: false,
            removed: null,
            queue: this.getState(),
          };
        }
        if (!removed) {
          return {
            found: false,
            alreadyDelivered: this.isKnownDeliveredId(cleanId),
            removed: null,
            queue: this.getState(),
          };
        }
        this.knownItemIds.delete(cleanId);
        this.deliveredItemIds.delete(cleanId);
        return {
          found: true,
          removed: toPublicItem(removed),
          ...(removed.images?.length ? { removedImages: removed.images.map((img) => ({ ...img })) } : {}),
          queue: this.getState(),
        };
      } finally {
        if (this.queueEpoch === myEpoch) {
          this.rebuilding = false;
        }
      }
    });
  }

  async switchItemMode(
    session: QueueCapableSession,
    itemId: string,
    targetMode: QueuedMessageMode
  ): Promise<QueueMutationResult> {
    const cleanId = itemId.trim();
    if (!cleanId) {
      return { found: false, alreadyDelivered: false, item: null, queue: this.getState() };
    }
    return this.runSerialized(async () => {
      const myEpoch = this.queueEpoch;
      this.rebuilding = true;
      try {
        const cleared = session.clearQueue?.() ?? {
          steering: this.steering.map((e) => e.wireText),
          followUp: this.followUp.map((e) => e.wireText),
        };
        const steerAlign = alignEntriesWithRawTexts(this.steering, cleared.steering, 'steer');
        const followAlign = alignEntriesWithRawTexts(this.followUp, cleared.followUp, 'followUp');
        this.recordKnownEntries(steerAlign.aligned);
        this.recordKnownEntries(followAlign.aligned);
        this.recordAwaitingDelivery(steerAlign.dropped);
        this.recordAwaitingDelivery(followAlign.dropped);
        const liveSteer = steerAlign.aligned;
        const liveFollow = followAlign.aligned;

        let moved: InternalQueueEntry | null = null;
        const steerIdx = liveSteer.findIndex((e) => e.id === cleanId);
        if (steerIdx !== -1) {
          if (targetMode === 'steer') {
            moved = liveSteer[steerIdx];
          } else {
            moved = liveSteer.splice(steerIdx, 1)[0];
            moved.mode = 'followUp';
            liveFollow.push(moved);
          }
        } else {
          const followIdx = liveFollow.findIndex((e) => e.id === cleanId);
          if (followIdx !== -1) {
            if (targetMode === 'followUp') {
              moved = liveFollow[followIdx];
            } else {
              moved = liveFollow.splice(followIdx, 1)[0];
              moved.mode = 'steer';
              liveSteer.push(moved);
            }
          }
        }

        const replayed = await this.replayToSession(session, liveSteer, liveFollow, myEpoch);
        if (!replayed) {
          return {
            found: false,
            alreadyDelivered: false,
            item: null,
            queue: this.getState(),
          };
        }
        if (!moved) {
          return {
            found: false,
            alreadyDelivered: this.isKnownDeliveredId(cleanId),
            item: null,
            queue: this.getState(),
          };
        }
        return {
          found: true,
          item: toPublicItem(moved),
          queue: this.getState(),
        };
      } finally {
        if (this.queueEpoch === myEpoch) {
          this.rebuilding = false;
        }
      }
    });
  }

  async clearAll(session?: QueueCapableSession | null): Promise<{
    cleared: PendingQueueState;
    restoredDraft: RestoredDraftPayload | null;
    queue: PendingQueueState;
  }> {
    return this.runSerialized(async () => {
      const { cleared, restoredDraft } = this.clearSyncInternal(session);
      return {
        cleared,
        restoredDraft,
        queue: this.getState(),
      };
    });
  }

  /**
   * 同步原子清空队列并生成中止/异常回填草稿（可直接用于 abort / finalize 路径，不阻塞于微任务链）。
   */
  clearForRestore(session?: QueueCapableSession | null): RestoredDraftPayload | null {
    return this.clearSyncInternal(session).restoredDraft;
  }

  private clearSyncInternal(session?: QueueCapableSession | null): {
    cleared: PendingQueueState;
    restoredDraft: RestoredDraftPayload | null;
  } {
    this.queueEpoch += 1;
    this.rebuilding = true;
    try {
      const rawCleared = session?.clearQueue?.();
      const liveSteer = rawCleared
        ? alignEntriesWithRawTexts(this.steering, rawCleared.steering, 'steer').aligned
        : [...this.steering];
      const liveFollow = rawCleared
        ? alignEntriesWithRawTexts(this.followUp, rawCleared.followUp, 'followUp').aligned
        : [...this.followUp];

      const cleared: PendingQueueState = {
        steering: liveSteer.map(toPublicItem),
        followUp: liveFollow.map(toPublicItem),
      };
      this.steering = [];
      this.followUp = [];
      this.awaitingDelivery = [];

      const restoredDraft = buildRestoredDraft(
        liveSteer.map((e) => e.text),
        liveFollow.map((e) => e.text)
      );
      return { cleared, restoredDraft };
    } finally {
      this.rebuilding = false;
    }
  }
}

/**
 * 统一把 Pi AgentSession / SettingsManager 的队列投递策略配置为：
 * steeringMode = "all"，followUpMode = "one-at-a-time"。
 */
export function applyPaperCupQueueModes(
  settingsManager?: {
    setSteeringMode?: (mode: 'all' | 'one-at-a-time') => void;
    setFollowUpMode?: (mode: 'all' | 'one-at-a-time') => void;
  } | null,
  session?: QueueCapableSession | null
): void {
  try {
    settingsManager?.setSteeringMode?.('all');
    settingsManager?.setFollowUpMode?.('one-at-a-time');
  } catch {
    // Ignore settings manager compatibility errors
  }
  try {
    session?.setSteeringMode?.('all');
    session?.setFollowUpMode?.('one-at-a-time');
  } catch {
    // Ignore session compatibility errors
  }
}
