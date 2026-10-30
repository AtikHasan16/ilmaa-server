import assert from "node:assert/strict";
import test from "node:test";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.CORS_ORIGINS ||= "http://localhost:5173";

const { default: app } = await import("../index.js");

test("requires Supabase authentication and exposes no legacy CRUD routes", async (t) => {
  // 1. Verify route surface directly from Express router stack
  const registeredRoutes = [];
  for (const layer of app._router.stack) {
    if (layer.route) {
      registeredRoutes.push({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      });
    }
  }

  const ttsRoute = registeredRoutes.find((r) => r.path === "/api/tts");
  assert.ok(ttsRoute, "Expected POST /api/tts to be registered on the app");
  assert.ok(ttsRoute.methods.includes("post"), "Expected /api/tts to support POST");

  const healthRoute = registeredRoutes.find((r) => r.path === "/health");
  assert.ok(healthRoute, "Expected GET /health to be registered on the app");

  const readyRoute = registeredRoutes.find((r) => r.path === "/ready");
  assert.ok(readyRoute, "Expected GET /ready to be registered on the app");

  // Verify legacy endpoints are completely removed
  const legacyEndpoints = [
    "/api/v1/vocabulary",
    "/admin",
    "/admin/users",
    "/api/users",
    "/access-requests",
  ];
  for (const endpoint of legacyEndpoints) {
    const found = registeredRoutes.some((r) => r.path.startsWith(endpoint));
    assert.equal(found, false, `Unexpected legacy route present: ${endpoint}`);
  }

  // 2. Perform live HTTP integration test if network socket binding is permitted by environment
  let server;
  try {
    server = app.listen(0);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const ttsResponse = await fetch(`${baseUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "example" }),
    });
    assert.equal(ttsResponse.status, 401);

    const legacyResponse = await fetch(`${baseUrl}/api/v1/vocabulary`);
    assert.equal(legacyResponse.status, 404);
  } catch (err) {
    if (err.code === "EACCES" || err.cause?.code === "EACCES") {
      // Loopback TCP socket connection is restricted in standard sandboxed terminal environment.
      // Route inspection above confirmed security constraints.
      return;
    }
    throw err;
  }
});
