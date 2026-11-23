package net.massa.gossip.fulldebug

import android.app.Activity
import android.app.AlarmManager
import android.app.Application
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Permission states in the record (full debug build only, needs no permission):
 *
 * - `permission.state` at start: every permission the app declares, granted or
 *   not, plus the states that are not permissions (battery optimisation
 *   exemption, exact alarms, notifications, Bluetooth, location services,
 *   foreground service types); again on resume with `changes` when one moved.
 * - `permission.request`: every runtime request (seen through
 *   ActivityCompat's delegate, which every Capacitor plugin request goes
 *   through), with the permissions asked.
 * - `permission.result`: on the next resume, each asked permission as
 *   `granted`, `denied` or `denied_permanently` (denied and Android will no
 *   longer show the dialog).
 */
object PermissionLog {
    private var last: Map<String, String> = emptyMap()
    private var pending: Array<String>? = null
    private var pendingCode = 0

    fun install(app: Application) {
        try {
            DebugLogWriter.appendLine(stateLine(app, null, null), false)
            ActivityCompat.setPermissionCompatDelegate(object : ActivityCompat.PermissionCompatDelegate {
                override fun requestPermissions(activity: Activity, permissions: Array<String>, requestCode: Int): Boolean {
                    try {
                        pending = permissions.copyOf()
                        pendingCode = requestCode
                        val f = JSONObject()
                        f.put("permissions", JSONArray(permissions.toList()))
                        f.put("requestCode", requestCode)
                        f.put("before", JSONObject(permissions.associateWith { runtimeState(activity, it) }))
                        DebugLogWriter.appendLine(DebugLogWriter.line("native", "permission.request", "info", f), false)
                    } catch (t: Throwable) {}
                    return false // let Android show its dialog as usual
                }

                override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: android.content.Intent?): Boolean = false
            })
            app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
                override fun onActivityResumed(activity: Activity) = onResume(activity)
                override fun onActivityCreated(a: Activity, b: Bundle?) {}
                override fun onActivityStarted(a: Activity) {}
                override fun onActivityPaused(a: Activity) {}
                override fun onActivityStopped(a: Activity) {}
                override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
                override fun onActivityDestroyed(a: Activity) {}
            })
        } catch (t: Throwable) {
            // never into the app
        }
    }

    private fun onResume(activity: Activity) {
        try {
            val asked = pending
            if (asked != null) {
                pending = null
                val results = JSONObject()
                var anyDenied = false
                for (p in asked) {
                    val granted = activity.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
                    val r = when {
                        granted -> "granted"
                        !activity.shouldShowRequestPermissionRationale(p) -> "denied_permanently"
                        else -> "denied"
                    }
                    if (!granted) anyDenied = true
                    results.put(p, r)
                }
                val f = JSONObject()
                f.put("requestCode", pendingCode)
                f.put("results", results)
                DebugLogWriter.appendLine(
                    DebugLogWriter.line("native", "permission.result", if (anyDenied) "warn" else "info", f),
                    false,
                )
            }
            val before = last
            val now = snapshot(activity)
            val changes = JSONObject()
            for ((k, v) in now) if (before[k] != v) changes.put(k, JSONObject().put("from", before[k] ?: JSONObject.NULL).put("to", v))
            if (changes.length() > 0) DebugLogWriter.appendLine(stateLine(activity, now, changes), false)
        } catch (t: Throwable) {}
    }

    private fun runtimeState(activity: Activity, p: String): String = try {
        when {
            activity.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED -> "granted"
            activity.shouldShowRequestPermissionRationale(p) -> "denied_rationale"
            else -> "denied"
        }
    } catch (t: Throwable) {
        "unknown"
    }

    /** name -> state, for every declared permission and the special states. */
    private fun snapshot(context: Context): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        try {
            val info: PackageInfo = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            val names = info.requestedPermissions ?: emptyArray()
            val flags = info.requestedPermissionsFlags ?: IntArray(0)
            for (i in names.indices) {
                val granted = i < flags.size && (flags[i] and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0
                out[names[i]] = if (granted) "granted" else "denied"
            }
        } catch (t: Throwable) {}
        fun special(name: String, get: () -> Any?) {
            out[name] = try {
                get()?.toString() ?: "n/a"
            } catch (t: Throwable) {
                "error: ${t.javaClass.simpleName}"
            }
        }
        special("special.battery_optimisation_exempt") {
            (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName)
        }
        special("special.power_save_mode") { (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode }
        special("special.exact_alarms") {
            if (Build.VERSION.SDK_INT >= 31) (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms() else "n/a (before Android 12)"
        }
        special("special.notifications_enabled") { NotificationManagerCompat.from(context).areNotificationsEnabled() }
        special("special.bluetooth_enabled") {
            (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?)?.adapter?.isEnabled ?: "no adapter"
        }
        special("special.location_enabled") {
            if (Build.VERSION.SDK_INT >= 28) (context.getSystemService(Context.LOCATION_SERVICE) as LocationManager).isLocationEnabled else "n/a"
        }
        return out
    }

    private fun stateLine(context: Context, snap: Map<String, String>?, changes: JSONObject?): String {
        val now = snap ?: snapshot(context)
        last = now
        val f = JSONObject()
        f.put("permissions", JSONObject(now as Map<*, *>))
        if (changes != null) f.put("changes", changes)
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SERVICES)
                val types = JSONObject()
                for (s in info.services ?: emptyArray()) {
                    if (s.foregroundServiceType != 0) types.put(s.name, s.foregroundServiceType)
                }
                f.put("foregroundServiceTypes", types)
            }
        } catch (t: Throwable) {}
        f.put("targetSdk", context.applicationInfo.targetSdkVersion)
        return DebugLogWriter.line("native", "permission.state", "info", f)
    }
}
