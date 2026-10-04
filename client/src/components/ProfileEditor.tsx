// The profile card's editor (6.7), a live part ("card") of the Profile
// panel: the photo and the background (re-encoded here, metadata dropped),
// the public nickname, the about text and any number of typed fields — each
// with its audience: only me (lock), room members (people), public (globe).
// The preview shows exactly what each audience gets (viewFor). Saving seals
// the whole card into the vault and brings the server's public copy in line
// (profile/client.ts).

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Globe, Lock, Plus, Trash2, Users } from "lucide-react";
import { t, tf, type Lang } from "../lib/i18n";
import {
  cleanValue, FIELD_TYPES, newFieldId, PROFILE_LIMITS, viewFor,
  type Audience, type FieldType, type ProfileCard, type ProfileItem,
} from "../lib/profile/model";
import { currentCard, loadCard, onCardChange, saveCard } from "../lib/profile/client";
import { sanitizeImage, type ImageKind } from "../lib/profile/image";
import { ProfileCardView } from "./ProfileCardView";
import "./profile.css";

const AUD_ICON = { me: Lock, room: Users, public: Globe } as const;

/** Three buttons: who sees this item. */
export function AudienceSwitch({ value, onChange, lang, testId }: { value: Audience; onChange: (a: Audience) => void; lang: Lang; testId: string }) {
  return (
    <span className="pf-aud" role="group" aria-label={tf(lang, "pf.aud.pick", { who: t(lang, `pf.aud.${value}`) })} data-testid={testId} data-value={value}>
      {(["me", "room", "public"] as const).map((a) => {
        const Icon = AUD_ICON[a];
        return (
          <button key={a} type="button" aria-pressed={value === a} title={`${t(lang, `pf.aud.${a}`)} — ${t(lang, `pf.aud.${a}.hint`)}`} aria-label={t(lang, `pf.aud.${a}`)} onClick={() => onChange(a)} data-testid={`${testId}-${a}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </span>
  );
}

export function ProfileEditor({ lang, signedIn, onSaved }: { lang: Lang; signedIn: boolean; onSaved?: (card: ProfileCard) => void }) {
  const [saved, setSaved] = useState<ProfileCard | null>(() => currentCard());
  const [draft, setDraft] = useState<ProfileCard | null>(() => currentCard());
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState<Audience>("room");
  const [newType, setNewType] = useState<FieldType>("phone");
  const pickRef = useRef<{ avatar: HTMLInputElement | null; cover: HTMLInputElement | null }>({ avatar: null, cover: null });

  useEffect(() => onCardChange((c) => { setSaved(c); setDraft((d) => (d && saved && JSON.stringify(d) !== JSON.stringify(saved) ? d : c)); }), [saved]);
  useEffect(() => {
    if (!signedIn || currentCard()) return;
    let live = true;
    loadCard().then((c) => { if (live) { setSaved(c); setDraft(c); } }).catch((e: Error) => { if (live) setLoadError(e.message); });
    return () => { live = false; };
  }, [signedIn]);

  const preview = useMemo(() => (draft ? viewFor(draft, tab) : null), [draft, tab]);
  if (!signedIn) return <p className="pf-edit__hint" data-testid="profile-need-signin-card">{t(lang, "pf.needSignIn")}</p>;
  if (loadError) return <p className="pf-edit__msg text-destructive" data-testid="profile-load-failed">{tf(lang, "pf.loadFailed", { message: loadError })}</p>;
  if (!draft) return <p className="pf-edit__hint">{t(lang, "pf.loading")}</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const put = (patch: Partial<ProfileCard>) => { setDraft({ ...draft, ...patch }); setMsg(""); };
  const item = (key: "nickname" | "about" | "avatar" | "cover", patch: Partial<ProfileItem>) => put({ [key]: { ...draft[key], ...patch } } as Partial<ProfileCard>);

  const pick = async (kind: ImageKind, e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      item(kind, { value: await sanitizeImage(file, kind) });
    } catch (err) {
      setMsg(t(lang, (err as Error).message === "image-too-large" ? "pf.err.imageLarge" : "pf.err.image"));
    }
  };

  const onSave = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await saveCard(draft);
      setSaved(r.card); setDraft(r.card);
      setMsg(r.publicError ? tf(lang, "pf.saved.publicFailed", { message: r.publicError }) : t(lang, r.public === "published" ? "pf.saved.published" : r.public === "withdrawn" ? "pf.saved.withdrawn" : "pf.saved"));
      onSaved?.(r.card);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const imageRow = (kind: ImageKind) => (
    <div className="pf-edit__row" data-testid={`profile-${kind}`}>
      <div className="pf-edit__grow">
        <span className="pf-edit__label">{t(lang, kind === "avatar" ? "pf.avatar" : "pf.cover")}</span>
        <div className="pf-edit__image">
          {draft[kind].value ? <img className={`pf-edit__thumb${kind === "cover" ? " pf-edit__thumb--cover" : ""}`} src={draft[kind].value} alt="" /> : <span className={`pf-edit__thumb${kind === "cover" ? " pf-edit__thumb--cover" : ""}`} />}
          <input ref={(el) => { pickRef.current[kind] = el; }} type="file" accept="image/*" hidden onChange={(e) => void pick(kind, e)} data-testid={`profile-${kind}-file`} />
          <button type="button" className="acc-btn acc-btn--small" onClick={() => pickRef.current[kind]?.click()}>{t(lang, "pf.pick")}</button>
          {draft[kind].value ? <button type="button" className="acc-btn acc-btn--small" onClick={() => item(kind, { value: "" })} data-testid={`profile-${kind}-remove`}>{t(lang, "pf.remove")}</button> : null}
        </div>
      </div>
      <AudienceSwitch value={draft[kind].audience} onChange={(a) => item(kind, { audience: a })} lang={lang} testId={`profile-${kind}-aud`} />
    </div>
  );

  return (
    <div className="pf-edit" data-testid="profile-editor">
      <p className="pf-edit__hint">{t(lang, "pf.intro")}</p>
      <div className="pf-edit__legend">
        {(["me", "room", "public"] as const).map((a) => { const Icon = AUD_ICON[a]; return <span key={a}><Icon className="h-3.5 w-3.5" aria-hidden /><b>{t(lang, `pf.aud.${a}`)}</b> — {t(lang, `pf.aud.${a}.hint`)}</span>; })}
      </div>

      {imageRow("avatar")}
      {imageRow("cover")}
      <p className="pf-edit__hint">{t(lang, "pf.image.note")}</p>

      <div className="pf-edit__row">
        <label className="pf-edit__grow">
          <span className="pf-edit__label">{t(lang, "pf.nickname")}</span>
          <input className="pf-edit__input" value={draft.nickname.value} maxLength={PROFILE_LIMITS.nicknameChars} onChange={(e) => item("nickname", { value: e.target.value })} data-testid="profile-nickname" />
          <span className="pf-edit__hint">{t(lang, "pf.nickname.hint")}</span>
        </label>
        <AudienceSwitch value={draft.nickname.audience} onChange={(a) => item("nickname", { audience: a })} lang={lang} testId="profile-nickname-aud" />
      </div>

      <div className="pf-edit__row">
        <label className="pf-edit__grow">
          <span className="pf-edit__label">{t(lang, "pf.about")}</span>
          <textarea className="pf-edit__input" value={draft.about.value} maxLength={PROFILE_LIMITS.aboutChars} onChange={(e) => item("about", { value: e.target.value })} data-testid="profile-about" />
        </label>
        <AudienceSwitch value={draft.about.audience} onChange={(a) => item("about", { audience: a })} lang={lang} testId="profile-about-aud" />
      </div>

      <div className="grid gap-2">
        <span className="pf-edit__label">{t(lang, "pf.fields")}</span>
        {draft.fields.map((f, i) => {
          const invalid = Boolean(f.value.trim()) && !cleanValue(f.type, f.value);
          const set = (patch: Partial<typeof f>) => put({ fields: draft.fields.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
          return (
            <div className="pf-edit__row" key={f.id} data-testid={`profile-field-${i}`}>
              <div className="pf-edit__field">
                <select className="pf-edit__input" value={f.type} onChange={(e) => set({ type: e.target.value as FieldType })} aria-label={t(lang, "pf.fields")} data-testid={`profile-field-${i}-type`}>
                  {FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{t(lang, `pf.type.${ft}`)}</option>)}
                </select>
                <input className="pf-edit__input" value={f.label} maxLength={PROFILE_LIMITS.labelChars} placeholder={t(lang, "pf.field.label")} aria-label={t(lang, "pf.field.label")} onChange={(e) => set({ label: e.target.value })} data-testid={`profile-field-${i}-label`} />
                {f.type === "address" || f.type === "other"
                  ? <textarea className="pf-edit__input" style={{ gridColumn: "1 / -1" }} value={f.value} maxLength={PROFILE_LIMITS.addressChars} placeholder={t(lang, "pf.field.value")} aria-label={t(lang, "pf.field.value")} onChange={(e) => set({ value: e.target.value })} data-testid={`profile-field-${i}-value`} />
                  : <input className="pf-edit__input" style={{ gridColumn: "1 / -1" }} value={f.value} maxLength={PROFILE_LIMITS.valueChars} placeholder={t(lang, "pf.field.value")} aria-label={t(lang, "pf.field.value")} aria-invalid={invalid} title={invalid ? t(lang, "pf.field.invalid") : undefined} onChange={(e) => set({ value: e.target.value })} data-testid={`profile-field-${i}-value`} />}
                {invalid ? <span className="pf-edit__hint text-destructive" style={{ gridColumn: "1 / -1" }}>{t(lang, "pf.field.invalid")}</span> : null}
              </div>
              <AudienceSwitch value={f.audience} onChange={(a) => set({ audience: a })} lang={lang} testId={`profile-field-${i}-aud`} />
              <button type="button" className="pf-edit__icon-btn" aria-label={t(lang, "pf.field.remove")} title={t(lang, "pf.field.remove")} onClick={() => put({ fields: draft.fields.filter((_, k) => k !== i) })} data-testid={`profile-field-${i}-remove`}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          );
        })}
        {draft.fields.length < PROFILE_LIMITS.fields ? (
          <div className="pf-edit__actions">
            <select className="pf-edit__input" style={{ width: "auto" }} value={newType} onChange={(e) => setNewType(e.target.value as FieldType)} aria-label={t(lang, "pf.addField")} data-testid="profile-add-type">
              {FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{t(lang, `pf.type.${ft}`)}</option>)}
            </select>
            <button type="button" className="acc-btn acc-btn--small" onClick={() => put({ fields: [...draft.fields, { id: newFieldId(), type: newType, label: "", value: "", audience: "me" }] })} data-testid="profile-add-field">
              <Plus className="h-3.5 w-3.5" aria-hidden /> {t(lang, "pf.addField")}
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-2">
        <span className="pf-edit__label">{t(lang, "pf.preview")}</span>
        <div className="pf-edit__tabs" role="tablist">
          {(["me", "room", "public"] as const).map((a) => { const Icon = AUD_ICON[a]; return (
            <button key={a} type="button" role="tab" aria-selected={tab === a} onClick={() => setTab(a)} data-testid={`profile-preview-${a}`}><Icon className="h-3 w-3" aria-hidden />{t(lang, `pf.aud.${a}`)}</button>
          ); })}
        </div>
        <ProfileCardView profile={preview} fallbackName={draft.nickname.value || "?"} lang={lang} testId="profile-preview" />
      </div>

      <div className="pf-edit__actions">
        <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60" disabled={busy || !dirty} onClick={() => void onSave()} data-testid="profile-save">
          {busy ? t(lang, "pf.saving") : t(lang, "pf.save")}
        </button>
        {dirty && !busy ? <span className="pf-edit__hint" data-testid="profile-dirty">{t(lang, "pf.dirty")}</span> : null}
        {msg ? <span className="pf-edit__msg" data-testid="profile-msg">{msg}</span> : null}
      </div>
    </div>
  );
}
