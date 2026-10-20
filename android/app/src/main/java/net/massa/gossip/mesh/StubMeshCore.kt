package net.massa.gossip.mesh

import java.security.MessageDigest

/**
 * Stand-in for the Rust node until its bindings exist. It keeps what the app
 * sends in memory and answers fetches from that, so the plugin, the SDK side
 * and the radio can be exercised end to end on one phone. It does not speak
 * on links: incoming chunks are counted and dropped, nothing is relayed.
 */
class StubMeshCore : MeshCore {
    private val lock = Any()
    private var running = false
    private var sink: MeshCoreSink? = null
    private val messages = LinkedHashMap<String, MutableList<MeshKeyValue>>()
    private val bulletin = ArrayList<ByteArray>()
    private val keys = HashMap<String, ByteArray>()
    private val links = HashSet<Int>()
    private var wanted: Set<String> = emptySet()
    private var upstreamUrls: List<String> = emptyList()
    private var bridgeEnabled = false
    private var framesIn = 0L

    override fun start(dataDir: String, configJson: String, sink: MeshCoreSink) = synchronized(lock) {
        this.sink = sink
        running = true
    }

    override fun stop() = synchronized(lock) {
        running = false
        sink = null
        links.clear()
    }

    override fun linkUp(linkId: Int, mtu: Int) {
        synchronized(lock) { links.add(linkId) }
    }

    override fun linkDown(linkId: Int) {
        synchronized(lock) { links.remove(linkId) }
    }

    override fun frameIn(linkId: Int, frame: ByteArray) {
        synchronized(lock) { framesIn++ }
    }

    override fun sendBlob(kind: MeshBlobKind, key: ByteArray?, payload: ByteArray, localOnly: Boolean): MeshSendResult {
        val id = sha256(byteArrayOf(kind.ordinal.toByte()) + (key ?: ByteArray(0)) + payload)
        val arrived: MeshKeyValue?
        val counter: String?
        synchronized(lock) {
            when (kind) {
                MeshBlobKind.MESSAGE -> {
                    val seeker = requireNotNull(key) { "a message needs its seeker" }
                    // Distinct values at one seeker are all kept, in arrival order, as in
                    // the node's key-value pool: the session picks the one that decrypts.
                    val copies = messages.getOrPut(hex(seeker)) { ArrayList() }
                    val isNew = copies.none { it.value.contentEquals(payload) }
                    val entry = MeshKeyValue(seeker, payload)
                    if (isNew) copies.add(entry)
                    arrived = if (isNew && hex(seeker) in wanted) entry else null
                    counter = null
                }
                MeshBlobKind.ANNOUNCEMENT -> {
                    if (bulletin.none { it.contentEquals(payload) }) bulletin.add(payload)
                    arrived = null
                    counter = bulletin.indexOfFirst { it.contentEquals(payload) }.plus(1).toString()
                }
                MeshBlobKind.KEYS -> {
                    keys[hex(sha256(payload))] = payload
                    arrived = null
                    counter = null
                }
            }
        }
        arrived?.let { sink?.arrival(listOf(it), emptyList()) }
        return MeshSendResult(id, counter)
    }

    override fun fetch(seekers: List<ByteArray>): List<MeshKeyValue> = synchronized(lock) {
        seekers.flatMap { messages[hex(it)].orEmpty() }
    }

    override fun fetchBulletin(cursor: String?, limit: Int): List<MeshBulletinItem> = synchronized(lock) {
        val after = cursor?.toIntOrNull() ?: 0
        bulletin.withIndex()
            .filter { it.index + 1 > after }
            .take(limit)
            .map { MeshBulletinItem((it.index + 1).toString(), it.value) }
    }

    // The stub hashes with SHA-256; the node indexes key sets by blake3.
    override fun getKeys(hash: ByteArray): ByteArray? = synchronized(lock) { keys[hex(hash)] }

    override fun setWanted(seekers: List<ByteArray>, localSeekers: List<ByteArray>) {
        synchronized(lock) { wanted = (seekers + localSeekers).map(::hex).toSet() }
    }

    override fun setUpstream(urls: List<String>, bridgeEnabled: Boolean) = synchronized(lock) {
        upstreamUrls = urls
        this.bridgeEnabled = bridgeEnabled
    }

    override fun status(): MeshCoreStatus = synchronized(lock) {
        MeshCoreStatus(
            running = running,
            // No handshake here: every radio link counts as a peer.
            meshPeers = links.size,
            upstreamReachable = false,
            bridgeEnabled = bridgeEnabled,
            bulletinCounter = bulletin.size.toString(),
            storedBlobs = (messages.values.sumOf { it.size } + bulletin.size + keys.size).toLong(),
        )
    }

    override fun wipe(newConfigJson: String) = synchronized(lock) {
        messages.clear()
        bulletin.clear()
        keys.clear()
    }

    override fun forgetKeys(hash: ByteArray): Boolean = synchronized(lock) { keys.remove(hex(hash)) != null }

    // The stub keeps every key set it was given until forgotten; a lock only empties the wanted list.
    override fun lock() = synchronized(lock) { wanted = emptySet() }

    private fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
