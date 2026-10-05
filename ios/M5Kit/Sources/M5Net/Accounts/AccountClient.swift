// The account API (server/accounts/routes.ts; Android account/Account and
// RegisterDialog; web client/src/lib/account.ts). Passkey accounts: the
// server picks the username, the passkey's PRF output is the account root
// (M5Crypto derives the key proof, seals and opens the root and the vault's
// slots), the session token authorises the APIs and the relay.
//
//   GET    /api/account/status · /countries
//   POST   /api/account/register/options · /register/check · /register/start · /register/verify
//   POST   /api/account/signin/options · /signin/verify  → a LOCKED session
//   POST   /api/account/unlock {keyProof}                → unlocked              (Bearer, locked ok)
//   GET    /api/account/me                                                      (Bearer, locked ok)
//   GET    /api/account/vault[?only=card] · PUT /api/account/vault             (Bearer)
//   POST   /api/account/event · /signout {everywhere}                          (Bearer, locked ok)
//   DELETE /api/account                                                         (Bearer)
//   POST   /api/account/passkeys/options · /passkeys/verify                     (Bearer)
//   GET    /api/account/passkeys/:id/wrapped · DELETE /api/account/passkeys/:id (Bearer)
//   PUT    /api/account/recovery · DELETE /api/account/recovery                 (Bearer)
//   POST   /api/account/recovery/start · /recovery/finish
//   GET    /api/account/sessions · DELETE /api/account/sessions/:id            (Bearer)
//   PUT    /api/account/identity                                               (Bearer)
//
// Calls that must get through (the server must hear of a passkey that now
// exists) are retried on network failures — twice, 1.5 s and 3 s apart — and
// never on a refusal (AccountSend).

import Foundation

/// GET /api/account/status.
public struct AccountServerStatus: Sendable, Equatable {
    public let available: Bool
    public let persistent: Bool
    public let rpId: String
    public let accounts: Int64
    public let raw: NetJSON
    public init(_ j: NetJSON) {
        available = j.bool("available")
        persistent = j.bool("persistent")
        rpId = j.str("rpId")
        accounts = j.int("accounts")
        raw = j
    }
}

/// The account summary the server answers with (client/src/lib/account.ts AccountSummary) — the fields the
/// network layer reads; everything is in `raw`.
public struct AccountSummary: Sendable, Equatable {
    public let id: String
    public let username: String
    public let groups: [String]
    public let keyVerified: Bool
    public let registered: Bool
    public let credentialIds: [String]
    public let recoverySet: Bool
    public let raw: NetJSON

    public init(_ j: NetJSON) {
        id = j.str("id", j.str("username"))
        username = j.str("username", j.str("id"))
        groups = j.arr("groups")?.compactMap(\.stringValue) ?? []
        keyVerified = j.bool("keyVerified")
        registered = j.bool("registered")
        credentialIds = Passkey.credentialIds(summary: j)
        recoverySet = j.obj("recovery")?.bool("set") ?? false
        raw = j
    }
}

/// A signed-in device of the account (GET /api/account/sessions).
public struct AccountSessionInfo: Sendable, Equatable {
    public let id: String
    public let createdAt: Millis
    public let lastUsedAt: Millis
    public let expiresAt: Millis
    public let client: String
    public let ip: String
    public let current: Bool
    public init(_ j: NetJSON) {
        id = j.str("id")
        createdAt = j.int("createdAt")
        lastUsedAt = j.int("lastUsedAt")
        expiresAt = j.int("expiresAt")
        client = j.str("client")
        ip = j.str("ip")
        current = j.bool("current")
    }
}

/// signin/verify, recovery/finish, register/verify: a session token and the account.
public struct AccountSignIn: Sendable, Equatable {
    public let token: String
    /// Locked until the key proof unlocks it (sign-in, recovery); register/verify answers unlocked.
    public let locked: Bool
    public let account: AccountSummary
    /// The root sealed for this passkey (a passkey added later): {iv, ct}; nil for the first passkey.
    public let wrapped: NetJSON?
    public init(_ j: NetJSON) throws {
        let t = j.str("token")
        guard !t.isEmpty else { throw NetError.badAnswer("no session token in the answer") }
        token = t
        locked = j.bool("locked")
        account = AccountSummary(j.obj("account") ?? .object([:]))
        let w = j.obj("wrapped")
        wrapped = (w.map { !$0.str("iv").isEmpty && !$0.str("ct").isEmpty } ?? false) ? w : nil
    }
}

/// register/start: the server's username, the passkey's name in the password manager, the form normalized, the options.
public struct RegistrationStart: Sendable, Equatable {
    public let username: String
    public let keyName: String
    public let normalized: NetJSON
    public let options: PasskeyCreationOptions
}

/// recovery/start: a ticket, the root sealed for the recovery code, the account's username, a new passkey's options.
public struct RecoveryStart: Sendable, Equatable {
    public let ticket: String
    public let wrapped: NetJSON?
    public let username: String
    public let options: PasskeyCreationOptions
}

/// How a call that must get through ended (Account.Sent).
public struct AccountSend: Sendable {
    public let answer: NetJSON?
    public let error: (any Error)?
    /// A try failed on the network: the server may have acted on it although no answer came.
    public let unsure: Bool
    /// The server itself said no, and nothing before may have reached it.
    public var refused: Bool { answer == nil && error is HTTPError && !unsure }
    public var httpError: HTTPError? { error as? HTTPError }
}

public enum AccountErrors {
    /// What a refusal means for the UI (Account.refusalCode): "rate-limited" (429), "rp-unverified"
    /// (app-not-trusted: refused before any passkey existed), else "".
    public static func refusalCode(status: Int, code: String) -> String {
        if status == 429 { return "rate-limited" }
        return code == "app-not-trusted" ? "rp-unverified" : ""
    }

    public static func code(of error: any Error) -> String {
        guard let e = error as? HTTPError else { return "" }
        return refusalCode(status: e.status, code: e.code)
    }
}

public struct AccountClient: Sendable {
    public let base: String
    public let http: HTTPClient
    /// Headers on every call (Android: X-M5-App-Cert; iOS needs none — the app's origin is its associated domain).
    public let extraHeaders: [String: String]
    /// The waits between tries of a call that must get through.
    public let retryDelays: [Duration]

    public init(base: String, http: HTTPClient = HTTPClient(), extraHeaders: [String: String] = [:],
                retryDelays: [Duration] = [.milliseconds(1500), .milliseconds(3000)]) {
        self.base = normalizeServer(base)
        self.http = http
        self.extraHeaders = extraHeaders
        self.retryDelays = retryDelays
    }

    /* ------------------------------------------------------------ http */

    /// One call: the answer (a JSON object) or HTTPError / NetError.
    public func call(_ method: String, _ path: String, body: NetJSON? = nil, token: String? = nil) async throws -> NetJSON {
        var headers = extraHeaders
        if let token, !token.isEmpty { headers["Authorization"] = "Bearer \(token)" }
        return try await http.json(method, try HTTPClient.url(base, path), body: body, headers: headers, maxBytes: 4 << 20)
    }

    /// A call that must get through: network failures are tried again (a refusal by the server is not).
    public func send(_ method: String, _ path: String, body: NetJSON? = nil, token: String? = nil) async -> AccountSend {
        var unsure = false
        var last: (any Error)?
        for attempt in 0...retryDelays.count {
            do {
                return AccountSend(answer: try await call(method, path, body: body, token: token), error: nil, unsure: unsure)
            } catch let e as HTTPError {
                return AccountSend(answer: nil, error: e, unsure: unsure)
            } catch {
                last = error
                unsure = true
                if attempt < retryDelays.count { try? await Task.sleep(for: retryDelays[attempt]) }
            }
        }
        return AccountSend(answer: nil, error: last, unsure: unsure)
    }

    /* ---------------------------------------------------------- public */

    public func status() async throws -> AccountServerStatus { AccountServerStatus(try await call("GET", "/api/account/status")) }

    /// ISO code + calling code of every country (the registration form).
    public func countries() async throws -> [NetJSON] { try await call("GET", "/api/account/countries").arr("countries") ?? [] }

    /* -------------------------------------------------------- register */

    /// A new account: the username the server picked and the passkey's creation options.
    public func registerOptions() async throws -> (username: String, options: PasskeyCreationOptions) {
        let a = try await call("POST", "/api/account/register/options", body: .object([:]))
        return (a.str("username"), try PasskeyCreationOptions(a.obj("publicKey") ?? .object([:])))
    }

    /// 6.4: the registration form checked ({firstName, lastName, country, phone, email}) → the normalized fields,
    /// or HTTPError with per-field `errors` in its body.
    public func registerCheck(form: NetJSON) async throws -> NetJSON {
        try await call("POST", "/api/account/register/check", body: form).obj("normalized") ?? .object([:])
    }

    /// 6.4: the form checked again → a new username and the passkey's creation options.
    public func registerStart(form: NetJSON) async throws -> RegistrationStart {
        let a = try await call("POST", "/api/account/register/start", body: form)
        return RegistrationStart(username: a.str("username"), keyName: a.str("keyName"), normalized: a.obj("normalized") ?? .object([:]),
                                 options: try PasskeyCreationOptions(a.obj("publicKey") ?? .object([:])))
    }

    /// The new passkey and the root's key proof → account + session (unlocked). Must get through: a passkey exists now.
    public func registerVerify(_ registration: PasskeyRegistration, keyProof: String) async -> AccountSend {
        await send("POST", "/api/account/register/verify", body: ["credential": registration.json, "keyProof": .string(keyProof)])
    }

    /* --------------------------------------------------------- sign in */

    public func signinOptions() async throws -> PasskeyRequestOptions {
        try PasskeyRequestOptions(server: try await call("POST", "/api/account/signin/options", body: .object([:])).obj("publicKey") ?? .object([:]))
    }

    /// The assertion → a LOCKED session (404 unknown-passkey: no account for this passkey here).
    public func signinVerify(_ assertion: PasskeyAssertion) async throws -> AccountSignIn {
        try AccountSignIn(try await call("POST", "/api/account/signin/verify", body: ["credential": assertion.json]))
    }

    /// Step two: the root's key proof (base64url, 43 characters) unlocks the session (403 wrong-key ends it).
    public func unlock(token: String, keyProof: String) async throws -> AccountSummary {
        AccountSummary(try await call("POST", "/api/account/unlock", body: ["keyProof": .string(keyProof)], token: token).obj("account") ?? .object([:]))
    }

    /// Is the session still valid, and locked?
    public func me(token: String) async throws -> (locked: Bool, account: AccountSummary) {
        let a = try await call("GET", "/api/account/me", token: token)
        return (a.bool("locked"), AccountSummary(a.obj("account") ?? .object([:])))
    }

    @discardableResult
    public func signOut(token: String, everywhere: Bool) async throws -> NetJSON {
        try await call("POST", "/api/account/signout", body: ["everywhere": .bool(everywhere)], token: token)
    }

    /// Deletes the account, its vault and its mailbox.
    @discardableResult
    public func deleteAccount(token: String) async throws -> NetJSON { try await call("DELETE", "/api/account", token: token) }

    /// A client event for the account's audit (decrypt-ok, signin-failed, …); best effort.
    public func event(token: String, kind: String, meta: [String: NetJSON] = [:]) async {
        _ = try? await call("POST", "/api/account/event", body: ["kind": .string(kind), "meta": .object(meta)], token: token)
    }

    /* ----------------------------------------------------------- vault */

    /// The vault's parts (each { ct, updatedAt } or absent); `onlyCard`: just the profile card.
    public func vault(token: String, onlyCard: Bool = false) async throws -> VaultContents {
        VaultContents(try await call("GET", "/api/account/vault" + (onlyCard ? "?only=card" : ""), token: token))
    }

    /// Stores sealed parts. Must get through (the same part may simply be stored again).
    public func putVault(token: String, patch: VaultPatch) async -> AccountSend {
        await send("PUT", "/api/account/vault", body: patch.json, token: token)
    }

    /* -------------------------------------------- passkeys, recovery */

    public func passkeyOptions(token: String) async throws -> PasskeyCreationOptions {
        try PasskeyCreationOptions(try await call("POST", "/api/account/passkeys/options", body: .object([:]), token: token).obj("publicKey") ?? .object([:]))
    }

    /// One more passkey, with the root sealed for its PRF output ({iv, ct}). Must get through.
    public func passkeyVerify(token: String, registration: PasskeyRegistration, wrapped: NetJSON, label: String) async -> AccountSend {
        await send("POST", "/api/account/passkeys/verify", body: ["credential": registration.json, "wrapped": wrapped, "label": .string(String(label.prefix(40)))], token: token)
    }

    /// The root sealed for one of the account's passkeys.
    public func passkeyWrapped(token: String, credentialId: String) async throws -> NetJSON? {
        try await call("GET", "/api/account/passkeys/\(Self.pathPart(credentialId))/wrapped", token: token).obj("wrapped")
    }

    public func deletePasskey(token: String, credentialId: String) async throws -> AccountSummary {
        AccountSummary(try await call("DELETE", "/api/account/passkeys/\(Self.pathPart(credentialId))", token: token).obj("account") ?? .object([:]))
    }

    /// The recovery code's id, verifier and the root sealed for it. Idempotent, must get through.
    public func setRecovery(token: String, id: String, verifier: String, wrapped: NetJSON) async -> AccountSend {
        await send("PUT", "/api/account/recovery", body: ["id": .string(id), "verifier": .string(verifier), "wrapped": wrapped], token: token)
    }

    @discardableResult
    public func clearRecovery(token: String) async throws -> NetJSON { try await call("DELETE", "/api/account/recovery", token: token) }

    /// A recovery code's id and proof → a ticket, the sealed root and a new passkey's options.
    public func recoveryStart(id: String, proof: String) async throws -> RecoveryStart {
        let a = try await call("POST", "/api/account/recovery/start", body: ["id": .string(id), "proof": .string(proof)])
        let w = a.obj("wrapped")
        return RecoveryStart(ticket: a.str("ticket"), wrapped: (w.map { !$0.str("ct").isEmpty } ?? false) ? w : nil,
                             username: a.str("username", a.str("userName")), options: try PasskeyCreationOptions(a.obj("publicKey") ?? .object([:])))
    }

    /// The new passkey and the root sealed for it → a LOCKED session (the key proof unlocks it next).
    public func recoveryFinish(ticket: String, registration: PasskeyRegistration, wrapped: NetJSON, label: String) async throws -> AccountSignIn {
        try AccountSignIn(try await call("POST", "/api/account/recovery/finish",
                                         body: ["ticket": .string(ticket), "credential": registration.json, "wrapped": wrapped, "label": .string(label)]))
    }

    /* -------------------------------------------- sessions, identity */

    public func sessions(token: String) async throws -> [AccountSessionInfo] {
        (try await call("GET", "/api/account/sessions", token: token).arr("sessions") ?? []).map(AccountSessionInfo.init)
    }

    /// Ends one session (another device); the sessions left.
    public func endSession(token: String, id: String) async throws -> [AccountSessionInfo] {
        (try await call("DELETE", "/api/account/sessions/\(Self.pathPart(id))", token: token).arr("sessions") ?? []).map(AccountSessionInfo.init)
    }

    /// The account's public signing key (raw Ed25519, base64 — M5Crypto's account key).
    public func setIdentity(token: String, publicKey: String) async throws -> Bool {
        try await call("PUT", "/api/account/identity", body: ["publicKey": .string(publicKey)], token: token).bool("ok")
    }

    /// The public profile API (/api/profile…): the owner's PUT / DELETE / GET (token), anyone's GET by username.
    public func profile(_ method: String, _ path: String, body: NetJSON? = nil, token: String? = nil) async throws -> NetJSON {
        guard path.hasPrefix("/api/profile") else { throw NetError.invalid("not a profile path") }
        return try await call(method, path, body: body, token: token)
    }

    static func pathPart(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? s
    }
}
