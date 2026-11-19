import * as React from 'react';
import { cn } from '@/lib/utils.js';

/**
 * 像素风「纸杯传递」加载动画（无 SVG）。
 *
 * 12×7 像素网格，每帧是一张完整的 box-shadow 像素图：
 * 小纸杯在棉线上来回跳跃传递，棉线以像素虚线朝传递方向流动。
 * 颜色全部派生自 currentColor，可直接用 `text-string` 等类着色并自动适配明暗主题。
 * 像素尺寸由 `--pc-px`（默认 2px → 24×14px）控制，与原转圈尺寸接近。
 */

const GRID_W = 12;
const GRID_H = 7;
const STRING_ROW = GRID_H - 1;
const FRAME_MS = 85;

const INK = 'currentColor';
const MID = 'color-mix(in oklab, currentColor 55%, transparent)';
const FAINT = 'color-mix(in oklab, currentColor 32%, transparent)';

// '#' 杯身 / '+' 杯腰纸带 / '.' 透明
const CUP = ['#####', '.###.', '.+++.', '.###.'];
const CUP_SQUASH = ['#######', '.#+++#.', '..###..'];

type Frame = { x: number; lift: number; squash: boolean; dir: 1 | -1 };

function buildFrames(): Frame[] {
  const hop = (from: number, to: number, dir: 1 | -1): Frame[] => {
    const step = (to - from) / 5;
    const lifts = [1, 2, 2, 1, 0];
    return [
      { x: from, lift: 0, squash: true, dir },
      ...lifts.map((lift, i) => ({ x: Math.round(from + step * (i + 1)), lift, squash: false, dir })),
      { x: to, lift: 0, squash: true, dir },
      { x: to, lift: 0, squash: false, dir },
    ];
  };
  return [...hop(1, 6, 1), ...hop(6, 1, -1)];
}

function px(n: number): string {
  // 伪元素位于 (-1,-1)，所有像素整体偏移 +1，避免 (0,0) 被元素自身裁掉
  return `calc(var(--pc-px) * ${n + 1})`;
}

function shadow(x: number, y: number, color: string): string {
  return `${px(x)} ${px(y)} 0 0 ${color}`;
}

function frameShadow(frame: Frame, index: number): string {
  const out: string[] = [];

  // 棉线：像素虚线朝传递方向流动
  for (let x = 0; x < GRID_W; x += 1) {
    const phase = (((x - frame.dir * index) % 3) + 3) % 3;
    if (phase !== 0) out.push(shadow(x, STRING_ROW, FAINT));
  }

  const sprite = frame.squash ? CUP_SQUASH : CUP;
  const originX = frame.squash ? frame.x - 1 : frame.x;
  const originY = STRING_ROW - sprite.length - frame.lift;
  sprite.forEach((row, ry) => {
    Array.from(row).forEach((cell, rx) => {
      if (cell === '.') return;
      const gx = originX + rx;
      const gy = originY + ry;
      if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return;
      out.push(shadow(gx, gy, cell === '+' ? MID : INK));
    });
  });

  return out.join(',');
}

function buildCss(): string {
  const frames = buildFrames();
  const shadows = frames.map(frameShadow);
  const total = frames.length;
  const keyframes = shadows
    .map((s, i) => `${((i / total) * 100).toFixed(3)}%{box-shadow:${s}}`)
    .concat(`100%{box-shadow:${shadows[0]}}`)
    .join('');
  const duration = total * FRAME_MS;

  return `
.pc-pixel-cup{--pc-px:2px;position:relative;display:inline-block;flex:none;vertical-align:middle;inline-size:calc(var(--pc-px) * ${GRID_W});block-size:calc(var(--pc-px) * ${GRID_H});}
.pc-pixel-cup::before{content:"";position:absolute;inset-inline-start:calc(var(--pc-px) * -1);inset-block-start:calc(var(--pc-px) * -1);inline-size:var(--pc-px);block-size:var(--pc-px);box-shadow:${shadows[0]};animation:pc-pixel-cup ${duration}ms steps(1,end) infinite;}
@media (prefers-reduced-motion: reduce){.pc-pixel-cup::before{animation-duration:${duration * 5}ms;}}
@media (forced-colors: active){.pc-pixel-cup{forced-color-adjust:none;color:CanvasText;}}
@keyframes pc-pixel-cup{${keyframes}}
`;
}

const STYLE_ID = 'pc-pixel-cup-style';

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildCss();
  document.head.appendChild(style);
}

ensureStyles();

interface PixelCupLoaderProps {
  className?: string;
  /** 提供时作为独立的 progressbar 播报；省略时视为装饰（旁边已有文字状态）。 */
  label?: string;
}

export function PixelCupLoader({ className, label }: PixelCupLoaderProps) {
  React.useLayoutEffect(() => {
    ensureStyles();
  }, []);

  return label ? (
    <span role="progressbar" aria-label={label} className={cn('pc-pixel-cup', className)} />
  ) : (
    <span aria-hidden="true" className={cn('pc-pixel-cup', className)} />
  );
}
