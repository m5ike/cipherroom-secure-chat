import { describe, expect, it } from "vitest";
import { createMemoryVault, createSessionCache, SESSION_IDLE_LIMIT_MS, type SessionData } from "../client/src/lib/session-cache";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

const DATA: SessionData = { name: "Alice", room: "brno-secure", passphrase: "correct horse — žluťoučký 🔐", desired: "connected" };

describe("session cache", () => {
  it("round-trips across a simulated reload (same tab storage, same vault)", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    await createSessionCache({ storage, vault }).save(DATA);
    expect(await createSessionCache({ storage, vault }).load()).toEqual(DATA);
  });

  it("remembers another signaling server and the saved connection a session came from", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const withOrigin: SessionData = { ...DATA, server: "wss://chat-eu.example.org", profileId: "cx-abc123def" };
    await createSessionCache({ storage, vault }).save(withOrigin);
    expect(await createSessionCache({ storage, vault }).load()).toEqual(withOrigin);
  });

  it("keeps nothing readable in storage — no name, room or key in the clear", async () => {
    const storage = memoryStorage();
    await createSessionCache({ storage, vault: createMemoryVault() }).save(DATA);
    const raw = storage.getItem("m5cet:session:v1")!;
    for (const secret of ["Alice", "brno-secure", "correct horse", "connected"]) expect(raw).not.toContain(secret);
  });

  it("uses a non-extractable wrapping key", async () => {
    const vault = createMemoryVault(); const storage = memoryStorage();
    await createSessionCache({ storage, vault }).save(DATA);
    const id = JSON.parse(storage.getItem("m5cet:session:v1")!).id as string;
    const key = (await vault.get(id))!;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("is gone when the tab is gone: fresh tab storage sees no session", async () => {
    const vault = createMemoryVault();
    await createSessionCache({ storage: memoryStorage(), vault }).save(DATA);
    expect(await createSessionCache({ storage: memoryStorage(), vault }).load()).toBeNull();
  });

  it("expires after one hour without activity and wipes itself", async () => {
    let t = 1_000_000; const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault, now: () => t });
    await cache.save(DATA);
    t += SESSION_IDLE_LIMIT_MS - 1;
    expect(await cache.load()).toEqual(DATA);
    t += 2;
    expect(await cache.load()).toBeNull();
    expect(storage.getItem("m5cet:session:v1")).toBeNull();
  });

  it("activity pushes the deadline out", async () => {
    let t = 1_000_000; const storage = memoryStorage();
    const cache = createSessionCache({ storage, vault: createMemoryVault(), now: () => t });
    await cache.save(DATA);
    t += SESSION_IDLE_LIMIT_MS - 1000; cache.touch();
    expect(cache.idleMs()).toBe(0);
    t += SESSION_IDLE_LIMIT_MS - 1000;
    expect(await cache.load()).toEqual(DATA);
  });

  it("rejects a tampered or transplanted record instead of trusting it", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault });
    await cache.save(DATA);
    const rec = JSON.parse(storage.getItem("m5cet:session:v1")!);
    rec.ct = (rec.ct[0] === "A" ? "B" : "A") + rec.ct.slice(1);
    storage.setItem("m5cet:session:v1", JSON.stringify(rec));
    expect(await cache.load()).toBeNull();
    expect(storage.getItem("m5cet:session:v1")).toBeNull();
  });

  it("without the key (e.g. cleared IndexedDB) the ciphertext is useless", async () => {
    const storage = memoryStorage();
    await createSessionCache({ storage, vault: createMemoryVault() }).save(DATA);
    expect(await createSessionCache({ storage, vault: createMemoryVault() }).load()).toBeNull();
  });

  it("updates the desired state in place and clear() removes key and record", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault });
    await cache.save(DATA);
    const id = JSON.parse(storage.getItem("m5cet:session:v1")!).id as string;
    await cache.save({ ...DATA, desired: "disconnected" });
    expect(JSON.parse(storage.getItem("m5cet:session:v1")!).id).toBe(id);   // same tab key reused
    expect((await cache.load())?.desired).toBe("disconnected");
    await cache.clear();
    expect(await cache.load()).toBeNull();
    expect(await vault.get(id)).toBeNull();
  });

  it("Disconnect takes effect synchronously — a reload right after the click stays disconnected", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault });
    await cache.save(DATA);
    cache.forceDisconnected();                       // no await: this is the click
    expect((await createSessionCache({ storage, vault }).load())?.desired).toBe("disconnected");
  });

  it("a Disconnect that lands during an in-flight 'connected' save still wins", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault });
    await cache.save(DATA);
    const inFlight = cache.save({ ...DATA, name: "Alice2" });   // older snapshot, still encrypting
    cache.forceDisconnected();
    await inFlight;
    const loaded = await cache.load();
    expect(loaded?.desired).toBe("disconnected");
    expect(loaded?.name).toBe("Alice2");                        // the data itself was still saved
  });

  it("an explicit Connect lifts the pin again", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault });
    await cache.save(DATA);
    cache.forceDisconnected();
    await cache.save({ ...DATA, desired: "connected" });
    expect((await cache.load())?.desired).toBe("connected");
  });

  it("the unencrypted pin can only lower the state, never raise it", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault });
    await cache.save({ ...DATA, desired: "disconnected" });
    const rec = JSON.parse(storage.getItem("m5cet:session:v1")!);
    delete rec.off; rec.desired = "connected";                 // what a storage-level forger could try
    storage.setItem("m5cet:session:v1", JSON.stringify(rec));
    expect((await cache.load())?.desired).toBe("disconnected"); // the encrypted value still says no
  });

  it("sweeps keys orphaned by tabs that were closed long ago", async () => {
    let t = 1_000_000; const vault = createMemoryVault();
    await createSessionCache({ storage: memoryStorage(), vault, now: () => t }).save(DATA);
    const orphanStorage = memoryStorage();
    await createSessionCache({ storage: orphanStorage, vault, now: () => t }).save(DATA);
    const orphanId = JSON.parse(orphanStorage.getItem("m5cet:session:v1")!).id as string;
    t += SESSION_IDLE_LIMIT_MS + 1;
    await createSessionCache({ storage: memoryStorage(), vault, now: () => t }).load();
    expect(await vault.get(orphanId)).toBeNull();
  });
});
