package net.massa.gossip.exchange

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * The phone showing the contact code: it advertises the code's service UUID
 * and serves one characteristic. A scanner subscribes, writes its request
 * (one write with response), and gets the answer back as notifications.
 *
 * Its own GATT server and advertising set, separate from the mesh radio.
 * Requests go to JS ([Listener.onRequest]), which seals the keys; this class
 * only frames and sends the bytes. A phone gets one answer, a code a few, and
 * a request not answered in [REQUEST_TIMEOUT_MS] is dropped. Callers must
 * hold the Bluetooth permissions. Every callback runs on [handler].
 */
@SuppressLint("MissingPermission")
class BlePresenter(
    private val context: Context,
    private val handler: Handler,
    private val listener: Listener,
) {
    interface Listener {
        fun onRequest(requestId: Int, request: ByteArray)

        /** The whole answer to [requestId] went out. */
        fun onSent(requestId: Int)
    }

    private class Peer(val device: BluetoothDevice) {
        var mtu = DEFAULT_ATT_MTU
        var subscribed = false
        var requestId: Int? = null
        val queue = ArrayDeque<ByteArray>()
    }

    private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
    private val peers = HashMap<String, Peer>()
    private var budget = PresenterBudget()
    private var nextRequestId = 1
    private var server: BluetoothGattServer? = null
    private var characteristic: BluetoothGattCharacteristic? = null
    private var serviceUuid: UUID? = null
    private var characteristicUuid: UUID? = null
    private var advertising = false
    private var running = false
    private var pendingStart: ((String?) -> Unit)? = null

    /** Starts serving and advertising; [done] gets null, or an error code. */
    fun start(service: UUID, characteristicId: UUID, timeoutMs: Long, done: (String?) -> Unit) {
        handler.post {
            if (running) stopNow()
            val adapter = bluetoothManager?.adapter
            if (adapter == null || !adapter.isEnabled) {
                done("BLUETOOTH_OFF")
                return@post
            }
            if (adapter.bluetoothLeAdvertiser == null) {
                done("UNSUPPORTED")
                return@post
            }
            running = true
            ContactExchangeGate.enter()
            serviceUuid = service
            characteristicUuid = characteristicId
            budget = PresenterBudget()
            try {
                val gattServer = bluetoothManager.openGattServer(context, serverCallback)
                if (gattServer == null) {
                    stopNow()
                    done("UNSUPPORTED")
                    return@post
                }
                val chr = BluetoothGattCharacteristic(
                    characteristicId,
                    BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                    BluetoothGattCharacteristic.PERMISSION_WRITE,
                )
                chr.addDescriptor(
                    BluetoothGattDescriptor(
                        CCCD_UUID,
                        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
                    )
                )
                val gattService = BluetoothGattService(service, BluetoothGattService.SERVICE_TYPE_PRIMARY)
                gattService.addCharacteristic(chr)
                server = gattServer
                characteristic = chr
                // Advertising starts once the service is in the GATT database (onServiceAdded).
                pendingStart = done
                if (!gattServer.addService(gattService)) {
                    pendingStart = null
                    stopNow()
                    done("START_FAILED")
                    return@post
                }
                handler.postDelayed(timeout, timeoutMs)
            } catch (e: SecurityException) {
                Log.w(TAG, "Bluetooth permission missing", e)
                pendingStart = null
                stopNow()
                done("PERMISSION_DENIED")
            }
        }
    }

    fun stop() {
        handler.post { if (running) stopNow() }
    }

    /** Sends [response] to the phone that made [requestId]; false if it is gone. */
    fun respond(requestId: Int, response: ByteArray, done: (Boolean) -> Unit) {
        handler.post {
            val peer = peers.values.firstOrNull { it.requestId == requestId }
            if (!running || peer == null || !peer.subscribed || peer.queue.isNotEmpty() ||
                response.size > ExchangeFraming.MAX_RESPONSE_LENGTH
            ) {
                done(false)
                return@post
            }
            peer.queue.addAll(ExchangeFraming.chunks(response, minOf(peer.mtu - ATT_HEADER_BYTES, MAX_ATT_VALUE)))
            done(true)
            pump(peer)
        }
    }

    private val timeout = Runnable { if (running) stopNow() }

    private fun stopNow() {
        handler.removeCallbacks(timeout)
        handler.removeCallbacksAndMessages(REQUEST_TOKEN)
        try {
            if (advertising) bluetoothManager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
            // Closing the server drops only its own use of the connections: the
            // mesh may share the same link with a phone, so none is cancelled.
            server?.close()
        } catch (e: SecurityException) {
            Log.w(TAG, "Bluetooth permission missing while stopping", e)
        } catch (e: IllegalStateException) {
            // Bluetooth turned off meanwhile: nothing left to stop.
        }
        advertising = false
        server = null
        characteristic = null
        peers.clear()
        pendingStart?.invoke("START_FAILED")
        pendingStart = null
        if (running) ContactExchangeGate.leave()
        running = false
    }

    private fun startAdvertising() {
        val advertiser = bluetoothManager?.adapter?.bluetoothLeAdvertiser
        val service = serviceUuid
        if (advertiser == null || service == null) {
            finishStart("UNSUPPORTED")
            return
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        // Only the code's random UUID: no device name, nothing that names the phone or Gossip.
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(service))
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build()
        advertiser.startAdvertising(settings, data, advertiseCallback)
    }

    private fun finishStart(error: String?) {
        val done = pendingStart ?: return
        pendingStart = null
        if (error != null) stopNow()
        done(error)
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            handler.post {
                if (!running) return@post
                advertising = true
                finishStart(null)
            }
        }

        override fun onStartFailure(errorCode: Int) {
            Log.w(TAG, "Advertising failed: $errorCode")
            handler.post { finishStart("ADVERTISE_FAILED") }
        }
    }

    private fun peer(device: BluetoothDevice): Peer = peers.getOrPut(device.address) { Peer(device) }

    private fun isOurs(chr: BluetoothGattCharacteristic?): Boolean =
        chr != null && chr.uuid == characteristicUuid && chr.service?.uuid == serviceUuid

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            handler.post {
                if (!running || service.uuid != serviceUuid) return@post
                if (status == BluetoothGatt.GATT_SUCCESS) startAdvertising() else finishStart("START_FAILED")
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState != BluetoothProfile.STATE_DISCONNECTED) return
            handler.post {
                val peer = peers.remove(device.address) ?: return@post
                if (peer.requestId != null) budget.release(device.address)
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            handler.post { if (running) peer(device).mtu = mtu }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            if (!isOurs(descriptor.characteristic) || descriptor.uuid != CCCD_UUID) {
                // Another server's descriptor (the mesh's): its own callback answers it.
                return
            }
            val ok = !preparedWrite && offset == 0
            if (responseNeeded) {
                server?.sendResponse(
                    device,
                    requestId,
                    if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED,
                    0,
                    null,
                )
            }
            if (!ok) return
            val enabled = value != null && value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            handler.post { if (running) peer(device).subscribed = enabled }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            if (!isOurs(characteristic)) return
            val request = value?.copyOf()
            handler.post {
                val admitted = running && !preparedWrite && offset == 0 && request != null &&
                    request.size == ExchangeFraming.REQUEST_LENGTH &&
                    peers[device.address]?.subscribed == true &&
                    budget.admit(device.address)
                if (responseNeeded) {
                    server?.sendResponse(
                        device,
                        requestId,
                        if (admitted) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE,
                        0,
                        null,
                    )
                }
                if (!admitted) return@post
                val peer = peer(device)
                val id = nextRequestId++
                peer.requestId = id
                // Not answered in time: forget it, the scanner times out on its side.
                handler.postAtTime(
                    {
                        if (peers[device.address]?.requestId == id && peer.queue.isEmpty()) {
                            peers.remove(device.address)
                            budget.release(device.address)
                        }
                    },
                    REQUEST_TOKEN,
                    android.os.SystemClock.uptimeMillis() + REQUEST_TIMEOUT_MS,
                )
                listener.onRequest(id, request)
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post {
                val peer = peers[device.address] ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    peer.queue.clear()
                    return@post
                }
                pump(peer)
            }
        }
    }

    /** Sends the next chunk; the stack confirms each one with onNotificationSent. */
    private fun pump(peer: Peer) {
        val gattServer = server ?: return
        val chr = characteristic ?: return
        val chunk = peer.queue.removeFirstOrNull()
        if (chunk == null) {
            val id = peer.requestId ?: return
            peer.requestId = null
            budget.release(peer.device.address)
            listener.onSent(id)
            return
        }
        val started = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gattServer.notifyCharacteristicChanged(peer.device, chr, false, chunk) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                chr.value = chunk
                @Suppress("DEPRECATION")
                gattServer.notifyCharacteristicChanged(peer.device, chr, false)
            }
        } catch (e: SecurityException) {
            false
        } catch (e: IllegalArgumentException) {
            // a notification the stack refuses (too long) must not take the app down
            false
        }
        if (!started) {
            peer.queue.clear()
            peer.requestId = null
            budget.release(peer.device.address)
        }
    }

    private companion object {
        const val TAG = "GossipContactExchange"
        const val DEFAULT_ATT_MTU = 23
        const val ATT_HEADER_BYTES = 3
        /** Longest attribute value Bluetooth allows, whatever the MTU; Android throws past it. */
        const val MAX_ATT_VALUE = 512
        const val REQUEST_TIMEOUT_MS = 15_000L
        val REQUEST_TOKEN = Any()
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
