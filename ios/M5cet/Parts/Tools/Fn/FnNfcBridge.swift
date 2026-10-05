// 6.6: a model's "nfc" interaction runs on the NFC part's sheet (Parts/NFC
// NfcModelSheetPresenter — Android NfcModelSheet.start from Fn.ask): refused or
// answered at once (a write, an unknown op, enum, no reader), or a sheet that
// waits for the card and asks the holder what may go (G-17). The engine keeps
// the sheet to cancel it when a newer command replaces the run, and tells it
// when the run ended.

import M5Core
import M5Design

extension NfcModelSheetModel: FnNfcAsk {}

@MainActor
enum FnNfcBridge {
    /// The engine's nfcAsk: the NFC part's sheet, answered with its NfcResult.
    static func ask(_ i: FnRun.Interaction, modelName: String, host: DesignHost?, reply: @escaping (JSON?) -> Void) -> (any FnNfcAsk)? {
        NfcModelSheetPresenter.start(runId: i.runId, spec: i.spec, modelName: modelName, host: host) { result in reply(.object(result)) }
    }
}
