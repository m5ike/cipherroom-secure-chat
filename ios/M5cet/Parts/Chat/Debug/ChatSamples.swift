// DEBUG only: what the chat parts add to the sample core (Core/Preview) for previews
// and screenshots (`-M5Screen room`): a picture and a voice message from Alice, a
// model's answer, a text file, an operator's notice — and a map policy with drawn
// stand-in tiles (the sample server does not exist). Launch arguments of the chat:
//   -M5ChatMenu <message id>     the long-press menu of that message
//   -M5ChatReply <message id>    the composer answers it
//   -M5ChatScrollTo <message id> the list scrolls there
//   -M5ChatPlace <message id>    the place sheet of that message
//   -M5ChatHold <message id>     the message is held (shown)
//   -M5ChatText <text>           the composer's field
//   -M5ChatNoKeyboard YES        the keyboard goes down again
// Never compiled into Release.

#if DEBUG
import AVFoundation
import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

@MainActor
enum ChatSamples {
    private static var done = false

    static var arg: (String) -> String? = { key in
        UserDefaults.standard.string(forKey: key).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Once, in sample mode: the extra messages, the map, and what the launch arguments ask for.
    static func start(_ host: DesignHost) {
        guard !done, DebugLaunch.screen != nil, let room = CoreModels.shared.rooms.active as? PreviewRoom else { return }
        done = true
        augment(room)
        emptySlots(host) // at once: a slot drawn already is not drawn again for a new factory
        Task { await prepare(host, room: room) }
        let composer = CoreModels.shared.composer(for: host)
        if let id = arg("M5ChatReply") { composer.setReply(id) }
        if let text = arg("M5ChatText") { composer.text = text }
        Task {
            try? await Task.sleep(for: .milliseconds(700))
            if let id = arg("M5ChatScrollTo") { ChatState.shared.window(host).scrollTarget = id == "top" ? room.messages.first?.id : id }
            // Pictures without the keyboard (a reply gives the field the focus).
            if UserDefaults.standard.bool(forKey: "M5ChatNoKeyboard") {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
            if let id = arg("M5ChatHold") { ChatState.shared.hold(id, true) }
            try? await Task.sleep(for: .milliseconds(500))
            if let id = arg("M5ChatMenu"), let m = room.message(id) { ChatActions.menu(m, host: host, anchor: "msg/" + id) }
            if let id = arg("M5ChatPlace"), let m = room.message(id) { PlaceSheet.show(m, host: host) }
        }
    }

    /// The sample room's extra messages, the map's stand-in tiles and policy, other parts' slots drawn empty.
    static func prepare(_ host: DesignHost, room: PreviewRoom) async {
        if room.message("s1") == nil { augment(room) }
        emptySlots(host)
        // The stand-in tiles first, then the policy: no preview asks the (non-existent) sample server.
        let server = CoreModels.shared.server
        await MapTiles.shared.seedForTesting(server: server)
        ChatMapPolicies.setForTesting(ChatMapPolicy.parse(JSONObject([("map", .object(JSONObject()))])), server: server)
        ChatState.shared.mapPolicyChanged()
    }

    /// Slots of other parts not registered yet draw nothing in the chat's pictures (not the DEBUG outline).
    static func emptySlots(_ host: DesignHost) {
        for name in ["userPanel", "roomTabs"] where !host.services.slots.has(name) {
            host.services.slots.register(name) { _ in AnyView(Color.clear.frame(idealWidth: 0, idealHeight: 0)) }
        }
        host.refresh()
    }

    /// A picture, a voice message, a text file, a model's answer, a notice and a hidden one in the sample room.
    static func augment(_ room: PreviewRoom) {
        var t = (room.messages.last?.createdAt ?? PreviewCore.t0) + 60_000
        func add(_ id: String, from: String = "Alice", mine: Bool = false, _ edit: (inout ChatMessage) -> Void) {
            var m = ChatMessage()
            m.id = id; m.roomKey = room.key; m.createdAt = t; m.mine = mine; m.verified = true
            m.senderName = mine ? "Mike" : from; m.senderId = mine ? "peer-me" : (from == "Alice" ? "peer-alice" : "peer-bob")
            m.status = mine ? "delivered" : "received"
            m.mark("created", "", at: t)
            edit(&m)
            room.messages.append(m)
            t += 45_000
        }
        add("s1") { m in
            m.text = "Výhled z kanceláře"
            m.fileName = "IMG_2041.jpg"; m.fileMime = "image/jpeg"; m.fileImage = true
            let jpeg = picture()
            m.fileSize = Int64(jpeg.count)
            m.fileDataUrl = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        }
        add("s2", from: "Bob") { m in
            m.fileName = "hlas-1760000300000.m4a"; m.fileMime = "audio/mp4"
            let clip = voiceClip()
            m.fileSize = Int64(clip.count)
            m.fileDataUrl = "data:audio/mp4;base64," + clip.base64EncodedString()
        }
        add("s3", mine: true) { m in
            m.text = "Poznámky z porady:"
            m.fileName = "porada.txt"; m.fileMime = "text/plain"
            let text = Data("1. Rozpočet na Q4\n2. Nový server do konce měsíce\n3. Školení v pátek\n".utf8)
            m.fileSize = Int64(text.count)
            m.fileDataUrl = "data:text/plain;base64," + text.base64EncodedString()
        }
        add("s4", from: ModelIdentity.systemMessengerId) { m in
            m.senderName = "Počasí"
            m.senderId = ModelIdentity.systemMessengerId
            m.model = ModelIdentity.of("weather", "Počasí", nil).toJson()
            m.text = "Praha: 14 °C, polojasno. Zítra déšť."
        }
        add("s5", from: "Alice") { m in
            m.text = "Tohle je skryté do zítřka"
            m.hiddenUntil = Millis.now + 86_400_000
        }
        add("s6", from: "Alice") { m in
            m.text = "Prosím, kdo vezme #faktury tento týden? @Mike"
            m.replyToId = "m2"; m.replyToSender = "Mike"; m.replyToText = "Dobře, díky! Posílám plán na zítřek."
        }
        room.lastActivity = t
    }

    /// A small landscape for the picture message.
    private static func picture() -> Data {
        let size = CGSize(width: 640, height: 420)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let img = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let c = ctx.cgContext
            let sky = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [UIColor(red: 0.36, green: 0.62, blue: 0.93, alpha: 1).cgColor,
                                                                                         UIColor(red: 0.98, green: 0.80, blue: 0.62, alpha: 1).cgColor] as CFArray, locations: [0, 1])!
            c.drawLinearGradient(sky, start: .zero, end: CGPoint(x: 0, y: 300), options: [])
            UIColor(red: 1, green: 0.85, blue: 0.4, alpha: 1).setFill()
            c.fillEllipse(in: CGRect(x: 450, y: 70, width: 90, height: 90))
            UIColor(red: 0.20, green: 0.42, blue: 0.30, alpha: 1).setFill()
            let hills = UIBezierPath()
            hills.move(to: CGPoint(x: 0, y: 300))
            hills.addCurve(to: CGPoint(x: 640, y: 280), controlPoint1: CGPoint(x: 200, y: 180), controlPoint2: CGPoint(x: 420, y: 360))
            hills.addLine(to: CGPoint(x: 640, y: 420)); hills.addLine(to: CGPoint(x: 0, y: 420)); hills.close()
            hills.fill()
            UIColor(red: 0.12, green: 0.30, blue: 0.22, alpha: 1).setFill()
            for i in 0..<9 { c.fill(CGRect(x: 40 + i * 70, y: 330 - (i % 3) * 14, width: 26, height: 90)) }
        }
        return img.jpegData(compressionQuality: 0.7) ?? Data()
    }

    /// Two seconds of a soft tone as AAC in an .m4a (written to a temporary file, read, deleted).
    private static func voiceClip() -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("m5-sample-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: url) }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
              let file = try? AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1]),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32_000) else { return Data() }
        buffer.frameLength = 32_000
        let p = buffer.floatChannelData![0]
        for i in 0..<32_000 { p[i] = Float(sin(Double(i) * 2 * .pi * 330 / 16_000) * 0.2 * min(1, Double(32_000 - i) / 4000)) }
        try? file.write(from: buffer)
        return (try? Data(contentsOf: url)) ?? Data()
    }
}

extension MapTiles {
    /// DEBUG: stand-in tiles (a plain land with streets) for the sample server, so the map preview can be seen.
    func seedForTesting(server: String) {
        let p = ChatMapPolicy.parse(JSONObject([("map", .object(JSONObject()))]))
        let tiles = MapTileMath.tiles(50.08804, 14.42076, p.zoom, Double(p.width), Double(p.height))
            + MapTileMath.tiles(50.08804, 14.42076, p.zoom, 560, 320)
        for t in Set(tiles) {
            let img = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256)).image { ctx in
                UIColor(red: 0.95, green: 0.94, blue: 0.91, alpha: 1).setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
                UIColor(red: 0.80, green: 0.88, blue: 0.80, alpha: 1).setFill()
                ctx.fill(CGRect(x: 30 + (t.x % 3) * 40, y: 40, width: 70, height: 60))
                UIColor.white.setStroke()
                for k in 0..<4 {
                    let path = UIBezierPath()
                    path.lineWidth = k % 2 == 0 ? 9 : 5
                    path.move(to: CGPoint(x: 0, y: 30 + k * 64 + (t.y % 2) * 12))
                    path.addLine(to: CGPoint(x: 256, y: 50 + k * 60))
                    path.stroke()
                    let v = UIBezierPath()
                    v.lineWidth = 6
                    v.move(to: CGPoint(x: 40 + k * 66, y: 0)); v.addLine(to: CGPoint(x: 20 + k * 70, y: 256))
                    v.stroke()
                }
            }
            seed(server + "|" + p.tiles + p.subdomains + "|" + t.description, img.pngData() ?? Data())
        }
    }
}
#endif
