import UIKit
import Capacitor
import WebKit

class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundRunnerStoragePlugin())
        bridge?.registerPluginInstance(BackgroundRefreshPlugin())
        bridge?.registerPluginInstance(NetworkObserverPlugin())

        #if DEBUG
        bridge?.registerPluginInstance(SSLBypassPlugin())
        if #available(iOS 16.4, *) {
            bridge?.webView?.isInspectable = true
        }
        #endif
    }
}
