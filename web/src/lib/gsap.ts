import * as React from 'react';
import gsap from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';

gsap.registerPlugin(DrawSVGPlugin, ScrollToPlugin);

export { gsap, DrawSVGPlugin, ScrollToPlugin };

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface UseGsapDetailsOptions {
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * GSAP-powered smooth height & chevron disclosure for native `<details>` elements.
 * Works identically across Chrome, Firefox, and Safari without `interpolate-size`.
 */
export function useGsapDetails(options?: UseGsapDetailsOptions) {
  const detailsRef = React.useRef<HTMLDetailsElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const chevronRef = React.useRef<SVGSVGElement>(null);
  const isClosingRef = React.useRef(false);
  const prevControlledRef = React.useRef(options?.controlledOpen);

  const animateOpen = React.useCallback(() => {
    const body = bodyRef.current;
    const chevron = chevronRef.current;
    const reduced = prefersReducedMotion();

    if (chevron) {
      gsap.to(chevron, {
        rotate: 90,
        duration: reduced ? 0.08 : 0.2,
        ease: 'power2.out',
        overwrite: 'auto',
      });
    }

    if (!body) return;
    gsap.killTweensOf(body);
    const targetHeight = body.scrollHeight;
    if (reduced) {
      gsap.fromTo(
        body,
        { opacity: 0 },
        { opacity: 1, duration: 0.1, clearProps: 'opacity,height,overflow' }
      );
      return;
    }

    gsap.fromTo(
      body,
      { height: 0, opacity: 0, overflow: 'hidden' },
      {
        height: targetHeight,
        opacity: 1,
        duration: 0.26,
        ease: 'power2.out',
        clearProps: 'height,opacity,overflow',
      }
    );
  }, []);

  const animateClose = React.useCallback(() => {
    const details = detailsRef.current;
    const body = bodyRef.current;
    const chevron = chevronRef.current;
    if (!details || !details.open) return;

    const reduced = prefersReducedMotion();
    isClosingRef.current = true;

    if (chevron) {
      gsap.to(chevron, {
        rotate: 0,
        duration: reduced ? 0.08 : 0.18,
        ease: 'power2.inOut',
        overwrite: 'auto',
      });
    }

    if (!body) {
      isClosingRef.current = false;
      details.open = false;
      options?.onOpenChange?.(false);
      return;
    }

    gsap.killTweensOf(body);
    const currentHeight = body.offsetHeight;

    gsap.fromTo(
      body,
      { height: currentHeight, overflow: 'hidden' },
      {
        height: reduced ? currentHeight : 0,
        opacity: 0,
        duration: reduced ? 0.08 : 0.2,
        ease: 'power2.in',
        onComplete: () => {
          isClosingRef.current = false;
          details.open = false;
          gsap.set(body, { clearProps: 'height,opacity,overflow' });
          options?.onOpenChange?.(false);
        },
      }
    );
  }, [options]);

  // Sync controlled `open` changes (e.g. ThinkingBlock auto-open/collapse on stream)
  React.useEffect(() => {
    if (options?.controlledOpen === undefined) return;
    const details = detailsRef.current;
    if (!details) return;

    const prev = prevControlledRef.current;
    prevControlledRef.current = options.controlledOpen;
    if (prev === options.controlledOpen) return;

    if (options.controlledOpen && !details.open) {
      details.open = true;
      animateOpen();
    } else if (!options.controlledOpen && details.open) {
      animateClose();
    }
  }, [animateClose, animateOpen, options?.controlledOpen]);

  // Sync initial chevron angle if initially open
  React.useLayoutEffect(() => {
    const details = detailsRef.current;
    const chevron = chevronRef.current;
    if (details?.open && chevron) {
      gsap.set(chevron, { rotate: 90 });
    }
  }, []);

  const handleSummaryClick = React.useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const details = detailsRef.current;
      if (!details) return;

      if (isClosingRef.current) {
        // Re-opening mid-close
        e.preventDefault();
        isClosingRef.current = false;
        gsap.killTweensOf(bodyRef.current);
        details.open = true;
        animateOpen();
        options?.onOpenChange?.(true);
        return;
      }

      if (details.open) {
        e.preventDefault();
        animateClose();
      }
    },
    [animateClose, animateOpen, options]
  );

  const handleToggle = React.useCallback(() => {
    const details = detailsRef.current;
    if (!details || isClosingRef.current) return;
    if (details.open) {
      animateOpen();
      options?.onOpenChange?.(true);
    }
  }, [animateOpen, options]);

  return {
    detailsRef,
    bodyRef,
    chevronRef,
    handleSummaryClick,
    handleToggle,
  };
}
