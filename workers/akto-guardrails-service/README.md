# akto-guardrails-service-cf

Cloudflare Worker that runs security policy checks on intercepted API traffic.

## What it does

Receives requests from `akto-ingest-guardrails-cf` via service binding, starts the `guardrails-service` Java container, and calls `akto-guardrail-executor-cf` (Python ML scanner) via HTTP for threat detection.

## Container

| Name | Image |
|---|---|
| `akto-guardrails-service-container-cf` | `aktosecurity/akto-guardrails-service:local` |

## Key config

- `AGENT_GUARD_ENGINE_URL` — set automatically by `deploy.sh` after deploying `akto-guardrail-executor-cf`
- `DATABASE_ABSTRACTOR_SERVICE_TOKEN` — set as a secret by `deploy.sh`

## Deploy

Use the root `deploy.sh` — do not deploy this worker in isolation. See the [root README](../../README.md) for full deployment instructions.
