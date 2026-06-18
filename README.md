<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# deploy-watch

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // deploy-watch              │
│  polls cloudflare pages every 5 minutes,   │
│  only speaks when something changes         │
└─────────────────────────────────────────────┘
```

[![Deploy](https://github.com/AtlasReaper311/deploy-watch/actions/workflows/deploy.yml/badge.svg)](https://github.com/AtlasReaper311/deploy-watch/actions)
![Cloudflare Worker](https://img.shields.io/badge/cloudflare-worker-f5a623?style=flat-square&labelColor=0a0a0f)
![Cron](https://img.shields.io/badge/cron-every%205min-4ade80?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

Cloudflare Worker that polls the Cloudflare Pages deployment API on a 5-minute cron and posts a success or failure embed into Discord only when a deploy's terminal outcome genuinely changes. It also always writes the latest known deploy snapshot to KV, so the atlas-systems.uk homepage can show real deploy metadata (last deploy time, commit SHA, build status) on a 5-minute cadence rather than deriving a proxy value from github-pulse's hourly-cached commit feed.

```
Cloudflare Pages API ──▶  deploy-watch (cron, every 5 min)
                               │
                    ┌──────────┴──────────┐
                    │                     │
              KV (latest snapshot)   Discord #deploy-log
              (/latest endpoint)     (on outcome change only)
                    │
              atlas-systems.uk
              (Live Signal section)
```

## Why it exists

`notify-deploy.yml` in `atlas-systems` posts to Discord the moment a push to main is made. It proves a push happened, not that the resulting Cloudflare Pages build succeeded. A failed build produces no signal at all under that setup. `deploy-watch` fills that gap by independently confirming the actual outcome from the Pages API, separate from GitHub's event stream.

The dedup key (`deploy-watch:last`) means Discord only receives one message per deployment outcome, not one every 5 minutes for the same result.

## Endpoints

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /deploy-watch/health` | None | Liveness probe |
| `GET /deploy-watch/latest` | None | Latest known deploy snapshot (used by the homepage) |
| `GET /deploy-watch/run` | Bearer token | Manually trigger a cron check without waiting for the scheduler |

### `/latest` response shape

```json
{
  "ok": true,
  "deployId": "abc123",
  "status": "success",
  "branch": "main",
  "commitSha": "3525b4b",
  "commitUrl": "https://github.com/AtlasReaper311/atlas-systems/commit/...",
  "createdOn": "2026-06-18T12:00:00Z",
  "endedOn": "2026-06-18T12:00:13Z",
  "checkedAt": "2026-06-18T12:05:00Z"
}
```

`checkedAt` is when `deploy-watch` last polled, not when the deploy happened. A `status` of anything other than `success`, `failure`, or `canceled` means a build is still in progress; the homepage uses this to show an amber "building" state.

## Prerequisites

- Node 22+ and `npx`
- A Cloudflare account with a live Pages project (`atlas-systems`)
- A Cloudflare API token with **Account: Cloudflare Pages: Read** permission
- A Discord webhook URL for the `deploy-log` channel

## Setup

1. **Create the KV namespace:**

   ```bash
   npm install
   npx wrangler login
   npx wrangler kv namespace create DEPLOY_WATCH_STATE
   ```

   Paste the printed `id` into `wrangler.toml` under `[[kv_namespaces]]`.

2. **Set secrets:**

   ```bash
   npx wrangler secret put CLOUDFLARE_API_TOKEN   # Pages Read token
   npx wrangler secret put DISCORD_DEPLOY_WEBHOOK  # deploy-log channel webhook
   ```

3. **Deploy:**

   ```bash
   npx wrangler deploy
   ```

4. **Test immediately** without waiting for the cron:

   ```bash
   curl -H "Authorization: Bearer YOUR_CLOUDFLARE_API_TOKEN" \
     https://api.atlas-systems.uk/deploy-watch/run
   ```

   A deploy outcome embed should land in `#deploy-log` within seconds if a recent Pages build exists.

## Cron schedule

Fires every 5 minutes (`*/5 * * * *`). Terminal outcomes (`success`, `failure`, `canceled`) trigger a Discord embed and update the dedup key. In-progress builds update the KV snapshot only and post nothing to Discord, so you see exactly one message per deploy, not one per poll.

## A note on the API token

The token passed as `CLOUDFLARE_API_TOKEN` needs **Account: Cloudflare Pages: Read** scoped to your account. This is a different, narrower permission than the `CF_WORKERS_DEPLOY_TOKEN` used by the GitHub Actions deploy workflow, which needs Workers write access. They are intentionally separate tokens with separate scopes. Do not reuse the same token for both.

## How it fits into Atlas Systems

`deploy-watch` is the feedback leg of the deploy pipeline: `notify-deploy.yml` says "a push was made," `deploy-watch` says "the build actually succeeded." Together they give the `deploy-log` Discord channel a complete picture without either one duplicating the other's job.

The transferable pattern is separating event notification from outcome verification: systems that only report trigger events create false confidence when a trigger doesn't produce the expected outcome. Adding an independent outcome poller with deduplication closes that gap without flooding the channel.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
