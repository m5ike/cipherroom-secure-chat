// The read operations on a card that are not tied to one radio (A/nfc/CardOps.java,
// the parts above android.nfc): the EMV and e-ID public reads, the model / workbench
// NfcResult of a full read, DESFire's public info and the Ultralight / NTAG pages.
// Writes, MIFARE Classic and the magic-card UID are the workbench's and the
// transport's; on iOS they are flagged (`NfcPlatform`).

import Foundation
import M5Core

public enum CardOps {
    /// EMV PUBLIC read: PPSE → the card's application labels and AIDs. Read-only, no transaction.
    public static func emvPublic(_ t: any ApduChannel) async throws -> NfcJSONObject {
        let r = Apdu.split(try await t.transmit(Apdu.selectByAid(EmvReader.ppse)))
        var out = NfcJSONObject()
        let ok = r.sw == 0x9000
        out["ppse"] = .string(ok ? Hex.upper(r.data) : "no-ppse")
        var apps = [NfcJSON]()
        if ok {
            let nodes = BerTlv.decode(r.data, recurse: true)
            let aids = BerTlv.findAll(nodes, 0x4f), labels = BerTlv.findAll(nodes, 0x50)
            for (i, a) in aids.enumerated() {
                var app: NfcJSONObject = ["aid": .string(Hex.upper(a.value))]
                if i < labels.count { app["label"] = .string(Bytes.asciiString(labels[i].value)) }
                apps.append(.object(app))
            }
        }
        out["applications"] = .array(apps)
        out["note"] = .string(NfcTexts.t("nfc.note.emvPublic", "Public data only: application labels/AIDs. No PIN, no signing, no transaction."))
        return out
    }

    /// e-ID / MRTD PUBLIC info: whether an eMRTD application answers. The data groups need the CAN / MRZ.
    public static func eidPublic(_ t: any ApduChannel) async throws -> NfcJSONObject {
        let r = Apdu.split(try await t.transmit(Apdu.build(0x00, 0xa4, 0x04, 0x0c, data: MrtdReader.aid)))
        let ok = r.sw == 0x9000
        return ["document": .string(ok ? "ICAO eMRTD (ePassport / eID)" : "unknown"), "selected": .bool(ok),
                "note": .string(NfcTexts.t("nfc.note.eidPublic", "Public info only. The data groups are protected by BAC/PACE — type the CAN or the MRZ to unlock them. No cloning, no signing."))]
    }

    /// 6.6: the NfcResult of a model / workbench card read — `emv-read` or `eid-read` / `mrtd-read` — with the
    /// op's `args` passed through (EMV: maxApps, history, deep; MRTD: mrz, documentNumber + dateOfBirth +
    /// dateOfExpiry, can, readPhoto, all): {status, emv | mrtd, message}. Nil for another op.
    public static func readResult(_ op: String, _ t: any ApduChannel, _ args: NfcJSONObject?, selectMasterFileForCardAccess: Bool = false) async -> NfcJSONObject? {
        switch op {
        case "emv-read":
            let emv = await EmvReader.read(t, EmvReader.Options.from(args: args))
            return ["status": "ok", "emv": .object(emv), "message": .string(EmvReader.summary(emv))]
        case "eid-read", "mrtd-read":
            var o = MrtdReader.Options.from(args: args)
            o.selectMasterFileForCardAccess = selectMasterFileForCardAccess
            let mrtd = await MrtdReader.read(t, o)
            return ["status": .string(MrtdReader.status(mrtd)), "mrtd": .object(mrtd), "message": .string(MrtdReader.summary(mrtd))]
        default: return nil
        }
    }

    /// DESFire: the version and the applications (public info only).
    public static func desfireApps(_ t: any ApduChannel) async throws -> NfcJSONObject { try await Desfire.readInfo(t) }

    /// Ultralight / NTAG: every readable page (READ 30 p answers four pages), until a read fails —
    /// over the transport's MIFARE commands (`NfcCapabilities.mifareUltralight`).
    public static func ultralightRead(_ t: any CardTransport, maxPage: Int = 231) async throws -> NfcJSONObject {
        guard t.capabilities.contains(.mifareUltralight) else { throw NfcError.unsupported("this reader does not send MIFARE commands") }
        var pages = [NfcJSON]()
        var p = 0
        while p < maxPage {
            guard let four = try? await t.mifareCommand([0x30, UInt8(p & 0xff)]), four.count >= 16 else { break }
            for i in 0..<4 { pages.append(.string(Hex.upper(four[(i * 4)..<(i * 4 + 4)]))) }
            p += 4
        }
        return ["pages": .array(pages), "pageCount": NfcJSON(pages.count)]
    }
}
