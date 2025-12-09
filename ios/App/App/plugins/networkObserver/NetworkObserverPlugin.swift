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
    
    private let logger = Logger(subsystem: "net.massa.gossip", category: "NetworkObserver")
    
    // Background task identifier (must match Info.plist BGTaskSchedulerPermittedIdentifiers)
    private static let backgroundTaskIdentifier = "net.massa.gossip.background.sync"
    
    private var pathMonitor: NWPathMonitor?
    private var monitorQueue: DispatchQueue?
    private var isObserving = false
    
    // Track previous network state to detect changes
    private var wasOnline = false
    private var previousNetworkType = "none"
    
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
        monitorQueue = DispatchQueue(label: "net.massa.gossip.networkMonitor", qos: .utility)
        
        // Get initial state
        updateInitialState()
        
        pathMonitor?.pathUpdateHandler = { [weak self] path in
            self?.handlePathUpdate(path)
        }
        
        pathMonitor?.start(queue: monitorQueue!)
        isObserving = true
        
        logger.info("Started observing network changes")
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
        
        let becameOnline = isOnline && !wasOnline
        let networkTypeChanged = isOnline && wasOnline && 
                networkType != previousNetworkType && 
                previousNetworkType != "none"
        
        logger.debug("Network update: online=\(isOnline), type=\(networkType), wasOnline=\(self.wasOnline), previousType=\(self.previousNetworkType)")
        
        if becameOnline {
            logger.info("Network became available (\(networkType)), triggering sync")
            triggerSyncWithBackgroundTask(reason: "connected", networkType: networkType)
        } else if networkTypeChanged {
            logger.info("Network type changed (\(self.previousNetworkType) → \(networkType)), triggering sync")
            triggerSyncWithBackgroundTask(reason: "type_changed", networkType: networkType)
        } else if !isOnline && wasOnline {
            logger.info("Network became unavailable")
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
     * Update initial network state without triggering sync.
     */
    private func updateInitialState() {
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "net.massa.gossip.initialState")
        
        monitor.pathUpdateHandler = { [weak self] path in
            monitor.cancel()
            self?.wasOnline = path.status == .satisfied
            self?.previousNetworkType = self?.getNetworkType(from: path) ?? "none"
            self?.logger.debug("Initial state: online=\(self?.wasOnline ?? false), type=\(self?.previousNetworkType ?? "none")")
        }
        
        monitor.start(queue: queue)
        
        // Add timeout to prevent indefinite monitoring if handler never fires
        DispatchQueue.global().asyncAfter(deadline: .now() + 5.0) {
            monitor.cancel()
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
                logger.error("Failed to schedule BGAppRefreshTask: \(error.localizedDescription)")
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
        endBackgroundTask()
        
        logger.info("Stopped observing network changes")
    }
    
    /**
     * Begin a background task to keep the app running while syncing.
     */
    private func beginBackgroundTask() {
        // End any existing background task
        endBackgroundTask()
        
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "GossipNetworkSync") { [weak self] in
            self?.logger.warning("Background task expired")
            self?.endBackgroundTask()
        }
        
        if backgroundTaskID != .invalid {
            logger.info("Background task started (ID: \(self.backgroundTaskID.rawValue))")
            
            // Auto-end after timeout (only if task hasn't been expired by iOS)
            let taskID = backgroundTaskID
            DispatchQueue.main.asyncAfter(deadline: .now() + backgroundTaskTimeout) { [weak self] in
                // Only end if this is still the same task (hasn't been expired/replaced)
                if let self = self, self.backgroundTaskID == taskID && self.backgroundTaskID != .invalid {
                    self.endBackgroundTask()
                }
            }
        } else {
            logger.warning("Failed to start background task")
        }
    }
    
    /**
     * End the background task.
     */
    private func endBackgroundTask() {
        if backgroundTaskID != .invalid {
            logger.info("Ending background task (ID: \(self.backgroundTaskID.rawValue))")
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
