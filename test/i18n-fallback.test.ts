// 6.13: a language that is only partly translated, or not at all (its files
// are not there, or its chunk fails): nothing breaks, t() falls back along
// localeChain (sk → cs → en; fi → en) and finally shows the key.

import { describe, it, expect, vi } from "vitest";

vi.mock("../client/src/lib/i18n-locales", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/lib/i18n-locales")>();
  return {
    ...real,
    LOCALE_MODULES: {
      // Slovak: one text only — everything else from Czech.
      sk: async () => ({ default: { web: { "common.close": "Zavrieť" }, "web-extra": { "files.active#few": "Prebiehajú {n} prenosy:" } } }),
      // Finnish: no files at all (before the translation is merged).
      fi: async () => ({ default: {} }),
      // Italian: the chunk does not load (offline) — and plain Node's disk is not asked for a test language dir.
      it: async () => { throw new Error("chunk failed"); },
    },
  };
});

const { t, tp, hasLocale } = await import("../client/src/lib/i18n");
const { hasOwnTranslation, loadLocale } = await import("../client/src/lib/i18n-load");
const { nfcFnText } = await import("../client/src/lib/i18n-nfc-fn");

describe("a partly translated language", () => {
  it("Slovak shows its own text, then Czech, then English, then the key", async () => {
    expect(await loadLocale("sk")).toBe(true);
    expect(t("sk", "common.close")).toBe("Zavrieť");
    expect(t("sk", "menu.settings")).toBe(t("cs", "menu.settings"));
    expect(t("sk", "menu.settings")).toBe("Nastavení");
    expect(t("sk", "no.such.key")).toBe("no.such.key");
    expect(tp("sk", "files.active", 3)).toBe("Prebiehajú 3 prenosy:");
    // A form Slovak lacks: the Czech one (sk has no plain files.active either).
    expect(tp("sk", "files.active", 7)).toBe("Probíhá 7 přenosů:");
    expect(nfcFnText("sk", "nfcfn.done")).toBe("Hotovo.");
  });

  it("Finnish without files shows English and says it has no translation of its own", async () => {
    expect(await loadLocale("fi")).toBe(false);
    expect(hasLocale("fi")).toBe(true);
    expect(hasOwnTranslation("fi")).toBe(false);
    expect(t("fi", "common.close")).toBe("Close");
    expect(tp("fi", "away.received", 1)).toBe("Delivered 1 message that arrived while you were away.");
  });

  it("a chunk that fails to load does not reject — the texts fall back", async () => {
    vi.stubEnv("M5_I18N_DIR", "/nonexistent-m5cet-i18n");
    await expect(loadLocale("it")).resolves.toBe(false);
    expect(t("it", "common.close")).toBe("Close");
    vi.unstubAllEnvs();
  });

  it("a language with no loader at all (Spanish here) reads the disk under Node, as the server's tsx does", async () => {
    expect(await loadLocale("es")).toBe(true);
    expect(t("es", "common.close")).toBe("Cerrar");
  });
});
