// The app's windows, the Room window, dialogs and panels as layouts (4.13):
// each drawn by its own component in every situation the Layout builder
// previews (client/src/layout-preview-parts.tsx), in every language —
// without an error of the layout, and with nothing a screen reader or a
// keyboard user would miss in what the layout itself drew. The preview
// talks to no server: neither does this.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { AppPart, PREVIEW_STEPS } from "../client/src/layout-preview-parts";
import { setLayoutPreviewMode } from "../client/src/components/LayoutView";
import { DEFAULT_LAYOUTS, LAYOUT_GROUP, LAYOUT_IDS, type LayoutId } from "../client/src/lib/layouts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { checkDom, checkTree } from "../client/src/lib/layout-a11y";
import { walkTree } from "../client/src/lib/layout-tree";

const network: string[] = [];
beforeEach(() => { vi.stubGlobal("fetch", (url: unknown) => { network.push(String(url)); return Promise.reject(new Error("no network in the preview")); }); });
afterEach(() => { cleanup(); document.body.innerHTML = ""; setLayoutPreviewMode(null); vi.unstubAllGlobals(); });

const PARTS = LAYOUT_IDS.filter((id) => LAYOUT_GROUP[id] !== "app");
const STEP_COUNT: Record<string, number> = Object.fromEntries(Object.entries(PREVIEW_STEPS).map(([k, v]) => [k, v.length + 1]));

/** What a situation shows once its clicks are done (or its made-up data is in). */
const REACHED: Record<string, (body: HTMLElement) => boolean> = {
  "panel.access:code": (b) => Boolean(b.querySelector("[data-testid=recovery-code]")),
  "part.shareResult:qr": (b) => Boolean(b.querySelector(".qr-box")),
  "panel.phone:call": (b) => (b.querySelector(".phone__number") as HTMLInputElement | null)?.value === "+420123456789",
  "panel.phone:sms": (b) => (b.querySelector("[data-testid=phone-sms-text]") as HTMLTextAreaElement | null)?.value !== "",
  "panel.phone:off": (b) => Boolean(b.querySelector(".phone__banner--warn")),
  "panel.speech:server": (b) => (b.textContent ?? "").includes("ElevenLabs"),
  "part.connectionEdit:new": (b) => Boolean(b.querySelector("[data-testid=cx-form]")),
  "part.connectionEdit:edit": (b) => (b.querySelector("[data-testid=cx-f-label]") as HTMLInputElement | null)?.value === "Rodina",
  "part.connectionDetail:log": (b) => Boolean(b.querySelector("[data-testid=cx-log]")),
  "part.connectionSettings:plain": (b) => Boolean(b.querySelector("[data-testid=cx-settings]")),
};

async function draw(layout: LayoutId, variant: string, lang: "cs" | "en" | "de") {
  const errors: string[] = [];
  setLayoutPreviewMode({ onError: (id, message) => errors.push(`${id}: ${message}`) });
  render(<AppPart layout={layout} variant={variant} lang={lang} />);
  // The situation's clicks (60 ms apart) and whatever the component loads by itself (made up, at once).
  await act(async () => { await new Promise((ok) => setTimeout(ok, 60 * (STEP_COUNT[`${layout}:${variant}`] ?? 0) + 40)); });
  return errors;
}

describe("windows, the Room window, dialogs and panels", () => {
  it("are all here (and nothing of the app's main screen), each situation with a way to reach it", () => {
    expect(PARTS.length).toBe(LAYOUT_IDS.length - 8);
    for (const key of [...Object.keys(PREVIEW_STEPS), ...Object.keys(REACHED)]) {
      const [id, variant] = key.split(":");
      expect(PREVIEW_VARIANTS[id as LayoutId]?.map((v) => v.id), key).toContain(variant);
    }
  });

  for (const id of PARTS) {
    it(`${id}: every situation draws without an error, named and labelled`, async () => {
      const own = new Set<string>();
      const parts = new Set<string>();
      walkTree(DEFAULT_LAYOUTS[id], (n) => { own.add(n.id); if (n.el === "slot") parts.add(n.id); });
      expect(checkTree(DEFAULT_LAYOUTS[id]).map((i) => `${i.id}: ${i.rule}`), `${id} (design)`).toEqual([]);
      for (const { id: variant } of PREVIEW_VARIANTS[id]) {
        for (const lang of ["cs", "en", "de"] as const) {
          const errors = await draw(id, variant, lang);
          expect(errors, `${id} ${variant} ${lang}`).toEqual([]);
          const reached = REACHED[`${id}:${variant}`];
          if (reached) expect(reached(document.body), `${id} ${variant} ${lang}: reached`).toBe(true);
          // Something of this very layout is on the page.
          expect(document.body.querySelector("[data-lb-id]"), `${id} ${variant} ${lang}: drawn`).not.toBeNull();
          const drawn = checkDom(document.body).filter((i) => own.has(i.id) && !parts.has(i.id) && i.rule !== "contrast");
          expect(drawn.map((i) => `${i.id}: ${i.rule} ${i.message}`), `${id} ${variant} ${lang} (drawn)`).toEqual([]);
          cleanup();
          document.body.innerHTML = "";
        }
      }
      expect(network, id).toEqual([]);
    });
  }
});
