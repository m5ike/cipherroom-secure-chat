// What M5NFC asks the app to wire for the connection tags (M5NFC README "What the
// app wires"): Argon2id for offline tags is M5NFC's `Argon2TagKdf` (M5Crypto's
// vendored PHC reference code; Android chat/Argon2) — NfcService passes it in —
// and the two POSTs of an invitation tag (`ShareInviteHTTP`) go through M5Net's
// HTTP transport over URLSession (Android Server.send with a 64 KiB answer cap).

import Foundation
import M5Net
import M5NFC

/// The invitation tag's POSTs (/api/share/create, /api/share/redeem) through M5Net: ephemeral URLSession,
/// no redirects, no cookies, the answer capped at 64 KiB, the app's User-Agent.
struct M5ShareInviteHTTP: ShareInviteHTTP {
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
