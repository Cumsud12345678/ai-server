// Söhbət tarixçəsinin modelə verilməsi (elan məsləhətçisi və dəstək botu üçün ortaq).
// Kəsilən mesaj açıq işarələnir ki, model öz köhnə cavabını "yarımçıq qalıb" sanıb özbaşına düzəliş etməsin.
export const clipTurn = (text, n) => { const t = String(text ?? ""); return t.length > n ? `${t.slice(0, n).trimEnd()} […qısaldılıb]` : t; };
export const historyContents = (history, turns, n) =>
  history.slice(-turns).map((h) => ({ role: h.role === "model" ? "model" : "user", parts: [{ text: clipTurn(h.text, n) }] }));
