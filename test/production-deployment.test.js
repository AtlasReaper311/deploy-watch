import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const LATEST_KEY = "deploy-watch:latest";

function createDeployState() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function createEnv() {
  return {
    DEPLOY_STATE: createDeployState(),
    ACCOUNT_ID: "synthetic-account",
    PROJECT_NAME: "atlas-systems",
    CLOUDFLARE_API_TOKEN: "expected-token",
  };
}

function deployment(environment) {
  return {
    id: `${environment}-deploy-001`,
    environment,
    project_name: "atlas-systems",
    created_on: "2099-01-01T00:00:00.000Z",
    latest_stage: {
      status: "active",
      ended_on: null,
    },
    deployment_trigger: {
      metadata: {
        branch: environment === "production" ? "main" : "feature-preview",
        commit_hash: "abcdef1234567890",
      },
    },
    url: `https://${environment}.example.invalid`,
  };
}

async function invokeRun(env) {
  const request = new Request("https://api.atlas-systems.uk/deploy-watch/run", {
    method: "GET",
    headers: {
      authorization: "Bearer expected-token",
      accept: "application/json",
    },
  });
  return worker.fetch(request, env);
}

test("deployment polling requests only the latest production Pages deployment", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return new Response(
      JSON.stringify({ success: true, result: [deployment("production")] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const env = createEnv();
  try {
    const response = await invokeRun(env);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(calls.length, 1);

    const apiUrl = new URL(calls[0]);
    assert.equal(apiUrl.searchParams.get("env"), "production");
    assert.equal(apiUrl.searchParams.get("per_page"), "1");

    const stored = JSON.parse(env.DEPLOY_STATE.store.get(LATEST_KEY));
    assert.equal(stored.deployId, "production-deploy-001");
    assert.equal(stored.branch, "main");
    assert.equal(stored.commitSha, "abcdef1");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("unexpected preview evidence is rejected before it can overwrite the latest snapshot", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ success: true, result: [deployment("preview")] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const env = createEnv();
  try {
    const response = await invokeRun(env);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.changed, false);
    assert.match(body.reason, /ignoring non-production deployment \(preview\)/);
    assert.equal(env.DEPLOY_STATE.store.has(LATEST_KEY), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
