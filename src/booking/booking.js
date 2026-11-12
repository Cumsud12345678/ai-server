// API-siz randevu təqvimi: sahib panelə xidmətləri (müddət, qiymət), iş saatlarını, eyni anda neçə müştəri qəbul etdiyini yazır.
// AI söhbətdə əvvəl find_slots ilə boş vaxtları yoxlayır (vaxtı heç vaxt özü uydurmur), ad + telefon soruşur, xülasəni göstərir və
// yalnız müştəri təsdiq edəndən sonra book_appointment çağırır. Randevu müraciətlər qutusuna (kb_leads, booking sahəsi ilə) yazılır.
// Portal sahibə bildiriş göndərir və Telegram/WhatsApp randevusu üçün müştəriyə xatırlatma planlaşdırır.
import { Type } from "@google/genai";
import { addInbox, listInbox } from "../kb/store.js";

export const SLOTS_TOOL = "find_slots";
export const BOOK_TOOL = "book_appointment";
export const BOOKING_STATUSES = ["booked", "done", "noshow", "cancelled"];
export const ACTIVE = new Set(["booked"]);
const STEPS = [10, 15, 20, 30, 45, 60];
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CTRL = /[\u0000-\u001f\u007f]/g;
const str = (v, n) => (typeof v === "string" ? v.replace(CTRL, " ").trim().slice(0, n) : "");
const mins = (hm) => { const m = HM.exec(hm); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const validTz = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };

/** Sahibin göndərdiyi ayar. Qaytarır: xəta mətni və ya null. */
export function validateBooking(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "Randevu ayarı obyekt olmalıdır";
  if (typeof b.enabled !== "boolean") return "enabled true və ya false olmalıdır";
  if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > 60)) return "Başlıq ən çox 60 simvol ola bilər";
  if (b.instructions !== undefined && (typeof b.instructions !== "string" || b.instructions.length > 1000)) return "Qaydalar ən çox 1000 simvol ola bilər";
  if (b.tz !== undefined && (typeof b.tz !== "string" || !validTz(b.tz))) return "Saat qurşağı düzgün deyil";
  if (!Array.isArray(b.services) || !b.services.length) return "Ən azı bir xidmət əlavə edin";
  if (b.services.length > 30) return "Ən çox 30 xidmət ola bilər";
  const names = new Set();
  for (const s of b.services) {
    if (!s || typeof s !== "object") return "Xidmət düzgün deyil";
    if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 60) return "Xidmətin adı 1-60 simvol olmalıdır";
    if (names.has(s.name.trim().toLowerCase())) return `Xidmət təkrarlanır: ${s.name.trim()}`;
    names.add(s.name.trim().toLowerCase());
    if (!Number.isInteger(s.duration) || s.duration < 5 || s.duration > 480) return `${s.name}: müddət 5-480 dəqiqə olmalıdır`;
    if (s.price !== undefined && (typeof s.price !== "string" || s.price.length > 30)) return `${s.name}: qiymət ən çox 30 simvol ola bilər`;
  }
  if (!Array.isArray(b.days) || b.days.length !== 7) return "Həftənin 7 günü üçün iş saatı göndərin";
  if (!b.days.some(Boolean)) return "Ən azı bir iş günü seçin";
  for (const d of b.days) {
    if (d === null) continue;
    if (!d || typeof d !== "object" || !HM.test(d.from) || !HM.test(d.to)) return "İş saatı SS:DD formatında olmalıdır";
    if (mins(d.to) <= mins(d.from)) return "İş saatının sonu başlanğıcından gec olmalıdır";
  }
  if (b.step !== undefined && !STEPS.includes(b.step)) return `Addım ${STEPS.join(", ")} dəqiqə ola bilər`;
  if (b.capacity !== undefined && (!Number.isInteger(b.capacity) || b.capacity < 1 || b.capacity > 20)) return "Eyni anda qəbul 1-20 olmalıdır";
  if (b.noticeMin !== undefined && (!Number.isInteger(b.noticeMin) || b.noticeMin < 0 || b.noticeMin > 2880)) return "Minimum qabaqcadan yazılma 0-2880 dəqiqə olmalıdır";
  if (b.horizonDays !== undefined && (!Number.isInteger(b.horizonDays) || b.horizonDays < 1 || b.horizonDays > 90)) return "Nə qədər irəliyə yazmaq olar: 1-90 gün";
  if (b.closedDates !== undefined && (!Array.isArray(b.closedDates) || b.closedDates.length > 60 || b.closedDates.some((x) => typeof x !== "string" || !DATE.test(x)))) return "Bağlı günlər YYYY-AA-GG formatında, ən çox 60";
  if (b.reminders !== undefined && typeof b.reminders !== "boolean") return "reminders true/false olmalıdır";
  return null;
}

export function cleanBooking(b) {
  return {
    enabled: b.enabled,
    ...(str(b.title, 60) && { title: str(b.title, 60) }),
    ...(typeof b.instructions === "string" && b.instructions.trim() && { instructions: b.instructions.trim().slice(0, 1000) }),
    tz: typeof b.tz === "string" && validTz(b.tz) ? b.tz : "Asia/Baku",
    services: b.services.map((s) => ({ name: str(s.name, 60), duration: s.duration, ...(str(s.price, 30) && { price: str(s.price, 30) }) })),
    days: b.days.map((d) => (d ? { from: d.from, to: d.to } : null)),
    step: STEPS.includes(b.step) ? b.step : 30,
    capacity: Number.isInteger(b.capacity) ? b.capacity : 1,
    noticeMin: Number.isInteger(b.noticeMin) ? b.noticeMin : 60,
    horizonDays: Number.isInteger(b.horizonDays) ? b.horizonDays : 30,
    closedDates: [...new Set(Array.isArray(b.closedDates) ? b.closedDates : [])].sort(),
    reminders: b.reminders !== false,
    updatedAt: new Date().toISOString(),
  };
}

const cfgOf = (tenant) => (tenant.booking?.enabled && tenant.booking.services?.length ? tenant.booking : null);
export const bookingEnabled = (tenant) => Boolean(cfgOf(tenant));

// ---- vaxt qurşağı ----
/** Verilmiş anın həmin qurşaqdakı yerli tarixi, saatı və həftə günü */
export function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}
/** Yerli tarix + dəqiqə → UTC millisaniyə */
export function zonedMs(date, minutes, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off = (ms) => { const l = localParts(ms, tz); const [ly, lm, ld] = l.date.split("-").map(Number); return Date.UTC(ly, lm - 1, ld, 0, l.minutes) - ms; };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WEEK_AZ = ["bazar", "bazar ertəsi", "çərşənbə axşamı", "çərşənbə", "cümə axşamı", "cümə", "şənbə"];

/** Aktiv randevular (ləğv olunmamış), [fromMs, toMs) aralığında */
async function activeBookings(tenantId) {
  const { items } = await listInbox("leads", tenantId, { limit: 500, filter: (d) => d.booking && ACTIVE.has(d.booking.status ?? "booked") });
  return items.map((d) => ({ start: Date.parse(d.booking.start), end: Date.parse(d.booking.end) }));
}

/** Bir gün üçün boş başlanğıc vaxtları (SS:DD) */
export function daySlots(cfg, service, date, busy, now = Date.now()) {
  const { weekday } = localParts(zonedMs(date, 12 * 60, cfg.tz), cfg.tz);
  const day = cfg.days[weekday];
  if (!day || cfg.closedDates?.includes(date)) return [];
  const today = localParts(now, cfg.tz).date;
  if (date < today || date > addDays(today, cfg.horizonDays)) return [];
  const out = [];
  for (let m = mins(day.from); m + service.duration <= mins(day.to); m += cfg.step) {
    const start = zonedMs(date, m, cfg.tz), end = start + service.duration * 60_000;
    if (start < now + cfg.noticeMin * 60_000) continue;
    const overlap = busy.filter((b) => b.start < end && b.end > start).length;
    if (overlap < cfg.capacity) out.push(hm(m));
  }
  return out;
}

const findService = (cfg, name) => {
  const s = str(String(name ?? ""), 60).toLowerCase();
  return cfg.services.find((x) => x.name.toLowerCase() === s) ?? (cfg.services.length === 1 && !s ? cfg.services[0] : null);
};

// ---- modelə alətlər ----
export function bookingDeclarations(tenant) {
  const cfg = cfgOf(tenant);
  if (!cfg) return [];
  const names = cfg.services.map((s) => s.name);
  const service = { type: Type.STRING, enum: names, description: "Xidmət" };
  return [
    { name: SLOTS_TOOL, description: "Randevu üçün boş vaxtları qaytarır. Müştəriyə vaxt təklif etməzdən əvvəl HƏMİŞƏ çağır, vaxtı özün uydurma.",
      parameters: { type: Type.OBJECT, properties: { service, date: { type: Type.STRING, description: "İstənilən gün YYYY-AA-GG (müştəri gün deməyibsə boş burax: ən yaxın boş günlər qayıdır)" } }, required: ["service"] } },
    { name: BOOK_TOOL, description: "Randevunu qeydə alır. YALNIZ find_slots-un qaytardığı vaxtla, ad və telefon toplanıb, xülasə göstərilib və müştəri açıq şəkildə təsdiq edəndən sonra çağır.",
      parameters: { type: Type.OBJECT, properties: { service, date: { type: Type.STRING, description: "YYYY-AA-GG" }, time: { type: Type.STRING, description: "SS:DD (find_slots-dan)" },
        name: { type: Type.STRING, description: "Müştərinin adı" }, phone: { type: Type.STRING, description: "Telefon nömrəsi" }, note: { type: Type.STRING, description: "Əlavə qeyd (istəyə bağlı)" } }, required: ["service", "date", "time", "name", "phone"] } },
  ];
}
export const isBookingTool = (name) => name === SLOTS_TOOL || name === BOOK_TOOL;

export function bookingPrompt(tenant, now = Date.now()) {
  const cfg = cfgOf(tenant);
  if (!cfg) return "";
  const l = localParts(now, cfg.tz);
  const services = cfg.services.map((s) => `${s.name} (${s.duration} dəq${s.price ? `, ${s.price}` : ""})`).join("; ");
  const hours = cfg.days.map((d, i) => `${WEEK_AZ[i]}: ${d ? `${d.from}-${d.to}` : "bağlı"}`).join(", ");
  return `\nRANDEVU QƏBULU${cfg.title ? ` (${cfg.title})` : ""}: Bu gün ${l.date} (${WEEK_AZ[l.weekday]}), saat ${hm(l.minutes)}. Xidmətlər: ${services}. İş saatları: ${hours}.
- Müştəri yazılmaq, randevu və ya vaxt almaq istəyəndə əvvəl xidməti dəqiqləşdir, sonra ${SLOTS_TOOL} ilə boş vaxtları yoxla və 3-5 variant təklif et. Vaxtı heç vaxt özün uydurma.
- "Sabah", "cümə", "axşam" kimi ifadələri bu günün tarixinə görə YYYY-AA-GG-yə çevir.
- Ad və telefon soruş, sonra qısa xülasə göstər (xidmət, gün, saat, ad, telefon) və "Təsdiq edirsiniz?" soruş. Təsdiq olmadan ${BOOK_TOOL} ÇAĞIRMA.
- Uğurlu olanda randevunun qeydə alındığını, günü və saatı de. Alət xəta qaytarsa (məs. vaxt artıq tutulub), yeni boş vaxt təklif et.
- Randevu məlumatlarını toplayarkən [[NO_ANSWER]] yazma.${cfg.instructions ? `\nRandevu qaydaları (yalnız bunlara əsaslan): ${cfg.instructions}` : ""}`;
}

// Sui-istifadə qoruması: söhbət başına saatda 3, hesab üzrə gündə BOOKINGS_PER_DAY (defolt 300)
const hits = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  if (hits.size > 20_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  const cur = hits.get(key);
  if (!cur || cur.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
  cur.n += 1;
  return cur.n <= max;
}
export const _resetBookingLimits = () => hits.clear();

const cleanConvo = (c) => (Array.isArray(c) ? c : []).slice(-10)
  .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string" && m.text.trim())
  .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 600) }));

export async function runBookingTool(tenant, name, args, ctx, { sid = null, channel = null, conversation = [], reach = null, now = Date.now() } = {}) {
  const cfg = cfgOf(tenant);
  if (!cfg) return { error: "Randevu qəbulu hazırda söndürülüb. Müştəriyə operatorla əlaqə saxlamağı təklif et." };
  const service = findService(cfg, args?.service);
  if (!service) return { error: `Belə xidmət yoxdur. Mövcud xidmətlər: ${cfg.services.map((s) => s.name).join(", ")}` };
  const busy = await activeBookings(tenant.tenantId);
  const today = localParts(now, cfg.tz).date;

  if (name === SLOTS_TOOL) {
    const date = typeof args?.date === "string" && DATE.test(args.date.trim()) ? args.date.trim() : null;
    const days = [];
    if (date) { const times = daySlots(cfg, service, date, busy, now); if (times.length) days.push({ date, weekday: WEEK_AZ[localParts(zonedMs(date, 720, cfg.tz), cfg.tz).weekday], times: times.slice(0, 24) }); }
    // Gün göstərilməyib və ya o gün boşdur: ən yaxın 3 boş gün
    for (let i = 0, start = date && date >= today ? addDays(date, 1) : today; days.length < 3 && i <= cfg.horizonDays; i++) {
      const d = addDays(start, i);
      if (d > addDays(today, cfg.horizonDays)) break;
      const times = daySlots(cfg, service, d, busy, now);
      if (times.length) days.push({ date: d, weekday: WEEK_AZ[localParts(zonedMs(d, 720, cfg.tz), cfg.tz).weekday], times: times.slice(0, 12) });
    }
    return { service: service.name, duration: service.duration, ...(service.price && { price: service.price }), ...(date && !days.some((x) => x.date === date) && { requestedDateFull: true }), days,
      note: days.length ? "Bu vaxtlardan 3-5-ni təklif et." : "Yaxın günlərdə boş vaxt yoxdur. Müştəriyə operatorla əlaqə saxlamağı təklif et." };
  }

  // book_appointment
  ctx.private = true; // şəxsi məlumatdır: keşə və sorğu jurnalına düşməsin
  if (ctx.booking) return { error: "Bu randevu artıq qeydə alınıb, təkrar göndərmə." };
  const perDay = Number(process.env.BOOKINGS_PER_DAY) || 300;
  if (!allow(`b|${tenant.tenantId}|${sid ?? "nosid"}`, 3, 60 * 60_000) || !allow(`bd|${tenant.tenantId}`, perDay, 24 * 60 * 60_000))
    return { error: "Qısa müddətdə çox randevu göndərildi. Müştəriyə bir az sonra yenidən cəhd etməyi və ya operatorla əlaqə saxlamağı de." };
  const date = str(args?.date, 10), time = str(args?.time, 5);
  if (!DATE.test(date) || !HM.test(time)) return { error: "Gün və saat düzgün deyil. find_slots ilə boş vaxtı yoxla." };
  const nameV = str(args?.name, 80), phone = str(args?.phone, 30), note = str(args?.note, 300);
  if (!nameV) return { error: "Müştərinin adı çatışmır. Soruş, uydurma." };
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return { error: "Telefon nömrəsi düzgün deyil. Müştəridən dəqiqləşdir." };
  if (!daySlots(cfg, service, date, busy, now).includes(time)) return { error: "Bu vaxt artıq boş deyil və ya iş saatından kənardır. find_slots ilə yeni boş vaxt tap və təklif et." };
  const startMs = zonedMs(date, mins(time), cfg.tz);
  const title = cfg.title || "Randevu";
  const doc = await addInbox("leads", tenant.tenantId, {
    name: nameV, contact: phone,
    question: `${title}: ${service.name} · ${date} ${time}${note ? ` · ${note}` : ""}`.slice(0, 500),
    conversation: cleanConvo(conversation), handled: false, status: "new",
    booking: { service: service.name, duration: service.duration, ...(service.price && { price: service.price }), date, time, start: new Date(startMs).toISOString(), end: new Date(startMs + service.duration * 60_000).toISOString(),
      tz: cfg.tz, status: "booked", ...(note && { note }), channel: ["widget", "telegram", "whatsapp", "api"].includes(channel) ? channel : "widget", ...(sid && { sid }), ...(reach && { reach }) },
  });
  const no = doc._id.slice(0, 8).toUpperCase();
  ctx.booking = { id: doc._id, title, service: service.name, date, time, start: doc.booking.start, name: nameV, contact: phone, reminders: cfg.reminders !== false };
  return { ok: true, bookingNumber: no, note: `Randevu qeydə alındı: ${service.name}, ${date} (${WEEK_AZ[localParts(startMs, cfg.tz).weekday]}) saat ${time}. Müştəriyə bunu qısa de.` };
}
