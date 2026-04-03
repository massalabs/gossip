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
    // We manage keyboard offset manually via --keyboard-offset.
    // On some Android devices, the OS also resizes the WebView despite adjustNothing.
    // We detect this and only apply the offset the OS didn't already handle.

    Keyboard.addListener('keyboardWillShow', (info: KeyboardInfo) => {
      updateState(true, info.keyboardHeight);
      setCssVar('--keyboard-height', `${info.keyboardHeight}px`);

      // Wait a frame so the OS resize (if any) is applied before measuring
      requestAnimationFrame(() => {
        const { viewportHeight } = useKeyboardStore.getState();
        const osShrink = viewportHeight - window.innerHeight;
        const offset = Math.max(0, info.keyboardHeight - osShrink);
        setCssVar('--keyboard-offset', `${offset}px`);
      });
    });

    Keyboard.addListener('keyboardWillHide', () => {
      updateState(false, 0);
      setCssVar('--keyboard-height', '0px');
      setCssVar('--keyboard-offset', '0px');
    });

    window.addEventListener('resize', () => {
      const h = window.innerHeight;
      const state = useKeyboardStore.getState();
      if (state.isVisible) {
        // Samsung: OS resized the WebView — update available height directly
        setCssVar('--available-height', `${h}px`);
      } else {
        // Keyboard closed — update the baseline viewport height
        useKeyboardStore.setState({ viewportHeight: h });
        setCssVar('--viewport-height', `${h}px`);
        setCssVar('--available-height', `${h}px`);
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
