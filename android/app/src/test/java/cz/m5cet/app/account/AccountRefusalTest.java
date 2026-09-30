package cz.m5cet.app.account;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** 6.4.1: a server that would not accept this build's origin says so before the passkey exists. */
public class AccountRefusalTest {
    @Test public void appNotTrustedReadsAsRpUnverified() {
        assertEquals("rp-unverified", Account.refusalCode("app-not-trusted"));
    }

    @Test public void otherRefusalsKeepTheirGenericHandling() {
        assertEquals("", Account.refusalCode(""));
        assertEquals("", Account.refusalCode(null));
        assertEquals("", Account.refusalCode("taken"));
        assertEquals("", Account.refusalCode("origin-not-allowed"));
    }

    @Test public void onlyServerRefusalsAreMapped() {
        assertEquals("", Account.codeOf(new java.io.IOException("offline")));
        assertEquals("", Account.codeOf(new IllegalStateException("x")));
    }
}
