import * as React from 'react';
import { ArrowRight, Folder } from 'lucide-react';
import { EngineeringStatus, resolveEngineDisplay } from '@/lib/api.js';
import { gsap } from '@/lib/gsap.js';
import { getPathBase } from '@/lib/paths.js';
import { cn } from '@/lib/utils.js';

export interface SuggestionItem {
  num: string;
  tag: string;
  title: string;
  subtitle: string;
  prompt: string;
  side: 'top' | 'bottom';
  xNorm: number;
}

export const SUGGESTIONS: readonly SuggestionItem[] = [
  {
    num: '01',
    tag: 'vn_detect',
    title: '解包并识别引擎',
    subtitle: '自动探测游戏封包结构与脚本引擎类型',
    prompt: '解包当前游戏目录并识别引擎',
    side: 'top',
    xNorm: 0.125,
  },
  {
    num: '02',
    tag: 'vn_status',
    title: '检查本地化状态',
    subtitle: '汇总工程画像、分轨进展与待补齐配置',
    prompt: '检查当前工作区的本地化状态',
    side: 'bottom',
    xNorm: 0.375,
  },
  {
    num: '03',
    tag: 'vn_qa',
    title: '运行确定性 QA',
    subtitle: '扫描占位符、标签语法与人称一致性问题',
    prompt: '对当前译文运行确定性 QA 并汇总问题',
    side: 'top',
    xNorm: 0.625,
  },
  {
    num: '04',
    tag: 'vn_release',
    title: '生成验收报告',
    subtitle: '校验双轨完整度并输出个人学习发布说明',
    prompt: '生成本地化验收与发布报告',
    side: 'bottom',
    xNorm: 0.875,
  },
];

const SVG_WIDTH = 1200;
const SVG_HEIGHT = 136;
const CENTER_Y = SVG_HEIGHT / 2;
const SAMPLE_COUNT = 72;
const CEL_STEP_MS = 100; // 10fps anime cel cadence aligned with Paper Cup Red Thread
const BEND_SIGMA = 0.085;
const MAX_BEND_PX = 34;

interface BendState {
  strength: number;
  centerX: number;
  dir: number;
}

function computeWaveY(
  xNorm: number,
  wavePhase: number,
  frameCount: number,
  sampleIndex: number,
  bend: BendState
): number {
  const primary = -Math.sin(xNorm * Math.PI * 3.6 + 0.15) * 10.5;
  const swell = Math.sin(xNorm * Math.PI * 1.9 - wavePhase) * 4.5;
  const trochoid = Math.sin(xNorm * Math.PI * 4.2 - wavePhase * 1.65) * 2.0;
  const boil = Math.sin(sampleIndex * 1.7 + (frameCount % 3) * 2.1) * 0.65;

  let bendOffset = 0;
  if (bend.strength > 0.001) {
    const dist = (xNorm - bend.centerX) / BEND_SIGMA;
    bendOffset = bend.strength * bend.dir * Math.exp(-(dist * dist)) * MAX_BEND_PX;
  }

  const ambientDamp = 1 - Math.min(0.45, Math.abs(bendOffset) / (MAX_BEND_PX * 1.8));
  return CENTER_Y + (primary + swell + trochoid) * ambientDamp + boil + bendOffset;
}

function buildHorizontalWavePath(
  wavePhase: number,
  frameCount: number,
  drawProgress: number,
  bend: BendState
): string {
  const maxIndex = Math.max(
    1,
    Math.round((SAMPLE_COUNT - 1) * Math.max(0, Math.min(1, drawProgress)))
  );
  const pts: Array<{ x: number; y: number }> = [];

  for (let i = 0; i <= maxIndex; i += 1) {
    const xNorm = i / (SAMPLE_COUNT - 1);
    const x = xNorm * SVG_WIDTH;
    const y = computeWaveY(xNorm, wavePhase, frameCount, i, bend);
    pts.push({ x, y });
  }

  if (pts.length === 1) {
    return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  }

  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = ((pts[i].x + pts[i + 1].x) * 0.5).toFixed(1);
    const my = ((pts[i].y + pts[i + 1].y) * 0.5).toFixed(1);
    d += ` Q ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

const ZERO_BEND: BendState = { strength: 0, centerX: 0.5, dir: -1 };
const STATIC_INITIAL_PATH = buildHorizontalWavePath(0, 0, 1, ZERO_BEND);

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
  const headerRef = React.useRef<HTMLDivElement>(null);
  const waveWrapRef = React.useRef<HTMLDivElement>(null);
  const mainPathRef = React.useRef<SVGPathElement | null>(null);
  const echoPathRef = React.useRef<SVGPathElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLLIElement | null>>([]);
  const hasPlayedDrawRef = React.useRef(false);

  const bendRef = React.useRef<BendState>({ strength: 0, centerX: 0.5, dir: -1 });
  const waveStateRef = React.useRef({ phase: 0, step: 0, drawProgress: 1 });
  const bendTweenRef = React.useRef<gsap.core.Tween | null>(null);
  const activeIdxRef = React.useRef<number | null>(null);
  const redrawRef = React.useRef<() => void>(() => {});

  const wsName = getPathBase(activeWorkspace || '') || '';
  const engineInfo = resolveEngineDisplay(engineeringStatus);
  const engineShort = engineInfo.shortLabel || '';

  // Entrance fade for headline kicker
  React.useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !motionAllowed) {
      gsap.set(el, { opacity: 1, y: 0, clearProps: 'transform,opacity' });
      return undefined;
    }
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(
        el,
        { y: 10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.55, ease: 'power2.out', clearProps: 'transform,opacity' }
      );
    });
    return () => mm.revert();
  }, [motionAllowed]);

  // Continuous full-width horizontal cel-animated red thread with interactive bend
  React.useEffect(() => {
    const mainPath = mainPathRef.current;
    const echoPath = echoPathRef.current;
    if (!mainPath || !echoPath) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const renderCurrentFrame = () => {
      const { phase, step, drawProgress } = waveStateRef.current;
      const bend = bendRef.current;
      const mainD = buildHorizontalWavePath(phase, step, drawProgress, bend);
      const echoD = buildHorizontalWavePath(phase - 0.25, step + 1, drawProgress, bend);
      mainPath.setAttribute('d', mainD);
      echoPath.setAttribute('d', echoD);
    };
    redrawRef.current = renderCurrentFrame;

    if (reduced || !motionAllowed) {
      waveStateRef.current = { phase: 0, step: 0, drawProgress: 1 };
      bendRef.current.strength = 0;
      mainPath.setAttribute('d', STATIC_INITIAL_PATH);
      mainPath.setAttribute('stroke-width', '1.45');
      echoPath.setAttribute('d', STATIC_INITIAL_PATH);
      itemRefs.current.forEach((el) => {
        if (el) {
          gsap.set(el, { opacity: 1, y: 0, clearProps: 'transform,opacity' });
        }
      });
      return () => {
        bendTweenRef.current?.kill();
      };
    }

    const playDrawIn = !hasPlayedDrawRef.current;
    hasPlayedDrawRef.current = true;

    if (playDrawIn) {
      itemRefs.current.forEach((el, idx) => {
        if (!el) return;
        const dirY = SUGGESTIONS[idx].side === 'top' ? -14 : 14;
        gsap.set(el, { opacity: 0, y: dirY });
      });
    } else {
      itemRefs.current.forEach((el) => {
        if (el) {
          gsap.set(el, { opacity: 1, y: 0 });
        }
      });
    }

    let rafId = 0;
    let lastTimestamp = performance.now();
    let accumulator = 0;
    let step = 0;
    let wavePhase = 0;
    const drawSteps = 9;
    const revealThresholds = [0.22, 0.42, 0.62, 0.82];
    const revealedItems = new Set<number>();

    const tickRender = () => {
      const drawProgress = playDrawIn ? Math.min(1, step / drawSteps) : 1;
      waveStateRef.current = { phase: wavePhase, step, drawProgress };
      renderCurrentFrame();

      const strokeJitter = step % 3 === 0 ? 1.55 : step % 3 === 1 ? 1.35 : 1.45;
      mainPath.setAttribute('stroke-width', strokeJitter.toFixed(2));

      if (playDrawIn) {
        revealThresholds.forEach((threshold, idx) => {
          if (!revealedItems.has(idx) && drawProgress >= threshold) {
            revealedItems.add(idx);
            const el = itemRefs.current[idx];
            if (el) {
              gsap.to(el, {
                opacity: 1,
                y: 0,
                duration: 0.45,
                ease: 'power2.out',
                clearProps: 'transform',
              });
            }
          }
        });
      }
    };

    tickRender();

    const tick = (now: number) => {
      const dt = Math.min(now - lastTimestamp, 250);
      lastTimestamp = now;
      accumulator += dt;

      while (accumulator >= CEL_STEP_MS) {
        accumulator -= CEL_STEP_MS;
        step += 1;
        wavePhase += 0.2;
        tickRender();
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      bendTweenRef.current?.kill();
    };
  }, [motionAllowed]);

  const handleItemEnter = React.useCallback(
    (idx: number) => {
      activeIdxRef.current = idx;
      if (!motionAllowed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      const wrapEl = waveWrapRef.current;
      const itemEl = itemRefs.current[idx];
      let targetX = SUGGESTIONS[idx].xNorm;
      if (wrapEl && itemEl) {
        const wrapRect = wrapEl.getBoundingClientRect();
        const itemRect = itemEl.getBoundingClientRect();
        if (wrapRect.width > 0) {
          targetX = Math.max(
            0.06,
            Math.min(0.94, (itemRect.left + itemRect.width * 0.36 - wrapRect.left) / wrapRect.width)
          );
        }
      }

      const targetDir = SUGGESTIONS[idx].side === 'top' ? -1 : 1;
      if (bendRef.current.strength < 0.05) {
        bendRef.current.centerX = targetX;
        bendRef.current.dir = targetDir;
      }

      bendTweenRef.current?.kill();
      bendTweenRef.current = gsap.to(bendRef.current, {
        strength: 1,
        centerX: targetX,
        dir: targetDir,
        duration: 0.42,
        ease: 'power3.out',
        onUpdate: () => redrawRef.current(),
      });
    },
    [motionAllowed]
  );

  const handleItemLeave = React.useCallback(
    (idx: number) => {
      if (activeIdxRef.current !== idx) return;
      activeIdxRef.current = null;
      if (!motionAllowed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      bendTweenRef.current?.kill();
      bendTweenRef.current = gsap.to(bendRef.current, {
        strength: 0,
        duration: 0.6,
        ease: 'power2.out',
        onUpdate: () => redrawRef.current(),
      });
    },
    [motionAllowed]
  );

  return (
    <section
      aria-labelledby="empty-hero-title"
      className="flex w-full flex-col items-center overflow-x-clip pt-[clamp(1.25rem,5dvh,3.75rem)] pb-4 text-center"
    >
      <div
        ref={headerRef}
        className="mx-auto flex w-full max-w-[56rem] flex-col items-center px-4 sm:px-6"
      >
        <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
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

        <h1
          id="empty-hero-title"
          className="pc-editorial-title text-ink"
          style={{ fontSize: 'clamp(1.5rem, 1.05rem + 1.35vw, 2.125rem)' }}
        >
          今天，想把哪部作品
          <br />
          <span className="text-string-ink">传到另一种语言里？</span>
        </h1>
      </div>

      {/* Edge-to-edge full-width oscillating red thread + Alternating Four Milestones */}
      <div className="relative mt-8 w-full sm:mt-10">
        <div
          ref={waveWrapRef}
          aria-hidden="true"
          className="pointer-events-none hidden md:flex md:items-center md:absolute md:inset-x-0 md:top-1/2 md:h-[6.5rem] md:-translate-y-1/2"
        >
          <svg
            viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
            preserveAspectRatio="none"
            fill="none"
            className="h-full w-full overflow-visible"
          >
            <path
              ref={echoPathRef}
              d={STATIC_INITIAL_PATH}
              stroke="var(--string)"
              strokeOpacity="0.2"
              strokeWidth="3.4"
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              ref={mainPathRef}
              d={STATIC_INITIAL_PATH}
              stroke="var(--string)"
              strokeWidth="1.45"
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="mx-auto w-full max-w-[56rem] px-4 sm:px-6">
          <ol className="relative z-10 grid w-full grid-cols-1 gap-3 border-l border-string/55 pl-4 text-left md:grid-cols-4 md:grid-rows-[minmax(6.75rem,1fr)_6.5rem_minmax(6.75rem,1fr)] md:gap-x-3 md:gap-y-0 md:border-l-0 md:pl-0">
            {SUGGESTIONS.map((item, idx) => {
              const desktopSlot =
                idx === 0
                  ? 'md:col-start-1 md:row-start-1 md:self-end md:pb-1'
                  : idx === 1
                    ? 'md:col-start-2 md:row-start-3 md:self-start md:pt-1'
                    : idx === 2
                      ? 'md:col-start-3 md:row-start-1 md:self-end md:pb-1'
                      : 'md:col-start-4 md:row-start-3 md:self-start md:pt-1';

              return (
                <li
                  key={item.num}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  className={cn('relative', desktopSlot)}
                >
                  <button
                    type="button"
                    onClick={() => onSelectPrompt(item.prompt)}
                    onMouseEnter={() => handleItemEnter(idx)}
                    onMouseLeave={() => handleItemLeave(idx)}
                    onFocus={() => handleItemEnter(idx)}
                    onBlur={() => handleItemLeave(idx)}
                    className="group flex w-full flex-col items-start rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-surface-raised/75 cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold tracking-[0.2em] text-string-ink">
                        {item.num}
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-px w-5 bg-string/65 transition-all duration-200 group-hover:w-7 group-hover:bg-string"
                      />
                      <span className="font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
                        {item.tag}
                      </span>
                    </div>

                    <span className="pc-editorial-title mt-1.5 inline-flex items-center gap-1.5 text-[1rem] font-bold tracking-[0.02em] text-ink transition-colors group-hover:text-string-ink">
                      <span>{item.title}</span>
                      <ArrowRight
                        className="size-3.5 shrink-0 text-ink-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-string-ink"
                        aria-hidden="true"
                      />
                    </span>

                    <span className="mt-1 text-xs leading-relaxed text-ink-3">
                      {item.subtitle}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
