// The camera of a video call (Android Calls.startVideo: Camera2Enumerator,
// 1280×720 at 30 fps, the front camera first; switchCamera turns it around).
// RTCCameraVideoCapturer feeds the call's RTCVideoSource. The simulator has no
// camera: `available` is false there and a video call stays audio-only.

import AVFoundation
@preconcurrency import WebRTC

@MainActor
final class CameraCapture {
    static let width: Int32 = 1280, height: Int32 = 720, fps = 30

    private let capturer: RTCCameraVideoCapturer
    private(set) var front = true
    private(set) var running = false

    init(source: RTCVideoSource) {
        capturer = RTCCameraVideoCapturer(delegate: source)
    }

    /// Whether this device has a camera to call with.
    static var available: Bool { !RTCCameraVideoCapturer.captureDevices().isEmpty }

    /// Starts the front camera (or the only one there is). False when there is none or it failed.
    func start(front: Bool = true) async -> Bool {
        guard let device = Self.device(front: front) else { return false }
        guard let format = Self.format(for: device) else { return false }
        let fps = Self.fps(for: format)
        let ok: Bool = await withCheckedContinuation { done in
            capturer.startCapture(with: device, format: format, fps: fps) { error in
                if let error { CallLog.error("camera: \(error.localizedDescription)") }
                done.resume(returning: error == nil)
            }
        }
        if ok {
            self.front = device.position != .back
            running = true
        }
        return ok
    }

    /// Front ↔ back.
    func switchCamera() async {
        guard running else { return }
        let want = !front
        guard Self.device(front: want)?.position == (want ? .front : .back) else { return }
        _ = await start(front: want)
    }

    func stop() async {
        guard running else { return }
        running = false
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            capturer.stopCapture { done.resume() }
        }
    }

    // MARK: choices (pure enough to read)

    static func device(front: Bool) -> AVCaptureDevice? {
        let all = RTCCameraVideoCapturer.captureDevices()
        return all.first { $0.position == (front ? .front : .back) } ?? all.first
    }

    /// The format closest to 1280×720 (by pixel count), preferring the capturer's pixel format.
    static func format(for device: AVCaptureDevice) -> AVCaptureDevice.Format? {
        let target = Int64(width) * Int64(height)
        return RTCCameraVideoCapturer.supportedFormats(for: device).min { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return abs(Int64(da.width) * Int64(da.height) - target) < abs(Int64(db.width) * Int64(db.height) - target)
        }
    }

    static func fps(for format: AVCaptureDevice.Format) -> Int {
        let top = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? Double(fps)
        return min(fps, Int(top))
    }
}
