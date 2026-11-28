package net.massa.gossip.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkIndexTest {

    /** Both phones connected to each other at once: this one holds a link in each role to one address. */
    private fun bothWays(): LinkIndex = LinkIndex().apply {
        assertTrue(add("peer", LinkRole.CENTRAL, 1))
        assertTrue(add("peer", LinkRole.PERIPHERAL, 2))
    }

    @Test
    fun twoLinksToOneAddressInBothRolesCoexist() {
        val index = bothWays()
        assertEquals(1, index.get("peer", LinkRole.CENTRAL))
        assertEquals(2, index.get("peer", LinkRole.PERIPHERAL))
        assertEquals(listOf(1, 2), index.idsFor("peer").sorted())
        assertEquals(setOf("peer"), index.addresses())
    }

    @Test
    fun chunksAndConfirmationsOfEachRoleFindTheirOwnLink() {
        // The radio looks a link up by address and role for an incoming chunk (write or
        // notification) and for a send confirmation (onCharacteristicWrite or
        // onNotificationSent): each must find its own link, whichever came up last.
        val index = LinkIndex().apply {
            add("peer", LinkRole.PERIPHERAL, 2)
            add("peer", LinkRole.CENTRAL, 1)
        }
        assertEquals(1, index.get("peer", LinkRole.CENTRAL))
        assertEquals(2, index.get("peer", LinkRole.PERIPHERAL))
        assertNull(index.get("other", LinkRole.CENTRAL))
    }

    @Test
    fun closingTheCentralLinkLeavesThePeripheralLinkWorking() {
        val index = bothWays()
        index.remove("peer", LinkRole.CENTRAL, 1)
        assertNull(index.get("peer", LinkRole.CENTRAL))
        assertEquals(2, index.get("peer", LinkRole.PERIPHERAL))
        assertEquals(setOf("peer"), index.addresses())
    }

    @Test
    fun closingThePeripheralLinkLeavesTheCentralLinkWorking() {
        val index = bothWays()
        index.remove("peer", LinkRole.PERIPHERAL, 2)
        assertEquals(1, index.get("peer", LinkRole.CENTRAL))
        assertNull(index.get("peer", LinkRole.PERIPHERAL))
        assertEquals(setOf("peer"), index.addresses())
    }

    @Test
    fun aSecondLinkInTheSameRoleIsRefusedAndTheFirstKept() {
        val index = LinkIndex()
        assertTrue(index.add("peer", LinkRole.CENTRAL, 1))
        assertFalse(index.add("peer", LinkRole.CENTRAL, 3))
        assertEquals(1, index.get("peer", LinkRole.CENTRAL))
    }

    @Test
    fun removingAStaleIdLeavesTheCurrentLink() {
        val index = LinkIndex()
        index.add("peer", LinkRole.CENTRAL, 1)
        index.remove("peer", LinkRole.CENTRAL, 7)
        assertEquals(1, index.get("peer", LinkRole.CENTRAL))
    }

    @Test
    fun theLastLinkClosedFreesTheAddress() {
        val index = bothWays()
        index.remove("peer", LinkRole.CENTRAL, 1)
        index.remove("peer", LinkRole.PERIPHERAL, 2)
        assertTrue(index.addresses().isEmpty())
        assertTrue(index.idsFor("peer").isEmpty())
    }

    @Test
    fun linkCountsCountLinksNotAddresses() {
        // linkCount() and the status event count links: two links to one phone are 2,
        // as before this index (the radio's id map always held both).
        val index = bothWays()
        index.add("other", LinkRole.CENTRAL, 3)
        assertEquals(3, index.size())
        assertEquals(2, index.addresses().size)
    }

    @Test
    fun closingAPeripheralLinkCutsTheConnectionWhenNothingElseUsesIt() {
        assertEquals(LinkClosing.Action.CUT, LinkClosing.peripheral(isCentralTo = false, exchangeActive = false))
    }

    @Test
    fun closingAPeripheralLinkWhileAlsoCentralOnlyStopsUsingIt() {
        assertEquals(LinkClosing.Action.STOP_USING, LinkClosing.peripheral(isCentralTo = true, exchangeActive = false))
    }

    @Test
    fun closingAPeripheralLinkDuringAContactExchangeOnlyStopsUsingIt() {
        assertEquals(LinkClosing.Action.STOP_USING, LinkClosing.peripheral(isCentralTo = false, exchangeActive = true))
    }

    @Test
    fun closingACentralLinkDisconnectsWhenNoPeripheralLinkIsUp() {
        assertEquals(LinkClosing.Action.CUT, LinkClosing.central(peripheralLinkUp = false))
    }

    @Test
    fun closingACentralLinkWhileAPeripheralLinkIsUpParksItsClient() {
        assertEquals(LinkClosing.Action.PARK, LinkClosing.central(peripheralLinkUp = true))
    }
}
