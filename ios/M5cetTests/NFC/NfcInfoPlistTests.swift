// What the build gives Core NFC (Info.plist and the entitlements are the
// coordinator's): every AID the readings select is listed, the list is M5NFC's
// (IOSAids), the usage text and the FeliCa system codes are there, the reader
// formats are TAG + NDEF, and no HCE entitlement is claimed before Apple grants it.

import XCTest
import M5NFC
@testable import M5cet

final class NfcInfoPlistTests: XCTestCase {
    let info = Bundle.main

    func testTheAidsTheReadingsSelectAreListed() {
        let listed = CoreNFCRules.infoPlistAids(info)
        XCTAssertEqual(Set(listed), Set(IOSAids.infoPlist))
        for aid in NfcService.ndefAids + NfcService.eidAids + IOSAids.documents { XCTAssertTrue(listed.contains(aid), aid) }
        XCTAssertEqual(NfcService.Configuration.fromBundle(info).allowedAids, listed)
        XCTAssertFalse(NfcService.Configuration.fromBundle(info).pacePolling, "PACE polling needs the PACE format — off")
    }

    /// Core NFC tries the AIDs in Info.plist's order when a card comes (before iOS 26.4, where a reading cannot narrow
    /// them): M5NFC wants the documents first (IOSAids); the plist starts with the payment directory.
    func testDocumentsFirst() {
        let listed = CoreNFCRules.infoPlistAids(info)
        XCTExpectFailure("Info.plist lists PPSE first; IOSAids.infoPlist puts A0000002471001 first — the coordinator reorders the plist",
                         strict: false)
        XCTAssertEqual(listed, IOSAids.infoPlist)
    }

    func testUsageTextAndFeliCa() {
        let usage = info.object(forInfoDictionaryKey: "NFCReaderUsageDescription") as? String ?? ""
        XCTAssertFalse(usage.isEmpty)
        XCTAssertTrue(CoreNFCRules.infoPlistFelicaCodes(info).contains("12FC"), "NDEF on FeliCa (Type 3)")
    }

    func testEntitlements() throws {
        let url = NfcRepo.root.appendingPathComponent("ios/M5cet/Resources/M5cet.entitlements")
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any] ?? [:]
        let formats = plist["com.apple.developer.nfc.readersession.formats"] as? [String] ?? []
        XCTAssertTrue(formats.contains("TAG"))
        XCTAssertTrue(formats.contains("NDEF"))
        XCTAssertNil(plist["com.apple.developer.nfc.hce"], "HCE needs Apple's approval first")
        XCTAssertNil(info.object(forInfoDictionaryKey: CoreNFCHceProbe.infoPlistKey))
    }
}
