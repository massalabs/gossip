package net.massa.gossip

import android.Manifest
import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Native QR scanner without Google Play Services: CameraX drives the
 * camera (focus, exposure) and ZXing core decodes the frames on-device.
 * `scan()` opens a full-screen [QrScanActivity] and resolves with the
 * decoded text, or rejects with code CANCELLED when the user leaves.
 */
@CapacitorPlugin(
    name = "QrScanner",
    permissions = [Permission(strings = [Manifest.permission.CAMERA], alias = "camera")]
)
class QrScannerPlugin : Plugin() {

    @PluginMethod
    fun scan(call: PluginCall) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            openScanner(call)
        } else {
            requestPermissionForAlias("camera", call, "onCameraPermission")
        }
    }

    @PermissionCallback
    private fun onCameraPermission(call: PluginCall) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            openScanner(call)
        } else {
            call.reject("Camera permission denied", "PERMISSION_DENIED")
        }
    }

    private fun openScanner(call: PluginCall) {
        startActivityForResult(call, Intent(context, QrScanActivity::class.java), "onScanResult")
    }

    @ActivityCallback
    private fun onScanResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val value = result.data?.getStringExtra(QrScanActivity.EXTRA_RESULT)
        if (result.resultCode == Activity.RESULT_OK && value != null) {
            call.resolve(JSObject().put("value", value))
        } else {
            call.reject("Scan cancelled", "CANCELLED")
        }
    }
}
