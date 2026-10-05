// DEBUG only: an NFC radio for screenshots — the simulator has no NFC, so
//   -M5NfcDemo iphone     the workbench as on an iPhone with NFC (a scanned NTAG and its ops)
//   -M5NfcDemo classic    … MIFARE Classic chosen: its ops disabled with the iPhone's reasons (emv: payment AIDs)
//   -M5NfcDemo template   … and a template's run (ISO 7816, on a simulated card)
//   -M5NfcDemo mrtd       … and an e-ID read (a specimen document, the face drawn here)
//   -M5NfcDemo records    … and an M5Cet card's records
//   -M5NfcDemo templates  … and the templates' picker (an EMV one listed but not runnable on an iPhone)
//   -M5NfcDemo consent    a model's read of an ID card, waiting for the holder's consent
//   -M5NfcDemo key        a model's e-ID read asking for the document's key
//   -M5NfcDemo builder    the card builder with three records
// e.g. xcrun simctl launch <udid> cz.m5cet.app -M5Screen nfc -M5NfcDemo template
// No real card data anywhere: the document is a specimen. Compiled out of Release.

#if DEBUG
import Foundation
import M5Core
import M5NFC
import UIKit

@MainActor
enum NfcDemo {
    static var mode: String? { UserDefaults.standard.string(forKey: "M5NfcDemo").flatMap { $0.isEmpty ? nil : $0 } }
    private static var service: NfcDemoService?

    static func installIfAsked() {
        guard mode != nil else { return }
        let s = NfcDemoService()
        service = s
        NfcUiHooks.service = { s }
    }

    /// The workbench in the asked state (after its view attached itself to the window).
    static func prepare(_ model: NfcWorkbenchModel) {
        guard let mode, service != nil else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(500))
            model.define = { templates }
            switch mode {
            case "iphone": model.scan()
            case "classic": model.tech = NfcCatalog.mifareClassic1k
            case "emv": model.tech = NfcCatalog.emv
            case "template":
                model.tech = NfcCatalog.isoDep
                if let t = ApduTemplates.parse(templates).first(where: { $0.cardType == ApduTemplates.iso7816 }) { model.startTemplate(t, nil) }
            case "mrtd":
                model.tech = NfcCatalog.eid
                model.run("eid-read", .mrtd(MrtdReader.Options(can: "123456")))
            case "records":
                model.tech = NfcCatalog.m5cetCard
                model.run("m5-read", .none)
            case "templates":
                model.scan()
                try? await Task.sleep(for: .milliseconds(400))
                model.showTemplates()
            case "consent", "key":
                guard let host = model.host else { return }
                var args: NfcJSONObject = [:]
                if mode == "consent" { args["can"] = "123456" }
                NfcModelSheetPresenter.start(runId: "demo", spec: ["command": ["op": "eid-read", "args": .object(args), "timeout": 30]],
                                             modelName: "Doklady", host: host) { _ in }
            default: break
            }
        }
    }

    static func prepare(_ model: NfcCardBuilderModel) {
        guard mode == "builder" else { return }
        model.pin = "48151623"
        model.add("message"); model.save(values: ["text": "Welcome to the team room"], oneTime: false, isInternal: false)
        model.add("wifi"); model.save(values: ["ssid": "M5-Guest", "password": "demo-only", "auth": "WPA"], oneTime: false, isInternal: false)
        model.add("one-time-message"); model.save(values: ["text": "The door code changes on Monday"], oneTime: true, isInternal: false)
    }

    /// m5mobile.define › apduTemplates for the picker.
    static let templates: [NfcJSON] = [
        ["label": "Payment card — every application", "card": "emv", "note": "PPSE, every AID, the history.", "steps": [["op": "emv-read"]]],
        ["label": "ID card — every data group", "card": "emrtd", "note": "PACE with the CAN, DG1–DG16.", "steps": [["op": "eid-read", "args": ["readPhoto": true, "all": true]]]],
        ["label": "DESFire — applications", "card": "desfire", "steps": [["apdu": "9060000000", "label": "GetVersion"], ["apdu": "906A000000", "label": "GetApplicationIDs"]]],
        ["label": "Smart card — basic info", "card": "iso7816", "note": "SELECT the e-ID, READ BINARY, GET DATA.",
         "steps": [["apdu": "00A4040C07A0000002471001", "label": "SELECT eMRTD"], ["apdu": "00B0000008", "label": "READ BINARY"],
                   ["apdu": "00CA9F7F00", "label": "GET DATA (CPLC)", "optional": true]]],
        ["label": "Write test", "card": "iso7816", "steps": [["apdu": "00D6000004AABBCCDD", "label": "UPDATE BINARY"]]],
    ]

    /// A specimen e-ID read: the holder, a drawn face, DG11 / DG12, the security objects, the files.
    static func mrtd() -> NfcJSONObject {
        let face = drawnFace()
        return [
            "present": true, "access": "pace",
            "pace": ["protocol": "PACE-ECDH-GM-AES-CBC-CMAC-128", "password": "can", "supported": true, "used": true, "parameterId": 13],
            "dataGroups": ["DG1", "DG2", "DG7", "DG11", "DG12", "DG14"],
            "mrzInfo": ["documentCode": "ID", "documentNumber": "SPEC01234", "nationality": "UTO", "issuer": "UTO", "givenNames": "ANNA",
                        "surname": "SPECIMEN", "dateOfBirth": "1990-05-14", "sex": "F", "dateOfExpiry": "2034-05-13"],
            "photo": .string(face), "photoMime": "image/jpeg",
            "images": [["kind": "face", "group": "DG2", "mime": "image/jpeg", "name": "face.jpg", "data": .string(face)],
                       ["kind": "signature", "group": "DG7", "mime": "image/jp2", "name": "signature.jp2", "data": "AAAADGpQICANCocKAAAAFGZ0eXA="]],
            "personal": ["fullName": "ANNA SPECIMEN", "placeOfBirth": "UTOPIA", "address": ["1 SAMPLE STREET", "UTOPIA"]],
            "document": ["issuingAuthority": "MINISTRY OF SAMPLES", "dateOfIssue": "2024-05-14"],
            "security": ["passive": "ok", "hashAlgorithm": "SHA-256", "protocols": ["PACE", "Chip Authentication"],
                         "signer": ["subject": "CN=Document Signer 01, C=UT", "issuer": "CN=CSCA Utopia, C=UT", "notBefore": "2024-01-01", "notAfter": "2034-12-31", "serial": "1A2B3C"]],
            "files": [["name": "EF.COM", "fid": "011E", "status": "read", "size": 23],
                      ["name": "EF.SOD", "fid": "011D", "status": "read", "size": 2_042],
                      ["name": "DG1", "fid": "0101", "status": "read", "size": 93, "hashOk": true],
                      ["name": "DG2", "fid": "0102", "status": "read", "size": 14_380, "hashOk": true],
                      ["name": "DG3", "fid": "0103", "status": "protected"]],
            "ldsVersion": "0108", "unicodeVersion": "040000", "message": "",
        ]
    }

    /// A face for the specimen: a silhouette, JPEG, base64.
    static func drawnFace() -> String {
        let size = CGSize(width: 180, height: 240)
        let img = UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor(red: 0.86, green: 0.89, blue: 0.93, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            UIColor(red: 0.45, green: 0.50, blue: 0.58, alpha: 1).setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 55, y: 45, width: 70, height: 88))
            ctx.cgContext.fillEllipse(in: CGRect(x: 20, y: 150, width: 140, height: 140))
        }
        return img.jpegData(compressionQuality: 0.8)?.base64EncodedString() ?? ""
    }
}

/// A simulated ISO 7816 card for a template's run: SELECT and READ BINARY answer, GET DATA is not there.
final class NfcDemoChip: ApduChannel, @unchecked Sendable {
    func transmit(_ apdu: [UInt8]) async throws -> [UInt8] {
        try await Task.sleep(for: .milliseconds(40))
        guard apdu.count >= 4 else { return [0x67, 0x00] }
        switch apdu[1] {
        case 0xA4: return [0x90, 0x00]
        case 0xB0: return [0x60, 0x16, 0x5F, 0x01, 0x04, 0x30, 0x31, 0x30, 0x90, 0x00]
        default: return [0x6A, 0x88]
        }
    }
}

/// The demo radio: an iPhone's capabilities without HCE, canned cards.
@MainActor
final class NfcDemoService: NfcUiService {
    var readingAvailable = true
    var capabilities: NfcCapabilities = .coreNFCiPhone
    var busy = false

    func limit(op: String, tech: String) -> String? { NfcPlatform.limit(op: op, tech: tech, capabilities: capabilities) }
    func refreshEmulation() async -> HceAvailability { .unavailable(NfcPlatform.limit(op: "m5-emulate", tech: "", capabilities: capabilities) ?? "") }
    func cancel() { busy = false }

    static let ntag = CardIdentity(uid: "04A23B11223380", tech: NfcCatalog.ntag21x, label: "NTAG 213 / 215 / 216", atqa: "0044", sak: "00", memory: "504 B")

    func readTag(texts: NfcSheetTexts, timeout: Duration?) async throws -> NfcTagRead {
        NfcTagRead(identity: Self.ntag, ndef: NdefStatus(state: .readWrite, capacity: 496), records: [try Ndef.textRecord("M5cet", lang: "en")])
    }

    func perform(_ op: String, tech: String, input: NfcOpInput, texts: NfcSheetTexts) async throws -> NfcOpResult {
        try await Task.sleep(for: .milliseconds(300))
        switch op {
        case "eid-read", "mrtd-read":
            let card = CardIdentity(uid: "08A1B2C3", tech: NfcCatalog.eid, label: "Electronic ID / MRTD", selectedAid: "A0000002471001")
            return NfcOpResult(card: card, output: ["status": "ok", "mrtd": .object(NfcDemo.mrtd()), "card": .object(card.json)])
        case "m5-read":
            let root = [UInt8](repeating: 7, count: 32)
            let recs = [M5Card.Record(type: "server-room", mode: M5Card.modeInternal, data: ["room": "team", "passphrase": "demo"]),
                        M5Card.Record(type: "wifi", mode: M5Card.modeInternal, data: ["ssid": "M5-Guest"]),
                        M5Card.Record(type: "one-time-message", mode: M5Card.modeInternal, oneTime: true, data: ["text": "Hello"])]
            let c = try M5Card.buildCard(recs, M5Card.keys(pin: nil, root: root))
            var id = Self.ntag
            id.tech = NfcCatalog.m5cetCard
            id.label = NfcCatalog.techInfo(NfcCatalog.m5cetCard).label
            return NfcOpResult(card: id, output: ["m5": .string(Hex.upper(c))])
        default:
            return NfcOpResult(card: Self.ntag, output: ["done": .string(texts.written(37)), "bytes": 37])
        }
    }

    func runTemplate(_ template: ApduTemplates.Template, mrtd: MrtdReader.Options?, texts: NfcSheetTexts,
                     onStep: TemplateRunner.StepListener?, onExchange: TemplateRunner.ExchangeListener?) async throws -> TemplateRunResult {
        await TemplateRunner(template, mrtd: mrtd, onStep: onStep, onExchange: onExchange).run(NfcDemoChip())
    }

    func openConn(_ body: String?, secret: String, trustedOrigin: String?, redeem: Bool) async -> NfcConnReading {
        var r = NfcConnReading()
        r.format = "v2-inv"
        r.need = "redeem"
        return r
    }

    func prepareConn(_ card: NfcJSONObject, kind: String, origin: String, appVersion: String) async throws -> NfcPreparedTag {
        NfcPreparedTag(body: NfcTagV2.prefix + "{}", code: kind == "off" ? "7K2M-9QXD-4TPR-8WZA-H3NB" : nil)
    }

    func writeConnTag(_ body: String, texts: NfcSheetTexts) async throws -> Int { 120 }
    func writeM5Card(_ container: [UInt8], texts: NfcSheetTexts) async throws -> Int { container.count + 16 }
    func lockTag(confirmPermanentLock: Bool, texts: NfcSheetTexts) async throws {}

    func emulateConnection(_ body: String, texts: NfcSheetTexts) async throws -> HceEnd {
        throw NfcError.unsupported(limit(op: "conn-emulate", tech: NfcCatalog.connectionTag) ?? "")
    }

    func emulateM5Card(_ container: [UInt8], texts: NfcSheetTexts) async throws -> HceEnd {
        throw NfcError.unsupported(limit(op: "m5-emulate", tech: NfcCatalog.m5cetCard) ?? "")
    }

    func stopEmulation() {}

    func modelPlan(_ spec: NfcJSONObject?, preferredReader: String) -> ModelNfcPlan { NfcModelPlanner.plan(spec, capabilities: capabilities, preferredReader: preferredReader) }

    func modelRead(_ command: ModelNfc.Command, texts: NfcSheetTexts) async -> NfcJSONObject {
        try? await Task.sleep(for: .milliseconds(1200))
        return ModelNfc.result("ok", ["uid": "08A1B2C3", "tech": "eid", "label": "Electronic ID / MRTD"], nil).with("mrtd", .object(NfcDemo.mrtd()))
    }
}
#endif

/// What a model's "nfc" interaction does on a device with these capabilities (NfcService.modelPlan's logic, for the
/// fakes that are not NfcService).
enum NfcModelPlanner {
    static func plan(_ spec: NfcJSONObject?, capabilities: NfcCapabilities, preferredReader: String) -> ModelNfcPlan {
        let cmd = ModelNfc.parse(spec)
        if let refused = ModelNfc.refusal(cmd) { return .answer(refused) }
        var d = ModelNfc.Device()
        d.hasNfc = !capabilities.isEmpty
        d.nfcOn = !capabilities.isEmpty
        d.internalCapabilities = capabilities
        d.preferred = preferredReader
        if cmd.op == "enum" { return .answer(ModelNfc.enumResult(cmd, d)) }
        let route = ModelNfc.route(cmd, d)
        if let r = route.result { return .answer(r) }
        if ModelNfc.needsDocumentKey(cmd) { return .askDocumentKey(cmd) }
        return .read(cmd)
    }
}
