// APDU framing for Core NFC: the cases of ISO 7816-4 (short and extended), the
// limits NFCISO7816APDU accepts, the bytes going back out unchanged, and the
// Info.plist rule for SELECT by name — plus the real NFCISO7816APDU built from a
// frame (Core NFC's class exists in the simulator, without a radio).

import CoreNFC
import XCTest
import M5NFC
@testable import M5cet

final class ApduFrameTests: XCTestCase {
    func frame(_ hex: String) throws -> ApduFrame { try ApduFrame.parse(hx(hex)) }

    func testTheFourCasesShortAndExtended() throws {
        var f = try frame("00A4040C")                                         // case 1
        XCTAssertEqual(f.data, []); XCTAssertEqual(f.expectedResponseLength, -1)
        f = try frame("0084000008")                                           // case 2S
        XCTAssertEqual(f.ins, 0x84); XCTAssertEqual(f.expectedResponseLength, 8)
        f = try frame("00B0000000")                                           // Le 00 = 256
        XCTAssertEqual(f.expectedResponseLength, 256)
        f = try frame("00A4040C07A0000002471001")                             // case 3S
        XCTAssertEqual(hexs(f.data), "A0000002471001"); XCTAssertEqual(f.expectedResponseLength, -1); XCTAssertTrue(f.selectsByName)
        f = try frame("00A404000E325041592E5359532E444446303100")             // case 4S
        XCTAssertEqual(f.data.count, 14); XCTAssertEqual(f.expectedResponseLength, 256)
        f = try frame("00B0000000FFFF")                                       // case 2E
        XCTAssertTrue(f.extended); XCTAssertEqual(f.expectedResponseLength, 65_535)
        f = try frame("00B0000000" + "0000")                                  // case 2E, Le 0000 = 65 536
        XCTAssertEqual(f.expectedResponseLength, 65_536)
        let big = [UInt8](repeating: 0xab, count: 300)
        f = try ApduFrame.parse(hx("00DA0000") + [0x00, 0x01, 0x2c] + big)    // case 3E
        XCTAssertEqual(f.data, big); XCTAssertEqual(f.expectedResponseLength, -1)
        f = try ApduFrame.parse(hx("00860000") + [0x00, 0x01, 0x2c] + big + [0x00, 0x00]) // case 4E
        XCTAssertEqual(f.data.count, 300); XCTAssertEqual(f.expectedResponseLength, 65_536)
    }

    func testMalformedApdusAreRefused() {
        for bad in ["00A404", "00A4040C05A000", "00A4040C02A00000AA", "00B000000000", "00B00000000002AA"] {
            XCTAssertThrowsError(try frame(bad), bad)
        }
        // An extended Lc of 0 is not a command.
        XCTAssertThrowsError(try ApduFrame.parse(hx("00D6000000000000")))
    }

    func testTheBytesGoBackOutAsTheyCame() throws {
        for hex in ["00A4040C", "0084000008", "00B0000000", "00A4040C07A0000002471001", "00A404000E325041592E5359532E444446303100",
                    "00B0000000FFFF", "00B00000000000", "0CB000000D9701008E08F4B0A5B2C1D2E3F400"] {
            XCTAssertEqual(hexs(try frame(hex).bytes), hex)
        }
        let big = hx("00DA0000") + [0x00, 0x01, 0x2c] + [UInt8](repeating: 1, count: 300) + [0x00, 0x00]
        XCTAssertEqual(try ApduFrame.parse(big).bytes, big)
    }

    func testCoreNFCGetsTheFields() throws {
        let f = try frame("00A404000E325041592E5359532E444446303100")
        let a = CoreNFCTag.apdu(f)
        XCTAssertEqual(a.instructionClass, 0x00)
        XCTAssertEqual(a.instructionCode, 0xa4)
        XCTAssertEqual(a.p1Parameter, 0x04)
        XCTAssertEqual(a.p2Parameter, 0x00)
        XCTAssertEqual(a.data.map { [UInt8]($0) }, latin("2PAY.SYS.DDF01"))
        XCTAssertEqual(a.expectedResponseLength, 256)
        XCTAssertEqual(CoreNFCTag.apdu(try frame("00A4040C07A0000002471001")).expectedResponseLength, -1)
        XCTAssertEqual(CoreNFCTag.apdu(try frame("00B00000000000")).expectedResponseLength, 65_536)
    }

    func testSelectByNameOnlyOfListedApplications() throws {
        let listed = IOSAids.infoPlist
        XCTAssertNil(CoreNFCRules.selectRefusal(try frame("00A4040C07A0000002471001"), allowed: listed))
        XCTAssertNil(CoreNFCRules.selectRefusal(try frame("00A4040007D276000085010100"), allowed: listed))
        // A partial AID (prefix of a listed one) and a longer one (a listed prefix) go — Core NFC decides.
        XCTAssertNil(CoreNFCRules.selectRefusal(try frame("00A4040005A000000247"), allowed: listed))
        // An application that is not listed is stopped before the card, with the AID in words.
        let why = CoreNFCRules.selectRefusal(try frame("00A4040C06F00102030405"), allowed: listed)
        XCTAssertNotNil(why)
        XCTAssertTrue(why!.contains("F00102030405"))
        // Only SELECT by name: a file id, a READ, anything else is not checked.
        XCTAssertNil(CoreNFCRules.selectRefusal(try frame("00A4000C023F00"), allowed: listed))
        XCTAssertNil(CoreNFCRules.selectRefusal(try frame("00B0000000"), allowed: listed))
        // No list (a build without the key): Core NFC itself answers.
        XCTAssertNil(CoreNFCRules.selectRefusal(try frame("00A4040C06F00102030405"), allowed: []))
    }

    func testDiscoveryAidsAreTheListedOnesInTheListsOrder() {
        let listed = ["325041592E5359532E4444463031", "A0000002471001", "D2760000850101", "D2760000850100"]
        XCTAssertEqual(CoreNFCRules.discoveryAids(["d2760000850101", "A0000002471001", "FFFF"], allowed: listed), ["A0000002471001", "D2760000850101"])
        XCTAssertEqual(CoreNFCRules.discoveryAids([], allowed: listed), [])
    }

    func testType2Capacity() {
        XCTAssertEqual(CoreNFCTransport.t2Capacity(getVersion: hx("0004040201000F03")), 144)
        XCTAssertEqual(CoreNFCTransport.t2Capacity(getVersion: hx("0004040201001103")), 504)
        XCTAssertEqual(CoreNFCTransport.t2Capacity(getVersion: hx("0004040201001303")), 888)
        XCTAssertEqual(CoreNFCTransport.t2Capacity(getVersion: nil), 48)
    }
}
