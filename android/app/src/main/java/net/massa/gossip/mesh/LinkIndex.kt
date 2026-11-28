package net.massa.gossip.mesh

/** Which phone opened a link: this one ([CENTRAL]) or the other one ([PERIPHERAL]). */
enum class LinkRole { CENTRAL, PERIPHERAL }

/**
 * The radio's links by Bluetooth address and role. Pure logic, driven by the
 * radio thread, unit-tested.
 *
 * When two phones connect to each other at the same moment, this phone holds
 * two links to one address: one it opened (central) and one the other phone
 * opened (peripheral). Both must be usable until the core, which keeps one link
 * per peer, closes one of them: each gets its own chunks and send
 * confirmations, and closing one leaves the other. Indexed by address alone,
 * the second link would hide the first, whose chunks and confirmations would
 * then be dropped, and if the core kept the hidden one both would be lost.
 */
class LinkIndex {
    private data class Key(val address: String, val role: LinkRole)

    private val ids = HashMap<Key, Int>()

    /** False, adding nothing, when [address] already has a link in [role]. */
    fun add(address: String, role: LinkRole, id: Int): Boolean {
        val key = Key(address, role)
        if (key in ids) return false
        ids[key] = id
        return true
    }

    fun get(address: String, role: LinkRole): Int? = ids[Key(address, role)]

    /** Removes the link [id], if it is still the one indexed there. */
    fun remove(address: String, role: LinkRole, id: Int) {
        val key = Key(address, role)
        if (ids[key] == id) ids.remove(key)
    }

    /** Every link to [address], in either role. */
    fun idsFor(address: String): List<Int> = LinkRole.entries.mapNotNull { get(address, it) }

    /** Addresses with at least one link. */
    fun addresses(): Set<String> = ids.keys.mapTo(HashSet()) { it.address }

    /** Links, not addresses: two links to one phone count as two. */
    fun size(): Int = ids.size

    fun clear() = ids.clear()
}

/**
 * How the radio closes a link when the same device may also carry another one.
 *
 * Android keeps one Bluetooth LE connection per device and shares it between
 * the app's GATT server and its GATT clients (the mesh central and the contact
 * exchange): the server callback even reports the connections this phone
 * opened as central. A link is a use of that connection, not the connection.
 */
object LinkClosing {
    enum class Action {
        /** End the connection: nothing else of this app uses it. */
        CUT,

        /** Peripheral link: drop it but leave the connection, which another use holds. */
        STOP_USING,

        /**
         * Central link: stop using its GATT client but keep it open until the
         * peripheral link to the same device ends. When the client is this app's
         * last hold on the connection, closing it may let the stack drop the
         * connection, and with it the peripheral link the core kept.
         */
        PARK,
    }

    /**
     * `BluetoothGattServer.cancelConnection` ends the device's connection for
     * every user: while this phone is also central to the device, or a contact
     * exchange may be using it, cancelling would cut those too.
     */
    fun peripheral(isCentralTo: Boolean, exchangeActive: Boolean): Action =
        if (isCentralTo || exchangeActive) Action.STOP_USING else Action.CUT

    fun central(peripheralLinkUp: Boolean): Action = if (peripheralLinkUp) Action.PARK else Action.CUT
}
