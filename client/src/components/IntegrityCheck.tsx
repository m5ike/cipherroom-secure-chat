// The version check in the interface (4.0): runs lib/integrity.ts on start,
// when the tab comes back, every ten minutes and after a sign-in; when this
// browser runs something else than the server deploys, a window explains it,
// lists what differs and offers "Fix" — wipe this app's cache and data here
// and load everything fresh.

//
// 4.13: the window's content is a layout ("dialog.integrity", lib/layouts/dialogs.ts).

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent, type Ref } from "react";
import { t, type Lang } from "../lib/i18n";
import { checkIntegrity, repairAndReload, type Mismatch } from "../lib/integrity";
import { SimpleModal } from "./SimpleModal";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

export type IntegrityHandle = { check: (now?: boolean) => Promise<void> };

const RECHECK_MS = 10 * 60 * 1000;
/** "Later" quiets the window for this long (a new deploy asks again). */
const SNOOZE_MS = 30 * 60 * 1000;

export function IntegrityCheck({ lang, onMismatch, handle }: {
  lang: Lang;
  /** Told once per found set (the App logs it for the operator). */
  onMismatch?: (mismatches: Mismatch[]) => void;
  handle?: Ref<IntegrityHandle>;
}) {
  const [found, setFound] = useState<Mismatch[] | null>(null);
  const [keepPrefs, setKeepPrefs] = useState(true);
  const [fixing, setFixing] = useState(false);
  const snoozed = useRef<{ until: number; key: string } | null>(null);
  const busy = useRef(false);
  const lastRun = useRef(0);
  const onMismatchRef = useRef(onMismatch);
  onMismatchRef.current = onMismatch;

  const check = useCallback(async (now = false) => {
    if (busy.current || (!now && Date.now() - lastRun.current < 60_000)) return;
    busy.current = true;
    lastRun.current = Date.now();
    try {
      const { mismatches } = await checkIntegrity();
      if (mismatches.length === 0) { setFound(null); return; }
      const key = mismatches.map((m) => `${m.kind}:${m.item}:${m.server}`).join("|");
      if (!now && snoozed.current && snoozed.current.key === key && Date.now() < snoozed.current.until) return;
      setFound((cur) => {
        if (!cur || cur.map((m) => `${m.kind}:${m.item}:${m.server}`).join("|") !== key) onMismatchRef.current?.(mismatches);
        return mismatches;
      });
    } finally {
      busy.current = false;
    }
  }, []);

  useImperativeHandle(handle, () => ({ check }), [check]);
  const { tree, base } = useLayoutBase("dialog.integrity", lang);

  useEffect(() => {
    const first = window.setTimeout(() => { void check(true); }, 2500);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void check(); }, RECHECK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [check]);

  if (!found || found.length === 0) return null;

  const later = () => {
    snoozed.current = { until: Date.now() + SNOOZE_MS, key: found.map((m) => `${m.kind}:${m.item}:${m.server}`).join("|") };
    setFound(null);
  };

  return (
    <SimpleModal title={t(lang, "ver.title")} onClose={later} testId="integrity-modal">
      {renderLayout(tree, {
        ...base,
        data: { found: found.map((m, i) => ({ ...m, key: `${m.kind}-${m.item}-${i}` })), keepPrefs, fixing },
        actions: {
          keepPrefs: (e) => setKeepPrefs((e as ChangeEvent<HTMLInputElement>).target.checked),
          fix: () => { setFixing(true); void repairAndReload({ keepPrefs }); },
          later: () => later(),
        },
      })}
    </SimpleModal>
  );
}
