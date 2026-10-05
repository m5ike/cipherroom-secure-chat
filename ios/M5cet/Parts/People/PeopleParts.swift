// People, profiles and message details — where the part plugs into the app
// (one line in App/Bootstrap.swift: `PeopleParts.install(into: model)`):
//
//   slots      userPanel (UserPanel), userList (UserPanel.List)
//   actions    people.* (11), users.toggle / dock / autoHide, msg.info (MsgDetails), msg.sender (ProfileUi.sender),
//              profile.open / pick / clear / field / sync / save / public / audience
//   router     shownUsername (profile.public's ActionGuard: only the person whose detail is open)
//   variables  settings.profile → $profile, settings → $myProfile, room / call → $users (the panel's state)
//   the lock   the vault copies, the open detail, the photos, the profile draft go (6.12 F-16); a new unlock
//
//   contacts   ContactsService (Platform/Contacts): its store gets the vault's user tier, People links through it,
//              PeopleReach is its ContactReachHost (the window side of "message / call via M5cet")
//
// The services other code owns come in through the seams (Model/PeopleSeams.swift): `profiles` (the
// account's profile card — the core installs it), `contacts` (the address book), `hides` (MsgDetails'
// hide / delete; the chat part shares its current unlock and the core sets the audit), PeopleRoomExtras
// (a room's statistics, forwards verified by key, the profile's new version).

import Foundation
import M5Core
import M5Design
import M5Proto
import SwiftUI

@MainActor
enum PeopleParts {
    /// The account's profile card (the core's account service installs its own).
    static var profiles: any PeopleProfileService = SignedOutProfiles()
    /// Hiding and deleting from the message details (the chat part / core may install the shared one).
    static var hides: any DetailsHiding = defaultHides
    static let defaultHides = DetailsHides()
    /// The address book (Platform/Contacts).
    static var contacts: (any PeopleContacts)? {
        get { PeopleModel.shared.contacts }
        set { PeopleModel.shared.contacts = newValue }
    }

    /// The actions People handles.
    static let peopleActions = ["people.open", "people.select", "people.all", "people.none", "people.message", "people.call", "people.video",
                                "people.verify", "people.link", "people.unlink", "people.unlinkAll"]
    static let usersActions = ["users.toggle", "users.dock", "users.autoHide"]
    static let profileActions = ["profile.open", "profile.pick", "profile.clear", "profile.field", "profile.sync", "profile.save", "profile.public",
                                 "profile.audience"]
    static let messageActions = ["msg.info", "msg.sender"]
    static var actions: [String] { peopleActions + usersActions + profileActions + messageActions }

    private static weak var services: DesignServices?
    private static let lock = PeopleLock()

    static func install(into model: AppModel) {
        // The address book and the people records (Platform/Contacts): the vault's user tier behind the store
        // (people.links, people.verified — the same store the rooms' verifiedDevice reads), the picker and
        // links, and the window side of "message / call via M5cet".
        let service = ContactsService.shared
        if let center = SecurityCenter.shared { service.store.setVault(SecurityPeopleVault(vault: center.vault)) }
        PeopleModel.shared.store = service.store
        PeopleModel.shared.contacts = service
        service.reach.host = PeopleReach.shared
        #if DEBUG
        // Sample mode (-M5Screen): the sample core's people, an in-memory card and records.
        if DebugLaunch.screen != nil {
            profiles = MemoryProfiles(card: MemoryProfiles.sampleCard())
            PeopleModel.shared.store = PeopleStore(vault: PeopleMemoryVault())
            let d = UserDefaults.standard
            UserPanelState.shared = UserPanelState.sample(dock: d.string(forKey: "M5UsersDock"), autoHide: d.bool(forKey: "M5UsersAutoHide"))
        }
        #endif
        install(services: model.design)
        SecurityCenter.shared?.add(lock)
        SecurityCenter.shared?.add(defaultHides)
    }

    /// Registers the slots, actions, the router's shownUsername and the screen variables (tests call it with their own services).
    static func install(services: DesignServices) {
        self.services = services
        services.slots.register("userPanel") { ctx in
            ensureVariables()
            PeopleReach.shared.host = ctx.host
            return AnyView(UserPanelView(ctx: ctx))
        }
        services.actions.onEnterApp { host in PeopleReach.shared.host = host }
        services.slots.register("userList") { ctx in AnyView(UserListView(users: ctx.scope["users"].arrayValue ?? [])) }
        services.actions.register(actions) { action, ctx in handle(action, ctx) }
        services.actions.shownUsername = { PeopleModel.shared.shownUsername() }
        services.actions.onSettingChanged { key, host in
            if key == "people.contacts" { PeopleModel.shared.contactsSettingChanged(on: host.settings.bool(key)) }
        }
        ensureVariables()
    }

    /// The screen variables People owns, on the core in use now (a new core — the bootstrap's, a preview's — gets them too).
    static func ensureVariables(_ core: CoreModels = CoreModels.shared) {
        guard !core.variables.has("settings.profile", "profile") else { return }
        core.variables.register("settings.profile", "profile") { ProfileEditor.shared.scope(nil) }
        core.variables.register("settings", "myProfile") { ProfileEditor.shared.summary(t: text) }
        let users: ScreenVariables.Provider = { UserPanelState.shared.scope(count: CoreModels.shared.rooms.active?.userCount ?? 0) }
        core.variables.register("room", "users", users)
        core.variables.register("call", "users", users)
    }

    /// A design text without a window (the screen variables): the last window People acted in, else the app's design.
    private static func text(_ key: String) -> String {
        if let h = ProfileEditor.shared.host { return h.peopleText(key) }
        guard let s = services else { return key }
        return PeopleTexts.t(Translator(design: s.design, lang: s.lang), lang: s.lang, key)
    }

    // MARK: the actions

    static func handle(_ action: DesignAction, _ ctx: ActionContext) {
        let host = ctx.host
        ensureVariables()
        ProfileEditor.shared.host = host
        PeopleReach.shared.host = host
        switch action {
        case .peopleOpen(let s), .peopleSelect(let s), .peopleAll(let s), .peopleNone(let s), .peopleMessage(let s), .peopleCall(let s),
             .peopleVideo(let s), .peopleVerify(let s), .peopleLink(let s), .peopleUnlink(let s), .peopleUnlinkAll(let s):
            PeopleModel.shared.run(action.name, s, host: host)
        case .usersToggle:
            UserPanelState.shared.toggle()
            host.refresh()
        case .usersDock(let edge):
            UserPanelState.shared.dock(edge.isEmpty ? "right" : edge)
            host.refresh()
        case .usersAutoHide(let on):
            UserPanelState.shared.setAutoHide(on)
            host.refresh()
        case .profileOpen(let s), .profilePick(let s), .profileClear(let s), .profileField(let s), .profileSync(let s), .profileSave(let s),
             .profilePublic(let s), .profileAudience(let s):
            ProfileEditor.shared.run(action.name, s, host: host, source: ctx.source)
        case .msgInfo(let id): messageInfo(id, host: host)
        case .msgSender(let id): showSender(id, host: host)
        default: break
        }
    }

    /// The message of an id: in the room on screen, else in another connected room.
    static func find(_ id: String) -> (room: any RoomModel, message: ChatMessage)? {
        let rooms = CoreModels.shared.rooms
        if let r = rooms.active, let m = r.message(id) { return (r, m) }
        for r in rooms.open { if let m = r.message(id) { return (r, m) } }
        return nil
    }

    /// msg.info: the message's details (MsgDetails) — not for a system line.
    static func messageInfo(_ id: String, host: DesignHost) {
        guard let (r, m) = find(id), m.kind != "sys" else { return }
        SecureDialog.present(MsgDetailsView(room: r, messageId: m.id, hides: hides), host: host, detents: [.medium, .large])
    }

    /// msg.sender: what the message's sender shares with the room (message.sender), else their detail.
    static func showSender(_ id: String, host: DesignHost) {
        guard let (r, m) = find(id), m.kind != "sys" else { return }
        // 6.11: a model's answer — the model behind it (message.model), and who it came through.
        if modelFace(m) != nil { showModel(m, host: host); return }
        if host.design.screen("message.sender") == nil {
            // A bundle from before 6.10: the person's detail (it has their room profile), when they are here.
            if r.peerName(m.senderId) != nil { PeopleModel.shared.run("people.open", m.senderId, host: host) }
            return
        }
        host.form["sender"] = ProfileEditor.sender(r, m, profiles: profiles, myUsername: CoreModels.shared.account.username, t: host.peopleText).designValue
        host.showSheet("message.sender")
    }

    /// ModelFace.of: the model behind an answer (nil for anything else).
    static func modelFace(_ m: ChatMessage) -> ModelIdentity? {
        if m.kind == "sys" || m.kind == "note" { return nil }
        if let model = m.model { return ModelIdentity.fromJson(model) }
        if m.fnCall { return nil }
        guard let fn = m.fnDraw else {
            return m.senderId.hasPrefix("function:") ? ModelIdentity.of(String(m.senderId.dropFirst("function:".count)), m.senderName, nil) : nil
        }
        return ModelIdentity.fromJson(fn)
    }

    /// 6.11: the model behind an answer — the message.model sheet; a design without it gets the same in a dialog.
    private static func showModel(_ m: ChatMessage, host: DesignHost) {
        guard let card = CoreModels.shared.fn?.modelCard(for: m) else { return }
        if host.design.screen("message.model") != nil {
            host.form["model"] = card.designValue
            host.showSheet("message.model")
            return
        }
        var text = "/" + card.optString("keyword")
        if !card.optString("line").isEmpty { text += "\n" + card.optString("line") }
        if !card.optString("summary").isEmpty { text += "\n\n" + card.optString("summary") }
        if !card.optString("usage").isEmpty { text += "\n\n" + host.peopleText("fnm.usage") + ": " + card.optString("usage") }
        if !card.optString("guide").isEmpty { text += "\n\n" + card.optString("guide") }
        var actions = [SecureDialog.Action(label: host.peopleText("nav.close"), role: .cancel)]
        if card.bool("known") == true {
            let write = card.optString("write")
            actions.insert(.init(label: host.peopleText("fnm.card.write")) { [weak host] in
                guard let host else { return }
                host.closeOverlay()
                CoreModels.shared.composer(for: host).write(write)
            }, at: 0)
        }
        SecureDialog.alert(host: host, title: card.optString("name"), message: text, actions: actions)
    }
}

/// What a lock does to People (M5.forgetSecrets): the copies of the vault, the open detail, the contacts'
/// photos, the profile draft and the opened card leave the memory.
@MainActor
final class PeopleLock: LockParticipant {
    func lockDidForget() {
        PeopleModel.shared.forget()
        ProfileEditor.shared.forget()
        PeopleParts.profiles.forget()
    }
}
