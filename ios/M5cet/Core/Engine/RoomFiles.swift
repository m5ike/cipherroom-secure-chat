// File transfer v2 of one room (android chat/Files.java, byte-compatible with
// client/src/lib/file-transfer.ts): meta → chunks → end to every open channel,
// through the server ("proxy") only when no channel is open; missing chunks
// asked for again (file-need, three rounds). Protocol 4 (§ 8): a random FK per
// transfer handed to each protocol-4 peer over its ratchet before the meta;
// older peers get the same file in the room-key lane. Proxied (review P07): the
// FK sealed to every present member's devices in hub signals, else the room key.
// The frames' crypto is M5Proto FileTransfer; this is the orchestration: the
// channels (RoomWire), the hub, the vault (FileVault), the room's actor for the
// protocol-4 keys, and the lock inbox for a file received while locked.

import Foundation
import M5Core
import M5Crypto
import M5Proto
import os

@MainActor
final class RoomFiles {
    unowned let room: RoomController
    private var incoming: [String: Incoming] = [:]
    private var outgoing: [String: Outgoing] = [:]
    private var proxyKeys = ProxyKeys()
    nonisolated private static let log = Logger(subsystem: "cz.m5cet.app", category: "files")

    init(room: RoomController) { self.room = room }

    private final class Incoming: @unchecked Sendable {
        let transfer: FileTransfer.Incoming
        let from: String?
        let slots: FileSlots
        var message: ChatMessage
        var lastUi: Date = .distantPast
        init(_ t: FileTransfer.Incoming, from: String?, slots: FileSlots, message: ChatMessage) {
            transfer = t; self.from = from; self.slots = slots; self.message = message
        }
    }

    private final class Outgoing {
        let id: String
        let vaultId: String
        let total: Int
        let size: Int64
        let startedAt = Date()
        var lanes: [Lane] = []
        var cancelled = false
        init(id: String, vaultId: String, size: Int64) {
            self.id = id; self.vaultId = vaultId; self.size = size; total = FileTransfer.total(size: size)
        }
        func laneOf(_ peer: String?) -> Lane? { lanes.first { peer == nil ? $0.peers.isEmpty : $0.peers.contains(peer!) } }
    }

    private final class Lane {
        let lane: FileTransfer.Lane
        let peers: [String]
        var endFrame: JSONObject?
        init(_ lane: FileTransfer.Lane, peers: [String]) { self.lane = lane; self.peers = peers }
    }

    // MARK: - receive

    /// The FK of a proxied transfer (opened from its sealed signal); the meta waiting for it goes now.
    func proxyKey(from: String, transferId: String, fk: Bytes, spk: String) {
        guard !from.isEmpty, FileTransfer.isId(transferId), fk.count == 32 else { return }
        guard let frames = proxyKeys.put(from: from, transferId: transferId, fk: fk, spk: spk) else { return }
        for f in frames {
            switch f {
            case .json(let o): onFrame(nil, o, proxy: true)
            case .binary(let b): onBinary(nil, b)
            }
        }
    }

    /// A JSON file frame from a channel (peerId) or the server (proxy).
    func onFrame(_ peerId: String?, _ f: JSONObject, proxy: Bool) {
        var kind = f.string("kind") ?? f.optString("type")
        if proxy, kind.hasPrefix("proxy-") { kind = "file-" + kind.dropFirst("proxy-".count) }
        let id = f.optString("transferId")
        guard FileTransfer.isId(id) else { return }
        if proxy, kind != "file-need", proxyKeys.queue(id, .json(f)) { return }
        switch kind {
        case "file-meta": onMeta(peerId, id, f, proxy: proxy)
        case "file-chunk":
            guard let i = incoming[id], let iv = try? Crypto.unb64(f.optString("iv")), let ct = try? Crypto.unb64(f.optString("ciphertext")) else { return }
            onChunk(i, seq: f.optInt("seq", -1), iv: iv, ct: ct)
        case "file-end": onEnd(id, f)
        case "file-cancel":
            if let i = incoming.removeValue(forKey: id) { i.slots.close(); failed(i, "cancelled") }
            if proxy, let o = outgoing[id] { o.cancelled = true }
        case "file-need":
            if let o = outgoing[id], Date().timeIntervalSince(o.startedAt) < 600 { resend(o, to: peerId, seqs: (f.array("seqs") ?? []).compactMap { $0.int64Value.map { Int($0) } }) }
        default: break
        }
    }

    /// A binary chunk ('M' | 0x01 / 0x11 | version | L | id | seq | iv | ct) from a channel or the server.
    func onBinary(_ peerId: String?, _ b: Bytes) {
        guard let c = FileTransfer.parseBinary(b) else { return }
        if peerId == nil, proxyKeys.queue(c.id, .binary(b)) { return }
        guard let i = incoming[c.id] else { return }
        onChunk(i, seq: c.seq, iv: c.iv, ct: c.ciphertext)
    }

    private func onMeta(_ peerId: String?, _ id: String, _ f: JSONObject, proxy: Bool) {
        guard incoming[id] == nil, outgoing[id] == nil, let session = room.session else { return }
        let v = f.optInt("v", 1)
        guard v == 2 || v == 4 else { return }
        let from = proxy ? f.optString("from") : (peerId ?? "")
        let keys = room.keys
        Task { @MainActor in
            var fk: Bytes?
            var signer: String?
            if v == 4 && proxy {
                guard let k = from.isEmpty ? nil : self.proxyKeys.take(from: from, transferId: id) else {
                    guard let w = self.proxyKeys.park(from: from, transferId: id, meta: f) else { Self.log.warning("a proxied protocol-4 file without its sender refused"); return }
                    let token = w.token
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(ProxyKeys.waitMs))
                        guard self.proxyKeys.expire(id, token: token) else { return }
                        Self.log.warning("a proxied protocol-4 file came without its key — not opened")
                        self.room.systemNotice("⚠ " + P4Texts.t("p4.file.noKey"))
                    }
                    return
                }
                fk = k.fk
                signer = k.spk
            } else if v == 4, let peerId {
                (fk, signer) = await session.local { core in (core.p4.fileKey(peerId, transferId: id), core.p4.helloPk(peerId)) }
            }
            if v == 4 && fk == nil { Self.log.warning("a protocol-4 file without its key refused"); return }
            if v == 2, let peerId, !proxy, await session.local({ $0.isV4(peerId) }) { Self.log.warning("a protocol-3 file from a protocol-4 peer refused"); return }
            let slots: FileSlots
            let t: FileTransfer.Incoming
            do {
                slots = try FileSlots()
                t = try FileTransfer.openMeta(id: id, frame: f, transport: proxy ? "proxy" : "p2p", fk: fk, p4Signer: signer, roomKeys: keys, slots: slots)
                slots.chunkSize = t.chunkSize
            } catch {
                Self.log.warning("file refused: \(String(describing: error), privacy: .public)")
                return
            }
            let name = self.room.peerName(from) ?? "?"
            let m = FileTransfer.message(t, roomKey: self.room.key, fallbackSenderId: from, fallbackName: name, now: EpochMs.now)
            self.incoming[id] = Incoming(t, from: proxy ? nil : peerId, slots: slots, message: m)
            await session.local { $0.addFile(m) }
        }
    }

    private func onChunk(_ i: Incoming, seq: Int, iv: Bytes, ct: Bytes) {
        guard i.transfer.accept(seq: seq, iv: iv, ciphertext: ct) else { return }
        if Date().timeIntervalSince(i.lastUi) > 0.25 {
            i.lastUi = Date()
            let p = i.transfer.progress
            let id = i.transfer.id
            if let s = room.session { Task { _ = await s.touch(id) { $0.fileProgress = p } } }
        }
    }

    private func onEnd(_ id: String, _ f: JSONObject) {
        guard let i = incoming[id] else { return }
        if !i.transfer.complete {
            i.transfer.rounds += 1
            if i.transfer.rounds > FileTransfer.maxResendRounds { incoming[id] = nil; i.slots.close(); failed(i, "missing chunks"); return }
            let need = i.transfer.needFrame()
            if i.transfer.transport == "proxy" { room.sendHubFrame(need) } else if let p = i.from { _ = room.wire?.sendText(need.stringify(), to: p) }
            return
        }
        incoming[id] = nil
        finish(i, f)
    }

    /// Decrypts and checks the chunks, stores the file in the vault — or, locked, keeps it for the unlock
    /// (6.12 F-16: still encrypted under its transfer key, which goes into the lock inbox).
    private func finish(_ i: Incoming, _ f: JSONObject) {
        guard let rooms = room.rooms, let store = rooms.fileStore else { return }
        nonisolated(unsafe) let t = i.transfer
        let inbox = rooms.core?.security.lockInbox
        let roomKey = room.key
        let slots = i.slots
        Task.detached(priority: .utility) {
            do {
                if let inbox, inbox.active {
                    let root = try t.endRoot(f)
                    try t.finish(endFrame: f, sink: nil)
                    slots.sync()
                    if inbox.keepFile(room: roomKey, id: t.id, key: t.key, slots: slots.url, chunkSize: t.chunkSize, total: t.total, size: t.size,
                                      lengths: t.lengths, root: root, p4: t.p4) {
                        slots.forget()
                        await self.finished(i, nil)
                        return
                    }
                    // The inbox closed meanwhile (unlocked): stored the usual way.
                }
                try store.receive(id: t.id) { sink in try t.finish(endFrame: f, sink: sink) }
                slots.close()
                await self.finished(i, nil)
            } catch {
                slots.close()
                await self.finished(i, String(describing: error))
            }
        }
    }

    private func finished(_ i: Incoming, _ error: String?) {
        if let error { failed(i, error) } else { done(i) }
    }

    private func done(_ i: Incoming) {
        let verified = i.transfer.signer != nil
        let fromPeer = i.from
        // § 12.1: "verified" only for a sender the person verified (a proxied protocol-4 file: the device that sealed its key).
        let signerKid = (i.transfer.signer).flatMap { $0.isEmpty ? nil : Ec.kid($0) } ?? ""
        let trustOk = fromPeer.map { id in room.snap.peers.first { $0.id == id }?.trust == Trust.verified }
            ?? (!i.transfer.p4 || (room.rooms?.verifiedDevice(signerKid) ?? false))
        let id = i.transfer.id
        guard let s = room.session else { return }
        Task {
            _ = await s.touch(id) { m in
                m.filePath = id
                m.fileProgress = -1
                m.fileVerified = verified
                m.verified = verified && trustOk
            }
            self.room.saveSoon()
        }
    }

    private func failed(_ i: Incoming, _ why: String) {
        let id = i.transfer.id
        let name = i.message.fileName ?? ""
        if let s = room.session { Task { _ = await s.touch(id) { $0.fileProgress = -2 } } }
        room.systemNotice("⚠ " + name + ": " + why)
    }

    // MARK: - send

    /// Sends a vault file (its bubble made by composeFile) to every open channel, or through the server.
    func send(vaultId: String, name: String, mime: String, size: Int64, bubbleId: String) {
        guard let session = room.session, let keys = room.keys, let files = room.rooms?.fileStore else { return }
        let id = "xfer-" + UUID().uuidString.lowercased()
        let out = Outgoing(id: id, vaultId: vaultId, size: size)
        outgoing[id] = out
        let wire = room.wire
        Task { @MainActor in
            do {
                let peers = wire?.openPeerIds ?? []
                let proxy = peers.isEmpty
                if proxy && !self.room.connected { throw CryptoError(Texts.t("file.err.nobody", "nobody to send it to")) }
                if proxy { try await self.planProxy(out, name: name, session: session, keys: keys) } else { try await self.planLanes(out, peers: peers, session: session, keys: keys) }
                let transport = proxy ? "proxy" : "p2p"
                let meta = FileTransfer.meta(id: id, name: String(name.prefix(200)), mime: mime, size: size, senderId: self.room.myId, senderName: self.room.myName,
                                             createdAt: EpochMs.now)
                let identity = await session.local { $0.identity }
                for lane in out.lanes {
                    let frame = try FileTransfer.bodyFrame(kind: "file-meta", id: id, body: meta, lane: lane.lane, transport: transport, identity: identity)
                    self.broadcast(lane.peers, frame, proxyType: "proxy-meta")
                }
                var hasher = FileTransfer.RootHasher()
                for seq in 0..<out.total where !out.cancelled {
                    let plain = try files.readRange(vaultId, offset: Int64(seq) * Int64(FileTransfer.chunk), count: FileTransfer.chunk)
                    hasher.add(plain)
                    for lane in out.lanes { try await self.sendChunk(lane, id: id, seq: seq, total: out.total, plain: plain, transport: transport) }
                    if seq % 8 == 0 || seq == out.total - 1 {
                        let p = Double(seq + 1) / Double(out.total)
                        _ = await session.touch(bubbleId) { $0.fileProgress = p }
                    }
                }
                if out.cancelled {
                    for lane in out.lanes {
                        self.broadcast(lane.peers, JSONObject([("kind", "file-cancel"), ("transferId", .string(id)), ("transport", .string(transport))]), proxyType: "proxy-cancel")
                    }
                    throw CryptoError("cancelled")
                }
                let end = FileTransfer.endBody(root: hasher.root(), total: out.total, size: size)
                for lane in out.lanes {
                    let frame = try FileTransfer.bodyFrame(kind: "file-end", id: id, body: end, lane: lane.lane, transport: transport, identity: identity)
                    lane.endFrame = frame
                    self.broadcast(lane.peers, frame, proxyType: "proxy-end")
                }
                _ = await session.touch(bubbleId) { m in m.fileProgress = -1; m.raise(proxy ? "stored" : "sent") }
                self.room.saveSoon()
            } catch {
                Self.log.warning("sending failed: \(String(describing: error), privacy: .public)")
                _ = await session.touch(bubbleId) { $0.fileProgress = -2 }
                self.room.systemNotice("⚠ " + name + ": " + String(describing: error))
            }
        }
    }

    /// Protocol-4 peers with a session get a fresh FK over their ratchet; older peers the room-key lane.
    private func planLanes(_ out: Outgoing, peers: [String], session: RoomSession, keys: RoomKeys) async throws {
        let fk = Crypto.random(32)
        let id = out.id
        let split = await session.local { core -> (v4: [String], v3: [String]) in
            var v4 = [String](), v3 = [String]()
            for p in peers {
                guard let peer = core.peer(p), !peer.downgrade, !peer.proto.isEmpty else { continue }
                if core.isV4(p) { if core.p4.ready(p) && core.p4.sendFileKey(p, transferId: id, fk: fk) { v4.append(p) } } else { v3.append(p) }
            }
            return (v4, v3)
        }
        if !split.v4.isEmpty { out.lanes.append(Lane(try FileTransfer.Lane.p4(fk: fk, transferId: id), peers: split.v4)) }
        if !split.v3.isEmpty { out.lanes.append(Lane(FileTransfer.Lane.p3(keys, transferId: id), peers: split.v3)) }
        if out.lanes.isEmpty { throw CryptoError(Texts.t("file.err.securing", "the connections are still being secured — try again in a moment")) }
    }

    /// Through the server: a fresh FK sealed to every present member's devices (signals before the meta), else the room key.
    private func planProxy(_ out: Outgoing, name: String, session: RoomSession, keys: RoomKeys) async throws {
        let fk = Crypto.random(32)
        let id = out.id
        let refs = await session.local { $0.proxyFileKeyAsks() }
        for _ in 0..<30 {
            if await session.local({ $0.relayReady(refs) }) { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let signals = await session.local({ $0.proxyFileKeySignals(transferId: id, fk: fk) }) {
            for s in signals { await session.sendSignal(s.peer, s.signal) }
            out.lanes.append(Lane(try FileTransfer.Lane.p4(fk: fk, transferId: id), peers: []))
            room.systemNotice("🔐 " + P4Texts.t("p4.file.proxyP4").replacingOccurrences(of: "{name}", with: name))
        } else {
            out.lanes.append(Lane(FileTransfer.Lane.p3(keys, transferId: id), peers: []))
            room.systemNotice("⚠ " + P4Texts.t("p4.file.proxyRoomKey").replacingOccurrences(of: "{name}", with: name))
        }
    }

    private func broadcast(_ peers: [String], _ frame: JSONObject, proxyType: String) {
        if peers.isEmpty { var f = frame; f["type"] = .string(proxyType); room.sendHubFrame(f); return }
        let text = frame.stringify()
        for p in peers { _ = room.wire?.sendText(text, to: p) }
    }

    private func sendChunk(_ lane: Lane, id: String, seq: Int, total: Int, plain: Bytes, transport: String) async throws {
        let sealed = try FileTransfer.sealChunk(id: id, seq: seq, total: total, plain: plain, lane: lane.lane)
        if lane.peers.isEmpty {
            room.sendHubFrame(FileTransfer.chunkFrame(id: id, seq: seq, iv: sealed.iv, ciphertext: sealed.ciphertext, transport: "proxy", p4: lane.lane.p4, proxy: true))
            // ~1.6 MB/s: under the server's proxy budget.
            try? await Task.sleep(for: .milliseconds(max(1, sealed.ciphertext.count / 1600)))
            return
        }
        let bin = await room.binaryPeers()
        for p in lane.peers {
            guard let wire = room.wire, wire.isOpen(p) else { continue }
            await wire.waitForBuffer(of: p)
            if bin.contains(p) {
                _ = wire.sendBinary(Data(FileTransfer.binaryFrame(id: id, seq: seq, iv: sealed.iv, ciphertext: sealed.ciphertext, type: 0x01, version: lane.lane.p4 ? 4 : 2)), to: p)
            } else {
                _ = wire.sendText(FileTransfer.chunkFrame(id: id, seq: seq, iv: sealed.iv, ciphertext: sealed.ciphertext, transport: transport, p4: lane.lane.p4, proxy: false).stringify(), to: p)
            }
        }
    }

    /// file-need: those chunks again (new IVs, the asking peer's lane), then the end again.
    private func resend(_ out: Outgoing, to peerId: String?, seqs: [Int]) {
        guard !seqs.isEmpty, seqs.count <= 5000, let files = room.rooms?.fileStore else { return }
        let open = peerId.flatMap { room.wire?.isOpen($0) == true ? $0 : nil }
        guard let lane = out.laneOf(open) else { return }
        let one = Lane(lane.lane, peers: open.map { [$0] } ?? [])
        Task { @MainActor in
            for seq in seqs where seq >= 0 && seq < out.total {
                guard let plain = try? files.readRange(out.vaultId, offset: Int64(seq) * Int64(FileTransfer.chunk), count: FileTransfer.chunk) else { return }
                try? await self.sendChunk(one, id: out.id, seq: seq, total: out.total, plain: plain, transport: open == nil ? "proxy" : "p2p")
            }
            if let end = lane.endFrame { self.broadcast(one.peers, end, proxyType: "proxy-end") }
        }
    }

    /// The room left: every transfer forgotten.
    func clear() {
        for i in incoming.values { i.slots.close() }
        incoming.removeAll()
        proxyKeys.clear()
        outgoing.removeAll()
    }
}

/// The received chunks of one transfer, still encrypted, in a temporary file — Android's layout (iv 12 ‖ ct per slot of
/// 12 + chunkSize + 16 bytes), so a file kept in the lock inbox opens at the unlock the same way. Never plaintext.
final class FileSlots: ChunkSlots, @unchecked Sendable {
    let url: URL
    private let handle: FileHandle
    private let lock = NSLock()
    /// The meta's chunk size (set before the first chunk).
    var chunkSize = FileTransfer.chunk
    private var kept = false

    init() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("m5x", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        url = dir.appendingPathComponent("m5x-" + UUID().uuidString + ".part")
        FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])
        handle = try FileHandle(forUpdating: url)
    }

    private var slot: UInt64 { UInt64(12 + chunkSize + 16) }

    func write(seq: Int, iv: Bytes, ciphertext: Bytes) throws {
        try lock.withLock {
            try handle.seek(toOffset: UInt64(seq) * slot)
            try handle.write(contentsOf: Data(iv + ciphertext))
        }
    }

    func read(seq: Int, length: Int) throws -> (iv: Bytes, ciphertext: Bytes) {
        try lock.withLock {
            try handle.seek(toOffset: UInt64(seq) * slot)
            guard let d = try handle.read(upToCount: 12 + length), d.count == 12 + length else { throw CryptoError("missing chunk") }
            let b = Array(d)
            return (Array(b[0..<12]), Array(b[12...]))
        }
    }

    func sync() { lock.withLock { try? handle.synchronize() } }

    /// The file moved into the lock inbox: closed, not deleted.
    func forget() { lock.withLock { kept = true; try? handle.close() } }

    func close() {
        lock.withLock {
            try? handle.close()
            if !kept { try? FileManager.default.removeItem(at: url) }
        }
    }
}
