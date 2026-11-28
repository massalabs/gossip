package net.massa.gossip.mesh

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * The key the mesh node encrypts its pools with (`pool_key_hex`): 32 random
 * bytes per installation, wrapped by a non-exportable AES-GCM key of the
 * Android Keystore and kept in no-backup preferences (`GossipMeshPrefs` is
 * excluded from backups and device transfer). [replace] draws a new one, so
 * a wipe leaves nothing wrapped under the old key.
 *
 * The configuration the service remembers for restarts never holds the key:
 * [withPoolKey] adds it each time the core starts.
 */
object MeshPoolKey {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "gossip_mesh_pool_key_wrap"
    private const val PREFS_NAME = "GossipMeshPrefs"
    private const val KEY_WRAPPED = "pool_key_wrapped"
    private const val GCM_TAG_BITS = 128
    private const val KEY_BYTES = 32

    /**
     * [configJson] with this installation's pool key, created on first use.
     * [onNewKey] runs before a key is created: pools left under a lost key no
     * longer open, so the caller deletes them.
     */
    @Synchronized
    fun withPoolKey(context: Context, configJson: String, onNewKey: () -> Unit = {}): String {
        val config = if (configJson.isBlank()) JSONObject() else JSONObject(configJson)
        val key = load(context) ?: run {
            onNewKey()
            create(context)
        }
        config.put("pool_key_hex", hex(key))
        return config.toString()
    }

    /** Draws a new pool key (the old one and its wrapping key are deleted) and returns [configJson] with it. */
    @Synchronized
    fun replace(context: Context, configJson: String): String {
        prefs(context).edit(commit = true) { remove(KEY_WRAPPED) }
        keyStore().deleteEntry(ALIAS)
        return withPoolKey(context, configJson)
    }

    private fun load(context: Context): ByteArray? {
        val stored = prefs(context).getString(KEY_WRAPPED, null) ?: return null
        val key = keyStore().getKey(ALIAS, null) as? SecretKey ?: return null
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val ivLen = bytes[0].toInt()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, bytes, 1, ivLen))
            cipher.doFinal(bytes, 1 + ivLen, bytes.size - 1 - ivLen)
        }.getOrNull()?.takeIf { it.size == KEY_BYTES }
    }

    /**
     * A new pool key. A key that no longer unwraps (the Keystore entry was lost)
     * is replaced too: the node then refuses the old pools, which the app wipes.
     */
    private fun create(context: Context): ByteArray {
        val keyStore = keyStore()
        keyStore.deleteEntry(ALIAS)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        val wrapKey = generator.generateKey()
        val poolKey = ByteArray(KEY_BYTES).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey)
        val iv = cipher.iv
        val sealed = cipher.doFinal(poolKey)
        val stored = byteArrayOf(iv.size.toByte()) + iv + sealed
        prefs(context).edit(commit = true) { putString(KEY_WRAPPED, Base64.encodeToString(stored, Base64.NO_WRAP)) }
        return poolKey
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
