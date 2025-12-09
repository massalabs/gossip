import UIKit
import Capacitor

class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundRunnerStoragePlugin())
        bridge?.registerPluginInstance(BackgroundRefreshPlugin())
        bridge?.registerPluginInstance(NetworkObserverPlugin())
        bridge?.registerPluginInstance(SyncManager())
    }
}

