// A second process for test/service-db-lock-612.test.ts: opens (and, when it
// is plain, converts) one service database and prints what it saw as JSON.
//   tsx test/helpers/service-db-open.ts <file> <label>

import { loadSqliteDriver } from "../../server/storage/db";
import { openServiceDatabase, serviceDbStates, type ServiceDbLabel } from "../../server/storage/service-db";

const [file, label] = process.argv.slice(2);
await loadSqliteDriver();
try {
  const db = await openServiceDatabase(file, label as ServiceDbLabel);
  const rows = Number((db!.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n);
  db!.close();
  process.stdout.write(JSON.stringify({ ok: true, rows, migrated: Boolean(serviceDbStates()[0]?.migratedAt) }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: (err as Error).message }));
}
