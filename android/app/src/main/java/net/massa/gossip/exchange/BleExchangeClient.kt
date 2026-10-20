package net.massa.gossip.exchange

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * The scanning phone's side: finds the phone advertising the code's service
 * UUID, connects, subscribes, writes the request and reassembles the answer.
 * One exchange at a time; it ends on the answer, a failure, [cancel] or the
 * timeout, and always disconnects. Callers must hold the Bluetooth
 * permissions. Every callback runs on [handler].
 */
@SuppressLint("MissingPermission")
class BleExchangeClient(
    private val context: Context,
    private val handler: Handler,
) {
    /** Result of one exchange: the answer, or an error code. */
    sealed class Outcome {
        class Answer(val bytes: ByteArray) : Outcome()
        class Failed(val code: String) : Outcome()
    }

    private class Attempt(
        val service: UUID,
        val characteristic: UUID,
        val request: ByteArray,
        val done: (Outcome) -> Unit,
    ) {
        var gatt: BluetoothGatt? = null
        var scanning = false
        val assembler = ResponseAssembler()
    }

    private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
    private var attempt: Attempt? = null

    fun exchange(service: UUID, characteristic: UUID, request: ByteArray, timeoutMs: Long, done: (Outcome) -> Unit) {
        handler.post {
            attempt?.let { finish(it, Outcome.Failed("CANCELLED")) }
            val adapter = bluetoothManager?.adapter
            val scanner = adapter?.bluetoothLeScanner
            if (adapter == null || !adapter.isEnabled || scanner == null) {
                done(Outcome.Failed("BLUETOOTH_OFF"))
                return@post
            }
            val current = Attempt(service, characteristic, request, done)
            attempt = current
            ContactExchangeGate.enter()
            handler.postDelayed({ if (attempt === current) finish(current, Outcome.Failed("TIMEOUT")) }, timeoutMs)
            try {
                val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(service)).build())
                val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
                scanner.startScan(filters, settings, scanCallback)
                current.scanning = true
            } catch (e: SecurityException) {
                Log.w(TAG, "Bluetooth permission missing", e)
                finish(current, Outcome.Failed("PERMISSION_DENIED"))
            }
        }
    }

    fun cancel() {
        handler.post { attempt?.let { finish(it, Outcome.Failed("CANCELLED")) } }
    }

    private fun finish(current: Attempt, outcome: Outcome) {
        if (attempt !== current) return
        attempt = null
        stopScan(current)
        current.gatt?.let {
            try {
                it.disconnect()
                it.close()
            } catch (e: SecurityException) {
                Log.w(TAG, "Bluetooth permission missing while closing", e)
            }
        }
        current.gatt = null
        ContactExchangeGate.leave()
        current.done(outcome)
    }

    private fun stopScan(current: Attempt) {
        if (!current.scanning) return
        current.scanning = false
        try {
            if (bluetoothManager?.adapter?.isEnabled == true) {
                bluetoothManager.adapter.bluetoothLeScanner?.stopScan(scanCallback)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Bluetooth permission missing while stopping the scan", e)
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            handler.post { connect(device) }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "Scan failed: $errorCode")
            handler.post { attempt?.let { finish(it, Outcome.Failed("SCAN_FAILED")) } }
        }
    }

    /** The first phone that advertises the code's UUID. */
    private fun connect(device: BluetoothDevice) {
        val current = attempt ?: return
        if (current.gatt != null) return
        stopScan(current)
        current.gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        if (current.gatt == null) finish(current, Outcome.Failed("CONNECT_FAILED"))
    }

    /** The attempt [gatt] belongs to, if it is still the current one. */
    private fun current(gatt: BluetoothGatt): Attempt? = attempt?.takeIf { it.gatt === gatt }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                val current = current(gatt) ?: run {
                    gatt.close()
                    return@post
                }
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!gatt.requestMtu(REQUESTED_ATT_MTU)) finish(current, Outcome.Failed("CONNECT_FAILED"))
                } else {
                    finish(current, Outcome.Failed("DISCONNECTED"))
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            handler.post {
                val current = current(gatt) ?: return@post
                // The 33-byte request must fit one write.
                if (status != BluetoothGatt.GATT_SUCCESS || mtu < ExchangeFraming.REQUEST_LENGTH + 3 ||
                    !gatt.discoverServices()
                ) {
                    finish(current, Outcome.Failed("CONNECT_FAILED"))
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            handler.post {
                val current = current(gatt) ?: return@post
                val chr = gatt.getService(current.service)?.getCharacteristic(current.characteristic)
                val cccd = chr?.getDescriptor(CCCD_UUID)
                if (status != BluetoothGatt.GATT_SUCCESS || chr == null || cccd == null ||
                    !gatt.setCharacteristicNotification(chr, true)
                ) {
                    finish(current, Outcome.Failed("NOT_FOUND"))
                    return@post
                }
                val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ==
                        BluetoothStatusCodes.SUCCESS
                } else {
                    @Suppress("DEPRECATION")
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(cccd)
                }
                if (!started) finish(current, Outcome.Failed("NOT_FOUND"))
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            handler.post {
                val current = current(gatt) ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    finish(current, Outcome.Failed("NOT_FOUND"))
                    return@post
                }
                val chr = descriptor.characteristic
                val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeCharacteristic(chr, current.request, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) ==
                        BluetoothStatusCodes.SUCCESS
                } else {
                    chr.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    @Suppress("DEPRECATION")
                    chr.value = current.request
                    @Suppress("DEPRECATION")
                    gatt.writeCharacteristic(chr)
                }
                if (!started) finish(current, Outcome.Failed("WRITE_FAILED"))
            }
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            handler.post {
                val current = current(gatt) ?: return@post
                // Refused: this code answers no more, or answered this phone already.
                if (status != BluetoothGatt.GATT_SUCCESS) finish(current, Outcome.Failed("REFUSED"))
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            val chunk = value.copyOf()
            handler.post { receive(gatt, characteristic, chunk) }
        }

        @Deprecated("Called before API 33 only")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            @Suppress("DEPRECATION")
            val chunk = characteristic.value?.copyOf() ?: return
            handler.post { receive(gatt, characteristic, chunk) }
        }
    }

    private fun receive(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, chunk: ByteArray) {
        val current = current(gatt) ?: return
        if (characteristic.uuid != current.characteristic) return
        current.assembler.add(chunk)
        if (current.assembler.failed) {
            finish(current, Outcome.Failed("BAD_RESPONSE"))
            return
        }
        current.assembler.result()?.let { finish(current, Outcome.Answer(it)) }
    }

    private companion object {
        const val TAG = "GossipContactExchange"
        const val REQUESTED_ATT_MTU = 517
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
