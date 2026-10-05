// The protocol-4 texts (android chat/P4Texts.java): from the design (the app's
// Texts provider), with these English words when the published design is
// older and does not have them yet.

import M5Core

public enum P4Texts {
    public static let en: [String: String] = [
        "p4.downgrade": "protocol downgrade refused — this device spoke protocol 4 before; its messages are not read",
        "p4.identityChanged": "identity changed — compare the safety number before you trust it",
        "p4.held": "identity changed — their messages are held until you verify them (People › Verify)",
        "p4.heldDropped": "{n} held messages were not shown (identity changed, not verified)",
        "p4.roomProof": "The server refused this device's proof that it holds the room key: another key is registered for this room on the server (someone may have claimed it first). Check the room name and passphrase with the others; the server's owner can reset the room's registration.",
        "p4.roomProofLegacy": "Another key is registered for this room on the server (someone who knew only its blind id may have claimed it first), so this device joined without proving it holds the room key — the others see it as unproven. Check the room name and passphrase with the others; the server's owner can reset the room's registration.",
        "p4.trust.otherName": "verified as {name} — now under another name",
        "p4.kt.checking": "being checked in the key-transparency log",
        "p4.kt.unchecked": "not yet checked in the key-transparency log",
        "p4.file.proxyP4": "{name} goes through the server — its key sealed for each member's devices (protocol 4)",
        "p4.file.proxyRoomKey": "{name} went through the server under the room key: a member's device could not be reached end to end",
        "p4.file.noKey": "A file through the server came without its key — it cannot be opened (ask the sender to send it again)",
        "p4.kt.alert.unknown-device": "A device this phone does not know was added to your account (key transparency). If it was not you, sign out everywhere and tell the server's operator.",
        "p4.kt.alert.account-key": "Another account key was registered for your account (key transparency).",
        "p4.kt.alert.unproven": "For a day the server has not proved that its key history continues the one this device saw (key transparency).",
        "p4.kt.dismiss": "Dismiss",
        "quote.held": "Held message — the sender's identity changed",
        "msginfo.state.relay-p4": "away — sealed for their devices (protocol 4)",
        "msginfo.state.relay-room": "away — under the room key (protocol 3)",
        "p4.roomProofRequired": "This server admits only members who prove they hold the room key; this room cannot prove it (it is joined by its plain name).",
        "p4.trust.new": "new key — not verified",
        "p4.trust.verified": "verified",
        "p4.trust.account": "account key — not verified",
        "p4.trust.changed": "identity changed",
        "p4.legacy": "older protocol (no PCS / PQ)",
        "p4.protocol4": "protocol 4 (PQ + PCS)",
        "p4.unproven": "did not prove the room key to the server",
        "p4.kt.alert.inconsistent": "The server shows a rewritten key history (key transparency).",
        "p4.kt.alert.split-view": "The server shows different key histories to different people (key transparency).",
        "p4.kt.alert.key-changed": "The server's key-transparency key changed.",
        "p4.kt.ok": "in the key-transparency log",
        "p4.kt.revoked": "revoked in the key-transparency log",
        "p4.kt.missing": "not in the key-transparency log",
        "p4.kt.unverifiable": "the key-transparency log could not be checked",
        "p4.legacyShort": "older protocol",
        "p4.clockAhead": "their device's clock runs about {min} min ahead — its messages show the time they arrived",
        "nfc.v2.kind.title": "How should the tag work?",
        "nfc.v2.kind.inv": "Invitation (recommended) — the room key stays on the server; the tag ends after 10 uses or 7 days",
        "nfc.v2.kind.off": "Offline — the room on the tag, opened with a code you give separately",
        "nfc.v2.preparing": "Preparing the tag…",
        "nfc.v2.code.title": "The tag's code",
        "nfc.v2.code.text": "Give this code to whoever may join — say it or write it down. It is not on the tag, nothing keeps it, and it is shown only now.",
        "nfc.v2.code.done": "I have it — write the tag",
        "nfc.v2.codeHint": "Code (new tags) or PIN (old tags)",
        "nfc.v2.invite": "Invitation tag",
        "nfc.v2.offline": "Offline tag",
        "nfc.v2.old": "Old connection tag (PIN)",
        "nfc.v2.weak": "Weak: anyone who has read this tag can guess its PIN offline. Rewrite it as a new tag.",
        "nfc.v2.rewrite": "Rewrite as a new tag",
        "nfc.v2.needCode": "Type the code you were given for this tag, then Open.",
        "nfc.v2.needPin": "Old tag: type its PIN, then Open.",
        "nfc.v2.needRedeem": "An invitation: Open asks the server (it uses one of the invitation's uses).",
        "nfc.v2.open": "Open",
        "nfc.v2.opening": "Opening the tag…",
        "nfc.v2.err.wrong-code": "Wrong code, or the tag was changed.",
        "nfc.v2.err.bad-code": "The code has 20 characters (letters and digits).",
        "nfc.v2.err.other-server": "This invitation is for another server ({origin}) — open M5cet there.",
        "nfc.v2.err.burned": "The invitation has been used up or ended.",
        "nfc.v2.err.not-found": "The invitation no longer exists (it expired or was ended).",
        "nfc.v2.err.network": "The server could not be reached.",
        "nfc.v2.err.bad-tag": "The tag is damaged or not a connection tag.",
        "nfc.v2.err.corrupt": "The invitation cannot be opened.",
        "p4.proven": "proved the room key",
    ]

    /// The design's text of `key`, else the English here, else the key.
    public static func t(_ key: String) -> String { Texts.t(key, en[key] ?? key) }

    /// A text with a count: its plural form, "{n}" filled in.
    public static func tn(_ key: String, _ n: Int64) -> String { Texts.n(key, n, en[key] ?? key) }
}
