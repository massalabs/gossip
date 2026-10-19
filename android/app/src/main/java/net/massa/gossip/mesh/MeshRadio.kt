package net.massa.gossip.mesh

/**
 * The radio layer of the mesh: it finds neighbours and moves chunks, nothing
 * more. Chunking, link handshakes, trust and replication all live in the core
 * (see [MeshCore]). A link id names one BLE connection for as long as it lives
 * and is never reused.
 */
interface MeshRadio {
    fun start(mode: PowerMode, listener: MeshRadioListener)

    fun stop()

    /** Switches power mode without dropping links. */
    fun setPowerMode(mode: PowerMode)

    /**
     * Queues one chunk of at most `mtu − 3` bytes for the link. Returns false
     * when the link is gone, the chunk is too large, or the link's queue is
     * full; chunks of one link go out in order.
     */
    fun sendFrame(linkId: Int, frame: ByteArray): Boolean

    /** Disconnects the link; [MeshRadioListener.onLinkDown] follows. */
    fun closeLink(linkId: Int)

    fun linkCount(): Int
}

/** Called on the radio's own thread; implementations hand work off quickly. */
interface MeshRadioListener {
    /** The link is ready both ways; [mtu] is the negotiated ATT MTU. */
    fun onLinkUp(linkId: Int, mtu: Int)

    fun onLinkDown(linkId: Int)

    fun onFrameIn(linkId: Int, frame: ByteArray)
}
