// A notification's room, sealed for this process (Android security/IntentSeal,
// 6.10 G-23) — the tag itself is M5Crypto's `IntentSeal` (HMAC-SHA256 under a key
// that exists only in this process, base64url of 128 bits); this is how the app
// carries it in a notification's `userInfo` (or a link's query): the room under
// "room", the tag under "cz.m5cet.seal" (Android's extra). A forged action, or a
// tag from an earlier process, opens the app, not the room.

import Foundation
import M5Crypto

enum IntentSealUserInfo {
    /// The userInfo / query key that carries the tag (Android's extra "cz.m5cet.seal").
    static let key = "cz.m5cet.seal"

    /// A notification's userInfo for a room, sealed for a purpose (`IntentSeal.open` / `.reply`).
    static func userInfo(room: String, purpose: String) -> [String: String] {
        ["room": room, key: IntentSeal.tag(purpose, room)]
    }

    /// The room of a userInfo when its tag is this process's for the purpose; nil otherwise.
    static func room(from userInfo: [AnyHashable: Any], purpose: String) -> String? {
        let room = userInfo["room"] as? String
        return IntentSeal.valid(purpose, room, userInfo[key] as? String) ? room : nil
    }
}
