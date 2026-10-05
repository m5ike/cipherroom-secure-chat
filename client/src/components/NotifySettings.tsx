// The user's own notification settings (6.7), inside the Notifications
// panel: which kinds, how much a notification shows (within what the
// operator allows), the order of the channels the server tries (signed in),
// quiet hours, an e-mail address when the server sends e-mail, a preview of
// a notification at the chosen level, and a test. A signed-in user's choice
// lives on the server (so it knows how to notify); a guest's in this browser.

import { useEffect, useMemo, useState } from "react";
import { t, tf, tp, type Lang } from "../lib/i18n";
import {
  NOTIFY_CHANNELS, NOTIFY_PRIVACY, privacyRank,
  type NotifyChannel, type NotifyKind, type NotifyLang, type NotifyPrivacy, type UserNotifyPrefs,
} from "../lib/notify-template";
import {
  DEFAULT_POLICY, clearNotifyEmail, fetchNotifyPolicy, loadAccountNotify, loadGuestNotify, localNotification, saveAccountNotify,
  saveGuestNotify, setNotifyEmail, showLocalNotification, testAccountNotify,
  type NotifyEndpoints, type NotifyPolicy,
} from "../lib/notify-client";

const USER_KINDS: NotifyKind[] = ["message", "mention", "call", "function", "summon"];
const BOX = "space-y-2 rounded-xl border border-border p-3";
const BTN = "inline-flex min-h-9 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60";
const INPUT = "min-h-9 rounded-lg border border-border bg-background px-2 text-sm";

const zone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } };
/** 6.13: notifications speak the nine languages too (NotifyLang = Locale): the user's own, not the nearest of cs / en / de. */
const asLang = (lang: Lang): NotifyLang => lang;

/** What the layout builder's preview shows (it never touches the network). */
const SAMPLE_ENDPOINTS: NotifyEndpoints = {
  android: [{ id: "and_sample", name: "Pixel", model: "Pixel 9", lastSeen: 0, fcm: true, linkedAt: 0 }],
  webpush: 1,
  email: null,
  ready: { android: { ready: true, reason: "", on: true }, webpush: { ready: true, reason: "", on: true }, email: { ready: false, reason: "no SMTP relay", on: false } },
};

export function NotifySettings({ lang, signedIn, offline = false }: { lang: Lang; signedIn: boolean; offline?: boolean }) {
  const [prefs, setPrefs] = useState<UserNotifyPrefs>(() => loadGuestNotify());
  const [policy, setPolicy] = useState<NotifyPolicy>(DEFAULT_POLICY);
  const [endpoints, setEndpoints] = useState<NotifyEndpoints | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (offline) { setPolicy(DEFAULT_POLICY); setEndpoints(signedIn ? SAMPLE_ENDPOINTS : null); return; }
    let cancelled = false;
    void (async () => {
      try {
        if (signedIn) {
          const r = await loadAccountNotify();
          if (cancelled) return;
          setPolicy(r.policy);
          setEndpoints(r.endpoints);
          setPrefs(r.saved ? r.prefs : { ...r.prefs, lang: asLang(lang), quiet: { ...r.prefs.quiet, tz: zone() } });
        } else {
          const p = await fetchNotifyPolicy();
          if (cancelled) return;
          setPolicy(p);
          setEndpoints(null);
          setPrefs(loadGuestNotify());
        }
      } catch (err) {
        if (!cancelled) setMsg(tf(lang, "notify.loadFailed", { error: (err as Error).message }));
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, lang, offline]);

  const patch = (p: Partial<UserNotifyPrefs>) => { setPrefs((cur) => ({ ...cur, ...p })); setMsg(""); };
  const kindOn = (k: NotifyKind) => prefs.kinds[k] !== false;
  const offered = USER_KINDS.filter((k) => policy.templates[k]?.on !== false);
  const levelName = (p: NotifyPrivacy) => t(lang, `notify.privacy.${p}`);

  // The channels in the user's order first, then the rest (not used).
  const channelRows = useMemo(() => {
    const used = prefs.order.filter((c) => (NOTIFY_CHANNELS as readonly string[]).includes(c));
    return [...used.map((id) => ({ id, used: true })), ...NOTIFY_CHANNELS.filter((c) => !used.includes(c)).map((id) => ({ id, used: false }))];
  }, [prefs.order]);

  const move = (id: NotifyChannel, by: -1 | 1) => {
    const order = [...prefs.order];
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    patch({ order });
  };
  const use = (id: NotifyChannel, on: boolean) => patch({ order: on ? [...prefs.order.filter((c) => c !== id), id] : prefs.order.filter((c) => c !== id) });

  const channelStatus = (id: NotifyChannel): string => {
    const r = endpoints?.ready[id];
    if (r && !r.on) return t(lang, "notify.channel.off");
    if (r && !r.ready) return tf(lang, "notify.channel.unready", { reason: r.reason });
    if (id === "android") return endpoints?.android.length ? tp(lang, "notify.channel.devices", endpoints.android.length) : t(lang, "notify.channel.none");
    if (id === "webpush") return endpoints?.webpush ? tp(lang, "notify.channel.browsers", endpoints.webpush) : t(lang, "notify.channel.none");
    const e = endpoints?.email;
    return e ? tf(lang, e.confirmed ? "notify.email.confirmed" : "notify.email.pending", { address: e.address }) : t(lang, "notify.channel.none");
  };

  // Kinds whose maximum is below the chosen level.
  const capped = prefs.privacy ? offered.filter((k) => privacyRank(policy.templates[k].maxPrivacy) < privacyRank(prefs.privacy as NotifyPrivacy)) : [];

  const preview = localNotification(
    { kind: "message", sender: t(lang, "notify.preview.sender"), room: t(lang, "notify.preview.room"), text: t(lang, "notify.preview.text"), count: 2 },
    { prefs: { ...prefs, on: true, kinds: {}, quiet: { ...prefs.quiet, on: false } }, policy, lang: asLang(lang), asPush: !prefs.privacy },
  );

  async function save() {
    setBusy(true);
    const next = { ...prefs, lang: asLang(lang), quiet: { ...prefs.quiet, tz: prefs.quiet.tz || zone() } };
    try {
      if (signedIn) { setPrefs(await saveAccountNotify(next)); setMsg(t(lang, "notify.saved")); }
      else { setPrefs(saveGuestNotify(next)); setMsg(t(lang, "notify.savedLocal")); }
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      if (!signedIn) {
        const n = showLocalNotification({ kind: "test" }, { prefs, policy, lang: asLang(lang) });
        setMsg(n ? t(lang, "notify.test.local") : t(lang, "app.notify.denied"));
        return;
      }
      const r = await testAccountNotify();
      if (r.ok) setMsg(tf(lang, "notify.test.ok", { channel: t(lang, `notify.channel.${r.channel}`) }));
      else if (r.skipped) setMsg(tf(lang, "notify.test.skipped", { reason: r.skipped }));
      else setMsg(tf(lang, "notify.test.failed", { errors: r.attempts.map((a) => `${a.channel}: ${a.error ?? "?"}`).join("; ") }));
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail() {
    setBusy(true);
    try {
      const e = await setNotifyEmail(address);
      setEndpoints((cur) => (cur ? { ...cur, email: { ...e, sentAt: Date.now() } } : cur));
      setMsg(tf(lang, "notify.email.sent", { address: e.address }));
      setAddress("");
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function forgetEmail() {
    try { await clearNotifyEmail(); setEndpoints((cur) => (cur ? { ...cur, email: null } : cur)); } catch (err) { setMsg((err as Error).message); }
  }

  const emailOffered = policy.channels.some((c) => c.id === "email" && c.on);

  return (
    <section className="mb-5 space-y-3" data-testid="notify-settings">
      <h3 className="text-sm font-semibold tracking-tight">{t(lang, "notify.title")}</h3>
      {!policy.enabled ? <p className="text-xs text-muted-foreground" data-testid="notify-server-off">{t(lang, "notify.serverOff")}</p> : null}
      {!signedIn ? <p className="text-xs text-muted-foreground" data-testid="notify-guest">{t(lang, "notify.guest")}</p> : null}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={prefs.on} onChange={(e) => patch({ on: e.target.checked })} data-testid="notify-on" />
        {t(lang, "notify.on")}
      </label>

      <div className={BOX}>
        <div className="text-xs font-semibold text-muted-foreground">{t(lang, "notify.kinds")}</div>
        {offered.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={kindOn(k)} disabled={!prefs.on} onChange={(e) => patch({ kinds: { ...prefs.kinds, [k]: e.target.checked } })} data-testid={`notify-kind-${k}`} />
            {t(lang, `notify.kind.${k}`)}
          </label>
        ))}
      </div>

      <div className={BOX}>
        <label className="block text-xs font-semibold text-muted-foreground" htmlFor="notify-privacy">{t(lang, "notify.privacy")}</label>
        <select id="notify-privacy" className={`${INPUT} w-full`} value={prefs.privacy} onChange={(e) => patch({ privacy: e.target.value as NotifyPrivacy | "" })} data-testid="notify-privacy">
          <option value="">{t(lang, "notify.privacy.default")}</option>
          {NOTIFY_PRIVACY.map((p) => <option key={p} value={p}>{levelName(p)}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">{t(lang, "notify.privacy.hint")}</p>
        {capped.map((k) => (
          <p key={k} className="text-xs text-amber-600" data-testid={`notify-capped-${k}`}>{tf(lang, "notify.privacy.capped", { kind: t(lang, `notify.kind.${k}`), level: levelName(policy.templates[k].maxPrivacy) })}</p>
        ))}
        {preview ? (
          <div className="rounded-lg bg-muted/50 p-2" data-testid="notify-preview">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t(lang, "notify.preview")}</div>
            <div className="text-sm font-semibold" data-testid="notify-preview-title">{preview.title}</div>
            <div className="text-sm" data-testid="notify-preview-body">{preview.options.body}</div>
          </div>
        ) : null}
      </div>

      {signedIn ? (
        <div className={BOX}>
          <div className="text-xs font-semibold text-muted-foreground">{t(lang, "notify.channels")}</div>
          <p className="text-xs text-muted-foreground">{t(lang, "notify.channels.hint")}</p>
          <ol className="space-y-1">
            {channelRows.map(({ id, used }, i) => (
              <li key={id} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`notify-channel-${id}`}>
                <input type="checkbox" checked={used} onChange={(e) => use(id, e.target.checked)} aria-label={`${t(lang, "notify.use")}: ${t(lang, `notify.channel.${id}`)}`} data-testid={`notify-use-${id}`} />
                <span className="min-w-0 flex-1">
                  <span className={used ? "font-medium" : "text-muted-foreground"}>{used ? `${i + 1}. ` : ""}{t(lang, `notify.channel.${id}`)}</span>
                  <span className="block text-xs text-muted-foreground" data-testid={`notify-status-${id}`}>{channelStatus(id)}</span>
                </span>
                <button type="button" className={BTN} disabled={!used || i === 0} onClick={() => move(id, -1)} aria-label={t(lang, "notify.up")} data-testid={`notify-up-${id}`}>↑</button>
                <button type="button" className={BTN} disabled={!used || i >= prefs.order.length - 1} onClick={() => move(id, 1)} aria-label={t(lang, "notify.down")} data-testid={`notify-down-${id}`}>↓</button>
              </li>
            ))}
          </ol>
          {emailOffered ? (
            <div className="flex flex-wrap items-center gap-2">
              <input type="email" className={`${INPUT} min-w-0 flex-1`} placeholder={t(lang, "notify.email.address")} aria-label={t(lang, "notify.email.address")} value={address} onChange={(e) => setAddress(e.target.value)} data-testid="notify-email-input" />
              <button type="button" className={BTN} disabled={busy || !address.includes("@")} onClick={() => void sendEmail()} data-testid="notify-email-send">{t(lang, "notify.email.send")}</button>
              {endpoints?.email ? <button type="button" className={BTN} onClick={() => void forgetEmail()} data-testid="notify-email-remove">{t(lang, "notify.email.remove")}</button> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={BOX}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={prefs.quiet.on} onChange={(e) => patch({ quiet: { ...prefs.quiet, on: e.target.checked } })} data-testid="notify-quiet" />
          {t(lang, "notify.quiet")}
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">{t(lang, "notify.quiet.from")}
            <input type="time" className={INPUT} value={prefs.quiet.from} disabled={!prefs.quiet.on} onChange={(e) => e.target.value && patch({ quiet: { ...prefs.quiet, from: e.target.value } })} data-testid="notify-quiet-from" />
          </label>
          <label className="flex items-center gap-1">{t(lang, "notify.quiet.to")}
            <input type="time" className={INPUT} value={prefs.quiet.to} disabled={!prefs.quiet.on} onChange={(e) => e.target.value && patch({ quiet: { ...prefs.quiet, to: e.target.value } })} data-testid="notify-quiet-to" />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{t(lang, "notify.quiet.hint")}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60" disabled={busy} onClick={() => void save()} data-testid="notify-save">{t(lang, "notify.save")}</button>
        <button type="button" className={BTN} disabled={busy} onClick={() => void test()} data-testid="notify-test">{t(lang, "notify.test")}</button>
      </div>
      {msg ? <p className="text-xs text-muted-foreground" role="status" data-testid="notify-msg">{msg}</p> : null}
    </section>
  );
}
