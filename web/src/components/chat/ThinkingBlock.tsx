import * as React from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { StreamingText } from './StreamingText.js';
import { gsap, useGsapDetails } from '@/lib/gsap.js';
import { cn } from '@/lib/utils.js';

interface ThinkingBlockProps {
  thinking: string;
  isStreaming?: boolean;
}

export function ThinkingBlock({ thinking, isStreaming = false }: ThinkingBlockProps) {
  const cursorRef = React.useRef<HTMLSpanElement>(null);
  const { detailsRef, bodyRef, chevronRef, handleSummaryClick, handleToggle } =
    useGsapDetails({ controlledOpen: isStreaming });

  React.useLayoutEffect(() => {
    if (!isStreaming || !cursorRef.current) return undefined;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      if (!cursorRef.current) return;
      gsap.to(cursorRef.current, {
        opacity: 0.25,
        scaleY: 0.8,
        duration: 0.52,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
    });
    return () => mm.revert();
  }, [isStreaming]);

  if (!thinking) return null;

  return (
    <details
      ref={detailsRef}
      open={isStreaming}
      onToggle={handleToggle}
      className="pc-details w-full"
    >
      <summary
        onClick={handleSummaryClick}
        className="inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-xs text-ink-3 transition-colors hover:border-line hover:bg-well/70 hover:text-ink"
      >
        <ChevronRight
          ref={chevronRef}
          className="pc-chevron size-3.5 shrink-0"
          aria-hidden="true"
        />
        <Brain
          className={cn('size-3.5 shrink-0', isStreaming && 'text-string')}
          aria-hidden="true"
        />
        <span className={cn(isStreaming && 'font-medium text-string-ink')}>
          {isStreaming ? '正在思考…' : `已深度思考 · ${thinking.length} 字`}
        </span>
      </summary>
      <div
        ref={bodyRef}
        className={cn(
          'pc-scroller mt-1.5 mb-2 ml-2 max-h-80 overflow-y-auto rounded-r-xl border-l-2 bg-well/40 py-2 pr-3 pl-4 text-[0.8125rem] leading-6 text-ink-2 whitespace-pre-wrap break-words',
          isStreaming ? 'border-string/65' : 'border-line-strong'
        )}
      >
        {isStreaming ? (
          <>
            <StreamingText text={thinking} />
            <span ref={cursorRef} className="pc-stream-cursor" aria-hidden="true" />
          </>
        ) : (
          thinking
        )}
      </div>
    </details>
  );
}
