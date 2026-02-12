import { Capacitor } from '@capacitor/core';
import { SafeArea } from 'capacitor-plugin-safe-area';

/**
 * Initialize safe area insets using capacitor-plugin-safe-area.
 * This plugin injects CSS variables --safe-area-inset-* that work on both iOS and Android.
 */
export async function initSafeArea(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { insets } = await SafeArea.getSafeAreaInsets();
    const root = document.documentElement;

    // Set CSS variables for safe areas
    root.style.setProperty('--sat', `${insets.top}px`);
    root.style.setProperty('--sab', `${insets.bottom}px`);
    root.style.setProperty('--sal', `${insets.left}px`);
    root.style.setProperty('--sar', `${insets.right}px`);

    console.log('[SafeArea] Insets applied:', insets);
  } catch (error) {
    console.error('[SafeArea] Failed to get insets:', error);
  }
}
