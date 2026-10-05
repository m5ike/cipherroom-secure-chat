// The tools' parts as the app installs them: the slots (aiChat, voicePad), the
// actions (ai.*, voice.dictate, voiceFx.*, calllog.*), the engine and the
// variables in whichever core the parts use ($ai, $log, $voiceFx, $voices,
// $voice), the AI chat (android ui/parts/AiChat: banner, turns, send / stop /
// clear against the server's own answers) and the voice pad (ToolPanels.VoicePad:
// dictation into the transcript, its state line, into a message).

import Foundation
import M5Core
import M5Design
import M5Proto
import SwiftUI
import XCTest
@testable import M5cet

@MainActor
final class ToolPartsTests: XCTestCase {
    private var services: DesignServices!
    private var engine: ToolsFnEngine!
    private var core: CoreModels!
    private var savedShared: CoreModels!
    private var savedVoice: (any ToolsVoice)!

    override func setUp() async throws {
        savedShared = CoreModels.shared
        savedVoice = ToolParts.voice
        services = RendererTestSupport.services(state: StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false)))
        engine = ToolsFnEngine(transport: ToolsFixtures.server())
        engine.timerEnabled = false
        core = toolsCore(ToolsRecordingRoom("team"))
        CoreModels.shared = core
        ToolParts.install(design: services, engine: engine)
        ToolParts.ai.input = ""
        ToolParts.ai.clear()
    }

    override func tearDown() async throws {
        ToolParts.voice = savedVoice
        CoreModels.shared = savedShared
    }

    private func host() -> DesignHost {
        let h = DesignHost(services: services)
        h.reducedMotion = true
        return h
    }

    func testTheSlotsAndActionsAreRegistered() {
        XCTAssertTrue(services.slots.has("aiChat"))
        XCTAssertTrue(services.slots.has("voicePad"))
        for a in ["ai.send", "ai.stop", "ai.clear", "voice.dictate", "voiceFx.test", "voiceFx.reset", "calllog.open", "calllog.refresh",
                  "calllog.item", "calllog.call", "calllog.clear", "calllog.system"] {
            XCTAssertTrue(services.actions.handles(a), a)
        }
        // Not ours: the NFC part's and the core's.
        XCTAssertFalse(services.actions.handles("nfc.read"))
    }

    func testTheEngineAndTheVariablesGoIntoTheCoreOfNow() {
        XCTAssertTrue(core.fn === engine)
        XCTAssertTrue(core.variables.has("ai", "ai"))
        XCTAssertTrue(core.variables.has("log", "log"))
        XCTAssertTrue(core.variables.has("settings.voiceFx", "voiceFx"))
        XCTAssertTrue(core.variables.has("voice", "voices"))
        XCTAssertEqual(core.variables.values(for: "ai")["ai"]?["state"], "loading")
        // Another core (the preview, the real one after the start): attached again when a part is drawn.
        let other = toolsCore(nil)
        CoreModels.shared = other
        XCTAssertNil(other.fn)
        ToolParts.attach()
        XCTAssertTrue(other.fn === engine)
        XCTAssertTrue(other.variables.has("log", "log"))
        // The composer's suggestions now come from the engine.
        let h = host()
        other.composer(for: h).text = "/"
        _ = other.composer(for: h).suggestions() // through the engine (no list yet: nothing to offer)
        XCTAssertNil(other.composer(for: h).argHint())
    }

    func testTheVoiceFollowsTheService() {
        let v = ToolsFakeVoice()
        ToolParts.voice = v
        XCTAssertEqual(core.tools.voice["available"], .bool(true))
        XCTAssertEqual(core.variables.values(for: "settings.voiceFx")["voiceFx"]?["testing"], "idle")
        v.speaking = true
        toolsWait { self.core.tools.voice["speaking"] == .bool(true) }
        // voiceFx.test / voiceFx.reset reach the service.
        let h = host()
        _ = services.actions.dispatch(.voiceFxTest, context: ActionContext(host: h, source: nil))
        XCTAssertEqual(v.fxTesting, "recording")
        _ = services.actions.dispatch(.voiceFxReset, context: ActionContext(host: h, source: nil))
        XCTAssertEqual(v.resets, 1)
        // $voices: asked once.
        _ = core.variables.values(for: "voice")
        toolsWait { (self.core.variables.values(for: "voice")["voices"]?.arrayValue?.count ?? 0) == 2 }
    }

    // MARK: AI chat

    func testTheAiChatBannerAndTurns() {
        let t: (String) -> String = { "[" + $0 + "]" }
        XCTAssertEqual(AiChatModel.banner(nil, t), "[ai.notE2ee]")
        XCTAssertEqual(AiChatModel.banner(AiAssistant.off, t), "[ai.off]")
        var turn = AiAssistant.Turn(id: 1, user: false)
        turn.pending = true
        XCTAssertEqual(AiChatModel.text(turn, t), "[ai.thinking]")
        turn.errorCode = "rate"
        XCTAssertEqual(AiChatModel.text(turn, t), "[ai.error]")
        turn.errorMessage = "slow down"
        XCTAssertEqual(AiChatModel.text(turn, t), "slow down")
        turn.model = "m1"
        turn.stopped = true
        XCTAssertEqual(AiChatModel.meta(turn, t), "[ai.stopped] · m1")
        XCTAssertNil(AiChatModel.meta(AiAssistant.Turn(id: 2, user: true), t))
    }

    func testAskingTheAssistantThroughTheDesignsActions() {
        let h = host()
        let ai = ToolParts.ai
        ai.loadIfNeeded()
        toolsWait { ToolParts.assistant.status != nil }
        XCTAssertEqual(ai.scope["state"], "ready")
        XCTAssertEqual(ToolParts.assistant.model, "local-ai/m1")
        ai.input = "Ahoj?"
        XCTAssertTrue(services.actions.dispatch(.aiSend, context: ActionContext(host: h, source: nil)))
        toolsWait { ToolParts.assistant.lastAnswer != nil }
        XCTAssertEqual(ToolParts.assistant.lastAnswer?.text, "Ahoj! **Jak** mohu pomoci?")
        XCTAssertEqual(ToolParts.assistant.lastAnswer?.model, "m1")
        XCTAssertEqual(ai.input, "")
        XCTAssertEqual(ToolParts.assistant.turns.count, 2)
        _ = services.actions.dispatch(.aiClear, context: ActionContext(host: h, source: nil))
        XCTAssertTrue(ToolParts.assistant.turns.isEmpty)
    }

    func testStoppingAnAnswerKeepsWhatCame() {
        let transport = ToolsFakeTransport()
        transport.route("/api/ai/status", ToolsFixtures.answer("aiStatus"))
        transport.route("/api/ai/chat", .sse("event: delta\ndata: {\"text\":\"Půl\"}\n\n", stall: true))
        let a = AiAssistant(api: FnApi(base: "https://chat.example.com", transport: transport))
        Task { _ = await a.loadStatus(bearer: "") }
        toolsWait { a.status != nil }
        XCTAssertTrue(a.send(bearer: "", question: "x"))
        toolsWait { a.turns.last?.text == "Půl" }
        XCTAssertTrue(a.busy)
        a.stop()
        XCTAssertFalse(a.busy)
        XCTAssertEqual(a.turns.last?.stopped, true)
        XCTAssertEqual(a.turns.last?.pending, false)
        XCTAssertEqual(a.turns.last?.text, "Půl")
        toolsWait { transport.open == 0 }
    }

    func testAnAssistantThatIsOffSendsNothing() {
        let transport = ToolsFakeTransport()
        transport.route("/api/ai/status", ToolsFixtures.answer("aiStatusOff"))
        let a = AiAssistant(api: FnApi(base: "https://chat.example.com", transport: transport))
        Task { _ = await a.loadStatus(bearer: "") }
        toolsWait { a.status != nil }
        XCTAssertEqual(a.status?.state, "off")
        XCTAssertFalse(a.send(bearer: "", question: "x"))
        XCTAssertTrue(transport.seen("/api/ai/chat").isEmpty)
    }

    // MARK: voice pad

    func testTheVoicePadDictatesIntoItsTranscript() {
        let v = ToolsFakeVoice()
        ToolParts.voice = v
        let pad = VoicePadModel()
        pad.transcript = "Ahoj"
        pad.toggle(v)
        toolsWait { v.sink != nil }
        XCTAssertEqual(VoicePadModel.stateText(v) { "[" + $0 + "]" }, "🎙 [voice.listening]")
        v.sink?("jak", false)
        XCTAssertEqual(pad.transcript, "Ahoj jak")
        v.sink?("jak se máš", true)
        XCTAssertEqual(pad.transcript, "Ahoj jak se máš")
        v.sink?("dobře", false)
        XCTAssertEqual(pad.transcript, "Ahoj jak se máš dobře")
        pad.toggle(v) // the microphone again: stops
        XCTAssertFalse(v.dictating)
        XCTAssertEqual(VoicePadModel.stateText(v) { "[" + $0 + "]" }, "[voice.tapToDictate]")
        v.say("x")
        XCTAssertEqual(VoicePadModel.stateText(v) { "[" + $0 + "]" }, "🔊 [voice.speak]…")
        pad.clear()
        XCTAssertEqual(pad.transcript, "")
    }

    func testVoiceDictateReachesOnlyAPadOnScreen() {
        let v = ToolsFakeVoice()
        ToolParts.voice = v
        let h = host()
        ToolParts.pad.shown = false
        _ = services.actions.dispatch(.voiceDictate, context: ActionContext(host: h, source: nil))
        toolsSettle()
        XCTAssertFalse(v.dictating)
        ToolParts.pad.shown = true
        defer { ToolParts.pad.shown = false }
        _ = services.actions.dispatch(.voiceDictate, context: ActionContext(host: h, source: nil))
        toolsWait { v.dictating }
    }

    func testIntoAMessage() {
        let h = host()
        let pad = VoicePadModel()
        pad.transcript = "  hotovo  "
        XCTAssertTrue(pad.toChat(host: h, core: core))
        XCTAssertEqual(core.composer(for: h).text, "hotovo")
        XCTAssertEqual(h.form["composer"], "hotovo")
        XCTAssertEqual(h.screen, "room")
        // No room: nothing happens.
        XCTAssertFalse(pad.toChat(host: h, core: toolsCore(nil)))
    }

    // MARK: drawing

    func testTheSlotsDraw() {
        let v = ToolsFakeVoice()
        ToolParts.voice = v
        for (screen, size) in [("ai", CGSize(width: 390, height: 844)), ("voice", CGSize(width: 390, height: 844))] {
            let h = host()
            h.showScreen(screen, transition: false)
            let (vc, window) = RendererTestSupport.show(DesignShell(host: h), size: size)
            toolsSettle(0.4)
            XCTAssertGreaterThan(RendererTestSupport.draw(vc.view).size.width, 0)
            window.isHidden = true
        }
    }
}
