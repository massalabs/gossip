package net.massa.gossip.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InboundLimitsTest {

    @Test
    fun inboundLinksStopBelowTheTotalSoOwnPicksKeepRoom() {
        val gate = InboundGate(maxInbound = 4, cooldownMs = 1_000)
        assertTrue(gate.admit("a", inbound = 3, nowMs = 0))
        assertFalse(gate.admit("a", inbound = 4, nowMs = 0))
    }

    @Test
    fun aClosedCentralWaitsOutItsCooldown() {
        val gate = InboundGate(maxInbound = 4, cooldownMs = 1_000)
        gate.onClosed("a", nowMs = 0)
        assertFalse(gate.admit("a", inbound = 0, nowMs = 999))
        assertTrue(gate.admit("b", inbound = 0, nowMs = 999))
        assertTrue(gate.admit("a", inbound = 0, nowMs = 1_000))
    }

    @Test
    fun aLinkPastItsPendingBytesIsRefusedUntilTheCoreCatchesUp() {
        val budget = InboundBudget(maxPendingBytes = 1_000)
        assertTrue(budget.tryAdd(1, 600))
        assertFalse(budget.tryAdd(1, 500))
        assertTrue(budget.tryAdd(2, 500))
        assertEquals(600L, budget.pendingBytes(1))
        budget.release(1, 600)
        assertEquals(0L, budget.pendingBytes(1))
        assertTrue(budget.tryAdd(1, 1_000))
    }
}
