// Port of A/security/ServerPin.java (6.7, audit V6 / F-05): the server's key
// at enrolment is pinned by the key itself, not by the kid string the server
// sends next to it. A pin — the build's pinned key (Info.plist / build config)
// or the kid of the console's QR code — is a hash of the key's SPKI in one of
// the forms the console shows:
//
//   kid            base64url(SHA-256(SPKI))[0..16]          (QR code, build)
//   fingerprint    hex of the first 16 bytes, grouped or not ("ABCD EF01 …")
//   SHA-256        64 hex digits (":" or spaces allowed) or base64(url)
//
// The key must be a P-256 SPKI, the kid the server states must be the key's
// own, and every pin given must match the key. No pin at all: trust on first
// use (the key is then pinned in DeviceState and every later answer —
// policy, control messages, bundles — must be signed by it).

import Foundation
import M5Core
import M5Crypto

public enum ServerKeyPin {
    /// Checks the key a server presents; returns its kid. Empty pins are skipped (no build pin, no QR code).
    /// Throws NetError.security with a message a person can act on.
    @discardableResult
    public static func check(publicKey: String?, statedKid: String?, pins: [String?] = []) throws -> String {
        let spki = (publicKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if spki.isEmpty { throw NetError.security("the server sent no key — enrolment stopped") }
        guard P256Keys.publicKey(spki: spki) != nil else { throw NetError.security("the server's key is not a valid P-256 key — enrolment stopped") }
        let kid = P256Keys.kid(spki: spki)
        guard let stated = statedKid, Bytes.same(kid, stated.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw NetError.security("the server's key does not match the key id it states (\(statedKid ?? "null") ≠ \(kid)) — enrolment stopped")
        }
        for pin in pins {
            guard let p = pin, !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            if !matches(spki: spki, pin: p) {
                throw NetError.security("the server's key \(kid) (\(P256Keys.fingerprint(spki: spki))) is not the pinned key \(p.trimmingCharacters(in: .whitespacesAndNewlines)) — check the server address and the QR code; enrolment stopped")
            }
        }
        return kid
    }

    /// The key at the end of enrolment is the very key that was checked before it.
    public static func same(checked: String?, answered: String?, answeredKid: String?) throws {
        let a = (checked ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let b = (answered ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty || !Bytes.same(a, b) { throw NetError.security("the server changed its key during enrolment — enrolment stopped") }
        try check(publicKey: b, statedKid: answeredKid)
    }

    /// True when the pin (kid, fingerprint or SHA-256 in any of its forms) names this key.
    public static func matches(spki: String, pin: String?) -> Bool {
        guard let pin, let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        let hash = Bytes.sha256(der)
        let p = pin.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.count == 16 { return Bytes.same(String(Bytes.b64url(hash).prefix(16)), p) }
        let bare = p.replacingOccurrences(of: ":", with: "").replacingOccurrences(of: " ", with: "")
        if bare.range(of: "^[0-9A-Fa-f]{64}$", options: .regularExpression) != nil { return Bytes.same(Bytes.hex(hash), bare.lowercased()) }
        if bare.range(of: "^[0-9A-Fa-f]{32}$", options: .regularExpression) != nil { return Bytes.same(Bytes.hex(hash.prefix(16)), bare.lowercased()) }
        if p.count == 43 { return Bytes.same(Bytes.b64url(hash), p) }
        if p.count == 44 { return Bytes.same(Bytes.b64(hash), p) }
        return false
    }
}
