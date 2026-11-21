package net.massa.gossip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {

    @Test
    fun armsOnlyWithATimeout() {
        assertNull(AppLock.deadlineFor(1_000, null))
        assertEquals(301_000L, AppLock.deadlineFor(1_000, 300))
        assertEquals(1_000L, AppLock.deadlineFor(1_000, 0))
        assertNull(AppLock.deadlineFor(1_000, -1))
    }

    @Test
    fun isDueOnceTheDeadlinePassed() {
        assertFalse(AppLock.isDue(null, Long.MAX_VALUE))
        assertFalse(AppLock.isDue(301_000, 300_999))
        assertTrue(AppLock.isDue(301_000, 301_000))
        assertTrue(AppLock.isDue(301_000, 900_000))
    }
}
