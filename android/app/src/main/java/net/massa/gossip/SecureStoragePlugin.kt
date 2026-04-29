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

    // Two executors: SQL ops vs namespace-blob ops, so a long namespace
    // write can't block a foreground SQL query. Both use 8 MB stack
    // because ML-KEM PQ crypto needs ~4 MB (default JVM stack ~512 KB).
    //
    // Daemon threads so they don't keep the JVM alive on host-activity
    // shutdown. Process death wipes them either way; this is hygiene
    // for hosts that lifecycle Capacitor without process kill.
    private val sqlExecutor = Executors.newSingleThreadExecutor(ThreadFactory { r ->
        Thread(null, r, "secure-storage-sql", 8 * 1024 * 1024).apply { isDaemon = true }
    })
    private val namespaceExecutor = Executors.newSingleThreadExecutor(ThreadFactory { r ->
        Thread(null, r, "secure-storage-namespace", 8 * 1024 * 1024).apply { isDaemon = true }
    })

    /**
     * Single dispatcher. Every call arrives as `{method, args}` where
     * `args` is a JSON string. Rust parses/encodes; we pick the right
     * executor and forward.
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
        // Explicit set of namespace-affined methods. The previous
        // `method.contains("Namespace")` was fragile: a future name like
        // `commitNamespaceTxn` would silently route here too.
        val exec = if (method in NAMESPACE_METHODS) namespaceExecutor else sqlExecutor
        exec.execute {
            try {
                val result = nativeCall(method, args)
                call.resolve(JSObject().put("result", result))

                if (method == "initSecureStorage") {
                    try {
                        val n = nativeCall("rayonThreadCount", "{}")
                        Log.i("SecureStorageNative", "rayon pool: $n threads")
                    } catch (_: Exception) { /* best-effort diag */ }
                }
            } catch (e: SecureStorageException.Error) {
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

    companion object {
        private val NAMESPACE_METHODS = setOf(
            "writeNamespaceData",
            "readNamespaceData",
            "namespaceDataLength",
            "clearNamespace",
        )
    }
}
