import express from "express";
import crypto from "node:crypto";
import { getTenantByKey, getTenant, refreshTenants } from "./tenants/tenantStore.js";
import { listCustomerTenants, addCustomerTenant, updateCustomerTenant, removeCustomerTenant } from "./tenants/customerStore.js";
import { getRepo, dropRepo } from "./data/repoFactory.js";
import { advise } from "./ai/advisor.js";
import { recordQuery, listQueries, queryStats, clearQueries, listConversations, getConversation } from "./queries/queries.js";
import { checkAndCount, addTokens, getUsage, getUsageSummary, deleteTenantUsage } from "./usage/usage.js";
import { canSpend, charge, deleteTenantBilling } from "./billing/billing.js";
import { registerBillingRoutes } from "./billing/routes.js";
import { sanitizeFilters, compileSchema } from "./data/filters.js";
import { createRestRepo, LOCAL_SORTABLE_FIELDS } from "./connectors/restRepo.js";
import { validateFieldSpecs } from "./connectors/mapper.js";
import { encryptSecret } from "./tenants/secretCrypto.js";
import { answerFromKb } from "./kb/answer.js";
import { registerKbRoutes } from "./kb/routes.js";
import { deleteTenantKb } from "./kb/store.js";

const LANGS = ["az", "en", "ru"];
const MODES = ["listings", "support", "both"];
const SECRET_AUTH = ["header", "bearer", "query"];
const newKey = () => `ca_live_${crypto.randomBytes(32).toString("hex")}`;
const hashKey = (key) => crypto.createHash("sha256").update(key).digest("hex");

// ---------- Konfiqurasiya yoxlaması (yalnız portal backend-i çağırır) ----------

function validateConfig(body = {}, { secretAlreadyStored = false } = {}) {
  const { businessName, domain, source, apiSecret } = body;
  if (typeof businessName !== "string" || !businessName.trim() || businessName.length > 120)
    return "businessName tələb olunur (maksimum 120 simvol)";
  if (typeof domain !== "string" || !domain.trim() || domain.length > 253)
    return "domain tələb olunur";
  const mode = body.profile?.mode ?? "listings";
  if (!MODES.includes(mode)) return "profile.mode listings, support və ya both olmalıdır";
  if (mode === "support") return validateProfile(body.profile ?? {}); // dəstək botunun elan mənbəyi yoxdur
  if (!source || source.type !== "rest") return "source.type 'rest' olmalıdır";
  if (typeof source.baseUrl !== "string" || !/^https:\/\//i.test(source.baseUrl)) {
    if (!(process.env.ALLOW_LOCAL_CONNECTORS === "1" && typeof source.baseUrl === "string" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(source.baseUrl)))
      return "baseUrl HTTPS ünvanı olmalıdır";
  }
  if (!source.search || !["GET", "POST"].includes(String(source.search.method || "GET").toUpperCase()) || typeof source.search.path !== "string" || !source.search.path.startsWith("/"))
    return "source.search.path və GET/POST method düzgün göstərilməlidir";
  if (!source.response || typeof source.response.itemsPath !== "string" || !source.response.itemsPath || !source.response.fields || typeof source.response.fields !== "object")
    return "source.response.itemsPath və source.response.fields tələb olunur";
  if (source.search.graphql !== undefined) {
    if (typeof source.search.graphql !== "string" || !source.search.graphql.trim() || source.search.graphql.length > 5000) return "source.search.graphql sorğu mətni olmalıdır (maksimum 5000 simvol)";
    if (source.search.method && String(source.search.method).toUpperCase() !== "POST") return "GraphQL üçün search.method POST olmalıdır";
  }
  if (source.localText !== undefined && typeof source.localText !== "boolean") return "source.localText true və ya false olmalıdır";
  const fieldErr = validateFieldSpecs(source.response.fields);
  if (fieldErr) return fieldErr;
  if (source.auth && !["none", ...SECRET_AUTH].includes(source.auth.type || "none")) return "auth.type dəstəklənmir";
  if (source.auth && SECRET_AUTH.includes(source.auth.type) && !apiSecret && !secretAlreadyStored)
    return "API autentifikasiyası üçün apiSecret tələb olunur";
  if (source.auth?.valueEnv || source.auth?.encryptedValue) return "Konfiqurasiyada valueEnv/encryptedValue göndərməyin; apiSecret sahəsindən istifadə edin";
  if (source.filters !== undefined) {
    if (!source.filters || typeof source.filters !== "object" || Array.isArray(source.filters)) return "source.filters obyekt olmalıdır";
    const { limit, sort } = source.filters;
    if (source.search?.limitParam !== undefined && !/^[A-Za-z0-9_.\-[\]]{1,60}$/.test(String(source.search.limitParam))) return "source.search.limitParam düzgün deyil";
    if (limit !== undefined && (!limit || typeof limit.param !== "string")) return "source.filters.limit.param tələb olunur";
    if (sort !== undefined && (!sort || typeof sort.param !== "string" || !sort.valueMap || typeof sort.valueMap !== "object")) return "source.filters.sort üçün param və valueMap tələb olunur";
    const compiled = compileSchema(source.filters, [], { strict: true });
    if (compiled.error) return compiled.error;
  }
  const ls = source.localSort;
  if (ls !== undefined && ls !== true && ls !== false && !(Array.isArray(ls) && ls.length && ls.every((f) => LOCAL_SORTABLE_FIELDS.includes(f))))
    return `source.localSort true və ya bu sahələrdən siyahı olmalıdır: ${LOCAL_SORTABLE_FIELDS.join(", ")}`;
  return validateProfile(body.profile ?? {});
}

// Yalnız tanınmış profil sahələri qəbul edilir. Qaytarır: xəta mətni və ya null.
function validateProfile(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "profile obyekt olmalıdır";
  if (p.language !== undefined && !LANGS.includes(p.language)) return "profile.language az, en və ya ru olmalıdır";
  if (p.tone !== undefined && (typeof p.tone !== "string" || p.tone.length > 60)) return "profile.tone mətn olmalıdır (maksimum 60 simvol)";
  if (p.extraInstructions !== undefined && (typeof p.extraInstructions !== "string" || p.extraInstructions.length > 1000))
    return "profile.extraInstructions mətn olmalıdır (maksimum 1000 simvol)";
  if (p.mode !== undefined && !MODES.includes(p.mode)) return "profile.mode listings, support və ya both olmalıdır";
  if (p.fallbackMessage !== undefined && (typeof p.fallbackMessage !== "string" || p.fallbackMessage.length > 300)) return "profile.fallbackMessage mətn olmalıdır (maksimum 300 simvol)";
  if (p.maxResults !== undefined && !Number.isFinite(Number(p.maxResults))) return "profile.maxResults rəqəm olmalıdır";
  if (p.logQueries !== undefined && typeof p.logQueries !== "boolean") return "profile.logQueries true və ya false olmalıdır";
  if (p.generalKnowledge !== undefined && typeof p.generalKnowledge !== "boolean") return "profile.generalKnowledge true və ya false olmalıdır";
  return null;
}

function mergeProfile(prev = {}, input = {}, extra = {}) {
  const next = { ...prev, ...extra };
  if (input.language !== undefined) next.language = input.language;
  if (input.tone !== undefined) next.tone = input.tone.trim();
  if (input.extraInstructions !== undefined) next.extraInstructions = input.extraInstructions.trim();
  if (input.mode !== undefined) next.mode = input.mode;
  if (input.fallbackMessage !== undefined) next.fallbackMessage = input.fallbackMessage.trim();
  if (input.maxResults !== undefined) next.maxResults = Math.min(Math.max(Math.round(Number(input.maxResults)), 1), 10);
  if (input.logQueries !== undefined) next.logQueries = input.logQueries;
  if (input.generalKnowledge !== undefined) next.generalKnowledge = input.generalKnowledge;
  next.language ??= "az";
  next.mode ??= "listings";
  next.maxResults ??= 5;
  return next;
}

function prepareSource(source, apiSecret, previousSource) {
  const copy = structuredClone(source);
  if (copy.auth) {
    delete copy.auth.value;
    delete copy.auth.secret;
    if (apiSecret && SECRET_AUTH.includes(copy.auth.type)) {
      copy.auth.encryptedValue = encryptSecret(apiSecret);
      delete copy.auth.valueEnv;
    } else if (SECRET_AUTH.includes(copy.auth.type) && previousSource?.auth?.encryptedValue) {
      copy.auth.encryptedValue = previousSource.auth.encryptedValue; // yeniləmədə köhnə açar saxlanır
    }
  }
  return copy;
}

// Konfiqurasiya ilə müştərinin API-sinə real sorğu göndərir.
async function probe(source, testFilters) {
  const repo = createRestRepo({ tenantId: "config-test", source });
  const result = await repo.searchWithDebug(sanitizeFilters(testFilters ?? {}, { maxResults: 3, schema: repo.schema }));
  return {
    supportedFilters: repo.supportedFilters,
    filters: repo.schema.args.map(({ name, kind, description }) => ({ name, kind, description })),
    sampleCount: result.listings.length,
    sampleListings: result.listings,
    debug: { request: result.debug.request, cached: result.debug.cached, rawCount: result.debug.rawCount, note: result.debug.note, dropped: result.debug.dropped },
  };
}

// Aktivləşdirmə/yeniləmə üçün: heç olmasa 1 elan düzgün oxunmalıdır.
function probeProblem(r) {
  if (r.sampleCount > 0) return null;
  if (r.debug.rawCount > 0)
    return { code: "MAPPING_FAILED", error: `Elanlar oxundu, amma sahə xəritələməsi səhvdir: ${[...new Set(r.debug.dropped ?? [])].slice(0, 3).join(", ")}` };
  return { code: "NO_LISTINGS", error: "Elan API-sindən heç bir elan gəlmədi. Xəritələməni yoxlaya bilmək üçün saytda ən azı bir elan olmalıdır." };
}

export function createApp({ adviseFn = advise, kbFn = answerFromKb } = {}) {
  const app = express();
  app.disable("x-powered-by");
  const smallJson = express.json({ limit: "100kb" });
  app.use((req, res, next) => (req.path.endsWith("/kb/files") ? next() : smallJson(req, res, next))); // fayl yükləmə öz limitini özü qoyur

  app.get("/health", (req, res) => res.json({ ok: true }));

  // ---------- Servis auth: yalnız portal backend-i bu tokenlə çağırır ----------
  const serviceAuth = (req, res, next) => {
    const expected = process.env.SERVICE_TOKEN || process.env.ONBOARDING_ADMIN_TOKEN || "";
    const supplied = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!expected || !supplied) return res.status(401).json({ error: "Servis icazəsi yoxdur" });
    const a = Buffer.from(expected), b = Buffer.from(supplied);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Servis icazəsi yoxdur" });
    next();
  };

  // :tenantId yalnız portal vasitəsilə yaradılmış müştəri ola bilər (dev tenant-lar yox).
  const customerTenant = (req, res, next) => {
    const id = req.params.tenantId;
    const tenant = listCustomerTenants().some((t) => t.tenantId === id) ? getTenant(id) : null;
    if (!tenant) return res.status(404).json({ error: "Müştəri tapılmadı" });
    req.tenant = tenant;
    next();
  };

  app.get("/v1/service/usage/summary", serviceAuth, async (_req, res) => res.json(await getUsageSummary()));
  app.post("/v1/service/config/test", serviceAuth, async (req, res) => {
    const body = req.body ?? {};
    const error = validateConfig(body);
    if (error) return res.status(400).json({ error });
    try {
      res.json({ ok: true, ...(await probe(prepareSource(body.source, body.apiSecret), body.testFilters)) });
    } catch (err) {
      res.status(422).json({ ok: false, error: err.message, code: err.code ?? "CONFIG_TEST_FAILED" });
    }
  });

  app.post("/v1/service/tenants", serviceAuth, async (req, res) => {
    const body = req.body ?? {};
    const error = validateConfig(body);
    if (error) return res.status(400).json({ error });
    const supportOnly = body.profile?.mode === "support";
    let source, checked = { sampleCount: 0, sampleListings: [] };
    if (!supportOnly) {
      try {
        source = prepareSource(body.source, body.apiSecret);
        checked = await probe(source, body.testFilters);
      } catch (err) {
        return res.status(422).json({ ok: false, error: err.message, code: err.code ?? "CONFIG_TEST_FAILED" });
      }
      const problem = probeProblem(checked);
      if (problem) return res.status(422).json({ ok: false, ...problem, debug: checked.debug });
    }

    const tenantId = `tenant-${crypto.randomBytes(8).toString("hex")}`;
    const apiKey = newKey();
    const profile = mergeProfile({}, body.profile ?? {}, { businessName: body.businessName.trim(), domain: body.domain.trim() });
    const tenant = {
      tenantId, apiKeyHash: hashKey(apiKey), language: profile.language,
      limits: {
        monthlyRequests: Number(process.env.DEFAULT_MONTHLY_REQUESTS) || 0, // 0 = aylıq sorğu limiti yoxdur: xərci balans məhdudlaşdırır
        ratePerMinute: Number(process.env.DEFAULT_RATE_PER_MINUTE) || 20,
      },
      createdAt: new Date().toISOString(), profile, ...(source && { source }),
    };
    try { await addCustomerTenant(tenant); refreshTenants(); }
    catch (err) { return res.status(500).json({ error: "Müştəri aktivləşdirilə bilmədi", detail: err.message }); }
    // API açarı yalnız bir dəfə qaytarılır; DB-də yalnız hash-i qalır.
    res.status(201).json({ ok: true, tenantId, apiKey, sampleCount: checked.sampleCount, sampleListings: checked.sampleListings, limits: tenant.limits });
  });

  app.put("/v1/service/tenants/:tenantId/config", serviceAuth, customerTenant, async (req, res) => {
    const body = req.body ?? {};
    const old = req.tenant;
    const error = validateConfig(body, { secretAlreadyStored: !!old.source?.auth?.encryptedValue });
    if (error) return res.status(400).json({ error });
    const supportOnly = body.profile?.mode === "support";
    let source, checked = { sampleCount: 0, sampleListings: [] };
    if (!supportOnly) {
      try {
        source = prepareSource(body.source, body.apiSecret, old.source);
        checked = await probe(source, body.testFilters);
      } catch (err) {
        return res.status(422).json({ ok: false, error: err.message, code: err.code ?? "CONFIG_TEST_FAILED" });
      }
      const problem = probeProblem(checked);
      if (problem) return res.status(422).json({ ok: false, ...problem, debug: checked.debug });
    }

    const profile = mergeProfile(old.profile, body.profile ?? {}, { businessName: body.businessName.trim(), domain: body.domain.trim() });
    await updateCustomerTenant(old.tenantId, (t) => {
      const { source: _old, ...rest } = t;
      return { ...rest, language: profile.language, profile, ...(source && { source }), configUpdatedAt: new Date().toISOString() };
    });
    refreshTenants();
    dropRepo(old.tenantId);
    res.json({ ok: true, sampleCount: checked.sampleCount, sampleListings: checked.sampleListings });
  });

  app.patch("/v1/service/tenants/:tenantId/profile", serviceAuth, customerTenant, async (req, res) => {
    const input = req.body ?? {};
    const error = validateProfile(input);
    if (error) return res.status(400).json({ error });
    if ((input.mode === "listings" || input.mode === "both") && !req.tenant.source)
      return res.status(400).json({ error: "Elan mənbəyi qoşulmayıb: əvvəlcə elan API-sini qoşun", code: "NO_SOURCE" });
    const profile = mergeProfile(req.tenant.profile, input);
    await updateCustomerTenant(req.tenant.tenantId, (t) => ({ ...t, language: profile.language, profile }));
    refreshTenants();
    res.json({ ok: true, profile });
  });

  // Köhnə açar dərhal etibarsız olur, yenisi yalnız bir dəfə qaytarılır.
  app.post("/v1/service/tenants/:tenantId/rotate-key", serviceAuth, customerTenant, async (req, res) => {
    const apiKey = newKey();
    await updateCustomerTenant(req.tenant.tenantId, (t) => ({ ...t, apiKeyHash: hashKey(apiKey), keyRotatedAt: new Date().toISOString() }));
    refreshTenants();
    res.json({ ok: true, tenantId: req.tenant.tenantId, apiKey });
  });

  // Müştərini tamamilə silir (açar dərhal etibarsız olur, konfiqurasiya və sayğac silinir). Geri qaytarmaq olmur.
  app.delete("/v1/service/tenants/:tenantId", serviceAuth, customerTenant, async (req, res) => {
    const id = req.tenant.tenantId;
    await removeCustomerTenant(id);
    refreshTenants();
    dropRepo(id);
    await deleteTenantUsage(id);
    await clearQueries(id);
    await deleteTenantKb(id);
    await deleteTenantBilling(id);
    res.json({ ok: true });
  });

  // ---------- Müştəri API-si (açarla) ----------
  // API açarı: "Authorization: Bearer <açar>" (və ya X-Api-Key). Açar yalnız müştərinin SERVERİNDƏ saxlanmalıdır.
  const auth = (req, res, next) => {
    const h = req.get("authorization") || "";
    const key = h.startsWith("Bearer ") ? h.slice(7).trim() : req.get("x-api-key");
    const tenant = getTenantByKey(key);
    if (!tenant) return res.status(401).json({ error: "API açarı yanlışdır və ya yoxdur" });
    req.tenant = tenant;
    next();
  };
  const gateOr429 = async (req, res, opts) => {
    // Balans (pulsuz məbləğ + yüklənmiş pul) bitibsə sorğu AI-a getmir; AI-sız əməliyyatlar (countMonthly: false) pulsuzdur
    if (opts?.countMonthly !== false) {
      const funds = await canSpend(req.tenant);
      if (!funds.ok) { res.status(402).json({ error: funds.message, code: funds.code }); return false; }
    }
    // Portal (vidjet) trafikində limiti portal özü müştərinin ayarına görə tətbiq edir; sayt üzrə dəqiqəlik tavan real ziyarətçiləri bloklamasın
    const gate = await checkAndCount(req.tenant, { ...opts, skipRate: Boolean(req.viaPortal) });
    if (gate.ok) return true;
    if (gate.retryAfter) res.set("Retry-After", String(gate.retryAfter));
    res.status(429).json({ error: gate.message, code: gate.code });
    return false;
  };

  async function chat(req, res) {
    const { message, history, sid } = req.body ?? {};
    if (typeof message !== "string" || !message.trim() || message.length > 500)
      return res.status(400).json({ error: "message düzgün deyil (1-500 simvol)" });
    if (!(await gateOr429(req, res))) return;
    try {
      const hist = Array.isArray(history) ? history : [];
      const support = req.tenant.profile?.mode === "support";
      const r = support
        ? await kbFn({ tenant: req.tenant, message: message.trim(), history: hist })
        : await adviseFn({ tenant: req.tenant, repo: await getRepo(req.tenant), message: message.trim(), history: hist });
      await addTokens(req.tenant, r.tokens);
      let bill;
      try { bill = await charge(req.tenant, { costUsd: r.costUsd ?? 0, tokens: r.tokens ?? 0 }); }
      catch (e) { console.error(`[billing] ${req.tenant.tenantId}: xərc yazıla bilmədi:`, e.message); } // cavab itməsin
      // results: >0 elan, 0 axtarış aparıldı amma tapılmadı, -1 axtarışsız cavab (ümumi sual və s.), -2 operatora yönləndirildi
      const searched = r.searched ?? true;
      const results = support ? (r.unanswered ? 0 : 1) : !searched ? (r.unanswered ? -2 : -1) : (r.listings?.length ?? 0);
      if (!req.skipQueryLog) await recordQuery(req.tenant, { message: message.trim(), results, tokens: r.tokens, cached: r.cached, costAzn: bill?.billedAzn, sid, answer: r.answer });
      res.json({ answer: r.answer, listings: r.listings ?? [], ...(r.sources && { sources: r.sources }), ...(r.unanswered && { unanswered: true }), usage: { tokens: r.tokens },
        // Balans vəziyyəti yalnız portala verilir (müştərinin açıq API-sində görünmür)
        ...(req.viaPortal && bill && { billing: { state: bill.state, balanceAzn: bill.balanceAzn, billedAzn: bill.billedAzn, ...(bill.notify && { notify: bill.notify }) } }) });
    } catch (err) {
      console.error(`[chat] ${req.tenant.tenantId}:`, err.status ?? "", err.message);
      if (!req.skipQueryLog) await recordQuery(req.tenant, { message: message.trim(), error: true, sid });
      if ([429, 500, 503].includes(err.status)) return res.status(503).json({ error: "Xidmət müvəqqəti yüklüdür, bir azdan yenə cəhd edin" });
      res.status(500).json({ error: "Xəta baş verdi" });
    }
  }

  // AI olmadan axtarış (test və debug üçün; aylıq sorğu limitinə yazılmır)
  async function listings(req, res) {
    if (!req.tenant.source) return res.status(400).json({ error: "Bu hesabın elan mənbəyi yoxdur", code: "NO_SOURCE" });
    if (!(await gateOr429(req, res, { countMonthly: false }))) return;
    try {
      const repo = await getRepo(req.tenant);
      const found = await repo.search(sanitizeFilters(req.query, { maxResults: req.tenant.profile?.maxResults, schema: repo.schema }));
      res.json({ count: found.length, listings: found });
    } catch (err) {
      console.error(`[listings] ${req.tenant.tenantId}:`, err.code ?? "", err.message);
      res.status(502).json({ error: "Data mənbəyi əlçatan deyil", code: err.code });
    }
  }

  const usage = async (req, res) => res.json(await getUsage(req.tenant));

  app.post("/v1/chat", auth, chat);
  app.get("/v1/listings", auth, listings);
  app.get("/v1/usage", auth, usage);

  // Portal eyni əməliyyatları müştərinin açarını bilmədən, tenantId ilə edir.
  // Portalın "Sınaq söhbəti" (test: true) sorğu qeydinə yazılmır
  app.post("/v1/service/tenants/:tenantId/chat", serviceAuth, customerTenant, (req, res) => { req.skipQueryLog = req.body?.test === true; req.viaPortal = true; return chat(req, res); });
  app.get("/v1/service/tenants/:tenantId/queries", serviceAuth, customerTenant, async (req, res) => {
    const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    res.json({ enabled: req.tenant.profile?.logQueries !== false, retentionDays: Number(process.env.QUERY_RETENTION_DAYS) || 90,
      ...(await listQueries(req.tenant.tenantId, { before: String(req.query.before ?? "").slice(0, 80), limit: n(req.query.limit, 30), noResults: req.query.noResults === "1", q: String(req.query.q ?? "").slice(0, 100), days: Math.min(n(req.query.days, 30), 90) })) });
  });
  app.get("/v1/service/tenants/:tenantId/conversations", serviceAuth, customerTenant, async (req, res) => {
    const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    res.json({ enabled: req.tenant.profile?.logQueries !== false, ...(await listConversations(req.tenant.tenantId, { before: String(req.query.before ?? "").slice(0, 40), limit: n(req.query.limit, 30), days: Math.min(n(req.query.days, 30), 90) })) });
  });
  app.get("/v1/service/tenants/:tenantId/conversations/:sid", serviceAuth, customerTenant, async (req, res) => {
    const c = await getConversation(req.tenant.tenantId, req.params.sid);
    if (!c) return res.status(404).json({ error: "Söhbət tapılmadı" });
    res.json(c);
  });
  app.get("/v1/service/tenants/:tenantId/queries/stats", serviceAuth, customerTenant, async (req, res) => {
    const d = Number(req.query.days);
    res.json({ enabled: req.tenant.profile?.logQueries !== false, ...(await queryStats(req.tenant.tenantId, { days: Number.isFinite(d) && d > 0 ? Math.min(d, 90) : 30 })) });
  });
  app.delete("/v1/service/tenants/:tenantId/queries", serviceAuth, customerTenant, async (req, res) => { await clearQueries(req.tenant.tenantId); res.json({ ok: true }); });
  app.get("/v1/service/tenants/:tenantId/listings", serviceAuth, customerTenant, listings);
  app.get("/v1/service/tenants/:tenantId/usage", serviceAuth, customerTenant, usage);

  registerKbRoutes(app, { serviceAuth, customerTenant });
  registerBillingRoutes(app, { serviceAuth, customerTenant });

  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON düzgün deyil" });
    console.error(err);
    res.status(500).json({ error: "Xəta baş verdi" });
  });
  return app;
}
