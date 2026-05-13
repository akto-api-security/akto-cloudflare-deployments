# Akto × Cloudflare

Intercept, analyse, and protect API traffic entirely on Cloudflare Workers + Containers, with backend API discovery and traffic processing in mini-runtime.

## How it works

Deploy the complete Akto Cloudflare stack: transparent proxy worker + traffic ingest + guardrails + backend API discovery. No changes to your existing code required.

```
Client Request
  → Cloudflare Network (route rule)
      → akto-cloudflare-proxy Worker
          ├─ validate request → akto-ingest-guardrails Worker (sync)
          ├─ fetch(request)   → your existing worker / origin
          └─ async: log traffic
              → data-ingestion-service → mini-runtime
                  → parse & discover APIs → Akto Dashboard
  ← response to client
```

## Architecture

| Component | Role | Type |
|---|---|---|
| **akto-cloudflare-proxy** | Transparent proxy, traffic capture | Cloudflare Worker (JavaScript) |
| **akto-ingest-guardrails** | Request validation, traffic routing | Cloudflare Worker + Durable Object (TypeScript + MRS container) |
| **akto-guardrails-executor** | Security policy enforcement | Cloudflare Container (Python) |
| **data-ingestion-service** | HTTP traffic intake, Kafka→HTTP bridge | Cloudflare Container (Java/Jetty WAR) |
| **mini-runtime** | API discovery, catalog sync, threat detection | Cloudflare Container (Java) |

---

## Full Stack Deployment

Every request is validated against your Akto security policies. APIs discovered and monitored continuously.

**Services to deploy (in order):**
1. **Java backends** (pre-built, pulled from Docker Hub + pushed to Cloudflare registry):
   - `mini-runtime` (aktosecurity/mini-runtime:local) — API discovery, catalog sync
   - `data-ingestion-service` (aktosecurity/data-ingestion-service:latest) — HTTP traffic intake
2. **Cloudflare Workers**:
   - `akto-guardrails-executor` — security scanning in container
   - `akto-ingest-guardrails` — request validation + traffic routing
   - `akto-cloudflare-proxy` — transparent proxy

---

## Quick Start

### Prerequisites

- **Node.js** v18+ — for Wrangler CLI
- **Docker** — for pulling and pushing container images
- **wrangler login** — authenticate with Cloudflare

### Deploy Everything

```bash
./deploy.sh
```

The script will ask you:
1. Cloudflare Account ID
2. Akto Account ID
3. Push images? (if yes, pulls and pushes Docker images from Docker Hub)
4. Cloudflare route pattern (e.g., `api.yourdomain.com/*`)
5. Akto API tokens for ingest authentication

Deploys everything in the correct order with guardrails and API discovery. First-time setup takes 5-10 minutes (Docker image pull + deployment); subsequent deploys are instant.

---

## Services

### Cloudflare Workers

| Worker | Role | Language |
|---|---|---|
| `akto-cloudflare-proxy` | Route-based transparent proxy. Captures traffic, optionally validates via guardrails, logs asynchronously. | JavaScript |
| `akto-ingest-guardrails` | Receives logged traffic, manages Durable Object for MRS container, routes to `data-ingestion-service`. | TypeScript |
| `akto-guardrails-executor` | Runs security policy scanning (LLM/regex). Required only for Option 1. | Python (container) |

### Java Backend Services

| Service | Role | Deployment |
|---|---|---|
| `mini-runtime` | Main API discovery & catalog sync engine. Parses traffic, detects endpoints, syncs to MongoDB. | Cloudflare Container (Java) |
| `data-ingestion-service` | HTTP traffic intake endpoint. Bridges Kafka and HTTP protocols. Receives from proxy, forwards to mini-runtime. | Cloudflare Container (Java/Jetty) |

---

## Container Images

The deployment uses the following container images:

| Component | Image | Version | Source |
|---|---|---|---|
| **Mini-runtime** | `aktosecurity/mini-runtime` | `local` | Public Docker Hub |
| **Data-ingestion-service** | `aktosecurity/data-ingestion-service` | `latest` | Public Docker Hub |
| **MRS (Mini Runtime Service)** | `registry.cloudflare.com/<account-id>/mrs` | `v1` | Built from MRS container |
| **Guardrails Executor** | `aktosecurity/akto-agent-guard-executor` | `local` | Public Docker Hub |

**Note:** All images are pulled from the public Docker Hub registry (`aktosecurity/`) except MRS which is built as part of the deployment.

---

## Testing

After deployment, verify the end-to-end flow:

```bash
# 1. Check Cloudflare workers are deployed
npx wrangler deployments list akto-cloudflare-proxy

# 2. Monitor proxy logs
npx wrangler tail akto-cloudflare-proxy --format pretty

# 3. Send test traffic
curl -X GET "https://api.yourdomain.com/api/test"

# 4. Check Akto Dashboard → API Collections (wait 30-60 sec for sync)
```

---

## Manual Deployment

### Pull Pre-built Container Images

```bash
# Pull mini-runtime
docker pull aktosecurity/mini-runtime:local

# Pull data-ingestion-service
docker pull aktosecurity/data-ingestion-service:latest
```

### Deploy Cloudflare Workers

```bash
# Option 1 (with guardrails)
cd workers/akto-guardrails-executor  && npm install && npx wrangler deploy
cd workers/akto-ingest-guardrails    && npm install && npx wrangler deploy
cd workers/akto-cloudflare-proxy     && npm install && npx wrangler deploy

# Option 2 (ingestion only)
cd workers/akto-ingest-guardrails    && npm install && npx wrangler deploy
cd workers/akto-cloudflare-proxy     && npm install && npx wrangler deploy
```

### Set Worker Secrets

```bash
# In akto-ingest-guardrails directory:
npx wrangler secret put DATABASE_ABSTRACTOR_SERVICE_TOKEN
npx wrangler secret put THREAT_BACKEND_TOKEN
```

### akto-cloudflare-proxy Configuration

Edit `workers/akto-cloudflare-proxy/wrangler.jsonc`:

```jsonc
"vars": {
  "APPLY_AKTO_GUARDRAILS": "false",      // "true" to enable guardrails
  "AKTO_ENDPOINTS_TO_GUARD": "",         // empty = all endpoints, or "/api/auth,/api/admin"
  "AKTO_ACCOUNT_ID": "1000000"           // Your Akto account ID
},
"routes": [
  {
    "pattern": "api.yourdomain.com/*",   // Your domain (must be in Cloudflare)
    "zone_name": "yourdomain.com"        // Cloudflare zone
  }
]
```

---

## Monitoring

### Cloudflare Worker Logs

```bash
# Proxy worker (traffic capture)
npx wrangler tail akto-cloudflare-proxy --format pretty

# Ingest guardrails worker (traffic routing)
npx wrangler tail akto-ingest-guardrails --format pretty

# Executor worker (security scanning, if Option 1)
npx wrangler tail akto-guardrails-executor --format pretty
```

### Akto Dashboard

1. **API Collections** — discovered endpoints, request/response patterns
2. **API Changes** — daily monitoring and change detection
3. **Security Policies** — guardrails status, blocked requests (if Option 1)
4. **Traffic Analytics** — request volume, response times, error rates

### Troubleshooting

**No traffic reaching proxy?**
- Check route rule is active: Cloudflare Dashboard → Workers & Pages → Routes
- Verify domain is in Cloudflare account
- Check route pattern matches your domain (e.g., `api.example.com/*`)

**APIs not appearing in Akto?**
- Verify proxy logs show traffic: `npx wrangler tail akto-cloudflare-proxy`
- Check ingest worker received data: `npx wrangler tail akto-ingest-guardrails`
- Wait 30-60 seconds for sync
- Verify Akto account ID is correct

**Guardrails not working?**
- Check `APPLY_AKTO_GUARDRAILS: "true"` in proxy config
- Redeploy proxy: `cd workers/akto-cloudflare-proxy && npx wrangler deploy`
- Check guardrails executor logs

**See:** [TESTING_GUIDE.md](TESTING_GUIDE.md) for detailed troubleshooting

---

## Support

- Akto Dashboard in-app chat
- [Discord](https://www.akto.io/community)
- help@akto.io
