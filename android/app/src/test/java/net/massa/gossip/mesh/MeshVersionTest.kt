package net.massa.gossip.mesh

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class MeshVersionTest {

    @Test
    fun theLastByteIsTheVersion() {
        val v1 = UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f01")
        assertEquals(v1, MeshConstants.serviceUuid(1))
        assertEquals("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f01", MeshConstants.serviceUuid(1).toString())
        assertEquals("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f02", MeshConstants.serviceUuid(2).toString())
        assertEquals("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5fff", MeshConstants.serviceUuid(255).toString())
        assertEquals(1, MeshConstants.MESH_VERSION)
        assertEquals(v1, MeshConstants.SERVICE_UUID)
        assertEquals(listOf(v1), MeshConstants.SUPPORTED_SERVICE_UUIDS)
    }

    @Test
    fun versionsRoundTrip() {
        for (version in 1..255) {
            assertEquals(version, MeshConstants.meshVersionOf(MeshConstants.serviceUuid(version)))
        }
    }

    @Test
    fun zeroAndOtherUuidsAreNoMeshVersion() {
        assertNull(MeshConstants.meshVersionOf(UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f00")))
        assertNull(MeshConstants.meshVersionOf(MeshConstants.CHUNK_CHARACTERISTIC_UUID))
        assertNull(MeshConstants.meshVersionOf(MeshConstants.CCCD_UUID))
        assertThrows(IllegalArgumentException::class.java) { MeshConstants.serviceUuid(0) }
        assertThrows(IllegalArgumentException::class.java) { MeshConstants.serviceUuid(256) }
    }

    @Test
    fun theUuidOfEarlierReleasesIsAnUnsupportedVersion() {
        val old = UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60")
        assertEquals(96, MeshConstants.meshVersionOf(old))
        assertFalse(old in MeshConstants.SUPPORTED_SERVICE_UUIDS)
        assertFalse(old == MeshConstants.SERVICE_UUID)
    }

    @Test
    fun anUnsupportedVersionIsNotScanned() {
        assertFalse(MeshConstants.serviceUuid(2) in MeshConstants.SUPPORTED_SERVICE_UUIDS)
    }
}
