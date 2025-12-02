import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.massa.gossip',
  appName: 'Gossip',
  webDir: 'dist',
  ios: {
    scheme: 'Gossip',
    contentInset: 'automatic',
    backgroundColor: '#000000',
    scrollEnabled: true,
    allowsLinkPreview: false,
  },
  plugins: {
    StatusBar: {
      // Style will be set dynamically by theme-provider based on light/dark mode
      // This is just a fallback default (light mode: dark icons on light background)
      style: 'dark',
      overlaysWebView: false,
    },
    EdgeToEdge: {
      // Background color is set dynamically via theme-provider based on light/dark mode
      // This is just a fallback default (light mode background)
      // Actual color updates happen in theme-provider.tsx when theme changes
      backgroundColor: '#f8f9fa', // Light mode: #f8f9fa, Dark mode: #18181b
    },
    LocalNotifications: {
      // Use the app launcher icon for status bar notifications on Android.
      // The value is the drawable/mipmap resource name without extension.
      smallIcon: 'ic_launcher',
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
