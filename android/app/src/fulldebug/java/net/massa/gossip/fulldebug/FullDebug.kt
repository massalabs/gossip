package net.massa.gossip.fulldebug

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import net.massa.gossip.DebugLog
import org.json.JSONObject

/**
 * Entry point of the full debug build, called by MainActivity through
 * reflection (this code exists only in that build). Starts the record, sends
 * the native logs to it, records uncaught exceptions and why the previous run
 * ended.
 */
object FullDebug {
    @Volatile private var installed = false

    @JvmStatic
    fun install(context: Context) {
        if (installed) return
        installed = true
        try {
            DebugLogWriter.init(context)
            DebugLog.sink = { lvl, tag, msg, tr -> DebugLogWriter.native(lvl, tag, msg, tr) }
            MeshLogPump.start()
            installUncaughtHandler()
            DebugLogWriter.appendLine(
                DebugLogWriter.line("native", "app.start", "info", JSONObject().put("process", context.packageName)),
                false,
            )
            recordPreviousExits(context)
            (context.applicationContext as? android.app.Application)?.let { PermissionLog.install(it) }
        } catch (t: Throwable) {
            // never into the app
        }
    }

    private fun installUncaughtHandler() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val f = JSONObject()
                f.put("thread", thread.name)
                f.put("err", DebugLogWriter.throwableJson(error))
                DebugLogWriter.appendLineAndWait(DebugLogWriter.line("native", "crash.uncaught", "error", f), 1500)
            } catch (t: Throwable) {}
            previous?.uncaughtException(thread, error)
        }
    }

    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_ANR -> "ANR"
        ApplicationExitInfo.REASON_CRASH -> "CRASH"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
        ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
        ApplicationExitInfo.REASON_OTHER -> "OTHER"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
        ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
        ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
        else -> "UNKNOWN_$reason"
    }

    private fun recordPreviousExits(context: Context) {
        if (Build.VERSION.SDK_INT < 30) return
        DebugLogWriter.submit {
            val prefs = context.getSharedPreferences("gossip-full-debug", Context.MODE_PRIVATE)
            val seen = prefs.getLong("lastExitTs", 0L)
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val exits = am.getHistoricalProcessExitReasons(null, 0, 5)
            var newest = seen
            for (info in exits.sortedBy { it.timestamp }) {
                if (info.timestamp <= seen) continue
                if (info.timestamp > newest) newest = info.timestamp
                val reason = reasonName(info.reason)
                val abnormal = info.reason in setOf(
                    ApplicationExitInfo.REASON_ANR,
                    ApplicationExitInfo.REASON_CRASH,
                    ApplicationExitInfo.REASON_CRASH_NATIVE,
                    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
                    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
                )
                val f = JSONObject()
                f.put("reason", reason)
                f.put("status", info.status)
                f.put("importance", info.importance)
                f.put("description", info.description ?: "")
                f.put("at", info.timestamp)
                f.put("pss", info.pss)
                f.put("rss", info.rss)
                f.put("process", info.processName)
                if (info.reason == ApplicationExitInfo.REASON_ANR) {
                    try {
                        info.traceInputStream?.use { s ->
                            val buf = ByteArray(256 * 1024)
                            var total = 0
                            while (total < buf.size) {
                                val r = s.read(buf, total, buf.size - total)
                                if (r <= 0) break
                                total += r
                            }
                            f.put("trace", String(buf, 0, total, Charsets.UTF_8))
                        }
                    } catch (t: Throwable) {}
                }
                DebugLogWriter.appendLine(
                    DebugLogWriter.line("native", "app.previous_exit", if (abnormal) "error" else "info", f),
                    abnormal,
                )
                if (abnormal) {
                    DebugLogWriter.pendingErrors.add("Previous run ended: $reason ${info.description ?: ""}".trim())
                }
            }
            prefs.edit().putLong("lastExitTs", newest).apply()
        }
    }
}
