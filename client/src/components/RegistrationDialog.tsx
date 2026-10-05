// Registration (6.4): the form dialog — first and last name, country (a
// searchable select), mobile and e-mail. The shared checks
// (lib/registration/form.ts) answer while the person types; on submit the
// server checks again (the phone's line type, the e-mail domain's MX, whether
// either is registered), then App runs the passkey registration with the
// options /register/start issued and syncs this device's data into the new
// account. Loaded on demand (libphonenumber comes with it).

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ChevronDown, Loader2, Search } from "lucide-react";
import { SimpleModal } from "./SimpleModal";
import { langTag, t, tf, type Lang } from "../lib/i18n";
import { compareText } from "../lib/i18n-intl";
import {
  REGISTRATION_FIELDS, checkRegistration, flagEmoji,
  type Country, type RegistrationErrors, type RegistrationField, type RegistrationInput,
} from "../lib/registration/form";
import { check, countries as loadCountries } from "../lib/registration/client";
import "./registration.css";

export type RegisterResult = { ok: true } | { ok: false; fields?: Record<string, string>; message?: string };

type Phase = "edit" | "checking" | "registering";

/** The region of the browser's language ("cs" → CZ), if it is a country we know. */
function defaultCountry(list: Country[]): string {
  const codes = new Set(list.map((c) => c.code));
  for (const tag of navigator.languages ?? [navigator.language]) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (region && codes.has(region)) return region;
    } catch { /* not a locale */ }
  }
  return codes.has("CZ") ? "CZ" : list[0]?.code ?? "";
}

function errorText(lang: Lang, field: RegistrationField, code: string): string {
  for (const key of [`reg.err.${code}.${field}`, `reg.err.${code}`]) {
    const text = t(lang, key);
    if (text !== key) return text;
  }
  return code;
}

export function RegistrationDialog({ lang, signedIn, onClose, onRegister }: {
  lang: Lang;
  signedIn: boolean;
  onClose: () => void;
  onRegister: (form: RegistrationInput) => Promise<RegisterResult>;
}) {
  const [form, setForm] = useState<RegistrationInput>({ firstName: "", lastName: "", country: "", phone: "", email: "" });
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [touched, setTouched] = useState<Partial<Record<RegistrationField, boolean>>>({});
  const [phase, setPhase] = useState<Phase>("edit");
  const [message, setMessage] = useState("");
  const [list, setList] = useState<Country[] | null>(null);

  useEffect(() => {
    let live = true;
    loadCountries().then((c) => {
      if (!live) return;
      setList(c);
      setForm((f) => (f.country ? f : { ...f, country: defaultCountry(c) }));
    }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);

  const names = useMemo(() => {
    try { return new Intl.DisplayNames([langTag(lang)], { type: "region" }); } catch { return null; }
  }, [lang]);
  const countryName = (code: string) => names?.of(code) ?? code;
  const dial = list?.find((c) => c.code === form.country)?.dial ?? "";

  // Errors of the shared checks, for the fields the person has left.
  const local = useMemo(() => {
    const r = checkRegistration(form);
    return r.ok ? {} : r.errors;
  }, [form]);
  const shown = (field: RegistrationField): string => {
    const code = errors[field] ?? (touched[field] ? local[field] : undefined);
    return code ? errorText(lang, field, code) : "";
  };

  const set = (field: RegistrationField, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    // A server verdict on this field no longer applies once it changes.
    setErrors((e) => { const next = { ...e }; delete next[field]; return next; });
    setMessage("");
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phase !== "edit" || signedIn) return;
    setTouched(Object.fromEntries(REGISTRATION_FIELDS.map((f) => [f, true])));
    const localCheck = checkRegistration(form);
    if (!localCheck.ok) { setErrors(localCheck.errors); return; }
    setPhase("checking");
    setMessage("");
    try {
      const remote = await check(form);
      if (!remote.ok) {
        setErrors(remote.errors);
        setMessage(remote.status === 429 ? t(lang, "reg.err.rate") : Object.keys(remote.errors).length ? "" : tf(lang, "reg.err.server", { message: remote.message }));
        setPhase("edit");
        return;
      }
      setPhase("registering");
      const result = await onRegister(remote.normalized);
      if (result.ok) { onClose(); return; }
      if (result.fields) setErrors(result.fields as RegistrationErrors);
      if (result.message) setMessage(result.message);
      setPhase("edit");
    } catch (err) {
      setMessage(tf(lang, "reg.err.server", { message: (err as Error).message }));
      setPhase("edit");
    }
  }

  const busy = phase !== "edit";
  const field = (name: RegistrationField, label: string, extra: { type?: string; autoComplete: string; inputMode?: "text" | "tel" | "email"; prefix?: string }) => {
    const error = shown(name);
    return (
      <label className="reg-field">
        <span className="reg-field__label">{label}</span>
        <span className={`reg-field__box${extra.prefix ? " reg-field__box--prefix" : ""}`}>
          {extra.prefix ? <span className="reg-field__prefix" aria-hidden="true">{extra.prefix}</span> : null}
          <input
            className="reg-input"
            name={name}
            type={extra.type ?? "text"}
            inputMode={extra.inputMode}
            autoComplete={extra.autoComplete}
            value={form[name]}
            disabled={busy || signedIn}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `reg-err-${name}` : undefined}
            onChange={(e) => set(name, e.target.value)}
            onBlur={() => setTouched((t0) => ({ ...t0, [name]: true }))}
            data-testid={`reg-${name}`}
          />
        </span>
        {error ? <span className="reg-error" id={`reg-err-${name}`} role="alert">{error}</span> : null}
      </label>
    );
  };

  return (
    <SimpleModal title={t(lang, "reg.title")} onClose={() => { if (phase !== "registering") onClose(); }} testId="registration-dialog" className="reg-dialog">
      <form className="reg-form" onSubmit={submit} noValidate>
        <p className="reg-intro">{t(lang, "reg.intro")}</p>
        {signedIn ? <p className="reg-banner" role="status">{t(lang, "reg.signedIn")}</p> : null}
        <div className="reg-row">
          {field("firstName", t(lang, "reg.firstName"), { autoComplete: "given-name" })}
          {field("lastName", t(lang, "reg.lastName"), { autoComplete: "family-name" })}
        </div>
        <CountrySelect
          lang={lang}
          list={list}
          value={form.country}
          nameOf={countryName}
          disabled={busy || signedIn}
          error={shown("country")}
          onChange={(code) => set("country", code)}
        />
        {field("phone", t(lang, "reg.phone"), { type: "tel", inputMode: "tel", autoComplete: "tel", prefix: dial ? `+${dial}` : undefined })}
        {field("email", t(lang, "reg.email"), { type: "email", inputMode: "email", autoComplete: "email" })}
        {message ? <p className="reg-error reg-error--form" role="alert">{message}</p> : null}
        <div className="reg-actions">
          <button type="button" className="acc-btn" onClick={onClose} disabled={phase === "registering"}>{t(lang, "reg.cancel")}</button>
          <button type="submit" className="acc-btn acc-btn--primary" disabled={busy || signedIn} data-testid="reg-submit">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {phase === "checking" ? t(lang, "reg.checking") : phase === "registering" ? t(lang, "reg.passkey") : t(lang, "reg.submit")}
          </button>
        </div>
      </form>
    </SimpleModal>
  );
}

/** A select with a search box: the button shows the flag, name and calling code. */
function CountrySelect({ lang, list, value, nameOf, disabled, error, onChange }: {
  lang: Lang;
  list: Country[] | null;
  value: string;
  nameOf: (code: string) => string;
  disabled: boolean;
  error: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo(() => {
    const byName = compareText(lang);
    const all = (list ?? []).map((c) => ({ ...c, name: nameOf(c.code) })).sort((a, b) => byName(a.name, b.name));
    const q = query.trim().toLowerCase().replace(/^\+/, "");
    if (!q) return all;
    const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    return all.filter((c) => plain(c.name).includes(plain(q)) || c.code.toLowerCase() === q || c.dial.startsWith(q));
  }, [list, query, nameOf, lang]);

  useEffect(() => { if (open) { setActive(0); searchRef.current?.focus(); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (code: string) => { onChange(code); setOpen(false); setQuery(""); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[active]) pick(items[active].code); }
    else if (e.key === "Escape") {
      // Closes the list, not the dialog.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  };
  const current = list?.find((c) => c.code === value);

  return (
    <div className="reg-field">
      <span className="reg-field__label" id="reg-country-label">{t(lang, "reg.country")}</span>
      <button
        type="button"
        className="reg-input reg-country"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="reg-country-label"
        aria-invalid={error ? true : undefined}
        disabled={disabled || !list}
        onClick={() => setOpen((o) => !o)}
        data-testid="reg-country"
      >
        <span className="reg-country__value">
          {current ? <>{flagEmoji(current.code)} {nameOf(current.code)} <span className="reg-country__dial">+{current.dial}</span></> : list ? "—" : t(lang, "reg.country.loading")}
        </span>
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <div className="reg-country__panel">
          <span className="reg-country__search">
            <Search className="h-4 w-4" aria-hidden="true" />
            <input
              ref={searchRef}
              className="reg-input"
              value={query}
              placeholder={t(lang, "reg.country.search")}
              aria-controls="reg-country-list"
              aria-activedescendant={items[active] ? `reg-country-${items[active].code}` : undefined}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              data-testid="reg-country-search"
            />
          </span>
          <ul className="reg-country__list" role="listbox" id="reg-country-list" aria-labelledby="reg-country-label" ref={listRef}>
            {items.length === 0 ? <li className="reg-country__none">{t(lang, "reg.country.none")}</li> : items.map((c, i) => (
              <li
                key={c.code}
                id={`reg-country-${c.code}`}
                role="option"
                aria-selected={c.code === value}
                data-index={i}
                className={`reg-country__item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(c.code); }}
              >
                <span aria-hidden="true">{flagEmoji(c.code)}</span>
                <span className="reg-country__name">{c.name}</span>
                <span className="reg-country__dial">+{c.dial}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <span className="reg-error" role="alert">{error}</span> : null}
    </div>
  );
}
