import * as React from 'react';
import { ArrowRight, Folder } from 'lucide-react';
import { StringPhone } from '@/components/brand/StringPhone.js';
import { EngineeringStatus } from '@/lib/api.js';
import { gsap } from '@/lib/gsap.js';
import { getPathBase } from '@/lib/paths.js';

export interface SuggestionItem {
  num: string;
  title: string;
  subtitle: string;
  prompt: string;
}

export const SUGGESTIONS: readonly SuggestionItem[] = [
  {
    num: '01',
    title: '解包并识别引擎',
    subtitle: '自动探测游戏封包结构与脚本引擎类型',
    prompt: '解包当前游戏目录并识别引擎',
  },
  {
    num: '02',
    title: '检查本地化状态',
    subtitle: '汇总工程画像、分轨进展与待补齐配置',
    prompt: '检查当前工作区的本地化状态',
  },
  {
    num: '03',
    title: '运行确定性 QA',
    subtitle: '扫描占位符、标签语法与人称一致性问题',
    prompt: '对当前译文运行确定性 QA 并汇总问题',
  },
  {
    num: '04',
    title: '生成验收报告',
    subtitle: '校验双轨完整度并输出个人学习发布说明',
    prompt: '生成本地化验收与发布报告',
  },
];

interface EmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
  motionAllowed: boolean;
  activeWorkspace?: string;
  engineeringStatus?: EngineeringStatus | null;
  onOpenWorkspaceSwitcher?: () => void;
}

export function EmptyState({
  onSelectPrompt,
  motionAllowed,
  activeWorkspace,
  engineeringStatus,
  onOpenWorkspaceSwitcher,
}: EmptyStateProps) {
  const sectionRef = React.useRef<HTMLElement>(null);
  const kickerRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const artworkRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLOListElement>(null);

  const wsName = getPathBase(activeWorkspace || '') || '';
  const firstEngineLine = (engineeringStatus?.engine || '').trim().split(/\r?\n/)[0] || '';
  const hasKnownEngine =
    Boolean(firstEngineLine) &&
    !firstEngineLine.includes('未识别') &&
    !firstEngineLine.toLowerCase().startsWith('unknown');
  const engineShort = hasKnownEngine ? firstEngineLine.split(/\s+/)[0] : '';

  React.useLayoutEffect(() => {
    const mm = gsap.matchMedia();

    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const heroTargets = [kickerRef.current, headingRef.current, artworkRef.current].filter(Boolean);
      const items = listRef.current ? Array.from(listRef.current.children) : [];

      if (!motionAllowed) {
        gsap.set([...heroTargets, ...items], { opacity: 1, clearProps: 'transform,opacity' });
        return;
      }

      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

      // Headline and rendered paper-cup artwork fade in cohesively on arrival
      tl.from(heroTargets, {
        y: 10,
        opacity: 0,
        duration: 0.65,
        stagger: 0.08,
        clearProps: 'transform,opacity',
      });

      if (items.length > 0) {
        tl.from(
          items,
          {
            y: 8,
            opacity: 0,
            duration: 0.36,
            stagger: 0.05,
            clearProps: 'transform,opacity',
          },
          '-=0.28'
        );
      }
    });

    mm.add('(prefers-reduced-motion: reduce)', () => {
      const targets = [
        kickerRef.current,
        headingRef.current,
        artworkRef.current,
        ...(listRef.current ? Array.from(listRef.current.children) : []),
      ].filter(Boolean);
      gsap.fromTo(
        targets,
        { opacity: 0 },
        { opacity: 1, duration: 0.14, clearProps: 'opacity' }
      );
    });

    return () => mm.revert();
  }, [motionAllowed]);

  const handleCardPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!motionAllowed || e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${Math.round(e.clientX - rect.left)}px`);
    e.currentTarget.style.setProperty('--my', `${Math.round(e.clientY - rect.top)}px`);
  };

  return (
    <section
      ref={sectionRef}
      aria-labelledby="empty-hero-title"
      className="mx-auto flex max-w-[44rem] flex-col items-center pt-[clamp(0.75rem,2.4dvh,2rem)] pb-2 text-center"
    >
      <div ref={kickerRef} className="mb-2 flex flex-wrap items-center justify-center gap-2">
        <span className="font-mono text-[10.5px] font-medium tracking-[0.22em] text-ink-3 uppercase">
          PAPER CUP STUDIO
        </span>
        {onOpenWorkspaceSwitcher && (
          <button
            type="button"
            onClick={onOpenWorkspaceSwitcher}
            aria-haspopup="dialog"
            className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-raised px-2.5 py-0.5 text-[11px] font-medium text-ink-2 shadow-[var(--shadow-card)] transition-colors hover:border-string/45 hover:text-ink cursor-pointer"
          >
            <Folder className="size-3 text-string" aria-hidden="true" />
            <span className="max-w-[14rem] truncate">{wsName || '选择游戏目录'}</span>
            {engineShort && (
              <span className="rounded-full bg-string-soft px-1.5 py-px font-mono text-[10px] text-string-ink">
                {engineShort}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Main tagline nestled right above the red cotton wire */}
      <h1
        ref={headingRef}
        id="empty-hero-title"
        className="pc-editorial-title relative z-20 mb-1 sm:-mb-8 text-ink"
        style={{ fontSize: 'clamp(1.375rem, 1rem + 1.25vw, 1.95rem)' }}
      >
        今天，想把哪部作品
        <br />
        <span className="text-string-ink">传到另一种语言里？</span>
      </h1>

      <div ref={artworkRef} className="w-full">
        <StringPhone motionAllowed={motionAllowed} />
      </div>

      <ol
        ref={listRef}
        className="mt-3.5 grid w-full max-w-[40rem] grid-cols-1 gap-2.5 text-left sm:mt-4 sm:grid-cols-2"
      >
        {SUGGESTIONS.map((item) => (
          <li key={item.num}>
            <button
              type="button"
              onClick={() => onSelectPrompt(item.prompt)}
              onPointerMove={handleCardPointerMove}
              className="pc-hero-card group flex w-full items-start gap-3 rounded-2xl px-3.5 py-2.5 text-left cursor-pointer"
            >
              <span className="pc-display pt-0.5 italic text-2xl leading-none text-string-ink">
                {item.num}
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block truncate text-[0.875rem] font-semibold text-ink transition-colors group-hover:text-string-ink">
                  {item.title}
                </span>
                <span className="block truncate text-xs text-ink-3">{item.subtitle}</span>
              </span>
              <ArrowRight
                className="mt-1 size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-string-ink"
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
