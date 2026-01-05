import { useState, useEffect } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';

/**
 * Hook to detect if the virtual keyboard  * Uses the @capacitor/keyboard plugin for native keyboard events.
 * Uses 'keyboardWillShow/Hide' events for instant response (before animation).
 * Falls back to visualViewport API for web.
 *
 * @see https://capacitorjs.com/docs/apis/keyboard
 */
export function useKeyboardVisible(): boolean {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    // Use Capacitor Keyboard plugin on native platforms
    if (Capacitor.isNativePlatform()) {
      // Use 'Will' events for instant response (fires before animation)
      // Note: On Android, Will and Did events fire almost simultaneously
      const showListener = Keyboard.addListener('keyboardWillShow', () => {
        setIsKeyboardVisible(true);
      });

      const hideListener = Keyboard.addListener('keyboardWillHide', () => {
        setIsKeyboardVisible(false);
      });

      return () => {
        showListener.then(handle => handle.remove());
        hideListener.then(handle => handle.remove());
      };
    }

    // Fallback to visualViewport API for web
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return;
    }

    const KEYBOARD_THRESHOLD = 150;

    const handleResize = () => {
      const heightDiff = window.innerHeight - visualViewport.height;
      setIsKeyboardVisible(heightDiff > KEYBOARD_THRESHOLD);
    };

    handleResize();
    visualViewport.addEventListener('resize', handleResize);

    return () => {
      visualViewport.removeEventListener('resize', handleResize);
    };
  }, []);

  return isKeyboardVisible;
}
