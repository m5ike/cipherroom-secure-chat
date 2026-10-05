// What M5NFC asks the app to wire for the connection tags (M5NFC README "What the
// app wires"): Argon2id for offline tags (`TagKdf` → M5Crypto's Argon2, the
// vendored PHC reference code; Android chat/Argon2) and the two POSTs of an
// invitation tag (`ShareInviteHTTP` → M5Net's HTTP transport over URLSession;
// Android Server.send with a 64 KiB answer cap).

import Foundation
import M5Crypto
import M5Net
import M5NFC

/// Argon2id (v 0x13) for M5NFC's offline connection tags — one derivation at a time (M5Crypto serializes them).
struct M5TagKdf: M5NFC.TagKdf {
    func argon2id(password: [UInt8], salt: [UInt8], passes: Int, memoryKiB: Int, parallelism: Int, length: Int) throws -> [UInt8] {
        try Argon2.argon2id(password: password, salt: salt, passes: passes, memoryKiB: memoryKiB, lanes: parallelism, length: length)
    }
}

/// The invitation tag's POSTs (/api/share/create, /api/share/redeem) through M5Net: ephemeral URLSession,
/// no redirects, no cookies, the answer capped at 64 KiB, the app's User-Agent.
struct M5ShareInviteHTTP: M5NFC.ShareInviteHTTP {
    let transport: any HTTPTransport
    let userAgent: String
    /// Seconds per request.
    let timeout: TimeInterval

    init(transport: any HTTPTransport = URLSessionHTTPTransport(), userAgent: String = M5NetInfo.userAgent, timeout: TimeInterval = 30) {
        self.transport = transport; self.userAgent = userAgent; self.timeout = timeout
    }

    func post(_ url: String, json body: [UInt8]) async throws -> (status: Int, body: [UInt8]) {
        guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http", u.host != nil else {
            throw NfcError(.invalidArgument, "not a server address: \(url)")
        }
        let req = HTTPRequest(method: "POST", url: u,
                              headers: ["Content-Type": "application/json", "Accept": "application/json", "User-Agent": userAgent],
                              body: Data(body), maxBytes: 64 * 1024, timeout: timeout)
        let res = try await transport.send(req, progress: nil)
        return (res.status, [UInt8](res.body))
    }
}
