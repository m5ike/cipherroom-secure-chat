// What the phone's lock screen shows of a message notification (Android
// telecom/LockScreen, 6.12 — security analysis G-22).
//
// Android: VISIBILITY_SECRET (nothing at all) when the person chose "Hide on the
// lock screen" (notify.lockScreenHide) and always while the app itself is locked;
// otherwise VISIBILITY_PRIVATE. A call's ring and a missed call stay (a ring must
// be answerable from the lock screen; its text is neutral while the app is locked).
//
// iOS has no per-notification lock-screen visibility: the person's system setting
// "Show Previews" decides (Always / When Unlocked — the default — / Never), and a
// category's hiddenPreviewsBodyPlaceholder is what a hidden preview shows. So a
// notification that Android would keep SECRET is posted with neutral text when
// previews show on the lock screen (Always) — what a locked phone shows then says
// nothing — and as it is otherwise (the system hides its preview there itself).
// While the app is locked the text is neutral anyway (Notify, S11).
//
// Shared: compiled into the app and, through a symlink, into M5cetNotifications.

import Foundation

enum LockScreen {
    /// The person's switch (Settings › Notifications).
    static let setting = "notify.lockScreenHide"

    /// A call's ring or a missed call (a notification's kind, or its neutral text's key).
    static func call(_ kind: String) -> Bool { kind == "call" || kind == "ring.call" || kind == "ring.missed" }

    /// Whether Android keeps a notification of this kind off the phone's lock screen (VISIBILITY_SECRET).
    static func secret(_ kind: String, appLocked: Bool, userHides: Bool) -> Bool {
        if call(kind) { return false }
        return userHides || appLocked
    }

    /// iOS: whether such a notification must carry only neutral text — Android's SECRET where the
    /// system would show its preview on a locked phone (`previewsAlways`: Show Previews = Always).
    static func neutralText(_ kind: String, appLocked: Bool, userHides: Bool, previewsAlways: Bool) -> Bool {
        if appLocked && !call(kind) { return true }
        return secret(kind, appLocked: appLocked, userHides: userHides) && previewsAlways
    }
}
