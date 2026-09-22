// Read-only "what do we know about this participant" view, shown from the
// bubble avatar menu or the recipients widget. Everything here is derived
// locally from the WebRTC connection and our own counters — we never ask the
// server, and we label honestly what the browser cannot know (a peer's real IP
// is only visible when ICE exposes the selected candidate pair).

import { Avatar } from "./UserBadge";
import { t, type Lang } from "../lib/i18n";

export type UserInfo = {
  name: string;
  avatar?: string;
  peerId: string;
  self: boolean;
  connectedForMs: number | null;
  ip?: string;
  candidateType?: string; // host / srflx / prflx / relay
  transport: "p2p-direct" | "p2p-relay" | "connecting" | "self";
  appType: string;
  usesServer: boolean;
  sentBytes: number;
  recvBytes: number;
  security: string;
  fingerprint?: string;
};

function dur(ms: number | null, lang: Lang): string {
  if (ms === null) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h} ${t(lang, "userinfo.h")} ${m} ${t(lang, "userinfo.m")}`;
  if (m > 0) return `${m} ${t(lang, "userinfo.m")} ${sec} ${t(lang, "userinfo.s")}`;
  return `${sec} ${t(lang, "userinfo.s")}`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="userinfo-row">
      <span className="userinfo-row__k">{label}</span>
      <span className="userinfo-row__v">{value}</span>
    </div>
  );
}

export function UserInfoView({ info, lang }: { info: UserInfo; lang: Lang }) {
  const transportLabel = t(lang, `userinfo.transport.${info.transport}`);
  return (
    <div className="space-y-3">
      <div className="userinfo-head">
        <Avatar name={info.name} avatar={info.avatar} size={44} />
        <div>
          <div className="text-base font-semibold">{info.name || "—"}</div>
          <div className="font-mono text-xs text-muted-foreground">{info.peerId.slice(-16)}</div>
        </div>
      </div>
      <div className="userinfo-grid">
        <Row label={t(lang, "userinfo.duration")} value={dur(info.connectedForMs, lang)} />
        <Row label={t(lang, "userinfo.ip")} value={info.ip || t(lang, "userinfo.ip.unknown")} />
        <Row label={t(lang, "userinfo.candidate")} value={info.candidateType || "—"} />
        <Row label={t(lang, "userinfo.transport")} value={transportLabel} />
        <Row label={t(lang, "userinfo.app")} value={info.appType} />
        <Row label={t(lang, "userinfo.server")} value={info.usesServer ? t(lang, "userinfo.server.on") : t(lang, "userinfo.server.off")} />
        <Row label={t(lang, "userinfo.sent")} value={bytes(info.sentBytes)} />
        <Row label={t(lang, "userinfo.recv")} value={bytes(info.recvBytes)} />
        <Row label={t(lang, "userinfo.security")} value={info.security} />
      </div>
      {info.fingerprint ? (
        <div>
          <div className="userinfo-row__k mb-1">{t(lang, "userinfo.fingerprint")}</div>
          <code className="userinfo-fp">{info.fingerprint}</code>
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">{t(lang, "userinfo.note")}</p>
    </div>
  );
}
