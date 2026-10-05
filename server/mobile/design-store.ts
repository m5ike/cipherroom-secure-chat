// Where a platform keeps its design (Android 6.0, iOS 6.14): design.json in
// the platform's folder (0600, atomic writes), the platform's default until
// the operator saves one. A saved design the current checks refuse (6.7 —
// e.g. the F-01 URL rules) is not used: the default is, and the console says
// why (`problem`).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { AndroidDesign } from "../android/design";

export type DesignStore = {
  /** The design in use (the saved one, or the default). */
  get(): AndroidDesign;
  /** Checks, stamps (rev, time, who) and saves a design; throws DesignError with the problems. */
  save(raw: unknown, by: string): AndroidDesign;
  /** Tests: read the file again. */
  forget(): void;
  /** Why the saved design is not in use, or null. */
  problem(): string | null;
};

export function createDesignStore(opts: {
  /** "android", "ios" — in the log line when a saved design is refused. */
  label: string;
  file: () => string;
  defaults: AndroidDesign;
  sanitize: (raw: unknown) => AndroidDesign;
  rev: (d: AndroidDesign) => string;
}): DesignStore {
  let cached: AndroidDesign | null = null;
  let refused: string | null = null;
  const fallback = () => ({ ...structuredClone(opts.defaults), rev: opts.rev(opts.defaults) });

  const get = (): AndroidDesign => {
    if (cached) return cached;
    let text: string | null = null;
    try { text = readFileSync(opts.file(), "utf8"); } catch { /* none saved: the default */ }
    try {
      cached = text === null ? fallback() : opts.sanitize(JSON.parse(text));
      refused = null;
    } catch (err) {
      // A saved design the checks now refuse is not used — said loudly, not silently: the
      // operator re-saves it in the console after fixing what the message names.
      refused = (err as Error).message || "the saved design does not pass the checks";
      console.warn(`[${opts.label}] the saved design is not used, the default is: ${refused}`);
      cached = fallback();
    }
    return cached;
  };

  return {
    get,
    save(raw, by) {
      const clean = opts.sanitize(raw);
      clean.rev = opts.rev(clean);
      clean.updatedAt = Date.now();
      clean.updatedBy = by;
      const file = opts.file();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      cached = clean;
      refused = null; // what was just saved passed the checks: it is the design in use
      return clean;
    },
    forget() { cached = null; },
    problem() { get(); return refused; },
  };
}
