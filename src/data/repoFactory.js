// Müştərinin konfiqurasiyasına görə düzgün data mənbəyini qaytarır.
// Hər mənbə eyni interfeysə malikdir: { schema, supportedFilters, sortFields, search(filters), vocabulary() }
import { LEGACY_SCHEMA, FILTER_KEYS } from "./filters.js";

const repos = new Map();

// Konfiqurasiya dəyişəndə köhnə repo (və onun cache-i) atılır.
export const dropRepo = (tenantId) => repos.delete(tenantId);

export async function getRepo(tenant) {
  const id = tenant.tenantId;
  if (repos.has(id)) return repos.get(id);
  const type = tenant.source?.type;
  let repo;
  if (type === "memory" || type === "mongo") {
    const m = await import(type === "memory" ? "./memoryRepo.js" : "./mongoRepo.js");
    repo = { schema: LEGACY_SCHEMA, supportedFilters: FILTER_KEYS, sortFields: LEGACY_SCHEMA.sortFields, search: m.search, vocabulary: m.vocabulary };
  } else if (type === "rest") {
    const { createRestRepo } = await import("../connectors/restRepo.js");
    repo = createRestRepo(tenant);
  } else if (type === "feed") {
    const { createFeedRepo } = await import("../connectors/feedRepo.js");
    const { getFeed } = await import("../connectors/feedStore.js");
    const stored = await getFeed(id);
    if (!stored?.items?.length) throw new Error("Feed məlumatı tapılmadı");
    repo = createFeedRepo(tenant, stored.items);
  } else {
    throw new Error(`Naməlum data mənbəyi tipi: ${type}`);
  }
  repos.set(id, repo);
  return repo;
}
