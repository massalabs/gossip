package net.massa.gossip.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two-phone test that measured 82 s without a link: phone B's Bluetooth restarted,
 * the link closed on both phones at 0, A retried at 10 s and was refused by B's inbound
 * cooldown, then waited its own reconnect cooldown. Replayed with the shipped defaults.
 */
class ReconnectAfterLossTest {

    private val slots = PeripheralAdmission.Slots(
        running = true,
        busy = 0,
        inboundLinks = 0,
        isCentralTo = false,
        exchangeActive = false,
    )

    @Test
    fun aLostLinkComesBackAfterThirtySeconds() {
        assertEquals(30_000L, MeshConstants.INBOUND_COOLDOWN_MS)
        assertEquals(30_000L, MeshConstants.RECONNECT_COOLDOWN_MS)

        // B, the peripheral: A's inbound link closed at 0.
        val b = PeripheralAdmission()
        b.onLinkClosed("A", nowMs = 0)
        // A, the central: its link to B closed at 0, and B stays in sight.
        val a = NeighbourSelector()
        a.onSeen("B", -60, 0)
        a.onDisconnected("B", 0)

        // A retry at 10 s is refused by B.
        assertTrue(b.onSubscribe("A", slots, nowMs = 10_000) is PeripheralAdmission.Verdict.Refuse)
        // A does not pick B again before 30 s...
        for (t in listOf(10_000L, 20_000L, 29_999L)) {
            a.onSeen("B", -60, t)
            assertTrue("picked at $t", a.pickConnections(emptySet(), t).isEmpty())
        }
        // ...and does at 30 s, when B admits it.
        a.onSeen("B", -60, 30_000)
        assertEquals(listOf("B"), a.pickConnections(emptySet(), 30_000))
        assertTrue(b.onSubscribe("A", slots, nowMs = 30_000) is PeripheralAdmission.Verdict.Admit)
    }

    @Test
    fun theMeasuredSequenceNowEndsAtFortySecondsInsteadOfEightyTwo() {
        // As measured: A retried at 10 s (its selector had no cooldown for B), B refused
        // it, and the failed attempt started A's reconnect cooldown at 10 s.
        val b = PeripheralAdmission()
        b.onLinkClosed("A", nowMs = 0)
        val a = NeighbourSelector()
        a.onSeen("B", -60, 10_000)
        assertEquals(listOf("B"), a.pickConnections(emptySet(), 10_000))
        assertTrue(b.onSubscribe("A", slots, nowMs = 10_000) is PeripheralAdmission.Verdict.Refuse)
        a.onDisconnected("B", 10_000)

        a.onSeen("B", -60, 39_999)
        assertTrue(a.pickConnections(emptySet(), 39_999).isEmpty())
        a.onSeen("B", -60, 40_000)
        assertEquals(listOf("B"), a.pickConnections(emptySet(), 40_000))
        assertTrue(b.onSubscribe("A", slots, nowMs = 40_000) is PeripheralAdmission.Verdict.Admit)
    }
}
