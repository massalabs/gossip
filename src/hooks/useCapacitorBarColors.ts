import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';
import { useAppStore } from '../stores/appStore';

/**
 * Hook to sync Capacitor status bar and navigation bar colors with app theme and scroll state
 * - Status bar matches header color (changes based on scroll)
 * - Navigation bar (Android) matches bottom navigation color
 */
export const useCapacitorBarColors = () => {
  const headerIsScrolled = useAppStore(s => s.headerIsScrolled);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // Listen for theme changes by observing class changes on documentElement
    const updateColors = () => {
      // Get CSS variable value (handles var(--variable-name) syntax)
      const getCSSVariableValue = (varName: string): string => {
        const root = document.documentElement;
        // Remove 'var(' and ')' if present, extract variable name
        const cleanVarName = varName.replace(/var\(|\)/g, '').trim();
        const value = getComputedStyle(root)
          .getPropertyValue(cleanVarName)
          .trim();
        return value || '#ffffff';
      };

      // Try to get the actual computed background color from the header element
      // This ensures we match exactly what's rendered
      const getHeaderBackgroundColor = (): string => {
        // Find the header element (HeaderWrapper)
        const header = document.querySelector(
          '[class*="header-bg-transition"]'
        ) as HTMLElement;
        if (header) {
          const computedStyle = window.getComputedStyle(header);
          const bgColor = computedStyle.backgroundColor;
          // Convert rgb/rgba to hex if needed
          if (
            bgColor &&
            bgColor !== 'rgba(0, 0, 0, 0)' &&
            bgColor !== 'transparent'
          ) {
            return rgbToHex(bgColor);
          }
        }
        // Fallback to CSS variable
        return headerIsScrolled
          ? getCSSVariableValue('var(--header-scrolled)')
          : getCSSVariableValue('var(--card)');
      };

      // Convert rgb/rgba to hex
      const rgbToHex = (rgb: string): string => {
        // Handle rgb(r, g, b) or rgba(r, g, b, a)
        const match = rgb.match(/\d+/g);
        if (match && match.length >= 3) {
          const r = parseInt(match[0], 10);
          const g = parseInt(match[1], 10);
          const b = parseInt(match[2], 10);
          return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
        }
        return rgb;
      };

      // Determine if dark mode is active
      const isDark = document.documentElement.classList.contains('dark');

      // Status bar color: get actual computed color from header element
      const statusBarColor = getHeaderBackgroundColor();

      // Navigation bar color: always matches bottom navigation (muted in light, card in dark)
      const navBarColor = isDark
        ? getCSSVariableValue('var(--card)') // Less dark in dark mode
        : getCSSVariableValue('var(--muted)'); // Grey in light mode

      // Set status bar style (light icons on dark bg, dark icons on light bg)
      const statusBarStyle = isDark ? Style.Dark : Style.Light;

      // Update status bar
      void StatusBar.setStyle({ style: statusBarStyle });
      void StatusBar.setBackgroundColor({ color: statusBarColor });

      // Update navigation bar (Android only via EdgeToEdge)
      if (Capacitor.getPlatform() === 'android') {
        void EdgeToEdge.setBackgroundColor({ color: navBarColor }).catch(
          err => {
            console.warn('Failed to set EdgeToEdge background color:', err);
          }
        );
      }
    };

    // Initial update
    updateColors();

    // Listen for theme class changes
    const observer = new MutationObserver(() => {
      updateColors();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      observer.disconnect();
    };
  }, [headerIsScrolled]);
};
