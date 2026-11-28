package net.massa.gossip

/**
 * Remembers a request to close the scanner that arrives while it is still
 * opening: between `scan()` and the scanner being on screen, which includes
 * the camera permission dialog. There is no scanner to close yet, so the
 * request is kept and applied when the scanner appears.
 *
 * A request made when no scan is opening is not kept: it must not close the
 * next scan.
 */
class ScanOpening {
    private var opening = false
    private var closeRequested = false

    /** A scan was asked for. */
    @Synchronized
    fun begin() {
        opening = true
        closeRequested = false
    }

    /** Asks to close the scan that is opening. False when none is. */
    @Synchronized
    fun requestClose(): Boolean {
        if (!opening) return false
        closeRequested = true
        return true
    }

    /** Whether the scan that is opening was asked to close. */
    @Synchronized
    fun closeRequested(): Boolean = opening && closeRequested

    /** The scanner is on screen. Returns whether it was asked to close meanwhile. */
    @Synchronized
    fun opened(): Boolean {
        val close = opening && closeRequested
        opening = false
        closeRequested = false
        return close
    }

    /** The scan ended, or never opened. */
    @Synchronized
    fun end() {
        opening = false
        closeRequested = false
    }
}
