package cz.m5cet.app.p4;

import java.security.GeneralSecurityException;

/**
 * Why a protocol-4 operation refused its input (primitives.ts P4Error). The
 * codes are stable (tests, UI, the reset reason): malformed, aead, kct, skip,
 * replay, signature, no-chain, expired, wiped, id-mismatch, state.
 */
public final class P4Error extends GeneralSecurityException {
    public final String code;

    public P4Error(String code) { this(code, code); }

    public P4Error(String code, String message) {
        super(message);
        this.code = code;
    }

    static P4Error malformed(String message) { return new P4Error("malformed", message); }
}
