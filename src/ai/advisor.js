import { createHash } from "node:crypto";
import { GoogleGenAI, Type } from "@google/genai";
import { buildToolDeclaration, runTool } from "./searchTool.js";
import { kbToolDeclaration, runKbTool, sourcesOf } from "../kb/answer.js";
import { newMeter } from "../billing/pricing.js";
import { privateDeclarations, privatePrompt, privateToolNames, runPrivateTool } from "../private/privateData.js";

// Ziyarətçi operatorla danışmaq istəyəndə və ya köməkçi kömək edə bilməyəndə çağırılır: vidjet əlaqə formasını göstərir.
const handoffDeclaration = {
  name: "request_operator",
  description: "İstifadəçi canlı operatorla, insanla və ya satıcı/menecerlə danışmaq istəyəndə ('operatora bağla', 'adminlə danışım', 'zəng edin') VƏ YA sən sualına kömək edə bilmirsənsə çağır. Bu, istifadəçiyə əlaqə formasını göstərir. Operatora özün qoşa bilmirsən, bunu istifadəçiyə deyə.",
  parameters: { type: Type.OBJECT, properties: { reason: { type: Type.STRING, description: "Qısa səbəb" } } },
};

const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash,gemini-3-flash-preview")
  .split(",").map((s) => s.trim()).filter(Boolean);

const HISTORY_TURNS = Number(process.env.HISTORY_TURNS) || 6;
const HISTORY_CHARS = Number(process.env.HISTORY_CHARS) || 700;
// DİQQƏT: Gemini-də "düşünmə" tokenləri də bu limitə daxildir; kiçik limit cavabı yarımçıq kəsir. Defolt: limitsiz.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || null;
// Gemini "düşünmə" tokenlərini məhdudlaşdırmaq üçün (ixtiyari; modelə görə dəstəklənməyə bilər)
const THINKING_BUDGET = process.env.GEMINI_THINKING_BUDGET !== undefined && process.env.GEMINI_THINKING_BUDGET !== "" ? Number(process.env.GEMINI_THINKING_BUDGET) : null;
const CACHE_TTL_MS = (Number(process.env.ANSWER_CACHE_SECONDS) || 300) * 1000;

const answerCache = new Map();
const cacheKey = (tenant, message) =>
  `${tenant.tenantId}|${createHash("sha1").update(JSON.stringify([tenant.profile, tenant.source])).digest("hex").slice(0, 12)}|${message.toLowerCase().replace(/\s+/g, " ").replace(/[?!.,;]+$/g, "").trim()}`;

// Müştərinin seçdiyi dil DEFOLT dildir. İstifadəçi başqa dildə (rus, ingilis, türk və s.) yazırsa, həmin dildə cavab verilir.
const LANG = {
  az: "Defolt dil Azərbaycan dilidir (Latın əlifbası). İstifadəçi başqa dildə (rus, ingilis, türk və s.) yazırsa, onun yazdığı dildə cavab ver; dil bəlli deyilsə Azərbaycan dilində yaz. Azərbaycanca yazanda başqa əlifba və dildən söz qarışdırma. Düzgün yazılış: büdcə (büdçə yox), düşünə.",
  en: "The default language is English. If the user writes in another language (Russian, Azerbaijani, Turkish, etc.), answer in the language they used; if the language is unclear, use English.",
  ru: "Язык по умолчанию — русский. Если пользователь пишет на другом языке (азербайджанском, английском, турецком и т. д.), отвечай на языке пользователя; если язык неясен, отвечай по-русски.",
};

function baseSystem(tenant) {
  const p = tenant.profile ?? {};
  const max = Math.min(p.maxResults ?? 10, 20);
  return `Sən ${p.businessName ? p.businessName + " saytı üçün " : ""}${p.domain ?? "elanlar"} üzrə seçim məsləhətçisisən (saytda elan, məhsul və ya xidmət ola bilər; hamısına "elan" deyirik).
İstifadəçinin sorğusuna uyğun elanları yalnız search_listings funksiyası ilə tap.
Cavabda yalnız funksiyanın qaytardığı elanlardan istifadə et, heç nə uydurma. Funksiya xəta qaytarsa, bunu istifadəçiyə bildir.
Hər elan üçün ad və qiyməti, sonra yalnız elanda həqiqətən olan və istifadəçiyə lazım olan sahələri göstər (attributes daxil; məsələn il, yürüş, şəhər, rəng, ölçü, material, zəmanət). Elanda olmayan sahəni yazma və uydurma. Link sahəsi (url) varsa göstər, yoxdursa link yazma və uydurma.
Rəyi yalnız elanın özündəki məlumatlara (qiymət və digər sahələr) əsasla və həm üstünlüyünü, həm də çatışmazlığını yaz (məsələn yüksək qiymət, köhnə il, qısa zəmanət).
${p.generalKnowledge === false
    ? "Brendin reputasiyası, etibarlılığı və ya servisi haqqında ümumi iddialar yazma."
    : `İstifadəçi elanlarla bağlı ümumi sual verirsə (marka və ya modelin ümumi xüsusiyyətləri, tipik üstün və çatışmayan cəhətlər, seçim məsləhəti, məhsul növləri arasında fərq), öz ümumi biliyindən qısa və faydalı cavab ver. Bu cavabı elanlardan ayır və "Bu ümumi məlumatdır, konkret elanda təsdiqlənməyib" qeydini əlavə et. Əmin olmadığın şeyi iddia etmə, "dəqiq bilmirəm" de. Konkret elanın vəziyyəti, qiyməti və ya satıcı haqqında bilmədiyin heç nə yazma. Rəqiblər, hüquqi, tibbi və maliyyə məsləhəti vermə. Sənin sahənlə əlaqəsiz suallara (kod, siyasət, şeir və s.) nəzakətlə yalnız bu saytın mövzusunda kömək edə bildiyini de. Sonda uyğun elanları göstərməyi təklif et.`}
Elanda mühərrik həcmi (volume) varsa və 20-dən böyükdürsə sm³, kiçikdirsə litr kimi yaz.
Ən çox ${max} elan göstər. Əgər nəticə 3-dən azdırsa, qiymət həddini təxminən 50% artırıb ikinci axtarış et və həmin elanları "büdcədən bir az yuxarı variantlar" başlığı altında ayrıca göstər.
Axtarışı necə apardığını (filtr, limit, ikinci axtarış) izah etmə, yalnız nəticəni göstər.
Uyğun elan yoxdursa, bunu açıq de və filtri necə genişləndirməyi təklif et.
Sorğu çox qeyri-dəqiqdirsə, əvvəlcə bir qısa aydınlaşdırıcı sual ver.
Satıcının telefonu və şəxsi məlumatı sənə verilmir, istifadəçini elan linkinə yönləndir.
İstifadəçi operatorla, canlı insanla və ya menecerlə danışmaq istəyirsə request_operator funksiyasını çağır, "qoşa bilmirəm" deyib bitirmə.
${p.mode === "both" ? `Şirkət haqqında suallara (çatdırılma, ödəniş, qaydalar, əlaqə, necə işləyir və s.) search_knowledge funksiyası ilə cavab ver və yalnız onun qaytardığı məlumata əsaslan; tapılmasa bilmədiyini de, uydurma. Elan axtarışı üçün search_listings istifadə et.\n` : ""}Ton: ${p.tone ?? "dostcasına"}.
${LANG[tenant.language] ?? LANG.az}${p.extraInstructions ? "\n" + p.extraInstructions : ""}`;
}

async function buildSystem(tenant, repo) {
  let v = {};
  try { v = (await repo.vocabulary?.()) ?? {}; } catch (e) { console.warn(`[vocab] ${tenant.tenantId}:`, e.message); }
  const LABELS = { makes: "Markalar", categories: "Kateqoriyalar", cities: "Şəhərlər", fuelTypes: "Yanacaq növləri", transmissions: "Sürətlər qutusu" };
  // Böyük siyahılar (yüzlərlə model) hər Gemini çağırışında token yandırır: onları prompta qoymuruq,
  // ad serverdə özü ID-yə çevrilir (dəqiq, sonra "ehtiva edir" uyğunluğu).
  const MAX_INLINE = Number(process.env.VOCAB_INLINE_MAX) || 60;
  const vocab = Object.entries(v)
    .filter(([, arr]) => Array.isArray(arr) && arr.length && new Set(arr).size <= MAX_INLINE)
    .map(([k, arr]) => `${LABELS[k] ?? k}: ${[...new Set(arr)].join(", ")}`).join("\n");
  const textArg = repo.schema?.args?.find((a) => a.kind === "text");
  const base = baseSystem(tenant) + (textArg
    ? `\n"${textArg.name}" sərbəst mətn axtarışıdır: yalnız digər filtrlərlə ifadə oluna bilməyən təsvir üçün doldur (məs. "su keçirməyən", "qış üçün"). Marka, qiymət kimi aydın şərtləri ona yazma. Nəticə 0-dırsa, onu çıxarıb və ya sadələşdirib bir dəfə yenidən axtar.`
    : "");
  return vocab
    ? `${base}\n\nBazadakı DƏQİQ dəyərlər (filtrdə yalnız bunlardan istifadə et; istifadəçi qısa və ya fərqli yazsa ən yaxın dəyəri seç, məs. "Mers" → "Mercedes-Benz"):\n${vocab}`
    : base;
}

let ai;
const defaultClient = () => (ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateWithRetry(client, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.models.generateContent(params);
    } catch (err) {
      if (!(err.status === 503 || err.status === 500) || attempt >= 2) throw err;
      const wait = 1500 * 2 ** attempt;
      console.warn(`[gemini] ${err.status}, ${wait}ms sonra təkrar (${params.model})`);
      await sleep(wait);
    }
  }
}

async function runWithModel(client, model, { tenant, repo, system, message, history, meter, identity, live = false }) {
  const ctx = { listings: [] };
  const both = tenant.profile?.mode === "both";
  const tools = [buildToolDeclaration(repo.schema), ...(both ? [kbToolDeclaration] : []), ...(identity ? privateDeclarations(tenant) : []), handoffDeclaration];
  const contents = [
    ...history.slice(-HISTORY_TURNS).map((h) => ({ role: h.role === "model" ? "model" : "user", parts: [{ text: String(h.text).slice(0, HISTORY_CHARS) }] })),
    { role: "user", parts: [{ text: message }] },
  ];

  for (let i = 0; i < 6; i++) {
    const response = await generateWithRetry(client, {
      model, contents,
      config: {
        systemInstruction: system, tools: [{ functionDeclarations: tools }],
        ...(MAX_OUTPUT_TOKENS && { maxOutputTokens: MAX_OUTPUT_TOKENS }),
        ...(THINKING_BUDGET !== null && { thinkingConfig: { thinkingBudget: THINKING_BUDGET } }),
      },
    });
    meter.add(model, response.usageMetadata); // real xərc: giriş/çıxış/düşünmə tokenləri ayrı qiymətlə

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) return { text: response.text, ctx };

    contents.push(response.candidates[0].content); // olduğu kimi qaytar
    const parts = [];
    for (const call of calls) {
      const result = call.name === handoffDeclaration.name ? (ctx.handoff = true, live ? { ok: true, note: "Söhbət canlı operatora ötürülür. Qısa və mehriban de ki, operator tezliklə burada yazacaq, bir az gözləsin. Əlavə sual vermə." } : { ok: true, note: "İstifadəçiyə əlaqə formu göstəriləcək. Qısa de: operatora birbaşa qoşa bilmirsən, amma aşağıdakı formada telefon və ya email qoysa operator onunla əlaqə saxlayacaq." }) : call.name === kbToolDeclaration.name ? await runKbTool(tenant, call.args, ctx, client) : privateToolNames.has(call.name) ? await runPrivateTool(tenant, identity, call.name, call.args, ctx) : await runTool(repo, tenant, call.name, call.args, ctx);
      parts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: "user", parts });
  }
  throw new Error("Model cavab verə bilmədi (çox dövr)");
}

// Qaytarır: { answer, listings, tokens }.  client: test üçün saxta Gemini müştərisi vermək olar
export async function advise({ tenant, repo, message, history = [], identity = null, live = false }, client = defaultClient()) {
  // Eyni sual (söhbət tarixçəsi yoxdur) qısa müddət keşdən verilir: token xərcləmir
  const key = !identity && history.length === 0 && CACHE_TTL_MS > 0 && tenant.profile?.mode !== "both" ? cacheKey(tenant, message) : null;
  const hit = key && answerCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { answer: hit.answer, listings: hit.listings, searched: hit.searched ?? true, tokens: 0, costUsd: 0, cached: true };

  const system = (await buildSystem(tenant, repo)) + privatePrompt(tenant, identity);
  const meter = newMeter(); // uğursuz model cəhdlərinin xərci də hesaba düşür
  let lastErr;
  for (const model of MODELS) {
    try {
      const { text, ctx } = await runWithModel(client, model, { tenant, repo, system, message, history, meter, identity, live });
      const seen = new Set();
      const listings = ctx.listings.filter((l) => !seen.has(l.id) && seen.add(l.id));
      const answer = text || "Cavab hazırlana bilmədi, zəhmət olmasa yenidən cəhd edin.";
      if (key && text && !ctx.failed && !ctx.handoff && !ctx.private) {
        if (answerCache.size > 500) answerCache.clear();
        answerCache.set(key, { at: Date.now(), answer, listings, searched: Boolean(ctx.searched) });
      }
      const sources = ctx.kbHits?.length ? sourcesOf(ctx.kbHits, []) : [];
      return { answer, listings, searched: Boolean(ctx.searched), tokens: meter.tokens, costUsd: meter.costUsd, ...(sources.length && { sources }), ...(ctx.handoff && { unanswered: true, handoff: true }), ...(ctx.private && { private: true }) };
    } catch (err) {
      lastErr = err;
      if ([503, 500, 429, 404].includes(err.status)) { console.warn(`[gemini] ${model} alınmadı (${err.status}), növbəti model`); continue; }
      throw err;
    }
  }
  throw lastErr;
}
