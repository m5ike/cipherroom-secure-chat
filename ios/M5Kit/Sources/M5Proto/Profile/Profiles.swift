// 6.7: the signed-in user's profile card — the pure parts of android
// profile/Profiles.java (client/src/lib/profile/client.ts): what the rooms
// get of the card, the save's public step (publish the public view or
// withdraw it) and its outcome, the public lookups' states, and the icons the
// trees draw. Opening and sealing the card in the account vault, the HTTP
// calls (PUT / DELETE /api/profile, GET /api/profile/<username>) and the
// change notifications belong to the app's profile store, which calls these.

import M5Core

/// The profile store's decisions and formats (android `profile/Profiles.java` without its vault, network and threads).
public enum Profiles {
    /// How many shared views the store's ProfileRoom.Cache keeps (every room).
    public static let cacheSize = 64

    /// What room members may see of me now (nil: nothing).
    public static func roomView(_ card: JSONObject?) -> JSONObject? {
        guard let card else { return nil }
        let v = ProfileCard.viewFor(card, "room")
        return ProfileCard.isEmptyView(v) ? nil : v
    }

    /// My photo (for my own avatar on this phone), "" without one.
    public static func myPhoto(_ card: JSONObject?) -> String { card?.object("avatar")?.orgString("value") ?? "" }

    /* -------------------------------------------------------------- save */

    /// What the save does on the server before the card is sealed into the vault.
    public enum PublicStep: Sendable, Equatable {
        /// PUT /api/profile with this body ({profile: the public view}).
        case publish(JSONObject)
        /// DELETE /api/profile (something was published, nothing is public now).
        case withdraw
        /// Nothing to publish, nothing to withdraw.
        case none
    }

    /// A save prepared: the normalized card (updatedAt set) and its public step.
    public struct SavePlan: Sendable, Equatable {
        public let card: JSONObject
        public let step: PublicStep
    }

    /// How a save went: the card to seal, the public part ("published", "withdrawn", "none") and its error ("" = none).
    public struct Saved: Sendable, Equatable {
        public let card: JSONObject
        public let outcome: String
        public let publicError: String
    }

    /// The first half of save(): the draft normalized, stamped `now`, and what the server is told.
    public static func planSave(_ draft: JSONObject?, now: Int64) -> SavePlan {
        let next = ProfileCard.normalize(draft).with("updatedAt", .int(now))
        let view = ProfileCard.publicBody(next)
        if !ProfileCard.isEmptyView(view) { return SavePlan(card: next, step: .publish(JSONObject([("profile", .object(view))]))) }
        if next.orgBool("published") { return SavePlan(card: next, step: .withdraw) }
        return SavePlan(card: next, step: .none)
    }

    /// The second half: the public step's result (nil: it went; else its error message — "error" when it has none)
    /// applied. A failed public step still saves the card, as it was.
    public static func finishSave(_ plan: SavePlan, publicError: String?) -> Saved {
        if let e = publicError { return Saved(card: plan.card, outcome: "none", publicError: e) }
        switch plan.step {
        case .publish: return Saved(card: plan.card.with("published", true), outcome: "published", publicError: "")
        case .withdraw: return Saved(card: plan.card.without("published"), outcome: "withdrawn", publicError: "")
        case .none: return Saved(card: plan.card, outcome: "none", publicError: "")
        }
    }

    /* ------------------------------------------------------------ lookups */

    /// ^[A-Za-z0-9_-]{3,64}$: a username a public lookup may ask for.
    public static func isUsername(_ s: String?) -> Bool {
        guard let u = s?.utf16 else { return false }
        return u.count >= 3 && u.count <= 64 && u.allSatisfy(Commands.wordUnit)
    }

    /// ^[A-Za-z0-9+/=_-]{40,64}$: an account key as the lookup answer gives it.
    static func isAccountKey(_ s: String) -> Bool {
        let u = s.utf16
        return u.count >= 40 && u.count <= 64 && u.allSatisfy { Commands.wordUnit($0) || $0 == 0x2B || $0 == 0x2F || $0 == 0x3D }
    }

    /// A public lookup's state: {state: loading | none | error | ok, accountKey, profile?}.
    public static func lookupState(_ state: String, _ profile: JSONObject?, _ accountKey: String) -> JSONObject {
        JSONObject([("state", .string(state)), ("accountKey", .string(accountKey))]).with("profile", profile.map(JSON.object))
    }

    /// The state for GET /api/profile/<username>'s answer: the profile checked again, the account key if it is one.
    public static func lookupResult(_ response: JSONObject) -> JSONObject {
        guard let profile = ProfileCard.normalizeShared(response.object("profile")) else { return lookupState("none", nil, "") }
        let key = response.orgString("accountKey")
        return lookupState("ok", profile, isAccountKey(key) ? key : "")
    }

    /// The state for a failed lookup: HTTP 404 is "none", anything else (or no status: no answer) "error".
    public static func lookupFailure(status: Int?) -> JSONObject { lookupState(status == 404 ? "none" : "error", nil, "") }

    /* -------------------------------------------------------------- icons */

    /// Type → the icon the trees draw (all in the app's icon set).
    public static func icon(_ type: String?) -> String {
        switch type ?? "" {
        case "name": return "user-round"
        case "phone": return "phone"
        case "email": return "mail"
        case "address": return "map-pin"
        case "url": return "globe"
        case "social": return "at-sign"
        case "org": return "briefcase"
        case "birthday": return "gift"
        default: return "file-text"
        }
    }

    public static func audienceIcon(_ audience: String?) -> String {
        audience == "public" ? "globe" : audience == "room" ? "users" : "lock"
    }

    /// A shared view as the trees draw it: the fields get their icons (nil when a field is not an object).
    public static func drawn(_ view: JSONObject?) -> JSONObject? {
        guard let view else { return nil }
        var fields = [JSON]()
        for x in view.array("fields") ?? [] {
            guard let f = x.objectValue else { return nil }
            fields.append(.object(JSONObject([("icon", .string(icon(f.orgString("type")))), ("label", .string(f.orgString("label"))),
                                              ("value", .string(f.orgString("value"))), ("type", .string(f.orgString("type")))])))
        }
        return view.with("fields", .array(fields))
    }
}
