// Read-only "what do we know about this participant" view, shown from the
// bubble avatar menu or the recipients widget. Everything here is derived
// locally from the WebRTC connection and our own counters — we never ask the
// server, and we label honestly what the browser cannot know (a peer's real IP
// is only visible when ICE exposes the selected candidate pair).
//
// 4.13: the view is a layout ("dialog.userInfo", lib/layouts/dialogs.ts);
// the safety number, the scanner and what they do stay here.

import { useEffect, useRef, useState } from "react";
import { QrCodeView } from "./SharePanel";
import { safetyNumber } from "../lib/identity";
import { t, type Lang } from "../lib/i18n";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

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

export function UserInfoView({ info, lang }: { info: UserInfo; lang: Lang }) {
  const { tree, base } = useLayoutBase("dialog.userInfo", lang);
  const safety = info.safety;
  const [number, setNumber] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<"match" | "mismatch" | "">("");
  useEffect(() => {
    if (!safety) return;
    let live = true;
    void safetyNumber(safety.mine, safety.theirs).then((n) => { if (live) setNumber(n); });
    return () => { live = false; };
  }, [safety?.mine, safety?.theirs]); // eslint-disable-line react-hooks/exhaustive-deps
  const canScan = typeof window !== "undefined" && "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia);
  const digits = number.replace(/\s/g, "");
  return renderLayout(tree, {
    ...base,
    data: {
      name: info.name, avatar: info.avatar, peerShort: info.peerId.slice(-16), username: info.username, duration: dur(info.connectedForMs, lang),
      ip: info.ip, candidateType: info.candidateType, transport: info.transport, appType: info.appType, usesServer: info.usesServer,
      sent: bytes(info.sentBytes), recv: bytes(info.recvBytes), security: info.security, fingerprint: info.fingerprint,
      hasSafety: Boolean(safety), number, digits, verified: Boolean(safety?.verified), result, scanning, canScan,
    },
    actions: {
      scan: () => setScanning(true),
      confirm: () => { safety?.onVerified(); setResult("match"); },
      exclude: () => { if (window.confirm(t(lang, "sec.exclude.confirm"))) safety?.onExclude(); },
    },
    slots: {
      qr: () => <QrCodeView value={`${QR_PREFIX}${digits}`} size={160} />,
      scanner: () => (
        <QrScanner
          onClose={() => setScanning(false)}
          onResult={(text) => {
            setScanning(false);
            const ok = text === `${QR_PREFIX}${digits}`;
            setResult(ok ? "match" : "mismatch");
            if (ok) safety?.onVerified();
          }}
        />
      ),
    },
  });
}
