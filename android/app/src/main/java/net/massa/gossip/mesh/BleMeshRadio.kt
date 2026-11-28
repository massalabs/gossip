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
import net.massa.gossip.DebugLog
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

    private class Link(
        val id: Int,
        val role: LinkRole,
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
    private val admission = PeripheralAdmission()
    private val nextLinkId = AtomicInteger(1)

    // Read from any thread by sendFrame/linkCount, written on the radio thread only.
    private val links = ConcurrentHashMap<Int, Link>()
    private val linkIndex = LinkIndex()
    private val pendingCentral = HashMap<String, Pending>()

    /** GATT clients of closed central links, kept open while a peripheral link to the same device is up (see [LinkClosing.Action.PARK]). */
    private val parkedCentral = HashMap<String, BluetoothGatt>()

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
            if (link.role == LinkRole.CENTRAL && now - link.upSinceMs < MeshConstants.QUICK_CLOSE_MS) {
                selector.onRefused(link.address, now)
            }
        }
    }

    // Links, not phones: two links to one phone count as two until the core closes one.
    override fun linkCount(): Int = links.size

    // ── Lifecycle ────────────────────────────────────────────────────────

    private fun isAdapterOn(): Boolean = bluetoothManager?.adapter?.isEnabled == true

    private fun startRadio() {
        if (!isAdapterOn()) {
            DebugLog.i(TAG, "Bluetooth is off; waiting for it")
            return
        }
        try {
            openGattServer()
            startAdvertising()
            restartScanCycle()
            scheduleRotation()
            handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)
        } catch (e: SecurityException) {
            DebugLog.w(TAG, "Bluetooth permission missing", e)
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
            for (gatt in parkedCentral.values) gatt.close()
            parkedCentral.clear()
            admission.clear()
            gattServer?.close()
        } catch (e: SecurityException) {
            DebugLog.w(TAG, "Bluetooth permission missing while stopping", e)
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
            DebugLog.w(TAG, "Advertising failed: $errorCode")
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
            handler.post { admission.onMtuChanged(device.address, mtu) }
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
            if (descriptor.uuid != MeshConstants.CCCD_UUID ||
                descriptor.characteristic?.uuid != MeshConstants.CHUNK_CHARACTERISTIC_UUID
            ) {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                }
                return
            }
            val enabled = value != null &&
                value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            // Answered on the radio thread: whether the subscribe is accepted depends on its state.
            handler.post { onNotificationsSubscribed(device, requestId, responseNeeded, enabled) }
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
            handler.post { onChunkWritten(device, chunk) }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post {
                val link = linkFor(device.address, LinkRole.PERIPHERAL) ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    closeNow(link)
                    return@post
                }
                link.queue.onSent()
                pump(link.id)
            }
        }
    }

    /**
     * Android reports here every Bluetooth LE device connected to the phone,
     * not only mesh centrals: the user's earbuds or watch, other apps' devices,
     * this phone's own central connections, the contact exchange. A connection
     * is therefore not a mesh peer; it becomes one only when it uses the mesh
     * service (see [PeripheralAdmission]). Connects are ignored, and so is the
     * disconnect of a device that never used the service.
     */
    private fun onServerConnectionState(device: BluetoothDevice, newState: Int) {
        if (newState != BluetoothProfile.STATE_DISCONNECTED) return
        val address = device.address
        admission.onDisconnected(address)
        linkFor(address, LinkRole.PERIPHERAL)?.let { removeLink(it) }
    }

    private fun slotsFor(address: String) = PeripheralAdmission.Slots(
        running = running,
        busy = links.size + pendingCentral.size,
        inboundLinks = links.values.count { it.role == LinkRole.PERIPHERAL },
        isCentralTo = isCentralTo(address),
        exchangeActive = ContactExchangeGate.active,
    )

    /**
     * A central wrote the CCCD of the chunk characteristic: its first use of
     * the mesh service, where the limits and the inbound gate apply. Enabled
     * and admitted, the link works both ways from now on.
     */
    private fun onNotificationsSubscribed(device: BluetoothDevice, requestId: Int, responseNeeded: Boolean, enabled: Boolean) {
        val address = device.address
        if (!enabled) {
            respond(device, requestId, responseNeeded, BluetoothGatt.GATT_SUCCESS)
            linkFor(address, LinkRole.PERIPHERAL)?.let { closeNow(it) }
            return
        }
        if (linkFor(address, LinkRole.PERIPHERAL) != null) {
            respond(device, requestId, responseNeeded, BluetoothGatt.GATT_SUCCESS)
            return
        }
        when (val verdict = admission.onSubscribe(address, slotsFor(address), SystemClock.elapsedRealtime())) {
            is PeripheralAdmission.Verdict.Admit -> {
                respond(device, requestId, responseNeeded, BluetoothGatt.GATT_SUCCESS)
                addLink(
                    Link(
                        id = nextLinkId.getAndIncrement(),
                        role = LinkRole.PERIPHERAL,
                        address = address,
                        mtu = verdict.mtu,
                        upSinceMs = SystemClock.elapsedRealtime(),
                        device = device,
                    )
                )
            }
            is PeripheralAdmission.Verdict.Refuse -> {
                // A failed subscribe makes a Gossip central give up and disconnect on
                // its own (Android: onSubscribed abandons the connection; iOS:
                // didUpdateNotificationStateFor with an error abandons it). The cancel
                // also covers a central that ignores the error.
                respond(device, requestId, responseNeeded, SUBSCRIBE_REFUSED_STATUS)
                if (verdict.cancel) gattServer?.cancelConnection(device)
            }
            PeripheralAdmission.Verdict.Wait -> respond(device, requestId, responseNeeded, BluetoothGatt.GATT_SUCCESS)
        }
    }

    /** A chunk from a central: delivered on its link, or, with no link yet, a first use of the mesh service. */
    private fun onChunkWritten(device: BluetoothDevice, chunk: ByteArray) {
        val address = device.address
        linkFor(address, LinkRole.PERIPHERAL)?.let {
            listener?.onFrameIn(it.id, chunk)
            return
        }
        val verdict = admission.onWriteBeforeSubscribe(address, slotsFor(address), SystemClock.elapsedRealtime())
        if (verdict is PeripheralAdmission.Verdict.Refuse && verdict.cancel) gattServer?.cancelConnection(device)
    }

    private fun respond(device: BluetoothDevice, requestId: Int, responseNeeded: Boolean, status: Int) {
        if (responseNeeded) gattServer?.sendResponse(device, requestId, status, 0, null)
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
            DebugLog.w(TAG, "Scan failed: $errorCode")
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
        // One filter per supported mesh version: a phone advertising any of them is a candidate.
        val filters = MeshConstants.SUPPORTED_SERVICE_UUIDS.map {
            ScanFilter.Builder().setServiceUuid(ParcelUuid(it)).build()
        }
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
            addAll(linkIndex.addresses())
            addAll(pendingCentral.keys)
            addAll(admission.pendingAddresses())
        }
        for (address in selector.pickConnections(busy, SystemClock.elapsedRealtime())) {
            try {
                val device = adapter.getRemoteDevice(address)
                val gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
                    ?: continue
                pendingCentral[address] = Pending(SystemClock.elapsedRealtime(), gatt)
            } catch (e: IllegalArgumentException) {
                // the exception message holds the address: not logged
                DebugLog.w(TAG, "Bad address from scan")
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
            handler.post { centralLinkOf(gatt)?.let { listener?.onFrameIn(it.id, chunk) } }
        }

        @Deprecated("Called before API 33 only")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            @Suppress("DEPRECATION")
            val chunk = characteristic.value?.copyOf() ?: return
            handler.post { centralLinkOf(gatt)?.let { listener?.onFrameIn(it.id, chunk) } }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            handler.post {
                val link = centralLinkOf(gatt) ?: return@post
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
        centralLinkOf(gatt)?.let { removeLink(it) }
        if (parkedCentral[address] === gatt) parkedCentral.remove(address)
        gatt.close()
    }

    private fun subscribe(gatt: BluetoothGatt, status: Int) {
        if (pendingCentral[gatt.device.address]?.gatt !== gatt) return
        val characteristic = MeshConstants.SUPPORTED_SERVICE_UUIDS.firstNotNullOfOrNull { gatt.getService(it) }
            ?.getCharacteristic(MeshConstants.CHUNK_CHARACTERISTIC_UUID)
        val cccd = characteristic?.getDescriptor(MeshConstants.CCCD_UUID)
        if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null || cccd == null ||
            !gatt.setCharacteristicNotification(characteristic, true)
        ) {
            abandon(gatt)
            return
        }
        if (!writeCccd(gatt, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) abandon(gatt)
    }

    private fun writeCccd(gatt: BluetoothGatt, cccd: BluetoothGattDescriptor, value: ByteArray): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            cccd.value = value
            @Suppress("DEPRECATION")
            gatt.writeDescriptor(cccd)
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
                role = LinkRole.CENTRAL,
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
        pendingCentral.containsKey(address) || linkFor(address, LinkRole.CENTRAL) != null

    // By address and role: both phones may connect to each other at once, and each of the
    // two links to one address must get its own chunks and confirmations (see LinkIndex).
    private fun linkFor(address: String, role: LinkRole): Link? = linkIndex.get(address, role)?.let { links[it] }

    /** The central link carried by [gatt]: a parked or stale client of the same address is not it. */
    private fun centralLinkOf(gatt: BluetoothGatt): Link? =
        linkFor(gatt.device.address, LinkRole.CENTRAL)?.takeIf { it.gatt === gatt }

    private fun addLink(link: Link) {
        // Both phones may have connected to each other; the core keeps one per peer id
        // and closes the other, so only an exact duplicate (same address and role) is refused.
        if (!linkIndex.add(link.address, link.role, link.id)) {
            // The duplicate shares the device's connection with the link already up: only
            // its own GATT client is closed. Cancelling the device's connection (the
            // peripheral case) would cut the existing link, so a peripheral duplicate is
            // just not used.
            if (link.role == LinkRole.CENTRAL) link.gatt?.let {
                it.disconnect()
                it.close()
            }
            return
        }
        links[link.id] = link
        listener?.onLinkUp(link.id, link.mtu)
    }

    private fun removeLink(link: Link) {
        if (links.remove(link.id) == null) return
        linkIndex.remove(link.address, link.role, link.id)
        link.queue.clear()
        selector.onDisconnected(link.address, SystemClock.elapsedRealtime())
        if (link.role == LinkRole.PERIPHERAL) {
            admission.onLinkClosed(link.address, SystemClock.elapsedRealtime())
            // the peripheral link a parked client was kept for is gone: the client may go now
            parkedCentral.remove(link.address)?.let {
                it.disconnect()
                it.close()
            }
        }
        listener?.onLinkDown(link.id)
        scheduleEvaluate()
    }

    /** Ends the link's use of the device's connection, without cutting a connection another link still uses. */
    private fun disconnect(link: Link) {
        when (link.role) {
            LinkRole.CENTRAL -> {
                val gatt = link.gatt ?: return
                when (LinkClosing.central(peripheralLinkUp = linkFor(link.address, LinkRole.PERIPHERAL) != null)) {
                    LinkClosing.Action.PARK -> park(link, gatt)
                    else -> {
                        gatt.disconnect()
                        gatt.close()
                    }
                }
            }
            LinkRole.PERIPHERAL -> {
                // The parked client is not counted as central: once only it is left, the
                // connection serves no link and is cut (removeLink then closes the client).
                val action = LinkClosing.peripheral(isCentralTo(link.address), ContactExchangeGate.active)
                if (action == LinkClosing.Action.CUT) link.device?.let { gattServer?.cancelConnection(it) }
                // STOP_USING: removeLink drops the link; the other phone's central sees no
                // more notifications. Nothing tells it here (a peripheral cannot unsubscribe
                // a central): its core closes the same link by the same rule, a lower link
                // key kept on both ends, and its radio then disconnects or parks its client.
            }
        }
    }

    /**
     * Whether a central `BluetoothGatt.disconnect()` drops the LE connection that
     * the peripheral link to the same device also uses is not settled: the stack
     * drops a connection that no local app holds, and an inbound connection may
     * not count as held by the GATT server. So the client stays open, unsubscribed,
     * until the peripheral link ends. The unsubscribe tells the other phone this
     * link is closed (its server sees notifications disabled and drops the link)
     * even if its core did not close it; it is best effort, the client may be busy.
     */
    private fun park(link: Link, gatt: BluetoothGatt) {
        parkedCentral.put(link.address, gatt)?.takeIf { it !== gatt }?.close()
        val characteristic = link.characteristic ?: return
        val cccd = characteristic.getDescriptor(MeshConstants.CCCD_UUID) ?: return
        gatt.setCharacteristicNotification(characteristic, false)
        writeCccd(gatt, cccd, BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
    }

    private fun closeNow(link: Link) {
        disconnect(link)
        removeLink(link)
    }


    /** Hands the link's next queued chunk to the stack, if none is in flight. A refused send closes the link. */
    private fun pump(linkId: Int) {
        val link = links[linkId] ?: return
        val chunk = link.queue.takeNext(SystemClock.elapsedRealtime()) ?: return
        val started = try {
            when (link.role) {
                LinkRole.CENTRAL -> writeChunk(link, chunk)
                LinkRole.PERIPHERAL -> notifyChunk(link, chunk)
            }
        } catch (e: IllegalArgumentException) {
            // refused by the stack (e.g. longer than an attribute value): close, do not crash
            false
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
                // the neighbour is rotated out, not one of its links: both go if it has two
                for (id in linkIndex.idsFor(address)) links[id]?.let { closeNow(it) }
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
            // Only devices that wrote to the mesh service and never subscribed are pending
            // here; a device that never used the service is not tracked, so never cut. A
            // subscribed peer that then stalls is a link, closed by the core's handshake
            // timeout (20 s) or by the stuck-send check below.
            val expired = admission.expire(now) { !isCentralTo(it) && !ContactExchangeGate.active }
            for (address in expired) {
                try {
                    bluetoothManager?.adapter?.getRemoteDevice(address)?.let { gattServer?.cancelConnection(it) }
                } catch (e: IllegalArgumentException) {
                    DebugLog.w(TAG, "Bad pending address")
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

        /**
         * ATT "Insufficient Resources", the answer to a refused subscribe: the
         * mesh is full. Not an authentication or encryption error, which would
         * make the other phone start pairing and show a prompt.
         */
        const val SUBSCRIBE_REFUSED_STATUS = 0x11
        const val EVALUATE_DELAY_MS = 500L
        const val CONNECT_TIMEOUT_MS = PeripheralAdmission.CONNECT_TIMEOUT_MS
        const val SEND_TIMEOUT_MS = 5_000L
        const val WATCHDOG_INTERVAL_MS = 5_000L
    }
}
