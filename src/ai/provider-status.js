// AI provayderlərinin (Claude, Gemini) hesab vəziyyəti: balans bitməsi, xərc limiti, açar problemi, kvota.
// Xəta gələndə növü təyin olunur və yaddaşda saxlanır; həmin provayderə ilk uğurlu sorğuda təmizlənir.
// Portal /health-dən bunu oxuyur və adminə e-poçt/Telegram xəbərdarlığı göndərir.
//
// Növlər:
//   balance — provayder hesabında pul bitib (Claude: "credit balance is too low", Gemini Prepay: balans 0)
//   limit   — provayder panelində qoyulan aylıq xərc limitinə çatılıb
//   auth    — açar səhvdir, silinib və ya hesab bloklanıb
//   quota   — sorğu kvotası/sürət həddi (429). Adətən keçicidir: yalnız qısa müddətdə çox təkrarlananda vacibdir

/** @type {Map<"claude"|"gemini", { kind: string, message: string, since: string, last: string, count: number }>} */
const issues = new Map();

export const providerOf = (model) => (/^claude-/i.test(String(model)) ? "claude" : "gemini");

/** Xətanın növünü təyin edir. Provayder hesabı ilə bağlı deyilsə null. */
export function classify(provider, err) {
  const status = Number(err?.status ?? err?.code) || 0;
  const msg = String(err?.message ?? "");
  if (provider === "claude") {
    if (/credit balance is too low/i.test(msg)) return "balance";
    if (/usage limit|spend(ing)? limit|workspace.*limit/i.test(msg)) return "limit";
    if (status === 401 || status === 403 || /authentication|invalid x-api-key|permission/i.test(msg)) return "auth";
    if (status === 429) return "quota";
    return null;
  }
  if (/prepay|prepaid|credit balance|insufficient (funds|balance|credit)|billing account|billing.*(disabled|not enabled|required)/i.test(msg)) return "balance";
  if (/spend(ing)? (cap|limit)/i.test(msg)) return "limit";
  if (/API key (not valid|expired|invalid)|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg) || status === 401 || status === 403) return "auth";
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return "quota";
  return null;
}

export function recordFailure(provider, err) {
  const kind = classify(provider, err);
  if (!kind) return null;
  const now = new Date().toISOString();
  const cur = issues.get(provider);
  // Eyni növ davam edirsə sayğac artır; növ dəyişibsə (məs. kvota → balans) yeni hadisə sayılır
  if (cur && cur.kind === kind) issues.set(provider, { ...cur, message: String(err?.message ?? "").slice(0, 300), last: now, count: cur.count + 1 });
  else issues.set(provider, { kind, message: String(err?.message ?? "").slice(0, 300), since: now, last: now, count: 1 });
  if (kind !== "quota") console.error(`[${provider}] hesab problemi (${kind}): ${String(err?.message ?? "").slice(0, 200)}`);
  return kind;
}

export function recordSuccess(provider) { issues.delete(provider); }

/** Portal üçün: hazırkı problemlər. Kvota yalnız son 15 dəqiqədə 5+ dəfə təkrarlanıbsa göstərilir (tək-tük 429 normaldır). */
export function providerIssues() {
  const out = {};
  const recent = Date.now() - 15 * 60_000;
  for (const [p, v] of issues) {
    if (v.kind === "quota" && (v.count < 5 || Date.parse(v.last) < recent)) continue;
    out[p] = { ...v };
  }
  return out;
}

export const _resetProviderIssues = () => issues.clear();
