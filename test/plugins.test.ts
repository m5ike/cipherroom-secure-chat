import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pluginLog } from "../server/plugins/log";
import { bytesToBase64, base64ToBytes, ConnectorNotConfiguredError } from "../server/plugins/types";
import { OpenAiConnector } from "../server/plugins/connectors/ai";
import {
  aiEnabled, speechEnabled, registrySnapshot, getAi, publicSpeechStatus,
} from "../server/plugins/registry";

const AI_ENV = ["ENABLE_AI", "ENABLE_SPEECH", "OPENAI_API_KEY", "AI_PROVIDER", "ANTHROPIC_API_KEY", "OLLAMA_URL", "HF_API_KEY"];

describe("plugin log", () => {
  beforeEach(() => pluginLog.clear());
  it("records entries with id + ts and streams them", () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    pluginLog.emitter.on("entry", on);
    const e = pluginLog.record({ level: "info", kind: "ai", connector: "openai", message: "hi" });
    pluginLog.emitter.off("entry", on);
    expect(e.id).toBeTruthy();
    expect(e.ts).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(pluginLog.recent(10)).toHaveLength(1);
  });
  it("is bounded to 500 entries", () => {
    for (let i = 0; i < 600; i += 1) pluginLog.record({ level: "info", kind: "ai", message: String(i) });
    expect(pluginLog.recent(1000).length).toBe(500);
    expect(pluginLog.recent(1000)[499].message).toBe("599");
  });
  it("time() logs success and rethrows on failure", async () => {
    await pluginLog.time("tts", "x", "op", async () => 1);
    await expect(pluginLog.time("tts", "x", "op", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const msgs = pluginLog.recent(10).map((e) => e.message);
    expect(msgs.some((m) => m.includes("ok"))).toBe(true);
    expect(msgs.some((m) => m.includes("failed"))).toBe(true);
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("registry gating + status", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of AI_ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of AI_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("is off and unconfigured by default", () => {
    expect(aiEnabled()).toBe(false);
    expect(speechEnabled()).toBe(false);
    const snap = registrySnapshot();
    expect(snap.ai.every((c) => !c.configured)).toBe(true);
    expect(publicSpeechStatus().ai.connectors).toHaveLength(0);
  });

  it("reports a connector configured once its key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const openai = registrySnapshot().ai.find((c) => c.id === "openai");
    expect(openai?.configured).toBe(true);
    expect(getAi()?.id).toBe("openai"); // default resolves to the configured one
    expect(publicSpeechStatus().ai.connectors.map((c) => c.id)).toContain("openai");
  });

  it("honours AI_PROVIDER for the default when several are configured", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OLLAMA_URL = "http://127.0.0.1:11434";
    process.env.AI_PROVIDER = "ollama";
    expect(getAi()?.id).toBe("ollama");
  });
});

describe("connector refuses to run unconfigured", () => {
  it("OpenAI throws ConnectorNotConfiguredError without a key", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(new OpenAiConnector().complete({ messages: [{ role: "user", content: "hi" }] }))
        .rejects.toBeInstanceOf(ConnectorNotConfiguredError);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
    }
  });
});
