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
import android.util.Log;

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

    private static final String TAG = "GossipForegroundSync";

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
    /**
     * Floor used when SCHEDULE_EXACT_ALARM is not granted and we fall back to
     * setAndAllowWhileIdle. Doze throttles inexact allow-while-idle alarms to a
     * 9–15 min minimum, so scheduling a 1-min next-fire is misleading and just
     * burns binder calls. Use 15 min to align with Doze's worst case.
     */
    private static final long TICK_MS_DEGRADED_FLOOR = 15 * 60 * 1000L;

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

    /**
     * Whether the app can schedule exact alarms.
     *
     * Pre-API 31, the SCHEDULE_EXACT_ALARM permission did not exist and exact alarms
     * are always allowed. From API 31+, the permission is required and must be checked
     * via AlarmManager.canScheduleExactAlarms() at runtime since the user (or system)
     * can revoke it at any time. The early Build.VERSION.SDK_INT return is recognized
     * by Android lint's SDK version checker, so canScheduleExactAlarms() (which is
     * @RequiresApi(31)) is only reached on API 31+.
     */
    private static boolean canUseExactAlarms(AlarmManager am) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        return am.canScheduleExactAlarms();
    }

    /**
     * Schedule the next sync tick via AlarmManager.
     *
     * On Android 12+ (API 31+), exact alarms require the SCHEDULE_EXACT_ALARM permission,
     * which is NOT pre-granted on Android 13+ fresh installs and may be revoked at any time
     * by the user or the system. Calling setExactAndAllowWhileIdle without it throws
     * SecurityException, which would crash the foreground service.
     *
     * Strategy (minSdk is 26, so we always have setExactAndAllowWhileIdle available):
     *  - API 31+ with permission: setExactAndAllowWhileIdle (1-min "max" preset works)
     *  - API 31+ without permission: fallback to setAndAllowWhileIdle (degraded — Doze
     *    will throttle to ~9-15 min minimum, but the app keeps working without crashing)
     *  - API 26-30: setExactAndAllowWhileIdle (no permission required on these versions)
     *
     * The whole call is wrapped in try/catch as a final safety net against any unexpected
     * SecurityException from OEM-specific battery savers (Xiaomi, Huawei, etc.).
     */
    private void scheduleNextTick() {
        AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (am == null) return;
        boolean exact = canUseExactAlarms(am);
        // In degraded mode, Doze clamps inexact alarms to 9-15 min anyway, so
        // honour that floor in our own next-fire calculation rather than asking
        // for 1 min and being silently throttled. Keeps tick metrics honest.
        long tickMs = exact ? getTickMs() : Math.max(getTickMs(), TICK_MS_DEGRADED_FLOOR);
        long triggerAt = SystemClock.elapsedRealtime() + tickMs;
        PendingIntent pi = tickPendingIntent();
        try {
            if (exact) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                Log.w(TAG, "SCHEDULE_EXACT_ALARM not granted, using inexact alarm (Doze-throttled)");
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
        } catch (SecurityException e) {
            Log.w(TAG, "SCHEDULE_EXACT_ALARM not granted, using inexact alarm (Doze-throttled)", e);
            try {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } catch (Exception ignored) {
                Log.e(TAG, "Failed to schedule any alarm — sync tick disabled until next service start");
            }
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
                .setOnlyAlertOnce(true)
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
