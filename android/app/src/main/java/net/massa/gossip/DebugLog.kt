package net.massa.gossip

import android.util.Log

/**
 * The only way the app's own code writes to logcat.
 *
 * A debug build logs exactly what `android.util.Log` would; a release build
 * writes nothing, as no log may remain in a release build. Any process with
 * the READ_LOGS permission, a bug report or a connected computer can read
 * logcat, so a line there can reveal what the user does and when.
 *
 * The arguments are still evaluated in a release build: pass plain values
 * only, never a call whose effect matters.
 *
 * The full debug build (-PfullDebug=true) also sends every line to its
 * on-disk record through [sink]; `BuildConfig.FULL_DEBUG` is a compile-time
 * false in every other build, so that branch is compiled out there.
 */
object DebugLog {
    /** Set only by the full debug build (net.massa.gossip.fulldebug.FullDebug). */
    @JvmStatic
    @Volatile
    var sink: ((level: String, tag: String, msg: String, tr: Throwable?) -> Unit)? = null

    private fun record(level: String, tag: String, msg: String, tr: Throwable?) {
        if (BuildConfig.FULL_DEBUG) {
            try {
                sink?.invoke(level, tag, msg, tr)
            } catch (t: Throwable) {
                // never into the app
            }
        }
    }

    @JvmStatic
    fun d(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.d(tag, msg)
        record("debug", tag, msg, null)
    }

    @JvmStatic
    fun i(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.i(tag, msg)
        record("info", tag, msg, null)
    }

    @JvmStatic
    fun w(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.w(tag, msg)
        record("warn", tag, msg, null)
    }

    @JvmStatic
    fun w(tag: String, msg: String, tr: Throwable) {
        if (BuildConfig.DEBUG) Log.w(tag, msg, tr)
        record("warn", tag, msg, tr)
    }

    @JvmStatic
    fun e(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.e(tag, msg)
        record("error", tag, msg, null)
    }

    @JvmStatic
    fun e(tag: String, msg: String, tr: Throwable) {
        if (BuildConfig.DEBUG) Log.e(tag, msg, tr)
        record("error", tag, msg, tr)
    }
}
