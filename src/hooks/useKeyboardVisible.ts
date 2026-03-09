import { useState, useEffect, useRef } from 'react';
import type React from 'react';
import { Keyboard, KeyboardInfo } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';

// ---------------------------------------------------------------------------
// Module-level singleton — tracks keyboard height independently of any React
// component lifecycle.  This lets code that mounts *after* the keyboard is
// already open read the correct height via `getKeyboardHeight()`.
// ---------------------------------------------------------------------------
let _kbHeight = 0;
let _kbListenersReady = false;

function setupKeyboardTracking() {
  if (_kbListenersReady || !Capacitor.isNativePlatform()) return;
  _kbListenersReady = true;
  Keyboard.addListener('keyboardWillShow', (info: KeyboardInfo) => {
    _kbHeight = info.keyboardHeight;
  });
  Keyboard.addListener('keyboardWillHide', () => {
    _kbHeight = 0;
  });
}

/**
 * Returns the current keyboard height (px) without needing a React hook.
 * Safe to call from event handlers, callbacks, or components that mounted
 * after the keyboard was already open.
 */
export function getKeyboardHeight(): number {
  setupKeyboardTracking();
  return _kbHeight;
}

/**
 * Hook to detect if the virtual keyboard  * Uses the @capacitor/keyboard plugin for native keyboard events.
 * Uses 'keyboardWillShow/Hide' events for instant response (before animation).
 * Falls back to visualViewport API for web.
 *
 * `isKeyboardVisibleRef` is a ref updated synchronously from native events,
 * suitable for use inside event handlers (e.g. onBlur) where React state
 * may already be stale.
 *
 * @see https://capacitorjs.com/docs/apis/keyboard
 */
export function useKeyboardVisible(): {
  isKeyboardVisible: boolean;
  isKeyboardVisibleRef: React.RefObject<boolean>;
  keyboardHeight: number;
  keyboardHeightRef: React.RefObject<number>;
} {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const isKeyboardVisibleRef = useRef(false);
  const keyboardHeightRef = useRef(0);

  useEffect(() => {
    // Use Capacitor Keyboard plugin on native platforms
    if (Capacitor.isNativePlatform()) {
      // Use 'Will' events for instant response (fires before animation)
      // Note: On Android, Will and Did events fire almost simultaneously
      const showListener = Keyboard.addListener(
        'keyboardWillShow',
        (info: KeyboardInfo) => {
          isKeyboardVisibleRef.current = true;
          keyboardHeightRef.current = info.keyboardHeight;
          setIsKeyboardVisible(true);
          setKeyboardHeight(info.keyboardHeight);
        }
      );

      const hideListener = Keyboard.addListener('keyboardWillHide', () => {
        isKeyboardVisibleRef.current = false;
        keyboardHeightRef.current = 0;
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
      isKeyboardVisibleRef.current = isVisible;
      keyboardHeightRef.current = isVisible ? heightDiff : 0;
      setIsKeyboardVisible(isVisible);
      setKeyboardHeight(isVisible ? heightDiff : 0);
    };

    handleResize();
    visualViewport.addEventListener('resize', handleResize);

    return () => {
      visualViewport.removeEventListener('resize', handleResize);
    };
  }, []);

  return {
    isKeyboardVisible,
    isKeyboardVisibleRef,
    keyboardHeight,
    keyboardHeightRef,
  };
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

  // useIOSKeyboardWorkaround already handles iOS platform check
  // If not iOS, active will be false and keyboardHeight will be 0
  if (!active) {
    return {};
  }

  return {
    // Calculate height only accounting for keyboard
    // Safe areas are handled by padding (pt-safe-t, pb-safe-b) in the component
    height: `calc(100dvh - ${keyboardHeight}px)`,
    transition: 'height 300ms ease-out',
  };
}
