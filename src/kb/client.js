// Bilik bazası modullarının AI müştərisi. Hibriddir: "claude-" modelləri Anthropic-ə, qalanı (və embedding) Gemini-yə gedir.
// Ad tarixi səbəbdən geminiClient qalıb (testlər useGeminiClient ilə saxta müştəri verir).
import { aiClient } from "../ai/llm.js";
let injected;
export const useGeminiClient = (c) => { injected = c; };
export const geminiClient = () => injected ?? aiClient();
