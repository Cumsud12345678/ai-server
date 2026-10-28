// Əməliyyatlar (Actions): çat saytın öz API-sində YAZMA əməliyyatı icra edir (sifarişi ləğv et, bilet yarat, görüş rezerv et, lead göndər).
//
// TƏHLÜKƏSİZLİK MODELİ (hamısı kodla məcbur edilir, modelin "yaxşı davranmasına" güvənilmir)
//  1. Heç bir əməliyyat modelin çağırışı ilə İCRA OLUNMUR. Model yalnız təklif yaradır; server parametrləri saxlayır və istifadəçiyə
//     "nə olacaq" kartını göstərir. İcra yalnız istifadəçinin ayrıca təsdiqindən sonra, ayrı sorğu ilə baş verir (birdəfəlik, 10 dəq).
//  2. Yalnız sahibin bəyan etdiyi əməliyyatlar və parametrlər var; hər parametr tip, uzunluq, enum, min/max ilə yoxlanır, artıqlar atılır.
//  3. İstifadəçi ID-si (userId) yalnız saytın imzaladığı identity tokendən gəlir; modelin parametri deyil. requireIdentity=true olanda
//     təklif də, təsdiq də eyni yoxlanmış istifadəçi tərəfindən olmalıdır.
//  4. Təsdiq kartı serverdə qurulur: parametr dəyərləri HƏMİŞƏ göstərilir (şablon onları gizlədə bilməz).
//  5. Sorğu SSRF-dən qorunur (DNS pinləmə, daxili şəbəkə qadağası, redirect yoxdur), imzalanır (HMAC) və heç vaxt avtomatik təkrarlanmır;
//     cavab gəlməsə nəticə "bəlli deyil" kimi bildirilir, uydurma uğur deyilir.
//  6. Limitlər: təklif (söhbət/istifadəçi başına), icra (istifadəçi başına saatda, sayt üzrə gündə); hər addım jurnala yazılır.
//  7. İcra nəticəsi modelə QAYTARILMIR (prompt injection yolu bağlıdır): istifadəçi mesajı sahibin şablonundan və ya təmizlənmiş xəta mətnindən gəlir.
import crypto from "node:crypto";
import { Type } from "@google/genai";
import { ConnectorError } from "../connectors/safeFetch.js";
import { stripHtml } from "../connectors/mapper.js";
import { decryptSecret, encryptSecret } from "../tenants/secretCrypto.js";
import { safeRequest } from "./http.js";
import { recordAction } from "./log.js";
import { createPending, dropPending, getPending, pendingTtlS } from "./pending.js";

export const MAX_ACTIONS = 10, MAX_PARAMS = 8;
const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;
const PARAM_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/;
const PATH_RE = /^\/[\w\-./{}%:@,]*$/;
const METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const TYPES = ["string", "number", "integer", "boolean", "enum"];
const SUB_RE = /^[\w.@:+-]{1,100}$/;
const PER_REQUEST = 2;
const PROPOSE_LIMIT = () => Number(process.env.ACTION_PROPOSALS_PER_10MIN) || 6;
const EXEC_LIMIT = () => Number(process.env.ACTION_EXECUTIONS_PER_HOUR) || 5;
const SITE_DAILY = () => Number(process.env.ACTION_SITE_DAILY) || 500;

export const TOOL_PREFIX = "act_";
export const isActionTool = (name) => typeof name === "string" && name.startsWith(TOOL_PREFIX);

const ctrl = /[\u0000-\u001f\u007f]/g;
const placeholders = (s) => [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
const fill = (tpl, values) => String(tpl).replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => (k in values ? String(values[k]) : "")).replace(/\s+/g, " ").trim();

// ---------- konfiqurasiya ----------
/** Xəta mətni və ya null. input: { baseUrl, auth?, items } (sirr sahələri daxil deyil) */
export function validateActions(input, { secretAlreadyStored = false, apiSecret } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "actions obyekt olmalıdır";
  const { baseUrl, auth, items } = input;
  const local = process.env.ALLOW_LOCAL_CONNECTORS === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(String(baseUrl));
  if (typeof baseUrl !== "string" || baseUrl.length > 300 || (!/^https:\/\//i.test(baseUrl) && !local)) return "baseUrl HTTPS ünvanı olmalıdır";
  if (auth !== undefined) {
    if (!auth || typeof auth !== "object" || !["none", "header", "bearer"].includes(auth.type ?? "none")) return "auth.type none, header və ya bearer olmalıdır";
    if (auth.value || auth.secret || auth.encryptedValue) return "Açarı auth daxilində göndərməyin; apiSecret sahəsindən istifadə edin";
    if (auth.type === "header" && !/^[A-Za-z0-9_-]{1,60}$/.test(String(auth.name ?? ""))) return "auth.name düzgün deyil";
    if (["header", "bearer"].includes(auth.type) && !apiSecret && !secretAlreadyStored) return "API autentifikasiyası üçün apiSecret tələb olunur";
  }
  if (!Array.isArray(items) || !items.length) return "Ən azı bir əməliyyat təyin edilməlidir";
  if (items.length > MAX_ACTIONS) return `Ən çox ${MAX_ACTIONS} əməliyyat ola bilər`;
  const seen = new Set();
  for (const [i, a] of items.entries()) {
    const w = `items[${i}]`;
    if (!a || typeof a !== "object" || Array.isArray(a)) return `${w} obyekt olmalıdır`;
    if (typeof a.key !== "string" || !KEY_RE.test(a.key)) return `${w}.key kiçik latın hərfləri, rəqəm və _ olmalıdır (məs. cancel_order)`;
    if (seen.has(a.key)) return `${w}.key təkrarlanır: ${a.key}`;
    seen.add(a.key);
    if (typeof a.title !== "string" || !a.title.trim() || a.title.length > 60) return `${w}.title tələb olunur (maksimum 60 simvol)`;
    if (typeof a.description !== "string" || a.description.trim().length < 10 || a.description.length > 300) return `${w}.description 10-300 simvol olmalıdır: AI bu əməliyyatı nə vaxt təklif edəcəyini bundan bilir`;
    if (!METHODS.includes(a.method)) return `${w}.method ${METHODS.join(", ")} olmalıdır (oxuma üçün "Şəxsi məlumat" bölməsindən istifadə edin)`;
    if (typeof a.path !== "string" || !PATH_RE.test(a.path) || a.path.length > 300 || a.path.includes("..")) return `${w}.path "/" ilə başlamalı və düzgün olmalıdır`;
    if (a.requireIdentity !== undefined && typeof a.requireIdentity !== "boolean") return `${w}.requireIdentity true/false olmalıdır`;
    if (a.enabled !== undefined && typeof a.enabled !== "boolean") return `${w}.enabled true/false olmalıdır`;
    const params = a.params ?? [];
    if (!Array.isArray(params) || params.length > MAX_PARAMS) return `${w}.params ən çox ${MAX_PARAMS} parametr ola bilər`;
    const names = new Set();
    for (const [j, p] of params.entries()) {
      const pw = `${w}.params[${j}]`;
      if (!p || typeof p !== "object") return `${pw} obyekt olmalıdır`;
      if (typeof p.name !== "string" || !PARAM_RE.test(p.name) || p.name === "userId") return `${pw}.name latın hərfləri, rəqəm və _ olmalıdır ("userId" ola bilməz)`;
      if (names.has(p.name)) return `${pw}.name təkrarlanır: ${p.name}`;
      names.add(p.name);
      if (!TYPES.includes(p.type)) return `${pw}.type ${TYPES.join(", ")} olmalıdır`;
      if (typeof p.description !== "string" || !p.description.trim() || p.description.length > 200) return `${pw}.description tələb olunur (maksimum 200 simvol)`;
      if (p.required !== undefined && typeof p.required !== "boolean") return `${pw}.required true/false olmalıdır`;
      if (p.type === "enum" && (!Array.isArray(p.enum) || p.enum.length < 2 || p.enum.length > 20 || p.enum.some((v) => typeof v !== "string" || !v.trim() || v.length > 60))) return `${pw}.enum 2-20 mətn dəyəri olmalıdır`;
      if (p.maxLength !== undefined && !(Number.isInteger(p.maxLength) && p.maxLength >= 1 && p.maxLength <= 500)) return `${pw}.maxLength 1-500 olmalıdır`;
      for (const k of ["min", "max"]) if (p[k] !== undefined && !Number.isFinite(p[k])) return `${pw}.${k} ədəd olmalıdır`;
    }
    for (const k of ["confirmText", "successMessage"]) if (a[k] !== undefined && (typeof a[k] !== "string" || a[k].length > 200)) return `${w}.${k} mətn olmalıdır (maksimum 200 simvol)`;
    const allowed = new Set([...names, "userId"]);
    for (const ph of [...placeholders(a.path), ...placeholders(a.confirmText ?? ""), ...placeholders(a.successMessage ?? "")]) if (!allowed.has(ph)) return `${w}: {${ph}} yer tutucusu parametr kimi bəyan olunmayıb`;
    if (placeholders(a.path).includes("userId") && a.requireIdentity !== true) return `${w}: path-də {userId} üçün requireIdentity true olmalıdır`;
    if (placeholders(a.confirmText ?? "").includes("userId") || placeholders(a.successMessage ?? "").includes("userId")) return `${w}: mesajlarda {userId} olmaz`;
  }
  return null;
}

export const newSigningSecret = () => `casig_${crypto.randomBytes(32).toString("hex")}`;

/** Saxlanacaq forma: açar şifrələnir; imza açarı və əvvəlki sirr qorunur. */
export function prepareActions(input, apiSecret, previous) {
  const out = { baseUrl: input.baseUrl.replace(/\/+$/, "") };
  const a = input.auth;
  if (a && a.type !== "none") {
    out.auth = { type: a.type, ...(a.name && { name: a.name }) };
    if (apiSecret) out.auth.encryptedValue = encryptSecret(apiSecret);
    else if (previous?.auth?.encryptedValue) out.auth.encryptedValue = previous.auth.encryptedValue;
  }
  out.items = structuredClone(input.items).map((x) => ({
    key: x.key, title: x.title.trim(), description: x.description.trim(), method: x.method, path: x.path,
    params: (x.params ?? []).map((p) => ({ name: p.name, type: p.type, description: p.description.trim(), required: p.required === true, ...(p.type === "enum" && { enum: p.enum.map((v) => v.trim()) }),
      ...(p.maxLength !== undefined && { maxLength: p.maxLength }), ...(p.min !== undefined && { min: p.min }), ...(p.max !== undefined && { max: p.max }) })),
    ...(x.confirmText?.trim() && { confirmText: x.confirmText.trim() }), ...(x.successMessage?.trim() && { successMessage: x.successMessage.trim() }),
    requireIdentity: x.requireIdentity === true, enabled: x.enabled !== false,
  }));
  if (previous?.signingSecretEnc) { out.signingSecretEnc = previous.signingSecretEnc; out.signingCreatedAt = previous.signingCreatedAt; }
  return out;
}

/** Panelə qaytarılan görünüş: heç bir sirr yoxdur. */
export function actionsView(tenant) {
  const d = tenant.actions;
  if (!d) return { configured: false, items: [], signing: { configured: false } };
  const { auth, signingSecretEnc, signingCreatedAt, ...rest } = d;
  return { configured: true, ...rest, items: Array.isArray(rest.items) ? rest.items : [],
    ...(auth && { auth: { type: auth.type, ...(auth.name && { name: auth.name }), hasSecret: Boolean(auth.encryptedValue) } }),
    signing: { configured: Boolean(signingSecretEnc), createdAt: signingCreatedAt ?? null },
    identityReady: Boolean(tenant.privateData?.identity?.secretEnc) };
}

const identityReady = (tenant) => Boolean(tenant.privateData?.identity?.secretEnc);
const liveItems = (tenant, identity) => (tenant.actions?.items ?? []).filter((a) => a.enabled !== false && (!a.requireIdentity || (identity?.sub && identityReady(tenant))));
/** Əməliyyat alətləri varmı (keşləməni söndürmək üçün) */
export const hasActions = (tenant) => Boolean(tenant.actions?.items?.some((a) => a.enabled !== false));

// ---------- parametr doğrulama ----------
/** Qaytarır: { values } və ya { error }. Bəyan olunmayan açarlar atılır. */
export function coerceParams(spec, args) {
  const values = {};
  for (const p of spec.params ?? []) {
    let v = args?.[p.name];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
      if (p.required) return { error: `"${p.name}" tələb olunur: istifadəçidən soruş` };
      continue;
    }
    if (p.type === "string") {
      if (typeof v === "object") return { error: `"${p.name}" mətn olmalıdır` };
      v = String(v).replace(ctrl, " ").replace(/\s+/g, " ").trim();
      if (!v) { if (p.required) return { error: `"${p.name}" tələb olunur` }; continue; }
      if (v.length > (p.maxLength ?? 200)) return { error: `"${p.name}" çox uzundur (maksimum ${p.maxLength ?? 200} simvol)` };
    } else if (p.type === "number" || p.type === "integer") {
      const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
      if (!Number.isFinite(n) || (p.type === "integer" && !Number.isInteger(n))) return { error: `"${p.name}" ${p.type === "integer" ? "tam ədəd" : "ədəd"} olmalıdır` };
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) return { error: `"${p.name}" ${p.min ?? ""}..${p.max ?? ""} aralığında olmalıdır` };
      v = n;
    } else if (p.type === "boolean") {
      if (v === true || v === "true") v = true; else if (v === false || v === "false") v = false; else return { error: `"${p.name}" bəli/xeyr olmalıdır` };
    } else if (p.type === "enum") {
      const hit = (p.enum ?? []).find((e) => e.toLowerCase() === String(v).trim().toLowerCase());
      if (!hit) return { error: `"${p.name}" yalnız bunlardan biri ola bilər: ${(p.enum ?? []).join(", ")}` };
      v = hit;
    }
    values[p.name] = v;
  }
  return { values };
}

/** Təsdiq kartı (serverdə qurulur): başlıq + sahibin şablonu + HƏMİŞƏ bütün parametr dəyərləri. */
export function confirmCard(spec, values, subject) {
  const shown = (v) => (typeof v === "boolean" ? (v ? "bəli" : "xeyr") : String(v).slice(0, 120));
  const vals = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, shown(v)]));
  const summary = spec.confirmText ? fill(spec.confirmText, vals) : "";
  const details = (spec.params ?? []).filter((p) => p.name in values).map((p) => ({ k: p.name, v: vals[p.name] }));
  return { title: spec.title, summary: summary.slice(0, 300), details, ...(spec.requireIdentity && subject && { account: true }) };
}

// ---------- alət (modelə verilən) ----------
export function actionDeclarations(tenant, { identity = null, sid = null } = {}) {
  if (!sid) return []; // təsdiqi söhbətə bağlamaq mümkün deyil
  return liveItems(tenant, identity).map((a) => {
    const properties = {};
    for (const p of a.params ?? []) {
      const base = { description: p.description };
      properties[p.name] = p.type === "enum" ? { type: Type.STRING, enum: p.enum, ...base }
        : p.type === "number" ? { type: Type.NUMBER, ...base } : p.type === "integer" ? { type: Type.INTEGER, ...base } : p.type === "boolean" ? { type: Type.BOOLEAN, ...base } : { type: Type.STRING, ...base };
    }
    return {
      name: `${TOOL_PREFIX}${a.key}`,
      description: `${a.description} DİQQƏT: bu əməliyyat dərhal icra OLUNMUR; istifadəçiyə təsdiq kartı göstərilir. Yalnız istifadəçi bunu açıq şəkildə istəyəndə çağır, parametrləri ondan soruş, özün uydurma.`,
      parameters: { type: Type.OBJECT, properties, required: (a.params ?? []).filter((p) => p.required).map((p) => p.name) },
    };
  });
}

export function actionsPrompt(tenant, identity) {
  const list = liveItems(tenant, identity);
  if (!list.length) return "";
  return `\nƏMƏLİYYATLAR: ${list.map((a) => a.title.toLowerCase()).join(", ")}. İstifadəçi bunlardan birini AÇIQ istəyəndə uyğun act_* alətini çağır; lazım olan məlumatı (nömrə, tarix və s.) əvvəl ondan soruş, uydurma. Alət əməliyyatı icra etmir: istifadəçiyə təsdiq kartı göstərilir. Ona görə "icra etdim/ləğv etdim/rezerv etdim" DEMƏ; yalnız qısa de ki, təsdiq kartını yoxlayıb təsdiq etsin. Əməliyyat siyahısında olmayan işi (geri ödəniş, qiymət endirimi və s.) etmək olmaz: bunu operatora yönləndir.`;
}

const hits = new Map(); // limit açarı -> [vaxtlar]
function allow(key, max, windowMs, now = Date.now()) {
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 8000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return true;
}
export const resetActionLimits = () => hits.clear();

/** Model alətə çağırış edəndə: yalnız TƏKLİF yaradır, heç nə icra etmir. ctx.pendingAction qoyur. */
export function runActionTool(tenant, identity, name, args, ctx, { sid = null, channel = null } = {}) {
  ctx.private = true; // keşə düşməsin
  const spec = liveItems(tenant, identity).find((a) => `${TOOL_PREFIX}${a.key}` === name);
  if (!spec) return { error: "Bu əməliyyat mövcud deyil və ya hesaba daxil olmaq tələb olunur." };
  if (!sid) return { error: "Əməliyyat bu söhbətdə mümkün deyil." };
  ctx.actionCalls = (ctx.actionCalls ?? 0) + 1;
  if (ctx.actionCalls > PER_REQUEST) return { error: "Bir mesajda çox əməliyyat təklif olundu. Bir-bir həll edək." };
  const subject = identity?.sub ?? null;
  if (!allow(`p|${tenant.tenantId}|${subject ?? sid}`, PROPOLIMIT(), 10 * 60_000)) return { error: "Çox tez-tez əməliyyat təklif olundu, bir neçə dəqiqə sonra yenidən cəhd edin." };
  const { values, error } = coerceParams(spec, args);
  if (error) return { error };
  const card = confirmCard(spec, values, subject);
  const p = createPending({ tenantId: tenant.tenantId, sid, key: spec.key, values, subject, channel, card });
  ctx.pendingAction = { id: p.id, ...card, expiresInS: pendingTtlS() };
  return { status: "awaiting_user_confirmation", note: "Əməliyyat İCRA OLUNMAYIB. İstifadəçiyə təsdiq kartı göstərilir. Yalnız qısa de ki, kartı yoxlayıb təsdiq etsin; icra olunmuş kimi cavab vermə." };
}
const PROPOLIMIT = PROPOSE_LIMIT;

// ---------- icra ----------
const signingSecretOf = (tenant) => { try { return tenant.actions?.signingSecretEnc ? decryptSecret(tenant.actions.signingSecretEnc) : null; } catch { return null; } };

/** İcra olunacaq sorğunun qurulması (preview üçün də istifadə olunur). Sirr qaytarmır, yalnız imza üçün daxildə istifadə edir. */
export function buildRequest(tenant, spec, values, { subject = null, idempotencyKey = "preview", test = false, now = Date.now() } = {}) {
  const d = tenant.actions;
  const body = { ...values, ...(spec.requireIdentity && subject && { userId: subject }) };
  let path = spec.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => encodeURIComponent(String(k === "userId" ? subject ?? "" : values[k] ?? "")));
  const url = new URL(path, `${d.baseUrl}/`);
  if (url.origin !== new URL(d.baseUrl).origin) throw new ConnectorError("Yol icazəsiz ünvana çıxır", "UNSAFE_URL");
  let payload;
  if (spec.method === "DELETE") {
    for (const [k, v] of Object.entries(body)) if (!spec.path.includes(`{${k}}`)) url.searchParams.set(k, String(v));
  } else payload = JSON.stringify(body);
  const ts = Math.floor(now / 1000);
  const headers = { "content-type": "application/json", accept: "application/json", "user-agent": "ChatbotActions/1.0", "x-chatbot-action": spec.key, "x-chatbot-timestamp": String(ts), "x-chatbot-idempotency-key": idempotencyKey, ...(test && { "x-chatbot-test": "1" }) };
  const sig = signingSecretOf(tenant);
  if (sig) headers["x-chatbot-signature"] = `sha256=${crypto.createHmac("sha256", sig).update(`${ts}.${spec.method}.${url.pathname}${url.search}.${payload ?? ""}`).digest("hex")}`;
  return { method: spec.method, url, headers, body: payload };
}

const authHeaders = (tenant) => {
  const a = tenant.actions?.auth;
  if (!a || a.type === "none") return {};
  const secret = a.encryptedValue ? decryptSecret(a.encryptedValue) : null;
  if (!secret) throw new ConnectorError("API açarı konfiqurasiya edilməyib", "NO_SECRET");
  return a.type === "header" ? { [a.name]: secret } : { authorization: `Bearer ${secret}` };
};

const apiMessage = (text) => {
  try {
    const j = JSON.parse(text);
    const m = [j?.message, j?.error, j?.detail, j?.error?.message].find((x) => typeof x === "string" && x.trim());
    return m ? stripHtml(m).replace(ctrl, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  } catch { return ""; }
};

/** Sorğunu göndərir. Qaytarır: { status: done|failed|unknown, httpStatus?, message, ms } — heç vaxt təkrar göndərmir. */
export async function execute(tenant, spec, values, { subject, idempotencyKey, test = false } = {}) {
  const t0 = Date.now();
  let req;
  try { req = buildRequest(tenant, spec, values, { subject, idempotencyKey, test }); req.headers = { ...authHeaders(tenant), ...req.headers }; }
  catch (e) { return { status: "failed", message: "Əməliyyat konfiqurasiyasında xəta var, sahibə bildirildi.", detail: e.message, ms: 0 }; }
  try {
    const r = await safeRequest(req.url.toString(), { method: req.method, headers: req.headers, body: req.body });
    const ms = Date.now() - t0;
    if (r.status >= 200 && r.status < 300) return { status: "done", httpStatus: r.status, message: (spec.successMessage ? fill(spec.successMessage, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]))) : "") || "Əməliyyat icra olundu.", ms };
    const why = apiMessage(r.text);
    return { status: "failed", httpStatus: r.status, message: why ? `Əməliyyat icra olunmadı: ${why}` : `Əməliyyat icra olunmadı (xəta kodu ${r.status}).`, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e.code === "TIMEOUT") return { status: "unknown", message: "Saytdan cavab gəlmədi, əməliyyatın icra olunub-olunmadığı bəlli deyil. Təkrar etmə, operatorla yoxla.", ms };
    return { status: "failed", message: "Sayta qoşulmaq alınmadı, əməliyyat icra olunmadı. Bir az sonra yenidən cəhd edin.", detail: e.message, ms };
  }
}

const logParams = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]").slice(0, 80)]));

/** İstifadəçinin qərarı. identity: yoxlanmış { sub } və ya null. Qaytarır: { status, message } */
export async function decideAction(tenant, { id, decision, sid, identity }) {
  const p = getPending(id);
  const gone = { status: "expired", message: "Bu təsdiq vaxtı keçib və ya artıq istifadə olunub. Əməliyyatı yenidən istəyin." };
  if (!p || p.tenantId !== tenant.tenantId || p.sid !== sid) return gone; // başqasının/yanlış söhbətin kartı: varlığı bildirilmir
  const spec = (tenant.actions?.items ?? []).find((a) => a.key === p.key);
  const base = { key: p.key, title: spec?.title ?? p.key, subject: p.subject, channel: p.channel, params: logParams(p.values) };
  if (p.subject && identity?.sub !== p.subject) { await recordAction(tenant.tenantId, { ...base, status: "denied" }); return { status: "denied", message: "Təsdiq üçün hesabınıza daxil olmalısınız." }; }
  dropPending(id); // birdəfəlik: təkrar təsdiq eyni əməliyyatı ikinci dəfə icra edə bilməz
  if (decision !== "confirm") { await recordAction(tenant.tenantId, { ...base, status: "cancelled" }); return { status: "cancelled", message: "Əməliyyat ləğv olundu." }; }
  if (!spec || spec.enabled === false || (spec.requireIdentity && !identityReady(tenant))) return { status: "failed", message: "Bu əməliyyat hazırda mövcud deyil." };
  if (!allow(`e|${tenant.tenantId}|${p.subject ?? p.sid}`, EXEC_LIMIT(), 60 * 60_000) || !allow(`d|${tenant.tenantId}`, SITE_DAILY(), 24 * 60 * 60_000)) {
    await recordAction(tenant.tenantId, { ...base, status: "denied" });
    return { status: "denied", message: "Əməliyyat limiti aşıldı, bir az sonra yenidən cəhd edin." };
  }
  const r = await execute(tenant, spec, p.values, { subject: p.subject, idempotencyKey: p.id });
  if (r.detail) console.warn(`[actions] ${tenant.tenantId}/${p.key}: ${r.detail}`);
  await recordAction(tenant.tenantId, { ...base, status: r.status, httpStatus: r.httpStatus, ms: r.ms });
  return { status: r.status, message: r.message };
}

/** Panel: sınaq. send=false → yalnız sorğunun necə görünəcəyi (heç nə göndərilmir). send=true → real sorğu (X-Chatbot-Test başlığı ilə). */
export async function testAction(tenant, { key, params, send = false, subject = "test-user" }) {
  const spec = (tenant.actions?.items ?? []).find((a) => a.key === key);
  if (!spec) return { error: "Əməliyyat tapılmadı" };
  const { values, error } = coerceParams(spec, params);
  if (error) return { error };
  if (!send) {
    const req = buildRequest(tenant, spec, values, { subject: spec.requireIdentity ? subject : null, test: true });
    const a = tenant.actions.auth;
    return { preview: { method: req.method, url: req.url.toString(), headers: { ...(a && a.type !== "none" ? { [a.type === "bearer" ? "authorization" : a.name]: "***" } : {}), ...req.headers, ...(req.headers["x-chatbot-signature"] && { "x-chatbot-signature": "sha256=…" }) }, body: req.body ? JSON.parse(req.body) : null } };
  }
  const r = await execute(tenant, spec, values, { subject: spec.requireIdentity ? subject : null, idempotencyKey: `test-${crypto.randomBytes(8).toString("hex")}`, test: true });
  await recordAction(tenant.tenantId, { key, title: spec.title, status: "test", httpStatus: r.httpStatus, subject: spec.requireIdentity ? subject : null, params: logParams(values), ms: r.ms });
  return { sent: true, status: r.status, httpStatus: r.httpStatus ?? null, message: r.message, ms: r.ms };
}
