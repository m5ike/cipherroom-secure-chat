// What only this device puts into a room's list (RoomCore+Local, android
// RoomSession startFnCall / fnCallStatus / fnCallProgress / addModelAnswer /
// addNote / addTranscript / sendFile / touched): never on the wire, kept by the
// history like Android, steps in place.

import Foundation
import M5Core
import M5Crypto
@testable import M5Proto
import Synchronization
import Testing

@Suite struct RoomLocalTests {
    static let keys = try! RoomKeys.derive(room: "local-room", passphrase: "a shared passphrase", memoryKiB: 64, passes: 1)

    final class Sink: RoomTransport, RoomEvents, @unchecked Sendable {
        let state = Mutex<(hub: [JSONObject], texts: Int, added: [(ChatMessage, Bool)], changed: [ChatMessage])>(([], 0, [], []))
        func sendHub(_ frame: JSONObject) { state.withLock { $0.hub.append(frame) } }
        func sendText(_ peerId: String, _ text: String) -> Bool { state.withLock { $0.texts += 1 }; return true }
        func isOpen(_ peerId: String) -> Bool { false }
        func added(_ message: ChatMessage, fresh: Bool) { state.withLock { $0.added.append((message, fresh)) } }
        func changed(_ message: ChatMessage) { state.withLock { $0.changed.append(message) } }
        func roomChanged() {}
        func createPeer(_ peerId: String, name: String, initiator: Bool) {}
        func dropPeer(_ peerId: String) {}
        func signal(from peerId: String, _ description: JSONObject) {}
    }

    func core(_ sink: Sink) -> RoomCore {
        RoomCore(key: "local-room", room: "local-room", label: "Local", userName: "Ann", keys: Self.keys, identity: ChatIdentity.generate(),
                 transport: sink, events: sink, device: P4Device(store: P4Store(backend: MemoryRecordVault()), origin: "https://x.example", account: nil),
                 pins: NamePins(vault: MemoryRecordVault()), verifiedDevice: { _ in false })
    }

    @Test func aCommandCallSettlesInPlace() {
        let sink = Sink()
        let c = core(sink)
        let call = c.startFnCall(keyword: "w", name: "Weather", query: "/w Praha", icon: "cloud")
        #expect(call.id.hasPrefix("fncall-") && call.mine && call.status == "displayed" && call.fnCall)
        #expect(call.fnLocal?.bool("pending") == true && call.fnLocal?.string("icon") == "cloud")
        c.fnCallProgress(call.id, progress: 3, text: "loading")
        #expect(c.message(call.id)?.fnLocal?.object("progress")?.double("p") == 1)
        c.fnCallStatus(call.id, kind: "ok", label: nil, code: "answered")
        let done = c.message(call.id)!
        #expect(done.fnLocal?.bool("pending") == false && done.fnLocal?.object("progress") == nil)
        #expect(done.fnLocal?.object("status")?.string("code") == "answered" && done.fnLocal?.object("status")?.string("label") == "")
        // A finished call takes no more progress.
        c.fnCallProgress(call.id, progress: 0.5, text: "late")
        #expect(c.message(call.id)?.fnLocal?.object("progress") == nil)
        // Nothing of it went anywhere.
        #expect(sink.state.withLock { $0.hub.isEmpty && $0.texts == 0 })
        // The history keeps the call's state.
        let kept = ChatMessage.from(done.json)
        #expect(kept.fnLocal?.object("status")?.string("code") == "answered")
    }

    @Test func aModelAnswerRepliesBelowTheCall() {
        let sink = Sink()
        let c = core(sink)
        let call = c.startFnCall(keyword: "ai", name: "AI", query: "/ai hi", icon: nil)
        let a = c.addModelAnswer(identity: JSONObject([("keyword", "ai"), ("name", "Claude")]), text: "Hello", share: nil, local: nil, replyTo: call)
        #expect(a.senderId == ModelIdentity.systemMessengerId && a.senderName == "Claude" && !a.mine)
        #expect(a.replyToId == call.id && a.createdAt > call.createdAt && a.model?.string("keyword") == "ai")
        #expect(c.messages.map(\.id).suffix(2) == [call.id, a.id])
    }

    @Test func notesTranscriptsFilesAndTouches() {
        let sink = Sink()
        let c = core(sink)
        let n = c.addNote(text: "card read", fileName: "card.json", fileMime: "application/json", dataUrl: "data:application/json;base64,e30=", fileSize: 2, toLabel: "Ann")
        #expect(n.kind == "note" && n.to == ["Ann"] && n.fileName == "card.json" && n.status == "displayed")
        let f = c.composeFile(vaultId: "out-1", name: "a.png", mime: "image/png", size: 200_000, loc: nil)
        #expect(f.fileProgress == 0 && f.status == "sending" && f.fileImage && f.filePath == "out-1")
        let t = c.addTranscript(peerId: "peer-x", text: "ahoj", sourceId: "rec-1")
        #expect(t.text == "🎙 ahoj" && t.sourceAudio == "rec-1" && t.senderName == "?")
        #expect(sink.state.withLock { $0.added.last?.1 } == true)
        let changed = c.touch(n.id) { $0.mark("displayed", "", at: 5) }
        #expect(changed?.has("displayed") == true)
        #expect(c.touch("missing") { $0.text = "x" } == nil)
        #expect(sink.state.withLock { $0.hub.isEmpty && $0.texts == 0 })
    }
}
