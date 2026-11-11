// Ağıllı operator çağırışı: AI söhbəti canlı operatora (və ya iş saatından kənar əlaqə formasına) ötürür və SƏBƏBİNİ deyir.
// Səbəblər: asked (müştəri özü istədi, həmişə aktiv), cant_help (kömək edə bilmir), upset (narazı/əsəbi), ready_to_buy (almağa/ödəməyə hazır).
// Hansı səbəblərin aktiv olduğunu sahib paneldə seçir; portal hər sorğuda göndərir. Açıq API-də (portal yoxdur) yalnız asked + cant_help.
import { Type } from "@google/genai";

export const HANDOFF_TOOL = "request_operator";
export const HANDOFF_REASONS = ["asked", "cant_help", "upset", "ready_to_buy"];
const DEFAULT_RULES = { cantHelp: true, upset: false, ready: false };

/** Portalın göndərdiyi qaydalar (yoxdursa köhnə davranış: yalnız istəyəndə və kömək edə bilməyəndə) */
export function cleanHandoffRules(v) {
  if (!v || typeof v !== "object") return { ...DEFAULT_RULES };
  return { cantHelp: v.cantHelp !== false, upset: v.upset === true, ready: v.ready === true };
}

const enabledReasons = (r) => ["asked", ...(r.cantHelp ? ["cant_help"] : []), ...(r.upset ? ["upset"] : []), ...(r.ready ? ["ready_to_buy"] : [])];

export function handoffDeclaration(rules, { orderForm = false } = {}) {
  const r = cleanHandoffRules(rules);
  const when = [
    "istifadəçi canlı operatorla, insanla və ya menecerlə danışmaq istəyəndə ('operatora bağla', 'adminlə danışım', 'zəng edin') — reason: asked",
    ...(r.cantHelp ? ["sualına kömək edə bilmirsənsə (məlumat yoxdur, səlahiyyətin xaricindədir) — reason: cant_help"] : []),
    ...(r.upset ? ["istifadəçi açıq şəkildə narazı, əsəbi və ya şikayətçidirsə (təhqir, 'heç kim cavab vermir', 'pulumu qaytarın', təkrarlanan şikayət) — reason: upset"] : []),
    ...(r.ready ? [`istifadəçi almağa, ödəməyə və ya sifarişi rəsmiləşdirməyə hazırdırsa ('necə ödəyim', 'götürürəm', 'kartla ödəmək istəyirəm')${orderForm ? ", AMMA sifariş forması ilə qəbul edə bilirsənsə əvvəl onu doldur, operatoru yalnız forma ilə həll olunmayan halda çağır" : ""} — reason: ready_to_buy`] : []),
  ];
  return {
    name: HANDOFF_TOOL,
    description: `Söhbəti canlı operatora ötürür (operator yoxdursa istifadəçiyə əlaqə formu göstərilir). Bu hallarda çağır: ${when.join("; ")}. Operatora özün birbaşa qoşa bilmirsən: bunu bu alət edir.`,
    parameters: { type: Type.OBJECT, properties: {
      reason: { type: Type.STRING, enum: enabledReasons(r), description: "Səbəb" },
      note: { type: Type.STRING, description: "Operator üçün 1 cümlə: nə istəyir, nəyə narazıdır" },
    }, required: ["reason"] },
  };
}

/** Sistem təlimatına əlavə sətir */
export function handoffPrompt(rules) {
  const r = cleanHandoffRules(rules);
  const extra = [r.upset && "istifadəçi narazı və ya əsəbidirsə", r.ready && "almağa və ya ödəməyə hazırdırsa", r.cantHelp && "kömək edə bilmirsənsə"].filter(Boolean);
  return `İstifadəçi operatorla, canlı insanla və ya menecerlə danışmaq istəyirsə ${extra.length ? `və ya ${extra.join(", ")} ` : ""}${HANDOFF_TOOL} funksiyasını uyğun səbəblə çağır, "qoşa bilmirəm" deyib bitirmə. Əsəbi istifadəçi ilə mübahisə etmə, üzr istə və ötür.`;
}

/** Alət çağırışı: ctx.handoff + ctx.handoffReason qoyur. Söndürülmüş səbəblə ötürmə olmur (model söhbəti davam etdirir). */
export function runHandoff(args, ctx, rules, live) {
  const r = cleanHandoffRules(rules);
  const reason = HANDOFF_REASONS.includes(args?.reason) ? args.reason : "asked";
  if (!enabledReasons(r).includes(reason)) return { ok: false, note: "Bu səbəblə operatora ötürmə aktiv deyil. Söhbəti özün nəzakətlə davam etdir." };
  ctx.handoff = true;
  ctx.handoffReason = reason;
  if (typeof args?.note === "string" && args.note.trim()) ctx.handoffNote = args.note.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  return live
    ? { ok: true, note: "Söhbət canlı operatora ötürülür. Qısa və mehriban de ki, operator tezliklə burada yazacaq, bir az gözləsin. Əlavə sual vermə." }
    : { ok: true, note: "İstifadəçiyə əlaqə formu göstəriləcək. Qısa de: operatora birbaşa qoşa bilmirsən, amma telefon və ya e-poçt qoysa operator onunla əlaqə saxlayacaq." };
}
