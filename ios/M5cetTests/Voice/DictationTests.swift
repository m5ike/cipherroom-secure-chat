// Dictation on iOS: on the device only. Which recogniser a language gets (SpeechTranscriber,
// DictationTranscriber, SFSpeechRecognizer only with on-device support — never one that would use the
// network), what happens without permission, during a call, for a language without a model or with one
// still to download, and the session's way through DictationMachine with the Speech framework faked.

import Speech
import XCTest
@testable import M5cet

@MainActor
private final class Listener: DictationListener {
    var log: [String] = []
    func onPartial(_ text: String) { log.append("P:" + text) }
    func onFinal(_ text: String) { log.append("F:" + text) }
    func onState(listening: Bool) { log.append(listening ? "listening" : "not listening") }
    func onLevel(_ level: Float) {}
    func onError(_ code: String) { log.append("E:" + code) }
    func onEnded() { log.append("ended") }
}

@MainActor
final class DictationTests: XCTestCase {
    func testThePlanPrefersWhatIsOnThePhoneAndNeverTheNetwork() {
        XCTAssertEqual(.ready(.transcriber), RecognizerPlan.choose(RecognizerFacts(transcriberSupported: true, transcriberInstalled: true, dictationSupported: true, dictationInstalled: true, legacyOnDevice: true)))
        XCTAssertEqual(.ready(.dictation), RecognizerPlan.choose(RecognizerFacts(transcriberSupported: true, transcriberInstalled: false, dictationSupported: true, dictationInstalled: true)))
        XCTAssertEqual(.ready(.legacyOnDevice), RecognizerPlan.choose(RecognizerFacts(transcriberSupported: true, legacyOnDevice: true)))
        XCTAssertEqual(.needsDownload(.transcriber), RecognizerPlan.choose(RecognizerFacts(transcriberSupported: true, dictationSupported: true)))
        XCTAssertEqual(.needsDownload(.dictation), RecognizerPlan.choose(RecognizerFacts(dictationSupported: true)))
        // A recogniser without on-device support (it would send the audio to Apple): unsupported.
        XCTAssertEqual(.unsupported, RecognizerPlan.choose(RecognizerFacts(legacyOnDevice: false)))
        XCTAssertEqual("download", RecognizerPlan.needsDownload(.dictation).availability)
    }

    func testTheLegacyRequestStaysOnTheDevice() {
        let r = SFSpeechAudioBufferRecognitionRequest()
        LegacyDictationSession.configure(r)
        XCTAssertTrue(r.requiresOnDeviceRecognition)
        XCTAssertTrue(r.shouldReportPartialResults)
        XCTAssertEqual(.dictation, r.taskHint)
    }

    func testTheRecognisersErrorsAreTheWebsCodes() {
        XCTAssertEqual("no-speech", LegacyDictationSession.errorCode(NSError(domain: "kAFAssistantErrorDomain", code: 1110)))
        XCTAssertEqual("aborted", LegacyDictationSession.errorCode(NSError(domain: "kAFAssistantErrorDomain", code: 216)))
        XCTAssertEqual("not-allowed", LegacyDictationSession.errorCode(NSError(domain: "kAFAssistantErrorDomain", code: 1700)))
        XCTAssertEqual("client", LegacyDictationSession.errorCode(NSError(domain: "x", code: 1)))
    }

    private func rig(_ facts: RecognizerFacts, lang: String = "cs-CZ") -> (Dictation, FakeRecognizers, FakePermissions, FakeAudioSession, ManualScheduler) {
        let rec = FakeRecognizers()
        rec.facts[lang] = facts
        let perms = FakePermissions(), session = FakeAudioSession(), clock = ManualScheduler()
        let d = Dictation(system: rec, permissions: perms, session: session, scheduler: clock, lang: { lang })
        return (d, rec, perms, session, clock)
    }

    func testADictationOnTheDevice() async {
        let (d, rec, _, session, _) = rig(RecognizerFacts(transcriberSupported: true, transcriberInstalled: true))
        let l = Listener()
        d.start(l)
        await settle()
        XCTAssertEqual(1, rec.sessions.count)
        XCTAssertEqual(.transcriber, rec.sessions[0].kind)
        XCTAssertEqual("cs-CZ", rec.sessions[0].lang)
        XCTAssertEqual(["begin:dictate"], session.log)
        let ev = rec.sessions[0].events
        ev.ready()
        ev.partial("dobrý")
        ev.fin("Dobrý den.")
        XCTAssertTrue(d.listening)
        d.stop()
        XCTAssertEqual(1, rec.sessions[0].session.stops)
        ev.end()
        XCTAssertFalse(d.active)
        XCTAssertEqual(["listening", "P:dobrý", "F:Dobrý den.", "not listening", "ended"], l.log)
        XCTAssertTrue(session.balanced) // the session went back when it ended
    }

    func testNothingListensWithoutPermission() async {
        let (d, rec, perms, session, _) = rig(RecognizerFacts(transcriberSupported: true, transcriberInstalled: true))
        perms.speech = .denied
        let l = Listener()
        d.start(l)
        await settle()
        XCTAssertTrue(rec.sessions.isEmpty)
        XCTAssertEqual(["E:not-allowed", "ended"], l.log)
        XCTAssertTrue(session.log.isEmpty)
        XCTAssertTrue(perms.asked.isEmpty) // never asked by itself: only requestPermissions() on the person's action
    }

    func testPermissionsAreAskedOnlyForWhatIsMissing() async {
        let (d, _, perms, _, _) = rig(RecognizerFacts())
        perms.speech = .undetermined
        let first = await d.requestPermissions()
        XCTAssertTrue(first)
        XCTAssertEqual(["speech"], perms.asked)
        perms.microphone = .undetermined
        perms.speech = .undetermined
        perms.answer = false
        let second = await d.requestPermissions()
        XCTAssertFalse(second)
        XCTAssertEqual(["speech", "mic"], perms.asked) // a no to the microphone stops there
    }

    func testACallHasTheMicrophone() async {
        let (d, rec, _, session, _) = rig(RecognizerFacts(transcriberSupported: true, transcriberInstalled: true))
        session.callActive = true
        let l = Listener()
        d.start(l)
        await settle()
        XCTAssertTrue(rec.sessions.isEmpty)
        XCTAssertEqual(["E:audio-capture", "ended"], l.log)
    }

    func testALanguageWithoutAModel() async {
        let (d, rec, _, _, _) = rig(RecognizerFacts())
        let l = Listener()
        d.start(l)
        await settle()
        XCTAssertTrue(rec.sessions.isEmpty)
        XCTAssertEqual(["E:language-not-supported", "ended"], l.log)
        XCTAssertFalse(d.needsDownload)
        let available = await d.available()
        XCTAssertFalse(available)
    }

    func testALanguageWhoseModelIsDownloadedOnRequest() async throws {
        let (d, rec, _, _, _) = rig(RecognizerFacts(dictationSupported: true))
        let l = Listener()
        d.start(l)
        await settle()
        XCTAssertTrue(d.needsDownload)
        XCTAssertEqual(["E:language-not-supported", "ended"], l.log)
        let before = await d.availability()
        XCTAssertEqual(.needsDownload(.dictation), before)
        try await d.installLanguage()
        XCTAssertEqual(["dictation:cs-CZ"], rec.installed)
        let after = await d.availability()
        XCTAssertEqual(.ready(.dictation), after)
        d.start(Listener())
        await settle()
        XCTAssertEqual(.dictation, rec.sessions.last?.kind)
    }

    func testAStopBeforeTheRecogniserStartedEndsIt() async {
        let (d, rec, _, session, _) = rig(RecognizerFacts(transcriberSupported: true, transcriberInstalled: true))
        let l = Listener()
        d.start(l)
        d.stop() // before the asynchronous start ran
        await settle()
        XCTAssertFalse(d.active)
        XCTAssertEqual(["ended"], l.log)
        XCTAssertTrue(rec.sessions.isEmpty)
        XCTAssertTrue(session.balanced)
    }

    func testAnAbortDropsTheSessionAndTheAudio() async {
        let (d, rec, _, session, _) = rig(RecognizerFacts(transcriberSupported: true, transcriberInstalled: true))
        let l = Listener()
        d.start(l)
        await settle()
        rec.sessions[0].events.ready()
        d.abort()
        XCTAssertEqual(1, rec.sessions[0].session.aborts)
        XCTAssertTrue(session.balanced)
        rec.sessions[0].events.fin("late") // ignored
        XCTAssertFalse(l.log.contains("F:late"))
    }

    func testAPauseThenSilenceRestartsIt() async {
        let (d, rec, _, _, clock) = rig(RecognizerFacts(transcriberSupported: true, transcriberInstalled: true))
        d.start(Listener())
        await settle()
        rec.sessions[0].events.ready()
        rec.sessions[0].events.end() // the recogniser ended by itself
        clock.advance(250)
        await settle()
        XCTAssertEqual(2, rec.sessions.count)
        d.abort()
    }

    func testRecordedAudioOnTheDevice() async {
        let (d, rec, perms, _, _) = rig(RecognizerFacts(legacyOnDevice: true))
        let text = await d.recognize(Pcm16(samples: [Int16](repeating: 0, count: 16_000), rate: 16_000))
        XCTAssertEqual("ahoj", text)
        XCTAssertEqual(.legacyOnDevice, rec.recognized.first?.0)
        perms.speech = .denied
        let none = await d.recognize(Pcm16(samples: [1], rate: 16_000))
        XCTAssertNil(none)
        XCTAssertEqual(1, rec.recognized.count)
    }

    func testTheSystemAnswersForTheNineLanguages() async {
        // The real Speech framework: whatever this simulator can do, a language never gets a recogniser
        // that would go to the network.
        let system = SpeechRecognizerSystem()
        for lang in ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"] {
            let tag = VoiceSpeech.localeTag(setting: lang, appLanguage: "en")
            let facts = await system.facts(for: Locale(identifier: tag))
            if case .ready(.legacyOnDevice) = RecognizerPlan.choose(facts) {
                XCTAssertTrue(SFSpeechRecognizer(locale: Locale(identifier: tag))?.supportsOnDeviceRecognition == true, tag)
            }
        }
    }
}
