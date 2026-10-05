// Text to speech (6.1) with the phone's voices — port of
// android/app/src/main/java/cz/m5cet/app/voice/Speech.java on AVSpeechSynthesizer:
// the language, the voice, the rate and the pitch come from the settings
// (voice.lang, voice.voice, voice.rate, voice.pitch); utterances report their end
// so dictation can pause while the phone speaks; `synthesize` makes PCM for a
// voice message or a call (AVSpeechSynthesizer.write — nothing leaves the phone).
//
// Languages: voice.lang, else the app's language, as a full BCP 47 tag for the 9
// app languages (en-US, cs-CZ, de-DE, es-ES, it-IT, fr-FR, sk-SK, sl-SI, fi-FI —
// Android maps cs, de, en and passes the rest; iOS's voices are found by the full
// tag). A language without a voice on this iPhone speaks with the system's
// default voice (as Android's TextToSpeech keeps its language), and voices()
// lists none for it — the settings can send the person to Settings › Accessibility
// › Spoken Content › Voices to download one.

import AVFoundation
import Foundation
import M5Core

/// The voice settings Speech, Dictation and the voice features read (the app's Settings; a fake in the tests).
@MainActor
protocol VoiceSettings: AnyObject {
    func string(_ key: String) -> String
    func number(_ key: String) -> Double
    func bool(_ key: String) -> Bool
    /// A raw value (MicFx reads voiceFx.* this way).
    func value(_ key: String) -> JSON?
    /// The app's language ("cs", "en"…).
    var appLanguage: String { get }
}

@MainActor
final class VoiceSpeech: NSObject {
    typealias Done = @MainActor (Bool) -> Void

    var settings: any VoiceSettings
    var session: any VoiceAudioSessionControlling
    /// The words of the design ("voice.defaultVoice").
    var text: (String) -> String = { $0 }
    /// Told when speaking starts or stops.
    var onStateChange: (() -> Void)?

    private let synth = AVSpeechSynthesizer()
    private var callbacks: [ObjectIdentifier: Done] = [:]
    private var current: AVSpeechUtterance?
    private var writers: [AVSpeechSynthesizer] = []
    private(set) var speaking = false

    /// Android's TextToSpeech.getMaxSpeechInputLength.
    static let maxInput = 4000

    init(settings: any VoiceSettings, session: any VoiceAudioSessionControlling) {
        self.settings = settings
        self.session = session
        super.init()
        synth.delegate = self
    }

    /// The phone can speak (iOS always has a synthesizer; Android's ready()).
    var ready: Bool { true }

    // MARK: language and voice

    /// The full tags of the app's languages (Locales.tag of M5Core: the same mapping).
    nonisolated static let fullTags = ["en": "en-US", "cs": "cs-CZ", "de": "de-DE", "es": "es-ES", "it": "it-IT", "fr": "fr-FR",
                                       "sk": "sk-SK", "sl": "sl-SI", "fi": "fi-FI"]

    /// The language for speech: the setting, else the app's language, as a BCP 47 tag.
    nonisolated static func localeTag(setting: String, appLanguage: String) -> String {
        let l = setting.isEmpty ? appLanguage : setting
        return fullTags[l.lowercased()] ?? l
    }

    var localeTag: String { Self.localeTag(setting: settings.string("voice.lang"), appLanguage: settings.appLanguage) }

    /// Android's clamp: 0 or less → 1 (the default), else within the range.
    nonisolated static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { v <= 0 ? 1 : max(lo, min(hi, v)) }

    /// voice.rate (Android: 1 = normal, 0.3 … 3) → AVSpeechUtterance.rate (0 … 1, 0.5 = normal): the
    /// default scaled below 1, the rest of the range above it.
    nonisolated static func utteranceRate(_ setting: Double) -> Float {
        let r = clamp(setting, 0.3, 3.0)
        let normal = Double(AVSpeechUtteranceDefaultSpeechRate), lo = Double(AVSpeechUtteranceMinimumSpeechRate), hi = Double(AVSpeechUtteranceMaximumSpeechRate)
        let v = r <= 1 ? lo + (normal - lo) * r : normal + (hi - normal) * (r - 1) / 2
        return Float(max(lo, min(hi, v)))
    }

    /// voice.pitch (0.3 … 2.5) → pitchMultiplier (0.5 … 2).
    nonisolated static func pitchMultiplier(_ setting: Double) -> Float { Float(max(0.5, min(2, clamp(setting, 0.3, 2.5)))) }

    /// The chosen voice (voice.voice = its identifier), else the language's default; nil = the system's.
    func voice() -> AVSpeechSynthesisVoice? {
        let id = settings.string("voice.voice")
        if !id.isEmpty, let v = AVSpeechSynthesisVoice(identifier: id) { return v }
        let tag = localeTag
        return AVSpeechSynthesisVoice(language: tag) ?? AVSpeechSynthesisVoice(language: String(tag.prefix(while: { $0 != "-" })))
    }

    private func utterance(_ text: String) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: text.count > Self.maxInput ? String(text.prefix(Self.maxInput)) : text)
        u.voice = voice()
        if u.voice == nil { M5Log.shared.warn("voice", "no \(localeTag) voice on this phone") }
        u.rate = Self.utteranceRate(settings.number("voice.rate"))
        u.pitchMultiplier = Self.pitchMultiplier(settings.number("voice.pitch"))
        return u
    }

    // MARK: speak

    /// Speaks now (replacing whatever is being said); done(false) when nothing was said.
    func speak(_ text: String, done: Done? = nil) {
        guard !text.javaTrimmed.isEmpty else { done?(false); return }
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        do { try session.begin(.speak) } catch { done?(false); return }
        let u = utterance(text)
        if let done { callbacks[ObjectIdentifier(u)] = done }
        current = u
        synth.speak(u)
    }

    func stop() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        speaking = false
        onStateChange?()
    }

    private func finished(_ id: ObjectIdentifier, ok: Bool) {
        if let c = current, ObjectIdentifier(c) == id { current = nil; speaking = false }
        session.end(.speak)
        let d = callbacks.removeValue(forKey: id)
        onStateChange?()
        d?(ok)
    }

    // MARK: synthesize

    /// Speech as 16-bit mono PCM (for a voice message or a call); nil when the voice made nothing.
    func synthesize(_ text: String) async -> Pcm16? {
        let t = text.javaTrimmed
        guard !t.isEmpty else { return nil }
        let u = utterance(t)
        let writer = AVSpeechSynthesizer()
        writers.append(writer) // kept until it is done
        defer { writers.removeAll { $0 === writer } }
        return await withCheckedContinuation { (k: CheckedContinuation<Pcm16?, Never>) in
            let collector = PcmCollector()
            Self.write(writer, u, collector) { k.resume(returning: $0) }
            // A voice that never answers: give up after the text's reading time + 30 s.
            let limit = Double(t.count) / 8 + 30
            DispatchQueue.main.asyncAfter(deadline: .now() + limit) {
                if let out = collector.finish(timedOut: true) { k.resume(returning: out) }
            }
        }.flatMap { $0.samples.isEmpty ? nil : $0 }
    }

    /// AVSpeechSynthesizer.write with its callback made outside the main actor (it runs on the synthesizer's queue).
    nonisolated private static func write(_ synth: AVSpeechSynthesizer, _ u: AVSpeechUtterance, _ collector: PcmCollector,
                                          _ done: @escaping @Sendable (Pcm16?) -> Void) {
        synth.write(u) { buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                // The last (empty) buffer: done.
                if let out = collector.finish() { done(out) }
                return
            }
            collector.add(pcm)
        }
    }

    /// The buffers of AVSpeechSynthesizer.write, as 16-bit mono at their rate (called on its queue).
    private final class PcmCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var samples = [Int16]()
        private var rate = 0
        private var done = false

        func add(_ b: AVAudioPCMBuffer) {
            let mono: [Int16]
            if b.format.commonFormat == .pcmFormatInt16, let d = b.int16ChannelData {
                let n = Int(b.frameLength), ch = Int(b.format.channelCount)
                mono = (0..<n).map { i in
                    var s = 0
                    for c in 0..<ch { s += Int(b.format.isInterleaved ? d[0][i * ch + c] : d[c][i]) }
                    return Int16(s / max(1, ch))
                }
            } else {
                mono = VoiceClipCodec.monoInt16(b)
            }
            lock.lock(); defer { lock.unlock() }
            if done { return }
            rate = Int(b.format.sampleRate.rounded())
            samples += mono
        }

        /// The PCM once (nil when already finished).
        func finish(timedOut: Bool = false) -> Pcm16?? {
            lock.lock(); defer { lock.unlock() }
            if done { return nil }
            done = true
            if timedOut && samples.isEmpty { return .some(nil) }
            return .some(Pcm16(samples: samples, rate: max(1, rate)))
        }
    }

    // MARK: voices

    /// The voices for the language ($voices of the voice screen): [{value, label}], the default first.
    func voices() -> [JSONObject] {
        var list = [JSONObject([("value", ""), ("label", .string(text("voice.defaultVoice")))])]
        let lang = String(localeTag.prefix(while: { $0 != "-" })).lowercased()
        let vs = AVSpeechSynthesisVoice.speechVoices()
            .filter { String($0.language.prefix(while: { $0 != "-" })).lowercased() == lang }
            .sorted { $0.name == $1.name ? $0.identifier < $1.identifier : $0.name < $1.name }
        for v in vs { list.append(JSONObject([("value", .string(v.identifier)), ("label", .string(Self.label(v)))])) }
        return list
    }

    /// "cs-CZ · Zuzana ★" (★: an enhanced or premium voice).
    nonisolated static func label(_ v: AVSpeechSynthesisVoice) -> String {
        v.language + " · " + v.name + (v.quality == .enhanced || v.quality == .premium ? " ★" : "")
    }
}

extension VoiceSpeech: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { MainActor.assumeIsolated { self.speaking = true; self.onStateChange?() } }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        DispatchQueue.main.async { MainActor.assumeIsolated { self.finished(id, ok: true) } }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        DispatchQueue.main.async { MainActor.assumeIsolated { self.finished(id, ok: false) } }
    }
}
