// A WebRTC video track in SwiftUI: RTCMTLVideoView (Metal) as the track's
// renderer — attached while the view is on screen, detached when it goes or
// the track changes (Android CallParts.Video: SurfaceViewRenderer + addSink).

import SwiftUI
@preconcurrency import WebRTC

struct RtcVideoView: UIViewRepresentable {
    let track: RTCVideoTrack?
    /// The front camera's own picture is shown mirrored (as a mirror would).
    var mirrored = false
    /// Fill the tile (crop) or fit the whole picture.
    var fill = true

    final class Coordinator {
        var track: RTCVideoTrack?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.clipsToBounds = true
        view.backgroundColor = .black
        configure(view, context: context)
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        configure(view, context: context)
    }

    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track?.remove(view)
        coordinator.track = nil
    }

    private func configure(_ view: RTCMTLVideoView, context: Context) {
        view.videoContentMode = fill ? .scaleAspectFill : .scaleAspectFit
        view.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        guard context.coordinator.track !== track else { return }
        context.coordinator.track?.remove(view)
        track?.add(view)
        context.coordinator.track = track
    }
}
