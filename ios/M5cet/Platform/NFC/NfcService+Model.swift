// What a Functions model's `nfc` call does on the iPhone (6.6; Android
// NfcModelSheet.start + ModelNfcDevice) — the radio side of M5NFC's ModelNfc:
//
//   modelPlan(spec)  → .answer   refused (a write / emulation / unknown op: "denied" / "unsupported"),
//                                `enum`, or ModelNfc.route's answer — on an iPhone an EMV read is answered
//                                at once with the payment-AID limit, on iPad "no NFC reader";
//                    → .askDocumentKey   an e-ID read without the CAN / MRZ: the sheet asks the holder
//                                (ModelNfc.checkDocumentKey, withDocumentKey) — it never goes to the model;
//                    → .read     modelRead(command): the system sheet waits for the card (the command's
//                                timeout, at most iOS's 60 s), ModelNfc.run reads it.
//
// The answer with card data then needs the holder's yes (6.10 G-17): the sheet shows
// ModelNfc.consent / consentText and sends ModelNfc.masked (default), the result, or
// ModelNfc.declined. That is the NFC UI's (NfcModelSheet); nothing here sends anything.

import Foundation
import M5NFC

extension NfcService {
    /// iOS ends a reader session after 60 s; a model's wait is capped there.
    nonisolated static let sessionLimit = 60

    /// The readers this device has for a model (Android ModelNfcDevice.snapshot): the iPhone's own Core NFC; no USB,
    /// no Bluetooth reader from a model; iOS has no NFC switch.
    func modelDevice(preferredReader: String = "") -> ModelNfc.Device {
        var d = ModelNfc.Device()
        d.hasNfc = readingAvailable
        d.nfcOn = readingAvailable
        d.internalCapabilities = capabilities
        d.preferred = preferredReader
        d.bluetooth = false
        d.usb = []
        return d
    }

    /// What a model's "nfc" interaction (its spec { command }) does here, before any card.
    func modelPlan(_ spec: NfcJSONObject?, preferredReader: String = "") -> ModelNfcPlan {
        let cmd = ModelNfc.parse(spec)
        if let refused = ModelNfc.refusal(cmd) { return .answer(refused) }
        let device = modelDevice(preferredReader: preferredReader)
        if cmd.op == "enum" { return .answer(ModelNfc.enumResult(cmd, device)) }
        let route = ModelNfc.route(cmd, device)
        if let r = route.result { return .answer(r) }
        if ModelNfc.needsDocumentKey(cmd) { return .askDocumentKey(cmd) }
        return .read(cmd)
    }

    /// Waits for the card (≤ the command's timeout, ≤ 60 s) and runs the model's read on it. Never throws: a timeout is
    /// ModelNfc.timedOut, the sheet closed is ModelNfc.cancelled, a card that left is "no-card".
    func modelRead(_ command: ModelNfc.Command, texts: NfcSheetTexts = NfcSheetTexts()) async -> NfcJSONObject {
        let seconds = max(1, min(command.timeout, Self.sessionLimit))
        let op = command.op
        let document = ModelNfc.isEidRead(op) || op == "eid-public"
        let polling: NfcSessionRequest.Polling = document ? eidPolling : op.hasPrefix("emv") ? [.iso14443] : .all
        do {
            return try await reading(polling, aids: document ? Self.eidAids : IOSAids.documents, alert: texts.hold, texts: texts,
                                     timeout: .seconds(seconds), end: { r in Self.sheetEnd(r, texts) }) { t, _ in
                await ModelNfc.run(command, TransportCard(t, identity: t.identity))
            }
        } catch let e as NfcError {
            if e == NfcTagSession.noCard(seconds) || e == NfcErrorMap.error(for: .timeout) { return ModelNfc.timedOut(seconds) }
            switch e.code {
            case .cancelled: return ModelNfc.cancelled()
            case .unsupported: return ModelNfc.result("unsupported", nil, e.message)
            default: return ModelNfc.result("error", nil, e.message)
            }
        } catch {
            return ModelNfc.result("error", nil, (error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
    }

    /// How the sheet ends for a model's answer.
    nonisolated static func sheetEnd(_ r: NfcJSONObject, _ texts: NfcSheetTexts) -> SheetEnd {
        switch r.optString("status") {
        case "ok": return .success(texts.done)
        case "no-card": return .failure(texts.lost)
        case "auth-failed": return .failure(texts.authFailed)
        default:
            let m = r.optString("message")
            return .failure(m.isEmpty ? texts.failed : m)
        }
    }
}
