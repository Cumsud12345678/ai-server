// Köməkçinin üslubu: ad, ton və cavab uzunluğu (bütün prompt-larda eyni).
export const ANSWER_LENGTHS = ["short", "medium", "long"];
const LEN = {
  short: "Cavablar qısa olsun: adətən 1-3 cümlə, lazımsız giriş və təkrar yazma.",
  medium: "",
  long: "Lazım olanda ətraflı izah et: addımları, şərtləri və vacib detalları yaz, amma uydurma məlumat əlavə etmə.",
};
/** Prompt-a əlavə olunan üslub sətirləri (boş ola bilər) */
export function styleLines(p = {}, defTone = "dostcasına") {
  const out = [`Ton: ${p.tone || defTone}.`];
  if (p.agentName) out.push(`Sənin adın "${String(p.agentName).replace(/["\n]/g, "").slice(0, 40)}". Özünü təqdim edəndə bu adı işlət, AI olduğunu gizlətmə.`);
  if (LEN[p.answerLength]) out.push(LEN[p.answerLength]);
  return out.join("\n");
}
