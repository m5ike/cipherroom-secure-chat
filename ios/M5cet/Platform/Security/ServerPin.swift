// The server's key at enrolment is pinned by the key itself, not by the kid string
// the server sends next to it (Android security/ServerPin, 6.7 audit V6 / F-05).
// A pin — the build's server key or the kid of the console's QR code — is a hash
// of the key's SPKI in one of the forms the console shows:
//
//   kid            base64url(SHA-256(SPKI))[0..16]          (QR code, build)
//   fingerprint    hex of the first 16 bytes, grouped or not ("ABCD EF01 …")
//   SHA-256        64 hex digits (":" or spaces allowed) or base64(url)
//
// The key must be a P-256 SPKI, the kid the server states must be the key's own,
// and every pin given must match the key. M5Net calls it at enrolment; the pinned
// key is then kept in the SYS tier with the rest of the server's settings.

import Foundation

enum ServerPin {
    struct Refusal: Error, Equatable, CustomStringConvertible {
        let message: String
        var description: String { message }
    }

    /// Checks the key a server presents; returns its kid. Empty pins are skipped (no build pin, no QR code).
    @discardableResult
    static func check(publicKey: String?, statedKid: String?, pins: [String?] = []) throws -> String {
        let spki = (publicKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spki.isEmpty else { throw Refusal(message: "the server sent no key — enrolment stopped") }
        guard (try? EcP256.publicKey(spki: spki)) != nil, let kid = EcP256.kid(spki: spki) else {
            throw Refusal(message: "the server's key is not a valid P-256 key — enrolment stopped")
        }
        guard let stated = statedKid, same(kid, stated.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw Refusal(message: "the server's key does not match the key id it states (\(statedKid ?? "null") ≠ \(kid)) — enrolment stopped")
        }
        for case let pin? in pins where !pin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if !matches(spki: spki, pin: pin) {
                throw Refusal(message: "the server's key \(kid) (\(EcP256.fingerprint(spki: spki) ?? "")) is not the pinned key "
                    + "\(pin.trimmingCharacters(in: .whitespacesAndNewlines)) — check the server address and the QR code; enrolment stopped")
            }
        }
        return kid
    }

    /// The key at the end of enrolment is the very key that was checked before it.
    static func same(checked: String?, answered: String?, answeredKid: String?) throws {
        let a = (checked ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let b = (answered ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !a.isEmpty, same(a, b) else { throw Refusal(message: "the server changed its key during enrolment — enrolment stopped") }
        try check(publicKey: b, statedKid: answeredKid)
    }

    /// True when the pin (kid, fingerprint or SHA-256 in any of its forms) names this key.
    static func matches(spki: String, pin: String?) -> Bool {
        guard let pin, let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        let hash = SecCrypto.sha256(der)
        let p = pin.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.count == 16 { return same(String(Bytes.b64url(hash).prefix(16)), p) }
        let bare = p.replacingOccurrences(of: ":", with: "").replacingOccurrences(of: " ", with: "")
        let isHex = !bare.isEmpty && bare.allSatisfy(\.isHexDigit)
        if isHex && bare.count == 64 { return same(Bytes.hex(hash), bare.lowercased()) }
        if isHex && bare.count == 32 { return same(Bytes.hex(hash.prefix(16)), bare.lowercased()) }
        if p.count == 43 { return same(Bytes.b64url(hash), p) }
        if p.count == 44 { return same(Bytes.b64(hash), p) }
        return false
    }

    private static func same(_ a: String, _ b: String) -> Bool { Bytes.same(Bytes.utf8(a), Bytes.utf8(b)) }
}
