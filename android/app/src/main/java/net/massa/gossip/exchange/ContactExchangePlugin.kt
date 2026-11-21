package net.massa.gossip.exchange

import android.Manifest
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.UUID

/**
 * The ContactExchange plugin (`services/contactExchange.ts`): the Bluetooth
 * half of adding a contact in person, independent of the mesh node. The
 * presenter advertises its code's UUID while the code is on screen; the
 * scanner connects once it has read one frame. Binary values cross the
 * bridge as standard base64; nothing is stored.
 *
 * Events: `request` ({ requestId, data }) for a scanner's request, and
 * `sent` ({ requestId }) once its answer went out.
 */
@CapacitorPlugin(
    name = "ContactExchange",
    permissions = [
        Permission(
            strings = [
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            ],
            alias = ContactExchangePlugin.ALIAS_BLUETOOTH,
        ),
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = ContactExchangePlugin.ALIAS_LOCATION),
    ],
)
class ContactExchangePlugin : Plugin() {

    private val thread = HandlerThread("gossip-contact-exchange").apply { start() }
    private val handler = Handler(thread.looper)

    private val presenter by lazy {
        BlePresenter(context, handler, object : BlePresenter.Listener {
            override fun onRequest(requestId: Int, request: ByteArray) {
                notifyListeners("request", JSObject().put("requestId", requestId).put("data", encode(request)))
            }

            override fun onSent(requestId: Int) {
                notifyListeners("sent", JSObject().put("requestId", requestId))
            }
        })
    }

    private val client by lazy { BleExchangeClient(context, handler) }

    override fun handleOnDestroy() {
        presenter.stop()
        client.cancel()
        handler.post { thread.quitSafely() }
    }

    // ── Permissions ──────────────────────────────────────────────────────

    @PluginMethod
    fun checkBluetooth(call: PluginCall) {
        call.resolve(JSObject().put("state", bluetoothState()))
    }

    @PluginMethod
    fun requestBluetooth(call: PluginCall) {
        val missing = requiredAliases().filter { getPermissionState(it) != PermissionState.GRANTED }
        if (missing.isEmpty()) {
            call.resolve(JSObject().put("state", "granted"))
        } else {
            requestPermissionForAliases(missing.toTypedArray(), call, "onBluetoothPermission")
        }
    }

    @PermissionCallback
    private fun onBluetoothPermission(call: PluginCall) {
        call.resolve(JSObject().put("state", bluetoothState()))
    }

    private fun bluetoothState(): String {
        val states = requiredAliases().map { getPermissionState(it) }
        return when {
            states.all { it == PermissionState.GRANTED } -> "granted"
            states.any { it == PermissionState.DENIED } -> "denied"
            else -> "prompt"
        }
    }

    private fun hasBluetooth(call: PluginCall): Boolean {
        if (bluetoothState() == "granted") return true
        call.reject("Bluetooth permission denied", "PERMISSION_DENIED")
        return false
    }

    // ── Presenter ────────────────────────────────────────────────────────

    @PluginMethod
    fun startPresenting(call: PluginCall) {
        if (!hasBluetooth(call)) return
        val service = uuid(call, "serviceUuid") ?: return
        val characteristic = uuid(call, "characteristicUuid") ?: return
        val timeoutMs = (call.getLong("timeoutMs") ?: MAX_PRESENT_MS).coerceIn(1_000L, MAX_PRESENT_MS)
        presenter.start(service, characteristic, timeoutMs) { error ->
            if (error == null) call.resolve() else call.reject("Could not start Bluetooth", error)
        }
    }

    @PluginMethod
    fun respond(call: PluginCall) {
        val requestId = call.getInt("requestId")
        val data = call.getString("data")?.let(::decodeOrNull)
        if (requestId == null || data == null) {
            call.reject("requestId and data are required", "INVALID_ARGUMENT")
            return
        }
        presenter.respond(requestId, data) { sent ->
            if (sent) call.resolve() else call.reject("No such request", "NOT_FOUND")
        }
    }

    @PluginMethod
    fun stopPresenting(call: PluginCall) {
        presenter.stop()
        call.resolve()
    }

    // ── Scanner ──────────────────────────────────────────────────────────

    @PluginMethod
    fun exchange(call: PluginCall) {
        if (!hasBluetooth(call)) return
        val service = uuid(call, "serviceUuid") ?: return
        val characteristic = uuid(call, "characteristicUuid") ?: return
        val request = call.getString("request")?.let(::decodeOrNull)
        if (request == null || request.size != ExchangeFraming.REQUEST_LENGTH) {
            call.reject("request must be ${ExchangeFraming.REQUEST_LENGTH} bytes", "INVALID_ARGUMENT")
            return
        }
        val timeoutMs = (call.getLong("timeoutMs") ?: MAX_EXCHANGE_MS).coerceIn(1_000L, MAX_EXCHANGE_MS)
        client.exchange(service, characteristic, request, timeoutMs) { outcome ->
            when (outcome) {
                is BleExchangeClient.Outcome.Answer -> call.resolve(JSObject().put("response", encode(outcome.bytes)))
                is BleExchangeClient.Outcome.Failed -> call.reject("Bluetooth exchange failed", outcome.code)
            }
        }
    }

    @PluginMethod
    fun cancelExchange(call: PluginCall) {
        client.cancel()
        call.resolve()
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun requiredAliases(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) listOf(ALIAS_BLUETOOTH) else listOf(ALIAS_LOCATION)

    private fun uuid(call: PluginCall, name: String): UUID? {
        val value = call.getString(name)
        return try {
            UUID.fromString(value)
        } catch (e: IllegalArgumentException) {
            call.reject("$name must be a UUID", "INVALID_ARGUMENT")
            null
        } catch (e: NullPointerException) {
            call.reject("$name is required", "INVALID_ARGUMENT")
            null
        }
    }

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decodeOrNull(value: String): ByteArray? = try {
        Base64.decode(value, Base64.NO_WRAP)
    } catch (e: IllegalArgumentException) {
        null
    }

    companion object {
        const val ALIAS_BLUETOOTH = "bluetooth"
        const val ALIAS_LOCATION = "location"
        private const val MAX_PRESENT_MS = 2 * 60 * 1000L
        private const val MAX_EXCHANGE_MS = 60 * 1000L
    }
}
