import Capacitor
import os.log

/**
 * Capacitor plugin for writing data to BackgroundRunner's storage.
 *
 * This bridges the gap between main app storage and BackgroundRunner storage.
 *
 * On iOS, the BackgroundRunner uses UserDefaults.standard WITHOUT any prefix.
 * But @capacitor/preferences uses a "CapacitorStorage." prefix on keys.
 * So we write directly to UserDefaults.standard with the original key name.
 *
 * This plugin allows any native service to write data that needs to be
 * accessed by the BackgroundRunner (e.g., seekers, timestamps, API URLs).
 */
@objc(BackgroundRunnerStoragePlugin)
public class BackgroundRunnerStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundRunnerStoragePlugin"
    public let jsName = "BackgroundRunnerStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)
    ]
    
    private let logger = Logger(subsystem: "net.massa.gossip", category: "BackgroundRunnerStorage")
    
    /**
     * Write a key-value pair to the BackgroundRunner's storage.
     * This bridges the gap between main app storage and BackgroundRunner storage.
     *
     * On iOS, the BackgroundRunner uses UserDefaults.standard WITHOUT any prefix.
     * But @capacitor/preferences uses a "CapacitorStorage." prefix on keys.
     * So we write directly to UserDefaults.standard with the original key name.
     */
    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Key is required")
            return
        }
        
        let value = call.getString("value")
        
        // Write directly to UserDefaults.standard (no prefix) for BackgroundRunner
        if let value = value {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
        logger.debug("Stored to BackgroundRunner storage: \(key)")
        call.resolve()
    }
}

