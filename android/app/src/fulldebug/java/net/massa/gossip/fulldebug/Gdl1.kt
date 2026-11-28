package net.massa.gossip.fulldebug

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * GDL1: the encryption of what the full debug build sends, to the
 * developers' public key, so that the backend stores only ciphertext. Same
 * format as src/fullDebug/gdl1.ts and DebugLogFilePlugin.swift; the reference
 * and the decryption are scripts/debug-logs-decrypt.mjs, the shared vectors
 * test/fixtures/gdl1/vectors.json (checked by Gdl1Test on the JVM and by
 * [selfTest] at every start of the app).
 *
 *   header  "GDL1" | ephemeral P-256 public key, uncompressed (65) | nonce prefix (4)
 *   key     HKDF-SHA256(ikm = ECDH x coordinate,
 *                       salt = ephemeral public (65) | recipient public (65),
 *                       info = "gossip-debug-logs v1", 32 bytes)
 *   chunks  65536-byte plaintext chunks (the last may be shorter, empty only
 *           when the whole plaintext is), each u32 BE length | AES-256-GCM
 *           ciphertext | 16-byte tag, nonce = prefix | u64 BE index,
 *           AAD = 0x01 for the last chunk, 0x00 otherwise.
 *
 * Plain JVM (java.security, javax.crypto; API 23+), no Android class, so that
 * it runs in a JVM unit test.
 */
object Gdl1 {
    const val ENC = "GDL1"
    const val CHUNK = 65536
    const val HEADER = 4 + 65 + 4
    private val MAGIC = "GDL1".toByteArray(Charsets.US_ASCII)
    private val INFO = "gossip-debug-logs v1".toByteArray(Charsets.US_ASCII)

    private val p256: ECParameterSpec by lazy {
        val p = AlgorithmParameters.getInstance("EC")
        p.init(ECGenParameterSpec("secp256r1"))
        p.getParameterSpec(ECParameterSpec::class.java)
    }

    /** The developers' public key (base64 DER from the JS side). */
    class Recipient(val der: ByteArray, val key: ECPublicKey) {
        val point: ByteArray = uncompressed(key)
        val fingerprint: String = hex(MessageDigest.getInstance("SHA-256").digest(der))
    }

    /** For the test vectors only: a given ephemeral key and nonce prefix. */
    class TestOverride(val d: ByteArray, val point: ByteArray, val noncePrefix: ByteArray)

    fun recipient(der: ByteArray): Recipient {
        val key = try {
            KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der)) as ECPublicKey
        } catch (t: Throwable) {
            throw IllegalArgumentException("the key to encrypt the logs is not an EC public key")
        }
        val p = key.params
        val q = p256
        if (p.order != q.order || p.curve.field.fieldSize != 256 || p.curve.a != q.curve.a ||
            p.curve.b != q.curve.b || p.generator != q.generator
        ) {
            throw IllegalArgumentException("the key to encrypt the logs is not a P-256 key")
        }
        return Recipient(der, key)
    }

    fun recipient(base64: String): Recipient {
        val der = try {
            Base64.getDecoder().decode(base64.filterNot { it.isWhitespace() })
        } catch (t: Throwable) {
            throw IllegalArgumentException("the key to encrypt the logs is not base64")
        }
        return recipient(der)
    }

    private fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        val out = ByteArray(32)
        if (b.size >= 32) System.arraycopy(b, b.size - 32, out, 0, 32)
        else System.arraycopy(b, 0, out, 32 - b.size, b.size)
        return out
    }

    /** 0x04 | X | Y */
    fun uncompressed(key: ECPublicKey): ByteArray =
        byteArrayOf(4) + fixed32(key.w.affineX) + fixed32(key.w.affineY)

    /** HKDF-SHA256 (RFC 5869), output up to 32 bytes (one block). */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..32)
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        expand.update(info)
        expand.update(1.toByte())
        val okm = expand.doFinal()
        prk.fill(0)
        return okm.copyOf(length)
    }

    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun unhex(s: String): ByteArray =
        ByteArray(s.length / 2) { i -> s.substring(2 * i, 2 * i + 2).toInt(16).toByte() }

    /**
     * Encrypts what is written to it into [out], chunk by chunk, holding at
     * most one chunk; [close] writes the last chunk and closes [out]. A fresh
     * ephemeral key and nonce prefix per instance (unless [test]); the
     * ephemeral private key stays inside the constructor.
     */
    class Writer(private val out: OutputStream, recipient: Recipient, test: TestOverride? = null) : OutputStream() {
        private val key: SecretKeySpec
        private val prefix: ByteArray
        private val buf = ByteArray(CHUNK)
        private var pos = 0
        private var index = 0L
        private var closed = false
        private val cipher = Cipher.getInstance("AES/GCM/NoPadding")

        init {
            val priv: PrivateKey
            val point: ByteArray
            if (test != null) {
                priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, test.d), p256))
                point = test.point.copyOf()
                prefix = test.noncePrefix.copyOf()
            } else {
                val gen = KeyPairGenerator.getInstance("EC")
                gen.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
                val pair = gen.generateKeyPair()
                priv = pair.private
                point = uncompressed(pair.public as ECPublicKey)
                prefix = ByteArray(4).also { SecureRandom().nextBytes(it) }
            }
            val ka = KeyAgreement.getInstance("ECDH")
            ka.init(priv)
            ka.doPhase(recipient.key, true)
            val shared = ka.generateSecret()
            val k = hkdf(shared, point + recipient.point, INFO, 32)
            shared.fill(0)
            key = SecretKeySpec(k, "AES")
            k.fill(0)
            out.write(MAGIC)
            out.write(point)
            out.write(prefix)
        }

        override fun write(b: Int) {
            if (pos == CHUNK) emit(false)
            buf[pos++] = b.toByte()
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            var o = off
            var n = len
            while (n > 0) {
                // A full chunk is written only once more data follows, so that
                // the last chunk is known when it is sealed.
                if (pos == CHUNK) emit(false)
                val k = minOf(n, CHUNK - pos)
                System.arraycopy(b, o, buf, pos, k)
                pos += k
                o += k
                n -= k
            }
        }

        override fun flush() = out.flush()

        override fun close() {
            if (closed) return
            closed = true
            try {
                emit(true)
            } finally {
                buf.fill(0)
                out.close()
            }
        }

        private fun emit(last: Boolean) {
            val nonce = ByteArray(12)
            System.arraycopy(prefix, 0, nonce, 0, 4)
            for (i in 0 until 8) nonce[4 + i] = (index ushr (56 - 8 * i)).toByte()
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
            cipher.updateAAD(byteArrayOf(if (last) 1 else 0))
            val sealed = cipher.doFinal(buf, 0, pos)
            val len = sealed.size
            out.write(byteArrayOf((len ushr 24).toByte(), (len ushr 16).toByte(), (len ushr 8).toByte(), len.toByte()))
            out.write(sealed)
            index++
            pos = 0
        }
    }

    // ── self-check against test/fixtures/gdl1/vectors.json (TEST-ONLY key) ──

    private const val TEST_RECIPIENT =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzO6DCrZshIuSJZtrPLwMo1GyT4I9wjeNwu+xFkT5hCewuDGpHS55r+csLbBYg3X17Xt21umN8KcICmU4rOxWvg=="
    private const val TEST_D = "16557eb229e3416543632cf48b0f8154bd2d2961029baf2f8aa192dad549cea9"
    private const val TEST_POINT =
        "044fb11200caf95d55f6975c1de397b9a5468ad241f88cb545f267a3052137a64d5ce6091933fd5f5ae4eac875630e08fbde6a20258bbbb7dc27ab7dfdfb3fb2e2"
    private const val TEST_PREFIX = "9b5b8a83"
    private val TEST_CASES = listOf(
        0 to "4e3afe052db0925cb166d400202cb1d1bab1ddbcc7c1a447b04975ee4a261e5d",
        1 to "019795c84717f755076afb7e5741fe7ca2e1d8d555194e48664239fdea79583f",
        65535 to "2f102ca9594569c5eee6f36759188c5b05141ec5d544e668bfa155b348ac768e",
        65536 to "b980390e9f67817e48974bf6a889ecdb3036d46bb34e2aaeebcf0f78ad34a51e",
        65537 to "fb1c071c6eab54d5af2a22300206093345ba346af43c97196268f3129b81c036",
        200000 to "96dfc2cef7acc90a95570c266cc5c73d05b428943e602802eda307d0a59dbe11",
    )

    /** Byte i of a test plaintext: (i * 31 + 7) & 0xff. */
    fun testPlaintext(size: Int): ByteArray = ByteArray(size) { i -> ((i * 31 + 7) and 0xff).toByte() }

    fun testOverride(): TestOverride = TestOverride(unhex(TEST_D), unhex(TEST_POINT), unhex(TEST_PREFIX))

    fun testRecipient(): Recipient = recipient(TEST_RECIPIENT)

    /** GDL1 of `plain` with the test key, written in blocks of growing size. */
    fun encryptForTest(plain: ByteArray, recipient: Recipient, test: TestOverride?): ByteArray {
        val bos = ByteArrayOutputStream()
        Writer(bos, recipient, test).use { w ->
            var i = 0
            var step = 1
            while (i < plain.size) {
                val k = minOf(step, plain.size - i)
                if (k == 1) w.write(plain[i].toInt()) else w.write(plain, i, k)
                i += k
                step = step * 3 + 5
            }
        }
        return bos.toByteArray()
    }

    /**
     * Runs the shared vectors on this device. Returns null when every one
     * matches, else what differs. Also makes one file with a fresh ephemeral
     * key (the path a real send takes) and checks its shape.
     */
    fun selfTest(): String? {
        val r = testRecipient()
        val sha = MessageDigest.getInstance("SHA-256")
        for ((size, expected) in TEST_CASES) {
            val got = hex(sha.digest(encryptForTest(testPlaintext(size), r, testOverride())))
            if (got != expected) return "vector $size: $got"
        }
        val fresh = encryptForTest(testPlaintext(10), r, null)
        if (fresh.size != HEADER + 4 + 10 + 16 || !fresh.copyOf(4).contentEquals(MAGIC) || fresh[4] != 4.toByte()) {
            return "fresh key: bad shape (${fresh.size} bytes)"
        }
        return null
    }
}
