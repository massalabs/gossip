package net.massa.gossip.mesh

import java.util.UUID

/**
 * BLE identifiers and link limits of the Gossip mesh. The values come from the
 * node's mesh specification (gossip-node `docs/MESH.md`, "BLE link"); iOS uses
 * the same ones in `MeshConstants.swift`.
 */
object MeshConstants {
    /** Advertised and scanned for. Fixed: iOS only discovers in the background by exact UUID. */
    val SERVICE_UUID: UUID = UUID.fromString("6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60")

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

    /** Received bytes waiting for the core on one link; past it the link is closed. */
    const val MAX_PENDING_INBOUND_BYTES_PER_LINK = 512 * 1024

    /** Chunks queued per link before sends to it fail; the core treats a failed send as a dropped message. */
    const val MAX_QUEUED_CHUNKS_PER_LINK = 256

    /** Bytes queued per link, the chunk layer's 512 KiB reassembly bound mirrored on the send side. */
    const val MAX_QUEUED_BYTES_PER_LINK = 512 * 1024
}
