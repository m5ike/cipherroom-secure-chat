// Core NFC's errors in M5NFC's words: the raw codes NfcErrorMap uses are the
// SDK's NFCReaderError values, the domain is NFCErrorDomain, and each error a
// session or a tag command can end with maps to what the readers and a model's
// answer expect (card gone → "no-card", the person closing the sheet → cancelled).

import CoreNFC
import XCTest
import M5NFC
@testable import M5cet

final class NfcErrorMapTests: XCTestCase {
    func nfc(_ code: Int) -> NSError { NSError(domain: NFCErrorDomain, code: code) }

    func testTheCodesAreTheSdks() {
        XCTAssertEqual(NfcErrorMap.domain, NFCErrorDomain)
        let pairs: [(Int, NFCReaderError.Code)] = [
            (NfcErrorMap.unsupportedFeature, .readerErrorUnsupportedFeature),
            (NfcErrorMap.securityViolation, .readerErrorSecurityViolation),
            (NfcErrorMap.invalidParameter, .readerErrorInvalidParameter),
            (NfcErrorMap.invalidParameterLength, .readerErrorInvalidParameterLength),
            (NfcErrorMap.parameterOutOfBound, .readerErrorParameterOutOfBound),
            (NfcErrorMap.radioDisabled, .readerErrorRadioDisabled),
            (NfcErrorMap.tagConnectionLost, .readerTransceiveErrorTagConnectionLost),
            (NfcErrorMap.retryExceeded, .readerTransceiveErrorRetryExceeded),
            (NfcErrorMap.tagResponseError, .readerTransceiveErrorTagResponseError),
            (NfcErrorMap.sessionInvalidated, .readerTransceiveErrorSessionInvalidated),
            (NfcErrorMap.tagNotConnected, .readerTransceiveErrorTagNotConnected),
            (NfcErrorMap.packetTooLong, .readerTransceiveErrorPacketTooLong),
            (NfcErrorMap.userCanceled, .readerSessionInvalidationErrorUserCanceled),
            (NfcErrorMap.sessionTimeout, .readerSessionInvalidationErrorSessionTimeout),
            (NfcErrorMap.terminatedUnexpectedly, .readerSessionInvalidationErrorSessionTerminatedUnexpectedly),
            (NfcErrorMap.systemIsBusy, .readerSessionInvalidationErrorSystemIsBusy),
            (NfcErrorMap.firstNDEFTagRead, .readerSessionInvalidationErrorFirstNDEFTagRead),
            (NfcErrorMap.invalidConfiguration, .tagCommandConfigurationErrorInvalidParameters),
            (NfcErrorMap.ndefTagNotWritable, .ndefReaderSessionErrorTagNotWritable),
            (NfcErrorMap.ndefTagUpdateFailure, .ndefReaderSessionErrorTagUpdateFailure),
            (NfcErrorMap.ndefTagSizeTooSmall, .ndefReaderSessionErrorTagSizeTooSmall),
            (NfcErrorMap.ndefZeroLengthMessage, .ndefReaderSessionErrorZeroLengthMessage),
        ]
        for (mine, sdk) in pairs { XCTAssertEqual(mine, sdk.rawValue, "\(sdk)") }
        XCTAssertEqual(NfcErrorMap.ineligible, 7)
        XCTAssertEqual(NfcErrorMap.accessNotAccepted, 8)
    }

    func testTagCommandErrors() {
        XCTAssertEqual(NfcErrorMap.command(nfc(100)).code, .cardGone)
        XCTAssertEqual(NfcErrorMap.command(nfc(104)).code, .cardGone)
        XCTAssertEqual(NfcErrorMap.command(nfc(101)).code, .io)
        XCTAssertEqual(NfcErrorMap.command(nfc(102)).code, .io)
        XCTAssertEqual(NfcErrorMap.command(nfc(105)).code, .invalidArgument)
        XCTAssertEqual(NfcErrorMap.command(nfc(2)).code, .unsupported)
        XCTAssertEqual(NfcErrorMap.command(nfc(400)), NfcError(.cardError, "read-only"))
        XCTAssertEqual(NfcErrorMap.command(nfc(402)), NfcError(.cardError, "too-small"))
        XCTAssertEqual(NfcErrorMap.command(nfc(200)).code, .cancelled)
        // A session that ended takes its reason along: a command cut by the 60 s limit says so.
        XCTAssertEqual(NfcErrorMap.command(nfc(103), sessionEnd: .timeout), NfcErrorMap.error(for: .timeout))
        XCTAssertEqual(NfcErrorMap.command(nfc(103)).code, .cancelled)
        // M5NFC's own errors pass through; anything else is io with its text.
        XCTAssertEqual(NfcErrorMap.command(NfcError.cardGone("x")), NfcError.cardGone("x"))
        XCTAssertEqual(NfcErrorMap.command(NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "boom"])), NfcError(.io, "boom"))
    }

    func testSessionEnds() {
        XCTAssertEqual(NfcErrorMap.sessionEnd(nfc(200)), .userCancelled)
        XCTAssertEqual(NfcErrorMap.sessionEnd(nfc(201)), .timeout)
        XCTAssertEqual(NfcErrorMap.sessionEnd(nfc(203)), .busy)
        if case .unavailable(let why) = NfcErrorMap.sessionEnd(nfc(2)) { XCTAssertTrue(why.contains("entitlement")) } else { XCTFail() }
        if case .unavailable(let why) = NfcErrorMap.sessionEnd(nfc(1)) { XCTAssertTrue(why.contains("no NFC reader")) } else { XCTFail() }
        if case .unavailable = NfcErrorMap.sessionEnd(nfc(6)) {} else { XCTFail() }
        XCTAssertEqual(NfcErrorMap.error(for: .userCancelled).code, .cancelled)
        XCTAssertEqual(NfcErrorMap.error(for: .busy).code, .io)
        XCTAssertTrue(NfcErrorMap.error(for: .timeout).message.contains("60 s"))
    }

    func testSheetTextsComeFromTheDesign() {
        // The design's own keys, the iPhone-only ones falling back to the nearest design key.
        let keys = NfcSheetTexts(KeyTexts())
        XCTAssertEqual(keys.reading, "⟨nfc.model.reading⟩")
        XCTAssertEqual(keys.done, "⟨nfc.model.done⟩")
        XCTAssertEqual(keys.lost, "⟨nfc.model.lost⟩")
        XCTAssertEqual(keys.hold, "⟨nfc.ios.hold⟩")
        let cs = NfcSheetTexts(FixedNfcTexts(strings: ["nfc.model.hold": "Přiložte kartu k telefonu", "nfc.done.writtenBytes": "Zapsáno {0} B",
                                                        "nfc.model.timeout": "Žádná karta do {0} s."]))
        XCTAssertEqual(cs.hold, "Přiložte kartu k telefonu")           // nfc.ios.hold missing → nfc.model.hold
        XCTAssertEqual(cs.written(120), "Zapsáno 120 B")
        XCTAssertEqual(cs.timeout(20), "Žádná karta do 20 s.")
        XCTAssertEqual(cs.multipleTags, "Přiložte kartu k telefonu")
        // No design at all: the default design's English.
        let en = NfcSheetTexts(FixedNfcTexts())
        XCTAssertEqual(en.hold, "Hold the card to the back of your phone")
        XCTAssertEqual(en.multipleTags, "More than one card — hold just one.")
        XCTAssertEqual(en.step(2, 7, "GPO"), "2/7 · GPO")
        XCTAssertEqual(en.failure(.cardGone()), en.lost)
        XCTAssertEqual(en.failure(NfcError(.unsupported, "why")), "why")
        XCTAssertEqual(NfcWriteFailure(.tooSmall, needed: 300, available: 137).text(en), "Too small: needs 300 B, the card holds 137 B.")
        // The app's default provider is M5NFC's chain (NfcTexts.install).
        NfcTexts.install({ $0 == "nfc.model.done" ? "Hotovo" : nil })
        defer { NfcTexts.install(nil) }
        XCTAssertEqual(NfcSheetTexts().done, "Hotovo")
    }
}
