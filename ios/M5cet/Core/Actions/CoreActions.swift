// Contract 2 for real (Renderer/README.md): every action of the design that is
// not the renderer's own — the rest of android/…/ui/Actions.run's switch, the
// action half of ui/parts/Parts (messages, the composer, forwarding, the lock's
// dialogs) and MainActivity's handlers (accounts, links, settings' side
// effects, entering the app). Actions whose state lives in a part (People,
// ProfileUi, MsgDetails, AiChat, NfcPanel, CallLogUi…) are registered here as a
// fallback that does what the core can without the part; the part registers
// the same names later and wins (Core/README.md § Akce lists who owns what).

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import UIKit
import os

@MainActor
final class CoreActions {
    unowned let core: AppCore
    let state: AppScreenState
    static let log = Logger(subsystem: "cz.m5cet.app", category: "actions")

    init(core: AppCore, state: AppScreenState) {
        self.core = core
        self.state = state
    }

    private var rooms: RoomsController { core.rooms }
    private func t(_ key: String) -> String { core.t(key) }

    /// The action names the core registers (handled fully, or as the fallback of a part).
    static let handled: [String] = [
        "room.join", "room.switch", "room.toggle", "rooms.connect", "room.leave", "room.forget", "room.delete", "room.clone", "room.edit",
        "message.send", "message.reply", "message.copy", "message.kind", "message.recipients", "compose", "send.option",
        "msg.forward", "msg.forwardRoom", "msg.forwardTo", "msg.map", "msg.open", "msg.save", "msg.share",
        "users.toggle", "users.dock", "users.autoHide",
        "call.audio", "call.video", "call.audioText", "call.end", "call.mute", "call.camera", "call.switchCamera", "call.speaker",
        "lock.now", "lock.biometric", "pin.change", "biometric.toggle", "wipe.ask", "kt.dismiss",
        "account.signin", "account.signup", "account.signout", "account.recovery", "account.addPasskey", "account.register",
        "update.check", "update.install", "fn.run", "voice.speak", "voice.stop", "system.settings", "conversations.settings", "lang.set",
        "notify.up", "notify.down", "notify.use", "notify.drop", "notify.test", "notify.sync",
        "nfc.read", "nfc.write", "nfc.emulate", "nfc.stop",
    ]

    /// Actions a part owns; the core logs them until the part registers (Core/README.md § Akce).
    static let partOwned: [String] = [
        "msg.quote", "msg.showHidden", "msg.mapPreview", "msg.source", "msg.info", "msg.sender",
        "people.open", "people.select", "people.all", "people.none", "people.message", "people.call", "people.video", "people.verify",
        "people.link", "people.unlink", "people.unlinkAll",
        "profile.open", "profile.pick", "profile.clear", "profile.field", "profile.sync", "profile.save", "profile.public", "profile.audience",
        "ai.send", "ai.stop", "ai.clear", "voice.dictate", "voiceFx.test", "voiceFx.reset",
        "calllog.open", "calllog.refresh", "calllog.item", "calllog.call", "calllog.clear", "calllog.system",
    ]

    func install(into router: AppActionRouter) {
        router.register(Self.handled) { [weak self] action, ctx in self?.run(action, ctx) }
        router.register(Self.partOwned) { [weak self] action, ctx in self?.partFallback(action, ctx) }
        router.onLink { [weak self] link, host in self?.link(link, host) ?? false }
        router.onEnterApp { [weak self] host in self?.enterApp(host) }
        router.onSettingChanged { [weak self] key, host in self?.settingChanged(key, host) }
    }

    // MARK: - the switch

    func run(_ action: DesignAction, _ ctx: ActionContext) {
        let host = ctx.host
        let s = action.argText
        switch action.name {
        // rooms
        case "room.join":
            state.joinError = ""
            host.form["roomEdit"] = nil
            host.showSheet("join")
        case "room.switch": if !s.isEmpty { goRoom(s, host) }
        case "room.toggle": rooms.toggleSelected(s)
        case "rooms.connect": rooms.connectSelected(); host.refresh()
        case "room.leave":
            rooms.leave(s)
            if rooms.activeController == nil { host.showScreen("rooms") } else { host.refresh() }
        case "room.forget": rooms.forget(s); host.refresh()
        case "room.delete", "room.clone", "room.edit": roomEdit(action.name, s, host)
        // messages, the composer
        case "message.send": core.models.composer(for: host).send()
        case "message.reply": core.models.composer(for: host).setReply(s)
        case "message.copy":
            if let m = rooms.activeController?.message(s) { host.copy(m.text); host.flash(title: "", text: "✓", level: .success) }
        case "message.kind": core.models.composer(for: host).messageKind(s)
        case "message.recipients": host.closeOverlay(); pickRecipients(host)
        case "compose": core.models.composer(for: host).compose(s)
        case "send.option": core.models.composer(for: host).sendOption(s)
        case "msg.forward": if let m = rooms.activeController?.message(s) { forward(m, host) }
        case "msg.forwardRoom": forwardRoom(s, host)
        case "msg.forwardTo": forwardTo(s, host)
        case "msg.map": if let m = rooms.activeController?.message(s) { openMap(m) }
        case "msg.open", "msg.save", "msg.share": if let m = rooms.activeController?.message(s) { shareFile(m, host) }
        // the user panel (Parts.toggleUsers / dockUsers / autoHideUsers — the panel reads UsersPanel)
        case "users.toggle": var p = UsersPanel.load(); p.open.toggle(); p.save(); host.refresh()
        case "users.dock": var p = UsersPanel.load(); p.dock = s.isEmpty ? "right" : s; p.save(); host.refresh()
        case "users.autoHide":
            var p = UsersPanel.load()
            if case .usersAutoHide(let on) = action { p.autoHide = on ?? !p.autoHide }
            p.save()
            host.refresh()
        // calls
        case "call.audio", "call.video", "call.audioText": startCall(video: action.name == "call.video", host)
        case "call.end":
            if let r = rooms.activeController { CallSystem.shared.endCall(roomKey: r.key) }
            if host.screen == "call" { host.back() }
        case "call.mute": if let r = rooms.activeController { CallSystem.shared.toggleMute(roomKey: r.key) }
        case "call.camera": if let r = rooms.activeController { CallSystem.shared.room(r.key)?.toggleCamera() }
        case "call.switchCamera": if let r = rooms.activeController, let rtc = CallSystem.shared.room(r.key) { Task { await rtc.switchCamera() } }
        case "call.speaker": CallSystem.shared.toggleSpeaker(); host.refresh()
        // lock, security
        case "lock.now": core.security.lockNow()
        case "lock.biometric": if let pad = state.lockPadModel() { Task { await pad.biometrics(texts: LockTexts(strings: [core.services.lang: ["lock.bioPrompt": t("lock.bioPrompt"), "lock.bioCancel": t("lock.bioCancel")]], languages: [core.services.lang])) } }
        case "pin.change": Task { await changePin(host) }
        case "biometric.toggle": toggleBiometric(host)
        case "wipe.ask": Task { await askWipe() }
        case "kt.dismiss": rooms.dismissKtAlert(); host.refresh()
        // the account
        case "account.signin": Task { await accountCeremony(signUp: false, host) }
        case "account.signup": Task { await accountCeremony(signUp: true, host) }
        case "account.signout":
            var everywhere = false
            if case .accountSignOut(let e) = action { everywhere = e }
            Task {
                await core.account.signOut(everywhere: everywhere)
                host.flash(title: "", text: t("set.user.signout") + " ✓", level: .success)
                host.refresh()
            }
        case "account.recovery": Task { await recoveryCode(host) }
        case "account.addPasskey": Task { await addPasskey(host) }
        case "account.register": Task { await register(host) }
        // updates
        case "update.check":
            Task {
                let ok = await core.device.checkIn(reason: "manual")
                host.flash(title: "", text: ok ? t("update.none") : t("room.offline"), level: ok ? .info : .warn)
            }
        case "update.install": host.closeOverlay(); core.updates?.install(host)
        // small things
        case "fn.run": if s.hasPrefix("/"), let r = rooms.activeController { r.sendText(s) }
        case "voice.speak": if !s.isEmpty { core.voice?.speak(s) }
        case "voice.stop": core.voice?.stopSpeaking()
        case "system.settings", "conversations.settings": openSystemSettings(s)
        case "lang.set": core.installTexts(); host.refresh()
        case "notify.up", "notify.down", "notify.use", "notify.drop", "notify.test", "notify.sync":
            if let n = core.notifyPrefs { n.run(action.name, s, host) } else { Self.log.notice("\(action.name, privacy: .public): no notification settings service yet") }
        case "nfc.read", "nfc.write", "nfc.emulate", "nfc.stop":
            if let h = core.nfcPanel { h(String(action.name.dropFirst(4)), host) } else { nfcFallback(action.name, host) }
        default:
            Self.log.notice("unhandled core action \(action.name, privacy: .public)")
        }
    }

    /// A part's action before the part registered: what the core can do alone, else a log line.
    func partFallback(_ action: DesignAction, _ ctx: ActionContext) {
        let host = ctx.host
        let s = action.argText
        switch action.name {
        case "msg.mapPreview": if let m = rooms.activeController?.message(s) { openMap(m) }
        case "msg.quote": rooms.activeController?.revealRequest = s
        case "people.message":
            core.models.composer(for: host).setRecipients([s])
            core.models.composer(for: host).focus()
        case "people.select":
            let c = core.models.composer(for: host)
            var ids = c.recipientIds
            if let i = ids.firstIndex(of: s) { ids.remove(at: i) } else { ids.append(s) }
            c.setRecipients(ids)
        case "people.all": core.models.composer(for: host).setRecipients(rooms.activeController?.peers.map(\.id) ?? [])
        case "people.none": core.models.composer(for: host).setRecipients([])
        case "people.call", "people.video": startCall(video: action.name == "people.video", host)
        case "people.verify": if let r = rooms.activeController { Task { await verify(r, peerId: s, host) } }
        case "calllog.open": host.showScreen("log")
        case "calllog.clear":
            Task {
                if await CoreDialogs.confirm(title: "", message: t("log.clear.ask"), yes: t("log.clear"), no: t("nav.close"), destructive: true) {
                    CallSystem.shared.history.clear()
                    host.refresh()
                }
            }
        default:
            Self.log.notice("\(action.name, privacy: .public): the part that handles it is not installed")
        }
    }

    // MARK: - rooms

    /// MainActivity.goRoom: the room on screen (the room screen drawn anew when it is already up).
    func goRoom(_ key: String, _ host: DesignHost) {
        rooms.switchTo(key)
        if host.screen != "room" { host.showScreen("room") } else { host.reshow() }
    }

    /// The join form's submit (MainActivity.finishJoin).
    func finishJoin(room: String, passphrase: String, name: String, _ host: DesignHost) {
        if room.trimmingCharacters(in: .whitespaces).isEmpty || passphrase.isEmpty {
            state.joinError = t("join.passphrase")
            host.refresh()
            return
        }
        state.joinError = ""
        let n = name.trimmingCharacters(in: .whitespaces)
        let key = rooms.join(room: room, passphrase: passphrase, userName: n.isEmpty ? (core.userName.isEmpty ? UIDevice.current.name : core.userName) : n)
        host.closeOverlay()
        goRoom(key, host)
    }

    /// RoomEdit.run: delete (asked first), clone, edit (the join form filled with the room).
    private func roomEdit(_ action: String, _ key: String, _ host: DesignHost) {
        guard let s = rooms.saved(key) else { return }
        let name = s.label.isEmpty ? s.room : s.label
        switch action {
        case "room.delete":
            Task {
                guard await CoreDialogs.confirm(title: t("room.delete.title"), message: t("room.delete.text").replacingOccurrences(of: "{name}", with: name),
                                                yes: t("room.delete.yes"), no: t("room.delete.no"), destructive: true) else { return }
                rooms.forget(key)
                host.refresh()
                host.flash(title: "", text: t("room.deleted").replacingOccurrences(of: "{name}", with: name), level: .info)
            }
        case "room.clone":
            if let k = rooms.clone(key), let c = rooms.saved(k) { host.flash(title: "", text: t("room.cloned").replacingOccurrences(of: "{name}", with: c.label), level: .success) }
            host.refresh()
        case "room.edit":
            host.form["roomEdit"] = .string(key)
            host.showSheet(core.services.design.screen("room.edit") != nil ? "room.edit" : "join")
        default: break
        }
    }

    /// RoomEdit.save: the edit sheet's Save.
    func saveEdit(key: String, room: String, passphrase: String, name: String, _ host: DesignHost) {
        if room.trimmingCharacters(in: .whitespaces).isEmpty || passphrase.isEmpty { host.flash(title: "", text: t("room.edit.missing"), level: .warn); return }
        guard rooms.update(key, room: room, passphrase: passphrase, userName: name.trimmingCharacters(in: .whitespaces)) != nil else { return }
        host.form["roomEdit"] = nil
        host.closeOverlay()
        host.refresh()
        host.flash(title: "", text: t("room.edit.saved"), level: .success)
    }

    // MARK: - the composer's dialogs

    /// message.recipients (Parts.pickRecipients): who gets the next message (none = everyone).
    private func pickRecipients(_ host: DesignHost) {
        guard let r = rooms.activeController else { return }
        let c = core.models.composer(for: host)
        let peers = r.peers
        if peers.isEmpty { host.flash(title: "", text: t("msg.nobody"), level: .info); return }
        let chosen = Set(peers.indices.filter { c.recipientIds.contains(peers[$0].id) })
        Task {
            guard let picked = await CoreDialogs.chooseMany(title: t("msg.recipients"), items: peers.map(\.name), chosen: chosen, ok: "OK",
                                                            everyone: t("msg.everyone"), cancel: t("nav.close")) else { return }
            c.setRecipients(picked.map { peers[$0].id })
        }
    }

    // MARK: - forwarding (Parts.forward, the 6.10 sheet message.forward)

    private var forwarding: ChatMessage?
    private var forwardRoomKey = ""

    private static func vaultFile(_ m: ChatMessage) -> Bool { m.filePath != nil && m.fileDataUrl == nil }

    private func forward(_ m: ChatMessage, _ host: DesignHost) {
        let open = rooms.connectedSessions
        if open.isEmpty { host.flash(title: "", text: t("room.offline"), level: .warn); return }
        forwarding = m
        forwardRoomKey = open.count == 1 ? open[0].key : ""
        if core.services.design.screen("message.forward") != nil {
            host.form["forward"] = forwardScope()
            host.showSheet("message.forward")
            return
        }
        // A design before 6.10: the dialogs.
        Task {
            guard let i = await CoreDialogs.choose(title: t("msg.forward"), items: open.map(\.label), cancel: t("nav.close")) else { return }
            let to = open[i]
            let peers = to.peers
            if peers.isEmpty || Self.vaultFile(m) { send(m, to: to, peer: nil, host); return }
            let who = [t("msg.everyone") + " · " + to.label] + peers.map(\.name)
            guard let w = await CoreDialogs.choose(title: t("msg.forwardTo"), items: who, cancel: t("nav.close")) else { return }
            send(m, to: to, peer: w == 0 ? nil : peers[w - 1], host)
        }
    }

    private func forwardRoom(_ key: String, _ host: DesignHost) {
        guard forwarding != nil else { return }
        let to = key.isEmpty ? nil : rooms.controller(key)
        forwardRoomKey = to?.connected == true ? to!.key : ""
        host.form["forward"] = forwardScope()
        host.refresh()
    }

    private func forwardTo(_ peerId: String, _ host: DesignHost) {
        guard let m = forwarding, let to = forwardRoomKey.isEmpty ? nil : rooms.controller(forwardRoomKey), to.connected else {
            host.closeOverlay()
            host.flash(title: "", text: t("room.offline"), level: .warn)
            return
        }
        let id = peerId.isEmpty || Self.vaultFile(m) ? nil : peerId
        let peer = id.flatMap { pid in to.peers.first { $0.id == pid } }
        if id != nil && peer == nil { host.form["forward"] = forwardScope(); host.refresh(); return }
        forwarding = nil
        forwardRoomKey = ""
        host.closeOverlay()
        send(m, to: to, peer: peer, host)
    }

    /// Parts.forwardTo: the same text and attachment, "forwarded from", no kinds; a vault file to the whole room.
    private func send(_ m: ChatMessage, to: RoomController, peer: PeerRef?, _ host: DesignHost) {
        var o = Outgoing(text: m.visibleText)
        o.forwardedFrom = m.forwardedFrom ?? m.senderName
        if m.fileDataUrl != nil { o.fileName = m.fileName; o.fileMime = m.fileMime; o.dataUrl = m.fileDataUrl; o.fileSize = m.fileSize; o.fileImage = m.fileImage }
        if let peer { o.recipients = [peer.id]; o.recipientNames = [peer.name] }
        if let path = m.filePath, m.fileDataUrl == nil {
            to.sendFile(vaultId: path, name: m.fileName ?? "file", mime: m.fileMime ?? "application/octet-stream", size: m.fileSize, o)
        } else {
            to.send(o)
        }
        host.flash(title: "", text: "✓ " + (peer.map { $0.name + " · " } ?? "") + to.label, level: .success)
    }

    /// $form.forward: the step, what goes, the rooms or the people.
    private func forwardScope() -> DesignValue {
        guard let m = forwarding else { return .object([:]) }
        let open = rooms.connectedSessions
        let to = forwardRoomKey.isEmpty ? nil : rooms.controller(forwardRoomKey)
        var text = String(m.visibleText.split(whereSeparator: \.isNewline).first ?? "")
        if text.isEmpty, let f = m.fileName { text = f }
        let kind = m.fileImage ? "image" : m.fileName != nil ? "file" : m.loc != nil ? "location" : "text"
        let icon = kind == "image" ? "image" : kind == "file" ? "paperclip" : kind == "location" ? "map-pin" : "message-square"
        let whole = Self.vaultFile(m)
        let people: [DesignValue] = to != nil && !whole ? to!.peers.map { ["id": .string($0.id), "name": .string($0.name)] } : []
        return ["step": .string(to == nil ? "room" : "who"), "canBack": .bool(to != nil && open.count > 1),
                "sender": .string(m.mine ? t("quote.you") : m.senderName), "text": .string(String(text.prefix(120))), "icon": .string(icon),
                "rooms": .array(open.map { ["key": .string($0.key), "name": .string($0.label), "users": .number(Double($0.userCount)), "here": .bool($0.key == rooms.activeKey)] }),
                "room": .string(to?.label ?? ""), "people": .array(people), "hasPeople": .bool(!people.isEmpty), "wholeRoom": .bool(whole)]
    }

    // MARK: - files and places

    /// The file in another app / saved / shared: a decrypted temporary copy to the share sheet (deleted after).
    private func shareFile(_ m: ChatMessage, _ host: DesignHost) {
        guard let name = m.fileName else { return }
        do {
            let url: URL
            if let path = m.filePath {
                url = try core.fileStore.temporaryCopy(path, name: name)
            } else if let d = m.fileDataUrl, let comma = d.firstIndex(of: ","), let data = Data(base64Encoded: String(d[d.index(after: comma)...])) {
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                url = dir.appendingPathComponent(Payloads.safeFileName(.string(name)))
                try data.write(to: url, options: .completeFileProtection)
            } else { return }
            SharePresenter.present([url])
            Task {
                try? await Task.sleep(for: .seconds(120))
                self.core.fileStore.discard(url)
            }
        } catch {
            host.flash(title: "", text: t("file.noApp"), level: .warn)
        }
    }

    /// The sender's position on a map (Parts.openMap): Apple Maps with a pin, else OpenStreetMap.
    private func openMap(_ m: ChatMessage) {
        guard let loc = m.loc, let lat = loc.double("lat"), let lon = loc.double("lon") else { return }
        let q = m.senderName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        if let u = URL(string: String(format: "maps://?ll=%.6f,%.6f&q=%@", locale: Locale(identifier: "en_US_POSIX"), lat, lon, q)), UIApplication.shared.canOpenURL(u) {
            UIApplication.shared.open(u)
        } else if let u = URL(string: PositionText.mapUrl(lat: lat, lon: lon)) {
            UIApplication.shared.open(u)
        }
    }

    private func openSystemSettings(_ what: String) {
        let url = what == "notifications" ? URL(string: UIApplication.openNotificationSettingsURLString) : URL(string: UIApplication.openSettingsURLString)
        if let url { UIApplication.shared.open(url) }
    }

    // MARK: - calls

    /// call.audio / call.video (Actions: the permissions first, then the call screen).
    private func startCall(video: Bool, _ host: DesignHost) {
        guard let r = rooms.activeController else { return }
        host.closeOverlay()
        Task {
            if await CallSystem.shared.startCall(roomKey: r.key, video: video) { host.showScreen("call") }
        }
    }

    /// People › verify: compare the safety number, then mark the person verified (or take it back).
    private func verify(_ r: RoomController, peerId: String, _ host: DesignHost) async {
        let number = r.safetyNumber(peerId)
        guard !number.isEmpty else { return }
        let verified = r.people.first { $0.id == peerId }?.trust == Trust.verified
        let ok = await CoreDialogs.confirm(title: t("people.verify"), message: number, yes: verified ? t("people.unverify") : t("people.verify"),
                                           no: t("nav.close"))
        if ok { r.identityVerified(peerId, !verified) }
    }

    // MARK: - lock, PIN, wipe (Parts.changePin, MainActivity.toggleBiometric, Parts.askWipe)

    private func changePin(_ host: DesignHost) async {
        guard let center = SecurityCenter.shared else { return }
        guard let v = await CoreDialogs.inputs(title: t("settings.changePin"), fields: [
            .init(placeholder: t("lock.enterPin"), secure: true, numeric: true), .init(placeholder: t("lock.setPin"), secure: true, numeric: true),
            .init(placeholder: t("lock.confirmPin"), secure: true, numeric: true)], ok: "OK", cancel: t("nav.close")) else { return }
        if v[1].count < center.lock.pinLength || v[1] != v[2] { host.flash(title: "", text: t("lock.pinMismatch"), level: .error); return }
        switch await center.lock.changePin(current: v[0], new: v[1]) {
        case .ok: host.flash(title: "", text: t("settings.changePin") + " ✓", level: .success)
        case .refused: host.flash(title: "", text: t("set.security.duress.same"), level: .error)
        case .wrongCurrent(let r):
            host.flash(title: "", text: r == .wiped ? t("lock.wiped") : t("lock.wrongPin"), level: .error)
        }
    }

    private func toggleBiometric(_ host: DesignHost) {
        guard let center = SecurityCenter.shared else { return }
        if center.vault.bioEnrolled { center.lock.disableBiometrics(); host.refresh(); return }
        do {
            try center.lock.enrollBiometrics()
            host.flash(title: "", text: t("settings.biometric") + " ✓", level: .success)
        } catch {
            host.flash(title: "", text: error.localizedDescription, level: .error)
        }
        host.refresh()
    }

    private func askWipe() async {
        guard await CoreDialogs.confirm(title: "", message: t("settings.wipe") + "?", yes: t("settings.wipe"), no: t("nav.close"), destructive: true) else { return }
        rooms.disconnectAll()
        SecurityCenter.shared?.wipe(reason: "user", remote: false, attempts: 0)
        core.routeChanged()
    }

    // MARK: - the account (MainActivity.accountSignIn, AccountDialogs.after)

    private func accountCeremony(signUp: Bool, _ host: DesignHost) async {
        let r = signUp ? await core.account.signUp() : await core.account.signIn()
        await AccountDialogs.after(r, signUp: signUp, core: core, host: host)
        host.refresh()
    }

    private func addPasskey(_ host: DesignHost) async {
        let r = await core.account.addPasskey()
        if r.ok { host.flash(title: "", text: t("passkey.added"), level: .success) } else { await AccountDialogs.after(r, signUp: false, core: core, host: host) }
        host.refresh()
    }

    private func recoveryCode(_ host: DesignHost) async {
        if core.account.scope["recovery"].boolValue == true {
            guard await CoreDialogs.confirm(title: t("passkey.recoveryTitle"), message: t("passkey.recoveryReplaceAsk"), yes: "OK", no: t("passkey.cancel")) else { return }
        }
        let (code, failure) = await core.account.createRecoveryCode()
        if let code {
            await CoreDialogs.notice(title: t("passkey.recoveryTitle"), message: code + "\n\n" + t("passkey.recoveryShow"), ok: t("passkey.recoveryDone"),
                                     extra: (t("passkey.recoveryCopy"), { host.copy(code) }))
        } else if let failure {
            await AccountDialogs.after(failure, signUp: false, core: core, host: host)
        }
        host.refresh()
    }

    /// 6.4 registration: name, country, mobile, e-mail → an account with a passkey.
    private func register(_ host: DesignHost) async {
        guard let v = await CoreDialogs.inputs(title: t("set.user.register"), fields: [
            .init(placeholder: t("reg.firstName")), .init(placeholder: t("reg.lastName")), .init(placeholder: t("reg.country")),
            .init(placeholder: t("reg.phone")), .init(placeholder: t("reg.email"))], ok: t("reg.submit"), cancel: t("nav.close")) else { return }
        let form: NetJSON = ["firstName": .string(v[0]), "lastName": .string(v[1]), "country": .string(v[2].uppercased()), "phone": .string(v[3]), "email": .string(v[4])]
        let r = await core.account.register(form: form)
        await AccountDialogs.after(r, signUp: true, core: core, host: host)
        host.refresh()
    }

    // MARK: - NFC without the panel (nfc.read / write / emulate / stop — Android Nfc with ConnTag)

    private func nfcFallback(_ name: String, _ host: DesignHost) {
        switch name {
        case "nfc.stop": NfcService.shared.cancel(); NfcService.shared.stopEmulation()
        default: host.flash(title: "", text: t("nfc.unavailable"), level: .warn)
        }
    }

    // MARK: - links, entering the app, settings

    /// m5cet:// links (MainActivity.handleIntent → Forms.enrollLink; a room link while the app runs).
    func link(_ link: DeepLink, _ host: DesignHost) -> Bool {
        switch link {
        case .enroll(let url):
            let starting = host.screen.isEmpty || host.screen == "splash"
            guard let l = EnrollLink.parse(url.absoluteString) else {
                notice(host, starting, t("enroll.qrInvalid"), .error)
                return true
            }
            let server = l.server, code = l.code, kid = l.kid
            if core.device.enrolled {
                let now = core.device.server
                let text = core.security.isLocked ? t("enroll.qrLocked")
                    : EnrollLink.sameServer(now, server) ? t("enroll.qrAlready").replacingOccurrences(of: "{server}", with: now)
                    : t("enroll.qrOther").replacingOccurrences(of: "{server}", with: now).replacingOccurrences(of: "{other}", with: server)
                notice(host, starting, text, .warn)
                return true
            }
            host.form["server"] = .string(server)
            host.form["code"] = .string(code)
            host.form["kid"] = .string(kid)
            host.form["enrollLinkServer"] = .string(server)
            host.form["enrollPrefill"] = .number((host.form["enrollPrefill"]?.numberValue ?? 0) + 1)
            state.enrollError = ""
            if starting { return true }
            if host.screen == "enroll" { host.refresh() } else { host.showScreen("enroll") }
            host.flash(title: "", text: t("enroll.qrApplied") + (code.isEmpty ? " " + t("enroll.qrNoCode") : ""), level: .info)
            return true
        default:
            return false
        }
    }

    private func notice(_ host: DesignHost, _ starting: Bool, _ text: String, _ level: FlashLevel) {
        if starting {
            Task { try? await Task.sleep(for: .seconds(1.5)); host.flash(title: "", text: text, level: level) }
        } else {
            host.flash(title: "", text: text, level: level)
        }
    }

    /// MainActivity.enterApp: the saved rooms, the account's session, a pending room, the check-in.
    func enterApp(_ host: DesignHost) {
        state.dropLockPad()
        core.enterApp()
        if let k = core.pendingRoom {
            core.pendingRoom = nil
            if rooms.controller(k) != nil { goRoom(k, host) } else { host.showScreen("rooms") }
        }
    }

    /// MainActivity.settingChanged: permissions, services, the rooms' receipts, the lock's own switches.
    func settingChanged(_ key: String, _ host: DesignHost) {
        switch key {
        case "messages.receipts", "messages.readReceipts": rooms.settingsChanged()
        case "calls.speaker", "callLog", "calls.logName", "calls.history", "hideIp": CallSystem.shared.settingsChanged()
        case SecuritySetting.lockDisconnect, SecuritySetting.shufflePin, SecuritySetting.screenshotFlash:
            core.security.securitySettingChanged(key, host.settings.bool(key))
        case SecuritySetting.duress:
            Task { await duressChanged(host) }
        default:
            core.settingObservers.forEach { $0(key, host) }
        }
    }

    /// Parts.duressChanged: on → the current PIN and the duress PIN twice; anything else turns it off again.
    private func duressChanged(_ host: DesignHost) async {
        guard let center = SecurityCenter.shared else { return }
        if !host.settings.bool(SecuritySetting.duress) { center.duress.clear(); center.settings.set(SecuritySetting.duress, false); host.refresh(); return }
        let off = { host.userSetSetting(SecuritySetting.duress, .bool(false)); host.refresh() }
        guard let v = await CoreDialogs.inputs(title: t("set.security.duress"), message: t("set.security.duress.about"), fields: [
            .init(placeholder: t("lock.enterPin"), secure: true, numeric: true), .init(placeholder: t("set.security.duress.new"), secure: true, numeric: true),
            .init(placeholder: t("lock.confirmPin"), secure: true, numeric: true)], ok: "OK", cancel: t("nav.close")) else { off(); return }
        if v[1] != v[2] { host.flash(title: "", text: t("lock.pinMismatch"), level: .error); off(); return }
        let r = await center.lock.confirm(pin: v[0])
        if r != .ok { host.flash(title: "", text: r == .wiped ? t("lock.wiped") : t("lock.wrongPin"), level: .error); off(); return }
        if let why = await center.lock.setDuress(pin: v[1]) {
            host.flash(title: "", text: why == "same" ? t("set.security.duress.same") : core.services.design.tn("set.security.duress.length", Int64(center.lock.pinLength), lang: core.services.lang), level: .error)
            off()
            return
        }
        host.flash(title: "", text: t("set.security.duress") + " ✓", level: .success)
        host.refresh()
    }
}

extension DesignAction {
    /// The argument's text of an action with one text argument ("" for the others).
    var argText: String {
        guard let child = Mirror(reflecting: self).children.first else { return "" }
        if let s = child.value as? String { return s }
        // copy / share: (text, computed)
        if let first = Mirror(reflecting: child.value).children.first?.value as? String { return first }
        return ""
    }
}
