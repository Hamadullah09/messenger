'use client';

import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'storeline.theme';

function apply(theme: ThemeChoice): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/** The effective theme right now (resolving "system" through the OS preference). */
export function resolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** Per-device theme preference (localStorage), shared by the sidebar toggle and Settings. */
export function useTheme(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>('system');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') setTheme(saved);
    } catch {
      // Storage unavailable: follow the device setting.
    }
    const sync = (event: StorageEvent) => {
      if (event.key !== KEY) return;
      const next =
        event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'system';
      setTheme(next);
      apply(next);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const update = useCallback((next: ThemeChoice) => {
    setTheme(next);
    apply(next);
    try {
      if (next === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // Not remembered in private mode.
    }
  }, []);

  return [theme, update];
}
