// ui/parts/Composer (slot "composer"): writing — the text field with suggestions
// (/ commands, @ people, # tags), a reply preview, the options of the next message
// (hold to reveal, vanishing, sealed with a code, as voice, speak it and send text,
// private to some people) as chips, and —
//  - attach (+): the design's "attach" sheet (picture, camera, file, position, voice
//    message, kinds, recipients);
//  - dictate (in the field): speech into the field; a long press opens
//    "dictate.options";
//  - mic: records a voice message (tap, then send or cancel on the recording bar:
//    level, time; at most 15 minutes);
//  - send (DesignSendButton): a badge says who gets it (everyone / only the chosen,
//    in another colour), dots and a one-time hint that a long press opens
//    "send.options".
// Its state is the window's ComposerModel (core); this part draws it and does what
// ComposerModel.request asks (the pickers, the camera, recording, dictation).
// Small files and pictures go inline, larger ones by transfer from the vault (ComposerModel).

import AVFoundation
import M5Core
import M5Design
import M5Proto
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ComposerPart: View {
    let ctx: SlotContext
    @Environment(\.designTextScale) private var textScale
    @Environment(\.scenePhase) private var phase
    @State private var voice: ComposerVoice?
    @State private var caret = 0
    @State private var caretToken = 0
    @State private var caretAt = 0
    @State private var fieldHeight: CGFloat = 44
    @State private var recording = false
    @State private var recMode = ""
    @State private var showPhotos = false
    @State private var photoItem: PhotosPickerItem?
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var hint = false
    @MainActor private static var hinted = false

    var body: some View {
        let host = ctx.host
        let composer = CoreModels.shared.composer(for: host)
        let c = ctx.context
        let _ = composer.revision
        VStack(spacing: 0) {
            Rectangle().fill(c.swiftColor("@border", .gray).opacity(0.8)).frame(height: max(1 / UIScreen.main.scale, 0.7))
                // The one-time hint floats just above the composer, at Send's end.
                .overlay(alignment: .bottomTrailing) { if hint { hintBubble.padding(.bottom, 6).fixedSize() } }
            let suggestions = composer.suggestions(caret: caret)
            if let s = suggestions, !s.items.isEmpty {
                ComposerSuggestList(result: s, ctx: ctx) { text, at in put(composer, text, at) }
            }
            if let r = composer.replyTo { replyLine(r, composer) }
            kinds(composer)
            if suggestions?.items.isEmpty ?? true, let h = composer.argHint(caret: caret) {
                ComposerArgHint(hint: h, ctx: ctx) { text, at in put(composer, text, at) }
            }
            if recording { recBar() } else { row(composer) }
        }
        .background(c.swiftColor("@surface", .white))
        .onAppear { start(composer) }
        .onDisappear { leave() }
        .onChange(of: composer.request) { _, r in take(r, composer) }
        .onChange(of: phase) { _, p in if p == .background { leave() } }
        .onChange(of: composer.text) { _, t in if !t.isEmpty { maybeHint() } }
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task { if let data = try? await item.loadTransferable(type: Data.self) { composer.sendImage(data) } }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { composer.sendFile(at: url) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { data in composer.sendImage(data) }.ignoresSafeArea()
        }
        .accessibilityIdentifier(ctx.id)
    }

    // MARK: the row: attach, the field with dictation, mic, send

    private func row(_ composer: ComposerModel) -> some View {
        let c = ctx.context
        let fg = c.swiftColor("@onSurface", .black), muted = c.swiftColor("@muted", .gray)
        let look = Look(settings: ctx.host.settings)
        let fontSize = 16 * c.appearance.fontScale * Double(textScale)
        let v = voice
        return HStack(spacing: 0) {
            iconButton("plus", color: fg, size: 44, label: ctx.t("composer.attach")) {
                ctx.host.showSheet("attach")
            }
            // The field and the dictation quick icon share one pill.
            HStack(spacing: 0) {
                ComposerField(text: Binding(get: { composer.text }, set: { composer.text = $0 }),
                              hint: ctx.t(v?.hintKey ?? "room.typeMessage"),
                              font: .systemFont(ofSize: fontSize), color: UIColor(fg), hintColor: UIColor(muted), tint: UIColor(c.swiftColor("@primary", .blue)),
                              enterSends: ctx.host.settings.bool("messages.enterSends"), focusRequests: composer.focusRequests,
                              caretToken: caretToken, caretAt: caretAt,
                              onSend: { send(composer) }, onCaret: { caret = $0 }, onPasteImage: { composer.sendImage($0) }, height: $fieldHeight)
                    .frame(height: fieldHeight)
                let on = v?.iconOn ?? false
                Button { tick(); v?.toggleDictation() } label: {
                    DesignIcon(name: on ? "square" : "speech", size: on ? 18 : 22, color: on ? c.swiftColor("@danger", .red) : muted)
                        .frame(width: 40, height: 40).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in longTick(); ctx.host.showSheet("dictate.options") })
                .accessibilityLabel(Text(verbatim: ctx.t(on ? "dict.stop" : "voice.dictate")))
                .help(Text(verbatim: ctx.t("voice.dictate")))
                .padding(.trailing, 2)
            }
            .frame(minHeight: 44)
            .background(RoundedRectangle(cornerRadius: min(look.radius("field"), 22)).fill(c.swiftColor("@surfaceVariant", .white)))
            .padding(.leading, 2).padding(.trailing, 4)
            // 6.2: the microphone records a voice message (the web's AudioRecorder).
            iconButton("mic", color: fg, size: 44, label: ctx.t("look.mic.record")) { record("voice", composer) }
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in longTick(); ctx.host.showSheet("send.options") })
            sendButton(composer)
                .padding(.leading, 2)
        }
        .padding(.leading, 4).padding(.trailing, 6).padding(.vertical, 6)
    }

    private func iconButton(_ icon: String, color: Color, size: CGFloat, label: String, _ run: @escaping () -> Void) -> some View {
        Button { tick(); run() } label: {
            DesignIcon(name: icon, size: 22, color: color).frame(width: size, height: size).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(Text(verbatim: label))
        .help(Text(verbatim: label))
    }

    /// Send's colour and badge: to the whole room the primary with a group; only to the chosen people the inverse (the text
    /// colour) with one person in the primary colour — a private message is never sent by mistake to everyone.
    private func sendButton(_ composer: ComposerModel) -> some View {
        let c = ctx.context
        let to = composer.recipientNames
        let only = !to.isEmpty
        let plan = composer.plan
        let surface = c.swiftColor("@surface", .white), primary = c.swiftColor("@primary", .blue), onPrimary = c.swiftColor("@onPrimary", .white)
        let icon = plan.asVoice ? "volume-2" : plan.voiceText ? "speech" : "send-horizontal"
        var label = only ? ctx.t("look.send.only") + " " + to.joined(separator: ", ") : ctx.t("look.send.everyone")
        if plan.asVoice { label += " · " + ctx.t("send.btn.asVoice") } else if plan.voiceText { label += " · " + ctx.t("send.btn.voiceText") }
        return DesignSendButton(icon: icon, fill: only ? c.swiftColor("@onSurface", .black) : primary, foreground: only ? surface : onPrimary,
                                people: only ? "user" : "users", badgeFill: only ? primary : onPrimary, badgeForeground: only ? onPrimary : primary,
                                ring: surface, cue: true, radius: CGFloat(Look(settings: ctx.host.settings).radius("icon")))
            .contentShape(Rectangle())
            .hoverEffect(.lift)
            .onTapGesture { tick(); send(composer) }
            .onLongPressGesture(minimumDuration: 0.5) {
                longTick()
                hint = false
                // Found it without the hint: no need to show it any more.
                if !Self.hinted { Self.hinted = true; ctx.host.userSetSetting(Look.keys.hintSend, .bool(true)) }
                ctx.host.showSheet("send.options")
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: label + " · " + ctx.t("look.send.hold")))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { send(composer) }
            .accessibilityAction(named: Text(verbatim: ctx.t("look.send.hold"))) { ctx.host.showSheet("send.options") }
            .help(Text(verbatim: label))
            .accessibilityIdentifier("composer.send")
    }

    // MARK: the reply and the options

    private func replyLine(_ r: ChatMessage, _ composer: ComposerModel) -> some View {
        let q = r.sealed != nil ? "🔒" : r.visibleText
        let short = q.count > 80 ? String(q.prefix(79)) + "…" : q
        return Button { composer.clearReply() } label: {
            Text(verbatim: "↪ " + Names.normalize(r.senderName) + ": " + short + "   ✕")
                .font(.system(size: 12 * textScale))
                .foregroundStyle(ctx.color("@muted", .gray))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.top, 6)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("composer.reply")
    }

    /// The chips: each option's text and how its ✕ turns it off.
    private func chips(_ composer: ComposerModel) -> [(String, () -> Void)] {
        let plan = composer.plan
        let host = ctx.host
        var chips: [(String, () -> Void)] = []
        if plan.asVoice {
            // 6.12 (G-14): with the server's speech the chip says that the server reads the text.
            let server = host.settings.str("voice.engine") == "server"
            chips.append(("🔊 " + ctx.t("send.opt.asVoice") + (server ? " · " + ctx.t("send.opt.asVoiceServer") : ""), { composer.sendOption("asVoice") }))
        }
        if plan.voiceText { chips.append(("🗣 " + ctx.t("send.opt.voiceText"), { composer.sendOption("voiceText") })) }
        if plan.tap { chips.append(("👁 " + ctx.t("msgkind.tap"), { composer.sendOption("tap") })) }
        if plan.vanishSeconds > 0 { chips.append(("⏳ \(plan.vanishSeconds) s", { composer.sendOption("vanish") })) }
        if let code = plan.sealCode { chips.append(("🔒 " + ctx.t("msgkind.sealed") + (code.isEmpty ? "" : " · " + code), { composer.sendOption("seal") })) }
        let to = composer.recipientNames
        if !to.isEmpty { chips.append(("✉ " + to.joined(separator: ", "), { composer.setRecipients([]) })) }
        if host.settings.bool("location.inHeader") { chips.append(("📍 " + ctx.t("location.inHeader"), { host.userSetSetting("location.inHeader", .bool(false)) })) }
        return chips
    }

    /// The options of the next message ($form: msgAsVoice, msgVoiceText, msgTap, msgVanish, msgSeal, msgTo) as chips; ✕ turns one off.
    @ViewBuilder
    private func kinds(_ composer: ComposerModel) -> some View {
        let host = ctx.host
        let list = chips(composer)
        if !list.isEmpty {
            let accent = ctx.color("@primary", .blue)
            let radius = Look(settings: host.settings).radius("chip")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(list.enumerated()), id: \.offset) { _, chip in
                        Button {
                            tick()
                            chip.1()
                            host.refresh()
                        } label: {
                            Text(verbatim: chip.0 + "  ✕")
                                .font(.system(size: 12.5 * textScale))
                                .foregroundStyle(accent)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(RoundedRectangle(cornerRadius: min(radius, 14)).fill(accent.opacity(0.12)))
                                .overlay(RoundedRectangle(cornerRadius: min(radius, 14)).strokeBorder(accent.opacity(0.4), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                    }
                }
                .padding(.horizontal, 10).padding(.top, 6)
            }
        }
    }

    // MARK: send

    /// Send (the button, Return, message.send): while dictating, the last words first.
    private func send(_ composer: ComposerModel) {
        if voice?.interceptSend() == true { return }
        hint = false
        _ = composer.send()
    }

    /// A picked suggestion or value: the text, the caret where the pick ends.
    private func put(_ composer: ComposerModel, _ text: String, _ at: Int) {
        composer.text = text
        caretAt = at
        caretToken += 1
        caret = at
    }

    // MARK: what the model asks for (ComposerRequest)

    private func take(_ r: ComposerRequest?, _ composer: ComposerModel) {
        guard let r else { return }
        composer.request = nil
        switch r {
        case .pickPhoto: showPhotos = true
        case .pickFile: showFiles = true
        case .camera: camera()
        case .recordVoice: record("voice", composer)
        case .recordText: record("text", composer)
        case .speakAsVoice: voice?.asVoice()
        case .toggleDictation: voice?.toggleDictation()
        case .dictateThenSend(let asVoice): if asVoice { voice?.asVoice() } else { voice?.asText() }
        }
    }

    /// The camera (UIImagePickerController): the photo goes like a picked one; nothing is written to a file.
    private func camera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            ctx.host.flash(title: "", text: ctx.t("file.noApp"), level: .warn)
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: showCamera = true
        case .notDetermined: Task { if await AVCaptureDevice.requestAccess(for: .video) { showCamera = true } }
        default: break // refused: as Android's withPermission, nothing happens
        }
    }

    // MARK: the microphone

    /// Runs `then` with the microphone: at once when allowed; else after the person allows it; none, a refusal and
    /// "refused for good" are said instead of nothing happening.
    private func withMic(_ then: @escaping @MainActor () -> Void) {
        Task {
            switch await ChatVoiceHub.service.microphone() {
            case .granted: then()
            case .none: ctx.host.flash(title: "", text: ctx.t("look.mic.none"), level: .error)
            case .blocked: ctx.host.flash(title: "", text: ctx.t("look.mic.blocked"), level: .warn)
            case .denied: ctx.host.flash(title: "", text: ctx.t("look.mic.denied"), level: .warn)
            }
        }
    }

    /// A voice message ("voice") or speech to send as text ("text": dictation, ComposerVoice).
    private func record(_ mode: String, _ composer: ComposerModel) {
        if recording { return }
        if mode == "text" { voice?.asText(); return }
        withMic { startRecording(mode) }
    }

    private func startRecording(_ mode: String) {
        guard !recording else { return }
        voice?.recordingStarts()
        hint = false
        guard ChatVoiceHub.service.startRecording() else { ctx.host.flash(title: "", text: ctx.t("look.mic.busy"), level: .error); return }
        recMode = mode
        recording = true
    }

    private func stopRecording(keep: Bool) {
        guard recording else { return }
        recording = false
        let mode = recMode
        let host = ctx.host
        let composer = CoreModels.shared.composer(for: host)
        Task {
            let clip = await ChatVoiceHub.service.stopRecording(keep: keep)
            guard keep, let clip, let room = CoreModels.shared.rooms.active else { return }
            // Under half a second is a slip of the finger, not a message.
            if clip.durationMs < 500 { host.flash(title: "", text: host.translator.t("look.mic.short"), level: .info); return }
            if mode == "text" {
                host.flash(title: "", text: host.translator.t("voice.recognizing"), level: .info)
                let (text, error) = await ChatVoiceHub.service.voiceToText(clip, roomKey: room.key)
                // 6.12 (G-14): the person did not let the server's provider hear it — nothing went.
                if error == "declined" { host.flash(title: "", text: host.translator.t("speakSend.declined"), level: .info); return }
                let t = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if t.isEmpty { host.flash(title: "", text: host.translator.t(text == nil ? "voice.failed" : "voice.nothingHeard"), level: .warn); return }
                room.send(composer.outgoing(t))
                composer.clearAfterSend()
                return
            }
            composer.sendVoiceMessage(clip.data, mime: clip.mime)
        }
    }

    /// The recording bar: cancel, the time and the level, send.
    private func recBar() -> some View {
        let c = ctx.context
        let fg = c.swiftColor("@onSurface", .black)
        return HStack(spacing: 0) {
            iconButton("trash", color: fg, size: 44, label: ctx.t("look.mic.cancel")) { stopRecording(keep: false) }
            TimelineView(.periodic(from: .now, by: 0.1)) { _ in
                let service = ChatVoiceHub.service
                let ms = service.recordingElapsedMs
                HStack(spacing: 0) {
                    Text(verbatim: (recMode == "text" ? "✍ " : "● ") + chatMediaTime(ms))
                        .font(.system(size: 15, design: .monospaced))
                        .foregroundStyle(c.swiftColor("@danger", .red))
                        .padding(.leading, 8).padding(.trailing, 10)
                    ProgressView(value: min(1, max(0, service.recordingLevel)))
                        .tint(c.swiftColor("@primary", .blue))
                        .background(Capsule().fill(c.swiftColor("@surfaceVariant", .white)))
                        .frame(maxWidth: .infinity)
                }
                .onChange(of: ms > 15 * 60_000) { _, over in if over { stopRecording(keep: true) } }
            }
            Button { tick(); stopRecording(keep: true) } label: {
                DesignSendButton(icon: "send-horizontal", fill: c.swiftColor("@primary", .red), foreground: c.swiftColor("@onPrimary", .white), people: nil,
                                 badgeFill: .clear, badgeForeground: .clear, ring: .clear, cue: false, radius: CGFloat(Look(settings: ctx.host.settings).radius("icon")))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: ctx.t("look.mic.stop")))
            .help(Text(verbatim: ctx.t("look.mic.stop")))
            .padding(.leading, 10)
        }
        .padding(6)
        .transition(.opacity)
    }

    // MARK: life

    private func start(_ composer: ComposerModel) {
        // A text waiting for the composer in $form ("composer": a shared text) goes into the field once.
        if let pending = ctx.host.form.removeValue(forKey: "composer") { composer.text = Expr.toText(pending) }
        if voice == nil {
            let v = ComposerVoice(composer: composer, host: ctx.host)
            v.withMic = { then in withMic(then) }
            v.recordForText = { withMic { startRecording("text") } }
            voice = v
        }
        // A position for the header is fetched now, so it is ready when the message goes.
        if ctx.host.settings.bool("location.inHeader"), let p = CoreModels.shared.position, p.permitted { Task { _ = await p.current() } }
        if let r = composer.request { take(r, composer) }
    }

    /// Leaving the room (or the background): dictation stops (the words stay), a recording is dropped — the microphone is free.
    private func leave() {
        voice?.detached()
        stopRecording(keep: false)
        hint = false
    }

    // MARK: the one-time hint over Send

    /// Once ever: a bubble over Send, "hold for more options" — when there is first something to send.
    private func maybeHint() {
        if Self.hinted || ctx.host.settings.bool(Look.keys.hintSend) { return }
        Self.hinted = true
        ctx.host.userSetSetting(Look.keys.hintSend, .bool(true))
        withAnimation(.easeOut(duration: Look(settings: ctx.host.settings).ms(220) / 1000)) { hint = true }
        Task {
            try? await Task.sleep(for: .seconds(6))
            withAnimation(.easeIn(duration: 0.18)) { hint = false }
        }
    }

    private var hintBubble: some View {
        let c = ctx.context
        return Text(verbatim: ctx.t("look.send.hint"))
            .font(.system(size: 13.5 * c.appearance.fontScale))
            .foregroundStyle(c.swiftColor("@surface", .white))
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: 240, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(c.swiftColor("@onSurface", .black).opacity(0.92)))
            .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.trailing, 8)
            .onTapGesture { withAnimation { hint = false } }
            .transition(.opacity.combined(with: .offset(y: 6)))
    }

    private func tick() { DesignHaptics.tick(Look(settings: ctx.host.settings).haptics) }
    private func longTick() { DesignHaptics.long(Look(settings: ctx.host.settings).haptics) }
}

/// The camera (UIImagePickerController, still photos): the picture comes back in memory, as JPEG.
struct CameraPicker: UIViewControllerRepresentable {
    let done: @MainActor (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.cameraCaptureMode = .photo
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency UIImagePickerControllerDelegate, @preconcurrency UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage, let data = img.jpegData(compressionQuality: 0.92) { parent.done(data) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
