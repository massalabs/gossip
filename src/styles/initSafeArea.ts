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
 * For PWA/browser when CSS env() is not supported:
 * estimate safe area insets from the visual viewport.
 */
function applyViewportFallback(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const compute = () => {
    const bottomInset = Math.max(
      0,
      window.innerHeight - vv.height - vv.offsetTop
    );
    const topInset = Math.max(0, vv.offsetTop);
    applyInsets({ top: topInset, bottom: bottomInset, left: 0, right: 0 });
  };

  compute();
  vv.addEventListener('resize', compute);
  vv.addEventListener('scroll', compute);
}

/**
 * Initialize safe area insets.
 *
 * - Native (Capacitor): uses capacitor-plugin-safe-area for accurate pixel values.
 * - PWA/browser modern: CSS env() handles it via base.css @supports rule.
 * - PWA/browser old Android: falls back to visualViewport-based detection.
 *
 * Sets CSS variables --sat/--sab/--sal/--sar and keeps them updated.
 */
export async function initSafeArea(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    // Modern browsers: CSS env() in base.css handles it via @supports.
    // Old browsers without env(): use JS fallback.
    if (!CSS.supports('padding-bottom', 'env(safe-area-inset-bottom, 0px)')) {
      applyViewportFallback();
    }
    return;
  }

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
