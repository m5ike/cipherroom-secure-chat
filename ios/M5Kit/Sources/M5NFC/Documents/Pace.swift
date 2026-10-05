// PACE — Password Authenticated Connection Establishment (6.6), ICAO 9303 Part
// 11 § 4.4 / BSI TR-03110 — A/nfc/PaceProtocol.java + A/nfc/Pace.java (pace.ts).
// The holder opens their own document with the CAN printed on it (or the MRZ);
// chip and reader agree on session keys and every later APDU is wrapped in
// secure messaging (AES or 3DES). The document's own access control, not a
// bypass — and many EU ID cards offer only PACE. Read-only.
//
// The generic mapping over ECDH on the six standardized curves, 3DES or AES:
//   1. the chip's nonce s, encrypted with Kπ = KDF(f(π), 3);
//   2. map it: G̃ = s·G + SK_map·PK_map(chip);
//   3. ephemeral ECDH on G̃ → shared secret K (x-coordinate) → KSenc, KSmac;
//   4. exchange tokens MAC(KSmac, 7F49 { OID, the other side's key }).
// Pinned to ICAO 9303-11 Appendix G.1 / I.1 and the BSI TR-03110 worked example,
// byte for byte (PaceTests, the same vectors as test/nfc-pace.test.ts).
//
// iOS: CoreNFC polls PACE-only ID cards with NFCTagReaderSession.PollingOption.pace
// (entitlement format "PACE"); the protocol itself runs here, over the transport's APDUs.

import Foundation
import M5Core

/// Why PACE did not open the document (PaceProtocol.PaceException).
public struct PaceError: Error, Sendable, CustomStringConvertible, LocalizedError {
    public enum Code: String, Sendable {
        /// The chip refused the password, or its token did not verify.
        case authFailed = "auth-failed"
        /// A variant this reader does not run, or a password the chip does not take.
        case unsupported
        /// Another status word.
        case cardError = "card-error"
        /// A malformed answer.
        case protocolError = "protocol"
    }
    public let code: Code
    public let message: String
    /// The status word ("6300") when one was the reason.
    public let sw: String?
    public init(_ code: Code, _ message: String, sw: String? = nil) { self.code = code; self.message = message; self.sw = sw }
    public var description: String { message }
    public var errorDescription: String? { message }
}

public enum Pace {
    /* ------------------------------------------------------------ what the chip announces */

    /// One PACEInfo (a PACE variant the chip runs).
    public struct Info: Sendable, Hashable, CustomStringConvertible {
        /// The protocol OID, dotted.
        public let oid: String
        /// Its name ("PACE ECDH-GM AES-128").
        public let name: String
        public let version: Int
        /// The standardized domain parameters (12 = NIST P-256, 13 = brainpoolP256r1…); nil when absent.
        public let parameterId: Int?
        /// "DH" / "ECDH".
        public let agreement: String
        /// "GM" / "IM" / "CAM".
        public let mapping: String
        /// "3DES" / "AES-128" / "AES-192" / "AES-256".
        public let cipher: String

        public init(oid: String, name: String, version: Int, parameterId: Int?, agreement: String, mapping: String, cipher: String) {
            self.oid = oid; self.name = name; self.version = version; self.parameterId = parameterId
            self.agreement = agreement; self.mapping = mapping; self.cipher = cipher
        }

        public var description: String { name + (parameterId.map { " (\(Pace.parameterName($0)))" } ?? "") }
    }

    /// What a SecurityInfos (EF.CardAccess, DG14) announces: the PACE variants, and every protocol by name.
    public struct SecurityInfos: Sendable { public let pace: [Info]; public let protocols: [String] }

    /// The standardized domain parameters (BSI TR-03110 Part 3, Table 4).
    public static let parameters: [Int: String] = [
        0: "1024-bit MODP (160-bit subgroup)", 1: "2048-bit MODP (224-bit subgroup)", 2: "2048-bit MODP (256-bit subgroup)",
        8: "NIST P-192", 9: "brainpoolP192r1", 10: "NIST P-224", 11: "brainpoolP224r1", 12: "NIST P-256",
        13: "brainpoolP256r1", 14: "brainpoolP320r1", 15: "NIST P-384", 16: "brainpoolP384r1", 17: "brainpoolP512r1", 18: "NIST P-521",
    ]

    /// "brainpoolP256r1", or "parameters 99" for an id outside the table.
    public static func parameterName(_ id: Int) -> String { parameters[id] ?? "parameters \(id)" }

    static let pacePrefix = "0.4.0.127.0.7.2.2.4."
    static let agreements: [String: (String, String)] = ["1": ("DH", "GM"), "2": ("ECDH", "GM"), "3": ("DH", "IM"), "4": ("ECDH", "IM"), "6": ("ECDH", "CAM")]
    static let ciphers: [String: String] = ["1": "3DES", "2": "AES-128", "3": "AES-192", "4": "AES-256"]

    /// Parses a SecurityInfos (the SET in EF.CardAccess or DG14). Tolerates trailing garbage; unknown infos are listed by OID.
    public static func parseSecurityInfos(_ bytes: [UInt8]) -> SecurityInfos {
        let top = BerTlv.decode(bytes, recurse: true)
        let set = top.first { $0.tag == 0x31 } ?? top.first
        var pace = [Info](), protocols = [String]()
        for info in Asn1.kids(set) {
            let k = Asn1.kids(info)
            guard let first = k.first, first.tag == 0x06 else { continue }
            let oid = Asn1.oidText(first.value)
            let name = Asn1.oidName(oid)
            if !protocols.contains(name) { protocols.append(name) }
            guard oid.hasPrefix(pacePrefix) else { continue }
            let rest = oid.dropFirst(pacePrefix.count).split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            guard let a = agreements[rest[0]], rest.count > 1, let c = ciphers[rest[1]] else { continue } // domain parameter info, or newer
            let version = k.count > 1 && k[1].tag == 0x02 && !k[1].value.isEmpty ? Int(k[1].value[k[1].value.count - 1]) : 0
            var param: Int? = nil
            if k.count > 2 && k[2].tag == 0x02 {
                var v: Int64 = 0
                for x in k[2].value { v = min(v * 256 + Int64(x), Int64(Int32.max)) }
                param = Int(v)
            }
            pace.append(Info(oid: oid, name: name, version: version, parameterId: param, agreement: a.0, mapping: a.1, cipher: c))
        }
        return SecurityInfos(pace: pace, protocols: protocols)
    }

    /// Whether this reader runs a variant: the generic mapping over ECDH on a standardized curve it knows.
    public static func supported(_ info: Info) -> Bool {
        info.mapping == "GM" && info.agreement == "ECDH" && EcCurve.forParameterId(info.parameterId) != nil
    }

    static let cipherRank = ["3DES", "AES-128", "AES-192", "AES-256"]

    /// The variant to use: the strongest one this reader runs, or nil.
    public static func choose(_ infos: [Info]) -> Info? {
        let ok = infos.filter(supported)
        // A stable sort by the cipher's strength, strongest first (as Array.sort / List.sort).
        let ranked = ok.enumerated().sorted { x, y in
            let rx = cipherRank.firstIndex(of: x.element.cipher) ?? -1, ry = cipherRank.firstIndex(of: y.element.cipher) ?? -1
            return rx != ry ? rx > ry : x.offset < y.offset
        }
        return ranked.first?.element
    }

    /* ------------------------------------------------------------ the password and the keys */

    /// The holder's password: the CAN printed on the document, or the MRZ key.
    public enum Password: Sendable, Hashable {
        case can(String)
        case mrz(MrzKey)
        public var isMrz: Bool { if case .mrz = self { return true }; return false }
        /// "CAN" / "MRZ" — as the messages name it.
        public var label: String { isMrz ? "MRZ" : "CAN" }
    }

    /// Fixed ephemeral private keys (mapping, key agreement) — only to replay a worked example.
    public struct Ephemeral: Sendable { public let map: BigUInt, agreement: BigUInt
        public init(map: BigUInt, agreement: BigUInt) { self.map = map; self.agreement = agreement }
    }

    /// f(π) (ICAO 9303-11 Table 14): the CAN as its ISO 8859-1 characters; the MRZ as SHA-1 of its MRZ
    /// information — all 20 bytes, unlike BAC's 16-byte seed.
    public static func secret(_ password: Password) -> [UInt8] {
        switch password {
        case .can(let can): return Bytes.latin1(can)
        case .mrz(let key): return NfcHash.sha1(Array(Bac.mrzInformation(key).utf8))
        }
    }

    /// KDF(K, c) = H(K ‖ c), c a 32-bit big-endian counter (§ 9.7.1): SHA-1 → 16 bytes for 3DES (DES parity set)
    /// and AES-128; SHA-256 → 24 / 32 bytes for AES-192 / AES-256. c = 1: KSenc, 2: KSmac, 3: Kπ.
    public static func kdf(_ secret: [UInt8], _ counter: Int, _ cipher: String) throws -> [UInt8] {
        let input = secret + Bytes.u8(counter >> 24, counter >> 16, counter >> 8, counter)
        switch cipher {
        case "3DES": return Bac.fixParity(Array(NfcHash.sha1(input)[0..<16]))
        case "AES-128": return Array(NfcHash.sha1(input)[0..<16])
        case "AES-192": return Array(NfcHash.sha256(input)[0..<24])
        case "AES-256": return Array(NfcHash.sha256(input)[0..<32])
        default: throw NfcError(.invalidArgument, "unknown PACE cipher \(cipher)")
        }
    }

    /// Kπ = KDF(f(π), 3): the key the chip's nonce is encrypted with.
    public static func passwordKey(_ password: Password, _ cipher: String) throws -> [UInt8] { try kdf(secret(password), 3, cipher) }

    /// s = D(Kπ, z): CBC, zero IV, no padding.
    public static func decryptNonce(_ cipher: String, _ kpi: [UInt8], _ z: [UInt8]) throws -> [UInt8] {
        let tdes = cipher == "3DES"
        let block = tdes ? 8 : 16
        guard !z.isEmpty, z.count % block == 0 else {
            throw PaceError(.protocolError, "the encrypted nonce is \(z.count) bytes, not whole \(block)-byte blocks")
        }
        return tdes ? try Des.tdesCbcDecrypt(kpi, z) : try Aes.cbcDecrypt(kpi, z)
    }

    /// The generic mapping (§ 4.4.3.3.1): H = SK_map·PK_map(chip), G̃ = s·G + H.
    public static func mapNonce(_ curve: EcCurve, _ s: [UInt8], _ skMap: BigUInt, _ pkMapChip: EcCurve.Point) throws -> (H: EcCurve.Point, G: EcCurve.Point) {
        guard let H = curve.mul(skMap, pkMapChip), let G = curve.add(curve.mul(BigUInt(bytes: s)), H) else {
            throw PaceError(.protocolError, "the mapped generator is the point at infinity")
        }
        return (H, G)
    }

    /// An authentication token (§ 4.4.3.4): the MAC under KSmac of 7F49 { 06 OID, 86 the ephemeral point } —
    /// AES-CMAC cut to 8 bytes, or for 3DES the retail MAC over the M2-padded input.
    public static func authToken(_ cipher: String, _ ksmac: [UInt8], _ oid: String, _ publicKey: [UInt8]) throws -> [UInt8] {
        let data = BerTlv.encode(0x7f49, BerTlv.encode(0x06, Asn1.oidBytes(oid)) + BerTlv.encode(0x86, publicKey))
        return cipher == "3DES" ? try Des.retailMac(ksmac, Des.pad(data)) : Array(try Aes.cmac(ksmac, data)[0..<8])
    }

    /* ------------------------------------------------------------ the protocol */

    /// MSE:Set AT accepted: 9000, or 63Cx — a retry counter some cards report, the protocol still selected.
    static func selected(_ sw: Int) -> Bool { Apdu.isOk(sw) || ((sw & 0xfff0) == 0x63c0 && (sw & 0x0f) > 0) }

    static func exchange(_ t: any ApduChannel, _ cmd: [UInt8]) async throws -> Apdu.Response {
        let raw = try await t.transmit(cmd)
        guard raw.count >= 2 else { throw PaceError(.protocolError, "Response shorter than SW1SW2 (\(raw.count) bytes)") }
        return Apdu.split(raw)
    }

    /// One GENERAL AUTHENTICATE of the chain (CLA 10 while more follow); the data objects inside 7C.
    static func authenticate(_ t: any ApduChannel, _ password: Password, _ dos: [UInt8], _ step: String, last: Bool) async throws -> [Tlv] {
        let r = try await exchange(t, Apdu.build(last ? 0x00 : 0x10, 0x86, 0x00, 0x00, data: BerTlv.encode(0x7c, dos), le: 0))
        if !Apdu.isOk(r.sw) {
            let refused = last || (r.sw >> 8) == 0x63 || r.sw == 0x6983 || r.sw == 0x6984
            let sw = StatusWords.hex(r.sw)
            throw PaceError(refused ? .authFailed : .cardError,
                            refused ? "the document did not accept the \(password.label) (SW \(sw))" : "\(step): \(StatusWords.describe(r.sw)) (SW \(sw))", sw: sw)
        }
        guard let dyn = BerTlv.find(BerTlv.decode(r.data, recurse: true), 0x7c) else {
            throw PaceError(.protocolError, "\(step): the answer carries no dynamic authentication data (7C)")
        }
        return dyn.children ?? []
    }

    static func valueOf(_ dos: [Tlv], _ tag: Int) -> [UInt8]? { BerTlv.find(dos, tag)?.value }

    /// Runs PACE with the holder's CAN or MRZ and returns the secure-messaging session (SSC zero), bound
    /// to `t`. Throws `PaceError`: auth-failed when the chip refuses the password (63xx, or its token does
    /// not verify), unsupported for a variant this reader does not run, card-error / protocol otherwise.
    /// `ephemeral` fixes the two private keys (tests replaying a worked example); nil for random ones.
    public static func establish(_ t: any ApduChannel, _ info: Info, _ password: Password, ephemeral: Ephemeral? = nil) async throws -> PaceSession {
        guard supported(info), let curve = EcCurve.forParameterId(info.parameterId) else {
            let param = info.parameterId.map { " (\(parameterName($0)))" } ?? ""
            throw PaceError(.unsupported, "\(info.name)\(param) is not a variant this reader runs — only the generic mapping over ECDH on the standardized curves")
        }
        let cipher = info.cipher

        // MSE:Set AT — the protocol (80), the password (83: 01 MRZ, 02 CAN) and the domain parameters (84).
        // 84 is optional; a chip that refuses it is asked again without.
        let mse = BerTlv.encode(0x80, Asn1.oidBytes(info.oid)) + BerTlv.encode(0x83, [password.isMrz ? 0x01 : 0x02])
        var set = try await exchange(t, Apdu.build(0x00, 0x22, 0xc1, 0xa4, data: mse + BerTlv.encode(0x84, [UInt8(info.parameterId ?? 0)])))
        if !selected(set.sw) { set = try await exchange(t, Apdu.build(0x00, 0x22, 0xc1, 0xa4, data: mse)) }
        if !selected(set.sw) {
            if set.sw == 0x6a88 { throw PaceError(.unsupported, "the document does not take the \(password.label) for PACE (SW 6A88)", sw: "6A88") }
            let sw = StatusWords.hex(set.sw)
            throw PaceError(.cardError, "the document refused \(info.name) — \(StatusWords.describe(set.sw)) (SW \(sw))", sw: sw)
        }

        // 1. The encrypted nonce.
        let kpi = try passwordKey(password, cipher)
        guard let z = valueOf(try await authenticate(t, password, [], "encrypted nonce", last: false), 0x80) else {
            throw PaceError(.protocolError, "no encrypted nonce (80) in the answer")
        }
        let s = try decryptNonce(cipher, kpi, z)

        // 2. Map the nonce to a new generator.
        let skMap = ephemeral?.map ?? curve.randomScalar()
        guard let pkMap = curve.mul(skMap) else { throw PaceError(.protocolError, "the mapping key is the point at infinity") }
        let mapped = valueOf(try await authenticate(t, password, BerTlv.encode(0x81, curve.encode(pkMap)), "map nonce", last: false), 0x82)
        guard let pkMapChip = curve.decode(mapped) else { throw PaceError(.protocolError, "the document's mapping key is not a point of the curve") }
        let G = try mapNonce(curve, s, skMap, pkMapChip).G

        // 3. Key agreement on G̃.
        let sk = ephemeral?.agreement ?? curve.randomScalar()
        guard let pkPcdPoint = curve.mul(sk, G) else { throw PaceError(.protocolError, "the ephemeral key is the point at infinity") }
        let pkPcd = curve.encode(pkPcdPoint)
        let pkChipBytes = valueOf(try await authenticate(t, password, BerTlv.encode(0x83, pkPcd), "key agreement", last: false), 0x84)
        guard let pkChip = curve.decode(pkChipBytes), let chipBytes = pkChipBytes, chipBytes != pkPcd else {
            throw PaceError(.protocolError, "the document's ephemeral key is invalid")
        }
        guard let shared = curve.mul(sk, pkChip) else { throw PaceError(.protocolError, "the shared secret is the point at infinity") }
        let k = try shared.x.bytes(size: curve.size)
        let ksenc = try kdf(k, 1, cipher), ksmac = try kdf(k, 2, cipher)

        // 4. Mutual authentication: our token over the chip's key, theirs over ours.
        let answer = try await authenticate(t, password, BerTlv.encode(0x85, try authToken(cipher, ksmac, info.oid, chipBytes)), "mutual authentication", last: true)
        guard let tChip = valueOf(answer, 0x86), Bytes.constantTimeEqual(tChip, try authToken(cipher, ksmac, info.oid, pkPcd)) else {
            throw PaceError(.authFailed, "the document's authentication token did not verify")
        }

        // Secure messaging from here, the SSC starting at zero (§ 9.8.6.3, § 9.8.7.3).
        return try PaceSession(t, info, ksenc: ksenc, ksmac: ksmac)
    }

    /// The channel a BAC session gives, as a PACE caller holds it (PaceProtocol.bacChannel).
    public static func bacChannel(_ t: any ApduChannel, _ s: Bac.Session) -> SecureMessagingChannel { BacChannel(t, s) }
}

/// An open PACE session: the session keys and the secure-messaging state (AES, or 3DES as BAC's),
/// bound to the transport it was established on.
public final class PaceSession: SecureMessagingChannel {
    public let info: Pace.Info
    /// "3DES" / "AES-128" / "AES-192" / "AES-256".
    public let cipher: String
    public let ksenc: [UInt8], ksmac: [UInt8]
    public var kind: String { "pace" }
    let transport: any ApduChannel
    /// The AES secure messaging (nil for 3DES).
    public let aesSm: AesSm?
    /// The 3DES secure messaging as a BAC session, SSC 8 zero bytes (nil for AES).
    public let bacSession: Bac.Session?

    init(_ t: any ApduChannel, _ info: Pace.Info, ksenc: [UInt8], ksmac: [UInt8]) throws {
        self.transport = t; self.info = info; self.cipher = info.cipher; self.ksenc = ksenc; self.ksmac = ksmac
        if info.cipher == "3DES" { bacSession = Bac.Session(ksenc: ksenc, ksmac: ksmac, ssc: [UInt8](repeating: 0, count: 8)); aesSm = nil }
        else { aesSm = try AesSm(ksenc: ksenc, ksmac: ksmac, ssc: [UInt8](repeating: 0, count: 16)); bacSession = nil }
    }

    /// The live send sequence counter (16 bytes for AES, 8 for 3DES).
    public var ssc: [UInt8] { aesSm?.ssc ?? bacSession?.ssc ?? [] }

    /// Wraps a plain APDU (advances the SSC).
    public func protect(_ plainApdu: [UInt8]) throws -> [UInt8] {
        if let a = aesSm { return try a.protect(plainApdu) }
        return try Bac.protect(bacSession!, plainApdu)
    }

    /// Unwraps the chip's answer (advances the SSC).
    public func unprotect(_ response: [UInt8]) throws -> SmReply {
        if let a = aesSm { return try a.unprotect(response) }
        guard response.count >= 2 else { throw PaceError(.protocolError, "Response shorter than SW1SW2 (\(response.count) bytes)") }
        do { return try Bac.unprotect(bacSession!, response) } catch let e as NfcError { throw PaceError(.protocolError, e.message) }
    }

    public func send(_ plainApdu: [UInt8]) async throws -> SmReply { try unprotect(try await transport.transmit(try protect(plainApdu))) }
}
