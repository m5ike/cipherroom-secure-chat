// What the app and its Notification Service Extension share about pushes —
// pure code over Foundation and CryptoKit, compiled into both targets (the
// extension has it through symlinks in ios/M5cetNotifications/Shared):
//
//   LockMirror     lock-state.json, the app lock as the extension may know it
//   NeutralTexts   the neutral texts (the server's own table, server/ios/commands.ts)
//   NotifyMirror   the person's notification switches, mirrored into the SYS tier
//   PushOpener     a control message's wire checked and opened synchronously
//                  (the server's signature with the pinned key, ECIES "push",
//                  the id, the expiry) — Android push/Control without the side effects
//   PushHandoff    what the extension did with a message, for the app (one file each)
//   ThreadIds      opaque, keyed ids for threads and conversations

import CryptoKit
import Foundation

// MARK: - the lock, as the extension sees it

/// lock-state.json in the App Group (Platform/Security SecurityCenter.writeMirror — no secret in it):
/// {v, locked, bg, bgMono, boot, autolock, screenshots}.
struct LockMirror: Equatable, Sendable {
    var locked: Bool
    /// When the app went to the background (wall ms; 0: it is not in the background).
    var bg: Int64
    /// The same moment on CLOCK_MONOTONIC (ms).
    var bgMono: Int64
    /// The boot session of the record (kern.bootsessionuuid).
    var boot: String
    /// The policy's auto-lock (seconds).
    var autolock: Int

    init(locked: Bool, bg: Int64 = 0, bgMono: Int64 = 0, boot: String, autolock: Int = 60) {
        self.locked = locked
        self.bg = bg
        self.bgMono = bgMono
        self.boot = boot
        self.autolock = autolock
    }

    init?(data: Data) {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        func i64(_ k: String) -> Int64 { (o[k] as? NSNumber)?.int64Value ?? 0 }
        locked = (o["locked"] as? Bool) ?? true
        bg = i64("bg")
        bgMono = i64("bgMono")
        boot = (o["boot"] as? String) ?? ""
        autolock = Int(i64("autolock"))
    }

    /// The Security README's rule: locked, or another boot (the app process is gone and starts locked),
    /// or in the background for at least the auto-lock time (CLOCK_MONOTONIC: setting the clock changes nothing).
    func isLocked(nowMono: Int64, boot now: String) -> Bool {
        if locked { return true }
        if boot.isEmpty || boot != now { return true }
        if bg > 0, nowMono - bgMono >= Int64(autolock) * 1000 { return true }
        return false
    }

    /// The app counts as locked now (no record, or one that does not read: locked).
    static func appLocked(at url: URL) -> Bool {
        guard let d = try? Data(contentsOf: url), let m = LockMirror(data: d) else { return true }
        return m.isLocked(nowMono: monoMs(), boot: bootSession)
    }

    static func monoMs() -> Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) }

    /// kern.bootsessionuuid (as SystemLockClock reads it).
    static let bootSession: String = {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &buf, &size, nil, 0) == 0 else { return "" }
        return String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }()
}

// MARK: - neutral texts

/// What a notification says when it may say nothing: the same table as the server's neutral APNs
/// alerts (server/ios/commands.ts NEUTRAL), plus a missed call. The app prefers the design's texts.
enum NeutralTexts {
    enum Kind: String, CaseIterable, Sendable { case message, call, notice, security, missed }

    private static let table: [String: [Kind: String]] = [
        "cs": [.message: "Nová zpráva", .call: "Příchozí hovor", .notice: "Nové upozornění", .security: "Bezpečnostní oznámení", .missed: "Zmeškaný hovor"],
        "en": [.message: "New message", .call: "Incoming call", .notice: "New notification", .security: "Security notice", .missed: "Missed call"],
        "de": [.message: "Neue Nachricht", .call: "Eingehender Anruf", .notice: "Neue Benachrichtigung", .security: "Sicherheitshinweis", .missed: "Verpasster Anruf"],
        "es": [.message: "Nuevo mensaje", .call: "Llamada entrante", .notice: "Nueva notificación", .security: "Aviso de seguridad", .missed: "Llamada perdida"],
        "it": [.message: "Nuovo messaggio", .call: "Chiamata in arrivo", .notice: "Nuova notifica", .security: "Avviso di sicurezza", .missed: "Chiamata persa"],
        "fr": [.message: "Nouveau message", .call: "Appel entrant", .notice: "Nouvelle notification", .security: "Avis de sécurité", .missed: "Appel manqué"],
        "sk": [.message: "Nová správa", .call: "Prichádzajúci hovor", .notice: "Nové upozornenie", .security: "Bezpečnostné oznámenie", .missed: "Zmeškaný hovor"],
        "sl": [.message: "Novo sporočilo", .call: "Dohodni klic", .notice: "Novo obvestilo", .security: "Varnostno obvestilo", .missed: "Zgrešen klic"],
        "fi": [.message: "Uusi viesti", .call: "Saapuva puhelu", .notice: "Uusi ilmoitus", .security: "Tietoturvailmoitus", .missed: "Vastaamaton puhelu"],
    ]

    static let languages = ["cs", "en", "de", "es", "it", "fr", "sk", "sl", "fi"]

    /// Whether a text is one of the neutral texts (the server's APNs alert, in any of the nine languages).
    static func isNeutral(_ text: String) -> Bool { table.values.contains { $0.values.contains(text) } }

    /// The text in `lang` ("cs", "cs-CZ", …), else English.
    static func text(_ kind: Kind, lang: String) -> String {
        let l = String(lang.prefix(2)).lowercased()
        return table[l]?[kind] ?? table["en"]![kind]!
    }

    /// The device's language among the nine (Locale.preferredLanguages).
    static var deviceLanguage: String {
        for l in Locale.preferredLanguages {
            let p = String(l.prefix(2)).lowercased()
            if table[p] != nil { return p }
        }
        return "en"
    }

    /// The neutral kind for a notification kind (message, mention, call, function, summon, test…).
    static func kind(forNotify kind: String) -> Kind {
        switch kind {
        case "message", "mention": .message
        case "call": .call
        default: .notice
        }
    }

    /// The design key of a neutral text (Android Notify's EXTRA_NEUTRAL) for a neutral kind.
    static func designKey(_ kind: Kind) -> String {
        switch kind {
        case .message: "notify.message"
        case .call: "ring.call"
        case .missed: "ring.missed"
        case .notice, .security: "notify.message"
        }
    }
}

// MARK: - the person's switches, for the extension

/// The notify.* settings the extension needs (Android NotifyPrefs read Settings), kept by the app as
/// the SYS record "notify-prefs" (readable while locked — nothing in it names a room or a person).
struct NotifyMirror: Codable, Equatable, Sendable {
    static let record = "notify-prefs"
    static let kinds = ["message", "mention", "call", "function", "summon"]

    var on = true
    var kinds: [String: Bool] = Dictionary(uniqueKeysWithValues: NotifyMirror.kinds.map { ($0, true) })
    /// "" (the server's default) | neutral | sender | room | content.
    var privacy = ""
    var quiet = false
    var quietFrom = "22:00"
    var quietTo = "07:00"
    /// The time zone of the quiet hours ("" = the phone's).
    var timeZone = ""
    var lockScreenHide = false
    /// The design's app name (titles of neutral notifications).
    var appName = "M5cet"
    /// The person's language (neutral texts).
    var lang = ""

    init() {}

    /// Whether a notification of `kind` may show now (the switches and quiet hours; a test always).
    func allows(_ kind: String, at: Int64) -> Bool {
        if kind == "test" { return true }
        if !on || !(kinds[kind] ?? true) { return false }
        return !NotifyTemplate.inQuietHours(quiet, quietFrom, quietTo, timeZone, at)
    }

    var data: Data { (try? JSONEncoder().encode(self)) ?? Data("{}".utf8) }

    static func from(_ data: Data?) -> NotifyMirror {
        guard let data, let m = try? JSONDecoder().decode(NotifyMirror.self, from: data) else { return NotifyMirror() }
        return m
    }

    enum CodingKeys: String, CodingKey { case on, kinds, privacy, quiet, quietFrom, quietTo, timeZone, lockScreenHide, appName, lang }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        on = try c.decodeIfPresent(Bool.self, forKey: .on) ?? true
        kinds = try c.decodeIfPresent([String: Bool].self, forKey: .kinds) ?? kinds
        privacy = try c.decodeIfPresent(String.self, forKey: .privacy) ?? ""
        quiet = try c.decodeIfPresent(Bool.self, forKey: .quiet) ?? false
        quietFrom = try c.decodeIfPresent(String.self, forKey: .quietFrom) ?? "22:00"
        quietTo = try c.decodeIfPresent(String.self, forKey: .quietTo) ?? "07:00"
        timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone) ?? ""
        lockScreenHide = try c.decodeIfPresent(Bool.self, forKey: .lockScreenHide) ?? false
        appName = try c.decodeIfPresent(String.self, forKey: .appName) ?? "M5cet"
        lang = try c.decodeIfPresent(String.self, forKey: .lang) ?? ""
    }
}

// MARK: - a control message, checked and opened

/// A control message's wire ({i, e, iv, ct, s}) checked and opened without side effects — synchronous,
/// for the places that cannot await: the notification extension and PushKit's handler (every VoIP push
/// must reach CallKit before it returns). The app's normal path is M5Net's ControlInbox (the same checks,
/// plus the "seen" record).
enum PushOpener {
    static let eciesLabel = "m5cet/android/ecies/1"

    struct Opened: @unchecked Sendable {
        let id: String
        let kind: String
        let payload: [String: Any]
        /// Expiry (ms), 0 = none.
        let exp: Int64
        /// When the server made it (ms), 0 = unknown.
        let at: Int64
    }

    enum Failure: Error, Equatable, Sendable {
        case noWire, notEnrolled, notSigned, cannotOpen, idMismatch, expired
    }

    /// The wire inside a push payload: the fields under "m5" (an object), or at the top.
    static func wire(from payload: [AnyHashable: Any]) -> [String: String]? {
        func strings(_ o: [AnyHashable: Any]) -> [String: String]? {
            var out: [String: String] = [:]
            for k in ["m5", "i", "e", "iv", "ct", "s"] { if let v = o[k] as? String { out[k] = v } }
            return (out["i"] ?? "").isEmpty ? nil : out
        }
        if let inner = payload["m5"] as? [AnyHashable: Any], let w = strings(inner) { return w }
        if let inner = payload["m5"] as? [String: String] { return strings(inner) }
        return strings(payload)
    }

    /// m5push/1|deviceId|i|e|iv|ct (server/mobile/crypto.ts pushSignedString).
    static func signedString(_ wire: [String: String], deviceId: String) -> String {
        ["m5push/1", deviceId, wire["i"] ?? "", wire["e"] ?? "", wire["iv"] ?? "", wire["ct"] ?? ""].joined(separator: "|")
    }

    /// ECDSA P-256 / SHA-256, a P1363 signature (base64) by an SPKI key (base64).
    static func verify(spki: String, text: String, signature: String) -> Bool {
        guard let der = Data(base64Encoded: spki.trimmingCharacters(in: .whitespacesAndNewlines)),
              let key = try? P256.Signing.PublicKey(derRepresentation: der),
              let raw = Data(base64Encoded: signature), raw.count == 64,
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else { return false }
        return key.isValidSignature(sig, for: Data(text.utf8))
    }

    /// ECIES as the server seals for one device: shared = ECDH(device key, e) (`agree`), key =
    /// HKDF-SHA256(salt "m5cet/android/ecies/1", info "<purpose>|<deviceId>"), AES-256-GCM with AAD
    /// "m5cet/android/ecies/1|<purpose>|<deviceId>".
    static func eciesOpen(e: String, iv: String, ct: String, deviceId: String, purpose: String,
                          agree: (P256.KeyAgreement.PublicKey) throws -> Data) throws -> Data {
        guard let eDer = Data(base64Encoded: e), let ivData = Data(base64Encoded: iv), ivData.count == 12,
              let all = Data(base64Encoded: ct), all.count >= 16 else { throw Failure.cannotOpen }
        let eph = try P256.KeyAgreement.PublicKey(derRepresentation: eDer)
        var shared = try agree(eph)
        defer { shared.resetBytes(in: 0..<shared.count) }
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: shared), salt: Data(eciesLabel.utf8),
                                         info: Data("\(purpose)|\(deviceId)".utf8), outputByteCount: 32)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: ivData), ciphertext: all.dropLast(16), tag: all.suffix(16))
        return try AES.GCM.open(box, using: key, authenticating: Data("\(eciesLabel)|\(purpose)|\(deviceId)".utf8))
    }

    /// Checks and opens one control message (Android Control.handle up to the dedupe): the server's
    /// signature with the pinned key, ECIES (purpose "push"), the id inside, the expiry.
    static func open(_ wire: [String: String], deviceId: String, serverKey: String, now: Int64,
                     agree: (P256.KeyAgreement.PublicKey) throws -> Data) throws -> Opened {
        let id = wire["i"] ?? ""
        if id.isEmpty { throw Failure.noWire }
        if deviceId.isEmpty || serverKey.isEmpty { throw Failure.notEnrolled }
        guard verify(spki: serverKey, text: signedString(wire, deviceId: deviceId), signature: wire["s"] ?? "") else { throw Failure.notSigned }
        let plain: Data
        do {
            plain = try eciesOpen(e: wire["e"] ?? "", iv: wire["iv"] ?? "", ct: wire["ct"] ?? "", deviceId: deviceId, purpose: "push", agree: agree)
        } catch {
            throw Failure.cannotOpen
        }
        guard let content = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] else { throw Failure.cannotOpen }
        guard (content["id"] as? String) == id else { throw Failure.idMismatch }
        let exp = (content["exp"] as? NSNumber)?.int64Value ?? 0
        if exp > 0, exp < now { throw Failure.expired }
        return Opened(id: id, kind: (content["kind"] as? String) ?? "", payload: (content["payload"] as? [String: Any]) ?? [:], exp: exp,
                      at: (content["at"] as? NSNumber)?.int64Value ?? 0)
    }

    static func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}

// MARK: - what the extension did, for the app

/// The extension's notes for the app (Application Support/m5/push-handoff in the App Group, one file
/// per message, no secret: ids, kinds and — for lock / wipe — the sealed wire as it came). The app
/// reads them at start and in the foreground: a lock or wipe goes through ControlInbox (verified again)
/// and is carried out; a message the extension showed is acknowledged without showing it twice.
struct PushHandoff: Sendable {
    struct Entry: Codable, Equatable, Sendable {
        var id: String
        var kind: String
        /// The extension posted a notification for it.
        var shown: Bool
        /// The sealed wire of a lock / wipe (the app opens and checks it itself).
        var wire: [String: String]?
        /// When the extension handled it (ms).
        var at: Int64
    }

    let dir: URL

    /// The App Group's handoff directory (`shared` = Application Support/m5 of the group).
    init(shared: URL) { dir = shared.appendingPathComponent("push-handoff", isDirectory: true) }

    /// The file of an id; nil for an id that is not a plain command id (the server's are "cmd_…").
    private func url(_ id: String) -> URL? {
        let plain = !id.isEmpty && id.count <= 80 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
        return plain ? dir.appendingPathComponent(id + ".json") : nil
    }

    func record(_ e: Entry) {
        guard let u = url(e.id), let data = try? JSONEncoder().encode(e) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try? data.write(to: u, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func entry(_ id: String) -> Entry? {
        guard let u = url(id), let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(Entry.self, from: d)
    }

    func entries() -> [Entry] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }
            .compactMap { (try? Data(contentsOf: $0)).flatMap { try? JSONDecoder().decode(Entry.self, from: $0) } }
            .sorted { $0.at < $1.at }
    }

    func remove(_ id: String) {
        if let u = url(id) { try? FileManager.default.removeItem(at: u) }
    }

    /// Drops what is older than `ms` (a command's TTL is at most 30 days).
    func purge(olderThan ms: Int64, now: Int64) {
        for e in entries() where now - e.at > ms { remove(e.id) }
    }
}

// MARK: - opaque ids

/// Ids that say nothing of a room (Android ConversationPlan.id, 6.8): keyed with a secret of this
/// install (SYS record "conversations" {k: 32 hex}), so neither Apple nor another app can tell a room.
enum ThreadIds {
    static let record = "conversations"

    static func hmacHex(_ secret: Data, _ text: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: SymmetricKey(data: secret.isEmpty ? Data([0]) : secret))
        return mac.map { String(format: "%02x", $0) }.joined()
    }

    /// A room's conversation / thread id: "conv-" + 80 bits of HMAC-SHA256(secret, "m5cet/conversation\0" + room key).
    static func conversation(secret: Data, roomKey: String) -> String {
        "conv-" + String(hmacHex(secret, "m5cet/conversation\u{0}" + roomKey).prefix(20))
    }

    /// The key under which the app maps the server's opaque room id to a room's thread (record "threads"),
    /// so a notification the extension draws joins the room's thread without the room key.
    static func serverRoom(secret: Data, serverRoomId: String) -> String {
        "srv-" + String(hmacHex(secret, "m5cet/server-room\u{0}" + serverRoomId).prefix(20))
    }

    /// The secret of a "conversations" record ({k: 32 hex}), nil when it has none.
    static func secret(fromRecord o: [String: Any]?) -> Data? {
        guard let k = o?["k"] as? String, k.count == 32, k.allSatisfy(\.isHexDigit) else { return nil }
        var out = Data()
        var i = k.startIndex
        while i < k.endIndex {
            let j = k.index(i, offsetBy: 2)
            guard let b = UInt8(k[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        return out
    }
}
