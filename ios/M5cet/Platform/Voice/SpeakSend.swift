// Speak and send (6.7) — the composer's "Send another way" sheet. Port 1:1 of
// android/app/src/main/java/cz/m5cet/app/voice/SpeakSend.java:
//
//  - "Send the text as voice" (compose › asVoice): the text in the field — or,
//    when the field is empty, what is dictated now — spoken by a voice (the
//    phone's, or the operator's speech module when the voice settings say so)
//    and sent as an end-to-end encrypted voice message, exactly like a recorded
//    one (no text goes along);
//  - "Speak it, send text" (compose › voiceText): dictation into the field, and
//    when it is stopped the text goes as an ordinary message.
//
// Pure (SpeakSendTests drive it with a pretend dictation and voice); the composer
// is its IO. One flow at a time:
//
//   IDLE ─asVoice (text in the field)→ SPEAKING ─clip→ send voice, clear → IDLE
//   IDLE ─asVoice (empty) / asText→ DICTATING ─stop→ FINISHING ─dictation ended→
//        (text) SPEAKING … / send the text, clear → IDLE;  (nothing heard) → IDLE
//   any ─cancel (the composer goes away)→ IDLE (nothing is sent)
// A voice that failed leaves the text in the field (it can still be sent as text).

import Foundation
import M5Core

/// What the composer does for the flow (Parts implements it).
@MainActor
protocol SpeakSendIO: AnyObject {
    associatedtype Clip
    var canDictate: Bool { get }
    /// Dictation into the field (the composer shows the text as it comes; dictationEnded() at the end).
    func startDictation()
    /// Stop it; the last words still come, then dictationEnded().
    func stopDictation()
    var fieldText: String { get }
    func clearField()
    /// The text as a voice message's clip (VoiceService.textToVoiceMessage).
    func speak(_ text: String, done: @escaping @MainActor (Clip?, String?) -> Void)
    func sendText(_ text: String)
    func sendVoice(_ clip: Clip)
    /// A notice (a strings key, and a detail or "").
    func notice(_ key: String, _ detail: String)
    /// The flow changed (the composer's icons).
    func changed(_ state: SpeakSendState, _ mode: SpeakSendMode)
}

extension SpeakSendIO {
    func changed(_ state: SpeakSendState, _ mode: SpeakSendMode) {}
}

enum SpeakSendMode: String, Sendable { case text = "TEXT", voice = "VOICE" }
enum SpeakSendState: String, Sendable { case idle = "IDLE", dictating = "DICTATING", finishing = "FINISHING", speaking = "SPEAKING" }

@MainActor
final class SpeakSend<IO: SpeakSendIO> {
    private unowned let io: IO
    private(set) var state: SpeakSendState = .idle
    private(set) var mode: SpeakSendMode = .text
    private var run = 0

    /// The composer owns the flow (the flow does not keep it alive).
    init(_ io: IO) { self.io = io }

    var busy: Bool { state != .idle }

    /// send.options › "Send the text as voice".
    func asVoice() {
        if state != .idle { if state == .dictating { stop() }; return }
        let text = io.fieldText.javaTrimmed
        if !text.isEmpty { speak(text); return }
        dictate(.voice)
    }

    /// send.options › "Speak it, send text".
    func asText() {
        if state != .idle { if state == .dictating { stop() }; return }
        dictate(.text)
    }

    private func dictate(_ m: SpeakSendMode) {
        if !io.canDictate { io.notice("look.dictate.none", ""); return }
        mode = m
        set(.dictating)
        io.notice(m == .voice ? "speakSend.speakNow" : "speakSend.speakNowText", "")
        io.startDictation()
    }

    /// The stop square (or Send) while dictating: finish the words, then go on.
    func stop() {
        if state != .dictating { return }
        set(.finishing)
        io.stopDictation()
    }

    /// The dictation is over (stopped, given up, or failed): what is in the field is final.
    func dictationEnded() {
        if state != .dictating && state != .finishing { return }
        let text = io.fieldText.javaTrimmed
        if text.isEmpty { io.notice("voice.nothingHeard", ""); set(.idle); return }
        if mode == .text {
            io.sendText(text)
            io.clearField()
            set(.idle)
            return
        }
        speak(text)
    }

    private func speak(_ text: String) {
        mode = .voice
        set(.speaking)
        run += 1
        let mine = run
        io.notice("voice.synthesizing", "")
        io.speak(text) { [weak self] clip, error in
            guard let self, mine == self.run, self.state == .speaking else { return } // cancelled meanwhile
            guard let clip else {
                self.io.notice(Self.errorKey(error), Self.detail(error))
                self.set(.idle)
                return
            }
            self.io.sendVoice(clip)
            self.io.clearField()
            self.set(.idle)
        }
    }

    /// The composer went away (or a voice recording started): nothing more happens, nothing is sent.
    func cancel() {
        if state == .idle { return }
        run += 1
        set(.idle)
    }

    private func set(_ s: SpeakSendState) {
        if state == s { return }
        state = s
        io.changed(s, mode)
    }

    /// The strings key for VoiceService.textToVoiceMessage's error.
    nonisolated static func errorKey(_ error: String?) -> String { SpeakSendErrors.key(error) }
    nonisolated static func detail(_ error: String?) -> String { SpeakSendErrors.detail(error) }
}

/// The errors of a spoken voice message, as the composer says them.
enum SpeakSendErrors {
    static func key(_ error: String?) -> String {
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

    /// RIFF … WAVE: the bytes are a WAV file (the server's Piper voices answer with one).
    static func isWav(_ b: [UInt8]?) -> Bool {
        guard let b, b.count >= 12 else { return false }
        return b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 && b[8] == 0x57 && b[9] == 0x41 && b[10] == 0x56 && b[11] == 0x45
    }
}
