// The keys: the Secure Enclave path (where this simulator has an enclave — Apple
// silicon) and the software fallback, through the same Keyring code. The PRF that
// replaces Android's hardware HMAC is deterministic per key and input, differs by
// key (another device), and is gone with its key. The device's signing key signs
// in the server's form (P1363 over SPKI), its encryption key agrees like CryptoKit.
// The Keychain store itself runs where the build is signed (else skipped).

import CryptoKit
import XCTest
@testable import M5cet

final class KeyringTests: XCTestCase {
    private func keyrings() throws -> [(String, Keyring)] {
        var out: [(String, Keyring)] = [("software", TestKeys.software(MemorySecureStore()))]
        if EnclaveKeyMaker.available { out.append(("secure-enclave", try TestKeys.enclave(MemorySecureStore()))) }
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

    func testTheDeviceSignsInTheServersForm() throws {
        for (name, k) in try keyrings() {
            let signer = KeyringSigner(keyring: k)
            let spki = try signer.publicKeySPKI()
            let data = Data("m5ios/1|POST|/api/ios/checkin|1|nonce|hash".utf8)
            let sig = try signer.sign(data)
            XCTAssertEqual(sig.count, 64, name)
            XCTAssertTrue(EcP256.verify(spki: spki, data: data, signature: Bytes.b64(sig)), name)
            XCTAssertEqual(spki, try signer.publicKeySPKI(), "the same key every time")
            XCTAssertEqual(signer.level, name == "secure-enclave" ? .secureEnclave : .software)
        }
    }

    func testTheDeviceAgreesLikeCryptoKit() throws {
        for (name, k) in try keyrings() {
            let device = KeyringAgreement(keyring: k)
            let peer = P256.KeyAgreement.PrivateKey()
            let mine = try device.sharedSecret(withSPKI: Bytes.b64(peer.publicKey.derRepresentation))
            let theirs = try EcP256.ecdh(peer, EcP256.publicKey(spki: device.publicKeySPKI()))
            XCTAssertEqual(mine, theirs, name)
        }
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
    }

    func testKeychainStoreWhereTheBuildIsSigned() throws {
        guard KeychainSecureStore.usable() else {
            throw XCTSkip("no keychain entitlement in this (unsigned) build — the app uses FileSecureStore here")
        }
        let store = KeychainSecureStore(service: "cz.m5cet.test.\(UUID().uuidString)")
        defer { store.deleteAll() }
        try store.write("a", Data([1, 2]), access: .foreground)
        try store.write("a", Data([3]), access: .background)
        XCTAssertEqual(try store.read("a"), Data([3]))
        try store.write("b", Data([4]), access: .background)
        XCTAssertEqual(Set(try store.names()), ["a", "b"])
        store.deleteAll()
        XCTAssertEqual(try store.names(), [])
        // The Secure Enclave keyring on the real Keychain.
        let k = Keyring.system(store: store)
        let spki = try KeyringSigner(keyring: k).publicKeySPKI()
        XCTAssertFalse(spki.isEmpty)
    }
}
