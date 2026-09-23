// @vitest-environment node
//
// Saved connections (client/src/lib/connections.ts) and the operator's
// policy for them (client-config.ts): what may be stored, the limits, which
// servers, the statistics and the log, and how the store batches its trips
// to the vault.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ConnectionsStore, deleteProfile, emptyState, formatDuration, record, sanitizeState, saveProfile, startupProfile,
  type ConnectionsState,
} from "../client/src/lib/connections";
import { DEFAULT_CLIENT_CONFIG, normalizeServerUrl, sanitizeClientConfig, serverAllowed, signalingUrl, allowedThemes } from "../client/src/lib/client-config";

const policy = { ...DEFAULT_CLIENT_CONFIG.connections, maxProfiles: 3, logLimit: 5 };
afterEach(() => { vi.useRealTimers(); });

const add = (s: ConnectionsState, room: string, extra: Record<string, unknown> = {}) => {
  const r = saveProfile(s, { label: room.toUpperCase(), room, passphrase: "key-" + room, userName: "Alice", ...extra }, policy, 1_000);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("editing connections", () => {
  it("adds, updates, makes the first one default, deletes", () => {
    let s = emptyState(policy);
    const a = add(s, "Brno Team");
    s = a.state;
    expect(a.profile).toMatchObject({ room: "brno-team", label: "BRNO TEAM", mode: "server", retention: "server", away: true, autoReconnect: true });
    expect(a.profile.id).toMatch(/^cx-/);
    expect(s.settings.defaultId).toBe(a.profile.id);
    expect(s.logs[a.profile.id]).toEqual([expect.objectContaining({ event: "created" })]);

    const b = add(s, "praha");
    s = b.state;
    const edited = saveProfile(s, { id: b.profile.id, room: "praha", passphrase: "new-key", ttlMinutes: 60 }, policy, 2_000);
    if (!edited.ok) throw new Error(edited.error);
    expect(edited.profile).toMatchObject({ passphrase: "new-key", ttlMinutes: 60, createdAt: 1_000, updatedAt: 2_000, userName: "Alice" });

    s = deleteProfile(edited.state, a.profile.id);
    expect(s.profiles.map((p) => p.room)).toEqual(["praha"]);
    expect(s.settings.defaultId).toBe(b.profile.id);
    expect(s.logs[a.profile.id]).toBeUndefined();
  });

  it("refuses what cannot work, and more than the operator allows", () => {
    let s = emptyState(policy);
    expect(saveProfile(s, { room: "  ", passphrase: "x" }, policy)).toMatchObject({ ok: false, error: "room" });
    expect(saveProfile(s, { room: "a", passphrase: "" }, policy)).toMatchObject({ ok: false, error: "passphrase" });
    expect(saveProfile(s, { room: "a", passphrase: "x", server: "wss://other.example" }, policy)).toMatchObject({ ok: false, error: "server" });
    expect(saveProfile(s, { id: "cx-nothere000", room: "a", passphrase: "x" }, policy)).toMatchObject({ ok: false, error: "missing" });
    for (const room of ["a", "b", "c"]) s = add(s, room).state;
    expect(saveProfile(s, { room: "d", passphrase: "x" }, policy)).toMatchObject({ ok: false, error: "limit" });
  });

  it("uses another signaling server only when the operator lists it (or allows any)", () => {
    const listed = { ...policy, servers: [{ id: "eu", label: "EU", url: "wss://eu.example/ws" }] };
    const ok = saveProfile(emptyState(listed), { room: "x", passphrase: "k", server: "https://eu.example/ws/" }, listed);
    expect(ok).toMatchObject({ ok: true, profile: { server: "wss://eu.example/ws", away: false } });
    expect(saveProfile(emptyState(listed), { room: "x", passphrase: "k", server: "wss://evil.example" }, listed)).toMatchObject({ ok: false });
    expect(saveProfile(emptyState({ ...policy, allowCustomServers: true }), { room: "x", passphrase: "k", server: "wss://any.example" }, { ...policy, allowCustomServers: true })).toMatchObject({ ok: true });
  });
});

describe("statistics and the log", () => {
  it("counts sessions, messages and files, and keeps the log bounded", () => {
    let s = add(emptyState(policy), "room").state;
    const id = s.profiles[0].id;
    s = record(s, id, "connect", undefined, policy, 10);
    s = record(s, id, "connected", "2 people", policy, 20, { peers: 2 });
    for (let i = 0; i < 4; i++) s = record(s, id, "sent", undefined, policy, 30 + i);
    s = record(s, id, "received", undefined, policy, 40);
    s = record(s, id, "file-received", "photo.jpg", policy, 50, { bytes: 1234 });
    s = record(s, id, "disconnected", undefined, policy, 60, { durationMs: 90_000 });
    expect(s.stats[id]).toMatchObject({ connects: 1, sent: 4, received: 1, filesReceived: 1, bytesReceived: 1234, totalMs: 90_000, longestMs: 90_000, peersMax: 2 });
    expect(s.profiles[0].lastUsedAt).toBe(10);
    // Messages count but do not flood the log; the log keeps the last 5.
    expect(s.logs[id].map((e) => e.event)).toEqual(["created", "connect", "connected", "file-received", "disconnected"]);
    s = record(s, id, "error", "boom", policy, 70);
    expect(s.logs[id]).toHaveLength(5);
    expect(s.logs[id].at(-1)).toMatchObject({ event: "error", detail: "boom" });
  });

  it("keeps nothing when the user (or the operator) switches statistics off", () => {
    let s = add(emptyState(policy), "room").state;
    const id = s.profiles[0].id;
    s = { ...s, settings: { ...s.settings, collectStats: false } };
    s = record(s, id, "connected", undefined, policy, 5);
    expect(s.stats[id]).toBeUndefined();
    const off = sanitizeState({ ...s, settings: { ...s.settings, collectStats: true } }, { ...policy, stats: false });
    expect(off.settings.collectStats).toBe(false);
  });

  it("formats durations for people", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe("3 h 12 min");
    expect(formatDuration(50 * 3_600_000)).toBe("2 d 2 h");
  });
});

describe("what comes back from the vault", () => {
  it("is sanitized: junk dropped, limits applied, dangling references cleared", () => {
    const raw = {
      profiles: [
        { id: "cx-aaaaaaaa", room: "Ok Room", passphrase: "k", server: "javascript:alert(1)", color: "#ABCDEF", keepalive: "turbo" },
        { id: "bad", room: "x", passphrase: "k" },
        { id: "cx-bbbbbbbb", room: "", passphrase: "k" },
        { id: "cx-cccccccc", room: "two", passphrase: "k", retention: "forever", ttlMinutes: 1e12 },
      ],
      settings: { defaultId: "cx-gone0000", autoConnect: "yes" },
      stats: { "cx-aaaaaaaa": { connects: 3, sent: -5 }, "cx-zzzzzzzz": { connects: 9 } },
      logs: { "cx-aaaaaaaa": [{ at: 1, event: "connected" }, { at: 2, event: "hacked" }] },
    };
    const s = sanitizeState(raw, policy);
    expect(s.profiles.map((p) => p.id)).toEqual(["cx-aaaaaaaa", "cx-cccccccc"]);
    expect(s.profiles[0]).toMatchObject({ room: "ok-room", server: "", color: "#abcdef", keepalive: "balanced" });
    expect(s.profiles[1]).toMatchObject({ retention: "server", ttlMinutes: 60 * 24 * 30 });
    expect(s.settings).toMatchObject({ defaultId: null, autoConnect: true });
    expect(s.stats).toEqual({ "cx-aaaaaaaa": expect.objectContaining({ connects: 3, sent: 0 }) });
    expect(s.logs["cx-aaaaaaaa"]).toEqual([{ at: 1, event: "connected" }]);
    expect(startupProfile(s)?.id).toBe("cx-aaaaaaaa");
  });
});

describe("the store", () => {
  it("saves edits at once and batches counters", async () => {
    vi.useFakeTimers();
    const saved: ConnectionsState[] = [];
    const store = new ConnectionsStore(async (s) => { saved.push(s); }, policy, 5_000);
    const r = store.save({ room: "live", passphrase: "k" });
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    const id = store.get().profiles[0].id;
    store.record(id, "connected");
    store.record(id, "sent");
    store.record(id, "sent");
    expect(saved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saved).toHaveLength(2);
    expect(saved[1].stats[id]).toMatchObject({ connects: 1, sent: 2 });
    // A disconnect without a session is not counted.
    store.record("cx-unknown00", "disconnected");
    store.record(id, "disconnected");
    await store.flush();
    expect(saved.at(-1)!.stats[id].totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe("the operator's policy", () => {
  it("normalizes server addresses and refuses unsafe ones", () => {
    expect(normalizeServerUrl("chat.example.com")).toBe("wss://chat.example.com");
    expect(normalizeServerUrl("https://chat.example.com/ws/")).toBe("wss://chat.example.com/ws");
    expect(normalizeServerUrl("ws://localhost:5000")).toBe("ws://localhost:5000");
    expect(normalizeServerUrl("ws://chat.example.com")).toBeNull();
    expect(normalizeServerUrl("wss://user:pw@chat.example.com")).toBeNull();
    expect(normalizeServerUrl("wss://chat.example.com/?token=1")).toBeNull();
    expect(normalizeServerUrl("javascript:alert(1)")).toBeNull();
    expect(signalingUrl("wss://chat.example.com")).toBe("wss://chat.example.com/ws");
    expect(signalingUrl("wss://chat.example.com/custom/ws")).toBe("wss://chat.example.com/custom/ws");
    expect(serverAllowed(policy, "")).toBe(true);
  });

  it("sanitizes what the console sends", () => {
    const c = sanitizeClientConfig({
      connections: { enabled: false, maxProfiles: 9999, logLimit: -1, servers: [{ label: "EU <b>", url: "eu.example" }, { url: "eu.example" }, { url: "http://x" }] },
      appearance: { themes: ["ios", "windows", "nope"], defaultTheme: "motorsport", defaultTone: "dark", defaultIcons: "sparkles", lockTheme: true },
    });
    expect(c.connections).toMatchObject({ enabled: false, maxProfiles: 200, logLimit: 0, servers: [{ id: "srv-1", label: "EU <b>", url: "wss://eu.example" }] });
    expect(c.appearance).toMatchObject({ themes: ["ios", "windows"], defaultTheme: "ios", defaultTone: "dark", defaultIcons: "theme", lockTheme: true });
    expect(allowedThemes(c.appearance)).toEqual(["ios"]);
    expect(allowedThemes(DEFAULT_CLIENT_CONFIG.appearance).length).toBeGreaterThanOrEqual(13);
  });
});
