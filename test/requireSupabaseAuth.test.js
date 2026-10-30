import assert from "node:assert/strict";
import test from "node:test";
import { createRequireSupabaseAuth } from "../middleware/requireSupabaseAuth.js";

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("rejects requests without a bearer token", async () => {
  let getUserCalled = false;
  const middleware = createRequireSupabaseAuth({
    auth: {
      getUser: async () => {
        getUserCalled = true;
      },
    },
  });
  const response = createResponse();

  await middleware({ get: () => "" }, response, () => {
    assert.fail("next should not be called");
  });

  assert.equal(response.statusCode, 401);
  assert.equal(getUserCalled, false);
});

test("rejects an invalid or expired Supabase token", async () => {
  const middleware = createRequireSupabaseAuth({
    auth: {
      getUser: async () => ({
        data: { user: null },
        error: { status: 401, message: "invalid token" },
      }),
    },
  });
  const response = createResponse();

  await middleware({ get: () => "Bearer invalid" }, response, () => {
    assert.fail("next should not be called");
  });

  assert.equal(response.statusCode, 401);
});

test("sets the verified user before continuing", async () => {
  const user = { id: "supabase-user-id" };
  const middleware = createRequireSupabaseAuth({
    auth: {
      getUser: async (token) => ({
        data: { user: token === "valid-token" ? user : null },
        error: null,
      }),
    },
  });
  const request = { get: () => "Bearer valid-token" };
  const response = createResponse();
  let nextCalled = false;

  await middleware(request, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(request.authUser, user);
});
