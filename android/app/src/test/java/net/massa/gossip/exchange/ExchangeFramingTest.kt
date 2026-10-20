package net.massa.gossip.exchange

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExchangeFramingTest {

    private fun response(size: Int) = ByteArray(size) { (it * 7).toByte() }

    @Test
    fun chunksReassembleAtEveryMtu() {
        val data = response(3_300)
        for (maxChunk in listOf(20, 182, 244, 514)) {
            val chunks = ExchangeFraming.chunks(data, maxChunk)
            assertTrue(chunks.all { it.size <= maxChunk })
            val assembler = ResponseAssembler()
            for (chunk in chunks) {
                assertFalse(assembler.isComplete)
                assembler.add(chunk)
            }
            assertTrue(assembler.isComplete)
            assertArrayEquals(data, assembler.result())
        }
    }

    @Test
    fun lengthPrefixCanSpanChunks() {
        val data = response(10)
        val framed = ExchangeFraming.chunks(data, 100).single()
        val assembler = ResponseAssembler()
        for (b in framed) assembler.add(byteArrayOf(b))
        assertArrayEquals(data, assembler.result())
    }

    @Test
    fun refusesAnOversizedLength() {
        val assembler = ResponseAssembler(maxLength = 1_000)
        assembler.add(byteArrayOf(0, 0, 0x10, 0))
        assertTrue(assembler.failed)
        assertNull(assembler.result())
    }

    @Test
    fun refusesAZeroLength() {
        val assembler = ResponseAssembler()
        assembler.add(byteArrayOf(0, 0, 0, 0))
        assertTrue(assembler.failed)
    }

    @Test
    fun refusesMoreBytesThanAnnounced() {
        val assembler = ResponseAssembler()
        assembler.add(byteArrayOf(0, 0, 0, 2, 1, 2, 3))
        assertTrue(assembler.failed)
        assertNull(assembler.result())
    }

    @Test
    fun refusesBytesAfterTheEnd() {
        val assembler = ResponseAssembler()
        assembler.add(byteArrayOf(0, 0, 0, 2, 1, 2))
        assertTrue(assembler.isComplete)
        assembler.add(byteArrayOf(9))
        assertTrue(assembler.failed)
        assertNull(assembler.result())
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAResponseOverTheLimit() {
        ExchangeFraming.chunks(response(ExchangeFraming.MAX_RESPONSE_LENGTH + 1), 200)
    }

    @Test
    fun answersEachPhoneOnce() {
        val budget = PresenterBudget(maxResponses = 10, maxConcurrent = 2)
        assertTrue(budget.admit("a"))
        assertFalse(budget.admit("a"))
        budget.release("a")
        assertFalse(budget.admit("a"))
    }

    @Test
    fun boundsConcurrentAndTotalRequests() {
        val budget = PresenterBudget(maxResponses = 3, maxConcurrent = 2)
        assertTrue(budget.admit("a"))
        assertTrue(budget.admit("b"))
        assertFalse(budget.admit("c"))
        budget.release("a")
        assertTrue(budget.admit("c"))
        budget.release("b")
        budget.release("c")
        assertFalse(budget.admit("d"))
    }

    @Test
    fun gateCountsUsers() {
        assertFalse(ContactExchangeGate.active)
        ContactExchangeGate.enter()
        ContactExchangeGate.enter()
        ContactExchangeGate.leave()
        assertTrue(ContactExchangeGate.active)
        ContactExchangeGate.leave()
        ContactExchangeGate.leave()
        assertFalse(ContactExchangeGate.active)
    }
}
