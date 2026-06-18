/**
 * deploy-watch
 *
 * Polls Cloudflare Pages' own deployment status every 5 minutes and
 * posts to Discord only when a deploy's terminal outcome (success,
 * failure, or canceled) genuinely changes, never on every poll, and
 * never while a build is still in progress. Closes the gap left by
 * notify-deploy.yml, which only proves a push happened, not that the
 * resulting build actually succeeded.
 */

const STATE_KEY = "deploy-watch:last";
const TERMINAL_STATUSES = new Set(["success", "failure", "canceled"]);
const COLOURS = { success: 4906624, failure: 14830410 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      return json(200, { ok: true, service: "deploy-watch" });
    }

    // Manual trigger for testing without waiting for the real cron
    // tick. Gated behind the same Discord webhook secret's presence
    // implicitly proving config is set, plus an explicit token check,
    // so a random visitor can't spam the channel by hitting a public URL.
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
  if (!TERMINAL_STATUSES.has(status)) {
    return { changed: false, reason: `deploy ${deploy.id} still in progress (${status})` };
  }

  const signature = `${deploy.id}:${status}`;
  const last = await env.DEPLOY_STATE.get(STATE_KEY);
  if (last === signature) {
    return { changed: false, reason: "already reported this outcome" };
  }

  await postOutcome(env, deploy, status);
  await env.DEPLOY_STATE.put(STATE_KEY, signature);
  return { changed: true, deployId: deploy.id, status };
}

async function postOutcome(env, deploy, status) {
  const meta = deploy.deployment_trigger?.metadata || {};
  const shortSha = meta.commit_hash ? meta.commit_hash.slice(0, 7) : "unknown";
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
          { name: "Commit", value: commitUrl ? `[${shortSha}](${commitUrl})` : shortSha, inline: true },
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

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
