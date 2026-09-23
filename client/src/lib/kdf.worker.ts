// Runs the passphrase KDF off the main thread: Argon2id (64 MiB, a few
// hundred milliseconds on a laptop, around a second on a phone) or PBKDF2
// would otherwise freeze the page while it runs.

import { runKdfInline, type KdfRequest } from "./kdf";

self.onmessage = async (event: MessageEvent<KdfRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  try {
    const secret = await runKdfInline(request);
    (self as unknown as Worker).postMessage({ id, ok: true, secret }, [secret.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message || String(err) });
  }
};
