// VoiceService (Android voice/Voice.java) with the Speech framework, the session and the server faked:
// dictation into a sink with read-back, autoplay, the background stopping what listens, the server's
// voice and transcription only after the consent, the errors the composer says; the voice settings'
// mapping onto AVSpeechSynthesizer; the audio session's categories and the call owning it; the voice
// changer's test; the recording buffer through the voice changer; the call's utterances and speakers.

import AVFoundation
import XCTest
import M5Core
@testable import M5cet

@MainActor
private final class Sink: VoiceSink {
    var log: [String] = []
    func onText(_ text: String, done: Bool) { log.append((done ? "F:" : "P:") + text) }
    func onEnded() { log.append("ended") }
}

private final class FakeServer: VoiceSpeechServer, @unchecked Sendable {
    var status = SpeechServerStatus(tts: true, voices: [.init(id: "piper-cs", label: "Piper (cs)")], stt: true, transcribers: [.init(id: "w", label: "Whisper")])
    var audio: (Data, String) = (Data(), "audio/mpeg")
    var said: [String] = []
    var heard: [Data] = []
    var fail = false

    func status() async -> SpeechServerStatus { status }
    func tts(text: String, connector: String?, voice: String?) async throws -> (bytes: Data, mime: String) {
        if fail { throw NetErrorStub() }
        said.append(text + "@" + (connector ?? ""))
        return audio
    }
    func stt(wav: Data, connector: String?) async throws -> String { heard.append(wav); return "přepis" }
}

private struct NetErrorStub: Error, CustomStringConvertible { var description: String { "HTTP 503" } }

@MainActor
private final class Env: VoiceEnvironment {
    var server = "https://chat.example.com"
    var signedIn = true
    var accountGroups: [String] = []
    func text(_ key: String) -> String? { nil }
}

@MainActor
final class VoiceServiceTests: XCTestCase {
    private func make(_ facts: RecognizerFacts = RecognizerFacts(transcriberSupported: true, transcriberInstalled: true))
        -> (VoiceService, FakeVoiceSettings, FakeRecognizers, FakeAudioSession) {
        let settings = FakeVoiceSettings(), rec = FakeRecognizers(), session = FakeAudioSession()
        rec.facts["cs-CZ"] = facts
        let s = VoiceService(settings: settings, session: session, recognizers: rec, permissions: FakePermissions(), scheduler: ManualScheduler(),
                             fxIO: FakeFxIO())
        return (s, settings, rec, session)
    }

    override func setUp() async throws { await MainActor.run { ServerVoiceConsent.reset() } }

    func testDictationGoesIntoTheSinkAndTheScreensHear() async {
        let (v, _, rec, _) = make()
        var changes = 0
        let token = v.addStateListener { changes += 1 }
        let sink = Sink()
        v.dictate(sink)
        await settle()
        XCTAssertTrue(v.dictating)
        let ev = rec.sessions[0].events
        ev.ready()
        ev.partial("ahoj")
        ev.fin("Ahoj.")
        XCTAssertTrue(v.listening)
        v.stopDictation()
        ev.end()
        XCTAssertEqual(["P:ahoj", "F:Ahoj.", "ended"], sink.log)
        XCTAssertFalse(v.dictating)
        XCTAssertGreaterThan(changes, 2)
        v.removeStateListener(token)
    }

    func testTheBackgroundStopsWhatListens() async {
        let (v, _, rec, _) = make()
        var dropped = 0
        v.addBackgroundListener { dropped += 1 }
        v.dictate(Sink())
        await settle()
        rec.sessions[0].events.ready()
        v.background()
        XCTAssertEqual(1, rec.sessions[0].session.stops) // the last words still come
        XCTAssertEqual(1, dropped)
    }

    func testTheErrorTheComposerSays() async {
        let (v, _, _, _) = make(RecognizerFacts(dictationSupported: true)) // a model still to download
        v.dictate(Sink())
        await settle()
        XCTAssertEqual("language-not-installed", v.takeDictationError())
        XCTAssertEqual("", v.takeDictationError())
        let (w, _, _, _) = make(RecognizerFacts())
        w.dictate(Sink())
        await settle()
        XCTAssertEqual("language-not-supported", w.takeDictationError())
    }

    func testAutoplayOnlyWhenSwitchedOn() {
        let (v, settings, _, session) = make()
        v.speakIncoming(sender: "Jana", text: "ahoj")
        XCTAssertTrue(session.log.isEmpty)
        settings.values["voice.autoplay"] = true
        v.speakIncoming(sender: "Jana", text: "  ")
        XCTAssertTrue(session.log.isEmpty)
        v.speakIncoming(sender: "Jana", text: "ahoj")
        XCTAssertEqual(["begin:speak"], session.log)
        v.speech.stop()
    }

    func testTheServersVoiceOnlyAfterTheConsent() async throws {
        let (v, settings, _, _) = make()
        settings.values["voice.engine"] = "server"
        let env = Env()
        v.environment = env
        let server = FakeServer()
        v.server = server
        // No one to ask: nothing leaves.
        var r = await v.textToVoiceMessage("Dobrý den", room: "r1", ask: nil)
        XCTAssertEqual("declined", r.error)
        XCTAssertTrue(server.said.isEmpty)
        // Asked, naming the provider; a no sends nothing.
        var asked: [String] = []
        r = await v.textToVoiceMessage("Dobrý den", room: "r1", ask: { use, provider, answer in asked.append(provider); answer(false) })
        XCTAssertEqual("declined", r.error)
        XCTAssertEqual(["Piper (cs)"], asked)
        XCTAssertTrue(server.said.isEmpty)
        // A yes: the server's WAV becomes the AAC voice message (at most 24 kHz).
        let wav = AudioPCM.wavBytes((0..<22_050).map { Int16(5000 * sin(Double($0) * 0.1)) }, rate: 22_050)
        server.audio = (wav, "audio/wav")
        r = await v.textToVoiceMessage("Dobrý den", room: "r1", ask: { _, _, answer in answer(true) })
        XCTAssertNil(r.error)
        XCTAssertEqual("audio/mp4", r.clip?.mime)
        XCTAssertEqual(1000, r.clip?.durationMs)
        XCTAssertEqual(["Dobrý den@piper-cs"], server.said)
        // Agreed in that room: not asked again; an MP3 answer goes as it is.
        server.audio = (Data([0xFF, 0xFB, 0x90, 0x00]), "audio/mpeg")
        r = await v.textToVoiceMessage("Znovu", room: "r1", ask: nil)
        XCTAssertEqual("audio/mpeg", r.clip?.mime)
        // The server's errors.
        server.fail = true
        r = await v.textToVoiceMessage("x", room: "r1", ask: nil)
        XCTAssertEqual("tts-failed: HTTP 503", r.error)
        server.status = .none
        r = await v.textToVoiceMessage("x", room: "r1", ask: nil)
        XCTAssertEqual("tts-server-off", r.error)
        env.server = ""
        r = await v.textToVoiceMessage("x", room: "r1", ask: nil)
        XCTAssertEqual("tts-server-off", r.error)
    }

    func testTheServersTranscriptionOnlyAfterTheConsent() async throws {
        let (v, _, _, _) = make()
        v.environment = Env()
        let server = FakeServer()
        v.server = server
        let pcm = Pcm16(samples: [Int16](repeating: 100, count: 48_000), rate: 48_000)
        var r = await v.serverVoiceToText(pcm, room: "r1", ask: { use, provider, answer in XCTAssertEqual(.transcribe, use); XCTAssertEqual("Whisper", provider); answer(false) })
        XCTAssertEqual("declined", r.error)
        XCTAssertTrue(server.heard.isEmpty)
        r = await v.serverVoiceToText(pcm, room: "r1", ask: { _, _, answer in answer(true) })
        XCTAssertEqual("přepis", r.text)
        // The server reads a 16 kHz mono WAV (as the web sends it).
        let sent = try AudioPCM.readWav(server.heard[0])
        XCTAssertEqual(16_000, sent.rate)
        XCTAssertEqual(16_000, sent.samples.count)
    }

    func testRecordedAudioToTextOnThePhone() async {
        let (v, _, rec, _) = make()
        var r = await v.voiceToText(Pcm16(samples: [1, 2, 3], rate: 16_000))
        XCTAssertEqual("ahoj", r.text)
        rec.transcript = nil
        r = await v.voiceToText(Pcm16(samples: [1, 2, 3], rate: 16_000))
        XCTAssertEqual("recogniser", r.error)
    }

    func testTheSpeechServersStatus() {
        let s = SpeechServerStatus.parse(JSONObject([
            ("tts", .object(JSONObject([("enabled", true), ("connectors", [.object(JSONObject([("id", "a"), ("label", "Piper")])), .object(JSONObject([("id", "b")]))])]))),
            ("stt", .object(JSONObject([("enabled", false)]))),
        ]))
        XCTAssertTrue(s.tts)
        XCTAssertEqual([.init(id: "a", label: "Piper"), .init(id: "b", label: "b")], s.voices)
        XCTAssertFalse(s.stt)
        XCTAssertEqual(SpeechServerStatus.none, SpeechServerStatus.parse(JSONObject()))
    }

    func testTheVoiceChangerFollowsTheSwitchAndTheGate() {
        let (v, settings, _, _) = make()
        settings.values["voiceFx.on"] = true
        settings.values["voiceFx.preset"] = "robot"
        v.recomputeFx() // the gate has not answered: off
        XCTAssertFalse(MicFx.active)
        MicFx.use(VoiceFx.neutralParams)
    }
}

@MainActor
final class VoiceSpeechTests: XCTestCase {
    func testTheNineLanguagesAsFullTags() {
        let want = ["en": "en-US", "cs": "cs-CZ", "de": "de-DE", "es": "es-ES", "it": "it-IT", "fr": "fr-FR", "sk": "sk-SK", "sl": "sl-SI", "fi": "fi-FI"]
        for (lang, tag) in want {
            XCTAssertEqual(tag, VoiceSpeech.localeTag(setting: "", appLanguage: lang))
            XCTAssertEqual(tag, VoiceSpeech.localeTag(setting: lang, appLanguage: "en"))
        }
        XCTAssertEqual("pt-BR", VoiceSpeech.localeTag(setting: "pt-BR", appLanguage: "cs")) // anything else as it is
    }

    func testRateAndPitchAsAndroidsSettings() {
        XCTAssertEqual(AVSpeechUtteranceDefaultSpeechRate, VoiceSpeech.utteranceRate(1))
        XCTAssertEqual(AVSpeechUtteranceDefaultSpeechRate, VoiceSpeech.utteranceRate(0)) // 0 = the default (Android's clamp)
        XCTAssertLessThan(VoiceSpeech.utteranceRate(0.5), AVSpeechUtteranceDefaultSpeechRate)
        XCTAssertEqual(AVSpeechUtteranceMaximumSpeechRate, VoiceSpeech.utteranceRate(3))
        XCTAssertEqual(AVSpeechUtteranceMaximumSpeechRate, VoiceSpeech.utteranceRate(10))
        XCTAssertGreaterThan(VoiceSpeech.utteranceRate(0.3), AVSpeechUtteranceMinimumSpeechRate)
        XCTAssertEqual(1, VoiceSpeech.pitchMultiplier(1))
        XCTAssertEqual(0.5, VoiceSpeech.pitchMultiplier(0.3))
        XCTAssertEqual(2, VoiceSpeech.pitchMultiplier(2.5))
    }

    func testTheVoicesListStartsWithTheDefault() {
        let settings = FakeVoiceSettings()
        let s = VoiceSpeech(settings: settings, session: FakeAudioSession())
        s.text = { $0 == "voice.defaultVoice" ? "Výchozí hlas" : $0 }
        let list = s.voices()
        XCTAssertEqual("", list[0].optString("value"))
        XCTAssertEqual("Výchozí hlas", list[0].optString("label"))
        for v in list.dropFirst() { XCTAssertTrue(v.optString("label").hasPrefix("cs"), v.optString("label")) } // Czech voices only
        // A chosen voice that is gone: the language's default.
        settings.values["voice.voice"] = "com.example.gone"
        XCTAssertEqual(s.voice()?.identifier, AVSpeechSynthesisVoice(language: "cs-CZ")?.identifier)
    }

    func testNothingToSayIsNotSaid() {
        let session = FakeAudioSession()
        let s = VoiceSpeech(settings: FakeVoiceSettings(), session: session)
        var answer: Bool?
        s.speak("   ") { answer = $0 }
        XCTAssertEqual(false, answer)
        XCTAssertTrue(session.log.isEmpty)
    }

    func testTheVoiceSynthesizesPCMWhenThisSimulatorHasOne() async throws {
        let settings = FakeVoiceSettings()
        settings.appLanguage = "en"
        let s = VoiceSpeech(settings: settings, session: FakeAudioSession())
        guard !AVSpeechSynthesisVoice.speechVoices().isEmpty else { throw XCTSkip("no voices in this simulator") }
        guard let pcm = await s.synthesize("Hello from M five chat.") else { throw XCTSkip("the simulator's voice made no audio") }
        XCTAssertGreaterThan(pcm.samples.count, pcm.rate / 4)
        XCTAssertTrue([16_000, 22_050, 24_000, 44_100, 48_000].contains(pcm.rate), "\(pcm.rate)")
        let clip = try VoiceService.speechClip(pcm)
        XCTAssertEqual("audio/mp4", clip.mime)
    }
}

final class VoiceAudioSessionTests: XCTestCase {
    func testPlaybackDucksRecordingUsesTheSpeaker() {
        let play = VoiceAudioSession.category(for: [.speak, .play])
        XCTAssertEqual(.playback, play.0)
        XCTAssertEqual(.spokenAudio, play.1)
        XCTAssertTrue(play.2.contains(.duckOthers))
        let rec = VoiceAudioSession.category(for: [.speak, .record])
        XCTAssertEqual(.playAndRecord, rec.0)
        XCTAssertTrue(rec.2.contains(.defaultToSpeaker))
        XCTAssertTrue(rec.2.contains(.allowBluetoothHFP))
        XCTAssertEqual(.playAndRecord, VoiceAudioSession.category(for: [.dictate]).0)
    }

    @MainActor
    func testACallKeepsTheMicrophone() {
        let s = FakeAudioSession()
        s.callActive = true
        XCTAssertThrowsError(try s.begin(.record)) { XCTAssertEqual($0 as? VoiceAudioError, .inCall) }
        XCTAssertThrowsError(try s.begin(.dictate))
        XCTAssertNoThrow(try s.begin(.speak)) // speech goes out through the call's session
    }
}

@MainActor
final class FakeFxIO: FxTestIO {
    var canRecord = true
    var log: [String] = []
    var recorded = Pcm16(samples: [Int16](repeating: 1, count: 16_000), rate: 16_000)
    func startRecording() -> Bool { log.append("record"); return canRecord }
    func stopRecording() -> Pcm16 { log.append("stop"); return recorded }
    func play(_ pcm: Pcm16) -> Bool { log.append("play \(pcm.samples.count)"); return true }
    func stopPlaying() { log.append("quiet") }
}

@MainActor
final class FxTestTests: XCTestCase {
    func testFourSecondsRecordedThenPlayedThenIdle() {
        let io = FakeFxIO(), clock = ManualScheduler()
        let t = FxTest(io: io, scheduler: clock)
        var changes = 0
        t.onChange = { changes += 1 }
        t.toggle()
        XCTAssertEqual(.recording, t.state)
        clock.advance(3999)
        XCTAssertEqual(.recording, t.state)
        clock.advance(1)
        XCTAssertEqual(.playing, t.state)
        clock.advance(1000 + 299) // the recording's length + 300 ms
        XCTAssertEqual(.playing, t.state)
        clock.advance(1)
        XCTAssertEqual(.idle, t.state)
        XCTAssertEqual(["record", "stop", "play 16000", "quiet"], io.log)
        XCTAssertEqual(3, changes)
        XCTAssertEqual("idle", t.scope(allowed: true).optString("testing"))
    }

    func testStoppedWhileRecordingFreesTheMicrophoneAndNothingPlays() {
        let io = FakeFxIO(), clock = ManualScheduler()
        let t = FxTest(io: io, scheduler: clock)
        t.toggle()
        t.toggle() // the same button: stop
        XCTAssertEqual(.idle, t.state)
        clock.advance(10_000)
        XCTAssertEqual(["record", "stop"], io.log)
    }

    func testNoMicrophoneNoTest() {
        let io = FakeFxIO()
        io.canRecord = false
        let t = FxTest(io: io, scheduler: ManualScheduler())
        t.toggle()
        XCTAssertEqual(.idle, t.state)
        let empty = FakeFxIO()
        empty.recorded = Pcm16(samples: [], rate: 16_000)
        let clock = ManualScheduler()
        let u = FxTest(io: empty, scheduler: clock)
        u.toggle()
        clock.advance(4000)
        XCTAssertEqual(.idle, u.state) // nothing recorded: nothing to play
    }
}

final class RecordingBufferTests: XCTestCase {
    func testWithoutTheVoiceChangerTheRecordingIsTheMicrophone() {
        MicFx.use(VoiceFx.neutralParams)
        let b = RecordingBuffer()
        let x = (0..<1600).map { Int16($0 % 300) }
        b.append(x)
        b.append(x)
        XCTAssertEqual(x + x, b.finish())
        XCTAssertGreaterThan(b.level, 0)
    }

    func testTheVoiceChangersDelayIsCutAndItsTailKept() {
        MicFx.use(VoiceFx.preset("deep")!)
        defer { MicFx.use(VoiceFx.neutralParams) }
        let b = RecordingBuffer()
        let x = (0..<16_000).map { Int16(8000 * sin(2 * Double.pi * 300 * Double($0) / 16_000)) }
        for i in stride(from: 0, to: x.count, by: 1600) { b.append(Array(x[i..<(i + 1600)])) }
        let out = b.finish()
        XCTAssertEqual(x.count, out.count) // as long as what was said
        XCTAssertNotEqual(0, out[100]) // no 512 samples of silence at the start (the STFT frame)
        XCTAssertNotEqual(x, out) // and changed
    }
}

final class CallAudioLogicTests: XCTestCase {
    private func block(_ amp: Double, _ n: Int = 480) -> [Int16] { (0..<n).map { Int16(amp * sin(Double($0) * 0.3)) } }

    func testAnUtteranceEndsAfter700msOfQuiet() {
        var c = UtteranceCutter(rate: 48_000)
        for _ in 0..<100 { XCTAssertNil(c.feed(block(3000), rate: 48_000)) }        // 1 s of voice
        for _ in 0..<70 { XCTAssertNil(c.feed(block(10), rate: 48_000)) }          // 700 ms of quiet: not yet
        let u = c.feed(block(10), rate: 48_000)                                     // 710 ms: done
        XCTAssertEqual(48_000 + 71 * 480, u?.samples.count)
        XCTAssertEqual(48_000, u?.rate)
        XCTAssertNil(c.feed(block(10), rate: 48_000))
    }

    func testAShortSoundIsNoUtteranceAndALongOneIsCut() {
        var c = UtteranceCutter(rate: 48_000)
        for _ in 0..<20 { _ = c.feed(block(3000), rate: 48_000) }                   // 200 ms
        var got: Pcm16?
        for _ in 0..<80 { got = got ?? c.feed(block(0), rate: 48_000) }
        XCTAssertNil(got)
        var long = UtteranceCutter(rate: 16_000)
        var cut: Pcm16?
        for i in 0..<1600 { if let u = long.feed(block(3000, 160), rate: 16_000) { cut = u; XCTAssertEqual(1500, i); break } } // at 15 s
        XCTAssertNotNil(cut)
    }

    func testTheSpokenTextReplacesTheMicrophoneAndSilenceFollows() {
        MicFx.use(VoiceFx.neutralParams)
        let taps = CallVoiceTaps()
        var mic = [Int16](repeating: 777, count: 480)
        mic.withUnsafeMutableBufferPointer { taps.processCapture($0.baseAddress!, frames: 480, channels: 1, rate: 48_000) }
        XCTAssertEqual([Int16](repeating: 777, count: 480), mic) // not active, no voice changer: untouched
        taps.setActive(true)
        taps.enqueue(Pcm16(samples: [10, 20, 30], rate: 24_000))
        var out = [Int16](repeating: 777, count: 8)
        out.withUnsafeMutableBufferPointer { taps.processCapture($0.baseAddress!, frames: 4, channels: 2, rate: 48_000) }
        // 24 kHz → 48 kHz, nearest sample, both channels.
        XCTAssertEqual([10, 10, 10, 10, 20, 20, 20, 20], out)
        out = [Int16](repeating: 777, count: 8)
        out.withUnsafeMutableBufferPointer { taps.processCapture($0.baseAddress!, frames: 4, channels: 2, rate: 48_000) }
        XCTAssertEqual([30, 30, 30, 30, 0, 0, 0, 0], out) // then silence (never the microphone)
        XCTAssertEqual(0, taps.queuedSpeech)
    }

    func testTheVoiceChangerOnACallsCapture() {
        MicFx.use(VoiceFx.preset("robot")!)
        defer { MicFx.use(VoiceFx.neutralParams) }
        let taps = CallVoiceTaps()
        var buf = [Int16](repeating: 0, count: 480)
        var changed = false
        for b in 0..<10 {
            for i in 0..<480 { buf[i] = Int16(8000 * sin(2 * Double.pi * 440 * Double(b * 480 + i) / 48_000)) }
            let before = buf
            buf.withUnsafeMutableBufferPointer { taps.processCapture($0.baseAddress!, frames: 480, channels: 1, rate: 48_000) }
            if buf != before { changed = true }
        }
        XCTAssertTrue(changed)
    }

    func testWhoSpoke() {
        XCTAssertEqual("a", CallVoiceSpeaker.pick(peers: ["a"], before: [:], after: [:]))
        XCTAssertEqual("b", CallVoiceSpeaker.pick(peers: ["a", "b"], before: ["a": 1, "b": 1], after: ["a": 1.2, "b": 3]))
        XCTAssertEqual("a", CallVoiceSpeaker.pick(peers: ["a", "b"], before: [:], after: [:])) // nothing to tell: the first
        XCTAssertNil(CallVoiceSpeaker.pick(peers: [], before: [:], after: [:]))
    }
}

@MainActor
private final class FakePeers: CallVoicePeers {
    var peerIds = ["p1"]
    var energy: [String: Double] = [:]
    func audioEnergy() async -> [String: Double] { energy }
}

private final class FakeSourceVault: VoiceSourceVault, @unchecked Sendable {
    var stored: [String: Data] = [:]
    func store(id: String, bytes: Data) throws { stored[id] = bytes }
}

@MainActor
final class CallVoiceBridgeTests: XCTestCase {
    func testWhatThePeerSaysComesAsTheirTextWithItsRecording() async throws {
        let taps = CallVoiceTaps()
        let bridge = CallVoiceBridge(taps: taps)
        let vault = FakeSourceVault()
        bridge.vault = vault
        var heardPcm: [Int] = []
        bridge.recognize = { pcm in heardPcm.append(pcm.rate); return " dobrý den " }
        var got: [(String, String, String?)] = []
        bridge.start(peers: FakePeers()) { got.append(($0, $1, $2)) }
        // The call's playout: 1 s of voice, then quiet.
        let voice = (0..<480).map { Int16(3000 * sin(Double($0) * 0.3)) }, quiet = [Int16](repeating: 0, count: 480)
        for _ in 0..<100 { voice.withUnsafeBufferPointer { taps.processPlayout($0.baseAddress!, frames: 480, channels: 1, rate: 48_000) } }
        for _ in 0..<80 { quiet.withUnsafeBufferPointer { taps.processPlayout($0.baseAddress!, frames: 480, channels: 1, rate: 48_000) } }
        let deadline = Date().addingTimeInterval(5)
        while got.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(1, got.count)
        XCTAssertEqual("p1", got.first?.0)
        XCTAssertEqual("dobrý den", got.first?.1)
        XCTAssertEqual([16_000], heardPcm) // transcribed at 16 kHz
        let source = try XCTUnwrap(got.first?.2)
        XCTAssertEqual(.mp4, VoiceClipCodec.container([UInt8](vault.stored[source]!), mime: nil)) // kept as AAC
        bridge.stop()
        XCTAssertFalse(taps.isActive)
    }

    func testTextIsSpokenIntoTheCall() async {
        let taps = CallVoiceTaps()
        let bridge = CallVoiceBridge(taps: taps)
        bridge.synthesize = { _ in Pcm16(samples: [1, 2, 3], rate: 24_000) }
        let none = await bridge.say("ahoj")
        XCTAssertNil(none) // not in a voice ↔ text call
        XCTAssertEqual(0, taps.queuedSpeech)
        bridge.start(peers: FakePeers()) { _, _, _ in }
        _ = await bridge.say("ahoj")
        XCTAssertEqual(1, taps.queuedSpeech)
        bridge.stop()
    }
}
