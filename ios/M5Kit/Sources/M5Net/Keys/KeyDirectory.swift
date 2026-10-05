// The key directory over HTTP (protocol 4, § 7.5; server/keys/routes.ts) and
// this device's upload to it (Android chat/P4Device.upload):
//
//   PUT /api/keys/bundle   (Bearer: an account session)
//     { pk, cert: { v: 2, exp, sig }, bundle: { id, dh, kem, exp, sig }, apk? }
//     → 200 { ok: true, device: DirectoryDevice, kt: { acct: index|null, dev: index|null } }
//     → 400 bad-request, bad-pk, bad-apk, bad-cert, cert-expired, cert-too-long, bad-bundle, bundle-expired,
//           bundle-too-long, bad-bundle-signature, bad-cert-signature
//     → 409 no-account-key, apk-mismatch, stale-bundle, too-many-devices
//     → 429 kt-quota (the account's key-log entries for the day are used up — not again this session)
//     → 503 kt-failed, kt-busy, directory-full;  401 signed-out / locked
//
// Other members read the directory over the hub (`key-bundles`, HubConnection).

import Foundation

/// What PUT /api/keys/bundle carries: this device's key, its certificate v2 by the account key, its current
/// mailbox bundle (M5Crypto makes all three) and the account key.
public struct KeyBundleUpload: Sendable, Equatable {
    public let pk: String
    public let certExp: Millis
    public let certSig: String
    public let bundle: NetJSON
    public let apk: String

    public init(pk: String, certExp: Millis, certSig: String, bundle: NetJSON, apk: String) {
        self.pk = pk
        self.certExp = certExp
        self.certSig = certSig
        self.bundle = bundle
        self.apk = apk
    }

    public var json: NetJSON {
        ["pk": .string(pk), "cert": ["v": 2, "exp": .int(certExp), "sig": .string(certSig)], "bundle": bundle, "apk": .string(apk)]
    }

    /// What identifies this upload (a new bundle, a renewed certificate or another account makes a new one).
    public func mark(username: String) -> String { "\(bundle.str("id"))|\(certExp)|\(username)" }
}

public struct KeyDirectoryClient: Sendable {
    public let http: HTTPClient
    public init(http: HTTPClient = HTTPClient()) { self.http = http }

    public func putBundle(base: String, token: String, upload: KeyBundleUpload) async throws -> NetJSON {
        try await http.json("PUT", try HTTPClient.url(base, "/api/keys/bundle"), body: upload.json, headers: ["Authorization": "Bearer \(token)"])
    }
}

/// Uploads this device's bundle and certificate when either is new since the last upload (signed in only);
/// a refused quota is not tried again in this session. The last mark is kept (Android: the cert record's "uploaded").
public actor KeyDirectoryUploader {
    public static let markKey = "key-upload"
    private let client: KeyDirectoryClient
    private let store: any NetStateStore
    private var quotaMark = ""
    private var busy = false

    public init(client: KeyDirectoryClient = KeyDirectoryClient(), store: any NetStateStore) {
        self.client = client
        self.store = store
    }

    public enum Outcome: Sendable, Equatable {
        case uploaded
        /// Already there (the same bundle, certificate and account).
        case unchanged
        /// 429 kt-quota earlier in this session: not again.
        case quota
        case busy
        case failed(status: Int, code: String)
    }

    public func upload(base: String, token: String, username: String, upload: KeyBundleUpload) async -> Outcome {
        if busy { return .busy }
        busy = true
        defer { busy = false }
        let mark = upload.mark(username: username)
        if mark == quotaMark { return .quota }
        if await store.load(Self.markKey)?.str("uploaded") == mark { return .unchanged }
        do {
            _ = try await client.putBundle(base: base, token: token, upload: upload)
            await store.save(Self.markKey, ["uploaded": .string(mark)])
            return .uploaded
        } catch let e as HTTPError {
            // 6.12 review S10: 429 kt-quota — the account's key-log entries for the day are used up.
            if e.status == 429 || e.code == "kt-quota" { quotaMark = mark }
            return .failed(status: e.status, code: e.code)
        } catch {
            return .failed(status: 0, code: "\(error)")
        }
    }

    /// Signed out or another account: the next upload goes again.
    public func reset() async { await store.save(Self.markKey, nil) }
}
