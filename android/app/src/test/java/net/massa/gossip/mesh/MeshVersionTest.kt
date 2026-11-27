package net.massa.gossip.mesh

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class MeshVersionTest {

    @Test
    fun versionOneIsTheUuidOfEarlierReleasesByteForByte() {
        val v1 = UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60")
        assertEquals(v1, MeshConstants.serviceUuid(1))
        assertEquals("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60", MeshConstants.serviceUuid(1).toString())
        assertEquals(1, MeshConstants.MESH_VERSION)
        assertEquals(v1, MeshConstants.SERVICE_UUID)
        assertEquals(listOf(v1), MeshConstants.SUPPORTED_SERVICE_UUIDS)
    }

    @Test
    fun onlyTheLastByteCarriesTheVersion() {
        assertEquals("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f61", MeshConstants.serviceUuid(2).toString())
        assertEquals("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5fff", MeshConstants.serviceUuid(MeshConstants.MAX_MESH_VERSION).toString())
    }

    @Test
    fun versionsRoundTrip() {
        for (version in 1..MeshConstants.MAX_MESH_VERSION) {
            assertEquals(version, MeshConstants.meshVersionOf(MeshConstants.serviceUuid(version)))
        }
    }

    @Test
    fun otherUuidsAreNoMeshVersion() {
        assertNull(MeshConstants.meshVersionOf(MeshConstants.CHUNK_CHARACTERISTIC_UUID))
        assertNull(MeshConstants.meshVersionOf(MeshConstants.CCCD_UUID))
        assertNull(MeshConstants.meshVersionOf(UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f5f")))
        assertThrows(IllegalArgumentException::class.java) { MeshConstants.serviceUuid(0) }
        assertThrows(IllegalArgumentException::class.java) { MeshConstants.serviceUuid(MeshConstants.MAX_MESH_VERSION + 1) }
    }

    @Test
    fun anUnsupportedVersionIsNotScanned() {
        assertFalse(MeshConstants.serviceUuid(2) in MeshConstants.SUPPORTED_SERVICE_UUIDS)
    }
}
