package net.massa.gossip.share

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.concurrent.Executors

/**
 * The AppShare plugin (`services/appShare.ts`): gives Gossip to a phone that
 * does not have it, with no internet: a Wi-Fi Direct hotspot serving the APK
 * to the other phone's browser. Texts of the landing page come from the app,
 * already translated.
 */
@CapacitorPlugin(
    name = "AppShare",
    permissions = [
        Permission(strings = [Manifest.permission.NEARBY_WIFI_DEVICES], alias = AppSharePlugin.ALIAS_NEARBY_WIFI),
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = AppSharePlugin.ALIAS_LOCATION),
    ],
)
class AppSharePlugin : Plugin() {

    private val io = Executors.newSingleThreadExecutor()
    private var hotspot: ApkHotspot? = null
    private var server: ApkWebServer? = null

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val apk = ShareableApk.installed(context)
        call.resolve(
            JSObject()
                .put("shareable", apk != null)
                .put("sizeBytes", apk?.length() ?: 0)
                .put("version", ShareableApk.versionName(context))
                .put("sharing", server != null),
        )
    }

    // ── Permissions ──────────────────────────────────────────────────────

    @PluginMethod
    fun requestWifiPermission(call: PluginCall) {
        if (wifiState() == "granted") {
            call.resolve(JSObject().put("state", "granted"))
        } else {
            requestPermissionForAlias(wifiAlias(), call, "onWifiPermission")
        }
    }

    @PermissionCallback
    private fun onWifiPermission(call: PluginCall) {
        call.resolve(JSObject().put("state", wifiState()))
    }

    // Wi-Fi Direct needs "nearby Wi-Fi devices" from Android 13, location before.
    private fun wifiAlias(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ALIAS_NEARBY_WIFI else ALIAS_LOCATION

    private fun wifiState(): String = when (getPermissionState(wifiAlias())) {
        PermissionState.GRANTED -> "granted"
        PermissionState.DENIED -> "denied"
        else -> "prompt"
    }

    // ── Hotspot ──────────────────────────────────────────────────────────

    @PluginMethod
    fun startHotspot(call: PluginCall) {
        if (wifiState() != "granted") {
            call.reject("Wi-Fi permission denied", "PERMISSION_DENIED")
            return
        }
        val apk = ShareableApk.installed(context)
        if (apk == null) {
            call.reject("This install cannot be shared", "NOT_SHAREABLE")
            return
        }
        val page = call.getString("landingPage")
        if (page.isNullOrEmpty()) {
            call.reject("landingPage is required", "INVALID_ARGUMENT")
            return
        }
        stopSharing()
        val spot = ApkHotspot(context) {
            stopSharing()
            notifyListeners("hotspot", JSObject().put("state", "stopped"))
        }
        hotspot = spot
        spot.start { result ->
            result.onFailure { error ->
                hotspot = null
                val code = (error as? ApkHotspot.Failure)?.code ?: ApkHotspot.FAILED
                call.reject(error.message, code)
            }
            result.onSuccess { network ->
                io.execute {
                    try {
                        val web = ApkWebServer(apk, page) { state ->
                            notifyListeners("download", JSObject().put("state", state))
                        }
                        val port = web.start(network.address)
                        server = web
                        keepScreenOn(true)
                        val host = network.address.hostAddress
                        call.resolve(
                            JSObject()
                                .put("ssid", network.ssid)
                                .put("passphrase", network.passphrase)
                                .put("url", "http://$host:$port/"),
                        )
                    } catch (e: Exception) {
                        stopSharing()
                        call.reject("Could not serve the app", ApkHotspot.FAILED, e)
                    }
                }
            }
        }
    }

    @PluginMethod
    fun stopHotspot(call: PluginCall) {
        stopSharing()
        call.resolve()
    }

    private fun stopSharing() {
        server?.stop()
        server = null
        hotspot?.stop()
        hotspot = null
        keepScreenOn(false)
    }

    // The other phone may take a minute to join: the screen should not lock.
    private fun keepScreenOn(on: Boolean) {
        val window = activity?.window ?: return
        activity.runOnUiThread {
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    @PluginMethod
    fun openWifiSettings(call: PluginCall) {
        val action = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Settings.Panel.ACTION_WIFI
        } else {
            Settings.ACTION_WIFI_SETTINGS
        }
        activity.startActivity(Intent(action))
        call.resolve()
    }

    override fun handleOnDestroy() {
        stopSharing()
        io.shutdown()
    }

    companion object {
        const val ALIAS_NEARBY_WIFI = "nearbyWifi"
        const val ALIAS_LOCATION = "location"
    }
}
