import Foundation
import Security

/// Joins the radio and the core for the whole app process. Radio events reach
/// the core in order on one queue; plugin calls run on another, so a slow call
/// never holds back incoming chunks. Mirrors `MeshNodeBridge.kt`; on iOS there
/// is no service, the radio lives as long as the process and state
/// restoration brings the process back for mesh events.
final class MeshNodeBridge: MeshRadioListener, MeshCoreSink {
    static let shared = MeshNodeBridge()

    private let events = DispatchQueue(label: "net.massa.gossip.mesh.events")
    private let inbound = InboundBudget(maxPendingBytes: MeshConstants.maxPendingInboundBytesPerLink)
    private let calls = DispatchQueue(label: "net.massa.gossip.mesh.calls")
    private let lock = NSLock()
    private var core: MeshCore?
    private var radio: MeshRadio?

    /// Set by the plugin; called from the core's threads.
    var onArrival: (([MeshKeyValue], [Data]) -> Void)?
    var onLinksChanged: ((Int) -> Void)?

    private init() {}

    var isCoreRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return core != nil
    }

    /// The configuration of the last start, without the pool key.
    private var baseConfig = "{}"

    /// Starts the core if it is not running; `configJson` only applies to a
    /// fresh start. The pool key comes from `MeshPoolKey`, never from the
    /// remembered configuration.
    func startCore(configJson: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard core == nil else { return }
        let dataDir = try Self.dataDir()
        // pools left under a key the Keychain lost no longer open: start afresh
        let withKey = try MeshPoolKey.withPoolKey(configJson) { Self.clearDataDir(dataDir) }
        let created = MeshCoreFactory.create()
        try created.start(dataDir: dataDir.path, configJson: withKey, sink: self)
        baseConfig = configJson
        core = created
    }

    /// Deletes everything the node stored and replaces the pool key, so that
    /// nothing is left wrapped under the old one. A running core restarts
    /// empty (a failed restart leaves it stopped, its directory deleted); a
    /// stopped one has its data directory deleted.
    func wipe(completion: @escaping (Result<Void, Error>) -> Void) {
        calls.async {
            completion(Result {
                let dataDir = try Self.dataDir()
                // not held across core calls: the core's writer reaches the radio through it
                self.lock.lock()
                let running = self.core
                let base = self.baseConfig
                self.lock.unlock()
                let fresh = try MeshPoolKey.replace(base)
                guard let running = running else {
                    Self.clearDataDir(dataDir)
                    return
                }
                do {
                    try running.wipe(newConfigJson: fresh)
                } catch {
                    running.stop()
                    self.lock.lock()
                    if self.core === running { self.core = nil }
                    self.lock.unlock()
                    Self.clearDataDir(dataDir)
                    throw error
                }
            })
        }
    }

    private static func clearDataDir(_ url: URL) {
        let fileManager = FileManager.default
        for item in (try? fileManager.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? [] {
            try? fileManager.removeItem(at: item)
        }
    }

    func stopCore() {
        lock.lock()
        let running = core
        core = nil
        lock.unlock()
        // outside the lock: stopping joins the core's writer, which may be
        // waiting for it in sendFrame
        running?.stop()
    }

    /// Starts the radio after the core, so no link event is lost.
    func startRadio(mode: MeshPowerMode) {
        lock.lock()
        defer { lock.unlock() }
        guard radio == nil else { return }
        let created = CoreBluetoothMeshRadio()
        radio = created
        created.start(mode: mode, listener: self)
    }

    func stopRadio() {
        lock.lock()
        defer { lock.unlock() }
        radio?.stop()
        radio = nil
    }

    func setPowerMode(_ mode: MeshPowerMode) {
        currentRadio()?.setPowerMode(mode)
    }

    func linkCount() -> Int { currentRadio()?.linkCount() ?? 0 }

    /// The app locked (from the app or the native auto-lock): the running
    /// core empties its wanted list and deletes the keys shared nearby, and
    /// keeps relaying. A stopped core holds neither.
    func lockNode(completion: (() -> Void)? = nil) {
        calls.async {
            self.currentCore()?.lockNode()
            completion?()
        }
    }

    /// Runs `body` against the core on the calls queue.
    func call<T>(_ body: @escaping (MeshCore) throws -> T, completion: @escaping (Result<T, Error>) -> Void) {
        calls.async {
            self.lock.lock()
            let running = self.core
            self.lock.unlock()
            guard let core = running else {
                completion(.failure(MeshCoreError.notStarted))
                return
            }
            completion(Result { try body(core) })
        }
    }

    /// Kept out of backups: it holds blobs relayed for other people.
    private static func dataDir() throws -> URL {
        var url = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent("mesh", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        return url
    }

    private func currentRadio() -> MeshRadio? {
        lock.lock()
        defer { lock.unlock() }
        return radio
    }

    private func currentCore() -> MeshCore? {
        lock.lock()
        defer { lock.unlock() }
        return core
    }

    // MARK: - MeshRadioListener: radio queue → events queue

    func onLinkUp(linkId: Int, mtu: Int) {
        events.async { self.currentCore()?.linkUp(linkId: linkId, mtu: mtu) }
        notifyLinks()
    }

    func onLinkDown(linkId: Int) {
        events.async { self.currentCore()?.linkDown(linkId: linkId) }
        notifyLinks()
    }

    func onFrameIn(linkId: Int, frame: Data) {
        // a link that outpaces the core is closed rather than queued without bound
        guard inbound.tryAdd(linkId: linkId, bytes: frame.count) else {
            currentRadio()?.closeLink(linkId: linkId)
            return
        }
        events.async {
            defer { self.inbound.release(linkId: linkId, bytes: frame.count) }
            self.currentCore()?.frameIn(linkId: linkId, frame: frame)
        }
    }

    // MARK: - MeshCoreSink: core → radio and app

    func sendFrame(linkId: Int, frame: Data) -> Bool {
        currentRadio()?.sendFrame(linkId: linkId, frame: frame) ?? false
    }

    func closeLink(linkId: Int) {
        currentRadio()?.closeLink(linkId: linkId)
    }

    func arrival(messages: [MeshKeyValue], announcements: [Data]) {
        onArrival?(messages, announcements)
    }

    private func notifyLinks() {
        // Read on the events queue so the count includes the change being reported.
        events.async { self.onLinksChanged?(self.linkCount()) }
    }
}

/// Bytes received on each link and not yet taken by the core. Mirrors
/// `InboundBudget` in InboundLimits.kt.
final class InboundBudget {
    private let maxPendingBytes: Int
    private let lock = NSLock()
    private var pending: [Int: Int] = [:]

    init(maxPendingBytes: Int) {
        self.maxPendingBytes = maxPendingBytes
    }

    /// Counts `bytes` for `linkId`; false, counting nothing, when that would pass the bound.
    func tryAdd(linkId: Int, bytes: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let next = (pending[linkId] ?? 0) + bytes
        guard next <= maxPendingBytes else { return false }
        pending[linkId] = next
        return true
    }

    func release(linkId: Int, bytes: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard let current = pending[linkId] else { return }
        let next = current - bytes
        pending[linkId] = next > 0 ? next : nil
    }
}

/// The key the mesh node encrypts its pools with (`pool_key_hex`): 32 random
/// bytes per installation in the Keychain, readable after the first unlock
/// (CoreBluetooth relaunches the app in the background) and only on this
/// device (`ThisDeviceOnly`: never in a backup or a device migration).
/// `replace` draws a new one, so a wipe leaves nothing wrapped under the old
/// key. Mirrors `MeshPoolKey.kt`.
enum MeshPoolKey {
    private static let service = "net.massa.gossip.mesh"
    private static let account = "pool-key"
    private static let lock = NSLock()

    /// `configJson` with this installation's pool key, created on first use.
    /// `onNewKey` runs before a key is created: pools left under a lost key no
    /// longer open, so the caller deletes them.
    static func withPoolKey(_ configJson: String, onNewKey: () -> Void = {}) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let key: Data
        if let stored = load() {
            key = stored
        } else {
            onNewKey()
            key = try create()
        }
        var config = (try? JSONSerialization.jsonObject(with: Data(configJson.utf8))) as? [String: Any] ?? [:]
        config["pool_key_hex"] = key.map { String(format: "%02x", $0) }.joined()
        let data = try JSONSerialization.data(withJSONObject: config)
        return String(decoding: data, as: UTF8.self)
    }

    /// Draws a new pool key (the old one is deleted) and returns `configJson` with it.
    static func replace(_ configJson: String) throws -> String {
        lock.lock()
        SecItemDelete(baseQuery() as CFDictionary)
        lock.unlock()
        return try withPoolKey(configJson)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func load() -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, data.count == 32 else { return nil }
        return data
    }

    private static func create() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw MeshCoreError.unsupported("No randomness for the mesh pool key")
        }
        let key = Data(bytes)
        SecItemDelete(baseQuery() as CFDictionary)
        var attributes = baseQuery()
        attributes[kSecValueData as String] = key
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        attributes[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw MeshCoreError.unsupported("Could not store the mesh pool key (\(status))")
        }
        return key
    }
}
