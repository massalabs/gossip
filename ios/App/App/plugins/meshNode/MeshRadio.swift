import CoreBluetooth
import Foundation

/// BLE identifiers and link limits of the Gossip mesh, from the node's mesh
/// specification (gossip-node `docs/MESH.md`, "BLE link"). Android uses the
/// same values in `MeshConstants.kt`.
enum MeshConstants {
    /// Advertised and scanned for. Fixed: in the background iOS only finds peers by exact UUID.
    static let serviceUUID = CBUUID(string: "6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60")
    /// The one characteristic: centrals write chunks without response, peripherals notify them.
    static let chunkCharacteristicUUID = CBUUID(string: "6a8b2f41-5c1d-4e2a-9b7f-3d0c8e1a5f60")
    /// A chunk is one write or notification of at most `ATT MTU − 3` bytes.
    static let attHeaderBytes = 3
    /// Mesh links per phone, both roles together.
    static let maxLinks = 8
    static let maxQueuedChunksPerLink = 256
    static let maxQueuedBytesPerLink = 512 * 1024
    static let centralRestoreIdentifier = "net.massa.gossip.mesh.central"
    static let peripheralRestoreIdentifier = "net.massa.gossip.mesh.peripheral"
}

/// How much battery the radio may spend: scanning is on for `scanOn`, off
/// for `scanOff`, and every `rotationInterval` one link makes room for a new
/// random neighbour. iOS throttles background scanning on its own whatever
/// these values say.
enum MeshPowerMode: String {
    case performance
    case balanced
    case powerSaver = "power_saver"

    var scanOn: TimeInterval {
        switch self {
        case .performance: return 10
        case .balanced: return 5
        case .powerSaver: return 3
        }
    }

    var scanOff: TimeInterval {
        switch self {
        case .performance: return 2
        case .balanced: return 10
        case .powerSaver: return 30
        }
    }

    var rotationInterval: TimeInterval {
        switch self {
        case .performance: return 60
        case .balanced: return 120
        case .powerSaver: return 300
        }
    }

    init(name: String?) {
        self = MeshPowerMode(rawValue: name?.lowercased() ?? "") ?? .balanced
    }
}

/// The radio layer of the mesh: it finds neighbours and moves chunks, nothing
/// more. Chunking, handshakes, trust and replication live in the core
/// (`MeshCore`). A link id names one connection for its lifetime and is never
/// reused.
protocol MeshRadio: AnyObject {
    func start(mode: MeshPowerMode, listener: MeshRadioListener)
    func stop()
    func setPowerMode(_ mode: MeshPowerMode)
    /// Queues one chunk of at most `mtu − 3` bytes. False when the link is
    /// gone, the chunk is too large or the link's queue is full.
    func sendFrame(linkId: Int, frame: Data) -> Bool
    func closeLink(linkId: Int)
    func linkCount() -> Int
}

/// Called on the radio's queue; implementations hand work off quickly.
protocol MeshRadioListener: AnyObject {
    /// The link works both ways; `mtu` is the ATT MTU (largest chunk + 3).
    func onLinkUp(linkId: Int, mtu: Int)
    func onLinkDown(linkId: Int)
    func onFrameIn(linkId: Int, frame: Data)
}

/// Chooses which seen phones to connect to: at random among candidates above
/// a signal floor, never only by signal strength, which would make clusters
/// of nearby phones that only hear each other. Pure logic, used on the
/// radio's queue. Mirrors `NeighbourSelector.kt`.
final class NeighbourSelector {
    private struct Candidate {
        var rssi: Int
        var lastSeen: TimeInterval
    }

    private let maxLinks: Int
    private let minRssi: Int
    private let candidateTtl: TimeInterval
    private let cooldown: TimeInterval
    private var candidates: [String: Candidate] = [:]
    private var cooldownUntil: [String: TimeInterval] = [:]

    init(
        maxLinks: Int = MeshConstants.maxLinks,
        minRssi: Int = -95,
        candidateTtl: TimeInterval = 30,
        cooldown: TimeInterval = 60
    ) {
        self.maxLinks = maxLinks
        self.minRssi = minRssi
        self.candidateTtl = candidateTtl
        self.cooldown = cooldown
    }

    func onSeen(_ id: String, rssi: Int, now: TimeInterval) {
        candidates[id] = Candidate(rssi: rssi, lastSeen: now)
    }

    func onDisconnected(_ id: String, now: TimeInterval) {
        cooldownUntil[id] = now + cooldown
    }

    func forget(_ id: String) {
        candidates.removeValue(forKey: id)
    }

    /// Ids to connect to now, enough to fill the free slots. `busy` are ids
    /// already linked or connecting.
    func pickConnections(busy: Set<String>, now: TimeInterval) -> [String] {
        prune(now)
        let free = maxLinks - busy.count
        guard free > 0 else { return [] }
        return Array(eligible(busy: busy, now: now).shuffled().prefix(free))
    }

    /// A link to drop for a new neighbour: only when every slot is taken, an
    /// eligible candidate waits, and the link is at least `minAge` old.
    func pickRotationVictim(links: [String: TimeInterval], now: TimeInterval, minAge: TimeInterval) -> String? {
        prune(now)
        guard links.count >= maxLinks, !eligible(busy: Set(links.keys), now: now).isEmpty else { return nil }
        return links.filter { now - $0.value >= minAge }.keys.randomElement()
    }

    func isCandidate(_ id: String) -> Bool { candidates[id] != nil }

    private func eligible(busy: Set<String>, now: TimeInterval) -> [String] {
        candidates.compactMap { id, candidate in
            guard !busy.contains(id), candidate.rssi >= minRssi, (cooldownUntil[id] ?? 0) <= now else { return nil }
            return id
        }
    }

    private func prune(_ now: TimeInterval) {
        candidates = candidates.filter { now - $0.value.lastSeen <= candidateTtl }
        cooldownUntil = cooldownUntil.filter { $0.value > now }
    }
}

/// Outgoing chunks of one link, bounded by count and bytes. CoreBluetooth
/// says when it cannot take more (`updateValue` false, or
/// `canSendWriteWithoutResponse` false); the chunk then stays at the head
/// until the ready callback. Offers come from the core's queue.
final class FrameQueue {
    private let lock = NSLock()
    private var chunks: [Data] = []
    private var bytes = 0

    func offer(_ chunk: Data) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard chunks.count < MeshConstants.maxQueuedChunksPerLink,
              bytes + chunk.count <= MeshConstants.maxQueuedBytesPerLink else { return false }
        chunks.append(chunk)
        bytes += chunk.count
        return true
    }

    func peek() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return chunks.first
    }

    func removeFirst() {
        lock.lock()
        defer { lock.unlock() }
        guard !chunks.isEmpty else { return }
        bytes -= chunks.removeFirst().count
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        chunks.removeAll()
        bytes = 0
    }
}
