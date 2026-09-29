package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.VideoTrack;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.core.Log;
import cz.m5cet.app.rtc.Rtc;

/**
 * One peer of a room: a WebRTC connection with the "m5cet" data channel
 * (ordered), and perfect negotiation exactly as the web client does it —
 * whoever changes the session offers; on a collision the initiator (the one
 * who joined later) ignores the other offer and the other side rolls back.
 * Every callback is handed to the room's own thread.
 */
final class Peer {
    final RoomSession room;
    final String id;
    String name;
    final boolean initiator;
    PeerConnection pc;
    DataChannel channel;
    boolean makingOffer;
    boolean ignoreOffer;
    String status = "connecting";
    String audio = "off";
    String publicKey;
    boolean verified;
    boolean changed;
    final List<RtpSender> senders = new ArrayList<>();
    VideoTrack remoteVideo;
    /** 6.1: the peer's audio (audio ↔ text calls transcribe it). */
    org.webrtc.AudioTrack remoteAudio;

    Peer(RoomSession room, String id, String name, boolean initiator) {
        this.room = room;
        this.id = id;
        this.name = name;
        this.initiator = initiator;
    }

    void start() {
        pc = Rtc.factory().createPeerConnection(Rtc.config(), new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState s) { }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) { }
            @Override public void onIceConnectionReceivingChange(boolean b) { }
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) { }
            @Override public void onIceCandidate(IceCandidate c) {
                room.post(() -> {
                    try { room.sendSignal(id, new JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)); }
                    catch (JSONException ignored) { }
                });
            }
            @Override public void onIceCandidatesRemoved(IceCandidate[] cs) { }
            @Override public void onAddStream(MediaStream s) { }
            @Override public void onRemoveStream(MediaStream s) { }
            @Override public void onDataChannel(DataChannel dc) { room.post(() -> wire(dc)); }
            @Override public void onRenegotiationNeeded() { room.post(Peer.this::negotiate); }
            @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) {
                room.post(() -> {
                    if (s == PeerConnection.PeerConnectionState.FAILED || s == PeerConnection.PeerConnectionState.CLOSED) { status = "closed"; room.changed(); }
                    else if (s == PeerConnection.PeerConnectionState.DISCONNECTED) { status = "closed"; room.changed(); }
                });
            }
            @Override public void onTrack(RtpTransceiver t) {
                MediaStreamTrack track = t.getReceiver().track();
                if (track instanceof VideoTrack) room.post(() -> { remoteVideo = (VideoTrack) track; room.calls.onRemoteVideo(Peer.this); });
                if (track instanceof org.webrtc.AudioTrack) room.post(() -> { remoteAudio = (org.webrtc.AudioTrack) track; room.calls.onRemoteAudio(Peer.this); });
            }
            @Override public void onAddTrack(RtpReceiver r, MediaStream[] streams) { }
        });
        if (pc == null) { Log.e("peer", "no peer connection", null); return; }
        room.calls.attachLocal(this);
        if (initiator) {
            DataChannel.Init init = new DataChannel.Init();
            init.ordered = true;
            wire(pc.createDataChannel("m5cet", init));
        }
    }

    private abstract static class Sdp implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription d) { }
        @Override public void onCreateFailure(String e) { Log.w("peer", "create SDP: " + e); }
        @Override public void onSetFailure(String e) { Log.w("peer", "set SDP: " + e); }
    }

    void negotiate() {
        if (pc == null) return;
        makingOffer = true;
        pc.setLocalDescription(new Sdp() {
            @Override public void onSetSuccess() {
                room.post(() -> {
                    makingOffer = false;
                    sendLocal();
                });
            }
            @Override public void onSetFailure(String e) { room.post(() -> makingOffer = false); super.onSetFailure(e); }
        });
    }

    private void sendLocal() {
        SessionDescription d = pc == null ? null : pc.getLocalDescription();
        if (d == null) return;
        try { room.sendSignal(id, new JSONObject().put("type", d.type.canonicalForm()).put("sdp", d.description)); }
        catch (JSONException ignored) { }
    }

    /** A sealed signal from this peer, opened (on the room's thread, in order). */
    void onSignal(JSONObject desc) {
        if (pc == null) return;
        String type = desc.optString("type", "");
        if (type.equals("offer") || type.equals("answer")) {
            boolean collision = type.equals("offer") && (makingOffer || pc.signalingState() != PeerConnection.SignalingState.STABLE);
            ignoreOffer = initiator && collision;
            if (ignoreOffer) return;
            SessionDescription sd = new SessionDescription(SessionDescription.Type.fromCanonicalForm(type), desc.optString("sdp"));
            room.hold();
            pc.setRemoteDescription(new Sdp() {
                @Override public void onSetSuccess() {
                    room.post(() -> {
                        if (type.equals("offer")) {
                            pc.setLocalDescription(new Sdp() {
                                @Override public void onSetSuccess() { room.post(() -> { sendLocal(); room.release(); }); }
                                @Override public void onSetFailure(String e) { room.post(room::release); super.onSetFailure(e); }
                            });
                        } else {
                            room.release();
                        }
                    });
                }
                @Override public void onSetFailure(String e) { room.post(room::release); super.onSetFailure(e); }
            }, sd);
            return;
        }
        String candidate = desc.optString("candidate", "");
        if (!candidate.isEmpty()) {
            IceCandidate c = new IceCandidate(desc.optString("sdpMid", "0"), desc.optInt("sdpMLineIndex", 0), candidate);
            if (!pc.addIceCandidate(c) && !ignoreOffer) Log.d("peer", "candidate not added");
        }
    }

    private void wire(DataChannel dc) {
        channel = dc;
        dc.registerObserver(new DataChannel.Observer() {
            @Override public void onBufferedAmountChange(long previous) { }
            @Override public void onStateChange() {
                DataChannel.State s = dc.state();
                room.post(() -> {
                    if (s == DataChannel.State.OPEN) { status = "open"; room.onChannelOpen(Peer.this); }
                    else if (s == DataChannel.State.CLOSED) { status = "closed"; room.changed(); }
                });
            }
            @Override public void onMessage(DataChannel.Buffer buffer) {
                ByteBuffer data = buffer.data;
                byte[] bytes = new byte[data.remaining()];
                data.get(bytes);
                boolean binary = buffer.binary;
                room.post(() -> {
                    if (!binary) room.onPeerText(Peer.this, new String(bytes, StandardCharsets.UTF_8));
                    else room.files.onBinary(Peer.this, bytes);
                });
            }
        });
        if (dc.state() == DataChannel.State.OPEN) room.post(() -> { status = "open"; room.onChannelOpen(this); });
    }

    boolean open() { return channel != null && channel.state() == DataChannel.State.OPEN; }

    /** 6.1: the peer reads binary file chunks ("bin" in its hello caps). */
    boolean bin = false;

    long buffered() { DataChannel dc = channel; return dc == null ? 0 : dc.bufferedAmount(); }

    boolean sendBinary(byte[] data) {
        DataChannel dc = channel;
        if (dc == null || dc.state() != DataChannel.State.OPEN) return false;
        return dc.send(new DataChannel.Buffer(ByteBuffer.wrap(data), true));
    }

    boolean send(String text) {
        DataChannel dc = channel;
        if (dc == null || dc.state() != DataChannel.State.OPEN) return false;
        return dc.send(new DataChannel.Buffer(ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8)), false));
    }

    void close() {
        try { if (channel != null) { channel.unregisterObserver(); channel.close(); channel.dispose(); } } catch (RuntimeException ignored) { }
        try { if (pc != null) { pc.close(); pc.dispose(); } } catch (RuntimeException ignored) { }
        channel = null;
        pc = null;
        status = "closed";
    }
}
