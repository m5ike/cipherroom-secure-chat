// The call's controls (Android CallParts.Controls): mute, speaker or the
// system route picker (a headset, Bluetooth, AirPlay), video (start the camera
// / camera on-off once it runs; a long press switches front / back), the
// camera switch, hang up. Everything goes through CallSystem, so CallKit's
// screen shows the same state.

import AVKit
import SwiftUI

struct CallControls: View {
    let room: RoomRtc
    var system: CallSystem = .shared
    var environment: (any CallEnvironment)?
    var regular = false

    private var audio: CallAudioSession { CallAudioSession.shared }

    var body: some View {
        let _ = room.revision
        HStack(spacing: regular ? 22 : 14) {
            round(room.audioState == .muted ? "mic.slash.fill" : "mic.fill", key: "call.mute",
                  on: room.audioState == .muted, id: "call.mute") {
                system.toggleMute(roomKey: room.roomKey)
            }
            routeButton
            round(room.videoOn && !room.cameraOn ? "video.slash.fill" : "video.fill", key: "call.video",
                  on: room.videoOn && room.cameraOn, id: "call.video") {
                if room.videoOn { room.toggleCamera() } else { Task { await system.startCall(roomKey: room.roomKey, video: true) } }
            }
            .simultaneousGesture(LongPressGesture().onEnded { _ in Task { await room.switchCamera() } })
            if room.videoOn {
                round("arrow.triangle.2.circlepath.camera.fill", key: "call.video", on: false, id: "call.switchCamera") {
                    Task { await room.switchCamera() }
                }
            }
            Button {
                system.endCall(roomKey: room.roomKey)
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .frame(width: size, height: size)
                    .background(Color.red, in: Circle())
                    .foregroundStyle(.white)
            }
            .accessibilityLabel(Text(verbatim: CallTexts.t("call.end", environment)))
            .accessibilityIdentifier("call.end")
        }
        .padding(.horizontal, regular ? 28 : 12)
        .padding(.vertical, regular ? 16 : 0)
        .background {
            if regular { Capsule().fill(.white.opacity(0.08)) }
        }
    }

    private var size: CGFloat { regular ? 68 : 60 }

    /// Speaker / earpiece; with a headset, Bluetooth or car output the system's route picker.
    @ViewBuilder
    private var routeButton: some View {
        if case .external = audio.route {
            RoutePicker()
                .frame(width: size, height: size)
                .background(.white.opacity(0.2), in: Circle())
                .accessibilityIdentifier("call.route")
        } else {
            round(audio.route == .speaker ? "speaker.wave.2.fill" : "ear", key: "call.audio",
                  on: audio.route == .speaker, id: "call.speaker") {
                system.toggleSpeaker()
            }
        }
    }

    private func round(_ symbol: String, key: String, on: Bool, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .semibold))
                .frame(width: size, height: size)
                .background(on ? Color.white : Color.white.opacity(0.2), in: Circle())
                .foregroundStyle(on ? Color.black : Color.white)
        }
        .accessibilityLabel(Text(verbatim: CallTexts.t(key, environment)))
        .accessibilityIdentifier(id)
    }
}

/// AVRoutePickerView: the system's own choice of the call's audio output.
private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.activeTintColor = .white
        v.prioritizesVideoDevices = false
        return v
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
