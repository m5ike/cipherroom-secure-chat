// The NFC workbench (slot "nfcWork", the design's "nfc" screen) — Android
// ui/parts/NfcWorkbench's views: the reader, the status, Scan / Stop, the PIN,
// "Open M5Cet" / "Build a card", "Application template", the technology and its
// ops (each disabled op says why), and the result: the card, an op's output,
// EMV / e-ID, the M5Cet card's records, a connection tag, a template's run with
// its views, Share / Forward / Keep for myself and the report's export.
// On iPad and in the simulator: the design's "no NFC" with the reason.

import M5Core
import M5Design
import M5NFC
import M5Proto
import SwiftUI

struct NfcWorkbenchView: View {
    let ctx: SlotContext
    @Bindable var model: NfcWorkbenchModel
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let p = NfcPalette(ctx.context, reducedMotion: ctx.host.reducedMotion)
        let w = model.words
        ScrollViewReader { scroller in
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                NfcText(text: w("nfc.reader.title"), size: 12, color: p.muted, family: p.family)
                // The iPhone's own reader only (external USB / Bluetooth readers are not on iOS — Android hides Serial the same way).
                HStack(spacing: 8) {
                    NfcText(text: w("nfc.reader.internal"), size: 13, color: p.onPrimary, bold: true, family: p.family)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(p.primary))
                        .accessibilityAddTraits(.isSelected)
                }
                .padding(.top, 6)
                .padding(.bottom, 10)

                if model.available {
                    NfcText(text: model.status, size: 15, color: p.fg, bold: true, family: p.family)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .accessibilityIdentifier("nfc.status")
                }

                if let why = model.unavailableReason {
                    // The design's "no NFC" state, with the reason — no dead Scan.
                    NfcCardBox(palette: p) {
                        HStack(spacing: 10) {
                            DesignIcon(name: "nfc", size: 22, color: p.muted)
                            NfcText(text: w.or("nfc.unavailable.device", "nfc.unavailable"), size: 15, color: p.fg, bold: true, family: p.family)
                        }
                        // The service's generic reason is English and says the same as the design's line above.
                        if why != NfcService.noReader { NfcText(text: why, size: 13, color: p.muted, family: p.family) }
                    }
                    .accessibilityIdentifier("nfc.noReader")
                    .padding(.bottom, 4)
                } else {
                    HStack(spacing: 10) {
                        NfcPillButton(label: w("nfc.work.scan"), icon: "scan-line", primary: true, enabled: !model.working, palette: p, id: "nfc.scan") { model.scan() }
                        NfcPillButton(label: w("nfc.stop"), icon: "square", palette: p, id: "nfc.stop") { model.stop() }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 4)
                    .padding(.bottom, 8)
                    if model.working { NfcSpinner(palette: p).padding(.bottom, 6) }
                    // The PIN of an M5Cet card, or a connection tag's code (format 2) / PIN (format 1).
                    NfcField(hint: w("nfc.work.pin"), text: $model.pin, keyboard: .asciiCapable, secret: true, palette: p, id: "nfc.pin")
                        .padding(.top, 8)
                }

                // M5Cet: open records and build a card.
                HStack(spacing: 10) {
                    let m5 = model.reason("m5-read", tech: NfcCatalog.m5cetCard)
                    NfcPillButton(label: w("nfc.m5.open"), icon: "credit-card", enabled: m5 == nil, palette: p, id: "nfc.m5.open") { model.tap("m5-read") }
                    NfcPillButton(label: w("nfc.m5.build"), icon: "square-pen", palette: p, id: "nfc.m5.build") { ctx.host.showScreen("nfc.builder") }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 10)
                .padding(.bottom, 2)

                // 6.10: an application template — a complete read of a card type — whatever the card turns out to be.
                NfcPillButton(label: w("nfc.tpl.open"), icon: "square-arrow-down", palette: p, id: "nfc.tpl.open") { model.showTemplates() }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 6)

                techRow(p, w)
                opsGrid(p)
                results(p, w).padding(.top, 12).id("nfc.results")
            }
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 28, trailing: 16))
        }
        // A new result (not just the card) comes into view: on an iPhone it is below the ops.
        .onChange(of: model.shown) {
            switch model.content {
            case .none, .card: break
            default:
                if ctx.host.reducedMotion { scroller.scrollTo("nfc.results", anchor: .top) }
                else { withAnimation(.easeOut(duration: 0.3)) { scroller.scrollTo("nfc.results", anchor: .top) } }
            }
        }
        }
        .accessibilityIdentifier(ctx.id)
        .onAppear { attach() }
        .task { _ = await model.service().refreshEmulation() }
        .onDisappear { model.stop() }
        .sheet(item: sheetPrompt) { prompt in
            NfcPromptSheet(prompt: prompt, model: model, palette: p)
                .presentationDetents(prompt == .templates ? [.large] : [.medium, .large])
        }
        .alert(Text(verbatim: lockText("nfc.lock.title", lockOp?.label)), isPresented: lockShown) {
            Button(role: .destructive) { model.confirmLock() } label: { Text(verbatim: lockText("nfc.lock.confirm", lockOp?.label)) }
            Button(role: .cancel) { model.cancelPrompt() } label: { Text(verbatim: w("nav.close")) }
        } message: {
            Text(verbatim: lockText("nfc.lock.text", lockOp?.help))
        }
    }

    private func attach() {
        model.host = ctx.host
        model.flashed = { [weak host = ctx.host] t, l in host?.flash(title: "", text: t, level: l) }
        model.openScreen = { [weak host = ctx.host] id in host?.showScreen(id) }
        model.define = { [weak host = ctx.host] in host.flatMap { NfcValues.nfc($0.services.state.define)["apduTemplates"]?.arrayValue } }
        model.onRecord = { [weak host = ctx.host] outcome in NfcRecordActions.perform(outcome, words: model.words, host: host) }
        model.conn.presenter = { [weak host = ctx.host] flow in
            NfcPresenter.connTag(flow, words: model.words, palette: { host.map { NfcPalette(host: $0) } })
        }
    }

    /* ------------------------------------------------------------ the technology and its ops */

    private func techRow(_ p: NfcPalette, _ w: NfcWords) -> some View {
        Menu {
            ForEach(model.selectableTechs, id: \.self) { t in
                Button { model.tech = t } label: {
                    if t == model.tech { Label { Text(verbatim: NfcCatalog.techInfo(t).label) } icon: { Image(systemName: "checkmark") } }
                    else { Text(verbatim: NfcCatalog.techInfo(t).label) }
                }
            }
        } label: {
            HStack(spacing: 6) {
                NfcText(text: w("nfc.tpl.r.tech") + ": " + NfcCatalog.techInfo(model.tech).label, size: 13, color: p.primary, bold: true, family: p.family)
                DesignIcon(name: "chevron-down", size: 14, color: p.primary)
            }
            .padding(.vertical, 6)
        }
        .padding(.top, 12)
        .accessibilityIdentifier("nfc.tech")
    }

    private func opsGrid(_ p: NfcPalette) -> some View {
        let ops = model.opButtons()
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 6, alignment: .top), GridItem(.flexible(), spacing: 6, alignment: .top)], alignment: .leading, spacing: 6) {
            ForEach(ops) { b in
                VStack(alignment: .leading, spacing: 3) {
                    NfcPillButton(label: b.op.label, icon: Self.opIcon(b.op), enabled: b.enabled && !model.working, fill: true, palette: p, id: "nfc.op." + b.op.id) {
                        model.tap(b.op.id)
                    }
                    if let why = b.reason {
                        NfcText(text: why, size: 11, color: p.muted, family: p.family)
                            .padding(.horizontal, 6)
                            .accessibilityIdentifier("nfc.op." + b.op.id + ".why")
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    static func opIcon(_ op: NfcCatalog.Op) -> String {
        if op.id == "app-template" { return "square-arrow-down" }
        if op.kind == "write" { return "pencil" }
        if op.kind == "emulate" { return "smartphone" }
        return "eye"
    }

    /* ------------------------------------------------------------ the result */

    @ViewBuilder
    private func results(_ p: NfcPalette, _ w: NfcWords) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            switch model.content {
            case .none:
                EmptyView()
            case .card:
                if let c = model.card { NfcCardInfoView(card: c, palette: p) }
            case .op(let out):
                if let c = model.card { NfcCardInfoView(card: c, palette: p) }
                NfcOpResultView(output: out, palette: p)
            case .emv(let e):
                if let c = model.card { NfcCardInfoView(card: c, palette: p) }
                NfcEmvView(emv: e, words: w, palette: p)
                NfcReportExportView(files: model.reportFiles(), words: w, palette: p, saved: model.reportSaved)
            case .mrtd(let m):
                if let c = model.card { NfcCardInfoView(card: c, palette: p) }
                NfcMrtdView(mrtd: m, words: w, palette: p)
                NfcReportExportView(files: model.reportFiles(), words: w, palette: p, saved: model.reportSaved)
            case .records(let rs):
                NfcRecordsView(records: rs, words: w, palette: p, emulateReason: model.reason("m5-emulate", tech: NfcCatalog.m5cetCard),
                               open: { model.openRecord($0) }, emulate: { if let c = model.lastContainer { model.emulateM5(c) } })
            case .connection(let r, let body):
                NfcConnTagCard(read: r, words: w, palette: p,
                               open: { Task { await model.openConnection(body) } },
                               rewrite: { model.rewrite($0) },
                               join: { room, pass, name in NfcJoin.finish(room: room, passphrase: pass, name: name, host: ctx.host) })
            case .progress(let label):
                NfcCardBox(palette: p) {
                    NfcText(text: label, size: 16, color: p.fg, bold: true, family: p.family)
                    NfcText(text: model.progress, size: 13, color: p.muted, family: p.family).padding(.top, 4)
                        .accessibilityIdentifier("nfc.tpl.progress")
                    NfcPillButton(label: w("nfc.tpl.cancel"), icon: "x", palette: p, id: "nfc.tpl.cancel") { model.cancelTemplate() }
                        .padding(.top, 10)
                }
            case .run:
                if let r = model.lastRun { NfcRunView(run: r, model: model, ctx: ctx, palette: p) }
            }
        }
    }

    /* ------------------------------------------------------------ prompts */

    private var sheetPrompt: Binding<NfcWorkbenchPrompt?> {
        Binding(get: { model.prompt == .lock ? nil : model.prompt },
                set: { if $0 == nil, model.prompt != nil, model.prompt != .lock { model.cancelPrompt() } })
    }

    private var lockShown: Binding<Bool> {
        Binding(get: { model.prompt == .lock }, set: { if !$0, model.prompt == .lock { model.cancelPrompt() } })
    }

    private var lockOp: NfcCatalog.Op? { NfcCatalog.findOp(NfcCatalog.ndef, "ndef-lock") }

    /// The permanent lock's question in the design's words (the iOS design's nfc.lock.*), else the catalog's English.
    private func lockText(_ key: String, _ catalog: String?) -> String { model.words.has(key) ? model.words(key) : catalog ?? "" }
}

/// A template run's output (Android showRun / drawView): the template and how it went, Share · Forward · Keep for
/// myself, the views (in / out · raw · JSON · readable), the full card numbers' switch, the view, the report.
struct NfcRunView: View {
    let run: TemplateRunResult
    @Bindable var model: NfcWorkbenchModel
    let ctx: SlotContext
    let palette: NfcPalette

    var body: some View {
        let p = palette
        let w = model.words
        let statusColor = run.status == "error" ? p.danger : run.status == "warn" ? p.warning : p.success
        NfcCardBox(palette: p) {
            HStack(alignment: .center, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    NfcText(text: run.label, size: 16, color: p.fg, bold: true, family: p.family)
                    NfcText(text: model.runSummary(run), size: 12, color: statusColor, family: p.family)
                        .accessibilityIdentifier("nfc.run.summary")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                share(p, w)
                if NfcUiHooks.forward != nil {
                    NfcRoundIcon(icon: "forward", label: w("nfc.out.forward"), palette: p, id: "nfc.out.forward") { forward() }
                        .padding(.leading, 6)
                }
                NfcRoundIcon(icon: "lock", label: w("nfc.out.toMyself"), palette: p, id: "nfc.out.toMyself") { model.keepForMyself() }
                    .padding(.leading, 6)
            }
            NfcSegments(items: [(TemplateViews.io, w("nfc.out.io")), (TemplateViews.raw, w("nfc.out.raw")), (TemplateViews.json, w("nfc.out.json")),
                                (TemplateViews.readable, w("nfc.out.readable"))],
                        selected: model.outView, palette: p) { model.outView = $0 }
                .padding(.top, 12)
            if TemplateViews.masks(run) {
                Toggle(isOn: $model.fullPan) { NfcText(text: w("nfc.out.fullPan"), size: 14, color: p.fg, family: p.family) }
                    .tint(p.primary)
                    .padding(.top, 8)
                    .accessibilityIdentifier("nfc.out.fullPan")
                if !model.fullPan { NfcText(text: w("nfc.out.masked"), size: 12, color: p.muted, family: p.family) }
            }
        }
        if model.outView != TemplateViews.readable {
            if run.exchanges.isEmpty {
                NfcCardBox(palette: p) { NfcText(text: w("nfc.out.empty"), size: 13, color: p.muted, family: p.family) }
            } else {
                NfcTextBox(text: model.outputText(), words: w, palette: p)
            }
        } else {
            if let emv = model.runEmv {
                ForEach(Array(emv.objects("apps").enumerated()), id: \.offset) { _, a in NfcEmvAppView(app: a, words: w, palette: p) }
            }
            if let m = run.mrtd { NfcMrtdView(mrtd: m, words: w, palette: p) }
            NfcTextBox(text: model.readableText(), words: w, palette: p)
        }
        NfcReportExportView(files: model.reportFiles(), words: w, palette: p, saved: model.reportSaved)
    }

    @ViewBuilder
    private func share(_ p: NfcPalette, _ w: NfcWords) -> some View {
        let icon = DesignIcon(name: "share-2", size: 22, color: p.primary).frame(width: 42, height: 42).background(Circle().fill(p.primary.opacity(0.12)))
        switch model.shareItem() {
        case .text(let text, let subject):
            ShareLink(item: text, subject: Text(verbatim: subject)) { icon }
                .accessibilityLabel(Text(verbatim: w("nfc.out.share"))).accessibilityIdentifier("nfc.out.share")
        case .file(let f, let subject):
            ShareLink(item: f, subject: Text(verbatim: subject), preview: SharePreview(Text(verbatim: f.name))) { icon }
                .accessibilityLabel(Text(verbatim: w("nfc.out.share"))).accessibilityIdentifier("nfc.out.share")
        case nil:
            EmptyView()
        }
    }

    private func forward() {
        do {
            if let m = try model.forwardMessage() { NfcUiHooks.forward?(m, ctx.host) }
        } catch {
            ctx.host.flash(title: "", text: NfcConnTagFlow.message(error), level: .error)
        }
    }
}

/// The prompts before the card (Android askText / askHex / askBlockHex / askMrtd, the templates' picker).
struct NfcPromptSheet: View {
    let prompt: NfcWorkbenchPrompt
    @Bindable var model: NfcWorkbenchModel
    let palette: NfcPalette
    @State private var text = ""
    @State private var block = ""
    @State private var form = NfcMrtdForm()

    var body: some View {
        let p = palette
        let w = model.words
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                switch prompt {
                case .text(let op):
                    title(w("nfc.ndef.prompt"))
                    NfcField(hint: w("nfc.ndef.prompt"), text: $text, multiline: true, palette: p, id: "nfc.prompt.text")
                    buttons(ok: { model.submitText(op, text) })
                case .hex(let op):
                    title(w("nfc.apdu.prompt"))
                    NfcField(hint: "00A4040007A0000002471001", text: $text, keyboard: .asciiCapable, capitalize: true, palette: p, id: "nfc.prompt.hex")
                    buttons(ok: { model.submitHex(op, text) })
                case .block(let op, let len):
                    title(w("nfc.write.title"))
                    NfcField(hint: w("nfc.block.no"), text: $block, keyboard: .numberPad, palette: p, id: "nfc.prompt.block")
                    NfcField(hint: w("nfc.block.data") + " (\(len) hex)", text: $text, keyboard: .asciiCapable, capitalize: true, palette: p, id: "nfc.prompt.data")
                    buttons(ok: { model.submitBlock(op, block: block, data: text, hexLength: len) })
                case .mrtd(let photo, let all, _):
                    title(w("nfc.eid.title"))
                    NfcField(hint: w("nfc.eid.docNumber"), text: $form.documentNumber, capitalize: true, palette: p, id: "nfc.eid.doc")
                    NfcField(hint: w("nfc.eid.dob"), text: $form.dateOfBirth, keyboard: .numberPad, palette: p, id: "nfc.eid.dob")
                    NfcField(hint: w("nfc.eid.expiry"), text: $form.dateOfExpiry, keyboard: .numberPad, palette: p, id: "nfc.eid.exp")
                    NfcField(hint: w("nfc.eid.mrz"), text: $form.mrz, multiline: true, capitalize: true, palette: p, id: "nfc.eid.mrz")
                    NfcField(hint: w("nfc.eid.can"), text: $form.can, keyboard: .numberPad, palette: p, id: "nfc.eid.can")
                    Toggle(isOn: $form.photo) { NfcText(text: w("nfc.eid.photo"), size: 14, color: p.fg, family: p.family) }.tint(p.primary)
                    Toggle(isOn: $form.all) { NfcText(text: w("nfc.eid.all"), size: 14, color: p.fg, family: p.family) }.tint(p.primary)
                        .onAppear { form.photo = photo; form.all = all }
                    buttons(ok: { model.submitMrtd(form) }, okLabel: w("nfc.eid.read"))
                case .templates:
                    title(w("nfc.tpl.title"))
                    ForEach(Array(model.templateGroups.enumerated()), id: \.offset) { _, g in
                        NfcSectionTitle(text: g.title, palette: p)
                        ForEach(g.items, id: \.index) { t in templateRow(t, p) }
                    }
                    NfcPillButton(label: w("nav.close"), icon: "x", palette: p, id: "nfc.tpl.close") { model.cancelPrompt() }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.top, 8)
                case .lock:
                    EmptyView()
                }
            }
            .padding(20)
        }
        .background(p.surface.ignoresSafeArea())
    }

    private func title(_ s: String) -> some View {
        NfcText(text: s, size: 18, color: palette.fg, bold: true, family: palette.family).padding(.bottom, 4)
    }

    private func buttons(ok: @escaping @MainActor () -> Void, okLabel: String? = nil) -> some View {
        HStack(spacing: 10) {
            Spacer()
            NfcPillButton(label: model.words("nav.close"), icon: "x", palette: palette, id: "nfc.prompt.close") { model.cancelPrompt() }
            NfcPillButton(label: okLabel ?? model.words.or("nfc.ok", "nfc.model.done"), icon: "check", primary: true, palette: palette, id: "nfc.prompt.ok", action: ok)
        }
        .padding(.top, 8)
    }

    /// One template in the picker: its label, its note, how many steps (or that it is older), and why it cannot run.
    private func templateRow(_ t: ApduTemplates.Template, _ p: NfcPalette) -> some View {
        let problem = model.templateProblem(t)
        return Button { model.pickTemplate(t) } label: {
            VStack(alignment: .leading, spacing: 2) {
                NfcText(text: t.label, size: 15, color: p.fg, bold: true, family: p.family)
                if !t.note.isEmpty { NfcText(text: t.note, size: 12, color: p.muted, family: p.family) }
                NfcText(text: model.templateMeta(t), size: 11, color: p.muted, family: p.family)
                if let problem { NfcText(text: problem, size: 12, color: p.danger, family: p.family) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(problem != nil)
        .opacity(problem == nil ? 1 : 0.6)
        .accessibilityIdentifier("nfc.tpl.\(t.index)")
    }
}
