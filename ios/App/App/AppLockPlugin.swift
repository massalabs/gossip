import Capacitor
import UIKit

/// The native side of the auto-lock, as `AppLock.kt` on Android: the
/// WebView's JavaScript does not run in the background, so the lock of a
/// phone left untouched cannot wait for it. A lock empties the mesh node's
/// wanted list and withdraws the keys shared nearby (the node keeps
/// relaying), locks the account's storage natively, and reloads the WebView
/// so that nothing decrypted stays in it and the app opens on the login
/// screen.
///
/// iOS suspends a backgrounded app within seconds, so no timer is sure to
/// fire on time. What runs: a background task keeps the app awake for the
/// seconds iOS grants; a check every 10 s, which also runs whenever the
/// mesh's Bluetooth background modes wake the app; and a check before the
/// app comes back to the foreground, which locks before the UI shows when
/// the time has passed. A suspended app that nothing wakes is locked when it
/// is next opened, not before. The deadline is on `CLOCK_MONOTONIC`, which
/// counts the time the phone sleeps on Darwin.
@objc(AppLockPlugin)
public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "AppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lockNow", returnType: CAPPluginReturnPromise),
    ]

    // Main thread only.
    private var timeoutSeconds: Int?
    private var deadline: UInt64?
    private var timer: DispatchSourceTimer?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var reloadPending = false

    override public func load() {
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(didEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(
            self, selector: #selector(willEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// `timeoutSeconds` while an account is open, null once none is.
    @objc func configure(_ call: CAPPluginCall) {
        let timeout = call.getInt("timeoutSeconds")
        DispatchQueue.main.async {
            self.timeoutSeconds = timeout
            if timeout == nil { self.disarm() }
            call.resolve()
        }
    }

    @objc func lockNow(_ call: CAPPluginCall) {
        call.resolve()
        DispatchQueue.main.async { self.lock() }
    }

    private static func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

    @objc private func didEnterBackground() {
        guard let timeout = timeoutSeconds, timeout >= 0 else { return }
        deadline = Self.now() + UInt64(timeout) * 1_000_000_000
        endBackgroundTask()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "gossip-auto-lock") { [weak self] in
            self?.endBackgroundTask()
        }
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now() + .seconds(min(timeout, 10)), repeating: .seconds(10), leeway: .seconds(1))
        source.setEventHandler { [weak self] in self?.lockIfDue() }
        timer?.cancel()
        timer = source
        source.resume()
    }

    @objc private func willEnterForeground() {
        lockIfDue()
        disarm()
        if reloadPending {
            reloadPending = false
            bridge?.webView?.reload()
        }
    }

    private func lockIfDue() {
        if let deadline = deadline, Self.now() >= deadline { lock() }
    }

    private func lock() {
        timeoutSeconds = nil
        disarm()
        MeshNodeBridge.shared.lockNode()
        SecureStoragePlugin.lockNow()
        if UIApplication.shared.applicationState == .active {
            bridge?.webView?.reload()
        } else {
            // a suspended WebView may not reload: done again before the UI shows
            reloadPending = true
            bridge?.webView?.reload()
        }
    }

    private func disarm() {
        deadline = nil
        timer?.cancel()
        timer = nil
        endBackgroundTask()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
