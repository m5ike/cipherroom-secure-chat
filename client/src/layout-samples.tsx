// Made-up props for the components that draw layouts (4.13): the Layout
// builder's preview shows each layout with them in its situations
// (PREVIEW_VARIANTS), and the tests draw the components with the same ones.
// Nothing here talks to a server.

import type { ReactNode } from "react";
import { emptyState, type ConnectionProfile, type ConnectionsState } from "./lib/connections";
import type { Lang } from "./lib/i18n";
import type { RoomDialogProps } from "./components/RoomDialog";
import type { AccountStatus, AccountSummary } from "./lib/account";
import type { ConnectionsPolicy } from "./lib/client-config";
import type { ConnectionsPanelProps } from "./components/ConnectionsPanel";

export const noop = () => undefined;

const NOW = Date.UTC(2026, 8, 24, 10, 0);

function profile(id: string, label: string, extra: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id, label, color: "", room: "tym-brno", passphrase: "correct horse battery", userName: "alice", server: "", mode: "light", retention: "session",
    ttlMinutes: 0, away: false, notifications: true, autoReconnect: true, keepalive: "balanced", createdAt: NOW - 86_400_000, updatedAt: NOW, lastUsedAt: NOW - 3_600_000, ...extra,
  };
}

/** Saved connections: a default one with a colour, one on another server, a Server-enhanced one. */
export function sampleConnections(count = 3): ConnectionsState {
  const state = emptyState();
  const all = [
    profile("c-team", "Tým Brno", { color: "#2f80ed", lastUsedAt: NOW - 60_000 }),
    profile("c-family", "Rodina", { room: "rodina-2026", userName: "", server: "wss://chat.example.org", lastUsedAt: NOW - 7_200_000 }),
    profile("c-ops", "Provoz", { room: "ops", mode: "server", lastUsedAt: NOW - 86_400_000 }),
  ];
  return { ...state, profiles: all.slice(0, count), settings: { ...state.settings, defaultId: count ? "c-team" : null } };
}

/** My connections with numbers and a log (the first one), for the window's detail. */
export function sampleConnectionsFull(count = 3): ConnectionsState {
  const state = sampleConnections(count);
  if (!count) return state;
  return {
    ...state,
    stats: {
      "c-team": {
        connects: 14, failures: 1, reconnects: 3, totalMs: 9_300_000, longestMs: 3_600_000, lastConnectedAt: NOW - 60_000, lastDisconnectedAt: NOW - 30_000,
        sent: 120, received: 342, filesSent: 4, filesReceived: 9, bytesSent: 4_200_000, bytesReceived: 18_900_000, peersMax: 5, errors: 2,
      },
    },
    logs: {
      "c-team": [
        { at: NOW - 3_700_000, event: "created" }, { at: NOW - 3_600_000, event: "connect" }, { at: NOW - 3_590_000, event: "connected" },
        { at: NOW - 3_500_000, event: "peer-joined", detail: "Bob" }, { at: NOW - 3_000_000, event: "file-received", detail: "photos.zip" },
        { at: NOW - 2_000_000, event: "error", detail: "ICE failed" }, { at: NOW - 1_000_000, event: "peer-left", detail: "Bob" }, { at: NOW - 30_000, event: "disconnected" },
      ],
    },
  };
}

/** The policy of the saved connections: another server on the list, one of one's own allowed. */
export function sampleConnectionsPolicy(extra: Partial<ConnectionsPolicy> = {}): ConnectionsPolicy {
  return {
    enabled: true, maxProfiles: 10, logLimit: 500, stats: true, allowCustomServers: true, autoConnectDefault: false,
    servers: [{ id: "example", label: "Example", url: "wss://chat.example.org" }], ...extra,
  };
}

/** "My connections" in its situations (the preview's variants). */
export function connectionsProps(variant: string, lang: Lang): ConnectionsPanelProps {
  const empty = variant === "empty";
  return {
    lang, timezone: "Europe/Prague",
    state: sampleConnectionsFull(empty ? 0 : 3),
    policy: sampleConnectionsPolicy(),
    eligible: { enabled: true, signedIn: variant !== "account", serverMode: variant !== "server" },
    activeId: "c-team", connected: variant === "list",
    current: empty ? { room: "novy-pokoj", passphrase: "k", userName: "Alice" } : null,
    storedBytes: 18_432,
    onConnect: noop, onDisconnect: noop, onSave: () => ({ ok: false, error: "room" }), onDelete: noop, onDefault: noop, onSettings: noop, onClearLog: noop,
    onSignIn: noop, onEnableServerMode: noop,
  };
}

/** The Room window in its situations. */
export function roomProps(variant: string, lang: Lang, share: ReactNode = null): RoomDialogProps {
  const signedOut = variant === "signedout";
  const connected = variant === "connected";
  return {
    lang,
    tab: variant === "light" ? "light" : "server",
    locked: connected,
    joined: connected,
    busy: false,
    fields: { name: "Alice", room: variant === "light" ? "tym-brno" : "", passphrase: "correct horse battery" },
    onField: noop,
    saved: {
      enabled: true,
      signedIn: !signedOut,
      ready: true,
      state: sampleConnections(variant === "empty" ? 0 : 3),
      activeId: connected ? "c-team" : null,
    },
    onConnect: noop,
    onReconnect: noop,
    onDisconnect: noop,
    onManage: noop,
    onCreate: noop,
    onSignIn: noop,
    share,
  };
}

/** A signed-in account: everything the account window can show (`full`), or a new one. */
export function sampleAccount(variant = "full"): AccountSummary {
  const full = variant !== "new";
  return {
    id: "bystry-sokol-7k3q", username: "bystry-sokol-7k3q", groups: ["user"], keyVerified: true, credentialId: "cred-0123456789abcdef0123456789", alg: -7,
    userName: "bystry-sokol-7k3q", createdAt: NOW - 30 * 86_400_000, lastLoginAt: NOW - 3_600_000, loginCount: full ? 42 : 1,
    vault: { profileBytes: full ? 2048 : 0, profileUpdatedAt: full ? NOW - 86_400_000 : 0, chatBytes: full ? 1_234_567 : 0, chatUpdatedAt: full ? NOW - 600_000 : 0, messages: full ? 318 : 0, messageBytes: full ? 912_345 : 0, rooms: full ? 3 : 0 },
    mailbox: { pending: full ? 2 : 0, bytes: full ? 4096 : 0 },
    away: full ? [{ room: "tym-brno", name: "Alice", since: NOW - 7_200_000 }] : [],
    pushDevices: full ? 2 : 0,
    audit: full ? [{ at: NOW - 3_600_000, kind: "login" }, { at: NOW - 7_200_000, kind: "passkey-added", meta: { label: "Phone" } }, { at: NOW - 9_000_000, kind: "something-new" }] as never : [],
    passkeys: full ? [
      { credentialId: "cred-0123456789abcdef0123456789", alg: -7, createdAt: NOW - 30 * 86_400_000, lastUsedAt: NOW - 3_600_000, label: "", primary: true },
      { credentialId: "cred-fedcba9876543210", alg: -8, createdAt: NOW - 86_400_000, lastUsedAt: 0, label: "Phone", primary: false },
    ] : undefined,
    recovery: full ? { set: true, createdAt: NOW - 86_400_000 } : { set: false },
    identity: full ? { publicKey: "MCowBQYDK2VwAyEAy1uGQ9xg1v3m5cet-sample-public-key", updatedAt: NOW } : null,
    sessions: full ? [
      { id: "s1", createdAt: NOW - 86_400_000, lastUsedAt: NOW - 60_000, expiresAt: NOW + 86_400_000, client: "Firefox · macOS", ip: "203.0.113.9", current: true },
      { id: "s2", createdAt: NOW - 86_400_000, lastUsedAt: NOW - 7_200_000, expiresAt: NOW + 86_400_000, client: "", ip: "", current: false },
    ] : undefined,
  };
}

export const SAMPLE_STATUS: AccountStatus = { available: true, persistent: true, rpId: "chat.example.org", accounts: 12, limits: { profileChars: 10_000, chatChars: 1_000_000, mailboxItems: 500 } };
