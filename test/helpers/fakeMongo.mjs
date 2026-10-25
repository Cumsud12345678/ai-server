// Sürücünün istifadə etdiyimiz əməliyyatlarının yaddaş nüsxəsi (bərabərlik/$gte filtrləri, sort/limit, $set/$inc/$setOnInsert, upsert, dublikat açar).
// DİQQƏT: bu real MongoDB deyil: yalnız məntiqin (CAS, təkrar-qoruması) düzgünlüyünü yoxlayır.
export function fakeMongo({ latency = 0 } = {}) {
  const data = new Map();
  const get = (n) => data.get(n) ?? data.set(n, new Map()).get(n);
  const tick = () => (latency ? new Promise((r) => setTimeout(r, Math.random() * latency)) : Promise.resolve());
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const matches = (d, f) => Object.entries(f).every(([k, v]) => {
    if (v && typeof v === "object" && "$gte" in v) return cmp(d[k], v.$gte) >= 0;
    return d[k] === v;
  });
  const apply = (doc, upd) => {
    for (const [op, fields] of Object.entries(upd)) {
      for (const [k, v] of Object.entries(fields)) {
        if (op === "$set") doc[k] = structuredClone(v);
        else if (op === "$inc") doc[k] = (doc[k] ?? 0) + v;
      }
    }
  };
  const collection = (name) => {
    const c = get(name);
    return {
      createIndex: async () => {},
      insertOne: async (doc) => {
        await tick();
        if (c.has(doc._id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        c.set(doc._id, structuredClone(doc));
      },
      findOne: async (f) => { await tick(); const r = [...c.values()].find((d) => matches(d, f)); return r ? structuredClone(r) : null; },
      updateOne: async (f, upd, opts = {}) => {
        await tick();
        let d = [...c.values()].find((x) => matches(x, f));
        if (!d && opts.upsert) { d = { _id: f._id, ...structuredClone(upd.$setOnInsert ?? {}) }; c.set(d._id, d); apply(d, { $inc: upd.$inc ?? {}, $set: upd.$set ?? {} }); return { matchedCount: 0, upsertedCount: 1 }; }
        if (!d) return { matchedCount: 0, modifiedCount: 0 };
        apply(d, { $set: upd.$set ?? {}, $inc: upd.$inc ?? {} });
        return { matchedCount: 1, modifiedCount: 1 };
      },
      deleteMany: async (f) => { for (const [k, d] of c) if (matches(d, f)) c.delete(k); },
      find: (f = {}) => {
        let rows = [...c.values()].filter((d) => matches(d, f)).map((d) => structuredClone(d));
        const cur = {
          sort: (s) => { const [[k, dir]] = Object.entries(s); rows.sort((a, b) => dir * cmp(a[k], b[k])); return cur; },
          limit: (n) => { rows = rows.slice(0, n); return cur; },
          toArray: async () => { await tick(); return rows; },
        };
        return cur;
      },
    };
  };
  return { collection };
}
