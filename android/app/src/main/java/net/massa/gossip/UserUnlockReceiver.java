package net.massa.gossip;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Broadcast receiver that triggers when the user unlocks their device.
 * 
 * This receiver listens for ACTION_USER_PRESENT, which is sent by the system
 * when the user unlocks the device (after entering PIN/pattern/fingerprint/face).
 * 
 * When triggered, it schedules an immediate background sync to fetch any
 * pending messages. This provides a better user experience as messages
 * are fetched right when the user is about to use their phone.
 * 
 * Note: This broadcast is only sent if there was a keyguard (lock screen).
 * If the device has no lock screen configured, this won't be triggered.
 * 
 * No specific permission is required to receive ACTION_USER_PRESENT.
 */
public class UserUnlockReceiver extends BroadcastReceiver {
    private static final String TAG = "GossipUserUnlock";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        
        if (Intent.ACTION_USER_PRESENT.equals(action)) {
            Log.d(TAG, "User unlocked device - triggering background sync");
            
            try {
                // Schedule immediate background sync
                BackgroundSyncWorker.scheduleBackgroundRunnerSync(context);
                
                Log.d(TAG, "Background sync scheduled successfully after device unlock");
            } catch (Exception e) {
                Log.e(TAG, "Failed to schedule background sync after device unlock", e);
            }
        }
    }
}

