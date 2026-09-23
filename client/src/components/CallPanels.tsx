// Who is in the room, and the voice / video call controls.

import { Lock, Mic, MicOff, PhoneOff } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import type { AudioStatus, PeerView } from "../lib/app-types";

export function PeerList({ peers, lang }: { peers: PeerView[]; lang: Lang }) {
  if (peers.length === 0) {
    return <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t(lang, "app.noPeers")}</div>;
  }
  return (
    <div className="space-y-2" data-testid="list-peers">
      {peers.map((peer) => (
        <div key={peer.id} className="flex items-center justify-between gap-3 rounded-2xl bg-background p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" data-testid={`text-peer-${peer.id}`}>{peer.name}</p>
            <p className="font-mono text-xs text-muted-foreground">{peer.id.slice(-12)}</p>
          </div>
          <div className="flex items-center gap-1">
            {peer.audio === "live" ? <Mic className="h-4 w-4 text-emerald-500" aria-label="audio live" /> : peer.audio === "muted" ? <MicOff className="h-4 w-4 text-amber-500" aria-label="audio muted" /> : null}
            <span className={`rounded-full px-2 py-1 text-xs ${peer.status === "open" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : peer.status === "connecting" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}>{peer.status}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AudioControls({ audioStatus, audioPeerCount, connected, onJoin, onLeave, onToggleMute, lang, media, mediaDetail }: { audioStatus: AudioStatus; audioPeerCount: number; connected: boolean; onJoin: () => void; onLeave: () => void; onToggleMute: () => void; lang: Lang; media: Record<string, "e2ee" | "partial" | "off"> | null; mediaDetail?: string }) {
  const states = Object.values(media ?? {});
  const sealed = states.filter((s) => s === "e2ee").length;
  const mediaState = media === null ? "unsupported" : states.length > 0 && sealed === states.length ? "e2ee" : states.some((s) => s !== "off") ? "partial" : "off";
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">{t(lang, "audio.hint")}</div>
      <div className="text-xs text-muted-foreground">{t(lang, "audio.onCall").replace("{n}", String(audioPeerCount))}</div>
      {audioStatus !== "off" ? (
        <div data-testid="media-e2ee" data-state={mediaState} data-detail={mediaDetail} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${mediaState === "e2ee" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-border text-muted-foreground"}`}>
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t(lang, `sec.media.${mediaState}`).replace("{n}", String(sealed)).replace("{total}", String(states.length))}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {audioStatus === "off" || audioStatus === "joining" ? (
          <button type="button" data-testid="button-audio-join" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60" onClick={onJoin} disabled={!connected || audioStatus === "joining"}>
            <Mic className="h-4 w-4" />
            {audioStatus === "joining" ? "..." : t(lang, "audio.join")}
          </button>
        ) : (
          <>
            <button type="button" data-testid="button-audio-mute" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent" onClick={onToggleMute}>
              {audioStatus === "muted" ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {audioStatus === "muted" ? t(lang, "audio.unmute") : t(lang, "audio.mute")}
            </button>
            <button type="button" data-testid="button-audio-leave" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent" onClick={onLeave}>
              <PhoneOff className="h-4 w-4" />
              {t(lang, "audio.leave")}
            </button>
          </>
        )}
      </div>
    </div>
  );
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
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t(lang, "app.video.hint")}</p>
      <video ref={localVideoRef} muted autoPlay playsInline className="aspect-video w-full rounded-2xl border border-border bg-black" />
      <div ref={remoteVideosRef} className="grid grid-cols-2 gap-2" />
      <div className="flex flex-wrap gap-2">
        {mode !== "video" ? (
          <button type="button" onClick={onStart} disabled={!connected} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
            {t(lang, "app.video.start")}
          </button>
        ) : (
          <>
            <button type="button" onClick={onToggleCamera} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">
              {videoOn ? t(lang, "app.video.cameraOff") : t(lang, "app.video.cameraOn")}
            </button>
            <button type="button" onClick={onLeave} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">
              {t(lang, "app.video.hangUp")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
