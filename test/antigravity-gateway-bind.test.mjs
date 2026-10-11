/**
 * The Antigravity gateway owns a fixed loopback port. A plugin reload unloads
 * the previous gateway and starts the next one a moment later, so the port can
 * still be held when the new gateway binds. That must not fail the plugin load,
 * and a port that never frees must report what actually went wrong.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
/** Point this at another copy of the gateway to check that copy too. */
const gatewayModule = process.env.QUOTA_GATEWAY_MODULE ?? "../antigravity-gateway.cjs";
const { createGateway } = require(gatewayModule);

/** The gateway validates its descriptors, so the fixture carries a real one. */
const MODELS = [{ id: "gemini-3.8-flash", api: "chat_completions", provider: "antigravity" }];

const gateway = () =>
  createGateway({ secret: Buffer.alloc(32, 7), models: MODELS, stream: async () => {} });

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function occupy(port) {
  const holder = createServer();
  await new Promise((resolve) => holder.listen(port, "127.0.0.1", resolve));
  return {
    release: () => new Promise((resolve) => holder.close(() => resolve())),
  };
}

test("a port released while the gateway starts is claimed instead of failing the load", async () => {
  const port = await freePort();
  const holder = await occupy(port);
  try {
    const candidate = gateway();
    const started = candidate.start(port);
    // The unload that precedes this load releases the port a moment later.
    setTimeout(() => void holder.release(), 400);
    const address = await started;
    assert.equal(address.port, port);
    await candidate.close();
  } finally {
    await holder.release();
  }
});

test("a port that stays busy reports the port and the bind error", async () => {
  const port = await freePort();
  const holder = await occupy(port);
  try {
    await assert.rejects(gateway().start(port), (error) => {
      assert.match(error.message, new RegExp(String(port)));
      assert.match(error.message, /EADDRINUSE/);
      return true;
    });
  } finally {
    await holder.release();
  }
});
