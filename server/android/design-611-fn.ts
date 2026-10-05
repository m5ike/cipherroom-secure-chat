// 6.11 design area: a model's answer as an incoming message from
// "system-messenger" (the model's name and icon), as a reply to the command;
// a run that hangs fails after 30 s with an error chip; a wrong call says what
// the model expects; the command suggester's look.
// One area of the 6.11 design (design-611.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
// The behaviour is the app's own (client/src/lib/system-messenger.ts is the
// contract; Android: fn/ModelIdentity, fn/CommandCheck, fn/RunWatch,
// fn/Suggestions + fn/Fuzzy + fn/ArgHint, ui/bubble/ModelFace):
//   - a model's answer is an INCOMING message: the model's name as the
//     sender, its icon (a lucide name or one emoji) in a circle of its colour
//     as the avatar, the command it answers as the quote on top (a tap goes
//     there); a caller-only answer says "only you see it", a room answer
//     "via <who sent it>" — a member's app sends it, the model's identity
//     travels in the message's fn flags (keyword, name, icon);
//   - the answer's bubble fits its content (wider for tables, code and forms);
//   - a run without a sign of life for 30 s (an open question pauses the
//     clock) ends with an error chip on the command and a flash; every run
//     ends exactly once (a newer one cancels it);
//   - a call that cannot run as typed (a required parameter missing, a wrong
//     type, range, value or format) is not sent: the answer is an error card
//     — what is wrong, the usage line, the parameters, the model's guide;
//   - the suggester: the used commands first, loose matching with the matches
//     highlighted, sections, each command with its icon, name, summary,
//     arguments and who sees the answer; a hint bar while the arguments are
//     typed.
//
// What the trees get:
//   message.in     the face: the model's icon circle instead of the monogram
//                  when $msg.model; the name in the model's colour and under
//                  it the model's line ("/mail · via Alice")
//   message.model  (new sheet) the model behind an answer — a tap on its
//                  avatar: icon, name, keyword, summary, usage line, the
//                  parameters (required or not, what each expects, help),
//                  the model's guide, who it came through; "Write the
//                  command" (compose "write:/keyword") puts "/keyword " into
//                  the message box — only a command's start, never other text

import type { ANode, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

/** The avatar's size in a received message's row (dp) — 6.10's. */
export const FACE = 36;

/* ================================================================ helpers */

function find(node: ANode, id: string): ANode | null {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

function parentOf(node: ANode, id: string): ANode | null {
  for (const c of node.children ?? []) {
    if (c.id === id) return node;
    const hit = parentOf(c, id);
    if (hit) return hit;
  }
  return null;
}

/** Adds a condition to a node's own (both must hold). */
function andIf(node: ANode, cond: string): void {
  node.if = node.if ? `(${node.if}) && ${cond}` : cond;
}

/* ============================================================ the bubbles */

const M = "$msg.model";

/** The model's avatar: its icon (or emoji) in a circle of its colour. */
export const modelFaceNode = (): ANode =>
  n("model-face", "column", { if: M, style: { width: FACE, height: FACE, radius: FACE / 2, bg: `=${M}.color`, align: "center", justify: "center" } }, [
    n("model-icon", "icon", { if: `!${M}.emoji`, props: { icon: `=${M}.glyph`, size: 20, color: "#ffffff" } }),
    n("model-emoji", "text", { if: `${M}.emoji`, text: `{${M}.icon}`, props: { align: "center" }, style: { size: 18 } }),
  ]);

/** Under the model's name: "/mail · only you see it", "/mail · via Alice". */
export const modelLineNode = (): ANode =>
  n("model-line", "text", { if: M, text: `{${M}.line}`, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } });

/**
 * message.in: the model's face instead of the monogram / photo, the model's
 * line under the name. A tree without a "face" (an operator's own) keeps its
 * look — the app still names the model as the sender. Patching twice changes
 * nothing.
 */
export function patchModelAnswers(screens: Record<string, ANode>): void {
  const tree = screens["message.in"];
  if (!tree) return;
  const face = find(tree, "face");
  if (face && !find(face, "model-face")) {
    for (const id of ["avatar", "photo"]) { const x = find(face, id); if (x) andIf(x, `!${M}`); }
    face.children = [...(face.children ?? []), modelFaceNode()];
  }
  const sender = find(tree, "sender");
  const p = sender ? parentOf(tree, "sender") : null;
  if (sender && p?.children && !find(tree, "model-line")) {
    // The model's name in its colour (a person's stays the primary colour).
    if (sender.style?.fg === "@primary") sender.style = { ...sender.style, fg: `=${M} ? ${M}.color : '@primary'` };
    const i = p.children.findIndex((c) => c.id === "sender");
    p.children.splice(i + 1, 0, modelLineNode());
  }
}

/* ===================================================== the model's sheet */

const S = "$form.model";

const handle = (): ANode => n("handle", "row", { style: { justify: "center", padding: "0 0 6 0" } }, [n("grip", "spacer", { props: { size: 4 }, style: { width: 40, bg: "@border", radius: 2 } })]);

const label = (id: string, key: string, cond: string): ANode =>
  n(id, "text", { if: cond, text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@muted", padding: "8 8 2 8" } });

export const modelSheet: ANode = n("root", "column", { style: { bg: "@surface", radius: 24, padding: "10 12 12 12", gap: 4 }, anim: { enter: { type: "slide-up", ms: 220, easing: "decelerate" } } }, [
  handle(),
  n("scroll", "scroll", {}, [
    n("body", "column", { style: { gap: 2, padding: "0 0 8 0" } }, [
      n("head", "row", { style: { gap: 14, align: "center", padding: "2 8 8 8" } }, [
        n("face", "column", { style: { width: 64, height: 64, radius: 32, bg: `=${S}.color`, align: "center", justify: "center" } }, [
          n("face-icon", "icon", { if: `!${S}.emoji`, props: { icon: `=${S}.glyph`, size: 32, color: "#ffffff" } }),
          n("face-emoji", "text", { if: `${S}.emoji`, text: `{${S}.icon}`, props: { align: "center" }, style: { size: 30 } }),
        ]),
        n("who", "column", { style: { weight: 1, gap: 2 } }, [
          n("title", "text", { text: `{${S}.name}`, props: { variant: "title" }, style: { bold: true, lines: 2 } }),
          n("keyword", "text", { text: `/{${S}.keyword}`, props: { variant: "mono" }, style: { fg: "@primary" } }),
          n("line", "text", { if: `${S}.line`, text: `{${S}.line}`, props: { variant: "caption" }, style: { fg: "@muted", lines: 2 } }),
        ]),
      ]),
      n("summary", "text", { if: `${S}.summary`, text: `{${S}.summary}`, props: { links: true }, style: { padding: "0 8 4 8" } }),
      n("visibility", "row", { if: `${S}.visibility`, style: { gap: 8, align: "center", padding: "2 8" } }, [
        n("visibility-icon", "icon", { props: { icon: `=${S}.visibility == 'room' ? 'users' : 'lock'`, size: 16, color: "@muted" } }),
        n("visibility-text", "text", { text: `{=${S}.visibility == 'room' ? _('fnm.card.room') : _('fnm.card.caller')}`, props: { variant: "caption" }, style: { weight: 1, fg: "@muted" } }),
      ]),
      label("usage-label", "fnm.usage", `${S}.usage`),
      n("usage", "text", { if: `${S}.usage`, text: `{${S}.usage}`, props: { variant: "mono" }, style: { bg: "@surfaceVariant", radius: 10, padding: "8 10", margin: "0 8 2 8" } }),
      label("inputs-label", "fnm.inputs", `${S}.hasInputs`),
      n("input", "row", { each: `${S}.inputs`, as: "mi", style: { gap: 10, align: "start", padding: "5 8" } }, [
        n("input-mark", "icon", { props: { icon: "=$mi.required ? 'circle-alert' : 'circle-dashed'", size: 16, color: "=$mi.required ? '@primary' : '@muted'" } }),
        n("input-col", "column", { style: { weight: 1, gap: 1 } }, [
          n("input-name", "text", { text: "{$mi.name}{=$mi.label ? ' · ' + $mi.label : ''}", style: { bold: true } }),
          n("input-expect", "text", { text: "{=$mi.required ? _('fnm.required') : _('fnm.optional')} · {$mi.expect}", props: { variant: "caption" }, style: { fg: "@muted" } }),
          n("input-help", "text", { if: "$mi.help", text: "{$mi.help}", props: { variant: "caption" } }),
        ]),
      ]),
      label("guide-label", "fnm.guide", `${S}.guide`),
      n("guide", "text", { if: `${S}.guide`, text: `{${S}.guide}`, props: { links: true }, style: { padding: "0 8 4 8" } }),
      n("unknown", "row", { if: `!${S}.known`, style: { gap: 10, align: "center", padding: "6 8" } }, [
        n("unknown-icon", "icon", { props: { icon: "info", size: 18, color: "@muted" } }),
        n("unknown-text", "text", { text: "{_'fnm.card.unknown'}", style: { weight: 1, fg: "@muted" } }),
      ]),
      n("note", "row", { style: { gap: 8, align: "start", padding: "8 8 2 8" } }, [
        n("note-icon", "icon", { props: { icon: "shield-check", size: 14, color: "@muted" } }),
        n("note-text", "text", { text: `{=${S}.local ? _('fnm.card.local') : _('fnm.card.honest')}`, props: { variant: "caption" }, style: { weight: 1, fg: "@muted" } }),
      ]),
      n("actions", "row", { style: { gap: 8, padding: "10 4 0 4" } }, [
        n("write", "button", { if: `${S}.known`, text: "{_'fnm.card.write'}", props: { icon: "square-terminal", variant: "tonal" }, style: { weight: 1 }, on: click("compose", `write:{${S}.write}`) }),
        n("sender", "button", { if: `${S}.senderId`, text: "{_'sender.profile'}", props: { icon: "user", variant: "text" }, style: { weight: 1 }, on: click("people.open", `{${S}.senderId}`) }),
      ]),
    ]),
  ]),
]);

const SAMPLE_MODEL = {
  keyword: "hlr", name: "Číslo a síť", icon: "phone", glyph: "phone", emoji: false, color: "#7bb234",
  line: "/hlr · přes Alice", summary: "Ověří telefonní číslo: země, operátor, dosažitelnost.", visibility: "room",
  usage: "/hlr <number> [format]", hasInputs: true, known: true, local: false, write: "/hlr ", senderId: "peer-1",
  inputs: [
    { name: "number", label: "Číslo", required: true, expect: "telefonní číslo v mezinárodním tvaru (+420…)", help: "Například +420 777 123 456" },
    { name: "format", label: "", required: false, expect: "jedna z: short, long", help: "" },
  ],
  guide: "/hlr +420777123456\n/hlr +420777123456 long",
};

const SCREENS: ScreenDef[] = [
  { id: "message.model", label: "Message › the model behind an answer", group: "parts", vars: ["$form.model"], sample: { form: { model: SAMPLE_MODEL } }, help: "A tap on a model answer's avatar: the model (icon, name, keyword, summary), its usage line, parameters and guide, who it came through; write the command." },
];

/* ================================================================ strings */

const T = (cs: string, en: string, de: string) => ({ cs, en, de });
const STR: Record<string, { cs: string; en: string; de: string }> = {
  // the answer
  "fnm.onlyYou": T("vidíte jen vy", "only you see it", "nur Sie sehen das"),
  "fnm.viaYou": T("poslali jste do místnosti", "sent to the room by you", "von Ihnen an den Raum gesendet"),
  "fnm.via": T("přes {name}", "via {name}", "über {name}"),
  "fnm.about": T("O modelu", "About the model", "Über das Modell"),
  // the command's bubble
  "fnm.answered": T("Odpověď je níže", "Answered below", "Antwort unten"),
  "fnm.cancelled": T("Zrušeno — spustili jste další příkaz", "Cancelled — a newer command replaced it", "Abgebrochen — ein neuerer Befehl hat ihn ersetzt"),
  "fnm.timeout": T("Model neodpověděl do {s} s", "The model did not answer within {s} s", "Das Modell hat nicht innerhalb von {s} s geantwortet"),
  "fnm.failed": T("Chyba při provádění funkce modelu /{keyword}", "Error while running the model's function /{keyword}", "Fehler beim Ausführen der Modellfunktion /{keyword}"),
  "fnm.interrupted": T("Přerušeno — aplikace se mezitím zavřela", "Interrupted — the app was closed meanwhile", "Unterbrochen — die App wurde inzwischen geschlossen"),
  "fnm.badCall": T("Chybné parametry", "Wrong parameters", "Falsche Parameter"),
  // the error card
  "fnm.error.title": T("Příkaz /{keyword} takhle spustit nejde", "/{keyword} cannot run like this", "/{keyword} kann so nicht ausgeführt werden"),
  "fnm.error.server": T("Server příkaz odmítl: {message}", "The server refused the call: {message}", "Der Server hat den Aufruf abgelehnt: {message}"),
  "fnm.error.expects": T("očekává se {expected}", "expects {expected}", "erwartet wird {expected}"),
  "fnm.problem.missing": T("chybí", "missing", "fehlt"),
  "fnm.problem.type": T("špatný typ", "wrong type", "falscher Typ"),
  "fnm.problem.pattern": T("špatný tvar", "wrong format", "falsches Format"),
  "fnm.problem.range": T("mimo rozsah", "out of range", "außerhalb des Bereichs"),
  "fnm.problem.values": T("není mezi povolenými hodnotami", "not one of the allowed values", "kein erlaubter Wert"),
  "fnm.expect.values": T("jedna z hodnot: {values}", "one of: {values}", "einer von: {values}"),
  "fnm.expect.number": T("číslo", "a number", "eine Zahl"),
  "fnm.expect.integer": T("celé číslo", "a whole number", "eine ganze Zahl"),
  "fnm.expect.phone": T("telefonní číslo v mezinárodním tvaru (+420…)", "a phone number in international form (+420…)", "eine Telefonnummer im internationalen Format (+49…)"),
  "fnm.expect.boolean": T("ano / ne (true / false)", "true / false", "ja / nein (true / false)"),
  "fnm.expect.pattern": T("text ve tvaru {pattern}", "text matching {pattern}", "Text im Format {pattern}"),
  "fnm.expect.email": T("e-mailová adresa", "an e-mail address", "eine E-Mail-Adresse"),
  "fnm.expect.type": T("hodnota typu {type}", "a {type}", "ein Wert vom Typ {type}"),
  "fnm.expect.value": T("hodnota", "a value", "ein Wert"),
  "fnm.usage": T("Použití", "Usage", "Verwendung"),
  "fnm.inputs": T("Parametry", "Parameters", "Parameter"),
  "fnm.guide": T("Návod modelu", "The model's guide", "Anleitung des Modells"),
  "fnm.col.name": T("Parametr", "Parameter", "Parameter"),
  "fnm.col.expect": T("Očekává", "Expects", "Erwartet"),
  "fnm.col.help": T("Popis", "Description", "Beschreibung"),
  "fnm.required": T("povinný", "required", "Pflicht"),
  "fnm.optional": T("nepovinný", "optional", "optional"),
  "fnm.default": T("výchozí {value}", "default {value}", "Standard {value}"),
  // the model's sheet
  "fnm.card.room": T("Odpověď uvidí celá místnost", "The whole room sees the answer", "Der ganze Raum sieht die Antwort"),
  "fnm.card.caller": T("Odpověď uvidí jen ten, kdo příkaz spustil", "Only whoever ran it sees the answer", "Nur wer den Befehl ausführt, sieht die Antwort"),
  "fnm.card.unknown": T("Tento model teď nemáte k dispozici.", "This model is not available to you now.", "Dieses Modell steht Ihnen gerade nicht zur Verfügung."),
  "fnm.card.local": T(
    "Odpovědi modelů jsou zprávy aplikace (system-messenger) — vidíte je jen na tomto zařízení.",
    "Model answers are the app's own messages (system-messenger) — only on this device.",
    "Antworten von Modellen sind Nachrichten der App (system-messenger) — nur auf diesem Gerät.",
  ),
  "fnm.card.honest": T(
    "Odpověď modelu do místnosti posílá aplikace toho, kdo příkaz spustil — šifrovaně end-to-end a pod jeho podpisem.",
    "A model's answer to the room is sent by the app of whoever ran the command — end-to-end encrypted and signed by them.",
    "Die Antwort eines Modells an den Raum sendet die App der Person, die den Befehl ausgeführt hat — Ende-zu-Ende-verschlüsselt und von ihr signiert.",
  ),
  "fnm.card.write": T("Napsat příkaz", "Write the command", "Befehl schreiben"),
  // the suggester
  "fnm.sec.recent": T("Naposledy použité", "Recently used", "Zuletzt verwendet"),
  "fnm.sec.commands": T("Příkazy", "Commands", "Befehle"),
  "fnm.sec.others": T("Další shody", "Other matches", "Weitere Treffer"),
  "fnm.sec.people": T("Lidé", "People", "Personen"),
  "fnm.sec.tags": T("Štítky", "Tags", "Tags"),
  "fnm.vis.room": T("místnost", "room", "Raum"),
  "fnm.vis.caller": T("jen vy", "only you", "nur Sie"),
  "fnm.none": T("Žádný příkaz neodpovídá", "No command matches", "Kein Befehl passt"),
  "fnm.pick": T("Vložit {label}", "Insert {label}", "{label} einfügen"),
  "fnm.hint.done": T("Vše zadáno — můžete odeslat", "All set — send it", "Alles eingegeben — jetzt senden"),
  "fnm.hint.value": T("Vložit hodnotu {value}", "Insert the value {value}", "Den Wert {value} einfügen"),
  // a model's question (form)
  "fnm.ask.required": T("Vyplňte povinná pole", "Fill in the required fields", "Füllen Sie die Pflichtfelder aus"),
};

export const AREA: DesignArea = {
  // No new element or action: the trees here use 6.10's (compose takes "write:/keyword" in a 6.11 app,
  // and only a 6.11 app opens message.model or fills $msg.model) — the default design still runs on app 61000.
  screens: SCREENS,
  trees: { "message.model": modelSheet },
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
  patch(screens) {
    patchModelAnswers(screens);
  },
};
