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
