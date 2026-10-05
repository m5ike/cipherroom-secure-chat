// 6.7: the profile on screen (port of android/…/ui/parts/ProfileUi.java) — the
// editor's actions and its $profile, the field dialog, the pictures picked for it,
// and what the People widget and a person's detail show of the profiles members
// share. The model and the rules are M5Proto's (ProfileCard, WhoSees, Profiles,
// ProfileImages); the card itself comes from PeopleProfileService.
//
// 6.10: who sees what — the editor's summary ($profile.whoSees) and each field's
// audience chip (profile.audience, a menu of the three), the card on top of
// Settings ($myProfile), and a sender's sheet ($form.sender: what they share with
// the room, from a tap on their avatar).

import Foundation
import M5Core
import M5Design
import M5Proto
import Observation

@MainActor
@Observable
final class ProfileEditor {
    static let shared = ProfileEditor()

    static let audiences = ["me", "room", "public"]

    @ObservationIgnored var profiles: () -> any PeopleProfileService = { PeopleParts.profiles }
    @ObservationIgnored var account: () -> any AccountModel = { CoreModels.shared.account }

    /// The editor's working copy (nil until the card is open), and the card as last saved. Not observed: the
    /// screen's scope writes them while it is resolved; changes redraw through `host.refresh()`.
    @ObservationIgnored private(set) var draft: JSONObject?
    @ObservationIgnored private var saved = ""
    @ObservationIgnored private(set) var busy = false
    @ObservationIgnored private(set) var msg = ""
    /// The window whose $form the editor binds (the one that opened it, or showed its screen last).
    @ObservationIgnored weak var host: DesignHost?

    /// 6.12 (F-16): the app locked — the working copy and the last saved card leave the memory.
    func forget() {
        draft = nil
        saved = ""
        msg = ""
    }

    // MARK: actions

    /// profile.* (Actions.run): open, pick, clear, field, sync, save, public, audience.
    func run(_ action: String, _ arg: String, host: DesignHost, source: ActionSource?) {
        self.host = host
        switch action {
        case "profile.open":
            // 6.10: also from a sheet (my own detail, my own avatar): the sheet goes first.
            host.closeOverlay()
            draft = nil
            msg = ""
            edit(host, profiles().card)
            host.showScreen("settings.profile")
        case "profile.pick":
            let kind = arg == "cover" ? "cover" : "avatar"
            ProfilePhotoPicker.pick(host: host) { [weak self, weak host] data in
                guard let self, let host else { return }
                self.picked(kind, data, host: host)
            }
        case "profile.clear":
            sync(host)
            image(arg == "cover" ? "cover" : "avatar", "")
            host.refresh()
        case "profile.field":
            sync(host)
            fieldDialog(arg, host: host)
        case "profile.sync":
            sync(host)
            host.refresh()
        case "profile.save": save(host)
        case "profile.public":
            profiles().fetchPublic(arg)
            PeopleModel.shared.refreshAll(host)
        case "profile.audience": audienceMenu(arg, host: host, anchor: source)
        default: PeopleLog.warn("profile: unknown action \(action)")
        }
    }

    /// Starts editing `card` (nil: not open yet): the form's fields get its values.
    func edit(_ host: DesignHost, _ card: JSONObject?) {
        guard let card else { return }
        let d = ProfileCard.normalize(card)
        draft = d
        saved = d.stringify()
        let nick = d.object("nickname") ?? JSONObject(), about = d.object("about") ?? JSONObject()
        host.form["pfNick"] = .string(nick.optString("value"))
        host.form["pfNickAud"] = .string(nick.optString("audience"))
        host.form["pfAbout"] = .string(about.optString("value"))
        host.form["pfAboutAud"] = .string(about.optString("audience"))
        host.form["pfAvatarAud"] = .string(d.object("avatar")?.optString("audience") ?? "me")
        host.form["pfCoverAud"] = .string(d.object("cover")?.optString("audience") ?? "me")
        host.form["pfPreview"] = "room"
    }

    private static func formText(_ form: [String: DesignValue], _ key: String) -> String {
        guard let v = form[key], !v.isNull else { return "" }
        return Expr.toText(v)
    }

    /// The form's values (typed or switched) into the working copy.
    func sync(_ host: DesignHost) {
        guard draft != nil else { return }
        put("nickname", "value", Self.formText(host.form, "pfNick"))
        put("about", "value", Self.formText(host.form, "pfAbout"))
        for (item, key) in [("nickname", "pfNickAud"), ("about", "pfAboutAud"), ("avatar", "pfAvatarAud"), ("cover", "pfCoverAud")] {
            let aud = Self.formText(host.form, key)
            if ProfileCard.isAudience(.string(aud)) { put(item, "audience", aud) }
        }
    }

    private func put(_ item: String, _ key: String, _ value: String) {
        guard var d = draft else { return }
        var it = d.object(item) ?? JSONObject()
        it[key] = .string(value)
        d[item] = .object(it)
        draft = d
    }

    private func image(_ kind: String, _ dataUrl: String) { put(kind, "value", dataUrl) }

    /// A picked picture: re-encoded without metadata, in the background (ProfileImages' ladder).
    func picked(_ kind: String, _ data: Data, host: DesignHost) {
        Task { @MainActor [weak self, weak host] in
            let result: Result<String, Error> = await Task.detached(priority: .userInitiated) {
                Result { try ProfileImageEncoder.encode(data, kind: kind) }
            }.value
            guard let self, let host else { return }
            switch result {
            case .success(let url):
                self.sync(host)
                self.image(kind, url)
                host.refresh()
            case .failure(let e):
                let large = (e as? ProfileImages.Failure) == .imageTooLarge
                host.flash(title: "", text: host.peopleText(large ? "pf.err.imageLarge" : "pf.err.image"), level: .error)
            }
        }
    }

    private func save(_ host: DesignHost) {
        guard draft != nil, !busy else { return }
        sync(host)
        busy = true
        msg = ""
        host.refresh()
        let toSave = ProfileCard.normalize(draft)
        let service = profiles()
        Task { @MainActor [weak self, weak host] in
            do {
                let s = try await service.save(toSave)
                guard let self else { return }
                self.busy = false
                let d = ProfileCard.normalize(s.card)
                self.draft = d
                self.saved = d.stringify()
                if let host {
                    self.msg = !s.publicError.isEmpty ? host.peopleText("pf.saved.publicFailed") + " " + s.publicError
                        : host.peopleText(s.outcome == "published" ? "pf.saved.published" : s.outcome == "withdrawn" ? "pf.saved.withdrawn" : "pf.saved")
                }
                for r in CoreModels.shared.rooms.open { (r as? any PeopleRoomExtras)?.profileChanged() }
            } catch {
                guard let self else { return }
                self.busy = false
                let text = (error as? LocalizedError)?.errorDescription ?? ""
                self.msg = text.isEmpty ? host?.peopleText("pf.loadFailed") ?? "" : text
            }
            host?.refresh()
        }
    }

    // MARK: $profile (settings.profile)

    /// $profile of settings.profile (MainActivity.scopeFor).
    func scope(_ host: DesignHost?) -> DesignValue {
        let service = profiles()
        let acct = account()
        let card = service.card
        if let host { self.host = host }
        if draft == nil, card != nil, let h = host ?? self.host { edit(h, card) }
        if card == nil && !acct.signedIn { draft = nil }
        let h = host ?? self.host
        if let h { sync(h) }
        let t: (String) -> String = { key in h?.peopleText(key) ?? key }
        var o = JSONObject([("signedIn", .bool(acct.signedIn)), ("ready", .bool(draft != nil)), ("loading", .bool(service.loading)),
                            ("error", .string(service.error)), ("busy", .bool(busy)), ("msg", .string(msg))])
        guard let d = draft else { return o.designValue }
        let avatar = d.object("avatar")?.optString("value") ?? "", cover = d.object("cover")?.optString("value") ?? ""
        let nick = d.object("nickname")?.optString("value") ?? ""
        let who = nick.isEmpty ? acct.username : nick
        o["dirty"] = .bool(ProfileCard.normalize(d).stringify() != saved)
        o["avatar"] = .string(avatar)
        o["cover"] = .string(cover)
        o["hasAvatar"] = .bool(!avatar.isEmpty)
        o["hasCover"] = .bool(!cover.isEmpty)
        o["initials"] = .string(who.isEmpty ? "?" : who)
        var fields = [JSON]()
        let list = d.array("fields") ?? []
        for (i, x) in list.enumerated() {
            let f = x.objectValue ?? JSONObject()
            let type = f.optString("type"), value = f.optString("value"), aud = f.optString("audience")
            fields.append(.object(JSONObject([
                ("index", .double(Double(i))), ("type", .string(type)), ("typeLabel", .string(t("pf.type." + type))), ("icon", .string(Profiles.icon(type))),
                ("label", .string(f.optString("label"))), ("value", .string(value)), ("audience", .string(aud)),
                ("audIcon", .string(Profiles.audienceIcon(aud))), ("audLabel", .string(Self.audienceLabel(aud, t))), // 6.10: the field's audience chip
                ("invalid", .bool(!value.javaTrimmed.isEmpty && ProfileCard.cleanValue(type, value).isEmpty)),
            ])))
        }
        o["fields"] = .array(fields)
        o["canAdd"] = .bool(list.count < ProfileCard.fields)
        // 6.10: who sees what, by name — as the draft stands now.
        let sees = WhoSees.summary(d)
        o["whoSees"] = .object(JSONObject([("public", .object(Self.named(d, sees.array("public"), t))), ("room", .object(Self.named(d, sees.array("room"), t))),
                                           ("me", .object(Self.named(d, sees.array("me"), t)))]))
        let aud = h.map { Self.formText($0.form, "pfPreview") } ?? "room"
        var preview = Self.labelled(Profiles.drawn(ProfileCard.viewFor(d, ProfileCard.isAudience(.string(aud)) ? aud : "room")), t) ?? JSONObject()
        preview["empty"] = .bool(ProfileCard.isEmptyView(preview))
        o["preview"] = .object(preview)
        return o.designValue
    }

    // MARK: 6.10 who sees what

    /// An audience's name as a chip says it (room members short).
    static func audienceLabel(_ audience: String, _ t: (String) -> String) -> String {
        let a = ProfileCard.isAudience(.string(audience)) ? audience : "me"
        return t("pf.aud." + a + (a == "room" ? ".short" : ""))
    }

    /// {count, text}: how many items, and their names ("nothing" for none).
    static func named(_ card: JSONObject, _ keys: [JSON]?, _ t: (String) -> String) -> JSONObject {
        var names = [String]()
        let fields = card.array("fields")
        for k in (keys ?? []).compactMap(\.stringValue) {
            if k.hasPrefix("field:") {
                guard let i = Int(k.dropFirst(6)), let fields, i >= 0, i < fields.count, let f = fields[i].objectValue else { continue }
                names.append(f.optString("label").isEmpty ? t("pf.type." + f.optString("type")) : f.optString("label"))
            } else {
                names.append(t("pf." + k))
            }
        }
        return JSONObject([("count", .double(Double(names.count))), ("text", .string(names.isEmpty ? t("pf.who.nothing") : names.joined(separator: ", ")))])
    }

    /// profile.audience: who sees one item (a field's index, or nickname / about / avatar / cover) — a menu of
    /// the three audiences at the item's chip, the current one checked.
    func audienceMenu(_ which: String, host: DesignHost, anchor: ActionSource?) {
        guard let d = draft, !which.isEmpty, let anchor else { return }
        sync(host)
        let formKey = Self.baseAudienceKey(which)
        var current = "me"
        var index = -1
        if formKey != nil {
            guard let item = d.object(which) else { return }
            current = item.optString("audience", "me")
        } else {
            guard let n = Double(which), n.isFinite, let fields = d.array("fields") else { return }
            index = Int(n)
            guard index >= 0, index < fields.count, let f = fields[index].objectValue else { return }
            current = f.optString("audience", "me")
        }
        let entries = Self.audiences.enumerated().map { i, aud in
            MenuEntry(id: i, icon: Profiles.audienceIcon(aud), label: host.peopleText("pf.aud." + aud), checked: aud == current) { [weak self, weak host] in
                guard let self, let host else { return }
                // The four base items are bound to the form (their switches): set it there, sync() takes it.
                if let formKey { host.form[formKey] = .string(aud) } else { self.setFieldAudience(index, aud) }
                self.sync(host)
                host.refresh()
            }
        }
        host.showMenu(entries, anchor: anchor.id)
    }

    private func setFieldAudience(_ index: Int, _ aud: String) {
        guard var d = draft, var fields = d.array("fields"), index >= 0, index < fields.count, var f = fields[index].objectValue else { return }
        f["audience"] = .string(aud)
        fields[index] = .object(f)
        d["fields"] = .array(fields)
        draft = d
    }

    static func baseAudienceKey(_ item: String) -> String? {
        switch item {
        case "nickname": "pfNickAud"
        case "about": "pfAboutAud"
        case "avatar": "pfAvatarAud"
        case "cover": "pfCoverAud"
        default: nil
        }
    }

    // MARK: $myProfile (Settings)

    /// $myProfile of Settings (the card on top): my name (the public nickname, else the username), my photo,
    /// and how many items each audience sees. The card opens in the background the first time (ready then).
    func summary(t: (String) -> String) -> DesignValue {
        let acct = account()
        let signedIn = acct.signedIn
        let card = signedIn ? profiles().card : nil
        let user = acct.username
        let nick = card?.object("nickname")?.optString("value") ?? ""
        let photo = card?.object("avatar")?.optString("value") ?? ""
        var o = JSONObject([("signedIn", .bool(signedIn)), ("ready", .bool(card != nil)), ("nickname", .string(nick)), ("photo", .string(photo)),
                            ("name", .string(!nick.isEmpty ? nick : !user.isEmpty ? user : t("set.user.signedOut")))])
        if let card {
            let who = WhoSees.summary(card)
            o["counts"] = .object(JSONObject([("public", .double(Double(who.array("public")?.count ?? 0))), ("room", .double(Double(who.array("room")?.count ?? 0))),
                                              ("me", .double(Double(who.array("me")?.count ?? 0)))]))
        }
        return o.designValue
    }

    // MARK: 6.10 a sender

    /// $form.sender (msg.sender): who wrote a message and what they share with the room — only their room view,
    /// checked again (WhoSees.senderView); for my own message what members see of me. Their name here, the
    /// nickname they share, the username, whether they are still here and a private message is possible.
    static func sender(_ r: any RoomModel, _ m: ChatMessage, profiles: any PeopleProfileService, myUsername: String, t: (String) -> String) -> JSONObject {
        let me = m.mine
        let function = ModelIdentity.reservedSender(m.senderId) // 6.11: system-messenger too
        let person = me || function ? nil : r.people.first { $0.id == m.senderId }
        let channel = person?.channel ?? ""
        let view = WhoSees.senderView(me || function ? nil : r.profile(of: m.senderId), me ? profiles.card : nil, me)
        let name = m.senderName.isEmpty ? "?" : m.senderName
        let nick = view?.optString("nickname") ?? ""
        var o = JSONObject([
            ("id", .string(m.senderId)), ("name", .string(name)), ("me", .bool(me)), ("function", .bool(function)),
            ("present", .bool(me || (person != nil && channel != "closed"))), ("canMessage", .bool(!me && channel == "open")),
            ("username", .string(me ? myUsername : person?.username ?? "")), ("title", .string(nick.isEmpty ? name : nick)),
            ("nickDiffers", .bool(!nick.isEmpty && nick.lowercased() != name.lowercased())), ("photo", .string(view?.optString("avatar") ?? "")),
            ("has", .bool(view != nil)),
        ])
        let drawn = view.flatMap { labelled(Profiles.drawn($0), t) }
        o["profile"] = .object(drawn ?? JSONObject([("fields", .array([]))]))
        return o
    }

    /// Fields without a label get their kind's name.
    static func labelled(_ drawn: JSONObject?, _ t: (String) -> String) -> JSONObject? {
        guard var d = drawn else { return nil }
        guard var f = d.array("fields") else { return d }
        for i in f.indices {
            guard var x = f[i].objectValue, x.optString("label").isEmpty else { continue }
            x["label"] = .string(t("pf.type." + x.optString("type")))
            f[i] = .object(x)
        }
        d["fields"] = .array(f)
        return d
    }

    // MARK: people

    /// A person's detail ($form.person.profile): what they share with the room, and their public profile when asked for.
    static func detail(_ r: any RoomModel, _ u: JSONObject, profiles: any PeopleProfileService, t: (String) -> String) -> JSONObject {
        let me = u.bool("me") ?? false
        let id = u.optString("id")
        let room = me ? profiles.roomView : r.profile(of: id)
        var p = JSONObject([("has", .bool(room != nil && !ProfileCard.isEmptyView(room)))])
        if let room { p["room"] = labelled(Profiles.drawn(room), t).map(JSON.object) }
        if !me, let look = profiles.lookup(u.optString("username")) {
            p["publicState"] = .string(look.optString("state"))
            if let pub = look.object("profile") { p["public"] = labelled(Profiles.drawn(pub), t).map(JSON.object) }
            let key = look.optString("accountKey")
            p["publicVerified"] = .bool(!key.isEmpty && key == r.accountKey(of: id))
        } else {
            p["publicState"] = ""
            p["publicVerified"] = false
        }
        var out = u
        out["profile"] = .object(p)
        return out
    }

    // MARK: the field dialog

    /// Edits a field (its index) or adds one ("new"): kind, label, value and who sees it.
    func fieldDialog(_ arg: String, host: DesignHost) {
        guard let d = draft else { return }
        let fields = d.array("fields") ?? []
        let isNew = arg == "new"
        var index = -1
        if !isNew {
            guard let n = Double(arg), n.isFinite else { return }
            index = Int(n)
            guard index >= 0, index < fields.count else { return }
        } else if fields.count >= ProfileCard.fields { return }
        let f = isNew ? JSONObject() : fields[index].objectValue ?? JSONObject()
        let start = ProfileFieldSheet.Field(type: ProfileCard.fieldTypes.contains(f.optString("type")) ? f.optString("type") : "phone",
                                            label: f.optString("label"), value: f.optString("value"),
                                            audience: isNew ? "me" : (ProfileCard.isAudience(f["audience"]) ? f.optString("audience") : "me"))
        let idx = index
        var remove: (@MainActor @Sendable () -> Void)?
        if !isNew {
            remove = { [weak self, weak host] in
                guard let self, var d = self.draft, var list = d.array("fields"), idx < list.count else { return }
                list.remove(at: idx)
                d["fields"] = .array(list)
                self.draft = d
                host?.refresh()
            }
        }
        let sheet = ProfileFieldSheet(field: start, isNew: isNew, onSave: { [weak self, weak host] next in
            guard let self, var d = self.draft else { return }
            var list = d.array("fields") ?? []
            let item = JSONObject([("id", .string(isNew ? ProfileCard.newFieldId() : f.optString("id"))), ("type", .string(next.type)),
                                   ("label", .string(next.label)), ("value", .string(next.value)), ("audience", .string(next.audience))])
            if isNew { list.append(.object(item)) } else if idx < list.count { list[idx] = .object(item) }
            d["fields"] = .array(list)
            self.draft = ProfileCard.normalize(d)
            host?.refresh()
        }, onRemove: remove)
        SecureDialog.present(sheet, host: host, detents: [.large])
    }
}
