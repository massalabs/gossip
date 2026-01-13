import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { PrivacyScreen } from '@capacitor-community/privacy-screen';
import { useAppStore } from '../stores/appStore';

/**
 * Hook to manage native screenshot protection based on debug settings.
 *
 * When `disableNativeScreenshot` is false (default), screenshot protection is enabled.
 * When `disableNativeScreenshot` is true, screenshot protection is disabled.
 *
 * This only applies to native platforms (Android/iOS).
 */
export const useScreenshotProtection = () => {
  const disableNativeScreenshot = useAppStore(s => s.disableNativeScreenshot);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    if (!isNative) return;

    const updateScreenshotProtection = async () => {
      try {
        if (disableNativeScreenshot) {
          // User wants screenshots enabled (protection disabled)
          await PrivacyScreen.disable();
        } else {
          // User wants screenshots disabled (protection enabled)
          await PrivacyScreen.enable();
        }
      } catch (error) {
        console.warn('Failed to update screenshot protection:', error);
      }
    };

    void updateScreenshotProtection();
  }, [disableNativeScreenshot, isNative]);
};
