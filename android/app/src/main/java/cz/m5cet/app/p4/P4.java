package cz.m5cet.app.p4;

/**
 * Protocol 4 (M5cet 6.12) — the constants every implementation shares
 * (client/src/lib/p4/contract.ts; normative text docs/protocol-v4.md). This
 * package is the Java port of the web reference library, checked byte for
 * byte against test/vectors/p4.json. Pure Java and Bouncy Castle's
 * lightweight API (ML-KEM-768, Ed25519): the JVM tests run the same code.
 */
public final class P4 {
    private P4() {}

    public static final int VERSION = 4;
    /** The capability a protocol-4 client lists in its hello `caps`. */
    public static final String CAP = "p4";

    /* ------------------------------------------------------------- labels */

    public static final String L_HELLO = "m5cet/hello/4";
    public static final String L_TRANSCRIPT = "m5cet/p4/th";
    public static final String L_ROOT = "m5cet/p4/root";
    public static final String L_RATCHET = "m5cet/p4/rk";
    public static final String L_PAIR_KEY = "m5cet/p4/mk";
    public static final String L_PAIR_AAD = "m5cet/p4/pair";
    public static final String L_SENDER_KEY = "m5cet/p4/sk";
    public static final String L_MAILBOX_BUNDLE = "m5cet/mb/4";
    public static final String L_MAILBOX = "m5cet/p4/mb";
    public static final String L_FILE = "m5cet/p4/file";
    public static final String L_FILE_META = "m5cet/p4/file-meta";
    public static final String L_FILE_CHUNK = "m5cet/p4/chunk";
    public static final String L_FILE_END = "m5cet/p4/file-end";
    public static final String L_MEDIA = "m5cet/p4/media";
    public static final String L_HUB_SEED = "m5cet/hub-auth/4";
    public static final String L_HUB_JOIN = "m5cet/hub-join/4";
    public static final String L_DEVICE_CERT = "m5cet/device-cert/2";
    public static final String L_KT_USER = "m5cet/kt/user|";
    public static final String L_KT_STH = "m5cet/kt/sth/4";
    public static final String L_REPLAY = "m5cet/p4/seen";
    public static final String L_SK_CERT = "m5cet/sk-cert/4";

    /* ------------------------------------------------------------- limits */

    /** Skipped message keys kept per chain (pair ratchet and sender keys). */
    public static final int MAX_SKIP = 1_000;
    /** Skipped message keys kept per pair session in total. */
    public static final int MAX_SKIPPED_TOTAL = 2_000;
    /** A sender-key chain is replaced after this many messages or this long. */
    public static final int SENDER_KEY_ROTATE_MESSAGES = 100;
    public static final long SENDER_KEY_ROTATE_MS = 15 * 60 * 1000L;
    public static final long MAILBOX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000L;
    public static final long MAILBOX_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000L;
    public static final long MAILBOX_KEEP_MS = 31 * 24 * 60 * 60 * 1000L;
    public static final long DEVICE_CERT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000L;
    public static final long REPLAY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000L;
    public static final long REPLAY_FUTURE_MS = 5 * 60 * 1000L;
    public static final int REPLAY_MAX_IDS_PER_ROOM = 50_000;
    /** Padding buckets (bytes, padded length INCLUDING the 0x80 marker); above the last, multiples of it. */
    public static final int[] PAD_BUCKETS = {256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536};

    /** ML-KEM-768 sizes (FIPS 203). */
    public static final int KEM_EK = 1184, KEM_DK = 2400, KEM_CT = 1088, KEM_SS = 32, KEM_SEED = 64;
}
