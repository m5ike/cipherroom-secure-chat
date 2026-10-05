// People and the address book (6.2) — the facade of Platform/Contacts, port of
// android/app/src/main/java/cz/m5cet/app/contacts/{LinkActivity, ContactIntents,
// Store, AddressBook} and the linking parts of ui/parts/People:
//
//  - link(): "Propojit s kontaktem" — after the person picked a contact
//    (CNContactPickerViewController in the UI; Android LinkActivity's picker),
//    the username is linked with the contact's identifier in the vault and an
//    interaction is donated so Siri, the share sheet and the contact card offer
//    M5cet for that person (AddressBook.swift says why nothing is written to the
//    address book on iOS);
//  - unlink() / unlinkAll() / setEnabled(): the donations go (people.contacts
//    off: the links stay in the vault; on again: donated again);
//  - continueUserActivity() / handle(link:): the person tapped M5cet for a
//    contact (or an m5cet://people/message?u=… link) → ContactReach finds them in
//    the connected rooms (Android ContactIntents);
//  - photo(), contact(): the linked contact's name and thumbnail (People widget);
//  - access / requestAccess() / needsAccessPicker(): full or limited access
//    (iOS 18) — asked only on the person's action.

import Contacts
import Foundation
import Intents
import M5Core

@MainActor
final class ContactsService {
    static let shared = ContactsService()

    let store: PeopleStore
    let reach: ContactReach
    var contacts: any ContactStoreAccess
    var donations: any PeopleDonating

    init(store: PeopleStore = PeopleStore(), contacts: any ContactStoreAccess = SystemContactStore(),
         donations: any PeopleDonating = SystemPeopleDonations(), scheduler: any DictationScheduler = MainQueueScheduler(),
         clock: any Clock = SystemClock()) {
        self.store = store
        self.contacts = contacts
        self.donations = donations
        reach = ContactReach(store: store, scheduler: scheduler, clock: clock)
    }

    /// The app's links (m5cet://people/…) come here first (AppModel.onLink).
    func install(into model: AppModel) {
        model.onLink { [weak self] link in self?.handle(link: link) ?? false }
    }

    // MARK: access

    var access: ContactsAccess { contacts.access }

    /// The system's question — only when the person asked to link a contact or to see contact photos.
    func requestAccess() async -> Bool {
        if contacts.access == .notDetermined { return await contacts.requestAccess() }
        return contacts.access.canRead
    }

    /// Limited access and this person's contact is not shared with M5cet: the UI offers ContactAccessButton
    /// (or .contactAccessPicker) so the person can share it.
    func needsAccessPicker(for username: String) -> Bool {
        guard contacts.access == .limited, let id = identifier(of: username) else { return false }
        return contacts.contact(id) == nil
    }

    // MARK: links

    /// The contact a username is linked with (its identifier), nil when none.
    func identifier(of username: String) -> String? {
        let id = store.link(username)?.optString("lookup") ?? ""
        return id.isEmpty ? nil : id
    }

    /// The linked contact (name, thumbnail) when the app may read it; nil otherwise.
    func contact(of username: String) -> ContactCard? { identifier(of: username).flatMap { contacts.contact($0) } }

    /// The linked contact's photo (the thumbnail) for a username; nil without one (Android AddressBook.photo).
    func photo(of username: String) -> Data? { contact(of: username)?.thumbnail }

    /// Links a person (an account username: Match.canLink) with the contact the person picked. Returns the
    /// contact's name; nil when the username cannot be linked (a guest) or the feature is off.
    @discardableResult
    func link(username: String, signedIn: Bool, contact: ContactCard, enabled: Bool) -> String? {
        guard enabled, Match.canLink(username, signedIn: signedIn), !contact.identifier.isEmpty else { return nil }
        let user = Match.cleanUsername(username)
        store.putLink(username: user, contactName: contact.name, identifier: contact.identifier)
        donations.donate(username: user, contact: contact)
        M5Log.shared.info("people", "linked a contact")
        return contact.name
    }

    /// "Zrušit propojení": the link goes (the contact itself stays as it was).
    func unlink(username: String) {
        guard store.link(username) != nil else { return }
        store.removeLink(username)
        donations.remove(username: Match.cleanUsername(username))
    }

    /// Settings › People: every link goes.
    func unlinkAll() {
        for u in store.linkedUsers() { donations.remove(username: u) }
        store.clearLinks()
    }

    /// people.contacts switched: off — the suggestions go (the links stay in the vault); on — they come
    /// back for the contacts that still exist.
    func setEnabled(_ on: Bool) {
        if !on { for u in store.linkedUsers() { donations.remove(username: u) }; return }
        for (_, v) in store.links() {
            guard let o = v.objectValue else { continue }
            let user = o.optString("username"), id = o.optString("lookup")
            guard !user.isEmpty, !id.isEmpty else { continue }
            let card = contacts.contact(id) ?? (contacts.access == .full ? nil : ContactCard(identifier: id, name: o.optString("contact")))
            if let card { donations.donate(username: user, contact: card) }
        }
    }

    /// The app is wiped (Android Wiper): nothing of people stays outside the vault (which goes too).
    func wipe() { donations.removeAll() }

    // MARK: requests from outside

    /// m5cet://people/message?u=<username> or m5cet://people/call?u=<username> (a Shortcut, a link).
    func handle(link: DeepLink) -> Bool {
        guard case .unsupported(let url) = link, let r = Self.request(from: url) else { return false }
        reach.accept(username: r.username, kind: r.kind)
        return true
    }

    nonisolated static func request(from url: URL) -> (username: String, kind: ContactReachKind)? {
        guard url.scheme?.lowercased() == DeepLink.scheme, url.host(percentEncoded: false)?.lowercased() == "people",
              let kind = ContactReachKind(rawValue: url.lastPathComponent.lowercased()),
              let u = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "u" })?.value else { return nil }
        let user = Match.cleanUsername(u)
        return user.isEmpty ? nil : (user, kind)
    }

    /// The link a person can be reached by (for a Shortcut or a share).
    nonisolated static func link(username: String, kind: ContactReachKind) -> URL? {
        let user = Match.cleanUsername(username)
        guard !user.isEmpty else { return nil }
        return URL(string: "\(DeepLink.scheme)://people/\(kind.rawValue)?u=\(user)")
    }

    /// A user activity from Siri, the share sheet or the contact card (INSendMessageIntent /
    /// INStartCallIntent for a person M5cet donated). True when it was one of ours; the caller passes
    /// the others on (Platform/Calls handles INStartCallIntent from Recents — handles "m5cet-…").
    func continueUserActivity(_ activity: NSUserActivity) -> Bool {
        guard let intent = activity.interaction?.intent else { return false }
        return handle(intent: intent)
    }

    /// The intent of such an activity; true when it named a person linked here.
    func handle(intent: INIntent) -> Bool {
        let r: (persons: [INPerson], kind: ContactReachKind)
        if let m = intent as? INSendMessageIntent { r = (m.recipients ?? [], .message) }
        else if let c = intent as? INStartCallIntent { r = (c.contacts ?? [], .call) }
        else { return false }
        guard let user = username(of: r.persons) else { return false }
        reach.accept(username: user, kind: r.kind)
        return true
    }

    /// The linked username an intent's person stands for: our custom identifier, else the linked contact.
    func username(of persons: [INPerson]) -> String? {
        for p in persons {
            if let c = p.customIdentifier, c.hasPrefix(SystemPeopleDonations.prefix) {
                let user = String(c.dropFirst(SystemPeopleDonations.prefix.count))
                if store.link(user) != nil { return Match.cleanUsername(user) }
            }
            if let id = p.contactIdentifier, let user = store.username(forContact: id) { return user }
        }
        return nil
    }
}

// MARK: - donations

/// The system's suggestions for linked people (INInteraction donations; a fake in the tests).
@MainActor
protocol PeopleDonating: AnyObject {
    func donate(username: String, contact: ContactCard)
    func remove(username: String)
    func removeAll()
}

@MainActor
final class SystemPeopleDonations: PeopleDonating {
    /// INPerson.customIdentifier of a linked person: "m5cet:" + username.
    nonisolated static let prefix = "m5cet:"
    nonisolated static let groupPrefix = "cz.m5cet.people."

    /// The person as the intents name them: the username as the handle, the linked contact, our identifier.
    nonisolated static func person(username: String, contact: ContactCard) -> INPerson {
        var name = PersonNameComponents()
        name.nickname = contact.name.isEmpty ? username : contact.name
        return INPerson(personHandle: INPersonHandle(value: username, type: .unknown), nameComponents: name,
                        displayName: contact.name.isEmpty ? username : contact.name, image: contact.thumbnail.map { INImage(imageData: $0) },
                        contactIdentifier: contact.identifier, customIdentifier: prefix + username)
    }

    func donate(username: String, contact: ContactCard) {
        let person = Self.person(username: username, contact: contact)
        let group = Self.groupPrefix + Match.key(username)
        let message = INSendMessageIntent(recipients: [person], outgoingMessageType: .outgoingMessageText, content: nil,
                                          speakableGroupName: nil, conversationIdentifier: group, serviceName: "M5cet", sender: nil, attachments: nil)
        let call = INStartCallIntent(callRecordFilter: nil, callRecordToCallBack: nil, audioRoute: .unknown, destinationType: .normal,
                                     contacts: [person], callCapability: .audioCall)
        for intent in [message as INIntent, call] {
            let i = INInteraction(intent: intent, response: nil)
            i.direction = .outgoing
            i.groupIdentifier = group
            Self.donate(i)
        }
    }

    func remove(username: String) { Self.delete(group: Self.groupPrefix + Match.key(username)) }

    /// Every interaction of the app (a wipe only — Notifications' and Calls' donations go too).
    func removeAll() { Self.deleteAll() }

    // The completions run on the system's queue: made outside the main actor.
    nonisolated private static func donate(_ i: INInteraction) {
        i.donate { error in if let error { M5Log.shared.warn("people", "donation: \(error.localizedDescription)") } }
    }

    nonisolated private static func delete(group: String) { INInteraction.delete(with: group) { _ in } }

    nonisolated private static func deleteAll() { INInteraction.deleteAll { _ in } }
}
