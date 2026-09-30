// 6.2: what a bubble shows of a file, from the bytes already in this browser
// (lib/attachment-media.ts): the kind, a data: URL's bytes, a text's first
// lines, and the Blob behind a received file's blob: URL.

import { describe, it, expect } from "vitest";
import { MEDIA_ICON, attachmentBlob, dataUrlBytes, dataUrlToBlob, forgetBlob, mediaKindOf, rememberBlob, textPreview } from "../client/src/lib/attachment-media";

const file = (mime: string, name = "f", kind: "file" | "image" = "file") => ({ kind, name, mime, size: 1, dataUrl: "" });
const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => btoa(String.fromCharCode(...enc(s)));

describe("the kind of a file", () => {
  it("follows the (already checked) type", () => {
    expect(mediaKindOf(file("image/png", "a.png", "image"))).toBe("image");
    expect(mediaKindOf(file("image/svg+xml", "a.svg"))).toBe("file");
    expect(mediaKindOf(file("video/mp4"))).toBe("video");
    expect(mediaKindOf(file("video/quicktime"))).toBe("file");
    expect(mediaKindOf(file("audio/webm"))).toBe("audio");
    expect(mediaKindOf(file("application/pdf"))).toBe("pdf");
    expect(mediaKindOf(file("text/plain"))).toBe("text");
    // A peer's Markdown arrives as octet-stream: the name tells it.
    expect(mediaKindOf(file("application/octet-stream", "notes.md"))).toBe("text");
    expect(mediaKindOf(file("application/octet-stream", "app.exe"))).toBe("file");
    expect(MEDIA_ICON.video).toBe("file-video");
  });
});

describe("data: URLs", () => {
  it("give their bytes (all, or the first few)", () => {
    const url = `data:text/plain;base64,${b64("Hello, world!")}`;
    expect(new TextDecoder().decode(dataUrlBytes(url)!)).toBe("Hello, world!");
    expect(new TextDecoder().decode(dataUrlBytes(url, 5)!)).toBe("Hello");
    expect(new TextDecoder().decode(dataUrlBytes("data:text/plain,a%20b")!)).toBe("a b");
    expect(dataUrlBytes("https://example.org/x")).toBeNull();
    expect(dataUrlBytes("data:text/plain;base64,@@@@")).toBeNull();
  });

  it("become a Blob of the given type (media play from blob: — the CSP has no data: in media-src)", async () => {
    const blob = dataUrlToBlob(`data:audio/webm;base64,${b64("abc")}`, "audio/webm")!;
    expect(blob.type).toBe("audio/webm");
    expect(blob.size).toBe(3);
  });
});

describe("a received file's Blob", () => {
  it("is decoded from a data: URL or remembered for its blob: URL — never fetched", async () => {
    const inline = attachmentBlob({ ...file("text/plain"), dataUrl: `data:text/plain;base64,${b64("hi")}` })!;
    expect(await inline.text()).toBe("hi");
    const big = new Blob(["chunked"], { type: "application/pdf" });
    rememberBlob("blob:x/1", big);
    expect(attachmentBlob({ ...file("application/pdf"), dataUrl: "blob:x/1" })).toBe(big);
    forgetBlob("blob:x/1");
    expect(attachmentBlob({ ...file("application/pdf"), dataUrl: "blob:x/1" })).toBeNull();
    expect(attachmentBlob(file("application/pdf"))).toBeNull();
  });
});

describe("a text's first lines", () => {
  it("are plain text, at most a few lines", () => {
    const p = textPreview(enc("# Plan\r\n- one\n- two\n- three\n- four\n- five\n- six\n- seven\n"))!;
    expect(p.text).toBe("# Plan\n- one\n- two\n- three\n- four\n- five");
    expect(p.more).toBe(true);
    expect(textPreview(enc("short"))).toEqual({ text: "short", more: false });
    // Read only the head of a big file: the rest is "more".
    expect(textPreview(enc("line"), 6, 480, 10_000)).toEqual({ text: "line", more: true });
  });

  it("are not made from binary bytes, and lose control characters", () => {
    expect(textPreview(new Uint8Array([0x25, 0x50, 0x00, 0x01]))).toBeNull();
    expect(textPreview(enc("a\u0007b\u001bc"))).toEqual({ text: "abc", more: false });
    expect(textPreview(enc("x".repeat(600)))).toEqual({ text: "x".repeat(480), more: true });
  });
});
