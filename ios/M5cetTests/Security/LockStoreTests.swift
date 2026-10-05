// The attempt counter sealed by a key that changes with every write (Android
// LockStoreTest, case for case): an older copy (or none) is a rollback; a never
// sealed record is not; a stop between any two steps of a write is not one either;
// keys that cannot be read decide nothing. Then the same on the real parts: the
// Keychain record and the Keyring's counter keys (software and Secure Enclave).

import XCTest
@testable import M5cet

final class LockStoreTests: XCTestCase {
    /// The process: once it "died" (killed between two steps), nothing more happens until revived.
    final class Life {
        var dead = false
    }

    /// The keys by generation, with switches to make them fail or "kill the process".
    final class Keys: LockAnchor {
        var keys: [Int64: Data] = [:]
        var unreadable = false, noCreate = false, noMac = false
        var dieAfterCreate = -1, dieAtDelete = -1
        var creates = 0, deletes = 0
        var life = Life()
        var died: Bool {
            get { life.dead }
            set { life.dead = newValue }
        }

        func generations() -> Set<Int64>? { unreadable ? nil : Set(keys.keys) }
        func create(_ gen: Int64) -> Bool {
            if died { return false }
            if noCreate { return false }
            keys[gen] = Bytes.random(32)
            creates += 1
            if creates == dieAfterCreate { died = true }
            return true
        }
        func delete(_ gen: Int64) {
            if died { return }
            deletes += 1
            if deletes == dieAtDelete { died = true; return }
            keys[gen] = nil
        }
        func mac(_ gen: Int64, _ data: Data) -> Data? {
            if died { return nil }
            guard !noMac, let k = keys[gen] else { return nil }
            return SecCrypto.hmac(key: k, data)
        }
    }

    final class Disk: LockRecords {
        var record: SecRecord = [:]
        var unavailable = false, noWrite = false
        var dieAfterWrite = -1, writes = 0
        var life = Life()
        var died: Bool {
            get { life.dead }
            set { life.dead = newValue }
        }

        func read() -> SecRecord? { unavailable ? nil : SecJSON.parse(SecJSON.data(record)) }
        func write(_ r: SecRecord) -> Bool {
            if died { return false }
            if noWrite { return false }
            record = SecJSON.parse(SecJSON.data(r))!
            writes += 1
            if writes == dieAfterWrite { died = true }
            return true
        }
    }

    /// One process for both: a stop in either ends every later step (Android's tests throw through the store).
    private func pair() -> (Keys, Disk) {
        let k = Keys(), d = Disk()
        d.life = k.life
        return (k, d)
    }

    /// The process "dies" after a step: the steps after it do not happen.
    private func revive(_ k: Keys, _ d: Disk) {
        k.died = false; k.dieAfterCreate = -1; k.dieAtDelete = -1
        d.died = false; d.dieAfterWrite = -1
    }

    private func state(_ attempts: Int) -> SecRecord { ["attempts": attempts, "until": 0] }

    func testANeverSealedRecordKeepsTheAttemptsAndIsSealedAtItsNextWrite() {
        let (keys, disk) = pair()
        disk.record = ["attempts": 3, "until": 0, "last": 1]
        let s = LockStore(anchor: keys, records: disk)
        var v = s.load()
        XCTAssertEqual(v.verdict, .legacy)
        XCTAssertEqual(v.state.jInt("attempts"), 3)
        var next = v.state
        LockCounter.begin(&next, now: LockTime(wallMs: 10, monoMs: 10, boot: "A"))
        XCTAssertTrue(s.save(next))
        XCTAssertEqual(disk.record.jInt64(LockStore.gen), 1)
        XCTAssertFalse(disk.record.jHas(LockStore.mig))
        XCTAssertEqual(Set(keys.keys.keys), [1])
        v = s.load()
        XCTAssertEqual(v.verdict, .ok)
        XCTAssertEqual(v.state.jInt("attempts"), 4)
        XCTAssertTrue(LockCounter.interrupted(v.state))
        let fresh = LockStore(anchor: Keys(), records: Disk())
        XCTAssertEqual(fresh.load().verdict, .legacy)
        XCTAssertEqual(fresh.load().state.jInt("attempts"), 0)
    }

    func testAFirstSealStoppedHalfwayIsNoRollback() {
        for stop in 1...2 {
            let (keys, disk) = pair()
            disk.record = state(2)
            let s = LockStore(anchor: keys, records: disk)
            if stop == 1 { disk.dieAfterWrite = 1 } else { keys.dieAfterCreate = 1 }
            _ = s.save(state(3))
            revive(keys, disk)
            let v = s.load()
            XCTAssertEqual(v.verdict, .legacy, "stop \(stop)")
            XCTAssertEqual(v.state.jInt("attempts"), 3, "stop \(stop)")
            XCTAssertTrue(s.save(state(4)))
            XCTAssertEqual(s.load().verdict, .ok)
            XCTAssertEqual(keys.keys.count, 1)
        }
    }

    func testEveryWriteRotatesAndAnOlderCopyIsARollback() {
        let (keys, disk) = pair()
        let s = LockStore(anchor: keys, records: disk)
        XCTAssertTrue(s.save(state(1)))
        let first = disk.record
        XCTAssertTrue(s.save(state(2)))
        let second = disk.record
        XCTAssertTrue(s.save(state(5)))
        XCTAssertEqual(Set(keys.keys.keys), [3], "one generation at a time")
        XCTAssertEqual(s.load().verdict, .ok)
        for old in [first, second] {
            disk.record = old
            XCTAssertEqual(s.load().verdict, .rollback)
        }
        disk.record = state(0)
        XCTAssertEqual(s.load().verdict, .rollback, "an unsealed record put back after the first seal")
        disk.record = [:]
        XCTAssertEqual(s.load().verdict, .rollback, "the record deleted while a key exists")
        XCTAssertTrue(s.save(state(6)))
        var edited = disk.record
        edited["attempts"] = 0
        disk.record = edited
        XCTAssertEqual(s.load().verdict, .rollback, "an edited record: the seal does not match")
        disk.record = [LockStore.unreadable: true]
        XCTAssertEqual(s.load().verdict, .rollback)
    }

    func testAStopBetweenTheStepsOfAWriteIsNoRollback() {
        for stop in 1...2 {
            let (keys, disk) = pair()
            let s = LockStore(anchor: keys, records: disk)
            XCTAssertTrue(s.save(state(1)))
            XCTAssertTrue(s.save(state(2)))
            // After the new key (before the record), or after the record (before the old key's deletion).
            if stop == 1 { keys.dieAfterCreate = keys.creates + 1 } else { keys.dieAtDelete = keys.deletes + 1 }
            _ = s.save(state(3))
            revive(keys, disk)
            XCTAssertEqual(keys.keys.count, 2, "stop \(stop): two generations meanwhile")
            let v = s.load()
            XCTAssertEqual(v.verdict, .ok, "stop \(stop)")
            XCTAssertEqual(v.state.jInt("attempts"), stop == 1 ? 2 : 3, "stop \(stop)")
            XCTAssertTrue(s.save(state(4)))
            XCTAssertEqual(keys.keys.count, 1)
            XCTAssertEqual(s.load().verdict, .ok)
        }
    }

    func testKeysThatCannotBeReadDecideNothing() {
        let (keys, disk) = pair()
        let s = LockStore(anchor: keys, records: disk)
        XCTAssertTrue(s.save(state(2)))
        keys.unreadable = true
        XCTAssertEqual(s.load().verdict, .unverified)
        XCTAssertEqual(s.load().state.jInt("attempts"), 2)
        XCTAssertFalse(s.save(state(3)), "not stored → not checked")
        keys.unreadable = false
        keys.noMac = true
        XCTAssertEqual(s.load().verdict, .unverified)
        XCTAssertFalse(s.save(state(3)))
        XCTAssertEqual(keys.keys.count, 1, "the key made for the failed write is gone again")
        keys.noMac = false
        disk.unavailable = true
        XCTAssertEqual(s.load().verdict, .unverified)
        disk.unavailable = false
        disk.noWrite = true
        XCTAssertFalse(s.save(state(3)))
        disk.noWrite = false
        XCTAssertEqual(s.load().verdict, .ok)
        XCTAssertEqual(s.load().state.jInt("attempts"), 2)
    }

    func testWithoutNewKeysItStillCounts() {
        let none = Keys()
        none.noCreate = true
        let disk = Disk()
        let s = LockStore(anchor: none, records: disk)
        XCTAssertTrue(s.save(state(4)))
        XCTAssertEqual(s.load().verdict, .legacy)
        XCTAssertEqual(s.load().state.jInt("attempts"), 4)
        let keys = Keys(), d2 = Disk()
        let s2 = LockStore(anchor: keys, records: d2)
        XCTAssertTrue(s2.save(state(1)))
        keys.noCreate = true
        XCTAssertTrue(s2.save(state(2)))
        XCTAssertEqual(d2.record.jInt64(LockStore.gen), 1)
        XCTAssertEqual(s2.load().verdict, .ok)
        XCTAssertEqual(s2.load().state.jInt("attempts"), 2)
    }

    func testKeysGoneWithASealedRecordIsARollback() {
        let (keys, disk) = pair()
        let s = LockStore(anchor: keys, records: disk)
        XCTAssertTrue(s.save(state(1)))
        keys.keys.removeAll()
        XCTAssertEqual(s.load().verdict, .rollback)
        let d2 = Disk()
        d2.record = [LockStore.unreadable: true]
        XCTAssertEqual(LockStore(anchor: Keys(), records: d2).load().verdict, .legacy, "an unreadable record before the first seal reads as none")
    }

    func testTheSealCoversWhatDecides() {
        let a: SecRecord = ["attempts": 3, "until": 0, "pending": 5, "last": 7, "untilMono": 9, "boot": "A", "wait": 30_000]
        let base = LockStore.canonical(a, gen: 4)
        func changed(_ k: String, _ v: Any?) -> Data {
            var b = a
            b[k] = v
            return LockStore.canonical(b, gen: 4)
        }
        XCTAssertNotEqual(base, changed("attempts", 2))
        XCTAssertNotEqual(base, changed("until", 99))
        XCTAssertNotEqual(base, changed("pending", 6))
        XCTAssertNotEqual(base, changed("pending", nil))
        XCTAssertNotEqual(base, changed("untilMono", 10), "iOS: the monotonic wait is sealed too")
        XCTAssertNotEqual(base, changed("boot", "B"))
        XCTAssertNotEqual(base, changed("wait", 1))
        XCTAssertNotEqual(base, LockStore.canonical(a, gen: 5))
        XCTAssertEqual(base, changed("last", 8), "\"last\" is only informative")
        var sealed = a
        sealed[LockStore.gen] = 4; sealed[LockStore.mac] = "x"; sealed[LockStore.mig] = 4
        XCTAssertFalse(LockStore.fields(sealed).jHas(LockStore.gen))
        XCTAssertFalse(LockStore.fields(sealed).jHas(LockStore.mac))
        XCTAssertFalse(LockStore.fields(sealed).jHas(LockStore.mig))
        XCTAssertEqual(LockStore.fields(sealed).jInt("attempts"), 3)
    }

    // MARK: the real parts

    func testOnTheKeychainRecordAndTheKeyringKeys() throws {
        for enclave in [false, true] where !enclave || EnclaveKeyMaker.available {
            let store = MemorySecureStore()
            let keyring = enclave ? try TestKeys.enclave(store) : TestKeys.software(store)
            let s = LockStore(anchor: KeyringLockAnchor(keyring: keyring), records: SecureStoreLockRecords(store: store))
            XCTAssertTrue(s.save(state(1)))
            let old = try XCTUnwrap(try store.read("lock"))
            XCTAssertTrue(s.save(state(2)))
            XCTAssertEqual(s.load().verdict, .ok)
            XCTAssertEqual(keyring.counterGenerations(), [2])
            // The older Keychain record put back (a restored Keychain item without its key).
            try store.write("lock", old, access: .foreground)
            XCTAssertEqual(s.load().verdict, .rollback)
            try store.write("lock", Data("not json".utf8), access: .foreground)
            XCTAssertEqual(s.load().verdict, .rollback)
            store.failing = true
            XCTAssertEqual(s.load().verdict, .unverified)
            XCTAssertFalse(s.save(state(3)))
        }
    }
}
