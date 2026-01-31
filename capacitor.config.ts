import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

// Enable HTTPS live reload: LIVE_RELOAD=true DEV_HOST=192.168.x.x npx cap run ios
const devServer =
  process.env.LIVE_RELOAD === 'true'
    ? { url: `https://${process.env.DEV_HOST || 'localhost'}:5173` }
    : undefined;

const config: CapacitorConfig = {
  appId: 'net.massa.gossip',
  appName: 'Gossip',
  webDir: 'dist',
  server: devServer,
  ios: {
    scheme: 'Gossip',
    contentInset: 'automatic',
    backgroundColor: '#000000',
    scrollEnabled: false, // Disable webview scrolling - we handle scrolling in app content
    allowsLinkPreview: false,
  },
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
