#if canImport(GossipMobile)
import Foundation
import GossipMobile

/// `MeshCore` over the Rust `gossip-mobile` node, from the `GossipMobile`
/// pod (scripts/build-mesh-ios.sh). The pod's types share names with the app's
/// own, hence the `GossipMobile.` prefixes.
///
/// The node may call the sink from inside `linkUp` and `frameIn` (closeLink
/// of a duplicate link); the sink adapter only forwards.
final class RustMeshCore: MeshCore {
    private let node: GossipMobile.MeshNodeCoreProtocol
    private let lock = NSLock()
    // `wipe` restarts the node empty, upstream and wanted list included:
    // remembered here so they are applied again.
    private var upstream: (urls: [String], bridge: Bool)?
    private var wanted: (seekers: [Data], local: [Data]) = ([], [])

    init(node: GossipMobile.MeshNodeCoreProtocol = GossipMobile.MeshNodeCore()) {
        self.node = node
    }

    func start(dataDir: String, configJson: String, sink: MeshCoreSink) throws {
        try node.start(dataDir: dataDir, configJson: configJson, sink: SinkAdapter(sink: sink))
    }

    func stop() { node.stop() }

    func linkUp(linkId: Int, mtu: Int) { node.linkUp(linkId: Int32(linkId), mtu: Int32(mtu)) }

    func linkDown(linkId: Int) { node.linkDown(linkId: Int32(linkId)) }

    func frameIn(linkId: Int, frame: Data) { node.frameIn(linkId: Int32(linkId), frame: frame) }

    func sendBlob(kind: MeshBlobKind, key: Data?, payload: Data, localOnly: Bool) throws -> MeshSendResult {
        let result = try node.sendBlob(kind: kind.ffi, key: key, payload: payload, localOnly: localOnly)
        return MeshSendResult(id: result.id, counter: result.counter)
    }

    func fetch(seekers: [Data]) throws -> [MeshKeyValue] {
        node.fetch(seekers: seekers).map { MeshKeyValue(key: $0.key, value: $0.value) }
    }

    func fetchBulletin(cursor: String?, limit: Int) throws -> [MeshBulletinItem] {
        node.fetchBulletin(cursor: cursor, limit: Int32(clamping: limit))
            .map { MeshBulletinItem(counter: $0.counter, data: $0.data) }
    }

    func getKeys(hash: Data) throws -> Data? { node.getKeys(hash: hash) }

    func setWanted(seekers: [Data], localSeekers: [Data]) throws {
        lock.lock(); defer { lock.unlock() }
        wanted = (seekers, localSeekers)
        node.setWanted(seekers: seekers, localSeekers: localSeekers)
    }

    func setUpstream(urls: [String], bridgeEnabled: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        upstream = (urls, bridgeEnabled)
        node.setUpstream(urls: urls, bridgeEnabled: bridgeEnabled)
    }

    func status() -> MeshCoreStatus {
        let status = node.status()
        return MeshCoreStatus(
            running: status.running,
            meshPeers: Int(status.meshPeers),
            upstreamReachable: status.upstreamReachable,
            bridgeEnabled: status.bridgeEnabled,
            bulletinCounter: status.bulletinCounter,
            storedBlobs: Int(status.storedBlobs),
            linksHandshaking: Int(status.linksHandshaking),
            meshBlobs: Int(status.meshBlobs),
            uploadPending: Int(status.uploadPending),
            wantedEntries: Int(status.wantedEntries),
            clockOffsetMs: Int(status.clockOffsetMs)
        )
    }

    func wipe(newConfigJson: String) throws {
        lock.lock(); defer { lock.unlock() }
        try node.wipe(newConfigJson: newConfigJson)
        if let upstream { node.setUpstream(urls: upstream.urls, bridgeEnabled: upstream.bridge) }
        if !wanted.seekers.isEmpty || !wanted.local.isEmpty {
            node.setWanted(seekers: wanted.seekers, localSeekers: wanted.local)
        }
    }

    func forgetKeys(hash: Data) -> Bool { node.forgetKeys(hash: hash) }

    func lockNode() {
        lock.lock(); defer { lock.unlock() }
        wanted = ([], [])
        node.lock()
    }

    private final class SinkAdapter: GossipMobile.MeshCoreSink, @unchecked Sendable {
        private let sink: MeshCoreSink

        init(sink: MeshCoreSink) { self.sink = sink }

        func sendFrame(linkId: Int32, frame: Data) -> Bool { sink.sendFrame(linkId: Int(linkId), frame: frame) }

        func closeLink(linkId: Int32) { sink.closeLink(linkId: Int(linkId)) }

        func arrival(messages: [GossipMobile.MeshKeyValue], announcements: [Data]) {
            sink.arrival(messages: messages.map { MeshKeyValue(key: $0.key, value: $0.value) }, announcements: announcements)
        }
    }
}

private extension MeshBlobKind {
    var ffi: GossipMobile.MeshBlobKind {
        switch self {
        case .message: return .message
        case .announcement: return .announcement
        case .keys: return .keys
        }
    }
}
#endif
