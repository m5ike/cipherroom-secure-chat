// Modal-window panels exposed from the top menu. Each panel reads/writes the
// shared Preferences object via the props passed in from App.tsx.
//
// 4.13: each panel's content is a layout ("panel.profile" … "panel.trust",
// lib/layouts/settings.ts) drawn in the large window; what they do stays here.

import { NeedSignIn } from "./NeedSignIn";
import { NotifySettings } from "./NotifySettings";
import { useEffect, useState, type ChangeEvent } from "react";
import { Modal } from "./Modal";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { langLabel, SUPPORTED_LANGS, t, type Lang } from "@/lib/i18n";
import { DEFAULT_ROOM_SECURITY, type Preferences, type RoomSecurity } from "@/lib/preferences";
import { Fingerprint, formatFingerprint } from "@/lib/fingerprint";
import { keyFingerprint } from "@/lib/identity";
import { ReleaseStatusCard } from "./ReleaseIntegrity";
import { currentAccount, saveVault } from "@/lib/account";
import { ProfileEditor } from "./ProfileEditor";

type PanelBaseProps = {
  open: boolean;
  onClose: () => void;
  prefs: Preferences;
  setPrefs: (next: Partial<Preferences>) => void;
  lang: Lang;
};

/** The actions every panel's fields share: a text or a choice, a tick box. */
function prefActions(setPrefs: (next: Partial<Preferences>) => void) {
  return {
    setText: (e: unknown, key: unknown) => setPrefs({ [String(key)]: (e as ChangeEvent<HTMLInputElement>).target.value } as Partial<Preferences>),
    setCheck: (e: unknown, key: unknown) => setPrefs({ [String(key)]: (e as ChangeEvent<HTMLInputElement>).target.checked } as Partial<Preferences>),
  };
}
const minutes = (e: unknown) => Math.max(0, Number((e as ChangeEvent<HTMLInputElement>).target.value) || 0);

export function ProfilePanel({ open, onClose, prefs, setPrefs, lang, onOpenConnection }: PanelBaseProps & { onOpenConnection?: () => void }) {
  const { tree, base } = useLayoutBase("panel.profile", lang);
  // Saving the profile with the account (4.0: no passkey buttons here).
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // Closed, it starts afresh (as the section did, drawn only while open).
  useEffect(() => { if (!open) { setBusy(false); setMsg(""); } }, [open]);
  const account = currentAccount();
  const onSave = async () => {
    setBusy(true); setMsg("");
    try { await saveVault({ profile: profileFromPrefs(prefs) }); setMsg(t(lang, "passkey.saved")); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "profile.title")}>
      {renderLayout(tree, {
        ...base,
        data: { prefs, account: account ? { username: account.username, id: account.id } : null, busy, msg, canOpenConnection: Boolean(onOpenConnection) },
        actions: { ...prefActions(setPrefs), save: () => void onSave(), openConnection: () => onOpenConnection?.() },
        // 6.7: the profile card (sealed in its own vault slot; its public part on the server).
        slots: { card: () => <ProfileEditor lang={lang} signedIn={Boolean(account)} /> },
      })}
    </Modal>
  );
}

/** What the passkey vault keeps: identity, appearance and the layout the
 *  user expects to find again on another device. */
export const PROFILE_KEYS: (keyof Preferences)[] = [
  "name", "bio", "avatar", "theme", "accent", "layout", "font", "fontSize", "effects",
  "lang", "timezone", "chatBgColor", "chatBgImage", "chatBgSaturation", "chatBgOpacity",
  "chatPattern", "chatWidth", "messageStyles", "menuDisplay",
  "chatFont", "monoFont", "textSize", "fontWeight", "lineHeight", "letterSpacing", "chatScale",
  "accentColor", "bubbleMine", "bubbleTheirs", "uiRadius", "bubbleRadius", "googleFonts", "deviceLayout",
  "widget", "chatRetention", "ttlDefaultMinutes", "roomSecurity",
  "showSystemInChat", "flash",
];

export function profileFromPrefs(prefs: Preferences): Partial<Preferences> {
  const out: Record<string, unknown> = {};
  for (const k of PROFILE_KEYS) out[k] = prefs[k];
  return out as Partial<Preferences>;
}

export function SettingsPanel({ open, onClose, prefs, setPrefs, lang, onOpenAppearance }: PanelBaseProps & { onOpenAppearance?: () => void }) {
  const { tree, base } = useLayoutBase("panel.settings", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "menu.settings")}>
      {renderLayout(tree, {
        ...base,
        data: {
          prefs,
          langs: SUPPORTED_LANGS.map((code) => ({ code, label: langLabel(code) })),
          tzHint: Intl.DateTimeFormat().resolvedOptions().timeZone,
          canOpenAppearance: Boolean(onOpenAppearance),
          maxAttachment: prefs.maxAttachmentBytes === Number.MAX_SAFE_INTEGER ? "unlimited" : String(prefs.maxAttachmentBytes),
        },
        actions: {
          ...prefActions(setPrefs),
          openAppearance: () => onOpenAppearance?.(),
          maxAttachment: (event) => {
            const value = (event as ChangeEvent<HTMLSelectElement>).target.value;
            if (value === "unlimited") {
              setPrefs({ maxAttachmentBytes: Number.MAX_SAFE_INTEGER });
            } else {
              const n = Number(value);
              if (!Number.isNaN(n) && n > 0) setPrefs({ maxAttachmentBytes: n });
            }
          },
        },
      })}
    </Modal>
  );
}

type PrivacyExtras = {
  onLocalPurge: () => void;
  onServerPurge: () => Promise<{ ok: boolean; message?: string }>;
  /** 6.12 (F-15): the server offers TURN — "hide my IP address" can work (lib/rtc.ts › turnAvailable). */
  turnAvailable?: boolean;
};

export function PrivacyPanel({
  open,
  onClose,
  prefs,
  setPrefs,
  lang,
  onLocalPurge,
  onServerPurge,
  turnAvailable = false,
}: PanelBaseProps & PrivacyExtras) {
  const [serverStatus, setServerStatus] = useState<string>("");
  const { tree, base } = useLayoutBase("panel.privacy", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "privacy.title")}>
      {renderLayout(tree, {
        ...base,
        data: { prefs, serverStatus, turnAvailable },
        actions: {
          ...prefActions(setPrefs),
          localPurge: () => onLocalPurge(),
          serverPurge: async () => {
            const result = await onServerPurge();
            setServerStatus(result.message || (result.ok ? "OK" : "FAIL"));
          },
        },
      })}
    </Modal>
  );
}

export function EncryptionPanel({ open, onClose, prefs, setPrefs, lang }: PanelBaseProps) {
  const { tree, base } = useLayoutBase("panel.encryption", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "encryption.title")}>
      {renderLayout(tree, { ...base, data: { prefs }, actions: { ttlDefault: (e) => setPrefs({ ttlDefaultMinutes: minutes(e) }) } })}
    </Modal>
  );
}

export function NotificationsPanel({
  open,
  onClose,
  prefs,
  setPrefs,
  lang,
  onEnable,
  onDisable,
  pushAvailable,
  onTestPush,
  onTestLocal,
  signedIn = true,
  onOpenConnection,
  notifyOffline = false,
}: PanelBaseProps & {
  onEnable: () => Promise<void>;
  onDisable: () => void;
  pushAvailable: boolean;
  /** 4.0: web push through the server belongs to a signed-in account. */
  signedIn?: boolean;
  onOpenConnection?: () => void;
  /** 6.7: the layout builder's preview — the user's settings drawn without asking the server. */
  notifyOffline?: boolean;
  onTestPush?: () => Promise<{ ok: boolean; reason?: string }>;
  onTestLocal?: () => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [testResult, setTestResult] = useState<string>("");
  const { tree, base } = useLayoutBase("panel.notifications", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "notif.title")}>
      {renderLayout(tree, {
        ...base,
        data: { prefs, pushAvailable, signedIn, lang, canTestLocal: Boolean(onTestLocal), canTestPush: Boolean(onTestPush), testResult },
        actions: {
          enable: () => void onEnable(),
          disable: () => onDisable(),
          testLocal: async () => { if (!onTestLocal) return; const r = await onTestLocal(); setTestResult(r.ok ? "Local test sent." : `Local test failed: ${r.reason}`); },
          testPush: async () => { if (!onTestPush) return; const r = await onTestPush(); setTestResult(r.ok ? "Push test sent." : `Push test failed: ${r.reason}`); },
        },
        slots: {
          needSignIn: () => <NeedSignIn lang={lang} onOpen={onOpenConnection} testId="notif-need-signin" />,
          // 6.7: the user's own choice — kinds, privacy, channel order, quiet hours, a test.
          notifyPrefs: () => (open ? <NotifySettings lang={lang} signedIn={signedIn} offline={notifyOffline} /> : null),
        },
      })}
    </Modal>
  );
}

export function AnalyticsPanel({ open, onClose, prefs, setPrefs, lang }: PanelBaseProps) {
  const { tree, base } = useLayoutBase("panel.analytics", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "analytics.title")}>
      {renderLayout(tree, { ...base, data: { prefs }, actions: prefActions(setPrefs) })}
    </Modal>
  );
}

export function RoomSecurityPanel({
  open,
  onClose,
  prefs,
  setPrefs,
  lang,
  room,
}: PanelBaseProps & { room: string }) {
  const security: RoomSecurity = (room && prefs.roomSecurity[room]) || DEFAULT_ROOM_SECURITY;
  const ttl = (room && prefs.roomTtl[room]) || { defaultMinutes: prefs.ttlDefaultMinutes, absoluteMinutes: 0 };

  function setSecurity(patch: Partial<RoomSecurity>) {
    if (!room) return;
    const next = { ...prefs.roomSecurity, [room]: { ...security, ...patch } };
    setPrefs({ roomSecurity: next });
  }

  function setTtl(patch: Partial<typeof ttl>) {
    if (!room) return;
    const next = { ...prefs.roomTtl, [room]: { ...ttl, ...patch } };
    setPrefs({ roomTtl: next });
  }

  const { tree, base } = useLayoutBase("panel.roomSecurity", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "room.security.title")}>
      {renderLayout(tree, {
        ...base,
        data: { room, lang, security, ttl },
        actions: {
          sort: (e) => setSecurity({ sort: (e as ChangeEvent<HTMLSelectElement>).target.value as RoomSecurity["sort"] }),
          securityCheck: (e, key) => setSecurity({ [String(key)]: (e as ChangeEvent<HTMLInputElement>).target.checked } as Partial<RoomSecurity>),
          ttl: (e, key) => setTtl({ [String(key)]: minutes(e) } as Partial<typeof ttl>),
        },
      })}
    </Modal>
  );
}

// -----------------------------------------------------------------------
// Trust panel — shows DTLS fingerprints per peer (TOFU) plus room DPA.
// -----------------------------------------------------------------------
/** 6.12 (F-25): who a connection belongs to — the member's name and the device key that signed their hello (if any yet). */
export type TrustPeer = { name: string; deviceKey?: string; verified: boolean };

type TrustPanelProps = PanelBaseProps & {
  peerFingerprints: Record<string, Fingerprint>;
  roomFingerprint?: string | null;
  /** 6.12 (F-25): the device behind a connection (peer id) — its fingerprints are labelled by that, not by the random peer id. */
  describePeer?: (peerId: string) => TrustPeer | null;
  /** 6.12: key transparency for this server, and the protocol each member speaks. */
  p4?: P4TrustInfo;
};

/** 6.12 (docs/protocol-v4.md § 14, § 1): what the security panel shows of protocol 4. */
export type P4TrustInfo = {
  kt: { state: "off" | "ok" | "alert" | "unknown"; size?: number; alert?: { kind: string; at: number; detail: string } | null };
  onKtDismiss: () => void;
  peers: Array<{ id: string; name: string; protocol: "pending" | 3 | 4 | "refused"; proven?: boolean }>;
};

/** 6.12: key transparency — a persistent red alert on a rewritten history or a split view — and each member's protocol. */
export function P4TrustSection({ info, lang }: { info: P4TrustInfo; lang: Lang }) {
  const kt = info.kt;
  const alert = kt.state === "alert" && kt.alert ? kt.alert : null;
  const label = (p: P4TrustInfo["peers"][number]) => t(lang, p.protocol === 4 ? "p4.peers.p4" : p.protocol === 3 ? "p4.peers.p3" : p.protocol === "refused" ? "p4.peers.refused" : "p4.peers.pending");
  return (
    <section className="mb-4 space-y-3" data-testid="p4-trust">
      <div>
        <h3 className="text-sm font-semibold">{t(lang, "p4.kt.title")}</h3>
        {alert ? (
          <div role="alert" data-testid="kt-alert" data-kind={alert.kind} className="mt-1 rounded-xl border border-destructive bg-destructive/10 p-3 text-sm font-semibold text-destructive">
            <p>{t(lang, `p4.kt.alert.${alert.kind}`).replace("{detail}", alert.detail)}</p>
            <p className="mt-1 text-xs font-normal">{new Date(alert.at).toLocaleString(lang)}</p>
            <button type="button" className="acc-btn acc-btn--small mt-2" onClick={info.onKtDismiss} data-testid="kt-dismiss">{t(lang, "p4.kt.dismiss")}</button>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="kt-state" data-state={kt.state}>
            {kt.state === "ok" ? t(lang, "p4.kt.ok").replace("{size}", String(kt.size ?? 0)) : kt.state === "off" ? t(lang, "p4.kt.off") : t(lang, "p4.kt.unknown")}
          </p>
        )}
      </div>
      <div>
        <h3 className="text-sm font-semibold">{t(lang, "p4.peers.title")}</h3>
        {info.peers.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t(lang, "p4.peers.none")}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm" data-testid="p4-peers">
            {info.peers.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2" data-testid={`p4-peer-${p.id}`} data-protocol={String(p.protocol)}>
                <span className="font-medium">{p.name}</span>
                <span className={`rounded-full px-2 text-[11px] ${p.protocol === 4 ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : p.protocol === "refused" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-700 dark:text-amber-300"}`}>{label(p)}</span>
                {p.proven === false && <span className="rounded-full bg-amber-500/15 px-2 text-[11px] text-amber-700 dark:text-amber-300" title={t(lang, "p4.unproven.title")}>{t(lang, "p4.unproven")}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}


/** The short fingerprints of device keys (async: SHA-256), remembered per key. */
function useDeviceIds(keys: string[]): Record<string, string> {
  const [ids, setIds] = useState<Record<string, string>>({});
  const wanted = keys.filter((k) => !(k in ids)).join("|");
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    void Promise.all(wanted.split("|").map(async (k) => [k, await keyFingerprint(k).catch(() => "?")] as const)).then((pairs) => {
      if (alive) setIds((cur) => ({ ...cur, ...Object.fromEntries(pairs) }));
    });
    return () => { alive = false; };
  }, [wanted]);
  return ids;
}

export function TrustPanel({ open, onClose, peerFingerprints, roomFingerprint, lang, describePeer, p4 }: TrustPanelProps) {
  // 6.12 (F-25): only this session's connections. The browser makes a new DTLS certificate for
  // every connection, and peer ids are random per session: a list of past peer ids said nothing.
  const entries = Object.entries(peerFingerprints).map(([peerId, fp]) => ({ peerId, fp, who: describePeer?.(peerId) ?? null }));
  const deviceIds = useDeviceIds(entries.map((e) => e.who?.deviceKey).filter((k): k is string => Boolean(k)));
  const { tree, base } = useLayoutBase("panel.trust", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "trust.title")}>
      <ReleaseStatusCard lang={lang} />
      {p4 && <P4TrustSection info={p4} lang={lang} />}
      {renderLayout(tree, {
        ...base,
        data: {
          lang,
          entries: entries.map(({ peerId, fp, who }) => {
            const device = who?.deviceKey ? deviceIds[who.deviceKey] ?? "…" : "";
            return {
              peerId, short: peerId.slice(-12), stored: fp.firstSeenAt.slice(0, 10), formatted: formatFingerprint(fp.digest), head: fp.digest.slice(0, 8), tail: fp.digest.slice(-4),
              name: who?.name || peerId.slice(-6),
              device,
              verified: Boolean(who?.verified),
              label: device
                ? `${who?.name || peerId.slice(-6)} · ${t(lang, "trust.device")} ${device}${who?.verified ? ` · ${t(lang, "trust.verified")}` : ` · ${t(lang, "trust.unverified")}`}`
                : `${who?.name || peerId.slice(-6)} · ${t(lang, "trust.noDevice")}`,
            };
          }),
          roomFingerprint: roomFingerprint ? formatFingerprint(roomFingerprint) : "",
        },
      })}
    </Modal>
  );
}
