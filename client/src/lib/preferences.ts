// Local-only preferences. Never sent to the server.

export type Preferences = {
  theme: "light" | "dark";
  mode: "light" | "server";
  name: string;
  lastRoom: string;
  notificationsEnabled: boolean;
};

const STORAGE_KEY = "cipherroom:prefs:v1";

const DEFAULTS: Preferences = {
  theme: "light",
  mode: "light",
  name: "",
  lastRoom: "brno-secure",
  notificationsEnabled: false,
};

function safeGet(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadPreferences(): Preferences {
  const storage = safeGet();
  if (!storage) return { ...DEFAULTS };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: parsed.theme === "dark" ? "dark" : "light",
      mode: parsed.mode === "server" ? "server" : "light",
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 42) : DEFAULTS.name,
      lastRoom: typeof parsed.lastRoom === "string" ? parsed.lastRoom.slice(0, 48) : DEFAULTS.lastRoom,
      notificationsEnabled: parsed.notificationsEnabled === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(prefs: Preferences) {
  const storage = safeGet();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota or privacy mode — fail silently.
  }
}

export function clearPreferences() {
  const storage = safeGet();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
