package net.massa.gossip.mesh

import android.Manifest
import android.os.Build
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import org.json.JSONException

/**
 * The MeshNode plugin: the `MeshNodePlugin` interface of the SDK
 * (gossip-sdk `api/messageProtocol/mesh.ts`) over [MeshNodeBridge]. Binary
 * values cross the bridge as standard base64.
 *
 * `start` asks for the Bluetooth permissions it needs (location before
 * Android 12, where BLE scanning required it), starts the core, then the
 * foreground [MeshService] that runs the radio.
 *
 * Events: `arrival` ({ messages: [{ seeker, ciphertext }], announcements })
 * and `status` ({ links }) when the number of radio links changes.
 */
@CapacitorPlugin(
    name = "MeshNode",
    permissions = [
        Permission(
            strings = [
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            ],
            alias = MeshNodePlugin.ALIAS_BLUETOOTH,
        ),
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = MeshNodePlugin.ALIAS_LOCATION),
    ],
)
class MeshNodePlugin : Plugin() {

    // Resolves calls off the bridge thread: core calls can block.
    private val replies = Executors.newSingleThreadExecutor { Thread(it, "gossip-mesh-replies") }

    private val arrivalListener = MeshNodeBridge.ArrivalListener { messages, announcements ->
        val payload = JSObject()
        payload.put("messages", JSArray().apply {
            for (m in messages) {
                put(JSObject().put("seeker", encode(m.key)).put("ciphertext", encode(m.value)))
            }
        })
        payload.put("announcements", JSArray().apply { for (a in announcements) put(encode(a)) })
        notifyListeners("arrival", payload)
    }

    private val linksListener = MeshNodeBridge.LinksListener { count ->
        notifyListeners("status", JSObject().put("links", count))
    }

    override fun load() {
        MeshNodeBridge.addArrivalListener(arrivalListener)
        MeshNodeBridge.addLinksListener(linksListener)
    }

    override fun handleOnDestroy() {
        MeshNodeBridge.removeArrivalListener(arrivalListener)
        MeshNodeBridge.removeLinksListener(linksListener)
        replies.shutdown()
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    @PluginMethod
    fun start(call: PluginCall) {
        val missing = requiredAliases().filter { getPermissionState(it) != PermissionState.GRANTED }
        if (missing.isEmpty()) {
            startNode(call)
        } else {
            requestPermissionForAliases(missing.toTypedArray(), call, "onStartPermissions")
        }
    }

    @PermissionCallback
    private fun onStartPermissions(call: PluginCall) {
        if (requiredAliases().all { getPermissionState(it) == PermissionState.GRANTED }) {
            startNode(call)
        } else {
            call.reject("Bluetooth permission denied", "PERMISSION_DENIED")
        }
    }

    private fun startNode(call: PluginCall) {
        val config = call.getObject("config")?.toString() ?: "{}"
        val mode = PowerMode.fromName(call.getString("powerMode"))
        replies.execute {
            try {
                MeshNodeBridge.startCore(context, config)
                MeshService.start(context, config, mode)
                call.resolve()
            } catch (e: Exception) {
                call.reject("Could not start the mesh node", "START_FAILED", e)
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        replies.execute {
            MeshService.stop(context)
            MeshNodeBridge.stopCore()
            call.resolve()
        }
    }

    @PluginMethod
    fun setPowerMode(call: PluginCall) {
        MeshService.setPowerMode(context, PowerMode.fromName(call.getString("powerMode")))
        call.resolve()
    }

    // ── Node API ─────────────────────────────────────────────────────────

    @PluginMethod
    fun sendBlob(call: PluginCall) {
        reply(call) { core ->
            val kind = MeshBlobKind.fromWireName(call.getString("kind"))
                ?: throw IllegalArgumentException("unknown blob kind")
            val payload = decode(call.getString("payload") ?: throw IllegalArgumentException("payload is required"))
            val key = call.getString("key")?.let(::decode)
            if (kind == MeshBlobKind.MESSAGE && key == null) {
                throw IllegalArgumentException("a message needs its seeker as key")
            }
            val result = core.sendBlob(kind, key, payload)
            JSObject().put("id", encode(result.id)).apply { result.counter?.let { put("counter", it) } }
        }
    }

    @PluginMethod
    fun fetch(call: PluginCall) {
        reply(call) { core ->
            val seekers = stringList(call, "seekers").map(::decode)
            val messages = JSArray()
            for (m in core.fetch(seekers)) {
                messages.put(JSObject().put("seeker", encode(m.key)).put("ciphertext", encode(m.value)))
            }
            JSObject().put("messages", messages)
        }
    }

    @PluginMethod
    fun fetchBulletin(call: PluginCall) {
        val cursor = call.getString("cursor")
        val limit = call.getInt("limit") ?: DEFAULT_BULLETIN_LIMIT
        reply(call) { core ->
            val items = JSArray()
            for (item in core.fetchBulletin(cursor, limit)) {
                items.put(JSObject().put("counter", item.counter).put("data", encode(item.data)))
            }
            JSObject().put("items", items)
        }
    }

    @PluginMethod
    fun getKeys(call: PluginCall) {
        reply(call) { core ->
            val hash = decode(call.getString("hash") ?: throw IllegalArgumentException("hash is required"))
            JSObject().apply { core.getKeys(hash)?.let { put("keys", encode(it)) } }
        }
    }

    @PluginMethod
    fun setWanted(call: PluginCall) {
        reply(call) { core ->
            core.setWanted(stringList(call, "seekers").map(::decode))
            JSObject()
        }
    }

    @PluginMethod
    fun setUpstream(call: PluginCall) {
        reply(call) { core ->
            core.setUpstream(stringList(call, "urls"), call.getBoolean("bridgeEnabled") ?: false)
            JSObject()
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        if (!MeshNodeBridge.isCoreRunning()) {
            call.resolve(
                JSObject()
                    .put("running", false)
                    .put("meshPeers", 0)
                    .put("upstreamReachable", false)
                    .put("bridgeEnabled", false)
                    .put("bulletinCounter", "0")
                    .put("storedBlobs", 0)
            )
            return
        }
        reply(call) { core ->
            val status = core.status()
            JSObject()
                .put("running", status.running)
                .put("meshPeers", status.meshPeers)
                .put("upstreamReachable", status.upstreamReachable)
                .put("bridgeEnabled", status.bridgeEnabled)
                .put("bulletinCounter", status.bulletinCounter)
                .put("storedBlobs", status.storedBlobs)
                .put("linksHandshaking", status.linksHandshaking)
                .put("meshBlobs", status.meshBlobs)
                .put("uploadPending", status.uploadPending)
                .put("wantedEntries", status.wantedEntries)
                .put("clockOffsetMs", status.clockOffsetMs)
                .put("peerId", status.peerId)
                .put("radioLinks", MeshNodeBridge.linkCount())
                .put("rustCore", MeshCoreFactory.hasRustCore())
        }
    }

    @PluginMethod
    fun wipe(call: PluginCall) {
        reply(call) { core ->
            core.wipe()
            JSObject()
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun requiredAliases(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) listOf(ALIAS_BLUETOOTH) else listOf(ALIAS_LOCATION)

    private fun reply(call: PluginCall, block: (MeshCore) -> JSObject) {
        replies.execute {
            try {
                call.resolve(MeshNodeBridge.call(block).get())
            } catch (e: ExecutionException) {
                val cause = e.cause ?: e
                if (cause is IllegalStateException) {
                    call.reject(cause.message, "NOT_STARTED")
                } else if (cause is IllegalArgumentException || cause is JSONException) {
                    call.reject(cause.message ?: "Invalid argument", "INVALID_ARGUMENT")
                } else {
                    call.reject(cause.message ?: "Mesh node call failed", "NODE_ERROR", cause as? Exception)
                }
            }
        }
    }

    private fun stringList(call: PluginCall, name: String): List<String> =
        call.getArray(name)?.toList<String>() ?: emptyList()

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decode(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)

    companion object {
        const val ALIAS_BLUETOOTH = "bluetooth"
        const val ALIAS_LOCATION = "location"
        private const val DEFAULT_BULLETIN_LIMIT = 100
    }
}
