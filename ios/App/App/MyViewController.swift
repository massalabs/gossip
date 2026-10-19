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

        #if DEBUG
        bridge?.registerPluginInstance(SSLBypassPlugin())
        if #available(iOS 16.4, *) {
            bridge?.webView?.isInspectable = true
        }
        #endif
    }
}
