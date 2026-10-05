// The server picker (m5cet-app://ui/welcome.html). Plain DOM, no framework,
// no inline script (its CSP is script-src 'self').

import type { UiState } from "../src/ui-preload";

type M5App = {
  state(): Promise<UiState>;
  connect(input: string): Promise<{ ok: boolean; error?: string }>;
  open(origin: string): Promise<{ ok: boolean; error?: string }>;
  remove(origin: string): Promise<void>;
  onState(fn: () => void): () => void;
};

const m5app = (window as unknown as { m5app: M5App }).m5app;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let strings: Record<string, string> = {};
const s = (k: string) => strings[k] ?? k;

function setBusy(busy: boolean): void {
  $<HTMLButtonElement>("connect").disabled = busy;
  $<HTMLInputElement>("server").disabled = busy;
  $("busy").hidden = !busy;
}

function showError(message: string): void {
  const el = $("error");
  el.textContent = message;
  el.hidden = !message;
}

async function render(): Promise<void> {
  const st = await m5app.state();
  strings = st.strings;
  document.documentElement.lang = st.lang;
  $("title").textContent = s("welcome.title");
  $("intro").textContent = s("welcome.intro");
  $("connect").textContent = s("btn.connect");
  $("servers").textContent = s("welcome.servers");
  $("note").textContent = s("welcome.note");
  $("busy").textContent = s("welcome.checking");
  $("version").textContent = `M5cet Desktop ${st.version}${st.signed ? "" : ` · ${s("welcome.unsigned")}`}`;
  const input = $<HTMLInputElement>("server");
  if (!input.value && st.defaultServer && st.servers.length === 0) input.value = st.defaultServer;
  showError(st.error);
  const list = $("list");
  list.replaceChildren();
  for (const srv of st.servers) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = srv.display;
    name.title = srv.origin;
    li.append(name);
    if (srv.codeSource === "server") {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = s("title.serverCode");
      li.append(tag);
    }
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = s("btn.open");
    open.addEventListener("click", () => void go(() => m5app.open(srv.origin)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = s("btn.remove");
    remove.addEventListener("click", () => void m5app.remove(srv.origin).then(render));
    li.append(open, remove);
    list.append(li);
  }
  $("list-wrap").hidden = st.servers.length === 0;
}

async function go(action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  showError("");
  setBusy(true);
  try {
    const r = await action();
    if (!r.ok) showError(r.error ?? s("err.invalid"));
  } finally {
    setBusy(false);
  }
}

$<HTMLFormElement>("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $<HTMLInputElement>("server").value;
  void go(() => m5app.connect(value));
});

m5app.onState(() => void render());
void render().then(() => $<HTMLInputElement>("server").focus());
