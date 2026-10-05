// 6.7: the user's profile card, as the web keeps it — a port of android
// profile/ProfileCard.java (client/src/lib/profile/model.ts): a photo, a
// background, a public nickname, an about text and typed fields — each with
// its audience:
//
//   me      only me — sealed in the account vault's "card" slot
//   room    room members — end-to-end encrypted in the rooms (ProfileRoom)
//   public  on the server (/api/profile), readable by username
//
// The audiences nest (public ⊂ room). Every new item is "only me"; the public
// nickname is public once it is typed and saved. The same normalizers run
// over what the vault, the server or a member hands over.

import Foundation
import M5Core
import M5Crypto

/// The profile card and its views (android `profile/ProfileCard.java`).
public enum ProfileCard {
    public static let audiences = ["me", "room", "public"]
    public static let fieldTypes = ["name", "phone", "email", "address", "url", "social", "org", "birthday", "other"]

    public static let nicknameChars = 40, aboutChars = 600, labelChars = 32, valueChars = 200, addressChars = 300, fields = 24
    /// Decoded bytes of the re-encoded images (both keep a room frame under one data channel message).
    public static let avatarBytes = 40 * 1024, coverBytes = 72 * 1024
    public static let avatarPx = 256, coverW = 1200, coverH = 400
    /// Upper bound of a shared view's JSON (images base64-encoded).
    public static let sharedMaxChars = Int((Double(avatarBytes + coverBytes) * 4.0 / 3).rounded(.up)) + 40_000

    private static let phone = FnPattern("[+]?[0-9][0-9 ()./-]{2,30}")
    private static let email = FnPattern("[^ \\t\\n\\x{0B}\\f\\r@<>\"]{1,64}@[^ \\t\\n\\x{0B}\\f\\r@<>\"]{1,190}\\.[^ \\t\\n\\x{0B}\\f\\r@<>\".]{2,63}")
    private static let url = FnPattern("[hH][tT][tT][pP][sS]?://[^ \\t\\n\\x{0B}\\f\\r<>\"]{3,190}")
    private static let birthday = FnPattern("[0-9]{4}-[0-9]{2}-[0-9]{2}|--[0-9]{2}-[0-9]{2}|[0-9]{1,2}\\.[ \\t\\n\\x{0B}\\f\\r]?[0-9]{1,2}\\.([ \\t\\n\\x{0B}\\f\\r]?[0-9]{4})?")

    public static func isAudience(_ v: JSON?) -> Bool {
        if case .string(let s)? = v { return audiences.contains { Js.same($0, s) } }
        return false
    }

    /// Who may see an item marked `item` when the viewer is `viewer`.
    public static func visibleTo(_ item: String?, _ viewer: String?) -> Bool {
        if viewer == "me" { return true }
        if viewer == "room" { return item == "room" || item == "public" }
        return item == "public"
    }

    /* ------------------------------------------------------------ values */

    /// At most `max` code points.
    private static func cap(_ s: String, _ max: Int) -> String {
        let u = s.unicodeScalars
        if u.count <= max { return s }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: u.prefix(max))
        return String(out)
    }

    /// [\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]: control and bidi-override characters.
    private static func control(_ c: UInt16) -> Bool {
        c <= 0x08 || (c >= 0x0B && c <= 0x1F) || c == 0x7F || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069)
    }

    /// One line: no control or bidi-override characters, single spaces, capped.
    public static func cleanLine(_ v: JSON?, _ max: Int) -> String {
        guard case .string(let raw)? = v else { return "" }
        var out = [UInt16]()
        out.reserveCapacity(raw.utf16.count)
        // CONTROL out, [\t\n\r]+ → " ", \s{2,} → " " (Java's \s: what is left of it here is the space).
        for c in raw.utf16 where !control(c) {
            let x: UInt16 = c == 0x09 || c == 0x0A || c == 0x0D ? 0x20 : c
            if x == 0x20 && out.last == 0x20 { continue }
            out.append(x)
        }
        return cap(Js.string(out).javaTrimmed, max)
    }

    /// cleanLine for a string.
    public static func cleanLine(_ v: String, _ max: Int) -> String { cleanLine(.string(v), max) }

    /// Several lines (about, address): at most one empty line in a row, capped.
    public static func cleanText(_ v: JSON?, _ max: Int) -> String {
        guard case .string(let raw)? = v else { return "" }
        let u = Array(raw.utf16)
        var out = [UInt16]()
        out.reserveCapacity(u.count)
        var i = 0
        var newlines = 0
        while i < u.count {
            var c = u[i]
            // \r\n? → \n
            if c == 0x0D { c = 0x0A; if i + 1 < u.count && u[i + 1] == 0x0A { i += 1 } }
            i += 1
            if control(c) { continue }
            if c == 0x09 { c = 0x20 }
            // \n{3,} → \n\n
            if c == 0x0A { newlines += 1; if newlines > 2 { continue } } else { newlines = 0 }
            out.append(c)
        }
        return cap(Js.string(out).javaTrimmed, max)
    }

    /// cleanText for a string.
    public static func cleanText(_ v: String, _ max: Int) -> String { cleanText(.string(v), max) }

    static func base64Bytes(_ b64: [UInt16]) -> Int {
        let pad = b64.suffix(2).elementsEqual([0x3D, 0x3D]) ? 2 : b64.last == 0x3D ? 1 : 0
        return (b64.count * 3) / 4 - pad
    }

    /// A data: URL of a JPEG, PNG or WebP within `maxBytes`, else "".
    public static func cleanImage(_ v: JSON?, _ maxBytes: Int) -> String {
        guard case .string(let s)? = v else { return "" }
        let u = Array(s.utf16)
        if u.count > Int((Double(maxBytes) * 4.0 / 3).rounded(.up)) + 40 { return "" }
        // ^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$
        var data: ArraySlice<UInt16>?
        for t in ["jpeg", "png", "webp"] {
            let prefix = Array("data:image/\(t);base64,".utf16)
            if u.starts(with: prefix) { data = u[prefix.count...] }
        }
        guard let data else { return "" }
        var i = data.startIndex
        while i < data.endIndex {
            let c = data[i]
            if !((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2B || c == 0x2F) { break }
            i += 1
        }
        if i == data.startIndex || data.endIndex - i > 2 || data[i...].contains(where: { $0 != 0x3D }) { return "" }
        return base64Bytes(Array(data)) <= maxBytes ? s : ""
    }

    /// cleanImage for a string.
    public static func cleanImage(_ v: String, _ maxBytes: Int) -> String { cleanImage(.string(v), maxBytes) }

    /// A field's value checked by its type; "" when it is not one.
    public static func cleanValue(_ type: String, _ v: JSON?) -> String {
        if type == "address" || type == "other" { return cleanText(v, addressChars) }
        let s = cleanLine(v, valueChars)
        if s.isEmpty { return "" }
        switch type {
        case "phone": return phone.matches(s) ? s : ""
        case "email": return email.matches(s) ? s : ""
        // Shown as a link the viewer may open — never fetched by the app.
        case "url": return url.matches(s) ? s : ""
        case "birthday": return birthday.matches(s) ? s : ""
        default: return s
        }
    }

    /// cleanValue for a string.
    public static func cleanValue(_ type: String, _ v: String) -> String { cleanValue(type, .string(v)) }

    /// A new field's id: 12 random hex digits.
    public static func newFieldId() -> String { Crypto.hex(Crypto.random(6)) }

    private static func typeOf(_ v: JSON?) -> String {
        if case .string(let s)? = v, fieldTypes.contains(where: { Js.same($0, s) }) { return s }
        return "other"
    }

    /// ^[A-Za-z0-9_-]{1,24}$.
    private static func isFieldId(_ s: String) -> Bool {
        let u = s.utf16
        return !u.isEmpty && u.count <= 24 && u.allSatisfy(Commands.wordUnit)
    }

    /* -------------------------------------------------------------- card */

    private static func item(_ value: String, _ audience: String) -> JSON {
        .object(JSONObject([("value", .string(value)), ("audience", .string(audience))]))
    }

    /// An empty card: everything only for me; the nickname is meant to be public (typing one is the opt-in).
    public static func empty() -> JSONObject { normalize(JSONObject()) }

    private static func item(_ raw: JSON?, _ clean: (JSON?) -> String, _ fallback: String) -> JSON {
        let o = raw?.objectValue ?? JSONObject()
        let aud = o["audience"]
        return item(clean(o["value"]), isAudience(aud) ? aud!.stringValue! : fallback)
    }

    /// A card from anywhere (the vault, the editor): every value checked, unknown audiences are "me".
    public static func normalize(_ input: JSONObject?) -> JSONObject {
        let o = input ?? JSONObject()
        var out = [JSON]()
        var seen = Set<[UInt16]>()
        for x in o.array("fields") ?? [] {
            if out.count >= fields { break }
            let f = x.objectValue ?? JSONObject()
            let type = typeOf(f["type"])
            var id = f.orgString("id")
            if !isFieldId(id) || seen.contains(Array(id.utf16)) { id = newFieldId() }
            seen.insert(Array(id.utf16))
            let aud = f["audience"]
            // The editor keeps what is being typed; views drop what does not check out.
            let value = type == "address" || type == "other" ? cleanText(f["value"], addressChars) : cleanLine(f["value"], valueChars)
            out.append(.object(JSONObject([("id", .string(id)), ("type", .string(type)), ("label", .string(cleanLine(f["label"], labelChars))),
                                           ("value", .string(value)), ("audience", isAudience(aud) ? aud! : "me")])))
        }
        var card = JSONObject([
            ("v", 1),
            ("nickname", item(o["nickname"], { cleanLine($0, nicknameChars) }, "public")),
            ("about", item(o["about"], { cleanText($0, aboutChars) }, "me")),
            ("avatar", item(o["avatar"], { cleanImage($0, avatarBytes) }, "me")),
            ("cover", item(o["cover"], { cleanImage($0, coverBytes) }, "me")),
            ("fields", .array(out)),
            ("updatedAt", .int(Swift.max(0, o.orgLong("updatedAt")))),
        ])
        if o.orgBool("published") { card["published"] = true }
        return card
    }

    /* ------------------------------------------------------------- views */

    /// Two FNV-1a passes over a canonical text of the view: its cache key (not a security property).
    static func rev(_ view: JSONObject) -> String {
        var c = [UInt16]()
        func add(_ s: String) { c.append(contentsOf: s.utf16) }
        add(view.orgString("nickname")); c.append(0); add(view.orgString("about")); c.append(0)
        add(view.orgString("avatar")); c.append(0); add(view.orgString("cover"))
        for x in view.array("fields") ?? [] {
            let f = x.objectValue ?? JSONObject()
            c.append(1); add(f.orgString("type")); c.append(0); add(f.orgString("label")); c.append(0); add(f.orgString("value"))
        }
        var a: UInt32 = 0x811C_9DC5, b: UInt32 = 0x9747_B28C
        for ch in c {
            a = (a ^ UInt32(ch)) &* 0x0100_0193
            b = (b ^ UInt32(ch)) &* 0x0100_0193
            b ^= b >> 13
        }
        return hex8(a) + hex8(b)
    }

    private static func hex8(_ v: UInt32) -> String {
        let s = String(v, radix: 16)
        return String(repeating: "0", count: 8 - s.count) + s
    }

    private static func withRev(_ view: JSONObject) -> JSONObject { view.with("rev", .string(rev(view))) }

    /// What `viewer` sees of the card: room members get "room" and "public"
    /// items, the public only "public" ones, "me" (the preview) everything. A
    /// field whose value does not check out for its type is left out.
    public static func viewFor(_ card: JSONObject?, _ viewer: String) -> JSONObject {
        let c = normalize(card)
        var view = JSONObject([("v", 1)])
        for key in ["nickname", "about", "avatar", "cover"] {
            let it = c.object(key) ?? JSONObject()
            let value = it.orgString("value")
            if !value.isEmpty && visibleTo(it.orgString("audience"), viewer) { view[key] = .string(value) }
        }
        var out = [JSON]()
        for x in c.array("fields") ?? [] {
            let f = x.objectValue ?? JSONObject()
            if !visibleTo(f.orgString("audience"), viewer) { continue }
            let value = cleanValue(f.orgString("type"), f.orgString("value"))
            if !value.isEmpty {
                out.append(.object(JSONObject([("type", .string(f.orgString("type"))), ("label", .string(f.orgString("label"))), ("value", .string(value))])))
            }
        }
        view["fields"] = .array(out)
        view["updatedAt"] = .int(c.orgLong("updatedAt"))
        return withRev(view)
    }

    public static func isEmptyView(_ view: JSONObject?) -> Bool {
        guard let view else { return true }
        let f = view.array("fields")
        return view.orgString("nickname").isEmpty && view.orgString("about").isEmpty && view.orgString("avatar").isEmpty
            && view.orgString("cover").isEmpty && (f == nil || f!.isEmpty)
    }

    /// A view handed to us (a member's frame, the server's answer): rebuilt
    /// from checked values only, its rev recomputed. Nil when it is not a profile.
    public static func normalizeShared(_ input: JSON?) -> JSONObject? {
        guard case .object(let o)? = input else { return nil }
        // (The length is JSON.stringify's, as the web measures it.)
        if o.orgInt("v") != 1 || Js.stringify(input).utf16.count > sharedMaxChars { return nil }
        var out = [JSON]()
        for x in o.array("fields") ?? [] {
            if out.count >= fields { break }
            guard let f = x.objectValue else { continue }
            let type = typeOf(f["type"])
            let value = cleanValue(type, f["value"])
            if !value.isEmpty {
                out.append(.object(JSONObject([("type", .string(type)), ("label", .string(cleanLine(f["label"], labelChars))), ("value", .string(value))])))
            }
        }
        var view = JSONObject([("v", 1)])
        let nickname = cleanLine(o["nickname"], nicknameChars), about = cleanText(o["about"], aboutChars)
        let avatar = cleanImage(o["avatar"], avatarBytes), cover = cleanImage(o["cover"], coverBytes)
        if !nickname.isEmpty { view["nickname"] = .string(nickname) }
        if !about.isEmpty { view["about"] = .string(about) }
        if !avatar.isEmpty { view["avatar"] = .string(avatar) }
        if !cover.isEmpty { view["cover"] = .string(cover) }
        view["fields"] = .array(out)
        view["updatedAt"] = .int(Swift.max(0, o.orgLong("updatedAt")))
        return withRev(view)
    }

    /// The same for an object.
    public static func normalizeShared(_ input: JSONObject?) -> JSONObject? { normalizeShared(input.map(JSON.object)) }

    /// The name a room's name field starts with: the public nickname when one
    /// is set, else what it had. The user can still change it for the room.
    public static func prefill(_ card: JSONObject?, _ current: String?) -> String {
        let nick = card?.object("nickname")?.orgString("value").javaTrimmed ?? ""
        return nick.isEmpty ? (current ?? "") : nick
    }

    /// The view to publish on the server: the public view without its rev (the server keeps its own).
    public static func publicBody(_ card: JSONObject?) -> JSONObject { viewFor(card, "public").without("rev") }
}
