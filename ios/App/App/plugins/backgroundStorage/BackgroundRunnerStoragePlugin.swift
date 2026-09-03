import Capacitor
import UserNotifications
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
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearIfValue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)
    ]
    
    private static let accountOutputMonitor = NSLock()
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "net.massa.gossip", category: "BackgroundRunnerStorage")
    
    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Key is required")
            return
        }
        if let value = UserDefaults.standard.string(forKey: key) {
            call.resolve(["value": value])
        } else {
            call.resolve([:])
        }
    }

    @objc func cancelNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        call.resolve()
    }

    @objc func clearIfValue(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let expected = call.getString("expected") else {
            call.reject("Key and expected value are required")
            return
        }
        Self.accountOutputMonitor.lock()
        defer { Self.accountOutputMonitor.unlock() }
        if UserDefaults.standard.string(forKey: key) == expected {
            UserDefaults.standard.removeObject(forKey: key)
            guard UserDefaults.standard.synchronize() else {
                call.reject("Failed to durably clear BackgroundRunner storage")
                return
            }
        }
        call.resolve()
    }

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
        let storedKey = call.getString("scope") == "app"
            ? "CapacitorStorage.\(key)"
            : key

        // BackgroundRunner keys have no prefix; Capacitor Preferences keys do.
        if let value = value {
            UserDefaults.standard.set(value, forKey: storedKey)
        } else {
            UserDefaults.standard.removeObject(forKey: storedKey)
        }
        if call.getBool("strict", false) && !UserDefaults.standard.synchronize() {
            call.reject("Failed to durably write BackgroundRunner storage")
            return
        }
        logger.debug("Stored to BackgroundRunner storage: \(key)")
        call.resolve()
    }
}

