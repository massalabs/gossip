import Capacitor

@objc(SecureStoragePlugin)
public class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorageNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initSecureStorage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "provisionStorage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "allocateSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlockSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lockSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isUnlocked", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "coverTrafficTick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "execSql", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeNamespaceData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readNamespaceData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "namespaceDataLength", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNamespace", returnType: CAPPluginReturnPromise),
    ]

    /// Single dedicated 8 MB-stack worker thread, serviced via a FIFO
    /// work queue. Spawning a new 8 MB `Thread` per call (the previous
    /// approach) was expensive on hot paths like `execSql`.
    ///
    /// PQ (ML-KEM) crypto needs ~4 MB of stack; the default iOS
    /// `DispatchQueue` stack is only 512 KB, hence the custom thread.
    private static let worker: WorkerThread = WorkerThread()

    private func enqueue(_ work: @escaping () -> Void) {
        SecureStoragePlugin.worker.enqueue(work)
    }

    @objc func initSecureStorage(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("missing path"); return
        }
        let domain = call.getString("domain") ?? "gossip"
        enqueue {
            do {
                let docsDir = FileManager.default
                    .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                let fullPath = docsDir.appendingPathComponent(path).path
                try FileManager.default.createDirectory(
                    atPath: fullPath, withIntermediateDirectories: true)
                // Data protection + backup exclusion — the storage
                // must remain encrypted when the device is locked and
                // must not leak via iCloud/iTunes backups.
                try? FileManager.default.setAttributes(
                    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                    ofItemAtPath: fullPath)
                var url = URL(fileURLWithPath: fullPath)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? url.setResourceValues(values)

                try initSecureStorage(path: fullPath, domain: domain)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func provisionStorage(_ call: CAPPluginCall) {
        enqueue {
            do {
                try provisionStorageNative()
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func allocateSession(_ call: CAPPluginCall) {
        guard let slot = call.getInt("slot"),
              slot >= 0, slot <= 255,
              let pwArray = call.getArray("password") as? [Int]
        else { call.reject("missing slot or password, or slot out of range"); return }
        var password = Data(pwArray.map { UInt8($0 & 0xFF) })
        enqueue {
            defer { Self.zero(&password) }
            do { try allocateSessionNative(slot: UInt8(slot), password: password); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func unlockSession(_ call: CAPPluginCall) {
        guard let pwArray = call.getArray("password") as? [Int]
        else { call.reject("missing password"); return }
        var password = Data(pwArray.map { UInt8($0 & 0xFF) })
        enqueue {
            defer { Self.zero(&password) }
            do {
                let unlocked = try unlockSessionNative(password: password)
                call.resolve(["unlocked": unlocked])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func lockSession(_ call: CAPPluginCall) {
        enqueue {
            do { try lockSessionNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func isUnlocked(_ call: CAPPluginCall) {
        enqueue {
            do {
                let unlocked = try isUnlockedNative()
                call.resolve(["unlocked": unlocked])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func coverTrafficTick(_ call: CAPPluginCall) {
        enqueue {
            do { try coverTrafficTickNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func execSql(_ call: CAPPluginCall) {
        guard let sql = call.getString("sql") else {
            call.reject("missing sql"); return
        }
        let rawParams = call.getArray("params") ?? []
        let params = convertSqlParams(rawParams)
        enqueue {
            do {
                let qr = try execSqlNative(sql: sql, params: params)
                var result: [String: Any] = [:]
                result["columns"] = qr.columns
                result["rows"] = qr.rows.map { row in row.map { self.sqlValueToJson($0) } }
                result["lastInsertRowId"] = qr.lastInsertRowid
                result["changes"] = qr.changes
                call.resolve(result)
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func flush(_ call: CAPPluginCall) {
        enqueue {
            do { try flushNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        enqueue {
            do { try closeNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    // MARK: - Namespace data API (session blob persistence)

    @objc func writeNamespaceData(_ call: CAPPluginCall) {
        guard let namespace = call.getInt("namespace"),
              namespace >= 0, namespace <= 255,
              let offset = call.getInt("offset"),
              let dataArr = call.getArray("data") as? [Int]
        else { call.reject("missing/invalid namespace/offset/data"); return }
        let data = Data(dataArr.map { UInt8($0 & 0xFF) })
        enqueue {
            do {
                try writeNamespaceDataNative(
                    namespace: UInt8(namespace),
                    offset: UInt64(offset),
                    data: data)
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func readNamespaceData(_ call: CAPPluginCall) {
        guard let namespace = call.getInt("namespace"),
              namespace >= 0, namespace <= 255,
              let offset = call.getInt("offset"),
              let len = call.getInt("len")
        else { call.reject("missing/invalid namespace/offset/len"); return }
        enqueue {
            do {
                let out = try readNamespaceDataNative(
                    namespace: UInt8(namespace),
                    offset: UInt64(offset),
                    len: UInt64(len))
                call.resolve(["data": Array(out).map { Int($0) }])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func namespaceDataLength(_ call: CAPPluginCall) {
        guard let namespace = call.getInt("namespace"),
              namespace >= 0, namespace <= 255
        else { call.reject("missing/invalid namespace"); return }
        enqueue {
            do {
                let len = try namespaceDataLengthNative(namespace: UInt8(namespace))
                call.resolve(["length": Int64(len)])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func clearNamespace(_ call: CAPPluginCall) {
        guard let namespace = call.getInt("namespace"),
              namespace >= 0, namespace <= 255
        else { call.reject("missing/invalid namespace"); return }
        enqueue {
            do {
                try clearNamespaceNative(namespace: UInt8(namespace))
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }

    // MARK: - Helpers

    private static func zero(_ buf: inout Data) {
        buf.resetBytes(in: 0..<buf.count)
    }

    private func convertSqlParams(_ arr: [Any]) -> [SqlParam] {
        arr.map { v in
            switch v {
            case is NSNull: return .null
            case let n as NSNumber:
                // `NSNumber` from the JS bridge can represent Bool, Int,
                // or Double. Use the ObjC type encoding to disambiguate:
                // Bool → 'c' (BOOL = signed char), Int → 'q'/'i', Double → 'd'.
                let t = String(cString: n.objCType)
                if t == "c" || t == "B" { return .integer(value: n.boolValue ? 1 : 0) }
                if t == "d" || t == "f" { return .real(value: n.doubleValue) }
                return .integer(value: n.int64Value)
            case let s as String: return .text(value: s)
            case let a as [Int]:
                return .blob(value: Data(a.map { UInt8($0 & 0xFF) }))
            default: return .text(value: String(describing: v))
            }
        }
    }

    private func sqlValueToJson(_ v: SqlValue) -> Any {
        switch v {
        case .null: return NSNull()
        case .integer(let value): return value
        case .real(let value): return value
        case .text(let value): return value
        case .blob(let value): return Array(value).map { Int($0) }
        }
    }
}

// MARK: - WorkerThread

/// Dedicated 8 MB-stack pthread draining a FIFO work queue. Replaces the
/// previous "spawn a new Thread per call" pattern — spawn cost + 8 MB
/// allocation per call were both wasteful on hot paths.
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
