package net.massa.gossip

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import net.massa.gossip.mesh.MeshNodeBridge

/**
 * Locks the app without the WebView, whose JavaScript is paused while the
 * app is in the background or the screen is off: the JS auto-lock alone only
 * runs once someone opens the app again.
 *
 * When the app goes to the background with an account open and an auto-lock
 * timeout set ([AppLockPlugin.configure]), an alarm is armed on the elapsed
 * clock (it counts deep sleep, and fires in Doze); coming back disarms it,
 * or locks at once when the time has passed. The notification's Lock action
 * locks the same way. A lock:
 *
 * - locks the mesh node ([MeshNodeBridge.lockNode]): the wanted list is
 *   emptied and the shared keys withdrawn, the node keeps relaying;
 * - locks the account's storage natively ([SecureStoragePlugin.lockNow]);
 * - finishes the app's tasks and removes them from Recents: the WebView is
 *   destroyed with everything decrypted in it, and the next open starts on
 *   the login screen. The process lives on while the mesh service runs.
 *
 * The state lives in memory: a process that died holds no open account.
 */
object AppLock {
    private const val TAG = "GossipAppLock"
    const val ACTION_AUTO_LOCK = "net.massa.gossip.action.AUTO_LOCK"
    const val ACTION_LOCK = "net.massa.gossip.action.LOCK"

    /** Seconds of background before the lock, while an account is open; null: no auto-lock. */
    @Volatile private var timeoutSeconds: Int? = null
    /** When the armed lock is due, on [SystemClock.elapsedRealtime]. */
    @Volatile private var deadline: Long? = null

    /** When a lock armed at [now] (ms) with [timeoutSeconds] is due; null when none is armed. */
    fun deadlineFor(now: Long, timeoutSeconds: Int?): Long? =
        timeoutSeconds?.takeIf { it >= 0 }?.let { now + it * 1000L }

    /** Whether a lock due at [deadline] is due at [now]. */
    fun isDue(deadline: Long?, now: Long): Boolean = deadline != null && now >= deadline

    fun configure(context: Context, timeoutSeconds: Int?) {
        this.timeoutSeconds = timeoutSeconds
        if (timeoutSeconds == null) disarm(context)
    }

    /** The app went to the background: arms the lock when an account is open. */
    fun onBackground(context: Context) {
        val due = deadlineFor(SystemClock.elapsedRealtime(), timeoutSeconds) ?: return
        deadline = due
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        val pending = alarmIntent(context)
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, due, pending)
            } else {
                // without the exact-alarm grant Doze may defer it; coming back still locks on time
                alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, due, pending)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "cannot arm the auto-lock alarm", e)
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, due, pending)
        }
    }

    /**
     * The app comes back: disarms the alarm, or locks when the time has
     * passed (the alarm was deferred). Returns whether it locked.
     */
    fun onForeground(context: Context): Boolean {
        val due = isDue(deadline, SystemClock.elapsedRealtime())
        disarm(context)
        if (due) {
            lock(context, reopen = true)
        }
        return due
    }

    /**
     * Locks now (see the class comment). With [reopen] a fresh activity
     * starts on the login screen, for a lock found due while opening.
     */
    fun lock(context: Context, reopen: Boolean = false) {
        val app = context.applicationContext
        timeoutSeconds = null
        disarm(app)
        MeshNodeBridge.lockNode()
        SecureStoragePlugin.lockNow()
        Handler(Looper.getMainLooper()).post {
            app.getSystemService(ActivityManager::class.java)?.appTasks?.forEach { it.finishAndRemoveTask() }
            if (reopen) {
                app.startActivity(
                    Intent(app, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                )
            }
        }
    }

    private fun disarm(context: Context) {
        deadline = null
        context.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(context))
    }

    private fun alarmIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, AppLockReceiver::class.java).setAction(ACTION_AUTO_LOCK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** For the notification's Lock action. */
    fun lockIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            1,
            Intent(context, AppLockReceiver::class.java).setAction(ACTION_LOCK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}

/** The auto-lock alarm and the notification's Lock action. */
class AppLockReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            AppLock.ACTION_AUTO_LOCK, AppLock.ACTION_LOCK -> AppLock.lock(context)
        }
    }
}
