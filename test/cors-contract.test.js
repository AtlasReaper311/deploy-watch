import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const PREVIEW_ORIGIN =
  "https://system-symphony-pr-43.atlas-systems-44t.pages.dev";
const PRODUCTION_ORIGINS = [
  "https://atlas-systems.uk",
  "https://www.atlas-systems.uk",
  "https://status.atlas-systems.uk",
];
const UNLISTED_ORIGIN = "https://unlisted-preview.example.invalid";
const LATEST_KEY = "deploy-watch:latest";

const SNAPSHOT = {
  deployId: "synthetic-deploy-001",
  status: "success",
  branch: "main",
  commitSha: "abcdef1",
  commitUrl: "https://github.com/AtlasReaper311/atlas-systems/commit/abcdef1",
  createdOn: "2099-01-01T00:00:00.000Z",
  endedOn: "2099-01-01T00:01:00.000Z",
  checkedAt: "2099-01-01T00:01:05.000Z",
};

function createDeployState(latest = null) {
  const store = new Map();
  if (latest !== null) {
    store.set(LATEST_KEY, JSON.stringify(latest));
  }
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put() {
      throw new Error("DEPLOY_STATE.put must not be called by CORS contract tests");
    },
  };
}

function createEnv({ latest = SNAPSHOT, token = undefined } = {}) {
  const env = {
    DEPLOY_STATE: createDeployState(latest),
    ACCOUNT_ID: "synthetic-account",
    PROJECT_NAME: "atlas-systems",
  };
  if (token !== undefined) {
    env.CLOUDFLARE_API_TOKEN = token;
  }
  return env;
}

async function invoke(path, { method = "GET", origin, env, authorization } = {}) {
  const headers = { accept: "application/json" };
  if (origin) headers.origin = origin;
  if (authorization) headers.authorization = authorization;
  const request = new Request(`https://api.atlas-systems.uk${path}`, {
    method,
    headers,
  });
  return worker.fetch(request, env ?? createEnv());
}

async function readJson(response) {
  const text = await response.text();
  return JSON.parse(text);
}

test("historical System Symphony preview origin is echoed on GET /latest", async () => {
  const response = await invoke("/deploy-watch/latest", { origin: PREVIEW_ORIGIN });
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    PREVIEW_ORIGIN
  );
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(body.ok, true);
  assert.equal(body.deployId, SNAPSHOT.deployId);
  assert.equal(body.status, SNAPSHOT.status);
});

test("historical preview origin receives the OPTIONS preflight contract", async () => {
  const response = await invoke("/deploy-watch/latest", {
    method: "OPTIONS",
    origin: PREVIEW_ORIGIN,
  });

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    PREVIEW_ORIGIN
  );
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "Accept, Content-Type"
  );
  assert.equal(response.headers.get("access-control-max-age"), "86400");
  assert.equal(response.headers.get("vary"), "Origin");
});

test("production allowlisted origins are echoed by the Worker handler", async () => {
  for (const origin of PRODUCTION_ORIGINS) {
    const response = await invoke("/deploy-watch/latest", { origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const body = await readJson(response);
    assert.equal(body.ok, true);
  }
});

test("unlisted origins do not receive Access-Control-Allow-Origin", async () => {
  const response = await invoke("/deploy-watch/latest", {
    origin: UNLISTED_ORIGIN,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("vary"), "Origin");
});

test("stored snapshot returns ok:true with snapshot fields", async () => {
  const response = await invoke("/deploy-watch/latest", {
    origin: PREVIEW_ORIGIN,
  });
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(body.ok, true);
  assert.equal(body.deployId, SNAPSHOT.deployId);
  assert.equal(body.status, SNAPSHOT.status);
  assert.equal(body.branch, SNAPSHOT.branch);
  assert.equal(body.commitSha, SNAPSHOT.commitSha);
});

test("missing snapshot preserves ok:true status:unknown", async () => {
  const response = await invoke("/deploy-watch/latest", {
    origin: PREVIEW_ORIGIN,
    env: createEnv({ latest: null }),
  });
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, status: "unknown" });
});

test("/run fails closed when CLOUDFLARE_API_TOKEN is absent", async () => {
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network must not be reached when the secret is absent");
  };

  try {
    const response = await invoke("/deploy-watch/run", {
      env: createEnv({ token: undefined }),
      authorization: "Bearer synthetic-token",
    });
    const body = await readJson(response);

    assert.equal(response.status, 401);
    assert.equal(body.ok, false);
    assert.match(body.error, /missing or wrong/i);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("/run fails closed for missing or wrong bearer when token is configured", async () => {
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network must not be reached for unauthorised /run");
  };

  try {
    const env = createEnv({ token: "expected-token" });

    const missing = await invoke("/deploy-watch/run", { env });
    assert.equal(missing.status, 401);
    assert.equal((await readJson(missing)).ok, false);

    const wrong = await invoke("/deploy-watch/run", {
      env,
      authorization: "Bearer wrong-token",
    });
    assert.equal(wrong.status, 401);
    assert.equal((await readJson(wrong)).ok, false);

    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
