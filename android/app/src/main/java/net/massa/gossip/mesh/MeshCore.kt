package net.massa.gossip.mesh

import android.content.Context

/**
 * The mesh node core: pools, link handshakes, BLE chunking, replication, the
 * wanted list and the internet upstream. It will be the Rust `gossip-mobile`
 * crate (gossip-node repository) through UniFFI; until then [StubMeshCore]
 * stands in. Calls may block (storage, network) and are made from the
 * bridge's core thread, never from the main thread.
 *
 * Binary values are raw bytes here; the plugin converts them to base64 for JS.
 */
interface MeshCore {
    /**
     * Opens the node's storage in [dataDir] and starts it. [configJson] is the
     * JSON object the app passes to `MeshNode.start({ config })`, opaque here.
     */
    fun start(dataDir: String, configJson: String, sink: MeshCoreSink)

    fun stop()

    // Radio events. Chunks follow the chunk format of gossip-node docs/MESH.md:
    // the core does the chunking and reassembly, the radio moves the chunks.

    fun linkUp(linkId: Int, mtu: Int)

    fun linkDown(linkId: Int)

    fun frameIn(linkId: Int, frame: ByteArray)

    // The MeshNode plugin API.

    fun sendBlob(kind: MeshBlobKind, key: ByteArray?, payload: ByteArray): MeshSendResult

    fun fetch(seekers: List<ByteArray>): List<MeshKeyValue>

    fun fetchBulletin(cursor: String?, limit: Int): List<MeshBulletinItem>

    fun getKeys(hash: ByteArray): ByteArray?

    fun setWanted(seekers: List<ByteArray>)

    fun setUpstream(urls: List<String>, bridgeEnabled: Boolean)

    fun status(): MeshCoreStatus

    /** Deletes everything the node stored, its own blobs and relayed ones. */
    fun wipe()
}

/** What the core asks of its host. May be called from any core thread. */
interface MeshCoreSink {
    /** Queues one chunk on the link; false when the radio refused it. */
    fun sendFrame(linkId: Int, frame: ByteArray): Boolean

    /** Asks the radio to drop the link: a duplicate peer id, a failed handshake, a protocol violation. */
    fun closeLink(linkId: Int)

    /** Blobs for seekers on the wanted list, and announcements, the node just stored. */
    fun arrival(messages: List<MeshKeyValue>, announcements: List<ByteArray>)
}

enum class MeshBlobKind(val wireName: String) {
    MESSAGE("message"),
    ANNOUNCEMENT("announcement"),
    KEYS("keys");

    companion object {
        fun fromWireName(name: String?): MeshBlobKind? = entries.firstOrNull { it.wireName == name }
    }
}

class MeshKeyValue(val key: ByteArray, val value: ByteArray)

class MeshBulletinItem(val counter: String, val data: ByteArray)

class MeshSendResult(val id: ByteArray, val counter: String?)

class MeshCoreStatus(
    val running: Boolean,
    /** Links whose handshake completed: the core's view, not the radio's. */
    val meshPeers: Int,
    val upstreamReachable: Boolean,
    val bridgeEnabled: Boolean,
    val bulletinCounter: String,
    val storedBlobs: Long,
    // Reported by the Rust node only; the stub leaves the defaults.
    val linksHandshaking: Int = 0,
    val meshBlobs: Long = 0,
    /** Mesh blobs waiting for a bridge to upload them. */
    val uploadPending: Long = 0,
    val wantedEntries: Long = 0,
    val clockOffsetMs: Long = 0,
    val peerId: String = "",
)

/**
 * The Rust node ([RustMeshCore], in the `meshffi` source set) when the build
 * included it, else [StubMeshCore]. The build includes it when a gossip-node
 * checkout with `gossip-mobile` is found (see `buildRustMeshCore`), so a
 * checkout of this repository alone still builds and runs.
 */
object MeshCoreFactory {
    private const val RUST_CORE = "net.massa.gossip.mesh.RustMeshCore"

    fun create(@Suppress("UNUSED_PARAMETER") context: Context): MeshCore = rustCore() ?: StubMeshCore()

    /** Whether this build carries the Rust node rather than the stub. */
    fun hasRustCore(): Boolean = runCatching { Class.forName(RUST_CORE) }.isSuccess

    private fun rustCore(): MeshCore? = runCatching {
        Class.forName(RUST_CORE).getDeclaredConstructor().newInstance() as MeshCore
    }.getOrNull()
}
