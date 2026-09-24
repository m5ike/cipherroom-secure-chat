// Modal-window panels exposed from the top menu. Each panel reads/writes the
// shared Preferences object via the props passed in from App.tsx.
//
// 4.13: each panel's content is a layout ("panel.profile" … "panel.trust",
// lib/layouts/settings.ts) drawn in the large window; what they do stays here.

import { NeedSignIn } from "./NeedSignIn";
import { useEffect, useState, type ChangeEvent } from "react";
import { Modal } from "./Modal";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { langLabel, SUPPORTED_LANGS, t, type Lang } from "@/lib/i18n";
import { DEFAULT_ROOM_SECURITY, type Preferences, type RoomSecurity } from "@/lib/preferences";
import { Fingerprint, formatFingerprint, loadFingerprints } from "@/lib/fingerprint";
import { currentAccount, saveVault } from "@/lib/account";

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
};

export function PrivacyPanel({
  open,
  onClose,
  prefs,
  setPrefs,
  lang,
  onLocalPurge,
  onServerPurge,
}: PanelBaseProps & PrivacyExtras) {
  const [serverStatus, setServerStatus] = useState<string>("");
  const { tree, base } = useLayoutBase("panel.privacy", lang);
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "privacy.title")}>
      {renderLayout(tree, {
        ...base,
        data: { prefs, serverStatus },
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
}: PanelBaseProps & {
  onEnable: () => Promise<void>;
  onDisable: () => void;
  pushAvailable: boolean;
  /** 4.0: web push through the server belongs to a signed-in account. */
  signedIn?: boolean;
  onOpenConnection?: () => void;
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
        slots: { needSignIn: () => <NeedSignIn lang={lang} onOpen={onOpenConnection} testId="notif-need-signin" /> },
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
type TrustPanelProps = PanelBaseProps & {
  peerFingerprints: Record<string, Fingerprint>;
  roomFingerprint?: string | null;
};

export function TrustPanel({ open, onClose, peerFingerprints, roomFingerprint, lang }: TrustPanelProps) {
  const stored = loadFingerprints();
  const entries = Object.entries({ ...stored, ...peerFingerprints });
  const { tree, base } = useLayoutBase("panel.trust", lang);
  return (
    <Modal open={open} onClose={onClose} title={lang === "cs" ? "Důvěra & DTLS otisky" : lang === "de" ? "Vertrauen & DTLS-Fingerprints" : "Trust & DTLS fingerprints"}>
      {renderLayout(tree, {
        ...base,
        data: {
          lang,
          entries: entries.map(([peerId, fp]) => ({ peerId, short: peerId.slice(-12), stored: fp.firstSeenAt.slice(0, 10), formatted: formatFingerprint(fp.digest), head: fp.digest.slice(0, 8), tail: fp.digest.slice(-4) })),
          roomFingerprint: roomFingerprint ? formatFingerprint(roomFingerprint) : "",
        },
      })}
    </Modal>
  );
}
