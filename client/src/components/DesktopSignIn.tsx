// /desktop-signin (6.13): the browser half of M5cet Desktop's passkey
// sign-in (lib/desktop-auth.ts). The app opened this page in the system
// browser; it shows the app's verification code, runs the passkey ceremony
// here — where the user's passkeys live — and sends the session and the
// account root back to the app ENCRYPTED to the app's key. This tab keeps
// nothing: it never adopts the session.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { pickLocale, type Locale } from "@/lib/locales";
import {
  appCallbackUrl, browserPasskeySignIn, completeHandoff, fetchHandoffInfo, parseHandoffUrl, verificationCode,
  type HandoffInfo,
} from "@/lib/desktop-auth";
import { PrfUnsupportedError } from "@/lib/passkey";

type Key =
  | "title" | "intro" | "code" | "warn" | "network" | "go" | "cancel" | "working" | "done" | "openApp"
  | "cancelled" | "expired" | "invalid" | "failed" | "noPrf" | "unknown";

const T: Record<Key, Record<Locale, string>> = {
  title: { en: "Sign in to M5cet Desktop", cs: "Přihlášení do M5cet Desktop", de: "Bei M5cet Desktop anmelden", es: "Iniciar sesión en M5cet Desktop", it: "Accedi a M5cet Desktop", fr: "Connexion à M5cet Desktop", sk: "Prihlásenie do M5cet Desktop", sl: "Prijava v M5cet Desktop", fi: "Kirjaudu M5cet Desktopiin" },
  intro: {
    en: "M5cet Desktop on your computer asks to sign in with your passkey.",
    cs: "M5cet Desktop ve vašem počítači žádá o přihlášení vaším passkey.",
    de: "M5cet Desktop auf Ihrem Computer möchte Sie mit Ihrem Passkey anmelden.",
    es: "M5cet Desktop en tu ordenador pide iniciar sesión con tu llave de acceso.",
    it: "M5cet Desktop sul tuo computer chiede di accedere con la tua passkey.",
    fr: "M5cet Desktop sur votre ordinateur demande à se connecter avec votre clé d’accès.",
    sk: "M5cet Desktop vo vašom počítači žiada o prihlásenie vaším prístupovým kľúčom.",
    sl: "M5cet Desktop v vašem računalniku prosi za prijavo s ključem za dostop.",
    fi: "Tietokoneesi M5cet Desktop pyytää kirjautumista pääsyavaimellasi.",
  },
  code: {
    en: "The app shows this code — check that it is the same:",
    cs: "Aplikace ukazuje tento kód — zkontrolujte, že je stejný:",
    de: "Die App zeigt diesen Code — prüfen Sie, dass er gleich ist:",
    es: "La app muestra este código; comprueba que es el mismo:",
    it: "L’app mostra questo codice: verifica che sia lo stesso:",
    fr: "L’app affiche ce code — vérifiez qu’il est identique :",
    sk: "Aplikácia ukazuje tento kód — skontrolujte, že je rovnaký:",
    sl: "Aplikacija prikazuje to kodo — preverite, da je enaka:",
    fi: "Sovellus näyttää tämän koodin – tarkista, että se on sama:",
  },
  warn: {
    en: "Continue only if you started this sign-in in M5cet Desktop on this computer just now.",
    cs: "Pokračujte, jen pokud jste toto přihlášení právě spustili v M5cet Desktop na tomto počítači.",
    de: "Fahren Sie nur fort, wenn Sie diese Anmeldung gerade in M5cet Desktop auf diesem Computer gestartet haben.",
    es: "Continúa solo si acabas de iniciar este inicio de sesión en M5cet Desktop en este ordenador.",
    it: "Continua solo se hai appena avviato questo accesso in M5cet Desktop su questo computer.",
    fr: "Ne continuez que si vous venez de lancer cette connexion dans M5cet Desktop sur cet ordinateur.",
    sk: "Pokračujte, len ak ste toto prihlásenie práve spustili v M5cet Desktop na tomto počítači.",
    sl: "Nadaljujte le, če ste to prijavo pravkar začeli v M5cet Desktop na tem računalniku.",
    fi: "Jatka vain, jos aloitit tämän kirjautumisen juuri M5cet Desktopissa tällä tietokoneella.",
  },
  network: {
    en: "This request came from another network than this browser. If you did not start it, cancel.",
    cs: "Žádost přišla z jiné sítě než tento prohlížeč. Pokud jste ji nespustili, zrušte ji.",
    de: "Diese Anfrage kam aus einem anderen Netz als dieser Browser. Wenn Sie sie nicht gestartet haben, brechen Sie ab.",
    es: "Esta solicitud llegó desde otra red distinta a la de este navegador. Si no la iniciaste tú, cancela.",
    it: "Questa richiesta proviene da una rete diversa da quella del browser. Se non l’hai avviata tu, annulla.",
    fr: "Cette demande vient d’un autre réseau que ce navigateur. Si vous ne l’avez pas lancée, annulez.",
    sk: "Žiadosť prišla z inej siete než tento prehliadač. Ak ste ju nespustili, zrušte ju.",
    sl: "Zahteva je prišla iz drugega omrežja kot ta brskalnik. Če je niste začeli vi, prekličite.",
    fi: "Pyyntö tuli eri verkosta kuin tämä selain. Jos et aloittanut sitä, peruuta.",
  },
  go: { en: "Sign in with passkey", cs: "Přihlásit se passkey", de: "Mit Passkey anmelden", es: "Iniciar sesión con llave de acceso", it: "Accedi con passkey", fr: "Se connecter avec une clé d’accès", sk: "Prihlásiť sa prístupovým kľúčom", sl: "Prijava s ključem za dostop", fi: "Kirjaudu pääsyavaimella" },
  cancel: { en: "Cancel", cs: "Zrušit", de: "Abbrechen", es: "Cancelar", it: "Annulla", fr: "Annuler", sk: "Zrušiť", sl: "Prekliči", fi: "Peruuta" },
  working: { en: "Waiting for your passkey…", cs: "Čekám na váš passkey…", de: "Warte auf Ihren Passkey …", es: "Esperando tu llave de acceso…", it: "In attesa della tua passkey…", fr: "En attente de votre clé d’accès…", sk: "Čakám na váš prístupový kľúč…", sl: "Čakam na vaš ključ za dostop …", fi: "Odotetaan pääsyavaintasi…" },
  done: {
    en: "Done. Return to M5cet Desktop — you can close this page.",
    cs: "Hotovo. Vraťte se do M5cet Desktop — tuto stránku můžete zavřít.",
    de: "Fertig. Kehren Sie zu M5cet Desktop zurück — Sie können diese Seite schließen.",
    es: "Listo. Vuelve a M5cet Desktop; puedes cerrar esta página.",
    it: "Fatto. Torna a M5cet Desktop: puoi chiudere questa pagina.",
    fr: "Terminé. Revenez à M5cet Desktop — vous pouvez fermer cette page.",
    sk: "Hotovo. Vráťte sa do M5cet Desktop — túto stránku môžete zavrieť.",
    sl: "Končano. Vrnite se v M5cet Desktop — to stran lahko zaprete.",
    fi: "Valmis. Palaa M5cet Desktopiin – voit sulkea tämän sivun.",
  },
  openApp: { en: "Open M5cet Desktop", cs: "Otevřít M5cet Desktop", de: "M5cet Desktop öffnen", es: "Abrir M5cet Desktop", it: "Apri M5cet Desktop", fr: "Ouvrir M5cet Desktop", sk: "Otvoriť M5cet Desktop", sl: "Odpri M5cet Desktop", fi: "Avaa M5cet Desktop" },
  cancelled: { en: "Cancelled. You can close this page.", cs: "Zrušeno. Tuto stránku můžete zavřít.", de: "Abgebrochen. Sie können diese Seite schließen.", es: "Cancelado. Puedes cerrar esta página.", it: "Annullato. Puoi chiudere questa pagina.", fr: "Annulé. Vous pouvez fermer cette page.", sk: "Zrušené. Túto stránku môžete zavrieť.", sl: "Preklicano. To stran lahko zaprete.", fi: "Peruutettu. Voit sulkea tämän sivun." },
  expired: {
    en: "This sign-in request has expired or was already used. Start it again in the app.",
    cs: "Tato žádost o přihlášení vypršela nebo už byla použita. Spusťte ji v aplikaci znovu.",
    de: "Diese Anmeldeanfrage ist abgelaufen oder wurde schon verwendet. Starten Sie sie in der App erneut.",
    es: "Esta solicitud de inicio de sesión ha caducado o ya se usó. Vuelve a iniciarla en la app.",
    it: "Questa richiesta di accesso è scaduta o è già stata usata. Riavviala nell’app.",
    fr: "Cette demande de connexion a expiré ou a déjà été utilisée. Relancez-la dans l’app.",
    sk: "Táto žiadosť o prihlásenie vypršala alebo už bola použitá. Spustite ju v aplikácii znova.",
    sl: "Ta zahteva za prijavo je potekla ali je bila že uporabljena. Znova jo začnite v aplikaciji.",
    fi: "Tämä kirjautumispyyntö on vanhentunut tai jo käytetty. Aloita se uudelleen sovelluksessa.",
  },
  invalid: { en: "This link is not valid.", cs: "Tento odkaz není platný.", de: "Dieser Link ist ungültig.", es: "Este enlace no es válido.", it: "Questo link non è valido.", fr: "Ce lien n’est pas valide.", sk: "Tento odkaz nie je platný.", sl: "Ta povezava ni veljavna.", fi: "Tämä linkki ei ole kelvollinen." },
  failed: { en: "Sign-in failed: {error}", cs: "Přihlášení selhalo: {error}", de: "Anmeldung fehlgeschlagen: {error}", es: "Error al iniciar sesión: {error}", it: "Accesso non riuscito: {error}", fr: "Échec de la connexion : {error}", sk: "Prihlásenie zlyhalo: {error}", sl: "Prijava ni uspela: {error}", fi: "Kirjautuminen epäonnistui: {error}" },
  noPrf: {
    en: "This passkey cannot produce an encryption key (PRF). Use a passkey from your password manager, iCloud Keychain or Google Password Manager, or a security key with PRF.",
    cs: "Tento passkey neumí vytvořit šifrovací klíč (PRF). Použijte passkey ze správce hesel, Klíčenky na iCloudu nebo Správce hesel Google, případně bezpečnostní klíč s PRF.",
    de: "Dieser Passkey kann keinen Schlüssel erzeugen (PRF). Verwenden Sie einen Passkey aus Ihrem Passwortmanager, dem iCloud-Schlüsselbund oder dem Google Passwortmanager oder einen Sicherheitsschlüssel mit PRF.",
    es: "Esta llave de acceso no puede generar una clave de cifrado (PRF). Usa una llave de tu gestor de contraseñas, del Llavero de iCloud o del Gestor de contraseñas de Google, o una llave de seguridad con PRF.",
    it: "Questa passkey non può generare una chiave di crittografia (PRF). Usa una passkey del gestore di password, del Portachiavi iCloud o di Gestore delle password di Google, oppure una chiave di sicurezza con PRF.",
    fr: "Cette clé d’accès ne peut pas produire de clé de chiffrement (PRF). Utilisez une clé de votre gestionnaire de mots de passe, du trousseau iCloud ou du Gestionnaire de mots de passe de Google, ou une clé de sécurité avec PRF.",
    sk: "Tento prístupový kľúč nevie vytvoriť šifrovací kľúč (PRF). Použite kľúč zo správcu hesiel, z Kľúčenky iCloud alebo zo Správcu hesiel Google, prípadne bezpečnostný kľúč s PRF.",
    sl: "Ta ključ za dostop ne more ustvariti šifrirnega ključa (PRF). Uporabite ključ iz upravitelja gesel, obeska za ključe iCloud ali Googlovega upravitelja gesel ali varnostni ključ s PRF.",
    fi: "Tämä pääsyavain ei voi luoda salausavainta (PRF). Käytä salasanojen hallinnan, iCloud-avainnipun tai Googlen salasanojen ylläpitäjän pääsyavainta tai PRF:ää tukevaa suojausavainta.",
  },
  unknown: {
    en: "This passkey is not registered on this server.",
    cs: "Tento passkey není na tomto serveru registrovaný.",
    de: "Dieser Passkey ist auf diesem Server nicht registriert.",
    es: "Esta llave de acceso no está registrada en este servidor.",
    it: "Questa passkey non è registrata su questo server.",
    fr: "Cette clé d’accès n’est pas enregistrée sur ce serveur.",
    sk: "Tento prístupový kľúč nie je na tomto serveri registrovaný.",
    sl: "Ta ključ za dostop na tem strežniku ni registriran.",
    fi: "Tätä pääsyavainta ei ole rekisteröity tälle palvelimelle.",
  },
};

type Phase = "loading" | "ready" | "working" | "done" | "cancelled" | "expired" | "invalid" | "error";

export default function DesktopSignIn() {
  const lang = useMemo<Locale>(() => pickLocale(typeof navigator !== "undefined" ? navigator.languages : [], "en"), []);
  const tr = (k: Key, vars: Record<string, string> = {}) => T[k][lang].replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m);
  const parsed = useMemo(() => parseHandoffUrl(window.location.href), []);
  const [phase, setPhase] = useState<Phase>(parsed ? "loading" : "invalid");
  const [info, setInfo] = useState<HandoffInfo | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("lang", lang);
    document.title = `M5cet · ${T.title[lang]}`;
    if (!parsed) return;
    let gone = false;
    void (async () => {
      const [i, c] = await Promise.all([fetchHandoffInfo(parsed.id), verificationCode(parsed.appKey)]);
      if (gone) return;
      setCode(c);
      // The key in the link (from the app, never seen by a server) must be the one the request was made with.
      if (!i || i.state !== "waiting") { setPhase("expired"); return; }
      if (i.appKey !== parsed.appKey) { setPhase("invalid"); return; }
      setInfo(i);
      setPhase("ready");
    })();
    return () => { gone = true; };
  }, [parsed, lang]);

  async function go() {
    if (!parsed || !info) return;
    setPhase("working");
    setError("");
    try {
      const payload = await browserPasskeySignIn(window.location.origin);
      const ok = await completeHandoff(parsed.id, parsed.appKey, window.location.origin, payload);
      if (!ok) { setPhase("expired"); return; }
      setPhase("done");
      // Wake the app (the link carries only the id; the app collects the encrypted result itself).
      window.location.href = appCallbackUrl(parsed.id);
    } catch (err) {
      const e = err as { name?: string; status?: number; code?: string; message?: string };
      if (e?.name === "NotAllowedError" || e?.name === "AbortError") { setPhase("ready"); return; }
      setError(err instanceof PrfUnsupportedError ? tr("noPrf") : e?.status === 404 || e?.code === "unknown-passkey" ? tr("unknown") : tr("failed", { error: e?.message ?? String(err) }));
      setPhase("error");
    }
  }

  const box: CSSProperties = { maxWidth: 520, margin: "10vh auto", padding: "28px 28px 24px", borderRadius: 16, background: "var(--surface, rgba(127,127,127,.08))", color: "var(--text, inherit)", font: "15px/1.5 system-ui, sans-serif", boxShadow: "0 8px 40px rgba(0,0,0,.25)" };
  const button: CSSProperties = { padding: "10px 18px", borderRadius: 10, border: 0, font: "inherit", fontWeight: 600, cursor: "pointer" };
  return (
    <main style={{ minHeight: "100vh", padding: 16 }}>
      <section style={box} aria-live="polite">
        <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>{tr("title")}</h1>
        {phase === "invalid" && <p>{tr("invalid")}</p>}
        {phase === "expired" && <p>{tr("expired")}</p>}
        {phase === "cancelled" && <p>{tr("cancelled")}</p>}
        {(phase === "loading" || phase === "ready" || phase === "working" || phase === "error") && (
          <>
            <p>{tr("intro")}</p>
            <p style={{ margin: "16px 0 4px" }}>{tr("code")}</p>
            <p data-testid="desktop-code" style={{ fontSize: 30, letterSpacing: 4, fontWeight: 700, fontVariantNumeric: "tabular-nums", margin: "0 0 16px" }}>{code || "…"}</p>
            <p style={{ opacity: 0.85 }}>{tr("warn")}</p>
            {info && !info.sameNetwork && <p role="alert" style={{ color: "#d97706", fontWeight: 600 }}>{tr("network")}</p>}
            {phase === "error" && <p role="alert" style={{ color: "#dc2626" }}>{error}</p>}
            <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
              <button type="button" style={{ ...button, background: "var(--accent, #2563eb)", color: "#fff" }} disabled={phase !== "ready" && phase !== "error"} onClick={() => void go()}>
                {phase === "working" ? tr("working") : tr("go")}
              </button>
              <button type="button" style={{ ...button, background: "transparent", color: "inherit", border: "1px solid currentColor" }} disabled={phase === "working"} onClick={() => setPhase("cancelled")}>
                {tr("cancel")}
              </button>
            </div>
          </>
        )}
        {phase === "done" && parsed && (
          <>
            <p>{tr("done")}</p>
            <a href={appCallbackUrl(parsed.id)} style={{ ...button, display: "inline-block", background: "var(--accent, #2563eb)", color: "#fff", textDecoration: "none" }}>{tr("openApp")}</a>
          </>
        )}
      </section>
    </main>
  );
}
