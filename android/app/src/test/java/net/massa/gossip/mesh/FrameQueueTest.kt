package net.massa.gossip.mesh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameQueueTest {

    private fun chunk(id: Int, size: Int = 10) = ByteArray(size) { id.toByte() }

    @Test
    fun sendsInOrderOneAtATime() {
        val q = FrameQueue()
        assertTrue(q.offer(chunk(1)))
        assertTrue(q.offer(chunk(2)))
        assertArrayEquals(chunk(1), q.takeNext(0))
        // the first one is not confirmed yet
        assertNull(q.takeNext(0))
        q.onSent()
        assertArrayEquals(chunk(2), q.takeNext(0))
        q.onSent()
        assertNull(q.takeNext(0))
        assertTrue(q.isIdle())
    }

    @Test
    fun refusesPastTheChunkBound() {
        val q = FrameQueue(maxChunks = 2, maxBytes = 1_000)
        assertTrue(q.offer(chunk(1)))
        assertTrue(q.offer(chunk(2)))
        assertFalse(q.offer(chunk(3)))
        q.takeNext(0)
        assertTrue(q.offer(chunk(3)))
    }

    @Test
    fun refusesPastTheByteBound() {
        val q = FrameQueue(maxChunks = 100, maxBytes = 25)
        assertTrue(q.offer(chunk(1, 10)))
        assertTrue(q.offer(chunk(2, 10)))
        assertFalse(q.offer(chunk(3, 10)))
        // bytes are released when a chunk leaves the queue, not when it is confirmed
        q.takeNext(0)
        assertTrue(q.offer(chunk(3, 10)))
    }

    @Test
    fun aChunkInFlightTooLongMeansStuck() {
        val q = FrameQueue()
        q.offer(chunk(1))
        assertFalse(q.isStuck(10_000, 5_000))
        q.takeNext(1_000)
        assertFalse(q.isStuck(6_000, 5_000))
        assertTrue(q.isStuck(6_001, 5_000))
        q.onSent()
        assertFalse(q.isStuck(60_000, 5_000))
    }

    @Test
    fun clearDropsEverything() {
        val q = FrameQueue(maxChunks = 2, maxBytes = 1_000)
        q.offer(chunk(1))
        q.offer(chunk(2))
        q.takeNext(0)
        q.clear()
        assertTrue(q.isIdle())
        assertTrue(q.offer(chunk(3)))
        assertArrayEquals(chunk(3), q.takeNext(0))
    }
}
