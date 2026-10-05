// The SHA-256 of every bundled file, as the app.asar header records it (pure).
//
// With the EnableEmbeddedAsarIntegrityValidation fuse Electron checks the
// asar HEADER against the hash in the signed Info.plist (macOS) / the signed
// executable's resources (Windows) when it opens the archive — so the header
// is as trustworthy as the app's signature. Electron validates file CONTENTS
// only on some of its read paths, so the app checks every client file it
// serves against the header's hash itself (intercept.ts): a byte changed in
// app.asar after signing means the file is refused, not served.
//
// asar layout: a Chromium pickle — uint32 4, uint32 header-pickle size,
// uint32 payload size, uint32 JSON length, then the JSON header
// { files: { name: { files: {…} } | { size, offset, integrity: { algorithm, hash } } } }.

export type AsarHashes = Map<string, string>;

type Node = { files?: Record<string, Node>; integrity?: { algorithm?: string; hash?: string }; unpacked?: boolean };

/** The JSON header's length and where it starts, from the first 16 bytes. */
export function asarHeaderLength(head: Uint8Array): number {
  if (head.length < 16) throw new Error("asar: header too short");
  const v = new DataView(head.buffer, head.byteOffset, 16);
  const first = v.getUint32(0, true);
  const json = v.getUint32(12, true);
  if (first !== 4 || json <= 0 || json > 64 * 1024 * 1024) throw new Error("asar: not an archive header");
  return json;
}

/** "web/index.html" → sha256 hex, for every packed file under `prefix`. */
export function asarHashesFromHeader(json: string, prefix = "web"): AsarHashes {
  const header = JSON.parse(json) as Node;
  const out: AsarHashes = new Map();
  const walk = (node: Node, path: string) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = path ? `${path}/${name}` : name;
      if (child.files) walk(child, p);
      else if (!child.unpacked && child.integrity?.algorithm === "SHA256" && typeof child.integrity.hash === "string" && /^[0-9a-f]{64}$/.test(child.integrity.hash)) out.set(p, child.integrity.hash);
    }
  };
  const root = header.files?.[prefix];
  if (root) walk(root, prefix);
  // The file index sits next to the web directory.
  const index = header.files?.["web-index.json"];
  if (index?.integrity?.hash) out.set("web-index.json", index.integrity.hash);
  return out;
}
