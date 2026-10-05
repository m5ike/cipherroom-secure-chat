// Values the app takes only from its own notifications and links (Android
// security/IntentSeal, 6.10 G-23): a notification's room (open it, reply into
// it) travels with a tag — HMAC-SHA256 under a key that exists only in this
// process (made at its start, never stored) over what the value is for and the
// value. Another app cannot make one (an m5cet:// link, a forged notification
// action's userInfo), and a tag fits only its own value and purpose. A tag from an
// earlier process is no longer valid: its notification opens the app, not the room.
//
// Tag: base64url(HMAC-SHA256(key, "m5cet/intent\0" + purpose + "\0" + value)[0..16]) — Android's.

import Foundation

enum PayloadSeal {
    /// The userInfo / query key that carries the tag (Android's extra "cz.m5cet.seal").
    static let key = "cz.m5cet.seal"
    /// What a tag is for: a notification opening its room, a reply into one.
    static let open = "open", reply = "reply"

    private static let processKey = Bytes.random(32)

    /// The tag of a value for a purpose under a key: 128 bits of HMAC-SHA256, base64url.
    static func tag(key: Data, purpose: String, value: String) -> String {
        let mac = SecCrypto.hmac(key: key, Bytes.utf8("m5cet/intent\u{0}" + purpose + "\u{0}" + value))
        return Bytes.b64url(mac.prefix(16))
    }

    /// Whether a tag is this key's for the purpose and value (constant time).
    static func valid(key: Data, purpose: String?, value: String?, tag: String?) -> Bool {
        guard let purpose, let value, let tag, !value.isEmpty else { return false }
        return Bytes.same(Bytes.utf8(self.tag(key: key, purpose: purpose, value: value)), Bytes.utf8(tag))
    }

    /// This process's tag of a value.
    static func tag(_ purpose: String, _ value: String) -> String { tag(key: processKey, purpose: purpose, value: value) }

    /// Whether the tag is this process's for the purpose and value.
    static func valid(_ purpose: String?, _ value: String?, tag: String?) -> Bool {
        valid(key: processKey, purpose: purpose, value: value, tag: tag)
    }

    /// A notification's userInfo for a room, sealed for a purpose.
    static func userInfo(room: String, purpose: String) -> [String: String] { ["room": room, key: tag(purpose, room)] }

    /// The room of a userInfo when its tag is this process's for the purpose; nil otherwise.
    static func room(from userInfo: [AnyHashable: Any], purpose: String) -> String? {
        let room = userInfo["room"] as? String
        return valid(purpose, room, tag: userInfo[key] as? String) ? room : nil
    }
}
