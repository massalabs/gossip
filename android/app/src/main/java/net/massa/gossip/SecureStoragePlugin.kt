package net.massa.gossip

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import org.json.JSONArray
import org.json.JSONObject

import uniffi.secureStorage.initSecureStorage as rustInitSecureStorage
import uniffi.secureStorage.provisionStorageNative
import uniffi.secureStorage.allocateSessionNative
import uniffi.secureStorage.unlockSessionNative
import uniffi.secureStorage.lockSessionNative
import uniffi.secureStorage.isUnlockedNative
import uniffi.secureStorage.coverTrafficTickNative
import uniffi.secureStorage.execSqlNative
import uniffi.secureStorage.flushNative
import uniffi.secureStorage.closeNative
import uniffi.secureStorage.writeNamespaceDataNative
import uniffi.secureStorage.readNamespaceDataNative
import uniffi.secureStorage.namespaceDataLengthNative
import uniffi.secureStorage.clearNamespaceNative
import uniffi.secureStorage.SqlParam
import uniffi.secureStorage.SqlValue
import uniffi.secureStorage.QueryResult
import uniffi.secureStorage.SecureStorageException

@CapacitorPlugin(name = "SecureStorageNative")
class SecureStoragePlugin : Plugin() {

    // PQ (ML-KEM) crypto needs ~4MB stack; default thread pool has ~512KB.
    private val executor = Executors.newSingleThreadExecutor(ThreadFactory { r ->
        Thread(null, r, "secure-storage", 8 * 1024 * 1024)
    })

    /**
     * Run [block] on the secure-storage executor and resolve [call] on
     * success. Any Throwable (including panics that UniFFI relays as
     * RuntimeException) is mapped to `call.reject` — without this catch
     * an uncaught error would kill the single-thread executor and
     * silently break every subsequent plugin call.
     */
    private fun runOnExecutor(call: PluginCall, block: () -> Unit) {
        executor.execute {
            try {
                block()
            } catch (e: SecureStorageException) {
                call.reject(e.message, e)
            } catch (t: Throwable) {
                call.reject(t.message ?: "secure-storage error", t)
            }
        }
    }

    @PluginMethod
    fun initSecureStorage(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("missing path")
        val domain = call.getString("domain") ?: "gossip"
        runOnExecutor(call) {
            val appDir = context.filesDir.resolve(path).absolutePath
            rustInitSecureStorage(appDir, domain)
            call.resolve()
        }
    }

    @PluginMethod
    fun provisionStorage(call: PluginCall) {
        runOnExecutor(call) {
            val fresh = provisionStorageNative()
            val result = JSObject()
            result.put("fresh", fresh)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun allocateSession(call: PluginCall) {
        val slot = call.getInt("slot") ?: return call.reject("missing slot")
        if (slot < 0 || slot > 255) return call.reject("slot out of range")
        val pw = call.getArray("password") ?: return call.reject("missing password")
        val password = jsArrayToByteArray(pw)
        runOnExecutor(call) {
            try {
                allocateSessionNative(slot.toUByte(), password)
                call.resolve()
            } finally {
                password.fill(0)
            }
        }
    }

    @PluginMethod
    fun unlockSession(call: PluginCall) {
        val pw = call.getArray("password") ?: return call.reject("missing password")
        val password = jsArrayToByteArray(pw)
        runOnExecutor(call) {
            try {
                val unlocked = unlockSessionNative(password)
                call.resolve(JSObject().put("unlocked", unlocked))
            } finally {
                password.fill(0)
            }
        }
    }

    @PluginMethod
    fun lockSession(call: PluginCall) {
        runOnExecutor(call) {
            lockSessionNative()
            call.resolve()
        }
    }

    @PluginMethod
    fun isUnlocked(call: PluginCall) {
        runOnExecutor(call) {
            val unlocked = isUnlockedNative()
            call.resolve(JSObject().put("unlocked", unlocked))
        }
    }

    @PluginMethod
    fun coverTrafficTick(call: PluginCall) {
        runOnExecutor(call) {
            coverTrafficTickNative()
            call.resolve()
        }
    }

    @PluginMethod
    fun execSql(call: PluginCall) {
        val sql = call.getString("sql") ?: return call.reject("missing sql")
        val paramsJson = call.getArray("params") ?: JSArray()
        val params = convertSqlParams(paramsJson)
        runOnExecutor(call) {
            val qr = execSqlNative(sql, params)
            val result = JSObject()
            val cols = JSArray()
            for (c in qr.columns) cols.put(c)
            result.put("columns", cols)
            val rows = JSArray()
            for (row in qr.rows) {
                val r = JSArray()
                for (v in row) r.put(sqlValueToJson(v))
                rows.put(r)
            }
            result.put("rows", rows)
            result.put("lastInsertRowId", qr.lastInsertRowid)
            result.put("changes", qr.changes)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun flush(call: PluginCall) {
        runOnExecutor(call) {
            flushNative()
            call.resolve()
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        runOnExecutor(call) {
            closeNative()
            call.resolve()
        }
    }

    // ── Namespace data API (session blob persistence) ───────────────

    @PluginMethod
    fun writeNamespaceData(call: PluginCall) {
        val namespace = call.getInt("namespace") ?: return call.reject("missing namespace")
        if (namespace < 0 || namespace > 255) return call.reject("namespace out of range")
        val offset = call.getLong("offset") ?: return call.reject("missing offset")
        val data = call.getArray("data") ?: return call.reject("missing data")
        val bytes = jsArrayToByteArray(data)
        runOnExecutor(call) {
            writeNamespaceDataNative(namespace.toUByte(), offset.toULong(), bytes)
            call.resolve()
        }
    }

    @PluginMethod
    fun readNamespaceData(call: PluginCall) {
        val namespace = call.getInt("namespace") ?: return call.reject("missing namespace")
        if (namespace < 0 || namespace > 255) return call.reject("namespace out of range")
        val offset = call.getLong("offset") ?: return call.reject("missing offset")
        val len = call.getLong("len") ?: return call.reject("missing len")
        runOnExecutor(call) {
            val out = readNamespaceDataNative(namespace.toUByte(), offset.toULong(), len.toULong())
            val arr = JSArray()
            for (b in out) arr.put(b.toInt() and 0xFF)
            call.resolve(JSObject().put("data", arr))
        }
    }

    @PluginMethod
    fun namespaceDataLength(call: PluginCall) {
        val namespace = call.getInt("namespace") ?: return call.reject("missing namespace")
        if (namespace < 0 || namespace > 255) return call.reject("namespace out of range")
        runOnExecutor(call) {
            val length = namespaceDataLengthNative(namespace.toUByte())
            call.resolve(JSObject().put("length", length.toLong()))
        }
    }

    @PluginMethod
    fun clearNamespace(call: PluginCall) {
        val namespace = call.getInt("namespace") ?: return call.reject("missing namespace")
        if (namespace < 0 || namespace > 255) return call.reject("namespace out of range")
        runOnExecutor(call) {
            clearNamespaceNative(namespace.toUByte())
            call.resolve()
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private fun jsArrayToByteArray(arr: JSArray): ByteArray {
        val bytes = ByteArray(arr.length())
        for (i in 0 until arr.length()) bytes[i] = arr.getInt(i).toByte()
        return bytes
    }

    private fun convertSqlParams(arr: JSArray): List<SqlParam> {
        val params = mutableListOf<SqlParam>()
        for (i in 0 until arr.length()) {
            val v = arr.opt(i)
            params.add(when {
                v == null || v == JSONObject.NULL -> SqlParam.Null
                v is Boolean -> SqlParam.Integer(if (v) 1L else 0L)
                v is Int -> SqlParam.Integer(v.toLong())
                v is Long -> SqlParam.Integer(v)
                v is Double -> SqlParam.Real(v)
                v is Float -> SqlParam.Real(v.toDouble())
                v is String -> SqlParam.Text(v)
                v is JSONArray -> {
                    val b = ByteArray(v.length())
                    for (j in 0 until v.length()) b[j] = v.getInt(j).toByte()
                    SqlParam.Blob(b)
                }
                else -> SqlParam.Text(v.toString())
            })
        }
        return params
    }

    private fun sqlValueToJson(v: SqlValue): Any? = when (v) {
        is SqlValue.Null -> JSONObject.NULL
        is SqlValue.Integer -> v.`value`
        is SqlValue.Real -> v.`value`
        is SqlValue.Text -> v.`value`
        is SqlValue.Blob -> {
            val arr = JSONArray()
            for (b in v.`value`) arr.put(b.toInt() and 0xFF)
            arr
        }
    }
}
