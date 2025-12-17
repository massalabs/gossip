package net.massa.gossip;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Use BackgroundSyncWorker instead of RunnerWorker directly
// BackgroundSyncWorker properly sets up the input data that RunnerWorker needs

/**
 * Capacitor plugin for monitoring network state changes and triggering background sync.
 * 
 * This plugin:
 * 1. Monitors network state changes at the native level (works in background)
 * 2. Acquires a wake lock when network becomes available OR network type changes
 * 3. Triggers the BackgroundRunner to execute the sync script
 * 
 * Sync is triggered when:
 * - Device goes from offline to online
 * - Network type changes (e.g., WiFi → Cellular, Cellular → WiFi)
 * 
 * This ensures messages are fetched immediately when connectivity is restored or changed,
 * even if the app is in the background or the device was in deep sleep.
 */
@CapacitorPlugin(name = "NetworkObserver")
public class NetworkObserverPlugin extends Plugin {
    private static final String TAG = "NetworkObserver";
    
    // Wake lock timeout in milliseconds (3 minutes)
    private static final long WAKE_LOCK_TIMEOUT_MS = 3 * 60 * 1000;
    
    // Network type constants
    private static final String NETWORK_TYPE_WIFI = "wifi";
    private static final String NETWORK_TYPE_CELLULAR = "cellular";
    private static final String NETWORK_TYPE_ETHERNET = "ethernet";
    private static final String NETWORK_TYPE_OTHER = "other";
    private static final String NETWORK_TYPE_NONE = "none";
    
    // Wake lock identifier
    private static final String WAKE_LOCK_TAG = "Gossip::NetworkSyncWakeLock";
    
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private PowerManager.WakeLock wakeLock;
    private boolean isObserving = false;
    
    // Track previous network state to detect changes
    // Volatile ensures visibility across threads, synchronized methods ensure atomicity
    private volatile boolean wasOnline = false;
    private volatile String previousNetworkType = NETWORK_TYPE_NONE;

    @Override
    public void load() {
        super.load();
        connectivityManager = (ConnectivityManager) getContext()
                .getSystemService(Context.CONNECTIVITY_SERVICE);
        
        // Initialize the current network state
        updateInitialState();
    }

    /**
     * Start observing network state changes.
     * When network becomes available or type changes, will acquire wake lock and trigger sync.
     */
    @PluginMethod
    public void startObserving(PluginCall call) {
        if (isObserving) {
            call.resolve();
            return;
        }

        try {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    String networkType = getNetworkType(network);
                    handleNetworkChange(true, networkType, "connected");
                }

                @Override
                public void onLost(@NonNull Network network) {
                    handleNetworkChange(false, NETWORK_TYPE_NONE, "disconnected");
                }

                @Override
                public void onCapabilitiesChanged(@NonNull Network network, 
                        @NonNull NetworkCapabilities capabilities) {
                    boolean isOnline = capabilities.hasCapability(
                            NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                            capabilities.hasCapability(
                                    NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                    
                    String networkType = getNetworkTypeFromCapabilities(capabilities);
                    handleNetworkChange(isOnline, networkType, "changed");
                }
            };

            NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();

            connectivityManager.registerNetworkCallback(request, networkCallback);
            isObserving = true;
            
            Log.d(TAG, "Started observing network changes");
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to start network observer", e);
            call.reject("Failed to start network observer", e);
        }
    }

    /**
     * Stop observing network state changes.
     */
    @PluginMethod
    public void stopObserving(PluginCall call) {
        if (!isObserving || networkCallback == null) {
            call.resolve();
            return;
        }

        try {
            connectivityManager.unregisterNetworkCallback(networkCallback);
            networkCallback = null;
            isObserving = false;
            releaseWakeLock();
            
            Log.d(TAG, "Stopped observing network changes");
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop network observer", e);
            call.reject("Failed to stop network observer", e);
        }
    }

    /**
     * Manually trigger background sync with wake lock.
     * Useful for testing or forcing an immediate sync.
     * The lock will be checked by the JavaScript code executed by BackgroundRunner.     */
    @PluginMethod
    public void triggerBackgroundSync(PluginCall call) {
        try {
            acquireWakeLock();
            scheduleBackgroundSync();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to trigger background sync", e);
            call.reject("Failed to trigger background sync", e);
        }
    }

    /**
     * Acquire wake lock for sync (can be called from JS for foreground sync).
     */
    @PluginMethod
    public void acquireWakeLockForSync(PluginCall call) {
        try {
            acquireWakeLock();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to acquire wake lock", e);
            call.reject("Failed to acquire wake lock", e);
        }
    }

    /**
     * Release wake lock.
     */
    @PluginMethod
    public void releaseWakeLock(PluginCall call) {
        releaseWakeLock();
        call.resolve();
    }

    /**
     * Handle network state change.
     * Triggers sync when:
     * - Transitioning from offline to online
     * - Network type changes while online (e.g., WiFi → 5G)
     * 
     * Synchronized to prevent race conditions when multiple network callbacks execute concurrently.
     */
    private synchronized void handleNetworkChange(boolean isOnline, String networkType, String reason) {
        boolean becameOnline = isOnline && !wasOnline;
        boolean networkTypeChanged = isOnline && wasOnline && 
                !networkType.equals(previousNetworkType) && 
                !previousNetworkType.equals(NETWORK_TYPE_NONE);
        
        if (becameOnline) {
            triggerSyncWithWakeLock("connected", networkType);
        } else if (networkTypeChanged) {
            triggerSyncWithWakeLock("type_changed", networkType);
        } else if (!isOnline && wasOnline) {
            notifyListeners("networkLost", new JSObject());
        }
        
        // Update online state carefully:
        // - Always update to true when online (network is validated)
        // - Only update to false when we're actually going offline (wasOnline was true)
        // - Don't update to false if we're in the middle of connecting (onCapabilitiesChanged can fire with false before true)
        if (isOnline || (!isOnline && wasOnline)) {
            wasOnline = isOnline;
            previousNetworkType = networkType;
        }
    }

    /**
     * Trigger sync with wake lock and notify listeners.
     * The shared lock is checked by the JavaScript code executed by BackgroundRunner.
     */
    private void triggerSyncWithWakeLock(String reason, String networkType) {
        // Acquire wake lock to keep device awake during sync
        acquireWakeLock();
        
        // Schedule background runner to execute sync
        scheduleBackgroundSync();
        
        // Notify JS listeners (for foreground case)
        JSObject data = new JSObject();
        data.put("reason", reason);
        data.put("networkType", networkType);
        notifyListeners("networkAvailable", data);
    }

    /**
     * Schedule the BackgroundRunner to execute immediately.
     * Uses BackgroundSyncWorker which properly sets up the input data for RunnerWorker.
     */
    private void scheduleBackgroundSync() {
        try {
            // Use BackgroundSyncWorker which properly configures the RunnerWorker
            // with the required input data (label, src, event)
            boolean scheduled = BackgroundSyncWorker.scheduleBackgroundRunnerSync(getContext());
            if (!scheduled) {
                Log.w(TAG, "Background sync could not be scheduled (lock may be held)");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule background sync", e);
        }
    }

    /**
     * Update initial network state without triggering sync.
     * Synchronized to prevent race conditions with concurrent network callbacks.
     */
    private synchronized void updateInitialState() {
        Network activeNetwork = connectivityManager.getActiveNetwork();
        if (activeNetwork != null) {
            NetworkCapabilities capabilities = connectivityManager
                    .getNetworkCapabilities(activeNetwork);
            if (capabilities != null) {
                wasOnline = capabilities.hasCapability(
                        NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                        capabilities.hasCapability(
                                NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                previousNetworkType = getNetworkTypeFromCapabilities(capabilities);
            }
        }
    }

    /**
     * Get network type from Network object.
     */
    private String getNetworkType(Network network) {
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
        if (capabilities == null) {
            return NETWORK_TYPE_OTHER;
        }
        return getNetworkTypeFromCapabilities(capabilities);
    }

    /**
     * Get network type string from NetworkCapabilities.
     */
    private String getNetworkTypeFromCapabilities(NetworkCapabilities capabilities) {
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return NETWORK_TYPE_WIFI;
        } else if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return NETWORK_TYPE_CELLULAR;
        } else if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return NETWORK_TYPE_ETHERNET;
        } else {
            return NETWORK_TYPE_OTHER;
        }
    }

    /**
     * Acquire a wake lock to keep the device awake for sync.
     */
    private void acquireWakeLock() {
        // Release any existing wake lock first
        releaseWakeLock();
        
        try {
            PowerManager powerManager = (PowerManager) getContext()
                    .getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        WAKE_LOCK_TAG
                );
                wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to acquire wake lock", e);
        }
    }

    /**
     * Release the wake lock if held.
     */
    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
            wakeLock = null;
        } catch (Exception e) {
            Log.e(TAG, "Failed to release wake lock", e);
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (isObserving && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering network callback on destroy", e);
            }
        }
        releaseWakeLock();
    }
}
