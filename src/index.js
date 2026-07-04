/**
 * deploy-watch
 *
 * Polls Cloudflare Pages' own deployment status every 5 minutes.
 * Posts to Discord only when the terminal outcome genuinely changes,
 * and stores a snapshot of the latest known deploy state so the
 * atlas-systems.uk homepage can show real deploy metadata.
 *
 * KV write discipline: LATEST_KEY is only written when deployId or
 * status actually changes — not on every poll. Keeps writes proportional
 * to deploy activity rather than poll frequency, which matters against
 * the free-tier 1,000 write/day ceiling.
 */

import { handleMeta } from "./_meta.js";

const STATE_KEY  = "deploy-watch:last";   // last Discord-notified outcome signature
const LATEST_KEY = "deploy-watch:latest"; // latest known snapshot for /latest endpoint

const TERMINAL_STATUSES = new Set(["success", "failure", "canceled"]);
const COLOURS = { success: 4906624, failure: 14830410 };
const ALLOWED_ORIGINS = [
  "https://atlas-systems.uk",
  "https://www.atlas-systems.uk",
  "https://status.atlas-systems.uk",
];

const META = {
  name: "deploy-watch",
  description: "Cloudflare Pages deploy monitor for atlas-systems.uk, reporting genuine outcome changes",
  version: "1.0.0",
  endpoints: [
    { method: "GET", path: "/deploy-watch/latest", description: "Latest known Pages deploy snapshot" },
    { method: "GET", path: "/deploy-watch/health", description: "Unauthenticated liveness probe" },
    { method: "GET", path: "/deploy-watch/run", description: "Manually trigger a deploy check; Bearer CLOUDFLARE_API_TOKEN required" },
    { method: "GET", path: "/deploy-watch/_meta", description: "This document" },
  ],
  source: "https://github.com/AtlasReaper311/deploy-watch",
};

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const cors = corsHeaders(request);
    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      return json(200, { ok: true, service: "deploy-watch" }, cors);
    }

    if (request.method === "GET" && url.pathname.endsWith("/latest")) {
      const raw = await env.DEPLOY_STATE.get(LATEST_KEY);
      if (!raw) return json(200, { ok: true, status: "unknown" }, cors);
      return json(200, { ok: true, ...JSON.parse(raw) }, cors);
    }

    if (request.method === "GET" && url.pathname.endsWith("/run")) {
      const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (auth !== env.CLOUDFLARE_API_TOKEN) {
        return json(401, { ok: false, error: "missing or wrong Authorization: Bearer token" });
      }
      const result = await checkDeployments(env);
      return json(200, { ok: true, ...result });
    }

    return json(404, { ok: false, error: "not found" });
  },

  async scheduled(_event, env, _ctx) {
    await checkDeployments(env);
  },
};

async function checkDeployments(env) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/pages/projects/${env.PROJECT_NAME}/deployments?per_page=1`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.success) {
    throw new Error("Cloudflare Pages API error: " + JSON.stringify(data.errors));
  }

  const deploy = data.result?.[0];
  if (!deploy) return { changed: false, reason: "no deployments found" };

  const status    = deploy.latest_stage?.status;
  const meta      = deploy.deployment_trigger?.metadata || {};
  const shortSha  = meta.commit_hash ? meta.commit_hash.slice(0, 7) : null;
  const commitUrl = meta.commit_hash
    ? `https://github.com/AtlasReaper311/${deploy.project_name}/commit/${meta.commit_hash}`
    : null;

  // Read existing snapshot once — used for the LATEST_KEY write guard.
  // checkedAt is excluded from the comparison: it changes every poll and
  // would defeat the purpose. The stored checkedAt reflects when deploy
  // state last changed, not when the Worker last ran.
  const existingRaw  = await env.DEPLOY_STATE.get(LATEST_KEY);
  const existing     = existingRaw ? JSON.parse(existingRaw) : null;
  const stateChanged = !existing || existing.deployId !== deploy.id || existing.status !== status;

  if (stateChanged) {
    await env.DEPLOY_STATE.put(
      LATEST_KEY,
      JSON.stringify({
        deployId:  deploy.id,
        status,
        branch:    meta.branch || deploy.environment || "unknown",
        commitSha: shortSha,
        commitUrl,
        createdOn: deploy.created_on,
        endedOn:   deploy.latest_stage?.ended_on || null,
        checkedAt: new Date().toISOString(),
      })
    );
  }

  if (!TERMINAL_STATUSES.has(status)) {
    return { changed: false, reason: `deploy ${deploy.id} still in progress (${status})` };
  }

  const signature = `${deploy.id}:${status}`;
  const last      = await env.DEPLOY_STATE.get(STATE_KEY);
  if (last === signature) {
    return { changed: false, reason: "already reported this outcome" };
  }

  await postOutcome(env, deploy, status, shortSha, commitUrl, meta);
  await env.DEPLOY_STATE.put(STATE_KEY, signature);
  return { changed: true, deployId: deploy.id, status };
}

async function postOutcome(env, deploy, status, shortSha, commitUrl, meta) {
  const ok = status === "success";

  const started     = new Date(deploy.created_on);
  const ended       = deploy.latest_stage?.ended_on ? new Date(deploy.latest_stage.ended_on) : null;
  const durationSec = ended ? Math.round((ended - started) / 1000) : null;

  await fetch(env.DISCORD_DEPLOY_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "deploy-watch",
      embeds: [
        {
          title: `Deploy ${ok ? "succeeded" : "failed"}: ${deploy.project_name}`,
          color: ok ? COLOURS.success : COLOURS.failure,
          fields: [
            { name: "Branch",  value: meta.branch || deploy.environment || "unknown", inline: true },
            { name: "Commit",  value: commitUrl ? `[${shortSha || "unknown"}](${commitUrl})` : shortSha || "unknown", inline: true },
            ...(durationSec !== null ? [{ name: "Build time", value: `${durationSec}s`, inline: true }] : []),
            { name: "Deploy URL", value: deploy.url || "—", inline: false },
          ],
          footer: { text: "Atlas Systems — Pipeline" },
        },
      ],
    }),
  });
}

function corsHeaders(request) {
  const origin  = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
