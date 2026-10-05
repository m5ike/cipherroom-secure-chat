// 6.7 (F-04 of the security analysis): any passphrase used to be accepted, and
// the blind room id lets whoever holds the server's data test guesses
// offline. The room key's strength is now estimated and shown, a weak key for
// a room typed in by hand is held back until the user confirms the room
// already exists, and the blind id costs the same Argon2id as the content key.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { estimatePassphrase, generateRoomKey, weakKeyBlocks, WEAK_BITS } from "../client/src/lib/passphrase-strength";
import { deriveRoomKeys } from "../client/src/lib/envelope";
import { RoomDialog, type RoomDialogProps } from "../client/src/components/RoomDialog";
import { ConnectionsPanel } from "../client/src/components/ConnectionsPanel";
import { ShareSection } from "../client/src/components/SharePanel";
import { emptyState, saveProfile } from "../client/src/lib/connections";
import { DEFAULT_CLIENT_CONFIG } from "../client/src/lib/client-config";

describe("the estimate", () => {
  it("rates what people type first as weak", () => {
    for (const key of ["heslo123", "password1", "Praha2024!", "qwertz", "aaaaaaaaaaaa", "12345678901234", "mojetajneheslo", "MojeRodina1985", "admin", "brno-brno-brno"]) {
      expect(estimatePassphrase(key).level, key).toBe("weak");
    }
  });

  it("counts the room's and the user's name for nothing", () => {
    const e = estimatePassphrase("rodina2024", { room: "rodina", name: "Alice" });
    expect(e.level).toBe("weak");
    expect(e.hints).toEqual(expect.arrayContaining(["context", "year"]));
    expect(estimatePassphrase("Alice-Kq7#vP2m", { name: "Alice" }).bits).toBeLessThan(estimatePassphrase("Alice-Kq7#vP2m").bits);
  });

  it("rates random keys and long phrases as strong", () => {
    expect(estimatePassphrase(generateRoomKey()).level).toBe("strong");
    expect(estimatePassphrase("xK9#mP2$vL7q").level).toBe("strong");
    expect(estimatePassphrase("kun-snih-trava-lampa-okno").level).toBe("strong");
    expect(estimatePassphrase("").level).toBe("empty");
  });

  it("a generated key: 24 characters from an alphabet without look-alikes, in groups of six", () => {
    const k = generateRoomKey();
    expect(k).toMatch(/^[A-HJ-NP-Za-km-z2-9]{6}(-[A-HJ-NP-Za-km-z2-9]{6}){3}$/);
    expect(generateRoomKey()).not.toBe(k);
  });

  it("the policy (6.12): a weak key waits for an explicit yes every time — a saved connection's key too", () => {
    const weak = estimatePassphrase("heslo123");
    expect(weak.bits).toBeLessThan(WEAK_BITS);
    expect(weakKeyBlocks(weak, { known: false, confirmed: false })).toBe(true);
    expect(weakKeyBlocks(weak, { known: false, confirmed: true })).toBe(false);
    // 6.7 let a saved connection's weak key through unmeasured; 6.12 does not.
    expect(weakKeyBlocks(weak, { known: true, confirmed: false })).toBe(true);
    expect(weakKeyBlocks(estimatePassphrase(generateRoomKey()), { known: false, confirmed: false })).toBe(false);
  });
});

describe("the blind room id costs an Argon2id", () => {
  it("is derived from the Argon2id output (other Argon2 cost → another id), never from the name alone", async () => {
    const a = await deriveRoomKeys("rodina", "heslo123", { memoryKiB: 64, passes: 1 });
    const b = await deriveRoomKeys("rodina", "heslo123", { memoryKiB: 64, passes: 2 });
    const c = await deriveRoomKeys("rodina", "heslo124", { memoryKiB: 64, passes: 1 });
    expect(a.roomId).toMatch(/^r3\./);
    expect(a.roomId).not.toBe(b.roomId); // the KDF's cost is in it: no shortcut past Argon2id
    expect(a.roomId).not.toBe(c.roomId);
    expect(a.roomId).not.toContain("rodina");
  });
});

describe("the Room window", () => {
  beforeEach(() => cleanup());
  const props = (over: Partial<RoomDialogProps> = {}): RoomDialogProps => ({
    lang: "en", tab: "light", locked: false, joined: false, busy: false,
    fields: { name: "Alice", room: "rodina", passphrase: "heslo123" },
    onField: vi.fn(),
    saved: { enabled: true, signedIn: true, ready: true, state: emptyState(), activeId: null },
    onConnect: vi.fn(), onReconnect: vi.fn(), onDisconnect: vi.fn(), onManage: vi.fn(), onCreate: vi.fn(), onSignIn: vi.fn(),
    onWeakKey: vi.fn(),
    share: null,
    ...over,
  });

  it("shows the key's strength under the key", () => {
    render(<RoomDialog {...props()} />);
    expect(screen.getByTestId("key-strength").getAttribute("data-level")).toBe("weak");
    expect(screen.getByTestId("key-strength-label").textContent).toMatch(/weak/);
  });

  it("a weak key: Connect asks with the offline-guessing risk; a second Connect asks again — only the explicit yes joins", () => {
    const p = props();
    render(<RoomDialog {...p} />);
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onConnect).not.toHaveBeenCalled();
    expect(p.onWeakKey).toHaveBeenCalledWith(expect.stringMatching(/Weak room key/));
    const box = screen.getByTestId("key-weak-held");
    expect(box.getAttribute("role")).toBe("alertdialog");
    expect(box.textContent).toMatch(/offline/);
    // 6.7 let the second Connect through; 6.12 keeps asking.
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onConnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("key-weak-confirm"));
    expect(p.onConnect).toHaveBeenCalledWith({ kind: "manual" });
    // …and the next Connect asks again (not once per session).
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("key-weak-held")).toBeTruthy();
    fireEvent.click(screen.getByTestId("key-weak-cancel"));
    expect(screen.queryByTestId("key-weak-held")).toBeNull();
    expect(p.onConnect).toHaveBeenCalledTimes(1);
  });

  it("the question offers a strong key instead (a new room)", () => {
    const p = props();
    render(<RoomDialog {...p} />);
    fireEvent.click(screen.getByTestId("button-connect"));
    fireEvent.click(screen.getByTestId("key-weak-generate"));
    const patch = (p.onField as ReturnType<typeof vi.fn>).mock.calls[0][0] as { passphrase: string };
    expect(estimatePassphrase(patch.passphrase).level).toBe("strong");
    expect(p.onConnect).not.toHaveBeenCalled();
  });

  it("a strong key connects at once; a saved connection's weak key asks too (window.confirm), every time", () => {
    const strong = props({ fields: { name: "Alice", room: "rodina", passphrase: generateRoomKey() } });
    render(<RoomDialog {...strong} />);
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(strong.onConnect).toHaveBeenCalledTimes(1);
    cleanup();
    const saved = saveProfile(emptyState(), { label: "Family", room: "rodina", passphrase: "heslo123", userName: "Alice" }, DEFAULT_CLIENT_CONFIG.connections, 1);
    if (!saved.ok) throw new Error(saved.error);
    const known = props({ tab: "server", saved: { enabled: true, signedIn: true, ready: true, state: saved.state, activeId: null } });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    try {
      render(<RoomDialog {...known} />);
      expect(screen.getByTestId("room-item-weak")).toBeTruthy();
      fireEvent.click(screen.getByTestId("button-connect"));
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Family.*weak room key[\s\S]*offline/));
      expect(known.onConnect).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByTestId("button-connect"));
      expect(known.onConnect).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("button-connect"));
      expect(confirm).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });

  it("an empty key: generating a strong key is the primary path for a new room", () => {
    const p = props({ fields: { name: "Alice", room: "rodina", passphrase: "" } });
    render(<RoomDialog {...p} />);
    expect(screen.getByTestId("key-new-hint").textContent).toMatch(/new room/i);
    const gen = screen.getByTestId("key-generate");
    expect(gen.className).toMatch(/rd-btn--primary/);
    expect(gen.textContent).toMatch(/New room/);
  });

  it("generates a strong key on one click", () => {
    const p = props();
    render(<RoomDialog {...p} />);
    fireEvent.click(screen.getByTestId("key-generate"));
    const patch = (p.onField as ReturnType<typeof vi.fn>).mock.calls[0][0] as { passphrase: string };
    expect(estimatePassphrase(patch.passphrase).level).toBe("strong");
  });
});

// 6.12 (F-04): saved connections are measured too, and the share / QR flow asks before passing a weak key on.
describe("My connections and sharing (6.12)", () => {
  beforeEach(() => cleanup());
  const base = (state = emptyState()) => ({
    lang: "en" as const, timezone: "UTC", state, policy: DEFAULT_CLIENT_CONFIG.connections,
    eligible: { enabled: true, signedIn: true, serverMode: true }, activeId: null, connected: false, current: null, storedBytes: 0,
    onConnect: vi.fn(), onDisconnect: vi.fn(), onDelete: vi.fn(), onDefault: vi.fn(), onSettings: vi.fn(), onClearLog: vi.fn(), onSignIn: vi.fn(), onEnableServerMode: vi.fn(),
  });

  it("the editor measures the key; Save with a weak key asks every time, Save anyway saves", () => {
    const onSave = vi.fn((input: { room?: string; passphrase?: string }) => saveProfile(emptyState(), input, DEFAULT_CLIENT_CONFIG.connections, 1));
    render(<ConnectionsPanel {...base()} onSave={onSave as never} startWith="new" />);
    fireEvent.change(screen.getByTestId("cx-f-room"), { target: { value: "rodina" } });
    fireEvent.change(screen.getByTestId("cx-f-key"), { target: { value: "heslo123" } });
    expect(screen.getByTestId("key-strength").getAttribute("data-level")).toBe("weak");
    fireEvent.click(screen.getByTestId("cx-f-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("key-weak-held").textContent).toMatch(/offline/);
    fireEvent.click(screen.getByTestId("key-weak-confirm"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("a strong key saves at once; the list marks a saved weak key and its Connect asks", () => {
    const strong = vi.fn((input: { room?: string; passphrase?: string }) => saveProfile(emptyState(), input, DEFAULT_CLIENT_CONFIG.connections, 1));
    render(<ConnectionsPanel {...base()} onSave={strong as never} startWith="new" />);
    fireEvent.change(screen.getByTestId("cx-f-room"), { target: { value: "rodina" } });
    fireEvent.change(screen.getByTestId("cx-f-key"), { target: { value: generateRoomKey() } });
    fireEvent.click(screen.getByTestId("cx-f-save"));
    expect(strong).toHaveBeenCalledTimes(1);
    cleanup();
    const saved = saveProfile(emptyState(), { label: "Family", room: "rodina", passphrase: "heslo123", userName: "Alice" }, DEFAULT_CLIENT_CONFIG.connections, 1);
    if (!saved.ok) throw new Error(saved.error);
    const p = base(saved.state);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    try {
      render(<ConnectionsPanel {...p} onSave={vi.fn() as never} />);
      expect(screen.getByTestId("cx-weak-badge")).toBeTruthy();
      fireEvent.click(screen.getByTestId("cx-connect"));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(p.onConnect).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("sharing a room with a weak key: the risk is said and the invite waits for an explicit yes", () => {
    render(<ShareSection lang="en" room="rodina" passphrase="heslo123" ready />);
    expect(screen.getByTestId("share-weak").textContent).toMatch(/offline/);
    fireEvent.click(screen.getByTestId("button-share"));
    expect(screen.getByTestId("share-weak-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("share-weak-cancel"));
    expect(screen.queryByTestId("share-weak-confirm")).toBeNull();
    cleanup();
    render(<ShareSection lang="en" room="rodina" passphrase={generateRoomKey()} ready />);
    expect(screen.queryByTestId("share-weak")).toBeNull();
  });
});
