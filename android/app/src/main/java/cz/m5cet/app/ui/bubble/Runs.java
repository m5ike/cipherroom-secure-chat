package cz.m5cet.app.ui.bubble;

import cz.m5cet.app.chat.ChatMessage;

/**
 * 6.10: messages in a run. A received message that follows one from the
 * same person within a few minutes continues their run ($msg.cont): the
 * design leaves out its avatar and name (a gap as wide as the avatar keeps
 * the bubbles in line), so the avatar — at the top of its row — marks where
 * a person starts talking. A notice, my own message, another person or a
 * pause starts a new run. Pure.
 */
public final class Runs {
    private Runs() {}

    /** A pause this long (ms) starts a new run. */
    public static final long GAP_MS = 5 * 60_000L;

    /** Does `cur` continue the run of `prev` (the message shown just above it)? */
    public static boolean continues(ChatMessage prev, ChatMessage cur) {
        if (prev == null || cur == null) return false;
        if ("sys".equals(prev.kind) || "sys".equals(cur.kind)) return false;
        // 6.11: a model's answer is its own run (never the asker's): only the same model's answers continue it.
        String pm = ModelFace.runKey(prev), cm = ModelFace.runKey(cur);
        if (pm != null || cm != null) return pm != null && pm.equals(cm) && cur.createdAt - prev.createdAt >= 0 && cur.createdAt - prev.createdAt <= GAP_MS;
        if (prev.mine != cur.mine) return false;
        if (prev.senderId == null || prev.senderId.isEmpty() || !prev.senderId.equals(cur.senderId)) return false;
        long gap = cur.createdAt - prev.createdAt;
        return gap >= 0 && gap <= GAP_MS;
    }
}
