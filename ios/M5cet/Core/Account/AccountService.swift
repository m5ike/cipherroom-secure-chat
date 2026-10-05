// The user's M5cet account (android account/Account.java, DeviceRoots,
// RecoveryCode): passkey sign-in with the PRF extension — the same passkeys as
// in the browser (the server's domain is the relying party). The PRF output is
// the account root (or opens it, for a later passkey); the root's key proof
// unlocks the session. The session (token, account, root) is kept in the vault's
// user tier (record "account", Android's fields), so it survives a restart; a
// root made on this phone (a provider without PRF) in "account-roots".
//
// The token authorises the server's APIs for this person (commands, the AI, the
// relay for away members, the key directory); the root's account key certifies
// this device for protocol 4 (P4AccountProvider).

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import Observation
import Synchronization
import os

/// How a ceremony ended (Android Account.Result): the UI answers by `code`.
struct AccountResult: Equatable, Sendable {
    let ok: Bool
    /// "" | cancelled | no-passkey | unsupported | unknown-passkey | no-prf | wrong-key | orphan | rp-unverified | taken | rate-limited
    let code: String
    let message: String
    let deviceBound: Bool
    let username: String

    static func success(_ bound: Bool, _ user: String) -> AccountResult { AccountResult(ok: true, code: "", message: "", deviceBound: bound, username: user) }
    static func failure(_ code: String, _ message: String, _ user: String = "") -> AccountResult {
        AccountResult(ok: false, code: code, message: message, deviceBound: false, username: user)
    }
}

/// The signed-in state for protocol 4, readable off the main actor (P4Device reads it on the rooms' actors).
final class AccountState: P4AccountProvider, @unchecked Sendable {
    private let state = Mutex<(signedIn: Bool, username: String, token: String, root: Bytes?)>((false, "", "", nil))
    var signedIn: Bool { state.withLock { $0.signedIn } }
    var username: String { state.withLock { $0.username } }
    var token: String { state.withLock { $0.token } }
    func accountSeed() -> Bytes? { state.withLock { $0.root.map { AccountKeys.accountSeed(root: $0) } } }
    func set(signedIn: Bool, username: String, token: String, root: Bytes?) { state.withLock { $0 = (signedIn, username, token, root) } }
}

@MainActor
@Observable
final class AccountService: AccountModel {
    static let record = "account"
    static let rootsRecord = "account-roots"

    @ObservationIgnored weak var core: AppCore?
    @ObservationIgnored let security: any CoreSecurity
    @ObservationIgnored let passkeys: any PasskeyAuthorizing
    @ObservationIgnored let p4Provider = AccountState()
    /// The vault's record (read once the vault is open; nil = not read yet).
    @ObservationIgnored private var cached: JSONObject?
    /// Bumped on every change (the screens re-read $account).
    private(set) var revision = 0
    /// A ceremony is running (the buttons wait).
    private(set) var busy = false
    nonisolated static let log = Logger(subsystem: "cz.m5cet.app", category: "account")

    init(security: any CoreSecurity, passkeys: any PasskeyAuthorizing) {
        self.security = security
        self.passkeys = passkeys
    }

    private var server: String { core?.device.server ?? "" }
    private var client: AccountClient { AccountClient(base: server) }
    private func t(_ key: String) -> String { core?.t(key) ?? key }

    // MARK: - state (the vault's "account" record)

    private var state: JSONObject {
        if let c = cached { return c }
        guard security.unlocked else { return JSONObject() }
        let s = security.userRecords.record(Self.record) ?? JSONObject()
        cached = s
        publish(s)
        return s
    }

    private func save(_ s: JSONObject) {
        // The app locked meanwhile (a late answer): nothing of the session stays in memory.
        guard security.unlocked else { cached = nil; publish(JSONObject()); return }
        cached = s
        security.userRecords.put(Self.record, s)
        publish(s)
        revision &+= 1
    }

    private func publish(_ s: JSONObject) {
        let a = s.object("account")
        let user = a?.string("username") ?? a?.optString("id") ?? ""
        p4Provider.set(signedIn: !s.optString("token").isEmpty, username: user, token: s.optString("token"), root: s.string("root").flatMap { try? Crypto.unb64($0) })
    }

    /// Forget what was read (the lock; the unlock reads it again).
    func reload() {
        cached = nil
        p4Provider.set(signedIn: false, username: "", token: "", root: nil)
        revision &+= 1
    }

    var signedIn: Bool { _ = revision; return !state.optString("token").isEmpty }
    var token: String { state.optString("token") }
    var username: String {
        _ = revision
        guard let a = state.object("account") else { return "" }
        return a.string("username") ?? a.optString("id")
    }
    var summary: JSONObject { state.object("account") ?? JSONObject() }
    var deviceBound: Bool { state.bool("deviceBound") ?? false }
    var hasRoot: Bool { signedIn && !state.optString("root").isEmpty }
    private var root: Bytes? { state.string("root").flatMap { try? Crypto.unb64($0) } }

    func bearer() async -> String { token }

    /// $account (Account.scope): the passkey in use, sessions, groups, recovery, device-bound.
    var scope: DesignValue {
        _ = revision
        let a = summary
        let cred = a.optString("credentialId")
        let recovery = a.object("recovery")
        let o = JSONObject([
            ("signedIn", .bool(signedIn)), ("username", .string(username)),
            ("credential", .string(cred.count > 12 ? String(cred.prefix(12)) + "…" : cred)),
            ("passkeys", .int(a.array("passkeys")?.count ?? 0)), ("sessions", .int(a.array("sessions")?.count ?? 0)),
            ("groups", .string((a.array("groups") ?? []).compactMap(\.stringValue).joined(separator: ", "))),
            ("since", .int(a.optInt64("createdAt"))), ("lastLogin", .int(a.optInt64("lastLoginAt"))), ("keyVerified", .bool(a.bool("keyVerified") ?? false)),
            ("signedInAt", .int(state.optInt64("at"))), ("deviceBound", .bool(signedIn && deviceBound)), ("canSeal", .bool(hasRoot)),
            ("recovery", .bool(recovery?.bool("set") ?? false)), ("recoverySince", .int(recovery?.optInt64("createdAt") ?? 0)),
            ("registered", .bool(signedIn && (a.bool("registered") ?? false))),
        ])
        return o.designValue
    }

    // MARK: - device roots (a provider without PRF)

    private func roots() -> JSONObject { security.userRecords.record(Self.rootsRecord) ?? JSONObject() }

    private func rootKept(_ accountId: String) -> (root: Bytes, confirmed: Bool)? {
        guard !accountId.isEmpty, let e = roots().object(server + "|" + accountId), let r = try? Crypto.unb64(e.optString("root")), !r.isEmpty else { return nil }
        return (r, e.bool("confirmed") ?? false)
    }

    private func keepRoot(_ accountId: String, _ root: Bytes, credential: String, confirmed: Bool) -> Bool {
        var all = roots()
        all[server + "|" + accountId] = .object(JSONObject([("root", .string(Crypto.b64(root))), ("credential", .string(credential)),
                                                             ("confirmed", .bool(confirmed)), ("at", .int(EpochMs.now))]))
        return security.userRecords.put(Self.rootsRecord, all)
    }

    private func confirmRoot(_ pendingId: String, as accountId: String) {
        var all = roots()
        guard var e = all.object(server + "|" + pendingId) else { return }
        e["confirmed"] = true
        all[server + "|" + pendingId] = nil
        all[server + "|" + accountId] = .object(e)
        security.userRecords.put(Self.rootsRecord, all)
    }

    private func removeRoot(_ accountId: String) {
        var all = roots()
        if all.object(server + "|" + accountId) != nil { all[server + "|" + accountId] = nil; security.userRecords.put(Self.rootsRecord, all) }
    }

    // MARK: - sign in (Account.signIn / finishSignIn)

    func signIn() async -> AccountResult {
        busy = true
        defer { busy = false }
        let options: PasskeyRequestOptions
        do { options = try await client.signinOptions() } catch { return .failure(AccountErrors.code(of: error), error.localizedDescription) }
        let assertion: PasskeyAssertion
        do { assertion = try await passkeys.assert(options) } catch { return Self.ceremony(error) }
        return await finishSignIn(assertion, rpId: options.rpId)
    }

    private func finishSignIn(_ a: PasskeyAssertion, rpId: String) async -> AccountResult {
        var token: String?
        var id = ""
        do {
            let answer: AccountSignIn
            do {
                answer = try await client.signinVerify(a)
            } catch let e as HTTPError where e.status == 404 || e.code == "unknown-passkey" {
                let stale = a.handleName
                if let pending = rootKept(stale), !pending.confirmed { removeRoot(stale) }
                return .failure("unknown-passkey", e.localizedDescription, stale)
            }
            token = answer.token
            id = answer.account.id.isEmpty ? a.handleName : answer.account.id
            let kept = rootKept(id)
            let wrapped = answer.wrapped.flatMap { JSON.parseObject($0.text) }
            var bound = false
            let root: Bytes
            if let k = kept, k.confirmed { root = k.root; bound = true }
            else if let prf = a.prfFirst.map({ Array($0) }), AccountKeys.sealed(wrapped) { root = try AccountKeys.openRoot(wrapped!, secret: prf, info: AccountKeys.wrapPasskey) }
            else if let prf = a.prfFirst.map({ Array($0) }) { root = prf }
            else if let k = kept { root = k.root; bound = true }
            else { return .failure("no-prf", t("passkey.noPrf").replacingOccurrences(of: "{user}", with: id), id) }
            var s = JSONObject([("token", .string(answer.token)), ("account", HubFrameBridge.json(answer.account.raw)), ("root", .string(Crypto.b64(root))),
                                ("at", .int(EpochMs.now)), ("deviceBound", .bool(bound)), ("rpId", .string(rpId))])
            save(s)
            let unlocked: AccountSummary
            do {
                unlocked = try await client.unlock(token: answer.token, keyProof: AccountKeys.keyProof(root))
            } catch let e as HTTPError where e.status == 403 {
                if bound, kept?.confirmed == false { removeRoot(id) }
                throw AccountFailure(code: "wrong-key", message: t(bound ? "passkey.wrongKeyDevice" : "passkey.wrongKey").replacingOccurrences(of: "{user}", with: id))
            }
            s["account"] = HubFrameBridge.json(unlocked.raw)
            save(s)
            if bound, kept?.confirmed == false { confirmRoot(id, as: id) }
            Self.log.info("signed in\(bound ? " (device-bound)" : "", privacy: .public)")
            accountChanged()
            return .success(bound, username)
        } catch {
            if let token { let c = client; Task { _ = try? await c.signOut(token: token, everywhere: false) } }
            save(JSONObject())
            if let f = error as? AccountFailure { return .failure(f.code, f.message, id) }
            return .failure(AccountErrors.code(of: error), error.localizedDescription, id)
        }
    }

    // MARK: - sign up (Account.signUp / create / rootFor / finishSignUp)

    /// A new account with a new passkey (the server picks the username).
    func signUp() async -> AccountResult {
        busy = true
        defer { busy = false }
        do {
            let (username, options) = try await client.registerOptions()
            return await create(options, username: username) { reg, proof in await self.client.registerVerify(reg, keyProof: proof) }
        } catch {
            return .failure(AccountErrors.code(of: error), error.localizedDescription)
        }
    }

    /// 6.4: the registration form (name, country, mobile, e-mail) checked by the server → an account with a passkey.
    func register(form: NetJSON) async -> AccountResult {
        busy = true
        defer { busy = false }
        do {
            let start = try await client.registerStart(form: form)
            return await create(start.options, username: start.username) { reg, proof in await self.client.registerVerify(reg, keyProof: proof) }
        } catch let e as HTTPError where e.code == "taken" {
            return .failure("taken", e.localizedDescription)
        } catch {
            return .failure(AccountErrors.code(of: error), error.localizedDescription)
        }
    }

    private func create(_ options: PasskeyCreationOptions, username: String,
                        verify: (PasskeyRegistration, String) async -> AccountSend) async -> AccountResult {
        let reg: PasskeyRegistration
        do { reg = try await passkeys.create(options) } catch { return Self.ceremony(error) }
        // The root: the PRF output at creation (iOS 18+), else a PRF-only assertion right away, else 32 random bytes kept here.
        var prf = reg.prfFirst.map { Array($0) }
        if prf == nil, let a = try? await passkeys.assert(.prfOnly(rpId: options.rpId, credentialId: reg.credentialId)) { prf = a.prfFirst.map { Array($0) } }
        let bound = prf == nil
        let root = prf ?? Crypto.random(32)
        if bound, !keepRoot(username, root, credential: reg.credentialIdB64url, confirmed: false) {
            return .failure("orphan", t("passkey.orphan").replacingOccurrences(of: "{user}", with: username).replacingOccurrences(of: "{reason}", with: "vault"), username)
        }
        let sent = await verify(reg, AccountKeys.keyProof(root))
        guard let answer = sent.answer else {
            let reason = sent.error?.localizedDescription ?? ""
            return .failure(sent.unsure ? "orphan" : AccountErrors.code(of: sent.error ?? AccountFailure(code: "", message: "")),
                            t(sent.unsure ? "passkey.orphanOffline" : "passkey.orphan").replacingOccurrences(of: "{user}", with: username)
                                .replacingOccurrences(of: "{reason}", with: reason), username)
        }
        let account = answer.obj("account") ?? .object([:])
        let id = account.str("id", account.str("username", username))
        save(JSONObject([("token", .string(answer.str("token"))), ("account", HubFrameBridge.json(account)), ("root", .string(Crypto.b64(root))),
                         ("at", .int(EpochMs.now)), ("deviceBound", .bool(bound)), ("rpId", .string(options.rpId))]))
        if bound { confirmRoot(username, as: id) }
        accountChanged()
        return .success(bound, self.username)
    }

    // MARK: - more ways in (addPasskey, recovery code)

    /// One more passkey with the root sealed for its PRF output.
    func addPasskey() async -> AccountResult {
        guard signedIn, let root else { return .failure("no-root", t("passkey.noRoot"), username) }
        busy = true
        defer { busy = false }
        do {
            let options = try await client.passkeyOptions(token: token)
            let reg: PasskeyRegistration
            do { reg = try await passkeys.create(options) } catch { return Self.ceremony(error) }
            var prf = reg.prfFirst.map { Array($0) }
            if prf == nil, let a = try? await passkeys.assert(.prfOnly(rpId: options.rpId, credentialId: reg.credentialId)) { prf = a.prfFirst.map { Array($0) } }
            guard let prf else { return .failure("no-prf", t("passkey.addNoPrf"), username) }
            let wrapped = try AccountKeys.sealRoot(root, secret: prf, info: AccountKeys.wrapPasskey)
            let sent = await client.passkeyVerify(token: token, registration: reg, wrapped: HubFrameBridge.net(.object(wrapped)), label: "M5cet · " + username)
            guard let answer = sent.answer else {
                return .failure("orphan", t("passkey.orphan").replacingOccurrences(of: "{user}", with: username)
                    .replacingOccurrences(of: "{reason}", with: sent.error?.localizedDescription ?? ""), username)
            }
            var s = state
            if let a = answer.obj("account") { s["account"] = HubFrameBridge.json(a) }
            save(s)
            return .success(deviceBound, username)
        } catch {
            return .failure(AccountErrors.code(of: error), error.localizedDescription, username)
        }
    }

    /// A new recovery code (shown once): its id, verifier and the root sealed for it go to the server.
    func createRecoveryCode() async -> (code: String?, failure: AccountResult?) {
        guard signedIn, let root else { return (nil, .failure("no-root", t("passkey.noRoot"), username)) }
        let code = RecoveryCodes.generate()
        guard let m = RecoveryCodes.material(code) else { return (nil, .failure("failed", "code")) }
        do {
            let wrapped = try AccountKeys.sealRoot(root, secret: m.secret, info: AccountKeys.wrapRecovery)
            let sent = await client.setRecovery(token: token, id: m.id, verifier: m.verifier, wrapped: HubFrameBridge.net(.object(wrapped)))
            guard sent.answer != nil else { return (nil, .failure(AccountErrors.code(of: sent.error ?? AccountFailure(code: "", message: "")), sent.error?.localizedDescription ?? "", username)) }
            restore()
            return (code, nil)
        } catch {
            return (nil, .failure("failed", error.localizedDescription, username))
        }
    }

    // MARK: - session

    /// After the unlock: is the session still valid? A locked one is unlocked with the kept root.
    func restore() {
        reload()
        guard signedIn else { accountChanged(); return }
        let tk = token, r = root, c = client
        Task { @MainActor in
            do {
                var (locked, account) = try await c.me(token: tk)
                if locked, let r { account = try await c.unlock(token: tk, keyProof: AccountKeys.keyProof(r)); locked = false }
                var s = self.state
                s["account"] = HubFrameBridge.json(account.raw)
                self.save(s)
                self.accountChanged()
            } catch let e as HTTPError where e.status == 401 || e.status == 403 {
                Self.log.info("the session ended")
                self.save(JSONObject())
                self.accountChanged()
            } catch {
                Self.log.notice("restore: not now")
                self.accountChanged()
            }
        }
    }

    /// Ends the session here (or everywhere); a device root stays for the next sign-in.
    func signOut(everywhere: Bool) async {
        let tk = token
        save(JSONObject())
        accountChanged()
        if !tk.isEmpty { _ = try? await client.signOut(token: tk, everywhere: everywhere) }
    }

    /// Deletes the account (its vault and mailbox on the server) and signs out.
    func deleteAccount() async -> Bool {
        let tk = token
        guard !tk.isEmpty else { return false }
        do { _ = try await client.deleteAccount(token: tk) } catch { return false }
        save(JSONObject())
        accountChanged()
        return true
    }

    /// Signed in or out: the rooms' sockets bind the session, the key directory gets this device.
    private func accountChanged() {
        revision &+= 1
        core?.rooms.onAccountChanged(token: signedIn ? token : nil)
        core?.uploadKeys()
    }

    private static func ceremony(_ error: any Error) -> AccountResult {
        if let f = error as? PasskeyFailure { return .failure(f.code, f.message) }
        return .failure("failed", error.localizedDescription)
    }
}

struct AccountFailure: Error {
    let code: String
    let message: String
}

/// The recovery code as the web makes it (account/RecoveryCode.java, client/src/lib/recovery.ts).
enum RecoveryCodes {
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    static let chars = 26

    /// A fresh code, grouped for writing down (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X).
    static func generate() -> String {
        var b = Crypto.random(chars)
        defer { for i in b.indices { b[i] = 0 } }
        var s = ""
        for i in 0..<chars {
            if i > 0 && i % 5 == 0 { s.append("-") }
            s.append(alphabet[Int(b[i] & 31)])
        }
        return s
    }

    /// Case, spaces, dashes and look-alikes do not matter; nil when it is not a code.
    static func normalize(_ code: String?) -> String? {
        guard let code else { return nil }
        var c = code.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        c = String(c.map { $0 == "I" || $0 == "L" ? "1" : $0 == "O" ? "0" : $0 == "U" ? "V" : $0 })
        guard c.count == chars, c.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return c
    }

    struct Material { let id: String, proof: String, verifier: String, secret: Bytes }

    static func material(_ code: String) -> Material? {
        guard let n = normalize(code) else { return nil }
        let key = Crypto.utf8("m5cet:recovery:v1:" + n)
        let id = Crypto.b64url(Array(Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:id")).prefix(18)))
        let proof = Crypto.b64url(Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:proof")))
        let verifier = Crypto.hex(Crypto.sha256(Crypto.utf8(proof)))
        return Material(id: id, proof: proof, verifier: verifier, secret: Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:kek")))
    }
}
