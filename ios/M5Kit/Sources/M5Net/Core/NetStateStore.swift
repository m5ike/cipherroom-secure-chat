// Persistence the network layer needs, as the app provides it.
//
// Android keeps these as JSON records in its vault (system tier: readable
// while the app is locked — the device config, seen control ids; user tier:
// only unlocked — resume secrets, key transparency, the account session, slot
// revisions). On iOS the app backs a NetStateStore with the Keychain or a
// Data Protection file of the right class and hands each service the store of
// its tier. The documents keep Android's shapes (same field names), so a
// state can be compared or migrated across platforms.

import Foundation

public protocol NetStateStore: Sendable {
    /// The document under `key`, or nil when there is none (or it cannot be read now — locked).
    func load(_ key: String) async -> NetJSON?
    /// Stores (nil: removes) the document under `key`.
    func save(_ key: String, _ value: NetJSON?) async
}

/// In memory (tests, previews, and a stand-in while the real store is locked).
public actor MemoryNetStateStore: NetStateStore {
    private var docs: [String: NetJSON]
    public init(_ docs: [String: NetJSON] = [:]) { self.docs = docs }
    public func load(_ key: String) async -> NetJSON? { docs[key] }
    public func save(_ key: String, _ value: NetJSON?) async { docs[key] = value }
    public func all() -> [String: NetJSON] { docs }
}
