// What the push and notification tests share: the server's own recording of a
// device session (ios/M5Kit/Tests/M5NetTests/fixtures/ios-api.json — /api/ios/*
// through the real routes), a transport that answers as that server did, the
// fixture device's keys in software, a test server that signs and seals control
// messages as server/mobile/commands.ts does, and fakes of the device's facts,
// the command host and the bundle storage.

import CryptoKit
import Foundation
import M5Design
import M5Net
import XCTest
@testable import M5cet

/// Standard base64 (the tests import M5Net and the app, both of which have a `Bytes`).
func b64(_ d: Data) -> String { d.base64EncodedString() }

/// A flag set from any thread.
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var on = false
    func set() { lock.withLock { on = true } }
    var value: Bool { lock.withLock { on } }
}

enum PushFixtures {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()

    static func json(_ path: String) throws -> NetJSON { try NetJSON.parse(Data(contentsOf: repo.appendingPathComponent(path))) }

    /// The recorded session (info, enroll, check-in with a lock command, a bundle offer and a release, the bundle file…).
    static let ios: NetJSON = (try? json("ios/M5Kit/Tests/M5NetTests/fixtures/ios-api.json")) ?? .object([:])

    static var devicePkcs8: Data { Data(base64Encoded: ios.str("devicePkcs8"))! }
    static var deviceId: String { ios.str("deviceId") }
    static var serverKey: String { ios.obj("info")!.obj("server")!.str("publicKey") }
    static var serverKid: String { ios.obj("info")!.obj("server")!.str("kid") }
    /// The server's clock at the check-in (the recorded command expires a week later).
    static var checkinTime: Millis { ios.obj("checkin")!.int("time") }
    static let base = "https://chat.example.com"
}

/// The fixture device's keys (the same P-256 key signs and decrypts, as in the recording).
struct FixtureSigner: DeviceSigner {
    let key: P256.Signing.PrivateKey
    init(pkcs8: Data = PushFixtures.devicePkcs8) { key = try! P256.Signing.PrivateKey(derRepresentation: pkcs8) }
    var level: KeyLevel { .software }
    func publicKeySPKI() throws -> String { b64(key.publicKey.derRepresentation) }
    func sign(_ data: Data) throws -> Data { try key.signature(for: data).rawRepresentation }
}

struct FixtureAgreement: DeviceAgreement {
    let key: P256.KeyAgreement.PrivateKey
    init(pkcs8: Data = PushFixtures.devicePkcs8) { key = try! P256.KeyAgreement.PrivateKey(derRepresentation: pkcs8) }
    init(key: P256.KeyAgreement.PrivateKey) { self.key = key }
    var level: KeyLevel { .software }
    func publicKeySPKI() throws -> String { b64(key.publicKey.derRepresentation) }
    func sharedSecret(withSPKI spki: String) throws -> Data {
        try key.sharedSecretFromKeyAgreement(with: EcP256.publicKey(spki: spki)).withUnsafeBytes { Data($0) }
    }
}

/// The server as it answered in the recording (by path); `override` answers first. Records the requests.
final class FixtureServer: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [HTTPRequest] = []
    var override: (@Sendable (HTTPRequest) -> HTTPResponse?)?
    let s = PushFixtures.ios

    var requests: [HTTPRequest] { lock.withLock { log } }
    func requests(_ path: String) -> [HTTPRequest] { requests.filter { $0.url.path == path } }

    static func json(_ status: Int, _ body: NetJSON) -> HTTPResponse { HTTPResponse(status: status, headers: ["Content-Type": "application/json"], body: body.data) }

    func send(_ request: HTTPRequest, progress: HTTPProgress?) async throws -> HTTPResponse {
        lock.withLock { log.append(request) }
        if let o = override?(request) { return o }
        switch (request.method, request.url.path) {
        case ("GET", "/api/ios/info"): return Self.json(200, s.obj("info")!)
        case ("POST", "/api/ios/enroll"): return Self.json(200, s.obj("enroll")!)
        case ("POST", "/api/ios/checkin"): return Self.json(200, s.obj("checkin")!)
        case ("GET", let p) where p.hasPrefix("/api/ios/bundles/"):
            let data = Data(base64Encoded: s.str("bundleFile"))!
            progress?(Int64(data.count), Int64(data.count))
            return HTTPResponse(status: 200, headers: ["Content-Type": "application/vnd.m5cet.bundle"], body: data)
        case ("GET", let p) where p.hasPrefix("/api/ios/releases/"): return Self.json(200, s.obj("release")!)
        case ("POST", "/api/ios/ack"): return Self.json(200, s.obj("ack")!)
        case ("POST", "/api/ios/events"): return Self.json(200, s.obj("events")!)
        case ("POST", "/api/ios/notify"): return Self.json(Int(s.obj("notify")!.int("status")), s.obj("notify")!.obj("body")!)
        case ("GET", "/api/notify/config"): return Self.json(200, ["enabled": true, "templates": ["message": ["maxPrivacy": "room", "sound": false]]])
        case ("PUT", "/api/account/notify"): return Self.json(200, ["ok": true])
        default: return Self.json(404, ["ok": false, "message": "no"])
        }
    }
}

extension HTTPRequest {
    var json: NetJSON? { body.flatMap { try? NetJSON.parse($0) } }
}

/// A server key that signs control messages and policies, and seals them for a device (server/mobile/crypto.ts).
struct TestControlServer {
    let key = P256.Signing.PrivateKey()
    var spki: String { b64(key.publicKey.derRepresentation) }
    var kid: String { EcP256.kid(spki: spki) ?? "" }

    /// eciesSeal: an ephemeral P-256 key, HKDF-SHA256(salt label, info "<purpose>|<deviceId>"), AES-256-GCM.
    static func seal(_ plain: Data, toSPKI device: String, deviceId: String, purpose: String) -> (e: String, iv: String, ct: String) {
        let eph = P256.KeyAgreement.PrivateKey()
        let peer = try! EcP256.publicKey(spki: device)
        let shared = try! eph.sharedSecretFromKeyAgreement(with: peer)
        let k = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(PushOpener.eciesLabel.utf8), sharedInfo: Data("\(purpose)|\(deviceId)".utf8),
                                               outputByteCount: 32)
        let iv = AES.GCM.Nonce()
        let box = try! AES.GCM.seal(plain, using: k, nonce: iv, authenticating: Data("\(PushOpener.eciesLabel)|\(purpose)|\(deviceId)".utf8))
        return (b64(eph.publicKey.derRepresentation), b64(Data(iv)), b64(box.ciphertext + box.tag))
    }

    /// A command's wire ({m5, i, e, iv, ct, s}) for one device.
    func wire(id: String, kind: String, payload: [String: Any] = [:], exp: Int64 = 0, at: Int64 = 1, device: String, deviceId: String) -> [String: String] {
        let content: [String: Any] = ["id": id, "kind": kind, "at": at, "exp": exp, "payload": payload]
        let plain = try! JSONSerialization.data(withJSONObject: content)
        let sealed = Self.seal(plain, toSPKI: device, deviceId: deviceId, purpose: "push")
        var w = ["m5": "1", "i": id, "e": sealed.e, "iv": sealed.iv, "ct": sealed.ct]
        w["s"] = b64(try! key.signature(for: Data(PushOpener.signedString(w, deviceId: deviceId).utf8)).rawRepresentation)
        return w
    }

    func netWire(id: String, kind: String, payload: [String: Any] = [:], exp: Int64 = 0, device: String, deviceId: String) -> NetJSON {
        NetJSON.from(wire(id: id, kind: kind, payload: payload, exp: exp, device: device, deviceId: deviceId))!
    }

    /// policySigned for a device.
    func policy(_ policy: [String: Any], deviceId: String, at: Int64) -> NetJSON {
        let json = String(decoding: try! JSONSerialization.data(withJSONObject: policy, options: [.sortedKeys]), as: UTF8.self)
        let sig = try! key.signature(for: Data(SignedDevicePolicy.signedString(deviceId: deviceId, at: at, policyJson: json).utf8))
        return ["at": .int(at), "policy": .string(json), "sig": .string(b64(sig.rawRepresentation))]
    }
}

@MainActor
final class FakeFacts: DeviceFactsProviding {
    var apnsEnvironment = "sandbox"
    func description(name: String?) -> DeviceDescription {
        DeviceDescription(name: name ?? "Test iPhone", model: "iPhone17,1", modelName: "iPhone 17 Pro", idiom: "phone", os: "iOS", osVersion: "26.0", locale: "cs")
    }
    func status(bundle: NetJSON?, push: String, policyAt: Millis) -> DeviceStatusReport {
        DeviceStatusReport(battery: 80, network: "wifi", rooms: 1, bundle: bundle, push: push, lockMode: "pin", storage: 1024, policyAt: policyAt, biometry: "faceID")
    }
}

@MainActor
final class RecordingHost: DeviceControlHost {
    var calls: [String] = []
    var flashInApp = false
    func lockNow() { calls.append("lock") }
    func wipe(reason: String) { calls.append("wipe:\(reason)") }
    func flash(title: String, text: String, level: String, alreadyShown: Bool) -> String {
        calls.append("flash:\(text)\(alreadyShown ? ":shown" : "")")
        return flashInApp ? "app" : "notification"
    }
    func push(title: String, body: String, room: String, url: String) { calls.append("push:\(title)") }
    func notify(_ payload: [String: Any]) { calls.append("notify:\(payload["kind"] as? String ?? "")") }
    func logTail(_ count: Int, errorsOnly: Bool) -> [String] { calls.append("logs:\(errorsOnly)"); return ["a log line"] }
}

final class MemoryBundleStorage: BundleStorage, @unchecked Sendable {
    private let lock = NSLock()
    var ledger = BundleLedger()
    var trial: (String, Int) = ("", 0)
    var files: [String: Data] = [:]

    func loadLedger() -> BundleLedger { lock.withLock { ledger } }
    func saveLedger(_ l: BundleLedger) { lock.withLock { ledger = l } }
    func loadTrial() -> (id: String, starts: Int) { lock.withLock { (trial.0, trial.1) } }
    func saveTrial(id: String, starts: Int) { lock.withLock { trial = (id, starts) } }
    func content(_ id: String) throws -> Data {
        guard let d = lock.withLock({ files[id] }) else { throw BundleError("the bundle's file is missing") }
        return d
    }
    func keep(_ id: String, content: Data) throws { lock.withLock { files[id] = content } }
    func delete(_ id: String) { _ = lock.withLock { files.removeValue(forKey: id) } }
    func keptIds() -> [String] { lock.withLock { Array(files.keys) } }
    func removeAll() { lock.withLock { files = [:]; ledger = BundleLedger(); trial = ("", 0) } }
}

/// A DeviceService wired to the recorded server and the fixture keys.
@MainActor
struct DeviceRig {
    let server = FixtureServer()
    let store = MemorySyncStateStore()
    let storage = MemoryBundleStorage()
    let host = RecordingHost()
    let facts = FakeFacts()
    let device: DeviceService
    var applied: [NetJSON] { appliedBox.value }
    let appliedBox = Holder<[NetJSON]>([])

    final class Holder<T>: @unchecked Sendable {
        var value: T
        init(_ v: T) { value = v }
    }

    init(clock: Millis = PushFixtures.checkinTime, agreement: any DeviceAgreement = FixtureAgreement(), signer: any DeviceSigner = FixtureSigner()) {
        let keys = KeyringEciesOpener(agreement: agreement)
        var deps = DeviceService.Dependencies(client: DeviceAPIClient(http: HTTPClient(transport: server), clock: NetClock { clock }), store: store,
                                              signer: KeyringRequestSigner(signer: signer), opener: keys, facts: facts, clock: NetClock { clock },
                                              appCode: 61400)
        let box = appliedBox
        deps.applyPolicy = { answer, _, _ in box.value.append(answer); return answer.obj("policySigned") != nil }
        deps.agree = keys.agree
        deps.defaultServer = PushFixtures.base
        let bundles = DesignBundleStore(storage: storage, crypto: DeviceBundleCrypto(opener: keys), appCode: 61400, now: { Double(clock) })
        bundles.builtIn = { nil }
        device = DeviceService(deps, bundles: bundles, events: DeviceEvents(store: store, clock: NetClock { clock }))
        device.host = host
    }

    /// Enrols through the recorded /info and /enroll (the QR code's kid pins the key).
    func enroll() async -> Bool {
        device.takeEnrollLink(URL(string: "m5cet://enroll?server=chat.example.com&kid=\(PushFixtures.serverKid)")!)
        return await device.enroll(code: "", name: "Test iPhone")
    }
}
