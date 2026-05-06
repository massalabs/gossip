import Capacitor
import os.log

@objc(SecureStoragePlugin)
public class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorageNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
    ]

    /// Dedicated 8 MB-stack worker thread draining a single FIFO queue.
    /// PQ (ML-KEM) crypto needs ~4 MB of stack; iOS's default
    /// `DispatchQueue` stack is only 512 KB.
    ///
    /// Keep every secure-storage call on one queue. The native VFS owns
    /// one global unlocked session and one SQLite handle set, so
    /// namespace calls must not overtake lifecycle calls such as
    /// `unlockSession`, `lockSession`, `flush`, or `close`.
    private static let worker: WorkerThread = WorkerThread(name: "secure-storage")

    private static let log = OSLog(subsystem: "secureStorage", category: "plugin")

    /// Single dispatcher. Every JS call is `{method, args}` where
    /// `args` is a JSON string. Rust does the parsing/encoding.
    /// `initSecureStorage` is special-cased to resolve the relative
    /// `path` under the app's sandboxed Application Support dir and
    /// apply iOS data-protection attributes.
    @objc func call(_ call: CAPPluginCall) {
        guard let method = call.getString("method") else {
            call.reject("missing method", "MISSING_METHOD")
            return
        }
        let rawArgs = call.getString("args") ?? "{}"

        let args: String
        if method == "initSecureStorage" {
            do {
                args = try Self.resolveInitArgs(rawArgs)
            } catch {
                call.reject(error.localizedDescription, "INIT_ARGS")
                return
            }
        } else {
            args = rawArgs
        }

        Self.worker.enqueue {
            do {
                let result = try nativeCall(method: method, argsJson: args)
                call.resolve(["result": result])
            } catch let SecureStorageException.Error(code, msg) {
                call.reject(msg, code)
            } catch {
                call.reject(error.localizedDescription, "INTERNAL")
            }
        }
    }

    /// Resolve the relative path to an absolute path rooted in the
    /// sandboxed Application Support directory and mark it excluded
    /// from backup. The directory uses
    /// `completeUntilFirstUserAuthentication`, meaning iOS blocks access
    /// before the first device unlock after boot, then allows later
    /// background access even while the device is locked.
    ///
    /// Both attribute applications are best-effort but logged on failure.
    /// If the backup exclusion specifically fails, that is fatal: a
    /// secureStorage file leaking into iCloud breaks the plausible-deniability
    /// story, so we surface the error to the caller rather than silently
    /// continuing.
    private static func resolveInitArgs(_ rawArgs: String) throws -> String {
        guard let data = rawArgs.data(using: .utf8),
              var json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw NSError(
                domain: "SecureStorage",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "invalid init args"])
        }

        let rel = (json["path"] as? String) ?? "secure-storage"
        let docsDir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let fullPath = docsDir.appendingPathComponent(rel).path
        try FileManager.default.createDirectory(
            atPath: fullPath, withIntermediateDirectories: true)

        // Keep storage unavailable before first unlock after boot, while
        // still permitting native background work after that first unlock.
        do {
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: fullPath)
        } catch {
            os_log(
                "data protection class application failed: %{public}@",
                log: Self.log, type: .error, error.localizedDescription)
        }

        // Backup exclusion: secureStorage must NOT ride iCloud backups.
        // Failure here breaks plausible deniability, so it is fatal.
        var url = URL(fileURLWithPath: fullPath)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)

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

    init(name: String) {
        let t = Thread(target: self, selector: #selector(run), object: nil)
        t.stackSize = 8 * 1024 * 1024
        t.qualityOfService = .userInitiated
        t.name = name
        t.start()
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
