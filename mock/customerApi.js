// SAXTA MÜŞTƏRİ API-si: bizim formatdan TAMAMİLƏ FƏRQLİ sxemlə (konnektoru sınamaq üçün).
// Fərqlər: sahə adları, qiymət obyektdir ("12 500" mətn ola bilər), kateqoriya yalnız kod verir,
// filtrlər ID ilə işləyir, qaralama (draft) elanlar da qayıdır, telefon sahəsi var.
import express from "express";

const BRANDS = [{ id: 1, title: "BMW" }, { id: 2, title: "Mercedes-Benz" }, { id: 3, title: "Toyota" }, { id: 4, title: "Hyundai" }, { id: 5, title: "Kia" }];
const CATEGORIES = [{ code: "sedan", title: "Sedan" }, { code: "suv", title: "SUV" }, { code: "hatch", title: "Hetçbek" }];
const CITIES = [{ id: 1, title: "Bakı" }, { id: 2, title: "Gəncə" }, { id: 3, title: "Sumqayıt" }];

const ad = (id, brand, model, price, year, cc, km, cat, city, color, extra = {}) => ({
  ad_id: id, state: "published",
  brand: BRANDS.find((b) => b.id === brand), model: model ? { id: id * 10, title: model } : null,
  price: { value: price, cur: "AZN" }, year, engine_cc: cc, km,
  category: { code: cat }, city: CITIES.find((c) => c.id === city),
  slug: `${BRANDS.find((b) => b.id === brand).title.toLowerCase()}-${(model ?? "x").toLowerCase().replace(/\s+/g, "-")}-${id}`,
  photos: [{ url: `/media/${id}-1.jpg` }], color: { title: color },
  contact: { name: "Satıcı", phone: "+994 50 123 45 67" }, ...extra,
});

const ADS = [
  ad(101, 1, "X5", 19500, 2008, 4800, 245000, "suv", 1, "Qara"),
  ad(102, 1, "520", 16800, 2012, 2000, 198000, "sedan", 1, "Ağ"),
  ad(103, 1, "320", 9200, 2006, 2000, 289000, "sedan", 2, "Boz"),
  ad(104, 2, "E200", 14500, 2010, 1800, 240000, "sedan", 1, "Qara"),
  ad(105, 3, "Camry", 17900, 2012, 2500, 215000, "sedan", 1, "Ağ"),
  ad(106, 3, "Corolla", 9800, 2009, 1600, 260000, "sedan", 1, "Gümüşü"),
  ad(107, 4, "Elantra", "12 500", 2013, 1800, 175000, "sedan", 1, "Ağ"),       // qiymət mətn!
  ad(108, 5, "Sportage", 15900, 2011, 2000, 205000, "suv", 3, "Qırmızı"),
  ad(109, 5, "Optima", 15500, 2014, 2400, 190000, "sedan", 1, "Qara", { photos: [] }), // şəkil yoxdur
  ad(110, 4, null, 8800, 2007, 1600, 300000, "hatch", 2, "Mavi"),                 // model yoxdur
  ad(111, 3, "Corolla", 3500, 2004, 1600, 330000, "sedan", 1, "Ağ", { state: "draft" }), // qaralama!
];

const ORDERS = {
  price_asc: (a, b) => a.price.value - b.price.value, price_desc: (a, b) => b.price.value - a.price.value,
  year_desc: (a, b) => b.year - a.year, year_asc: (a, b) => a.year - b.year, km_asc: (a, b) => a.km - b.km,
};
const n = (v) => Number(String(v).replace(/\s/g, ""));

export function createMockApi({ apiKey = process.env.DEMO_CUSTOMER_KEY || "demo-customer-secret" } = {}) {
  const app = express();
  app.use((req, res, next) => (req.get("x-api-key") === apiKey ? next() : res.status(401).json({ ok: false, error: "bad key" })));

  app.get("/api/meta", (req, res) => res.json({ brands: BRANDS, categories: CATEGORIES, cities: CITIES }));

  app.get("/api/ads", (req, res) => {
    const q = req.query;
    let items = ADS.filter((a) =>
      (!q.brand_id || a.brand.id === Number(q.brand_id)) && (!q.body || a.category.code === q.body) &&
      (!q.city_id || a.city.id === Number(q.city_id)) && (!q.price_from || n(a.price.value) >= Number(q.price_from)) &&
      (!q.price_to || n(a.price.value) <= Number(q.price_to)) && (!q.year_from || a.year >= Number(q.year_from)) &&
      (!q.year_to || a.year <= Number(q.year_to)) && (!q.km_to || a.km <= Number(q.km_to)) &&
      (!q.color || a.color.title === q.color) && (!q.colors || q.colors.split(",").includes(a.color.title)) &&
      (!q.has_photo || (q.has_photo === "1") === a.photos.length > 0) &&
      (!q.cc_from || a.engine_cc >= Number(q.cc_from)) && (!q.cc_to || a.engine_cc <= Number(q.cc_to)));
    if (ORDERS[q.order]) items = [...items].sort((a, b) => ORDERS[q.order](
      { ...a, price: { value: n(a.price.value) } }, { ...b, price: { value: n(b.price.value) } }));
    const perPage = Math.min(Number(q.per_page) || 20, 50);
    res.json({ ok: true, data: { total: items.length, items: items.slice(0, perPage) } });
  });
  return app;
}
