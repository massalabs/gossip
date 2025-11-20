import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.massa.gossip',
  appName: 'Gossip',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  ios: {
    scheme: 'Gossip',
    contentInset: 'automatic',
    backgroundColor: '#000000',
    scrollEnabled: true,
    allowsLinkPreview: false,
    // Universal Links - configure in Xcode entitlements file
    // Add: applinks:echodev.build.half-red.net
  },
  android: {
    // Android App Links will be configured in AndroidManifest.xml
    allowMixedContent: false,
  },
  plugins: {
    StatusBar: {
      style: 'dark',
      overlaysWebView: false,
    },
  },
};

export default config;
