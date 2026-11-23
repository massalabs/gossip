#if FULL_DEBUG
import Capacitor
import Compression
import CryptoKit
import Foundation

/// JS access to the record of the full debug build (registered only in that
/// build), as `DebugLogFilePlugin.kt` on Android: same plugin name, methods,
/// parameters and results (`src/fullDebug/writers.ts`). See
/// `DebugLogWriter.swift` for the files.
@objc(DebugLogFilePlugin)
public class DebugLogFilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DebugLogFilePlugin"
    public let jsName = "DebugLogFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stats", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSegments", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSegment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWebInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeNativeErrors", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareUpload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readPiece", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardUpload", returnType: CAPPluginReturnPromise),
    ]

    static let pieceSize = 512 * 1024

    /// Upload preparation and piece reads: off the writer queue.
    private let worker = DispatchQueue(label: "net.massa.gossip.debug-upload", qos: .utility)

    override public func load() {
        DebugLogWriter.shared.start()
    }

    private func fail(_ call: CAPPluginCall, _ error: Error) {
        call.reject(String(describing: type(of: error)) + ": " + String(describing: error))
    }

    private struct PluginError: Error, CustomStringConvertible {
        let description: String
    }

    @objc func append(_ call: CAPPluginCall) {
        let lines = call.getString("lines") ?? ""
        DebugLogWriter.shared.append(lines, urgent: call.getBool("urgent") ?? false)
        call.resolve()
    }

    @objc func flush(_ call: CAPPluginCall) {
        worker.async {
            _ = DebugLogWriter.shared.call(5) { () -> Bool in
                DebugLogWriter.shared.flushNow(true)
                return true
            }
            call.resolve()
        }
    }

    @objc func stats(_ call: CAPPluginCall) {
        worker.async {
            let s = DebugLogWriter.shared.stats()
            call.resolve([
                "installId": DebugLogWriter.shared.installId,
                "bytes": s?.bytes ?? 0,
                "segments": s?.segments ?? 0,
                "firstLine": s?.firstLine ?? 0,
                "lastLine": s?.lastLine ?? 0,
                "cap": s?.cap ?? DebugLogWriter.defaultCap,
            ])
        }
    }

    @objc func listSegments(_ call: CAPPluginCall) {
        worker.async {
            var arr: [[String: Any]] = []
            for (url, len) in DebugLogWriter.shared.snapshot() ?? [] {
                arr.append(["name": url.lastPathComponent, "size": len])
            }
            call.resolve(["segments": arr])
        }
    }

    @objc func readSegment(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        let offset = Int(call.getDouble("offset") ?? 0)
        let length = min(Int(call.getDouble("length") ?? Double(DebugLogFilePlugin.pieceSize)), 4 * 1024 * 1024)
        worker.async {
            guard let url = DebugLogWriter.shared.segmentURL(name) else {
                call.reject("IllegalArgumentException: bad segment name")
                return
            }
            do {
                let data = try DebugLogFilePlugin.readRange(url, offset: offset, length: length)
                call.resolve([
                    "data": data.base64EncodedString(),
                    "size": DebugLogWriter.size(of: url),
                ])
            } catch {
                self.fail(call, error)
            }
        }
    }

    @objc func setCap(_ call: CAPPluginCall) {
        let bytes = Int(call.getDouble("bytes") ?? Double(DebugLogWriter.defaultCap))
        DebugLogWriter.shared.setCap(bytes)
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        worker.async {
            DebugLogWriter.shared.clear()
            call.resolve()
        }
    }

    @objc func setWebInfo(_ call: CAPPluginCall) {
        var info: [String: Any] = [:]
        for (key, value) in call.jsObjectRepresentation {
            info[key] = value
        }
        DebugLogWriter.shared.setWebInfo(info)
        call.resolve()
    }

    @objc func takeNativeErrors(_ call: CAPPluginCall) {
        call.resolve(["errors": DebugLogWriter.shared.takeErrors()])
    }

    // MARK: - upload: gzip + cut natively, so that 1 GiB never sits in memory

    private static func uploadFile() -> URL? {
        guard let caches = try? FileManager.default.url(
            for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        else { return nil }
        let d = caches.appendingPathComponent("debug-upload", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: nil)
        return d.appendingPathComponent("upload.gz", isDirectory: false)
    }

    /// Writes one gzip stream of the record (lines numbered `fromLine` and
    /// after; every segment keeps its header line) into the caches, removing
    /// `f.c` and `f.s` from every line when `strip`. Returns its size, piece
    /// count and SHA-256.
    @objc func prepareUpload(_ call: CAPPluginCall) {
        let strip = call.getBool("strip") ?? false
        let fromLine = Int(call.getDouble("fromLine") ?? 0)
        worker.async {
            do {
                let result = try DebugLogFilePlugin.prepare(strip: strip, fromLine: fromLine)
                call.resolve(result)
            } catch {
                self.fail(call, error)
            }
        }
    }

    private static func prepare(strip: Bool, fromLine: Int) throws -> [String: Any] {
        guard let segs = DebugLogWriter.shared.snapshot() else {
            throw PluginError(description: "record not ready")
        }
        guard let target = uploadFile() else { throw PluginError(description: "no cache directory") }
        try? FileManager.default.removeItem(at: target)
        guard FileManager.default.createFile(atPath: target.path, contents: nil, attributes: nil) else {
            throw PluginError(description: "cannot create the upload file")
        }
        let gz = try GzipFileWriter(url: target)
        var firstN = -1
        var lastN = -1
        var rawBytes = 0
        var lines = 0

        func emit(_ line: String) throws {
            let data = Data((line + "\n").utf8)
            try gz.write(data)
            rawBytes += data.count
            lines += 1
        }
        func note(_ n: Int?) {
            guard let n = n else { return }
            if firstN < 0 { firstN = n }
            lastN = max(lastN, n)
        }

        do {
            for (url, length) in segs {
                guard let h = try? FileHandle(forReadingFrom: url) else { continue }
                let data = (try? h.read(upToCount: length)) ?? nil
                try? h.close()
                guard let content = data else { continue }
                var header: String?
                var headerWritten = false
                var first = true
                let text = String(decoding: content, as: UTF8.self)
                for sub in text.split(separator: "\n", omittingEmptySubsequences: true) {
                    let line = String(sub)
                    let n = DebugLogWriter.nPrefix(line)
                    if first {
                        first = false
                        if line.contains("\"ev\":\"header\"") {
                            header = line
                            if n == nil || n! >= fromLine {
                                try emit(line)
                                headerWritten = true
                                note(n)
                            }
                            continue
                        }
                    }
                    if let n = n, n < fromLine { continue }
                    if !headerWritten, let hdr = header {
                        try emit(hdr)
                        headerWritten = true
                    }
                    try emit(strip ? stripLine(line) : line)
                    note(n)
                }
            }
            let sha = try gz.finish()
            let size = DebugLogWriter.size(of: target)
            return [
                "size": size,
                "pieces": (size + pieceSize - 1) / pieceSize,
                "pieceSize": pieceSize,
                "sha256": sha,
                "fromLine": firstN < 0 ? 0 : firstN,
                "toLine": lastN < 0 ? 0 : lastN,
                "rawBytes": rawBytes,
                "lines": lines,
            ]
        } catch {
            gz.abandon()
            throw error
        }
    }

    @objc func readPiece(_ call: CAPPluginCall) {
        let n = call.getInt("n") ?? Int(call.getDouble("n") ?? 0)
        worker.async {
            guard let url = DebugLogFilePlugin.uploadFile() else {
                call.reject("IllegalStateException: no upload prepared")
                return
            }
            do {
                let data = try DebugLogFilePlugin.readRange(
                    url, offset: n * DebugLogFilePlugin.pieceSize, length: DebugLogFilePlugin.pieceSize)
                call.resolve(["data": data.base64EncodedString()])
            } catch {
                self.fail(call, error)
            }
        }
    }

    @objc func discardUpload(_ call: CAPPluginCall) {
        worker.async {
            if let url = DebugLogFilePlugin.uploadFile() {
                try? FileManager.default.removeItem(at: url)
            }
            call.resolve()
        }
    }

    /// Removes `f.c` and `f.s` (content and secrets); a line that does not parse is kept as is.
    private static func stripLine(_ line: String) -> String {
        if !line.contains("\"c\":") && !line.contains("\"s\":") { return line }
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8), options: []),
              var o = obj as? [String: Any],
              var f = o["f"] as? [String: Any]
        else { return line }
        if f["c"] == nil && f["s"] == nil { return line }
        f.removeValue(forKey: "c")
        f.removeValue(forKey: "s")
        o["f"] = f
        guard JSONSerialization.isValidJSONObject(o),
              let data = try? JSONSerialization.data(withJSONObject: o, options: [])
        else { return line }
        return String(decoding: data, as: UTF8.self)
    }

    private static func readRange(_ url: URL, offset: Int, length: Int) throws -> Data {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        let len = DebugLogWriter.size(of: url)
        if offset >= len || length <= 0 { return Data() }
        try h.seek(toOffset: UInt64(offset))
        return try h.read(upToCount: min(length, len - offset)) ?? Data()
    }
}

/// One gzip member (RFC 1952) written to a file as it is produced: header,
/// raw DEFLATE from the Compression framework (`COMPRESSION_ZLIB` is raw
/// DEFLATE, RFC 1951, without the zlib wrapper), then CRC-32 and size. The
/// SHA-256 is of the gzip bytes, as they are written.
private final class GzipFileWriter {
    private let handle: FileHandle
    private let stream: UnsafeMutablePointer<compression_stream>
    private let outSize = 256 * 1024
    private let outBuffer: UnsafeMutablePointer<UInt8>
    private var hasher = SHA256()
    private var crc: UInt32 = 0
    private var isize: UInt32 = 0
    private var closed = false

    private struct GzipError: Error, CustomStringConvertible {
        let description: String
    }

    init(url: URL) throws {
        handle = try FileHandle(forWritingTo: url)
        stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        outBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: outSize)
        if compression_stream_init(stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB) != COMPRESSION_STATUS_OK {
            // deinit must not release a second time
            closed = true
            stream.deallocate()
            outBuffer.deallocate()
            try? handle.close()
            throw GzipError(description: "compression_stream_init failed")
        }
        // ID1 ID2 CM=deflate FLG=0 MTIME=0 XFL=0 OS=unix
        try output(Data([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03]))
    }

    deinit {
        if !closed { release() }
    }

    private func release() {
        closed = true
        compression_stream_destroy(stream)
        stream.deallocate()
        outBuffer.deallocate()
        try? handle.close()
    }

    private func output(_ data: Data) throws {
        hasher.update(data: data)
        try handle.write(contentsOf: data)
    }

    func write(_ data: Data) throws {
        if data.isEmpty { return }
        crc = Crc32.update(crc, data)
        isize = isize &+ UInt32(truncatingIfNeeded: data.count)
        try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            stream.pointee.src_ptr = base
            stream.pointee.src_size = raw.count
            repeat {
                stream.pointee.dst_ptr = outBuffer
                stream.pointee.dst_size = outSize
                let status = compression_stream_process(stream, 0)
                if status == COMPRESSION_STATUS_ERROR {
                    throw GzipError(description: "compression_stream_process failed")
                }
                let produced = outSize - stream.pointee.dst_size
                if produced > 0 { try output(Data(bytes: outBuffer, count: produced)) }
            } while stream.pointee.src_size > 0 || stream.pointee.dst_size == 0
        }
    }

    /// Ends the stream and returns the SHA-256 (hex) of the whole file.
    func finish() throws -> String {
        var status: compression_status
        repeat {
            stream.pointee.src_size = 0
            stream.pointee.dst_ptr = outBuffer
            stream.pointee.dst_size = outSize
            status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
            if status == COMPRESSION_STATUS_ERROR {
                throw GzipError(description: "compression_stream_process (finalize) failed")
            }
            let produced = outSize - stream.pointee.dst_size
            if produced > 0 { try output(Data(bytes: outBuffer, count: produced)) }
        } while status != COMPRESSION_STATUS_END
        var trailer = Data()
        for v in [crc, isize] {
            trailer.append(UInt8(truncatingIfNeeded: v))
            trailer.append(UInt8(truncatingIfNeeded: v >> 8))
            trailer.append(UInt8(truncatingIfNeeded: v >> 16))
            trailer.append(UInt8(truncatingIfNeeded: v >> 24))
        }
        try output(trailer)
        try handle.synchronize()
        let digest = hasher.finalize()
        release()
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    func abandon() {
        if !closed { release() }
    }
}

private enum Crc32 {
    static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 {
            c = (c & 1) != 0 ? (0xEDB8_8320 ^ (c >> 1)) : (c >> 1)
        }
        return c
    }

    static func update(_ crc: UInt32, _ data: Data) -> UInt32 {
        var c = ~crc
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for b in raw {
                c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8)
            }
        }
        return ~c
    }
}
#endif
