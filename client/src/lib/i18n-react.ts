// 6.13: switching the language at runtime, without a reload. The screen keeps
// the language it shows until the new one's texts have arrived (its chunk),
// then switches in one render — no flash of half-translated text. <html lang>
// follows with the language's BCP 47 tag.

import { useEffect, useState } from "react";
import { hasLocale, langTag, type Lang } from "./i18n";
import { loadLocale } from "./i18n-load";

/** <html lang="…"> and dir for a language (all nine are written left to right). */
export function applyDocumentLang(lang: Lang): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("lang", langTag(lang));
  root.setAttribute("dir", "ltr");
}

/**
 * The language to draw with: the wanted one once its texts are here (built
 * in, or loaded), until then the one shown before. A failed load still
 * switches — the texts then come from the fallbacks (localeChain).
 */
export function useLoadedLang(wanted: Lang): Lang {
  const [shown, setShown] = useState<Lang>(() => (hasLocale(wanted) ? wanted : "en"));
  useEffect(() => {
    let live = true;
    if (hasLocale(wanted)) setShown(wanted);
    else void loadLocale(wanted).then(() => { if (live) setShown(wanted); });
    return () => { live = false; };
  }, [wanted]);
  useEffect(() => { applyDocumentLang(shown); }, [shown]);
  return hasLocale(wanted) && shown !== wanted ? wanted : shown;
}
