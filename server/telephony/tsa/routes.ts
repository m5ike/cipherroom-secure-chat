// The console's TSA endpoints (6.9), on the ADMIN service behind its
// authentication and consoleGuard("telephony", …) — see control/api-contract.ts:
//
//   GET    /admin/telephony/tsa/catalog          the palette, groups, limits, templates, formula functions
//   GET    /admin/telephony/tsa                  the list (TsaListRow[] as `tsas`)
//   POST   /admin/telephony/tsa                  create { id?, name, description?, template? }
//   GET    /admin/telephony/tsa/:id              the TSA, its problems, which rules use it
//   PUT    /admin/telephony/tsa/:id              save the draft { name, description, graph, tags }
//   DELETE /admin/telephony/tsa/:id              refused while a rule uses it
//   POST   /admin/telephony/tsa/:id/validate     { graph? } → problems
//   POST   /admin/telephony/tsa/:id/publish      the draft → version + 1 (no errors allowed)
//   POST   /admin/telephony/tsa/:id/duplicate    { id?, name? }
//   GET    /admin/telephony/tsa/:id/export       a JSON file
//   POST   /admin/telephony/tsa/import           an exported file ({ format, tsa } — or { file, id?, name? })
//   POST   /admin/telephony/sim                  { tsa, draft?, from?, to?, vars? } → { session, turn }
//   POST   /admin/telephony/sim/:session/event   a TsaEvent → { session, turn }
//   GET    /admin/telephony/sim/:session         a simulation's session with its trace
//
// And the audio files the Play tool plays (not in the contract's table):
//
//   GET    /admin/telephony/tsa/files            { files, limits }
//   POST   /admin/telephony/tsa/files            { name, data: "data:audio/…;base64,…" }
//   GET    /admin/telephony/tsa/files/:id        the audio (the console's preview)
//   DELETE /admin/telephony/tsa/files/:id
//
// Answers are { ok: true, … } or { ok: false, message, problems? }.

import type { Express, Request, Response } from "express";
import type { TsaListRow } from "../control/api-contract";
import { telLog } from "../control/hooks";
import { CALL_PROPS, FORMULA_FUNCTIONS } from "./formula";
import { TSA_CATALOG, TSA_GROUPS } from "./catalog";
import { AUDIO_FILE_LIMITS, AudioFileError, addAudioFile, listAudioFiles, readAudioFile, removeAudioFile } from "./files";
import { SimError, simEvent, simGet, simStart } from "./simulator";
import { TsaStoreError, tsaStore } from "./store";
import { TSA_TEMPLATES } from "./templates";
import { TSA_ID, TSA_LIMITS } from "./types";
import "./runtime";

const who = (res: Response): string => String(res.locals.adminName ?? "admin").slice(0, 120);
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});

function failed(res: Response, err: unknown): void {
  if (err instanceof TsaStoreError) { res.status(err.status).json({ ok: false, message: err.message, ...(err.problems.length ? { problems: err.problems } : {}) }); return; }
  if (err instanceof SimError || err instanceof AudioFileError) { res.status(err.status).json({ ok: false, message: err.message }); return; }
  res.status(500).json({ ok: false, message: (err as Error).message?.slice(0, 300) || "failed" });
}

function row(t: ReturnType<typeof tsaStore.list>[number]): TsaListRow {
  return {
    id: t.id, name: t.name, description: t.description, version: t.version, updatedAt: t.updatedAt, updatedBy: t.updatedBy, tags: t.tags,
    published: Boolean(t.published), publishedVersion: t.published?.version ?? 0, usedBy: tsaStore.usedBy(t.id), nodes: t.graph.nodes.length,
  };
}

const idOf = (req: Request): string | null => { const id = String(req.params.id); return TSA_ID.test(id) ? id : null; };

export function registerTsaRoutes(app: Express): void {
  /* ------------------------------------------------------------ palette */

  app.get("/admin/telephony/tsa/catalog", (_req, res) => {
    res.json({
      ok: true, tools: TSA_CATALOG, groups: TSA_GROUPS, limits: { ...TSA_LIMITS },
      templates: TSA_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
      formula: { functions: FORMULA_FUNCTIONS, call: CALL_PROPS },
    });
  });

  /* -------------------------------------------------------- audio files */

  app.get("/admin/telephony/tsa/files", (_req, res) => { res.json({ ok: true, files: listAudioFiles(), limits: AUDIO_FILE_LIMITS }); });
  app.post("/admin/telephony/tsa/files", (req, res) => {
    try {
      const file = addAudioFile(body(req), who(res));
      telLog({ kind: "config", level: "info", summary: `audio file "${file.name}" uploaded by ${who(res)} (${Math.round(file.bytes / 1024)} kB)` });
      res.json({ ok: true, file });
    } catch (err) { failed(res, err); }
  });
  app.get("/admin/telephony/tsa/files/:fid", (req, res) => {
    const f = readAudioFile(String(req.params.fid));
    if (!f) return res.status(404).json({ ok: false, message: "No such file." });
    res.type(f.file.mime).send(f.bytes);
  });
  app.delete("/admin/telephony/tsa/files/:fid", (req, res) => {
    const ok = removeAudioFile(String(req.params.fid));
    if (!ok) return res.status(404).json({ ok: false, message: "No such file." });
    telLog({ kind: "config", level: "info", summary: `audio file ${String(req.params.fid)} removed by ${who(res)}` });
    res.json({ ok: true });
  });

  /* --------------------------------------------------------------- TSAs */

  app.get("/admin/telephony/tsa", (_req, res) => {
    res.json({ ok: true, tsas: tsaStore.list().map(row), templates: TSA_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })), store: tsaStore.status() });
  });

  app.post("/admin/telephony/tsa", (req, res) => {
    try {
      const r = tsaStore.create(body(req), who(res));
      telLog({ kind: "config", level: "info", summary: `TSA ${r.tsa.id} created by ${who(res)}${typeof body(req).template === "string" ? ` from the template ${String(body(req).template)}` : ""}` });
      res.json({ ok: true, ...r });
    } catch (err) { failed(res, err); }
  });

  app.post("/admin/telephony/tsa/import", (req, res) => {
    try {
      const b = body(req);
      let raw: unknown = b.format === "m5cet-tsa" || b.tsa ? b : b.file;
      if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { throw new TsaStoreError(400, "The file is not JSON."); } }
      const r = tsaStore.importOne(raw, who(res), { id: b.id, name: b.name });
      telLog({ kind: "config", level: "info", summary: `TSA ${r.tsa.id} imported by ${who(res)}` });
      res.json({ ok: true, ...r });
    } catch (err) { failed(res, err); }
  });

  app.get("/admin/telephony/tsa/:id", (req, res) => {
    const id = idOf(req);
    const t = id ? tsaStore.get(id) : null;
    if (!t) return res.status(404).json({ ok: false, message: "No such TSA." });
    res.json({ ok: true, tsa: t, usedBy: tsaStore.usedBy(t.id), problems: tsaStore.problems(t.graph) });
  });

  app.put("/admin/telephony/tsa/:id", (req, res) => {
    const id = idOf(req);
    if (!id) return res.status(404).json({ ok: false, message: "No such TSA." });
    try { res.json({ ok: true, ...tsaStore.saveDraft(id, body(req), who(res)) }); }
    catch (err) { failed(res, err); }
  });

  app.delete("/admin/telephony/tsa/:id", (req, res) => {
    const id = idOf(req);
    if (!id) return res.status(404).json({ ok: false, message: "No such TSA." });
    try {
      tsaStore.remove(id);
      telLog({ kind: "config", level: "notice", summary: `TSA ${id} deleted by ${who(res)}` });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof TsaStoreError && err.status === 409) return res.status(409).json({ ok: false, message: err.message, usedBy: tsaStore.usedBy(id) });
      failed(res, err);
    }
  });

  app.post("/admin/telephony/tsa/:id/validate", (req, res) => {
    const id = idOf(req);
    const t = id ? tsaStore.get(id) : null;
    if (!t) return res.status(404).json({ ok: false, message: "No such TSA." });
    const b = body(req);
    res.json({ ok: true, problems: tsaStore.problems(b.graph !== undefined ? b.graph : t.graph) });
  });

  app.post("/admin/telephony/tsa/:id/publish", (req, res) => {
    const id = idOf(req);
    if (!id) return res.status(404).json({ ok: false, message: "No such TSA." });
    try {
      const r = tsaStore.publish(id, who(res));
      telLog({ kind: "config", level: "notice", summary: `TSA ${id} v${r.tsa.version} published by ${who(res)}` });
      res.json({ ok: true, ...r });
    } catch (err) { failed(res, err); }
  });

  app.post("/admin/telephony/tsa/:id/duplicate", (req, res) => {
    const id = idOf(req);
    if (!id) return res.status(404).json({ ok: false, message: "No such TSA." });
    try {
      const tsa = tsaStore.duplicate(id, body(req), who(res));
      res.json({ ok: true, tsa, problems: tsaStore.problems(tsa.graph) });
    } catch (err) { failed(res, err); }
  });

  app.get("/admin/telephony/tsa/:id/export", (req, res) => {
    const id = idOf(req);
    if (!id) return res.status(404).json({ ok: false, message: "No such TSA." });
    try {
      const doc = tsaStore.exportOne(id);
      res.setHeader("Content-Disposition", `attachment; filename="tsa-${id}.json"`);
      res.type("application/json").send(JSON.stringify(doc, null, 2));
    } catch (err) { failed(res, err); }
  });

  /* ---------------------------------------------------------- simulator */

  app.post("/admin/telephony/sim", async (req, res) => {
    try { res.json({ ok: true, ...(await simStart(body(req))) }); }
    catch (err) { failed(res, err); }
  });

  app.post("/admin/telephony/sim/:session/event", async (req, res) => {
    try { res.json({ ok: true, ...(await simEvent(String(req.params.session).slice(0, 80), body(req))) }); }
    catch (err) { failed(res, err); }
  });

  app.get("/admin/telephony/sim/:session", async (req, res) => {
    const s = await simGet(String(req.params.session).slice(0, 80));
    if (!s) return res.status(404).json({ ok: false, message: "No such session." });
    res.json({ ok: true, session: s });
  });
}
