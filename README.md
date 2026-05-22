# Akto × Cloudflare

Deploy Akto on Cloudflare Workers to automatically capture API traffic, discover endpoints, and enforce security policies — with no changes to your existing code.

---

## How it works

```
Client Request
  → Cloudflare (route rule)
      → akto-cloudflare-proxy-cf
          ├── forwards request → your origin / worker
          └── async (fire-and-forget, no latency added)
              → akto-ingest-guardrails-cf
                  ├── akto-guardrails-service-cf → akto-guardrail-executor-cf  (security scanning)
                  └── akto-mini-runtime-cf                              (API discovery → Akto Dashboard)
  ← Response to client
```

All traffic analysis happens asynchronously after the response is sent, so there is **zero added latency** to your users.

---

## Services

| Worker | Container | Role |
|---|---|---|
| `akto-cloudflare-proxy-cf` | — | Transparent proxy. Captures all traffic and forwards it asynchronously. |
| `akto-ingest-guardrails-cf` | `data-ingestion-service` | Receives traffic, routes to scanner and mini-runtime. |
| `akto-guardrails-service-cf` | `guardrails-service` | Runs security policy checks. |
| `akto-guardrail-executor-cf` | `guardrail-executor` | Python ML service for API threat detection. |
| `akto-mini-runtime-cf` | `mini-runtime` | Discovers API endpoints and syncs them to Akto Dashboard. |

### How workers connect

```
akto-cloudflare-proxy-cf  →  akto-ingest-guardrails-cf   (service binding)
akto-ingest-guardrails-cf →  akto-guardrails-service-cf  (service binding)
akto-ingest-guardrails-cf →  akto-mini-runtime-cf         (service binding)
akto-guardrails-service-cf → akto-guardrail-executor-cf         (HTTP)
```

---

## Container Images

All images are pulled from DockerHub — no local builds needed.

| Worker | DockerHub Image |
|---|---|
| `akto-mini-runtime-cf` | `aktosecurity/mini-runtime:local` |
| `akto-ingest-guardrails-cf` | `aktosecurity/data-ingestion-service:latest` |
| `akto-guardrails-service-cf` | `aktosecurity/akto-guardrails-service:local` |
| `akto-guardrail-executor-cf` | `aktosecurity/akto-agent-guard-executor:local` |

---

## Prerequisites

- **Node.js** v18+ and **npm**
- **Docker or Podman** (to push images to Cloudflare registry — deploy.sh prefers Podman, falls back to Docker)
- **Wrangler CLI** authenticated: `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` in `.env`)
- An **Akto account** — [sign up at akto.io](https://www.akto.io)
- Your domain must be on **Cloudflare** (for the route rule)

---

## Deploy

### 1. Configure

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
CLOUDFLARE_ACCOUNT_ID=   # dash.cloudflare.com → Overview → Account ID
AKTO_ACCOUNT_ID=         # Akto Dashboard → Settings → Account
AKTO_API_TOKEN=          # Akto Dashboard → Quick Start → Hybrid SaaS → Copy Token
ROUTE_PATTERN=           # e.g. api.yourdomain.com/*
IMAGE_TAG=v1             # version tag for images pushed to Cloudflare registry
```

### 2. Run the deployment script

```bash
./deploy.sh
```

The script will:
1. Ask whether to push container images to your Cloudflare registry (required on first run)
2. Deploy all 5 workers in the correct order
3. Set secrets automatically
4. Auto-detect and configure the internal service URLs

First run takes ~10 minutes (image push). Subsequent deploys take ~1 minute.

---

## Manual Deployment

If you prefer not to use `deploy.sh`, follow these steps.

### Step 1 — Push images to Cloudflare registry

Cloudflare Workers can only pull images from `registry.cloudflare.com`. You need to pull each image from DockerHub, re-tag it for your account, and push it once.

```bash
ACCOUNT=<your-cloudflare-account-id>
TAG=v1

# Pull from DockerHub
docker pull --platform linux/amd64 aktosecurity/mini-runtime:local
docker pull --platform linux/amd64 aktosecurity/data-ingestion-service:latest
docker pull --platform linux/amd64 aktosecurity/akto-guardrails-service:local
docker pull --platform linux/amd64 aktosecurity/akto-agent-guard-executor:local

# Re-tag and push to Cloudflare registry
# Note: use docker buildx (not plain docker tag) to preserve the linux/amd64 platform metadata

for entry in \
    "aktosecurity/mini-runtime:local=mini-runtime" \
    "aktosecurity/data-ingestion-service:latest=data-ingestion-service" \
    "aktosecurity/akto-guardrails-service:local=guardrails-service" \
    "aktosecurity/akto-agent-guard-executor:local=guardrail-executor"; do
  src="${entry%%=*}"
  name="${entry##*=}"
  dst="registry.cloudflare.com/${ACCOUNT}/${name}:${TAG}"
  echo "FROM $src" | docker buildx build --platform linux/amd64 --provenance=false --load -t "$dst" -
  npx wrangler containers push "$dst"
done
```

### Step 2 — Update wrangler.jsonc files

In each worker's `wrangler.jsonc`, replace `YOUR_ACCOUNT_ID` with your Cloudflare account ID and set the correct image tag:

```
workers/akto-mini-runtime/wrangler.jsonc
workers/akto-ingest-guardrails/wrangler.jsonc
workers/akto-guardrails-service/wrangler.jsonc
workers/akto-guardrail-executor/wrangler.jsonc
```

Example (in each file):
```jsonc
"image": "registry.cloudflare.com/<your-account-id>/mini-runtime:v1"
```

Also set your Akto account ID and route in `workers/akto-cloudflare-proxy/wrangler.jsonc`:
```jsonc
"AKTO_ACCOUNT_ID": "<your-akto-account-id>",
...
"pattern": "api.yourdomain.com/*",
"zone_name": "yourdomain.com"
```

And set the guardrail-executor URL in `workers/akto-guardrails-service/wrangler.jsonc` — you'll get this after deploying `akto-guardrail-executor-cf` in step 3:
```jsonc
"AGENT_GUARD_ENGINE_URL": "https://akto-guardrail-executor-cf.<your-subdomain>.workers.dev"
```

### Step 3 — Deploy workers in order

Workers must be deployed in this order because each one depends on the previous:

```bash
# 1. mini-runtime
cd workers/akto-mini-runtime
npm install
npx wrangler secret put DATABASE_ABSTRACTOR_SERVICE_TOKEN
npx wrangler deploy

# 2. guardrail-executor — note the deployed URL in the output (you'll need it for step 3)
cd ../akto-guardrail-executor
npm install
npx wrangler deploy

# 3. guardrails-service — paste the guardrail-executor URL from step 2 into wrangler.jsonc first
cd ../akto-guardrails-service
npm install
npx wrangler secret put DATABASE_ABSTRACTOR_SERVICE_TOKEN
npx wrangler deploy

# 4. ingest-guardrails
cd ../akto-ingest-guardrails
npm install
npx wrangler deploy

# 5. cloudflare-proxy (must be last — binds to ingest-guardrails)
cd ../akto-cloudflare-proxy
npm install
npx wrangler deploy
```

The `DATABASE_ABSTRACTOR_SERVICE_TOKEN` is your Akto API token from:
**Akto Dashboard → Quick Start → Hybrid SaaS → Connect → Copy Token**

---

## Configuration

### Enable / disable guardrails

In `workers/akto-cloudflare-proxy/wrangler.jsonc`:

```jsonc
"APPLY_AKTO_GUARDRAILS": "true",    // "false" to disable (API discovery still works)
"AKTO_GUARDRAILS_MODE": "async",    // "blocked" to reject requests that fail policy
"AKTO_ENDPOINTS_TO_GUARD": "",      // "" = all endpoints, or "/api/chat,/api/auth"
```

### Mini-runtime name

In `workers/akto-mini-runtime/wrangler.jsonc`, set `MINI_RUNTIME_NAME` to identify this deployment in your Akto Dashboard:

```jsonc
"MINI_RUNTIME_NAME": "mini-runtime-cf"
```

---

## Monitor logs

```bash
npx wrangler tail akto-cloudflare-proxy-cf          --format pretty
npx wrangler tail akto-ingest-guardrails-cf         --format pretty
npx wrangler tail akto-guardrails-service-cf       --format pretty
npx wrangler tail akto-guardrail-executor-cf               --format pretty
npx wrangler tail akto-mini-runtime-cf              --format pretty
```

---

## Troubleshooting

**No traffic in Akto Dashboard?**
- Check the route rule is active: Cloudflare Dashboard → Workers & Pages → Routes
- Tail `akto-cloudflare-proxy-cf` logs and send a test request to your domain
- Wait 30–60 seconds after the first request for the sync

**Container stuck starting (port not ready error)?**
- A container needs a full restart to pick up new env vars
- Delete the container app via the Cloudflare API, then redeploy the worker — it will re-create on the next request

**Guardrails not running?**
- Confirm `APPLY_AKTO_GUARDRAILS: "true"` in the proxy config
- Check `akto-guardrails-service-cf` logs for errors

---

## Support

- [Akto Documentation](https://docs.akto.io)
- [Discord Community](https://www.akto.io/community)
- help@akto.io
