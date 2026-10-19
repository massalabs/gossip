import Foundation

/// Joins the radio and the core for the whole app process. Radio events reach
/// the core in order on one queue; plugin calls run on another, so a slow call
/// never holds back incoming chunks. Mirrors `MeshNodeBridge.kt`; on iOS there
/// is no service, the radio lives as long as the process and state
/// restoration brings the process back for mesh events.
final class MeshNodeBridge: MeshRadioListener, MeshCoreSink {
    static let shared = MeshNodeBridge()

    private let events = DispatchQueue(label: "net.massa.gossip.mesh.events")
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

    /// Starts the core if it is not running; `configJson` only applies to a fresh start.
    func startCore(configJson: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard core == nil else { return }
        let created = MeshCoreFactory.create()
        try created.start(dataDir: try Self.dataDir().path, configJson: configJson, sink: self)
        core = created
    }

    func stopCore() {
        lock.lock()
        defer { lock.unlock() }
        core?.stop()
        core = nil
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
        events.async { self.currentCore()?.frameIn(linkId: linkId, frame: frame) }
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
