package net.massa.gossip.mesh

import kotlin.random.Random

/**
 * Chooses which seen phones to connect to. In a crowd a phone hears far more
 * neighbours than it can link to, and choosing by signal strength alone makes
 * clusters of nearby phones that only talk among themselves. So candidates
 * above a signal floor are picked at random, and one link is periodically
 * replaced by a new random neighbour.
 *
 * Pure logic, no Android types: driven by the radio's thread and unit-tested.
 * Addresses are whatever the platform shows for a peer (on Android a BLE
 * address, often a rotating random one).
 */
class NeighbourSelector(
    private val maxLinks: Int = MeshConstants.MAX_LINKS,
    /** Below this a link is unlikely to carry anything; not a ranking. */
    private val minRssi: Int = -95,
    /** A candidate not heard for this long is forgotten. */
    private val candidateTtlMs: Long = 30_000,
    /** A peer just disconnected or rotated out is not picked again for this long. */
    private val cooldownMs: Long = 60_000,
    private val random: Random = Random.Default,
) {
    private class Candidate(var rssi: Int, var lastSeenMs: Long)

    private val candidates = HashMap<String, Candidate>()
    private val cooldownUntil = HashMap<String, Long>()

    fun onSeen(address: String, rssi: Int, nowMs: Long) {
        val candidate = candidates[address]
        if (candidate == null) {
            candidates[address] = Candidate(rssi, nowMs)
        } else {
            candidate.rssi = rssi
            candidate.lastSeenMs = nowMs
        }
    }

    fun onDisconnected(address: String, nowMs: Long) {
        cooldownUntil[address] = nowMs + cooldownMs
    }

    /**
     * Addresses to connect to now, at random among eligible candidates, enough
     * to fill the free link slots. [busy] are addresses already linked or being
     * connected, in either role.
     */
    fun pickConnections(busy: Set<String>, nowMs: Long): List<String> {
        prune(nowMs)
        val free = maxLinks - busy.size
        if (free <= 0) return emptyList()
        return eligible(busy, nowMs).shuffled(random).take(free)
    }

    /**
     * A link to drop to make room for a new neighbour, or null. Only when every
     * slot is taken, some eligible candidate is waiting, and the link has been
     * up for at least [minAgeMs]. [links] maps each linked address to the time
     * its link came up.
     */
    fun pickRotationVictim(links: Map<String, Long>, nowMs: Long, minAgeMs: Long): String? {
        prune(nowMs)
        if (links.size < maxLinks) return null
        if (eligible(links.keys, nowMs).isEmpty()) return null
        val old = links.filterValues { nowMs - it >= minAgeMs }.keys.toList()
        return if (old.isEmpty()) null else old[random.nextInt(old.size)]
    }

    fun candidateCount(): Int = candidates.size

    private fun eligible(busy: Set<String>, nowMs: Long): List<String> =
        candidates.filter { (address, candidate) ->
            address !in busy &&
                candidate.rssi >= minRssi &&
                (cooldownUntil[address] ?: 0L) <= nowMs
        }.keys.toList()

    private fun prune(nowMs: Long) {
        candidates.entries.removeAll { nowMs - it.value.lastSeenMs > candidateTtlMs }
        cooldownUntil.entries.removeAll { it.value <= nowMs }
    }
}
