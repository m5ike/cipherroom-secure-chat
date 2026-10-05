// The WebAuthn JSON around the passkey ceremonies (Android account/AccountKeys
// "webauthn" part and Passkeys; server/accounts/webauthn.ts). The ceremonies
// themselves are the app's (AuthenticationServices:
// ASAuthorizationPlatformPublicKeyCredentialProvider, with the PRF extension);
// this turns the server's options into what they need and their results into
// the JSON the server verifies.
//
//   creation options  { challenge, rp:{id,name}, user:{id,name,displayName}, pubKeyCredParams,
//                       authenticatorSelection, excludeCredentials?, attestation, timeout }
//   request options   { challenge, rpId, allowCredentials?, userVerification, timeout }
//   registration      { id, rawId, type:"public-key", response:{ clientDataJSON, attestationObject, transports? } }
//   assertion         { id, rawId, type:"public-key", response:{ clientDataJSON, authenticatorData, signature, userHandle } }
//
// All binary values base64url without padding. The PRF extension is asked
// with the salt "m5cet:passkey:prf:v1" (eval.first): its output is the account
// root (or opens it — M5Crypto: AccountKeys).

import Foundation

public enum Passkey {
    /// The PRF salt (AccountKeys.PRF_SALT): the passkey's PRF output for it is the account root.
    public static let prfSalt = Data("m5cet:passkey:prf:v1".utf8)

    /// The username in an assertion's user handle (the server puts it there since 4.0), or "".
    public static func handleName(_ userHandle: Data?) -> String {
        guard let h = userHandle, !h.isEmpty, let name = String(data: h, encoding: .utf8) else { return "" }
        return name.range(of: "^[\\p{L}\\p{N}._-]{1,40}$", options: .regularExpression) != nil ? name : ""
    }

    /// The account's passkeys (credential ids, base64url) from its summary: every one listed, else the first.
    public static func credentialIds(summary: NetJSON) -> [String] {
        var ids = (summary.arr("passkeys") ?? []).map { $0.str("credentialId").replacingOccurrences(of: "=", with: "") }.filter { !$0.isEmpty }
        let first = summary.str("credentialId").replacingOccurrences(of: "=", with: "")
        if ids.isEmpty, !first.isEmpty { ids.append(first) }
        return ids
    }
}

/// The server's creation options (register/options, register/start, passkeys/options, recovery/start).
public struct PasskeyCreationOptions: Sendable, Equatable {
    public let challenge: Data
    public let rpId: String
    public let rpName: String
    /// The user handle (the username's UTF-8 since 4.0).
    public let userId: Data
    public let userName: String
    public let displayName: String
    /// COSE algorithms the server takes (-7 ES256, -8 EdDSA, -257 RS256).
    public let algorithms: [Int]
    public let excludeCredentials: [Data]
    public let userVerification: String
    public let residentKey: String
    public let attestation: String
    public let timeoutMs: Int64
    public let raw: NetJSON

    public init(_ j: NetJSON) throws {
        guard let ch = Bytes.unb64url(j.str("challenge")), !ch.isEmpty else { throw NetError.badAnswer("no challenge in the creation options") }
        guard let rp = j.obj("rp"), !rp.str("id").isEmpty, let user = j.obj("user"), let uid = Bytes.unb64url(user.str("id")) else {
            throw NetError.badAnswer("incomplete creation options")
        }
        challenge = ch
        rpId = rp.str("id")
        rpName = rp.str("name")
        userId = uid
        userName = user.str("name")
        displayName = user.str("displayName")
        algorithms = (j.arr("pubKeyCredParams") ?? []).compactMap { $0["alg"]?.intValue }
        excludeCredentials = (j.arr("excludeCredentials") ?? []).compactMap { Bytes.unb64url($0.str("id")) }
        let sel = j.obj("authenticatorSelection") ?? .object([:])
        userVerification = sel.str("userVerification", "required")
        residentKey = sel.str("residentKey", "required")
        attestation = j.str("attestation", "none")
        timeoutMs = j.int("timeout", 60_000)
        raw = j
    }

    /// The PRF salt to evaluate at creation (the app passes it to the PRF extension).
    public var prfSalt: Data { Passkey.prfSalt }
}

/// The server's request options (signin/options), or one made here (a PRF-only assertion, a confirmation).
public struct PasskeyRequestOptions: Sendable, Equatable {
    public let challenge: Data
    public let rpId: String
    public let allowCredentials: [Data]
    public let userVerification: String
    public let timeoutMs: Int64
    /// Ask for the PRF output (the root) with Passkey.prfSalt.
    public let wantsPrf: Bool

    public init(challenge: Data, rpId: String, allowCredentials: [Data] = [], userVerification: String = "required", timeoutMs: Int64 = 60_000, wantsPrf: Bool) {
        self.challenge = challenge
        self.rpId = rpId
        self.allowCredentials = allowCredentials
        self.userVerification = userVerification
        self.timeoutMs = timeoutMs
        self.wantsPrf = wantsPrf
    }

    /// The server's `publicKey` of signin/options (always with PRF: the sign-in needs the root).
    public init(server j: NetJSON) throws {
        guard let ch = Bytes.unb64url(j.str("challenge")), !ch.isEmpty, !j.str("rpId").isEmpty else { throw NetError.badAnswer("incomplete request options") }
        self.init(challenge: ch, rpId: j.str("rpId"), allowCredentials: (j.arr("allowCredentials") ?? []).compactMap { Bytes.unb64url($0.str("id")) },
                  userVerification: j.str("userVerification", "required"), timeoutMs: j.int("timeout", 60_000), wantsPrf: true)
    }

    /// A PRF-only assertion with a credential just created (AccountKeys.prfRequest): a local challenge, only it allowed.
    public static func prfOnly(rpId: String, credentialId: Data, challenge: Data = Bytes.random(32)) -> PasskeyRequestOptions {
        PasskeyRequestOptions(challenge: challenge, rpId: rpId, allowCredentials: [credentialId], wantsPrf: true)
    }

    /// "Confirm with your passkey" (AccountKeys.confirmRequest): any of the account's passkeys, a local challenge, no PRF.
    public static func confirm(rpId: String, credentialIds: [String], challenge: Data = Bytes.random(32)) -> PasskeyRequestOptions {
        PasskeyRequestOptions(challenge: challenge, rpId: rpId, allowCredentials: credentialIds.compactMap(Bytes.unb64url), wantsPrf: false)
    }
}

/// A new passkey as AuthenticationServices returns it (ASAuthorizationPlatformPublicKeyCredentialRegistration).
public struct PasskeyRegistration: Sendable, Equatable {
    public let credentialId: Data
    public let clientDataJSON: Data
    public let attestationObject: Data
    public let transports: [String]
    /// The PRF output for Passkey.prfSalt when the provider gave it at creation (iOS 18+), else nil.
    public let prfFirst: Data?

    public init(credentialId: Data, clientDataJSON: Data, attestationObject: Data, transports: [String] = [], prfFirst: Data? = nil) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.attestationObject = attestationObject
        self.transports = transports
        self.prfFirst = prfFirst
    }

    public var credentialIdB64url: String { Bytes.b64url(credentialId) }

    /// What the server reads (AccountKeys.strip): id, rawId, type, response. Never the PRF output.
    public var json: NetJSON {
        var response: [String: NetJSON] = ["clientDataJSON": .string(Bytes.b64url(clientDataJSON)), "attestationObject": .string(Bytes.b64url(attestationObject))]
        if !transports.isEmpty { response["transports"] = .strings(transports) }
        let id = Bytes.b64url(credentialId)
        return ["id": .string(id), "rawId": .string(id), "type": "public-key", "response": .object(response)]
    }
}

/// An assertion as AuthenticationServices returns it (ASAuthorizationPlatformPublicKeyCredentialAssertion).
public struct PasskeyAssertion: Sendable, Equatable {
    public let credentialId: Data
    public let clientDataJSON: Data
    public let authenticatorData: Data
    public let signature: Data
    public let userHandle: Data?
    public let prfFirst: Data?

    public init(credentialId: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userHandle: Data?, prfFirst: Data? = nil) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signature = signature
        self.userHandle = userHandle
        self.prfFirst = prfFirst
    }

    public var credentialIdB64url: String { Bytes.b64url(credentialId) }
    /// The username its user handle names, or "".
    public var handleName: String { Passkey.handleName(userHandle) }

    public var json: NetJSON {
        let id = Bytes.b64url(credentialId)
        return ["id": .string(id), "rawId": .string(id), "type": "public-key", "response": [
            "clientDataJSON": .string(Bytes.b64url(clientDataJSON)), "authenticatorData": .string(Bytes.b64url(authenticatorData)),
            "signature": .string(Bytes.b64url(signature)), "userHandle": userHandle.map { .string(Bytes.b64url($0)) } ?? .null,
        ]]
    }
}
