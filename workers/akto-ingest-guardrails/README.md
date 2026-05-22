# akto-ingest-guardrails-cf

Cloudflare Worker that receives intercepted API traffic and routes it to the guardrails scanner and mini-runtime.

## What it does

Called by `akto-cloudflare-proxy-cf` via service binding. For each request it:
- Forwards traffic to `akto-guardrails-service-cf` (security policy checks) — if guardrails are enabled
- Forwards traffic to `akto-mini-runtime-cf` (API discovery → Akto Dashboard)
- Forwards traffic to its own `data-ingestion-service` container for batch ingestion

## Container

| Name | Image |
|---|---|
| `akto-data-ingestion-container-cf` | `aktosecurity/data-ingestion-service:latest` |

## Key config

- `ENABLE_MCP_GUARDRAILS` — `"true"` to enable guardrails routing (default), `"false"` to skip
- `DATABASE_ABSTRACTOR_SERVICE_TOKEN` — set as a secret by `deploy.sh`

## Deploy

Use the root `deploy.sh` — do not deploy this worker in isolation. See the [root README](../../README.md) for full deployment instructions.
