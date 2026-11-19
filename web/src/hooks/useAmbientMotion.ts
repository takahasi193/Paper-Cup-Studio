import { useCallback, useEffect, useState } from 'react';
import { useMediaQuery } from './useMediaQuery.js';

export const AMBIENT_MOTION_STORAGE_KEY = 'papercup:ambient-motion';

function readInitialAmbient(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(AMBIENT_MOTION_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function applyAmbientToDocument(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  if (enabled) {
    delete document.documentElement.dataset.ambient;
  } else {
    document.documentElement.dataset.ambient = 'off';
  }
}

export function useAmbientMotion() {
  const [ambientEnabled, setAmbientState] = useState<boolean>(readInitialAmbient);
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useEffect(() => {
    applyAmbientToDocument(ambientEnabled);
  }, [ambientEnabled]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== AMBIENT_MOTION_STORAGE_KEY) return;
      const next = e.newValue !== 'off';
      applyAmbientToDocument(next);
      setAmbientState(next);
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setAmbientEnabled = useCallback((enabled: boolean) => {
    try {
      if (enabled) {
        window.localStorage.removeItem(AMBIENT_MOTION_STORAGE_KEY);
      } else {
        window.localStorage.setItem(AMBIENT_MOTION_STORAGE_KEY, 'off');
      }
    } catch {
      // Ignore storage persistence errors
    }
    applyAmbientToDocument(enabled);
    setAmbientState(enabled);
  }, []);

  return {
    ambientEnabled,
    setAmbientEnabled,
    prefersReducedMotion,
    motionAllowed: ambientEnabled && !prefersReducedMotion,
  };
}
