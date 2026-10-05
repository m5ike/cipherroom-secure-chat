// 6.2 People: what the app keeps of people, in the vault (user tier) — port of
// android/…/contacts/Store.java, the same record names:
//
//   people.links     username key → {username, contact (its name), lookup, id, at}:
//                    the links with address-book contacts, so a link survives the
//                    integration being switched off and on
//   people.verified  device key id → the time its safety number was compared
//
// Read often (every refresh of the People widget), so kept in memory while the
// vault is open; the lock forgets the copies (6.12 F-16).

import Foundation
import M5Core
import os

/// Where the two records live: the vault's user tier (Platform/Security), or memory in tests and previews.
@MainActor
protocol PeopleRecords: AnyObject {
    var unlocked: Bool { get }
    /// The record ({} when there is none or it does not open).
    func read(_ name: String) -> JSONObject
    func write(_ name: String, _ value: JSONObject)
}

/// The vault's user tier (records `people.links`, `people.verified` — Android's names).
@MainActor
final class VaultPeopleRecords: PeopleRecords {
    private let vault: () -> Vault?

    init(vault: @escaping () -> Vault? = { SecurityCenter.shared?.vault }) { self.vault = vault }

    var unlocked: Bool { vault()?.unlocked ?? false }

    func read(_ name: String) -> JSONObject {
        guard let v = vault(), v.unlocked, let d = try? v.get(.user, name) else { return JSONObject() }
        return JSON.parseObject(String(decoding: d, as: UTF8.self)) ?? JSONObject()
    }

    func write(_ name: String, _ value: JSONObject) {
        guard let v = vault(), v.unlocked else { return }
        do { try v.put(.user, name, Data(value.stringify().utf8)) } catch { PeopleLog.warn("people: \(name) not saved") }
    }
}

/// In memory (tests, previews).
@MainActor
final class MemoryPeopleRecords: PeopleRecords {
    var unlocked = true
    var records: [String: JSONObject] = [:]
    func read(_ name: String) -> JSONObject { unlocked ? records[name] ?? JSONObject() : JSONObject() }
    func write(_ name: String, _ value: JSONObject) { if unlocked { records[name] = value } }
}

@MainActor
final class PeopleStore {
    static let linksRecord = "people.links", verifiedRecord = "people.verified"

    let records: any PeopleRecords
    var now: () -> Int64
    private var links: JSONObject?
    private var verified: JSONObject?

    init(records: any PeopleRecords, now: @escaping () -> Int64 = { Millis.now }) {
        self.records = records
        self.now = now
    }

    private func read(_ name: String) -> JSONObject {
        guard records.unlocked else { links = nil; verified = nil; return JSONObject() }
        if name == Self.linksRecord {
            if links == nil { links = records.read(name) }
            return links ?? JSONObject()
        }
        if verified == nil { verified = records.read(name) }
        return verified ?? JSONObject()
    }

    private func write(_ name: String, _ value: JSONObject) {
        guard records.unlocked else { return }
        records.write(name, value)
        if name == Self.linksRecord { links = value } else { verified = value }
    }

    /// 6.12 (F-16): the app locked — the copies kept in memory go (read again after the unlock).
    func forget() { links = nil; verified = nil }

    // MARK: links

    /// The link of a username, nil when there is none.
    func link(_ username: String?) -> JSONObject? {
        let k = PeopleMatch.key(username)
        return k.isEmpty ? nil : read(Self.linksRecord).object(k)
    }

    /// Every link.
    func allLinks() -> JSONObject { read(Self.linksRecord) }

    func putLink(username: String, contactName: String, lookup: String, id: Int64 = 0) {
        var all = read(Self.linksRecord)
        all[PeopleMatch.key(username)] = .object(JSONObject([("username", .string(username)), ("contact", .string(contactName)),
                                                             ("lookup", .string(lookup)), ("id", .int(id)), ("at", .int(now()))]))
        write(Self.linksRecord, all)
    }

    func removeLink(_ username: String) {
        var all = read(Self.linksRecord)
        all[PeopleMatch.key(username)] = nil
        write(Self.linksRecord, all)
    }

    func clearLinks() { write(Self.linksRecord, JSONObject()) }

    /// The usernames linked here.
    func linkedUsers() -> [String] {
        read(Self.linksRecord).compactMap { $0.value.objectValue?.optString("username") }
    }

    // MARK: verified

    func verified(_ kid: String?) -> Bool {
        guard let kid, !kid.isEmpty else { return false }
        return read(Self.verifiedRecord).has(kid)
    }

    func setVerified(_ kid: String?, _ on: Bool) {
        guard let kid, !kid.isEmpty else { return }
        var all = read(Self.verifiedRecord)
        all[kid] = on ? .int(now()) : nil
        write(Self.verifiedRecord, all)
    }
}

/// The part's log lines (os.Logger, subsystem cz.m5cet.app, category people) — never a name or a key.
enum PeopleLog {
    static let logger = os.Logger(subsystem: "cz.m5cet.app", category: "people")
    static func warn(_ s: String) { logger.notice("\(s, privacy: .public)") }
}
