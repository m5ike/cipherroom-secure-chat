// Card emulation (Android CardService → Core NFC CardSession): the gate — built
// with HCE, supported, eligible, an iPhone — and what the UI hears when it is
// closed (M5NFC's limit reason; `.emulation` stays out of the capabilities); the
// APDU answers a reader gets (M5NFC's Type4TagEmulator) and when a reader has read
// the whole card. No CardSession is started here: the simulator has none, and
// this build has no HCE entitlement.

import XCTest
import M5NFC
@testable import M5cet

@MainActor
final class NfcCardEmulationTests: XCTestCase {
    static let reason = "Card emulation needs the HCE entitlement (Core NFC CardSession) — not available on this device."

    func testTheGate() async {
        let closed = HceAvailability.unavailable(Self.reason)
        let off = await HceCheck.availability(FakeHce(configured: false, supported: true, isEligible: true), readingAvailable: true)
        XCTAssertEqual(off, closed)
        let unsupported = await HceCheck.availability(FakeHce(configured: true, supported: false, isEligible: true), readingAvailable: true)
        XCTAssertEqual(unsupported, closed)
        let ineligible = await HceCheck.availability(FakeHce(configured: true, supported: true, isEligible: false), readingAvailable: true)
        XCTAssertEqual(ineligible, closed)
        let open = await HceCheck.availability(FakeHce(configured: true, supported: true, isEligible: true), readingAvailable: true)
        XCTAssertEqual(open, .available)
        let ipad = await HceCheck.availability(FakeHce(configured: true, supported: true, isEligible: true), readingAvailable: false)
        XCTAssertEqual(ipad, .unavailable("This device has no NFC reader (iPad and Apple Watch have none)."))
    }

    func testCapabilitiesFollowTheGate() async throws {
        let s = makeNfcService(NfcRig(), hce: FakeHce(configured: true, supported: true, isEligible: true))
        XCTAssertFalse(s.capabilities.contains(.emulation), "unknown until checked")
        await s.refreshEmulation()
        XCTAssertTrue(s.capabilities.contains(.emulation))
        XCTAssertNil(s.limit(op: "conn-emulate", tech: NfcCatalog.connectionTag))
        XCTAssertTrue(s.ops(for: NfcCatalog.m5cetCard).contains { $0.id == "m5-emulate" })

        let without = makeNfcService(NfcRig())
        await without.refreshEmulation()
        XCTAssertFalse(without.capabilities.contains(.emulation))
        XCTAssertEqual(without.limit(op: "m5-emulate", tech: NfcCatalog.m5cetCard), Self.reason)
        XCTAssertFalse(without.ops(for: NfcCatalog.m5cetCard).contains { $0.id == "m5-emulate" })
        // Asked anyway: the reason, and nothing started.
        do { _ = try await without.emulateConnection("m5cet:nfc:v2:{}"); XCTFail() } catch let e as NfcError {
            XCTAssertEqual(e, NfcError.unsupported(Self.reason))
        }
        XCTAssertFalse(without.emulation.serving)
        // A model never emulates.
        if case .answer(let r) = without.modelPlan(["command": ["op": "conn-emulate"]]) { XCTAssertEqual(r.optString("status"), "denied") } else { XCTFail() }
    }

    func testThisBuildAndTheSimulatorHaveNoHce() async {
        let probe = CoreNFCHceProbe()
        XCTAssertFalse(probe.configured, "Info.plist has no HCE AID until Apple grants the entitlement")
        XCTAssertFalse(probe.supported)
        let a = await HceCheck.availability(probe, readingAvailable: CoreNFCSessionDriver.readingAvailable)
        XCTAssertFalse(a.isAvailable)
    }

    func testAReaderReadsTheConnectionTagOffThePhone() throws {
        let body = "m5cet:nfc:v2:{\"v\":2,\"t\":\"inv\",\"o\":\"https://chat.example.org\",\"id\":\"QEFCQ0RFRkdISUpLTE1OTw\",\"k\":\"0123456789ABCDEFGHJKMNPQRS\"}"
        var r = HceResponder(try Type4TagEmulator.connection(body))
        func send(_ hex: String) -> [UInt8] { r.process(hx(hex)) }
        XCTAssertEqual(hexs(send("00A4040007D276000085010100")), "9000")       // the NDEF application
        XCTAssertEqual(hexs(send("00A4000C02E103")), "9000")                   // the CC
        let cc = send("00B000000F")
        XCTAssertEqual(Array(cc.suffix(2)), [0x90, 0x00])
        XCTAssertEqual(Array(cc[9..<11]), [0xe1, 0x04])
        XCTAssertFalse(r.served)
        XCTAssertEqual(hexs(send("00A4000C02E104")), "9000")                   // the NDEF file
        let nlen = send("00B0000002")
        let n = Int(nlen[0]) << 8 | Int(nlen[1])
        var message = [UInt8](), offset = 2
        while message.count < n {
            let le = min(0x3b, n - message.count)
            let chunk = send(String(format: "00B0%04X%02X", offset, le))
            XCTAssertEqual(Array(chunk.suffix(2)), [0x90, 0x00])
            message += chunk.dropLast(2)
            offset += le
        }
        XCTAssertTrue(r.served)
        XCTAssertEqual(ConnectionCard.body(of: try Ndef.decodeMessage(message)), body)
        // Nothing is writable; another application is not here.
        XCTAssertEqual(hexs(send("00D6000004DEADBEEF")), "6D00")
        XCTAssertEqual(hexs(send("00A4040007A000000003101000")), "6A82")
        r.deactivated()
        XCTAssertEqual(hexs(send("00B0000002")), "6A82")                        // after deselection: select again
    }
}
