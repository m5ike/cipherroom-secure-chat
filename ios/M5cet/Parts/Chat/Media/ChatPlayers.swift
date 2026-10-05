// ui/media/AudioBar (6.1) and ui/media/VideoBox (6.2): a small player in a bubble —
// play / pause, position, time — for voice messages, audio attachments and the
// recording behind a call transcript; a video's first frame with a play button,
// played in place. The bytes are opened only when played and served from memory
// (ChatMemoryAsset) — no plaintext file. One plays at a time (ChatMedia); leaving
// the screen releases the player.

import AVFoundation
import M5Design
import M5Proto
import Observation
import SwiftUI
import UIKit

/// What a player opens when it plays: the bytes, their type, the file's name.
struct ChatMediaSource {
    let open: @MainActor () throws -> (data: Data, mime: String, name: String)

    static func message(_ m: ChatMessage) -> ChatMediaSource {
        ChatMediaSource { (try ChatVaultMedia.data(m), m.fileMime ?? "audio/mp4", m.fileName ?? "audio.m4a") }
    }
}

/// AudioBar.fmt: "m:ss".
func chatMediaTime(_ ms: Int64) -> String {
    let s = max(0, ms) / 1000
    return "\(s / 60):" + String(format: "%02d", s % 60)
}

@MainActor
@Observable
final class ChatPlayer {
    private(set) var playing = false
    /// 0–1 of the length.
    private(set) var position: Double = 0
    private(set) var durationMs: Int64 = 0
    private(set) var positionMs: Int64 = 0
    private(set) var failed = false
    private(set) var prepared = false
    /// A video's size (rotation applied) — the box follows it.
    var videoSize: CGSize?

    @ObservationIgnored let player = AVPlayer()
    @ObservationIgnored private var source: ChatMediaSource?
    @ObservationIgnored private var asset: ChatMemoryAsset?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private let video: Bool

    init(video: Bool) { self.video = video }

    func set(_ s: ChatMediaSource, durationMs: Int64 = 0) {
        source = s
        if durationMs > 0 && self.durationMs == 0 { self.durationMs = durationMs }
    }

    func toggle() {
        if playing { pause(); return }
        ChatMedia.willPlay(self) { [weak self] in self?.pause() }
        if prepared { start(); return }
        guard let source else { return }
        do {
            let (data, mime, name) = try source.open()
            let a = ChatMemoryAsset(data: data, mime: mime, name: name)
            asset = a
            let item = AVPlayerItem(asset: a.asset)
            player.replaceCurrentItem(with: item)
            endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.ended() }
            }
            timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: video ? 4 : 5), queue: .main) { [weak self] t in
                MainActor.assumeIsolated { self?.tick(t) }
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let d = try? await a.asset.load(.duration), d.isNumeric, d.seconds > 0 { self.durationMs = Int64((d.seconds * 1000).rounded()) }
                let status = try? await a.asset.load(.isPlayable)
                if status == false { self.fail(); return }
            }
            prepared = true
            start()
        } catch {
            fail()
        }
    }

    private func start() {
        let session = AVAudioSession.sharedInstance()
        // A call holds the session (playAndRecord): play within it; else as spoken media.
        if session.category != .playAndRecord {
            try? session.setCategory(.playback, mode: video ? .moviePlayback : .spokenAudio)
            try? session.setActive(true)
        }
        player.play()
        playing = true
    }

    func pause() {
        player.pause()
        playing = false
    }

    func seek(_ fraction: Double) {
        guard prepared, durationMs > 0 else { return }
        let t = CMTime(value: CMTimeValue(Double(durationMs) * min(1, max(0, fraction))), timescale: 1000)
        player.seek(to: t)
        position = fraction
    }

    private func tick(_ t: CMTime) {
        guard t.isNumeric else { return }
        positionMs = Int64((t.seconds * 1000).rounded())
        if let d = player.currentItem?.duration, d.isNumeric, d.seconds > 0 { durationMs = Int64((d.seconds * 1000).rounded()) }
        position = durationMs > 0 ? min(1, Double(positionMs) / Double(durationMs)) : 0
        if player.currentItem?.status == .failed { fail() }
    }

    private func ended() {
        playing = false
        position = 0
        positionMs = 0
        player.seek(to: .zero)
    }

    private func fail() {
        failed = true
        playing = false
        release()
    }

    func release() {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        asset = nil
        prepared = false
        playing = false
        ChatMedia.released(self)
    }
}

/// AudioBar: a play / pause circle, the position, the time.
struct ChatAudioBar: View {
    let source: ChatMediaSource
    var durationMs: Int64 = 0
    let fg: Color
    let accent: Color
    let t: (String) -> String
    /// Starts playing as soon as it is shown (the transcript's recording).
    var autoplay = false
    @State private var player = ChatPlayer(video: false)
    @State private var dragging: Double?

    var body: some View {
        HStack(spacing: 0) {
            Button { player.toggle() } label: {
                DesignIcon(name: player.playing ? "square" : "play", size: 18, color: fg)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(accent.opacity(0.18)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            .accessibilityLabel(Text(verbatim: t(player.playing ? "media.a11y.pause" : "media.a11y.play")))
            SeekBar(value: dragging ?? player.position, fg: fg, accent: accent) { v, done in
                guard player.prepared else { return }
                dragging = done ? nil : v
                if done { player.seek(v) }
            }
            .padding(.horizontal, 10)
            .accessibilityHidden(true)
            Text(verbatim: timeText)
                .font(.system(size: 11.5).monospacedDigit())
                .foregroundStyle(fg.opacity(0.8))
        }
        .frame(minWidth: 200)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: t("media.a11y.audio")))
        .onAppear {
            player.set(source, durationMs: durationMs)
            if autoplay { player.toggle() }
        }
        .onDisappear { player.release() }
    }

    private var timeText: String {
        if player.failed { return "⚠" }
        if player.playing { return chatMediaTime(player.positionMs) }
        return player.durationMs > 0 ? chatMediaTime(player.durationMs) : "▶"
    }
}

/// AudioBar's SeekBar: a thin track, the played part and the thumb in the accent colour; dragging seeks.
private struct SeekBar: View {
    let value: Double
    let fg: Color
    let accent: Color
    let change: (Double, Bool) -> Void

    var body: some View {
        GeometryReader { g in
            let w = max(1, g.size.width)
            let x = CGFloat(min(1, max(0, value))) * w
            ZStack(alignment: .leading) {
                Capsule().fill(fg.opacity(0.22)).frame(height: 3)
                Capsule().fill(accent).frame(width: x, height: 3)
                Circle().fill(accent).frame(width: 12, height: 12).offset(x: x - 6)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    ChatState.shared.controlTouchAt = Date()
                    change(Double(min(w, max(0, v.location.x)) / w), false)
                }
                .onEnded { v in change(Double(min(w, max(0, v.location.x)) / w), true) })
        }
        .frame(height: 28)
    }
}

/// VideoBox: the first frame with a play button, played in place on tap; the time in the corner.
struct ChatVideoBox: View {
    let message: ChatMessage
    let maxWidth: CGFloat
    let t: (String) -> String
    @State private var player = ChatPlayer(video: true)
    @State private var poster: UIImage?
    @State private var ratio: CGFloat = 16 / 9
    @State private var durationMs: Int64 = 0

    var body: some View {
        let size = boxSize
        ZStack {
            Color.black
            ChatPlayerLayerView(player: player.player)
            if !player.playing, let poster, player.positionMs == 0 {
                Image(uiImage: poster).resizable().scaledToFill()
            }
            if !player.playing {
                DesignIcon(name: "play", size: 26, color: .white)
                    .frame(width: 56, height: 56)
                    .background(Circle().fill(Color.black.opacity(0.6)))
            }
            if durationMs > 0 || player.failed || player.playing {
                Text(verbatim: player.failed ? "⚠" : player.playing ? chatMediaTime(player.positionMs) + " / " + chatMediaTime(max(durationMs, player.durationMs)) : chatMediaTime(durationMs))
                    .font(.system(size: 11.5).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.5)))
                    .padding(6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .contentShape(Rectangle())
        .onTapGesture { player.toggle() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: t("media.a11y.video")))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { player.toggle() }
        .task(id: message.id) { await loadFrame() }
        .onAppear { player.set(.message(message)) }
        .onDisappear { player.release() }
    }

    /// VideoBox.onMeasure: the box's width, its height by the video's ratio (120–340).
    private var boxSize: CGSize {
        var w = maxWidth
        var h = (w / max(0.3, ratio)).rounded()
        if h > 340 { h = 340; w = min(maxWidth, (h * ratio).rounded()) }
        return CGSize(width: w, height: max(120, h))
    }

    private func loadFrame() async {
        let key = message.id + "#video"
        if let meta = ChatState.shared.meta(key) as? (Int, Int, Int64) {
            poster = ChatState.shared.image(message.id + "#poster")
            apply(meta.0, meta.1, meta.2)
            return
        }
        guard let data = try? ChatVaultMedia.data(message) else { return }
        let asset = ChatMemoryAsset(data: data, mime: message.fileMime ?? "video/mp4", name: message.fileName ?? "video.mp4")
        guard let f = await MediaPreviews.videoFrame(asset.asset, maxPx: 720) else { return }
        if let img = f.image { ChatState.shared.putImage(img, message.id + "#poster"); poster = img }
        ChatState.shared.putMeta((f.width, f.height, f.durationMs), key)
        apply(f.width, f.height, f.durationMs)
    }

    private func apply(_ w: Int, _ h: Int, _ d: Int64) {
        if w > 0 && h > 0 { ratio = CGFloat(w) / CGFloat(h) }
        durationMs = d
    }
}

/// The player's picture (AVPlayerLayer).
struct ChatPlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    final class LayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let v = LayerView()
        v.playerLayer.videoGravity = .resizeAspect
        v.playerLayer.player = player
        v.isUserInteractionEnabled = false
        return v
    }

    func updateUIView(_ v: LayerView, context: Context) { v.playerLayer.player = player }
}
