#!/usr/bin/env node
// Load test for the signaling server: many WebSocket clients join rooms,
// exchange sealed-signal-sized frames and heartbeats, optionally push
// relayed file chunks, and the script reports what the server did with it.
//
//   node scripts/load-test.mjs --url ws://127.0.0.1:5000/ws --clients 300 \
//        --room-size 4 --duration 30 --rate 2 [--proxy-kbps 256] [--ramp 10]
//
// Every client joins room load-<n>; each second it sends `rate` sealed
// signals to a random member of its room, and a ping every --ping-every
// seconds (RTT from the pong). With --proxy-kbps, one client per room also streams binary
// proxy chunks at that rate to the others. Nothing here needs a room key:
// the server only relays opaque frames, which is exactly what is measured.
//
// Point it only at a server you run. The per-address connection limits
// (WS_CONNECTS_PER_MINUTE, WS_CONNECTIONS_PER_CLIENT) apply to the load
// test too: raise them on the test server, or the refusals are the result.

import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]);
  return acc;
}, []));
const URL_ = args.url ?? "ws://127.0.0.1:5000/ws";
const CLIENTS = Number(args.clients ?? 100);
const ROOM_SIZE = Math.max(2, Number(args["room-size"] ?? 4));
const DURATION = Number(args.duration ?? 20) * 1000;
const RATE = Number(args.rate ?? 2);
const RAMP = Number(args.ramp ?? 5) * 1000;
const PROXY_KBPS = Number(args["proxy-kbps"] ?? 0);
// A real client pings every 12–45 s; the heartbeat budget is 0.5/s.
const PING_EVERY = Number(args["ping-every"] ?? 5) * 1000;
const ORIGIN = args.origin ?? new URL(URL_.replace(/^ws/, "http")).origin;

const stats = {
  connected: 0, refused: 0, closed: 0, joined: 0,
  sent: 0, received: 0, bytesOut: 0, bytesIn: 0,
  rateLimited: 0, errors: {}, joinMs: [], rttMs: [], signalsDelivered: 0, chunksDelivered: 0, transfers: 0,
};
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const members = new Map(); // room -> Set(peerId)
const sockets = [];
let stopping = false;

function client(i) {
  const room = `load-${Math.floor(i / ROOM_SIZE)}`;
  const t0 = performance.now();
  const ws = new WebSocket(URL_, { headers: { Origin: ORIGIN } });
  sockets.push(ws);
  let peerId = null;
  let proxyStart = null;
  const timers = [];
  const send = (frame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const data = typeof frame === "string" || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame);
    ws.send(data);
    stats.sent += 1;
    stats.bytesOut += typeof data === "string" ? Buffer.byteLength(data) : data.length;
  };
  ws.on("unexpected-response", (_req, res) => { stats.refused += 1; stats.errors[`http-${res.statusCode}`] = (stats.errors[`http-${res.statusCode}`] ?? 0) + 1; });
  ws.on("error", (err) => { stats.errors[err.code ?? "error"] = (stats.errors[err.code ?? "error"] ?? 0) + 1; });
  ws.on("open", () => { stats.connected += 1; });
  ws.on("close", () => { if (!stopping) stats.closed += 1; timers.forEach(clearInterval); if (peerId) members.get(room)?.delete(peerId); });
  ws.on("message", (data, isBinary) => {
    stats.received += 1;
    stats.bytesIn += data.length;
    if (isBinary) { stats.chunksDelivered += 1; return; }
    let f; try { f = JSON.parse(data.toString()); } catch { return; }
    switch (f.type) {
      case "hello":
        send({ type: "join", protocol: 2, room, name: `load-${i}`, peerId: f.peerId, features: ["bin"] });
        break;
      case "joined": {
        peerId = f.peerId;
        stats.joined += 1;
        stats.joinMs.push(performance.now() - t0);
        if (!members.has(room)) members.set(room, new Set());
        members.get(room).add(peerId);
        const every = Math.max(20, 1000 / Math.max(RATE, 0.001));
        send({ type: "ping", t: Date.now() });
        timers.push(setInterval(() => send({ type: "ping", t: Date.now() }), PING_EVERY));
        timers.push(setInterval(() => {
          const others = [...(members.get(room) ?? [])].filter((p) => p !== peerId);
          if (others.length) {
            const target = others[Math.floor(Math.random() * others.length)];
            // A sealed signal of a typical ICE candidate's size.
            send({ type: "signal", target, payload: { sealed: { v: 2, iv: randomBytes(12).toString("base64"), ciphertext: randomBytes(220).toString("base64") } } });
          }
        }, every));
        if (PROXY_KBPS > 0 && i % ROOM_SIZE === 0) proxyStart = startProxy(send, i, timers);
        break;
      }
      case "pong": stats.rttMs.push(Date.now() - f.t); break;
      case "signal": stats.signalsDelivered += 1; break;
      case "proxy-chunk": stats.chunksDelivered += 1; break;
      case "rate-limited": stats.rateLimited += 1; stats.errors[`rate-limited: ${f.frame}`] = (stats.errors[`rate-limited: ${f.frame}`] ?? 0) + 1; break;
      case "error": { const k = `${f.code ?? "error"}${f.message ? `: ${String(f.message).slice(0, 40)}` : ""}`; stats.errors[k] = (stats.errors[k] ?? 0) + 1; break; }
      case "proxy-ack":
        // The relay runs a bounded number of transfers (64): past that it
        // says "server-full" and the sender must not stream.
        if (f.accepted) { stats.transfers += 1; proxyStart?.(); } else stats.errors[`proxy-ack: ${f.reason}`] = (stats.errors[`proxy-ack: ${f.reason}`] ?? 0) + 1;
        break;
    }
  });
}

/** One sender per room: a relayed "file" of opaque binary chunks. Announces
 *  the transfer; the returned function starts streaming once it is accepted. */
function startProxy(send, i, timers) {
  const transferId = `xfer-load-${i}-${randomBytes(4).toString("hex")}`;
  send({ type: "proxy-meta", transferId, iv: randomBytes(12).toString("base64"), ciphertext: randomBytes(200).toString("base64") });
  const chunkBytes = 16 * 1024;
  const perSec = Math.max(1, Math.round((PROXY_KBPS * 1024) / chunkBytes));
  let seq = 0;
  return () => {
    timers.push(setInterval(() => {
      const id = Buffer.from(transferId);
      const head = Buffer.from([0x4d, 0x11, 3, id.length]);
      const seqBuf = Buffer.alloc(4); seqBuf.writeUInt32BE(seq++ % 2_000_000);
      send(Buffer.concat([head, id, seqBuf, randomBytes(12), randomBytes(chunkBytes + 16)]));
    }, 1000 / perSec));
  };
}

console.log(`load test: ${CLIENTS} clients → ${URL_}, rooms of ${ROOM_SIZE}, ${RATE}/s each, ${DURATION / 1000}s${PROXY_KBPS ? `, proxy ${PROXY_KBPS} KiB/s per room` : ""}`);
for (let i = 0; i < CLIENTS; i++) setTimeout(() => client(i), (RAMP * i) / CLIENTS);

const started = Date.now();
const progress = setInterval(() => {
  const s = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`\r${s}s  connected ${stats.connected}/${CLIENTS}  joined ${stats.joined}  frames out ${stats.sent} in ${stats.received}  rtt p95 ${pct(stats.rttMs, 95)} ms   `);
}, 1000);

setTimeout(() => {
  stopping = true;
  clearInterval(progress);
  for (const ws of sockets) try { ws.close(1000); } catch { /* gone */ }
  const secs = (DURATION + RAMP) / 1000;
  const report = {
    clients: CLIENTS, connected: stats.connected, joined: stats.joined, refused: stats.refused, droppedDuringRun: stats.closed,
    joinMs: { p50: Math.round(pct(stats.joinMs, 50)), p95: Math.round(pct(stats.joinMs, 95)), p99: Math.round(pct(stats.joinMs, 99)) },
    rttMs: { p50: pct(stats.rttMs, 50), p95: pct(stats.rttMs, 95), p99: pct(stats.rttMs, 99), samples: stats.rttMs.length },
    framesPerSec: { out: Math.round(stats.sent / secs), in: Math.round(stats.received / secs) },
    mbitPerSec: { out: +((stats.bytesOut * 8) / secs / 1e6).toFixed(2), in: +((stats.bytesIn * 8) / secs / 1e6).toFixed(2) },
    signalsDelivered: stats.signalsDelivered, relayedTransfers: stats.transfers, chunksDelivered: stats.chunksDelivered, rateLimited: stats.rateLimited, errors: stats.errors,
  };
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  const ok = stats.joined >= CLIENTS * 0.99 && stats.closed === 0;
  setTimeout(() => process.exit(ok ? 0 : 1), 300);
}, DURATION + RAMP);
