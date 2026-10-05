// Vault slots v2 (android VaultSlotTest — the web's sealSlot vectors), the
// account keys (AccountKeysTest — the web's sealRoot / openRoot / profile
// vectors), the recovery code (RecoveryCodeTest), the signed device policy
// (SignedPolicyTest — signed by the server's code), sealed messages, the PIN
// wrap, the lock inbox and intent seals.

import Foundation
import M5Core
@testable import M5Crypto
import Testing

@Suite struct VaultSlotTests {
    /// The web's sealSlot with the raw AES key (i * 11 + 5): the "card" at rev 1800000000123, the "registration" at …456.
    static let key = "BRAbJjE8R1JdaHN+iZSfqrXAy9bh7PcCDRgjLjlET1o="
    static let webCard = "TTVWMgAAAaMYXFB7CLeeZ7w1AcPkmCxknzruLap0CQHD50LedLgxr4Z/UkWo1J9CYU8+t0gBVbkR5fx+cQXziKPJHE6pouDvctllfjmWnH5bycKTDLb/PI2NjOiO5w=="
    static let webRegistration = "TTVWMgAAAaMYXFHItUXCoIHThKywQWvS8KzLwYII0kthlsWJ0CYjqCRPchF0bQ061p+IjA=="

    @Test func opensTheWebsV2Slots() throws {
        let key = b64(VaultSlotTests.key)
        let card = try AccountKeys.openSlot(VaultSlotTests.webCard, key: key, slot: "card")
        #expect(!card.legacy)
        #expect(card.rev == 1_800_000_000_123)
        #expect(card.value.string("nick") == "Žofie")
        #expect(card.value.object("audiences")?.bool("room") == true)
        #expect(try AccountKeys.openSlot(VaultSlotTests.webRegistration, key: key, slot: "registration").value.string("name") == "A")
        // A slot's ciphertext handed back as another slot does not open.
        #expect(throws: (any Error).self) { try AccountKeys.openSlot(VaultSlotTests.webCard, key: key, slot: "profile") }
        #expect(throws: (any Error).self) { try AccountKeys.openSlot(VaultSlotTests.webRegistration, key: key, slot: "card") }
    }

    @Test func sealsV2AndStillReadsV1() throws {
        let key = b64(VaultSlotTests.key)
        let value = JSONObject([("x", 1), ("y", "z")])
        let v2 = try AccountKeys.sealSlot(value, key: key, slot: "card", rev: 42)
        #expect(Array(b64(v2).prefix(4)) == Array("M5V2".utf8))
        let back = try AccountKeys.openSlot(v2, key: key, slot: "card")
        #expect(back.rev == 42)
        #expect(back.value.string("y") == "z")
        // Another revision in the header fails (it is in the AAD).
        var raw = b64(v2)
        raw[11] ^= 1
        #expect(throws: (any Error).self) { try AccountKeys.openSlot(B64.encode(raw), key: key, slot: "card") }
        // A v1 part (6.11 and older) opens, marked legacy.
        let old = try AccountKeys.openSlot(try AccountKeys.sealProfile(value, key: key), key: key, slot: "card")
        #expect(old.legacy)
        #expect(old.rev == 0)
        #expect(old.value.int("x") == 1)
    }
}

@Suite struct AccountKeysTests {
    static let root = b64("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=")
    static let secret = b64("oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8=")

    @Test func keyProofAsTheWeb() {
        #expect(AccountKeys.keyProof(AccountKeysTests.root) == "ihXn4Wh4-qLqyW1GATHHFOS0yXGdXYWv1k5xqATOLG0")
        #expect(AccountKeys.keyProof(Crypto.random(32)).count == 43)
    }

    @Test func opensAndSealsRootsAsTheWeb() throws {
        let sealed = JSONObject([("iv", "pR6pkrNKqhwn3ZLN"), ("ct", "vyW+GK+Arl2/N2S4HNzz7mYnjyz7I56HBli8VTlhXpIDgXnrPoSv0DHN+fWk+HIk")])
        #expect(try AccountKeys.openRoot(sealed, secret: AccountKeysTests.secret, info: AccountKeys.wrapRecovery) == AccountKeysTests.root)
        #expect(throws: (any Error).self) { try AccountKeys.openRoot(sealed, secret: AccountKeysTests.secret, info: AccountKeys.wrapPasskey) }
        #expect(throws: (any Error).self) { try AccountKeys.openRoot(sealed, secret: AccountKeysTests.root, info: AccountKeys.wrapRecovery) }
        #expect(throws: (any Error).self) { try AccountKeys.openRoot(JSONObject([("iv", "!!"), ("ct", "??")]), secret: AccountKeysTests.secret, info: AccountKeys.wrapRecovery) }
        let s = try AccountKeys.sealRoot(AccountKeysTests.root, secret: AccountKeysTests.secret, info: AccountKeys.wrapPasskey, iv: b64("EBESExQVFhcYGRob"))
        #expect(s.string("iv") == "EBESExQVFhcYGRob")
        #expect(s.string("ct") == "fyDTLnQ9RpmWZ4oxAUwL3mEzHYjKZ7LnLVAWJ/44zTg+4s8Ak/3X0b1TyTRlePcj")
        #expect(!AccountKeys.sealed(nil))
        #expect(!AccountKeys.sealed(JSONObject([("iv", ""), ("ct", "")])))
        #expect(AccountKeys.sealed(JSONObject([("iv", "a"), ("ct", "b")])))
    }

    static let webRegistration = "MDEyMzQ1Njc4OTo7YMQEAIfxdtDjgKB97Caxu8AUZ3tuNNvKng7s/8MReuYP8N36QyRRwVem59RKnqzcSM80uV4GbYxfuimwME+3LWOCJsZP5DVow+W+TDhbwHi5Aj37alM6dWKC8j7BWmrBCE4vb8Cfgs63t5BOULCEGjY5ARX7lgaqLMu0LJYkfwaL5G44wcPfNGrvKg1y8H1B61PO2w8TbJTxvg=="
    static let webRegistrationJson = #"{"v":1,"firstName":"Jan","lastName":"Novák","country":"CZ","phone":"+420777123456","email":"jan@example.cz","registeredAt":1760000000000}"#

    @Test func theVaultAsTheWeb() throws {
        let r = try AccountKeys.openProfile(AccountKeysTests.webRegistration, key: AccountKeys.profileKey(AccountKeysTests.root))
        #expect(r.int("v") == 1)
        #expect(r.string("lastName") == "Novák")
        #expect(r.int64("registeredAt") == 1_760_000_000_000)
        #expect(throws: (any Error).self) { try AccountKeys.openProfile(AccountKeysTests.webRegistration, key: AccountKeys.profileKey(AccountKeysTests.secret)) }
        // The same key, IV and JSON text give exactly the web's bytes — and this JSON writer keeps the web's key order.
        let iv = (0..<12).map { UInt8(0x30 + $0) }
        let parsed = JSON.parseObject(AccountKeysTests.webRegistrationJson)!
        #expect(parsed.stringify() == AccountKeysTests.webRegistrationJson)
        #expect(try AccountKeys.sealProfile(parsed, key: AccountKeys.profileKey(AccountKeysTests.root), iv: iv) == AccountKeysTests.webRegistration)
        // Tampered, cut short or not base64: an error, never a guess.
        #expect(throws: (any Error).self) { try AccountKeys.openProfile(B64.encode(Bytes(repeating: 0, count: 20)), key: AccountKeys.profileKey(AccountKeysTests.root)) }
        #expect(throws: (any Error).self) { try AccountKeys.openProfile("***", key: AccountKeys.profileKey(AccountKeysTests.root)) }
    }

    @Test func webauthnJson() throws {
        let first = Crypto.b64url(AccountKeysTests.secret)
        let c = JSONObject([("clientExtensionResults", .object(JSONObject([("prf", .object(JSONObject([("results", .object(JSONObject([("first", .string(first))])))])))])))])
        #expect(AccountKeys.prfOf(c) == AccountKeysTests.secret)
        #expect(AccountKeys.prfOf(nil) == nil)
        let options = AccountKeys.withPrf(JSONObject([("challenge", "abc"), ("extensions", .object(JSONObject([("credProps", true)])))]))
        #expect(options.object("extensions")?.bool("credProps") == true)
        #expect(options.object("extensions")?.object("prf")?.object("eval")?.string("first") == "bTVjZXQ6cGFzc2tleTpwcmY6djE")
        let registration = JSONObject([("id", "Y3JlZA"), ("rawId", "Y3JlZA"), ("type", "public-key"),
                                       ("response", .object(JSONObject([("clientDataJSON", "x"), ("transports", .array(["internal", "hybrid"]))]))),
                                       ("clientExtensionResults", .object(JSONObject()))])
        #expect(AccountKeys.strip(registration).count == 4)
        let r = AccountKeys.prfRequest(rpId: "chat.fir.ma", registration: registration, challenge: Bytes(repeating: 0, count: 32))
        #expect(r.array("allowCredentials")?.first?["transports"]?.arrayValue?.count == 2)
        #expect(AccountKeys.credentialIds(JSONObject([("credentialId", "AAA"), ("passkeys", .array([.object(JSONObject([("credentialId", "AAA")])), .object(JSONObject([("credentialId", "BBB=")]))]))])) == ["AAA", "BBB"])
        #expect(AccountKeys.credentialIds(JSONObject([("credentialId", "AAA")])) == ["AAA"])
        #expect(AccountKeys.confirmRequest(rpId: "x", ids: ["A"], challenge: []).has("extensions") == false)
        let handle = Crypto.b64url(Crypto.utf8("bystry-sokol-7k3q"))
        #expect(AccountKeys.handleName(JSONObject([("response", .object(JSONObject([("userHandle", .string(handle))])))])) == "bystry-sokol-7k3q")
        #expect(AccountKeys.handleName(JSONObject([("response", .object(JSONObject([("userHandle", .string(Crypto.b64url([0, 1, 2])))])))])) == "")
    }

    @Test func recoveryCodeAsTheWeb() throws {
        let m = try #require(RecoveryCode.material("0123456789ABCDEFGHJKMNPQRS"))
        #expect(m.id == "cR844GIEoW3PHRm2pbnsKNTM")
        #expect(m.proof == "4Rrk2qDybJ22G_nylVw53ScZHfAIv6TPwbWKO3eQiks")
        #expect(m.verifier == "1fa55f656bd8467599a6a2d03a859114d2cc24d5b606a55ff97dbded605e0137")
        #expect(B64.encode(m.secret) == "crIBSDzsoabt3c7bvJbZwtruVUXaa62hxrOMaaMLGHE=")
        #expect(RecoveryCode.material("oi234-56789-abcde-fghjk-mnpqr-s")?.id == m.id)
        #expect(RecoveryCode.normalize("0123456789ABCDEFGHJKMNPQRU") == "0123456789ABCDEFGHJKMNPQRV")
        #expect(RecoveryCode.normalize("0123456789ABCDEFGHJKMNPQR") == nil)
        #expect(RecoveryCode.material("nope") == nil)
        for _ in 0..<20 {
            let c = RecoveryCode.generate()
            #expect(RecoveryCode.normalize(c) == c.replacingOccurrences(of: "-", with: ""))
        }
    }
}

@Suite struct SecurityTests {
    /// Signed by the server's code (server/android/crypto.ts signPolicy).
    static let nodeKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkbXImCDqgGYKZpLQXxNgmWauLY/95ict9xpD99v0DRKBB2FBS04nu/7QDeGD/yDfS0KdIil5PTqP65jPmBRXGQ=="
    static let nodeWire = #"{"at":1767225600000,"policy":"{\"lock\":{\"pinLength\":6,\"maxAttempts\":8,\"wipe\":true,\"screenshots\":false,\"autolockSeconds\":60},\"logs\":\"errors\"}","sig":"MBx8PB0dZ3HvzifYelc46hPRQ2zAg2mDDTCvM+ZHQJ35DKYjsonwez7y8QzZCZ7XhKzqhAiVITVTdWqF0DUHOw=="}"#

    @Test func signedPolicy() throws {
        let wire = JSON.parseObject(SecurityTests.nodeWire)!
        let p = try #require(SignedPolicy.open(wire, serverKey: SecurityTests.nodeKey, deviceId: "and_test1", lastAt: 0))
        #expect(p.object("lock")?.bool("screenshots") == false)
        #expect(p.object("lock")?.int("maxAttempts") == 8)
        #expect(SignedPolicy.open(wire, serverKey: SecurityTests.nodeKey, deviceId: "and_test1", lastAt: 1_767_225_600_000) != nil)
        #expect(SignedPolicy.open(wire, serverKey: SecurityTests.nodeKey, deviceId: "and_other", lastAt: 0) == nil)
        #expect(SignedPolicy.open(wire, serverKey: Prim.generateP256().spki, deviceId: "and_test1", lastAt: 0) == nil)
        #expect(SignedPolicy.open(wire, serverKey: SecurityTests.nodeKey, deviceId: "and_test1", lastAt: 1_767_225_600_001) == nil)
        let tampered = wire.with("policy", .string(wire.optString("policy").replacingOccurrences(of: "\"screenshots\":false", with: "\"screenshots\":true")))
        #expect(SignedPolicy.open(tampered, serverKey: SecurityTests.nodeKey, deviceId: "and_test1", lastAt: 0) == nil)
        #expect(SignedPolicy.open(wire.with("at", .int(1_767_225_600_002)), serverKey: SecurityTests.nodeKey, deviceId: "and_test1", lastAt: 0) == nil)
        #expect(SignedPolicy.open(nil, serverKey: SecurityTests.nodeKey, deviceId: "and_test1", lastAt: 0) == nil)
        #expect(SignedPolicy.open(wire, serverKey: "", deviceId: "and_test1", lastAt: 0) == nil)
        let k = Prim.generateP256()
        let json = #"{"lock":{"wipe":true}}"#
        let sig = Crypto.b64(try Ec.sign(k, Crypto.utf8(SignedPolicy.signedString(deviceId: "ios_x", at: 5, policyJson: json))))
        #expect(SignedPolicy.open(JSONObject([("at", 5), ("policy", .string(json)), ("sig", .string(sig))]), serverKey: k.spki, deviceId: "ios_x", lastAt: 4) != nil)
    }

    @Test func sealedMessagesAndTheirBound() throws {
        let sealed = try Sealed.seal("zpráva", code: "WXYZ-2345-6789")
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta, code: "wxyz 2345 6789") == "zpráva")
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta, code: "WXYZ-2345-6788") == nil)
        let t0 = Date()
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta.with("it", .int(2_000_000_000)), code: "WXYZ-2345-6789") == nil)
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta.with("it", 0), code: "WXYZ-2345-6789") == nil)
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta.with("it", -5), code: "WXYZ-2345-6789") == nil)
        #expect(Date().timeIntervalSince(t0) < 1)
        let code = Sealed.newCode()
        #expect(code.count == 14)
        #expect(Sealed.normalize(code).count == 12)
    }

    @Test func pinWrapVersionsAndMove() throws {
        let dek = Crypto.random(32), salt = Crypto.random(16)
        let stretched = PinWrap.stretch(pin: "123456", salt: salt, iterations: 1000)
        let hw = Crypto.random(32)
        let kek: PinWrap.Kek = { s, v in v >= 2 ? Crypto.hmac256(hw, PinWrap.kekInput(s)) : Crypto.hmac256(hw, s) }
        let v1 = try PinWrap.seal(dek: dek, stretched: stretched, salt: salt, iterations: 1000, version: 1, hw: nil, kek: kek)
        #expect(PinWrap.version(v1) == 1)
        #expect(try PinWrap.open(v1, stretched: stretched, kek: kek) == dek)
        #expect(try PinWrap.open(v1, stretched: PinWrap.stretch(pin: "654321", salt: salt, iterations: 1000), kek: kek) == nil)
        let v2 = try PinWrap.moved(v1, dek: dek, stretched: stretched, hw: "secure-enclave", kek: kek)
        #expect(PinWrap.version(v2) == 2)
        #expect(v2.string("hw") == "secure-enclave")
        #expect(try PinWrap.salt(v2) == salt)
        #expect(try PinWrap.open(v2, stretched: stretched, kek: kek) == dek)
        // A v2 wrap read as v1 (its AAD) does not open.
        #expect(try PinWrap.open(v2.without("v"), stretched: stretched, kek: kek) == nil)
        #expect(throws: (any Error).self) { try PinWrap.iterations(JSONObject()) }
    }

    @Test func lockBoxGenerationsAndLog() throws {
        let gen = LockBox.newKeyPair()
        let kid = LockBox.kid(gen)
        var log = Bytes()
        for i in 1...5 { log += LockBox.line(try LockBox.seal(publicKey: gen.spki, kid: kid, seq: Int64(i), Crypto.utf8(#"{"t":"msg","n":\#(i)}"#))) }
        log += LockBox.line(try LockBox.seal(publicKey: gen.spki, kid: kid, seq: 3, Crypto.utf8("again"))) // a line written twice: once
        log += Crypto.utf8(#"{"s":9,"e":"cut"# + "\n")                                                                 // cut by a crash
        let other = LockBox.newKeyPair()
        log += LockBox.line(try LockBox.seal(publicKey: other.spki, kid: LockBox.kid(other), seq: 7, [1]))      // another generation
        let dek = Crypto.random(32)
        let wrapped = try LockBox.wrapKey(dek: dek, kid: kid, pkcs8: b64(gen.pkcs8))
        let priv = try LockBox.unwrapKey(dek: dek, kid: kid, wrapped)
        #expect(throws: (any Error).self) { try LockBox.unwrapKey(dek: Crypto.random(32), kid: kid, wrapped) }
        let opened = LockBox.openAll(priv, kid: kid, LockBox.read(log))
        #expect(opened.items.map(Crypto.str) == (1...5).map { #"{"t":"msg","n":\#($0)}"# })
        #expect(opened.failed == 1)
    }

    @Test func intentSeals() {
        let t = IntentSeal.tag(IntentSeal.open, "room-1")
        #expect(IntentSeal.valid(IntentSeal.open, "room-1", t))
        #expect(!IntentSeal.valid(IntentSeal.reply, "room-1", t))
        #expect(!IntentSeal.valid(IntentSeal.open, "room-2", t))
        #expect(!IntentSeal.valid(IntentSeal.open, "", t))
        #expect(IntentSeal.tag(Bytes(repeating: 1, count: 32), "open", "x") != IntentSeal.tag(Bytes(repeating: 2, count: 32), "open", "x"))
    }
}
