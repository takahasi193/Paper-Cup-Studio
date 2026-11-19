import * as React from 'react';
import { Pause, Play } from 'lucide-react';
import cupLight from '@/assets/paper-cup-light.webp';
import cupDark from '@/assets/paper-cup-dark.webp';
import { gsap } from '@/lib/gsap.js';

/** 左杯日文 ⇄ 右杯中文：同一句话在纸杯电话两端「传过去」。 */
const DIALOGUE: ReadonlyArray<{ ja: string; zh: string }> = [
  { ja: '聞こえる？', zh: '听得见吗？' },
  { ja: '届いたよ。', zh: '传到了哦。' },
  { ja: '物語を、君へ。', zh: '把故事传给你。' },
  { ja: 'また明日ね。', zh: '明天见啦。' },
];

function Chars({ text }: { text: string }) {
  return (
    <>
      {Array.from(text).map((ch, i) => (
        <span key={i}>{ch}</span>
      ))}
    </>
  );
}

interface StringPhoneProps {
  /** 环境动效开关（设置中的「环境动效」）；关闭时气泡保持静态首句。 */
  motionAllowed?: boolean;
}

/**
 * Borderless watercolor paper-cup showcase with cup-aligned bilingual speech bubbles.
 * The illustration adapts seamlessly across Light「纸」and Dark「夜」via theme-aware WebP assets.
 * 气泡样式保持不变，动效层：轻微漂浮 + 左右气泡依次弹出、逐字「传话」并循环切换台词。
 */
export function StringPhone({ motionAllowed = true }: StringPhoneProps) {
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const leftFloatRef = React.useRef<HTMLDivElement>(null);
  const rightFloatRef = React.useRef<HTMLDivElement>(null);
  const leftBubbleRef = React.useRef<HTMLDivElement>(null);
  const rightBubbleRef = React.useRef<HTMLDivElement>(null);
  const leftTextRef = React.useRef<HTMLSpanElement>(null);
  const rightTextRef = React.useRef<HTMLSpanElement>(null);

  const shouldAnimate = motionAllowed && !paused;
  const line = shouldAnimate ? DIALOGUE[index] : DIALOGUE[paused ? index : 0];

  React.useEffect(() => {
    if (!motionAllowed) {
      setIndex(0);
      setPaused(false);
    }
  }, [motionAllowed]);

  // 气泡轻微漂浮（左右错相，避免机械同步）
  React.useLayoutEffect(() => {
    if (!shouldAnimate) return undefined;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.to(leftFloatRef.current, {
        y: -4,
        duration: 2.4,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
      gsap.to(rightFloatRef.current, {
        y: -3,
        duration: 2.9,
        delay: 0.7,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
    });
    return () => mm.revert();
  }, [shouldAnimate]);

  // 一轮对话：左气泡弹出逐字显现 → 右气泡回应 → 停留 → 收起 → 下一句
  React.useLayoutEffect(() => {
    if (!shouldAnimate) {
      const bubbles = [leftBubbleRef.current, rightBubbleRef.current].filter(Boolean);
      const chars = [
        ...Array.from(leftTextRef.current?.children ?? []),
        ...Array.from(rightTextRef.current?.children ?? []),
      ];
      if (bubbles.length > 0) {
        gsap.set(bubbles, { opacity: 1, scale: 1, y: 0 });
      }
      if (chars.length > 0) {
        gsap.set(chars, { opacity: 1 });
      }
      return undefined;
    }

    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const leftBubble = leftBubbleRef.current;
      const rightBubble = rightBubbleRef.current;
      if (!leftBubble || !rightBubble) return;
      const leftChars = Array.from(leftTextRef.current?.children ?? []);
      const rightChars = Array.from(rightTextRef.current?.children ?? []);

      gsap.set([leftBubble, rightBubble], { opacity: 0, scale: 0.86, y: 0 });
      gsap.set([...leftChars, ...rightChars], { opacity: 0 });

      gsap
        .timeline({
          delay: index === 0 ? 0.55 : 0.2,
          onComplete: () => setIndex((i) => (i + 1) % DIALOGUE.length),
        })
        .to(leftBubble, { scale: 1, duration: 0.42, ease: 'back.out(2.2)' })
        .to(leftBubble, { opacity: 1, duration: 0.22, ease: 'power1.out' }, '<')
        .to(leftChars, { opacity: 1, duration: 0.12, stagger: 0.07 }, '<0.06')
        .to(rightBubble, { scale: 1, duration: 0.42, ease: 'back.out(2.2)' }, '+=0.45')
        .to(rightBubble, { opacity: 1, duration: 0.22, ease: 'power1.out' }, '<')
        .to(rightChars, { opacity: 1, duration: 0.12, stagger: 0.07 }, '<0.06')
        .to(
          [leftBubble, rightBubble],
          { opacity: 0, scale: 0.94, y: -3, duration: 0.32, ease: 'power2.in', stagger: 0.08 },
          '+=2.6'
        );
    });
    return () => mm.revert();
  }, [index, shouldAnimate]);

  return (
    <div className="relative mx-auto flex w-full max-w-[min(34rem,56dvh)] flex-col">
      <div
        className="pc-cup-halo pointer-events-none absolute inset-x-[12%] inset-y-[10%] rounded-full"
        aria-hidden="true"
      />

      {/* Left cup speech bubble (points down into the open mouth of the left cup) */}
      <div
        ref={leftFloatRef}
        aria-hidden="true"
        className="relative z-10 order-first -mb-2 self-start pl-[5%] sm:order-none sm:mb-0 sm:pl-0 sm:absolute sm:left-[7%] sm:top-[20%]"
      >
        <div
          ref={leftBubbleRef}
          className="relative inline-flex origin-[26px_100%] items-center rounded-2xl border border-voice/30 bg-surface-raised/95 px-3.5 py-1.5 text-[0.8125rem] text-ink shadow-[var(--shadow-card)] backdrop-blur-xs"
        >
          <span ref={leftTextRef} lang="ja" className="pc-editorial-jp leading-snug">
            <Chars text={line.ja} />
          </span>
          <svg
            width="12"
            height="7"
            viewBox="0 0 12 7"
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-[6px] left-5 block text-voice/35"
          >
            <path d="M1 0 L6 6 L11 0" className="fill-surface-raised" stroke="currentColor" strokeWidth="1" />
            <path d="M1.5 0 H10.5" className="stroke-surface-raised" strokeWidth="1.5" />
          </svg>
        </div>
      </div>

      {/* Rendered Japanese watercolor paper-cup artwork (Light「纸」/ Dark「夜」) */}
      <div className="relative w-full">
        <img
          src={cupLight}
          alt=""
          width={1236}
          height={598}
          decoding="async"
          fetchPriority="high"
          className="pc-cup-art-light h-auto w-full select-none"
          draggable={false}
        />
        <img
          src={cupDark}
          alt=""
          width={1236}
          height={598}
          decoding="async"
          className="pc-cup-art-dark h-auto w-full select-none"
          draggable={false}
        />
      </div>

      {/* Right cup speech bubble (points up toward the elevated right cup) */}
      <div
        ref={rightFloatRef}
        aria-hidden="true"
        className="relative z-10 -mt-2 self-end pr-[5%] sm:mt-0 sm:pr-0 sm:absolute sm:right-[6%] sm:bottom-[13%]"
      >
        <div
          ref={rightBubbleRef}
          className="relative inline-flex origin-[calc(100%-30px)_0] items-center rounded-2xl border border-string/35 bg-surface-raised/95 px-3.5 py-1.5 text-[0.8125rem] font-medium text-string-ink shadow-[var(--shadow-card)] backdrop-blur-xs"
        >
          <span ref={rightTextRef} lang="zh-CN" className="pc-editorial-title leading-snug tracking-[0.04em]">
            <Chars text={line.zh} />
          </span>
          <svg
            width="12"
            height="7"
            viewBox="0 0 12 7"
            aria-hidden="true"
            className="pointer-events-none absolute -top-[6px] right-6 block text-string/40"
          >
            <path d="M1 7 L6 1 L11 7" className="fill-surface-raised" stroke="currentColor" strokeWidth="1" />
            <path d="M1.5 7 H10.5" className="stroke-surface-raised" strokeWidth="1.5" />
          </svg>
        </div>
      </div>

      {motionAllowed && (
        <div className="-mt-1 flex justify-center">
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-raised/85 px-2.5 py-0.5 text-[11px] text-ink-3 opacity-75 transition-opacity hover:border-line-strong hover:text-ink hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
          >
            {paused ? (
              <>
                <Play className="size-2.5 fill-current" aria-hidden="true" />
                <span>继续台词动画</span>
              </>
            ) : (
              <>
                <Pause className="size-2.5" aria-hidden="true" />
                <span>暂停台词动画</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
