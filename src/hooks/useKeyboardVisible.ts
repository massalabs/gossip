import { useState, useEffect } from 'react';
import type React from 'react';
import { Keyboard, KeyboardInfo } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';

/**
 * Hook to detect if the virtual keyboard  * Uses the @capacitor/keyboard plugin for native keyboard events.
 * Uses 'keyboardWillShow/Hide' events for instant response (before animation).
 * Falls back to visualViewport API for web.
 *
 * @see https://capacitorjs.com/docs/apis/keyboard
 */
export function useKeyboardVisible(): {
  isKeyboardVisible: boolean;
  keyboardHeight: number;
} {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    // Use Capacitor Keyboard plugin on native platforms
    if (Capacitor.isNativePlatform()) {
      // Use 'Will' events for instant response (fires before animation)
      // Note: On Android, Will and Did events fire almost simultaneously
      const showListener = Keyboard.addListener(
        'keyboardWillShow',
        async (info: KeyboardInfo) => {
          setIsKeyboardVisible(true);
          console.log('keyboardWillShow', info.keyboardHeight);
          setKeyboardHeight(info.keyboardHeight);
        }
      );

      const hideListener = Keyboard.addListener('keyboardWillHide', () => {
        setIsKeyboardVisible(false);
        setKeyboardHeight(0);
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
      const isVisible = heightDiff > KEYBOARD_THRESHOLD;
      setIsKeyboardVisible(isVisible);
      setKeyboardHeight(isVisible ? heightDiff : 0);
    };

    handleResize();
    visualViewport.addEventListener('resize', handleResize);

    return () => {
      visualViewport.removeEventListener('resize', handleResize);
    };
  }, []);

  return { isKeyboardVisible, keyboardHeight };
}

/**
 * iOS-specific keyboard layout workaround helper.
 *
 * Returns an object with:
 * - active: true only on iOS native when the keyboard is visible
 * - keyboardHeight: the height of the keyboard in pixels
 *
 * Use this to apply layout workarounds (e.g. fixed heights, positioning) to avoid
 * slow/late keyboard resize issues in the iOS WebView.
 *
 * See: https://github.com/ionic-team/capacitor-keyboard/issues/19
 */
export function useIOSKeyboardWorkaround(): {
  active: boolean;
  keyboardHeight: number;
} {
  const { isKeyboardVisible, keyboardHeight } = useKeyboardVisible();
  const isIOS = Capacitor.getPlatform() === 'ios';
  return {
    active: isIOS && isKeyboardVisible,
    keyboardHeight: isIOS ? keyboardHeight : 0,
  };
}

/**
 * Hook that returns styles for fixed-positioned elements to handle iOS keyboard
 * and safe areas (Android/iOS notches, gesture areas).
 *
 * Use this hook on any element with `position: fixed` to automatically adjust
 * its height when the keyboard is visible on iOS, while respecting safe areas.
 *
 * @returns React.CSSProperties object with height adjustment accounting for
 *          keyboard and safe areas
 *
 * Example:
 * ```tsx
 * const styles = useFixedKeyboardStyles();
 * <div className="fixed inset-0 pt-safe-t pb-safe-b" style={styles}>
 *   {content}
 * </div>
 * ```
 */
export function useFixedKeyboardStyles(): React.CSSProperties {
  const { active, keyboardHeight } = useIOSKeyboardWorkaround();
  const isIOS = Capacitor.getPlatform() === 'ios';

  // Only apply keyboard workaround on iOS
  if (!isIOS) {
    return {};
  }

  return {
    // Calculate height only accounting for keyboard
    // Safe areas are handled by padding (pt-safe-t, pb-safe-b) in the component
    height: active ? `calc(100vh - ${keyboardHeight}px)` : '100vh',
    transition: 'height 300ms ease-out',
  };
}
