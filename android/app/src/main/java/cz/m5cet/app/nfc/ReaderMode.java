package cz.m5cet.app.nfc;

import android.app.Activity;
import android.nfc.NfcAdapter;
import android.os.Bundle;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Who holds the activity's reader mode (6.6). Android gives an activity ONE
 * reader-mode callback; the workbench, the card builder and the connection-card
 * panel each take it in turn (the newest wins, as before), and a Functions
 * model's read (ModelNfc) borrows it for a moment. Every owner goes through
 * here, so when the borrowed read lets go the owner under it gets reader mode
 * back — a model's read never leaves the workbench's scan switched off.
 *
 * {@link #borrow} stays on top until {@link #release}: an owner that asks while a
 * model's read is waiting is queued under it and gets reader mode when the read
 * is over. Card emulation (CardService) is not touched — the platform pauses it
 * while reader mode is on and resumes it after.
 */
public final class ReaderMode {
    private ReaderMode() {}

    private static final class Entry {
        final Object owner;
        final NfcAdapter.ReaderCallback callback;
        final int flags;
        final Bundle extras;
        final boolean borrowed;
        Entry(Object owner, NfcAdapter.ReaderCallback callback, int flags, Bundle extras, boolean borrowed) {
            this.owner = owner; this.callback = callback; this.flags = flags; this.extras = extras; this.borrowed = borrowed;
        }
    }

    private static final Map<Activity, List<Entry>> STACKS = new WeakHashMap<>();

    /** An owner takes reader mode (below a borrowed read, if one is waiting). */
    public static void enable(Activity a, Object owner, NfcAdapter.ReaderCallback cb, int flags, Bundle extras) {
        push(a, new Entry(owner, cb, flags, extras, false));
    }

    /** A model's read takes reader mode above everyone until it releases it. */
    public static void borrow(Activity a, Object owner, NfcAdapter.ReaderCallback cb, int flags, Bundle extras) {
        push(a, new Entry(owner, cb, flags, extras, true));
    }

    /** The owner lets go; reader mode goes back to the one before it, or off. */
    public static void release(Activity a, Object owner) {
        Entry top;
        synchronized (STACKS) {
            List<Entry> s = STACKS.get(a);
            if (s == null || s.isEmpty()) { top = null; }
            else {
                boolean wasTop = s.get(s.size() - 1).owner == owner;
                if (!remove(s, owner)) return;
                if (!wasTop) return;
                top = s.isEmpty() ? null : s.get(s.size() - 1);
            }
        }
        apply(a, top);
    }

    /** Whether this owner has reader mode now. */
    public static boolean holds(Activity a, Object owner) {
        synchronized (STACKS) {
            List<Entry> s = STACKS.get(a);
            return s != null && !s.isEmpty() && s.get(s.size() - 1).owner == owner;
        }
    }

    private static void push(Activity a, Entry e) {
        Entry top;
        synchronized (STACKS) {
            List<Entry> s = STACKS.get(a);
            if (s == null) { s = new ArrayList<>(); STACKS.put(a, s); }
            remove(s, e.owner);
            // One owner at a time, as before: a new one replaces the last (which lost
            // reader mode on the platform too); only a borrowed read sits above it.
            if (!e.borrowed) s.removeIf(x -> !x.borrowed);
            int at = s.size();
            if (!e.borrowed) while (at > 0 && s.get(at - 1).borrowed) at--;   // queue under a borrowed read
            s.add(at, e);
            if (at != s.size() - 1) return;
            top = e;
        }
        apply(a, top);
    }

    private static boolean remove(List<Entry> s, Object owner) {
        for (int i = s.size() - 1; i >= 0; i--) if (s.get(i).owner == owner) { s.remove(i); return true; }
        return false;
    }

    private static void apply(Activity a, Entry top) {
        NfcAdapter n = NfcAdapter.getDefaultAdapter(a);
        if (n == null) return;
        try {
            if (top == null) n.disableReaderMode(a);
            else n.enableReaderMode(a, top.callback, top.flags, top.extras);
        } catch (RuntimeException ignored) { /* the activity is going away */ }
    }
}
