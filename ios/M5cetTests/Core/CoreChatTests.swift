// Two (and three) people in one room through the core's own controllers —
// RoomsController / RoomController over M5Net's HubConnection (an in-memory hub)
// and M5Proto's RoomSession, data channels in memory: the join with the room
// proof, protocol 4 between them, a message, its receipts, a reply; a member who
// went away gets what was sent meanwhile through the relay when back; a lock
// keeps receiving into the lock inbox and the unlock merges it; the history
// stays across a restart; the call system's seam is attached and detached.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class CoreChatTests: XCTestCase {
    let roomName = "Core Test Room"
    let pass = "a shared passphrase for tests"

    private func joinBoth(_ hub: FakeHub, _ net: LoopbackNet) async -> (TestPerson, TestPerson, String) {
        let alice = TestPerson.make("Alice", hub: hub, net: net)
        let bob = TestPerson.make("Bob", hub: hub, net: net)
        let key = alice.rooms.join(room: roomName, passphrase: pass, userName: "Alice")
        await eventually("Alice joined") { alice.room(key)?.connected == true }
        _ = bob.rooms.join(room: roomName, passphrase: pass, userName: "Bob")
        await eventually("Bob joined") { bob.room(key)?.connected == true }
        await eventually("the channel is open both ways") { alice.room(key)?.peers.count == 1 && bob.room(key)?.peers.count == 1 }
        // Protocol 4 between them (the hellos, the KEM): both see the other as "p4".
        await eventually("protocol 4") {
            alice.room(key)?.people.first { !$0.me }?.proto == "p4" && bob.room(key)?.people.first { !$0.me }?.proto == "p4"
        }
        return (alice, bob, key)
    }

    func testTwoPeopleTalkWithReceiptsAndAReply() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let (alice, bob, key) = await joinBoth(hub, net)
        // The join carried the room proof (a blind room id: r3.…).
        XCTAssertTrue(hub.seenFrames.contains { $0.optString("type") == "join" && $0.object("proof") != nil })
        let aliceRoom = try XCTUnwrap(alice.room(key)), bobRoom = try XCTUnwrap(bob.room(key))
        XCTAssertTrue(aliceRoom.keys?.roomId.hasPrefix("r3.") ?? false)
        XCTAssertEqual(alice.rooms.activeKey, key)
        XCTAssertEqual(alice.rooms.items.first?.connected, true)

        let id = aliceRoom.sendText("Ahoj Bobe")
        XCTAssertTrue(id.hasPrefix("msg-"))
        await eventually("Bob got it") { bobRoom.messages.contains { $0.text == "Ahoj Bobe" && !$0.mine } }
        let got = try XCTUnwrap(bobRoom.messages.first { $0.text == "Ahoj Bobe" })
        XCTAssertEqual(got.senderName, "Alice")
        XCTAssertTrue(got.verified || got.has("decrypted"))
        await eventually("delivered") { aliceRoom.message(id).map { ChatMessage.rank($0.status) >= ChatMessage.rank("delivered") } ?? false }
        // Read receipt.
        bobRoom.markRead([got.id])
        await eventually("read") { aliceRoom.message(id)?.status == "read" }

        // A reply.
        var o = Outgoing(text: "Ahoj Alice")
        o.replyTo = got
        bobRoom.send(o)
        await eventually("Alice got the reply") { aliceRoom.messages.contains { $0.text == "Ahoj Alice" && $0.replyToId == id } }

        // A private message to one person; a note never leaves.
        aliceRoom.addNote(text: "note to self", fileName: nil, fileMime: nil, dataUrl: nil, filePath: nil, fileSize: 0, toLabel: "Alice")
        await eventually("the note") { aliceRoom.messages.contains { $0.kind == "note" } }
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(bobRoom.messages.contains { $0.text == "note to self" })

        // People: me first, Bob with protocol 4.
        XCTAssertEqual(aliceRoom.people.first?.me, true)
        XCTAssertEqual(aliceRoom.people.first { !$0.me }?.name, "Bob")
        XCTAssertFalse(aliceRoom.safetyNumber(aliceRoom.peers[0].id).isEmpty)
    }

    func testAnAwayMemberGetsTheRelayWhenBack() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let (alice, bob, key) = await joinBoth(hub, net)
        let aliceRoom = try XCTUnwrap(alice.room(key)), bobRoom = try XCTUnwrap(bob.room(key))
        // Bob is signed in: his socket binds his account (auth); the hub knows him by it.
        bob.rooms.onAccountChanged(token: "bob")
        await eventually("Alice knows Bob's account") { aliceRoom.people.contains { $0.name == "Bob" && $0.signedIn } }
        // Bob goes to the background: the socket closes without leaving, his channel goes.
        net.disconnect(bobRoom.myId)
        await bob.rooms.pauseAll()
        await eventually("Bob is away for Alice") { aliceRoom.people.contains { $0.channel == "away" || $0.channel == "held" } }
        let id = aliceRoom.sendText("Are you there?")
        await eventually("the hub keeps it for Bob") { hub.relayQueue("acc-bob") > 0 }
        await eventually("stored for him") { aliceRoom.message(id).map { ChatMessage.rank($0.status) >= ChatMessage.rank("stored") } ?? false }
        // Bob comes back as the same member: the relay delivers it, acknowledged.
        await bob.rooms.hub.resumeAll()
        await eventually("Bob got it from the relay", timeout: 30) { bobRoom.messages.contains { $0.text == "Are you there?" } }
        XCTAssertTrue(bobRoom.messages.first { $0.text == "Are you there?" }?.relayed ?? false)
        await eventually("acknowledged") { hub.relayQueue("acc-bob") == 0 }
    }

    func testTheLockKeepsReceivingIntoTheInboxAndTheUnlockMerges() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let (alice, bob, key) = await joinBoth(hub, net)
        let aliceRoom = try XCTUnwrap(alice.room(key)), bobRoom = try XCTUnwrap(bob.room(key))
        bobRoom.sendText("before the lock")
        await eventually("Alice has it") { aliceRoom.messages.contains { $0.text == "before the lock" } }
        aliceRoom.saveNow()

        alice.security.lockNow()
        await eventually("the history left the memory") { !aliceRoom.historyReady && !aliceRoom.messages.contains { $0.text == "before the lock" } }
        XCTAssertFalse(alice.rooms.loaded)
        bobRoom.sendText("while locked")
        await eventually("into the lock inbox") {
            alice.security.inbox.sealed.contains { $0.optString("t") == "msg" && $0.object("m")?.optString("text") == "while locked" }
        }
        // Nothing of it in the vault while locked.
        XCTAssertNil(alice.security.userVault.record(History.recordName(key)))

        alice.security.unlock()
        await eventually("the unlock merged it") {
            aliceRoom.historyReady && aliceRoom.messages.contains { $0.text == "before the lock" } && aliceRoom.messages.contains { $0.text == "while locked" }
        }
        let stored = History.load(alice.security.userVault, key)
        XCTAssertTrue(stored.contains { $0.text == "while locked" })
        XCTAssertTrue(alice.rooms.loaded)
    }

    func testTheHistoryStaysAcrossARestart() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let (alice, bob, key) = await joinBoth(hub, net)
        let bobRoom = try XCTUnwrap(bob.room(key))
        bobRoom.sendText("remember me")
        await eventually("Alice has it") { alice.room(key)?.messages.contains { $0.text == "remember me" } == true }
        alice.room(key)?.saveNow()
        alice.rooms.disconnectAll()
        try? await Task.sleep(for: .milliseconds(300))

        // The same vault, a new core: the saved room connects again with its history.
        let again = TestPerson.make("Alice", hub: hub, net: net, security: alice.security)
        again.rooms.load()
        XCTAssertEqual(again.rooms.items.map(\.key), [key])
        await eventually("the history is back") { again.room(key)?.messages.contains { $0.text == "remember me" } == true }
        await eventually("connected again") { again.room(key)?.connected == true }
    }

    func testCallsAttachAndDetachWithTheRoom() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let alice = TestPerson.make("Alice", hub: hub, net: net)
        let key = alice.rooms.join(room: roomName, passphrase: pass, userName: "Alice")
        await eventually("attached") { net.attached.contains("Alice:" + key) }
        await eventually("joined") { alice.room(key)?.connected == true }
        alice.rooms.leave(key)
        await eventually("detached") { net.detached.contains("Alice:" + key) }
        XCTAssertNil(alice.room(key))
        XCTAssertEqual(alice.rooms.items.first?.selected, false)
        // Forget: the saved room and its history go.
        alice.rooms.forget(key)
        XCTAssertTrue(alice.rooms.items.isEmpty)
    }

    func testCloneAndEditOfSavedRooms() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let alice = TestPerson.make("Alice", hub: hub, net: net)
        let key = alice.rooms.add("Team", passphrase: "p", userName: "Alice")
        let copy = try XCTUnwrap(alice.rooms.clone(key))
        XCTAssertEqual(alice.rooms.saved(copy)?.label, "Team 2")
        XCTAssertEqual(alice.rooms.saved(copy)?.passphrase, "p")
        let edited = try XCTUnwrap(alice.rooms.update(copy, room: "Team B", passphrase: "q", userName: "Al"))
        XCTAssertNil(alice.rooms.saved(copy))
        XCTAssertEqual(alice.rooms.saved(edited)?.passphrase, "q")
        XCTAssertEqual(alice.rooms.saved(edited)?.userName, "Al")
        // Stored as Android's record "rooms".
        let rec = alice.security.userVault.record("rooms")
        XCTAssertEqual(rec?.array("list")?.count, 2)
    }
}
