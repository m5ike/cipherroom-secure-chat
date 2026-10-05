// An insertion-ordered map (Java's LinkedHashMap) for the protocol's bounded
// key stores: skipped message keys, chains, replay ids, outboxes.

public struct OrderedMap<Key: Hashable & Sendable, Value: Sendable>: Sendable {
    public private(set) var keys: [Key] = []
    private var values: [Key: Value] = [:]

    public init() {}

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    public subscript(key: Key) -> Value? {
        get { values[key] }
        set {
            if let v = newValue {
                if values.updateValue(v, forKey: key) == nil { keys.append(key) }
            } else {
                _ = remove(key)
            }
        }
    }

    @discardableResult
    public mutating func remove(_ key: Key) -> Value? {
        guard let v = values.removeValue(forKey: key) else { return nil }
        if let i = keys.firstIndex(of: key) { keys.remove(at: i) }
        return v
    }

    public var first: (key: Key, value: Value)? { keys.first.map { ($0, values[$0]!) } }
    public var orderedValues: [Value] { keys.map { values[$0]! } }
    public var entries: [(key: Key, value: Value)] { keys.map { ($0, values[$0]!) } }

    public mutating func removeAll() { keys.removeAll(); values.removeAll() }
}
