package net.massa.gossip.mesh

import java.util.UUID

/**
 * BLE identifiers and link limits of the Gossip mesh. The values come from the
 * node's mesh specification (`wasm/mesh/docs/MESH.md`, "BLE link"); iOS uses
 * the same ones in `MeshConstants.swift`.
 */
object MeshConstants {
    /**
     * Mesh protocol version this build speaks. It is carried in the last byte
     * of the service UUID (see [serviceUuid]), not in an extra advertised
     * byte: iOS can only advertise service UUIDs and a name, and any extra
     * byte would make a Gossip phone easier to tell apart.
     */
    const val MESH_VERSION = 1

    /**
     * Versions this build can link with: it scans for the service UUID of
     * each. A version left out here is never scanned for, so phones speaking
     * only that version are never dialled.
     */
    val SUPPORTED_MESH_VERSIONS: List<Int> = listOf(1)

    /**
     * The service UUID with its last byte cleared. That byte is the mesh
     * version itself; 0 is not a version, so the base UUID names none.
     */
    private val SERVICE_UUID_BASE: UUID = UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f00")

    const val MAX_MESH_VERSION = 0xff

    /**
     * The service UUID of mesh [version]: the base UUID with its last byte set
     * to the version, so version 1 is `…5f01`, version 2 `…5f02`, up to 255
     * (`…5fff`). The UUID 0.1.0 and 0.1.1 advertised (`…5f60`) now reads as
     * version 96, which no build supports: 0.1.2 does not mesh with them, on
     * purpose (no phone stays on those versions). Only the service UUID
     * carries the version; the characteristic UUID is the same for all.
     */
    fun serviceUuid(version: Int): UUID {
        require(version in 1..MAX_MESH_VERSION) { "mesh version out of range" }
        return UUID(SERVICE_UUID_BASE.mostSignificantBits, SERVICE_UUID_BASE.leastSignificantBits or version.toLong())
    }

    /** The mesh version [uuid] names, or null when it is not a mesh service UUID. */
    fun meshVersionOf(uuid: UUID): Int? {
        if (uuid.mostSignificantBits != SERVICE_UUID_BASE.mostSignificantBits ||
            (uuid.leastSignificantBits and 0xffL.inv()) != SERVICE_UUID_BASE.leastSignificantBits
        ) {
            return null
        }
        val version = (uuid.leastSignificantBits and 0xffL).toInt()
        return if (version in 1..MAX_MESH_VERSION) version else null
    }

    /**
     * Advertised, and offered by the GATT server: the UUID of [MESH_VERSION].
     * iOS only discovers in the background by exact UUID, which is why the
     * version changes the UUID rather than adding to it.
     */
    val SERVICE_UUID: UUID = serviceUuid(MESH_VERSION)

    /** Scanned for, and looked up on a peer: one UUID per supported version, the current one first. */
    val SUPPORTED_SERVICE_UUIDS: List<UUID> =
        (listOf(MESH_VERSION) + SUPPORTED_MESH_VERSIONS.filter { it != MESH_VERSION }).map(::serviceUuid)

    /** The one characteristic: centrals write chunks without response, peripherals notify them. */
    val CHUNK_CHARACTERISTIC_UUID: UUID = UUID.fromString("6a8b2f41-5c1d-4e2a-9b7f-3d0c8e1a5f60")

    /** Client Characteristic Configuration descriptor, written by a central to enable notifications. */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    const val REQUESTED_ATT_MTU = 517

    /** ATT MTU every BLE connection starts with, before any exchange. */
    const val DEFAULT_ATT_MTU = 23

    /** A chunk is one write or notification of at most `ATT MTU − 3` bytes. */
    const val ATT_HEADER_BYTES = 3

    /** Mesh links per phone, inbound and outbound together. */
    const val MAX_LINKS = 8

    /** Of [MAX_LINKS], how many other phones may open: the rest are for the neighbours this phone picks. */
    const val MAX_INBOUND_LINKS = 4

    /** How long a central whose inbound link closed must wait before connecting again. */
    const val INBOUND_COOLDOWN_MS = 60_000L

    /** A link the core closes within this time of coming up was refused, not lost. */
    const val QUICK_CLOSE_MS = 30_000L

    /** How long a phone that refused our link is left alone (see [NeighbourSelector]). */
    const val REFUSED_COOLDOWN_MS = 10 * 60_000L

    /** Received bytes waiting for the core on one link; past it the link is closed. */
    const val MAX_PENDING_INBOUND_BYTES_PER_LINK = 512 * 1024

    /** Chunks queued per link before sends to it fail; the core treats a failed send as a dropped message. */
    const val MAX_QUEUED_CHUNKS_PER_LINK = 256

    /** Bytes queued per link, the chunk layer's 512 KiB reassembly bound mirrored on the send side. */
    const val MAX_QUEUED_BYTES_PER_LINK = 512 * 1024
}
