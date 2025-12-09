package net.massa.gossip;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for managing background sync lock.
 * 
 * This plugin provides methods for the BackgroundRunner to acquire and release
 * the sync lock, preventing concurrent background sync executions.
 * 
 * The lock is timestamp-based with a timeout to handle cases where the sync
 * process crashes or doesn't complete properly.
 */
@CapacitorPlugin(name = "SyncManager")
public class SyncManager extends Plugin {
    private static final String TAG = "GossipSyncManager";
    private static final String PREFS_NAME = "gossip_sync_lock";
    private static final String KEY_LOCK_TIME = "sync_lock_time";
    
    // Maximum time to wait before releasing sync lock (90 seconds)
    // This acts as a safety timeout in case the sync doesn't complete.
    // Normal syncs should complete in seconds, so 90 seconds is generous.
    private static final long SYNC_LOCK_TIMEOUT_MS = 90 * 1000;
    
    // Static lock object for cross-process synchronization
    // Synchronized on the class to ensure atomicity across all plugin instances
    private static final Object LOCK = new Object();
    
    /**
     * Try to acquire the sync lock.
     * Returns true if the lock was acquired, false if a sync is already running.
     * 
     * Automatically releases expired locks (older than SYNC_LOCK_TIMEOUT_MS).
     * 
     * Uses synchronized block on static LOCK object and commit() for cross-process synchronization.
     */
    @PluginMethod
    public void acquireLock(PluginCall call) {
        synchronized (LOCK) {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            long currentTime = System.currentTimeMillis();
            long lockTime = prefs.getLong(KEY_LOCK_TIME, 0);
            
            // Check if lock exists and is still valid
            if (lockTime > 0) {
                long lockAge = currentTime - lockTime;
                if (lockAge < SYNC_LOCK_TIMEOUT_MS) {
                    JSObject result = new JSObject();
                    result.put("acquired", false);
                    call.resolve(result);
                    return;
                } else {
                    // Lock expired, release it
                    releaseLockInternal(prefs);
                }
            }
            
            // Acquire the lock - use commit() for immediate cross-process visibility
            prefs.edit().putLong(KEY_LOCK_TIME, currentTime).commit();
            
            JSObject result = new JSObject();
            result.put("acquired", true);
            call.resolve(result);
        }
    }
    
    /**
     * Release the sync lock.
     * Uses synchronized block on static LOCK object and commit() for cross-process synchronization.
     */
    @PluginMethod
    public void releaseLock(PluginCall call) {
        synchronized (LOCK) {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            releaseLockInternal(prefs);
            call.resolve();
        }
    }
    
    /**
     * Check if a sync is currently running (lock is held).
     * Uses synchronized block on static LOCK object for cross-process synchronization.
     */
    @PluginMethod
    public void isLocked(PluginCall call) {
        synchronized (LOCK) {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            long lockTime = prefs.getLong(KEY_LOCK_TIME, 0);
            
            if (lockTime == 0) {
                JSObject result = new JSObject();
                result.put("isLocked", false);
                call.resolve(result);
                return;
            }
            
            long lockAge = System.currentTimeMillis() - lockTime;
            if (lockAge >= SYNC_LOCK_TIMEOUT_MS) {
                // Lock expired
                releaseLockInternal(prefs);
                JSObject result = new JSObject();
                result.put("isLocked", false);
                call.resolve(result);
                return;
            }
            
            JSObject result = new JSObject();
            result.put("isLocked", true);
            call.resolve(result);
        }
    }
    
    /**
     * Internal method to release the lock.
     * Uses commit() for immediate cross-process visibility.
     */
    private void releaseLockInternal(SharedPreferences prefs) {
        prefs.edit().remove(KEY_LOCK_TIME).commit();
    }
}
