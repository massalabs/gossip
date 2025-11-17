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
      style: 'dark',
      overlaysWebView: false,
    },
    EdgeToEdge: {
      // Background color is set dynamically via theme-provider based on light/dark mode
      // This is just a fallback default (light mode background)
      // Actual color updates happen in theme-provider.tsx when theme changes
      backgroundColor: '#f8f9fa', // Light mode: #f8f9fa, Dark mode: #18181b
    },
  },
};

export default config;
