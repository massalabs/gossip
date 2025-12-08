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

        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            handleAppUpdate(context);
        }
    }

    /**
     * Handle app update by immediately scheduling background sync.
     */
    private void handleAppUpdate(Context context) {
        try {
            // Schedule an immediate sync after app update
            boolean scheduled = BackgroundSyncWorker.scheduleBackgroundRunnerSync(context);
            if (!scheduled) {
                Log.w(TAG, "Background sync could not be scheduled after update (lock may be held)");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule background sync after update", e);
        }
    }
}
