// @vitest-environment node
// 6.12: the console's overview names what is not as strong as it should be —
// a service database left plain, sandboxes without bubblewrap, unkeyed room
// hashes, an open TURN gate, the switches back to older behaviour.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securityPosture } from "../server/security-posture";
import { _resetIsolationForTests } from "../server/functions/sandbox/isolation";
import { _resetServiceDbStatesForTests, openServiceDatabase } from "../server/storage/service-db";
import { _resetMasterKeyForTests } from "../server/storage/keys";
import { _resetRoomHashForTests } from "../server/monitor/traffic";

const dir = mkdtempSync(join(tmpdir(), "m5posture-"));
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; _resetIsolationForTests(); _resetServiceDbStatesForTests(); _resetMasterKeyForTests(); _resetRoomHashForTests(); });

const byId = (id: string) => securityPosture().checks.find((c) => c.id === id);

describe("security posture", () => {
  it("reports encrypted service databases as ok and a plain one as a warning", async () => {
    process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 3).toString("hex");
    _resetMasterKeyForTests();
    (await openServiceDatabase(join(dir, "functions.db"), "functions"))!.close();
    expect(byId("db-functions")).toMatchObject({ tone: "ok" });
    process.env.STORAGE_MASTER_KEY = "broken";
    _resetMasterKeyForTests();
    (await openServiceDatabase(join(dir, "telephony.db"), "telephony"))!.close();
    expect(byId("db-telephony")).toMatchObject({ tone: "warn", detail: expect.stringMatching(/NOT encrypted at rest/) });
    _resetRoomHashForTests();
    expect(byId("room-hash")).toMatchObject({ tone: "warn" });
  });

  it("reports the sandbox isolation once it is known", () => {
    expect(byId("sandbox-isolation")).toBeUndefined();
    _resetIsolationForTests({ setting: "auto", mode: "permission", bwrap: null, reason: "bubblewrap (bwrap) is not installed", checkedAt: 1 });
    expect(byId("sandbox-isolation")).toMatchObject({ tone: "warn", detail: expect.stringMatching(/permission model only/) });
    _resetIsolationForTests({ setting: "bwrap", mode: "refused", bwrap: null, reason: "x", checkedAt: 1 });
    expect(byId("sandbox-isolation")).toMatchObject({ tone: "err" });
    _resetIsolationForTests({ setting: "auto", mode: "bwrap", bwrap: "/usr/bin/bwrap", reason: "", checkedAt: 1 });
    expect(byId("sandbox-isolation")).toMatchObject({ tone: "ok" });
  });

  it("names the switches back to weaker behaviour", () => {
    expect(byId("turn-gate")).toMatchObject({ tone: "ok" });
    process.env.TURN_REQUIRE_HUB = "0";
    process.env.WEBAUTHN_ALLOW_SUBDOMAINS = "1";
    process.env.ACCESS_LOG_FULL_IP = "1";
    expect(byId("turn-gate")).toMatchObject({ tone: "warn" });
    expect(byId("webauthn-subdomains")).toMatchObject({ tone: "warn" });
    expect(byId("access-log-ip")).toMatchObject({ tone: "warn" });
  });
});
