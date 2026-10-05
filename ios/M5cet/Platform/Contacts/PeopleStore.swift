// What the app keeps of people (6.2), in the vault's user tier — port of
// android/app/src/main/java/cz/m5cet/app/contacts/Store.java, the same records
// and the same JSON:
//
//   people.links     username key → {username, contact (its name), lookup, id, at}:
//                    the links with address-book contacts, so a link survives the
//                    integration being switched off and on, and a contact or a
//                    Siri / share-sheet suggestion acts only for a username linked
//                    here. iOS keeps the CNContact identifier in "lookup" (Android:
//                    the lookup key) and 0 in "id" (iOS has no numeric contact id).
//   people.verified  device key id → the time its safety number was compared
//
// Read often (every refresh of the People widget, every hello a room checks), so
// kept in memory while the vault is open; the app locked → forget(). Thread-safe:
// the room sessions ask verified(kid) from their own actors (M5Proto RoomSession's
// verifiedDevice closure).

import Foundation
import M5Core
import Synchronization

/// The vault's user tier, as far as the people store needs it — Platform/Security implements it
/// (Android: Vault.json / putJson with Tier.USER). Called from any thread.
protocol PeopleVault: AnyObject, Sendable {
    /// The vault is open (PIN / biometric); a closed vault reads as empty and keeps no writes.
    var isUnlocked: Bool { get }
    /// A record's bytes (UTF-8 JSON), nil when there is none.
    func readRecord(_ name: String) -> Data?
    func writeRecord(_ name: String, _ data: Data) throws
}

final class PeopleStore: Sendable {
    static let linksRecord = "people.links"
    static let verifiedRecord = "people.verified"

    private struct State {
        var vault: (any PeopleVault)?
        var links: JSONObject?
        var verified: JSONObject?
    }

    private let state: Mutex<State>
    private let clock: any Clock

    init(vault: (any PeopleVault)? = nil, clock: any Clock = SystemClock()) {
        state = Mutex(State(vault: vault))
        self.clock = clock
    }

    /// Platform/Security's vault (set once at start; tests set a fake).
    func setVault(_ vault: (any PeopleVault)?) {
        state.withLock { $0 = State(vault: vault) }
    }

    /// 6.12 (F-16): the app locked — the copies kept in memory go (read again after the unlock).
    func forget() {
        state.withLock { $0.links = nil; $0.verified = nil }
    }

    private static func read(_ s: inout State, _ name: String) -> JSONObject {
        guard let vault = s.vault, vault.isUnlocked else { s.links = nil; s.verified = nil; return JSONObject() }
        if name == linksRecord {
            if s.links == nil { s.links = load(vault, name) }
            return s.links!
        }
        if s.verified == nil { s.verified = load(vault, name) }
        return s.verified!
    }

    private static func load(_ vault: any PeopleVault, _ name: String) -> JSONObject {
        guard let data = vault.readRecord(name), let o = (try? JSON.parse(Bytes(data)))?.objectValue else { return JSONObject() }
        return o
    }

    private static func write(_ s: inout State, _ name: String, _ value: JSONObject) {
        guard let vault = s.vault, vault.isUnlocked else { return }
        do {
            try vault.writeRecord(name, Data(value.stringify().utf8))
            if name == linksRecord { s.links = value } else { s.verified = value }
        } catch {
            M5Log.shared.warn("people", "\(name) not saved: \(error)")
        }
    }

    // MARK: links

    /// The link of a username (a copy), nil when there is none.
    func link(_ username: String?) -> JSONObject? {
        let k = Match.key(username)
        guard !k.isEmpty else { return nil }
        return state.withLock { Self.read(&$0, Self.linksRecord).object(k) }
    }

    /// Every link (a copy).
    func links() -> JSONObject { state.withLock { Self.read(&$0, Self.linksRecord) } }

    /// Links a username with an address-book contact (its identifier and the name it shows).
    func putLink(username: String, contactName: String, identifier: String) {
        let k = Match.key(username)
        guard !k.isEmpty else { return }
        let now = clock.now()
        state.withLock { s in
            var all = Self.read(&s, Self.linksRecord)
            all[k] = .object(JSONObject([("username", .string(username)), ("contact", .string(contactName)),
                                         ("lookup", .string(identifier)), ("id", .int(0)), ("at", .int(now))]))
            Self.write(&s, Self.linksRecord, all)
        }
    }

    func removeLink(_ username: String?) {
        let k = Match.key(username)
        state.withLock { s in
            var all = Self.read(&s, Self.linksRecord)
            all[k] = nil
            Self.write(&s, Self.linksRecord, all)
        }
    }

    func clearLinks() { state.withLock { Self.write(&$0, Self.linksRecord, JSONObject()) } }

    /// The usernames linked here.
    func linkedUsers() -> [String] {
        links().compactMap { $0.value.objectValue?.optString("username") }
    }

    /// iOS: the username linked with an address-book contact (its identifier), nil when none is.
    func username(forContact identifier: String) -> String? {
        guard !identifier.isEmpty else { return nil }
        for (_, v) in links() {
            if let o = v.objectValue, o.optString("lookup") == identifier { return o.optString("username") }
        }
        return nil
    }

    // MARK: verified

    func verified(_ kid: String?) -> Bool {
        guard let kid, !kid.isEmpty else { return false }
        return state.withLock { Self.read(&$0, Self.verifiedRecord).has(kid) }
    }

    func setVerified(_ kid: String?, _ on: Bool) {
        guard let kid, !kid.isEmpty else { return }
        let now = clock.now()
        state.withLock { s in
            var all = Self.read(&s, Self.verifiedRecord)
            all[kid] = on ? .int(now) : nil
            Self.write(&s, Self.verifiedRecord, all)
        }
    }
}
