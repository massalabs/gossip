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

    // Two executors: SQL ops vs namespace-blob ops, so a long SQL
    // query can't block a session-blob persist. Both use 8 MB stack
    // because ML-KEM PQ crypto needs ~4 MB (default JVM stack ~512 KB).
    private val sqlExecutor = Executors.newSingleThreadExecutor(ThreadFactory { r ->
        Thread(null, r, "secure-storage-sql", 8 * 1024 * 1024)
    })
    private val namespaceExecutor = Executors.newSingleThreadExecutor(ThreadFactory { r ->
        Thread(null, r, "secure-storage-namespace", 8 * 1024 * 1024)
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
        val method = call.getString("method") ?: return call.reject("missing method")
        val argsRaw = call.getString("args") ?: "{}"
        val args = if (method == "initSecureStorage") resolveInitPath(argsRaw) else argsRaw
        val exec = if (method.contains("Namespace")) namespaceExecutor else sqlExecutor
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
            } catch (e: SecureStorageException) {
                call.reject(e.message, e)
            } catch (e: Exception) {
                call.reject(e.message ?: "secure-storage error", e)
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
