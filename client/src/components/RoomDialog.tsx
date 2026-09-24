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
//
// 4.13: both are layouts ("room.tabs", "room" — lib/layouts/room.ts) the
// operator can redesign; the choosing, the keyboard and the state stay here.

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { t, tf, type Lang } from "../lib/i18n";
import type { ConnectionsState } from "../lib/connections";
import { NeedSignIn } from "./NeedSignIn";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import "../room.css";

export type RoomTab = "light" | "server";
/** What Connect joins: a saved connection, or the room typed in. */
export type RoomTarget = { kind: "manual" } | { kind: "profile"; id: string };

const TABS: ReadonlyArray<{ id: RoomTab; icon: string; long: string; short: string }> = [
  { id: "light", icon: "zap", long: "room.tab.light", short: "room.tab.light.short" },
  { id: "server", icon: "server", long: "room.tab.server", short: "room.tab.server.short" },
];

/** The tabs, rendered in the window's header in place of its title. */
export function RoomTabs({ lang, tab, locked, onTab }: { lang: Lang; tab: RoomTab; locked: boolean; onTab: (tab: RoomTab) => void }) {
  const { tree, base } = useLayoutBase("room.tabs", lang);
  const tabs = TABS.map((x) => ({ ...x, selected: tab === x.id, disabled: locked && tab !== x.id }));
  return renderLayout(tree, {
    ...base,
    data: { tabs, locked },
    actions: {
      tab: (_e, id) => onTab(id as RoomTab),
      // Arrow keys move between tabs (WAI-ARIA tabs pattern).
      tabKey: (event) => {
        const e = event as KeyboardEvent<HTMLDivElement>;
        if (locked || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        const next = TABS[(TABS.findIndex((x) => x.id === tab) + 1) % TABS.length];
        onTab(next.id);
        document.getElementById(`rd-tab-${next.id}`)?.focus();
      },
    },
  });
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
  const { tree, base } = useLayoutBase("room", lang);
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

  // The saved connections: the default first, then the most recently used.
  const defaultId = saved.state.settings.defaultId;
  const ordered = useMemo(() => [...profiles].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || b.lastUsedAt - a.lastUsedAt), [profiles, defaultId]);
  const items = ordered.map((p) => {
    const checked = selected === p.id;
    return {
      id: p.id, label: p.label, room: p.room, user: p.userName || "—", host: p.server ? new URL(p.server).host : t(lang, "cx.thisServer"),
      mode: p.mode, color: p.color ?? "", isDefault: defaultId === p.id, checked, disabled: locked && !checked, live: locked && checked && saved.activeId === p.id,
    };
  });
  // The key shown or not: back to hidden whenever the fields go away.
  const [showKey, setShowKey] = useState(false);
  useEffect(() => { if (!manual) setShowKey(false); }, [manual]);
  const field = (key: "name" | "room" | "passphrase") => (event: unknown) => props.onField({ [key]: (event as ChangeEvent<HTMLInputElement>).target.value });

  return renderLayout(tree, {
    ...base,
    data: {
      tab, locked, joined, busy, signedIn: saved.signedIn, savedEnabled: saved.enabled, listed, needsSignIn, manual,
      items, selected, fields: props.fields, showKey, connectLabel,
    },
    actions: {
      submit: (event) => submit(event as FormEvent),
      disconnect: () => props.onDisconnect(),
      pick: (_e, id) => { if (!locked) setPick(String(id)); },
      manage: () => props.onManage(),
      create: () => props.onCreate(),
      fieldName: field("name"),
      fieldRoom: field("room"),
      fieldKey: field("passphrase"),
      toggleKey: () => setShowKey((v) => !v),
    },
    slots: {
      needSignIn: () => <NeedSignIn lang={lang} onOpen={locked ? undefined : props.onSignIn} text={t(lang, "room.signin.text")} testId="room-need" />,
      share: () => props.share,
    },
  });
}
