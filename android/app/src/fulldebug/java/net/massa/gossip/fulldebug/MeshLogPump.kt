package net.massa.gossip.fulldebug

import android.os.Process
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Full debug build only: copies the mesh node's Rust log lines into the record.
 *
 * The full-debug mesh library (gossip-mobile built with `--features full-debug`)
 * writes each `tracing` event to the Android log, tag `GossipMesh`, as one JSON
 * object: `{"t":ms,"lvl":"debug","target":"gossip_repl::…","msg":"…","f":{…}}`.
 * An app may read its own log lines without any permission, so this reads them
 * back from `logcat` (this process only) and writes each as a `src:"mesh"` line.
 *
 * A normal build has neither this file nor the log lines (docs/PRIVACY-CHECKS.md).
 */
object MeshLogPump {
    private const val TAG = "GossipMesh"

    @Volatile private var started = false

    /** Newest mesh time copied (pump thread only). */
    private var lastT = 0L

    /** After a logcat restart, which replays the buffer: lines up to this time are copies. */
    private var skipUpTo = 0L

    @JvmStatic
    fun start() {
        if (started) return
        started = true
        val t = Thread({ loop() }, "gm-log-pump")
        t.isDaemon = true
        t.priority = Thread.MIN_PRIORITY
        t.start()
    }

    private fun loop() {
        var backoffMs = 1_000L
        while (true) {
            try {
                // -v raw: the message only (it carries its own time and level);
                // --pid: this process only, from its first line still in the buffer
                val proc = ProcessBuilder(
                    "logcat", "-v", "raw", "--pid=${Process.myPid()}", "$TAG:V", "*:S",
                ).redirectErrorStream(true).start()
                BufferedReader(InputStreamReader(proc.inputStream, Charsets.UTF_8)).use { r ->
                    while (true) {
                        val l = r.readLine() ?: break
                        copy(l)
                        backoffMs = 1_000L
                    }
                }
                proc.destroy()
            } catch (t: Throwable) {
                // never into the app
            }
            skipUpTo = lastT
            note("mesh.log.pump_restart", "warn", JSONObject().put("retry_ms", backoffMs))
            try {
                Thread.sleep(backoffMs)
            } catch (e: InterruptedException) {
                return
            }
            backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
        }
    }

    private fun copy(raw: String) {
        val s = raw.trim()
        if (!s.startsWith("{")) {
            // a logcat banner ("--------- beginning of main") or a cut line
            if (s.isNotEmpty() && !s.startsWith("-----")) {
                note("mesh.log.unparsed", "warn", JSONObject().put("raw", s))
            }
            return
        }
        try {
            val o = JSONObject(s)
            val t = o.optLong("t", 0L)
            // lines of several threads may arrive slightly out of order: only a
            // replay after a restart is skipped
            if (t != 0L && t <= skipUpTo) return
            if (t > lastT) lastT = t
            val f = o.optJSONObject("f") ?: JSONObject()
            f.put("target", o.optString("target"))
            f.put("msg", o.optString("msg"))
            val line = JSONObject(DebugLogWriter.line("mesh", "mesh.log", o.optString("lvl", "debug"), f))
            if (t != 0L) line.put("t", t)
            DebugLogWriter.appendLine(line.toString(), o.optString("lvl") == "error")
        } catch (e: Throwable) {
            note("mesh.log.unparsed", "warn", JSONObject().put("raw", s))
        }
    }

    private fun note(ev: String, lvl: String, f: JSONObject) {
        try {
            DebugLogWriter.appendLine(DebugLogWriter.line("mesh", ev, lvl, f), false)
        } catch (t: Throwable) {}
    }
}
