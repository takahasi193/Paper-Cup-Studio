import * as React from 'react';

interface StreamChunk {
  id: number;
  text: string;
}

const MAX_STREAM_CHUNKS = 160;
const RETAINED_TAIL_CHUNKS = 40;

export function StreamingText({ text }: { text: string }) {
  const [chunks, setChunks] = React.useState<StreamChunk[]>(() =>
    text ? [{ id: 0, text }] : []
  );
  const nextIdRef = React.useRef(1);

  React.useLayoutEffect(() => {
    setChunks((prev) => {
      const current = prev.map((c) => c.text).join('');
      if (current === text) return prev;
      if (!text) return [];
      if (text.startsWith(current)) {
        const delta = text.slice(current.length);
        if (!delta) return prev;
        if (prev.length >= MAX_STREAM_CHUNKS) {
          const headCount = prev.length - RETAINED_TAIL_CHUNKS;
          const mergedText = prev
            .slice(0, headCount)
            .map((c) => c.text)
            .join('');
          return [
            { id: prev[0].id, text: mergedText },
            ...prev.slice(headCount),
            { id: nextIdRef.current++, text: delta },
          ];
        }
        return [...prev, { id: nextIdRef.current++, text: delta }];
      }
      return [{ id: nextIdRef.current++, text }];
    });
  }, [text]);

  return (
    <>
      {chunks.map((chunk) => (
        <span key={chunk.id} className="pc-stream-chunk">
          {chunk.text}
        </span>
      ))}
    </>
  );
}
