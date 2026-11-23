package net.massa.gossip.fulldebug

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import android.webkit.WebView
import net.massa.gossip.BuildConfig
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.SecureRandom
import java.util.TimeZone
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * The record of the full debug build: JSON lines in
 * `filesDir/debug-logs/NNNNNN.jsonl`, written by one thread.
 *
 * Every line gets its number `n` here (one counter for the web view and the
 * native code, never reused in one install). A segment is closed at 16 MiB and
 * starts with a header line; the oldest segments are deleted when the total
 * goes over the cap (5 GiB by default; 1, 2 or 5 GiB) or when the free space
 * of the phone falls under 2 GiB.
 *
 * Nothing here may throw into the app: every entry point catches all.
 */
object DebugLogWriter {
    const val SEGMENT_MAX = 16L * 1024 * 1024
    const val GIB = 1024L * 1024 * 1024
    const val DEFAULT_CAP = 5L * GIB
    const val MIN_CAP = 32L * 1024 * 1024
    /** Never leave the phone with less free space than this: oldest segments go first. */
    const val MIN_FREE = 2L * GIB
    private const val PREFS = "gossip-full-debug"
    private const val CAP_PREFS = "CapacitorStorage"
    const val INSTALL_ID_KEY = "gossip-full-debug-install-id"
    private val SEGMENT_NAME = Regex("^\\d{6}\\.jsonl$")
    private val N_PREFIX = Regex("^\\{\"n\":(\\d+)")
    private val N_ANY = Regex("\\{\"n\":(\\d+)")

    val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "gossip-debug-log").apply { isDaemon = true }
    }

    /** Errors found natively (previous exit, uncaught exception) for the JS pop-up. */
    val pendingErrors = ConcurrentLinkedQueue<String>()

    @Volatile private var appContext: Context? = null
    private var dir: File? = null
    private var out: BufferedOutputStream? = null
    private var fos: FileOutputStream? = null
    private var current: File? = null
    private var currentSize = 0L
    private var nextN = 1L
    private var cap = DEFAULT_CAP
    private var webInfo: JSONObject? = null
    private var flushScheduled = false
    @Volatile var installId: String = ""
        private set

    private fun prefs(): SharedPreferences? =
        appContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun init(context: Context) {
        synchronized(this) {
            if (appContext != null) return
            appContext = context.applicationContext
        }
        installId = loadInstallId(context.applicationContext)
        submit { openRecord() }
    }

    private fun loadInstallId(context: Context): String = try {
        // Kept in Capacitor's Preferences store, so the web view can read it too.
        val p = context.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE)
        val existing = p.getString(INSTALL_ID_KEY, null)
        if (existing != null && Regex("^[A-Za-z0-9_-]{1,64}$").matches(existing)) {
            existing
        } else {
            val bytes = ByteArray(16)
            SecureRandom().nextBytes(bytes)
            val id = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            p.edit().putString(INSTALL_ID_KEY, id).commit()
            id
        }
    } catch (t: Throwable) {
        "unknown"
    }

    fun submit(task: () -> Unit) {
        try {
            executor.execute { safe(task) }
        } catch (t: Throwable) {
            // executor gone: nothing to do
        }
    }

    /** Runs on the writer thread and waits for it, at most `timeoutMs`. */
    fun <T> call(timeoutMs: Long, task: () -> T): T? = try {
        executor.submit<T> { task() }.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (t: Throwable) {
        null
    }

    private inline fun safe(task: () -> Unit) {
        try {
            task()
        } catch (t: Throwable) {
            // never into the app
        }
    }

    // ── writer thread only below ─────────────────────────────────────

    private fun openRecord() {
        val ctx = appContext ?: return
        val d = File(ctx.filesDir, "debug-logs")
        d.mkdirs()
        dir = d
        cap = prefs()?.getLong("cap", DEFAULT_CAP) ?: DEFAULT_CAP
        nextN = recoverNextN()
        enforceCap()
        openNewSegment()
    }

    fun segments(): List<File> {
        val d = dir ?: return emptyList()
        return (d.listFiles() ?: emptyArray()).filter { SEGMENT_NAME.matches(it.name) }.sortedBy { it.name }
    }

    private fun recoverNextN(): Long {
        var best = prefs()?.getLong("lastN", 0L) ?: 0L
        val last = segments().lastOrNull()
        if (last != null) {
            try {
                RandomAccessFile(last, "r").use { raf ->
                    val len = raf.length()
                    val start = maxOf(0L, len - 256 * 1024)
                    val buf = ByteArray((len - start).toInt())
                    raf.seek(start)
                    raf.readFully(buf)
                    val text = String(buf, Charsets.UTF_8)
                    N_ANY.findAll(text).lastOrNull()?.groupValues?.get(1)?.toLongOrNull()?.let {
                        if (it > best) best = it
                    }
                }
            } catch (t: Throwable) {}
        }
        return best + 1
    }

    private fun openNewSegment() {
        closeSegment()
        val d = dir ?: return
        val lastIndex = segments().lastOrNull()?.name?.substring(0, 6)?.toIntOrNull() ?: 0
        val f = File(d, String.format("%06d.jsonl", lastIndex + 1))
        val stream = FileOutputStream(f, true)
        fos = stream
        out = BufferedOutputStream(stream, 64 * 1024)
        current = f
        currentSize = f.length()
        writeRaw(headerLine(f.name))
    }

    private fun closeSegment() {
        try {
            out?.flush()
            fos?.fd?.sync()
            out?.close()
        } catch (t: Throwable) {}
        out = null
        fos = null
        current = null
    }

    private fun upMs(): Long = try {
        if (Build.VERSION.SDK_INT >= 24) SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime() else SystemClock.elapsedRealtime()
    } catch (t: Throwable) {
        0L
    }

    private fun headerLine(segment: String): String {
        val f = JSONObject()
        f.put("install", installId)
        f.put("segment", segment)
        f.put("appId", BuildConfig.APPLICATION_ID)
        f.put("appVersion", BuildConfig.VERSION_NAME)
        f.put("versionCode", BuildConfig.VERSION_CODE)
        f.put("commit", BuildConfig.FULL_DEBUG_COMMIT)
        f.put("buildTime", BuildConfig.FULL_DEBUG_BUILD_TIME)
        f.put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
        f.put("android", Build.VERSION.RELEASE)
        f.put("sdk", Build.VERSION.SDK_INT)
        f.put("abi", Build.SUPPORTED_ABIS.joinToString(","))
        try {
            val pkg = WebView.getCurrentWebViewPackage()
            if (pkg != null) f.put("webview", "${pkg.packageName} ${pkg.versionName}")
        } catch (t: Throwable) {}
        f.put("tz", TimeZone.getDefault().id)
        f.put("tzOffsetMin", TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000)
        f.put("pid", Process.myPid())
        webInfo?.let { f.put("web", it) }
        return line("native", "header", "info", f)
    }

    fun line(src: String, ev: String, lvl: String, f: JSONObject, dur: Long? = null): String {
        val o = JSONObject()
        o.put("t", System.currentTimeMillis())
        o.put("up", upMs())
        o.put("src", src)
        o.put("ev", ev)
        o.put("lvl", lvl)
        if (dur != null) o.put("dur", dur)
        o.put("f", f)
        return o.toString()
    }

    /** Writes one line without its `n`; adds the number. Writer thread. */
    private fun writeRaw(lineNoN: String) {
        val o = out ?: return
        val trimmed = lineNoN.trim()
        if (trimmed.isEmpty()) return
        val n = nextN++
        val numbered = when {
            trimmed == "{}" -> "{\"n\":$n}"
            trimmed.startsWith("{") -> "{\"n\":$n," + trimmed.substring(1)
            else -> "{\"n\":$n,\"src\":\"native\",\"ev\":\"raw\",\"f\":${JSONObject.quote(trimmed)}}"
        }
        val bytes = (numbered + "\n").toByteArray(Charsets.UTF_8)
        o.write(bytes)
        currentSize += bytes.size
        if (currentSize >= SEGMENT_MAX) {
            prefs()?.edit()?.putLong("lastN", nextN - 1)?.apply()
            closeSegment()
            enforceCap()
            openNewSegment()
        }
    }

    private fun scheduleFlush() {
        if (flushScheduled) return
        flushScheduled = true
        try {
            executor.schedule({
                safe {
                    flushScheduled = false
                    out?.flush()
                }
            }, 250, TimeUnit.MILLISECONDS)
        } catch (t: Throwable) {
            flushScheduled = false
        }
    }

    /** Writes now and, when `sync`, to the disk itself. Writer thread. */
    fun flushNow(sync: Boolean) {
        out?.flush()
        if (sync) fos?.fd?.sync()
        prefs()?.edit()?.putLong("lastN", nextN - 1)?.apply()
    }

    private fun enforceCap() {
        val segs = segments().toMutableList()
        var total = segs.sumOf { it.length() }
        val d = dir
        fun lowSpace(): Boolean = try {
            d != null && d.usableSpace < MIN_FREE
        } catch (t: Throwable) {
            false
        }
        while ((total > cap || lowSpace()) && segs.size > 1) {
            val oldest = segs.removeAt(0)
            if (oldest == current) break
            total -= oldest.length()
            oldest.delete()
        }
    }

    // ── public API: any thread ───────────────────────────────────────

    /** Lines joined by `\n`, each a JSON object without `n`. */
    fun append(lines: String, urgent: Boolean) {
        submit {
            for (l in lines.split('\n')) writeRaw(l)
            if (urgent) flushNow(true) else scheduleFlush()
        }
    }

    fun appendLine(lineNoN: String, urgent: Boolean) {
        submit {
            writeRaw(lineNoN)
            if (urgent) flushNow(true) else scheduleFlush()
        }
    }

    /** For the uncaught-exception handler: write and sync before the process dies. */
    fun appendLineAndWait(lineNoN: String, timeoutMs: Long) {
        call(timeoutMs) {
            writeRaw(lineNoN)
            flushNow(true)
        }
    }

    fun native(lvl: String, tag: String, msg: String, tr: Throwable?) {
        try {
            val f = JSONObject()
            f.put("tag", tag)
            f.put("msg", msg)
            if (tr != null) f.put("err", throwableJson(tr))
            appendLine(line("native", "log", lvl, f), lvl == "error")
        } catch (t: Throwable) {}
    }

    fun throwableJson(tr: Throwable): JSONObject {
        val e = JSONObject()
        e.put("name", tr.javaClass.name)
        e.put("message", tr.message ?: "")
        e.put("stack", tr.stackTraceToString().take(64 * 1024))
        return e
    }

    fun setCap(bytes: Long) {
        submit {
            cap = maxOf(MIN_CAP, bytes)
            prefs()?.edit()?.putLong("cap", cap)?.apply()
            enforceCap()
        }
    }

    fun setWebInfo(info: JSONObject) {
        submit {
            webInfo = info
            val f = JSONObject(info.toString())
            writeRaw(line("native", "app.web_info", "info", f))
            scheduleFlush()
        }
    }

    fun clear() {
        call(10_000) {
            closeSegment()
            for (s in segments()) s.delete()
            openNewSegment()
        }
    }

    data class Stats(
        val bytes: Long,
        val segments: Int,
        val firstLine: Long,
        val lastLine: Long,
        val cap: Long,
    )

    fun stats(): Stats? = call(10_000) {
        flushNow(false)
        val segs = segments()
        var first = 0L
        segs.firstOrNull()?.let { f ->
            try {
                f.bufferedReader().use { r ->
                    val l = r.readLine()
                    if (l != null) N_PREFIX.find(l)?.groupValues?.get(1)?.toLongOrNull()?.let { first = it }
                }
            } catch (t: Throwable) {}
        }
        Stats(segs.sumOf { it.length() }, segs.size, first, nextN - 1, cap)
    }

    /** Flushes, then lists the segments with their current length (writer thread). */
    fun snapshot(): List<Pair<File, Long>>? = call(10_000) {
        flushNow(true)
        segments().map { it to it.length() }
    }

    fun nPrefix(line: String): Long? = N_PREFIX.find(line)?.groupValues?.get(1)?.toLongOrNull()
}
