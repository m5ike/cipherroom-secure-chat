package cz.m5cet.app.telecom;

/**
 * 6.12 (security analysis G-22, the rest): what the phone's lock screen shows
 * of a message notification.
 *
 *   VISIBILITY_SECRET   nothing at all (not even "New message"): when the
 *                       person chose "Hide on the lock screen"
 *                       (notify.lockScreenHide), and always while the app
 *                       itself is locked — its notifications are neutral then
 *                       anyway, and now they do not appear on a locked phone
 *   VISIBILITY_PRIVATE  otherwise, as before 6.12: the neutral public version
 *                       where the phone hides sensitive content, the
 *                       notification itself where it shows everything (the
 *                       system's default) — that is, while the app is unlocked
 *                       the lock screen can show a message, like other
 *                       messengers do
 * A call's ring and a missed call stay PRIVATE: a ring must be answerable from
 * the lock screen (its text is neutral while the app is locked).
 *
 * Pure: LockScreenTest.
 */
public final class LockScreen {
    private LockScreen() {}

    /** The person's switch (Settings › Notifications). */
    public static final String SETTING = "notify.lockScreenHide";

    /** A call's ring or a missed call (a notification's kind, or its neutral text's key). */
    static boolean call(String kind) {
        return "call".equals(kind) || "ring.call".equals(kind) || "ring.missed".equals(kind);
    }

    /** Whether a notification of this kind stays off the phone's lock screen (VISIBILITY_SECRET). */
    public static boolean secret(String kind, boolean appLocked, boolean userHides) {
        if (call(kind)) return false;
        return userHides || appLocked;
    }
}
