// People › Verify (People.verify — a SecureDialog): the safety number to compare,
// in three lines of four groups, and — as the web's user info does it — its QR code
// to show and a camera to scan the other's ("M5CET-SN:1:" + the 60 digits; the
// number is the same on both sides). "They match" (or a matching scan) marks the
// person's key as verified; on a verified person the button takes it back.
// Key transparency's alert for the server (RoomsModel.ktAlert) is shown here too:
// it is about the keys being compared.

import AVFoundation
import M5Design
import SwiftUI
import UIKit

struct SafetyVerifyView: View {
    let name: String
    /// The twelve groups ("13286 60170 …").
    let number: String
    let verified: Bool
    /// The server's key-transparency alert in words ("" = none).
    var ktAlert = ""
    /// on: verified (true) or taken back; scanned: by the QR code.
    let onVerify: @MainActor (_ on: Bool, _ scanned: Bool) -> Void
    /// Whether this device can scan (a camera); tests and previews set it.
    var canScan = QRScannerView.available

    @Environment(DesignHost.self) private var host
    @Environment(\.peopleClose) private var close
    @State private var scanning = false
    @State private var result = ""

    var body: some View {
        let ctx = host.renderContext()
        let fg = ctx.swiftColor("@onSurface", .black), muted = ctx.swiftColor("@muted", .gray)
        let primary = ctx.swiftColor("@primary", .blue), danger = ctx.swiftColor("@danger", .red), success = ctx.swiftColor("@success", DesignColor(argb: 0xFF16_A34A))
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(verbatim: host.peopleText("people.safety"))
                        .font(.system(size: 19, weight: .bold))
                        .foregroundStyle(fg)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    Button { close() } label: { DesignIcon(name: "x", size: 22, color: fg).frame(width: 44, height: 44) }
                        .accessibilityLabel(Text(verbatim: host.peopleText("nav.close")))
                        .accessibilityIdentifier("people.verify.close")
                }
                Text(verbatim: Safety.lines(number))
                    .font(.system(size: 19, weight: .bold, design: .monospaced))
                    .lineSpacing(5)
                    .foregroundStyle(fg)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("people.verify.number")
                if scanning {
                    QRScannerView { text in
                        scanning = false
                        let ok = SafetyQR.matches(text, number: number)
                        result = ok ? "match" : "mismatch"
                        if ok && !verified { onVerify(true, true) }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                } else if let image = SafetyQR.image(SafetyQR.payload(number)) {
                    Image(uiImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 168, height: 168)
                        .padding(10)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel(Text(verbatim: host.peopleText("people.safety")))
                        .accessibilityIdentifier("people.verify.qr")
                }
                if result == "match" {
                    note("shield-check", host.peopleText("sec.safety.verified"), success)
                } else if result == "mismatch" {
                    note("shield-alert", host.peopleText("sec.safety.mismatch"), danger)
                }
                Text(verbatim: PeopleTexts.fill(host.peopleText("people.verify.hint"), name: name))
                    .font(.system(size: 14))
                    .foregroundStyle(muted)
                    .fixedSize(horizontal: false, vertical: true)
                if !ktAlert.isEmpty {
                    HStack(alignment: .top, spacing: 10) {
                        DesignIcon(name: "shield-alert", size: 20, color: danger)
                        Text(verbatim: ktAlert).font(.system(size: 13)).foregroundStyle(danger).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    pill("check", host.peopleText("p4.kt.dismiss"), primary, id: "people.verify.kt") {
                        _ = host.runner.runFromApp("kt.dismiss", value: nil)
                    }
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { buttons(primary: primary, muted: muted) }
                    VStack(alignment: .leading, spacing: 8) { buttons(primary: primary, muted: muted) }
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 24)
            .padding(.top, 18)
            .padding(.bottom, 24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(ctx.swiftColor("@surface", .white).ignoresSafeArea())
    }

    @ViewBuilder
    private func buttons(primary: Color, muted: Color) -> some View {
        pill(verified ? "shield-off" : "shield-check", host.peopleText(verified ? "people.verify.undo" : "people.verify.match"), primary,
             id: "people.verify.toggle") {
            onVerify(!verified, false)
            close()
        }
        if canScan && !scanning {
            pill("scan-line", host.peopleText("sec.safety.scan"), primary, id: "people.verify.scan") {
                result = ""
                QRScannerView.ask { ok in if ok { scanning = true } }
            }
        }
        pill("x", host.peopleText("nav.close"), muted, id: "people.verify.dismiss") { close() }
    }

    private func note(_ icon: String, _ text: String, _ color: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            DesignIcon(name: icon, size: 18, color: color)
            Text(verbatim: text).font(.system(size: 14, weight: .semibold)).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func pill(_ icon: String, _ label: String, _ color: Color, id: String, _ action: @escaping @MainActor () -> Void) -> some View {
        PeoplePill(icon: icon, label: label, color: color, action: action).accessibilityIdentifier(id)
    }
}

/// A tonal pill with an icon (MsgDetails.button): the actions of People's dialogs.
struct PeoplePill: View {
    let icon: String
    let label: String
    let color: Color
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                DesignIcon(name: icon, size: 16, color: color)
                Text(verbatim: label).font(.system(size: 13.5, weight: .bold)).foregroundStyle(color).lineLimit(2)
            }
            .padding(.leading, 12)
            .padding(.trailing, 14)
            .padding(.vertical, 8)
            .background(color.opacity(0.13), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// The camera scanning a QR code (AVCaptureSession + AVCaptureMetadataOutput; NSCameraUsageDescription):
/// the first code read ends it.
struct QRScannerView: UIViewRepresentable {
    let onResult: @MainActor (String) -> Void

    /// A camera exists (not in the simulator).
    static var available: Bool { AVCaptureDevice.default(for: .video) != nil }

    /// Asks for the camera when needed; true when it may be used.
    static func ask(_ done: @escaping @MainActor (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: done(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { ok in Task { @MainActor in done(ok) } }
        default: done(false)
        }
    }

    func makeUIView(context: Context) -> ScannerView {
        let v = ScannerView()
        v.onResult = onResult
        v.start()
        return v
    }

    func updateUIView(_ uiView: ScannerView, context: Context) { uiView.onResult = onResult }

    static func dismantleUIView(_ uiView: ScannerView, coordinator: ()) { uiView.stop() }

    final class ScannerView: UIView, AVCaptureMetadataOutputObjectsDelegate {
        var onResult: (@MainActor (String) -> Void)?
        private let box = SessionBox()
        private var session: AVCaptureSession { box.session }
        private var done = false

        /// The capture session, started and stopped off the main thread (AVFoundation's advice).
        private final class SessionBox: @unchecked Sendable {
            let session = AVCaptureSession()
        }

        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        private var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        func start() {
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            preview.session = session
            preview.videoGravity = .resizeAspectFill
            let b = box
            DispatchQueue.global(qos: .userInitiated).async { b.session.startRunning() }
        }

        func stop() {
            let b = box
            DispatchQueue.global(qos: .userInitiated).async { if b.session.isRunning { b.session.stopRunning() } }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            let text = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }.first
            MainActor.assumeIsolated {
                guard let text, !done else { return }
                done = true
                stop()
                onResult?(text)
            }
        }
    }
}
