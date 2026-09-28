// 2D and bar codes for functions (4.15, stage 4), host-side via bwip-js:
// QR, Micro QR, rMQR, Aztec, Data Matrix, PDF417, MaxiCode, Han Xin, DotCode,
// Code 128/39/93, EAN/UPC, ITF and more. Returns an SVG string (default) or a
// PNG as bytes; a function typically passes it to m5.out.image.

import bwipjs from "bwip-js";
import { Buffer } from "node:buffer";

export class CodeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CodeError"; }
}

// Friendly names → bwip-js symbology ids (bcid).
const ALIAS: Record<string, string> = {
  qr: "qrcode", qrcode: "qrcode", microqr: "microqr", rmqr: "rectangularmicroqrcode",
  aztec: "azteccode", datamatrix: "datamatrix", pdf417: "pdf417", micropdf417: "micropdf417",
  maxicode: "maxicode", hanxin: "hanxin", dotcode: "dotcode",
  code128: "code128", code39: "code39", code93: "code93", codabar: "rationalizedCodabar",
  itf: "interleaved2of5", itf14: "itf14", ean13: "ean13", ean8: "ean8", upca: "upca", upce: "upce",
  gs1128: "gs1-128", databar: "databaromni",
};

type CodeSpec = {
  type?: string; bcid?: string; text?: string; data?: string;
  scale?: number; height?: number; width?: number; includetext?: boolean;
  format?: "svg" | "png"; backgroundcolor?: string; color?: string; rotate?: "N" | "R" | "L" | "I";
  padding?: number;
};

const clampNum = (v: unknown, def: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const HEX = /^[0-9a-fA-F]{6}$/;

/** Renders one code; returns { format, svg?, image?, mime }. */
export async function hostCode(spec: CodeSpec): Promise<Record<string, unknown>> {
  const name = String(spec.bcid ?? spec.type ?? "qrcode").toLowerCase();
  const bcid = ALIAS[name] ?? name;
  const text = String(spec.text ?? spec.data ?? "");
  if (!text) throw new CodeError("bad-argument", "text is required");
  const opts: Record<string, unknown> = {
    bcid, text,
    scale: clampNum(spec.scale, 3, 1, 12),
    ...(spec.height ? { height: clampNum(spec.height, 10, 1, 500) } : {}),
    ...(spec.width ? { width: clampNum(spec.width, 10, 1, 500) } : {}),
    ...(spec.includetext ? { includetext: true } : {}),
    ...(spec.rotate && "NRLI".includes(spec.rotate) ? { rotate: spec.rotate } : {}),
    ...(spec.padding !== undefined ? { paddingwidth: clampNum(spec.padding, 0, 0, 50), paddingheight: clampNum(spec.padding, 0, 0, 50) } : {}),
    ...(typeof spec.backgroundcolor === "string" && HEX.test(spec.backgroundcolor) ? { backgroundcolor: spec.backgroundcolor } : {}),
    ...(typeof spec.color === "string" && HEX.test(spec.color) ? { barcolor: spec.color } : {}),
  };
  try {
    if (spec.format === "png") {
      const png = Buffer.from(await bwipjs.toBuffer(opts as never));
      return { format: "png", mime: "image/png", image: { $b: png.toString("base64") } };
    }
    const svg = bwipjs.toSVG(opts as never);
    return { format: "svg", mime: "image/svg+xml", svg, image: { $b: Buffer.from(svg, "utf8").toString("base64") } };
  } catch (err) {
    throw new CodeError("render-failed", `cannot render ${bcid}: ${(err as Error).message}`);
  }
}

/** The friendly type names a function may pass to m5.codes. */
export const CODE_TYPES = Object.keys(ALIAS);
