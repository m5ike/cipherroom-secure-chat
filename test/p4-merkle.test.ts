import { describe, expect, it } from "vitest";
import { consistencyProof, inclusionProof, leafHash, treeHash, verifyConsistency, verifyInclusion, type Hash } from "../client/src/lib/p4/merkle";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function leaves(n: number): Promise<Hash[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => leafHash(`entry-${i}`)));
}

describe("p4 merkle (RFC 9162)", () => {
  it("matches the RFC 6962 hashes of the empty tree and of one leaf", async () => {
    expect(hex(await treeHash([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // SHA-256(0x00 || "") — the leaf hash of an empty entry.
    expect(hex(await leafHash(new Uint8Array()))).toBe("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d");
  });

  it("proves and verifies every leaf of every tree up to 33 leaves", async () => {
    const all = await leaves(33);
    for (let size = 1; size <= 33; size++) {
      const root = await treeHash(all, 0, size);
      for (let i = 0; i < size; i++) {
        const path = await inclusionProof(all, i, size);
        expect(await verifyInclusion(all[i], i, size, path, root)).toBe(true);
        // Another leaf, another index or another size must fail.
        expect(await verifyInclusion(all[(i + 1) % 33], i, size, path, root)).toBe(false);
        if (size > 1) expect(await verifyInclusion(all[i], (i + 1) % size, size, path, root)).toBe(false);
      }
    }
  });

  it("proves and verifies consistency between every pair of sizes up to 33", async () => {
    const all = await leaves(33);
    for (let second = 1; second <= 33; second++) {
      const secondRoot = await treeHash(all, 0, second);
      for (let first = 0; first <= second; first++) {
        const firstRoot = await treeHash(all, 0, first);
        const proof = await consistencyProof(all, first, second);
        expect(await verifyConsistency(first, second, firstRoot, secondRoot, proof)).toBe(true);
        if (first > 0 && first < second) {
          const forged = await treeHash(await leaves(first + 1), 1, first + 1);
          expect(await verifyConsistency(first, second, forged, secondRoot, proof)).toBe(false);
        }
      }
    }
  });

  it("rejects a history that was rewritten", async () => {
    const a = await leaves(10);
    const b = [...a];
    b[3] = await leafHash("rewritten");
    const proof = await consistencyProof(b, 6, 10);
    expect(await verifyConsistency(6, 10, await treeHash(a, 0, 6), await treeHash(b, 0, 10), proof)).toBe(false);
  });
});
