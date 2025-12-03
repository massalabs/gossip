package net.massa.gossip;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Broadcast receiver that triggers when the app is updated.
 * This ensures that background sync is triggered after an app update,
 * which may have cleared WorkManager jobs.
 * 
 * When triggered, it schedules background sync work via WorkManager,
 * which then triggers the Capacitor BackgroundRunner to execute the background-sync.js script.
 */
public class AppUpdateReceiver extends BroadcastReceiver {
    private static final String TAG = "GossipAppUpdateReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        Log.d(TAG, "Received broadcast: " + action);

        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            handleAppUpdate(context);
        }
    }

    /**
     * Handle app update by immediately scheduling background sync.
     */
    private void handleAppUpdate(Context context) {
        Log.d(TAG, "App updated - scheduling immediate background sync");
        
        try {
            // Schedule an immediate sync after app update
            BackgroundSyncWorker.scheduleBackgroundRunnerSync(context);
            
            Log.d(TAG, "Background sync scheduled after app update");
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule background sync after update", e);
        }
    }
}
