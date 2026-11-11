// API-siz sifariş forması: sahib panelə sahələri yazır (ad, telefon, ünvan, məhsul, say...), AI söhbətdə onları bir-bir
// soruşur, xülasəni göstərib təsdiq istəyir və yalnız müştəri təsdiq edəndən sonra submit_order alətini çağırır.
// Sifariş müraciətlər qutusuna (kb_leads, order sahəsi ilə) yazılır; portal sahibə e-poçt və ötürmə (Telegram/Bitrix/webhook) göndərir.
// Müştərinin öz API-si lazım deyil: "Əməliyyatlar"dan fərqli olaraq heç bir xarici sorğu getmir.
import { Type } from "@google/genai";
import { addInbox } from "../kb/store.js";

export const ORDER_TOOL = "submit_order";
export const FIELD_TYPES = ["text", "phone", "email", "number", "select", "address"];
export const MAX_FIELDS = 12;
const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;
const CTRL = /[\u0000-\u001f\u007f]/g;

const str = (v, n) => (typeof v === "string" ? v.replace(CTRL, " ").trim().slice(0, n) : "");

/** Sahibin göndərdiyi forma. Qaytarır: xəta mətni və ya null. */
export function validateOrderForm(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return "Sifariş forması obyekt olmalıdır";
  if (typeof f.enabled !== "boolean") return "enabled true və ya false olmalıdır";
  if (f.title !== undefined && (typeof f.title !== "string" || f.title.length > 60)) return "Başlıq ən çox 60 simvol ola bilər";
  if (f.instructions !== undefined && (typeof f.instructions !== "string" || f.instructions.length > 1500)) return "Sifariş qaydaları ən çox 1500 simvol ola bilər";
  if (f.successMessage !== undefined && (typeof f.successMessage !== "string" || f.successMessage.length > 300)) return "Təşəkkür mesajı ən çox 300 simvol ola bilər";
  if (!Array.isArray(f.fields) || !f.fields.length) return "Ən azı bir sahə əlavə edin";
  if (f.fields.length > MAX_FIELDS) return `Ən çox ${MAX_FIELDS} sahə ola bilər`;
  const keys = new Set();
  for (const x of f.fields) {
    if (!x || typeof x !== "object") return "Sahə düzgün deyil";
    if (typeof x.key !== "string" || !KEY_RE.test(x.key)) return `Sahə açarı düzgün deyil: ${String(x.key ?? "").slice(0, 40)} (kiçik latın hərfi, rəqəm, _)`;
    if (keys.has(x.key)) return `Sahə açarı təkrarlanır: ${x.key}`;
    keys.add(x.key);
    if (typeof x.label !== "string" || !x.label.trim() || x.label.length > 60) return `${x.key}: ad 1-60 simvol olmalıdır`;
    if (!FIELD_TYPES.includes(x.type)) return `${x.key}: növ ${FIELD_TYPES.join(", ")} olmalıdır`;
    if (x.required !== undefined && typeof x.required !== "boolean") return `${x.key}: required true/false olmalıdır`;
    if (x.description !== undefined && (typeof x.description !== "string" || x.description.length > 200)) return `${x.key}: izah ən çox 200 simvol ola bilər`;
    if (x.type === "select") {
      if (!Array.isArray(x.options) || x.options.length < 2 || x.options.length > 30) return `${x.key}: seçim üçün 2-30 variant yazın`;
      if (x.options.some((o) => typeof o !== "string" || !o.trim() || o.length > 60)) return `${x.key}: variantlar 1-60 simvol olmalıdır`;
    }
  }
  // Sahib müştəri ilə əlaqə saxlaya bilməlidir: telefon və ya e-poçt məcburidir
  if (!f.fields.some((x) => (x.type === "phone" || x.type === "email") && x.required)) return "Telefon və ya e-poçt sahəsi olmalı və məcburi olmalıdır (müştəri ilə əlaqə üçün)";
  return null;
}

/** Yoxlanmış formanın saxlanan nüsxəsi (yalnız tanınan sahələr). */
export function cleanOrderForm(f) {
  return {
    enabled: f.enabled,
    ...(str(f.title, 60) && { title: str(f.title, 60) }),
    ...(typeof f.instructions === "string" && f.instructions.trim() && { instructions: f.instructions.trim().slice(0, 1500) }),
    ...(str(f.successMessage, 300) && { successMessage: str(f.successMessage, 300) }),
    fields: f.fields.map((x) => ({
      key: x.key, label: str(x.label, 60), type: x.type, required: x.required === true,
      ...(str(x.description, 200) && { description: str(x.description, 200) }),
      ...(x.type === "select" && { options: [...new Set(x.options.map((o) => str(o, 60)).filter(Boolean))] }),
    })),
    updatedAt: new Date().toISOString(),
  };
}

const live = (tenant) => (tenant.orderForm?.enabled && tenant.orderForm.fields?.length ? tenant.orderForm : null);
export const orderEnabled = (tenant) => Boolean(live(tenant));

const TYPE_HINT = { phone: "telefon nömrəsi", email: "e-poçt ünvanı", address: "tam çatdırılma ünvanı", number: "rəqəm" };

/** Modelə verilən alət (forma aktiv deyilsə null). */
export function orderDeclaration(tenant) {
  const f = live(tenant);
  if (!f) return null;
  const properties = {};
  for (const x of f.fields) {
    const description = [x.label, TYPE_HINT[x.type], x.description].filter(Boolean).join(". ");
    properties[x.key] = x.type === "select" ? { type: Type.STRING, enum: x.options, description }
      : x.type === "number" ? { type: Type.NUMBER, description } : { type: Type.STRING, description };
  }
  return {
    name: ORDER_TOOL,
    description: `Müştərinin ${f.title ? `"${f.title}"` : "sifarişini"} qeydə alır və şirkətə göndərir. YALNIZ bütün məcburi məlumatlar toplanıb, xülasə müştəriyə göstərilib və müştəri açıq şəkildə təsdiq edəndən sonra çağır. Heç bir dəyəri özün uydurma və ya təxmin etmə.`,
    parameters: { type: Type.OBJECT, properties, required: f.fields.filter((x) => x.required).map((x) => x.key) },
  };
}

/** Sistem təlimatına əlavə (forma aktiv deyilsə boş). */
export function orderPrompt(tenant) {
  const f = live(tenant);
  if (!f) return "";
  const list = f.fields.map((x) => `${x.label}${x.required ? "" : " (istəyə bağlı)"}${x.type === "select" ? `: ${x.options.join(" / ")}` : ""}`).join("; ");
  return `\nSİFARİŞ QƏBULU: Müştəri almaq, sifariş vermək və ya ${f.title ? `"${f.title}"` : "sifariş"} etmək istəyəndə ${ORDER_TOOL} alətindən istifadə et. Toplanacaq məlumat: ${list}.
- Məlumatları söhbət tərzində soruş, bir mesajda ən çox 2 sual. Müştəri artıq dediyi məlumatı yenidən soruşma.
- Hamısı toplananda qısa xülasə göstər və "Təsdiq edirsiniz?" soruş. Müştəri təsdiq etməyincə aləti ÇAĞIRMA.
- Alət uğurlu olanda sifarişin qəbul olunduğunu və şirkətin əlaqə saxlayacağını de. Alət xəta qaytarsa, səbəbini müştəriyə sadə dillə izah et.
- Sifariş məlumatlarını toplayarkən [[NO_ANSWER]] yazma.${f.instructions ? `\nSifariş qaydaları (çatdırılma, ödəniş və s.; yalnız bunlara əsaslan, uydurma): ${f.instructions}` : ""}`;
}

// Sui-istifadə qoruması (yaddaşda): söhbət başına saatda 3, hesab üzrə gündə ORDERS_PER_DAY (defolt 200)
const hits = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  if (hits.size > 20_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  const cur = hits.get(key);
  if (!cur || cur.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
  cur.n += 1;
  return cur.n <= max;
}
export const _resetOrderLimits = () => hits.clear();

/** Modelin göndərdiyi dəyərləri forma üzrə yoxlayır. */
export function coerceOrder(form, args = {}) {
  const values = {}, missing = [], bad = [];
  for (const x of form.fields) {
    const raw = args?.[x.key];
    const empty = raw === undefined || raw === null || (typeof raw === "string" && !raw.trim());
    if (empty) { if (x.required) missing.push(x.label); continue; }
    let v = null;
    if (x.type === "number") { const n = Number(typeof raw === "string" ? raw.replace(",", ".").replace(/\s/g, "") : raw); v = Number.isFinite(n) ? n : null; }
    else if (x.type === "select") { const s = str(String(raw), 60).toLowerCase(); v = x.options.find((o) => o.toLowerCase() === s) ?? null; }
    else if (x.type === "phone") { const s = str(String(raw), 30); const d = s.replace(/\D/g, ""); v = d.length >= 7 && d.length <= 15 ? s : null; }
    else if (x.type === "email") { const s = str(String(raw), 120); v = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null; }
    else v = str(String(raw), x.type === "address" ? 300 : 200) || null;
    if (v === null) bad.push(x.label); else values[x.key] = v;
  }
  return { values, missing, bad };
}

const cleanConvo = (c) => (Array.isArray(c) ? c : []).slice(-10)
  .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string" && m.text.trim())
  .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 600) }));

/** submit_order: sifarişi müraciətlər qutusuna yazır. ctx.order portala qayıdır (bildiriş üçün). */
export async function runOrderTool(tenant, args, ctx, { sid = null, channel = null, conversation = [] } = {}) {
  ctx.private = true; // şəxsi məlumatdır: keşə və sorğu jurnalına düşməsin
  const f = live(tenant);
  if (!f) return { error: "Sifariş qəbulu hazırda söndürülüb. Müştəriyə operatorla əlaqə saxlamağı təklif et." };
  if (ctx.order) return { error: "Bu sifariş artıq qəbul olunub, təkrar göndərmə." };
  const perDay = Number(process.env.ORDERS_PER_DAY) || 200;
  if (!allow(`o|${tenant.tenantId}|${sid ?? "nosid"}`, 3, 60 * 60_000) || !allow(`od|${tenant.tenantId}`, perDay, 24 * 60 * 60_000))
    return { error: "Qısa müddətdə çox sifariş göndərildi. Müştəriyə bir az sonra yenidən cəhd etməyi və ya operatorla əlaqə saxlamağı de." };
  const { values, missing, bad } = coerceOrder(f, args);
  if (missing.length) return { error: `Bu məlumatlar çatışmır: ${missing.join(", ")}. Müştəridən soruş, uydurma.` };
  if (bad.length) return { error: `Bu məlumatlar düzgün deyil: ${bad.join(", ")}. Müştəridən dəqiqləşdir.` };
  const fields = f.fields.filter((x) => values[x.key] !== undefined).map((x) => ({ key: x.key, label: x.label, value: String(values[x.key]) }));
  const contactField = f.fields.find((x) => (x.type === "phone" || x.type === "email") && values[x.key] !== undefined);
  const nameField = f.fields.find((x) => x.type === "text" && (x.key === "name" || /^(ad|adınız|ad soyad|ad və soyad|name|full name|имя|isim|ad soyadı)$/i.test(x.label.trim())));
  const title = f.title || "Sifariş";
  // Ad və əlaqə kartda ayrıca göstərilir: xülasədə qalan sahələr (məhsul, ünvan, say...)
  const summary = fields.filter((x) => x.key !== contactField?.key && x.key !== nameField?.key).map((x) => `${x.label}: ${x.value}`).join("; ");
  const doc = await addInbox("leads", tenant.tenantId, {
    name: nameField ? String(values[nameField.key]).slice(0, 80) : "",
    contact: String(values[contactField.key]),
    question: `${title}${summary ? `: ${summary}` : ""}`.slice(0, 500),
    conversation: cleanConvo(conversation),
    handled: false, status: "new",
    order: { title, fields: fields.map(({ label, value }) => ({ label, value })), channel: ["widget", "telegram", "whatsapp", "api"].includes(channel) ? channel : "widget", ...(sid && { sid }) },
  });
  ctx.order = { id: doc._id, title, name: doc.name, contact: doc.contact, fields: doc.order.fields };
  return { ok: true, orderNumber: doc._id.slice(0, 8).toUpperCase(), note: `Sifariş qəbul olundu (nömrə: ${doc._id.slice(0, 8).toUpperCase()}). Müştəriyə bunu qısa de.${f.successMessage ? ` Mənası bu olsun: ${f.successMessage}` : " Şirkət tezliklə onunla əlaqə saxlayacaq."}` };
}
