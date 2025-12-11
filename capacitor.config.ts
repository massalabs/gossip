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

  android: {
    adjustMarginsForEdgeToEdge: 'force',
  },

  plugins: {
    SystemBars: {
      insetsHandling: 'css',
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
