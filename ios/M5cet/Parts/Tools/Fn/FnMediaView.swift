// A function's sound or video — a port of android/…/fn/FnMedia.java (FnMedia
// in FnOutputs.tsx): a small player over the output's bytes written to a file
// (the app's temporary directory, complete file protection, deleted when the
// player goes). Nothing is prepared before the first tap — unless the message
// is fresh and the output asks to autoplay (once).

import AVFoundation
import CryptoKit
import M5Core
import SwiftUI

struct FnMediaView: View {
    let o: JSONObject
    /// The once-key of an autoplay (nil: no autoplay).
    let autoplayOnce: String?
    let look: ToolsLook
    /// It could not be played (reported once).
    let failed: (String) -> Void

    @State private var player: AVPlayer?
    @State private var file: URL?
    @State private var playing = false
    @State private var preparing = false
    @State private var broken = false
    @State private var position: Double = 0
    @State private var duration: Double = 0
    @State private var ticker: Task<Void, Never>?

    private var video: Bool { o.optString("type") == "video" }
    private var loop: Bool { o["loop"] == .bool(true) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = o.string("title"), !title.isEmpty {
                Text(verbatim: title).toolsFont(14).foregroundStyle(look.color("@onSurface"))
            }
            if video {
                ZStack {
                    Color.black
                    if let player { FnVideoSurface(player: player) }
                    if !playing { playButton }
                }
                .frame(height: 200)
                .contentShape(Rectangle())
                .onTapGesture { toggle() }
            } else {
                HStack(spacing: 8) {
                    playButton
                    Slider(value: Binding(get: { position }, set: { v in position = v; player?.seek(to: CMTime(seconds: v, preferredTimescale: 600)) }),
                           in: 0...max(duration, 0.01))
                        .disabled(player == nil || preparing)
                        .tint(look.color("@primary"))
                    Text(verbatim: Self.clock(position) + " / " + Self.clock(duration))
                        .toolsFont(12, design: .monospaced).foregroundStyle(look.color("@muted"))
                }
            }
        }
        .onAppear {
            if let k = autoplayOnce, FnOnce.firstTime(k) { toggle() }
        }
        .onDisappear { release() }
    }

    private var playButton: some View {
        Button { toggle() } label: {
            Text(verbatim: broken ? "✕" : preparing ? "…" : playing ? "❚❚" : "▶")
                .toolsFont(16)
                .foregroundStyle(look.color("@onPrimary"))
                .frame(width: 40, height: 40)
                .background(Circle().fill(look.color("@primary")))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: look.words("fnui.play")))
    }

    private func toggle() {
        if broken || preparing { return }
        if let player {
            if playing { player.pause(); playing = false } else { player.play(); playing = true; tick() }
            return
        }
        preparing = true
        let b64 = o.optString("data"), mime = o.optString("mime")
        Task { @MainActor in
            let made = await Task.detached(priority: .userInitiated) { () -> Result<URL, FnFailure> in
                guard let bytes = Data(base64Encoded: b64) else { return .failure(.network("not base64 media")) }
                do { return .success(try FnMediaFiles.write(bytes, mime: mime)) } catch { return .failure(.network(String(describing: error))) }
            }.value
            switch made {
            case .failure(let f): fail(f.message)
            case .success(let url): open(url)
            }
        }
    }

    private func open(_ url: URL) {
        file = url
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        player = p
        Task { @MainActor in
            do {
                let d = try await item.asset.load(.duration)
                duration = d.seconds.isFinite ? d.seconds : 0
                preparing = false
                p.play()
                playing = true
                tick()
            } catch {
                fail("the \(video ? "video" : "audio") could not be played (\(error.localizedDescription))")
            }
        }
    }

    /// The position, four times a second while it plays.
    private func tick() {
        ticker?.cancel()
        ticker = Task { @MainActor in
            while !Task.isCancelled, let p = player {
                position = p.currentTime().seconds.isFinite ? p.currentTime().seconds : 0
                if duration > 0 && position >= duration - 0.05 {
                    if loop { await p.seek(to: .zero); p.play() } else { playing = false; p.pause(); await p.seek(to: .zero); position = 0; break }
                }
                if !playing { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    private func fail(_ why: String) {
        broken = true
        preparing = false
        failed(why)
        release()
    }

    /// Stops and lets go of the player (the next tap prepares it again).
    private func release() {
        ticker?.cancel()
        player?.pause()
        player = nil
        playing = false
        if let file { FnMediaFiles.discard(file) }
        file = nil
    }

    static func clock(_ s: Double) -> String {
        let t = Int(max(0, s.isFinite ? s : 0))
        return String(format: "%d:%02d", t / 60, t % 60)
    }
}

/// The player's layer.
private struct FnVideoSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerView {
        let v = PlayerView()
        v.playerLayer.player = player
        v.playerLayer.videoGravity = .resizeAspect
        return v
    }

    func updateUIView(_ v: PlayerView, context: Context) { v.playerLayer.player = player }

    final class PlayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// Where a sound's or video's bytes wait to be played.
enum FnMediaFiles {
    static var dir: URL { FileManager.default.temporaryDirectory.appendingPathComponent("fn-media", isDirectory: true) }

    /// The bytes as a file named by their hash (written once), protected while the device is locked.
    static func write(_ bytes: Data, mime: String) throws -> URL {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let ext = String(mime.drop { $0 != "/" }.dropFirst()).replacingOccurrences(of: "mpeg", with: "mp3").replacingOccurrences(of: "x-", with: "")
        let url = dir.appendingPathComponent(hash + "." + (ext.isEmpty ? "bin" : ext))
        if (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) != bytes.count {
            try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        }
        return url
    }

    static func discard(_ url: URL) { try? FileManager.default.removeItem(at: url) }

    /// The lock: nothing of a played output stays.
    static func forget() { try? FileManager.default.removeItem(at: dir) }
}
