// Təsdiq gözləyən əməliyyatlar. Yalnız server saxlayır: model və ziyarətçi parametrləri sonradan dəyişə bilməz,
// ziyarətçi yalnız "bəli/xeyr" deyir. Birdəfəlik və qısaömürlüdür. (Tək proses üçün: yaddaşda.)
import crypto from "node:crypto";

const TTL_MS = () => (Number(process.env.ACTION_PENDING_TTL_S) || 600) * 1000;
const MAX = 5000;
const store = new Map(); // id -> record
const bySession = new Map(); // `${tenantId}|${sid}` -> id

const gc = (now) => {
  for (const [id, p] of store) if (p.expiresAt <= now) { store.delete(id); if (bySession.get(p.sessionKey) === id) bySession.delete(p.sessionKey); }
  while (store.size > MAX) { const id = store.keys().next().value; const p = store.get(id); store.delete(id); if (p && bySession.get(p.sessionKey) === id) bySession.delete(p.sessionKey); }
};

/** Hər söhbətdə eyni anda yalnız 1 gözləyən əməliyyat var: yenisi köhnəni əvəz edir. */
export function createPending({ tenantId, sid, key, values, subject, channel, card }, now = Date.now()) {
  gc(now);
  const sessionKey = `${tenantId}|${sid}`;
  const old = bySession.get(sessionKey);
  if (old) store.delete(old);
  const id = crypto.randomBytes(16).toString("hex");
  const p = { id, tenantId, sid, key, values, subject: subject ?? null, channel: channel ?? null, card, sessionKey, createdAt: now, expiresAt: now + TTL_MS() };
  store.set(id, p); bySession.set(sessionKey, id);
  return p;
}

export function getPending(id, now = Date.now()) {
  const p = typeof id === "string" ? store.get(id) : null;
  if (!p) return null;
  if (p.expiresAt <= now) { store.delete(id); if (bySession.get(p.sessionKey) === id) bySession.delete(p.sessionKey); return null; }
  return p;
}

export function dropPending(id) {
  const p = store.get(id);
  if (!p) return;
  store.delete(id);
  if (bySession.get(p.sessionKey) === id) bySession.delete(p.sessionKey);
}

export const pendingTtlS = () => Math.round(TTL_MS() / 1000);
export const resetPending = () => { store.clear(); bySession.clear(); };
