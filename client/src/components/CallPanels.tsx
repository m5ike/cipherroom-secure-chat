// Who is in the room, and the voice / video call controls.
//
// 4.13: each is a layout ("part.peers", "part.audio", "part.video" —
// lib/layouts/tools.ts); the calls themselves stay in App.tsx.

import { type Lang } from "../lib/i18n";
import type { AudioStatus, PeerView } from "../lib/app-types";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

export function PeerList({ peers, lang }: { peers: PeerView[]; lang: Lang }) {
  const { tree, base } = useLayoutBase("part.peers", lang);
  return renderLayout(tree, { ...base, data: { peers: peers.map((p) => ({ id: p.id, name: p.name, short: p.id.slice(-12), status: p.status, audio: p.audio })) } });
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
