import { create } from 'zustand';
import { Keyboard, KeyboardInfo } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';

interface KeyboardState {
  isVisible: boolean;
  height: number;
  viewportHeight: number;
}

const KEYBOARD_THRESHOLD = 150;

export const useKeyboardStore = create<KeyboardState>(() => ({
  isVisible: false,
  height: 0,
  viewportHeight: window.innerHeight,
}));

function setCssVar(name: string, value: string) {
  document.documentElement.style.setProperty(name, value);
}

function updateState(isVisible: boolean, height: number) {
  useKeyboardStore.setState({ isVisible, height });
}

function initKeyboardTracking() {
  const vp = window.innerHeight;
  useKeyboardStore.setState({ viewportHeight: vp });
  setCssVar('--viewport-height', `${vp}px`);
  setCssVar('--keyboard-height', '0px');
  setCssVar('--keyboard-offset', '0px');

  const platform = Capacitor.getPlatform();
  setCssVar(
    '--keyboard-transition-duration',
    platform === 'android' ? '0.35s' : '0.25s'
  );

  if (Capacitor.isNativePlatform()) {
    if (platform === 'android') {
      // Android: `resize` config is iOS-only, so the OS always resizes the
      // WebView when the keyboard opens. We let --viewport-height follow the
      // OS resize and keep --keyboard-offset at 0 (no transform needed).
      window.addEventListener('resize', () => {
        const h = window.innerHeight;
        useKeyboardStore.setState({ viewportHeight: h });
        setCssVar('--viewport-height', `${h}px`);
      });

      Keyboard.addListener('keyboardWillShow', (info: KeyboardInfo) => {
        updateState(true, info.keyboardHeight);
        setCssVar('--keyboard-height', `${info.keyboardHeight}px`);
      });

      Keyboard.addListener('keyboardWillHide', () => {
        updateState(false, 0);
        setCssVar('--keyboard-height', '0px');
      });
    } else {
      // iOS: KeyboardResize.None prevents OS resize, so we lock
      // --viewport-height and use --keyboard-offset for a GPU transform.
      window.addEventListener('resize', () => {
        if (useKeyboardStore.getState().height === 0) {
          const h = window.innerHeight;
          useKeyboardStore.setState({ viewportHeight: h });
          setCssVar('--viewport-height', `${h}px`);
        }
      });

      Keyboard.addListener('keyboardWillShow', (info: KeyboardInfo) => {
        updateState(true, info.keyboardHeight);
        setCssVar('--keyboard-height', `${info.keyboardHeight}px`);
        setCssVar('--keyboard-offset', `${info.keyboardHeight}px`);
      });

      Keyboard.addListener('keyboardWillHide', () => {
        updateState(false, 0);
        setCssVar('--keyboard-height', '0px');
        setCssVar('--keyboard-offset', '0px');
      });
    }

    return;
  }

  // Web fallback: visualViewport API
  const visualViewport = window.visualViewport;
  if (!visualViewport) return;

  const handleResize = () => {
    const diff = window.innerHeight - visualViewport.height;
    const visible = diff > KEYBOARD_THRESHOLD;
    updateState(visible, visible ? diff : 0);
    setCssVar('--keyboard-height', visible ? `${diff}px` : '0px');
  };

  handleResize();
  visualViewport.addEventListener('resize', handleResize);
}

initKeyboardTracking();
