// The account vault's parts on the wire (server/accounts/routes.ts
// GET / PUT /api/account/vault) and their revisions (6.12, F-26).
//
// The parts are sealed by M5Crypto with the vault key; here they are bytes:
//   v1  base64( iv(12) ‖ AES-GCM(JSON) )                              no AAD (legacy)
//   v2  base64( "M5V2" ‖ rev (u64 BE) ‖ iv(12) ‖ AES-GCM(JSON) )       AAD "m5cet:vault-slot:v2|<slot>|<rev>"
// The revision is readable without the key, so a server handing back an
// OLDER version of a slot than this device has seen is noticed (warned
// about; the data still shown) — Account.nextSlotRev / noteSlotRev.

import Foundation
import M5Core

/// One stored part: its ciphertext (base64) and when the server stored it.
public struct VaultPart: Sendable, Equatable {
    public let ct: String
    public let updatedAt: Millis
    init?(_ j: NetJSON?) {
        guard let j, !j.str("ct").isEmpty else { return nil }
        ct = j.str("ct")
        updatedAt = j.int("updatedAt")
    }
}

/// GET /api/account/vault.
public struct VaultContents: Sendable, Equatable {
    public let profile: VaultPart?
    public let chat: VaultPart?
    public let connections: VaultPart?
    public let registration: VaultPart?
    public let card: VaultPart?
    public init(_ j: NetJSON) {
        profile = VaultPart(j.obj("profile"))
        chat = VaultPart(j.obj("chat"))
        connections = VaultPart(j.obj("connections"))
        registration = VaultPart(j.obj("registration"))
        card = VaultPart(j.obj("card"))
    }

    public func part(_ slot: String) -> VaultPart? {
        switch slot {
        case "profile": return profile
        case "chat": return chat
        case "connections": return connections
        case "registration": return registration
        case "card": return card
        default: return nil
        }
    }
}

/// PUT /api/account/vault: the parts to store (sealed, base64), with the counts the server shows.
public struct VaultPatch: Sendable, Equatable {
    public var profile: String?
    public var chat: (ct: String, messages: Int, messageBytes: Int, rooms: Int)?
    public var connections: (ct: String, count: Int)?
    public var registration: String?
    public var card: String?

    public init(profile: String? = nil, chat: (ct: String, messages: Int, messageBytes: Int, rooms: Int)? = nil, connections: (ct: String, count: Int)? = nil,
                registration: String? = nil, card: String? = nil) {
        self.profile = profile
        self.chat = chat
        self.connections = connections
        self.registration = registration
        self.card = card
    }

    public static func == (a: VaultPatch, b: VaultPatch) -> Bool { a.json == b.json }

    public var json: NetJSON {
        .compact([
            "profile": profile.map { .string($0) },
            "chat": chat.map { ["ct": .string($0.ct), "messages": .int(Int64($0.messages)), "messageBytes": .int(Int64($0.messageBytes)), "rooms": .int(Int64($0.rooms))] },
            "connections": connections.map { ["ct": .string($0.ct), "count": .int(Int64($0.count))] },
            "registration": registration.map { .string($0) },
            "card": card.map { .string($0) },
        ])
    }
}

public enum VaultSlotFormat {
    static let magic = Data([0x4D, 0x35, 0x56, 0x32]) // "M5V2"
    static let maxRev: Int64 = 9_007_199_254_740_991

    /// The associated data of a v2 slot (AccountKeys.slotAad).
    public static func aad(slot: String, rev: Int64) -> Data { Data("m5cet:vault-slot:v2|\(slot)|\(rev)".utf8) }

    /// A v2 part's revision (0 and v2 false for a v1 part, or one that only looks like v2 — then M5Crypto tries v1).
    public static func revision(of ciphertext: String) -> (rev: Int64, v2: Bool) {
        guard let all = Bytes.unb64(ciphertext), all.count >= 4 + 8 + 12 + 16, all.prefix(4) == magic else { return (0, false) }
        var rev: UInt64 = 0
        for b in all.dropFirst(4).prefix(8) { rev = rev << 8 | UInt64(b) }
        guard rev <= UInt64(maxRev) else { return (0, false) }
        return (Int64(rev), true)
    }
}

/// The newest revision seen of each slot, per account (Android: the user tier's "account.slots" record).
public actor VaultSlotRevisions {
    public static let record = "account.slots"
    private let store: any NetStateStore
    private let clock: NetClock

    public init(store: any NetStateStore, clock: NetClock = .system) {
        self.store = store
        self.clock = clock
    }

    /// A revision newer than any this device has seen of the slot (other devices' clocks may run ahead).
    public func next(account: String, slot: String) async -> Int64 {
        let seen = await store.load(Self.record)?.obj(account)?.int(slot) ?? 0
        return max(clock.now(), seen + 1)
    }

    /// Notes a revision opened or written; false when it is older than one seen before — a rollback (warn).
    @discardableResult
    public func note(account: String, slot: String, rev: Int64) async -> Bool {
        if account.isEmpty { return true }
        let all = await store.load(Self.record) ?? .object([:])
        let mine = all.obj(account) ?? .object([:])
        let seen = mine.int(slot)
        if rev < seen { return false }
        if rev == 0 { return true }
        await store.save(Self.record, all.with(account, mine.with(slot, .int(rev))))
        return true
    }
}
