// 6.13: choosing the language — the first visit speaks the browser's
// language (navigator.languages → pickLocale), the pickers (Settings and the
// start screen) offer the nine languages by their own names, a switch at
// runtime loads the language's chunk and redraws without a reload, <html lang>
// follows, and texts a language lacks come from its fallbacks (sk → cs → en).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { SUPPORTED_LANGS, detectLang, langLabel, langTag, t, type Lang } from "../client/src/lib/i18n";
import { applyDocumentLang, useLoadedLang } from "../client/src/lib/i18n-react";
import { NOTIFY_LANGS, renderNotification, DEFAULT_TEMPLATES } from "../client/src/lib/notify-template";
import { browserLang, loadPreferences } from "../client/src/lib/preferences";
import { LOCALES, LOCALE_INFO, localeChain, pickLocale } from "../client/src/lib/locales";
import { StartScreen, LANGUAGE_CHOICES } from "../client/src/components/StartScreen";
import { SettingsPanel } from "../client/src/components/panels";
import { startProps } from "../client/src/layout-samples";

const languages = (list: string[]) => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(list);
  vi.spyOn(navigator, "language", "get").mockReturnValue(list[0] ?? "");
};

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("detection", () => {
  it("picks the first of the browser's languages the app speaks", () => {
    languages(["sk-SK", "cs", "en"]);
    expect(detectLang(undefined)).toBe("sk");
    expect(browserLang()).toBe("sk");
    languages(["pt-BR", "fr-CA", "de"]);
    expect(detectLang(null)).toBe("fr");
    languages(["pt-PT", "ja"]);
    expect(detectLang(undefined)).toBe("en");
    expect(pickLocale("sl-SI,sl;q=0.9,en;q=0.8")).toBe("sl");
  });

  it("keeps a stored choice; an unknown one is detected again", () => {
    languages(["fi-FI"]);
    expect(detectLang("de")).toBe("de");
    expect(detectLang("xx")).toBe("fi");
  });

  it("the first visit's preferences speak the browser's language; a stored choice stays", () => {
    languages(["it-IT", "en"]);
    expect(loadPreferences().lang).toBe("it");
    localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ lang: "sl" }));
    expect(loadPreferences().lang).toBe("sl");
    localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ lang: "klingon" }));
    expect(loadPreferences().lang).toBe("it");
  });
});

describe("the fallback chain", () => {
  it("Slovak falls back to Czech, then English; the others straight to English", () => {
    expect(localeChain("sk")).toEqual(["sk", "cs", "en"]);
    expect(localeChain("fi")).toEqual(["fi", "en"]);
    expect(localeChain("en")).toEqual(["en"]);
  });

  it("notifications speak the user's own language (NotifyLang = the nine)", () => {
    expect([...NOTIFY_LANGS].sort()).toEqual([...LOCALES].sort());
    expect(renderNotification(DEFAULT_TEMPLATES.call, "sk", { app: "M5cet" }, "neutral").body).toBe("Niekto vám volá");
    expect(renderNotification(DEFAULT_TEMPLATES.call, "fi", { app: "M5cet" }, "neutral").body).toBe("Joku soittaa");
  });
});

describe("the pickers", () => {
  it("offer the nine languages by their own names, with their tags", () => {
    expect([...SUPPORTED_LANGS]).toEqual([...LOCALES]);
    expect(SUPPORTED_LANGS.map(langLabel)).toEqual(["English", "Čeština", "Deutsch", "Español", "Italiano", "Français", "Slovenčina", "Slovenščina", "Suomi"]);
    expect(LANGUAGE_CHOICES.map((c) => c.tag)).toEqual(LOCALES.map((l) => LOCALE_INFO[l].tag));
  });

  it("Settings lists them and switches the language", () => {
    const setPrefs = vi.fn();
    const prefs = { ...loadPreferences(), lang: "cs" as Lang };
    render(<SettingsPanel open onClose={() => undefined} prefs={prefs} setPrefs={setPrefs} lang="cs" />);
    const select = screen.getByTestId("select-language") as HTMLSelectElement;
    const options = [...select.querySelectorAll("option")];
    expect(options.map((o) => o.value)).toEqual([...LOCALES]);
    expect(options.map((o) => o.textContent)).toContain("Slovenščina");
    expect(options.find((o) => o.value === "fi")?.getAttribute("lang")).toBe("fi-FI");
    fireEvent.change(select, { target: { value: "fi" } });
    expect(setPrefs).toHaveBeenCalledWith({ lang: "fi" });
  });

  it("the start screen has the picker (with onLang) and reports the choice", () => {
    const onLang = vi.fn();
    render(<StartScreen {...startProps("start", "en")} onLang={onLang} />);
    const select = screen.getByTestId("start-language") as HTMLSelectElement;
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(SUPPORTED_LANGS.map(langLabel));
    expect(select.getAttribute("aria-label")).toBe("Language");
    fireEvent.change(select, { target: { value: "sk" } });
    expect(onLang).toHaveBeenCalledWith("sk");
  });

  it("no picker on the start screen when nobody listens", () => {
    const { onLang: _drop, ...rest } = startProps("start", "en");
    render(<StartScreen {...rest} />);
    expect(screen.queryByTestId("start-language")).toBeNull();
  });
});

describe("switching at runtime", () => {
  function Probe({ initial }: { initial: Lang }) {
    const [wanted, setWanted] = useState<Lang>(initial);
    const lang = useLoadedLang(wanted);
    return (
      <div>
        <p data-testid="probe">{t(lang, "common.close")}</p>
        <button type="button" onClick={() => setWanted("fi")}>fi</button>
        <button type="button" onClick={() => setWanted("sk")}>sk</button>
        <button type="button" onClick={() => setWanted("de")}>de</button>
      </div>
    );
  }

  it("loads the language's chunk, then redraws in it; <html lang> follows", async () => {
    render(<Probe initial="en" />);
    expect(screen.getByTestId("probe").textContent).toBe("Close");
    await act(async () => { fireEvent.click(screen.getByText("fi")); });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Sulje"));
    await waitFor(() => expect(document.documentElement.getAttribute("lang")).toBe("fi-FI"));
    await act(async () => { fireEvent.click(screen.getByText("sk")); });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Zavrieť"));
    await act(async () => { fireEvent.click(screen.getByText("de")); });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Schließen"));
    expect(document.documentElement.getAttribute("lang")).toBe("de-DE");
  });

  it("applyDocumentLang writes the tag and the direction", () => {
    applyDocumentLang("sl");
    expect(document.documentElement.getAttribute("lang")).toBe("sl-SI");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
    expect(langTag("cs")).toBe("cs-CZ");
  });
});
