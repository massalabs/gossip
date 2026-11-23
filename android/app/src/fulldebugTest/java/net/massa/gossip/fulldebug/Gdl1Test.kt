package net.massa.gossip.fulldebug

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.spec.ECGenParameterSpec

/**
 * Gdl1.kt against the shared vectors test/fixtures/gdl1/vectors.json, made
 * by the reference scripts/debug-logs-decrypt.mjs (TEST-ONLY keys).
 * Run: ./gradlew testDebugUnitTest -PfullDebug=true
 */
class Gdl1Test {
    private val vectors: String by lazy {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val f = File(dir, "test/fixtures/gdl1/vectors.json")
            if (f.isFile) return@lazy f.readText()
            dir = dir.parentFile
        }
        throw IllegalStateException("test/fixtures/gdl1/vectors.json not found")
    }

    private fun field(name: String): String =
        Regex("\"$name\":\\s*\"([^\"]*)\"").find(vectors)?.groupValues?.get(1)
            ?: throw IllegalStateException("no $name in vectors.json")

    private class Case(val size: Int, val sha256: String, val ciphertextSize: Int, val hex: String?)

    private fun cases(): List<Case> {
        val body = vectors.substringAfter("\"cases\"")
        return Regex("\\{[^{}]*\\}").findAll(body).map { m ->
            val o = m.value
            fun str(k: String) = Regex("\"$k\":\\s*\"([^\"]*)\"").find(o)?.groupValues?.get(1)
            fun num(k: String) = Regex("\"$k\":\\s*(\\d+)").find(o)!!.groupValues[1].toInt()
            Case(num("size"), str("sha256")!!, num("ciphertextSize"), str("hex"))
        }.toList()
    }

    private fun unhex(s: String) = ByteArray(s.length / 2) { i -> s.substring(2 * i, 2 * i + 2).toInt(16).toByte() }

    private fun sha(b: ByteArray) = Gdl1.hex(MessageDigest.getInstance("SHA-256").digest(b))

    private fun override() = Gdl1.TestOverride(unhex(field("ephemeralD")), unhex(field("ephemeralPoint")), unhex(field("noncePrefix")))

    @Test
    fun recipientPointAndFingerprint() {
        val r = Gdl1.recipient(field("recipientSpkiB64"))
        assertEquals(field("recipientPoint"), Gdl1.hex(r.point))
        assertEquals(field("keyFp"), r.fingerprint)
    }

    @Test
    fun hkdfAsVectors() {
        val salt = unhex(field("ephemeralPoint")) + unhex(field("recipientPoint"))
        val key = Gdl1.hkdf(unhex(field("shared")), salt, "gossip-debug-logs v1".toByteArray(), 32)
        assertEquals(field("key"), Gdl1.hex(key))
    }

    @Test
    fun encryptsAsVectors() {
        val r = Gdl1.recipient(field("recipientSpkiB64"))
        val all = cases()
        assertEquals(6, all.size)
        for (c in all) {
            val ct = Gdl1.encryptForTest(Gdl1.testPlaintext(c.size), r, override())
            assertEquals("size ${c.size}", c.ciphertextSize, ct.size)
            assertEquals("size ${c.size}", c.sha256, sha(ct))
            assertEquals(field("header"), Gdl1.hex(ct.copyOf(Gdl1.HEADER)))
            if (c.hex != null) assertEquals(c.hex, Gdl1.hex(ct))
        }
    }

    @Test
    fun selfTestPasses() {
        assertNull(Gdl1.selfTest())
    }

    @Test
    fun freshKeyEveryFile() {
        val r = Gdl1.recipient(field("recipientSpkiB64"))
        val a = Gdl1.encryptForTest(ByteArray(100), r, null)
        val b = Gdl1.encryptForTest(ByteArray(100), r, null)
        assertNotEquals(Gdl1.hex(a.copyOf(Gdl1.HEADER)), Gdl1.hex(b.copyOf(Gdl1.HEADER)))
        assertArrayEquals("GDL1".toByteArray(), a.copyOf(4))
    }

    @Test
    fun refusesOtherKeys() {
        assertThrows(IllegalArgumentException::class.java) { Gdl1.recipient("bm90IGEga2V5") }
        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec("secp384r1"))
        val p384 = gen.generateKeyPair().public.encoded
        assertThrows(IllegalArgumentException::class.java) { Gdl1.recipient(p384) }
    }
}
