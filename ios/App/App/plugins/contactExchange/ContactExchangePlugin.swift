import Capacitor
import CoreBluetooth
import Foundation

/// The ContactExchange plugin (`services/contactExchange.ts`): the Bluetooth
/// half of adding a contact in person, independent of the mesh node and its
/// managers. The presenter advertises its code's UUID while the code is on
/// screen; the scanner connects once it has read one frame. Binary values
/// cross the bridge as standard base64; nothing is stored.
///
/// Events: `request` ({ requestId, data }) for a scanner's request, and
/// `sent` ({ requestId }) once its answer went out.
@objc(ContactExchangePlugin)
public class ContactExchangePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ContactExchangePlugin"
    public let jsName = "ContactExchange"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkBluetooth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestBluetooth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPresenting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPresenting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exchange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelExchange", returnType: CAPPluginReturnPromise),
    ]

    private static let maxPresent: TimeInterval = 120
    private static let maxExchange: TimeInterval = 60

    private let queue = DispatchQueue(label: "net.massa.gossip.contact-exchange")
    private lazy var presenter: ContactExchangePresenter = {
        let presenter = ContactExchangePresenter(queue: self.queue)
        presenter.onRequest = { [weak self] id, request in
            self?.notifyListeners("request", data: ["requestId": id, "data": request.base64EncodedString()])
        }
        presenter.onSent = { [weak self] id in
            self?.notifyListeners("sent", data: ["requestId": id])
        }
        return presenter
    }()
    private lazy var client = ContactExchangeClient(queue: self.queue)
    private var authorizer: BluetoothAuthorizer?

    // MARK: - Permissions

    @objc func checkBluetooth(_ call: CAPPluginCall) {
        call.resolve(["state": Self.permissionState()])
    }

    /// iOS asks the first time a Bluetooth manager is created; this creates one
    /// only for that, and answers once the user has chosen.
    @objc func requestBluetooth(_ call: CAPPluginCall) {
        guard CBManager.authorization == .notDetermined else {
            call.resolve(["state": Self.permissionState()])
            return
        }
        DispatchQueue.main.async {
            let authorizer = BluetoothAuthorizer { [weak self] in
                call.resolve(["state": Self.permissionState()])
                self?.authorizer = nil
            }
            self.authorizer = authorizer
            authorizer.start()
        }
    }

    private static func permissionState() -> String {
        switch CBManager.authorization {
        case .allowedAlways: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    private func hasBluetooth(_ call: CAPPluginCall) -> Bool {
        if CBManager.authorization == .allowedAlways { return true }
        call.reject("Bluetooth permission denied", "PERMISSION_DENIED")
        return false
    }

    // MARK: - Presenter

    @objc func startPresenting(_ call: CAPPluginCall) {
        guard hasBluetooth(call),
              let service = Self.uuid(call, "serviceUuid"),
              let characteristic = Self.uuid(call, "characteristicUuid") else { return }
        let timeout = min(max((call.getDouble("timeoutMs") ?? Self.maxPresent * 1000) / 1000, 1), Self.maxPresent)
        presenter.start(service: service, characteristic: characteristic, timeout: timeout) { error in
            if let error = error {
                call.reject("Could not start Bluetooth", error)
            } else {
                call.resolve()
            }
        }
    }

    @objc func respond(_ call: CAPPluginCall) {
        guard let requestId = call.getInt("requestId"),
              let data = call.getString("data").flatMap({ Data(base64Encoded: $0) }) else {
            call.reject("requestId and data are required", "INVALID_ARGUMENT")
            return
        }
        presenter.respond(requestId: requestId, response: data) { sent in
            if sent {
                call.resolve()
            } else {
                call.reject("No such request", "NOT_FOUND")
            }
        }
    }

    @objc func stopPresenting(_ call: CAPPluginCall) {
        presenter.stop()
        call.resolve()
    }

    // MARK: - Scanner

    @objc func exchange(_ call: CAPPluginCall) {
        guard hasBluetooth(call),
              let service = Self.uuid(call, "serviceUuid"),
              let characteristic = Self.uuid(call, "characteristicUuid") else { return }
        guard let request = call.getString("request").flatMap({ Data(base64Encoded: $0) }),
              request.count == ExchangeFraming.requestLength else {
            call.reject("request must be \(ExchangeFraming.requestLength) bytes", "INVALID_ARGUMENT")
            return
        }
        let timeout = min(max((call.getDouble("timeoutMs") ?? Self.maxExchange * 1000) / 1000, 1), Self.maxExchange)
        client.exchange(service: service, characteristic: characteristic, request: request, timeout: timeout) { outcome in
            switch outcome {
            case .success(let response):
                call.resolve(["response": response.base64EncodedString()])
            case .failure(let error):
                call.reject("Bluetooth exchange failed", error.code)
            }
        }
    }

    @objc func cancelExchange(_ call: CAPPluginCall) {
        client.cancel()
        call.resolve()
    }

    private static func uuid(_ call: CAPPluginCall, _ name: String) -> CBUUID? {
        guard let value = call.getString(name), let uuid = UUID(uuidString: value) else {
            call.reject("\(name) must be a UUID", "INVALID_ARGUMENT")
            return nil
        }
        return CBUUID(nsuuid: uuid)
    }
}

/// Holds a central manager only until iOS reports the user's Bluetooth choice.
private final class BluetoothAuthorizer: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager?
    private var onDecided: (() -> Void)?

    init(onDecided: @escaping () -> Void) {
        self.onDecided = onDecided
    }

    func start() {
        // Creating the manager shows the prompt; no power alert on top of it.
        manager = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionShowPowerAlertKey: false,
        ])
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard CBManager.authorization != .notDetermined else { return }
        let callback = onDecided
        onDecided = nil
        manager?.delegate = nil
        manager = nil
        callback?()
    }
}

// MARK: - Framing

/// Byte framing of the exchange, the same as Android's `ExchangeFraming.kt`
/// (CONTACT-EXCHANGE.md): the response goes as notifications of a 4-byte
/// big-endian length, then the bytes.
enum ExchangeFraming {
    /// 0x01 ‖ the scanner's X25519 key.
    static let requestLength = 33
    static let maxResponseLength = 16 * 1024
    static let lengthPrefixBytes = 4

    static func chunks(_ data: Data, maxChunk: Int) -> [Data]? {
        guard maxChunk > lengthPrefixBytes, data.count <= maxResponseLength else { return nil }
        var framed = Data()
        let length = UInt32(data.count)
        framed.append(contentsOf: [
            UInt8(truncatingIfNeeded: length >> 24),
            UInt8(truncatingIfNeeded: length >> 16),
            UInt8(truncatingIfNeeded: length >> 8),
            UInt8(truncatingIfNeeded: length),
        ])
        framed.append(data)
        var chunks: [Data] = []
        var start = 0
        while start < framed.count {
            let end = min(start + maxChunk, framed.count)
            chunks.append(framed.subdata(in: start..<end))
            start = end
        }
        return chunks
    }
}

/// Reassembles a response; anything malformed fails it for good.
struct ResponseAssembler {
    private var header = [UInt8]()
    private var body: [UInt8]?
    private var expected = 0
    private(set) var failed = false

    var isComplete: Bool { !failed && body != nil && body!.count == expected }

    var result: Data? { isComplete ? Data(body!) : nil }

    mutating func add(_ chunk: Data) {
        if failed || isComplete {
            if !chunk.isEmpty { failed = true }
            return
        }
        var bytes = [UInt8](chunk)[...]
        while header.count < ExchangeFraming.lengthPrefixBytes, let first = bytes.first {
            header.append(first)
            bytes = bytes.dropFirst()
        }
        guard header.count == ExchangeFraming.lengthPrefixBytes else { return }
        if body == nil {
            let length = header.reduce(0) { ($0 << 8) | Int($1) }
            guard length > 0, length <= ExchangeFraming.maxResponseLength else {
                failed = true
                return
            }
            expected = length
            body = []
            body?.reserveCapacity(length)
        }
        guard bytes.count <= expected - body!.count else {
            failed = true
            return
        }
        body?.append(contentsOf: bytes)
    }
}

/// What one code on screen agrees to answer: a few requests in all, one per
/// phone, and not many at once.
struct PresenterBudget {
    private let maxResponses = 16
    private let maxConcurrent = 2
    private var answered = Set<UUID>()
    private var inFlight = Set<UUID>()
    private var total = 0

    mutating func admit(_ peer: UUID) -> Bool {
        guard total < maxResponses, inFlight.count < maxConcurrent,
              !answered.contains(peer), !inFlight.contains(peer) else { return false }
        inFlight.insert(peer)
        total += 1
        return true
    }

    mutating func release(_ peer: UUID) {
        if inFlight.remove(peer) != nil { answered.insert(peer) }
    }
}

// MARK: - Presenter

/// The phone showing the code: its own peripheral manager (not the mesh's),
/// one service with one characteristic, advertised under the code's UUID.
/// A scanner subscribes, writes its request (with response) and gets the
/// answer as notifications. Everything runs on `queue`.
final class ContactExchangePresenter: NSObject, CBPeripheralManagerDelegate {
    var onRequest: ((Int, Data) -> Void)?
    var onSent: ((Int) -> Void)?

    private final class Peer {
        let central: CBCentral
        var subscribed = false
        var requestId: Int?
        var sending = false
        var chunks: [Data] = []

        init(central: CBCentral) {
            self.central = central
        }
    }

    private static let requestTimeout: TimeInterval = 15

    private let queue: DispatchQueue
    private var manager: CBPeripheralManager?
    private var serviceUUID: CBUUID?
    private var characteristicUUID: CBUUID?
    private var characteristic: CBMutableCharacteristic?
    private var pendingStart: ((String?) -> Void)?
    private var timeoutWork: DispatchWorkItem?
    private var budget = PresenterBudget()
    private var peers: [UUID: Peer] = [:]
    private var nextRequestId = 1
    private var running = false

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func start(service: CBUUID, characteristic: CBUUID, timeout: TimeInterval, done: @escaping (String?) -> Void) {
        queue.async {
            if self.running { self.stopNow() }
            self.running = true
            self.serviceUUID = service
            self.characteristicUUID = characteristic
            self.budget = PresenterBudget()
            self.pendingStart = done
            // No restoration identifier: the code is only on screen in the
            // foreground, and nothing of it is kept.
            self.manager = CBPeripheralManager(delegate: self, queue: self.queue, options: nil)
            let work = DispatchWorkItem { [weak self] in self?.stopNow() }
            self.timeoutWork = work
            self.queue.asyncAfter(deadline: .now() + timeout, execute: work)
        }
    }

    func stop() {
        queue.async { if self.running { self.stopNow() } }
    }

    func respond(requestId: Int, response: Data, done: @escaping (Bool) -> Void) {
        queue.async {
            guard self.running,
                  let peer = self.peers.values.first(where: { $0.requestId == requestId }),
                  peer.subscribed, !peer.sending,
                  let chunks = ExchangeFraming.chunks(response, maxChunk: peer.central.maximumUpdateValueLength) else {
                done(false)
                return
            }
            peer.chunks = chunks
            peer.sending = true
            done(true)
            self.pump(peer)
        }
    }

    private func stopNow() {
        timeoutWork?.cancel()
        timeoutWork = nil
        if let manager = manager {
            if manager.isAdvertising { manager.stopAdvertising() }
            // A peripheral cannot disconnect a central: removing the service
            // tells it the exchange is over.
            manager.removeAllServices()
            manager.delegate = nil
        }
        manager = nil
        characteristic = nil
        peers.removeAll()
        let start = pendingStart
        pendingStart = nil
        running = false
        start?("START_FAILED")
    }

    private func finishStart(_ error: String?) {
        guard let done = pendingStart else { return }
        pendingStart = nil
        if error != nil { stopNow() }
        done(error)
    }

    private func peer(_ central: CBCentral) -> Peer {
        if let peer = peers[central.identifier] { return peer }
        let peer = Peer(central: central)
        peers[central.identifier] = peer
        return peer
    }

    private func pump(_ peer: Peer) {
        guard let manager = manager, let characteristic = characteristic, peer.sending else { return }
        while let chunk = peer.chunks.first {
            // false: the transmit queue is full; peripheralManagerIsReady calls this again.
            guard manager.updateValue(chunk, for: characteristic, onSubscribedCentrals: [peer.central]) else { return }
            peer.chunks.removeFirst()
        }
        peer.sending = false
        guard let id = peer.requestId else { return }
        peer.requestId = nil
        budget.release(peer.central.identifier)
        onSent?(id)
    }

    // MARK: CBPeripheralManagerDelegate

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard running, peripheral === manager else { return }
        switch peripheral.state {
        case .poweredOn:
            guard pendingStart != nil, characteristic == nil,
                  let serviceUUID = serviceUUID, let characteristicUUID = characteristicUUID else { return }
            let chr = CBMutableCharacteristic(
                type: characteristicUUID,
                properties: [.write, .notify],
                value: nil,
                permissions: [.writeable]
            )
            let service = CBMutableService(type: serviceUUID, primary: true)
            service.characteristics = [chr]
            characteristic = chr
            peripheral.add(service)
        case .poweredOff:
            if pendingStart != nil { finishStart("BLUETOOTH_OFF") } else { stopNow() }
        case .unauthorized:
            if pendingStart != nil { finishStart("PERMISSION_DENIED") } else { stopNow() }
        case .unsupported:
            if pendingStart != nil { finishStart("UNSUPPORTED") } else { stopNow() }
        default:
            // .unknown or .resetting: wait for the next state.
            break
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard running, peripheral === manager else { return }
        guard error == nil, let serviceUUID = serviceUUID else {
            finishStart("START_FAILED")
            return
        }
        // Only the code's random UUID: no local name, nothing that names the phone or Gossip.
        peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceUUID]])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        guard running, peripheral === manager else { return }
        finishStart(error == nil ? nil : "ADVERTISE_FAILED")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didSubscribeTo characteristic: CBCharacteristic) {
        guard running, characteristic.uuid == characteristicUUID else { return }
        peer(central).subscribed = true
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == characteristicUUID,
              let peer = peers.removeValue(forKey: central.identifier) else { return }
        if peer.requestId != nil { budget.release(central.identifier) }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        // One plain write of the request: long (multi-part) writes are refused.
        guard running, requests.count == 1, first.characteristic.uuid == characteristicUUID,
              first.offset == 0, let value = first.value, value.count == ExchangeFraming.requestLength,
              let peer = peers[first.central.identifier], peer.subscribed,
              budget.admit(first.central.identifier) else {
            peripheral.respond(to: first, withResult: .unlikelyError)
            return
        }
        peripheral.respond(to: first, withResult: .success)
        let id = nextRequestId
        nextRequestId += 1
        peer.requestId = id
        // Not answered in time: forget it, the scanner times out on its side.
        let centralId = first.central.identifier
        queue.asyncAfter(deadline: .now() + Self.requestTimeout) { [weak self] in
            guard let self = self, let current = self.peers[centralId],
                  current.requestId == id, !current.sending else { return }
            self.peers.removeValue(forKey: centralId)
            self.budget.release(centralId)
        }
        onRequest?(id, value)
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        for peer in peers.values where peer.sending { pump(peer) }
    }
}

// MARK: - Scanner

struct ContactExchangeError: Error {
    let code: String
}

/// The scanning phone's side, with its own central manager (not the mesh's):
/// finds the phone advertising the code's UUID, connects, subscribes, writes
/// the request and reassembles the answer. One exchange at a time; it always
/// disconnects at the end. Everything runs on `queue`.
final class ContactExchangeClient: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private final class Attempt {
        let service: CBUUID
        let characteristic: CBUUID
        let request: Data
        let done: (Result<Data, ContactExchangeError>) -> Void
        var peripheral: CBPeripheral?
        var assembler = ResponseAssembler()

        init(service: CBUUID, characteristic: CBUUID, request: Data,
             done: @escaping (Result<Data, ContactExchangeError>) -> Void) {
            self.service = service
            self.characteristic = characteristic
            self.request = request
            self.done = done
        }
    }

    private let queue: DispatchQueue
    private var central: CBCentralManager?
    private var attempt: Attempt?

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func exchange(service: CBUUID, characteristic: CBUUID, request: Data, timeout: TimeInterval,
                  done: @escaping (Result<Data, ContactExchangeError>) -> Void) {
        queue.async {
            if let previous = self.attempt { self.finish(previous, .failure(ContactExchangeError(code: "CANCELLED"))) }
            let current = Attempt(service: service, characteristic: characteristic, request: request, done: done)
            self.attempt = current
            self.queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self = self, self.attempt === current else { return }
                self.finish(current, .failure(ContactExchangeError(code: "TIMEOUT")))
            }
            if let central = self.central {
                self.centralManagerDidUpdateState(central)
            } else {
                // No restoration identifier: an exchange only runs while the scanner is open.
                self.central = CBCentralManager(delegate: self, queue: self.queue, options: [
                    CBCentralManagerOptionShowPowerAlertKey: false,
                ])
            }
        }
    }

    func cancel() {
        queue.async {
            guard let current = self.attempt else { return }
            self.finish(current, .failure(ContactExchangeError(code: "CANCELLED")))
        }
    }

    private func finish(_ current: Attempt, _ outcome: Result<Data, ContactExchangeError>) {
        guard attempt === current else { return }
        attempt = nil
        if let central = central {
            if central.state == .poweredOn, central.isScanning { central.stopScan() }
            if let peripheral = current.peripheral { central.cancelPeripheralConnection(peripheral) }
        }
        current.peripheral?.delegate = nil
        current.peripheral = nil
        current.done(outcome)
    }

    private func fail(_ code: String) {
        guard let current = attempt else { return }
        finish(current, .failure(ContactExchangeError(code: code)))
    }

    /// The attempt `peripheral` belongs to, if it is still the current one.
    private func ongoing(_ peripheral: CBPeripheral) -> Attempt? {
        guard let current = attempt, current.peripheral === peripheral else { return nil }
        return current
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard let current = attempt else { return }
        switch central.state {
        case .poweredOn:
            if current.peripheral == nil, !central.isScanning {
                central.scanForPeripherals(withServices: [current.service], options: nil)
            }
        case .poweredOff:
            fail("BLUETOOTH_OFF")
        case .unauthorized:
            fail("PERMISSION_DENIED")
        case .unsupported:
            fail("UNSUPPORTED")
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard let current = attempt, current.peripheral == nil else { return }
        central.stopScan()
        // Retained here: CoreBluetooth drops a peripheral nobody holds.
        current.peripheral = peripheral
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard let current = ongoing(peripheral) else { return }
        peripheral.delegate = self
        peripheral.discoverServices([current.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard ongoing(peripheral) != nil else { return }
        fail("CONNECT_FAILED")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard ongoing(peripheral) != nil else { return }
        fail("DISCONNECTED")
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let current = ongoing(peripheral) else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == current.service }) else {
            fail("NOT_FOUND")
            return
        }
        peripheral.discoverCharacteristics([current.characteristic], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let current = ongoing(peripheral) else { return }
        guard error == nil,
              let chr = service.characteristics?.first(where: { $0.uuid == current.characteristic }) else {
            fail("NOT_FOUND")
            return
        }
        peripheral.setNotifyValue(true, for: chr)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard let current = ongoing(peripheral), characteristic.uuid == current.characteristic else { return }
        // The 33-byte request must fit one write.
        guard error == nil, characteristic.isNotifying,
              peripheral.maximumWriteValueLength(for: .withResponse) >= current.request.count else {
            fail("NOT_FOUND")
            return
        }
        peripheral.writeValue(current.request, for: characteristic, type: .withResponse)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard ongoing(peripheral) != nil else { return }
        // Refused: this code answers no more, or answered this phone already.
        if error != nil { fail("REFUSED") }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let current = ongoing(peripheral), characteristic.uuid == current.characteristic,
              error == nil, let value = characteristic.value else { return }
        current.assembler.add(value)
        if current.assembler.failed {
            fail("BAD_RESPONSE")
        } else if let response = current.assembler.result {
            finish(current, .success(response))
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        guard let current = ongoing(peripheral),
              invalidatedServices.contains(where: { $0.uuid == current.service }) else { return }
        fail("DISCONNECTED")
    }
}
