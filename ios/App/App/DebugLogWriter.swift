#if FULL_DEBUG
import AVFoundation
import CoreBluetooth
import Foundation
import Security
import UIKit
import UserNotifications

/// The record of the full debug build (`FULL_DEBUG`, absent from every other
/// build): JSON lines in `Application Support/debug-logs/NNNNNN.jsonl`,
/// excluded from the iCloud backup, written by one serial queue. Same format
/// and rules as `DebugLogWriter.kt` on Android.
///
/// Every line gets its number `n` here (one counter for the web view and the
/// native code, never reused in one install). A segment is closed at 16 MiB
/// and starts with a header line; the oldest segments are deleted when the
/// total goes over the cap (5 GiB by default; 1, 2 or 5 GiB) or when the free
/// space of the phone falls under 2 GiB.
///
/// Nothing here may throw into the app: only the throwing `FileHandle` APIs
/// are used (the older ones raise Objective-C exceptions), and every
/// `JSONSerialization` call is checked with `isValidJSONObject` first.
final class DebugLogWriter {
    static let shared = DebugLogWriter()

    static let segmentMax = 16 * 1024 * 1024
    static let gib = 1024 * 1024 * 1024
    static let defaultCap = 5 * gib
    static let minCap = 32 * 1024 * 1024
    /// Never leave the phone with less free space than this: oldest segments go first.
    static let minFree = 2 * gib
    static let installIdKey = "gossip-full-debug-install-id"
    /// Capacitor Preferences keeps its values in UserDefaults with this prefix.
    private static let capacitorPrefix = "CapacitorStorage."
    private static let capKey = "gossip-full-debug.cap"
    private static let lastNKey = "gossip-full-debug.lastN"
    private static let bufferMax = 64 * 1024

    let queue = DispatchQueue(label: "net.massa.gossip.debug-log", qos: .utility)
    private let queueKey = DispatchSpecificKey<Bool>()
    let installId: String
    private let startUptime = ProcessInfo.processInfo.systemUptime

    // Queue only below.
    private var dir: URL?
    private var handle: FileHandle?
    private var currentName: String?
    private var currentSize = 0
    private var pending = Data()
    private var nextN = 1
    private var cap = DebugLogWriter.defaultCap
    private var webInfo: [String: Any]?
    private var flushScheduled = false
    private var opened = false

    /// Errors found natively (previous run, uncaught exception) for the JS pop-up.
    private let errorsLock = NSLock()
    private var errors: [String] = []

    private init() {
        installId = DebugLogWriter.loadInstallId()
        queue.setSpecific(key: queueKey, value: true)
    }

    /// Opens the record (once). Any thread.
    func start() {
        queue.async { [self] in
            guard !opened else { return }
            opened = true
            openRecord()
        }
    }

    private static func loadInstallId() -> String {
        let defaults = UserDefaults.standard
        let key = capacitorPrefix + installIdKey
        if let existing = defaults.string(forKey: key), isSafeId(existing) {
            return existing
        }
        var bytes = [UInt8](repeating: 0, count: 16)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            return "unknown"
        }
        let id = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        defaults.set(id, forKey: key)
        return id
    }

    private static func isSafeId(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 64 else { return false }
        for u in s.unicodeScalars {
            let ok = (u >= "A" && u <= "Z") || (u >= "a" && u <= "z") || (u >= "0" && u <= "9")
                || u == "-" || u == "_"
            if !ok { return false }
        }
        return true
    }

    private var onQueue: Bool { DispatchQueue.getSpecific(key: queueKey) == true }

    /// Runs on the writer queue and waits for it, at most `timeout` seconds.
    func call<T>(_ timeout: TimeInterval, _ task: @escaping () -> T) -> T? {
        if onQueue { return task() }
        let done = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()
        queue.async {
            box.value = task()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut { return nil }
        return box.value
    }

    private final class ResultBox<T> {
        var value: T?
    }

    // MARK: - queue only

    private func openRecord() {
        let fm = FileManager.default
        guard let base = try? fm.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        else { return }
        var d = base.appendingPathComponent("debug-logs", isDirectory: true)
        do {
            try fm.createDirectory(at: d, withIntermediateDirectories: true, attributes: nil)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try d.setResourceValues(values)
        } catch {
            // the directory may still be usable
        }
        dir = d
        let stored = UserDefaults.standard.integer(forKey: DebugLogWriter.capKey)
        cap = stored > 0 ? max(DebugLogWriter.minCap, stored) : DebugLogWriter.defaultCap
        nextN = recoverNextN()
        enforceCap()
        openNewSegment()
    }

    private static func isSegmentName(_ name: String) -> Bool {
        guard name.count == 12, name.hasSuffix(".jsonl") else { return false }
        return name.prefix(6).allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    func segments() -> [URL] {
        guard let d = dir,
              let items = try? FileManager.default.contentsOfDirectory(
                at: d, includingPropertiesForKeys: nil, options: [])
        else { return [] }
        return items
            .filter { DebugLogWriter.isSegmentName($0.lastPathComponent) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static func size(of url: URL) -> Int {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let n = attrs[.size] as? NSNumber
        else { return 0 }
        return n.intValue
    }

    private func recoverNextN() -> Int {
        var best = UserDefaults.standard.integer(forKey: DebugLogWriter.lastNKey)
        if let last = segments().last, let h = try? FileHandle(forReadingFrom: last) {
            defer { try? h.close() }
            let len = DebugLogWriter.size(of: last)
            let start = max(0, len - 256 * 1024)
            if (try? h.seek(toOffset: UInt64(start))) != nil,
               let data = try? h.readToEnd() {
                let text = String(decoding: data, as: UTF8.self)
                let parts = text.components(separatedBy: "{\"n\":")
                var i = parts.count - 1
                while i >= 1 {
                    let digits = parts[i].prefix { $0 >= "0" && $0 <= "9" }
                    if let n = Int(digits) {
                        if n > best { best = n }
                        break
                    }
                    i -= 1
                }
            }
        }
        return best + 1
    }

    private func openNewSegment() {
        closeSegment()
        guard let d = dir else { return }
        let lastIndex = segments().last.flatMap { Int($0.lastPathComponent.prefix(6)) } ?? 0
        let name = String(format: "%06d.jsonl", lastIndex + 1)
        let url = d.appendingPathComponent(name, isDirectory: false)
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            _ = fm.createFile(atPath: url.path, contents: nil, attributes: nil)
        }
        guard let h = try? FileHandle(forWritingTo: url) else { return }
        _ = try? h.seekToEnd()
        handle = h
        currentName = name
        currentSize = DebugLogWriter.size(of: url)
        writeRaw(headerLine(name))
    }

    private func closeSegment() {
        writePending()
        if let h = handle {
            try? h.synchronize()
            try? h.close()
        }
        handle = nil
        currentName = nil
    }

    private func writePending() {
        guard !pending.isEmpty else { return }
        if let h = handle {
            do {
                try h.write(contentsOf: pending)
            } catch {
                // disk full or file gone: the lines are lost
            }
        }
        pending.removeAll(keepingCapacity: true)
    }

    private func upMs() -> Int {
        Int((ProcessInfo.processInfo.systemUptime - startUptime) * 1000)
    }

    private static func machine() -> String {
        var sysinfo = utsname()
        uname(&sysinfo)
        let mirror = Mirror(reflecting: sysinfo.machine)
        var s = ""
        for child in mirror.children {
            guard let v = child.value as? Int8, v != 0 else { break }
            s.append(Character(UnicodeScalar(UInt8(bitPattern: v))))
        }
        return s
    }

    private func headerLine(_ segment: String) -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        let os = ProcessInfo.processInfo.operatingSystemVersion
        var f: [String: Any] = [
            "install": installId,
            "segment": segment,
            "appId": Bundle.main.bundleIdentifier ?? "",
            "appVersion": info["CFBundleShortVersionString"] as? String ?? "",
            "versionCode": info["CFBundleVersion"] as? String ?? "",
            "device": "Apple " + DebugLogWriter.machine(),
            "ios": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            "tz": TimeZone.current.identifier,
            "tzOffsetMin": TimeZone.current.secondsFromGMT() / 60,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
        ]
        // No build-time constants on iOS: the commit is in `web.buildId`
        // (VITE_APP_BUILD_ID); the build time is the executable's date.
        if let exe = Bundle.main.executableURL,
           let attrs = try? FileManager.default.attributesOfItem(atPath: exe.path),
           let date = attrs[.modificationDate] as? Date {
            f["buildTime"] = Int(date.timeIntervalSince1970 * 1000)
        }
        if let web = webInfo { f["web"] = web }
        return line("native", "header", "info", f, nil)
    }

    /// Writes one line without its `n`; adds the number. Queue only.
    private func writeRaw(_ lineNoN: String) {
        guard handle != nil else { return }
        let trimmed = lineNoN.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }
        let n = nextN
        nextN += 1
        let numbered: String
        if trimmed == "{}" {
            numbered = "{\"n\":\(n)}"
        } else if trimmed.hasPrefix("{") {
            numbered = "{\"n\":\(n)," + String(trimmed.dropFirst())
        } else {
            numbered = "{\"n\":\(n),\"src\":\"native\",\"ev\":\"raw\",\"f\":\(DebugLogWriter.quote(trimmed))}"
        }
        let bytes = Data((numbered + "\n").utf8)
        pending.append(bytes)
        currentSize += bytes.count
        if pending.count >= DebugLogWriter.bufferMax { writePending() }
        if currentSize >= DebugLogWriter.segmentMax {
            UserDefaults.standard.set(nextN - 1, forKey: DebugLogWriter.lastNKey)
            closeSegment()
            enforceCap()
            openNewSegment()
        }
    }

    private func scheduleFlush() {
        if flushScheduled { return }
        flushScheduled = true
        queue.asyncAfter(deadline: .now() + .milliseconds(250)) { [self] in
            flushScheduled = false
            writePending()
        }
    }

    /// Writes now and, when `sync`, to the disk itself. Queue only.
    func flushNow(_ sync: Bool) {
        writePending()
        if sync, let h = handle { try? h.synchronize() }
        UserDefaults.standard.set(nextN - 1, forKey: DebugLogWriter.lastNKey)
    }

    private func lowSpace() -> Bool {
        guard let d = dir else { return false }
        // a fresh URL: resource values are cached per URL value
        let fresh = URL(fileURLWithPath: d.path, isDirectory: true)
        guard let values = try? fresh.resourceValues(forKeys: [.volumeAvailableCapacityKey]),
              let free = values.volumeAvailableCapacity
        else { return false }
        return free < DebugLogWriter.minFree
    }

    private func enforceCap() {
        var segs = segments()
        var total = segs.reduce(0) { $0 + DebugLogWriter.size(of: $1) }
        while (total > cap || lowSpace()) && segs.count > 1 {
            let oldest = segs.removeFirst()
            if oldest.lastPathComponent == currentName { break }
            total -= DebugLogWriter.size(of: oldest)
            try? FileManager.default.removeItem(at: oldest)
        }
    }

    // MARK: - lines

    /// A JSON string literal for `s`.
    static func quote(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: []) else {
            return "\"\""
        }
        let text = String(decoding: data, as: UTF8.self)
        // "[...]" -> "..."
        return String(text.dropFirst().dropLast())
    }

    /// Values JSONSerialization accepts; anything else becomes its description.
    static func sanitize(_ value: Any) -> Any {
        if let s = value as? String { return s }
        if value is NSNull { return value }
        if let d = value as? Data { return d.base64EncodedString() }
        if let n = value as? NSNumber {
            return n.doubleValue.isFinite ? n : String(describing: n)
        }
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict { out[k] = sanitize(v) }
            return out
        }
        if let arr = value as? [Any] { return arr.map { sanitize($0) } }
        return String(describing: value)
    }

    /// One line without `n`.
    func line(_ src: String, _ ev: String, _ lvl: String, _ f: [String: Any], _ dur: Int?) -> String {
        var o: [String: Any] = [
            "t": Int(Date().timeIntervalSince1970 * 1000),
            "up": upMs(),
            "src": src,
            "ev": ev,
            "lvl": lvl,
            "f": DebugLogWriter.sanitize(f),
        ]
        if let dur = dur { o["dur"] = dur }
        if JSONSerialization.isValidJSONObject(o),
           let data = try? JSONSerialization.data(withJSONObject: o, options: []) {
            return String(decoding: data, as: UTF8.self)
        }
        return "{\"src\":\"native\",\"ev\":\"line.unserializable\",\"lvl\":\"warn\",\"f\":{\"ev\":\(DebugLogWriter.quote(ev))}}"
    }

    static func errorFields(_ error: Error) -> [String: Any] {
        let ns = error as NSError
        return [
            "name": String(describing: type(of: error)),
            "domain": ns.domain,
            "code": ns.code,
            "message": String(describing: error),
        ]
    }

    // MARK: - public API, any thread

    /// Lines joined by `\n`, each a JSON object without `n`.
    func append(_ lines: String, urgent: Bool) {
        queue.async { [self] in
            for l in lines.split(separator: "\n", omittingEmptySubsequences: true) {
                writeRaw(String(l))
            }
            if urgent { flushNow(true) } else { scheduleFlush() }
        }
    }

    func appendLine(_ lineNoN: String, urgent: Bool) {
        queue.async { [self] in
            writeRaw(lineNoN)
            if urgent { flushNow(true) } else { scheduleFlush() }
        }
    }

    /// For a crash: write and sync before the process dies.
    func appendLineAndWait(_ lineNoN: String, timeout: TimeInterval) {
        _ = call(timeout) { [self] in
            writeRaw(lineNoN)
            flushNow(true)
            return true
        }
    }

    func native(_ lvl: String, _ tag: String, _ msg: String, _ error: Error?) {
        var f: [String: Any] = ["tag": tag, "msg": msg]
        if let error = error { f["err"] = DebugLogWriter.errorFields(error) }
        appendLine(line("native", "log", lvl, f, nil), urgent: lvl == "error")
    }

    func event(_ ev: String, lvl: String, f: [String: Any], dur: Int?) {
        appendLine(line("native", ev, lvl, f, dur), urgent: lvl == "error")
    }

    func addError(_ text: String) {
        errorsLock.lock()
        errors.append(text)
        errorsLock.unlock()
    }

    func takeErrors() -> [String] {
        errorsLock.lock()
        let out = errors
        errors.removeAll()
        errorsLock.unlock()
        return out
    }

    func flushAsync(sync: Bool) {
        queue.async { [self] in flushNow(sync) }
    }

    func setCap(_ bytes: Int) {
        queue.async { [self] in
            cap = max(DebugLogWriter.minCap, bytes)
            UserDefaults.standard.set(cap, forKey: DebugLogWriter.capKey)
            enforceCap()
        }
    }

    func setWebInfo(_ info: [String: Any]) {
        queue.async { [self] in
            let clean = DebugLogWriter.sanitize(info) as? [String: Any] ?? [:]
            webInfo = clean
            writeRaw(line("native", "app.web_info", "info", clean, nil))
            scheduleFlush()
        }
    }

    func clear() {
        _ = call(10) { [self] in
            closeSegment()
            for s in segments() { try? FileManager.default.removeItem(at: s) }
            openNewSegment()
            return true
        }
    }

    struct Stats {
        let bytes: Int
        let segments: Int
        let firstLine: Int
        let lastLine: Int
        let cap: Int
    }

    func stats() -> Stats? {
        return call(10) { [self] () -> Stats in
            flushNow(false)
            let segs = segments()
            var first = 0
            if let f = segs.first, let h = try? FileHandle(forReadingFrom: f) {
                if let data = try? h.read(upToCount: 64), let n = DebugLogWriter.nPrefix(String(decoding: data, as: UTF8.self)) {
                    first = n
                }
                try? h.close()
            }
            let bytes = segs.reduce(0) { $0 + DebugLogWriter.size(of: $1) }
            return Stats(bytes: bytes, segments: segs.count, firstLine: first, lastLine: nextN - 1, cap: cap)
        }
    }

    /// Flushes, then lists the segments with their current length.
    func snapshot() -> [(URL, Int)]? {
        return call(10) { [self] () -> [(URL, Int)] in
            flushNow(true)
            return segments().map { ($0, DebugLogWriter.size(of: $0)) }
        }
    }

    func segmentURL(_ name: String) -> URL? {
        guard DebugLogWriter.isSegmentName(name) else { return nil }
        return call(5) { [self] () -> URL? in
            dir?.appendingPathComponent(name, isDirectory: false)
        } ?? nil
    }

    static func nPrefix(_ line: String) -> Int? {
        let prefix = "{\"n\":"
        guard line.hasPrefix(prefix) else { return nil }
        let digits = line.dropFirst(prefix.count).prefix { $0 >= "0" && $0 <= "9" }
        return Int(digits)
    }
}

/// Entry point of the full debug build, called by `AppDelegate`. Starts the
/// record, records uncaught Objective-C exceptions, whether the previous run
/// ended cleanly, and the app's life (foreground, background, memory).
enum FullDebug {
    private static var installed = false
    private static var previousHandler: (@convention(c) (NSException) -> Void)?
    private static var observers: [NSObjectProtocol] = []

    /// Set while the app runs in the foreground; cleared when it goes to the
    /// background or terminates. Found at start: the previous run ended
    /// while in the foreground without a clean exit (crash, watchdog, kill).
    private static func markerURL() -> URL? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        else { return nil }
        return base.appendingPathComponent("debug-logs-running.marker", isDirectory: false)
    }

    private static func setMarker(_ on: Bool) {
        guard let url = markerURL() else { return }
        if on {
            _ = FileManager.default.createFile(atPath: url.path, contents: Data("1".utf8), attributes: nil)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Main thread, from `application(_:didFinishLaunchingWithOptions:)`.
    static func install(launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
        if installed { return }
        installed = true
        let writer = DebugLogWriter.shared
        writer.start()
        captureStderr()

        previousHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exception in
            FullDebug.recordUncaught(exception)
        }

        let wasRunning = markerURL().map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        setMarker(true)

        var launch: [String] = []
        if let options = launchOptions {
            for key in options.keys { launch.append(key.rawValue) }
        }
        writer.event("app.start", lvl: "info", f: [
            "launchOptions": launch,
            "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "thermal": ProcessInfo.processInfo.thermalState.rawValue,
        ], dur: nil)
        writer.event(
            "app.previous_run", lvl: wasRunning ? "error" : "info",
            f: ["clean": !wasRunning], dur: nil)
        FullDebug.logPermissions("start")
        if wasRunning {
            writer.addError("Previous run ended without a clean exit (crash, watchdog or kill in the foreground)")
        }

        let center = NotificationCenter.default
        func observe(_ name: Notification.Name, _ body: @escaping () -> Void) {
            FullDebug.observers.append(center.addObserver(forName: name, object: nil, queue: nil) { _ in body() })
        }
        observe(UIApplication.didEnterBackgroundNotification) {
            writer.event("app.background", lvl: "info", f: [:], dur: nil)
            writer.flushAsync(sync: true)
            FullDebug.setMarker(false)
        }
        observe(UIApplication.willEnterForegroundNotification) {
            FullDebug.setMarker(true)
            writer.event("app.foreground", lvl: "info", f: [:], dur: nil)
            FullDebug.logPermissions("foreground")
        }
        observe(UIApplication.didBecomeActiveNotification) {
            writer.event("app.active", lvl: "debug", f: [:], dur: nil)
        }
        observe(UIApplication.willResignActiveNotification) {
            writer.event("app.inactive", lvl: "debug", f: [:], dur: nil)
        }
        observe(UIApplication.willTerminateNotification) {
            writer.appendLineAndWait(writer.line("native", "app.terminate", "info", [:], nil), timeout: 1)
            FullDebug.setMarker(false)
        }
        observe(UIApplication.didReceiveMemoryWarningNotification) {
            writer.event("app.memory_warning", lvl: "warn", f: [:], dur: nil)
        }
        observe(UIApplication.protectedDataWillBecomeUnavailableNotification) {
            writer.event("app.protected_data", lvl: "info", f: ["available": false], dur: nil)
            writer.flushAsync(sync: true)
        }
        observe(UIApplication.protectedDataDidBecomeAvailableNotification) {
            writer.event("app.protected_data", lvl: "info", f: ["available": true], dur: nil)
        }
        observe(Notification.Name.NSProcessInfoPowerStateDidChange) {
            writer.event("app.low_power", lvl: "info", f: ["on": ProcessInfo.processInfo.isLowPowerModeEnabled], dur: nil)
        }
        observe(ProcessInfo.thermalStateDidChangeNotification) {
            writer.event("app.thermal", lvl: "info", f: ["state": ProcessInfo.processInfo.thermalState.rawValue], dur: nil)
        }
    }

    /// One `permission.state` line: Bluetooth, camera, notifications,
    /// background refresh, low-power mode. Local network: iOS has no API to
    /// read it, so "unknown". The notification settings arrive
    /// asynchronously, so the line is written from their callback.
    static func logPermissions(_ trigger: String) {
        var base: [String: Any] = [
            "trigger": trigger,
            "bluetooth": bluetoothName(CBManager.authorization),
            "camera": cameraName(AVCaptureDevice.authorizationStatus(for: .video)),
            "localNetwork": "unknown",
            "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
        ]
        DispatchQueue.main.async {
            base["backgroundRefresh"] = FullDebug.refreshName(UIApplication.shared.backgroundRefreshStatus)
            let snapshot = base
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                var f = snapshot
                f["notifications"] = FullDebug.notificationName(settings.authorizationStatus)
                DebugLogWriter.shared.event("permission.state", lvl: "info", f: f, dur: nil)
            }
        }
    }

    static func bluetoothName(_ a: CBManagerAuthorization) -> String {
        switch a {
        case .allowedAlways: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    static func cameraName(_ a: AVAuthorizationStatus) -> String {
        switch a {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private static func refreshName(_ s: UIBackgroundRefreshStatus) -> String {
        switch s {
        case .available: return "available"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
    }

    private static func notificationName(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }

    /// The mesh library (gossip-mobile built with the cargo feature
    /// `full-debug`) writes one JSON line per tracing event to stderr,
    /// prefixed `GossipMesh `. stderr is turned into a pipe read by one
    /// thread: mesh lines become `src:"mesh"` lines of the record, any other
    /// line a `native` `stderr` line; everything is copied on to the original
    /// stderr (the Xcode console).
    private static func captureStderr() {
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else { return }
        let original = dup(STDERR_FILENO)
        if dup2(fds[1], STDERR_FILENO) < 0 {
            close(fds[0])
            close(fds[1])
            if original >= 0 { close(original) }
            return
        }
        close(fds[1])
        let readFd = fds[0]
        let thread = Thread {
            let size = 16 * 1024
            var buffer = [UInt8](repeating: 0, count: size)
            var carry = Data()
            while true {
                let n = read(readFd, &buffer, size)
                if n <= 0 { break }
                if original >= 0 { _ = write(original, buffer, n) }
                carry.append(contentsOf: buffer[0..<n])
                while let idx = carry.firstIndex(of: 0x0A) {
                    let lineData = carry.subdata(in: carry.startIndex..<idx)
                    carry.removeSubrange(carry.startIndex...idx)
                    FullDebug.recordStderrLine(String(decoding: lineData, as: UTF8.self))
                }
                if carry.count > 64 * 1024 {
                    FullDebug.recordStderrLine(String(decoding: carry, as: UTF8.self))
                    carry.removeAll()
                }
            }
        }
        thread.name = "gossip-debug-stderr"
        thread.start()
    }

    private static let meshPrefix = "GossipMesh "

    private static func recordStderrLine(_ text: String) {
        let writer = DebugLogWriter.shared
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty { return }
        if line.hasPrefix(meshPrefix) {
            let payload = String(line.dropFirst(meshPrefix.count))
            if let obj = try? JSONSerialization.jsonObject(with: Data(payload.utf8), options: []),
               let o = obj as? [String: Any] {
                var f: [String: Any] = [:]
                f["target"] = o["target"] ?? ""
                f["msg"] = o["msg"] ?? ""
                if let fields = o["f"] { f["f"] = fields }
                if let t = o["t"] { f["meshT"] = t }
                let lvl = (o["lvl"] as? String) ?? "debug"
                writer.appendLine(writer.line("mesh", "mesh.log", lvl, f, nil), urgent: lvl == "error")
            } else {
                writer.appendLine(writer.line("mesh", "mesh.log", "debug", ["raw": payload], nil), urgent: false)
            }
            return
        }
        writer.appendLine(writer.line("native", "stderr", "debug", ["text": line], nil), urgent: false)
    }

    private static func recordUncaught(_ exception: NSException) {
        let writer = DebugLogWriter.shared
        let f: [String: Any] = [
            "name": exception.name.rawValue,
            "reason": exception.reason ?? "",
            "stack": exception.callStackSymbols.joined(separator: "\n"),
            "thread": Thread.isMainThread ? "main" : (Thread.current.name ?? ""),
        ]
        writer.appendLineAndWait(writer.line("native", "crash.uncaught", "error", f, nil), timeout: 1.5)
        setMarker(false)
        previousHandler?(exception)
    }
}
#endif
