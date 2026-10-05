// Fakes of what Platform/Voice talks to: the audio session (a call may own it), the permissions, the
// Speech framework (what a language can do, sessions driven by the test), the settings.

import Foundation
import M5Core
@testable import M5cet

@MainActor
final class FakeAudioSession: VoiceAudioSessionControlling {
    var callActive = false
    var fail = false
    private(set) var log: [String] = []
    private(set) var open: [VoiceAudioUse: Int] = [:]

    func begin(_ use: VoiceAudioUse) throws {
        if callActive && use.records { log.append("refused:" + use.rawValue); throw VoiceAudioError.inCall }
        if fail { throw VoiceAudioError.session("no") }
        open[use, default: 0] += 1
        log.append("begin:" + use.rawValue)
    }

    func end(_ use: VoiceAudioUse) {
        guard let n = open[use], n > 0 else { return }
        open[use] = n - 1
        log.append("end:" + use.rawValue)
    }

    var balanced: Bool { open.values.allSatisfy { $0 == 0 } }
}

@MainActor
final class FakePermissions: VoicePermissions {
    var microphone: VoicePermission = .granted
    var speech: VoicePermission = .granted
    var answer = true
    private(set) var asked: [String] = []

    func requestMicrophone() async -> Bool { asked.append("mic"); microphone = answer ? .granted : .denied; return answer }
    func requestSpeech() async -> Bool { asked.append("speech"); speech = answer ? .granted : .denied; return answer }
}

/// The Speech framework as a test wants it: the facts per language, sessions it drives by hand.
@MainActor
final class FakeRecognizers: RecognizerSystem {
    var facts: [String: RecognizerFacts] = [:]
    var transcript: String? = "ahoj"
    private(set) var factsAsked: [String] = []
    private(set) var installed: [String] = []
    private(set) var sessions: [(kind: RecognizerKind, lang: String, events: any DictationEvents, session: FakeDictationSession)] = []
    private(set) var recognized: [(RecognizerKind, Int)] = []
    var noSession = false

    func facts(for locale: Locale) async -> RecognizerFacts {
        let tag = locale.identifier(.bcp47)
        factsAsked.append(tag)
        return facts[tag] ?? RecognizerFacts()
    }

    func install(_ kind: RecognizerKind, locale: Locale) async throws {
        installed.append(kind.rawValue + ":" + locale.identifier(.bcp47))
        var f = facts[locale.identifier(.bcp47)] ?? RecognizerFacts()
        if kind == .transcriber { f.transcriberInstalled = true } else { f.dictationInstalled = true }
        facts[locale.identifier(.bcp47)] = f
    }

    func session(_ kind: RecognizerKind, locale: Locale, events: any DictationEvents, level: @escaping @Sendable (Float) -> Void) -> (any DictationSession)? {
        if noSession { return nil }
        let s = FakeDictationSession(events)
        sessions.append((kind, locale.identifier(.bcp47), events, s))
        return s
    }

    func recognize(_ kind: RecognizerKind, pcm: Pcm16, locale: Locale) async -> String? {
        recognized.append((kind, pcm.samples.count))
        return transcript
    }
}

@MainActor
final class FakeVoiceSettings: VoiceSettings {
    var values: [String: JSON] = [:]
    var appLanguage = "cs"

    init() {
        let d = DefaultVoiceSettings()
        values = d.values
    }

    func string(_ key: String) -> String { values[key]?.stringValue ?? "" }
    func number(_ key: String) -> Double { values[key]?.doubleValue ?? 0 }
    func bool(_ key: String) -> Bool { values[key]?.boolValue ?? false }
    func value(_ key: String) -> JSON? { values[key] }
}

/// Lets the main actor run the tasks the code under test started.
@MainActor
func settle(_ rounds: Int = 20) async {
    for _ in 0..<rounds { await Task.yield() }
}
