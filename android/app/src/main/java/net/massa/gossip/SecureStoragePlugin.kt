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

    @PluginMethod
    fun initSecureStorage(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("missing path")
        val domain = call.getString("domain") ?: "gossip"
        executor.execute {
            try {
                val appDir = context.filesDir.resolve(path).absolutePath
                rustInitSecureStorage(appDir, domain)
                call.resolve()
            } catch (e: SecureStorageException) {
                call.reject(e.message, e)
            }
        }
    }

    @PluginMethod
    fun provisionStorage(call: PluginCall) {
        executor.execute {
            try {
                val fresh = provisionStorageNative()
                val result = JSObject()
                result.put("fresh", fresh)
                call.resolve(result)
            } catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun allocateSession(call: PluginCall) {
        val slot = call.getInt("slot") ?: return call.reject("missing slot")
        val pw = call.getArray("password") ?: return call.reject("missing password")
        val password = jsArrayToByteArray(pw)
        executor.execute {
            try { allocateSessionNative(slot.toUByte(), password); call.resolve() }
            catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun unlockSession(call: PluginCall) {
        val pw = call.getArray("password") ?: return call.reject("missing password")
        val password = jsArrayToByteArray(pw)
        executor.execute {
            try {
                val unlocked = unlockSessionNative(password)
                call.resolve(JSObject().put("unlocked", unlocked))
            } catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun lockSession(call: PluginCall) {
        executor.execute {
            try { lockSessionNative(); call.resolve() }
            catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun isUnlocked(call: PluginCall) {
        executor.execute {
            try {
                val unlocked = isUnlockedNative()
                call.resolve(JSObject().put("unlocked", unlocked))
            } catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun coverTrafficTick(call: PluginCall) {
        executor.execute {
            try { coverTrafficTickNative(); call.resolve() }
            catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun execSql(call: PluginCall) {
        val sql = call.getString("sql") ?: return call.reject("missing sql")
        val paramsJson = call.getArray("params") ?: JSArray()
        val params = convertSqlParams(paramsJson)
        executor.execute {
            try {
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
            } catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun flush(call: PluginCall) {
        executor.execute {
            try { flushNative(); call.resolve() }
            catch (e: SecureStorageException) { call.reject(e.message, e) }
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        executor.execute {
            try { closeNative(); call.resolve() }
            catch (e: SecureStorageException) { call.reject(e.message, e) }
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
