// @vitest-environment node
//
// Profile images (6.7, client/src/lib/profile/image.ts): the photo and the
// background lose every metadata segment — EXIF with its GPS position, XMP,
// comments, PNG text chunks, WebP EXIF / XMP — keep their pixels, fit their
// byte cap, and a data: URL that lies about its format is refused.

import { describe, it, expect } from "vitest";
import { checkImageDataUrl, cropFor, encodeUnderCap, sniffImage, stripImageMetadata, toDataUrl } from "../client/src/lib/profile/image";
import { PROFILE_LIMITS } from "../client/src/lib/profile/model";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array) => String.fromCharCode(...b);
const seg = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];

/** A JPEG skeleton: JFIF, an EXIF block with a GPS position, a comment, a table, the scan. */
function jpegWithExif(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii("Exif\0\0"), ...ascii("GPSLatitude=49.1951;GPSLongitude=16.6068;Make=Phone;Serial=SN12345")]),
    ...seg(0xed, ascii("Photoshop 3.0\0IPTC by-line: Alice")),
    ...seg(0xfe, ascii("taken at home")),
    ...seg(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78,
    0xff, 0xd9,
  ]);
}

function pngChunk(type: string, body: number[]): number[] {
  const len = body.length;
  return [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...ascii(type), ...body, 0, 0, 0, 0];
}

function pngWithText(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...pngChunk("tEXt", ascii("Comment\0GPS 49.19 16.60")),
    ...pngChunk("eXIf", ascii("MM\0*serial")),
    ...pngChunk("IDAT", [1, 2, 3, 4]),
    ...pngChunk("IEND", []),
  ]);
}

function riffChunk(type: string, body: number[]): number[] {
  const len = body.length;
  return [...ascii(type), len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, (len >>> 24) & 0xff, ...body, ...(len & 1 ? [0] : [])];
}

function webpWithExif(): Uint8Array {
  const body = [
    ...ascii("WEBP"),
    ...riffChunk("VP8X", [0x08 | 0x04 | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ...riffChunk("VP8 ", [9, 8, 7, 6, 5]),
    ...riffChunk("EXIF", ascii("GPS 49.19 16.60")),
    ...riffChunk("XMP ", ascii("<x:xmpmeta>serial</x:xmpmeta>")),
  ];
  const size = body.length;
  return Uint8Array.from([...ascii("RIFF"), size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff, ...body]);
}

describe("metadata is stripped", () => {
  it("JPEG: EXIF (with GPS), IPTC and comments go; JFIF, the tables and the scan stay byte for byte", () => {
    const src = jpegWithExif();
    const out = stripImageMetadata(src)!;
    expect(out).not.toBeNull();
    const s = text(out);
    for (const gone of ["Exif", "GPS", "Serial", "IPTC", "taken at home"]) expect(s).not.toContain(gone);
    expect(s).toContain("JFIF");
    expect(Array.from(out.slice(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(out.slice(-2))).toEqual([0xff, 0xd9]);
    // The scan data (with its stuffed 0xFF00 and a restart marker) is untouched.
    const scan = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78];
    expect(text(out)).toContain(String.fromCharCode(...scan));
    expect(sniffImage(out)).toBe("image/jpeg");
    // Stripping again changes nothing.
    expect(Array.from(stripImageMetadata(out)!)).toEqual(Array.from(out));
  });

  it("PNG: text and eXIf chunks go, the image chunks stay", () => {
    const out = stripImageMetadata(pngWithText())!;
    const s = text(out);
    expect(s).not.toContain("tEXt");
    expect(s).not.toContain("GPS");
    expect(s).not.toContain("eXIf");
    for (const kept of ["IHDR", "IDAT", "IEND"]) expect(s).toContain(kept);
  });

  it("WebP: EXIF and XMP chunks go, VP8X no longer announces them, the RIFF size is right", () => {
    const out = stripImageMetadata(webpWithExif())!;
    const s = text(out);
    expect(s).not.toContain("EXIF");
    expect(s).not.toContain("GPS");
    expect(s).not.toContain("xmpmeta");
    expect(s).toContain("VP8 ");
    const flags = out[12 + 8];
    expect(flags & 0x08).toBe(0);
    expect(flags & 0x04).toBe(0);
    expect(flags & 0x10).toBe(0x10); // alpha stays
    const riff = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
    expect(riff).toBe(out.length - 8);
  });

  it("anything else, or a broken file, is not an image", () => {
    expect(stripImageMetadata(Uint8Array.from(ascii("<svg/>")))).toBeNull();
    expect(stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull();
  });
});

describe("a data: URL handed to the server or a peer", () => {
  it("comes back without metadata", () => {
    const clean = checkImageDataUrl(toDataUrl(jpegWithExif(), "image/jpeg"), PROFILE_LIMITS.avatarBytes);
    expect(clean.startsWith("data:image/jpeg;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(clean.split(",")[1]), (c) => c.charCodeAt(0));
    expect(text(bytes)).not.toContain("GPS");
  });

  it("is refused when it lies about its format, is not a picture, or is over the cap", () => {
    expect(checkImageDataUrl(toDataUrl(pngWithText(), "image/jpeg"), PROFILE_LIMITS.avatarBytes)).toBe("");
    expect(checkImageDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", PROFILE_LIMITS.avatarBytes)).toBe("");
    expect(checkImageDataUrl("https://example.com/a.jpg", PROFILE_LIMITS.avatarBytes)).toBe("");
    const big = new Uint8Array(PROFILE_LIMITS.avatarBytes + 1);
    big.set(jpegWithExif().slice(0, 4));
    expect(checkImageDataUrl(toDataUrl(big, "image/jpeg"), PROFILE_LIMITS.avatarBytes)).toBe("");
    expect(checkImageDataUrl(toDataUrl(jpegWithExif(), "image/jpeg"), 10)).toBe("");
  });
});

describe("re-encoding", () => {
  it("crops the photo to a centred square and the background to 3:1, never scaling up", () => {
    expect(cropFor("avatar", 4000, 3000)).toEqual({ sx: 500, sy: 0, sw: 3000, sh: 3000, dw: PROFILE_LIMITS.avatarPx, dh: PROFILE_LIMITS.avatarPx });
    expect(cropFor("cover", 4000, 3000)).toMatchObject({ sx: 0, sw: 4000, sh: 1333, dw: PROFILE_LIMITS.coverW, dh: 400 });
    expect(cropFor("cover", 600, 1000)).toMatchObject({ sw: 600, sh: 200, dw: 600, dh: 200 });
    expect(cropFor("avatar", 100, 50)).toMatchObject({ sw: 50, sh: 50, dw: 50, dh: 50 });
  });

  it("lowers the quality, then the size, until the bytes fit the cap", async () => {
    const tried: Array<[number, number]> = [];
    const encode = async (scale: number, quality: number) => { tried.push([scale, quality]); return new Uint8Array(Math.round(100_000 * scale * scale * quality)); };
    const out = await encodeUnderCap(encode, 30_000);
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(tried[0]).toEqual([1, 0.86]);
    expect(tried.at(-1)![0]).toBeLessThan(1);
    await expect(encodeUnderCap(async () => new Uint8Array(1_000_000), 1_000)).rejects.toThrow("image-too-large");
  });
});
