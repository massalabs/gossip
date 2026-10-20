import CoreBluetooth
import Foundation

/// `MeshRadio` over CoreBluetooth. The phone is a peripheral (it advertises
/// the mesh service, receives chunks as writes and sends chunks as
/// notifications) and a central (it scans, connects, writes chunks and
/// receives notifications) at the same time, up to `MeshConstants.maxLinks`
/// links in both roles together.
///
/// Both managers use state restoration, so iOS can relaunch the app in the
/// background for mesh events; `MeshNodePlugin.load()` recreates the radio
/// at launch when the mesh was on. Everything runs on one serial queue except
/// the per-link send queues.
///
/// iOS limits: in the background the advertised UUID moves to Apple's
/// overflow area and scanning slows down, so two backgrounded iPhones find
/// each other poorly. A peripheral cannot disconnect a central; closing such
/// a link only stops using it.
final class CoreBluetoothMeshRadio: NSObject, MeshRadio {
    private enum Role { case central, peripheral }

    private final class Link {
        let id: Int
        let role: Role
        let peerId: String
        let maxChunk: Int
        let upSince: TimeInterval
        let peripheral: CBPeripheral?
        let characteristic: CBCharacteristic?
        let central: CBCentral?
        let queue = FrameQueue()

        init(id: Int, role: Role, peerId: String, maxChunk: Int, upSince: TimeInterval,
             peripheral: CBPeripheral? = nil, characteristic: CBCharacteristic? = nil, central: CBCentral? = nil) {
            self.id = id
            self.role = role
            self.peerId = peerId
            self.maxChunk = maxChunk
            self.upSince = upSince
            self.peripheral = peripheral
            self.characteristic = characteristic
            self.central = central
        }
    }

    private let queue = DispatchQueue(label: "net.massa.gossip.mesh.radio")
    private let selector = NeighbourSelector()
    private var central: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?
    private var serverCharacteristic: CBMutableCharacteristic?
    private var serviceAdded = false

    private weak var listener: MeshRadioListener?
    private var mode = MeshPowerMode.balanced
    private var running = false
    private var scanning = false
    private var nextLinkId = 1

    // `links` is read by sendFrame from other queues, so it is guarded; the rest is queue-only.
    private let linksLock = NSLock()
    private var links: [Int: Link] = [:]
    private var centralLinkByPeer: [UUID: Int] = [:]
    private var peripheralLinkByCentral: [UUID: Int] = [:]
    /// Centrals whose link closed, until when they are ignored. A peripheral
    /// cannot disconnect a central, so a closed link only stops being used and
    /// a hostile central could otherwise subscribe again at once.
    private var inboundCooldownUntil: [UUID: TimeInterval] = [:]
    /// Discovered peripherals must be retained for CoreBluetooth to connect to them.
    private var discovered: [UUID: CBPeripheral] = [:]
    private var connecting: [UUID: (peripheral: CBPeripheral, started: TimeInterval)] = [:]

    private var scanTimer: DispatchSourceTimer?
    private var rotationTimer: DispatchSourceTimer?
    private var watchdogTimer: DispatchSourceTimer?

    private static let connectTimeout: TimeInterval = 20

    func start(mode: MeshPowerMode, listener: MeshRadioListener) {
        queue.async {
            guard !self.running else { return }
            self.mode = mode
            self.listener = listener
            self.running = true
            // Creating the managers prompts for Bluetooth the first time.
            self.central = CBCentralManager(delegate: self, queue: self.queue, options: [
                CBCentralManagerOptionRestoreIdentifierKey: MeshConstants.centralRestoreIdentifier,
            ])
            self.peripheralManager = CBPeripheralManager(delegate: self, queue: self.queue, options: [
                CBPeripheralManagerOptionRestoreIdentifierKey: MeshConstants.peripheralRestoreIdentifier,
            ])
            self.startTimers()
        }
    }

    func stop() {
        queue.async {
            guard self.running else { return }
            self.running = false
            self.stopTimers()
            self.stopScan()
            self.peripheralManager?.stopAdvertising()
            for link in self.allLinks() { self.closeNow(link) }
            for (_, pending) in self.connecting { self.central?.cancelPeripheralConnection(pending.peripheral) }
            self.connecting.removeAll()
            self.discovered.removeAll()
            self.peripheralManager?.removeAllServices()
            self.serviceAdded = false
            self.central = nil
            self.peripheralManager = nil
            self.listener = nil
        }
    }

    func setPowerMode(_ mode: MeshPowerMode) {
        queue.async {
            guard self.mode != mode else { return }
            self.mode = mode
            if self.running {
                self.stopTimers()
                self.stopScan()
                self.startTimers()
            }
        }
    }

    func sendFrame(linkId: Int, frame: Data) -> Bool {
        guard let link = link(linkId), frame.count <= link.maxChunk, link.queue.offer(frame) else { return false }
        queue.async { self.pump(link) }
        return true
    }

    func closeLink(linkId: Int) {
        queue.async {
            guard let link = self.link(linkId) else { return }
            self.closeNow(link)
            // closed by the core right away: would otherwise be redialled every cooldown
            let t = self.now()
            if link.role == .central && t - link.upSince < MeshConstants.quickClose {
                self.selector.onRefused(link.peerId, now: t)
            }
        }
    }

    func linkCount() -> Int {
        linksLock.lock()
        defer { linksLock.unlock() }
        return links.count
    }

    // MARK: - Links

    private func link(_ id: Int) -> Link? {
        linksLock.lock()
        defer { linksLock.unlock() }
        return links[id]
    }

    private func allLinks() -> [Link] {
        linksLock.lock()
        defer { linksLock.unlock() }
        return Array(links.values)
    }

    private func busyIds() -> Set<String> {
        var busy = Set(allLinks().map { $0.peerId })
        for id in connecting.keys { busy.insert(id.uuidString) }
        return busy
    }

    private func addLink(_ link: Link) {
        linksLock.lock()
        links[link.id] = link
        linksLock.unlock()
        listener?.onLinkUp(linkId: link.id, mtu: link.maxChunk + MeshConstants.attHeaderBytes)
    }

    private func removeLink(_ link: Link) {
        linksLock.lock()
        let removed = links.removeValue(forKey: link.id) != nil
        linksLock.unlock()
        guard removed else { return }
        switch link.role {
        case .central:
            if let peripheral = link.peripheral, centralLinkByPeer[peripheral.identifier] == link.id {
                centralLinkByPeer.removeValue(forKey: peripheral.identifier)
            }
        case .peripheral:
            if let central = link.central, peripheralLinkByCentral[central.identifier] == link.id {
                peripheralLinkByCentral.removeValue(forKey: central.identifier)
            }
            if let central = link.central {
                inboundCooldownUntil[central.identifier] = now() + MeshConstants.inboundCooldown
            }
        }
        link.queue.clear()
        selector.onDisconnected(link.peerId, now: now())
        listener?.onLinkDown(linkId: link.id)
        connectToNewNeighbours()
    }

    private func closeNow(_ link: Link) {
        if link.role == .central, let peripheral = link.peripheral {
            central?.cancelPeripheralConnection(peripheral)
        }
        removeLink(link)
    }

    /// Sends queued chunks until CoreBluetooth says it is full; its ready callback calls this again.
    private func pump(_ link: Link) {
        guard self.link(link.id) != nil else { return }
        while let chunk = link.queue.peek() {
            let accepted: Bool
            switch link.role {
            case .central:
                guard let peripheral = link.peripheral, let characteristic = link.characteristic,
                      peripheral.state == .connected else {
                    closeNow(link)
                    return
                }
                guard peripheral.canSendWriteWithoutResponse else { return }
                peripheral.writeValue(chunk, for: characteristic, type: .withoutResponse)
                accepted = true
            case .peripheral:
                guard let manager = peripheralManager, let characteristic = serverCharacteristic,
                      let central = link.central else {
                    closeNow(link)
                    return
                }
                accepted = manager.updateValue(chunk, for: characteristic, onSubscribedCentrals: [central])
            }
            guard accepted else { return }
            link.queue.removeFirst()
        }
    }

    private func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    // MARK: - Scanning, rotation, watchdog

    private func makeTimer(after delay: TimeInterval, repeating interval: TimeInterval?, _ handler: @escaping () -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        if let interval = interval {
            timer.schedule(deadline: .now() + delay, repeating: interval)
        } else {
            timer.schedule(deadline: .now() + delay)
        }
        timer.setEventHandler(handler: handler)
        timer.resume()
        return timer
    }

    private func startTimers() {
        scheduleScanPhase(scanOn: true)
        rotationTimer = makeTimer(after: mode.rotationInterval, repeating: mode.rotationInterval) { [weak self] in
            self?.rotate()
        }
        watchdogTimer = makeTimer(after: 5, repeating: 5) { [weak self] in
            self?.watchdog()
        }
    }

    private func stopTimers() {
        scanTimer?.cancel()
        rotationTimer?.cancel()
        watchdogTimer?.cancel()
        scanTimer = nil
        rotationTimer = nil
        watchdogTimer = nil
    }

    /// Scans for `scanOn`, pauses for `scanOff`, and again.
    private func scheduleScanPhase(scanOn: Bool) {
        guard running else { return }
        if scanOn { startScan() } else { stopScan() }
        scanTimer?.cancel()
        scanTimer = makeTimer(after: scanOn ? mode.scanOn : mode.scanOff, repeating: nil) { [weak self] in
            self?.scheduleScanPhase(scanOn: !scanOn)
        }
    }

    private func startScan() {
        guard let central = central, central.state == .poweredOn, !scanning else { return }
        // Duplicates keep RSSI and last-seen fresh in the foreground; iOS ignores this in the background.
        central.scanForPeripherals(withServices: [MeshConstants.serviceUUID], options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: true,
        ])
        scanning = true
    }

    private func stopScan() {
        guard scanning else { return }
        if central?.state == .poweredOn { central?.stopScan() }
        scanning = false
    }

    private func connectToNewNeighbours() {
        guard running, let central = central, central.state == .poweredOn else { return }
        for id in selector.pickConnections(busy: busyIds(), now: now()) {
            guard let uuid = UUID(uuidString: id), let peripheral = discovered[uuid] else {
                selector.forget(id)
                continue
            }
            connecting[uuid] = (peripheral, now())
            central.connect(peripheral, options: nil)
        }
    }

    /// One long-lived central link makes room for a new random neighbour. Peripheral-role
    /// links are left alone: iOS gives a peripheral no way to disconnect a central.
    private func rotate() {
        guard running else { return }
        let all = allLinks()
        guard all.count >= MeshConstants.maxLinks else { return }
        var upSince: [String: TimeInterval] = [:]
        for link in all where link.role == .central { upSince[link.peerId] = link.upSince }
        // The selector needs the full link count to know every slot is taken.
        for link in all where link.role == .peripheral { upSince["peripheral-\(link.id)"] = now() }
        guard let victim = selector.pickRotationVictim(links: upSince, now: now(), minAge: mode.rotationInterval),
              let link = all.first(where: { $0.role == .central && $0.peerId == victim }) else { return }
        closeNow(link)
    }

    private func watchdog() {
        guard running else { return }
        let t = now()
        for (uuid, pending) in connecting where t - pending.started > Self.connectTimeout {
            connecting.removeValue(forKey: uuid)
            central?.cancelPeripheralConnection(pending.peripheral)
            selector.onDisconnected(uuid.uuidString, now: t)
        }
        // Forget peripherals no longer seen, so `discovered` stays bounded.
        for (uuid, _) in discovered where !selector.isCandidate(uuid.uuidString)
            && connecting[uuid] == nil && centralLinkByPeer[uuid] == nil {
            discovered.removeValue(forKey: uuid)
        }
    }

    // MARK: - Peripheral role setup

    private func addServiceIfNeeded() {
        guard let manager = peripheralManager, manager.state == .poweredOn, !serviceAdded else { return }
        let characteristic = CBMutableCharacteristic(
            type: MeshConstants.chunkCharacteristicUUID,
            properties: [.writeWithoutResponse, .notify],
            value: nil,
            permissions: [.writeable]
        )
        let service = CBMutableService(type: MeshConstants.serviceUUID, primary: true)
        service.characteristics = [characteristic]
        manager.add(service)
        serverCharacteristic = characteristic
        serviceAdded = true
    }

    private func startAdvertising() {
        guard let manager = peripheralManager, manager.state == .poweredOn, !manager.isAdvertising else { return }
        // No local name: it would identify the phone.
        manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [MeshConstants.serviceUUID]])
    }
}

// MARK: - CBCentralManagerDelegate

extension CoreBluetoothMeshRadio: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard running else { return }
        if central.state == .poweredOn {
            startScan()
        } else {
            scanning = false
            for link in allLinks() where link.role == .central { removeLink(link) }
            connecting.removeAll()
        }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        // Connections iOS kept for us while the app was not running: drop them and
        // reconnect through the selector, since their link state did not survive.
        let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        for peripheral in peripherals {
            central.cancelPeripheralConnection(peripheral)
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let rssi = RSSI.intValue
        // 127 means the RSSI is not available.
        guard rssi != 127 else { return }
        discovered[peripheral.identifier] = peripheral
        selector.onSeen(peripheral.identifier.uuidString, rssi: rssi, now: now())
        connectToNewNeighbours()
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard running, connecting[peripheral.identifier] != nil else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.delegate = self
        peripheral.discoverServices([MeshConstants.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connecting.removeValue(forKey: peripheral.identifier)
        selector.onDisconnected(peripheral.identifier.uuidString, now: now())
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        connecting.removeValue(forKey: peripheral.identifier)
        if let id = centralLinkByPeer[peripheral.identifier], let link = link(id) {
            removeLink(link)
        } else {
            selector.onDisconnected(peripheral.identifier.uuidString, now: now())
        }
    }
}

// MARK: - CBPeripheralDelegate (central role)

extension CoreBluetoothMeshRadio: CBPeripheralDelegate {
    private func abandon(_ peripheral: CBPeripheral) {
        connecting.removeValue(forKey: peripheral.identifier)
        selector.onDisconnected(peripheral.identifier.uuidString, now: now())
        central?.cancelPeripheralConnection(peripheral)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil,
              let service = peripheral.services?.first(where: { $0.uuid == MeshConstants.serviceUUID }) else {
            abandon(peripheral)
            return
        }
        peripheral.discoverCharacteristics([MeshConstants.chunkCharacteristicUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil,
              let characteristic = service.characteristics?.first(where: {
                  $0.uuid == MeshConstants.chunkCharacteristicUUID
              }) else {
            abandon(peripheral)
            return
        }
        peripheral.setNotifyValue(true, for: characteristic)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard characteristic.uuid == MeshConstants.chunkCharacteristicUUID else { return }
        guard error == nil, characteristic.isNotifying else {
            if let id = centralLinkByPeer[peripheral.identifier], let link = link(id) {
                closeNow(link)
            } else {
                abandon(peripheral)
            }
            return
        }
        guard connecting.removeValue(forKey: peripheral.identifier) != nil,
              centralLinkByPeer[peripheral.identifier] == nil else { return }
        let id = nextLinkId
        nextLinkId += 1
        centralLinkByPeer[peripheral.identifier] = id
        addLink(Link(
            id: id,
            role: .central,
            peerId: peripheral.identifier.uuidString,
            maxChunk: peripheral.maximumWriteValueLength(for: .withoutResponse),
            upSince: now(),
            peripheral: peripheral,
            characteristic: characteristic
        ))
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.uuid == MeshConstants.chunkCharacteristicUUID,
              let value = characteristic.value,
              let id = centralLinkByPeer[peripheral.identifier] else { return }
        listener?.onFrameIn(linkId: id, frame: value)
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        guard let id = centralLinkByPeer[peripheral.identifier], let link = link(id) else { return }
        pump(link)
    }

    func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        guard invalidatedServices.contains(where: { $0.uuid == MeshConstants.serviceUUID }),
              let id = centralLinkByPeer[peripheral.identifier], let link = link(id) else { return }
        closeNow(link)
    }
}

// MARK: - CBPeripheralManagerDelegate

extension CoreBluetoothMeshRadio: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard running else { return }
        if peripheral.state == .poweredOn {
            addServiceIfNeeded()
            startAdvertising()
        } else {
            serviceAdded = false
            serverCharacteristic = nil
            for link in allLinks() where link.role == .peripheral { removeLink(link) }
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String: Any]) {
        // The service survives in the restored manager; adding it again would duplicate it.
        let services = dict[CBPeripheralManagerRestoredStateServicesKey] as? [CBMutableService] ?? []
        if let service = services.first(where: { $0.uuid == MeshConstants.serviceUUID }),
           let characteristic = service.characteristics?.first(where: {
               $0.uuid == MeshConstants.chunkCharacteristicUUID
           }) as? CBMutableCharacteristic {
            serverCharacteristic = characteristic
            serviceAdded = true
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if error != nil {
            serviceAdded = false
            serverCharacteristic = nil
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didSubscribeTo characteristic: CBCharacteristic) {
        guard running, characteristic.uuid == MeshConstants.chunkCharacteristicUUID,
              peripheralLinkByCentral[central.identifier] == nil else { return }
        let current = now()
        inboundCooldownUntil = inboundCooldownUntil.filter { $0.value > current }
        let inbound = allLinks().filter { $0.role == .peripheral }.count
        guard allLinks().count + connecting.count < MeshConstants.maxLinks,
              inbound < MeshConstants.maxInboundLinks,
              inboundCooldownUntil[central.identifier] == nil else {
            // Over a cap or cooling down: never used, so the central's handshake
            // times out and it moves on.
            return
        }
        let id = nextLinkId
        nextLinkId += 1
        peripheralLinkByCentral[central.identifier] = id
        addLink(Link(
            id: id,
            role: .peripheral,
            peerId: central.identifier.uuidString,
            maxChunk: central.maximumUpdateValueLength,
            upSince: now(),
            central: central
        ))
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard let id = peripheralLinkByCentral[central.identifier], let link = link(id) else { return }
        removeLink(link)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests where request.characteristic.uuid == MeshConstants.chunkCharacteristicUUID {
            // a chunk is one plain write: anything at an offset is refused
            guard request.offset == 0, let value = request.value,
                  let id = peripheralLinkByCentral[request.central.identifier] else { continue }
            listener?.onFrameIn(linkId: id, frame: value)
        }
        // The characteristic only allows writes without response, so there is nothing to answer.
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        for link in allLinks() where link.role == .peripheral { pump(link) }
    }
}
