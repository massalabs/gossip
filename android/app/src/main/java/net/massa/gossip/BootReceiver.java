package net.massa.gossip;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.UserManager;
import android.util.Log;

/**
 * Broadcast receiver that triggers when the device boots up.
 * This ensures that background sync is triggered after a device restart.
 * 
 * The receiver listens for:
 * - BOOT_COMPLETED: Standard Android boot completed
 * - QUICKBOOT_POWERON: Quick boot on some devices
 * - LOCKED_BOOT_COMPLETED: Direct boot completed (for encrypted devices)
 * 
 * When triggered, it schedules a WorkManager job (via BackgroundSyncWorker) which,
 * after a short delay (to allow the system to fully initialize), triggers the
 * Capacitor BackgroundRunner to execute the background-sync.js script.
 * 
 * Note: This receiver is directBootAware, meaning it can receive LOCKED_BOOT_COMPLETED
 * before the device is unlocked. We check for device unlock state before scheduling
 * sync because credential-protected storage (SharedPreferences) is not accessible
 * until the device is unlocked.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "GossipBootReceiver";
    
    // Delay in minutes after boot before first sync
    // This gives the system time to stabilize
    private static final int BOOT_SYNC_DELAY_MINUTES = 2;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        Log.d(TAG, "Received broadcast: " + action);

        switch (action) {
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_LOCKED_BOOT_COMPLETED:
            case "android.intent.action.QUICKBOOT_POWERON":
            case "com.htc.intent.action.QUICKBOOT_POWERON":
                handleBoot(context, action);
                break;
            default:
                Log.d(TAG, "Ignoring action: " + action);
                break;
        }
    }

    /**
     * Handle device boot by scheduling background sync.
     * We schedule a delayed sync to allow the system to stabilize first.
     * 
     * For Direct Boot (LOCKED_BOOT_COMPLETED), we skip scheduling if the device
     * is still locked, as credential-protected storage won't be accessible.
     * The sync will be scheduled when BOOT_COMPLETED fires after unlock.
     */
    private void handleBoot(Context context, String action) {
        Log.d(TAG, "Device booted - checking if sync can be scheduled");
        
        // For Direct Boot, check if credential-protected storage is available
        if (Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            if (!isUserUnlocked(context)) {
                Log.d(TAG, "Device is locked (Direct Boot) - skipping sync, will wait for BOOT_COMPLETED");
                return;
            }
        }
        
        try {
            // Schedule a delayed sync to run after the system has stabilized
            BackgroundSyncWorker.scheduleDelayedSync(context, BOOT_SYNC_DELAY_MINUTES);
            
            Log.d(TAG, "Background sync scheduled for " + BOOT_SYNC_DELAY_MINUTES + " minutes after boot");
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule background sync after boot", e);
        }
    }
    
    /**
     * Check if the user has unlocked the device and credential-protected storage is available.
     * This is important for Direct Boot scenarios where the device may boot but still be locked.
     */
    private boolean isUserUnlocked(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            UserManager userManager = (UserManager) context.getSystemService(Context.USER_SERVICE);
            if (userManager != null) {
                return userManager.isUserUnlocked();
            }
        }
        // For older versions, assume unlocked (Direct Boot didn't exist before N)
        return true;
    }
}
