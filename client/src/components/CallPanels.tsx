// Who is in the room, and the voice / video call controls.
//
// 4.13: each is a layout ("part.peers", "part.audio", "part.video" —
// lib/layouts/tools.ts); the calls themselves stay in App.tsx.

import { type Lang } from "../lib/i18n";
import type { AudioStatus, PeerView } from "../lib/app-types";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { presenceView, usePresenceClock } from "../lib/presence-book";
import type { RoomPresence } from "../lib/use-room-presence";
import "../presence.css";

/** 6.7 `presence`: each person's status dot and "last seen …", and the members whose connection went (held, listed as away). */
export function PeerList({ peers, lang, presence }: { peers: PeerView[]; lang: Lang; presence?: RoomPresence }) {
  const { tree, base } = useLayoutBase("part.peers", lang);
  const now = usePresenceClock();
  const seen = (id: string) => (presence ? presenceView(presence.factsOf(id), now, lang) : { presence: "", presenceLabel: "", seenText: "" });
  // A held member's own entry (the server's) stands for them, not a closed peer left behind.
  const list = [
    ...peers.filter((p) => !presence?.isHeld(p.id)).map((p) => ({ id: p.id, name: p.name, short: p.id.slice(-12), status: p.status as string, audio: p.audio as string, ...seen(p.id) })),
    ...(presence?.held([], []) ?? []).map((h) => ({ id: h.peerId, name: h.name, short: h.peerId.slice(-12), status: "away", audio: "off", ...seen(h.peerId) })),
  ];
  return renderLayout(tree, { ...base, data: { peers: list } });
}

export function AudioControls({ audioStatus, audioPeerCount, connected, onJoin, onLeave, onToggleMute, lang, media, mediaDetail }: { audioStatus: AudioStatus; audioPeerCount: number; connected: boolean; onJoin: () => void; onLeave: () => void; onToggleMute: () => void; lang: Lang; media: Record<string, "e2ee" | "partial" | "off"> | null; mediaDetail?: string }) {
  const { tree, base } = useLayoutBase("part.audio", lang);
  const states = Object.values(media ?? {});
  const sealed = states.filter((s) => s === "e2ee").length;
  const mediaState = media === null ? "unsupported" : states.length > 0 && sealed === states.length ? "e2ee" : states.some((s) => s !== "off") ? "partial" : "off";
  return renderLayout(tree, {
    ...base,
    data: { audioStatus, audioPeerCount, connected, mediaState, mediaDetail, sealed, total: states.length },
    actions: { join: () => onJoin(), toggleMute: () => onToggleMute(), leave: () => onLeave() },
  });
}

export function VideoControls({
  connected, mode, videoOn, onStart, onLeave, onToggleCamera, localVideoRef, remoteVideosRef, lang,
}: {
  connected: boolean;
  mode: "audio" | "video" | "off";
  videoOn: boolean;
  onStart: () => void;
  onLeave: () => void;
  onToggleCamera: () => void;
  localVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  remoteVideosRef: React.MutableRefObject<HTMLDivElement | null>;
  lang: Lang;
}) {
  const { tree, base } = useLayoutBase("part.video", lang);
  return renderLayout(tree, {
    ...base,
    data: { connected, mode, videoOn },
    actions: { start: () => onStart(), toggleCamera: () => onToggleCamera(), leave: () => onLeave() },
    refs: { localVideo: localVideoRef as never, remoteVideos: remoteVideosRef as never },
  });
}
