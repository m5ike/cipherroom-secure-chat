// The server's part of protocol 4 (6.12), put together at start-up
// (server/routes.ts): the hub's room verifiers (signaling/proof.ts), the key
// directory (keys/*) and key transparency (kt/*).
//
// With server-side storage all three keep their tables in the global SQLite
// database (shared by the instances of a cluster) and their keys come from
// the storage master key. Without it: verifiers and the directory in memory
// (per instance, lost on a restart), key transparency off (/api/kt → 503).

import type { AccountStore } from "../accounts/store";
import type { StorageService } from "../storage/service";
import { serverSubkey } from "../storage/keys";
import type { HubDirectory } from "../signaling/hub";
import { RoomProofs, SqliteVerifiers, proofSettings } from "../signaling/proof";
import { ktSignerFromMasterKey } from "../kt/log";
import { KtService } from "../kt/service";
import { MemoryDirectory, SqliteDirectory, type DirectoryBackend } from "./directory";
import { KeyServices } from "./service";

export type Protocol4Services = {
  kt: KtService;
  keys: KeyServices;
  proofs: RoomProofs;
  hubDirectory: HubDirectory;
  /** Stops listening to the account store. */
  detach: () => void;
};

export function protocol4Services(storage: StorageService, accounts: AccountStore): Protocol4Services {
  const settings = proofSettings();
  let kt: KtService;
  let directory: DirectoryBackend;
  let proofs: RoomProofs;
  if (storage.isAvailable) {
    const db = storage.global.handleForQueue();
    kt = KtService.open(db, ktSignerFromMasterKey);
    try {
      directory = new SqliteDirectory(db);
    } catch (err) {
      console.warn(`[keys] the key directory is in memory: ${(err as Error).message}`);
      directory = new MemoryDirectory();
    }
    try {
      proofs = new RoomProofs(new SqliteVerifiers(db), serverSubkey("hub-room-verifier"), settings);
    } catch (err) {
      console.warn(`[hub] room verifiers are in memory: ${(err as Error).message}`);
      proofs = RoomProofs.inMemory(settings);
    }
  } else {
    kt = KtService.off(storage.unavailableReason ?? "server-side storage is off");
    directory = new MemoryDirectory();
    proofs = RoomProofs.inMemory(settings);
  }
  const keys = new KeyServices(accounts, directory, () => kt);
  const detach = keys.attach();
  return {
    kt,
    keys,
    proofs,
    hubDirectory: { devices: (accountId) => keys.devices(accountId), lookup: (accountId) => keys.lookup(accountId) },
    detach,
  };
}
