// What only this device puts into a room's list (android chat/RoomSession.java:
// touched, startFnCall, fnCallStatus, fnCallProgress, addModelAnswer, addNote,
// addTranscript, sendFile's bubble, addFile) — local messages and local steps,
// never sent by these calls themselves. The app's UI and its Fn engine drive
// them; the room's actor runs them in order with everything else.

import Foundation
import M5Core
import M5Crypto

public extension RoomCore {
    /// A step only this device keeps (displayed, revealed, opened, a hide ended): the message changed in place —
    /// the app stores the history after it. Nil when the message is not in the list.
    @discardableResult
    func touch(_ id: String, _ change: (inout ChatMessage) -> Void) -> ChatMessage? { update(id, change) }

    /// 6.5: a command call shows at once as the sender's own bubble — its query, loading (fnLocal.pending) — until
    /// `fnCallStatus` settles it. 6.11: the model's answer is its own message below (`addModelAnswer`).
    @discardableResult
    func startFnCall(keyword: String, name: String, query: String, icon: String?) -> ChatMessage {
        var m = ChatMessage()
        m.id = "fncall-" + Crypto.hex(Crypto.random(10))
        m.roomKey = key
        m.senderId = myId
        m.senderName = userName
        m.text = query
        m.createdAt = now
        m.mine = true
        m.verified = true
        m.status = "displayed"
        m.mark("displayed", "", at: m.createdAt)
        var fn = JSONObject([("keyword", .string(keyword)), ("name", .string(name)), ("query", .string(m.text)), ("pending", true)])
        if let icon { fn["icon"] = .string(icon) }
        m.fnLocal = fn
        add(m, fresh: false)
        events.roomChanged()
        return m
    }

    /// The loading becomes a status chip: kind ok | error | info, its label ("" = the words of `code`), the code
    /// (timeout, cancelled, bad-input, answered, sent…).
    func fnCallStatus(_ id: String, kind: String, label: String?, code: String?) {
        _ = update(id) { m in
            var fn = m.fnLocal ?? JSONObject()
            fn["pending"] = false
            fn["outputs"] = nil
            fn["progress"] = nil
            var st = JSONObject([("kind", .string(kind)), ("label", .string(label ?? ""))])
            if let code { st["code"] = .string(code) }
            fn["status"] = .object(st)
            m.fnLocal = fn
        }
    }

    /// 6.11: what a running command says it is doing (0–1, −1 = unknown, and a text ≤ 200) — under the loading.
    func fnCallProgress(_ id: String, progress p: Double, text: String?) {
        guard let m = message(id), let fn = m.fnLocal, fn.bool("pending") == true else { return }
        let t = Payloads.prefixUTF16(text ?? "", 200)
        let clamped = p.isFinite ? max(-1, min(1, p)) : -1
        _ = update(id) { $0.fnLocal?["progress"] = .object(JSONObject([("p", .double(clamped)), ("text", .string(t))])) }
    }

    /// 6.11: a model's answer as an incoming message from system-messenger (the model's name as the sender, its
    /// identity for the face, a reply to what asked). Here only, never sent: `share` is what the history keeps,
    /// `local` every output of this run.
    @discardableResult
    func addModelAnswer(identity: JSONObject?, text: String, share: JSONObject?, local: JSONObject?, replyTo: ChatMessage?) -> ChatMessage {
        var m = ChatMessage()
        m.id = "fn-" + Crypto.hex(Crypto.random(10))
        m.roomKey = key
        m.senderId = ModelIdentity.systemMessengerId
        m.senderName = identity?.string("name") ?? ModelIdentity.systemMessengerName
        m.text = text
        m.createdAt = max(now, (replyTo?.createdAt ?? -1) + 1)
        m.verified = true
        m.model = identity
        m.fn = share
        m.fnLocal = local
        m.mark("displayed", "", at: m.createdAt)
        if let r = replyTo {
            m.replyToId = r.id
            m.replyToSender = r.senderName
            m.replyToText = Payloads.prefixUTF16(r.visibleText, 200)
        }
        add(m, fresh: false)
        return m
    }

    /// 6.10: a note to myself — kept in this room's history here, never sent (kind "note", which no peer's payload
    /// can be). Mine, "displayed", its "to" naming only me; optionally a file (inline or a vault file).
    @discardableResult
    func addNote(text: String, fileName: String? = nil, fileMime: String? = nil, dataUrl: String? = nil, filePath: String? = nil,
                 fileSize: Int64 = 0, toLabel: String? = nil) -> ChatMessage {
        var m = ChatMessage()
        m.id = "note-" + Crypto.hex(Crypto.random(10))
        m.roomKey = key
        m.kind = "note"
        m.senderId = myId
        m.senderName = userName
        m.text = text
        m.createdAt = now
        m.mine = true
        m.verified = true
        m.status = "displayed"
        m.mark("created", "", at: m.createdAt)
        if let toLabel, !toLabel.isEmpty { m.to.append(toLabel) }
        if let fileName {
            m.fileName = fileName
            m.fileMime = fileMime
            m.fileDataUrl = dataUrl
            m.filePath = filePath
            m.fileSize = fileSize
        }
        add(m, fresh: false)
        events.roomChanged()
        return m
    }

    /// Audio ↔ text calls: what a peer said, as its message here (local only), with the recording behind it.
    @discardableResult
    func addTranscript(peerId: String, text: String, sourceId: String) -> ChatMessage {
        let p = peer(peerId)
        var m = ChatMessage()
        m.id = "call-" + Crypto.hex(Crypto.random(10))
        m.roomKey = key
        m.senderId = peerId
        m.senderName = p?.name ?? "?"
        m.text = "🎙 " + text
        m.createdAt = now
        m.verified = p?.verified ?? false
        m.sourceAudio = sourceId
        add(m, fresh: true)
        return m
    }

    /// A file of mine from the vault (FileVault id): its bubble at once, progress 0, "sending" — the app's
    /// transfer moves it on (`touch`). The position of the composer goes along.
    @discardableResult
    func composeFile(vaultId: String, name: String, mime: String, size: Int64, loc: JSONObject?, id: String? = nil) -> ChatMessage {
        var m = ChatMessage()
        m.id = id.flatMap { $0.hasPrefix("file-") && $0.utf16.count <= Payloads.idMax && message($0) == nil ? $0 : nil } ?? "file-" + Crypto.hex(Crypto.random(12))
        m.roomKey = key
        m.createdAt = now
        m.senderId = myId
        m.senderName = userName
        m.mine = true
        m.verified = true
        m.status = "sending"
        m.fileName = name
        m.fileMime = Payloads.safeMime(mime)
        m.fileImage = Payloads.inlineImage(m.fileMime)
        m.fileSize = size
        m.filePath = vaultId
        m.fileProgress = 0
        m.mark("created", "", at: m.createdAt)
        m.loc = loc
        add(m, fresh: false)
        return m
    }

    /// A local message the app built itself (its id known to the UI at once: a command's call, a model's answer).
    func addLocal(_ m: ChatMessage) {
        if message(m.id) != nil { return }
        add(m, fresh: false)
        events.roomChanged()
    }

    /// 6.12 (F-16): the app locked with the room staying connected — the history leaves the memory (it was saved);
    /// what arrives now goes to the lock inbox and stays in the list until the unlock restores the rest.
    func dropAll() {
        messages.removeAll()
        events.roomChanged()
    }

    /// A received file's bubble (the app's transfer made it): arrived now, fresh for the notifications.
    func addFile(_ m: ChatMessage) {
        var m = m
        if !m.mine { arrived(&m, via: "") }
        add(m, fresh: !m.mine)
    }
}

public extension RoomSession {
    /// A step only this device keeps (see RoomCore.touch).
    @discardableResult
    func touch(_ id: String, _ change: @Sendable (inout ChatMessage) -> Void) -> ChatMessage? { core.touch(id, change) }

    /// A local message (fn calls, model answers, notes, transcripts, files) — the body runs on the room's actor.
    func local<T: Sendable>(_ body: @Sendable (RoomCore) -> T) -> T { body(core) }
}
