// Shapes the chat screen shares with its panels.

export type PeerStatus = "connecting" | "open" | "closed";
export type AudioStatus = "off" | "joining" | "live" | "muted";

export type PeerView = {
  id: string;
  name: string;
  status: PeerStatus;
  initiator: boolean;
  audio: AudioStatus;
  /** 6.12 (docs/protocol-v4.md § 13): did they prove to the server that they hold the room key? Undefined: the server did not say. */
  proven?: boolean;
};
