// AI istifadəsinin REAL xərci (dollar) və müştəriyə yazılan məbləğ (manat). Claude və Gemini birlikdə.
// Qiymətlər 1 milyon token üçün dollardır. Env ilə dəyişdirmək olar (AI_PRICES və ya köhnə adı GEMINI_PRICES):
//   AI_PRICES='{"gemini-3.5-flash-lite":{"in":0.3,"out":2.5,"cachedIn":0.03}}'
// DİQQƏT: defoltlar yayımlanmış qiymətlərə görədir; provayder qiyməti dəyişsə env-dən yenilə.
// Naməlum model "*" qiyməti ilə (ən bahalısı) hesablanır: səhv model adı səni zərərə salmasın.
//
// tier: prompt (keş daxil) "over" tokendən çoxdursa BÜTÜN sətirlər (çıxış da) yüksək qiymətlə hesablanır.
// Claude Haiku 5.5-də bu hədd 100 000 tokendir.
const DEFAULT_PRICES = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cachedIn: 0.01, cacheWrite: 0.125, tier: { over: 100_000, in: 0.5, out: 2.5, cachedIn: 0.05, cacheWrite: 0.625 } },
  "claude-haiku-4-5": { in: 1, out: 5, cachedIn: 0.1, cacheWrite: 1.25 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5, cachedIn: 0.03 },
  "gemini-3.5-flash": { in: 1.5, out: 9, cachedIn: 0.15 },
  "gemini-3-flash-preview": { in: 0.5, out: 3, cachedIn: 0.05 },
  "gemini-embedding-001": { in: 0.15, out: 0 },
  "*": { in: 1.5, out: 9, cachedIn: 0.15 },
};

function envPrices() {
  const raw = process.env.AI_PRICES || process.env.GEMINI_PRICES;
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { console.warn("[billing] AI_PRICES düzgün JSON deyil, defolt qiymətlər işləyir"); return {}; }
}
const prices = () => ({ ...DEFAULT_PRICES, ...envPrices() });

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Bir AI çağırışının xərci (USD). usage Gemini formatındadır (Claude cavabı llm.js-də bu formata çevrilir):
 * promptTokenCount (keş daxil), cachedContentTokenCount (keşdən oxunan), cacheWriteTokenCount (Claude keşə yazma),
 * candidatesTokenCount + thoughtsTokenCount (çıxış). Ətraflı bölgü yoxdursa (yalnız total), 85% giriş / 15% çıxış sayılır.
 */
export function callCostUsd(model, usage) {
  if (!usage) return 0;
  const base = prices()[model] ?? prices()["*"];
  const total = num(usage.totalTokenCount);
  const hasSplit = usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined;
  const prompt = hasSplit ? num(usage.promptTokenCount) + num(usage.toolUsePromptTokenCount) : Math.round(total * 0.85);
  const output = hasSplit ? num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount) : total - Math.round(total * 0.85);
  const p = base.tier && prompt > base.tier.over ? { ...base, ...base.tier } : base;
  const cached = Math.min(num(usage.cachedContentTokenCount), prompt);
  const written = Math.min(num(usage.cacheWriteTokenCount), prompt - cached);
  const fresh = prompt - cached - written;
  return (fresh * p.in + cached * (p.cachedIn ?? p.in) + written * (p.cacheWrite ?? p.in) + output * p.out) / 1e6;
}

/** Embedding xərci: cavabda token sayı gəlmir, ~4 simvol = 1 token kimi təxmin edilir. */
export function embedUsage(texts) {
  const tokens = Math.ceil(texts.reduce((n, t) => n + String(t).length, 0) / 4);
  return { promptTokenCount: tokens, candidatesTokenCount: 0, totalTokenCount: tokens };
}

// Model üzrə ümumi xərc statistikası (admin "Maliyyə" səhifəsi). Yalnız işlək serverdə (index.js) qoşulur, testlərdə boşdur.
let modelHook = null;
/** fn(model, costUsd, tokens): hər AI çağırışından sonra çağırılır. Xəta sorğunu dayandırmamalıdır. */
export const onModelCost = (fn) => { modelHook = fn; };
export const reportModelCost = (model, costUsd, tokens) => {
  if (!modelHook || !model) return;
  try { const p = modelHook(model, costUsd, tokens); if (p?.catch) p.catch(() => {}); } catch { /* statistika vacib deyil */ }
};

/** Bir sorğu boyu bütün çağırışları toplayan sayğac (uğursuz model cəhdlərinin xərci də itmir). */
export function newMeter() {
  const m = { costUsd: 0, tokens: 0, calls: 0, models: [] };
  m.add = (model, usage) => {
    const cost = callCostUsd(model, usage);
    m.costUsd += cost;
    m.tokens += num(usage?.totalTokenCount);
    m.calls++;
    if (!m.models.includes(model)) m.models.push(model);
    reportModelCost(model, cost, num(usage?.totalTokenCount));
  };
  return m;
}

const envNum = (name, d) => (process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : d);
export const config = {
  markup: () => envNum("BILLING_MARKUP", 1.5),          // həqiqi xərcə vurulan əmsal
  usdAzn: () => envNum("USD_AZN_RATE", 1.7),            // AZN dollara sabitlənib
  freeAzn: () => envNum("BILLING_FREE_AZN", 2),          // pulsuz məbləğ (müştəriyə yazılan manatla)
  freePeriod: () => (process.env.BILLING_FREE_PERIOD === "once" ? "once" : "monthly"),
  // Yüklənmiş balansın istifadə müddəti (gün): hər yükləmənin öz müddəti var, xərclənməyən hissə sonra yanır. 0 = müddətsiz
  topupExpiryDays: () => Math.max(0, Math.round(envNum("BILLING_TOPUP_EXPIRY_DAYS", 365))),
  lowAzn: () => envNum("BILLING_LOW_AZN", 1),            // "balans azalır" xəbərdarlığı həddi
  minTopupAzn: () => envNum("BILLING_MIN_TOPUP_AZN", 10),
  maxTopupAzn: () => envNum("BILLING_MAX_TOPUP_AZN", 1000),
  enforce: () => process.env.BILLING_ENFORCE !== "false", // false: yalnız hesablayır, heç vaxt dayandırmır (keçid dövrü)
  defaultAvgAzn: () => 0.0022,
  // Müştəri başına gündəlik xərc tavanı (müştəriyə yazılan manatla). 0 = limit yoxdur. Admin hər müştəri üçün ayrıca dəyişə bilər.
  dailyLimitAzn: () => envNum("BILLING_DAILY_LIMIT_AZN", 0),                           // sorğu tarixçəsi olmayanda göstərilən orta qiymət (təxmini)
};

export const MICRO = 1_000_000;
export const toMicro = (azn) => Math.round(num(azn) * MICRO);
export const fromMicro = (m) => Math.round((num(m) / MICRO) * 10_000) / 10_000;
/** USD xərc → müştəriyə yazılan mikro-manat (həqiqi xərc, vuruq əmsalı ilə). */
export const billedMicro = (costUsd, markup = config.markup()) => Math.round(costUsd * config.usdAzn() * MICRO * markup);
