// Zero-knowledge storage for PassKey-encrypted profiles. The server only ever
// holds ciphertext, keyed by the opaque WebAuthn credential id. It cannot read
// a profile and never sees a key — the client encrypts under a PRF-derived key
// before uploading (see client/src/lib/passkey.ts). In-memory only; a real
// deployment should mount a KV/DB behind ProfileStore.

import type { Express, Request, Response } from "express";

const CRED_ID = /^[A-Za-z0-9_-]{16,512}$/;

export const PROFILE_LIMITS = {
  maxProfiles: 5000,
  maxCiphertextChars: 64_000,
} as const;

type StoredProfile = { ciphertext: string; updatedAt: number };

export class ProfileStore {
  private map = new Map<string, StoredProfile>();

  put(credentialId: string, ciphertext: string): { ok: boolean; message?: string } {
    if (!CRED_ID.test(credentialId)) return { ok: false, message: "invalid credentialId" };
    if (typeof ciphertext !== "string" || ciphertext.length === 0 || ciphertext.length > PROFILE_LIMITS.maxCiphertextChars) {
      return { ok: false, message: "invalid ciphertext" };
    }
    if (!this.map.has(credentialId) && this.map.size >= PROFILE_LIMITS.maxProfiles) {
      return { ok: false, message: "profile store full" };
    }
    this.map.set(credentialId, { ciphertext, updatedAt: Date.now() });
    return { ok: true };
  }

  get(credentialId: string): StoredProfile | null {
    return CRED_ID.test(credentialId) ? (this.map.get(credentialId) ?? null) : null;
  }

  delete(credentialId: string): boolean {
    return this.map.delete(credentialId);
  }

  get size(): number {
    return this.map.size;
  }
}

export const profileStore = new ProfileStore();

export function registerPasskeyRoutes(app: Express): void {
  app.put("/api/passkey/profile", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const r = profileStore.put(String(body.credentialId || ""), typeof body.ciphertext === "string" ? body.ciphertext : "");
    if (!r.ok) return res.status(400).json({ ok: false, message: r.message });
    res.json({ ok: true });
  });

  app.get("/api/passkey/profile", (req: Request, res: Response) => {
    const id = String(req.query.credentialId || "");
    if (!CRED_ID.test(id)) return res.status(400).json({ ok: false, message: "invalid credentialId" });
    const p = profileStore.get(id);
    if (!p) return res.status(404).json({ ok: false, message: "not found" });
    res.json({ ok: true, ciphertext: p.ciphertext, updatedAt: p.updatedAt });
  });

  app.delete("/api/passkey/profile", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    profileStore.delete(String(body.credentialId || ""));
    res.json({ ok: true });
  });
}
