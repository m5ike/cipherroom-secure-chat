// Whether the AI and speech modules are on (4.0.6): switched in the console
// (Konzole › AI & speech) and kept in a file both services read — or fixed by
// the environment, which wins when it is set:
//
//   ENABLE_AI=1 / 0, ENABLE_SPEECH=1 / 0     (unset: the console decides)
//
//   PLUGINS_SETTINGS_FILE                    explicit path, or
//   $DATA_DIR/plugins.json                   (shared by the app and the admin service), or
//   ./.m5cet/plugins.json
//
// Both stay OFF until an operator turns them on: each call can cost money at
// a provider.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type PluginSwitch = "ai" | "speech";
export type SwitchSource = "env" | "console" | "default";
export type PluginSettings = { ai?: boolean; speech?: boolean; updatedAt?: number; updatedBy?: string };

const ENV_NAME: Record<PluginSwitch, string> = { ai: "ENABLE_AI", speech: "ENABLE_SPEECH" };

export function pluginSettingsPath(): string {
  const explicit = process.env.PLUGINS_SETTINGS_FILE?.trim();
  if (explicit) return resolve(explicit);
  const dir = process.env.DATA_DIR?.trim();
  return dir ? resolve(dir, "plugins.json") : resolve(process.cwd(), ".m5cet", "plugins.json");
}

let cache: { sig: string; file: string; settings: PluginSettings } | null = null;

function read(): PluginSettings {
  const file = pluginSettingsPath();
  let sig = "";
  try { const st = statSync(file); sig = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { /* none yet */ }
  if (cache && cache.sig === sig && cache.file === file) return cache.settings;
  let settings: PluginSettings = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    settings = {
      ai: typeof raw.ai === "boolean" ? raw.ai : undefined,
      speech: typeof raw.speech === "boolean" ? raw.speech : undefined,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
      updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy.slice(0, 120) : undefined,
    };
  } catch { /* missing or corrupt → off */ }
  cache = { sig, file, settings };
  return settings;
}

/** "1" / "true" / "on" → true, "0" / "false" / "off" → false, else not set. */
function envSwitch(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return undefined;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return undefined;
}

/** Whether a module is on, and who decided. */
export function switchState(which: PluginSwitch): { enabled: boolean; source: SwitchSource; env: string } {
  const fromEnv = envSwitch(ENV_NAME[which]);
  if (fromEnv !== undefined) return { enabled: fromEnv, source: "env", env: ENV_NAME[which] };
  const stored = read()[which];
  if (stored !== undefined) return { enabled: stored, source: "console", env: ENV_NAME[which] };
  return { enabled: false, source: "default", env: ENV_NAME[which] };
}

export function pluginSettings(): PluginSettings {
  return { ...read() };
}

/** Saves the console's switches (atomic, 0600). A switch the environment fixes is refused. */
export function setPluginSwitches(change: Partial<Record<PluginSwitch, boolean>>, actor: string): { ok: true } | { ok: false; message: string } {
  for (const which of Object.keys(change) as PluginSwitch[]) {
    if (switchState(which).source === "env") return { ok: false, message: `${ENV_NAME[which]} is set in the server's environment — change or remove it there (then restart).` };
  }
  const next: PluginSettings = { ...read(), ...change, updatedAt: Date.now(), updatedBy: actor.slice(0, 120) };
  const file = pluginSettingsPath();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    cache = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `cannot write ${file}: ${(err as Error).message}` };
  }
}
