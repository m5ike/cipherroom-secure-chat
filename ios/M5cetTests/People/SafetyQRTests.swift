// The QR code of a safety number as the web's user info makes and reads it
// ("M5CET-SN:1:" + the 60 digits): the payload, what a scan must say to match, and
// the code drawn with CoreImage read back as the same text (what the other phone's
// camera reads). The number itself is Platform/Contacts' Safety (its tests are the
// Android ones, M5cetTests/Contacts).

import M5Crypto
import XCTest
@testable import M5cet

/// The web's safety-number vectors (Node's WebCrypto; Android SafetyTest).
enum PeopleKeys {
    static let a = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4/wYNFBsiKTA3PkVMU1phaG92fYSLkpmgp661vMPK0djf5u30+wIJEBceJSwzOkFIT1ZdZGtyeQ=="
    static let b = "yNXi7/wJFiMwPUpXZHF+i5ilsr/M2ebzAA0aJzRBTltodYKPnKm2w9Dd6vcEER4rOEVSX2x5hpOgrbrH1OHu+wgVIi88SVZjcH2Kl6SxvsvY5fL/DBkmM0BNWg=="
    static let number = "13286 60170 84613 24995 23962 36648 18264 48418 04707 59157 69365 29038"
}

final class SafetyQRTests: XCTestCase {
    func testTheNumberIsTheSameOnBothSidesAndAsTheProtocols() {
        XCTAssertEqual(Safety.number(PeopleKeys.a, PeopleKeys.b), PeopleKeys.number)
        XCTAssertEqual(Safety.number(PeopleKeys.b, PeopleKeys.a), PeopleKeys.number)
        XCTAssertEqual(ChatIdentity.safetyNumber(PeopleKeys.a, PeopleKeys.b), PeopleKeys.number)
    }

    func testThePayloadAsTheWebMakesIt() {
        let payload = SafetyQR.payload(Safety.lines(PeopleKeys.number))
        XCTAssertEqual(payload, "M5CET-SN:1:132866017084613249952396236648182644841804707591576936529038")
        XCTAssertEqual(SafetyQR.digits(payload), String(payload.dropFirst(11)))
        XCTAssertTrue(SafetyQR.matches(payload, number: PeopleKeys.number))
        XCTAssertTrue(SafetyQR.matches(" " + payload + "\n", number: PeopleKeys.number))
        XCTAssertFalse(SafetyQR.matches(payload.replacingOccurrences(of: "29038", with: "29039"), number: PeopleKeys.number))
        XCTAssertFalse(SafetyQR.matches(payload, number: ""))
        XCTAssertNil(SafetyQR.digits("M5CET-SN:2:" + String(payload.dropFirst(11))))
        XCTAssertNil(SafetyQR.digits("https://example.com"))
        XCTAssertEqual(SafetyQR.payload("123"), "")
    }

    @MainActor
    func testTheCodeDrawnReadsBackAsTheSameText() throws {
        let payload = SafetyQR.payload(PeopleKeys.number)
        let image = try XCTUnwrap(SafetyQR.image(payload))
        XCTAssertGreaterThan(image.size.width, 100)
        let read = try XCTUnwrap(SafetyQR.read(image))
        XCTAssertEqual(read, payload)
        XCTAssertTrue(SafetyQR.matches(read, number: PeopleKeys.number))
        XCTAssertNil(SafetyQR.image(""))
    }
}
