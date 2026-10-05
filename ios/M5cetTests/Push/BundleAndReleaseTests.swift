// The design bundle store (Android update/Bundles) with the server's own bundle
// file, the release notice (update/Releases on iOS: records, no install), the
// VoIP invite opener and the APNs environment.

import CryptoKit
import Foundation
import M5Design
import M5Net
import XCTest
@testable import M5cet

@MainActor
final class DesignBundleStoreTests: XCTestCase {
    private let id = PushFixtures.ios.str("buildId")
    private var offer: BundleOffer { BundleOffer(PushFixtures.ios.obj("checkin")!.obj("bundle")!) }
    private var keys: DesignBundleStore.Keys { .init(serverKey: PushFixtures.serverKey, serverKid: PushFixtures.serverKid, deviceId: PushFixtures.deviceId) }
    private var fetch: DesignBundleStore.Fetch { { _, progress in
        let d = Data(base64Encoded: PushFixtures.ios.str("bundleFile"))!
        progress(Int64(d.count), Int64(d.count))
        return d
    } }

    private func store(_ storage: MemoryBundleStorage, now: Double = 1_000) -> (DesignBundleStore, Holder) {
        let s = DesignBundleStore(storage: storage, crypto: DeviceBundleCrypto(opener: KeyringEciesOpener(agreement: FixtureAgreement())), appCode: 61400,
                                  now: { now })
        s.builtIn = { nil }
        let events = Holder()
        s.event = { type, _ in events.types.append(type) }
        return (s, events)
    }

    final class Holder { var types: [String] = [] }

    func testABundleIsStagedTriedAndConfirmed() async throws {
        let storage = MemoryBundleStorage()
        let (s, events) = store(storage)
        await s.offer(offer, autoDownload: true, wifiOnly: false, unmetered: true, fetch: fetch, keys: keys)
        XCTAssertEqual(s.download, .ready)
        XCTAssertEqual(s.stagedVersion, "6.14.0-b1")
        XCTAssertEqual(storage.ledger.staged, id)
        XCTAssertNil(s.design, "staged, not used before the next start")
        XCTAssertEqual(events.types, ["update-available"])

        // The next start: the staged bundle is the trial.
        let (s2, events2) = store(storage)
        s2.trialDuration = .seconds(3600)
        let design = s2.loadActive()
        XCTAssertNotNil(design)
        XCTAssertEqual(s2.activeId, id)
        XCTAssertTrue(s2.onTrial)
        XCTAssertEqual(s2.report.str("state"), "trial")
        XCTAssertEqual(storage.trial.0, id)
        XCTAssertEqual(storage.trial.1, 1)
        let revision = s2.revision
        // 20 s without a crash: good.
        s2.confirmTrial()
        XCTAssertFalse(s2.onTrial)
        XCTAssertEqual(storage.ledger.active, id)
        XCTAssertEqual(storage.ledger.good, [id])
        XCTAssertEqual(s2.report.str("state"), "good")
        XCTAssertEqual(events2.types, ["bundle-installed"])
        XCTAssertEqual(s2.revision, revision, "confirming changes nothing on screen")
        // A later start uses it.
        let (s3, _) = store(storage)
        XCTAssertNotNil(s3.loadActive())
        XCTAssertEqual(s3.activeId, id)
        XCTAssertFalse(s3.onTrial)
        // The same offer is not fetched again.
        let fetched = Flag()
        await s3.offer(offer, autoDownload: true, wifiOnly: false, unmetered: true, fetch: { _, _ in fetched.set(); return Data() }, keys: keys)
        XCTAssertFalse(fetched.value)
    }

    func testAScreenThatFailsRollsTheTrialBack() async {
        let storage = MemoryBundleStorage()
        let (s, _) = store(storage)
        await s.offer(offer, autoDownload: true, wifiOnly: false, unmetered: true, fetch: fetch, keys: keys)
        let (s2, events) = store(storage)
        s2.trialDuration = .seconds(3600)
        s2.loadActive()
        var told: [String] = []
        s2.onRolledBack = { told.append($0) }
        var seen: [Bool] = []
        s2.onChange { seen.append($0 == nil) }
        XCTAssertTrue(s2.renderFailed(screen: "rooms", message: "bad node"))
        XCTAssertNil(s2.design, "back to the built-in design")
        XCTAssertEqual(s2.activeId, "")
        XCTAssertEqual(storage.ledger.items[id]?.state, "failed")
        XCTAssertEqual(told, [id])
        XCTAssertEqual(seen, [true])
        XCTAssertEqual(events.types, ["bundle-rollback"])
        // A failed bundle is not fetched again.
        XCTAssertFalse(storage.ledger.shouldFetch(id: id, minAppCode: 61400, appCode: 61400, activeId: ""))
    }

    func testATrialThatNeverReachesItsTimeCountsAsACrash() async {
        let storage = MemoryBundleStorage()
        let (s, _) = store(storage)
        await s.offer(offer, autoDownload: true, wifiOnly: false, unmetered: true, fetch: fetch, keys: keys)
        for start in 1...DesignBundleStore.crashStarts {
            let (st, _) = store(storage)
            st.trialDuration = .seconds(3600)
            st.loadActive()
            XCTAssertEqual(st.activeId, id, "start \(start)")
        }
        let (last, events) = store(storage)
        last.loadActive()
        XCTAssertEqual(last.activeId, "", "the fourth start rolls back")
        XCTAssertEqual(storage.ledger.items[id]?.state, "failed")
        XCTAssertEqual(events.types, ["bundle-rollback"])
    }

    func testBundlesThatDoNotCheckOutAreRefused() async {
        let storage = MemoryBundleStorage()
        let (s, events) = store(storage)
        // Another kid than the pinned key's.
        await s.offer(offer, autoDownload: true, wifiOnly: false, unmetered: true, fetch: fetch,
                      keys: .init(serverKey: PushFixtures.serverKey, serverKid: "AAAAAAAAAAAAAAAA", deviceId: PushFixtures.deviceId))
        XCTAssertEqual(s.download, .failed)
        XCTAssertEqual(storage.ledger.items[id]?.state, "failed")
        XCTAssertEqual(storage.ledger.items[id]?.error, "the bundle's signature is not the server's")
        XCTAssertEqual(events.types, ["update-available", "bundle-failed"])
        XCTAssertTrue(storage.files.isEmpty)
        // Not for this device.
        let storage2 = MemoryBundleStorage()
        let (s2, _) = store(storage2)
        await s2.offer(offer, autoDownload: true, wifiOnly: false, unmetered: true, fetch: fetch,
                       keys: .init(serverKey: PushFixtures.serverKey, serverKid: PushFixtures.serverKid, deviceId: "ios_other"))
        XCTAssertEqual(storage2.ledger.items[id]?.error, "the bundle is not encrypted for this device")
        // A newer app needed: not even fetched.
        let storage3 = MemoryBundleStorage()
        let old = DesignBundleStore(storage: storage3, crypto: DeviceBundleCrypto(opener: KeyringEciesOpener(agreement: FixtureAgreement())), appCode: 61300)
        let fetched = Flag()
        await old.offer(offer, autoDownload: true, wifiOnly: false, unmetered: true, fetch: { _, _ in fetched.set(); return Data() }, keys: keys)
        XCTAssertFalse(fetched.value)
    }

    func testThePolicyCanHoldTheDownload() async {
        let storage = MemoryBundleStorage()
        let (s, _) = store(storage)
        await s.offer(offer, autoDownload: true, wifiOnly: true, unmetered: false, fetch: fetch, keys: keys)
        XCTAssertEqual(s.download, .available)
        XCTAssertEqual(s.scope["state"] as? String, "none")
        await s.download(offer, fetch: fetch, keys: keys)
        XCTAssertEqual(s.download, .ready)
        XCTAssertEqual(s.scope["state"] as? String, "ready")
        XCTAssertEqual(s.scope["progress"] as? Double, 1)
    }

    func testTheVaultKeepsTheContentSealed() async throws {
        let fx = try Fixture()
        let storage = VaultBundleStorage(vault: fx.vault)
        try storage.keep("ibld_x", content: Data("plain".utf8))
        let file = fx.vault.paths.root.appendingPathComponent("bundles/ibld_x.bin")
        let sealed = try Data(contentsOf: file)
        XCTAssertFalse(sealed.range(of: Data("plain".utf8)) != nil, "never in the clear")
        XCTAssertEqual(try storage.content("ibld_x"), Data("plain".utf8))
        XCTAssertEqual(storage.keptIds(), ["ibld_x"])
        var l = BundleLedger()
        l.staged(id: "ibld_x", version: "1", number: 1, now: 1)
        storage.saveLedger(l)
        XCTAssertEqual(storage.loadLedger(), l)
        storage.removeAll()
        XCTAssertTrue(storage.keptIds().isEmpty)
        XCTAssertEqual(storage.loadLedger(), BundleLedger())
    }
}

@MainActor
final class UpdateNoticeTests: XCTestCase {
    private func record(_ id: String, build: Int64, minBuild: Int64 = 0, mandatory: Bool = false, url: String = "https://apps.apple.com/app/m5cet/id1") -> ReleaseRecord {
        ReleaseRecord(["id": .string(id), "version": "6.15.0", "build": .int(build), "bundleId": "cz.m5cet.app", "channel": "stable", "store": "appstore",
                       "url": .string(url), "notes": ["cs": "Rychlejší", "en": "Faster"], "minBuild": .int(minBuild), "rollout": 100, "mandatory": .bool(mandatory)])
    }

    func testANewerVersionIsAnnouncedOnceAndOfferedWhenVerified() {
        let u = UpdateNotice(currentBuild: 61400)
        var announced: [String] = []
        u.onNewRelease.append { announced.append($0.id) }
        u.onCheckin(release: record("r1", build: 61500), minBuild: 0, updateRequired: false)
        u.onCheckin(release: record("r1", build: 61500), minBuild: 0, updateRequired: false)
        XCTAssertEqual(announced, ["r1"])
        XCTAssertEqual(u.state, .available)
        XCTAssertNil(u.storeURL, "only a verified record's link is opened")
        XCTAssertFalse(u.mandatory)
        u.verified(record("r1", build: 61500))
        XCTAssertEqual(u.state, .ready)
        XCTAssertEqual(u.storeURL?.host, "apps.apple.com")
        let scope = u.scope(lang: "cs")
        XCTAssertEqual(scope["notes"] as? String, "Rychlejší")
        XCTAssertEqual(scope["state"] as? String, "ready")
        XCTAssertEqual(scope["kind"] as? String, "release")
        // Not newer: nothing.
        u.onCheckin(release: record("r0", build: 61400), minBuild: 0, updateRequired: false)
        XCTAssertFalse(u.available)
        XCTAssertEqual(u.state, .none)
    }

    func testBelowTheMinimumTheAppMustUpdate() {
        let u = UpdateNotice(currentBuild: 61400)
        u.onCheckin(release: nil, minBuild: 61500, updateRequired: false)
        XCTAssertTrue(u.mandatory)
        u.onCheckin(release: nil, minBuild: 0, updateRequired: true)
        XCTAssertTrue(u.mandatory, "the server's verdict")
        u.onCheckin(release: record("r2", build: 61600, minBuild: 61450), minBuild: 0, updateRequired: false)
        XCTAssertTrue(u.mandatory, "the release's minimum")
        u.onCheckin(release: record("r3", build: 61600, mandatory: true), minBuild: 0, updateRequired: false)
        XCTAssertTrue(u.mandatory)
        u.onCheckin(release: record("r4", build: 61600), minBuild: 0, updateRequired: false)
        XCTAssertFalse(u.mandatory)
        u.noteMinBuild(61401)
        XCTAssertTrue(u.mandatory, "/info's or the enrolment's minimum")
    }

    func testOnlyApplesStoresAreOpened() {
        let u = UpdateNotice(currentBuild: 61400)
        u.onCheckin(release: record("r1", build: 61500, url: "https://evil.example.com/app"), minBuild: 0, updateRequired: false)
        u.verified(record("r1", build: 61500, url: "https://evil.example.com/app"))
        XCTAssertNil(u.storeURL)
        u.onCheckin(release: record("r2", build: 61500, url: "https://testflight.apple.com/join/abc"), minBuild: 0, updateRequired: false)
        u.verified(record("r2", build: 61500, url: "https://testflight.apple.com/join/abc"))
        XCTAssertEqual(u.storeURL?.host, "testflight.apple.com")
        u.verificationFailed()
        XCTAssertNil(u.storeURL)
    }
}

@MainActor
final class VoIPInviteOpenerTests: XCTestCase {
    func testCallInvitesInBothForms() throws {
        let server = TestControlServer()
        let rig = DeviceRig(clock: 1_800_000_000_000)
        rig.store.saveNow("config", DeviceState(server: PushFixtures.base, deviceId: "ios_test0001", serverKey: server.spki, serverKid: server.kid).json)
        let device = DeviceService(rig.device.deps, bundles: rig.device.bundles, events: rig.device.events)
        let enc = try FixtureAgreement().publicKeySPKI()
        let opener = VoIPInviteOpener(device: device, keys: KeyringEciesOpener(agreement: FixtureAgreement()), store: rig.store)
        let w = server.wire(id: "v1", kind: "call", payload: ["room": "family", "who": "Alice", "video": true, "at": 5], exp: 4_000_000_000_000,
                            device: enc, deviceId: "ios_test0001")
        let invite = try XCTUnwrap(opener.openCallInvite(["m5": w]))
        XCTAssertEqual(invite, VoIPCallInvite(kind: .ring, id: "v1", roomKey: "family", who: "Alice", video: true, at: 5))
        XCTAssertNil(opener.openCallInvite(["m5": w]), "the same push twice: once")
        let end = server.wire(id: "v2", kind: "call-end", payload: ["room": "family"], device: enc, deviceId: "ios_test0001")
        XCTAssertEqual(opener.openCallInvite(["m5": end])?.kind, .end)
        // Forged: nil (CallKit then gets a neutral call, ended at once).
        let forged = TestControlServer().wire(id: "v3", kind: "call", payload: ["room": "family"], device: enc, deviceId: "ios_test0001")
        XCTAssertNil(opener.openCallInvite(["m5": forged]))
        XCTAssertNil(opener.openCallInvite(["aps": ["alert": "x"]]))
    }

    func testTheNotifiersCallMapsTheServersRoom() {
        let o = PushOpener.Opened(id: "n1", kind: "notify", payload: ["kind": "call", "room": "srv-room", "privacy": "sender", "vars": ["sender": "Bob"], "at": 7],
                                  exp: 0, at: 1)
        let invite = VoIPInviteOpener.invite(o) { $0 == "srv-room" ? "family" : nil }
        XCTAssertEqual(invite, VoIPCallInvite(kind: .ring, id: "n1", roomKey: "family", who: "Bob", video: false, at: 7))
        let neutral = PushOpener.Opened(id: "n2", kind: "notify", payload: ["kind": "call", "room": "srv-room", "privacy": "neutral", "vars": ["sender": "Bob"]],
                                        exp: 0, at: 1)
        XCTAssertEqual(VoIPInviteOpener.invite(neutral) { _ in "family" }?.who, "", "the level hides the caller")
        XCTAssertNil(VoIPInviteOpener.invite(o) { _ in nil }, "a room this device does not have")
        let message = PushOpener.Opened(id: "n3", kind: "notify", payload: ["kind": "message", "room": "srv-room"], exp: 0, at: 1)
        XCTAssertNil(VoIPInviteOpener.invite(message) { _ in "family" })
    }
}

final class ApnsEnvironmentTests: XCTestCase {
    func testTheProvisioningProfileSaysWhichEnvironment() {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>Entitlements</key><dict><key>aps-environment</key><string>production</string></dict></dict></plist>
        """
        var cms = Data([0x30, 0x82, 0x01, 0x00])
        cms.append(Data(plist.utf8))
        cms.append(Data([0xA0, 0x00]))
        XCTAssertEqual(ApnsEnvironment.fromProvision(cms), "production")
        XCTAssertNil(ApnsEnvironment.fromProvision(Data("no plist".utf8)))
        XCTAssertEqual(ApnsEnvironment.wire("development"), "sandbox")
        XCTAssertEqual(ApnsEnvironment.wire("production"), "production")
        #if targetEnvironment(simulator)
        XCTAssertEqual(ApnsEnvironment.entitlement(), "development")
        #endif
    }

    func testTheBackgroundCheckinsInterval() {
        var st = DeviceState(server: "https://x", deviceId: "d", serverKey: "k", serverKid: "k")
        st.pollSecondsRaw = 1800
        XCTAssertEqual(CheckinSchedule.backgroundInterval(state: st, pushEnabled: true), 12 * 3600)
        XCTAssertEqual(CheckinSchedule.backgroundInterval(state: st, pushEnabled: false), 1800)
        st.pollSecondsRaw = 60
        XCTAssertEqual(CheckinSchedule.backgroundInterval(state: st, pushEnabled: false), 900, "at least 15 minutes")
    }
}
