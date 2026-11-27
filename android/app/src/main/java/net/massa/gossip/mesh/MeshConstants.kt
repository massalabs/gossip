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

    /** Version 1's UUID, the one 0.1.0 and 0.1.1 advertise: it must never change. */
    private val VERSION_1_SERVICE_UUID: UUID = UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60")

    /** Last byte of [VERSION_1_SERVICE_UUID]; version v ends in `0x5f + v`. */
    private const val VERSION_BYTE_OFFSET = 0x5f

    const val MAX_MESH_VERSION = 0xff - VERSION_BYTE_OFFSET

    /**
     * The service UUID of mesh [version]: version 1's UUID with its last byte
     * set to `0x5f + version`, so version 1 is `…5f60` (today's UUID, byte for
     * byte), version 2 `…5f61`, up to version [MAX_MESH_VERSION] (`…5fff`).
     * The simplest rule that keeps version 1 exact. Only the service UUID
     * carries the version; the characteristic UUID is the same for all.
     */
    fun serviceUuid(version: Int): UUID {
        require(version in 1..MAX_MESH_VERSION) { "mesh version out of range" }
        val lsb = (VERSION_1_SERVICE_UUID.leastSignificantBits and 0xffL.inv()) or
            (VERSION_BYTE_OFFSET + version).toLong()
        return UUID(VERSION_1_SERVICE_UUID.mostSignificantBits, lsb)
    }

    /** The mesh version [uuid] names, or null when it is not a mesh service UUID. */
    fun meshVersionOf(uuid: UUID): Int? {
        if (uuid.mostSignificantBits != VERSION_1_SERVICE_UUID.mostSignificantBits ||
            (uuid.leastSignificantBits and 0xffL.inv()) != (VERSION_1_SERVICE_UUID.leastSignificantBits and 0xffL.inv())
        ) {
            return null
        }
        val version = (uuid.leastSignificantBits and 0xffL).toInt() - VERSION_BYTE_OFFSET
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
