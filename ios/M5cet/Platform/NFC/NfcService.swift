// The NFC of the iPhone for the screens and the models — the facade the NFC UI
// (NfcWorkbench, NfcCardBuilder, NfcModelSheet, NfcPanel, ConnTagUi) calls.
// Android: Nfc (the connection card), InternalReader + ReaderMode (reader mode
// per op), CardOps (the per-technology functions), ModelNfcDevice (a model's
// card), CardService (emulation). The logic is M5NFC's; this runs it on a card
// in the system NFC sheet:
//
//   one call = one sheet: the sheet asks for the card (the design's words), the
//   op runs on it, the sheet ends with "Done" / "Written 120 B" or the error.
//
// What the iPhone cannot do is answered with M5NFC's reason before any sheet
// opens (NfcPlatform.limit): MIFARE Classic, raw ISO 14443-3 frames, payment
// AIDs (EMV), card emulation without the HCE entitlement; iPad: no NFC at all.
// One reading at a time — a new one cancels the one before (Android: the newest
// reader-mode owner wins). `cancel()` or cancelling the calling task ends it.

import Foundation
import M5Core
import M5NFC
import Observation

@MainActor
@Observable
final class NfcService {
    static let shared = NfcService()

    /// What the build allows (Info.plist and entitlements — coordinator-owned).
    struct Configuration: Sendable {
        /// Info.plist com.apple.developer.nfc.readersession.iso7816.select-identifiers.
        var allowedAids: [String]
        /// Poll PACE-only ID cards too — only with "PACE" in com.apple.developer.nfc.readersession.formats.
        var pacePolling = false

        static func fromBundle(_ bundle: Bundle = .main) -> Configuration {
            Configuration(allowedAids: CoreNFCRules.infoPlistAids(bundle), pacePolling: bundle.object(forInfoDictionaryKey: "M5NfcPacePolling") as? Bool ?? false)
        }
    }

    @ObservationIgnored let configuration: Configuration
    /// The iPhone has an NFC reader (false on iPad, Apple Watch and the simulator).
    let readingAvailable: Bool
    @ObservationIgnored let emulation: NfcCardEmulation
    @ObservationIgnored let kdf: any TagKdf
    @ObservationIgnored let http: (any ShareInviteHTTP)?
    @ObservationIgnored private let factory: NfcSessionDriverFactory
    @ObservationIgnored let timing: NfcTagSession.Timing
    /// A reading is in progress (the system sheet is up).
    private(set) var busy = false
    @ObservationIgnored private var current: NfcTagSession?

    private convenience init() {
        self.init(configuration: .fromBundle(), readingAvailable: CoreNFCSessionDriver.readingAvailable,
                  factory: CoreNFCSessionDriver.factory, hce: CoreNFCHceProbe(), kdf: Argon2TagKdf(), http: M5ShareInviteHTTP())
    }

    /// Any radio (tests: a fake driver factory and HCE probe).
    init(configuration: Configuration, readingAvailable: Bool, factory: @escaping NfcSessionDriverFactory, hce: any HceProbe,
         kdf: any TagKdf, http: (any ShareInviteHTTP)?, timing: NfcTagSession.Timing = .init()) {
        self.configuration = configuration
        self.readingAvailable = readingAvailable
        self.factory = factory
        self.kdf = kdf
        self.http = http
        self.timing = timing
        emulation = NfcCardEmulation(probe: hce, readingAvailable: readingAvailable)
    }

    /* ------------------------------------------------------------ what it can do */

    /// What this device's own reader does: Core NFC on an iPhone (+ emulation when HCE is available), nothing on iPad.
    var capabilities: NfcCapabilities {
        guard readingAvailable else { return .none }
        return emulation.availability.isAvailable ? NfcCapabilities.coreNFCiPhone.union(.emulation) : .coreNFCiPhone
    }

    /// Why an op is not offered here (nil when it is) — M5NFC's words, for the UI to say.
    func limit(op: String, tech: String = "") -> String? { NfcPlatform.limit(op: op, tech: tech, capabilities: capabilities) }

    /// The catalogue ops this device runs on a technology.
    func ops(for tech: String) -> [NfcCatalog.Op] { NfcPlatform.ops(for: tech, capabilities: capabilities) }

    /// The technologies this device talks to.
    var technologies: [String] { NfcPlatform.technologies(capabilities: capabilities) }

    /// Checks card emulation again (CardSession.isEligible is async); `capabilities` follows.
    @discardableResult
    func refreshEmulation() async -> HceAvailability { await emulation.refresh() }

    /// Ends the reading in progress (the sheet closes; the call throws NfcError .cancelled).
    func cancel() {
        current?.cancel()
        current = nil
        busy = false
    }

    /* ------------------------------------------------------------ the session */

    nonisolated static let ndefAids = [Hex.upper(Ndef.t4tAid), "D2760000850100"]
    nonisolated static let eidAids = [Hex.upper(MrtdReader.aid)]
    /// In the app's language (M5NFC's NfcTexts — the iOS design's nfc.ios.limit.noReader).
    nonisolated static var noReader: String { NfcPlatform.noReader }
    nonisolated static let lockNeedsYes = "Making a tag read-only is permanent — it needs the explicit confirmation."

    /// How a reading ends on the sheet.
    enum SheetEnd: Sendable {
        case success(String?)
        case failure(String)
    }

    var eidPolling: NfcSessionRequest.Polling { configuration.pacePolling ? [.iso14443, .pace] : [.iso14443] }

    /// One reading: the sheet, a card the op takes, the op, the sheet's end. The body runs off the main actor.
    func reading<T: Sendable>(_ polling: NfcSessionRequest.Polling, aids: [String], alert: String, texts: NfcSheetTexts,
                              timeout: Duration? = nil, accept: @escaping NfcTagSession.Accept = { _ in true },
                              end: @escaping @Sendable (T) -> SheetEnd,
                              _ body: @escaping @Sendable (CoreNFCTransport, NfcTagSession) async throws -> T) async throws -> T {
        guard readingAvailable else { throw NfcError.unsupported(Self.noReader) }
        current?.cancel()
        let request = NfcSessionRequest(polling: polling, aids: CoreNFCRules.discoveryAids(aids, allowed: configuration.allowedAids), alert: alert)
        let session = NfcTagSession(request: request, texts: texts, deviceCapabilities: capabilities, allowedAids: configuration.allowedAids,
                                    timing: timing, factory: factory)
        current = session
        busy = true
        defer {
            if current === session { current = nil; busy = false }
        }
        let transport = try await session.waitForCard(timeout: timeout, accept: accept)
        do {
            let value = try await body(transport, session)
            switch end(value) {
            case .success(let m): await session.succeed(m)
            case .failure(let m): await session.fail(m)
            }
            return value
        } catch {
            await session.fail(Self.sheetText(error, texts))
            throw error
        }
    }

    /// The sheet's error line for a thrown error.
    nonisolated static func sheetText(_ error: any Error, _ texts: NfcSheetTexts) -> String {
        if let w = error as? NfcWriteFailure { return w.text(texts) }
        if let n = error as? NfcError { return texts.failure(n) }
        return texts.failed
    }

    /* ------------------------------------------------------------ tags (NDEF) */

    /// Reads a tag in one tap: its identity, NDEF state and records (Android Nfc.readFrom / the workbench scan).
    func readTag(texts: NfcSheetTexts = NfcSheetTexts(), timeout: Duration? = nil) async throws -> NfcTagRead {
        try await reading(.all, aids: IOSAids.documents, alert: texts.hold, texts: texts, timeout: timeout, end: { _ in .success(texts.done) }) { t, _ in
            try await Self.read(t)
        }
    }

    /// The identity, NDEF state and records of the card behind `t`.
    nonisolated static func read(_ t: CoreNFCTransport) async throws -> NfcTagRead {
        var status: NdefStatus? = nil
        var records: [NdefRecord]? = nil
        if t.capabilities.contains(.ndefRead) {
            do {
                let s = try await t.ndefStatus()
                status = s
                if s.state != .notSupported { records = try await t.session.readNdef(t.generation) }
            } catch let e as NfcError where e.code == .cardGone || e.code == .cancelled {
                throw e
            } catch {
                // NDEF that does not read: the identity only (Android: "ndef": false).
            }
        }
        return NfcTagRead(identity: t.identity, ndef: status, records: records)
    }

    /// Writes NDEF records onto a tag (Android CardOps.ndefWriteAny: an NDEF tag, or a blank Ultralight / NTAG).
    /// Returns the message's bytes. A read-only, too small or unwritable tag throws `NfcWriteFailure`.
    func writeTag(_ records: [NdefRecord], texts: NfcSheetTexts = NfcSheetTexts()) async throws -> Int {
        _ = try Ndef.encodeMessage(records) // a malformed record fails before the sheet
        return try await reading(.all, aids: Self.ndefAids, alert: texts.holdWrite, texts: texts, end: { .success(texts.written($0)) }) { t, _ in
            try await t.writeMessage(records)
        }
    }

    /// Makes a tag permanently read-only (Android CardOps.ndefLock). It cannot be undone: without
    /// `confirmPermanentLock` (the person's explicit yes) nothing happens and no sheet opens.
    func lockTag(confirmPermanentLock: Bool, texts: NfcSheetTexts = NfcSheetTexts()) async throws {
        guard confirmPermanentLock else { throw NfcError(.invalidArgument, Self.lockNeedsYes) }
        try await reading(.all, aids: Self.ndefAids, alert: texts.holdWrite, texts: texts, end: { _ in .success(texts.locked) }) { t, _ in
            try await t.writeLock()
        }
    }

    /* ------------------------------------------------------------ connection tags */

    /// Reads a connection tag and opens it (Android Nfc.read: an invitation goes to the server — only `trustedOrigin`,
    /// the app's server — an offline tag runs Argon2id with `secret`, a format-1 tag its PIN). The tag has left the
    /// field when it is opened. `redeem` false leaves an invitation unredeemed (need = "redeem").
    func readConnTag(secret: String = "", trustedOrigin: String?, redeem: Bool = true, texts: NfcSheetTexts = NfcSheetTexts()) async throws -> NfcConnRead {
        let tag = try await readTag(texts: texts)
        let body = tag.connectionBody
        let read = await openConnBody(body, secret: secret, trustedOrigin: trustedOrigin, redeem: redeem)
        return NfcConnRead(tag: tag, body: body, read: read)
    }

    /// Opens a body read before, with the code / PIN typed now (Android Nfc.openLast) — no tag needed.
    func openConnBody(_ body: String?, secret: String, trustedOrigin: String?, redeem: Bool = true) async -> NfcConnTag.Read {
        await NfcConnTag.open(body, secret: secret, trustedOrigin: trustedOrigin, redeem: redeem, kdf: kdf, http: http)
    }

    /// A format-2 body for the room `card` ({room, passphrase, name}): "inv" (an invitation on `origin`) or "off"
    /// (offline, with the code to show once) — Android ConnTag.prepare. Format 1 is never written.
    func prepareConnTag(_ card: NfcJSONObject, kind: String, origin: String, appVersion: String) async throws -> NfcConnTag.Prepared {
        try await NfcConnTag.prepare(card, kind: kind, origin: origin, appVersion: appVersion, kdf: kdf, http: http)
    }

    /// Writes a prepared format-2 body onto a tag (Android Nfc.write / NfcWorkbench.writeConnection).
    func writeConnTag(_ body: String, texts: NfcSheetTexts = NfcSheetTexts()) async throws -> Int {
        guard body.hasPrefix(NfcTagV2.prefix) else { throw NfcError(.invalidArgument, "no tag prepared") }
        return try await writeTag([ConnectionCard.record(body)], texts: texts)
    }

    /// Writes an M5Cet card container (the builder's output) onto a tag.
    func writeM5Card(_ container: [UInt8], texts: NfcSheetTexts = NfcSheetTexts()) async throws -> Int {
        guard M5Card.isM5Card(container) else { throw NfcError(.invalidArgument, "not an M5Cet card container") }
        return try await writeTag([M5Card.ndefRecord(container)], texts: texts)
    }

    /* ------------------------------------------------------------ cards (ISO 7816) */

    /// Reads an e-ID / e-passport with the holder's CAN (PACE).
    func readMrtd(can: String, readPhoto: Bool = true, all: Bool = true, texts: NfcSheetTexts = NfcSheetTexts()) async throws -> NfcJSONObject {
        try await readMrtd(MrtdReader.Options(can: can, readPhoto: readPhoto, all: all), texts: texts)
    }

    /// Reads an e-ID / e-passport with its MRZ (PACE or BAC).
    func readMrtd(mrz: String, readPhoto: Bool = true, all: Bool = true, texts: NfcSheetTexts = NfcSheetTexts()) async throws -> NfcJSONObject {
        try await readMrtd(MrtdReader.Options(mrz: mrz, readPhoto: readPhoto, all: all), texts: texts)
    }

    /// Reads an e-ID / e-passport (Android CardOps.eidRead): {status, mrtd, message, card}. The session has already
    /// selected the eMRTD application, so EF.CardAccess is looked for under the master file too
    /// (`MrtdReader.Options.selectMasterFileForCardAccess`).
    func readMrtd(_ options: MrtdReader.Options, texts: NfcSheetTexts = NfcSheetTexts(), timeout: Duration? = nil) async throws -> NfcJSONObject {
        if let why = limit(op: "eid-read", tech: NfcCatalog.eid) { throw NfcError.unsupported(why) }
        return try await reading(eidPolling, aids: Self.eidAids, alert: texts.hold, texts: texts, timeout: timeout, accept: Self.iso7816Only,
                                 end: { $0.optString("status") == "ok" ? .success(texts.done) : .failure(texts.authFailed) }) { t, _ in
            var o = options
            o.selectMasterFileForCardAccess = t.capabilities.contains(.autoSelectsAid)
            let mrtd = await MrtdReader.read(t, o)
            return ["status": .string(MrtdReader.status(mrtd)), "mrtd": .object(mrtd), "message": .string(MrtdReader.summary(mrtd)),
                    "card": .object(t.identity.json)]
        }
    }

    /// EMV read (Android CardOps.emvRead). On an iPhone Core NFC refuses payment applications: this throws M5NFC's
    /// reason before any sheet (`NfcPlatform.limit`) — nothing is read, nothing faked.
    func readEmv(_ options: EmvReader.Options = EmvReader.Options(), texts: NfcSheetTexts = NfcSheetTexts()) async throws -> NfcJSONObject {
        if let why = limit(op: "emv-read", tech: NfcCatalog.emv) { throw NfcError.unsupported(why) }
        return try await reading([.iso14443], aids: [], alert: texts.hold, texts: texts, accept: { $0.isoDep }, end: { _ in .success(texts.done) }) { t, _ in
            let emv = await EmvReader.read(t, options)
            return ["status": "ok", "emv": .object(emv), "message": .string(EmvReader.summary(emv)), "card": .object(t.identity.json)]
        }
    }

    /// Runs an APDU template (6.10, m5mobile.define.apduTemplates) on a card — M5NFC's TemplateRunner with its
    /// read-only rule (G-18). `mrtd`: the holder's key for an eid-read step. The sheet shows each step.
    func runTemplate(_ template: ApduTemplates.Template, mrtd: MrtdReader.Options? = nil, texts: NfcSheetTexts = NfcSheetTexts(),
                     onStep: TemplateRunner.StepListener? = nil, onExchange: TemplateRunner.ExchangeListener? = nil) async throws -> TemplateRunResult {
        guard template.runnable else { throw NfcError(.invalidArgument, template.problems.first ?? "the template has no steps") }
        guard NfcPlatform.templateRuns(template, capabilities: capabilities) else {
            let op = template.cardType == ApduTemplates.emv ? "emv-read" : "app-template"
            throw NfcError.unsupported(limit(op: op, tech: template.cardType == ApduTemplates.emv ? NfcCatalog.emv : NfcCatalog.isoDep)
                                       ?? (readingAvailable ? "This template does not run on this iPhone." : Self.noReader))
        }
        var aids = IOSAids.documents
        if !template.aid.isEmpty { aids.insert(template.aid.uppercased(), at: 0) }
        return try await reading([.iso14443], aids: aids, alert: texts.holdTemplate, texts: texts, accept: { $0.isoDep },
                                 end: { r in r.status == "error" ? .failure(r.error ?? texts.failed) : .success(texts.done) }) { t, session in
            let runner = TemplateRunner(template, mrtd: mrtd.map { o in
                var o = o
                o.selectMasterFileForCardAccess = t.capabilities.contains(.autoSelectsAid)
                return o
            }, onStep: { n, total, label in
                Task { await session.setAlert(texts.step(n, total, label)) }
                onStep?(n, total, label)
            }, onExchange: onExchange)
            return await withTaskCancellationHandler { await runner.run(t) } onCancel: { runner.cancel() }
        }
    }

    /// `runTemplate` without progress callbacks.
    func readCard(template: ApduTemplates.Template, mrtd: MrtdReader.Options? = nil, texts: NfcSheetTexts = NfcSheetTexts()) async throws -> TemplateRunResult {
        try await runTemplate(template, mrtd: mrtd, texts: texts)
    }

    nonisolated static let iso7816Only: NfcTagSession.Accept = { if case .iso7816 = $0 { return true }; return false }

    /* ------------------------------------------------------------ the workbench's ops */

    /// One catalogue op on the next card (Android NfcWorkbench.runOp) — what the iPhone cannot do throws M5NFC's
    /// reason before the sheet. `tech`: the technology the person chose (for the limit), "" for any.
    func perform(_ op: String, tech: String = "", input: NfcOpInput = .none, texts: NfcSheetTexts = NfcSheetTexts()) async throws -> NfcOpResult {
        if let why = limit(op: op == "mrtd-read" ? "eid-read" : op, tech: tech) { throw NfcError.unsupported(why) }
        switch op {
        case "scan", "read-uid", "read-public", "ndef-read":
            let r = try await readTag(texts: texts)
            return NfcOpResult(card: r.identity, output: op == "read-uid" ? NfcJSONObject() : r.json)
        case "ndef-write", "m5-write", "conn-write":
            let records: [NdefRecord]
            switch input {
            case .records(let rs): records = rs
            case .text(let s): records = [try Ndef.textRecord(s, lang: Locale.current.language.languageCode?.identifier ?? "en")]
            default: throw NfcError(.invalidArgument, "nothing to write")
            }
            _ = try Ndef.encodeMessage(records)
            return try await reading(.all, aids: Self.ndefAids, alert: texts.holdWrite, texts: texts, end: { .success($0.output.string("done")) }) { t, _ in
                let n = try await t.writeMessage(records)
                return NfcOpResult(card: t.identity, output: ["done": .string(texts.written(n)), "bytes": NfcJSON(n)])
            }
        case "ndef-lock":
            guard case .confirmLock(true) = input else { throw NfcError(.invalidArgument, Self.lockNeedsYes) }
            return try await reading(.all, aids: Self.ndefAids, alert: texts.holdWrite, texts: texts, end: { _ in .success(texts.locked) }) { t, _ in
                try await t.writeLock()
                return NfcOpResult(card: t.identity, output: ["done": .string(texts.locked)])
            }
        case "eid-read", "mrtd-read":
            guard case .mrtd(let o) = input else {
                throw NfcError(.invalidArgument, texts.provider.t("nfc.eid.needKey", "Give the MRZ (document number, date of birth, expiry) or the CAN printed on the document to open the chip."))
            }
            let r = try await readMrtd(o, texts: texts)
            return NfcOpResult(card: Self.identity(r), output: r)
        case "app-template":
            guard case .template(let tpl, let o) = input else { throw NfcError(.invalidArgument, "no template chosen") }
            let r = try await runTemplate(tpl, mrtd: o, texts: texts)
            return NfcOpResult(card: CardIdentity(uid: "", tech: NfcCatalog.isoDep), output: ["status": .string(r.status)], template: r)
        case "emv-read":
            let r = try await readEmv(texts: texts)
            return NfcOpResult(card: Self.identity(r), output: r)
        default:
            break
        }
        // The rest: a short op on the card in the field.
        let accept: NfcTagSession.Accept
        let polling: NfcSessionRequest.Polling
        switch op {
        case "ul-read", "ntag-read", "ul-write", "ntag-write": accept = { $0.capabilities.contains(.mifareUltralight) }; polling = [.iso14443]
        case "desfire-apps": accept = { $0.capabilities.contains(.desfire) }; polling = [.iso14443]
        case "raw-apdu", "select-aid", "emv-public", "eid-public": accept = { $0.isoDep }; polling = [.iso14443]
        case "v-read", "v-write": accept = { if case .iso15693 = $0 { return true }; return false }; polling = [.iso15693]
        case "felica-systems": accept = { if case .feliCa = $0 { return true }; return false }; polling = [.iso18092]
        case "m5-read", "conn-read": accept = { _ in true }; polling = .all
        default: throw NfcError.unsupported("\"\(op)\" is not an operation of this device.")
        }
        return try await reading(polling, aids: IOSAids.documents, alert: texts.hold, texts: texts, accept: accept, end: { _ in .success(texts.done) }) { t, _ in
            let out: NfcJSONObject
            switch op {
            case "ul-read", "ntag-read":
                out = try await CardOps.ultralightRead(t)
            case "ul-write", "ntag-write":
                guard case .block(let page, let data) = input, data.count == 4, (0...255).contains(page) else { throw NfcError(.invalidArgument, "page-is-4-bytes") }
                let ack = try await t.mifareCommand([0xa2, UInt8(page)] + data)
                if ack.count == 1 && ack[0] & 0x0f != 0x0a { throw NfcError(.cardError, "the tag refused page \(page)") }
                out = ["done": .string(texts.written(4))]
            case "desfire-apps":
                out = try await CardOps.desfireApps(t)
            case "raw-apdu", "select-aid":
                guard case .apdu(let apdu) = input else { throw NfcError(.invalidArgument, "no APDU") }
                out = ["apdu": .string(Hex.upper(try await t.transmit(apdu)))]
            case "emv-public":
                out = try await CardOps.emvPublic(t)
            case "eid-public":
                out = try await CardOps.eidPublic(t)
            case "v-read":
                out = try await t.iso15693Read()
            case "v-write":
                guard case .block(let block, let data) = input else { throw NfcError(.invalidArgument, "a block and its data") }
                try await t.iso15693Write(block: block, data: data)
                out = ["done": .string(texts.written(data.count))]
            case "felica-systems":
                out = try await t.felicaSystems()
            default: // m5-read, conn-read: the records; the screens open them (M5Card / ConnTag) after the tap
                let r = try await Self.read(t)
                var o = r.json
                if let c = r.m5Container { o["m5"] = .string(Hex.upper(c)) }
                if let b = r.connectionBody { o["connBody"] = .string(b) }
                return NfcOpResult(card: r.identity, output: o)
            }
            return NfcOpResult(card: t.identity, output: out)
        }
    }

    nonisolated static func identity(_ r: NfcJSONObject) -> CardIdentity {
        let c = r.optObject("card") ?? NfcJSONObject()
        return CardIdentity(uid: c.optString("uid"), tech: c.optString("tech", NfcCatalog.unknown), label: c.string("label"), ats: c.string("ats"),
                            memory: c.string("memory"))
    }

    /* ------------------------------------------------------------ card emulation (HCE) */

    /// Answers as the connection tag (Android Nfc.emulate / CardService.serveConnection) until a reader read it,
    /// `stopEmulation()`, or iOS ends it. Without HCE on this iPhone: M5NFC's limit reason.
    func emulateConnection(_ body: String, texts: NfcSheetTexts = NfcSheetTexts()) async throws -> HceEnd {
        guard body.hasPrefix(NfcTagV2.prefix) else { throw NfcError(.invalidArgument, "no tag prepared") }
        return try await emulation.serve(try Type4TagEmulator.connection(body), texts: texts)
    }

    /// Answers as an M5Cet card (Android CardService.serveM5Card).
    func emulateM5Card(_ container: [UInt8], texts: NfcSheetTexts = NfcSheetTexts()) async throws -> HceEnd {
        try await emulation.serve(try Type4TagEmulator.m5Card(container), texts: texts)
    }

    /// Stops answering as a card (Android CardService.stopServing).
    func stopEmulation() { emulation.stop() }
}
