// Nümunə JSON-dan oxuyur (DATA_SOURCE=memory).
import { readFile } from "node:fs/promises";
import { toPublic } from "./filters.js";

const FILE = new URL("../../data/sample-listings.json", import.meta.url);
let cache;
async function load() {
  if (!cache) cache = JSON.parse(await readFile(FILE, "utf8"));
  return cache;
}
const norm = (s) => String(s ?? "").trim().toLowerCase();

export async function search(f) {
  let r = (await load()).filter((x) => x.active !== false);
  if (f.make) r = r.filter((x) => norm(x.make).includes(norm(f.make)));
  if (f.model) r = r.filter((x) => norm(x.model).includes(norm(f.model)));
  if (f.bodyType) r = r.filter((x) => norm(x.bodyType) === norm(f.bodyType));
  if (f.city) r = r.filter((x) => norm(x.city) === norm(f.city));
  if (f.fuelType) r = r.filter((x) => norm(x.fuelType) === norm(f.fuelType));
  if (f.transmission) r = r.filter((x) => norm(x.transmission) === norm(f.transmission));
  if (f.minPrice !== undefined) r = r.filter((x) => x.price >= f.minPrice);
  if (f.maxPrice !== undefined) r = r.filter((x) => x.price <= f.maxPrice);
  if (f.minYear !== undefined) r = r.filter((x) => x.year >= f.minYear);
  if (f.maxYear !== undefined) r = r.filter((x) => x.year <= f.maxYear);
  if (f.maxMileage !== undefined) r = r.filter((x) => x.mileage <= f.maxMileage);

  const dir = f.sortDir === "desc" ? -1 : 1;
  r.sort((a, b) => (a[f.sortBy] - b[f.sortBy]) * dir);
  return r.slice(0, f.limit).map(toPublic);
}

export async function vocabulary() {
  const all = (await load()).filter((x) => x.active !== false);
  const uniq = (k) => [...new Set(all.map((x) => x[k]).filter(Boolean))].sort();
  return { makes: uniq("make"), categories: uniq("bodyType"), cities: uniq("city"),
    fuelTypes: uniq("fuelType"), transmissions: uniq("transmission") };
}
