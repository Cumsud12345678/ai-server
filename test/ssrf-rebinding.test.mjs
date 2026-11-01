import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateIp } from "../src/connectors/ipCheck.js";
import { guardedFetch, isPrivateIpError } from "../src/connectors/safeDispatcher.js";

test("isPrivateIp: əlavə xüsusi aralıqlar da tutulur", () => {
  for (const ip of ["198.18.0.1", "198.19.255.1", "192.0.0.8", "64:ff9b::7f00:1", "ff02::1", "169.254.169.254"]) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ["198.20.0.1", "192.0.2.1", "8.8.8.8", "2606:4700::1"]) assert.ok(!isPrivateIp(ip), ip);
});

test("guardedFetch: domen daxili IP-yə resolve olunanda qoşulmur (DNS rebinding qorunması)", async () => {
  const server = http.createServer((_req, res) => res.end("gizli")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  const prev = process.env.ALLOW_LOCAL_CONNECTORS;
  try {
    delete process.env.ALLOW_LOCAL_CONNECTORS;
    // "localhost" assertSafeUrl-dan yan keçsə belə (rebinding ssenarisi), qoşulma anında bloklanır
    await assert.rejects(guardedFetch(`http://localhost:${port}/`), (e) => isPrivateIpError(e));

    process.env.ALLOW_LOCAL_CONNECTORS = "1"; // lokal inkişafda işləməlidir
    const res = await guardedFetch(`http://localhost:${port}/`);
    assert.equal(await res.text(), "gizli");
  } finally {
    if (prev === undefined) delete process.env.ALLOW_LOCAL_CONNECTORS; else process.env.ALLOW_LOCAL_CONNECTORS = prev;
    server.close();
  }
});
