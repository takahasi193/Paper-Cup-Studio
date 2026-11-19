import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useMediaQuery } from './useMediaQuery.js';

export type ColorSchemePreference = 'system' | 'light' | 'dark';
export type ResolvedColorScheme = 'light' | 'dark';

export const COLOR_SCHEME_STORAGE_KEY = 'papercup:color-scheme';
const LEGACY_THEME_STORAGE_KEY = 'papercup:theme';

function readStoredPreference(): ColorSchemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    // Ignore storage errors
  }
  return 'system';
}

function applySchemeMeta(preference: ColorSchemePreference): void {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (!meta) return;
  meta.content = preference === 'system' ? 'light dark' : preference;
}

type ViewTransitionDoc = Document & {
  startViewTransition?: (updateCallback: () => void) => { finished: Promise<void> };
};

export function useColorScheme() {
  const [preference, setPreferenceState] = useState<ColorSchemePreference>(readStoredPreference);
  const osDark = useMediaQuery('(prefers-color-scheme: dark)');
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const systemScheme: ResolvedColorScheme = osDark ? 'dark' : 'light';
  const resolvedScheme: ResolvedColorScheme = preference === 'system' ? systemScheme : preference;

  useEffect(() => {
    applySchemeMeta(preference);
    try {
      window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }, [preference]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== COLOR_SCHEME_STORAGE_KEY) return;
      const next: ColorSchemePreference =
        e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'system';
      applySchemeMeta(next);
      setPreferenceState(next);
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setPreference = useCallback(
    (next: ColorSchemePreference, origin?: { x: number; y: number }) => {
      try {
        if (next === 'system') {
          window.localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
        } else {
          window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, next);
        }
      } catch {
        // Ignore storage persistence errors while applying in memory
      }

      const applyUpdate = () => {
        applySchemeMeta(next);
        setPreferenceState(next);
      };

      const doc = document as ViewTransitionDoc;
      if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion) {
        const root = document.documentElement;
        const x = origin?.x ?? window.innerWidth / 2;
        const y = origin?.y ?? window.innerHeight / 2;
        const radius = Math.hypot(
          Math.max(x, window.innerWidth - x),
          Math.max(y, window.innerHeight - y)
        );
        root.style.setProperty('--vt-x', `${Math.round(x)}px`);
        root.style.setProperty('--vt-y', `${Math.round(y)}px`);
        root.style.setProperty('--vt-r', `${Math.ceil(radius)}px`);
        root.classList.add('pc-vt-radial');

        const vt = doc.startViewTransition(() => {
          flushSync(applyUpdate);
        });
        vt.finished.finally(() => {
          root.classList.remove('pc-vt-radial');
        });
      } else {
        applyUpdate();
      }
    },
    [prefersReducedMotion]
  );

  const toggleQuickScheme = useCallback(
    (origin?: { x: number; y: number }) => {
      const target: ResolvedColorScheme = resolvedScheme === 'dark' ? 'light' : 'dark';
      if (target === systemScheme) {
        setPreference('system', origin);
      } else {
        setPreference(target, origin);
      }
    },
    [resolvedScheme, setPreference, systemScheme]
  );

  return {
    preference,
    setPreference,
    toggleQuickScheme,
    systemScheme,
    resolvedScheme,
  };
}
