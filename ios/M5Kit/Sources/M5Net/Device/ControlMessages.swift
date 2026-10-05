// Port of A/push/Control.java (docs/android-architecture.md §1.8): the
// server's control messages — the same wire form whether a push (APNs on iOS,
// FCM on Android) or a check-in brought them:
//
//   { i, e, iv, ct, s }   i: the message id; e/iv/ct: ECIES sealed for this
//                         device ("push" purpose); s: the server's P1363
//                         signature over "m5push/1|deviceId|i|e|iv|ct"
//
// Each is checked (the pinned key), opened (the device's encryption key —
// EciesOpener, the Secure Enclave on iOS), its id matched, deduplicated (the
// last 300 ids), checked for expiry, and handed to the app as a command to
// carry out and acknowledge (DeviceAPIClient.ack).

import Foundation

/// ECIES as the server seals for one device (server/android/crypto.ts eciesSeal): an ephemeral P-256 key `e`
/// (SPKI, base64), `iv` (12 bytes), `ct` (AES-256-GCM ciphertext ‖ tag).
public struct EciesEnvelope: Sendable, Equatable {
    public let e: String
    public let iv: String
    public let ct: String
    public init(e: String, iv: String, ct: String) {
        self.e = e
        self.iv = iv
        self.ct = ct
    }
    public init?(_ j: NetJSON?) {
        guard let j, !j.str("e").isEmpty, !j.str("iv").isEmpty, !j.str("ct").isEmpty else { return nil }
        self.init(e: j.str("e"), iv: j.str("iv"), ct: j.str("ct"))
    }
}

/// The device's encryption key (Android: Config.encPrivateKey; iOS: a Secure Enclave key-agreement key).
/// The scheme (crypto.ts eciesSeal / eciesOpen):
///   shared = ECDH-P256(device key, e)
///   key    = HKDF-SHA256(ikm: shared, salt: "m5cet/android/ecies/1", info: "<purpose>|<deviceId>", 32 bytes)
///   plain  = AES-256-GCM-open(key, iv, ct, aad: "m5cet/android/ecies/1|<purpose>|<deviceId>")
/// Purposes: "push" (control messages), "bundle|<bundle id>" (a design bundle's content key).
public protocol EciesOpener: Sendable {
    /// The public key, SPKI DER base64 (/enroll `encKey`).
    func publicKeySPKI() async throws -> String
    func open(_ wire: EciesEnvelope, deviceId: String, purpose: String) async throws -> Data
}

public enum ControlKind: String, Sendable {
    case ping, status, flash, push, notify, update, config, lock, wipe
    case unknown
}

/// A control message checked and opened: the app carries it out and acknowledges it (`id`).
public struct ControlCommand: Sendable {
    public let id: String
    public let kind: ControlKind
    /// The kind as the server wrote it (also for `.unknown`).
    public let kindName: String
    public let payload: NetJSON
    /// Expiry (ms), 0 = none.
    public let exp: Millis
    /// "apns", "checkin", …
    public let via: String
}

public enum ControlOutcome: Sendable {
    case command(ControlCommand)
    /// Not carried out (and not acknowledged): why.
    case dropped(String)
    /// Seen before: already handled.
    case duplicate(String)
}

public actor ControlInbox {
    private let store: any NetStateStore
    private let opener: any EciesOpener
    private let clock: NetClock
    /// The record of seen ids (Android: system tier "seen").
    public static let seenKey = "seen"
    static let keep = 300

    public init(store: any NetStateStore, opener: any EciesOpener, clock: NetClock = .system) {
        self.store = store
        self.opener = opener
        self.clock = clock
    }

    /// The control message's wire inside a push payload: the fields at the top or under "m5" (an object).
    public static func wire(fromPush payload: NetJSON) -> NetJSON? {
        if let inner = payload.obj("m5"), !inner.str("i").isEmpty { return inner }
        return payload.str("i").isEmpty ? nil : payload
    }

    /// The signed string of a wire (DeviceSigning.pushString).
    public static func signedString(_ wire: NetJSON, deviceId: String) -> String {
        DeviceSigning.pushString(deviceId: deviceId, id: wire.str("i"), e: wire.str("e"), iv: wire.str("iv"), ct: wire.str("ct"))
    }

    /// Checks, opens, deduplicates and checks the expiry of one control message (Control.handle).
    public func handle(_ wire: NetJSON, deviceId: String, serverKey: String, via: String) async -> ControlOutcome {
        let id = wire.str("i")
        if id.isEmpty || deviceId.isEmpty { return .dropped("no message id or not enrolled") }
        guard P256Keys.verify(spki: serverKey, text: Self.signedString(wire, deviceId: deviceId), signature: wire.str("s")) else {
            return .dropped("message \(id) is not signed by the server")
        }
        let content: NetJSON
        do {
            let plain = try await opener.open(EciesEnvelope(e: wire.str("e"), iv: wire.str("iv"), ct: wire.str("ct")), deviceId: deviceId, purpose: "push")
            content = try NetJSON.parse(plain)
        } catch {
            return .dropped("message \(id) cannot be opened: \(error)")
        }
        if content.str("id") != id { return .dropped("message id mismatch") }
        if await seen(id) { return .duplicate(id) }
        let exp = content.int("exp")
        if exp > 0, exp < clock.now() { return .dropped("message \(id) expired") }
        let kind = content.str("kind")
        return .command(ControlCommand(id: id, kind: ControlKind(rawValue: kind) ?? .unknown, kindName: kind, payload: content.obj("payload") ?? .object([:]),
                                       exp: exp, via: via))
    }

    /// Remembers `id`; true when it was seen before.
    private func seen(_ id: String) async -> Bool {
        var ids = await store.load(Self.seenKey)?.arr("ids")?.compactMap(\.stringValue) ?? []
        if ids.contains(id) { return true }
        ids.append(id)
        if ids.count > Self.keep { ids.removeFirst(ids.count - Self.keep) }
        await store.save(Self.seenKey, ["ids": .strings(ids)])
        return false
    }
}
