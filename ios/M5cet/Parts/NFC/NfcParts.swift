// The NFC UI of the app (6.14) — the port of android/…/ui/parts/{ToolPanels.NfcPanel,
// NfcWorkbench, NfcCardBuilder, NfcModelSheet, ConnTagUi} over Platform/NFC's
// NfcService. One line in App/Bootstrap.swift installs it:
//
//   slots    nfcPanel (NfcPanel), nfcWork (NfcWorkbenchView — the design's "nfc" screen),
//            nfcBuilder (NfcCardBuilderView — "nfc.builder")
//   actions  nfc.read, nfc.write, nfc.emulate, nfc.stop (Android Actions → Parts.nfc → NfcPanel.action);
//            nfc.workbench / nfc.builder are the renderer's (DesignHost.perform), nfc.reader the runner's
//   $nfc     of the "nfc" screen (Android Parts.nfcScope → Nfc.state)
//   texts    M5NFC's NfcTexts (the system NFC sheet, M5Card's errors, the readers' summaries) speak the
//            design's words in the app's language — installed now and again when the design or the language changes
//   model    NfcModelSheetPresenter.start(…) for the Functions UI (see NfcModelSheet.swift)
//
// File map (Android → Swift): ToolPanels.NfcPanel + nfc/Nfc → NfcPanel.swift; NfcWorkbench → NfcWorkbenchModel /
// NfcWorkbenchView / NfcResultViews / NfcRecordActions / NfcExport; NfcCardBuilder → NfcCardBuilder.swift;
// NfcModelSheet → NfcModelSheet.swift; ConnTagUi → NfcConnTagFlow.swift (+ NfcPresenter for its dialogs);
// ToolPanels.label / button, cardBox… → NfcUiKit.swift; the NfcService seam and the hooks other owners install →
// NfcUiService.swift. DEBUG screenshots: NfcDemo.swift (-M5NfcDemo …).
//
// Nothing of this was tried on a real card here — the simulator and the iPad have no NFC; the tests run the view
// models on a fake service and NfcService on the simulated chips of M5cetTests/NFC.

import M5Design
import M5NFC
import Observation
import Synchronization
import SwiftUI

@MainActor
enum NfcParts {
    /// The panel's state, one for the app (the design's actions reach it even when no panel shows).
    private(set) static var panel: NfcPanelModel?
    nonisolated private static let texts = NfcTextStore()

    static func install(into model: AppModel) {
        let services = model.design
        #if DEBUG
        NfcDemo.installIfAsked()
        #endif
        installTexts(services)

        let words = NfcWords(Translator(design: services.design, lang: services.lang))
        let panel = NfcPanelModel(service: { NfcUiHooks.service() }, words: words)
        panel.conn.presenter = { [weak panel] flow in
            NfcPresenter.connTag(flow, words: panel?.words ?? words, palette: { panel?.host.map { NfcPalette(host: $0) } })
        }
        Self.panel = panel

        services.slots.register("nfcPanel") { ctx in AnyView(NfcPanelSlot(ctx: ctx, model: panel)) }
        services.slots.register("nfcWork") { ctx in AnyView(NfcWorkbenchSlot(ctx: ctx)) }
        services.slots.register("nfcBuilder") { ctx in AnyView(NfcCardBuilderSlot(ctx: ctx)) }

        services.actions.register(["nfc.read", "nfc.write", "nfc.emulate", "nfc.stop"]) { action, ctx in
            ensureRegistered()
            panel.host = ctx.host
            panel.words = NfcWords(ctx.host.translator)
            let what = String(action.name.dropFirst(4))
            // The panel's field, else the design's $form.nfcPin (DesignAction's "nfc.read": "with $form.nfcPin").
            let typed = panel.pin.isEmpty ? (ctx.host.form["nfcPin"]?.stringValue ?? "") : panel.pin
            panel.action(what, secret: typed)
        }

        ensureRegistered()
    }

    /// $nfc and the tools' NFC flag on the core in use — again when the core was replaced after the install
    /// (the engine's core, a DEBUG preview): the NFC screens and actions call it.
    static func ensureRegistered() {
        guard let panel else { return }
        let core = CoreModels.shared
        if !core.variables.has("nfc", "nfc") { core.variables.register("nfc", "nfc") { panel.scope } }
        let available = NfcUiHooks.service().readingAvailable
        if core.tools.nfcAvailable != available { core.tools.nfcAvailable = available }
    }

    /// NfcTexts.install with the design's strings; again whenever the design or the language changes.
    static func installTexts(_ services: DesignServices) {
        withObservationTracking {
            texts.set(services.design, services.lang)
        } onChange: {
            Task { @MainActor in installTexts(services) }
        }
        NfcTexts.install({ texts.text($0) }, plural: { texts.plural($0, $1) })
    }
}

/// The design and the language M5NFC's texts read (any thread).
final class NfcTextStore: Sendable {
    private let state = Mutex<(design: Design?, lang: String)>((nil, "en"))

    func set(_ design: Design, _ lang: String) { state.withLock { $0 = (design, lang) } }

    func text(_ key: String) -> String? {
        let (d, l) = state.withLock { ($0.design, $0.lang) }
        return d?.text(key, lang: l)
    }

    func plural(_ key: String, _ n: Int) -> String? {
        let (d, l) = state.withLock { ($0.design, $0.lang) }
        guard let d, d.text(key, lang: l) != nil || d.text(key + "#other", lang: l) != nil else { return nil }
        return d.tn(key, Int64(n), lang: l)
    }
}

/* ------------------------------------------------------------ the slots: one model per window, the design's words */

struct NfcPanelSlot: View {
    let ctx: SlotContext
    let model: NfcPanelModel

    var body: some View {
        NfcPanelView(ctx: ctx, model: model)
            .onAppear {
                NfcParts.ensureRegistered()
                model.words = NfcWords(ctx.context.translator)
            }
            .onChange(of: ctx.context.translator.lang ?? "") { model.words = NfcWords(ctx.context.translator) }
    }
}

struct NfcWorkbenchSlot: View {
    let ctx: SlotContext
    @State private var model: NfcWorkbenchModel

    init(ctx: SlotContext) {
        self.ctx = ctx
        _model = State(initialValue: NfcWorkbenchModel(service: { NfcUiHooks.service() }, words: NfcWords(ctx.context.translator)))
    }

    var body: some View {
        NfcWorkbenchView(ctx: ctx, model: model)
            .onAppear {
                NfcParts.ensureRegistered()
                #if DEBUG
                NfcDemo.prepare(model)
                #endif
            }
            .onChange(of: ctx.context.translator.lang ?? "") { model.words = NfcWords(ctx.context.translator) }
    }
}

struct NfcCardBuilderSlot: View {
    let ctx: SlotContext
    @State private var model: NfcCardBuilderModel

    init(ctx: SlotContext) {
        self.ctx = ctx
        _model = State(initialValue: NfcCardBuilderModel(service: { NfcUiHooks.service() }, words: NfcWords(ctx.context.translator)))
    }

    var body: some View {
        NfcCardBuilderView(ctx: ctx, model: model)
            .onAppear {
                #if DEBUG
                NfcDemo.prepare(model)
                #endif
            }
            .onChange(of: ctx.context.translator.lang ?? "") { model.words = NfcWords(ctx.context.translator) }
    }
}
