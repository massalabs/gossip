package net.massa.gossip.fulldebug

import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.zip.GZIPOutputStream

/**
 * JS access to the record of the full debug build (registered only in that
 * build). See DebugLogWriter for the files, and src/fullDebug/ for the JS side.
 */
@CapacitorPlugin(name = "DebugLogFile")
class DebugLogFilePlugin : Plugin() {
    companion object {
        const val PIECE_SIZE = 512 * 1024
        private val SEGMENT_NAME = Regex("^\\d{6}\\.jsonl$")
    }

    /** Upload preparation and piece reads: off the writer thread. */
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "gossip-debug-upload").apply { isDaemon = true }
    }

    override fun load() {
        FullDebug.install(context)
    }

    override fun handleOnPause() {
        DebugLogWriter.submit { DebugLogWriter.flushNow(true) }
    }

    private fun fail(call: PluginCall, t: Throwable) {
        try {
            call.reject(t.javaClass.simpleName + ": " + (t.message ?: ""))
        } catch (ignored: Throwable) {}
    }

    @PluginMethod
    fun append(call: PluginCall) {
        try {
            val lines = call.getString("lines") ?: ""
            DebugLogWriter.append(lines, call.getBoolean("urgent", false) == true)
            call.resolve()
        } catch (t: Throwable) {
            fail(call, t)
        }
    }

    @PluginMethod
    fun flush(call: PluginCall) {
        try {
            DebugLogWriter.call(5_000) { DebugLogWriter.flushNow(true) }
            call.resolve()
        } catch (t: Throwable) {
            fail(call, t)
        }
    }

    @PluginMethod
    fun stats(call: PluginCall) {
        worker.execute {
            try {
                val s = DebugLogWriter.stats()
                val r = JSObject()
                r.put("installId", DebugLogWriter.installId)
                r.put("bytes", s?.bytes ?: 0)
                r.put("segments", s?.segments ?: 0)
                r.put("firstLine", s?.firstLine ?: 0)
                r.put("lastLine", s?.lastLine ?: 0)
                r.put("cap", s?.cap ?: DebugLogWriter.DEFAULT_CAP)
                call.resolve(r)
            } catch (t: Throwable) {
                fail(call, t)
            }
        }
    }

    @PluginMethod
    fun listSegments(call: PluginCall) {
        worker.execute {
            try {
                val arr = JSArray()
                for ((f, len) in DebugLogWriter.snapshot() ?: emptyList()) {
                    val o = JSObject()
                    o.put("name", f.name)
                    o.put("size", len)
                    arr.put(o)
                }
                val r = JSObject()
                r.put("segments", arr)
                call.resolve(r)
            } catch (t: Throwable) {
                fail(call, t)
            }
        }
    }

    @PluginMethod
    fun readSegment(call: PluginCall) {
        worker.execute {
            try {
                val name = call.getString("name") ?: ""
                if (!SEGMENT_NAME.matches(name)) throw IllegalArgumentException("bad segment name")
                val offset = (call.getDouble("offset") ?: 0.0).toLong()
                val length = minOf((call.getDouble("length") ?: PIECE_SIZE.toDouble()).toLong(), 4L * 1024 * 1024).toInt()
                val f = File(File(context.filesDir, "debug-logs"), name)
                val data = readRange(f, offset, length)
                val r = JSObject()
                r.put("data", Base64.encodeToString(data, Base64.NO_WRAP))
                r.put("size", f.length())
                call.resolve(r)
            } catch (t: Throwable) {
                fail(call, t)
            }
        }
    }

    @PluginMethod
    fun setCap(call: PluginCall) {
        try {
            val bytes = (call.getDouble("bytes") ?: DebugLogWriter.DEFAULT_CAP.toDouble()).toLong()
            DebugLogWriter.setCap(bytes)
            call.resolve()
        } catch (t: Throwable) {
            fail(call, t)
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        worker.execute {
            try {
                DebugLogWriter.clear()
                call.resolve()
            } catch (t: Throwable) {
                fail(call, t)
            }
        }
    }

    @PluginMethod
    fun setWebInfo(call: PluginCall) {
        try {
            DebugLogWriter.setWebInfo(JSONObject(call.data.toString()))
            call.resolve()
        } catch (t: Throwable) {
            fail(call, t)
        }
    }

    @PluginMethod
    fun takeNativeErrors(call: PluginCall) {
        try {
            val arr = JSArray()
            while (true) {
                val e = DebugLogWriter.pendingErrors.poll() ?: break
                arr.put(e)
            }
            val r = JSObject()
            r.put("errors", arr)
            call.resolve(r)
        } catch (t: Throwable) {
            fail(call, t)
        }
    }

    // ── upload: gzip + encrypt + cut natively, so that 1 GiB never sits in memory ──

    private fun uploadDir(): File = File(context.cacheDir, "debug-upload").apply { mkdirs() }

    private fun uploadFile(): File = File(uploadDir(), "upload.gdl1")

    /**
     * Writes one gzip stream of the record (lines numbered `fromLine` and
     * after; every segment keeps its header line), encrypted (GDL1, see
     * Gdl1.kt) to `recipientKey` (base64 DER of the developers' public key),
     * into the cache, removing `f.c` and `f.s` from every line when `strip`
     * (before compression). The plaintext never reaches the disk. Returns the
     * encrypted file's size, piece count and SHA-256, and the gzip stream's
     * size and SHA-256. Without a valid key nothing is written.
     */
    @PluginMethod
    fun prepareUpload(call: PluginCall) {
        worker.execute {
            val target = uploadFile()
            try {
                val strip = call.getBoolean("strip", false) == true
                val fromLine = (call.getDouble("fromLine") ?: 0.0).toLong()
                val recipient = Gdl1.recipient(
                    call.getString("recipientKey")
                        ?: throw IllegalArgumentException("no key to encrypt the logs: nothing is sent unencrypted"),
                )
                val segs = DebugLogWriter.snapshot() ?: throw IllegalStateException("record not ready")
                // An unencrypted file of an older version of this build.
                File(uploadDir(), "upload.gz").delete()
                target.delete()
                val cipherDigest = MessageDigest.getInstance("SHA-256")
                val plainDigest = MessageDigest.getInstance("SHA-256")
                var firstN = -1L
                var lastN = -1L
                var rawBytes = 0L
                var lines = 0L
                val encrypted = Gdl1.Writer(
                    DigestOutputStream(BufferedOutputStream(FileOutputStream(target), 256 * 1024), cipherDigest),
                    recipient,
                )
                val plain = DigestOutputStream(encrypted, plainDigest)
                GZIPOutputStream(plain, 64 * 1024).use { gz ->
                    for ((file, length) in segs) {
                        var header: String? = null
                        var headerWritten = false
                        val reader = InputStreamReader(BoundedInput(file, length), Charsets.UTF_8).buffered(256 * 1024)
                        reader.use { r ->
                            var first = true
                            while (true) {
                                val line = r.readLine() ?: break
                                if (line.isEmpty()) continue
                                val n = DebugLogWriter.nPrefix(line)
                                if (first) {
                                    first = false
                                    if (line.contains("\"ev\":\"header\"")) {
                                        header = line
                                        if (n == null || n >= fromLine) {
                                            writeLine(gz, line)
                                            headerWritten = true
                                            rawBytes += line.length + 1
                                            lines++
                                            if (n != null) {
                                                if (firstN < 0) firstN = n
                                                lastN = maxOf(lastN, n)
                                            }
                                        }
                                        continue
                                    }
                                }
                                if (n != null && n < fromLine) continue
                                if (!headerWritten && header != null) {
                                    writeLine(gz, header!!)
                                    headerWritten = true
                                }
                                val out = if (strip) stripLine(line) else line
                                writeLine(gz, out)
                                rawBytes += out.length + 1
                                lines++
                                if (n != null) {
                                    if (firstN < 0) firstN = n
                                    lastN = maxOf(lastN, n)
                                }
                            }
                        }
                    }
                }
                val size = target.length()
                val r = JSObject()
                r.put("enc", Gdl1.ENC)
                r.put("size", size)
                r.put("pieces", ((size + PIECE_SIZE - 1) / PIECE_SIZE).toInt())
                r.put("pieceSize", PIECE_SIZE)
                r.put("sha256", Gdl1.hex(cipherDigest.digest()))
                r.put("plainSize", plain.count)
                r.put("plainSha256", Gdl1.hex(plainDigest.digest()))
                r.put("fromLine", if (firstN < 0) 0 else firstN)
                r.put("toLine", if (lastN < 0) 0 else lastN)
                r.put("rawBytes", rawBytes)
                r.put("lines", lines)
                call.resolve(r)
            } catch (t: Throwable) {
                target.delete()
                fail(call, t)
            }
        }
    }

    @PluginMethod
    fun readPiece(call: PluginCall) {
        worker.execute {
            try {
                val n = call.getInt("n") ?: 0
                val data = readRange(uploadFile(), n.toLong() * PIECE_SIZE, PIECE_SIZE)
                val r = JSObject()
                r.put("data", Base64.encodeToString(data, Base64.NO_WRAP))
                call.resolve(r)
            } catch (t: Throwable) {
                fail(call, t)
            }
        }
    }

    @PluginMethod
    fun discardUpload(call: PluginCall) {
        worker.execute {
            try {
                uploadFile().delete()
                File(uploadDir(), "upload.gz").delete()
            } catch (t: Throwable) {}
            call.resolve()
        }
    }

    private fun writeLine(out: OutputStream, line: String) {
        out.write(line.toByteArray(Charsets.UTF_8))
        out.write('\n'.code)
    }

    /** Removes `f.c` and `f.s` (content and secrets); a line that does not parse is kept as is. */
    private fun stripLine(line: String): String {
        if (!line.contains("\"c\":") && !line.contains("\"s\":")) return line
        return try {
            val o = JSONObject(line)
            val f = o.optJSONObject("f") ?: return line
            if (!f.has("c") && !f.has("s")) return line
            f.remove("c")
            f.remove("s")
            o.toString()
        } catch (t: Throwable) {
            line
        }
    }

    private fun readRange(f: File, offset: Long, length: Int): ByteArray {
        RandomAccessFile(f, "r").use { raf ->
            val len = raf.length()
            if (offset >= len) return ByteArray(0)
            val n = minOf(length.toLong(), len - offset).toInt()
            val buf = ByteArray(n)
            raf.seek(offset)
            raf.readFully(buf)
            return buf
        }
    }

    /** Reads a file up to a fixed length (the segment as it was at the snapshot). */
    private class BoundedInput(file: File, private var remaining: Long) : java.io.InputStream() {
        private val inner = java.io.FileInputStream(file)
        override fun read(): Int {
            if (remaining <= 0) return -1
            val b = inner.read()
            if (b >= 0) remaining--
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (remaining <= 0) return -1
            val r = inner.read(b, off, minOf(len.toLong(), remaining).toInt())
            if (r > 0) remaining -= r
            return r
        }
        override fun close() = inner.close()
    }

    private class DigestOutputStream(private val inner: OutputStream, private val digest: MessageDigest) : OutputStream() {
        var count = 0L
            private set
        override fun write(b: Int) {
            inner.write(b)
            digest.update(b.toByte())
            count++
        }
        override fun write(b: ByteArray, off: Int, len: Int) {
            inner.write(b, off, len)
            digest.update(b, off, len)
            count += len
        }
        override fun flush() = inner.flush()
        override fun close() = inner.close()
    }
}
