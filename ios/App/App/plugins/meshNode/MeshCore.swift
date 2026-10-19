import CryptoKit
import Foundation

/// The mesh node core: pools, link handshakes, BLE chunking, replication, the
/// wanted list and the internet upstream. It will be the Rust `gossip-mobile`
/// crate (gossip-node repository) through UniFFI; until then `StubMeshCore`
/// stands in. Calls may block and are made from the bridge's queues, never
/// from the main thread. Mirrors `MeshCore.kt`.
protocol MeshCore: AnyObject {
    /// Opens the node's storage in `dataDir` and starts it. `configJson` is
    /// the object passed to `MeshNode.start({ config })`, opaque here.
    func start(dataDir: String, configJson: String, sink: MeshCoreSink) throws
    func stop()

    // Radio events; chunks follow gossip-node docs/MESH.md, the core does the chunking.
    func linkUp(linkId: Int, mtu: Int)
    func linkDown(linkId: Int)
    func frameIn(linkId: Int, frame: Data)

    // The MeshNode plugin API.
    func sendBlob(kind: MeshBlobKind, key: Data?, payload: Data) throws -> MeshSendResult
    func fetch(seekers: [Data]) throws -> [MeshKeyValue]
    func fetchBulletin(cursor: String?, limit: Int) throws -> [MeshBulletinItem]
    func getKeys(hash: Data) throws -> Data?
    func setWanted(seekers: [Data]) throws
    func setUpstream(urls: [String], bridgeEnabled: Bool) throws
    func status() -> MeshCoreStatus
    /// Deletes everything the node stored, its own blobs and relayed ones.
    func wipe() throws
}

/// What the core asks of its host; may be called from any of the core's threads.
protocol MeshCoreSink: AnyObject {
    func sendFrame(linkId: Int, frame: Data) -> Bool
    /// A duplicate peer id, a failed handshake, a protocol violation.
    func closeLink(linkId: Int)
    /// Blobs for seekers on the wanted list, and announcements, just stored.
    func arrival(messages: [MeshKeyValue], announcements: [Data])
}

enum MeshBlobKind: String {
    case message
    case announcement
    case keys
}

struct MeshKeyValue {
    let key: Data
    let value: Data
}

struct MeshBulletinItem {
    let counter: String
    let data: Data
}

struct MeshSendResult {
    let id: Data
    let counter: String?
}

struct MeshCoreStatus {
    let running: Bool
    /// Links whose handshake completed: the core's view, not the radio's.
    let meshPeers: Int
    let upstreamReachable: Bool
    let bridgeEnabled: Bool
    let bulletinCounter: String
    let storedBlobs: Int
    // Reported by the Rust node only; the stub leaves the defaults.
    var linksHandshaking: Int = 0
    var meshBlobs: Int = 0
    /// Mesh blobs waiting for a bridge to upload them.
    var uploadPending: Int = 0
    var wantedEntries: Int = 0
    var clockOffsetMs: Int = 0
    var peerId: String = ""
}

/// The Rust node (`RustMeshCore`) when the `GossipMobile` pod is installed
/// (scripts/build-mesh-ios.sh, then `pod install`), else `StubMeshCore`, so a
/// checkout of this repository alone still builds.
enum MeshCoreFactory {
    static func create() -> MeshCore {
        #if canImport(GossipMobile)
        return RustMeshCore()
        #else
        return StubMeshCore()
        #endif
    }

    static var hasRustCore: Bool {
        #if canImport(GossipMobile)
        return true
        #else
        return false
        #endif
    }
}

/// Stand-in for the Rust node until its bindings exist: keeps what the app
/// sends in memory and answers fetches from it. It does not speak on links;
/// incoming chunks are dropped and nothing is relayed. Mirrors `StubMeshCore.kt`.
final class StubMeshCore: MeshCore {
    private let lock = NSLock()
    private var running = false
    private weak var sink: MeshCoreSink?
    private var messages: [Data: [Data]] = [:]
    private var bulletin: [Data] = []
    private var keys: [Data: Data] = [:]
    private var links = Set<Int>()
    private var wanted = Set<Data>()
    private var bridgeEnabled = false

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func start(dataDir: String, configJson: String, sink: MeshCoreSink) throws {
        locked {
            self.sink = sink
            running = true
        }
    }

    func stop() {
        locked {
            running = false
            sink = nil
            links.removeAll()
        }
    }

    func linkUp(linkId: Int, mtu: Int) { _ = locked { links.insert(linkId) } }

    func linkDown(linkId: Int) { _ = locked { links.remove(linkId) } }

    func frameIn(linkId: Int, frame: Data) {}

    func sendBlob(kind: MeshBlobKind, key: Data?, payload: Data) throws -> MeshSendResult {
        let id = Data(SHA256.hash(data: Data(kind.rawValue.utf8) + (key ?? Data()) + payload))
        var arrived: MeshKeyValue?
        let counter: String? = try locked {
            switch kind {
            case .message:
                guard let seeker = key else { throw MeshCoreError.invalidArgument("a message needs its seeker") }
                // Distinct values at one seeker are all kept, in order, as in the node's pool.
                var copies = messages[seeker] ?? []
                if !copies.contains(payload) {
                    copies.append(payload)
                    messages[seeker] = copies
                    if wanted.contains(seeker) { arrived = MeshKeyValue(key: seeker, value: payload) }
                }
                return nil
            case .announcement:
                if !bulletin.contains(payload) { bulletin.append(payload) }
                return String((bulletin.firstIndex(of: payload) ?? 0) + 1)
            case .keys:
                keys[Data(SHA256.hash(data: payload))] = payload
                return nil
            }
        }
        if let arrived = arrived { sink?.arrival(messages: [arrived], announcements: []) }
        return MeshSendResult(id: id, counter: counter)
    }

    func fetch(seekers: [Data]) throws -> [MeshKeyValue] {
        locked { seekers.flatMap { seeker in (messages[seeker] ?? []).map { MeshKeyValue(key: seeker, value: $0) } } }
    }

    func fetchBulletin(cursor: String?, limit: Int) throws -> [MeshBulletinItem] {
        locked {
            let after = Int(cursor ?? "") ?? 0
            return bulletin.enumerated()
                .filter { $0.offset + 1 > after }
                .prefix(limit)
                .map { MeshBulletinItem(counter: String($0.offset + 1), data: $0.element) }
        }
    }

    // The stub hashes with SHA-256; the node indexes key sets by blake3.
    func getKeys(hash: Data) throws -> Data? { locked { keys[hash] } }

    func setWanted(seekers: [Data]) throws { locked { wanted = Set(seekers) } }

    func setUpstream(urls: [String], bridgeEnabled: Bool) throws { locked { self.bridgeEnabled = bridgeEnabled } }

    func status() -> MeshCoreStatus {
        locked {
            MeshCoreStatus(
                running: running,
                // No handshake here: every radio link counts as a peer.
                meshPeers: links.count,
                upstreamReachable: false,
                bridgeEnabled: bridgeEnabled,
                bulletinCounter: String(bulletin.count),
                storedBlobs: messages.values.reduce(0) { $0 + $1.count } + bulletin.count + keys.count
            )
        }
    }

    func wipe() throws {
        locked {
            messages.removeAll()
            bulletin.removeAll()
            keys.removeAll()
        }
    }
}

enum MeshCoreError: Error, LocalizedError {
    case notStarted
    case invalidArgument(String)

    var errorDescription: String? {
        switch self {
        case .notStarted: return "The mesh node is not started"
        case .invalidArgument(let message): return message
        }
    }
}
