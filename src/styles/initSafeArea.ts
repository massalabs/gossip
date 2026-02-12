import { Capacitor } from '@capacitor/core';
import { SafeArea } from 'capacitor-plugin-safe-area';

function applyInsets(insets: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}): void {
  const root = document.documentElement;
  root.style.setProperty('--sat', `${insets.top}px`);
  root.style.setProperty('--sab', `${insets.bottom}px`);
  root.style.setProperty('--sal', `${insets.left}px`);
  root.style.setProperty('--sar', `${insets.right}px`);
}

/**
 * Initialize safe area insets using capacitor-plugin-safe-area.
 * Sets CSS variables --sat/--sab/--sal/--sar and listens for
 * orientation changes so they stay up to date.
 */
export async function initSafeArea(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { insets } = await SafeArea.getSafeAreaInsets();
    applyInsets(insets);

    // Update insets on orientation / layout changes
    SafeArea.addListener('safeAreaChanged', ({ insets }) => {
      applyInsets(insets);
    });
  } catch (error) {
    console.error('[SafeArea] Failed to get insets:', error);
  }
}
