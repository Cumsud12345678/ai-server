// Gemini istifadəsinin REAL xərci (dollar) və müştəriyə yazılan məbləğ (manat).
// Qiymətlər env-dən dəyişdirilə bilər: GEMINI_PRICES='{"gemini-3.5-flash":{"in":1.5,"out":9,"cachedIn":0.15}}' (1 milyon token üçün dollar).
// DİQQƏT: aşağıdakı defoltlar yayımlanmış qiymətlərə görə təxminidir; Google qiymət dəyişsə env-dən yenilə.

// Claude Haiku 5.5 tarifi (1M token: giriş 0.10, çıxış 0.50, keş oxuma 0.01 USD): bütün modellərə tətbiq olunur.
// Real Gemini qiymətlərinə qayıtmaq üçün GEMINI_PRICES env-i ilə modeli göstər (məs. gemini-3.5-flash: in 1.5, out 9, cachedIn 0.15).
const HAIKU = { in: 0.1, out: 0.5, cachedIn: 0.01 };
const DEFAULT_PRICES = {
  "gemini-3.5-flash": HAIKU,
  "gemini-3-flash-preview": HAIKU,
  "gemini-3.5-flash-lite": HAIKU,
  "*": HAIKU,
};

function prices() {
  try { return { ...DEFAULT_PRICES, ...(process.env.GEMINI_PRICES ? JSON.parse(process.env.GEMINI_PRICES) : {}) }; }
  catch { console.warn("[billing] GEMINI_PRICES düzgün JSON deyil, defolt qiymətlər işləyir"); return DEFAULT_PRICES; }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Bir Gemini çağırışının xərci (USD). Giriş, çıxış və "düşünmə" tokenləri ayrı qiymətlə hesablanır.
 * usage: response.usageMetadata. Ətraflı bölgü yoxdursa (yalnız total), 85% giriş / 15% çıxış sayılır.
 */
export function callCostUsd(model, usage) {
  if (!usage) return 0;
  const p = prices()[model] ?? prices()["*"];
  const total = num(usage.totalTokenCount);
  const hasSplit = usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined;
  const cached = Math.min(num(usage.cachedContentTokenCount), num(usage.promptTokenCount));
  const prompt = hasSplit ? num(usage.promptTokenCount) + num(usage.toolUsePromptTokenCount) : Math.round(total * 0.85);
  const output = hasSplit ? num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount) : total - Math.round(total * 0.85);
  return ((prompt - cached) * p.in + cached * (p.cachedIn ?? p.in) + output * p.out) / 1e6;
}

/** Bir sorğu boyu bütün çağırışları toplayan sayğac (uğursuz model cəhdlərinin xərci də itmir). */
export function newMeter() {
  const m = { costUsd: 0, tokens: 0, calls: 0, models: [] };
  m.add = (model, usage) => {
    m.costUsd += callCostUsd(model, usage);
    m.tokens += num(usage?.totalTokenCount);
    m.calls++;
    if (!m.models.includes(model)) m.models.push(model);
  };
  return m;
}

const envNum = (name, d) => (process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : d);
export const config = {
  markup: () => envNum("BILLING_MARKUP", 1.5),          // həqiqi xərcə vurulan əmsal
  usdAzn: () => envNum("USD_AZN_RATE", 1.7),            // AZN dollara sabitlənib
  freeAzn: () => envNum("BILLING_FREE_AZN", 2),          // pulsuz məbləğ (müştəriyə yazılan manatla)
  freePeriod: () => (process.env.BILLING_FREE_PERIOD === "once" ? "once" : "monthly"),
  lowAzn: () => envNum("BILLING_LOW_AZN", 1),            // "balans azalır" xəbərdarlığı həddi
  minTopupAzn: () => envNum("BILLING_MIN_TOPUP_AZN", 10),
  maxTopupAzn: () => envNum("BILLING_MAX_TOPUP_AZN", 1000),
  enforce: () => process.env.BILLING_ENFORCE !== "false", // false: yalnız hesablayır, heç vaxt dayandırmır (keçid dövrü)
  defaultAvgAzn: () => 0.0022,                           // sorğu tarixçəsi olmayanda göstərilən orta qiymət (təxmini)
};

export const MICRO = 1_000_000;
export const toMicro = (azn) => Math.round(num(azn) * MICRO);
export const fromMicro = (m) => Math.round((num(m) / MICRO) * 10_000) / 10_000;
/** USD xərc → müştəriyə yazılan mikro-manat (həqiqi xərc, vuruq əmsalı ilə). */
export const billedMicro = (costUsd, markup = config.markup()) => Math.round(costUsd * config.usdAzn() * MICRO * markup);
