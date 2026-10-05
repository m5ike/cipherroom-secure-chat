// 6.7: the signed-in user's profile card on this phone and the rooms' profile
// frames — android profile/Profiles.java + RoomSession.profiles() over M5Proto's
// pure parts (Profiles, ProfileCard, ProfileRoom). The card opens once per
// account from the account vault's own "card" part (AccountService.loadCard),
// is saved there sealed (every audience — what is "only me" never leaves the
// phone readable) after its public view went to the server or was withdrawn
// (Profiles.planSave → PUT / DELETE /api/profile → finishSave). The rooms hand
// the "room" view to their members, one peer at a time, sealed for that peer
// (ProfileRoom.Exchange per room, one Cache for every room). People's editor
// and detail read it as PeopleParts.profiles; the lock forgets the card, the
// lookups and what the members shared (6.12 F-16).

import Foundation
import M5Core
import M5Crypto
import M5Net
import M5Proto
import Observation
import os

@MainActor
@Observable
final class CoreProfiles: PeopleProfileService, RoomProfiles {
    @ObservationIgnored weak var core: AppCore?
    /// What the other members share, by their device key and rev (every room).
    @ObservationIgnored let cache = ProfileRoom.Cache(Profiles.cacheSize)
    /// Each connected room's side of the profile frames (by room key).
    @ObservationIgnored private var exchanges: [String: ProfileRoom.Exchange] = [:]
    private var opened: JSONObject?
    /// The account the card was opened for ("" = none yet).
    private var loadedFor = ""
    private(set) var loading = false
    private(set) var error = ""
    private var lookups: [String: JSONObject] = [:]
    /// Bumped when the card was opened, saved or dropped (the screens read it again).
    private(set) var revision = 0
    @ObservationIgnored var now: () -> Int64 = { EpochMs.now }
    nonisolated static let log = Logger(subsystem: "cz.m5cet.app", category: "profile")

    init(core: AppCore?) { self.core = core }

    private var account: AccountService? { core?.account }
    private var user: String { (account?.signedIn ?? false) ? account?.username ?? "" : "" }

    // MARK: - the card (Profiles.card / open)

    /// The card of the signed-in account (nil: signed out, or still opening — reading it starts the opening).
    var card: JSONObject? {
        _ = revision
        let u = user
        if u.isEmpty {
            if opened != nil || !loadedFor.isEmpty {
                // Signed out: the card and the lookups go (after this read — a getter does not mutate the observed state).
                Task { @MainActor [weak self] in self?.dropForSignOut() }
            }
            return nil
        }
        if u != loadedFor && !loading {
            loading = true
            Task { @MainActor [weak self] in await self?.open(u) }
        }
        return u == loadedFor ? opened : nil
    }

    private func dropForSignOut() {
        guard user.isEmpty, opened != nil || !loadedFor.isEmpty else { return }
        opened = nil; loadedFor = ""; error = ""; lookups = [:]
        changed()
    }

    private func open(_ u: String) async {
        var card: JSONObject?
        var err = ""
        do {
            card = ProfileCard.normalize(try await account?.loadCard())
        } catch {
            err = error.localizedDescription
            Self.log.warning("the card did not open")
        }
        loading = false
        // Signed out or another account meanwhile: this card is not theirs.
        guard user == u else { return }
        loadedFor = u
        opened = card
        error = err
        changed()
    }

    /// The name a room's name field starts with: the public nickname, else `current`.
    func prefill(_ current: String) -> String { ProfileCard.prefill(card, current) }

    // MARK: - save (Profiles.save)

    func save(_ draft: JSONObject) async throws -> Profiles.Saved {
        guard let account, account.signedIn else { throw ProfileServiceError.unavailable }
        let plan = Profiles.planSave(draft, now: now())
        var publicError: String?
        do {
            switch plan.step {
            case .publish(let body): _ = try await account.profileApi("PUT", "/api/profile", body: body, auth: true)
            case .withdraw: _ = try await account.profileApi("DELETE", "/api/profile", body: nil, auth: true)
            case .none: break
            }
        } catch {
            publicError = error.localizedDescription.isEmpty ? "error" : error.localizedDescription
        }
        let saved = Profiles.finishSave(plan, publicError: publicError)
        try await account.saveCard(saved.card)
        opened = saved.card
        loadedFor = account.username
        error = ""
        changed()
        return saved
    }

    // MARK: - lookups (Profiles.lookup / fetchPublic)

    func lookup(_ username: String) -> JSONObject? { lookups[username] }

    /// Only when the person asks: it tells the server whose profile is looked at.
    func fetchPublic(_ username: String) {
        guard Profiles.isUsername(username), let account else { return }
        lookups[username] = Profiles.lookupState("loading", nil, "")
        Task { @MainActor [weak self] in
            let result: JSONObject
            do {
                result = Profiles.lookupResult(try await account.profileApi("GET", "/api/profile/" + username, body: nil, auth: false))
            } catch let e as HTTPError {
                result = Profiles.lookupFailure(status: e.status)
            } catch {
                result = Profiles.lookupFailure(status: nil)
            }
            self?.lookups[username] = result
        }
    }

    // MARK: - the lock (6.12 F-16)

    /// The opened card, the public lookups and what the other members shared leave the memory (the card opens again
    /// after the unlock, the rooms share again when they reconnect).
    func forget() {
        opened = nil; loadedFor = ""; error = ""; lookups = [:]
        loading = false
        cache.clear()
        exchanges = [:]
        revision &+= 1
    }

    /// The rooms learn the new version, the screens draw again (Profiles.changed → RoomSession.profileChanged).
    private func changed() {
        revision &+= 1
        for r in core?.rooms.connectedSessions ?? [] { exchanges[r.key]?.changed() }
        core?.hosts.forEach { $0.refresh() }
    }

    /// A room's own "my profile changed" (PeopleRoomExtras.profileChanged): its members learn the version.
    func profileChanged(room: RoomController) { exchanges[room.key]?.changed() }

    // MARK: - RoomProfiles (RoomSession.profiles)

    private func exchange(_ room: RoomController) -> ProfileRoom.Exchange {
        if let x = exchanges[room.key] { return x }
        let x = ProfileRoom.Exchange(cache, RoomProfileDeps(room: room, profiles: self))
        exchanges[room.key] = x
        return x
    }

    /// A checked profile frame from the channel's peer (RoomCore: bound to it, only sealed for us alone).
    func frame(room: RoomController, peerId: String, _ frame: JSONObject) {
        guard let f = ProfileRoom.parse(frame) else { return }
        exchange(room).receive(peerId, f)
    }

    /// Their hello was accepted (protocol 4: the pair session is up): if they speak profiles, they learn my rev.
    func hello(room: RoomController, peerId: String, caps: [JSON]?) { exchange(room).hello(peerId, caps) }

    /// What a member shares with the room (nil: nothing, or an app without profiles).
    func profile(of peerId: String) -> JSONObject? {
        _ = revision
        return cache.of(peerId)
    }

    /// The account key that signed a member's messages: the exchange's, else the member's attested account key
    /// from its hello (the same key — Android takes it from the messages' signatures).
    func accountKey(room: RoomController, peerId: String) -> String {
        let k = exchanges[room.key]?.accountKey(peerId) ?? ""
        return k.isEmpty ? room.snap.peers.first { $0.id == peerId }?.accountKey ?? "" : k
    }

    /// A peer left the room: its exchange state and shared view go.
    func peerGone(room: RoomController, peerId: String) { exchanges[room.key]?.forget(peerId) }

    /// The room went (left, forgotten).
    func roomGone(_ key: String) { exchanges[key] = nil }

    /// What room members may see of me now (nil: nothing).
    var myRoomView: JSONObject? { Profiles.roomView(card) }

    #if DEBUG
    /// Tests: this card as the signed-in account's, without the vault (the rooms learn its version).
    func useCard(_ card: JSONObject?) {
        opened = card.map { ProfileCard.normalize($0) }
        loadedFor = user
        error = ""
        changed()
    }
    #endif
}

/// ProfileRoom.Deps for one room. The exchange is only driven from the main actor (CoreProfiles), so these run there.
private final class RoomProfileDeps: ProfileRoom.Deps, @unchecked Sendable {
    private weak var room: RoomController?
    private weak var profiles: CoreProfiles?

    @MainActor
    init(room: RoomController, profiles: CoreProfiles) {
        self.room = room
        self.profiles = profiles
    }

    /// Sealed for that one peer (the ratchet, or the pair key) — never the room key, never via the server.
    func send(_ peerId: String, _ frame: JSONObject) -> Bool {
        MainActor.assumeIsolated { room?.sendProfileFrame(peerId, frame) ?? false }
    }

    func myView() -> JSONObject? { MainActor.assumeIsolated { profiles?.myRoomView } }

    func ownerOf(_ peerId: String) -> String? {
        MainActor.assumeIsolated {
            guard let k = room?.snap.peers.first(where: { $0.id == peerId })?.publicKey, !k.isEmpty else { return nil }
            return k
        }
    }

    func now() -> Int64 { EpochMs.now }
}
