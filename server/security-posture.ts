// What the console's overview says about this process's security settings
// (6.12): the at-rest encryption of functions.db / telephony.db, the function
// sandbox's isolation and queue, keyed room hashes, the TURN gate and the
// switches that bring back an older, weaker behaviour. Each check is a
// line in Overview › Health (admin-ui console.js renderHealth) and part of
// /api/admin/overview → health.security. Nothing here is secret.

import { serviceDbStates } from "./storage/service-db";
import { isolationState } from "./functions/sandbox/isolation";
import { sandboxGateStats } from "./functions/sandbox/pool";
import { roomHashKeyed } from "./monitor/traffic";
import { turnGateEnabled } from "./turn-gate";

export type PostureCheck = { id: string; tone: "ok" | "warn" | "err"; title: string; detail: string };

export function securityPosture(): { checks: PostureCheck[] } {
  const checks: PostureCheck[] = [];
  for (const db of serviceDbStates()) {
    const title = `${db.label}.db at rest`;
    if (db.encrypted && !db.warning) checks.push({ id: `db-${db.label}`, tone: "ok", title, detail: "encrypted (SQLCipher, master-key subkey)" });
    else checks.push({ id: `db-${db.label}`, tone: db.encrypted ? "err" : "warn", title, detail: db.warning || "not encrypted" });
  }
  const iso = isolationState();
  if (iso) {
    const title = "Function sandboxes";
    if (iso.mode === "bwrap") checks.push({ id: "sandbox-isolation", tone: "ok", title, detail: "bubblewrap (own namespaces, no network, read-only binds) + Node permission model" });
    else if (iso.mode === "refused") checks.push({ id: "sandbox-isolation", tone: "err", title, detail: `no function can run: ${iso.reason}` });
    else checks.push({ id: "sandbox-isolation", tone: "warn", title, detail: `Node permission model only — ${iso.reason}` });
  }
  const gate = sandboxGateStats();
  if (gate) checks.push({ id: "sandbox-queue", tone: gate.waiting > 0 ? "warn" : "ok", title: "Sandbox slots", detail: `${gate.running} of ${gate.max} running, ${gate.waiting} waiting (queue ${gate.queue})` });
  checks.push(roomHashKeyed()
    ? { id: "room-hash", tone: "ok", title: "Room hashes", detail: "keyed (HMAC with a master-key subkey)" }
    : { id: "room-hash", tone: "warn", title: "Room hashes", detail: "NOT keyed — the storage master key is unavailable; logs carry guessable room hashes" });
  checks.push(turnGateEnabled()
    ? { id: "turn-gate", tone: "ok", title: "TURN credentials", detail: "only for addresses with a hub connection that joined a room" }
    : { id: "turn-gate", tone: "warn", title: "TURN credentials", detail: "for anyone who asks (TURN_REQUIRE_HUB=0)" });
  if (process.env.WEBAUTHN_ALLOW_SUBDOMAINS === "1") checks.push({ id: "webauthn-subdomains", tone: "warn", title: "Passkey origins", detail: "every subdomain of the rpId is accepted (WEBAUTHN_ALLOW_SUBDOMAINS=1)" });
  if (process.env.ACCESS_LOG_FULL_IP === "1") checks.push({ id: "access-log-ip", tone: "warn", title: "Access log", detail: "keeps full IP addresses (ACCESS_LOG_FULL_IP=1)" });
  return { checks };
}
