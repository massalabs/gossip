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
 *
 * `scan({ continuous: true })` keeps the camera open for animated codes: each
 * new code read is a `frame` event ({ value }), `setStatus` writes a line over
 * the camera, and `finish()` closes it (the scan then resolves with "").
 */
@CapacitorPlugin(
    name = "QrScanner",
    permissions = [Permission(strings = [Manifest.permission.CAMERA], alias = "camera")]
)
class QrScannerPlugin : Plugin() {

    @PluginMethod
    fun scan(call: PluginCall) {
        QrScanActivity.opening.begin()
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
            QrScanActivity.opening.end()
            call.reject("Camera permission denied", "PERMISSION_DENIED")
        }
    }

    private fun openScanner(call: PluginCall) {
        // closed while the permission was asked: as if finish() had closed it
        if (QrScanActivity.opening.closeRequested()) {
            QrScanActivity.opening.end()
            call.resolve(JSObject().put("value", ""))
            return
        }
        val intent = Intent(context, QrScanActivity::class.java)
        call.getString("closeLabel")?.let { intent.putExtra(QrScanActivity.EXTRA_CLOSE_LABEL, it) }
        val continuous = call.getBoolean("continuous") ?: false
        intent.putExtra(QrScanActivity.EXTRA_CONTINUOUS, continuous)
        QrScanActivity.onFrame = if (continuous) {
            { value -> notifyListeners("frame", JSObject().put("value", value)) }
        } else {
            null
        }
        startActivityForResult(call, intent, "onScanResult")
    }

    @PluginMethod
    fun setStatus(call: PluginCall) {
        val text = call.getString("text") ?: ""
        // Kept for a scanner still opening, which shows it once created.
        QrScanActivity.status = text
        QrScanActivity.current?.get()?.setStatus(text)
        call.resolve()
    }

    @PluginMethod
    fun finish(call: PluginCall) {
        val scanner = QrScanActivity.current?.get()
        if (scanner != null) {
            scanner.finishContinuous()
        } else {
            // not on screen yet: closed when it appears
            QrScanActivity.opening.requestClose()
        }
        call.resolve()
    }

    @ActivityCallback
    private fun onScanResult(call: PluginCall?, result: ActivityResult) {
        QrScanActivity.opening.end()
        QrScanActivity.onFrame = null
        QrScanActivity.status = ""
        if (call == null) return
        val value = result.data?.getStringExtra(QrScanActivity.EXTRA_RESULT)
        if (result.resultCode == Activity.RESULT_OK && value != null) {
            call.resolve(JSObject().put("value", value))
        } else {
            call.reject("Scan cancelled", "CANCELLED")
        }
    }
}
