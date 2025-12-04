#import <Capacitor/Capacitor.h>

// Register the BackgroundRefreshPlugin with Capacitor
// This allows the plugin to be called from JavaScript/TypeScript
CAP_PLUGIN(BackgroundRefreshPlugin, "BackgroundRefresh",
    CAP_PLUGIN_METHOD(getBackgroundRefreshStatus, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(openSettings, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isLowPowerModeEnabled, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getFullStatus, CAPPluginReturnPromise);
)

