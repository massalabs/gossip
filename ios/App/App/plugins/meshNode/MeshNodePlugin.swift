import Capacitor
import CoreBluetooth
import Foundation

/// The MeshNode plugin: the `MeshNodePlugin` interface of the SDK
/// (gossip-sdk `api/messageProtocol/mesh.ts`) over `MeshNodeBridge`. Binary
/// values cross the bridge as standard base64.
///
/// The mesh state (on, configuration, power mode) is kept in UserDefaults so
/// that a background relaunch by CoreBluetooth state restoration brings the
/// node and radio back in `load()`, before any JS runs.
///
/// Events: `arrival` ({ messages: [{ seeker, ciphertext }], announcements })
/// and `status` ({ links }) when the number of radio links changes.
@objc(MeshNodePlugin)
public class MeshNodePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MeshNodePlugin"
    public let jsName = "MeshNode"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPowerMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendBlob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchBulletin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWanted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setUpstream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
    ]

    private static let enabledKey = "gossip.mesh.enabled"
    private static let configKey = "gossip.mesh.config"
    private static let powerModeKey = "gossip.mesh.powerMode"
    private static let defaultBulletinLimit = 100

    private let bridgeNode = MeshNodeBridge.shared

    override public func load() {
        bridgeNode.onArrival = { [weak self] messages, announcements in
            self?.notifyListeners("arrival", data: [
                "messages": messages.map {
                    ["seeker": $0.key.base64EncodedString(), "ciphertext": $0.value.base64EncodedString()]
                },
                "announcements": announcements.map { $0.base64EncodedString() },
            ])
        }
        bridgeNode.onLinksChanged = { [weak self] count in
            self?.notifyListeners("status", data: ["links": count])
        }
        // the switch holds the install id it was set on, so a phone restored
        // from a backup does not start the mesh before being asked again
        let defaults = UserDefaults.standard
        let installId = Self.installId()
        if !installId.isEmpty, defaults.string(forKey: Self.enabledKey) == installId {
            do {
                try bridgeNode.startCore(configJson: defaults.string(forKey: Self.configKey) ?? "{}")
                bridgeNode.startRadio(mode: MeshPowerMode(name: defaults.string(forKey: Self.powerModeKey)))
            } catch {
                CAPLog.print("[MeshNode] could not restore the mesh node: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Lifecycle

    @objc func start(_ call: CAPPluginCall) {
        if CBManager.authorization == .denied || CBManager.authorization == .restricted {
            call.reject("Bluetooth permission denied", "PERMISSION_DENIED")
            return
        }
        let config = Self.json(call.getObject("config")) ?? "{}"
        let mode = MeshPowerMode(name: call.getString("powerMode"))
        do {
            try bridgeNode.startCore(configJson: config)
        } catch {
            call.reject("Could not start the mesh node", "START_FAILED", error)
            return
        }
        let defaults = UserDefaults.standard
        defaults.set(Self.installId(), forKey: Self.enabledKey)
        defaults.set(config, forKey: Self.configKey)
        defaults.set(mode.rawValue, forKey: Self.powerModeKey)
        // Creating the managers shows the Bluetooth prompt the first time.
        bridgeNode.startRadio(mode: mode)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: Self.enabledKey)
        bridgeNode.stopRadio()
        bridgeNode.stopCore()
        call.resolve()
    }

    @objc func setPowerMode(_ call: CAPPluginCall) {
        let mode = MeshPowerMode(name: call.getString("powerMode"))
        UserDefaults.standard.set(mode.rawValue, forKey: Self.powerModeKey)
        bridgeNode.setPowerMode(mode)
        call.resolve()
    }

    // MARK: - Permissions

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["bluetooth": Self.permissionState()])
    }

    /// iOS shows its prompt when the radio first creates its managers, which `start` does;
    /// this reports the state without prompting.
    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        call.resolve(["bluetooth": Self.permissionState()])
    }

    /// Random id of this installation, in a file kept out of backups: the app
    /// ties consents (bridging) to it, so a phone restored from a backup asks again.
    static func installId() -> String {
        let fileManager = FileManager.default
        guard let directory = try? fileManager.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return "" }
        var file = directory.appendingPathComponent("mesh-install-id")
        if let id = try? String(contentsOf: file, encoding: .utf8), !id.isEmpty { return id }
        let id = UUID().uuidString
        do {
            try id.write(to: file, atomically: true, encoding: .utf8)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try file.setResourceValues(values)
        } catch {
            return ""
        }
        return id
    }

    private static func permissionState() -> String {
        switch CBManager.authorization {
        case .allowedAlways: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    // MARK: - Node API

    @objc func sendBlob(_ call: CAPPluginCall) {
        guard let kind = MeshBlobKind(rawValue: call.getString("kind") ?? ""),
              let payload = Self.decode(call.getString("payload")) else {
            call.reject("kind and payload are required", "INVALID_ARGUMENT")
            return
        }
        let key = Self.decode(call.getString("key"))
        if kind == .message && key == nil {
            call.reject("a message needs its seeker as key", "INVALID_ARGUMENT")
            return
        }
        reply(call, { core -> [String: Any] in
            let result = try core.sendBlob(kind: kind, key: key, payload: payload)
            var reply: [String: Any] = ["id": result.id.base64EncodedString()]
            if let counter = result.counter { reply["counter"] = counter }
            return reply
        })
    }

    @objc func fetch(_ call: CAPPluginCall) {
        guard let seekers = Self.decodeList(call.getArray("seekers")) else {
            call.reject("seekers must be base64 strings", "INVALID_ARGUMENT")
            return
        }
        reply(call, { core -> [String: Any] in
            let messages = try core.fetch(seekers: seekers).map {
                ["seeker": $0.key.base64EncodedString(), "ciphertext": $0.value.base64EncodedString()]
            }
            return ["messages": messages]
        })
    }

    @objc func fetchBulletin(_ call: CAPPluginCall) {
        let cursor = call.getString("cursor")
        let limit = call.getInt("limit") ?? Self.defaultBulletinLimit
        reply(call, { core -> [String: Any] in
            let items = try core.fetchBulletin(cursor: cursor, limit: limit).map {
                ["counter": $0.counter, "data": $0.data.base64EncodedString()]
            }
            return ["items": items]
        })
    }

    @objc func getKeys(_ call: CAPPluginCall) {
        guard let hash = Self.decode(call.getString("hash")) else {
            call.reject("hash is required", "INVALID_ARGUMENT")
            return
        }
        reply(call, { core -> [String: Any] in
            guard let keys = try core.getKeys(hash: hash) else { return [:] }
            return ["keys": keys.base64EncodedString()]
        })
    }

    @objc func setWanted(_ call: CAPPluginCall) {
        guard let seekers = Self.decodeList(call.getArray("seekers")) else {
            call.reject("seekers must be base64 strings", "INVALID_ARGUMENT")
            return
        }
        reply(call, { core -> [String: Any] in
            try core.setWanted(seekers: seekers)
            return [:]
        })
    }

    @objc func setUpstream(_ call: CAPPluginCall) {
        let urls = (call.getArray("urls") as? [String]) ?? []
        let bridgeEnabled = call.getBool("bridgeEnabled") ?? false
        reply(call, { core -> [String: Any] in
            try core.setUpstream(urls: urls, bridgeEnabled: bridgeEnabled)
            return [:]
        })
    }

    @objc func status(_ call: CAPPluginCall) {
        guard bridgeNode.isCoreRunning else {
            call.resolve([
                "running": false, "meshPeers": 0, "upstreamReachable": false,
                "bridgeEnabled": false, "bulletinCounter": "0", "storedBlobs": 0,
            ])
            return
        }
        reply(call, { core -> [String: Any] in
            let status = core.status()
            return [
                "running": status.running,
                "meshPeers": status.meshPeers,
                "upstreamReachable": status.upstreamReachable,
                "bridgeEnabled": status.bridgeEnabled,
                "bulletinCounter": status.bulletinCounter,
                "storedBlobs": status.storedBlobs,
                "linksHandshaking": status.linksHandshaking,
                "meshBlobs": status.meshBlobs,
                "uploadPending": status.uploadPending,
                "wantedEntries": status.wantedEntries,
                "clockOffsetMs": status.clockOffsetMs,
                "peerId": status.peerId,
                "radioLinks": MeshNodeBridge.shared.linkCount(),
                "rustCore": MeshCoreFactory.hasRustCore,
            ]
        })
    }

    /// What this build can do, before the node is started.
    @objc func capabilities(_ call: CAPPluginCall) {
        call.resolve(["rustCore": MeshCoreFactory.hasRustCore, "installId": Self.installId()])
    }

    @objc func forgetKeys(_ call: CAPPluginCall) {
        guard let hash = Self.decode(call.getString("hash")) else {
            call.reject("hash is required", "INVALID_ARGUMENT")
            return
        }
        reply(call, { core -> [String: Any] in
            try core.forgetKeys(hash: hash)
            return [:]
        })
    }

    @objc func wipe(_ call: CAPPluginCall) {
        reply(call, { core -> [String: Any] in
            try core.wipe()
            return [:]
        })
    }

    // MARK: - Helpers

    private func reply(_ call: CAPPluginCall, _ body: @escaping (MeshCore) throws -> [String: Any]) {
        bridgeNode.call(body) { result in
            switch result {
            case .success(let value):
                call.resolve(value)
            case .failure(let error):
                switch error as? MeshCoreError {
                case .notStarted?:
                    call.reject("The mesh node is not started", "NOT_STARTED")
                case .invalidArgument(let message)?:
                    call.reject(message, "INVALID_ARGUMENT")
                case .unsupported(let message)?:
                    call.reject(message, "UNIMPLEMENTED")
                case nil:
                    call.reject(error.localizedDescription, "NODE_ERROR", error)
                }
            }
        }
    }

    private static func decode(_ value: String?) -> Data? {
        guard let value = value else { return nil }
        return Data(base64Encoded: value)
    }

    /// Nil when any entry is not a base64 string; an absent array is empty.
    private static func decodeList(_ array: JSArray?) -> [Data]? {
        guard let array = array else { return [] }
        var out: [Data] = []
        for item in array {
            guard let string = item as? String, let data = Data(base64Encoded: string) else { return nil }
            out.append(data)
        }
        return out
    }

    private static func json(_ object: JSObject?) -> String? {
        guard let object = object, JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
