// "My connections": the saved rooms of a signed-in user in server-enhanced
// mode — list, editor, statistics and log per connection, and the comfort
// settings (default connection, connect after sign-in, reconnecting, the
// header switcher). State and persistence live in lib/connections.ts; this
// file only shows it and hands edits back.

import { useMemo, useState } from "react";
import {
  BarChart3, Check, Eye, EyeOff, KeyRound, Pencil, Plug, PlugZap, Plus, RefreshCw, Save, Server, Settings2, Star, Trash2, Undo2,
} from "lucide-react";
import { t, tf, type Lang } from "../lib/i18n";
import { formatBytes, formatFullDate, formatLogTime } from "../lib/format";
import { normalizeServerUrl, type ConnectionsPolicy } from "../lib/client-config";
import {
  EMPTY_STATS, formatDuration, type ConnectionEvent, type ConnectionProfile, type ConnectionSettings, type ConnectionsState,
  type EditResult, type Keepalive, type LogEntry, type ProfileInput,
} from "../lib/connections";
import type { ChatRetention } from "../lib/chat-history";
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

function Switch({ label, checked, onChange, hint, disabled, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean; testId?: string }) {
  return (
    <label className={`ap-toggle cx-switch${disabled ? " is-disabled" : ""}`}>
      <span>
        <span className="ap-toggle__label">{label}</span>
        {hint ? <span className="ap-hint">{hint}</span> : null}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className="ap-toggle__track" aria-hidden="true"><span className="ap-toggle__thumb" /></span>
    </label>
  );
}

export function ConnectionsPanel(props: ConnectionsPanelProps) {
  const { lang, state, policy, eligible } = props;
  const [view, setView] = useState<View>({ kind: "list" });

  if (!eligible.enabled || !eligible.signedIn || !eligible.serverMode) {
    return (
      <div className="cx" data-testid="connections-panel">
        <div className="cx-card cx-need" data-testid="connections-need">
          <h3 className="cx-need__title">{t(lang, eligible.enabled ? "cx.need.title" : "cx.need.disabled")}</h3>
          {eligible.enabled ? (
            <>
              {!eligible.signedIn ? <p>{t(lang, "cx.need.account")}</p> : null}
              {!eligible.serverMode ? <p>{t(lang, "cx.need.server")}</p> : null}
              <div className="cx-actions">
                {!eligible.serverMode ? <button type="button" className="cx-btn" onClick={props.onEnableServerMode} data-testid="cx-enable-server"><Server className="h-4 w-4" />{t(lang, "cx.enableServer")}</button> : null}
                {!eligible.signedIn ? <button type="button" className="cx-btn cx-btn--primary" onClick={props.onSignIn} data-testid="cx-sign-in"><KeyRound className="h-4 w-4" />{t(lang, "cx.signIn")}</button> : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="cx" data-testid="connections-panel">
      <nav className="cx-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view.kind !== "settings"} className="cx-tab" onClick={() => setView({ kind: "list" })} data-testid="cx-tab-list">
          <Plug className="h-4 w-4" />{t(lang, "cx.tab.list")}
          <span className="cx-count">{tf(lang, "cx.limit", { n: state.profiles.length, max: policy.maxProfiles })}</span>
        </button>
        <button type="button" role="tab" aria-selected={view.kind === "settings"} className="cx-tab" onClick={() => setView({ kind: "settings" })} data-testid="cx-tab-settings">
          <Settings2 className="h-4 w-4" />{t(lang, "cx.tab.settings")}
        </button>
      </nav>
      {view.kind === "list" ? <ListView {...props} onEdit={(id, draft) => setView({ kind: "edit", id, draft })} onDetail={(id) => setView({ kind: "detail", id })} /> : null}
      {view.kind === "edit" ? <EditView {...props} id={view.id} draft={view.draft} onDone={() => setView({ kind: "list" })} /> : null}
      {view.kind === "detail" ? <DetailView {...props} id={view.id} onBack={() => setView({ kind: "list" })} onEdit={() => setView({ kind: "edit", id: view.id })} /> : null}
      {view.kind === "settings" ? <SettingsView {...props} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- list */

function ListView(props: ConnectionsPanelProps & { onEdit: (id?: string, draft?: ProfileInput) => void; onDetail: (id: string) => void }) {
  const { lang, state, activeId, connected, current, policy } = props;
  const full = state.profiles.length >= policy.maxProfiles;
  const alreadySaved = current ? state.profiles.some((p) => p.room === current.room && p.passphrase === current.passphrase) : true;
  return (
    <>
      <p className="cx-intro">{t(lang, "cx.intro")}</p>
      <div className="cx-actions">
        <button type="button" className="cx-btn cx-btn--primary" disabled={full} onClick={() => props.onEdit()} data-testid="cx-add"><Plus className="h-4 w-4" />{t(lang, "cx.add")}</button>
        {current && !alreadySaved ? (
          <button type="button" className="cx-btn" disabled={full} data-testid="cx-save-current"
            onClick={() => props.onEdit(undefined, { label: current.room, room: current.room, passphrase: current.passphrase, userName: current.userName })}>
            <Save className="h-4 w-4" />{t(lang, "cx.saveCurrent")}
          </button>
        ) : null}
      </div>
      {state.profiles.length === 0 ? <p className="cx-empty" data-testid="cx-empty">{t(lang, "cx.empty")}</p> : null}
      <ul className="cx-list" data-testid="cx-list">
        {state.profiles.map((p) => {
          const s = state.stats[p.id] ?? EMPTY_STATS;
          const isActive = activeId === p.id && connected;
          const isDefault = state.settings.defaultId === p.id;
          return (
            <li key={p.id} className={`cx-card cx-item${isActive ? " is-active" : ""}`} data-testid="cx-item" data-id={p.id} style={p.color ? { ["--cx-color" as string]: p.color } : undefined}>
              <div className="cx-item__head">
                <span className="cx-dot" aria-hidden="true" />
                <div className="cx-item__title">
                  <span className="cx-item__label" data-testid="cx-item-label">{p.label}</span>
                  <span className="cx-item__sub">{p.room} · {p.userName || "—"} · {p.server ? new URL(p.server).host : t(lang, "cx.thisServer")}</span>
                </div>
                {isDefault ? <span className="cx-badge" data-testid="cx-default-badge"><Star className="h-3 w-3" />{t(lang, "cx.default")}</span> : null}
                {isActive ? <span className="cx-badge cx-badge--ok"><Check className="h-3 w-3" />{t(lang, "cx.active")}</span> : null}
              </div>
              <div className="cx-item__meta">
                {tf(lang, "cx.usage", { n: s.connects, time: formatDuration(s.totalMs) })}
                {" · "}
                {p.lastUsedAt ? tf(lang, "cx.lastUsed", { when: formatFullDate(p.lastUsedAt, lang, props.timezone) }) : t(lang, "cx.never")}
              </div>
              <div className="cx-item__actions">
                {isActive ? (
                  <button type="button" className="cx-btn" onClick={props.onDisconnect} data-testid="cx-disconnect"><PlugZap className="h-4 w-4" />{t(lang, "cx.disconnect")}</button>
                ) : (
                  <button type="button" className="cx-btn cx-btn--primary" onClick={() => props.onConnect(p.id)} data-testid="cx-connect"><Plug className="h-4 w-4" />{t(lang, "cx.connect")}</button>
                )}
                <button type="button" className="cx-icon" title={t(lang, "cx.edit")} aria-label={t(lang, "cx.edit")} onClick={() => props.onEdit(p.id)} data-testid="cx-edit"><Pencil className="h-4 w-4" /></button>
                <button type="button" className="cx-icon" title={t(lang, "cx.details")} aria-label={t(lang, "cx.details")} onClick={() => props.onDetail(p.id)} data-testid="cx-details"><BarChart3 className="h-4 w-4" /></button>
                <button type="button" className="cx-icon" title={t(lang, "cx.makeDefault")} aria-label={t(lang, "cx.makeDefault")} aria-pressed={isDefault} onClick={() => props.onDefault(isDefault ? null : p.id)} data-testid="cx-make-default"><Star className="h-4 w-4" /></button>
                <button type="button" className="cx-icon cx-icon--danger" title={t(lang, "cx.delete")} aria-label={t(lang, "cx.delete")} data-testid="cx-delete"
                  onClick={() => { if (window.confirm(tf(lang, "cx.delete.confirm", { name: p.label }))) props.onDelete(p.id); }}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
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

  const submit = (connect: boolean) => {
    const result = props.onSave({ ...form, ...(props.id ? { id: props.id } : {}), away: foreign ? false : form.away });
    if (!result.ok) { setError(t(lang, `cx.err.${result.error}`)); return; }
    if (connect) props.onConnect(result.profile.id);
    props.onDone();
  };

  return (
    <form className="cx-form" onSubmit={(e) => { e.preventDefault(); submit(false); }} data-testid="cx-form">
      <h3 className="cx-form__title">{t(lang, props.id ? "cx.form.edit" : "cx.form.new")}</h3>
      <div className="cx-grid">
        <label className="cx-field">
          <span>{t(lang, "cx.form.label")}</span>
          <input value={form.label ?? ""} maxLength={60} onChange={(e) => set({ label: e.target.value })} data-testid="cx-f-label" />
        </label>
        <div className="cx-field">
          <span>{t(lang, "cx.form.color")}</span>
          <div className="cx-colors" role="radiogroup" aria-label={t(lang, "cx.form.color")}>
            {COLORS.map((c) => (
              <button key={c || "none"} type="button" role="radio" aria-checked={(form.color ?? "") === c} className="cx-color" style={{ background: c || "transparent" }} onClick={() => set({ color: c })} aria-label={c || "—"} />
            ))}
          </div>
        </div>
        <label className="cx-field">
          <span>{t(lang, "cx.form.room")}</span>
          <input value={form.room ?? ""} required maxLength={64} onChange={(e) => set({ room: e.target.value })} data-testid="cx-f-room" autoComplete="off" />
        </label>
        <label className="cx-field">
          <span>{t(lang, "cx.form.userName")}</span>
          <input value={form.userName ?? ""} maxLength={42} onChange={(e) => set({ userName: e.target.value })} data-testid="cx-f-name" />
        </label>
        <div className="cx-field cx-field--wide">
          <span>{t(lang, "cx.form.passphrase")}</span>
          <div className="cx-key">
            <input type={showKey ? "text" : "password"} value={form.passphrase ?? ""} required onChange={(e) => set({ passphrase: e.target.value })} data-testid="cx-f-key" autoComplete="new-password" spellCheck={false} />
            <button type="button" className="cx-icon" onClick={() => setShowKey((v) => !v)} aria-label={t(lang, showKey ? "cx.form.hide" : "cx.form.show")}>{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
            <button type="button" className="cx-btn" onClick={() => { set({ passphrase: randomKey() }); setShowKey(true); }} data-testid="cx-f-generate"><RefreshCw className="h-4 w-4" />{t(lang, "cx.form.generate")}</button>
          </div>
        </div>
        <label className="cx-field cx-field--wide">
          <span>{t(lang, "cx.form.server")}</span>
          <select
            value={custom ? "__custom" : form.server ?? ""}
            onChange={(e) => { if (e.target.value === "__custom") { setCustom(true); } else { setCustom(false); set({ server: e.target.value }); } }}
            data-testid="cx-f-server"
          >
            <option value="">{t(lang, "cx.thisServer")}</option>
            {policy.servers.map((s) => <option key={s.id} value={s.url}>{s.label} — {new URL(s.url).host}</option>)}
            {policy.allowCustomServers ? <option value="__custom">{t(lang, "cx.form.server.custom")}</option> : null}
          </select>
          {custom ? (
            <input placeholder={t(lang, "cx.form.server.url")} value={form.server ?? ""} onChange={(e) => set({ server: e.target.value })}
              onBlur={() => { const n = normalizeServerUrl(form.server ?? ""); if (n) set({ server: n }); }} data-testid="cx-f-server-url" />
          ) : null}
          {foreign ? <span className="ap-hint">{t(lang, "cx.form.server.hint")}</span> : null}
        </label>
        <label className="cx-field">
          <span>{t(lang, "cx.form.mode")}</span>
          <select value={form.mode} onChange={(e) => set({ mode: e.target.value as "light" | "server" })} data-testid="cx-f-mode">
            <option value="server">Server-enhanced</option>
            <option value="light">Light · P2P</option>
          </select>
        </label>
        <label className="cx-field">
          <span>{t(lang, "cx.form.retention")}</span>
          <select value={form.retention} onChange={(e) => set({ retention: e.target.value as ChatRetention })} data-testid="cx-f-retention">
            {RETENTIONS.map((r) => <option key={r} value={r}>{t(lang, `data.${r}`)}</option>)}
          </select>
        </label>
        <label className="cx-field">
          <span>{t(lang, "cx.form.ttl")}</span>
          <select value={String(form.ttlMinutes ?? 0)} onChange={(e) => set({ ttlMinutes: Number(e.target.value) })} data-testid="cx-f-ttl">
            {TTL_OPTIONS.map((m) => <option key={m} value={m}>{m === 0 ? t(lang, "cx.form.ttl.off") : formatDuration(m * 60_000)}</option>)}
          </select>
        </label>
        <label className="cx-field">
          <span>{t(lang, "cx.form.keepalive")}</span>
          <select value={form.keepalive} onChange={(e) => set({ keepalive: e.target.value as Keepalive })} data-testid="cx-f-keepalive">
            {KEEPALIVES.map((k) => <option key={k} value={k}>{t(lang, `keepalive.${k}`)}</option>)}
          </select>
        </label>
      </div>
      <div className="cx-switches">
        <Switch label={t(lang, "cx.form.away")} hint={t(lang, "cx.form.away.hint")} checked={!foreign && Boolean(form.away)} disabled={foreign || form.retention !== "server"} onChange={(away) => set({ away })} testId="cx-f-away" />
        <Switch label={t(lang, "cx.form.notifications")} checked={Boolean(form.notifications)} onChange={(notifications) => set({ notifications })} testId="cx-f-notify" />
        <Switch label={t(lang, "cx.form.autoReconnect")} checked={Boolean(form.autoReconnect)} onChange={(autoReconnect) => set({ autoReconnect })} testId="cx-f-reconnect" />
      </div>
      {error ? <p className="cx-error" role="alert" data-testid="cx-error">{error}</p> : null}
      <div className="cx-actions">
        <button type="submit" className="cx-btn cx-btn--primary" data-testid="cx-f-save"><Save className="h-4 w-4" />{t(lang, "cx.form.save")}</button>
        <button type="button" className="cx-btn" onClick={() => submit(true)} data-testid="cx-f-save-connect"><Plug className="h-4 w-4" />{t(lang, "cx.form.saveConnect")}</button>
        <button type="button" className="cx-btn cx-btn--ghost" onClick={props.onDone}><Undo2 className="h-4 w-4" />{t(lang, "cx.form.cancel")}</button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------- detail */

type LogFilter = "all" | "session" | "people" | "files" | "errors";
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
  return (
    <div className="cx-detail" data-testid="cx-detail">
      <div className="cx-detail__head">
        <button type="button" className="cx-btn cx-btn--ghost" onClick={props.onBack}><Undo2 className="h-4 w-4" />{t(lang, "cx.log.back")}</button>
        <h3 className="cx-form__title">{profile.label}</h3>
        <button type="button" className="cx-icon" onClick={props.onEdit} aria-label={t(lang, "cx.edit")}><Pencil className="h-4 w-4" /></button>
      </div>
      <div className="cx-stats" data-testid="cx-stats">
        {tiles.map(([label, value]) => (
          <div key={label} className="cx-stat"><span className="cx-stat__value">{value}</span><span className="cx-stat__label">{label}</span></div>
        ))}
      </div>
      <div className="cx-log-head">
        <h4>{t(lang, "cx.log")}</h4>
        <div className="ap-seg" role="radiogroup" aria-label={t(lang, "cx.log")}>
          {(["all", "session", "people", "files", "errors"] as LogFilter[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className="ap-seg__btn" onClick={() => setFilter(f)} data-testid={`cx-log-${f}`}>{t(lang, `cx.log.filter.${f}`)}</button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? <p className="cx-empty">{t(lang, "cx.log.empty")}</p> : (
        <ol className="cx-log" data-testid="cx-log">
          {shown.slice(0, 300).map((e: LogEntry, i) => (
            <li key={`${e.at}-${i}`} className={`cx-log__row is-${e.event}`}>
              <time dateTime={new Date(e.at).toISOString()} title={formatFullDate(e.at, lang, props.timezone)}>{formatLogTime(e.at, lang, props.timezone)}</time>
              <span className="cx-log__event">{t(lang, `cx.ev.${e.event}`)}</span>
              {e.detail ? <span className="cx-log__detail">{e.detail}</span> : null}
            </li>
          ))}
        </ol>
      )}
      <div className="cx-actions">
        <button type="button" className="cx-btn" onClick={exportJson} data-testid="cx-export">{t(lang, "cx.log.export")}</button>
        <button type="button" className="cx-btn cx-btn--danger" onClick={() => { if (window.confirm(t(lang, "cx.log.clear.confirm"))) props.onClearLog(id); }} data-testid="cx-clear-log">{t(lang, "cx.log.clear")}</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ settings */

function SettingsView(props: ConnectionsPanelProps) {
  const { lang, state, policy } = props;
  const st = state.settings;
  return (
    <div className="cx-settings" data-testid="cx-settings">
      <label className="cx-field">
        <span>{t(lang, "cx.set.default")}</span>
        <select value={st.defaultId ?? ""} onChange={(e) => props.onDefault(e.target.value || null)} data-testid="cx-s-default">
          <option value="">{t(lang, "cx.set.default.none")}</option>
          {state.profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <div className="cx-switches">
        <Switch label={t(lang, "cx.set.autoConnect")} hint={t(lang, "cx.set.autoConnect.hint")} checked={st.autoConnect} onChange={(autoConnect) => props.onSettings({ autoConnect })} testId="cx-s-autoconnect" />
        <Switch label={t(lang, "cx.set.autoReconnect")} checked={st.autoReconnect} onChange={(autoReconnect) => props.onSettings({ autoReconnect })} testId="cx-s-autoreconnect" />
        <Switch label={t(lang, "cx.set.reconnectOnResume")} checked={st.reconnectOnResume} onChange={(reconnectOnResume) => props.onSettings({ reconnectOnResume })} testId="cx-s-resume" />
        <Switch label={t(lang, "cx.set.collectStats")} hint={policy.stats ? undefined : t(lang, "cx.set.collectStats.off")} checked={st.collectStats} disabled={!policy.stats} onChange={(collectStats) => props.onSettings({ collectStats })} testId="cx-s-stats" />
        <Switch label={t(lang, "cx.set.quickSwitch")} checked={st.quickSwitch} onChange={(quickSwitch) => props.onSettings({ quickSwitch })} testId="cx-s-quickswitch" />
        <Switch label={t(lang, "cx.set.confirmSwitch")} checked={st.confirmSwitch} onChange={(confirmSwitch) => props.onSettings({ confirmSwitch })} testId="cx-s-confirm" />
      </div>
      <p className="cx-intro">{tf(lang, "cx.set.storage", { n: state.profiles.length, size: formatBytes(props.storedBytes) })}</p>
    </div>
  );
}
