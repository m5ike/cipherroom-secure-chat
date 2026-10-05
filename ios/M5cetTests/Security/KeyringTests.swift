// The keys: the Secure Enclave path (where this simulator has an enclave — Apple
// silicon) and the software fallback, through the same Keyring code. The PRF that
// replaces Android's hardware HMAC is deterministic per key and input, differs by
// key (another device), and is gone with its key. The device's signing key is
// M5Net's RequestSigner and M5Crypto's DeviceSigner (P1363 over SPKI), its
// encryption key M5Crypto's KeyAgreer. The extension's keys (sys, enc) are in the
// shared store, every other key app-only. The Keychain stores themselves run where
// the build is signed (else skipped).

import CryptoKit
import M5Core
import M5Crypto
import M5Net
import XCTest
@testable import M5cet

final class KeyringTests: XCTestCase {
    private func keyrings() throws -> [(String, Keyring)] {
        var out: [(String, Keyring)] = [("software", TestKeys.software(MemorySecureStore(), shared: MemorySecureStore()))]
        if EnclaveKeyMaker.available { out.append(("secure-enclave", try TestKeys.enclave(MemorySecureStore(), shared: MemorySecureStore()))) }
        return out
    }

    func testTheEnclaveIsUsedWhereThereIsOne() throws {
        let k = try TestKeys.enclave(MemorySecureStore())
        XCTAssertEqual(k.level, .secureEnclave)
        XCTAssertEqual(try k.ensureAgreementKey("pin", access: .foreground), .secureEnclave)
        XCTAssertEqual(k.level(of: "pin"), .secureEnclave)
        // The stored blob is the enclave's encrypted key, not a scalar.
        let blob = try XCTUnwrap(try k.store.read("key.pin"))
        XCTAssertGreaterThan(blob.count, 33)
    }

    func testThePrfIsDeterministicPerKeyAndInput() throws {
        for (name, k) in try keyrings() {
            try k.ensureAgreementKey("pin", access: .foreground)
            let a = try k.prf("pin", Data("m5/pin/2|aaaa".utf8))
            XCTAssertEqual(a.count, 32, name)
            XCTAssertEqual(a, try k.prf("pin", Data("m5/pin/2|aaaa".utf8)), name)
            XCTAssertNotEqual(a, try k.prf("pin", Data("m5/pin/2|aaab".utf8)), name)
            // Another key (another device's enclave): another PRF — no guessing without this one.
            try k.ensureAgreementKey("duress", access: .foreground)
            XCTAssertNotEqual(a, try k.prf("duress", Data("m5/pin/2|aaaa".utf8)), name)
            // The key gone: no PRF at all.
            k.delete("pin")
            XCTAssertThrowsError(try k.prf("pin", Data("m5/pin/2|aaaa".utf8)), name)
            // ensure never replaces an existing key.
            try k.ensureAgreementKey("duress", access: .foreground)
            XCTAssertEqual(try k.prf("duress", Data("x".utf8)), try k.prf("duress", Data("x".utf8)))
        }
    }

    func testTheDeviceSignsInTheServersForm() async throws {
        for (name, k) in try keyrings() {
            let signer = try KeyringSigner(keyring: k)
            let data = Data("m5ios/1|POST|/api/ios/checkin|1|nonce|hash".utf8)
            // M5Net RequestSigner: SPKI + P1363 Data.
            let spki = try await signer.publicKeySPKI()
            let sig = try await signer.signP1363(data)
            XCTAssertEqual(sig.count, 64, name)
            XCTAssertTrue(P256Keys.verify(spki: spki, data: data, signature: Bytes.b64(sig)), name)
            // M5Crypto DeviceSigner: P1363 base64.
            XCTAssertTrue(Ec.verify(signer.publicKey, Array(data), try signer.sign(Array(data))), name)
            XCTAssertEqual(spki, try KeyringSigner(keyring: k).publicKey, "the same key every time")
            XCTAssertEqual(signer.level, name == "secure-enclave" ? .secureEnclave : .software)
            let generic: any RequestSigner = signer
            _ = generic
        }
    }

    func testTheDeviceKeyOpensEciesFromTheServer() throws {
        for (name, k) in try keyrings() {
            let device = try KeyringAgreement(keyring: k)
            let peer = P256.KeyAgreement.PrivateKey()
            let mine = try device.agree(with: peer.publicKey)
            let theirs = try peer.sharedSecretFromKeyAgreement(with: Ec.publicFromSpki(device.spki)).withUnsafeBytes { Array($0) }
            XCTAssertEqual(mine, theirs, name)
            // What the server seals to the device (M5Crypto Ecies, Android's "m5cet/android/ecies/1") opens with it.
            let wire = try Ecies.seal(deviceEncSpki: device.spki, deviceId: "ios_1", purpose: "push", Crypto.utf8("hello"))
            XCTAssertEqual(try Ecies.open(device, deviceId: "ios_1", purpose: "push", wire), Crypto.utf8("hello"), name)
        }
    }

    func testOnlyTheExtensionsKeysAreShared() throws {
        let app = MemorySecureStore(), shared = MemorySecureStore()
        let k = TestKeys.software(app, shared: shared)
        for alias in ["sys", "enc", "pin", "duress", "bio"] { try k.ensureAgreementKey(alias, access: .foreground) }
        try k.ensureSigningKey("sign", access: .background)
        XCTAssertTrue(k.newCounterKey(1))
        XCTAssertEqual(Set(try shared.names()), ["key.sys", "key.enc"], "the SYS key and the device's encryption key")
        XCTAssertEqual(Set(try app.names()), ["key.pin", "key.duress", "key.bio", "key.sign", "key.ctr.1"])
        XCTAssertEqual(Keyring.sharedAliases, ["sys", "enc"])
        k.deleteAll()
        XCTAssertEqual(try app.names() + shared.names(), [])
    }

    func testCounterGenerationsAndDeleteAll() throws {
        for (name, k) in try keyrings() {
            XCTAssertEqual(k.counterGenerations(), [], name)
            XCTAssertTrue(k.newCounterKey(1))
            XCTAssertTrue(k.newCounterKey(2))
            XCTAssertEqual(k.counterGenerations(), [1, 2], name)
            try k.ensureSigningKey("sign", access: .background)
            try k.store.write("other", Data([1]), access: .background)
            k.deleteAll()
            XCTAssertEqual(k.counterGenerations(), [], name)
            XCTAssertFalse(k.has("sign"))
            XCTAssertEqual(try k.store.names(), ["other"], "only the keys go with Keyring.deleteAll")
        }
    }

    func testAStoreThatCannotAnswerDecidesNothing() {
        let store = MemorySecureStore()
        let k = TestKeys.software(store)
        store.failing = true
        XCTAssertNil(k.counterGenerations())
        XCTAssertFalse(k.newCounterKey(1))
    }

    func testBiometricKeysFallBackToSoftwareOnlyWhereAllowed() throws {
        let k = try TestKeys.enclave(MemorySecureStore())
        // The simulator's enclave makes no biometric keys: software, marked so (softwareBiometry: true).
        let level = try k.ensureAgreementKey("bio", access: .biometry)
        #if targetEnvironment(simulator)
        XCTAssertEqual(level, .software)
        #endif
        let strict = Keyring(store: MemorySecureStore(), enclave: EnclaveKeyMaker(), softwareBiometry: false)
        #if targetEnvironment(simulator)
        XCTAssertThrowsError(try strict.ensureAgreementKey("bio", access: .biometry), "a device build never falls back")
        #else
        _ = strict
        #endif
    }

    // MARK: the stores

    func testFileAndMemoryStores() throws {
        let dir = TempDir()
        for store in [FileSecureStore(dir: dir.url.appendingPathComponent("kc")), MemorySecureStore()] as [any SecureStore] {
            XCTAssertNil(try store.read("a"))
            try store.write("a", Data([1, 2]), access: .foreground)
            try store.write("key.ctr.7", Data([3]), access: .background)
            XCTAssertEqual(try store.read("a"), Data([1, 2]))
            XCTAssertEqual(Set(try store.names()), ["a", "key.ctr.7"])
            store.delete("a")
            XCTAssertNil(try store.read("a"))
            store.deleteAll()
            XCTAssertEqual(try store.names(), [])
        }
        // The unsigned simulator build: the app-only stand-in in the app's container, the shared one on the App Group side.
        let paths = SecurityPaths.under(dir.url)
        XCTAssertTrue(paths.devKeychain.path.hasPrefix(paths.root.path))
        XCTAssertTrue(paths.devSharedKeychain.path.hasPrefix(paths.shared.path))
    }

    func testTheKeychainGroupsWhereTheBuildIsSigned() throws {
        guard let prefix = KeychainSecureStore.groupPrefix() else {
            throw XCTSkip("no keychain entitlement in this (unsigned) build — the app uses FileSecureStore here")
        }
        let paths = SecurityPaths.under(TempDir().url)
        let stores = SecurityCenter.systemStores(paths)
        let app = try XCTUnwrap(stores.app as? KeychainSecureStore), shared = try XCTUnwrap(stores.shared as? KeychainSecureStore)
        XCTAssertEqual(app.accessGroup, prefix + "cz.m5cet.app")
        XCTAssertEqual(shared.accessGroup, prefix + "cz.m5cet.shared")
        let testApp = KeychainSecureStore(service: "cz.m5cet.test.\(UUID().uuidString)", accessGroup: app.accessGroup)
        let testShared = KeychainSecureStore(service: testApp.service, accessGroup: shared.accessGroup)
        defer {
            testApp.deleteAll()
            testShared.deleteAll()
        }
        try testApp.write("a", Data([1, 2]), access: .foreground)
        try testApp.write("a", Data([3]), access: .background)
        XCTAssertEqual(try testApp.read("a"), Data([3]))
        try testShared.write("b", Data([4]), access: .background)
        XCTAssertEqual(try testApp.names(), ["a"], "one group's items are not the other's")
        XCTAssertEqual(try testShared.names(), ["b"])
        XCTAssertNil(try testShared.read("a"))
        testApp.deleteAll()
        XCTAssertEqual(try testApp.names(), [])
        // The Secure Enclave keyring on the real Keychain: the signing key app-only, the encryption key shared.
        let k = Keyring.system(store: testApp, shared: testShared)
        _ = try KeyringSigner(keyring: k)
        _ = try KeyringAgreement(keyring: k)
        XCTAssertEqual(try testApp.names(), ["key.sign"])
        XCTAssertEqual(try testShared.names().sorted(), ["b", "key.enc"])
    }
}
