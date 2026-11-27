package net.massa.gossip.mesh

/**
 * Limits on what other phones can make this one take. Pure logic, driven by
 * the radio and the bridge, unit-tested.
 *
 * [InboundGate] keeps hostile centrals from filling every link slot: inbound
 * links are capped below the total, so this phone always has room for the
 * neighbours it picks itself, and a central whose link just closed waits out
 * a cooldown before it may connect again.
 */
class InboundGate(
    private val maxInbound: Int = MeshConstants.MAX_INBOUND_LINKS,
    private val cooldownMs: Long = MeshConstants.INBOUND_COOLDOWN_MS,
) {
    private val cooldownUntil = HashMap<String, Long>()

    /** Whether a central at [address] may connect, with [inbound] inbound connections already held. */
    fun admit(address: String, inbound: Int, nowMs: Long): Boolean {
        cooldownUntil.entries.removeAll { it.value <= nowMs }
        return inbound < maxInbound && address !in cooldownUntil
    }

    fun onClosed(address: String, nowMs: Long) {
        cooldownUntil[address] = nowMs + cooldownMs
    }
}

/**
 * Which devices connected to this phone's GATT server are mesh peers. Pure
 * logic, driven by the radio thread, unit-tested.
 *
 * Android reports every Bluetooth LE device connected to the phone to the
 * GATT server (the user's earbuds, watch, other apps' devices, this app's
 * contact exchange), not only centrals of the mesh service. So a connection
 * alone means nothing here: a device only becomes an arriving mesh peer when
 * it uses the mesh service, by subscribing to the chunk characteristic or
 * writing to it. Until then it takes no slot, is never counted or reported,
 * and the radio never cancels its connection: cancelling would cut the user's
 * own devices, and counting them would refuse real peers.
 *
 * The limits and the [InboundGate] apply at that first use. A refused device
 * has shown it is a mesh central, so only then may the radio cancel it.
 */
class PeripheralAdmission(
    private val gate: InboundGate = InboundGate(),
    private val maxLinks: Int = MeshConstants.MAX_LINKS,
    private val connectTimeoutMs: Long = CONNECT_TIMEOUT_MS,
) {
    /** What the radio holds when a device uses the mesh service; this class adds its own pending ones. */
    class Slots(
        val running: Boolean,
        /** Links in both roles plus outgoing connections not yet links. */
        val busy: Int,
        /** Links other phones opened to this one. */
        val inboundLinks: Int,
        /** This phone is connected, or connecting, to the device as central. */
        val isCentralTo: Boolean,
        /** A contact exchange is using Bluetooth (see `ContactExchangeGate`). */
        val exchangeActive: Boolean,
    )

    sealed class Verdict {
        /** The subscribe is accepted: the link is up, with [mtu]. */
        class Admit(val mtu: Int) : Verdict()

        /** A write came before the subscribe: counted, and the subscribe is awaited. */
        object Wait : Verdict()

        /** Refused: the subscribe is answered with an error, and the connection cancelled if [cancel]. */
        class Refuse(val cancel: Boolean) : Verdict()
    }

    private class Pending(val startedMs: Long)

    /** MTUs exchanged with connected devices, kept for the link a later subscribe opens. Never counted. */
    private val mtus = HashMap<String, Int>()

    /** Devices that wrote to the mesh characteristic before subscribing: counted, timed out. */
    private val pending = HashMap<String, Pending>()

    fun pendingCount(): Int = pending.size

    fun pendingAddresses(): Set<String> = pending.keys.toSet()

    fun onMtuChanged(address: String, mtu: Int) {
        mtus[address] = mtu
    }

    /** The device enabled notifications on the chunk characteristic, and has no link to this phone yet. */
    fun onSubscribe(address: String, slots: Slots, nowMs: Long): Verdict {
        // A device that wrote first already holds a slot: it is let in without a second check.
        if (pending.remove(address) == null) refusal(address, slots, nowMs)?.let { return it }
        return Verdict.Admit(mtus[address] ?: MeshConstants.DEFAULT_ATT_MTU)
    }

    /**
     * The device wrote a chunk while it has no link. Mesh centrals subscribe
     * before they write (the link only comes up on the subscribe), so this is
     * not a path real peers take; the chunk is dropped as before. The device
     * still used the mesh service, so it takes a slot, or is refused, and a
     * subscribe that does not follow within the timeout drops it.
     */
    fun onWriteBeforeSubscribe(address: String, slots: Slots, nowMs: Long): Verdict {
        if (address in pending) return Verdict.Wait
        refusal(address, slots, nowMs)?.let { return it }
        pending[address] = Pending(nowMs)
        return Verdict.Wait
    }

    /** A disconnect: true only when the device was pending here. Other devices leave no trace. */
    fun onDisconnected(address: String): Boolean {
        mtus.remove(address)
        return pending.remove(address) != null
    }

    /** A link opened by the device at [address] closed: it waits out the gate's cooldown. */
    fun onLinkClosed(address: String, nowMs: Long) = gate.onClosed(address, nowMs)

    /**
     * Pending devices that did not subscribe in time, removed. Those [mayCancel]
     * allows are returned for the radio to cancel.
     */
    fun expire(nowMs: Long, mayCancel: (String) -> Boolean): List<String> {
        val expired = pending.filterValues { nowMs - it.startedMs > connectTimeoutMs }.keys.toList()
        for (address in expired) pending.remove(address)
        return expired.filter(mayCancel)
    }

    fun clear() {
        mtus.clear()
        pending.clear()
    }

    private fun refusal(address: String, slots: Slots, nowMs: Long): Verdict.Refuse? {
        // Android shares one connection per device between the app's GATT servers and
        // clients: when this phone is central to the device too, both sides linked to
        // each other and the core keeps one link per peer, so it is not refused (and
        // cancelling it would drop the central link as well).
        if (slots.isCentralTo) return null
        val inbound = slots.inboundLinks + pending.size
        val busy = slots.busy + pending.size
        if (slots.running && busy < maxLinks && gate.admit(address, inbound, nowMs)) return null
        // A contact exchange shares the app's connections: cancelling this one could
        // cut the exchange, so while one runs the device is only refused.
        return Verdict.Refuse(cancel = !slots.exchangeActive)
    }

    companion object {
        /** How long a device that used the mesh service has to finish subscribing. */
        const val CONNECT_TIMEOUT_MS = 20_000L
    }
}

/**
 * Bytes received on each link and not yet taken by the core. A link that
 * sends faster than the core reads would otherwise grow the queue without
 * bound; past [maxPendingBytes] it is closed.
 */
class InboundBudget(private val maxPendingBytes: Int = MeshConstants.MAX_PENDING_INBOUND_BYTES_PER_LINK) {
    private val pending = HashMap<Int, Long>()

    /** Counts [bytes] for [linkId]; false, counting nothing, when that would pass the bound. */
    @Synchronized
    fun tryAdd(linkId: Int, bytes: Int): Boolean {
        val next = (pending[linkId] ?: 0L) + bytes
        if (next > maxPendingBytes) return false
        pending[linkId] = next
        return true
    }

    @Synchronized
    fun release(linkId: Int, bytes: Int) {
        val next = (pending[linkId] ?: return) - bytes
        if (next <= 0) pending.remove(linkId) else pending[linkId] = next
    }

    @Synchronized
    fun pendingBytes(linkId: Int): Long = pending[linkId] ?: 0L
}
