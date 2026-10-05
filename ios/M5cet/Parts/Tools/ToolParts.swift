// The tools' parts (6.14 iOS) — functions and models, the AI assistant, the
// voice pad, the History — registered in one line of App/Bootstrap.swift:
//
//   ToolParts.install(into: model)
//
// Slots:     aiChat (AiChatView), voicePad (VoicePadView).
// Actions:   ai.send, ai.stop, ai.clear, voice.dictate, voiceFx.test, voiceFx.reset,
//            calllog.open, calllog.refresh, calllog.item, calllog.call, calllog.clear, calllog.system.
// Core:      core.fn = the commands engine (ToolsFnEngine); variables $ai (ai), $log (log),
//            $voiceFx (settings.voiceFx), $voices (voice, settings.voice, dictate.options);
//            core.tools.voice ($voice) follows the voice service.
// Chat:      the bubble draws FnMessageContent(message:) for a command's call and a model's answer;
//            FnModelFace.scope gives $msg.model.
// Voice:     ToolParts.voice = VoiceServiceToolsVoice(VoiceService.shared); what of the service's integration
//            is unset gets this part's: VoiceSpeechServer (FnSpeech, /api/speech/*), ClientConfigFetching
//            (the voice changer's gate), the design's settings, the server / account / words.
// Seams:     engine.deviceId / roomId / usageStore (core), engine.nfcAsk (the NFC part),
//            ToolsCallLog.shared.messages (the rooms' histories in the vault).
//
// The core the parts use can be replaced (the real one at launch, PreviewCore in DEBUG previews):
// attach() is idempotent and runs again when a part is drawn, an action runs or the app is entered.

import Foundation
import M5Core
import M5Design
import Observation
import SwiftUI
import os

@MainActor
enum ToolParts {
    static let log = Logger(subsystem: "cz.m5cet.app", category: "tools")

    /// The commands engine (nil before install).
    private(set) static var engine: ToolsFnEngine?
    /// The AI chat's input and actions.
    static let ai = AiChatModel(assistant: { ToolParts.assistant }, bearer: { await ToolParts.bearer() })
    /// The voice pad's transcript.
    static let pad = VoicePadModel()
    /// The voice (Platform/Voice's service once it is wired; nothing until then).
    static var voice: any ToolsVoice = UnavailableToolsVoice() {
        didSet { followVoice(); attached = nil; attach() }
    }

    private static weak var attached: CoreModels?
    private static var fallbackAssistant: AiAssistant?

    static var assistant: AiAssistant {
        if let engine { return engine.assistant }
        if let a = fallbackAssistant { return a }
        let a = AiAssistant(api: FnApi(base: CoreModels.shared.server, transport: FnURLSessionTransport()))
        fallbackAssistant = a
        return a
    }

    static func bearer() async -> String {
        if let engine { return await engine.bearer() }
        return await CoreModels.shared.account.bearer()
    }

    // MARK: install

    static func install(into model: AppModel) {
        install(design: model.design)
        model.onScenePhase { phase in if phase == .active { attach() } }
        wireVoice(model)
    }

    /// The real voice (Platform/Voice): what of its integration is still unset — the speech module and the
    /// voice changer's gate over this part's HTTP, the design's settings, the server and account — then the pad,
    /// dictation and $voice follow it.
    static func wireVoice(_ model: AppModel) {
        let vs = VoiceService.shared
        let transport = engine?.transport ?? FnURLSessionTransport()
        if vs.server == nil {
            vs.server = ToolsSpeechServer(transport: transport, server: { CoreModels.shared.server }, bearer: { await ToolParts.bearer() })
        }
        if vs.configFetcher == nil { vs.configFetcher = ToolsClientConfigFetcher(transport: transport) }
        if vs.environment == nil { vs.environment = ToolsVoiceEnvironment(model.design) }
        if vs.settings is DefaultVoiceSettings { vs.setSettings(DesignVoiceSettings(model.design)) }
        vs.install(into: model)
        let bridge = VoiceServiceToolsVoice(vs)
        voice = bridge
        model.design.actions.onSettingChanged { key, _ in
            if key == "voice.lang" { bridge.refreshAvailability() }
            if key.hasPrefix("voiceFx.") { vs.recomputeFx() }
        }
    }

    /// The slots, the actions and the engine (the tests pass their own services and engine).
    static func install(design: DesignServices, engine e: ToolsFnEngine? = nil) {
        var made = e ?? ToolsFnEngine()
        #if DEBUG
        // The renderer's sample mode (-M5Screen): no network — the server's answers as the fixtures captured them.
        if e == nil && ToolsDebug.sample { made = ToolsFnEngine(transport: ToolsPreviewTransport()) }
        ToolsDebug.install(design.slots)
        #endif
        let engine = made
        self.engine = engine
        // A model's "nfc" question: the NFC part's sheet (Parts/NFC).
        if engine.nfcAsk == nil { engine.nfcAsk = { i, name, host, reply in FnNfcBridge.ask(i, modelName: name, host: host, reply: reply) } }
        attached = nil
        let slots = design.slots
        let actions = design.actions

        slots.register("aiChat") { ctx in
            attach()
            let host = ctx.host
            #if DEBUG
            ToolsDebug.aiDemo(ai)
            #endif
            return AnyView(AiChatView(host: host, model: ai, openLink: { [weak host] url in engine.openLink(url, host: host) }))
        }
        slots.register("voicePad") { ctx in
            attach()
            #if DEBUG
            ToolsDebug.voiceDemo(pad)
            #endif
            return AnyView(VoicePadSlot(host: ctx.host, model: pad))
        }

        actions.register(["ai.send", "ai.stop", "ai.clear"]) { a, ctx in
            attach()
            engine.host = ctx.host
            switch a.name {
            case "ai.send": ai.send()
            case "ai.stop": ai.stop()
            default: ai.clear()
            }
        }
        actions.register(["voice.dictate"]) { _, _ in
            // Android Parts.voicePadDictate: the pad on screen dictates (nothing without it).
            if pad.shown { pad.toggle(voice) }
        }
        actions.register(["voiceFx.test", "voiceFx.reset"]) { a, ctx in
            if a.name == "voiceFx.test" {
                voice.fxToggleTest()
            } else {
                // MicFx.resetCustom: the custom values back to their defaults, in the app's settings.
                var s = ctx.host.settings
                var changed: [String] = []
                for (k, v) in voice.fxResetCustom() where s.set(k, v) { changed.append(k) }
                ctx.host.settings = s
                for k in changed { ctx.host.settingChanged(k) }
            }
            ctx.host.refresh()
        }
        actions.register(ToolsCallLog.actions) { a, ctx in
            attach()
            ToolsCallLog.shared.host = ctx.host
            ToolsCallLog.shared.run(a.name, argument(a), host: ctx.host)
        }
        actions.onSettingChanged { key, _ in if key == "voice.lang" { VoicesCache.shared.reset() } }
        actions.onEnterApp { host in
            attach()
            engine.host = engine.host ?? host
            engine.load()
        }
        followVoice()
        attach()
    }

    /// The engine and the variables into the core the parts use now (idempotent).
    static func attach(_ core: CoreModels = CoreModels.shared) {
        guard let engine else { return }
        if attached === core, core.fn === engine { return }
        attached = core
        core.fn = engine
        core.variables.register("ai", "ai") { ai.scope }
        core.variables.register("log", "log") {
            // The History's own scope needs the window's $form (filter, search): the host that ran the engine last.
            guard let host = ToolsCallLog.shared.host ?? engine.host else { return ToolsCallLog.scope(all: [], filter: .all, query: "", loading: true, history: true, now: 0, timeZone: .current, lang: "en", t: { $0 }) }
            return ToolsCallLog.shared.scope(host: host)
        }
        core.variables.register("settings.voiceFx", "voiceFx") { voice.fxScope }
        for screen in ["voice", "settings.voice", "dictate.options"] {
            core.variables.register(screen, "voices") { VoicesCache.shared.value(voice) }
        }
        core.tools.voiceAvailable = true
        core.tools.aiAvailable = true
        core.tools.voice = voice.scope
    }

    /// $voice (core.tools.voice) follows the voice service.
    private static func followVoice() {
        let v = voice
        withObservationTracking {
            _ = v.scope
        } onChange: {
            Task { @MainActor in
                guard ToolParts.voice === v else { return }
                CoreModels.shared.tools.voice = v.scope
                followVoice()
            }
        }
    }

    /// The argument of a calllog.* action.
    static func argument(_ a: DesignAction) -> String {
        switch a {
        case .calllogOpen(let s), .calllogRefresh(let s), .calllogItem(let s), .calllogCall(let s), .calllogClear(let s), .calllogSystem(let s): return s
        default: return ""
        }
    }
}

/// The voice pad with the voice of now.
private struct VoicePadSlot: View {
    let host: DesignHost
    let model: VoicePadModel

    var body: some View { VoicePadView(host: host, model: model, voice: ToolParts.voice) }
}

/// The voices of the voice settings (Speech.voices, asked once and when the voice's language changes).
@MainActor
@Observable
final class VoicesCache {
    static let shared = VoicesCache()
    private var voices: [DesignValue]?
    @ObservationIgnored private var loading = false

    func value(_ voice: any ToolsVoice) -> DesignValue {
        if let voices { return .array(voices) }
        if !loading {
            loading = true
            Task { @MainActor in
                let v = await voice.voices()
                voices = v
                loading = false
            }
        }
        return .array([])
    }

    /// voice.lang changed: asked again.
    func reset() { voices = nil }
}
