package cz.m5cet.app.contacts;

import java.util.Locale;
import java.util.Map;

/**
 * 6.2 People: what a peer connection's statistics (WebRTC getStats) say about
 * the link — the round trip of the pair in use, the candidates (direct or
 * through TURN), the codecs of a call, the bytes and the DTLS state. Read
 * from plain maps (type + members per stats id) so it is testable without
 * WebRTC; the room turns an RTCStatsReport into them.
 */
public final class RtcStats {
    private RtcStats() {}

    /** One stats object: its type ("candidate-pair", "transport", "codec"…) and members. */
    public static final class Entry {
        public final String type;
        public final Map<String, Object> members;
        public Entry(String type, Map<String, Object> members) { this.type = type == null ? "" : type; this.members = members; }
        String str(String k) { Object v = members == null ? null : members.get(k); return v == null ? "" : String.valueOf(v); }
        double num(String k, double d) { Object v = members == null ? null : members.get(k); return v instanceof Number ? ((Number) v).doubleValue() : d; }
        boolean bool(String k) { Object v = members == null ? null : members.get(k); return Boolean.TRUE.equals(v); }
    }

    /** What the People widget and the person's detail show. */
    public static final class Summary {
        /** The round trip of the pair in use, ms; -1 when not measured yet. */
        public long rttMs = -1;
        /** host / srflx / prflx / relay */
        public String localType = "", remoteType = "";
        /** udp / tcp (and the relay's own protocol when relayed) */
        public String protocol = "", relayProtocol = "";
        public String remoteAddress = "";
        public String audioCodec = "", videoCodec = "";
        public long bytesSent = 0, bytesReceived = 0;
        public String dtlsState = "", srtpCipher = "", tlsVersion = "";
        /** The peer's DTLS certificate fingerprint ("sha-256 AB:CD:…"). */
        public String dtlsFingerprint = "";
        public final long at;
        public Summary(long at) { this.at = at; }

        /** "direct", "relay" or "" (Presence.transport). */
        public String transport() { return Presence.transport(localType, remoteType); }

        /** The DTLS version from the stats' hex form ("FEFD" = DTLS 1.2), "" when unknown. */
        public String dtlsVersion() {
            switch (tlsVersion.toUpperCase(Locale.ROOT)) {
                case "FEFC": return "DTLS 1.3";
                case "FEFD": return "DTLS 1.2";
                case "FEFF": return "DTLS 1.0";
                default: return tlsVersion.isEmpty() ? "" : "DTLS " + tlsVersion;
            }
        }

        /** The codecs of a call ("opus", "opus · VP8"), "" without one. */
        public String codecs() {
            if (audioCodec.isEmpty()) return videoCodec;
            return videoCodec.isEmpty() ? audioCodec : audioCodec + " · " + videoCodec;
        }
    }

    public static Summary parse(Map<String, Entry> all, long now) {
        Summary s = new Summary(now);
        if (all == null) return s;
        Entry transport = null;
        for (Entry e : all.values()) if (e.type.equals("transport") && (transport == null || !e.str("selectedCandidatePairId").isEmpty())) transport = e;
        Entry pair = transport == null ? null : all.get(transport.str("selectedCandidatePairId"));
        if (pair == null) {
            // No transport stats: the nominated, working pair (the "selected" flag of older libraries wins).
            for (Entry e : all.values()) {
                if (!e.type.equals("candidate-pair")) continue;
                boolean ok = e.bool("selected") || (e.bool("nominated") && "succeeded".equals(e.str("state")));
                if (ok && (pair == null || e.bool("selected"))) pair = e;
            }
        }
        if (pair != null) {
            double rtt = pair.num("currentRoundTripTime", -1);
            if (rtt < 0) {
                double total = pair.num("totalRoundTripTime", -1), n = pair.num("responsesReceived", 0);
                if (total >= 0 && n > 0) rtt = total / n;
            }
            if (rtt >= 0) s.rttMs = Math.round(rtt * 1000);
            Entry local = all.get(pair.str("localCandidateId")), remote = all.get(pair.str("remoteCandidateId"));
            if (local != null) {
                s.localType = local.str("candidateType");
                s.protocol = local.str("protocol");
                s.relayProtocol = local.str("relayProtocol");
            }
            if (remote != null) {
                s.remoteType = remote.str("candidateType");
                String addr = remote.str("address").isEmpty() ? remote.str("ip") : remote.str("address");
                double port = remote.num("port", -1);
                s.remoteAddress = addr.isEmpty() ? "" : port > 0 ? (addr.contains(":") ? "[" + addr + "]" : addr) + ":" + (long) port : addr;
            }
            s.bytesSent = (long) pair.num("bytesSent", 0);
            s.bytesReceived = (long) pair.num("bytesReceived", 0);
        }
        if (transport != null) {
            s.dtlsState = transport.str("dtlsState");
            s.srtpCipher = transport.str("srtpCipher");
            s.tlsVersion = transport.str("tlsVersion");
            if (transport.num("bytesSent", -1) >= 0) s.bytesSent = (long) transport.num("bytesSent", 0);
            if (transport.num("bytesReceived", -1) >= 0) s.bytesReceived = (long) transport.num("bytesReceived", 0);
            Entry cert = all.get(transport.str("remoteCertificateId"));
            if (cert != null && !cert.str("fingerprint").isEmpty()) s.dtlsFingerprint = (cert.str("fingerprintAlgorithm") + " " + cert.str("fingerprint")).trim();
        }
        for (Entry e : all.values()) {
            if (!e.type.equals("inbound-rtp") && !e.type.equals("outbound-rtp")) continue;
            Entry codec = all.get(e.str("codecId"));
            if (codec == null) continue;
            String mime = codec.str("mimeType");
            String name = mime.contains("/") ? mime.substring(mime.indexOf('/') + 1) : mime;
            if (name.isEmpty()) continue;
            String kind = e.str("kind").isEmpty() ? e.str("mediaType") : e.str("kind");
            if (kind.equals("audio") && s.audioCodec.isEmpty()) s.audioCodec = name.toLowerCase(Locale.ROOT).equals("opus") ? "opus" : name;
            if (kind.equals("video") && s.videoCodec.isEmpty()) s.videoCodec = name;
        }
        return s;
    }
}
