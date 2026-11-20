import Capacitor
import Network
import UIKit
import BackgroundTasks
import os.log

/**
 * Capacitor plugin for monitoring network state changes and triggering background sync.
 *
 * This plugin:
 * 1. Monitors network state changes at the native level (works in background)
 * 2. Begins a background task when network becomes available OR network type changes
 * 3. Triggers the BackgroundRunner to execute the sync script
 *
 * Sync is triggered when:
 * - Device goes from offline to online
 * - Network type changes (e.g., WiFi → Cellular, Cellular → WiFi)
 *
 * This ensures messages are fetched immediately when connectivity is restored or changed,
 * even if the app is in the background.
 */
@objc(NetworkObserverPlugin)
public class NetworkObserverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NetworkObserverPlugin"
    public let jsName = "NetworkObserver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startObserving", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopObserving", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "triggerBackgroundSync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acquireWakeLockForSync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseWakeLock", returnType: CAPPluginReturnPromise)
    ]
    
    #if DEBUG
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "net.massa.gossip", category: "NetworkObserver")
    #endif

    // Background task identifier (must match Info.plist BGTaskSchedulerPermittedIdentifiers)
    private static let backgroundTaskIdentifier = "\(Bundle.main.bundleIdentifier ?? "net.massa.gossip").background.sync"
    
    private var pathMonitor: NWPathMonitor?
    private var monitorQueue: DispatchQueue?
    private var isObserving = false
    
    // Track previous network state to detect changes. Only mutated from
    // `monitorQueue` inside `handlePathUpdate`, so no extra synchronization
    // is needed as long as we never read/write these from another queue.
    private var wasOnline = false
    private var previousNetworkType = "none"
    private var hasReceivedInitialState = false
    
    // Background task management
    private var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid
    private let backgroundTaskTimeout: TimeInterval = 30 // 30 seconds max
    
    // MARK: - Plugin Methods
    
    /**
     * Start observing network state changes.
     * When network becomes available or type changes, will trigger sync.
     */
    @objc func startObserving(_ call: CAPPluginCall) {
        if isObserving {
            call.resolve()
            return
        }
        
        pathMonitor = NWPathMonitor()
        monitorQueue = DispatchQueue(label: "\(Bundle.main.bundleIdentifier ?? "net.massa.gossip").networkMonitor", qos: .utility)

        // Single monitor: its first callback seeds `wasOnline` /
        // `previousNetworkType` and skips triggering sync. A previous
        // implementation spun up a *second* `NWPathMonitor` on a separate
        // queue to "get the initial state", which raced with this one
        // (both wrote `wasOnline`).
        pathMonitor?.pathUpdateHandler = { [weak self] path in
            self?.handlePathUpdate(path)
        }

        pathMonitor?.start(queue: monitorQueue!)
        isObserving = true
        
        #if DEBUG
        logger.info("Started observing network changes")
        #endif
        call.resolve()
    }
    
    /**
     * Stop observing network state changes.
     */
    @objc func stopObserving(_ call: CAPPluginCall) {
        stopMonitoring()
        call.resolve()
    }
    
    /**
     * Manually trigger background sync.
     * The lock will be acquired/released by the BackgroundRunner JavaScript code.
     */
    @objc func triggerBackgroundSync(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.beginBackgroundTask()
            self?.scheduleImmediateBackgroundTask()
            call.resolve()
        }
    }
    
    /**
     * Acquire a background task for sync (can be called from JS for foreground sync).
     */
    @objc func acquireWakeLockForSync(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.beginBackgroundTask()
            call.resolve()
        }
    }
    
    /**
     * Release the background task.
     */
    @objc func releaseWakeLock(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.endBackgroundTask()
            call.resolve()
        }
    }
    
    // MARK: - Private Methods
    
    /**
     * Handle network path update.
     * Triggers sync when:
     * - Transitioning from offline to online
     * - Network type changes while online (e.g., WiFi → Cellular)
     */
    private func handlePathUpdate(_ path: NWPath) {
        let isOnline = path.status == .satisfied
        let networkType = getNetworkType(from: path)

        // Seed state on the very first callback without triggering sync;
        // we don't want to spuriously kick off a background task just
        // because the monitor is reporting the world as it already is.
        if !hasReceivedInitialState {
            hasReceivedInitialState = true
            wasOnline = isOnline
            previousNetworkType = networkType
            #if DEBUG
            logger.debug("Initial state: online=\(isOnline), type=\(networkType)")
            #endif
            return
        }

        let becameOnline = isOnline && !wasOnline
        let networkTypeChanged = isOnline && wasOnline &&
                networkType != previousNetworkType &&
                previousNetworkType != "none"

        #if DEBUG
        logger.debug("Network update: online=\(isOnline), type=\(networkType), wasOnline=\(self.wasOnline), previousType=\(self.previousNetworkType)")
        #endif

        if becameOnline {
            #if DEBUG
            logger.info("Network became available (\(networkType)), triggering sync")
            #endif
            triggerSyncWithBackgroundTask(reason: "connected", networkType: networkType)
        } else if networkTypeChanged {
            #if DEBUG
            logger.info("Network type changed (\(self.previousNetworkType) → \(networkType)), triggering sync")
            #endif
            triggerSyncWithBackgroundTask(reason: "type_changed", networkType: networkType)
        } else if !isOnline && wasOnline {
            #if DEBUG
            logger.info("Network became unavailable")
            #endif
            DispatchQueue.main.async { [weak self] in
                self?.notifyListeners("networkLost", data: [:])
            }
        }

        wasOnline = isOnline
        previousNetworkType = networkType
    }
    
    /**
     * Trigger sync with background task and notify listeners.
     * The lock will be acquired/released by the BackgroundRunner JavaScript code.
     */
    private func triggerSyncWithBackgroundTask(reason: String, networkType: String) {
        DispatchQueue.main.async { [weak self] in
            self?.beginBackgroundTask()
            self?.scheduleImmediateBackgroundTask()
            self?.notifyListeners("networkAvailable", data: [
                "reason": reason,
                "networkType": networkType
            ])
        }
    }
    
    /**
     * Schedule an immediate background task refresh.
     * This will trigger the BackgroundRunner's configured task.
     */
    private func scheduleImmediateBackgroundTask() {
        if #available(iOS 13.0, *) {
            do {
                let request = BGAppRefreshTaskRequest(identifier: Self.backgroundTaskIdentifier)
                request.earliestBeginDate = Date() // As soon as possible
                try BGTaskScheduler.shared.submit(request)
            } catch {
                #if DEBUG
                logger.error("Failed to schedule BGAppRefreshTask: \(error.localizedDescription)")
                #endif
            }
        }
    }
    
    /**
     * Stop monitoring network changes.
     */
    private func stopMonitoring() {
        pathMonitor?.cancel()
        pathMonitor = nil
        monitorQueue = nil
        isObserving = false
        hasReceivedInitialState = false
        endBackgroundTask()
        
        #if DEBUG
        logger.info("Stopped observing network changes")
        #endif
    }
    
    /**
     * Begin a background task to keep the app running while syncing.
     */
    private func beginBackgroundTask() {
        // End any existing background task
        endBackgroundTask()
        
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "GossipNetworkSync") { [weak self] in
            #if DEBUG
            self?.logger.warning("Background task expired")
            #endif
            self?.endBackgroundTask()
        }
        
        if backgroundTaskID != .invalid {
            #if DEBUG
            logger.info("Background task started (ID: \(self.backgroundTaskID.rawValue))")
            #endif
            
            // Auto-end after timeout (only if task hasn't been expired by iOS)
            let taskID = backgroundTaskID
            DispatchQueue.main.asyncAfter(deadline: .now() + backgroundTaskTimeout) { [weak self] in
                // Only end if this is still the same task (hasn't been expired/replaced)
                if let self = self, self.backgroundTaskID == taskID && self.backgroundTaskID != .invalid {
                    self.endBackgroundTask()
                }
            }
        } else {
            #if DEBUG
            logger.warning("Failed to start background task")
            #endif
        }
    }
    
    /**
     * End the background task.
     */
    private func endBackgroundTask() {
        if backgroundTaskID != .invalid {
            #if DEBUG
            logger.info("Ending background task (ID: \(self.backgroundTaskID.rawValue))")
            #endif
            UIApplication.shared.endBackgroundTask(backgroundTaskID)
            backgroundTaskID = .invalid
        }
    }
    
    /**
     * Get network type string from NWPath.
     */
    private func getNetworkType(from path: NWPath) -> String {
        if path.usesInterfaceType(.wifi) {
            return "wifi"
        } else if path.usesInterfaceType(.cellular) {
            return "cellular"
        } else if path.usesInterfaceType(.wiredEthernet) {
            return "ethernet"
        } else if path.status == .satisfied {
            return "other"
        } else {
            return "none"
        }
    }
    
    // MARK: - Lifecycle
    
    deinit {
        stopMonitoring()
    }
}
