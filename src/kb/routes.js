// Bilik bazası endpoint-ləri (yalnız portal çağırır: /v1/service/tenants/:tenantId/kb/*)
import express from "express";
import { listSources, listInbox, updateInbox, deleteInbox, deleteSource, addInbox, countChunks } from "./store.js";
import { ingestFile, ingestText, ingestUrl, refreshSource, MAX_FILE_BYTES } from "./ingest.js";
import { KbError } from "./extract.js";
import { createQa, updateQa, MAX_QUESTIONS, MAX_QUESTION_CHARS, MAX_ANSWER_CHARS } from "./qa.js";
import { maskPII } from "../queries/queries.js";
import { fallbackText } from "./answer.js";

const STALE_MS = 20 * 60_000;
const view = (s) => ({
  id: s._id, type: s.type, name: s.name, url: s.url ?? null, status: s.status === "processing" && Date.now() - new Date(s.updatedAt) > STALE_MS ? "failed" : s.status,
  error: s.status === "processing" && Date.now() - new Date(s.updatedAt) > STALE_MS ? "Emal yarımçıq qaldı, yenidən cəhd edin" : s.error,
  chunks: s.chunks ?? 0, chars: s.chars ?? 0, pages: s.pages ?? 0, size: s.size ?? null, createdAt: s.createdAt, lastIndexedAt: s.lastIndexedAt ?? null, lastRefreshAt: s.lastRefreshAt ?? null, refreshError: s.refreshError ?? null,
  ...(s.type === "qa" && { questions: s.questions ?? [], answer: s.answer ?? "" }),
});
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function registerKbRoutes(app, { serviceAuth, customerTenant }) {
  const base = "/v1/service/tenants/:tenantId/kb";
  const guard = [serviceAuth, customerTenant];
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof KbError) return res.status(e.code === "DUPLICATE" ? 409 : 400).json({ error: e.message, code: e.code });
      console.error("[kb]", e);
      res.status(500).json({ error: "Xəta baş verdi" });
    }
  };

  app.get(base, ...guard, wrap(async (req, res) => {
    const t = req.tenant;
    const [sources, chunks] = await Promise.all([listSources(t.tenantId), countChunks(t.tenantId)]);
    res.json({
      mode: t.profile?.mode ?? "listings", autoRefresh: t.profile?.kbAutoRefresh ?? "weekly", fallbackMessage: t.profile?.fallbackMessage ?? "", defaultFallback: fallbackText({ ...t, profile: { ...t.profile, fallbackMessage: "" } }),
      sources: sources.map(view),
      limits: { qa: t.limits?.kbQa ?? (Number(process.env.KB_MAX_QA) || 300), qaQuestions: MAX_QUESTIONS, qaQuestionChars: MAX_QUESTION_CHARS, qaAnswerChars: MAX_ANSWER_CHARS, sources: t.limits?.kbSources ?? (Number(process.env.KB_MAX_SOURCES) || 30), chunks: t.limits?.kbChunks ?? (Number(process.env.KB_MAX_CHUNKS) || 2500), fileBytes: MAX_FILE_BYTES },
      totals: { sources: sources.filter((x) => x.type !== "qa").length, qa: sources.filter((x) => x.type === "qa").length, chunks },
    });
  }));

  // Fayl JSON içində base64 gəlir (portal multipart-ı özü qəbul edib çevirir); yalnız bu route böyük gövdə qəbul edir
  app.post(`${base}/files`, ...guard, express.json({ limit: Math.ceil(MAX_FILE_BYTES * 1.4) + 4096 }), wrap(async (req, res) => {
    const { name, mime, data } = req.body ?? {};
    if (typeof name !== "string" || typeof data !== "string" || !data) throw new KbError("name və data tələb olunur", "BAD_REQUEST");
    const s = await ingestFile(req.tenant, { name: name.slice(0, 200), mime: str(mime, 100), buffer: Buffer.from(data, "base64") });
    res.status(202).json({ source: view(s) });
  }));
  app.post(`${base}/urls`, ...guard, wrap(async (req, res) => {
    const url = str(req.body?.url, 2000);
    if (!url) throw new KbError("url tələb olunur", "BAD_REQUEST");
    res.status(202).json({ source: view(await ingestUrl(req.tenant, { url, crawl: req.body?.crawl === true })) });
  }));
  app.post(`${base}/texts`, ...guard, wrap(async (req, res) => {
    res.status(202).json({ source: view(await ingestText(req.tenant, { title: str(req.body?.title, 160), text: typeof req.body?.text === "string" ? req.body.text : "" })) });
  }));
  // Sual-cavab cütləri: vektorlaşdırma qısadır, ona görə dərhal hazır qayıdır
  app.post(`${base}/qa`, ...guard, wrap(async (req, res) => {
    res.status(201).json({ source: view(await createQa(req.tenant, req.body)) });
  }));
  app.put(`${base}/qa/:id`, ...guard, wrap(async (req, res) => {
    const s = await updateQa(req.tenant, req.params.id, req.body);
    if (!s) return res.status(404).json({ error: "Cütlük tapılmadı" });
    res.json({ source: view(s) });
  }));
  app.post(`${base}/sources/:id/refresh`, ...guard, wrap(async (req, res) => {
    const s = await refreshSource(req.tenant, req.params.id);
    if (!s) return res.status(404).json({ error: "Mənbə tapılmadı" });
    res.status(202).json({ source: view(s) });
  }));
  app.delete(`${base}/sources/:id`, ...guard, wrap(async (req, res) => {
    if (!(await listSources(req.tenant.tenantId)).some((s) => s._id === req.params.id)) return res.status(404).json({ error: "Mənbə tapılmadı" });
    await deleteSource(req.tenant.tenantId, req.params.id);
    res.json({ ok: true });
  }));

  // ---- cavabsız suallar ----
  const inboxView = (d) => ({ id: d._id, at: d.at, ...(d.message !== undefined && { message: d.message }), ...(d.reason && { reason: d.reason }),
    ...(d.contact !== undefined && { name: d.name ?? "", contact: d.contact, question: d.question ?? "", conversation: d.conversation ?? [], handled: Boolean(d.handled) }) });
  app.get(`${base}/unanswered`, ...guard, wrap(async (req, res) => {
    const { total, items } = await listInbox("unanswered", req.tenant.tenantId, { limit: Number(req.query.limit) || 100 });
    res.json({ total, items: items.map(inboxView) });
  }));
  app.delete(`${base}/unanswered/:id`, ...guard, wrap(async (req, res) => {
    res.status((await deleteInbox("unanswered", req.tenant.tenantId, req.params.id)) ? 200 : 404).json({ ok: true });
  }));

  // ---- müraciətlər (operatorla əlaqə) ----
  app.get(`${base}/leads`, ...guard, wrap(async (req, res) => {
    const { total, items } = await listInbox("leads", req.tenant.tenantId, { limit: Number(req.query.limit) || 100 });
    res.json({ total, open: items.filter((d) => !d.handled).length, items: items.map(inboxView) });
  }));
  const cleanConvo = (c) => (Array.isArray(c) ? c : []).slice(-10)
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string" && m.text.trim())
    .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 600) }));
  app.post(`${base}/leads`, ...guard, wrap(async (req, res) => {
    const b = req.body ?? {};
    const contact = str(b.contact, 120);
    if (contact.length < 5 || !(/@/.test(contact) || contact.replace(/\D/g, "").length >= 7)) throw new KbError("Düzgün telefon və ya e-poçt yazın", "BAD_CONTACT");
    const doc = await addInbox("leads", req.tenant.tenantId, { name: str(b.name, 80), contact, question: str(b.question, 500), conversation: cleanConvo(b.conversation), handled: false });
    res.status(201).json({ ok: true, lead: inboxView(doc) });
  }));
  app.patch(`${base}/leads/:id`, ...guard, wrap(async (req, res) => {
    if (typeof req.body?.handled !== "boolean") throw new KbError("handled true/false olmalıdır", "BAD_REQUEST");
    const d = await updateInbox("leads", req.tenant.tenantId, req.params.id, { handled: req.body.handled });
    if (!d) return res.status(404).json({ error: "Müraciət tapılmadı" });
    res.json({ lead: inboxView(d) });
  }));
  app.delete(`${base}/leads/:id`, ...guard, wrap(async (req, res) => {
    res.status((await deleteInbox("leads", req.tenant.tenantId, req.params.id)) ? 200 : 404).json({ ok: true });
  }));
}
void maskPII;
