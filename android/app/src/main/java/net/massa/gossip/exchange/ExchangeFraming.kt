package net.massa.gossip.exchange

/**
 * Byte framing of the in-person contact exchange (CONTACT-EXCHANGE.md). The
 * request is one ATT write; the response, longer than an ATT packet, goes as
 * notifications of at most `min(ATT MTU − 3, 512)` bytes: a 4-byte big-endian length,
 * then the bytes. The native side never looks inside: the crypto is in JS.
 */
object ExchangeFraming {
    /** 0x01 ‖ the scanner's X25519 key. */
    const val REQUEST_LENGTH = 33

    /** The public keys and a name, sealed: about 3.2 KB today. */
    const val MAX_RESPONSE_LENGTH = 16 * 1024

    const val LENGTH_PREFIX_BYTES = 4

    /** The notifications that carry [data] over a link whose chunks hold [maxChunk] bytes. */
    fun chunks(data: ByteArray, maxChunk: Int): List<ByteArray> {
        require(maxChunk > LENGTH_PREFIX_BYTES) { "chunk too small" }
        require(data.size <= MAX_RESPONSE_LENGTH) { "response too long" }
        val framed = ByteArray(LENGTH_PREFIX_BYTES + data.size)
        framed[0] = (data.size ushr 24).toByte()
        framed[1] = (data.size ushr 16).toByte()
        framed[2] = (data.size ushr 8).toByte()
        framed[3] = data.size.toByte()
        data.copyInto(framed, LENGTH_PREFIX_BYTES)
        return (framed.indices step maxChunk).map { start ->
            framed.copyOfRange(start, minOf(start + maxChunk, framed.size))
        }
    }
}

/**
 * Reassembles a response from its notifications. Anything malformed (a length
 * over the limit, more bytes than announced) fails it for good.
 */
class ResponseAssembler(private val maxLength: Int = ExchangeFraming.MAX_RESPONSE_LENGTH) {
    private val header = ByteArray(ExchangeFraming.LENGTH_PREFIX_BYTES)
    private var headerFilled = 0
    private var body: ByteArray? = null
    private var bodyFilled = 0

    var failed = false
        private set

    val isComplete: Boolean get() = !failed && body != null && bodyFilled == body!!.size

    /** The response once [isComplete]. */
    fun result(): ByteArray? = if (isComplete) body!!.copyOf() else null

    fun add(chunk: ByteArray) {
        if (failed || isComplete) {
            if (chunk.isNotEmpty()) failed = true
            return
        }
        var offset = 0
        while (headerFilled < header.size && offset < chunk.size) {
            header[headerFilled++] = chunk[offset++]
        }
        if (headerFilled < header.size) return
        val buffer = body ?: run {
            val length = ((header[0].toInt() and 0xff) shl 24) or
                ((header[1].toInt() and 0xff) shl 16) or
                ((header[2].toInt() and 0xff) shl 8) or
                (header[3].toInt() and 0xff)
            if (length <= 0 || length > maxLength) {
                failed = true
                return
            }
            ByteArray(length).also { body = it }
        }
        val remaining = chunk.size - offset
        if (remaining > buffer.size - bodyFilled) {
            failed = true
            return
        }
        chunk.copyInto(buffer, bodyFilled, offset, chunk.size)
        bodyFilled += remaining
    }
}

/**
 * What one code on screen agrees to answer: a few requests in all, one per
 * phone (BLE address), and not many at once. Everything else is ignored.
 */
class PresenterBudget(
    private val maxResponses: Int = 16,
    private val maxConcurrent: Int = 2,
) {
    private val answered = HashSet<String>()
    private val inFlight = HashSet<String>()
    private var total = 0

    @Synchronized
    fun admit(address: String): Boolean {
        if (total >= maxResponses || inFlight.size >= maxConcurrent) return false
        if (address in answered || address in inFlight) return false
        inFlight += address
        total++
        return true
    }

    /** The request of [address] is over, answered or not: it is not admitted again. */
    @Synchronized
    fun release(address: String) {
        if (inFlight.remove(address)) answered += address
    }
}
