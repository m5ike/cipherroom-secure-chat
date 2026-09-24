// Read-only "what do we know about this participant" view, shown from the
// bubble avatar menu or the recipients widget. Everything here is derived
// locally from the WebRTC connection and our own counters — we never ask the
// server, and we label honestly what the browser cannot know (a peer's real IP
// is only visible when ICE exposes the selected candidate pair).

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ScanLine, UserX } from "lucide-react";
import { Avatar } from "./UserBadge";
import { QrCodeView } from "./SharePanel";
import { safetyNumber } from "../lib/identity";
import { t, type Lang } from "../lib/i18n";

export type UserInfo = {
  /** The nickname shown in the room. */
  name: string;
  /** 4.0: the username behind it (account, or this P2P session's). */
  username?: string;
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
  /** 3.1: both device keys, to compare safety numbers; and what can be done. */
  safety?: {
    mine: string;
    theirs: string;
    verified: boolean;
    onVerified: () => void;
    onExclude: () => void;
  };
};

const QR_PREFIX = "M5CET-SN:1:";

/** Reads a QR code with the camera (BarcodeDetector); null when the browser cannot. */
function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    if (!Detector) { onClose(); return; }
    const detector = new Detector({ formats: ["qr_code"] });
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then((s) => {
      if (stopped) { s.getTracks().forEach((tr) => tr.stop()); return; }
      stream = s;
      if (video.current) { video.current.srcObject = s; void video.current.play(); }
      const tick = async () => {
        if (stopped || !video.current) return;
        try {
          const found = await detector.detect(video.current);
          if (found[0]?.rawValue) { onResult(found[0].rawValue); return; }
        } catch { /* next frame */ }
        timer = window.setTimeout(tick, 250);
      };
      void tick();
    }).catch(() => onClose());
    return () => { stopped = true; window.clearTimeout(timer); stream?.getTracks().forEach((tr) => tr.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <video ref={video} className="userinfo-scan" muted playsInline />;
}

function SafetySection({ safety, lang }: { safety: NonNullable<UserInfo["safety"]>; lang: Lang }) {
  const [number, setNumber] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<"match" | "mismatch" | "">("");
  useEffect(() => {
    let live = true;
    void safetyNumber(safety.mine, safety.theirs).then((n) => { if (live) setNumber(n); });
    return () => { live = false; };
  }, [safety.mine, safety.theirs]);
  const canScan = typeof window !== "undefined" && "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia);
  const digits = number.replace(/\s/g, "");
  return (
    <div className="userinfo-safety" data-testid="safety-number">
      <div className="userinfo-row__k mb-1">{t(lang, "sec.safety")}</div>
      <p className="text-[11px] text-muted-foreground">{t(lang, "sec.safety.desc")}</p>
      <code className="userinfo-sn">{number || "…"}</code>
      {digits ? <QrCodeView value={`${QR_PREFIX}${digits}`} size={160} /> : null}
      {scanning ? (
        <QrScanner
          onClose={() => setScanning(false)}
          onResult={(text) => {
            setScanning(false);
            const ok = text === `${QR_PREFIX}${digits}`;
            setResult(ok ? "match" : "mismatch");
            if (ok) safety.onVerified();
          }}
        />
      ) : null}
      {safety.verified || result === "match" ? <p className="text-xs text-emerald-600 dark:text-emerald-400"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />{t(lang, "sec.safety.verified")}</p> : null}
      {result === "mismatch" ? <p className="text-xs font-semibold text-destructive">{t(lang, "sec.safety.mismatch")}</p> : null}
      <div className="flex flex-wrap gap-2">
        {canScan && !safety.verified ? <button type="button" className="acc-btn acc-btn--small" onClick={() => setScanning(true)}><ScanLine className="h-3.5 w-3.5" />{t(lang, "sec.safety.scan")}</button> : null}
        {!safety.verified && result !== "match" ? <button type="button" className="acc-btn acc-btn--small" onClick={() => { safety.onVerified(); setResult("match"); }} data-testid="safety-confirm">{t(lang, "sec.safety.confirm")}</button> : null}
        <button type="button" className="acc-btn acc-btn--small acc-btn--danger" onClick={() => { if (window.confirm(t(lang, "sec.exclude.confirm"))) safety.onExclude(); }} data-testid="peer-exclude"><UserX className="h-3.5 w-3.5" />{t(lang, "sec.exclude")}</button>
      </div>
    </div>
  );
}

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
        {info.username ? <Row label={t(lang, "id.username")} value={<span className="font-mono" data-testid="userinfo-username">{info.username}</span>} /> : null}
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
      {info.safety ? <SafetySection safety={info.safety} lang={lang} /> : null}
      <p className="text-[11px] text-muted-foreground">{t(lang, "userinfo.note")}</p>
    </div>
  );
}
