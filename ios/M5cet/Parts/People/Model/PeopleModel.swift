// 6.2 People: the People widget's model and actions (port of android/…/ui/parts/
// People.java), as the web's recipients widget does them — who is in the room
// (status, connection quality, the avatar, a linked contact's photo), choosing who
// gets the next message ($form.msgTo, which the composer reads), a person's detail
// ("users.person", a sheet bound to $form.person), private messages, calls,
// comparing safety numbers (with the QR code, SafetyVerify), and links with the
// address book (PeopleContacts).

import Foundation
import M5Core
import M5Design
import M5Proto
import Observation
import UIKit

@MainActor
@Observable
final class PeopleModel {
    /// The app's People (Bootstrap installs its services).
    static let shared = PeopleModel()

    @ObservationIgnored var core: () -> CoreModels = { CoreModels.shared }
    @ObservationIgnored var store: PeopleStore
    @ObservationIgnored var contacts: (any PeopleContacts)?
    @ObservationIgnored var profiles: () -> any PeopleProfileService = { PeopleParts.profiles }
    @ObservationIgnored var now: () -> Int64 = { Millis.now }
    /// Delays (the keep-fresh loop, the composer's focus) — tests make them short.
    @ObservationIgnored var freshDelay: Duration = .milliseconds(2000)

    /// Bumped when something only People knows changed (a verification, a link, a contact's photo): views redraw.
    private(set) var revision = 0

    /// A linked contact's photo per username key, as a data: URL ("" = none or not readable).
    @ObservationIgnored private var photos: [String: String] = [:]
    @ObservationIgnored private var loading: Set<String> = []
    /// The person the open detail shows, the window showing it, and the one loop keeping it fresh.
    @ObservationIgnored private(set) var shown: String?
    @ObservationIgnored private weak var shownHost: DesignHost?
    @ObservationIgnored private var fresh = 0

    init(store: PeopleStore? = nil) {
        self.store = store ?? PeopleStore(records: VaultPeopleRecords())
    }

    private func touch() { revision &+= 1 }

    // MARK: the model

    /// Who gets the next message ($form.msgTo): peer ids; empty = everyone.
    static func selection(_ form: [String: DesignValue]) -> [String] {
        (form["msgTo"]?.arrayValue ?? []).map { Expr.toText($0) }
    }

    /// The people of a room for the widget, connected first (me on top), away next, the rest last.
    func users(_ r: (any RoomModel)?, form: [String: DesignValue], settings: SettingsModel, t: (String) -> String) -> [JSONObject] {
        guard let r else { return [] }
        let sel = Self.selection(form)
        let contactsOn = settings.bool("people.contacts")
        let at = now()
        var list = [JSONObject]()
        for p in r.people {
            var u = p.scope.json.objectValue ?? JSONObject()
            // 6.12 (F-22): the name as the app shows names (no bidi or invisible characters, NFKC, ≤ 48).
            u["name"] = .string(Names.normalize(u.optString("name")))
            enrich(&u, sel: sel, contactsOn: contactsOn, t: t, now: at)
            list.append(decorate(r, u)) // 6.7: a shared profile photo
        }
        list = list.enumerated().sorted { a, b in
            let ka = a.element.bool("me") == true ? -1 : PeoplePresence.rank(a.element.optString("status"))
            let kb = b.element.bool("me") == true ? -1 : PeoplePresence.rank(b.element.optString("status"))
            return ka != kb ? ka < kb : a.offset < b.offset
        }.map(\.element)
        Self.flagLookalikes(&list)
        return list
    }

    /// What tells two members apart for the look-alike check: their device key, else their account, else the connection.
    static func identity(_ u: JSONObject) -> String {
        let key = u.optString("publicKey")
        if !key.isEmpty { return "k:" + key }
        let user = u.optString("username")
        if u.bool("signedIn") == true && !user.isEmpty { return "a:" + user.lowercased(with: Locale(identifier: "en_US_POSIX")) }
        return "i:" + u.optString("id")
    }

    /// 6.12 (F-22): a member whose name mixes scripts or looks like another member's shows "⚠ " before it;
    /// "nameFlag" says so to the design.
    static func flagLookalikes(_ list: inout [JSONObject]) {
        let flags = Names.flags(list.map { Names.Person(identity($0), $0.optString("name")) })
        for i in list.indices {
            list[i]["nameFlag"] = .bool(flags[i])
            if flags[i] { list[i]["name"] = .string(Names.shown(list[i].optString("name"), flagged: true)) }
        }
    }

    /// What the widget draws of one person (the room's facts + status, signal, avatar, selection, link).
    private func enrich(_ u: inout JSONObject, sel: [String], contactsOn: Bool, t: (String) -> String, now at: Int64) {
        let id = u.optString("id"), name = u.optString("name"), username = u.optString("username"), channel = u.optString("channel")
        let me = u.bool("me") ?? false, signedIn = u.bool("signedIn") ?? false, open = channel == "open"
        let status = PeoplePresence.status(channel, signedIn: signedIn, audio: u.optString("audio"))
        let rtt = PeopleJSON.long(u, "rtt", -1)
        let bars = PeoplePresence.bars(open: open, rttMs: rtt)
        let kid = PeopleSafety.keyId(u.optString("publicKey"))
        let link = me || !signedIn || username.isEmpty ? nil : store.link(username)
        u["status"] = .string(status)
        u["statusIcon"] = .string(PeoplePresence.icon(status))
        u["statusColor"] = .string(PeoplePresence.color(status))
        u["statusLabel"] = .string(t("people.status." + status))
        u["signal"] = .double(Double(bars))
        u["signalIcon"] = .string(PeoplePresence.signalIcon(bars))
        u["signalColor"] = .string(PeoplePresence.signalColor(bars))
        u["rttText"] = .string(rtt >= 0 ? "\(rtt) ms" : "—")
        u["glyph"] = .string(PeopleAvatars.glyph(name, nil))
        u["avatarBg"] = .string(PeopleAvatars.background(name))
        u["avatarFg"] = .string(PeopleAvatars.foreground(name))
        u["selectable"] = .bool(!me && open)
        u["selected"] = .bool(!me && open && sel.contains(id))
        u["linked"] = .bool(link != nil)
        u["contact"] = .string(link?.optString("contact") ?? "")
        u["photo"] = .string(link != nil && contactsOn ? photo(username, link: link!) : "")
        u["canLink"] = .bool(!me && contactsOn && PeopleMatch.canLink(username, signedIn: signedIn))
        u["kid"] = .string(kid)
        u["safetyVerified"] = .bool(!me && store.verified(kid))
        // The 6.0 trees: a valid hello with an unchanged key; "away" as a flag.
        u["verified"] = .bool((u.bool("signed") ?? false) && !(u.bool("changed") ?? false))
        u["away"] = .bool(status == PeoplePresence.away)
        // 6.7: the status dot and "last seen …" (online / away / far away).
        PeopleLastSeen.decorate(&u, t: t, now: at)
    }

    /// ProfileUi.decorate: a member without a contact photo shows the photo they share with the room.
    private func decorate(_ r: any RoomModel, _ u: JSONObject) -> JSONObject {
        guard u.optString("photo").isEmpty else { return u }
        let photo = u.bool("me") == true ? profiles().myPhoto : r.profile(of: u.optString("id"))?.optString("avatar") ?? ""
        var o = u
        if !photo.isEmpty { o["photo"] = .string(photo) }
        return o
    }

    private func find(_ r: any RoomModel, _ id: String, form: [String: DesignValue], settings: SettingsModel, t: (String) -> String) -> JSONObject? {
        users(r, form: form, settings: settings, t: t).first { $0.optString("id") == id }
    }

    /// Everything the detail shows of a person ($form.person).
    func person(_ r: (any RoomModel)?, _ id: String, form: [String: DesignValue], settings: SettingsModel, t: (String) -> String) -> JSONObject? {
        guard let r, var u = find(r, id, form: form, settings: settings, t: t) else { return nil }
        let me = u.bool("me") ?? false, open = u.optString("channel") == "open"
        let since = PeopleJSON.long(u, "since"), at = now()
        let st = me ? nil : (r as? any PeopleRoomExtras)?.peerStats(id)
        let transport = me ? "self" : !open || st == nil || st!.transport.isEmpty ? "connecting" : st!.transport
        let theirs = u.optString("publicKey"), mine = r.myPublicKey
        // 6.12 (§ 12.2): both account keys when both devices are attested, else both device keys.
        let keys = me ? SafetyKeys(mine: mine, theirs: theirs) : r.safetyKeys(id)
        let safety = !me && !keys.mine.isEmpty && !keys.theirs.isEmpty
        var candidates = ""
        if let st, !st.localType.isEmpty {
            candidates = st.localType + " → " + st.remoteType + (st.proto.isEmpty ? "" : " · " + st.proto.uppercased())
                + (st.relayProtocol.isEmpty ? "" : " (TURN " + st.relayProtocol.uppercased() + ")")
        }
        var security = "AES-GCM 256 (E2EE)"
        if let st, st.dtlsState == "connected" {
            security += " · " + (st.dtlsVersion.isEmpty ? "DTLS" : st.dtlsVersion) + (st.srtpCipher.isEmpty ? "" : " · " + st.srtpCipher)
        }
        let number = safety ? PeopleSafety.number(keys.mine, keys.theirs) : ""
        u["peerShort"] = .string(id.utf16.count > 16 ? String(id.suffix(16)) : id)
        u["sinceText"] = .string(since > 0 ? PeoplePresence.duration(at - since, h: t("people.h"), m: t("people.m"), s: t("people.s")) : "—")
        u["transport"] = .string(transport)
        u["transportLabel"] = .string(t("people.transport." + transport))
        u["candidates"] = .string(candidates)
        u["remote"] = .string(st?.remoteAddress ?? "")
        u["codec"] = .string(st?.codecs ?? "")
        u["traffic"] = .string(st.map { PeoplePresence.bytes($0.bytesSent) + " / " + PeoplePresence.bytes($0.bytesReceived) } ?? "—")
        u["security"] = .string(security)
        u["dtls"] = .string(st?.dtlsFingerprint ?? "")
        u["fingerprint"] = .string(PeopleSafety.fingerprint(me ? mine : theirs))
        u["hasSafety"] = .bool(safety)
        u["safety"] = .string(PeopleSafety.lines(number))
        u["safetyNumber"] = .string(number)
        u["room"] = .string(r.label)
        u["contactsOn"] = .bool(settings.bool("people.contacts"))
        u["others"] = .double(Double(max(0, r.userCount - 1)))
        return ProfileEditor.detail(r, u, profiles: profiles(), t: t) // 6.7: what they share, their public profile when asked for
    }

    /// A linked contact's photo as a data: URL ("" until it is read, or without one); read once, in the background.
    private func photo(_ username: String, link: JSONObject) -> String {
        let k = PeopleMatch.key(username)
        if let p = photos[k] { return p }
        guard let contacts, !loading.contains(k) else { return "" }
        let identifier = link.optString("lookup")
        guard !identifier.isEmpty else { return "" }
        loading.insert(k)
        Task { @MainActor [weak self] in
            let data = await contacts.photo(identifier: identifier)
            guard let self else { return }
            let url = data.flatMap { Self.small($0) }.map { "data:image/jpeg;base64," + $0.base64EncodedString() } ?? ""
            self.photos[k] = url
            self.loading.remove(k)
            if !url.isEmpty { self.touch() }
        }
        return ""
    }

    /// A photo small enough for an avatar (the thumbnail usually is): ≤ 48 KB as it is, else 128 px wide JPEG 85.
    nonisolated static func small(_ b: Data) -> Data? {
        if b.count <= 48 * 1024, b.starts(with: [0xFF, 0xD8]) { return b }
        guard let image = UIImage(data: b), image.size.width > 0 else { return nil }
        let w: CGFloat = 128, h = max(1, (128 * image.size.height / image.size.width).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return small.jpegData(compressionQuality: 0.85)
    }

    /// The panel and an open detail again (People.refreshAll).
    func refreshAll(_ host: DesignHost?) {
        touch()
        guard let host else { return }
        if let id = shown, host === shownHost, host.sheet?.screen == "users.person",
           let p = person(core().rooms.active, id, form: host.form, settings: host.settings, t: host.peopleText) {
            host.form["person"] = p.designValue
        }
        host.refresh()
    }

    /// 6.10 (G-20): the username of the person whose detail is open now, or nil — profile.public looks up only
    /// them (the design's argument is computed: "{$form.person.username}"), never a name a design built from data.
    func shownUsername() -> String? {
        guard let id = shown, let host = shownHost, host.sheet?.screen == "users.person" else { return nil }
        let u = person(core().rooms.active, id, form: host.form, settings: host.settings, t: host.peopleText)?.optString("username") ?? ""
        return u.isEmpty ? nil : u
    }

    /// 6.12 (F-16): the lock — the photos, the open detail and the vault copies go.
    func forget() {
        photos = [:]
        loading = []
        shown = nil
        shownHost = nil
        fresh &+= 1
        store.forget()
        touch()
    }

    // MARK: actions

    /// The design's people.* actions.
    func run(_ action: String, _ arg: String, host: DesignHost) {
        switch action {
        case "people.open": open(arg, host: host)
        case "people.select": toggle(arg, host: host)
        case "people.all": selectAll(host: host)
        case "people.none": select([], host: host)
        case "people.message": privateTo(arg, host: host)
        case "people.call": call(arg, video: false, host: host)
        case "people.video": call(arg, video: true, host: host)
        case "people.verify": verify(arg, host: host)
        case "people.link": link(arg, host: host)
        case "people.unlink": unlink(arg, host: host)
        case "people.unlinkAll": unlinkAll(host: host)
        default: PeopleLog.warn("people: unknown action \(action)")
        }
    }

    private func select(_ ids: [String], host: DesignHost) {
        core().composer(for: host).setRecipients(ids)
        touch()
        host.refresh()
    }

    /// Adds or removes a person from who gets the next message (only connected peers of the active room).
    private func toggle(_ id: String, host: DesignHost) {
        guard let r = core().rooms.active, !id.isEmpty, r.peerName(id) != nil else { return }
        var sel = Self.selection(host.form).filter { r.peerName($0) != nil }
        if let i = sel.firstIndex(of: id) { sel.remove(at: i) } else { sel.append(id) }
        select(sel, host: host)
    }

    /// "Select all": every connected person of the room.
    private func selectAll(host: DesignHost) {
        let all = users(core().rooms.active, form: host.form, settings: host.settings, t: host.peopleText)
        select(all.filter { $0.bool("selectable") == true }.map { $0.optString("id") }, host: host)
    }

    /// A private message to only this person: they alone are selected and the composer gets the focus.
    func privateTo(_ peerId: String, host: DesignHost) {
        guard let r = core().rooms.active, !peerId.isEmpty, r.peerName(peerId) != nil else { return }
        host.closeOverlay()
        select([peerId], host: host)
        let composer = core().composer(for: host)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            composer.focus()
        }
    }

    /// The person's detail as a sheet, kept fresh (duration, round trip) while it is open.
    func open(_ id: String, host: DesignHost) {
        guard let p = person(core().rooms.active, id, form: host.form, settings: host.settings, t: host.peopleText) else { return }
        shown = id
        shownHost = host
        host.form["person"] = p.designValue
        host.showSheet("users.person")
        fresh &+= 1
        let g = fresh
        Task { @MainActor [weak self, weak host] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard let self, let host else { return }
            await self.keepFresh(id, g, host: host)
        }
    }

    private func keepFresh(_ id: String, _ g: Int, host: DesignHost) async {
        while g == fresh, id == shown, host.sheet?.screen == "users.person" {
            guard let r = core().rooms.active else { return }
            r.refreshStats()
            try? await Task.sleep(for: .milliseconds(400))
            guard g == fresh, id == shown, host.sheet?.screen == "users.person" else { return }
            if let p = person(r, id, form: host.form, settings: host.settings, t: host.peopleText) {
                host.form["person"] = p.designValue
                host.refresh()
            }
            try? await Task.sleep(for: freshDelay)
        }
    }

    /// A call from the detail: the room's call (as on the web) — asked first when more people would hear it.
    private func call(_ id: String, video: Bool, host: DesignHost) {
        guard let r = core().rooms.active else { return }
        host.closeOverlay()
        let go: @MainActor () -> Void = { [weak host] in _ = host?.runner.runFromApp(video ? "call.video" : "call.audio", value: nil) }
        if r.userCount <= 2 || r.call.active { go(); return }
        let who = r.peerName(id) ?? ""
        SecureDialog.alert(host: host, title: nil, message: PeopleTexts.fill(host.peopleText("people.callAsk"), name: who, other: r.label),
                           actions: [.init(label: host.peopleText(video ? "people.video" : "people.call"), run: go),
                                     .init(label: host.peopleText("nav.close"), role: .cancel)])
    }

    /// The safety number to compare (and its QR code); "they match" marks the person's device key as verified.
    private func verify(_ id: String, host: DesignHost) {
        guard let p = person(core().rooms.active, id, form: host.form, settings: host.settings, t: host.peopleText), p.bool("hasSafety") == true else { return }
        let kid = p.optString("kid"), name = p.optString("name")
        let view = SafetyVerifyView(name: name, number: p.optString("safetyNumber"), verified: p.bool("safetyVerified") ?? false,
                                    ktAlert: core().rooms.ktAlert) { [weak self, weak host] on, scanned in
            guard let self, let host else { return }
            self.setVerified(id, kid: kid, name: name, on: on, scanned: scanned, host: host)
        }
        SecureDialog.present(view, host: host, detents: [.large])
    }

    /// The verification is set (or taken back): the key id's mark, and the room accepts the identity — a
    /// changed one's pins follow and its held messages appear (6.12 § 12).
    func setVerified(_ peerId: String, kid: String, name: String, on: Bool, scanned: Bool, host: DesignHost) {
        store.setVerified(kid, on)
        core().rooms.active?.identityVerified(peerId, on)
        if on { host.flash(title: "", text: scanned ? host.peopleText("sec.safety.verified") : PeopleTexts.fill(host.peopleText("people.verify.done"), name: name), level: .success) }
        refreshAll(host)
    }

    /// "Link to a contact": the address book's picker, then the link kept in the vault.
    private func link(_ id: String, host: DesignHost) {
        guard host.settings.bool("people.contacts") else { host.flash(title: "", text: host.peopleText("people.contactsOff"), level: .warn); return }
        guard let p = person(core().rooms.active, id, form: host.form, settings: host.settings, t: host.peopleText) else { return }
        guard p.bool("canLink") == true else { host.flash(title: "", text: host.peopleText("people.linkOnlyAccounts"), level: .warn); return }
        let username = p.optString("username"), name = p.optString("name")
        guard let contacts else { host.flash(title: "", text: host.peopleText("people.linkFailed"), level: .error); return }
        Task { @MainActor [weak self, weak host] in
            do {
                guard let pick = try await contacts.pickContact(for: username, messageLabel: host?.peopleText("people.contact.message") ?? "",
                                                                callLabel: host?.peopleText("people.contact.call") ?? "") else { return }
                guard let self, let host else { return }
                self.store.putLink(username: username, contactName: pick.name, lookup: pick.identifier)
                self.photos[PeopleMatch.key(username)] = nil
                host.flash(title: "", text: PeopleTexts.fill(host.peopleText("people.linked"), name: name, other: pick.name), level: .success)
                self.refreshAll(host)
            } catch {
                host?.flash(title: "", text: host?.peopleText("people.linkFailed") ?? "", level: .error)
            }
        }
    }

    /// "Unlink": the app's traces go from the contact (the contact itself stays).
    private func unlink(_ id: String, host: DesignHost) {
        let p = person(core().rooms.active, id, form: host.form, settings: host.settings, t: host.peopleText)
        let username = p?.optString("username") ?? id
        guard store.link(username) != nil else { return }
        let contacts = contacts
        Task { @MainActor [weak self, weak host] in
            await contacts?.remove(username: username)
            guard let self else { return }
            self.store.removeLink(username)
            self.photos[PeopleMatch.key(username)] = nil
            host?.flash(title: "", text: host?.peopleText("people.unlinked") ?? "", level: .success)
            self.refreshAll(host)
        }
    }

    /// Settings › People: every link goes (from the address book and from the app).
    private func unlinkAll(host: DesignHost) {
        SecureDialog.alert(host: host, title: nil, message: host.peopleText("people.unlinkAllAsk"), actions: [
            .init(label: host.peopleText("people.unlinkAll"), role: .destructive) { [weak self, weak host] in
                guard let self else { return }
                let contacts = self.contacts
                Task { @MainActor [weak self, weak host] in
                    await contacts?.removeAll()
                    guard let self else { return }
                    self.store.clearLinks()
                    self.photos = [:]
                    host?.flash(title: "", text: host?.peopleText("people.unlinked") ?? "", level: .success)
                    self.refreshAll(host)
                }
            },
            .init(label: host.peopleText("nav.close"), role: .cancel),
        ])
    }

    /// people.contacts off: what the app put into the address book goes (the links stay in the vault);
    /// on again: it comes back, where the contact still is.
    func contactsSettingChanged(on: Bool) {
        photos = [:]
        touch()
        guard let contacts else { return }
        if !on { Task { await contacts.removeAll() }; return }
        let links = store.allLinks().compactMap { $0.value.objectValue }
        Task { await contacts.restore(links: links) }
    }
}
