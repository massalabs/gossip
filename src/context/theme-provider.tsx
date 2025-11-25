'use client';

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';
import { StatusBar, Style } from '@capacitor/status-bar';
import { STORAGE_KEYS, StorageKey } from '../utils/localStorage';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { Theme, ThemeContext } from './theme-context';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: StorageKey; // Uses STORAGE_KEYS.THEME by default
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = STORAGE_KEYS.THEME,
}: ThemeProviderProps) {
  const [theme, setTheme] = useLocalStorage<Theme>(storageKey, defaultTheme);

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return theme;
  });

  useEffect(() => {
    const root = document.documentElement;

    const updateTheme = () => {
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : theme;

      setResolvedTheme(resolved);

      if (resolved === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }

      // Update status bar and edge-to-edge for native platforms
      if (Capacitor.isNativePlatform()) {
        const backgroundColor = resolved === 'dark' ? '#18181b' : '#f8f9fa';
        void StatusBar.setStyle({
          style: resolved === 'dark' ? Style.Dark : Style.Light,
        });

        void StatusBar.setBackgroundColor({ color: backgroundColor });
        void EdgeToEdge.setBackgroundColor({ color: backgroundColor }).catch(
          err => {
            console.warn('Failed to set EdgeToEdge background color:', err);
          }
        );
      }
    };

    updateTheme();

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => updateTheme();
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
