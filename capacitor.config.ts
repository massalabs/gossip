import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'net.massa.gossip',
  appName: 'Gossip',
  webDir: 'dist',
  ios: {
    scheme: 'Gossip',
    contentInset: 'automatic',
    backgroundColor: '#000000',
    scrollEnabled: false, // Disable webview scrolling - we handle scrolling in app content
    allowsLinkPreview: false,
  },
  // Live reload: set DEV_SERVER_URL env var to enable (see scripts/dev-android.sh)
  ...(process.env.DEV_SERVER_URL
    ? { server: { url: process.env.DEV_SERVER_URL, cleartext: true } }
    : {}),
  plugins: {
    // Keyboard plugin configuration
    Keyboard: {
      resize: KeyboardResize.Body,
    },
    LocalNotifications: {
      smallIcon: 'ic_notification',
      iconColor: '#488AFF',
    },
    BackgroundRunner: {
      label: 'net.massa.gossip.background.sync',
      src: 'runners/background-sync.js',
      event: 'backgroundSync',
      repeat: true,
      interval: 15,
      autoStart: true,
    },
  },
};

export default config;
