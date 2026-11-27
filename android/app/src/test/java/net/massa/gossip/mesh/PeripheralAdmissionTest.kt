package net.massa.gossip.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PeripheralAdmissionTest {

    private fun admission() = PeripheralAdmission(
        gate = InboundGate(maxInbound = 4, cooldownMs = 60_000),
        maxLinks = 8,
        connectTimeoutMs = 20_000,
    )

    private fun slots(
        running: Boolean = true,
        busy: Int = 0,
        inbound: Int = 0,
        isCentralTo: Boolean = false,
        exchangeActive: Boolean = false,
    ) = PeripheralAdmission.Slots(running, busy, inbound, isCentralTo, exchangeActive)

    private fun assertAdmitted(verdict: PeripheralAdmission.Verdict, mtu: Int? = null) {
        assertTrue("expected admit, got $verdict", verdict is PeripheralAdmission.Verdict.Admit)
        if (mtu != null) assertEquals(mtu, (verdict as PeripheralAdmission.Verdict.Admit).mtu)
    }

    private fun assertRefused(verdict: PeripheralAdmission.Verdict, cancel: Boolean) {
        assertTrue("expected refuse, got $verdict", verdict is PeripheralAdmission.Verdict.Refuse)
        assertEquals(cancel, (verdict as PeripheralAdmission.Verdict.Refuse).cancel)
    }

    @Test
    fun devicesThatNeverUseTheServiceAreNeverCountedNorCancelled() {
        val a = admission()
        // Earbuds, a watch, other apps' devices: connected for hours, exchanging MTUs, never subscribing.
        for (i in 0 until 50) a.onMtuChanged("earbud-$i", 247)
        assertEquals(0, a.pendingCount())
        assertTrue(a.expire(nowMs = 24 * 3_600_000L) { true }.isEmpty())
        // They left every slot free: a real peer is still admitted.
        assertAdmitted(a.onSubscribe("peer", slots(), nowMs = 24 * 3_600_000L))
    }

    @Test
    fun aSubscribeIsAdmittedWhenThereIsRoomWithTheExchangedMtu() {
        val a = admission()
        a.onMtuChanged("peer", 517)
        assertAdmitted(a.onSubscribe("peer", slots(busy = 7, inbound = 3), nowMs = 0), mtu = 517)
    }

    @Test
    fun aSubscribeWithoutMtuExchangeGetsTheDefaultMtu() {
        assertAdmitted(admission().onSubscribe("peer", slots(), nowMs = 0), mtu = MeshConstants.DEFAULT_ATT_MTU)
    }

    @Test
    fun aSubscribeIsRefusedAndCancelledWhenFull() {
        val a = admission()
        assertRefused(a.onSubscribe("peer", slots(busy = 8), nowMs = 0), cancel = true)
        assertRefused(a.onSubscribe("peer", slots(inbound = 4), nowMs = 0), cancel = true)
        assertRefused(a.onSubscribe("peer", slots(running = false), nowMs = 0), cancel = true)
    }

    @Test
    fun aSubscribeIsRefusedWhileTheCentralCoolsDown() {
        val a = admission()
        a.onLinkClosed("peer", nowMs = 0)
        assertRefused(a.onSubscribe("peer", slots(), nowMs = 59_999), cancel = true)
        assertAdmitted(a.onSubscribe("other", slots(), nowMs = 59_999))
        assertAdmitted(a.onSubscribe("peer", slots(), nowMs = 60_000))
    }

    @Test
    fun aCentralThisPhoneIsLinkedToIsNeitherRefusedNorCancelled() {
        val a = admission()
        assertAdmitted(a.onSubscribe("peer", slots(busy = 8, inbound = 4, isCentralTo = true), nowMs = 0))
        assertEquals(
            PeripheralAdmission.Verdict.Wait,
            a.onWriteBeforeSubscribe("other", slots(busy = 8, isCentralTo = true), nowMs = 0),
        )
        assertTrue(a.expire(nowMs = 30_000) { address -> address != "other" }.isEmpty())
    }

    @Test
    fun duringAContactExchangeARefusedDeviceIsNotCancelled() {
        val a = admission()
        assertRefused(a.onSubscribe("peer", slots(busy = 8, exchangeActive = true), nowMs = 0), cancel = false)
        assertRefused(a.onWriteBeforeSubscribe("peer", slots(busy = 8, exchangeActive = true), nowMs = 0), cancel = false)
    }

    @Test
    fun aWriteBeforeTheSubscribeTakesASlotUntilTheSubscribe() {
        val a = admission()
        assertEquals(PeripheralAdmission.Verdict.Wait, a.onWriteBeforeSubscribe("peer", slots(), nowMs = 0))
        assertEquals(PeripheralAdmission.Verdict.Wait, a.onWriteBeforeSubscribe("peer", slots(), nowMs = 1))
        assertEquals(1, a.pendingCount())
        assertEquals(setOf("peer"), a.pendingAddresses())
        // the pending one counts against the limits of the others
        assertRefused(a.onSubscribe("other", slots(busy = 7), nowMs = 2), cancel = true)
        assertRefused(a.onSubscribe("other", slots(inbound = 3), nowMs = 2), cancel = true)
        // its own subscribe is not checked twice
        assertAdmitted(a.onSubscribe("peer", slots(busy = 8), nowMs = 3))
        assertEquals(0, a.pendingCount())
    }

    @Test
    fun aWriteBeforeTheSubscribeIsRefusedWhenFull() {
        val a = admission()
        assertRefused(a.onWriteBeforeSubscribe("peer", slots(busy = 8), nowMs = 0), cancel = true)
        assertEquals(0, a.pendingCount())
    }

    @Test
    fun aDeviceThatUsedTheServiceAndStallsIsDroppedAfterTheTimeout() {
        val a = admission()
        a.onWriteBeforeSubscribe("peer", slots(), nowMs = 0)
        assertTrue(a.expire(nowMs = 20_000) { true }.isEmpty())
        assertEquals(listOf("peer"), a.expire(nowMs = 20_001) { true })
        assertEquals(0, a.pendingCount())
    }

    @Test
    fun anExpiredDeviceTheRadioMayNotCancelIsStillForgotten() {
        val a = admission()
        a.onWriteBeforeSubscribe("peer", slots(), nowMs = 0)
        assertTrue(a.expire(nowMs = 20_001) { false }.isEmpty())
        assertEquals(0, a.pendingCount())
    }

    @Test
    fun aDisconnectOfAnUnknownDeviceChangesNothing() {
        val a = admission()
        a.onWriteBeforeSubscribe("peer", slots(), nowMs = 0)
        assertFalse(a.onDisconnected("earbud"))
        assertEquals(setOf("peer"), a.pendingAddresses())
        assertTrue(a.onDisconnected("peer"))
        assertEquals(0, a.pendingCount())
    }

    @Test
    fun aDisconnectForgetsTheMtu() {
        val a = admission()
        a.onMtuChanged("peer", 517)
        a.onDisconnected("peer")
        assertAdmitted(a.onSubscribe("peer", slots(), nowMs = 0), mtu = MeshConstants.DEFAULT_ATT_MTU)
    }
}
