import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, assertSafeUrl } from "../src/connectors/safeFetch.js";

test("isPrivateIp", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
});
test("assertSafeUrl: istehsal rejimində http və daxili ünvanlar bloklanır", async () => {
  delete process.env.ALLOW_LOCAL_CONNECTORS;
  await assert.rejects(assertSafeUrl("http://example.com/x"), /https/);
  await assert.rejects(assertSafeUrl("https://127.0.0.1/x"), /Daxili/);
  await assert.rejects(assertSafeUrl("https://169.254.169.254/latest/meta-data"), /Daxili/);
  await assert.rejects(assertSafeUrl("not a url"), /düzgün deyil/);
});
test("assertSafeUrl: lokal inkişaf rejimi", async () => {
  process.env.ALLOW_LOCAL_CONNECTORS = "1";
  await assertSafeUrl("http://localhost:4000/api");
});
