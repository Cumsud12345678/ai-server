// Şəxsi məlumatı (e-poçt, telefon) maskalayır: test çıxışlarında istifadə olunur
export function maskPII(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") {
    const s = v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "***@***").replace(/\+?\d[\d\s().-]{6,}\d/g, "***tel***");
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  }
  if (Array.isArray(v)) return depth > 3 ? "[…]" : v.slice(0, 2).map((x) => maskPII(x, depth + 1));
  if (typeof v === "object") return depth > 3 ? "{…}" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskPII(x, depth + 1)]));
  return v;
}
