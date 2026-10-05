// The signed-in user's profile card as People and the profile editor read it —
// the contract of android/…/profile/Profiles.java the UI uses: the card opened
// once per account from the account vault's "card" part (in the background), its
// state (loading, error), the save (the public view PUT / DELETE on /api/profile,
// then the whole card sealed into the vault — M5Proto Profiles.planSave /
// finishSave), the public lookups a person's detail asks for, and the lock's
// forget. The core's account service implements it (Core/Account); until it is
// installed, People runs on SignedOutProfiles (no card: the editor asks to sign in).

import Foundation
import M5Core
import M5Proto
import Observation

@MainActor
protocol PeopleProfileService: AnyObject, Observable {
    /// The card of the signed-in account (nil: signed out, or still opening — reading it starts the opening).
    var card: JSONObject? { get }
    var loading: Bool { get }
    /// Why the card did not open ("" = fine).
    var error: String { get }
    /// Saves the card: the public view to the server (or withdrawn), then sealed into the vault. A failed
    /// public step still saves the card (Saved.publicError). Throws when the vault part failed.
    func save(_ draft: JSONObject) async throws -> Profiles.Saved
    /// A public lookup's state for a username ({state: loading | none | error | ok, profile?, accountKey}); nil = not asked.
    func lookup(_ username: String) -> JSONObject?
    /// Asks the server for a username's public profile — only when the person asks (it tells the server whose
    /// profile is looked at). The state shows through `lookup`.
    func fetchPublic(_ username: String)
    /// 6.12 (F-16): the lock — the card and the lookups leave the memory.
    func forget()
}

extension PeopleProfileService {
    /// What room members may see of me now (nil: nothing).
    var roomView: JSONObject? {
        guard let c = card else { return nil }
        let v = ProfileCard.viewFor(c, "room")
        return ProfileCard.isEmptyView(v) ? nil : v
    }

    /// My photo (for my own avatar on this phone), "" without one.
    var myPhoto: String { Profiles.myPhoto(card) }
}

/// No profile service yet (or signed out): no card, nothing to look up.
@MainActor
@Observable
final class SignedOutProfiles: PeopleProfileService {
    var card: JSONObject? { nil }
    var loading: Bool { false }
    var error: String { "" }
    func save(_ draft: JSONObject) async throws -> Profiles.Saved { throw ProfileServiceError.unavailable }
    func lookup(_ username: String) -> JSONObject? { nil }
    func fetchPublic(_ username: String) {}
    func forget() {}
}

enum ProfileServiceError: Error, LocalizedError {
    case unavailable
    var errorDescription: String? { "profile service unavailable" }
}

/// A card in memory with the public step simulated — previews, screenshots and tests. The public lookup
/// answers from `publicProfiles` (username → {profile, accountKey}); anyone else has none.
@MainActor
@Observable
final class MemoryProfiles: PeopleProfileService {
    var card: JSONObject?
    var loading = false
    var error = ""
    var lookups: [String: JSONObject] = [:]
    @ObservationIgnored var publicProfiles: [String: JSONObject] = [:]
    @ObservationIgnored var publicError: String?
    @ObservationIgnored var now: () -> Int64 = { EpochMs.now }
    @ObservationIgnored private(set) var saves = 0

    init(card: JSONObject? = nil) { self.card = card }

    func save(_ draft: JSONObject) async throws -> Profiles.Saved {
        let plan = Profiles.planSave(draft, now: now())
        let saved = Profiles.finishSave(plan, publicError: publicError)
        card = saved.card
        saves += 1
        return saved
    }

    func lookup(_ username: String) -> JSONObject? { lookups[username] }

    func fetchPublic(_ username: String) {
        guard Profiles.isUsername(username) else { return }
        lookups[username] = Profiles.lookupState("loading", nil, "")
        let found = publicProfiles[username]
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard let self else { return }
            if let f = found { self.lookups[username] = Profiles.lookupResult(f) } else { self.lookups[username] = Profiles.lookupFailure(status: 404) }
        }
    }

    func forget() { card = nil; lookups = [:] }

    /// The preview's card: a nickname for everyone, an about text for room members, a phone only for me, a blog.
    static func sampleCard() -> JSONObject {
        func item(_ v: String, _ aud: String) -> JSON { .object(JSONObject([("value", .string(v)), ("audience", .string(aud))])) }
        func field(_ id: String, _ type: String, _ label: String, _ value: String, _ aud: String) -> JSON {
            .object(JSONObject([("id", .string(id)), ("type", .string(type)), ("label", .string(label)), ("value", .string(value)), ("audience", .string(aud))]))
        }
        return ProfileCard.normalize(JSONObject([
            ("nickname", item("Mike", "public")), ("about", item("Píšu aplikace a jezdím na kole.", "room")),
            ("avatar", item("", "room")), ("cover", item("", "me")),
            ("fields", .array([field("a1b2c3", "phone", "Mobil", "+420 777 123 456", "me"), field("d4e5f6", "url", "Blog", "https://mike.example", "public")])),
        ]))
    }
}
