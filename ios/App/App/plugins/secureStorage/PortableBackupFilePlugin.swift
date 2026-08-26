import Capacitor
import UIKit

/// Bounded document-picker transport. JavaScript receives random durable tokens, never URLs.
@objc(PortableBackupFilePlugin)
public final class PortableBackupFilePlugin: CAPPlugin, CAPBridgedPlugin,
    UIDocumentPickerDelegate
{
    public let identifier = "PortableBackupFilePlugin"
    public let jsName = "PortableBackupFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "selectExportDestination", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeExportChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginVerification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readVerificationChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishVerification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listInterruptedOutputs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteOutput", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetOutput", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetRecoveryJournal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abandon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startProtection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateProtection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopProtection", returnType: CAPPluginReturnPromise),
    ]

    private let maxChunk = 256 * 1024
    private let maxBase64 = ((256 * 1024 + 2) / 3) * 4
    private let maxBackupBytes: UInt64 = 64 * 1024 * 1024 * 1024
    private var entries: [String: PortableBackupEntry] = [:]
    private var runtimes: [String: PortableBackupRuntime] = [:]
    private var pickerCall: CAPPluginCall?
    private var pickerPlaceholder: URL?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var protectionExpired = false
    private let stateLock = NSRecursiveLock()
    private var journalLoadError: Error?

    public override func load() {
        super.load()
        do {
            entries = try loadJournal()
            journalLoadError = nil
        } catch {
            entries = [:]
            journalLoadError = error
        }
        // A verified marker is retained only when final journal deletion failed.
        // Remove it without touching the user-owned verified output.
        let verified = entries.filter { !$0.value.unverified }.map(\.key)
        if !verified.isEmpty {
            for token in verified { entries.removeValue(forKey: token) }
            try? persistJournal()
        }
    }

    @objc func selectExportDestination(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.selectExportDestinationOnMain(call)
        }
    }

    private func selectExportDestinationOnMain(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            try ensureJournalLoaded()
        } catch {
            call.reject("Backup recovery journal is unavailable", "JOURNAL_FAILED")
            return
        }
        guard pickerCall == nil else {
            call.reject("Backup destination selection is already active", "PICKER_ACTIVE")
            return
        }
        do {
            let placeholder = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: placeholder, withIntermediateDirectories: true)
            let file = placeholder.appendingPathComponent("gossip-backup.gossipbackup")
            guard FileManager.default.createFile(atPath: file.path, contents: Data()) else {
                throw CocoaError(.fileWriteUnknown)
            }
            pickerCall = call
            pickerPlaceholder = placeholder
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            guard let presenter = bridge?.viewController else {
                throw TransportError.notOpen
            }
            presenter.present(picker, animated: true)
        } catch {
            cleanupPicker()
            call.reject("Unable to open backup destination picker", "PICKER_FAILED")
        }
    }

    public func documentPicker(
        _ controller: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let call = pickerCall, urls.count == 1, let url = urls.first else {
            pickerCall?.reject("Select one Gossip backup", "INVALID_DESTINATION")
            cleanupPicker()
            return
        }
        do {
            guard url.startAccessingSecurityScopedResource() else {
                throw PortableBackupSupportError.securityScopeDenied
            }
            defer { url.stopAccessingSecurityScopedResource() }
            let bookmark = try url.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil)
            let token = UUID().uuidString
            entries[token] = PortableBackupEntry(
                bookmark: bookmark,
                name: url.lastPathComponent,
                unverified: true
            )
            do {
                try persistJournal()
            } catch {
                entries.removeValue(forKey: token)
                try? PortableBackupCoordinatedAccess.write(
                    url,
                    options: .forDeleting
                ) { coordinatedURL in
                    try FileManager.default.removeItem(at: coordinatedURL)
                }
                throw error
            }
            call.resolve(["token": token, "name": url.lastPathComponent])
        } catch {
            call.reject("Unable to retain backup destination access", "JOURNAL_FAILED")
        }
        cleanupPicker()
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        stateLock.lock()
        defer { stateLock.unlock() }
        pickerCall?.reject("Backup destination selection cancelled", "CANCELLED")
        cleanupPicker()
    }

    @objc func beginExport(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            let (token, runtime) = try requireRuntime(call)
            runtime.close()
            guard var entry = entries[token] else { throw TransportError.invalidToken }
            entry.unverified = true
            entries[token] = entry
            try persistJournal()
            try PortableBackupCoordinatedAccess.write(runtime.url, options: []) { url in
                let output = try FileHandle(forWritingTo: url)
                defer { try? output.close() }
                try output.truncate(atOffset: 0)
                try output.synchronize()
            }
            runtime.written = 0
            runtime.inputOffset = 0
            runtime.exportOpen = true
            runtime.verificationOpen = false
            call.resolve()
        } catch {
            reject(call, error, code: "OPEN_FAILED")
        }
    }

    @objc func writeExportChunk(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            let (_, runtime) = try requireRuntime(call)
            guard let encoded = call.getString("data"),
                  !encoded.isEmpty, encoded.count <= maxBase64,
                  var bytes = Data(base64Encoded: encoded),
                  !bytes.isEmpty, bytes.count <= maxChunk,
                  runtime.exportOpen
            else { throw TransportError.invalidChunk }
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            let next = try adding(runtime.written, UInt64(bytes.count))
            guard next <= maxBackupBytes else { throw TransportError.tooLarge }
            try PortableBackupCoordinatedAccess.write(
                runtime.url,
                options: .forMerging
            ) { url in
                let output = try FileHandle(forWritingTo: url)
                defer { try? output.close() }
                try output.seek(toOffset: runtime.written)
                try output.write(contentsOf: bytes)
            }
            runtime.written = next
            call.resolve(["writtenBytes": NSNumber(value: next)])
        } catch {
            reject(call, error, code: "WRITE_FAILED")
        }
    }

    @objc func finishExport(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            let (_, runtime) = try requireRuntime(call)
            guard runtime.exportOpen else { throw TransportError.notOpen }
            try PortableBackupCoordinatedAccess.write(
                runtime.url,
                options: .forMerging
            ) { url in
                let output = try FileHandle(forWritingTo: url)
                defer { try? output.close() }
                try output.synchronize()
            }
            runtime.exportOpen = false
            call.resolve(["writtenBytes": NSNumber(value: runtime.written)])
        } catch {
            if let token = call.getString("token") { runtimes[token]?.exportOpen = false }
            reject(call, error, code: "WRITE_FAILED")
        }
    }

    @objc func beginVerification(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            let (_, runtime) = try requireRuntime(call)
            runtime.inputOffset = 0
            runtime.verificationOpen = true
            call.resolve()
        } catch {
            reject(call, error, code: "VERIFY_OPEN_FAILED")
        }
    }

    @objc func readVerificationChunk(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            let (_, runtime) = try requireRuntime(call)
            let requested = call.getInt("maxBytes") ?? maxChunk
            guard requested > 0, requested <= maxChunk, runtime.verificationOpen else {
                throw TransportError.notOpen
            }
            let read = try PortableBackupCoordinatedAccess.read(runtime.url) { url in
                let input = try FileHandle(forReadingFrom: url)
                defer { try? input.close() }
                try input.seek(toOffset: runtime.inputOffset)
                return try input.read(upToCount: requested)
            }
            guard var bytes = read, !bytes.isEmpty else {
                runtime.verificationOpen = false
                call.resolve(["data": NSNull()])
                return
            }
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            runtime.inputOffset = try adding(runtime.inputOffset, UInt64(bytes.count))
            call.resolve(["data": bytes.base64EncodedString()])
        } catch {
            reject(call, error, code: "VERIFY_READ_FAILED")
        }
    }

    @objc func finishVerification(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            let token = try requireToken(call)
            try closeAndTerminalize(token: token)
            call.resolve()
        } catch {
            reject(call, error, code: "JOURNAL_FAILED")
        }
    }

    @objc func listInterruptedOutputs(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            try ensureJournalLoaded()
        } catch {
            call.reject("Backup recovery journal is unavailable", "JOURNAL_FAILED")
            return
        }
        let outputs = entries.compactMap { token, entry -> [String: Any]? in
            guard entry.unverified else { return nil }
            return ["token": token, "name": entry.name]
        }
        call.resolve(["outputs": outputs])
    }

    @objc func deleteOutput(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            try ensureJournalLoaded()
        } catch {
            call.reject("Backup recovery journal is unavailable", "JOURNAL_FAILED")
            return
        }
        guard let token = call.getString("token"), entries[token] != nil else {
            call.resolve(["deleted": false])
            return
        }
        runtimes[token]?.close()
        var cleaned = false
        do {
            let runtime = try runtime(for: token)
            do {
                try PortableBackupCoordinatedAccess.write(
                    runtime.url,
                    options: .forDeleting
                ) { url in
                    try FileManager.default.removeItem(at: url)
                }
                cleaned = true
            } catch where (error as NSError).domain == NSCocoaErrorDomain
                && (error as NSError).code == CocoaError.Code.fileNoSuchFile.rawValue {
                cleaned = true
            } catch {
                try PortableBackupCoordinatedAccess.write(runtime.url, options: []) { url in
                    let output = try FileHandle(forWritingTo: url)
                    defer { try? output.close() }
                    try output.truncate(atOffset: 0)
                    try output.synchronize()
                }
                cleaned = true
            }
            if cleaned { try closeAndTerminalize(token: token) }
        } catch {
            cleaned = false
        }
        call.resolve(["deleted": cleaned])
    }

    @objc func forgetOutput(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            let token = try requireToken(call)
            try closeAndTerminalize(token: token)
            call.resolve()
        } catch {
            reject(call, error, code: "JOURNAL_FAILED")
        }
    }

    @objc func resetRecoveryJournal(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard journalLoadError != nil else {
            call.reject("Recovery journal reset is not authorized", "RESET_NOT_ALLOWED")
            return
        }
        do {
            runtimes.removeAll()
            entries.removeAll()
            let url = journalURL
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            journalLoadError = nil
            try persistJournal()
            call.resolve()
        } catch {
            journalLoadError = error
            call.reject("Unable to reset backup recovery journal", "JOURNAL_FAILED")
        }
    }

    @objc func abandon(_ call: CAPPluginCall) { deleteOutput(call) }

    @objc func startProtection(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.startProtectionOnMain(call) }
    }

    private func startProtectionOnMain(_ call: CAPPluginCall) {
        stateLock.lock()
        defer { stateLock.unlock() }
        endBackgroundTask()
        protectionExpired = false
        backgroundTask = UIApplication.shared.beginBackgroundTask(
            withName: "Gossip portable backup"
        ) { [weak self] in
            guard let self else { return }
            self.protectionExpired = true
            self.endBackgroundTask()
        }
        guard backgroundTask != .invalid else {
            call.reject("Unable to protect backup", "PROTECTION_FAILED")
            return
        }
        call.resolve()
    }

    @objc func updateProtection(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.backgroundTask != .invalid, !self.protectionExpired else {
                call.reject("Backup background time expired", "PROTECTION_FAILED")
                return
            }
            call.resolve()
        }
    }

    @objc func stopProtection(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stateLock.lock()
            defer { self.stateLock.unlock() }
            self.endBackgroundTask()
            self.protectionExpired = false
            call.resolve()
        }
    }

    deinit {
        for runtime in runtimes.values { runtime.close() }
        endBackgroundTask()
        if let placeholder = pickerPlaceholder {
            try? FileManager.default.removeItem(at: placeholder)
        }
    }

    private enum TransportError: Error {
        case invalidToken, invalidChunk, notOpen, tooLarge, overflow
    }

    private func requireToken(_ call: CAPPluginCall) throws -> String {
        try ensureJournalLoaded()
        guard let token = call.getString("token"), entries[token] != nil else {
            throw TransportError.invalidToken
        }
        return token
    }

    private func requireRuntime(_ call: CAPPluginCall) throws -> (String, PortableBackupRuntime) {
        let token = try requireToken(call)
        return (token, try runtime(for: token))
    }

    private func runtime(for token: String) throws -> PortableBackupRuntime {
        if let current = runtimes[token] { return current }
        guard var entry = entries[token] else { throw TransportError.invalidToken }
        var stale = false
        let url = try URL(
            resolvingBookmarkData: entry.bookmark,
            options: .withoutImplicitStartAccessing,
            relativeTo: nil,
            bookmarkDataIsStale: &stale)
        let runtime = try PortableBackupRuntime(url: url)
        if stale {
            entry.bookmark = try url.bookmarkData(
                options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            entries[token] = entry
            try persistJournal()
        }
        runtimes[token] = runtime
        return runtime
    }

    private func closeAndTerminalize(token: String) throws {
        runtimes.removeValue(forKey: token)?.close()
        guard var entry = entries[token] else { throw TransportError.invalidToken }
        entry.unverified = false
        entries[token] = entry
        do {
            try persistJournal()
        } catch {
            entry.unverified = true
            entries[token] = entry
            throw error
        }
        entries.removeValue(forKey: token)
        // A failed removal leaves only a durable verified marker, which load()
        // removes without touching the verified user file.
        try? persistJournal()
    }

    private func adding(_ left: UInt64, _ right: UInt64) throws -> UInt64 {
        let (result, overflow) = left.addingReportingOverflow(right)
        if overflow { throw TransportError.overflow }
        return result
    }

    private var journalURL: URL { PortableBackupJournalStore.url }

    private func ensureJournalLoaded() throws {
        guard journalLoadError != nil else { return }
        entries = try loadJournal()
        journalLoadError = nil
    }

    private func loadJournal() throws -> [String: PortableBackupEntry] {
        try PortableBackupJournalStore.load()
    }

    private func persistJournal() throws {
        try PortableBackupJournalStore.persist(entries)
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func cleanupPicker() {
        if let placeholder = pickerPlaceholder { try? FileManager.default.removeItem(at: placeholder) }
        pickerPlaceholder = nil
        pickerCall = nil
    }

    private func reject(_ call: CAPPluginCall, _ error: Error, code: String) {
        _ = error
        call.reject("Portable backup operation failed", code)
    }
}
