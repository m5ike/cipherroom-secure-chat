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

  it("the policy: weak and unknown is held until confirmed; a saved connection's key is not", () => {
    const weak = estimatePassphrase("heslo123");
    expect(weak.bits).toBeLessThan(WEAK_BITS);
    expect(weakKeyBlocks(weak, { known: false, confirmed: false })).toBe(true);
    expect(weakKeyBlocks(weak, { known: false, confirmed: true })).toBe(false);
    expect(weakKeyBlocks(weak, { known: true, confirmed: false })).toBe(false);
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

  it("a weak key for a room it does not know: the first Connect is held back and says why, the second goes", () => {
    const p = props();
    render(<RoomDialog {...p} />);
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onConnect).not.toHaveBeenCalled();
    expect(p.onWeakKey).toHaveBeenCalledWith(expect.stringMatching(/too weak/));
    expect(screen.getByTestId("key-weak-held")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onConnect).toHaveBeenCalledWith({ kind: "manual" });
  });

  it("a strong key, or the key of a saved connection, connects at once", () => {
    const strong = props({ fields: { name: "Alice", room: "rodina", passphrase: generateRoomKey() } });
    render(<RoomDialog {...strong} />);
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(strong.onConnect).toHaveBeenCalledTimes(1);
    cleanup();
    const saved = saveProfile(emptyState(), { label: "Family", room: "rodina", passphrase: "heslo123", userName: "Alice" }, DEFAULT_CLIENT_CONFIG.connections, 1);
    if (!saved.ok) throw new Error(saved.error);
    const known = props({ saved: { enabled: true, signedIn: true, ready: true, state: saved.state, activeId: null } });
    render(<RoomDialog {...known} />);
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(known.onConnect).toHaveBeenCalledTimes(1);
  });

  it("generates a strong key on one click", () => {
    const p = props();
    render(<RoomDialog {...p} />);
    fireEvent.click(screen.getByTestId("key-generate"));
    const patch = (p.onField as ReturnType<typeof vi.fn>).mock.calls[0][0] as { passphrase: string };
    expect(estimatePassphrase(patch.passphrase).level).toBe("strong");
  });
});
