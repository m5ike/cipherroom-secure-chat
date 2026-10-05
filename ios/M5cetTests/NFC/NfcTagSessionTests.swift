// The reading session with a fake Core NFC (FakeDriver, FakeTag): the sheet's
// texts, a card found and connected, its identity and capabilities, APDUs passed
// through raw (61xx / 6Cxx are M5NFC's, and M5NFC's transmitSmart resolves them
// over this transport), "multiple tags" and "not this card" polling again, the
// person closing the sheet, iOS's timeout, the card leaving, a cancelled task —
// every command waiting on Core NFC ends, none hangs.

import XCTest
import M5NFC
@testable import M5cet

final class NfcTagSessionTests: XCTestCase {
    static let ndefAid = "D2760000850101"

    func isoTag(_ chip: SimChip = IsoSim(), aid: String = ndefAid, hb: [UInt8]? = nil) -> FakeTag {
        let t = FakeTag(.iso7816(initialSelectedAid: aid, historicalBytes: hb, applicationData: nil, supportsPace: false))
        t.chip = chip
        return t
    }

    func testACardIsFoundConnectedAndTalkedTo() async throws {
        let rig = NfcRig(), chip = IsoSim(), tag = isoTag(chip)
        rig.present(tag)
        let session = makeNfcSession(rig)
        let t = try await session.waitForCard(timeout: .seconds(5))
        XCTAssertEqual(t.identity.uid, "04A23B11223380")
        XCTAssertEqual(t.identity.tech, NfcCatalog.ndef)
        XCTAssertEqual(t.identity.selectedAid, Self.ndefAid)
        // The raw answer: 61xx is the reader's to follow, as on Android.
        let v1 = try await t.transmit(hx("00A4020C022F00")); XCTAssertEqual(hexs(v1), "9000")
        let v2 = try await t.transmit(hx("00B2010400")); XCTAssertEqual(hexs(v2), String(format: "61%02X", NfcSim.dir1.count))
        // M5NFC's transmitSmart over this transport: GET RESPONSE, then the record.
        let r = try await Apdu.transmitSmart(t, hx("00B2010400"))
        XCTAssertEqual(r.data, NfcSim.dir1); XCTAssertEqual(r.sw, 0x9000)
        XCTAssertEqual(chip.seen.suffix(2), ["00B2010400", String(format: "00C00000%02X", NfcSim.dir1.count)])
        // 6Cxx: the command again with the Le the card asked for.
        _ = try await t.transmit(hx("00A4020C022F01"))
        let atr = try await Apdu.transmitSmart(t, hx("00B0000000"))
        XCTAssertEqual(atr.data, NfcSim.atr)
        XCTAssertEqual(chip.seen.suffix(2), ["00B0000000", String(format: "00B00000%02X", NfcSim.atr.count)])
        await session.succeed("DONE")
        let d = try XCTUnwrap(rig.last)
        await rig.wait { d.invalidations.count == 1 }
        XCTAssertEqual(d.invalidations, [nil])
        XCTAssertEqual(d.alertMessage, "DONE")
        let alerts = await session.alerts
        XCTAssertEqual(alerts, ["HOLD", "⟨nfc.model.reading⟩", "DONE"])
        // After the end: nothing more goes to the card.
        do { _ = try await t.transmit(hx("00B0000000")); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cancelled) }
    }

    func testCapabilitiesAreTheTagsWithinTheIphones() async throws {
        let rig = NfcRig()
        let ul = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        ul.mifare = { f in
            if f == [0x60] { return hx("0004040201000F03") }             // NTAG213
            if f.first == 0x30 { return [UInt8](repeating: f[1], count: 16) }
            throw NSError(domain: "NFCError", code: 102)
        }
        rig.present(ul)
        let session = makeNfcSession(rig)
        let t = try await session.waitForCard(timeout: .seconds(5))
        XCTAssertEqual(t.identity.tech, NfcCatalog.ntag21x)
        XCTAssertEqual(t.identity.memory, "144 / 504 / 888 B")
        XCTAssertTrue(t.capabilities.contains(.mifareUltralight))
        XCTAssertTrue(t.capabilities.contains(.ndefWrite))
        XCTAssertFalse(t.capabilities.contains(.iso7816))
        for never: NfcCapabilities in [.mifareClassic, .rawFrames, .paymentAids, .emulation] { XCTAssertFalse(t.capabilities.contains(never)) }
        let page4 = try await t.mifareCommand([0x30, 0x04])
        XCTAssertEqual(page4, [UInt8](repeating: 4, count: 16))
        do { _ = try await t.transmit(hx("00A4040C07A0000002471001")); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .unsupported) }
        do { _ = try await t.rawFrame([0x40]); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .unsupported) }
        // ModelNfc sees it as Android does: not an ISO-DEP card.
        let card = TransportCard(t, identity: t.identity)
        let isoDep = try await card.isoDep()
        XCTAssertNil(isoDep)
        let pages = try await CardOps.ultralightRead(t, maxPage: 8)
        XCTAssertEqual(pages.optInt("pageCount"), 8)
        await session.succeed()
    }

    func testIso7816CardsAutoSelectAndDesfireTalksIsoWrapped() async throws {
        let rig = NfcRig()
        rig.present(isoTag(aid: "A0000002471001"))
        let s1 = makeNfcSession(rig)
        let t = try await s1.waitForCard(timeout: .seconds(5))
        XCTAssertEqual(t.identity.tech, NfcCatalog.eid)
        XCTAssertTrue(t.capabilities.isSuperset(of: [.iso7816, .autoSelectsAid, .ndefRead]))
        XCTAssertFalse(t.capabilities.contains(.mifareUltralight))
        await s1.succeed()

        let df = FakeTag(.miFare(family: "desfire", historicalBytes: hx("75778102 80".replacingOccurrences(of: " ", with: ""))))
        let chip = DesfireSim()
        df.chip = chip
        rig.present(df)
        let s2 = makeNfcSession(rig)
        let d = try await s2.waitForCard(timeout: .seconds(5))
        XCTAssertEqual(d.identity.tech, NfcCatalog.mifareDesfire)
        XCTAssertTrue(d.capabilities.isSuperset(of: [.iso7816, .desfire]))
        XCTAssertFalse(d.capabilities.contains(.autoSelectsAid))
        let info = try await Desfire.readInfo(d)
        XCTAssertEqual(info.strings("applications").count, 2)
        XCTAssertEqual(chip.seen.first, "9060000000")
        await s2.succeed()
    }

    func testMultipleTagsAndTheWrongCardMakeItLookAgain() async throws {
        let rig = NfcRig()
        let a = isoTag(), b = isoTag(aid: "A0000002471001")
        let ul = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        var round = 0
        rig.onBegin = { $0.detect([a, b]) }
        rig.onRestart = { d in
            round += 1
            d.detect(round == 1 ? [ul] : [b])   // then a card this reading does not take, then the right one
        }
        let session = makeNfcSession(rig)
        let t = try await session.waitForCard(timeout: .seconds(5), accept: NfcService.iso7816Only)
        XCTAssertEqual(t.identity.tech, NfcCatalog.eid)
        let d = try XCTUnwrap(rig.last)
        XCTAssertEqual(d.restarts, 2)
        let alerts = await session.alerts
        XCTAssertEqual(alerts, ["HOLD", "⟨nfc.ios.multipleTags⟩", "HOLD", "⟨nfc.model.notThisCard⟩", "HOLD", "⟨nfc.model.reading⟩"])
        await session.succeed()
    }

    func testThePersonClosingTheSheetCancels() async throws {
        let rig = NfcRig()
        rig.onBegin = { d in DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { d.systemInvalidate(200) } }
        let session = makeNfcSession(rig)
        do { _ = try await session.waitForCard(timeout: .seconds(5)); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cancelled) }
        let end = await session.end
        XCTAssertEqual(end, .userCancelled)
        XCTAssertEqual(rig.last?.invalidations, [])   // the system closed it; the app did not have to
    }

    func testNoCardInTimeEndsWithTheTimeoutText() async throws {
        let rig = NfcRig()
        let session = makeNfcSession(rig)
        do { _ = try await session.waitForCard(timeout: .seconds(1)); XCTFail() } catch let e as NfcError { XCTAssertEqual(e, NfcTagSession.noCard(1)) }
        let d = try XCTUnwrap(rig.last)
        XCTAssertEqual(d.invalidations, ["⟨nfc.model.timeout⟩"])
    }

    func testIosEndingTheSessionFailsTheCommandThatWaits() async throws {
        let rig = NfcRig(), tag = isoTag()
        rig.present(tag)
        let session = makeNfcSession(rig)
        let t = try await session.waitForCard(timeout: .seconds(5))
        tag.hang = true
        async let answer = t.transmit(hx("00B0000000"))
        try await Task.sleep(for: .milliseconds(50))
        rig.last?.systemInvalidate(201)                                     // the 60 s limit
        do { _ = try await answer; XCTFail() } catch let e as NfcError { XCTAssertEqual(e, NfcErrorMap.error(for: .timeout)) }
        XCTAssertEqual(session.pending.count, 0)
    }

    func testACancelledTaskEndsTheSessionAndItsCommands() async throws {
        let rig = NfcRig(), tag = isoTag()
        rig.present(tag)
        let session = makeNfcSession(rig)
        let t = try await session.waitForCard(timeout: .seconds(5))
        tag.hang = true
        let task = Task { try await t.transmit(hx("00B0000000")) }
        try await Task.sleep(for: .milliseconds(50))
        task.cancel()
        do { _ = try await task.value; XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cancelled) }
        await rig.wait { rig.last?.invalidations.count == 1 }
        XCTAssertEqual(rig.last?.invalidations, [nil])                       // closed quietly
        XCTAssertEqual(session.pending.count, 0)
        // Waiting for a card is cancelled the same way.
        let rig2 = NfcRig()
        let s2 = makeNfcSession(rig2)
        let wait = Task { try await s2.waitForCard(timeout: nil) }
        try await Task.sleep(for: .milliseconds(50))
        wait.cancel()
        do { _ = try await wait.value; XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cancelled) }
    }

    func testTheCardLeavingIsCardGoneAndAModelHearsNoCard() async throws {
        let rig = NfcRig(), tag = isoTag(aid: "A0000002471001")
        rig.present(tag)
        let session = makeNfcSession(rig)
        let t = try await session.waitForCard(timeout: .seconds(5))
        tag.leave()
        do { _ = try await t.transmit(hx("00B0000000")); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cardGone) }
        let c = ModelNfc.parse(["command": ["op": "eid-public"]])
        let r = await ModelNfc.run(c, TransportCard(t, identity: t.identity))
        XCTAssertEqual(r.optString("status"), "no-card")
    }

    func testConnectFailures() async throws {
        // Lost while connecting: polling again, then the card.
        let rig = NfcRig(), tag = isoTag()
        rig.onBegin = { d in d.connectError = NSError(domain: "NFCError", code: 100); d.detect([tag]) }
        rig.onRestart = { d in d.connectError = nil; d.detect([tag]) }
        let s = makeNfcSession(rig)
        _ = try await s.waitForCard(timeout: .seconds(5))
        XCTAssertEqual(rig.last?.restarts, 1)
        await s.succeed()
        // Refused (an AID Info.plist lacks, …): the sheet ends with the reason.
        let rig2 = NfcRig()
        rig2.onBegin = { d in d.connectError = NSError(domain: "NFCError", code: 2); d.detect([tag]) }
        let s2 = makeNfcSession(rig2)
        do { _ = try await s2.waitForCard(timeout: .seconds(5)); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .unsupported) }
        XCTAssertEqual(rig2.last?.invalidations.count, 1)
        XCTAssertNotNil(rig2.last?.invalidations.first ?? nil)
    }

    func testNoReaderNoSession() async {
        let rig = NfcRig()
        rig.noReader = true
        let s = makeNfcSession(rig)
        do { _ = try await s.waitForCard(timeout: .seconds(1)); XCTFail() } catch let e as NfcError {
            XCTAssertEqual(e.code, .unsupported)
            XCTAssertTrue(e.message.contains("no NFC reader"))
        } catch { XCTFail("\(error)") }
    }

    func testAnotherCardInTheSameSessionMakesTheOldTransportStale() async throws {
        let rig = NfcRig(), tag = isoTag()
        rig.present(tag)
        rig.onRestart = { $0.detect([tag]) }
        let s = makeNfcSession(rig)
        let first = try await s.waitForCard(timeout: .seconds(5))
        let second = try await s.waitForCard(timeout: .seconds(5))   // "hold the card again" (a one-time record)
        do { _ = try await first.transmit(hx("00A4020C022F00")); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cardGone) }
        let v3 = try await second.transmit(hx("00A4020C022F00")); XCTAssertEqual(hexs(v3), "9000")
        await s.succeed()
    }

    func testCompletionsOnAnotherThreadAndUnlistedSelects() async throws {
        let rig = NfcRig(), tag = isoTag()
        tag.delay = 0.005
        rig.present(tag)
        let s = makeNfcSession(rig, aids: ["D2760000850101"])
        let t = try await s.waitForCard(timeout: .seconds(5))
        for _ in 0..<20 { let v4 = try await t.transmit(hx("00A4020C022F00")); XCTAssertEqual(hexs(v4), "9000") }
        // SELECT of an application the build does not list: refused before the card, the session goes on.
        do { _ = try await t.transmit(hx("00A4040C07A0000000041010")); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .unsupported) }
        XCTAssertFalse(tag.apdus.contains("00A4040C07A0000000041010"))
        do { _ = try await t.transmit([0x00, 0xa4]); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .invalidArgument) }
        let v5 = try await t.transmit(hx("00A4020C022F00")); XCTAssertEqual(hexs(v5), "9000")
        await s.succeed()
    }

    func testPendingCallsAreResumedOnce() {
        let p = PendingCalls()
        let failed = LockedBox(0)
        let a = p.add { _ in failed.update { $0 += 1 } }
        let b = p.add { _ in failed.update { $0 += 1 } }
        XCTAssertTrue(p.take(a))
        XCTAssertFalse(p.take(a))
        p.failAll(NfcError(.cancelled, "x"))
        XCTAssertFalse(p.take(b))
        p.failAll(NfcError(.cancelled, "x"))
        XCTAssertEqual(failed.value, 1)
        XCTAssertEqual(p.count, 0)
    }
}

final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func update(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}
