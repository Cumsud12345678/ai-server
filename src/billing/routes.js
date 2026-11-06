// Balans marşrutları (xidmət açarı ilə: portal çağırır) və ödəniş provayderinin webhook-u.
import { adminLedger, adminRequests, getAiControl, listRequests, requestTopup, resolveRequest, setAiControl, setSettings, summary, topup } from "./billing.js";
import { activeProvider, getProvider } from "./providers.js";
import { store } from "./storage.js";
import { fromMicro } from "./pricing.js";
import { finance } from "./finance.js";

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[billing]", err);
    res.status(500).json({ error: "Xəta baş verdi" });
  }
};

export function registerBillingRoutes(app, { serviceAuth, customerTenant }) {
  const base = "/v1/service/tenants/:tenantId/billing";

  app.get(base, serviceAuth, customerTenant, wrap(async (req, res) => res.json(await summary(req.tenant.tenantId, { admin: req.query.admin === "1" }))));

  // Müştəri yükləmə istəyir
  app.post(`${base}/topup-request`, serviceAuth, customerTenant, wrap(async (req, res) => {
    const provider = activeProvider();
    const request = await requestTopup(req.tenant.tenantId, req.body?.amountAzn, { provider: provider.name });
    if (provider.createCheckout) {
      const { url } = await provider.createCheckout({ tenantId: req.tenant.tenantId, amountAzn: request.amountAzn, requestId: request.id });
      return res.status(201).json({ request, provider: provider.name, checkoutUrl: url });
    }
    res.status(201).json({ request, provider: provider.name, instructions: provider.instructions?.() ?? "" });
  }));

  // Admin: əl ilə yükləmə / düzəliş
  app.post(`${base}/topup`, serviceAuth, customerTenant, wrap(async (req, res) => {
    const { amountAzn, note, by, ref } = req.body ?? {};
    res.json(await topup(req.tenant.tenantId, amountAzn, { note, by, ref }));
  }));
  app.patch(`${base}/settings`, serviceAuth, customerTenant, wrap(async (req, res) => res.json(await setSettings(req.tenant.tenantId, req.body ?? {}))));

  // Admin: gözləyən sorğular və bütün balanslar
  app.get("/v1/service/billing/requests", serviceAuth, wrap(async (req, res) => {
    // Köhnə çağırış (yalnız status): gözləyənlər siyahısı. Yeni: status=all və süzgəclər + səhifələmə (Ödənişlər səhifəsi)
    const q = req.query;
    if (q.status === "all" || q.tenantId || q.since || q.until || q.before || q.limit) return res.json(await adminRequests({ ...q, status: q.status === "all" ? undefined : q.status }));
    const status = ["pending", "approved", "rejected"].includes(q.status) ? q.status : "pending";
    res.json({ requests: await listRequests({ status, limit: 100 }) });
  }));
  app.get("/v1/service/billing/ledger", serviceAuth, wrap(async (req, res) => res.json(await adminLedger(req.query))));

  // Ümumi AI açarı (admin)
  app.get("/v1/service/ai-control", serviceAuth, wrap(async (_req, res) => res.json(await getAiControl())));
  app.put("/v1/service/ai-control", serviceAuth, wrap(async (req, res) => res.json(await setAiControl(req.body ?? {}))));
  app.post("/v1/service/billing/requests/:id/:action", serviceAuth, wrap(async (req, res) => res.json(await resolveRequest(String(req.params.id).slice(0, 80), req.params.action, String(req.body?.by ?? "").slice(0, 80)))));
  app.get("/v1/service/billing/accounts", serviceAuth, wrap(async (_req, res) => {
    const rows = await store().listAccounts();
    res.json({ accounts: rows.map((a) => ({ tenantId: a._id, totalAzn: fromMicro(a.free + a.paid), paidAzn: fromMicro(a.paid), spentAzn: fromMicro(a.spent ?? 0) })) });
  }));

  // Admin: maliyyə hesabatı (pul girişi, AI xərci, mənfəət, model və müştəri üzrə)
  app.get("/v1/service/billing/finance", serviceAuth, wrap(async (req, res) => res.json(await finance({ months: req.query.months }))));

  // Ödəniş şlüzü xəbəri (provayder qoşulanda işləyir)
  app.post("/v1/billing/webhook/:provider", wrap(async (req, res) => {
    const p = getProvider(String(req.params.provider));
    if (!p?.handleWebhook) return res.status(404).json({ error: "Provayder tapılmadı" });
    const evt = await p.handleWebhook(req);
    if (!evt) return res.status(400).json({ error: "Etibarsız xəbər" });
    const out = await topup(evt.tenantId, evt.amountAzn, { note: `Ödəniş (${p.name})`, by: p.name, ref: `pay:${p.name}:${evt.ref}` });
    if (evt.requestId) { try { await resolveRequest(evt.requestId, "approve", p.name); } catch { /* sorğu yoxdur/artıq həll olunub */ } }
    res.json({ ok: true, duplicate: out.duplicate });
  }));
}
