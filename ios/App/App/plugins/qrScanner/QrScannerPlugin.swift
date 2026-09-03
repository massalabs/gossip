import AVFoundation
import Capacitor
import UIKit

/**
 * Native QR scanner built only on AVFoundation: iOS decodes QR codes itself
 * through AVCaptureMetadataOutput, so no third-party library is involved.
 * `scan()` presents a full-screen camera and resolves with the decoded text,
 * or rejects with code CANCELLED when the user closes it.
 */
@objc(QrScannerPlugin)
public class QrScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrScannerPlugin"
    public let jsName = "QrScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    @objc func scan(_ call: CAPPluginCall) {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                guard granted else {
                    call.reject("Camera permission denied", "PERMISSION_DENIED")
                    return
                }
                guard let host = self.bridge?.viewController else {
                    call.reject("No view controller", "UNAVAILABLE")
                    return
                }
                let scanner = QrScanViewController()
                scanner.modalPresentationStyle = .fullScreen
                // [weak scanner]: the controller owns this closure, so a strong
                // capture would keep the controller, its session and this call
                // alive after every scan.
                scanner.onResult = { [weak scanner] value in
                    scanner?.dismiss(animated: true) {
                        switch value {
                        case .some(let text):
                            call.resolve(["value": text])
                        case .none:
                            call.reject("Scan cancelled", "CANCELLED")
                        }
                    }
                }
                host.present(scanner, animated: true)
            }
        }
    }
}

final class QrScanViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    /// Called once: decoded text, or nil when cancelled / camera unavailable.
    var onResult: ((String?) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "net.massa.gossip.qr-session")
    private let previewLayer = AVCaptureVideoPreviewLayer()
    // Aiming guide only: dims outside a centred rounded square and outlines it.
    private let dimLayer = CAShapeLayer()
    private let frameLayer = CAShapeLayer()
    private var finished = false
    private var setupFailed = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            setupFailed = true
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            setupFailed = true
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        previewLayer.session = session
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)

        view.layer.addSublayer(dimLayer)
        view.layer.addSublayer(frameLayer)

        let close = UIButton(type: .system)
        close.setTitle("✕", for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 28)
        close.tintColor = .white
        close.accessibilityLabel = "Close"
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
        ])

        // startRunning blocks, keep it off the main thread.
        sessionQueue.async { self.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer.frame = view.bounds
        layoutViewfinder()
    }

    private func layoutViewfinder() {
        let side = min(view.bounds.width, view.bounds.height) * 0.7
        let box = CGRect(x: (view.bounds.width - side) / 2,
                         y: (view.bounds.height - side) / 2,
                         width: side, height: side)
        let hole = UIBezierPath(roundedRect: box, cornerRadius: 24)

        let mask = UIBezierPath(rect: view.bounds)
        mask.append(hole)
        dimLayer.frame = view.bounds
        dimLayer.path = mask.cgPath
        dimLayer.fillRule = .evenOdd
        dimLayer.fillColor = UIColor.black.withAlphaComponent(0.55).cgColor

        frameLayer.frame = view.bounds
        frameLayer.path = hole.cgPath
        frameLayer.fillColor = nil
        frameLayer.strokeColor = UIColor.white.cgColor
        frameLayer.lineWidth = 3
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Report camera failures only once fully presented, so dismiss() works.
        if setupFailed { finish(nil) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { self.session.stopRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              code.type == .qr,
              let value = code.stringValue else { return }
        finish(value)
    }

    @objc private func closeTapped() {
        finish(nil)
    }

    private func finish(_ value: String?) {
        guard !finished else { return }
        finished = true
        let callback = onResult
        onResult = nil
        callback?(value)
    }
}
