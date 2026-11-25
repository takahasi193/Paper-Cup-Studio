export interface OffsetDeltaChunk {
  seq?: number;
  offset?: number;
  endOffset?: number;
  delta: string;
}

export interface LiveFieldOverlay {
  text: string;
  offset: number;
}

export interface LiveMessageOverlay {
  thinking: LiveFieldOverlay;
  content: LiveFieldOverlay;
}

export interface PreBaselineMessageBuffer {
  thinking: OffsetDeltaChunk[];
  content: OffsetDeltaChunk[];
}

export interface DeltaApplyResult {
  next: LiveFieldOverlay;
  changed: boolean;
  gapDetected: boolean;
}

/**
 * Deterministically apply a single stream delta chunk onto an offset-tracked
 * field state. Never guesses character overlap by suffix/prefix matching.
 */
export function applyOffsetDeltaChunk(
  current: LiveFieldOverlay,
  chunk: OffsetDeltaChunk,
  options?: { allowLegacyAppend?: boolean }
): DeltaApplyResult {
  if (!chunk.delta) {
    return { next: current, changed: false, gapDetected: false };
  }

  if (typeof chunk.offset === 'number' && Number.isFinite(chunk.offset) && chunk.offset >= 0) {
    const startOffset = chunk.offset;
    const endOffset =
      typeof chunk.endOffset === 'number' && Number.isFinite(chunk.endOffset) && chunk.endOffset >= startOffset
        ? chunk.endOffset
        : startOffset + chunk.delta.length;

    // Completely covered by current baseline/overlay -> no-op
    if (endOffset <= current.offset) {
      return { next: current, changed: false, gapDetected: false };
    }

    // Gap between current end and incoming start -> do NOT concatenate out-of-order text
    if (startOffset > current.offset) {
      return { next: current, changed: false, gapDetected: true };
    }

    // Contiguous or partially overlapping: slice exact suffix beyond current.offset
    const sliceStart = Math.max(0, current.offset - startOffset);
    const addition = chunk.delta.slice(sliceStart);
    if (!addition) {
      return { next: current, changed: false, gapDetected: false };
    }
    const nextText = current.text + addition;
    const nextOffset = Math.max(endOffset, current.offset + addition.length);
    return {
      next: { text: nextText, offset: nextOffset },
      changed: true,
      gapDetected: false,
    };
  }

  // Legacy fallback only for post-baseline live deltas lacking offset metadata
  if (options?.allowLegacyAppend) {
    const nextText = current.text + chunk.delta;
    return {
      next: { text: nextText, offset: current.offset + chunk.delta.length },
      changed: true,
      gapDetected: false,
    };
  }

  return { next: current, changed: false, gapDetected: false };
}

/**
 * Reconcile an ordered list of buffered pre-baseline chunks against a fresh HTTP snapshot field.
 */
export function reconcileBufferedChunks(
  snapText: string,
  snapOffset: number | undefined,
  chunks: readonly OffsetDeltaChunk[] | undefined
): { field: LiveFieldOverlay; aheadOfSnapshot: boolean; gapDetected: boolean } {
  const baseOffset =
    typeof snapOffset === 'number' && Number.isFinite(snapOffset) && snapOffset >= 0
      ? snapOffset
      : snapText.length;
  let state: LiveFieldOverlay = { text: snapText, offset: baseOffset };
  if (!chunks || chunks.length === 0) {
    return { field: state, aheadOfSnapshot: false, gapDetected: false };
  }

  const ordered = [...chunks].sort((a, b) => {
    const aOff = typeof a.offset === 'number' ? a.offset : Number.POSITIVE_INFINITY;
    const bOff = typeof b.offset === 'number' ? b.offset : Number.POSITIVE_INFINITY;
    if (aOff !== bOff) return aOff - bOff;
    const aSeq = typeof a.seq === 'number' ? a.seq : Number.POSITIVE_INFINITY;
    const bSeq = typeof b.seq === 'number' ? b.seq : Number.POSITIVE_INFINITY;
    return aSeq - bSeq;
  });

  let gapDetected = false;
  for (const chunk of ordered) {
    const res = applyOffsetDeltaChunk(state, chunk, { allowLegacyAppend: false });
    state = res.next;
    if (res.gapDetected) {
      gapDetected = true;
    }
  }

  return {
    field: state,
    aheadOfSnapshot: state.offset > baseOffset,
    gapDetected,
  };
}

/**
 * Reconcile an existing post-baseline live overlay field against a newer HTTP snapshot.
 * If the snapshot caught up to or surpassed the overlay's verified offset, drop the overlay.
 */
export function reconcileOverlayWithSnapshot(
  snapText: string,
  snapOffset: number | undefined,
  existing: LiveFieldOverlay | undefined
): { field: LiveFieldOverlay; aheadOfSnapshot: boolean } {
  const baseOffset =
    typeof snapOffset === 'number' && Number.isFinite(snapOffset) && snapOffset >= 0
      ? snapOffset
      : snapText.length;
  if (existing && existing.offset > baseOffset) {
    return { field: existing, aheadOfSnapshot: true };
  }
  return { field: { text: snapText, offset: baseOffset }, aheadOfSnapshot: false };
}
