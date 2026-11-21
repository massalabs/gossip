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
 */
object DebugLog {
    @JvmStatic
    fun d(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.d(tag, msg)
    }

    @JvmStatic
    fun i(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.i(tag, msg)
    }

    @JvmStatic
    fun w(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.w(tag, msg)
    }

    @JvmStatic
    fun w(tag: String, msg: String, tr: Throwable) {
        if (BuildConfig.DEBUG) Log.w(tag, msg, tr)
    }

    @JvmStatic
    fun e(tag: String, msg: String) {
        if (BuildConfig.DEBUG) Log.e(tag, msg)
    }

    @JvmStatic
    fun e(tag: String, msg: String, tr: Throwable) {
        if (BuildConfig.DEBUG) Log.e(tag, msg, tr)
    }
}
