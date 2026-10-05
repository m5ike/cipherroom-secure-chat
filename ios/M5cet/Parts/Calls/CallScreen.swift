// The in-app call screen of a room (Android: the design's "call" screen with
// the callControls and video slots — ui/parts/CallParts): everyone in the call
// as tiles (their video, or their initials and whether they are muted), my
// camera in a corner, the room, how long, how the link is (RTT, direct or
// through TURN), and the controls. CallKit's own screen stays the system's;
// this is the app's while it is in front.
//
// iPhone: up to two columns, my camera small in the corner. iPad (regular
// width): up to four columns, a larger corner picture, the controls in a bar.

import SwiftUI
@preconcurrency import WebRTC

struct CallScreen: View {
    let room: RoomRtc
    var system: CallSystem = .shared
    var environment: (any CallEnvironment)?
    /// Leaves the screen (the call goes on; the room's own view shows it).
    var onClose: (() -> Void)?

    @Environment(\.horizontalSizeClass) private var widthClass

    private var regular: Bool { widthClass == .regular }

    var body: some View {
        let _ = room.revision
        ZStack {
            Color.black.ignoresSafeArea()
            CallParticipantsGrid(room: room, regular: regular)
                .padding(.horizontal, regular ? 24 : 8)
                .padding(.top, regular ? 96 : 84)
                .padding(.bottom, regular ? 132 : 150)
            VStack(spacing: 0) {
                header
                Spacer(minLength: 0)
                CallControls(room: room, system: system, environment: environment, regular: regular)
                    .padding(.bottom, regular ? 28 : 16)
            }
            if let mine = room.localVideo {
                localPreview(mine)
            }
        }
        .preferredColorScheme(.dark)
        .task(id: room.roomKey) {
            while !Task.isCancelled {
                await room.refreshStats()
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .accessibilityIdentifier("call.screen")
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: room.roomLabel.isEmpty ? CallTexts.t(room.videoOn ? "call.video" : "call.audio", environment) : room.roomLabel)
                    .font(regular ? .title2.weight(.semibold) : .headline)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    if let since = room.startedAt {
                        TimelineView(.periodic(from: since, by: 1)) { ctx in
                            Text(verbatim: CallLogItems.length(Int64(ctx.date.timeIntervalSince(since))).ifEmpty("0:00"))
                                .monospacedDigit()
                        }
                    }
                    if let link = linkLine { Text(verbatim: link) }
                }
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))
            }
            Spacer()
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "chevron.down")
                        .font(.title3.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .background(.white.opacity(0.12), in: Circle())
                }
                .foregroundStyle(.white)
                .accessibilityLabel(Text(verbatim: CallTexts.t("nav.close", environment)))
            }
        }
        .padding(.horizontal, regular ? 32 : 16)
        .padding(.top, 12)
    }

    /// "48 ms · direct" — the worst round trip of the call and how it goes.
    private var linkLine: String? {
        let stats = room.peers.compactMap(\.stats)
        guard !stats.isEmpty else { return nil }
        let rtt = stats.map(\.rttMs).max() ?? -1
        let relay = stats.contains { $0.transport == "relay" }
        var parts: [String] = []
        if rtt >= 0 { parts.append("\(rtt) ms") }
        parts.append(relay ? "TURN" : "P2P")
        return parts.joined(separator: " · ")
    }

    private func localPreview(_ track: RTCVideoTrack) -> some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                ZStack {
                    RtcVideoView(track: track, mirrored: room.frontCamera)
                    if !room.cameraOn {
                        Color.black
                        Image(systemName: "video.slash").foregroundStyle(.white.opacity(0.8))
                    }
                }
                .frame(width: regular ? 180 : 110, height: regular ? 240 : 160)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(.white.opacity(0.25), lineWidth: 1))
                .onTapGesture(count: 2) { Task { await room.switchCamera() } }
                .padding(.trailing, regular ? 32 : 12)
                .padding(.bottom, regular ? 140 : 160)
                .accessibilityIdentifier("call.localVideo")
            }
        }
    }
}

/// Everyone in the call (their audio is on) and everyone who sends video, as tiles.
struct CallParticipantsGrid: View {
    let room: RoomRtc
    let regular: Bool

    var body: some View {
        let _ = room.revision
        let people = room.peers.filter { $0.audio != .off || $0.remoteVideo != nil }
        GeometryReader { geo in
            let n = max(1, people.count)
            let cols = columns(n, landscape: geo.size.width > geo.size.height)
            let rows = Int((Double(n) / Double(cols)).rounded(.up))
            let spacing: CGFloat = 8
            let height = max(120, (geo.size.height - spacing * CGFloat(rows - 1)) / CGFloat(rows))
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: spacing), count: cols), spacing: spacing) {
                    ForEach(people, id: \.id) { p in
                        CallTile(peer: p)
                            .frame(height: height)
                    }
                }
            }
            .scrollDisabled(rows * Int(height) <= Int(geo.size.height) + 1)
            .overlay {
                if people.isEmpty { waiting }
            }
        }
    }

    /// One column for one or two people on a phone held upright, two for more; up to four on an iPad.
    private func columns(_ n: Int, landscape: Bool) -> Int {
        if n <= 1 { return 1 }
        if regular { return n <= 4 ? 2 : n <= 9 ? 3 : 4 }
        if n == 2 { return landscape ? 2 : 1 }
        return 2
    }

    private var waiting: some View {
        VStack(spacing: 12) {
            Image(systemName: room.videoOn ? "video" : "phone")
                .font(.system(size: 44, weight: .light))
            Text(verbatim: room.roomLabel)
                .font(.title3)
        }
        .foregroundStyle(.white.opacity(0.7))
    }
}

/// One person in the call: their video, or their initials; their name and whether they are muted.
struct CallTile: View {
    let peer: RtcPeer

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let video = peer.remoteVideo {
                RtcVideoView(track: video)
            } else {
                Color(white: 0.14)
                Text(verbatim: Self.initials(peer.name))
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(width: 84, height: 84)
                    .background(Self.color(peer.name), in: Circle())
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 6) {
                Image(systemName: peer.audio == .muted ? "mic.slash.fill" : peer.audio == .live ? "mic.fill" : "mic")
                Text(verbatim: peer.name).lineLimit(1)
                if peer.status != .open { Image(systemName: "wifi.exclamationmark") }
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.black.opacity(0.45), in: Capsule())
            .padding(8)
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    /// The first letters of up to two words ("Alice Novak" → "AN").
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
        let letters = words.prefix(2).compactMap { $0.first.map { String($0).uppercased() } }
        return letters.isEmpty ? "?" : letters.joined()
    }

    /// A stable colour per name (the web's monogram colours are a hash of the name too).
    static func color(_ name: String) -> Color {
        let hue = Double(UInt32(bitPattern: CallLogItems.javaHash(name)) % 360) / 360
        return Color(hue: hue, saturation: 0.55, brightness: 0.6)
    }
}

extension String {
    fileprivate func ifEmpty(_ other: String) -> String { isEmpty ? other : self }
}
