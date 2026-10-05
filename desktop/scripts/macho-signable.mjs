// Makes a thin 64-bit Mach-O file signable by codesign (6.13.1).
//
// pcsc-mini's x86_64 macOS binary (@pcsc-mini/macos-x86_64 0.1.3, built with
// Zig) is unsigned and its load commands end exactly where __text begins: no
// header padding. codesign then writes the new LC_CODE_SIGNATURE command over
// the first 16 bytes of the code, and the signed library crashes on load
// (SIGSEGV — found running the universal app's Intel half under Rosetta). The
// arm64 binary is fine: it already carries LC_CODE_SIGNATURE.
//
// The fix drops LC_SOURCE_VERSION — a 16-byte, informational load command
// (the source version of the build, read by nothing at run time) — so the
// signature's command fits where it was. Nothing else in the file moves.
// Files that are signed already, or have room, are left alone.

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const LC_SOURCE_VERSION = 0x2a;
const HEADER = 32;

/** Inspects a Mach-O buffer: whether it is signed and how many bytes are free after its load commands. */
export function machoInfo(buf) {
  if (buf.length < HEADER || buf.readUInt32LE(0) !== MH_MAGIC_64) return null;
  const ncmds = buf.readUInt32LE(16);
  const sizeofcmds = buf.readUInt32LE(20);
  let off = HEADER;
  let firstSection = Infinity;
  let signed = false;
  let sourceVersion = -1;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > HEADER + sizeofcmds) throw new Error("malformed load command");
    if (cmd === LC_CODE_SIGNATURE) signed = true;
    if (cmd === LC_SOURCE_VERSION && size === 16) sourceVersion = off;
    if (cmd === LC_SEGMENT_64) {
      const nsects = buf.readUInt32LE(off + 64);
      for (let s = 0; s < nsects; s++) {
        const fileOffset = buf.readUInt32LE(off + 72 + s * 80 + 48);
        if (fileOffset > 0) firstSection = Math.min(firstSection, fileOffset);
      }
    }
    off += size;
  }
  return { ncmds, sizeofcmds, signed, sourceVersion, padding: firstSection === Infinity ? Infinity : firstSection - (HEADER + sizeofcmds) };
}

/** Returns true when the buffer was changed (in place). Throws when no room can be made. */
export function makeSignable(buf) {
  const info = machoInfo(buf);
  if (!info || info.signed || info.padding >= 16) return false;
  if (info.sourceVersion < 0) throw new Error("no room for a code signature and no LC_SOURCE_VERSION to drop");
  const end = HEADER + info.sizeofcmds;
  buf.copy(buf, info.sourceVersion, info.sourceVersion + 16, end);
  buf.fill(0, end - 16, end);
  buf.writeUInt32LE(info.ncmds - 1, 16);
  buf.writeUInt32LE(info.sizeofcmds - 16, 20);
  return true;
}
