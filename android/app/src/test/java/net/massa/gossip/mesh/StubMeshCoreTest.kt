package net.massa.gossip.mesh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StubMeshCoreTest {

    private class RecordingSink : MeshCoreSink {
        val arrivals = ArrayList<List<MeshKeyValue>>()
        override fun sendFrame(linkId: Int, frame: ByteArray) = true
        override fun closeLink(linkId: Int) {}
        override fun arrival(messages: List<MeshKeyValue>, announcements: List<ByteArray>) {
            arrivals.add(messages)
        }
    }

    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    @Test
    fun keepsEveryDistinctCopyAtASeekerOnce() {
        val core = StubMeshCore()
        core.start("/unused", "{}", RecordingSink())
        val seeker = bytes(1, 2, 3)
        core.sendBlob(MeshBlobKind.MESSAGE, seeker, bytes(9))
        core.sendBlob(MeshBlobKind.MESSAGE, seeker, bytes(9))
        core.sendBlob(MeshBlobKind.MESSAGE, seeker, bytes(8))
        val fetched = core.fetch(listOf(seeker, bytes(7)))
        assertEquals(2, fetched.size)
        assertArrayEquals(bytes(9), fetched[0].value)
        assertArrayEquals(bytes(8), fetched[1].value)
    }

    @Test
    fun reportsArrivalsForWantedSeekersOnly() {
        val sink = RecordingSink()
        val core = StubMeshCore()
        core.start("/unused", "{}", sink)
        core.setWanted(listOf(bytes(1)))
        core.sendBlob(MeshBlobKind.MESSAGE, bytes(1), bytes(5))
        core.sendBlob(MeshBlobKind.MESSAGE, bytes(2), bytes(5))
        assertEquals(1, sink.arrivals.size)
        assertArrayEquals(bytes(1), sink.arrivals[0][0].key)
    }

    @Test
    fun bulletinPagesFromTheCursor() {
        val core = StubMeshCore()
        core.start("/unused", "{}", RecordingSink())
        assertEquals("1", core.sendBlob(MeshBlobKind.ANNOUNCEMENT, null, bytes(1)).counter)
        assertEquals("2", core.sendBlob(MeshBlobKind.ANNOUNCEMENT, null, bytes(2)).counter)
        // a copy keeps its counter
        assertEquals("1", core.sendBlob(MeshBlobKind.ANNOUNCEMENT, null, bytes(1)).counter)
        val page = core.fetchBulletin("1", 10)
        assertEquals(listOf("2"), page.map { it.counter })
        assertEquals("2", core.status().bulletinCounter)
    }

    @Test
    fun wipeForgetsEverything() {
        val core = StubMeshCore()
        core.start("/unused", "{}", RecordingSink())
        core.sendBlob(MeshBlobKind.MESSAGE, bytes(1), bytes(1))
        core.sendBlob(MeshBlobKind.ANNOUNCEMENT, null, bytes(2))
        core.sendBlob(MeshBlobKind.KEYS, null, bytes(3))
        assertEquals(3L, core.status().storedBlobs)
        core.wipe()
        assertEquals(0L, core.status().storedBlobs)
        assertTrue(core.fetch(listOf(bytes(1))).isEmpty())
    }
}
