import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import "./mobile.css";
import "./account.css";
import "./themes.css";
import { applyDeviceAttributes, captureInstallPrompt, deviceInfo, startViewportSync, watchFullscreen } from "./lib/device";
import { startStyleRuntime } from "./lib/style-editor";
import { loadPreferences } from "./lib/preferences";
import { applyTheme } from "./lib/themes";
import { effectiveAppearance } from "./lib/client-config";
import { loadCachedClientConfig } from "./lib/client-config-client";

// Before the first render: classify the device (phone / tablet / desktop,
// OS, browser) so the very first paint already uses the optimised layout,
// track the visual viewport (on-screen keyboard), and mount the user's
// saved Edit Mode styles.
// The version check's fix reloads with ?refresh=…: it has done its job.
{
  const url = new URL(window.location.href);
  if (url.searchParams.has("refresh")) {
    url.searchParams.delete("refresh");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}
const startPrefs = loadPreferences();
applyDeviceAttributes(deviceInfo(), startPrefs.deviceLayout);
// The template before the first paint: no flash of the default one.
{
  const shown = effectiveAppearance(startPrefs, loadCachedClientConfig().appearance);
  applyTheme(shown.theme, startPrefs.accent, startPrefs.layout, { tone: shown.tone, icons: shown.icons });
}
startViewportSync();
watchFullscreen(() => {});
captureInstallPrompt();
startStyleRuntime();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary scope="app">
    <App />
  </ErrorBoundary>,
);
