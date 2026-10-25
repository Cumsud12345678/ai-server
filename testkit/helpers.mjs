import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMockApi } from "../mock/customerApi.js";

process.env.ALLOW_LOCAL_CONNECTORS = "1";
process.env.DEMO_CUSTOMER_KEY = "test-secret";

export async function startMock() {
  const server = await new Promise((res) => { const s = createMockApi({ apiKey: "test-secret" }).listen(0, () => res(s)); });
  return { server, url: `http://localhost:${server.address().port}` };
}
export const demoTenant = (baseUrl) => {
  const list = JSON.parse(readFileSync(new URL("../src/tenants/tenants.json", import.meta.url), "utf8"));
  const t = structuredClone(list.find((x) => x.tenantId === "demo-musteri"));
  t.source.baseUrl = baseUrl;
  return t;
};
export const tmpFile = (name, content) => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "ca-")), name);
  writeFileSync(f, content);
  return f;
};
