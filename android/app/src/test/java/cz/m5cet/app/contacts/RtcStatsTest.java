package cz.m5cet.app.contacts;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.math.BigInteger;
import java.util.HashMap;
import java.util.Map;

/** A peer connection's statistics as the People widget reads them (the shapes libwebrtc reports). */
public class RtcStatsTest {
    private static Map<String, Object> m(Object... kv) {
        Map<String, Object> out = new HashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) out.put((String) kv[i], kv[i + 1]);
        return out;
    }

    private static Map<String, RtcStats.Entry> report(boolean relay) {
        Map<String, RtcStats.Entry> all = new HashMap<>();
        all.put("T01", new RtcStats.Entry("transport", m("selectedCandidatePairId", "CP1", "dtlsState", "connected", "tlsVersion", "FEFD",
            "srtpCipher", "AES_CM_128_HMAC_SHA1_80", "bytesSent", BigInteger.valueOf(86_220), "bytesReceived", BigInteger.valueOf(93_800), "remoteCertificateId", "CFr")));
        all.put("CFr", new RtcStats.Entry("certificate", m("fingerprint", "3A:5F:00", "fingerprintAlgorithm", "sha-256")));
        all.put("CP0", new RtcStats.Entry("candidate-pair", m("localCandidateId", "Lx", "remoteCandidateId", "Rx", "state", "failed", "currentRoundTripTime", 0.9)));
        all.put("CP1", new RtcStats.Entry("candidate-pair", m("localCandidateId", "L1", "remoteCandidateId", "R1", "state", "succeeded", "nominated", true,
            "currentRoundTripTime", 0.0384, "bytesSent", BigInteger.valueOf(1), "bytesReceived", BigInteger.valueOf(2))));
        all.put("L1", new RtcStats.Entry("local-candidate", m("candidateType", relay ? "relay" : "host", "protocol", "udp", "relayProtocol", relay ? "tls" : null)));
        all.put("R1", new RtcStats.Entry("remote-candidate", m("candidateType", "srflx", "address", "203.0.113.7", "port", 51234)));
        all.put("IA", new RtcStats.Entry("inbound-rtp", m("kind", "audio", "codecId", "C111")));
        all.put("OV", new RtcStats.Entry("outbound-rtp", m("kind", "video", "codecId", "C96")));
        all.put("C111", new RtcStats.Entry("codec", m("mimeType", "audio/opus")));
        all.put("C96", new RtcStats.Entry("codec", m("mimeType", "video/VP8")));
        return all;
    }

    @Test
    public void theSelectedPair() {
        RtcStats.Summary s = RtcStats.parse(report(false), 7);
        assertEquals(38, s.rttMs);
        assertEquals("host", s.localType);
        assertEquals("srflx", s.remoteType);
        assertEquals("direct", s.transport());
        assertEquals("udp", s.protocol);
        assertEquals("203.0.113.7:51234", s.remoteAddress);
        assertEquals(86_220, s.bytesSent);
        assertEquals(93_800, s.bytesReceived);
        assertEquals("DTLS 1.2", s.dtlsVersion());
        assertEquals("AES_CM_128_HMAC_SHA1_80", s.srtpCipher);
        assertEquals("sha-256 3A:5F:00", s.dtlsFingerprint);
        assertEquals("opus · VP8", s.codecs());
        assertEquals(7, s.at);
    }

    @Test
    public void throughTurn() {
        RtcStats.Summary s = RtcStats.parse(report(true), 0);
        assertEquals("relay", s.transport());
        assertEquals("tls", s.relayProtocol);
    }

    @Test
    public void withoutTransportStatsTheNominatedWorkingPair() {
        Map<String, RtcStats.Entry> all = report(false);
        all.remove("T01");
        RtcStats.Summary s = RtcStats.parse(all, 0);
        assertEquals(38, s.rttMs);
        assertEquals(1, s.bytesSent);
        assertEquals("", s.dtlsState);
    }

    @Test
    public void theAverageWhenNoCurrentRoundTrip() {
        Map<String, RtcStats.Entry> all = new HashMap<>();
        all.put("CP", new RtcStats.Entry("candidate-pair", m("state", "succeeded", "nominated", true, "totalRoundTripTime", 0.3, "responsesReceived", 3)));
        assertEquals(100, RtcStats.parse(all, 0).rttMs);
    }

    @Test
    public void nothingYet() {
        RtcStats.Summary s = RtcStats.parse(new HashMap<>(), 0);
        assertEquals(-1, s.rttMs);
        assertEquals("", s.transport());
        assertEquals("", s.codecs());
        assertEquals(-1, RtcStats.parse(null, 0).rttMs);
    }

    @Test
    public void anIpv6Address() {
        Map<String, RtcStats.Entry> all = report(false);
        all.put("R1", new RtcStats.Entry("remote-candidate", m("candidateType", "host", "address", "2001:db8::1", "port", 9)));
        assertEquals("[2001:db8::1]:9", RtcStats.parse(all, 0).remoteAddress);
    }
}
