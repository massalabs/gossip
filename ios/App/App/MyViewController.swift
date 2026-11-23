import UIKit
import Capacitor
import WebKit

class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundRunnerStoragePlugin())
        bridge?.registerPluginInstance(BackgroundRefreshPlugin())
        bridge?.registerPluginInstance(NetworkObserverPlugin())
        bridge?.registerPluginInstance(SecureStoragePlugin())
        bridge?.registerPluginInstance(PortableBackupFilePlugin())
        bridge?.registerPluginInstance(QrScannerPlugin())
        bridge?.registerPluginInstance(MeshNodePlugin())
        bridge?.registerPluginInstance(AppLockPlugin())
        bridge?.registerPluginInstance(ContactExchangePlugin())

        // Full debug build only (FULL_DEBUG, set by fastlane when
        // GOSSIP_FULL_DEBUG=true): its record, absent from any other build.
        #if FULL_DEBUG
        bridge?.registerPluginInstance(DebugLogFilePlugin())
        #endif

        #if DEBUG
        bridge?.registerPluginInstance(SSLBypassPlugin())
        if #available(iOS 16.4, *) {
            bridge?.webView?.isInspectable = true
        }
        #endif
    }
}
