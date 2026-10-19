package net.massa.gossip.mesh

/**
 * How much battery the radio may spend. Scanning is duty-cycled: on for
 * [scanOnMs], then off for [scanOffMs]. Links stay up while scanning is off.
 *
 * [rotationIntervalMs] is how often one link is replaced by a random new
 * neighbour, so that a crowd does not settle into clusters that never hear
 * from each other. The node's simulation (gossip-node `docs/SIMULATION.md`)
 * is where these values get tuned.
 */
enum class PowerMode(
    val scanOnMs: Long,
    val scanOffMs: Long,
    val rotationIntervalMs: Long,
    val lowLatencyAdvertising: Boolean,
) {
    PERFORMANCE(scanOnMs = 10_000, scanOffMs = 2_000, rotationIntervalMs = 60_000, lowLatencyAdvertising = true),
    BALANCED(scanOnMs = 5_000, scanOffMs = 10_000, rotationIntervalMs = 120_000, lowLatencyAdvertising = false),
    POWER_SAVER(scanOnMs = 3_000, scanOffMs = 30_000, rotationIntervalMs = 300_000, lowLatencyAdvertising = false);

    companion object {
        fun fromName(name: String?): PowerMode =
            entries.firstOrNull { it.name.equals(name, ignoreCase = true) } ?: BALANCED
    }
}
