package net.massa.gossip.mesh

import android.content.Context
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * Joins the radio and the core, for the whole process: [MeshService] owns the
 * radio's lifetime and starts the core before the radio, so no link event is
 * lost; [MeshNodePlugin] starts and stops both. Radio events reach the core
 * in order on one thread; plugin calls run on another, so a slow call (a
 * storage sweep, an upstream fetch) never holds back incoming chunks.
 */
object MeshNodeBridge : MeshRadioListener, MeshCoreSink {

    fun interface ArrivalListener {
        fun onArrival(messages: List<MeshKeyValue>, announcements: List<ByteArray>)
    }

    fun interface LinksListener {
        fun onLinksChanged(linkCount: Int)
    }

    private val events: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "gossip-mesh-events") }
    private val calls: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "gossip-mesh-calls") }

    private val lock = Any()
    @Volatile private var core: MeshCore? = null
    @Volatile private var radio: MeshRadio? = null

    private val inbound = InboundBudget()

    private val arrivalListeners = CopyOnWriteArrayList<ArrivalListener>()
    private val linksListeners = CopyOnWriteArrayList<LinksListener>()

    /** Starts the core if it is not running; [configJson] only applies to a fresh start. */
    fun startCore(context: Context, configJson: String): MeshCore = synchronized(lock) {
        core?.let { return it }
        val dataDir = File(context.filesDir, "mesh").apply { mkdirs() }
        val created = MeshCoreFactory.create(context.applicationContext)
        created.start(dataDir.absolutePath, configJson, this)
        core = created
        created
    }

    fun stopCore() = synchronized(lock) {
        core?.stop()
        core = null
    }

    fun isCoreRunning(): Boolean = core != null

    fun attachRadio(radio: MeshRadio, mode: PowerMode) = synchronized(lock) {
        this.radio?.stop()
        this.radio = radio
        radio.start(mode, this)
    }

    fun detachRadio() = synchronized(lock) {
        radio?.stop()
        radio = null
    }

    fun setPowerMode(mode: PowerMode) {
        radio?.setPowerMode(mode)
    }

    fun linkCount(): Int = radio?.linkCount() ?: 0

    /** Runs [block] against the core on the calls thread; fails when the core is not started. */
    fun <T> call(block: (MeshCore) -> T): Future<T> = calls.submit<T> {
        val running = core ?: throw IllegalStateException("The mesh node is not started")
        block(running)
    }

    fun addArrivalListener(listener: ArrivalListener) = arrivalListeners.add(listener)

    fun removeArrivalListener(listener: ArrivalListener) = arrivalListeners.remove(listener)

    fun addLinksListener(listener: LinksListener) = linksListeners.add(listener)

    fun removeLinksListener(listener: LinksListener) = linksListeners.remove(listener)

    // ── MeshRadioListener: radio thread → events thread ──────────────────

    override fun onLinkUp(linkId: Int, mtu: Int) {
        events.execute { core?.linkUp(linkId, mtu) }
        notifyLinks()
    }

    override fun onLinkDown(linkId: Int) {
        events.execute { core?.linkDown(linkId) }
        notifyLinks()
    }

    override fun onFrameIn(linkId: Int, frame: ByteArray) {
        // a link that outpaces the core is closed rather than queued without bound
        if (!inbound.tryAdd(linkId, frame.size)) {
            radio?.closeLink(linkId)
            return
        }
        events.execute {
            try {
                core?.frameIn(linkId, frame)
            } finally {
                inbound.release(linkId, frame.size)
            }
        }
    }

    // ── MeshCoreSink: core → radio and app ───────────────────────────────

    override fun sendFrame(linkId: Int, frame: ByteArray): Boolean = radio?.sendFrame(linkId, frame) ?: false

    override fun closeLink(linkId: Int) {
        radio?.closeLink(linkId)
    }

    override fun arrival(messages: List<MeshKeyValue>, announcements: List<ByteArray>) {
        for (listener in arrivalListeners) listener.onArrival(messages, announcements)
    }

    private fun notifyLinks() {
        val count = linkCount()
        for (listener in linksListeners) listener.onLinksChanged(count)
    }
}
