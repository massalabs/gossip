package net.massa.gossip.mesh

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
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
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random
import net.massa.gossip.exchange.ContactExchangeGate

/**
 * [MeshRadio] over Android BLE. The phone is a GATT peripheral (it advertises
 * the mesh service and accepts writes, sending chunks back as notifications)
 * and a GATT central (it scans for the service, connects, writes chunks and
 * receives notifications) at the same time, up to [MeshConstants.MAX_LINKS]
 * links in both roles together.
 *
 * Every BLE callback is re-posted to one radio thread, which owns all state
 * except the per-link send queues. Callers must hold the Bluetooth runtime
 * permissions before [start]; a revoked permission surfaces as a stopped radio.
 */
@SuppressLint("MissingPermission")
class BleMeshRadio(
    private val context: Context,
    random: Random = Random.Default,
) : MeshRadio {

    private enum class Role { CENTRAL, PERIPHERAL }

    private class Link(
        val id: Int,
        val role: Role,
        val address: String,
        val mtu: Int,
        val upSinceMs: Long,
        val gatt: BluetoothGatt? = null,
        val characteristic: BluetoothGattCharacteristic? = null,
        val device: BluetoothDevice? = null,
    ) {
        val queue = FrameQueue()
        val maxChunk: Int get() = mtu - MeshConstants.ATT_HEADER_BYTES
    }

    /** A connection that is not a link yet: still negotiating MTU, services or notifications. */
    private class Pending(val startedMs: Long, var gatt: BluetoothGatt? = null, var mtu: Int = MeshConstants.DEFAULT_ATT_MTU)

    private val thread = HandlerThread("gossip-mesh-radio").apply { start() }
    private val handler = Handler(thread.looper)
    private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
    private val selector = NeighbourSelector(random = random)
    private val inboundGate = InboundGate()
    private val nextLinkId = AtomicInteger(1)

    // Read from any thread by sendFrame/linkCount, written on the radio thread only.
    private val links = ConcurrentHashMap<Int, Link>()
    private val linkByAddress = HashMap<String, Int>()
    private val pendingCentral = HashMap<String, Pending>()
    private val pendingPeripheral = HashMap<String, Pending>()

    private var listener: MeshRadioListener? = null
    private var mode = PowerMode.BALANCED
    private var running = false
    private var scanning = false
    private var advertising = false
    private var gattServer: BluetoothGattServer? = null
    private var serverCharacteristic: BluetoothGattCharacteristic? = null
    private var stateReceiverRegistered = false

    override fun start(mode: PowerMode, listener: MeshRadioListener) {
        handler.post {
            if (running) return@post
            this.mode = mode
            this.listener = listener
            running = true
            registerStateReceiver()
            startRadio()
        }
    }

    override fun stop() {
        handler.post {
            if (!running) return@post
            running = false
            stopRadio()
            unregisterStateReceiver()
            listener = null
        }
    }

    override fun setPowerMode(mode: PowerMode) {
        handler.post {
            if (this.mode == mode) return@post
            this.mode = mode
            if (running && isAdapterOn()) {
                stopAdvertising()
                startAdvertising()
                restartScanCycle()
                scheduleRotation()
            }
        }
    }

    override fun sendFrame(linkId: Int, frame: ByteArray): Boolean {
        val link = links[linkId] ?: return false
        if (frame.size > link.maxChunk) return false
        if (!link.queue.offer(frame)) return false
        handler.post { pump(linkId) }
        return true
    }

    override fun closeLink(linkId: Int) {
        handler.post {
            val link = links[linkId] ?: return@post
            disconnect(link)
            removeLink(link)
            // closed by the core right away: most often a second link to a phone we
            // are already linked with, which would otherwise be redialled every cooldown
            val now = SystemClock.elapsedRealtime()
            if (link.role == Role.CENTRAL && now - link.upSinceMs < MeshConstants.QUICK_CLOSE_MS) {
                selector.onRefused(link.address, now)
            }
        }
    }

    override fun linkCount(): Int = links.size

    // ── Lifecycle ────────────────────────────────────────────────────────

    private fun isAdapterOn(): Boolean = bluetoothManager?.adapter?.isEnabled == true

    private fun startRadio() {
        if (!isAdapterOn()) {
            Log.i(TAG, "Bluetooth is off; waiting for it")
            return
        }
        try {
            openGattServer()
            startAdvertising()
            restartScanCycle()
            scheduleRotation()
            handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)
        } catch (e: SecurityException) {
            Log.w(TAG, "Bluetooth permission missing", e)
            stopRadio()
        }
    }

    private fun stopRadio() {
        handler.removeCallbacks(scanCycle)
        handler.removeCallbacks(rotation)
        handler.removeCallbacks(watchdog)
        handler.removeCallbacks(evaluate)
        try {
            stopScan()
            stopAdvertising()
            for (link in links.values.toList()) {
                disconnect(link)
                removeLink(link)
            }
            for (pending in pendingCentral.values) pending.gatt?.close()
            pendingCentral.clear()
            pendingPeripheral.clear()
            gattServer?.close()
        } catch (e: SecurityException) {
            Log.w(TAG, "Bluetooth permission missing while stopping", e)
        }
        gattServer = null
        serverCharacteristic = null
    }

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
            handler.post {
                if (!running) return@post
                when (state) {
                    BluetoothAdapter.STATE_ON -> startRadio()
                    BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> stopRadio()
                }
            }
        }
    }

    private fun registerStateReceiver() {
        if (stateReceiverRegistered) return
        ContextCompat.registerReceiver(
            context,
            stateReceiver,
            IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        stateReceiverRegistered = true
    }

    private fun unregisterStateReceiver() {
        if (!stateReceiverRegistered) return
        context.unregisterReceiver(stateReceiver)
        stateReceiverRegistered = false
    }

    // ── Peripheral role ──────────────────────────────────────────────────

    private fun openGattServer() {
        if (gattServer != null) return
        val server = bluetoothManager?.openGattServer(context, serverCallback) ?: return
        val characteristic = BluetoothGattCharacteristic(
            MeshConstants.CHUNK_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        characteristic.addDescriptor(
            BluetoothGattDescriptor(
                MeshConstants.CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            )
        )
        val service = BluetoothGattService(MeshConstants.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(characteristic)
        server.addService(service)
        gattServer = server
        serverCharacteristic = characteristic
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            Log.w(TAG, "Advertising failed: $errorCode")
            handler.post { advertising = false }
        }
    }

    private fun startAdvertising() {
        if (advertising) return
        val advertiser = bluetoothManager?.adapter?.bluetoothLeAdvertiser ?: return
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(
                if (mode.lowLatencyAdvertising) AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY
                else AdvertiseSettings.ADVERTISE_MODE_BALANCED
            )
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        // No device name: it would identify the phone, and the UUID already fills most of the 31 bytes.
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(MeshConstants.SERVICE_UUID))
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build()
        advertiser.startAdvertising(settings, data, advertiseCallback)
        advertising = true
    }

    private fun stopAdvertising() {
        if (!advertising) return
        bluetoothManager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
        advertising = false
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post { onServerConnectionState(device, newState) }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            handler.post { pendingPeripheral[device.address]?.mtu = mtu }
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
            if (preparedWrite || offset != 0) {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null)
                }
                return
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
            if (descriptor.uuid != MeshConstants.CCCD_UUID) return
            val enabled = value != null &&
                value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            handler.post { onNotificationsSubscribed(device, enabled) }
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
            // a chunk is one plain write: long (prepared) writes and offsets are refused
            if (preparedWrite || offset != 0) {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null)
                }
                return
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
            if (characteristic.uuid != MeshConstants.CHUNK_CHARACTERISTIC_UUID || value == null) return
            val chunk = value.copyOf()
            handler.post { deliver(device.address, Role.PERIPHERAL, chunk) }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post {
                val link = linkFor(device.address, Role.PERIPHERAL) ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    closeNow(link)
                    return@post
                }
                link.queue.onSent()
                pump(link.id)
            }
        }
    }

    private fun onServerConnectionState(device: BluetoothDevice, newState: Int) {
        val address = device.address
        if (newState == BluetoothProfile.STATE_CONNECTED) {
            // The server callback also reports the connections this phone opened as
            // central; cancelling one of those would drop that link too.
            if (!isCentralTo(address) &&
                (!running || busyCount() >= MeshConstants.MAX_LINKS ||
                    !inboundGate.admit(address, inboundCount(), SystemClock.elapsedRealtime()))
            ) {
                // A contact exchange shares the app's connections: cancelling this
                // one could cut its link, so while one runs it is only left unused.
                if (!ContactExchangeGate.active) gattServer?.cancelConnection(device)
                return
            }
            pendingPeripheral[address] = Pending(SystemClock.elapsedRealtime())
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            pendingPeripheral.remove(address)
            linkFor(address, Role.PERIPHERAL)?.let { removeLink(it) }
        }
    }

    /** A central enabled notifications: the link works both ways from now on. */
    private fun onNotificationsSubscribed(device: BluetoothDevice, enabled: Boolean) {
        val address = device.address
        if (!enabled) {
            linkFor(address, Role.PERIPHERAL)?.let { closeNow(it) }
            return
        }
        val pending = pendingPeripheral.remove(address) ?: return
        addLink(
            Link(
                id = nextLinkId.getAndIncrement(),
                role = Role.PERIPHERAL,
                address = address,
                mtu = pending.mtu,
                upSinceMs = SystemClock.elapsedRealtime(),
                device = device,
            )
        )
    }

    // ── Central role ─────────────────────────────────────────────────────

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val address = result.device.address
            val rssi = result.rssi
            handler.post {
                selector.onSeen(address, rssi, SystemClock.elapsedRealtime())
                scheduleEvaluate()
            }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            for (result in results) onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, result)
        }

        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "Scan failed: $errorCode")
            handler.post { scanning = false }
        }
    }

    /** Scans for [PowerMode.scanOnMs], pauses for [PowerMode.scanOffMs], and again. */
    private val scanCycle = object : Runnable {
        override fun run() {
            if (!running || !isAdapterOn()) return
            if (scanning) {
                stopScan()
                handler.postDelayed(this, mode.scanOffMs)
            } else {
                startScan()
                handler.postDelayed(this, mode.scanOnMs)
            }
        }
    }

    private fun restartScanCycle() {
        handler.removeCallbacks(scanCycle)
        stopScan()
        handler.post(scanCycle)
    }

    private fun startScan() {
        val scanner = bluetoothManager?.adapter?.bluetoothLeScanner ?: return
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(MeshConstants.SERVICE_UUID)).build())
        val settings = ScanSettings.Builder()
            .setScanMode(
                if (mode == PowerMode.PERFORMANCE) ScanSettings.SCAN_MODE_LOW_LATENCY
                else ScanSettings.SCAN_MODE_BALANCED
            )
            .build()
        scanner.startScan(filters, settings, scanCallback)
        scanning = true
    }

    private fun stopScan() {
        if (!scanning) return
        if (isAdapterOn()) bluetoothManager?.adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        scanning = false
    }

    private val evaluate = Runnable { connectToNewNeighbours() }

    /** Coalesces the scan results of one moment into one decision. */
    private fun scheduleEvaluate() {
        handler.removeCallbacks(evaluate)
        handler.postDelayed(evaluate, EVALUATE_DELAY_MS)
    }

    private fun connectToNewNeighbours() {
        if (!running || !isAdapterOn()) return
        val adapter = bluetoothManager?.adapter ?: return
        val busy = HashSet<String>().apply {
            addAll(linkByAddress.keys)
            addAll(pendingCentral.keys)
            addAll(pendingPeripheral.keys)
        }
        for (address in selector.pickConnections(busy, SystemClock.elapsedRealtime())) {
            try {
                val device = adapter.getRemoteDevice(address)
                val gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
                    ?: continue
                pendingCentral[address] = Pending(SystemClock.elapsedRealtime(), gatt)
            } catch (e: IllegalArgumentException) {
                // the exception message holds the address: not logged
                Log.w(TAG, "Bad address from scan")
            }
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            handler.post { onClientConnectionState(gatt, status, newState) }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            handler.post {
                val pending = pendingCentral[gatt.device.address] ?: return@post
                if (status == BluetoothGatt.GATT_SUCCESS) pending.mtu = mtu
                if (!gatt.discoverServices()) abandon(gatt)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            handler.post { subscribe(gatt, status) }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            handler.post { onSubscribed(gatt, descriptor, status) }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            val chunk = value.copyOf()
            handler.post { deliver(gatt.device.address, Role.CENTRAL, chunk) }
        }

        @Deprecated("Called before API 33 only")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            @Suppress("DEPRECATION")
            val chunk = characteristic.value?.copyOf() ?: return
            handler.post { deliver(gatt.device.address, Role.CENTRAL, chunk) }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            handler.post {
                val link = linkFor(gatt.device.address, Role.CENTRAL) ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    closeNow(link)
                    return@post
                }
                link.queue.onSent()
                pump(link.id)
            }
        }
    }

    private fun onClientConnectionState(gatt: BluetoothGatt, status: Int, newState: Int) {
        val address = gatt.device.address
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
            if (!running || pendingCentral[address]?.gatt !== gatt) {
                gatt.disconnect()
                gatt.close()
                return
            }
            if (!gatt.requestMtu(MeshConstants.REQUESTED_ATT_MTU)) abandon(gatt)
            return
        }
        // Disconnected, or the connection attempt failed.
        if (pendingCentral[address]?.gatt === gatt) {
            pendingCentral.remove(address)
            selector.onDisconnected(address, SystemClock.elapsedRealtime())
        }
        val link = linkFor(address, Role.CENTRAL)
        if (link != null && link.gatt === gatt) removeLink(link)
        gatt.close()
    }

    private fun subscribe(gatt: BluetoothGatt, status: Int) {
        if (pendingCentral[gatt.device.address]?.gatt !== gatt) return
        val characteristic = gatt.getService(MeshConstants.SERVICE_UUID)
            ?.getCharacteristic(MeshConstants.CHUNK_CHARACTERISTIC_UUID)
        val cccd = characteristic?.getDescriptor(MeshConstants.CCCD_UUID)
        if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null || cccd == null ||
            !gatt.setCharacteristicNotification(characteristic, true)
        ) {
            abandon(gatt)
            return
        }
        val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            @Suppress("DEPRECATION")
            gatt.writeDescriptor(cccd)
        }
        if (!started) abandon(gatt)
    }

    /** Notifications are on: the link works both ways from now on. */
    private fun onSubscribed(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
        val address = gatt.device.address
        val pending = pendingCentral[address]
        if (pending?.gatt !== gatt || descriptor.uuid != MeshConstants.CCCD_UUID) return
        if (status != BluetoothGatt.GATT_SUCCESS) {
            abandon(gatt)
            return
        }
        pendingCentral.remove(address)
        addLink(
            Link(
                id = nextLinkId.getAndIncrement(),
                role = Role.CENTRAL,
                address = address,
                mtu = pending.mtu,
                upSinceMs = SystemClock.elapsedRealtime(),
                gatt = gatt,
                characteristic = descriptor.characteristic,
            )
        )
    }

    /** Gives up on a connection that is not a link yet. */
    private fun abandon(gatt: BluetoothGatt) {
        val address = gatt.device.address
        if (pendingCentral[address]?.gatt === gatt) {
            pendingCentral.remove(address)
            selector.onDisconnected(address, SystemClock.elapsedRealtime())
        }
        gatt.disconnect()
        gatt.close()
    }

    // ── Links ────────────────────────────────────────────────────────────

    private fun isCentralTo(address: String): Boolean =
        pendingCentral.containsKey(address) || linkFor(address, Role.CENTRAL) != null

    private fun busyCount(): Int = links.size + pendingCentral.size + pendingPeripheral.size

    private fun inboundCount(): Int = pendingPeripheral.size + links.values.count { it.role == Role.PERIPHERAL }

    private fun linkFor(address: String, role: Role): Link? {
        val link = linkByAddress[address]?.let { links[it] } ?: return null
        return if (link.role == role) link else null
    }

    private fun addLink(link: Link) {
        // Both phones may have connected to each other; the core keeps one per peer id
        // and closes the other, so only an exact duplicate (same address and role) is refused.
        if (linkFor(link.address, link.role) != null) {
            disconnect(link)
            return
        }
        links[link.id] = link
        linkByAddress[link.address] = link.id
        listener?.onLinkUp(link.id, link.mtu)
    }

    private fun removeLink(link: Link) {
        if (links.remove(link.id) == null) return
        if (linkByAddress[link.address] == link.id) linkByAddress.remove(link.address)
        link.queue.clear()
        selector.onDisconnected(link.address, SystemClock.elapsedRealtime())
        if (link.role == Role.PERIPHERAL) inboundGate.onClosed(link.address, SystemClock.elapsedRealtime())
        listener?.onLinkDown(link.id)
        scheduleEvaluate()
    }

    private fun disconnect(link: Link) {
        when (link.role) {
            Role.CENTRAL -> link.gatt?.let {
                it.disconnect()
                it.close()
            }
            Role.PERIPHERAL -> link.device?.let { gattServer?.cancelConnection(it) }
        }
    }

    private fun closeNow(link: Link) {
        disconnect(link)
        removeLink(link)
    }

    private fun deliver(address: String, role: Role, chunk: ByteArray) {
        val link = linkFor(address, role) ?: return
        listener?.onFrameIn(link.id, chunk)
    }

    /** Hands the link's next queued chunk to the stack, if none is in flight. A refused send closes the link. */
    private fun pump(linkId: Int) {
        val link = links[linkId] ?: return
        val chunk = link.queue.takeNext(SystemClock.elapsedRealtime()) ?: return
        val started = when (link.role) {
            Role.CENTRAL -> writeChunk(link, chunk)
            Role.PERIPHERAL -> notifyChunk(link, chunk)
        }
        if (!started) closeNow(link)
    }

    private fun writeChunk(link: Link, chunk: ByteArray): Boolean {
        val gatt = link.gatt ?: return false
        val characteristic = link.characteristic ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeCharacteristic(
                characteristic,
                chunk,
                BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
            ) == BluetoothStatusCodes.SUCCESS
        } else {
            characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            characteristic.value = chunk
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(characteristic)
        }
    }

    private fun notifyChunk(link: Link, chunk: ByteArray): Boolean {
        val server = gattServer ?: return false
        val device = link.device ?: return false
        val characteristic = serverCharacteristic ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicChanged(device, characteristic, false, chunk) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            characteristic.value = chunk
            @Suppress("DEPRECATION")
            server.notifyCharacteristicChanged(device, characteristic, false)
        }
    }

    // ── Rotation and watchdog ────────────────────────────────────────────

    /** Every rotation interval, one long-lived link makes room for a new random neighbour. */
    private val rotation = object : Runnable {
        override fun run() {
            if (!running) return
            val now = SystemClock.elapsedRealtime()
            val upSince = links.values.associate { it.address to it.upSinceMs }
            selector.pickRotationVictim(upSince, now, mode.rotationIntervalMs)?.let { address ->
                linkByAddress[address]?.let { links[it] }?.let { closeNow(it) }
            }
            handler.postDelayed(this, mode.rotationIntervalMs)
        }
    }

    private fun scheduleRotation() {
        handler.removeCallbacks(rotation)
        handler.postDelayed(rotation, mode.rotationIntervalMs)
    }

    /** Drops connections stuck before becoming links, and links whose stack stopped confirming sends. */
    private val watchdog = object : Runnable {
        override fun run() {
            if (!running) return
            val now = SystemClock.elapsedRealtime()
            for ((address, pending) in pendingCentral.entries.toList()) {
                if (now - pending.startedMs > CONNECT_TIMEOUT_MS) pending.gatt?.let { abandon(it) }
                    ?: pendingCentral.remove(address)
            }
            for ((address, pending) in pendingPeripheral.entries.toList()) {
                if (now - pending.startedMs > CONNECT_TIMEOUT_MS) {
                    pendingPeripheral.remove(address)
                    if (isCentralTo(address) || ContactExchangeGate.active) continue
                    try {
                        bluetoothManager?.adapter?.getRemoteDevice(address)?.let { gattServer?.cancelConnection(it) }
                    } catch (e: IllegalArgumentException) {
                        Log.w(TAG, "Bad pending address")
                    }
                }
            }
            for (link in links.values.toList()) {
                if (link.queue.isStuck(now, SEND_TIMEOUT_MS)) closeNow(link)
            }
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }

    private companion object {
        const val TAG = "GossipMeshRadio"
        const val EVALUATE_DELAY_MS = 500L
        const val CONNECT_TIMEOUT_MS = 20_000L
        const val SEND_TIMEOUT_MS = 5_000L
        const val WATCHDOG_INTERVAL_MS = 5_000L
    }
}
