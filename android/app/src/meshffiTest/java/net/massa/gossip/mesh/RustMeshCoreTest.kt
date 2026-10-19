package net.massa.gossip.mesh

import net.massa.gossip.mesh.ffi.MeshBulletinItem as FfiBulletinItem
import net.massa.gossip.mesh.ffi.MeshCoreSink as FfiSink
import net.massa.gossip.mesh.ffi.MeshCoreStatus as FfiStatus
import net.massa.gossip.mesh.ffi.MeshKeyValue as FfiKeyValue
import net.massa.gossip.mesh.ffi.MeshNodeCoreInterface
import net.massa.gossip.mesh.ffi.MeshSendResult as FfiSendResult
import net.massa.gossip.mesh.ffi.MeshBlobKind as FfiBlobKind
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RustMeshCoreTest {

    /** Records calls; [linkUp] closes the link from inside the call, as the node does for a duplicate. */
    private class FakeNode : MeshNodeCoreInterface {
        val calls = mutableListOf<String>()
        var sink: FfiSink? = null
        var kind: FfiBlobKind? = null
        var localOnly: Boolean? = null

        override fun start(dataDir: String, configJson: String, sink: FfiSink) {
            this.sink = sink
            calls += "start"
        }
        override fun stop() { calls += "stop" }
        override fun linkUp(linkId: Int, mtu: Int) {
            calls += "linkUp $linkId"
            sink!!.closeLink(linkId)
        }
        override fun linkDown(linkId: Int) { calls += "linkDown $linkId" }
        override fun frameIn(linkId: Int, frame: ByteArray) {
            sink!!.arrival(listOf(FfiKeyValue(byteArrayOf(1), frame)), listOf(byteArrayOf(9)))
        }
        override fun sendBlob(kind: FfiBlobKind, key: ByteArray?, payload: ByteArray, localOnly: Boolean): FfiSendResult {
            this.kind = kind
            this.localOnly = localOnly
            return FfiSendResult(byteArrayOf(7), "3")
        }
        override fun fetch(seekers: List<ByteArray>) = seekers.map { FfiKeyValue(it, byteArrayOf(2)) }
        override fun fetchBulletin(cursor: String?, limit: Int) = listOf(FfiBulletinItem("1", byteArrayOf(4)))
        override fun getKeys(hash: ByteArray): ByteArray? = null
        override fun setWanted(seekers: List<ByteArray>, localSeekers: List<ByteArray>) {
            calls += "setWanted ${seekers.size} ${localSeekers.size}"
        }
        override fun setUpstream(urls: List<String>, bridgeEnabled: Boolean) {
            calls += "setUpstream ${urls.size} $bridgeEnabled"
        }
        override fun status() = FfiStatus(true, 2, true, true, "5", 10, 1, 4, 3, 6, -20, "")
        override fun wipe(newConfigJson: String?) { calls += "wipe $newConfigJson" }
        override fun forgetOwn(kind: FfiBlobKind, key: ByteArray): Boolean {
            calls += "forgetOwn $kind ${key.size}"
            return true
        }
    }

    private class RecordingSink : MeshCoreSink {
        val closed = mutableListOf<Int>()
        val arrivals = mutableListOf<Pair<List<MeshKeyValue>, List<ByteArray>>>()
        override fun sendFrame(linkId: Int, frame: ByteArray) = true
        override fun closeLink(linkId: Int) { closed += linkId }
        override fun arrival(messages: List<MeshKeyValue>, announcements: List<ByteArray>) {
            arrivals += messages to announcements
        }
    }

    @Test
    fun forwardsReentrantCloseLinkAndArrivals() {
        val node = FakeNode()
        val sink = RecordingSink()
        val core = RustMeshCore(node)
        core.start("/tmp", "{}", sink)
        core.linkUp(4, 185)
        core.frameIn(4, byteArrayOf(5, 6))
        assertEquals(listOf(4), sink.closed)
        val (messages, announcements) = sink.arrivals.single()
        assertArrayEquals(byteArrayOf(5, 6), messages.single().value)
        assertArrayEquals(byteArrayOf(9), announcements.single())
    }

    @Test
    fun wipeReappliesUpstreamAndWanted() {
        val node = FakeNode()
        val core = RustMeshCore(node)
        core.setUpstream(listOf("https://a"), true)
        core.setWanted(listOf(byteArrayOf(1), byteArrayOf(2)), listOf(byteArrayOf(3)))
        node.calls.clear()
        core.wipe("{\"pool_key_hex\":\"aa\"}")
        assertEquals(
            listOf("wipe {\"pool_key_hex\":\"aa\"}", "setUpstream 1 true", "setWanted 2 1"),
            node.calls,
        )
    }

    @Test
    fun mapsKindsResultsAndStatus() {
        val node = FakeNode()
        val core = RustMeshCore(node)
        val result = core.sendBlob(MeshBlobKind.KEYS, null, byteArrayOf(1))
        assertEquals(FfiBlobKind.KEYS, node.kind)
        assertEquals(false, node.localOnly)
        core.sendBlob(MeshBlobKind.MESSAGE, byteArrayOf(2), byteArrayOf(1), localOnly = true)
        assertEquals(true, node.localOnly)
        assertTrue(core.forgetOwn(MeshBlobKind.KEYS, ByteArray(32)))
        assertEquals("forgetOwn KEYS 32", node.calls.last())
        assertEquals("3", result.counter)
        assertEquals("1", core.fetchBulletin(null, 10).single().counter)
        val status = core.status()
        assertTrue(status.running)
        assertEquals(3L, status.uploadPending)
        assertEquals(-20L, status.clockOffsetMs)
    }
}
