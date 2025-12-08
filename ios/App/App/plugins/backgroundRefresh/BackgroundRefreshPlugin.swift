import Capacitor
import UIKit

/**
 * Capacitor plugin for checking iOS Background App Refresh status.
 * This is critical for reliable background sync on iOS devices.
 *
 * Background App Refresh can be disabled by:
 * - User in Settings > General > Background App Refresh
 * - Low Power Mode (automatically disables background refresh)
 * - Parental controls or MDM restrictions
 */
@objc(BackgroundRefreshPlugin)
public class BackgroundRefreshPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundRefreshPlugin"
    public let jsName = "BackgroundRefresh"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getBackgroundRefreshStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isLowPowerModeEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getFullStatus", returnType: CAPPluginReturnPromise)
    ]

    /**
     * Get the current background refresh status.
     *
     * Returns:
     * - status: "available" | "denied" | "restricted" | "unknown"
     * - isEnabled: boolean - whether background refresh is enabled
     * - userCanEnable: boolean - whether the user can enable it (false for restricted)
     */
    @objc func getBackgroundRefreshStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let status = UIApplication.shared.backgroundRefreshStatus

            var statusString = "unknown"
            var isEnabled = false
            var userCanEnable = false

            switch status {
            case .available:
                statusString = "available"
                isEnabled = true
                userCanEnable = true
            case .denied:
                // User disabled in Settings > General > Background App Refresh
                statusString = "denied"
                isEnabled = false
                userCanEnable = true
            case .restricted:
                // System-level restriction (parental controls, MDM, Low Power Mode active restriction)
                statusString = "restricted"
                isEnabled = false
                userCanEnable = false
            @unknown default:
                statusString = "unknown"
                isEnabled = false
                userCanEnable = false
            }

            call.resolve([
                "status": statusString,
                "isEnabled": isEnabled,
                "userCanEnable": userCanEnable
            ])
        }
    }

    /**
     * Open the app's settings page in iOS Settings.
     * Note: Cannot navigate directly to Background App Refresh settings,
     * but opening app settings allows the user to find the option.
     */
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let settingsUrl = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Invalid settings URL")
                return
            }

            if UIApplication.shared.canOpenURL(settingsUrl) {
                UIApplication.shared.open(settingsUrl, options: [:]) { success in
                    if success {
                        call.resolve()
                    } else {
                        call.reject("Failed to open settings")
                    }
                }
            } else {
                call.reject("Cannot open settings URL")
            }
        }
    }

    /**
     * Check if Low Power Mode is currently enabled.
     * When Low Power Mode is active, background app refresh is disabled system-wide.
     */
    @objc func isLowPowerModeEnabled(_ call: CAPPluginCall) {
        let isLowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        call.resolve([
            "isEnabled": isLowPower
        ])
    }

    /**
     * Get comprehensive background sync status for iOS.
     * Combines background refresh status and low power mode in one call.
     */
    @objc func getFullStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let refreshStatus = UIApplication.shared.backgroundRefreshStatus
            let isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled

            var statusString = "unknown"
            var isEnabled = false
            var userCanEnable = false

            switch refreshStatus {
            case .available:
                statusString = "available"
                isEnabled = true
                userCanEnable = true
            case .denied:
                statusString = "denied"
                isEnabled = false
                userCanEnable = true
            case .restricted:
                statusString = "restricted"
                isEnabled = false
                userCanEnable = false
            @unknown default:
                statusString = "unknown"
                isEnabled = false
                userCanEnable = false
            }

            // If low power mode is on, background refresh won't work even if status is "available"
            let effectivelyEnabled = isEnabled && !isLowPowerMode

            call.resolve([
                "backgroundRefreshStatus": statusString,
                "isBackgroundRefreshEnabled": isEnabled,
                "userCanEnableBackgroundRefresh": userCanEnable,
                "isLowPowerModeEnabled": isLowPowerMode,
                "isBackgroundSyncReliable": effectivelyEnabled
            ])
        }
    }
}

