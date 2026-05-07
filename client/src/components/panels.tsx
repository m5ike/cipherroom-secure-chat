// Modal-window panels exposed from the top menu. Each panel reads/writes the
// shared Preferences object via the props passed in from App.tsx.

import { useState } from "react";
import {
  AlertTriangle,
  BellRing,
  Cloud,
  Eraser,
  KeyRound,
  Languages,
  Palette,
  PuzzleIcon,
  ShieldCheck,
  Trash2,
  UserCircle2,
  Lock,
} from "lucide-react";
import { Modal } from "./Modal";
import { THEMES, FONT_FAMILIES, type ThemeId } from "@/lib/themes";
import { langLabel, SUPPORTED_LANGS, t, type Lang } from "@/lib/i18n";
import { DEFAULT_ROOM_SECURITY, type Preferences, type RoomSecurity } from "@/lib/preferences";

type PanelBaseProps = {
  open: boolean;
  onClose: () => void;
  prefs: Preferences;
  setPrefs: (next: Partial<Preferences>) => void;
  lang: Lang;
};

const Section: React.FC<{ title: string; description?: string; icon?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  description,
  icon,
  children,
}) => (
  <section className="mb-5 space-y-3">
    <div className="flex items-start gap-3">
      {icon ? <div className="mt-0.5 text-primary">{icon}</div> : null}
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
    </div>
    <div className="space-y-2">{children}</div>
  </section>
);

const Row: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <label className="grid gap-1 text-sm">
    <span className="font-medium">{label}</span>
    {children}
    {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
  </label>
);

const inputClass =
  "min-h-10 rounded-xl border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";
const selectClass = inputClass;

export function ProfilePanel({ open, onClose, prefs, setPrefs, lang }: PanelBaseProps) {
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "profile.title")}>
      <Section title={t(lang, "profile.title")} icon={<UserCircle2 className="h-4 w-4" />}>
        <Row label={t(lang, "profile.display.name")}>
          <input
            data-testid="input-profile-name"
            className={inputClass}
            value={prefs.name}
            maxLength={42}
            onChange={(event) => setPrefs({ name: event.target.value })}
          />
        </Row>
        <Row label={t(lang, "profile.avatar")}>
          <input
            data-testid="input-profile-avatar"
            className={inputClass}
            value={prefs.avatar}
            placeholder="🦊  or  https://..."
            onChange={(event) => setPrefs({ avatar: event.target.value })}
          />
        </Row>
        <Row label={t(lang, "profile.bio")}>
          <textarea
            data-testid="input-profile-bio"
            className={`${inputClass} min-h-24 py-2`}
            value={prefs.bio}
            maxLength={280}
            onChange={(event) => setPrefs({ bio: event.target.value })}
          />
        </Row>
      </Section>
    </Modal>
  );
}

export function SettingsPanel({ open, onClose, prefs, setPrefs, lang }: PanelBaseProps) {
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "menu.settings")}>
      <Section title={t(lang, "common.language")} icon={<Languages className="h-4 w-4" />}>
        <Row label={t(lang, "common.language")}>
          <select
            className={selectClass}
            value={prefs.lang}
            onChange={(event) => setPrefs({ lang: event.target.value as Lang })}
            data-testid="select-language"
          >
            {SUPPORTED_LANGS.map((code) => (
              <option key={code} value={code}>
                {langLabel(code)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t(lang, "common.timezone")} hint={Intl.DateTimeFormat().resolvedOptions().timeZone}>
          <input
            className={inputClass}
            value={prefs.timezone}
            onChange={(event) => setPrefs({ timezone: event.target.value })}
            data-testid="input-timezone"
          />
        </Row>
      </Section>
      <Section title={t(lang, "common.theme")} icon={<Palette className="h-4 w-4" />}>
        <div className="grid gap-2 sm:grid-cols-3" data-testid="theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              onClick={() => setPrefs({ theme: theme.id as ThemeId })}
              className={`rounded-2xl border p-3 text-left text-xs transition ${
                prefs.theme === theme.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-accent"
              }`}
              data-testid={`theme-${theme.id}`}
            >
              <div className="mb-1 h-1.5 w-full rounded-full m5-stripe" />
              <div className="font-semibold">{t(lang, theme.labelKey)}</div>
              <div className="text-[11px] text-muted-foreground">{theme.tone}</div>
            </button>
          ))}
        </div>
        <Row label={t(lang, "common.font")}>
          <select
            className={selectClass}
            value={prefs.font}
            onChange={(event) => setPrefs({ font: event.target.value })}
          >
            {FONT_FAMILIES.map((font) => (
              <option key={font.id} value={font.id}>{font.label}</option>
            ))}
          </select>
        </Row>
        <Row label={t(lang, "common.size")}>
          <select
            className={selectClass}
            value={prefs.fontSize}
            onChange={(event) => setPrefs({ fontSize: event.target.value as Preferences["fontSize"] })}
          >
            <option value="sm">S</option>
            <option value="md">M</option>
            <option value="lg">L</option>
          </select>
        </Row>
        <label className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm">
          <span>{t(lang, "common.effects")}</span>
          <input
            type="checkbox"
            checked={prefs.effects}
            onChange={(event) => setPrefs({ effects: event.target.checked })}
          />
        </label>
      </Section>
    </Modal>
  );
}

export function TemplatesPanel({ open, onClose, prefs, setPrefs, lang }: PanelBaseProps) {
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "menu.templates")}>
      <p className="mb-4 text-sm text-muted-foreground">
        {prefs.lang === "cs"
          ? "Zvol vizuální šablonu. Změna je okamžitá a uloží se lokálně."
          : prefs.lang === "de"
            ? "Wähle eine Vorlage. Wirkt sofort und wird lokal gespeichert."
            : "Pick a template. Applied instantly and stored locally."}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            data-testid={`template-${theme.id}`}
            onClick={() => setPrefs({ theme: theme.id as ThemeId })}
            className={`rounded-3xl border p-4 text-left transition ${
              prefs.theme === theme.id
                ? "border-primary bg-primary/10"
                : "border-border hover:bg-accent"
            }`}
          >
            <div className="mb-3 h-2 w-full rounded-full m5-stripe" />
            <div className="text-sm font-semibold">{t(lang, theme.labelKey)}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {theme.id === "motorsport" && (lang === "cs" ? "Tmavé, sportovní, ostré akcenty." : lang === "de" ? "Dunkel, sportlich, scharfe Akzente." : "Dark, sporty, sharp accents.")}
              {theme.id === "glass" && (lang === "cs" ? "Světlé, sklovité panely, čistý layout." : lang === "de" ? "Hell, gläsern, klarer Aufbau." : "Light, glassy panels, clean layout.")}
              {theme.id === "terminal" && (lang === "cs" ? "Konzolový styl, monospace, tmavě zelená." : lang === "de" ? "Konsolen-Stil, monospace, dunkelgrün." : "Console style, monospace, dark green.")}
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

type PrivacyExtras = {
  onLocalPurge: () => void;
  onServerPurge: () => Promise<{ ok: boolean; message?: string }>;
};

export function PrivacyPanel({
  open,
  onClose,
  prefs,
  setPrefs,
  lang,
  onLocalPurge,
  onServerPurge,
}: PanelBaseProps & PrivacyExtras) {
  const [serverStatus, setServerStatus] = useState<string>("");

  return (
    <Modal open={open} onClose={onClose} title={t(lang, "privacy.title")}>
      <Section title={t(lang, "privacy.consent")} icon={<ShieldCheck className="h-4 w-4" />}>
        <p className="text-xs text-muted-foreground">{t(lang, "privacy.consent.body")}</p>
        <label className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm">
          <span>{t(lang, "analytics.opt.in")}</span>
          <input
            type="checkbox"
            data-testid="check-analytics-consent"
            checked={prefs.analyticsConsent}
            onChange={(event) => setPrefs({ analyticsConsent: event.target.checked })}
          />
        </label>
      </Section>
      <Section title={t(lang, "privacy.local.purge")} icon={<Eraser className="h-4 w-4" />}>
        <button
          type="button"
          data-testid="button-local-purge"
          onClick={onLocalPurge}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent"
        >
          <Trash2 className="h-4 w-4" />
          {t(lang, "privacy.local.purge")}
        </button>
      </Section>
      <Section title={t(lang, "privacy.server.purge")} icon={<AlertTriangle className="h-4 w-4" />}>
        <button
          type="button"
          data-testid="button-server-purge"
          onClick={async () => {
            const result = await onServerPurge();
            setServerStatus(result.message || (result.ok ? "OK" : "FAIL"));
          }}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent"
        >
          <Cloud className="h-4 w-4" />
          {t(lang, "privacy.server.purge")}
        </button>
        {serverStatus ? (
          <p className="text-xs text-muted-foreground" data-testid="text-server-purge-result">{serverStatus}</p>
        ) : null}
      </Section>
    </Modal>
  );
}

export function EncryptionPanel({ open, onClose, prefs, setPrefs, lang }: PanelBaseProps) {
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "encryption.title")}>
      <Section title={t(lang, "encryption.dtls.label")} icon={<Lock className="h-4 w-4" />}>
        <p className="text-sm text-muted-foreground">{t(lang, "encryption.dtls.body")}</p>
      </Section>
      <Section title={t(lang, "encryption.aes.label")} icon={<ShieldCheck className="h-4 w-4" />}>
        <p className="text-sm text-muted-foreground">{t(lang, "encryption.aes.body")}</p>
      </Section>
      <Section title={t(lang, "encryption.kdf.label")} icon={<KeyRound className="h-4 w-4" />}>
        <p className="text-sm text-muted-foreground">{t(lang, "encryption.kdf.body")}</p>
      </Section>
      <p className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
        {t(lang, "encryption.disclaimer")}
      </p>
      <Section title="TTL" icon={<AlertTriangle className="h-4 w-4" />}>
        <Row label={t(lang, "ttl.user.default")} hint={t(lang, "ttl.unit.minutes")}>
          <input
            type="number"
            min={0}
            max={60 * 24 * 30}
            data-testid="input-ttl-default"
            value={prefs.ttlDefaultMinutes}
            onChange={(event) => setPrefs({ ttlDefaultMinutes: Math.max(0, Number(event.target.value) || 0) })}
            className={inputClass}
          />
        </Row>
      </Section>
    </Modal>
  );
}

export function NotificationsPanel({
  open,
  onClose,
  prefs,
  setPrefs,
  lang,
  onEnable,
  onDisable,
  pushAvailable,
}: PanelBaseProps & {
  onEnable: () => Promise<void>;
  onDisable: () => void;
  pushAvailable: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "notif.title")}>
      <Section title={t(lang, "notif.title")} icon={<BellRing className="h-4 w-4" />}>
        <p className="text-xs text-muted-foreground">
          {pushAvailable
            ? lang === "cs" ? "Push server (VAPID) je nakonfigurovaný."
              : lang === "de" ? "Push-Server (VAPID) ist konfiguriert." : "Push server (VAPID) is configured."
            : lang === "cs" ? "Push není konfigurován — použijí se lokální notifikace v tabu."
              : lang === "de" ? "Push nicht konfiguriert — lokale Benachrichtigungen im Tab." : "Push not configured — falling back to in-tab notifications."}
        </p>
        <div className="flex gap-2">
          {prefs.notificationsEnabled ? (
            <button
              type="button"
              onClick={onDisable}
              data-testid="button-notif-disable"
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent"
            >
              {t(lang, "common.disable")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onEnable()}
              data-testid="button-notif-enable"
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground"
            >
              {t(lang, "common.enable")}
            </button>
          )}
        </div>
      </Section>
    </Modal>
  );
}

export function AnalyticsPanel({ open, onClose, prefs, setPrefs, lang }: PanelBaseProps) {
  return (
    <Modal open={open} onClose={onClose} title={t(lang, "analytics.title")}>
      <Section title={t(lang, "analytics.title")} icon={<ShieldCheck className="h-4 w-4" />}>
        <p className="text-xs text-muted-foreground">{t(lang, "privacy.consent.body")}</p>
        <label className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm">
          <span>{t(lang, "analytics.opt.in")}</span>
          <input
            type="checkbox"
            data-testid="check-analytics-consent-2"
            checked={prefs.analyticsConsent}
            onChange={(event) => setPrefs({ analyticsConsent: event.target.checked })}
          />
        </label>
      </Section>
    </Modal>
  );
}

export function RoomSecurityPanel({
  open,
  onClose,
  prefs,
  setPrefs,
  lang,
  room,
}: PanelBaseProps & { room: string }) {
  const security: RoomSecurity = (room && prefs.roomSecurity[room]) || DEFAULT_ROOM_SECURITY;
  const ttl = (room && prefs.roomTtl[room]) || { defaultMinutes: prefs.ttlDefaultMinutes, absoluteMinutes: 0 };

  function setSecurity(patch: Partial<RoomSecurity>) {
    if (!room) return;
    const next = { ...prefs.roomSecurity, [room]: { ...security, ...patch } };
    setPrefs({ roomSecurity: next });
  }

  function setTtl(patch: Partial<typeof ttl>) {
    if (!room) return;
    const next = { ...prefs.roomTtl, [room]: { ...ttl, ...patch } };
    setPrefs({ roomTtl: next });
  }

  return (
    <Modal open={open} onClose={onClose} title={t(lang, "room.security.title")}>
      {!room ? (
        <p className="text-sm text-muted-foreground">
          {lang === "cs" ? "Připoj se nejprve do místnosti." : lang === "de" ? "Bitte zuerst einem Raum beitreten." : "Join a room first."}
        </p>
      ) : (
        <>
          <Section title={t(lang, "room.security.title")} icon={<PuzzleIcon className="h-4 w-4" />}>
            <Row label={t(lang, "room.sort")}>
              <select
                className={selectClass}
                value={security.sort}
                onChange={(event) => setSecurity({ sort: event.target.value as RoomSecurity["sort"] })}
              >
                <option value="asc">{t(lang, "room.sort.asc")}</option>
                <option value="desc">{t(lang, "room.sort.desc")}</option>
              </select>
            </Row>
            <label className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm">
              <span>{t(lang, "room.delivery")}</span>
              <input
                type="checkbox"
                checked={security.deliveryReceipts}
                onChange={(event) => setSecurity({ deliveryReceipts: event.target.checked })}
              />
            </label>
            <label className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm">
              <span>{t(lang, "room.read")}</span>
              <input
                type="checkbox"
                checked={security.readReceipts}
                onChange={(event) => setSecurity({ readReceipts: event.target.checked })}
              />
            </label>
            <label className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm">
              <span>{t(lang, "room.typing")}</span>
              <input
                type="checkbox"
                checked={security.typingIndicator}
                onChange={(event) => setSecurity({ typingIndicator: event.target.checked })}
              />
            </label>
          </Section>
          <Section title={t(lang, "ttl.title")} icon={<AlertTriangle className="h-4 w-4" />}>
            <Row label={t(lang, "ttl.room.override")} hint={t(lang, "ttl.unit.minutes")}>
              <input
                type="number"
                min={0}
                max={60 * 24 * 30}
                value={ttl.defaultMinutes}
                onChange={(event) => setTtl({ defaultMinutes: Math.max(0, Number(event.target.value) || 0) })}
                className={inputClass}
                data-testid="input-room-ttl-default"
              />
            </Row>
            <Row label={t(lang, "ttl.room.absolute")} hint={t(lang, "ttl.unit.minutes")}>
              <input
                type="number"
                min={0}
                max={60 * 24 * 30}
                value={ttl.absoluteMinutes}
                onChange={(event) => setTtl({ absoluteMinutes: Math.max(0, Number(event.target.value) || 0) })}
                className={inputClass}
                data-testid="input-room-ttl-absolute"
              />
            </Row>
          </Section>
        </>
      )}
    </Modal>
  );
}
