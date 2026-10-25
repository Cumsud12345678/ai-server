// Gemini embedding: sənəd hissələri və sorğu üçün vektorlar (L2-normallaşdırılmış, cosine = dot product).
import { geminiClient } from "./client.js";

const MODEL = () => process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const DIM = () => Number(process.env.GEMINI_EMBED_DIM) || 768;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => Math.round((x / n) * 1e5) / 1e5);
}

async function embedBatch(client, texts, taskType) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.models.embedContent({
        model: MODEL(), contents: texts, config: { taskType, outputDimensionality: DIM() },
      });
      const out = res.embeddings?.map((e) => e.values);
      if (!out || out.length !== texts.length) throw new Error("Embedding cavabı natamamdır");
      return out.map(normalize);
    } catch (err) {
      if (![429, 500, 503].includes(err.status) || attempt >= 3) throw err;
      await sleep(1500 * 2 ** attempt);
    }
  }
}

export async function embedDocuments(texts, client = geminiClient()) {
  const out = [];
  for (let i = 0; i < texts.length; i += 50) out.push(...(await embedBatch(client, texts.slice(i, i + 50), "RETRIEVAL_DOCUMENT")));
  return out;
}
export async function embedQuery(text, client = geminiClient()) {
  return (await embedBatch(client, [text], "RETRIEVAL_QUERY"))[0];
}
