// @vitest-environment node
//
// The Redis side of the cluster bus (server/cluster/resp.ts, RedisBus):
// the RESP codec on its own, and — when a redis-server binary is on this
// machine — two buses talking through a real server, surviving its restart.

import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { encodeCommand, parseReply, parseRedisUrl, RespError } from "../server/cluster/resp";
import { RedisBus, type ClusterMessage } from "../server/cluster/bus";

describe("RESP", () => {
  it("encodes commands as arrays of bulk strings", () => {
    expect(encodeCommand(["PUBLISH", "ch", "héllo"]).toString()).toBe("*3\r\n$7\r\nPUBLISH\r\n$2\r\nch\r\n$6\r\nhéllo\r\n");
  });

  it("parses every reply type, and waits for the rest of a split one", () => {
    const wire = Buffer.from("+OK\r\n-ERR bad\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$3\r\nabc\r\n");
    const values: unknown[] = [];
    let at = 0;
    for (;;) { const r = parseReply(wire, at); if (!r) break; values.push(r.value); at = r.next; }
    expect(values[0]).toBe("OK");
    expect(values[1]).toBeInstanceOf(RespError);
    expect(values[2]).toBe(42);
    expect(String(values[3])).toBe("hello");
    expect(values[4]).toBeNull();
    expect((values[5] as Buffer[]).map(String)).toEqual(["message", "ch", "abc"]);
    // Every cut in the middle of a value is "not yet".
    for (let cut = 1; cut < 11; cut++) expect(parseReply(Buffer.from("$5\r\nhello\r\n").subarray(0, cut))).toBeNull();
  });

  it("reads redis:// and rediss:// addresses", () => {
    expect(parseRedisUrl("redis://:s%40cret@cache.local:6380/2")).toEqual({ host: "cache.local", port: 6380, tls: false, password: "s@cret", db: 2 });
    expect(parseRedisUrl("rediss://user:pw@r.example")).toMatchObject({ tls: true, port: 6379, username: "user", password: "pw", db: 0 });
    expect(() => parseRedisUrl("http://x")).toThrow();
  });
});

const redisBinary = spawnSync("sh", ["-c", "command -v redis-server"], { encoding: "utf8" }).stdout.trim();
const PORT = 16_379 + (process.pid % 500);
let server: ChildProcess | null = null;
const startRedis = async () => {
  server = spawn(redisBinary, ["--port", String(PORT), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--requirepass", "test-pass"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 400));
};
afterAll(() => { server?.kill("SIGKILL"); });

describe.skipIf(!redisBinary)("two instances through a real Redis", () => {
  it("delivers signed messages to the other instance only, and again after Redis restarts", async () => {
    await startRedis();
    const url = `redis://:test-pass@127.0.0.1:${PORT}`;
    const one = new RedisBus(url, "m5cet:test", "s3cret", "one");
    const two = new RedisBus(url, "m5cet:test", "s3cret", "two");
    const outsider = new RedisBus(url, "m5cet:test", "other-secret", "outsider");
    await Promise.all([one.ready(), two.ready(), outsider.ready()]);
    await new Promise((r) => setTimeout(r, 100)); // subscriptions settle

    const gotTwo: ClusterMessage[] = [];
    const gotOne: ClusterMessage[] = [];
    two.subscribe((m) => gotTwo.push(m));
    one.subscribe((m) => gotOne.push(m));
    one.publish({ t: "room", room: "r", payload: { type: "x" } });
    outsider.publish({ t: "room", room: "r", payload: { type: "forged" } });
    await expect.poll(() => gotTwo.length).toBe(1);
    expect(gotTwo[0]).toMatchObject({ t: "room", from: "one", payload: { type: "x" } });
    expect(gotOne).toEqual([]); // never back to the sender, forged ones dropped
    expect(two.status()).toMatchObject({ kind: "redis", connected: true, signed: true, dropped: 1 });

    // Redis goes away and comes back: the buses reconnect and resubscribe.
    server!.kill("SIGKILL");
    await expect.poll(() => one.status().connected, { timeout: 5000 }).toBe(false);
    one.publish({ t: "room", room: "r", payload: { type: "while-down" } });
    await startRedis();
    await expect.poll(() => one.status().connected && two.status().connected, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => gotTwo.filter((m) => m.t === "room").length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    one.publish({ t: "room", room: "r", payload: { type: "after" } });
    await expect.poll(() => gotTwo.some((m) => (m.payload as { type?: string })?.type === "after"), { timeout: 5000 }).toBe(true);
    // Reconnecting is a resync for the hub (it re-announces its members).
    expect(gotTwo.some((m) => m.t === "resync")).toBe(true);

    await Promise.all([one.close(), two.close(), outsider.close()]);
  }, 40_000);
});
