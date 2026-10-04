// Side-effect module: point the telephony data file at a fresh temp location
// BEFORE server/telephony/sip.ts is imported (its singleton enables
// persistence at import time). Import this first in any test that touches the
// telephony module so the repo's own .m5cet/telephony.json is never written.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m5cet-telephony-"));
process.env.TELEPHONY_DATA_FILE = join(dir, "telephony.json");
// 6.9: the webhook / event log (telephony.db) too — never the repo's .m5cet.
process.env.TELEPHONY_DB_FILE = join(dir, "telephony.db");
delete process.env.SIP_TRUNKS;
delete process.env.PUBLIC_BASE_URL;

export const TELEPHONY_TMP_DIR = dir;
