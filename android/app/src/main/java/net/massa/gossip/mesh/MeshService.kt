package net.massa.gossip.mesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import net.massa.gossip.MainActivity
import net.massa.gossip.R

/**
 * Foreground service that keeps the mesh radio on while the app is in the
 * background or closed: relaying needs no keys, so the phone keeps carrying
 * other people's blobs with the app locked. Restarted by the system after a
 * kill (START_STICKY), with the configuration the app last started it with.
 */
class MeshService : Service() {

    override fun onCreate() {
        super.onCreate()
        createChannelIfNeeded()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                } else {
                    0
                },
            )
        } catch (e: RuntimeException) {
            // Android 14+ refuses a connectedDevice service without a granted Bluetooth permission.
            Log.w(TAG, "Cannot run the mesh in the foreground", e)
            stopSelf()
            return START_NOT_STICKY
        }

        val mode = PowerMode.fromName(prefs.getString(KEY_POWER_MODE, null))
        if (!MeshNodeBridge.isCoreRunning()) {
            MeshNodeBridge.startCore(this, prefs.getString(KEY_CONFIG, null) ?: "{}")
            // After a reboot the app has not run yet: apply the upstream it last set,
            // so a bridge keeps bridging. The wanted list comes back with the app.
            val urls = prefs.getStringSet(KEY_UPSTREAM_URLS, null)
            if (urls != null) {
                val bridge = prefs.getBoolean(KEY_BRIDGE, false)
                MeshNodeBridge.call { it.setUpstream(urls.toList(), bridge) }
            }
        }
        if (!radioAttached) {
            MeshNodeBridge.attachRadio(BleMeshRadio(applicationContext), mode)
            radioAttached = true
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (radioAttached) {
            MeshNodeBridge.detachRadio()
            radioAttached = false
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannelIfNeeded() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.mesh_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = getString(R.string.mesh_channel_desc)
        channel.setShowBadge(false)
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.mesh_notification_title))
            .setContentText(getString(R.string.mesh_notification_body))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        private const val TAG = "GossipMeshService"
        private const val CHANNEL_ID = "gossip_mesh"
        private const val NOTIFICATION_ID = 0x604f537
        private const val PREFS_NAME = "GossipMeshPrefs"
        private const val KEY_CONFIG = "config"
        private const val KEY_POWER_MODE = "power_mode"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_UPSTREAM_URLS = "upstream_urls"
        private const val KEY_BRIDGE = "bridge"
        private const val KEY_INSTALL_ID = "install_id"

        // The service is a singleton per process; the flag lives with it.
        private var radioAttached = false

        /** Remembers the configuration for restarts, then starts the service. */
        fun start(context: Context, configJson: String, mode: PowerMode) {
            context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit {
                putString(KEY_CONFIG, configJson)
                putString(KEY_POWER_MODE, mode.name)
                putBoolean(KEY_ENABLED, true)
            }
            ContextCompat.startForegroundService(context, Intent(context, MeshService::class.java))
        }

        /** Remembered so the service can apply it on its own after a reboot. */
        fun rememberUpstream(context: Context, urls: List<String>, bridgeEnabled: Boolean) {
            context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit {
                putStringSet(KEY_UPSTREAM_URLS, urls.toSet())
                putBoolean(KEY_BRIDGE, bridgeEnabled)
            }
        }

        /**
         * Random id of this installation, kept out of backups with the rest of
         * these preferences: the app ties consents (bridging) to it, so a
         * phone restored from a backup asks again.
         */
        @Synchronized
        fun installId(context: Context): String {
            val prefs = context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            prefs.getString(KEY_INSTALL_ID, null)?.let { return it }
            val id = java.util.UUID.randomUUID().toString()
            prefs.edit { putString(KEY_INSTALL_ID, id) }
            return id
        }

        /** Whether the app last started the mesh rather than stopped it. */
        @JvmStatic
        fun isEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

        /** Starts the service again with the remembered configuration (after a reboot). */
        @JvmStatic
        fun restart(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, MeshService::class.java))
        }

        fun setPowerMode(context: Context, mode: PowerMode) {
            context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit {
                putString(KEY_POWER_MODE, mode.name)
            }
            MeshNodeBridge.setPowerMode(mode)
        }

        fun stop(context: Context) {
            context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit { putBoolean(KEY_ENABLED, false) }
            context.stopService(Intent(context, MeshService::class.java))
        }
    }
}
