package net.massa.gossip;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/** Foreground data-sync protection held only while a portable backup is active. */
public class PortableBackupForegroundService extends Service {
    private static final String CHANNEL = "gossip_portable_backup";
    private static final int NOTIFICATION_ID = 0x47424b50;
    private static final String ACTION_START = "net.massa.gossip.BACKUP_START";
    private static final String ACTION_PROGRESS = "net.massa.gossip.BACKUP_PROGRESS";
    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_TEXT = "text";
    private static final String EXTRA_PROCESSED = "processed";
    private static final String EXTRA_TOTAL = "total";

    private PowerManager.WakeLock wakeLock;
    private String title;
    private String text;

    public static Intent startIntent(Context context, String title, String text) {
        return new Intent(context, PortableBackupForegroundService.class)
                .setAction(ACTION_START).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text);
    }

    public static Intent progressIntent(Context context, String text, long processed, long total) {
        return new Intent(context, PortableBackupForegroundService.class)
                .setAction(ACTION_PROGRESS).putExtra(EXTRA_TEXT, text)
                .putExtra(EXTRA_PROCESSED, processed).putExtra(EXTRA_TOTAL, total);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        title = getString(R.string.portable_backup_notification_title);
        text = getString(R.string.portable_backup_notification_preparing);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, getString(R.string.portable_backup_channel_name),
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.portable_backup_channel_desc));
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Gossip:PortableBackup");
            wakeLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String incomingTitle = intent.getStringExtra(EXTRA_TITLE);
            String incomingText = intent.getStringExtra(EXTRA_TEXT);
            if (incomingTitle != null) title = incomingTitle;
            if (incomingText != null) text = incomingText;
        }
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire(6L * 60 * 60 * 1000);
        }
        startForeground(NOTIFICATION_ID, notification(intent));
        return START_NOT_STICKY;
    }

    private android.app.Notification notification(Intent source) {
        Intent launch = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title).setContentText(text).setOngoing(true)
                .setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setContentIntent(PendingIntent.getActivity(this, NOTIFICATION_ID, launch, pendingFlags));
        long total = source == null ? 0 : source.getLongExtra(EXTRA_TOTAL, 0);
        long processed = source == null ? 0 : source.getLongExtra(EXTRA_PROCESSED, 0);
        if (total > 0) {
            int progress = (int) Math.min(1000, (processed * 1000.0) / total);
            builder.setProgress(1000, progress, false);
        } else {
            builder.setProgress(0, 0, true);
        }
        return builder.build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf(startId);
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
