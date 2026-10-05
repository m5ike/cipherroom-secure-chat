// The phone's address book (6.2) — the iOS half of
// android/app/src/main/java/cz/m5cet/app/contacts/AddressBook.java.
//
// What Android does, and why iOS cannot:
//  - Android adds an account of the app's own type (AuthenticatorService), a
//    contacts sync adapter that only declares the data kinds (SyncService), and
//    per linked person a raw contact of that account with two rows — "Zpráva přes
//    M5cet" / "Volat přes M5cet" — joined to the chosen contact; the Contacts app
//    opens such a row in M5cet (ContactIntents).
//  - iOS has no app accounts in Contacts, no custom data rows, no raw contacts
//    an app may join to someone else's card, and an app may not write to the
//    address book behind the person's back. Writing a link into the person's own
//    card (a URL field) would change their contact — synced to iCloud and shared
//    with the card — so this port does NOT write to the address book at all.
//  - The replacement: the link lives in the vault only (PeopleStore: the
//    username and the CNContact identifier), and M5cet donates an
//    INSendMessageIntent / INStartCallIntent interaction for each linked person
//    (ContactsService) — Siri suggestions, the share sheet and the contact card's
//    Message / Call buttons can then offer "M5cet" for that person; tapping it
//    opens the app with the intent (ContactsService.continueUserActivity), which
//    reaches the person as Android's row does.
//
// Reading: the CNContact identifier and name of the contact the person picked
// (CNContactPickerViewController — out of process, needs no permission), and the
// linked contact's name and thumbnail later (needs access; with limited access
// (iOS 18) only for contacts the person shared — `readable` says so, and the UI
// offers ContactAccessButton / .contactAccessPicker for that contact).

import Contacts
import Foundation

/// What M5cet may read of the address book.
enum ContactsAccess: String, Sendable {
    case notDetermined, denied, restricted
    /// iOS 18: only the contacts the person shared with the app.
    case limited
    case full

    var canRead: Bool { self == .limited || self == .full }
}

/// A contact as the people features need it.
struct ContactCard: Sendable, Equatable {
    var identifier: String
    var name: String
    var thumbnail: Data?
}

/// The Contacts framework (CNContactStore; a fake in the tests).
protocol ContactStoreAccess: AnyObject, Sendable {
    var access: ContactsAccess { get }
    /// The system's question (the person's action only); true when some access was granted.
    func requestAccess() async -> Bool
    /// A contact by its identifier, nil when it is gone or not shared with the app.
    func contact(_ identifier: String) -> ContactCard?
}

final class SystemContactStore: ContactStoreAccess, @unchecked Sendable {
    private let store = CNContactStore()

    var access: ContactsAccess {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .restricted: .restricted
        case .limited: .limited
        case .authorized: .full
        @unknown default: .denied
        }
    }

    func requestAccess() async -> Bool {
        do { return try await store.requestAccess(for: .contacts) } catch { return false }
    }

    func contact(_ identifier: String) -> ContactCard? {
        guard access.canRead, !identifier.isEmpty else { return nil }
        let keys: [CNKeyDescriptor] = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactThumbnailImageDataKey as CNKeyDescriptor,
                                       CNContactImageDataAvailableKey as CNKeyDescriptor]
        guard let c = try? store.unifiedContact(withIdentifier: identifier, keysToFetch: keys) else { return nil }
        return ContactCard(identifier: c.identifier, name: CNContactFormatter.string(from: c, style: .fullName) ?? "",
                           thumbnail: c.imageDataAvailable ? c.thumbnailImageData : nil)
    }

    /// The name of a contact the picker returned (CNContactPickerViewController gives the contact itself).
    static func card(of contact: CNContact) -> ContactCard {
        let name = contact.isKeyAvailable(CNContactGivenNameKey) ? (CNContactFormatter.string(from: contact, style: .fullName) ?? "") : ""
        let thumb = contact.isKeyAvailable(CNContactThumbnailImageDataKey) ? contact.thumbnailImageData : nil
        return ContactCard(identifier: contact.identifier, name: name, thumbnail: thumb)
    }
}
