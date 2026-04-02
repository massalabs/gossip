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
    ]

    /// Serialization lock — ensures only one Rust call at a time.
    private let lock = NSLock()

    /// Run a closure on a thread with 8 MB stack (serialized).
    /// PQ (ML-KEM) crypto operations need ~4 MB of stack space,
    /// but iOS DispatchQueue threads only have 512 KB by default.
    private func runOnLargeStack(_ work: @escaping () -> Void) {
        let thread = Thread { [lock] in
            lock.lock()
            defer { lock.unlock() }
            work()
        }
        thread.stackSize = 8 * 1024 * 1024
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    @objc func initSecureStorage(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("missing path"); return
        }
        let domain = call.getString("domain") ?? "gossip"
        runOnLargeStack {
            do {
                let docsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
                let fullPath = docsDir.appendingPathComponent(path).path
                try FileManager.default.createDirectory(atPath: fullPath, withIntermediateDirectories: true)
                try Gossip.initSecureStorage(path: fullPath, domain: domain)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func provisionStorage(_ call: CAPPluginCall) {
        runOnLargeStack {
            do {
                let fresh = try provisionStorageNative()
                call.resolve(["fresh": fresh])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func allocateSession(_ call: CAPPluginCall) {
        guard let slot = call.getInt("slot"),
              let pwArray = call.getArray("password") as? [Int]
        else { call.reject("missing slot or password"); return }
        let password = Data(pwArray.map { UInt8($0 & 0xFF) })
        runOnLargeStack {
            do { try allocateSessionNative(slot: UInt8(slot), password: password); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func unlockSession(_ call: CAPPluginCall) {
        guard let pwArray = call.getArray("password") as? [Int]
        else { call.reject("missing password"); return }
        let password = Data(pwArray.map { UInt8($0 & 0xFF) })
        runOnLargeStack {
            do {
                let unlocked = try unlockSessionNative(password: password)
                call.resolve(["unlocked": unlocked])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func lockSession(_ call: CAPPluginCall) {
        runOnLargeStack {
            do { try lockSessionNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func isUnlocked(_ call: CAPPluginCall) {
        runOnLargeStack {
            do {
                let unlocked = try isUnlockedNative()
                call.resolve(["unlocked": unlocked])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func coverTrafficTick(_ call: CAPPluginCall) {
        runOnLargeStack {
            do { try coverTrafficTickNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func execSql(_ call: CAPPluginCall) {
        guard let sql = call.getString("sql") else {
            call.reject("missing sql"); return
        }
        let rawParams = call.getArray("params") ?? []
        let tConvert = CFAbsoluteTimeGetCurrent()
        let params = convertSqlParams(rawParams)
        let convertMs = (CFAbsoluteTimeGetCurrent() - tConvert) * 1000

        let tLockWait = CFAbsoluteTimeGetCurrent()
        runOnLargeStack {
            let lockMs = (CFAbsoluteTimeGetCurrent() - tLockWait) * 1000
            do {
                let tExec = CFAbsoluteTimeGetCurrent()
                let qr = try execSqlNative(sql: sql, params: params)
                let execMs = (CFAbsoluteTimeGetCurrent() - tExec) * 1000

                let tSerialize = CFAbsoluteTimeGetCurrent()
                var result: [String: Any] = [:]
                result["columns"] = qr.columns
                result["rows"] = qr.rows.map { row in row.map { self.sqlValueToJson($0) } }
                result["lastInsertRowId"] = qr.lastInsertRowid
                result["changes"] = qr.changes
                let serializeMs = (CFAbsoluteTimeGetCurrent() - tSerialize) * 1000

                let sqlType = sql.trimmingCharacters(in: .whitespaces).prefix(6).uppercased()
                let totalMs = convertMs + lockMs + execMs + serializeMs
                if totalMs > 5 {
                    NSLog("[NativePerf] %@(%.0fms) lock=%.0f exec=%.0f ser=%.0f conv=%.0f: %@",
                          sqlType, totalMs, lockMs, execMs, serializeMs, convertMs,
                          String(sql.prefix(80)))
                }
                call.resolve(result)
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func flush(_ call: CAPPluginCall) {
        runOnLargeStack {
            do { try flushNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        runOnLargeStack {
            do { try closeNative(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    // MARK: - Helpers

    private func convertSqlParams(_ arr: [Any]) -> [SqlParam] {
        arr.map { v in
            switch v {
            case is NSNull: return .null
            case let b as Bool: return .integer(value: b ? 1 : 0)
            case let n as Int: return .integer(value: Int64(n))
            case let n as Int64: return .integer(value: n)
            case let n as Double: return .real(value: n)
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
