// Starter TSAs (6.9): what "New TSA › from a template" draws — four common
// call flows, in Czech (the Start's language is cs-CZ; change the texts and
// the language for other callers). Each is a plain graph; what the operator
// must decide (the number a Dial calls, the room a message goes to) is left
// empty, so the editor marks it and publishing waits until it is filled in.
//
//   ivr-menu        greeting, one digit, 1 / 2 / 3 → a message or the operator
//                   (Dial), anything else → the menu again, silence → asked
//                   twice more, then goodbye
//   route-code      a 6-digit route code (Read DTMF) → Route audio by KEY;
//                   three attempts (While + Set), then goodbye
//   voicemail       a greeting, Record with transcription, the transcript as a
//                   message into a room
//   opening-hours   Opening hours → the menu (1 = the operator) or a "closed"
//                   message and busy

import { defaultParams } from "./catalog";
import type { TsaEdge, TsaGraph, TsaNode, TsaNodeType } from "./types";

class Draw {
  readonly nodes: TsaNode[] = [];
  readonly edges: TsaEdge[] = [];
  private n = 0;

  /** A node at a grid cell (column, row) with its tool's defaults and these parameters. */
  node(id: string, type: TsaNodeType, col: number, row: number, params: Record<string, unknown> = {}, extra: Partial<Pick<TsaNode, "inputs" | "label" | "w" | "note">> = {}): string {
    this.nodes.push({ id, type, x: 60 + col * 280, y: 60 + row * 150, ...extra, params: { ...defaultParams(type), ...params } });
    return id;
  }
  flow(from: string, port: string, to: string): void {
    this.edges.push({ id: `e${++this.n}`, from: { node: from, port }, to: { node: to, port: "in" }, kind: "flow" });
  }
  data(from: string, port: string, to: string, toPort: string): void {
    this.edges.push({ id: `d${++this.n}`, from: { node: from, port }, to: { node: to, port: toPort }, kind: "data" });
  }
  graph(): TsaGraph { return { nodes: this.nodes, edges: this.edges }; }
}

const START = { answer: true, language: "cs-CZ", maxMinutes: 30 };

function ivrMenu(): TsaGraph {
  const d = new Draw();
  d.node("start", "start", 1, 0, START);
  d.node("greeting", "tts", 1, 1, { text: "Dobrý den. Pro obchodní oddělení stiskněte jedničku, pro technickou podporu dvojku, pro spojení s operátorem trojku.", bargeIn: true }, { inputs: 0 });
  d.node("menu", "read_dtmf", 1, 2, { maxDigits: 1, timeout: 6, retries: 2 });
  d.node("choice", "switch", 1, 3, { cases: ["1", "2", "3"], match: "equals" });
  d.node("sales", "tts", 0, 4, { text: "Obchodní oddělení. Naši nabídku najdete na webu, rádi vám také zavoláme zpět. Děkujeme za zavolání." }, { inputs: 0 });
  d.node("support", "tts", 1, 4, { text: "Technická podpora. Popište nám prosím problém e-mailem, ozveme se vám do jednoho pracovního dne. Na shledanou." }, { inputs: 0 });
  d.node("operator", "dial", 2, 4, { kind: "number", to: "", via: "rules", timeout: 30 }, { label: "Operator" });
  d.node("invalid", "tts", 3, 4, { text: "Tuto volbu neznám." }, { inputs: 0 });
  d.node("unavailable", "tts", 2, 5, { text: "Operátor je teď nedostupný. Zkuste to prosím později. Na shledanou." }, { inputs: 0 });
  d.node("silence", "tts", 0, 3, { text: "Nic jste nezvolili. Na shledanou." }, { inputs: 0 });
  d.node("end", "hangup", 1, 6);
  d.flow("start", "next", "greeting");
  d.flow("greeting", "next", "menu");
  d.flow("greeting", "on_failed", "menu");
  d.flow("menu", "next", "choice");
  d.flow("menu", "on_timeout", "silence");
  d.data("menu", "digits", "choice", "IN1");
  d.flow("choice", "case_1", "sales");
  d.flow("choice", "case_2", "support");
  d.flow("choice", "case_3", "operator");
  d.flow("choice", "default", "invalid");
  d.flow("invalid", "next", "greeting");
  d.flow("invalid", "on_failed", "greeting");
  d.flow("sales", "next", "end");
  d.flow("sales", "on_failed", "end");
  d.flow("support", "next", "end");
  d.flow("support", "on_failed", "end");
  d.flow("operator", "on_answered", "end");
  d.flow("operator", "on_busy", "unavailable");
  d.flow("operator", "on_no_answer", "unavailable");
  d.flow("operator", "on_failed", "unavailable");
  d.flow("unavailable", "next", "end");
  d.flow("unavailable", "on_failed", "end");
  d.flow("silence", "next", "end");
  d.flow("silence", "on_failed", "end");
  return d.graph();
}

function routeCode(): TsaGraph {
  const d = new Draw();
  d.node("start", "start", 1, 0, START);
  d.node("reset", "set", 1, 1, { name: "attempts", value: "0" }, { inputs: 0 });
  d.node("attempts", "while", 1, 2, { formula: "$attempts < 3", maxRounds: 3 }, { inputs: 0, label: "Three attempts" });
  d.node("ask", "read_dtmf", 0, 3, { maxDigits: 6, finishOnKey: "#", timeout: 10, prompt: "Zadejte prosím šestimístný kód a stiskněte mřížku." });
  d.node("route", "route_audio", 0, 4, { announce: "Spojuji.", mode: "fail" });
  d.node("wrong", "set", 1, 4, { name: "attempts", value: "$attempts + 1" }, { inputs: 0, label: "One more attempt" });
  d.node("wrong_msg", "tts", 1, 5, { text: "Tento kód neplatí." }, { inputs: 0 });
  d.node("bye", "tts", 0, 6, { text: "Hovor skončil. Na shledanou." }, { inputs: 0 });
  d.node("failed", "tts", 2, 5, { text: "Spojení se teď nepodařilo. Zkuste to prosím později." }, { inputs: 0 });
  d.node("too_many", "tts", 3, 3, { text: "Kód nebyl zadán správně. Na shledanou." }, { inputs: 0 });
  d.node("end", "hangup", 2, 7);
  d.flow("start", "next", "reset");
  d.flow("reset", "next", "attempts");
  d.flow("attempts", "body", "ask");
  d.flow("attempts", "done", "too_many");
  d.flow("ask", "next", "route");
  d.flow("ask", "on_timeout", "wrong");
  d.data("ask", "digits", "route", "KEY");
  d.flow("route", "on_success", "bye");
  d.flow("route", "on_code_error", "wrong");
  d.flow("route", "on_failed", "failed");
  d.flow("wrong", "next", "wrong_msg");
  d.flow("bye", "next", "end");
  d.flow("bye", "on_failed", "end");
  d.flow("failed", "next", "end");
  d.flow("failed", "on_failed", "end");
  d.flow("too_many", "next", "end");
  d.flow("too_many", "on_failed", "end");
  return d.graph();
}

function voicemail(): TsaGraph {
  const d = new Draw();
  d.node("start", "start", 1, 0, START);
  d.node("greeting", "tts", 1, 1, { text: "Dobrý den, teď vám nemůžeme odpovědět. Zanechte nám prosím vzkaz po zaznění tónu. Nahrávání ukončíte mřížkou." }, { inputs: 0 });
  d.node("message", "record", 1, 2, { maxSeconds: 120, finishOnKey: "#", silenceSeconds: 5, beep: true, trim: true, transcribe: true });
  d.node("post", "room_message", 1, 3, { target: "room", room: "", member: "", text: "📞 Vzkaz od {call.from} ({IN2} s): {IN1}" }, { inputs: 2, label: "Transcript to the room" });
  d.node("not_posted", "log", 2, 3, { level: "warn", text: "Vzkaz od {call.from} se nepodařilo doručit do místnosti (nahrávka {IN1})." }, { inputs: 1 });
  d.node("thanks", "tts", 1, 4, { text: "Děkujeme, váš vzkaz jsme předali. Na shledanou." }, { inputs: 0 });
  d.node("nothing", "tts", 0, 3, { text: "Nezanechali jste žádný vzkaz. Na shledanou." }, { inputs: 0 });
  d.node("sorry", "tts", 3, 3, { text: "Omlouváme se, nahrávání se nepodařilo. Na shledanou." }, { inputs: 0 });
  d.node("end", "hangup", 1, 5);
  d.flow("start", "next", "greeting");
  d.flow("greeting", "next", "message");
  d.flow("greeting", "on_failed", "message");
  d.flow("message", "next", "post");
  d.flow("message", "on_timeout", "nothing");
  d.flow("message", "on_failed", "sorry");
  d.data("message", "transcript", "post", "IN1");
  d.data("message", "duration", "post", "IN2");
  d.data("message", "url", "not_posted", "IN1");
  d.flow("post", "next", "thanks");
  d.flow("post", "on_failed", "not_posted");
  d.flow("not_posted", "next", "thanks");
  d.flow("thanks", "next", "end");
  d.flow("thanks", "on_failed", "end");
  d.flow("nothing", "next", "end");
  d.flow("nothing", "on_failed", "end");
  d.flow("sorry", "next", "end");
  d.flow("sorry", "on_failed", "end");
  return d.graph();
}

function openingHours(): TsaGraph {
  const d = new Draw();
  d.node("start", "start", 1, 0, START);
  d.node("hours", "time_condition", 1, 1, { timezone: "Europe/Prague", days: "mon-fri", from: "08:00", to: "17:00", closedOn: ["01-01", "12-24", "12-25", "12-26"] });
  d.node("menu", "tts", 0, 2, { text: "Dobrý den. Pro spojení s operátorem stiskněte jedničku.", bargeIn: true }, { inputs: 0 });
  d.node("pick", "read_dtmf", 0, 3, { maxDigits: 1, timeout: 6, retries: 1 });
  d.node("is_one", "condition", 0, 4, { formula: "IN1 == 1" }, { inputs: 1, w: 320 });
  d.node("operator", "dial", 0, 5, { kind: "number", to: "", via: "rules", timeout: 30 }, { label: "Operator" });
  d.node("busy_msg", "tts", 1, 6, { text: "Všichni operátoři jsou teď obsazeni. Zavolejte prosím později. Na shledanou." }, { inputs: 0 });
  d.node("bye", "tts", 2, 4, { text: "Na shledanou." }, { inputs: 0 });
  d.node("closed", "tts", 3, 2, { text: "Dobrý den, právě máme zavřeno. Jsme tu v pracovní dny od osmi do sedmnácti hodin." }, { inputs: 0 });
  d.node("closed_end", "hangup", 3, 3, { as: "busy" }, { label: "Busy" });
  d.node("end", "hangup", 1, 7);
  d.flow("start", "next", "hours");
  d.flow("hours", "on_true", "menu");
  d.flow("hours", "on_false", "closed");
  d.flow("menu", "next", "pick");
  d.flow("menu", "on_failed", "pick");
  d.flow("pick", "next", "is_one");
  d.flow("pick", "on_timeout", "bye");
  d.data("pick", "digits", "is_one", "IN1");
  d.flow("is_one", "on_true", "operator");
  d.flow("is_one", "on_false", "menu");
  d.flow("operator", "on_answered", "end");
  d.flow("operator", "on_busy", "busy_msg");
  d.flow("operator", "on_no_answer", "busy_msg");
  d.flow("operator", "on_failed", "busy_msg");
  d.flow("busy_msg", "next", "end");
  d.flow("busy_msg", "on_failed", "end");
  d.flow("bye", "next", "end");
  d.flow("bye", "on_failed", "end");
  d.flow("closed", "next", "closed_end");
  d.flow("closed", "on_failed", "closed_end");
  return d.graph();
}

export type TsaTemplate = { id: string; name: string; description: string; graph: () => TsaGraph };

export const TSA_TEMPLATES: TsaTemplate[] = [
  { id: "ivr-menu", name: "IVR menu", description: "A greeting and a one-digit menu: 1 and 2 play a message, 3 calls the operator, anything else repeats the menu; silence is asked twice more, then goodbye. Fill in the operator's number.", graph: ivrMenu },
  { id: "route-code", name: "Route code", description: "Asks for a 6-digit route code and connects the call's audio to the room or member the inroute table names; three attempts, then goodbye.", graph: routeCode },
  { id: "voicemail", name: "Voicemail", description: "A greeting, a recorded message with its transcript, posted as a notice into a room. Fill in the room (its blind id).", graph: voicemail },
  { id: "opening-hours", name: "Opening hours", description: "Inside the hours (Mon–Fri 08:00–17:00, Prague) a menu where 1 calls the operator; outside a 'closed' message and busy. Fill in the operator's number.", graph: openingHours },
];
