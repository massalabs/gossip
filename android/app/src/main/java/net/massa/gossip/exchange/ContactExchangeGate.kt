package net.massa.gossip.exchange

import java.util.concurrent.atomic.AtomicInteger

/**
 * Whether a contact exchange is using Bluetooth right now. Android shares one
 * GATT connection per peer between all GATT servers of the app, so the mesh
 * radio sees the exchange's connections too: while this is active it leaves
 * connections it did not ask for alone instead of cancelling them.
 */
object ContactExchangeGate {
    private val users = AtomicInteger(0)

    val active: Boolean get() = users.get() > 0

    fun enter() {
        users.incrementAndGet()
    }

    fun leave() {
        users.updateAndGet { if (it > 0) it - 1 else 0 }
    }
}
