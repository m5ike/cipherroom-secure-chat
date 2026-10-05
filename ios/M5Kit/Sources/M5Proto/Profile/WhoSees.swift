// 6.10: who sees what of the profile card, in words a person can check at a
// glance (Settings' profile card, the editor's "Who sees what") — and what a
// tap on a sender's avatar may show. A port of android profile/WhoSees.java.
//
// The items are named by keys: "nickname", "about", "avatar", "cover" and
// "field:<index>" (the card's fields in their order). An item counts only
// with a value that would be shared (the same check as ProfileCard.viewFor: a
// field whose value does not check out for its type is shared with no one).
// The audiences nest — the public sees the public items, room members the
// room and public ones — so:
//
//   seenBy(card, "public")   what anyone with the username reads
//   seenBy(card, "room")     what the people in my rooms get
//   onlyMe(card)             what stays in my vault (seen by no one else)

import M5Core

/// Who sees what of the profile card (android `profile/WhoSees.java`).
public enum WhoSees {
    private static let items = ["nickname", "about", "avatar", "cover"]

    /// The items `viewer` (me | room | public) sees of the card, in the card's order.
    public static func seenBy(_ card: JSONObject?, _ viewer: String) -> [String] {
        let c = ProfileCard.normalize(card)
        var out = [String]()
        for key in items {
            if let it = c.object(key), !it.orgString("value").isEmpty, ProfileCard.visibleTo(it.orgString("audience"), viewer) { out.append(key) }
        }
        for (i, x) in (c.array("fields") ?? []).enumerated() {
            guard let f = x.objectValue, ProfileCard.visibleTo(f.orgString("audience"), viewer) else { continue }
            if !ProfileCard.cleanValue(f.orgString("type"), f.orgString("value")).isEmpty { out.append("field:\(i)") }
        }
        return out
    }

    /// What no one else sees: the items marked "only me".
    public static func onlyMe(_ card: JSONObject?) -> [String] {
        let room = seenBy(card, "room")
        return seenBy(card, "me").filter { !room.contains($0) }
    }

    /// {public: [keys], room: [keys], me: [keys only I see]} — the editor's and the settings' summary.
    public static func summary(_ card: JSONObject?) -> JSONObject {
        func list(_ a: [String]) -> JSON { .array(a.map { .string($0) }) }
        return JSONObject([("public", list(seenBy(card, "public"))), ("room", list(seenBy(card, "room"))), ("me", list(onlyMe(card)))])
    }

    /// What a tap on a sender's avatar shows (nil: nothing to show). Another
    /// member: only the view they sent the room, checked again as anything
    /// handed over (ProfileCard.normalizeShared — an item they did not share
    /// never reaches this phone). Me: my card as room members see it (never
    /// what is "only me").
    public static func senderView(_ sharedByThem: JSONObject?, _ myCard: JSONObject?, _ me: Bool) -> JSONObject? {
        let v = me ? myCard.map { ProfileCard.viewFor($0, "room") } : ProfileCard.normalizeShared(sharedByThem)
        return ProfileCard.isEmptyView(v) ? nil : v
    }
}
