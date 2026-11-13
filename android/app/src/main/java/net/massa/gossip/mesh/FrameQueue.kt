package net.massa.gossip.mesh

/**
 * Outgoing chunks of one link. Android runs one GATT operation at a time per
 * connection, so a chunk is handed to the stack only after the previous one
 * was confirmed ([onSent]). Bounded by chunk count and bytes: past either the
 * offer fails, and the core treats that as a dropped message.
 *
 * Offers come from the core's thread, sends from the radio's thread.
 */
class FrameQueue(
    private val maxChunks: Int = MeshConstants.MAX_QUEUED_CHUNKS_PER_LINK,
    private val maxBytes: Int = MeshConstants.MAX_QUEUED_BYTES_PER_LINK,
) {
    private val chunks = ArrayDeque<ByteArray>()
    private var bytes = 0
    private var inFlightSinceMs: Long? = null

    @Synchronized
    fun offer(chunk: ByteArray): Boolean {
        if (chunks.size >= maxChunks || bytes + chunk.size > maxBytes) return false
        chunks.addLast(chunk)
        bytes += chunk.size
        return true
    }

    /** The next chunk to send, or null while one is in flight or none is queued. */
    @Synchronized
    fun takeNext(nowMs: Long): ByteArray? {
        if (inFlightSinceMs != null) return null
        val chunk = chunks.removeFirstOrNull() ?: return null
        bytes -= chunk.size
        inFlightSinceMs = nowMs
        return chunk
    }

    /** The stack confirmed the chunk in flight. */
    @Synchronized
    fun onSent() {
        inFlightSinceMs = null
    }

    /** Whether a chunk has been in flight for longer than [timeoutMs]: the link is stuck. */
    @Synchronized
    fun isStuck(nowMs: Long, timeoutMs: Long): Boolean {
        val since = inFlightSinceMs ?: return false
        return nowMs - since > timeoutMs
    }

    @Synchronized
    fun isIdle(): Boolean = inFlightSinceMs == null && chunks.isEmpty()

    @Synchronized
    fun clear() {
        chunks.clear()
        bytes = 0
        inFlightSinceMs = null
    }
}
