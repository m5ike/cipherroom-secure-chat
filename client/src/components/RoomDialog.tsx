// The Room window (the logo, top left): the connection type as tabs in the
// window's header, the tab's content, and a part that is always there —
// Connect / Reconnect, Disconnect and Share this room.
//
//   Light · P2P       name, room ID and key, typed in
//   Server-enhanced   the account's saved connections to pick from (no
//                     buttons on them — those live in My connections), or
//                     "another room" typed in; a gear opens My connections.
//                     4.0: only for a passkey sign-in — signed out, the tab
//                     says so and links to the Connection window
//
// While a connection is up, nothing can be switched: the tabs and the other
// connections are disabled until Disconnect. The connecting itself stays in
// App.tsx; this file shows the choice and reports it.

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  Check, Eye, EyeOff, KeyRound, Lock, LogOut, PencilLine, Plug, Plus, Radio, RefreshCw, Server, Settings, Star, Zap,
} from "lucide-react";
import { t, tf, type Lang } from "../lib/i18n";
import type { ConnectionProfile, ConnectionsState } from "../lib/connections";
import { NeedSignIn } from "./NeedSignIn";
import "../room.css";

export type RoomTab = "light" | "server";
/** What Connect joins: a saved connection, or the room typed in. */
export type RoomTarget = { kind: "manual" } | { kind: "profile"; id: string };

const TABS: ReadonlyArray<{ id: RoomTab; icon: typeof Zap; long: string; short: string }> = [
  { id: "light", icon: Zap, long: "room.tab.light", short: "room.tab.light.short" },
  { id: "server", icon: Server, long: "room.tab.server", short: "room.tab.server.short" },
];

/** The tabs, rendered in the window's header in place of its title. */
export function RoomTabs({ lang, tab, locked, onTab }: { lang: Lang; tab: RoomTab; locked: boolean; onTab: (tab: RoomTab) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (locked || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const next = TABS[(TABS.findIndex((x) => x.id === tab) + 1) % TABS.length];
    onTab(next.id);
    refs.current[TABS.indexOf(next)]?.focus();
  };
  return (
    <div className="rd-tabs" role="tablist" aria-label={t(lang, "room.tabs")} onKeyDown={onKeyDown} data-testid="room-tabs">
      {TABS.map((x, i) => {
        const Icon = x.icon;
        const selected = tab === x.id;
        return (
          <button
            key={x.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={`rd-tab-${x.id}`}
            aria-selected={selected}
            aria-controls="rd-panel"
            tabIndex={selected ? 0 : -1}
            disabled={locked && !selected}
            title={locked && !selected ? t(lang, "room.locked") : undefined}
            className="rd-tab"
            onClick={() => onTab(x.id)}
            data-testid={`room-tab-${x.id}`}
          >
            <Icon className="rd-tab__icon" aria-hidden="true" />
            <span className="rd-tab__long">{t(lang, x.long)}</span>
            <span className="rd-tab__short" aria-hidden="true">{t(lang, x.short)}</span>
          </button>
        );
      })}
    </div>
  );
}

export type RoomDialogProps = {
  lang: Lang;
  tab: RoomTab;
  /** A connection is up (or on its way): nothing may be switched. */
  locked: boolean;
  /** In the room now: the main button reads Reconnect. */
  joined: boolean;
  /** Deriving the key or opening the socket: the main button waits. */
  busy: boolean;
  fields: { name: string; room: string; passphrase: string };
  onField: (patch: Partial<{ name: string; room: string; passphrase: string }>) => void;
  saved: {
    /** The operator allows saved connections. */
    enabled: boolean;
    signedIn: boolean;
    /** The vault is open (connections loaded). */
    ready: boolean;
    state: ConnectionsState;
    /** The saved connection in use (or last used). */
    activeId: string | null;
  };
  onConnect: (target: RoomTarget) => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onManage: () => void;
  onCreate: () => void;
  onSignIn: () => void;
  /** Share this room — the always-visible part below the buttons. */
  share: ReactNode;
};

/** The connection a fresh dialog points at: in use, default, last used, first. */
function initialPick(state: ConnectionsState, activeId: string | null): string {
  const ids = new Set(state.profiles.map((p) => p.id));
  if (activeId && ids.has(activeId)) return activeId;
  if (state.settings.defaultId && ids.has(state.settings.defaultId)) return state.settings.defaultId;
  const recent = [...state.profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
  return recent?.id ?? "manual";
}

export function RoomDialog(props: RoomDialogProps) {
  const { lang, tab, locked, joined, busy, saved } = props;
  const listed = saved.enabled && saved.signedIn && saved.ready;
  const profiles = saved.state.profiles;
  const [pick, setPick] = useState<string>(() => initialPick(saved.state, saved.activeId));

  // Back from My connections: a deleted pick falls back, a new one is picked.
  const knownIds = useRef<Set<string>>(new Set(profiles.map((p) => p.id)));
  useEffect(() => {
    const ids = new Set(profiles.map((p) => p.id));
    const added = profiles.filter((p) => !knownIds.current.has(p.id));
    knownIds.current = ids;
    if (locked) return;
    if (added.length === 1) setPick(added[0].id);
    else if (pick !== "manual" && !ids.has(pick)) setPick(initialPick(saved.state, saved.activeId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles]);
  // The vault opened while the window was open: point at the usual one.
  useEffect(() => {
    if (listed && pick === "manual" && profiles.length > 0 && !locked) setPick(initialPick(saved.state, saved.activeId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed]);

  // While connected the choice is the connection in use.
  const selected = locked ? (saved.activeId && profiles.some((p) => p.id === saved.activeId) ? saved.activeId : "manual") : pick;
  const selectedProfile = tab === "server" && listed ? profiles.find((p) => p.id === selected) ?? null : null;
  // Signed out, Server-enhanced has nothing to connect: no fields, no button.
  const needsSignIn = tab === "server" && !saved.signedIn;
  const manual = tab === "light" || (!needsSignIn && (!listed || selected === "manual"));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (joined) { props.onReconnect(); return; }
    props.onConnect(selectedProfile ? { kind: "profile", id: selectedProfile.id } : { kind: "manual" });
  };

  const connectLabel = joined
    ? t(lang, "join.reconnect")
    : selectedProfile ? tf(lang, "room.connectTo", { name: selectedProfile.label }) : t(lang, "join.connect");

  return (
    <div className="rd" data-tab={tab}>
      <form data-testid="form-join" onSubmit={submit} autoComplete="off" className="rd-form">
        <div role="tabpanel" id="rd-panel" aria-labelledby={`rd-tab-${tab}`} className="rd-panel" data-testid={`room-panel-${tab}`}>
          <p className="rd-hint">{t(lang, tab === "light" ? "room.hint.light" : "room.hint.server")}</p>

          {tab === "server" ? (
            <SavedList
              {...props}
              listed={listed}
              selected={selected}
              onPick={(id) => { if (!locked) setPick(id); }}
            />
          ) : null}

          {manual ? <ManualFields {...props} disabled={locked} /> : null}

          {locked ? (
            <p className="rd-locked" data-testid="room-locked"><Lock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />{t(lang, "room.locked")}</p>
          ) : null}
        </div>

        <div className="rd-actions">
          <button data-testid="button-connect" type="submit" className="rd-btn rd-btn--primary" disabled={busy || (needsSignIn && !joined)}>
            {joined ? <RefreshCw className="h-4 w-4 flex-none" aria-hidden="true" /> : <Radio className="h-4 w-4 flex-none" aria-hidden="true" />}
            <span className="truncate">{connectLabel}</span>
          </button>
          {locked ? (
            <button type="button" data-testid="button-disconnect" onClick={props.onDisconnect} className="rd-btn">
              <LogOut className="h-4 w-4 flex-none" aria-hidden="true" />
              {t(lang, "common.disconnect")}
            </button>
          ) : null}
        </div>
      </form>
      <div className="rd-share">{props.share}</div>
    </div>
  );
}

/* ------------------------------------------------------ typed in by hand */

function ManualFields({ lang, fields, onField, disabled }: RoomDialogProps & { disabled: boolean }) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div className="rd-fields" data-testid="room-manual-fields">
      <label className="rd-field">
        <span>{t(lang, "join.name")}</span>
        <input data-testid="input-name" className="rd-input" value={fields.name} disabled={disabled}
          onChange={(event) => onField({ name: event.target.value })} maxLength={42} />
      </label>
      <label className="rd-field">
        <span>{t(lang, "join.room")}</span>
        <input data-testid="input-room" className="rd-input rd-input--mono" value={fields.room} disabled={disabled}
          onChange={(event) => onField({ room: event.target.value })} maxLength={48} />
      </label>
      <label className="rd-field rd-field--wide">
        <span>{t(lang, "join.passphrase")}</span>
        <span className="rd-key">
          <input data-testid="input-passphrase" className="rd-input" value={fields.passphrase} disabled={disabled}
            onChange={(event) => onField({ passphrase: event.target.value })}
            type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} />
          <button type="button" className="rd-eye" onClick={() => setShowKey((v) => !v)}
            aria-label={t(lang, showKey ? "cx.form.hide" : "cx.form.show")} title={t(lang, showKey ? "cx.form.hide" : "cx.form.show")}
            aria-pressed={showKey} data-testid="room-key-toggle">
            {showKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          </button>
        </span>
      </label>
    </div>
  );
}

/* ------------------------------------------------ the saved connections */

function SavedList(props: RoomDialogProps & { listed: boolean; selected: string; onPick: (id: string) => void }) {
  const { lang, saved, listed, selected, locked } = props;
  const profiles = saved.state.profiles;
  // The default first, then the most recently used.
  const ordered = useMemo(() => [...profiles].sort((a, b) =>
    Number(b.id === saved.state.settings.defaultId) - Number(a.id === saved.state.settings.defaultId) || b.lastUsedAt - a.lastUsedAt,
  ), [profiles, saved.state.settings.defaultId]);

  if (!saved.signedIn) {
    return <NeedSignIn lang={lang} onOpen={locked ? undefined : props.onSignIn} text={t(lang, "room.signin.text")} testId="room-need" />;
  }
  if (!saved.enabled) {
    return (
      <div className="rd-need" data-testid="room-disabled">
        <span className="rd-need__icon" aria-hidden="true"><Lock className="h-5 w-5" /></span>
        <span className="rd-need__text"><span>{t(lang, "room.disabled")}</span></span>
      </div>
    );
  }
  if (!listed) return <p className="rd-loading" aria-busy="true" data-testid="room-loading">{t(lang, "room.saved.loading")}</p>;

  return (
    <div className="rd-saved">
      <div className="rd-saved__head">
        <span className="rd-saved__title">
          {t(lang, "room.saved.title")}
          <span className="rd-count">{profiles.length}</span>
        </span>
        <button type="button" className="rd-gear" onClick={props.onManage} title={t(lang, "room.saved.manage")} aria-label={t(lang, "room.saved.manage")} data-testid="room-manage">
          <Settings className="h-[1.1rem] w-[1.1rem]" aria-hidden="true" />
        </button>
      </div>

      {profiles.length === 0 ? (
        <div className="rd-empty" data-testid="room-empty">
          <span className="rd-empty__icon" aria-hidden="true"><Plug className="h-5 w-5" /></span>
          <span>{t(lang, "room.saved.empty")}</span>
          <button type="button" className="rd-btn rd-btn--soft" onClick={props.onCreate} disabled={locked} data-testid="room-create">
            <Plus className="h-4 w-4" aria-hidden="true" />{t(lang, "room.saved.create")}
          </button>
        </div>
      ) : null}

      <div className="rd-list" role="radiogroup" aria-label={t(lang, "room.saved.list")} data-testid="room-list">
        {ordered.map((p) => (
          <SavedItem key={p.id} {...props} profile={p} checked={selected === p.id} disabled={locked && selected !== p.id} />
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={selected === "manual"}
          disabled={locked && selected !== "manual"}
          className="rd-item rd-item--manual"
          onClick={() => props.onPick("manual")}
          data-testid="room-item-manual"
        >
          <span className="rd-item__glyph" aria-hidden="true"><PencilLine className="h-4 w-4" /></span>
          <span className="rd-item__text">
            <span className="rd-item__label">{t(lang, "room.manual")}</span>
            <span className="rd-item__sub rd-item__sub--plain">{t(lang, "room.manual.hint")}</span>
          </span>
          <span className="rd-item__check" aria-hidden="true"><Check className="h-3.5 w-3.5" /></span>
        </button>
      </div>
    </div>
  );
}

function SavedItem(props: RoomDialogProps & { profile: ConnectionProfile; checked: boolean; disabled: boolean; onPick: (id: string) => void }) {
  const { lang, profile: p, checked, disabled, saved, locked } = props;
  const isDefault = saved.state.settings.defaultId === p.id;
  const live = locked && checked && saved.activeId === p.id;
  const host = p.server ? new URL(p.server).host : t(lang, "cx.thisServer");
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={`rd-item${live ? " is-live" : ""}`}
      style={p.color ? { ["--cx-color" as string]: p.color } : undefined}
      onClick={() => props.onPick(p.id)}
      data-testid="room-item"
      data-id={p.id}
    >
      <span className="rd-item__dot" aria-hidden="true" />
      <span className="rd-item__text">
        <span className="rd-item__label">
          <span className="truncate">{p.label}</span>
          {isDefault ? <Star className="rd-item__star" aria-label={t(lang, "cx.default")} /> : null}
        </span>
        <span className="rd-item__sub">{p.room} · {p.userName || "—"} · {host}</span>
      </span>
      <span className="rd-item__meta">
        {live ? <span className="rd-live" data-testid="room-item-live"><span className="rd-live__pulse" aria-hidden="true" />{t(lang, "cx.active")}</span>
          : <span className="rd-chip">{t(lang, p.mode === "server" ? "room.mode.server" : "room.mode.light")}</span>}
      </span>
      <span className="rd-item__check" aria-hidden="true"><Check className="h-3.5 w-3.5" /></span>
    </button>
  );
}
