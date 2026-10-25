import test from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

process.env.USAGE_FILE = tmpFile("usage-rate.json", "{}");

test("dəqiqəlik limit birbaşa API üçün işləyir, portal (vidjet) trafikində isə atlanır", async () => {
  const { checkAndCount } = await import("../src/usage/usage.js");
  const direct = { tenantId: "rate-direct", limits: { ratePerMinute: 2 } };
  assert.equal((await checkAndCount(direct)).ok, true);
  assert.equal((await checkAndCount(direct)).ok, true);
  const third = await checkAndCount(direct);
  assert.equal(third.ok, false);
  assert.equal(third.code, "RATE_LIMIT");

  const portal = { tenantId: "rate-portal", limits: { ratePerMinute: 2 } };
  for (let i = 0; i < 10; i++) assert.equal((await checkAndCount(portal, { skipRate: true })).ok, true, `portal sorğusu ${i + 1}`);
});
