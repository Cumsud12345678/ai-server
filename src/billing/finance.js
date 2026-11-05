// Admin "Maliyyə" hesabatı: pul girişi (yükləmələr), AI-ın real xərci, istifadədən gəlir və mənfəət.
// Bütün məbləğlər mikro-manatla toplanır, cavabda manata çevrilir.
//
// Anlayışlar:
//   cashIn   — balansa daxil olan pul (ledger): ödəniş/təsdiqlənmiş sorğu + admin əl ilə əlavəsi − düzəlişlər
//   billed   — istifadəyə görə müştəriyə yazılan məbləğ (vuruq daxil)
//   free     — billed-in pulsuz aylıq hissədən çıxılan hissəsi (gəlir deyil). Bu sahə yeni yazılır: köhnə günlərdə 0-dır
//   cost     — provayderə (Claude/Gemini) ödənən real xərc, vuruqsuz
//   profit   — (billed − free) − cost
import { config, fromMicro } from "./pricing.js";
import { store } from "./storage.js";

const monthOf = (iso) => String(iso).slice(0, 7);
const monthsBack = (n) => {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
};
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
// ref ledger-də _id kimi saxlanır (təkrar-qoruma): "req:<sorğu>" = təsdiqlənmiş yükləmə sorğusu, "pay:<provayder>:…" = ödəniş şlüzü
const isPayment = (e) => { const id = String(e._id ?? ""); return id.startsWith("req:") || id.startsWith("pay:"); };
const azn = (m) => fromMicro(m);

export async function finance({ months = 6 } = {}) {
  const n = Math.min(24, Math.max(1, Math.round(Number(months) || 6)));
  const keys = monthsBack(n);
  const st = store();
  const [ledger, days, models, accounts] = await Promise.all([st.listAllLedger(), st.listAllDays(`${keys[0]}-01`), st.listModels(keys[0]), st.listAccounts()]);

  const blank = () => ({ paid: 0, manual: 0, adjust: 0, billed: 0, free: 0, cost: 0, requests: 0 });
  const byMonth = new Map(keys.map((k) => [k, blank()]));
  let cashIn = 0;
  for (const e of ledger) {
    const amount = Number(e.amount) || 0;
    cashIn += amount;
    const row = byMonth.get(monthOf(e.at));
    if (!row) continue;
    if (amount < 0) row.adjust += amount;
    else if (isPayment(e)) row.paid += amount;
    else row.manual += amount;
  }

  const since30 = daysAgo(30);
  const tenants = new Map();
  for (const d of days) {
    const row = byMonth.get(monthOf(d.date));
    if (row) { row.billed += d.billed ?? 0; row.free += d.free ?? 0; row.cost += d.cost ?? 0; row.requests += d.requests ?? 0; }
    if (d.date >= since30) {
      const t = tenants.get(d.tenantId) ?? { billed: 0, free: 0, cost: 0, requests: 0 };
      t.billed += d.billed ?? 0; t.free += d.free ?? 0; t.cost += d.cost ?? 0; t.requests += d.requests ?? 0;
      tenants.set(d.tenantId, t);
    }
  }

  const accById = new Map(accounts.map((a) => [a._id, a]));
  const monthRows = keys.map((k) => {
    const r = byMonth.get(k);
    const revenue = r.billed - r.free;
    return {
      month: k,
      cashIn: { paidAzn: azn(r.paid), manualAzn: azn(r.manual), adjustAzn: azn(r.adjust), totalAzn: azn(r.paid + r.manual + r.adjust) },
      billedAzn: azn(r.billed), freeAzn: azn(r.free), revenueAzn: azn(revenue), costAzn: azn(r.cost), profitAzn: azn(revenue - r.cost),
      marginPct: revenue > 0 ? Math.round(((revenue - r.cost) / revenue) * 1000) / 10 : null,
      requests: r.requests,
    };
  });

  const modelRows = new Map();
  for (const m of models) {
    const row = modelRows.get(m.model) ?? { model: m.model, months: Object.fromEntries(keys.map((k) => [k, 0])), cost: 0, calls: 0, tokens: 0 };
    if (m.month in row.months) row.months[m.month] += m.cost ?? 0;
    row.cost += m.cost ?? 0; row.calls += m.calls ?? 0; row.tokens += m.tokens ?? 0;
    modelRows.set(m.model, row);
  }

  const tenantRows = [...tenants.entries()].map(([tenantId, t]) => {
    const acc = accById.get(tenantId);
    const revenue = t.billed - t.free;
    return {
      tenantId, requests: t.requests,
      billedAzn: azn(t.billed), freeAzn: azn(t.free), revenueAzn: azn(revenue), costAzn: azn(t.cost), profitAzn: azn(revenue - t.cost),
      markup: acc?.markup ?? config.markup(), customMarkup: acc?.markup != null,
      balanceAzn: acc ? azn(acc.free + acc.paid) : 0,
    };
  }).filter((t) => t.costAzn > 0 || t.billedAzn > 0).sort((a, b) => a.profitAzn - b.profitAzn).slice(0, 100);

  const cur = byMonth.get(keys[keys.length - 1]);
  return {
    months: monthRows,
    models: [...modelRows.values()].sort((a, b) => b.cost - a.cost).map((r) => ({
      model: r.model, provider: /^claude/i.test(r.model) ? "anthropic" : /^gemini/i.test(r.model) ? "google" : "other",
      costAzn: azn(r.cost), calls: r.calls, tokens: r.tokens, months: Object.fromEntries(Object.entries(r.months).map(([k, v]) => [k, azn(v)])),
    })),
    tenants: tenantRows,
    totals: {
      cashInAzn: azn(cashIn),
      cashInMonthAzn: azn(cur.paid + cur.manual + cur.adjust),
      // Müştərilərin hələ xərcləmədiyi ödənişli balans: ödənilib, amma xidmət hələ göstərilməyib
      outstandingPaidAzn: azn(accounts.reduce((s, a) => s + Math.max(0, a.paid ?? 0), 0)),
      // Kredit limiti ilə mənfiyə düşmüş balanslar (müştərilərin borcu)
      creditUsedAzn: azn(accounts.reduce((s, a) => s + Math.max(0, -(a.paid ?? 0)), 0)),
      defaultMarkup: config.markup(), usdAzn: config.usdAzn(),
    },
  };
}
