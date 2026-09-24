// "My connections": the saved rooms of a signed-in user in server-enhanced
// mode — list, editor, statistics and log per connection, and the comfort
// settings (default connection, connect after sign-in, reconnecting, the
// header switcher). State and persistence live in lib/connections.ts; this
// file only shows it and hands edits back.
//
// 4.13: drawn by layouts ("panel.connections", "part.connectionEdit",
// "part.connectionDetail", "part.connectionSettings" — lib/layouts/connections.ts).

import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { t, tf, type Lang } from "../lib/i18n";
import { formatBytes, formatFullDate, formatLogTime } from "../lib/format";
import { normalizeServerUrl, type ConnectionsPolicy } from "../lib/client-config";
import {
  EMPTY_STATS, formatDuration, type ConnectionEvent, type ConnectionSettings, type ConnectionsState,
  type EditResult, type Keepalive, type ProfileInput,
} from "../lib/connections";
import type { ChatRetention } from "../lib/chat-history";
import { SimpleModal } from "./SimpleModal";
import { NeedSignIn } from "./NeedSignIn";
import { ShareConnection } from "./SharePanel";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
// The switches, segmented controls and hints share the Appearance screen's styles.
import "../appearance.css";
import "../connections.css";

export type ConnectionsPanelProps = {
  lang: Lang;
  timezone: string;
  state: ConnectionsState;
  policy: ConnectionsPolicy;
  eligible: { enabled: boolean; signedIn: boolean; serverMode: boolean };
  activeId: string | null;
  connected: boolean;
  /** The room this tab is in now, to save it as a connection. */
  current: { room: string; passphrase: string; userName: string } | null;
  storedBytes: number;
  onConnect: (id: string) => void;
  onDisconnect: () => void;
  onSave: (input: ProfileInput & { id?: string }) => EditResult;
  onDelete: (id: string) => void;
  onDefault: (id: string | null) => void;
  onSettings: (patch: Partial<ConnectionSettings>) => void;
  onClearLog: (id: string) => void;
  onSignIn: () => void;
  onEnableServerMode: () => void;
  /** Open straight on a new connection (the Room window's "Create a connection"). */
  startWith?: "new";
  /** 4.0: the Invitations module is on for this user (else no Share button). */
  canShare?: boolean;
};

type View = { kind: "list" } | { kind: "edit"; id?: string; draft?: ProfileInput } | { kind: "detail"; id: string } | { kind: "settings" };

const COLORS = ["", "#007aff", "#34c759", "#ff9500", "#ff3b30", "#af52de", "#30b0c7", "#8e8e93"];
const TTL_OPTIONS = [0, 5, 60, 60 * 24, 60 * 24 * 7];
const RETENTIONS: ChatRetention[] = ["ephemeral", "session", "server"];
const KEEPALIVES: Keepalive[] = ["conservative", "balanced", "aggressive"];

/** 24 characters from 57 look-alike-free ones (~140 bits), without modulo bias. */
function randomKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < 24) out += alphabet[b % alphabet.length];
    }
  }
  return out.replace(/(.{6})(?=.)/g, "$1-");
}

const value = (e: unknown) => (e as ChangeEvent<HTMLInputElement | HTMLSelectElement>).target.value;
const checked = (e: unknown) => (e as ChangeEvent<HTMLInputElement>).target.checked;

export function ConnectionsPanel(props: ConnectionsPanelProps) {
  const { lang, state, policy, eligible, activeId, connected, current } = props;
  const [view, setView] = useState<View>(props.startWith === "new" ? { kind: "edit" } : { kind: "list" });
  // Share a connection: a window of its own, above this one.
  const [sharing, setSharing] = useState<string | null>(null);
  const shared = sharing ? state.profiles.find((p) => p.id === sharing) ?? null : null;
  const { tree, base } = useLayoutBase("panel.connections", lang);

  // 4.0: saved connections belong to a passkey account; signing in happens
  // in the Connection window only.
  const gate = eligible.enabled && !eligible.signedIn ? "account" : !eligible.enabled ? "disabled" : !eligible.serverMode ? "server" : "";
  const list = !gate && view.kind === "list";
  const full = state.profiles.length >= policy.maxProfiles;
  const alreadySaved = current ? state.profiles.some((p) => p.room === current.room && p.passphrase === current.passphrase) : true;
  const items = list ? state.profiles.map((p) => {
    const s = state.stats[p.id] ?? EMPTY_STATS;
    return {
      id: p.id, label: p.label, room: p.room, user: p.userName || "—", color: p.color ?? "",
      host: p.server ? new URL(p.server).host : t(lang, "cx.thisServer"),
      isActive: activeId === p.id && connected, isDefault: state.settings.defaultId === p.id,
      meta: `${tf(lang, "cx.usage", { n: s.connects, time: formatDuration(s.totalMs) })} · ${p.lastUsedAt ? tf(lang, "cx.lastUsed", { when: formatFullDate(p.lastUsedAt, lang, props.timezone) }) : t(lang, "cx.never")}`,
    };
  }) : [];
  const toList = () => setView({ kind: "list" });

  return renderLayout(tree, {
    ...base,
    data: {
      gate, view: view.kind, countText: tf(lang, "cx.limit", { n: state.profiles.length, max: policy.maxProfiles }),
      full, canSaveCurrent: Boolean(current) && !alreadySaved, items, canShare: props.canShare !== false, sharing: Boolean(shared),
    },
    actions: {
      tab: (_e, tab) => setView({ kind: tab === "settings" ? "settings" : "list" }),
      add: () => setView({ kind: "edit" }),
      saveCurrent: () => { if (current) setView({ kind: "edit", draft: { label: current.room, room: current.room, passphrase: current.passphrase, userName: current.userName } }); },
      connect: (_e, id) => props.onConnect(String(id)),
      disconnect: () => props.onDisconnect(),
      edit: (_e, id) => setView({ kind: "edit", id: String(id) }),
      details: (_e, id) => setView({ kind: "detail", id: String(id) }),
      makeDefault: (_e, id) => props.onDefault(state.settings.defaultId === id ? null : String(id)),
      share: (_e, id) => setSharing(String(id)),
      delete: (_e, id) => {
        const p = state.profiles.find((x) => x.id === id);
        if (p && window.confirm(tf(lang, "cx.delete.confirm", { name: p.label }))) props.onDelete(p.id);
      },
      enableServerMode: () => props.onEnableServerMode(),
    },
    slots: {
      needSignIn: () => <NeedSignIn lang={lang} onOpen={props.onSignIn} text={t(lang, "cx.need.account")} testId="cx-need" />,
      edit: () => (view.kind === "edit" ? <EditView {...props} id={view.id} draft={view.draft} onDone={toList} /> : null),
      detail: () => (view.kind === "detail" ? <DetailView {...props} id={view.id} onBack={toList} onEdit={() => setView({ kind: "edit", id: view.id })} /> : null),
      settings: () => <SettingsView {...props} />,
      share: () => (shared ? (
        <SimpleModal title={t(lang, "sc.title")} onClose={() => setSharing(null)} testId="share-connection-dialog">
          <ShareConnection lang={lang} connection={shared} onDone={() => setSharing(null)} />
        </SimpleModal>
      ) : null),
    },
  });
}

/* ---------------------------------------------------------------- edit */

function EditView(props: ConnectionsPanelProps & { id?: string; draft?: ProfileInput; onDone: () => void }) {
  const { lang, state, policy } = props;
  const existing = props.id ? state.profiles.find((p) => p.id === props.id) : undefined;
  const [form, setForm] = useState<ProfileInput>(() => ({
    label: "", color: "", room: "", passphrase: "", userName: props.current?.userName ?? "", server: "",
    mode: "server", retention: "server", ttlMinutes: 0, away: true, notifications: true, autoReconnect: true, keepalive: "balanced",
    ...existing, ...props.draft,
  }));
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const listed = policy.servers.some((s) => s.url === form.server);
  const [custom, setCustom] = useState(Boolean(form.server) && !listed);
  const set = (patch: Partial<ProfileInput>) => { setForm((f) => ({ ...f, ...patch })); setError(""); };
  const foreign = Boolean(form.server);
  const { tree, base } = useLayoutBase("part.connectionEdit", lang);

  const submit = (connect: boolean) => {
    const result = props.onSave({ ...form, ...(props.id ? { id: props.id } : {}), away: foreign ? false : form.away });
    if (!result.ok) { setError(t(lang, `cx.err.${result.error}`)); return; }
    if (connect) props.onConnect(result.profile.id);
    props.onDone();
  };

  return renderLayout(tree, {
    ...base,
    data: {
      editing: Boolean(props.id),
      form: {
        label: form.label ?? "", room: form.room ?? "", userName: form.userName ?? "", passphrase: form.passphrase ?? "", server: form.server ?? "",
        mode: form.mode, retention: form.retention, keepalive: form.keepalive,
        away: Boolean(form.away), notifications: Boolean(form.notifications), autoReconnect: Boolean(form.autoReconnect),
      },
      colors: COLORS.map((c) => ({ key: c || "none", value: c, bg: c || "transparent", label: c || "—", checked: (form.color ?? "") === c })),
      showKey,
      servers: policy.servers.map((s) => ({ id: s.id, url: s.url, label: s.label, host: new URL(s.url).host })),
      allowCustom: policy.allowCustomServers, custom, serverValue: custom ? "__custom" : form.server ?? "", foreign,
      retentions: RETENTIONS,
      ttls: TTL_OPTIONS.map((m) => ({ value: String(m), label: m === 0 ? t(lang, "cx.form.ttl.off") : formatDuration(m * 60_000) })),
      ttlValue: String(form.ttlMinutes ?? 0),
      keepalives: KEEPALIVES,
      error,
    },
    actions: {
      field: (e, name) => set({ [String(name)]: value(e) }),
      color: (_e, c) => set({ color: String(c ?? "") }),
      toggleKey: () => setShowKey((v) => !v),
      generate: () => { set({ passphrase: randomKey() }); setShowKey(true); },
      server: (e) => { const v = value(e); if (v === "__custom") { setCustom(true); } else { setCustom(false); set({ server: v }); } },
      serverBlur: () => { const n = normalizeServerUrl(form.server ?? ""); if (n) set({ server: n }); },
      mode: (e) => set({ mode: value(e) as "light" | "server" }),
      retention: (e) => set({ retention: value(e) as ChatRetention }),
      ttl: (e) => set({ ttlMinutes: Number(value(e)) }),
      keepalive: (e) => set({ keepalive: value(e) as Keepalive }),
      check: (e, name) => set({ [String(name)]: checked(e) }),
      save: (e) => { (e as FormEvent).preventDefault(); submit(false); },
      saveConnect: () => submit(true),
      cancel: () => props.onDone(),
    },
  });
}

/* -------------------------------------------------------------- detail */

type LogFilter = "all" | "session" | "people" | "files" | "errors";
const LOG_FILTERS: LogFilter[] = ["all", "session", "people", "files", "errors"];
const FILTER_EVENTS: Record<Exclude<LogFilter, "all">, ReadonlySet<ConnectionEvent>> = {
  session: new Set(["connect", "connected", "disconnected", "reconnect", "created", "edited"]),
  people: new Set(["peer-joined", "peer-left"]),
  files: new Set(["file-sent", "file-received"]),
  errors: new Set(["failed", "error"]),
};

function DetailView(props: ConnectionsPanelProps & { id: string; onBack: () => void; onEdit: () => void }) {
  const { lang, state, id } = props;
  const profile = state.profiles.find((p) => p.id === id);
  const [filter, setFilter] = useState<LogFilter>("all");
  const log = state.logs[id] ?? [];
  const shown = useMemo(() => (filter === "all" ? log : log.filter((e) => FILTER_EVENTS[filter].has(e.event))).slice().reverse(), [log, filter]);
  const { tree, base } = useLayoutBase("part.connectionDetail", lang);
  if (!profile) return null;
  const s = state.stats[id] ?? EMPTY_STATS;
  const sessions = Math.max(1, s.connects);
  const date = (v: number) => (v ? formatLogTime(v, lang, props.timezone) : "—");
  const tiles: Array<[string, string]> = [
    [t(lang, "cx.stats.connects"), String(s.connects)],
    [t(lang, "cx.stats.online"), formatDuration(s.totalMs)],
    [t(lang, "cx.stats.longest"), formatDuration(s.longestMs)],
    [t(lang, "cx.stats.average"), formatDuration(s.totalMs / sessions)],
    [t(lang, "cx.stats.messages"), `${s.sent} / ${s.received}`],
    [t(lang, "cx.stats.files"), `${s.filesSent} / ${s.filesReceived}`],
    [t(lang, "cx.stats.data"), `${formatBytes(s.bytesSent)} / ${formatBytes(s.bytesReceived)}`],
    [t(lang, "cx.stats.reconnects"), String(s.reconnects)],
    [t(lang, "cx.stats.failures"), String(s.failures)],
    [t(lang, "cx.stats.errors"), String(s.errors)],
    [t(lang, "cx.stats.peers"), String(s.peersMax)],
    [t(lang, "cx.stats.last"), date(s.lastConnectedAt)],
  ];
  const exportJson = () => {
    // The key stays out of the export: statistics and the log only.
    const { passphrase: _secret, ...safe } = profile;
    const blob = new Blob([JSON.stringify({ connection: safe, stats: s, log }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `m5cet-connection-${profile.room}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
  };
  return renderLayout(tree, {
    ...base,
    data: {
      label: profile.label,
      tiles: tiles.map(([label, v]) => ({ label, value: v })),
      filters: LOG_FILTERS, filter,
      shown: shown.slice(0, 300).map((e, i) => ({
        key: `${e.at}-${i}`, iso: new Date(e.at).toISOString(), full: formatFullDate(e.at, lang, props.timezone), time: formatLogTime(e.at, lang, props.timezone),
        event: e.event, detail: e.detail ?? "",
      })),
    },
    actions: {
      back: () => props.onBack(),
      edit: () => props.onEdit(),
      filter: (_e, f) => setFilter(f as LogFilter),
      export: () => exportJson(),
      clearLog: () => { if (window.confirm(t(lang, "cx.log.clear.confirm"))) props.onClearLog(id); },
    },
  });
}

/* ------------------------------------------------------------ settings */

function SettingsView(props: ConnectionsPanelProps) {
  const { lang, state, policy } = props;
  const st = state.settings;
  const { tree, base } = useLayoutBase("part.connectionSettings", lang);
  return renderLayout(tree, {
    ...base,
    data: {
      defaultId: st.defaultId ?? "", profiles: state.profiles.map((p) => ({ id: p.id, label: p.label })), settings: st,
      statsAllowed: policy.stats, storageText: tf(lang, "cx.set.storage", { n: state.profiles.length, size: formatBytes(props.storedBytes) }),
    },
    actions: {
      default: (e) => props.onDefault(value(e) || null),
      setting: (e, key) => props.onSettings({ [String(key)]: checked(e) } as Partial<ConnectionSettings>),
    },
  });
}
