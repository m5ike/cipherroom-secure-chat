// Contract for the parts (Core/README.md § Skladač): the composer's state and
// what Send does — the non-view half of android/…/ui/parts/Composer.java and of
// Parts.{sendComposer, replyTo, composerAction, messageKind, sendOption,
// composerScope, pickRecipients, composerWrite, focusComposer}. One per window
// (its $form holds the message kinds and the recipients, as on Android).
//
// The composer part (chat agent) draws the field over `text`, the reply quote
// over `replyTo`, the chips over `plan` / `recipientNames`, and does what
// `request` asks (a picker, the camera, recording, dictation — UI the core
// cannot do), then calls back: sendImage / sendFile / sendBytes / sendVoiceClip.
// The design's actions (message.send, compose, message.kind, send.option,
// message.recipients, message.reply) reach the same model through the router.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Proto
import Observation
import UIKit

/// What the composer part must do now (it clears `request` when it took it).
enum ComposerRequest: Equatable, Sendable {
    /// compose photo: the photo picker (Android ACTION_OPEN_DOCUMENT image/*).
    case pickPhoto
    /// compose camera.
    case camera
    /// compose file: the document picker.
    case pickFile
    /// compose voice: record a voice message (the microphone, ≤ 15 min).
    case recordVoice
    /// compose voiceText: speak and send it as text (dictation, or recorded and transcribed by the server).
    case recordText
    /// compose asVoice / Send with "as voice": the field's text (or what is dictated now) spoken and sent as a voice message.
    case speakAsVoice
    /// compose dictate: dictation into the field on / off.
    case toggleDictation
    /// The send button with the dictation step (SendPlan.dictateSpeak / dictateText).
    case dictateThenSend(asVoice: Bool)
}

/// A position for the message header or a position message ({lat, lon, acc, at} — Where.json).
protocol PositionSource: AnyObject {
    @MainActor var permitted: Bool { get }
    /// The latest fix without waiting (nil = none yet).
    @MainActor func recent() -> JSONObject?
    /// A fresh fix (nil = none / refused); asks for the permission when needed.
    @MainActor func current() async -> JSONObject?
}

@MainActor
@Observable
final class ComposerModel {
    /// Pictures and files up to this size go inline in the message (Composer.INLINE_MAX); bigger ones by transfer.
    static let inlineMax = 96 * 1024

    /// The field's text (the part binds its TextField / TextEditor to it).
    var text = ""
    /// The message being answered (the quote over the field), nil = none.
    private(set) var replyTo: ChatMessage?
    /// What the part must do now (a picker, recording…); the part sets it to nil when it took it.
    var request: ComposerRequest?
    /// Bumped when the field should get the focus and the keyboard (a private message chosen, compose write:…).
    private(set) var focusRequests = 0
    /// Bumped when the kinds / recipients changed outside the part (the chips redraw).
    private(set) var revision = 0
    /// A voice step (dictating, speaking a text) is running — Send waits (SendPlan.Step.wait).
    var voiceBusy = false

    @ObservationIgnored weak var host: DesignHost?
    @ObservationIgnored private let core: CoreModels

    init(host: DesignHost?, core: CoreModels) {
        self.host = host
        self.core = core
    }

    // MARK: state the part reads

    /// The room the composer sends into (the active one).
    var room: (any RoomModel)? { core.rooms.active }

    /// The options of the next message from $form (tap, vanish, seal code, as voice, voice text).
    var plan: SendPlan { _ = revision; return SendPlan.of(form.jsonForm) }

    /// Who gets the next message ($form.msgTo: peer ids; empty = everyone).
    var recipientIds: [String] {
        _ = revision
        return (form["msgTo"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }

    /// Their names (the ones still in the room).
    var recipientNames: [String] { recipientIds.compactMap { room?.peerName($0) } }

    /// $composer of the "attach" and "send.options" sheets.
    var scope: DesignValue {
        let p = plan
        return ["hasText": .bool(!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty), "tap": .bool(p.tap),
                "vanish": .number(Double(p.vanishSeconds)), "sealed": .bool(p.sealed), "sealCode": .string(p.sealCode ?? ""),
                "asVoice": .bool(p.asVoice), "voiceText": .bool(p.voiceText), "count": .number(Double(p.count)),
                "private": .bool(form["msgTo"] != nil)]
    }

    private var form: [String: DesignValue] {
        get { host?.form ?? [:] }
        set { host?.form = newValue }
    }

    private var settings: SettingsModel { host?.settings ?? SettingsModel() }

    // MARK: the field

    /// message.reply / a swipe: answer this message (nil = no reply).
    func setReply(_ id: String?) {
        guard let id, let m = room?.message(id) else { replyTo = nil; return }
        replyTo = m
        focus()
    }

    func clearReply() { replyTo = nil }

    /// The field gets the focus and the keyboard.
    func focus() { focusRequests &+= 1 }

    /// compose "write:/keyword": a command's start into the field (only "/keyword ", never other text).
    func write(_ command: String) {
        let t = command.trimmingCharacters(in: .whitespaces)
        guard let first = t.first else { return }
        let chars = core.fn?.commandChars ?? ["/"]
        let rest = t.dropFirst()
        guard chars.contains(String(first)), (1...40).contains(rest.count),
              rest.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" }) else { return }
        text = t + " "
        focus()
    }

    // MARK: kinds and recipients ($form)

    /// message.kind: tap | vanish[:s] | seal[:code] | normal — for the next message (Parts.messageKind).
    func messageKind(_ arg: String) {
        let k = arg.trimmingCharacters(in: .whitespaces)
        var f = form
        if k == "normal" { f["msgTap"] = nil; f["msgVanish"] = nil; f["msgSeal"] = nil }
        else if k == "tap" { if f["msgTap"]?.boolValue == true { f["msgTap"] = nil } else { f["msgTap"] = true } }
        else if k == "vanish", f["msgVanish"] != nil { f["msgVanish"] = nil }
        else if k.hasPrefix("vanish") {
            let s: Int
            if let i = k.firstIndex(of: ":") { s = Int(Expr.num(.string(String(k[k.index(after: i)...])))) } else { s = Int(settings.num("messages.vanishSeconds")) }
            f["msgVanish"] = s > 0 ? .number(Double(s)) : nil
        } else if k.hasPrefix("seal") {
            if f["msgSeal"] != nil && !k.contains(":") { f["msgSeal"] = nil }
            else if let i = k.firstIndex(of: ":") { f["msgSeal"] = .string(String(k[k.index(after: i)...])) }
            else { f["msgSeal"] = .string(Sealed.newCode()) }
        }
        form = f
        changed()
    }

    /// send.option: an option of "Send another way" on / off (SendPlan.apply).
    func sendOption(_ arg: String) {
        var f = form.jsonForm
        guard SendPlan.apply(&f, arg, defaultVanish: Int(settings.num("messages.vanishSeconds")), newCode: { Sealed.newCode() }) else { return }
        form = f.designForm
        changed()
    }

    /// The recipients of the next message (none = everyone) — message.recipients' choice, People's selection.
    func setRecipients(_ ids: [String]) {
        var f = form
        f["msgTo"] = ids.isEmpty ? nil : .array(ids.map { .string($0) })
        form = f
        changed()
    }

    private func changed() {
        revision &+= 1
        host?.refresh()
    }

    // MARK: send

    /// The message's kinds, recipients, expiry and position from the composer's state and the settings (Composer.outgoing).
    func outgoing(_ text: String) -> Outgoing {
        var o = Outgoing(text: text)
        o.replyTo = replyTo
        let p = plan
        o.tap = p.tap
        o.vanishSeconds = p.vanishSeconds
        o.sealCode = p.sealCode
        for id in recipientIds { if let n = room?.peerName(id) { o.recipients.append(id); o.recipientNames.append(n) } }
        o.ttlMinutes = Int(settings.num("messages.ttlMinutes"))
        if settings.bool("location.inHeader"), let l = core.position?.recent() { o.loc = l }
        return o
    }

    /// message.send / the send button: the field the way the options say (Composer.sendNow). False: nothing went.
    @discardableResult
    func send() -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = room, let host else { return false }
        let step = plan.step(hasText: !t.isEmpty, voiceBusy: voiceBusy)
        if step == .none || step == .wait { return false }
        if (step == .text || step == .speak), let fn = core.fn, fn.run(room: r, text: t, host: host) { clearAfterSend(); return true }
        switch step {
        case .speak: request = .speakAsVoice; return true
        case .dictateSpeak: request = .dictateThenSend(asVoice: true); return true
        case .dictateText: request = .dictateThenSend(asVoice: false); return true
        default:
            r.send(outgoing(t))
            clearAfterSend()
            return true
        }
    }

    /// Text that came by voice (dictation, the server's transcript) sent as a message with the kinds.
    func sendSpoken(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let r = room else { return }
        r.send(outgoing(t))
        clearAfterSend()
    }

    /// After a send: the field (only the text that went — what came meanwhile stays), the reply. The options stay on.
    func clearAfterSend(sent: String? = nil) {
        let keep = SendPlan.leftover(field: text, sent: sent)
        if keep != text { text = keep }
        replyTo = nil
        changed()
    }

    /// Bytes of a file: inline (≤ inlineMax, the safe type) or into the vault and by transfer. caption nil = the field.
    func sendBytes(_ data: Data, name: String, mime: String, image: Bool, caption: String? = nil) {
        guard let r = room else { return }
        let cap = caption ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
        let sent: String? = cap.isEmpty ? "" : nil
        let safe = Payloads.safeMime(mime)
        if data.count <= Self.inlineMax {
            var o = outgoing(cap)
            o.fileName = name
            o.fileMime = safe
            o.fileSize = Int64(data.count)
            o.fileImage = image && Payloads.inlineImage(safe)
            o.dataUrl = "data:" + safe + ";base64," + data.base64EncodedString()
            r.send(o)
            clearAfterSend(sent: sent)
            return
        }
        guard let files = core.files else { host?.flash(title: "", text: host?.translator.t("file.failed") ?? "", level: .error); return }
        do {
            let id = try files.store(data)
            r.sendFile(vaultId: id, name: name, mime: mime, size: Int64(data.count), outgoing(""))
            clearAfterSend(sent: sent)
        } catch {
            host?.flash(title: "", text: error.localizedDescription, level: .error)
        }
    }

    /// A picked or captured picture: at most 1600 px, JPEG quality 85 → 45 until it fits inline (else by transfer).
    func sendImage(_ data: Data) {
        guard let img = UIImage(data: data) else { sendBytes(data, name: "file", mime: "application/octet-stream", image: false); return }
        let scale = min(1, 1600 / max(img.size.width * img.scale, img.size.height * img.scale))
        let size = CGSize(width: (img.size.width * img.scale * scale).rounded(), height: (img.size.height * img.scale * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let scaled = scale < 1 ? UIGraphicsImageRenderer(size: size, format: format).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) } : img
        var jpeg = Data()
        for q in stride(from: 85, through: 45, by: -10) {
            jpeg = scaled.jpegData(compressionQuality: CGFloat(q) / 100) ?? Data()
            if jpeg.count <= Self.inlineMax { break }
        }
        sendBytes(jpeg, name: "photo-\(Millis.now).jpg", mime: "image/jpeg", image: true)
    }

    /// Any file (the document picker's security-scoped URL): inline when small, else stored in the vault and transferred.
    func sendFile(at url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = Payloads.safeFileName(.string(url.lastPathComponent))
        let mime = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType?.preferredMIMEType) ?? "application/octet-stream"
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
        if size >= 0 && size <= Self.inlineMax, let data = try? Data(contentsOf: url) {
            sendBytes(data, name: name, mime: mime, image: false)
            return
        }
        guard let r = room, let files = core.files else { return }
        do {
            let stored = try files.store(contentsOf: url)
            r.sendFile(vaultId: stored.id, name: name, mime: mime, size: stored.size, outgoing(""))
        } catch {
            host?.flash(title: "", text: error.localizedDescription, level: .error)
        }
    }

    /// A recorded voice message (hlas-<ms>.m4a, audio/mp4) — inline when small, else by transfer.
    func sendVoiceMessage(_ data: Data, mime: String = "audio/mp4") {
        let ext = mime.contains("mp4") || mime.contains("aac") ? "m4a" : mime.contains("wav") ? "wav" : mime.contains("ogg") ? "ogg" : mime.contains("webm") ? "webm" : "mp3"
        sendBytes(data, name: "hlas-\(Millis.now).\(ext)", mime: mime.isEmpty ? "audio/mpeg" : mime, image: false)
    }

    /// A text spoken into a voice message (as voice): sent without the text; the field loses only `spoken`.
    func sendVoiceClip(_ data: Data, mime: String, spoken: String) {
        let ext = mime.contains("mp4") || mime.contains("aac") ? "m4a" : mime.contains("wav") ? "wav" : mime.contains("ogg") ? "ogg" : mime.contains("webm") ? "webm" : "mp3"
        sendBytes(data, name: "hlas-\(Millis.now).\(ext)", mime: mime.isEmpty ? "audio/mpeg" : mime, image: false, caption: "")
        clearAfterSend(sent: spoken)
        if plan.sealed { host?.flash(title: "", text: host?.translator.t("send.code.noVoice") ?? "", level: .info) }
    }

    /// compose location: the position as a message ("📍 lat, lon (±acc m) map-url" and loc for the pin).
    func sharePosition() {
        guard let r = room, let host else { return }
        guard let source = core.position else { host.flash(title: "", text: host.translator.t("location.none"), level: .warn); return }
        host.flash(title: "", text: host.translator.t("location.finding"), level: .info)
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let l = await source.current() else { host.flash(title: "", text: host.translator.t("location.none"), level: .warn); return }
            let lat = l.double("lat") ?? 0, lon = l.double("lon") ?? 0, acc = l.double("acc") ?? 0
            var o = self.outgoing(String(format: "📍 %.5f, %.5f (±%d m) %@", locale: Locale(identifier: "en_US_POSIX"), lat, lon, Int(acc.rounded()),
                                         PositionText.mapUrlWeb(lat: lat, lon: lon)))
            o.loc = l
            r.send(o)
            self.clearAfterSend()
        }
    }

    /// The design's compose action (Parts.composerAction): photo | camera | file | location | voice | voiceText | asVoice | dictate | write:/kw.
    func compose(_ what: String) {
        host?.closeOverlay()
        switch what {
        case "photo": request = .pickPhoto
        case "camera": request = .camera
        case "file": request = .pickFile
        case "location": sharePosition()
        case "voice": request = .recordVoice
        case "voiceText": request = .recordText
        case "asVoice": request = .speakAsVoice
        case "dictate": request = .toggleDictation
        default: if what.hasPrefix("write:") { write(String(what.dropFirst("write:".count))) }
        }
    }

    // MARK: suggestions (/ commands, @ people, # tags) — the Fn engine's

    func suggestions(caret: Int? = nil) -> Suggestions.Result? {
        guard let fn = core.fn else { return nil }
        let r = room
        return fn.suggest(text: text, caret: caret ?? text.utf16.count, names: r?.peers.map(\.name) ?? [], recent: r?.messages.map(\.visibleText) ?? [])
    }

    func argHint(caret: Int? = nil) -> ArgHint? { core.fn?.hint(text: text, caret: caret ?? text.utf16.count) }

    /// The lock: what was typed leaves the memory.
    func forget() {
        text = ""
        replyTo = nil
        request = nil
    }
}

/// Map links of a position (location/Where).
enum PositionText {
    /// A pin on OpenStreetMap (Where.mapUrl, zoom 17) — the place sheet's fallback.
    static func mapUrl(lat: Double, lon: Double) -> String {
        String(format: "https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=17/%.6f/%.6f", locale: Locale(identifier: "en_US_POSIX"), lat, lon, lat, lon)
    }

    /// The web's link for a shared position (Where.mapUrlWeb, maps.ts osmLink, zoom 15) — the same text on both sides.
    static func mapUrlWeb(lat: Double, lon: Double) -> String {
        String(format: "https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=15/%.6f/%.6f", locale: Locale(identifier: "en_US_POSIX"), lat, lon, lat, lon)
    }
}
