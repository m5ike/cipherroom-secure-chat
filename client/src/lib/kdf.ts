// The passphrase → room secret step, and where it runs.
//
//   argon2id  (crypto v3, default)  memory-hard: 64 MiB, 3 passes. A GPU or
//             ASIC guessing weak passphrases pays in memory, not only in
//             time — far costlier than PBKDF2 at the same wait for the user.
//   pbkdf2    (crypto v2)           SHA-256, 600 000 iterations — still
//             derived when a v2 envelope arrives (messages queued by 3.0).
//
// In the browser it runs in a Web Worker (kdf.worker.ts) so the page stays
// responsive; tests and browsers without workers run it inline. Argon2id
// comes from hash-wasm (WebAssembly; CSP needs 'wasm-unsafe-eval').

export type KdfRequest =
  | { kdf: "argon2id"; password: string; salt: string; memoryKiB: number; passes: number }
  | { kdf: "pbkdf2"; password: string; salt: string; iterations: number };

export const ARGON2_PARAMS = { memoryKiB: 64 * 1024, passes: 3 } as const;
export const PBKDF2_ITERATIONS = 600_000;

const utf8 = (s: string) => new Uint8Array(new TextEncoder().encode(s));

/** The KDF, here and now (inside the worker, or where no worker exists). */
export async function runKdfInline(request: KdfRequest): Promise<Uint8Array<ArrayBuffer>> {
  if (request.kdf === "argon2id") {
    const { argon2id } = await import("hash-wasm");
    const out = await argon2id({
      password: request.password,
      salt: utf8(request.salt),
      parallelism: 1,
      iterations: request.passes,
      memorySize: request.memoryKiB,
      hashLength: 32,
      outputType: "binary",
    });
    return new Uint8Array(out);
  }
  const material = await crypto.subtle.importKey("raw", utf8(request.password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: utf8(request.salt), iterations: request.iterations, hash: "SHA-256" }, material, 256);
  return new Uint8Array(bits);
}

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Uint8Array<ArrayBuffer>) => void; reject: (e: Error) => void }>();

function useWorker(): boolean {
  if (workerBroken || typeof window === "undefined" || typeof Worker !== "function") return false;
  try { return (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE !== "test"; } catch { return true; }
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./kdf.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; secret?: Uint8Array<ArrayBuffer>; error?: string }>) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    pending.delete(event.data.id);
    if (event.data.ok && event.data.secret) job.resolve(new Uint8Array(event.data.secret));
    else job.reject(new Error(event.data.error || "KDF failed"));
  };
  worker.onerror = () => {
    // A worker that cannot start (CSP, old browser): run inline from now on.
    workerBroken = true;
    for (const [id, job] of pending) { pending.delete(id); job.reject(new Error("worker failed")); }
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Runs the KDF — in the worker when there is one. */
export async function runKdf(request: KdfRequest): Promise<Uint8Array<ArrayBuffer>> {
  if (!useWorker()) return runKdfInline(request);
  try {
    return await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, ...request });
    });
  } catch {
    return runKdfInline(request);
  }
}
