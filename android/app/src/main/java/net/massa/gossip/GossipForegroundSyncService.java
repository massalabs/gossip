package net.massa.gossip;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps periodic background sync more reliable on Android
 * without server push. Shows a persistent notification while active.
 *
 * Uses AlarmManager.setExactAndAllowWhileIdle() for tick scheduling so that
 * sync triggers survive Doze mode (Handler.postDelayed is suspended during Doze).
 */
public class GossipForegroundSyncService extends Service {

    public static final String PREFS_NAME = "GossipForegroundSyncPrefs";
    public static final String KEY_ENABLED = "foreground_sync_enabled";
    /** SharedPreferences key matching BACKGROUND_SYNC_PRESET_KV_KEY on the JS side. */
    private static final String KEY_SYNC_PRESET = "gossip-sync-preset";

    private static final String CHANNEL_ID = "gossip_foreground_sync";
    private static final int NOTIFICATION_ID = 0x604f535; // "GOSS"
    private static final int ALARM_REQUEST_CODE = 0x604f536;
    private static final String ACTION_TICK = "net.massa.gossip.FOREGROUND_SYNC_TICK";

    private static final long TICK_MS_MAX = 1 * 60 * 1000L;       // 1 min — preset "max"
    private static final long TICK_MS_BALANCED = 5 * 60 * 1000L;   // 5 min — preset "balanced" (default)

    @Override
    public void onCreate() {
        super.onCreate();
        createChannelIfNeeded();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();
        startForeground(NOTIFICATION_ID, notification);

        if (ACTION_TICK.equals(intent != null ? intent.getAction() : null)) {
            // Fired by AlarmManager — perform sync then schedule next tick.
            BackgroundSyncWorker.scheduleBackgroundRunnerSync(getApplicationContext());
        }
        scheduleNextTick();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        cancelTick();
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel =
                    new NotificationChannel(
                            CHANNEL_ID,
                            getString(R.string.foreground_sync_channel_name),
                            NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.foreground_sync_channel_desc));
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    // ── Alarm-based tick scheduling ──────────────────────────────────────

    private long getTickMs() {
        String preset = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_SYNC_PRESET, "balanced");
        return "max".equals(preset) ? TICK_MS_MAX : TICK_MS_BALANCED;
    }

    private PendingIntent tickPendingIntent() {
        Intent intent = new Intent(this, GossipForegroundSyncService.class);
        intent.setAction(ACTION_TICK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getService(this, ALARM_REQUEST_CODE, intent, flags);
    }

    private void scheduleNextTick() {
        AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (am == null) return;
        long triggerAt = SystemClock.elapsedRealtime() + getTickMs();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, tickPendingIntent());
        } else {
            am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, tickPendingIntent());
        }
    }

    private void cancelTick() {
        AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (am != null) {
            am.cancel(tickPendingIntent());
        }
    }

    // ── Notification ──────────────────────────────────────────────────────

    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent =
                PendingIntent.getActivity(this, 0, launchIntent, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.foreground_sync_notification_title))
                .setContentText(getString(R.string.foreground_sync_notification_body))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    // ── Static helpers ────────────────────────────────────────────────────

    public static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, false);
    }

    static void setEnabledFlag(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_ENABLED, enabled)
                .apply();
    }

    /** Persist the sync preset so the foreground tick interval matches. */
    public static void setSyncPreset(Context context, String preset) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_SYNC_PRESET, preset)
                .apply();
    }

    /** Start the foreground service. Flag is set only on success. */
    public static void start(Context context) {
        Intent i = new Intent(context, GossipForegroundSyncService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(i);
        } else {
            context.startService(i);
        }
        setEnabledFlag(context, true);
    }

    /** Stop the service and clear the preference. */
    public static void stop(Context context) {
        setEnabledFlag(context, false);
        context.stopService(new Intent(context, GossipForegroundSyncService.class));
    }
}
