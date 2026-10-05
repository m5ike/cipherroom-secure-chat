// A Functions model asks this phone for a card (6.6) — Android
// ui/parts/NfcModelSheet: the "nfc" run interaction as a sheet from the bottom —
// what is asked in plain words and by which model, "hold the card", a progress
// state while reading and the result line. The read is NfcService.modelRead (the
// system NFC sheet over this one). 6.10 (security analysis G-17): a result with
// card data (a card number, track data, a document's holder, MRZ or photo) goes
// only after the holder chose what — "Send (masked)" is the default, "Send
// everything" says what it adds, "Don't send" (or closing the sheet) answers
// "denied" (ModelNfc.consent / masked / declined).
//
// An e-ID read that came without the document key asks the holder for the CAN or
// the MRZ here first; it is used for this read only and never sent. (No camera
// MRZ scan: Android has none either.)
//
// Closing the sheet before an answer answers { status: "timeout", message:
// "Cancelled" }. Writes and emulation never get a sheet: they are refused.
//
// For the Functions UI (the "nfc" interaction of a run — Android Fn.java):
//
//   let sheet = NfcModelSheetPresenter.start(runId: run.id, spec: interaction.spec, modelName: run.name,
//                                            host: host) { answer in reply(answer) }   // nil = answered at once
//   sheet?.runEnded()                                   // the run ended / was cancelled while the sheet waits
//
// (`spec` and the answer as M5Core's JSONObject; an overload takes M5NFC's NfcJSONObject.)
//
// iOS: the app going to the background ends Core NFC's session; while the sheet
// still waits it asks for the card again on return (Android: reader mode given back
// on pause, taken again on resume).

import M5Core
import M5Design
import M5NFC
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class NfcModelSheetModel {
    enum State: Equatable { case key, wait, read, consent, done }

    let runId: String
    let modelName: String
    private(set) var command: ModelNfc.Command
    private(set) var state: State = .wait
    /// The document key's problem (nfc.model.key.*), shown under the fields.
    private(set) var keyError: String?
    /// Seconds left while waiting for the card.
    private(set) var secondsLeft = 0
    /// What the sheet shows when done (the answer that went).
    private(set) var shown: NfcJSONObject?
    /// What the holder is asked about (G-17).
    private(set) var consent: ModelNfc.Consent?
    /// Answered (or the run went away): nothing more is sent.
    private(set) var over = false

    @ObservationIgnored private var consenting: NfcJSONObject?
    @ObservationIgnored private let answer: @MainActor (NfcJSONObject) -> Void
    @ObservationIgnored let service: @MainActor () -> any NfcUiService
    @ObservationIgnored var words: NfcWords
    @ObservationIgnored private var readTask: Task<Void, Never>?
    @ObservationIgnored private var tickTask: Task<Void, Never>?
    @ObservationIgnored private var deadline = Date()
    @ObservationIgnored private var cancelledByUs = false
    /// The app went to the background while waiting (Core NFC ended the session): ask again on return.
    @ObservationIgnored private var backgrounded = false
    /// Close the sheet (the presenter dismisses it).
    @ObservationIgnored var dismiss: @MainActor () -> Void = {}
    @ObservationIgnored var autoCloseAfter: Duration = .milliseconds(2500)
    @ObservationIgnored var clock: () -> Date = Date.init

    init(runId: String, command: ModelNfc.Command, modelName: String?, service: @escaping @MainActor () -> any NfcUiService, words: NfcWords,
         answer: @escaping @MainActor (NfcJSONObject) -> Void) {
        self.runId = runId
        self.command = command
        self.modelName = (modelName ?? "").trimmingCharacters(in: .whitespaces)
        self.service = service
        self.words = words
        self.answer = answer
    }



    /// What is asked, in plain words (ModelNfc.whatKey).
    var title: String { words(ModelNfc.whatKey(command.op)) }
    var byLine: String? { modelName.isEmpty ? nil : words.f("nfc.model.by", modelName) }
    var icon: String {
        let op = command.op
        return op.hasPrefix("emv") ? "credit-card" : (op.hasPrefix("eid") || op == "mrtd-read") ? "contact-round" : "nfc"
    }

    /* ------------------------------------------------------------ the document key */

    func askKey() {
        state = .key
        keyError = nil
    }

    /// The holder's key: checked, then it lives only in this read's command; the fields forget it.
    func submitKey(_ k: ModelNfc.DocumentKey) {
        if let problem = ModelNfc.checkDocumentKey(k) { keyError = words(problem); return }
        keyError = nil
        command = ModelNfc.withDocumentKey(command, k)
        waitForCard()
    }

    /* ------------------------------------------------------------ the card */

    /// Waits for the card (the command's timeout, at most iOS's 60 s) and reads it.
    func waitForCard() {
        guard !over else { return }
        state = .wait
        let seconds = max(1, min(command.timeout, NfcService.sessionLimit))
        deadline = clock().addingTimeInterval(TimeInterval(seconds))
        secondsLeft = seconds
        tick()
        startRead()
    }

    private func startRead() {
        readTask?.cancel()
        cancelledByUs = false
        backgrounded = false
        let s = service()
        let cmd = command
        readTask = Task { [weak self] in
            let r = await s.modelRead(cmd, texts: NfcSheetTexts())
            self?.readEnded(r)
        }
    }

    private func tick() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while let self, !Task.isCancelled, !self.over, self.state == .wait {
                let left = self.deadline.timeIntervalSince(self.clock())
                self.secondsLeft = max(0, Int(left.rounded(.up)))
                if left <= 0 { break }
                try? await Task.sleep(for: .milliseconds(min(1000, max(50, Int(left * 1000)))))
            }
        }
    }

    /// The read came back: "Cancelled" by the sheet, the app's background (ask again), or the card's answer.
    private func readEnded(_ r: NfcJSONObject) {
        tickTask?.cancel()
        if over { return }
        let cancelled = r.optString("status") == "timeout" && r.optString("message") == "Cancelled"
        if cancelled && backgrounded && !cancelledByUs { return } // resumed() asks again
        if cancelled {
            answerOnce(r)
            close()
            return
        }
        done(r)
    }

    /// The sheet saw the card: reading (NfcService has no separate callback — the system sheet shows it).
    func reading() {
        guard !over, state == .wait else { return }
        state = .read
    }

    /// 6.10 (G-17): card data goes to the server and the model only with the holder's yes.
    func done(_ r: NfcJSONObject) {
        guard !over else { return }
        let c = ModelNfc.consent(r)
        if c.sensitive {
            consent = c
            consenting = r
            state = .consent
            return
        }
        answerOnce(r)
        showResult(r)
    }

    /// The consent text (who read what, and what goes).
    var consentText: String {
        guard let consent else { return "" }
        let w = words
        return ModelNfc.consentText(consent, model: modelName, { w($0) })
    }

    /// "Send everything" is offered only when it adds something.
    var offersFull: Bool { !(consent?.full.isEmpty ?? true) }

    func sendMasked() { if let r = consenting { consented(ModelNfc.masked(r) ?? ModelNfc.declined(r)) } }
    func sendFull() { if let r = consenting { consented(r) } }
    func dontSend() { if let r = consenting { consented(ModelNfc.declined(r)) } }

    private func consented(_ sent: NfcJSONObject) {
        guard !over else { return }
        consenting = nil
        answerOnce(sent)
        showResult(sent)
    }

    /// What closing the sheet answers: "Cancelled", or — while asking for consent — the holder's no.
    private var closingAnswer: NfcJSONObject { consenting.map(ModelNfc.declined) ?? ModelNfc.cancelled() }

    private func showResult(_ r: NfcJSONObject) {
        state = .done
        shown = r
        let status = r.optString("status")
        if status == "ok" || status == "denied" {
            Task { [weak self] in
                try? await Task.sleep(for: self?.autoCloseAfter ?? .seconds(2.5))
                self?.close()
            }
        }
    }

    /// The result line: ✓ and what was read, or ⚠ and why not.
    var resultHead: String {
        guard let r = shown else { return "" }
        switch r.optString("status") {
        case "ok": return "✓ " + words("nfc.model.done")
        case "timeout": return "⚠ " + words.f("nfc.model.timeout", String(min(command.timeout, NfcService.sessionLimit)))
        case "no-card": return "⚠ " + words("nfc.model.lost")
        case "auth-failed": return "⚠ " + words("nfc.model.authFailed")
        case "unsupported": return "⚠ " + words("nfc.model.notThisCard")
        case "denied": return words("nfc.consent.notSent")
        default: return "⚠ " + words("nfc.model.error")
        }
    }

    var resultDetail: String {
        guard let r = shown, r.optString("status") != "timeout", r.optString("status") != "denied" else { return "" }
        let m = r.optString("message")
        if !m.isEmpty { return m }
        if let c = r.optObject("card") { return (c.optString("label") + " · " + c.optString("uid")).trimmingCharacters(in: .whitespaces) }
        return ""
    }

    /* ------------------------------------------------------------ closing */

    private func answerOnce(_ r: NfcJSONObject) {
        guard !over else { return }
        over = true
        answer(r)
    }

    /// Close: cancel when nothing was answered yet; the read stops.
    func close() {
        answerOnce(closingAnswer)
        release()
        dismiss()
    }

    /// The sheet went away (swipe): the same as Close.
    func dismissed() {
        answerOnce(closingAnswer)
        release()
    }

    /// The run ended (or was cancelled) while the sheet still waited: nothing more to answer, the sheet goes.
    func runEnded() {
        guard !over else { return }
        over = true
        release()
        dismiss()
    }

    private func release() {
        tickTask?.cancel()
        if readTask != nil {
            cancelledByUs = true
            readTask?.cancel()
            readTask = nil
            let s = service()
            if s.busy { s.cancel() }
        }
    }

    /* ------------------------------------------------------------ the app's background */

    func wentToBackground() { if state == .wait && !over { backgrounded = true } }

    /// Back in front while the sheet still waits: the card is asked for again (until the deadline).
    func resumed() {
        guard backgrounded, !over, state == .wait else { return }
        backgrounded = false
        if clock() >= deadline {
            let r = ModelNfc.timedOut(max(1, min(command.timeout, NfcService.sessionLimit)))
            answerOnce(r)
            showResult(r)
            return
        }
        tick()
        startRead()
    }
}

/// Starts and shows the model's sheet (Android NfcModelSheet.start).
@MainActor
enum NfcModelSheetPresenter {
    /// Handles one "nfc" interaction: refused / answered at once (a write, an unknown op, enum, no reader, EMV on an
    /// iPhone) or a sheet that waits for the card. Returns the sheet, or nil when there is none to keep.
    @discardableResult
    static func start(runId: String, spec: NfcJSONObject?, modelName: String?, host: DesignHost?,
                      service: (any NfcUiService)? = nil, present: Bool = true,
                      answer: @escaping @MainActor (NfcJSONObject) -> Void) -> NfcModelSheetModel? {
        let s = service ?? NfcUiHooks.service()
        let words = host.map { NfcWords($0.translator) } ?? NfcWords.builtIn
        let preferred = host?.settings.str("nfc.reader") ?? ""
        let flash: (String, FlashLevel) -> Void = { t, l in host?.flash(title: "", text: t, level: l) }
        let cmd = ModelNfc.parse(spec)
        switch s.modelPlan(spec, preferredReader: preferred) {
        case .answer(let r):
            answer(r)
            if let refused = ModelNfc.refusal(cmd) {
                let denied = refused.optString("status") == "denied"
                flash(words(denied ? "nfc.model.denied" : "nfc.model.unsupported"), denied ? .warn : .info)
            } else if cmd.op != "enum" {
                // No reader here (iPad) — or this iPhone does not run it for a model (EMV: payment AIDs).
                flash(words(s.readingAvailable ? "nfc.model.unsupported" : "nfc.unavailable"), .warn)
            }
            return nil
        case .askDocumentKey(let c):
            let m = NfcModelSheetModel(runId: runId, command: c, modelName: modelName, service: { s }, words: words, answer: answer)
            m.askKey()
            if present { show(m, host: host) }
            return m
        case .read(let c):
            let m = NfcModelSheetModel(runId: runId, command: c, modelName: modelName, service: { s }, words: words, answer: answer)
            if present { show(m, host: host) }
            m.waitForCard()
            return m
        }
    }

    /// The same with M5Core's JSON (the Functions engine's).
    @discardableResult
    static func start(runId: String, spec: JSONObject?, modelName: String?, host: DesignHost?,
                      answer: @escaping @MainActor (JSONObject) -> Void) -> NfcModelSheetModel? {
        let nfcSpec = spec.map(NfcValues.nfc)
        return start(runId: runId, spec: nfcSpec, modelName: modelName, host: host) { r in
            answer(JSON.parseObject(r.compact) ?? JSONObject())
        }
    }

    static func show(_ m: NfcModelSheetModel, host: DesignHost?) {
        guard let host else { return }
        let palette = NfcPalette(host: host)
        let shown = NfcShownController()
        let watcher = NfcLifecycleWatcher(m)
        shown.vc = NfcPresenter.sheet(NfcModelSheetView(model: m, palette: palette).environment(\.colorScheme, host.isDark ? .dark : .light),
                                      dark: host.isDark, onDismiss: { [weak m] in m?.dismissed(); watcher.stop() })
        m.dismiss = { [weak shown] in shown?.vc?.dismiss(animated: true); watcher.stop() }
    }
}

/// The app's background and return while the sheet waits.
@MainActor
final class NfcLifecycleWatcher {
    private var tokens: [any NSObjectProtocol] = []

    init(_ m: NfcModelSheetModel) {
        let nc = NotificationCenter.default
        tokens.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak m] _ in
            MainActor.assumeIsolated { m?.wentToBackground() }
        })
        tokens.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak m] _ in
            MainActor.assumeIsolated { m?.resumed() }
        })
    }

    func stop() {
        for t in tokens { NotificationCenter.default.removeObserver(t) }
        tokens = []
    }
}

/// The sheet (Android NfcModelSheet's dialog): header (what, by whom, close), the body for the state, the read-only line.
struct NfcModelSheetView: View {
    @Bindable var model: NfcModelSheetModel
    let palette: NfcPalette
    @State private var key = ModelNfc.DocumentKey()

    var body: some View {
        let p = palette
        let w = model.words
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    DesignIcon(name: model.icon, size: 26, color: p.primary)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(p.primary.opacity(0.12)))
                    VStack(alignment: .leading, spacing: 2) {
                        NfcText(text: model.title, size: 18, color: p.fg, bold: true, family: p.family)
                        if let by = model.byLine { NfcText(text: by, size: 13, color: p.muted, family: p.family) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button { model.close() } label: { DesignIcon(name: "x", size: 22, color: p.fg).frame(width: 44, height: 44) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(verbatim: w("nav.close")))
                        .accessibilityIdentifier("nfc.model.close")
                }
                content(p, w)
                NfcText(text: w("nfc.readonly.help"), size: 12, color: p.muted, family: p.family).padding(.top, 14)
            }
            .padding(EdgeInsets(top: 16, leading: 20, bottom: 20, trailing: 20))
        }
        .background(p.surface.ignoresSafeArea())
        .accessibilityIdentifier("nfc.model")
    }

    @ViewBuilder
    private func content(_ p: NfcPalette, _ w: NfcWords) -> some View {
        switch model.state {
        case .key:
            VStack(alignment: .leading, spacing: 8) {
                NfcText(text: w("nfc.model.key.title"), size: 15, color: p.fg, bold: true, family: p.family).padding(.top, 8)
                NfcText(text: w("nfc.model.key.help"), size: 13, color: p.muted, family: p.family)
                // The CAN is printed on the card (not a PIN): shown while typed.
                NfcField(hint: w("nfc.model.key.can"), text: $key.can, keyboard: .numberPad, palette: p, id: "nfc.model.key.can")
                orLine(p, w)
                NfcField(hint: w("nfc.model.key.mrz"), text: $key.mrz, multiline: true, capitalize: true, palette: p, id: "nfc.model.key.mrz")
                orLine(p, w)
                NfcField(hint: w("nfc.eid.docNumber"), text: $key.documentNumber, capitalize: true, palette: p, id: "nfc.model.key.doc")
                NfcField(hint: w("nfc.eid.dob"), text: $key.dateOfBirth, keyboard: .numberPad, palette: p, id: "nfc.model.key.dob")
                NfcField(hint: w("nfc.eid.expiry"), text: $key.dateOfExpiry, keyboard: .numberPad, palette: p, id: "nfc.model.key.exp")
                if let e = model.keyError { NfcText(text: e, size: 13, color: p.danger, family: p.family).accessibilityIdentifier("nfc.model.key.error") }
                HStack(spacing: 10) {
                    Spacer()
                    NfcPillButton(label: w("nfc.model.cancel"), icon: "x", palette: p, id: "nfc.model.cancel") { model.close() }
                    NfcPillButton(label: w("nfc.eid.read"), icon: "scan-line", primary: true, palette: p, id: "nfc.model.key.read") {
                        let k = key
                        model.submitKey(k)
                        if model.keyError == nil {
                            key = ModelNfc.DocumentKey()
                            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                        }
                    }
                }
                .padding(.top, 16)
            }
        case .wait, .read:
            VStack(spacing: 8) {
                NfcSpinner(palette: p).padding(.top, 18).padding(.bottom, 6)
                NfcText(text: model.state == .read ? w("nfc.model.reading") : w("nfc.model.hold"), size: 16, color: p.fg, bold: true, family: p.family)
                    .multilineTextAlignment(.center)
                if model.state == .wait {
                    NfcText(text: w.f("nfc.model.waiting", String(model.secondsLeft)), size: 13, color: p.muted, family: p.family)
                        .accessibilityIdentifier("nfc.model.count")
                }
                HStack {
                    Spacer()
                    NfcPillButton(label: w("nfc.model.cancel"), icon: "x", palette: p, id: "nfc.model.cancel") { model.close() }
                }
                .padding(.top, 16)
            }
            .frame(maxWidth: .infinity)
        case .consent:
            VStack(alignment: .leading, spacing: 8) {
                NfcText(text: w("nfc.consent.title"), size: 16, color: p.fg, bold: true, family: p.family).padding(.top, 8)
                NfcText(text: model.consentText, size: 13, color: p.fg, family: p.family)
                    .accessibilityIdentifier("nfc.consent.text")
                VStack(spacing: 8) {
                    NfcPillButton(label: w("nfc.consent.sendMasked"), icon: "shield-check", primary: true, fill: true, palette: p, id: "nfc.consent.masked") { model.sendMasked() }
                    if model.offersFull {
                        NfcPillButton(label: w("nfc.consent.sendFull"), icon: "send", fill: true, palette: p, id: "nfc.consent.full") { model.sendFull() }
                    }
                    NfcPillButton(label: w("nfc.consent.dontSend"), icon: "x", fill: true, palette: p, id: "nfc.consent.no") { model.dontSend() }
                }
                .padding(.top, 12)
            }
        case .done:
            VStack(alignment: .leading, spacing: 8) {
                let status = model.shown?.optString("status") ?? ""
                NfcText(text: model.resultHead, size: 16, color: status == "ok" ? p.success : status == "denied" ? p.fg : p.danger, bold: true, family: p.family)
                    .padding(.top, 8)
                    .accessibilityIdentifier("nfc.model.result")
                if !model.resultDetail.isEmpty { NfcText(text: model.resultDetail, size: 13, color: p.muted, family: p.family) }
                HStack {
                    Spacer()
                    NfcPillButton(label: w("nav.close"), icon: "check", primary: status == "ok", palette: p, id: "nfc.model.done") { model.close() }
                }
                .padding(.top, 16)
            }
        }
    }

    private func orLine(_ p: NfcPalette, _ w: NfcWords) -> some View {
        NfcText(text: w("nfc.model.key.or"), size: 12, color: p.muted, bold: true, family: p.family).frame(maxWidth: .infinity).padding(.top, 2)
    }
}
