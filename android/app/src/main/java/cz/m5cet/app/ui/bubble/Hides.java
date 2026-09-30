package cz.m5cet.app.ui.bubble;

import java.util.concurrent.CopyOnWriteArrayList;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.security.Crypto;

/**
 * Hiding and deleting messages in this device's view (6.2). A hide lasts
 * 15 minutes, an hour, 8 hours, a day or until the next sign-in — the next
 * time the app is unlocked: such a hide names the unlock it was made in,
 * and every unlock (or a new start of the app) begins a new one. Deleting
 * takes the message out of this device's view and history, not anyone
 * else's. Both are logged for the operator's audit (MessageAudit).
 */
public final class Hides {
    private Hides() {}

    public static final long SIGNIN = ChatMessage.UNTIL_SIGNIN;
    /** The choices of the details view, in order; the timeline's meta names them. */
    public static final long[] FOR = {15 * 60_000L, 3_600_000L, 8 * 3_600_000L, 86_400_000L, SIGNIN};
    public static final String[] NAMES = {"15m", "1h", "8h", "1d", "signin"};

    public interface Listener { void onHidesChanged(); }

    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    /** The unlock the app is in now (never stored: a new start is a new one). */
    private static volatile String unlock = Crypto.b64url(Crypto.random(9));

    static {
        M5 app = M5.get();
        if (app != null) app.addListener(what -> {
            if (!"unlocked".equals(what)) return;
            unlock = Crypto.b64url(Crypto.random(9));
            for (Listener l : listeners) l.onHidesChanged();
            MessageAudit.flush(app);
        });
    }

    public static void addListener(Listener l) { if (!listeners.contains(l)) listeners.add(l); }
    public static void removeListener(Listener l) { listeners.remove(l); }

    /** Is the message hidden in this view now? */
    public static boolean hidden(ChatMessage m, long now) { return hidden(m, now, unlock); }

    static boolean hidden(ChatMessage m, long now, String currentUnlock) {
        if (m.hiddenUntil == SIGNIN) return currentUnlock.equals(m.hiddenFor);
        return m.hiddenUntil > now;
    }

    /** A hide that is over (its time passed, or the app was unlocked since): cleared, with its "unhidden" step. True when that happened. */
    public static boolean endIfOver(ChatMessage m, long now) {
        if (m.hiddenUntil == 0 || hidden(m, now)) return false;
        boolean signin = m.hiddenUntil == SIGNIN;
        m.mark("unhidden", signin ? "signin" : "time", signin ? now : m.hiddenUntil);
        m.hiddenUntil = 0;
        m.hiddenFor = null;
        return true;
    }

    /** When the next timed hide among these ends (Long.MAX_VALUE = none). */
    public static long nextEnd(Iterable<ChatMessage> messages, long now) {
        long next = Long.MAX_VALUE;
        for (ChatMessage m : messages) if (m.hiddenUntil > now) next = Math.min(next, m.hiddenUntil);
        return next;
    }

    /** Hides for FOR[choice]; logged. */
    public static void hide(M5 app, RoomSession r, ChatMessage m, int choice) {
        long span = FOR[Math.max(0, Math.min(FOR.length - 1, choice))];
        long until = span == SIGNIN ? SIGNIN : System.currentTimeMillis() + span;
        r.hide(m, until, unlock, NAMES[Math.max(0, Math.min(NAMES.length - 1, choice))]);
        MessageAudit.add(app, "hide", r, m, until == SIGNIN ? 0 : until);
    }

    /** Shows a hidden message again before its time; logged. */
    public static void unhide(M5 app, RoomSession r, ChatMessage m) {
        r.hide(m, 0, null, "user");
        MessageAudit.add(app, "unhide", r, m, 0);
    }

    /** Deletes it from this device (view and history); logged. */
    public static void delete(M5 app, RoomSession r, ChatMessage m) {
        MessageAudit.add(app, "delete", r, m, 0);
        r.deleteLocal(m);
    }
}
