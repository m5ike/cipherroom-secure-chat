import CryptoKit
import Foundation
import Testing
@testable import M5Design

/// BundleCrypto with CryptoKit — what the app wires to M5Crypto (the device key would be in the Keychain).
struct CryptoKitBundleCrypto: BundleCrypto {
    let deviceKey: P256.KeyAgreement.PrivateKey
    static let label = "m5cet/android/ecies/1"

    func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    func verifyP1363(publicKeySpki: Data, message: Data, signature: Data) -> Bool {
        guard let key = try? P256.Signing.PublicKey(derRepresentation: publicKeySpki),
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return key.isValidSignature(sig, for: message)
    }

    func eciesOpen(deviceId: String, purpose: String, wire: EciesWire) throws -> Data {
        guard let e = Data(base64Encoded: wire.e), let iv = Data(base64Encoded: wire.iv), let ct = Data(base64Encoded: wire.ct) else { throw BundleError("bad wire") }
        let shared = try deviceKey.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(derRepresentation: e))
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(Self.label.utf8), sharedInfo: Data("\(purpose)|\(deviceId)".utf8), outputByteCount: 32)
        return try open(key, iv, ct, Data("\(Self.label)|\(purpose)|\(deviceId)".utf8))
    }

    func aesGcmOpen(key: Data, iv: Data, ciphertextAndTag: Data, aad: Data) throws -> Data {
        try open(SymmetricKey(data: key), iv, ciphertextAndTag, aad)
    }

    private func open(_ key: SymmetricKey, _ iv: Data, _ ct: Data, _ aad: Data) throws -> Data {
        guard ct.count >= 16 else { throw BundleError("short") }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16))
        return try AES.GCM.open(box, using: key, authenticating: aad)
    }
}

/// BundleFile.java / Bundles.java against a bundle the server's own code built (fixtures/make-bundle.ts).
@Suite struct BundleFileTests {
    static let info = try! Fixtures.json(Fixtures.here + "test-bundle.json")
    static let file = try! Fixtures.data(Fixtures.here + "test-bundle.m5ab")
    static let serverSpki = Data(base64Encoded: info["serverSpki"].stringValue!)!
    static let kid = info["kid"].stringValue!
    static let deviceId = info["deviceId"].stringValue!
    static let crypto: CryptoKitBundleCrypto = {
        var d = info["deviceD"].stringValue!.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while d.count % 4 != 0 { d += "=" }
        return CryptoKitBundleCrypto(deviceKey: try! P256.KeyAgreement.PrivateKey(rawRepresentation: Data(base64Encoded: d)!))
    }()
    static let id = info["header"]["id"].stringValue!

    static func open(_ file: Data = file, id: String = id, spki: Data = serverSpki, kid: String = kid, device: String = deviceId, app: Int = 61400) throws -> BundleVerifier.Verified {
        try BundleVerifier.open(file: file, expectedId: id, serverKeySpki: spki, serverKid: kid, deviceId: device, appCode: app, crypto: crypto)
    }

    @Test func theServersBundleOpens() throws {
        let v = try Self.open()
        let h = Self.info["header"]
        #expect(v.file.id == h["id"].stringValue && v.file.number == 7 && v.file.version == "6.14.0-b7" && v.file.channel == "beta")
        #expect(v.file.created == 1_791_217_500_000 && v.file.minAppCode == 61400 && v.file.kid == Self.kid)
        #expect(v.file.signedString.hasPrefix("m5bundle/1|bld_ios_fixture_01|7|6.14.0-b7|beta|1791217500000|61400|\(Int(h["size"].numberValue!))|"))
        #expect(v.content.count == Int(h["size"].numberValue!))
        #expect(v.contents.entries.first?.path == "manifest.json")
        #expect(v.contents.entries.dropFirst().map(\.path) == Self.info["files"].arrayValue!.map { $0.stringValue! })
        #expect(v.contents.version == "6.14.0-b7" && v.contents.minAppCode == 61400)
        #expect(v.contents.manifest["designRev"] == Self.info["designRev"])
        let d = v.design
        #expect(d.source == Self.id && d.version == "6.14.0-b7" && d.appName == "M5cet Test")
        #expect(Set(d.document.screens.keys) == Set(Self.info["screens"].arrayValue!.map { $0.stringValue! }))
        #expect(d.assets["logo.png"]?.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
        #expect(d.t("test.only", lang: "cs") == "Only in the bundle")
        #expect(d.t("lock.title", lang: "cs") == Fixtures.builtIn.t("lock.title", lang: "cs"))
        #expect(d.withFallback(Fixtures.builtIn).t("settings.title", lang: "fi") == Fixtures.builtIn.t("settings.title", lang: "fi"))
        #expect(DesignReport.check(d.document).unknownElements.isEmpty)
        // the screens draw
        #expect(try ScreenResolver(RenderContext(design: d, dark: false, translator: Translator(design: d, lang: "en"))).resolve(screen: "lock", scope: .empty) != nil)
        // and the kept content opens at the next start
        let again = try BundleVerifier.openStored(content: v.content, id: Self.id, appCode: 61400, crypto: Self.crypto)
        #expect(again.document == d.document)
        #expect(throws: BundleError("the bundle needs a newer app")) { try BundleVerifier.openStored(content: v.content, id: Self.id, appCode: 61399, crypto: Self.crypto) }
    }

    @Test func whatIsRefused() throws {
        #expect(throws: BundleError("the server sent another bundle")) { try Self.open(id: "bld_other") }
        #expect(throws: BundleError("the bundle's signature is not the server's")) { try Self.open(kid: "AAAAAAAAAAAAAAAA") }
        let otherKey = Data(base64Encoded: Self.info["deviceSpki"].stringValue!)!
        #expect(throws: BundleError("the bundle's signature is not the server's")) { try Self.open(spki: otherKey) }
        #expect(throws: BundleError("the bundle needs a newer app")) { try Self.open(app: 61399) }
        #expect(throws: BundleError("the bundle is not encrypted for this device")) { try Self.open(device: "ios_someoneelse") }
        #expect(throws: BundleError("not an M5AB bundle")) { try Self.open(Data("M5AX".utf8) + Self.file.dropFirst(4)) }
        #expect(throws: BundleError("not an M5AB bundle")) { try Self.open(Data([0x4D, 0x35])) }
        var bigHeader = Self.file
        bigHeader[5] = 0x7F
        #expect(throws: BundleError("bad bundle header")) { try Self.open(bigHeader) }
    }

    @Test func tamperingIsCaught() throws {
        let headerLen = Int(Self.file[5]) << 24 | Int(Self.file[6]) << 16 | Int(Self.file[7]) << 8 | Int(Self.file[8])
        // a signed header field changed
        let text = String(decoding: Self.file[9..<(9 + headerLen)], as: UTF8.self)
        #expect(text.contains("\"number\":7"))
        let forged = Data(Self.file[0..<9]) + Data(text.replacingOccurrences(of: "\"number\":7", with: "\"number\":8").utf8) + Self.file[(9 + headerLen)...]
        #expect(throws: BundleError("the bundle's signature is not the server's")) { try Self.open(forged) }
        // a byte of a segment
        var flipped = Self.file
        flipped[flipped.count - 20] ^= 1
        #expect(throws: BundleError("bundle ciphertext hash mismatch")) { try Self.open(flipped) }
        // cut short / grown
        #expect(throws: BundleError("bundle ciphertext hash mismatch")) { try Self.open(Self.file.dropLast(1)) }
        #expect(throws: BundleError("bundle ciphertext hash mismatch")) { try Self.open(Self.file + Data([0])) }
        // the segments under a key that does not open them
        let b = try BundleFile.parse(Self.file)
        #expect(throws: BundleError("a bundle segment does not authenticate")) { try b.decrypt(cek: Data(repeating: 7, count: 32), crypto: Self.crypto) }
        #expect(!b.verify(serverKeySpki: Data([1, 2, 3]), crypto: Self.crypto))
    }
}

/// The M5PK container and its manifest (BundleFile.unpack) and gzip as Java reads it.
@Suite struct BundleContainerTests {
    static let crypto = BundleFileTests.crypto

    static func manifest(_ files: [(String, Data)], format: Int = 1, extra: [String: DesignValue] = [:]) -> Data {
        var list: [String: DesignValue] = [:]
        for (p, d) in files { list[p] = .obj(["size": .number(Double(d.count)), "sha256": .string(BundleContents.hex(crypto.sha256(d)))]) }
        var m: [String: DesignValue] = ["format": .number(Double(format)), "version": "v", "minAppCode": 60000, "files": .object(list)]
        for (k, v) in extra { m[k] = v }
        return Data(DesignValue.object(m).jsonText().utf8)
    }

    static func unpack(_ entries: [(String, Data)]) throws -> BundleContents {
        try BundleContents.unpack(try Gzip.compress(BundleContents.pack(entries)), crypto: crypto)
    }

    @Test func aGoodContainer() throws {
        let files: [(String, Data)] = [("a.json", Data("{}".utf8)), ("assets/x.png", Data([1, 2]))]
        let c = try Self.unpack([("manifest.json", Self.manifest(files))] + files)
        #expect(c.entries.map(\.path) == ["manifest.json", "a.json", "assets/x.png"])
        #expect(c.files["assets/x.png"] == Data([1, 2]))
    }

    @Test func whatIsRefused() throws {
        let files: [(String, Data)] = [("a.json", Data("{}".utf8))]
        let m = Self.manifest(files)
        #expect(throws: BundleError("bad path in the container")) { try Self.unpack([("manifest.json", m), ("../evil", Data())]) }
        #expect(throws: BundleError("bad path in the container")) { try Self.unpack([("manifest.json", m), ("/etc/x", Data())]) }
        #expect(throws: BundleError("bad path in the container")) { try Self.unpack([("manifest.json", m), ("a/..b", Data())]) }
        #expect(throws: BundleError("the bundle has no manifest")) { try Self.unpack(files + [("manifest.json", m)]) }
        #expect(throws: BundleError("the bundle has no manifest")) { try Self.unpack(files) }
        #expect(throws: BundleError("bundle file a.json does not match its manifest")) { try Self.unpack([("manifest.json", m), ("a.json", Data("{ }".utf8))]) }
        #expect(throws: BundleError("bundle file a.json does not match its manifest")) { try Self.unpack([("manifest.json", m)]) }
        #expect(throws: BundleError("unknown bundle format")) { try Self.unpack([("manifest.json", Self.manifest(files, format: 2))] + files) }
        #expect(throws: BundleError("bad manifest")) { try Self.unpack([("manifest.json", Data("[".utf8))]) }
        let packed = BundleContents.pack([("manifest.json", m)] + files)
        #expect(throws: BundleError("trailing bytes in the container")) { try BundleContents.unpack(try Gzip.compress(packed + Data([0])), crypto: Self.crypto) }
        #expect(throws: BundleError("truncated container")) { try BundleContents.unpack(try Gzip.compress(packed.dropLast(1)), crypto: Self.crypto) }
        #expect(throws: BundleError("not an M5PK container")) { try BundleContents.unpack(try Gzip.compress(Data("M5PX\u{1}0000".utf8)), crypto: Self.crypto) }
        #expect(throws: BundleError("bad bundle compression")) { try BundleContents.unpack(packed, crypto: Self.crypto) }
    }

    @Test func gzipAsJavaReadsIt() throws {
        let text = Data(String(repeating: "M5cet design bundle ", count: 500).utf8)
        let gz = try Gzip.compress(text)
        #expect(try Gzip.decompress(gz, limit: 1 << 20) == text)
        // two members, and garbage after the last one
        #expect(try Gzip.decompress(gz + gz + Data("junk".utf8), limit: 1 << 20) == text + text)
        // header fields: FEXTRA, FNAME, FCOMMENT
        var withFields = Data([0x1F, 0x8B, 8, 0x04 | 0x08 | 0x10, 0, 0, 0, 0, 0, 0xFF, 3, 0, 9, 9, 9])
        withFields.append(Data("name.bin\u{0}".utf8))
        withFields.append(Data("a comment\u{0}".utf8))
        withFields.append(gz.dropFirst(10))
        #expect(try Gzip.decompress(withFields, limit: 1 << 20) == text)
        // a corrupt trailer, not gzip, past the limit
        var bad = gz
        bad[bad.count - 6] ^= 0xFF
        #expect(throws: Gzip.Failure.self) { try Gzip.decompress(bad, limit: 1 << 20) }
        #expect(throws: Gzip.Failure.self) { try Gzip.decompress(Data("plain".utf8), limit: 1 << 20) }
        #expect(throws: Gzip.Failure(message: "too large", tooLarge: true)) { try Gzip.decompress(gz, limit: 1000) }
        #expect(Gzip.crc32(Data("123456789".utf8)) == 0xCBF4_3926)
    }

    @Test func aBundleBombIsTooLarge() throws {
        let bomb = try Gzip.compress(Data(count: BundleFile.maxContent + 1))
        #expect(bomb.count < 200_000)
        #expect(throws: BundleError("bundle too large")) { try BundleContents.unpack(bomb, crypto: Self.crypto) }
    }
}

/// Bundles.java's rules: offer, stage, trial, confirm, roll back.
@Suite struct BundleLedgerTests {
    struct Broken: Error {}
    static let design = Fixtures.builtIn

    @Test func offersAreFetchedOnlyWhenNewAndForThisApp() {
        var l = BundleLedger()
        #expect(l.shouldFetch(id: "b1", minAppCode: 61400, appCode: 61400, activeId: ""))
        #expect(!l.shouldFetch(id: "", minAppCode: 0, appCode: 61400, activeId: ""))
        #expect(!l.shouldFetch(id: "b1", minAppCode: 61500, appCode: 61400, activeId: ""))
        #expect(!l.shouldFetch(id: "b1", minAppCode: 0, appCode: 61400, activeId: "b1"))
        l.failed(id: "b2", error: "bad", now: 1)
        #expect(!l.shouldFetch(id: "b2", minAppCode: 0, appCode: 61400, activeId: ""))
        l.staged(id: "b3", version: "v3", number: 3, now: 2)
        #expect(!l.shouldFetch(id: "b3", minAppCode: 0, appCode: 61400, activeId: ""))
        #expect(l.items["b3"]?.state == "staged" && l.staged == "b3")
    }

    @Test func aStagedBundleRunsOnTrialThenBecomesGood() {
        var l = BundleLedger()
        l.staged(id: "b1", version: "v1", number: 1, now: 1)
        let loaded = l.loadActive(now: 10) { _ in Self.design }
        #expect(loaded.activeId == "b1" && loaded.trialStarted && loaded.design != nil)
        #expect(l.trial == "b1" && l.staged == "" && l.trialSince == 10)
        #expect(l.report(activeId: "b1").state == "trial")
        let prune = l.confirmTrial(now: 20_010, kept: ["b1", "old"])
        #expect(l.active == "b1" && l.trial == "" && l.good == ["b1"] && l.items["b1"]?.state == "good")
        #expect(prune == ["old"])
        #expect(l.report(activeId: "b1") == ("b1", "v1", "good"))
        // three good ones kept, newest first
        for (i, id) in ["b2", "b3", "b4"].enumerated() {
            l.staged(id: id, version: id, number: i + 2, now: 30)
            _ = l.loadActive(now: 40) { _ in Self.design }
            l.confirmTrial(now: 50)
        }
        #expect(l.good == ["b4", "b3", "b2"] && l.active == "b4")
    }

    @Test func aCrashedTrialRollsBack() {
        var l = BundleLedger()
        l.active = "good1"; l.good = ["good1"]
        l.staged(id: "b2", version: "v2", number: 2, now: 1)
        _ = l.loadActive(now: 2) { _ in Self.design }
        l.crashed()
        let loaded = l.loadActive(now: 3) { _ in Self.design }
        #expect(loaded.activeId == "good1" && !loaded.trialStarted)
        #expect(loaded.rolledBack.map(\.id) == ["b2"] && loaded.rolledBack[0].why == "the app crashed with it")
        #expect(l.items["b2"]?.state == "failed" && l.trial == "" && !l.trialCrashed)
        l.confirmTrial(now: 4) // nothing on trial: nothing changes
        #expect(l.active == "good1")
    }

    @Test func aBundleThatNoLongerOpensFallsBackAlongTheGoodOnes() {
        var l = BundleLedger()
        l.active = "b3"; l.good = ["b3", "b2", "b1"]
        let loaded = l.loadActive(now: 1) { id in
            if id == "b3" { throw BundleError("bundle content hash mismatch") }
            return Self.design
        }
        #expect(loaded.activeId == "b2" && l.active == "b2" && l.items["b3"]?.error == "bundle content hash mismatch")
        var none = BundleLedger()
        none.active = "x"; none.good = ["x"]
        let builtIn = none.loadActive(now: 1) { _ in throw Broken() }
        #expect(builtIn.design == nil && builtIn.activeId == "" && none.active == "")
    }

    @Test func aScreenThatFailsRollsTheTrialBack() {
        var l = BundleLedger()
        l.active = "a"; l.good = ["a"]
        l.staged(id: "t", version: "v", number: 1, now: 1)
        _ = l.loadActive(now: 1) { _ in Self.design }
        let notTrial = l.renderFailed(screen: "room", activeId: "a", message: "x", now: 2)
        let trial = l.renderFailed(screen: "room", activeId: "t", message: "unclosed \"{\" at 0", now: 2)
        #expect(!notTrial && trial)
        #expect(l.items["t"]?.error == "screen room: unclosed \"{\" at 0" && l.trial == "" && l.active == "a")
        let codable = try? JSONDecoder().decode(BundleLedger.self, from: JSONEncoder().encode(l))
        #expect(codable == l)
    }
}
