# Akto × Cloudflare

Monitor and protect your API traffic using Cloudflare Workers — no changes to your existing servers.

---

## How it works

```
Client → your domain (*.yourdomain.com)
           ↓
    akto-cloudflare-proxy         intercepts all traffic via a Cloudflare route rule
           ↓
    your origin / MCP server      request forwarded as-is
           ↓  (async, background)
    akto-ingest-guardrails        logs traffic to Akto for API discovery
```

Optionally, guardrails can block or redact requests before they reach your origin.

---

## Before you start

- A domain added to your Cloudflare account
- Node.js 18+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed (`npm i -g wrangler`) and logged in (`wrangler login`)
- Your **Akto account ID** — Akto Dashboard → Settings → Account
- Your **Akto API token** — Akto Dashboard → Quick Start → Hybrid SaaS → Connect

---

## Deploy

```bash
./deploy.sh
```

The script asks a few questions and deploys everything in the right order. That's it.

### What it asks

| Prompt | What to enter |
|---|---|
| Option 1 or 2 | `1` for guardrails + ingestion, `2` for ingestion only |
| Cloudflare account ID | [dash.cloudflare.com](https://dash.cloudflare.com) → your account → Overview (right sidebar) |
| Akto account ID | Akto Dashboard → Settings → Account |
| First time? | `y` if you've never deployed to this Cloudflare account before (requires Docker) |
| Route pattern | e.g. `*.yourdomain.com/*` or `api.yourdomain.com/*` |
| KV namespace | `n` unless you need rate limiting |
| Secrets | Paste your Akto API token when prompted (twice — for ingestion and guardrails) |

---

## Manual deployment

**1. akto-guardrails-executor**
```bash
cd workers/akto-guardrails-executor
# Edit wrangler.jsonc — replace <YOUR_CLOUDFLARE_ACCOUNT_ID> with your account ID
npm install
npx wrangler containers push agent-guard-executor:latest   # first time only, requires Docker
npx wrangler deploy
```

**2. akto-ingest-guardrails**
```bash
cd workers/akto-ingest-guardrails
# Edit wrangler.jsonc — replace <YOUR_CLOUDFLARE_ACCOUNT_ID> with your account ID
npm install
npx wrangler containers push mrs:latest   # first time only, requires Docker
npx wrangler deploy
npx wrangler secret put DATABASE_ABSTRACTOR_SERVICE_TOKEN
npx wrangler secret put THREAT_BACKEND_TOKEN
```

**3. akto-cloudflare-proxy**
```bash
cd workers/akto-cloudflare-proxy
# Edit wrangler.jsonc — set your route pattern, AKTO_ACCOUNT_ID, and APPLY_AKTO_GUARDRAILS=true
npm install
npx wrangler deploy
```

---

## Backend: Cloudflare Worker

If your backend is a **Cloudflare Worker**, don't add your domain as a custom domain on it — the proxy won't intercept the traffic. Instead, add it as a service binding:

**`workers/akto-cloudflare-proxy/wrangler.jsonc`**
```jsonc
"services": [
  { "binding": "AKTO_INGESTION_WORKER", "service": "akto-ingest-guardrails" },
  { "binding": "MCP_WORKER", "service": "your-worker-name" }
]
```

**`workers/akto-cloudflare-proxy/src/index.js`** — replace both `fetch(requestForFetch)` and `fetch(request)` calls with:
```js
env.MCP_WORKER ? env.MCP_WORKER.fetch(request) : fetch(request)
```

Then redeploy:
```bash
cd workers/akto-cloudflare-proxy && npx wrangler deploy
```

---

## Configuration

Edit `workers/akto-cloudflare-proxy/wrangler.jsonc` before deploying:

| Variable | Description |
|---|---|
| `APPLY_AKTO_GUARDRAILS` | `"true"` to block/redact requests that violate policies. `"false"` for monitoring only. |
| `AKTO_ENDPOINTS_TO_GUARD` | Comma-separated path substrings to guard, e.g. `"/api/chat,/api/completions"`. Empty = guard everything. |
| `AKTO_ACCOUNT_ID` | Your Akto account ID |

---

## Tail logs

```bash
npx wrangler tail akto-cloudflare-proxy    --format pretty
npx wrangler tail akto-ingest-guardrails   --format pretty
npx wrangler tail akto-guardrails-executor --format pretty   # option 1 only
```

---

## Support

- Akto Dashboard in-app chat
- [Discord](https://www.akto.io/community)
- help@akto.io
