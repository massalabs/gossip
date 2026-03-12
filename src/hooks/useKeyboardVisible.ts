import { useState, useEffect, useRef } from 'react';
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

  // Lock viewport height before keyboard opens.
  // On Samsung/iOS the OS shrinks the WebView when keyboard opens, which would
  // shrink 100dvh and cause ghost gap (double-offset: OS resize + our transform).
  // By locking to a pixel value, the container stays full-height and only the
  // CSS transform moves content up.
  document.documentElement.style.setProperty(
    '--viewport-height',
    `${window.innerHeight}px`
  );

  // Update baseline when keyboard is closed (handles orientation changes)
  window.addEventListener('resize', () => {
    if (_kbHeight === 0) {
      document.documentElement.style.setProperty(
        '--viewport-height',
        `${window.innerHeight}px`
      );
    }
  });

  Keyboard.addListener('keyboardWillShow', (info: KeyboardInfo) => {
    _kbHeight = info.keyboardHeight;
    document.documentElement.style.setProperty(
      '--keyboard-height',
      `${info.keyboardHeight}px`
    );
  });

  Keyboard.addListener('keyboardWillHide', () => {
    _kbHeight = 0;
    document.documentElement.style.setProperty('--keyboard-height', '0px');
  });
}

// Initialize tracking immediately so the CSS variable is set
// before any component mounts.
setupKeyboardTracking();

/**
 * Returns the current keyboard height (px) without needing a React hook.
 * Safe to call from event handlers, callbacks, or components that mounted
 * after the keyboard was already open.
 */
export function getKeyboardHeight(): number {
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
