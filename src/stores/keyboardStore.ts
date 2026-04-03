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
  setCssVar('--available-height', `${vp}px`);
  setCssVar('--keyboard-height', '0px');

  const platform = Capacitor.getPlatform();
  setCssVar(
    '--keyboard-transition-duration',
    platform === 'android' ? '0.35s' : '0.25s'
  );

  if (Capacitor.isNativePlatform()) {
    // Infallible strategy: always write --available-height directly.
    // - keyboardWillShow: set available = viewportHeight - keyboardHeight
    // - resize (if OS also shrinks WebView): overwrite with window.innerHeight
    // Whoever fires last wins — both compute the same correct value.

    Keyboard.addListener('keyboardWillShow', (info: KeyboardInfo) => {
      updateState(true, info.keyboardHeight);
      setCssVar('--keyboard-height', `${info.keyboardHeight}px`);
      const { viewportHeight } = useKeyboardStore.getState();
      setCssVar(
        '--available-height',
        `${viewportHeight - info.keyboardHeight}px`
      );
    });

    Keyboard.addListener('keyboardWillHide', () => {
      updateState(false, 0);
      setCssVar('--keyboard-height', '0px');
      const { viewportHeight } = useKeyboardStore.getState();
      setCssVar('--available-height', `${viewportHeight}px`);
    });

    window.addEventListener('resize', () => {
      const h = window.innerHeight;
      // Always trust the actual viewport height
      setCssVar('--available-height', `${h}px`);
      if (!useKeyboardStore.getState().isVisible) {
        useKeyboardStore.setState({ viewportHeight: h });
      }
    });

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
