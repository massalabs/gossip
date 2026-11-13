package net.massa.gossip.mesh

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NeighbourSelectorTest {

    private fun selector(seed: Int = 1) = NeighbourSelector(
        maxLinks = 3,
        minRssi = -90,
        candidateTtlMs = 10_000,
        cooldownMs = 5_000,
        random = Random(seed),
    )

    @Test
    fun leavesAPhoneThatRefusedOurLinkAloneLongerThanALostOne() {
        val s = NeighbourSelector(
            maxLinks = 3,
            minRssi = -90,
            candidateTtlMs = 1_000_000,
            cooldownMs = 5_000,
            refusedCooldownMs = 600_000,
            random = Random(1),
        )
        s.onSeen("lost", -60, 0)
        s.onSeen("dup", -60, 0)
        s.onDisconnected("lost", 0)
        s.onDisconnected("dup", 0)
        s.onRefused("dup", 0)
        // a later plain disconnect does not shorten the refusal
        s.onDisconnected("dup", 1_000)
        s.onSeen("lost", -60, 10_000)
        s.onSeen("dup", -60, 10_000)
        assertEquals(listOf("lost"), s.pickConnections(emptySet(), 10_000))
        s.onSeen("dup", -60, 600_001)
        assertTrue("dup" in s.pickConnections(emptySet(), 600_001))
    }

    @Test
    fun fillsOnlyTheFreeSlots() {
        val s = selector()
        for (i in 0 until 10) s.onSeen("p$i", -60, 0)
        assertEquals(3, s.pickConnections(emptySet(), 0).size)
        assertEquals(1, s.pickConnections(setOf("p0", "p1"), 0).size)
        assertTrue(s.pickConnections(setOf("p0", "p1", "p2"), 0).isEmpty())
    }

    @Test
    fun neverPicksBusyWeakOrStaleCandidates() {
        val s = selector()
        s.onSeen("busy", -50, 0)
        s.onSeen("weak", -95, 0)
        s.onSeen("stale", -50, 0)
        s.onSeen("good", -80, 9_000)
        val picked = s.pickConnections(setOf("busy"), 11_000)
        assertEquals(listOf("good"), picked)
        assertEquals(1, s.candidateCount())
    }

    @Test
    fun cooldownKeepsADroppedPeerOutForAWhile() {
        val s = selector()
        s.onSeen("a", -50, 0)
        s.onDisconnected("a", 0)
        assertTrue(s.pickConnections(emptySet(), 1_000).isEmpty())
        s.onSeen("a", -50, 5_500)
        assertEquals(listOf("a"), s.pickConnections(emptySet(), 5_500))
    }

    @Test
    fun picksAtRandomRatherThanByStrongestSignal() {
        // With strongest-first, "strong" would win every time.
        val counts = HashMap<String, Int>()
        for (seed in 0 until 200) {
            val s = NeighbourSelector(maxLinks = 1, random = Random(seed))
            s.onSeen("strong", -40, 0)
            for (i in 0 until 9) s.onSeen("weaker$i", -85, 0)
            val pick = s.pickConnections(emptySet(), 0).single()
            counts[pick] = (counts[pick] ?: 0) + 1
        }
        assertTrue("strong picked ${counts["strong"]} times out of 200", (counts["strong"] ?: 0) < 60)
        assertTrue(counts.size > 5)
    }

    @Test
    fun rotationOnlyWhenFullWithSomeoneWaitingAndOldLinks() {
        val s = selector()
        val links = mapOf("a" to 0L, "b" to 0L, "c" to 50_000L)
        for (address in links.keys) s.onSeen(address, -50, 59_000)

        // nobody waiting
        assertNull(s.pickRotationVictim(links, 60_000, 30_000))

        s.onSeen("new", -70, 59_000)
        val victim = s.pickRotationVictim(links, 60_000, 30_000)
        assertNotNull(victim)
        // "c" has been up for 10 s only
        assertTrue(victim in setOf("a", "b"))

        // not full
        assertNull(s.pickRotationVictim(mapOf("a" to 0L, "b" to 0L), 60_000, 30_000))
        // all links too young
        assertNull(s.pickRotationVictim(links.mapValues { 55_000L }, 60_000, 30_000))
    }

    @Test
    fun rotationVictimVariesAcrossRotations() {
        val links = (0 until 3).associate { "p$it" to 0L }
        val victims = HashSet<String>()
        for (seed in 0 until 50) {
            val s = selector(seed)
            s.onSeen("waiting", -60, 100_000)
            victims.add(s.pickRotationVictim(links, 100_000, 30_000)!!)
        }
        assertEquals(links.keys, victims)
        assertFalse("waiting" in victims)
    }
}
