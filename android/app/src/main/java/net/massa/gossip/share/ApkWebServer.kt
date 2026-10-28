package net.massa.gossip.share

import android.util.Log
import java.io.BufferedOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * A minimal HTTP/1.0 server for the hotspot: a landing page at `/` and the APK
 * at `/Gossip.apk`. It only listens on the hotspot's address, serves nothing
 * else and closes each connection after one answer.
 */
class ApkWebServer(
    private val apk: File,
    private val landingPage: String,
    private val onDownload: (state: String) -> Unit,
) {
    private var server: ServerSocket? = null
    private val workers = Executors.newFixedThreadPool(MAX_CLIENTS)
    private val active = AtomicInteger()

    /** Listens on [address] and returns the port. */
    fun start(address: InetAddress): Int {
        val socket = try {
            ServerSocket(PORT, BACKLOG, address)
        } catch (e: IOException) {
            // another app holds the port: take any free one
            ServerSocket(0, BACKLOG, address)
        }
        server = socket
        Thread({ acceptLoop(socket) }, "gossip-apk-server").apply {
            isDaemon = true
            start()
        }
        return socket.localPort
    }

    fun stop() {
        try {
            server?.close()
        } catch (_: IOException) {
        }
        server = null
        workers.shutdownNow()
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: SocketException) {
                return
            } catch (e: IOException) {
                Log.w(TAG, "accept failed", e)
                continue
            }
            if (active.incrementAndGet() > MAX_CLIENTS) {
                active.decrementAndGet()
                client.close()
                continue
            }
            try {
                workers.execute {
                    try {
                        handle(client)
                    } finally {
                        active.decrementAndGet()
                    }
                }
            } catch (_: java.util.concurrent.RejectedExecutionException) {
                active.decrementAndGet()
                client.close()
            }
        }
    }

    private fun handle(client: Socket) {
        client.use {
            try {
                client.soTimeout = READ_TIMEOUT_MS
                val request = readRequestLine(client.getInputStream()) ?: return
                val parts = request.split(' ')
                val method = parts.getOrNull(0) ?: return
                val path = parts.getOrNull(1)?.substringBefore('?') ?: return
                val out = BufferedOutputStream(client.getOutputStream(), BUFFER_SIZE)
                val head = method == "HEAD"
                when {
                    method != "GET" && !head -> respond(out, "405 Method Not Allowed", "text/plain", "")
                    path == "/" || path == "/index.html" ->
                        respond(out, "200 OK", "text/html; charset=utf-8", if (head) null else landingPage)
                    path == "/${ShareableApk.FILE_NAME}" -> sendApk(out, head)
                    else -> respond(out, "404 Not Found", "text/plain", "Not found")
                }
                out.flush()
            } catch (e: IOException) {
                Log.d(TAG, "client dropped: ${e.message}")
            }
        }
    }

    private fun sendApk(out: OutputStream, head: Boolean) {
        val length = apk.length()
        writeHead(
            out,
            "200 OK",
            "application/vnd.android.package-archive",
            length,
            "Content-Disposition: attachment; filename=\"${ShareableApk.FILE_NAME}\"\r\n",
        )
        if (head) return
        onDownload("started")
        try {
            apk.inputStream().use { it.copyTo(out, BUFFER_SIZE) }
            out.flush()
            onDownload("completed")
        } catch (e: IOException) {
            onDownload("failed")
            throw e
        }
    }

    private fun respond(out: OutputStream, status: String, type: String, body: String?) {
        val bytes = (body ?: landingPage).toByteArray(Charsets.UTF_8)
        writeHead(out, status, type, bytes.size.toLong(), "")
        if (body != null) out.write(bytes)
    }

    private fun writeHead(out: OutputStream, status: String, type: String, length: Long, extra: String) {
        val head = "HTTP/1.0 $status\r\n" +
            "Content-Type: $type\r\n" +
            "Content-Length: $length\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n" +
            extra +
            "\r\n"
        out.write(head.toByteArray(Charsets.US_ASCII))
    }

    /** The request line; the headers after it are read and ignored. */
    private fun readRequestLine(input: InputStream): String? {
        val header = StringBuilder()
        var total = 0
        while (true) {
            val byte = input.read()
            if (byte < 0) return null
            if (++total > MAX_HEADER_BYTES) return null
            header.append(byte.toChar())
            if (header.endsWith("\r\n\r\n") || header.endsWith("\n\n")) break
        }
        return header.lineSequence().firstOrNull()?.trim()
    }

    companion object {
        private const val TAG = "ApkWebServer"
        const val PORT = 9999
        private const val BACKLOG = 8
        private const val MAX_CLIENTS = 6
        private const val READ_TIMEOUT_MS = 15_000
        private const val MAX_HEADER_BYTES = 16 * 1024
        private const val BUFFER_SIZE = 64 * 1024
    }
}
