// The account API: the passkey ceremonies' JSON (the server's options in,
// AuthenticationServices' results out as webauthn.ts reads them), the calls
// and their retry rule, the vault's parts and revisions, the notification
// settings and the device's link, the key directory upload.

import Foundation
import Testing
@testable import M5Net
import M5Core

/// The creation options as server/accounts/routes.ts registrationOptions writes them.
private let creation: NetJSON = [
    "challenge": "q83vEjRWeJA", "rp": ["id": "chat.example.com", "name": "M5cet"],
    "user": ["id": .string(Bytes.b64url(Data("ab12cd34".utf8))), "name": "ab12cd34", "displayName": "M5cet · ab12cd34"],
    "pubKeyCredParams": [["type": "public-key", "alg": -7], ["type": "public-key", "alg": -8], ["type": "public-key", "alg": -257]],
    "authenticatorSelection": ["residentKey": "required", "requireResidentKey": true, "userVerification": "required"],
    "excludeCredentials": [["type": "public-key", "id": "AQID"]], "attestation": "none", "timeout": 60000,
]

@Suite struct WebAuthnJSONTests {
    @Test func theServersOptionsBecomeTheCeremonysParameters() throws {
        let o = try PasskeyCreationOptions(creation)
        #expect(o.rpId == "chat.example.com" && o.userName == "ab12cd34" && String(data: o.userId, encoding: .utf8) == "ab12cd34")
        #expect(o.algorithms == [-7, -8, -257] && o.excludeCredentials == [Data([1, 2, 3])] && o.userVerification == "required" && o.timeoutMs == 60000)
        #expect(o.challenge == Bytes.unb64url("q83vEjRWeJA"))
        #expect(o.prfSalt == Data("m5cet:passkey:prf:v1".utf8))
        #expect(throws: NetError.self) { _ = try PasskeyCreationOptions(creation.with("challenge", "")) }
        let r = try PasskeyRequestOptions(server: ["challenge": "q83vEjRWeJA", "rpId": "chat.example.com", "userVerification": "required", "timeout": 60000])
        #expect(r.rpId == "chat.example.com" && r.wantsPrf && r.allowCredentials.isEmpty)
        let prf = PasskeyRequestOptions.prfOnly(rpId: "chat.example.com", credentialId: Data([9]))
        #expect(prf.allowCredentials == [Data([9])] && prf.wantsPrf && prf.challenge.count == 32)
        let confirm = PasskeyRequestOptions.confirm(rpId: "x", credentialIds: ["AQID", "BAUG"])
        #expect(confirm.allowCredentials.count == 2 && !confirm.wantsPrf)
    }

    @Test func theCeremonysResultsAreWhatTheServerVerifies() throws {
        let reg = PasskeyRegistration(credentialId: Data([1, 2, 3, 250]), clientDataJSON: Data(#"{"type":"webauthn.create"}"#.utf8), attestationObject: Data([0xA3]),
                                      transports: ["internal", "hybrid"], prfFirst: Data(repeating: 7, count: 32))
        let j = reg.json
        #expect(j.str("id") == "AQID-g" && j.str("rawId") == "AQID-g" && j.str("type") == "public-key")
        #expect(j.obj("response")?.str("attestationObject") == "ow" && j.obj("response")?.arr("transports") == ["internal", "hybrid"])
        #expect(Bytes.unb64url(j.obj("response")!.str("clientDataJSON")) == reg.clientDataJSON)
        #expect(!j.text.contains("prf")) // the PRF output never leaves the device
        let a = PasskeyAssertion(credentialId: Data([1]), clientDataJSON: Data("{}".utf8), authenticatorData: Data([2]), signature: Data([3]), userHandle: Data("ab12cd34".utf8))
        #expect(a.json.obj("response")?.str("userHandle") == Bytes.b64url(Data("ab12cd34".utf8)))
        #expect(a.handleName == "ab12cd34")
        let anonymous = PasskeyAssertion(credentialId: Data([1]), clientDataJSON: Data(), authenticatorData: Data(), signature: Data(), userHandle: nil)
        #expect(anonymous.json.obj("response")?["userHandle"] == .null)
        #expect(Passkey.handleName(Data("bad name!".utf8)) == "")
        #expect(Passkey.handleName(Data("Žofie.1".utf8)) == "Žofie.1")
        #expect(Passkey.credentialIds(summary: ["credentialId": "AAA=", "passkeys": [["credentialId": "BBB"], ["credentialId": ""]]]) == ["BBB"])
        #expect(Passkey.credentialIds(summary: ["credentialId": "AAA="]) == ["AAA"])
    }
}

@Suite struct AccountClientTests {
    func client(_ handler: @escaping StubHTTP.Handler) -> (AccountClient, StubHTTP) {
        let stub = StubHTTP(handler)
        return (AccountClient(base: "chat.example.com/", http: HTTPClient(transport: stub), retryDelays: [.milliseconds(1), .milliseconds(1)]), stub)
    }

    @Test func signUpSignInAndUnlock() async throws {
        let (c, stub) = client { req in
            switch req.url.path {
            case "/api/account/register/options": return StubHTTP.json(["ok": true, "username": "ab12cd34", "publicKey": creation])
            case "/api/account/register/verify": return StubHTTP.json(["ok": true, "token": "tok-new", "account": ["id": "ab12cd34", "username": "ab12cd34", "groups": ["user"]]])
            case "/api/account/signin/options": return StubHTTP.json(["ok": true, "publicKey": ["challenge": "AAAA", "rpId": "chat.example.com", "userVerification": "required", "timeout": 60000]])
            case "/api/account/signin/verify":
                return StubHTTP.json(["ok": true, "token": "tok-locked", "locked": true, "account": ["id": "ab12cd34"], "wrapped": ["iv": "aXY=", "ct": "Y3Q="]])
            case "/api/account/unlock":
                #expect(req.headers["Authorization"] == "Bearer tok-locked")
                #expect(req.jsonBody?.str("keyProof").count == 43)
                return StubHTTP.json(["ok": true, "account": ["id": "ab12cd34", "keyVerified": true, "passkeys": [["credentialId": "AQID"]]]])
            default: return StubHTTP.json(404, ["ok": false])
            }
        }
        let (username, options) = try await c.registerOptions()
        #expect(username == "ab12cd34" && options.rpId == "chat.example.com")
        let reg = PasskeyRegistration(credentialId: Data([1, 2, 3]), clientDataJSON: Data("{}".utf8), attestationObject: Data([1]))
        let sent = await c.registerVerify(reg, keyProof: String(repeating: "A", count: 43))
        #expect(sent.answer?.str("token") == "tok-new" && !sent.unsure)
        #expect(stub.requests.last?.jsonBody?.obj("credential")?.str("id") == "AQID")
        #expect(stub.requests.last?.url.absoluteString == "https://chat.example.com/api/account/register/verify")
        let req = try await c.signinOptions()
        #expect(req.wantsPrf && req.rpId == "chat.example.com")
        let a = PasskeyAssertion(credentialId: Data([1, 2, 3]), clientDataJSON: Data("{}".utf8), authenticatorData: Data([1]), signature: Data([2]), userHandle: Data("ab12cd34".utf8))
        let signIn = try await c.signinVerify(a)
        #expect(signIn.locked && signIn.token == "tok-locked" && signIn.wrapped?.str("ct") == "Y3Q=")
        let account = try await c.unlock(token: signIn.token, keyProof: String(repeating: "B", count: 43))
        #expect(account.keyVerified && account.credentialIds == ["AQID"])
    }

    @Test func aCallThatMustGetThroughIsTriedAgainOnlyOnNetworkFailures() async {
        let tries = Mutexed(0)
        let (c, _) = client { _ in
            tries.value += 1
            if tries.value < 3 { throw NetError.network("lost") }
            return StubHTTP.json(["ok": true, "account": ["id": "x"]])
        }
        let s = await c.putVault(token: "t", patch: VaultPatch(card: "Y2FyZA=="))
        #expect(s.answer != nil && s.unsure && tries.value == 3)
        let refused = Mutexed(0)
        let (c2, _) = client { _ in refused.value += 1; return StubHTTP.json(409, ["ok": false, "code": "taken", "errors": ["email": "taken"], "message": "taken"]) }
        let r = await c2.registerVerify(PasskeyRegistration(credentialId: Data([1]), clientDataJSON: Data(), attestationObject: Data()), keyProof: "x")
        #expect(r.refused && refused.value == 1 && r.httpError?.body.obj("errors")?.str("email") == "taken")
        let (c3, _) = client { _ in throw NetError.network("down") }
        let none = await c3.putVault(token: "t", patch: VaultPatch(card: "x"))
        #expect(none.answer == nil && none.unsure && !none.refused)
    }

    @Test func vaultSessionsRecoveryAndErrors() async throws {
        let (c, stub) = client { req in
            switch (req.method, req.url.path) {
            case ("GET", "/api/account/vault"):
                if req.url.query == "only=card" { return StubHTTP.json(["ok": true, "card": ["ct": "Y2FyZA==", "updatedAt": 5]]) }
                return StubHTTP.json(["ok": true, "profile": ["ct": "cHJvZmlsZQ==", "updatedAt": 1], "chat": .null, "connections": .null, "registration": .null, "card": .null])
            case ("GET", "/api/account/sessions"):
                return StubHTTP.json(["ok": true, "sessions": [["id": "0123456789abcdef", "createdAt": 1, "lastUsedAt": 2, "expiresAt": 3, "client": "Safari/iOS", "ip": "1.2.3.0/24", "current": true]]])
            case ("DELETE", "/api/account/sessions/0123456789abcdef"): return StubHTTP.json(["ok": true, "sessions": []])
            case ("POST", "/api/account/recovery/start"):
                return StubHTTP.json(["ok": true, "ticket": "t1", "wrapped": ["iv": "aXY=", "ct": "Y3Q="], "userName": "ab12cd34", "username": "ab12cd34", "publicKey": creation])
            case ("POST", "/api/account/passkeys/options"): return StubHTTP.json(403, ["ok": false, "code": "app-not-trusted", "message": "no"])
            case ("PUT", "/api/account/identity"): return StubHTTP.json(["ok": true])
            default: return StubHTTP.json(404, ["ok": false, "message": "no"])
            }
        }
        let v = try await c.vault(token: "t")
        #expect(v.profile?.ct == "cHJvZmlsZQ==" && v.chat == nil && v.part("card") == nil)
        #expect(try await c.vault(token: "t", onlyCard: true).card?.updatedAt == 5)
        let sessions = try await c.sessions(token: "t")
        #expect(sessions.first?.current == true && sessions.first?.client == "Safari/iOS")
        #expect(try await c.endSession(token: "t", id: "0123456789abcdef").isEmpty)
        let rec = try await c.recoveryStart(id: "rid", proof: "p")
        #expect(rec.ticket == "t1" && rec.username == "ab12cd34" && rec.options.rpId == "chat.example.com")
        do {
            _ = try await c.passkeyOptions(token: "t")
            Issue.record("no refusal")
        } catch {
            #expect(AccountErrors.code(of: error) == "rp-unverified")
        }
        #expect(try await c.setIdentity(token: "t", publicKey: "a2V5"))
        await #expect(throws: NetError.self) { _ = try await c.profile("GET", "/api/account/me") }
        #expect(stub.requests.allSatisfy { $0.headers["Authorization"] == nil || $0.headers["Authorization"] == "Bearer t" })
    }

    @Test func thePatchCarriesTheCountsTheServerShows() {
        let p = VaultPatch(chat: (ct: "Y2hhdA==", messages: 3, messageBytes: 120, rooms: 2), connections: (ct: "Y29u", count: 4), registration: "cmVn")
        #expect(p.json == ["chat": ["ct": "Y2hhdA==", "messages": 3, "messageBytes": 120, "rooms": 2], "connections": ["ct": "Y29u", "count": 4], "registration": "cmVn"])
    }
}

@Suite struct VaultSlotTests {
    @Test func aV2PartsRevisionIsReadWithoutTheKey() {
        var blob = Data("M5V2".utf8)
        blob.append(contentsOf: [0, 0, 1, 0x93, 0x5A, 0x09, 0x1F, 0x00]) // 1_733_000_000_256-ish
        blob.append(Data(repeating: 1, count: 12 + 20))
        let r = VaultSlotFormat.revision(of: Bytes.b64(blob))
        #expect(r.v2 && r.rev == 0x0000_0193_5A09_1F00)
        #expect(VaultSlotFormat.revision(of: Bytes.b64(Data(repeating: 1, count: 40))) == (0, false))
        #expect(VaultSlotFormat.aad(slot: "card", rev: 5) == Data("m5cet:vault-slot:v2|card|5".utf8))
    }

    @Test func anOlderRevisionIsARollback() async {
        let clock = TestClock(1_000)
        let revs = VaultSlotRevisions(store: MemoryNetStateStore(), clock: clock.clock)
        #expect(await revs.next(account: "acc", slot: "card") == 1_000)
        #expect(await revs.note(account: "acc", slot: "card", rev: 5_000))
        #expect(await revs.next(account: "acc", slot: "card") == 5_001) // another device's clock ran ahead
        #expect(await !revs.note(account: "acc", slot: "card", rev: 4_999))
        #expect(await revs.note(account: "acc", slot: "card", rev: 0) == false) // older than seen
        #expect(await revs.note(account: "other", slot: "card", rev: 0))
    }
}

@Suite struct NotifyAndKeysTests {
    @Test func theDeviceIsLinkedOncePerSessionAndUnlinkedSignedOut() async throws {
        let stub = StubHTTP { _ in StubHTTP.json(["ok": true, "linked": true]) }
        let api = DeviceAPIClient(http: HTTPClient(transport: stub))
        let link = NotifyLink(api: api)
        let creds = DeviceCredentials(server: "https://h", deviceId: "ios_x", signer: SoftwareRequestSigner())
        #expect(await link.sync(device: creds, token: "tok", wanted: true) == .linked)
        #expect(await link.sync(device: creds, token: "tok", wanted: true) == .unchanged)
        #expect(stub.requests.count == 1 && stub.requests[0].jsonBody == ["on": true, "token": "tok"])
        #expect(stub.requests[0].url.path == "/api/ios/notify" && stub.requests[0].headers["X-M5-Signature"] != nil)
        #expect(await link.sync(device: creds, token: nil, wanted: true) == .unlinked)
        #expect(stub.requests.last?.jsonBody == ["on": false])
        #expect(await link.sync(device: creds, token: nil, wanted: false) == .unchanged)
    }

    @Test func notificationSettingsAsTheServerKeepsThem() async throws {
        let prefs = NotifyPrefs(order: ["android", "webpush", "email"], quiet: true, timeZone: "Europe/Prague", lang: "cs")
        #expect(prefs.json.obj("kinds")?.objectValue?.count == 5)
        #expect(prefs.json.obj("quiet") == ["on": true, "from": "22:00", "to": "07:00", "tz": "Europe/Prague"])
        let stub = StubHTTP { req in
            if req.url.path == "/api/account/notify/test" { return StubHTTP.json(409, ["ok": false, "skipped": "quiet-hours"]) }
            return StubHTTP.json(["ok": true])
        }
        let n = NotifyClient(base: "https://h", http: HTTPClient(transport: stub))
        try await n.putPrefs(token: "t", prefs: prefs)
        #expect(stub.requests[0].method == "PUT" && stub.requests[0].headers["Authorization"] == "Bearer t")
        #expect(try await n.test(token: "t").str("skipped") == "quiet-hours")
    }

    @Test func theKeyDirectoryGetsEachBundleOnce() async throws {
        let status = Mutexed(200)
        let stub = StubHTTP { req in
            #expect(req.method == "PUT" && req.url.path == "/api/keys/bundle")
            if status.value == 429 { return StubHTTP.json(429, ["ok": false, "code": "kt-quota", "message": "quota"]) }
            return StubHTTP.json(["ok": true, "kt": ["acct": 1, "dev": 2]])
        }
        let store = MemoryNetStateStore()
        let up = KeyDirectoryUploader(client: KeyDirectoryClient(http: HTTPClient(transport: stub)), store: store)
        let b = KeyBundleUpload(pk: "pk", certExp: 9, certSig: "sig", bundle: ["id": "b1", "exp": 5], apk: "apk")
        #expect(b.json.obj("cert") == ["v": 2, "exp": 9, "sig": "sig"])
        #expect(await up.upload(base: "https://h", token: "t", username: "u", upload: b) == .uploaded)
        #expect(await up.upload(base: "https://h", token: "t", username: "u", upload: b) == .unchanged)
        status.value = 429
        let b2 = KeyBundleUpload(pk: "pk", certExp: 9, certSig: "sig", bundle: ["id": "b2", "exp": 5], apk: "apk")
        #expect(await up.upload(base: "https://h", token: "t", username: "u", upload: b2) == .failed(status: 429, code: "kt-quota"))
        #expect(await up.upload(base: "https://h", token: "t", username: "u", upload: b2) == .quota)
        #expect(stub.requests.count == 2)
    }
}
