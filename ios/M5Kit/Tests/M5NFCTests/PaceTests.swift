// PACE (6.6): Aes (AES + CMAC), EcCurve (the six curves), Pace (the protocol) and AesSm (AES secure
// messaging) — PaceTest.java (test/nfc-pace.test.ts) against the SAME official vectors
// (test/fixtures/pace-vectors.json): ICAO 9303-11 Appendix G.1 (every value and every APDU), Appendix
// I.1 (PACE-CAM), the BSI TR-03110 worked example (the exchange and its 21 AES secure-messaging APDUs);
// AES against FIPS-197 / SP 800-38A, CMAC against RFC 4493, k·G and ECDH on all six curves against
// node:crypto (pace-ec-vectors.json) and the NIST curves against CryptoKit. Then a simulated PACE-only
// chip — written from the spec — is opened end to end with the CAN and with the MRZ.

import Testing
import Foundation
import CryptoKit
@testable import M5NFC

enum PaceVectors {
    static let all: NfcJSONObject = try! Repo.json("test/fixtures/pace-vectors.json").objectValue!
    static var g1: NfcJSONObject { all.optObject("icaoG")! }
    static var i1: NfcJSONObject { all.optObject("icaoI")! }
    static var bsi: NfcJSONObject { all.optObject("bsi")! }
    static let ec: NfcJSONObject = try! Repo.json("android/app/src/test/resources/pace-ec-vectors.json").objectValue!

    static func pairs(_ a: [NfcJSON]?) -> [(String, String)] { (a ?? []).map { ($0[0]!.jsString, $0[1]!.jsString) } }
    static func mrz(_ m: NfcJSONObject) -> MrzKey { MrzKey(m.optString("documentNumber"), m.optString("dateOfBirth"), m.optString("dateOfExpiry")) }
    static func big(_ h: String) -> BigUInt { BigUInt(hex: h)! }
    /// The PACEInfo a vector announces, parsed the way EF.CardAccess is.
    static func infoOf(_ paceInfo: String) -> Pace.Info { Pace.parseSecurityInfos(BerTlv.encode(0x31, b(paceInfo))).pace[0] }
    static let bsiInfo = Pace.Info(oid: "0.4.0.127.0.7.2.2.4.2.2", name: "PACE ECDH-GM AES-128", version: 2, parameterId: 13, agreement: "ECDH", mapping: "GM", cipher: "AES-128")

    /// G.1's recorded exchange, its MSE:Set AT with the optional 84 (the parameter id, 0D) this reader adds.
    static func g1Pairs() -> [(String, String)] {
        var p = pairs(g1.optArray("apdus"))
        let doc = b(p[0].0)
        p[0] = (H(Bytes.slice(doc, 0, 4) + u8(Int(doc[4]) + 3) + Bytes.slice(doc, 5) + u8(0x84, 0x01, 0x0d)), p[0].1)
        return p
    }

    static func ephemeral(_ v: NfcJSONObject) -> Pace.Ephemeral { Pace.Ephemeral(map: big(v.optString("skMapPcd")), agreement: big(v.optString("skPcd"))) }
}

/// RFC 4493 CMAC as a CBC-MAC (CommonCrypto AES-CBC, zero IV) over the subkey-masked message — independent of Aes.cmac.
func refCmac(_ key: [UInt8], _ m: [UInt8]) throws -> [UInt8] {
    let L = try CC.crypt(.aes, encrypt: true, ecb: true, key: key, data: [UInt8](repeating: 0, count: 16), iv: nil)
    func shift(_ x: [UInt8]) -> [UInt8] {
        var o = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 { o[i] = x[i] << 1 | (i < 15 ? x[i + 1] >> 7 : 0) }
        if x[0] & 0x80 != 0 { o[15] ^= 0x87 }
        return o
    }
    let k1 = shift(L), k2 = shift(k1)
    let n = max(1, (m.count + 15) / 16)
    let whole = !m.isEmpty && m.count % 16 == 0
    var x = m + [UInt8](repeating: 0, count: n * 16 - m.count)
    if !whole { x[m.count] = 0x80 }
    let sub = whole ? k1 : k2
    for j in 0..<16 { x[(n - 1) * 16 + j] ^= sub[j] }
    let c = try CC.crypt(.aes, encrypt: true, ecb: false, key: key, data: x, iv: [UInt8](repeating: 0, count: 16))
    return Array(c[((n - 1) * 16)...])
}

func refKdf(_ k: [UInt8], _ c: Int, _ alg: String, _ len: Int) -> [UInt8] {
    let input = k + u8(0, 0, 0, c)
    return Array((alg == "SHA-1" ? NfcHash.sha1(input) : NfcHash.sha256(input)).prefix(len))
}

/// A transport that plays the chip's side of a recorded exchange and checks every command.
final class Replay: ApduChannel {
    let pairs: [(String, String)]
    let check: (Int, String, String) -> Void
    var i = 0
    init(_ pairs: [(String, String)], check: ((Int, String, String) -> Void)? = nil) {
        self.pairs = pairs
        self.check = check ?? { i, cmd, want in #expect(cmd == want, "APDU \(i)") }
    }
    func transmit(_ cmd: [UInt8]) async throws -> [UInt8] {
        guard i < pairs.count else { throw CardFailure(message: "unexpected APDU \(H(cmd))") }
        let p = pairs[i]
        check(i, H(cmd), p.0)
        i += 1
        return b(p.1)
    }
    var done: Bool { i == pairs.count }
}

@Suite struct AesCmacTests {
    static let pt = "00112233445566778899AABBCCDDEEFF"
    static let spKey = b("2B7E151628AED2A6ABF7158809CF4F3C")
    static let spMsg = b("6BC1BEE22E409F96E93D7E117393172A AE2D8A571E03AC9C9EB76FAC45AF8E51 30C81C46A35CE411E5FBC1191A0A52EF F69F2445DF4F9B17AD2B417BE66C3710")

    @Test func aesEncryptsAndDecryptsTheFips197Blocks() throws {
        let cases = [("000102030405060708090A0B0C0D0E0F", "69C4E0D86A7B0430D8CDB78070B4C55A"),
                     ("000102030405060708090A0B0C0D0E0F1011121314151617", "DDA97CA4864CDFE06EAF70A0EC0D7191"),
                     ("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "8EA2B7CA516745BFEAFC49904B496089")]
        for (k, c) in cases {
            #expect(H(try Aes.encryptBlock(b(k), b(Self.pt))) == c)
            #expect(H(try Aes.decryptBlock(b(k), b(c))) == Self.pt)
        }
        #expect(H(try Aes.encryptBlock(Self.spKey, b("3243F6A8885A308D313198A2E0370734"))) == "3925841D02DC09FBDC118597196A0B32")
    }

    @Test func aesCbcAsInSp80038a() throws {
        let iv = b("000102030405060708090A0B0C0D0E0F")
        let ct = "7649ABAC8119B246CEE98E9B12E9197D5086CB9B507219EE95DB113A917678B273BED6B8E3C1743B7116E69E222295163FF1CAA1681FAC09120ECA307586E1A7"
        #expect(H(try Aes.cbcEncrypt(Self.spKey, Self.spMsg, iv: iv)) == ct)
        #expect(H(try Aes.cbcDecrypt(Self.spKey, b(ct), iv: iv)) == H(Self.spMsg))
        #expect(throws: NfcError.self) { try Aes.cbcEncrypt(Self.spKey, [UInt8](repeating: 0, count: 15)) }
    }

    @Test func cmacGivesTheRfc4493Tags() throws {
        #expect(H(try Aes.cmac(Self.spKey, [])) == "BB1D6929E95937287FA37D129B756746")
        #expect(H(try Aes.cmac(Self.spKey, Bytes.slice(Self.spMsg, 0, 16))) == "070A16B46B4D4144F79BDD9DD04A287C")
        #expect(H(try Aes.cmac(Self.spKey, Bytes.slice(Self.spMsg, 0, 40))) == "DFA66747DE9AE63030CA32611497C827")
        #expect(H(try Aes.cmac(Self.spKey, Self.spMsg)) == "51F0BEBF7E3B9D92FC49741779363CFE")
    }

    @Test func aesAndCmacMatchTheReferencesOnRandomKeysIvsAndLengths() throws {
        for len in [16, 24, 32] {
            for i in 0..<6 {
                let key = NfcCrypto.random(len), iv = NfcCrypto.random(16), data = NfcCrypto.random(16 * (1 + i * 3))
                // The CBC chain by hand from ECB blocks: an independent construction.
                var prev = iv, manual = [UInt8]()
                for blk in stride(from: 0, to: data.count, by: 16) {
                    let x = (0..<16).map { data[blk + $0] ^ prev[$0] }
                    prev = try Aes.encryptBlock(key, x)
                    manual += prev
                }
                #expect(H(try Aes.cbcEncrypt(key, data, iv: iv)) == H(manual))
                #expect(H(try Aes.cbcDecrypt(key, manual, iv: iv)) == H(data))
                for n in [0, 1, 15, 16, 17, 31, 32, 33, 81] {
                    let m = NfcCrypto.random(n)
                    #expect(H(try refCmac(key, m)) == H(try Aes.cmac(key, m)))
                }
            }
        }
        // The CBC-MAC reference itself reproduces RFC 4493.
        #expect(H(try refCmac(Self.spKey, Self.spMsg)) == "51F0BEBF7E3B9D92FC49741779363CFE")
        #expect(H(try refCmac(Self.spKey, [])) == "BB1D6929E95937287FA37D129B756746")
    }
}

@Suite struct CurveTests {
    @Test func coversExactlyTheStandardizedCurves() {
        #expect(EcCurve.paceCurveIds == [12, 13, 15, 16, 17, 18])
        #expect(Set(EcCurve.paceCurves.keys) == [12, 13, 15, 16, 17, 18])
        #expect(EcCurve.paceCurveIds.map { EcCurve.paceCurves[$0]!.name } == ["NIST P-256", "brainpoolP256r1", "NIST P-384", "brainpoolP384r1", "brainpoolP512r1", "NIST P-521"])
        for id in EcCurve.paceCurveIds {
            let c = EcCurve.paceCurves[id]!
            #expect(c.onCurve(c.G), "\(c.name)")
            #expect(c.h == .one)
        }
    }

    @Test func kGAndEcdhEqualNodeCryptoOnAllSixCurves() throws {
        let curves = PaceVectors.ec.optObject("curves")!
        for id in EcCurve.paceCurveIds {
            let c = EcCurve.paceCurves[id]!
            let v = curves.optObject("\(id)")!
            #expect(c.nodeName == v.optString("name"))
            #expect(c.decode(c.encode(c.G)) == c.G)
            let mul = v.objects("mul")
            #expect(mul.count == 8)
            for p in mul { #expect(H(c.encode(c.mul(PaceVectors.big(p.optString("k")))!)) == p.optString("kG"), "\(c.name) k=\(p.optString("k"))") }
            // ECDH: our x-coordinate of k1·(k2·G) is node's shared secret.
            let e = v.optObject("ecdh")!
            let k1 = PaceVectors.big(e.optString("k1")), k2 = PaceVectors.big(e.optString("k2"))
            #expect(H(try c.mul(k1, c.mul(k2))!.x.bytes(size: c.size)) == e.optString("shared"))
            #expect(H(try c.mul(k2, c.mul(k1))!.x.bytes(size: c.size)) == e.optString("shared"))
        }
    }

    @Test func groupLawsAndPointValidation() {
        for id in EcCurve.paceCurveIds {
            let c = EcCurve.paceCurves[id]!
            let k1 = c.randomScalar(), k2 = c.randomScalar()
            #expect(!k1.isZero && k1 < c.n)
            let P1 = c.mul(k1)!, P2 = c.mul(k2)!
            // (k1 + k2)·G = k1·G + k2·G, P + P = 2k·G, n·G = O, P + (−P) = O.
            #expect(c.mul(k1 + k2) == c.add(P1, P2), "\(c.name)")
            #expect(c.mul(k1.shiftedLeft(1)) == c.add(P1, P1), "\(c.name)")
            #expect(c.mul(c.n) == nil, "\(c.name)")
            #expect(c.add(P1, EcCurve.Point(x: P1.x, y: c.p - P1.y)) == nil, "\(c.name)")
            #expect(c.add(P1, nil) == P1)
            #expect(c.mul(c.n + .one) == c.G)
            // Validation: off-curve, wrong length, compressed.
            let enc = c.encode(P1)
            #expect(enc.count == 1 + 2 * c.size)
            var bad = enc
            bad[bad.count - 1] ^= 1
            #expect(c.decode(bad) == nil)
            #expect(c.decode(Bytes.slice(enc, 1)) == nil)
            #expect(c.decode(u8(0x02) + Bytes.slice(enc, 1, 1 + c.size)) == nil)
            #expect(c.decode(enc) == P1)
        }
    }

    /// The NIST curves against CryptoKit's ECDH (the JVM's SunEC on Android).
    @Test func nistCurvesMatchCryptoKitEcdhOnRandomScalars() throws {
        for _ in 0..<3 {
            let a = P256.KeyAgreement.PrivateKey(), b2 = P256.KeyAgreement.PrivateKey()
            try checkNist(EcCurve.paceCurves[12]!, a.rawRepresentation, b2.publicKey.x963Representation, try a.sharedSecretFromKeyAgreement(with: b2.publicKey).withUnsafeBytes { Array($0) })
            let c = P384.KeyAgreement.PrivateKey(), d = P384.KeyAgreement.PrivateKey()
            try checkNist(EcCurve.paceCurves[15]!, c.rawRepresentation, d.publicKey.x963Representation, try c.sharedSecretFromKeyAgreement(with: d.publicKey).withUnsafeBytes { Array($0) })
            let e = P521.KeyAgreement.PrivateKey(), f = P521.KeyAgreement.PrivateKey()
            try checkNist(EcCurve.paceCurves[18]!, e.rawRepresentation, f.publicKey.x963Representation, try e.sharedSecretFromKeyAgreement(with: f.publicKey).withUnsafeBytes { Array($0) })
        }
    }

    func checkNist(_ c: EcCurve, _ sk: Data, _ peer: Data, _ shared: [UInt8]) throws {
        let k = BigUInt(bytes: [UInt8](sk))
        let P = c.decode([UInt8](peer))
        #expect(P != nil, "\(c.name): CryptoKit's point is on the curve")
        #expect(H(try c.mul(k, P)!.x.bytes(size: c.size)) == H(shared), "\(c.name)")
    }
}

@Suite struct PaceProtocolTests {
    typealias V = PaceVectors

    @Test func kdfUsesSha1For3desAndAes128AndSha256ForAes192And256() throws {
        let K = b("0102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F20")
        #expect(H(try Pace.kdf(K, 1, "AES-128")) == H(refKdf(K, 1, "SHA-1", 16)))
        #expect(H(try Pace.kdf(K, 2, "AES-192")) == H(refKdf(K, 2, "SHA-256", 24)))
        #expect(H(try Pace.kdf(K, 3, "AES-256")) == H(refKdf(K, 3, "SHA-256", 32)))
        // 3DES: the BAC key derivation (ICAO 9303-11 Appendix D) — SHA-1, 16 bytes, DES parity.
        let seed = b("239AB9CB282DAF66231DC5A4DF6BFBAE")
        #expect(H(try Pace.kdf(seed, 1, "3DES")) == "AB94FDECF2674FDFB9B391F85D7F76F2")
        #expect(H(try Pace.kdf(seed, 2, "3DES")) == H(Bac.deriveKey(seed, 2)))
        for x in try Pace.kdf(K, 3, "3DES") { #expect(x.nonzeroBitCount % 2 == 1) }
    }

    @Test func encodesTheCanAsItsCharactersAndTheMrzAsSha1OfTheMrzInformation() {
        #expect(H(Pace.secret(.can("123456"))) == H(ascii("123456")))
        #expect(H(Pace.secret(.mrz(V.mrz(V.g1.optObject("mrz")!)))) == V.g1.optString("K"))
        #expect(Pace.Password.can("1").label == "CAN")
        #expect(Pace.Password.mrz(V.mrz(V.g1.optObject("mrz")!)).label == "MRZ")
    }

    /// Every intermediate value of a worked example, recomputed.
    @discardableResult
    func checkVector(_ v: NfcJSONObject) throws -> (info: Pace.Info, ksenc: [UInt8], ksmac: [UInt8]) {
        let info = v.has("paceInfo") ? V.infoOf(v.optString("paceInfo")) : V.bsiInfo
        let c = EcCurve.forParameterId(info.parameterId)!
        let pw: Pace.Password = v.has("mrz") ? .mrz(V.mrz(v.optObject("mrz")!)) : .can(v.optString("password"))
        if v.has("K") { #expect(H(Pace.secret(pw)) == v.optString("K")) }
        let kpi = try Pace.passwordKey(pw, info.cipher)
        #expect(H(kpi) == v.optString("kpi"))
        #expect(H(try Pace.decryptNonce(info.cipher, kpi, b(v.optString("z")))) == v.optString("s"))
        // Mapping.
        #expect(H(c.encode(c.mul(V.big(v.optString("skMapPcd")))!)) == v.optString("pkMapPcd"))
        #expect(H(c.encode(c.mul(V.big(v.optString("skMapPicc")))!)) == v.optString("pkMapPicc"))
        let mapped = try Pace.mapNonce(c, b(v.optString("s")), V.big(v.optString("skMapPcd")), c.decode(b(v.optString("pkMapPicc")))!)
        #expect(H(c.encode(mapped.H)) == v.optString("H"))
        #expect(H(c.encode(mapped.G)) == v.optString("G"))
        // The chip's side of the mapping gives the same generator.
        #expect(try Pace.mapNonce(c, b(v.optString("s")), V.big(v.optString("skMapPicc")), c.decode(b(v.optString("pkMapPcd")))!).G == mapped.G)
        // Key agreement on G̃.
        #expect(H(c.encode(c.mul(V.big(v.optString("skPcd")), mapped.G)!)) == v.optString("pkPcd"))
        #expect(H(c.encode(c.mul(V.big(v.optString("skPicc")), mapped.G)!)) == v.optString("pkPicc"))
        let k = try c.mul(V.big(v.optString("skPcd")), c.decode(b(v.optString("pkPicc"))))!.x.bytes(size: c.size)
        #expect(H(k) == v.optString("shared"))
        #expect(H(try c.mul(V.big(v.optString("skPicc")), c.decode(b(v.optString("pkPcd"))))!.x.bytes(size: c.size)) == v.optString("shared"))
        let ksenc = try Pace.kdf(k, 1, info.cipher), ksmac = try Pace.kdf(k, 2, info.cipher)
        #expect(H(ksenc) == v.optString("ksenc"))
        #expect(H(ksmac) == v.optString("ksmac"))
        // Tokens: ours over the chip's key, the chip's over ours.
        #expect(H(try Pace.authToken(info.cipher, ksmac, info.oid, b(v.optString("pkPicc")))) == v.optString("tPcd"))
        #expect(H(try Pace.authToken(info.cipher, ksmac, info.oid, b(v.optString("pkPcd")))) == v.optString("tPicc"))
        return (info, ksenc, ksmac)
    }

    @Test func icaoG1ReadsThePaceInfo() {
        let info = V.infoOf(V.g1.optString("paceInfo"))
        #expect(info.oid == "0.4.0.127.0.7.2.2.4.2.2")
        #expect(info.name == "PACE ECDH-GM AES-128")
        #expect(info.agreement == "ECDH" && info.mapping == "GM" && info.cipher == "AES-128")
        #expect(info.version == 2)
        #expect(info.parameterId == 13)
        #expect(Pace.supported(info))
    }

    @Test func icaoG1DerivesEveryValue() throws { try checkVector(V.g1) }

    @Test func icaoG1SendsExactlyTheExamplesApdusAndAcceptsTheChipsToken() async throws {
        let r = Replay(V.g1Pairs())
        let s = try await Pace.establish(r, V.infoOf(V.g1.optString("paceInfo")), .mrz(V.mrz(V.g1.optObject("mrz")!)), ephemeral: V.ephemeral(V.g1))
        #expect(r.done)
        #expect(s.cipher == "AES-128")
        #expect(H(s.ksenc) == V.g1.optString("ksenc"))
        #expect(H(s.ksmac) == V.g1.optString("ksmac"))
        #expect(H(s.ssc) == H([UInt8](repeating: 0, count: 16)))
        #expect(s.aesSm != nil)
        #expect(s.bacSession == nil)
    }

    @Test func icaoG1FailsAsAuthFailedWhenTheChipsTokenDoesNotVerify() async throws {
        var p = V.g1Pairs()
        p[4] = (p[4].0, p[4].1.replacingOccurrences(of: "3ABB9674BCE93C08", with: "3ABB9674BCE93C09"))
        let e = await #expect(throws: PaceError.self) {
            _ = try await Pace.establish(Replay(p), V.infoOf(V.g1.optString("paceInfo")), .mrz(V.mrz(V.g1.optObject("mrz")!)), ephemeral: V.ephemeral(V.g1))
        }
        #expect(e?.code == .authFailed)
        #expect(e?.message == "the document's authentication token did not verify")
    }

    @Test func mseAcceptsA63CxRetryCounter() async throws {
        var p = V.g1Pairs()
        p[0] = (p[0].0, "63C3")
        let r = Replay(p)
        _ = try await Pace.establish(r, V.infoOf(V.g1.optString("paceInfo")), .mrz(V.mrz(V.g1.optObject("mrz")!)), ephemeral: V.ephemeral(V.g1))
        #expect(r.done)
    }

    @Test func icaoI1DerivesEveryValueOfTheCamExample() throws {
        let d = try checkVector(V.i1)
        #expect(d.info.mapping == "CAM")
        #expect(!Pace.supported(d.info))
        // The encrypted chip-authentication data: AES-CBC with IV = E(KSenc, −1), M2-padded.
        let ca = V.i1.optObject("caData")!
        let plain = try Aes.cbcDecrypt(d.ksenc, b(ca.optString("encrypted")), iv: try Aes.encryptBlock(d.ksenc, [UInt8](repeating: 0xff, count: 16)))
        #expect(H(plain) == ca.optString("decrypted") + "80" + String(repeating: "00", count: 15))
    }

    @Test func bsiDerivesEveryValue() throws { try checkVector(V.bsi) }

    @Test func bsiRunsTheLoggedExchangeThenThe21LoggedSecureMessagingApdus() async throws {
        // The example's MSE:Set AT carries a CHAT and the PIN reference (eID terminal authentication), which
        // this reader does not send — so it is answered, not compared. A PIN and a CAN of the same digits encode the same.
        let sm = V.bsi.optArray("sm")!
        #expect(sm.count == 21)
        var p: [(String, String)] = [("", "9000")]
        p += V.pairs(V.bsi.optArray("apdus"))
        for row in sm { p.append((row[1]!.jsString, row[2]!.jsString)) }
        let r = Replay(p, check: { i, cmd, want in if i == 0 { #expect(cmd.hasPrefix("0022C1A4")) } else { #expect(cmd == want, "APDU \(i)") } })
        let ch = try await Pace.establish(r, V.bsiInfo, .can(V.bsi.optString("password")), ephemeral: V.ephemeral(V.bsi))
        for (i, row) in sm.enumerated() {
            let reply = try await ch.send(b(row[0]!.jsString))
            #expect(H(reply.data + sw(reply.sw)) == row[3]!.jsString, "SM \(i)")
        }
        #expect(r.done)
    }

    @Test func bsiWrapsAndUnwrapsEachLoggedApduOnItsOwn() throws {
        for (i, row) in V.bsi.optArray("sm")!.enumerated() {
            let s = try AesSm(ksenc: b(V.bsi.optString("ksenc")), ksmac: b(V.bsi.optString("ksmac")), ssc: try BigUInt(2 * i).bytes(size: 16))
            #expect(H(try s.protect(b(row[0]!.jsString))) == row[1]!.jsString, "SM \(i)")
            let r = try s.unprotect(b(row[2]!.jsString))
            #expect(H(r.data + sw(r.sw)) == row[3]!.jsString, "SM \(i)")
            #expect(H(s.ssc) == H(try BigUInt(2 * i + 2).bytes(size: 16)))
        }
    }

    @Test func aesSmRejectsAResponseWhoseMacDoesNotVerify() throws {
        var bad = b(V.bsi.optArray("sm")![0][2]!.jsString)
        bad[bad.count - 3] ^= 1
        let s = try AesSm(ksenc: b(V.bsi.optString("ksenc")), ksmac: b(V.bsi.optString("ksmac")), ssc: try BigUInt.one.bytes(size: 16))
        let e = #expect(throws: PaceError.self) { try s.unprotect(bad) }
        #expect(e?.code == .protocolError)
        #expect(e?.message.contains("MAC") == true)
    }

    @Test func aesSmPassesABareStatusWordThroughAndRejectsAnAnswerWithoutAMac() throws {
        let s = try AesSm(ksenc: [UInt8](repeating: 0, count: 16), ksmac: [UInt8](repeating: 0, count: 16), ssc: [UInt8](repeating: 0, count: 16))
        let r = try s.unprotect(b("6988"))
        #expect(r.sw == 0x6988 && r.data.isEmpty)
        #expect(H(s.ssc) == H(try BigUInt.one.bytes(size: 16)))
        let e = #expect(throws: PaceError.self) { try s.unprotect(b("990290009000")) }
        #expect(e?.message == "secure messaging: the response carries no MAC")
    }

    @Test func aesSmUsesDo85ForAnOddIns() throws {
        let s = try AesSm(ksenc: b(V.bsi.optString("ksenc")), ksmac: b(V.bsi.optString("ksmac")), ssc: [UInt8](repeating: 0, count: 16))
        let wrapped = try s.protect(b("00B10000045402010000")) // READ BINARY (odd INS) with data 54 02 01 00, Le 00
        #expect(wrapped[0] == 0x0c)
        #expect(wrapped[5] == 0x85) // the cryptogram without a padding-indicator byte
        #expect(wrapped[6] == 16)
        #expect(wrapped[7 + 16] == 0x97)
    }

    @Test func bacChannelWrapsBacSecureMessaging() async throws {
        // ICAO 9303-11 Appendix D: SELECT EF.COM under the BAC session keys.
        let s = BacDesTests.session("887022120C06C226")
        let r = Replay([("0CA4020C158709016375432908C044F68E08BF8B92D635FF24F800", "990290008E08FA855A5D4C50A8ED9000")])
        let sel = try await Pace.bacChannel(r, s).send(b("00A4020C02011E"))
        #expect(sel.sw == 0x9000)
        #expect(r.done)
    }

    @Test func mseRefusalsAreUnsupportedOrCardErrors() async throws {
        let info = V.infoOf(V.g1.optString("paceInfo"))
        let pw = Pace.Password.mrz(V.mrz(V.g1.optObject("mrz")!))
        let with84 = V.g1Pairs()[0].0, without = V.g1.optArray("apdus")![0][0]!.jsString
        let r88 = Replay([(with84, "6A88"), (without, "6A88")])
        var e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(r88, info, pw) }
        #expect(r88.done)
        #expect(e?.code == .unsupported)
        #expect(e?.message == "the document does not take the MRZ for PACE (SW 6A88)")
        #expect(e?.sw == "6A88")
        let r80 = Replay([(with84, "6A80"), (without, "6A80")])
        e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(r80, info, pw) }
        #expect(e?.code == .cardError)
        #expect(e?.sw == "6A80")
        #expect(e?.message == "the document refused PACE ECDH-GM AES-128 — Incorrect parameters in data field (SW 6A80)")
    }

    @Test func aGeneralAuthenticateErrorMidChainIsACardError() async throws {
        var p = Array(V.g1Pairs().prefix(2))
        p[1] = (p[1].0, "6A80")
        let e = await #expect(throws: PaceError.self) {
            _ = try await Pace.establish(Replay(p), V.infoOf(V.g1.optString("paceInfo")), .mrz(V.mrz(V.g1.optObject("mrz")!)), ephemeral: V.ephemeral(V.g1))
        }
        #expect(e?.code == .cardError)
        #expect(e?.message == "encrypted nonce: Incorrect parameters in data field (SW 6A80)")
    }

    @Test func refusesTheVariantsItDoesNotRunAsUnsupported() async throws {
        let chip = PaceSimChip(PaceSuite.all[0].1)
        let infos = Pace.parseSecurityInfos(T(0x31,
            T(0x30, oid("0.4.0.127.0.7.2.2.4.4.2"), integer(2), integer(13)), // ECDH-IM
            T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), integer(2), integer(0)),  // DH-GM
            T(0x30, oid("0.4.0.127.0.7.2.2.4.6.2"), integer(2), integer(13)), // ECDH-CAM
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2), integer(14)), // brainpoolP320r1
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2))               // no parameter id
        )).pace
        #expect(infos.count == 5)
        for info in infos {
            #expect(!Pace.supported(info), "\(info.name)")
            let e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(chip, info, .can(PaceSuite.can)) }
            #expect(e?.code == .unsupported)
        }
        #expect(Pace.choose(infos) == nil)
        #expect(chip.log.isEmpty)
        var e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(chip, infos[0], .can(PaceSuite.can)) }
        #expect(e?.message == "PACE ECDH-IM AES-128 (brainpoolP256r1) is not a variant this reader runs — only the generic mapping over ECDH on the standardized curves")
        e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(chip, infos[4], .can(PaceSuite.can)) }
        #expect(e?.message == "PACE ECDH-GM AES-128 is not a variant this reader runs — only the generic mapping over ECDH on the standardized curves")
    }

    @Test func choosesTheStrongestVariantItRuns() {
        let si = Pace.parseSecurityInfos(T(0x31,
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.1"), integer(2), integer(12)),  // 3DES
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2), integer(13)),  // AES-128
            T(0x30, oid("0.4.0.127.0.7.2.2.4.4.4"), integer(2), integer(13)),  // ECDH-IM AES-256 (not run)
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.4"), integer(2), integer(16)),  // AES-256
            T(0x30, oid("0.4.0.127.0.7.2.2.3.2.2"), integer(1)),               // Chip Authentication
            T(0x30, oid("1.2.3.4"), integer(1))                                // something unknown
        ) + u8(0x00, 0x00))                                                    // trailing garbage
        #expect(si.pace.count == 4)
        #expect(si.protocols == ["PACE ECDH-GM 3DES", "PACE ECDH-GM AES-128", "PACE ECDH-IM AES-256", "PACE ECDH-GM AES-256", "Chip Authentication (ECDH, AES-128)", "1.2.3.4"])
        let best = Pace.choose(si.pace)!
        #expect(best.name == "PACE ECDH-GM AES-256")
        #expect(best.parameterId == 16)
        #expect(best.description == "PACE ECDH-GM AES-256 (brainpoolP384r1)")
    }

    @Test func oidsRoundTrip() {
        for o in ["0.4.0.127.0.7.2.2.4.2.2", "1.2.840.113549.1.7.2", "2.16.840.1.101.3.4.2.1", "1.3.36.3.3.2.8.1.1.13", "1.2.4294967296.1"] { #expect(Asn1.oidText(Asn1.oidBytes(o)) == o) }
        #expect(H(Asn1.oidBytes("0.4.0.127.0.7.2.2.4.2.2")) == "04007F00070202040202")
        #expect(BerTlv.encode(0x7f49, BerTlv.encode(0x86, u8(0))) == b("7F4903860100"))
    }
}

/* ================================================================ a simulated PACE chip */

enum PaceSuite {
    struct Suite { let oid: String, cipher: String, param: Int }
    static let all: [(String, Suite)] = [
        ("AES-128 / brainpoolP256r1", Suite(oid: "0.4.0.127.0.7.2.2.4.2.2", cipher: "AES-128", param: 13)),
        ("AES-256 / brainpoolP384r1", Suite(oid: "0.4.0.127.0.7.2.2.4.2.4", cipher: "AES-256", param: 16)),
        ("AES-192 / NIST P-521", Suite(oid: "0.4.0.127.0.7.2.2.4.2.3", cipher: "AES-192", param: 18)),
        ("AES-256 / brainpoolP512r1", Suite(oid: "0.4.0.127.0.7.2.2.4.2.4", cipher: "AES-256", param: 17)),
        ("AES-128 / NIST P-384", Suite(oid: "0.4.0.127.0.7.2.2.4.2.2", cipher: "AES-128", param: 15)),
        ("3DES / NIST P-256", Suite(oid: "0.4.0.127.0.7.2.2.4.2.1", cipher: "3DES", param: 12)),
    ]
    static func named(_ n: String) -> Suite { all.first { $0.0 == n }!.1 }
    static let can = "123456"
    static let dg1 = Doc.dg1
    static let dg2 = Doc.dg2
    static let dg11 = T(0x6b, T(0x5c, u8(0x5f, 0x0e)), T(0x5f0e, ascii("ERIKSSON<<ANNA<MARIA")))
    static let com = T(0x60, T(0x5f01, ascii("0108")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x75, 0x6b)))
    static let files: [Int: [UInt8]] = [0x011e: com, 0x0101: dg1, 0x0102: dg2, 0x010b: dg11]
}

/// A PACE-only chip from the spec (ICAO 9303-11 § 4.4, § 9.8): EF.CardAccess in the clear, everything else
/// behind PACE (6982 before), no BAC. KDF, nonce encryption, tokens and AES secure messaging from
/// CommonCrypto (CMAC as a CBC-MAC); 3DES from Des (pinned to the BAC worked example); points from EcCurve.
final class PaceSimChip: ApduChannel {
    var log = [String]()
    let suite: PaceSuite.Suite
    let reject84: Bool, badToken: Bool
    let curve: EcCurve
    let aes: Bool, block: Int
    let cardAccess: [UInt8]
    var kpi: [UInt8]?
    var step = 0
    var s = [UInt8](), pkPcd = [UInt8](), pkPicc = [UInt8]()
    var gMapped: EcCurve.Point
    var ksenc: [UInt8]?, ksmac = [UInt8](), ssc = [UInt8]()
    var pendingEnc: [UInt8]?, pendingMac: [UInt8]?
    var selected: Int?
    var app = false

    init(_ suite: PaceSuite.Suite, reject84: Bool = false, badToken: Bool = false) {
        self.suite = suite; self.reject84 = reject84; self.badToken = badToken
        curve = EcCurve.paceCurves[suite.param]!
        aes = suite.cipher != "3DES"
        block = aes ? 16 : 8
        gMapped = curve.G
        cardAccess = T(0x31, T(0x30, oid(suite.oid), integer(2), integer(suite.param)), T(0x30, oid("0.4.0.127.0.7.2.2.4.4.2"), integer(2), integer(13)))
    }

    static func inc(_ c: inout [UInt8]) { var i = c.count - 1; while i >= 0 { c[i] &+= 1; if c[i] != 0 { break }; i -= 1 } }
    func padB(_ d: [UInt8]) -> [UInt8] { Des.pad(d, block: block) }
    static func unpadB(_ d: [UInt8]) -> [UInt8] { var i = d.count - 1; while d[i] == 0 { i -= 1 }; return Bytes.slice(d, 0, i) }

    func kdf(_ k: [UInt8], _ c: Int) -> [UInt8] {
        switch suite.cipher {
        case "3DES", "AES-128": return refKdf(k, c, "SHA-1", 16)
        case "AES-192": return refKdf(k, c, "SHA-256", 24)
        default: return refKdf(k, c, "SHA-256", 32)
        }
    }

    func enc(_ k: [UInt8], _ d: [UInt8], _ iv: [UInt8]?) throws -> [UInt8] { aes ? try CC.crypt(.aes, encrypt: true, ecb: false, key: k, data: d, iv: iv) : try Des.tdesCbcEncrypt(k, d) }
    func dec(_ k: [UInt8], _ d: [UInt8], _ iv: [UInt8]?) throws -> [UInt8] { aes ? try CC.crypt(.aes, encrypt: false, ecb: false, key: k, data: d, iv: iv) : try Des.tdesCbcDecrypt(k, d) }
    func iv() throws -> [UInt8]? { aes ? try CC.crypt(.aes, encrypt: true, ecb: true, key: ksenc!, data: ssc, iv: nil) : nil }
    /// The SM checksum over already padded input (§ 9.8: the SM layer pads).
    func mac(_ k: [UInt8], _ padded: [UInt8]) throws -> [UInt8] { aes ? Array(try refCmac(k, padded).prefix(8)) : try Des.retailMac(k, padded) }
    /// The token: CMAC pads itself, the retail MAC over M2 padding (§ 4.4.3.4).
    func token(_ k: [UInt8], _ pk: [UInt8]) throws -> [UInt8] {
        let d = T(0x7f49, oid(suite.oid), T(0x86, pk))
        return aes ? Array(try refCmac(k, d).prefix(8)) : try Des.retailMac(k, Des.pad(d))
    }

    /// SELECT / READ BINARY over the files; only EF.CardAccess before PACE.
    func run(_ ins: Int, _ p1: Int, _ p2: Int, _ data: [UInt8], _ le: Int?) -> ([UInt8], [UInt8]) {
        if ins == 0xa4 && p1 == 0x04 { app = data == MrtdReader.aid; return ([], sw(app ? 0x9000 : 0x6a82)) }
        if ins == 0xa4 {
            guard data.count >= 2 else { return ([], sw(0x6a80)) }
            let fid = Int(data[0]) << 8 | Int(data[1])
            if fid == 0x011c { selected = fid; return ([], sw(0x9000)) }
            if ksenc == nil { return ([], sw(0x6982)) }
            if !app || PaceSuite.files[fid] == nil { return ([], sw(0x6a82)) }
            selected = fid
            return ([], sw(0x9000))
        }
        if ins == 0xb0 {
            guard let sel = selected, let f = sel == 0x011c ? cardAccess : ksenc != nil ? PaceSuite.files[sel] : nil else { return ([], sw(0x6982)) }
            let off = p1 << 8 | p2, n = le == nil || le == 0 ? 256 : le!
            return (Bytes.slice(f, off, off + n), sw(off + n > f.count ? 0x6282 : 0x9000))
        }
        return ([], sw(0x6d00))
    }

    static func get(_ dos: [Tlv], _ tag: Int) -> [UInt8]? {
        if let n = dos.first(where: { $0.tag == tag }) { return n.value }
        return dos.first?.children?.first { $0.tag == tag }?.value
    }

    func plainCommand(_ a: [UInt8]) throws -> [UInt8] {
        let cla = Int(a[0]), ins = Int(a[1]), p1 = Int(a[2]), p2 = Int(a[3])
        let lc = a.count > 5 ? Int(a[4]) : 0
        let data = Bytes.slice(a, 5, 5 + lc)
        let dos = lc > 0 && (ins == 0x22 || ins == 0x86) ? BerTlv.decode(data, recurse: true) : []
        if ins == 0x22 && p1 == 0xc1 && p2 == 0xa4 { // MSE:Set AT
            step = 0; kpi = nil
            guard let o = PaceSimChip.get(dos, 0x80), o == Asn1.oidBytes(suite.oid) else { return sw(0x6a80) }
            if let p84 = PaceSimChip.get(dos, 0x84), reject84 || Int(p84[0]) != suite.param { return sw(0x6a80) }
            let ref = PaceSimChip.get(dos, 0x83)
            let secret: [UInt8]? = ref?.first == 0x02 ? ascii(PaceSuite.can) : ref?.first == 0x01 ? NfcHash.sha1(ascii("L898902C<369080619406236")) : nil
            guard let secret else { return sw(0x6a88) }
            kpi = kdf(secret, 3)
            step = 1
            return sw(0x9000)
        }
        if ins == 0x86 { // GENERAL AUTHENTICATE, chained
            guard let kpi, step >= 1 else { return sw(0x6985) }
            if (cla == 0x10) != (step < 4) { step = 0; return sw(0x6883) }
            if step == 1 {
                s = NfcCrypto.random(16)
                step = 2
                return T(0x7c, T(0x80, try enc(kpi, s, [UInt8](repeating: 0, count: 16)))) + sw(0x9000)
            }
            if step == 2 {
                guard let pkMapPcd = curve.decode(PaceSimChip.get(dos, 0x81)) else { step = 0; return sw(0x6a80) }
                let sk = curve.randomScalar()
                gMapped = curve.add(curve.mul(BigUInt(bytes: s)), curve.mul(sk, pkMapPcd))!
                step = 3
                return T(0x7c, T(0x82, curve.encode(curve.mul(sk)!))) + sw(0x9000)
            }
            if step == 3 {
                pkPcd = PaceSimChip.get(dos, 0x83) ?? []
                guard let P = curve.decode(pkPcd) else { step = 0; return sw(0x6a80) }
                let sk = curve.randomScalar()
                pkPicc = curve.encode(curve.mul(sk, gMapped)!)
                let k = try curve.mul(sk, P)!.x.bytes(size: curve.size)
                pendingEnc = kdf(k, 1); pendingMac = kdf(k, 2)
                step = 4
                return T(0x7c, T(0x84, pkPicc)) + sw(0x9000)
            }
            // Step 4: check the terminal's token over our key, answer with ours over theirs.
            step = 0
            guard let pm = pendingMac, let t85 = PaceSimChip.get(dos, 0x85), t85 == (try token(pm, pkPicc)) else { return sw(0x6300) }
            var t = try token(pm, pkPcd)
            if badToken { t[0] ^= 1 }
            ksenc = pendingEnc; ksmac = pm; ssc = [UInt8](repeating: 0, count: block)
            return T(0x7c, T(0x86, t)) + sw(0x9000)
        }
        if ins == 0x84 { return sw(0x6d00) } // no BAC on this chip
        let le: Int? = a.count == 5 ? Int(a[4]) : a.count > 5 + lc ? Int(a[5 + lc]) : nil
        let r = run(ins, p1, p2, data, le)
        return r.0 + r.1
    }

    /// Secure messaging (§ 9.8): check the MAC, decrypt, run, wrap the answer.
    func smCommand(_ a: [UInt8]) throws -> [UInt8] {
        guard a[0] & 0x0c == 0x0c else { ksenc = nil; return sw(0x6987) }
        var do87: [UInt8]?, do97: [UInt8]?, do8e: [UInt8]?
        for n in BerTlv.decode(Bytes.slice(a, 5, 5 + Int(a[4])), recurse: false) {
            if n.tag == 0x87 { do87 = n.value } else if n.tag == 0x97 { do97 = n.value } else if n.tag == 0x8e { do8e = n.value }
        }
        PaceSimChip.inc(&ssc)
        let macIn = padB(ssc + padB(Bytes.slice(a, 0, 4)) + (do87.map { T(0x87, $0) } ?? []) + (do97.map { T(0x97, $0) } ?? []))
        guard let m = do8e, try mac(ksmac, macIn) == m else { ksenc = nil; return sw(0x6988) }
        let data = try do87.map { PaceSimChip.unpadB(try dec(ksenc!, Bytes.slice($0, 1), try iv())) } ?? []
        let r = run(Int(a[1]), Int(a[2]), Int(a[3]), data, do97.map { Int($0[0]) })
        PaceSimChip.inc(&ssc)
        let r87 = r.0.isEmpty ? [] : T(0x87, u8(0x01), try enc(ksenc!, padB(r.0), try iv()))
        let r99 = T(0x99, r.1)
        return r87 + r99 + T(0x8e, try mac(ksmac, padB(ssc + r87 + r99))) + sw(0x9000)
    }

    func transmit(_ cmd: [UInt8]) async throws -> [UInt8] {
        log.append(H(cmd))
        return ksenc != nil ? try smCommand(cmd) : try plainCommand(cmd)
    }
}

/// SELECT the EF and READ BINARY it in chunks — what the reader does over any channel.
func readFile(_ ch: SecureMessagingChannel, _ fid: Int) async throws -> [UInt8] {
    let sel = try await ch.send(Apdu.selectByFid(fid, p2: 0x0c))
    guard Apdu.isOk(sel.sw) else { throw CardFailure(message: "select \(String(fid, radix: 16)): SW \(StatusWords.hex(sel.sw))") }
    var out = [UInt8]()
    var off = 0
    for _ in 0..<64 {
        let r = try await ch.send(Apdu.readBinary(off, le: 0xdf))
        out += r.data
        off += r.data.count
        if r.sw != 0x9000 || r.data.count < 0xdf { break }
    }
    return out
}

/// The plain channel, before PACE.
final class PlainChannel: SecureMessagingChannel {
    let t: any ApduChannel
    init(_ t: any ApduChannel) { self.t = t }
    var kind: String { "plain" }
    func send(_ cmd: [UInt8]) async throws -> SmReply { let r = Apdu.split(try await t.transmit(cmd)); return SmReply(data: r.data, sw: r.sw) }
}

@Suite struct PaceChipTests {
    /// EF.CardAccess in the clear → the PACEInfo to run → PACE → the eMRTD application over SM (mrtd.ts's order).
    func open(_ chip: PaceSimChip, _ pw: Pace.Password) async throws -> PaceSession {
        let si = Pace.parseSecurityInfos(try await readFile(PlainChannel(chip), 0x011c))
        #expect(si.pace.count == 2)
        #expect(si.protocols.contains("PACE ECDH-IM AES-128"))
        let info = try #require(Pace.choose(si.pace))
        #expect(info.mapping == "GM")
        let s = try await Pace.establish(chip, info, pw)
        let sel = try await s.send(Apdu.build(0x00, 0xa4, 0x04, 0x0c, data: MrtdReader.aid))
        #expect(sel.sw == 0x9000)
        return s
    }

    /// The reader end to end (6.6 integration): MrtdReader opens a PACE-only chip with the CAN alone.
    @Test func theReaderOpensAPaceOnlyChipWithTheCan() async throws {
        for name in ["AES-128 / brainpoolP256r1", "3DES / NIST P-256"] {
            let d = await MrtdReader.read(PaceSimChip(PaceSuite.named(name)), MrtdReader.Options(can: PaceSuite.can))
            #expect(d.optString("access") == "pace", "\(name)")
            #expect(d.optObject("pace")?.optString("password") == "can")
            #expect(d.optObject("pace")?.optBool("used") == true)
            #expect(d.optObject("mrzInfo")?.optString("surname") == "ERIKSSON")
            #expect(d.objects("images").first?.optString("kind") == "face")
            #expect(!d.has("message"), "\(name): \(d.optString("message"))")
        }
        // A wrong CAN: nothing read, and the reason.
        let d = await MrtdReader.read(PaceSimChip(PaceSuite.named("AES-128 / brainpoolP256r1")), MrtdReader.Options(can: "654321"))
        #expect(d.optString("access") == "none")
        #expect(d.optString("message").hasPrefix("PACE: "))
        #expect(!d.has("mrzInfo"))
    }

    @Test func simulatedChipOpensWithTheCanOverEverySuiteAndReadsTheDocument() async throws {
        for (name, suite) in PaceSuite.all {
            let chip = PaceSimChip(suite)
            let s = try await open(chip, .can(PaceSuite.can))
            #expect(s.cipher == suite.cipher, "\(name)")
            #expect(s.info.parameterId == suite.param)
            #expect(s.ssc.count == (suite.cipher == "3DES" ? 8 : 16))
            #expect(H(try await readFile(s, 0x011e)) == H(PaceSuite.com), "\(name)")
            #expect(H(try await readFile(s, 0x0101)) == H(PaceSuite.dg1), "\(name)")
            #expect(H(try await readFile(s, 0x0102)) == H(PaceSuite.dg2), "\(name)")
            #expect(H(try await readFile(s, 0x010b)) == H(PaceSuite.dg11), "\(name)")
            #expect(MrtdReader.mrzFromDg1(PaceSuite.dg1)?.optString("surname") == "ERIKSSON")
            // The protocol as sent: MSE:Set AT with the CAN (83 01 02) and the parameter id, the chained GA, then only SM.
            let mse = chip.log.filter { $0.hasPrefix("0022C1A4") }
            #expect(mse.count == 1)
            #expect(mse[0].hasSuffix("830102" + "8401" + String(format: "%02X", suite.param)))
            let ga = chip.log.filter { $0.fullMatch("[01]086.*") }
            #expect(ga.map { String($0.prefix(2)) } == ["10", "10", "10", "00"])
            let after = chip.log[(chip.log.firstIndex(of: ga[3])! + 1)...]
            #expect(after.count > 5)
            for l in after { #expect(l.hasPrefix("0C"), "\(name): \(l)") }
        }
    }

    @Test func simulatedChipOpensWithTheMrz() async throws {
        let chip = PaceSimChip(PaceSuite.named("AES-128 / brainpoolP256r1"))
        let s = try await open(chip, .mrz(Doc.key))
        #expect(H(try await readFile(s, 0x0101)) == H(PaceSuite.dg1))
        #expect(chip.log.last { $0.hasPrefix("0022C1A4") }?.contains("830101") == true)
    }

    @Test func simulatedChipOpensWithTheMrzOver3des() async throws {
        let chip = PaceSimChip(PaceSuite.named("3DES / NIST P-256"))
        let s = try await open(chip, .mrz(Doc.key))
        #expect(s.bacSession != nil)
        #expect(s.aesSm == nil)
        #expect(H(try await readFile(s, 0x0102)) == H(PaceSuite.dg2))
    }

    static func infoFor(_ suite: PaceSuite.Suite) -> Pace.Info { Pace.parseSecurityInfos(T(0x31, T(0x30, oid(suite.oid), integer(2), integer(suite.param)))).pace[0] }

    @Test func aWrongCanIsAuthFailedAndNothingIsRead() async {
        for name in ["AES-128 / brainpoolP256r1", "3DES / NIST P-256"] {
            let suite = PaceSuite.named(name)
            let chip = PaceSimChip(suite)
            let e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(chip, Self.infoFor(suite), .can("654321")) }
            #expect(e?.code == .authFailed, "\(name)")
            #expect(e?.message == "the document did not accept the CAN (SW 6300)")
            #expect(e?.sw == "6300")
            for l in chip.log { #expect(!l.hasPrefix("0C"), "\(name): \(l)") }
        }
    }

    @Test func aWrongChipTokenIsAuthFailed() async {
        let suite = PaceSuite.named("AES-256 / brainpoolP384r1")
        let e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(PaceSimChip(suite, badToken: true), Self.infoFor(suite), .can(PaceSuite.can)) }
        #expect(e?.code == .authFailed)
        #expect(e?.message == "the document's authentication token did not verify")
    }

    @Test func asksAgainWithoutTheParameterReferenceWhenTheChipRefusesIt() async throws {
        let chip = PaceSimChip(PaceSuite.named("AES-128 / brainpoolP256r1"), reject84: true)
        let s = try await open(chip, .can(PaceSuite.can))
        #expect(H(try await readFile(s, 0x0101)) == H(PaceSuite.dg1))
        let mse = chip.log.filter { $0.hasPrefix("0022C1A4") }
        #expect(mse.count == 2)
        #expect(mse[0].contains("84010D"))
        #expect(!mse[1].contains("84010D"))
    }
}
