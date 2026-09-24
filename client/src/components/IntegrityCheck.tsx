// The version check in the interface (4.0): runs lib/integrity.ts on start,
// when the tab comes back, every ten minutes and after a sign-in; when this
// browser runs something else than the server deploys, a window explains it,
// lists what differs and offers "Fix" — wipe this app's cache and data here
// and load everything fresh.

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { AlertTriangle, RefreshCw, Wrench } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { checkIntegrity, repairAndReload, type Mismatch } from "../lib/integrity";
import { SimpleModal } from "./SimpleModal";

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
      <div className="ic">
        <p className="ic-lead"><AlertTriangle className="h-5 w-5 flex-none" aria-hidden="true" /><span>{t(lang, "ver.desc")}</span></p>
        <h3 className="ic-title">{t(lang, "ver.found")} <span className="ic-count">{found.length}</span></h3>
        <div className="ic-table-wrap">
          <table className="ic-table" data-testid="integrity-list">
            <thead>
              <tr><th>{t(lang, "ver.col.item")}</th><th>{t(lang, "ver.col.local")}</th><th>{t(lang, "ver.col.server")}</th></tr>
            </thead>
            <tbody>
              {found.map((m, i) => (
                <tr key={`${m.kind}-${m.item}-${i}`} data-kind={m.kind}>
                  <td><span className="ic-kind">{t(lang, `ver.kind.${m.kind}`)}</span> <code>{m.item}</code></td>
                  <td><code>{m.local}</code></td>
                  <td><code>{m.server || t(lang, "ver.missing")}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ic-fix-desc">{t(lang, "ver.fix.desc")}</p>
        <label className="ic-keep">
          <input type="checkbox" checked={keepPrefs} onChange={(e) => setKeepPrefs(e.target.checked)} data-testid="integrity-keep" />
          {t(lang, "ver.keepPrefs")}
        </label>
        <div className="ic-actions">
          <button type="button" className="acc-btn acc-btn--primary" disabled={fixing} data-testid="integrity-fix"
            onClick={() => { setFixing(true); void repairAndReload({ keepPrefs }); }}>
            {fixing ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Wrench className="h-4 w-4" aria-hidden="true" />}
            {fixing ? t(lang, "ver.fixing") : t(lang, "ver.fix")}
          </button>
          <button type="button" className="acc-btn" onClick={later} disabled={fixing} data-testid="integrity-later">{t(lang, "ver.later")}</button>
        </div>
      </div>
    </SimpleModal>
  );
}
