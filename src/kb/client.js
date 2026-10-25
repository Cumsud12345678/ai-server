import { GoogleGenAI } from "@google/genai";
let ai, injected;
export const useGeminiClient = (c) => { injected = c; };
export const geminiClient = () => injected ?? (ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
