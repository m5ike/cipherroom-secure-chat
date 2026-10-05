// The persistent indicator over the page while it runs this server's web
// code (m5cet-app://ui/banner.html). The page cannot hide it: it is a view of
// its own above the page, in another session.

import type { UiState } from "../src/ui-preload";

type M5App = { state(): Promise<UiState>; useAppCode(): Promise<void>; onState(fn: () => void): () => void };
const m5app = (window as unknown as { m5app: M5App }).m5app;

async function render(): Promise<void> {
  const st = await m5app.state();
  document.documentElement.lang = st.lang;
  const server = st.banner?.server ?? "";
  (document.getElementById("text") as HTMLElement).textContent = (st.strings["banner.serverCode"] ?? "").replace("{server}", server);
  (document.getElementById("back") as HTMLElement).textContent = st.strings["banner.switchBack"] ?? "";
}

document.getElementById("back")?.addEventListener("click", () => void m5app.useAppCode());
m5app.onState(() => void render());
void render();
