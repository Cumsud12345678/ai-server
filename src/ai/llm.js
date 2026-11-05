// Hibrid AI müştərisi: Claude (Anthropic) + Gemini (Google) bir interfeys arxasında.
//
// Bütün kod Gemini formatında yazılıb (client.models.generateContent / embedContent). Bu modul həmin formatı saxlayır:
//  - model adı "claude-" ilə başlayırsa → sorğu Anthropic Messages API-yə çevrilir, cavab yenidən Gemini formatına salınır;
//  - əks halda → sorğu olduğu kimi Gemini-yə gedir.
// Embedding və səs (audio) yalnız Gemini-dədir: Claude-da bunlar yoxdur.
//
// Mühit dəyişənləri:
//   ANTHROPIC_API_KEY       Claude açarı. Yoxdursa Claude modelləri ötürülür və növbəti (Gemini) model işləyir.
//   GEMINI_API_KEY          Gemini açarı (embedding, səs və ehtiyat model üçün mütləqdir).
//   AI_MODELS               Çat modelləri sırası (birincisi əsas, qalanları ehtiyat). Defolt: claude-haiku-5-5,gemini-3.5-flash-lite
//   CLAUDE_MAX_TOKENS       Claude cavabının maksimum uzunluğu (MAX_OUTPUT_TOKENS verilməyibsə). Defolt: 4096
//   CLAUDE_THINKING         off (defolt) = düşünmə söndürülür (ucuz və sürətli); auto = modelin öz defoltu
//   CLAUDE_PROMPT_CACHE     1 = sistem təlimatı və alətlər keşlənir (eyni müştəriyə 5 dəqiqədə çox sorğu gələndə sərfəlidir)
import { GoogleGenAI } from "@google/genai";

export const DEFAULT_CHAT_MODELS = "claude-haiku-5-5,gemini-3.5-flash-lite";
/** Çat/şəkil/qaralama üçün model sırası. Köhnə GEMINI_MODELS də oxunur (AI_MODELS yoxdursa). */
export const chatModels = () =>
  (process.env.AI_MODELS || process.env.GEMINI_MODELS || DEFAULT_CHAT_MODELS).split(",").map((s) => s.trim()).filter(Boolean);
/** Səs yalnız Gemini-də: siyahıdakı Claude modelləri atılır. */
export const geminiOnly = (models) => models.filter((m) => !isClaude(m));
export const isClaude = (model) => /^claude-/i.test(String(model));
/** Model sırasında növbəti modelə keçməyə dəyən xətalar. */
export const RETRYABLE = [503, 500, 429, 404, 529];

const API = () => process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const VERSION = "2023-06-01";

// ---------- Gemini sxemi → JSON Schema ----------
// Gemini "Type" dəyərləri böyük hərflə yazılmış sətirlərdir ("STRING", "OBJECT"...); Claude adi JSON Schema istəyir.
export function toJsonSchema(s) {
  if (!s || typeof s !== "object") return { type: "object", properties: {} };
  const out = {};
  if (s.type) out.type = String(s.type).toLowerCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.required?.length) out.required = s.required;
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

// ---------- Gemini contents → Claude messages ----------
function partToBlocks(part) {
  if (part.text !== undefined) return part.text ? [{ type: "text", text: String(part.text) }] : [];
  if (part.inlineData) {
    const mime = part.inlineData.mimeType;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
      const e = new Error(`Claude bu faylı qəbul etmir (${mime})`); e.status = 404; throw e; // növbəti (Gemini) modelə keçir
    }
    return [{ type: "image", source: { type: "base64", media_type: mime, data: part.inlineData.data } }];
  }
  return [];
}

export function toClaudeMessages(contents) {
  const messages = [];
  let pendingIds = []; // əvvəlki model mesajındakı alət çağırışlarının id-ləri (sıra ilə)
  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : "user";
    let blocks;
    if (role === "assistant") {
      // Claude-dan gələn mesajı olduğu kimi qaytarırıq (düşünmə blokları və tool_use id-ləri itməsin)
      if (Array.isArray(c._claude)) blocks = c._claude;
      else {
        blocks = [];
        for (const p of c.parts ?? []) {
          if (p.functionCall) blocks.push({ type: "tool_use", id: p.functionCall.id || `call_${messages.length}_${blocks.length}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
          else blocks.push(...partToBlocks(p));
        }
      }
      pendingIds = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    } else {
      blocks = [];
      let i = 0;
      for (const p of c.parts ?? []) {
        if (p.functionResponse) {
          const id = p.functionResponse.id || pendingIds[i] || `call_missing_${i}`;
          i++;
          blocks.push({ type: "tool_result", tool_use_id: id, content: JSON.stringify(p.functionResponse.response?.result ?? p.functionResponse.response ?? null) });
        } else blocks.push(...partToBlocks(p));
      }
      // Claude-da tool_result blokları mesajın əvvəlində olmalıdır
      blocks.sort((a, b) => (b.type === "tool_result") - (a.type === "tool_result"));
      pendingIds = [];
    }
    if (!blocks.length) continue;
    // Claude ardıcıl eyni rollu mesaj qəbul etmir: birləşdiririk
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  // Söhbət user mesajı ilə başlamalıdır
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}

// ---------- Claude cavabı → Gemini formatı ----------
export function fromClaudeResponse(data) {
  const blocks = data.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
  const u = data.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + cacheRead + cacheWrite; // Claude-da input_tokens keşi daxil etmir
  const output = u.output_tokens ?? 0;
  return {
    text,
    functionCalls: calls.length ? calls : undefined,
    candidates: [{ content: { role: "model", parts: [...(text ? [{ text }] : []), ...calls.map((fc) => ({ functionCall: fc }))], _claude: blocks }, finishReason: data.stop_reason }],
    usageMetadata: { promptTokenCount: prompt, cachedContentTokenCount: cacheRead, cacheWriteTokenCount: cacheWrite, candidatesTokenCount: output, totalTokenCount: prompt + output },
  };
}

// ---------- Claude çağırışı ----------
export function buildClaudeRequest({ model, contents, config = {} }) {
  const cache = process.env.CLAUDE_PROMPT_CACHE === "1";
  const decls = (config.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
  const tools = decls.map((d) => ({ name: d.name, description: d.description ?? "", input_schema: toJsonSchema(d.parameters) }));
  if (cache && tools.length) tools[tools.length - 1].cache_control = { type: "ephemeral" };
  const sys = typeof config.systemInstruction === "string" ? config.systemInstruction : config.systemInstruction?.parts?.map((p) => p.text).join("\n") ?? "";
  let maxTokens = config.maxOutputTokens || Number(process.env.MAX_OUTPUT_TOKENS) || Number(process.env.CLAUDE_MAX_TOKENS) || 4096;
  let system = sys || undefined;
  if (config.responseMimeType === "application/json") system = `${sys}\n\nYalnız etibarlı JSON qaytar, izah və ya markdown yazma.`.trim();
  if (cache && system) system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  const body = { model, max_tokens: maxTokens, messages: toClaudeMessages(contents) };
  if (system) body.system = system;
  if (tools.length) body.tools = tools;
  if ((process.env.CLAUDE_THINKING || "off") === "off") body.thinking = { type: "disabled" };
  return body;
}

async function callClaude(params) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error("ANTHROPIC_API_KEY verilməyib, Claude ötürülür"); e.status = 404; throw e; }
  const res = await fetch(`${API()}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": VERSION },
    body: JSON.stringify(buildClaudeRequest(params)),
    signal: AbortSignal.timeout(Number(process.env.CLAUDE_TIMEOUT_MS) || 60_000),
  }).catch((err) => { const e = new Error(`Claude ilə əlaqə alınmadı: ${err.message}`); e.status = 503; throw e; });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Claude ${res.status}: ${data?.error?.message ?? res.statusText}`);
    // 529 (yüklüdür) mövcud təkrar cəhd məntiqinə 503 kimi düşür; 401/403 (açar səhvdir) → Gemini-yə keçsin, bot dayanmasın
    e.status = res.status === 529 ? 503 : [401, 403].includes(res.status) ? 404 : res.status;
    if ([401, 403].includes(res.status)) console.error("[claude] açar qəbul olunmadı (401/403): ANTHROPIC_API_KEY-i yoxla");
    throw e;
  }
  return fromClaudeResponse(data);
}

// ---------- hibrid müştəri ----------
export function hybridClient(gemini) {
  return {
    models: {
      generateContent: (params) => (isClaude(params.model) ? callClaude(params) : gemini().models.generateContent(params)),
      embedContent: (params) => gemini().models.embedContent(params),
    },
  };
}

let g, hybrid;
const geminiDefault = () => (g ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
/** Bütün modulların defolt müştərisi. */
export const aiClient = () => (hybrid ??= hybridClient(geminiDefault));
