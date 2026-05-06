package net.massa.gossip

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import org.json.JSONObject
import uniffi.secureStorage.nativeCall
import uniffi.secureStorage.SecureStorageException

@CapacitorPlugin(name = "SecureStorageNative")
class SecureStoragePlugin : Plugin() {

    // One 8 MB-stack FIFO executor for every secure-storage call.
    // ML-KEM PQ crypto needs ~4 MB (default JVM stack ~512 KB), and
    // the native VFS owns one global unlocked session + SQLite handle
    // set, so namespace calls must not overtake lifecycle calls such
    // as unlockSession, lockSession, flush, or close.
    //
    // Daemon thread so it doesn't keep the JVM alive on host-activity
    // shutdown. Process death wipes them either way; this is hygiene
    // for hosts that lifecycle Capacitor without process kill.
    private val executor = Executors.newSingleThreadExecutor(ThreadFactory { r ->
        Thread(null, r, "secure-storage", 8 * 1024 * 1024).apply { isDaemon = true }
    })

    /**
     * Single dispatcher. Every call arrives as `{method, args}` where
     * `args` is a JSON string. Rust parses/encodes; we forward on the
     * secure-storage FIFO worker.
     *
     * `initSecureStorage` is special-cased: the relative `path` from JS
     * is resolved against the app's sandboxed files dir before handing
     * the absolute path to Rust.
     */
    @PluginMethod
    fun call(call: PluginCall) {
        val method = call.getString("method") ?: return call.reject("missing method", "MISSING_METHOD")
        val argsRaw = call.getString("args") ?: "{}"
        val args = if (method == "initSecureStorage") resolveInitPath(argsRaw) else argsRaw
        executor.execute {
            try {
                val result = nativeCall(method, args)
                call.resolve(JSObject().put("result", result))

                if (method == "initSecureStorage") {
                    try {
                        val n = nativeCall("rayonThreadCount", "{}")
                        Log.i("SecureStorageNative", "rayon pool: $n threads")
                    } catch (_: Exception) { /* best-effort diag */ }
                }
            } catch (e: SecureStorageException.Exception) {
                // Pass code + Throwable explicitly. The previous
                // `reject(e.message, e)` resolved to the (message, code: String)
                // overload, dropping the throwable on the floor and stuffing
                // a stringified Exception into the code slot.
                call.reject(e.msg, e.code, e)
            } catch (e: Exception) {
                call.reject(e.message ?: "secure-storage error", "INTERNAL", e)
            }
        }
    }

    /** Rewrite the JSON's `path` field from relative to absolute. */
    private fun resolveInitPath(argsRaw: String): String {
        val json = JSONObject(argsRaw)
        val rel = json.optString("path", "secure-storage")
        val abs = context.filesDir.resolve(rel).absolutePath
        return json.put("path", abs).toString()
    }
}
