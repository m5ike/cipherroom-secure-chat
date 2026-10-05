// ui/parts/ComposerVoice (6.7) + voice/SpeakSend: dictation into the field and
// "speak and send".
//  - dictation stops for real: the same icon again (or Send) stops it, the last
//    words still land in the field; the icon follows the dictation's real state;
//  - leaving the room, a voice recording starting, or the app going to the
//    background stop it and free the microphone;
//  - "Send the text as voice": the field's text — or, empty, what is dictated now —
//    spoken and sent as a voice message without the text;
//  - "Speak it, send text": dictation, then the text goes as a message; without
//    the phone's recogniser and with the server's speech chosen, it is recorded and
//    transcribed by the server instead.
// SpeakSend's flow (one at a time):
//   idle ─asVoice (text)→ speaking ─clip→ send voice, clear → idle
//   idle ─asVoice (empty) / asText→ dictating ─stop→ finishing ─ended→ (text) speaking… / send text → idle
//   any ─cancel→ idle (nothing is sent). A voice that failed leaves the text in the field.

import M5Design
import M5Proto
import Observation
import SwiftUI

@MainActor
@Observable
final class ComposerVoice {
    enum Mode { case text, voice }
    enum State { case idle, dictating, finishing, speaking }

    private(set) var state: State = .idle { didSet { composer.voiceBusy = state != .idle } }
    private(set) var mode: Mode = .text
    /// The composer's own dictation runs (the icon is a stop square).
    private(set) var mine = false
    @ObservationIgnored private var forFlow = false
    @ObservationIgnored private var sendWhenEnded = false
    @ObservationIgnored private var base = ""
    /// The text the flow sent last (or is speaking): what leaves the field when it went.
    @ObservationIgnored private var last: String?
    @ObservationIgnored private var run = 0
    @ObservationIgnored weak var host: DesignHost?
    @ObservationIgnored let composer: ComposerModel
    /// Asks for the microphone first (the composer's withMic).
    @ObservationIgnored var withMic: (@MainActor (@escaping @MainActor () -> Void) -> Void)?
    /// A recording for the server to transcribe (the composer's recorder, "text" mode).
    @ObservationIgnored var recordForText: (@MainActor () -> Void)?

    init(composer: ComposerModel, host: DesignHost) {
        self.composer = composer
        self.host = host
    }

    private var voice: any ChatVoiceService { ChatVoiceHub.service }
    var busy: Bool { state != .idle }
    var dictating: Bool { mine && voice.dictating }

    // MARK: life

    /// The composer went away (or a recording starts): the flow is dropped, the composer's dictation stops (its words stay).
    func detached() {
        cancel()
        sendWhenEnded = false
        if mine && voice.dictating { voice.stopDictation() }
    }

    func recordingStarts() { detached() }

    // MARK: the icon

    /// The dictation icon (in the field): start, or stop when it runs.
    func toggleDictation() {
        if state == .dictating { stop(); return }
        // The square while the text is being spoken: nothing is sent (the text stays in the field).
        if state == .speaking { cancel(); return }
        if busy { return }
        if dictating { voice.stopDictation(); return }
        if !voice.dictationAvailable { notice("look.dictate.none"); return }
        withMic? { [weak self] in self?.start(flow: false) }
    }

    /// Send while dictating: the last words first, then it goes.
    func interceptSend() -> Bool {
        if state == .dictating { stop(); return true }
        if busy { return true }
        if dictating { sendWhenEnded = true; voice.stopDictation(); return true }
        return false
    }

    // MARK: speak and send

    /// send.options › "Send the text as voice".
    func asVoice() {
        guard requireRoom() else { return }
        if state != .idle { if state == .dictating { stop() }; return }
        let text = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { speak(text); return }
        dictate(.voice)
    }

    /// send.options › "Speak it, send text".
    func asText() {
        guard requireRoom() else { return }
        if !voice.dictationAvailable && host?.settings.str("voice.engine") == "server" { recordForText?(); return }
        if state != .idle { if state == .dictating { stop() }; return }
        dictate(.text)
    }

    private func requireRoom() -> Bool {
        if CoreModels.shared.rooms.active != nil { return true }
        host?.flash(title: "", text: host?.translator.t("room.offline") ?? "", level: .warn)
        return false
    }

    private func dictate(_ m: Mode) {
        if !voice.dictationAvailable { notice("look.dictate.none"); return }
        mode = m
        state = .dictating
        notice(m == .voice ? "speakSend.speakNow" : "speakSend.speakNowText")
        withMic? { [weak self] in self?.start(flow: true) }
    }

    /// The stop square (or Send) while dictating: finish the words, then go on.
    func stop() {
        guard state == .dictating else { return }
        state = .finishing
        if dictating { voice.stopDictation() } else { dictationEnded() }
    }

    /// The dictation is over: what is in the field is final.
    private func dictationEnded() {
        guard state == .dictating || state == .finishing else { return }
        let text = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { notice("voice.nothingHeard"); state = .idle; return }
        if mode == .text {
            last = text
            CoreModels.shared.rooms.active?.send(composer.outgoing(text))
            composer.clearAfterSend(sent: text)
            state = .idle
            return
        }
        speak(text)
    }

    private func speak(_ text: String) {
        mode = .voice
        state = .speaking
        run += 1
        let mine = run
        last = text
        notice("voice.synthesizing")
        let key = CoreModels.shared.rooms.active?.key ?? ""
        Task { @MainActor [weak self] in
            guard let self else { return }
            let (clip, error) = await self.voice.textToVoiceMessage(text, roomKey: key)
            guard mine == self.run, self.state == .speaking else { return } // cancelled meanwhile
            guard let clip else {
                self.notice(Self.errorKey(error), Self.detail(error))
                self.state = .idle
                return
            }
            self.composer.sendVoiceClip(clip.data, mime: clip.mime, spoken: self.last ?? text)
            self.last = nil
            self.state = .idle
        }
    }

    /// The composer went away (or a voice recording started): nothing more happens, nothing is sent.
    func cancel() {
        if state == .idle { return }
        run += 1
        state = .idle
    }

    // MARK: dictation

    private func start(flow: Bool) {
        if dictating { if flow { cancel() }; return }
        base = composer.text
        if !base.isEmpty && !base.hasSuffix(" ") { base += " " }
        forFlow = flow
        mine = true
        voice.dictate(onText: { [weak self] text, done in
            guard let self else { return }
            self.composer.text = self.base + text
            if !done { return }
            self.base = self.composer.text + " "
            // 6.8: sent the way Send's options say; still in the field while an earlier one is spoken.
            if !self.forFlow && self.host?.settings.bool("voice.dictateSend") == true && self.composer.send() { self.base = "" }
        }, onEnded: { [weak self] error in
            guard let self else { return }
            self.mine = false
            if !error.isEmpty { self.host?.flash(title: "", text: self.errorText(error), level: .warn) }
            if self.forFlow { self.forFlow = false; self.dictationEnded(); return }
            if self.sendWhenEnded { self.sendWhenEnded = false; _ = self.composer.send() }
        })
    }

    /// A dictation error in words (the design's dict.err.*).
    private func errorText(_ code: String) -> String {
        guard let t = host?.translator else { return code }
        let key = "dict.err." + code
        let text = t.t(key)
        return text == key ? t.t("dict.err.other").replacingOccurrences(of: "{code}", with: code) : text
    }

    /// The field's hint and the icon follow the real state.
    var hintKey: String {
        if state == .speaking { return "voice.synthesizing" }
        if dictating {
            if state == .dictating { return mode == .voice ? "speakSend.speakNow" : "speakSend.speakNowText" }
            return voice.listening ? "voice.listening" : "dict.starting"
        }
        return "room.typeMessage"
    }

    var iconOn: Bool { dictating || state == .speaking }

    // MARK: notices

    private func notice(_ key: String, _ detail: String = "") {
        let level: FlashLevel
        switch key {
        case "speakSend.noVoice", "speakSend.serverOff", "speakSend.failed", "voice.failed": level = .error
        case "voice.nothingHeard", "look.dictate.none": level = .warn
        default: level = .info
        }
        guard let host else { return }
        host.flash(title: "", text: host.translator.t(key) + (detail.isEmpty ? "" : ": " + detail), level: level)
    }

    /// The strings key for textToVoiceMessage's error.
    static func errorKey(_ error: String?) -> String {
        guard let error else { return "voice.failed" }
        if error.hasPrefix("tts-none") { return "speakSend.noVoice" }
        if error.hasPrefix("tts-server-off") { return "speakSend.serverOff" }
        // 6.12 (G-14): the person did not let the server's speech provider read it — nothing was sent.
        if error == "declined" { return "speakSend.declined" }
        return "speakSend.failed"
    }

    static func detail(_ error: String?) -> String {
        guard let error, let r = error.range(of: ": ") else { return "" }
        return String(error[r.upperBound...])
    }
}
