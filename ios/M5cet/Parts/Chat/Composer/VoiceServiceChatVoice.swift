// The composer's voice on Platform/Voice (VoiceService.shared): the voice message
// recorder (16 kHz, the voice changer in its path, AAC-LC like Android), dictation
// on the device (permissions asked on the person's action), the text as a voice
// message and a recording as text (the phone's, or the operator's speech module
// with voice.engine = server — after ServerVoiceConsent, asked here in the
// design's words: Android ComposerVoice.asker), reading aloud.

import AVFoundation
import M5Design
import UIKit

@MainActor
final class VoiceServiceChatVoice: ChatVoiceService {
    let voice: VoiceService
    /// The design's words for the consent question.
    private let texts: @MainActor (String) -> String
    /// Whether dictation can run for the language (asked once in the background; nil = not known yet → try).
    private var available: Bool?

    init(_ voice: VoiceService = .shared, texts: @escaping @MainActor (String) -> String) {
        self.voice = voice
        self.texts = texts
        refresh()
    }

    /// Asks the system again what dictation can do (the language may have changed).
    func refresh() {
        Task { [weak self] in
            guard let self else { return }
            self.available = await self.voice.dictation.available()
        }
    }

    // MARK: the microphone

    func microphone() async -> ChatMicAccess {
        guard AVAudioSession.sharedInstance().isInputAvailable else { return .none }
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .blocked
        default: return await AVAudioApplication.requestRecordPermission() ? .granted : .denied
        }
    }

    // MARK: a voice message

    func startRecording() -> Bool { voice.startRecording() }
    var recordingElapsedMs: Int64 { voice.recorder.elapsedMs }
    var recordingLevel: Double { Double(voice.recorder.level) }

    func stopRecording(keep: Bool) async -> ChatVoiceClip? {
        guard keep else { voice.dropRecording(); return nil }
        guard let c = voice.finishRecording() else { return nil }
        return ChatVoiceClip(data: c.bytes, mime: c.mime, durationMs: c.durationMs, pcm: c.pcm)
    }

    // MARK: dictation

    var dictationAvailable: Bool { available ?? true }
    var dictating: Bool { voice.dictating }
    var listening: Bool { voice.listening }

    func dictate(onText: @escaping @MainActor (String, Bool) -> Void, onEnded: @escaping @MainActor (String) -> Void) {
        Task { [weak self] in
            guard let self else { return }
            guard await self.voice.dictation.requestPermissions() else { onEnded("not-allowed"); return }
            self.voice.dictate(Sink(voice: self.voice, onText: onText, onEnded: onEnded))
        }
    }

    func stopDictation() { voice.stopDictation() }

    private final class Sink: VoiceSink {
        weak var voice: VoiceService?
        let text: @MainActor (String, Bool) -> Void
        let ended: @MainActor (String) -> Void
        init(voice: VoiceService, onText: @escaping @MainActor (String, Bool) -> Void, onEnded: @escaping @MainActor (String) -> Void) {
            self.voice = voice
            text = onText
            ended = onEnded
        }
        func onText(_ t: String, done: Bool) { text(t, done) }
        func onEnded() { ended(voice?.takeDictationError() ?? "") }
    }

    // MARK: text ↔ voice

    func textToVoiceMessage(_ text: String, roomKey: String) async -> (clip: ChatVoiceClip?, error: String?) {
        let r = await voice.textToVoiceMessage(text, room: roomKey, ask: ask)
        return (r.clip.map { ChatVoiceClip(data: $0.bytes, mime: $0.mime, durationMs: $0.durationMs, pcm: $0.pcm) }, r.error)
    }

    func voiceToText(_ clip: ChatVoiceClip, roomKey: String) async -> (text: String?, error: String?) {
        guard let pcm = clip.pcm else { return (nil, "recogniser") }
        if voice.settings.string("voice.engine") == "server" { return await voice.serverVoiceToText(pcm, room: roomKey, ask: ask) }
        return await voice.voiceToText(pcm)
    }

    func say(_ text: String) { voice.say(text) }

    /// 6.12 (G-14): the question before the server's speech provider gets the text (or a recording) — the
    /// provider named; closing it is a no.
    private var ask: ServerVoiceConsent.Ask {
        let t = texts
        return { use, provider, answer in
            var answered = false
            let once: @MainActor (Bool) -> Void = { yes in if !answered { answered = true; answer(yes) } }
            let message = t(use == .speak ? "voice.consent.speak" : "voice.consent.transcribe").replacingOccurrences(of: "{provider}", with: provider)
            let alert = UIAlertController(title: t("voice.consent.title"), message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: t("voice.consent.no"), style: .cancel) { _ in MainActor.assumeIsolated { once(false) } })
            alert.addAction(UIAlertAction(title: t("voice.consent.yes"), style: .default) { _ in MainActor.assumeIsolated { once(true) } })
            guard ChatFileActions.topController() != nil else { once(false); return }
            ChatFileActions.present(alert)
        }
    }
}
