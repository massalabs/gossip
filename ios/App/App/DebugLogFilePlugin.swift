#if FULL_DEBUG
import Capacitor
import Compression
import CryptoKit
import Foundation
import Security

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
        // The GDL1 test vectors on this device, recorded as `enc.selftest`:
        // field evidence that what this phone sends can be decrypted.
        worker.async {
            let start = Date()
            let problem = Gdl1.selfTest()
            var f: [String: Any] = ["ok": problem == nil, "format": Gdl1.enc]
            if let problem = problem { f["error"] = problem }
            DebugLogWriter.shared.event(
                "enc.selftest", lvl: problem == nil ? "info" : "error", f: f,
                dur: Int(Date().timeIntervalSince(start) * 1000))
        }
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

    // MARK: - upload: gzip + encrypt + cut natively, so that 1 GiB never sits in memory

    private static func uploadDir() -> URL? {
        guard let caches = try? FileManager.default.url(
            for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        else { return nil }
        let d = caches.appendingPathComponent("debug-upload", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: nil)
        return d
    }

    private static func uploadFile() -> URL? {
        uploadDir()?.appendingPathComponent("upload.gdl1", isDirectory: false)
    }

    /// The unencrypted file of an older version of this build: removed.
    private static func removeLegacyUpload() {
        if let d = uploadDir() {
            try? FileManager.default.removeItem(at: d.appendingPathComponent("upload.gz", isDirectory: false))
        }
    }

    /// Writes one gzip stream of the record (lines numbered `fromLine` and
    /// after; every segment keeps its header line), encrypted (GDL1, see
    /// `Gdl1` below) to `recipientKey` (base64 DER of the developers' public
    /// key), into the caches, removing `f.c` and `f.s` from every line when
    /// `strip` (before compression). The plaintext never reaches the disk.
    /// Returns the encrypted file's size, piece count and SHA-256, and the
    /// gzip stream's size and SHA-256. Without a valid key nothing is written.
    @objc func prepareUpload(_ call: CAPPluginCall) {
        let strip = call.getBool("strip") ?? false
        let fromLine = Int(call.getDouble("fromLine") ?? 0)
        let recipientKey = call.getString("recipientKey")
        worker.async {
            do {
                guard let recipientKey = recipientKey else {
                    throw PluginError(description: "no key to encrypt the logs: nothing is sent unencrypted")
                }
                let recipient = try Gdl1.recipient(base64: recipientKey)
                let result = try DebugLogFilePlugin.prepare(strip: strip, fromLine: fromLine, recipient: recipient)
                call.resolve(result)
            } catch {
                self.fail(call, error)
            }
        }
    }

    private static func prepare(strip: Bool, fromLine: Int, recipient: Gdl1.Recipient) throws -> [String: Any] {
        guard let segs = DebugLogWriter.shared.snapshot() else {
            throw PluginError(description: "record not ready")
        }
        guard let target = uploadFile() else { throw PluginError(description: "no cache directory") }
        removeLegacyUpload()
        try? FileManager.default.removeItem(at: target)
        guard FileManager.default.createFile(atPath: target.path, contents: nil, attributes: nil) else {
            throw PluginError(description: "cannot create the upload file")
        }
        let handle = try FileHandle(forWritingTo: target)
        var complete = false
        defer {
            try? handle.close()
            if !complete { try? FileManager.default.removeItem(at: target) }
        }
        var cipherHasher = SHA256()
        let encrypted = try Gdl1Writer(recipient: recipient, test: nil) { data in
            cipherHasher.update(data: data)
            try handle.write(contentsOf: data)
        }
        let gz = try GzipFileWriter { data in try encrypted.write(data) }
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
            let plain = try gz.finish()
            try encrypted.finish()
            try handle.synchronize()
            let size = DebugLogWriter.size(of: target)
            complete = true
            return [
                "enc": Gdl1.enc,
                "size": size,
                "pieces": (size + pieceSize - 1) / pieceSize,
                "pieceSize": pieceSize,
                "sha256": Gdl1.hex(cipherHasher.finalize()),
                "plainSize": plain.size,
                "plainSha256": plain.sha256,
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
            DebugLogFilePlugin.removeLegacyUpload()
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

/// One gzip member (RFC 1952) handed to `sink` as it is produced: header,
/// raw DEFLATE from the Compression framework (`COMPRESSION_ZLIB` is raw
/// DEFLATE, RFC 1951, without the zlib wrapper), then CRC-32 and size. The
/// SHA-256 and size are of the gzip bytes, as they are produced.
private final class GzipFileWriter {
    private let sink: (Data) throws -> Void
    private var bytesOut = 0
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

    init(sink: @escaping (Data) throws -> Void) throws {
        self.sink = sink
        stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        outBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: outSize)
        if compression_stream_init(stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB) != COMPRESSION_STATUS_OK {
            // deinit must not release a second time
            closed = true
            stream.deallocate()
            outBuffer.deallocate()
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
    }

    private func output(_ data: Data) throws {
        hasher.update(data: data)
        bytesOut += data.count
        try sink(data)
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

    /// Ends the stream; returns the SHA-256 (hex) and size of the gzip bytes.
    func finish() throws -> (sha256: String, size: Int) {
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
        let digest = hasher.finalize()
        release()
        return (Gdl1.hex(digest), bytesOut)
    }

    func abandon() {
        if !closed { release() }
    }
}

/// GDL1: the encryption of what the full debug build sends, to the
/// developers' public key, so that the backend stores only ciphertext. Same
/// format as `Gdl1.kt` and `src/fullDebug/gdl1.ts`; the reference and the
/// decryption are `scripts/debug-logs-decrypt.mjs`, the shared vectors
/// `test/fixtures/gdl1/vectors.json` (run by `selfTest` at every start).
///
///   header  "GDL1" | ephemeral P-256 public key, uncompressed (65) | nonce prefix (4)
///   key     HKDF-SHA256(ikm = ECDH x coordinate,
///                       salt = ephemeral public (65) | recipient public (65),
///                       info = "gossip-debug-logs v1", 32 bytes)
///   chunks  65536-byte plaintext chunks (the last may be shorter, empty only
///           when the whole plaintext is), each u32 BE length | AES-256-GCM
///           ciphertext | 16-byte tag, nonce = prefix | u64 BE index,
///           AAD = 0x01 for the last chunk, 0x00 otherwise.
enum Gdl1 {
    static let enc = "GDL1"
    static let chunk = 65536
    static let headerSize = 4 + 65 + 4
    static let info = Data("gossip-debug-logs v1".utf8)

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// The developers' public key (base64 DER from the JS side).
    struct Recipient {
        let der: Data
        let key: P256.KeyAgreement.PublicKey
        /// 0x04 | X | Y
        var point: Data { key.x963Representation }
    }

    /// For the test vectors only: a given ephemeral scalar and nonce prefix.
    struct TestOverride {
        let d: Data
        let noncePrefix: Data
    }

    static func recipient(base64: String) throws -> Recipient {
        let cleaned = base64.filter { !$0.isWhitespace }
        guard let der = Data(base64Encoded: cleaned) else {
            throw Failure(description: "the key to encrypt the logs is not base64")
        }
        do {
            // Parses the SubjectPublicKeyInfo; refuses another curve.
            let key = try P256.KeyAgreement.PublicKey(derRepresentation: der)
            return Recipient(der: der, key: key)
        } catch {
            throw Failure(description: "the key to encrypt the logs is not a P-256 public key")
        }
    }

    static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func unhex(_ s: String) -> Data {
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16) ?? 0)
            i = j
        }
        return out
    }

    // MARK: self-check against test/fixtures/gdl1/vectors.json (TEST-ONLY key)

    private static let testRecipient =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzO6DCrZshIuSJZtrPLwMo1GyT4I9wjeNwu+xFkT5hCewuDGpHS55r+csLbBYg3X17Xt21umN8KcICmU4rOxWvg=="
    private static let testD = "16557eb229e3416543632cf48b0f8154bd2d2961029baf2f8aa192dad549cea9"
    private static let testHeader =
        "47444c31044fb11200caf95d55f6975c1de397b9a5468ad241f88cb545f267a3052137a64d5ce6091933fd5f5ae4eac875630e08fbde6a20258bbbb7dc27ab7dfdfb3fb2e29b5b8a83"
    private static let testPrefix = "9b5b8a83"
    private static let testCases: [(Int, String)] = [
        (0, "4e3afe052db0925cb166d400202cb1d1bab1ddbcc7c1a447b04975ee4a261e5d"),
        (1, "019795c84717f755076afb7e5741fe7ca2e1d8d555194e48664239fdea79583f"),
        (65535, "2f102ca9594569c5eee6f36759188c5b05141ec5d544e668bfa155b348ac768e"),
        (65536, "b980390e9f67817e48974bf6a889ecdb3036d46bb34e2aaeebcf0f78ad34a51e"),
        (65537, "fb1c071c6eab54d5af2a22300206093345ba346af43c97196268f3129b81c036"),
        (200000, "96dfc2cef7acc90a95570c266cc5c73d05b428943e602802eda307d0a59dbe11"),
    ]

    /// Byte i of a test plaintext: (i * 31 + 7) & 0xff.
    static func testPlaintext(_ size: Int) -> Data {
        Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
    }

    /// GDL1 of `plain`, written in blocks of growing size.
    static func encryptForTest(_ plain: Data, _ recipient: Recipient, _ test: TestOverride?) throws -> Data {
        var out = Data()
        let w = try Gdl1Writer(recipient: recipient, test: test) { out.append($0) }
        var i = 0
        var step = 1
        while i < plain.count {
            let k = min(step, plain.count - i)
            try w.write(plain.subdata(in: i..<(i + k)))
            i += k
            step = step * 3 + 5
        }
        try w.finish()
        return out
    }

    /// Runs the shared vectors on this device. Returns nil when every one
    /// matches, else what differs. Also makes one file with a fresh
    /// ephemeral key (the path a real send takes) and checks its shape.
    static func selfTest() -> String? {
        do {
            let r = try recipient(base64: testRecipient)
            let test = TestOverride(d: unhex(testD), noncePrefix: unhex(testPrefix))
            for (size, expected) in testCases {
                let ct = try encryptForTest(testPlaintext(size), r, test)
                if hex(ct.prefix(headerSize)) != testHeader { return "vector \(size): header \(hex(ct.prefix(headerSize)))" }
                let got = hex(SHA256.hash(data: ct))
                if got != expected { return "vector \(size): \(got)" }
            }
            let fresh = try encryptForTest(testPlaintext(10), r, nil)
            if fresh.count != headerSize + 4 + 10 + 16 || hex(fresh.prefix(5)) != "47444c3104" {
                return "fresh key: bad shape (\(fresh.count) bytes)"
            }
            return nil
        } catch {
            return "\(type(of: error)): \(error)"
        }
    }
}

/// Encrypts what is written to it (GDL1) and hands the bytes to `sink`,
/// holding at most one chunk; `finish` writes the last chunk. A fresh
/// ephemeral key and nonce prefix per instance (unless `test`); the
/// ephemeral private key stays inside `init`.
final class Gdl1Writer {
    private let sink: (Data) throws -> Void
    private let key: SymmetricKey
    private let prefix: Data
    private var buffer = Data()
    private var index: UInt64 = 0
    private var finished = false

    init(recipient: Gdl1.Recipient, test: Gdl1.TestOverride?, sink: @escaping (Data) throws -> Void) throws {
        self.sink = sink
        let ephemeral: P256.KeyAgreement.PrivateKey
        let noncePrefix: Data
        if let test = test {
            ephemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: test.d)
            noncePrefix = Data(test.noncePrefix)
        } else {
            ephemeral = P256.KeyAgreement.PrivateKey()
            var bytes = [UInt8](repeating: 0, count: 4)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                throw Gdl1.Failure(description: "no random bytes for the nonce prefix")
            }
            noncePrefix = Data(bytes)
        }
        prefix = noncePrefix
        let point = ephemeral.publicKey.x963Representation
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient.key)
        var salt = Data()
        salt.append(point)
        salt.append(recipient.point)
        // HKDF-SHA256 with ikm = the shared secret (the x coordinate).
        key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: salt, sharedInfo: Gdl1.info, outputByteCount: 32)
        var header = Data("GDL1".utf8)
        header.append(point)
        header.append(noncePrefix)
        buffer.reserveCapacity(Gdl1.chunk)
        try sink(header)
    }

    func write(_ data: Data) throws {
        var rest = Data(data)
        while !rest.isEmpty {
            // A full chunk is sealed only once more data follows, so that the
            // last chunk is known when it is sealed.
            if buffer.count == Gdl1.chunk { try emit(last: false) }
            let k = min(rest.count, Gdl1.chunk - buffer.count)
            buffer.append(rest.prefix(k))
            rest = Data(rest.dropFirst(k))
        }
    }

    func finish() throws {
        if finished { return }
        finished = true
        try emit(last: true)
        buffer = Data()
    }

    private func emit(last: Bool) throws {
        var nonceBytes = Data(prefix)
        withUnsafeBytes(of: index.bigEndian) { nonceBytes.append(contentsOf: $0) }
        let nonce = try AES.GCM.Nonce(data: nonceBytes)
        let box = try AES.GCM.seal(
            buffer, using: key, nonce: nonce, authenticating: Data([UInt8(last ? 1 : 0)]))
        let length = UInt32(box.ciphertext.count + box.tag.count)
        var record = Data(capacity: 4 + Int(length))
        withUnsafeBytes(of: length.bigEndian) { record.append(contentsOf: $0) }
        record.append(box.ciphertext)
        record.append(box.tag)
        try sink(record)
        index += 1
        buffer.removeAll(keepingCapacity: true)
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
