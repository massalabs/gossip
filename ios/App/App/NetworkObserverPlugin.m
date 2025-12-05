#import <Capacitor/Capacitor.h>
#import <BackgroundTasks/BackgroundTasks.h>

// Register the NetworkObserverPlugin with Capacitor
CAP_PLUGIN(NetworkObserverPlugin, "NetworkObserver",
    CAP_PLUGIN_METHOD(startObserving, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopObserving, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(triggerBackgroundSync, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(acquireWakeLockForSync, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(releaseWakeLock, CAPPluginReturnPromise);
)
