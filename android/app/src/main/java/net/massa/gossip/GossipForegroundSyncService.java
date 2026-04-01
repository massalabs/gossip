package net.massa.gossip;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps periodic background sync more reliable on Android
 * without server push. Shows a persistent notification while active.
 */
public class GossipForegroundSyncService extends Service {

    public static final String PREFS_NAME = "GossipForegroundSyncPrefs";
    public static final String KEY_ENABLED = "foreground_sync_enabled";

    private static final String CHANNEL_ID = "gossip_foreground_sync";
    private static final int NOTIFICATION_ID = 0x604f535; // "GOSS"
    /** Interval between BackgroundRunner triggers while the service runs. */
    private static final long TICK_MS = 5 * 60 * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tickRunnable =
            new Runnable() {
                @Override
                public void run() {
                    BackgroundSyncWorker.scheduleBackgroundRunnerSync(getApplicationContext());
                    handler.postDelayed(this, TICK_MS);
                }
            };

    @Override
    public void onCreate() {
        super.onCreate();
        createChannelIfNeeded();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();
        startForeground(NOTIFICATION_ID, notification);
        handler.removeCallbacks(tickRunnable);
        handler.post(tickRunnable);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tickRunnable);
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

    /** Persist preference and start the foreground service. */
    public static void start(Context context) {
        setEnabledFlag(context, true);
        Intent i = new Intent(context, GossipForegroundSyncService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(i);
        } else {
            context.startService(i);
        }
    }

    /** Stop the service and clear the preference. */
    public static void stop(Context context) {
        setEnabledFlag(context, false);
        context.stopService(new Intent(context, GossipForegroundSyncService.class));
    }
}
