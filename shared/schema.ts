// Cross-cutting types shared between client and server.
//
// Today this is intentionally tiny: the wire contract is reflected by the
// SignalingPolicy advertised at /api/health so embedders can verify they
// are talking to a relay that does not persist anything by default.

export type SignalingPolicy = {
  transport: "webrtc-datachannel";
  persistence: "none";
  cache: "no-store";
  signalingOnly: true;
};
