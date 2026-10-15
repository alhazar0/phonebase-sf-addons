import AVFoundation
import CoreImage
import ImageIO
import Network

struct CameraBinding {
    let identityPrefix: String
    let port: UInt16
    let width: Int32
    let height: Int32
    let fps: Int32
}

enum BrokerError: Error, CustomStringConvertible {
    case argument(String)
    case camera(String)

    var description: String {
        switch self {
        case .argument(let message), .camera(let message): return message
        }
    }
}

func parseBindings() throws -> [CameraBinding] {
    let arguments = Array(CommandLine.arguments.dropFirst())
    var bindings: [CameraBinding] = []
    var index = 0
    while index < arguments.count {
        guard arguments[index] == "--camera", index + 9 < arguments.count else {
            throw BrokerError.argument(
                "Expected --camera <identity> --port <port> --width <width> --height <height> --fps <fps>"
            )
        }
        let identity = arguments[index + 1]
        guard arguments[index + 2] == "--port",
              let port = UInt16(arguments[index + 3]),
              arguments[index + 4] == "--width",
              let width = Int32(arguments[index + 5]),
              arguments[index + 6] == "--height",
              let height = Int32(arguments[index + 7]),
              arguments[index + 8] == "--fps",
              let fps = Int32(arguments[index + 9]) else {
            throw BrokerError.argument("Invalid camera broker binding near \(identity)")
        }
        bindings.append(CameraBinding(
            identityPrefix: identity,
            port: port,
            width: width,
            height: height,
            fps: fps
        ))
        index += 10
    }
    guard !bindings.isEmpty else {
        throw BrokerError.argument("At least one camera binding is required")
    }
    guard Set(bindings.map(\.identityPrefix)).count == bindings.count,
          Set(bindings.map(\.port)).count == bindings.count else {
        throw BrokerError.argument("Camera identities and stream ports must be unique")
    }
    return bindings
}

final class FrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let identity: String
    private let port: UInt16
    private let targetWidth: CGFloat = 720
    private let targetHeight: CGFloat = 1280
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let networkQueue: DispatchQueue
    private var connection: NWConnection?
    private var connected = false
    private var sending = false

    init(identity: String, port: UInt16) {
        self.identity = identity
        self.port = port
        self.networkQueue = DispatchQueue(label: "screenhand.camera.network.\(port)")
        super.init()
        networkQueue.async { [weak self] in self?.connect() }
    }

    private func connect() {
        guard connection == nil, let endpointPort = NWEndpoint.Port(rawValue: port) else { return }
        let next = NWConnection(host: "127.0.0.1", port: endpointPort, using: .tcp)
        connection = next
        next.stateUpdateHandler = { [weak self, weak next] state in
            guard let self, self.connection === next else { return }
            switch state {
            case .ready:
                self.connected = true
                print("Camera \(self.identity) connected to 127.0.0.1:\(self.port)")
            case .failed, .cancelled:
                self.connected = false
                self.sending = false
                self.connection = nil
                self.networkQueue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.connect()
                }
            default:
                break
            }
        }
        next.start(queue: networkQueue)
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let oriented = CIImage(cvPixelBuffer: pixelBuffer).oriented(.left)
        let normalized = oriented.transformed(by: CGAffineTransform(
            translationX: -oriented.extent.minX,
            y: -oriented.extent.minY
        ))
        let scaled = normalized.transformed(by: CGAffineTransform(
            scaleX: targetWidth / normalized.extent.width,
            y: targetHeight / normalized.extent.height
        )).cropped(to: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        guard let jpeg = context.jpegRepresentation(
            of: scaled,
            colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.88]
        ) else { return }

        networkQueue.async { [weak self] in
            guard let self, self.connected, !self.sending, let connection = self.connection else { return }
            self.sending = true
            connection.send(content: jpeg, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                self.sending = false
                if error != nil {
                    self.connected = false
                    self.connection?.cancel()
                }
            })
        }
    }
}

struct CameraRuntime {
    let session: AVCaptureSession
    let sink: FrameSink
    let queue: DispatchQueue
}

func matchingDevice(prefix: String) throws -> AVCaptureDevice {
    let matches = AVCaptureDevice.devices(for: .video).filter {
        $0.uniqueID.lowercased().hasPrefix(prefix.lowercased())
    }
    guard matches.count == 1, let device = matches.first else {
        throw BrokerError.camera("Camera identity \(prefix) matched \(matches.count) devices")
    }
    guard device.localizedName.caseInsensitiveCompare("USB Camera2") == .orderedSame else {
        throw BrokerError.camera(
            "Refusing \(device.localizedName) (\(device.uniqueID)); only robot USB Camera2 is allowed"
        )
    }
    return device
}

func configure(_ binding: CameraBinding) throws -> CameraRuntime {
    let device = try matchingDevice(prefix: binding.identityPrefix)
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }

    if let selection = device.formats.compactMap({ format -> (AVCaptureDevice.Format, AVFrameRateRange)? in
        let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        guard dimensions.width == binding.width, dimensions.height == binding.height else { return nil }
        guard let range = format.videoSupportedFrameRateRanges.first(where: { range in
            range.minFrameRate <= Double(binding.fps) + 0.1 &&
                range.maxFrameRate >= Double(binding.fps) - 0.1
        }) else { return nil }
        return (format, range)
    }).first {
        device.activeFormat = selection.0
        // Ask AVFoundation for the configured cadence directly. A second
        // wall-clock throttle here can skip every other frame when capture
        // timestamps jitter around the exact interval (30 fps -> 15 fps).
        let requestedFrameDuration = CMTime(value: 1, timescale: binding.fps)
        device.activeVideoMinFrameDuration = requestedFrameDuration
        device.activeVideoMaxFrameDuration = requestedFrameDuration
    } else {
        throw BrokerError.camera(
            "Camera \(binding.identityPrefix) does not support \(binding.width)x\(binding.height)@\(binding.fps)"
        )
    }

    let session = AVCaptureSession()
    session.beginConfiguration()
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else {
        throw BrokerError.camera("Cannot add camera input \(binding.identityPrefix)")
    }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
    ]
    guard session.canAddOutput(output) else {
        throw BrokerError.camera("Cannot add camera output \(binding.identityPrefix)")
    }
    session.addOutput(output)
    let sink = FrameSink(identity: device.uniqueID, port: binding.port)
    let queue = DispatchQueue(label: "screenhand.camera.frames.\(binding.port)")
    output.setSampleBufferDelegate(sink, queue: queue)
    session.commitConfiguration()
    print("Bound \(device.uniqueID) -> 127.0.0.1:\(binding.port)")
    return CameraRuntime(session: session, sink: sink, queue: queue)
}

func cameraAuthorized() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        return true
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .video) { value in
            granted = value
            semaphore.signal()
        }
        semaphore.wait()
        return granted
    default:
        return false
    }
}

do {
    guard cameraAuthorized() else {
        throw BrokerError.camera("Camera permission is not granted")
    }
    let bindings = try parseBindings()
    let runtimes = try bindings.map(configure)
    for runtime in runtimes {
        runtime.queue.async { runtime.session.startRunning() }
    }
    withExtendedLifetime(runtimes) {
        RunLoop.current.run()
    }
} catch {
    fputs("ScreenHand camera broker: \(error)\n", stderr)
    exit(1)
}
