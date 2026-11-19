import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let supportsSiblingIndex: boolean | undefined;

export function applySiblingIndexFallback(container: HTMLElement | null): void {
  if (!container || typeof window === 'undefined') return;
  if (supportsSiblingIndex === undefined) {
    supportsSiblingIndex = Boolean(
      window.CSS?.supports?.('animation-delay: calc(sibling-index() * 0.1s)')
    );
  }
  if (supportsSiblingIndex) return;
  Array.from(container.children).forEach((child, index) => {
    if (child instanceof HTMLElement) {
      child.style.setProperty('--sibling-index', String(index + 1));
    }
  });
}
