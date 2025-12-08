import Capacitor
import Foundation
import os.log

/**
 * Capacitor plugin for managing background sync lock.
 *
 * This plugin provides methods for the BackgroundRunner to acquire and release
 * the sync lock, preventing concurrent background sync executions.
 *
 * The lock is timestamp-based with a timeout to handle cases where the sync
 * process crashes or doesn't complete properly.
 */
@objc(SyncManagerPlugin)
public class SyncManager: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SyncManagerPlugin"
    public let jsName = "SyncManager"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "acquireLock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseLock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isLocked", returnType: CAPPluginReturnPromise)
    ]
    
    private let logger = Logger(subsystem: "net.massa.gossip", category: "SyncManager")
    private let userDefaults = UserDefaults.standard
    private let lockTimeKey = "gossip_sync_lock_time"
    
    // Maximum time to wait before releasing sync lock (90 seconds)
    // This acts as a safety timeout in case the sync doesn't complete.
    // Normal syncs should complete in seconds, so 90 seconds is generous.
    private let syncLockTimeout: TimeInterval = 90.0
    
    private let lockQueue = DispatchQueue(label: "net.massa.gossip.syncLock")
    
    /**
     * Try to acquire the sync lock.
     * Returns true if the lock was acquired, false if a sync is already running.
     *
     * Automatically releases expired locks (older than syncLockTimeout).
     */
    @objc func acquireLock(_ call: CAPPluginCall) {
        lockQueue.sync {
            let currentTime = Date().timeIntervalSince1970
            let lockTime = userDefaults.double(forKey: lockTimeKey)
            
            // Check if lock exists and is still valid
            if lockTime > 0 {
                let lockAge = currentTime - lockTime
                if lockAge < syncLockTimeout {
                    call.resolve(["acquired": false])
                    return
                } else {
                    // Lock expired, release it
                    releaseLockInternal()
                }
            }
            
            // Acquire the lock
            userDefaults.set(currentTime, forKey: lockTimeKey)
            call.resolve(["acquired": true])
        }
    }
    
    /**
     * Release the sync lock.
     */
    @objc func releaseLock(_ call: CAPPluginCall) {
        lockQueue.async {
            self.releaseLockInternal()
            call.resolve()
        }
    }
    
    /**
     * Check if a sync is currently running (lock is held).
     */
    @objc func isLocked(_ call: CAPPluginCall) {
        lockQueue.sync {
            let lockTime = userDefaults.double(forKey: lockTimeKey)
            
            if lockTime == 0 {
                call.resolve(["isLocked": false])
                return
            }
            
            let lockAge = Date().timeIntervalSince1970 - lockTime
            if lockAge >= syncLockTimeout {
                // Lock expired
                releaseLockInternal()
                call.resolve(["isLocked": false])
                return
            }
            
            call.resolve(["isLocked": true])
        }
    }
    
    /**
     * Internal method to release the lock.
     */
    private func releaseLockInternal() {
        userDefaults.removeObject(forKey: lockTimeKey)
    }
}

