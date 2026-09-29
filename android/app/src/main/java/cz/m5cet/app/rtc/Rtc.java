package cz.m5cet.app.rtc;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;

/**
 * One WebRTC factory for the app (audio device, video codecs on the GPU
 * where the phone has them) and the ICE servers from /api/turn — refreshed
 * before short-lived TURN credentials expire.
 */
public final class Rtc {
    private Rtc() {}

    private static PeerConnectionFactory factory;
    private static EglBase egl;
    private static List<PeerConnection.IceServer> ice;
    private static long iceUntil = 0;

    public static synchronized EglBase egl() {
        if (egl == null) egl = EglBase.create();
        return egl;
    }

    public static synchronized PeerConnectionFactory factory() {
        if (factory != null) return factory;
        M5 app = M5.get();
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions());
        JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(app)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            // 6.1: audio ↔ text calls replace the microphone with speech (CallAudio).
            .setAudioBufferCallback((buffer, format, channels, rate, bytes, ts) -> cz.m5cet.app.voice.CallAudio.get().onCapture(buffer, format, channels, rate, bytes, ts))
            .createAudioDeviceModule();
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl().getEglBaseContext(), true, true))
            .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl().getEglBaseContext()))
            .createPeerConnectionFactory();
        Log.i("rtc", "WebRTC ready");
        return factory;
    }

    /** The server's ICE servers (STUN, TURN with fresh credentials), cached until shortly before they expire. */
    public static synchronized List<PeerConnection.IceServer> iceServers() {
        if (ice != null && System.currentTimeMillis() < iceUntil) return ice;
        List<PeerConnection.IceServer> out = new ArrayList<>();
        long until = System.currentTimeMillis() + 10 * 60_000;
        try {
            JSONObject answer = M5.get().server.turn();
            JSONArray servers = answer.optJSONArray("iceServers");
            if (servers != null) for (int i = 0; i < servers.length(); i++) {
                JSONObject s = servers.getJSONObject(i);
                List<String> urls = new ArrayList<>();
                Object u = s.opt("urls");
                if (u instanceof JSONArray) for (int j = 0; j < ((JSONArray) u).length(); j++) urls.add(((JSONArray) u).getString(j));
                else if (u != null) urls.add(String.valueOf(u));
                if (urls.isEmpty()) continue;
                PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
                if (s.has("username")) b.setUsername(s.optString("username"));
                if (s.has("credential")) b.setPassword(s.optString("credential"));
                out.add(b.createIceServer());
            }
            long ttl = answer.optLong("ttlSeconds", 0);
            if (ttl > 120) until = System.currentTimeMillis() + (ttl - 60) * 1000;
        } catch (Exception e) {
            Log.w("rtc", "no ICE servers from the server: " + e.getMessage());
        }
        if (out.isEmpty()) out.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        ice = out;
        iceUntil = until;
        return out;
    }

    /** How many ICE servers the server gave (the settings' connection info). */
    public static synchronized int iceCount() { return ice == null ? 0 : ice.size(); }

    public static PeerConnection.RTCConfiguration config() {
        PeerConnection.RTCConfiguration c = new PeerConnection.RTCConfiguration(iceServers());
        c.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        c.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
        c.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
        c.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE;
        // Perfect negotiation: the polite side rolls back its own offer when both offer at once (the web relies on it).
        c.enableImplicitRollback = true;
        return c;
    }
}
