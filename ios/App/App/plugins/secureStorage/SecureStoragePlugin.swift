import Capacitor

@objc(SecureStoragePlugin)
public class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorageNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
    ]

    /// Single dedicated 8 MB-stack worker thread, serviced via a FIFO
    /// queue. PQ (ML-KEM) crypto needs ~4 MB of stack; the default
    /// iOS `DispatchQueue` stack is only 512 KB.
    private static let worker: WorkerThread = WorkerThread()

    /// Single dispatcher. Every JS call is `{method, args}` where
    /// `args` is a JSON string. Rust does the parsing/encoding.
    /// `initSecureStorage` is special-cased to resolve the relative
    /// `path` under the app's sandboxed Application Support dir and
    /// apply iOS data-protection attributes.
    @objc func call(_ call: CAPPluginCall) {
        guard let method = call.getString("method") else {
            call.reject("missing method"); return
        }
        let rawArgs = call.getString("args") ?? "{}"

        let args: String
        if method == "initSecureStorage" {
            do {
                args = try Self.resolveInitArgs(rawArgs)
            } catch {
                call.reject(error.localizedDescription); return
            }
        } else {
            args = rawArgs
        }

        Self.worker.enqueue {
            do {
                let result = try nativeCall(method: method, argsJson: args)
                call.resolve(["result": result])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// Resolve the relative path to an absolute path rooted in the
    /// sandboxed Application Support directory and mark it
    /// `completeUntilFirstUserAuthentication` + excluded from backup.
    private static func resolveInitArgs(_ rawArgs: String) throws -> String {
        guard let data = rawArgs.data(using: .utf8),
              var json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw NSError(domain: "SecureStorage", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid init args"]) }

        let rel = (json["path"] as? String) ?? "secure-storage"
        let docsDir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let fullPath = docsDir.appendingPathComponent(rel).path
        try FileManager.default.createDirectory(
            atPath: fullPath, withIntermediateDirectories: true)
        // Data protection + backup exclusion — storage stays encrypted
        // when the device is locked and must not leak via iCloud backups.
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fullPath)
        var url = URL(fileURLWithPath: fullPath)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)

        json["path"] = fullPath
        let out = try JSONSerialization.data(withJSONObject: json)
        return String(data: out, encoding: .utf8) ?? "{}"
    }
}

// MARK: - WorkerThread

/// Dedicated 8 MB-stack pthread draining a FIFO work queue.
private final class WorkerThread {
    private let lock = NSCondition()
    private var queue: [() -> Void] = []
    private var thread: Thread?

    init() {
        let t = Thread(target: self, selector: #selector(run), object: nil)
        t.stackSize = 8 * 1024 * 1024
        t.qualityOfService = .userInitiated
        t.name = "secure-storage"
        t.start()
        thread = t
    }

    func enqueue(_ work: @escaping () -> Void) {
        lock.lock()
        queue.append(work)
        lock.signal()
        lock.unlock()
    }

    @objc private func run() {
        while true {
            lock.lock()
            while queue.isEmpty { lock.wait() }
            let job = queue.removeFirst()
            lock.unlock()
            job()
        }
    }
}
