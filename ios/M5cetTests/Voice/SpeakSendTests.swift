// Ports of android/app/src/test/java/cz/m5cet/app/voice/SpeakSendTest.java and
// ServerVoiceConsentTest.java — 6.7 speak and send with a pretend dictation and voice: the field's text
// spoken and sent as a voice message (no text along); an empty field dictated first; the dictated text
// sent as a message; a failed voice says why and keeps the text; the composer going away sends
// nothing. 6.12 (G-14): voice.engine = server asks once per room, naming the provider.

import XCTest
@testable import M5cet

@MainActor
private final class Composer: SpeakSendIO {
    typealias Clip = String
    var field = ""
    var recogniser = true, dictating = false
    var log: [String] = []
    var pending: (@MainActor (String?, String?) -> Void)?
    var pendingText: String?

    var canDictate: Bool { recogniser }
    func startDictation() { dictating = true; log.append("dictate") }
    func stopDictation() { dictating = false; log.append("stop") }
    var fieldText: String { field }
    func clearField() { field = ""; log.append("clear") }
    func speak(_ text: String, done: @escaping @MainActor (String?, String?) -> Void) { pendingText = text; pending = done; log.append("speak:" + text) }
    func sendText(_ text: String) { log.append("text:" + text) }
    func sendVoice(_ clip: String) { log.append("voice:" + clip) }
    func notice(_ key: String, _ detail: String) { log.append("notice:" + key + (detail.isEmpty ? "" : "=" + detail)) }
}

@MainActor
final class SpeakSendTests: XCTestCase {
    func testTheFieldsTextIsSpokenAndSentAsAVoiceMessage() {
        let c = Composer()
        let f = SpeakSend(c)
        c.field = "  Ahoj, jak se máš?  "
        f.asVoice()
        XCTAssertEqual(.speaking, f.state)
        XCTAssertEqual("Ahoj, jak se máš?", c.pendingText)
        c.pending?("clip.m4a", nil)
        XCTAssertEqual(["notice:voice.synthesizing", "speak:Ahoj, jak se máš?", "voice:clip.m4a", "clear"], c.log)
        XCTAssertEqual(.idle, f.state)
        XCTAssertFalse(c.log.contains { $0.hasPrefix("text:") }) // the voice goes without the text
    }

    func testAnEmptyFieldIsDictatedFirstThenSpoken() {
        let c = Composer()
        let f = SpeakSend(c)
        f.asVoice()
        XCTAssertEqual(.dictating, f.state)
        XCTAssertTrue(c.dictating)
        c.field = "dobrý den" // the dictated words in the field
        f.stop() // the stop square
        XCTAssertEqual(.finishing, f.state)
        f.dictationEnded()
        XCTAssertEqual("dobrý den", c.pendingText)
        c.pending?("v", nil)
        XCTAssertEqual(["notice:speakSend.speakNow", "dictate", "stop", "notice:voice.synthesizing", "speak:dobrý den", "voice:v", "clear"], c.log)
    }

    func testSpeakItSendText() {
        let c = Composer()
        let f = SpeakSend(c)
        f.asText()
        XCTAssertEqual(.text, f.mode)
        c.field = "posílám text"
        f.asText() // the same item again stops it
        f.dictationEnded()
        XCTAssertEqual(["notice:speakSend.speakNowText", "dictate", "stop", "text:posílám text", "clear"], c.log)
        XCTAssertEqual(.idle, f.state)
    }

    func testNothingHeardSendsNothing() {
        let c = Composer()
        let f = SpeakSend(c)
        f.asVoice()
        f.stop()
        f.dictationEnded()
        XCTAssertTrue(c.log.contains("notice:voice.nothingHeard"))
        XCTAssertNil(c.pending)
        XCTAssertEqual(.idle, f.state)
    }

    func testAFailedVoiceSaysWhyAndKeepsTheText() {
        let c = Composer()
        let f = SpeakSend(c)
        c.field = "text"
        f.asVoice()
        c.pending?(nil, "tts-none")
        XCTAssertTrue(c.log.contains("notice:speakSend.noVoice"))
        XCTAssertEqual("text", c.field)
        f.asVoice()
        c.pending?(nil, "tts-server-off")
        XCTAssertTrue(c.log.contains("notice:speakSend.serverOff"))
        f.asVoice()
        c.pending?(nil, "tts-failed: HTTP 503")
        XCTAssertTrue(c.log.contains("notice:speakSend.failed=HTTP 503"))
        XCTAssertFalse(c.log.contains { $0.hasPrefix("voice:") })
    }

    func testTheComposerGoingAwaySendsNothing() {
        let c = Composer()
        let f = SpeakSend(c)
        c.field = "text"
        f.asVoice()
        f.cancel()
        c.pending?("late", nil)
        XCTAssertFalse(c.log.contains("voice:late"))
        XCTAssertEqual(.idle, f.state)
        f.asText()
        f.cancel()
        f.dictationEnded() // the dictation's end after the cancel: nothing
        XCTAssertFalse(c.log.contains { $0.hasPrefix("text:") })
    }

    func testWithoutARecogniserItSaysSo() {
        let c = Composer()
        c.recogniser = false
        let f = SpeakSend(c)
        f.asVoice()
        XCTAssertEqual(["notice:look.dictate.none"], c.log)
        XCTAssertEqual(.idle, f.state)
    }

    func testKnowsAWav() {
        XCTAssertTrue(SpeakSendErrors.isWav(Array("RIFF\0\0\0\0WAVEfmt ".utf8)))
        XCTAssertFalse(SpeakSendErrors.isWav([0xff, 0xfb, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
        XCTAssertFalse(SpeakSendErrors.isWav(nil))
        XCTAssertEqual("speakSend.failed", SpeakSendErrors.key("tts-failed: x"))
        XCTAssertEqual("x", SpeakSendErrors.detail("tts-failed: x"))
    }
}

@MainActor
final class ServerVoiceConsentTests: XCTestCase {
    private var asked: [String] = []
    private var results: [Bool] = []

    private func answering(_ yes: Bool) -> ServerVoiceConsent.Ask {
        { [weak self] use, provider, answer in self?.asked.append(use.rawValue + ":" + provider); answer(yes) }
    }

    private func record() -> @MainActor (Bool) -> Void { { [weak self] in self?.results.append($0) } }

    override func setUp() async throws {
        await MainActor.run { ServerVoiceConsent.reset() }
    }

    func testAskedOncePerRoomNamingTheProvider() {
        ServerVoiceConsent.check("room-a", .speak, provider: "Piper (cs)", ask: answering(true), then: record())
        ServerVoiceConsent.check("room-a", .speak, provider: "Piper (cs)", ask: answering(true), then: record())
        XCTAssertEqual(["SPEAK:Piper (cs)"], asked)
        XCTAssertEqual([true, true], results)
        XCTAssertTrue(ServerVoiceConsent.isGiven("room-a", .speak))
        // Another room, and the other use (a recording to transcribe), ask again.
        ServerVoiceConsent.check("room-b", .speak, provider: "Cloud TTS", ask: answering(true), then: record())
        ServerVoiceConsent.check("room-a", .transcribe, provider: "Whisper", ask: answering(true), then: record())
        XCTAssertEqual(["SPEAK:Piper (cs)", "SPEAK:Cloud TTS", "TRANSCRIBE:Whisper"], asked)
    }

    func testANoSendsNothingAndIsNotRemembered() {
        ServerVoiceConsent.check("room-a", .speak, provider: "Cloud TTS", ask: answering(false), then: record())
        XCTAssertEqual([false], results)
        XCTAssertFalse(ServerVoiceConsent.isGiven("room-a", .speak))
        ServerVoiceConsent.check("room-a", .speak, provider: "Cloud TTS", ask: answering(true), then: record())
        XCTAssertEqual(2, asked.count)
        // No one to ask (no screen): no.
        ServerVoiceConsent.check("room-c", .speak, provider: "x", ask: nil, then: record())
        XCTAssertEqual([false, true, false], results)
        // An unnamed provider is still asked about (as "?"), never silently.
        ServerVoiceConsent.check("room-d", .speak, provider: "  ", ask: answering(false), then: record())
        XCTAssertEqual("SPEAK:?", asked.last)
    }

    func testALockForgetsTheYeses() {
        ServerVoiceConsent.check("room-a", .speak, provider: "p", ask: answering(true), then: record())
        ServerVoiceConsent.reset()
        XCTAssertFalse(ServerVoiceConsent.isGiven("room-a", .speak))
        ServerVoiceConsent.check("room-a", .speak, provider: "p", ask: answering(true), then: record())
        XCTAssertEqual(2, asked.count)
    }

    func testADeclinedVoiceSaysSo() {
        XCTAssertEqual("speakSend.declined", SpeakSendErrors.key("declined"))
        XCTAssertEqual("speakSend.serverOff", SpeakSendErrors.key("tts-server-off"))
        XCTAssertEqual("speakSend.failed", SpeakSendErrors.key("tts-failed: x"))
    }
}
