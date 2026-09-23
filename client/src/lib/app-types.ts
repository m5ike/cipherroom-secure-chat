// Shapes the chat screen shares with its panels.

export type PeerStatus = "connecting" | "open" | "closed";
export type AudioStatus = "off" | "joining" | "live" | "muted";

export type PeerView = {
  id: string;
  name: string;
  status: PeerStatus;
  initiator: boolean;
  audio: AudioStatus;
};
