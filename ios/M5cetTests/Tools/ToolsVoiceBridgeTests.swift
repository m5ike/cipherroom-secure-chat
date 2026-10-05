// The tools on the real voice (Platform/Voice's VoiceService): the bridge's state and
// the voice changer's reset, the operator's speech module and the voice changer's gate
// over this part's HTTP (the server's own status answer), the voice settings read live
// from the design's settings, the environment's words.

import Foundation
import M5Core
import M5Design
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class ToolsVoiceBridgeTests: XCTestCase {
    func testTheBridgeFollowsTheService() {
        let service = VoiceService()
        let bridge = VoiceServiceToolsVoice(service)
        XCTAssertFalse(bridge.dictating)
        XCTAssertFalse(bridge.speaking)
        XCTAssertEqual(bridge.fxTesting, "idle")
        XCTAssertEqual(bridge.scope["dictating"], .bool(false))
        // voiceFx.reset: the custom effect's keys with Android's defaults, not the switch or the preset.
        let reset = bridge.fxResetCustom()
        XCTAssertEqual(reset.map(\.0), ["voiceFx.pitch", "voiceFx.formant", "voiceFx.robot", "voiceFx.echo", "voiceFx.echoMs", "voiceFx.echoFeedback", "voiceFx.whisper", "voiceFx.gain"])
        XCTAssertEqual(reset.first?.1, .number(-5))
        XCTAssertNotNil(bridge.fxScope["testing"].stringValue)
    }

    func testVoiceFxResetWritesTheDefaultsIntoTheSettings() {
        let saved = ToolParts.voice
        defer { ToolParts.voice = saved }
        let services = RendererTestSupport.services(state: StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false)))
        ToolParts.install(design: services, engine: ToolsFnEngine(transport: ToolsFakeTransport()))
        ToolParts.voice = VoiceServiceToolsVoice(VoiceService())
        let host = DesignHost(services: services)
        var s = host.settings
        _ = s.set("voiceFx.pitch", .number(7))
        host.settings = s
        XCTAssertEqual(host.settings.get("voiceFx.pitch"), .number(7))
        _ = services.actions.dispatch(.voiceFxReset, context: ActionContext(host: host, source: nil))
        XCTAssertEqual(host.settings.get("voiceFx.pitch"), .number(-5))
    }

    func testTheSpeechModuleAndTheGateGoThroughThisPartsHttp() async throws {
        let t = ToolsFakeTransport()
        t.route("/api/speech/status", ToolsFixtures.answer("speechStatus"))
        t.route("/api/speech/tts", .json("{\"ok\":true,\"audioBase64\":\"AQID\",\"mime\":\"audio/wav\"}"))
        t.route("/api/client-config", ToolsFixtures.answer("clientConfig"))
        let server = ToolsSpeechServer(transport: t, server: { "https://chat.example.com" }, bearer: { "Bearer tok" })
        let st = await server.status()
        XCTAssertEqual(st, SpeechServerStatus.none)
        let audio = try await server.tts(text: "Ahoj", connector: nil, voice: nil)
        XCTAssertEqual(audio.bytes, Data([1, 2, 3]))
        XCTAssertEqual(audio.mime, "audio/wav")
        XCTAssertEqual(t.seen("/api/speech/tts").first?.authorization, "Bearer tok")
        let config = try await ToolsClientConfigFetcher(transport: t).clientConfig(server: "https://chat.example.com")
        XCTAssertNotNil(config.object("config")?.object("composer"))
        XCTAssertNil(t.seen("/api/client-config").first?.authorization) // the gate asks as a guest
    }

    func testTheVoiceSettingsAreTheDesignsAndTheWordsItsTexts() {
        let services = RendererTestSupport.services()
        services.setLang("en")
        let settings = DesignVoiceSettings(services)
        XCTAssertEqual(settings.string("voice.engine"), "device")
        XCTAssertEqual(settings.number("voiceFx.pitch"), -5)
        XCTAssertFalse(settings.bool("voice.autoplay"))
        XCTAssertEqual(settings.appLanguage, "en")
        var s = services.settings
        _ = s.set("voice.autoplay", true)
        services.settings = s
        XCTAssertTrue(settings.bool("voice.autoplay")) // read live
        let env = ToolsVoiceEnvironment(services)
        XCTAssertEqual(env.text("voice.defaultVoice"), "Default voice")
        XCTAssertNil(env.text("no.such.key"))
    }
}
