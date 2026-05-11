# akto-cloudflare-proxy

Transparent Cloudflare route-based proxy that mirrors API traffic to Akto and optionally enforces MCP guardrails.

## How it works

Deploy with a Cloudflare route rule covering your domain. It sits between Cloudflare and your origin:

1. Receives the request at the Cloudflare edge
2. *(Guardrails enabled)* Calls `akto-ingest-guardrails` synchronously — blocks or redacts the request if a policy fires
3. Forwards to your origin with `fetch(request)`
4. Streams the response back to the client
5. Asynchronously logs the full request+response to `akto-ingest-guardrails` for Akto ingestion

No changes required to your origin server or code.

## Prerequisites

- `akto-ingest-guardrails` deployed (required — service binding target for both ingestion and guardrails)
- `akto-guardrails-executor` deployed (required only if `APPLY_AKTO_GUARDRAILS=true`)

## Configuration (`wrangler.jsonc`)

```jsonc
"vars": {
  "APPLY_AKTO_GUARDRAILS": "false",     // "true" to enable blocking guardrails
  "AKTO_ENDPOINTS_TO_GUARD": "",        // optional: "/api/chat,/api/completions"
  "AKTO_ACCOUNT_ID": "1000000"          // Akto Dashboard → Settings → Account
},
"routes": [
  {
    "pattern": "api.yourdomain.com/*",  // your domain
    "zone_name": "yourdomain.com"
  }
]
```


## Deploy

```bash
npm install
npx wrangler deploy
```

Or use the root `./deploy.sh` for a guided end-to-end deployment of all workers.

## Traffic flow

```
Client
  → akto-cloudflare-proxy  (Cloudflare route)
      ├─ [guardrails] → akto-ingest-guardrails /api/validate/request  (sync, blocking)
      ├─ fetch(request) → your origin server
      └─ waitUntil → akto-ingest-guardrails /api/ingestData  (async, never blocks)
  ← response to client
```

## Logs

```bash
npx wrangler tail akto-cloudflare-proxy --format pretty
```
