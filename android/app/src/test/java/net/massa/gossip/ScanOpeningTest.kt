package net.massa.gossip

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanOpeningTest {

    @Test
    fun aCloseAskedWhileOpeningIsAppliedWhenTheScannerAppears() {
        val opening = ScanOpening()
        opening.begin()
        assertTrue(opening.requestClose())
        assertTrue(opening.closeRequested())
        assertTrue(opening.opened())
    }

    @Test
    fun aScannerNobodyAskedToCloseStaysOpen() {
        val opening = ScanOpening()
        opening.begin()
        assertFalse(opening.closeRequested())
        assertFalse(opening.opened())
    }

    @Test
    fun aCloseAskedWhenNoScanIsOpeningIsNotKeptForTheNextOne() {
        val opening = ScanOpening()
        assertFalse(opening.requestClose())
        opening.begin()
        assertFalse(opening.opened())
    }

    @Test
    fun aCloseAskedForOneScanDoesNotCloseTheNext() {
        val opening = ScanOpening()
        opening.begin()
        opening.requestClose()
        opening.end()
        opening.begin()
        assertFalse(opening.closeRequested())
        assertFalse(opening.opened())
    }

    @Test
    fun theRequestIsUsedOnce() {
        val opening = ScanOpening()
        opening.begin()
        opening.requestClose()
        assertTrue(opening.opened())
        assertFalse(opening.opened())
        assertFalse(opening.requestClose())
    }
}
