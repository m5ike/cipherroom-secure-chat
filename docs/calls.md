# Audio / video calls

Calls share the same `RTCPeerConnection` instances created for the chat
DataChannel. Adding/removing tracks triggers a fresh SDP offer/answer
exchange over the signaling WebSocket. All media traffic is encrypted
end-to-end with **DTLS-SRTP**, the standard WebRTC transport security.
The signaling server only sees the SDP/ICE metadata used to set up the
session, never the media itself.

## UI

The toolbar has separate **Audio** and **Video** buttons. Inside each
modal:

- **Audio**: join, mute/unmute, leave. The mic stream is captured via
  `getUserMedia({ audio: true })` and added to every open peer.
- **Video**: start a call (`getUserMedia({ audio: true, video: true })`),
  toggle the camera track on/off, hang up. Local preview shows in a
  `<video>` element; remote streams are appended to a grid container.

## Device selection

`client/src/lib/calls.ts` exports `listDevices()` which returns
`audioInputs`, `videoInputs`, `audioOutputs` from
`navigator.mediaDevices.enumerateDevices()`. Pass `audioDeviceId` /
`videoDeviceId` to `getCallStream(...)` to pin a specific device. The
default UI uses the OS default device — extending the modal with a
device picker is left as a small follow-up.

## Limitations / privacy notes

- ICE config lives in `client/src/lib/rtc.ts`. The default is Google's
  public STUN (`stun:stun.l.google.com:19302`). To add TURN set
  `TURN_SERVER_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL` on the server:
  the client fetches `GET /api/turn` at load and replaces its `iceServers`.
  Those credentials are static and served to any caller, so use a
  TURN-only account (or put coturn's ephemeral `use-auth-secret` scheme in
  front). The Google STUN entry is hardcoded on both sides; self-hosting
  STUN currently means editing `rtc.ts` and `routes.ts`.
- Calls need `Permissions-Policy` to allow `camera`/`microphone` for the
  app's own origin. Releases before 2.5.0 sent `camera=()` and calls could
  not start; check any reverse proxy does not re-add such a header.
- WebRTC does not protect IP addresses from peers; either use a
  TURN-only policy or accept that peers can learn your public IP.
- DTLS-SRTP fingerprints are exchanged in the SDP and verified on the
  fly. The signaling server cannot decrypt media even if compromised.
