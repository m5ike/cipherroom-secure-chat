// The NFC workbench's state and logic (slot "nfcWork") — Android
// ui/parts/NfcWorkbench (6.3 / 6.5 / 6.6 / 6.10 / 6.12), without its views.
//
// Android ARMS an op and runs it on the next tap; on iOS one call is one system
// sheet (NfcService): tapping an op asks what it needs first (text, APDU, block,
// the document's key, the lock's yes, a connection tag's kind), then the sheet
// asks for the card and the op runs on it.
//
// What this device cannot do is not a dead button: every op of the catalogue is
// listed for the technology (detected, or chosen from TagTech.selectable — the
// iPhone never sees a MIFARE Classic card), those it cannot run are disabled with
// NfcService's reason (no reader on iPad, MIFARE Classic, raw frames, payment AIDs,
// emulation without HCE) or, for an op no reader of the app runs, "nfc.op.unsupported".
// iOS addition (kept on purpose): making a tag read-only asks a destructive yes first.

import Foundation
import M5Core
import M5Design
import M5NFC
import M5Proto
import Observation

/// An op of the catalogue for the technology on screen, and why it is disabled (nil = it runs).
struct NfcOpButton: Identifiable, Equatable {
    let op: NfcCatalog.Op
    let reason: String?
    var id: String { op.id }
    var enabled: Bool { reason == nil }
}

/// What an op asks before the card (Android: the dialogs askText / askHex / askBlockHex / askMrtd, the picker).
enum NfcWorkbenchPrompt: Identifiable, Equatable {
    /// ndef-write: the text of a record.
    case text(op: String)
    /// raw-apdu / select-aid: an APDU in hex.
    case hex(op: String)
    /// ul-write / ntag-write / v-write: a block number and its data (hexLength hex digits).
    case block(op: String, hexLength: Int)
    /// eid-read (or an e-ID template): the document's key; `photo` / `all` preset by a template's args.
    case mrtd(photo: Bool, all: Bool, template: Bool)
    /// ndef-lock: permanent — the explicit yes (iOS).
    case lock
    /// The application templates (m5mobile.define › apduTemplates).
    case templates

    var id: String {
        switch self {
        case .text(let op): return "text:" + op
        case .hex(let op): return "hex:" + op
        case .block(let op, _): return "block:" + op
        case .mrtd: return "mrtd"
        case .lock: return "lock"
        case .templates: return "templates"
        }
    }
}

/// The document key form (Android askMrtd): BAC fields, or a pasted MRZ, and / or the CAN.
struct NfcMrtdForm: Equatable {
    var documentNumber = "", dateOfBirth = "", dateOfExpiry = "", mrz = "", can = ""
    var photo = true, all = true
}

/// What an opened record of an M5Cet card does (Android actOnRecord / saveRecord).
enum NfcRecordOutcome: Equatable {
    case join(room: String, passphrase: String, name: String)
    case url(String)
    case wifi(ssid: String, password: String)
    case contact(name: String, tel: String, email: String, org: String)
    case urlLogin(url: String, user: String, password: String)
    /// passkey / identity / external key: the app's vault takes it (not on iOS yet — the hand-off text).
    case handoff(title: String)
    case text(title: String, body: String)
}

@MainActor
@Observable
final class NfcWorkbenchModel {
    /// What the result area shows.
    enum Content: Equatable {
        case none
        /// The detected card and its ops.
        case card
        /// An op's output (done / note / apdu / the rest).
        case op(NfcJSONObject)
        case emv(NfcJSONObject)
        case mrtd(NfcJSONObject)
        /// The M5Cet card's records (the container is `lastContainer`).
        case records([M5Card.Sealed])
        /// A connection tag (its body kept to open it again).
        case connection(NfcConnReading, body: String)
        /// A template runs (its label).
        case progress(String)
        /// The last template run (`lastRun`).
        case run
    }

    // Screen limits (Android NfcWorkbench).
    static let screenMax = 80_000, messageMax = 60_000, shareTextMax = 100_000, noteInlineMax = 560 * 1024, inlineMax = 96 * 1024

    /// The ops Android's runOp (and NfcService.perform) run; the others say "nfc.op.unsupported".
    static let handled: Set<String> = [
        "read-public", "raw-apdu", "ndef-read", "ndef-write", "ndef-lock", "m5-read", "m5-write", "m5-emulate", "conn-read", "conn-write",
        "conn-emulate", "ul-read", "ul-write", "ntag-read", "ntag-write", "desfire-apps", "select-aid", "app-template", "v-read", "v-write",
        "felica-systems", "emv-public", "emv-read", "eid-public", "eid-read", "mrtd-read",
    ]

    private(set) var status: String
    /// The technology whose ops are listed (detected by a scan, or chosen).
    var tech = NfcCatalog.unknown
    /// The card the last reading saw.
    private(set) var card: CardIdentity?
    private(set) var content: Content = .none { didSet { reportCache = nil; shown &+= 1 } }
    /// Counts what the result area was given (the view scrolls to a new result).
    private(set) var shown = 0
    @ObservationIgnored private var reportCache: [NfcExportFile]?
    /// The PIN of an M5Cet card, or a connection tag's code / PIN.
    var pin = ""
    var prompt: NfcWorkbenchPrompt?
    /// A reading / op / template is in progress.
    private(set) var working = false
    private(set) var emulating = false
    /// The template step line ("Step 2 / 7 · …").
    private(set) var progress = ""
    private(set) var lastRun: TemplateRunResult?
    var outView = TemplateViews.readable
    /// G-19: the card number and track data as read — only when the user turns it on (off again for each run).
    var fullPan = false { didSet { reportCache = nil } }
    /// The last M5Cet container opened (to be the card, to erase a one-time record).
    private(set) var lastContainer: [UInt8]?
    /// The application templates (parsed when the picker opens).
    private(set) var templates: [ApduTemplates.Template] = []
    /// The template that waits for the document's key.
    @ObservationIgnored private(set) var pendingTemplate: ApduTemplates.Template?

    let conn: NfcConnTagFlow
    @ObservationIgnored let service: @MainActor () -> any NfcUiService
    @ObservationIgnored var words: NfcWords
    @ObservationIgnored weak var host: DesignHost?
    /// m5mobile.define › apduTemplates ($define).
    @ObservationIgnored var define: @MainActor () -> [NfcJSON]? = { nil }
    @ObservationIgnored var trustedOrigin: @MainActor () -> String = { CoreModels.shared.server }
    @ObservationIgnored var activeCard: @MainActor () -> NfcJSONObject? = {
        let rooms = CoreModels.shared.rooms
        return rooms.activeKey.isEmpty ? nil : rooms.card(rooms.activeKey).map(NfcValues.nfc)
    }
    @ObservationIgnored var rooms: @MainActor () -> any RoomsModel = { CoreModels.shared.rooms }
    @ObservationIgnored var files: @MainActor () -> (any MessageFiles)? = { CoreModels.shared.files }
    /// Flash and navigation (the window's host; the tests record them).
    @ObservationIgnored var flashed: @MainActor (String, FlashLevel) -> Void = { _, _ in }
    @ObservationIgnored var openScreen: @MainActor (String) -> Void = { _ in }
    /// An opened record's outcome (the view performs it: join, open, show…).
    @ObservationIgnored var onRecord: @MainActor (NfcRecordOutcome) -> Void = { _ in }
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored var clock: () -> Date = Date.init

    init(service: @escaping @MainActor () -> any NfcUiService, words: NfcWords, conn: NfcConnTagFlow? = nil) {
        self.service = service
        self.words = words
        self.conn = conn ?? NfcConnTagFlow(service: service)
        status = service().readingAvailable ? words("nfc.work.tapScan") : words("nfc.unavailable")
    }

    var available: Bool { service().readingAvailable }
    /// Why nothing can be read here (iPad, simulator).
    var unavailableReason: String? { service().unavailableReason }

    private func flash(_ text: String, _ level: FlashLevel) { flashed(text, level) }

    /* ------------------------------------------------------------ the ops */

    /// The ops for the technology (scan / read-uid are the top button), each with why it cannot run here.
    func opButtons() -> [NfcOpButton] {
        NfcCatalog.ops(for: tech).filter { $0.id != "scan" && $0.id != "read-uid" }.map { NfcOpButton(op: $0, reason: reason($0.id, tech: tech)) }
    }

    /// Why an op is disabled: the device (no reader, the iPhone's limits), else an op no reader of the app runs.
    func reason(_ op: String, tech: String) -> String? {
        let s = service()
        if let r = s.reason(op: op, tech: tech) { return r }
        // Core NFC never hands a MIFARE Classic tag to the app — not even its NDEF: every op of the tag says why.
        if tech.hasPrefix("mifare-classic"), !s.capabilities.contains(.mifareClassic), let r = s.limit(op: "classic-read", tech: tech) { return r }
        return Self.handled.contains(op) ? nil : words("nfc.op.unsupported")
    }

    /// The technologies to choose from (the iPhone never sees some of them: their ops say why).
    var selectableTechs: [String] { TagTech.selectable }

    /// Clicking an op: writes / APDU / the document's key gather input first, then the sheet (Android onOpClicked).
    func tap(_ op: String) {
        if let why = reason(op, tech: tech) { flash(why, .info); return }
        switch op {
        case "app-template": showTemplates()
        case "m5-emulate":
            if let c = lastContainer { emulateM5(c) } else { flash(words("nfc.m5.buildFirst"), .info); openScreen("nfc.builder") }
        case "conn-emulate": emulateConnection()
        case "m5-write": openScreen("nfc.builder")
        case "eid-read", "mrtd-read": pendingTemplate = nil; prompt = .mrtd(photo: true, all: true, template: false)
        case "raw-apdu", "select-aid": prompt = .hex(op: op)
        case "ndef-write": prompt = .text(op: op)
        case "ul-write", "ntag-write", "v-write": prompt = .block(op: op, hexLength: 8)
        case "conn-write": prepareConnection()
        case "ndef-lock": prompt = .lock
        default: run(op, .none)
        }
    }

    func submitText(_ op: String, _ text: String) {
        prompt = nil
        run(op, .text(text))
    }

    func submitHex(_ op: String, _ input: String) {
        prompt = nil
        guard let bytes = Self.hex(input) else { flash(words("nfc.hex.bad"), .warn); return }
        run(op, .apdu(bytes))
    }

    func submitBlock(_ op: String, block: String, data: String, hexLength: Int) {
        prompt = nil
        guard let b = Int(block.trimmingCharacters(in: .whitespaces)) else { flash(words("nfc.block.no"), .warn); return }
        let h = data.filter(\.isHexDigit)
        guard h.count == hexLength, let bytes = Self.hex(h) else { flash(words("nfc.hex.bad"), .warn); return }
        run(op, .block(b, bytes))
    }

    /// The person said yes to the permanent lock.
    func confirmLock() {
        prompt = nil
        run("ndef-lock", .confirmLock(true))
    }

    /// The document's key, then the read (or the e-ID template that asked for it).
    func submitMrtd(_ form: NfcMrtdForm) {
        prompt = nil
        guard let o = Self.mrtdOptions(form) else { flash(words("nfc.eid.needKey"), .warn); return }
        if let t = pendingTemplate {
            pendingTemplate = nil
            startTemplate(t, o)
        } else {
            run("eid-read", .mrtd(o))
        }
    }

    func cancelPrompt() {
        prompt = nil
        pendingTemplate = nil
    }

    /// Android askMrtd: the CAN alone opens a PACE document; a pasted MRZ; otherwise the three BAC fields. nil = not enough.
    nonisolated static func mrtdOptions(_ f: NfcMrtdForm) -> MrtdReader.Options? {
        var o = MrtdReader.Options()
        let mrz = f.mrz.trimmingCharacters(in: .whitespacesAndNewlines)
        let can = f.can.trimmingCharacters(in: .whitespaces)
        if !can.isEmpty { o.can = can }
        if !mrz.isEmpty {
            o.mrz = mrz
        } else {
            let dn = f.documentNumber.trimmingCharacters(in: .whitespaces), db = f.dateOfBirth.trimmingCharacters(in: .whitespaces)
            let ex = f.dateOfExpiry.trimmingCharacters(in: .whitespaces)
            let anyKey = !dn.isEmpty || !db.isEmpty || !ex.isEmpty
            if (anyKey || can.isEmpty) && (dn.isEmpty || db.isEmpty || ex.isEmpty) { return nil }
            if anyKey { o.key = MrzKey(dn, db, ex) }
        }
        o.readPhoto = f.photo
        o.all = f.all
        return o
    }

    /// Hex digits (anything else dropped), an even, non-empty count — nil otherwise.
    nonisolated static func hex(_ s: String) -> [UInt8]? {
        let h = s.filter(\.isHexDigit)
        guard !h.isEmpty, h.count % 2 == 0 else { return nil }
        return Hex.decodeLenient(h)
    }

    /* ------------------------------------------------------------ the sheet */

    /// Scan: the card's identity and public record (Android startScan + onTag with no armed op). A connection tag
    /// whose code was typed already opens its join card at once.
    func scan() {
        guard available else { flash(words("nfc.unavailable"), .warn); return }
        let s = service()
        s.stopEmulation()
        emulating = false
        status = words("nfc.hold")
        let secret = pinText
        start { [weak self] in
            let tag = try await s.readTag(texts: NfcSheetTexts(), timeout: nil)
            guard let self else { return }
            self.detected(tag.identity)
            if let body = tag.connectionBody {
                // An invitation is redeemed only when asked (Open): every redemption uses one of its uses.
                let r = await s.openConn(body, secret: secret, trustedOrigin: self.trustedOrigin(), redeem: false)
                if r.room != nil { self.content = .connection(r, body: body); return }
            }
            self.content = .card
        }
    }

    /// Stop: the sheet, a template, the emulation.
    func stop() {
        task?.cancel()
        task = nil
        let s = service()
        if s.busy { s.cancel() }
        s.stopEmulation()
        emulating = false
        working = false
        status = available ? words("nfc.work.tapScan") : words("nfc.unavailable")
    }

    /// Runs an op on the next card (Android arm + runOp) and shows its result.
    func run(_ op: String, _ input: NfcOpInput) {
        guard available else { flash(words("nfc.unavailable"), .warn); return }
        let s = service()
        s.stopEmulation()
        emulating = false
        status = words("nfc.work.holdCard")
        let tech = self.tech
        start { [weak self] in
            let r = try await s.perform(op, tech: tech, input: input, texts: NfcSheetTexts())
            await self?.ran(op, r)
        }
    }

    private func start(_ body: @escaping @MainActor () async throws -> Void) {
        task?.cancel()
        working = true
        task = Task { [weak self] in
            do { try await body() } catch { self?.failed(error) }
            self?.working = false
        }
    }

    private func detected(_ id: CardIdentity) {
        card = id
        if id.tech != NfcCatalog.unknown || tech == NfcCatalog.unknown { tech = id.tech }
        status = id.label.isEmpty ? NfcCatalog.techInfo(tech).label : id.label
    }

    /// What an op returned, on the screen (Android runOp's cases).
    private func ran(_ op: String, _ r: NfcOpResult) async {
        if !r.card.uid.isEmpty || r.card.tech != NfcCatalog.unknown { detected(r.card) }
        switch op {
        case "eid-read", "mrtd-read":
            let m = r.output.optObject("mrtd") ?? r.output
            content = .mrtd(m)
            status = MrtdReader.summary(m)
        case "emv-read":
            let e = r.output.optObject("emv") ?? r.output
            content = .emv(e)
            status = EmvReader.summary(e)
        case "m5-read":
            openM5Records(r.output.string("m5").map { Hex.decodeLenient($0) })
        case "conn-read":
            guard let body = r.output.string("connBody") else { status = words("nfc.conn.none"); content = .card; return }
            await openConnection(body)
        case "ndef-lock":
            content = .op(["done": .string(words("nfc.done.locked"))])
        case "scan", "read-uid":
            content = .card
        default:
            content = .op(r.output)
        }
    }

    private var pinText: String { pin.trimmingCharacters(in: .whitespaces) }

    /// A failure's words on the status line; closing the sheet is no failure.
    private func failed(_ error: any Error) {
        if let e = error as? NfcError, e.code == .cancelled {
            status = available ? words("nfc.work.tapScan") : words("nfc.unavailable")
            return
        }
        if error is CancellationError { return }
        if let w = error as? NfcWriteFailure { status = w.text(NfcSheetTexts()); return }
        status = "⚠ " + NfcConnTagFlow.message(error)
    }

    /* ------------------------------------------------------------ connection tags */

    /// Opens a connection tag's body with the code / PIN typed now (an invitation is redeemed now: Open).
    func openConnection(_ body: String) async {
        let r = await service().openConn(body, secret: pinText, trustedOrigin: trustedOrigin(), redeem: true)
        content = .connection(r, body: body)
    }

    /// "Write connection": an invitation or an offline tag for the active room, prepared, then the sheet.
    func prepareConnection() {
        guard let card = activeCard() else { flash(words("rooms.empty"), .warn); return }
        rewrite(card)
    }

    /// A format-2 tag for this room card (the old tag's room, rewritten, too).
    func rewrite(_ card: NfcJSONObject) {
        conn.flash = { [weak self] t, l in self?.flash(t, l) }
        conn.prepare(card) { [weak self] body in self?.run("conn-write", .records([ConnectionCard.record(body)])) }
    }

    /* ------------------------------------------------------------ emulation */

    /// The phone answers as the M5Cet card (HCE).
    func emulateM5(_ container: [UInt8]) {
        emulate { s in try await s.emulateM5Card(container, texts: NfcSheetTexts()) }
    }

    /// 6.12 (§ 16): the phone answers as a format-2 connection tag (prepared first).
    func emulateConnection() {
        guard let card = activeCard() else { flash(words("rooms.empty"), .warn); return }
        conn.flash = { [weak self] t, l in self?.flash(t, l) }
        conn.prepare(card) { [weak self] body in
            self?.emulate { s in try await s.emulateConnection(body, texts: NfcSheetTexts()) }
        }
    }

    private func emulate(_ work: @escaping @MainActor (any NfcUiService) async throws -> HceEnd) {
        task?.cancel()
        let s = service()
        emulating = true
        status = words("nfc.emulating")
        task = Task { [weak self] in
            do {
                let end = try await work(s)
                self?.emulating = false
                if let self { self.status = end == .served ? "✓ " + self.words("nfc.model.done") : self.words("nfc.work.tapScan") }
            } catch {
                self?.emulating = false
                self?.failed(error)
            }
        }
    }

    /* ------------------------------------------------------------ the M5Cet card */

    func openM5Records(_ container: [UInt8]?) {
        guard let container, M5Card.isM5Card(container) else { status = words("nfc.m5.none"); content = .card; return }
        do {
            let records = try M5Card.decodeContainer(container)
            lastContainer = container
            content = .records(records)
        } catch {
            status = "⚠ " + NfcConnTagFlow.message(error)
        }
    }

    /// Opens one record with its key (PBKDF2 — off the main thread) and does what it says.
    func openRecord(_ sealed: M5Card.Sealed) {
        let pin = pinText
        let root = NfcUiHooks.accountRoot?()
        Task { [weak self] in
            do {
                let rec = try await Task.detached(priority: .userInitiated) {
                    try M5Card.open(sealed, M5Card.keys(pin: M5Card.isValidPin(pin) ? pin : nil, root: root))
                }.value
                guard let self else { return }
                self.onRecord(Self.outcome(rec, words: self.words))
                // A one-time record erases itself once it has been shown.
                if rec.oneTime, let c = self.lastContainer { self.eraseOneTime(c, id: rec.id) }
            } catch {
                self?.flash(NfcConnTagFlow.message(error), .warn)
            }
        }
    }

    /// What a record does (Android actOnRecord / saveRecord): RUN joins or opens, SAVE offers, DISPLAY shows.
    nonisolated static func outcome(_ rec: M5Card.Record, words: NfcWords) -> NfcRecordOutcome {
        let meta = M5Records.meta(rec.type)
        let d = rec.data
        switch meta?.action ?? M5Records.display {
        case M5Records.run:
            if rec.type == "server-room" { return .join(room: d.optString("room"), passphrase: d.optString("passphrase"), name: d.optString("name")) }
            return .url(d.optString("url"))
        case M5Records.save:
            switch rec.type {
            case "wifi": return .wifi(ssid: d.optString("ssid"), password: d.optString("password"))
            case "contact": return .contact(name: d.optString("name"), tel: d.optString("tel"), email: d.optString("email"), org: d.optString("org"))
            case "url-login": return .urlLogin(url: d.optString("url"), user: d.optString("user"), password: d.optString("password"))
            default: return .handoff(title: words(meta?.label ?? "nfc.rec.externalKey"))
            }
        default:
            return .text(title: words(meta?.label ?? "nfc.rec.message"), body: d.has("text") ? d.optString("text") : d.optString("url", d.compact))
        }
    }

    /// Rewrites the card without the one-time record on the next card (Android eraseOneTime).
    func eraseOneTime(_ container: [UInt8], id: Int) {
        guard let rewritten = try? M5Card.removeRecord(container, id: id) else { return }
        flash(words("nfc.onetime.rewrite"), .info)
        let s = service()
        start { [weak self] in
            _ = try await s.writeM5Card(rewritten, texts: NfcSheetTexts())
            guard let self else { return }
            self.lastContainer = rewritten
            if case .records(let rs) = self.content { self.content = .records(rs.filter { $0.id != id }) }
            self.status = self.words("nfc.onetime.erased") + " ✓"
        }
    }

    /* ------------------------------------------------------------ 6.10 application templates */

    /// The picker: m5mobile.define › apduTemplates, grouped by the card type each reads.
    func showTemplates() {
        templates = ApduTemplates.parse(define())
        if templates.isEmpty { flash(words("nfc.tpl.none"), .info); return }
        prompt = .templates
    }

    /// The picker's groups (Android: EMV, e-ID, DESFire, ISO 7816, other), each with its title.
    var templateGroups: [(title: String, items: [ApduTemplates.Template])] {
        [ApduTemplates.emv, ApduTemplates.emrtd, ApduTemplates.desfire, ApduTemplates.iso7816, ""].compactMap { g in
            let items = templates.filter { (ApduTemplates.cards.contains($0.cardType) ? $0.cardType : "") == g }
            return items.isEmpty ? nil : (words("nfc.tpl.group." + (g.isEmpty ? "other" : g)), items)
        }
    }

    /// Why a template is listed but cannot run: its problems (a bad command, not a read — G-18), or this device
    /// (no reader; an EMV template needs payment AIDs).
    func templateProblem(_ t: ApduTemplates.Template) -> String? {
        if !t.runnable { return words.f("nfc.tpl.cantRun", t.problems.isEmpty ? "—" : t.problems.joined(separator: "; ")) }
        let s = service()
        if !NfcPlatform.templateRuns(t, capabilities: s.capabilities) {
            let emv = t.cardType == ApduTemplates.emv
            let why = s.reason(op: emv ? "emv-read" : "app-template", tech: emv ? NfcCatalog.emv : NfcCatalog.isoDep) ?? words("nfc.op.unsupported")
            return words.f("nfc.tpl.cantRun", why)
        }
        return nil
    }

    /// The line under a template: its steps, or that it is an older entry.
    func templateMeta(_ t: ApduTemplates.Template) -> String {
        guard let legacy = t.legacy else { return words.f("nfc.tpl.steps", String(t.steps.count)) }
        return words(legacy == "op" ? "nfc.tpl.legacyOp" : "nfc.tpl.legacy")
    }

    /// An e-ID template asks the holder's key first (its args preset what to read); the others wait for the card.
    func pickTemplate(_ t: ApduTemplates.Template) {
        prompt = nil
        guard templateProblem(t) == nil else { return }
        if let eid = t.eidRead {
            pendingTemplate = t
            prompt = .mrtd(photo: eid.args.optBool("readPhoto", true), all: eid.args.optBool("all", true), template: true)
            return
        }
        startTemplate(t, nil)
    }

    /// Runs every step on the next card with the progress on the screen; Cancel keeps what was read.
    func startTemplate(_ t: ApduTemplates.Template, _ mrtd: MrtdReader.Options?) {
        guard available else { flash(words("nfc.unavailable"), .warn); return }
        let s = service()
        s.stopEmulation()
        content = .progress(t.label)
        progress = "…"
        status = t.label + " — " + words("nfc.tpl.hold")
        start { [weak self] in
            let r = try await s.runTemplate(t, mrtd: mrtd, texts: NfcSheetTexts(), onStep: { n, total, label in
                Task { @MainActor in self?.step(n, total, label) }
            }, onExchange: nil)
            self?.showRun(r)
        }
    }

    /// Cancel a running template: the runner stops before its next command; what was read stays.
    func cancelTemplate() { task?.cancel() }

    private func step(_ n: Int, _ total: Int, _ label: String) {
        let s = words.f("nfc.tpl.running", String(n), String(total), label)
        progress = s
        status = s
    }

    /// The output of a run (Android showRun): readable first, the full card numbers off.
    func showRun(_ r: TemplateRunResult) {
        lastRun = r
        outView = TemplateViews.readable
        fullPan = false
        content = .run
        status = runSummary(r)
    }

    /// How the run went, in one line.
    func runSummary(_ r: TemplateRunResult) -> String {
        let sym = r.status == "error" ? "✗ " : r.status == "warn" ? "⚠ " : "✓ "
        if r.cancelled { return sym + words("nfc.tpl.cancelled") }
        if let e = r.error { return sym + words.f("nfc.tpl.failed", e) }
        return sym + words.f("nfc.tpl.done", String(r.exchanges.count), Formats.decimal(words.lang, Double(r.ms) / 1000, 1))
    }

    /// The current view's text (masked unless the full data is on) — what Share / Forward / Keep send.
    func outputText() -> String {
        guard let r = lastRun else { return "" }
        return TemplateViews.view(outView, r, labels: words.labels, full: fullPan)
    }

    /// The readable view's text under the native EMV / e-ID drawing.
    func readableText() -> String {
        guard let r = lastRun else { return "" }
        return TemplateViews.readableText(r, labels: words.labels, cards: false, full: fullPan)
    }

    /// The run's EMV data as the readable view draws it (masked unless the full data is on).
    var runEmv: NfcJSONObject? {
        guard let r = lastRun, let e = r.emv else { return nil }
        return fullPan ? e : TemplateViews.maskedEmv(e, pans: TemplateViews.pans(r))
    }

    /// A file name for the output: nfc-<template>-<date>.
    func fileBase(_ label: String) -> String {
        var base = label.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        base = base.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if base.count > 40 { base = String(base.prefix(40)); while base.hasSuffix("-") { base.removeLast() } }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return "nfc-" + (base.isEmpty ? "card" : base) + "-" + f.string(from: clock())
    }

    /// Share: the text, or the JSON (and a very long text) as a file — in memory, never on the disk.
    func shareItem() -> NfcShareItem? {
        guard let r = lastRun else { return nil }
        let text = outputText()
        let json = outView == TemplateViews.json
        if json || text.count > Self.shareTextMax {
            return .file(NfcExportFile(name: fileBase(r.label) + (json ? ".json" : ".txt"), mime: json ? "application/json" : "text/plain",
                                       data: Data(text.utf8)), subject: r.label)
        }
        return .text(text, subject: r.label)
    }

    /// Forward to a user (Android forwardOutput): the chat's forward with the output as the message — the text, or
    /// the JSON (and a text too long for a message) as a file: inline when small, else through the vault.
    func forwardMessage() throws -> ChatMessage? {
        guard let r = lastRun else { return nil }
        let text = outputText()
        let json = outView == TemplateViews.json
        var m = ChatMessage()
        m.id = "nfc-" + String(UInt64(clock().timeIntervalSince1970 * 1_000_000), radix: 36)
        m.senderName = "NFC"
        m.forwardedFrom = "NFC · " + r.label
        if !json && text.count <= Self.messageMax {
            m.text = text
            return m
        }
        if !json { flash(words("nfc.out.asFile"), .info) }
        let bytes = Data(text.utf8)
        m.text = r.label
        m.fileName = fileBase(r.label) + (json ? ".json" : ".txt")
        m.fileMime = Payloads.safeMime(json ? "application/json" : "text/plain")
        m.fileSize = Int64(bytes.count)
        if bytes.count <= Self.inlineMax {
            m.fileDataUrl = "data:" + (m.fileMime ?? "text/plain") + ";base64," + bytes.base64EncodedString()
            return m
        }
        guard let files = files() else { throw NfcError(.unsupported, "no file vault") }
        m.filePath = try files.store(bytes)
        return m
    }

    /// Keep for myself: a note in the current room's history — on this device only, never sent (RoomModel.addNote).
    func keepForMyself() {
        guard let r = lastRun else { return }
        guard let room = rooms().active else { flash(words("nfc.out.noRoom"), .warn); return }
        let text = outputText()
        let json = outView == TemplateViews.json
        let head = "🔒 " + words("nfc.out.noteHead") + " · " + r.label
        let me = words("nfc.out.me")
        let noted = words.f("nfc.out.noted", room.label)
        if !json && text.count <= Self.messageMax {
            room.addNote(text: head + "\n\n" + text, fileName: nil, fileMime: nil, dataUrl: nil, filePath: nil, fileSize: 0, toLabel: me)
            flash(noted, .success)
            return
        }
        let bytes = Data(text.utf8)
        let name = fileBase(r.label) + (json ? ".json" : ".txt")
        let mime = Payloads.safeMime(json ? "application/json" : "text/plain")
        if bytes.count <= Self.noteInlineMax {
            room.addNote(text: head, fileName: name, fileMime: mime, dataUrl: "data:" + mime + ";base64," + bytes.base64EncodedString(),
                         filePath: nil, fileSize: Int64(bytes.count), toLabel: me)
            flash(noted, .success)
            return
        }
        do {
            guard let files = files() else { throw NfcError(.unsupported, "no file vault") }
            let id = try files.store(bytes)
            room.addNote(text: head, fileName: name, fileMime: mime, dataUrl: nil, filePath: id, fileSize: Int64(bytes.count), toLabel: me)
            flash(noted, .success)
        } catch {
            flash(NfcConnTagFlow.message(error), .error)
        }
    }

    /* ------------------------------------------------------------ the report (CardReport) */

    /// The e-ID / EMV read on screen as CardReport's input ({status, emv | mrtd}), nil when there is none.
    var reportInput: NfcJSON? {
        switch content {
        case .emv(let e): return ["status": "ok", "emv": .object(e)]
        case .mrtd(let m): return ["status": "ok", "mrtd": .object(m)]
        case .run:
            guard let r = lastRun else { return nil }
            if let e = r.emv { return ["status": "ok", "emv": .object(e)] }
            if let m = r.mrtd { return ["status": "ok", "mrtd": .object(m)] }
            return nil
        default: return nil
        }
    }

    /// The report's files: HTML, JSON, CSV, text and the card's own files — card numbers masked unless the full data is on.
    func reportFiles() -> [NfcExportFile] {
        if let c = reportCache { return c }
        guard let input = reportInput else { return [] }
        let full = content == .run && fullPan
        let files = NfcReportExport.files(input, lang: words.lang, fullPan: full)
        reportCache = files
        return files
    }
}

/// What Share hands the system share sheet.
enum NfcShareItem: Equatable {
    case text(String, subject: String)
    case file(NfcExportFile, subject: String)
}
