package cz.m5cet.app.chat;

import android.provider.CallLog;

import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraVideoCapturer;
import org.webrtc.MediaConstraints;
import org.webrtc.RtpSender;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.util.Collections;

import cz.m5cet.app.core.Log;
import cz.m5cet.app.rtc.Rtc;
import cz.m5cet.app.telecom.CallLogBridge;

/**
 * Calls in a room, as the web client does them: no ringing — tracks are
 * added to the existing peer connections (perfect negotiation renegotiates)
 * and "audio-status" tells the others. Media is DTLS-SRTP end to end
 * between the phones; the extra frame encryption of browsers ("media" in
 * the hello) is not announced, so browsers talk to this app without it.
 * When the call ends, the phone's call log can record it (settings).
 */
public final class Calls {
    private final RoomSession room;
    private AudioSource audioSource;
    private AudioTrack audio;
    private VideoSource videoSource;
    private VideoTrack video;
    private CameraVideoCapturer camera;
    private SurfaceTextureHelper helper;
    private String state = "off";
    private long startedAt = 0;
    private boolean videoOn = false;

    public interface VideoListener { void onVideo(RoomSession room); }
    private static volatile VideoListener videoListener;
    public static void setVideoListener(VideoListener l) { videoListener = l; }

    Calls(RoomSession room) { this.room = room; }

    public String state() { return state; }
    public boolean video() { return videoOn; }
    public VideoTrack localVideo() { return video; }

    /** The remote video tracks for the call screen. */
    public java.util.List<VideoTrack> remoteVideos() {
        java.util.List<VideoTrack> out = new java.util.ArrayList<>();
        for (Peer p : room.peers.values()) if (p.remoteVideo != null) out.add(p.remoteVideo);
        return out;
    }

    /** Adds the live tracks to a new peer. */
    void attachLocal(Peer p) {
        if (audio != null) p.senders.add(p.pc.addTrack(audio, Collections.singletonList("m5cet")));
        if (video != null) p.senders.add(p.pc.addTrack(video, Collections.singletonList("m5cet")));
    }

    void onRemoteVideo(Peer p) {
        VideoListener l = videoListener;
        if (l != null) l.onVideo(room);
    }

    public void startAudio() {
        room.post(() -> {
            if (audio != null) return;
            audioSource = Rtc.factory().createAudioSource(new MediaConstraints());
            audio = Rtc.factory().createAudioTrack("m5-audio", audioSource);
            for (Peer p : room.peers.values()) if (p.pc != null) p.senders.add(p.pc.addTrack(audio, Collections.singletonList("m5cet")));
            state = "live";
            startedAt = System.currentTimeMillis();
            room.broadcastAudio("live");
            route();
            room.changed();
            Log.i("call", "audio on in " + room.logName());
        });
    }

    public void startVideo() {
        startAudio();
        room.post(() -> {
            if (video != null) return;
            Camera2Enumerator cams = new Camera2Enumerator(room.app);
            String front = null;
            for (String name : cams.getDeviceNames()) if (cams.isFrontFacing(name)) { front = name; break; }
            if (front == null && cams.getDeviceNames().length > 0) front = cams.getDeviceNames()[0];
            if (front == null) return;
            camera = cams.createCapturer(front, null);
            helper = SurfaceTextureHelper.create("m5-camera", Rtc.egl().getEglBaseContext());
            videoSource = Rtc.factory().createVideoSource(false);
            camera.initialize(helper, room.app, videoSource.getCapturerObserver());
            camera.startCapture(1280, 720, 30);
            video = Rtc.factory().createVideoTrack("m5-video", videoSource);
            for (Peer p : room.peers.values()) if (p.pc != null) p.senders.add(p.pc.addTrack(video, Collections.singletonList("m5cet")));
            videoOn = true;
            room.changed();
            VideoListener l = videoListener;
            if (l != null) l.onVideo(room);
        });
    }

    public void mute(boolean muted) {
        room.post(() -> {
            if (audio == null) return;
            audio.setEnabled(!muted);
            state = muted ? "muted" : "live";
            room.broadcastAudio(state);
            room.changed();
        });
    }

    /** Hangs up: removes the tracks (renegotiation follows) and logs the call. */
    public void stop() {
        room.post(() -> {
            boolean was = audio != null;
            for (Peer p : room.peers.values()) {
                for (RtpSender s : p.senders) { try { if (p.pc != null) p.pc.removeTrack(s); } catch (RuntimeException ignored) { } }
                p.senders.clear();
            }
            try { if (camera != null) camera.stopCapture(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            if (camera != null) { camera.dispose(); camera = null; }
            if (video != null) { video.dispose(); video = null; }
            if (videoSource != null) { videoSource.dispose(); videoSource = null; }
            if (helper != null) { helper.dispose(); helper = null; }
            if (audio != null) { audio.dispose(); audio = null; }
            if (audioSource != null) { audioSource.dispose(); audioSource = null; }
            if (was) {
                long seconds = (System.currentTimeMillis() - startedAt) / 1000;
                CallLogBridge.record(room.app, room.label, videoOn, CallLog.Calls.OUTGOING_TYPE, startedAt, seconds);
                room.broadcastAudio("off");
                Log.i("call", "call ended in " + room.logName() + " after " + seconds + " s");
            }
            videoOn = false;
            cameraOn = true;
            if (audioText) { audioText = false; cz.m5cet.app.voice.CallAudio.get().stop(); }
            state = "off";
            unroute();
            room.changed();
        });
    }

    /* ------------------------------------------------------- 6.1 */

    private boolean audioText = false;
    private boolean cameraOn = true;
    private boolean front = true;

    public boolean audioText() { return audioText; }
    public boolean cameraOn() { return video != null && cameraOn; }

    /**
     * An audio ↔ text call: the call's audio as usual for the others, but my
     * messages are spoken into it and what the others say comes as text.
     */
    public void startAudioText() {
        startAudio();
        room.post(() -> {
            audioText = true;
            cz.m5cet.app.voice.CallAudio.get().start((peerId, text, source) -> room.addTranscript(peerId, text, source));
            for (Peer p : new java.util.ArrayList<>(room.peers.values())) if (p.remoteAudio != null) cz.m5cet.app.voice.CallAudio.get().listen(room.app, p.id, p.remoteAudio);
            room.changed();
        });
        route();
    }

    void onRemoteAudio(Peer p) {
        if (audioText) cz.m5cet.app.voice.CallAudio.get().listen(room.app, p.id, p.remoteAudio);
    }

    /** Camera on / off in a video call (the track is disabled: black frames, no renegotiation — like the web). */
    public void toggleCamera() {
        room.post(() -> {
            if (video == null) return;
            cameraOn = !cameraOn;
            video.setEnabled(cameraOn);
            room.changed();
        });
    }

    /** Front / back camera. */
    public void switchCamera() {
        room.post(() -> {
            if (camera == null) return;
            camera.switchCamera(new CameraVideoCapturer.CameraSwitchHandler() {
                @Override public void onCameraSwitchDone(boolean isFront) { front = isFront; }
                @Override public void onCameraSwitchError(String e) { Log.w("call", "camera switch: " + e); }
            });
        });
    }

    /** Speaker or earpiece (Settings › Calls › Speaker; video calls always use the speaker). */
    public void route() {
        android.media.AudioManager am = room.app.getSystemService(android.media.AudioManager.class);
        if (am == null) return;
        boolean speaker = videoOn || room.app.settings.bool("calls.speaker");
        try {
            am.setMode(android.media.AudioManager.MODE_IN_COMMUNICATION);
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                int want = speaker ? android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                for (android.media.AudioDeviceInfo d : am.getAvailableCommunicationDevices()) if (d.getType() == want) { am.setCommunicationDevice(d); return; }
            } else {
                am.setSpeakerphoneOn(speaker);
            }
        } catch (RuntimeException e) { Log.w("call", "audio route: " + e.getMessage()); }
    }

    private void unroute() {
        android.media.AudioManager am = room.app.getSystemService(android.media.AudioManager.class);
        if (am == null) return;
        try {
            if (android.os.Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
            am.setMode(android.media.AudioManager.MODE_NORMAL);
        } catch (RuntimeException ignored) { }
    }

    /** Tells a peer whose channel just opened how we are in the call ("off" too, like the web). */
    void announce() {
        room.broadcastAudio(state);
    }

    /** A peer's audio-status: "off" ends its video tile. */
    void onPeerAudio(Peer p, String status) {
        if ("off".equals(status) && p.remoteVideo != null) {
            p.remoteVideo = null;
            VideoListener l = videoListener;
            if (l != null) l.onVideo(room);
        }
    }
}
