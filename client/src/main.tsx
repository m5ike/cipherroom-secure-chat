import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./mobile.css";
import "./account.css";
import { applyDeviceAttributes, captureInstallPrompt, deviceInfo, startViewportSync, watchFullscreen } from "./lib/device";
import { startStyleRuntime } from "./lib/style-editor";
import { loadPreferences } from "./lib/preferences";

// Before the first render: classify the device (phone / tablet / desktop,
// OS, browser) so the very first paint already uses the optimised layout,
// track the visual viewport (on-screen keyboard), and mount the user's
// saved Edit Mode styles.
applyDeviceAttributes(deviceInfo(), loadPreferences().deviceLayout);
startViewportSync();
watchFullscreen(() => {});
captureInstallPrompt();
startStyleRuntime();

createRoot(document.getElementById("root")!).render(<App />);
