/**
 * deploy-watch
 *
 * Polls Cloudflare Pages' own deployment status every 5 minutes.
 * Posts to Discord only when the terminal outcome genuinely changes
 * (see postOutcome), and separately always stores the latest known
 * snapshot, including mid-build state, so the homepage's "Last deploy"
 * / "Commit" / "Build" cells reflect real deploy data on a 5-minute
 * cadence rather than depending on github-pulse's hourly-cached commit
 * timestamp, which can't satisfy "updates whenever a deploy happens."
 */

const STATE_KEY = "deploy-watch:last";
const LATEST_KEY = "deploy-watch:latest";
const TERMINAL_STATUSES = new Set(["success", "failure", "canceled"]);
const COLOURS = { success: 4906624, failure: 14830410 };
const ALLOWED_ORIGINS = ["https://atlas-systems.uk", "https://www.atlas-systems.uk", "https://status.atlas-systems.uk"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

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

  async scheduled(event, env, ctx) {
    await checkDeployments(env);
  },
};

async function checkDeployments(env) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/pages/projects/${env.PROJECT_NAME}/deployments?per_page=1`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.success) throw new Error("Cloudflare Pages API error: " + JSON.stringify(data.errors));

  const deploy = data.result?.[0];
  if (!deploy) return { changed: false, reason: "no deployments found" };

  const status = deploy.latest_stage?.status;
  const meta = deploy.deployment_trigger?.metadata || {};
  const shortSha = meta.commit_hash ? meta.commit_hash.slice(0, 7) : null;

  // Always store the latest known snapshot, regardless of whether this
  // is a new terminal outcome, so /latest reflects reality at the
  // normal 5-minute poll cadence, mid-build included, not only on
  // confirmed success or failure.
  await env.DEPLOY_STATE.put(
    LATEST_KEY,
    JSON.stringify({
      deployId: deploy.id,
      status,
      branch: meta.branch || deploy.environment || "unknown",
      commitSha: shortSha,
      commitUrl: meta.commit_hash
        ? `https://github.com/AtlasReaper311/${deploy.project_name}/commit/${meta.commit_hash}`
        : null,
      createdOn: deploy.created_on,
      endedOn: deploy.latest_stage?.ended_on || null,
      checkedAt: new Date().toISOString(),
    })
  );

  if (!TERMINAL_STATUSES.has(status)) {
    return { changed: false, reason: `deploy ${deploy.id} still in progress (${status})` };
  }

  const signature = `${deploy.id}:${status}`;
  const last = await env.DEPLOY_STATE.get(STATE_KEY);
  if (last === signature) {
    return { changed: false, reason: "already reported this outcome" };
  }

  await postOutcome(env, deploy, status, shortSha, meta);
  await env.DEPLOY_STATE.put(STATE_KEY, signature);
  return { changed: true, deployId: deploy.id, status };
}

async function postOutcome(env, deploy, status, shortSha, meta) {
  const commitUrl = meta.commit_hash
    ? `https://github.com/AtlasReaper311/${deploy.project_name}/commit/${meta.commit_hash}`
    : null;
  const ok = status === "success";

  const started = new Date(deploy.created_on);
  const ended = deploy.latest_stage?.ended_on ? new Date(deploy.latest_stage.ended_on) : null;
  const durationSec = ended ? Math.round((ended - started) / 1000) : null;

  const payload = {
    username: "deploy-watch",
    embeds: [
      {
        title: `Deploy ${ok ? "succeeded" : "failed"}: ${deploy.project_name}`,
        color: ok ? COLOURS.success : COLOURS.failure,
        fields: [
          { name: "Branch", value: meta.branch || deploy.environment || "unknown", inline: true },
          { name: "Commit", value: commitUrl ? `[${shortSha || "unknown"}](${commitUrl})` : shortSha || "unknown", inline: true },
          ...(durationSec !== null ? [{ name: "Build time", value: `${durationSec}s`, inline: true }] : []),
          { name: "Deploy URL", value: deploy.url || "—", inline: false },
        ],
        footer: { text: "Atlas Systems — Pipeline" },
      },
    ],
  };

  await fetch(env.DISCORD_DEPLOY_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
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
