// Köməkçinin üslubu: ad, ton və cavab uzunluğu (bütün prompt-larda eyni).
export const ANSWER_LENGTHS = ["short", "medium", "long"];
const LEN = {
  short: "Cavablar qısa olsun: adətən 1-3 cümlə, lazımsız giriş və təkrar yazma.",
  medium: "",
  long: "Lazım olanda ətraflı izah et: addımları, şərtləri və vacib detalları yaz, amma uydurma məlumat əlavə etmə.",
};
/** Şirkətin əlaqə məlumatı (paneldə "Şirkət məlumatı"): sahə → [etiket, maksimum uzunluq] */
export const COMPANY_FIELDS = {
  phone: ["Telefon", 40], whatsapp: ["WhatsApp", 40], email: ["E-poçt", 80], address: ["Ünvan", 200], city: ["Şəhər", 60],
  hours: ["İş saatları", 200], website: ["Sayt", 120], instagram: ["Instagram", 120], facebook: ["Facebook", 120], about: ["Şirkət haqqında", 600],
};
export function validateCompany(v) {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "profile.company obyekt olmalıdır";
  for (const [k, val] of Object.entries(v)) {
    const f = COMPANY_FIELDS[k];
    if (!f) return `profile.company.${k} tanınmır`;
    if (typeof val !== "string" || val.length > f[1]) return `profile.company.${k} mətn olmalıdır (maksimum ${f[1]} simvol)`;
  }
  return null;
}
export function cleanCompany(v) {
  if (!v) return undefined;
  const out = {};
  for (const k of Object.keys(COMPANY_FIELDS)) { const s = typeof v[k] === "string" ? v[k].replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim() : ""; if (s) out[k] = s; }
  return Object.keys(out).length ? out : undefined;
}
function companyLines(c) {
  const rows = Object.entries(COMPANY_FIELDS).filter(([k]) => c?.[k]).map(([k, [label]]) => `- ${label}: ${String(c[k]).replace(/\n+/g, " ")}`);
  return rows.length ? `Şirkətin rəsmi əlaqə məlumatı (müştəri ünvan, telefon, iş saatı, sosial şəbəkə soruşanda yalnız bunu işlət, başqa nömrə və ya ünvan uydurma):\n${rows.join("\n")}` : "";
}

/** Prompt-a əlavə olunan üslub sətirləri (boş ola bilər) */
export function styleLines(p = {}, defTone = "dostcasına") {
  const out = [`Ton: ${p.tone || defTone}.`];
  if (p.agentName) out.push(`Sənin adın "${String(p.agentName).replace(/["\n]/g, "").slice(0, 40)}". Özünü təqdim edəndə bu adı işlət, AI olduğunu gizlətmə.`);
  if (LEN[p.answerLength]) out.push(LEN[p.answerLength]);
  const c = companyLines(p.company);
  if (c) out.push(c);
  return out.join("\n");
}
